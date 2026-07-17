// 验证脚本：系统迭代 C5 钉钉通知派发（事务提交后 best-effort 发送 + 三侧物理隔离落库，§8）
//   用法：node scripts/verify-sys-notify.js
//
// in-process express app（挂真实 router）+ 内存库 + 自签 token + 可控 mock 发送闭包，覆盖（方案 §8.1/§8.2 + 用户 0630 拍板）：
//   1. dev 侧发：指派/改派/重开（notifyAssignedDeveloper 指派模板）+ 验收打回（notifyReturnedToDeveloper 打回模板）
//   2. requester 侧发：回填预计完成（仅需求方侧，creator 侧保持 not_sent，M-4）+ 已上线（批次逐单）
//   3. 本期不发（admin 自身）：转待验证(submit) / 受阻(blocked) → 无发送
//   4. 三侧物理隔离（dev 只动 notify_* / requester 只动 requester_notify_*，互不覆盖）
//   5. 失败必落库（*_notify_status='failed' + 短枚举 error）+ best-effort 绝不抛（mock throw 不崩端点）
//   6. read_at 每次新发送重置 + 深链 baseUrl 开关 + markdown 转义（issueSafeText 复用 escapeMarkdown）
//   7. 直接调 dispatchSysNotify 覆盖 no_assignee / dev_not_found / 未知 marker 分支
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-notify-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

// ── 可控 mock 发送闭包（覆盖 _sys-attach-test-deps stub）──────────
//   behavior: 'ok'（返 message_key）/ 'fail'（返 ok:false + reason）/ 'throw'（抛异常，验 best-effort）。
let devBehavior = 'ok', reqBehavior = 'ok', baseUrlVal = '';
let devSeq = 0, reqSeq = 0;
const sentLog = [];   // { kind:'dev'|'req', to/phone, title, md }
async function mockDevSend(targetUser, title, md) {
  sentLog.push({ kind: 'dev', to: targetUser && targetUser.id, title, md });
  if (devBehavior === 'throw') throw new Error('boom-dev');
  if (devBehavior === 'fail') return { ok: false, reason: 'requester_invalid' };
  return { ok: true, message_key: 'mk-dev-' + (++devSeq) };
}
async function mockReqSend(phone, title, md) {
  sentLog.push({ kind: 'req', phone, title, md });
  if (reqBehavior === 'throw') throw new Error('boom-req');
  if (reqBehavior === 'fail') return { ok: false, reason: 'requester_invalid' };
  return { ok: true, message_key: 'mk-req-' + (++reqSeq) };
}
async function mockBaseUrl() { return baseUrlVal; }

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),                 // 附件 4 项 stub（过工厂校验）
  sendIssueDingtalkRaw: mockDevSend,                     // 覆盖 stub：可控 dev/creator 发送
  sendIssueDingtalkToRequester: mockReqSend,             // 覆盖 stub：可控需求方发送
  getSafePlatformBaseUrl: mockBaseUrl,                   // 覆盖 stub：可控深链 baseUrl
});
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const notifyRow = (id) => get(`SELECT notify_status, notify_message_key, notify_error, read_at,
  requester_notify_status, requester_notify_message_key, requester_notify_error, requester_read_at,
  creator_notify_status, creator_notified_at FROM sys_issues WHERE id=?`, [id]);
