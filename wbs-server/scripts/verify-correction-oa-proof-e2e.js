// verify-correction-oa-proof-e2e.js — 数据修正建单字段体系优化 B2 块 e2e（router-mount + in-memory db）
//   方案：docs/local/数据修正/数据修正模块_OA号自动补全_方案_20260629_v1.5.md §2.4/§2.5（H-3/M-8/L-10）
//   覆盖：
//     ① 真OA + multipart + 1 文件 → 200，附件落库 attachment_type=oa_proof，详情可查
//     ② 真OA + multipart 但 0 文件 → 400 OA_PROOF_REQUIRED，无附件落库，_pending 暂存目录被清理
//     ③ 真OA + JSON（非 multipart，multer no-op）→ 同样 400 OA_PROOF_REQUIRED（无文件通道天然拦截）
//     ④ 通用 /:id/attachments 端点拒绝 attachment_type=oa_proof（M-8，防绕过"建单同步"审计门槛）
//     ⑤ 跨系统真OA建单：oa_proof 只挂主单，子单详情查自身为空（L-10 单级不合并）
//     ⑥ 留空 OA（自发现）却硬塞 oa_proof_files（API 绕过前端隐藏区）→ 建单仍成功但文件被丢弃，
//        不落库、_pending 暂存目录被清理（非预期组合的防御性收尾）
//     ⑦ 多文件（3 张）oa_proof 同步上传全部落库
//   require routes/corrections 真实 router + _internals（非复刻）。用法：node scripts/verify-correction-oa-proof-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');

