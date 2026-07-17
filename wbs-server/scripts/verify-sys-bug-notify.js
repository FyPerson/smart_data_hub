// 验证脚本：系统迭代 bug 流通知（④b-1 手动通知基座 + 通知改造 C3 四方扩展）
//   用法：node scripts/verify-sys-bug-notify.js
//
// 覆盖（真实 HTTP + 落库状态）：
//   [A] bug 自动派发跳过：bug assign/estimate 不再自动发（notify_status/requester_notify_status 保持 not_sent）
//   [Md] 手动通知开发（逐 dev，C3 G9）：POST notify-developer 带 dev_user_id → 子表 notify_status='sent'
//   [Mr] 手动通知报障人：POST notify-requester（有手机号，非「处理中」态）→ requester_notify_status='sent'
//   [F3] 收窄：「处理中」态不再可通知报障人（用户 2026-07-06 拍板，方案 §5.2 sendable 去掉处理中）
//   [Snap] H-5/M-A 收件人快照：首发落快照 → 清空当前 requester_phone 后仍可重发/查已读（读快照不读当前值）
//   [Relay] 通知对接人（新，G7）：path B 建单 → notify-relay sent；未指定/非待处理/白名单外 → 409
//   [Creator] 通知建单人（新，G8）：self-guard(admin=created_by 恒跳过) + 非建单人开发/白名单发送成功 + 未授权 403
//   [RS] 查已读状态（新，G11）：INVALID_NOTIFY_TYPE / DEV_USER_ID_REQUIRED / NOTIFY_NOT_SENT / cached / HISTORICAL_SNAPSHOT_MISSING / NO_DINGTALK_CONFIG（stub 空配置，不深入真钉钉，同 verify-sys-create-chat 范式）
//   [G] 闸门：notify-developer 非本单开发 → 409 DEV_ASSIGNEE_NOT_FOUND / notify-requester 无手机号且无快照 → 409 NO_REQUESTER_PHONE
//   [T] type 精判：notify-developer/relay/creator/requester 对 feature → 400 MANUAL_NOTIFY_BUG_ONLY（变更流无手动端点）
//   [P] 权限：dev 非白名单非 admin → 403 / relay 白名单成员不可发（仅 admin）/ creator 宽松矩阵
//   [C] ⭐变更流零回归 canary：feature assign 仍自动发开发(notify_status='sent') + feature estimate 仍自动发需求方
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
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

