// verify-correction-cross-system-e2e.js — L4 跨系统关联 真实端点 e2e（契约 B 建两单 + link-new 追加 + 组闸门端到端）
//   require-cache mock 钉钉 + router-mount + in-memory db。覆盖方案 §6.1 契约 B / §6.2 link-new / §6.3 组闸门 / §6.7 子单 409。
//   ① 契约 B 建两单：master group_id=id + child group_id=master + 锚点 resolve 双端 / 子单主表 requester_name 非空+子表仅主单 / 子单不带 error_proof_note
//   ② 禁直派 400（cross_system+assigned_to / +relay）+ system2 校验（缺 location_info / 非法 source_system）
//   ③ 子单 409：notify-done / error_proof(attachments) / link-new 都 ON_MASTER_ONLY
//   ④ 组闸门（§6.3）：master FIXED + child 未完成 → 409 GROUP_NOT_ALL_DONE；child FIXED → 放开 sent；
//      child VOIDED/admin_closure → 重新阻塞；child ARCHIVED+normal → 视为完成放开
//   ⑤ RC3-L3：主单 ARCHIVED+normal 调 notify-done → 409 端点态闸门（FIXED/REFIXED 才可发）
//   ⑥ link-new 追加：单系统单升主单 + 追加 → 组内 2 单 / 新单兼容列复制主业务方 / 状态收窄（ARCHIVED 终态 + 已 sent 阻塞）
// 用法：node scripts/verify-correction-cross-system-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── require-cache mock 钉钉（必须在 require corrections 之前）──
let MK = 100;
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => ({ ok: true, userid: 'uid_' + phone }),
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk_' + (MK++) }),
  sendFileToUser: async () => ({ errcode: 0 }),
  uploadMedia: async () => 'media1',
  getReadStatus: async () => ({ readDetails: [] }),
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
const ADMIN2 = { id: 2, username: 'admin2', display_name: '管理员2', role: 'admin' };
// B1（OA 格式闸 + 自发现自动业务方，方案 v1.5 §2.3 H-2/M-7）：留空 OA 会被后端静默覆盖为"业务方=建单人"，
//   本文件全部用例的诉求是验证跨系统关联/link-new/组闸门等结构性行为、且大量断言了自定义 requesters[] 姓名，
//   故全部创建调用统一带一个真实数字 OA 号（走"真OA模式"），避免被 H-2 短路改写业务方。oa() 每次返回递增新号。
let _oaSeq = 900100;
const oa = () => String(_oaSeq++);

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
// B2（OA 截图强制·建单同步上传，H-3）：真OA模式建单须走 multipart 且带 ≥1 张 oa_proof_files
function reqMultipartCreate(fields, user) {
  return new Promise((resolve) => {
    const boundary = '----L4CreateBoundary' + Math.floor(1e8 + Math.random() * 1e8);
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
function reqMultipart(p, fields, fileName, fileBuf, user) {
  return new Promise((resolve) => {
    const boundary = '----L4Boundary' + (p.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(fileBuf); chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const r = http.request({ host: 'localhost', port: PORT, method: 'POST', path: p,
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
const setStatus = (id, status, ct) => dbRunAsync(`UPDATE correction_requests SET status=?, closure_type=? WHERE id=?`, [status, ct || null, id]);

(async () => {
  console.log('=== L4 跨系统关联 真实端点 e2e（契约 B + link-new + 组闸门）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001'),(2,'admin2','管理员2','admin','13900000002'),(99,'dev99','开发99','user','13900000099')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ① 契约 B 建两单
  const cb = await reqMultipartCreate( {
    source_system: 'BMS', location_info: '系统1：客户X字段错', correction_type: 'single', oa_number: oa(), reason: '跨系统契约B建两单测试原因',
    requesters: [{ name: '主业务方', phone: '13800000001' }, { name: '业务方乙', phone: '13800000002' }],
    error_proof_note: '错误截图见附件', cross_system: true, system2: { source_system: 'CRM', location_info: '系统2：同字段错', correction_count: 3 },
  }, ADMIN);
  ok(cb.status === 200 && cb.body.cross_system === true && cb.body.master_id && Array.isArray(cb.body.child_ids) && cb.body.child_ids.length === 1,
    `① 契约 B 建两单 → 200（master #${cb.body.master_id} + child #${cb.body.child_ids && cb.body.child_ids[0]}）`);
  const masterId = cb.body.master_id, childId = cb.body.child_ids[0];
  const mRow = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [masterId]);
  const cRow = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [childId]);
  ok(Number(mRow.correction_group_id) === masterId, '① 主单 group_id=id（不变量：组内有 group_id=id 的主单）');
  ok(Number(cRow.correction_group_id) === masterId, '① 子单 group_id=master_id');
  ok(mRow.status === 'PENDING_ASSIGN' && cRow.status === 'PENDING_ASSIGN', '① 两单 PENDING_ASSIGN（不带初始指派）');
  ok(cRow.source_system === 'CRM' && cRow.location_info === '系统2：同字段错' && cRow.correction_count === 1, '① 子单系统字段=system2（CRM/修正方式）+ single 主单→子单 cc 强制 1（传入 3 被忽略，用户优化条数分流）');
  ok(cRow.correction_type === 'single' && cRow.reason === mRow.reason, '① 子单继承主单 correction_type/reason 公共字段');
  ok(cRow.requester_name === '主业务方' && cRow.requester_phone === '13800000001', '② 子单主表 requester_name/phone 复制主业务方（NOT NULL 兼容冗余）');
  ok(cRow.error_proof_note === null, '② 子单不带 error_proof_note（只主单填）');
  const subM = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [masterId]);
  const subC = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [childId]);
  ok(subM.length === 2 && subC.length === 0, '② 子表仅主单有记录（主单 2 行业务方 / 子单 0 行）');
  // 锚点双端 resolve
  const aM = await I.resolveCorrectionGroupAnchor(masterId);
  const aC = await I.resolveCorrectionGroupAnchor(childId);
  ok(aM.is_master === true && aM.group_members.length === 2 && aM.requesters.length === 2, '① 主单 resolve：is_master + 组成员 2 + requesters 2');
  ok(aC.is_master === false && aC.master_id === masterId && aC.group_members.length === 2 && aC.requesters.length === 2, '① 子单 resolve：非主 + master_id + 组成员 2 + requesters 取主单子表');

  // ② 禁直派 + system2 校验
  const dA = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'CRM', location_info: 'y' }, assigned_to: 99 }, ADMIN);
  ok(dA.status === 400 && dA.body.code === 'CROSS_SYSTEM_NO_DIRECT_ASSIGN', '② 跨系统 + assigned_to → 400 CROSS_SYSTEM_NO_DIRECT_ASSIGN');
  const dR = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'CRM', location_info: 'y' }, relay_notified_user_id: 7 }, ADMIN);
  ok(dR.status === 400 && dR.body.code === 'CROSS_SYSTEM_NO_DIRECT_ASSIGN', '② 跨系统 + relay → 400 CROSS_SYSTEM_NO_DIRECT_ASSIGN');
  const dL = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'CRM' } }, ADMIN);
  ok(dL.status === 400 && dL.body.code === 'LINKED_MISSING_LOCATION_INFO', '② system2 缺 location_info → 400 LINKED_MISSING_LOCATION_INFO');
  const dS = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: '不存在的系统', location_info: 'y' } }, ADMIN);
  ok(dS.status === 400 && dS.body.code === 'INVALID_LINKED_SOURCE_SYSTEM', '② system2 非法 source_system → 400 INVALID_LINKED_SOURCE_SYSTEM');
  const dF = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], system2: { source_system: 'CRM', location_info: 'y' } }, ADMIN);   // 传 system2 但无 cross_system flag
  ok(dF.status === 400 && dF.body.code === 'CROSS_SYSTEM_FLAG_REQUIRED', '② L-3：传 system2 但未开 cross_system → 400 CROSS_SYSTEM_FLAG_REQUIRED（挡静默降级）');

  // ③ 子单 409（notify-done / error_proof / link-new 都 ON_MASTER_ONLY）
  await setStatus(childId, 'FIXED');   // 让子单进入可能误触发的态
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const cN = await reqJson('POST', `/api/corrections/${childId}/notify-done`, {}, ADMIN);
  ok(cN.status === 409 && cN.body.code === 'NOTIFY_DONE_ON_MASTER_ONLY' && cN.body.master_id === masterId, '③ 子单 notify-done → 409 NOTIFY_DONE_ON_MASTER_ONLY + master_id');
  const cE = await reqMultipart(`/api/corrections/${childId}/attachments`, { attachment_type: 'error_proof' }, 'p.png', png, ADMIN);
  ok(cE.status === 409 && cE.body.code === 'ERROR_PROOF_ON_MASTER_ONLY', '③ 子单 error_proof → 409 ERROR_PROOF_ON_MASTER_ONLY');
  const cL = await reqJson('POST', `/api/corrections/${childId}/link-new`, { source_system: '财务系统', location_info: 'z' }, ADMIN);
  ok(cL.status === 409 && cL.body.code === 'LINK_ON_MASTER_ONLY' && cL.body.master_id === masterId, '③ 子单 link-new → 409 LINK_ON_MASTER_ONLY + master_id');
  await setStatus(childId, 'PENDING_ASSIGN');   // 还原

  // ④ 组闸门：master FIXED + child 未完成 → 409；child FIXED → 放开
  await setStatus(masterId, 'FIXED');
  const g1 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, {}, ADMIN);   // 单业务方？主单 2 业务方 → 需 requester_id
  // 主单 2 业务方，notify-done 需 requester_id；先取主业务方
  const primId = subM.find(r => r.is_primary === 1).id;
  const g1b = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: primId }, ADMIN);
  ok(g1b.status === 409 && g1b.body.code === 'GROUP_NOT_ALL_DONE', '④ 组内 child 未完成 → notify-done 409 GROUP_NOT_ALL_DONE');
  await setStatus(childId, 'FIXED');
  const g2 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: primId }, ADMIN);
  ok(g2.status === 200 && g2.body.status === 'sent', '④ child FIXED → 组闸门放开 → notify-done sent');
  // child VOIDED → 重新阻塞（用第二个业务方测，避免已 sent 的重发契约）
  const secId = subM.find(r => r.is_primary === 0).id;
  await setStatus(childId, 'VOIDED');
  const g3 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: secId }, ADMIN);
  ok(g3.status === 409 && g3.body.code === 'GROUP_NOT_ALL_DONE', '④ child VOIDED → 重新阻塞 409 GROUP_NOT_ALL_DONE');
  await setStatus(childId, 'ARCHIVED', 'admin_closure');
  const g4 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: secId }, ADMIN);
  ok(g4.status === 409 && g4.body.code === 'GROUP_NOT_ALL_DONE', '④ child ARCHIVED+admin_closure → 阻塞 409');
  await setStatus(childId, 'ARCHIVED', 'normal');
  const g5 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: secId }, ADMIN);
  ok(g5.status === 200 && g5.body.status === 'sent', '④ child ARCHIVED+normal → 视为完成 → 放开 sent');

  // ⑤ RC3-L3：主单 ARCHIVED+normal 调 notify-done → 端点态闸门 409（非组闸门）
  await setStatus(masterId, 'ARCHIVED', 'normal');
  const g6 = await reqJson('POST', `/api/corrections/${masterId}/notify-done`, { requester_id: primId }, ADMIN);
  ok(g6.status === 409 && g6.body.code !== 'GROUP_NOT_ALL_DONE', `⑤ RC3-L3：主单 ARCHIVED 调 notify-done → 端点态闸门 409（code=${g6.body.code}，非组闸门）`);

  // ⑥ link-new 追加：单系统单升主单 + 追加 → 组内 2 单
  const s1 = await reqMultipartCreate( { source_system: 'BMS', location_info: '独立单', correction_type: 'single', oa_number: oa(), reason: 'link-new独立单测试原因', requesters: [{ name: '独立主', phone: '13700000007' }] }, ADMIN);
  const soloId = s1.body.id;
  const ln = await reqJson('POST', `/api/corrections/${soloId}/link-new`, { source_system: 'CRM', location_info: '追加系统', correction_count: 5 }, ADMIN2);   // soloId 由 ADMIN(1) 建，link-new 由 ADMIN2(2) 做
  ok(ln.status === 200 && ln.body.master_id === soloId && ln.body.id && Array.isArray(ln.body.group_members) && ln.body.group_members.length === 2,
    `⑥ link-new 单系统单升主单 + 追加 → 组内 2 单（新单 #${ln.body.id}）`);
  // M-2：追加单 created_by 继承主单建单人(admin#1)，history operator=实际操作人(admin2#2)
  const newCreated = await dbGetAsync('SELECT created_by FROM correction_requests WHERE id=?', [ln.body.id]);
  ok(Number(newCreated.created_by) === 1, '⑥ M-2：追加单 created_by 继承主单建单人(admin#1)，非 link-new 操作人(admin2#2)');
  const newHist = await dbGetAsync("SELECT operator_id FROM correction_status_history WHERE correction_request_id=? ORDER BY id DESC LIMIT 1", [ln.body.id]);
  ok(Number(newHist.operator_id) === 2, '⑥ M-2：history operator=实际追加操作人(admin2#2)');
  const soloAfter = await dbGetAsync('SELECT correction_group_id FROM correction_requests WHERE id=?', [soloId]);
  const newRow = await dbGetAsync('SELECT correction_group_id, requester_name, requester_phone, source_system FROM correction_requests WHERE id=?', [ln.body.id]);
  ok(Number(soloAfter.correction_group_id) === soloId, '⑥ 源单升主单（group_id=id）');
  ok(Number(newRow.correction_group_id) === soloId && newRow.requester_name === '独立主' && newRow.requester_phone === '13700000007' && newRow.source_system === 'CRM',
    '⑥ 追加单 group_id=master + 复制主业务方兼容列 + system=追加系统');
  const newSub = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [ln.body.id]);
  ok(newSub.length === 0, '⑥ 追加单不写子表');

  // ⑥b 状态收窄：主单 ARCHIVED 终态 → 409；主单业务方已 sent → 409
  await setStatus(soloId, 'ARCHIVED', 'normal');
  const lnT = await reqJson('POST', `/api/corrections/${soloId}/link-new`, { source_system: '财务系统', location_info: 'z' }, ADMIN);
  ok(lnT.status === 409 && lnT.body.code === 'LINK_NOT_ALLOWED_TERMINAL', '⑥b 主单 ARCHIVED 终态 → link-new 409 LINK_NOT_ALLOWED_TERMINAL');
  // 已 sent 阻塞：用一张新单标主业务方 sent
  const s2 = await reqMultipartCreate( { source_system: 'BMS', location_info: '已通知单', correction_type: 'single', oa_number: oa(), reason: '已通知单阻塞测试原因', requesters: [{ name: '甲', phone: '13700000008' }] }, ADMIN);
  await dbRunAsync(`UPDATE correction_requesters SET completion_notify_status='sent' WHERE correction_request_id=? AND is_primary=1`, [s2.body.id]);
  const lnN = await reqJson('POST', `/api/corrections/${s2.body.id}/link-new`, { source_system: '财务系统', location_info: 'z' }, ADMIN);
  ok(lnN.status === 409 && lnN.body.code === 'LINK_NOT_ALLOWED_NOTIFIED', '⑥b 主单业务方已 sent → link-new 409 LINK_NOT_ALLOWED_NOTIFIED');

  // ⑦ L5：GET 详情 group.members 含 assigned_to_name（前端关联组区"开发"列）+ 主单优先排序 + 子单 is_master/master_id（banner/隐藏依据）
  const cb7 = await reqMultipartCreate( {
    source_system: 'BMS', location_info: 'L5系统1', correction_type: 'single', oa_number: oa(), reason: 'L5关联组详情测试原因',
    requesters: [{ name: '主', phone: '13800000010' }],
    cross_system: true, system2: { source_system: 'HRD', location_info: 'L5系统2' },
  }, ADMIN);
  const m7 = cb7.body.master_id, c7 = cb7.body.child_ids[0];
  await dbRunAsync(`UPDATE correction_requests SET assigned_to=99, assigned_to_name='开发99' WHERE id=?`, [c7]);   // 子单指派开发（验组区"开发"列）
  const det = await reqJson('GET', `/api/corrections/${m7}`, null, ADMIN);
  ok(det.status === 200 && det.body.group && det.body.group.is_master === true && Array.isArray(det.body.group.members) && det.body.group.members.length === 2,
    '⑦ L5：主单详情 group.is_master=true + members 长度 2');
  ok(det.body.group.members.every(mm => 'assigned_to_name' in mm), '⑦ L5：group.members 每行含 assigned_to_name 字段（前端组区开发列）');
  ok(Number(det.body.group.members[0].id) === Number(m7), '⑦ L5：group.members 主单优先排序（members[0]=主单）');
  const childMember = det.body.group.members.find(x => Number(x.id) === Number(c7));
  ok(childMember && childMember.assigned_to_name === '开发99' && childMember.source_system === 'HRD' && childMember.status === 'PENDING_ASSIGN',
    '⑦ L5：子单成员 assigned_to_name=开发99 + source_system=HRD + status');
  const detC = await reqJson('GET', `/api/corrections/${c7}`, null, ADMIN);
  ok(detC.status === 200 && detC.body.group && detC.body.group.is_master === false && Number(detC.body.group.master_id) === Number(m7),
    '⑦ L5：子单详情 group.is_master=false + master_id=主单（前端 banner/隐藏 done/error_proof 依据）');

  // ⑧ M-2（codex 57）：跨系统组内系统互异——建单 system2≠系统1 / link-new 不重复系统 /「其他」按补充说明细分
  const sameSys = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'BMS', location_info: 'y' } }, ADMIN);
  ok(sameSys.status === 400 && sameSys.body.code === 'CROSS_SYSTEM_SAME_SYSTEM', '⑧ M-2：建单 system2==系统1(BMS) → 400 CROSS_SYSTEM_SAME_SYSTEM');
  const otherSame = await reqMultipartCreate( { source_system: '其他', source_system_other: 'A系统', location_info: 'x', correction_type: 'single', oa_number: oa(), requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: '其他', source_system_other: 'A系统', location_info: 'y' } }, ADMIN);
  ok(otherSame.status === 400 && otherSame.body.code === 'CROSS_SYSTEM_SAME_SYSTEM', '⑧ M-2：「其他」同补充说明(A=A) → 400（细分判同系统）');
  const otherDiff = await reqMultipartCreate( { source_system: '其他', source_system_other: 'A系统', location_info: 'x', correction_type: 'single', oa_number: oa(), reason: '其他子系统差异测试原因', requesters: [{ name: '甲', phone: '13700000010' }], cross_system: true, system2: { source_system: '其他', source_system_other: 'B系统', location_info: 'y' } }, ADMIN);
  ok(otherDiff.status === 200 && otherDiff.body.cross_system === true, '⑧ M-2：「其他」不同补充说明(A≠B) → 放行（不误拒不同的「其他」子系统）');
  const s3 = await reqMultipartCreate( { source_system: 'BMS', location_info: '独立', correction_type: 'single', oa_number: oa(), reason: 'link-new去重独立单测试原因', requesters: [{ name: '主', phone: '13700000011' }] }, ADMIN);
  const dupLn = await reqJson('POST', `/api/corrections/${s3.body.id}/link-new`, { source_system: 'BMS', location_info: 'z' }, ADMIN);
  ok(dupLn.status === 409 && dupLn.body.code === 'LINK_DUPLICATE_SOURCE_SYSTEM', '⑧ M-2：link-new 追加组内已有系统(BMS) → 409 LINK_DUPLICATE_SOURCE_SYSTEM');
  const okLn = await reqJson('POST', `/api/corrections/${s3.body.id}/link-new`, { source_system: 'CRM', location_info: 'z' }, ADMIN);
  ok(okLn.status === 200 && okLn.body.id, '⑧ M-2：link-new 追加不同系统(CRM) → 放行');

  // ⑨ 修正条数分流（用户优化 2026-06-18）：single 强制 1 / batch 必填 ≥2（主单 + 跨系统 system2 + link-new）
  const cc_s = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'single', oa_number: oa(), correction_count: 99, reason: 'single条数强制1测试原因', requesters: [{ name: '甲', phone: '13700000020' }] }, ADMIN);
  const cc_sRow = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [cc_s.body.id]);
  ok(cc_s.status === 200 && cc_sRow.correction_count === 1, '⑨ single 传 cc=99 → 后端强制 1（忽略传值，防 API 绕过）');
  const cc_b0 = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), reason: 'batch缺条数测试原因', requesters: [{ name: '甲' }] }, ADMIN);
  ok(cc_b0.status === 400 && cc_b0.body.code === 'CORRECTION_COUNT_REQUIRED', '⑨ batch 不填 cc → 400 CORRECTION_COUNT_REQUIRED');
  const cc_b1 = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), correction_count: 1, reason: 'batch条数1测试原因', requesters: [{ name: '甲' }] }, ADMIN);
  ok(cc_b1.status === 400 && cc_b1.body.code === 'BATCH_COUNT_MIN', '⑨ batch cc=1 → 400 BATCH_COUNT_MIN（仅 1 条应改 single）');
  const cc_b2 = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), correction_count: 2, reason: 'batch条数边界2测试原因', requesters: [{ name: '甲' }] }, ADMIN);
  const cc_b2Row = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [cc_b2.body.id]);
  ok(cc_b2.status === 200 && cc_b2Row.correction_count === 2, '⑨ batch cc=2 → 放行边界 + db=2');
  // 跨系统 batch：system2 也按 batch ≥2 必填
  const cc_xs0 = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), correction_count: 5, reason: '跨系统batch缺子条数测试原因', requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'CRM', location_info: 'y' } }, ADMIN);
  ok(cc_xs0.status === 400 && cc_xs0.body.code === 'LINKED_CORRECTION_COUNT_REQUIRED', '⑨ 跨系统 batch system2 不填 cc → 400 LINKED_CORRECTION_COUNT_REQUIRED');
  const cc_xs1 = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), correction_count: 5, reason: '跨系统batch子条数1测试原因', requesters: [{ name: '甲' }], cross_system: true, system2: { source_system: 'CRM', location_info: 'y', correction_count: 1 } }, ADMIN);
  ok(cc_xs1.status === 400 && cc_xs1.body.code === 'LINKED_BATCH_COUNT_MIN', '⑨ 跨系统 batch system2 cc=1 → 400 LINKED_BATCH_COUNT_MIN');
  const cc_xs = await reqMultipartCreate( { source_system: 'BMS', location_info: 'x', correction_type: 'batch', oa_number: oa(), correction_count: 5, reason: '跨系统batch条数分流测试原因', requesters: [{ name: '甲', phone: '13700000021' }], cross_system: true, system2: { source_system: 'CRM', location_info: 'y', correction_count: 3 } }, ADMIN);
  const cc_xsM = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [cc_xs.body.master_id]);
  const cc_xsC = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [cc_xs.body.child_ids[0]]);
  ok(cc_xs.status === 200 && cc_xsM.correction_count === 5 && cc_xsC.correction_count === 3, '⑨ 跨系统 batch：主单 cc=5 + 子单 cc=3 各自写入');
  // link-new：继承主单类型
  const ln_bFail = await reqJson('POST', `/api/corrections/${cc_b2.body.id}/link-new`, { source_system: 'HRD', location_info: 'z' }, ADMIN);   // cc_b2=batch 主单
  ok(ln_bFail.status === 400 && ln_bFail.body.code === 'LINKED_CORRECTION_COUNT_REQUIRED', '⑨ link-new batch 主单追加不填 cc → 400 LINKED_CORRECTION_COUNT_REQUIRED');
  const ln_bOk = await reqJson('POST', `/api/corrections/${cc_b2.body.id}/link-new`, { source_system: 'HRD', location_info: 'z', correction_count: 4 }, ADMIN);
  const ln_bRow = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [ln_bOk.body.id]);
  ok(ln_bOk.status === 200 && ln_bRow.correction_count === 4, '⑨ link-new batch 主单追加 cc=4 → 子单 cc=4');
  const ln_s = await reqJson('POST', `/api/corrections/${cc_s.body.id}/link-new`, { source_system: 'HRD', location_info: 'z', correction_count: 99 }, ADMIN);   // cc_s=single 主单
  const ln_sRow = await dbGetAsync('SELECT correction_count FROM correction_requests WHERE id=?', [ln_s.body.id]);
  ok(ln_s.status === 200 && ln_sRow.correction_count === 1, '⑨ link-new single 主单追加传 cc=99 → 子单恒 1（忽略传值）');

  console.log(`\n=== L4+L5+末次审+条数分流 跨系统 e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); process.exit(1); });
