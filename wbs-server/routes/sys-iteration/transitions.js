// routes/sys-iteration/transitions.js — 系统迭代状态机常量（前后端单一来源，T-M4）
//   业务语义 SSOT = 方案 v1.6 §3.2-§3.7（状态机/转移矩阵/10 维度）+ §9（权限矩阵）。
//   本文件 = §3.7「机器可读常量」的落地：ALLOWED_STATUSES / TRANSITIONS（每条 10 维度）/ BIZ_SYSTEMS +
//     buildMeta（决策②，前端 fetch 消费同一份，杜绝双状态机漂移）+ findTransition（sysIssueTransition 查表用）。
//
// ⚠️ C2 切片（本轮先打通变更流 feature+improvement）：
//   - 变更流（feature/improvement 共用一条流）的 ALLOWED_STATUSES + TRANSITIONS **本轮全定义**
//     （状态机常量是单一来源，一次定全更干净；前端 meta 也需完整状态图）。
//   - bug 流 / config 流的常量 **本轮留空位 + TODO 标注**，追加 bug/config 时增量填（不动变更流）。
//   - 端点实现分 commit：C2 实现到 建单/排期/指派/reassign + 列表/详情/meta；estimate/submit/accept/return/
//     批次/暂缓/恢复/拒绝/作废/重开/范围变更/派生 的常量已在表里，端点 C3+ 补。
'use strict';

// ── 被迭代的业务系统白名单（决策①，§12 GET /sys-systems 下拉源）──────────
//   照 correction source_system 范式（后端常量 + '其他' 兜底，非字典表）。
//   system_name 后端白名单校验，不进 DB CHECK（业务系统列表可能微调，常量层更灵活）。
const BIZ_SYSTEMS = ['BMS', 'HRD', 'OA', '智数协同', '其他'];

// ── 类型 → 初始态（建单落地态，§3.6）──────────
//   bug→待处理 / 变更（feature/improvement）→待评估 / config→待处理（config 本轮留位）。
const INITIAL_STATUS_BY_TYPE = {
  feature: '待评估',
  improvement: '待评估',
  // bug: '待处理',        // TODO 追加 bug 流时填
  // config: '待处理',     // TODO 追加 config 流时填
};

// ── 每个 type 的合法状态集（§3.3 变更流 + §3.4 旁路态）──────────
const CHANGE_FLOW_STATUSES = [
  '待评估', '已排期', '开发中', '待验证', '待上线', '已上线', '已关闭',  // 主流程
  '已暂缓', '已拒绝', '已作废',                                          // 旁路态（§3.4）
];
const ALLOWED_STATUSES = {
  feature: CHANGE_FLOW_STATUSES,
  improvement: CHANGE_FLOW_STATUSES,
  // bug: [...],        // TODO 追加 bug 流时填（待处理→处理中→待验证→...，§3.2）
  // config: [...],     // TODO 追加 config 流时填（待处理→处理中→待验收→已生效，§18.2）
};

