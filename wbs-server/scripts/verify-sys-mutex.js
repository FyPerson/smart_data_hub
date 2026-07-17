// 验证脚本：系统迭代 C4.5 状态机串行化 mutex（sysTxnMutex）
//   用法：node scripts/verify-sys-mutex.js
//
// 目的：证明并发 sys 事务被 mutex 串行化——**无 nested-transaction 500、无部分提交脏态**。
//   对照 C4 审 ultracode CONFIRMED：并发双击 publish 原会交错→R2 ROLLBACK 回滚 R1 事务→
//   "已发布批次 release_note=NULL 违反闸门③"脏态 + 双 500。加锁后应：恰一胜（200）一负（409 非 500），脏态不可达。
// in-process express app（挂真实 router）+ 内存库（parallel 模式，与生产同源）+ 自签 token。
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-mutex-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); } catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => { let n = 0; const t = setInterval(() => {
    if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
    else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
    else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
  }, 10); });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const png = Buffer.from('89504e470d0a1a0a', 'hex');
// multipart 上传（F3：附件写串行化证明）
function upload(p, tok, fields, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysMutexBoundary' + (p.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(png); chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
let passed = 0; const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 推到「开发中」（create→schedule→assign→estimate），供附件上传
async function seedInProgress() {
  const id = (await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'a', system_name: 'BMS', source: '内部' })).body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  return id;
}

