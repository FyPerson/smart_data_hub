// verify-correction-notify-done-e2e.js — L2b 真实端点 e2e（notify-done 多业务方 + read-status done）
//   require-cache mock 钉钉 + router-mount + in-memory db，真实跑 notify-done/read-status 端点（非复刻）。
//   覆盖跨系统关联方案 §6.3/§6.4：
//   ① 单业务方未传 requester_id → 自动取主业务方 → sent 落子表 + 主业务方回写主表（RC2-M2）
//   ② 多业务方按 requester_id 逐个发；非主业务方 sent 只落子表、不回写主表（主表仍 not_sent）
//   ③ 多业务方未传 requester_id → 400 REQUESTER_ID_REQUIRED
//   ④ requester_id 归属校验：拿别单 requester_id → 404 REQUESTER_NOT_IN_GROUP（堵串单 RC2-M3）
//   ⑤ no_phone（业务方无手机）→ no_phone 落子表；⑥ 重发契约 already_sent / force_resend
//   ⑦ 非 FIXED/REFIXED → 409 INVALID_STATE_FOR_NOTIFY
//   ⑧ 组闸门（§6.3）：组内有未完成成员 → 409 GROUP_NOT_ALL_DONE；全完成 → 放行
//   ⑨ 子单 notify-done → 409 NOTIFY_DONE_ON_MASTER_ONLY
//   ⑩ read-status done 按 requester_id 归属 + 子表 read_at + 主业务方回写主表
// 用法：node scripts/verify-correction-notify-done-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── require-cache mock 钉钉（必须在 require corrections 之前）──
let MK = 100;                 // 自增 message_key
let READ_STUB = { readDetails: [] };   // 可控已读返回
const INVALID_PHONE = '13900000099';   // 反查不到的手机号（测 requester_invalid）
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => (String(phone) === INVALID_PHONE) ? { ok: false, reason: 'requester_invalid' } : { ok: true, userid: 'uid_' + phone },
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk_' + (MK++) }),
  sendFileToUser: async () => ({ errcode: 0 }),
  uploadMedia: async () => 'media1',
  getReadStatus: async () => READ_STUB,
  escapeMarkdown: (x) => x,
  classifyError: () => ({ reason: 'exception', hint: 'err' }),
} };

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};
const CONFIG = { dingtalk_app_key: 'k', dingtalk_app_secret: 's', dingtalk_robot_code: 'r' };

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: (req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ error: 'no user' });
    try { req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return next(); } catch (e) { return res.status(401).json({ error: 'bad user' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' }),
  requirePublisherOrAdmin: (req, res, next) => (req.user && ['admin', 'publisher'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'pub/admin only' }),
  sendIssueDingtalkRaw: async () => ({}),
  UPLOAD_DIR: require('os').tmpdir(),
  readSystemConfig: async (key) => (CONFIG[key] != null ? CONFIG[key] : null),
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: async (ak, as, tk, fn) => fn(tk),   // 直接调，不重试
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),
  safeDeleteFileSync: noop,
  maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };
const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };

let PORT, srv;
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
async function waitReady() {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}
// 建单 + 直接置 FIXED（绕状态机，本测聚焦 notify-done）
async function createFixed(requesters) {
  const c = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'L2b 测试', correction_type: 'single', requesters }, ADMIN);
  await dbRunAsync(`UPDATE correction_requests SET status='FIXED' WHERE id=?`, [c.body.id]);
  return c.body.id;
}

