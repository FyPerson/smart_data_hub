// verify-correction-datafix-e2e.js — 数据修正建单字段体系优化 A 块 e2e（router-mount + in-memory db，不碰真库）
//   方案：docs/local/数据修正/数据修正模块_OA号自动补全_方案_20260629_v1.5.md §3（不变，见 v1.3 §4 / v1.1 §4）
//   覆盖：
//     ① 建单空 oa_number → 自动补 'datafix-{自身id}'（H-2，UPDATE await + changes===1 + WHERE oa_number IS NULL 双条件）
//     ② 建单真实 oa_number → 原样落库，不触发补号
//     ③ 跨系统建单空 oa_number → 主单/子单【各自独立】生成 'datafix-{own id}'，不继承（H-1）
//     ④ 跨系统建单真实 oa_number → 主单/子单沿用同一真实号（既有行为不变，回归保障）
//     ⑤ 响应体带 oa_number: finalOaNumber（H-2"贯穿...响应"）
//   require routes/corrections 真实 router + _internals（非复刻）。用法：node scripts/verify-correction-datafix-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-datafix-uploads-' + process.pid);
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
// B2（OA 截图强制·建单同步上传，H-3）：真OA模式建单须走 multipart 且带 ≥1 张 oa_proof_files；
//   本 helper 固定附一张最小 PNG（内容不重要，测试只关心 fileFilter 按扩展名放行），
//   字段值对象/数组一律 JSON.stringify（对齐前端 buildCorrectionFormData + 后端 parseMaybeJsonField 契约）。
function reqMultipartCreate(fields, user) {
  return new Promise((resolve) => {
    const boundary = '----DatafixCreateBoundary' + Math.floor(1e8 + Math.random() * 1e8);
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
  console.log('=== A 块 datafix 占位号自动补全 e2e ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ① 空 oa_number → 自动补 datafix-{id}
  const c1 = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '空OA测试', correction_type: 'single', reason: '空OA自动补号测试原因', requester_name: '业务方甲',
  }, ADMIN);
  ok(c1.status === 200 && c1.body.id, `①建单成功（#${c1.body.id}）`);
  ok(c1.body.oa_number === `datafix-${c1.body.id}`, `①响应体 oa_number=datafix-${c1.body.id}（H-2 贯穿响应）`);
  const row1 = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [c1.body.id]);
  ok(row1.oa_number === `datafix-${c1.body.id}`, `①DB 落库 oa_number=datafix-${c1.body.id}`);

  // ② 真实 oa_number → 原样落库，不补号
  const c2 = await reqMultipartCreate({
    source_system: 'BMS', location_info: '真实OA测试', correction_type: 'single', reason: '真实OA原样落库测试原因', oa_number: '364265', requester_name: '业务方乙',
  }, ADMIN);
  ok(c2.status === 200 && c2.body.oa_number === '364265', '②真实 oa_number 响应体原样返回（不触发补号）');
  const row2 = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [c2.body.id]);
  ok(row2.oa_number === '364265', '②DB 落库原样保留真实 oa_number');

  // ③ 跨系统 + 空 oa_number → 主单/子单各自独立生成 datafix-{own id}（H-1，不继承）
  const c3 = await reqJson('POST', '/api/corrections', {
    source_system: 'BMS', location_info: '跨系统空OA主单', correction_type: 'single', reason: '跨系统空OA测试原因背景', requester_name: '业务方丙',
    cross_system: true, system2: { source_system: 'CRM', location_info: '跨系统空OA子单' },
  }, ADMIN);
  ok(c3.status === 200 && c3.body.cross_system === true && c3.body.child_ids.length === 1, '③跨系统建单成功（主单+1子单）');
  const masterId = c3.body.master_id, childId = c3.body.child_ids[0];
  ok(c3.body.oa_number === `datafix-${masterId}`, `③响应体主单 oa_number=datafix-${masterId}`);
  const masterRow = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [masterId]);
  const childRow = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [childId]);
  ok(masterRow.oa_number === `datafix-${masterId}`, `③主单 DB oa_number=datafix-${masterId}`);
  ok(childRow.oa_number === `datafix-${childId}`, `③子单 DB oa_number=datafix-${childId}（独立生成，未继承主单占位号）`);
  ok(childRow.oa_number !== masterRow.oa_number, '③H-1：子单占位号与主单不同（各自独立，非继承）');

  // ④ 跨系统 + 真实 oa_number → 主单/子单沿用同一真实号（既有行为不变，回归保障）
  const c4 = await reqMultipartCreate({
    source_system: 'BMS', location_info: '跨系统真实OA主单', correction_type: 'single', reason: '跨系统真实OA回归测试原因', requester_name: '业务方丁',
    oa_number: '778899', cross_system: true, system2: { source_system: 'HRD', location_info: '跨系统真实OA子单' },
  }, ADMIN);
  ok(c4.status === 200, '④跨系统真实 OA 建单成功');
  const masterRow4 = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [c4.body.master_id]);
  const childRow4 = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [c4.body.child_ids[0]]);
  ok(masterRow4.oa_number === '778899' && childRow4.oa_number === '778899', '④真实 OA 场景：主单/子单沿用同一真实号（回归不变）');

  // ⑤ 前端 formatOaNo datafix 特判（从 Data_Correction.html 提取真实实现，非复刻——防止手写副本漂移）
  const htmlPath = path.join(__dirname, '..', 'public', 'Data_Correction.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const oaCoreMatch = html.match(/function oaCore\(raw\) \{[\s\S]*?\n {8}\}/);
  const formatOaNoMatch = html.match(/function formatOaNo\(raw\) \{[\s\S]*?\n {8}\}/);
  ok(!!oaCoreMatch && !!formatOaNoMatch, '⑤从 Data_Correction.html 成功提取 oaCore/formatOaNo 源码');
  // 'use strict' 下直接 eval 函数声明不会泄漏到外层作用域，改用 new Function 显式构造 + 挂 global 供 formatOaNo 内部调用 oaCore
  const oaCoreBody = oaCoreMatch[0].replace(/^function oaCore\(raw\) \{/, '').replace(/\}$/, '');
  const formatOaNoBody = formatOaNoMatch[0].replace(/^function formatOaNo\(raw\) \{/, '').replace(/\}$/, '');
  global.oaCore = new Function('raw', oaCoreBody);
  global.formatOaNo = new Function('raw', formatOaNoBody);
  const formatOaNo = global.formatOaNo;
  ok(formatOaNo('datafix-22') === 'datafix-22', '⑤formatOaNo(datafix-22) 原样显示（不套 OA- 前缀）');
  ok(formatOaNo('DATAFIX-9') === 'DATAFIX-9', '⑤formatOaNo 大小写不敏感原样显示');
  ok(formatOaNo('364265') === 'OA-364265', '⑤formatOaNo 真实号仍走 OA- 归一规则（回归不变）');
  ok(formatOaNo('') === '' && formatOaNo(null) === '' && formatOaNo(undefined) === '', '⑤formatOaNo 空值仍返回空白（回归不变）');

  console.log(`\n=== A 块 datafix e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
