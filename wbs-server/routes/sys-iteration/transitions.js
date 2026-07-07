// routes/sys-iteration/transitions.js — 系统迭代状态机常量（前后端单一来源，T-M4）
//   业务语义 SSOT = 方案 v1.6 §3.2-§3.7（状态机/转移矩阵/10 维度）+ §9（权限矩阵）。
//   本文件 = §3.7「机器可读常量」的落地：ALLOWED_STATUSES / TRANSITIONS（每条 10 维度）/ BIZ_SYSTEMS +
//     buildMeta（决策②，前端 fetch 消费同一份，杜绝双状态机漂移）+ findTransition（sysIssueTransition 查表用）。
//
// ⚠️ C2 切片（变更流 feature+improvement 已全上线 v1.102.0）：
//   - 变更流（feature/improvement 共用一条流）的 ALLOWED_STATUSES + TRANSITIONS 全定义。
//   - **bug 流已追加（bug流_方案_20260702_v1.2）**：BUG_FLOW_TRANSITIONS 见下方——
//     Commit ① 前段（建单→…→待上线）+ Commit ② 两条确认上线路径（填发版信息/发版 hotfix/不发版专用 transition，死端解除）；
//     真钉钉建群=③；手动链式通知+对接人白名单=④；派生双描述=⑤。
//   - config 流的常量 **留空位 + TODO 标注**，追加 config 时增量填（不动既有流）。
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
  bug: '待处理',           // bug 前段最短（无评估/排期，建单直落 待处理，bug 方案 §2.1）
  // config: '待处理',     // TODO 追加 config 流时填
};