// 捕获 ding 标题（验返工 vs 指派模板 / released bug 口径 / relay·creator 模板）——覆盖 _sys-attach-test-deps 的默认 stub
let lastDevTitle = null, lastReqTitle = null, lastRawTitle = null;
let lastReqPhone = null;   // [U-1·codex43] 记录 requester 实际发送目标手机号，把 M-A"重发认同一人"从间接推导升为强断言
let reqSendMode = 'ok';   // [U-1] requester 发送 mock 三态：'ok'=成功 / 'invalid'=硬失败未送达(号查不到,不固化) / 'key_missing'=已送达无key(应固化)
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r))),
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: async (_u, title, _md) => { lastDevTitle = title; lastRawTitle = title; return { ok: true, message_key: 'stub-dev' }; },
  sendIssueDingtalkToRequester: async (p, title, _md) => {
    lastReqTitle = title; lastReqPhone = p;
    if (reqSendMode === 'ok') return { ok: true, message_key: 'stub-req' };
    if (reqSendMode === 'key_missing') return { ok: false, reason: 'message_key_missing' };   // 钉钉已送达但无 key（r.success 却缺 key）
    return { ok: false, reason: 'requester_invalid' };   // 硬失败：号查不到钉钉，未送达
  },
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);
const liaison2Tok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

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
const devRowStatus = async (issueId, userId) => (await get('SELECT notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL', [issueId, userId])).notify_status;

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
async function bugAssignedWithCollab(primaryId, collaboratorIds, extra = {}) {
  const id = await createBug(extra);
  const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: primaryId, collaborator_ids: collaboratorIds });
  assert.strictEqual(r.status, 200, 'bug assign(带协作) 200 ' + JSON.stringify(r.body));
  return id;
}
// bug 打回一轮回处理中（return_count=1）
async function bugReturned(devId = 5, extra = {}) {
  const id = await bugAssigned(devId, extra);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '修复（占位理由）' });   // 待验证
  const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '未修好' });   // 打回→处理中 return_count++
  assert.strictEqual(r.status, 200, 'bug return 200');
  return id;
}
// bug 走到待验证（accept 前）
async function bugToVerifying(devId = 5, extra = {}) {
  const id = await bugAssigned(devId, extra);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '修复（占位理由）' });
  assert.strictEqual(r.status, 200, 'bug submit 200');
  return id;
}
// bug 走到已上线·不发版（release_id 保持 NULL，测 released 接缝）—— 通知改造后走新 G3-G6 编排流程（C3b 消费点，此处
//   仍走旧 set-release-flag/confirm-online-norelease，因 verify-sys-bug-notify 的事实基线早于 C3b 退场；
//   C3b 落地后本 helper 由 verify-sys-release-orchestration.js 系列脚本另行覆盖 G3-G6 路径，本文件聚焦通知本身，
//   仍需一个「已上线」态样本 —— 改走 accept→hotfix-publish 前的最短路径已随 C3b 退场，故改造为直接 DB 打状态构造样本，
//   不依赖已退场的端点（避免本文件在 C3b commit 后失败）。
async function bugOnlineNoRelease(devId = 5, extra = {}) {
  const id = await bugToVerifying(devId, extra);
  await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});   // 待上线
  // 直接构造「已上线·不发版」终态样本（release_id 保持 NULL），不经过已退场的 set-release-flag/confirm-online-norelease——
  //   本文件只关心通知侧行为（released 文案/sendable 门），已上线路径本身由 verify-sys-release-orchestration 覆盖。
  await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [id]);
  return id;
}
// bug 到待上线 + 指定上线执行开发（release_assignee，follow-up 2026-07-07）——直接 DB 指定 release_assignee
//   （assign-release-dev 端点本身由 verify-sys-release-orchestration 覆盖，本文件聚焦「通知上线开发」侧行为）。
async function bugToPrereleaseWithExecutor(devId = 5, execId = 6, extra = {}) {
  const id = await bugToVerifying(devId, extra);
  await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});   // 待上线
  await run('UPDATE sys_issues SET release_assignee_id=?, release_assignee_name=? WHERE id=?', [execId, '开发李', id]);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin',NULL,NULL),(5,'dev','开发王','user','13900000000','du5'),
    (6,'dev2','开发李','user','13600000000','du6'),(7,'shenjun','示例发布者','publisher','13700000000','du7'),
    (13,'wangtaotao','示例对接人','user','13500000000','du13')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] bug 自动派发跳过 ═══
  {
    const id = await bugAssigned(5);   // assign 触发 dispatchSysNotify('notifyAssignedDeveloper')，bug 应早返回
    assert.strictEqual(await nStatus(id), 'not_sent', '[A] bug assign 后主表 notify_status 仍 not_sent（转只读回溯，弃写）');
    assert.strictEqual(await devRowStatus(id, 5), 'not_sent', '[A] bug assign 后子表 notify_status 仍 not_sent（自动派发跳过，通知走手动 G9）');
    // estimate bug（有报障人）→ 需求方侧也不自动发
    const id2 = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    let r = await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, 'bug estimate 200');
    assert.strictEqual(await rStatus(id2), 'not_sent', '[A] bug estimate 后 requester_notify_status 仍 not_sent（自动派发跳过）');
    ok('[A] bug 自动派发跳过：assign/estimate 后主表+子表/requester 通知态均保持 not_sent（走手动）');
  }

  // ═══ [Md] 手动通知开发（逐 dev，C3 G9；处理中·首次=指派模板）═══
  {
    const id = await bugAssigned(5);   // 处理中 return_count=0
    lastDevTitle = null;
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 200, '[Md] admin notify-developer 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.notify_status, 'sent', '[Md] 回 notify_status=sent');
    assert.strictEqual(r.body.dev_user_id, 5, '[Md] 回响应带 dev_user_id 回显');
    assert.strictEqual(await devRowStatus(id, 5), 'sent', '[Md] 落库子表 notify_status=sent（非主表）');
    assert.strictEqual(await nStatus(id), 'not_sent', '[Md] 主表 notify_status 保持 not_sent（子表才是真相源）');
    assert.ok(/指派/.test(lastDevTitle), '[Md] 首次(return_count=0)用指派模板，title 含"指派" got ' + lastDevTitle);
    // 对接人也能手动通知开发
    const id2 = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${id2}/notify-developer`, liaisonTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 200, '[Md] 对接人 notify-developer 200');
    assert.strictEqual(await devRowStatus(id2, 5), 'sent', '[Md] 对接人触发也落子表 sent');
    // 缺 dev_user_id → 400
    const id3 = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${id3}/notify-developer`, adminTok, {});
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'DEV_USER_ID_REQUIRED');
    ok('[Md] 手动通知开发（逐 dev）：admin/对接人（处理中·首次）→ 子表 notify_status=sent + 指派模板 + 缺 dev_user_id 400');
  }

  // ═══ [Md2] 多开发：主开发+协作各自独立通知状态（C3 G9 消费批2 子表）═══
  {
    const id = await bugAssignedWithCollab(5, [6]);   // 处理中，主开发5+协作6
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 200, '[Md2] 通知主开发 200');
    assert.strictEqual(await devRowStatus(id, 5), 'sent', '[Md2] 主开发子表 sent');
    assert.strictEqual(await devRowStatus(id, 6), 'not_sent', '[Md2] 协作开发子表仍 not_sent（各自独立，未被误发）');
    r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, '[Md2] 通知协作开发 200');
    assert.strictEqual(await devRowStatus(id, 6), 'sent', '[Md2] 协作开发子表也变 sent（独立通知不互相影响）');
    // 通知一个不在本单指派子表的用户 → 409 DEV_ASSIGNEE_NOT_FOUND
    r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 99 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'DEV_ASSIGNEE_NOT_FOUND');
    ok('[Md2] 多开发逐 dev 独立通知状态（主/协作互不覆盖）+ 非本单开发 409 DEV_ASSIGNEE_NOT_FOUND');
  }

  // ═══ [Mr] 手动通知报障人·progress（待验证态，F3 收窄后处理中不再可发）═══
  {
    const id = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });   // 待验证
    lastReqTitle = null;
    let r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Mr] notify-requester 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[Mr] progress → requester_notify_status=sent');
    assert.strictEqual(await rStatus(id), 'sent', '[Mr] 落库 requester_notify_status=sent');
    assert.ok(/进展/.test(lastReqTitle), '[Mr] 待验证→progress 卡片，title 含"进展" got ' + lastReqTitle);
    const snap = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id])).requester_notify_phone_snapshot;
    assert.strictEqual(snap, PHONE, '[Mr] 发送成功落收件人快照（H-5）');
    ok('[Mr] 手动通知报障人：progress 卡片（待验证）→ sent + title 含"进展" + 落收件人快照');
  }

  // ═══ [F3] 用户 2026-07-06 拍板收窄：处理中不再可通知报障人（原④b-1 含处理中，方案 §5.2 去掉）═══
  {
    const id = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });   // 处理中
    const r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[F3] 处理中 bug notify-requester 应 409（收窄后不再可发）');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[F3] code=STATUS_NOT_NOTIFIABLE');
    ok('[F3] 收窄验证：处理中态不再可通知报障人（sendable={待验证,待上线,已上线}，方案 §5.2 逐字执行）');
  }

  // ═══ [Snap] H-5/M-A 收件人快照：发后改号/清号，重发仍认原快照 ═══
  {
    const id = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    let r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Snap] 首发 200');
    const snapAfterFirst = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id])).requester_notify_phone_snapshot;
    assert.strictEqual(snapAfterFirst, PHONE, '[Snap] 首发后快照=当前手机号');
    // 清空当前 requester_phone（模拟发后改号/清号）
    await run('UPDATE sys_issues SET requester_phone=NULL WHERE id=?', [id]);
    lastReqTitle = null;
    r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Snap] 清空当前手机号后重发仍 200（M-A：重发依赖快照非当前值）');
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[Snap] 重发仍 sent');
    const snapAfterResend = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id])).requester_notify_phone_snapshot;
    assert.strictEqual(snapAfterResend, PHONE, '[Snap] 重发后快照不变（COALESCE 幂等，非覆盖成 NULL）');
    ok('[Snap] 收件人快照：首发落快照 + 清空当前 requester_phone 后重发仍用旧快照成功（M-A 两套规则）');
    // 真正首次无手机号（快照也空）→ 409 NO_REQUESTER_PHONE
    const noPhoneId = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${noPhoneId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'NO_REQUESTER_PHONE');
    ok('[Snap] 真首次无手机号（快照+当前值皆空）→ 409 NO_REQUESTER_PHONE（M-A 首发依赖当前值语义保留）');
  }

  // ═══ [U-1] 首发失败不固化快照：admin 改正手机号后仍能生效（ultracode 收口）═══
  {
    const WRONG = '13800000000', RIGHT = PHONE;
    const id = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '李四', requester_phone: WRONG });
    // ① 首发硬失败（模拟 sendIssueDingtalkToRequester 查不到钉钉号 requester_invalid → ok:false·未送达）
    reqSendMode = 'invalid';
    let r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    reqSendMode = 'ok';
    assert.strictEqual(r.status, 200, '[U-1] 首发失败仍 200（落 failed 状态，非 HTTP 错误）');
    assert.strictEqual(r.body.requester_notify_status, 'failed', '[U-1] 首发失败落 status=failed');
    const snapAfterFail = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id])).requester_notify_phone_snapshot;
    assert.strictEqual(snapAfterFail, null, '[U-1] ⭐ 首发失败不固化快照（收口前会被 COALESCE 锁死错号→业务方永久失联）');
    // ② admin 改正手机号
    await run('UPDATE sys_issues SET requester_phone=? WHERE id=?', [RIGHT, id]);
    // ③ 重发成功 → 读改正后的当前号（快照仍空，非旧错号），成功后快照落正确值
    r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[U-1] 改正手机号后重发 200');
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[U-1] 改正后重发 sent（读当前 phone 非旧错号快照）');
    const snapAfterFix = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id])).requester_notify_phone_snapshot;
    assert.strictEqual(snapAfterFix, RIGHT, '[U-1] 成功后快照=改正后手机号（非旧错号）');
    ok('[U-1] 首发硬失败不锁快照：改正 requester_phone 后重发生效、快照落正确号（收口前失败首发被 COALESCE 永久锁死错号→业务方失联）');

    // ④ [codex42] message_key_missing（钉钉已送达但无 key）=已投递→**应固化快照**（区别于硬失败不固化）；
    //    admin 若误以为没发去改号，重发仍认已送达那人（M-A"重发认同一人"不被本收口误伤）。
    const km = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '王五', requester_phone: RIGHT });
    reqSendMode = 'key_missing';
    r = await call('POST', `/api/sys-issues/${km}/notify-requester`, adminTok);
    reqSendMode = 'ok';
    assert.strictEqual(r.body.requester_notify_status, 'failed', '[U-1] message_key_missing 落 failed（无 key 无法跟踪已读）');
    const snapKm = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [km])).requester_notify_phone_snapshot;
    assert.strictEqual(snapKm, RIGHT, '[U-1] ⭐ message_key_missing=已送达→固化快照（区别硬失败不固化，codex42）');
    await run('UPDATE sys_issues SET requester_phone=? WHERE id=?', ['13900000000', km]);   // admin 误改号
    lastReqPhone = null;
    r = await call('POST', `/api/sys-issues/${km}/notify-requester`, adminTok);
    assert.strictEqual(lastReqPhone, RIGHT, '[U-1] ⭐ 改号后重发的**实际发送目标**=原快照号（非新号 13900000000）——M-A 强断言（codex43）');
    const snapKm2 = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [km])).requester_notify_phone_snapshot;
    assert.strictEqual(snapKm2, RIGHT, '[U-1] message_key_missing 后改号重发仍认原快照（M-A：已送达那人，非新号）');
    ok('[U-1·codex42] message_key_missing=已投递→固化快照（区别硬失败不固化）；改号后重发仍认已送达那人（M-A"重发认同一人"不被收口误伤）');
  }

  // ═══ [Rework] ultracode MED：打回返工用返工模板（非陈旧指派模板）═══
  {
    const id = await bugReturned(5);   // 处理中 return_count=1
    lastDevTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 200, '[Rework] 打回后处理中 notify-developer 200');
    assert.strictEqual(await devRowStatus(id, 5), 'sent', '[Rework] 落子表 sent');
    assert.ok(/打回|返工/.test(lastDevTitle), '[Rework] return_count>0 用返工模板，title 含"打回/返工" got ' + lastDevTitle);
    ok('[Rework] 打回返工（return_count>0）通知开发 → 返工模板（修 ultracode MED：不发陈旧指派模板）');
  }

  // ═══ [Rework2] codex 复审 M-1（有意接受语义）：打回后改派新开发，通知仍走返工模板（锁定行为）═══
  {
    const id = await bugReturned(5);   // 处理中 return_count=1, dev5
    // ⚠️ 既有测试变更（C2：reassign body 改 member_ids+reason，见交付汇报清单）。
    await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '换人' });   // 处理中 dev6, return_count 保留=1
    lastDevTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, '[Rework2] 打回后改派 notify-developer 200');
    assert.ok(/打回|返工/.test(lastDevTitle), '[Rework2] 打回后改派新开发仍返工模板（有意接受：内容对新接手者成立）got ' + lastDevTitle);
    ok('[Rework2] 打回后改派→通知开发仍返工模板（codex 复审 M-1 有意接受语义，锁定不加精判字段）');
  }

  // ═══ [Rel] codex L-1/ultracode：已上线·不发版(release_id=NULL) 通知报障人 → released bug 口径 ═══
  {
    const id = await bugOnlineNoRelease(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    assert.strictEqual((await get('SELECT release_id FROM sys_issues WHERE id=?', [id])).release_id, null, '[Rel] 已上线·不发版 → release_id=NULL');
    lastReqTitle = null;
    const r = await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, '[Rel] 已上线 notify-requester 200（release_id=NULL 接缝优雅降级不报错）');
    assert.strictEqual(r.body.requester_notify_status, 'sent', '[Rel] released → sent');
    assert.ok(/已修复上线|问题/.test(lastReqTitle), '[Rel] bug released 用问题修复口径 got ' + lastReqTitle);
    ok('[Rel] 已上线·不发版(release_id=NULL) 通知报障人 → released bug 口径「已修复上线」+ sent（接缝无错）');
  }

  // ═══ [Relay] 通知对接人（新，G7）═══
  {
    // path B 建单（relay_user_id=7 示例发布者）→ 待处理态 → notify-relay 成功
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'relay-a', system_name: 'BMS', source: '内部', assign_mode: 'B', relay_user_id: 7 });
    assert.strictEqual(r.status, 201, '[Relay] path B 建单 201 ' + JSON.stringify(r.body));
    const idA = r.body.id;
    lastRawTitle = null;
    r = await call('POST', `/api/sys-issues/${idA}/notify-relay`, adminTok);
    assert.strictEqual(r.status, 200, '[Relay] notify-relay 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.relay_notify_status, 'sent', '[Relay] relay_notify_status=sent');
    assert.strictEqual((await get('SELECT relay_notify_status FROM sys_issues WHERE id=?', [idA])).relay_notify_status, 'sent', '[Relay] 落库 sent');
    assert.ok(/指派/.test(lastRawTitle), '[Relay] title 含"指派"（协助指派开发）got ' + lastRawTitle);
    // 未指定对接人（none 路径）→ 409 NO_RELAY_USER_TO_NOTIFY
    const idNone = await createBug();
    r = await call('POST', `/api/sys-issues/${idNone}/notify-relay`, adminTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'NO_RELAY_USER_TO_NOTIFY');
    // 非待处理态（已指派进处理中）→ 409 STATUS_NOT_NOTIFIABLE（即便有 relay_user_id，此单走 path A 未设置 relay，构造脏数据验证状态门）
    let r2 = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'relay-b', system_name: 'BMS', source: '内部', assign_mode: 'B', relay_user_id: 13 });
    const idB = r2.body.id;
    await run(`UPDATE sys_issues SET status='处理中', assigned_to=5, assigned_to_name='开发王' WHERE id=?`, [idB]);
    r = await call('POST', `/api/sys-issues/${idB}/notify-relay`, adminTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE');
    // 白名单外（脏数据：relay_notified_user_id 指向非白名单用户）→ 409 RELAY_USER_NOT_WHITELISTED
    const idC = await createBug();
    await run('UPDATE sys_issues SET relay_notified_user_id=5 WHERE id=?', [idC]);   // dev(5) 非白名单
    r = await call('POST', `/api/sys-issues/${idC}/notify-relay`, adminTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELAY_USER_NOT_WHITELISTED');
    ok('[Relay] 通知对接人：path B 待处理态成功 sent + title 含指派 + 未指定 409 + 非待处理 409 + 白名单外 409（防御纵深）');
  }

  // ═══ [Creator] 通知建单人（新，G8，self-guard 横切）═══
  {
    // native 建单 created_by 恒 admin(1)——admin 自己触发 → self-guard 200 skipped
    const id = await bugToVerifying(5);   // 待验证
    let r = await call('POST', `/api/sys-issues/${id}/notify-creator`, adminTok);
    assert.strictEqual(r.status, 200, '[Creator] admin(=created_by) 触发 200');
    assert.strictEqual(r.body.skipped, true, '[Creator] self-guard：skipped=true');
    assert.strictEqual(r.body.code, 'SELF_NOTIFY_SKIPPED', '[Creator] code=SELF_NOTIFY_SKIPPED');
    assert.strictEqual((await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id])).creator_notify_status, 'not_sent', '[Creator] self-guard 不实际发送，creator_notify_status 仍 not_sent');
    // 主开发本人（非建单人）触发 → 实际发送 sent
    lastRawTitle = null;
    r = await call('POST', `/api/sys-issues/${id}/notify-creator`, devTok);
    assert.strictEqual(r.status, 200, '[Creator] 主开发触发 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.creator_notify_status, 'sent', '[Creator] 主开发（非建单人）触发 → 实发 sent');
    assert.strictEqual((await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id])).creator_notify_status, 'sent', '[Creator] 落库 sent');
    // 白名单对接人触发 → 也能发（未被 self-guard 拦，因对接人非建单人）
    const id2 = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${id2}/notify-creator`, liaisonTok);
    assert.strictEqual(r.status, 200, '[Creator] 白名单对接人触发 200');
    assert.strictEqual(r.body.creator_notify_status, 'sent', '[Creator] 白名单触发 → sent');
    // 未授权（dev2 非本单主开发/非白名单/非 admin）→ 403
    const id3 = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${id3}/notify-creator`, dev2Tok);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_NOTIFY');
    // 状态门：处理中态不可通知建单人（sendable={待验证,待上线,已上线}）
    const idMid = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${idMid}/notify-creator`, devTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE');
    ok('[Creator] 通知建单人：admin(=created_by) self-guard 200 skipped + 主开发/白名单实发 sent + 未授权 403 + 状态门 409');
  }

  // ═══ [RelExec] 通知上线开发（release_assignee 侧，follow-up 2026-07-07，仅 admin）═══
  {
    // 未指定上线开发（release_assignee_id 空）+ 待上线 → 409 NO_RELEASE_ASSIGNEE_TO_NOTIFY
    const idNo = await bugToVerifying(5);
    await call('POST', `/api/sys-issues/${idNo}/accept`, adminTok, {});   // 待上线，未指定 release_assignee
    let r = await call('POST', `/api/sys-issues/${idNo}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 409, '[RelExec] 未指定上线开发 409 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'NO_RELEASE_ASSIGNEE_TO_NOTIFY', '[RelExec] code=NO_RELEASE_ASSIGNEE_TO_NOTIFY');

    // 指定 release_assignee(6) + 待上线 → admin 发送成功 sent
    const id = await bugToPrereleaseWithExecutor(5, 6);
    r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 200, '[RelExec] admin 发送 200 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.release_assignee_notify_status, 'sent', '[RelExec] admin 发送 → sent');
    assert.strictEqual((await get('SELECT release_assignee_notify_status FROM sys_issues WHERE id=?', [id])).release_assignee_notify_status, 'sent', '[RelExec] 落库 sent');

    // 非 admin（主开发 / 白名单对接人）→ 403（requireAdmin，仅 admin 可发，区别于 dev/requester 的 admin_or_bug_liaison）
    r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, devTok);
    assert.strictEqual(r.status, 403, '[RelExec] 主开发 403（仅 admin）');
    r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, liaisonTok);
    assert.strictEqual(r.status, 403, '[RelExec] 白名单对接人 403（仅 admin）');

    // 非待上线态（处理中，即便已指定 release_assignee）→ 409 STATUS_NOT_NOTIFIABLE
    const idMid = await bugAssigned(5);
    await run('UPDATE sys_issues SET release_assignee_id=6, release_assignee_name=? WHERE id=?', ['开发李', idMid]);
    r = await call('POST', `/api/sys-issues/${idMid}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 409, '[RelExec] 处理中态 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[RelExec] 非待上线 code=STATUS_NOT_NOTIFIABLE');

    // feature 单（变更流）→ 400 MANUAL_NOTIFY_BUG_ONLY（第 5 类同其余 4 类，仅 bug）
    const rf = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'feat', system_name: 'BMS', source: '内部' });
    r = await call('POST', `/api/sys-issues/${rf.body.id}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 400, '[RelExec] feature 单 400');
    assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY', '[RelExec] feature code=MANUAL_NOTIFY_BUG_ONLY');

    ok('[RelExec] 通知上线开发（仅 admin）：admin 发 sent + 未指定 409 + 主开发/白名单 403 + 非待上线 409 + feature 400');
  }

  // ═══ [RS] 查已读状态（新，G11）═══
  {
    // INVALID_NOTIFY_TYPE
    const id = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    let r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=bogus`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_NOTIFY_TYPE');
    // type=dev 缺 dev_user_id
    r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=dev`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'DEV_USER_ID_REQUIRED');
    // type=dev 非本单开发 → 404
    r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=dev&dev_user_id=99`, adminTok);
    assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'DEV_ASSIGNEE_NOT_FOUND');
    // 尚未发送 → NOTIFY_NOT_SENT（dev/relay/creator/requester 各测一遍，覆盖 4 类型分支）
    for (const t of ['relay', 'creator', 'requester', 'release_executor']) {
      r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=${t}`, adminTok);
      assert.strictEqual(r.status, 400, `[RS] type=${t} 未发送应 400`);
      assert.strictEqual(r.body.code, 'NOTIFY_NOT_SENT', `[RS] type=${t} code=NOTIFY_NOT_SENT`);
    }
    r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=dev&dev_user_id=5`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'NOTIFY_NOT_SENT');
    // 已发送 + read_at 已固化 → cached:true（不查配置/钉钉）
    await call('POST', `/api/sys-issues/${id}/notify-requester`, adminTok);   // 落 sent + message_key
    await run("UPDATE sys_issues SET requester_read_at='2026-08-01 12:00:00' WHERE id=?", [id]);
    r = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=requester`, adminTok);
    assert.strictEqual(r.status, 200, '[RS] cached 200');
    assert.strictEqual(r.body.read, true); assert.strictEqual(r.body.cached, true);
    // 已发送但快照为空（历史迁移前旧数据模拟）→ HISTORICAL_SNAPSHOT_MISSING
    const id2 = await bugToVerifying(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    await call('POST', `/api/sys-issues/${id2}/notify-requester`, adminTok);
    await run('UPDATE sys_issues SET requester_notify_phone_snapshot=NULL WHERE id=?', [id2]);   // 模拟历史无快照
    r = await call('GET', `/api/sys-issues/${id2}/notify-read-status?type=requester`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'HISTORICAL_SNAPSHOT_MISSING');
    // 已发送 + 无 read_at + 无钉钉配置（stub 空）→ NO_DINGTALK_CONFIG（同 verify-sys-create-chat 范式，不深入真钉钉反查）
    //   ⚠️ 用新的「处理中」态 bug（非 id，id 已 submit 到「待验证」，notify-developer 仅处理中态可发）
    const idDev = await bugAssigned(5);
    await call('POST', `/api/sys-issues/${idDev}/notify-developer`, adminTok, { dev_user_id: 5 });
    r = await call('GET', `/api/sys-issues/${idDev}/notify-read-status?type=dev&dev_user_id=5`, adminTok);
    assert.strictEqual(r.status, 500); assert.strictEqual(r.body.code, 'NO_DINGTALK_CONFIG');
    ok('[RS] 查已读状态：INVALID_NOTIFY_TYPE/DEV_USER_ID_REQUIRED/DEV_ASSIGNEE_NOT_FOUND/NOTIFY_NOT_SENT(4类)/cached/HISTORICAL_SNAPSHOT_MISSING/NO_DINGTALK_CONFIG（stub 空配置，不深入真钉钉，同 create-chat 范式）');
  }

  // ═══ [S] codex H-1/M-1 + ultracode：手动通知后端状态闸门（终态拦截，前后端同源真闸）═══
  {
    // 已作废 bug（assigned 仍在）→ notify-developer / notify-requester 均 409 STATUS_NOT_NOTIFIABLE
    const voidedId = await bugAssigned(5, { requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    await call('POST', `/api/sys-issues/${voidedId}/void`, adminTok, { reason: '误建' });
    let r = await call('POST', `/api/sys-issues/${voidedId}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 409, '[S] 已作废 bug notify-developer → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] dev code=STATUS_NOT_NOTIFIABLE');
    r = await call('POST', `/api/sys-issues/${voidedId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 已作废 bug notify-requester → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] requester code=STATUS_NOT_NOTIFIABLE');
    // 待验证 bug notify-developer → 409（通知开发仅处理中）
    const verifyingId = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${verifyingId}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 409, '[S] 待验证 bug notify-developer → 409（仅处理中）');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 待验证 dev 409');
    // 待处理(未受理) bug notify-requester → 409（有 phone 但未受理无进展；状态闸门在 phone 校验前）
    const pendingId = await createBug({ requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    r = await call('POST', `/api/sys-issues/${pendingId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 待处理 bug notify-requester → 409（未受理无进展）');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 待处理 requester 409');
    // 已拒绝 终态 bug（待处理→issue_reject，未指派）notify-requester 有 phone → 409 STATUS_NOT_NOTIFIABLE
    const rejectedId = await createBug({ requester_dept: '财务部', requester_name: '张三', requester_phone: PHONE });
    await call('POST', `/api/sys-issues/${rejectedId}/issue-reject`, adminTok, { reason: '非缺陷' });
    r = await call('POST', `/api/sys-issues/${rejectedId}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409, '[S] 已拒绝 bug notify-requester → 409');
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[S] 已拒绝 requester STATUS_NOT_NOTIFIABLE');
    ok('[S] 后端状态闸门：终态(已作废/已拒绝)/待验证/待处理 → dev/requester 409 STATUS_NOT_NOTIFIABLE（前端镜像·后端权威真闸）');
  }

  // ═══ [G] 闸门 ═══
  {
    const noPhone = await bugAssigned(5);   // 无报障人手机号
    let r = await call('POST', `/api/sys-issues/${noPhone}/notify-requester`, adminTok);
    // 处理中态本就被 F3 收窄拒绝（先状态门后手机号门），验证顺序不误判成手机号错误
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE');
    const noPhoneVerifying = await bugToVerifying(5);   // 待验证·无手机号
    r = await call('POST', `/api/sys-issues/${noPhoneVerifying}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'NO_REQUESTER_PHONE');
    ok('[G] 闸门：处理中态优先报状态门（非手机号门）+ 待验证态无手机号 → 409 NO_REQUESTER_PHONE');
  }

  // ═══ [T] type 精判（变更流无手动端点，4 类端点全覆盖）═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'feat', system_name: 'BMS', source: '内部', requester_phone: PHONE });
    const fid = r.body.id;
    await call('POST', `/api/sys-issues/${fid}/schedule`, adminTok, {});
    await call('POST', `/api/sys-issues/${fid}/assign`, adminTok, { assigned_to: 5 });
    r = await call('POST', `/api/sys-issues/${fid}/notify-developer`, adminTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 400, '[T] feature notify-developer → 400'); assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY');
    r = await call('POST', `/api/sys-issues/${fid}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY');
    r = await call('POST', `/api/sys-issues/${fid}/notify-relay`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY');
    r = await call('POST', `/api/sys-issues/${fid}/notify-creator`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY');
    r = await call('GET', `/api/sys-issues/${fid}/notify-read-status?type=requester`, adminTok);
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_BUG_ONLY');
    ok('[T] type 精判：feature 4 类手动通知端点 + 查已读端点 → 400 MANUAL_NOTIFY_BUG_ONLY（变更流无手动端点）');
  }

  // ═══ [P] 权限 ═══
  {
    const id = await bugAssigned(5);
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, devTok, { dev_user_id: 5 });   // dev(5) 非白名单非 admin
    assert.strictEqual(r.status, 403, '[P] 非白名单非 admin notify-developer → 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_BUG_LIAISON', '[P] code=NOT_ADMIN_OR_BUG_LIAISON');
    // relay：仅 admin，白名单成员（对接人）不可发（G7 §3.1：对接人不能发 notify-relay 给自己）
    let r2 = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'relay-p', system_name: 'BMS', source: '内部', assign_mode: 'B', relay_user_id: 7 });
    const idB = r2.body.id;
    r = await call('POST', `/api/sys-issues/${idB}/notify-relay`, liaisonTok);
    assert.strictEqual(r.status, 403, '[P] 白名单对接人 notify-relay 应 403（仅 admin）');
    r = await call('POST', `/api/sys-issues/${idB}/notify-relay`, devTok);
    assert.strictEqual(r.status, 403, '[P] 普通开发 notify-relay 应 403');
    ok('[P] 权限：非白名单非 admin 手动通知开发 → 403 NOT_ADMIN_OR_BUG_LIAISON + notify-relay 仅 admin（白名单/普通开发均 403）');
  }

  // ═══ [C] ⭐变更流零回归 canary（feature/improvement 多 marker 自动派发仍生效）═══
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
    assert.strictEqual(await nStatus(fid), 'sent', '[C] ⭐feature assign 仍自动发开发（主表 notify_*）——bug 早返回未误伤变更流');
    await call('POST', `/api/sys-issues/${fid}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(await rStatus(fid), 'sent', '[C] ⭐feature estimate 仍自动发需求方');
    const featSnap = (await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [fid])).requester_notify_phone_snapshot;
    assert.strictEqual(featSnap, PHONE, '[C] feature 自动派发同样落收件人快照（共享 sendSysRequesterNotify，无 type 分叉）');
    // improvement assign→dev auto（覆盖 improvement 类型，codex M-2 点名）
    const iid = await seedChangeAssigned('improvement', 5);
    assert.strictEqual(await nStatus(iid), 'sent', '[C] improvement assign 仍自动发开发（变更流两类型均零回归）');
    // feature reassign→新开发 auto（换人 marker）
    //   ⚠️ 既有测试变更（C2：reassign body 改 member_ids+reason，见交付汇报清单）。
    const fid2 = await seedChangeAssigned('feature', 5);
    let r = await call('POST', `/api/sys-issues/${fid2}/reassign`, adminTok, { member_ids: [6], reason: '换人' });
    assert.strictEqual(r.status, 200, 'feature reassign 200');
    assert.strictEqual(await nStatus(fid2), 'sent', '[C] feature reassign 仍自动发新开发（reassign marker）');
    // feature return→dev auto（打回 marker）
    const fid3 = await seedChangeAssigned('feature', 5);
    await call('POST', `/api/sys-issues/${fid3}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${fid3}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });   // 待验证
    await call('POST', `/api/sys-issues/${fid3}/return`, adminTok, { reason: '打回' });   // 开发中
    assert.strictEqual(await nStatus(fid3), 'sent', '[C] feature return 仍自动发开发（return marker）');
    ok('[C] 变更流零回归 canary：feature+improvement × assign/estimate/reassign/return 全部仍自动派发 sent（dispatchSysNotify bug 早返回精确隔离，快照写入不分叉，publish/reopen 由 verify-sys-notify/release 覆盖）');
  }

  server.close();
  console.log(`\n✅ verify-sys-bug-notify 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-bug-notify 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
