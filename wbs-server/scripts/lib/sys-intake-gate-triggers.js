// 角色权限重构 C0：受理门触发器的测试辅助（摘除 / 重建 / 作用域执行）。
//   背景：C0 在 sys_issues 上建了 intake_required 恒 1 的拒绝型触发器（BEFORE INSERT/UPDATE，RAISE ABORT）。
//   少数 verify 需要**故意造 intake_required=0 的脏数据**——它们测的正是"脏数据存在时内层防线仍拦得住"
//   （引擎 [3.5] fail-closed）或"迁移能把存量归一"。这类夹具必须显式摘除 DB 约束，
//   而**不是**把生产约束调弱去迁就夹具（codex C0 三轮审 HIGH：不以测试适配成本决定生产约束强度）。
//
//   DDL 一律从被测模块的 _internals 取，不在测试里手抄——防两处漂移。
//
//   用法：
//     const gate = require('./lib/sys-intake-gate-triggers')(run, I);
//     await gate.withoutTriggers(async () => {
//       await run('UPDATE sys_issues SET intake_required=0 WHERE id=?', [id]);   // 造脏
//       ...断言...
//     });   // 无论内部是否抛错，退出时必定重建触发器
'use strict';

module.exports = function makeIntakeGateTriggerHelper(run, I) {
  if (!I || !I.SYS_INTAKE_GATE_TRIGGER_NAMES || !I.SYS_INTAKE_GATE_TRIGGERS_SQL) {
    throw new Error('sys-intake-gate-triggers: _internals 缺少 SYS_INTAKE_GATE_TRIGGER_NAMES / SYS_INTAKE_GATE_TRIGGERS_SQL');
  }
  const drop = async () => {
    for (const n of I.SYS_INTAKE_GATE_TRIGGER_NAMES) await run(`DROP TRIGGER IF EXISTS ${n}`);
  };
  // ⚠️ 逐个尝试 + 聚合错误（codex C0 四轮审 MED-1）：原实现遇首个 CREATE 失败即中止，
  //   会留下"另一个触发器未恢复"的半裸状态，与"退出必定重建"的承诺不符。
  const restore = async () => {
    const errs = [];
    for (const sql of I.SYS_INTAKE_GATE_TRIGGERS_SQL) {
      try { await run(sql); } catch (e) { errs.push(e && e.message); }
    }
    // 存在性证据取自 `CREATE TRIGGER IF NOT EXISTS` 成功返回本身（已存在→幂等；不存在→本次创建），
    //   **不查 sqlite_master**（helper 只持有 run，不引入 all 依赖）。
    //   ⚠️ 已知局限（六轮审 LOW·如实记录）：该推断**认名不认定义**——库里若存在同名但定义漂移的旧触发器，
    //     IF NOT EXISTS 会静默保留它。本 helper 只服务测试夹具（同进程内刚由权威 DDL 建的触发器，
    //     不存在漂移），故接受；**生产侧的恢复在 index.js 的 finally [F]**，那里有 all 可用且显式查
    //     sqlite_master 校验名称齐全。
    if (errs.length) {
      throw new Error(`受理门触发器恢复失败（${errs.length}/${I.SYS_INTAKE_GATE_TRIGGERS_SQL.length} 条 DDL 出错）：${errs.join(' | ')}`);
    }
  };
  // 在"无触发器"作用域内执行 fn。
  //   ⚠️ drop 也在 try 覆盖范围内（codex 四轮审 MED-1）：drop 部分成功后抛错同样需要 restore，
  //     否则会留下"一个摘了一个没摘"的半裸状态。
  const withoutTriggers = async (fn) => {
    try {
      await drop();
      return await fn();
    } finally {
      await restore();
    }
  };
  return { drop, restore, withoutTriggers };
};
