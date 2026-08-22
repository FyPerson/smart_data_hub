# -*- coding: utf-8 -*-
"""
历史台账归档 · Python 提取脚本（A2）

方案 SSOT：docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §2/§3/§4
真相源：legacy-archive-manifest.json（A1 产物，由 freeze-legacy-manifest.py 冻结）——
本脚本**不自行解析日期做切分**，逐 dataset 只按 manifest.keep_excel_rows 选行；
切分口径与本脚本双解析器不可互证，manifest 是唯一真相源（方案 §2 关键机制）。

产出：逐 dataset `<dataset_key>.jsonl`（每 keep 行一条 {excel_row,row_index,data,images}）
     + `images/<原始图片ID>.<ext>`（DISPIMG 落盘）+ `payload-summary.json`（完成哨兵，
     含逐 dataset 行数对拍 + 图片六计数器 + 冻结断言）。

字段键：fNNN 按列位 1 起补零三位，覆盖该 dataset 全部列（不裁剪"全空列"——bug_list
的 31 个"全空"列实为 WPS 图片外溢列，裁列会让 images.field 归属整体错位，方案 §3.2）。

值来源 = pandas（与 freeze-legacy-manifest.py 同解析器，展示契约见方案 §3.4）；
图片归属扫描 = 裸 zipfile + ElementTree 直读 `xl/worksheets/sheetN.xml` 的 `<c><f>` 文本
（**不用 openpyxl.load_workbook 扫公式**——见下方"实现偏离"说明）+ `xl/cellimages.xml` /
`xl/_rels/cellimages.xml.rels`（WPS 私有扩展，openpyxl 不识别，必须绕过 openpyxl 直读包）。

⚠️ 实现偏离任务书字面指令（"load_workbook(data_only=False) 扫全部 8 表 DISPIMG 公式"）：
实测 openpyxl 的 read_only 迭代器会把 **共享公式（t="shared"）跟随单元格**也展开成与主
单元格相同的公式文本——bug_list 的 R4579:R4587 是一组共享公式（si="0"，源于人工拖拽填
充），主单元格 R4579 有字面 `<f>` 文本，跟随的 R4580-R4587 这 8 个单元格的 `<f>` 元素只有
`t="shared" si="0"` 属性、**没有自己的字面公式文本**——但 openpyxl 会重建出与主单元格相同
的 DISPIMG 文本，导致 bug_list 引用格数从冻结锚点 467 虚增到 475（跨解析器实测验证，
extract 实跑记录见 A2 交付报告）。冻结锚点 467/1（方案 §3.3）以"该单元格自身 `<f>` 是否
携带字面 DISPIMG 文本"为口径（468 条字面引用中恰有 1 个 ID 被 2 个独立字面单元格
[R4566/R4579] 各引一次，其余 466 个 ID 各被引 1 次，467 个声明 ID 全部被覆盖，算术自洽）。
改走裸 XML `<f>` 文本存在性判断，与冻结锚点严格对齐；R4580-R4587 这 8 行不产出图片归属
（它们在业务上更像是拖拽公式产生的残留态，而非独立截图）。

用法：
    "C:\\Program Files\\Python312\\python.exe" extract-legacy-payload.py
        [--source 源xlsx路径] [--manifest manifest路径] [--out 输出目录]
"""

import argparse
import datetime
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

# ---------------------------------------------------------------------------
# 默认路径（与 freeze-legacy-manifest.py 对齐）
# ---------------------------------------------------------------------------

# D4 源文件收口（2026-08-22）：唯一权威位置迁至 uploads/legacy-archive/source/（随源文件下载
# 端点 GET /api/legacy-archive/source-file 一并落位，tmp 工作副本已删）；SHA-256 与 active 批次
# 记录一致（abe0244c…）。未来重导新批次：新源文件放同目录后用 --source 显式指定或更新本默认值。
DEFAULT_SOURCE_FILE = (
    r"E:\数据开发与治理规范手册\wbs-server\uploads\legacy-archive\source\BMS 3.0系统 bug、维护单清单260820.xlsx"
)
DEFAULT_MANIFEST = r"E:\数据开发与治理规范手册\tmp\legacy-archive-manifest.json"
DEFAULT_OUT_DIR = r"E:\数据开发与治理规范手册\tmp\legacy-archive-payload"

# 冻结断言（方案 §3.3 预筛实测锚，2026-08-20）：bug_list 467 格全部落 keep 行、
# ocr_dispatch_log 另有 1 格；换源文件/手工台账追加涂改会让这两个数漂移，此处显式判红。
EXPECTED_DATASET_IMAGE_REF_COUNTS = {
    "bug_list": 467,
    "ocr_dispatch_log": 1,
}

