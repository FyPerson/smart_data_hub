// 验证脚本：系统迭代「物理删除迭代单」DELETE /sys-issues/:id（admin 专用·不可逆·2026-07-07）
//   用法：node scripts/verify-sys-delete.js
//
// in-process express app（挂真实 router）+ 内存库 + 真实临时落盘 + 自签 token，覆盖：
//   1. 级联删除：主表 sys_issues + 三子表（timeline/attachments/dev_assignees）全清 + 附件磁盘文件删除 → 零残留
//      （PRAGMA foreign_keys OFF，CASCADE 不生效，全靠 handler 手动级联——本例正是防孤儿脏数据的回归）
//   2. 守卫①：有派生子单（被引用为 origin）→ 409 SYS_ISSUE_HAS_DERIVED，母单保留；子单本身可删（不影响母单）
//   3. 守卫②：已挂上线批次（release_id）→ 409 SYS_ISSUE_IN_RELEASE，单保留
//   4. 边界：不存在 → 404；非 admin → 403（requireAdmin 中间件先拦）；非法 id → 400
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./_sys-attach-test-deps');   // 真实临时落盘根：附件磁盘文件删除断言用

const SECRET = 'verify-sys-delete-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // UPLOAD_DIR/safeDeleteFileSync/... + 通知/建群 stub（过工厂 deps 校验）
});
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const cnt = async (sql, params = []) => (await get(sql, params)).n;

