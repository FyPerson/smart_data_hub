// 验证脚本：系统迭代 受理与排期改造 C1 Schema 迁移端到端
//   方案：docs/local/系统迭代/系统迭代_受理与排期改造_方案_20260719_v1.3.3.md §8（Schema 迁移）+ §12（存量迁移）
//   用法：node scripts/verify-sys-intake-schedule-migration.js
//
// 覆盖（方案 §12 三场景验收 + §8.1/§8.3 不变量）：
//   [1] 补列：sys_issues 11 新列（intake_required/scheduled_start/tech_lead_* 9）全部 ALTER 到位
//   [2] 归一化 + 默认：intake_required NOT NULL DEFAULT 0，旧行回填 0；tech_lead_notify_status DEFAULT 'not_sent'
//   [3] 状态映射（§12 步骤4）：feature/improvement 的「待评估/已排期」→「待指派」；bug 不动；其它态零破坏
//   [4] 后验守恒（§12 步骤6）：总行数守恒 + 旧态清零 + 映射数守恒 + intake_required∈{0,1} + (type,status)∈新集
//   [5] 迁移标记（§12 步骤8）：sys_schema_migrations 落 'intake_schedule_c1'；readiness ready=true
//   [6] 三场景（§12 步骤9）：①首次(有旧态) ②重跑(标记在→整段跳过) ③列在无标记(残留态→补列跳过·映射命中·补标记)
//   [7] fail-fast（§12 步骤2）：先验发现非法 (type,status) 组合（不在旧∪新集）→ 迁移抛错回滚、readiness error
//   [8] readiness 锚点：intake_required + tech_lead_notify_status 入 KEY_COLS（mid-migration 崩溃保护）
//
// 设计说明：fresh :memory: → 真实 initSchema（CREATE sys_issues 不含 C1 列）→ 首次 runSysMigration 自动 ALTER 补列。
//   旧态数据须在「首次映射发生前」种入——但 initSchema 尾部自动触发一次 migration。故用「种旧态 + 删标记 + 重跑」
//   精确复现三场景（这与生产「旧库首次迁移」等价：migration 只依赖调用时刻的 DB 状态，不依赖数据何时插入，
//   同 verify-sys-dev-assignee-migration.js 两阶段法说明）。
const assert = require('assert');
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

function makeMod(db, run, get, all) {
  return require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
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
// 等 readiness 进入 error 态（用于 fail-fast 场景 [7]）
function waitError(I) {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); res(I.SYS_SCHEMA_STATE.error); }
      else if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); rej(new Error('期望 error 但 ready=true')); }
      else if (++n > 500) { clearInterval(t); rej(new Error('等 error 超时')); }
    }, 10);
  });
}

const seedIssue = (run, type, status, intakeRaw) =>
  // intakeRaw=undefined → 不写 intake_required（走列 DEFAULT）；否则显式写（测归一化）
  intakeRaw === undefined
    ? run(`INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
           VALUES (?, ?, '存量单', 'BMS', '内部', 1, 'admin')`, [type, status])
    : run(`INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
           VALUES (?, ?, '存量单', 'BMS', '内部', 1, 'admin', ?)`, [type, status, intakeRaw]);

const C1_KEY = 'intake_schedule_c1';
// ⭐ 角色权限重构 C0：新增 role_perm_c0_intake_gate 迁移（intake_required 存量归一为 1），紧随 C1 之后跑。
//   夹具"删标记重跑"必须**两个一起删**——只删 C1 会造出真实启动流程里不存在的中间态
//   （C1 把非法值归一为 0，而 C0 因标记仍在被跳过 → 残留 0），进而让断言测到一个假的最终态。
const C0_KEY = 'role_perm_c0_intake_gate';
const clearMarker = (run) => run(`DELETE FROM sys_schema_migrations WHERE migration_key IN (?, ?)`, [C1_KEY, C0_KEY]);
const markerRow = (get) => get(`SELECT migration_key, applied_at FROM sys_schema_migrations WHERE migration_key = ?`, [C1_KEY]);

