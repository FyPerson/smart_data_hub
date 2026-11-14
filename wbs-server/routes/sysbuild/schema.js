// routes/sysbuild/schema.js — 项目管理（系统建设记录）模块的结构定义（DDL + 结构合约）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §6（表清单）、
//   §2.2（不变量）、§4（规则与状态机）；公共约定见 §6.1。
//
// 约定：
//   - 全部是新表，CREATE TABLE IF NOT EXISTS 首次真建，CHECK 一次带全；不开外键，父子关系由服务端
//     在写事务内校验（REFERENCES 不写，避免读者误以为有引用完整性）。
//   - 本数组同时是结构合约：db.js 初始化时按对象名逐个比对 sqlite_master 中的标准形 SQL，任何
//     同名但定义不同的对象（人工改过）判未就绪。改这里的任一条语句都会让已建库判「定义不符」——
//     上线前开发期改 DDL 需要删掉测试库重建；上线后改结构必须走迁移，不能直接改这里的文本。
//   - 时间戳 DATETIME NOT NULL DEFAULT localtime；「尚未发生」的时间列可空。业务日期列用 dateCheck。
//   - 事件类型（sysbuild_events.event_type）不加 DB 枚举 CHECK：C2–C6 会陆续登记新类型，SQLite 改
//     CHECK 须重建表；改由服务端事件登记表校验（写事件的唯一助手里），DB 只校验形态。
//   - 只追加：允许 UPDATE 的列以 UPDATABLE_COLUMNS 为准，verify-sysbuild-static.js 据此扫描路由。
//   - 约定（C1b 预筛 L3 / L4 / L7）：①知会的已读回执一律追加到 sysbuild_notice_receipts（引用发送尝试，不更新旧行、不计入发送次数）；
//     ②系统动作（启动补发等）写事件时 operator_id = 0、operator_name = '系统'；③没有版本概念的对象（邀请、授权）
//     在 confirm_tasks / confirmations / views 的 object_version_id 里填对象自身的 id。
'use strict';

const TS = "DATETIME NOT NULL DEFAULT (datetime('now','localtime'))";

// 业务日期 CHECK（v1.2 §3.0）：GLOB 形态 + date() 非空 + 等值 + 2000–2099。date(...) IS NOT NULL
//   不可省：对 2026-13-01 这类值 date() 返回 NULL，只写等值比较时整个 CHECK 为 NULL 会被当作通过。
function dateCheck(col, nullable) {
  const body = `${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${col},'+0 days') IS NOT NULL AND date(${col},'+0 days') = ${col} AND ${col} BETWEEN '2000-01-01' AND '2099-12-31'`;
  return nullable ? `CHECK (${col} IS NULL OR (${body}))` : `CHECK (${body})`;
}
function inList(col, values, nullable) {
  const list = values.map((v) => `'${v}'`).join(',');
  return nullable ? `CHECK (${col} IS NULL OR ${col} IN (${list}))` : `CHECK (${col} IN (${list}))`;
}
const BOOL = (col) => `${col} INTEGER NOT NULL DEFAULT 0 CHECK (${col} IN (0,1))`;
const JSON_COL = (col, nullable) => (nullable
  ? `${col} TEXT CHECK (${col} IS NULL OR json_valid(${col}))`
  : `${col} TEXT NOT NULL CHECK (json_valid(${col}))`);

