// 验证脚本：系统迭代 bug 流 Commit ④b-2 — create-chat 成员多选（chat-candidates 端点 + 选中成员/报障人 opt-in）
//   用法：node scripts/verify-sys-chat-picker.js
//
// ⚠️ create-chat 与 dingtalk-notify（top-level require，不可注入）耦合——本脚本**模块 mock** dingtalk-notify 缓存导出
//   （getAccessToken/getUserIdByMobile/createChatGroup/... 全 stub），使 create-chat 能走真 HTTP 端到端跑，捕获 createChatGroup 收到的成员钉钉列表验证成员规划。
//
// 覆盖：
//   [Cand] chat-candidates：候选=active 非 viewer 有手机号 排底座 / base_members / 报障人 eligible / 不暴露手机号 / auth(非 admin·assignee 403 / 非 bug 409)
//   [Sel]  create-chat member_user_ids → 选中成员进群（createChatGroup 收到其钉钉）+ selected_added 计数
//   [Skip] 选中 无效/无手机号/viewer → selectedSkipped（不阻断建群）
//   [Req]  include_requester：false→报障人不加(not_selected) / true+有手机号→加入
//   [Cap]  member_user_ids >30 → 400 TOO_MANY_MEMBERS
//   [Dedup] 选中与底座同钉钉 → 不重复计
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

// ── 模块 mock dingtalk-notify（必须在 require index.js 之前）──
const dtn = require('../utils/dingtalk-notify');
let lastChatMembers = null, lastOwner = null;
const NOTFOUND_PHONE = '13911111111';   // codex32 M-2：合法手机号但钉钉反查返 null（查无此人）
const THROW_PHONE = '13922222222';       // codex32 M-2：反查抛异常
dtn.getAccessToken = async () => 'tok';
const FLAKY_PHONE = '13944444444';       // codex 600-R：前 flakyFails 次反查抛异常，之后成功（交错用例里「选中时解析失败、追补时恢复」）
let flakyFails = 0;
dtn.getUserIdByMobile = async (_t, phone) => {   // 手机号→唯一钉钉号；含失败分支（codex32 M-2 降级覆盖）
  if (phone === FLAKY_PHONE && flakyFails > 0) { flakyFails--; throw new Error('flaky boom'); }
  if (phone === NOTFOUND_PHONE) return null;
  if (phone === THROW_PHONE) throw new Error('lookup boom');
  return 'ding_' + phone;
};
// [codex 600 MED-1] chatGate：设了就在返回前停住（chatEntered 先 resolve，表示请求已进到钉钉建群这一步），用于建群与指派交错的用例
let chatGate = null, chatEntered = null;
dtn.createChatGroup = async (_t, _name, owner, members) => {
  lastOwner = owner; lastChatMembers = members.slice();
  if (chatGate) { if (chatEntered) chatEntered(); await chatGate; }
  return { errcode: 0, chatid: 'cid1', openConversationId: 'ocid1' };
};
dtn.sendGroupMessage = async () => ({ code: 0 });
dtn.classifyError = () => ({ hint: 'x', errcode: -1, errmsg: 'x', reason: 'x' });
dtn.classifyAddUserErrcode = () => ({ kind: 'success', action: null });
let addUserCalls = [];   // [#207] 捕获 addUserToChat（指派 / 加协作 / 改派后自动加群）
dtn.addUserToChat = async (_t, chatid, dings) => { addUserCalls.push({ chatid, dings: dings.slice() }); return { errcode: 0 }; };
dtn.escapeMarkdown = x => x;

const SECRET = 'verify-sys-chat-picker-secret';
const db = new sqlite3.Database(':memory:');
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, r) => e ? rej(e) : res(r)));
const all = (s, p = []) => new Promise((res, rej) => db.all(s, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};
const authenticateToken = (req, res, next) => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null; if (!t) return res.status(401).json({ error: 'x' }); try { req.user = jwt.verify(t, SECRET); next(); } catch { return res.status(401).json({ error: 'x' }); } };
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'x' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  COLLAB_CHAT_ADMIN_ID: 3,
  readSystemConfig: async () => 'cfg',                                   // 钉钉配置齐全
  callDingtalkWithTokenRetry: async (_k, _s, _t, fn) => fn('tok'),       // 直接执行回调（回调内调 mock dingtalkNotify）
  maskPhone: x => x,
});
const I = mod._internals;
function waitReady() { return new Promise((res, rej) => { let n = 0; const t = setInterval(() => { if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); } else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); } else if (++n > 500) { clearInterval(t); rej(new Error('timeout')); } }, 10); }); }

