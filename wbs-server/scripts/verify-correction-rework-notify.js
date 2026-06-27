// verify-correction-rework-notify.js — 归档单返工 Commit E：返工子单自带 done（option A·单值）真实端点 e2e
//   router-mount + in-memory db + require-cache mock 钉钉（捕获 markdown 文案断言返工语义）。覆盖 §七 + codex 68：
//   A 返工子单 done 发自身（不重定向主单）：发组主单主业务方 + 状态记返工子单【自身行】+ 文案「二次修复·第N次」+ 带附件
//   B 幂等（自身行已 sent → already_sent；force_resend 重发）
//   C 不污染主单 requester 子表（原单完成态原样保留）
//   D 权限（admin/建单人）+ 可发态（仅 FIXED/REFIXED）+ 无主业务方（REQUESTER_ROWS_MISSING）
//   E read-status 返工分支（读自身行 message_key；未读 read=false）
//   F 普通主单 done 零回归（仍写 requester 子表 + 主表兼容列）
// 用法：node scripts/verify-correction-rework-notify.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── mock 钉钉（捕获 markdown 发送，断言文案）──
let MK = 100;
const SENDS = [];
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => ({ ok: true, userid: 'uid_' + phone }),
  sendMarkdownToUser: async (t, robot, uids, title, md) => { SENDS.push({ title, md, uids }); return { errcode: 0, processQueryKey: 'mk_' + (MK++) }; },
  sendFileToUser: async () => ({ errcode: 0 }),
  uploadMedia: async () => 'media1',
  getReadStatus: async () => ({ readDetails: [] }),   // 默认未读
  escapeMarkdown: (x) => x,
  classifyError: () => ({ reason: 'exception', hint: 'err' }),
} };

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rework-notify-'));
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
  UPLOAD_DIR,
  readSystemConfig: async (key) => (CONFIG[key] != null ? CONFIG[key] : null),
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: async (ak, as, tk, fn) => fn(tk),
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),
  safeDeleteFileSync: noop, maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;
let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };
const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const DEV99 = { id: 99, username: 'dev99', display_name: '开发99', role: 'user' };

