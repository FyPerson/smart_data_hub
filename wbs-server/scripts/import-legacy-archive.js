// scripts/import-legacy-archive.js — 历史台账归档 · Node 导入脚本（A2）
//   方案 SSOT = docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §4
//   前置产物：freeze-legacy-manifest.py（manifest）→ extract-legacy-payload.py（payload：逐 dataset
//   jsonl + images/ + payload-summary.json 完成哨兵，含 jsonl_sha256/images_manifest_sha256）→
//   本脚本（Node·按 manifest 选行写库）。
//
// 主流程（方案 §4）：
//   ⓪ 开事务前静态复算比对（codex 04 号外部审 H1）：不依赖 db——逐 dataset jsonl 文件哈希 +
//      images/ 目录清单哈希 vs payload-summary 记录值 + 四个"应为 0"计数器复判 + ref_total/
//      resolved_ok/written_ok 用 jsonl 实际内容复算比对。任一不过直接 exit(1)，不打开事务。
//   ① 建 batch（status=pending，拿 batch_id）
//   ② 落盘 uploads/legacy-archive/<batch_id>/（复制 payload/images 全部文件；M2：batchDir 必须
//      不存在，撞见已存在目录视为疑似残留，拒绝自动覆盖/删除）
//   ③ 按 manifest 选行写 datasets+rows——H1 三跳链逐位置严格校验：row_index 必须 1..N 连续序、
//      excel_row 必须等于 manifest.keep_excel_rows[row_index-1]（逐位置非集合）、data 字段键集合
//      必须与 columns.field 集合双向相等、images[].file 白名单字符 + 落盘存在性、被引用文件集合
//      与实际落盘文件集合全等（非仅计数）。
//   ④ 生成导入报告（§4 验收清单）
//   ⑤ 全部对拍绿 → status=verified（双条件 WHERE status='pending'）
//   ①③④⑤ 全部包在同一个 BEGIN IMMEDIATE ... COMMIT 事务里（batch 创建也在事务内——INSERT 的
//   lastID 在事务提交前就可读，借此在事务内先拿到 batch_id 供②命名目录；任何一步失败整体 ROLLBACK，
//   batch 行本身也随之撤销，不会留下"半成品 pending 批次"）。图片落盘（②）是文件系统操作，事务回滚
//   不会撤销它，因此失败路径显式补一步"仅清理本批次 images 目录"（绝不触碰其他批次目录）。
//
// M1（codex 04 号外部审）：db 一旦打开，后续全部异步操作（含 assertLegacyArchiveTablesExist）纳入
//   单一 try/finally——rowStmt 在 finally best-effort finalize，db.close() 用 Promise 包装并 await，
//   错误路径改设 process.exitCode（不在 close 未完成前 process.exit()，避免异步收尾被提前杀掉）。
//   runActivate() 同款处理。
//
// codex 05 号外部审（本轮新增）：
//   H（TOCTOU）：preflight 哈希校验与事务阶段实际消费之间存在时间窗口（单 admin 本机场景下重跑
//     extract 与 import 并发的自伤场景）。低成本修法——不做快照目录，改为在实际消费点二次复算：
//     readJsonlDataset 读取时同步比对 SHA-256，copyBatchImages 复制的同时累加计算落盘内容的清单
//     哈希，两处都与 preflight 记录值比对，不一致结构化 throw。
//   M（keep_excel_rows 重复值）：preflight 增断言，逐 dataset 长度与去重后长度相等 + 每项为正整数；
//     extract 侧 build_row_index_maps 前也补了同款断言（Python len==len(set)）。
//   M（symlink）：copyBatchImages 枚举源文件时 lstatSync 校验 isFile() 且非符号链接。
//
// 幂等：不做"先清后灌"覆盖旧批次——每次运行都是新批次（方案 §4"幂等"节，v0.1 覆盖式设计已被 C-1 否决）。
//
// 用法：
//   node scripts/import-legacy-archive.js [--manifest <path>] [--payload <dir>] [--db <path>] [--uploads-root <dir>]
//   node scripts/import-legacy-archive.js --activate <batch_id> [--db <path>]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// ---------------------------------------------------------------------------
// 参数解析（process.argv 风格，对齐 scripts/backfill-sys-derive-root-seq.js 既有范式）
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function flagValue(flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`❌ ${flag} 缺少参数值`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = flagValue('--db', path.join(__dirname, '..', 'task_pool.db'));
const UPLOADS_ROOT = flagValue('--uploads-root', path.join(__dirname, '..', 'uploads'));
const MANIFEST_PATH = flagValue('--manifest', path.join(__dirname, '..', '..', 'tmp', 'legacy-archive-manifest.json'));
const PAYLOAD_DIR = flagValue('--payload', path.join(__dirname, '..', '..', 'tmp', 'legacy-archive-payload'));
const ACTIVATE_BATCH_ID = args.includes('--activate') ? flagValue('--activate', null) : null;

const LEGACY_ARCHIVE_UPLOAD_BASE = path.join(UPLOADS_ROOT, 'legacy-archive');

// ---------------------------------------------------------------------------
// bug_list 专属列可见性边界（方案 §3.2，2026-08-20 冻结）——18 具名业务列=list，
// position 18/50（0-based，= original_index 19/51，即列 S/AY）两个"有文字的无名旁注列"=detail，
// 其余 31 个 WPS 图片外溢列=none。该边界硬编码在本脚本内，前提是 bug_list 恰好 51 列——
// 一旦源表列数变化（新增/删除列），下方 assertBugListColumnCount 会先行拦截，不静默按错误边界分类。
// ---------------------------------------------------------------------------
const BUG_LIST_NAMED_COL_COUNT = 18;
const BUG_LIST_DETAIL_ORIGINAL_INDEXES = new Set([19, 51]);
const BUG_LIST_EXPECTED_COLUMN_COUNT = 51;

// L8（A2 预筛 LOW 留存，A3 当场修）：batches.script_version 此前取平台 package.json 版本
// （require('../package.json').version）——语义不清：平台版本每次发布都会跳（如 v1.157.x），
// 与本导入脚本自身的建表/校验逻辑是否变过完全无关，日后回看某批次的 script_version 无法判断
// "当时用的是哪版导入口径"。改为脚本自有版本号，仅本脚本内部逻辑（H1 校验链/visibility 边界/
// L1 计数器语义等）发生实质变化时手动递增——与平台发布节奏解耦。当前值 1.1（对应本次 L1/L7/L8/
// L10 四条 LOW 收口批次）。列名 script_version 含义不变（仍是"产出该批次的脚本版本"），只是
// 取值来源从"平台版本"改成"脚本自己声明的版本"。
const IMPORT_SCRIPT_VERSION = '1.1';

function resolveVisibility(datasetKey, originalIndex) {
  if (datasetKey !== 'bug_list') return 'list';
  if (originalIndex <= BUG_LIST_NAMED_COL_COUNT) return 'list';
  if (BUG_LIST_DETAIL_ORIGINAL_INDEXES.has(originalIndex)) return 'detail';
  return 'none';
}

// 图片文件名白名单（方案 §6 权限矩阵鉴权图片端点同款字符集，H1 落盘前置校验）。
const IMAGE_FILENAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// DB helper（Promise 封装，对齐既有 backfill 脚本范式）
// ---------------------------------------------------------------------------
function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ db 不存在：${dbPath}`);
    process.exit(1);
  }
  return new sqlite3.Database(dbPath);
}

function makeHelpers(db) {
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  return { run, all, get };
}

// M1：db.close() 统一走这个 Promise 封装——从不 reject（失败只 console.error），供 finally 无条件 await。
function closeDbAsync(db) {
  return new Promise((resolve) => {
    db.close((err) => {
      if (err) console.error(`⚠️ 关闭数据库连接失败：${err.message}`);
      resolve();
    });
  });
}

async function assertLegacyArchiveTablesExist(all) {
  const required = ['legacy_archive_batches', 'legacy_archive_datasets', 'legacy_archive_rows'];
  const rows = await all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('legacy_archive_batches','legacy_archive_datasets','legacy_archive_rows')"
  );
  const present = new Set(rows.map(r => r.name));
  const missing = required.filter(t => !present.has(t));
  if (missing.length > 0) {
    throw new Error(`legacy-archive 三表未就绪（缺：${missing.join(',')}）——需先调用 routes/legacy-archive 的 initSchema()`);
  }
}

// ---------------------------------------------------------------------------
// 载入 manifest / payload
// ---------------------------------------------------------------------------
function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`❌ ${label} 不存在：${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// codex 05 号外部审 H（TOCTOU）：preflight 阶段的哈希比对与"事务阶段实际消费该文件"之间存在时间
// 窗口（单 admin 本机场景下的自伤场景：preflight 通过后、事务读取前，重跑 extract 覆盖了 payload）。
// 低成本修法——不做快照目录（威胁模型是单 admin 本机，非多方对抗），而是在**实际消费点**（本函数，
// 事务阶段真正读取该 jsonl 文件时）同步复算 SHA-256 并与 preflight 记录值比对，不一致直接结构化
// throw，被 runImport 的 try/catch 收口 ROLLBACK。
function readJsonlDataset(datasetKey, expectedSha256) {
  const filePath = path.join(PAYLOAD_DIR, `${datasetKey}.jsonl`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`payload 缺 ${datasetKey}.jsonl：${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
  if (actualHash !== expectedSha256) {
    throw new Error(
      `${datasetKey}.jsonl 哈希在事务消费时复算不一致（preflight 记录=${expectedSha256} 消费时实算=${actualHash}）` +
      '——payload 在 preflight 后被修改（TOCTOU），拒绝导入'
    );
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  return lines.map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// codex 04 号 H1：SHA helper——与 extract-legacy-payload.py 的 sha256_file / compute_images_
// manifest_sha256 逐字节同步的算法（任一方改动都需同步改另一方，否则两侧哈希永远对不上；已用
// 真实 payload 交叉验证过两侧算出的哈希完全一致，见 A2 交付报告）。
// ---------------------------------------------------------------------------
function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// codex 05 号外部审 L（排序 ASCII，只落注释不改逻辑）：`.sort()` 依赖"文件名在 ASCII 域内"这个
// 前提——本模块文件名固定形如 `<WPS_ID>.<ext>`，且由 IMAGE_FILENAME_PATTERN=`^[A-Za-z0-9_.-]+$`
// 白名单结构性保证（见下方常量）。在纯 ASCII 域内，JS 字符串 `.sort()`（UTF-16 code unit 序）与
// Python 侧 `sorted()`（Unicode 码点序，extract-legacy-payload.py 的 compute_images_manifest_
// sha256 同款算法）产出完全相同的排序结果，两侧哈希才能对上。若未来放宽白名单允许非 ASCII 文件名，
// 此处需改为显式按 UTF-8 字节序排序（如 `Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))`），
// 否则会在含非 ASCII 文件名时产出不同排序、两侧哈希不再一致。
function computeImagesManifestSha256(imagesDir) {
  const filenames = fs.readdirSync(imagesDir).sort();
  const h = crypto.createHash('sha256');
  for (const name of filenames) {
    const fileHash = sha256File(path.join(imagesDir, name));
    h.update(Buffer.from(`${name}:${fileHash}\n`, 'utf8'));
  }
  return { hash: h.digest('hex'), filenames };
}

// ---------------------------------------------------------------------------
// codex 04 号 H1：开事务前的静态复算比对（纯文件级，不依赖 db；此时尚未打开 db，失败直接
// process.exit(1) 无需 finally 收尾）——
//   ① 逐 dataset jsonl 文件哈希 vs payload-summary.jsonl_sha256
//   ② images/ 目录清单哈希 vs payload-summary.images_manifest_sha256
//   ③ 四个"应为 0"计数器（unattributed_refs/missing_relationship_refs/excluded_row_refs/
//      unreferenced_cellimage_ids）import 侧复判
//   ④ ref_total/resolved_ok/written_ok 用 jsonl 实际内容复算比对（顺带把 images.length 求和
//      算出的 totalImageRefsExpected 返回给调用方，供事务阶段第二次独立复算互证）
// ---------------------------------------------------------------------------
function runPreflightChecks(manifest, summary) {
  let totalImageRefsExpected = 0;
  // L1（A2 预筛 LOW 留存，A3 当场修·与 extract-legacy-payload.py 同步）：written_ok 语义已从
  // "落盘阶段逐引用自增"改为"落盘的唯一文件数"（len(written_ids)）——不再等于 jsonl 引用总数
  // （本数据集实测：468 引用 vs 467 唯一文件，1 个 img_id 被 2 个单元格各引一次）。旧口径的
  // "引用数"对拍现在专属 written_ref_count 字段；written_ok 改与"jsonl 内容去重后的引用文件名
  // 集合大小"对拍——这个 Set 就是那把独立复算的尺子。
  const referencedFilesPreflight = new Set();

  // codex 05 号外部审 M（keep_excel_rows 重复值）：manifest 自相矛盾防线——若 keep_excel_rows
  // 内部有重复值，后续按 row_index-1 下标定位 excel_row 期望值、以及字典式的
  // excel_row_to_row_index 映射（extract 侧 build_row_index_maps 同款风险，已在那边补了同款
  // 断言）都会静默"丢行"。freeze 侧（A1 已收官）未对此做集合语义断言，缺口由提取侧+导入侧
  // 两端各自独立兜住，注释互相指路。
  for (const ds of manifest.datasets) {
    const key = ds.dataset_key;
    const keepRows = ds.keep_excel_rows;
    const uniqueSize = new Set(keepRows).size;
    if (uniqueSize !== keepRows.length) {
      console.error(
        `❌ ${key}.keep_excel_rows 含重复值（长度=${keepRows.length}，去重后=${uniqueSize}）——manifest 自相矛盾，拒绝导入`
      );
      process.exit(1);
    }
    const invalidValues = keepRows.filter(v => !Number.isInteger(v) || v <= 0);
    if (invalidValues.length > 0) {
      console.error(
        `❌ ${key}.keep_excel_rows 含非正整数值（如 ${JSON.stringify(invalidValues.slice(0, 5))}）——manifest 自相矛盾，拒绝导入`
      );
      process.exit(1);
    }
  }

  for (const ds of manifest.datasets) {
    const key = ds.dataset_key;
    const jsonlPath = path.join(PAYLOAD_DIR, `${key}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
      console.error(`❌ payload 缺 ${key}.jsonl：${jsonlPath}`);
      process.exit(1);
    }
    const rawBuf = fs.readFileSync(jsonlPath);
    const actualHash = crypto.createHash('sha256').update(rawBuf).digest('hex');
    const expectedHash = summary.jsonl_sha256 && summary.jsonl_sha256[key];
    if (actualHash !== expectedHash) {
      console.error(
        `❌ ${key}.jsonl 哈希不一致：payload-summary 记录=${expectedHash} 实算=${actualHash}` +
        '（payload 疑似在 extract 之后被改动/损坏，拒绝导入）'
      );
      process.exit(1);
    }
    const lines = rawBuf.toString('utf8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const row = JSON.parse(line);
      const images = Array.isArray(row.images) ? row.images : [];
      totalImageRefsExpected += images.length;
      for (const img of images) {
        if (img && typeof img.file === 'string') referencedFilesPreflight.add(img.file);
      }
    }
  }

  const imagesDir = path.join(PAYLOAD_DIR, 'images');
  if (!fs.existsSync(imagesDir)) {
    console.error(`❌ payload 缺 images/ 目录：${imagesDir}`);
    process.exit(1);
  }
  const { hash: actualImagesHash, filenames: imageFilenames } = computeImagesManifestSha256(imagesDir);
  if (actualImagesHash !== summary.images_manifest_sha256) {
    console.error(
      `❌ images/ 目录清单哈希不一致：payload-summary 记录=${summary.images_manifest_sha256} 实算=${actualImagesHash}` +
      '（images/ 疑似在 extract 之后被改动/部分丢失，拒绝导入）'
    );
    process.exit(1);
  }

  const counters = summary.image_counters || {};
  const mustBeZeroFields = ['unattributed_refs', 'missing_relationship_refs', 'excluded_row_refs', 'unreferenced_cellimage_ids'];
  for (const field of mustBeZeroFields) {
    if (counters[field] !== 0) {
      console.error(`❌ payload-summary.image_counters.${field} 应为 0，实际=${counters[field]}（import 侧复判拒收）`);
      process.exit(1);
    }
  }

  // L1：ref_total/resolved_ok/written_ref_count 三者都是"引用数"语义，与 jsonl 引用总数对拍。
  for (const field of ['ref_total', 'resolved_ok', 'written_ref_count']) {
    if (counters[field] !== totalImageRefsExpected) {
      console.error(
        `❌ payload-summary.image_counters.${field}(${counters[field]}) 与 jsonl 实际引用数复算` +
        `(${totalImageRefsExpected}) 不一致`
      );
      process.exit(1);
    }
  }
  // L1：written_ok 是"文件数"语义，与 jsonl 内容去重后的引用文件名集合大小对拍（不是引用总数）。
  if (counters.written_ok !== referencedFilesPreflight.size) {
    console.error(
      `❌ payload-summary.image_counters.written_ok(${counters.written_ok})（文件数语义）与 jsonl 去重后` +
      `引用文件名集合大小复算(${referencedFilesPreflight.size}) 不一致`
    );
    process.exit(1);
  }

  console.log(
    `[OK] 开事务前静态复算全过：jsonl×${manifest.datasets.length} 哈希一致 + images 清单哈希一致` +
    `（${imageFilenames.length} 文件）+ 四个"应为 0"计数器复判通过 + 图片引用数复算一致` +
    `(引用数=${totalImageRefsExpected} / 唯一文件数=${referencedFilesPreflight.size})`
  );
  return { totalImageRefsExpected, totalUniqueImageFilesExpected: referencedFilesPreflight.size };
}

