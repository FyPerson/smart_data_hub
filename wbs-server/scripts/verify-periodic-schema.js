// 验证脚本：周期取数推送模块 三表 schema（集成点1 ①）
//   方案：docs/local/周期取数推送/周期取数推送模块_方案_20260703_v1.0.md §5
//   任务书：docs/local/周期取数推送/周期取数推送_Sonnet任务书_20260705_v1.0.md
//   用法：node scripts/verify-periodic-schema.js
//
// RC-L2 根治：require routes/periodic-fetch/index.js 真实 mod.initSchema()（db helper 注入本脚本 :memory: db），
//   测的是真实建表 DDL（与断言期望清单漂移即暴露），非复刻一份 DDL。
//
// 断言覆盖：3 表存在 + 关键列齐 + 索引建上（含 task_name 部分唯一索引） + readiness 两态（干净库 ready /
//   缺列库 false）+ 建表顺序不报错 + 枚举 CHECK 生效（periodic_tasks.status /
//   periodic_task_runs.status·file_status / periodic_task_pushes.push_status）+ task_name 仅 active 唯一
//   （disabled 不占名）+ NOT NULL + 默认值（template_version=1/status=active/file_status=present）+
//   FK 定义正确性（测试期）+ _internals KEY_COLS 与真实表同源。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
// 集成点2 起 REQUIRED_DEPS 扩了 5 项（getMssqlPool/getMysqlPool/readSystemConfig/maskPhone/decryptPassword），
//   本脚本只测 schema/readiness，不会真正跑数/推送，用不到的分支给最简 mock 保证工厂能构造成功即可。
const mockDeps = {
  getMssqlPool: async () => ({ request: () => { throw new Error('mock getMssqlPool：schema verify 不应触发'); } }),
  getMysqlPool: async () => ({ query: async () => { throw new Error('mock getMysqlPool：schema verify 不应触发'); } }),
  readSystemConfig: async () => null,
  maskPhone: () => '[mock]',
  decryptPassword: (x) => x,
};
const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  ...mockDeps,
};
const mod = require('../routes/periodic-fetch')(deps);
const I = mod._internals;

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.PERIODIC_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.PERIODIC_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.PERIODIC_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时未就绪')); }
    }, 10);
  });
}

