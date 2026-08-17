// verify-correction-oa-gate-e2e.js — 数据修正建单字段体系优化 B1 块 e2e（router-mount + in-memory db）
//   方案：docs/local/数据修正/数据修正模块_OA号自动补全_方案_20260629_v1.5.md §2.2/§2.3/§2.6
//   覆盖：
//     ① validateInputOaNumber 纯函数单测（空/真实/非法格式全枚举，M-4/L-9/M-6）
//     ② 建单流程重排（H-1）：留空 OA + 前端传自定义 requesters[] → 后端静默忽略，强制业务方=建单人（H-2/M-7）
//     ③ 留空 OA 时业务方部门也强制 null（§2.1/§2.3，不采信前端 requester_dept）
//     ④ 建单人无可用姓名（display_name/username 均空）→ 400 SELF_REQUESTER_NAME_MISSING
//     ⑤ 真实 OA 号（纯数字）→ 既有 requesters[]/requester_dept 行为不变（回归保障）
//     ⑥ 非法 OA 格式（含 datafix- 前缀手填 / 字母混杂 / 数字类型）→ 400 INVALID_OA_NUMBER
//     ⑦ 跨系统建单留空 OA → 子单同样承接主单的"建单人自发现"身份（既有 common 传递机制不变）
//   require routes/corrections 真实 router + _internals（非复刻）。用法：node scripts/verify-correction-oa-gate-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-oagate-uploads-' + process.pid);
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