// ---------------------------------------------------------------------------
// 图片落盘：复制 payload/images/* → uploads/legacy-archive/<batch_id>/*
//
// codex 05 号外部审 H（TOCTOU）+ M（symlink）：一遍循环内完成"复制 + 内容哈希校验 + 非常规文件
// 类型拦截"——
//   ① symlink 防线：用 lstatSync（不跟随符号链接）校验每个源文件 isFile() 且非 isSymbolicLink()，
//      不是普通文件直接结构化 throw（防 images/ 里混入指向任意路径的符号链接被当成图片复制）。
//   ② TOCTOU 防线：复制内容的同时用同一份已读入内存的 Buffer 累加计算与
//      compute_images_manifest_sha256（extract-legacy-payload.py）同算法的清单哈希，复制完成后
//      与 preflight 记录的 summary.images_manifest_sha256 比对——证明的是"实际落盘的内容"，
//      不是 preflight 时读到的内容（若两者之间 images/ 被改过，这里会真实抓到）。
//   不做快照目录（威胁模型=单 admin 本机，非多方对抗场景，快照的额外磁盘/时间成本不划算）。
// ---------------------------------------------------------------------------
function copyBatchImages(batchDir, expectedImagesManifestSha256) {
  const srcDir = path.join(PAYLOAD_DIR, 'images');
  if (!fs.existsSync(srcDir)) {
    throw new Error(`payload 缺 images/ 目录：${srcDir}`);
  }
  // M2（codex 04 号外部审）：复制前 batchDir 必须不存在——正常流程里 batchId 由 AUTOINCREMENT
  // 保证单调递增不重用，不该撞见已存在的同名目录；撞见了大概率是上次失败批次清理未完全生效的
  // 残留。本函数不自动删除未知残留（那是破坏性动作），交人工核实内容后手动删除再重试。
  if (fs.existsSync(batchDir)) {
    throw new Error(`疑似失败批次残留目录 ${batchDir}，人工确认后删除再重试`);
  }
  fs.mkdirSync(batchDir, { recursive: true });

  // 排序须与 computeImagesManifestSha256 完全一致（同算法两处实现，见该函数注释里的 ASCII 前提）。
  const files = fs.readdirSync(srcDir).sort();
  const h = crypto.createHash('sha256');
  let copied = 0;
  for (const f of files) {
    const srcPath = path.join(srcDir, f);
    const st = fs.lstatSync(srcPath); // lstatSync 不跟随符号链接，才能真正识别出"这是个链接"
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`payload/images/${f} 不是普通文件（疑似符号链接或特殊文件类型），拒绝复制`);
    }
    const content = fs.readFileSync(srcPath);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    h.update(Buffer.from(`${f}:${fileHash}\n`, 'utf8'));
    fs.writeFileSync(path.join(batchDir, f), content);
    copied++;
  }

  const actualManifestHash = h.digest('hex');
  if (actualManifestHash !== expectedImagesManifestSha256) {
    throw new Error(
      `落盘图片内容哈希与 preflight 记录不一致（preflight=${expectedImagesManifestSha256} 实际落盘=${actualManifestHash}）` +
      '——payload/images/ 在 preflight 后被修改（TOCTOU），拒绝导入'
    );
  }

  return { srcFileCount: files.length, copiedCount: copied };
}

