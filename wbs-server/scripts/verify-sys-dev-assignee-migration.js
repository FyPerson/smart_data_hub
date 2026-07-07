// 验证脚本：通知改造 Commit C1b 历史迁移端到端
//   方案：docs/local/系统迭代/bug流通知改造_方案_20260703_v1.5.md（内容 v1.6 定稿）§4.3 H-2/H-3
//   前置分析：docs/local/系统迭代/bug流通知改造_编码前置分析_20260705_v1.0.md G12/F4
//   任务书：docs/local/系统迭代/bug流通知改造_Sonnet任务书_20260705_v1.0.md §批1
//   用法：node scripts/verify-sys-dev-assignee-migration.js
//
// 覆盖：
//   [1] 补 primary 子表行 + dev notify 回填：user_name 解析四优先级
//       （users.display_name → users.username → sys_issues.assigned_to_name → 'user#'+id）
//   [G12] 每 issue 在册行恰好 1 条 is_primary=1 ∧ user_id==assigned_to
//   [2] 幂等：migration 二跑内容逐字不变；issue 已有在册 primary 行（即便 user_id 不同）→ 跳过不覆盖
//   [3] requester 历史快照降级数据基础：status='sent' ∧ snapshot 天然 NULL（C1a ALTER 新列，无需 C1b 额外动作）
//   [4] users 表不存在时优雅降级为 assigned_to_name，不 crash 整个迁移（多数 verify-sys-*.js 场景防护）
//   [5] F4：index.js 注释修正——反事实旧表述已删，新四行正交表述已在
//
// 设计说明：两阶段模拟（initSchema 建全五表 → 手工插入"历史"行 → 手动重跑 runSysMigration 触发回填）
//   与 verify-sys-bug-migration.js「先建旧库+种数据+一次 initSchema」等价——[1c] backfill 查询是纯读写现状的
//   幂等操作，不依赖数据"何时"插入，只依赖调用 runSysMigration 时刻的 DB 状态，故两种模拟方式效果相同；
//   本文件选两阶段法是为了避免重复整段旧库 DDL 样板（复用真实 initSchema 建表，非手工复刻）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function makeDbHelpers(db) {
  return {
    run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })),
    all: (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))),
    get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row))),
  };
}

