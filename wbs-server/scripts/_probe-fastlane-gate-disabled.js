'use strict';
// [部署闸·2026-08-13] 先行上线授权闸「禁用方向」子进程探针——供 verify-sys-fastrelease-auth.js [11] 组
//   execFile 调用。为什么独立子进程：routes/sys-iteration 工厂在同一进程内二次实例化会 init 挂起
//   （进程级单例状态·测试基建限制，非产品缺陷），干净进程单实例=与全部 verify 套件同构的已证可行路径。
//   本探针：fastlaneAuthorizeEnabled:false + 独立内存库 → 打授权（应 403 FAST_RELEASE_FEATURE_DISABLED，
//   且闸在 id 校验之前，空库不存在的 id 也应 403 而非 400）+ 打撤销（不受闸，应走常规 400 id 校验）。
//   结果以单行 JSON 写 stdout，断言留在父套件做（探针只采集事实）。
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'probe-fastlane-gate-secret';
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
  fastlaneAuthorizeEnabled: false,   // ← 本探针的全部意义
});

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);

function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (mod._internals.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (mod._internals.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(mod._internals.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

async function main() {
  mod.initSchema();   // 初始化须显式触发（工厂不自动跑），与 verify-sys-fastrelease-auth.js main() 同款
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + adminTok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const authorize = await call('POST', '/api/sys-issues/999999/fast-release-authorize', { note: '闸门禁用态授权尝试' });
  const revoke = await call('POST', '/api/sys-issues/999999/fast-release-revoke', {});
  server.close();
  process.stdout.write(JSON.stringify({ authorize, revoke }));
  process.exit(0);
}

main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
