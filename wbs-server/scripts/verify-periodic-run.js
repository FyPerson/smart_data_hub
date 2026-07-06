// 验证脚本：周期取数推送模块 ③ 一键跑数落盘（集成点2，方案 §2②③/§4.2/§4.4/§5.2，任务书附录 A.2/A.3）
//   用法：node scripts/verify-periodic-run.js
//
// require routes/periodic-fetch/index.js + routes/periodic-fetch/runner.js 真实逻辑（禁止复刻）。
// 外部依赖用 mock（pool.request 返固定 recordset/流式事件序列），不连真实业务库（任务书附录 A.5）。
//
// 断言覆盖（两个层次）：
//   [单元层] runner.js 纯函数：Asia/Shanghai 上月区间跨年边界 / mssql 流式行数上限触发(cancel) /
//     mssql 查询超时/查询错误分类 / mysql 缓冲行数上限 / xlsx 生成基本形态 / 结果文件路径安全校验
//     （越界拒/不存在拒）+ 删除守卫（成功删/越界拒）。
//   [端点层] POST /run 全状态机：success(非空)/empty_result(0行,仍生成文件)/failed(行数超限·查询错误·
//     查询超时·连接密码解密失败·目标连接不存在·任务已禁用) + 运行前双校验兜底(模板被绕过 CRUD 直接改库
//     注入残留占位符/危险SQL,运行前必须再拦一次) + 下载端点(鉴权/无文件409/文件已清理409/路径穿越防护
//     自愈missing) + 删除守卫端点(手动清理/幂等/物理已丢失标missing) + requireAdmin 401 覆盖。
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const EventEmitter = require('events');
const XLSX = require('xlsx');

const runner = require('../routes/periodic-fetch/runner');

const SECRET = 'verify-periodic-run-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ============================================================
// § 单元层：mock mssql 流式 request（EventEmitter，模拟 tedious/mssql query() 语义——
//   stream 模式下 Promise 无论成功/失败/cancel 都会 resolve，err 由 'error' 事件单独通知）。
// ============================================================
function makeMockMssqlRequest(scenario) {
  const req = new EventEmitter();
  req.stream = null;
  req.timeout = null;
  req.canceled = false;
  req.cancel = () => { req.canceled = true; };
  req.query = () => new Promise((resolve) => {
    setImmediate(() => {
      if (scenario.columns) req.emit('recordset', scenario.columns);
      let idx = 0;
      function emitNext() {
        if (req.canceled) {
          req.emit('error', new Error('Canceled.'));
          resolve({ recordsets: [], recordset: undefined });
          return;
        }
        if (idx >= (scenario.rows || []).length) {
          if (scenario.errorAtEnd) req.emit('error', scenario.errorAtEnd);
          resolve({ recordsets: [], recordset: undefined });
          return;
        }
        req.emit('row', scenario.rows[idx]);
        idx++;
        setImmediate(emitNext);
      }
      emitNext();
    });
  });
  return req;
}
function makeMockMssqlPool(scenario) {
  return { request: () => makeMockMssqlRequest(scenario) };
}

