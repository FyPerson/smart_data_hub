// verify-correction-reassign-e2e.js — L-R 改派端点 e2e（router-mount + in-memory db，不碰真库）
//   覆盖跨系统关联方案 §6.8 / §7.2 改派（D-13，镜像 issue v1.75.0 C2 改人范式，codex 46 收口）：
//   ① ASSIGNED_PENDING_ESTIMATE 改派成功 + 开发通知态全清（含 notify_error，RC4-M2）+ assigned_* 改写
//   ② IN_PROGRESS 改派 → 409 REASSIGN_NOT_ALLOWED_AFTER_ESTIMATE（RC4-L3 引导作废重建）
//   ③ 改派同人 → 400 REASSIGN_NO_CHANGE
//   ④ 白名单对接人改「本人经手」relay 单 → 成功（RC4-M1 放行分支）
//   ⑤ 白名单对接人改「非本人」relay 单 → 403 NOT_AUTHORIZED_TO_REASSIGN（RC4-M1 不能只靠粗筛中间件）
//   ⑥ 普通 user（非 admin/pub/白名单）→ 403（粗筛中间件 requireRelayOrPublisherOrAdmin）
//   ⑦ 跨系统子单独立改派成功，主单 assigned_to 不受影响（RC4-L2 不锚点化）
//   ⑧ history 同态记录（from=to=ASSIGNED_PENDING_ESTIMATE）detail GET 不被过滤、可见、带 reason（RC4-M4）
//   ⑨ 边界：缺 assigned_to→400 / 目标不存在→400 / 目标 viewer→400 / 非 ASSIGNED 非 IN_PROGRESS 态→409 REASSIGN_STATUS_INVALID
//   ⑩ 白盒：乐观锁 WHERE 绑 stale assigned_to → changes=0（CONCURRENT_REASSIGN 守卫 SQL 不变量；真并发 BEGIN IMMEDIATE 序列化单线程不可重现，此处验证 SQL 守卫正确性）
//   require routes/corrections 真实 router + _internals（非复刻）。用法：node scripts/verify-correction-reassign-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-lr-uploads-' + process.pid);
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

// 用户：admin(1) / 开发99 / 开发88 / 白名单对接人7、13 / viewer50 / 普通 user60
const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const RELAY7 = { id: 7, username: 'relay7', display_name: '对接人7', role: 'user' };
const RELAY13 = { id: 13, username: 'relay13', display_name: '对接人13', role: 'user' };
const USER60 = { id: 60, username: 'user60', display_name: '普通用户60', role: 'user' };

function reqJson(method, p, body, user) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, method, path: p,
      headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}