const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const ADMIN_NO_NAME = { id: 2, username: '', display_name: '', role: 'admin' };   // ④ 用：无可用姓名

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
    const boundary = '----OaGateCreateBoundary' + Math.floor(1e8 + Math.random() * 1e8);
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
  console.log('=== B1 块 OA 号格式闸 + 自发现自动业务方 e2e ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001'),(2,'','','admin',NULL)`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ① validateInputOaNumber 纯函数单测
  const V = I.validateInputOaNumber;
  ok(V(undefined).ok === true && V(undefined).mode === 'empty' && V(undefined).value === null, '①undefined → 留空模式');
  ok(V(null).ok === true && V(null).mode === 'empty', '①null → 留空模式');
  ok(V('').ok === true && V('').mode === 'empty', '①空串 → 留空模式');
  ok(V('   ').ok === true && V('   ').mode === 'empty', '①纯空白 → 留空模式');
  ok(V('364265').ok === true && V('364265').mode === 'real' && V('364265').value === '364265', '①纯数字 → 真OA模式');
  ok(V(' 364265 ').ok === true && V(' 364265 ').value === '364265', '①前后空白 trim 后纯数字 → 真OA模式');
  ok(V('00123').ok === true && V('00123').value === '00123', '①前导零原样保留（不按数值归一）');
  ok(V('1'.repeat(20)).ok === true, '①20 位数字（上限内）→ 放行');
  ok(V('1'.repeat(21)).ok === false && V('1'.repeat(21)).code === 'INVALID_OA_NUMBER', '①21 位数字（超上限）→ 400');
  ok(V('datafix-5').ok === false && V('datafix-5').code === 'INVALID_OA_NUMBER', '①手填 datafix- 前缀 → 400（M-6 隔离：入参校验不认落库特殊值）');
  ok(V('123abc').ok === false, '①数字混字母 → 400');
  ok(V('OA-123').ok === false, '①带 OA- 前缀 → 400（前端只传纯数字部分）');
  ok(V('一二三').ok === false, '①中文数字 → 400');
  ok(V('1e3').ok === false, '①科学计数法字符串 → 400');
  ok(V(123456).ok === false && V(123456).code === 'INVALID_OA_NUMBER', '①number 类型（非字符串）→ 400（L-9 防前导零丢失/科学计数）');

  // ② 留空 OA + 前端传自定义 requesters[] → 后端静默忽略，强制业务方=建单人（H-2/M-7）
  const c2 = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '留空OA测试', correction_type: 'single', reason: '留空OA静默覆盖测试原因',
    requesters: [{ name: '外部业务方甲', phone: '13800000099' }, { name: '外部业务方乙', phone: '13800000098' }],
    requester_dept: '外部部门',
  }, ADMIN);
  ok(c2.status === 200, `②留空 OA 建单成功（#${c2.body.id}）`);
  const row2 = await dbGetAsync('SELECT requester_name, requester_phone, requester_dept FROM correction_requests WHERE id=?', [c2.body.id]);
  ok(row2.requester_name === '管理员', `②主表 requester_name 被强制覆盖为建单人"管理员"（非"外部业务方甲"）`);
  ok(row2.requester_phone === null, '②主表 requester_phone 强制 null（H-2）');
  const rqs2 = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [c2.body.id]);
  ok(rqs2.length === 1 && rqs2[0].requester_name === '管理员', '②子表只写一条建单人记录（外部业务方甲/乙均未落库）');

  // ③ 留空 OA 时业务方部门也强制 null（§2.1/§2.3）
  ok(row2.requester_dept === null, '③留空 OA 时 requester_dept 强制 null（不采信前端"外部部门"）');

  // ④ 建单人无可用姓名（display_name/username 均空）→ 400 SELF_REQUESTER_NAME_MISSING
  const c4 = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '无姓名建单人测试', correction_type: 'single', reason: '无姓名建单人测试原因背景',
  }, ADMIN_NO_NAME);
  ok(c4.status === 400 && c4.body.code === 'SELF_REQUESTER_NAME_MISSING', `④建单人无可用姓名 → 400 SELF_REQUESTER_NAME_MISSING（实际 ${c4.status}/${c4.body.code}）`);

  // ⑤ 真实 OA 号（纯数字）→ 既有 requesters[]/requester_dept 行为不变（回归保障）
  const c5 = await reqMultipartCreate({
    source_system: 'BMS', location_info: '真实OA回归测试', correction_type: 'single', reason: '真实OA业务方不变测试原因',
    oa_number: '364265', requester_dept: '财务部',
    requesters: [{ name: '真实业务方甲', phone: '13800000001' }, { name: '真实业务方乙', phone: '' }],
  }, ADMIN);
  ok(c5.status === 200, `⑤真实 OA 建单成功（#${c5.body.id}）`);
  const row5 = await dbGetAsync('SELECT requester_name, requester_phone, requester_dept, oa_number FROM correction_requests WHERE id=?', [c5.body.id]);
  ok(row5.requester_name === '真实业务方甲' && row5.requester_dept === '财务部', '⑤真实 OA 场景：业务方姓名/部门均按前端传值（未被静默覆盖，回归不变）');
  const rqs5 = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [c5.body.id]);
  ok(rqs5.length === 2, '⑤真实 OA 场景：多业务方子表仍完整写入（回归不变）');

  // ⑥ 非法 OA 格式 → 400 INVALID_OA_NUMBER（含手填 datafix- 前缀——旧 A 块方案的 RESERVED_OA_PREFIX 已被本闸吸收，v1.5 §3 末段）
  const c6a = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'x', correction_type: 'single', reason: '非法格式测试原因背景', oa_number: 'datafix-99' }, ADMIN);
  ok(c6a.status === 400 && c6a.body.code === 'INVALID_OA_NUMBER', `⑥手填 datafix-99 → 400 INVALID_OA_NUMBER（实际 ${c6a.status}/${c6a.body.code}）`);
  const c6b = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'x', correction_type: 'single', reason: '非法格式测试原因背景', oa_number: 'ABC123' }, ADMIN);
  ok(c6b.status === 400 && c6b.body.code === 'INVALID_OA_NUMBER', '⑥字母数字混合 → 400 INVALID_OA_NUMBER');
  const c6c = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'x', correction_type: 'single', reason: '非法格式测试原因背景', oa_number: 123456 }, ADMIN);
  ok(c6c.status === 400 && c6c.body.code === 'INVALID_OA_NUMBER', '⑥JSON number 类型 oa_number → 400 INVALID_OA_NUMBER');

  // ⑦ 跨系统建单留空 OA → 子单承接主单"建单人自发现"身份（既有 common 传递机制）
  const c7 = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '跨系统留空OA主单', correction_type: 'single', reason: '跨系统留空OA测试原因背景',
    cross_system: true, system2: { source_system: 'HRD', location_info: '跨系统留空OA子单' },
    requesters: [{ name: '外部业务方丙' }],   // 应被静默忽略
  }, ADMIN);
  ok(c7.status === 200 && c7.body.child_ids.length === 1, '⑦跨系统留空 OA 建单成功');
  const childRow7 = await dbGetAsync('SELECT requester_name, requester_dept FROM correction_requests WHERE id=?', [c7.body.child_ids[0]]);
  ok(childRow7.requester_name === '管理员' && childRow7.requester_dept === null, '⑦子单同样承接建单人身份（非外部业务方丙），部门 null');

  console.log(`\n=== B1 块 OA 号格式闸 e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
