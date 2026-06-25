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
      // 只暴露 action/from/to/requiredPayload
      for (const k of Object.keys(tf)) {
        assert.ok(['action', 'from', 'to', 'requiredPayload'].includes(k), `typeFlows[${type}] 含非预期字段 ${k}`);
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