async function unitTests() {
  console.log('\n[单元层] runner.js 纯函数');

  // ── 1. Asia/Shanghai 上月区间：跨年边界（写死时区，不依赖服务器 tz）──
  let r = runner.computeLastMonthRangeShanghai(new Date('2026-07-03T01:00:00Z'));
  assert.deepStrictEqual(r, { start: '2026-06-01', end: '2026-07-01' });
  ok('普通月份：2026-07-03(UTC) → 上月区间 [2026-06-01, 2026-07-01)');

  r = runner.computeLastMonthRangeShanghai(new Date('2025-12-31T16:30:00Z')); // UTC 16:30 Dec31 = 上海 00:30 Jan1
  assert.deepStrictEqual(r, { start: '2025-12-01', end: '2026-01-01' });
  ok('跨年边界：UTC Dec31 16:30 = 上海 Jan1 00:30 → 上月区间 [2025-12-01, 2026-01-01)（写死时区不受服务器tz影响）');

  // ── 2. mssql 流式行数上限：maxRows=3，实际 5 行 → 第 4 行触发 cancel + ROW_LIMIT_EXCEEDED ──
  const cols = { a: { index: 0, name: 'a' }, b: { index: 1, name: 'b' } };
  const rows5 = [1, 2, 3, 4, 5].map((n) => ({ a: n, b: 'x' + n }));
  let pool = makeMockMssqlPool({ columns: cols, rows: rows5 });
  let outcome = await runner.runMssqlFullQuery(pool, 'SELECT a,b FROM t', { maxRows: 3, timeoutMs: 5000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'ROW_LIMIT_EXCEEDED');
  assert.strictEqual(outcome.rowCount, 4, '应在第4行(超过maxRows=3)时判定超限并停止计数');
  ok('mssql 流式：maxRows=3 实际5行 → 第4行 cancel + ROW_LIMIT_EXCEEDED（不隐式截断，直接失败）');

  // ── 3. mssql 正常成功：3 行全部放行 ──
  pool = makeMockMssqlPool({ columns: cols, rows: rows5.slice(0, 3) });
  outcome = await runner.runMssqlFullQuery(pool, 'SELECT a,b FROM t', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.rowCount, 3);
  assert.deepStrictEqual(outcome.columns, ['a', 'b']);
  ok('mssql 流式：3行不超限 → success，columns 顺序取自 recordset 元数据');

  // ── 4. mssql 0 行（empty_result 场景的执行层基础）──
  pool = makeMockMssqlPool({ columns: cols, rows: [] });
  outcome = await runner.runMssqlFullQuery(pool, 'SELECT a,b FROM t WHERE 1=0', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.rowCount, 0);
  assert.deepStrictEqual(outcome.columns, ['a', 'b'], '0 行时仍应拿到列头（recordset 元数据先于 row 到达）');
  ok('mssql 流式：0 行 → success + rowCount=0（列头仍在，供空结果 xlsx 生成表头）');

  // ── 5. mssql 查询错误（非 cancel）→ QUERY_ERROR ──
  pool = makeMockMssqlPool({ columns: cols, rows: [], errorAtEnd: new Error('Invalid column name xyz.') });
  outcome = await runner.runMssqlFullQuery(pool, 'SELECT xyz FROM t', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'QUERY_ERROR');
  ok('mssql 流式：查询报错(非取消) → QUERY_ERROR');

  // ── 6. mssql 超时错误 → QUERY_TIMEOUT ──
  const timeoutErr = Object.assign(new Error('Timeout: Request failed to complete in 60000ms'), { code: 'ETIMEOUT' });
  pool = makeMockMssqlPool({ columns: cols, rows: [], errorAtEnd: timeoutErr });
  outcome = await runner.runMssqlFullQuery(pool, 'SELECT a FROM slow_view', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'QUERY_TIMEOUT');
  ok('mssql 流式：ETIMEOUT/超时字样错误 → 归类 QUERY_TIMEOUT（非泛化 QUERY_ERROR）');

  // ── 7. pool.request() 本身抛错（连接已断）→ POOL_REQUEST_FAILED ──
  const brokenPool = { request: () => { throw new Error('connection is closed'); } };
  outcome = await runner.runMssqlFullQuery(brokenPool, 'SELECT 1', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'POOL_REQUEST_FAILED');
  ok('mssql：pool.request() 抛错 → POOL_REQUEST_FAILED（连接失败兜底不崩溃）');

  // ── 8. mysql 缓冲行数上限：maxRows=2，实际3行 → ROW_LIMIT_EXCEEDED ──
  const mysqlRows3 = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const mysqlFields = [{ name: 'a' }];
  let mysqlPool = { query: async () => [mysqlRows3, mysqlFields] };
  outcome = await runner.runMysqlFullQuery(mysqlPool, 'SELECT a FROM t', { maxRows: 2, timeoutMs: 5000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'ROW_LIMIT_EXCEEDED');
  assert.strictEqual(outcome.rowCount, 3);
  ok('mysql 缓冲：maxRows=2 实际3行 → ROW_LIMIT_EXCEEDED（后置校验，标注与 mssql 流式的不对称风险已知）');

  // ── 9. mysql 正常成功 ──
  mysqlPool = { query: async () => [mysqlRows3, mysqlFields] };
  outcome = await runner.runMysqlFullQuery(mysqlPool, 'SELECT a FROM t', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.rowCount, 3);
  ok('mysql 缓冲：3行不超限 → success');

  // ── 9b. E-1 mssql 重名输出列检测：物理 2 列都叫 id（recordset 折叠成 1 键但 index=1 泄露物理列数）→ DUPLICATE_COLUMNS ──
  //   构造：recordset 元数据对象只剩一个键 id（后写覆盖），但其 index=1 表明物理上有 index 0 和 1 两列。
  const dupCols = { id: { index: 1, name: 'id' } }; // maxIndex=1 → physicalCount=2 > keys=1 → 重名
  pool = makeMockMssqlPool({ columns: dupCols, rows: [{ id: 5 }] });
  outcome = await runner.runMssqlFullQuery(pool, 'SELECT a.id, b.id FROM a JOIN b', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'DUPLICATE_COLUMNS', 'mssql 折叠列检测：物理列数>唯一列名数 → DUPLICATE_COLUMNS（宁失败不静默丢列）');
  ok('E-1 mssql：同名输出列（SELECT a.id,b.id）→ DUPLICATE_COLUMNS 拒（index 泄露物理列数，防静默丢敏感列）');

  // ── 9c. E-1 mysql 重名输出列检测：fields 有序含重复名 → DUPLICATE_COLUMNS + 列出重复名 ──
  mysqlPool = { query: async () => [[{ id: 1 }], [{ name: 'id' }, { name: 'id' }, { name: 'val' }]] };
  outcome = await runner.runMysqlFullQuery(mysqlPool, 'SELECT a.id, b.id, val FROM a JOIN b', { maxRows: 100000, timeoutMs: 60000 });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.code, 'DUPLICATE_COLUMNS');
  assert.deepStrictEqual(outcome.duplicateColumns, ['id'], 'mysql fields 数组保留重复名 → 精确列出重复列');
  ok('E-1 mysql：fields 含重复列名 → DUPLICATE_COLUMNS 并列出重复列名 id');

  // ── 10. xlsx 生成基本形态：列头 + 数据行 + 可被 XLSX 重新读回 ──
  const buf = runner.buildResultXlsxBuffer(['col1', 'col2'], [{ col1: 'v1', col2: 2 }, { col1: null, col2: 3 }]);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'xlsx buffer 应非空');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepStrictEqual(aoa[0], ['col1', 'col2'], '首行应为列头');
  assert.strictEqual(aoa[1][0], 'v1');
  assert.strictEqual(aoa[1][1], 2);
  ok('xlsx 生成：列头+数据行正确，可被 XLSX 重新解析（含 null 值不炸）');

  // ── 11. 结果文件路径安全：写入→安全解析成功；不存在路径→null；越界路径→null ──
  const goodPath = runner.writeResultFile(Buffer.from('test-content'));
  const safe = runner.resolveSafeResultPath(goodPath);
  assert.ok(safe, '正常落盘路径应能安全解析');
  assert.strictEqual(runner.resolveSafeResultPath(path.join(runner.PERIODIC_RESULTS_DIR, 'not-exist.xlsx')), null, '不存在的文件应返回 null');
  const outsidePath = path.join(runner.PERIODIC_RESULTS_DIR, '..', 'outside-periodic-results.txt');
  fs.writeFileSync(outsidePath, 'evil');
  assert.strictEqual(runner.resolveSafeResultPath(outsidePath), null, '目录外路径（含 realpath 后落在子树外）应拒绝，防路径穿越');
  fs.unlinkSync(outsidePath);
  ok('路径安全：正常落盘可解析 / 不存在→null / 越界（子树外）→null（防路径穿越）');

  // ── 12. 删除守卫：成功删除 + 越界/不存在时拒绝 ──
  const delResult = runner.deleteResultFileGuarded(goodPath);
  assert.strictEqual(delResult.ok, true);
  assert.ok(!fs.existsSync(goodPath), '删除守卫应真正物理删除文件');
  const delAgain = runner.deleteResultFileGuarded(goodPath);
  assert.strictEqual(delAgain.ok, false);
  assert.strictEqual(delAgain.reason, 'NOT_FOUND_OR_OUTSIDE');
  ok('删除守卫：成功删除物理文件 / 已不存在再删 → NOT_FOUND_OR_OUTSIDE（不越界删除任意路径）');
}

