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
const BIZ_SYSTEMS = ['BMS', 'HRD', '电子签', '客户报销平台', '其他'];   // 2026-08-17 追加「客户报销平台」+ 移除「OA」「智数协同」（用户拍板：两系统不在维护范围·生产存量均 0 张核实后干净移除·verify-sys-meta 断言同步）

// ── 类型 → 无受理分支的初始态（建单未选对接人时落地态，受理排期改造 §9）──────────
//   ⚠️ 受理排期改造：初始态不再是单一常量——依 intake_required 分两支（选对接人→待受理 / 未选→本表）。
//   本表 = intake_required=0（无受理）分支：变更（feature/improvement）→待指派（消歧「待评估」）/ bug→待处理 / config 留位。
//   历史「待评估」态语义拆分：admin triage 的「待评估」→「待指派」（受理通过后待派开发），开发技术评估仍叫「可行性评估」。
const INITIAL_STATUS_WITHOUT_INTAKE_BY_TYPE = {
  feature: '待指派',
  improvement: '待指派',
  bug: '待处理',           // bug 前段最短（建单直落 待处理，bug 方案 §2.1）
  // config: '待处理',     // TODO 追加 config 流时填
};

// resolveInitialStatus(type, intakeRequired)：建单/派生/reactivate 落态唯一权威（受理排期改造 §9）。
//   intakeRequired 必须已由调用方归一化为 0/1（严格布尔）；1→'待受理'（进受理门），0→无受理分支（本 type 的 WITHOUT_INTAKE 态）。
//   非法 type/flag → throw（fail-closed，禁静默落错态）。create.to=null 的机器契约配套（§9 create/derive/reactivate 均调本函数）。
function resolveInitialStatus(type, intakeRequired) {
  if (intakeRequired !== 0 && intakeRequired !== 1) {
    throw new Error(`resolveInitialStatus: intakeRequired 必须已归一化为 0/1，实际=${intakeRequired}`);
  }
  const withoutIntake = INITIAL_STATUS_WITHOUT_INTAKE_BY_TYPE[type];
  if (!withoutIntake) throw new Error(`resolveInitialStatus: 未知/未登记 type="${type}"`);
  return intakeRequired === 1 ? '待受理' : withoutIntake;
}

// ── 角色权限重构 C2.5（方案 v1.9 §4-C2.5）：预沟通段常量 ────────────────────────────────
//   业务来由：真实流程里"admin 判需求合不合理"与"和开发讨论能不能做"都发生在**业务方走 OA 之前**，
//   而被拒绝的需求永远不会有 OA 单 → 原设计（起点=OA 之后的「待受理」）让这一段决策永久无痕。
//   C2.5 把单据生命周期起点前移到「待商议」，拒绝走已有的 issue_reject（原因必填）。
// ⚠️ **命名避坑**：平台曾有过「待评估」态（受理排期改造砍掉，index.js 的 C1_LEGACY_STATUSES 里还留着
//   它作迁移识别用）。新态**必须叫「待商议」**，与历史迁移语义不撞车。
// ⚠️ **bug 不走本段**：生产故障没有"合不合理/能不能做"的讨论空间，也不走 OA（用户 2026-07-27 拍板）。
// （C2.5 撤销·方案 v2.1）预沟通段的两个专属常量已删——
//   预沟通段废除后已无任何消费方（grep 归零核实）；verify-sys-pre-discuss [S] 哨兵断言两者恒 undefined。

// ── 角色权限重构 C0（方案 v1.5 §4-C0）：**创建路径落态唯一入口**──────────────────────────
//   ⭐ 受理门焊死：全类型（bug/feature/improvement·config 无 transitions 不适用·v1.5 §2.6）建单必经受理，
//     故创建落态**恒 intake_required=1 → '待受理'**，不再由调用方/客户端决定。
//   ⚠️ **本函数不收 intakeRequired 参数**（方案 v1.5 §4-C0「内部固定 intake=1、不收外部参数」）——
//     这是"焊死"的实现手段：参数一旦开放，创建入口就能再次绕过受理门（v1.4 前 derive 硬编码 0 即此类漏洞）。
//   ⚠️ 创建入口共 3 个（v1.5 §2.4 枚举闭合·routes/ 下无复制/批量导入/后台任务入口）：
//     index.js 建单 INSERT / derive 新单 INSERT / reactivate 落态 UPDATE —— **三者必须且只能调本函数**。
//     verify-sys-intake-gate.js 以源码扫描断言"index.js 创建路径不再直调 resolveInitialStatus"锁定该不变量。
//   ⚠️ resolveInitialStatus 本身保留未删，但**已无任何直调方**：原唯一消费者 change_intake_mode 的实现体
//     随 C0 删除（该路由现在只返 409），index.js 的直调数已归零并被 verify 源码扫描断言锁定。
//     它现在仅作为本函数的内部实现，以及 buildMeta 组装 initialStatusesByType 两分支时的取值来源；
//     `intakeRequired=0` 分支已是纯历史遗留，由 C5 末次审决定是否连同 meta 的 without_intake 字段一并清理。
//   ⚠️ **config 不在本模块的支持范围**：ALLOWED_STATUSES / TRANSITIONS 均无 config 键，
//     本函数对 config 会 fail-closed 抛错，建单入口先以 400 TYPE_NOT_SUPPORTED 拒绝
//     （verify-sys-intake-gate [I]/[C1] 各有断言钉死）。文件早期注释里"四类型含 config"是历史表述，以此处为准。
//   ⭐ **C2.5（v1.9）起按 type 分流**：变更流（feature/improvement）落「待商议」进预沟通段；bug 仍落「待受理」。
//     ⚠️ 分流点只此一处——三个创建入口（建单 / derive / reactivate）与 status-transition-guard 的
//     CREATE 边、reactivate 动态边**全部改调本函数**，不再各自持有一份"合法初始态集"副本
//     （C1+C2 对抗审 F1「两份清单必然漂移」的直接应用：v1.8 只改本函数就会让 guard 当场分叉 → 建单 409）。
//     ⚠️ **`intake_required` 与本次分流正交**：新态在受理门**之前**，DB 触发器只判 `NEW.intake_required IS NOT 1`
//     （intake-gate-sql.js·与 status 无关），故创建仍恒 intake=1、受理门仍必经，**C0 焊死不作废**。
//     ⚠️ reactivate（已拒绝复活）随本函数自动回「待商议」重走预沟通（用户拍板）——这正是"唯一入口"的价值：
//     不为它开分叉参数，否则 C0 焊死的"落态不受调用方影响"就破了。
//   ⭐⭐ C2.5 撤销（方案 v2.1·2026-07-28）：预沟通段废除，**全类型恒落「待受理」**——"建单即代表该做"
//     （用户澄清：不存在 admin 判"该不该做"的环节，业务沟通在建单前完成）。分流逻辑删除；
//     "唯一入口"性质不变（建单/derive/reactivate 与 guard 仍全部调本函数），C0 焊死不作废（intake 恒 1）。
function resolveSysInitialStatusForCreate(type) {
  return resolveInitialStatus(type, 1);
}