// 批次发布通知改为响应后后台派发（#4），需轮询等落库（单动作端点仍同步 await，无需 settle）。
async function settleReq(id, expect) {
  for (let i = 0; i < 400; i++) {
    if ((await notifyRow(id)).requester_notify_status === expect) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`settleReq 超时：#${id} requester_notify_status 未达 ${expect}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 建单（可带 requester_phone）→ 排期 → 指派 dev(5)。返回 id（指派后 dev 侧已派发）。
async function seedAssigned(extra = {}) {
  const body = { type: 'feature', title: extra.title || 't', system_name: 'BMS', source: '内部' };
  if (extra.requester_phone) body.requester_phone = extra.requester_phone;
  if (extra.requester_name) body.requester_name = extra.requester_name;
  let r = await call('POST', '/api/sys-issues', adminTok, body);
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  return id;
}
async function seedToVerify(extra = {}) {
  const id = await seedAssigned(extra);
  let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + JSON.stringify(r.body));
  // C3：submit 唯一写入口改多开发 commit 事件模型（方案 §6.1），旧 {summary} 单人摘要体已随之退场；
  //   本文件测的是 notify 派发，用 no_code 模式最省事（无需构造合法 commit_ref）。
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付完成（notify 测试占位理由）' });
  assert.strictEqual(r.status, 200, 'submit 200, got ' + JSON.stringify(r.body));
  return id;
}
async function seedToReady(extra = {}) {
  const id = await seedToVerify(extra);
  const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'accept 200, got ' + JSON.stringify(r.body));
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),(6,'dev2','开发李','user','13800000006')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });

  // ── A. 指派 → dev 侧 sent + 三侧隔离 + sentLog 指派模板 ──────────
  devBehavior = 'ok'; reqBehavior = 'ok'; baseUrlVal = '';
  let before = sentLog.length;
  let id = await seedAssigned();
  let row = await notifyRow(id);
  assert.strictEqual(row.notify_status, 'sent', 'A: dev notify_status=sent');
  assert.ok(/^mk-dev-/.test(row.notify_message_key), 'A: dev message_key 落库');
  assert.strictEqual(row.notify_error, null, 'A: dev error null');
  assert.strictEqual(row.requester_notify_status, 'not_sent', 'A: requester 侧未动（隔离）');
  assert.strictEqual(row.creator_notify_status, 'not_sent', 'A: creator 侧未动（隔离）');
  const aSent = sentLog.slice(before).filter(s => s.kind === 'dev');
  assert.strictEqual(aSent.length, 1, 'A: 恰一条 dev 发送');
  assert.ok(/指派/.test(aSent[0].title), 'A: 指派模板标题');
  ok('指派 → dev 侧 sent + requester/creator 侧未动（三侧隔离）+ 指派模板');

  // ── B. 指派发送失败 → dev failed + error 落库 + 动作仍 200 ──────────
  devBehavior = 'fail';
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  const idB = r.body.id;
  await call('POST', `/api/sys-issues/${idB}/schedule`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${idB}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, 'B: 指派动作仍 200（通知失败不影响）');
  row = await notifyRow(idB);
  assert.strictEqual(row.notify_status, 'failed', 'B: dev notify_status=failed');
  assert.strictEqual(row.notify_error, 'requester_invalid', 'B: dev error=短枚举 reason');
  assert.strictEqual(row.notify_message_key, null, 'B: failed 不落 message_key');
  ok('指派发送失败 → dev failed + error 落库 + 动作仍 200');

  // ── C. 发送抛异常 → best-effort 不崩端点 + notify_status 保持 not_sent ──────────
  devBehavior = 'throw';
  r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  const idC = r.body.id;
  await call('POST', `/api/sys-issues/${idC}/schedule`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${idC}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, 'C: 发送抛异常端点仍 200（best-effort 绝不抛）');
  row = await notifyRow(idC);
  assert.strictEqual(row.notify_status, 'not_sent', 'C: 抛异常在落库前 → 保持 not_sent（吞掉）');
  ok('发送抛异常 → best-effort 不崩端点（200）+ notify_status not_sent');

  // ── D. 回填预计完成 → 仅需求方侧 sent + creator 保持 not_sent + dev 侧不被覆盖 ──────────
  devBehavior = 'ok'; reqBehavior = 'ok';
  before = sentLog.length;
  id = await seedAssigned({ requester_phone: '13900000009' });   // 指派后 dev=sent
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'D: estimate 200');
  row = await notifyRow(id);
  assert.strictEqual(row.requester_notify_status, 'sent', 'D: requester 侧 sent');
  assert.ok(/^mk-req-/.test(row.requester_notify_message_key), 'D: requester message_key 落库');
  assert.strictEqual(row.creator_notify_status, 'not_sent', 'D: creator 侧保持 not_sent（M-4 本期不发）');
  assert.strictEqual(row.notify_status, 'sent', 'D: dev 侧仍是指派时的 sent（estimate 不覆盖 dev 侧）');
  const dSent = sentLog.slice(before).filter(s => s.kind === 'req');
  assert.strictEqual(dSent.length, 1, 'D: 恰一条 requester 发送');
  assert.ok(/预计完成/.test(dSent[0].title), 'D: estimate 模板标题');
  ok('回填预计 → 仅需求方侧 sent + creator not_sent(M-4) + dev 侧不被覆盖（三侧独立）');

  // ── E. 回填预计·无需求方（内部单 requester 三字段皆空）→ requester 保持 not_sent（#2：非 failed）──────────
  before = sentLog.length;
  id = await seedAssigned();   // 内部单无任何 requester 信息
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'E: estimate 200');
  row = await notifyRow(id);
  assert.strictEqual(row.requester_notify_status, 'not_sent', 'E: 无需求方 → requester 保持 not_sent（不误标 failed）');
  assert.strictEqual(row.requester_notify_error, null, 'E: 无需求方 → 无 error');
  assert.strictEqual(sentLog.slice(before).filter(s => s.kind === 'req').length, 0, 'E: 无需求方不调发送');
  ok('回填预计·无需求方（内部单）→ requester 保持 not_sent（不误标 failed，#2）');

  // ── E2. 有需求方(填了 requester_name)但无手机号 → requester failed='requester_phone_empty'（真失败该落 failed）──────────
  before = sentLog.length;
  id = await seedAssigned({ requester_name: '王业务' });   // 有姓名无手机号
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'E2: estimate 200');
  row = await notifyRow(id);
  assert.strictEqual(row.requester_notify_status, 'failed', 'E2: 有需求方缺手机号 → failed');
  assert.strictEqual(row.requester_notify_error, 'requester_phone_empty', 'E2: error=requester_phone_empty');
  assert.strictEqual(sentLog.slice(before).filter(s => s.kind === 'req').length, 0, 'E2: 缺手机号不调发送');
  ok('回填预计·有需求方缺手机号 → requester failed（区分『无需求方』与『缺手机号』）');

  // ── Fe. 可行性评估路径补发需求方（#1）：可行/有条件可行发，不可行不发 ──────────
  r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'fe', system_name: 'BMS', source: '业务方', requester_phone: '13922220001', needs_feasibility: 1 });
  const idFe = r.body.id;
  await call('POST', `/api/sys-issues/${idFe}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${idFe}/assign`, adminTok, { assigned_to: 5 });
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${idFe}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: '2026-08-05 10:00' });
  assert.strictEqual(r.status, 200, 'Fe: feasibility 可行 200, got ' + JSON.stringify(r.body));
  row = await notifyRow(idFe);
  assert.strictEqual(row.requester_notify_status, 'sent', 'Fe: 可行 → 需求方 sent');
  assert.strictEqual(row.creator_notify_status, 'not_sent', 'Fe: creator 侧 not_sent');
  assert.strictEqual(sentLog.slice(before).filter(s => s.kind === 'req' && /预计完成/.test(s.title)).length, 1, 'Fe: 发预计完成模板');
  ok('可行性评估·可行 → 需求方 sent（#1：需评估单也能收到 ETA 通知）');
  r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'fe2', system_name: 'BMS', source: '业务方', requester_phone: '13922220002', needs_feasibility: 1 });
  const idFe2 = r.body.id;
  await call('POST', `/api/sys-issues/${idFe2}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${idFe2}/assign`, adminTok, { assigned_to: 5 });
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${idFe2}/feasibility`, devTok, { conclusion: '不可行', requirement_confirm: '理解了', risk: '技术不可行', dev_estimated_at: '2026-08-05 10:00' });
  assert.strictEqual(r.status, 200, 'Fe2: feasibility 不可行 200');
  assert.strictEqual((await notifyRow(idFe2)).requester_notify_status, 'not_sent', 'Fe2: 不可行 → 需求方不发');
  assert.strictEqual(sentLog.slice(before).filter(s => s.kind === 'req').length, 0, 'Fe2: 不可行无 req 发送');
  ok('可行性评估·不可行 → 需求方不发（工作不推进）');

  // ── Eu. estimate 同分钟 unchanged 零写入（#6，§7 M-3）：同值再回填不重复推送需求方 ──────────
  id = await seedAssigned({ requester_phone: '13933330001' });
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'Eu: 首次 estimate 200');
  assert.strictEqual((await notifyRow(id)).requester_notify_status, 'sent', 'Eu: 首次 → 需求方 sent');
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });   // 同值再回填
  assert.strictEqual(r.status, 200, 'Eu: 同值 estimate 200');
  assert.strictEqual(r.body.unchanged, true, 'Eu: 同值返回 unchanged:true');
  assert.strictEqual(sentLog.slice(before).filter(s => s.kind === 'req').length, 0, 'Eu: unchanged 不重复推送需求方');
  ok('estimate 同分钟 unchanged 零写入 → 不重复推送需求方（#6）');

  // ── Re. reassign 派发新开发（#7：独立派发路径，verify 此前漏测）──────────
  //   ⚠️ 既有测试变更（C2：reassign body 改 member_ids+reason，见交付汇报清单）。
  id = await seedAssigned();   // 指派 dev5（dev 侧 sent）
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '换人' });
  assert.strictEqual(r.status, 200, 'Re: reassign 200, got ' + JSON.stringify(r.body));
  row = await notifyRow(id);
  assert.strictEqual(row.notify_status, 'sent', 'Re: reassign → dev 侧重新 sent');
  const reSent = sentLog.slice(before).filter(s => s.kind === 'dev');
  assert.ok(reSent.length === 1 && reSent[0].to === 6, 'Re: 发给新开发 dev6');
  assert.ok(/指派/.test(reSent[0].title), 'Re: 复用指派模板');
  assert.strictEqual(row.requester_notify_status, 'not_sent', 'Re: requester 侧未被触碰（三侧隔离）');
  ok('reassign → 发新开发 dev6（指派模板）+ 三侧隔离（#7 补测）');

  // ── F. 转待验证(submit) → admin 自身不发（无新发送） ──────────
  id = await seedAssigned();
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付完成（notify 测试占位理由）' });
  assert.strictEqual(r.status, 200, 'F: submit 200');
  assert.strictEqual(sentLog.length, before, 'F: submit 不触发任何发送（admin 自身按需精简）');
  ok('转待验证(submit) → 无发送（admin 自身，§8.1）');

  // ── G. 验收打回 → dev 侧 sent（打回发，用户拍板）+ 打回模板 + read_at 重置 ──────────
  id = await seedToVerify();   // 待验证（dev 侧此前 sent）
  await run('UPDATE sys_issues SET read_at = ? WHERE id = ?', ['2026-07-01 09:00', id]);   // 模拟已读
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '验收不通过，需返工' });
  assert.strictEqual(r.status, 200, 'G: return 200');
  row = await notifyRow(id);
  assert.strictEqual(row.notify_status, 'sent', 'G: dev 侧 sent（打回发）');
  assert.strictEqual(row.read_at, null, 'G: 新发送重置 read_at=NULL');
  const gSent = sentLog.slice(before).filter(s => s.kind === 'dev');
  assert.strictEqual(gSent.length, 1, 'G: 恰一条 dev 发送');
  assert.ok(/打回|返工/.test(gSent[0].title), 'G: 打回模板标题');
  ok('验收打回 → dev 侧 sent（打回模板）+ read_at 重置（用户拍板：打回发）');

  // ── H. 受阻(blocked) → admin 自身不发（无发送 + 三侧不变） ──────────
  r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'tb', system_name: 'BMS', source: '内部', needs_feasibility: 1 });
  const idH = r.body.id;
  await call('POST', `/api/sys-issues/${idH}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${idH}/assign`, adminTok, { assigned_to: 5 });
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${idH}/blocked`, devTok, { reason: '依赖外部接口未就绪，受阻' });
  assert.strictEqual(r.status, 200, 'H: blocked 200');
  assert.strictEqual(sentLog.length, before, 'H: blocked 不触发任何发送（admin 自身，用户拍板不发）');
  ok('受阻(blocked) → 无发送（admin 自身，用户拍板）');

  // ── I. 重开 → dev 侧 sent（指派模板） ──────────
  id = await seedToReady();   // 待上线
  // 直接 hotfix-publish 推到已上线再 reopen
  r = await call('POST', `/api/sys-issues/${id}/hotfix-publish`, adminTok, { release_note: '上线', version_tag: 'v1' });
  assert.strictEqual(r.status, 201, 'I: hotfix-publish 201');
  before = sentLog.length;
  r = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '上线后发现问题，重开返工' });
  assert.strictEqual(r.status, 200, 'I: reopen 200');
  row = await notifyRow(id);
  assert.strictEqual(row.notify_status, 'sent', 'I: reopen → dev 侧 sent');
  const iSent = sentLog.slice(before).filter(s => s.kind === 'dev');
  assert.ok(iSent.length === 1 && /指派/.test(iSent[0].title), 'I: 重开复用指派模板');
  ok('重开 → dev 侧 sent（指派模板）');

  // ── J. 批次发布 → 批次内逐单发需求方·已上线（含版本号） ──────────
  devBehavior = 'ok'; reqBehavior = 'ok';
  const j1 = await seedToReady({ requester_phone: '13911110001' });
  const j2 = await seedToReady({ requester_phone: '13911110002' });
  r = await call('POST', '/api/sys-releases', adminTok, { title: '通知批次' });
  const relJ = r.body.id;
  await call('POST', `/api/sys-releases/${relJ}/add-issues`, adminTok, { issue_ids: [j1, j2] });
  // seed 期 estimate 已给两单发过需求方通知（sent），清回 not_sent 让 settle 检测的是 release 派发而非残留态
  await run("UPDATE sys_issues SET requester_notify_status='not_sent', requester_notify_message_key=NULL WHERE id IN (?,?)", [j1, j2]);
  before = sentLog.length;
  r = await call('POST', `/api/sys-releases/${relJ}/publish`, adminTok, { release_note: '6月发布', version_tag: 'v2.0' });
  assert.strictEqual(r.status, 200, 'J: publish 200');
  await settleReq(j1, 'sent'); await settleReq(j2, 'sent');   // #4：批次通知改后台派发，等落库
  const j1Row = await notifyRow(j1), j2Row = await notifyRow(j2);
  assert.strictEqual(j1Row.requester_notify_status, 'sent', 'J: j1 requester sent');
  assert.strictEqual(j2Row.requester_notify_status, 'sent', 'J: j2 requester sent');
  // codex 审 L-2：补 message_key 为新发值 + sentLog phone 集合匹配批次单据（防仅靠状态位假绿）
  assert.ok(/^mk-req-/.test(j1Row.requester_notify_message_key), 'J: j1 message_key 为本次新发值');
  assert.ok(/^mk-req-/.test(j2Row.requester_notify_message_key), 'J: j2 message_key 为本次新发值');
  const jSent = sentLog.slice(before).filter(s => s.kind === 'req');
  assert.strictEqual(jSent.length, 2, 'J: 批次逐单 2 条 requester 发送');
  const jPhones = new Set(jSent.map(s => s.phone));
  assert.ok(jPhones.size === 2 && jPhones.has('13911110001') && jPhones.has('13911110002'), 'J: sentLog phone 集合精确匹配批次两单');
  assert.ok(jSent.every(s => /已上线/.test(s.title)), 'J: 已上线模板标题');
  assert.ok(jSent.some(s => /v2\.0/.test(s.md)), 'J: 已上线 markdown 含版本号');
  ok('批次发布 → 后台逐单发需求方·已上线（含版本号 + message_key 新值 + phone 集合匹配，#4/L-2）');

  // ── K. 批次内一单需求方缺手机号 → 该单 failed，其他单 sent（逐单 best-effort 隔离，后台派发） ──────────
  const k1 = await seedToReady({ requester_phone: '13911110003' });
  const k2 = await seedToReady({ requester_name: '李业务' });   // 有需求方缺手机号 → failed（可轮询信号）
  r = await call('POST', '/api/sys-releases', adminTok, { title: '混合批次' });
  const relK = r.body.id;
  await call('POST', `/api/sys-releases/${relK}/add-issues`, adminTok, { issue_ids: [k1, k2] });
  await run("UPDATE sys_issues SET requester_notify_status='not_sent', requester_notify_message_key=NULL, requester_notify_error=NULL WHERE id IN (?,?)", [k1, k2]);
  r = await call('POST', `/api/sys-releases/${relK}/publish`, adminTok, { release_note: 'x', version_tag: 'v3' });
  assert.strictEqual(r.status, 200, 'K: publish 200');
  await settleReq(k1, 'sent'); await settleReq(k2, 'failed');
  assert.strictEqual((await notifyRow(k1)).requester_notify_status, 'sent', 'K: 有手机号单 sent');
  assert.strictEqual((await notifyRow(k2)).requester_notify_error, 'requester_phone_empty', 'K: 缺手机号单 failed');
  ok('批次内一单缺手机号 failed 其他单 sent（逐单 best-effort 隔离 + 后台派发不互相影响）');

  // ── L. 深链 baseUrl 开关 ──────────
  baseUrlVal = 'http://platform.example';
  before = sentLog.length;
  await seedAssigned();
  let lmd = sentLog.slice(before).filter(s => s.kind === 'dev')[0].md;
  assert.ok(lmd.includes('Sys_Iteration.html?issue='), 'L: baseUrl 非空 → md 含深链');
  baseUrlVal = '';
  before = sentLog.length;
  await seedAssigned();
  lmd = sentLog.slice(before).filter(s => s.kind === 'dev')[0].md;
  assert.ok(!lmd.includes('Sys_Iteration.html'), 'L: baseUrl 空 → md 省略深链');
  ok('深链 baseUrl 开关（配则带 Sys_Iteration.html?issue=，空则省略）');

  // ── M. markdown 转义（issueSafeText 复用 escapeMarkdown）──────────
  const evil = { id: 9, type: 'feature', title: '注入[x](http://e)`code`', system_name: 'B]M[S', dev_estimated_at: null };
  const dm = I.buildSysDevMarkdown(evil, 'notifyAssignedDeveloper', '');
  assert.ok(dm.md.includes('\\[') && dm.md.includes('\\(') && dm.md.includes('\\`'), 'M: 正文 title 特殊字符被转义');
  assert.ok(dm.md.includes('B\\]M\\[S'), 'M: 正文 system_name 方括号被转义');
  ok('markdown 正文转义：title/system_name 特殊字符走 issueSafeText（escapeMarkdown）');

  // ── M2. title 字段纯文本清理（L-1）：控制字符清掉 + 截断 + 不做 markdown 转义 ──────────
  const evil2 = { id: 9, type: 'feature', title: 'A\nB\tC' + 'x'.repeat(100), system_name: 'S', dev_estimated_at: null };
  const dm2 = I.buildSysDevMarkdown(evil2, 'notifyAssignedDeveloper', '');
  assert.ok(!/[\n\t]/.test(dm2.title), 'M2: title 字段控制字符被清理（无换行/制表）');
  assert.ok(dm2.title.length <= 75, 'M2: title 字段截断（前缀+≤60）');
  assert.ok(!dm2.title.includes('\\'), 'M2: title 字段是纯文本，不含 markdown 转义反斜杠');
  ok('title 字段纯文本清理：控制字符清掉 + 截断 + 非 markdown 转义（L-1）');

  // ── N. 直接 dispatchSysNotify 覆盖边界分支 ──────────
  // N1：no_assignee（待评估单无 assigned_to）
  r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'na', system_name: 'BMS', source: '内部' });
  const idN = r.body.id;
  await I.dispatchSysNotify(idN, 'notifyAssignedDeveloper');
  assert.strictEqual((await notifyRow(idN)).notify_error, 'no_assignee', 'N1: 无被指派人 → no_assignee');
  // N2：dev_not_found（assigned_to 指向不存在用户）
  await run('UPDATE sys_issues SET assigned_to = 999 WHERE id = ?', [idN]);
  await I.dispatchSysNotify(idN, 'notifyAssignedDeveloper');
  assert.strictEqual((await notifyRow(idN)).notify_error, 'dev_not_found', 'N2: 用户不存在 → dev_not_found');
  // N3：未知 marker 不崩（best-effort）
  await I.dispatchSysNotify(idN, 'notifyNonexistent');   // 不抛即通过
  // N4：no-op marker 早返回（submit/blocked）不查库不发
  before = sentLog.length;
  await I.dispatchSysNotify(idN, 'notifySubmittedToAdmin');
  await I.dispatchSysNotify(idN, 'notifyBlockedToAdmin');
  await I.dispatchSysNotify(idN, null);
  assert.strictEqual(sentLog.length, before, 'N4: no-op/null marker 不发送');
  ok('dispatchSysNotify 边界：no_assignee / dev_not_found / 未知 marker 不崩 / no-op 早返回');

  // ── 收尾 ──────────
  console.log(`\n✅ verify-sys-notify 全部通过（${passed} 项检查）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ verify-sys-notify 失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