// ============================================================
// § 端点层：完整 HTTP 路由测试（真实 router，mock getMssqlPool/getMysqlPool/decryptPassword）
// ============================================================
const MSSQL_SCENARIOS = {};
const MYSQL_SCENARIOS = {};
const BAD_PASSWORD_MARKER = '__BAD_PASSWORD__';

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: (req, res, next) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: '未登录' });
    try { req.user = jwt.verify(tok, SECRET); next(); } catch { return res.status(403).json({ error: '登录过期' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '权限不足' }),
  getMssqlPool: async (cfg) => {
    const scenario = MSSQL_SCENARIOS[cfg.database];
    if (!scenario) throw new Error('未知 mssql scenario: ' + cfg.database);
    return makeMockMssqlPool(scenario);
  },
  getMysqlPool: async (cfg) => {
    const scenario = MYSQL_SCENARIOS[cfg.database];
    if (!scenario) throw new Error('未知 mysql scenario: ' + cfg.database);
    return { query: async () => [scenario.rows, scenario.fields] };
  },
  readSystemConfig: async () => null,
  maskPhone: (p) => (p ? String(p).slice(0, 3) + '****' : p),
  decryptPassword: (enc) => {
    if (enc === BAD_PASSWORD_MARKER) throw new Error('解密失败：密钥不匹配');
    return enc;
  },
};