// ── 枚举（服务端校验与 DDL 同源）────────────────────────────────────────────────────────
const ENUMS = Object.freeze({
  buildType: ['outsource', 'procurement', 'inhouse'],
  projectStatus: ['active', 'paused', 'terminated', 'closed'],
  historyWindow: ['never', 'open', 'closed'],
  partySide: ['demand', 'dev'],
  // withdrawn = 尚未生效即被撤回（邀请撤回、负责人撤掉未被接受的授权；C1b 预筛 M1）
  appointmentStatus: ['pending', 'active', 'rejected', 'ended', 'withdrawn'],
  delegationStatus: ['pending_owner', 'pending_accept', 'active', 'rejected', 'revoked', 'withdrawn'],
  invitationKind: ['join', 'appointment'],
  invitationStatus: ['pending', 'accepted', 'declined', 'withdrawn'],
  batchStatus: ['planning', 'active', 'live', 'transferred', 'superseded'],
  nodeStatus: ['not_started', 'in_progress', 'closed', 'cancelled'],
  scheduleKind: ['baseline', 'plan_change', 'actual_start', 'actual_end', 'actual_correct'],
  proposerStatus: ['pending', 'confirmed', 'proxy_confirmed', 'denied'],
  // 方案 v1.2 D41：总体规划单一身份——包类型去掉 overall_batch_req（单批合并形态改记在包版本的 form 上）
  packageType: ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing'],
  // 包版本形态（只在总体规划包的版本上填写）：overall = 普通「总体」；overall_batch_req = 单批项目的「总体 + 批次需求」合并形态
  packageForm: ['overall', 'overall_batch_req'],
  packageVersionStatus: ['draft', 'pending', 'effective', 'superseded'],
  itemRevisionOp: ['add', 'remove'],
  // §4.1 七类登记：补充说明 / 补交材料 / 经验教训 / 使用与效益 / 更正 / 意见与反馈 / 问题与处理
  entryType: ['note', 'material', 'lesson', 'benefit', 'correction', 'feedback', 'issue'],
  // 用途：一般 / 开发方处理说明 / 正式交付物提交
  entryPurpose: ['general', 'dev_note', 'deliverable'],
  commitmentFlagSource: ['submitter', 'pm'],
  entryPeriod: ['process', 'supplement'],
  // 方案 v1.2 D43（C5 S-S1a 落地）：风险与涉及承诺标记的补标 / 取消都是办理动作，当前值由服务端按时间归并（unmark_commitment / mark_risk / unmark_risk 为本批新增）
  entryAction: ['conclude', 'for_reference', 'correct', 'void', 'link_change', 'link_sys_issue', 'assign_items', 'split', 'escalate', 'mark_commitment', 'adjudicate', 'unmark_commitment', 'mark_risk', 'unmark_risk'],
  // §4.1 结论：已处理 / 已采纳并入定稿材料 / 不采纳 / 留待后续 / 转正式变更 / 转系统迭代 / 业务确认不再处理 / 项目已终止
  conclusionKind: ['handled', 'adopted', 'not_adopted', 'deferred', 'to_change', 'to_sys_iteration', 'no_further', 'project_terminated'],
  basisKind: ['dev_note_version', 'pm_verify'],
  changeStatus: ['draft', 'pending', 'effective', 'withdrawn'],
  confirmObjectType: ['package_version', 'item_version', 'invitation', 'delegation', 'dev_entry', 'conclusion', 'adjudication', 'handover'],
  // C6a：handover_accept_issue = 交接确认「接受带此问题上线」，handover_no_further = 交接确认「业务确认不再处理」（对象类型沿用 handover，每个需求部门代表人各一条任务）；
  //   handover_accept（运维交接接收，G6 维护方接收）保留不动。
  confirmPurpose: ['package_confirm', 'proposer_confirm', 'accept_invitation', 'delegation_grant', 'delegation_accept', 'dev_key_confirm', 'conclusion_confirm', 'adjudicate', 'handover_accept', 'handover_accept_issue', 'handover_no_further'],
  revisionStatus: ['pending', 'confirmed', 'objected', 'rejected', 'invalid', 'superseded'],
  confirmMethod: ['platform', 'card', 'proxy', 'history'],
  confirmDecision: ['confirm', 'object', 'reject'],
  viewSource: ['page', 'self_submit', 'card_render'],
  goliveKind: ['golive', 'revoke', 'regolive'],
  noticeKind: ['schedule_change', 'for_reference'],
  noticeChannel: ['dingtalk', 'platform'],
  noticeResult: ['sent', 'failed'],
  readStatus: ['unknown', 'read', 'unread'],
  commentObjectType: ['entry', 'item', 'package_version', 'node'],
  // event：凭据挂在事件行上（历史窗口开启 / 关闭 / 重开等没有独立记录的操作；10 号 M-2）
  bindingOwnerType: ['entry', 'item_version', 'material_version', 'confirmation', 'change', 'golive_event', 'history_import', 'comment', 'schedule_record', 'package_version', 'event'],
  frozenObjectType: ['package_version', 'item_version', 'entry', 'material_version', 'change'],
  batchRelationKind: ['split', 'merge', 'replace', 'transfer'],
  route: ['project', 'sys_iteration', 'pending'],
  // 方案 v1.2 D39（C5 S-S1b 落地）：判定依据类别。undetermined = 尚未判定（route = pending 的快照，判定列全空）；其余三类 = 已生效规划内 / 规划内待细化 / 规划外
  routingBasis: ['in_plan', 'planned_detail', 'out_of_plan', 'undetermined'],
  // 知会异议的处理方式（C5 S-S1b）：return_to_handling = 原登记回到办理（节点未收口）；supplement_entry = 节点已收口，生成异议补充登记，原登记保持仅供参考
  //   C6b：加 to_pm = 改期知会的异议处理方式（转 PM，不阻塞改期；不生成异议补充登记、不拉原登记回办理）。结构变化（CHECK 的取值集合）并入 Q7。
  noticeObjectionMode: ['return_to_handling', 'supplement_entry', 'to_pm'],
  historyFactType: ['appointment', 'delegation', 'package_effective', 'node_closed', 'golive'],
  sendIntentStatus: ['pending', 'sent', 'failed'],
  cardStatus: ['sent', 'updated', 'expired'],
});
const E = ENUMS;

