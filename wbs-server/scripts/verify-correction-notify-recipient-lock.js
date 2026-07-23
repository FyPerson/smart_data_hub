// verify-correction-notify-recipient-lock.js — MED-1 通知回写手机号乐观锁 并发实证（2026-07-23 E3 二审）
//   场景：notify-done / notify-estimate「读手机号 → 网络发送 → 回写」的发送在途窗口内，建单人通过
//   E3 PUT /:id 修改业务方手机号（PUT 会重置通知态）。修复前：回写无条件按 id 覆盖 → 旧消息状态
//   盖到新手机号上（错误归属）。修复后：回写带 TRIM(COALESCE(requester_phone,''))=读时值 乐观锁，
//   changes=0 → 放弃回写 + sent 场景返回 RECIPIENT_CHANGED_DURING_SEND。
//   实现：require-cache mock 钉钉（复用 notify-done-e2e 脚手架），mock 的 sendMarkdownToUser /
//   resolveRequesterDingUserId 内挂 ON_SEND / ON_RESOLVE 钩子——钩子里调【真实 E3 PUT 端点】改手机号，
//   真实复现"发送在途 + 并发编辑"交错（非 SQL 复刻）。
//   覆盖：
//   ① done sent 在途改号 → 200 success:false RECIPIENT_CHANGED_DURING_SEND + 子表/主表保持 not_sent（PUT 重置）
//   ② done 正常（无并发）→ sent 回写正常（乐观锁不误伤）
//   ③ done failed（反查失败）在途改号 → failed 不回写（保持 PUT 重置的 not_sent）
//   ④ estimate sent 在途改号 → RECIPIENT_CHANGED_DURING_SEND + 主表保持 not_sent
//   ⑤ estimate 正常 → sent 回写正常
// 用法：node scripts/verify-correction-notify-recipient-lock.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── require-cache mock 钉钉（必须在 require corrections 之前）──
let MK = 500;
let ON_SEND = null;      // sendMarkdownToUser 发送前钩子（模拟发送在途的并发编辑）
let ON_RESOLVE = null;   // resolveRequesterDingUserId 钩子（模拟反查在途的并发编辑）
const INVALID_PHONE = '13900000099';
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => {
    if (ON_RESOLVE) { const h = ON_RESOLVE; ON_RESOLVE = null; await h(); }
    return (String(phone) === INVALID_PHONE) ? { ok: false, reason: 'requester_invalid' } : { ok: true, userid: 'uid_' + phone };
  },
  sendMarkdownToUser: async () => {
    if (ON_SEND) { const h = ON_SEND; ON_SEND = null; await h(); }
    return { errcode: 0, processQueryKey: 'mk_' + (MK++) };
  },
  sendFileToUser: async () => ({ errcode: 0 }),
  uploadMedia: async () => 'media1',
  getReadStatus: async () => ({ readDetails: [] }),
  escapeMarkdown: (x) => x,
  classifyError: () => ({ reason: 'exception', hint: 'err' }),
} };

