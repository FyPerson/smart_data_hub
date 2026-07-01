// 验证脚本：系统迭代 meta + 状态机常量枚举同步（C2，方案 §3.7 / 12-M4 / 05-H1）
//   用法：node scripts/verify-sys-meta.js
//
// 核心断言（require 真实 transitions.js + index.js initSchema 取 DDL CHECK 枚举）：
//   1. buildMeta 结构完整（statusLabels / typeFlows / actions / bizSystems / initialStatusByType）
//   2. meta 不暴露内部 guard（M-4：typeFlows 不含 roleGuard/ownerGuard/sideEffects/notifyAfterCommit）
//   3. ⭐ 枚举同步（12-M4 + 05-H1）：transitions 常量的 timelineEvent / actionCode ⊆ DDL CHECK 枚举，无幽灵值
//   4. 变更流类型流完整（feature/improvement 共用同一份，含 create→...→close 全动作）
//   5. findTransition / resolveToStatus 行为正确（含 reassign 待验证→开发中映射、'*' 通配、to=null 旁路）
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const T = require('../routes/sys-iteration/transitions');

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
  for (const k of ['statusLabels', 'typeFlows', 'actions', 'bizSystems', 'initialStatusByType']) {
    assert.ok(meta[k] !== undefined, `meta 缺字段 ${k}`);
  }
  assert.deepStrictEqual(meta.bizSystems, ['BMS', 'HRD', 'OA', '智数协同', '其他'], 'bizSystems 应为 BIZ_SYSTEMS');
  ok('buildMeta 结构完整（statusLabels/typeFlows/actions/bizSystems/initialStatusByType）');

  // [2] M-4：typeFlows 不暴露内部 guard
  for (const type of Object.keys(meta.typeFlows)) {
    for (const tf of meta.typeFlows[type]) {
      for (const leak of ['roleGuard', 'ownerGuard', 'sideEffects', 'notifyAfterCommit', 'timelineEvent', 'actionCode']) {
        assert.ok(!(leak in tf), `typeFlows[${type}] 泄露内部字段 ${leak}`);
      }
      // 只暴露 action/from/to/requiredPayload/kind（kind = F2b codex 17 M-1 旁路标记）
      for (const k of Object.keys(tf)) {
        assert.ok(['action', 'from', 'to', 'requiredPayload', 'kind'].includes(k), `typeFlows[${type}] 含非预期字段 ${k}`);
      }
    }
  }
  ok('M-4：typeFlows 仅暴露 action/from/to/requiredPayload，不泄露 roleGuard/ownerGuard/sideEffects/notifyAfterCommit/timelineEvent/actionCode');

  // [3] ⭐ 枚举同步（12-M4 + 05-H1）：transitions 的 timelineEvent/actionCode ⊆ DDL CHECK
  const timelineDdl = (await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issue_timeline'")).sql;
  const ddlEventTypes = parseCheckEnum(timelineDdl, 'event_type');
  assert.ok(Array.isArray(ddlEventTypes) && ddlEventTypes.length > 0, '无法解析 sys_issue_timeline event_type CHECK 枚举');
  ok(`DDL event_type CHECK 枚举解析成功（${ddlEventTypes.length} 个：${ddlEventTypes.join('/')}）`);

  // 收集所有 transition 用到的 timelineEvent + actionCode
  const usedEvents = new Set();
  const usedActionCodes = new Set();
  for (const type of Object.keys(T.TRANSITIONS)) {
    for (const t of T.transitionsForType(type)) {
      if (t.timelineEvent) usedEvents.add(t.timelineEvent);
      if (t.actionCode) usedActionCodes.add(t.actionCode);
    }
  }
  // 每个 timelineEvent 必须 ∈ DDL event_type 枚举（防 05-H1 那类 CHECK 冲突）
  const eventLeak = [...usedEvents].filter(e => !ddlEventTypes.includes(e));
  assert.strictEqual(eventLeak.length, 0, `transitions 用了 DDL CHECK 没有的 event_type（会触发 CHECK 失败）：${eventLeak.join(',')}`);
  ok(`枚举同步：transitions 全部 timelineEvent（${[...usedEvents].join('/')}）⊆ DDL event_type CHECK（含 reassign 独立枚举 05-H1，无 CHECK 冲突）`);

  // actionCode 是 status_change 的细分（RC-L1），不入 DDL CHECK（DDL 无 action_code CHECK），仅自洽检查非空字符串
  for (const ac of usedActionCodes) {
    assert.ok(typeof ac === 'string' && ac.length > 0, `actionCode 应为非空字符串：${ac}`);
  }
  ok(`actionCode 自洽（${[...usedActionCodes].join('/')}，RC-L1 status_change 细分动作）`);

  // [4] 变更流类型流完整（feature/improvement 共用 + 含核心动作）
  assert.deepStrictEqual(meta.statusLabels.feature, meta.statusLabels.improvement, 'feature/improvement 状态集应一致（共用变更流）');
  const featureActions = meta.typeFlows.feature.map(t => t.action);
  for (const a of ['create', 'schedule', 'assign', 'reassign', 'estimate', 'submit', 'accept', 'return', 'publish', 'close']) {
    assert.ok(featureActions.includes(a), `变更流缺动作 ${a}`);
  }
  ok(`变更流类型流完整（feature/improvement 共用，含 create/schedule/assign/reassign/estimate/submit/accept/return/publish/close ${featureActions.length} 动作）`);

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
    create: 'transition', schedule: 'transition', assign: 'transition', reassign: 'transition',
    submit: 'transition', accept: 'transition', return: 'transition', publish: 'transition',
    close: 'transition', hold: 'transition', resume: 'transition', reactivate: 'transition',
    issue_reject: 'transition', void: 'transition', reopen: 'transition',
  };
  for (const type of Object.keys(meta.typeFlows)) {   // codex 20 L-2：遍历所有 type（非仅 feature），防 config/bug 流动作差异漏检
    for (const tf of meta.typeFlows[type]) {
      assert.ok(KIND_EXPECT[tf.action] !== undefined, `[4d] ${type} 动作 ${tf.action} 未在 kind 期望表（新增动作须补 KIND_EXPECT + 核对 to 语义）`);
      assert.strictEqual(tf.kind, KIND_EXPECT[tf.action], `[4d] ${type} 动作 ${tf.action} kind 应为 ${KIND_EXPECT[tf.action]}（实 ${tf.kind}）`);
    }
  }
  // ⭐ resume 专项（ultracode 对抗审）：to=null 但实改 status（动态解析），必须 transition 不能 side_effect（白名单 SIDE_EFFECT_ACTIONS 不含 resume）
  assert.strictEqual(meta.typeFlows.feature.find(t => t.action === 'resume').kind, 'transition', 'resume 必须 kind=transition（to=null 是动态解析 status 非旁路，防误标 side_effect）');
  ok('[4d] kind 全集断言：5 旁路 side_effect + 其余 transition（含 resume 专项=transition 防 to=null 误标，codex 17 M-1 + ultracode 对抗审）');

  // [5] findTransition / resolveToStatus 行为
  // 5a. assign：已排期 → 开发中
  const tAssign = T.findTransition('feature', 'assign', '已排期');
  assert.ok(tAssign && T.resolveToStatus(tAssign, '已排期') === '开发中', 'assign 已排期→开发中');
  // 5b. reassign：待验证 → 开发中（映射对象）
  const tReassign = T.findTransition('feature', 'reassign', '待验证');
  assert.ok(tReassign && T.resolveToStatus(tReassign, '待验证') === '开发中', 'reassign 待验证→开发中（映射）');
  assert.strictEqual(T.resolveToStatus(tReassign, '开发中'), '开发中', 'reassign 开发中→开发中');
  // 5c. void：'*' 通配（任意态）
  const tVoid = T.findTransition('feature', 'void', '待评估');
  assert.ok(tVoid && tVoid.from === '*' && T.resolveToStatus(tVoid, '待评估') === '已作废', 'void 通配 → 已作废');
  // 5d. estimate：to=null（不改 status 的旁路）
  const tEst = T.findTransition('feature', 'estimate', '开发中');
  assert.strictEqual(T.resolveToStatus(tEst, '开发中'), null, 'estimate to=null（旁路不改 status）');
  // 5e. 非法：feature 在「待评估」不能 assign（assign 需「已排期」前置）
  assert.strictEqual(T.findTransition('feature', 'assign', '待评估'), null, 'feature 待评估态不能 assign');
  // 5f. bug/config 本轮未定义
  assert.strictEqual(T.findTransition('bug', 'create', null), null, 'bug 流本轮未定义（追加时填）');
  ok('findTransition/resolveToStatus：assign(已排期→开发中) / reassign 映射(待验证→开发中) / void 通配 / estimate 旁路 to=null / 非法前置态返 null / bug 未定义');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 meta + 状态机常量枚举同步验证通过`);
  console.log(`  覆盖：meta 结构 + M-4 不泄露内部 guard + 枚举同步(timelineEvent ⊆ DDL CHECK 12-M4) + 变更流完整 + findTransition/resolveToStatus`);
  db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
