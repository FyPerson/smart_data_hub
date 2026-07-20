// routes/sys-iteration/status-families.js — 系统迭代 主状态族常量（C0，多开发协作与 commit 留痕重构 v2.9）
//   SSOT = docs/local/系统迭代/系统迭代_多开发协作与commit留痕_方案_20260716_v2.9.md §4.0（快照值）
//        + docs/local/系统迭代/系统迭代_多开发协作与commit留痕_开发计划_20260716_v2.9.md §2.6（族×routeKind 白名单）
//
// ⚠️ C0 范围：本文件只建常量 + 族判断函数，**不接线任何业务路由**（业务写入口改造是 C2/C3 的事）。
//   本文件的族快照值已在方案 §12「Step0-1 族常量固化」核对过与现网 v1.113.0 transitions.js 100% 一致
//   （五族对 feature/improvement(10态)/bug(7态) 完备互斥，禁「等」）；本次建常量时逐条复核一遍不变。
//
// ── 按 issue_type 索引（禁平面集合、禁「等」）──────────
//   现网只有 feature/improvement/bug 三类流已定义状态机（transitions.js CHANGE_FLOW_STATUSES / BUG_FLOW_STATUSES）；
//   config 流状态机在 transitions.js 留 TODO 空位（尚未定义状态集），本文件同步不臆造 config 的族归属——
//   isInFamily 对未登记 issue_type 一律返回 false（族外拒绝，不变量 7 ②层 assertKnownIssueStatus 的基石）。
//   feature/improvement 共用同一条变更流（CHANGE_FLOW_TRANSITIONS 共享），族值逐字相同，两个 key 各自显式列出
//   （不用共享引用别名，防未来两流分裂时漏改其一——与 transitions.js TRANSITIONS={feature:X,improvement:X} 的
//   "共用同一数组引用"写法刻意不同：那是"转移规则"共用可以引用同一份，这里是"状态字符串快照"独立誊抄更利于
//   逐条肉眼核对与未来分裂时不致命漏改，成本可控（每族最多 3 个状态字符串））。
'use strict';

// ── 受理阶段态（INTAKE）：建单后、进入 D_PRE 前的对接人受理门内态（受理排期改造 §B）──────────
//   ⚠️ 独立成族，**不并入 D_PRE**（codex 128-H1 设计缺陷闭合）：成员动作族矩阵（MEMBER_ACTION_FAMILY_MATRIX）
//   对 add/remove/reassign 允许 D_PRE；若把待受理/待修改并入 D_PRE，reassign 等独立端点会在受理阶段被放行
//   → 对接人/admin 绕过受理直接改派=写宽读窄。解法=INTAKE 独立族，矩阵不含 INTAKE → 受理阶段天然禁成员动作 409。
//   变更流 + bug 的 INTAKE 态相同（待受理/待修改），两 key 独立誊抄（同族其他常量范式）。
const SYS_INTAKE_STATUSES = {
  feature: ['待受理', '待修改'],
  improvement: ['待受理', '待修改'],
  bug: ['待受理', '待修改'],
};

// ── 开发前态（D_PRE）：受理通过后、进入开发前的态 ──────────
//   受理排期改造：变更流删「待评估/已排期」→ 改「待指派」（受理通过落态）；bug D_PRE 保持「待处理」。
const SYS_D_PRE_STATUSES = {
  feature: ['待指派', '已暂缓'],
  improvement: ['待指派', '已暂缓'],
  bug: ['待处理'],
};

// ── 开发执行态（DEV）：开发正在干活的态 ──────────
const SYS_DEV_STATUSES = {
  feature: ['开发中'],
  improvement: ['开发中'],
  bug: ['处理中'],
};

// ── 待验证态（VERIFY）：全员完成态、等待验收 ──────────
const SYS_VERIFY_STATUSES = {
  feature: ['待验证'],
  improvement: ['待验证'],
  bug: ['待验证'],
};

