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
//   [RelExec] 通知上线开发（release_assignee 侧）：⚠️ 2026-07-30 用户裁定，随旧上线编排家族 4 端点
//        （assign-release-dev/reassign-release-dev/notify-release-executor/notify-release-executor-batch）
//        全部封禁退场——原五类业务分支（admin 发送成功 sent / 未指定 409 / 非 admin 403 / 非待上线 409 /
//        feature 400）全部作废，改测封禁契约本身：任意角色 + 任意场景一律 409 LEGACY_RELEASE_FLOW_DISABLED，
//        零落库副作用（本文件不含批量端点 notify-release-executor-batch 的测试，批量端点的封禁契约
//        并入 verify-sys-release-orchestration.js——原专属套件 verify-sys-notify-release-batch.js
//        已随功能删除，其行为测试同随之作废）
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
// ⭐ 角色权限重构 C1：手动通知权由「bug 对接人白名单[7,13]」收敛为「admin ∨ 受理人[13]」全类型统一。
//   本文件里 liaisonTok 原是示例发布者(7)，现改为**示例对接人(13)** —— 它在各用例中扮演的是"有通知权的非 admin 角色"，
//   C1 后这个角色由受理人担任。示例发布者另起 techLeadTok，专用于"已失权"的负例断言。
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const techLeadTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);
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
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);
const PHONE = '13800000000';
const nStatus = async (id) => (await get('SELECT notify_status FROM sys_issues WHERE id=?', [id])).notify_status;
const rStatus = async (id) => (await get('SELECT requester_notify_status FROM sys_issues WHERE id=?', [id])).requester_notify_status;
const devRowStatus = async (issueId, userId) => (await get('SELECT notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL', [issueId, userId])).notify_status;

