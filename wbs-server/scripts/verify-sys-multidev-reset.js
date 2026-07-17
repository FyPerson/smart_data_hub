// scripts/verify-sys-multidev-reset.js — S35 验收：C0 一次性重置脚本二次执行被标记阻止 + 探针失败整体回滚
//   SSOT = 方案 v2.9 §9.2（Mz-4 固定序）+ 开发计划 v2.9 §3.1 步骤2 + 验收表 S35
//   用法：node scripts/verify-sys-multidev-reset.js
//
// 覆盖：
//   [1] 第一遍 runReset 成功：探针全过 + 标记落库 + dev_assignees 清单内行全部归 pending（resolved_at/
//       no_code_reason/superseded_by 清空）+ 代表选举生效
//       ⭐ M1（86 号审）反例：软删历史行残留 is_primary=1 → 重置后应归 0
//       ⭐ M4（86 号审）反例：两次执行（含被标记阻止的第二遍）backup path 不同，无覆盖风险
//   [2] 第二遍 runReset 被标记阻止：ok=false reason=ALREADY_APPLIED，库内数据不再被二次改写
//   [3] --expect-issues 不符 → 中止，不做任何写操作（marker 未插入、dev_assignees 未被改写）
//   [H1]（86 号审）--issue-ids 含库内不存在 id（即便 --expect-issues 总数凑巧吻合）→ 中止
//       （ISSUE_IDS_MISMATCH），未做任何写操作、标记未落库
//   [4] 探针失败场景（预置脏数据，reset 步骤本身不修复的不变量违规）→ 整体 ROLLBACK：marker 未落库 +
//       dev_assignees 的 dev_status 变化被回滚（验证"回滚"而非"部分提交"）
//   [HIGH]（95 号复审 2026-07-17 引入·96 号复审扩展到 VERIFY 族）完成态族状态感知回填 + 零在册 pre-check：
//     · 混合族批次（DEV 族对照单 + 待上线单 + 已上线单 + 待验证单）reset 后：DEV 族仍走 pending；RELEASE 族
//       两单（含一条软删历史行）+ VERIFY 族一单统一回填 no_code（resolved_at 非空 + 各自专属迁移 no_code_reason，
//       RELEASE/VERIFY 文案不同）；独立复核 P1-P15 全绿
//     · RELEASE/VERIFY 族单 assigned_to=NULL 零在册 → pre-check 在覆盖动作前 fail-fast
//       （reason=COMPLETION_FAMILY_ZERO_ROSTER，96 号复审改名——RELEASE 族专用旧码已随范围扩展并入通用码），
//       给出明确 issue id + 所属族名指引，同批次其余单零副作用（整体回滚）
//   ⚠️ 本脚本操作临时文件 db（os.tmpdir() 下），**绝不触碰 wbs-server/task_pool.db**（backup 用 fs.copyFileSync
//   需要真实文件路径，:memory: 无法验证备份逻辑，故用临时文件——用后即删）。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { runReset, RESET_MARKER_KEY, RELEASE_MIGRATION_NO_CODE_REASON, VERIFY_MIGRATION_NO_CODE_REASON } = require('./sys-multidev-c0-reset');
const { runProbes } = require('./lib/sys-multidev-probes');

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