// ── 状态机 transition 常量（每条 10 维度，§3.7 / §3.6 转移矩阵 / §9 权限矩阵）──────────
//   维度：type / from（数组，前置态白名单）/ to（目标态，或 from→to 映射）/ action（动作码）/
//        roleGuard（角色，§9）/ ownerGuard（'assignee'=登录人须=assigned_to / null）/
//        requiredPayload（闸门必填字段，§7）/ sideEffects（副作用字段，人读说明）/
//        timelineEvent（写哪个 event_type，§4.2）/ actionCode（status_change 细分，RC-L1）/
//        notifyAfterCommit（提交后触发的通知，§8，事务提交后发）。
//
// ⚠️ 权限口径（T-M1，§9）：所有 admin 写动作一律 roleGuard='admin'，**不绑 created_by**（任意 admin 可代办）；
//   ownerGuard='assignee' 仅用于"开发本人"约束（estimate/submit 校验登录人=assigned_to，RC-M5）。
// ⚠️ 枚举同步（05-H1 + 12-M4）：下方 timelineEvent / actionCode 必须 ⊆ DDL CHECK 枚举（index.js sys_issue_timeline），
//   verify-sys-meta.js 加"常量 ⊆ DDL CHECK 且无幽灵值"断言。
const CHANGE_FLOW_TRANSITIONS = [
  {
    action: 'create',                       // 建单（端点 POST /sys-issues，不走 transition，单独 INSERT；此条供 meta 完整性）
    from: [], to: '待评估',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['INSERT 主表 + 写 created timeline'],
    timelineEvent: 'created', actionCode: null,
    notifyAfterCommit: null,
  },
  {
    action: 'schedule',                     // 排期：待评估 → 已排期（admin 确认做 + 定优先级/deadline）
    from: ['待评估'], to: '已排期',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['priority_reviewed_at=now', '可改 priority/deadline'],
    timelineEvent: 'status_change', actionCode: 'schedule',
    notifyAfterCommit: null,
  },
  {
    action: 'assign',                       // 指派：已排期 → 开发中（admin 派给开发，被指派人非 viewer）
    from: ['已排期'], to: '开发中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['assigned_to'],
    sideEffects: ['assigned_to/_name/assigned_at 写入'],   // codex 14 L-1：DDL 无 assigned_by 字段（系统迭代 admin 集中主导，"谁指派"恒 admin 不单记）
    timelineEvent: 'assign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5 落地
  },
  {
    action: 'reassign',                     // 重新指派：开发中/待验证 → 开发中（换人，不走 transition，乐观锁绑 oldAssignedTo，照 correction v1.85.0 L-R / 06-M3）
    from: ['开发中', '待验证'], to: { '开发中': '开发中', '待验证': '开发中' },
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['newAssignedTo', 'oldAssignedTo', 'reason'],
    sideEffects: ['assigned_to/_name/assigned_at 更新', 'dev_estimated_at 清空（T-M2）', '仅重置开发侧 notify_*（不动 requester/creator，05-L3）', 'return_count 不变（05-M2）'],
    timelineEvent: 'reassign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5
  },
  {
    action: 'estimate',                     // 回填预计完成：开发中（不改 status，写 dev_estimated_at）—— 端点 C3
    from: ['开发中'], to: null,             // to=null 表示不改 status（旁路动作）
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['dev_estimated_at'],
    sideEffects: ['dev_estimated_at 写入（>=assigned_at 校验，§7）'],
    timelineEvent: 'estimate', actionCode: null,
    notifyAfterCommit: 'notifyEstimateToCreatorAndRequester',  // C5（双收件人，T-M3）
  },
  {
    action: 'submit',                       // 提交：开发中 → 待验证（闸门 交付说明 + dev_estimated_at 非空）—— 端点 C3
    from: ['开发中'], to: '待验证',
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['summary'],           // 交付说明 trim 非空 + dev_estimated_at 非空（transition 内校）
    sideEffects: ['first_submitted_at（首次永不变）', 'round_no 递增 + submit timeline'],
    timelineEvent: 'submit', actionCode: null,
    notifyAfterCommit: 'notifySubmittedToAdmin',  // C5（admin 自身按需精简，feedback_no_self_notify）
  },
  {
    action: 'accept',                       // 验收通过：待验证 → 待上线（admin）—— 端点 C3
    from: ['待验证'], to: '待上线',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['accepted_at=now'],
    timelineEvent: 'status_change', actionCode: 'accept',
    notifyAfterCommit: null,
  },
  {
    action: 'return',                       // 验收打回：待验证 → 开发中（admin，打回原因必填）—— 端点 C3
    from: ['待验证'], to: '开发中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],            // 打回原因 trim 非空
    sideEffects: ['return_count++（U-2）', 'dev_estimated_at 清空（T-M2）'],
    timelineEvent: 'return', actionCode: null,
    notifyAfterCommit: 'notifyReturnedToDeveloper',  // C5
  },
  {
    action: 'publish',                      // 批次发布：待上线 → 已上线（走 publishReleaseTransition，批次级）—— 端点 C4
    from: ['待上线'], to: '已上线',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],                    // 批次级闸门（release_note/version_tag）在 publishReleaseTransition 校
    sideEffects: ['released_at=now', 'release_id 绑批次', 'release timeline（ref_id=批次 id）'],
    timelineEvent: 'release', actionCode: null,
    notifyAfterCommit: 'notifyReleasedToRequester',  // C5
  },
  {
    action: 'close',                        // 关闭：已上线 → 已关闭（admin）—— 端点 C4
    from: ['已上线'], to: '已关闭',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['closed_at=now'],
    timelineEvent: 'status_change', actionCode: 'close',
    notifyAfterCommit: null,
  },
  // ── 旁路态动作（§3.4，端点 C3+）──────────
  {
    action: 'hold',                         // 暂缓：任意活跃态 → 已暂缓（admin，原因必填）
    from: ['待评估', '已排期', '开发中', '待验证', '待上线'], to: '已暂缓',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['进入暂缓前活跃态记入 timeline from_status（H-1 恢复用）'],
    timelineEvent: 'status_change', actionCode: 'hold',
    notifyAfterCommit: null,
  },
  {
    action: 'resume',                       // 暂缓恢复：已暂缓 → 暂缓前活跃态（admin，timeline 可解析，H-1/RC-M2）
    from: ['已暂缓'], to: null,             // to 动态解析（resolveToStatus，从 timeline 取暂缓前 from_status）
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['恢复到最近一次进入暂缓前的活跃态（校验属当前 type 合法活跃态，否则 409）'],
    timelineEvent: 'status_change', actionCode: 'resume',
    notifyAfterCommit: null,
  },
  {
    action: 'reactivate',                   // 重新激活：已拒绝 → 初始态（admin，不计返工，RC-M1）
    from: ['已拒绝'], to: '待评估',         // 变更流回 待评估（bug 回 待处理，追加 bug 时分流）
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['回初始态重走指派流程（reopen_count 不变）'],
    timelineEvent: 'status_change', actionCode: 'reactivate',
    notifyAfterCommit: null,
  },
  {
    action: 'issue_reject',                 // 拒绝：待评估 → 已拒绝（admin，原因必填，§3.4）
    from: ['待评估'], to: '已拒绝',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'issue_reject',
    notifyAfterCommit: null,
  },
  {
    action: 'void',                         // 作废：任意态 → 已作废（admin，软删除，原因必填，§3.4）
    from: '*', to: '已作废',                // from='*' 通用旁路（任意非已作废态）
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['软删除，前端隐藏'],
    timelineEvent: 'status_change', actionCode: 'void',
    notifyAfterCommit: null,
  },
  {
    action: 'reopen',                       // 重开：已上线/已关闭 → 开发中（admin，计返工，§3.5）
    from: ['已上线', '已关闭'], to: '开发中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['reopen_count++', 'reopened_at=now', '清 accepted_at/released_at/closed_at/release_id/dev_estimated_at（first_submitted_at 永不变）'],
    timelineEvent: 'reopen', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5
  },
  {
    action: 'scope_change',                 // 范围变更：处理中/开发中/待验证（不改 status，写事件 + scope_changed=1，§5.2）
    from: ['开发中', '待验证'], to: null,   // to=null 不改 status
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['summary'],           // 变更摘要 trim 非空
    sideEffects: ['scope_changed=1', '可改 deadline（旧值写入事件 summary 留痕）'],
    timelineEvent: 'scope_change', actionCode: null,
    notifyAfterCommit: null,
  },
  {
    action: 'derive',                       // 派生迭代：原单任意态 → 新建一单（admin，防环，§5.1）
    from: '*', to: null,                    // 新建单，不改原单 status
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],  // 新单建单字段 + origin_issue_id
    sideEffects: ['新建单 origin_issue_id=原单 id', '先写 created 再写 derive（T-L3）', '防环 M-1'],
    timelineEvent: 'derive', actionCode: null,
    notifyAfterCommit: null,
  },
];