async function createBug(extra = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });
  assert.strictEqual(r.status, 201, '建 bug 201 ' + JSON.stringify(r.body));
  // ⭐ 角色权限重构 C0：建单恒落「待受理」→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, adminTok, {});
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
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
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
    // ⭐ C1：受理人(13) 能手动通知开发；示例发布者(7) 不再能（转纯技术负责人）
    const id2 = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${id2}/notify-developer`, liaisonTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 200, `[Md] ⭐ 受理人(13) notify-developer 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await devRowStatus(id2, 5), 'sent', '[Md] 受理人触发也落子表 sent');
    const id2b = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${id2b}/notify-developer`, techLeadTok, { dev_user_id: 5 });
    assert.strictEqual(r.status, 403, `[Md] ⭐ 示例发布者(7) notify-developer 应 403（C1 失去通知权）, got ${r.status} ${JSON.stringify(r.body)}`);
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
    // ⭐ 角色权限重构 C0：path B（建单即指定通知对接人）**结构性关闭** —— 受理门恒开 ⟹ 400。
    //   ⚠️ 连带事实（C0 编码期发现·已回写方案 v1.5）：path B 是 `relay_notified_user_id` 的**唯一业务写入路径**，
    //     关闭后该列在新单上永不写值 → notify-relay 端点在 C0 后只服务历史单（生产零单据 ⟹ 实质不可达）。
    //     本方案 §2.7 判定 relay 属"低危·保持不动"，故端点与其防御纵深**保留**，此处继续回归其行为，
    //     夹具改用 DB 直接置列（沿用本文件既有范式，见下方"白名单外脏数据"用例）。端点是否随 C1/C5 退场另议。
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'relay-a', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'B', relay_user_id: 7 });
    assert.strictEqual(r.status, 400, '[Relay] C0：path B 建单应 400 ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', '[Relay] C0：path B code=INTAKE_WITH_ASSIGN_CONFLICT');

    // 夹具：建单 → 受理（→待处理）→ DB 置 relay 目标（等价于旧 path B 的落库结果）
    const idA = await createBug();
    await run(`UPDATE sys_issues SET relay_notified_user_id=7, relay_notified_user_name='示例发布者' WHERE id=?`, [idA]);
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
    const idB = await createBug();   // C0：path B 已关闭，改 DB 置 relay 目标（同上）
    await run(`UPDATE sys_issues SET relay_notified_user_id=13, relay_notified_user_name='示例对接人', status='处理中', assigned_to=5, assigned_to_name='开发王' WHERE id=?`, [idB]);
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
    // C2a·H3 修正：主开发本人（devTok）现在 → 403（删「主开发本人」放权·is_primary 禁作授权源，与去主次一致）
    //   ⚠️ C1 复审 MED-1：本端点补挂 requireIntakeLiaison 后，403 由**中间件层**发出，code 随之从
    //     NOT_AUTHORIZED_FOR_NOTIFY（handler guard）变为 NOT_ADMIN_OR_INTAKE_LIAISON（中间件），
    //     与 notify-developer / notify-requester 两通道口径一致（它们本就有中间件）。放行面完全不变。
    r = await call('POST', `/api/sys-issues/${id}/notify-creator`, devTok);
    assert.strictEqual(r.status, 403, '[Creator·H3] 主开发本人触发 → 403（不再放权）');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', '[Creator·H3] code=NOT_ADMIN_OR_INTAKE_LIAISON（C1 复审补挂中间件后由中间件层拒）');
    assert.strictEqual((await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id])).creator_notify_status, 'not_sent', '[Creator·H3] 主开发被拒后 creator_notify_status 仍 not_sent');
    // 受理人[13] 触发 → 能发（C1 起 creator 通道 = 全类型 admin∨受理人）
    const id2 = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${id2}/notify-creator`, liaisonTok);
    assert.strictEqual(r.status, 200, '[Creator] 受理人(13) 触发 200');
    assert.strictEqual(r.body.creator_notify_status, 'sent', '[Creator] 受理人触发 → sent');
    // 未授权（dev2 非受理人/非 admin）→ 403（同上：C1 复审后由中间件层拒）
    const id3 = await bugToVerifying(5);
    r = await call('POST', `/api/sys-issues/${id3}/notify-creator`, dev2Tok);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON');
    // 状态门：处理中态不可通知建单人（sendable={待验证,待上线,已上线}）——用受理人触发（过授权、卡状态门）
    const idMid = await bugAssigned(5);
    r = await call('POST', `/api/sys-issues/${idMid}/notify-creator`, liaisonTok);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE');
    ok('[Creator] 通知建单人：admin(=created_by) self-guard skipped + 受理人实发 sent + 主开发本人 403(H3删·中间件层) + 未授权 403 + 状态门 409');
  }

  // ═══ [RelExec·封禁契约] 通知上线开发（release_assignee 侧）═══
  //   ⚠️ 2026-07-30 用户裁定：旧上线编排家族 4 端点全封退场，notify-release-executor 单条端点在此列。
  //   原"admin 发送成功 sent / 未指定 409 NO_RELEASE_ASSIGNEE_TO_NOTIFY / 非 admin 403 / 非待上线 409
  //   STATUS_NOT_NOTIFIABLE / feature 400 MANUAL_NOTIFY_BUG_ONLY"五类业务分支全部随端点封禁作废——
  //   封禁闸门置于一切业务判定之前，不再有分支，只剩一种行为：任意已登录角色 + 任意场景一律 409
  //   LEGACY_RELEASE_FLOW_DISABLED，零落库副作用。改测封禁契约本身。
  {
    // 造一条「待上线」+ 已指定 release_assignee(6) 的单——即便 body/状态本该走通旧业务逻辑（这条单
    // 若在封禁前调用会 200 sent），封禁闸门也须在一切判定之前先拦下。
    const id = await bugToPrereleaseWithExecutor(5, 6);
    const before = await get('SELECT release_assignee_id, release_assignee_name, release_assignee_notify_status FROM sys_issues WHERE id=?', [id]);

    // admin 合法调用（封禁前本该 200 sent 的场景）→ 409
    let r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 409, `[RelExec·封禁契约] admin 合法调用应 409（旧上线编排家族全封）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[RelExec·封禁契约] admin code=LEGACY_RELEASE_FLOW_DISABLED');

    // 非 admin（主开发）→ 同样 409 同 code（证明不是走到旧的"仅 admin"403，而是端点级封禁，requireAdmin 已摘）
    r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, devTok);
    assert.strictEqual(r.status, 409, `[RelExec·封禁契约] 主开发调用应 409（非 403）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[RelExec·封禁契约] 主开发 code=LEGACY_RELEASE_FLOW_DISABLED');

    // feature 单（封禁前本该 400 MANUAL_NOTIFY_BUG_ONLY 的场景）→ 同样 409（封禁在类型校验之前）
    const rf = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'feat-relexec', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    r = await call('POST', `/api/sys-issues/${rf.body.id}/notify-release-executor`, adminTok);
    assert.strictEqual(r.status, 409, `[RelExec·封禁契约] feature 单也应 409（封禁在类型校验之前）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[RelExec·封禁契约] feature code=LEGACY_RELEASE_FLOW_DISABLED');

    // 零落库副作用：反复调用后 release_assignee 三列纹丝不动
    const after = await get('SELECT release_assignee_id, release_assignee_name, release_assignee_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.deepStrictEqual(after, before, '[RelExec·封禁契约] 反复调用后 release_assignee_id/_name/notify_status 一列未动（零副作用）');

    ok('[RelExec·封禁契约] notify-release-executor 全封：admin/主开发一律 409 LEGACY_RELEASE_FLOW_DISABLED + feature 单同样 409（封禁在类型校验前）+ 零落库副作用');
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

  // ═══ [T] 交互优化 C2a：变更流手动端点放开 + 精确断言（codex H1/M3：不用"200或409"兼容，逐格精确）═══
  //   建变更流单并推到「待验证」（此态 developer/creator/requester 三通道均在白名单，便于一处覆盖 3 通道成功）：
  //   建单→schedule→assign(dev6)→estimate(dev6)→submit(no_code)→到待验证。
  const seedChangeToVerifying = async (type, extra = {}) => {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: type + '-t', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, requester_phone: PHONE, ...extra });
    const cid = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：本 seed 专服务**变更流**（feature/improvement）→ 建单直落「待受理」，
  //   无需再走预沟通段，直接接既有受理一步。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${cid}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${cid}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
    r = await call('POST', `/api/sys-issues/${cid}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(r.status, 200, `${type} 夹具补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await call('POST', `/api/sys-issues/${cid}/assign`, adminTok, { assigned_to: 6 });
    await call('POST', `/api/sys-issues/${cid}/estimate`, dev2Tok, { dev_estimated_at: EST });   // dev6=dev2Tok 回填
    await call('POST', `/api/sys-issues/${cid}/submit`, dev2Tok, { mode: 'no_code', no_code_reason: '交付（占位）' });   // →待验证
    return cid;
  };
  // 表驱动：feature/improvement × 通道 × (admin 放行 / 对接人拒绝) 逐格
  for (const type of ['feature', 'improvement']) {
    const vid = await seedChangeToVerifying(type);
    // developer：待验证在变更流 dev 白名单（开发中/待验证）——admin 发 dev6（非自己）→ 200 sent
    let r = await call('POST', `/api/sys-issues/${vid}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, `[T] ${type} developer admin 放行 200 ` + JSON.stringify(r.body));
    assert.strictEqual(await devRowStatus(vid, 6), 'sent', `[T] ${type} developer 落子表 sent`);
    // ⭐ C1：变更流通知**放开给受理人**（原「变更流仅 admin」特判已删）——受理人 200 / 技术负责人 403
    r = await call('POST', `/api/sys-issues/${vid}/notify-developer`, liaisonTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, `[T] ⭐ ${type} developer 受理人(13) → 200（C1 全类型统一）, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${vid}/notify-developer`, techLeadTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 403, `[T] ⭐ ${type} developer 示例发布者(7) → 403（转纯技术负责人）`);
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', `[T] ${type} developer 示例发布者被中间件拒`);
    // creator：admin=created_by → self-guard skipped 200 + creator_notify_status 仍 not_sent
    r = await call('POST', `/api/sys-issues/${vid}/notify-creator`, adminTok);
    assert.strictEqual(r.status, 200, `[T] ${type} creator admin self-guard 200`);
    assert.strictEqual(r.body.code, 'SELF_NOTIFY_SKIPPED', `[T] ${type} creator self-guard skipped`);
    assert.strictEqual((await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [vid])).creator_notify_status, 'not_sent', `[T] ${type} creator self-guard 不写状态`);
    // ⭐ C1：creator 通道变更流同样放开给受理人
    r = await call('POST', `/api/sys-issues/${vid}/notify-creator`, liaisonTok);
    assert.strictEqual(r.status, 200, `[T] ⭐ ${type} creator 受理人(13) → 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${vid}/notify-creator`, techLeadTok);
    assert.strictEqual(r.status, 403, `[T] ⭐ ${type} creator 示例发布者(7) → 403`);
    // requester：admin 发（待验证在 requester 白名单 + 有 phone）→ 200 sent + 落快照
    r = await call('POST', `/api/sys-issues/${vid}/notify-requester`, adminTok);
    assert.strictEqual(r.status, 200, `[T] ${type} requester admin 放行 200 ` + JSON.stringify(r.body));
    assert.strictEqual((await get('SELECT requester_notify_status FROM sys_issues WHERE id=?', [vid])).requester_notify_status, 'sent', `[T] ${type} requester sent`);
    assert.strictEqual((await get('SELECT requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [vid])).requester_notify_phone_snapshot, PHONE, `[T] ${type} requester 落快照`);
    // ⭐ C1：requester 通道变更流同样放开给受理人
    r = await call('POST', `/api/sys-issues/${vid}/notify-requester`, liaisonTok);
    assert.strictEqual(r.status, 200, `[T] ⭐ ${type} requester 受理人(13) → 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${vid}/notify-requester`, techLeadTok);
    assert.strictEqual(r.status, 403, `[T] ⭐ ${type} requester 示例发布者(7) → 403`);
    // relay：变更流无对接人通道 → 400 CHANNEL_NA（admin 也拒）
    r = await call('POST', `/api/sys-issues/${vid}/notify-relay`, adminTok);
    assert.strictEqual(r.body.code, 'MANUAL_NOTIFY_CHANNEL_NA', `[T] ${type} relay → CHANNEL_NA`);
    // 查已读（channel 级授权，codex M2）：admin 查 creator 通道 → 非 403；对接人查 → 403（变更流仅 admin）
    r = await call('GET', `/api/sys-issues/${vid}/notify-read-status?type=creator`, adminTok);
    assert.notStrictEqual(r.status, 403, `[T] ${type} 查已读 admin 放行`);
    // ⭐ C1：查已读走同一 sysManualNotifyGuard，受理人放行、示例发布者拒
    r = await call('GET', `/api/sys-issues/${vid}/notify-read-status?type=creator`, liaisonTok);
    assert.notStrictEqual(r.status, 403, `[T] ⭐ ${type} 查已读受理人(13) 放行（写读同源）`);
    r = await call('GET', `/api/sys-issues/${vid}/notify-read-status?type=creator`, techLeadTok);
    assert.strictEqual(r.status, 403, `[T] ⭐ ${type} 查已读示例发布者(7) → 403`);
  }
  // 状态门：变更流 developer 在「开发中」允许、在终态拒绝（相邻状态精确覆盖·codex M3）
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'feat-st', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const fid = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段，直接受理。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${fid}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${fid}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
    r = await call('POST', `/api/sys-issues/${fid}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(r.status, 200, `[T] 夹具补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await call('POST', `/api/sys-issues/${fid}/assign`, adminTok, { assigned_to: 6 });   // 开发中
    r = await call('POST', `/api/sys-issues/${fid}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, '[T] feature developer 开发中态放行 200');   // 开发中 ∈ 变更流 dev 白名单
    // creator 在「开发中」：admin=created_by → self-guard 优先于状态门（授权/自指先于状态检查）→ 200 skipped。
    //   注：变更流 creator 状态门无法用现有角色单独触发（admin 恒 self-guard skip / 对接人对变更流 403），
    //   故此处验证的是"self-guard 优先"这一实际顺序，非状态门本身（bug creator 状态门已由 [Creator] 块覆盖）。
    r = await call('POST', `/api/sys-issues/${fid}/notify-creator`, adminTok);
    assert.strictEqual(r.status, 200, '[T] feature creator 开发中 admin → self-guard 200（优先于状态门）');
    assert.strictEqual(r.body.code, 'SELF_NOTIFY_SKIPPED', '[T] feature creator self-guard skipped');
  }
  ok('[T] C2a 表驱动：feature+improvement × developer/creator/requester × admin放行(精确 sent/skipped/快照)+对接人403 · relay=CHANNEL_NA · 查已读channel级 · 状态门相邻覆盖');

  // ═══ [SG] C2a·codex M1：自指守卫顺序——先查活动成员行，再判自指 ═══
  //   伪造/非成员的"自己 ID" → 应先归 DEV_ASSIGNEE_NOT_FOUND（非 SELF_NOTIFY_FORBIDDEN）；在册成员发自己 → SELF_NOTIFY_FORBIDDEN。
  {
    // bug 单，dev5 在册。用 devTok(id5) 发给自己(dev_user_id=5)——在册 → SELF_NOTIFY_FORBIDDEN
    //   （但 dev 非 admin/对接人，会先被 sysManualNotifyGuard developer 通道 403 挡在自指之前）——故改用 admin 发给"admin 自己"验顺序：
    //   admin(id1) 非本单成员，发 dev_user_id=1 → 应 DEV_ASSIGNEE_NOT_FOUND（顺序正确：先查活动行、admin 不在册）。
    const id = await bugAssigned(5);   // 处理中，dev5 在册；admin 有权（bug developer=admin∨对接人）
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, adminTok, { dev_user_id: 1 });   // admin 自己非本单成员
    assert.strictEqual(r.status, 409, '[SG] admin 发非成员的自己 → 先查活动行 → 409（非自指）');
    assert.strictEqual(r.body.code, 'DEV_ASSIGNEE_NOT_FOUND', '[SG] 顺序正确：DEV_ASSIGNEE_NOT_FOUND 优先于自指');
    // 构造"在册成员发自己"：把 admin(id1) 加为本单在册开发，再 admin 发给自己 → SELF_NOTIFY_FORBIDDEN
    const id2 = await bugAssignedWithCollab(5, [1]);   // dev5 主 + admin(1) 协作，均在册·处理中
    r = await call('POST', `/api/sys-issues/${id2}/notify-developer`, adminTok, { dev_user_id: 1 });
    assert.strictEqual(r.status, 403, '[SG] admin 在册后发给自己 → 403');
    assert.strictEqual(r.body.code, 'SELF_NOTIFY_FORBIDDEN', '[SG] 在册自己 → SELF_NOTIFY_FORBIDDEN');
    ok('[SG] C2a 自指守卫顺序：非成员自己→DEV_ASSIGNEE_NOT_FOUND（先查活动行）· 在册自己→SELF_NOTIFY_FORBIDDEN');
  }

  // ═══ [P] 权限 ═══
  {
    const id = await bugAssigned(5);
    let r = await call('POST', `/api/sys-issues/${id}/notify-developer`, devTok, { dev_user_id: 5 });   // dev(5) 非白名单非 admin
    assert.strictEqual(r.status, 403, '[P] 非白名单非 admin notify-developer → 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', '[P] code=NOT_ADMIN_OR_INTAKE_LIAISON');
    // relay：仅 admin，白名单成员（对接人）不可发（G7 §3.1：对接人不能发 notify-relay 给自己）
    let r2 = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'relay-p', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'B', relay_user_id: 7 });
    const idB = r2.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${idB}/intake-accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${idB}/notify-relay`, liaisonTok);
    assert.strictEqual(r.status, 403, '[P] 白名单对接人 notify-relay 应 403（仅 admin）');
    r = await call('POST', `/api/sys-issues/${idB}/notify-relay`, devTok);
    assert.strictEqual(r.status, 403, '[P] 普通开发 notify-relay 应 403');
    ok('[P] 权限：非白名单非 admin 手动通知开发 → 403 NOT_ADMIN_OR_INTAKE_LIAISON + notify-relay 仅 admin（白名单/普通开发均 403）');
  }

  // ═══ [C] 交互优化 C2a：变更流通知已全手动 canary（feature/improvement 不再自动派发）═══
  //   ⚠️ 语义反转（C2a）：原断言"变更流仍自动发 sent"，现 isAutoNotifyEnabled 恒 false → 全 type 不自动派发，
  //   变更流 assign/estimate/reassign/return 后 notify_status/requester_notify_status 保持 not_sent（改由通知区手动触发）。
  const seedChangeAssigned = async (type, devId, extra = {}) => {
    const rr = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: type + '-canary', system_name: 'BMS', source: '业务方', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });
    const cid = rr.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：本 seed 专服务**变更流**（feature/improvement）→ 建单直落「待受理」，
  //   无需再走预沟通段。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${cid}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${cid}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
    const oa = await call('POST', `/api/sys-issues/${cid}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(oa.status, 200, `${type} 夹具补 OA 号 200, got ${oa.status} ${JSON.stringify(oa.body)}`);
    await call('POST', `/api/sys-issues/${cid}/assign`, adminTok, { assigned_to: devId });   // 开发中
    return cid;
  };
  {
    // feature assign→dev 不再 auto + estimate→requester 不再 auto
    const fid = await seedChangeAssigned('feature', 5, { requester_dept: '市场部', requester_name: '李四', requester_phone: PHONE });
    assert.strictEqual(await nStatus(fid), 'not_sent', '[C] ⭐feature assign 不再自动发开发（C2a 全手动）');
    await call('POST', `/api/sys-issues/${fid}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(await rStatus(fid), 'not_sent', '[C] ⭐feature estimate 不再自动发需求方（C2a 全手动）');
    // improvement assign→dev 不再 auto
    const iid = await seedChangeAssigned('improvement', 5);
    assert.strictEqual(await nStatus(iid), 'not_sent', '[C] improvement assign 不再自动发开发（变更流两类型均全手动）');
    // feature reassign→新开发 不再 auto（reassign body = member_ids+reason）
    const fid2 = await seedChangeAssigned('feature', 5);
    let r = await call('POST', `/api/sys-issues/${fid2}/reassign`, adminTok, { member_ids: [6], reason: '换人' });
    assert.strictEqual(r.status, 200, 'feature reassign 200');
    assert.strictEqual(await nStatus(fid2), 'not_sent', '[C] feature reassign 不再自动发新开发（C2a 全手动）');
    // feature return→dev 不再 auto
    const fid3 = await seedChangeAssigned('feature', 5);
    await call('POST', `/api/sys-issues/${fid3}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${fid3}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });   // 待验证
    await call('POST', `/api/sys-issues/${fid3}/return`, adminTok, { reason: '打回' });   // 开发中
    assert.strictEqual(await nStatus(fid3), 'not_sent', '[C] feature return 不再自动发开发（C2a 全手动）');
    ok('[C] C2a 全手动 canary：feature+improvement × assign/estimate/reassign/return 全部 not_sent（isAutoNotifyEnabled 恒 false·改手动触发）');
  }

  server.close();
  console.log(`\n✅ verify-sys-bug-notify 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-bug-notify 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
