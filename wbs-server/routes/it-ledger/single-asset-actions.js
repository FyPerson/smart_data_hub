'use strict';

// C5 单资产动作；所有依赖由 C1–C3 底座注入，移除 C4 不影响本模块。
module.exports = function installSingleAssetActions(deps) {
  const { ACTION_HANDLERS, PAYLOAD_KEYS, invariants, loadAndCheckPrimary, assertEligible,
    assertStatusIn, throwViolation, toRowForCheck, parseAssetRow, writeEvent } = deps;
  const columns = {
    assign: ['status', 'custodian_user_id', 'custodian_name', 'location_text'],
    reassign: ['custodian_user_id', 'custodian_name'],
    return: ['status', 'custodian_user_id', 'custodian_name', 'location_text', 'floor_id', 'room_id', 'pos'],
    place: ['status', 'location_text'],
    relocate: ['location_text'],
    ap_place: ['status', 'floor_id', 'room_id', 'pos'],
    ap_relocate: ['floor_id', 'room_id', 'pos'],
    renew: ['expires_at'],
    cancel: ['status'],
  };
  for (const [action, keys] of Object.entries(columns)) {
    PAYLOAD_KEYS[action] = { primary: new Set(keys), affected: new Set() };
  }

  function error(status, code, field, message) {
    return Object.assign(new Error(message), { status, code, field });
  }
  function bad(field, message) { return error(400, 'LEDGER_BAD_REQUEST', field, message); }
  function textValue(value, field, required) {
    if (value === undefined || value === null) {
      if (required) throw bad(field, `${field} 必填`);
      return null;
    }
    if (typeof value !== 'string') throw bad(field, `${field} 必须为字符串`);
    const normalized = value.trim();
    if (!normalized && required) throw bad(field, `${field} 不得为空白`);
    return normalized || null;
  }
  const isTerminal = row => row.category === 'laptop' || row.category === 'desktop';
  const isNonRackOther = row => row.category === 'other' && row.u_height === 0;
  const isSoftware = row => row.category === 'software' || row.category === 'subscription';

  async function custodian(q, body) {
    const id = body.custodian_user_id === undefined ? null : body.custodian_user_id;
    let name = textValue(body.custodian_name, 'custodian_name', false);
    if (id !== null) {
      if (!invariants.isSafePosInt(id)) throw bad('custodian_user_id', '保管人id必须为安全正整数');
      const user = await q.get('SELECT id, display_name FROM users WHERE id = ?', [id]);
      if (!user) throw bad('custodian_user_id', '保管人不存在');
      name = user.display_name;
    }
    if (id === null && name === null) throw error(409, 'CUSTODIAN_REQUIRED', 'custodian_user_id', '须提供保管人id或姓名');
    return { custodian_user_id: id, custodian_name: name };
  }

  async function floorContext(q, id, input) {
    const floor = await q.get('SELECT rooms FROM it_floors WHERE id = ?', [id]);
    if (!floor) throw error(input ? 400 : 500, input ? 'LEDGER_BAD_REQUEST' : 'LEDGER_INTERNAL', 'floor_id', '楼层不存在');
    let rooms;
    try { rooms = JSON.parse(floor.rooms); }
    catch (_) { throw error(500, 'LEDGER_INTERNAL', 'floor_id', '楼层房间JSON损坏'); }
    if (!Array.isArray(rooms) || rooms.some(room => !room || typeof room !== 'object' || Array.isArray(room) || typeof room.id !== 'string')) {
      throw error(500, 'LEDGER_INTERNAL', 'floor_id', '楼层房间数据形态损坏');
    }
    return { rooms };
  }

  async function apPosition(q, body) {
    for (const key of ['floor_id', 'room_id']) {
      if (typeof body[key] !== 'string' || !body[key]) throw bad(key, `${key} 必填且为非空字符串`);
    }
    const pos = body.pos;
    if (!pos || typeof pos !== 'object' || Array.isArray(pos) || Object.keys(pos).sort().join(',') !== 'x,y') {
      throw bad('pos', 'pos 必须恰含x/y');
    }
    for (const key of ['x', 'y']) {
      if (typeof pos[key] !== 'number' || !Number.isFinite(pos[key]) || pos[key] < 0 || pos[key] > 1) throw bad('pos', 'pos坐标必须在[0,1]');
    }
    const floor = await floorContext(q, body.floor_id, true);
    if (!floor.rooms.some(room => room.id === body.room_id)) throw bad('room_id', '房间不属于该楼层');
    return { floor_id: body.floor_id, room_id: body.room_id, pos: { x: pos.x, y: pos.y } };
  }

  function sameValue(left, right) {
    if (left && right && typeof left === 'object' && typeof right === 'object') return left.x === right.x && left.y === right.y;
    return left === right;
  }

  async function finish(q, req, action, primary, target, body, opId) {
    const before = toRowForCheck(primary);
    if (['reassign', 'relocate', 'ap_relocate'].includes(action) && Object.keys(target).every(key => sameValue(before[key], target[key]))) {
      throw error(409, 'NO_OP_TRANSITION', 'action', '有效业务目标与当前值相同');
    }
    const keys = Object.keys(target);
    const sql = keys.map(key => `${key} = ?`).join(', ');
    const values = keys.map(key => key === 'pos' && target[key] !== null ? JSON.stringify(target[key]) : target[key]);
    await q.run(`UPDATE it_assets SET ${sql}, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?`, [...values, primary.id]); // C5_VERSION_UPDATE
    const reread = await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.id]);
    if (!reread) throw error(500, 'LEDGER_INTERNAL', 'id', '写后资产行缺失');
    const row = toRowForCheck(reread);
    const ctx = {};
    if (row.category === 'ap' && row.floor_id !== null) ctx.floor = await floorContext(q, row.floor_id, false);
    const violation = invariants.validateAssetInvariants(row, ctx); // C5_REREAD_VALIDATE
    if (violation) throwViolation(violation);
    const from = {}; const to = {};
    for (const key of columns[action]) { from[key] = before[key]; to[key] = row[key]; }
    const allowed = PAYLOAD_KEYS[action].primary;
    for (const side of [from, to]) {
      if (Object.keys(side).length !== allowed.size || Object.keys(side).some(key => !allowed.has(key) || side[key] === undefined)) {
        throw error(500, 'LEDGER_INTERNAL', 'from_state/to_state', 'C5事件字段集合不全等');
      }
    }
    await writeEvent(q, { // C5_EVENT_BEGIN
      op_id: opId, asset_id: primary.id, action, role: 'primary', related_asset_id: null,
      from_state: from, to_state: to, operator_id: req.user.id, note: body.note || null,
    }); // C5_EVENT_END
    return { primary: parseAssetRow(reread), affectedIds: [] };
  }

  function register(action, paramKeys, eligible, statuses, target) {
    ACTION_HANDLERS[action] = {
      paramKeys,
      async run(q, req, id, body, opId) {
        const primary = await loadAndCheckPrimary(q, req, id, body);
        assertEligible(eligible(primary), action);
        assertStatusIn(primary.status, statuses, action);
        return finish(q, req, action, primary, await target(q, primary, body), body, opId);
      },
    };
  }
  register('assign', ['custodian_user_id', 'custodian_name', 'location_text'], isTerminal, ['in_depot'], async (q, row, body) => ({
    status: 'in_service', ...await custodian(q, body), location_text: textValue(body.location_text, 'location_text', false),
  }));
  register('reassign', ['custodian_user_id', 'custodian_name'], isTerminal, ['in_service'], (q, row, body) => custodian(q, body));
  register('return', ['to'], row => isTerminal(row) || row.category === 'ap' || isNonRackOther(row), ['in_service'], (q, row, body) => {
    const to = body.to === undefined ? 'in_depot' : body.to;
    if (!invariants.DEPOT_STATUSES.includes(to)) throw bad('to', 'to必须属于库房三态');
    return { status: to, custodian_user_id: null, custodian_name: null, location_text: null, floor_id: null, room_id: null, pos: null };
  });
  register('place', ['location_text'], isNonRackOther, ['in_depot'], (q, row, body) => ({ status: 'in_service', location_text: textValue(body.location_text, 'location_text', true) }));
  register('relocate', ['location_text'], row => isTerminal(row) || isNonRackOther(row), ['in_service'], (q, row, body) => ({ location_text: textValue(body.location_text, 'location_text', true) }));
  register('ap_place', ['floor_id', 'room_id', 'pos'], row => row.category === 'ap', ['in_depot'], async (q, row, body) => ({ status: 'in_service', ...await apPosition(q, body) }));
  register('ap_relocate', ['floor_id', 'room_id', 'pos'], row => row.category === 'ap', ['in_service'], (q, row, body) => apPosition(q, body));
  register('renew', ['expires_at'], isSoftware, ['active'], (q, row, body) => {
    if (!invariants.isValidYmd(body.expires_at)) throw bad('expires_at', 'expires_at必须为合法YYYY-MM-DD');
    if (row.expires_at !== null && !invariants.isValidYmd(row.expires_at)) throw error(500, 'LEDGER_INTERNAL', 'expires_at', '持久化旧日期非法');
    if (row.expires_at !== null && body.expires_at <= row.expires_at) throw bad('expires_at', '新到期日必须晚于旧到期日');
    return { expires_at: body.expires_at };
  });
  register('cancel', [], isSoftware, ['active'], () => ({ status: 'cancelled' }));
};
