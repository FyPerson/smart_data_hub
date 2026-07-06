// 验证脚本：周期取数推送模块 任务 CRUD 端点（集成点1 ②，方案 §2/§5.1）
//   用法：node scripts/verify-periodic-task-crud.js
//
// in-process express app（挂真实 router，真实 JWT authenticateToken + requireAdmin，对齐 verify-sys-flow.js
//   范式）+ 内存库 + seed db_connections（source 连接）+ 自签 token，测端点全链路：
//   1. 建单（登记）：合法建单 201 / 缺字段 400 / 未知 source_connection_id 400 / 占位符校验失败 400 /
//      SQL 形态校验失败 400 / 同名 active 冲突 409
//   2. requireAdmin：无 token 401 / 非 admin 角色 403
//   3. 改（PUT）：改模板 → template_version+1 / 不改模板 → version 不变 / 改 status 字段被拒 400 /
//      task_name 冲突 409 / 目标不存在 404
//   4. 禁用：合法禁用 200 → 同名可重新注册新 active 任务 / 重复禁用幂等 200 / 目标不存在 404
//   5. 列表 + 详情：?status 过滤 / 详情含 source_connection 快照信息 / 详情不存在 404
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-periodic-crud-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// authenticateToken/requireAdmin 真实行为模拟（对齐 server.js:3602-3633 语义：无 token→401，非 admin→403）
const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录,请先登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(403).json({ error: '登录已过期,请重新登录' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin')
  ? next()
  : res.status(403).json({ error: '权限不足,需要管理员权限' });

// 集成点2 起 REQUIRED_DEPS 扩了 5 项（getMssqlPool/getMysqlPool/readSystemConfig/maskPhone/
//   decryptPassword），本脚本只测任务 CRUD，用不到跑数/推送分支，给最简 mock 保证工厂能构造成功。
const mod = require('../routes/periodic-fetch')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  getMssqlPool: async () => ({ request: () => { throw new Error('mock：CRUD verify 不应触发'); } }),
  getMysqlPool: async () => ({ query: async () => { throw new Error('mock：CRUD verify 不应触发'); } }),
  readSystemConfig: async () => null,
  maskPhone: () => '[mock]',
  decryptPassword: (x) => x,
});
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
const userTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (tok !== null) headers['Authorization'] = 'Bearer ' + tok;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (r) => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// #21 真实模板结构（方案 §3.3，UNION ALL 双段）
const VALID_TEMPLATE = `SELECT a, b FROM t1 WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'
UNION ALL
SELECT a, b FROM t2 WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'`;

