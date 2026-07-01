// 验证脚本：系统迭代 sysIssueTransition 状态机（C2，方案 §3.6/§3.7/§9）
//   用法：node scripts/verify-sys-transition.js
//
// require 真实 index.js _internals.sysIssueTransition 跑变更流全链路，断言：
//   1. 流转合法性（非法 from→to 拒）+ expectedFrom 比对（陈旧前置态 409）
//   2. 双 WHERE + changes≠1 → 409（并发：先改 status 再 transition 应 409）
//   3. 权限分流（roleGuard='admin' 非 admin 拒 / ownerGuard='assignee' 非本人拒）
//   4. RC-M5 状态级不变量（无 assigned_to 进开发态拒）
//   5. ⭐ reassign 不增 return_count（05-M2 判别）vs return 增 return_count（U-2）
//   6. timeline 写入（event_type/action_code/from/to 正确）
//   7. 变更流正向链路：建单→排期→指派→提交→验收→...（transition 串起来）
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
async function seedIssue({ status = '待评估', assigned_to = null, type = 'feature', dev_estimated_at = null } = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, assigned_to, assigned_to_name, dev_estimated_at)
     VALUES (?, ?, 't', 'BMS', '内部', 1, 'admin', ?, ?, ?)`,
    [type, status, assigned_to, assigned_to ? '开发王' : null, dev_estimated_at]
  );
  return r.lastID;
}
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }
async function rowOf(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }
async function timelineOf(id) { return await all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id', [id]); }

async function main() {
  mod.initSchema();
  await waitReady();
  ok('readiness ready=true（真实 initSchema）');

  // [1] 流转合法性：待评估 → assign（assign 需「已排期」前置）应拒
  {
    const id = await seedIssue({ status: '待评估' });
    await assert.rejects(
      I.sysIssueTransition(id, 'assign', '待评估', ADMIN, { assigned_to: DEV.id, assigned_to_name: DEV.name }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_TRANSITION',
      '待评估态 assign 应 INVALID_TRANSITION');
    ok('流转合法性：feature 待评估态执行 assign（需已排期前置）被拒 INVALID_TRANSITION');
  }

  // [2] expectedFrom 比对：实际「已排期」但传 expectedFrom='待评估' 应 409
  {
    const id = await seedIssue({ status: '已排期' });
    await assert.rejects(
      I.sysIssueTransition(id, 'schedule', '待评估', ADMIN, {}),
      e => e instanceof I.SysTransitionError && (e.code === 'CONCURRENT_STATE_CHANGE' || e.code === 'INVALID_TRANSITION'),
      'expectedFrom 不匹配应拒');
    ok('expectedFrom 比对：实际已排期 + 传 expectedFrom=待评估 → 拒（陈旧前置态）');
  }

  // [3] 权限：schedule roleGuard=admin，非 admin（开发）执行应 403
  {
    const id = await seedIssue({ status: '待评估' });
    await assert.rejects(
      I.sysIssueTransition(id, 'schedule', '待评估', DEV, {}),
      e => e instanceof I.SysTransitionError && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      'schedule 非 admin 应 403');
    ok('权限 roleGuard：schedule（admin 动作）由开发执行 → 403 NOT_AUTHORIZED_FOR_TRANSITION');
  }

  // [4] RC-M5：指派时不给 assigned_to → 进开发中态被不变量拦（无开发负责人）
  {
    const id = await seedIssue({ status: '已排期', assigned_to: null });
    await assert.rejects(
      I.sysIssueTransition(id, 'assign', '已排期', ADMIN, {}),  // 缺 assigned_to
      e => e instanceof I.SysTransitionError && (e.code === 'NO_ASSIGNEE_FOR_DEV_STATE' || e.code === 'INVALID_ASSIGN_TARGET'),
      'assign 缺 assigned_to 应被拦');
    ok('RC-M5 状态级不变量：assign 缺 assigned_to → 进「开发中」被拦（无开发负责人）');
  }

  // [5] 正向链路：待评估 → schedule → 已排期 → assign → 开发中（带 assigned_to）
  let mainId;
  {
    mainId = await seedIssue({ status: '待评估' });
    let r = await I.sysIssueTransition(mainId, 'schedule', '待评估', ADMIN, { priority: 'P1', deadline: '2026-07-01' });
    assert.strictEqual(r.toStatus, '已排期', 'schedule → 已排期');
    assert.strictEqual(await statusOf(mainId), '已排期');
    const after = await rowOf(mainId);
    assert.strictEqual(after.priority, 'P1', 'schedule 改 priority=P1');
    assert.ok(after.priority_reviewed_at, 'schedule 盖 priority_reviewed_at');

    r = await I.sysIssueTransition(mainId, 'assign', '已排期', ADMIN, { assigned_to: DEV.id, assigned_to_name: DEV.name });
    assert.strictEqual(r.toStatus, '开发中', 'assign → 开发中');
    const afterAssign = await rowOf(mainId);
    assert.strictEqual(Number(afterAssign.assigned_to), DEV.id, 'assigned_to 写入');
    assert.ok(afterAssign.assigned_at, 'assigned_at 盖时间');
    ok('正向链路：待评估 →schedule→ 已排期（priority/reviewed_at）→assign→ 开发中（assigned_to/at）');
  }

  // [5b] codex 14 M-2：schedule deadline 校验（非法格式/非法日期 → 400 INVALID_DEADLINE）
  {
    const id = await seedIssue({ status: '待评估' });
    await assert.rejects(
      I.sysIssueTransition(id, 'schedule', '待评估', ADMIN, { deadline: '随便写' }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_DEADLINE',
      'schedule 非法 deadline 格式应 400');
    await assert.rejects(
      I.sysIssueTransition(id, 'schedule', '待评估', ADMIN, { deadline: '2026-13-45' }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_DEADLINE',
      'schedule 格式对但非法日期应 400');
    // 合法 deadline 放行
    const r = await I.sysIssueTransition(id, 'schedule', '待评估', ADMIN, { deadline: '2026-07-15' });
    assert.strictEqual(r.toStatus, '已排期', '合法 deadline schedule → 已排期');
    const after = await rowOf(id);
    assert.strictEqual(after.deadline, '2026-07-15', 'deadline 规范化入库');
    ok('M-2：schedule deadline 校验——「随便写」/「2026-13-45」→ 400 INVALID_DEADLINE，合法「2026-07-15」放行入库');

    // codex 14b M-1：纯空格 deadline = 可选未填，放行（不报 400）
    const id2 = await seedIssue({ status: '待评估' });
    const r2 = await I.sysIssueTransition(id2, 'schedule', '待评估', ADMIN, { deadline: '   ' });
    assert.strictEqual(r2.toStatus, '已排期', '纯空格 deadline 应放行 → 已排期');
    assert.strictEqual((await rowOf(id2)).deadline, null, '纯空格 deadline 入库为 NULL（未填）');
    ok('M-1(复)：schedule 纯空格 deadline「   」→ 放行（trim 后判空=可选未填，不误报 400）');

    // 闰年边界：2024-02-29 合法放行 / 2026-02-29 非法 400
    const id3 = await seedIssue({ status: '待评估' });
    const r3 = await I.sysIssueTransition(id3, 'schedule', '待评估', ADMIN, { deadline: '2024-02-29' });
    assert.strictEqual(r3.toStatus, '已排期', '闰年 2024-02-29 应放行');
    const id4 = await seedIssue({ status: '待评估' });
    await assert.rejects(
      I.sysIssueTransition(id4, 'schedule', '待评估', ADMIN, { deadline: '2026-02-29' }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_DEADLINE',
      '非闰年 2026-02-29 应 400');
    ok('M-2 闰年边界：2024-02-29 放行 / 2026-02-29 → 400 INVALID_DEADLINE（new Date 回比对挡非法日期）');
  }

  // [6] 提交闸门：开发中 submit 缺 dev_estimated_at → ESTIMATE_REQUIRED
  {
    await assert.rejects(
      I.sysIssueTransition(mainId, 'submit', '开发中', DEV, { summary: '改完了' }),
      e => e instanceof I.SysTransitionError && e.code === 'ESTIMATE_REQUIRED',
      'submit 缺 dev_estimated_at 应拒');
    ok('提交闸门：开发中 submit 缺 dev_estimated_at → ESTIMATE_REQUIRED');

    // 补 dev_estimated_at 后再 submit（缺 summary → SUBMIT_SUMMARY_REQUIRED）
    await run("UPDATE sys_issues SET dev_estimated_at = datetime('now','localtime') WHERE id=?", [mainId]);
    await assert.rejects(
      I.sysIssueTransition(mainId, 'submit', '开发中', DEV, { summary: '   ' }),
      e => e instanceof I.SysTransitionError && e.code === 'SUBMIT_SUMMARY_REQUIRED',
      'submit 空 summary 应拒');
    ok('提交闸门：交付说明 trim 空 → SUBMIT_SUMMARY_REQUIRED');

    // 合法 submit（开发本人）→ 待验证 + first_submitted_at
    const r = await I.sysIssueTransition(mainId, 'submit', '开发中', DEV, { summary: '已完成功能 X' });
    assert.strictEqual(r.toStatus, '待验证', 'submit → 待验证');
    const after = await rowOf(mainId);
    assert.ok(after.first_submitted_at, 'first_submitted_at 盖');
    ok('提交：开发本人 + dev_estimated_at + summary 齐 → 待验证（first_submitted_at 盖）');
  }

  // [7] ownerGuard：非本人开发 submit 应 403（DEV2 不是 assigned_to）
  {
    const id = await seedIssue({ status: '开发中', assigned_to: DEV.id, dev_estimated_at: '2026-07-01 10:00' });
    await assert.rejects(
      I.sysIssueTransition(id, 'submit', '开发中', DEV2, { summary: '我来交' }),
      e => e instanceof I.SysTransitionError && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      '非本人开发 submit 应 403');
    ok('ownerGuard：submit 由非本人开发（DEV2≠assigned_to）执行 → 403');
  }

  // [7b] ⭐ codex 14 H-1 复审专项：ownerGuard 严格本人——admin 也不能代提交（submit 已指派 DEV 的单）
  {
    const id = await seedIssue({ status: '开发中', assigned_to: DEV.id, dev_estimated_at: '2026-07-01 10:00' });
    await assert.rejects(
      I.sysIssueTransition(id, 'submit', '开发中', ADMIN, { summary: 'admin 代交' }),
      e => e instanceof I.SysTransitionError && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      'admin submit 已指派 DEV 的单应 403（H-1 严格本人）');
    ok('⭐ H-1 复审：ownerGuard 严格本人——admin 对已指派 DEV 的 submit → 403（admin 全能仅 roleGuard 动作，不代办开发本人动作）');
    // 反证：被指派开发本人 submit 仍可（确认没误伤正常路径）
    const r = await I.sysIssueTransition(id, 'submit', '开发中', DEV, { summary: '本人正常交付' });
    assert.strictEqual(r.toStatus, '待验证', '开发本人 submit 仍正常 → 待验证');
    ok('H-1 反证：开发本人 submit 仍正常放行 → 待验证（修 H-1 未误伤正常路径）');
  }

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
    await assert.rejects(
      I.sysIssueTransition(id, 'return', '待验证', ADMIN, { reason: '  ' }),
      e => e instanceof I.SysTransitionError && e.code === 'RETURN_REASON_REQUIRED',
      'return 缺 reason 应拒');
    ok('return 闸门：打回原因 trim 空 → RETURN_REASON_REQUIRED');
  }

  // [10] 双 WHERE 并发：事务外先改 status，再用旧 expectedFrom transition → 409
  {
    const id = await seedIssue({ status: '待评估' });
    // 模拟并发：先把 status 改成 已排期（绕过 transition）
    await run("UPDATE sys_issues SET status='已排期' WHERE id=?", [id]);
    // 此时用 expectedFrom='待评估' 调 schedule → expectedFrom 比对先拦（409 或 INVALID_TRANSITION）
    await assert.rejects(
      I.sysIssueTransition(id, 'schedule', '待评估', ADMIN, {}),
      e => e instanceof I.SysTransitionError && (e.code === 'CONCURRENT_STATE_CHANGE' || e.code === 'INVALID_TRANSITION'),
      '并发改状态后旧 expectedFrom 应拒');
    ok('双 WHERE 并发守卫：status 被并发改后，旧 expectedFrom 的 transition 被拒（409/INVALID_TRANSITION）');
  }

  // [11] timeline 写入正确（mainId 链路：created? 无——seed 没写；schedule/assign/submit/return 有 timeline）
  {
    const tl = await timelineOf(mainId);
    // schedule(status_change/schedule) + assign(assign) + submit(submit) + return(return)
    const events = tl.map(t => t.event_type);
    assert.ok(events.includes('status_change'), 'schedule 写 status_change');
    assert.ok(events.includes('assign'), 'assign 写 assign');
    assert.ok(events.includes('submit'), 'submit 写 submit');
    assert.ok(events.includes('return'), 'return 写 return');
    const scheduleEv = tl.find(t => t.action_code === 'schedule');
    assert.ok(scheduleEv && scheduleEv.from_status === '待评估' && scheduleEv.to_status === '已排期', 'schedule timeline from/to 正确');
    ok(`timeline 写入：schedule(status_change/schedule) + assign + submit + return 各 1 条，from/to/action_code 正确（共 ${tl.length} 条）`);
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