// 全部 transitions（按 type 组织；本轮只有变更流，bug/config 追加时 concat）。
const TRANSITIONS = {
  feature: CHANGE_FLOW_TRANSITIONS,
  improvement: CHANGE_FLOW_TRANSITIONS,    // 变更流两类型共用同一份（共享尾段 + 共享前段，§3.3）
  // bug: BUG_FLOW_TRANSITIONS,            // TODO 追加 bug 流
  // config: CONFIG_FLOW_TRANSITIONS,      // TODO 追加 config 流
};

// ── 查表 helper（sysIssueTransition / 端点用）──────────

// 该 type 的全部 transitions（无则空数组）。
function transitionsForType(type) {
  return TRANSITIONS[type] || [];
}

// 按 (type, action, fromStatus) 查唯一 transition；找不到返 null。
//   from 支持：数组（fromStatus ∈ 数组）/ '*'（任意态）。
function findTransition(type, action, fromStatus) {
  const list = transitionsForType(type);
  for (const t of list) {
    if (t.action !== action) continue;
    if (t.from === '*') return t;
    if (Array.isArray(t.from) && t.from.includes(fromStatus)) return t;
  }
  return null;
}

// 解析目标态（M-7 resolveToStatus）：to 为字符串直接返；为映射对象按 fromStatus 取；
//   为 null 表示不改 status（旁路动作，由端点单独处理）；resume 等动态态由端点从 timeline 解析（此处返 undefined）。
function resolveToStatus(transition, fromStatus) {
  if (!transition) return undefined;
  const to = transition.to;
  if (to === null) return null;                 // 不改 status
  if (typeof to === 'string') return to;
  if (to && typeof to === 'object') return to[fromStatus];  // from→to 映射（如 reassign 待验证→开发中）
  return undefined;
}