const db = new sqlite3.Database(':memory:');
const dbRunAsyncBase = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
// ⑥ 三审 MED 镜像窗口复现：注入 deps 的 dbRunAsync 带 SQL 后钩——匹配语句执行完、下一条语句前触发一次
//   （钩子先置空再执行，钩子内经由本 wrapper 的 PUT 不会重入）。本地造数用 dbRunAsyncBase 不过钩。
let ON_AFTER_SQL = null;   // { test: (sql)=>bool, hook: async fn }
const dbRunAsync = async (q, p = []) => {
  const r = await dbRunAsyncBase(q, p);
  if (ON_AFTER_SQL && ON_AFTER_SQL.test(q)) { const h = ON_AFTER_SQL.hook; ON_AFTER_SQL = null; await h(); }
  return r;
};
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
  sendIssueDingtalkRaw: async () => ({ ok: true, message_key: 'mk_raw_' + (MK++) }),
  UPLOAD_DIR: require('os').tmpdir(),
  readSystemConfig: async (key) => (CONFIG[key] != null ? CONFIG[key] : null),
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: async (ak, as, tk, fn) => fn(tk),
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
function reqMultipartCreate(fields, user) {
  return new Promise((resolve) => {
    const boundary = '----RecipientLockBoundary' + Math.floor(1e8 + Math.random() * 1e8);
    const chunks = [];
    for (const [k, val] of Object.entries(fields || {})) {
      if (val === undefined || val === null) continue;
      const strVal = (typeof val === 'object') ? JSON.stringify(val) : String(val);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${strVal}\r\n`));
    }
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="oa_proof_files"; filename="oa_proof.png"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(png);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const r = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/corrections',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64') } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    r.write(bodyBuf); r.end();
  });
}
async function waitReady() {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}
let _oaSeq = 910100;
const oa = () => String(_oaSeq++);
// 造真OA单（admin 建单 → requesters 保留）+ 置目标状态
async function createWithStatus(requesters, status, extra) {
  const c = await reqMultipartCreate({ source_system: 'BMS', location_info: '收件人锁测试', correction_type: 'single', oa_number: oa(), reason: '收件人锁测试原因', requesters }, ADMIN);
  assert(c.status === 200, `建单失败: ${c.status} ${JSON.stringify(c.body)}`);
  await dbRunAsync(`UPDATE correction_requests SET status=?${extra ? ', ' + extra : ''} WHERE id=?`, [status, c.body.id]);
  return c.body.id;
}
// 钩子体：调真实 E3 PUT 改主业务方手机号（PUT 内部会重置通知态——真实复现并发编辑）
function editPhoneHook(id, rowId, name, newPhone) {
  return async () => {
    const r = await reqJson('PUT', `/api/corrections/${id}`, { requesters: [{ id: rowId, name, phone: newPhone }] }, ADMIN);
    assert(r.status === 200, `钩子内 PUT 改号失败: ${r.status} ${JSON.stringify(r.body)}`);
  };
}

(async () => {
  console.log('=== MED-1 通知回写收件人乐观锁 并发实证 ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ① done sent 在途改号
  console.log('① notify-done sent 发送在途改号');
  const idA = await createWithStatus([{ name: '主A', phone: '13800000001' }], 'FIXED');
  const rowA = await dbGetAsync(`SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idA]);
  ON_SEND = editPhoneHook(idA, rowA.id, '主A', '13811111111');
  const n1 = await reqJson('POST', `/api/corrections/${idA}/notify-done`, {}, ADMIN);
  ok(n1.status === 200 && n1.body.success === false && n1.body.code === 'RECIPIENT_CHANGED_DURING_SEND',
    `在途改号 → 200 success:false RECIPIENT_CHANGED_DURING_SEND（实际 ${n1.status}/${n1.body.code}）`);
  let sub = await dbGetAsync(`SELECT requester_phone, completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE id=?`, [rowA.id]);
  ok(sub.requester_phone === '13811111111' && sub.completion_notify_status === 'not_sent' && sub.completion_notify_message_key == null,
    '子表行保持 PUT 重置的 not_sent（旧 sent 未盖到新号）');
  let mas = await dbGetAsync(`SELECT completion_notify_status, requester_phone FROM correction_requests WHERE id=?`, [idA]);
  ok(mas.completion_notify_status === 'not_sent' && mas.requester_phone === '13811111111', '主表兼容列同保持 not_sent + 新号');

  // ② done 正常路（乐观锁不误伤）
  console.log('\n② notify-done 正常（无并发）');
  const idB = await createWithStatus([{ name: '主B', phone: '13800000002' }], 'FIXED');
  const n2 = await reqJson('POST', `/api/corrections/${idB}/notify-done`, {}, ADMIN);
  ok(n2.status === 200 && n2.body.success === true && n2.body.status === 'sent', `正常发送 → sent（实际 ${n2.status}/${n2.body.status}）`);
  sub = await dbGetAsync(`SELECT completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idB]);
  ok(sub.completion_notify_status === 'sent' && sub.completion_notify_message_key, '子表 sent 回写正常（守卫不误伤）');
  mas = await dbGetAsync(`SELECT completion_notify_status, completion_notify_message_key FROM correction_requests WHERE id=?`, [idB]);
  ok(mas.completion_notify_status === 'sent' && mas.completion_notify_message_key === sub.completion_notify_message_key, '主表镜像正常（EXISTS 锚不误伤，key 一致）');

  // ③ done failed（反查失败）在途改号 → failed 不回写
  console.log('\n③ notify-done failed 反查在途改号');
  const idC = await createWithStatus([{ name: '主C', phone: INVALID_PHONE }], 'FIXED');
  const rowC = await dbGetAsync(`SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idC]);
  ON_RESOLVE = editPhoneHook(idC, rowC.id, '主C', '13822222222');
  const n3 = await reqJson('POST', `/api/corrections/${idC}/notify-done`, {}, ADMIN);
  ok(n3.status === 400 && n3.body.code === 'REQUESTER_INVALID', `反查失败仍按原语义返回（实际 ${n3.status}/${n3.body.code}）`);
  sub = await dbGetAsync(`SELECT requester_phone, completion_notify_status, completion_notify_error FROM correction_requesters WHERE id=?`, [rowC.id]);
  ok(sub.requester_phone === '13822222222' && sub.completion_notify_status === 'not_sent' && sub.completion_notify_error == null,
    'failed 未盖到新号（保持 PUT 重置的 not_sent + error NULL）');

  // ④ estimate sent 在途改号
  console.log('\n④ notify-estimate sent 发送在途改号');
  const idD = await createWithStatus([{ name: '主D', phone: '13800000004' }], 'IN_PROGRESS', `dev_estimated_at='2026-08-01 10:00:00'`);
  const rowD = await dbGetAsync(`SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idD]);
  ON_SEND = editPhoneHook(idD, rowD.id, '主D', '13833333333');
  const n4 = await reqJson('POST', `/api/corrections/${idD}/notify-estimate`, {}, ADMIN);
  ok(n4.status === 200 && n4.body.success === false && n4.body.code === 'RECIPIENT_CHANGED_DURING_SEND',
    `在途改号 → RECIPIENT_CHANGED_DURING_SEND（实际 ${n4.status}/${n4.body.code}）`);
  mas = await dbGetAsync(`SELECT requester_phone, requester_notify_status, requester_notify_message_key FROM correction_requests WHERE id=?`, [idD]);
  ok(mas.requester_phone === '13833333333' && mas.requester_notify_status === 'not_sent' && mas.requester_notify_message_key == null,
    '主表保持 PUT 重置的 not_sent（旧 sent 未盖到新号）');

  // ⑤ estimate 正常路
  console.log('\n⑤ notify-estimate 正常（无并发）');
  const idE = await createWithStatus([{ name: '主E', phone: '13800000005' }], 'IN_PROGRESS', `dev_estimated_at='2026-08-01 10:00:00'`);
  const n5 = await reqJson('POST', `/api/corrections/${idE}/notify-estimate`, {}, ADMIN);
  ok(n5.status === 200 && n5.body.success === true && n5.body.status === 'sent', `正常发送 → sent（实际 ${n5.status}/${n5.body.status}）`);
  mas = await dbGetAsync(`SELECT requester_notify_status FROM correction_requests WHERE id=?`, [idE]);
  ok(mas.requester_notify_status === 'sent', '主表 sent 回写正常（守卫不误伤）');

  // ⑥ 三审 MED：子表 sent 写成功【之后】、主表镜像写【之前】被 PUT 改号重置 → EXISTS 锚跳过镜像，两表恒一致
  console.log('\n⑥ notify-done 子表写后/镜像写前 PUT 交错（三审 MED 镜像窗口）');
  const idF = await createWithStatus([{ name: '主F', phone: '13800000006' }], 'FIXED');
  const rowF = await dbGetAsync(`SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idF]);
  ON_AFTER_SQL = {
    test: (sql) => /UPDATE correction_requesters SET completion_notify_status='sent'/.test(sql),
    hook: editPhoneHook(idF, rowF.id, '主F', '13844444444'),
  };
  const n6 = await reqJson('POST', `/api/corrections/${idF}/notify-done`, {}, ADMIN);
  ok(n6.status === 200 && n6.body.success === true && n6.body.status === 'sent', `响应仍 sent（发完才编辑的等价时序，实际 ${n6.status}/${n6.body.status}）`);
  sub = await dbGetAsync(`SELECT completion_notify_status FROM correction_requesters WHERE id=?`, [rowF.id]);
  mas = await dbGetAsync(`SELECT completion_notify_status, completion_notify_message_key FROM correction_requests WHERE id=?`, [idF]);
  ok(sub.completion_notify_status === 'not_sent', '子表保持 PUT 重置的 not_sent');
  ok(mas.completion_notify_status === 'not_sent' && mas.completion_notify_message_key == null, '主表镜像被 EXISTS 锚跳过（未复活旧 sent，两表一致）');

  // ⑦ 三审 L-1：历史 whitespace 手机号（JS trim ≠ SQLite TRIM）无并发时不误伤
  console.log('\n⑦ 历史 whitespace 手机号无并发不误伤（三审 L-1）');
  const idG = await createWithStatus([{ name: '主G', phone: '13800000007' }], 'FIXED');
  const rowG = await dbGetAsync(`SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1`, [idG]);
  await dbRunAsyncBase(`UPDATE correction_requesters SET requester_phone=? WHERE id=?`, ['\t13800000007\t', rowG.id]);
  await dbRunAsyncBase(`UPDATE correction_requests SET requester_phone=? WHERE id=?`, ['\t13800000007\t', idG]);
  const n7 = await reqJson('POST', `/api/corrections/${idG}/notify-done`, {}, ADMIN);
  ok(n7.status === 200 && n7.body.success === true && n7.body.status === 'sent', `含制表符历史号正常发送 → sent（实际 ${n7.status}/${n7.body.status || n7.body.code}）`);
  sub = await dbGetAsync(`SELECT completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE id=?`, [rowG.id]);
  ok(sub.completion_notify_status === 'sent' && sub.completion_notify_message_key, '原始值快照锁匹配成功，sent 正常回写（TRIM 归一版会误判 changes=0）');

  console.log(`\n✅ 全部通过：${pass} 断言`);
  srv.close(); db.close(); process.exit(0);
})().catch(e => { console.error('\n✗ 失败：', e.message, '\n', e.stack); try { srv && srv.close(); } catch (_) {} process.exit(1); });
