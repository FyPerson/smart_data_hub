// verify-correction-requesters-e2e.js — L2a 端点 e2e（router-mount + in-memory db，不碰真库）
//   覆盖跨系统关联方案 §6.1 契约 A / §6.5 / §6.7 的 L2a 部分（不含 notify-done 多业务方，那在 L2b）：
//   ① 建单 requesters[] → 多业务方写子表（主业务方 is_primary=1 + 主表 requester_name 兼容冗余）
//   ② 建单 fallback 旧字段 requester_name → 单业务方子表（契约 A 兼容）
//   ③ 建单 error_proof_note 落库 + Path A 直接指派兼容（assigned_to → ASSIGNED_PENDING_ESTIMATE）
//   ④ 建单 0 业务方 → 400 / requesters[] 全空名 → 400
//   ⑤ resolveCorrectionGroupAnchor 无组单：master=自身 / is_master=true / requesters=子表行
//   ⑥ notify-estimate 权限收紧仅 admin：被指派开发(user)→403（去 isAssignee）/ admin→非 403（§6.5）
//   ⑦ attachments type 分流：未知 type→400 / fix_proof 非 FIXED→409 / error_proof 早期态 admin→成功 / error_proof 被指派开发(非建单人)→403
//   require routes/corrections 真实 router + _internals（非复刻）。用法：node scripts/verify-correction-requesters-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-l2a-uploads-' + process.pid);
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
  // mock auth：从 x-test-user 头注入 req.user；requireAdmin/PublisherOrAdmin 按 role 放行
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
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),   // 真实取扩展名（multer fileFilter 依赖）
  safeDeleteFileSync: (rel) => { try { fs.unlinkSync(path.join(TMP_UPLOAD, rel)); } catch (_) {} },
  maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const DEV = { id: 99, username: 'dev99', display_name: '开发99', role: 'user' };

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
// B2（OA 截图强制·建单同步上传，H-3）：真OA模式建单须走 multipart 且带 ≥1 张 oa_proof_files
function reqMultipartCreate(fields, user) {
  return new Promise((resolve) => {
    const boundary = '----L2aCreateBoundary' + Math.floor(1e8 + Math.random() * 1e8);
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
// 手工 multipart（multer 解析）：fields + 单个文件
function reqMultipart(p, fields, fileName, fileBuf, user) {
  return new Promise((resolve) => {
    const boundary = '----L2aBoundary' + Math.floor(1e8 + (p.length * 7919));
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(fileBuf);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const r = http.request({ host: 'localhost', port: PORT, method: 'POST', path: p,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64') } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    r.write(bodyBuf); r.end();
  });
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
  console.log('=== L2a 端点 e2e（建单 requesters[] + error_proof + attachments 分流 + estimate 权限）===\n');
  // users 表（建单 Path A 校验被指派开发存在）
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (99,'dev99','开发99','user','13900000099'),(1,'admin','管理员','admin','13900000001')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ① 建单 requesters[] 多业务方
  // B1（OA 格式闸 + 自发现自动业务方，方案 v1.5 §2.3 H-2/M-7）：留空 OA 会被后端静默覆盖为"业务方=建单人"，
  //   本组用例的诉求是验证 requesters[] 规范化本身（多业务方/trim/主业务方），须带真实数字 OA 号才能走"真OA模式"
  //   保留既有 requesters[] 校验路径不被 H-2 短路——下方全部创建调用同理追加 oa_number。
  const c1 = await reqMultipartCreate( {
    source_system: 'BMS', location_info: '多业务方测试', correction_type: 'single', reason: '多业务方测试原因背景',
    oa_number: '900001',
    requesters: [{ name: ' 主业务方 ', phone: ' 13800000001 ' }, { name: '业务方乙', phone: '' }, { name: '' }],
  }, ADMIN);
  ok(c1.status === 200 && c1.body.id, `建单 requesters[] → 200（#${c1.body.id}）`);
  const id1 = c1.body.id;
  const rq1 = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=? ORDER BY seq', [id1]);
  ok(rq1.length === 2, `requesters[] 写子表 2 行（空名条目跳过）实得 ${rq1.length}`);
  ok(rq1[0].is_primary === 1 && rq1[0].seq === 1 && rq1[0].requester_name === '主业务方' && rq1[0].requester_phone === '13800000001',
    '第一条=主业务方 is_primary=1 seq=1 + trim');
  ok(rq1[1].is_primary === 0 && rq1[1].seq === 2 && rq1[1].requester_name === '业务方乙' && rq1[1].requester_phone === null,
    '第二条 is_primary=0 seq=2 + 空 phone→NULL');
  const m1 = await dbGetAsync('SELECT requester_name, requester_phone FROM correction_requests WHERE id=?', [id1]);
  ok(m1.requester_name === '主业务方' && m1.requester_phone === '13800000001', '主表 requester_name/phone = 主业务方（兼容冗余）');

  // ② 建单 fallback 旧字段（契约 A 兼容，无 requesters[]）
  const c2 = await reqMultipartCreate( {
    source_system: 'CRM', location_info: '旧字段兼容', correction_type: 'single', reason: '旧字段兼容测试原因', oa_number: '900002', requester_name: '老张', requester_phone: '13700000002',
  }, ADMIN);
  ok(c2.status === 200 && c2.body.id, `建单 fallback 旧字段 → 200（#${c2.body.id}）`);
  const rq2 = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [c2.body.id]);
  ok(rq2.length === 1 && rq2[0].is_primary === 1 && rq2[0].requester_name === '老张', '旧字段 → 单业务方子表 1 行 is_primary=1');

  // ③ 建单 error_proof_note + Path A 直接指派
  const c3 = await reqMultipartCreate( {
    source_system: 'BMS', location_info: 'Path A 直派', correction_type: 'single', reason: 'Path A 直派测试原因', oa_number: '900003', requester_name: '业务方丙',
    error_proof_note: '错误证明：金额字段错误', assigned_to: 99,
  }, ADMIN);
  ok(c3.status === 200 && c3.body.status === 'ASSIGNED_PENDING_ESTIMATE', `建单 Path A 直派 → ASSIGNED_PENDING_ESTIMATE（契约 A 兼容，#${c3.body.id}）`);
  const m3 = await dbGetAsync('SELECT error_proof_note, assigned_to FROM correction_requests WHERE id=?', [c3.body.id]);
  ok(m3.error_proof_note === '错误证明：金额字段错误' && Number(m3.assigned_to) === 99, 'error_proof_note 落库 + assigned_to=99');

  // ④ 建单 0 业务方 → 400（B1：0 业务方校验只在"真OA模式"下触发——留空 OA 会被 H-2 自动填建单人、不会 0 业务方，
  //   故本组须带真实 OA 号才能测到 normalizeCorrectionRequesters 的 MISSING_REQUIRED_FIELDS 分支）
  const c4 = await reqMultipartCreate( { source_system: 'BMS', location_info: '无业务方', correction_type: 'single', oa_number: '900004' }, ADMIN);
  ok(c4.status === 400 && c4.body.code === 'MISSING_REQUIRED_FIELDS', '建单 0 业务方 → 400 MISSING_REQUIRED_FIELDS');
  const c4b = await reqMultipartCreate( { source_system: 'BMS', location_info: '全空名', correction_type: 'single', oa_number: '900005', requesters: [{ name: '  ' }, { name: '' }] }, ADMIN);
  ok(c4b.status === 400 && c4b.body.code === 'MISSING_REQUIRED_FIELDS', '建单 requesters[] 全空名 → 400');

  // ⑤ resolveCorrectionGroupAnchor 无组单
  const anchor = await I.resolveCorrectionGroupAnchor(id1);
  ok(anchor && anchor.master_id === id1 && anchor.is_master === true && anchor.requesters.length === 2,
    'resolveCorrectionGroupAnchor 无组单：master=自身 / is_master=true / requesters=子表 2 行');

  // ⑥ notify-estimate 权限收紧仅 admin（§6.5）：被指派开发(user)→403（去 isAssignee）/ admin→非 403
  const estDev = await reqJson('POST', `/api/corrections/${c3.body.id}/notify-estimate`, {}, DEV);
  ok(estDev.status === 403 && estDev.body.code === 'NOT_AUTHORIZED_TO_NOTIFY', 'notify-estimate 被指派开发(user)→403（isAssignee 已去除）');
  const estAdmin = await reqJson('POST', `/api/corrections/${c3.body.id}/notify-estimate`, {}, ADMIN);
  ok(estAdmin.status !== 403, `notify-estimate admin→非 403（权限通过，落状态闸门 ${estAdmin.status}）`);

  // ⑦ attachments type 分流
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // 最小 PNG 魔数片段
  // 未知 type → 400（不落表）
  const aBad = await reqMultipart(`/api/corrections/${id1}/attachments`, { attachment_type: 'bogus' }, 'x.png', png, ADMIN);
  ok(aBad.status === 400 && aBad.body.code === 'INVALID_ATTACHMENT_TYPE', 'attachments 未知 type → 400 INVALID_ATTACHMENT_TYPE');
  // fix_proof 非 FIXED（id1=PENDING_ASSIGN）→ 409
  const aFix = await reqMultipart(`/api/corrections/${id1}/attachments`, { attachment_type: 'fix_proof' }, 'x.png', png, ADMIN);
  ok(aFix.status === 409 && aFix.body.code === 'INVALID_STATE_FOR_ATTACHMENT', 'attachments fix_proof 非 FIXED → 409');
  // error_proof 早期态 admin → 成功
  const aErr = await reqMultipart(`/api/corrections/${id1}/attachments`, { attachment_type: 'error_proof' }, 'proof.png', png, ADMIN);
  ok(aErr.status === 200 && aErr.body.attachment_type === 'error_proof', `attachments error_proof 早期态 admin → 200 成功`);
  const attRow = await dbGetAsync(`SELECT attachment_type FROM correction_attachments WHERE correction_request_id=? ORDER BY id DESC LIMIT 1`, [id1]);
  ok(attRow && attRow.attachment_type === 'error_proof', 'error_proof 附件落库 attachment_type=error_proof');
  // error_proof 被指派开发(非建单人非 admin)→403。c3 单 created_by=admin(1)、assigned_to=99 → DEV(99) 非 creator
  const aErrDev = await reqMultipart(`/api/corrections/${c3.body.id}/attachments`, { attachment_type: 'error_proof' }, 'p.png', png, DEV);
  ok(aErrDev.status === 403 && aErrDev.body.code === 'NOT_AUTHORIZED_FOR_ATTACHMENT', 'attachments error_proof 被指派开发(非建单人)→403（权限限 admin/建单人）');

  // ⑧ codex 49 M-1：业务方输入上限（requesters ≤20 / name ≤100 / phone ≤50）+ 区分码
  const cMany = await reqMultipartCreate( { source_system: 'BMS', location_info: '超量', correction_type: 'single', oa_number: '900006', requesters: Array.from({ length: 21 }, (_, i) => ({ name: '人' + i })) }, ADMIN);
  ok(cMany.status === 400 && cMany.body.code === 'TOO_MANY_REQUESTERS', 'M-1：requesters>20 → 400 TOO_MANY_REQUESTERS');
  const cLongName = await reqMultipartCreate( { source_system: 'BMS', location_info: '超长名', correction_type: 'single', oa_number: '900007', requesters: [{ name: '啊'.repeat(101) }] }, ADMIN);
  ok(cLongName.status === 400 && cLongName.body.code === 'REQUESTER_NAME_TOO_LONG', 'M-1：name>100 → 400 REQUESTER_NAME_TOO_LONG');
  const cLongPhone = await reqMultipartCreate( { source_system: 'BMS', location_info: '超长号', correction_type: 'single', oa_number: '900008', requesters: [{ name: '有效名', phone: '1'.repeat(51) }] }, ADMIN);
  ok(cLongPhone.status === 400 && cLongPhone.body.code === 'REQUESTER_PHONE_TOO_LONG', 'M-1：phone>50 → 400 REQUESTER_PHONE_TOO_LONG');
  // L-3：非字符串 name/phone 不静默落库（{name:123} 跳过 / {phone:{}} → NULL，无 "[object Object]"）
  const cNonStr = await reqMultipartCreate( { source_system: 'BMS', location_info: '非字符串', correction_type: 'single', reason: '非字符串归一化测试原因', oa_number: '900009', requesters: [{ name: 123, phone: {} }, { name: '真名', phone: {} }] }, ADMIN);
  ok(cNonStr.status === 200, 'L-3：非字符串 name(123) 跳过 + 有效名通过 → 200');
  const rqNonStr = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [cNonStr.body.id]);
  ok(rqNonStr.length === 1 && rqNonStr[0].requester_name === '真名' && rqNonStr[0].requester_phone === null, 'L-3：{name:123} 跳过、{phone:{}}→NULL（无 "[object Object]" 落库）');

  // ⑨ codex 49 M-2：锚点不变量——master group_id=id + child group_id=master，从两端 resolve 都返回完整组
  await dbRunAsync(`INSERT INTO correction_requests (id,source_system,location_info,requester_name,status,correction_type,created_by,correction_group_id) VALUES (500,'BMS','主单','主业务方','FIXED','single',1,500)`);
  await dbRunAsync(`INSERT INTO correction_requesters (correction_request_id,requester_name,is_primary,seq) VALUES (500,'主业务方',1,1)`);
  await dbRunAsync(`INSERT INTO correction_requests (id,source_system,location_info,requester_name,status,correction_type,created_by,correction_group_id) VALUES (501,'CRM','子单','主业务方','ASSIGNED_PENDING_ESTIMATE','single',1,500)`);
  const aM = await I.resolveCorrectionGroupAnchor(500);
  ok(aM.master_id === 500 && aM.is_master === true && aM.group_members.length === 2, 'M-2：从主单 resolve → master=500/is_master=true/组成员 2');
  const aC = await I.resolveCorrectionGroupAnchor(501);
  ok(aC.master_id === 500 && aC.is_master === false && aC.group_members.length === 2 && aC.requesters.length === 1,
    'M-2：从子单 resolve → master=500/is_master=false/组成员 2/requesters 取主单子表（不变量行为化钉死）');

  console.log(`\n=== L2a e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
