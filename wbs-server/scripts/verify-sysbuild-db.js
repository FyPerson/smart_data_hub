// 验证脚本：项目管理（系统建设记录）模块 db 层——连接 / 锁 / 事务 / 故障路径
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §10.2（替换清单 R1–R6）
//         + v1.2 §7.2 / §8「故障路径」「错误分类」「原子性」「跨连接」
//
// 用法：node scripts/verify-sysbuild-db.js            跑全部用例
//       node scripts/verify-sysbuild-db.js --self-test 对 routes/sysbuild/db.js 逐一注入变异，
//         每个变异在子进程里重跑全部用例，必须至少一条判红（否则说明对应断言没有判别力）
//
// 夹具：直接 require db 工厂（不起整站、不连业务库），每个用例一个进程私有临时目录里的一次性库
//   文件（本模块自开连接，不能用 :memory:）。另开「外部连接」模拟共享连接。等待一律用信号 + 有界
//   超时，不用 sleep；时间相关只断言「最终发生」，不断言耗时上界。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { spawnSync } = require('child_process');

const DB_MODULE_DEFAULT = path.join(__dirname, '..', 'routes', 'sysbuild', 'db.js');
const argModIdx = process.argv.indexOf('--module');
const DB_MODULE = argModIdx > 0 ? process.argv[argModIdx + 1] : DB_MODULE_DEFAULT;
const SELF_TEST = process.argv.includes('--self-test');

const SCHEMA = [
  { type: 'table', name: 'sysbuild_t_items', sql: `CREATE TABLE IF NOT EXISTS sysbuild_t_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )` },
  { type: 'table', name: 'sysbuild_t_events', sql: `CREATE TABLE IF NOT EXISTS sysbuild_t_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created','renamed'))
  )` },
  { type: 'index', name: 'idx_sysbuild_t_events_item', sql: 'CREATE INDEX IF NOT EXISTS idx_sysbuild_t_events_item ON sysbuild_t_events(item_id)' },
];

// ── 小工具 ───────────────────────────────────────────────────────────────────────────
const silentLogger = { info() {}, warn() {}, error() {} };
const tmpRoots = [];
function newDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-db-'));
  tmpRoots.push(dir);
  return path.join(dir, 'case.db');
}
function cleanupTmp() {
  for (const dir of tmpRoots) {
    try {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.rmdirSync(dir);
    } catch (e) {
      console.error(`  [清理] 临时目录未删除（保留现场）: ${dir} — ${e.message}`);
    }
  }
}
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(t));
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function waitUntil(pred, ms, label) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`等待超时 ${ms}ms: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}
function openExternal(file, busyMs) {
  return new Promise((resolve, reject) => {
    const c = new sqlite3.Database(file, (err) => {
      if (err) return reject(err);
      c.run(`PRAGMA busy_timeout = ${busyMs}`, (e) => (e ? reject(e) : resolve(c)));
    });
  });
}
const ext = {
  run: (c, sql, p) => new Promise((res, rej) => c.run(sql, p || [], function cb(e) { if (e) rej(e); else res(this); })),
  get: (c, sql, p) => new Promise((res, rej) => c.get(sql, p || [], (e, r) => (e ? rej(e) : res(r)))),
  close: (c) => new Promise((res) => c.close(() => res())),
};
// 只调一次的 processExit 替身
function exitSpy() {
  const calls = [];
  return { calls, fn: (code) => { calls.push(code); } };
}
// 驱动 trace：收集已发出的 SQL；flush 发一条哨兵并等它的 trace 到达，之前的 SQL 必然都已报告。
function traceOf(conn) {
  const seen = [];
  conn.on('trace', (sql) => seen.push(sql));
  let n = 0;
  return {
    seen,
    async flush() {
      const tag = `SELECT 'sentinel-${++n}'`;
      await new Promise((res, rej) => conn.get(tag, (e) => (e ? rej(e) : res())));
      await waitUntil(() => seen.includes(tag), 3000, 'trace 哨兵');
    },
  };
}

function loadFactory() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(DB_MODULE);
}
const createdModules = [];
function makeDb(file, extra) {
  const { createSysbuildDb } = loadFactory();
  const m = createSysbuildDb(Object.assign({
    logger: silentLogger, DB_FILE: file, schemaObjects: SCHEMA,
    busyTimeoutMs: 300, lockTimeoutMs: 1500, enableTestHooks: true,
  }, extra || {}));
  createdModules.push(m);
  return m;
}
// 模块连接按设计不主动关闭（只有故障路径关闭）；测试结束时用原型方法绕过实例上的替身逐个关闭，
//   否则 Windows 下临时库文件被占用删不掉。已关闭的连接报 Database is closed，忽略。
async function closeModuleConns() {
  for (const m of createdModules) {
    const conn = m._internals.getConnForTest && m._internals.getConnForTest();
    if (conn) await new Promise((res) => sqlite3.Database.prototype.close.call(conn, () => res()));
  }
}
async function readyDb(extra) {
  const file = newDbFile();
  const exit = exitSpy();
  const m = makeDb(file, Object.assign({ processExit: exit.fn }, extra || {}));
  await m.initSchema();
  assert.strictEqual(m.getReadiness().ready, true, '初始化后应就绪');
  return { m, file, exit };
}
async function expectReject(promise, check, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: 应当失败却成功了`);
  check(err);
  return err;
}

// ── 用例 ─────────────────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('R1 无事务豁免：真实错误对象为真；改 code 或只含半句均为假', async () => {
  const { isNoTxnRollbackError } = loadFactory();
  const c = new sqlite3.Database(':memory:');
  const real = await new Promise((res) => c.run('ROLLBACK', (e) => res(e)));
  await ext.close(c);
  assert.ok(real && real.code === 'SQLITE_ERROR', '真实 ROLLBACK 无事务错误应为 SQLITE_ERROR');
  assert.strictEqual(isNoTxnRollbackError(real), true);
  const fake = (code, message) => Object.assign(new Error(message), { code });
  assert.strictEqual(isNoTxnRollbackError(fake('SQLITE_MISUSE', real.message)), false, '同文案但 code 不是 SQLITE_ERROR');
  assert.strictEqual(isNoTxnRollbackError(fake('SQLITE_ERROR', 'SQLITE_ERROR: cannot rollback')), false, '只含 cannot rollback');
  assert.strictEqual(isNoTxnRollbackError(fake('SQLITE_ERROR', 'SQLITE_ERROR: no transaction is active')), false, '只含 no transaction');
  assert.strictEqual(isNoTxnRollbackError(fake('SQLITE_MISUSE', 'SQLITE_MISUSE: Database is closed')), false, 'Database is closed');
});