# L6（Opus 预筛顺手修）：xl/cellimages.xml 声明的 cellImage 条目数冻结锚点——文件头注释声称
# "467 个 ID → 466 张唯一内容""467 个声明 ID 全部被覆盖"，此前只在开发期人工用一次性脚本验证过，
# 未落进本脚本的实际断言（"注释声称的不变量"没有代码兜底）。build_cellimage_id_map 内据此断言，
# 未被任何 DISPIMG 公式引用的声明 ID 数也计入 summary 并在 main() 冻结断言里判 0。
EXPECTED_DECLARED_CELLIMAGE_ID_COUNT = 467

# OOXML / WPS 私有命名空间
NS_SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_ETC = "http://www.wps.cn/officeDocument/2017/etCustomData"
NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

CELLIMAGES_PART = "xl/cellimages.xml"
CELLIMAGES_RELS_PART = "xl/_rels/cellimages.xml.rels"


class HardFailure(Exception):
    """携带"期望 vs 实际"结构化差异的致命失败（脚本以 exit 1 收尾）。"""

    def __init__(self, label, detail):
        self.label = label
        self.detail = detail
        super().__init__(f"{label}: {detail}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="历史台账归档 · Python 提取脚本")
    parser.add_argument("source", nargs="?", default=DEFAULT_SOURCE_FILE, help="源 xlsx 路径")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST, help="口径冻结 manifest 路径")
    parser.add_argument("--out", default=DEFAULT_OUT_DIR, help="payload 输出目录")
    parser.add_argument(
        "--self-test-format", action="store_true",
        help="M3：只跑 format_cell_value 展示契约合成用例（不触碰源文件/manifest/out），供 "
        "verify-legacy-archive-schema.js 子进程调用，覆盖真实 payload 零命中的两个分支",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# 开工闸：源文件 SHA-256 == manifest.source_sha256
# ---------------------------------------------------------------------------


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def compute_images_manifest_sha256(images_dir):
    """codex 04 号 H1（外部审）：图片目录完整性单一汇总哈希——供 import 侧在开事务前复算比对，
    抓"images/ 目录在 extract 与 import 之间被部分改动/替换/漏拷"这类问题，不要求逐文件传递
    467 个哈希（那也可行但让 summary 膨胀且收益有限，此处退而求其次用清单级摘要）。

    算法（Node 侧 import-legacy-archive.js 的 computeImagesManifestSha256 必须逐字节同步实现，
    否则两侧算出的哈希永远对不上）：
    ① 列出 images_dir 下全部文件名，按 Python 字符串默认序（Unicode 码点序）升序排序；
    ② 逐文件计算内容 SHA-256（复用 sha256_file 同款分块读取逻辑）；
    ③ 逐行拼接 `"<filename>:<sha256hex>\\n"`（UTF-8 编码，LF 换行，不含 CRLF）；
    ④ 对拼接后的完整字节串整体求 SHA-256，返回其十六进制摘要。

    codex 05 号外部审 L（排序 ASCII，只落注释不改逻辑）：①的排序依赖"文件名在 ASCII 域内"这个
    前提——本模块文件名固定形如 `<WPS_ID>.<ext>`（ID 前缀 "ID_" + 32 位大写十六进制 + 内容魔数
    sniff 出的 png/jpg/gif/bmp/bin 扩展名），且 Node 侧 import-legacy-archive.js 用
    IMAGE_FILENAME_PATTERN=`^[A-Za-z0-9_.-]+$` 白名单结构性保证了这一点——在纯 ASCII 域内，
    Python 字符串默认序（Unicode 码点序）与 JS 字符串 `.sort()`（UTF-16 code unit 序）产出完全
    相同的排序结果，两侧哈希才能对上。若未来放宽白名单允许非 ASCII 文件名，此处排序需改为显式
    UTF-8 字节序（Python `sorted(names, key=lambda s: s.encode('utf-8'))`），否则会在含非 ASCII
    文件名时产出不同排序、两侧哈希不再一致。
    """
    filenames = sorted(os.listdir(images_dir))
    h = hashlib.sha256()
    for name in filenames:
        file_hash = sha256_file(os.path.join(images_dir, name))
        line = f"{name}:{file_hash}\n"
        h.update(line.encode("utf-8"))
    return h.hexdigest(), filenames


def load_manifest(manifest_path):
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


def check_source_sha256(source_file, manifest):
    expected = manifest["source_sha256"]
    actual = sha256_file(source_file)
    if actual != expected:
        raise HardFailure(
            "source_sha256_mismatch",
            f"manifest 记录={expected} 实算={actual}（源文件已变更，需重新冻结 manifest 才能提取）",
        )
    return actual


# ---------------------------------------------------------------------------
# 展示契约（方案 §3.4）：单元格显示值字符串化
# ---------------------------------------------------------------------------


def format_datetime_value(v):
    """日期→YYYY-MM-DD；带非零时间分量→YYYY-MM-DD HH:mm。1970-01-01 等历史脏值原样保留。"""
    if isinstance(v, pd.Timestamp):
        dt = v.to_pydatetime()
    else:
        dt = v
    if isinstance(dt, datetime.datetime):
        has_time = (dt.hour, dt.minute, dt.second, dt.microsecond) != (0, 0, 0, 0)
        if has_time:
            return dt.strftime("%Y-%m-%d %H:%M")
        return dt.strftime("%Y-%m-%d")
    # 纯 date（无时间分量的类型本身）
    return dt.strftime("%Y-%m-%d")


def format_number_value(v):
    """数字通用格式化：整数不带 .0；非整数去掉多余尾零，避免浮点噪声/科学计数法。"""
    fv = float(v)
    if fv.is_integer():
        return str(int(fv))
    s = f"{fv:.10f}".rstrip("0").rstrip(".")
    return s if s else "0"


def format_cell_value(v):
    """展示契约主函数：文本原样；数字/日期按上方两个 helper；空(NaN/None)→None（写 JSON null）。"""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (pd.Timestamp, datetime.datetime, datetime.date)):
        return format_datetime_value(v)
    if isinstance(v, (bool, np.bool_)):  # 必须先于 int 判断（bool 是 int 子类）
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return format_number_value(v)
    return str(v)


