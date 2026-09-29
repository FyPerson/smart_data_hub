'use strict';
const express = require('express');

module.exports = function createStocktakes(deps) {
  const { withRead, withWrite, requireLedgerWrite, stripFinance, rejectFinanceFields, handleErr,
    invariants, parseAssetRow, toRowForCheck, activeClause } = deps;
  const router = express.Router();
  const SNAPSHOT_KEYS = ['status', 'rack_id', 'u_start', 'parent_asset_id', 'slot_no', 'custodian_name', 'location_text', 'floor_id', 'room_id', 'pos', 'version'];
  const RESULTS = ['pending', 'found', 'missing', 'mismatch'];
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const err = (status, code, field, message) => Object.assign(new Error(message), { status, code, field });
  const bad = (field, message) => err(400, 'LEDGER_BAD_REQUEST', field, message);
  function id(value, field) {
    if (!invariants.isSafePosInt(value)) throw err(400, 'LEDGER_INVALID_ID', field, 'id必须是安全正整数');
    return value;
  }
  function input(req, keys) {
    const body = req.body || {};
    if (!plain(body)) throw bad('body', '请求体必须是对象');
    rejectFinanceFields(body, req.user.role === 'admin');
    const extra = Object.keys(body).find(key => !keys.includes(key));
    if (extra) throw bad(extra, '未声明的字段');
    return body;
  }
  function note(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw bad('note', 'note必须为字符串或NULL');
    return value;
  }
  function json(value, field, object = true) {
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { throw err(500, 'LEDGER_INTERNAL', field, '持久化JSON损坏'); }
    if (object && !plain(parsed)) throw err(500, 'LEDGER_INTERNAL', field, '持久化JSON对象形态错误');
    return parsed;
  }
  const snapshot = row => Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, row[key]]));
  function equal(a, b) {
    if (plain(a) && plain(b)) return a.x === b.x && a.y === b.y;
    return a === b;
  }
  async function batch(q, value) {
    const row = await q.get('SELECT * FROM it_stocktakes WHERE id=?', [id(Number(value), 'stocktake_id')]);
    if (!row) throw err(404, 'LEDGER_NOT_FOUND', 'stocktake_id', '盘点批次不存在');
    return row;
  }
  async function item(q, batchId, value) {
    const row = await q.get('SELECT * FROM it_stocktake_items WHERE id=? AND stocktake_id=?', [id(Number(value), 'item_id'), batchId]);
    if (!row) throw err(404, 'LEDGER_NOT_FOUND', 'item_id', '盘点明细不存在或不属于该批次');
    return row;
  }
  function requireOpen(row) {
    if (row.status !== 'open') throw err(400, 'LEDGER_BAD_REQUEST', 'status', '关闭后核对字段冻结'); // C6_OPEN_GATE
  }
  async function counts(q, batchId) {
    const result = { pending: 0, found: 0, missing: 0, mismatch: 0 };
    for (const row of await q.all('SELECT result,COUNT(*) AS n FROM it_stocktake_items WHERE stocktake_id=? GROUP BY result', [batchId])) {
      if (!RESULTS.includes(row.result)) throw err(500, 'LEDGER_INTERNAL', 'result', '盘点结果域损坏');
      result[row.result] = row.n;
    }
    return result;
  }
  function batchView(row) { return { ...row, scope: json(row.scope, 'scope'), summary: row.summary === null ? null : json(row.summary, 'summary') }; }
  function itemView(row) { return { ...row, expected: json(row.expected, 'expected'), actual: row.actual === null ? null : json(row.actual, 'actual') }; }
  async function unchangedExcept(q, table, before, changes) {
    const after = await q.get(`SELECT * FROM ${table} WHERE id=?`, [before.id]);
    const wanted = { ...before, ...changes };
    if (!after || Object.keys(wanted).length !== Object.keys(after).length || Object.keys(wanted).some(key => after[key] !== wanted[key])) {
      throw err(500, 'LEDGER_INTERNAL', 'id', '写后完整行与本次变更不符');
    }
    return after;
  }
  function route(method, url, writes, fn, status = 200) {
    router[method](url, ...(writes ? [requireLedgerWrite] : []), async (req, res) => {
      try {
        const value = await (writes ? withWrite : withRead)(async q => {
          if (writes) await q.assertWrite(req.user);
          return fn(q, req);
        });
        res.status(status).json(stripFinance(value, req.user.role === 'admin'));
      } catch (error) { handleErr(res, error); }
    });
  }
  async function selectScope(q, scope) {
    if (!plain(scope) || Object.keys(scope).some(key => !['categories', 'rack_ids', 'depot_only'].includes(key))) throw bad('scope', 'scope字段非法');
    const filters = [await activeClause(q,'a')]; const params = [];
    for (const key of ['categories', 'rack_ids']) if (scope[key] !== undefined) {
      if (!Array.isArray(scope[key])) throw bad('scope.' + key, '筛选必须是数组');
      for (const value of scope[key]) {
        if (key === 'categories' ? !invariants.CATEGORY_VALUES.includes(value) : !invariants.isSafePosInt(value)) throw bad('scope.' + key, '筛选值非法');
        if (key === 'rack_ids' && !await q.get('SELECT id FROM it_racks WHERE id=?', [value])) throw bad('scope.rack_ids', '机柜不存在');
      }
      if (!scope[key].length) filters.push('0=1');
      else {
        const places = scope[key].map(() => '?').join(',');
        if (key === 'categories') { filters.push(`a.category IN (${places})`); params.push(...scope[key]); }
        else { filters.push(`(a.rack_id IN (${places}) OR (a.category='disk' AND p.rack_id IN (${places})))`); params.push(...scope[key], ...scope[key]); }
      }
    }
    if (scope.depot_only !== undefined && typeof scope.depot_only !== 'boolean') throw bad('scope.depot_only', 'depot_only必须为bool');
    if (scope.depot_only) filters.push("a.status IN ('in_depot','faulty','to_retire')");
    return q.all(`SELECT a.* FROM it_assets a LEFT JOIN it_assets p ON p.id=a.parent_asset_id ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY a.id`, params);
  }
  route('post', '/', true, async (q, req) => {
    const body = input(req, ['title', 'scope', 'note']);
    if (typeof body.title !== 'string' || !body.title.trim()) throw bad('title', 'title必填');
    const scope = body.scope === undefined ? {} : body.scope;
    const rows = await selectScope(q, scope);
    const inserted = await q.run("INSERT INTO it_stocktakes(title,scope,status,created_by,note) VALUES(?,?,'open',?,?)", [body.title.trim(), JSON.stringify(scope), req.user.id, note(body.note)]);
    for (const raw of rows) {
      const expected = snapshot(parseAssetRow(raw));
      await q.run("INSERT INTO it_stocktake_items(stocktake_id,asset_id,expected,result) VALUES(?,?,?,'pending')", [inserted.lastID, raw.id, JSON.stringify(expected)]);
    }
    const created = await batch(q, inserted.lastID);
    if (created.title !== body.title.trim() || created.scope !== JSON.stringify(scope) || created.status !== 'open' || created.created_by !== req.user.id || !created.created_at || created.closed_at !== null || created.closed_by !== null || created.summary !== null || created.note !== note(body.note)) throw err(500, 'LEDGER_INTERNAL', 'stocktake_id', '盘点批次落库不符');
    const actual = await q.all('SELECT * FROM it_stocktake_items WHERE stocktake_id=? ORDER BY asset_id', [created.id]);
    if (actual.length !== rows.length || actual.some((row, i) => row.asset_id !== rows[i].id || row.expected !== JSON.stringify(snapshot(parseAssetRow(rows[i]))) || row.result !== 'pending' || row.checked_by !== null || row.checked_at !== null || row.actual !== null || row.resolved_op_id !== null || row.note !== null)) throw err(500, 'LEDGER_INTERNAL', 'expected', '盘点快照落库不符');
    return { ...batchView(created), counts: await counts(q, created.id), item_count: actual.length };
  }, 201);
  route('get', '/', false, async q => {
    const result = [];
    for (const row of await q.all('SELECT * FROM it_stocktakes ORDER BY id DESC')) result.push({ ...batchView(row), counts: await counts(q, row.id) });
    return result;
  });
  route('get', '/:id', false, async (q, req) => {
    const row = await batch(q, req.params.id); const items = [];
    for (const raw of await q.all('SELECT * FROM it_stocktake_items WHERE stocktake_id=? ORDER BY id', [row.id])) {
      const value = itemView(raw); const currentRaw = await q.get('SELECT * FROM it_assets WHERE id=?', [raw.asset_id]);
      const current = currentRaw ? parseAssetRow(currentRaw) : null;
      items.push({ ...value, current, version_changed: current ? current.version !== value.expected.version : null,
        changed_fields: current ? SNAPSHOT_KEYS.filter(key => key !== 'version' && !equal(value.expected[key], current[key])) : [] });
    }
    return { ...batchView(row), counts: await counts(q, row.id), items };
  });
  function actualValue(value) {
    if (value === undefined || value === null) return null;
    if (!plain(value) || Object.keys(value).some(key => !SNAPSHOT_KEYS.includes(key))) throw bad('actual', 'actual须为快照键的对象子集');
    for (const [key, val] of Object.entries(value)) {
      if (key === 'pos') {
        if (val !== null && (!plain(val) || Object.keys(val).sort().join(',') !== 'x,y' || ['x', 'y'].some(k => typeof val[k] !== 'number' || !Number.isFinite(val[k]) || val[k] < 0 || val[k] > 1))) throw bad('actual.pos', '坐标非法');
      } else if (['rack_id', 'u_start', 'parent_asset_id', 'slot_no', 'version'].includes(key)) {
        if ((key === 'version' || val !== null) && !invariants.isSafePosInt(val)) throw bad('actual.' + key, '须为安全正整数或可空位置');
      } else if (val !== null && typeof val !== 'string') throw bad('actual.' + key, '须为字符串或NULL');
    }
    return value;
  }
  route('put', '/:id/items/:itemId', true, async (q, req) => {
    const body = input(req, ['result', 'actual', 'note']); const parent = await batch(q, req.params.id); requireOpen(parent);
    const before = await item(q, parent.id, req.params.itemId);
    if (!RESULTS.includes(body.result)) throw bad('result', 'result非法');
    const actual = actualValue(body.actual);
    if (body.result === 'mismatch' && actual === null) throw bad('actual', 'mismatch必须提供actual');
    const now = await q.get("SELECT datetime('now','localtime') AS value");
    const changes = { result: body.result, actual: actual === null ? null : JSON.stringify(actual), checked_by: body.result === 'pending' ? null : req.user.id,
      checked_at: body.result === 'pending' ? null : now.value, note: body.note === undefined ? before.note : note(body.note) };
    await q.run('UPDATE it_stocktake_items SET result=?,actual=?,checked_by=?,checked_at=?,note=? WHERE id=?', [changes.result, changes.actual, changes.checked_by, changes.checked_at, changes.note, before.id]);
    return itemView(await unchangedExcept(q, 'it_stocktake_items', before, changes));
  });
  route('post', '/:id/close', true, async (q, req) => {
    if (req.user.role !== 'admin') throw err(403, 'LEDGER_FORBIDDEN', 'role', '关闭盘点仅admin');
    const body = input(req, ['force']); const before = await batch(q, req.params.id);
    if (before.status === 'closed') throw err(409, 'NO_OP_TRANSITION', 'status', '盘点已关闭');
    if (body.force !== undefined && typeof body.force !== 'boolean') throw bad('force', 'force必须为bool');
    const summary = await counts(q, before.id);
    if (summary.pending && body.force !== true) throw err(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'result', '仍有pending明细');
    const now = await q.get("SELECT datetime('now','localtime') AS value");
    const changes = { status: 'closed', closed_at: now.value, closed_by: req.user.id, summary: JSON.stringify(summary) };
    await q.run('UPDATE it_stocktakes SET status=?,closed_at=?,closed_by=?,summary=? WHERE id=?', [changes.status, changes.closed_at, changes.closed_by, changes.summary, before.id]);
    return batchView(await unchangedExcept(q, 'it_stocktakes', before, changes));
  });
  route('put', '/:id/items/:itemId/note', true, async (q, req) => {
    const body = input(req, ['note']); if (body.note === undefined) throw bad('note', 'note必填');
    const parent = await batch(q, req.params.id); const before = await item(q, parent.id, req.params.itemId); const value = note(body.note);
    await q.run('UPDATE it_stocktake_items SET note=? WHERE id=?', [value, before.id]);
    return itemView(await unchangedExcept(q, 'it_stocktake_items', before, { note: value }));
  });
  route('put', '/:id/note', true, async (q, req) => {
    const body = input(req, ['note']); if (body.note === undefined) throw bad('note', 'note必填');
    const before = await batch(q, req.params.id); const value = note(body.note);
    await q.run('UPDATE it_stocktakes SET note=? WHERE id=?', [value, before.id]);
    return batchView(await unchangedExcept(q, 'it_stocktakes', before, { note: value }));
  });
  async function bind(q, assetId, itemId, opId) {
    if (itemId === undefined || itemId === null) return;
    if (!invariants.isSafePosInt(itemId)) throw bad('stocktake_item_id', '盘点明细id非法');
    const before = await q.get('SELECT * FROM it_stocktake_items WHERE id=?', [itemId]);
    if (!before) throw bad('stocktake_item_id', '盘点明细不存在');
    const parent = await q.get('SELECT * FROM it_stocktakes WHERE id=?', [before.stocktake_id]);
    if (!parent) throw err(500, 'LEDGER_INTERNAL', 'stocktake_id', '盘点批次引用缺失');
    if (parent.status !== 'closed' || !['missing', 'mismatch'].includes(before.result) || before.asset_id !== assetId) throw err(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'stocktake_item_id', '差异绑定前置条件不满足');
    if (before.resolved_op_id !== null) throw err(409, 'NO_OP_TRANSITION', 'stocktake_item_id', '差异已绑定，禁止重绑');
    const events = await q.all("SELECT asset_id FROM it_asset_events WHERE op_id=? AND role='primary'", [opId]);
    if (events.length !== 1 || events[0].asset_id !== assetId) throw err(409, 'NO_OP_TRANSITION', 'stocktake_item_id', '没有唯一可绑定的本次primary事件');
    await q.run('UPDATE it_stocktake_items SET resolved_op_id=? WHERE id=?', [opId, itemId]); // C6_BIND_WRITE
    await unchangedExcept(q, 'it_stocktake_items', before, { resolved_op_id: opId });
  }
  async function validateWrittenAsset(q, assetId) {
    const raw = await q.get('SELECT * FROM it_assets WHERE id=?', [assetId]);
    if (!raw) throw err(500, 'LEDGER_INTERNAL', 'id', '编辑后资产缺失');
    const row = toRowForCheck(raw); const ctx = {};
    if (row.rack_id !== null) {
      const rack = await q.get('SELECT u_total FROM it_racks WHERE id=?', [row.rack_id]);
      if (!rack) throw err(500, 'LEDGER_INTERNAL', 'rack_id', '机柜引用缺失');
      ctx.rack = rack;
      const occupied = await q.all("SELECT id,u_start,u_height FROM it_assets WHERE rack_id=? AND status='in_service'", [row.rack_id]);
      ctx.occupiedIntervals = occupied.map(r => [r.u_start, r.u_start + r.u_height - 1, r.id]);
    }
    if (row.category === 'disk' && row.parent_asset_id !== null) {
      ctx.parent = await q.get('SELECT slot_count,status,category FROM it_assets WHERE id=?', [row.parent_asset_id]);
      if (!ctx.parent) throw err(500, 'LEDGER_INTERNAL', 'parent_asset_id', '宿主引用缺失');
    }
    if (row.category === 'ap' && row.floor_id !== null) {
      const floor = await q.get('SELECT rooms FROM it_floors WHERE id=?', [row.floor_id]);
      if (!floor) throw err(500, 'LEDGER_INTERNAL', 'floor_id', '楼层引用缺失');
      ctx.floor = { rooms: json(floor.rooms, 'rooms', false) };
    }
    if (invariants.isHostEligible(row)) ctx.childDisks = await q.all('SELECT slot_no,status FROM it_assets WHERE parent_asset_id=?', [assetId]);
    const violation = invariants.validateAssetInvariants(row, ctx); // C6_EDIT_REREAD
    if (violation) throw err(violation.status, violation.code, violation.field, violation.message);
    return raw;
  }
  return { router, bind, validateWrittenAsset };
};