const TMP_UPLOAD = path.join(os.tmpdir(), 'corr-oaproof-uploads-' + process.pid);
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
// 通用 multipart POST（field 名可配，供 oa_proof_files/files 两种端点复用）
function reqMultipart(p, fields, fileField, fileCount, user) {
  return new Promise((resolve) => {
    const boundary = '----OaProofBoundary' + Math.floor(1e8 + Math.random() * 1e8);
    const chunks = [];
    for (const [k, val] of Object.entries(fields || {})) {
      if (val === undefined || val === null) continue;
      const strVal = (typeof val === 'object') ? JSON.stringify(val) : String(val);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${strVal}\r\n`));
    }
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    for (let i = 0; i < fileCount; i++) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="proof${i}.png"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(png);
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
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
function countFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) n += countFilesRecursive(p);
    else n++;
  }
  return n;
}

(async () => {
  console.log('=== B2 块 OA 截图强制（建单同步上传）e2e ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001')`);
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api/corrections', mod.router);
  srv = app.listen(0);
  PORT = srv.address().port;

  // ① 真OA + multipart + 1 文件 → 200
  const c1 = await reqMultipart('/api/corrections',
    { source_system: 'BMS', location_info: '真OA截图测试', correction_type: 'single', reason: '真OA截图强制测试原因', oa_number: '365001', requester_name: '业务方甲' },
    'oa_proof_files', 1, ADMIN);
  ok(c1.status === 200 && c1.body.id, `①真OA+1张截图建单成功（#${c1.body.id}）`);
  const att1 = await dbAllAsync(`SELECT * FROM correction_attachments WHERE correction_request_id=? AND attachment_type='oa_proof'`, [c1.body.id]);
  ok(att1.length === 1 && att1[0].uploaded_by === 1, '①oa_proof 落库 1 条，uploaded_by=建单人');
  const d1 = await reqJson('GET', `/api/corrections/${c1.body.id}`, null, ADMIN);
  const d1OaProofs = (d1.body.attachments || []).filter(a => a.attachment_type === 'oa_proof');
  ok(d1OaProofs.length === 1 && d1OaProofs[0].from_master === false, '①详情接口可查到 oa_proof，from_master=false（单级非合并）');

  // ② 真OA + multipart 但 0 文件 → 400 OA_PROOF_REQUIRED
  const c2 = await reqMultipart('/api/corrections',
    { source_system: 'BMS', location_info: '缺截图测试', correction_type: 'single', reason: '缺OA截图测试原因背景', oa_number: '365002', requester_name: '业务方乙' },
    'oa_proof_files', 0, ADMIN);
  ok(c2.status === 400 && c2.body.code === 'OA_PROOF_REQUIRED', `②真OA无截图 → 400 OA_PROOF_REQUIRED（实际 ${c2.status}/${c2.body.code}）`);
  const att2 = await dbAllAsync(`SELECT * FROM correction_attachments WHERE attachment_type='oa_proof'`);
  ok(att2.length === 1, '②失败建单未新增 oa_proof 落库（仍只有①那 1 条）');

  // ③ 真OA + JSON（非 multipart）→ 同样 400 OA_PROOF_REQUIRED（multer no-op，req.files 恒空）
  const c3 = await reqJson('POST', '/api/corrections', { source_system: 'BMS', location_info: 'JSON真OA测试', correction_type: 'single', reason: 'JSON真OA无文件通道测试原因', oa_number: '365003', requester_name: '业务方丙' }, ADMIN);
  ok(c3.status === 400 && c3.body.code === 'OA_PROOF_REQUIRED', `③JSON 传真实 OA（无文件通道）→ 400 OA_PROOF_REQUIRED（实际 ${c3.status}/${c3.body.code}）`);

  // ④ 通用 /:id/attachments 端点拒绝 attachment_type=oa_proof（M-8）——防绕过"建单同步"审计门槛补传
  const c4att = await reqMultipart(`/api/corrections/${c1.body.id}/attachments`, { attachment_type: 'oa_proof' }, 'files', 1, ADMIN);
  ok(c4att.status === 400 && c4att.body.code === 'INVALID_ATTACHMENT_TYPE', `④通用附件端点拒 oa_proof → 400 INVALID_ATTACHMENT_TYPE（实际 ${c4att.status}/${c4att.body.code}）`);

  // ⑤ 跨系统真OA建单：oa_proof 只挂主单，子单详情查自身为空（L-10）
  const c5 = await reqMultipart('/api/corrections',
    { source_system: 'BMS', location_info: '跨系统真OA主单', correction_type: 'single', reason: '跨系统真OA截图单级测试原因', oa_number: '365005', requester_name: '业务方丁',
      cross_system: true, system2: { source_system: 'HRD', location_info: '跨系统真OA子单' } },
    'oa_proof_files', 1, ADMIN);
  ok(c5.status === 200 && c5.body.child_ids && c5.body.child_ids.length === 1, `⑤跨系统真OA建单成功（主单#${c5.body.master_id}+子单#${c5.body.child_ids && c5.body.child_ids[0]}）`);
  const masterAtt = await dbAllAsync(`SELECT * FROM correction_attachments WHERE correction_request_id=? AND attachment_type='oa_proof'`, [c5.body.master_id]);
  const childAtt = await dbAllAsync(`SELECT * FROM correction_attachments WHERE correction_request_id=? AND attachment_type='oa_proof'`, [c5.body.child_ids[0]]);
  ok(masterAtt.length === 1, '⑤oa_proof 只挂主单（DB 层）');
  ok(childAtt.length === 0, '⑤子单自身 DB 无 oa_proof 记录（未复制）');
  const childDetail = await reqJson('GET', `/api/corrections/${c5.body.child_ids[0]}`, null, ADMIN);
  const childOaProofs = (childDetail.body.attachments || []).filter(a => a.attachment_type === 'oa_proof');
  ok(childOaProofs.length === 0, '⑤子单详情接口查自身 oa_proof 为空（L-10：不像 error_proof 那样合并主单）');
  const masterDetail = await reqJson('GET', `/api/corrections/${c5.body.master_id}`, null, ADMIN);
  const masterOaProofs = (masterDetail.body.attachments || []).filter(a => a.attachment_type === 'oa_proof');
  ok(masterOaProofs.length === 1, '⑤主单详情接口查自身 oa_proof 有 1 条');

  // ⑥ 留空 OA（自发现）却硬塞 oa_proof_files（API 绕过前端隐藏区）→ 建单仍成功，文件被丢弃不落库
  const pendingNewDir = path.join(TMP_UPLOAD, 'correction', '_pending', '_new');
  const beforeCount = countFilesRecursive(pendingNewDir);
  const c6 = await reqMultipart('/api/corrections',
    { source_system: 'BMS', location_info: '留空OA却塞文件测试', correction_type: 'single', reason: '留空OA塞文件防御测试原因' },
    'oa_proof_files', 1, ADMIN);
  ok(c6.status === 200 && c6.body.id, `⑥留空OA+硬塞文件仍建单成功（#${c6.body.id}，自发现模式不读文件）`);
  const att6 = await dbAllAsync(`SELECT * FROM correction_attachments WHERE correction_request_id=?`, [c6.body.id]);
  ok(att6.length === 0, '⑥文件未被持久化（自发现分支不读 req.files，无 oa_proof 落库）');
  const afterCount = countFilesRecursive(pendingNewDir);
  ok(afterCount <= beforeCount, `⑥_pending/_new/ 暂存目录已清理（不残留孤儿文件；前 ${beforeCount} 后 ${afterCount}）`);

  // ⑦ 多文件（3 张）oa_proof 同步上传全部落库
  const c7 = await reqMultipart('/api/corrections',
    { source_system: 'BMS', location_info: '多文件OA截图测试', correction_type: 'single', reason: '多文件OA截图测试原因背景', oa_number: '365007', requester_name: '业务方戊' },
    'oa_proof_files', 3, ADMIN);
  ok(c7.status === 200, `⑦多文件真OA建单成功（#${c7.body.id}）`);
  const att7 = await dbAllAsync(`SELECT * FROM correction_attachments WHERE correction_request_id=? AND attachment_type='oa_proof'`, [c7.body.id]);
  ok(att7.length === 3, `⑦3 张 oa_proof 全部落库（实得 ${att7.length}）`);

  // ⑧ 关键回归修复验证：真OA建单同步指派(assigned_to)，事务已 COMMIT（含 oa_proof 已落库落盘）后，
  //   若 correctionTransition（指派）内部失败 → 最外层 catch 必须【不】把已提交成功的 oa_proof 记录/文件
  //   误删（persistedOaProof 须在 COMMIT 后清空，否则会把"单已建成功但截图凭空消失"的数据不一致 bug 带上线）。
  //   用独立 db + 包装 dbRunAsync 拦截 correctionTransition 内部指派 UPDATE，制造"COMMIT 后才失败"的场景。
  console.log('\n--- ⑧ 关键修复回归：post-commit 指派失败不得回滚已提交的 oa_proof ---');
  const TMP_UPLOAD2 = path.join(os.tmpdir(), 'corr-oaproof-uploads2-' + process.pid);
  fs.mkdirSync(TMP_UPLOAD2, { recursive: true });
  const db2 = new sqlite3.Database(':memory:');
  let interceptAssignUpdate = false;
  const dbRunAsync2 = (q, p = []) => new Promise((res, rej) => {
    if (interceptAssignUpdate && /UPDATE correction_requests SET .*assigned_to.*WHERE id = \? AND status = \?/s.test(q)) {
      return rej(new Error('mock 指派 UPDATE 失败（模拟 COMMIT 后才发生的失败，如并发状态变化导致的 DB 层异常）'));
    }
    db2.run(q, p, function (e) { e ? rej(e) : res(this); });
  });
  const dbGetAsync2 = (q, p = []) => new Promise((res, rej) => db2.get(q, p, (e, r) => e ? rej(e) : res(r)));
  const dbAllAsync2 = (q, p = []) => new Promise((res, rej) => db2.all(q, p, (e, r) => e ? rej(e) : res(r)));
  const deps2 = { ...deps, db: db2, dbRunAsync: dbRunAsync2, dbGetAsync: dbGetAsync2, dbAllAsync: dbAllAsync2, UPLOAD_DIR: TMP_UPLOAD2,
    safeDeleteFileSync: (rel) => { try { fs.unlinkSync(path.join(TMP_UPLOAD2, rel)); } catch (_) {} } };
  const mod2 = require('../routes/corrections')(deps2);
  const I2 = mod2._internals;
  await dbRunAsync2(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync2(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001'),(50,'dev50','开发50','user','13900000050')`);
  mod2.initSchema();
  const t0 = Date.now();
  while (!I2.CORRECTION_SCHEMA_STATE.ready) {
    if (I2.CORRECTION_SCHEMA_STATE.error) throw new Error('schema2 error: ' + I2.CORRECTION_SCHEMA_STATE.error);
    if (Date.now() - t0 > 3000) throw new Error('readiness2 timeout');
    await new Promise(r => setTimeout(r, 30));
  }
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/corrections', mod2.router);
  const srv2 = app2.listen(0);
  const PORT2 = srv2.address().port;
  function reqMultipart2(fields, fileField, fileCount, user) {
    return new Promise((resolve) => {
      const boundary = '----OaProofFixBoundary' + Math.floor(1e8 + Math.random() * 1e8);
      const chunks = [];
      for (const [k, val] of Object.entries(fields || {})) {
        if (val === undefined || val === null) continue;
        const strVal = (typeof val === 'object') ? JSON.stringify(val) : String(val);
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${strVal}\r\n`));
      }
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      for (let i = 0; i < fileCount; i++) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="proof${i}.png"\r\nContent-Type: image/png\r\n\r\n`));
        chunks.push(png);
        chunks.push(Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const bodyBuf = Buffer.concat(chunks);
      const r = http.request({ host: 'localhost', port: PORT2, method: 'POST', path: '/api/corrections',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64') } },
        (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
      r.on('error', e => resolve({ status: 0, error: e.message }));
      r.write(bodyBuf); r.end();
    });
  }
  interceptAssignUpdate = true;
  const c8 = await reqMultipart2(
    { source_system: 'BMS', location_info: '指派失败回归测试', correction_type: 'single', reason: '指派失败不回滚oa_proof回归测试原因', oa_number: '365008', requester_name: '业务方己', assigned_to: 50 },
    'oa_proof_files', 1, ADMIN);
  ok(c8.status === 500, `⑧建单+指派，指派内部失败 → 500（实际 ${c8.status}，非本次修复关注点，只关注副作用）`);
  const allRows8 = await dbAllAsync2(`SELECT id, status FROM correction_requests`);
  ok(allRows8.length === 1 && allRows8[0].status === 'PENDING_ASSIGN', `⑧修正单本体仍存在且停留在 PENDING_ASSIGN（指派事务自身 ROLLBACK，主建单事务早已 COMMIT，未被波及，实得 ${JSON.stringify(allRows8)}）`);
  const newId8 = allRows8[0].id;
  const att8 = await dbAllAsync2(`SELECT * FROM correction_attachments WHERE correction_request_id=? AND attachment_type='oa_proof'`, [newId8]);
  ok(att8.length === 1, `⑧【关键修复验证】oa_proof 附件记录未被误删，仍为 1 条（修复前会被最外层 catch 误回滚成 0 条）`);
  const physicalPath8 = path.join(TMP_UPLOAD2, 'correction', String(newId8), path.basename(att8[0].file_name));
  ok(fs.existsSync(physicalPath8), `⑧【关键修复验证】oa_proof 物理文件仍存在于磁盘（未被误删）：${physicalPath8}`);

  srv2.close(); db2.close();
  try { fs.rmSync(TMP_UPLOAD2, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n=== B2 块 OA 截图强制 e2e 通过：${pass} 断言 ===`);
  srv.close(); db.close();
  try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {}
})().catch(e => { console.error('✗ FAIL:', e.message, e.stack); try { srv && srv.close(); } catch (_) {} db.close(); try { fs.rmSync(TMP_UPLOAD, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
