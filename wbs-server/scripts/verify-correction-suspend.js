// verify-correction-suspend.js — 数据修正暂缓功能 verify（暂缓与列表导出方案 v1.1 §2.5.3，编码任务 S1 批次 1）
//   范式对齐 verify-correction-reassign-e2e.js（router-mount + in-memory db + http.request HTTP harness，
//   走真实端点非复刻）与 verify-correction-rework-transition.js（真并发 Promise.all 竞态断言）。
// 覆盖 7 组断言（方案 §2.5.3）：
//   ① 转移合法性：两入口成功 / PENDING_ASSIGN·FIXED·REFIXED 暂缓被拒（确切 400 INVALID_TRANSITION）/
//      三出口成功（恢复/行政闭环/作废）/ 端到端恢复后重报预计→IN_PROGRESS→FIXED 全流程走通（层内绿≠功能可用）
//   ② 路径隔离（反向对照组）：SUSPENDED 单走 /assign → 409；/resume 对非暂缓单 → 409；恢复不碰 assigned_to/
//      assigned_at；指派不清空 dev_estimated_at；并发双 /resume 恰一次成功
//   ③ 权限：assignee 可暂缓 / creator 暂缓 403 / creator 可恢复 / 无关用户恢复 403 / admin 双向可
//   ④ 理由：空串/纯空白暂缓 → 400 SUSPEND_REASON_REQUIRED；恢复不带 note 成功
//   ⑤ 恢复语义：dev_estimated_at 清空（哨兵值验证，禁 NULL 对 NULL 假绿）；expected_deadline 传新值/不传/非法/过去时间；
//      suspended_at 恢复后保留非空
//   ⑥ history：暂缓+恢复各一行（from/to/reason/operator 逐列）；重复暂缓两轮→4 行新增、suspended_at 变化
//   ⑦ 迁移：suspended_at 列存在；runCorrectionMigration 重跑幂等；老库快照（无该列）迁移后列出现
// 用法：node scripts/verify-correction-suspend.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-suspend-uploads-' + process.pid);
fs.mkdirSync(TMP_UPLOAD, { recursive: true });

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};
const an = async () => ({});

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: (req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ error: 'no test user' });
    try { req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return next(); } catch (e) { return res.status(401).json({ error: 'bad test user' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' }),
  requirePublisherOrAdmin: (req, res, next) => (req.user && ['admin', 'publisher'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'pub/admin only' }),
  sendIssueDingtalkRaw: an,
  UPLOAD_DIR: TMP_UPLOAD,
  readSystemConfig: an,
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: an,
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),
  safeDeleteFileSync: (rel) => { try { fs.unlinkSync(path.join(TMP_UPLOAD, rel)); } catch (_) {} },
  maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

// 用户：admin(1) / 开发甲5（多数用例的 assignee）/ 开发乙6（改派目标/非本单开发）/ 建单人X10 / 路人99
const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const DEV_A = { id: 5, username: 'devA', display_name: '开发甲', role: 'user' };
const DEV_B = { id: 6, username: 'devB', display_name: '开发乙', role: 'user' };
const CREATOR_X = { id: 10, username: 'creatorX', display_name: '建单人X', role: 'user' };
const STRANGER = { id: 99, username: 'stranger', display_name: '路人', role: 'user' };
const PUBLISHER_P = { id: 20, username: 'pubP', display_name: '发布者P', role: 'publisher' };

function reqJson(method, p, body, user) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, method, path: p,
      headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}

// 直接 INSERT 一行 correction（精确控制 status/assigned_to/expected_deadline/dev_estimated_at/suspended_at 等哨兵值）
let SEQ = 1000;
async function seedCorrection({ status, assignedTo = null, assignedName = null, createdBy = 1, expectedDeadline = null, devEstimatedAt = null, suspendedAt = null, dingtalkChatId = null, correctionType = 'single' } = {}) {
  const id = ++SEQ;
  await dbRunAsync(
    `INSERT INTO correction_requests
       (id, source_system, location_info, requester_name, status, correction_type, created_by,
        assigned_to, assigned_to_name, expected_deadline, dev_estimated_at, suspended_at, dingtalk_chat_id)
     VALUES (?, 'BMS', '暂缓测试', '业务方', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, status, correctionType, createdBy, assignedTo, assignedName, expectedDeadline, devEstimatedAt, suspendedAt, dingtalkChatId]
  );
  return id;
}

let PORT, srv;
async function waitReady(timeoutMs = 3000) {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) {
    if (I.CORRECTION_SCHEMA_STATE.error) throw new Error('schema error: ' + I.CORRECTION_SCHEMA_STATE.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('readiness timeout');
    await new Promise(r => setTimeout(r, 30));
  }
}

(async () => {
  console.log('=== 数据修正暂缓功能 verify（暂缓与列表导出方案 v1.1 §2.5.3）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role) VALUES
    (1,'admin','管理员','admin'),(5,'devA','开发甲','user'),(6,'devB','开发乙','user'),
    (10,'creatorX','建单人X','user'),(99,'stranger','路人','user'),(50,'viewer50','查看者50','viewer'),
    (20,'pubP','发布者P','publisher')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ══════════════════ ① 转移合法性 ══════════════════
  console.log('— ① 转移合法性 —');
  const g1a = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  const r1a = await reqJson('POST', `/api/corrections/${g1a}/suspend`, { reason: '业务源单据尚未闭环' }, DEV_A);
  ok(r1a.status === 200 && r1a.body.status === 'SUSPENDED', `①a ASSIGNED_PENDING_ESTIMATE→SUSPENDED 成功（#${g1a}）`);

  const g1b = await seedCorrection({ status: 'IN_PROGRESS', assignedTo: 5, assignedName: '开发甲', devEstimatedAt: '2026-06-20 12:00:00' });
  const r1b = await reqJson('POST', `/api/corrections/${g1b}/suspend`, { reason: '客户未确认修正范围' }, DEV_A);
  ok(r1b.status === 200 && r1b.body.status === 'SUSPENDED', `①b IN_PROGRESS→SUSPENDED 成功（#${g1b}）`);

  const g1c = await seedCorrection({ status: 'PENDING_ASSIGN' });
  const r1c = await reqJson('POST', `/api/corrections/${g1c}/suspend`, { reason: 'x' }, ADMIN);
  ok(r1c.status === 400 && r1c.body.code === 'INVALID_TRANSITION', `①c PENDING_ASSIGN→SUSPENDED 被拒 400 INVALID_TRANSITION`);

  const g1d = await seedCorrection({ status: 'FIXED' });
  const r1d = await reqJson('POST', `/api/corrections/${g1d}/suspend`, { reason: 'x' }, ADMIN);
  ok(r1d.status === 400 && r1d.body.code === 'INVALID_TRANSITION', `①d FIXED→SUSPENDED 被拒 400 INVALID_TRANSITION`);

  const g1e = await seedCorrection({ status: 'REFIXED' });
  const r1e = await reqJson('POST', `/api/corrections/${g1e}/suspend`, { reason: 'x' }, ADMIN);
  ok(r1e.status === 400 && r1e.body.code === 'INVALID_TRANSITION', `①e REFIXED→SUSPENDED 被拒 400 INVALID_TRANSITION`);

  const g1f1 = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r1f1 = await reqJson('POST', `/api/corrections/${g1f1}/resume`, {}, DEV_A);
  ok(r1f1.status === 200 && r1f1.body.status === 'ASSIGNED_PENDING_ESTIMATE', `①f1 SUSPENDED→恢复 ASSIGNED_PENDING_ESTIMATE 成功`);

  const g1f2 = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r1f2 = await reqJson('POST', `/api/corrections/${g1f2}/admin-close`, { closure_reason: '业务方长期未反馈，行政收口暂缓单' }, ADMIN);
  ok(r1f2.status === 200 && r1f2.body.status === 'ARCHIVED', `①f2 SUSPENDED→ARCHIVED（行政闭环）成功`);

  const g1f3 = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', createdBy: 10 });
  const r1f3 = await reqJson('POST', `/api/corrections/${g1f3}/void`, { void_reason: '暂缓单确认作废' }, CREATOR_X);
  ok(r1f3.status === 200 && r1f3.body.status === 'VOIDED', `①f3 SUSPENDED→VOIDED（作废）成功`);

  const g1g = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r1g1 = await reqJson('POST', `/api/corrections/${g1g}/resume`, {}, DEV_A);
  ok(r1g1.status === 200, `①g1 端到端起点：恢复成功`);
  const r1g2 = await reqJson('POST', `/api/corrections/${g1g}/reply-estimate`, { dev_estimated_at: '2026-09-01 10:00' }, DEV_A);
  ok(r1g2.status === 200 && r1g2.body.status === 'IN_PROGRESS', `①g2 恢复后重报预计 → IN_PROGRESS 成功`);
  await I.correctionTransition(g1g, 'IN_PROGRESS', 'FIXED', { id: 5, name: '开发甲', role: 'user' }, { batch_completion_note: '业务已闭环，完成修正' });
  const rowG1g = await dbGetAsync('SELECT status FROM correction_requests WHERE id=?', [g1g]);
  ok(rowG1g.status === 'FIXED', `①g3 端到端：恢复后重报预计→IN_PROGRESS→FIXED 全流程走通（层内绿≠功能可用）`);

  // ①h codex 437 MED-1 防御存在性断言（真行为断言，非静态扫描）：业务闸门指派 else 分支只接受 PENDING_ASSIGN 源态——
  //   临时 monkey-patch I.CORRECTION_STATUS_TRANSITIONS（工厂闭包内同一对象引用，非复刻）模拟"未来新增第三条入边"
  //   （REJECTED→ASSIGNED_PENDING_ESTIMATE），验证防御行确切拦截为 400 UNSUPPORTED_TRANSITION，且不误当"指派"
  //   静默写 assigned_to（前置非空哨兵，禁假绿）。finally 复原，防污染后续用例。
  const g1h = await seedCorrection({ status: 'REJECTED', assignedTo: 5, assignedName: '开发甲' });
  const before1h = await dbGetAsync('SELECT assigned_to, assigned_to_name FROM correction_requests WHERE id=?', [g1h]);
  ok(before1h.assigned_to === 5, `①h 前置哨兵：assigned_to 非空（=5，防 NULL 对 NULL 假绿）`);
  const origRejectedTransitions = I.CORRECTION_STATUS_TRANSITIONS.REJECTED;
  I.CORRECTION_STATUS_TRANSITIONS.REJECTED = [...origRejectedTransitions, 'ASSIGNED_PENDING_ESTIMATE'];
  let g1hErr = null;
  try {
    await I.correctionTransition(g1h, 'REJECTED', 'ASSIGNED_PENDING_ESTIMATE', { id: 1, name: '管理员', role: 'admin' },
      { assigned_to: 6, assigned_to_name: '开发乙', assigned_by: 1 });
  } catch (e) {
    g1hErr = e;
  } finally {
    I.CORRECTION_STATUS_TRANSITIONS.REJECTED = origRejectedTransitions;
  }
  ok(!!g1hErr && g1hErr.httpStatus === 400 && g1hErr.code === 'UNSUPPORTED_TRANSITION',
    `①h MED-1 防御：模拟未来新增入边（REJECTED→ASSIGNED_PENDING_ESTIMATE）确切被拦 400 UNSUPPORTED_TRANSITION（实得 status=${g1hErr ? g1hErr.httpStatus : '?'} code=${g1hErr ? g1hErr.code : '?'}）`);
  const after1h = await dbGetAsync('SELECT assigned_to, assigned_to_name, status FROM correction_requests WHERE id=?', [g1h]);
  ok(after1h.assigned_to === before1h.assigned_to && after1h.assigned_to_name === before1h.assigned_to_name && after1h.status === 'REJECTED',
    `①h 防御拦截后 assigned_to/assigned_to_name/status 均未被静默改写（未误当指派语义写入，哨兵前后对拍）`);

  // ══════════════════ ② 路径隔离（反向对照组）══════════════════
  console.log('— ② 路径隔离 —');
  const g2a = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r2a = await reqJson('POST', `/api/corrections/${g2a}/assign`, { assigned_to: 6 }, ADMIN);
  ok(r2a.status === 409 && r2a.body.code === 'CONCURRENT_STATE_CHANGE', `②a SUSPENDED 单走 /assign → 409 CONCURRENT_STATE_CHANGE（不会误触恢复分支）`);

  // /resume 反向隔离用 PENDING_ASSIGN 单（唯一在流转表里对 ASSIGNED_PENDING_ESTIMATE 合法的非 SUSPENDED 源态——
  //   合法性检查先于 expectedFromStatus 比对，用 IN_PROGRESS/FIXED 等态会先被 INVALID_TRANSITION 拦截，测不到 409 分支）
  const g2b = await seedCorrection({ status: 'PENDING_ASSIGN' });
  const r2b = await reqJson('POST', `/api/corrections/${g2b}/resume`, {}, ADMIN);
  ok(r2b.status === 409 && r2b.body.code === 'CONCURRENT_STATE_CHANGE', `②b /resume 对非暂缓单（PENDING_ASSIGN）→ 409 CONCURRENT_STATE_CHANGE`);

  const g2c = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  await dbRunAsync(`UPDATE correction_requests SET assigned_at='2026-05-01 09:00:00' WHERE id=?`, [g2c]);
  const before2c = await dbGetAsync('SELECT assigned_to, assigned_to_name, assigned_at FROM correction_requests WHERE id=?', [g2c]);
  const r2c = await reqJson('POST', `/api/corrections/${g2c}/resume`, {}, DEV_A);
  ok(r2c.status === 200, `②c 恢复成功`);
  const after2c = await dbGetAsync('SELECT assigned_to, assigned_to_name, assigned_at FROM correction_requests WHERE id=?', [g2c]);
  ok(before2c.assigned_to === after2c.assigned_to && before2c.assigned_to_name === after2c.assigned_to_name && before2c.assigned_at === after2c.assigned_at,
    `②c 恢复前后 assigned_to/assigned_to_name/assigned_at 逐字段相等（恢复不碰指派面，§2.4b）`);

  const g2d = await seedCorrection({ status: 'PENDING_ASSIGN', devEstimatedAt: '2026-04-01 08:00:00' });
  const before2d = await dbGetAsync('SELECT dev_estimated_at FROM correction_requests WHERE id=?', [g2d]);
  const r2d = await reqJson('POST', `/api/corrections/${g2d}/assign`, { assigned_to: 6 }, ADMIN);
  ok(r2d.status === 200, `②d 指派成功`);
  const after2d = await dbGetAsync('SELECT dev_estimated_at FROM correction_requests WHERE id=?', [g2d]);
  ok(before2d.dev_estimated_at === after2d.dev_estimated_at && after2d.dev_estimated_at === '2026-04-01 08:00:00',
    `②d 指派前后 dev_estimated_at 不变（指派分支不含清空逻辑，与恢复分支写入面物理隔离，§2.4b）`);

  const g2e = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const [e2eA, e2eB] = await Promise.all([
    reqJson('POST', `/api/corrections/${g2e}/resume`, { note: '并发A' }, DEV_A),
    reqJson('POST', `/api/corrections/${g2e}/resume`, { note: '并发B' }, DEV_A),
  ]);
  const e2eSucc = [e2eA, e2eB].filter(r => r.status === 200).length;
  ok(e2eSucc === 1, `②e 并发双 /resume（Promise.all 真并发两连发）→ 恰 1 个 200`);
  const e2eLoser = [e2eA, e2eB].find(r => r.status !== 200);
  // 败者有三种【设计内】结局，取决于其读到 fromStatus 的时机（实测三种均已复现，非猜测）：
  //   ① 409 CONCURRENT_STATE_CHANGE——败者事务内 SELECT 早于胜者 UPDATE 提交，读到 fromStatus='SUSPENDED'（与
  //      expectedFromStatus 一致）过流转合法性+比对，但落库时双条件 WHERE 已被胜者改状态命中 0 行 → changes!==1 抛 409。
  //   ② 400 INVALID_TRANSITION——败者 SELECT 晚于胜者整个事务（BEGIN..COMMIT）完成，读到 fromStatus 已是
  //      'ASSIGNED_PENDING_ESTIMATE'；该态到自身不在 CORRECTION_STATUS_TRANSITIONS 表内（无自环），
  //      流转合法性检查【先于】expectedFromStatus 比对，故直接 400，而非 409（真实跑通过，非笔误）。
  //   ③ 500——同 verify-correction-rework-transition.js「J 真并发竞态」先例：本项目单连接无 mutex，两个几乎同时
  //      发出的 BEGIN IMMEDIATE 仍可能触发 'transaction within a transaction'（系统性、非本批引入，对抗审已定性）。
  //      codex 437 HIGH：禁止接受"任意 500 内容"黑盒判据。500 的真实响应形态锁定自
  //      sendCorrectionTransitionError 非 CorrectionTransitionError 兜底分支（corrections.js 约 :2491-2495）：
  //      `res.status(500).json({ error: e.message })`——固定无 code 字段。本地 3 次真实并发复测（TEMP 调试打印
  //      JSON.stringify(e2eLoser) 后已移除）文案完全一致：
  //      {"status":500,"body":{"error":"SQLITE_ERROR: cannot start a transaction within a transaction"}}
  //      SQLITE_BUSY/database is locked 属同族"单连接嵌套/争用"错误未在本次窗口复现，但保留同一 family 正则
  //      兜底（非本批引入的系统性并发面已知会走该族），拒绝匹配以外的任意 500 内容。
  const SQLITE_NESTED_TX_RE = /cannot start a transaction within a transaction|SQLITE_BUSY|database is locked/i;
  const e2eLoserOk = e2eLoser && e2eLoser.body && (
    (e2eLoser.status === 409 && e2eLoser.body.code === 'CONCURRENT_STATE_CHANGE') ||
    (e2eLoser.status === 400 && e2eLoser.body.code === 'INVALID_TRANSITION') ||
    (e2eLoser.status === 500 && e2eLoser.body.code === undefined
      && typeof e2eLoser.body.error === 'string' && SQLITE_NESTED_TX_RE.test(e2eLoser.body.error)));
  ok(e2eLoserOk, `②e 败者是设计内失败（409 CONCURRENT_STATE_CHANGE / 400 INVALID_TRANSITION 自环非法 / 500 无 code 且 body.error 匹配 SQLite 嵌套事务·锁争用文案，codex 437 HIGH 收紧），实际 status=${e2eLoser ? e2eLoser.status : '?'} code=${e2eLoser && e2eLoser.body ? e2eLoser.body.code : '?'} error=${e2eLoser && e2eLoser.body ? e2eLoser.body.error : '?'}`);
  const e2eHist = await dbAllAsync(`SELECT id FROM correction_status_history WHERE correction_request_id=? AND from_status='SUSPENDED' AND to_status='ASSIGNED_PENDING_ESTIMATE'`, [g2e]);
  ok(e2eHist.length === 1, `②e history 恰一行恢复记录（无双写）`);

  // ②f codex 437 MED-2 verify 补强：PUT /:id 编辑端点不认 status/assigned_to 字段（PUT handler 全文无
  //   b.status/b.assigned_to 消费点，SUSPENDED 单不该被 PUT 悄悄"越权改状态/改派"）；location_info 在白名单内
  //   应正常生效（对照组，证明"其他字段不被写"不是因为整个请求被拒，而是精确白名单隔离）。哨兵值 999 前置确认非空。
  const g2f = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const before2f = await dbGetAsync('SELECT status, assigned_to, location_info FROM correction_requests WHERE id=?', [g2f]);
  ok(before2f.status === 'SUSPENDED' && before2f.assigned_to === 5, `②f 前置哨兵：status=SUSPENDED / assigned_to=5（非目标伪造值 999，防假绿）`);
  const r2f = await reqJson('PUT', `/api/corrections/${g2f}`, { status: 'FIXED', assigned_to: 999, location_info: '合法更新后的修正方式' }, ADMIN);
  ok(r2f.status === 200, `②f PUT 请求本身成功（200，非因整体被拒才"看似安全"）`);
  const after2f = await dbGetAsync('SELECT status, assigned_to, location_info FROM correction_requests WHERE id=?', [g2f]);
  ok(after2f.status === 'SUSPENDED', `②f status 未被 body.status='FIXED' 篡改，仍 SUSPENDED（PUT 不消费 status 字段）`);
  ok(after2f.assigned_to === 5, `②f assigned_to 未被 body.assigned_to=999 篡改，仍 =5（PUT 不消费 assigned_to 字段）`);
  ok(after2f.location_info === '合法更新后的修正方式', `②f location_info 已生效（白名单内字段对照组：非整体拒绝，是精确字段隔离）`);

  // ══════════════════ ③ 权限 ══════════════════
  console.log('— ③ 权限 —');
  // assignee 可暂缓已由 ①a/①b 覆盖
  const g3b = await seedCorrection({ status: 'IN_PROGRESS', assignedTo: 5, assignedName: '开发甲', createdBy: 10, devEstimatedAt: '2026-06-01 10:00:00' });
  const r3b = await reqJson('POST', `/api/corrections/${g3b}/suspend`, { reason: 'x' }, CREATOR_X);
  ok(r3b.status === 403 && r3b.body.code === 'NOT_AUTHORIZED_FOR_TRANSITION', `③b 建单人（非开发本人/非 admin）暂缓 → 403`);

  const g3c = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', createdBy: 10 });
  const r3c = await reqJson('POST', `/api/corrections/${g3c}/resume`, {}, CREATOR_X);
  ok(r3c.status === 200, `③c 建单人可恢复`);

  const g3d = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', createdBy: 10 });
  const r3d = await reqJson('POST', `/api/corrections/${g3d}/resume`, {}, STRANGER);
  ok(r3d.status === 403 && r3d.body.code === 'NOT_AUTHORIZED_FOR_TRANSITION', `③d 无关用户（非 admin/assignee/creator）恢复 → 403`);

  const g3e = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  const r3e1 = await reqJson('POST', `/api/corrections/${g3e}/suspend`, { reason: 'admin 代为暂缓' }, ADMIN);
  ok(r3e1.status === 200, `③e1 admin 可暂缓`);
  const r3e2 = await reqJson('POST', `/api/corrections/${g3e}/resume`, {}, ADMIN);
  ok(r3e2.status === 200, `③e2 admin 可恢复（双向可）`);

  // 预筛 L3：publisher（非 assignee/creator/admin）恢复 → 403（反向对照——防恢复权限组
  //   [ASSIGNED_PENDING_ESTIMATE case fromStatus==='SUSPENDED' 分支] 被误加 isPublisher/isWhitelistRelay 时全绿掩盖越权口子）
  const g3f = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', createdBy: 10 });
  const r3f = await reqJson('POST', `/api/corrections/${g3f}/resume`, {}, PUBLISHER_P);
  ok(r3f.status === 403 && r3f.body.code === 'NOT_AUTHORIZED_FOR_TRANSITION', `③f publisher（非 assignee/creator/admin）恢复 → 403 NOT_AUTHORIZED_FOR_TRANSITION（预筛 L3）`);

  // ══════════════════ ④ 理由 ══════════════════
  console.log('— ④ 理由 —');
  const g4a = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  const r4a = await reqJson('POST', `/api/corrections/${g4a}/suspend`, { reason: '' }, DEV_A);
  ok(r4a.status === 400 && r4a.body.code === 'SUSPEND_REASON_REQUIRED', `④a reason 空串 → 400 SUSPEND_REASON_REQUIRED`);

  const r4b = await reqJson('POST', `/api/corrections/${g4a}/suspend`, { reason: '   ' }, DEV_A);
  ok(r4b.status === 400 && r4b.body.code === 'SUSPEND_REASON_REQUIRED', `④b reason 纯空白（'   '）→ 400 SUSPEND_REASON_REQUIRED（同码）`);

  const g4c = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r4c = await reqJson('POST', `/api/corrections/${g4c}/resume`, {}, DEV_A);
  ok(r4c.status === 200, `④c 恢复不带 note → 成功`);

  // ══════════════════ ⑤ 恢复语义 ══════════════════
  console.log('— ⑤ 恢复语义 —');
  const g5a = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', devEstimatedAt: '2026-07-01 09:00:00' });
  const before5a = await dbGetAsync('SELECT dev_estimated_at FROM correction_requests WHERE id=?', [g5a]);
  ok(before5a.dev_estimated_at === '2026-07-01 09:00:00', `⑤a 前置哨兵：暂缓中 dev_estimated_at 非空（保留现场）`);
  const r5a = await reqJson('POST', `/api/corrections/${g5a}/resume`, {}, DEV_A);
  ok(r5a.status === 200, `⑤a 恢复成功`);
  const after5a = await dbGetAsync('SELECT dev_estimated_at FROM correction_requests WHERE id=?', [g5a]);
  ok(after5a.dev_estimated_at === null, `⑤a 恢复后 dev_estimated_at IS NULL（前置非空哨兵，禁 NULL 对 NULL 假绿）`);

  const g5b = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', expectedDeadline: '2026-06-01 17:00:00' });
  const r5b = await reqJson('POST', `/api/corrections/${g5b}/resume`, { expected_deadline: '2026-09-15 10:30' }, DEV_A);
  ok(r5b.status === 200, `⑤b 传新 expected_deadline 恢复成功`);
  const after5b = await dbGetAsync('SELECT expected_deadline FROM correction_requests WHERE id=?', [g5b]);
  ok(after5b.expected_deadline === '2026-09-15 10:30:00', `⑤b expected_deadline 传新值生效（归一化 T→空格+补秒）`);

  const g5c = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', expectedDeadline: '2026-06-01 17:00:00' });
  const before5c = await dbGetAsync('SELECT expected_deadline FROM correction_requests WHERE id=?', [g5c]);
  const r5c = await reqJson('POST', `/api/corrections/${g5c}/resume`, {}, DEV_A);
  ok(r5c.status === 200, `⑤c 不传 expected_deadline 恢复成功`);
  const after5c = await dbGetAsync('SELECT expected_deadline FROM correction_requests WHERE id=?', [g5c]);
  ok(before5c.expected_deadline === after5c.expected_deadline, `⑤c 不传 expected_deadline → 沿用原值（前后对拍相等）`);

  const g5d = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r5d = await reqJson('POST', `/api/corrections/${g5d}/resume`, { expected_deadline: '2026-13-45' }, DEV_A);
  ok(r5d.status === 400 && r5d.body.code === 'INVALID_EXPECTED_DEADLINE', `⑤d 非法 expected_deadline('2026-13-45') → 400 INVALID_EXPECTED_DEADLINE`);

  const g5e = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲' });
  const r5e = await reqJson('POST', `/api/corrections/${g5e}/resume`, { expected_deadline: '2020-01-01 00:00' }, DEV_A);
  ok(r5e.status === 200, `⑤e 过去时间 expected_deadline 被接受（不做假保护，如实记录，§2.4）`);
  const after5e = await dbGetAsync('SELECT expected_deadline FROM correction_requests WHERE id=?', [g5e]);
  ok(after5e.expected_deadline === '2020-01-01 00:00:00', `⑤e 过去时间落库为归一化值`);

  const g5f = await seedCorrection({ status: 'SUSPENDED', assignedTo: 5, assignedName: '开发甲', suspendedAt: '2026-05-01 08:00:00' });
  const r5f = await reqJson('POST', `/api/corrections/${g5f}/resume`, {}, DEV_A);
  ok(r5f.status === 200, `⑤f 恢复成功`);
  const after5f = await dbGetAsync('SELECT suspended_at FROM correction_requests WHERE id=?', [g5f]);
  ok(after5f.suspended_at === '2026-05-01 08:00:00', `⑤f suspended_at 恢复后保留非空（最后一次暂缓时刻，不清空，§2.2）`);

  // 预筛 M2 端到端：先造非空哨兵态（防 NULL 对 NULL 假绿）——开发通知/业务方预计通知/completion 完成通知
  // 三族全落"已发送"，暂缓→恢复后断言前两族被重置（否则 notify-estimate/notify-developer 会因 already_sent 短路拒绝再发），
  // completion 完成通知族原样不动（反向对照——FIXED/REFIXED 不可暂缓，暂缓单必然从未完成，动它属越界）。
  const g5g = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  await dbRunAsync(
    `UPDATE correction_requests SET
       notify_status='sent', notified_at='2026-07-01 08:00:00', notify_message_key='devKeyX', notify_error='devErrX', read_at='2026-07-01 09:00:00',
       requester_notify_status='sent', requester_notified_at='2026-07-01 08:10:00', requester_notify_message_key='reqKeyX', requester_notify_error='reqErrX', requester_read_at='2026-07-01 09:10:00',
       completion_notify_status='sent', completion_notified_at='2026-07-01 08:20:00', completion_notify_message_key='doneKeyX', completion_notify_error='doneErrX', completion_read_at='2026-07-01 09:20:00'
     WHERE id=?`, [g5g]
  );
  const NOTIFY_COLS_SQL = `notify_status, notified_at, notify_message_key, notify_error, read_at,
            requester_notify_status, requester_notified_at, requester_notify_message_key, requester_notify_error, requester_read_at,
            completion_notify_status, completion_notified_at, completion_notify_message_key, completion_notify_error, completion_read_at`;
  const before5g = await dbGetAsync(`SELECT ${NOTIFY_COLS_SQL} FROM correction_requests WHERE id=?`, [g5g]);
  ok(before5g.notify_status === 'sent' && before5g.requester_notify_status === 'sent' && before5g.completion_notify_status === 'sent',
    `⑤g0 前置哨兵：开发/业务方预计/completion 三族通知态均先落非空 sent（防 NULL 对 NULL 假绿）`);
  const r5g1 = await reqJson('POST', `/api/corrections/${g5g}/suspend`, { reason: '预筛M2端到端验证' }, DEV_A);
  ok(r5g1.status === 200 && r5g1.body.status === 'SUSPENDED', `⑤g1 暂缓成功`);
  const r5g2 = await reqJson('POST', `/api/corrections/${g5g}/resume`, {}, DEV_A);
  ok(r5g2.status === 200, `⑤g2 恢复成功`);
  const after5g = await dbGetAsync(`SELECT ${NOTIFY_COLS_SQL} FROM correction_requests WHERE id=?`, [g5g]);
  ok(after5g.notify_status === 'not_sent' && after5g.notified_at === null && after5g.notify_message_key === null && after5g.notify_error === null && after5g.read_at === null,
    `⑤g3 开发通知四件套（notify_status/notified_at/notify_message_key/notify_error/read_at）恢复后全重置（预筛 M2）`);
  ok(after5g.requester_notify_status === 'not_sent' && after5g.requester_notified_at === null && after5g.requester_notify_message_key === null && after5g.requester_notify_error === null && after5g.requester_read_at === null,
    `⑤g4 业务方预计通知四件套（requester_notify_status/requester_notified_at/requester_notify_message_key/requester_notify_error/requester_read_at）恢复后全重置（预筛 M2）`);
  ok(after5g.completion_notify_status === 'sent' && after5g.completion_notified_at === before5g.completion_notified_at &&
     after5g.completion_notify_message_key === 'doneKeyX' && after5g.completion_notify_error === 'doneErrX' && after5g.completion_read_at === before5g.completion_read_at,
    `⑤g5 反向对照：completion 完成通知族原样未动（暂缓单必然从未完成，动它属越界，预筛 M2）`);

  // ══════════════════ ⑥ history ══════════════════
  console.log('— ⑥ history —');
  const g6a = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  const r6a1 = await reqJson('POST', `/api/corrections/${g6a}/suspend`, { reason: '业务待客户确认口径' }, DEV_A);
  ok(r6a1.status === 200, `⑥a1 暂缓成功`);
  const r6a2 = await reqJson('POST', `/api/corrections/${g6a}/resume`, { note: '客户已确认，可继续' }, DEV_A);
  ok(r6a2.status === 200, `⑥a2 恢复成功`);
  const hist6a = await dbAllAsync(`SELECT from_status, to_status, reason, operator_id FROM correction_status_history WHERE correction_request_id=? ORDER BY id`, [g6a]);
  const susRow = hist6a.find(h => h.to_status === 'SUSPENDED');
  const resRow = hist6a.find(h => h.from_status === 'SUSPENDED' && h.to_status === 'ASSIGNED_PENDING_ESTIMATE');
  ok(!!susRow && susRow.from_status === 'ASSIGNED_PENDING_ESTIMATE' && susRow.reason === '业务待客户确认口径' && Number(susRow.operator_id) === 5,
    `⑥a 暂缓 history：from=ASSIGNED_PENDING_ESTIMATE/to=SUSPENDED/reason/operator_id(5) 正确`);
  ok(!!resRow && resRow.reason === '客户已确认，可继续' && Number(resRow.operator_id) === 5,
    `⑥a 恢复 history：from=SUSPENDED/to=ASSIGNED_PENDING_ESTIMATE/reason/operator_id(5) 正确`);

  const g6b = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 5, assignedName: '开发甲' });
  const histBefore6b = await dbAllAsync(`SELECT id FROM correction_status_history WHERE correction_request_id=?`, [g6b]);
  await reqJson('POST', `/api/corrections/${g6b}/suspend`, { reason: '第一次暂缓' }, DEV_A);
  const susAt1 = (await dbGetAsync('SELECT suspended_at FROM correction_requests WHERE id=?', [g6b])).suspended_at;
  await reqJson('POST', `/api/corrections/${g6b}/resume`, {}, DEV_A);
  await new Promise(r => setTimeout(r, 1100));   // 保证第二次 datetime('now','localtime') 秒级时间戳与第一次不同
  await reqJson('POST', `/api/corrections/${g6b}/suspend`, { reason: '第二次暂缓' }, DEV_A);
  const susAt2 = (await dbGetAsync('SELECT suspended_at FROM correction_requests WHERE id=?', [g6b])).suspended_at;
  await reqJson('POST', `/api/corrections/${g6b}/resume`, {}, DEV_A);
  const histAfter6b = await dbAllAsync(`SELECT id FROM correction_status_history WHERE correction_request_id=?`, [g6b]);
  ok(histAfter6b.length - histBefore6b.length === 4, `⑥b 重复暂缓两轮 → history 共新增 4 行（暂缓/恢复/暂缓/恢复）`);
  ok(susAt1 !== susAt2, `⑥b 两次暂缓 suspended_at 不同（相隔 >1s，验证"最近一次覆盖"语义）`);

  // ══════════════════ ⑦ 迁移 ══════════════════
  console.log('— ⑦ 迁移 —');
  const cols7 = await dbAllAsync('PRAGMA table_info(correction_requests)');
  ok(cols7.some(c => c.name === 'suspended_at'), `⑦a suspended_at 列存在（PRAGMA table_info，新库 CREATE TABLE 路径）`);

  // 预筛 L2：原断言方向性无效——susCountBefore 与 ⑦a 同一次 PRAGMA 读数（非"跑前"独立读），且重复 ALTER
  //   真实场景是抛 "duplicate column name"（非静默加出第二列），故"跑前后各 1 列"对守卫有没有生效零判别力。
  //   改为：①真实幂等——重跑 migration 后 PRAGMA【重读】confirm 恰 1 列 + ready 仍 true + error 仍 null（无异常吞没）；
  //   ②对照组——绕过 [2a-susp] colNames.includes 守卫裸 ALTER，确切验证 SQLite 本身不容忍重复 ADD COLUMN
  //   （证明"不炸"靠的是守卫在跳过，不是 SQLite 恰好容忍）。
  const susCountBefore = cols7.filter(c => c.name === 'suspended_at').length;
  ok(susCountBefore === 1, `⑦b 前置：迁移前 suspended_at 恰 1 列`);
  await I.runCorrectionMigration(null);
  const cols7b = await dbAllAsync('PRAGMA table_info(correction_requests)');
  const susCountAfter = cols7b.filter(c => c.name === 'suspended_at').length;
  ok(susCountAfter === 1, `⑦b runCorrectionMigration 重复跑真实幂等：PRAGMA 重读 suspended_at 恰 1 列（未被误加第二列）`);
  ok(I.CORRECTION_SCHEMA_STATE.ready === true, `⑦b 重复迁移后 readiness 仍 ready=true（无异常吞没，corrections.js:639-641 outer catch 会置 ready=false）`);
  ok(I.CORRECTION_SCHEMA_STATE.error === null, `⑦b 重复迁移后 error 仍为 null（真无异常抛出，非静默吞后巧合 ready=true）`);

  let dupAltErr = null;
  try {
    await dbRunAsync('ALTER TABLE correction_requests ADD COLUMN suspended_at DATETIME');
  } catch (e) {
    dupAltErr = e;
  }
  ok(!!dupAltErr && /duplicate column name/i.test(dupAltErr.message || ''),
    `⑦b 对照组：绕过 colNames.includes 守卫裸 ALTER ADD COLUMN suspended_at 确切抛 "duplicate column name"（实得：${dupAltErr ? dupAltErr.message : '未抛出'}）——证明"不炸"靠守卫跳过而非 SQLite 容忍重复列`);

  // ⑦c 老库快照（codex 437 MED-3：弃手写简化表，对齐 verify-correction-migration.js 既有老库构造范式——
  //   老库=真实列集减 suspended_at，程序化从当前 db 的真实 DDL 定点删除派生【非手写复刻】，与生产 DDL 零漂移风险）。
  //   迁移后跑完整 schema 断言（列全集与真实当前库逐一对拍，非仅验 suspended_at 单列）+ 一条关键查询（复刻 GET /
  //   列表端点 :2232-2244 真实投影 SELECT）走通——独立 db2/mod2 实例（范式同 verify-correction-migration.js：
  //   module.exports 是工厂函数，CORRECTION_SCHEMA_STATE 等闭包在工厂调用内，多次 require(...)(deps) 各自独立不互相污染）。
  const realDdlRow = await dbGetAsync(`SELECT sql FROM sqlite_master WHERE type='table' AND name='correction_requests'`);
  ok(!!realDdlRow && /suspended_at DATETIME,/.test(realDdlRow.sql), `⑦c 前置：从真实 db 派生 DDL 含 suspended_at 列定义（程序化派生基准有效）`);
  // 定点删除 suspended_at 列定义那一行（非改写复刻整表列清单），模拟"暂缓方案 v1.1 上线前"的已上线生产表。
  const oldLibDdl = realDdlRow.sql.replace(/[ \t]*suspended_at DATETIME,\r?\n/, '');
  ok(!/suspended_at/.test(oldLibDdl), `⑦c 老库 DDL 派生成功：定点删除后不再含 suspended_at`);

  const db2 = new sqlite3.Database(':memory:');
  const dbRunAsync2 = (q, p = []) => new Promise((res, rej) => db2.run(q, p, function (e) { e ? rej(e) : res(this); }));
  const dbGetAsync2 = (q, p = []) => new Promise((res, rej) => db2.get(q, p, (e, r) => e ? rej(e) : res(r)));
  const dbAllAsync2 = (q, p = []) => new Promise((res, rej) => db2.all(q, p, (e, r) => e ? rej(e) : res(r)));
  const deps2 = Object.assign({}, deps, { db: db2, dbRunAsync: dbRunAsync2, dbGetAsync: dbGetAsync2, dbAllAsync: dbAllAsync2, UPLOAD_DIR: TMP_UPLOAD + '-2' });
  await dbRunAsync2(oldLibDdl);
  await dbRunAsync2(`INSERT INTO correction_requests (id, source_system, location_info, requester_name, status, correction_type, created_by, created_at)
                   VALUES (1,'BMS','老库快照测试','张三','FIXED','single',1,'2026-06-17 10:00:00')`);
  const beforeCols7c = (await dbAllAsync2('PRAGMA table_info(correction_requests)')).map(c => c.name);
  ok(!beforeCols7c.includes('suspended_at'), `⑦c 前置：老库快照不含 suspended_at（程序化派生，模拟暂缓方案 v1.1 上线前生产表）`);

  const mod2 = require('../routes/corrections')(deps2);
  mod2.initSchema();
  const t0c = Date.now();
  while (!mod2._internals.CORRECTION_SCHEMA_STATE.ready) {
    if (mod2._internals.CORRECTION_SCHEMA_STATE.error) throw new Error('schema2 error: ' + mod2._internals.CORRECTION_SCHEMA_STATE.error);
    if (Date.now() - t0c > 3000) throw new Error('readiness2 timeout');
    await new Promise(r => setTimeout(r, 30));
  }
  const afterCols7c = (await dbAllAsync2('PRAGMA table_info(correction_requests)')).map(c => c.name).sort();
  ok(afterCols7c.includes('suspended_at'), `⑦c 老库快照跑 migration 后 suspended_at 列出现（ALTER 幂等补列）`);
  // 完整 schema 断言（MED-3）：迁移后老库列全集与真实当前库列全集（cols7b，⑦b 已从同一真实 db 重读）逐一对拍——
  //   防迁移路径漏补其他列却被"只验 suspended_at 单列"的旧断言掩盖。
  const realFullCols = cols7b.map(c => c.name).sort();
  const missingInOld = realFullCols.filter(c => !afterCols7c.includes(c));
  const extraInOld = afterCols7c.filter(c => !realFullCols.includes(c));
  ok(missingInOld.length === 0 && extraInOld.length === 0,
    `⑦c 完整 schema 断言：迁移后老库列全集（${afterCols7c.length} 列）与真实当前库列全集（${realFullCols.length} 列）逐一相等——缺：${missingInOld.join(',') || '无'} / 多：${extraInOld.join(',') || '无'}`);
  const rowAfter7c = await dbGetAsync2('SELECT status, location_info FROM correction_requests WHERE id=1');
  ok(rowAfter7c.status === 'FIXED' && rowAfter7c.location_info === '老库快照测试', `⑦c 旧数据保留（迁移不破坏存量行）`);

  // 关键查询：复刻 GET / 列表端点真实投影 SELECT（corrections.js 约 :2232-2244，逐列原样搬），仅把动态 WHERE
  //   换成定点 id=? ——证明迁移后的老库表不只是"列名对得上"，是真实业务查询语句能跑通（列表渲染不会因缺列/类型不符报错）。
  const listProjectionSql = `SELECT id, source_system, source_system_other, location_info, correction_type, correction_count, status,
                    requester_name, requester_dept, requester_phone, oa_number, process_type, assigned_to, assigned_to_name,
                    expected_deadline, dev_estimated_at, created_at, fixed_at, refixed_at, archived_at, suspended_at,
                    submission_count, created_by, created_by_name, dingtalk_chat_id,
                    relay_notified_at, relay_notify_status, notify_status, requester_notify_status, completion_notify_status, closure_type,
                    correction_group_id,
                    rework_parent_id, rework_root_id, rework_seq, rework_child_count,
                    CASE WHEN correction_group_id = id
                         THEN (SELECT COUNT(*) FROM correction_requests g
                                WHERE g.correction_group_id = correction_requests.id AND g.rework_parent_id IS NULL)
                         ELSE NULL END AS group_nonrework_count
               FROM correction_requests
              WHERE id = ?
              ORDER BY id DESC`;
  let listProjectionErr = null;
  let listProjectionRows = [];
  try {
    listProjectionRows = await dbAllAsync2(listProjectionSql, [1]);
  } catch (e) {
    listProjectionErr = e;
  }
  ok(!listProjectionErr, `⑦c 关键查询：GET / 列表端点真实投影 SELECT 对迁移后老库表走通（未抛异常，实得：${listProjectionErr ? listProjectionErr.message : '无'}）`);
  ok(listProjectionRows.length === 1 && listProjectionRows[0].status === 'FIXED' && listProjectionRows[0].suspended_at === null,
    `⑦c 关键查询：返回恰 1 行，status=FIXED / suspended_at=NULL（老数据从未暂缓过，迁移补列默认值符合预期）`);
  db2.close();

  // ══════════════════ M2（预筛 C3c）：SUSPENDED 态前端按钮门（静态源码文本断言）══════════════════
  //   范式对齐 verify-correction-relay-whitelist.js「读文件文本 + 正则抓字面量」——不起浏览器/不执行 JS，
  //   纯文本断言 Data_Correction.html 里各按钮 onclick 前最近一个 if 条件的字面量文本，防"改按钮门时
  //   漏记 SUSPENDED 边界"这类静默回归（本组断言的具体缺口来源：C1-C3 批次里 SUSPENDED 按钮门是手写的，
  //   没有任何自动化守卫钉住它，纯靠人工 review 不可持续）。
  console.log('\n— M2：SUSPENDED 态前端按钮门（Data_Correction.html 静态文本断言）—');
  const DC_HTML_PATH = path.join(__dirname, '..', 'public', 'Data_Correction.html');
  const dcHtml = fs.readFileSync(DC_HTML_PATH, 'utf8');

  // 从 anchor（如 onclick="openXxx(...)"）向前回溯 500 字符窗口，取最近一个 `if (...) {` 的条件文本
  // （不足以跨越到上一个按钮块——各按钮 if 块之间间距远小于 500 字符，已用下方实测锚点逐一验证过命中的
  // 确是"紧邻自己"的 if，非误跨到更早的按钮块）。
  function extractPrecedingIfCondition(html, anchorStr) {
    const idx = html.indexOf(anchorStr);
    if (idx < 0) return null;
    const windowStart = Math.max(0, idx - 500);
    const before = html.slice(windowStart, idx);
    const matches = [...before.matchAll(/if\s*\(([\s\S]*?)\)\s*\{/g)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1].replace(/\s+/g, ' ').trim();
  }

  const suspendGate = extractPrecedingIfCondition(dcHtml, 'onclick="openSuspend(${r.id})"');
  ok(!!suspendGate, 'M2：暂缓按钮门条件文本可定位（onclick="openSuspend(...)" 前置 if）');
  ok(suspendGate === "(isAdmin || isAssignee) && ['ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS'].includes(s)",
    `M2：暂缓按钮源态门恰为 ['ASSIGNED_PENDING_ESTIMATE','IN_PROGRESS']（不含 SUSPENDED），实得 ${JSON.stringify(suspendGate)}`);

  const resumeGate = extractPrecedingIfCondition(dcHtml, 'onclick="openResume(${r.id})"');
  ok(!!resumeGate, 'M2：恢复按钮门条件文本可定位');
  ok(resumeGate === "(isAdmin || isAssignee || isCreator) && s === 'SUSPENDED'",
    `M2：恢复按钮门恰为 s==='SUSPENDED'，实得 ${JSON.stringify(resumeGate)}`);

  const estimateGate = extractPrecedingIfCondition(dcHtml, 'onclick="openEstimate(${r.id})"');
  ok(!!estimateGate, 'M2：回复预计完成按钮门条件文本可定位');
  ok(!estimateGate.includes('SUSPENDED'), `M2：回复预计完成按钮门不含 SUSPENDED（工作态动作对暂缓单不可见），实得 ${JSON.stringify(estimateGate)}`);

  const completeGate = extractPrecedingIfCondition(dcHtml, 'onclick="openComplete(${r.id}');
  ok(!!completeGate, 'M2：标完成按钮门条件文本可定位');
  ok(!completeGate.includes('SUSPENDED'), `M2：标完成按钮门不含 SUSPENDED，实得 ${JSON.stringify(completeGate)}`);

  const resubmitGate = extractPrecedingIfCondition(dcHtml, 'onclick="openResubmit(${r.id}');
  ok(!!resubmitGate, 'M2：重修提交按钮门条件文本可定位');
  ok(!resubmitGate.includes('SUSPENDED'), `M2：重修提交按钮门不含 SUSPENDED，实得 ${JSON.stringify(resubmitGate)}`);

  const adminCloseGate = extractPrecedingIfCondition(dcHtml, 'onclick="openAdminClose(${r.id})"');
  ok(!!adminCloseGate, 'M2：行政闭环按钮门条件文本可定位');
  ok(adminCloseGate.includes('SUSPENDED'), `M2：行政闭环按钮门含 SUSPENDED（出口三路之一，业务黄了但不算作废），实得 ${JSON.stringify(adminCloseGate)}`);

  // 作废门是"非 VOIDED 即可"的排除式（非枚举式 includes），结构性覆盖 SUSPENDED（SUSPENDED !== 'VOIDED' 恒真）——
  // 首个 doVoid(...) 命中=普通作废门（:1304-1305），非 admin_closure 覆盖分支的三元式（indexOf 天然只取第一个）。
  const voidGate = extractPrecedingIfCondition(dcHtml, 'onclick="doVoid(${r.id})"');
  ok(!!voidGate, 'M2：作废按钮门条件文本可定位（首个匹配=普通作废门）');
  ok(voidGate.includes("!== 'VOIDED'"), `M2：作废门覆盖 SUSPENDED（排除式 s!=='VOIDED'，非枚举式），实得 ${JSON.stringify(voidGate)}`);

  // ★对照组：构造违例文本（暂缓按钮门误加 SUSPENDED），断言 checker 真能判红——非恒真判据。
  //   violationOrig 直接取用上面已实测提取出的 suspendGate（程序化拿到的真实子串，非手写复刻——避免
  //   手打字面量与源码实际空白/引号格式不一致导致 replace 空操作、对照组本身先假摔）。
  {
    ok(dcHtml.split(suspendGate).length - 1 === 1, 'M2 对照组前置：suspendGate 条件文本在源码中唯一出现（replace 定位不模糊）');
    const violationBad = suspendGate.replace("['ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS']", "['ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'SUSPENDED']");
    ok(violationBad !== suspendGate, 'M2 对照组前置：违例条件文本与原文不同（非空操作）');
    const badHtml = dcHtml.replace(suspendGate, violationBad);
    ok(badHtml !== dcHtml, 'M2 对照组前置：违例文本替换确实命中原文');
    const badGate = extractPrecedingIfCondition(badHtml, 'onclick="openSuspend(${r.id})"');
    ok(!!badGate && badGate.includes('SUSPENDED'), `★M2 对照组：暂缓门误含 SUSPENDED 的违例文本，checker 抓到了它（实得 ${JSON.stringify(badGate)}）`);
    ok(badGate !== suspendGate, '★M2 对照组：违例文本与正确门不相等（证明本组判据能真正区分对错，非恒真）');
  }

  console.log(`\n[全部通过] ${pass}/${pass} ✓ 数据修正暂缓功能验证通过（暂缓与列表导出方案 v1.1 §2.5.3 七组断言：转移合法性/路径隔离/权限/理由/恢复语义/history/迁移 + M2 前端按钮门静态断言）`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('\n✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} try { db.close(); } catch (_) {} try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