// 环境缺陷回填（A3 交付报告实测记录，2026-08-20）：不用 fs.rmSync(dir,{recursive:true,force:true})
// 删本函数的目标目录——本机实测（Windows + Node v24.11.1）该 API 对含数百个文件的目录会**静默
// no-op**：不抛异常、不报错、目录与全部文件原样保留，重试 8 次+每次间隔 500ms 仍无变化（疑似与
// AV 对新落盘文件的扫描/占用有关）；改手写递归——逐文件 fs.unlinkSync + 目录清空后 fs.rmdirSync，
// 同一批文件用这个路径删除稳定生效（已用最小复现脚本反复验证）。这正是 L10（图片计数不符报错提示
// "可能为上批残留目录"）的真实触发源：若本函数因这个 bug 悄悄没删干净，下一次导入撞见同 batch_id
// （AUTOINCREMENT 在 ROLLBACK 后可能被复用，见 runImport 主流程注释）会被 copyBatchImages 的 M2
// 护栏拦下——现在从根上修，此前的"残留目录"更难真的发生。
// M5（外部 codex 07 审·本轮当场修）：逐 entry 用 lstatSync 判定类型（不用 withFileTypes 的 Dirent
// 类型标记——不同 Node/libuv 版本对 Windows reparse point 的 Dirent 类型上报不够可靠，lstatSync 是
// 最权威的信号源）。命中符号链接/Windows 目录联接（junction）——两者在 Node 的 lstat 实现下都会被
// isSymbolicLink() 判 true（libuv 对 Windows reparse point 统一走这个分支，不区分 symlink/junction/
// mount point 细分类型）——直接删"链接节点本身"，绝不递归进目标（防链接指向本模块目录树之外的
// 任意路径被误删）：先试 unlinkSync（文件型链接），失败且是 EPERM/EISDIR（目录型链接在 Windows
// 上部分场景 unlinkSync 会报这类错）再退到 rmdirSync（对纯链接节点安全，不会牵连目标内容）。
// 普通文件遇 EPERM（Windows 只读属性 FILE_ATTRIBUTE_READONLY）——先 chmodSync 去只读位再重删一次，
// 而非直接放弃（payload 源文件权限不受本模块控制，防御性处理）。
// 目录深度说明：本函数实际递归深度受 uploads/legacy-archive/<batch_id>/ 的真实目录结构约束——
// 该层级下只放置扁平的图片文件（import-legacy-archive.js 落盘逻辑本身不产生子目录），正常情况
// 递归深度恒为 1，不存在深递归撑爆调用栈的风险；写成通用递归只是防御性代码风格，不代表实际会用到
// 深层递归。
function removeDirManualSync(dir) {
  // M5（codex 08 复审·本轮当场修）：上一版只对递归"子项"做了 lstat 判定，传入的 dir 根节点本身
  // 没查——若 uploads/legacy-archive/<batch_id> 这个根目录被替换成指向外部路径的 symlink/junction，
  // 会直接 readdirSync(dir) 把外部目标目录的内容当成"本模块的图片文件"扫进来递归删除。根节点与
  // 子项用同一套判定逻辑：命中链接只删链接节点本身（unlinkSync，失败退 rmdirSync），绝不 readdir
  // 递归进去。
  const rootSt = fs.lstatSync(dir);
  if (rootSt.isSymbolicLink()) {
    try {
      fs.unlinkSync(dir);
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir);
      else throw e;
    }
    return;
  }
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(full);
      } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(full);
        else throw e;
      }
      continue;
    }
    if (st.isDirectory()) {
      removeDirManualSync(full);
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch (e) {
      if (e && e.code === 'EPERM') {
        fs.chmodSync(full, 0o666);
        fs.unlinkSync(full);
      } else {
        throw e;
      }
    }
  }
  fs.rmdirSync(dir);
}