// ── 发布控制态（RELEASE）：待上线 + 已上线（进入边见方案 §4.0/计划 §2.6，本文件不建边校验逻辑，仅状态归属）──────────
const SYS_RELEASE_STATUSES = {
  feature: ['待上线', '已上线'],
  improvement: ['待上线', '已上线'],
  bug: ['待上线', '已上线'],
};

// ── 非发布终态（NONRELEASE_TERMINAL）：不经发布流程结束的态 ──────────
const SYS_NONRELEASE_TERMINAL_STATUSES = {
  feature: ['已关闭', '已拒绝', '已作废'],
  improvement: ['已关闭', '已拒绝', '已作废'],
  bug: ['已拒绝', '已作废'],   // bug 流无「已关闭」（已上线即终态，§3.4 现网差异）
};

// ── 派生族（不在方案 §4.0 表内单独定义快照值，由上面 4 族按 type 逐一并集算出）──────────
function unionByType(...familyMaps) {
  const result = {};
  for (const map of familyMaps) {
    for (const type of Object.keys(map)) {
      result[type] = (result[type] || []).concat(map[type]);
    }
  }
  return result;
}

// FROZEN = RELEASE ∪ 非发布终态（commit 编辑/成员动作全关）
const SYS_FROZEN_STATUSES = unionByType(SYS_RELEASE_STATUSES, SYS_NONRELEASE_TERMINAL_STATUSES);

// TERMINAL = 已上线 ∪ 非发布终态（不含待上线——§5.4 附件「非终态」判断专用）
const SYS_TERMINAL_STATUSES = (() => {
  const result = {};
  for (const type of Object.keys(SYS_NONRELEASE_TERMINAL_STATUSES)) {
    result[type] = ['已上线', ...SYS_NONRELEASE_TERMINAL_STATUSES[type]];
  }
  return result;
})();

// ── 族名 → 快照 map 的统一索引（isInFamily 用；FAMILY_NAMES 供调用方枚举/校验）──────────
const FAMILIES = {
  INTAKE: SYS_INTAKE_STATUSES,
  D_PRE: SYS_D_PRE_STATUSES,
  DEV: SYS_DEV_STATUSES,
  VERIFY: SYS_VERIFY_STATUSES,
  RELEASE: SYS_RELEASE_STATUSES,
  NONRELEASE_TERMINAL: SYS_NONRELEASE_TERMINAL_STATUSES,
  FROZEN: SYS_FROZEN_STATUSES,
  TERMINAL: SYS_TERMINAL_STATUSES,
};
const FAMILY_NAMES = Object.keys(FAMILIES);

// 该 issue_type 是否有已定义的状态机族归属（config 等未登记类型 → false，族外拒绝的基石）。
function isKnownIssueType(issueType) {
  return Object.prototype.hasOwnProperty.call(SYS_D_PRE_STATUSES, issueType);
}

// 核心判断函数：(issue_type, status) 是否属于 familyName 族。
//   未登记 issue_type / 未知 familyName / status 不在该族快照值内 → 一律 false（fail-closed，不变量 7 ②层基石）。
function isInFamily(issueType, status, familyName) {
  const map = FAMILIES[familyName];
  if (!map) throw new Error(`status-families.isInFamily: 未知族名 "${familyName}"（合法值：${FAMILY_NAMES.join('/')}）`);
  const list = map[issueType];
  if (!Array.isArray(list)) return false;   // issue_type 未登记（如 config）→ 族外
  return list.includes(status);
}

// 该 issue_type 下某族的快照状态数组（只读用途，如探针/verify 脚本枚举断言；调用方不得改写返回数组）。
function getFamilyStatuses(issueType, familyName) {
  const map = FAMILIES[familyName];
  if (!map) throw new Error(`status-families.getFamilyStatuses: 未知族名 "${familyName}"（合法值：${FAMILY_NAMES.join('/')}）`);
  return map[issueType] || [];
}