// 在指定文件路径新建一份完整 C0 schema 的临时库（真实 initSchema，非复刻 DDL），完成后关闭连接
//   （runReset 会自己开独立连接，Windows 下同文件多连接并存易有锁冲突，先关闭建库连接更稳）。
async function buildSchemaFile(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: H.run, dbGetAsync: H.get, dbAllAsync: H.all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  mod.initSchema();
  await waitReady(mod._internals);
  // validation_config 是 server.js 启动时创建的全局表（非 sys-iteration 模块自建，server.js:1102）——
  // 生产 task_pool.db 早已存在该表；本测试库模拟"server.js 已跑过至少一次"的真实前提，先行建好，
  // 使 readState() 在 runReset() 调用前查询该表不会因表不存在而报错（sys-multidev-c0-reset.js 内部
  // 也有同构防御性建表，双重保险，互不冲突——CREATE TABLE IF NOT EXISTS 幂等）。
  await H.run(`CREATE TABLE IF NOT EXISTS validation_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT UNIQUE NOT NULL,
      config_value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);
  await new Promise((resolve) => db.close(() => resolve()));
}

function tmpDbPath(label) {
  return path.join(os.tmpdir(), `sys-multidev-reset-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupFiles(dbPath) {
  // 清理主库 + 本脚本产生的 backup_* 副本（同目录 <base>.backup_*<ext> 命名，见 sys-multidev-c0-reset.js backupDbFile）。
  const dir = path.dirname(dbPath);
  const ext = path.extname(dbPath);
  const base = path.basename(dbPath, ext);
  try { fs.unlinkSync(dbPath); } catch (_) { /* best-effort */ }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${base}.backup_`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* best-effort */ }
      }
    }
  } catch (_) { /* best-effort */ }
}

// 造一个「待重置」issue：feature/开发中，2 名开发在册（1 名已 code_submitted 待被重置回 pending，1 名 excused）。
async function seedDirtyIssue(dbPath, { withBadCommit = false } = {}) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  const issueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', 'S35单', 'BMS', 1, 'admin')`
  )).lastID;
  // ⚠️ 不给 daSubmitted 挂"合法"commit 行：reset 无条件把清单内全部 dev_assignees 行置 pending
  //   （方案 §9.2 字面「置 pending」不区分原 dev_status），而 P2「pending ⇒ commit 行=0」——若此处预置
  //   commit 行，reset 后必然触发 P2 违规（这不是 bug，是探针如实反映"清单内还有未清理的 commit 残留"）。
  //   sys_issue_dev_commits 是本 C0 commit 才新建的表，生产在此之前不可能有历史行，故"code_submitted+
  //   已有 commit"这一组合在真实生产前置里不成立，此处 happy-path 场景不模拟该组合（该组合的探针拦截
  //   行为由 scenarioProbeFailureRollback 用另一种违规类型 P7 覆盖，效果等价：证明"reset 不会盲目让探针
  //   通过，遇真实不变量冲突会如实回滚"）。
  const daSubmitted = (await H.run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status, resolved_at) VALUES (?, 1, '开发甲', 'code_submitted', '2026-01-01 00:00:00')`,
    [issueId]
  )).lastID;
  const daExcused = (await H.run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status, resolved_at) VALUES (?, 2, '开发乙', 'excused', '2026-01-01 00:00:00')`,
    [issueId]
  )).lastID;
  // M1（86 号审）反例数据：软删历史行残留 is_primary=1（模拟"修复前"的脏数据——旧选举实现两条 UPDATE
  //   都带 `AND removed_at IS NULL`，永远碰不到已软删的行，导致这类残留双 primary 数据）。
  const daRemovedPrimary = (await H.run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status, removed_at, is_primary) VALUES (?, 3, '开发丙(已移除)', 'pending', '2026-01-01 00:00:00', 1)`,
    [issueId]
  )).lastID;
  await H.run(`UPDATE sys_issues SET assigned_to = 1, assigned_to_name = '开发甲' WHERE id = ?`, [issueId]);

  if (withBadCommit) {
    // 探针失败场景专用：插入一条与自身 dev_assignee 行三元组不一致的 commit（P7 违规），且该违规**不在**
    //   reset 脚本会修改的字段范围内（reset 只碰 dev_assignees 的 dev_status/resolved_at/no_code_reason/
    //   superseded_by + assigned_to 选举，不碰 dev_commits），故 reset 执行后该违规依旧存在 → 探针必失败。
    await H.run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 999, 'frontend', 'feat/badtriple', datetime('now'))`,
      [issueId, daSubmitted]
    );
  }

  await new Promise((resolve) => db.close(() => resolve()));
  return { issueId, daSubmitted, daExcused, daRemovedPrimary };
}

async function readState(dbPath, issueId) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  const rows = await H.all(`SELECT id, user_id, dev_status, resolved_at, no_code_reason, superseded_by, is_primary FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id`, [issueId]);
  const issue = await H.get(`SELECT assigned_to, assigned_to_name FROM sys_issues WHERE id = ?`, [issueId]);
  const marker = await H.get(`SELECT config_key FROM validation_config WHERE config_key = ?`, [RESET_MARKER_KEY]);
  await new Promise((resolve) => db.close(() => resolve()));
  return { rows, issue, markerExists: !!marker };
}