// ── 每个 type 的合法状态集（§3.3 变更流 + §3.4 旁路态）──────────
const CHANGE_FLOW_STATUSES = [
  '待评估', '已排期', '开发中', '待验证', '待上线', '已上线', '已关闭',  // 主流程
  '已暂缓', '已拒绝', '已作废',                                          // 旁路态（§3.4）
];
// bug 流状态集（bug 方案 §2.2）：无 已排期/待评估（前段裁剪）、无 已暂缓（暂缓有意省略）、
//   无 已关闭（已上线即终态，上线后再出问题一律派生新单）。
const BUG_FLOW_STATUSES = [
  '待处理', '处理中', '待验证', '待上线', '已上线',   // 主流程（已上线=终态）
  '已拒绝', '已作废',                                  // 旁路态
];
const ALLOWED_STATUSES = {
  feature: CHANGE_FLOW_STATUSES,
  improvement: CHANGE_FLOW_STATUSES,
  bug: BUG_FLOW_STATUSES,
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
    from: ['已拒绝'], to: '待评估',         // 变更流回 待评估（bug 流有独立条目回 待处理，见 BUG_FLOW_TRANSITIONS）
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
  // ── scope_change（范围变更）：feature/improvement 全禁（F2a §3.2 / 评估编码方案 v0.3 开放①）──────────
  //   评估环节确立"绝对禁止开发态调需求"（v1.7 §十九 ⑦）→ feature/improvement 彻底移除 scope_change 动作
  //   （非 from=[]，是不展示该动作；buildMeta typeFlows 自然不含，前端无范围变更按钮）；
  //   需求变化统一走 derive 派生新单 / 作废重开。
  //   ⚠️ config 流 scope_change 不受影响（§18.9 config 支持范围变更）——追加 config 流时在 CONFIG_FLOW_TRANSITIONS 自带。
  //   端点层 POST /scope-change 另加 type 守卫（409 SCOPE_CHANGE_DISABLED）双保险，防直接调 API。
  // ── 可行性评估旁路动作（F2b §3.1 / v1.7 §十九，feature/improvement，to=null 不改 status）──────────
  //   三动作端点独立事务实现（不走 sysIssueTransition，照 estimate 范式），常量在表里供 meta/findTransition 一致性。
  //   buildMeta 据 to===null 标 kind='side_effect'，前端路由专用端点（/feasibility /blocked /unblock）不误走通用 transition。
  {
    action: 'feasibility',                  // 填可行性评估（开发本人，不改 status，旁路）—— 端点 F2b
    from: ['开发中'], to: null,
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['conclusion', 'requirement_confirm', 'dev_estimated_at'],  // 有条件可行/不可行时 risk 必填见端点
    sideEffects: ['写评估字段 + dev_estimated_at', 'feasibility timeline 快照（冻结）'],
    timelineEvent: 'feasibility', actionCode: null,
    notifyAfterCommit: null,
  },
  {
    action: 'blocked',                      // 受阻（开发本人，不改 status，标 blocked=1）—— 端点 F2b
    from: ['开发中'], to: null,
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['reason'],
    sideEffects: ['blocked=1 + blocked_reason + blocked_at', 'blocked timeline'],
    timelineEvent: 'blocked', actionCode: null,
    notifyAfterCommit: 'notifyBlockedToAdmin',  // C5 落地（F2b 端点先不发，C5 补）
  },
  {
    action: 'unblock',                      // 解除受阻（admin，不改 status，blocked=0）—— 端点 F2b
    from: ['开发中'], to: null,
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['blocked=0', 'unblock timeline'],
    timelineEvent: 'unblock', actionCode: null,
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

// ── bug 流 transitions（bug流_方案_20260702_v1.2 §2/§2.3，Commit ①）──────────
//   与变更流的刻意差异（不是漏配）：
//   · 前段最短：无 schedule（建单直落 待处理，指派直达 处理中）。
//   · 无 hold/resume：暂缓有意省略（§2.2）。
//   · 无 close：已上线=终态。
//   · 无 reopen：上线后再出问题一律派生新单（§4；[覆盖]主方案 reopen）。
//   · 无 derive 条目（Commit ⑤ 随双描述 derive_reason/fix_gap_note + 反向约束一并放开——
//     ① 先不进 meta/typeFlows，端点层另有 SYS_BUG_DERIVE_PENDING 临时闸，fail-closed）。
//   · confirm-online-norelease 与变更流的 'accept'/'return' 一样走 sysIssueTransition 通用引擎，但需要
//     额外的 release_id/needs_release 双 WHERE 守卫（§8.2 [审:H1]）——由 index.js switch 分支追加 whereFrags，
//     常量层仅声明 from/to/roleGuard，实际闸门在端点实现（Commit ②）。
//   · 无 feasibility/blocked/unblock/scope_change：评估环节与范围变更均不适用 bug（建单守卫已拒 needs_feasibility）。
//   ⚠️ 权限口径（Commit ① 暂全 admin，安全侧收紧）：§3 对接人白名单（requireAdminOrBugLiaison 粗筛 +
//     handler 内 type='bug' 精判）= Commit ④，届时 assign/reassign 放开白名单；ownerGuard='assignee' 口径同变更流（严格本人）。
const BUG_FLOW_TRANSITIONS = [
  {
    action: 'create',                       // 建单（端点 POST /sys-issues，不走 transition；此条供 meta 完整性）
    from: [], to: '待处理',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['INSERT 主表 + 写 created timeline', '可选报障人 requester_*（§3 复用，不新增 reporter_*）'],
    timelineEvent: 'created', actionCode: null,
    notifyAfterCommit: null,                // 建单后路由（先通知对接人/直通开发）= Commit ④ 手动链
  },
  {
    action: 'assign',                       // 指派：待处理 → 处理中（前段直达，无排期）
    from: ['待处理'], to: '处理中',
    roleGuard: 'admin_or_bug_liaison', ownerGuard: null,   // ④ 对接人白名单放开（示例发布者/示例对接人）——仅挂 bug transition，不全局化（变更流 assign 仍 roleGuard='admin'），sysIssueTransition [3] 精判 type 隐含
    requiredPayload: ['assigned_to'],
    sideEffects: ['assigned_to/_name/assigned_at 写入'],
    timelineEvent: 'assign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',
  },
  {
    action: 'reassign',                     // 换人：处理中/待验证 → 处理中（同变更流范式；群成员同步=③）
    from: ['处理中', '待验证'], to: { '处理中': '处理中', '待验证': '处理中' },
    roleGuard: 'admin_or_bug_liaison', ownerGuard: null,   // ④ 对接人白名单放开——reassign 走独立事务（不经 sysIssueTransition [3]），故此 roleGuard 仅作 SSOT 记录，实际由端点中间件 requireAdminOrBugLiaison + handler type='bug' 精判 enforced
    requiredPayload: ['newAssignedTo', 'oldAssignedTo', 'reason'],
    sideEffects: ['assigned_to/_name/assigned_at 更新', 'dev_estimated_at 清空', '仅重置开发侧 notify_*', 'return_count 不变'],
    timelineEvent: 'reassign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',
  },
  {
    action: 'estimate',                     // 回填预计完成：处理中（态内，不改 status）
    from: ['处理中'], to: null,
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['dev_estimated_at'],
    sideEffects: ['dev_estimated_at 写入（>=assigned_at，同分钟归一化 unchanged 零写入）'],
    timelineEvent: 'estimate', actionCode: null,
    notifyAfterCommit: 'notifyEstimateToCreatorAndRequester',   // 报障人侧复用 requester_*（无报障人保持 not_sent）
  },
  {
    action: 'submit',                       // 提交修复：处理中 → 待验证（闸门：交付说明 + dev_estimated_at 非空）
    from: ['处理中'], to: '待验证',
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['summary'],
    sideEffects: ['first_submitted_at（首次永不变）', 'round_no 递增 + submit timeline',
      '（⑤ 追加）派生单首次提交 fix_gap_note 闸门（谓词 [审:H3]）'],
    timelineEvent: 'submit', actionCode: null,
    notifyAfterCommit: 'notifySubmittedToAdmin',   // dispatch 早返回不发（admin 自身）；完成通知手动链=④
  },
  {
    action: 'accept',                       // 验收通过：待验证 → 待上线（建单人；native 建单人恒 admin，T-M1 口径 roleGuard='admin'）
    from: ['待验证'], to: '待上线',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['accepted_at=now'],
    timelineEvent: 'status_change', actionCode: 'accept',
    notifyAfterCommit: null,
  },
  {
    action: 'return',                       // 验收打回：待验证 → 处理中（原因必填，return_count++）
    from: ['待验证'], to: '处理中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['return_count++', 'dev_estimated_at 清空',
      '（共享 switch 分支连带清评估+blocked 字段——bug 恒 NULL/0，零副作用）'],
    timelineEvent: 'return', actionCode: null,
    notifyAfterCommit: 'notifyReturnedToDeveloper',
  },
  {
    action: 'issue_reject',                 // 拒绝：待处理 → 已拒绝（admin，原因必填；bug 仅前段可拒）
    from: ['待处理'], to: '已拒绝',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'issue_reject',
    notifyAfterCommit: null,
  },
  {
    action: 'reactivate',                   // 重新激活：已拒绝 → 待处理（回 bug 初始态，不计返工）
    from: ['已拒绝'], to: '待处理',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['回初始态重走指派流程（reopen_count 不变）'],
    timelineEvent: 'status_change', actionCode: 'reactivate',
    notifyAfterCommit: null,
  },
  {
    action: 'void',                         // 作废：任意态 → 已作废（admin，软删除 + 死锁逃生口，§2.2）
    from: '*', to: '已作废',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['软删除，前端隐藏', '（共享 switch 分支连带清 blocked 三件套——bug 恒 0，零副作用）'],
    timelineEvent: 'status_change', actionCode: 'void',
    notifyAfterCommit: null,
  },
  // ── [v1.6 退场] Commit ② 曾追加的两条确认上线路径 + 填发版信息（bug流_方案_20260702_v1.2 §8）──────────
  //   通知改造 v1.6 §2.3 [C-1 旧入口替换矩阵] 已把 待上线→已上线 的唯一入口收敛到
  //   assign-release-dev + execute-release（见下方新增两条）。三条旧 meta 条目
  //   set_release_flag / publish / confirm-online-norelease **整体移除**（非仅端点层拒绝）——
  //   findTransition('bug', 这三个 action, 任意态) 从此恒返 null，端点侧另加 type='bug' 早期显式
  //   LEGACY_RELEASE_FLOW_DISABLED 拒绝（更友好的错误信息，早于 findTransition 判断）。
  //   ⚠️ ACTION_LABELS 里这三个动作的中文标签**保留不删**（见下方，历史 timeline 行仍需渲染 action_code）。
  //   变更流（feature/improvement）从未定义这三个 action，本次移除零影响（CHANGE_FLOW_TRANSITIONS 独立数组）。
  {
    action: 'assign-release-dev',           // 上线编排①：建单人批量指定上线开发（写 release_assignee_id，§2.3 C3b，G3）
    from: ['待上线'], to: null,             // 不改 status；批量端点（POST /sys-issues/assign-release-dev）独立实现，
                                             //   不走 sysIssueTransition/findTransition（本条目仅供 buildMeta 前端展示/文档一致性）
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['issue_ids', 'release_assignee_id'],
    sideEffects: ['release_assignee_id/_name 写入（批量，先整批资格校验，任一失败整批不落库，H-4）',
      '仅允许"未指定执行人"或"同人幂等重提"；改 A→B 须走 reassign-release-dev（M-1）'],
    timelineEvent: 'note', actionCode: 'assign_release_dev',
    notifyAfterCommit: null,
  },
  {
    action: 'execute-release',              // 上线编排②：被指定开发执行上线（mode=hotfix|publish，§2.3 C3b，G5/G6）
    from: ['待上线'], to: '已上线',
    roleGuard: null, ownerGuard: null,      // 权限=actor.id===release_assignee_id（H-1，独立端点内校验，非常规二元 guard 模型）
    requiredPayload: ['mode'],
    sideEffects: ['mode=hotfix：单 issue 不建批次，release_id/version_tag 保持 NULL（H-2/H-3）',
      'mode=publish：单事务建/更 sys_releases 批次（复用 _publishReleaseCoreInTxn 内核）+ release_id/version_tag 写入',
      'F2：不自动触发任何通知（建单人通知走手动 notify-creator，G8）'],
    timelineEvent: 'release', actionCode: null,
    notifyAfterCommit: null,
  },
  // ── Commit ⑤ 追加：派生（bug流_方案_20260702_v1.2 §4）──────────
  //   ① 起端点层 SYS_BUG_DERIVE_PENDING 临时闸 + 本 meta 无 derive 条目双重 fail-closed；⑤ 一并放开。
  //   与变更流 derive 的差异：from=['已上线']（§4「仅从已上线单发起」，非 '*'）——bug 上线后再出问题才派生新单。
  //   非状态 transition（不改本单 status，to=null）：走独立端点 POST /derive（非 sysIssueTransition 引擎），
  //   此条仅供 META.typeFlows 前端长按钮；derive_reason 必填/M5 反向约束/防环均在端点精判（origin.type 依赖运行时）。
  {
    action: 'derive',                       // 派生迭代：已上线 → 新建一单（admin，防环，§4/§5.1）
    from: ['已上线'], to: null,             // 新建单，不改原单 status
    roleGuard: 'admin', ownerGuard: null,
    // 新单建单字段。[codex L-1 部分采纳] requiredPayload 仅通用 transition 引擎消费，derive 走独立端点
    //   POST /derive 不校此表 = 纯文档；且 origin.type='bug' 时 type 可省略、端点默认 'bug'（M5）——
    //   故 'type' 语义是"常规必填 / bug 派生可省"，保留以示常态契约（删除反而误导读者以为 type 从不需要）。
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['新建单 origin_issue_id=原单 id', '先写 created 再写 derive（T-L3）', '防环 M-1',
      '（⑤）origin=bug 须已上线 + derive_reason 必填 + 新单默认 bug（M5）'],
    timelineEvent: 'derive', actionCode: null,
    notifyAfterCommit: null,
  },
];

// 全部 transitions（按 type 组织；config 追加时 concat）。
const TRANSITIONS = {
  feature: CHANGE_FLOW_TRANSITIONS,
  improvement: CHANGE_FLOW_TRANSITIONS,    // 变更流两类型共用同一份（共享尾段 + 共享前段，§3.3）
  bug: BUG_FLOW_TRANSITIONS,               // bug 流（bug流_方案_20260702_v1.2，Commit ① 起）
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

// 旁路动作白名单（不改 status 的就地副作用动作，前端路由专用端点 /feasibility /blocked /unblock /estimate /scope-change /derive）——
//   codex 20 L-1：显式白名单替「to===null 推断」，新增动作默认 transition（安全侧），避免 resume 类「to=null 但动态解析 status」误标。
// ⚠️ set_release_flag 已随 v1.6 退场从 BUG_FLOW_TRANSITIONS 移除（不再有该 action 的 typeFlows 条目），
//   本白名单集不因此报废——保留字面量对 KIND_EXPECT 类测试无害（Set.has 对不存在的 action 从不命中，
//   不影响 buildMeta 分类）；新增 assign-release-dev（不改 status，真旁路）入本白名单，execute-release
//   （真改 status 为 已上线）不入，走默认 'transition' 分类。
const SIDE_EFFECT_ACTIONS = new Set(['estimate', 'feasibility', 'blocked', 'unblock', 'derive', 'scope_change', 'set_release_flag', 'assign-release-dev']);

// ── 开发工作态统一判定（bug 方案 [审:M4] isDevWorkState，Commit ①）──────────
//   「开发正在干活」的态名按类型不同（变更流=开发中 / bug=处理中 / config 追加时=处理中），
//   附件上传守卫、TOCTOU 复查等**散落 status 判断**一律走本 helper，杜绝「开发中」硬编码漏掉 bug 处理中。
//   ⚠️ estimate/submit 等 transition 类动作不需要它——findTransition 的 from 白名单已按 type 收窄；
//     feasibility/blocked/unblock 端点是评估环节专属（feature/improvement-only，type 守卫前置），
//     其「开发中」硬编码是类型限定下的有意写法，不在本 helper 替换范围。
const DEV_WORK_STATUS_BY_TYPE = {
  feature: '开发中',
  improvement: '开发中',
  bug: '处理中',
  // config: '处理中',   // TODO 追加 config 流时填（§18.2）
};
function isDevWorkState(type, status) {
  return !!status && DEV_WORK_STATUS_BY_TYPE[type] === status;
}

// RC-M5 状态级不变量的目标态全集（跨类型 union）：进入这些态必须有 assigned_to（开发负责人）。
//   状态名跨类型无歧义冲突：待处理/待评估/已排期=未指派前段不在内；处理中(bug)/开发中(变更流) 起必有开发。
const REQUIRES_ASSIGNEE_STATUSES = ['开发中', '处理中', '待验证', '待上线', '已上线', '已关闭'];

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
    feasibility: '可行性评估', blocked: '标记受阻', unblock: '解除受阻',
    // scope_change label 为 config 流预留（feature/improvement 已移除该动作，typeFlows 不含）——
    //   meta.actions 是全动作 label 超集，前端按 typeFlows 显隐按钮，故残留此 label 无害（ultracode 对抗审确认）。
    scope_change: '范围变更', derive: '派生迭代',
    // bug 流 Commit ②：确认上线两路径 + 填发版信息 ——⚠️ 标签保留供历史 timeline 行渲染 action_code
    //   （v1.6 §2.3 [C-1 回填]：三条 action 已从 BUG_FLOW_TRANSITIONS 移除退场，但历史单曾产生的
    //   timeline 行 action_code 仍是这几个字面量，meta.actions 是全动作 label 超集，删标签会让
    //   历史行渲染成空白/undefined，故仅删 TRANSITIONS 条目、不删本处标签）。
    set_release_flag: '填发版信息', 'confirm-online-norelease': '确认上线（不发版）',
    // 通知改造 v1.6 §2.3 新增：上线编排两动作
    'assign-release-dev': '指定上线开发', 'execute-release': '执行上线',
  };

  for (const type of Object.keys(TRANSITIONS)) {
    statusLabels[type] = ALLOWED_STATUSES[type] || [];
    typeFlows[type] = transitionsForType(type).map(t => ({
      action: t.action,
      from: t.from,                              // 数组 / '*'
      to: t.to,                                  // 字符串 / 映射 / null（前端据此判断是否旁路动作）
      requiredPayload: t.requiredPayload || [],
      kind: SIDE_EFFECT_ACTIONS.has(t.action) ? 'side_effect' : 'transition',   // codex 17 M-1 + codex 20 L-1：显式白名单判定旁路动作（路由专用端点），新增动作默认 transition；resume 虽 to=null（动态解析 status）但不在白名单 → 正确标 transition
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
  // bug 流 Commit ①（[审:M4] 开发工作态统一判定 + RC-M5 目标态全集）
  DEV_WORK_STATUS_BY_TYPE,
  isDevWorkState,
  REQUIRES_ASSIGNEE_STATUSES,
};