// 反向查询：(issue_type,status) 属于哪个「基础族」（INTAKE/D_PRE/DEV/VERIFY/RELEASE/NONRELEASE_TERMINAL 六者之一，
//   不含派生族 FROZEN/TERMINAL——那两个是并集，任何合法状态本就落在某个基础族里，查"派生族"没有唯一答案）。
//   查不到（族外/未知 type）→ null（fail-closed，供 assertMainStatusTransition 白名单判断用）。
//   ⚠️ 受理排期改造 §B：待受理/待修改归 INTAKE（非 null）——成员动作族矩阵不含 INTAKE → 受理阶段成员动作天然 409。
const BASE_FAMILY_NAMES = ['INTAKE', 'D_PRE', 'DEV', 'VERIFY', 'RELEASE', 'NONRELEASE_TERMINAL'];
function familyOfStatus(issueType, status) {
  for (const name of BASE_FAMILY_NAMES) {
    if (isInFamily(issueType, status, name)) return name;
  }
  return null;
}

// ── C2（成员 API + W-GATE + assertMainStatusTransition）Step0 尾巴：SYS_W06_ALLOWED_STATUS ──────────
//   固化"W06 类"动作（开发本人自服务、不改主状态的旁路动作）的合法 from 状态，按 action 键、按 issue_type 索引。
//   W06 精确定义 = transitions.js 里 ownerGuard='assignee' 且**不改变主状态**（to===null）的动作——
//   submit 虽也 ownerGuard='assignee' 但会改 status（开发中→待验证），是独立的主状态转换动作，非 W06（C3 归属，
//   走 handleDevSubmit 唯一入口，不在此表）。逐条对照 transitions.js 现网 CHANGE_FLOW_TRANSITIONS +
//   BUG_FLOW_TRANSITIONS 的 from 数组固化（2026-07-16 复核，与 v1.113.0 现网 100% 一致）：
//   - estimate：feature/improvement from=['开发中']；bug from=['处理中']（bug 无 feasibility/blocked，§2.2 裁剪）
//   - feasibility：仅 feature/improvement from=['开发中']（评估环节 F2a，bug/config 不适用）
//   - blocked：仅 feature/improvement from=['开发中']（unblock 是 admin 动作 roleGuard='admin'，非 W06——
//     解除受阻不是"开发自服务"，不入本表）
//   本表当前仅"固化"，C2 不接线到任何端点（W06 各端点仍走现网 estimate/feasibility/blocked 独立实现，未来
//   迁移到 assertDevMember + 本表的改造属 C3 前置，见开发计划 v2.9 §5「留 C2/C3 前」）。
const SYS_W06_ALLOWED_STATUS = {
  estimate: { feature: ['开发中'], improvement: ['开发中'], bug: ['处理中'] },
  feasibility: { feature: ['开发中'], improvement: ['开发中'] },
  blocked: { feature: ['开发中'], improvement: ['开发中'] },
};
// 判断函数：(action, issue_type, status) 是否落在 W06 白名单内；未登记 action/type → false（fail-closed，禁「等」）。
function isW06Allowed(action, issueType, status) {
  const byType = SYS_W06_ALLOWED_STATUS[action];
  if (!byType) return false;
  const list = byType[issueType];
  if (!Array.isArray(list)) return false;
  return list.includes(status);
}

module.exports = {
  SYS_INTAKE_STATUSES,
  SYS_D_PRE_STATUSES,
  SYS_DEV_STATUSES,
  SYS_VERIFY_STATUSES,
  SYS_RELEASE_STATUSES,
  SYS_NONRELEASE_TERMINAL_STATUSES,
  SYS_FROZEN_STATUSES,
  SYS_TERMINAL_STATUSES,
  FAMILIES,
  FAMILY_NAMES,
  BASE_FAMILY_NAMES,
  isKnownIssueType,
  isInFamily,
  getFamilyStatuses,
  familyOfStatus,
  SYS_W06_ALLOWED_STATUS,
  isW06Allowed,
};