const mod = require('../routes/periodic-fetch')(deps);
const I = mod._internals;

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.PERIODIC_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.PERIODIC_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);

let server, port;
function call(method, urlPath, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        const ct = r.headers['content-type'] || '';
        if (ct.includes('json')) {
          try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { parsed = null; }
        }
        resolve({ status: r.statusCode, headers: r.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedSourceConnections() {
  await run(`CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT, type TEXT, host TEXT, port INTEGER, database TEXT, username TEXT, password TEXT, connection_type TEXT)`);
  const rows = [
    [10, 'DB_SUCCESS5', 'sqlserver', 'h1', 1433, 'DB_SUCCESS5', 'u', 'pw', 'source'],
    [13, 'DB_EMPTY', 'sqlserver', 'h1', 1433, 'DB_EMPTY', 'u', 'pw', 'source'],
    [14, 'DB_QUERYERR', 'sqlserver', 'h1', 1433, 'DB_QUERYERR', 'u', 'pw', 'source'],
    [15, 'DB_TIMEOUT', 'sqlserver', 'h1', 1433, 'DB_TIMEOUT', 'u', 'pw', 'source'],
    [16, 'DB_BADPW', 'sqlserver', 'h1', 1433, 'DB_BADPW', 'u', BAD_PASSWORD_MARKER, 'source'],
    [17, 'DB_MYSQL_SUCCESS', 'mysql', 'h2', 3306, 'DB_MYSQL_SUCCESS', 'u2', 'pw2', 'source'],
    [18, 'DB_DUPCOLS', 'sqlserver', 'h1', 1433, 'DB_DUPCOLS', 'u', 'pw', 'source'],
    [20, 'DB_TO_BE_DELETED', 'sqlserver', 'h1', 1433, 'DB_TO_BE_DELETED', 'u', 'pw', 'source'],
  ];
  for (const r of rows) {
    await run(`INSERT INTO db_connections (id,name,type,host,port,database,username,password,connection_type) VALUES (?,?,?,?,?,?,?,?,?)`, r);
  }
  MSSQL_SCENARIOS['DB_SUCCESS5'] = { columns: { a: { index: 0, name: 'a' }, b: { index: 1, name: 'b' } }, rows: [1, 2, 3].map((n) => ({ a: n, b: 'x' + n })) };
  MSSQL_SCENARIOS['DB_EMPTY'] = { columns: { a: { index: 0, name: 'a' } }, rows: [] };
  MSSQL_SCENARIOS['DB_QUERYERR'] = { columns: {}, rows: [], errorAtEnd: new Error('Invalid object name t.') };
  MSSQL_SCENARIOS['DB_TIMEOUT'] = { columns: {}, rows: [], errorAtEnd: Object.assign(new Error('Timeout: Request failed to complete in 60000ms'), { code: 'ETIMEOUT' }) };
  MSSQL_SCENARIOS['DB_BADPW'] = { columns: {}, rows: [] }; // 不会被真正调用(密码解密先失败)
  MSSQL_SCENARIOS['DB_DUPCOLS'] = { columns: { id: { index: 1, name: 'id' } }, rows: [{ id: 5 }] }; // E-1：物理 2 列同名 id
  MSSQL_SCENARIOS['DB_TO_BE_DELETED'] = { columns: {}, rows: [] };
  MYSQL_SCENARIOS['DB_MYSQL_SUCCESS'] = { rows: [{ a: 1 }, { a: 2 }], fields: [{ name: 'a' }] };
}

const VALID_TEMPLATE = `SELECT a, b FROM t WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'`;

async function createTask(name, sourceConnectionId) {
  const r = await call('POST', '/api/periodic-tasks', adminTok, {
    task_name: name, source_connection_id: sourceConnectionId, script_template: VALID_TEMPLATE,
  });
  assert.strictEqual(r.status, 201, `建任务 ${name} 应 201，实际 ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

async function endpointTests() {
  console.log('\n[端点层] POST /run 状态机 + 下载 + 删除守卫');
  await seedSourceConnections();

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;

  // ── [1] success：3 行 → status=success, row_count=3, file present ──
  const taskA = await createTask('T-success', 10);
  let r = await call('POST', `/api/periodic-tasks/${taskA}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'success');
  assert.strictEqual(r.body.row_count, 3);
  const runIdA = r.body.run_id;
  ok(`success：3 行执行成功 → run #${runIdA} status=success row_count=3`);

  // ── [2] empty_result：0 行 → status=empty_result（不与 success 混同）──
  const taskB = await createTask('T-empty', 13);
  r = await call('POST', `/api/periodic-tasks/${taskB}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'empty_result');
  assert.strictEqual(r.body.row_count, 0);
  const runIdB = r.body.run_id;
  ok(`empty_result：0 行 → run #${runIdB} status=empty_result（方案 §5.2 单独标识不与 success 混同）`);

  // ── [3] failed：查询报错 ──
  const taskC = await createTask('T-queryerr', 14);
  r = await call('POST', `/api/periodic-tasks/${taskC}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'failed');
  ok(`failed：查询报错 → run #${r.body.run_id} status=failed（error_msg: ${r.body.error}）`);

  // ── [4] failed：查询超时 ──
  const taskD = await createTask('T-timeout', 15);
  r = await call('POST', `/api/periodic-tasks/${taskD}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'failed');
  assert.ok(/超时/.test(r.body.error), '超时错误文案应含"超时"字样');
  ok(`failed：查询超时(ETIMEOUT) → run #${r.body.run_id} status=failed，文案含"超时"`);

  // ── [5] failed：目标库密码解密失败 ──
  const taskE = await createTask('T-badpw', 16);
  r = await call('POST', `/api/periodic-tasks/${taskE}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'failed');
  assert.strictEqual(r.body.code, 'CONN_DECRYPT_FAILED');
  ok(`failed：目标库密码解密失败 → run #${r.body.run_id} status=failed code=CONN_DECRYPT_FAILED`);

  // ── [6] MySQL 方言：正常成功执行（双方言支持）──
  const taskF = await createTask('T-mysql', 17);
  r = await call('POST', `/api/periodic-tasks/${taskF}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'success');
  assert.strictEqual(r.body.row_count, 2);
  ok(`MySQL 方言：run #${r.body.run_id} status=success row_count=2（双方言全量执行路由生效）`);

  // ── [7] TASK_DISABLED：禁用任务不可执行 ──
  const taskG = await createTask('T-disabled', 10);
  await call('POST', `/api/periodic-tasks/${taskG}/disable`, adminTok);
  r = await call('POST', `/api/periodic-tasks/${taskG}/run`, adminTok);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'TASK_DISABLED');
  ok('TASK_DISABLED：禁用任务调用 /run → 409（禁用=退役，不可执行）');

  // ── [8] SOURCE_CONNECTION_NOT_FOUND：任务注册后连接被删除 ──
  const taskH = await createTask('T-conn-gone', 20);
  await run(`DELETE FROM db_connections WHERE id = 20`);
  r = await call('POST', `/api/periodic-tasks/${taskH}/run`, adminTok);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'SOURCE_CONNECTION_NOT_FOUND');
  ok('SOURCE_CONNECTION_NOT_FOUND：任务注册后目标连接被删除 → 409（运行前防御性重查）');

  // ── [9] 运行前兜底校验：CRUD 校验被绕过（直接改库注入残留占位符）→ /run 仍应拒绝 ──
  const taskI = await createTask('T-bypass-residual', 10);
  await run(`UPDATE periodic_tasks SET script_template = ? WHERE id = ?`, [`SELECT * FROM t WHERE d>='{{MONTH_START}}' AND x='{{UNKNOWN_X}}'`, taskI]);
  // 直接写库绕过占位符白名单校验(模拟"模板被改")，UNKNOWN_X 不在受支持列表内，替换后仍会残留 {{UNKNOWN_X}}
  r = await call('POST', `/api/periodic-tasks/${taskI}/run`, adminTok);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'PLACEHOLDER_RESIDUAL');
  ok('运行前兜底：CRUD 校验被绕过注入未知占位符 → /run 仍 400 PLACEHOLDER_RESIDUAL（替换后残留 {{UNKNOWN_X}}）');

  const taskJ = await createTask('T-bypass-danger', 10);
  await run(`UPDATE periodic_tasks SET script_template = ? WHERE id = ?`, [`SELECT * FROM t WHERE d>='{{MONTH_START}}'; DROP TABLE t;--`, taskJ]);
  r = await call('POST', `/api/periodic-tasks/${taskJ}/run`, adminTok);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'SQL_FORM_REJECTED');
  ok('运行前兜底：CRUD 校验被绕过注入多语句 DROP TABLE → /run 仍 400 SQL_FORM_REJECTED（双校验兜底生效）');

  // ── [10] requireAdmin：无 token → 401 ──
  r = await call('POST', `/api/periodic-tasks/${taskA}/run`, null);
  assert.strictEqual(r.status, 401);
  ok('POST /run 无 token → 401');

  // ── [11] 下载：成功 run 可下载，内容为合法 xlsx ──
  r = await call('GET', `/api/periodic-tasks/runs/${runIdA}/download`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers['content-disposition'].includes('periodic-run-'), 'Content-Disposition 应含 ascii 兜底文件名');
  assert.ok(r.headers['content-disposition'].includes("filename*=UTF-8''"), 'Content-Disposition 应含 UTF-8 展示名');
  const wbDown = XLSX.read(r.raw, { type: 'buffer' });
  const sheetDown = wbDown.Sheets[wbDown.SheetNames[0]];
  const aoaDown = XLSX.utils.sheet_to_json(sheetDown, { header: 1 });
  assert.deepStrictEqual(aoaDown[0], ['a', 'b']);
  ok(`下载：run #${runIdA} → 200，双文件名头（ascii+UTF-8），内容为合法 xlsx 且列头匹配`);

  // ── [12] 下载：failed run 无文件 → 409 RUN_HAS_NO_FILE ──
  r = await call('GET', `/api/periodic-tasks/runs/${(await call('POST', `/api/periodic-tasks/${taskC}/run`, adminTok)).body.run_id}/download`, adminTok);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'RUN_HAS_NO_FILE');
  ok('下载：failed run → 409 RUN_HAS_NO_FILE（未生成有效文件）');

  // ── [13] 下载：无 token → 401 ──
  r = await call('GET', `/api/periodic-tasks/runs/${runIdA}/download`, null);
  assert.strictEqual(r.status, 401);
  ok('下载端点无 token → 401（方案 §4.4 下载鉴权硬约束）');

  // ── [14] 删除守卫：手动清理成功 → file_status=cleaned；再次清理幂等 ──
  const taskK = await createTask('T-to-clean', 10);
  r = await call('POST', `/api/periodic-tasks/${taskK}/run`, adminTok);
  const runIdK = r.body.run_id;
  r = await call('POST', `/api/periodic-tasks/runs/${runIdK}/file/clean`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.file_status, 'cleaned');
  ok(`删除守卫：run #${runIdK} 手动清理 → file_status=cleaned`);
  r = await call('POST', `/api/periodic-tasks/runs/${runIdK}/file/clean`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.ok(/幂等/.test(r.body.message || ''));
  ok('删除守卫：已清理的 run 再次清理 → 200 幂等（非报错）');

  // ── [15] 下载：已清理的 run → 409 FILE_NOT_PRESENT ──
  r = await call('GET', `/api/periodic-tasks/runs/${runIdK}/download`, adminTok);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'FILE_NOT_PRESENT');
  ok('下载：文件已清理的 run → 409 FILE_NOT_PRESENT（方案 §4.4"清理后重发需重新跑本月"）');

  // ── [16] 路径穿越防护自愈：DB 里 result_file_path 被篡改指向目录外 → 下载自愈为 missing ──
  const taskL = await createTask('T-traversal', 10);
  r = await call('POST', `/api/periodic-tasks/${taskL}/run`, adminTok);
  const runIdL = r.body.run_id;
  const outsideEvil = path.join(runner.PERIODIC_RESULTS_DIR, '..', 'evil-traversal-test.xlsx');
  fs.writeFileSync(outsideEvil, 'evil-content');
  await run(`UPDATE periodic_task_runs SET result_file_path = ? WHERE id = ?`, [outsideEvil, runIdL]);
  r = await call('GET', `/api/periodic-tasks/runs/${runIdL}/download`, adminTok);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'FILE_MISSING');
  const runRowL = await get(`SELECT file_status FROM periodic_task_runs WHERE id = ?`, [runIdL]);
  assert.strictEqual(runRowL.file_status, 'missing', '路径越界应自愈标记 file_status=missing（不下发文件）');
  fs.unlinkSync(outsideEvil);
  ok(`路径穿越防护：run #${runIdL} result_file_path 被篡改指向目录外 → 下载 404 FILE_MISSING + file_status 自愈为 missing`);

  // ── [17] 删除守卫：物理文件已被意外删除（未走清理端点）→ 手动清理端点应报 missing ──
  const taskM = await createTask('T-physically-gone', 10);
  r = await call('POST', `/api/periodic-tasks/${taskM}/run`, adminTok);
  const runIdM = r.body.run_id;
  const runRowM = await get(`SELECT result_file_path FROM periodic_task_runs WHERE id = ?`, [runIdM]);
  fs.unlinkSync(runRowM.result_file_path); // 绕过端点直接删物理文件，模拟"文件不存在异常"
  r = await call('POST', `/api/periodic-tasks/runs/${runIdM}/file/clean`, adminTok);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'FILE_MISSING');
  const runRowM2 = await get(`SELECT file_status FROM periodic_task_runs WHERE id = ?`, [runIdM]);
  assert.strictEqual(runRowM2.file_status, 'missing', '物理文件已丢失应标记 missing（区别于正常清理 cleaned，方案 §4.4）');
  ok(`删除守卫：run #${runIdM} 物理文件已被意外删除 → 清理端点 404 FILE_MISSING + file_status=missing（区别于正常 cleaned）`);

  // ── [18] E-1 端点：source 返回同名输出列 → run 落 failed DUPLICATE_COLUMNS（宁失败不静默丢敏感列）──
  const taskDup = await createTask('T-dupcols', 18);
  r = await call('POST', `/api/periodic-tasks/${taskDup}/run`, adminTok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'failed');
  assert.strictEqual(r.body.code, 'DUPLICATE_COLUMNS');
  const dupRow = await get(`SELECT status, error_msg, result_file_path FROM periodic_task_runs WHERE id = ?`, [r.body.run_id]);
  assert.strictEqual(dupRow.status, 'failed');
  assert.strictEqual(dupRow.result_file_path, null, '重名列失败不应生成结果文件');
  assert.ok(/别名/.test(dupRow.error_msg || ''), '错误文案应提示加列别名');
  ok('E-1 端点：同名输出列 → run failed DUPLICATE_COLUMNS + 无结果文件 + 文案提示加别名（不静默丢敏感列）');

  // ── [19] M-2① buildResultXlsxBuffer 抛错（如大结果 XLSX.write RangeError）→ 落 failed，不卡 running ──
  const origBuild = runner.buildResultXlsxBuffer;
  runner.buildResultXlsxBuffer = () => { throw new Error('模拟 XLSX.write RangeError（结果过大）'); };
  const taskX = await createTask('T-xlsx-throw', 10);
  r = await call('POST', `/api/periodic-tasks/${taskX}/run`, adminTok);
  runner.buildResultXlsxBuffer = origBuild; // 立即恢复
  assert.strictEqual(r.status, 500);
  const xRow = await get(`SELECT status, error_msg FROM periodic_task_runs WHERE id = ?`, [r.body.run_id]);
  assert.strictEqual(xRow.status, 'failed', 'M-2①：buildXlsx 抛错 → run 落 failed（不永久卡 running）');
  assert.ok(/生成\/落盘失败/.test(xRow.error_msg || ''));
  ok('M-2①：buildResultXlsxBuffer 抛错（纳入 try）→ run 落 failed 不卡 running（旧代码它在 try 外会留僵尸 running）');

  // ── [20] M-2② 终态 UPDATE 失败 → 删孤儿结果文件 + 落 failed（避免磁盘留无法回收的敏感孤儿）──
  const dbRunTermFail = async (sql, params) => {
    if (/result_file_path=\?/.test(sql)) throw new Error('模拟终态 UPDATE DB 故障');
    return run(sql, params);
  };
  const modTF = require('../routes/periodic-fetch')({ ...deps, dbRunAsync: dbRunTermFail });
  modTF.initSchema();
  await new Promise((res, rej) => { let n = 0; const t = setInterval(() => { if (modTF._internals.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); } else if (++n > 500) { clearInterval(t); rej(new Error('TF readiness 超时')); } }, 10); });
  const appTF = express(); appTF.use(express.json()); appTF.use('/api', modTF.router);
  const serverTF = http.createServer(appTF);
  await new Promise((res) => serverTF.listen(0, '127.0.0.1', res));
  const portTF = serverTF.address().port;
  const callTF = (m, p, tok, body) => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const rq = http.request({ host: '127.0.0.1', port: portTF, path: p, method: m, headers }, (rr) => { let b = ''; rr.on('data', (c) => b += c); rr.on('end', () => resolve({ status: rr.statusCode, body: b ? JSON.parse(b) : null })); });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
  // 建任务走本 server（modTF），run → 终态 UPDATE 抛错 → 删孤儿 + 落 failed
  const cTask = await callTF('POST', '/api/periodic-tasks', adminTok, { task_name: 'T-termfail', source_connection_id: 10, script_template: VALID_TEMPLATE });
  assert.strictEqual(cTask.status, 201);
  const filesBefore = fs.readdirSync(runner.PERIODIC_RESULTS_DIR).length;
  r = await callTF('POST', `/api/periodic-tasks/${cTask.body.id}/run`, adminTok);
  assert.strictEqual(r.status, 500);
  const filesAfter = fs.readdirSync(runner.PERIODIC_RESULTS_DIR).length;
  assert.strictEqual(filesAfter, filesBefore, 'M-2②：终态失败时已写盘的孤儿结果文件应被删除（目录文件数不增）');
  const tfRow = await get(`SELECT status, result_file_path, file_status, error_msg FROM periodic_task_runs WHERE id = ?`, [r.body.run_id]);
  assert.strictEqual(tfRow.status, 'failed');
  assert.strictEqual(tfRow.result_file_path, null, '终态失败后 result_file_path 回滚为 NULL');
  assert.strictEqual(tfRow.file_status, 'missing');
  assert.ok(/终态写入失败/.test(tfRow.error_msg || ''));
  serverTF.close();
  ok('M-2②：终态 UPDATE 失败 → 删孤儿结果文件（目录文件数不增）+ 落 failed + result_file_path=NULL/file_status=missing');

  // ── [21] M-2③ 僵尸 run reaper：running 且 started_at 超阈值 → 启动复位为 failed；新鲜 running 不动 ──
  const staleIns = await run(
    `INSERT INTO periodic_task_runs (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot, triggered_by, date_range_start, date_range_end, started_at, status)
     VALUES (?, 'SELECT 1', 'T-stale', 'c(sqlserver)', 1, 1, '2026-06-01', '2026-07-01', datetime('now','localtime','-30 minutes'), 'running')`,
    [taskX]
  );
  const freshIns = await run(
    `INSERT INTO periodic_task_runs (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot, triggered_by, date_range_start, date_range_end, started_at, status)
     VALUES (?, 'SELECT 1', 'T-fresh-running', 'c(sqlserver)', 1, 1, '2026-06-01', '2026-07-01', datetime('now','localtime'), 'running')`,
    [taskX]
  );
  await mod._internals.reapStaleRunningRuns();
  const staleRow = await get(`SELECT status, error_msg FROM periodic_task_runs WHERE id = ?`, [staleIns.lastID]);
  const freshRow = await get(`SELECT status FROM periodic_task_runs WHERE id = ?`, [freshIns.lastID]);
  assert.strictEqual(staleRow.status, 'failed', '超阈值 running → reaper 复位 failed');
  assert.ok(/自愈复位/.test(staleRow.error_msg || ''));
  assert.strictEqual(freshRow.status, 'running', '新鲜 running（未超阈值）不被 reaper 误伤');
  ok('M-2③ reaper：超阈值僵尸 running → failed 自愈复位；新鲜 running 不误伤（双条件守卫 status+started_at）');

  // ── [22] W-1 clean 端点 status 守卫：对 running run 清理 → 409 RUN_IN_PROGRESS（不误写 missing）──
  const wRun = await run(
    `INSERT INTO periodic_task_runs (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot, triggered_by, date_range_start, date_range_end, started_at, file_status, status)
     VALUES (?, 'SELECT 1', 'T-w1', 'c(sqlserver)', 1, 1, '2026-06-01', '2026-07-01', datetime('now','localtime'), 'present', 'running')`,
    [taskX]
  );
  r = await call('POST', `/api/periodic-tasks/runs/${wRun.lastID}/file/clean`, adminTok);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'RUN_IN_PROGRESS');
  const wRow = await get(`SELECT file_status FROM periodic_task_runs WHERE id = ?`, [wRun.lastID]);
  assert.strictEqual(wRow.file_status, 'present', 'W-1：对 running run 清理被拒，file_status 不被误写 missing');
  ok('W-1：clean 端点补 status 守卫——对 running run 清理 → 409 RUN_IN_PROGRESS，file_status 不失真');
}