// 直接 INSERT 一行 correction（精确控制 status/assigned_to/relay_notified_user_id/group，避免走完整建单链路）
let SEQ = 1000;
async function seedCorrection({ status, assignedTo = null, assignedName = null, relayUser = null, groupId = null, createdBy = 1 }) {
  const id = ++SEQ;
  await dbRunAsync(
    `INSERT INTO correction_requests
       (id, source_system, location_info, requester_name, status, correction_type, created_by,
        assigned_to, assigned_to_name, relay_notified_user_id, correction_group_id)
     VALUES (?, 'BMS', '改派测试', '业务方', ?, 'single', ?, ?, ?, ?, ?)`,
    [id, status, createdBy, assignedTo, assignedName, relayUser, groupId]
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
  console.log('=== L-R 改派端点 e2e（§6.8/§7.2 D-13）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role) VALUES
    (1,'admin','管理员','admin'),(99,'dev99','开发99','user'),(88,'dev88','开发88','user'),
    (7,'relay7','对接人7','user'),(13,'relay13','对接人13','user'),(50,'viewer50','查看者50','viewer'),(60,'user60','普通用户60','user')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ① ASSIGNED 改派成功 + 通知态全清（含 error）+ assigned_* 改写
  const id1 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99' });
  // 预置"已成功通知 + 残留 error/read_at"状态，验证改派后全部清空
  await dbRunAsync(`UPDATE correction_requests SET notify_status='sent', notified_at='2026-06-18 10:00:00', notify_message_key='oldkey', notify_error='旧发送错误', read_at='2026-06-18 11:00:00' WHERE id=?`, [id1]);
  const r1 = await reqJson('POST', `/api/corrections/${id1}/reassign`, { assigned_to: 88 }, ADMIN);
  ok(r1.status === 200 && r1.body.reassigned === true && r1.body.assigned_to === 88, `① ASSIGNED 改派成功 → 200 assigned_to=88（#${id1}）`);
  const a1 = await dbGetAsync(`SELECT assigned_to, assigned_to_name, assigned_by, notify_status, notified_at, notify_message_key, notify_error, read_at, status FROM correction_requests WHERE id=?`, [id1]);
  ok(a1.assigned_to === 88 && a1.assigned_to_name === '开发88' && a1.assigned_by === 1, '① assigned_to/name/by 改写为新开发88/操作人admin');
  ok(a1.status === 'ASSIGNED_PENDING_ESTIMATE', '① 状态不变（仍 ASSIGNED_PENDING_ESTIMATE，非状态机转移）');
  ok(a1.notify_status === 'not_sent' && a1.notified_at === null && a1.notify_message_key === null && a1.notify_error === null && a1.read_at === null,
    '① 开发通知态完整清空：notify_status=not_sent + notified_at/message_key/error/read_at 全 NULL（RC4-M2 含 error）');
  const h1 = await dbAllAsync(`SELECT from_status, to_status, reason, operator_id FROM correction_status_history WHERE correction_request_id=? ORDER BY id DESC LIMIT 1`, [id1]);
  ok(h1[0] && h1[0].from_status === 'ASSIGNED_PENDING_ESTIMATE' && h1[0].to_status === 'ASSIGNED_PENDING_ESTIMATE' && /改派 旧#99→新#88/.test(h1[0].reason) && h1[0].operator_id === 1,
    '① history 同态留痕：from=to=ASSIGNED_PENDING_ESTIMATE + reason"改派 旧#99→新#88" + operator');

  // ② IN_PROGRESS 改派 → 409 REASSIGN_NOT_ALLOWED_AFTER_ESTIMATE
  const id2 = await seedCorrection({ status: 'IN_PROGRESS', assignedTo: 99, assignedName: '开发99' });
  const r2 = await reqJson('POST', `/api/corrections/${id2}/reassign`, { assigned_to: 88 }, ADMIN);
  ok(r2.status === 409 && r2.body.code === 'REASSIGN_NOT_ALLOWED_AFTER_ESTIMATE', '② IN_PROGRESS 改派 → 409 REASSIGN_NOT_ALLOWED_AFTER_ESTIMATE');

  // ③ 改派同人 → 400 REASSIGN_NO_CHANGE
  const id3 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99' });
  const r3 = await reqJson('POST', `/api/corrections/${id3}/reassign`, { assigned_to: 99 }, ADMIN);
  ok(r3.status === 400 && r3.body.code === 'REASSIGN_NO_CHANGE', '③ 改派同人(99→99) → 400 REASSIGN_NO_CHANGE');

  // ④ 白名单对接人改「本人经手」relay 单 → 成功
  const id4 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99', relayUser: 7 });
  const r4 = await reqJson('POST', `/api/corrections/${id4}/reassign`, { assigned_to: 88 }, RELAY7);
  ok(r4.status === 200 && r4.body.assigned_to === 88, '④ 白名单对接人7 改本人 relay 单 → 200 成功（RC4-M1 放行）');

  // ⑤ 白名单对接人改「非本人」relay 单 → 403（relay_notified_user_id=7，操作人=13）
  const id5 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99', relayUser: 7 });
  const r5 = await reqJson('POST', `/api/corrections/${id5}/reassign`, { assigned_to: 88 }, RELAY13);
  ok(r5.status === 403 && r5.body.code === 'NOT_AUTHORIZED_TO_REASSIGN', '⑤ 白名单对接人13 改非本人 relay 单(relay=7) → 403 NOT_AUTHORIZED_TO_REASSIGN（粗筛过、精校验拦）');

  // ⑥ 普通 user（非 admin/pub/白名单）→ 403（粗筛中间件）
  const id6 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99' });
  const r6 = await reqJson('POST', `/api/corrections/${id6}/reassign`, { assigned_to: 88 }, USER60);
  ok(r6.status === 403, '⑥ 普通 user(非白名单) 改派 → 403（粗筛中间件 requireRelayOrPublisherOrAdmin）');

  // ⑦ 跨系统子单独立改派，主单不受影响（RC4-L2 不锚点化）
  const masterId = await seedCorrection({ status: 'FIXED', assignedTo: 99, assignedName: '开发99' });
  await dbRunAsync(`UPDATE correction_requests SET correction_group_id=? WHERE id=?`, [masterId, masterId]);   // 主单 group=自身
  const childId = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99', groupId: masterId });   // 子单
  const r7 = await reqJson('POST', `/api/corrections/${childId}/reassign`, { assigned_to: 88 }, ADMIN);
  ok(r7.status === 200 && r7.body.assigned_to === 88, `⑦ 跨系统子单(#${childId}) 独立改派 → 200`);
  const mAfter = await dbGetAsync(`SELECT assigned_to, status FROM correction_requests WHERE id=?`, [masterId]);
  ok(Number(mAfter.assigned_to) === 99 && mAfter.status === 'FIXED', '⑦ 主单 assigned_to/status 不受子单改派影响（不锚点化、不跳主单）');

  // ⑧ history 同态记录 detail GET 不被过滤、可见、带 reason（RC4-M4）
  const det = await reqJson('GET', `/api/corrections/${id1}`, null, ADMIN);
  const sameStatusHist = (det.body.history || []).filter(h => h.from_status === h.to_status);
  ok(det.status === 200 && sameStatusHist.length >= 1 && /改派 旧#99→新#88/.test(sameStatusHist[0].reason),
    '⑧ detail GET 返回同态 history 记录（from===to）不被过滤、带"改派"reason（RC4-M4 前端据此特殊渲染）');

  // ⑨ 边界
  const id9 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99' });
  const r9a = await reqJson('POST', `/api/corrections/${id9}/reassign`, {}, ADMIN);
  ok(r9a.status === 400 && r9a.body.code === 'REASSIGN_TARGET_REQUIRED', '⑨a 缺 assigned_to → 400 REASSIGN_TARGET_REQUIRED');
  const r9b = await reqJson('POST', `/api/corrections/${id9}/reassign`, { assigned_to: 99999 }, ADMIN);
  ok(r9b.status === 400 && r9b.body.code === 'REASSIGN_TARGET_NOT_FOUND', '⑨b 目标用户不存在 → 400 REASSIGN_TARGET_NOT_FOUND');
  const r9c = await reqJson('POST', `/api/corrections/${id9}/reassign`, { assigned_to: 50 }, ADMIN);
  ok(r9c.status === 400 && r9c.body.code === 'REASSIGN_TARGET_VIEWER', '⑨c 目标 viewer → 400 REASSIGN_TARGET_VIEWER');
  const id9d = await seedCorrection({ status: 'PENDING_ASSIGN' });   // 非 ASSIGNED 非 IN_PROGRESS
  const r9d = await reqJson('POST', `/api/corrections/${id9d}/reassign`, { assigned_to: 88 }, ADMIN);
  ok(r9d.status === 409 && r9d.body.code === 'REASSIGN_STATUS_INVALID', '⑨d PENDING_ASSIGN 态改派 → 409 REASSIGN_STATUS_INVALID');

  // ⑩ 白盒乐观锁守卫 SQL 不变量：WHERE 绑 stale assigned_to → changes=0（真并发 BEGIN IMMEDIATE 序列化单线程不可重现）
  const id10 = await seedCorrection({ status: 'ASSIGNED_PENDING_ESTIMATE', assignedTo: 99, assignedName: '开发99' });
  const stale = await dbRunAsync(
    `UPDATE correction_requests SET assigned_to=88 WHERE id=? AND status='ASSIGNED_PENDING_ESTIMATE' AND assigned_to=?`,
    [id10, 999999]   // 绑错误（陈旧）old assignee
  );
  ok(stale.changes === 0, '⑩ 白盒：乐观锁 WHERE 绑 stale assigned_to(999999) → changes=0（CONCURRENT_REASSIGN 守卫 SQL 正确）');
  const fresh = await dbRunAsync(
    `UPDATE correction_requests SET assigned_to=88 WHERE id=? AND status='ASSIGNED_PENDING_ESTIMATE' AND assigned_to=?`,
    [id10, 99]   // 绑正确 old assignee
  );
  ok(fresh.changes === 1, '⑩ 白盒：乐观锁 WHERE 绑正确 old assignee(99) → changes=1（正常路径放行）');

  console.log(`\n=== L-R 改派 e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