async function seedToReady() {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付完成（占位理由）' });
  await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });

  // ── 1. 并发建单（30 并发）：全 201 + id 互异 + 零 500（无 nested-transaction 交错）──────────
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, (_, k) =>
    call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'concurrent-' + k, system_name: 'BMS', source: '内部' })));
  const created201 = results.filter(r => r.status === 201);
  const errs500 = results.filter(r => r.status === 500);
  assert.strictEqual(errs500.length, 0, `并发建单不应有 500（nested-transaction），实际 ${errs500.length} 个：` + JSON.stringify(errs500.map(e => e.body)));
  assert.strictEqual(created201.length, N, `${N} 并发建单应全 201，实际 ${created201.length}`);
  const ids = new Set(created201.map(r => r.body.id));
  assert.strictEqual(ids.size, N, '并发建单 id 应全互异（无丢失/覆盖）');
  const dbCount = (await get("SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE 'concurrent-%'")).c;
  assert.strictEqual(dbCount, N, `库内应恰好 ${N} 条并发单（无部分提交丢失）`);
  ok(`并发建单 ${N} 个：全 201 + id 互异 + 库内 ${N} 条 + 零 500（mutex 串行化无交错）`);

  // ── 2. ⭐ 并发双击 publish（C4 审 finding 直击场景）──────────
  //   批次含 1 待上线单，两个并发 publish（都带 release_note/version_tag）→ 恰一胜（200）一负（409 非 500），
  //   且批次终态=已发布 + release_note 完好（非 NULL，不违反闸门③）。
  const relId = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
  const iss = await seedToReady();
  await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [iss] });
  const [p1, p2] = await Promise.all([
    call('POST', `/api/sys-releases/${relId}/publish`, adminTok, { release_note: '并发上线说明', version_tag: 'v9.9.9' }),
    call('POST', `/api/sys-releases/${relId}/publish`, adminTok, { release_note: '并发上线说明', version_tag: 'v9.9.9' }),
  ]);
  const pubStatuses = [p1.status, p2.status].sort();
  assert.deepStrictEqual(pubStatuses, [200, 409], `并发双击 publish 应恰一 200 一 409，实际 ${JSON.stringify(pubStatuses)}（500=nested-transaction 脏态）`);
  const loser = [p1, p2].find(r => r.status === 409);
  assert.strictEqual(loser.body.code, 'RELEASE_NOT_PLANNING', '败者应为 RELEASE_NOT_PLANNING（非 500）');
  const relRow = await get('SELECT status, release_note, version_tag FROM sys_releases WHERE id=?', [relId]);
  assert.strictEqual(relRow.status, '已发布', '批次终态=已发布');
  assert.strictEqual(relRow.release_note, '并发上线说明', '⭐ release_note 完好非 NULL（脏态不可达，闸门③ 不被违反）');
  assert.strictEqual(relRow.version_tag, 'v9.9.9', 'version_tag 完好');
  const issRow = await get('SELECT status, released_at FROM sys_issues WHERE id=?', [iss]);
  assert.strictEqual(issRow.status, '已上线', '组内单翻已上线');
  assert.ok(issRow.released_at, 'released_at 落');
  const relTl = await all("SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'", [iss]);
  assert.strictEqual(relTl.length, 1, 'release timeline 恰 1 条（无重复写入）');
  ok('⭐ 并发双击 publish：恰一 200 一 409（非 500）+ 批次已发布 release_note 完好 + 单翻已上线 + release timeline 仅 1 条（finding 脏态不可达）');

  // ── 3. 并发混合事务（建单 + 建批次 + schedule 各 10）：零 500 ──────────
  const drafts = await Promise.all(Array.from({ length: 10 }, (_, k) =>
    call('POST', '/api/sys-issues', adminTok, { type: 'improvement', title: 'mix-' + k, system_name: 'OA', source: '内部' })));
  const mixed = await Promise.all([
    ...Array.from({ length: 10 }, (_, k) => call('POST', '/api/sys-releases', adminTok, { title: 'mix-rel-' + k })),
    ...drafts.map(d => call('POST', `/api/sys-issues/${d.body.id}/schedule`, adminTok, {})),
  ]);
  const mix500 = mixed.filter(r => r.status === 500);
  assert.strictEqual(mix500.length, 0, '并发混合事务零 500，实际：' + JSON.stringify(mix500.map(e => e.body)));
  const allScheduled = mixed.filter(r => r.body && r.body.status === '已排期').length;
  assert.strictEqual(allScheduled, 10, '10 个 schedule 全成功（已排期）');
  ok('并发混合事务（建单/建批次/schedule 各 10）：零 500 + schedule 全成');

  // ── 4. F3a：事务内错误早退（inline sysRollback return）后锁不泄漏 ──────────
  const badRel = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
  for (let k = 0; k < 5; k++) {
    const r = await call('POST', `/api/sys-releases/${badRel}/add-issues`, adminTok, { issue_ids: [990000 + k] });   // 不存在/不可加 → 409 inline rollback
    assert.strictEqual(r.status, 409, '不可加单 → 409 inline rollback');
  }
  const afterErr = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'after-err', system_name: 'BMS', source: '内部' });
  assert.strictEqual(afterErr.status, 201, '错误早退 5 次后建单仍 201（inline rollback 未泄漏锁）');
  ok('F3a：事务内错误早退后建单成功（inline sysRollback 锁不泄漏）');

  // ── 5. ⭐ F3b：附件写串行化（F1 修复直证）——并发上传交付附件 + 并发建单，全成 + 行全持久 + 零 500 ──────────
  const att1 = await seedInProgress(); const att2 = await seedInProgress();
  const attRes = await Promise.all([
    ...Array.from({ length: 6 }, (_, k) => upload(`/api/sys-issues/${att1}/attachments`, devTok, { attachment_type: 'delivery' }, `a${k}.png`)),
    ...Array.from({ length: 6 }, (_, k) => upload(`/api/sys-issues/${att2}/attachments`, devTok, { attachment_type: 'delivery' }, `b${k}.png`)),
    ...Array.from({ length: 6 }, (_, k) => call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'cc' + k, system_name: 'BMS', source: '内部' })),
  ]);
  const att500 = attRes.filter(r => r.status === 500);
  assert.strictEqual(att500.length, 0, '并发上传+建单零 500（附件 INSERT 已纳入 mutex 不交错），实际：' + JSON.stringify(att500.map(e => e.body)));
  const okUploads = attRes.filter(r => r.status === 200 && r.body && r.body.ok).length;
  assert.strictEqual(okUploads, 12, '12 个并发上传全 200');
  const rowCnt = (await get("SELECT COUNT(*) AS c FROM sys_issue_attachments WHERE issue_id IN (?,?) AND status='active'", [att1, att2])).c;
  assert.strictEqual(rowCnt, 12, `两单共 12 行附件全持久（无被并发事务回滚丢失），实际 ${rowCnt}`);
  ok('⭐ F3b：并发上传 12 附件 + 并发建单 6：全成 + 12 行全持久 + 零 500（附件写已串行化，不被他事务回滚）');

  console.log(`\n✅ verify-sys-mutex 全部通过（${passed} 项断言）`);
  server.close();
}
main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
