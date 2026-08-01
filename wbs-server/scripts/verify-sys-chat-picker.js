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
dtn.getUserIdByMobile = async (_t, phone) => {   // 手机号→唯一钉钉号；含失败分支（codex32 M-2 降级覆盖）
  if (phone === NOTFOUND_PHONE) return null;
  if (phone === THROW_PHONE) throw new Error('lookup boom');
  return 'ding_' + phone;
};
dtn.createChatGroup = async (_t, _name, owner, members) => { lastOwner = owner; lastChatMembers = members.slice(); return { errcode: 0, chatid: 'cid1', openConversationId: 'ocid1' }; };
dtn.sendGroupMessage = async () => ({ code: 0 });
dtn.classifyError = () => ({ hint: 'x', errcode: -1, errmsg: 'x', reason: 'x' });
dtn.classifyAddUserErrcode = () => ({ kind: 'success', action: null });
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
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
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
    const baseIds = r.body.base_members.map(b => b.id).sort();
    assert.deepStrictEqual(baseIds, [1, 3, 5], '[Cand] base_members = 群主3+建单人1+开发5（发起人 admin=1 去重）got ' + baseIds);
    assert.strictEqual(r.body.requester.eligible, true, '[Cand] 报障人有手机号 → eligible');
    // 报障人无手机号 → eligible=false
    const id2 = await seedBug(null);
    const r2 = await call('GET', `/api/sys-issues/${id2}/chat-candidates`, adminTok);
    assert.strictEqual(r2.body.requester.eligible, false, '[Cand] 报障人无手机号 → eligible=false');
    ok('[Cand] chat-candidates：候选[7,8]排无手机/viewer/离职/base + base_members[1,3,5] + 报障人 eligible + 不暴露手机号');
  }

  // ═══ [Cand-auth] 鉴权 ═══
  {
    const id = await seedBug('13900000000');
    // dev6 非 admin 非 assignee(该单 assigned=5) → 403
    const dev6 = jwt.sign({ id: 6, username: 'd6', role: 'user' }, SECRET);
    let r = await call('GET', `/api/sys-issues/${id}/chat-candidates`, dev6);
    assert.strictEqual(r.status, 403, '[Cand-auth] 非 admin/assignee → 403');
    // feature 单 → 409 CHAT_ONLY_FOR_BUG
    const rf = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'f', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    await call('POST', `/api/sys-issues/${rf.body.id}/schedule`, adminTok, {});
    await call('POST', `/api/sys-issues/${rf.body.id}/assign`, adminTok, { assigned_to: 5 });
    r = await call('GET', `/api/sys-issues/${rf.body.id}/chat-candidates`, adminTok);
    assert.strictEqual(r.status, 409, '[Cand-auth] feature → 409');
    assert.strictEqual(r.body.code, 'CHAT_ONLY_FOR_BUG', '[Cand-auth] CHAT_ONLY_FOR_BUG');
    ok('[Cand-auth] 非 admin/assignee 403 + 非 bug 409');
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