function waitReady(I) {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

function makeMod(db, run, get, all) {
  return require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
}

// ── 场景 A：users 表存在（含 display_name/username 两种命名场景 + 无此 id 场景）──────────
async function scenarioWithUsersTable() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);
  ok('场景A：五表建全（首次 initSchema，此刻 sys_issues 空表，[1c] 无历史数据可迁移）');

  // users 表（真实建表语句简化：本场景只需 id/display_name/username 三列）
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, username TEXT)`);
  await run(`INSERT INTO users (id, display_name, username) VALUES (5, '真姓名甲', 'devA')`);   // 优先级①：display_name
  await run(`INSERT INTO users (id, display_name, username) VALUES (6, NULL, 'devB')`);          // 优先级②：仅 username
  // id=7：users 无此行（模拟账号已删除）→ 优先级③兜底 assigned_to_name
  // id=8：users 无此行 + assigned_to_name 也空 → 优先级④最终兜底 user#id

  const mkIssue = async (assignedTo, assignedToName, notifyStatus, notifiedAt, notifyMsgKey) => {
    const r = await run(
      `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name, notify_status, notified_at, notify_message_key, notify_error, read_at)
       VALUES ('feature', '开发中', '历史单', 'BMS', 1, 'admin', ?, ?, ?, ?, ?, NULL, NULL)`,
      [assignedTo, assignedToName, notifyStatus, notifiedAt, notifyMsgKey]
    );
    return r.lastID;
  };
  const issueA = await mkIssue(5, '旧留痕甲', 'sent', '2026-06-01 10:00:00', 'msgkey-a');
  const issueB = await mkIssue(6, '旧留痕乙', 'not_sent', null, null);
  const issueC = await mkIssue(7, '旧留痕丙', 'failed', null, null);
  const issueD = await mkIssue(8, null, 'not_sent', null, null);
  const issueE = await mkIssue(null, null, 'not_sent', null, null);   // assigned_to=NULL，对照组：不应生成子表行
  const issueR = await mkIssue(null, null, 'not_sent', null, null);   // requester 历史快照降级场景
  await run(`UPDATE sys_issues SET requester_notify_status = 'sent' WHERE id = ?`, [issueR]);
  ok('场景A：造 6 条历史单（A~D 各覆盖一种 user_name 解析优先级 + E 对照组 assigned_to=NULL + R 用于 requester 快照场景）');

  // ── [1] 手动重跑迁移，模拟"这批历史数据在本次迁移代码上线前已存在，本次启动首次发现并回填" ──────────
  await I.runSysMigration(null);
  await waitReady(I);

  const rowsAfter = await all(`SELECT issue_id, user_id, user_name, is_primary, notify_status, notified_at, notify_message_key, notify_error, read_at, removed_at FROM sys_issue_dev_assignees ORDER BY issue_id`);
  assert.strictEqual(rowsAfter.length, 4, `应恰好补 4 条 primary 行（A/B/C/D；E/R 无 assigned_to 应被排除），实际 ${rowsAfter.length}`);
  const byIssue = new Map(rowsAfter.map(r => [r.issue_id, r]));
  assert.ok(!byIssue.has(issueE), 'issueE（assigned_to=NULL）不应生成子表行');
  assert.ok(!byIssue.has(issueR), 'issueR（assigned_to=NULL）不应生成子表行');

  const a = byIssue.get(issueA);
  assert.strictEqual(a.user_id, 5, 'issueA user_id=assigned_to');
  assert.strictEqual(a.user_name, '真姓名甲', 'issueA 优先级①：users.display_name');
  assert.strictEqual(a.is_primary, 1, 'issueA is_primary=1');
  assert.strictEqual(a.notify_status, 'sent', 'issueA dev notify_status 回填 sent');
  assert.strictEqual(a.notified_at, '2026-06-01 10:00:00', 'issueA notified_at 回填');
  assert.strictEqual(a.notify_message_key, 'msgkey-a', 'issueA notify_message_key 回填');
  assert.strictEqual(a.removed_at, null, 'issueA removed_at NULL（在册）');

  const b = byIssue.get(issueB);
  assert.strictEqual(b.user_name, 'devB', 'issueB 优先级②：users.username（display_name 为空）');

  const c = byIssue.get(issueC);
  assert.strictEqual(c.user_name, '旧留痕丙', 'issueC 优先级③：users 无此 id → assigned_to_name 兜底');

  const d = byIssue.get(issueD);
  assert.strictEqual(d.user_name, 'user#8', 'issueD 优先级④：users 无此 id 且 assigned_to_name 空 → user#id 兜底');
  ok('⭐ [1] 补 primary 子表行 + dev notify 回填：4/6 历史单正确生成（E/R 因 assigned_to=NULL 排除）+ user_name 四优先级解析全对 + notify_status/notified_at/message_key 回填正确 + removed_at NULL（在册）');

  // ── [G12] 每 issue 恰好 1 条 is_primary=1 ∧ user_id==assigned_to ──────────
  for (const [issueId, expectedUid] of [[issueA, 5], [issueB, 6], [issueC, 7], [issueD, 8]]) {
    const primaries = await all(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND is_primary = 1 AND removed_at IS NULL`, [issueId]);
    assert.strictEqual(primaries.length, 1, `issue ${issueId} 应恰好 1 条在册 primary 行`);
    assert.strictEqual(primaries[0].user_id, expectedUid, `issue ${issueId} primary user_id 应==assigned_to`);
  }
  ok('⭐ G12 强断言：每 issue 在册行恰好 1 条 is_primary=1 且 user_id==assigned_to（A/B/C/D 全部核对）');

  // ── [2] 幂等：二跑不新增行、内容逐字不变 ──────────
  const beforeSnapshot = JSON.stringify(await all(`SELECT * FROM sys_issue_dev_assignees ORDER BY id`));
  await I.runSysMigration(null);
  await waitReady(I);
  const afterSnapshot = JSON.stringify(await all(`SELECT * FROM sys_issue_dev_assignees ORDER BY id`));
  assert.strictEqual(beforeSnapshot, afterSnapshot, '二跑迁移后 sys_issue_dev_assignees 内容应逐字不变（幂等）');
  const countAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_dev_assignees`)).c;
  assert.strictEqual(countAfter, 4, '二跑后总行数仍为 4（无重复插入）');
  ok('⭐ [2] 幂等：migration 二跑 sys_issue_dev_assignees 内容逐字不变 + 总行数不变（WHERE NOT EXISTS 已在册 primary 生效）');

  // ── [2b] 幂等边界：issue 已有在册 primary 行（即便 user_id≠assigned_to，模拟 C2 上线后已改派场景）
  //   → 迁移只看"存在性"不比对 user_id 一致性，跳过不新增不覆盖 ──────────
  const issueF = await mkIssue(9, '丁', 'not_sent', null, null);
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, notify_status) VALUES (?, 99, '已改派开发', 1, 'sent')`, [issueF]);
  await I.runSysMigration(null);
  await waitReady(I);
  const fRows = await all(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND is_primary = 1 AND removed_at IS NULL`, [issueF]);
  assert.strictEqual(fRows.length, 1, 'issueF 已有在册 primary 行（跳过判据=存在性非 user_id 一致性），迁移不应新增第二条');
  assert.strictEqual(fRows[0].user_id, 99, 'issueF 已有的在册 primary 行不应被迁移覆盖（user_id 仍为 99，非 assigned_to=9）');
  ok('⭐ [2b] 幂等边界：issue 已有在册 primary 行（即便 user_id≠assigned_to，如 C2 上线后已改派场景）→ 迁移跳过不新增不覆盖');

  // ── [3] requester 历史快照降级数据基础 ──────────
  const rIssue = await get(`SELECT requester_notify_status, requester_notify_phone_snapshot FROM sys_issues WHERE id = ?`, [issueR]);
  assert.strictEqual(rIssue.requester_notify_status, 'sent', 'issueR requester_notify_status=sent（预置样本）');
  assert.strictEqual(rIssue.requester_notify_phone_snapshot, null, 'issueR requester_notify_phone_snapshot 天然 NULL（C1a ALTER 新列，无需 C1b 额外迁移）');
  ok('⭐ [3] requester 历史快照降级数据基础：status=sent ∧ snapshot IS NULL 组合天然成立（HISTORICAL_SNAPSHOT_MISSING 留给 C3 read-status 按此判读，C1b 无需新增标记列/迁移动作）');

  db.close();
}

// ── 场景 B：users 表不存在（多数 verify-sys-*.js 场景防护）──────────
async function scenarioNoUsersTable() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);

  // 手工插入一条待迁移的"历史单"（users 表全程不存在），再手动重跑迁移触发降级路径。
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, assigned_to, assigned_to_name)
             VALUES ('bug', '处理中', '无 users 表场景', 'BMS', 1, 'admin', 42, '兜底姓名')`);
  await I.runSysMigration(null);
  await waitReady(I);
  const row = await get(`SELECT user_id, user_name, is_primary FROM sys_issue_dev_assignees WHERE user_id = 42`);
  assert.ok(row, 'users 表不存在场景下仍应正确补 primary 子表行（不因 users 缺失而整体跳过迁移）');
  assert.strictEqual(row.user_name, '兜底姓名', 'users 表不存在 → 直接回退 assigned_to_name（不查 users，PRAGMA 表探测分支）');
  assert.strictEqual(row.is_primary, 1, 'is_primary=1');
  ok('⭐ [4] users 表不存在（探测分支）：迁移不 crash，正确回退 assigned_to_name，readiness 仍 ready=true');
  db.close();
}

// ── F4：index.js 注释修正——反事实旧表述已删，新四行正交表述已在 ──────────
function verifyF4Comment() {
  const src = fs.readFileSync(path.join(__dirname, '../routes/sys-iteration/index.js'), 'utf8');
  assert.ok(!/无每单 relay_notified_user_id 绑定，与 correction 不同/.test(src), 'F4：反事实旧注释（"无每单 relay_notified_user_id 绑定"）应已删除');
  assert.ok(/F4 修正/.test(src) && /四行正交/.test(src), 'F4：新注释应含"F4 修正"+"四行正交"表述');
  ok('⭐ [5] F4 注释修正：源码不再含反事实旧表述（"无每单绑定"），已替换为 §3.1 四行正交表述');
}

async function main() {
  await scenarioWithUsersTable();
  await scenarioNoUsersTable();
  verifyF4Comment();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ 通知改造 Commit C1b 历史迁移端到端验证通过`);
  console.log('  覆盖：补 primary 子表行(4 场景 user_name 优先级) + dev notify 回填 + G12 恰好1条断言 + 幂等(二跑逐字不变/已有在册跳过不覆盖) + requester 历史快照数据基础 + users 表缺失降级 + F4 注释修正');
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