async function scenarioHappyPathAndBlock() {
  const dbPath = tmpDbPath('happy');
  await buildSchemaFile(dbPath);
  const { issueId, daRemovedPrimary } = await seedDirtyIssue(dbPath);

  // ── [1] 第一遍成功 ──────────
  const r1 = await runReset({ dbPath, issueIds: [issueId], expectIssues: 1 });
  assert.strictEqual(r1.ok, true, `第一遍 runReset 应成功，实际：${JSON.stringify(r1)}`);
  assert.ok(fs.existsSync(r1.backupPath), '备份文件应已生成');
  ok(`[1] 第一遍 runReset 成功：探针全过 + 备份文件生成（${path.basename(r1.backupPath)}）`);

  const state1 = await readState(dbPath, issueId);
  assert.ok(state1.markerExists, '第一遍成功后 validation_config 标记应已落库');
  for (const row of state1.rows) {
    assert.strictEqual(row.dev_status, 'pending', `重置后 da#${row.id} dev_status 应为 pending`);
    assert.strictEqual(row.resolved_at, null, `重置后 da#${row.id} resolved_at 应清空`);
    assert.strictEqual(row.no_code_reason, null, `重置后 da#${row.id} no_code_reason 应清空`);
    assert.strictEqual(row.superseded_by, null, `重置后 da#${row.id} superseded_by 应清空`);
  }
  const primaryCount = state1.rows.filter(r => r.is_primary === 1).length;
  assert.strictEqual(primaryCount, 1, '代表选举后应恰好 1 条 is_primary=1');
  assert.ok(state1.issue.assigned_to !== null, '代表选举后 assigned_to 应非空');
  ok(`[1] 重置生效：清单内 dev_assignees 全部归 pending + resolved_at/no_code_reason/superseded_by 清空 + 代表选举产生唯一 is_primary（assigned_to=${state1.issue.assigned_to}）`);

  // ── M1（86 号审）反例：软删历史行残留 is_primary=1 → 重置后应归 0 ──────────
  const removedRow = state1.rows.find(r => r.id === daRemovedPrimary);
  assert.ok(removedRow, '软删历史行应仍存在（reset 不删行，只清字段）');
  assert.strictEqual(removedRow.is_primary, 0, 'M1：软删历史行 is_primary 应被选举清零（此前旧实现两条 UPDATE 都带 removed_at IS NULL 过滤，永远碰不到软删行，残留双 primary）');
  ok('[1] M1 反例：软删历史行（人为预置 is_primary=1 残留）重置后已归 0，代表选举不再遗漏软删行');

  // ── [2] 第二遍被标记阻止 ──────────
  const r2 = await runReset({ dbPath, issueIds: [issueId], expectIssues: 1 });
  assert.strictEqual(r2.ok, false, '第二遍 runReset 应失败（已执行过）');
  assert.strictEqual(r2.reason, 'ALREADY_APPLIED', `第二遍失败原因应为 ALREADY_APPLIED，实际：${r2.reason}`);
  const state2 = await readState(dbPath, issueId);
  assert.deepStrictEqual(state2.rows, state1.rows, '第二遍被阻止后库内 dev_assignees 数据不应再变化');
  ok('[2] 第二遍执行被 validation_config 标记正确阻止：ok=false reason=ALREADY_APPLIED，库内数据未再变化');

  // ── M4（86 号审）反例：两次执行（含被标记阻止的第二遍，备份步骤在标记检查之前无条件先跑）backup path 不同 ──────────
  assert.notStrictEqual(r1.backupPath, r2.backupPath, 'M4：两次执行产生的备份文件路径应不同（毫秒级时间戳 + COPYFILE_EXCL 防覆盖）');
  assert.ok(fs.existsSync(r2.backupPath), '第二遍的备份文件也应已生成（备份先于标记检查，Mz-4 固定序）');
  ok(`[2] M4 反例：两次执行 backup path 不同（${path.basename(r1.backupPath)} ≠ ${path.basename(r2.backupPath)}），无覆盖风险`);

  cleanupFiles(dbPath);
}