async function main() {
  mod.initSchema();
  await waitReady();

  // seed db_connections：source 连接（sqlserver）+ 一个非 source 连接（warehouse，用于负向测试）
  await run(`CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT, type TEXT, connection_type TEXT)`);
  await run(`INSERT INTO db_connections (id, name, type, connection_type) VALUES (1, 'business_db只读', 'sqlserver', 'source')`);
  await run(`INSERT INTO db_connections (id, name, type, connection_type) VALUES (2, '数仓主库', 'sqlserver', 'warehouse')`);
  await run(`INSERT INTO db_connections (id, name, type, connection_type) VALUES (3, 'HRD只读', 'mysql', 'source')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed db_connections（source×2 + warehouse×1）');

  try {
    // ══════════════════ [1] 建单（登记）══════════════════
    // [1a] 缺 token → 401
    let r = await call('POST', '/api/periodic-tasks', null, { task_name: 't', source_connection_id: 1, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 401, '无 token 应 401，实际 ' + r.status);
    ok('POST /periodic-tasks 无 token → 401');

    // [1b] 非 admin → 403
    r = await call('POST', '/api/periodic-tasks', userTok, { task_name: 't', source_connection_id: 1, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 403, '非 admin 应 403，实际 ' + r.status);
    ok('POST /periodic-tasks 非 admin（role=user）→ 403');

    // [1c] 缺 task_name → 400
    r = await call('POST', '/api/periodic-tasks', adminTok, { source_connection_id: 1, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 400, '缺 task_name 应 400');
    assert.strictEqual(r.body.code, 'TASK_NAME_REQUIRED');
    ok('POST /periodic-tasks 缺 task_name → 400 TASK_NAME_REQUIRED');

    // [1d] 非法 source_connection_id（非数字）→ 400
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 't-badconn', source_connection_id: 'abc', script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 400, '非法 source_connection_id 应 400');
    assert.strictEqual(r.body.code, 'INVALID_SOURCE_CONNECTION_ID');
    ok('POST /periodic-tasks source_connection_id 非数字 → 400 INVALID_SOURCE_CONNECTION_ID');

    // [1e] source_connection_id 不存在 → 400
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 't-noconn', source_connection_id: 999, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 400, '不存在的 source_connection_id 应 400');
    assert.strictEqual(r.body.code, 'SOURCE_CONNECTION_NOT_FOUND');
    ok('POST /periodic-tasks source_connection_id=999（不存在）→ 400 SOURCE_CONNECTION_NOT_FOUND');

    // [1f] source_connection_id 指向非 source 连接（warehouse）→ 400
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 't-warehouse', source_connection_id: 2, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 400, '指向 warehouse 连接应 400');
    assert.strictEqual(r.body.code, 'SOURCE_CONNECTION_NOT_FOUND');
    ok('POST /periodic-tasks source_connection_id=2（type=warehouse 非 source）→ 400 SOURCE_CONNECTION_NOT_FOUND');

    // [1g] 占位符校验失败（无占位符）→ 400
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 't-noplaceholder', source_connection_id: 1, script_template: 'SELECT 1' });
    assert.strictEqual(r.status, 400, '无占位符应 400');
    assert.strictEqual(r.body.code, 'NO_PLACEHOLDER_FOUND');
    ok('POST /periodic-tasks 模板无占位符 → 400 NO_PLACEHOLDER_FOUND（占位符校验先行）');

    // [1h] SQL 最小形态校验失败（DDL）→ 400（占位符合法但 SQL 非法）
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 't-baddml', source_connection_id: 1, script_template: `DROP TABLE t WHERE d = '{{MONTH_START}}'` });
    assert.strictEqual(r.status, 400, 'DDL 模板应 400');
    assert.strictEqual(r.body.code, 'SQL_FORM_REJECTED');
    ok('POST /periodic-tasks 模板含 DROP TABLE（占位符合法但 SQL 非法）→ 400 SQL_FORM_REJECTED');

    // [1i] 合法建单 → 201
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 'T21-月结算', description: '#21每月固定取数', source_connection_id: 1, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 201, '合法建单应 201，实际 ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.template_version, 1, '首次建单 template_version 应为 1');
    const taskId = r.body.id;
    ok('POST /periodic-tasks 合法建单（#21 真实模板）→ 201，template_version=1，id=' + taskId);

    // [1j] 同名 active 冲突 → 409
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 'T21-月结算', source_connection_id: 1, script_template: VALID_TEMPLATE });
    assert.strictEqual(r.status, 409, '同名 active 冲突应 409');
    assert.strictEqual(r.body.code, 'TASK_NAME_CONFLICT');
    ok('POST /periodic-tasks 同名 active 任务重复建单 → 409 TASK_NAME_CONFLICT');

    // ══════════════════ [2] 改（PUT）══════════════════
    // [2a] 改 status 字段被拒
    r = await call('PUT', `/api/periodic-tasks/${taskId}`, adminTok, { status: 'disabled' });
    assert.strictEqual(r.status, 400, '编辑接口改 status 应 400');
    assert.strictEqual(r.body.code, 'STATUS_CHANGE_NOT_ALLOWED_HERE');
    ok('PUT /periodic-tasks/:id 携带 status 字段 → 400 STATUS_CHANGE_NOT_ALLOWED_HERE（职责分离，须走 /disable）');

    // [2b] 目标不存在 → 404
    r = await call('PUT', '/api/periodic-tasks/999999', adminTok, { description: 'x' });
    assert.strictEqual(r.status, 404, '不存在任务编辑应 404');
    ok('PUT /periodic-tasks/999999（不存在）→ 404 PERIODIC_TASK_NOT_FOUND');

    // [2c] 仅改描述（不改模板）→ template_version 不变
    r = await call('PUT', `/api/periodic-tasks/${taskId}`, adminTok, { description: '更新说明' });
    assert.strictEqual(r.status, 200, '仅改描述应 200: ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.template_version, 1, '仅改描述 template_version 应仍为 1');
    assert.strictEqual(r.body.script_changed, false, '仅改描述 script_changed 应为 false');
    ok('PUT /periodic-tasks/:id 仅改描述（不改模板）→ template_version 保持 1，script_changed=false');

    // [2d] 改模板 → template_version+1（方案 §5.1）
    const NEW_TEMPLATE = `SELECT a FROM t1 WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'`;
    r = await call('PUT', `/api/periodic-tasks/${taskId}`, adminTok, { script_template: NEW_TEMPLATE });
    assert.strictEqual(r.status, 200, '改模板应 200: ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.template_version, 2, '改模板后 template_version 应变为 2');
    assert.strictEqual(r.body.script_changed, true, '改模板 script_changed 应为 true');
    ok('PUT /periodic-tasks/:id 改 script_template → template_version 2（自动 +1，方案 §5.1）');

    // [2e] 改模板破坏占位符（新模板缺占位符）→ 400，且不应影响已存版本
    r = await call('PUT', `/api/periodic-tasks/${taskId}`, adminTok, { script_template: 'SELECT 1' });
    assert.strictEqual(r.status, 400, '改成无占位符模板应 400');
    assert.strictEqual(r.body.code, 'NO_PLACEHOLDER_FOUND');
    r = await call('GET', `/api/periodic-tasks/${taskId}`, adminTok);
    assert.strictEqual(r.body.template_version, 2, '校验失败的编辑不应影响已保存的 template_version');
    ok('PUT /periodic-tasks/:id 改成无占位符模板 → 400 拒绝，且不影响已保存版本（校验先于写入）');

    // [2f] 建第二个任务，用于测试改名冲突
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 'T-second', source_connection_id: 3, script_template: `SELECT 1 WHERE d='{{MONTH_START}}'` });
    assert.strictEqual(r.status, 201, '第二个任务建单应 201');
    const taskId2 = r.body.id;
    r = await call('PUT', `/api/periodic-tasks/${taskId2}`, adminTok, { task_name: 'T21-月结算' });
    assert.strictEqual(r.status, 409, '改名冲突应 409');
    assert.strictEqual(r.body.code, 'TASK_NAME_CONFLICT');
    ok('PUT /periodic-tasks/:id 改名撞已存在 active 同名任务 → 409 TASK_NAME_CONFLICT');

    // ══════════════════ [3] 禁用 ══════════════════
    // [3a] 非 admin 禁用 → 403
    r = await call('POST', `/api/periodic-tasks/${taskId2}/disable`, userTok);
    assert.strictEqual(r.status, 403, '非 admin 禁用应 403');
    ok('POST /periodic-tasks/:id/disable 非 admin → 403');

    // [3b] 目标不存在 → 404
    r = await call('POST', '/api/periodic-tasks/999999/disable', adminTok);
    assert.strictEqual(r.status, 404, '禁用不存在任务应 404');
    ok('POST /periodic-tasks/999999/disable（不存在）→ 404');

    // [3c] 合法禁用 → 200
    r = await call('POST', `/api/periodic-tasks/${taskId2}/disable`, adminTok);
    assert.strictEqual(r.status, 200, '合法禁用应 200: ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, 'disabled');
    ok('POST /periodic-tasks/:id/disable 合法禁用 → 200 status=disabled');

    // [3d] 重复禁用幂等 → 200（非报错）
    r = await call('POST', `/api/periodic-tasks/${taskId2}/disable`, adminTok);
    assert.strictEqual(r.status, 200, '重复禁用应幂等 200');
    assert.ok(/幂等/.test(r.body.message || ''), '重复禁用响应应标注幂等');
    ok('POST /periodic-tasks/:id/disable 重复禁用 → 幂等 200（非 409）');

    // [3e] ⭐ disabled 不占名：禁用后同名可重新注册新 active 任务（方案 §5.1）
    r = await call('POST', '/api/periodic-tasks', adminTok, { task_name: 'T-second', source_connection_id: 3, script_template: `SELECT 1 WHERE d='{{MONTH_START}}'` });
    assert.strictEqual(r.status, 201, 'disabled 同名重建应 201: ' + JSON.stringify(r.body));
    const taskId2b = r.body.id;
    ok('⭐ disabled 任务不占名：同名「T-second」重新注册新 active 任务 → 201（方案 §5.1）');

    // ══════════════════ [4] 列表 + 详情 ══════════════════
    r = await call('GET', '/api/periodic-tasks', adminTok);
    assert.strictEqual(r.status, 200, '列表应 200');
    assert.ok(Array.isArray(r.body.items) && r.body.items.length >= 3, '列表应含至少 3 条（T21-月结算/T-second旧disabled/T-second新active）');
    ok(`GET /periodic-tasks 列表 → 200，共 ${r.body.items.length} 条`);

    r = await call('GET', '/api/periodic-tasks?status=disabled', adminTok);
    assert.strictEqual(r.status, 200, 'status=disabled 过滤应 200');
    assert.ok(r.body.items.every(t => t.status === 'disabled'), '过滤结果应全部 disabled');
    assert.ok(r.body.items.some(t => t.id === taskId2), '过滤结果应含刚禁用的 taskId2');
    ok('GET /periodic-tasks?status=disabled 过滤 → 仅返回 disabled 任务');

    r = await call('GET', '/api/periodic-tasks?status=bogus', adminTok);
    assert.strictEqual(r.status, 400, '非法 status 过滤应 400');
    assert.strictEqual(r.body.code, 'INVALID_STATUS_FILTER');
    ok('GET /periodic-tasks?status=bogus（非法值）→ 400 INVALID_STATUS_FILTER');

    r = await call('GET', `/api/periodic-tasks/${taskId2b}`, adminTok);
    assert.strictEqual(r.status, 200, '详情应 200');
    assert.strictEqual(r.body.source_connection_name, 'HRD只读', '详情应含 source 连接名快照');
    assert.strictEqual(r.body.source_connection_type, 'mysql', '详情应含 source 连接方言');
    ok('GET /periodic-tasks/:id 详情 → 200，含 source_connection_name/type（LEFT JOIN db_connections）');

    r = await call('GET', '/api/periodic-tasks/999999', adminTok);
    assert.strictEqual(r.status, 404, '不存在详情应 404');
    ok('GET /periodic-tasks/999999（不存在）→ 404');

    // ══════════════════ [5] readiness 探针（M-1：requireAdmin）══════════════════
    r = await call('GET', '/api/periodic-tasks/_readiness', adminTok);
    assert.strictEqual(r.status, 200, 'readiness admin 应 200');
    assert.strictEqual(r.body.ready, true, 'readiness 应 ready=true');
    ok('GET /periodic-tasks/_readiness admin token → 200 { ready:true }');

    // M-1（集成审）：探针加了 requireAdmin，非 admin / 无 token 应被拒（方案 §4.3 所有端点 requireAdmin）
    r = await call('GET', '/api/periodic-tasks/_readiness', userTok);
    assert.strictEqual(r.status, 403, '非 admin 调 _readiness 应 403，实际 ' + r.status);
    ok('⭐ GET /periodic-tasks/_readiness 非 admin（role=user）→ 403（M-1，方案 §4.3 所有端点 requireAdmin）');

    r = await call('GET', '/api/periodic-tasks/_readiness', null);
    assert.strictEqual(r.status, 401, '无 token 调 _readiness 应 401，实际 ' + r.status);
    ok('GET /periodic-tasks/_readiness 无 token → 401');

  } finally {
    server.close();
    db.close();
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 周期取数推送任务 CRUD 端点验证通过`);
  console.log('  覆盖：建单(占位符/SQL形态/未知连接/非source连接/同名冲突/401·403) + 改(template_version+1/职责分离/改名冲突/404) + 禁用(幂等/disabled不占名/401·403·404) + 列表过滤 + 详情(source快照) + readiness');
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); try { server && server.close(); } catch (_) {} db.close(); process.exit(1); });
