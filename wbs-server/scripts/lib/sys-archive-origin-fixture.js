'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listenOnSafePort } = require('./listen-safe-port');
const express = require('express');
const sqlite3 = require('sqlite3');

module.exports = async function startFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-archive-origin-'));
  const db = new sqlite3.Database(':memory:');
  const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this); }));
  const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows)));
  const get = async (sql, args = []) => (await all(sql, args))[0];
  const users = { 1: { id: 1, username: 'archive-admin', display_name: '归档测试管理员', role: 'admin' }, 5: { id: 5, username: 'archive-dev', display_name: '归档测试开发', role: 'user' } };
  const authenticateToken = (req, res, next) => {
    const user = users[Number((req.headers.authorization || '').replace('Bearer fixture-', ''))];
    if (!user) return res.status(401).json({ error: '未登录' });
    req.user = user; next();
  };
  const noop = () => {};
  const mod = require('../../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop }, db,
    dbRunAsync: run, dbGetAsync: get, dbAllAsync: all, authenticateToken,
    requireAdmin: (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: '需要管理员' }),
    ...require('../_sys-attach-test-deps'), UPLOAD_DIR: root, ALLOWED_FILE_DIRS: [root],
  });
  let server;
  async function stop() {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
    const moduleUploads = path.join(root, 'sys-iteration');
    if (fs.existsSync(moduleUploads)) fs.rmdirSync(moduleUploads);
    fs.rmdirSync(root); // Remove known empty fixture directories only.
  }
  try {
    mod.initSchema();
    const deadline = Date.now() + 15000;
    while (!mod._internals.SYS_SCHEMA_STATE.ready) {
      if (mod._internals.SYS_SCHEMA_STATE.error || Date.now() > deadline) throw Error('schema not ready: ' + mod._internals.SYS_SCHEMA_STATE.error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await run("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)");
    for (const user of Object.values(users)) await run('INSERT INTO users(id,username,display_name,role) VALUES(?,?,?,?)', [user.id,user.username,user.display_name,user.role]);
    await run("INSERT INTO users(id,username,display_name,role) VALUES(13,'wangtaotao','测试对接人','user')");
    const app = express(); app.use(express.json());
    app.use('/api', mod.router);
    app.get('/api/auth/me', authenticateToken, (req, res) => res.json(req.user));
    app.get('/api/user', authenticateToken, (req, res) => res.json(req.user));
    app.use(express.static(path.resolve(__dirname, '../../public'), { etag: false, maxAge: 0 }));
    // #95: bind through the shared safe-port helper (20000-49999, retries only EADDRINUSE/EACCES on bind, never HTTP).
    server = await listenOnSafePort(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, body, uid = 1) => {
      const response = await fetch(base + '/api' + url, { method, headers: { Authorization: 'Bearer fixture-' + uid, 'Content-Type': 'application/json', Connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() };
    };
    let seq = 0;
    async function seed(type = 'bug', status = '已上线') {
      const result = await api('POST', '/sys-issues', { intake_contract_version: 2, type, title: `归档原因测试-${++seq}`, system_name: 'BMS', source: '内部', description: '合成测试数据', intake_liaison_id: 13 });
      assert.equal(result.status, 201, JSON.stringify(result));
      const id = result.body.id;
      // Fixture prepares the state; close itself always exercises the real HTTP transaction.
      await run("UPDATE sys_issues SET status=?, assigned_to=5, assigned_to_name='归档测试开发', released_at=datetime('now','localtime') WHERE id=?", [status, id]);
      return id;
    }
    return { db, mod, app, base, run, all, get, api, seed, stop };
  } catch (e) { await stop(); throw e; }
};
