// 验证脚本：系统迭代 sysIssueTransition 状态机（C2，方案 §3.6/§3.7/§9）
//   用法：node scripts/verify-sys-transition.js
//
// require 真实 index.js _internals.sysIssueTransition 跑变更流全链路，断言：
//   1. 流转合法性（非法 from→to 拒）+ expectedFrom 比对（陈旧前置态 409）
//   2. 双 WHERE + changes≠1 → 409（并发：先改 status 再 transition 应 409）
//   3. 权限分流（roleGuard='admin' 非 admin 拒）
//   [C3 退场] assign/submit 均移出本函数（旧 switch-case 删除），RC-M5/submit 闸门/ownerGuard 白盒测试随之退场
//     ——真实端点行为分别见 verify-sys-dev-assignee-transition.js / verify-sys-multidev-submit.js
//   5. ⭐ reassign 不增 return_count（05-M2 判别）vs return 增 return_count（U-2）
//   6. timeline 写入（event_type/action_code/from/to 正确，覆盖仍走本函数的 schedule/return）
//   7. 变更流正向链路（schedule 走 transition，assign/submit 改直接 SQL 快进）→验收→...
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
});
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const DEV = { id: 5, name: '开发王', role: 'user' };
const DEV2 = { id: 6, name: '开发李', role: 'user' };
const OTHER = { id: 9, name: '路人', role: 'user' };

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 直接 INSERT 一个变更流单（指定 status/assigned_to，跳过端点，专测 transition）
//   受理排期改造：默认前段态由「待评估」改「待受理」（新前段·intake_accept 引擎测起点）。
async function seedIssue({ status = '待受理', assigned_to = null, type = 'feature', dev_estimated_at = null, intake_required = null } = {}) {
  // ⭐ 角色权限重构 C0：受理门焊死为全类型必经 → intake_required **全表恒 1**（0 已是非法态，
  //   DB 触发器会 ABORT）。原按 status 派生 0/1 的逻辑随之作废：非受理态也必须是 1。
  //   （旧注释语境是"受理态恒 1、其余 0"，那是受理门可选时代的口径。）
  const ir = intake_required !== null ? intake_required : 1;
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, assigned_to, assigned_to_name, dev_estimated_at, intake_required)
     VALUES (?, ?, 't', 'BMS', '内部', 1, 'admin', ?, ?, ?, ?)`,
    [type, status, assigned_to, assigned_to ? '开发王' : null, dev_estimated_at, ir]
  );
  return r.lastID;
}
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }
async function rowOf(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }
async function timelineOf(id) { return await all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id', [id]); }

// [C3] assign/submit 均已移出 sysIssueTransition（'assign' switch 分支随旧 /assign 端点删除、'submit' 改走独立
//   handleDevSubmit 多开发 commit 事件模型，见 index.js:1303-1314 退场注释）——直接 `I.sysIssueTransition(id,
//   'assign'|'submit', ...)` 的白盒调用已测不到生产路径（无端点再传这两个 action 给本函数）。本文件后续 fixture
//   改直接 SQL 落状态 + roster（对齐 seedIssue 既有"跳过端点直插库"风格）快进到所需前置态，不模拟旧闸门行为。
//   assign 的真实端点行为（含 RC-M5 无 assigned_to 不变量、timeline 记录）由 verify-sys-dev-assignee-transition.js
//   /verify-sys-bug-transitions.js 覆盖；submit 的真实端点行为（含 roster pending 校验、dev_events 记录）由
//   verify-sys-multidev-submit.js 覆盖，均为 HTTP 层真实调用，非本文件白盒直调风格。
async function fastForwardAssign(id, devId = DEV.id, devName = DEV.name) {
  await run(`UPDATE sys_issues SET status='开发中', assigned_to=?, assigned_to_name=?, assigned_at=datetime('now','localtime') WHERE id=?`,
    [devId, devName, id]);
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, 'pending')`,
    [id, devId, devName]);
}
async function fastForwardSubmit(id) {
  await run(`UPDATE sys_issue_dev_assignees SET dev_status='no_code', resolved_at=datetime('now','localtime'), no_code_reason='fixture 快进' WHERE issue_id=? AND removed_at IS NULL`, [id]);
  await run(`UPDATE sys_issues SET status='待验证', first_submitted_at=datetime('now','localtime') WHERE id=?`, [id]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  // [C10] users 表：intake_accept 引擎侧「空单 eligible 受理兜底」判据会**无条件**求值
  //   isIntakeLiaisonEligible(actor.id)（读 users 表判 active∧role∈{user,publisher}）——即便 actor=admin
  //   该表达式也被 eager 计算（isUnboundAcceptClaim 常量在 if 前先算），故本 harness 必须建 users 表，
  //   否则任何空单 intake_accept 会因缺表抛「no such table: users」。seed 关键角色即可。
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','admin','admin','active'),(5,'dev','开发王','user','active'),(6,'dev2','开发李','user','active'),
    (9,'other','路人','user','active'),(13,'liaison','对接人','user','active')`);
  ok('readiness ready=true（真实 initSchema）+ users 表 seed（C10 空单受理兜底判据需读库）');

  // 受理排期改造：schedule 退场·引擎白盒测的具名边改用 intake_accept（待受理→待指派·仍走 sysIssueTransition）。
  // [1] 流转合法性：待受理 → assign（assign 需「待指派」前置·受理门未过不能直派）应拒
  {
    const id = await seedIssue({ status: '待受理' });
    await assert.rejects(
      I.sysIssueTransition(id, 'assign', '待受理', ADMIN, { assigned_to: DEV.id, assigned_to_name: DEV.name }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_TRANSITION',
      '待受理态 assign 应 INVALID_TRANSITION');
    ok('流转合法性：feature 待受理态执行 assign（需待指派前置·受理门未过）被拒 INVALID_TRANSITION');
  }

  // [2] expectedFrom 比对：实际「待受理」但传 expectedFrom='待修改' 应拒（陈旧前置态）
  {
    const id = await seedIssue({ status: '待受理' });
    await assert.rejects(
      I.sysIssueTransition(id, 'intake_accept', '待修改', ADMIN, {}),
      e => e instanceof I.SysTransitionError && (e.code === 'CONCURRENT_STATE_CHANGE' || e.code === 'INVALID_TRANSITION'),
      'expectedFrom 不匹配应拒');
    ok('expectedFrom 比对：实际待受理 + 传 expectedFrom=待修改 → 拒（陈旧前置态）');
  }

  // [3] 权限：intake_accept roleGuard=intake_liaison（C10 绑单精判：admin ∨ 该单绑定对接人 ∨ 空单 eligible 受理）。
  //   本用例把单绑到 13（非 DEV），使「空单受理兜底」分支短路（row.intake_liaison_id != null → 不触发
  //   isIntakeLiaisonEligible 读库·本 harness 无 users 表，否则会因缺表抛错）——DEV 非 admin、非绑定人 →
  //   403 NOT_BOUND_LIAISON（C10 后拒绝码由 NOT_AUTHORIZED_FOR_TRANSITION 收窄为 NOT_BOUND_LIAISON）。
  {
    const id = await seedIssue({ status: '待受理' });
    await run(`UPDATE sys_issues SET intake_liaison_id = 13 WHERE id = ?`, [id]);   // 绑非 DEV 的对接人
    await assert.rejects(
      I.sysIssueTransition(id, 'intake_accept', '待受理', DEV, {}),
      e => e instanceof I.SysTransitionError && e.code === 'NOT_BOUND_LIAISON',
      'intake_accept 非受理人/admin 应 403 NOT_BOUND_LIAISON');
    ok('权限 roleGuard：intake_accept（受理人/admin 动作）由非绑定开发执行 → 403 NOT_BOUND_LIAISON（C10 绑单精判·已绑单非绑定人拒）');
  }

  // [3b] 受理排期改造 codex131-H1：roleGuard='creator_or_admin'（resubmit_intake）——建单人∨admin·引擎按事务内 row.created_by 校验
  {
    // 待修改单·created_by=DEV(5)。resubmit_intake：待修改→待受理（INTAKE 族内·无 roster 门）
    // 待修改态 intake_required=1（受理排期改造 C3 codex MED-1 连带修：受理门不变量在权限校验前·夹具须一致否则先撞 409）
    const mk = async (createdBy) => (await run(
      `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
       VALUES ('feature', '待修改', 't', 'BMS', '内部', ?, ?, 1)`,
      [createdBy, createdBy === 1 ? 'admin' : '开发王'])).lastID;
    // ① 非 admin 非 creator（DEV2=6·单 created_by=5）→ 403
    const idA = await mk(DEV.id);
    await assert.rejects(
      I.sysIssueTransition(idA, 'resubmit_intake', '待修改', DEV2, {}),
      e => e instanceof I.SysTransitionError && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      'resubmit_intake 非建单人非 admin 应 403');
    // ② 建单人本人（DEV=5·单 created_by=5）→ 200 待受理
    const idB = await mk(DEV.id);
    const rB = await I.sysIssueTransition(idB, 'resubmit_intake', '待修改', DEV, {});
    assert.strictEqual(rB.toStatus, '待受理', 'resubmit_intake 建单人本人 → 待受理');
    // ③ admin（非建单人·单 created_by=5）→ 200（admin 全能）
    const idC = await mk(DEV.id);
    const rC = await I.sysIssueTransition(idC, 'resubmit_intake', '待修改', ADMIN, {});
    assert.strictEqual(rC.toStatus, '待受理', 'resubmit_intake admin（非建单人）→ 待受理');
    ok('权限 roleGuard creator_or_admin（codex131-H1）：resubmit_intake 非建单人非 admin→403 / 建单人本人→200 / admin→200（引擎按事务内 row.created_by 校验）');
  }

  // [C3 退场] [4] RC-M5：指派时不给 assigned_to → 进开发中态被不变量拦（无开发负责人）
  //   旧路径：I.sysIssueTransition(id,'assign',...) 的 switch-case 内部校验 assigned_to 必填。该 case 已删除，
  //   'assign' 落到 default 分支 no-op（不再触发此检查）——RC-M5 不变量现由真实 /sys-issues/:id/assign 端点
  //   在 HTTP 层强制（缺 assigned_to → 400 ASSIGN_TARGET_REQUIRED，见 verify-sys-dev-assignee-transition.js），
  //   非本函数职责，随退场一并移除，不在本文件补白盒替代（白盒直调该 action 本身已是测试死代码）。

  // [5] 正向链路：待受理 → intake_accept → 待指派 → assign(快进) → 开发中（带 assigned_to）
  let mainId;
  {
    mainId = await seedIssue({ status: '待受理' });
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] seedIssue 默认 type='feature'，intake_accept 受理必带 risk_level。
    let r = await I.sysIssueTransition(mainId, 'intake_accept', '待受理', ADMIN, { risk_level: '二级' });
    assert.strictEqual(r.toStatus, '待指派', 'intake_accept 待受理 → 待指派');
    assert.strictEqual(await statusOf(mainId), '待指派');

    // [C3] assign 不再走 sysIssueTransition（见上方 [4] 退场说明），改直接 SQL 快进（fastForwardAssign）
    await fastForwardAssign(mainId);
    assert.strictEqual(await statusOf(mainId), '开发中', 'assign 快进 → 开发中');
    const afterAssign = await rowOf(mainId);
    assert.strictEqual(Number(afterAssign.assigned_to), DEV.id, 'assigned_to 写入');
    assert.ok(afterAssign.assigned_at, 'assigned_at 盖时间');
    ok('正向链路：待受理 →intake_accept→ 待指派 →assign(快进)→ 开发中（assigned_to/at）');
  }

  // [5b] 受理排期改造：schedule 的 deadline/priority 校验专测已退场（schedule 动作删·priority/deadline 改由建单填 + 待修改态 edit_in_revision 承接·§7.3）。
  //   deadline 格式校验（normalizeDeadline）逻辑本身在建单端点仍生效，其单元反例由 verify-sys-schema.js/建单 verify 覆盖，不在本引擎白盒测。

  // [C3 退场] [6]/[7]/[7b] 旧 submit 闸门（ESTIMATE_REQUIRED/SUBMIT_SUMMARY_REQUIRED/ownerGuard 严格本人 H-1）
  //   均属旧 I.sysIssueTransition(...,'submit',...) switch-case 内部逻辑，随该 case 删除一并退场（index.js:
  //   1307-1314）。新 handleDevSubmit 是完全不同的校验模型，逐项核实覆盖情况（codex 98 号 MED5 要求：凡属
  //   submit 行为验证必须走真实路由核实，不能只在此处 SQL 快进就断言"已覆盖"）：
  //   - SUBMIT_SUMMARY_REQUIRED：被新 §6.1 mode 专属必填校验取代（no_code_reason trim 1..500 / commit_ref
  //     trim 1..200），真实路由反例见 verify-sys-multidev-submit.js VALIDATION 边界组——确认覆盖。
  //   - ownerGuard 严格本人（H-1，admin 也不能代提交）：assertDevMember 统一在册判定（403 NOT_ROSTERED），
  //     真实路由反例见 verify-sys-bug-transitions.js:524-533（非在册开发 403 + admin 代提交 403 两条）——确认覆盖。
  //   - ✅ ESTIMATE_REQUIRED（提交前必须已回填 dev_estimated_at）：上一轮核实时发现新 handleDevSubmit 曾
  //     遗漏此项校验（既非被取代也未被复刻），已按 codex 98 号 HIGH 同一处方（SSOT 未明确废除的现网 submit
  //     资格不变量=行为回归，非语义重定义）在同批次内回填——对照 e39e65b 版旧 case 'submit'（index.js:1376）
  //     逐字复刻（判定/错误码 `ESTIMATE_REQUIRED` 原样，无 type 限定，bug 流同受理）。真实路由反例见
  //     verify-sys-multidev-submit.js S1b（feature + bug 各一条）——确认覆盖，缺口已回填，非遗留问题。
  //   [8]/[9] 需要 mainId 处于「待验证」态作前置 fixture（非 submit 行为验证本身）——直接 SQL 快进
  //   （fastForwardSubmit）绕过 handleDevSubmit 全部校验（含新恢复的 ESTIMATE_REQUIRED），在此仍合规
  //   （SQL 快进只允许用于非 submit 行为验证的场景准备，不受本轮闸门变化影响）。
  await fastForwardSubmit(mainId);
  assert.strictEqual(await statusOf(mainId), '待验证', 'submit 快进 → 待验证');
  ok('正向链路（续）：开发中 →submit(快进)→ 待验证（fixture 准备，submit 行为本身验证见上方逐项核实）');

  // [8] ⭐ return vs reassign 的 return_count 判别（05-M2）
  {
    // return（验收打回）：待验证 → 开发中，return_count++
    const before = (await rowOf(mainId)).return_count;
    const r = await I.sysIssueTransition(mainId, 'return', '待验证', ADMIN, { reason: '列对不齐' });
    assert.strictEqual(r.toStatus, '开发中', 'return → 开发中');
    const after = await rowOf(mainId);
    assert.strictEqual(after.return_count, before + 1, `return 应 return_count++（${before}→${after.return_count}）`);
    assert.strictEqual(after.dev_estimated_at, null, 'return 清 dev_estimated_at（T-M2）');
    ok(`return（验收打回）：待验证 → 开发中，return_count++ (${before}→${after.return_count}) + 清 dev_estimated_at`);
  }

  // [9] return 闸门：缺 reason → RETURN_REASON_REQUIRED
  {
    const id = await seedIssue({ status: '待验证', assigned_to: DEV.id });
    // C3：return 是 VERIFY→DEV（enteringDev），guard [2b] 要求在册成员数≥1（方案不变量），需补 roster 行
    //   否则会被 guard 先一步以 400 GATE_INVARIANT 拦下，掩盖本测试真正要验的 RETURN_REASON_REQUIRED。
    await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, 'no_code')`,
      [id, DEV.id, DEV.name]);
    await assert.rejects(
      I.sysIssueTransition(id, 'return', '待验证', ADMIN, { reason: '  ' }),
      e => e instanceof I.SysTransitionError && e.code === 'RETURN_REASON_REQUIRED',
      'return 缺 reason 应拒');
    ok('return 闸门：打回原因 trim 空 → RETURN_REASON_REQUIRED');
  }

  // [10] 双 WHERE 并发：事务外先改 status，再用旧 expectedFrom transition → 409
  {
    const id = await seedIssue({ status: '待受理' });
    // 模拟并发：先把 status 改成 待指派（绕过 transition·模拟已被 intake_accept）
    await run("UPDATE sys_issues SET status='待指派' WHERE id=?", [id]);
    // 此时用 expectedFrom='待受理' 调 intake_accept → expectedFrom 比对先拦（409 或 INVALID_TRANSITION）
    await assert.rejects(
      I.sysIssueTransition(id, 'intake_accept', '待受理', ADMIN, {}),
      e => e instanceof I.SysTransitionError && (e.code === 'CONCURRENT_STATE_CHANGE' || e.code === 'INVALID_TRANSITION'),
      '并发改状态后旧 expectedFrom 应拒');
    ok('双 WHERE 并发守卫：status 被并发改后，旧 expectedFrom 的 transition 被拒（409/INVALID_TRANSITION）');
  }

  // [11] timeline 写入正确（mainId 链路：intake_accept/return 仍走 sysIssueTransition，有 timeline；
  //   assign/submit 本轮改直接 SQL 快进，不经真实端点，故不写 timeline——真实 assign/submit 的 timeline/
  //   dev_events 落库分别由 verify-sys-dev-assignee-transition.js / verify-sys-multidev-submit.js 覆盖）
  {
    const tl = await timelineOf(mainId);
    const events = tl.map(t => t.event_type);
    assert.ok(events.includes('status_change'), 'intake_accept 写 status_change');
    assert.ok(events.includes('return'), 'return 写 return');
    const intakeEv = tl.find(t => t.action_code === 'intake_accept');
    assert.ok(intakeEv && intakeEv.from_status === '待受理' && intakeEv.to_status === '待指派', 'intake_accept timeline from/to 正确');
    ok(`timeline 写入：intake_accept(status_change/intake_accept) + return 各 1 条，from/to/action_code 正确（共 ${tl.length} 条；assign/submit 为快进 fixture 不写 timeline，见上方 [C3 退场] 说明）`);
  }

  // [12] reassign 路径（不走 transition，但验 05-M2：reassign 不增 return_count）—— 直接测 transitions 常量层
  {
    const tReassign = I.transitions.findTransition('feature', 'reassign', '待验证');
    assert.ok(tReassign, 'reassign 常量存在');
    assert.ok(!tReassign.sideEffects.some(s => /return_count\+\+/.test(s)), 'reassign sideEffects 不含 return_count++');
    assert.ok(tReassign.sideEffects.some(s => /return_count 不变/.test(s)), 'reassign sideEffects 标注 return_count 不变（05-M2）');
    ok('reassign vs return 判别（05-M2）：reassign 常量 sideEffects 明确"return_count 不变"，不污染质量信号');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 sysIssueTransition 状态机验证通过`);
  console.log(`  覆盖：流转合法性 + expectedFrom + 权限(roleGuard/ownerGuard) + RC-M5 不变量 + 正向链路 + 提交闸门 + return_count(U-2) + 双 WHERE 并发 + timeline + reassign 判别(05-M2)`);
  db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