def run_self_test_format():
    """M3（Opus 预筛必修）：展示契约（方案 §3.4）四类固定样例的合成用例分支。

    "数字文本""空日期(null)"两类已能从真实 payload 挑到固定 (dataset,row_index,field) 三元组
    （bug_list row_index=1/f001="1"；bug_list row_index=173/f009=None），由 verify 脚本直接查库断言。

    "带时间日期"与"脏日期 1970-01-01"这两类**真实数据零命中**——本函数交付前已用两条独立路径核实：
    ①逐 8 表扫全部 jsonl 输出找不到任何 "YYYY-MM-DD HH:MM" 或 "1970-01-01" 开头的日期串；
    ②直接对源 xlsx 全 8 表的 datetime64 列做 `== pd.Timestamp('1970-01-01')` 精确匹配，同样零命中
    （此前 Opus 预筛认为"BMS维护单里有" 1970-01-01 脏日期，经核实是误判——把某台账列的原始数字
    单元格误当日期解析出的现象，非本脚本 pandas 路径下真实存在的日期值；已在 A2 交付报告说明）。
    两条分支只能靠合成 pd.Timestamp 直接单元测试 format_cell_value 本体，与真实数据两例互补覆盖
    展示契约四类样例，供 verify-legacy-archive-schema.js 以子进程 --self-test-format 调用核验。
    """
    cases = [
        ("带时间日期", pd.Timestamp("2022-03-14 15:30:00"), "2022-03-14 15:30"),
        ("脏日期1970-01-01", pd.Timestamp("1970-01-01"), "1970-01-01"),
        ("空日期null", None, None),
        ("数字文本整数", 474, "474"),
    ]
    all_ok = True
    for label, v, expected in cases:
        actual = format_cell_value(v)
        case_ok = actual == expected
        all_ok = all_ok and case_ok
        print(f"{'[PASS]' if case_ok else '[FAIL]'} {label}: input={v!r} expected={expected!r} actual={actual!r}")
    sys.exit(0 if all_ok else 1)


# ---------------------------------------------------------------------------
# 图片：cellimages.xml + rels 建 ID → (target_path) 映射
# ---------------------------------------------------------------------------