// ── 每个 type 的合法状态集（§3.3 变更流 + §3.4 旁路态·受理排期改造 §4.1）──────────
//   受理排期改造：删「待评估/已排期」→ 加「待受理/待修改」(INTAKE 族) +「待指派」(D_PRE 族·受理通过落态)。
//   角色权限重构 C2.5：**队首加「待商议」**（预沟通段·OA 之前·仅变更流）——数组顺序即前端状态筛选/流程图展示序，
//     新态是整条流的真实起点，必须排在「待受理」之前。
//   角色权限重构 C2.5 撤销（方案 v2.1）：「待商议」从状态集移除——预沟通段废除，建单直落「待受理」。
// [工期对接测试与风险等级拆分 方案 v1.1 §3.1-1·C4] 状态集分裂——feature 独有「待对接测试」（全员提交+GATE
//   通过后、对接人测试验收前的态，插在「开发中」与「待验证」之间，同 status-families.js LIAISON_TEST 族
//   顺序），improvement 沿用原状态集不变。C0 矩阵验证清单 §F-3 钉死"拆分必须"，两 key 各自显式列出
//   （不用共享引用别名）——同 status-families.js 文件头 :19-22 的"独立誊抄范式"，防未来两流分裂时漏改其一。
const FEATURE_FLOW_STATUSES = [
  '待受理', '待修改', '待指派', '开发中', '待对接测试', '待验证', '待上线', '已上线', '已关闭',  // 主流程
  '已暂缓', '已拒绝', '已作废',                                                                  // 旁路态（§3.4）
];
const IMPROVEMENT_FLOW_STATUSES = [
  '待受理', '待修改', '待指派', '开发中', '待验证', '待上线', '已上线', '已关闭',  // 主流程（无对接测试段）
  '已暂缓', '已拒绝', '已作废',                                                    // 旁路态（§3.4）
];
// bug 流状态集（bug 方案 §2.2 + 受理排期改造 §4.1 + 上线体统一重构 §6.5 + bug暂缓方案 v0.4 §4.1）：加
//   「待受理/待修改」(受理门·用户拍板 bug 也走)。⭐ [bug暂缓方案 20260803 v0.4 §4.1] bug 流原"无 已暂缓
//   （暂缓有意省略）"的设计已被推翻——本方案兑现 `bug流_方案_20260702_v1.0.md:68` 当年留的预留口子，
//   补上「已暂缓」态（见下方 BUG_FLOW_TRANSITIONS 新增 hold/resume 两条目）。
//   ⭐ [C6·方案 v3.4 §6.5] 补「已关闭」终态——原"bug 已上线即终态、上线后再出问题一律派生新单"的设计
//   作废：归档改为全类型统一复用 close（已上线→已关闭），BUG_FLOW_TRANSITIONS 新增 close/reopen 两条目
//   （见下方，reopen 目标态回「处理中」，与 change 流回「开发中」对称）。
const BUG_FLOW_STATUSES = [
  '待受理', '待修改', '待处理', '处理中', '待验证', '待上线', '已上线', '已关闭',   // 主流程（已关闭=归档终态，§6.5）
  '已暂缓',                                                              // ← 新增（bug暂缓方案 20260803 v0.4）
  '已拒绝', '已作废',                                                     // 旁路态
];
const ALLOWED_STATUSES = {
  feature: FEATURE_FLOW_STATUSES,
  improvement: IMPROVEMENT_FLOW_STATUSES,
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
// [工期对接测试与风险等级拆分 方案 v1.1 §3.1-1·C4] 边集分裂——feature/improvement 原共用同一份数组引用
//   （C0 矩阵验证清单 §F-3："拆分必须"），现各自独立成数组（同上方状态集分裂动机：feature 的 submit 边
//   目标改为动态 GATE 解析 + 新增 liaison_test_pass/return 两条边，improvement 不受影响、原样保留）。
//   IMPROVEMENT_FLOW_TRANSITIONS 是原 CHANGE_FLOW_TRANSITIONS 的逐字保留（除下方"新单默认
//   intake_required=0"过时残留注释订正外，无其余改动）；FEATURE_FLOW_TRANSITIONS 见其后。
const IMPROVEMENT_FLOW_TRANSITIONS = [
  {
    action: 'create',                       // 建单（端点 POST /sys-issues，不走 transition，单独 INSERT；此条供 meta 完整性）
    // 受理排期改造 §9：create.to 改机器契约——落态由 resolveInitialStatus(type,intake_required) 动态解析（选对接人→待受理 / 未选→待指派），
    //   不可静态读；to:null + dynamicTarget:'initial_status' + targetEntity:'current_issue'（作用当前单）。buildMeta 原样暴露标记。
    from: [], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['INSERT 主表 + 写 created timeline'],
    timelineEvent: 'created', actionCode: null,
    notifyAfterCommit: null,
  },
  // ── （C2.5 撤销·方案 v2.1）"预沟通通过"条目已删除——预沟通段废除，OA 号改为受理后经
  //    set-oa-number 端点补填（§4-R4），变更流指派前守卫必有号 ──────────
  // ── 受理门动作（受理排期改造 §5·intake_required=1 才走）──────────
  // ⭐ 用户拍板批1改造B（2026-08-06）：risk_level 必填面从"仅 feature"扩到"feature+improvement"——
  //   本条目属 IMPROVEMENT_FLOW_TRANSITIONS 专属数组，requiredPayload 从 [] 改为 ['risk_level']，
  //   与 FEATURE_FLOW_TRANSITIONS 的同名条目现已对齐（两个独立对象改一处不影响另一处，同上方数组
  //   拆分动机注释——此前是"feature 专属能力不泄漏到 improvement"的示例之一，现该示例已不成立，
  //   两流在 risk_level 必填这件事上重新合流；"待对接测试"段等其余 feature 专属能力不受影响）。
  {
    action: 'intake_accept',                // 受理通过：待受理 → 待指派（对接人∨admin，风险等级必填）
    from: ['待受理'], to: '待指派',
    roleGuard: 'intake_liaison', ownerGuard: null,   // 引擎侧 intake_liaison∨admin（roleGuard 语义见 index.js requireIntakeLiaison）
    requiredPayload: ['risk_level'],
    sideEffects: ['risk_level 与 status 同一 UPDATE 原子落库'],
    timelineEvent: 'status_change', actionCode: 'intake_accept',
    notifyAfterCommit: null,
  },
  {
    action: 'intake_return',                // 受理退改：待受理 → 待修改（对接人∨admin，原因必填）
    from: ['待受理'], to: '待修改',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['notify 建单人（退改需修改）'],
    timelineEvent: 'status_change', actionCode: 'intake_return',
    notifyAfterCommit: null,                // 通知由端点显式发（§8.2 note 不自动触发 notifyAfterCommit）
  },
  {
    action: 'resubmit_intake',              // 修改后重新提交：待修改 → 待受理（建单人∨admin）
    from: ['待修改'], to: '待受理',
    roleGuard: 'creator_or_admin', ownerGuard: null,   // 授权=created_by∨admin（§5.3·codex131-H1 修：roleGuard 与意图同源·引擎按 row.created_by 事务内校验）
    requiredPayload: [],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'resubmit_intake',
    notifyAfterCommit: null,                // 本期不发·待受理列表驱动（§4.5）
  },
  {
    // ⭐ C2.5 撤销（方案 v2.1 §3）：谓词回「待受理」——预沟通段废除，"对接人拿不准转技术负责人"发生在
    //   待受理阶段（转不转都不改状态·"都是开发团队的评估时长"）。至此与 bug 侧同值（全类型待受理）。
    action: 'request_tech_consult',         // 发起技术负责人沟通：待受理 → 待受理（对接人∨admin，选技术负责人）
    from: ['待受理'], to: null,             // 旁路·不改 status（选技术负责人·通知发送 S5 起改手动）
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['tech_lead_id'],
    sideEffects: ['tech_lead_id/_name 写入', '通知列组重置为 not_sent（S5 手动化：不自动发送·用户点「发送通知」经 resend-tech-consult 发·方案 v2.1 §6）'],
    timelineEvent: 'note', actionCode: 'request_tech_consult',
    notifyAfterCommit: null,                // 本动作不发送通知（S5 手动化）；用户后续经 resend-tech-consult 手动发
  },
  {
    // 建单优化批 C3（方案 20260731_v1.2 §6）：编辑窗口两档扩展——from 从单一「待修改」扩至 A 档
    //   （待受理/待修改/待指派）+ B 档（开发中，剔除 needs_feasibility）；待验证起冻结不变。字段档位
    //   由端点 handler 事务内按真实 status 判定（§6.2 并发终闸），本 from 仅供前端按钮可见性镜像。
    action: 'edit_in_revision',             // 编辑内容：指派前/开发期均可编辑（建单人∨admin·旁路）
    from: ['待受理', '待修改', '待指派', '开发中'], to: null,
    roleGuard: 'creator_or_admin', ownerGuard: null,   // 授权=created_by∨admin（§5.3·codex131-H1 修·引擎按 row.created_by 校验）
    requiredPayload: [],
    sideEffects: ['两档白名单字段更新（建单优化批 C3·方案 §6.1）', 'note timeline 快照改动字段'],
    timelineEvent: 'note', actionCode: 'edit_in_revision',
    notifyAfterCommit: null,
  },
  {
    action: 'change_intake_mode',           // 切换受理模式：待受理/待修改/待指派 → §5.4 真值表（admin，原因必填）
    from: ['待受理', '待修改', '待指派'], to: null,   // 动态·§5.4 真值表（开↔关切换目标态因 status 而异）
    dynamicTarget: 'intake_mode', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['intake_required 翻转 + status 同事务切换（§5.4）'],
    timelineEvent: 'status_change', actionCode: 'change_intake_mode',
    notifyAfterCommit: null,
  },
  {
    action: 'assign',                       // 指派：待指派 → 开发中（admin ∨ 受理人，被指派人非 viewer）
    from: ['待指派'], to: '开发中',         // 受理排期改造：from 由「已排期」改「待指派」
    // ⭐ 角色权限重构 C1（方案 v1.5 §4-C1）：指派权由 admin 扩到「admin ∨ 受理人[13]」**全类型**。
    //   ⚠️ 这一处是 v1.4 的**阻断级漏项**：v1.4 只写了处置 bug 流的 'admin_or_bug_liaison'，漏了变更流这条
    //     仍是 'admin' —— 不改的话示例对接人指派 feature/improvement 会在引擎 [3] 被 `roleGuard==='admin' && !isAdmin`
    //     直接 403，「受理人全类型主导」这个 C1 核心目标根本跑不通（v1.5 §2.2 源码核实时发现）。
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['assigned_to'],
    sideEffects: ['assigned_to/_name/assigned_at 写入'],   // codex 14 L-1：DDL 无 assigned_by 字段（系统迭代 admin 集中主导，"谁指派"恒 admin 不单记）
    timelineEvent: 'assign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5 落地
  },
  {
    // 重新指派（M3·91 号审 v2.9 重写，MED-2/LOW·92 号审补 from）：改派开发集合（member_ids 声明式差量），
    //   不走 sysIssueTransition/findTransition（独立事务，端点 POST .../reassign 自行处理）。to 目标态不再是
    //   静态映射——去主次化后 assigned_to 纯派生，实际主状态变化（若有）由 W-GATE 依 roster 完成态判定，事前
    //   不可静态得知，故仿 resume 用 to:null 动态解析语义标注（本条目不在 SIDE_EFFECT_ACTIONS 白名单，
    //   buildMeta 仍正确归类 kind='transition'）。dev_estimated_at 清空语义随旧"换主清进度"概念一并废除
    //   （v2.9 §3 无此要求，去主次后无"主"可清）。
    // C2c（2026-07-18 交互优化·用户实测发现）：from 去掉 D_PRE 族（待评估/已排期/已暂缓），只留 DEV/VERIFY
    //   （开发中/待验证）。**背景**：92 号审曾把 from 补 D_PRE 以与矩阵同源，但去主次后「已排期」态本无在册
    //   开发成员（首次指派走 assign：已排期→开发中），reassign（改派现有集合）在此无实际对象——却让「已排期」
    //   态同时渲染 assign(指派) + reassign(改派) 两按钮共存，逻辑上未进开发的态只应有「指派」。故收窄 from。
    //   **写读同源铁律**：前端 from 收窄的同时必须同步后端真校验 MEMBER_ACTION_FAMILY_MATRIX.reassign（index.js:1030
    //   `['D_PRE','DEV','VERIFY']`→`['DEV','VERIFY']`），否则前端不显但后端仍放行=写宽读窄。已暂缓（D_PRE）改派
    //   诉求随之收敛：暂缓单需先 resume 回开发中再改派（暂缓态本就无活跃开发编排）。
    action: 'reassign',
    from: ['开发中', '待验证'], to: null,
    // ⭐ 角色权限重构 C1：同 assign 扩到「admin ∨ 受理人[13]」。
    //   ⚠️ reassign 走独立事务（不经 sysIssueTransition [3]），故此 roleGuard 仅作 **SSOT 记录**——
    //     实际闸门是端点中间件 requireIntakeLiaison + handler 的 isSysCoordinator 精判。
    //     即便如此也必须同步改：buildMeta 把它暴露给前端做按钮显隐，不改会造成「前端不显但后端放行」的写宽读窄。
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['member_ids', 'reason'],
    sideEffects: ['开发集合差量应用（新增 INSERT pending / 移除软删）', '选举 electRepresentative 重算 assigned_to/_name（assigned_at 仅首次形成时补写）', 'W-GATE 按新 roster 完成态判定主状态是否联动', '仅代表真实变化时才 notifyAssignedDeveloper（不再按 toAdd.length 判定）', 'return_count 不变（05-M2，v2.9 沿用）'],
    // LOW（92 号审）：timelineEvent 置 null——成员动作只写 sys_issue_dev_events，不进 sys_issue_timeline
    //   （M4/91 号审拍板：主状态变化才写 timeline，成员差量本身不写；本字段目前无消费方，此前留
    //   'reassign' 是历史静态映射时代的残留，纯误导，去掉防未来误接线）。
    timelineEvent: null, actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5；实际触发条件见端点内 repChanged 判定
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
    action: 'set_scheduled_start',          // 定计划开工日：开发中（不改 status·须 dev_estimated_at 非空·admin·参考字段）—— 受理排期改造 §7.2
    from: ['开发中'], to: null,             // 旁路·YYYY-MM-DD·可传 null 清除
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['scheduled_start'],   // 端点校 dev_estimated_at 非空 + 日期格式
    sideEffects: ['scheduled_start 写入/清除（参考字段·非闸门·§7.2）'],
    timelineEvent: 'note', actionCode: 'set_scheduled_start',
    notifyAfterCommit: null,
  },
  {
    action: 'submit',                       // 提交：开发中 → 待验证（dev_estimated_at 非空 + 提交双勾）—— 端点 C3
    from: ['开发中'], to: '待验证',
    roleGuard: null, ownerGuard: 'assignee',
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.3·C3] 原 ['summary'] 是历史遗留字段——W05 唯一 submit
    //   收敛（C2/C3，多开发 commit 事件模型）已把请求体收窄为 mode=no_code|commits 二选一，validateSubmitBody
    //   的 ALLOWED_TOP_KEYS 里从未有过 'summary'，字面发送该键反而会被判"不支持的字段"拒绝——本条目此前
    //   一直是失真的死数据（无测试锁定其值，顺手一并订正，非本次功能引入的新问题）。改列 §3.3 新增的
    //   提交双勾（三类型通用、无条件必填，恒等 true 才能提交）；mode/no_code_reason/commits 是条件必填
    //   （随 mode 分支），沿用 feasibility.requiredPayload 的既有惯例不列条件字段，只列无条件必填项。
    requiredPayload: ['self_tested', 'test_env_deployed'],
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
    sideEffects: ['return_count++（U-2）', 'dev_estimated_at 清空（T-M2）', 'scheduled_start 清空（受理排期改造 §7.2·预计变则开工日失效）'],
    timelineEvent: 'return', actionCode: null,
    notifyAfterCommit: 'notifyReturnedToDeveloper',  // C5
  },
  // [C3 退场，方案 v3.4 §6.7/§6.14] 原 'publish' 条目（待上线→已上线，走 publishReleaseTransition/legacy
  //   /sys-releases/:id/publish）已删除——该端点本身现全类型 409（LEGACY_RELEASE_FLOW_DISABLED，见
  //   index.js 路由），发布唯一合法入口收窄为 /sys-releases/:id/execute（中心守卫自读自判）。本条目
  //   "无路由通过 sysIssueTransition 引擎实际触发"（HTTP 层从未注册 POST /sys-issues/:id/publish），
  //   数据库实测 sys_issue_timeline 里 action_code='publish' 历史行数=0（2026-07-29 主会话核实），
  //   故直接删除条目本体，不留"退役但保标签"式兼容（那是给*真有历史行*的旧动作用的，如 schedule/
  //   pre_discuss_pass；本条目没有这个负担）。ACTION_LABELS 里的 publish 标签同步删除（见下方 `label`
  //   常量块）。⚠️ 副作用：feature/improvement 的 typeFlows 不再含 publish 动作，前端「单条上线」按钮
  //   （现接 hotfix-publish，Sys_Iteration.html action==='publish' 分支）会随之消失，需第2批前端一并
  //   重接新版「安排上线」入口——本批只做后端，交付报告已记录此依赖。
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
    action: 'hold',                         // 暂缓：活跃态 → 已暂缓（admin，原因必填）
    // 受理排期改造 §4.2/§B（129-H1）：from 去「待评估/已排期」（态已删）+ 去「待受理/待修改」（INTAKE 族·禁受理阶段暂缓）——
    //   若允许 INTAKE→hold→已暂缓(D_PRE)，因 add/remove 允许 D_PRE 会形成「待受理→暂缓→加减成员→resume 回待受理」绕过受理门。
    //   受理阶段未进开发无需暂缓·要缓走 intake_return 退改。
    from: ['待指派', '开发中', '待验证', '待上线'], to: '已暂缓',
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
    // ⚠️ [行为变更] requiredPayload 从 [] 改为 ['reason']（bug暂缓方案 20260803 v0.4 口径 #1：两流 resume
    //   统一必填理由——bug 流新增的 resume 条目本就理由必填，变更流不能是"同名动作两套契约"）。既有调用方
    //   （前端弹窗 + verify 脚本）须同步补传 reason，否则 400（方案 §10.3 回归清单）。
    requiredPayload: ['reason'],
    sideEffects: ['恢复到最近一次进入暂缓前的活跃态（校验属当前 type 合法活跃态，否则 409）'],
    timelineEvent: 'status_change', actionCode: 'resume',
    notifyAfterCommit: null,
  },
  {
    action: 'reactivate',                   // 重新激活：已拒绝 → 初始态（admin，不计返工，RC-M1）
    // 受理排期改造 §9：to 动态解析（resolveInitialStatus 读单据当前 intake_required·1→待受理·0→待指派）·不固定待指派。
    from: ['已拒绝'], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['回初始态重走受理/指派流程（reopen_count 不变）'],
    timelineEvent: 'status_change', actionCode: 'reactivate',
    notifyAfterCommit: null,
  },
  {
    action: 'issue_reject',                 // 拒绝：待受理 → 已拒绝（**仅受理人**·意见前置·原因必填）
    // ⭐⭐ C2.5 撤销 + R2 重构（方案 v2.1 §2/§3·用户拍板）：
    //   · from 收回单值「待受理」（待商议随预沟通段废除）。
    //   · roleGuard='intake_liaison_only'（**新增值·排除 admin**）：拒绝语义=开发方回绝需求，天然属对接人；
    //     admin=建单人，"建单即该做"，事后确实不能做走 void 作废（用户原话拍板）。判定只看 uid∈受理人
    //     白名单不看 role（双身份 uid∈白名单即放行·方案 §2 矩阵 190 号钉死）。bug 条目不受影响（保持 admin）。
    //   · 前置守卫「当前轮已有评估意见」在引擎执行器内（同事务·非本表可表达），见 index.js R2 守卫段——
    //     未咨询/未回复 → 409 REJECT_REQUIRES_TECH_COMMENT（"拒绝的依据必须是技术负责人的意见"）。
    from: ['待受理'], to: '已拒绝',
    roleGuard: 'intake_liaison_only', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['前置守卫：当前轮已有 tech_lead_comment（引擎执行器·REJECT_REQUIRES_TECH_COMMENT）'],
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
    // ⭐ [C6·方案 v3.4 §6.5] from 收窄为**仅** `['已关闭']`（原 `['已上线', '已关闭']`）——重开前必须先
    //   「归档」（close），不再允许从「已上线」直接重开。附录 A 明列「reopen｜admin·已上线（未归档）｜
    //   ❌ 409（须先归档）」：findTransition 对 from=已上线 现查无此边（返 null），index.js
    //   sysIssueTransition [1] 对这一具体组合（action='reopen' && fromStatus='已上线'）额外精判返
    //   409 ISSUE_NOT_ARCHIVED（而非泛化的 400 INVALID_TRANSITION），语义更贴近"动作合法但业务前置未满足"。
    action: 'reopen',                       // 重开：已关闭 → 开发中（admin，计返工，§3.5，§6.5 收窄）
    from: ['已关闭'], to: '开发中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['reopen_count++', 'reopened_at=now', '清 accepted_at/released_at/closed_at/release_id/dev_estimated_at/scheduled_start/online_source/post_release_acceptance/post_accepted_at/post_derive_issue_id（first_submitted_at 永不变·受理排期改造 §7.2；online_source 三件套=组 B·SB2 预筛 HIGH-1，重开=新一轮，上一轮"怎么上线的+补验收进度"一并作废，见 index.js case \'reopen\'）'],
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
    // [工期对接测试与风险等级拆分 方案 v1.1 §2·C4 收口] 订正过时残留注释——原文"新单默认
    //   intake_required=0"已不准确：受理覆盖面运行时真相核实（resolveSysInitialStatusForCreate
    //   实现·index.js）显示普通建单/derive 派生/reactivate 复活**三入口全部**恒 INSERT
    //   intake_required=1（受理门焊死后无绕过路径），derive 新单不例外。to:null·kind='side_effect'
    //   （不改原单），但**新单**落态用 createdIssueDynamicTarget（非共用 dynamicTarget·区分目标属
    //   当前单还是新单）+ targetEntity='created_issue' 动态解析——解析结果恒为「待受理」，非"默认 0"。
    from: '*', to: null, createdIssueDynamicTarget: 'initial_status', targetEntity: 'created_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],  // 新单建单字段 + origin_issue_id
    sideEffects: ['新建单 origin_issue_id=原单 id·新单恒 intake_required=1（三创建入口统一走受理门，非"默认 0 可后续 change_intake_mode 打开"）', '先写 created 再写 derive（T-L3）', '防环 M-1'],
    timelineEvent: 'derive', actionCode: null,
    notifyAfterCommit: null,
  },
];

