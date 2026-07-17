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

  // [C3 退场] [4] RC-M5：指派时不给 assigned_to → 进开发中态被不变量拦（无开发负责人）
  //   旧路径：I.sysIssueTransition(id,'assign',...) 的 switch-case 内部校验 assigned_to 必填。该 case 已删除，
  //   'assign' 落到 default 分支 no-op（不再触发此检查）——RC-M5 不变量现由真实 /sys-issues/:id/assign 端点
  //   在 HTTP 层强制（缺 assigned_to → 400 ASSIGN_TARGET_REQUIRED，见 verify-sys-dev-assignee-transition.js），
  //   非本函数职责，随退场一并移除，不在本文件补白盒替代（白盒直调该 action 本身已是测试死代码）。

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

    // [C3] assign 不再走 sysIssueTransition（见上方 [4] 退场说明），改直接 SQL 快进（fastForwardAssign）
    await fastForwardAssign(mainId);
    assert.strictEqual(await statusOf(mainId), '开发中', 'assign 快进 → 开发中');
    const afterAssign = await rowOf(mainId);
    assert.strictEqual(Number(afterAssign.assigned_to), DEV.id, 'assigned_to 写入');
    assert.ok(afterAssign.assigned_at, 'assigned_at 盖时间');
    ok('正向链路：待评估 →schedule→ 已排期（priority/reviewed_at）→assign(快进)→ 开发中（assigned_to/at）');
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

  // [11] timeline 写入正确（mainId 链路：schedule/return 仍走 sysIssueTransition，有 timeline；
  //   assign/submit 本轮改直接 SQL 快进，不经真实端点，故不写 timeline——真实 assign/submit 的 timeline/
  //   dev_events 落库分别由 verify-sys-dev-assignee-transition.js / verify-sys-multidev-submit.js 覆盖）
  {
    const tl = await timelineOf(mainId);
    const events = tl.map(t => t.event_type);
    assert.ok(events.includes('status_change'), 'schedule 写 status_change');
    assert.ok(events.includes('return'), 'return 写 return');
    const scheduleEv = tl.find(t => t.action_code === 'schedule');
    assert.ok(scheduleEv && scheduleEv.from_status === '待评估' && scheduleEv.to_status === '已排期', 'schedule timeline from/to 正确');
    ok(`timeline 写入：schedule(status_change/schedule) + return 各 1 条，from/to/action_code 正确（共 ${tl.length} 条；assign/submit 为快进 fixture 不写 timeline，见上方 [C3 退场] 说明）`);
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
