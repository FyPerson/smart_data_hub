/**
 * xlsx 表头读取 helper（取数交付质量记录 v3.0 Commit B）
 *
 * 设计来源：docs/local/数据协作模块_v3.0/取数交付质量记录_方案_20260605_v3.0.md §5.2
 * 用途：读 admin 上传的 example_xlsx 模板第一行表头，作为列对齐的"需求模板列 T"。
 *
 * 库选型（2026-06-05 探针校正）：用项目已有的 xlsx/SheetJS（server.js:10 已 require），
 *   不引入 exceljs（方案原指定 exceljs 是盘库漏看了项目已有 xlsx 库；探针实测 SheetJS
 *   sheet_to_json(ws,{header:1})[0] 干净读出 15 列中文表头，零数据行也能读）。
 *
 * 模板规范约定（codex 69 M-2/M-3 + 用户拍板）：
 *   - 表头 = 第一个 sheet 的物理第一行（不支持说明页/封面页在前，不自动识别表头行）。
 *   - 表头必须是静态文本/普通数值，**不支持公式表头**（公式无缓存值会读到 null）。
 *   - 用 raw:false 取单元格格式化文本（贴近 Excel 显示值），避免日期表头返回序列号。
 *   - 不支持分组型合并表头（真实字段在第二行的场景）；合并单元格取左上格值。
 *   - 业务保证模板必有且第一行有表头（用户拍板）；读取/解析失败属异常兜底（调用方写 NULL 未比对）。
 *
 * 异常策略（codex 67 M-2 + 69 M-4）：
 *   - 文件不存在/读取失败/非 xlsx → 抛 XLSX_READ_FAILED（调用方 C2 catch 后写 is_columns_complete=NULL，跳过比对不阻断主流程）
 *   - 空表头（无 sheet / 第一行全空）→ header=[]（调用方据此跳过比对，不报错）
 *
 * 提供 1 个工具函数：
 *   - readXlsxHeader(filePath)  读第一行表头，返回 { header, sheetName }
 */

'use strict';

const fs = require('fs');
const XLSX = require('xlsx');

/**
 * 读 xlsx 第一个 sheet 的第一行表头。
 *
 * @param {string} filePath xlsx 文件绝对路径
 * @returns {{ header: string[], sheetName: string|null }}
 *   header    = 第一行表头的原始单元格文本数组（去尾部连续空列，保留中间空列占位）
 *               文件无 sheet 或第一行全空 → []
 *               不做归一化（trim/lowercase/去空/去重由 compareColumns 统一处理，避免双重逻辑）
 *   sheetName = 实际读取的 sheet 名（M-3 诊断用；无 sheet 时为 null）
 *
 * @throws {Error} 文件不存在 / 读取失败 / 解析失败（err.code='XLSX_READ_FAILED'）
 */
function readXlsxHeader(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        const e = new Error('readXlsxHeader: filePath 必填且需为字符串');
        e.code = 'XLSX_READ_FAILED';
        throw e;
    }
    if (!fs.existsSync(filePath)) {
        const e = new Error(`xlsx 模板文件不存在：${filePath}`);
        e.code = 'XLSX_READ_FAILED';
        throw e;
    }

    let wb;
    try {
        // cellDates/cellNF/cellHTML 关掉减少开销；只需要表头文本
        wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellHTML: false });
    } catch (err) {
        const e = new Error(`xlsx 解析失败：${err.message}`);
        e.code = 'XLSX_READ_FAILED';
        throw e;
    }

    const firstSheetName = wb.SheetNames && wb.SheetNames[0];
    if (!firstSheetName) return { header: [], sheetName: null };  // 无 sheet
    const ws = wb.Sheets[firstSheetName];
    if (!ws || !ws['!ref']) return { header: [], sheetName: firstSheetName };  // 空 sheet（无数据范围）

    // header:1 → 二维数组，第一行即表头；defval:null 让空单元格占位为 null（保持列位置）
    // raw:false → 取格式化文本（cell.w，贴近 Excel 显示值），避免日期表头返回序列号（M-2）
    // ⚠️ 不传 blankrows:false：表头语义 = 物理第一行。若传 blankrows:false，全空的第一行会被
    //    跳过、第二行数据被误当表头（会把数据行当列名引发错误列对齐）。第一行全空 = 无有效表头 → []。
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    if (!rows || rows.length === 0) return { header: [], sheetName: firstSheetName };

    const headerRow = rows[0];
    if (!Array.isArray(headerRow)) return { header: [], sheetName: firstSheetName };

    // 去掉尾部连续的空单元格（xlsx 常把范围撑宽留尾部空列），但中间空列保留占位
    // —— compareColumns 会再忽略空列名，这里只是不把"尾部撑宽的空列"带出来污染诊断列数
    let lastNonEmpty = -1;
    for (let i = 0; i < headerRow.length; i++) {
        const v = headerRow[i];
        if (v != null && String(v).trim() !== '') lastNonEmpty = i;
    }
    if (lastNonEmpty < 0) return { header: [], sheetName: firstSheetName };  // 第一行全空

    const header = headerRow.slice(0, lastNonEmpty + 1).map(v => (v == null ? '' : String(v)));
    return { header, sheetName: firstSheetName };
}

module.exports = {
    readXlsxHeader,
};