const EXPECTED_INDEXES = [
  'idx_periodic_tasks_name_active', 'idx_periodic_tasks_status',
  'idx_periodic_runs_task_started', 'idx_periodic_pushes_run_pushed',
];

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
  await run('PRAGMA foreign_keys = ON');   // 测试期开启，验 FK 定义拼对（生产未启用，仅结构声明）
  mod.initSchema();
  await waitReady();
  ok('三表 + 索引建立成功（真实 initSchema，非复刻 DDL）+ readiness ready=true');

  // [0] _internals KEY_COLS 与本脚本期望同源
  assert.ok(Array.isArray(I.PERIODIC_TASKS_KEY_COLS) && I.PERIODIC_TASKS_KEY_COLS.length > 0, '_internals 导出 PERIODIC_TASKS_KEY_COLS');
  ok(`_internals.PERIODIC_TASKS_KEY_COLS 就绪（${I.PERIODIC_TASKS_KEY_COLS.length} 列，readiness 校验锚点）`);

  // [1] 三表存在
  const tables = (await all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('periodic_tasks','periodic_task_runs','periodic_task_pushes')"
  )).map(r => r.name);
  assert.strictEqual(tables.length, 3, `应有 3 表，实际 ${tables.length}: ${tables.join(',')}`);
  ok(`三表存在：${tables.sort().join(' / ')}`);

  // [2] periodic_tasks 关键列齐全（与 _internals KEY_COLS 同源）
  const taskColRows = await all('PRAGMA table_info(periodic_tasks)');
  const taskCols = taskColRows.map(r => r.name);
  const missingKey = I.PERIODIC_TASKS_KEY_COLS.filter(c => !taskCols.includes(c));
  assert.strictEqual(missingKey.length, 0, `_internals KEY_COLS 在真实表缺失: ${missingKey.join(',')}`);
  ok('periodic_tasks._internals KEY_COLS 全部存在于真实建表（readiness 与真实 schema 同源）');

  const runColRows = await all('PRAGMA table_info(periodic_task_runs)');
  const runCols = runColRows.map(r => r.name);
  const missingRunKey = I.PERIODIC_RUNS_KEY_COLS.filter(c => !runCols.includes(c));
  assert.strictEqual(missingRunKey.length, 0, `periodic_task_runs _internals KEY_COLS 缺失: ${missingRunKey.join(',')}`);
  ok('periodic_task_runs._internals KEY_COLS 全部存在于真实建表');

  const pushColRows = await all('PRAGMA table_info(periodic_task_pushes)');
  const pushCols = pushColRows.map(r => r.name);
  const missingPushKey = I.PERIODIC_PUSHES_KEY_COLS.filter(c => !pushCols.includes(c));
  assert.strictEqual(missingPushKey.length, 0, `periodic_task_pushes _internals KEY_COLS 缺失: ${missingPushKey.join(',')}`);
  ok('periodic_task_pushes._internals KEY_COLS 全部存在于真实建表');

  // [3] periodic_tasks 核心 NOT NULL 列
  const TASK_NOTNULL = ['task_name', 'source_connection_id', 'script_template', 'template_version', 'status', 'created_by', 'created_at'];
  const nnBroken = TASK_NOTNULL.filter(c => { const d = taskColRows.find(x => x.name === c); return !d || d.notnull !== 1; });
  assert.strictEqual(nnBroken.length, 0, `periodic_tasks NOT NULL 约束缺失: ${nnBroken.join(',')}`);
  ok(`periodic_tasks 核心 NOT NULL 约束生效（${TASK_NOTNULL.length} 列）`);

  // [4] 索引齐全
  const idxRows = (await all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_periodic%'")).map(r => r.name);
  const missingIdx = EXPECTED_INDEXES.filter(i => !idxRows.includes(i));
  assert.strictEqual(missingIdx.length, 0, `索引缺失: ${missingIdx.join(',')}`);
  ok(`4 索引齐全（${EXPECTED_INDEXES.join(' / ')}）`);

  // [5] status CHECK：active/disabled 合法 + 非法拒 + 默认值
  await run(`INSERT INTO periodic_tasks (task_name, source_connection_id, script_template, created_by) VALUES ('t1', 1, "SELECT '{{MONTH_START}}'", 1)`);
  await run(`INSERT INTO periodic_tasks (task_name, source_connection_id, script_template, created_by, status) VALUES ('t2', 1, "SELECT '{{MONTH_START}}'", 1, 'disabled')`);
  await assert.rejects(
    run(`INSERT INTO periodic_tasks (task_name, source_connection_id, script_template, created_by, status) VALUES ('t3', 1, "SELECT '{{MONTH_START}}'", 1, 'archived')`),
    /CHECK|constraint/i, 'status=archived 应被 CHECK 拒'
  );
  const defaults = await get(`SELECT status, template_version FROM periodic_tasks WHERE task_name='t1'`);
  assert.strictEqual(defaults.status, 'active', 'status 默认应 active');
  assert.strictEqual(defaults.template_version, 1, 'template_version 默认应 1');
  ok('periodic_tasks.status CHECK（active/disabled）合法，非法值拒；默认 status=active/template_version=1');

  // [6] ⭐ task_name 仅 active 唯一（disabled 不占名）
  await assert.rejects(
    run(`INSERT INTO periodic_tasks (task_name, source_connection_id, script_template, created_by) VALUES ('t1', 1, "SELECT '{{MONTH_START}}'", 1)`),
    /UNIQUE|constraint/i, '同名 active 任务应被部分唯一索引拒'
  );
  // t2 是 disabled，同名 t2 建新 active 任务应允许（disabled 不占名，方案 §5.1）
  await run(`INSERT INTO periodic_tasks (task_name, source_connection_id, script_template, created_by) VALUES ('t2', 1, "SELECT '{{MONTH_START}}'", 1)`);
  ok('task_name 仅 active 唯一：同名 active 冲突被拒；disabled 同名可重建新 active（方案 §5.1 部分唯一索引语义）');

  // [7] periodic_task_runs：status CHECK + file_status CHECK + 默认值 + NOT NULL
  const taskId = (await get(`SELECT id FROM periodic_tasks WHERE task_name='t1'`)).id;
  const insertRunSql = (status) => run(
    `INSERT INTO periodic_task_runs
       (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
        triggered_by, date_range_start, date_range_end, started_at, status)
     VALUES (?, 'SELECT 1', 't1', 'conn-1', 1, 1, '2026-06-01', '2026-07-01', datetime('now'), ?)`,
    [taskId, status]
  );
  for (const st of ['queued', 'running', 'success', 'failed', 'empty_result']) {
    await insertRunSql(st);
  }
  await assert.rejects(insertRunSql('cancelled'), /CHECK|constraint/i, 'run status=cancelled 应被 CHECK 拒');
  ok('periodic_task_runs.status CHECK：queued/running/success/failed/empty_result 合法，cancelled 被拒');

  const runId = (await get(`SELECT id FROM periodic_task_runs WHERE status='success'`)).id;
  const fileStatusDefault = await get(`SELECT file_status FROM periodic_task_runs WHERE id = ?`, [runId]);
  assert.strictEqual(fileStatusDefault.file_status, 'present', 'file_status 默认应 present');
  await assert.rejects(
    run(`UPDATE periodic_task_runs SET file_status = 'expired' WHERE id = ?`, [runId]),
    /CHECK|constraint/i, 'file_status=expired 应被 CHECK 拒'
  );
  ok('periodic_task_runs.file_status 默认 present + CHECK（present/cleaned/missing）非法值拒');

  // [8] periodic_task_pushes：push_status CHECK + NOT NULL
  const insertPushSql = (status) => run(
    `INSERT INTO periodic_task_pushes (run_id, phone_snapshot, push_status, pushed_by, pushed_at)
     VALUES (?, '13800000000', ?, 1, datetime('now'))`,
    [runId, status]
  );
  for (const st of ['pending', 'success', 'failed', 'skipped']) {
    await insertPushSql(st);
  }
  await assert.rejects(insertPushSql('unknown'), /CHECK|constraint/i, 'push_status=unknown 应被 CHECK 拒');
  ok('periodic_task_pushes.push_status CHECK：pending/success/failed/skipped 合法，unknown 被拒');

  // [9] FK 定义正确性（测试期 FK ON）：runs/pushes 引用不存在的父行被拒
  await assert.rejects(
    run(`INSERT INTO periodic_task_runs
           (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
            triggered_by, date_range_start, date_range_end, started_at, status)
         VALUES (999999, 'SELECT 1', 'x', 'conn-1', 1, 1, '2026-06-01', '2026-07-01', datetime('now'), 'queued')`),
    /FOREIGN KEY|constraint/i, 'periodic_task_runs FK 未拦截孤儿引用'
  );
  await assert.rejects(
    run(`INSERT INTO periodic_task_pushes (run_id, phone_snapshot, push_status, pushed_by, pushed_at)
         VALUES (999999, '13800000000', 'pending', 1, datetime('now'))`),
    /FOREIGN KEY|constraint/i, 'periodic_task_pushes FK 未拦截孤儿引用'
  );
  ok('FK 定义正确（测试期）：runs/pushes 引用不存在的父行被 FK 拒（生产未启用 FK，仅结构声明）');

  // [10] readiness 缺列库 → ready=false
  await verifyMissingColLib();

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 周期取数推送三表 schema 验证通过【require 真实 initSchema，非复刻 DDL】`);
  console.log('  覆盖：3 表 + 关键列 + 4 索引 + status/file_status/push_status CHECK + task_name 仅 active 唯一 + NOT NULL + FK 定义 + readiness 两态');
  db.close();
}

// [10] readiness 缺列库：独立内存库手工建缺关键列的 periodic_tasks，调 runPeriodicMigration 应判 ready=false
async function verifyMissingColLib() {
  const db2 = new sqlite3.Database(':memory:');
  const run2 = (sql) => new Promise((res, rej) => db2.run(sql, [], function (e) { e ? rej(e) : res(this); }));
  const all2 = (sql) => new Promise((res, rej) => db2.all(sql, [], (e, rows) => e ? rej(e) : res(rows)));
  const get2 = (sql) => new Promise((res, rej) => db2.get(sql, [], (e, row) => e ? rej(e) : res(row)));
  const mod2 = require('../routes/periodic-fetch')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db: db2, dbRunAsync: run2, dbGetAsync: get2, dbAllAsync: all2,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...mockDeps,
  });
  // 手工建残缺三表（periodic_tasks 故意缺 template_version + created_at）
  await run2(`CREATE TABLE periodic_tasks (id INTEGER PRIMARY KEY, task_name TEXT, source_connection_id INTEGER, script_template TEXT, status TEXT, created_by INTEGER)`);
  await run2(`CREATE TABLE periodic_task_runs (id INTEGER PRIMARY KEY, task_id INTEGER, rendered_script TEXT, task_name_snapshot TEXT, source_connection_snapshot TEXT, template_version_snapshot INTEGER, triggered_by INTEGER, date_range_start TEXT, date_range_end TEXT, started_at TEXT, status TEXT, file_status TEXT)`);
  await run2(`CREATE TABLE periodic_task_pushes (id INTEGER PRIMARY KEY, run_id INTEGER, phone_snapshot TEXT, push_status TEXT, pushed_by INTEGER, pushed_at TEXT)`);
  await mod2._internals.runPeriodicMigration(null);
  const st = mod2._internals.PERIODIC_SCHEMA_STATE;
  assert.strictEqual(st.ready, false, '缺列库 readiness 应为 false');
  assert.ok(/template_version|created_at/.test(st.error || ''), `缺列错误信息应含缺失锚点，实际：${st.error}`);
  ok(`readiness 缺列库：periodic_tasks 缺 template_version/created_at → ready=false（错误：${st.error}）`);
  db2.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