(async () => {
  console.log('=== L2b notify-done 多业务方 + read-status done 真实端点 e2e ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ① 单业务方未传 requester_id → 自动取主业务方 → sent + 回写主表
  const idA = await createFixed([{ name: '主A', phone: '13800000001' }]);
  const n1 = await reqJson('POST', `/api/corrections/${idA}/notify-done`, {}, ADMIN);
  ok(n1.status === 200 && n1.body.status === 'sent' && n1.body.requester_id, `单业务方 notify-done 未传 requester_id 自动取主 → sent（requester_id=${n1.body.requester_id}）`);
  const subA = await dbGetAsync(`SELECT * FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idA]);
  const masA = await dbGetAsync(`SELECT completion_notify_status, completion_notify_message_key FROM correction_requests WHERE id=?`, [idA]);
  ok(subA.completion_notify_status === 'sent' && subA.completion_notify_message_key, '主业务方子表行 sent + message_key');
  ok(masA.completion_notify_status === 'sent' && masA.completion_notify_message_key === subA.completion_notify_message_key, 'RC2-M2：主业务方回写主表（message_key 一致）');

  // ② 多业务方：非主业务方 sent 只落子表、不回写主表
  const idB = await createFixed([{ name: '主B', phone: '13800000002' }, { name: '乙B', phone: '13800000003' }]);
  const subsB = await dbAllAsync(`SELECT * FROM correction_requesters WHERE correction_request_id=? ORDER BY seq`, [idB]);
  const secId = subsB[1].id;   // 非主业务方
  const n2 = await reqJson('POST', `/api/corrections/${idB}/notify-done`, { requester_id: secId }, ADMIN);
  ok(n2.status === 200 && n2.body.status === 'sent' && Number(n2.body.requester_id) === secId, '多业务方按 requester_id 通知非主业务方 → sent');
  const sub2 = await dbGetAsync(`SELECT completion_notify_status FROM correction_requesters WHERE id=?`, [secId]);
  const mas2 = await dbGetAsync(`SELECT completion_notify_status FROM correction_requests WHERE id=?`, [idB]);
  ok(sub2.completion_notify_status === 'sent', '非主业务方子表行 sent');
  ok(mas2.completion_notify_status === 'not_sent', 'RC2-M2：非主业务方不回写主表（主表仍 not_sent）');

  // ③ 多业务方未传 requester_id → 400
  const n3 = await reqJson('POST', `/api/corrections/${idB}/notify-done`, {}, ADMIN);
  ok(n3.status === 400 && n3.body.code === 'REQUESTER_ID_REQUIRED', '多业务方未传 requester_id → 400 REQUESTER_ID_REQUIRED');

  // ④ 归属校验：拿别单(idA)的 requester_id 调 idB → 404
  const n4 = await reqJson('POST', `/api/corrections/${idB}/notify-done`, { requester_id: subA.id }, ADMIN);
  ok(n4.status === 404 && n4.body.code === 'REQUESTER_NOT_IN_GROUP', '归属校验：别单 requester_id → 404 REQUESTER_NOT_IN_GROUP（堵串单 RC2-M3）');

  // ⑤ no_phone：主业务方无手机
  const idC = await createFixed([{ name: '无手机C' }]);
  const n5 = await reqJson('POST', `/api/corrections/${idC}/notify-done`, {}, ADMIN);
  ok(n5.status === 400 && n5.body.code === 'REQUESTER_PHONE_EMPTY' && n5.body.status === 'no_phone', 'no_phone：业务方无手机 → 400 + 子表 no_phone');
  const subC = await dbGetAsync(`SELECT completion_notify_status, completion_notify_error FROM correction_requesters WHERE correction_request_id=?`, [idC]);
  ok(subC.completion_notify_status === 'no_phone' && subC.completion_notify_error === 'no_phone', 'no_phone 落子表行');

  // ⑥ 重发契约：already_sent / force_resend
  const n6a = await reqJson('POST', `/api/corrections/${idA}/notify-done`, {}, ADMIN);
  ok(n6a.status === 200 && n6a.body.already_sent === true, '重发契约：已 sent 未传 force → already_sent');
  const keyBefore = (await dbGetAsync(`SELECT completion_notify_message_key k FROM correction_requesters WHERE id=?`, [subA.id])).k;
  const n6b = await reqJson('POST', `/api/corrections/${idA}/notify-done`, { force_resend: true }, ADMIN);
  const keyAfter = (await dbGetAsync(`SELECT completion_notify_message_key k FROM correction_requesters WHERE id=?`, [subA.id])).k;
  ok(n6b.status === 200 && n6b.body.status === 'sent' && keyAfter !== keyBefore, '重发契约：force_resend → 重发新 message_key');

  // ⑦ 非 FIXED/REFIXED → 409
  const cP = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'PENDING', correction_type: 'single', requesters: [{ name: 'P', phone: '13800000005' }] }, ADMIN);
  const n7 = await reqJson('POST', `/api/corrections/${cP.body.id}/notify-done`, {}, ADMIN);
  ok(n7.status === 409 && n7.body.code === 'INVALID_STATE_FOR_NOTIFY', '非 FIXED/REFIXED → 409 INVALID_STATE_FOR_NOTIFY');

  // ⑧⑨ 组闸门 + 子单 409：手造 master(500,FIXED) + child(501,IN_PROGRESS)
  await dbRunAsync(`INSERT INTO correction_requests (id,source_system,location_info,requester_name,requester_phone,status,correction_type,created_by,correction_group_id) VALUES (500,'BMS','主单','组主','13800000006','FIXED','single',1,500)`);
  await dbRunAsync(`INSERT INTO correction_requesters (correction_request_id,requester_name,requester_phone,is_primary,seq,completion_notify_status) VALUES (500,'组主','13800000006',1,1,'not_sent')`);
  await dbRunAsync(`INSERT INTO correction_requests (id,source_system,location_info,requester_name,requester_phone,status,correction_type,created_by,correction_group_id) VALUES (501,'CRM','子单','组主','13800000006','IN_PROGRESS','single',1,500)`);
  const nG1 = await reqJson('POST', `/api/corrections/500/notify-done`, {}, ADMIN);
  ok(nG1.status === 409 && nG1.body.code === 'GROUP_NOT_ALL_DONE', '组闸门：组内有未完成成员(501 IN_PROGRESS) → 409 GROUP_NOT_ALL_DONE');
  const nChild = await reqJson('POST', `/api/corrections/501/notify-done`, {}, ADMIN);
  ok(nChild.status === 409 && nChild.body.code === 'NOTIFY_DONE_ON_MASTER_ONLY' && nChild.body.master_id === 500, '子单 notify-done → 409 NOTIFY_DONE_ON_MASTER_ONLY + master_id=500');
  await dbRunAsync(`UPDATE correction_requests SET status='FIXED' WHERE id=501`);   // 子单完成
  const nG2 = await reqJson('POST', `/api/corrections/500/notify-done`, {}, ADMIN);
  ok(nG2.status === 200 && nG2.body.status === 'sent', '组闸门：组内全完成 → 放行 sent');

  // ⑩ read-status done 按 requester_id（先 not read，再 READ_STUB 命中）
  READ_STUB = { readDetails: [] };
  const rs1 = await reqJson('GET', `/api/corrections/${idA}/notify-read-status?recipient=done`, null, ADMIN);
  ok(rs1.status === 200 && rs1.body.read === false, 'read-status done 单业务方自动取主 + 未读 → read=false');
  // 命中 READ：mock 返回该业务方 uid READ
  const phoneA = '13800000001';
  READ_STUB = { readDetails: [{ userId: 'uid_' + phoneA, readStatus: 'READ', readTimestamp: 1718000000000 }] };
  const rs2 = await reqJson('GET', `/api/corrections/${idA}/notify-read-status?recipient=done`, null, ADMIN);
  ok(rs2.status === 200 && rs2.body.read === true && rs2.body.read_at, 'read-status done 命中 READ → read=true + read_at 固化');
  const subARead = await dbGetAsync(`SELECT completion_read_at FROM correction_requesters WHERE id=?`, [subA.id]);
  const masARead = await dbGetAsync(`SELECT completion_read_at FROM correction_requests WHERE id=?`, [idA]);
  ok(subARead.completion_read_at && masARead.completion_read_at === subARead.completion_read_at, 'read-status done：read_at 固化子表 + 主业务方回写主表');
  // read-status done 归属校验：别单 requester_id → 404
  const rs3 = await reqJson('GET', `/api/corrections/${idB}/notify-read-status?recipient=done&requester_id=${subA.id}`, null, ADMIN);
  ok(rs3.status === 404 && rs3.body.code === 'REQUESTER_NOT_IN_GROUP', 'read-status done 归属校验：别单 requester_id → 404');

  // ⑪ codex 50 L-3：read-status done NOT_SENT 返当前行状态（前端区分 not_sent/failed/no_phone）
  const idL3 = await createFixed([{ name: 'L3', phone: '13800000007' }]);   // 未通知
  const rsL3 = await reqJson('GET', `/api/corrections/${idL3}/notify-read-status?recipient=done`, null, ADMIN);
  ok(rsL3.status === 400 && rsL3.body.code === 'REQUESTER_NOTIFY_NOT_SENT' && rsL3.body.status === 'not_sent' && rsL3.body.requester_id,
    'L-3：read-status done NOT_SENT 返当前态（status=not_sent + requester_id）');

  // ⑫ codex 50 M-2：force_resend 失败 → 清旧 read_at（孤儿不残留）
  const idM2 = await createFixed([{ name: 'M2', phone: '13800000008' }]);
  await reqJson('POST', `/api/corrections/${idM2}/notify-done`, {}, ADMIN);   // sent
  READ_STUB = { readDetails: [{ userId: 'uid_13800000008', readStatus: 'READ', readTimestamp: 1718000000000 }] };
  await reqJson('GET', `/api/corrections/${idM2}/notify-read-status?recipient=done`, null, ADMIN);   // 固化 read_at
  const subM2a = await dbGetAsync(`SELECT completion_read_at FROM correction_requesters WHERE correction_request_id=?`, [idM2]);
  ok(subM2a.completion_read_at, 'M-2 前置：notify + read 固化 read_at');
  await dbRunAsync(`UPDATE correction_requesters SET requester_phone=? WHERE correction_request_id=?`, [INVALID_PHONE, idM2]);   // 改无效手机
  const nM2 = await reqJson('POST', `/api/corrections/${idM2}/notify-done`, { force_resend: true }, ADMIN);   // 重发→反查失败→failed
  const subM2b = await dbGetAsync(`SELECT completion_notify_status, completion_read_at FROM correction_requesters WHERE correction_request_id=?`, [idM2]);
  ok(nM2.body.status === 'failed' && subM2b.completion_notify_status === 'failed' && subM2b.completion_read_at === null,
    'M-2：force_resend 失败 → failed + 清旧 read_at（message_key 清空 read_at 即孤儿）');

  // ⑬ codex 50 L-5：主单无子表行（历史/异常数据）→ REQUESTER_ROWS_MISSING
  await dbRunAsync(`INSERT INTO correction_requests (id,source_system,location_info,requester_name,requester_phone,status,correction_type,created_by) VALUES (600,'BMS','无子表遗留单','遗留','13800000009','FIXED','single',1)`);
  const nL5 = await reqJson('POST', `/api/corrections/600/notify-done`, {}, ADMIN);
  ok(nL5.status === 409 && nL5.body.code === 'REQUESTER_ROWS_MISSING', 'L-5：主单无子表行 → 409 REQUESTER_ROWS_MISSING（非误导 REQUESTER_ID_REQUIRED）');

  console.log(`\n=== L2b notify-done e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); process.exit(1); });