test('错误分类：BUSY→503，FULL/IOERR/MISUSE→500，业务错误原样透传', async () => {
  const { classifyDbError, makeError } = loadFactory();
  const drv = (code, errno) => Object.assign(new Error(code), { code, errno });
  assert.strictEqual(classifyDbError(drv('SQLITE_BUSY', 5)).code, 'SYSBUILD_BUSY');
  assert.strictEqual(classifyDbError(drv('SQLITE_BUSY', 5)).status, 503);
  for (const [code, errno] of [['SQLITE_FULL', 13], ['SQLITE_IOERR', 10], ['SQLITE_MISUSE', 21], ['SQLITE_CONSTRAINT', 19]]) {
    const e = classifyDbError(drv(code, errno));
    assert.strictEqual(e.status, 500, code);
    assert.strictEqual(e.code, 'SYSBUILD_INTERNAL', code);
  }
  const biz = makeError(409, 'SYSBUILD_STATE', 'x');
  assert.strictEqual(classifyDbError(biz), biz);
});

test('initSchema 单飞：两次调用返回同一个 Promise；就绪前读写 503 INITIALIZING', async () => {
  const m = makeDb(newDbFile());
  const before = await expectReject(m.withRead(async () => 1), () => {}, '就绪前读');
  assert.strictEqual(before.code, 'SYSBUILD_SCHEMA_INITIALIZING');
  const p1 = m.initSchema();
  const p2 = m.initSchema();
  assert.strictEqual(p1, p2);
  await p1;
  assert.strictEqual(m.getReadiness().ready, true);
});

test('结构合约：同名但定义不同 → 未就绪且错误指出对象；缺失对象会补建', async () => {
  const file = newDbFile();
  const c = await openExternal(file, 300);
  await ext.run(c, 'CREATE TABLE sysbuild_t_items (id INTEGER PRIMARY KEY, name TEXT)');
  await ext.close(c);
  const m = makeDb(file);
  await m.initSchema();
  const st = m._internals.getState();
  assert.strictEqual(st.ready, false);
  assert.ok(/sysbuild_t_items/.test(st.initError) && /人工/.test(st.initError), st.initError);
  const e = await expectReject(m.withRead(async () => 1), () => {}, '合约不符后读');
  assert.strictEqual(e.code, 'SYSBUILD_SCHEMA_NOT_READY');
  // 只缺索引：补建后就绪
  const file2 = newDbFile();
  const c2 = await openExternal(file2, 300);
  await ext.run(c2, SCHEMA[0].sql);
  await ext.run(c2, SCHEMA[1].sql);
  await ext.close(c2);
  const m2 = makeDb(file2);
  await m2.initSchema();
  assert.strictEqual(m2.getReadiness().ready, true);
});

test('结构合约：索引列组被人工改过 → 未就绪', async () => {
  const file = newDbFile();
  const c = await openExternal(file, 300);
  await ext.run(c, SCHEMA[0].sql);
  await ext.run(c, SCHEMA[1].sql);
  await ext.run(c, 'CREATE INDEX idx_sysbuild_t_events_item ON sysbuild_t_events(kind)');
  await ext.close(c);
  const m = makeDb(file);
  await m.initSchema();
  assert.ok(/idx_sysbuild_t_events_item/.test(m._internals.getState().initError));
});

test('初始化失败（目录不存在）→ 503 SCHEMA_NOT_READY，不重试', async () => {
  const m = makeDb(path.join(os.tmpdir(), `sysbuild-no-such-dir-${process.pid}-${Date.now()}`, 'x.db'));
  await m.initSchema();
  const e = await expectReject(m.withWriteTxn(async () => 1), () => {}, '初始化失败后写');
  assert.strictEqual(e.code, 'SYSBUILD_SCHEMA_NOT_READY');
  assert.strictEqual(e.txnOutcome, 'not_committed');
});

