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
//   - 系统动作（启动补发等）写事件时 operator_id = 0、operator_name = '系统'。
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
  partySide: ['demand', 'dev'],
  appointmentStatus: ['active', 'ended'],
  delegationStatus: ['active', 'revoked'],
  batchStatus: ['planning', 'active', 'live'],
  nodeStatus: ['not_started', 'in_progress', 'closed', 'cancelled'],
  scheduleKind: ['baseline', 'plan_change', 'actual_start', 'actual_end', 'actual_correct'],
  // 方案 v1.2 D41：总体规划单一身份——包类型去掉 overall_batch_req（单批合并形态改记在包版本的 form 上）
  packageType: ['initiation', 'overall', 'batch_accept', 'closing'],
  // 包版本形态（只在总体规划包的版本上填写）：overall = 普通「总体」；overall_batch_req = 单批项目的「总体 + 批次需求」合并形态
  packageForm: ['overall', 'overall_batch_req'],
  packageVersionStatus: ['draft', 'pending', 'effective', 'superseded'],
  // §4.1 七类登记：补充说明 / 补交材料 / 经验教训 / 使用与效益 / 更正 / 意见与反馈 / 问题与处理
  entryType: ['note', 'material', 'lesson', 'benefit', 'correction', 'feedback', 'issue'],
  entryPeriod: ['process', 'supplement'],
  entryAction: ['correct', 'void'],
  confirmObjectType: ['package_version'],
  confirmPurpose: ['package_confirm'],
  revisionStatus: ['pending', 'confirmed', 'objected', 'rejected', 'invalid', 'superseded'],
  confirmMethod: ['platform', 'card'],
  confirmDecision: ['confirm', 'object', 'reject'],
  viewSource: ['page', 'self_submit', 'card_render'],
  goliveKind: ['golive', 'revoke', 'regolive'],
  noticeKind: ['schedule_change'],
  noticeChannel: ['dingtalk', 'platform'],
  noticeResult: ['sent', 'failed'],
  bindingOwnerType: ['entry', 'material_version', 'golive_event', 'schedule_record', 'package_version', 'opinion', 'opinion_assessment', 'work_task'],
  frozenObjectType: ['package_version', 'entry', 'material_version'],
  sendIntentStatus: ['pending', 'sent', 'failed'],
  cardStatus: ['sent', 'updated', 'expired'],
  opinionSide: ['demand', 'dev', 'internal'],
  opinionCategory: ['requirement', 'problem', 'improvement', 'cut'],
  opinionStatus: ['triage', 'assessment', 'disposition', 'cut_approval', 'concluded'],
  opinionOutcome: ['now', 'next', 'no', 'cut_agreed', 'scope_kept'],
  assessmentSource: ['self', 'dev', 'proxy'],
  workTaskStatus: ['pending', 'done', 'cancelled'],
  cutApprovalStatus: ['pending', 'agree', 'object'],
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
    user_id INTEGER NOT NULL,
    joined_at DATETIME NOT NULL,
    removed_at DATETIME,
    removed_reason TEXT,
    added_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK ((removed_at IS NULL) = (removed_reason IS NULL))`],
  ['sysbuild_appointments', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    status TEXT NOT NULL ${inList('status', E.appointmentStatus)},
    proposed_by INTEGER NOT NULL,
    effective_at DATETIME NOT NULL,
    ended_at DATETIME,
    end_reason TEXT,
    created_at ${TS},
    CHECK ((status = 'ended') = (ended_at IS NOT NULL))`],
  ['sysbuild_delegations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    appointment_id INTEGER NOT NULL,
    status TEXT NOT NULL ${inList('status', E.delegationStatus)},
    proposed_by INTEGER NOT NULL,
    effective_at DATETIME NOT NULL,
    revoked_at DATETIME,
    revoke_reason TEXT,
    created_at ${TS},
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (revoked_at IS NULL OR (revoke_reason IS NOT NULL AND length(trim(revoke_reason)) > 0))`],
  ['sysbuild_batches', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    name TEXT NOT NULL,
    ${BOOL('is_default')},
    status TEXT NOT NULL DEFAULT 'planning' ${inList('status', E.batchStatus)},
    dev_assignee_member_id INTEGER,
    created_at ${TS}`],
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
  ['sysbuild_packages', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    batch_id INTEGER,
    type TEXT NOT NULL ${inList('type', E.packageType)},
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (type <> 'batch_accept' OR batch_id IS NOT NULL),
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
    created_at ${TS},
    CHECK ((period = 'supplement') = (days_after_close IS NOT NULL)),
    CHECK (days_after_close IS NULL OR days_after_close >= 0),
    CHECK (no_written_evidence = 0 OR (no_evidence_reason IS NOT NULL AND length(trim(no_evidence_reason)) >= 10))`],
  ['sysbuild_entry_actions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    action TEXT NOT NULL ${inList('action', E.entryAction)},
    text TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
  ['sysbuild_confirm_tasks', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    object_type TEXT NOT NULL ${inList('object_type', E.confirmObjectType)},
    object_id INTEGER NOT NULL,
    object_version_id INTEGER NOT NULL,
    purpose TEXT NOT NULL ${inList('purpose', E.confirmPurpose)},
    party_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at ${TS}`],
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
  // 确认记录挂在对应的内容包任务修订上。
  ['sysbuild_confirmations', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_revision_id INTEGER NOT NULL,
    object_type TEXT NOT NULL ${inList('object_type', E.confirmObjectType)},
    object_version_id INTEGER NOT NULL,
    actor_user_id INTEGER,
    method TEXT NOT NULL ${inList('method', E.confirmMethod)},
    decision TEXT NOT NULL ${inList('decision', E.confirmDecision)},
    checkbox_text TEXT,
    reason TEXT,
    view_id INTEGER,
    card_instance_id INTEGER,
    dingtalk_user_id TEXT,
    created_at ${TS},
    CHECK (method <> 'platform' OR (actor_user_id IS NOT NULL AND view_id IS NOT NULL AND checkbox_text IS NOT NULL AND length(trim(checkbox_text)) > 0)),
    CHECK (method <> 'card' OR (actor_user_id IS NOT NULL AND card_instance_id IS NOT NULL AND dingtalk_user_id IS NOT NULL)),
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
    reason TEXT,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK (kind <> 'revoke' OR (reason IS NOT NULL AND length(trim(reason)) > 0))`],
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
  ['sysbuild_opinions', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    node_id INTEGER,
    author_user_id INTEGER NOT NULL,
    author_name TEXT NOT NULL CHECK (length(trim(author_name)) > 0),
    author_side TEXT NOT NULL ${inList('author_side', E.opinionSide)},
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    category TEXT ${inList('category', E.opinionCategory, true)},
    status TEXT NOT NULL DEFAULT 'triage' ${inList('status', E.opinionStatus)},
    triage_text TEXT,
    triaged_by INTEGER,
    triaged_at DATETIME,
    needs_assessment INTEGER CHECK (needs_assessment IN (0,1)),
    skip_reason TEXT,
    assessment_text TEXT,
    assessment_hours REAL CHECK (assessment_hours IS NULL OR (typeof(assessment_hours) = 'real' AND assessment_hours BETWEEN 0 AND 1.7976931348623157e308)),
    assessment_source TEXT ${inList('assessment_source', E.assessmentSource, true)},
    assessed_by INTEGER,
    assessed_at DATETIME,
    assessed_for_user_id INTEGER,
    assessed_for_delegation_id INTEGER,
    outcome TEXT ${inList('outcome', E.opinionOutcome, true)},
    outcome_text TEXT,
    resolved_by INTEGER,
    resolved_at DATETIME,
    cut_scope_version_id INTEGER,
    adjustment_version_id INTEGER,
    created_at ${TS},
    updated_at ${TS},
    CHECK ((status = 'triage' AND category IS NULL AND triaged_by IS NULL AND triaged_at IS NULL)
      OR (status <> 'triage' AND category IS NOT NULL AND triage_text IS NOT NULL AND triaged_by IS NOT NULL AND triaged_at IS NOT NULL)),
    CHECK ((assessment_source IS NULL AND assessment_text IS NULL AND assessment_hours IS NULL AND assessed_by IS NULL AND assessed_at IS NULL)
      OR (assessment_source IS NOT NULL AND assessment_text IS NOT NULL AND assessment_hours IS NOT NULL AND assessed_by IS NOT NULL AND assessed_at IS NOT NULL)),
    CHECK ((assessed_for_user_id IS NULL AND assessed_for_delegation_id IS NULL)
      OR (assessment_source IS NOT NULL AND assessed_for_user_id IS NOT NULL AND assessed_for_delegation_id IS NOT NULL)),
    CHECK ((status = 'concluded' AND outcome IS NOT NULL AND outcome_text IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
      OR (status <> 'concluded' AND outcome IS NULL AND outcome_text IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)),
    CHECK (status <> 'cut_approval' OR (category = 'cut' AND cut_scope_version_id IS NOT NULL)),
    CHECK (adjustment_version_id IS NULL OR (status = 'concluded' AND ((outcome = 'now' AND category = 'requirement')
      OR (outcome = 'cut_agreed' AND category = 'cut' AND cut_scope_version_id IS NOT NULL AND adjustment_version_id = cut_scope_version_id))))`],
  ['sysbuild_tasks', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    source_opinion_id INTEGER,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    assignee_user_id INTEGER NOT NULL,
    planned_on TEXT ${dateCheck('planned_on', true)},
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.workTaskStatus)},
    result_text TEXT,
    resolved_by INTEGER,
    resolved_at DATETIME,
    created_by INTEGER NOT NULL,
    created_at ${TS},
    CHECK ((status = 'pending' AND result_text IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
      OR (status <> 'pending' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
    CHECK (status <> 'cancelled' OR (result_text IS NOT NULL AND length(trim(result_text)) > 0))`],
  ['sysbuild_cut_approvals', `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    opinion_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    party_name TEXT NOT NULL CHECK (length(trim(party_name)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' ${inList('status', E.cutApprovalStatus)},
    decided_by INTEGER,
    delegation_id INTEGER,
    decision_text TEXT,
    decided_at DATETIME,
    created_at ${TS},
    CHECK ((status = 'pending' AND decided_by IS NULL AND delegation_id IS NULL AND decision_text IS NULL AND decided_at IS NULL)
      OR (status <> 'pending' AND decided_by IS NOT NULL AND delegation_id IS NOT NULL AND decided_at IS NOT NULL))`],
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
  ['uq_sysbuild_batches_seq', 'sysbuild_batches(project_id, seq)', true],
  ['uq_sysbuild_batches_default', 'sysbuild_batches(project_id) WHERE is_default = 1', true],
  ['idx_sysbuild_nodes_project', 'sysbuild_nodes(project_id, batch_id, sort_order)'],
  ['uq_sysbuild_nodes_golive', 'sysbuild_nodes(batch_id) WHERE is_golive_milestone = 1', true],
  ['idx_sysbuild_schedule_node', 'sysbuild_node_schedule_records(node_id, id)'],
  ['uq_sysbuild_schedule_baseline', 'sysbuild_node_schedule_records(node_id) WHERE kind = \'baseline\'', true],
  ['idx_sysbuild_packages_project', 'sysbuild_packages(project_id, type, batch_id)'],
  // 方案 v1.2 D41：每项目 initiation / overall / closing 各至多一个包；每批至多一个批次验收包
  ['uq_sysbuild_packages_project_single', 'sysbuild_packages(project_id, type) WHERE type IN (\'initiation\',\'overall\',\'closing\')', true],
  ['uq_sysbuild_packages_batch_single', 'sysbuild_packages(batch_id, type) WHERE type = \'batch_accept\'', true],
  ['uq_sysbuild_package_versions_no', 'sysbuild_package_versions(package_id, version_no)', true],
  ['uq_sysbuild_package_versions_effective', 'sysbuild_package_versions(package_id) WHERE status = \'effective\'', true],
  ['uq_sysbuild_package_versions_pending', 'sysbuild_package_versions(package_id) WHERE status = \'pending\'', true],
  // C3b 预筛可选加固：每个包同一时刻至多一个草稿版本（S4）；服务端预查给业务提示，索引兜底
  ['uq_sysbuild_package_versions_draft', 'sysbuild_package_versions(package_id) WHERE status = \'draft\'', true],
  ['uq_sysbuild_materials_key', 'sysbuild_materials(node_id, material_key)', true],
  ['uq_sysbuild_material_versions_no', 'sysbuild_material_versions(material_id, version_no)', true],
  ['idx_sysbuild_entries_project', 'sysbuild_entries(project_id, node_id, period)'],
  ['idx_sysbuild_entries_type', 'sysbuild_entries(project_id, type)'],
  ['idx_sysbuild_entry_actions_entry', 'sysbuild_entry_actions(entry_id, id)'],
  ['idx_sysbuild_confirm_tasks_project', 'sysbuild_confirm_tasks(project_id, object_type, object_id)'],
  ['uq_sysbuild_task_revisions_no', 'sysbuild_confirm_task_revisions(task_id, rev_no)', true],
  ['uq_sysbuild_task_revisions_pending', 'sysbuild_confirm_task_revisions(task_id) WHERE status = \'pending\'', true],
  ['idx_sysbuild_task_revisions_member', 'sysbuild_confirm_task_revisions(required_member_id, status)'],
  ['idx_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)'],
  // 方案 v1.2 D42 / §4.2「一修订一决策」：一条任务修订只接受一次终态决策
  ['uq_sysbuild_confirmations_revision', 'sysbuild_confirmations(task_revision_id)', true],
  ['idx_sysbuild_confirmations_object', 'sysbuild_confirmations(object_type, object_version_id)'],
  ['idx_sysbuild_views_user_object', 'sysbuild_views(user_id, object_type, object_version_id)'],
  ['idx_sysbuild_golive_batch', 'sysbuild_golive_events(batch_id, id)'],
  ['idx_sysbuild_notices_project', 'sysbuild_notices(project_id, recipient_member_id)'],
  ['idx_sysbuild_notice_attempts_notice', 'sysbuild_notice_attempts(notice_id, id)'],
  ['idx_sysbuild_attachments_project', 'sysbuild_attachments(project_id, uploaded_by)'],
  ['idx_sysbuild_bindings_owner', 'sysbuild_attachment_bindings(owner_type, owner_id)'],
  ['uq_sysbuild_attachment_refs', 'sysbuild_attachment_refs(attachment_id, owner_type, owner_id)', true],
  ['idx_sysbuild_attachment_refs_owner', 'sysbuild_attachment_refs(owner_type, owner_id)'],
  ['uq_sysbuild_frozen', 'sysbuild_frozen_attachments(object_type, object_version_id, attachment_id)', true],
  ['idx_sysbuild_frozen_attachment', 'sysbuild_frozen_attachments(attachment_id)'],
  ['idx_sysbuild_send_intents_status', 'sysbuild_send_intents(status, project_id)'],
  ['idx_sysbuild_card_instances_revision', 'sysbuild_card_instances(task_revision_id)'],
  ['idx_sysbuild_events_project', 'sysbuild_events(project_id, id)'],
  ['idx_sysbuild_events_object', 'sysbuild_events(object_type, object_id)'],
  ['idx_sysbuild_opinions_project_status', 'sysbuild_opinions(project_id, status, id)'],
  ['idx_sysbuild_opinions_adjustment', 'sysbuild_opinions(project_id, adjustment_version_id, id) WHERE adjustment_version_id IS NOT NULL'],
  ['idx_sysbuild_tasks_project_status', 'sysbuild_tasks(project_id, status, id)'],
  ['idx_sysbuild_tasks_node', 'sysbuild_tasks(project_id, node_id, id)'],
  ['uq_sysbuild_tasks_source_opinion', 'sysbuild_tasks(source_opinion_id) WHERE source_opinion_id IS NOT NULL', true],
  ['uq_sysbuild_cut_approvals_party', 'sysbuild_cut_approvals(opinion_id, party_id)', true],
];

// 允许 UPDATE 的列（§6.2「可更新列」）。其余列只在 INSERT 时写入；任何 DELETE 都不允许。
//   verify-sysbuild-static.js 扫描路由里每条 UPDATE 的 SET 列，必须是本表的子集。
const UPDATABLE_COLUMNS = Object.freeze({
  // build_type 建项后不可改（方案 v1.2 D44 / §6.2）：建项 INSERT 写入，之后不在可更新列内，静态守卫据此拒绝任何改它的 UPDATE。
  sysbuild_projects: ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on', 'pm_user_id', 'status', 'updated_at'],
  sysbuild_parties: ['name'],
  sysbuild_members: ['removed_at', 'removed_reason'],
  sysbuild_appointments: ['status', 'ended_at', 'end_reason'],
  sysbuild_delegations: ['status', 'revoked_at', 'revoke_reason'],
  sysbuild_batches: ['status', 'name', 'dev_assignee_member_id'],
  sysbuild_nodes: ['name', 'sort_order', 'status', 'opened_at', 'closed_at', 'updated_at'],
  // form / parent_overall_version_id：提交确认时按项目现状重算，与草稿存的值不同则在草稿条件下回写（C4a 修订批 P32）
  sysbuild_package_versions: ['status', 'effective_at', 'snapshot_json', 'form', 'parent_overall_version_id', 'updated_at'],
  sysbuild_confirm_task_revisions: ['status', 'status_reason', 'updated_at'],
  sysbuild_attachments: ['deleted_at', 'deleted_by', 'masked_at', 'masked_by', 'mask_reason'],
  sysbuild_send_intents: ['status', 'attempts', 'last_error', 'updated_at'],
  sysbuild_card_instances: ['status'],
  sysbuild_opinions: ['category', 'status', 'triage_text', 'triaged_by', 'triaged_at', 'needs_assessment', 'skip_reason',
    'assessment_text', 'assessment_hours', 'assessment_source', 'assessed_by', 'assessed_at', 'assessed_for_user_id', 'assessed_for_delegation_id',
    'outcome', 'outcome_text', 'resolved_by', 'resolved_at', 'cut_scope_version_id', 'adjustment_version_id', 'updated_at'],
  sysbuild_tasks: ['status', 'result_text', 'resolved_by', 'resolved_at'],
  sysbuild_cut_approvals: ['status', 'decided_by', 'delegation_id', 'decision_text', 'decided_at'],
});

// 条件更新合约（10 号 M-7）：这些列虽在 UPDATABLE_COLUMNS 里，但只允许在指定条件下更新——更新它们的
//   UPDATE 语句的 WHERE 必须原样包含这里登记的条件片段，并由调用方核对影响行数。verify-sysbuild-static.js 据此扫描。
//   登记残余（C4a 修订批）：sysbuild_package_versions.status 有 draft / pending / effective / superseded 四种合法旧状态（提交 draft→pending、撤回 pending→superseded、
//   生效 pending→effective、替代 effective→superseded），放不进这里「一列一个片段」的白名单，所以 confirm.js / confirm-core.js 里每处写 status 的 UPDATE 都自己带旧状态条件
//   并核影响行数（0 → 409），静态守卫（S2）不覆盖这几处。
const CONDITIONAL_UPDATES = Object.freeze({
  sysbuild_package_versions: Object.freeze({ snapshot_json: "status = 'draft'", form: "status = 'draft'", parent_overall_version_id: "status = 'draft'" }),
  sysbuild_members: Object.freeze({ removed_at: 'removed_at IS NULL', removed_reason: 'removed_at IS NULL' }),
  sysbuild_appointments: Object.freeze({ status: "status = 'active'", ended_at: "status = 'active'", end_reason: "status = 'active'" }),
  sysbuild_delegations: Object.freeze({ status: "status = 'active'", revoked_at: "status = 'active'", revoke_reason: "status = 'active'" }),
  sysbuild_confirm_task_revisions: Object.freeze({ status: "status = 'pending'", status_reason: "status = 'pending'" }),
  // 合并形态总体规划生效后，批次由规划中转进行中。上线与撤销在进行中和已上线间转换。
  // 每次写入都在 WHERE 中带旧状态参数。
  sysbuild_batches: Object.freeze({ status: 'status = ?' }),
  // C6b：发送意图的状态只经 notify.js 的「记发送结果」一处写（pending → sent / failed，failed → sent / failed，跳过的 → sent）；每条 UPDATE 的 WHERE 带旧状态（status = ?，旧值作参数），核影响行数。
  sysbuild_send_intents: Object.freeze({ status: 'status = ?' }),
  sysbuild_opinions: Object.freeze({ status: 'status = ?' }),
  sysbuild_tasks: Object.freeze({ status: "status = 'pending'" }),
  sysbuild_cut_approvals: Object.freeze({ status: "status = 'pending'" }),
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
