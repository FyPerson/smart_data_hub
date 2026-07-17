// scripts/verify-sys-multidev-schema.js — S34 验收：C0 schema runner 连续两次（重启模拟）零副作用
//   SSOT = 开发计划 v2.9 §3.1「两步执行」步骤1（可重复 schema runner）+ 验收表 S34
//   用法：node scripts/verify-sys-multidev-schema.js
//
// 覆盖：
//   [1] 临时文件库上跑两遍 initSchema+runSysMigration（每遍新连接+新模块工厂实例=真实重启模拟，86 号审 M3
//       收口——此前同连接重跑会读到第一遍残留 ready=true 提前返回，二跑验证形同虚设）：表集合/列集合/
//       索引集合前后逐字不变 + 两遍均从 ready=false 真实等到 ready=true 无 error
//   [1b] C0 全部索引显式清单存在（86 号审 M2②收口——原 LIKE 'idx_sys%' 漏采 idx_dev_% 系列新索引）
//   [2] 4 新列存在（sys_issue_dev_assignees.dev_status/resolved_at/no_code_reason/superseded_by）
//   [3] 3 新表存在（sys_issue_dev_commits/sys_issue_dev_events/sys_issue_release_commit_snapshots）
//   [4] CHECK 生效：sys_issue_dev_commits.component 非法值应被拒
//   [5] UNIQUE(release_id,issue_id) 生效：sys_issue_release_commit_snapshots 重复插入应被拒
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function makeHelpers(db) {
  return {
    run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })),
    all: (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))),
    get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row))),
  };
}

function waitReady(I) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

// M2②（86 号审）：C0 全部新增/复用索引显式清单——快照采集不再靠 LIKE 模式猜测前缀（旧 `idx_sys%` 漏采
//   `idx_dev_%` 系列——C0 新表索引命名未跟 idx_sys 前缀），改为显式断言这份清单全部存在。
const EXPECTED_C0_INDEXES = [
  'idx_sys_dev_assignee_active',          // 复用等价 uq_dev_assignee_roster（附录C，主会话核实的偏差裁定）
  'idx_dev_assignee_issue_removed',       // M2①新补（附录C）
  'idx_dev_commits_assignee',
  'idx_dev_commits_issue',
  'idx_dev_commits_user',
];