def build_cellimage_id_map(zf):
    """解析 xl/cellimages.xml + xl/_rels/cellimages.xml.rels，返回：
    id_to_target: {ID: 'xl/media/imageNNN.ext' 或 None(关系缺失/文件不存在)}
    供后续逐 DISPIMG 引用查表判定"无归属引用"（ID 不在此表）vs"关系缺失"（在表但 target 为 None）。
    """
    ci_root = ET.fromstring(zf.read(CELLIMAGES_PART))
    id_to_rid = {}
    for item in ci_root.findall(f"{{{NS_ETC}}}cellImage"):
        cnv_pr = item.find(f".//{{{NS_XDR}}}cNvPr")
        blip = item.find(f".//{{{NS_A}}}blip")
        if cnv_pr is None or blip is None:
            continue
        img_id = cnv_pr.get("name")
        rid = blip.get(f"{{{NS_R}}}embed")
        if img_id and rid:
            id_to_rid[img_id] = rid

    rels_root = ET.fromstring(zf.read(CELLIMAGES_RELS_PART))
    rid_to_target = {}
    for rel in rels_root:
        rid_to_target[rel.get("Id")] = rel.get("Target")

    zip_names = set(zf.namelist())
    id_to_target = {}
    for img_id, rid in id_to_rid.items():
        target = rid_to_target.get(rid)
        if not target:
            id_to_target[img_id] = None  # 关系缺失：rId 未在 rels 中声明
            continue
        full_path = posixpath.normpath(posixpath.join("xl", target))
        if full_path not in zip_names:
            id_to_target[img_id] = None  # 关系缺失：声明的 target 文件不存在于包内
            continue
        id_to_target[img_id] = full_path

    # L6：冻结锚点断言——本数据集实测 xl/cellimages.xml 恰好声明 467 个 cellImage 条目（两 ID 共享
    # 1 个 rId 属正常，见文件头"实现偏离"说明，不影响此计数）。换源文件/手工台账重新导出会让这个
    # 数漂移，此处显式判红而非任由后续六计数器隐性吸收掉这类结构性变化。
    if len(id_to_target) != EXPECTED_DECLARED_CELLIMAGE_ID_COUNT:
        raise HardFailure(
            "cellimages_declared_id_count",
            f"期望 xl/cellimages.xml 声明 {EXPECTED_DECLARED_CELLIMAGE_ID_COUNT} 个 cellImage 条目，"
            f"实际 {len(id_to_target)} 个——源文件与冻结锚点已不同源，需人工核实",
        )
    return id_to_target