function cleanupBatchImages(batchDir) {
  try {
    if (fs.existsSync(batchDir)) {
      removeDirManualSync(batchDir);
    }
  } catch (e) {
    console.error(`⚠️ 清理批次图片目录失败（需人工核实）：${batchDir}（${e.message}）`);
  }
}

// ---------------------------------------------------------------------------
// 主导入流程
// ---------------------------------------------------------------------------
async function runImport() {
  const manifest = loadJson(MANIFEST_PATH, 'manifest');
  const summaryPath = path.join(PAYLOAD_DIR, 'payload-summary.json');
  // 完成哨兵：无 summary=半成品 payload，直接拒收（对齐 extract-legacy-payload.py 的"无 summary=半成品"约定）。
  const summary = loadJson(summaryPath, 'payload-summary.json（完成哨兵）');

  if (summary.source_sha256 !== manifest.source_sha256) {
    console.error(`❌ payload-summary.source_sha256(${summary.source_sha256}) 与 manifest.source_sha256(${manifest.source_sha256}) 不一致，疑似 manifest/payload 不是同一批产物`);
    process.exit(1);
  }

  const bugListDs = manifest.datasets.find(d => d.dataset_key === 'bug_list');
  if (bugListDs && bugListDs.column_count !== BUG_LIST_EXPECTED_COLUMN_COUNT) {
    console.error(`❌ bug_list 列数漂移：manifest 记录 ${bugListDs.column_count}，本脚本硬编码的 visibility 边界基于 ${BUG_LIST_EXPECTED_COLUMN_COUNT} 列，需人工核实后再改本脚本常量`);
    process.exit(1);
  }

  // H1：开事务前静态复算比对（尚未打开 db，无资源需要 finally 收尾，失败直接 exit(1)）。
  const { totalImageRefsExpected } = runPreflightChecks(manifest, summary);

  // ── M1：db 一旦打开，后续全部异步操作纳入单一 try/finally ──────────────────
  const db = openDb(DB_PATH);
  const { run, all, get } = makeHelpers(db);
  let batchId = null;
  let batchDir = null;
  let rowStmt = null;
  let txOpen = false;
  let result = null;

  try {
    await run('PRAGMA busy_timeout = 5000');
    await assertLegacyArchiveTablesExist(all);

    await run('BEGIN IMMEDIATE');
    txOpen = true;

    // ── ① 建 batch（status=pending） ──────────────────────────────
    const scriptVersion = IMPORT_SCRIPT_VERSION; // L8：脚本自有版本号，不再取平台 package.json 版本
    const insertBatchResult = await run(
      `INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, report, script_version, status)
       VALUES (?, ?, ?, NULL, ?, 'pending')`,
      [manifest.source_file, manifest.source_sha256, JSON.stringify(manifest), scriptVersion]
    );
    batchId = insertBatchResult.lastID;
    batchDir = path.join(LEGACY_ARCHIVE_UPLOAD_BASE, String(batchId));
    console.log(`[OK] batch #${batchId} 已建（status=pending）`);

    // ── ② 图片落盘（M2 护栏见 copyBatchImages） ──────────────────────────────
    const imageCopyResult = copyBatchImages(batchDir, summary.images_manifest_sha256);
    console.log(`[OK] 图片落盘：${imageCopyResult.copiedCount}/${imageCopyResult.srcFileCount} 个文件 → ${batchDir}`);

    // ── ③ 按 manifest 选行写 datasets + rows（H1：三跳链逐位置严格校验） ──────────
    const datasetReports = [];
    let totalRowsWritten = 0;
    let totalImageRefsWritten = 0;
    const allReferencedFiles = new Set();

    rowStmt = db.prepare(
      `INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data, images, search_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const rowStmtRun = (params) => new Promise((res, rej) => rowStmt.run(params, function (e) { e ? rej(e) : res(this); }));

    for (const ds of manifest.datasets) {
      const datasetKey = ds.dataset_key;
      if (ds.headers.length !== ds.column_count) {
        throw new Error(
          `${datasetKey}: manifest.headers.length(${ds.headers.length}) != manifest.column_count(${ds.column_count})——列元数据来源自相矛盾，拒绝继续`
        );
      }
      // H1 前提：keep_excel_rows 长度必须与 counts.keep 同源——下面按 row_index-1 下标逐位置取值，
      // 长度不一致会静默取到 undefined 而不是明确报错，此处先行拦截。
      if (ds.keep_excel_rows.length !== ds.counts.keep) {
        throw new Error(
          `${datasetKey}: manifest.keep_excel_rows.length(${ds.keep_excel_rows.length}) != manifest.counts.keep(${ds.counts.keep})——manifest 自相矛盾`
        );
      }
      const columns = ds.headers.map((name, i) => {
        const originalIndex = i + 1;
        return {
          field: `f${String(originalIndex).padStart(3, '0')}`,
          name,
          original_index: originalIndex,
          display_order: originalIndex,
          visibility: resolveVisibility(datasetKey, originalIndex),
        };
      });
      const columnFieldSet = new Set(columns.map(c => c.field));
      const listFields = new Set(columns.filter(c => c.visibility === 'list').map(c => c.field));

      const jsonlRows = readJsonlDataset(datasetKey, summary.jsonl_sha256[datasetKey]);
      if (jsonlRows.length !== ds.counts.keep) {
        throw new Error(`${datasetKey}: payload jsonl 行数(${jsonlRows.length}) != manifest keep(${ds.counts.keep})`);
      }

      const insertDatasetResult = await run(
        `INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count)
         VALUES (?, ?, ?, ?, ?)`,
        [batchId, datasetKey, ds.sheet_name, JSON.stringify(columns), jsonlRows.length]
      );
      const datasetId = insertDatasetResult.lastID;

      const writtenExcelRows = [];
      for (let i = 0; i < jsonlRows.length; i++) {
        const row = jsonlRows[i];
        const expectedRowIndex = i + 1;

        // H1①（codex 04 号外部审）：row_index 必须精确等于 1..N 连续序（按 jsonl 读取序）——
        // 此前"数量+集合"式校验挡不住错序/换键/错配对，这里改逐位置断言。
        if (row.row_index !== expectedRowIndex) {
          throw new Error(
            `${datasetKey}: jsonl 第 ${i + 1} 条记录 row_index=${row.row_index}，应为 ${expectedRowIndex}（序不连续/错序）`
          );
        }
        // H1②：excel_row 必须等于 manifest 该 dataset keep_excel_rows[row_index-1]（逐位置，非集合）。
        const expectedExcelRow = ds.keep_excel_rows[row.row_index - 1];
        if (row.excel_row !== expectedExcelRow) {
          throw new Error(
            `${datasetKey} row_index=${row.row_index}: excel_row=${row.excel_row}，manifest 该位置期望=${expectedExcelRow}（逐位置比对不一致，可能错序/换键）`
          );
        }
        // H1③：Object.keys(row.data) 集合必须严格等于 columns 的 field 集合（双向）——升级自
        // 上一轮"仅比数量"的 M5 守卫，数量相同但键集合不同（如换键）此前会被静默放过。
        const rowKeys = Object.keys(row.data || {});
        const rowKeySet = new Set(rowKeys);
        if (rowKeySet.size !== rowKeys.length) {
          throw new Error(`${datasetKey} row_index=${row.row_index}: data 键重复（JSON 反序列化异常，理论不可达）`);
        }
        const missingFields = columns.filter(c => !rowKeySet.has(c.field)).map(c => c.field);
        const extraFields = rowKeys.filter(k => !columnFieldSet.has(k));
        if (missingFields.length > 0 || extraFields.length > 0) {
          throw new Error(
            `${datasetKey} row_index=${row.row_index}: data 字段键集合与列定义不一致（缺 ${JSON.stringify(missingFields)}，多 ${JSON.stringify(extraFields)}）`
          );
        }

        const searchText = Array.from(listFields)
          .map(f => row.data[f])
          .filter(v => v !== null && v !== undefined)
          .join(' ')
          .toLowerCase();
        const images = Array.isArray(row.images) ? row.images : [];
        for (const img of images) {
          // H1④：图片文件名白名单校验（落盘存在性在行循环结束后统一做集合级核对，见下方）。
          if (typeof img.file !== 'string' || !IMAGE_FILENAME_PATTERN.test(img.file)) {
            throw new Error(
              `${datasetKey} row_index=${row.row_index}: images[].file 非法文件名 ${JSON.stringify(img.file)}（不满足白名单字符集 [A-Za-z0-9_.-]+）`
            );
          }
          totalImageRefsWritten++;
          allReferencedFiles.add(img.file);
        }
        await rowStmtRun([
          datasetId,
          row.row_index,
          row.excel_row,
          JSON.stringify(row.data),
          JSON.stringify(images),
          searchText,
        ]);
        writtenExcelRows.push(row.excel_row);
        totalRowsWritten++;
      }

      // 行号集合断言（§4 验收清单"行号集合断言结果"）——此处保留作为独立的第二重聚合校验，
      // 与上面循环内的逐位置断言互不替代：逐位置断言证明"每一步都对"，这里的集合断言额外证明
      // "整体收口后仍然完整"（例如若某种 bug 只在收尾阶段出现，逐位置断言未必能覆盖到）。
      const writtenSet = new Set(writtenExcelRows);
      const manifestSet = new Set(ds.keep_excel_rows);
      const setEqual = writtenSet.size === manifestSet.size && ds.keep_excel_rows.every(r => writtenSet.has(r));
      if (!setEqual) {
        const missingInWritten = ds.keep_excel_rows.filter(r => !writtenSet.has(r));
        const extraInWritten = writtenExcelRows.filter(r => !manifestSet.has(r));
        throw new Error(
          `${datasetKey}: excel_row 集合与 manifest.keep_excel_rows 不一致（缺 ${missingInWritten.length} 个，多 ${extraInWritten.length} 个）`
        );
      }

      // H1（上一轮 Opus 预筛必修）：库内回读校验——查已插入行，双向比对（缺集合为空 + 多集合
      // 为空 + 长度相等，三条同时成立才算过），证明 report.passed=true 与库里实际落了什么有因果链。
      const readbackRows = await all(
        `SELECT excel_row FROM legacy_archive_rows WHERE dataset_id = ? ORDER BY row_index`,
        [datasetId]
      );
      const readbackExcelRows = readbackRows.map(r => r.excel_row);
      const readbackSet = new Set(readbackExcelRows);
      const missingInReadback = ds.keep_excel_rows.filter(r => !readbackSet.has(r));
      const extraInReadback = readbackExcelRows.filter(r => !manifestSet.has(r));
      const readbackMatch =
        missingInReadback.length === 0 &&
        extraInReadback.length === 0 &&
        readbackExcelRows.length === ds.keep_excel_rows.length;

      datasetReports.push({
        dataset_key: datasetKey,
        row_count: jsonlRows.length,
        expected_row_count: ds.counts.keep,
        row_count_match: jsonlRows.length === ds.counts.keep,
        column_count: ds.column_count,
        field_keys: columns.map(c => c.field),
        excel_row_set_match: setEqual,
        readback_row_count: readbackExcelRows.length,
        readback_match: readbackMatch,
      });
    }

    await new Promise((res, rej) => rowStmt.finalize((e) => (e ? rej(e) : res())));
    rowStmt = null; // finalize 成功后清空引用，避免 finally 里再次 finalize（双重 finalize 防御）

    // H1④续（codex 04 号外部审）：被引用文件集合 == 落盘文件集合，全等（非仅计数）。
    const destFiles = fs.readdirSync(batchDir);
    const destFileSet = new Set(destFiles);
    const missingInDest = [...allReferencedFiles].filter(f => !destFileSet.has(f));
    const extraInDest = destFiles.filter(f => !allReferencedFiles.has(f));
    if (missingInDest.length > 0 || extraInDest.length > 0) {
      throw new Error(
        `图片文件集合不一致：被引用但未落盘 ${missingInDest.length} 个（如 ${missingInDest.slice(0, 5).join(',')}），` +
        `落盘但未被引用 ${extraInDest.length} 个（如 ${extraInDest.slice(0, 5).join(',')}）`
      );
    }

    // H1⑤续：ref_total/resolved_ok/written_ok 已在 preflight 用 jsonl 内容复算过一次
    // （totalImageRefsExpected）；这里是事务阶段第二次独立重算（totalImageRefsWritten，来自
    // 实际写库过程中的累加），两条代码路径分别得出同一个数，必须相等才互证成立。
    if (totalImageRefsWritten !== totalImageRefsExpected) {
      throw new Error(
        `图片引用总数不一致：preflight 复算=${totalImageRefsExpected}，事务阶段实际写入=${totalImageRefsWritten}`
      );
    }

    // H1：总行数库内回读（限定本批次——同一物理表可能已有其他批次的历史行，见"第二次全量导入"
    // 场景，裸 `SELECT COUNT(*) FROM legacy_archive_rows` 会把旧批次也计入，必须按 batch_id 收窄）。
    const totalReadbackRow = await get(
      `SELECT COUNT(*) c FROM legacy_archive_rows r JOIN legacy_archive_datasets d ON r.dataset_id = d.id WHERE d.batch_id = ?`,
      [batchId]
    );
    const totalRowsReadback = totalReadbackRow.c;

    // ── ④ 生成导入报告（§4 验收清单） ──────────────────────────────
    const totalRowsExpected = manifest.totals.keep;
    const totalRowsMatch = totalRowsWritten === totalRowsExpected;
    const totalRowsReadbackMatch = totalRowsReadback === totalRowsExpected;
    const perDatasetRowsMatch = datasetReports.every(d => d.row_count_match);
    const perDatasetRowSetMatch = datasetReports.every(d => d.excel_row_set_match);
    const perDatasetRowsReadbackMatch = datasetReports.every(d => d.readback_match);

    const destFileCount = destFiles.length;
    const srcImageFileCount = imageCopyResult.srcFileCount;
    const uniqueReferencedFileCount = allReferencedFiles.size;

    // L1：written_ok 已改为"文件数"语义（不再等同引用数），须与唯一文件数对拍；旧口径的"引用数"
    // 对拍改由新增字段 written_ref_count 承担（与 totalImageRefsWritten 这个引用计数对齐）。
    const imageCountersMatch =
      summary.image_counters.written_ok === uniqueReferencedFileCount &&
      summary.image_counters.written_ref_count === totalImageRefsWritten &&
      destFileCount === srcImageFileCount &&
      uniqueReferencedFileCount === srcImageFileCount;

    const sourceShaMatch = manifest.source_sha256 === summary.source_sha256;

    const report = {
      generated_at: new Date().toISOString(),
      source_file: manifest.source_file,
      source_sha256: manifest.source_sha256,
      source_sha256_match: sourceShaMatch,
      total_rows_written: totalRowsWritten,
      total_rows_expected: totalRowsExpected,
      total_rows_match: totalRowsMatch,
      total_rows_readback: totalRowsReadback,
      total_rows_readback_match: totalRowsReadbackMatch,
      datasets: datasetReports,
      per_dataset_rows_match: perDatasetRowsMatch,
      per_dataset_row_set_match: perDatasetRowSetMatch,
      per_dataset_rows_readback_match: perDatasetRowsReadbackMatch,
      image_summary_counters: summary.image_counters,
      total_image_refs_written: totalImageRefsWritten,
      total_image_refs_expected_preflight: totalImageRefsExpected,
      unique_image_files_referenced: uniqueReferencedFileCount,
      image_src_file_count: srcImageFileCount,
      image_dest_file_count: destFileCount,
      image_counters_match: imageCountersMatch,
      // H1：以下三项在事务阶段以 throw 强制执行（不过关不会走到这里），记录进报告只为审计留痕。
      image_file_set_match: true,
      image_ref_count_cross_check_match: true,
      preflight_checks_passed: true,
    };

    // H1：至少 2 个合取项来自库内回读（total_rows_readback_match / per_dataset_rows_readback_match），
    // 不再是清一色"前置 throw 已保证的结构性恒真"。
    const allPassed =
      totalRowsMatch &&
      totalRowsReadbackMatch &&
      perDatasetRowsMatch &&
      perDatasetRowSetMatch &&
      perDatasetRowsReadbackMatch &&
      imageCountersMatch &&
      sourceShaMatch;
    report.passed = allPassed;

    console.log('[OK] 导入报告：');
    console.log(`    total_rows_written=${totalRowsWritten} expected=${totalRowsExpected} match=${totalRowsMatch} readback=${totalRowsReadback} readback_match=${totalRowsReadbackMatch}`);
    console.log(`    per_dataset_rows_match=${perDatasetRowsMatch} per_dataset_row_set_match=${perDatasetRowSetMatch} per_dataset_rows_readback_match=${perDatasetRowsReadbackMatch}`);
    console.log(
      `    image_counters_match=${imageCountersMatch}（written_ok[文件数]=${summary.image_counters.written_ok} ` +
      `written_ref_count[引用数]=${summary.image_counters.written_ref_count} totalRefsWritten=${totalImageRefsWritten} ` +
      `srcFiles=${srcImageFileCount} destFiles=${destFileCount} uniqueRefFiles=${uniqueReferencedFileCount}）`
    );
    console.log(`    image_file_set_match=true（被引用文件集合与落盘文件集合全等）`);
    console.log(`    source_sha256_match=${sourceShaMatch}`);
    console.log(`    passed=${allPassed}`);

    if (!allPassed) {
      // L10（A2 预筛 LOW 留存，A3 当场修）：图片计数不符时补一条诊断指引——batch_id 由 AUTOINCREMENT
      // 保证单调递增，但事务 ROLLBACK 会一并撤销 sqlite_sequence 的递增（SQLite 文档明文行为），
      // 下次运行有机会拿到与失败批次相同的 batch_id；若上次失败时 cleanupBatchImages 自身清理失败
      // （仅 console.error，不阻断），残留目录会在 copyBatchImages 的 M2 护栏被直接拦下（"疑似失败批次
      // 残留目录"），但如果残留是更隐蔽的部分文件（如 Windows 文件锁导致 rmSync 半途失败），也可能
      // 表现为本次的图片计数对不上——因此此处显式指路，不让人只盯着当前批次找不存在的 bug。
      const imageHint = !imageCountersMatch
        ? `（图片计数不符：如排查无果，请人工核查 ${batchDir} 与上一失败批次是否有残留未清理——` +
          '见 copyBatchImages 函数 M2 护栏注释与 cleanupBatchImages 的清理失败提示）'
        : '';
      throw new Error(`导入报告校验未全过，拒绝置 verified（详见上方逐项 match 结果）${imageHint}`);
    }

    // ── ⑤ 校验全过 → status=verified（双条件守卫：WHERE id=? AND status='pending'） ──────
    const updateResult = await run(
      `UPDATE legacy_archive_batches SET report = ?, status = 'verified' WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(report), batchId]
    );
    if (updateResult.changes !== 1) {
      throw new Error(`batch #${batchId} 状态更新未生效（changes=${updateResult.changes}，双条件守卫拦截：批次状态已不是 pending）`);
    }

    await run('COMMIT');
    txOpen = false;
    console.log(`\n✅ batch #${batchId} 导入完成并置 verified。`);
    console.log(`   下一步：核对上方导入报告，确认无误后执行：`);
    console.log(`   node scripts/import-legacy-archive.js --activate ${batchId} --db "${DB_PATH}"`);

    result = { batchId, report };
  } catch (e) {
    if (txOpen) { try { await run('ROLLBACK'); } catch (_) { /* best-effort */ } }
    if (batchDir) cleanupBatchImages(batchDir);
    console.error(`\n❌ 导入失败已回滚（batch 行随事务撤销）：${e.message}`);
    process.exitCode = 1; // M1：不在此处 process.exit()，让下方 finally 的异步收尾完整跑完
  } finally {
    // M1：rowStmt best-effort finalize（若 try 块内已成功 finalize 并置 null，这里跳过）。
    if (rowStmt) {
      await new Promise((resolve) => {
        rowStmt.finalize((err) => {
          if (err) console.error(`⚠️ rowStmt finalize 失败：${err.message}`);
          resolve();
        });
      });
    }
    // M1：db.close() 统一 await，成功/失败路径都要走到这里才让进程真正退出。
    await closeDbAsync(db);
  }
  return result;
}