async function scenarioExpectMismatch() {
  const dbPath = tmpDbPath('mismatch');
  await buildSchemaFile(dbPath);
  const { issueId } = await seedDirtyIssue(dbPath);
  const before = await readState(dbPath, issueId);

  const r = await runReset({ dbPath, issueIds: [issueId], expectIssues: 999 });   // 故意错误的预期总行数
  assert.strictEqual(r.ok, false, '--expect-issues 不符应失败');
  assert.strictEqual(r.reason, 'EXPECT_ISSUES_MISMATCH', `失败原因应为 EXPECT_ISSUES_MISMATCH，实际：${r.reason}`);
  const after = await readState(dbPath, issueId);
  assert.deepStrictEqual(after.rows, before.rows, 'expect-issues 不符时不应做任何写操作，dev_assignees 应逐字不变');
  assert.strictEqual(after.markerExists, false, 'expect-issues 不符时标记不应落库');
  ok('[3] --expect-issues 与库内总行数不符 → 中止（EXPECT_ISSUES_MISMATCH），未做任何写操作、标记未落库');

  cleanupFiles(dbPath);
}

// H1（86 号审）反例：--issue-ids 含库内不存在的 id，但 --expect-issues 恰好与库内总行数吻合（codex 给出的
//   具体反例：--issue-ids=999 --expect-issues=1，库内确实只有 1 条但 id 不是 999）——修复前只查总数会放行，
//   打一次"空重置"却仍写下永久标记；修复后须整体中止且标记未落库。
async function scenarioIssueIdsMismatch() {
  const dbPath = tmpDbPath('idsmismatch');
  await buildSchemaFile(dbPath);
  const { issueId } = await seedDirtyIssue(dbPath);   // 库内实际只有这一条 issue（真实 id，非 999）
  const before = await readState(dbPath, issueId);

  const r = await runReset({ dbPath, issueIds: [999], expectIssues: 1 });   // 总数吻合(1)，但清单 id 不存在
  assert.strictEqual(r.ok, false, '--issue-ids 含不存在 id 应失败（即便 --expect-issues 总数吻合）');
  assert.strictEqual(r.reason, 'ISSUE_IDS_MISMATCH', `失败原因应为 ISSUE_IDS_MISMATCH，实际：${r.reason}`);
  const after = await readState(dbPath, issueId);
  assert.deepStrictEqual(after.rows, before.rows, '--issue-ids 不匹配时不应做任何写操作，真实 issue 的 dev_assignees 应逐字不变');
  assert.strictEqual(after.markerExists, false, '--issue-ids 不匹配时标记不应落库');
  ok(`[H1] --issue-ids=[999]（不存在，但 --expect-issues=1 与库内总数凑巧吻合）→ 中止（ISSUE_IDS_MISMATCH），未做任何写操作、标记未落库（防"打空重置却写永久标记"）`);

  cleanupFiles(dbPath);
}

async function scenarioProbeFailureRollback() {
  const dbPath = tmpDbPath('probefail');
  await buildSchemaFile(dbPath);
  const { issueId } = await seedDirtyIssue(dbPath, { withBadCommit: true });
  const before = await readState(dbPath, issueId);
  assert.notStrictEqual(before.rows.find(r => r.user_id === 1).dev_status, 'pending', '前置：脏数据 dev_status 本不是 pending（供回滚后比对用）');

  const r = await runReset({ dbPath, issueIds: [issueId], expectIssues: 1 });
  assert.strictEqual(r.ok, false, '探针失败场景 runReset 应失败');
  assert.strictEqual(r.reason, 'PROBE_FAILED', `失败原因应为 PROBE_FAILED，实际：${r.reason}`);
  assert.ok(Array.isArray(r.failedProbes) && r.failedProbes.length > 0, '应返回至少 1 条失败探针');
  assert.ok(r.failedProbes.some(p => p.id === 'P7'), `失败探针应含 P7（commit 三元组不一致），实际：${r.failedProbes.map(p => p.id).join(',')}`);

  const after = await readState(dbPath, issueId);
  assert.strictEqual(after.markerExists, false, '探针失败回滚后标记不应落库');
  assert.deepStrictEqual(after.rows, before.rows, '探针失败回滚后 dev_assignees 应逐字恢复到重置前（整体 ROLLBACK，非部分提交）');
  ok(`[4] 探针失败（预置 P7 违规）→ 整体 ROLLBACK：标记未落库 + dev_assignees 数据完整回滚到重置前状态（失败探针=${r.failedProbes.map(p => p.id).join(',')}）`);

  cleanupFiles(dbPath);
}

