// 验证脚本：系统迭代 meta + 状态机常量枚举同步（C2，方案 §3.7 / 12-M4 / 05-H1）
//   用法：node scripts/verify-sys-meta.js
//
// 核心断言（require 真实 transitions.js + index.js initSchema 取 DDL CHECK 枚举）：
//   1. buildMeta 结构完整（statusLabels / typeFlows / actions / bizSystems / initialStatusByType）
//   2. meta 不暴露内部 guard（M-4：typeFlows 不含 roleGuard/ownerGuard/sideEffects/notifyAfterCommit）
//   3. ⭐ 枚举同步（12-M4 + 05-H1）：transitions 常量的 timelineEvent / actionCode ⊆ DDL CHECK 枚举，无幽灵值
//   4. 变更流类型流完整（feature/improvement 各自独立数组·C4 起已拆分，非共用同一份，含 create→...→close 全动作）
//   5. findTransition / resolveToStatus 行为正确（含 reassign to=null 动态解析·M3/91 号审、'*' 通配、to=null 旁路）
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const T = require('../routes/sys-iteration/transitions');
const SF = require('../routes/sys-iteration/status-families');   // [6] MED-2·92 号审：reassign.from 写读同源核对用

// 取真实 DDL CHECK 枚举（从 index.js initSchema 建表，PRAGMA 读不到 CHECK，改从 sqlite_master.sql 文本解析）
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
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (mod._internals.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (mod._internals.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(mod._internals.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 从 sqlite_master.sql 解析某表某列 CHECK IN (...) 的枚举值集合
function parseCheckEnum(ddlSql, col) {
  // 匹配 col ... CHECK (... col IN ('a','b',...)) 或 CHECK (event_type IN (...))
  const re = new RegExp(`${col}\\s+IN\\s*\\(([^)]*)\\)`, 'i');
  const m = ddlSql.match(re);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

async function main() {
  mod.initSchema();
  await waitReady();

  // [1] buildMeta 结构完整
  const meta = T.buildMeta();
  for (const k of ['statusLabels', 'typeFlows', 'actions', 'bizSystems', 'initialStatusesByType']) {
    assert.ok(meta[k] !== undefined, `meta 缺字段 ${k}`);
  }
  assert.deepStrictEqual(meta.bizSystems, ['BMS', 'HRD', 'OA', '智数协同', '电子签', '其他'], 'bizSystems 应为 BIZ_SYSTEMS');
  // 受理排期改造 §9：initialStatusesByType 新形状（{with_intake,without_intake} 每 type）——建单落态两分支权威。
  assert.strictEqual(meta.initialStatusesByType.feature.with_intake, '待受理', 'feature 受理模式初始态=待受理');
  assert.strictEqual(meta.initialStatusesByType.feature.without_intake, '待指派', 'feature 无受理初始态=待指派');
  assert.strictEqual(meta.initialStatusesByType.bug.without_intake, '待处理', 'bug 无受理初始态=待处理');
  ok('buildMeta 结构完整（statusLabels/typeFlows/actions/bizSystems/initialStatusesByType 新形状）');

  // [2] M-4：typeFlows 不暴露内部 guard
  for (const type of Object.keys(meta.typeFlows)) {
    for (const tf of meta.typeFlows[type]) {
      for (const leak of ['roleGuard', 'ownerGuard', 'sideEffects', 'notifyAfterCommit', 'timelineEvent', 'actionCode']) {
        assert.ok(!(leak in tf), `typeFlows[${type}] 泄露内部字段 ${leak}`);
      }
      // 只暴露 action/from/to/requiredPayload/kind（kind = F2b codex 17 M-1 旁路标记）
      //   + 受理排期改造 §9：动态目标标记 dynamicTarget/createdIssueDynamicTarget/targetEntity（消费者据此知"目标 resolver 解析·不可静态读 to"）。
      //   + [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点1·C4] possibleTargets（feature submit 的 w_gate
      //   动态解析枚举全部可能落点，C0 §F-1 提醒的白名单 spread 键，补白名单同批必须补这里，否则"新增了
      //   一个合法字段"会被本条断言误判成"泄露"）。
      for (const k of Object.keys(tf)) {
        assert.ok(['action', 'from', 'to', 'requiredPayload', 'kind', 'dynamicTarget', 'createdIssueDynamicTarget', 'targetEntity', 'possibleTargets'].includes(k), `typeFlows[${type}] 含非预期字段 ${k}`);
      }
    }
  }
  ok('M-4：typeFlows 仅暴露 action/from/to/requiredPayload，不泄露 roleGuard/ownerGuard/sideEffects/notifyAfterCommit/timelineEvent/actionCode');

  // [2b] [codex 272 号 L-2 契约锁，S12 双路审查 Opus-3 MED 收口] submit 条目的 requiredPayload 恰为
  //   ['self_tested','test_env_deployed']（feature/improvement/bug 三 type 各查一次）。
  //   ⚠️ 此前注释声称"feature 与 bug 两 type 各查一次——feature/improvement 共享同一份
  //   CHANGE_FLOW_TRANSITIONS 数组引用，验 feature 即等价验 improvement，故不重复抽查"已失实：
  //   工期对接测试与风险等级拆分方案 v1.1·C4 把该常量拆成 FEATURE_FLOW_TRANSITIONS/
  //   IMPROVEMENT_FLOW_TRANSITIONS 两个独立数组（transitions.js，为了让 feature 专属能力如对接测试段
  //   不静默泄漏到 improvement——⚠️ risk_level 必填曾是本注释举的第二个例子，用户拍板批1改造B
  //   （2026-08-06）后已不成立：risk_level 必填改为 feature+improvement 共用，仅"待对接测试"段仍
  //   feature 独有）——CHANGE_FLOW_TRANSITIONS 这个标识符本身已不存在，
  //   两个 type 现在是各自独立的对象，改一个不再自动带动另一个改，此前"验 feature 即覆盖 improvement"
  //   的断言强度承诺自 C4 起已经落空（只是没人回头补，属于 S12 双路审查抓出的真实契约断言失守）。
  //   本条锁的是"形状"（deepStrictEqual 精确匹配，非 includes 子集判断）——未来若有人往
  //   requiredPayload 里悄悄加/删/改键名而不同步更新 validateSubmitBody/verify-sys-multidev-submit
  //   的表驱动矩阵，本条会立刻炸，而不是等到生产真实提交时才发现前端/文档描述的必填字段与后端实际
  //   校验的字段对不上。
  {
    const findSubmit = (type) => (meta.typeFlows[type] || []).find(tf => tf.action === 'submit');
    const featureSubmit = findSubmit('feature');
    const improvementSubmit = findSubmit('improvement');
    const bugSubmit = findSubmit('bug');
    assert.ok(featureSubmit, 'L-2：meta.typeFlows.feature 应含 action=submit 条目');
    assert.ok(improvementSubmit, 'L-2：meta.typeFlows.improvement 应含 action=submit 条目');
    assert.ok(bugSubmit, 'L-2：meta.typeFlows.bug 应含 action=submit 条目');
    assert.deepStrictEqual(featureSubmit.requiredPayload, ['self_tested', 'test_env_deployed'], `L-2：feature submit requiredPayload 应恰为 ['self_tested','test_env_deployed']，实得 ${JSON.stringify(featureSubmit.requiredPayload)}`);
    assert.deepStrictEqual(improvementSubmit.requiredPayload, ['self_tested', 'test_env_deployed'], `L-2：improvement submit requiredPayload 应恰为 ['self_tested','test_env_deployed']，实得 ${JSON.stringify(improvementSubmit.requiredPayload)}`);
    assert.deepStrictEqual(bugSubmit.requiredPayload, ['self_tested', 'test_env_deployed'], `L-2：bug submit requiredPayload 应恰为 ['self_tested','test_env_deployed']，实得 ${JSON.stringify(bugSubmit.requiredPayload)}`);
    ok("L-2：submit 条目 requiredPayload 契约锁——feature/improvement/bug 三 type 均恰为 ['self_tested','test_env_deployed']（S12-Opus-3 收口：三 type 各自独立抽查，不再依赖已失效的「验一个带动另一个」假设）");
  }

  // [3] ⭐ 枚举同步（12-M4 + 05-H1）：transitions 的 timelineEvent/actionCode ⊆ DDL CHECK
  const timelineDdl = (await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issue_timeline'")).sql;
  const ddlEventTypes = parseCheckEnum(timelineDdl, 'event_type');
  assert.ok(Array.isArray(ddlEventTypes) && ddlEventTypes.length > 0, '无法解析 sys_issue_timeline event_type CHECK 枚举');
  ok(`DDL event_type CHECK 枚举解析成功（${ddlEventTypes.length} 个：${ddlEventTypes.join('/')}）`);

  // 收集所有 transition 用到的 timelineEvent + actionCode + roleGuard
  const usedEvents = new Set();
  const usedActionCodes = new Set();
  const usedRoleGuards = new Set();
  for (const type of Object.keys(T.TRANSITIONS)) {
    for (const t of T.transitionsForType(type)) {
      if (t.timelineEvent) usedEvents.add(t.timelineEvent);
      if (t.actionCode) usedActionCodes.add(t.actionCode);
      if (t.roleGuard) usedRoleGuards.add(t.roleGuard);   // 空/undefined 合法（靠 ownerGuard）·只收非空
    }
  }
  // 受理排期改造 C2（codex MED-1）：所有非空 roleGuard 必须 ∈ KNOWN_ROLE_GUARDS——引擎对未知 roleGuard 默认拒绝
  //   （500 UNKNOWN_ROLE_GUARD·fail-closed），此断言防 transition 新增/拼错未实现的 guard 值（引擎会拒→动作全挂）。
  const guardLeak = [...usedRoleGuards].filter(g => !T.KNOWN_ROLE_GUARDS.has(g));
  assert.strictEqual(guardLeak.length, 0, `transitions 用了引擎未实现的 roleGuard（引擎会 500 UNKNOWN_ROLE_GUARD 拒绝）：${guardLeak.join(',')}`);
  ok(`⭐ roleGuard 枚举同步（C2·MED-1）：transitions 全部非空 roleGuard（${[...usedRoleGuards].join('/')}）⊆ KNOWN_ROLE_GUARDS（引擎默认拒绝未知 guard·防拼错/漏实现静默放行）`);
  // 每个 timelineEvent 必须 ∈ DDL event_type 枚举（防 05-H1 那类 CHECK 冲突）
  const eventLeak = [...usedEvents].filter(e => !ddlEventTypes.includes(e));
  assert.strictEqual(eventLeak.length, 0, `transitions 用了 DDL CHECK 没有的 event_type（会触发 CHECK 失败）：${eventLeak.join(',')}`);
  // LOW（92 号审）：reassign 条目 timelineEvent 已改 null（成员动作只写 dev_events，不进 timeline，见
  //   transitions.js 同批改动）——DDL CHECK 仍保留 'reassign' 值（供 C2 前的历史 timeline 行渲染，非本次删除
  //   范围），但它不再出现在 usedEvents 里，故提示语不再点名 05-H1。
  ok(`枚举同步：transitions 全部 timelineEvent（${[...usedEvents].join('/')}）⊆ DDL event_type CHECK（无 CHECK 冲突；reassign 已随 v2.9 改 timelineEvent=null，DDL 枚举值仅保留供历史行渲染）`);

  // actionCode 是 status_change 的细分（RC-L1），不入 DDL CHECK（DDL 无 action_code CHECK），仅自洽检查非空字符串
  for (const ac of usedActionCodes) {
    assert.ok(typeof ac === 'string' && ac.length > 0, `actionCode 应为非空字符串：${ac}`);
  }
  ok(`actionCode 自洽（${[...usedActionCodes].join('/')}，RC-L1 status_change 细分动作）`);

  // [4] 变更流类型流完整（feature/improvement 分裂后：不再严格相等，改为"feature = improvement + 待对接测试"）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.1-1·C4·C0 §F-2 收口] C1 阶段起 feature/improvement 已拆分
  //   独立数组（FEATURE_FLOW_STATUSES/IMPROVEMENT_FLOW_TRANSITIONS，transitions.js），不再共用同一份
  //   常量引用——原"严格相等"断言的前提（"共用变更流"）已不成立。C4 落地「待对接测试」后两者唯一合法
  //   差异=该状态，本断言反向改写为"改回 diff 后严格相等"，比单纯放宽成"包含关系"更精确：既允许这一个
  //   已知差异，又不放过任何其他意外分叉（例如未来谁手滑往 improvement 也加了个新态）。
  const featureStatusesWithoutLiaisonTest = meta.statusLabels.feature.filter(s => s !== '待对接测试');
  assert.deepStrictEqual(featureStatusesWithoutLiaisonTest, meta.statusLabels.improvement, 'feature 状态集去掉「待对接测试」后应与 improvement 严格相等（拆分后唯一合法差异=对接测试段）');
  assert.ok(meta.statusLabels.feature.includes('待对接测试'), 'feature 状态集应含「待对接测试」');
  assert.ok(!meta.statusLabels.improvement.includes('待对接测试'), 'improvement 状态集不应含「待对接测试」（仅 feature 独有）');
  const featureActions = meta.typeFlows.feature.map(t => t.action);
  // 受理排期改造 §4.2：schedule 退场（从必含动作删）+ 新增受理门动作（intake_accept/intake_return/resubmit_intake/change_intake_mode 等）。
  for (const a of ['create', 'assign', 'reassign', 'estimate', 'submit', 'accept', 'return', 'close',
    'intake_accept', 'intake_return', 'resubmit_intake', 'request_tech_consult', 'edit_in_revision', 'change_intake_mode', 'set_scheduled_start']) {
    assert.ok(featureActions.includes(a), `变更流缺动作 ${a}`);
  }
  assert.ok(!featureActions.includes('schedule'), '变更流 schedule 已退场（typeFlows 不应含）');
  // [C3 退场] publish 条目随上线体统一重构删除（legacy /sys-releases/:id/publish 全类型 409，唯一合法
  //   发布入口收窄为 /sys-releases/:id/execute，不再是 sysIssueTransition 引擎驱动的逐单动作）。
  assert.ok(!featureActions.includes('publish'), '变更流 publish 已退场（typeFlows 不应含，C3 收窄）');
  ok(`变更流类型流完整（feature/improvement 共用·schedule/publish 退场·含受理门 intake_accept/return/resubmit/change_intake_mode + set_scheduled_start ${featureActions.length} 动作）`);

  // [4b] F2a §3.2：feature/improvement 全禁 scope_change（评估环节"禁开发态调需求"）——typeFlows 彻底移除该动作
  assert.ok(!featureActions.includes('scope_change'), 'feature typeFlows 不应含 scope_change（F2a 已移除）');
  const imprActions = meta.typeFlows.improvement.map(t => t.action);
  assert.ok(!imprActions.includes('scope_change'), 'improvement typeFlows 不应含 scope_change（F2a 已移除）');
  // 移除后 findTransition 对 feature/improvement 的 scope_change 一律返 null（端点层另有 SCOPE_CHANGE_DISABLED 守卫）
  assert.strictEqual(T.findTransition('feature', 'scope_change', '开发中'), null, 'feature scope_change 已无 transition（findTransition 返 null）');
  assert.strictEqual(T.findTransition('improvement', 'scope_change', '待验证'), null, 'improvement scope_change 已无 transition');
  // derive 仍在：需求变化统一走派生新单 / 作废重开（替代 scope_change 的出口）
  assert.ok(featureActions.includes('derive'), 'feature 仍含 derive（scope_change 移除后需求变化的出口）');
  ok('[F2a §3.2] feature/improvement typeFlows 移除 scope_change（findTransition 返 null）+ 保留 derive 作需求变化出口');

  // [4c] M-2（codex 19）：reactivate 不清评估字段依赖「无 开发后态 → 已拒绝 回路」不变量——固化为转移图断言
  //   遍历所有 transition，断言 to='已拒绝' 的 from 不含开发后态（'*' 通配也算含，因它包含开发后态）；
  //   未来 bug/config 流若新增「开发中→已拒绝」类路径，本断言立即报警（提示须给 reactivate/issue_reject 加清字段）。
  const DEV_POST_STATES = ['开发中', '待验证', '待上线', '已上线', '已关闭'];
  for (const type of Object.keys(T.TRANSITIONS)) {
    for (const tr of T.transitionsForType(type)) {
      const toStates = (typeof tr.to === 'string') ? [tr.to]
        : (tr.to && typeof tr.to === 'object') ? Object.values(tr.to) : [];
      if (!toStates.includes('已拒绝')) continue;
      const froms = tr.from === '*' ? ['*'] : (Array.isArray(tr.from) ? tr.from : []);
      const leak = froms.includes('*') ? ['*'] : froms.filter(f => DEV_POST_STATES.includes(f));
      assert.strictEqual(leak.length, 0, `[${type}] transition「${tr.action}」to=已拒绝 的 from 含开发后态(${leak.join(',')})——破坏 reactivate 不清评估前提（残留跨轮带入），须给 reactivate/issue_reject 加 SYS_CLEAR_FEASIBILITY_FIELDS_SQL`);
    }
  }
  ok('[4c] 转移图不变量：无「开发后态→已拒绝」transition（固化 reactivate 不清评估前提，codex 19 M-2）');

  // [4d] F2b codex 17 M-1 + ultracode 对抗审：kind 全集断言（防 resume 类「to=null 但实改 status」误标）
  //   side_effect = 真正不改 status 的旁路动作（路由专用端点）；transition = 改 status（含 resume：to=null 但动态解析目标态）。
  const KIND_EXPECT = {
    estimate: 'side_effect', feasibility: 'side_effect', blocked: 'side_effect', unblock: 'side_effect', derive: 'side_effect', scope_change: 'side_effect',
    // 受理排期改造 §4.4 断言3：request_tech_consult/edit_in_revision/set_scheduled_start 真旁路（to=null 不改 status）=side_effect；
    //   change_intake_mode/reactivate 带 dynamicTarget（动态解析 status）+ intake_accept/return/resubmit（静态改态）=transition。
    request_tech_consult: 'side_effect', edit_in_revision: 'side_effect', set_scheduled_start: 'side_effect',
    // ⭐ 角色权限重构 C2.5 撤销（v2.1）：pre_discuss_pass 随预沟通段整体撤销，条目已删（不再是合法 action，
    //   不应出现在任何 typeFlows 里；若仍出现，[4d] 循环会因下方缺键而当场红灯）。
    intake_accept: 'transition', intake_return: 'transition', resubmit_intake: 'transition', change_intake_mode: 'transition',
    create: 'transition', schedule: 'transition', assign: 'transition', reassign: 'transition',
    submit: 'transition', accept: 'transition', return: 'transition', publish: 'transition',
    close: 'transition', hold: 'transition', resume: 'transition', reactivate: 'transition',
    issue_reject: 'transition', void: 'transition', reopen: 'transition',
    // [v1.6 退场，通知改造 C3b] set_release_flag / confirm-online-norelease 两条已随 BUG_FLOW_TRANSITIONS
    //   移除（不再出现在任何 typeFlows 里，故本表也删对应条目——留着不影响正确性但会误导读者以为还在用）。
    //   新增上线编排两动作：assign-release-dev 不改 status（真旁路，SIDE_EFFECT_ACTIONS 已收）/
    //   execute-release 真改 status 为已上线（默认 transition 分类）。
    'assign-release-dev': 'side_effect', 'execute-release': 'transition',
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5·C4 新增] 对接测试两条边——均真改 status（待对接测试
    //   ↔待验证/开发中），非旁路，kind=transition。
    liaison_test_pass: 'transition', liaison_test_return: 'transition',
  };
  for (const type of Object.keys(meta.typeFlows)) {   // codex 20 L-2：遍历所有 type（非仅 feature），防 config/bug 流动作差异漏检
    for (const tf of meta.typeFlows[type]) {
      assert.ok(KIND_EXPECT[tf.action] !== undefined, `[4d] ${type} 动作 ${tf.action} 未在 kind 期望表（新增动作须补 KIND_EXPECT + 核对 to 语义）`);
      assert.strictEqual(tf.kind, KIND_EXPECT[tf.action], `[4d] ${type} 动作 ${tf.action} kind 应为 ${KIND_EXPECT[tf.action]}（实 ${tf.kind}）`);
    }
  }
  // ⭐ resume 专项（ultracode 对抗审）：to=null 但实改 status（动态解析），必须 transition 不能 side_effect（白名单 SIDE_EFFECT_ACTIONS 不含 resume）
  assert.strictEqual(meta.typeFlows.feature.find(t => t.action === 'resume').kind, 'transition', 'resume 必须 kind=transition（to=null 是动态解析 status 非旁路，防误标 side_effect）');
  ok('[4d] kind 全集断言：6 旁路 side_effect + 其余 transition（含 resume 专项=transition 防 to=null 误标，codex 17 M-1 + ultracode 对抗审）');

  // [5] findTransition / resolveToStatus 行为
  // 5a. assign：待指派 → 开发中（受理排期改造：from 由已排期改待指派）
  const tAssign = T.findTransition('feature', 'assign', '待指派');
  assert.ok(tAssign && T.resolveToStatus(tAssign, '待指派') === '开发中', 'assign 待指派→开发中');
  // 5a2. 受理排期改造 §5：intake 门流转 + schedule 退场
  assert.ok(T.findTransition('feature', 'intake_accept', '待受理'), 'intake_accept 待受理→存在');
  assert.strictEqual(T.resolveToStatus(T.findTransition('feature', 'intake_accept', '待受理'), '待受理'), '待指派', 'intake_accept 待受理→待指派');
  assert.strictEqual(T.resolveToStatus(T.findTransition('bug', 'intake_accept', '待受理'), '待受理'), '待处理', 'bug intake_accept 待受理→待处理');
  assert.strictEqual(T.findTransition('feature', 'schedule', '待受理'), null, 'schedule 退场：findTransition 恒 null');
  assert.strictEqual(T.findTransition('feature', 'schedule', '待指派'), null, 'schedule 退场：任意态 findTransition 恒 null');
  // 5b. reassign（既有测试变更·M3/91 号审）：v2.9 前是静态 from→to 映射（待验证→开发中/开发中→开发中）；
  //   C2 重写为声明式 member_ids 差量 + W-GATE 动态判定目标态，实际目标态事前不可静态得知——改仿 resume 的
  //   to=null 动态解析语义（transitions.js 同批改动），故本处断言随之改为 resolveToStatus 返 null（不再改 status
  //   由端点内 W-GATE 处理），而非旧断言的具体字符串目标态。
  const tReassign = T.findTransition('feature', 'reassign', '待验证');
  assert.ok(tReassign, 'reassign 常量存在（待验证前置）');
  assert.strictEqual(T.resolveToStatus(tReassign, '待验证'), null, 'reassign to=null（动态解析，不再是静态映射）');
  assert.strictEqual(T.resolveToStatus(tReassign, '开发中'), null, 'reassign 开发中前置同为 to=null');
  // 5c. void：'*' 通配（任意态·用新态待受理验证）
  const tVoid = T.findTransition('feature', 'void', '待受理');
  assert.ok(tVoid && tVoid.from === '*' && T.resolveToStatus(tVoid, '待受理') === '已作废', 'void 通配 → 已作废');
  // 5d. estimate：to=null（不改 status 的旁路）
  const tEst = T.findTransition('feature', 'estimate', '开发中');
  assert.strictEqual(T.resolveToStatus(tEst, '开发中'), null, 'estimate to=null（旁路不改 status）');
  // 5e. 非法：feature 在「待受理」不能 assign（assign 需「待指派」前置·受理门未通过不可直派）
  assert.strictEqual(T.findTransition('feature', 'assign', '待受理'), null, 'feature 待受理态不能 assign（须先 intake_accept 到待指派）');
  // 5f. create.to=null 机器契约（受理排期改造 §9）：create from:[]·findTransition(create,null) 不命中（防静态读 create.to）
  const cf = T.buildMeta().typeFlows.feature.find(t => t.action === 'create');
  assert.strictEqual(cf.to, null, 'create.to=null（机器契约·落态由 resolveInitialStatus 动态解析）');
  assert.strictEqual(cf.dynamicTarget, 'initial_status', 'create 带 dynamicTarget=initial_status');
  assert.strictEqual(cf.targetEntity, 'current_issue', 'create targetEntity=current_issue');
  ok('findTransition/resolveToStatus：assign(待指派→开发中) / intake 门流转 / schedule 退场返 null / void 通配 / estimate 旁路 / 待受理不可 assign / create.to=null 机器契约');

  // [6] MED-2（92 号审）+ 93 号收口 + S2 收敛（bug暂缓方案 20260803 v0.4 §4.5b·codex 236 L-1）：reassign
  //   条目 from 与后端权威放行集合"写读同源"——族清单**直接读后端真源**（index.js 导出），非本测试重复
  //   维护的第二份清单，矩阵/覆盖表/transitions.from 任何一侧漂移都会立即被本断言暴露。
  //   ⭐ S2 变更：族粒度做不到"同族内排除单个状态"（D_PRE.bug 现含【待处理,已暂缓】两态，reassign 要保留
  //   待处理但排除已暂缓·§4.5b），故改读 `_internals.memberActionAuthoritativeStatuses`（族门展开 -
  //   MEMBER_ACTION_STATUS_EXCLUDE 状态级排除）而非直接 flatMap 族门——单一函数仍是唯一权威，只是计算
  //   多了一层排除，本测试不重复实现该排除逻辑（避免第三份副本）。
  // C2c·codex115 MED：reassign 族门改 **type 感知**（memberActionFamiliesFor）——bug 保留 D_PRE(待处理可预指派改派)，
  //   变更流排除 D_PRE(去主次后 D_PRE 无在册开发)。断言逐 type 读真源，任何一侧漂移都会立即暴露（防写读不同源）。
  const famFor = mod._internals.memberActionFamiliesFor;
  const authoritativeStatusesFor = mod._internals.memberActionAuthoritativeStatuses;
  assert.ok(typeof famFor === 'function', '[6] 后端应导出 type 感知 memberActionFamiliesFor');
  assert.ok(typeof authoritativeStatusesFor === 'function', '[6] 后端应导出 memberActionAuthoritativeStatuses（§4.5b 族门-状态级排除唯一权威，S2 新增）');
  const reassignAuthoritativeStatuses = (type) => authoritativeStatusesFor('reassign', type);
  // 附加同源自证：变更流排除 D_PRE、bug 族门仍含 D_PRE（type 覆盖真生效，防覆盖表写错静默回落）——
  //   ⚠️ 族门含 D_PRE ≠「已暂缓」进最终权威集合，S2 起两者分离由状态级排除表控制，见下方 [6b] 负向断言。
  assert.ok(!famFor('reassign', 'feature').includes('D_PRE'), '[6] 变更流(feature) reassign 族门应排除 D_PRE');
  assert.ok(famFor('reassign', 'bug').includes('D_PRE'), '[6] bug reassign 族门应保留 D_PRE（待处理态预指派后可改派，不受§4.5b状态级排除影响）');
  for (const type of ['feature', 'improvement', 'bug']) {
    // 直接按 action 取条目（不经 findTransition，避免"用待验证的 from 元素去找 from"这种自我耦合的假阳性——
    // 若 from 漏了某个权威态，findTransition(type,'reassign',那个态) 会返 null，反而让本测试提前误判"条目不存在"
    // 而非"from 缺项"，掩盖真实问题）。
    const t = T.transitionsForType(type).find(x => x.action === 'reassign');
    assert.ok(t, `[6] ${type} reassign 常量应存在`);
    const expected = reassignAuthoritativeStatuses(type).slice().sort();
    const actual = (t.from || []).slice().sort();
    assert.deepStrictEqual(actual, expected, `[6] ${type} reassign.from 应与后端 memberActionAuthoritativeStatuses('reassign',${type}) 展开状态集合完全一致（写读同源·族门展开-状态级排除），实际 from=${JSON.stringify(actual)} 权威=${JSON.stringify(expected)}`);
  }
  ok('[6] MED-2/C2c/S2·§4.5b：reassign.from（feature/improvement/bug 三份）与后端 memberActionAuthoritativeStatuses type 感知放行集合（族门展开 - MEMBER_ACTION_STATUS_EXCLUDE 状态级排除，动态取自 MEMBER_ACTION_FAMILY_MATRIX + TYPE_OVERRIDE + status-families.js）完全一致，写读同源');

  // [6b] ⭐ S2（bug暂缓方案 §4.5b·codex 236 L-1·口径已定死）：负向断言——「已暂缓」不出现在 bug reassign
  //   的 meta/from 中（声明侧）；族门本身仍含 D_PRE（bug 待处理态改派能力不受影响，与上方 [6] 正向互证，
  //   双向锁死：只改一边会让 [6] 或 [6b] 其中之一红）。
  {
    const bugReassignFrom = (T.transitionsForType('bug').find(x => x.action === 'reassign').from || []);
    assert.ok(!bugReassignFrom.includes('已暂缓'),
      `[6b] bug reassign.from 不应含「已暂缓」（§4.5b：暂缓期改派冻结，真闸=HOLD_ROSTER_FROZEN），实际 from=${JSON.stringify(bugReassignFrom)}`);
    assert.ok(bugReassignFrom.includes('待处理'),
      '[6b] bug reassign.from 应仍含「待处理」（92 号审既有能力，未被 §4.5b 误伤）');
  }
  ok('[6b] bug reassign.from 声明侧不含「已暂缓」+ 仍含「待处理」（S2·§4.5b 双向收窄的声明半侧，行为半侧见 verify-sys-multidev-members 的 HOLD_ROSTER_FROZEN 冻结用例）');

  // [7] ⭐ [C6·方案 v3.4 §6.5 附录 B「基础族并集双向集合断言」重跑] 每 type 全体基础族（INTAKE/D_PRE/DEV/
  //   LIAISON_TEST/VERIFY/RELEASE/NONRELEASE_TERMINAL，status-families.js BASE_FAMILY_NAMES——⚠️ L-1
  //   [codex 267 号]：本节注释/断言文案一律不写具体数量词如"六族"，改用"基础族并集"，防未来再加/删族时
  //   数字描述静默过期）的并集须与 transitions.js ALLOWED_STATUSES[type] **严格集合相等**（双向：族里
  //   没有 ALLOWED_STATUSES 之外的幽灵态，ALLOWED_STATUSES 里也没有漏挂族的孤儿态）+ 基础族两两不相交
  //   （同一状态不得同时落在两个基础族——否则 familyOfStatus 的"按 BASE_FAMILY_NAMES 顺序找第一个命中"
  //   会掩盖另一族的真实归属，引擎误判）。
  //   源自受理与排期改造方案 v1.3.x §B 原始定义："基础族并集=ALLOWED_STATUSES 严格集合相等（双向·防幽灵态）
  //   +各族两两不相交"；bug 补「已关闭」终态（C6）后必须重新钉一遍——NONRELEASE_TERMINAL.bug 从
  //   ['已拒绝','已作废'] 变为 ['已关闭','已拒绝','已作废']，任何一侧漏改都会在此立即红灯。
  //
  //   ✅ [工期对接测试与风险等级拆分 方案 v1.1·C0 矩阵验证清单 §A H1/§F-2·C4 收口] **过渡豁免已删除，
  //   恢复严格相等**——C1 阶段（codex 267 号 M-1）曾对 feature 开一个"多出「待对接测试」幽灵态"的临时
  //   豁免口子（族先行登记 vs 状态机同步接线拆成两个 commit 的结构性产物），C4 已给
  //   FEATURE_FLOW_STATUSES/ALLOWED_STATUSES.feature 补上「待对接测试」（transitions.js），豁免的前提
  //   条件（diffExtra 恰为 {'待对接测试'}）已自然收敛为空集，按当初注释的明确指示删除豁免分支，改回
  //   原始的双向严格集合相等——不允许"临时豁免"变成长期存活的新常态。
  for (const type of ['feature', 'improvement', 'bug']) {
    const unionSet = new Set();
    const seenIn = new Map();   // status → 命中的族名（用于两两不相交的具体定位）
    let disjointViolation = null;
    for (const fam of SF.BASE_FAMILY_NAMES) {
      for (const st of SF.getFamilyStatuses(type, fam)) {
        if (seenIn.has(st) && !disjointViolation) {
          disjointViolation = `状态「${st}」同时属于「${seenIn.get(st)}」与「${fam}」两个基础族`;
        }
        seenIn.set(st, fam);
        unionSet.add(st);
      }
    }
    assert.strictEqual(disjointViolation, null, `[7] ${type} 基础族并集两两不相交违例：${disjointViolation}`);
    const unionSorted = [...unionSet].sort();
    const allowedSorted = (T.ALLOWED_STATUSES[type] || []).slice().sort();
    assert.deepStrictEqual(unionSorted, allowedSorted,
      `[7] ${type} 基础族并集应与 ALLOWED_STATUSES 严格集合相等（双向：无幽灵态、无孤儿态）`);
    // 反向补一手：familyOfStatus 对 ALLOWED_STATUSES 里每个状态都应能查到非 null 的族（独立函数路径复核一遍）。
    for (const st of allowedSorted) {
      assert.ok(SF.familyOfStatus(type, st), `[7] ${type} 状态「${st}」应能被 familyOfStatus 查到所属基础族（非 null）`);
    }
  }
  // 两条直接断言（不依赖上面的通用循环推导，直接钉死"待对接测试仅 feature 独有"这一具体事实）：
  //   ① feature 的「待对接测试」确实归属 LIAISON_TEST 族（不是归到别的族、也不是查不到族）；
  //   ② improvement/bug 的 LIAISON_TEST 族数组确为空（status-families.js 两 key 齐列惯例，禁「等」）。
  assert.strictEqual(SF.familyOfStatus('feature', '待对接测试'), 'LIAISON_TEST',
    '[7] feature「待对接测试」应精确归属 LIAISON_TEST 族');
  assert.deepStrictEqual(SF.getFamilyStatuses('improvement', 'LIAISON_TEST'), [],
    '[7] improvement 的 LIAISON_TEST 族状态数组应为空（仅 feature 独有）');
  assert.deepStrictEqual(SF.getFamilyStatuses('bug', 'LIAISON_TEST'), [],
    '[7] bug 的 LIAISON_TEST 族状态数组应为空（仅 feature 独有）');
  // [C6] 精确锚点：bug 的 NONRELEASE_TERMINAL 族现含「已关闭」，且该状态与 change 流一致落在 NONRELEASE_TERMINAL
  //   （而非误落进 RELEASE 或其他族）——直接钉死这条本次改动的核心事实，不完全依赖上面的通用循环。
  assert.strictEqual(SF.familyOfStatus('bug', '已关闭'), 'NONRELEASE_TERMINAL', '[C6] bug「已关闭」应归 NONRELEASE_TERMINAL 族（与 feature/improvement 一致）');
  assert.ok(SF.getFamilyStatuses('bug', 'NONRELEASE_TERMINAL').includes('已关闭'), '[C6] bug NONRELEASE_TERMINAL 族含「已关闭」');
  ok('[7] ⭐ 基础族并集双向集合断言（方案附录 B·C4 收口恢复严格相等，豁免已删除）：feature/improvement/bug 三类型的全体基础族（INTAKE/D_PRE/DEV/LIAISON_TEST/VERIFY/RELEASE/NONRELEASE_TERMINAL）并集与 ALLOWED_STATUSES 双向严格集合相等（feature 含「待对接测试」/improvement·bug 不含）+ 两两不相交 + familyOfStatus 全覆盖，bug「已关闭」精确落 NONRELEASE_TERMINAL 族');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 meta + 状态机常量枚举同步验证通过`);
  console.log(`  覆盖：meta 结构 + M-4 不泄露内部 guard + 枚举同步(timelineEvent ⊆ DDL CHECK 12-M4) + 变更流完整 + findTransition/resolveToStatus + [C6]基础族并集双向集合断言重跑（bug 补已关闭终态）`);
  db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