// [工期对接测试与风险等级拆分 方案 v1.1 §3.1-1·C4] FEATURE_FLOW_TRANSITIONS——与 IMPROVEMENT_FLOW_TRANSITIONS
//   逐条相同，仅两处差异：① submit 条目改为 §3.0 决策树的动态 GATE 解析契约（dynamicTarget:'w_gate' +
//   possibleTargets，冻结·閉 255-F M-2）；② 新增 liaison_test_pass/liaison_test_return 两条边（§3.1 点5，
//   走 sysIssueTransition 通用引擎）。两数组独立成文本（同 status-families.js"两 key 誊抄"范式），未来若
//   improvement 也要接对接测试段，需同步补齐本文件两处差异，不会因共享引用而"改一个另一个自动跟着变"
//   ——这正是拆分的目的：feature 专属能力不静默泄漏到 improvement。
const FEATURE_FLOW_TRANSITIONS = [
  {
    action: 'create',                       // 建单（端点 POST /sys-issues，不走 transition，单独 INSERT；此条供 meta 完整性）
    // 受理排期改造 §9：create.to 改机器契约——落态由 resolveInitialStatus(type,intake_required) 动态解析（选对接人→待受理 / 未选→待指派），
    //   不可静态读；to:null + dynamicTarget:'initial_status' + targetEntity:'current_issue'（作用当前单）。buildMeta 原样暴露标记。
    from: [], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['INSERT 主表 + 写 created timeline'],
    timelineEvent: 'created', actionCode: null,
    notifyAfterCommit: null,
  },
  {
    action: 'intake_accept',                // 受理通过：待受理 → 待指派（对接人∨admin）
    from: ['待受理'], to: '待指派',
    roleGuard: 'intake_liaison', ownerGuard: null,   // 引擎侧 intake_liaison∨admin（roleGuard 语义见 index.js requireIntakeLiaison）
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] risk_level 与状态流转同一 UPDATE 原子落库（唯一
    // 写点=sysIssueTransition 的 case 'intake_accept'）——本条目属 FEATURE_FLOW_TRANSITIONS 专属数组，
    // 与 IMPROVEMENT_FLOW_TRANSITIONS 的同名条目是两个独立对象，改一处不影响另一处（数组拆分动机见
    // 上方注释）。⭐ 用户拍板批1改造B（2026-08-06）：IMPROVEMENT_FLOW_TRANSITIONS 同名条目已同步改为
    // requiredPayload:['risk_level']（原为 []）——risk_level 必填不再是 feature 专属能力，两流在这
    // 一点上重新合流，仅"待对接测试"段等其余能力仍 feature 独有。
    requiredPayload: ['risk_level'],
    sideEffects: ['risk_level 与 status 同一 UPDATE 原子落库'],
    timelineEvent: 'status_change', actionCode: 'intake_accept',
    notifyAfterCommit: null,
  },
  {
    action: 'intake_return',                // 受理退改：待受理 → 待修改（对接人∨admin，原因必填）
    from: ['待受理'], to: '待修改',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['notify 建单人（退改需修改）'],
    timelineEvent: 'status_change', actionCode: 'intake_return',
    notifyAfterCommit: null,                // 通知由端点显式发（§8.2 note 不自动触发 notifyAfterCommit）
  },
  {
    action: 'resubmit_intake',              // 修改后重新提交：待修改 → 待受理（建单人∨admin）
    from: ['待修改'], to: '待受理',
    roleGuard: 'creator_or_admin', ownerGuard: null,   // 授权=created_by∨admin（§5.3·codex131-H1 修：roleGuard 与意图同源·引擎按 row.created_by 事务内校验）
    requiredPayload: [],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'resubmit_intake',
    notifyAfterCommit: null,                // 本期不发·待受理列表驱动（§4.5）
  },
  {
    // ⭐ C2.5 撤销（方案 v2.1 §3）：谓词回「待受理」——预沟通段废除，"对接人拿不准转技术负责人"发生在
    //   待受理阶段（转不转都不改状态·"都是开发团队的评估时长"）。至此与 bug 侧同值（全类型待受理）。
    action: 'request_tech_consult',         // 发起技术负责人沟通：待受理 → 待受理（对接人∨admin，选技术负责人）
    from: ['待受理'], to: null,             // 旁路·不改 status（选技术负责人·通知发送 S5 起改手动）
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['tech_lead_id'],
    sideEffects: ['tech_lead_id/_name 写入', '通知列组重置为 not_sent（S5 手动化：不自动发送·用户点「发送通知」经 resend-tech-consult 发·方案 v2.1 §6）'],
    timelineEvent: 'note', actionCode: 'request_tech_consult',
    notifyAfterCommit: null,                // 本动作不发送通知（S5 手动化）；用户后续经 resend-tech-consult 手动发
  },
  {
    // 建单优化批 C3（方案 20260731_v1.2 §6）：编辑窗口两档扩展——from 从单一「待修改」扩至 A 档
    //   （待受理/待修改/待指派）+ B 档（开发中，剔除 needs_feasibility）；待验证起冻结不变。字段档位
    //   由端点 handler 事务内按真实 status 判定（§6.2 并发终闸），本 from 仅供前端按钮可见性镜像。
    action: 'edit_in_revision',             // 编辑内容：指派前/开发期均可编辑（建单人∨admin·旁路）
    from: ['待受理', '待修改', '待指派', '开发中'], to: null,
    roleGuard: 'creator_or_admin', ownerGuard: null,   // 授权=created_by∨admin（§5.3·codex131-H1 修·引擎按 row.created_by 校验）
    requiredPayload: [],
    sideEffects: ['两档白名单字段更新（建单优化批 C3·方案 §6.1）', 'note timeline 快照改动字段'],
    timelineEvent: 'note', actionCode: 'edit_in_revision',
    notifyAfterCommit: null,
  },
  {
    action: 'change_intake_mode',           // 切换受理模式：待受理/待修改/待指派 → §5.4 真值表（admin，原因必填）
    from: ['待受理', '待修改', '待指派'], to: null,   // 动态·§5.4 真值表（开↔关切换目标态因 status 而异）
    dynamicTarget: 'intake_mode', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['intake_required 翻转 + status 同事务切换（§5.4）'],
    timelineEvent: 'status_change', actionCode: 'change_intake_mode',
    notifyAfterCommit: null,
  },
  {
    action: 'assign',                       // 指派：待指派 → 开发中（admin ∨ 受理人，被指派人非 viewer）
    from: ['待指派'], to: '开发中',         // 受理排期改造：from 由「已排期」改「待指派」
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['assigned_to'],
    sideEffects: ['assigned_to/_name/assigned_at 写入'],   // codex 14 L-1：DDL 无 assigned_by 字段（系统迭代 admin 集中主导，"谁指派"恒 admin 不单记）
    timelineEvent: 'assign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5 落地
  },
  {
    // 重新指派（M3·91 号审 v2.9 重写，MED-2/LOW·92 号审补 from）：改派开发集合（member_ids 声明式差量），
    //   不走 sysIssueTransition/findTransition（独立事务，端点 POST .../reassign 自行处理）。
    action: 'reassign',
    from: ['开发中', '待验证'], to: null,
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['member_ids', 'reason'],
    sideEffects: ['开发集合差量应用（新增 INSERT pending / 移除软删）', '选举 electRepresentative 重算 assigned_to/_name（assigned_at 仅首次形成时补写）', 'W-GATE 按新 roster 完成态判定主状态是否联动', '仅代表真实变化时才 notifyAssignedDeveloper（不再按 toAdd.length 判定）', 'return_count 不变（05-M2，v2.9 沿用）'],
    timelineEvent: null, actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5；实际触发条件见端点内 repChanged 判定
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
    action: 'set_scheduled_start',          // 定计划开工日：开发中（不改 status·须 dev_estimated_at 非空·admin·参考字段）—— 受理排期改造 §7.2
    from: ['开发中'], to: null,             // 旁路·YYYY-MM-DD·可传 null 清除
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['scheduled_start'],   // 端点校 dev_estimated_at 非空 + 日期格式
    sideEffects: ['scheduled_start 写入/清除（参考字段·非闸门·§7.2）'],
    timelineEvent: 'note', actionCode: 'set_scheduled_start',
    notifyAfterCommit: null,
  },
  {
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点1·C4] submit 目标态改**动态 GATE 解析**契约（冻结·
    //   閉 255-F M-2）——不再是静态 to:'待验证'：全员提交完成后由 runWGate 按 §3.0 决策树判定真实落点
    //   （开发中=资格不合格暂留原地 / 待对接测试=⑦正常通过 / 待验证=⑥降级跳过测试段）。possibleTargets
    //   枚举全部可能落点供前端/verify 消费；dynamicTarget:'w_gate' 标记"目标由 W-GATE 解析·不可静态读
    //   to"——本端点走独立 handler（非 sysIssueTransition 引擎），故 dynamicTarget/possibleTargets 只是
    //   meta 层的机器契约标记，不参与运行时 status-transition-guard 的 ADMIN_TRANSITION 分支判断
    //   （那里对本 action 从不会被以 ADMIN_TRANSITION routeKind 调用；GATE routeKind 走自己的边硬编码，
    //   不读 dynamicTarget 字段——见 status-transition-guard.js）。kind 显式标 'transition'（submit 不在
    //   SIDE_EFFECT_ACTIONS 白名单，buildMeta 会自然推导 'transition'，此处注明防误读）。
    action: 'submit',                       // 提交：开发中 → §3.0 决策树动态解析（dev_estimated_at 非空 + 提交双勾）—— 端点 C3/C4
    from: ['开发中'], to: null,
    dynamicTarget: 'w_gate', possibleTargets: ['开发中', '待对接测试', '待验证'], kind: 'transition',
    roleGuard: null, ownerGuard: 'assignee',
    requiredPayload: ['self_tested', 'test_env_deployed'],
    sideEffects: ['first_submitted_at（首次永不变）', 'round_no 递增 + submit timeline', 'W-GATE 按 §3.0 决策树落点（开发中/待对接测试/待验证）'],
    timelineEvent: 'submit', actionCode: null,
    notifyAfterCommit: 'notifySubmittedToAdmin',  // C5（admin 自身按需精简，feedback_no_self_notify）
  },
  {
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5·C4 新增] 对接测试通过：待对接测试 → 待验证（对接人
    //   池∨admin）。走 sysIssueTransition 通用引擎；①b 步骤复查 isRosterCompleteAndEligible∧hasDeliverable
    //   （不复查 hasValidLiaison——操作者池授权即测试合法性来源，§3.0 末尾"复查组合规则"冻结）。
    // ⭐ [方案 D22-④·批2 2026-08-06] pass 凭证校验（"至少其一"闸门，见 index.js case 'liaison_test_pass'
    //   实现）：本轮已上传 delivery/screenshot 附件 或 当场填写 test_note，二者满足其一即可放行——
    //   requiredPayload **刻意不列 'test_note'**：那个数组表达的是"这个键必须非空传入"的单字段硬性必填
    //   （如 return 的 'reason'），本闸门是"两个来源任一满足即可"的或逻辑，字段本身在 payload 里可以完全
    //   不出现（附件满足时）——列进 requiredPayload 会误导成"每次 pass 都必须带 test_note"，与实际口径
    //   不符，故显式不列，闸门逻辑完全在引擎实现内部判定。
    action: 'liaison_test_pass',            // 对接测试通过：待对接测试 → 待验证（对接人池∨admin，凭证二选一）
    from: ['待对接测试'], to: '待验证',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['复查 isRosterCompleteAndEligible∧hasDeliverable（不复查 hasValidLiaison，§3.0）', 'D17：本边落态时刻即 feature last_completed_at 口径（action_code=liaison_test_pass 入白名单）', 'D22-④：凭证二选一闸门（本轮新传附件 delivery/screenshot 或 test_note，皆无→400 LIAISON_TEST_PASS_EVIDENCE_REQUIRED）+ 结构化留痕落 timeline.payload_json（test_note 全文/attachment_ids/evidence 三态/cycle_no·291 号 H-2 加列后），summary 仅 80 字展示摘要'],
    timelineEvent: 'status_change', actionCode: 'liaison_test_pass',
    notifyAfterCommit: null,                // D10：测试通过不通知
  },
  {
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5+§3.1b·C4 新增] 对接测试打回：待对接测试 → 开发中
    //   （对接人池∨admin，原因必填）。v1.1 D18：不递增 return_count（语义分离于业务验收打回）；
    //   花名册重置按 §3.1b 映射（code_submitted/no_code → pending，excused 不动）；
    //   liaison_test_cycle_no 不在本边递增（周期号只在进入测试态时+1，见 runWGate ⑦）。
    action: 'liaison_test_return',          // 对接测试打回：待对接测试 → 开发中（对接人池∨admin，原因必填）
    from: ['待对接测试'], to: '开发中',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['花名册重置（§3.1b：code_submitted/no_code→pending 清 resolved_at/no_code_reason，excused 不动，行数断言≥1）', 'v1.1 D18：不递增 return_count（测试周期打回≠业务验收打回，独立计入 liaison_test_cycle_no 语义）', 'gate_deferred_at 清（§3.6）'],
    timelineEvent: 'status_change', actionCode: 'liaison_test_return',
    notifyAfterCommit: null,                // 通知走既有 notify-developer 手动端点（D13/D18，§3.1b）
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
    sideEffects: ['return_count++（U-2）', 'dev_estimated_at 清空（T-M2）', 'scheduled_start 清空（受理排期改造 §7.2·预计变则开工日失效）'],
    timelineEvent: 'return', actionCode: null,
    notifyAfterCommit: 'notifyReturnedToDeveloper',  // C5
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
  {
    // 暂缓：活跃态 → 已暂缓（admin，原因必填）。⚠️ [工期对接测试与风险等级拆分 方案 v1.1·C4 合并修复批
    //   275-H1] `from` **刻意不含**「待对接测试」——C0 矩阵验证清单 §C（§3.5 全动作档位矩阵）逐格核实
    //   过的拍板格值＝该态下 hold 禁止（对接测试是开发↔对接人之间的短周期交接，不进入 admin 暂缓通道；
    //   需要中断应走 liaison_test_return 打回开发中）。这不是遗漏，未来新增活跃态时不要把「待对接测试」
    //   顺手塞进这个数组——verify-sys-liaison-test.js 有专门的反向锁死断言防误加边。
    action: 'hold',
    from: ['待指派', '开发中', '待验证', '待上线'], to: '已暂缓',
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
    requiredPayload: ['reason'],
    sideEffects: ['恢复到最近一次进入暂缓前的活跃态（校验属当前 type 合法活跃态，否则 409）'],
    timelineEvent: 'status_change', actionCode: 'resume',
    notifyAfterCommit: null,
  },
  {
    action: 'reactivate',                   // 重新激活：已拒绝 → 初始态（admin，不计返工，RC-M1）
    from: ['已拒绝'], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['回初始态重走受理/指派流程（reopen_count 不变）'],
    timelineEvent: 'status_change', actionCode: 'reactivate',
    notifyAfterCommit: null,
  },
  {
    action: 'issue_reject',                 // 拒绝：待受理 → 已拒绝（**仅受理人**·意见前置·原因必填）
    from: ['待受理'], to: '已拒绝',
    roleGuard: 'intake_liaison_only', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['前置守卫：当前轮已有 tech_lead_comment（引擎执行器·REJECT_REQUIRES_TECH_COMMENT）'],
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
    action: 'reopen',                       // 重开：已关闭 → 开发中（admin，计返工，§3.5，§6.5 收窄）
    from: ['已关闭'], to: '开发中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['reopen_count++', 'reopened_at=now', '清 accepted_at/released_at/closed_at/release_id/dev_estimated_at/scheduled_start/online_source/post_release_acceptance/post_accepted_at/post_derive_issue_id（first_submitted_at 永不变·受理排期改造 §7.2；online_source 三件套=组 B·SB2 预筛 HIGH-1，重开=新一轮，上一轮"怎么上线的+补验收进度"一并作废，见 index.js case \'reopen\'）'],
    timelineEvent: 'reopen', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',  // C5
  },
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
    // [工期对接测试与风险等级拆分 方案 v1.1 §2·C4 收口] 订正过时残留注释——原文"新单默认
    //   intake_required=0"已不准确：受理覆盖面运行时真相核实（resolveSysInitialStatusForCreate
    //   实现·index.js）显示普通建单/derive 派生/reactivate 复活**三入口全部**恒 INSERT
    //   intake_required=1（受理门焊死后无绕过路径），derive 新单不例外。to:null·kind='side_effect'
    //   （不改原单），但**新单**落态用 createdIssueDynamicTarget（非共用 dynamicTarget·区分目标属
    //   当前单还是新单）+ targetEntity='created_issue' 动态解析——解析结果恒为「待受理」，非"默认 0"。
    from: '*', to: null, createdIssueDynamicTarget: 'initial_status', targetEntity: 'created_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],  // 新单建单字段 + origin_issue_id
    sideEffects: ['新建单 origin_issue_id=原单 id·新单恒 intake_required=1（三创建入口统一走受理门，非"默认 0 可后续 change_intake_mode 打开"）', '先写 created 再写 derive（T-L3）', '防环 M-1'],
    timelineEvent: 'derive', actionCode: null,
    notifyAfterCommit: null,
  },
];