let PORT, srv;
function reqHttp(method, p, body, user) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, method, path: p,
      headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message })); if (data) r.write(data); r.end();
  });
}
async function waitReady() {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}
// 建主单 M（升主单 group_id=M）+ 主业务方子表行（可带初始完成态）
async function mkMaster(o = {}) {
  const base = { source_system: 'BMS', location_info: 'loc主', correction_count: 1, reason: '原始修正原因占位文本足够长',
    correction_type: 'single', requester_name: '业务张', requester_phone: '13800000001', status: 'ARCHIVED', closure_type: 'normal',
    created_by: 1, created_by_name: '管理员', assigned_to: 99, assigned_to_name: '开发99' };
  const row = { ...base, ...o }; const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  const mid = r.lastID;
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [mid, mid]);
  return mid;
}
async function mkRequester(masterId, o = {}) {
  const base = { requester_name: '业务张', requester_phone: '13800000001', is_primary: 1, seq: 1, completion_notify_status: 'not_sent' };
  const row = { correction_request_id: masterId, ...base, ...o }; const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requesters (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return r.lastID;
}
async function mkRework(masterId, o = {}) {
  const base = { source_system: 'BMS', location_info: 'loc返工', correction_count: 1, reason: '返工原因占位文本足够长', correction_type: 'single',
    requester_name: '业务张', status: 'FIXED', created_by: 1, created_by_name: '管理员', assigned_to: 99, assigned_to_name: '开发99',
    correction_group_id: masterId, rework_parent_id: masterId, rework_root_id: masterId, rework_seq: 1 };
  const row = { ...base, ...o }; const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return r.lastID;
}

(async () => {
  console.log('=== 归档单返工 Commit E：返工子单自带 done（option A·单值）e2e ===\n');
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ── A 返工子单 done 发自身（带附件 + 文案返工语义 + 状态记自身行）──
  console.log('— A 返工子单 done 发自身 —');
  const M = await mkMaster();
  const mReqId = await mkRequester(M, { completion_notify_status: 'sent', completion_notify_message_key: 'orig_key', completion_notified_at: '2026-06-20 10:00:00' });   // 原单首次完成已通知
  const child = await mkRework(M, { rework_seq: 2 });
  // 给返工子单建一张物理 fix_proof（测 att 分支）
  const proofName = 'rework_proof.png';
  fs.writeFileSync(path.join(UPLOAD_DIR, proofName), 'PNGDATA');
  await dbRunAsync(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', ?, ?, 99, '开发99')`, [child, proofName, proofName]);
  SENDS.length = 0;
  const a1 = await reqHttp('POST', `/api/corrections/${child}/notify-done`, {}, ADMIN);
  ok(a1.status === 200 && a1.body.success && a1.body.status === 'sent' && a1.body.rework_seq === 2, 'A1 返工子单 notify-done → 200 sent + rework_seq=2（不重定向主单）');
  const childRow = await dbGetAsync('SELECT completion_notify_status, completion_notify_message_key FROM correction_requests WHERE id=?', [child]);
  ok(childRow.completion_notify_status === 'sent' && childRow.completion_notify_message_key && childRow.completion_notify_message_key.startsWith('mk_'),
    'A2 完成态记返工子单【自身行】completion_notify_*（幂等键按子单 id，codex 68）');
  const lastMd = SENDS[SENDS.length - 1];
  ok(lastMd && /二次修复/.test(lastMd.md) && /第\s*2\s*次返工/.test(lastMd.md) && lastMd.uids[0] === 'uid_13800000001',
    'A3 文案标返工语义「二次修复·第2次返工」+ 发给组主单主业务方(uid_主业务方手机)');

  // ── B 幂等 + force_resend ──
  console.log('— B 幂等 —');
  const b1 = await reqHttp('POST', `/api/corrections/${child}/notify-done`, {}, ADMIN);
  ok(b1.status === 200 && b1.body.already_sent === true, 'B1 再发（未 force）→ already_sent（自身行已 sent）');
  SENDS.length = 0;
  const b2 = await reqHttp('POST', `/api/corrections/${child}/notify-done`, { force_resend: true }, ADMIN);
  ok(b2.status === 200 && b2.body.status === 'sent' && SENDS.length === 1, 'B2 force_resend → 重发（新 send 一次）');

  // ── C 不污染主单 requester 子表 ──
  console.log('— C 不污染主单子表 —');
  const mReqRow = await dbGetAsync('SELECT completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE id=?', [mReqId]);
  ok(mReqRow.completion_notify_status === 'sent' && mReqRow.completion_notify_message_key === 'orig_key',
    'C1 原单主业务方子表行完成态原样保留（返工 done 写自身行不复用原单维度）');

  // ── D 权限 + 可发态 + 无主业务方 ──
  console.log('— D 权限/可发态/无主业务方 —');
  const dOther = { id: 77, username: 'u77', display_name: '路人77', role: 'user' };
  const d1 = await reqHttp('POST', `/api/corrections/${child}/notify-done`, {}, dOther);
  ok(d1.status === 403 && d1.body.code === 'NOT_AUTHORIZED_TO_NOTIFY', 'D1 非 admin 非建单人 → 403');
  const childPending = await mkRework(M, { rework_seq: 3, status: 'PENDING_ASSIGN' });
  const d2 = await reqHttp('POST', `/api/corrections/${childPending}/notify-done`, {}, ADMIN);
  ok(d2.status === 409 && d2.body.code === 'INVALID_STATE_FOR_NOTIFY', 'D2 返工子单非 FIXED/REFIXED → 409 INVALID_STATE_FOR_NOTIFY');
  const M2 = await mkMaster();   // 无主业务方子表行
  const child2 = await mkRework(M2, {});
  const d3 = await reqHttp('POST', `/api/corrections/${child2}/notify-done`, {}, ADMIN);
  ok(d3.status === 409 && d3.body.code === 'REQUESTER_ROWS_MISSING', 'D3 组主单无主业务方 → 409 REQUESTER_ROWS_MISSING');

  // ── E read-status 返工分支（读自身行）──
  console.log('— E read-status 返工分支 —');
  const e1 = await reqHttp('GET', `/api/corrections/${child}/notify-read-status?recipient=done`, null, ADMIN);
  ok(e1.status === 200 && e1.body.read === false, 'E1 返工子单 read-status done → 读自身行 message_key 查钉钉（未读 read=false，不重定向主单）');
  const childPending2 = await mkRework(M, { rework_seq: 9, status: 'FIXED' });   // 未发过
  const e2 = await reqHttp('GET', `/api/corrections/${childPending2}/notify-read-status?recipient=done`, null, ADMIN);
  ok(e2.status === 400 && e2.body.code === 'REQUESTER_NOTIFY_NOT_SENT', 'E2 返工子单未发完成通知 → read-status 400 NOT_SENT（读自身态）');

  // ── F 普通主单 done 零回归 ──
  console.log('— F 普通主单 done 零回归 —');
  const Mn = await mkMaster({ status: 'FIXED' });
  const mnReq = await mkRequester(Mn, { requester_phone: '13800000002' });
  SENDS.length = 0;
  const f1 = await reqHttp('POST', `/api/corrections/${Mn}/notify-done`, {}, ADMIN);
  ok(f1.status === 200 && f1.body.success && f1.body.status === 'sent' && f1.body.requester_id === mnReq, 'F1 普通主单 done → 200 sent（仍走 requester 子表路径，带 requester_id）');
  const mnReqRow = await dbGetAsync('SELECT completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE id=?', [mnReq]);
  ok(mnReqRow.completion_notify_status === 'sent' && mnReqRow.completion_notify_message_key, 'F2 普通主单完成态写 requester 子表（真相源未变）');
  const mnRow = await dbGetAsync('SELECT completion_notify_status FROM correction_requests WHERE id=?', [Mn]);
  ok(mnRow.completion_notify_status === 'sent', 'F3 普通主单主表兼容列回写（is_primary 同步，零回归）');
  const fMd = SENDS[SENDS.length - 1];
  ok(fMd && /已完成/.test(fMd.md) && !/二次修复/.test(fMd.md), 'F4 普通主单文案仍「已完成」非返工语义（不外溢）');

  // ── G（对抗审 LOW-5 / §11 四象限）象限②跨系统子单返工：被返工单 S 是组【子单】（rework_parent_id=S ≠ correction_group_id=GM），
  //   done 必须发【组主单 GM】主业务方而非被返工子单 S（判别后端读 correction_group_id 非 rework_parent_id）──
  console.log('— G 象限②跨系统子单返工 done 发组主单 —');
  const GM = await mkMaster();
  const gmPhone = '13800000009';
  await mkRequester(GM, { requester_phone: gmPhone });
  const Sins = await dbRunAsync(`INSERT INTO correction_requests (source_system,location_info,correction_count,reason,correction_type,requester_name,status,closure_type,created_by,correction_group_id) VALUES ('CRM','系统2字段错',1,'象限2跨系统子单原因文本足够长','single','业务张','ARCHIVED','normal',1,?)`, [GM]);
  const Sid = Sins.lastID;   // 跨系统子单（group_id=GM，无自己的 requester 子表）
  const Rxs = await mkRework(GM, { rework_parent_id: Sid, rework_root_id: Sid, rework_seq: 1, source_system: 'CRM' });   // 返工子单：parent=S≠group_id=GM
  SENDS.length = 0;
  const g1 = await reqHttp('POST', `/api/corrections/${Rxs}/notify-done`, {}, ADMIN);
  ok(g1.status === 200 && g1.body.status === 'sent', 'G1 象限②跨系统子单返工 done → 200 sent');
  const gMd = SENDS[SENDS.length - 1];
  ok(gMd && gMd.uids[0] === 'uid_' + gmPhone, 'G2 done 发【组主单 GM】主业务方（读 correction_group_id 非 rework_parent_id=S），即便 R.parent=S≠group_id');
  const sSub = await dbGetAsync('SELECT id FROM correction_requesters WHERE correction_request_id=?', [Sid]);
  ok(!sSub, 'G3 被返工子单 S 无 requester 子表行（done 不依赖被返工单，恒发组主单 requesters）');

  // ── H read-status 查到 READ → 固化 completion_read_at（返工自身行）+ cached 早返回 ──
  console.log('— H read-status READ 固化 —');
  require.cache[dtPath].exports.getReadStatus = async () => ({ readDetails: [{ userId: 'uid_13800000001', readStatus: 'READ', readTimestamp: 1782500000000 }] });
  const h1 = await reqHttp('GET', `/api/corrections/${child}/notify-read-status?recipient=done`, null, ADMIN);
  ok(h1.status === 200 && h1.body.read === true && h1.body.read_at, 'H1 返工 done read-status 查到 READ → read=true + read_at（读自身行 message_key）');
  const childRead = await dbGetAsync('SELECT completion_read_at FROM correction_requests WHERE id=?', [child]);
  ok(childRead.completion_read_at, 'H2 completion_read_at 固化到返工子单【自身行】');
  const h2 = await reqHttp('GET', `/api/corrections/${child}/notify-read-status?recipient=done`, null, ADMIN);
  ok(h2.status === 200 && h2.body.cached === true, 'H3 二次查 → cached 早返回（已固化自身行）');

  // ── I（codex R1/R2）不变量/数据异常守卫 ──
  console.log('— I 不变量守卫 —');
  // I1：返工子单 group_id=自身（违反 [2g]「≠自身」半边；DB CHECK 只守「parent 非空⇒group_id 非空」拦不住此项）→ notify-done 409 INVARIANT
  const ds = await dbRunAsync(`INSERT INTO correction_requests (source_system,location_info,correction_count,reason,correction_type,requester_name,status,created_by,correction_group_id,rework_parent_id,rework_root_id,rework_seq) VALUES ('BMS','loc',1,'脏groupid返工原因文本足够长','single','业务张','FIXED',1,?,?,?,1)`, [M, M, M]);
  const dsId = ds.lastID;
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [dsId, dsId]);   // group_id=自身（CHECK 过非空，违反≠自身）
  const i1 = await reqHttp('POST', `/api/corrections/${dsId}/notify-done`, {}, ADMIN);
  ok(i1.status === 409 && i1.body.code === 'REWORK_GROUP_INVARIANT_BROKEN', 'I1 返工子单 group_id=自身 → notify-done 409 REWORK_GROUP_INVARIANT_BROKEN（不退化 REQUESTER_ROWS_MISSING）');
  // I1b：返工子单 rework_seq 空（脏，无 DB CHECK）→ 409 INVARIANT（不输出「第 NaN 次返工」）
  const ds2 = await dbRunAsync(`INSERT INTO correction_requests (source_system,location_info,correction_count,reason,correction_type,requester_name,status,created_by,correction_group_id,rework_parent_id,rework_root_id) VALUES ('BMS','loc',1,'脏seq返工原因文本足够长','single','业务张','FIXED',1,?,?,?)`, [M, M, M]);
  const i1b = await reqHttp('POST', `/api/corrections/${ds2.lastID}/notify-done`, {}, ADMIN);
  ok(i1b.status === 409 && i1b.body.code === 'REWORK_GROUP_INVARIANT_BROKEN', 'I1b 返工子单 rework_seq 空 → 409 INVARIANT（不输出第 NaN 次）');
  // I2：read-status 返工子单组主单无主业务方 → 409 REQUESTER_ROWS_MISSING（区分无手机号 PHONE_EMPTY，codex MED-2）
  const GMnoP = await mkMaster();   // 无 requester 子表
  const rNoP = await mkRework(GMnoP, {});
  await dbRunAsync("UPDATE correction_requests SET completion_notify_status='sent', completion_notify_message_key='k1' WHERE id=?", [rNoP]);
  const i2 = await reqHttp('GET', `/api/corrections/${rNoP}/notify-read-status?recipient=done`, null, ADMIN);
  ok(i2.status === 409 && i2.body.code === 'REQUESTER_ROWS_MISSING', 'I2 read-status 返工子单组主单无主业务方 → 409 REQUESTER_ROWS_MISSING（区分 PHONE_EMPTY）');

  console.log(`\n✅ verify-correction-rework-notify 全部通过（${pass} 项）`);
  srv.close(); db.close();
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('\n❌ 验证失败：', e && (e.stack || e.message)); try { srv && srv.close(); } catch (_) {} try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