// 测试卫生：本脚本在真实 periodic-results/ 目录落盘测试 xlsx（该目录只被本模块自身 verify 脚本使用，
//   非生产路径），跑完清空目录内容，避免残留污染下次运行/误导人工检查目录。
function cleanupResultsDir() {
  try {
    const dir = runner.PERIODIC_RESULTS_DIR;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* 目录不存在等异常忽略,不影响验证结果判定 */ }
}

async function main() {
  mod.initSchema();
  await waitReady();
  await unitTests();
  await endpointTests();
  console.log(`\n[全部通过] ${passed} ✓ 周期取数推送 ③一键跑数落盘 验证通过`);
  console.log('  覆盖：Asia/Shanghai上月区间跨年 + mssql流式行数上限(cancel)/超时/查询错误/连接失败 + mysql缓冲行数上限 + E-1重名列检测(mssql折叠+mysql fields) + xlsx生成 + 路径安全+删除守卫 + 端点状态机(success/empty_result/failed×4类)+运行前兜底双校验 + 下载(鉴权/无文件/已清理/路径穿越自愈) + 删除守卫端点(手动/幂等/物理丢失) + E-1端点DUPLICATE_COLUMNS + M-2①buildXlsx抛错落failed + M-2②终态UPDATE失败删孤儿 + M-2③reaper僵尸复位 + W-1 clean对running 409 + requireAdmin');
  server.close();
  db.close();
  cleanupResultsDir();
}

main().catch((e) => {
  console.error('\n[失败]', e.message, e.stack);
  if (server) server.close();
  db.close();
  cleanupResultsDir();
  process.exit(1);
});