// ---------------------------------------------------------------------------
// --activate 独立入口：verified → active，旧 active → retired（单事务 + 双条件守卫）
// ---------------------------------------------------------------------------
async function runActivate(batchIdArg) {
  const batchId = Number(batchIdArg);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    console.error(`❌ --activate 参数必须是正整数 batch_id，实得：${batchIdArg}`);
    process.exit(1); // 尚未打开 db，无资源需要 finally 收尾
  }

  const db = openDb(DB_PATH);
  const { run, get } = makeHelpers(db);
  let txOpen = false;

  try {
    await run('PRAGMA busy_timeout = 5000');
    await run('BEGIN IMMEDIATE');
    txOpen = true;

    const target = await get('SELECT id, status FROM legacy_archive_batches WHERE id = ?', [batchId]);
    if (!target) {
      throw new Error(`batch #${batchId} 不存在`);
    }
    if (target.status !== 'verified') {
      throw new Error(`batch #${batchId} 当前状态是 ${target.status}，只有 verified 才能激活`);
    }

    // 先把旧 active（若有）降级 retired——必须先于下一步，否则同一事务内会短暂出现两条 active，
    // 违反部分唯一索引 idx_legacy_archive_batches_active。
    const retireResult = await run(
      `UPDATE legacy_archive_batches SET status = 'retired' WHERE status = 'active'`
    );
    console.log(`[OK] 旧 active 批次降级 retired：${retireResult.changes} 条`);

    const activateResult = await run(
      `UPDATE legacy_archive_batches SET status = 'active' WHERE id = ? AND status = 'verified'`,
      [batchId]
    );
    if (activateResult.changes !== 1) {
      throw new Error(`batch #${batchId} 激活未生效（changes=${activateResult.changes}，双条件守卫拦截：并发状态变化？）`);
    }

    await run('COMMIT');
    txOpen = false;
    console.log(`\n✅ batch #${batchId} 已激活（active）。`);
  } catch (e) {
    if (txOpen) { try { await run('ROLLBACK'); } catch (_) { /* best-effort */ } }
    console.error(`\n❌ 激活失败已回滚：${e.message}`);
    process.exitCode = 1; // M1：同款——不在此处 process.exit()
  } finally {
    await closeDbAsync(db);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
// L7（A2 预筛 LOW 留存，A3 当场修）：此前 IIFE 无 .catch——runImport/runActivate 内部的抛错都已被
// 各自的 try/catch 收口（只设 process.exitCode，不再往外抛），但若未来有人在 try 之前的同步/异步
// 代码路径引入新的抛错（如顶层新增一段前置校验忘了包 try），该错误会绕开两个函数各自的 catch，
// 变成一条裸的 unhandled promise rejection——Node 对未处理拒绝的默认行为因版本而异（新版本会以
// 非 0 退出码终止，但不保证走本脚本统一的"❌"输出风格，且退出码语义不受本脚本控制）。补一层
// 顶层 .catch 兜底，统一成本脚本一贯的错误输出风格 + 显式 exitCode，不依赖 Node 的默认行为。
(async () => {
  if (ACTIVATE_BATCH_ID !== null) {
    await runActivate(ACTIVATE_BATCH_ID);
  } else {
    await runImport();
  }
})().catch((e) => {
  console.error(`\n❌ 未捕获的顶层异常（理论不可达——若命中说明 try 之前的代码路径新增了抛错）：${e && e.message}`);
  if (e && e.stack) console.error(e.stack);
  process.exitCode = 1;
});