// ── meta（决策②，buildMeta：从 TRANSITIONS 派生前端只读视图）──────────
//   M-4：只返前端必需，**不暴露** roleGuard/ownerGuard/sideEffects/notifyAfterCommit。
function buildMeta() {
  const statusLabels = {};      // type → 合法状态集（前端渲染状态徽章/筛选器）
  const typeFlows = {};         // type → [{ action, from, to, requiredPayload, needsPayload }]（前端类型联动按钮显隐）
  const actions = {};           // action → 中文 label（前端动作按钮文案）
  const ACTION_LABELS = {
    create: '建单', schedule: '排期', assign: '指派', reassign: '改派',
    estimate: '回填预计完成', submit: '提交', accept: '验收通过', return: '验收打回',
    publish: '批次发布', close: '关闭', hold: '暂缓', resume: '恢复',
    reactivate: '重新激活', issue_reject: '拒绝', void: '作废', reopen: '重开',
    scope_change: '范围变更', derive: '派生迭代',
  };

  for (const type of Object.keys(TRANSITIONS)) {
    statusLabels[type] = ALLOWED_STATUSES[type] || [];
    typeFlows[type] = transitionsForType(type).map(t => ({
      action: t.action,
      from: t.from,                              // 数组 / '*'
      to: t.to,                                  // 字符串 / 映射 / null（前端据此判断是否旁路动作）
      requiredPayload: t.requiredPayload || [],
      // 仅暴露"是否需弹窗收集 payload"，不暴露内部 guard/sideEffects（M-4）
    }));
  }
  for (const a of Object.keys(ACTION_LABELS)) actions[a] = ACTION_LABELS[a];

  return { statusLabels, typeFlows, actions, bizSystems: BIZ_SYSTEMS, initialStatusByType: INITIAL_STATUS_BY_TYPE };
}

module.exports = {
  BIZ_SYSTEMS,
  INITIAL_STATUS_BY_TYPE,
  ALLOWED_STATUSES,
  TRANSITIONS,
  transitionsForType,
  findTransition,
  resolveToStatus,
  buildMeta,
};
