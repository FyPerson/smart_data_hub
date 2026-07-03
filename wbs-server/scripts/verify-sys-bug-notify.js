// 验证脚本：系统迭代 bug 流通知改手动（bug流_方案_20260702_v1.2 §6，Commit ④b-1）
//   用法：node scripts/verify-sys-bug-notify.js
//
// 覆盖（真实 HTTP + 落库状态）：
//   [A] bug 自动派发跳过：bug assign/estimate 不再自动发（notify_status/requester_notify_status 保持 not_sent）
//   [Md] 手动通知开发：POST notify-developer（admin/对接人）→ notify_status='sent'（复用 sendSysDevNotify）
//   [Mr] 手动通知报障人：POST notify-requester（有手机号）→ requester_notify_status='sent'；已上线走 released、其余走 progress
//   [G] 闸门：notify-developer 未指派 → 409 NO_ASSIGNEE_TO_NOTIFY / notify-requester 无手机号 → 409 NO_REQUESTER_PHONE
//   [T] type 精判：notify-developer/requester 对 feature → 400 MANUAL_NOTIFY_BUG_ONLY（变更流无手动端点）
//   [P] 权限：非白名单非 admin（dev id=5）→ 403 NOT_ADMIN_OR_BUG_LIAISON / 对接人(7) → 200
//   [C] ⭐变更流零回归 canary：feature assign 仍自动发开发(notify_status='sent') + feature estimate 仍自动发需求方
//       （requester_notify_status='sent'）——证明 dispatchSysNotify 的 bug 早返回精确隔离、未误伤变更流 auto
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-notify-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
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

// 捕获 ding 标题（验返工 vs 指派模板 / released bug 口径）——覆盖 _sys-attach-test-deps 的默认 stub
let lastDevTitle = null, lastReqTitle = null;
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r))),
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: async (_u, title, _md) => { lastDevTitle = title; return { ok: true, message_key: 'stub-dev' }; },
  sendIssueDingtalkToRequester: async (_p, title, _md) => { lastReqTitle = title; return { ok: true, message_key: 'stub-req' }; },
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

const adminTok = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const EST = '2026-08-01 10:00';
const PHONE = '13800000000';
const nStatus = async (id) => (await get('SELECT notify_status FROM sys_issues WHERE id=?', [id])).notify_status;
const rStatus = async (id) => (await get('SELECT requester_notify_status FROM sys_issues WHERE id=?', [id])).requester_notify_status;