// 抓取当前库的结构快照：表名集合 + 每表列集合(name/type/notnull/dflt/pk) + 索引名集合。
//   M2②：索引采集 WHERE 显式加括号（type='index' AND (name LIKE 'idx_%' OR name LIKE 'uq_%')），覆盖
//   idx_sys_%/idx_dev_%/uq_% 全部命名前缀，不再遗漏。
async function snapshotSchema(H) {
  const tables = (await H.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sys_%' ORDER BY name`)).map(r => r.name);
  const columnsByTable = {};
  for (const t of tables) {
    const cols = await H.all(`PRAGMA table_info(${t})`);
    columnsByTable[t] = cols.map(c => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`).sort();
  }
  const indexes = (await H.all(`SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_%' OR name LIKE 'uq_%') ORDER BY name`))
    .map(r => r.name).sort();
  return { tables, columnsByTable, indexes };
}

// M3（86 号审）：临时文件库 + 两次独立"重启"——每遍新开 sqlite3.Database 连接 + 新 require 模块工厂调用
//   （routes/sys-iteration 是工厂函数 `module.exports = (deps) => {...}`，SYS_SCHEMA_STATE 声明在工厂体内，
//   每次调用工厂都会产生全新的 { ready:false, error:null } 状态对象——不需要 delete require.cache，直接
//   再调用一次工厂即可拿到真正从 ready=false 开始的新实例）；第一遍跑完显式关闭连接再开第二遍，避免同文件
//   多连接并存竞态，真实还原"进程重启"语义（此前同连接重跑 initSchema 时，第二次 waitReady 一进来就读到
//   第一遍残留的 ready=true 立即返回，根本没有真正等待第二遍完成就抓了快照，二跑验证形同虚设）。
function tmpSchemaDbPath() {
  return path.join(os.tmpdir(), `verify-sys-multidev-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function bootFreshInstance(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: H.run, dbGetAsync: H.get, dbAllAsync: H.all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  return { db, H, mod };
}

async function main() {
  const schemaDbPath = tmpSchemaDbPath();

  // ── [1] 第一遍："首次启动"：新文件 + 新连接 + 新模块实例 ──────────
  let inst = await bootFreshInstance(schemaDbPath);
  assert.strictEqual(inst.mod._internals.SYS_SCHEMA_STATE.ready, false, '第一遍启动前 ready 应为初始值 false（新工厂实例）');
  inst.mod.initSchema();
  await waitReady(inst.mod._internals);
  assert.strictEqual(inst.mod._internals.SYS_SCHEMA_STATE.error, null, '第一遍 initSchema 后 error 应为 null');
  const snap1 = await snapshotSchema(inst.H);
  await new Promise((resolve) => inst.db.close(() => resolve()));
  ok(`第一遍（首次启动）initSchema+runSysMigration 完成：${snap1.tables.length} 张 sys_% 表就绪，ready=true error=null`);

  // ── [1] 第二遍：真实"重启模拟"——同一份文件、全新连接、全新模块工厂实例（ready 从 false 重新等起）──────────
  inst = await bootFreshInstance(schemaDbPath);
  assert.strictEqual(inst.mod._internals.SYS_SCHEMA_STATE.ready, false, '第二遍启动前 ready 应重新为 false（新工厂实例，非复用第一遍残留状态）');
  inst.mod.initSchema();
  await waitReady(inst.mod._internals);
  assert.strictEqual(inst.mod._internals.SYS_SCHEMA_STATE.error, null, '第二遍 initSchema 后 error 应为 null');
  const snap2 = await snapshotSchema(inst.H);
  const { db, H } = inst;   // 后续 [2]-[5] 复用第二遍连接继续断言（该连接已持有完整已建 schema 状态）
  assert.deepStrictEqual(snap2.tables, snap1.tables, '二跑（重启后）表集合应逐字不变');
  assert.deepStrictEqual(snap2.indexes, snap1.indexes, '二跑（重启后）索引集合应逐字不变');
  for (const t of snap1.tables) {
    assert.deepStrictEqual(snap2.columnsByTable[t], snap1.columnsByTable[t], `二跑（重启后）${t} 列集合应逐字不变`);
  }
  ok(`S34：schema runner 连续两次（真实重启模拟：新文件连接+新模块工厂实例，从 ready=false 真实等待）零副作用——表集合(${snap2.tables.length})/索引集合(${snap2.indexes.length})/每表列集合逐字不变，两遍均 ready=true error=null`);

  // ── [1b] M2②：C0 全部索引显式存在断言（防 LIKE 模式漏采）──────────
  for (const idx of EXPECTED_C0_INDEXES) {
    assert.ok(snap2.indexes.includes(idx), `C0 索引 ${idx} 应存在（显式清单断言，防 LIKE 前缀漏采）`);
  }
  ok(`C0 全部索引显式存在：${EXPECTED_C0_INDEXES.join(' / ')}`);

  // ── [2] 4 新列存在（sys_issue_dev_assignees）──────────
  const daCols = (await H.all(`PRAGMA table_info(sys_issue_dev_assignees)`)).map(c => c.name);
  for (const c of ['dev_status', 'resolved_at', 'no_code_reason', 'superseded_by']) {
    assert.ok(daCols.includes(c), `sys_issue_dev_assignees 应含 C0 新列 ${c}`);
  }
  const devStatusCol = (await H.all(`PRAGMA table_info(sys_issue_dev_assignees)`)).find(c => c.name === 'dev_status');
  assert.strictEqual(devStatusCol.notnull, 1, 'dev_status 应 NOT NULL');
  assert.strictEqual(devStatusCol.dflt_value, "'pending'", "dev_status 默认值应为 'pending'");
  ok('4 新列存在（dev_status NOT NULL DEFAULT pending / resolved_at / no_code_reason / superseded_by）');

  // ── [3] 3 新表存在 ──────────
  const allTables = (await H.all(`SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);
  for (const t of ['sys_issue_dev_commits', 'sys_issue_dev_events', 'sys_issue_release_commit_snapshots']) {
    assert.ok(allTables.includes(t), `应存在新表 ${t}`);
  }
  ok('3 新表存在：sys_issue_dev_commits / sys_issue_dev_events / sys_issue_release_commit_snapshots');

  // ── [4] CHECK 生效：component 非法值应被拒 ──────────
  const issueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', 'S34单', 'BMS', 1, 'admin')`
  )).lastID;
  const daId = (await H.run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name) VALUES (?, 1, '开发甲')`, [issueId]
  )).lastID;
  await assert.rejects(
    H.run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 1, 'ios', 'r1', datetime('now'))`, [issueId, daId]),
    /CHECK|constraint/i, 'component=ios 应被 CHECK(frontend/backend) 拒'
  );
  await assert.rejects(
    H.run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 1, 'frontend', '', datetime('now'))`, [issueId, daId]),
    /CHECK|constraint/i, 'commit_ref 空串应被 CHECK(长度1..200) 拒'
  );
  await assert.doesNotReject(
    H.run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 1, 'frontend', 'feat/ok', datetime('now'))`, [issueId, daId]),
    '合法 component+commit_ref 应成功插入'
  );
  ok('CHECK 生效：sys_issue_dev_commits.component 非法值拒 + commit_ref 空串拒 + 合法值放行');

  // ── [4b] events action CHECK 生效 ──────────
  await assert.rejects(
    H.run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, created_at) VALUES (?, ?, 'bogus_action', 1, datetime('now'))`, [issueId, daId]),
    /CHECK|constraint/i, 'action 非法值应被 CHECK 拒'
  );
  await assert.doesNotReject(
    H.run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, created_at) VALUES (?, ?, 'add', 1, datetime('now'))`, [issueId, daId]),
    '合法 action 应成功插入'
  );
  ok('CHECK 生效：sys_issue_dev_events.action 非法值拒 + 合法值放行');

  // ── [5] UNIQUE(release_id,issue_id) 生效 ──────────
  const releaseId = (await H.run(
    `INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('S34-R1', 1, 'admin')`
  )).lastID;
  await H.run(
    `INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at) VALUES (?, ?, '[]', datetime('now'))`,
    [releaseId, issueId]
  );
  await assert.rejects(
    H.run(`INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at) VALUES (?, ?, '[]', datetime('now'))`, [releaseId, issueId]),
    /UNIQUE|constraint/i, '同 (release_id,issue_id) 二次插入应被 UNIQUE 拒'
  );
  ok('UNIQUE(release_id,issue_id) 生效：sys_issue_release_commit_snapshots 重复插入被拒');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ S34 验收：C0 schema runner 连续两次零副作用（真实重启模拟）+ 索引显式清单 + 4 新列 + 3 新表 + CHECK/UNIQUE 生效`);
  await new Promise((resolve) => db.close(() => resolve()));
  try { fs.unlinkSync(schemaDbPath); } catch (_) { /* best-effort */ }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