// HIGH（95 号复审 2026-07-17 引入·96 号复审扩展 VERIFY 族）：混合族批次种子——DEV 族对照单（应仍走原
//   pending 回填）+ RELEASE 族两单（待上线 feature 1 名在册+1 名软删历史行 / 已上线 bug 1 名在册）+ VERIFY
//   族一单（待验证 feature 1 名在册），后三者均应回填 no_code（RELEASE/VERIFY 各自专属文案）。种子 dev_status
//   用任意值（'pending'）模拟迁移前遗留的任意脏值——reset 后会被统一覆盖，种子本身不必满足探针恒真（探针只
//   检查 reset **执行后**的最终态，同 seedDirtyIssue 既有范式）。刻意不给任何行挂 commit：sys_issue_dev_commits
//   是本次 C0 才新建的空表，生产在此之前不可能存在历史 commit 行（同文件头注释），no_code 配对要求 commit=0
//   天然满足。
async function seedReleaseFamilyScenario(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);

  const devIssueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '开发中', 'DEV族对照单', 'BMS', 1, 'admin', 1, '开发甲')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 1, '开发甲', 'pending')`, [devIssueId]);

  const releasePendingId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '待上线', 'RELEASE族待上线单', 'BMS', 1, 'admin', 2, '开发乙')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 2, '开发乙', 'pending')`, [releasePendingId]);
  await H.run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status, removed_at) VALUES (?, 12, '开发庚(已移除)', 'pending', '2026-01-01 00:00:00')`,
    [releasePendingId]
  );   // 软删历史行——P1-P5 配对不变量不区分 removed_at，同样应被回填

  const releasePublishedId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('bug', '已上线', 'RELEASE族已上线单', 'BMS', 1, 'admin', 3, '开发丙')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 3, '开发丙', 'pending')`, [releasePublishedId]);

  // HIGH（96 号复审新增）：VERIFY 族一单——与 RELEASE 族同构的死循环点，同批次一并验证分族回填正确覆盖。
  const verifyPendingId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '待验证', 'VERIFY族待验证单', 'BMS', 1, 'admin', 4, '开发丁')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 4, '开发丁', 'pending')`, [verifyPendingId]);

  await new Promise((resolve) => db.close(() => resolve()));
  return { devIssueId, releasePendingId, releasePublishedId, verifyPendingId };
}

async function scenarioReleaseFamilyBackfill() {
  const dbPath = tmpDbPath('releasebackfill');
  await buildSchemaFile(dbPath);
  const { devIssueId, releasePendingId, releasePublishedId, verifyPendingId } = await seedReleaseFamilyScenario(dbPath);

  const r = await runReset({ dbPath, issueIds: [devIssueId, releasePendingId, releasePublishedId, verifyPendingId], expectIssues: 4 });
  assert.strictEqual(r.ok, true, `HIGH：混合族 reset 应成功，实际：${JSON.stringify(r)}`);

  const devState = await readState(dbPath, devIssueId);
  for (const row of devState.rows) {
    assert.strictEqual(row.dev_status, 'pending', `HIGH：DEV 族对照单 da#${row.id} 应仍走原 pending 回填（分族生效对照）`);
    assert.strictEqual(row.resolved_at, null, 'HIGH：DEV 族 resolved_at 应为 NULL');
    assert.strictEqual(row.no_code_reason, null, 'HIGH：DEV 族 no_code_reason 应为 NULL');
  }

  const releasePendingState = await readState(dbPath, releasePendingId);
  assert.strictEqual(releasePendingState.rows.length, 2, 'HIGH：待上线单应保留 2 条 dev_assignees 行（在册+软删各 1，reset 不删行）');
  for (const row of releasePendingState.rows) {
    assert.strictEqual(row.dev_status, 'no_code', `HIGH：待上线单 da#${row.id} 应回填为 no_code（RELEASE 族，非 pending）`);
    assert.ok(row.resolved_at, `HIGH：待上线单 da#${row.id} resolved_at 应非空`);
    assert.strictEqual(row.no_code_reason, RELEASE_MIGRATION_NO_CODE_REASON, `HIGH：待上线单 da#${row.id} no_code_reason 应为 RELEASE 迁移专用文案`);
  }

  const releasePublishedState = await readState(dbPath, releasePublishedId);
  for (const row of releasePublishedState.rows) {
    assert.strictEqual(row.dev_status, 'no_code', `HIGH：已上线单 da#${row.id} 应回填为 no_code`);
    assert.ok(row.resolved_at, `HIGH：已上线单 da#${row.id} resolved_at 应非空`);
    assert.strictEqual(row.no_code_reason, RELEASE_MIGRATION_NO_CODE_REASON, 'HIGH：已上线单 no_code_reason 应为 RELEASE 迁移专用文案');
  }

  // HIGH（96 号复审新增）：VERIFY 族单同样应回填 no_code，且使用 VERIFY 专属文案（与 RELEASE 文案不同）。
  const verifyPendingState = await readState(dbPath, verifyPendingId);
  for (const row of verifyPendingState.rows) {
    assert.strictEqual(row.dev_status, 'no_code', `HIGH（96号）：待验证单 da#${row.id} 应回填为 no_code（VERIFY 族，非 pending）`);
    assert.ok(row.resolved_at, `HIGH（96号）：待验证单 da#${row.id} resolved_at 应非空`);
    assert.strictEqual(row.no_code_reason, VERIFY_MIGRATION_NO_CODE_REASON, `HIGH（96号）：待验证单 da#${row.id} no_code_reason 应为 VERIFY 迁移专用文案`);
    assert.notStrictEqual(row.no_code_reason, RELEASE_MIGRATION_NO_CODE_REASON, 'HIGH（96号）：VERIFY 族文案不应与 RELEASE 族文案相同（分开措辞）');
  }

  // 独立连接跑一遍探针（非信 runReset 内部自证）：验证落库最终态真实满足全部 15 条恒真不变量（含 P14 VERIFY 恒真）。
  const probeDb = new sqlite3.Database(dbPath);
  const probeResults = await runProbes(probeDb);
  const failedProbes = probeResults.filter(p => !p.pass);
  assert.strictEqual(failedProbes.length, 0, `HIGH：reset 后独立探针复核应全绿，实际失败：${JSON.stringify(failedProbes)}`);
  assert.strictEqual(probeResults.length, 15, 'HIGH：探针结果集应恰好 15 条（P1-P15）');
  await new Promise((resolve) => probeDb.close(() => resolve()));

  ok('[HIGH] 完成态族状态感知回填：DEV 族单仍走 pending（对照）+ 待上线/已上线单（RELEASE）与待验证单（VERIFY）统一回填 no_code（含软删历史行，各自专属文案）+ resolved_at 非空 + 独立复核 P1-P15 全绿（含 P14）');

  cleanupFiles(dbPath);
}