// 直接 INSERT 造一个迭代单（最小必填列，其余走 DEFAULT）；extra 可带 origin_issue_id / release_id
async function insIssue(id, extra = {}) {
  const cols = ['id', 'type', 'status', 'title', 'system_name', 'source', 'created_by', 'created_by_name'];
  const vals = [id, extra.type || 'bug', extra.status || '待处理', extra.title || ('单' + id), 'BMS', '内部', 1, 'admin'];
  if (extra.origin_issue_id !== undefined) { cols.push('origin_issue_id'); vals.push(extra.origin_issue_id); }
  if (extra.release_id !== undefined) { cols.push('release_id'); vals.push(extra.release_id); }
  await run(`INSERT INTO sys_issues (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready');

  try {
    // ── [1] 级联删除完整性 + 附件磁盘文件 ──────────
    await insIssue(100, { title: '待删单' });
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (100,'created',1,'admin'),(100,'assign',1,'admin')`);
    await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, notify_status, notify_message_key) VALUES (100,5,'开发王',1,'sent','k1'),(100,6,'开发李',0,'sent','k2')`);
    const attDir = path.join(UPLOAD_DIR, 'sys-iteration', '100');
    fs.mkdirSync(attDir, { recursive: true });
    const attAbs = path.join(attDir, 'f.png');
    fs.writeFileSync(attAbs, Buffer.from('89504e470d0a1a0a', 'hex'));
    await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (100,'delivery','sys-iteration/100/f.png','f.png',5,'开发王')`);

    let r = await call('DELETE', '/api/sys-issues/100', adminTok);
    assert.strictEqual(r.status, 200, '删除应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true, 'body.ok');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=100'), 0, '主表残留');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issue_timeline WHERE issue_id=100'), 0, 'timeline 残留');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issue_attachments WHERE issue_id=100'), 0, '附件行残留');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issue_dev_assignees WHERE issue_id=100'), 0, '协作开发行残留');
    assert.strictEqual(fs.existsSync(attAbs), false, '附件磁盘文件残留');
    ok('级联删除：主表 + timeline + 附件行 + 协作开发行全清 + 附件磁盘文件删除（零残留）');

    // ── [2] 守卫①：有派生子单 → 409，母单保留；子单可删 ──────────
    await insIssue(200, { title: '母单' });
    await insIssue(201, { title: '派生子单', origin_issue_id: 200 });
    r = await call('DELETE', '/api/sys-issues/200', adminTok);
    assert.strictEqual(r.status, 409, '母单删除应 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'SYS_ISSUE_HAS_DERIVED', 'code');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=200'), 1, '母单被误删');
    ok('守卫①：有派生子单 → 409 SYS_ISSUE_HAS_DERIVED，母单保留');

    r = await call('DELETE', '/api/sys-issues/201', adminTok);
    assert.strictEqual(r.status, 200, '子单应可删, got ' + r.status);
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=201'), 0, '子单未删');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=200'), 1, '删子单误伤母单');
    ok('子单可删（origin 指向母单，删子单不影响母单）');

    r = await call('DELETE', '/api/sys-issues/200', adminTok);
    assert.strictEqual(r.status, 200, '派生链清空后母单应可删, got ' + r.status);
    ok('派生链清空后母单可删');

    // ── [3] 守卫②：已挂上线批次 → 409 ──────────
    await run(`INSERT INTO sys_releases (id, release_no, status, created_by, created_by_name) VALUES (1,'R-1','计划中',1,'admin')`);
    await insIssue(300, { title: '批次单', release_id: 1 });
    r = await call('DELETE', '/api/sys-issues/300', adminTok);
    assert.strictEqual(r.status, 409, '批次单删除应 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'SYS_ISSUE_IN_RELEASE', 'code');
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=300'), 1, '批次单被误删');
    ok('守卫②：已挂上线批次 → 409 SYS_ISSUE_IN_RELEASE，单保留');

    // ── [4] 边界：不存在 404 / 非 admin 403 / 非法 id 400 ──────────
    r = await call('DELETE', '/api/sys-issues/999999', adminTok);
    assert.strictEqual(r.status, 404, '不存在应 404, got ' + r.status);
    assert.strictEqual(r.body.code, 'SYS_ISSUE_NOT_FOUND', 'code');
    ok('不存在单 → 404 SYS_ISSUE_NOT_FOUND');

    r = await call('DELETE', '/api/sys-issues/300', devTok);
    assert.strictEqual(r.status, 403, '非 admin 应 403, got ' + r.status);
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=300'), 1, '非 admin 竟删成功');
    ok('非 admin → 403（requireAdmin 中间件先拦，单保留）');

    r = await call('DELETE', '/api/sys-issues/abc', adminTok);
    assert.strictEqual(r.status, 400, '非法 id 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_SYS_ISSUE_ID', 'code');
    ok('非法 id → 400 INVALID_SYS_ISSUE_ID');

    // ── [5] 锁释放回归（codex 44 H-1/H-2 修复：守卫读下沉事务后，守卫失败必须 sysRollback 释放锁）──────────
    //   TOCTOU 归零靠 sysBeginImmediate 全局锁架构（持锁期间写路径被串行化，verify 层难直接造真并发）；
    //   此处验证修复引入的新风险点：守卫失败的 rollback 路径不泄漏锁——否则下一次 sysBeginImmediate 会超时→503。
    await insIssue(400, { title: '母单2' });
    await insIssue(401, { title: '子单2', origin_issue_id: 400 });
    await run(`INSERT INTO sys_releases (id, release_no, status, created_by, created_by_name) VALUES (2,'R-2','计划中',1,'admin')`);
    await insIssue(402, { title: '批次单2', release_id: 2 });
    await insIssue(403, { title: '干净单-可删' });
    r = await call('DELETE', '/api/sys-issues/400', adminTok);
    assert.strictEqual(r.status, 409, '母单2 守卫应 409, got ' + r.status); assert.strictEqual(r.body.code, 'SYS_ISSUE_HAS_DERIVED');
    r = await call('DELETE', '/api/sys-issues/402', adminTok);
    assert.strictEqual(r.status, 409, '批次单2 守卫应 409（非 503=锁未泄漏）, got ' + r.status); assert.strictEqual(r.body.code, 'SYS_ISSUE_IN_RELEASE');
    r = await call('DELETE', '/api/sys-issues/403', adminTok);
    assert.strictEqual(r.status, 200, '连续 2 次守卫失败后干净单应可删（锁未泄漏）, got ' + r.status);
    assert.strictEqual(await cnt('SELECT COUNT(*) n FROM sys_issues WHERE id=403'), 0);
    ok('锁释放回归：连续 2 次守卫失败（事务内 rollback）后干净单仍能拿锁删除（锁无泄漏）');

    console.log(`\n✅ 全部通过（${passed} 项）`);
  } finally {
    if (server) server.close();
    try { fs.rmSync(path.join(UPLOAD_DIR, 'sys-iteration'), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌ 失败:', e && e.message, '\n', e && e.stack); if (server) server.close(); process.exit(1); });