async function createBug(extra = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'bug', system_name: 'BMS', source: '内部', ...extra });
  assert.strictEqual(r.status, 201, '建 bug 201 ' + JSON.stringify(r.body));
  return r.body.id;
}
async function bugAssigned(devId = 5, extra = {}) {
  const id = await createBug(extra);
  const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200');
  return id;
}
// bug 打回一轮回处理中（return_count=1）
async function bugReturned(devId = 5, extra = {}) {
  const id = await bugAssigned(devId, extra);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { summary: '修复' });   // 待验证
  const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '未修好' });   // 打回→处理中 return_count++
  assert.strictEqual(r.status, 200, 'bug return 200');
  return id;
}
// bug 走到已上线·不发版（release_id 保持 NULL，测 released 接缝）
async function bugOnlineNoRelease(devId = 5, extra = {}) {
  const id = await bugAssigned(devId, extra);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { summary: '修复' });   // 待验证
  await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});                    // 待上线
  await call('POST', `/api/sys-issues/${id}/set-release-flag`, devTok, { needs_release: 0 });   // 不发版
  const r = await call('POST', `/api/sys-issues/${id}/confirm-online-norelease`, adminTok, {}); // 已上线·release_id=NULL
  assert.strictEqual(r.status, 200, 'bug confirm-online-norelease 200 ' + JSON.stringify(r.body));
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin',NULL,NULL),(5,'dev','开发王','user','13900000000','du5'),
    (6,'dev2','开发李','user','13600000000','du6'),(7,'shenjun','示例发布者','publisher','13700000000','du7')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] bug 自动派发跳过 ═══
  {
    const id = await bugAssigned(5);   // assign 触发 dispatchSysNotify('notifyAssignedDeveloper')，bug 应早返回
    assert.strictEqual(await nStatus(id), 'not_sent', '[A] bug assign 后 notify_status 仍 not_sent（自动派发跳过）');
    // estimate bug（有报障人）→ 需求方侧也不自动发
    const id2 = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    let r = await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, 'bug estimate 200');
    assert.strictEqual(await rStatus(id2), 'not_sent', '[A] bug estimate 后 requester_notify_status 仍 not_sent（自动派发跳过）');
    ok('[A] bug 自动派发跳过：assign/estimate 后 dev/requester 通知态均保持 not_sent（走手动）');
  }

  // ═══ [Md] 手动通知开发（处理中·首次=指派模板）═══
  {
    const id = await bugAssigned(5);   // 处理中 return_count=0
    lastDevTitle = null;
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 200, '[Md] admin notify-developer 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.notify_status, 'sent', '[Md] 回 notify_status=sent');
    assert.strictEqual(await nStatus(id), 'sent', '[Md] 落库 notify_status=sent');
    assert.ok(/指派/.test(lastDevTitle), '[Md] 首次(return_count=0)用指派模板，title 含"指派" got ' + lastDevTitle);
    // 对接人也能手动通知开发
    const id2 = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${id2}/notify-developer`, liaisonTok);
    assert.strictEqual(r.status, 200, '[Md] 对接人 notify-developer 200');
    assert.strictEqual(await nStatus(id2), 'sent', '[Md] 对接人触发也落 sent');
    ok('[Md] 手动通知开发：admin/对接人（处理中·首次）→ notify_status=sent + 指派模板');
  }

  // ═══ [Mr] 手动通知报障人·progress（处理中）═══
  {
    const id = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    lastReqTitle = null;
    let r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Mr] notify-requester 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[Mr] progress → requester_notify_status=sent');
    assert.strictEqual(await rStatus(id), 'sent', '[Mr] 落库 requester_notify_status=sent');
    assert.ok(/进展/.test(lastReqTitle), '[Mr] 处理中→progress 卡片，title 含"进展" got ' + lastReqTitle);
    ok('[Mr] 手动通知报障人：progress 卡片（处理中）→ sent + title 含"进展"');
  }

  // ═══ [Rework] ultracode MED：打回返工用返工模板（非陈旧指派模板）═══
  {
    const id = await bugReturned(5);   // 处理中 return_count=1
    lastDevTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 200, '[Rework] 打回后处理中 notify-developer 200');
    assert.strictEqual(await nStatus(id), 'sent', '[Rework] 落 sent');
    assert.ok(/打回|返工/.test(lastDevTitle), '[Rework] return_count>0 用返工模板，title 含"打回/返工" got ' + lastDevTitle);
    ok('[Rework] 打回返工（return_count>0）通知开发 → 返工模板（修 ultracode MED：不发陈旧指派模板）');
  }

  // ═══ [Rework2] codex 复审 M-1（有意接受语义）：打回后改派新开发，通知仍走返工模板（锁定行为）═══
  {
    const id = await bugReturned(5);   // 处理中 return_count=1, dev5
    await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 6, oldAssignedTo: 5, reason: '换人' });   // 处理中 dev6, return_count 保留=1
    lastDevTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 200, '[Rework2] 打回后改派 notify-developer 200');
    assert.ok(/打回|返工/.test(lastDevTitle), '[Rework2] 打回后改派新开发仍返工模板（有意接受：内容对新接手者成立）got ' + lastDevTitle);
    ok('[Rework2] 打回后改派→通知开发仍返工模板（codex 复审 M-1 有意接受语义，锁定不加精判字段）');
  }

  // ═══ [Rel] codex L-1/ultracode：已上线·不发版(release_id=NULL) 通知报障人 → released bug 口径 ═══
  {
    const id = await bugOnlineNoRelease(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    assert.strictEqual((await get('SELECT release_id FROM sys_issues WHERE id=?', [id])).release_id, null, '[Rel] confirm-online-norelease → release_id=NULL');
    lastReqTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Rel] 已上线 notify-requester 200（release_id=NULL 接缝优雅降级不报错）');
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[Rel] released → sent');
    assert.ok(/已修复上线|问题/.test(lastReqTitle), '[Rel] bug released 用问题修复口径 got ' + lastReqTitle);
    ok('[Rel] 已上线·不发版(release_id=NULL) 通知报障人 → released bug 口径「已修复上线」+ sent（接缝无错）');
  }

  // ═══ [S] codex H-1/M-1 + ultracode：手动通知后端状态闸门（终态拦截，前后端同源真闸）═══
  {
    // 已作废 bug（assigned 仍在）→ notify-developer / notify-requester 均 409 STATUS_NOT_NOTIFIABLE
    const voidedId = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    await call('POST', `/api/sys-issues/${voidedId}/void`, adminTok, { reason: '误建' });
    let r = await call('POST', `/api/sys-issues/${voidedId}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 已作废 bug notify-developer → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] dev code=STATUS_NOT_NOTIFIABLE');
    r = await call('POST', `/api/sys-issues/${voidedId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 已作废 bug notify-requester → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] requester code=STATUS_NOT_NOTIFIABLE');
    // 待验证 bug notify-developer → 409（通知开发仅处理中）
    const verifyingId = await bugAssigned(5);
    await call('POST', `/api/sys-issues/${verifyingId}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${verifyingId}/submit`, devTok, { summary: '修复' });   // 待验证
    r = await call('POST', `/api/sys-issues/${verifyingId}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 待验证 bug notify-developer → 409（仅处理中）');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 待验证 dev 409');
    // 待处理(未受理) bug notify-requester → 409（有 phone 但未受理无进展；状态闸门在 phone 校验前）
    const pendingId = await createBug({ requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    r = await call('POST', `/api/sys-issues/${pendingId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 待处理 bug notify-requester → 409（未受理无进展）');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 待处理 requester 409');
    // [codex 复审 L-2] 已拒绝 终态 bug（待处理→issue_reject，未指派）notify-requester 有 phone → 409 STATUS_NOT_NOTIFIABLE
    //   （notify-developer 对已拒绝走 NO_ASSIGNEE，因已拒绝从待处理来未指派；⚠️ 已关闭对 bug 不可达=bug 流无 close 动作，故不测该态）
    const rejectedId = await createBug({ requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    await call('POST', `/api/sys-issues/${rejectedId}/issue-reject`, adminTok, { reason: '非缺陷' });
    r = await call('POST', `/api/sys-issues/${rejectedId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 已拒绝 bug notify-requester → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 已拒绝 requester STATUS_NOT_NOTIFIABLE');
    ok('[S] 后端状态闸门：终态(已作废/已拒绝)/待验证/待处理 → dev/requester 409 STATUS_NOT_NOTIFIABLE（前端镜像·后端权威真闸；已关闭对 bug 不可达）');
  }

  // ═══ [G] 闸门 ═══
  {
    const unassigned = await createBug();   // 待处理，未指派
    let r = await call('POST', `/api/sys-issues/${unassigned}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 409, '[G] 未指派 notify-developer → 409');
    assert.strictEqual(r.body.code, 'NO_ASSIGNEE_TO_NOTIFY', '[G] code=NO_ASSIGNEE_TO_NOTIFY');
    const noPhone = await bugAssigned(5);   // 无报障人手机号
    r = await call('POST', `/api/sys-issues/${noPhone}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[G] 无手机号 notify-requester → 409');
    assert.strictEqual(r.body.code, 'NO_REQUESTER_PHONE', '[G] code=NO_REQUESTER_PHONE');
    ok('[G] 闸门：未指派通知开发 409 NO_ASSIGNEE_TO_NOTIFY + 无手机号通知报障人 409 NO_REQUESTER_PHONE');
  }

  // ═══ [T] type 精判（变更流无手动端点）═══
  {
    // feature → schedule → assign
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'feat', system_name: 'BMS', source: '内部', requester_phone: PHONE });
    const fid = r.body.id;
    await call('POST', `/api/sys-issues/${fid}/schedule`, adminTok, {});
    await call('POST', `/api/sys-issues/${fid}/assign`, adminTok, { assigned_to: 5 });
    r = await call('POST', `/api/sys-issues/${fid}/notify-developer`, adminTok);
    assert.strictEqual(r.status, 400, '[T] feature notify-developer → 400');
    assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY', '[T] code=MANUAL_NOTIFY_BUG_ONLY');
    r = await call('POST', `/api/sys-issues/${fid}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 400, '[T] feature notify-requester → 400 MANUAL_NOTIFY_BUG_ONLY');
    ok('[T] type 精判：feature 手动通知端点 → 400 MANUAL_NOTIFY_BUG_ONLY（变更流无手动端点）');
  }

  // ═══ [P] 权限 ═══
  {
    const id = await bugAssigned(5);
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, devTok);   // dev(5) 非白名单非 admin
    assert.strictEqual(r.status, 403, '[P] 非白名单非 admin notify-developer → 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_BUG_LIAISON', '[P] code=NOT_ADMIN_OR_BUG_LIAISON');
    ok('[P] 权限：非白名单非 admin 手动通知 → 403 NOT_ADMIN_OR_BUG_LIAISON');
  }

  // ═══ [C] ⭐变更流零回归 canary（feature/improvement 多 marker 自动派发仍生效）═══
  //   codex M-2：改的是共享基建 dispatchSysNotify，补 feature+improvement × assign/estimate/reassign/return 逐分支证据。
  const seedChangeAssigned = async (type, devId, extra = {}) => {
    const rr = await call('POST', '/api/sys-issues', adminTok, { type, title: type + '-canary', system_name: 'BMS', source: '业务方', ...extra });
    const cid = rr.body.id;
    await call('POST', `/api/sys-issues/${cid}/schedule`, adminTok, {});
    await call('POST', `/api/sys-issues/${cid}/assign`, adminTok, { assigned_to: devId });   // 开发中
    return cid;
  };
  {
    // feature assign→dev auto + estimate→requester auto
    const fid = await seedChangeAssigned('feature', 5, { requester_dept: '市场部', requester_name: '李四', requester_phone: PHONE });
    assert.strictEqual(await nStatus(fid), 'sent', '[C] ⭐feature assign 仍自动发开发——bug 早返回未误伤变更流');
    await call('POST', `/api/sys-issues/${fid}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(await rStatus(fid), 'sent', '[C] ⭐feature estimate 仍自动发需求方');
    // improvement assign→dev auto（覆盖 improvement 类型，codex M-2 点名）
    const iid = await seedChangeAssigned('improvement', 5);
    assert.strictEqual(await nStatus(iid), 'sent', '[C] improvement assign 仍自动发开发（变更流两类型均零回归）');
    // feature reassign→新开发 auto（换人 marker）
    const fid2 = await seedChangeAssigned('feature', 5);
    let r = await call('POST', `/api/sys-issues/${fid2}/reassign`, adminTok, { newAssignedTo: 6, oldAssignedTo: 5, reason: '换人' });
    assert.strictEqual(r.status, 200, 'feature reassign 200');
    assert.strictEqual(await nStatus(fid2), 'sent', '[C] feature reassign 仍自动发新开发（reassign marker）');
    // feature return→dev auto（打回 marker）
    const fid3 = await seedChangeAssigned('feature', 5);
    await call('POST', `/api/sys-issues/${fid3}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${fid3}/submit`, devTok, { summary: '交付' });   // 待验证
    await call('POST', `/api/sys-issues/${fid3}/return`, adminTok, { reason: '打回' });   // 开发中
    assert.strictEqual(await nStatus(fid3), 'sent', '[C] feature return 仍自动发开发（return marker）');
    ok('[C] 变更流零回归 canary：feature+improvement × assign/estimate/reassign/return 全部仍自动派发 sent（dispatchSysNotify bug 早返回精确隔离，publish/reopen 由 verify-sys-notify/release 覆盖）');
  }

  server.close();
  console.log(`\n✅ verify-sys-bug-notify 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-bug-notify 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
