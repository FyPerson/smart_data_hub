'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const express = require('express');
const XLSX = require('xlsx');
const parse = require('../routes/it-ledger/reconcile-parser');

module.exports = async function verifyR2({ check, withTimeout, rawAllOn, rawRunOn, logger }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'it-reconcile-r2-'));
  const db = path.join(root, 'test.db'), store = path.join(root, 'originals');
  let mod, server;
  const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } };
  const all = (sql, args = []) => withTimeout(rawAllOn(db, sql, args), 5000, 'R2 raw read');
  const run = (sql, args = []) => withTimeout(rawRunOn(db, sql, args), 5000, 'R2 raw write');
  const workbook = (sheets, type = 'xlsx') => {
    const book = XLSX.utils.book_new();
    for (const [name, rows, edit] of sheets) {
      const sheet = XLSX.utils.aoa_to_sheet(rows); if (edit) edit(sheet);
      XLSX.utils.book_append_sheet(book, sheet, name);
    }
    return XLSX.write(book, { type: 'buffer', bookType: type });
  };
  const one = (row = ['a', 'Asset'], headers = ['编号', '资产名称'], edit) => workbook([['固定资产', [headers, row], edit]]);
  const tables = ['it_assets', 'it_asset_events', 'it_stocktakes', 'it_stocktake_items', 'it_reconciles', 'it_reconcile_items'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, await all(`SELECT * FROM ${table} ORDER BY id`)])));
  const files = () => fs.existsSync(store) ? fs.readdirSync(store).sort() : [];
  try {
    await run("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,display_name TEXT,role TEXT)");
    for (const [id, role] of [[1, 'admin'], [2, 'user'], [3, 'user']]) await run('INSERT INTO users VALUES(?,?,?,?)', [id, `user${id}`, `User ${id}`, role]);
    const authenticateToken = (req, res, next) => {
      if (!req.headers['x-test-id']) return res.status(401).json({ code: 'TEST_UNAUTHORIZED' });
      req.user = { id: Number(req.headers['x-test-id']), role: req.headers['x-test-role'] || 'user' }; next();
    };
    const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ code: 'LEDGER_FORBIDDEN' });
    mod = require('../routes/it-ledger')({ logger, DB_FILE: db, authenticateToken, requireAdmin, reconcileStorageDir: store, enableTestHooks: true });
    await withTimeout(mod.initSchema(), 15000, 'R2 init');
    check('R2临时模块ready', mod._internals.state.ready === true, JSON.stringify(mod._internals.state));
    const app = express(); app.use(express.json()); app.use('/api', mod.router);
    server = await withTimeout(listenOnSafePort(app, null), 5000, 'R2 listen');
    const base = `http://127.0.0.1:${server.address().port}/api/it-assets`;
    const headers = user => user === null ? {} : { 'x-test-id': String(user?.id || 1), 'x-test-role': user?.role || 'admin' };
    async function api(method, suffix, body, user) {
      return withTimeout((async () => {
        const response = await fetch(base + suffix, { method, headers: { ...headers(user), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      })(), 10000, 'R2 json request');
    }
    async function upload(buffer, filename = 'assets.xlsx', fields = {}, user) {
      return withTimeout((async () => {
        const form = new FormData(); if (buffer) form.append('file', new Blob([buffer]), filename);
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        const response = await fetch(base + '/reconciles', { method: 'POST', headers: headers(user), body: form });
        return { status: response.status, body: await response.json() };
      })(), 15000, 'R2 upload');
    }
    async function reject(label, buffer, status = 400, filename, fields, user) {
      const before = await snapshot(), oldFiles = files();
      const result = await upload(buffer, filename, fields, user);
      check(label + ':status', result.status === status, JSON.stringify(result));
      if (status === 400) check(label + ':错误码', result.body.code === 'LEDGER_BAD_REQUEST', JSON.stringify(result));
      check(label + ':六表零变化', same(before, await snapshot()));
      check(label + ':原件零新增', same(files(), oldFiles));
      return result;
    }
    const normalize = mod._internals.normalizeReconcileKey;
    function parsed(buffer) { return parse(buffer, normalize); }
    function parserReject(label, buffer, reason) {
      let error; try { parsed(buffer); } catch (e) { error = e; }
      check('R2解析反例-' + label, !!error && error.status === 400 && error.code === 'LEDGER_BAD_REQUEST' && error.detail.reason === reason, error && JSON.stringify(error.detail));
      return error;
    }
    const aliasGroups = [
      ['编号', '资产编号', '固定资产编号'], ['资产名称', '名称'], ['部门', '所属部门'], ['设备名称', '设备类型'], ['品牌'], ['型号', '规格型号'],
      ['购置日期', '购入日期'], ['购置金额', '金额', '原值'], ['数量', '数量(台)', ' 数量\n（台） '], ['责任人', '领用人', '使用人'], ['备注', '说明'],
    ];
    const standard = aliasGroups.map(group => group[0]), values = ['001', 'Asset', 'Dept', 'Type', 'Brand', 'Model', '2026-09-20', 12, 1, 'Owner', 'Note'];
    for (let c = 0; c < aliasGroups.length; c++) for (const alias of aliasGroups[c]) {
      const h = [...standard]; h[c] = alias;
      const out = parsed(one(values, h));
      check(`R2别名 ${c}/${alias}`, out.rows.length === 1 && out.rows[0].external_key === '001' && Object.values(out.meta.header_map['固定资产']).includes(alias));
    }
    for (const [v, accept] of [[null, true], ['', true], [' ', true], [1, true], ['1', true], [' 1 ', true], ['1.0', false], ['01', false], [0, false], [2, false], [-1, false], [1.5, false], [true, false]]) {
      const buffer = one(['Q', 'name', v], ['编号', '资产名称', '数量']);
      if (accept) check('R2数量合法/空默认1 ' + JSON.stringify(v), parsed(buffer).rows[0].external_row.qty === 1);
      else parserReject('数量' + JSON.stringify(v), buffer, 'invalid_qty');
    }
    for (const [v, expected] of [[null, null], ['', null], ['  ', null], [0, 0], [1.25, 1.25], [' ￥ 1,234.50 ', 1234.5], ['$0', 0], ['＄ 2', 2]]) check('R2金额合法 ' + JSON.stringify(v), parsed(one(['M', 'n', v], ['编号', '资产名称', '金额'])).rows[0].external_amount === expected);
    for (const value of ['￥', '$ ', 'abc', '-1', -1, 'Infinity', 'NaN', true]) parserReject('金额' + String(value), one(['M', 'n', value], ['编号', '资产名称', '金额']), 'invalid_amount');
    const formatted = parsed(one([7, 'name'], undefined, sheet => { sheet.A2.z = '00000'; }));
    check('R2格式化数字编号保留前导零', formatted.rows[0].external_key === '00007' && formatted.rows[0].external_row.asset_no_raw === '00007');
    for (const [value, format, expected] of [['0012', null, '0012'], [12, '0000', '0012'], [12, null, '12']]) check('R2方案前导零三样本 ' + expected + '/' + format, parsed(one([value, 'name'], undefined, sheet => { if (format) sheet.A2.z = format; })).rows[0].external_key === expected);
    for (const [value, expected] of [['2024-02-29', '2024-02-29'], ['2023-02-29', null], ['2026/9/2', '2026-09-02'], ['n/a', null], [null, null], [1, '1900-01-01'], [60, null]]) check('R2日期 ' + String(value), parsed(one(['D', 'n', value], ['编号', '资产名称', '购置日期'])).rows[0].external_row.purchased_at === expected);
    check('R2数量公式缓存', parsed(one(['F', 'n', 1], ['编号', '资产名称', '数量'], sheet => { sheet.C2.f = '1+0'; })).rows[0].external_row.qty === 1);
    parserReject('数量公式无缓存', one(['F', 'n', 1], ['编号', '资产名称', '数量'], sheet => { sheet.C2 = { t: 'n', f: '1+0' }; }), 'formula_without_value');
    parserReject('金额公式无缓存', one(['F', 'n', 1], ['编号', '资产名称', '金额'], sheet => { sheet.C2 = { t: 'n', f: '1+0' }; }), 'formula_without_value');
    parserReject('数量Excel错误值不可当整数1', one(['F', 'n', 1], ['编号', '资产名称', '数量'], sheet => { sheet.C2 = { t: 'e', v: 0x07, f: '1/0' }; }), 'invalid_qty');
    parserReject('金额Excel错误值不可当数值7', one(['F', 'n', 1], ['编号', '资产名称', '金额'], sheet => { sheet.C2 = { t: 'e', v: 0x07, f: '1/0' }; }), 'invalid_amount');
    parserReject('重复目标表头', one(['A', 'n', 'A'], ['编号', '资产名称', '资产编号']), 'duplicate_header');
    parserReject('缺编号表头', one(['A', 'n'], ['序号', '资产名称']), 'missing_header');
    parserReject('不搜寻第二行表头', workbook([['固定资产', [[], standard, values]]]), 'missing_header');
    parserReject('ref始于第二行仍不冒充表头', one(['编号', '资产名称'], undefined, sheet => { delete sheet.A1; delete sheet.B1; sheet['!ref'] = 'A2:B2'; }), 'missing_header');
    parserReject('零有效资产', workbook([['固定资产', [standard, [], []]]]), 'no_valid_rows');
    parserReject('缺名称', one(['A', '']), 'empty_asset_name');
    for (const [value, reason] of [[null, 'empty'], ['a b', 'charset'], ['a\n', 'newline'], ['x'.repeat(65), 'charset']]) parserReject('编号 ' + String(value), one([value, 'n']), `asset_no_${reason}`);
    for (const column of [0, 1, 2]) parserReject('关键合并' + column, workbook([['固定资产', [['编号', '资产名称', '数量'], ['a', 'A', 1], ['b', 'B', 1]], sheet => { sheet['!merges'] = [{ s: { r: 1, c: column }, e: { r: 2, c: column } }]; }]]), 'merged_key_rows');
    const dup = parserReject('跨sheet全部重复定位', workbook([['固定资产', [['编号', '资产名称'], ['abc', 'A'], ['ABC', 'B']]], ['低值报废', [['编号', '资产名称'], ['　Abc ', 'C']]]]), 'duplicate_asset_no');
    check('R2重复三处完整位置', same(dup?.detail.duplicates, [{ key: 'ABC', locations: [{ sheet: '固定资产', row_no: 2 }, { sheet: '固定资产', row_no: 3 }, { sheet: '低值报废', row_no: 2 }] }]));
    const dimensions = parsed(workbook([['低值报废', [['编号', '资产名称'], ['a', 'A'], [], ['b', 'B']]], ['说明', [['not headers']]]]));
    check('R2低值与报废独立+unknown+统计', same(dimensions.meta.sheets, [{ name: '低值报废', asset_class: 'low_value', retired_hint: true, rows: 3, valid_rows: 2 }]) && dimensions.meta.total_rows === 3 && dimensions.meta.skipped_rows === 1 && same(dimensions.meta.unknown_sheets, ['说明']));
    const manyRows = [['编号', '资产名称'], ...Array.from({ length: 2000 }, (_, i) => ['X' + i, 'N'])];
    check('R2行数2000允许', parsed(workbook([['固定资产', manyRows]])).rows.length === 2000);
    parserReject('2001行拒绝', workbook([['固定资产', [...manyRows, ['X2000', 'N']]]]), 'too_many_rows');
    const ten = [['固定资产', [['编号', '资产名称'], ['a', 'A']]], ...Array.from({ length: 9 }, (_, i) => ['其他' + i, [['x']]])];
    check('R2总sheet10允许含未知', parsed(workbook(ten)).meta.unknown_sheets.length === 9);
    parserReject('11sheet含未知也拒绝', workbook([...ten, ['其他9', [['x']]]]), 'too_many_sheets');
    // Reproduce the book's non-adjacent duplicate shape without private input.
    // Keep blank rows so the parser must report physical Excel rows, not item indices.
    const duplicateRows = Array.from({ length: 49 }, () => []);
    duplicateRows[0] = ['编号', '资产名称'];
    duplicateRows[1] = ['SYNTH-UNIQUE', 'Synthetic unique asset'];
    duplicateRows[14] = ['SYNTH-DUP-001', 'Synthetic duplicate A'];
    duplicateRows[48] = ['SYNTH-DUP-001', 'Synthetic duplicate B'];
    const samplePath = path.join(root, 'synthetic-duplicate-book.xlsx');
    const sample = workbook([['固定资产表', duplicateRows]]);
    fs.writeFileSync(samplePath, sample);
    const sampleBefore = Buffer.from(sample);
    const duplicateError = parserReject('合成册子非相邻重复', sample, 'duplicate_asset_no');
    check('R2合成册子重复定位', same(duplicateError?.detail.duplicates, [{ key: 'SYNTH-DUP-001', locations: [{ sheet: '固定资产表', row_no: 15 }, { sheet: '固定资产表', row_no: 49 }] }]));
    const allowedMerge = workbook([['报废', [['编号', '资产名称', '金额'], ['a', 'A', 10], ['b', 'B', null]], sheet => { sheet['!merges'] = [{ s: { r: 1, c: 2 }, e: { r: 2, c: 2 } }]; }]]);
    check('R2金额合并允许且不向下填充', same(parsed(allowedMerge).rows.map(row => row.external_amount), [10, null]));

    for (const [id, level] of [[2, 'write'], [3, 'read']]) {
      const result = await api('PUT', `/acl/${id}`, { level }); check('R2ACL夹具', result.status === 200, JSON.stringify(result));
    }
    await reject('R2未登录', one(), 401, undefined, undefined, null);
    await reject('R2read不得创建', one(), 403, undefined, undefined, { id: 3, role: 'user' });
    await reject('R2无ACL', one(), 403, undefined, undefined, { id: 99, role: 'user' });
    await reject('R2缺文件', null);
    await reject('R2错误后缀', one(), 400, 'a.csv');
    await reject('R2大小越界', Buffer.alloc(2 * 1024 * 1024 + 1));
    // #37: three valid XLSX files, not junk padding, prove the inclusive business boundary.
    const byteLimit = 2 * 1024 * 1024, boundaryBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(boundaryBook, XLSX.utils.aoa_to_sheet([['编号','资产名称'],['BOUNDARY','Boundary asset']]), '固定资产');
    const filler = XLSX.utils.aoa_to_sheet(Array.from({ length: 70 }, () => ['x'.repeat(30000)]));
    XLSX.utils.book_append_sheet(boundaryBook, filler, '填充');
    const writeBoundary = () => XLSX.write(boundaryBook, { type: 'buffer', bookType: 'xlsx', compression: false });
    const lastLength = 30000 + byteLimit - writeBoundary().length;
    check('R2精确字节边界夹具可构造', Number.isInteger(lastLength) && lastLength > 0 && lastLength < 32767);
    for (const delta of [-1, 0, 1]) {
      filler.A70.v = 'x'.repeat(lastLength + delta);
      const bytes = writeBoundary(); assert.equal(bytes.length, byteLimit + delta);
      check('R2边界文件确实是合法册子 ' + delta, parsed(bytes).rows.length === 1);
      if (delta > 0) {
        const result = await reject('R2合法册子多1字节仍拒绝', bytes);
        check('R2多1字节明确接收层限额拒绝', result.body.field === 'file' && result.body.message === '上传失败：LIMIT_FILE_SIZE');
      } else {
        const before = await snapshot(), result = await upload(bytes, 'boundary-' + bytes.length + '.xlsx');
        check('R2合法册子边界内201 ' + delta, result.status === 201, JSON.stringify(result));
        if (result.status !== 201) throw Error('inclusive upload boundary failed');
        check('R2边界册子分类/统计正确 ' + delta, result.body.counts.not_in_ledger === 1 && result.body.source_meta.total_rows === 1 && same(result.body.source_meta.unknown_sheets, ['填充']));
        const source = JSON.parse((await all('SELECT source_meta FROM it_reconciles WHERE id=?', [result.body.id]))[0].source_meta);
        check('R2边界原件完整不截断 ' + delta, fs.readFileSync(path.join(store, source.stored_name)).equals(bytes));
        const after = await snapshot();
        check('R2边界上传不改非对账四表 ' + delta, ['it_assets','it_asset_events','it_stocktakes','it_stocktake_items'].every(table => same(before[table], after[table])));
      }
    }
    await reject('R2坏工作簿', Buffer.from([0, 1, 2, 3]));
    await reject('R2无有效数据', workbook([['固定资产', [standard]]]));
    for (const fields of [{ resolved_op_id: 'fake' }, { stocktake_item_id: '1' }, { title: '' }, { fin_amount: '1' }, { 'note[x]': 'nested' }]) await reject('R2拒绝字段' + JSON.stringify(fields), one(), 400, undefined, fields);
    // Frozen §13's exact 3-ledger/3-book arithmetic, in this otherwise empty temporary DB.
    for (const number of ['yw01-02-267', 'SMALL2', 'SMALL3']) {
      const r = await api('POST', '', { category: 'other', name: number, asset_no: number, placement: { kind: 'depot', status: 'in_depot' } });
      check('R2三台账夹具', r.status === 201, JSON.stringify(r));
    }
    const small = await upload(workbook([['固定资产', [['编号', '资产名称'], ['YW01-02-267', 'A'], ['small2', 'B'], ['NEW3', 'C']]]]));
    check('R2三台账三册行算术及对称规范化', small.status === 201 && small.body.counts.pending === 2 && small.body.counts.not_in_ledger === 1 && small.body.counts.not_in_sheet === 1 && Object.values(small.body.counts).reduce((a,b) => a+b,0) === 4, JSON.stringify(small));
    // This reset is restricted to the exclusively owned test database, before the main fixture baseline.
    for (const table of ['it_reconcile_items', 'it_reconciles', 'it_asset_events', 'it_assets']) await run(`DELETE FROM ${table}`);
    // Create all-category legitimate ledger fixtures through the real API, then use raw SQL only for legacy invalid/duplicate IDs.
    const definitions = [['server', 'unique'], ['disk', 'amb'], ['laptop', 'AMB'], ['ap', 'no-book'], ['other', null], ['software', 'soft'], ['subscription', 'sub'], ['other', 'orphan'], ['other', 'ORPHAN'], ['other', 'bad no']];
    const ids = [];
    for (const [category, number] of definitions) {
      const body = { category, name: category + ids.length, fin_amount: 321, fin_vendor: 'private', owner_name: 'Owner', owner_dept: 'Dept', asset_class: 'fixed' };
      if (['software', 'subscription'].includes(category)) body.expires_at = '2027-01-01'; else body.placement = { kind: 'depot', status: 'in_depot' };
      if (category === 'server') { body.u_height = 1; body.slot_count = 4; }
      const result = await api('POST', '', body); check('R2资产夹具 ' + category, result.status === 201, JSON.stringify(result));
      if (result.status !== 201) throw Error('R2 fixture failed');
      ids.push(result.body.id); await run('UPDATE it_assets SET asset_no=? WHERE id=?', [number, result.body.id]);
    }
    await run("UPDATE it_assets SET status='retired' WHERE id=?", [ids[3]]);
    const matchBook = workbook([['固定资产', [['编号', '资产名称', '购置金额'], [' UNIQUE ', 'Unique book', 123], ['amb', 'Amb book', 234], ['new', 'New book', 345], ['soft', 'Software book', 456], ['sub', 'Sub book', 567]]]]);
    const unchanged = await snapshot(), indexes = await all("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name");
    const response = await upload(matchBook, 'match.xlsx', { title: 'R2 batch', note: 'batch note' }, { id: 2, role: 'user' });
    check('R2write创建201', response.status === 201, JSON.stringify(response)); if (response.status !== 201) throw Error('R2 create failed');
    check('R2响应十类计数', same(response.body.counts, { pending: 3, found: 0, missing: 0, mismatch: 0, not_in_ledger: 1, ledger_added: 0, not_in_sheet: 5, confirmed_off_book: 0, ambiguous: 1, ledger_fixed: 0 }));
    check('R2响应隐藏stored_name且JSON已解析', typeof response.body.source_meta === 'object' && !Object.hasOwn(response.body.source_meta, 'stored_name'));
    const batch = (await all('SELECT * FROM it_reconciles WHERE id=?', [response.body.id]))[0], items = await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [batch.id]);
    const source = JSON.parse(batch.source_meta), internal = mod._internals;
    check('R2source_meta精确十键', same(Object.keys(source).sort(), ['filename','stored_name','key_rule_version','sheets','header_map','parsed_at','parsed_by','total_rows','skipped_rows','unknown_sheets'].sort()));
    check('R2header_map精确11目标键及原列名', same(source.header_map['固定资产'], { asset_no: '编号', asset_name: '资产名称', dept: null, device_type: null, brand: null, model: null, purchased_at: null, amount: '购置金额', qty: null, owner_name: null, remark: null }));
    check('R2原件逐字节完整且随机名', /^[a-f0-9-]{36}\.xlsx$/.test(source.stored_name) && fs.readFileSync(path.join(store, source.stored_name)).equals(matchBook));
    check('R2创建人元数据', batch.created_by === 2 && source.parsed_by === 2 && source.key_rule_version === 1 && batch.note === 'batch note' && batch.status === 'open');
    let candidateCount = 0; const regular = [], candidates = [];
    for (const item of items) {
      check('R2初态无核对/actual/note', item.checked_by === null && item.checked_at === null && item.actual === null && item.note === null);
      if (item.external_row) { const row = JSON.parse(item.external_row); check('R2册面13键且无金额', same(Object.keys(row).sort(), ['sheet','row_no','dept','device_type','asset_no_raw','asset_name','brand','model','purchased_at','qty','owner_name','remark','retired_hint'].sort()) && !Object.hasOwn(row, 'amount')); }
      if (item.ledger_snapshot) {
        const row = JSON.parse(item.ledger_snapshot), asset = unchanged.it_assets.find(a => a.id === item.asset_id);
        check('R2台账12键精确', same(Object.keys(row).sort(), ['version','asset_no','name','brand','model','sn','category','status','owner_name','owner_dept','asset_class','location_desc'].sort()));
        check('R2台账快照逐字段值', same(row, { version: asset.version, asset_no: asset.asset_no, name: asset.name, brand: asset.brand, model: asset.model, sn: asset.sn, category: asset.category, status: asset.status, owner_name: asset.owner_name, owner_dept: asset.owner_dept, asset_class: asset.asset_class, location_desc: null }));
        regular.push(item.asset_id);
      }
      if (item.ambiguous_candidates) {
        const cs = JSON.parse(item.ambiguous_candidates); candidateCount += cs.length; candidates.push(...cs.map(c => c.id));
        check('R2歧义全候选精确内容', same(cs.map(c => c.id), [ids[1], ids[2]]) && cs.every(c => same(Object.keys(c).sort(), ['id', 'asset_no', 'name', 'sn', 'category', 'location_desc'].sort())));
        check('R2候选快照逐字段值', same(cs, [ids[1], ids[2]].map(id => { const a = unchanged.it_assets.find(row => row.id === id); return { id, asset_no: a.asset_no, name: a.name, sn: a.sn, category: a.category, location_desc: null }; })));
        check('R2歧义不伪装asset或snapshot', item.asset_id === null && item.ledger_snapshot === null && item.result === 'ambiguous');
      }
    }
    check('R2覆盖守恒+引用互斥', regular.length + candidateCount === 10 && new Set([...regular, ...candidates]).size === 10 && !regular.some(id => candidates.includes(id)));
    check('R2未命中重复组各自册外', [ids[7], ids[8]].every(id => items.some(item => item.asset_id === id && item.result === 'not_in_sheet')));
    check('R2无编号及格式异常保留原快照', [ids[4], ids[9]].every(id => items.some(item => item.asset_id === id && item.result === 'not_in_sheet')));
    check('R2退休记录同样覆盖', JSON.parse(items.find(item => item.asset_id === ids[3]).ledger_snapshot).status === 'retired');
    const after = await snapshot();
    check('R2四个非对账表完整不变', ['it_assets', 'it_asset_events', 'it_stocktakes', 'it_stocktake_items'].every(table => same(unchanged[table], after[table])));
    check('R2所有索引SQL不变', same(indexes, await all("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name")));
    await run("CREATE TRIGGER r2_abort BEFORE INSERT ON it_reconcile_items WHEN NEW.result='ambiguous' BEGIN SELECT RAISE(ABORT,'R2 expected fault'); END");
    await reject('R2数据库中途失败', matchBook, 500, undefined, undefined, { id: 2, role: 'user' });
    await run('DROP TRIGGER r2_abort');
    await run("CREATE TRIGGER r2_dirty AFTER INSERT ON it_reconcile_items BEGIN UPDATE it_reconcile_items SET note='unexpected trigger' WHERE id=NEW.id; END");
    const dirty = await reject('R2实际落库偏离也回滚', matchBook, 500);
    check('R2写后整行校验真实触发', dirty.body.code === 'LEDGER_INTERNAL' && dirty.body.message === '明细写后整行校验失败');
    await run('DROP TRIGGER r2_dirty');
    await run("CREATE TRIGGER r2_batch_dirty AFTER INSERT ON it_reconciles BEGIN UPDATE it_reconciles SET created_at='unexpected timestamp' WHERE id=NEW.id; END");
    const dirtyBatch = await reject('R2批次实际整行偏离回滚', matchBook, 500);
    check('R2批次时间也精确校验', dirtyBatch.body.code === 'LEDGER_INTERNAL' && dirtyBatch.body.message === '批次写后整行校验失败');
    await run('DROP TRIGGER r2_batch_dirty');
    const beforeACL = await all('SELECT * FROM it_asset_acl ORDER BY user_id');
    await run('CREATE TRIGGER r2_revoke AFTER INSERT ON it_reconciles BEGIN DELETE FROM it_asset_acl WHERE user_id=2; END');
    const forbidden = await reject('R2最终写权限事务内复核', matchBook, 403, undefined, undefined, { id: 2, role: 'user' });
    check('R2终判精确权限码及ACL也回滚', forbidden.body.code === 'LEDGER_FORBIDDEN' && same(beforeACL, await all('SELECT * FROM it_asset_acl ORDER BY user_id')));
    await run('DROP TRIGGER r2_revoke');
    // Signal-controlled order: an existing writer owns the mutex; upload queues and must classify the committed current ledger.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = mod._internals.setTxnMidGate(gate);
    let first, second, stopPolling = false;
    try {
      first = mod._internals.withWrite(q => q.run('UPDATE it_assets SET name=?,version=version+1 WHERE id=?', ['Current at classification', ids[0]]));
      await withTimeout(arrived, 5000, 'R2 writer arrived');
      second = upload(matchBook);
      await withTimeout(new Promise(resolve => {
        const tick = () => { if (stopPolling) return; if (mod._internals.itTxnMutex._internals.waiterCount() > 0) resolve(); else setImmediate(tick); }; tick();
      }), 5000, 'R2 upload queued');
      check('R2并发上传确实排队', mod._internals.itTxnMutex._internals.waiterCount() > 0);
      mod._internals.setTxnMidGate(null); release();
      const [, created] = await withTimeout(Promise.all([first, second]), 15000, 'R2 ordered complete');
      check('R2等待写入完成后建批次', created.status === 201, JSON.stringify(created));
      const item = (await all('SELECT ledger_snapshot FROM it_reconcile_items WHERE reconcile_id=? AND asset_id=?', [created.body.id, ids[0]]))[0];
      check('R2快照读取事务内最新值', JSON.parse(item.ledger_snapshot).name === 'Current at classification' && JSON.parse(item.ledger_snapshot).version === 2);
    } finally {
      stopPolling = true; mod._internals.setTxnMidGate(null); release();
      await withTimeout(Promise.allSettled([first, second].filter(Boolean)), 15000, 'R2 ordered cleanup');
    }
    const xls = await upload(workbook([['固定资产', [['编号', '资产名称'], ['LEGACY', 'Legacy']]]], 'xls'), '盘点原件.XLS');
    check('R2旧.xls实际可上传', xls.status === 201, JSON.stringify(xls));
    check('R2中文原始文件名保真', xls.body.source_meta?.filename === '盘点原件.XLS', xls.body.source_meta?.filename);
    const duplicateResult = await reject('R2合成册子重复整批拒绝', sample);
    check('R2HTTP合成重复定位不丢失', same(duplicateResult.body.detail.duplicates, duplicateError.detail.duplicates));
    check('R2admin创建同样隐藏stored_name', !JSON.stringify(xls.body).includes('stored_name'));
    check('R2合成样本文件及输入缓冲未改写', fs.readFileSync(samplePath).equals(sampleBefore) && sample.equals(sampleBefore));
    const oldRows = await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [batch.id]);
    // Two ambiguity groups, a duplicate group without any book row, and a malformed ID coexist.
    await run('UPDATE it_assets SET asset_no=? WHERE id=?', ['UNIQUE', ids[5]]);
    const mixedBook = workbook([['固定资产', [['编号', '资产名称'], ['amb', 'A'], ['orphan', 'B'], ['sub', 'C'], ['NEW4', 'D']]]]);
    const mixed = await upload(mixedBook);
    check('R2两歧义组混合精确计数', mixed.status === 201 && same(mixed.body.counts, { pending: 1, found: 0, missing: 0, mismatch: 0, not_in_ledger: 1, ledger_added: 0, not_in_sheet: 5, confirmed_off_book: 0, ambiguous: 2, ledger_fixed: 0 }), JSON.stringify(mixed));
    const mixedItems = await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [mixed.body.id]);
    const mixedIds = mixedItems.filter(row => row.asset_id !== null).map(row => row.asset_id);
    const mixedCandidates = mixedItems.filter(row => row.ambiguous_candidates !== null).flatMap(row => JSON.parse(row.ambiguous_candidates).map(c => c.id));
    check('R2混合覆盖守恒且两引用集合互斥', mixedIds.length + mixedCandidates.length === 10 && new Set([...mixedIds, ...mixedCandidates]).size === 10 && !mixedCandidates.some(id => mixedIds.includes(id)));
    check('R2混合无册面重复组逐条册外', [ids[0],ids[5]].every(id => mixedItems.some(row => row.asset_id === id && row.result === 'not_in_sheet')));
    await run('UPDATE it_assets SET asset_no=? WHERE id=?', ['fixed-disk', ids[1]]);
    const repaired = await upload(matchBook);
    check('R2修正编号后重建成功', repaired.status === 201, JSON.stringify(repaired));
    const resolved = (await all("SELECT * FROM it_reconcile_items WHERE reconcile_id=? AND external_key='AMB'", [repaired.body.id]))[0];
    check('R2新批次重新分类pending而不自动found', resolved.result === 'pending' && resolved.asset_id === ids[2] && resolved.ambiguous_candidates === null);
    check('R2旧批次全部明细永久不变', same(oldRows, await all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [batch.id])));
  } finally {
    if (server) await withTimeout(new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())), 5000, 'R2 server close');
    if (mod) await withTimeout(mod.shutdown(), 10000, 'R2 shutdown');
    // root is an exclusively owned mkdtemp directory, never a user directory.
    if (fs.existsSync(store)) { for (const file of fs.readdirSync(store)) fs.unlinkSync(path.join(store, file)); fs.rmdirSync(store); }
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root);
  }
};