async function scenarioReleaseZeroRosterPrecheck() {
  const dbPath = tmpDbPath('releasezeroroster');
  await buildSchemaFile(dbPath);
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  // RELEASE 族单，assigned_to=NULL 且零在册（典型成因：roster 从未真正形成）——reset 无法凭空回填出开发者。
  const zeroRosterIssueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待上线', 'RELEASE族零在册单', 'BMS', 1, 'admin')`
  )).lastID;
  // 同批次陪跑一条正常 DEV 族单，验证 pre-check fail-fast 时"零副作用"覆盖到同批次其他单（整体回滚）
  const devIssueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '开发中', 'DEV族陪跑单', 'BMS', 1, 'admin', 1, '开发甲')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 1, '开发甲', 'pending')`, [devIssueId]);
  await new Promise((resolve) => db.close(() => resolve()));

  const before = await readState(dbPath, devIssueId);

  const r = await runReset({ dbPath, issueIds: [zeroRosterIssueId, devIssueId], expectIssues: 2 });
  assert.strictEqual(r.ok, false, 'HIGH：RELEASE 族零在册单应 fail-fast');
  assert.strictEqual(r.reason, 'COMPLETION_FAMILY_ZERO_ROSTER', `HIGH：失败原因应为 COMPLETION_FAMILY_ZERO_ROSTER（96 号复审改名自 RELEASE 族专用旧码），实际：${r.reason}`);
  assert.ok(Array.isArray(r.zeroRosterIssueIds) && r.zeroRosterIssueIds.includes(zeroRosterIssueId), `HIGH：zeroRosterIssueIds 应含目标 issue id，实际：${JSON.stringify(r.zeroRosterIssueIds)}`);
  assert.ok(r.message.includes(String(zeroRosterIssueId)), `HIGH：错误 message 应明确列出目标 issue id，实际：${r.message}`);

  const after = await readState(dbPath, devIssueId);
  assert.deepStrictEqual(after.rows, before.rows, 'HIGH：pre-check fail-fast 应整体回滚（覆盖动作在 pre-check 之后），同批次陪跑 DEV 族单未被写入');
  assert.strictEqual(after.markerExists, false, 'HIGH：pre-check fail-fast 后标记不应落库');

  ok('[HIGH] RELEASE 族零在册单（assigned_to=NULL）pre-check：覆盖动作前 fail-fast（reason=COMPLETION_FAMILY_ZERO_ROSTER）+ message 明确列出 issue id + 同批次其余单零副作用（整体回滚）');

  cleanupFiles(dbPath);
}

// HIGH（96 号复审新增）：VERIFY 族零在册单 pre-check——与 RELEASE 族零在册场景同构，独立种子验证 VERIFY 族
//   同样被 pre-check 覆盖（而非只在 RELEASE 族生效）。
async function scenarioVerifyZeroRosterPrecheck() {
  const dbPath = tmpDbPath('verifyzeroroster');
  await buildSchemaFile(dbPath);
  const db = new sqlite3.Database(dbPath);
  const H = makeHelpers(db);
  // VERIFY 族单，assigned_to=NULL 且零在册（典型成因：roster 从未真正形成）——reset 无法凭空回填出开发者。
  const zeroRosterIssueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待验证', 'VERIFY族零在册单', 'BMS', 1, 'admin')`
  )).lastID;
  // 同批次陪跑一条正常 DEV 族单，验证 pre-check fail-fast 时"零副作用"覆盖到同批次其他单（整体回滚）
  const devIssueId = (await H.run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '开发中', 'DEV族陪跑单', 'BMS', 1, 'admin', 1, '开发甲')`
  )).lastID;
  await H.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 1, '开发甲', 'pending')`, [devIssueId]);
  await new Promise((resolve) => db.close(() => resolve()));

  const before = await readState(dbPath, devIssueId);

  const r = await runReset({ dbPath, issueIds: [zeroRosterIssueId, devIssueId], expectIssues: 2 });
  assert.strictEqual(r.ok, false, 'HIGH（96号）：VERIFY 族零在册单应 fail-fast');
  assert.strictEqual(r.reason, 'COMPLETION_FAMILY_ZERO_ROSTER', `HIGH（96号）：失败原因应为 COMPLETION_FAMILY_ZERO_ROSTER，实际：${r.reason}`);
  assert.ok(Array.isArray(r.zeroRosterIssueIds) && r.zeroRosterIssueIds.includes(zeroRosterIssueId), `HIGH（96号）：zeroRosterIssueIds 应含目标 issue id，实际：${JSON.stringify(r.zeroRosterIssueIds)}`);
  assert.ok(r.message.includes(String(zeroRosterIssueId)) && r.message.includes('VERIFY'), `HIGH（96号）：错误 message 应明确列出目标 issue id 且标注 VERIFY 族，实际：${r.message}`);

  const after = await readState(dbPath, devIssueId);
  assert.deepStrictEqual(after.rows, before.rows, 'HIGH（96号）：pre-check fail-fast 应整体回滚，同批次陪跑 DEV 族单未被写入');
  assert.strictEqual(after.markerExists, false, 'HIGH（96号）：pre-check fail-fast 后标记不应落库');

  ok('[HIGH（96号）] VERIFY 族零在册单（assigned_to=NULL）pre-check：覆盖动作前 fail-fast（reason=COMPLETION_FAMILY_ZERO_ROSTER）+ message 明确列出 issue id 与所属族 + 同批次其余单零副作用（整体回滚）');

  cleanupFiles(dbPath);
}

async function main() {
  await scenarioHappyPathAndBlock();
  await scenarioExpectMismatch();
  await scenarioIssueIdsMismatch();
  await scenarioProbeFailureRollback();
  await scenarioReleaseFamilyBackfill();
  await scenarioReleaseZeroRosterPrecheck();
  await scenarioVerifyZeroRosterPrecheck();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ S35 验收：一次性重置第一遍成功(含 M1/M4 反例)+第二遍被标记阻止 + expect-issues 不符中止 + issue-ids 不匹配中止(H1) + 探针失败整体回滚 + 完成态族(RELEASE+VERIFY)状态感知回填(HIGH) + RELEASE/VERIFY 族零在册 pre-check(HIGH·96号)`);
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