const adminTok = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', role: 'user' }, SECRET);
let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let passed = 0; const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 建 bug（admin 建=created_by 1）→ 指派 dev5 → 处理中；带报障人手机号
async function seedBug(reqPhone) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'b', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, requester_name: '赵报障', requester_phone: reqPhone });
  const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT, status TEXT DEFAULT 'active')`);
  // 3=示例用户A群主(有钉钉) 1=admin建单人(无手机) 5=dev开发(有钉钉) 7=示例发布者对接人(仅手机号) 8=王五(仅手机号) 9=无手机 10=viewer有手机 11=inactive有手机
  await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id, status) VALUES
    (1,'admin','管理员','admin',NULL,NULL,'active'),
    (3,'fengyun','示例用户A','admin','13300000000','ding3','active'),
    (5,'dev','开发王','user','13500000000','ding5','active'),
    (7,'shenjun','示例发布者','publisher','13700000000',NULL,'active'),
    (8,'wangwu','王五','user','13800000000',NULL,'active'),
    (9,'nophone','无手机','user',NULL,NULL,'active'),
    (10,'viewer','观察员','viewer','13100000000',NULL,'active'),
    (11,'inact','离职','user','13200000000',NULL,'disabled'),
    (12,'ndf','钉钉查无','user','${NOTFOUND_PHONE}',NULL,'active'),
    (13,'wangtaotao','示例对接人','user',NULL,NULL,'active')`);
    // ⚠️ 13 号（示例对接人/intake_liaison_id 唯一受理人）刻意不给手机号——resolveActiveSysIntakeLiaisons()
    //   只判 status='active'，不判 phone；给了手机号会被本组 [Cand] 候选枚举误收（本组测的是 chat-candidates
    //   候选池，与 intake_liaison_id 无关，不应因新增受理人夹具而改变其精确枚举断言 [7,8,12]）。
  const app = express(); app.use(express.json()); app.use('/api', mod.router);
  server = await listenOnSafePort(app);
  port = server.address().port;
  ok('readiness + HTTP harness（模块 mock dingtalk-notify）');

  // ═══ [Cand] chat-candidates ═══
  {
    const id = await seedBug('13900000000');   // 报障人有手机号
    const r = await call('GET', `/api/sys-issues/${id}/chat-candidates`, adminTok);
    assert.strictEqual(r.status, 200, '[Cand] 200');
    const candIds = r.body.candidates.map(c => c.id).sort((a, b) => a - b);
    // base={3,1,5}（群主/建单人 admin=1/开发 5；发起人 admin=1）→ 候选=有手机号非 viewer active 排 base = {7,8,12}
    //   （12 手机号格式合法故是候选；其钉钉反查失败是 create-chat 阶段的事，不影响候选筛选）
    assert.deepStrictEqual(candIds, [7, 8, 12], '[Cand] 候选=有手机号非viewer非base = [7,8,12]（排 9无手机/10viewer/11离职/base）got ' + candIds);
    assert.ok(r.body.candidates.every(c => c.phone === undefined), '[Cand] 不暴露手机号（仅 id+display_name）');
    const baseIds = r.body.base_members.map(b => b.id).sort((a, b) => a - b);
    // #207：建单人 admin=1（管理员 → 另拉示例用户A 3）+ 对接人 13 + 在册开发 5 + 发起人 admin=1（去重）
    assert.deepStrictEqual(baseIds, [1, 3, 5, 13], '[Cand] base_members = 建单人1+示例用户A3(管理员建单)+在册开发5+对接人13 got ' + baseIds);
    assert.strictEqual(r.body.requester.eligible, true, '[Cand] 报障人有手机号 → eligible');
    // 报障人无手机号 → eligible=false
    const id2 = await seedBug(null);
    const r2 = await call('GET', `/api/sys-issues/${id2}/chat-candidates`, adminTok);
    assert.strictEqual(r2.body.requester.eligible, false, '[Cand] 报障人无手机号 → eligible=false');
    ok('[Cand] chat-candidates：候选[7,8]排无手机/viewer/离职/base + base_members[1,3,5,13]（#207）+ 报障人 eligible + 不暴露手机号');
  }

  // ═══ [Cand-auth] 鉴权 ═══
  {
    const id = await seedBug('13900000000');
    // dev6 非 admin 非在册开发(该单在册=[5]) → 403
    const dev6 = jwt.sign({ id: 6, username: 'd6', role: 'user' }, SECRET);
    let r = await call('GET', `/api/sys-issues/${id}/chat-candidates`, dev6);
    assert.strictEqual(r.status, 403, '[Cand-auth] 非 admin/在册开发 → 403');
    // [#207] feature 单（待受理，未指派）→ 不再 409 CHAT_ONLY_FOR_BUG：candidates 200 + create-chat 200
    const rf = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'f', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const fRow = await get('SELECT status FROM sys_issues WHERE id = ?', [rf.body.id]);
    r = await call('GET', `/api/sys-issues/${rf.body.id}/chat-candidates`, adminTok);
    assert.strictEqual(r.status, 200, '[Cand-auth] #207 feature → candidates 200 got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${rf.body.id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [7] });
    assert.strictEqual(r.status, 200, `[Cand-auth] #207 feature（${fRow.status}）→ create-chat 200 got ` + JSON.stringify(r.body));
    ok(`[Cand-auth] 非 admin/在册开发 403 + #207 feature（${fRow.status}）可拉群`);
  }

  // ═══ [#207-Status] 状态门槛：已作废 / 已关闭 拒；已上线 / 已拒绝 放行 ═══
  {
    for (const [st, expect] of [['已作废', 409], ['已关闭', 409], ['已上线', 200], ['已拒绝', 200]]) {
      const id = await seedBug('13900000000');
      await run('UPDATE sys_issues SET status = ? WHERE id = ?', [st, id]);   // 夹具：直接落态（四态生产均可达）
      const r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [] });
      assert.strictEqual(r.status, expect, `[#207-Status] ${st} → ${expect} got ${r.status} ${JSON.stringify(r.body)}`);
      if (expect === 409) assert.strictEqual(r.body.code, 'CHAT_NOT_ALLOWED_IN_STATUS', `[#207-Status] ${st} code`);
    }
    // 已建群后归档 → 幂等返回原群（重新打开沿用原群）
    const id = await seedBug('13900000000');
    const r1 = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论' });
    assert.strictEqual(r1.status, 200, '[#207-Status] 先建群');
    await run(`UPDATE sys_issues SET status = '已关闭' WHERE id = ?`, [id]);
    const r2 = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, {});
    assert.strictEqual(r2.status, 200, '[#207-Status] 已归档但已建群 → 幂等 200');
    assert.strictEqual(r2.body.idempotent, true, '[#207-Status] idempotent=true');
    ok('[#207-Status] 已作废/已关闭 409 / 已上线·已拒绝 200 / 已建群后归档 → 幂等返回原群');
  }

  // ═══ [#207-Owner] 群主=建单人；管理员建单才拉示例用户A ═══
  {
    // 管理员 1 建单（无手机号→解析不到）→ 示例用户A 3 入群并接任群主
    const idA = await seedBug('13900000000');
    lastOwner = null; lastChatMembers = null;
    let r = await call('POST', `/api/sys-issues/${idA}/create-chat`, adminTok, { chat_desc: '讨论' });
    assert.strictEqual(r.status, 200, '[#207-Owner] 管理员建单 200 got ' + JSON.stringify(r.body));
    assert.ok(lastChatMembers.includes('ding3'), '[#207-Owner] 管理员建单 → 示例用户A入群');
    assert.strictEqual(lastOwner, 'ding3', '[#207-Owner] 管理员建单人无钉钉号 → 群主退到示例用户A got ' + lastOwner);
    assert.ok(r.body.owner_user_id === 3 && r.body.owner_is_fallback === true && r.body.owner_name === '示例用户A', '[#207-Owner] 响应写明实际群主=示例用户A（接任） got ' + JSON.stringify({ u: r.body.owner_user_id, f: r.body.owner_is_fallback, n: r.body.owner_name }));
    assert.ok(r.body.missing_required_member_ids.some(m => m.user_id === 13), '[#207-Owner] 对接人 13 在固定成员内（无手机号→记缺号）');
    // 普通用户 8（有手机号）建单 → 群主=8，示例用户A不入群
    //   本 harness 的建单端点挂的是 admin-only mock，故 admin 建单后改 created_by=8（生产普通用户建单是常态）
    const idU = await seedBug(null);
    await run('UPDATE sys_issues SET created_by = 8 WHERE id = ?', [idU]);
    r = await call('GET', `/api/sys-issues/${idU}/chat-candidates`, devTok);
    const bU = r.body.base_members.map(b => b.id).sort((a, b) => a - b);
    assert.deepStrictEqual(bU, [5, 8, 13], '[#207-Owner] 普通用户建单 base = 建单人8+在册开发5(发起人)+对接人13，无示例用户A got ' + bU);
    lastOwner = null; lastChatMembers = null;
    r = await call('POST', `/api/sys-issues/${idU}/create-chat`, devTok, { chat_desc: '讨论' });
    assert.strictEqual(r.status, 200, '[#207-Owner] 开发发起 200 got ' + JSON.stringify(r.body));
    assert.strictEqual(lastOwner, 'ding_13800000000', '[#207-Owner] 群主 = 建单人 8 got ' + lastOwner);
    assert.ok(!lastChatMembers.includes('ding3'), '[#207-Owner] 非管理员建单 → 示例用户A不入群 got ' + JSON.stringify(lastChatMembers));
    assert.ok(r.body.owner_user_id === 8 && r.body.owner_is_fallback === false, '[#207-Owner] 响应群主=建单人8、非接任');
    // 普通用户 9（无手机号）建单 → 建单人解析不到；发起人 5 有钉钉号也不接任 → 409 OWNER_NOT_RESOLVABLE，不调钉钉建群
    const idN = await seedBug(null);
    await run('UPDATE sys_issues SET created_by = 9 WHERE id = ?', [idN]);
    lastOwner = null; lastChatMembers = null;
    r = await call('POST', `/api/sys-issues/${idN}/create-chat`, devTok, { chat_desc: '讨论', member_user_ids: [7] });
    assert.strictEqual(r.status, 409, '[#207-Owner] 普通建单人缺号 → 409 got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'OWNER_NOT_RESOLVABLE', '[#207-Owner] code=OWNER_NOT_RESOLVABLE');
    assert.strictEqual(lastOwner, null, '[#207-Owner] 未调钉钉建群（发起人不接任群主）');
    const rowN = await get('SELECT dingtalk_open_conversation_id FROM sys_issues WHERE id = ?', [idN]);
    assert.strictEqual(rowN.dingtalk_open_conversation_id, null, '[#207-Owner] 未落群');
    ok('[#207-Owner] 群主=建单人 / 管理员建单才拉示例用户A（建单人解析不到时示例用户A接任，响应写明）/ 普通建单人缺号 409、发起人不接任 / 对接人在固定成员内');
  }

  // ═══ [#207-Roster] 协作开发（非代表）可发起 + 底座含全员在册开发 ═══
  {
    const id = await seedBug('13900000000');   // 在册 [5]
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(r.status, 200, '[#207-Roster] 加协作开发 8 got ' + JSON.stringify(r.body));
    const rep = await get('SELECT assigned_to FROM sys_issues WHERE id = ?', [id]);
    const collabId = Number(rep.assigned_to) === 8 ? 5 : 8;   // 取非代表的那位，证明不分主次
    const collabTok = jwt.sign({ id: collabId, username: 'c' + collabId, role: 'user' }, SECRET);
    r = await call('GET', `/api/sys-issues/${id}/chat-candidates`, collabTok);
    assert.strictEqual(r.status, 200, `[#207-Roster] 非代表在册开发 ${collabId} candidates 200 got ` + JSON.stringify(r.body));
    const baseIds = r.body.base_members.map(b => b.id).sort((a, b) => a - b);
    assert.ok(baseIds.includes(5) && baseIds.includes(8), '[#207-Roster] base_members 含在册开发 5、8 got ' + baseIds);
    lastChatMembers = null;
    r = await call('POST', `/api/sys-issues/${id}/create-chat`, collabTok, { chat_desc: '讨论' });
    assert.strictEqual(r.status, 200, '[#207-Roster] 非代表在册开发发起 create-chat 200 got ' + JSON.stringify(r.body));
    assert.ok(lastChatMembers.includes('ding5') && lastChatMembers.includes('ding_13800000000'), '[#207-Roster] 两位在册开发都进群 got ' + JSON.stringify(lastChatMembers));
    // 被移出名单后不再有发起权（不凭历史 assigned_to 残值放行）
    const id2 = await seedBug('13900000000');
    await call('POST', `/api/sys-issues/${id2}/dev-assignees`, adminTok, { user_ids: [8] });
    const row5 = await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = 5 AND removed_at IS NULL', [id2]);
    r = await call('DELETE', `/api/sys-issues/${id2}/dev-assignees/${row5.id}`, adminTok, { reason: '转岗' });
    assert.strictEqual(r.status, 200, '[#207-Roster] 移除 5 got ' + JSON.stringify(r.body));
    r = await call('GET', `/api/sys-issues/${id2}/chat-candidates`, devTok);
    assert.strictEqual(r.status, 403, '[#207-Roster] 已移出名单的 5 → 403');
    ok('[#207-Roster] 非代表在册开发可发起 + 底座含全员在册开发 + 移出名单即失发起权');
  }

  // ═══ [#207-AutoJoin] 先拉群、后指派 / 加协作 / 改派：新入册开发自动加群 ═══
  {
    const r0 = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'aj', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, requester_name: '赵报障', requester_phone: '13900000000' });
    const id = r0.body.id;
    await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    const st = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    let r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '先拉群', member_user_ids: [12, 7] });   // 未指派时底座只有群主可解析，需带一名选中成员成群
    assert.strictEqual(r.status, 200, `[#207-AutoJoin] 未指派（${st.status}）可先拉群 got ` + JSON.stringify(r.body));
    addUserCalls = [];
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '[#207-AutoJoin] 指派 200 got ' + JSON.stringify(r.body));
    assert.deepStrictEqual(addUserCalls.map(c => c.dings).flat(), ['ding5'], '[#207-AutoJoin] 首次指派 → 开发 5 加群 got ' + JSON.stringify(addUserCalls));
    addUserCalls = [];
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(r.status, 200, '[#207-AutoJoin] 加协作 200');
    assert.deepStrictEqual(addUserCalls.map(c => c.dings).flat(), ['ding_13800000000'], '[#207-AutoJoin] 新增协作 8 → 加群 got ' + JSON.stringify(addUserCalls));
    addUserCalls = [];
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(r.status, 200, '[#207-AutoJoin] 重复加 200 got ' + JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.skipped_user_ids) && r.body.skipped_user_ids.map(Number).includes(8), '[#207-AutoJoin] 重复加 → 8 记 skipped got ' + JSON.stringify(r.body));
    assert.deepStrictEqual(addUserCalls, [], '[#207-AutoJoin] 重复加已在册 → 不再触达钉钉');
    addUserCalls = [];
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5, 8, 7], reason: '补人' });
    assert.strictEqual(r.status, 200, '[#207-AutoJoin] 改派 200 got ' + JSON.stringify(r.body));
    assert.ok(addUserCalls.map(c => c.dings).flat().includes('ding_13700000000'), '[#207-AutoJoin] 改派新增 7 → 加群 got ' + JSON.stringify(addUserCalls));
    // 无群单：指派不触达钉钉
    const idNo = await seedBug('13900000000');
    addUserCalls = [];
    r = await call('POST', `/api/sys-issues/${idNo}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(r.status, 200, '[#207-AutoJoin] 无群单加协作 200 got ' + JSON.stringify(r.body));
    const inNo = await get('SELECT 1 AS x FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = 8 AND removed_at IS NULL', [idNo]);
    const chatNo = await get('SELECT dingtalk_open_conversation_id FROM sys_issues WHERE id = ?', [idNo]);
    assert.ok(inNo && chatNo.dingtalk_open_conversation_id === null, '[#207-AutoJoin] 无群单：8 已入册且单据仍无群');
    assert.deepStrictEqual(addUserCalls, [], '[#207-AutoJoin] 无群单加协作 → 不触达钉钉');
    ok('[#207-AutoJoin] 先拉群后指派 / 加协作 / 改派新增 → 自动加群；重复加与无群单不触达钉钉');
  }

  // ═══ [#207-Interleave] 建群进行中（钉钉建群未返回）完成指派 → 群落库后追补加群（codex 600 MED-1 / 600-R MED）═══
  {
    // 建群请求停在钉钉建群这一步时执行 during()；入口没等到（夹具失败 / 建群提前返回）或超时都判红，finally 放行，不留阻塞
    async function interleave(id, body, during) {
      let release;
      chatGate = new Promise(res => { release = res; });
      const entered = new Promise(res => { chatEntered = res; });
      const pChat = call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, body);
      let timer;
      try {
        const first = await Promise.race([
          entered.then(() => 'entered'),
          pChat.then(r => ({ early: r })),
          new Promise(res => { timer = setTimeout(() => res('timeout'), 10000); }),
        ]);
        assert.strictEqual(first, 'entered', '[#207-Interleave] 建群请求应停在钉钉建群一步 got ' + JSON.stringify(first));
        await during();
      } catch (e) {
        // [codex 600-R2 L] 失败路径：先放行，再等在途建群请求收尾（限 10 秒），保留原始断言错误往外抛
        try { clearTimeout(timer); release(); await Promise.race([pChat.catch(() => {}), new Promise(res => setTimeout(res, 10000))]); } catch (_) { /* 收尾失败不覆盖原始错误 */ }
        throw e;
      } finally {
        clearTimeout(timer); release(); chatGate = null; chatEntered = null;
      }
      return pChat;
    }
    async function seedAccepted(title) {
      const r0 = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      assert.ok((r0.status === 200 || r0.status === 201) && r0.body && r0.body.id > 0, '[#207-Interleave] 夹具建单 got ' + JSON.stringify(r0.body));
      const ra = await call('POST', `/api/sys-issues/${r0.body.id}/intake-accept`, adminTok, {});
      assert.strictEqual(ra.status, 200, '[#207-Interleave] 夹具受理 got ' + JSON.stringify(ra.body));
      return r0.body.id;
    }
    // ① 建群期间首次指派开发 5
    const id = await seedAccepted('il');
    const rc = await interleave(id, { chat_desc: '交错', member_user_ids: [12, 7] }, async () => {
      addUserCalls = [];
      const ra = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(ra.status, 200, '[#207-Interleave] 建群期间指派 200 got ' + JSON.stringify(ra.body));
      assert.deepStrictEqual(addUserCalls, [], '[#207-Interleave] 群未落库 → 指派侧加群跳过');
      assert.ok(!lastChatMembers.includes('ding5'), '[#207-Interleave] 夹具前提：成员快照里没有开发 5 got ' + JSON.stringify(lastChatMembers));
    });
    assert.strictEqual(rc.status, 200, '[#207-Interleave] 建群 200 got ' + JSON.stringify(rc.body));
    assert.deepStrictEqual(addUserCalls.map(c => c.dings).flat(), ['ding5'], '[#207-Interleave] 群落库后追补开发 5 加群 got ' + JSON.stringify(addUserCalls));
    // ② 选中成员 14 当时反查失败（记 skipped）、建群期间被指派入册 → 追补按「实际进群」求差集，14 仍被补（反查已恢复）
    await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id, status) VALUES (14,'flaky','反查抖动','user','${FLAKY_PHONE}',NULL,'active')`);
    const id2 = await seedAccepted('il2');
    flakyFails = 1;
    const rc2 = await interleave(id2, { chat_desc: '交错2', member_user_ids: [7, 14] }, async () => {
      addUserCalls = [];
      const ra = await call('POST', `/api/sys-issues/${id2}/assign`, adminTok, { assigned_to: 14 });
      assert.strictEqual(ra.status, 200, '[#207-Interleave] 建群期间指派 14 → 200 got ' + JSON.stringify(ra.body));
      assert.deepStrictEqual(addUserCalls, [], '[#207-Interleave] 群未落库 → 指派侧加群跳过（14）');
      assert.ok(!lastChatMembers.includes('ding_' + FLAKY_PHONE), '[#207-Interleave] 夹具前提：成员快照里没有 14 got ' + JSON.stringify(lastChatMembers));
    });
    assert.strictEqual(rc2.status, 200, '[#207-Interleave] 建群2 200 got ' + JSON.stringify(rc2.body));
    assert.ok(rc2.body.selected_skipped.some(s => s.user_id === 14), '[#207-Interleave] 夹具前提：14 选中时反查失败记 skipped got ' + JSON.stringify(rc2.body.selected_skipped));
    assert.deepStrictEqual(addUserCalls.map(c => c.dings).flat(), ['ding_' + FLAKY_PHONE], '[#207-Interleave] 选中但未进群、建群期间入册的 14 被追补 got ' + JSON.stringify(addUserCalls));
    ok('[#207-Interleave] 建群与指派交错：指派侧因无群跳过，建群侧落库后按「实际进群」求差集追补（含选中时反查失败的人），开发不漏');
  }

  // ═══ [Sel] 选中成员进群 ═══
  {
    const id = await seedBug('13900000000');
    lastChatMembers = null;
    const r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [7, 8], include_requester: false });
    assert.strictEqual(r.status, 200, '[Sel] create-chat 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.selected_added, 2, '[Sel] selected_added=2（7,8 均有手机号 mock 反查成功）');
    // createChatGroup 收到成员钉钉：底座 ding3/ding5 + 选中 ding_137../ding_138..（admin id=1 无手机→missing 不进）
    assert.ok(lastChatMembers.includes('ding_13700000000') && lastChatMembers.includes('ding_13800000000'), '[Sel] 选中成员钉钉进群 got ' + JSON.stringify(lastChatMembers));
    assert.ok(lastChatMembers.includes('ding3') && lastChatMembers.includes('ding5'), '[Sel] 底座示例用户A/开发钉钉在群');
    ok('[Sel] create-chat member_user_ids=[7,8] → 选中成员钉钉进群 + selected_added=2');
  }

  // ═══ [Skip] 无效/无手机号/viewer/离职 选中 → skipped ═══
  {
    const id = await seedBug('13900000000');
    const r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [9, 10, 11, 999], include_requester: false });
    assert.strictEqual(r.status, 200, '[Skip] 200');
    assert.strictEqual(r.body.selected_added, 0, '[Skip] 无有效选中 → selected_added=0');
    assert.strictEqual(r.body.selected_skipped.length, 4, '[Skip] 9无手机/10viewer/11离职/999不存在 全 skipped got ' + JSON.stringify(r.body.selected_skipped));
    ok('[Skip] 选中 无手机号(9)/viewer(10)/离职(11)/不存在(999) → 全 selectedSkipped 不阻断建群');
  }

  // ═══ [Req] 报障人 opt-in ═══
  {
    // include_requester=false → 报障人不加
    const id = await seedBug('13900000000');
    let r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [], include_requester: false });
    assert.strictEqual(r.body.requester_included, false, '[Req] 未勾选 → requester_included=false');
    assert.strictEqual(r.body.requester_skip_reason, 'not_selected', '[Req] reason=not_selected');
    // include_requester=true + 有手机号 → 加入
    const id2 = await seedBug('13900000001');
    lastChatMembers = null;
    r = await call('POST', `/api/sys-issues/${id2}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [], include_requester: true });
    assert.strictEqual(r.body.requester_included, true, '[Req] 勾选+有手机号 → requester_included=true');
    assert.ok(lastChatMembers.includes('ding_13900000001'), '[Req] 报障人钉钉进群');
    ok('[Req] 报障人 opt-in：未勾选=not_selected 不加 / 勾选+有手机号 → 进群');
  }

  // ═══ [Fail] codex32 M-2：合法手机号但钉钉反查失败降级（no_ding / not_found / lookup_failed）═══
  {
    // 选中候选 12（合法手机号但反查返 null）→ selected_skipped reason=no_ding（非无手机号，是有号但查无钉钉）
    const id = await seedBug('13900000000');
    let r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [12], include_requester: false });
    assert.strictEqual(r.body.selected_added, 0, '[Fail] 反查 null 的选中 → 不加');
    assert.ok(r.body.selected_skipped.some(s => s.user_id === 12 && s.reason === 'no_ding'), '[Fail] selected_skipped reason=no_ding（合法手机号但钉钉查无）got ' + JSON.stringify(r.body.selected_skipped));
    // 报障人手机号反查返 null → requester_skip_reason=not_found
    const id2 = await seedBug(NOTFOUND_PHONE);
    r = await call('POST', `/api/sys-issues/${id2}/create-chat`, adminTok, { chat_desc: '讨论', include_requester: true });
    assert.strictEqual(r.body.requester_included, false, '[Fail] 反查 null 报障人 → 不加');
    assert.strictEqual(r.body.requester_skip_reason, 'not_found', '[Fail] requester not_found');
    // 报障人手机号反查抛异常 → lookup_failed（降级不阻断建群）
    const id3 = await seedBug(THROW_PHONE);
    r = await call('POST', `/api/sys-issues/${id3}/create-chat`, adminTok, { chat_desc: '讨论', include_requester: true });
    assert.strictEqual(r.status, 200, '[Fail] 报障人反查抛异常仍建群成功（降级）');
    assert.strictEqual(r.body.requester_skip_reason, 'lookup_failed', '[Fail] requester lookup_failed');
    ok('[Fail] 钉钉反查失败降级：选中 no_ding / 报障人 not_found / lookup_failed（真实生产降级面，不阻断建群）');
  }

  // ═══ [Assignee] codex32 L-1：被指派开发作为发起人正向 ═══
  {
    const id = await seedBug('13900000000');   // assigned to dev5
    let r = await call('GET', `/api/sys-issues/${id}/chat-candidates`, devTok);
    assert.strictEqual(r.status, 200, '[Assignee] assignee 拉 candidates 200');
    lastChatMembers = null;
    r = await call('POST', `/api/sys-issues/${id}/create-chat`, devTok, { chat_desc: '讨论', member_user_ids: [7], include_requester: false });
    assert.strictEqual(r.status, 200, '[Assignee] assignee 发起 create-chat 200');
    assert.ok(lastChatMembers.includes('ding5') && lastChatMembers.includes('ding_13700000000'), '[Assignee] 发起人(开发5)+选中(7)在群');
    ok('[Assignee] 被指派开发作为发起人：chat-candidates + create-chat 正向成功（前端 async 集成由部署前 Playwright 兜）');
  }

  // ═══ [Cap] >30 → 400 ═══
  {
    const id = await seedBug('13900000000');
    const many = Array.from({ length: 31 }, (_, i) => i + 100);
    const r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: many });
    assert.strictEqual(r.status, 400, '[Cap] >30 → 400');
    assert.strictEqual(r.body.code, 'TOO_MANY_MEMBERS', '[Cap] TOO_MANY_MEMBERS');
    ok('[Cap] member_user_ids >30 → 400 TOO_MANY_MEMBERS');
  }

  // ═══ [Dedup] 选中与底座同人 → 不重复 ═══
  {
    const id = await seedBug('13900000000');
    lastChatMembers = null;
    // 选中含开发 5（已在底座）→ 去重不重复；含 7 新增
    const r = await call('POST', `/api/sys-issues/${id}/create-chat`, adminTok, { chat_desc: '讨论', member_user_ids: [5, 7], include_requester: false });
    assert.strictEqual(r.status, 200, '[Dedup] 200');
    const ding5count = lastChatMembers.filter(d => d === 'ding5').length;
    assert.strictEqual(ding5count, 1, '[Dedup] 底座开发5 钉钉只出现一次（选中含5被 baseIdSet 排除/dedup）');
    // 5 被 baseIdSet.has 排除（parse 阶段），故 selected_added 只算 7
    assert.strictEqual(r.body.selected_added, 1, '[Dedup] selected_added=1（仅7，5 已在底座被排）');
    ok('[Dedup] 选中含底座成员(5) → 去重不重复计，selected_added 仅算新增(7)');
  }

  server.close();
  console.log(`\n✅ verify-sys-chat-picker 全部通过：${passed} 组断言`);
}
main().catch(e => { console.error('❌ verify-sys-chat-picker 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
