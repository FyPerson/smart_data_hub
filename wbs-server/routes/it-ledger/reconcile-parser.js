'use strict';
const XLSX = require('xlsx');

const ALIASES = Object.freeze({
  asset_no: ['编号', '资产编号', '固定资产编号'], asset_name: ['资产名称', '名称'],
  dept: ['部门', '所属部门'], device_type: ['设备名称', '设备类型'], brand: ['品牌'],
  model: ['型号', '规格型号'], purchased_at: ['购置日期', '购入日期'],
  amount: ['购置金额', '金额', '原值'], qty: ['数量', '数量(台)'],
  owner_name: ['责任人', '领用人', '使用人'], remark: ['备注', '说明'],
});
function bad(reason, sheet = null, row_no = null, extra = {}) {
  return Object.assign(new Error(`对账文件无效：${reason}`), {
    status: 400, code: 'LEDGER_BAD_REQUEST', field: 'file', detail: { reason, sheet, row_no, ...extra },
  });
}
const blank = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const headerKey = value => String(value).replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
function amount(value, sheet, row) {
  if (blank(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw bad('invalid_amount', sheet, row);
  const cleaned = typeof value === 'string' ? value.replace(/[,¥￥$＄\s]/g, '') : value;
  if (cleaned === '') throw bad('invalid_amount', sheet, row);
  const result = Number(cleaned);
  if (!Number.isFinite(result) || result < 0) throw bad('invalid_amount', sheet, row);
  return result;
}
function date(cell, date1904) {
  if (!cell || blank(cell.v)) return null;
  let y, m, d;
  if (cell.t === 'n' && Number.isFinite(cell.v)) {
    const parsed = XLSX.SSF.parse_date_code(cell.v, { date1904 });
    if (!parsed) return null;
    ({ y, m, d } = parsed);
  } else {
    const match = String(cell.v).trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
    if (!match) return null;
    [, y, m, d] = match.map(Number);
  }
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (y < 100 || y > 9999 || candidate.getUTCFullYear() !== y || candidate.getUTCMonth() !== m - 1 || candidate.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Pure synchronous parsing. No mutex, DB access, file writes or asset mutation.
module.exports = function parseReconcile(buffer, normalizeReconcileKey) {
  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true, cellText: true, sheetStubs: true }); }
  catch (_) { throw bad('unreadable_workbook'); }
  if (workbook.SheetNames.length > 10) throw bad('too_many_sheets');
  const sheets = [], unknown_sheets = [], header_map = Object.create(null), rows = [];
  let total_rows = 0, skipped_rows = 0;
  const positions = new Map();
  for (const name of workbook.SheetNames) {
    if (!/固定资产|低值|报废/.test(name)) { unknown_sheets.push(name); continue; }
    const ws = workbook.Sheets[name];
    let range;
    try { range = XLSX.utils.decode_range(ws['!ref'] || 'A1'); } catch (_) { throw bad('invalid_range', name); }
    // Always anchor physical row 1 and column A, even if !ref starts elsewhere.
    const formatted = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
    const columns = Object.create(null), headers = Object.fromEntries(Object.keys(ALIASES).map(key => [key, null]));
    for (let c = 0; c <= range.e.c; c++) {
      const original = formatted[0]?.[c];
      if (blank(original)) continue;
      const target = Object.keys(ALIASES).find(key => ALIASES[key].includes(headerKey(original)));
      if (!target) continue;
      if (columns[target] !== undefined) throw bad('duplicate_header', name, 1, { column: target });
      columns[target] = c; headers[target] = String(original);
    }
    for (const required of ['asset_no', 'asset_name']) {
      if (columns[required] === undefined) throw bad('missing_header', name, 1, { column: required });
    }
    for (const merge of ws['!merges'] || []) {
      if (merge.e.r > merge.s.r && merge.e.r >= 1 && ['asset_no', 'asset_name', 'qty'].some(key => columns[key] !== undefined && columns[key] >= merge.s.c && columns[key] <= merge.e.c)) {
        throw bad('merged_key_rows', name, Math.max(1, merge.s.r) + 1);
      }
    }
    header_map[name] = headers;
    const sheet = { name, asset_class: name.includes('低值') ? 'low_value' : 'fixed', retired_hint: name.includes('报废'), rows: range.e.r, valid_rows: 0 };
    sheets.push(sheet); total_rows += sheet.rows;
    for (let r = 1; r <= range.e.r; r++) {
      const text = key => { const v = formatted[r]?.[columns[key]]; return blank(v) ? null : String(v); };
      const cell = key => columns[key] === undefined ? null : ws[XLSX.utils.encode_cell({ r, c: columns[key] })];
      const rawId = text('asset_no'), nameText = text('asset_name');
      if (blank(rawId) && blank(nameText)) { skipped_rows++; continue; }
      const key = normalizeReconcileKey(rawId);
      if (!key.ok) throw bad(`asset_no_${key.reason}`, name, r + 1);
      if (blank(nameText)) throw bad('empty_asset_name', name, r + 1);
      const quantityCell = cell('qty'), quantity = quantityCell?.v;
      if (quantityCell?.f && (quantityCell.t === 'z' || quantity === undefined || quantity === null)) throw bad('formula_without_value', name, r + 1);
      if (quantityCell?.t === 'e') throw bad('invalid_qty', name, r + 1);
      if (!blank(quantity) && !(typeof quantity === 'number' && Number.isInteger(quantity) && quantity === 1) && !(typeof quantity === 'string' && quantity.trim() === '1')) throw bad('invalid_qty', name, r + 1);
      const amountCell = cell('amount');
      if (amountCell?.f && (amountCell.t === 'z' || amountCell.v === undefined || amountCell.v === null)) throw bad('formula_without_value', name, r + 1);
      if (amountCell?.t === 'e') throw bad('invalid_amount', name, r + 1);
      const external_row = {
        sheet: name, row_no: r + 1, dept: text('dept'), device_type: text('device_type'), asset_no_raw: rawId,
        asset_name: nameText, brand: text('brand'), model: text('model'), purchased_at: date(cell('purchased_at'), !!workbook.Workbook?.WBProps?.date1904),
        qty: 1, owner_name: text('owner_name'), remark: text('remark'), retired_hint: sheet.retired_hint,
      };
      rows.push({ external_key: key.key, external_row, external_amount: amount(amountCell?.v, name, r + 1) });
      sheet.valid_rows++;
      if (!positions.has(key.key)) positions.set(key.key, []);
      positions.get(key.key).push({ sheet: name, row_no: r + 1 });
      if (rows.length > 2000) throw bad('too_many_rows');
    }
  }
  const duplicates = [...positions].filter(([, locations]) => locations.length > 1).map(([key, locations]) => ({ key, locations }));
  if (duplicates.length) throw bad('duplicate_asset_no', null, null, { duplicates });
  if (!rows.length) throw bad('no_valid_rows');
  return { rows, meta: { sheets, header_map, total_rows, skipped_rows, unknown_sheets } };
};