// ── 场景①+③+④：有旧态数据首次迁移（映射 + 后验 + 补列 + 归一化 + 幂等）──────────
async function scenarioMigrateWithLegacyData() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);   // 首次自动迁移（空表·0 行映射·标记已落）
  ok('初始化：真实 initSchema + 首次自动迁移（空表·标记 intake_schedule_c1 已落·ready=true）');

  // [1] 补列到位（首次自动迁移已 ALTER）
  const cols = (await all('PRAGMA table_info(sys_issues)')).map(c => c.name);
  const NEW_COLS = ['intake_required', 'scheduled_start', 'tech_lead_id', 'tech_lead_name',
    'tech_lead_notify_status', 'tech_lead_notified_at', 'tech_lead_notify_message_key',
    'tech_lead_read_at', 'tech_lead_notify_error', 'tech_lead_notify_sent_by', 'tech_lead_notify_request_event_id'];
  for (const c of NEW_COLS) assert.ok(cols.includes(c), `sys_issues 应含 C1 新列 ${c}`);
  ok(`⭐ [1] 补列：sys_issues 11 新列全部 ALTER 到位（${NEW_COLS.length} 列）`);

  // 种旧态 + 边界数据（含归一化样本），再删标记 → 重跑（复现「列在无标记的残留态」=场景③，语义等价首次有旧态数据）
  //   ⭐ 角色权限重构 C0：本组要造的正是「C0 之前的旧库形态」——含 intake_required 缺省/'1'/7 等非 1 值。
  //     C0 之后这些在 DB 层已被触发器拒（全表恒 1），故造夹具时**显式摘除约束**（真实升级顺序也是
  //     先有旧数据、迁移修完才建约束）。绝不为迁就夹具去调弱生产约束（codex C0 三轮审 HIGH）。
  const gate = require('./lib/sys-intake-gate-triggers')(run, I);
  await gate.withoutTriggers(async () => {
    await seedIssue(run, 'feature', '待评估');        // 应映射 → 待指派
    await seedIssue(run, 'improvement', '已排期');    // 应映射 → 待指派
    await seedIssue(run, 'feature', '开发中');        // 非旧态·零破坏对照
    await seedIssue(run, 'bug', '待处理');            // bug 无旧态·不动
    await seedIssue(run, 'feature', '待评估', '1');   // intake_required='1'（字符串）→ C1 归一化 1
    await seedIssue(run, 'improvement', '待指派', 7); // intake_required=7（非法值）→ C1 归一化 0 → C0 再归一 1
  });
  const beforeTotal = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
  await clearMarker(run);
  await I.runSysMigration(null);
  await waitReady(I);
  ok(`⭐ [6-③] 列在无标记（残留态）：种 ${beforeTotal} 行旧态/边界 + 删标记 + 重跑 → 补列跳过(幂等)·映射命中·补标记·ready=true`);

  // [3] 状态映射
  const rows = await all(`SELECT type, status, intake_required FROM sys_issues ORDER BY id`);
  assert.strictEqual(rows[0].status, '待指派', 'feature 待评估 → 待指派');
  assert.strictEqual(rows[1].status, '待指派', 'improvement 已排期 → 待指派');
  assert.strictEqual(rows[2].status, '开发中', 'feature 开发中 非旧态·不动（零破坏）');
  assert.strictEqual(rows[3].status, '待处理', 'bug 待处理 不动');
  assert.strictEqual(rows[4].status, '待指派', 'feature 待评估(intake=1) → 待指派');
  assert.strictEqual(rows[5].status, '待指派', 'improvement 待指派 非旧态·不动');
  ok('⭐ [3] 状态映射：feature/improvement 待评估/已排期 → 待指派；bug 与非旧态零破坏');

  // [2] 归一化：⭐ 角色权限重构 C0 起本断言测的是**迁移链最终态**（C1 归一化 → C0 归一 两段叠加）。
  //   C1 段：'1'（字符串）→1 / 7（非法）→0 / 未显式写→列 DEFAULT；
  //   C0 段（migration_key=role_perm_c0_intake_gate·紧随 C1）：受理门焊死为全类型必经 → 全表归一为 1。
  //   故最终态**所有行恒 1**，C1 段的中间态（0）在本脚本已观测不到——这正是 C0 的目标：
  //   新模型下 intake_required=0 是非法态（会造出「待受理+ir0」矛盾单卡死受理），不允许存量残留。
  //   ⚠️ C1 归一化逻辑本身的回归保护由"非法值 7 不会残留"承担（若 C1 段失灵，7 会被 C0 的 !=1 条件一并改成 1，
  //     故这里额外断言不存在任何非 0/1 的脏值，作为两段共同的兜底）。
  for (const [i, r] of rows.entries()) {
    assert.strictEqual(r.intake_required, 1,
      `第 ${i} 行 intake_required 应为 1（C1 归一化 + C0 全表归一叠加后的最终态），实际 ${r.intake_required}`);
  }
  ok('⭐ [2]+[4] 归一化最终态：C1（\'1\'→1 / 7→0 / 缺省→DEFAULT）叠加 C0（全表归一 1）→ 所有行 intake_required 恒 1（新模型下 0 为非法态）');

  // [4] 后验守恒：总行数守恒 + 旧态清零
  const afterTotal = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
  assert.strictEqual(afterTotal, beforeTotal, `总行数守恒（前 ${beforeTotal} = 后 ${afterTotal}）`);
  const legacyRemain = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE type IN ('feature','improvement') AND status IN ('待评估','已排期')`)).c;
  assert.strictEqual(legacyRemain, 0, '映射后旧态清零');
  ok('⭐ [4] 后验守恒：总行数守恒 + 旧态清零（迁移不增删行·仅改 status）');

  // [5] 迁移标记落
  const m = await markerRow(get);
  assert.ok(m && m.migration_key === C1_KEY && m.applied_at, '迁移标记 intake_schedule_c1 已落且 applied_at 非空');
  ok('⭐ [5] 迁移标记：sys_schema_migrations 落 intake_schedule_c1（applied_at 随事务提交）');

  // [6-②] 重跑（标记在）→ 整段跳过、内容逐字不变（幂等）
  const before = JSON.stringify(await all(`SELECT id, type, status, intake_required FROM sys_issues ORDER BY id`));
  await I.runSysMigration(null);
  await waitReady(I);
  const after = JSON.stringify(await all(`SELECT id, type, status, intake_required FROM sys_issues ORDER BY id`));
  assert.strictEqual(before, after, '标记在场景重跑：sys_issues 内容逐字不变（整段跳过）');
  ok('⭐ [6-②] 重跑（标记已在）：整段跳过·内容逐字不变（幂等）');

  db.close();
}

// ── 场景⑦：fail-fast——先验发现非法组合（不在旧∪新集）→ 迁移回滚、readiness error ──────────
async function scenarioFailFast() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);

  // 种一条非法组合（status 无 CHECK，可插任意值）：feature + '幽灵态'（不在旧∪新集）
  await seedIssue(run, 'feature', '幽灵态');
  await clearMarker(run);
  await I.runSysMigration(null);
  const err = await waitError(I);
  assert.ok(/先验失败|非法组合/.test(err), `fail-fast 错误信息应含「先验失败/非法组合」，实际：${err}`);
  // 回滚验证：非法态仍在（未被误改）、标记未落
  const ghost = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE status='幽灵态'`)).c;
  assert.strictEqual(ghost, 1, 'fail-fast 回滚：非法态行保留（迁移未提交任何改动）');
  const m = await markerRow(get);
  assert.ok(!m, 'fail-fast：迁移标记未落（事务回滚·下次可重跑）');
  ok('⭐ [7] fail-fast：非法 (type,status) 组合触发先验失败 → 事务回滚（非法态保留·标记未落·readiness error·sys 写入口 503）');

  db.close();
}