// ── bug 流 transitions（bug流_方案_20260702_v1.2 §2/§2.3，Commit ①）──────────
//   与变更流的刻意差异（不是漏配）：
//   · 前段最短：无 schedule（建单直落 待处理，指派直达 处理中）。
//   · 无 hold/resume：暂缓有意省略（§2.2）。
//   · ⭐⭐ [C6·方案 v3.4 §6.5·2026-07-29] 原"无 close：已上线=终态"+"无 reopen：上线后再出问题一律
//     派生新单（§4；[覆盖]主方案 reopen）"两条**均作废**——归档/重开改为全类型统一复用 close/reopen
//     （见下方新增两条目）：已上线→已关闭（close，与变更流同条目逐字复用）；已关闭→处理中（reopen，
//     from 收窄为仅「已关闭」，目标态='处理中' 与变更流的'开发中'对称，两流各自独立条目、非共用引用）。
//     derive_reason/fix_gap_note 双描述机制（⑤）与本次归档/重开改动正交，不受影响。
//   · 无 derive 条目（Commit ⑤ 随双描述 derive_reason/fix_gap_note + 反向约束一并放开——
//     ① 先不进 meta/typeFlows，端点层另有 SYS_BUG_DERIVE_PENDING 临时闸，fail-closed）。
//   · confirm-online-norelease 与变更流的 'accept'/'return' 一样走 sysIssueTransition 通用引擎，但需要
//     额外的 release_id/needs_release 双 WHERE 守卫（§8.2 [审:H1]）——由 index.js switch 分支追加 whereFrags，
//     常量层仅声明 from/to/roleGuard，实际闸门在端点实现（Commit ②）。
//   · 无 feasibility/blocked/unblock/scope_change：评估环节与范围变更均不适用 bug（建单守卫已拒 needs_feasibility）。
//   ⚠️ 权限口径（角色权限重构 C1 后·历史演进：Commit ① 全 admin → Commit ④ bug 对接人白名单[7,13] → C1 收敛）：
//     assign/reassign 现为 roleGuard='intake_liaison'（admin ∨ 受理人[13]·**与变更流同口径、无 type 隔离**），
//     粗筛中间件 = requireIntakeLiaison（requireAdminOrBugLiaison 已随 C1 删除）；ownerGuard='assignee' 口径同变更流（严格本人）。
const BUG_FLOW_TRANSITIONS = [
  {
    action: 'create',                       // 建单（端点 POST /sys-issues，不走 transition；此条供 meta 完整性）
    // 受理排期改造 §9：bug create.to 亦改机器契约（选对接人→待受理 / 未选→待处理·resolveInitialStatus 动态解析）。
    from: [], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['type', 'title', 'system_name', 'source'],
    sideEffects: ['INSERT 主表 + 写 created timeline', '可选报障人 requester_*（§3 复用，不新增 reporter_*）'],
    timelineEvent: 'created', actionCode: null,
    notifyAfterCommit: null,                // 建单后路由（先通知对接人/直通开发）= Commit ④ 手动链
  },
  // ── 受理门动作（受理排期改造 §4.3·bug 也走受理门·用户拍板·intake_required=1 才走）──────────
  {
    action: 'intake_accept',                // 受理通过：待受理 → 待处理（bug 正常汇合边·对接人∨admin）
    from: ['待受理'], to: '待处理',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: [],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'intake_accept',
    notifyAfterCommit: null,
  },
  {
    action: 'intake_return',                // 受理退改：待受理 → 待修改（对接人∨admin，原因必填）
    from: ['待受理'], to: '待修改',
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['notify 建单人（退改需修改）'],
    timelineEvent: 'status_change', actionCode: 'intake_return',
    notifyAfterCommit: null,
  },
  {
    action: 'resubmit_intake',              // 修改后重新提交：待修改 → 待受理（建单人∨admin·§5.3·codex131-H1 修）
    from: ['待修改'], to: '待受理',
    roleGuard: 'creator_or_admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'resubmit_intake',
    notifyAfterCommit: null,                // 本期不发·待受理列表驱动（§4.5）
  },
  {
    // 建单优化批 C3（方案 20260731_v1.2 §6）：编辑窗口两档扩展——from 从单一「待修改」扩至 A 档
    //   （待受理/待修改/待处理）+ B 档（处理中，剔除 needs_feasibility）；待验证起冻结不变。字段档位
    //   由端点 handler 事务内按真实 status 判定（§6.2 并发终闸），本 from 仅供前端按钮可见性镜像。
    action: 'edit_in_revision',             // 编辑内容：指派前/开发期均可编辑（建单人∨admin·旁路·130-M 补 bug 亦有·codex131-H1 修）
    from: ['待受理', '待修改', '待处理', '处理中'], to: null,
    roleGuard: 'creator_or_admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['两档白名单字段更新（建单优化批 C3·方案 §6.1）', 'note timeline 快照改动字段'],
    timelineEvent: 'note', actionCode: 'edit_in_revision',
    notifyAfterCommit: null,
  },
  {
    // 角色权限重构 C3（方案 v1.9 §4-C3）历史沿革：本条目语义从来就是"请技术负责人协助判断/定位"（诊断协助），
    //   谓词锚定「待受理」，C3 当时曾令 tech-lead-comment/cancel-consult 两个端点谓词硬编码「待商议」（仅变更流可用，
    //   bug 不获得"回一条评估意见"的能力，只沿用本条目 request-tech-consult 的既有诊断协助能力）。
    // ⭐⭐ C2.5 撤销（方案 v2.1）：预沟通段废除后，tech-lead-comment/cancel-consult 的开放态谓词已改**全类型
    //   统一「待受理」**（见 index.js）——bug 现在与变更流同等可用"回一条评估意见"/"取消咨询"两个端点，
    //   不再是变更流专属能力。本条目 request_tech_consult 的谓词本就是「待受理」，故这次改写对它是零回归。
    action: 'request_tech_consult',         // 发起技术负责人沟通：待受理 → 待受理（对接人∨admin·文案"请技术负责人协助判断/定位"）
    from: ['待受理'], to: null,
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['tech_lead_id'],
    sideEffects: ['tech_lead_id/_name 写入', '通知列组重置为 not_sent（S5 手动化：不自动发送·用户点「发送通知」经 resend-tech-consult 发·方案 v2.1 §6）'],
    timelineEvent: 'note', actionCode: 'request_tech_consult',
    notifyAfterCommit: null,
  },
  {
    action: 'change_intake_mode',           // 切换受理模式：待受理/待修改/待处理 → §5.4 bug 真值表（admin·原因必填）
    from: ['待受理', '待修改', '待处理'], to: null,
    dynamicTarget: 'intake_mode', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['intake_required 翻转 + status 同事务切换（§5.4 bug）'],
    timelineEvent: 'status_change', actionCode: 'change_intake_mode',
    notifyAfterCommit: null,
  },
  {
    action: 'assign',                       // 指派：待处理 → 处理中（前段直达，无排期）
    from: ['待处理'], to: '处理中',
    // ⭐ 角色权限重构 C1：由 'admin_or_bug_liaison'（admin∨[7,13]·仅 bug）改为 'intake_liaison'（admin∨[13]·全类型统一）。
    //   语义变化有两处：① 示例发布者[7] **失去 bug 指派权**（转纯技术负责人，只回一条评估留言）
    //   ② 不再需要"仅挂 bug transition 以免全局化"这套隔离——受理人本就该全类型主导，变更流侧同步改成同一 guard。
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['assigned_to'],
    sideEffects: ['assigned_to/_name/assigned_at 写入'],
    timelineEvent: 'assign', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',
  },
  {
    // 换人（M3·91 号审 v2.9 重写，同变更流范式）。C2c（2026-07-18·codex 115 MED 修正）：bug **保留**「待处理」
    //   (D_PRE)——bug 待处理态可经 add 预指派/reactivate(已拒绝→待处理)带 roster，reassign 声明式改派是既有合法能力
    //   （92 号审有意保留），**不随变更流去 D_PRE 一并收窄**（矩阵一刀切会误伤 bug）。故 bug from 含待处理，与后端
    //   memberActionFamiliesFor('reassign','bug')=基础矩阵（含 D_PRE）同源；变更流侧才排除 D_PRE（type 覆盖）。
    // ⭐⭐ [bug暂缓方案 20260803 v0.4 §4.5b·S2 收敛·codex 236 L-1 口径已定死] S1 曾把「已暂缓」补进本
    //   from（status-families.js 把 bug D_PRE 扩到 ['待处理','已暂缓']后，reassign 族门运行时已覆盖该态，
    //   S1 阶段不补会让 verify-sys-meta.js [6] 写读同源断言永红）——**S2 落地冻结守卫后已按方案收敛移出**：
    //   真闸 = index.js assertRosterNotFrozen（bug+已暂缓 → 409 HOLD_ROSTER_FROZEN，§4.5）；声明与运行时
    //   族门的同步收窄 = index.js MEMBER_ACTION_STATUS_EXCLUDE.reassign.bug=['已暂缓']（族粒度做不到"同族内
    //   排除单状态"，故加此状态级排除表，叠在 D_PRE 族门之上——族门本身仍含 D_PRE 以保留「待处理」）。
    //   verify-sys-meta.js [6] 的 authoritative 计算已改为直接消费 memberActionAuthoritativeStatuses，
    //   与本 from 数组同源，双向锁死（§4.5b 校验清单 3 项）。
    action: 'reassign',
    from: ['待处理', '处理中', '待验证'], to: null,
    // ⭐ 角色权限重构 C1：同 bug assign 改 'intake_liaison'（admin∨[13]）。
    //   reassign 走独立事务（不经 sysIssueTransition [3]），此 roleGuard 仅作 SSOT 记录 + 供 buildMeta 前端显隐，
    //   实际闸门 = 端点中间件 requireIntakeLiaison + handler 的 isSysCoordinator 精判。
    roleGuard: 'intake_liaison', ownerGuard: null,
    requiredPayload: ['member_ids', 'reason'],
    sideEffects: ['开发集合差量应用（新增 INSERT pending / 移除软删）', '选举 electRepresentative 重算 assigned_to/_name（assigned_at 仅首次形成时补写）', 'W-GATE 按新 roster 完成态判定主状态是否联动', '仅代表真实变化时才 notifyAssignedDeveloper', 'return_count 不变（v2.9 沿用）'],
    timelineEvent: null, actionCode: null,
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
    action: 'set_scheduled_start',          // 定计划开工日：处理中（不改 status·须 dev_estimated_at 非空·admin·参考字段）—— 受理排期改造 §7.2（H2 bug 亦支持）
    from: ['处理中'], to: null,
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['scheduled_start'],
    sideEffects: ['scheduled_start 写入/清除（参考字段·非闸门）'],
    timelineEvent: 'note', actionCode: 'set_scheduled_start',
    notifyAfterCommit: null,
  },
  {
    action: 'submit',                       // 提交修复：处理中 → 待验证（dev_estimated_at 非空 + 提交双勾）
    from: ['处理中'], to: '待验证',
    roleGuard: null, ownerGuard: 'assignee',
    // [v1.1 §3.3·C3] 同上方变更流 submit 条目——'summary' 系历史死数据（同订正理由），改列提交双勾。
    requiredPayload: ['self_tested', 'test_env_deployed'],
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
    sideEffects: ['return_count++', 'dev_estimated_at 清空', 'scheduled_start 清空（受理排期改造 §7.2·H2）',
      '（共享 switch 分支连带清评估+blocked 字段——bug 恒 NULL/0，零副作用）'],
    timelineEvent: 'return', actionCode: null,
    notifyAfterCommit: 'notifyReturnedToDeveloper',
  },
  {
    action: 'issue_reject',                 // 拒绝：待受理/待处理 → 已拒绝（admin，原因必填·受理排期改造 §4.3 双 from）
    from: ['待受理', '待处理'], to: '已拒绝',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: [],
    timelineEvent: 'status_change', actionCode: 'issue_reject',
    notifyAfterCommit: null,
  },
  {
    action: 'reactivate',                   // 重新激活：已拒绝 → 初始态（回 bug 初始态·不计返工）
    // 受理排期改造 §9：to 动态解析（resolveInitialStatus 读当前 intake_required·1→待受理·0→待处理）·存量已拒绝 intake_required=0 走待处理。
    from: ['已拒绝'], to: null, dynamicTarget: 'initial_status', targetEntity: 'current_issue',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['回初始态重走受理/指派流程（reopen_count 不变）'],
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
  // ── [bug暂缓方案 20260803 v0.4 §4.2] 暂缓 / 恢复——bug 流补齐 `bug流_方案_20260702_v1.0.md:68`
  //   当年"有意省略"留下的预留口子（S1 只做常量层，守卫/通知/前端为 S2-S4）──────────
  {
    action: 'hold',                         // 暂缓：处理中 → 已暂缓（活跃在册成员 ∨ admin，理由必填）
    from: ['处理中'], to: '已暂缓',          // ⚠️ 不照抄变更流四态（口径 #5）
    // ⚠️⚠️ S2 已落地 —— 双 null **不代表无授权**：真实闸门是 index.js 内的 assertBugHoldActor(actor, issue)
    //   （定义在 sysIssueTransition 上方，call 点见该函数 [3.4] 段），在 findTransition 之后、任何状态 UPDATE
    //   之前、且是 hold 唯一入口（无专用端点）必经此处。**改动本行务必同步该守卫**——引擎对双 null 是完全
    //   放行（permitted 初值 true，双 null 时全部 if 分支不命中），若把 assertBugHoldActor 的调用条件
    //   （action==='hold' && type==='bug'）改掉或删掉守卫本体，会重新打开"任何登录用户可暂缓他人单"的
    //   授权真空——S1 阶段曾用 roleGuard:'admin' 过一道临时防线（宁过严勿过松），S2 落地 assertBugHoldActor
    //   后按方案 §5.2 改回本行的 null/null（真实授权语义=任一活跃在册成员 ∨ admin，非仅 admin）。
    roleGuard: null, ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: [
      '进入暂缓前活跃态记入 timeline from_status（resume 解析用）',
      // ⭐ S3 已落地（index.js SYS_CLEAR_CREATOR_NOTIFY_FIELDS_SQL，随主表状态 UPDATE 同一 setFrags 一并写）：
      //   重置**主表** sys_issues 的建单人侧通知列组（creator_notify_* 六列）为 not_sent/NULL —— 本轮暂缓
      //   通知（POST /sys-issues/:id/notify-hold-creator）的锚点，供该端点判断"本轮是否已发送"。
      '重置建单人侧通知列组（creator_notify_*）为 not_sent —— 本轮通知锚点（方案 §7.4，S3 已落地）',
    ],
    timelineEvent: 'status_change', actionCode: 'hold',
    notifyAfterCommit: null,                 // 通知走手动按钮，不挂自动 marker
  },
  {
    action: 'resume',                       // 恢复：已暂缓 → 处理中（admin，理由必填）
    from: ['已暂缓'], to: null,              // 动态解析（resolveToStatus；本流恒「处理中」）
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: [
      '恢复到最近一次进入暂缓前的活跃态',
      // ⭐ S3 已落地（index.js sysIssueTransition 内 `if (action === 'resume' && type === 'bug') { UPDATE
      //   sys_issue_dev_assignees ... }`，主 UPDATE 之后、同一事务内的独立语句，非 setFrags——目标是**子表**
      //   不是主表，setFrags 只作用于主表 UPDATE，装不下跨表写）：重置**子表** sys_issue_dev_assignees
      //   的通知列组（notify_* 六列）为 not_sent/NULL，范围=该单全部在册行（removed_at IS NULL）—— 本轮
      //   重启通知（POST /sys-issues/:id/notify-resume-dev）的锚点。§13-8 已核实主表 notify_*（dev 侧）
      //   服务的自动派发路径恒不可达（isAutoNotifyEnabled 恒 false），重置那套没有意义，故本方案只重置子表。
      //   ⚠️ S5b·L-1 收口（此前本注释漏了 `&& type === 'bug'` 条件，与实现不符，容易让后续审查者误以为
      //   变更流 resume 也会重置子表——S3b 已把该重置显式收窄为 bug-only：变更流 resume **不**重置子表
      //   notify_*，保持既有已上线行为不变（子表 notify_* 同样服务既有的 notify-developer 手动通知场景，
      //   若不收窄会把变更流单已写入的通知痕迹一并抹掉，见 S3b 裁定与 verify-sys-bug-hold-notify.js [11b]）。
      '重置开发侧（子表）通知列组为 not_sent —— 本轮通知锚点（方案 §7.4，S3 落地，S3b 收窄为 bug-only）',
    ],
    timelineEvent: 'status_change', actionCode: 'resume',
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
  // ── [C6·方案 v3.4 §6.5·2026-07-29] 归档 + 重开——bug 补「已关闭」终态 ──────────
  //   原设计"bug 已上线即终态，上线后再出问题一律派生新单"作废（见文件头差异说明）。归档改为全类型
  //   统一复用 close：字段/动作码/闸门与 CHANGE_FLOW_TRANSITIONS 的 close 条目逐字同构（同一份 index.js
  //   switch case 'close' 通用实现消费，见该处注释——两个条目共享同一套 sideEffects 落地代码，非各自
  //   实现一遍）。
  {
    action: 'close',                        // 关闭（归档）：已上线 → 已关闭（admin）—— §6.5
    from: ['已上线'], to: '已关闭',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: [],
    sideEffects: ['closed_at=now'],
    timelineEvent: 'status_change', actionCode: 'close',
    notifyAfterCommit: null,
  },
  {
    // 重开目标态='处理中'（bug 的 DEV 族），与变更流 reopen 的目标态='开发中' 对称——两流各自独立条目
    // （非共用同一数组引用，同 bug 流其余具名边的既有写法），from 同收窄为仅 ['已关闭']（附录 A：从「已
    // 上线」直接 reopen → 409 须先归档，判定逻辑在 index.js sysIssueTransition [1] 内、两流共用同一段
    // 精判代码，非各自实现）。sideEffects 逐字复用变更流 reopen 同款清列语义（字段名跨类型通用，同一张
    // sys_issues 表），红线核对：清 release_id 后旧 release 本身不被触碰（不回「计划中」），见 index.js
    // switch case 'reopen' 通用实现。
    action: 'reopen',                       // 重开：已关闭 → 处理中（admin，计返工，§6.5）
    from: ['已关闭'], to: '处理中',
    roleGuard: 'admin', ownerGuard: null,
    requiredPayload: ['reason'],
    sideEffects: ['reopen_count++', 'reopened_at=now', '清 accepted_at/released_at/closed_at/release_id/dev_estimated_at/scheduled_start/online_source/post_release_acceptance/post_accepted_at/post_derive_issue_id（first_submitted_at 永不变；online_source 三件套=组 B·SB2 预筛 HIGH-1，重开=新一轮，上一轮"怎么上线的+补验收进度"一并作废——bug 流是本三列唯一活跃消费方，见 index.js case \'reopen\'）'],
    timelineEvent: 'reopen', actionCode: null,
    notifyAfterCommit: 'notifyAssignedDeveloper',
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
// [工期对接测试与风险等级拆分 方案 v1.1 §3.1-1·C4] feature/improvement 从共享同一数组引用改为
//   各自独立数组（拆分动机与内容见上方 FEATURE_FLOW_TRANSITIONS/IMPROVEMENT_FLOW_TRANSITIONS 注释）。
const TRANSITIONS = {
  feature: FEATURE_FLOW_TRANSITIONS,
  improvement: IMPROVEMENT_FLOW_TRANSITIONS,
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
//   ⚠️ 受理排期改造 §4.4 断言3：request_tech_consult/edit_in_revision/set_scheduled_start 入旁路（to=null 不改 status·真旁路）。
//     change_intake_mode/reactivate/create 虽 to=null 但带 dynamicTarget（动态解析**当前单** status·非"不改"）→ 不入旁路、走 'transition' 分类。
//     ⚠️ derive **仍入旁路 side_effect**（codex131-L5 修·方案 §9）——derive **不改原单 status**（to=null 真旁路），createdIssueDynamicTarget 只描述**新建实体**的动态初始态·不改变原单分类。
const SIDE_EFFECT_ACTIONS = new Set(['estimate', 'feasibility', 'blocked', 'unblock', 'derive', 'scope_change', 'set_release_flag', 'assign-release-dev',
  'request_tech_consult', 'edit_in_revision', 'set_scheduled_start']);

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
// [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点3·C4] 补「待对接测试」——仅 feature 落这个态，且落入时
//   刻已经历「开发中」（必有 assigned_to），本条只是把它也纳入"进入这些态必须有开发负责人"的全集声明，
//   不改变任何现有行为（结构上不可能出现"进待对接测试但无 assigned_to"的组合）。
const REQUIRES_ASSIGNEE_STATUSES = ['开发中', '处理中', '待对接测试', '待验证', '待上线', '已上线', '已关闭'];

// ── meta（决策②，buildMeta：从 TRANSITIONS 派生前端只读视图）──────────
//   M-4：只返前端必需，**不暴露** roleGuard/ownerGuard/sideEffects/notifyAfterCommit。
function buildMeta() {
  const statusLabels = {};      // type → 合法状态集（前端渲染状态徽章/筛选器）
  const typeFlows = {};         // type → [{ action, from, to, requiredPayload, needsPayload }]（前端类型联动按钮显隐）
  const actions = {};           // action → 中文 label（前端动作按钮文案）
  const ACTION_LABELS = {
    // ⚠️ schedule '排期' 标签保留（受理排期改造：schedule 动作退场·TRANSITIONS 已删条目·但历史 timeline 行 action_code='schedule' 仍需渲染）。
    create: '建单', schedule: '排期', assign: '指派', reassign: '改派',
    estimate: '回填预计完成', submit: '标记我的开发完成', accept: '验收通过', return: '验收打回',   // P4：submit 改名（去主次多开发·仅标记本人开发项完成·H7）
    // [C3 退场] publish 标签随 TRANSITIONS 条目一并删除（见上方该条目处注释：0 历史行，无兼容负担）。
    close: '关闭', hold: '暂缓', resume: '恢复',
    reactivate: '重新激活', issue_reject: '拒绝', void: '作废', reopen: '重开',
    feasibility: '可行性评估', blocked: '标记受阻', unblock: '解除受阻',
    // 受理排期改造 §5/§6/§7：受理门 + 技术负责人 + 计划开工日新动作
    // C2.5 已撤销（方案 v2.1）——⚠️ 下方标签**保留**供历史 timeline 行渲染（本地库曾真实产生过
    //   "预沟通通过"事件行；同上方 set_release_flag 先例：只删 TRANSITIONS 条目不删标签，
    //   删标签会让历史行渲染成 undefined。方案 §7 历史兼容允许清单第②类）。
    pre_discuss_pass: '预沟通通过',
    intake_accept: '受理通过', intake_return: '退回修改', resubmit_intake: '重新提交受理',
    request_tech_consult: '请技术负责人沟通', edit_in_revision: '编辑内容', change_intake_mode: '切换受理模式',
    set_scheduled_start: '定计划开工日',
    // C2.5 撤销·R4：OA 号补填端点的 timeline action_code 标签（set-oa-number 是旁路路由不进 TRANSITIONS·仅供渲染）
    set_oa_number: '补填 OA 号',
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
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5·C4 新增] 对接测试段两条边（仅 feature）
    liaison_test_pass: '对接测试通过', liaison_test_return: '对接测试打回',
  };

  for (const type of Object.keys(TRANSITIONS)) {
    statusLabels[type] = ALLOWED_STATUSES[type] || [];
    typeFlows[type] = transitionsForType(type).map(t => ({
      action: t.action,
      from: t.from,                              // 数组 / '*'
      to: t.to,                                  // 字符串 / 映射 / null（前端据此判断是否旁路动作）
      requiredPayload: t.requiredPayload || [],
      kind: SIDE_EFFECT_ACTIONS.has(t.action) ? 'side_effect' : 'transition',   // codex 17 M-1 + codex 20 L-1：显式白名单判定旁路动作（路由专用端点），新增动作默认 transition；resume 虽 to=null（动态解析 status）但不在白名单 → 正确标 transition
      // 受理排期改造 §9：动态目标标记原样暴露（消费者见即知"目标由 resolver 解析·不可静态读 to"）——
      //   dynamicTarget='initial_status'/'intake_mode'/'w_gate'（作用当前单）｜createdIssueDynamicTarget（作用新单·derive）｜targetEntity 区分实体。
      ...(t.dynamicTarget ? { dynamicTarget: t.dynamicTarget } : {}),
      ...(t.createdIssueDynamicTarget ? { createdIssueDynamicTarget: t.createdIssueDynamicTarget } : {}),
      ...(t.targetEntity ? { targetEntity: t.targetEntity } : {}),
      // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点1·C4·C0 §F-1 收口] possibleTargets 补入白名单 spread——
      //   此前只在 TRANSITIONS 条目上加这个字段，buildMeta 从不透传，前端/verify 读到的 typeFlows 条目会
      //   静默丢失该字段（白名单 spread 模式下"忘加白名单键"是结构性丢失，非报错——C0 矩阵验证清单
      //   §F-1 提前点名的坑，此处补上防止真掉进去）。
      ...(t.possibleTargets ? { possibleTargets: t.possibleTargets } : {}),
      // 仅暴露"是否需弹窗收集 payload"，不暴露内部 guard/sideEffects（M-4）
    }));
  }
  for (const a of Object.keys(ACTION_LABELS)) actions[a] = ACTION_LABELS[a];

  // 受理排期改造 §9：initialStatusesByType（复数·新形状）替代旧 initialStatusByType——前端从此取初始态，禁从 create.to 推导。
  //   ⚠️ codex132-L1 修（单一事实源）：两分支值统一由 resolveInitialStatus 生成·不再硬编码 '待受理'/直读 WITHOUT_INTAKE 映射·
  //   杜绝"resolver 唯一权威"声明与 meta 组装第二套逻辑漂移。
  //   ⭐ 角色权限重构 C2.5（方案 v1.9 §4-C2.5·前置核实查出的第 5 处漂移）：**新增 `for_create` 才是建单落态权威**。
  //   C2.5 起变更流建单落「待商议」，而 `with_intake` 恒等于 `resolveInitialStatus(type,1)`='待受理' ——
  //   它**不再等于"建单会落到哪"**，只是"intake_required=1 分支的解析值"（受理门内态）。
  //   两个 key 保留原语义不动（既有 verify 断言与历史消费者不破），另加 `for_create` 直接暴露
  //   `resolveSysInitialStatusForCreate`。消费者要"建单落态"一律读 `for_create`，**别再读 with_intake**。
  const initialStatusesByType = {};
  for (const type of Object.keys(INITIAL_STATUS_WITHOUT_INTAKE_BY_TYPE)) {
    initialStatusesByType[type] = {
      for_create: resolveSysInitialStatusForCreate(type),   // ⭐ 建单/derive/reactivate 真实落态（C2.5 起按 type 分流）
      // ⚠️ 角色权限重构 C4·184 号预审（PM-5·弃用性注释）：不再等于建单落态（C2.5 分流后）——
      //   建单落态请读 for_create；本字段=进入受理门时的落态（intake_required=1 分支的解析值，恒'待受理'）。
      with_intake: resolveInitialStatus(type, 1),           // 历史分支值 = 受理门内初始态（恒'待受理'）·非建单落态
      without_intake: resolveInitialStatus(type, 0),        // 历史分支值 = intake_required=0 分支（C0 后创建路径不再产生）
    };
  }

  return { statusLabels, typeFlows, actions, bizSystems: BIZ_SYSTEMS, initialStatusesByType };
}

// ⚠️ 已实现 roleGuard 枚举（SSOT·受理排期改造 C2·codex C2 常规审 MED-1 收口）：引擎（index.js sysIssueTransition [3]）
//   逐个判断这些 guard 字符串·permitted 初值 true → 未知 guard 静默放行是结构性 fail-open。引擎对**非空未知 roleGuard**
//   显式拒绝（500 UNKNOWN_ROLE_GUARD·fail-closed）·本集是判定基准。roleGuard 为空/undefined 合法（靠 ownerGuard·如 estimate/submit）。
//   verify-sys-meta 断言 TRANSITIONS 里所有非空 roleGuard ∈ 本集（防新增 transition 拼错/漏实现）。
// ⭐ 角色权限重构 C1：'admin_or_bug_liaison' **退场**——四条曾用它的 transition（bug/变更流的 assign+reassign）
//   已统一改为 'intake_liaison'（admin∨受理人[13]·全类型）。本集是 fail-closed 判定基准（引擎对非空未知
//   roleGuard 返 500 UNKNOWN_ROLE_GUARD），故必须同步删；verify-sys-meta 断言"所有非空 roleGuard ∈ 本集"，
//   若哪里还残留旧字符串会立刻红灯。
// C2.5 撤销·R2：+'intake_liaison_only'（仅受理人白名单·不含 admin·变更流 issue_reject 专用·判定见 index.js 引擎段）
const KNOWN_ROLE_GUARDS = new Set(['admin', 'intake_liaison', 'creator_or_admin', 'intake_liaison_only']);

// 受理排期改造 C3（codex C3 常规审 MED-1）：受理门动作运行期不变量集——**仅被 sysIssueTransition 引擎消费**（[3.5] 处校验）：
//   这些经引擎流转的受理动作**仅当 intake_required=1 才可执行**（transitions.js:84「intake_required=1 才走」升级为引擎 fail-closed·
//   堵 resubmit_intake 产「待受理+intake_required=0」矛盾组合）。
//   ⚠️ 只含**走 sysIssueTransition** 的受理动作。以下不在本集：
//     · change_intake_mode（C4·自持事务端点·非引擎）——它翻转 intake_required·加了会自锁开受理门路径。
//     · edit_in_revision（C4·自持事务端点·直接查 status='待修改' 门·不经引擎）——待修改态结构上 intake_required=1，网关由端点 status 门隐含保证，无需入本集。
//   C5 的 request_tech_consult 若**走 sysIssueTransition** 才须加入本集（待受理态发起·要 intake_required=1）；若做成自持端点则同 edit_in_revision 由 status 门隐含。
const INTAKE_GATE_ACTIONS = new Set(['intake_accept', 'intake_return', 'resubmit_intake']);

module.exports = {
  BIZ_SYSTEMS,
  INITIAL_STATUS_WITHOUT_INTAKE_BY_TYPE,
  resolveInitialStatus,          // 受理排期改造 §9：落态解析器（C0 后创建路径不再直调·仅 change_intake_mode 与 meta 组装消费）
  resolveSysInitialStatusForCreate,   // 角色权限重构 C0：创建路径（建单/derive/reactivate）落态唯一入口·恒 intake=1·C2.5 起按 type 分流
  ALLOWED_STATUSES,
  KNOWN_ROLE_GUARDS,             // 受理排期改造 C2（codex MED-1）：引擎默认拒绝未知 roleGuard 的判定基准
  INTAKE_GATE_ACTIONS,           // 受理排期改造 C3（codex MED-1）：受理门动作 intake_required=1 运行期不变量集
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