def sniff_ext_mime(data):
    """按内容魔数 sniff（不信任 xlsx 内声明的扩展名）。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg", "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif", "image/gif"
    if data[:2] == b"BM":
        return "bmp", "image/bmp"
    return "bin", "application/octet-stream"


# ---------------------------------------------------------------------------
# 逐表扫 DISPIMG 公式（裸 zipfile + ElementTree 直读 sheetN.xml，理由见文件头"实现偏离"）
# ---------------------------------------------------------------------------

DISPIMG_PATTERN = re.compile(r'_xlfn\.DISPIMG\("(ID_[0-9A-Fa-f]+)"')
CELL_COORD_PATTERN = re.compile(r"([A-Za-z]+)(\d+)")


def build_sheet_name_to_part(zf):
    """workbook.xml（sheet name→r:id）+ workbook.xml.rels（r:id→part 相对路径）两跳解析，
    返回 {sheet_name: 'xl/worksheets/sheetN.xml'}——不硬编码 sheet1..8 顺序假设。"""
    wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
    sheets_el = wb_root.find(f"{{{NS_SPREADSHEET}}}sheets")
    name_to_rid = {
        sheet_el.get("name"): sheet_el.get(f"{{{NS_R}}}id")
        for sheet_el in sheets_el.findall(f"{{{NS_SPREADSHEET}}}sheet")
    }
    rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {rel.get("Id"): rel.get("Target") for rel in rels_root}
    name_to_part = {}
    for name, rid in name_to_rid.items():
        target = rid_to_target.get(rid)
        if target:
            name_to_part[name] = posixpath.normpath(posixpath.join("xl", target))
    return name_to_part


def scan_dispimg_refs(zf, dataset_sheets):
    """逐 sheet（全部 8 表）扫 DISPIMG **字面**公式引用（`<c><f>` 元素自身携带 DISPIMG 文本才算，
    共享公式跟随单元格——`<f t="shared" si="N"/>` 无字面文本——不计入，见文件头"实现偏离"说明）。
    返回 {dataset_key: [(excel_row, col_1based, img_id), ...]}。

    L9（Opus 预筛顺手修）：单元格文本用 `findall`（非 `search`）——`search` 只取首个匹配，若未来
    某单元格公式里出现多个 DISPIMG 调用（如 `IF(cond, DISPIMG(a,1), DISPIMG(b,1))` 这类条件切换
    显示图），会静默丢掉第二个及以后的引用。`findall` 逐一收集同一单元格内的全部匹配，各自追加
    一条 (excel_row, col, img_id) 记录；下游 extract_images() 的 (excel_row, col) 分组早已按顺序
    枚举同组多个 img_id 并递增 seq（本函数改动前就有这段逻辑，只是此前恒定单元素——见其注释），
    无需改动。本数据集实测每格恒 1 个 DISPIMG，改动后 468/467/1 计数不应变化（作为回归验证）。
    """
    from openpyxl.utils import column_index_from_string

    sheet_name_to_part = build_sheet_name_to_part(zf)
    refs_by_dataset = {}
    for sheet_name, dataset_key in dataset_sheets:
        part = sheet_name_to_part.get(sheet_name)
        if not part:
            raise HardFailure(
                f"{dataset_key}.sheet_part_not_found",
                f"sheet_name={sheet_name!r} 未能通过 workbook.xml(.rels) 解析到对应 worksheet part",
            )
        root = ET.fromstring(zf.read(part))
        refs = []
        for c in root.iter(f"{{{NS_SPREADSHEET}}}c"):
            f_el = c.find(f"{{{NS_SPREADSHEET}}}f")
            if f_el is None or not f_el.text or "DISPIMG" not in f_el.text:
                continue
            matches = DISPIMG_PATTERN.findall(f_el.text)
            if not matches:
                continue
            coord = c.get("r")
            coord_m = CELL_COORD_PATTERN.match(coord)
            if not coord_m:
                raise HardFailure(f"{dataset_key}.bad_cell_coord", f"无法解析单元格坐标: {coord!r}")
            col_letters, row_str = coord_m.group(1), coord_m.group(2)
            row_num = int(row_str)
            col_num = column_index_from_string(col_letters)
            for img_id in matches:
                refs.append((row_num, col_num, img_id))
        refs_by_dataset[dataset_key] = refs
    return refs_by_dataset


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def clean_out_dir(out_dir):
    """先清空重建 out 目录（仅限本脚本产物目录）——目录级 os.replace 对非空目标在 Windows
    不可靠，改用清空重建；summary 最后写作完成哨兵（无 summary=半成品）。

    M4 护栏（Opus 预筛必修）：rmtree 前必须确认目标"不存在 或 含 payload-summary.json 完成哨兵"，
    否则结构化 HardFailure 拒删——防 --out 参数手滑指到无关目录（如业务文档目录）导致整目录被
    静默清空。调用时机也刻意放在 main() 里源文件 SHA 校验通过之后（先确认"自己真能跑得起来"，
    即口径没漂移，再碰旧产物；不是"先删后做"）。"""
    if os.path.exists(out_dir):
        summary_path = os.path.join(out_dir, "payload-summary.json")
        if not os.path.isfile(summary_path):
            raise HardFailure(
                "out_dir_guard_not_our_output",
                f"{out_dir} 已存在但不含 payload-summary.json 完成哨兵，疑似 --out 指向了非本脚本"
                "产物目录，拒绝删除（请人工核实该目录内容后手动清空，或改传一个新的空目录）",
            )
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    os.makedirs(os.path.join(out_dir, "images"))


def build_row_index_maps(datasets):
    """逐 dataset 建 excel_row → row_index（1 起，按 keep_excel_rows 顺序）+ keep_excel_rows 的 set。

    codex 05 号外部审 M（keep_excel_rows 重复值）：freeze 侧（scripts/freeze-legacy-manifest.py，
    A1 已收官不再改动）产出 manifest 时未对 keep_excel_rows 做"集合语义"断言——理论上若其内部
    逻辑有 bug 产出重复 excel_row，这里的字典推导式 `{r: i+1 for i, r in enumerate(keep_rows)}`
    会静默用后一个 row_index 覆盖前一个（同一个 excel_row 只保留最后一次出现的映射，其余 row_index
    悄悄"丢行"）。该缺口由提取侧（本函数）与导入侧（import-legacy-archive.js 的 preflight）两端
    共同兜住：提取侧建立映射前先断言 len(keep_rows) == len(set(keep_rows))。
    """
    result = {}
    for ds in datasets:
        key = ds["dataset_key"]
        keep_rows = ds["keep_excel_rows"]
        if len(keep_rows) != len(set(keep_rows)):
            raise HardFailure(
                f"{key}.keep_excel_rows_duplicate",
                f"keep_excel_rows 含重复值（长度={len(keep_rows)}，去重后={len(set(keep_rows))}）"
                "——manifest 自相矛盾，行号→行索引映射会静默丢行",
            )
        result[key] = {
            "excel_row_to_row_index": {r: i + 1 for i, r in enumerate(keep_rows)},
            "keep_set": set(keep_rows),
        }
    return result


def extract_images(source_file, manifest, out_dir, row_index_maps):
    """逐引用解析 + 落盘 + 六计数器。返回 (images_by_dataset_row, counters, per_dataset_ref_counts)。
    images_by_dataset_row: {dataset_key: {row_index: [image_entry, ...]}}
    """
    dataset_sheets = [(ds["sheet_name"], ds["dataset_key"]) for ds in manifest["datasets"]]

    zf = zipfile.ZipFile(source_file)
    try:
        refs_by_dataset = scan_dispimg_refs(zf, dataset_sheets)
        id_to_target = build_cellimage_id_map(zf)

        # L1（A2 预筛 LOW 留存，A3 当场修）：written_ok 此前逐引用自增，值恒等于
        # resolved_ok - excluded_row_refs（本数据集实测=468，与实际落盘的唯一文件数 467 不符——
        # 同一 img_id 被 2 个独立单元格各引一次时，文件只落盘一次但计数器加了两次）。这会让
        # import 侧拿 written_ok 与"落盘文件数"对拍时产生假警报（467 文件 vs 468 引用）。
        # 改为两个语义分离的计数器：written_ref_count=落盘阶段实际处理的引用数（旧 written_ok
        # 语义，含重复引用不去重）；written_ok=len(written_ids)（真正写盘的唯一文件数）——报告里
        # 两者并列打印，供人工一眼区分"引用数"与"文件数"，不再共用一个易混淆的字段。
        counters = {
            "ref_total": 0,
            "resolved_ok": 0,
            "written_ref_count": 0,
            "written_ok": 0,
            "unattributed_refs": 0,
            "missing_relationship_refs": 0,
            "excluded_row_refs": 0,
        }
        per_dataset_ref_counts = {}
        images_by_dataset_row = {}
        written_ids = set()  # 同一 ID 被多行引用时物理文件只落盘一次（幂等）

        for dataset_key, refs in refs_by_dataset.items():
            per_dataset_ref_counts[dataset_key] = len(refs)
            images_by_dataset_row[dataset_key] = {}
            row_maps = row_index_maps[dataset_key]

            # 先按 (excel_row, col) 分组，保证同一单元格多引用时 seq 有序（本数据集实测恒为 1）
            grouped = {}
            for excel_row, col_1based, img_id in refs:
                grouped.setdefault((excel_row, col_1based), []).append(img_id)

            for (excel_row, col_1based), img_ids in grouped.items():
                for seq, img_id in enumerate(img_ids, start=1):
                    counters["ref_total"] += 1

                    if img_id not in id_to_target:
                        counters["unattributed_refs"] += 1
                        continue
                    target_path = id_to_target[img_id]
                    if target_path is None:
                        counters["missing_relationship_refs"] += 1
                        continue
                    counters["resolved_ok"] += 1

                    if excel_row not in row_maps["keep_set"]:
                        counters["excluded_row_refs"] += 1
                        continue  # ≥8/1 被剔行的图不落盘

                    # 落盘（同 ID 只写一次，幂等）
                    if img_id not in written_ids:
                        data = zf.read(target_path)
                        ext, mime = sniff_ext_mime(data)
                        file_name = f"{img_id}.{ext}"
                        dest = os.path.join(out_dir, "images", file_name)
                        with open(dest, "wb") as f:
                            f.write(data)
                        written_ids.add(img_id)
                    else:
                        # 复用已落盘文件的 ext/mime（重新 sniff 一次，成本极低，避免额外状态）
                        data_head = zf.read(target_path)[:16]
                        ext, mime = sniff_ext_mime(data_head)
                        file_name = f"{img_id}.{ext}"

                    counters["written_ref_count"] += 1  # L1：引用数（含重复引用，不去重）

                    row_index = row_maps["excel_row_to_row_index"][excel_row]
                    field = f"f{col_1based:03d}"
                    entry = {
                        "field": field,
                        "seq": seq,
                        "file": file_name,
                        "orig_id": img_id,
                        "mime": mime,
                    }
                    images_by_dataset_row[dataset_key].setdefault(row_index, []).append(entry)

        # L1：written_ok 语义变更收口——落盘循环结束后统一改写为唯一文件数（len(written_ids)），
        # 不再是循环内的逐引用自增值（那个语义现在专属 written_ref_count，见上方计数器初始化注释）。
        counters["written_ok"] = len(written_ids)

        # L6：未被引用的声明 ID 数——xl/cellimages.xml 声明的 ID 里有多少从未被任何 DISPIMG 公式
        # 引用到（跨全部 8 表汇总去重后比对）。本数据集实测应为 0（文件头注释声称"467 个声明 ID
        # 全部被覆盖"），此前只在开发期人工验证过，未落进代码——现补进 summary 供 main() 冻结断言。
        referenced_ids = {img_id for refs in refs_by_dataset.values() for _, _, img_id in refs}
        unreferenced_ids = set(id_to_target.keys()) - referenced_ids
        counters["declared_cellimage_ids"] = len(id_to_target)
        counters["unreferenced_cellimage_ids"] = len(unreferenced_ids)

        return images_by_dataset_row, counters, per_dataset_ref_counts
    finally:
        zf.close()


def build_dataset_jsonl(xl, dataset, out_dir, row_images):
    """逐 keep 行产出 <dataset_key>.jsonl 一条记录；值来源=pandas（与 freeze 同解析器）。"""
    dataset_key = dataset["dataset_key"]
    sheet_name = dataset["sheet_name"]
    column_count = dataset["column_count"]
    keep_rows = dataset["keep_excel_rows"]

    df = pd.read_excel(xl, sheet_name=sheet_name, header=0)
    actual_column_count = df.shape[1]
    if actual_column_count != column_count:
        raise HardFailure(
            f"{dataset_key}.column_count_drift",
            f"manifest 记录 column_count={column_count}，本次 pandas 实测={actual_column_count}"
            "（源文件已在冻结 manifest 之后被改动，需重新冻结）",
        )

    out_path = os.path.join(out_dir, f"{dataset_key}.jsonl")
    row_count = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for row_index, excel_row in enumerate(keep_rows, start=1):
            idx = excel_row - 2  # 表头占第 1 行，pandas RangeIndex 0 起
            row_values = df.iloc[idx]
            data = {}
            for col_pos in range(column_count):
                raw = row_values.iloc[col_pos]
                data[f"f{col_pos + 1:03d}"] = format_cell_value(raw)
            images = row_images.get(row_index, [])
            record = {
                "excel_row": excel_row,
                "row_index": row_index,
                "data": data,
                "images": images,
            }
            f.write(json.dumps(record, ensure_ascii=False))
            f.write("\n")
            row_count += 1
    return row_count


def main():
    args = parse_args()

    # M3：自测模式最先判断，不触碰 source/manifest/out 任何一样（纯函数级单元测试，供 verify 子进程调用）。
    if args.self_test_format:
        run_self_test_format()
        return

    source_file = args.source
    manifest_path = args.manifest
    out_dir = args.out

    print("=" * 70)
    print("历史台账归档 · Python 提取脚本")
    print(f"源文件: {source_file}")
    print(f"manifest: {manifest_path}")
    print(f"输出目录: {out_dir}")
    print("=" * 70)

    try:
        manifest = load_manifest(manifest_path)
    except FileNotFoundError:
        print(f"[FAIL] manifest 不存在: {manifest_path}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 开工闸：源文件 SHA-256 == manifest.source_sha256
    # ------------------------------------------------------------------
    try:
        source_sha256 = check_source_sha256(source_file, manifest)
    except FileNotFoundError:
        print(f"[FAIL] 源文件不存在: {source_file}")
        sys.exit(1)
    except HardFailure as e:
        print(f"[FAIL] {e.label}: {e.detail}")
        sys.exit(1)
    print(f"[PASS] source_sha256 = {source_sha256}（与 manifest 一致）")

    try:
        row_index_maps = build_row_index_maps(manifest["datasets"])
    except HardFailure as e:
        print(f"[FAIL] {e.label}: {e.detail}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 输出目录：清空重建（M4：SHA 校验通过后才碰旧目录 + rmtree 前哨兵护栏）
    # ------------------------------------------------------------------
    try:
        clean_out_dir(out_dir)
    except HardFailure as e:
        print(f"[FAIL] {e.label}: {e.detail}")
        sys.exit(1)
    print(f"[OK] 输出目录已清空重建: {out_dir}")

    # ------------------------------------------------------------------
    # 图片提取（全部 8 表·DISPIMG 扫描 + 落盘 + 六计数器）
    # ------------------------------------------------------------------
    try:
        images_by_dataset_row, counters, per_dataset_ref_counts = extract_images(
            source_file, manifest, out_dir, row_index_maps
        )
    except HardFailure as e:
        print(f"[FAIL] {e.label}: {e.detail}")
        sys.exit(1)

    print("[OK] 图片提取完成，六计数器（+ L6 新增 2 项声明 ID 诊断计数）：")
    for k, v in counters.items():
        print(f"    {k} = {v}")
    print("    逐 dataset 引用格数：")
    for k, v in per_dataset_ref_counts.items():
        print(f"      {k} = {v}")

    # ------------------------------------------------------------------
    # 逐 dataset 产出 jsonl（值来源=pandas）
    # ------------------------------------------------------------------
    dataset_row_counts = {}
    try:
        with pd.ExcelFile(source_file, engine="openpyxl") as xl:
            for dataset in manifest["datasets"]:
                dataset_key = dataset["dataset_key"]
                row_images = images_by_dataset_row.get(dataset_key, {})
                row_count = build_dataset_jsonl(xl, dataset, out_dir, row_images)
                dataset_row_counts[dataset_key] = row_count
                print(f"[OK] {dataset_key}.jsonl 写出 {row_count} 行")
    except HardFailure as e:
        print(f"[FAIL] {e.label}: {e.detail}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # codex 04 号 H1（外部审）：逐 dataset jsonl 文件哈希 + images 目录清单哈希——供
    # import-legacy-archive.js 在开事务前复算比对（"import 侧复算比对后才开始事务"）。
    # ------------------------------------------------------------------
    jsonl_sha256 = {}
    for dataset in manifest["datasets"]:
        key = dataset["dataset_key"]
        jsonl_path = os.path.join(out_dir, f"{key}.jsonl")
        jsonl_sha256[key] = sha256_file(jsonl_path)
    images_manifest_sha256, images_filenames = compute_images_manifest_sha256(os.path.join(out_dir, "images"))
    print(f"[OK] jsonl_sha256 已计算（{len(jsonl_sha256)} 个 dataset）+ images_manifest_sha256（{len(images_filenames)} 个文件）")

    # ------------------------------------------------------------------
    # 冻结断言（任一失败 exit 1，不写 summary——无 summary=半成品）
    # ------------------------------------------------------------------
    failures = []

    for dataset in manifest["datasets"]:
        key = dataset["dataset_key"]
        expected_keep = dataset["counts"]["keep"]
        actual_keep = dataset_row_counts.get(key)
        if actual_keep != expected_keep:
            failures.append(f"{key}.row_count: manifest keep={expected_keep} 实际写出={actual_keep}")

    if counters["excluded_row_refs"] != 0:
        failures.append(f"excluded_row_refs 应为 0，实际={counters['excluded_row_refs']}（存在剔除行仍关联图片）")
    if counters["unattributed_refs"] != 0:
        failures.append(f"unattributed_refs 应为 0，实际={counters['unattributed_refs']}（存在无归属 DISPIMG 引用）")
    if counters["missing_relationship_refs"] != 0:
        failures.append(
            f"missing_relationship_refs 应为 0，实际={counters['missing_relationship_refs']}（存在关系缺失引用）"
        )
    # L6：未被引用的声明 ID 应为 0（文件头注释声称的不变量，此处代码兜底）。
    if counters["unreferenced_cellimage_ids"] != 0:
        failures.append(
            f"unreferenced_cellimage_ids 应为 0，实际={counters['unreferenced_cellimage_ids']}"
            "（xl/cellimages.xml 里有声明 ID 从未被任何 DISPIMG 公式引用，需人工核实是否有截图被漏收）"
        )

    for key, expected_count in EXPECTED_DATASET_IMAGE_REF_COUNTS.items():
        actual_count = per_dataset_ref_counts.get(key, 0)
        if actual_count != expected_count:
            failures.append(f"{key}.image_ref_count: 期望={expected_count} 实际={actual_count}")

    if failures:
        print()
        print("[FAIL] 以下冻结断言未通过（summary 不会写出）：")
        for msg in failures:
            print(f"  - {msg}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 全过 → 写 payload-summary.json（完成哨兵）
    # ------------------------------------------------------------------
    summary = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(),
        "source_file": os.path.basename(source_file),
        "source_sha256": source_sha256,
        "manifest_generated_at": manifest.get("generated_at"),
        "manifest_script_version": manifest.get("script_version"),
        "dataset_row_counts": dataset_row_counts,
        "dataset_image_ref_counts": per_dataset_ref_counts,
        "image_counters": counters,
        "total_rows": sum(dataset_row_counts.values()),
        # codex 04 号 H1：payload 完整性哈希，import 侧开事务前复算比对（算法见
        # compute_images_manifest_sha256 文档字符串，Node 侧需逐字节同步实现）。
        "jsonl_sha256": jsonl_sha256,
        "images_manifest_sha256": images_manifest_sha256,
        "images_file_count": len(images_filenames),
    }
    summary_path = os.path.join(out_dir, "payload-summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print()
    print(f"[OK] payload-summary.json 已写出: {summary_path}（完成哨兵）")
    print(f"[OK] 总行数 = {summary['total_rows']}")
    sys.exit(0)


if __name__ == "__main__":
    main()