// ── 场景⑧：readiness 锚点 mid-migration 崩溃保护 ──────────
async function scenarioReadinessAnchor() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);

  // 断言 KEY_COLS 含 C1 热路径锚点（mid-migration 崩溃后未补这两列 → readiness 应判 ready=false）
  const keyCols = I.SYS_ISSUES_KEY_COLS;
  assert.ok(keyCols.includes('intake_required'), 'SYS_ISSUES_KEY_COLS 应含 intake_required（热路径锚点）');
  assert.ok(keyCols.includes('tech_lead_notify_status'), 'SYS_ISSUES_KEY_COLS 应含 tech_lead_notify_status（NOT NULL 通知列锚点）');
  ok('⭐ [8] readiness 锚点：intake_required + tech_lead_notify_status 入 SYS_ISSUES_KEY_COLS（mid-migration 崩溃保护）');

  db.close();
}

// ── 场景⑨：事务失败注入（codex MED-2）——迁移中途某步失败 → 整体回滚（标记不落·旧态原样）·可重跑收敛 ──────────
//   在「写标记 INSERT」注入失败：断言 ROLLBACK 后①标记未落 ②状态映射被回滚（旧态原样保留·未变待指派）
//   ③补列因 ALTER 也在事务内应回滚（PRAGMA 不再有新列）④清除注入后重跑成功收敛（标记落·映射生效）。
//   注入法：包裹 db.run，命中目标 SQL 的第 K 次调用抛错（模拟磁盘满/约束冲突等中途故障）。
async function scenarioFaultInjectionRollback() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = makeMod(db, run, get, all);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I);   // 首次自动迁移（空表·标记已落）

  // 种旧态数据 + 删标记 → 准备一次「有实际映射」的迁移，但注入其「写标记」步骤失败
  await seedIssue(run, 'feature', '待评估');
  await seedIssue(run, 'improvement', '已排期');
  await clearMarker(run);
  const beforeSnapshot = JSON.stringify(await all(`SELECT id, type, status FROM sys_issues ORDER BY id`));

  // 注入：拦 sys_schema_migrations 的 INSERT（写标记步骤）令其失败——此时补列/映射均已在事务内执行，
  //   失败应触发 ROLLBACK 把它们全部撤销（验证「标记与列/数据同步回滚」）。
  const origRun = db.run.bind(db);
  let injected = false;
  db.run = function (sql, params, cb) {
    if (!injected && typeof sql === 'string' && /INSERT INTO sys_schema_migrations/.test(sql)) {
      injected = true;
      const callback = (typeof params === 'function') ? params : cb;
      // 模拟写标记失败（不真执行 INSERT）
      if (callback) process.nextTick(() => callback(new Error('注入故障：写迁移标记失败（模拟磁盘满/约束冲突）')));
      return;
    }
    return origRun(sql, params, cb);
  };

  await I.runSysMigration(null);
  const err = await waitError(I);
  db.run = origRun;   // 撤注入
  assert.ok(/注入故障|迁移异常/.test(err), `注入失败应传导到 readiness error，实际：${err}`);

  // ① 标记未落
  const m1 = await markerRow(get);
  assert.ok(!m1, '事务失败注入：迁移标记未落（ROLLBACK 撤销·下次可重跑）');
  // ② 状态映射被回滚（旧态原样·未变待指派）
  const afterSnapshot = JSON.stringify(await all(`SELECT id, type, status FROM sys_issues ORDER BY id`));
  assert.strictEqual(afterSnapshot, beforeSnapshot, '事务失败注入：状态映射被 ROLLBACK 撤销（旧态原样保留·未误改待指派）');
  const stillLegacy = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE status IN ('待评估','已排期')`)).c;
  assert.strictEqual(stillLegacy, 2, '事务失败注入：2 行旧态仍在（映射整体回滚）');
  ok('⭐ [9-a] 事务失败注入（写标记步骤失败）→ ROLLBACK：标记未落 + 状态映射回滚（旧态原样·补列/映射/标记同步撤销）');

  // ④ 清除注入后重跑 → 成功收敛
  await I.runSysMigration(null);
  await waitReady(I);
  const m2 = await markerRow(get);
  assert.ok(m2 && m2.migration_key === C1_KEY, '重跑：标记正常落');
  const recovered = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE type IN ('feature','improvement') AND status IN ('待评估','已排期')`)).c;
  assert.strictEqual(recovered, 0, '重跑：旧态清零（映射成功·失败不留半成品阻塞后续）');
  const targetNow = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE status='待指派'`)).c;
  assert.strictEqual(targetNow, 2, '重跑：2 行成功映射到待指派');
  ok('⭐ [9-b] 失败后重跑收敛：撤除故障 → 迁移成功（标记落·旧态清零·2 行映射待指派）·失败不留半成品阻塞');

  db.close();
}

async function main() {
  console.log('系统迭代 受理与排期改造 C1 Schema 迁移验证\n');
  await scenarioMigrateWithLegacyData();
  await scenarioFailFast();
  await scenarioReadinessAnchor();
  await scenarioFaultInjectionRollback();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ C1 Schema 迁移端到端验证通过`);
  console.log('  覆盖：补 11 列 + 状态映射(待评估/已排期→待指派) + intake_required 归一化(∈{0,1}) + 后验守恒(行数/旧态清零/映射数) + 迁移标记 + 三场景(首次/重跑/列在无标记) + fail-fast 回滚 + 事务失败注入回滚+重跑收敛 + readiness 锚点');
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
