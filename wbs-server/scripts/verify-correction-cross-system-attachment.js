// verify-correction-cross-system-attachment.js — 跨系统 error_proof 附件跨单可见（codex 61·方案 A）真实端点 e2e
//   require-cache mock 钉钉 + router-mount + in-memory db。真实走 GET /:id 详情接口改动后的取附件合并 SQL + effective_error_proof_note。
//   设计原则：error_proof = 诉求级（组内共享一份、物理存主单）；fix_proof = 单级（各单各交各看本单）。
//   覆盖（对齐 codex 61 12 条拍板）：
//   ① 跨系统组：子单 GET 详情取到主单 error_proof（from_master=true）——本优化核心痛点
//   ② 负断言（M-1）：子单详情【不含】主单 fix_proof（接口级不变量——子单仅额外获得主单 error_proof）
//   ③ 主/子 fix_proof 不互串：主单只见自己 fix_proof、子单只见自己 fix_proof（单级隔离）
//   ④ 单系统单回归（行为不变）：error_proof 查自身 + from_master=false（关键回归保障 master===id）
//   ⑤ 三单组（M-6 link-new）：主+子A+追加子B 都见同一主单 error_proof；三单各自 fix_proof 不互串
//   ⑥ effective_error_proof_note（M-4）：主单/无组取自身、子单取主单 note（前端统一字段）
//   ⑦ L-2：所有附件行带 from_master 布尔 + source_correction_request_id
//   ⑧ L-3：error_proof 排在 fix_proof 前（CASE 稳序）
//   ⑨ 护栏（M-2）：attachment_type 只有 error_proof/fix_proof 两类（NOT NULL + 单一写入口，无脏数据）
// 用法：node scripts/verify-correction-cross-system-attachment.js
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
const DEV_S1 = { id: 91, username: 'dev_s1', display_name: '系统1开发', role: 'user' };
const DEV_S2 = { id: 92, username: 'dev_s2', display_name: '系统2开发', role: 'user' };
const DEV_S3 = { id: 93, username: 'dev_s3', display_name: '系统3开发', role: 'user' };

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
function reqMultipart(p, fields, fileName, fileBuf, user) {
  return new Promise((resolve) => {
    const boundary = '----AttBoundary' + (p.length * 7919);
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
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const GET = (id, user) => reqJson('GET', `/api/corrections/${id}`, null, user);
// 详情附件提取助手
const errOf = (detail) => (detail.body.attachments || []).filter(a => a.attachment_type === 'error_proof');
const fixOf = (detail) => (detail.body.attachments || []).filter(a => a.attachment_type === 'fix_proof');
// 指派单：直接改 assigned_to + 态（绕过 transition，本脚本只验附件可见性，不验指派流程）
const assignDev = (id, devId) => dbRunAsync(`UPDATE correction_requests SET assigned_to=?, status='IN_PROGRESS' WHERE id=?`, [devId, id]);

(async () => {
  console.log('=== 跨系统 error_proof 附件跨单可见（codex 61·方案 A）真实端点 e2e ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES
    (1,'admin','管理员','admin','13900000001'),
    (91,'dev_s1','系统1开发','user','13900000091'),
    (92,'dev_s2','系统2开发','user','13900000092'),
    (93,'dev_s3','系统3开发','user','13900000093')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ── 建跨系统两单（主单系统1 + 子单系统2）──
  const cb = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '系统1：客户X字段错', correction_type: 'single',
    requesters: [{ name: '主业务方', phone: '13800000001' }],
    error_proof_note: '错误证明：客户名称在两系统都显示乱码', cross_system: true,
    system2: { source_system: 'CRM', location_info: '系统2：同字段错' },
  }, ADMIN);
  assert(cb.status === 200 && cb.body.master_id && cb.body.child_ids.length === 1, '前置：建跨系统两单');
  const masterId = cb.body.master_id, childId = cb.body.child_ids[0];

  // ⓪ 写端防线（codex 61 代码审 L-2）：子单上传 error_proof 仍被拒 409——方案 A 的"单一真相源"前提是 error_proof 物理只在主单。
  //   写读两端语义钉死（feedback_write_read_same_semantic）：读时合并主单 error_proof 必须配"写时归主单"防线不回归，否则会掩盖子单脏附件。
  const subUp = await reqMultipart(`/api/corrections/${childId}/attachments`, { attachment_type: 'error_proof' }, 'sub_err.png', png, ADMIN);
  ok(subUp.status === 409 && subUp.body.code === 'ERROR_PROOF_ON_MASTER_ONLY' && subUp.body.master_id === masterId,
    '⓪ L-2 写端防线：子单上传 error_proof → 409 ERROR_PROOF_ON_MASTER_ONLY（物理单一真相源前提）');
  const subErrRows = await dbAllAsync(`SELECT COUNT(*) AS c FROM correction_attachments WHERE correction_request_id=? AND attachment_type='error_proof'`, [childId]);
  ok(subErrRows[0].c === 0, '⓪ L-2：子单本地无 error_proof 落库（409 拦截后未写脏附件）');

  await assignDev(masterId, DEV_S1.id);   // 系统1开发
  await assignDev(childId, DEV_S2.id);     // 系统2开发

  // ── 主单上传 error_proof（建单错误证明，归主单）──
  const upErr = await reqMultipart(`/api/corrections/${masterId}/attachments`, { attachment_type: 'error_proof' }, 'err.png', png, ADMIN);
  ok(upErr.status === 200 && upErr.body.attachment_type === 'error_proof', '前置：主单上传 error_proof 成功');
  // ── 主单系统1开发上传自己的 fix_proof（标完成）──
  const upFixM = await reqMultipart(`/api/corrections/${masterId}/complete`, {}, 'fix_s1.png', png, DEV_S1);
  ok(upFixM.status === 200 && upFixM.body.status === 'FIXED', '前置：主单系统1开发 complete 上传 fix_proof');
  // ── 子单系统2开发上传自己的 fix_proof（标完成）──
  const upFixC = await reqMultipart(`/api/corrections/${childId}/complete`, {}, 'fix_s2.png', png, DEV_S2);
  ok(upFixC.status === 200 && upFixC.body.status === 'FIXED', '前置：子单系统2开发 complete 上传 fix_proof');

  // ① 核心：子单 GET 详情取到主单 error_proof（from_master=true）——本优化痛点
  const cD = await GET(childId, DEV_S2);
  ok(cD.status === 200, '① 系统2开发可看子单详情（assignee 可见）');
  const cErr = errOf(cD);
  ok(cErr.length === 1, '① 子单详情含 1 个 error_proof（主单的，本优化核心）');
  ok(cErr[0].from_master === true, '① 子单的 error_proof from_master=true（标来源）');
  ok(Number(cErr[0].source_correction_request_id) === masterId, '① error_proof source_correction_request_id=主单 id');
  ok(cErr[0].original_name === 'err.png', '① 子单看到的 error_proof 即主单上传的那份（物理一份，单一真相源）');

  // ② 负断言（M-1）：子单详情【不含】主单 fix_proof（接口级不变量）
  const cFix = fixOf(cD);
  ok(cFix.length === 1, '② 子单详情只含 1 个 fix_proof（子单自己的，不含主单 fix_proof）');
  ok(cFix[0].original_name === 'fix_s2.png', '② 子单 fix_proof=系统2自己的（fix_s2），非主单 fix_s1');
  ok(!cFix.some(a => a.original_name === 'fix_s1.png'), '② M-1 负断言：子单详情【不含】主单 fix_proof（fix_s1 不串入）');
  ok(cFix.every(a => a.from_master === false), '② 子单 fix_proof from_master 恒 false（单级材料）');

  // ③ 主单详情：error_proof 查自己（from_master=false）+ 只见自己 fix_proof（不见子单 fix_proof）
  const mD = await GET(masterId, DEV_S1);
  const mErr = errOf(mD), mFix = fixOf(mD);
  ok(mErr.length === 1 && mErr[0].from_master === false, '③ 主单 error_proof 查自己 + from_master=false（master===id 回归保障）');
  ok(mFix.length === 1 && mFix[0].original_name === 'fix_s1.png', '③ 主单只见自己 fix_proof（fix_s1）');
  ok(!mFix.some(a => a.original_name === 'fix_s2.png'), '③ 主单【不含】子单 fix_proof（fix_s2 不串入，单级隔离）');

  // ④ effective_error_proof_note（M-4）：子单取主单 note、主单取自身
  ok(cD.body.request.effective_error_proof_note === '错误证明：客户名称在两系统都显示乱码', '④ M-4：子单 effective_error_proof_note=主单 note');
  ok(mD.body.request.effective_error_proof_note === '错误证明：客户名称在两系统都显示乱码', '④ M-4：主单 effective_error_proof_note=自身 note');
  ok(cD.body.request.error_proof_note === null, '④ 子单自身 error_proof_note 仍为 NULL（物理不复制，靠 effective 字段合并）');

  // ⑤ 单系统单回归（行为完全不变，master===id）
  const solo = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '独立单字段错', correction_type: 'single',
    requesters: [{ name: '独立业务方', phone: '13800000009' }], error_proof_note: '独立单错误说明',
  }, ADMIN);
  const soloId = solo.body.id;
  await reqMultipart(`/api/corrections/${soloId}/attachments`, { attachment_type: 'error_proof' }, 'solo_err.png', png, ADMIN);
  await assignDev(soloId, DEV_S1.id);
  await reqMultipart(`/api/corrections/${soloId}/complete`, {}, 'solo_fix.png', png, DEV_S1);
  const sD = await GET(soloId, ADMIN);
  const sErr = errOf(sD), sFix = fixOf(sD);
  ok(sErr.length === 1 && sErr[0].from_master === false && Number(sErr[0].source_correction_request_id) === soloId,
    '⑤ 单系统单 error_proof 查自身 + from_master=false（回归：无组单 master===id 行为不变）');
  ok(sFix.length === 1 && sFix[0].original_name === 'solo_fix.png', '⑤ 单系统单 fix_proof 查自身');
  ok(sD.body.request.effective_error_proof_note === '独立单错误说明', '⑤ 单系统单 effective_error_proof_note=自身');

  // ⑥ L-3：error_proof 排在 fix_proof 前（CASE 稳序）——用主单详情（含两类）验
  ok(mD.body.attachments.length >= 2, '⑥ 主单详情含 ≥2 附件（error_proof + fix_proof）');
  const firstErrIdx = mD.body.attachments.findIndex(a => a.attachment_type === 'error_proof');
  const firstFixIdx = mD.body.attachments.findIndex(a => a.attachment_type === 'fix_proof');
  ok(firstErrIdx >= 0 && firstFixIdx >= 0 && firstErrIdx < firstFixIdx, '⑥ L-3：error_proof 排在 fix_proof 之前（CASE 稳序）');

  // ⑦ L-2：所有附件行都带 from_master 布尔 + source_correction_request_id
  const allAtt = [...mD.body.attachments, ...cD.body.attachments, ...sD.body.attachments];
  ok(allAtt.every(a => typeof a.from_master === 'boolean'), '⑦ L-2：所有附件行带 from_master 布尔（无 undefined）');
  ok(allAtt.every(a => Number.isInteger(Number(a.source_correction_request_id)) && Number(a.source_correction_request_id) > 0), '⑦ L-2：所有附件行带 source_correction_request_id');

  // ⑧ 护栏（M-2）：全库 attachment_type 只有 error_proof/fix_proof 两类（NOT NULL + 单一写入口，无脏数据）
  const types = await dbAllAsync(`SELECT DISTINCT attachment_type FROM correction_attachments`);
  ok(types.every(t => t.attachment_type === 'error_proof' || t.attachment_type === 'fix_proof'),
    `⑧ M-2 护栏：attachment_type 只有 error_proof/fix_proof 两类（实测 ${types.map(t => t.attachment_type).join('/')}）`);

  // ⑨ 三单组（M-6 link-new 第三系统）：主+子A+追加子B 都见同一主单 error_proof；三单各自 fix_proof 不互串
  //   用 link-new 在主单上追加第三系统单
  const ln = await reqJson('POST', `/api/corrections/${masterId}/link-new`, { source_system: 'OA 系统', location_info: '系统3：同字段错' }, ADMIN);
  ok(ln.status === 200 && ln.body.master_id === masterId && ln.body.id, `⑨ link-new 追加第三系统单 #${ln.body.id}`);
  const child3Id = ln.body.id;
  await assignDev(child3Id, DEV_S3.id);
  await reqMultipart(`/api/corrections/${child3Id}/complete`, {}, 'fix_s3.png', png, DEV_S3);
  const c3D = await GET(child3Id, DEV_S3);
  const c3Err = errOf(c3D), c3Fix = fixOf(c3D);
  ok(c3Err.length === 1 && c3Err[0].from_master === true && Number(c3Err[0].source_correction_request_id) === masterId && c3Err[0].original_name === 'err.png',
    '⑨ 追加子单B 也看到同一主单 error_proof（from_master=true）');
  ok(c3D.body.request.effective_error_proof_note === '错误证明：客户名称在两系统都显示乱码', '⑨ 追加子单B effective_error_proof_note=主单 note');
  ok(c3Fix.length === 1 && c3Fix[0].original_name === 'fix_s3.png', '⑨ 追加子单B 只见自己 fix_proof（fix_s3）');
  ok(!c3Fix.some(a => ['fix_s1.png', 'fix_s2.png'].includes(a.original_name)), '⑨ 追加子单B【不含】主单/子单A 的 fix_proof（三单 fix_proof 不互串）');
  // 复查：主单/子单A 视角依旧只见各自 fix_proof（追加 B 不污染）
  const mD2 = await GET(masterId, DEV_S1), cD2 = await GET(childId, DEV_S2);
  ok(fixOf(mD2).length === 1 && fixOf(mD2)[0].original_name === 'fix_s1.png', '⑨ 复查：主单仍只见自己 fix_proof（追加 B 不污染）');
  ok(fixOf(cD2).length === 1 && fixOf(cD2)[0].original_name === 'fix_s2.png', '⑨ 复查：子单A 仍只见自己 fix_proof');
  ok(errOf(mD2).length === 1 && errOf(cD2).length === 1, '⑨ 复查：主单/子单A 仍各见 1 个 error_proof（同主单一份）');

  srv.close();
  console.log(`\n✅ 全部 ${pass} 断言通过`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ 验证失败:', e.message); if (srv) try { srv.close(); } catch (_) {} process.exit(1); });