// ── 表 ─────────────────────────────────────────────────────────────────────────────────
const TABLES = [
  ['sysbuild_projects', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_name TEXT NOT NULL,
    phase_name TEXT,
    build_type TEXT NOT NULL ${inList('build_type', E.buildType)},
    goal TEXT,
    oa_number TEXT CHECK (oa_number IS NULL OR (oa_number GLOB '[0-9]*' AND oa_number NOT GLOB '*[^0-9]*' AND length(oa_number) BETWEEN 1 AND 20)),
    initiated_on DATE ${dateCheck('initiated_on', true)},
    pm_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' ${inList('status', E.projectStatus)},
    history_window TEXT NOT NULL DEFAULT 'never' ${inList('history_window', E.historyWindow)},
    created_by INTEGER NOT NULL,
    created_at ${TS},
    updated_at ${TS}`],
  ['sysbuild_parties', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    side TEXT NOT NULL ${inList('side', E.partySide)},
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_members', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    party_id INTEGER,
    user_id INTEGER,
    person_name TEXT,
    joined_at DATETIME,
    removed_at DATETIME,
    removed_reason TEXT,
    added_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (user_id IS NOT NULL OR (person_name IS NOT NULL AND length(trim(person_name)) > 0)),
    CHECK ((removed_at IS NULL) = (removed_reason IS NULL))`],
  ['sysbuild_appointments', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.appointmentStatus)},
    proposed_by INTEGER NOT NULL,
    effective_at DATETIME,
    ended_at DATETIME,
    end_reason TEXT,
    created_at ${TS},
    CHECK (status NOT IN ('active','ended') OR effective_at IS NOT NULL),
    CHECK (status IN ('active','ended') OR effective_at IS NULL),
    CHECK ((status = 'ended') = (ended_at IS NOT NULL))`],
  ['sysbuild_delegations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    appointment_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_owner' ${inList('status', E.delegationStatus)},
    proposed_by INTEGER NOT NULL,
    effective_at DATETIME,
    revoked_at DATETIME,
    revoke_reason TEXT,
    created_at ${TS},
    CHECK (status NOT IN ('active','revoked') OR effective_at IS NOT NULL),
    CHECK (status IN ('active','revoked') OR effective_at IS NULL),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (revoked_at IS NULL OR (revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0))`],
  ['sysbuild_invitations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    kind TEXT NOT NULL ${inList('kind', E.invitationKind)},
    appointment_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.invitationStatus)},
    invited_by INTEGER NOT NULL,
    responded_at DATETIME,
    created_at ${TS},
    CHECK ((kind = 'appointment') = (appointment_id IS NOT NULL)),
    CHECK ((status = 'pending') = (responded_at IS NULL))`],
  ['sysbuild_batches', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    name TEXT NOT NULL,
    ${BOOL('is_default')},
    status TEXT NOT NULL DEFAULT 'planning' ${inList('status', E.batchStatus)},
    superseded_by INTEGER,
    transfer_change_id INTEGER,
    dev_assignee_member_id INTEGER,
    created_at ${TS},
    CHECK ((status = 'transferred') = (transfer_change_id IS NOT NULL)),
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))`],
  ['sysbuild_nodes', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    batch_id INTEGER,
    template_key TEXT,
    name TEXT NOT NULL,
    g_stage TEXT,
    sort_order INTEGER NOT NULL,
    ${BOOL('is_golive_milestone')},
    status TEXT NOT NULL DEFAULT 'not_started' ${inList('status', E.nodeStatus)},
    opened_at DATETIME,
    closed_at DATETIME,
    created_at ${TS},
    updated_at ${TS},
    CHECK (is_golive_milestone = 0 OR (batch_id IS NOT NULL AND status <> 'cancelled')),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    CHECK (status NOT IN ('in_progress','closed') OR opened_at IS NOT NULL)`],
  ['sysbuild_node_schedule_records', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    kind TEXT NOT NULL ${inList('kind', E.scheduleKind)},
    planned_start DATE ${dateCheck('planned_start', true)},
    planned_end DATE ${dateCheck('planned_end', true)},
    actual_date DATE ${dateCheck('actual_date', true)},
    corrects_kind TEXT,
    reason TEXT,
    source_party_id INTEGER,
    dev_key_entry_id INTEGER,
    package_version_id INTEGER,
    ${BOOL('no_written_evidence')},
    no_evidence_reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (kind NOT IN ('baseline','plan_change') OR (planned_start IS NOT NULL AND planned_end IS NOT NULL AND planned_start <= planned_end AND actual_date IS NULL)),
    CHECK (kind IN ('baseline','plan_change') OR (actual_date IS NOT NULL AND planned_start IS NULL AND planned_end IS NULL)),
    CHECK (kind <> 'baseline' OR package_version_id IS NOT NULL),
    CHECK (kind NOT IN ('plan_change','actual_correct') OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
    CHECK ((kind = 'actual_correct') = (corrects_kind IS NOT NULL)),
    CHECK (corrects_kind IS NULL OR corrects_kind IN ('actual_start','actual_end')),
    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))`],
  ['sysbuild_modules', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_items', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    code TEXT NOT NULL CHECK (code GLOB 'R-[0-9]*' AND substr(code,3) NOT GLOB '*[^0-9]*'),
    module_id INTEGER,
    replaces_item_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_item_versions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    content TEXT NOT NULL,
    quote_text TEXT,
    proposer_name TEXT,
    proposer_member_id INTEGER,
    proposer_party_id INTEGER,
    occasion TEXT,
    proposed_on DATE ${dateCheck('proposed_on', true)},
    proposer_status TEXT NOT NULL DEFAULT 'pending' ${inList('proposer_status', E.proposerStatus)},
    deny_reason TEXT,
    ${BOOL('no_written_evidence')},
    no_evidence_reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (proposer_member_id IS NOT NULL OR (proposer_name IS NOT NULL AND length(trim(proposer_name)) > 0)),
    CHECK (proposer_status <> 'denied' OR (deny_reason IS NOT NULL AND length(trim(deny_reason)) > 0)),
    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))`],
  ['sysbuild_packages', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    batch_id INTEGER,
    type TEXT NOT NULL ${inList('type', E.packageType)},
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (type NOT IN ('batch_req','batch_accept') OR batch_id IS NOT NULL),
    CHECK (type NOT IN ('initiation','overall','closing') OR batch_id IS NULL)`],
  ['sysbuild_package_versions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    parent_overall_version_id INTEGER,
    form TEXT ${inList('form', E.packageForm, true)},
    status TEXT NOT NULL DEFAULT 'draft' ${inList('status', E.packageVersionStatus)},
    effective_at DATETIME,
    ${JSON_COL('snapshot_json', false)},
    created_by INTEGER NOT NULL,
    created_at ${TS},
    updated_at ${TS},
    CHECK (status <> 'effective' OR effective_at IS NOT NULL),
    CHECK (status NOT IN ('draft','pending') OR effective_at IS NULL)`],
  ['sysbuild_package_item_revisions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_version_id INTEGER NOT NULL,
    item_version_id INTEGER NOT NULL,
    committed_batch_id INTEGER,
    op TEXT NOT NULL ${inList('op', E.itemRevisionOp)},
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_materials', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    material_key TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at ${TS}`],
  ['sysbuild_material_versions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    body TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_entries', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    node_id INTEGER,
    type TEXT NOT NULL ${inList('type', E.entryType)},
    purpose TEXT NOT NULL DEFAULT 'general' ${inList('purpose', E.entryPurpose)},
    ${BOOL('commitment_flag')},
    commitment_flag_source TEXT ${inList('commitment_flag_source', E.commitmentFlagSource, true)},
    ${BOOL('is_risk')},
    source_party_id INTEGER,
    source_name TEXT,
    operator_user_id INTEGER NOT NULL,
    ${JSON_COL('operator_identity_snapshot', false)},
    period TEXT NOT NULL ${inList('period', E.entryPeriod)},
    days_after_close INTEGER,
    business_date DATE ${dateCheck('business_date', true)},
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    ${BOOL('no_written_evidence')},
    no_evidence_reason TEXT,
    ${JSON_COL('routing_json', true)},
    from_comment_id INTEGER,
    parent_entry_id INTEGER,
    objects_entry_id INTEGER,
    revision_of_entry_id INTEGER,
    created_at ${TS},
    CHECK ((parent_entry_id IS NOT NULL) + (objects_entry_id IS NOT NULL) + (revision_of_entry_id IS NOT NULL) <= 1),
    CHECK ((commitment_flag = 1) = (commitment_flag_source IS NOT NULL)),
    CHECK ((period = 'supplement') = (days_after_close IS NOT NULL)),
    CHECK (days_after_close IS NULL OR days_after_close >= 0),
    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))`],
  ['sysbuild_entry_items', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    item_version_id INTEGER NOT NULL,
    assigned_by_action_id INTEGER,
    created_at ${TS}`],
  ['sysbuild_entry_actions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    action TEXT NOT NULL ${inList('action', E.entryAction)},
    conclusion_kind TEXT ${inList('conclusion_kind', E.conclusionKind, true)},
    basis_kind TEXT ${inList('basis_kind', E.basisKind, true)},
    basis_ref INTEGER,
    text TEXT,
    sys_issue_no TEXT,
    assignee_text TEXT,
    change_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK ((action IN ('conclude','adjudicate')) = (conclusion_kind IS NOT NULL)),
    CHECK (basis_kind IS NULL OR basis_ref IS NOT NULL OR basis_kind = 'pm_verify'),
    CHECK (action <> 'link_sys_issue' OR (sys_issue_no IS NOT NULL AND length(trim(sys_issue_no)) > 0)),
    CHECK (change_id IS NULL OR action IN ('conclude','link_change')),
    CHECK (action <> 'conclude' OR ((conclusion_kind = 'to_change') = (change_id IS NOT NULL))),
    CHECK (action <> 'link_change' OR change_id IS NOT NULL)`],
  ['sysbuild_changes', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    package_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    ${JSON_COL('affects_json', false)},
    package_version_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft' ${inList('status', E.changeStatus)},
    ${BOOL('no_written_evidence')},
    no_evidence_reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    updated_at ${TS},
    CHECK (status <> 'effective' OR package_version_id IS NOT NULL),
    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))`],
  ['sysbuild_confirm_tasks', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    object_type TEXT NOT NULL ${inList('object_type', E.confirmObjectType)},
    object_id INTEGER NOT NULL,
    object_version_id INTEGER NOT NULL,
    purpose TEXT NOT NULL ${inList('purpose', E.confirmPurpose)},
    party_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (object_type NOT IN ('invitation','delegation') OR object_version_id = object_id)`],
  ['sysbuild_confirm_task_revisions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    rev_no INTEGER NOT NULL CHECK (rev_no >= 1),
    required_member_id INTEGER NOT NULL,
    basis_appointment_id INTEGER,
    basis_delegation_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.revisionStatus)},
    status_reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    updated_at ${TS},
    CHECK (status NOT IN ('invalid','superseded') OR (status_reason IS NOT NULL AND length(trim(status_reason)) > 0))`],
  // 确认记录：平台 / 卡片 / 代录挂在任务修订上；历史补录不挂任何当前修订（§4.2「历史补录」），
  //   直接引用对象类型与版本。代录与历史补录记实际确认人与身份依据，不生成本人浏览与勾选。
  ['sysbuild_confirmations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_revision_id INTEGER,
    object_type TEXT NOT NULL ${inList('object_type', E.confirmObjectType)},
    object_version_id INTEGER NOT NULL,
    actor_user_id INTEGER,
    actual_confirmer TEXT,
    identity_basis TEXT,
    method TEXT NOT NULL ${inList('method', E.confirmMethod)},
    decision TEXT NOT NULL ${inList('decision', E.confirmDecision)},
    checkbox_text TEXT,
    reason TEXT,
    view_id INTEGER,
    external_date DATE ${dateCheck('external_date', true)},
    proxy_by INTEGER,
    card_instance_id INTEGER,
    dingtalk_user_id TEXT,
    created_at ${TS},
    CHECK ((method = 'history') = (task_revision_id IS NULL)),
    CHECK (method <> 'platform' OR (actor_user_id IS NOT NULL AND view_id IS NOT NULL AND checkbox_text IS NOT NULL AND length(trim(checkbox_text)) > 0)),
    CHECK (method <> 'card' OR (actor_user_id IS NOT NULL AND card_instance_id IS NOT NULL AND dingtalk_user_id IS NOT NULL)),
    CHECK (method NOT IN ('proxy','history') OR (external_date IS NOT NULL AND actual_confirmer IS NOT NULL AND length(trim(actual_confirmer)) > 0 AND identity_basis IS NOT NULL AND length(trim(identity_basis)) > 0 AND view_id IS NULL AND checkbox_text IS NULL)),
    CHECK (method NOT IN ('proxy','history') OR proxy_by IS NOT NULL),
    CHECK (decision = 'confirm' OR (reason IS NOT NULL AND length(trim(reason)) > 0))`],
  ['sysbuild_views', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    object_type TEXT NOT NULL ${inList('object_type', E.confirmObjectType)},
    object_version_id INTEGER NOT NULL,
    source TEXT NOT NULL ${inList('source', E.viewSource)},
    card_instance_id INTEGER,
    ${JSON_COL('frozen_attachment_set', false)},
    opened_at ${TS},
    CHECK ((source = 'card_render') = (card_instance_id IS NOT NULL))`],
  ['sysbuild_golive_events', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    kind TEXT NOT NULL ${inList('kind', E.goliveKind)},
    ${JSON_COL('handover_snapshot_json', true)},
    reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (kind <> 'revoke' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
    CHECK (kind = 'revoke' OR handover_snapshot_json IS NOT NULL)`],
  ['sysbuild_notices', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL ${inList('kind', E.noticeKind)},
    ref_type TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    recipient_member_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_notice_attempts', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice_id INTEGER NOT NULL,
    channel TEXT NOT NULL ${inList('channel', E.noticeChannel)},
    result TEXT NOT NULL ${inList('result', E.noticeResult)},
    response_code TEXT,
    created_at ${TS}`],
  // 已读回执：每次查询结果追加一行，引用对应的发送尝试（10 号 M-4；不计入发送次数）
  ['sysbuild_notice_receipts', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    read_status TEXT NOT NULL ${inList('read_status', E.readStatus)},
    checked_at ${TS}`],
  // 知会异议（C5 S-S1a）：接收人本人或来源方现任负责人对一条知会提的异议，只追加；同一知会至多一条（uq_sysbuild_notice_objections）。C6b 起改期知会的异议复用本表：mode 枚举（noticeObjectionMode）加了 to_pm（转 PM，不阻塞改期，objection_entry_id 为空）；return_to_handling / supplement_entry 仍是仅供参考知会专用的处理方式。mode 取值集合变了 = CHECK 变了，已有库走 Q7 迁移。
  ['sysbuild_notice_objections', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice_id INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    mode TEXT NOT NULL ${inList('mode', E.noticeObjectionMode)},
    objection_entry_id INTEGER,
    created_at ${TS},
    CHECK ((mode = 'supplement_entry') = (objection_entry_id IS NOT NULL))`],
  ['sysbuild_comments', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    object_type TEXT NOT NULL ${inList('object_type', E.commentObjectType)},
    object_id INTEGER NOT NULL,
    author_user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    ${JSON_COL('mentions_json', true)},
    upgraded_entry_id INTEGER,
    voided_at DATETIME,
    void_reason TEXT,
    created_at ${TS},
    CHECK ((voided_at IS NULL) = (void_reason IS NULL))`],
  // 附件：staged_at = 暂存上传时刻（§10.3 暂存 + 提交时绑定，超过 24 小时未绑定禁止再绑定）。
  ['sysbuild_attachments', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    file_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    ${BOOL('is_image')},
    supersedes_attachment_id INTEGER,
    uploaded_by INTEGER NOT NULL,
    staged_at ${TS},
    deleted_at DATETIME,
    deleted_by INTEGER,
    masked_at DATETIME,
    masked_by INTEGER,
    mask_reason TEXT,
    created_at ${TS},
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
    CHECK ((masked_at IS NULL) = (masked_by IS NULL)),
    CHECK (masked_at IS NULL OR (mask_reason IS NOT NULL AND length(trim(mask_reason)) > 0))`],
  ['sysbuild_attachment_bindings', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id INTEGER NOT NULL UNIQUE,
    owner_type TEXT NOT NULL ${inList('owner_type', E.bindingOwnerType)},
    owner_id INTEGER NOT NULL,
    bound_by INTEGER NOT NULL,
    bound_at ${TS}`],
  // 附件引用（方案 v1.2 D40 / §10.3 附件复用）：绑定 = 上传来源归属（一个附件只首次绑定一次）；条目 / 材料出新版本时沿用旧版本的附件，
  //   在新版本的写事务内追加一行引用（只追加；同一附件对同一对象至多一条）。冻结清单按「绑定 ∪ 引用」生成。
  ['sysbuild_attachment_refs', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    attachment_id INTEGER NOT NULL,
    owner_type TEXT NOT NULL ${inList('owner_type', E.bindingOwnerType)},
    owner_id INTEGER NOT NULL,
    ref_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_frozen_attachments', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_type TEXT NOT NULL ${inList('object_type', E.frozenObjectType)},
    object_version_id INTEGER NOT NULL,
    attachment_id INTEGER NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at ${TS}`],
  ['sysbuild_batch_relations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_batch_id INTEGER NOT NULL,
    to_batch_id INTEGER,
    kind TEXT NOT NULL ${inList('kind', E.batchRelationKind)},
    change_package_version_id INTEGER,
    created_at ${TS},
    CHECK (kind = 'transfer' OR (to_batch_id IS NOT NULL AND to_batch_id <> from_batch_id))`],
  ['sysbuild_routing_snapshots', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    part_no INTEGER NOT NULL CHECK (part_no >= 1),
    overall_package_version_id INTEGER,
    item_version_id INTEGER,
    committed_batch_id INTEGER,
    golive_event_id INTEGER,
    decided_at ${TS},
    trigger_action_id INTEGER,
    route TEXT NOT NULL ${inList('route', E.route)},
    basis_category TEXT NOT NULL ${inList('basis_category', E.routingBasis)},
    CHECK ((route = 'pending') = (basis_category = 'undetermined')),
    CHECK (basis_category <> 'undetermined' OR (overall_package_version_id IS NULL AND item_version_id IS NULL AND committed_batch_id IS NULL AND golive_event_id IS NULL)),
    CHECK (basis_category <> 'in_plan' OR (overall_package_version_id IS NOT NULL AND item_version_id IS NOT NULL AND route IN ('project', 'sys_iteration')
      AND (route <> 'project' OR committed_batch_id IS NOT NULL) AND (route <> 'sys_iteration' OR golive_event_id IS NOT NULL))),
    CHECK (basis_category <> 'planned_detail' OR (item_version_id IS NOT NULL AND route = 'project')),
    CHECK (basis_category <> 'out_of_plan' OR (item_version_id IS NULL AND route IN ('sys_iteration', 'project')))`],
  ['sysbuild_history_imports', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    object_type TEXT NOT NULL,
    object_id INTEGER NOT NULL,
    fact_type TEXT NOT NULL ${inList('fact_type', E.historyFactType)},
    actual_confirmer TEXT NOT NULL CHECK (length(trim(actual_confirmer)) > 0),
    identity_basis TEXT NOT NULL CHECK (length(trim(identity_basis)) > 0),
    original_date DATE NOT NULL ${dateCheck('original_date', false)},
    imported_by INTEGER NOT NULL,
    imported_at ${TS}`],
  ['sysbuild_send_intents', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    recipient_user_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'dingtalk' ${inList('channel', E.noticeChannel)},
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.sendIntentStatus)},
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    created_at ${TS},
    updated_at ${TS}`],
  ['sysbuild_card_instances', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_revision_id INTEGER NOT NULL,
    recipient_user_id INTEGER NOT NULL,
    dingtalk_user_id TEXT NOT NULL,
    rendered_object_version_id INTEGER NOT NULL,
    ${JSON_COL('rendered_snapshot_json', false)},
    out_track_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'sent' ${inList('status', E.cardStatus)},
    created_at ${TS}`],
  ['sysbuild_guide_state', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    guide_key TEXT NOT NULL,
    seen_at ${TS},
    UNIQUE (user_id, guide_key)`],
  ['sysbuild_events', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    object_type TEXT NOT NULL,
    object_id INTEGER,
    event_type TEXT NOT NULL CHECK (event_type GLOB '[a-z]*' AND event_type NOT GLOB '*[^a-z_]*'),
    ${JSON_COL('payload_json', true)},
    operator_id INTEGER NOT NULL,
    operator_name TEXT NOT NULL,
    created_at ${TS}`],
];

// ── 索引（唯一性约束与常用筛选；部分唯一索引表达「同一时刻至多一个」）─────────────────────
const INDEXES = [
  ['idx_sysbuild_projects_pm', 'sysbuild_projects(pm_user_id)'],
  ['idx_sysbuild_parties_project', 'sysbuild_parties(project_id, side)'],
  ['uq_sysbuild_parties_one_dev', 'sysbuild_parties(project_id) WHERE side = \'dev\'', true],
  ['idx_sysbuild_members_project', 'sysbuild_members(project_id, party_id)'],
  ['idx_sysbuild_members_user', 'sysbuild_members(user_id, project_id)'],
  ['uq_sysbuild_members_active_user', 'sysbuild_members(project_id, user_id) WHERE user_id IS NOT NULL AND removed_at IS NULL', true],
  ['idx_sysbuild_appointments_party', 'sysbuild_appointments(party_id, status)'],
  ['uq_sysbuild_appointments_active', 'sysbuild_appointments(party_id) WHERE status = \'active\'', true],
  ['idx_sysbuild_delegations_party', 'sysbuild_delegations(party_id, status)'],
  ['uq_sysbuild_delegations_active', 'sysbuild_delegations(party_id) WHERE status = \'active\'', true],
  ['idx_sysbuild_invitations_member', 'sysbuild_invitations(member_id, status)'],
  ['uq_sysbuild_batches_seq', 'sysbuild_batches(project_id, seq)', true],
  ['uq_sysbuild_batches_default', 'sysbuild_batches(project_id) WHERE is_default = 1', true],
  ['idx_sysbuild_nodes_project', 'sysbuild_nodes(project_id, batch_id, sort_order)'],
  ['uq_sysbuild_nodes_golive', 'sysbuild_nodes(batch_id) WHERE is_golive_milestone = 1', true],
  ['idx_sysbuild_schedule_node', 'sysbuild_node_schedule_records(node_id, id)'],
  ['uq_sysbuild_schedule_baseline', 'sysbuild_node_schedule_records(node_id) WHERE kind = \'baseline\'', true],
  ['idx_sysbuild_modules_project', 'sysbuild_modules(project_id)'],
  // C3b 预筛可选加固：模块名项目内唯一（S5，按存储的值精确比较、大小写敏感）；服务端预查给业务提示，索引兜底
  ['uq_sysbuild_modules_name', 'sysbuild_modules(project_id, name)', true],
  ['uq_sysbuild_items_code', 'sysbuild_items(project_id, code)', true],
  ['uq_sysbuild_item_versions_no', 'sysbuild_item_versions(item_id, version_no)', true],
  ['idx_sysbuild_packages_project', 'sysbuild_packages(project_id, type, batch_id)'],
  // 方案 v1.2 D41：每项目 initiation / overall / closing 各至多一个包；每批 batch_req / batch_accept 各至多一个包（change 不限）
  ['uq_sysbuild_packages_project_single', 'sysbuild_packages(project_id, type) WHERE type IN (\'initiation\',\'overall\',\'closing\')', true],
  ['uq_sysbuild_packages_batch_single', 'sysbuild_packages(batch_id, type) WHERE type IN (\'batch_req\',\'batch_accept\')', true],
  ['uq_sysbuild_package_versions_no', 'sysbuild_package_versions(package_id, version_no)', true],
  ['uq_sysbuild_package_versions_effective', 'sysbuild_package_versions(package_id) WHERE status = \'effective\'', true],
  ['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \'pending\'', true],
  // C3b 预筛可选加固：每个包同一时刻至多一个草稿版本（S4）；服务端预查给业务提示，索引兜底
  ['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \'draft\'', true],
  ['idx_sysbuild_pkg_item_rev_version', 'sysbuild_package_item_revisions(package_version_id, id)'],
  ['uq_sysbuild_materials_key', 'sysbuild_materials(node_id, material_key)', true],
  ['uq_sysbuild_material_versions_no', 'sysbuild_material_versions(material_id, version_no)', true],
  ['idx_sysbuild_entries_project', 'sysbuild_entries(project_id, node_id, period)'],
  ['idx_sysbuild_entries_type', 'sysbuild_entries(project_id, type)'],
  ['idx_sysbuild_entry_items_entry', 'sysbuild_entry_items(entry_id)'],
  ['idx_sysbuild_entry_items_item', 'sysbuild_entry_items(item_id)'],
  ['idx_sysbuild_entry_actions_entry', 'sysbuild_entry_actions(entry_id, id)'],
  ['idx_sysbuild_changes_project', 'sysbuild_changes(project_id, status)'],
  // C5 S-S1c：每条变更对应一个变更包（建变更时同一事务建包与第一版草稿），一个变更包至多对应一条变更
  ['uq_sysbuild_changes_package', 'sysbuild_changes(package_id)', true],
  ['idx_sysbuild_confirm_tasks_project', 'sysbuild_confirm_tasks(project_id, object_type, object_id)'],
  ['uq_sysbuild_task_revisions_no', 'sysbuild_confirm_task_revisions(task_id, rev_no)', true],
  ['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \'pending\'', true],
  ['idx_sysbuild_task_revisions_member', 'sysbuild_confirm_task_revisions(required_member_id, status)'],
  ['idx_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)'],
  // 方案 v1.2 D42 / §4.2「一修订一决策」：一条任务修订只接受一次终态决策；历史补录（task_revision_id 为空）不受限
  ['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id) WHERE task_revision_id IS NOT NULL', true],
  ['idx_sysbuild_confirmations_object', 'sysbuild_confirmations(object_type, object_version_id)'],
  ['idx_sysbuild_views_user_object', 'sysbuild_views(user_id, object_type, object_version_id)'],
  ['idx_sysbuild_golive_batch', 'sysbuild_golive_events(batch_id, id)'],
  ['idx_sysbuild_notices_project', 'sysbuild_notices(project_id, recipient_member_id)'],
  ['idx_sysbuild_notice_attempts_notice', 'sysbuild_notice_attempts(notice_id, id)'],
  ['idx_sysbuild_notice_receipts_attempt', 'sysbuild_notice_receipts(attempt_id, id)'],
  ['uq_sysbuild_notice_objections', 'sysbuild_notice_objections(notice_id)', true],
  ['idx_sysbuild_comments_object', 'sysbuild_comments(project_id, object_type, object_id)'],
  ['idx_sysbuild_attachments_project', 'sysbuild_attachments(project_id, uploaded_by)'],
  ['idx_sysbuild_bindings_owner', 'sysbuild_attachment_bindings(owner_type, owner_id)'],
  ['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true],
  ['idx_sysbuild_attachment_refs_owner', 'sysbuild_attachment_refs(owner_type, owner_id)'],
  ['uq_sysbuild_frozen', 'sysbuild_frozen_attachments(object_type, object_version_id, attachment_id)', true],
  ['idx_sysbuild_frozen_attachment', 'sysbuild_frozen_attachments(attachment_id)'],
  ['idx_sysbuild_batch_relations_from', 'sysbuild_batch_relations(from_batch_id)'],
  ['idx_sysbuild_batch_relations_to', 'sysbuild_batch_relations(to_batch_id)'],
  ['idx_sysbuild_routing_part', 'sysbuild_routing_snapshots(entry_id, part_no, id)'],
  ['idx_sysbuild_routing_batch', 'sysbuild_routing_snapshots(committed_batch_id)'],
  ['idx_sysbuild_history_imports_project', 'sysbuild_history_imports(project_id, object_type, object_id)'],
  ['idx_sysbuild_send_intents_status', 'sysbuild_send_intents(status, project_id)'],
  ['idx_sysbuild_card_instances_revision', 'sysbuild_card_instances(task_revision_id)'],
  ['idx_sysbuild_events_project', 'sysbuild_events(project_id, id)'],
  ['idx_sysbuild_events_object', 'sysbuild_events(object_type, object_id)'],
];

// 允许 UPDATE 的列（§6.2「可更新列」）。其余列只在 INSERT 时写入；任何 DELETE 都不允许。
//   verify-sysbuild-static.js 扫描路由里每条 UPDATE 的 SET 列，必须是本表的子集。
const UPDATABLE_COLUMNS = Object.freeze({
  // build_type 建项后不可改（方案 v1.2 D44 / §6.2）：建项 INSERT 写入，之后不在可更新列内，静态守卫据此拒绝任何改它的 UPDATE。
  sysbuild_projects: ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on', 'pm_user_id', 'status', 'history_window', 'updated_at'],
  sysbuild_parties: ['name'],
  sysbuild_members: ['joined_at', 'removed_at', 'removed_reason'],
  sysbuild_appointments: ['status', 'effective_at', 'ended_at', 'end_reason'],
  sysbuild_delegations: ['status', 'effective_at', 'revoked_at', 'revoke_reason'],
  sysbuild_invitations: ['status', 'responded_at'],
  sysbuild_batches: ['status', 'name', 'superseded_by', 'transfer_change_id', 'dev_assignee_member_id'],
  sysbuild_nodes: ['name', 'sort_order', 'status', 'opened_at', 'closed_at', 'updated_at'],
  sysbuild_modules: ['name'],
  sysbuild_items: ['module_id'],
  sysbuild_item_versions: ['proposer_status', 'deny_reason'],
  // form / parent_overall_version_id：提交确认时按项目现状重算，与草稿存的值不同则在草稿条件下回写（C4a 修订批 P32）
  sysbuild_package_versions: ['status', 'effective_at', 'snapshot_json', 'form', 'parent_overall_version_id', 'updated_at'],
  // package_version_id：提交（submit）时由空写入产出的内容包版本（C1b 预筛待裁 1，自决 P3 待追认）
  sysbuild_changes: ['status', 'package_version_id', 'updated_at'],
  sysbuild_confirm_task_revisions: ['status', 'status_reason', 'updated_at'],
  sysbuild_comments: ['upgraded_entry_id', 'voided_at', 'void_reason'],
  sysbuild_attachments: ['deleted_at', 'deleted_by', 'masked_at', 'masked_by', 'mask_reason'],
  sysbuild_send_intents: ['status', 'attempts', 'last_error', 'updated_at'],
  sysbuild_card_instances: ['status'],
});

// 条件更新合约（10 号 M-7）：这些列虽在 UPDATABLE_COLUMNS 里，但只允许在指定条件下更新——更新它们的
//   UPDATE 语句的 WHERE 必须原样包含这里登记的条件片段，并由调用方核对影响行数。verify-sysbuild-static.js 据此扫描。
//   登记残余（C4a 修订批）：sysbuild_package_versions.status 有 draft / pending / effective / superseded 四种合法旧状态（提交 draft→pending、撤回 pending→superseded、
//   生效 pending→effective、替代 effective→superseded），放不进这里「一列一个片段」的白名单，所以 confirm.js / confirm-core.js 里每处写 status 的 UPDATE 都自己带旧状态条件
//   并核影响行数（0 → 409），静态守卫（S2）不覆盖这几处。
const CONDITIONAL_UPDATES = Object.freeze({
  sysbuild_package_versions: Object.freeze({ snapshot_json: "status = 'draft'", form: "status = 'draft'", parent_overall_version_id: "status = 'draft'" }),
  sysbuild_members: Object.freeze({ joined_at: 'joined_at IS NULL' }),
  // C4a：提出人状态只在「待确认」时由确认记录驱动改写一次；任务修订的终态（已确认 / 有异议 / 不认可 / 已失效 / 已替代）都只从「待确认」转入
  sysbuild_item_versions: Object.freeze({ proposer_status: "proposer_status = 'pending'", deny_reason: "proposer_status = 'pending'" }),
  sysbuild_confirm_task_revisions: Object.freeze({ status: "status = 'pending'", status_reason: "status = 'pending'" }),
  // C4a 修订批三 M-1：合并形态总体规划包生效时，批次只从「规划中」推进到「进行中」（confirm-core.js advancePlanningBatches）；其余批次状态转移（上线 / 转出 / 被替代，C5–C6）
  //   到时各自登记。
  //   C6a：批次状态转移增加 进行中 → 已上线（确认试运行结束）与 已上线 → 进行中（撤销上线），旧状态各不相同，与 history_window 同写法登记为单项 `status = ?`（旧值作参数传入，
  //   规划中 → 进行中也改成带参数的写法，confirm-core.advancePlanningBatches）。
  sysbuild_batches: Object.freeze({ status: 'status = ?' }),
  // C4b Q-S2：历史补录窗口三态（never / open / closed）的转移只在 history.js 一处写：开启 never → open、关闭 open → closed、重开 closed → open；
  //   每条 UPDATE 的 WHERE 带「history_window = ?」（旧值），核影响行数（0 → 409）。登记片段是单项 `history_window = ?` 而不是某个字面量：三种转移的旧值不同，放不进「一列一个字面量」的写法。
  sysbuild_projects: Object.freeze({ history_window: 'history_window = ?' }),
  // C6b：发送意图的状态只经 notify.js 的「记发送结果」一处写（pending → sent / failed，failed → sent / failed，跳过的 → sent）；每条 UPDATE 的 WHERE 带旧状态（status = ?，旧值作参数），核影响行数。
  sysbuild_send_intents: Object.freeze({ status: 'status = ?' }),
});

function tableSql(name, body) {
  return `CREATE TABLE IF NOT EXISTS ${name} (${body}\n  )`;
}
function indexSql(name, target, unique) {
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${target}`;
}

// 结构对象清单（建表顺序：先全部表，再全部索引）。
const SCHEMA_OBJECTS = Object.freeze([
  ...TABLES.map(([name, body]) => Object.freeze({ type: 'table', name, sql: tableSql(name, body) })),
  ...INDEXES.map(([name, target, unique]) => Object.freeze({ type: 'index', name, sql: indexSql(name, target, !!unique) })),
]);

const TABLE_NAMES = Object.freeze(TABLES.map(([name]) => name));

module.exports = { SCHEMA_OBJECTS, TABLE_NAMES, ENUMS, UPDATABLE_COLUMNS, CONDITIONAL_UPDATES, dateCheck };