test('原子性：事件插入被触发器拒绝时业务行一起回滚（触发器确实触发过）', async () => {
  const { m, file } = await readyDb();
  const c = await openExternal(file, 300);
  await ext.run(c, `CREATE TRIGGER sysbuild_t_inject BEFORE INSERT ON sysbuild_t_events
    WHEN (SELECT COUNT(*) FROM sysbuild_t_items WHERE name = 'atom') = 1
    BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  const e = await expectReject(m.withWriteTxn(async (q) => {
    const r = await q.run('INSERT INTO sysbuild_t_items(name) VALUES (?)', ['atom']);
    await q.run("INSERT INTO sysbuild_t_events(item_id, kind) VALUES (?, 'created')", [r.lastID]);
  }), () => {}, '原子性');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  assert.ok(/injected/.test(e.cause && e.cause.message), '触发器应确实触发');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='atom'")).n, 0);
  assert.strictEqual((await ext.get(c, 'SELECT COUNT(*) n FROM sysbuild_t_events')).n, 0);
  await ext.close(c);
});

test('R6 保留的写查询助手在提交后调用 → 拒绝，驱动没收到 SQL', async () => {
  const { m } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  let kept = null;
  await m.withWriteTxn(async (q) => { kept = q; await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('a')"); });
  const e = await expectReject(kept.get("SELECT 'late-after-commit'"), () => {}, '提交后调用');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  await tr.flush();
  assert.ok(!tr.seen.includes("SELECT 'late-after-commit'"), '驱动不应收到这条 SQL');
});

test('R6 提交收尾窗口（标记失效后、COMMIT 发出前）调用 → 拒绝，驱动没收到 SQL', async () => {
  const { m } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  let kept = null;
  let windowErr = null;
  m._internals.setBeforeCommit(async () => {
    try { await kept.get("SELECT 'in-commit-window'"); } catch (e) { windowErr = e; }
  });
  await m.withWriteTxn(async (q) => { kept = q; await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('w')"); });
  m._internals.setBeforeCommit(null);
  assert.ok(windowErr && windowErr.code === 'SYSBUILD_INTERNAL', '收尾窗口内调用应被拒绝');
  await tr.flush();
  assert.ok(!tr.seen.includes("SELECT 'in-commit-window'"));
  assert.ok(tr.seen.includes('COMMIT'), '事务照常提交');
});

test('R6 保留的读查询助手在读回调结束后调用 → 拒绝', async () => {
  const { m } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  let kept = null;
  await m.withRead(async (q) => { kept = q; return q.get('SELECT 1 AS one'); });
  const e = await expectReject(kept.all("SELECT 'late-read'"), () => {}, '读结束后调用');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  await tr.flush();
  assert.ok(!tr.seen.includes("SELECT 'late-read'"));
});

test('04 号 M-1 排队中的读：故障发生在排队期间 → 取锁后复核得 503 UNAVAILABLE（不是 500）', async () => {
  const { m, exit } = await readyDb();
  const gate = deferred();
  const arrived = deferred();
  const w = m.withWriteTxn(async (q) => { arrived.resolve(); await gate.promise; return q.get('SELECT 1 AS one'); });
  await arrived.promise;
  // 读回调不发 SQL：复核必须在回调执行之前拦下（查询助手的故障检查兜不住这种回调）。
  let readFnRan = false;
  const r = m.withRead(async () => { readFnRan = true; return 'ran'; });
  await waitUntil(() => m._internals.waitingCount() === 1, 3000, '读已排队');
  m._internals.getConnForTest().emit('error', new Error('injected connection error'));
  gate.resolve();
  await expectReject(w, (e) => assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE'), '在途写');
  await expectReject(r, (e) => {
    assert.strictEqual(e.status, 503);
    assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  }, '排队的读');
  assert.strictEqual(readFnRan, false, '读回调不应被执行');
  assert.deepStrictEqual(exit.calls, []);
});

test('R3/R5 故障时在途事务未完成：关闭排在事务之后；事务回滚、锁释放、外部可写、不重开、不退出', async () => {
  const { m, file, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  const origClose = conn.close.bind(conn);
  conn.close = (cb) => { closeCalls += 1; return origClose(cb); };
  const gate = deferred();
  const arrived = deferred();
  const w = m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('half')");
    arrived.resolve();
    await gate.promise;
    await q.get('SELECT 1 AS one'); // 故障后被查询助手拒绝
  });
  await arrived.promise;
  conn.emit('error', new Error('injected connection error'));
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE', 'error 事件后立即不可用');
  assert.strictEqual(closeCalls, 0, '事务持锁期间不得关闭连接');
  gate.resolve();
  const e = await expectReject(w, () => {}, '在途写');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'not_committed', '事务已正常回滚');
  // 显式等关闭回调落定（09 号 M-3）：前面成功的 ROLLBACK 已释放写锁，只等「已发起关闭」证明不了什么。
  const closeResult = await withTimeout(m._internals.enterFaultForTest('等待关闭落定'), 5000, '故障关闭落定');
  assert.ok(closeResult && closeResult.ok === true, '关闭回调成功');
  const c = await openExternal(file, 2000);
  await withTimeout(ext.run(c, 'BEGIN IMMEDIATE'), 5000, '外部连接拿写锁');
  await ext.run(c, "INSERT INTO sysbuild_t_items(name) VALUES ('ext')");
  await ext.run(c, 'COMMIT');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='half'")).n, 0, '半截写入已回滚');
  await ext.close(c);
  await expectReject(m.withRead(async () => 1), (er) => assert.strictEqual(er.code, 'SYSBUILD_UNAVAILABLE'), '故障后读');
  assert.strictEqual(m._internals.getConnForTest(), conn, '不重开连接');
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, []);
});

test('R5 连接 error 事件（无在途事务）→ 关闭一次；重复进入故障复用同一结果', async () => {
  const { m, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  const origClose = conn.close.bind(conn);
  conn.close = (cb) => { closeCalls += 1; return origClose(cb); };
  conn.emit('error', new Error('e1'));
  const p1 = m._internals.enterFaultForTest('again-1');
  const p2 = m._internals.enterFaultForTest('again-2');
  const r1 = await withTimeout(p1, 5000, '故障关闭');
  const r2 = await withTimeout(p2, 5000, '故障关闭');
  assert.strictEqual(r1, r2, '复用同一个关闭结果');
  assert.ok(r1 && r1.ok === true);
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, []);
  assert.strictEqual(m._internals.getState().closedOnce, true);
});

test('R5 故障关闭失败 → processExit(1) 恰好一次；关闭只调用一次', async () => {
  const { m, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  conn.close = (cb) => { closeCalls += 1; setImmediate(() => cb(new Error('injected close failure'))); };
  const r = await withTimeout(m._internals.enterFaultForTest('x'), 5000, '故障关闭');
  await withTimeout(m._internals.enterFaultForTest('y'), 5000, '再次故障');
  conn.emit('error', new Error('z'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, [1]);
});

// ROLLBACK 失败注入：只拦截本连接上的 'ROLLBACK'，其余 SQL 原样执行。
function failRollbackWith(conn, errObj) {
  const origRun = conn.run.bind(conn);
  conn.run = (sql, params, cb) => {
    if (sql === 'ROLLBACK') { setImmediate(() => cb.call({}, errObj)); return conn; }
    return origRun(sql, params, cb);
  };
}
test('R2 ROLLBACK 报 Database is closed → 进入故障路径（不按回滚完成返回），结果不确定', async () => {
  const { m, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  failRollbackWith(conn, Object.assign(new Error('SQLITE_MISUSE: Database is closed'), { code: 'SQLITE_MISUSE', errno: 21 }));
  const e = await withTimeout(expectReject(m.withWriteTxn(async () => { throw m.makeError(409, 'SYSBUILD_STATE', 'biz'); }), () => {}, 'R2'), 8000, 'R2 不得死锁');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(m._internals.getState().closedOnce, true);
  assert.deepStrictEqual(exit.calls, []);
});

test('R4 ROLLBACK 失败（相近文案）在锁内直接进入故障，不再次取锁、不死锁', async () => {
  const { m } = await readyDb();
  const conn = m._internals.getConnForTest();
  failRollbackWith(conn, Object.assign(new Error('SQLITE_ERROR: cannot rollback'), { code: 'SQLITE_ERROR', errno: 1 }));
  const e = await withTimeout(expectReject(m.withWriteTxn(async () => { throw new Error('boom'); }), () => {}, 'R4'), 8000, 'R4 不得死锁');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(m._internals.waitingCount(), 0);
});

test('R5 在途事务期间 error 事件排队关闭 + 该事务 ROLLBACK 失败锁内关闭 → 排队的一次复用结果，只关一次、不退出', async () => {
  const { m, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  const origClose = conn.close.bind(conn);
  conn.close = (cb) => { closeCalls += 1; return origClose(cb); };
  failRollbackWith(conn, Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR', errno: 10 }));
  const gate = deferred();
  const arrived = deferred();
  const w = m.withWriteTxn(async () => { arrived.resolve(); await gate.promise; throw new Error('biz'); });
  await arrived.promise;
  const queued = m._internals.enterFaultForTest('error 事件（排队）');
  gate.resolve();
  const e = await withTimeout(expectReject(w, () => {}, '在途写'), 8000, '不得死锁');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  const qr = await withTimeout(queued, 8000, '排队的故障关闭');
  assert.ok(qr && qr.ok === true, '排队的一次拿到同一个成功的关闭结果');
  assert.strictEqual(closeCalls, 1, '只关闭一次');
  assert.deepStrictEqual(exit.calls, [], '不得因重复关闭而退出');
});

test('R1 真实无事务 ROLLBACK：触发器 RAISE(ROLLBACK) 让 SQLite 自动回滚 → 豁免生效、写入不存在、模块仍可用', async () => {
  const { m, file } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  const c = await openExternal(file, 300);
  await ext.run(c, `CREATE TRIGGER sysbuild_t_autorollback BEFORE INSERT ON sysbuild_t_events
    WHEN (SELECT COUNT(*) FROM sysbuild_t_items WHERE name = 'rb') = 1
    BEGIN SELECT RAISE(ROLLBACK, 'injected-rollback'); END`);
  const e = await expectReject(m.withWriteTxn(async (q) => {
    const r = await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('rb')");
    await q.run("INSERT INTO sysbuild_t_events(item_id, kind) VALUES (?, 'created')", [r.lastID]);
  }), () => {}, 'R1 真实');
  assert.ok(/injected-rollback/.test(e.cause && e.cause.message), '触发器应确实触发');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  await tr.flush();
  assert.ok(tr.seen.includes('ROLLBACK'), '应发出过 ROLLBACK（得到真实的无事务错误）');
  assert.strictEqual(m.getReadiness().ready, true, '豁免生效，不进入故障');
  assert.strictEqual(m._internals.getState().closedOnce, false);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='rb'")).n, 0, '写入已被自动回滚');
  await ext.close(c);
});

test('H-1 查询助手拒绝事务控制语句（含注释前缀、三个入口），驱动没收到；事务照常提交', async () => {
  const { isTxnControlSql } = loadFactory();
  for (const s of ['COMMIT', 'commit;', '  /* x */ Commit', '-- c\nBEGIN IMMEDIATE', 'END', 'savepoint a', 'RELEASE a', 'ROLLBACK',
    '; COMMIT', ';;  /* c */ ; COMMIT', ';\n-- x\nEND', ' ; /* a */ ; -- b\n ; rollback']) {
    assert.strictEqual(isTxnControlSql(s), true, s);
  }
  for (const s of ['SELECT 1', 'UPDATE sysbuild_t_items SET name = ?', "SELECT 'commit'", 'BEGINNING', '/* commit */ SELECT 1']) {
    assert.strictEqual(isTxnControlSql(s), false, s);
  }
  const { m, file } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  const bad = ['COMMIT', '  /* sneaky */ commit', '-- c\nBEGIN', 'END', 'SAVEPOINT s1', 'ROLLBACK', '; COMMIT', ';; /* c */ ; END', ';\n-- x\nCOMMIT'];
  const rejected = [];
  await m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('h1')");
    for (const [i, sql] of bad.entries()) {
      const fn = [q.run, q.get, q.all][i % 3];
      try { await fn(sql); } catch (e) { rejected.push(e.code); }
    }
  });
  assert.deepStrictEqual(rejected, bad.map(() => 'SYSBUILD_INTERNAL'));
  await tr.flush();
  for (const sql of bad.filter((s) => s !== 'COMMIT')) assert.ok(!tr.seen.includes(sql), `驱动不应收到 ${JSON.stringify(sql)}`);
  assert.strictEqual(tr.seen.filter((s) => s === 'COMMIT').length, 1, '只有底座自己发出的一次 COMMIT');
  const c = await openExternal(file, 300);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='h1'")).n, 1);
  await ext.close(c);
});

// 09-R H-1 方案 B：事务标记硬核对。用原始连接直接提交来模拟「任何绕过关键字检查的提前提交」，
//   核对不依赖关键字检查是否完备。
test('09-R 事务被提前提交后业务抛错 → 不确定、进入故障，绝不标「确知未提交」', async () => {
  const { m, file, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('early1')");
    await new Promise((res, rej) => conn.run('COMMIT', (er) => (er ? rej(er) : res())));
    throw m.makeError(409, 'SYSBUILD_STATE', '业务拒绝');
  }), () => {}, '提前提交后抛错');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE');
  assert.deepStrictEqual(exit.calls, []);
  const c = await openExternal(file, 300);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='early1'")).n, 1, '前提：数据确已提交');
  await ext.close(c);
});

test('09-R 事务被提前提交后业务正常返回 → COMMIT 报无活动事务 → 不确定、进入故障', async () => {
  const { m } = await readyDb();
  const conn = m._internals.getConnForTest();
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('early2')");
    await new Promise((res, rej) => conn.run('COMMIT', (er) => (er ? rej(er) : res())));
    return 'ok';
  }), () => {}, '提前提交后返回');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE');
});

test('09-R 提前提交后又自行开新事务再抛错 → ROLLBACK 成功也核对标记 → 不确定、进入故障', async () => {
  const { m, file } = await readyDb();
  const conn = m._internals.getConnForTest();
  const raw = (sql) => new Promise((res, rej) => conn.run(sql, (er) => (er ? rej(er) : res())));
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('early3')");
    await raw('COMMIT');
    await raw('BEGIN');
    throw new Error('biz');
  }), () => {}, '提前提交后开新事务');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE');
  const c = await openExternal(file, 300);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='early3'")).n, 1, '前提：前一段确已提交');
  await ext.close(c);
});

// 09-R2 方案 A：首个驱动错误后事务作废、语句串行发送、COMMIT 非 BUSY 错误标不确定。
const DUP = "INSERT OR ROLLBACK INTO sysbuild_t_items(id, name) VALUES (1, 'dup')";
async function countItems(file, name) {
  const c = await openExternal(file, 300);
  const n = (await ext.get(c, 'SELECT COUNT(*) n FROM sysbuild_t_items WHERE name = ?', [name])).n;
  await ext.close(c);
  return n;
}
test('09-R2 H-1 捕获 INSERT OR ROLLBACK 的错误后继续写再抛错 → 后续语句被拒，什么都没落库，未提交', async () => {
  const { m, file } = await readyDb();
  let laterErr = null;
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(id, name) VALUES (1, 'first')");
    try { await q.run(DUP); } catch (_) { /* 业务吞掉错误 */ }
    try { await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('after')"); } catch (er) { laterErr = er; }
    throw new Error('biz');
  }), () => {}, '吞错后再抛错');
  assert.ok(laterErr && laterErr.code === 'SYSBUILD_INTERNAL', '作废后的语句应被拒绝');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.strictEqual(await countItems(file, 'after'), 0);
  assert.strictEqual(await countItems(file, 'first'), 0);
  assert.strictEqual(m.getReadiness().ready, true);
});

test('09-R2 H-1 捕获错误后业务正常返回 → 不提交，未提交，什么都没落库', async () => {
  const { m, file } = await readyDb();
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(id, name) VALUES (1, 'first2')");
    try { await q.run(DUP); } catch (_) { /* 业务吞掉错误 */ }
    try { await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('after2')"); } catch (_) { /* 同上 */ }
    return 'ok';
  }), () => {}, '吞错后正常返回');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.strictEqual(await countItems(file, 'after2'), 0);
  assert.strictEqual(await countItems(file, 'first2'), 0);
});

test('09-R2 H-1 并行发出（不等前一条）：自动回滚之后的语句不会在自动提交模式下落库', async () => {
  const { m, file } = await readyDb();
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(id, name) VALUES (1, 'first3')");
    const p1 = q.run(DUP);
    const p2 = q.run("INSERT INTO sysbuild_t_items(name) VALUES ('par')");
    const r = await Promise.allSettled([p1, p2]);
    assert.strictEqual(r[1].status, 'rejected', '前提：第二条应被拒绝');
    return 'ok';
  }), () => {}, '并行');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.strictEqual(await countItems(file, 'par'), 0);
});

test('09-R3 H-1 回调不等已排队的写就返回（只捕获其拒绝）→ 被收尾取消的语句作废事务，没有部分提交', async () => {
  const { m, file } = await readyDb();
  let p2Settled = null;
  const e = await expectReject(m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('nw1')");
    const p1 = q.run("INSERT INTO sysbuild_t_items(name) VALUES ('nw2')");
    const p2 = q.run("INSERT INTO sysbuild_t_items(name) VALUES ('nw3')");
    p1.catch(() => {});
    p2.then(() => { p2Settled = 'ok'; }, () => { p2Settled = 'rejected'; });
    return 'ok';
  }), () => {}, '不等就返回');
  assert.strictEqual(p2Settled, 'rejected', '前提：最后一条因收尾被取消');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  for (const n of ['nw1', 'nw2', 'nw3']) assert.strictEqual(await countItems(file, n), 0, `${n} 不应落库`);
});

test('09-R3 M-1 回调写入后 throw null / undefined / 0 → 视为失败、回滚', async () => {
  const { m, file } = await readyDb();
  for (const [i, v] of [null, undefined, 0].entries()) {
    const name = `falsy${i}`;
    const e = await expectReject(m.withWriteTxn(async (q) => {
      await q.run('INSERT INTO sysbuild_t_items(name) VALUES (?)', [name]);
      throw v;
    }), () => {}, `throw ${String(v)}`);
    assert.strictEqual(e.txnOutcome, 'not_committed');
    assert.strictEqual(await countItems(file, name), 0, `throw ${String(v)} 后不应落库`);
  }
});

test('09-R2 H-2 COMMIT 返回非 BUSY 错误（注入 IOERR）→ 不确定、进入故障、只关一次', async () => {
  const { m, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  const origRun = conn.run.bind(conn);
  conn.run = (sql, params, cb) => {
    if (sql === 'COMMIT') { setImmediate(() => cb.call({}, Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR', errno: 10 }))); return conn; }
    return origRun(sql, params, cb);
  };
  let closeCalls = 0;
  const origClose = conn.close.bind(conn);
  conn.close = (cb) => { closeCalls += 1; return origClose(cb); };
  const e = await expectReject(m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('io')")), () => {}, 'COMMIT IOERR');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(m.getReadiness().code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, []);
});

test('09-R2 事务标记删除失败后：旧行残留不影响下一次提交与下一次回滚的判定', async () => {
  const { m, file } = await readyDb();
  const conn = m._internals.getConnForTest();
  const origRun = conn.run.bind(conn);
  let failDeleteOnce = true;
  conn.run = (sql, params, cb) => {
    if (failDeleteOnce && /^DELETE FROM temp\.sysbuild_txn_mark/.test(sql)) {
      failDeleteOnce = false;
      setImmediate(() => cb.call({}, Object.assign(new Error('SQLITE_IOERR: injected'), { code: 'SQLITE_IOERR', errno: 10 })));
      return conn;
    }
    return origRun(sql, params, cb);
  };
  await m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('d1')"));
  await m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('d2')"));
  const e = await expectReject(m.withWriteTxn(async (q) => { await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('d3')"); throw new Error('biz'); }), () => {}, '回滚');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.strictEqual(m.getReadiness().ready, true);
  assert.strictEqual(await countItems(file, 'd2'), 1);
  assert.strictEqual(await countItems(file, 'd3'), 0);
  const left = await new Promise((res, rej) => conn.get('SELECT COUNT(*) AS n FROM temp.sysbuild_txn_mark', (er, r) => (er ? rej(er) : res(r))));
  assert.strictEqual(left.n, 1, '只残留删除失败的那一行');
});

test('09-R 事务标记：成功提交后清理，不累积；回滚后不残留', async () => {
  const { m } = await readyDb();
  const conn = m._internals.getConnForTest();
  for (let i = 0; i < 5; i += 1) await m.withWriteTxn(async (q) => q.run('INSERT INTO sysbuild_t_items(name) VALUES (?)', [`ok${i}`]));
  await expectReject(m.withWriteTxn(async () => { throw new Error('biz'); }), () => {}, '回滚一次');
  const row = await new Promise((res, rej) => conn.get('SELECT COUNT(*) AS n FROM temp.sysbuild_txn_mark', (er, r) => (er ? rej(er) : res(r))));
  assert.strictEqual(row.n, 0);
  assert.strictEqual(m.getReadiness().ready, true);
});

test('M-1 结构合约：字面量大小写与空白不被抹平（CHECK 枚举改成大写 → 未就绪）', async () => {
  const { normalizeSchemaSql } = loadFactory();
  assert.notStrictEqual(normalizeSchemaSql("CHECK (k IN ('A'))"), normalizeSchemaSql("check (k in ('a'))"));
  assert.notStrictEqual(normalizeSchemaSql("CHECK (k = 'a b')"), normalizeSchemaSql("CHECK (k = 'a  b')"));
  assert.notStrictEqual(normalizeSchemaSql("CHECK (k = 'if not exists')"), normalizeSchemaSql("CHECK (k = ' ')"));
  assert.strictEqual(normalizeSchemaSql("CREATE TABLE IF NOT EXISTS t ( a  TEXT , b INT )"), normalizeSchemaSql('create table t(a text,b int)'));
  assert.strictEqual(normalizeSchemaSql("CHECK (k IN ('it''s', 'X'))"), normalizeSchemaSql("check (k in ('it''s','X'))"));
  const file = newDbFile();
  const c = await openExternal(file, 300);
  await ext.run(c, SCHEMA[0].sql);
  await ext.run(c, SCHEMA[1].sql.replace("'created'", "'CREATED'"));
  await ext.close(c);
  const m = makeDb(file);
  await m.initSchema();
  assert.ok(/sysbuild_t_events/.test(m._internals.getState().initError || ''), '大写枚举应判定义不符');
});

test('M-2 业务回调执行期间连接故障、回调不再查询直接返回 → 不提交，503、确知未提交、写入不存在', async () => {
  const { m, file } = await readyDb();
  const gate = deferred();
  const arrived = deferred();
  const w = m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('m2')");
    arrived.resolve();
    await gate.promise;
    return 'returned-without-query';
  });
  await arrived.promise;
  const closed = m._internals.enterFaultForTest('error 事件（模拟）');
  gate.resolve();
  const e = await expectReject(w, () => {}, 'M-2');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.ok((await withTimeout(closed, 5000, '故障关闭')).ok);
  const c = await openExternal(file, 300);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='m2'")).n, 0);
  await ext.close(c);
});

test('M-3 锁内故障关闭：close 回调落定之前原写请求不结束、排队的读不被放行；落定后外部才可写', async () => {
  const { m, file, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  const origClose = conn.close.bind(conn);
  let closeCalls = 0;
  let heldCb = null;
  conn.close = (cb) => { closeCalls += 1; heldCb = cb; };
  failRollbackWith(conn, Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR', errno: 10 }));
  const gate = deferred();
  const arrived = deferred();
  let wSettled = false;
  let rSettled = false;
  let readFnRan = false;
  const w = m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('held')");
    arrived.resolve();
    await gate.promise;
    throw new Error('biz');
  });
  w.then(() => { wSettled = true; }, () => { wSettled = true; });
  await arrived.promise;
  const r = m.withRead(async () => { readFnRan = true; });
  r.then(() => { rSettled = true; }, () => { rSettled = true; });
  await waitUntil(() => m._internals.waitingCount() === 1, 3000, '读已排队');
  gate.resolve();
  await waitUntil(() => closeCalls === 1, 3000, '关闭已发起');
  for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res));
  assert.strictEqual(wSettled, false, 'close 回调落定前原写请求不得结束');
  assert.strictEqual(rSettled, false, '锁仍被持有，排队的读不得被放行');
  assert.strictEqual(m._internals.waitingCount(), 1);
  origClose(heldCb);
  const e = await withTimeout(expectReject(w, () => {}, '原写请求'), 5000, '原写请求结束');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  await expectReject(r, (er) => assert.strictEqual(er.code, 'SYSBUILD_UNAVAILABLE'), '排队的读');
  assert.strictEqual(readFnRan, false);
  const c = await openExternal(file, 2000);
  await withTimeout(ext.run(c, 'BEGIN IMMEDIATE'), 5000, '外部拿写锁');
  await ext.run(c, 'COMMIT');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='held'")).n, 0, '关闭回滚了未结束的事务');
  await ext.close(c);
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, []);
});

test('M-3 故障关闭一直不回调 → 超时判失败、processExit(1) 恰一次；迟到回调与再次进入故障都不重复退出', async () => {
  const { m, exit } = await readyDb({ closeTimeoutMs: 300 });
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  let lateCb = null;
  conn.close = (cb) => { closeCalls += 1; lateCb = cb; };
  const r1 = await withTimeout(m._internals.enterFaultForTest('x'), 5000, '关闭超时');
  assert.strictEqual(r1.ok, false);
  assert.ok(/超时/.test(r1.err.message));
  assert.deepStrictEqual(exit.calls, [1]);
  lateCb(null);
  await new Promise((res) => setImmediate(res));
  const r2 = await withTimeout(m._internals.enterFaultForTest('y'), 5000, '再次故障');
  assert.strictEqual(r2, r1);
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, [1]);
});

test('M-3 驱动操作尚未完成时发生故障 → 关闭等该操作与事务结束后才发起', async () => {
  const { m } = await readyDb();
  const conn = m._internals.getConnForTest();
  const origClose = conn.close.bind(conn);
  let opDone = false;
  let opDoneAtClose = null;
  conn.close = (cb) => { opDoneAtClose = opDone; return origClose(cb); };
  const arrived = deferred();
  const HEAVY = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT COUNT(*) AS n FROM c';
  const w = m.withWriteTxn(async (q) => {
    await q.run("INSERT INTO sysbuild_t_items(name) VALUES ('op')");
    const p = q.get(HEAVY);
    arrived.resolve();
    const v = await p;
    opDone = true;
    return v;
  });
  await arrived.promise;
  const closed = m._internals.enterFaultForTest('error 事件（模拟）');
  assert.strictEqual(opDone, false, '前提：故障发生时驱动操作尚未完成');
  const e = await withTimeout(expectReject(w, () => {}, '在途写'), 20000, '在途写结束');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  assert.ok((await withTimeout(closed, 5000, '故障关闭')).ok);
  assert.strictEqual(opDoneAtClose, true, '关闭必须在驱动操作完成之后发起');
});

test('M-3 COMMIT 失败且随后 ROLLBACK 也失败 → 进入故障路径、结果不确定、只关一次', async () => {
  const { m, file, exit } = await readyDb();
  const conn = m._internals.getConnForTest();
  let closeCalls = 0;
  const origClose = conn.close.bind(conn);
  conn.close = (cb) => { closeCalls += 1; return origClose(cb); };
  failRollbackWith(conn, Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR', errno: 10 }));
  const c = await openExternal(file, 300);
  await ext.run(c, 'BEGIN');
  await ext.get(c, 'SELECT COUNT(*) n FROM sysbuild_t_items');
  const e = await withTimeout(expectReject(m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('cr')")), () => {}, 'COMMIT+ROLLBACK'), 8000, '不得死锁');
  assert.strictEqual(e.code, 'SYSBUILD_UNAVAILABLE');
  assert.strictEqual(e.txnOutcome, 'uncertain');
  assert.strictEqual(closeCalls, 1);
  assert.deepStrictEqual(exit.calls, []);
  await ext.run(c, 'COMMIT');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='cr'")).n, 0);
  await ext.close(c);
});

test('M-3 未发布连接在发布前收到 error 事件 → 初始化失败、不进入故障路径、不退出、局部连接已关闭', async () => {
  let opened = null;
  const exit = exitSpy();
  const m = makeDb(newDbFile(), {
    processExit: exit.fn,
    onConnOpenedForTest: (c) => { opened = c; },
    beforePublish: () => { opened.emit('error', new Error('init-time connection error')); },
  });
  await m.initSchema();
  const st = m._internals.getState();
  assert.strictEqual(st.ready, false);
  assert.ok(/error 事件/.test(st.initError || ''), st.initError);
  assert.strictEqual(st.fault, null);
  assert.strictEqual(st.closedOnce, false);
  assert.deepStrictEqual(exit.calls, []);
  const e2 = await new Promise((res) => opened.get('SELECT 1', (er) => res(er)));
  assert.ok(e2 && /closed/i.test(e2.message), '局部连接应已关闭');
  assert.strictEqual(m._internals.getConnForTest(), null, '未发布');
});

test('BEGIN 遇忙（外部连接持写锁）→ 503 BUSY、确知未提交、不发 ROLLBACK；外部事务不受影响', async () => {
  const { m, file } = await readyDb();
  const tr = traceOf(m._internals.getConnForTest());
  const c = await openExternal(file, 300);
  await ext.run(c, 'BEGIN IMMEDIATE');
  await ext.run(c, "INSERT INTO sysbuild_t_items(name) VALUES ('outer')");
  const e = await expectReject(m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('mine')")), () => {}, 'BEGIN 遇忙');
  assert.strictEqual(e.code, 'SYSBUILD_BUSY');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  await tr.flush();
  assert.ok(!tr.seen.includes('ROLLBACK'), 'BEGIN 失败不得执行 ROLLBACK');
  await ext.run(c, 'COMMIT');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='outer'")).n, 1);
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='mine'")).n, 0);
  await ext.close(c);
});

test('COMMIT 遇忙（外部连接持读事务）→ 回滚、503 BUSY、确知未提交；之后照常可写', async () => {
  const { m, file } = await readyDb();
  const c = await openExternal(file, 300);
  await ext.run(c, 'BEGIN');
  await ext.get(c, 'SELECT COUNT(*) n FROM sysbuild_t_items');
  const e = await expectReject(m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('c1')")), () => {}, 'COMMIT 遇忙');
  assert.strictEqual(e.code, 'SYSBUILD_BUSY');
  assert.strictEqual(e.txnOutcome, 'not_committed');
  await ext.run(c, 'COMMIT');
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='c1'")).n, 0);
  await m.withWriteTxn(async (q) => q.run("INSERT INTO sysbuild_t_items(name) VALUES ('c2')"));
  assert.strictEqual((await ext.get(c, "SELECT COUNT(*) n FROM sysbuild_t_items WHERE name='c2'")).n, 1);
  await ext.close(c);
});

test('等锁超时 → 503 BUSY，写请求确知未提交', async () => {
  const { m } = await readyDb({ lockTimeoutMs: 200 });
  const gate = deferred();
  const arrived = deferred();
  const w = m.withRead(async () => { arrived.resolve(); await gate.promise; });
  await arrived.promise;
  await expectReject(m.withRead(async () => 1), (e) => assert.strictEqual(e.code, 'SYSBUILD_BUSY'), '读等锁超时');
  const e2 = await expectReject(m.withWriteTxn(async () => 1), () => {}, '写等锁超时');
  assert.strictEqual(e2.code, 'SYSBUILD_BUSY');
  assert.strictEqual(e2.txnOutcome, 'not_committed');
  gate.resolve();
  await w;
});

// ── 运行 ─────────────────────────────────────────────────────────────────────────────
async function runAll() {
  let failed = 0;
  for (const c of cases) {
    try {
      await withTimeout(c.fn(), 20000, c.name);
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  ✗ ${c.name}\n      ${e && e.message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  return failed;
}

// 变异清单：每条只替换 db.js 中恰好出现一次的片段；变异后至少一条用例判红才算有判别力。
const MUTATIONS = [
  { id: 'R1-去掉 code 校验', from: "err.code === 'SQLITE_ERROR' && typeof err.message", to: 'typeof err.message' },
  { id: 'R1-改成半句匹配', from: 'err.message.includes(NO_TXN_PHRASE)', to: "err.message.includes('cannot rollback')" },
  { id: 'R2-Database is closed 直接按已回滚返回（台账旧行为）', from: '      if (!isNoTxnRollbackError(rbErr)) {', to: "      if (/Database is closed/.test(rbErr.message)) return 'rolled_back';\n      if (!isNoTxnRollbackError(rbErr)) {" },
  { id: 'R3-error 事件立即关闭（不进锁）', from: '      faultQueuedPromise = mutex.acquire(0).then((release) => enterFaultUnderLock(reason).finally(release));', to: '      faultQueuedPromise = enterFaultUnderLock(reason);' },
  { id: 'R4-回滚失败再次取锁', from: "      await enterFaultUnderLock(`ROLLBACK 失败: ${rbErr && rbErr.message}`);", to: "      await mutex.acquire(0).then((rel) => enterFaultUnderLock('x').finally(rel));" },
  { id: 'R5-不复用关闭结果', from: '    if (!faultClosePromise) {\n      faultClosePromise', to: '    {\n      faultClosePromise' },
  { id: 'R5-关闭失败不退出', from: '        processExit(1);', to: '        void 0;' },
  { id: 'R6-查询助手不查标记', from: '      if (!marker.active) throw', to: '      if (false) throw' },
  { id: 'R6-提交前不置失效', from: '      marker.active = false;\n      await marker.chain;\n      // 业务回调吞掉', to: '      await marker.chain;\n      // 业务回调吞掉' },
  { id: 'M-1-读取锁后不复核', from: '    try {\n      assertUsable();\n      const conn = sbDb;\n      marker.active = true;', to: '    try {\n      const conn = sbDb;\n      marker.active = true;' },
  { id: 'BEGIN 失败也回滚', from: "        throw withOutcome(classifyDbError(beginErr), 'not_committed');", to: "        await rollbackOrFault(conn);\n        throw withOutcome(classifyDbError(beginErr), 'not_committed');" },
  { id: '合约只查存在不比定义', from: "      if (row.type !== obj.type || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(obj.sql)) mismatched.push(obj.name);", to: '' },
  { id: '回滚成功也报不确定', from: "        throw withOutcome(classifyDbError(failure), 'not_committed');", to: "        throw withOutcome(classifyDbError(failure), 'uncertain');" },
  { id: 'H-1-不拦事务控制语句', from: '      if (isTxnControlSql(sql)) throw', to: '      if (false) throw' },
  { id: 'H-1-注释前缀可绕过', from: "    if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }\n", to: '' },
  { id: 'M-1-字面量也转小写', from: '    parts.push(s.slice(i, j + 1));', to: '    parts.push(s.slice(i, j + 1).toLowerCase());' },
  { id: 'M-2-故障后仍提交', from: '          if (state.fault) { failed = true;', to: '          if (false) { failed = true;' },
  { id: '09-R3-收尾取消已接纳语句不作废事务', from: '        if (!marker.active && acceptedInScope) marker.poisoned = true;\n', to: '' },
  { id: '09-R3-抛假值当成功', from: '        failed = true;\n        failure = bizErr;', to: '        failure = bizErr;' },
  { id: '09-R2-驱动错误后不作废事务', from: '      if (marker.poisoned) throw', to: '      if (false) throw' },
  { id: '09-R2-语句不串行', from: '      marker.chain = p.then(() => {}, () => {});\n', to: '' },
  { id: '09-R2-吞错后正常返回仍提交', from: '      if (!failed && marker.poisoned) {', to: '      if (false) {' },
  { id: '09-R2-COMMIT 非 BUSY 错误按未提交', from: '        if (isBusyError(commitErr)) {', to: '        if (true) {' },
  { id: '发布前不查初始化期故障', from: "      if (conn.__faulted) throw new Error('初始化期间连接 error 事件');\n      sbDb = conn;", to: '      sbDb = conn;' },
  { id: '09-R-不核对事务标记', from: '    if (markRow) {', to: '    if (false) {' },
  { id: '09-R-ROLLBACK 成功即判已回滚（不核对标记）', from: "      await runOn(conn, 'ROLLBACK');\n    } catch (rbErr) {", to: "      await runOn(conn, 'ROLLBACK');\n      return 'rolled_back';\n    } catch (rbErr) {" },
  { id: '09-R-不跳前导分号', from: "    const t = s.replace(/^[\\s;]+/, '');", to: "    const t = s.replace(/^\\s+/, '');" },
];

// 09 号 M-4：子进程结果分三类——检出（退出码 1 且汇总行显示有用例失败）/ 未检出（全部通过）/
//   异常（启动失败、被信号终止或整体超时、没有汇总行）。异常不算检出，单列为自检失败。
function runChild(args) {
  const r = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 300000 });
  const m = /^(\d+)\/(\d+) 通过\s*$/m.exec(r.stdout || '');
  const passedN = m ? Number(m[1]) : null;
  const totalN = m ? Number(m[2]) : null;
  if (r.error || r.signal || m === null) return { kind: 'abnormal', detail: (r.error && r.error.message) || r.signal || ((r.stderr || '').split('\n').slice(-4).join(' | ') || '无汇总行') };
  if (r.status === 1 && passedN < totalN) return { kind: 'red', detail: `${passedN}/${totalN}` };
  if (r.status === 0 && passedN === totalN) return { kind: 'green', detail: `${passedN}/${totalN}` };
  return { kind: 'abnormal', detail: `退出码 ${r.status} 与汇总 ${passedN}/${totalN} 不一致` };
}

function selfTest() {
  const base = runChild(['--module', DB_MODULE_DEFAULT]);
  if (base.kind !== 'green') {
    console.log(`  ✗ 未变异基线不是全绿（${base.kind}：${base.detail}），变异自检无意义，终止`);
    return 1;
  }
  console.log(`  ✓ 未变异基线 ${base.detail} 全绿`);
  const src = fs.readFileSync(DB_MODULE_DEFAULT, 'utf8').replace(/\r\n/g, '\n');
  const sqliteAbs = require.resolve('sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-db-mut-'));
  // 分类器自检（09-R M-1）：加载不起来的模块必须判为异常，不能被算作检出。
  fs.writeFileSync(path.join(dir, 'db.js'), `${src}\n这一行不是合法的 JavaScript(\n`);
  const broken = runChild(['--module', path.join(dir, 'db.js')]);
  fs.unlinkSync(path.join(dir, 'db.js'));
  if (broken.kind !== 'abnormal') {
    console.log(`  ✗ 分类器自检：语法错误的模块被判为 ${broken.kind}（应为异常），变异结果不可信，终止`);
    fs.rmdirSync(dir);
    return 1;
  }
  console.log(`  ✓ 分类器自检：语法错误的模块判为异常（${broken.detail}）`);
  let weak = 0;
  for (const mu of MUTATIONS) {
    const count = src.split(mu.from).length - 1;
    if (count !== 1) { console.log(`  ✗ [${mu.id}] 变异锚点出现 ${count} 次（应恰好 1 次）`); weak += 1; continue; }
    const mutated = src.replace(mu.from, mu.to).replace("require('sqlite3')", `require(${JSON.stringify(sqliteAbs)})`);
    const file = path.join(dir, 'db.js');
    fs.writeFileSync(file, mutated);
    const res = runChild(['--module', file]);
    const label = res.kind === 'red' ? `判红（${res.detail}）` : res.kind === 'green' ? '未判红（断言无判别力）' : `异常（${res.detail}），不计为检出`;
    console.log(`  ${res.kind === 'red' ? '✓' : '✗'} [${mu.id}] ${label}`);
    if (res.kind !== 'red') weak += 1;
    fs.unlinkSync(file);
  }
  fs.rmdirSync(dir);
  console.log(`\n变异自检：${MUTATIONS.length - weak}/${MUTATIONS.length} 判红`);
  return weak;
}

(async () => {
  if (SELF_TEST) {
    const weak = selfTest();
    process.exitCode = weak === 0 ? 0 : 1;
    return;
  }
  // 09-R M-1：先在用例循环外加载被测模块；加载失败是「异常」不是「用例失败」，用独立退出码 3、
  //   不打印汇总行，变异自检据此归为异常而不计为检出。
  try {
    loadFactory();
  } catch (e) {
    console.log(`被测模块加载失败（不计为用例失败）: ${e && e.message}`);
    process.exitCode = 3;
    return;
  }
  const failed = await runAll();
  await closeModuleConns();
  cleanupTmp();
  process.exitCode = failed === 0 ? 0 : 1;
})();
