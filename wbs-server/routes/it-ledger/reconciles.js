'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const parseWorkbook = require('./reconcile-parser');

module.exports = function createReconciles(deps) {
  const { withRead, withWrite, requireLedgerWrite, requireAdmin, stripFinance, handleErr, logger,
    normalizeReconcileKey, validateAmbiguousCandidates, SOURCE_META_KEYS, EXTERNAL_ROW_KEYS,
    LEDGER_SNAPSHOT_KEYS, AMBIGUOUS_CANDIDATE_KEYS, KEY_RULE_VERSION, RECONCILE_RESULTS, activeClause } = deps;
  const router = express.Router();
  const storageDir = path.resolve(deps.storageDir || path.join(__dirname, 'uploads', 'it-reconcile'));
  const err = (status, code, field, message) => Object.assign(new Error(message), { status, code, field });
  const bad = (field, message) => err(400, 'LEDGER_BAD_REQUEST', field, message);
  const internal = message => err(500, 'LEDGER_INTERNAL', 'reconcile', message);
  const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  function exactKeys(value, keys) {
    if (!plain(value) || Object.keys(value).length !== keys.size || Object.keys(value).some(key => !keys.has(key))) throw internal('对账快照键集合不符');
  }
  function json(value) {
    try { return JSON.parse(value); } catch (_) { throw internal('对账JSON损坏'); }
  }
  function batchView(row) {
    const source_meta = json(row.source_meta);
    exactKeys(source_meta, SOURCE_META_KEYS);
    delete source_meta.stored_name;
    return { ...row, source_meta, summary: row.summary === null ? null : json(row.summary) };
  }
  async function counts(q, id) {
    const result = Object.fromEntries(RECONCILE_RESULTS.map(key => [key, 0]));
    for (const row of await q.all('SELECT result,COUNT(*) AS n FROM it_reconcile_items WHERE reconcile_id=? GROUP BY result', [id])) {
      if (!Object.hasOwn(result, row.result)) throw internal('对账result域损坏');
      result[row.result] = row.n;
    }
    return result;
  }
  async function locations(q, assets) {
    const byId = new Map(assets.map(row => [row.id, row]));
    const racks = new Map((await q.all('SELECT * FROM it_racks')).map(row => [row.id, row]));
    const floors = new Map((await q.all('SELECT * FROM it_floors')).map(row => [row.id, row]));
    return row => {
      if (row.parent_asset_id !== null) return `${byId.get(row.parent_asset_id)?.name || row.parent_asset_id} / 槽位 ${row.slot_no}`;
      if (row.rack_id !== null) return `${racks.get(row.rack_id)?.name || row.rack_id} / U${row.u_start}`;
      if (row.floor_id !== null) {
        const floor = floors.get(row.floor_id);
        const rooms = floor ? json(floor.rooms) : [];
        return `${floor?.name || row.floor_id} / ${rooms.find(room => room.id === row.room_id)?.name || row.room_id}`;
      }
      const parts = [row.custodian_name, row.location_text].filter(v => typeof v === 'string' && v.length);
      return parts.length ? parts.join(' / ') : null;
    };
  }
  function snapshot(row, location) {
    const result = Object.fromEntries([...LEDGER_SNAPSHOT_KEYS].map(key => [key, key === 'location_desc' ? location(row) : row[key]]));
    exactKeys(result, LEDGER_SNAPSHOT_KEYS);
    return result;
  }
  function candidate(row, location) {
    return Object.fromEntries([...AMBIGUOUS_CANDIDATE_KEYS].map(key => [key, key === 'location_desc' ? location(row) : row[key]]));
  }
  const upload = multer({
    // Busboy emits limit when size equals the threshold; +1 keeps the accepted maximum inclusive at 2 MiB.
    storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 + 1, files: 1 },
    fileFilter(req, file, done) {
      const extension = path.extname(file.originalname).toLowerCase();
      done(['.xlsx', '.xls'].includes(extension) ? null : bad('file', '只允许.xlsx或.xls文件'), true);
    },
  }).single('file');
  function receive(req, res, next) {
    upload(req, res, e => e ? handleErr(res, e.status ? e : bad('file', `上传失败：${e.code || 'invalid_upload'}`)) : next());
  }
  async function removeFile(filename) {
    try { await fs.unlink(path.join(storageDir, filename)); }
    catch (e) { if (e.code !== 'ENOENT') logger.error(`[it-reconcile] 原件清理失败 stored_name=${filename}: ${e.message}`); }
  }
  function originalFilename(value) {
    // Browsers send UTF-8 multipart filenames; Busboy's legacy parameter default is Latin-1.
    // Decode only a lossless UTF-8 byte sequence, preserving genuine non-UTF-8 names.
    if (![...value].every(char => char.codePointAt(0) <= 255)) return value;
    const bytes = Buffer.from(value, 'latin1'), decoded = bytes.toString('utf8');
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : value;
  }
  router.post('/', requireLedgerWrite, receive, async (req, res) => {
    let storedName = null;
    try {
      if (!req.file) throw bad('file', '缺少上传文件');
      const body = req.body || {};
      for (const key of Object.keys(body)) if (!['title', 'note'].includes(key)) throw bad(key, '未声明的字段');
      const filename = originalFilename(req.file.originalname);
      const title = body.title === undefined ? filename : body.title;
      if (typeof title !== 'string' || !title.trim()) throw bad('title', 'title必须是非空字符串');
      const note = body.note === undefined ? null : body.note;
      if (note !== null && typeof note !== 'string') throw bad('note', 'note必须是字符串或NULL');
      // Parsing is intentionally outside withWrite: no DB access or mutex ownership.
      const parsed = parseWorkbook(req.file.buffer, normalizeReconcileKey);
      storedName = randomUUID() + path.extname(req.file.originalname).toLowerCase();
      const source = { filename, stored_name: storedName, key_rule_version: KEY_RULE_VERSION,
        ...parsed.meta, parsed_at: new Date().toISOString(), parsed_by: req.user.id };
      exactKeys(source, SOURCE_META_KEYS);
      await fs.mkdir(storageDir, { recursive: true });
      try { await fs.writeFile(path.join(storageDir, storedName), req.file.buffer, { flag: 'wx' }); }
      catch (e) { if (e.code === 'EEXIST') storedName = null; throw e; } // never unlink a file this request did not create
      const result = await withWrite(async q => {
        const assets = await q.all(`SELECT * FROM it_assets WHERE ${await activeClause(q)} ORDER BY id`);
        const location = await locations(q, assets), groups = new Map(), referenced = new Set(), expected = [];
        for (const row of assets) {
          const normalized = normalizeReconcileKey(row.asset_no);
          if (!normalized.ok) continue;
          if (!groups.has(normalized.key)) groups.set(normalized.key, []);
          groups.get(normalized.key).push(row);
        }
        const add = (external, asset, candidates, result) => {
          if (external) exactKeys(external.external_row, EXTERNAL_ROW_KEYS);
          if (candidates && !validateAmbiguousCandidates(candidates).ok) throw internal('歧义候选快照不合法');
          expected.push({ asset_id: asset?.id ?? null, external_key: external?.external_key ?? null,
            external_row: external ? JSON.stringify(external.external_row) : null, external_amount: external?.external_amount ?? null,
            ledger_snapshot: asset ? JSON.stringify(snapshot(asset, location)) : null,
            ambiguous_candidates: candidates ? JSON.stringify(candidates) : null, result, actual: null, checked_by: null, checked_at: null, note: null });
        };
        for (const external of parsed.rows) {
          const matches = groups.get(external.external_key) || [];
          for (const asset of matches) referenced.add(asset.id);
          if (matches.length === 1) add(external, matches[0], null, 'pending');
          else if (matches.length === 0) add(external, null, null, 'not_in_ledger');
          else add(external, null, matches.map(row => candidate(row, location)), 'ambiguous');
        }
        for (const asset of assets) if (!referenced.has(asset.id)) add(null, asset, null, 'not_in_sheet');
        const coverage = expected.reduce((n, row) => n + (row.asset_id === null ? 0 : 1) + (row.ambiguous_candidates ? json(row.ambiguous_candidates).length : 0), 0);
        if (coverage !== assets.length) throw internal('对账覆盖不守恒');
        const sourceJSON = JSON.stringify(source);
        const now = await q.get("SELECT datetime('now','localtime') AS value");
        const inserted = await q.run("INSERT INTO it_reconciles(title,status,source_meta,created_by,created_at,note) VALUES(?,'open',?,?,?,?)", [title, sourceJSON, req.user.id, now.value, note]);
        for (const row of expected) {
          const keys = Object.keys(row);
          const added = await q.run(`INSERT INTO it_reconcile_items(reconcile_id,${keys.join(',')}) VALUES(?,${keys.map(() => '?').join(',')})`, [inserted.lastID, ...Object.values(row)]);
          row.id = added.lastID; row.reconcile_id = inserted.lastID;
        }
        const realBatch = await q.get('SELECT * FROM it_reconciles WHERE id=?', [inserted.lastID]);
        const realItems = await q.all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [inserted.lastID]);
        if (!isDeepStrictEqual(realBatch, { id: inserted.lastID, title, status: 'open', source_meta: sourceJSON, created_by: req.user.id, created_at: now.value, closed_at: null, closed_by: null, summary: null, note })) throw internal('批次写后整行校验失败');
        if (!isDeepStrictEqual(realItems, expected)) throw internal('明细写后整行校验失败');
        await q.assertWrite(req.user);
        return { ...batchView(realBatch), counts: await counts(q, realBatch.id) };
      });
      storedName = null; // committed: retain the original even if response transmission fails
      res.status(201).json(stripFinance(result, req.user.role === 'admin'));
    } catch (e) {
      if (storedName) await removeFile(storedName);
      handleErr(res, e);
    }
  });
  // R3: all helpers below use the caller's captured transaction/query object.
  const { RECONCILE_TRANSITIONS, RECONCILE_AUTO_RESULTS, parseAssetRow, rejectFinanceFields } = deps;
  const ACTUAL_KEYS = new Set([...LEDGER_SNAPSHOT_KEYS].filter(key => key !== 'version'));
  const safeId = (value, field) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw err(400, 'LEDGER_INVALID_ID', field, 'id必须是安全正整数');
    return value;
  };
  function input(req, keys) {
    const body = req.body === undefined ? {} : req.body;
    if (!plain(body)) throw bad('body', '请求体必须是普通对象');
    rejectFinanceFields(body, req.user.role === 'admin');
    const extra = Object.keys(body).find(key => !keys.includes(key));
    if (extra) throw bad(extra, '未声明的字段');
    return body;
  }
  function noteValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw bad('note', 'note必须是字符串或NULL');
    return value;
  }
  function actualValue(value) {
    if (!plain(value) || !Object.keys(value).length) throw bad('actual', 'actual必须是非空普通对象');
    for (const [key, observed] of Object.entries(value)) {
      if (!ACTUAL_KEYS.has(key) || (observed !== null && typeof observed !== 'string')) throw bad('actual', 'actual只接受允许的文本业务字段或NULL');
    }
    return value;
  }
  async function batch(q, value) {
    const row = await q.get('SELECT * FROM it_reconciles WHERE id=?', [safeId(Number(value), 'reconcile_id')]);
    if (!row) throw err(404, 'LEDGER_NOT_FOUND', 'reconcile_id', '对账批次不存在');
    return row;
  }
  async function item(q, batchId, value) {
    const row = await q.get('SELECT * FROM it_reconcile_items WHERE reconcile_id=? AND id=?', [batchId, safeId(Number(value), 'item_id')]);
    if (!row) throw err(404, 'LEDGER_NOT_FOUND', 'item_id', '对账明细不存在或不属于本批次');
    return row;
  }
  function requireOpen(row) {
    if (row.status !== 'open') throw err(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'status', '对账批次已关闭');
  }
  async function currentContext(q) {
    // Live columns of historical batches include archived records, labelled, so they are not reported as broken references.
    const assets = await q.all('SELECT * FROM it_assets ORDER BY id'), location = await locations(q, assets);
    const archived = await q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='it_asset_record_controls'")
      ? new Map((await q.all('SELECT asset_id,state FROM it_asset_record_controls')).map(r => [r.asset_id, r.state])) : new Map();
    return new Map(assets.map(row => [row.id, { ...parseAssetRow(row), location_desc: location(row), ...(archived.has(row.id) ? { record_state: archived.get(row.id) } : {}) }]));
  }
  function itemView(row, current) {
    const external_row = row.external_row === null ? null : json(row.external_row);
    const ledger_snapshot = row.ledger_snapshot === null ? null : json(row.ledger_snapshot);
    const ambiguous_candidates = row.ambiguous_candidates === null ? null : json(row.ambiguous_candidates);
    if (row.external_row !== null) exactKeys(external_row, EXTERNAL_ROW_KEYS);
    if (row.ledger_snapshot !== null) exactKeys(ledger_snapshot, LEDGER_SNAPSHOT_KEYS);
    if (row.ambiguous_candidates !== null && !validateAmbiguousCandidates(ambiguous_candidates).ok) throw internal('歧义候选快照损坏');
    const actual = row.actual === null ? null : json(row.actual);
    if (row.actual !== null) { try { actualValue(actual); } catch (_) { throw internal('人工核实值损坏'); } }
    const normalized = ledger_snapshot ? normalizeReconcileKey(ledger_snapshot.asset_no) : null;
    return { ...row, external_row, ledger_snapshot, ambiguous_candidates, actual,
      current: row.asset_id === null ? null : current.get(row.asset_id) || null,
      candidate_current: ambiguous_candidates === null ? [] : ambiguous_candidates.map(candidate => ({ id: candidate.id, current: current.get(candidate.id) || null })),
      ledger_note: normalized && !normalized.ok ? (normalized.reason === 'empty' ? '未填编号' : '编号格式异常') : null,
      result_note: ['ledger_added', 'ledger_fixed'].includes(row.result) ? '人工声明，待新批次验证' : null };
  }
  async function changedRow(q, table, before, changes) {
    const keys = Object.keys(changes);
    await q.run(`UPDATE ${table} SET ${keys.map(key => key + '=?').join(',')} WHERE id=?`, [...Object.values(changes), before.id]);
    const actual = await q.get(`SELECT * FROM ${table} WHERE id=?`, [before.id]);
    if (!isDeepStrictEqual(actual, { ...before, ...changes })) throw internal('对账更新写后整行校验失败');
    return actual;
  }
  const handler = (writes, fn) => async (req, res) => {
    try {
      const value = await (writes ? withWrite : withRead)(async q => {
        const result = await fn(q, req);
        if (writes) await q.assertWrite(req.user);
        return result;
      });
      res.json(stripFinance(value, req.user.role === 'admin'));
    } catch (e) { handleErr(res, e); }
  };
  router.get('/', handler(false, async q => {
    const rows = await q.all('SELECT * FROM it_reconciles ORDER BY id DESC'), items = [];
    for (const row of rows) items.push({ ...batchView(row), counts: await counts(q, row.id) });
    return { items };
  }));
  router.get('/:id', handler(false, async (q, req) => {
    const row = await batch(q, req.params.id), current = await currentContext(q);
    const items = await q.all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [row.id]);
    return { ...batchView(row), counts: await counts(q, row.id), items: items.map(item => itemView(item, current)) };
  }));
  router.put('/:id/items/:itemId/check', requireLedgerWrite, handler(true, async (q, req) => {
    const parent = await batch(q, req.params.id); requireOpen(parent);
    const before = await item(q, parent.id, req.params.itemId), body = input(req, ['result', 'actual']);
    if (typeof body.result !== 'string') throw bad('result', 'result必须是字符串');
    if (!RECONCILE_TRANSITIONS[before.result]?.has(body.result)) throw err(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'result', '不允许此结果迁移');
    const actual = body.result === 'mismatch' ? actualValue(body.actual) : null;
    if (body.result !== 'mismatch' && Object.hasOwn(body, 'actual')) throw bad('actual', '只有mismatch可提交actual');
    const now = await q.get("SELECT datetime('now','localtime') AS value");
    const row = await changedRow(q, 'it_reconcile_items', before, { result: body.result, actual: actual === null ? null : JSON.stringify(actual), checked_by: req.user.id, checked_at: now.value });
    return itemView(row, await currentContext(q));
  }));
  router.put('/:id/items/bulk-confirm-off-book', requireLedgerWrite, handler(true, async (q, req) => {
    const parent = await batch(q, req.params.id); requireOpen(parent);
    const body = input(req, ['item_ids']);
    if (!Array.isArray(body.item_ids) || !body.item_ids.length || body.item_ids.some(value => !Number.isSafeInteger(value) || value <= 0)) throw bad('item_ids', 'item_ids须为非空合法id数组');
    const ids = [...new Set(body.item_ids)];
    if (ids.length > 500) throw bad('item_ids', '去重后的item_ids不能超过500');
    const before = await q.all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [parent.id]), byId = new Map(before.map(row => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id), reason = !row ? 'not_in_batch' : row.result !== 'not_in_sheet' ? 'not_off_book' : null;
      if (reason) throw Object.assign(bad('item_ids', '批量确认含不合格条目'), { detail: { item_id: id, reason } });
    }
    const now = await q.get("SELECT datetime('now','localtime') AS value"), selected = new Set(ids);
    const changes = { result: 'confirmed_off_book', checked_by: req.user.id, checked_at: now.value };
    await q.run(`UPDATE it_reconcile_items SET result='confirmed_off_book',checked_by=?,checked_at=? WHERE reconcile_id=? AND id IN (${ids.map(() => '?').join(',')})`, [req.user.id, now.value, parent.id, ...ids]);
    const after = await q.all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [parent.id]);
    if (!isDeepStrictEqual(after, before.map(row => selected.has(row.id) ? { ...row, ...changes } : row))) throw internal('对账批量写后整行校验失败');
    const current = await currentContext(q);
    return { items: after.filter(row => selected.has(row.id)).map(row => itemView(row, current)) };
  }));
  router.put('/:id/items/:itemId/note', requireLedgerWrite, handler(true, async (q, req) => {
    const parent = await batch(q, req.params.id), before = await item(q, parent.id, req.params.itemId), body = input(req, ['note']);
    return itemView(await changedRow(q, 'it_reconcile_items', before, { note: noteValue(body.note) }), await currentContext(q));
  }));
  router.put('/:id/note', requireLedgerWrite, handler(true, async (q, req) => {
    const before = await batch(q, req.params.id), body = input(req, ['note']);
    return batchView(await changedRow(q, 'it_reconciles', before, { note: noteValue(body.note) }));
  }));
  router.post('/:id/close', requireAdmin, handler(true, async (q, req) => {
    const before = await batch(q, req.params.id);
    if (before.status === 'closed') throw err(409, 'NO_OP_TRANSITION', 'status', '对账批次已关闭，不重算summary');
    const body = input(req, ['force']);
    if (body.force !== undefined && typeof body.force !== 'boolean') throw bad('force', 'force必须是布尔值');
    const force = body.force === true, values = await counts(q, before.id);
    if (!force && RECONCILE_AUTO_RESULTS.some(key => values[key] !== 0)) throw err(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'result', '仍有未核实条目');
    const now = await q.get("SELECT datetime('now','localtime') AS value");
    const summary = { ...values, closed_at: now.value, closed_by: req.user.id, force };
    return batchView(await changedRow(q, 'it_reconciles', before, { status: 'closed', closed_at: now.value, closed_by: req.user.id, summary: JSON.stringify(summary) }));
  }));
  router.delete('/:id', requireAdmin, async (req, res) => {
    try {
      const result = await withWrite(async q => {
        const before = await batch(q, req.params.id); requireOpen(before); input(req, []);
        const source = json(before.source_meta); exactKeys(source, SOURCE_META_KEYS);
        if (typeof source.stored_name !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(xlsx|xls)$/.test(source.stored_name)) throw internal('原件存储名损坏');
        await q.run('DELETE FROM it_reconcile_items WHERE reconcile_id=?', [before.id]);
        await q.run('DELETE FROM it_reconciles WHERE id=?', [before.id]);
        if (await q.get('SELECT id FROM it_reconciles WHERE id=?', [before.id]) || await q.get('SELECT id FROM it_reconcile_items WHERE reconcile_id=?', [before.id])) throw internal('对账删除写后核验失败');
        await q.assertWrite(req.user);
        return { id: before.id, storedName: source.stored_name };
      });
      await removeFile(result.storedName);
      res.json({ id: result.id, deleted: true });
    } catch (e) { handleErr(res, e); }
  });
  // R4: the backend returns column/row data; workbook writing stays in the existing client helper.
  const EXPORT_GROUPS = ['册面', '台账·建批次快照', '台账·导出时实时', '盘点'];
  const EXPORT_COLUMNS = [
    ['external_asset_no','册面编号',0],['external_dept','册面部门',0],['external_device_type','册面设备名称',0,true],
    ['external_asset_name','册面资产名称',0],['external_brand','册面品牌',0],['external_model','册面型号',0],
    ['external_purchased_at','册面购置日期',0],['external_amount','册面购置金额',0],['external_owner_name','册面责任人',0],
    ['external_remark','册面备注',0,true],['external_retired_hint','是否报废册',0],
    ['snapshot_asset_no','快照编号',1],['snapshot_name','快照名称',1],['snapshot_status','快照状态',1],
    ['snapshot_location_desc','快照位置',1],['snapshot_owner_name','快照财务责任人',1],['snapshot_owner_dept','快照财务部门',1],
    ['current_asset_no','台账编号',2],['current_name','台账名称',2],['current_category','类别',2],['current_sn','SN',2],
    ['current_status','当前状态',2],['current_location_desc','当前位置',2],['current_owner_name','财务责任人',2],
    ['current_owner_dept','财务部门',2],['current_asset_class','财务分类',2],['current_custodian_name','使用保管人',2],['link_state','台账关联状态',2],
    ['result','结果',3],['ledger_no_state','台账编号情况',3],['external_snapshot_diff','册面与快照差异',3],
    ['snapshot_current_diff','快照与当前差异',3],['actual_fields','人工核实字段',3],['checked_by','核对人',3],['checked_at','核对时间',3],['note','盘点备注',3],
  ];
  const emptyValue = value => value === null || value === '';
  function equalValue(left, right, normalizeNumber = false) {
    if (emptyValue(left) || emptyValue(right)) return emptyValue(left) && emptyValue(right);
    if (!normalizeNumber) return left === right;
    const a = normalizeReconcileKey(left), b = normalizeReconcileKey(right);
    return a.ok && b.ok && a.key === b.key;
  }
  function exportRow(item, columns) {
    const external = item.external_row, expected = item.ledger_snapshot, current = item.current;
    const candidates = item.ambiguous_candidates;
    const pairMap = [['asset_no_raw','asset_no'],['asset_name','name'],['brand','brand'],['model','model'],['owner_name','owner_name'],['dept','owner_dept']];
    const bookDiff = !external || !expected ? '不适用' : pairMap.filter(([from,to]) => !equalValue(external[from], expected[to], to === 'asset_no')).map(([,to]) => to).join('、');
    const currentDiff = !expected || !current ? '不适用' : [...ACTUAL_KEYS].filter(key => !equalValue(expected[key], current[key])).join('、');
    const currentFields = ['asset_no','name','category','sn','status','location_desc','owner_name','owner_dept','asset_class','custodian_name'];
    const number = expected ? normalizeReconcileKey(expected.asset_no) : null;
    const row = {
      external_asset_no: external?.asset_no_raw ?? null, external_dept: external?.dept ?? null, external_device_type: external?.device_type ?? null,
      external_asset_name: external?.asset_name ?? null, external_brand: external?.brand ?? null, external_model: external?.model ?? null,
      external_purchased_at: external?.purchased_at ?? null, external_amount: item.external_amount, external_owner_name: external?.owner_name ?? null,
      external_remark: external?.remark ?? null, external_retired_hint: external === null ? null : external.retired_hint ? '是' : '否',
      ...Object.fromEntries(['asset_no','name','status','location_desc','owner_name','owner_dept'].map(key => ['snapshot_' + key, expected?.[key] ?? null])),
      ...Object.fromEntries(currentFields.map(key => ['current_' + key, current?.[key] ?? null])),
      link_state: candidates ? `编号歧义（${candidates.length} 条）` : item.asset_id === null ? '无对应台账' : !current ? '原引用异常' : current.record_state ? (current.record_state === 'voided' ? '台账记录已作废' : '台账记录已删除') : currentFields.some(key => emptyValue(current[key])) ? '字段未填' : '',
      result: item.result_note ? `${item.result}（${item.result_note}）` : item.result,
      ledger_no_state: candidates ? '编号歧义' : !number ? '' : number.ok ? '正常' : number.reason === 'empty' ? '未填编号' : '编号格式异常',
      external_snapshot_diff: bookDiff, snapshot_current_diff: currentDiff, actual_fields: item.actual === null ? '' : JSON.stringify(item.actual),
      checked_by: item.checked_by, checked_at: item.checked_at, note: item.note,
    };
    return Object.fromEntries(columns.map(column => [column.key, row[column.key]]));
  }
  router.get('/:id/export', handler(false, async (q, req) => {
    const parent = await batch(q, req.params.id), current = await currentContext(q);
    const items = await q.all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id', [parent.id]);
    const columns = EXPORT_COLUMNS.filter(([key]) => req.user.role === 'admin' || key !== 'external_amount').map(([key,label,group,hidden]) => ({ key, label, group: EXPORT_GROUPS[group], hidden: hidden === true }));
    const values = await counts(q, parent.id), has_unverified = RECONCILE_AUTO_RESULTS.some(key => values[key] > 0);
    return { batch: batchView(parent), exported_at: new Date().toISOString(), has_unverified,
      notice: '快照列 = 建批次当时；实时列 = 导出当时；核对结论在批次关闭后已冻结' + (has_unverified ? '；本批次含未核实项' : ''),
      columns, groups: EXPORT_GROUPS.map(label => ({ label, keys: columns.filter(column => column.group === label).map(column => column.key) })), freeze_columns: 3,
      rows: items.map(row => exportRow(itemView(row, current), columns)) };
  }));
  router.get('/:id/source-file', requireAdmin, async (req, res) => {
    try {
      const file = await withRead(async q => {
        const parent = await batch(q, req.params.id), source = json(parent.source_meta); exactKeys(source, SOURCE_META_KEYS);
        if (typeof source.filename !== 'string' || typeof source.stored_name !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(xlsx|xls)$/.test(source.stored_name)) throw internal('原件存储元数据损坏');
        try {
          const realBase = await fs.realpath(storageDir), realFile = await fs.realpath(path.join(storageDir, source.stored_name));
          const relative = path.relative(realBase, realFile);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw internal('原件真实路径越界');
          if (!(await fs.stat(realFile)).isFile()) throw err(404, 'LEDGER_NOT_FOUND', 'file', '原件不存在');
          return { filename: source.filename, extension: path.extname(source.stored_name), bytes: await fs.readFile(realFile) };
        } catch (e) {
          if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw err(404, 'LEDGER_NOT_FOUND', 'file', '原件不存在');
          throw e;
        }
      });
      res.set('Cache-Control', 'private, no-store');
      res.type(file.extension).attachment(file.filename).send(file.bytes);
    } catch (e) { handleErr(res, e); }
  });
  return { router };
};
