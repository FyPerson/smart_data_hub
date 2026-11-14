// routes/sysbuild/entries.js — 项目管理（系统建设记录）模块：登记与办理、知会与知会异议（C5 S-S1a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记、办理结论的确认、仅供参考）、§4.2「办理结论」「异议裁定」、§4.5、§5.2–5.3、§6.2、§6.3、§7「登记与办理」「知会」。
//   派单 = docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md（本文口径与方案冲突时以派单为准，冲突点在交付报告里列出）。
//
// 工厂 createEntryRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（todayProvider：业务日期上限与「收口后第 N 天」用，缺省取服务器本地日期）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 对象状态 / 业务规则 409 → 证据与引用对象 400。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp（OBJECT_OPS + OP_KIND）；读接口逐对象 actions 用 rules.opAllowed 与同一个 target 构造函数（entries-core.entryTarget），标志与执行同源。
// 登记与办理记录只追加（sysbuild_entries / sysbuild_entry_actions 不在 UPDATABLE_COLUMNS）；登记当前状态（结论状态、涉及承诺、风险）全部由服务端派生，不落列。
// S-S1b 已加：分流判定与判定快照（entries-routing.js）、混合拆分与手动 split、待判定归属 assign_items、link_sys_issue、关联已上线条目时「关闭新增」、
//   节点收口前置（plan.js 经 entries-core）、收口后异议（objects_entry_id 与知会异议的 supplement_entry 模式）。
// S-S1c 已加：结论「转正式变更」（change_id 必填，同一事务写 link_change 办理记录）与独立的 link_change 动作；开发方处理说明 / 正式交付物用途与来源方为开发方的涉及承诺（需要开发方负责人认可：认可任务、
//   本人提交并确认、修订重提 revision_of_entry_id、办理依据 basis_dev_note_entry_id）；变更本身（建变更 / 出新版本 / 读）在 changes.js，提交 / 撤回在 confirm.js，生效在 confirm-core.applyChangeEffect。
// 仍不做（代码里遇到的明确 409，不做半套）：评论与评论转登记（第二期）；钉钉发送与待办派生（C6）。
'use strict';
const { attachmentStateFields } = require('./attachments');
const express = require('express');
const rules = require('./rules');
const schema = require('./schema');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { resolveCurrentPlan } = require('./packages');
const { attachmentDisplayName } = require('./attachments');
const core = require('./confirm-core');
const entries = require('./entries-core');
const routing = require('./entries-routing');
const goliveCore = require('./golive-core'); // C6a：登记有新的办理动作后，让过期的交接确认失效（golive-core 不依赖本文件，不成环）
const notifySchedule = require('./notify-schedule'); // C6b：改期知会的视图 / 异议资格（只依赖 events / confirm-core / notify-core，不成环）

const TITLE_MAX = 100;
const BODY_MAX = 4000;
const TEXT_MAX = 2000; // 结论 / 更正 / 裁定说明
const REASON_MAX = 500; // 作废、标记、无书面证据、异议原因
const ASSIGNEE_MAX = 100;
const SYS_ISSUE_MAX = 32; // 系统迭代单号：1–32 位文本，只存文本不校验单据存在（D9）
const EVIDENCE_REASON_MIN = 10;
const ID_LIST_MAX = 20;
const ITEM_IDS_MAX = 50;
const CREATE_KEYS = Object.freeze([
  'node_id', 'type', 'purpose', 'title', 'body', 'business_date', 'commitment_flag', 'is_risk', 'source_party_id', 'item_ids', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason',
  'objects_entry_id', 'revision_of_entry_id', 'self_confirm_text',
]);
// 异议登记（objects_entry_id 非空）只认这几个键：节点 / 条目 / 来源方 / 标志都由被异议的登记与提出人身份决定，不由请求指定（D34）
const OBJECTION_KEYS = Object.freeze(['objects_entry_id', 'type', 'title', 'body', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
const OBJECTION_TYPES = Object.freeze(['feedback', 'issue']);
// 登记类型：七类去掉「更正」——更正走办理动作 correct，不作独立登记（派单 §3）
const REGISTERABLE_TYPES = Object.freeze(schema.ENUMS.entryType.filter((x) => x !== 'correction'));
// 办理动作 → 允许的请求字段（其余字段 400）。动作名 = OBJECT_OPS 里 entry_<动作>。
//   S-S1c：conclude 加 change_id（转正式变更必填，其余类别不许带）与 basis_dev_note_entry_id（可选，办理依据 = 已认可的开发方处理说明登记）；link_change = 给已有结论的登记补挂变更号。
const ACTION_FIELDS = Object.freeze({
  correct: Object.freeze(['text']),
  void: Object.freeze(['reason']),
  conclude: Object.freeze(['conclusion_kind', 'text', 'sys_issue_no', 'assignee_text', 'change_id', 'basis_dev_note_entry_id']),
  link_change: Object.freeze(['change_id', 'text']),
  for_reference: Object.freeze(['text']),
  mark_commitment: Object.freeze(['reason']),
  unmark_commitment: Object.freeze(['reason']),
  mark_risk: Object.freeze(['reason']),
  unmark_risk: Object.freeze(['reason']),
  escalate: Object.freeze(['text']),
  // S-S1b：手动拆分（groups = 条目编号分组）/ 待判定归属（依据类别、依据文字、条目、规划外的去向）/ 记系统迭代单号
  split: Object.freeze(['groups', 'text']),
  assign_items: Object.freeze(['basis_category', 'text', 'item_ids', 'route']),
  link_sys_issue: Object.freeze(['sys_issue_no', 'text']),
});
// 枚举里有、但不作为办理动作提交的动作：409。S-S1b 已开放 split / assign_items / link_sys_issue；S-S1c 开放 link_change，只剩 adjudicate（裁定经确认任务进行）。
const LATER_ACTIONS = Object.freeze(['adjudicate']);
const LATER_ACTION_MESSAGE = '该办理动作随后续阶段开放';
// adjudicate 枚举值保留在 entryAction 里，但本模块的裁定不作为「办理动作」提交：「交负责人裁定」（escalate）建裁定确认任务，负责人在确认任务里确认 / 不认可（POST /confirm-tasks/:tid/decide），
//   所以直接提交 adjudicate 动作的文案与「随后续阶段开放」区分开（L5）。
const ADJUDICATE_ACTION_MESSAGE = '裁定经确认任务进行，不作为办理动作';
// 需要写「原因」的动作：reason 存进办理记录的 text 列
const REASON_ACTIONS = Object.freeze(['void', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk']);
// 每个动作的 OBJECT_OPS 名与 actions 标志名（标志名 = 请求里的动作名）
const ACTION_FLAGS = Object.freeze(['correct', 'void', 'conclude', 'for_reference', 'mark_commitment', 'unmark_commitment', 'mark_risk', 'unmark_risk', 'escalate', 'split', 'assign_items', 'link_sys_issue', 'link_change', 'object']);

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
function bodyOf(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
  return b;
}
function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw invalid(`不支持的字段 ${k}`, k);
  }
}
function readText(raw, field, label, max, required) {
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (typeof raw !== 'string') throw invalid(`${label}必须是文本`, field);
  const v = raw.trim();
  if (v === '') {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field);
  if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
  return v;
}
// 0 / 1 / false / true；缺省 = 0
function readFlag(raw, field, label) {
  if (raw === undefined || raw === null) return 0;
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  throw invalid(`${label}必须是 0 / 1`, field);
}
function readIdParam(raw, field, label) {
  const id = rules.parseId(raw);
  if (!id) throw invalid(`${label}不合法`, field);
  return id;
}
function readIdList(raw, field, label, max) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid(`${label}列表格式不对`, field);
  if (raw.length > max) throw invalid(`${label}一次最多 ${max} 个`, field);
  const ids = raw.map((v) => readIdParam(v, field, label));
  if (new Set(ids).size !== ids.length) throw invalid(`${label}重复`, field);
  return ids;
}
function validDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// 方向类证据校验（与 items.js assertEvidence 同口径：至少一个附件，或声明无书面证据并写明原因 ≥ 10 字，两者互斥）。mode：
//   material = 补交材料（必有附件，「无书面证据」不能代替，缺 → 400 SYSBUILD_EVIDENCE_REQUIRED）；direction = 带「涉及承诺」标记的登记（附件或声明二选一）；optional = 证据可选（声明了就按同样规则校验）。
function assertEvidence(count, ev, mode) {
  if (mode === 'material' && count === 0) throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料必须上传附件');
  if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');
  if (!ev.noEvidence && ev.noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');
  if (mode === 'direction' && !ev.noEvidence && count === 0) {
    throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '带「涉及承诺」标记的登记须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）');
  }
  if (ev.noEvidence && (ev.noEvidenceReason === null || Array.from(ev.noEvidenceReason).length < EVIDENCE_REASON_MIN)) {
    throw invalid(`无书面证据原因至少 ${EVIDENCE_REASON_MIN} 个字`, 'no_evidence_reason');
  }
}

function createEntryRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/entries 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/entries 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/entries 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function' || typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') {
    throw new Error('routes/sysbuild/entries 参数 attachmentHelpers 必须带 bindStagedAttachments 与 freezeAttachmentSet');
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  const today = () => (typeof ctx.todayProvider === 'function' ? ctx.todayProvider() : core.localDateString(new Date()));

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      if (err.extra && typeof err.extra === 'object') Object.assign(body, err.extra); // S-S1b：拒绝新增的响应带 guide / live_items
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 登记接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '64kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
  });

  // ── 加载 ─────────────────────────────────────────────────────────────────────────────────
  async function loadProjectCtx(q, pid, user) {
    const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
    rules.assertVisible(access);
    const identity = await rules.completeIdentity(q, access, user);
    return { access, identity };
  }
  async function loadEntryCtx(q, eid, user) {
    const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
    if (!entry) throw rules.notFound();
    const pc = await loadProjectCtx(q, entry.project_id, user);
    return { entry, access: pc.access, identity: pc.identity };
  }
  const userNameOf = async (q, uid) => {
    const u = await q.get('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [uid]);
    return u ? u.n : null;
  };

  // ── 视图 ─────────────────────────────────────────────────────────────────────────────────
  // 每条登记的 actions：标志与写端点同一张 OBJECT_OPS 表、同一个 target 构造函数（entries-core.entryTarget），前端不推算。
  async function actionsOf(q, access, identity, entry, facts, user) {
    // 提异议标志（actions.object）的事实：资格依据 + 关联条目是否全部已上线 + 节点是否已取消（预筛 L-2，与 POST entries 带 objects_entry_id 同一个 entry_object 判定）；
    //   没有资格的人不必再算后两项（can 先于 state，标志恒为假）
    const basis = await entries.objectorBasisOf(q, entry, facts, identity, user);
    const oFacts = basis === null ? { itemsAllLive: false, nodeCancelled: false } : await routing.objectionFacts(q, entry, facts);
    const t = await entries.entryTarget(q, access.project, entry, facts, user, Object.assign({ objectorBasis: basis }, oFacts));
    const out = {};
    // codex 24 M2：conclude_kinds = 对 conclusionKind 全部类别逐一用同一判定（带 kind 的 target，与 POST …/actions 执行同源）算出的当前可用类别（按枚举顺序）；
    //   actions.conclude = conclude_kinds 非空（不再用不带类别的判定——那样「项目已终止」结论这类只在特定状态可用的类别会让标志与可选项对不上）。
    out.conclude_kinds = schema.ENUMS.conclusionKind.filter((kind) => rules.opAllowed('entry_conclude', identity, access.project, Object.assign({}, t, { kind })));
    for (const a of ACTION_FLAGS) out[a] = a === 'conclude' ? out.conclude_kinds.length > 0 : rules.opAllowed(`entry_${a}`, identity, access.project, t);
    return out;
  }
  function currentConclusionOf(derived) {
    const a = derived.current;
    if (!a) return null;
    return {
      action_id: a.id, action: a.action, kind: a.action === 'for_reference' ? 'for_reference' : a.conclusion_kind, text: a.text,
      sys_issue_no: a.sys_issue_no, assignee_text: a.assignee_text, change_id: a.change_id, basis_kind: a.basis_kind, basis_ref: a.basis_ref, created_by: a.created_by, created_at: a.created_at,
    };
  }
  const DEV_CONFIRM_LABELS = Object.freeze({ none: '未建认可任务', pending: '待开发方负责人认可', approved: '已认可', not_approved: '负责人未认可', lapsed: '认可已失效' });
  async function devConfirmView(q, entry, derived) {
    const required = await entries.entryNeedsDevConfirm(q, entry, derived.commitment_current === true);
    const dc = await entries.devConfirmOf(q, entry);
    return {
      required, status: dc.status, label: DEV_CONFIRM_LABELS[dc.status], task_id: dc.task ? dc.task.id : null,
      required_member_id: dc.revision ? dc.revision.required_member_id : null, required_name: dc.revision ? await entries.memberNameOf(q, dc.revision.required_member_id) : null,
      revised_by_entry_ids: (await q.all('SELECT id FROM sysbuild_entries WHERE revision_of_entry_id = ? ORDER BY id', [entry.id])).map((r) => r.id),
    };
  }
  async function baseView(q, access, identity, entry, facts, user) {
    const d = facts.derived;
    const conf = await entries.resolveConclusionConfirmer(q, entry);
    const devConfirm = await devConfirmView(q, entry, d);
    const actions = await actionsOf(q, access, identity, entry, facts, user);
    const sourceMatches = identity.isPm === true || identity.partyId === entry.source_party_id;
    const devPartyId = await entries.devPartyIdOf(q, entry.project_id);
    const canCreate = rules.opAllowed('entry_create_process', identity, access.project, {}) || rules.opAllowed('entry_create_supplement', identity, access.project, {});
    const purposeAllowed = !rules.ENTRY_DEV_PURPOSES.includes(entry.purpose) || rules.opAllowed('entry_create_dev', identity, access.project, { devPartyId });
    actions.revise = devConfirm.status === 'not_approved' && sourceMatches && canCreate && purposeAllowed;
    return {
      id: entry.id, project_id: entry.project_id, node_id: entry.node_id, type: entry.type, purpose: entry.purpose,
      source_party_id: entry.source_party_id, source_name: entry.source_name,
      operator_user_id: entry.operator_user_id, operator_name: await userNameOf(q, entry.operator_user_id), operator_identity: entries.parseSnapshot(entry),
      period: entry.period, days_after_close: entry.days_after_close, business_date: entry.business_date, title: entry.title, body: entry.body,
      no_written_evidence: entry.no_written_evidence === 1, no_evidence_reason: entry.no_evidence_reason,
      commitment_flag: entry.commitment_flag === 1, commitment_flag_source: entry.commitment_flag_source, is_risk: entry.is_risk === 1,
      commitment_current: d.commitment_current, risk_current: d.risk_current,
      voided: d.voided, conclusion_state: d.conclusion_state, current_conclusion: currentConclusionOf(d), confirmer: await entries.confirmerView(q, conf),
      // S-S1b：拆分来源 / 异议对象、「已结」（收口前置口径，entries-core.entryResolved）、当前分流归属、已拆分容器的子项
      parent_entry_id: entry.parent_entry_id, objects_entry_id: entry.objects_entry_id, resolved: entries.entryResolved(d),
      routing: facts.routing ? { route: facts.routing.route, basis_category: facts.routing.basis_category, part_no: facts.routing.part_no, decided_at: facts.routing.decided_at } : null,
      split_children: d.split_children === undefined ? [] : d.split_children,
      // S-S1c：修订重提的来源、开发方关键事项的认可情况（required = 是否需要开发方负责人认可；status = none / pending / approved / not_approved（负责人未认可）/ lapsed；label 给页面直接用）
      revision_of_entry_id: entry.revision_of_entry_id,
      dev_confirm: devConfirm,
      // 转系统迭代的处理项（去向 = sys_iteration）还没结：状态「待转系统迭代」，PM 对它 conclude to_sys_iteration（填单号与承接人）
      awaiting_sys_iteration: !!(facts.routing && facts.routing.route === 'sys_iteration') && !entries.entryResolved(d),
      created_at: entry.created_at,
      actions,
    };
  }
  async function attachmentsOfEntry(q, entryId) {
    const rows = await q.all(
      `SELECT b.attachment_id AS attachment_id, a.original_name AS original_name, a.masked_at AS masked_at, a.deleted_at AS deleted_at,
              a.mime_type AS mime_type, a.size AS size, a.sha256 AS sha256, a.is_image AS is_image,
              a.masked_by AS masked_by, a.mask_reason AS mask_reason, a.deleted_by AS deleted_by,
              COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
         FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id
         LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
        WHERE b.owner_type = 'entry' AND b.owner_id = ? ORDER BY b.attachment_id`,
      [entryId]
    );
    return rows.map((a) => ({
      attachment_id: a.attachment_id, masked: !!a.masked_at, deleted: !!a.deleted_at, original_name: attachmentDisplayName(a), // Q8：遮蔽后不返回原名
      mime_type: a.mime_type, size: a.size, sha256: a.sha256, is_image: a.is_image === 1,
      ...attachmentStateFields(a),
    }));
  }
  async function detailView(q, access, identity, entry, user) {
    const facts = await entries.loadEntryFacts(q, entry);
    const view = await baseView(q, access, identity, entry, facts, user);
    // 拆分子项的附件不复制：详情回读原登记（容器）名下的附件并标 from_parent（结论确认的冻结清单也取原登记附件，见 entries-core.ensureEntryFrozen）
    view.attachments = (await attachmentsOfEntry(q, entry.id)).map((a) => Object.assign(a, { from_parent: false }));
    if (entry.parent_entry_id !== null && entry.parent_entry_id !== undefined) {
      for (const a of await attachmentsOfEntry(q, entry.parent_entry_id)) view.attachments.push(Object.assign(a, { from_parent: true }));
    }
    // codex 25 M2：items = 当前关联（entries-core.currentItemRowsOf，补选归属后只剩最近一次归属的集合）；items_history = 全部关联行（含被替代的历史关联，按编号升序）
    view.items_history = await q.all(
      `SELECT ei.id AS id, ei.item_id AS item_id, ei.item_version_id AS item_version_id, ei.assigned_by_action_id AS assigned_by_action_id, it.code AS code, iv.version_no AS version_no
         FROM sysbuild_entry_items ei JOIN sysbuild_items it ON it.id = ei.item_id JOIN sysbuild_item_versions iv ON iv.id = ei.item_version_id
        WHERE ei.entry_id = ? ORDER BY ei.id`,
      [entry.id]
    );
    const currentIds = facts.currentItemRows.map((r) => r.id);
    view.items = view.items_history.filter((r) => currentIds.includes(r.id));
    // 判定快照（只追加，按编号升序）：挂在本登记名下（拆分后各处理项各挂各的）
    view.routing_snapshots = await q.all(`SELECT ${entries.SNAPSHOT_COLS} FROM sysbuild_routing_snapshots WHERE entry_id = ? ORDER BY id`, [entry.id]);
    view.records = [];
    for (const a of facts.actions) {
      view.records.push({
        id: a.id, action: a.action, conclusion_kind: a.conclusion_kind, text: a.text, sys_issue_no: a.sys_issue_no, assignee_text: a.assignee_text,
        change_id: a.change_id, basis_kind: a.basis_kind, basis_ref: a.basis_ref, created_by: a.created_by, created_by_name: await userNameOf(q, a.created_by), created_at: a.created_at,
      });
    }
    view.confirm_tasks = [];
    for (const tr of facts.taskRows) {
      const revs = await q.all(
        `SELECT r.id AS id, r.rev_no AS rev_no, r.required_member_id AS required_member_id, r.status AS status, r.status_reason AS status_reason, r.created_at AS created_at,
                m.user_id AS member_user_id
           FROM sysbuild_confirm_task_revisions r LEFT JOIN sysbuild_members m ON m.id = r.required_member_id WHERE r.task_id = ? ORDER BY r.rev_no`,
        [tr.task.id]
      );
      const revisions = [];
      for (const r of revs) {
        const cf = await q.get('SELECT decision, method, reason, created_at FROM sysbuild_confirmations WHERE task_revision_id = ?', [r.id]);
        revisions.push({
          id: r.id, rev_no: r.rev_no, status: r.status, status_reason: r.status_reason, required_member_id: r.required_member_id,
          required_name: await entries.memberNameOf(q, r.required_member_id), proxy_only: r.member_user_id === null, created_at: r.created_at,
          confirmation: cf ? { decision: cf.decision, method: cf.method, reason: cf.reason, created_at: cf.created_at } : null,
        });
      }
      view.confirm_tasks.push({ task_id: tr.task.id, purpose: tr.task.purpose, object_type: tr.task.object_type, action_id: tr.task.object_version_id, party_id: tr.task.party_id, revisions });
    }
    view.notices = [];
    for (const nr of facts.noticeRows) view.notices.push(await noticeView(q, nr.notice, nr.objection, { access, identity, entry, facts, uid: Number(user.id) }));
    return view;
  }
  // 知会视图：每条带 actions.object（L6，与 POST /notices/:nid/object 同一个 notice_object 判定、同一个 target 构造函数 noticeTarget，前端不推算）。
  //   c = { access, identity, entry, facts, uid }。
  async function noticeView(q, n, objection, c) {
    const attempts = await q.all('SELECT channel, result, created_at FROM sysbuild_notice_attempts WHERE notice_id = ? ORDER BY id', [n.id]);
    const target = noticeTarget(c.identity, c.entry, c.facts, n, objection, n.recipient_member_id, c.uid, await recipientUserOf(q, n.recipient_member_id), await entries.objectorBasisOf(q, c.entry, c.facts, c.identity, { id: c.uid }));
    return {
      id: n.id, project_id: n.project_id === undefined ? undefined : n.project_id, kind: n.kind, ref_type: n.ref_type, ref_id: n.ref_id, recipient_member_id: n.recipient_member_id,
      recipient_name: await entries.memberNameOf(q, n.recipient_member_id), created_at: n.created_at, attempts,
      objection: objection ? { reason: objection.reason, actor_user_id: objection.actor_user_id, member_id: objection.member_id, mode: objection.mode, objection_entry_id: objection.objection_entry_id, created_at: objection.created_at } : null,
      actions: { object: rules.opAllowed('notice_object', c.identity, c.access.project, target) },
    };
  }

  // ── POST /sysbuild/projects/:id/entries：写登记 ───────────────────────────────────────────────
  function readCreateInput(body) {
    // S-S1b（D34 / P97）：objects_entry_id 非空 = 对已有有效结论的登记提异议，服务端生成一条异议登记；只认 OBJECTION_KEYS，类型缺省「意见与反馈」，标题缺省按被异议登记生成
    if (body.objects_entry_id !== undefined && body.objects_entry_id !== null) {
      onlyKeys(body, OBJECTION_KEYS);
      const objectsEntryId = readIdParam(body.objects_entry_id, 'objects_entry_id', '被异议的登记');
      const oType = body.type === undefined || body.type === null ? 'feedback' : body.type;
      if (typeof oType !== 'string' || !OBJECTION_TYPES.includes(oType)) throw invalid(`异议登记的类型必须是 ${OBJECTION_TYPES.join(' / ')} 之一`, 'type');
      const oText = readText(body.body, 'body', '异议内容', BODY_MAX, true);
      if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
      return {
        objectsEntryId, revisionOfEntryId: null, type: oType, purpose: 'general', title: readText(body.title, 'title', '标题', TITLE_MAX, false), text: oText, businessDate: null, commitment: 0, isRisk: 0, nodeId: null,
        sourcePartyId: null, itemIds: [], attachmentIds: readIdList(body.attachment_ids, 'attachment_ids', '附件编号', ID_LIST_MAX),
        ev: { noEvidence: body.no_written_evidence === true, noEvidenceReason: readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', REASON_MAX, false) },
      };
    }
    const type = body.type;
    if (typeof type !== 'string' || type === '') throw invalid('登记类型必填', 'type');
    if (type === 'correction') throw invalid('更正走办理动作（POST /entries/:eid/actions，action = correct），不作独立登记', 'type');
    if (!REGISTERABLE_TYPES.includes(type)) throw invalid(`登记类型必须是 ${REGISTERABLE_TYPES.join(' / ')} 之一`, 'type');
    const purpose = body.purpose === undefined || body.purpose === null ? 'general' : body.purpose;
    if (typeof purpose !== 'string' || !schema.ENUMS.entryPurpose.includes(purpose)) throw invalid(`用途必须是 ${schema.ENUMS.entryPurpose.join(' / ')} 之一`, 'purpose');
    const title = readText(body.title, 'title', '标题', TITLE_MAX, true);
    const text = readText(body.body, 'body', '内容', BODY_MAX, true);
    let businessDate = null;
    if (body.business_date !== undefined && body.business_date !== null && body.business_date !== '') {
      if (!validDate(body.business_date)) throw invalid('业务日期必须是 YYYY-MM-DD 格式的有效日期（2000–2099）', 'business_date');
      businessDate = body.business_date;
    }
    const commitment = readFlag(body.commitment_flag, 'commitment_flag', '涉及承诺标记');
    const isRisk = readFlag(body.is_risk, 'is_risk', '风险标记');
    if (isRisk === 1 && type !== 'issue') throw invalid('只有「问题与处理」类可以标风险', 'is_risk');
    const nodeId = body.node_id === undefined || body.node_id === null ? null : readIdParam(body.node_id, 'node_id', '节点');
    const sourcePartyId = body.source_party_id === undefined || body.source_party_id === null ? null : readIdParam(body.source_party_id, 'source_party_id', '来源方');
    const itemIds = readIdList(body.item_ids, 'item_ids', '需求条目编号', ITEM_IDS_MAX);
    const attachmentIds = readIdList(body.attachment_ids, 'attachment_ids', '附件编号', ID_LIST_MAX);
    if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
    const ev = { noEvidence: body.no_written_evidence === true, noEvidenceReason: readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', REASON_MAX, false) };
    // S-S1c：revision_of_entry_id = 修订重提（开发方关键事项被负责人不认可后，新登记引用旧登记，旧登记保留）；与拆分来源 / 异议对象互斥（库内 CHECK）
    const revisionOfEntryId = body.revision_of_entry_id === undefined || body.revision_of_entry_id === null ? null : readIdParam(body.revision_of_entry_id, 'revision_of_entry_id', '被修订的登记');
    // 预筛 Q2：本人提交并确认的确认文案（开发方现任负责人本人登记需认可的事项时必须带，且等于固定确认文案；不带 / 不等 → 400 在建任务处判，见 entries-core.requestDevConfirm）。这里只收类型。
    if (body.self_confirm_text !== undefined && body.self_confirm_text !== null && typeof body.self_confirm_text !== 'string') throw invalid('self_confirm_text 必须是字符串', 'self_confirm_text');
    const selfConfirmText = typeof body.self_confirm_text === 'string' ? body.self_confirm_text : null;
    return { objectsEntryId: null, revisionOfEntryId, selfConfirmText, type, purpose, title, text, businessDate, commitment, isRisk, nodeId, sourcePartyId, itemIds, attachmentIds, ev };
  }

  // 登记写入的共用部分（主端点与收口后知会异议共用）：关联需求条目 → 分流判定 → 写登记行（含自动拆分）→ 附件 → 判定快照 → 事件。
  //   c = { input, per, sourcePartyId, objectsEntryId }：input 是 readCreateInput 的结果（异议登记的 nodeId / itemIds 已由调用方按被异议的登记填好），per = 时段判定。
  async function createEntryCore(q, user, access, identity, pid, c) {
    const { input, per, sourcePartyId, objectsEntryId } = c;
    const uid = Number(user.id);
    // 关联需求条目：属本项目；挂当前生效总体规划里的现行版本，不在生效规划里的取最新版本。
    const cur = input.itemIds.length > 0 ? await resolveCurrentPlan(q, pid) : { byItem: {} };
    const itemRows = [];
    for (const itemId of input.itemIds) {
      const item = await q.get('SELECT id FROM sysbuild_items WHERE id = ? AND project_id = ?', [itemId, pid]);
      if (!item) throw invalid('需求条目不存在或不属于本项目', 'item_ids');
      let versionId;
      if (hasKey(cur.byItem, itemId)) versionId = cur.byItem[itemId].item_version_id;
      else {
        const last = await q.get('SELECT id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1', [itemId]);
        if (!last) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：需求条目没有版本');
        versionId = last.id;
      }
      itemRows.push({ itemId, versionId });
    }
    // 分流判定（§4.3，办理类登记；知悉类不分流）：全部条目已上线 → 拒绝新增（409，引导系统迭代）；未关联条目 / 条目不在生效规划里 → 尚未判定；既有未上线又有已上线（或待判定）→ 照常受理并拆分
    //   S-S1c（派单 0b 冲突 5）：用途为开发方处理说明 / 正式交付物的登记不进分流（不判定、不留快照、不可拆分）；来源方为开发方且带涉及承诺的登记（需要开发方负责人认可）进分流但不可拆分——
    //   既有未上线又有已上线的 409，引导拆成两件事登记。
    const needsDev = await entries.entryNeedsDevConfirm(q, { purpose: input.purpose, source_party_id: sourcePartyId }, input.commitment === 1);
    let parts = null;
    if (rules.ENTRY_HANDLED_TYPES.includes(input.type) && input.purpose === 'general') {
      const classified = await routing.classifyItems(q, cur, input.itemIds);
      parts = routing.planParts(classified);
      if (parts.length === 1 && parts[0].route === 'sys_iteration') throw await routing.liveRejection(q, classified);
      if (parts.length > 1 && needsDev) {
        throw Object.assign(stateError('需要开发方负责人认可的登记不能拆分：未上线部分请单独登记，已上线部分请到系统迭代受理渠道提单'), { extra: { guide: 'sys_iteration', live_items: await routing.describeLiveItems(q, classified) } });
      }
    }
    const snapshot = entries.operatorSnapshotOf(identity);
    const eid = await entries.insertEntryRow(q, {
      projectId: pid, nodeId: input.nodeId, type: input.type, purpose: input.purpose, commitment: input.commitment, commitmentSource: input.commitment === 1 ? 'submitter' : null, isRisk: input.isRisk,
      sourcePartyId, operatorUserId: uid, snapshotJson: JSON.stringify(snapshot), period: per.period, days: per.days, businessDate: input.businessDate, title: input.title, body: input.text,
      noEvidence: input.ev.noEvidence ? 1 : 0, noEvidenceReason: input.ev.noEvidenceReason, parentEntryId: null, objectsEntryId, revisionOfEntryId: input.revisionOfEntryId === undefined ? null : input.revisionOfEntryId,
    });
    for (const r of itemRows) {
      await q.run('INSERT INTO sysbuild_entry_items (entry_id, item_id, item_version_id, assigned_by_action_id) VALUES (?, ?, ?, NULL)', [eid, r.itemId, r.versionId]);
    }
    const bound = input.attachmentIds.length > 0
      ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid, userId: uid, attachmentIds: input.attachmentIds, ownerType: 'entry', ownerId: eid, operatorName: core.operatorNameOf(user) })
      : [];
    await emit(q, user, pid, 'entry', eid, 'entry_created', {
      type: input.type, purpose: input.purpose, node_id: input.nodeId, period: per.period, days_after_close: per.days, source_party_id: sourcePartyId,
      commitment_flag: input.commitment, is_risk: input.isRisk, item_ids: input.itemIds, attachment_ids: bound, no_written_evidence: input.ev.noEvidence, operator_identity: snapshot,
      objects_entry_id: objectsEntryId, revision_of_entry_id: input.revisionOfEntryId === undefined ? null : input.revisionOfEntryId,
    });
    // S-S1c：需要开发方负责人认可的登记，同一事务建认可任务（附件绑定之后，冻结清单才完整）；登记人就是开发方现任负责人 → 本人提交并确认；开发方暂无负责人 → 409 整笔回滚
    let devConfirm = null;
    if (needsDev) {
      const row0 = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
      devConfirm = await entries.requestDevConfirm(q, user, attachmentHelpers, row0, { registrantIsPm: identity.isPm === true, selfConfirmText: input.selfConfirmText === undefined ? null : input.selfConfirmText }); // 任务建立 / 确认记录各写 confirm_task_created / confirmation_recorded 事件
    }
    let children = [];
    if (parts !== null && parts.length === 1) {
      const sids = await routing.appendSnapshots(q, eid, 1, routing.snapshotRowsOfPart(parts[0]), null);
      await emit(q, user, pid, 'entry', eid, 'routing_decided', { part_no: 1, route: parts[0].route, snapshot_ids: sids, item_ids: input.itemIds });
    } else if (parts !== null) {
      const parentRow = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
      const itemRowsOf = await q.all('SELECT id, item_id, item_version_id FROM sysbuild_entry_items WHERE entry_id = ? ORDER BY id', [eid]);
      children = await routing.splitIntoParts(q, parentRow, itemRowsOf, parts, null, undefined, uid, user);
      await emit(q, user, pid, 'entry', eid, 'entry_split', { via: 'auto', children: children.map((k) => ({ entry_id: k.entry_id, part_no: k.part_no, route: k.route })) });
      for (const k of children) {
        await emit(q, user, pid, 'entry', k.entry_id, 'routing_decided', { part_no: k.part_no, route: k.route, snapshot_ids: k.snapshot_ids, parent_entry_id: eid });
      }
    }
    const row = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
    return { entry: await detailView(q, access, identity, row, user), entry_id: eid };
  }

  router.post('/sysbuild/projects/:id/entries', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, CREATE_KEYS);
    const input = readCreateInput(body);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { access, identity } = await loadProjectCtx(q, pid, user);
      const todayStr = today();
      // 异议登记（D34）：被异议的登记须属本项目；挂靠（节点 / 项目整体）与关联条目沿用被异议登记，时段按该挂靠当前是否收口判定。
      //   被异议的登记不存在（或不属于本项目）先报 400 而不是 404：它是请求体里的引用对象，不是路径对象（路径上的项目已过可见性 404 一步）；§5.3「参数先于对象」，与 node_id 不存在同口径（预筛 L-3）。
      let objected = null;
      if (input.objectsEntryId !== null) {
        objected = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [input.objectsEntryId, pid]);
        if (!objected) throw invalid('被异议的登记不存在或不属于本项目', 'objects_entry_id');
        input.nodeId = objected.node_id;
      }
      // 时段由服务端判定（§4.1，登记人不能选）：先取节点算时段，才能按时段对应的项目状态类别判（已终止 / 已结项只能写补充登记）。节点不存在 / 不属于本项目的 400 在权限与状态检查之后。
      const node = input.nodeId === null ? null : (await q.get('SELECT id, project_id, status, closed_at FROM sysbuild_nodes WHERE id = ? AND project_id = ?', [input.nodeId, pid])) || null;
      const per = await entries.decideEntryPeriod(q, access.project, node, todayStr);
      if (objected !== null) {
        // 谁能提异议 + 被异议登记须已有有效结论：与读接口 actions.object 同一个 entryTarget / objectorBasisOf；项目状态按 resolve 类（四态都允许，§4.5「既有登记的异议」）
        const ofacts = await entries.loadEntryFacts(q, objected);
        //   关联条目全部已上线 / 节点已取消两项事实在读接口 actions.object 里算（标志为假）；执行时传 false，由下面 createEntryCore 的带 guide 的 409（引导系统迭代）与节点已取消 409 接手，
        //   这样执行结果同样是 409，且响应带 guide / live_items。
        rules.assertOp('entry_object', identity, access.project, await entries.entryTarget(q, access.project, objected, ofacts, user, { objectorBasis: await entries.objectorBasisOf(q, objected, ofacts, identity, user), itemsAllLive: false, nodeCancelled: false }));
        input.itemIds = Array.from(new Set(ofacts.currentItemRows.map((r) => r.item_id))); // 当前关联（codex 25 M2）
        if (input.title === null) input.title = Array.from(`对第 ${objected.id} 条登记的异议：${objected.title}`).slice(0, TITLE_MAX).join('');
      } else {
        // S-S1c：开发方处理说明 / 正式交付物用途只有开发方负责人、开发方代表人、PM 代登可写（403 先于后面的 409）；项目状态类别 accept（需要负责人认可，已终止 / 已结项 409）
        if (rules.ENTRY_DEV_PURPOSES.includes(input.purpose)) rules.assertOp('entry_create_dev', identity, access.project, { devPartyId: await entries.devPartyIdOf(q, pid) });
        rules.assertOp(per.period === 'process' ? 'entry_create_process' : 'entry_create_supplement', identity, access.project, {});
      }
      if (input.nodeId !== null && node === null) throw invalid('节点不存在或不属于本项目', 'node_id');
      if (node !== null && node.status === 'cancelled') throw stateError('该节点已取消，不能再关联新登记');
      if (input.businessDate !== null && input.businessDate > todayStr) throw invalid(`业务日期不能晚于今天（${todayStr}）`, 'business_date');
      // 来源方：PM 可代登并填真实来源方（不填 = PM 本人登记，来源方为空）；非 PM 填了 400；成员本人取其成员行的参与方（可空 = 信息技术部内部成员）；admin 非成员来源方为空。
      let sourcePartyId = null;
      if (input.sourcePartyId !== null) {
        if (identity.isPm !== true) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');
        const party = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [input.sourcePartyId, pid]);
        if (!party) throw invalid('来源方不是本项目的参与方', 'source_party_id');
        sourcePartyId = party.id;
      } else if (identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined) {
        sourcePartyId = identity.partyId === undefined ? null : identity.partyId;
      }
      // S-S1c 开发方关键事项：来源方必须是开发方（PM 代登须填开发方；开发方负责人 / 代表人取其成员行的开发方）；正式交付物必有附件；修订重提（revision_of_entry_id）只对「负责人未认可」的旧登记，用途须与旧登记一致
      if (rules.ENTRY_DEV_PURPOSES.includes(input.purpose)) {
        if (!(await entries.isDevParty(q, sourcePartyId))) throw invalid('开发方处理说明 / 正式交付物的来源方必须是开发方（项目经理代登请填写开发方参与方）', 'source_party_id');
        if (input.purpose === 'deliverable' && input.attachmentIds.length === 0) throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '正式交付物必须上传附件');
      }
      if (input.revisionOfEntryId !== null) {
        const old = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [input.revisionOfEntryId, pid]);
        if (!old) throw invalid('被修订的登记不存在或不属于本项目', 'revision_of_entry_id');
        if (old.purpose !== input.purpose) throw invalid('修订重提的用途必须与被修订的登记一致', 'purpose');
        if ((old.source_party_id === null || old.source_party_id === undefined ? null : old.source_party_id) !== sourcePartyId) throw invalid('修订重提的来源方必须与被修订的登记一致', 'source_party_id'); // 预筛 L3
        if ((await entries.devConfirmOf(q, old)).status !== 'not_approved') throw stateError('只有开发方负责人未认可的登记可以修订重提');
      }
      // 证据：补交材料必有附件；带「涉及承诺」标记的是方向类（附件或「无书面证据」+ 原因 ≥ 10 字）；其余可选
      assertEvidence(input.attachmentIds.length, input.ev, input.type === 'material' ? 'material' : (input.commitment === 1 ? 'direction' : 'optional'));
      // 关联条目 → 分流判定 → 写登记（含自动拆分）→ 附件 → 判定快照 → 事件：见上面的 createEntryCore
      const created = await createEntryCore(q, user, access, identity, pid, { input, per, sourcePartyId, objectsEntryId: input.objectsEntryId });
      return { entry: created.entry };
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/projects/:id/entries?node=&period=&type=&party= ─────────────────────────────
  router.get('/sysbuild/projects/:id/entries', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const qs = req.query || {};
    const conds = ['project_id = ?'];
    const params = [pid];
    if (qs.node !== undefined && qs.node !== '') { conds.push('node_id = ?'); params.push(readIdParam(qs.node, 'node', '节点')); }
    if (qs.period !== undefined && qs.period !== '') {
      if (typeof qs.period !== 'string' || !schema.ENUMS.entryPeriod.includes(qs.period)) throw invalid(`period 必须是 ${schema.ENUMS.entryPeriod.join(' / ')} 之一`, 'period');
      conds.push('period = ?'); params.push(qs.period);
    }
    if (qs.type !== undefined && qs.type !== '') {
      if (typeof qs.type !== 'string' || !schema.ENUMS.entryType.includes(qs.type)) throw invalid(`type 必须是 ${schema.ENUMS.entryType.join(' / ')} 之一`, 'type');
      conds.push('type = ?'); params.push(qs.type);
    }
    if (qs.party !== undefined && qs.party !== '') { conds.push('source_party_id = ?'); params.push(readIdParam(qs.party, 'party', '来源方')); }
    // S-S1b 待判定列表：?routing=pending = 当前分流去向为「尚未判定」且未结（没有有效结论、未作废）的登记。选择独立筛选而不是另开 /pending-routing 端点：复用同一个列表视图与 actions 投影，
    //   筛选条件可与 node / period / type / party 叠加。可见范围：PM（admin 接管后）看全量，其余成员只看自己登记的。
    let pendingOnly = false;
    if (qs.routing !== undefined && qs.routing !== '') {
      if (qs.routing !== 'pending') throw invalid('routing 只支持 pending（待判定）', 'routing');
      pendingOnly = true;
      conds.push('(SELECT s.route FROM sysbuild_routing_snapshots s WHERE s.entry_id = sysbuild_entries.id ORDER BY s.id DESC LIMIT 1) = ?');
      params.push('pending');
    }
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const { access, identity } = await loadProjectCtx(q, pid, user);
      let rows = await q.all(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE ${conds.join(' AND ')} ORDER BY id DESC`, params);
      if (pendingOnly && !rules.canActAsPm(identity)) rows = rows.filter((r) => Number(r.operator_user_id) === Number(user.id));
      const list = [];
      for (const entry of rows) {
        const facts = await entries.loadEntryFacts(q, entry);
        if (pendingOnly && entries.entryResolved(facts.derived)) continue;
        if (pendingOnly && (facts.routing === null || facts.routing.route !== 'pending')) continue; // 预筛 L-1：已拆分容器没有当前去向（旧快照只作历史），不列
        list.push(await baseView(q, access, identity, entry, facts, user));
      }
      const devPartyId = await entries.devPartyIdOf(q, pid);
      const devAllowed = rules.opAllowed('entry_create_dev', identity, access.project, { devPartyId });
      const owner = devPartyId === null ? null : await core.currentOwner(q, devPartyId);
      const selfConfirm = devAllowed && await entries.devOwnerSelfSubmit(q, user, owner, Number(user.id), identity.isPm);
      const sources = identity.isPm === true ? [{ id: null, label: 'PM 本人登记' }, ...(await q.all('SELECT id, name FROM sysbuild_parties WHERE project_id = ? ORDER BY sort_order, id', [pid])).map((p) => ({ id: p.id, label: '代登：' + p.name }))] : null;
      return {
        project_id: pid, entries: list,
        registration: { types: REGISTERABLE_TYPES, purposes: schema.ENUMS.entryPurpose.filter((p) => p === 'general' || devAllowed), source_choices: sources, self_confirm: { enabled: selfConfirm, text: core.checkboxTextsOf('dev_key_confirm').confirm, purposes: rules.ENTRY_DEV_PURPOSES } },
        actions: { create_entry: rules.opAllowed('entry_create_process', identity, access.project, {}) || rules.opAllowed('entry_create_supplement', identity, access.project, {}) },
      };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/entries/:eid：详情（办理记录、结论确认任务与修订、知会、逐对象 actions）──────────────────
  router.get('/sysbuild/entries/:eid', handle(async (req, res) => {
    const eid = readIdParam(req.params.eid, 'eid', '登记编号');
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const { entry, access, identity } = await loadEntryCtx(q, eid, user);
      return { entry: await detailView(q, access, identity, entry, user) };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/entries/:eid/actions：办理动作 ─────────────────────────────────────────────
  function readActionInput(body) {
    const action = body.action;
    if (typeof action !== 'string' || action === '') throw invalid('办理动作必填', 'action');
    if (!schema.ENUMS.entryAction.includes(action)) throw invalid(`不支持的办理动作 ${action}`, 'action');
    if (LATER_ACTIONS.includes(action)) return { action, later: true };
    if (!hasKey(ACTION_FIELDS, action)) throw invalid(`不支持的办理动作 ${action}`, 'action');
    onlyKeys(body, ['action', ...ACTION_FIELDS[action]]);
    const out = { action, later: false, text: null, kind: null, sysIssueNo: null, assigneeText: null, changeId: null, basisEntryId: null };
    if (REASON_ACTIONS.includes(action)) {
      out.text = readText(body.reason, 'reason', '原因', REASON_MAX, true);
    } else if (action === 'conclude') {
      const kind = body.conclusion_kind;
      if (typeof kind !== 'string' || kind === '') throw invalid('结论类别必填', 'conclusion_kind');
      if (!schema.ENUMS.conclusionKind.includes(kind)) throw invalid(`结论类别必须是 ${schema.ENUMS.conclusionKind.join(' / ')} 之一`, 'conclusion_kind');
      out.kind = kind;
      out.text = readText(body.text, 'text', '结论说明', TEXT_MAX, true);
      // 留待后续须写承接节点或批次；转系统迭代须写单号与承接人（单号只存文本，不校验单据存在，D9）；这两个字段对别的结论类别不适用
      out.assigneeText = readText(body.assignee_text, 'assignee_text', '承接说明', ASSIGNEE_MAX, kind === 'deferred' || kind === 'to_sys_iteration');
      out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, kind === 'to_sys_iteration');
      if (out.assigneeText !== null && kind !== 'deferred' && kind !== 'to_sys_iteration') throw invalid('承接说明只用于「留待后续」和「转系统迭代」', 'assignee_text');
      if (out.sysIssueNo !== null && kind !== 'to_sys_iteration') throw invalid('系统迭代单号只用于「转系统迭代」', 'sys_issue_no');
      // S-S1c：转正式变更必带 change_id（缺 400；本项目 / 未撤回的校验在端点里，409）；其余类别不许带。办理依据 = 已认可的开发方处理说明登记（可选；归属 / 认可状态在端点里判）
      if (kind === 'to_change') out.changeId = readIdParam(body.change_id, 'change_id', '变更编号');
      else if (body.change_id !== undefined && body.change_id !== null) throw invalid('变更编号只用于「转正式变更」', 'change_id');
      if (body.basis_dev_note_entry_id !== undefined && body.basis_dev_note_entry_id !== null) out.basisEntryId = readIdParam(body.basis_dev_note_entry_id, 'basis_dev_note_entry_id', '办理依据（开发方处理说明登记）');
    } else if (action === 'link_change') {
      out.changeId = readIdParam(body.change_id, 'change_id', '变更编号');
      out.text = readText(body.text, 'text', '说明', TEXT_MAX, false);
    } else if (action === 'split') {
      // 手动拆分：groups = 条目编号的分组（至少两组、并集 = 登记关联的全部条目），分组内容的校验在端点里（条目归属 400、每组去向一致 409）
      out.text = readText(body.text, 'text', '拆分说明', TEXT_MAX, false);
      if (!Array.isArray(body.groups)) throw invalid('groups 必填，格式为需求条目编号的分组数组', 'groups');
      out.groups = body.groups;
    } else if (action === 'assign_items') {
      // 待判定归属：必须写依据文字；依据类别 / 条目 / 规划外的去向的组合在 routing.planAssignment 里判
      out.text = readText(body.text, 'text', '判定依据', TEXT_MAX, true);
      if (typeof body.basis_category !== 'string' || body.basis_category === '') throw invalid('判定依据类别必填', 'basis_category');
      out.basis = body.basis_category;
      out.itemIds = readIdList(body.item_ids, 'item_ids', '需求条目编号', ITEM_IDS_MAX);
      if (body.route !== undefined && body.route !== null && typeof body.route !== 'string') throw invalid('去向必须是文本', 'route');
      out.route = body.route === undefined ? null : body.route;
    } else if (action === 'link_sys_issue') {
      out.sysIssueNo = readText(body.sys_issue_no, 'sys_issue_no', '系统迭代单号', SYS_ISSUE_MAX, true);
      out.text = readText(body.text, 'text', '说明', TEXT_MAX, false);
    } else if (action === 'correct') {
      out.text = readText(body.text, 'text', '更正内容', TEXT_MAX, true);
    } else {
      out.text = readText(body.text, 'text', '说明', TEXT_MAX, false); // for_reference / escalate：说明可选
    }
    return out;
  }
  router.post('/sysbuild/entries/:eid/actions', parseJsonBody, handle(async (req, res) => {
    const eid = readIdParam(req.params.eid, 'eid', '登记编号');
    const input = readActionInput(bodyOf(req));
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const { entry, access, identity } = await loadEntryCtx(q, eid, user);
      // 本批不开放的动作（L2，§5.3 403 先于 409）：先核「办理登记」权限（PM，admin 接管后），有权限的人才得到「未开放」409
      if (input.later) {
        if (!rules.canActAsPm(identity)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');
        throw stateError(input.action === 'adjudicate' ? ADJUDICATE_ACTION_MESSAGE : LATER_ACTION_MESSAGE);
      }
      const facts = await entries.loadEntryFacts(q, entry);
      const target = await entries.entryTarget(q, access.project, entry, facts, user, input.kind === null ? {} : { kind: input.kind });
      rules.assertOp(`entry_${input.action}`, identity, access.project, target);
      // S-S1b：拆分 / 待判定归属的方案先算（条目归属 400、归属组合 409 都在写任何行之前；同一事务内，抛错整笔回滚）
      let parts = null;
      let plan = null;
      if (input.action === 'split') parts = await routing.planManualSplit(q, entry.project_id, Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))), input.groups);
      else if (input.action === 'assign_items') plan = await routing.planAssignment(q, entry.project_id, { basis: input.basis, itemIds: input.itemIds, route: input.route }, { isChild: entry.parent_entry_id !== null && entry.parent_entry_id !== undefined, noSplit: target.needsDevConfirm === true, noSplitNotApproved: target.devConfirmStatus === 'not_approved' });
      // S-S1c：转正式变更 / 挂靠变更的 change_id 校验（缺 400 在 readActionInput；不属本项目 / 已撤回 409）；办理依据（已认可的开发方处理说明登记）校验（不存在 400、未认可 409）。都在写任何行之前。
      if (input.changeId !== null) {
        const ch = await q.get('SELECT id, project_id, status FROM sysbuild_changes WHERE id = ?', [input.changeId]);
        if (!ch || ch.project_id !== entry.project_id) throw stateError('该变更不属于本项目');
        if (ch.status === 'withdrawn') throw stateError('该变更已撤回，不能转入或挂靠');
        if (input.action === 'link_change' && (await q.get("SELECT id FROM sysbuild_entry_actions WHERE entry_id = ? AND action IN ('link_change', 'conclude') AND change_id = ? LIMIT 1", [eid, input.changeId]))) {
          throw stateError('该登记已挂靠此变更');
        }
      }
      if (input.basisEntryId !== null) {
        const be = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [input.basisEntryId, entry.project_id]);
        if (!be) throw invalid('办理依据的登记不存在或不属于本项目', 'basis_dev_note_entry_id');
        if (be.id === entry.id || be.purpose !== 'dev_note') throw invalid('办理依据必须是本项目的开发方处理说明登记（且不是本登记自己）', 'basis_dev_note_entry_id');
        const ap = await entries.devApprovalUsable(q, be);
        if (!ap.ok) throw stateError(`办理依据未认可：${ap.reason}`);
      }
      const ins = await q.run(
        'INSERT INTO sysbuild_entry_actions (entry_id, action, conclusion_kind, text, sys_issue_no, assignee_text, change_id, basis_kind, basis_ref, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eid, input.action, input.kind, input.text, input.sysIssueNo, input.assigneeText, input.changeId, input.basisEntryId === null ? null : 'dev_note_version', input.basisEntryId, uid]
      );
      const actionId = ins.lastID;
      let task = null;
      let notice = null;
      let closed = [];
      let children = [];
      let devRequest = null;
      if (input.action === 'conclude' || input.action === 'for_reference') {
        // 只有一条当前结论：新结论让上一条结论 / 裁定的待确认修订失效（旧结论保留在办理记录里）
        //   M-c：项目已终止时以「项目已终止」结论从裁定中收尾——待确认的裁定修订 → superseded，原因「项目已终止，PM 以项目已终止结论关闭」（规则层只在这一种结论放行 escalated）
        closed = await entries.closePendingEntryRevisions(q, user, entry, 'superseded', entries.SUPERSEDED_BY_NEW_CONCLUSION, input.kind === 'project_terminated' ? entries.ESCALATED_CLOSED_BY_TERMINATION_REASON : undefined);
        const conf = await entries.resolveConclusionConfirmer(q, entry); // 与读接口 confirmer 同一个函数；assertOp 已拦下 unavailable
        // P96：「项目已终止」结论不需要确认（不建任务、不冻结附件、不要求代表人存在），直接已确定
        if ((conf.kind === 'owner' || conf.kind === 'delegate') && input.kind !== 'project_terminated') {
          if (input.action === 'conclude') {
            await entries.ensureEntryFrozen(q, attachmentHelpers, user, entry);
            const t = await core.createTaskWithRevision(q, user, {
              projectId: entry.project_id, objectType: 'conclusion', objectId: entry.id, objectVersionId: actionId, purpose: 'conclusion_confirm', partyId: conf.partyId,
              requiredMemberId: conf.memberId, basisAppointmentId: conf.appointmentId, basisDelegationId: conf.delegationId,
            });
            task = { task_id: t.taskId, revision_id: t.revisionId, required_member_id: conf.memberId, kind: conf.kind, proxy_only: conf.proxyOnly };
          } else {
            const nr = await q.run(
              "INSERT INTO sysbuild_notices (project_id, kind, ref_type, ref_id, recipient_member_id, created_by) VALUES (?, 'for_reference', 'entry', ?, ?, ?)",
              [entry.project_id, entry.id, conf.memberId, uid]
            );
            await q.run("INSERT INTO sysbuild_notice_attempts (notice_id, channel, result) VALUES (?, 'platform', 'sent')", [nr.lastID]); // 不发钉钉（C6）
            await emit(q, user, entry.project_id, 'notice', nr.lastID, 'notice_created', { kind: 'for_reference', entry_id: entry.id, action_id: actionId, recipient_member_id: conf.memberId });
            notice = { id: nr.lastID, recipient_member_id: conf.memberId };
          }
        }
      } else if (input.action === 'void') {
        closed = await entries.closePendingEntryRevisions(q, user, entry, 'invalid', entries.ENTRY_VOIDED_REASON);
        closed = closed.concat(await entries.invalidatePendingDevRevisions(q, user, entry, entries.DEV_VOIDED_REASON)); // S-S1c：待认可的开发方关键事项随作废失效
      } else if (input.action === 'mark_commitment' || input.action === 'unmark_commitment') {
        // S-S1c（派单 0b 冲突 5）：来源方为开发方的一般登记，PM 补标涉及承诺 → 同一事务建开发方认可任务（已有当前有效认可则不重复）；取消承诺 → 其待确认的认可修订失效（「已取消涉及承诺」）。
        //   处理说明 / 交付物用途的认可与承诺标记无关（任务登记时已建），不在此处增删。
        if (entry.purpose === 'general' && (await entries.isDevParty(q, entry.source_party_id))) {
          if (input.action === 'mark_commitment') {
            // 修订批 3 H2：已终止 / 已结项不能再提交认可——由 rules entry_mark_commitment（上面的 assertOp，读接口 actions 同源）与 entries-core.requestDevConfirm 的项目状态判定把关（原本这里一行判定移走）
            devRequest = await entries.requestDevConfirm(q, user, attachmentHelpers, entry, { registrantIsPm: true });
          } else {
            closed = await entries.invalidatePendingDevRevisions(q, user, entry, entries.DEV_CANCELLED_COMMITMENT_REASON);
          }
        }
      } else if (input.action === 'escalate') {
        const adj = await entries.resolveAdjudicator(q, entry); // assertOp 已核 state = ok
        await entries.ensureEntryFrozen(q, attachmentHelpers, user, entry);
        const t = await core.createTaskWithRevision(q, user, {
          projectId: entry.project_id, objectType: 'adjudication', objectId: entry.id, objectVersionId: actionId, purpose: 'adjudicate', partyId: entry.source_party_id,
          requiredMemberId: adj.owner.memberId, basisAppointmentId: adj.owner.appointmentId, basisDelegationId: null,
        });
        task = { task_id: t.taskId, revision_id: t.revisionId, required_member_id: adj.owner.memberId, kind: 'owner', proxy_only: false };
      } else if (input.action === 'split') {
        // 手动拆分：每组一条子登记 + 各自判定快照（触发动作 = 本 split 动作）；原登记成为已拆分容器
        // 预筛 H-2 防御（fail-closed，生产不可达）：规则只允许从「尚未给结论」拆分，此时容器名下不会有待确认的结论 / 裁定修订；若有（库内数据自相矛盾），
        //   拆分后容器上的修订无人能处理（容器上任何动作 409），所以整笔 500 回滚
        const stuck = await q.get(
          `SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
            WHERE t.object_type IN ('conclusion', 'adjudication') AND t.object_id = ? AND r.status = 'pending' LIMIT 1`,
          [eid]
        );
        if (stuck) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：待拆分的登记名下有待确认的结论或裁定修订');
        children = await routing.splitIntoParts(q, entry, facts.currentItemRows, parts, actionId, facts.derived, uid, user);
        await emit(q, user, entry.project_id, 'entry', eid, 'entry_split', { via: 'manual', action_id: actionId, children: children.map((k) => ({ entry_id: k.entry_id, part_no: k.part_no, route: k.route })) });
        for (const k of children) {
          await emit(q, user, entry.project_id, 'entry', k.entry_id, 'routing_decided', { part_no: k.part_no, route: k.route, snapshot_ids: k.snapshot_ids, parent_entry_id: eid, trigger_action_id: actionId });
        }
      } else if (input.action === 'assign_items') {
        // 待判定归属：把归属后的完整条目集合各写一行 entry_items（assigned_by_action_id = 本动作；codex 25 M2：当前关联 = 最近一次归属写下的集合，旧关联行保留作历史；规划外归属写不出行 = 空集），
        //   并追加一次判定快照（触发动作 = 本动作，part_no 沿用本登记的处理项序号）。
        const written = [];
        for (const l of plan.links) {
          const ir = await q.run('INSERT INTO sysbuild_entry_items (entry_id, item_id, item_version_id, assigned_by_action_id) VALUES (?, ?, ?, ?)', [eid, l.item_id, l.item_version_id, actionId]);
          written.push({ id: ir.lastID, item_id: l.item_id, item_version_id: l.item_version_id });
        }
        if (plan.route === 'mixed') {
          // codex 25 M3：非子项登记补选到混合去向（既有未上线又有已上线）→ 同一事务按去向自动拆成子登记（快照触发动作 = 本次归属动作），本登记成为已拆分容器
          children = await routing.splitIntoParts(q, entry, written, plan.parts, actionId, facts.derived, uid, user);
          await emit(q, user, entry.project_id, 'entry', eid, 'entry_split', { via: 'assign', action_id: actionId, children: children.map((k) => ({ entry_id: k.entry_id, part_no: k.part_no, route: k.route })) });
          for (const k of children) {
            await emit(q, user, entry.project_id, 'entry', k.entry_id, 'routing_decided', { part_no: k.part_no, route: k.route, snapshot_ids: k.snapshot_ids, parent_entry_id: eid, trigger_action_id: actionId });
          }
          await emit(q, user, entry.project_id, 'entry', eid, 'routing_assigned', { action_id: actionId, basis_category: plan.basis, route: 'mixed', snapshot_ids: [], item_ids: plan.links.map((l) => l.item_id) });
        } else {
          const sids = await routing.appendSnapshots(q, eid, facts.routing ? facts.routing.part_no : 1, plan.rows, actionId);
          await emit(q, user, entry.project_id, 'entry', eid, 'routing_assigned', { action_id: actionId, basis_category: plan.basis, route: plan.route, snapshot_ids: sids, item_ids: plan.links.map((l) => l.item_id) });
        }
      }
      // C6a（P149）：登记有了新的办理动作（任何动作：结论 / 更正 / 作废 / 标风险 / 补选归属 / 拆分 / 记单号…），发起时的状态指纹随之过期——该登记未完成的交接确认修订同一事务置为已失效
      //   （原因「问题状态已变化」）；已确认的交接确认不动，判「已清」时按指纹不再算数（golive-core.handoverTasksOf）。
      const staleHandover = await goliveCore.invalidateStaleHandoverRevisions(q, user, entry);
      await emit(q, user, entry.project_id, 'entry', eid, 'entry_action_recorded', {
        action_id: actionId, action: input.action, conclusion_kind: input.kind, sys_issue_no: input.sysIssueNo, assignee_text: input.assigneeText,
        task_id: task ? task.task_id : null, notice_id: notice ? notice.id : null, closed_revision_ids: closed.concat(staleHandover),
        change_id: input.changeId, basis_ref: input.basisEntryId, dev_confirm_task_id: devRequest ? devRequest.taskId : null,
      });
      // S-S1c：结论「转正式变更」同一事务写一条 link_change 办理记录（把结论与变更号挂靠在一起；结论本身照常经代表人确认）
      if (input.action === 'conclude' && input.kind === 'to_change') {
        const lr = await q.run("INSERT INTO sysbuild_entry_actions (entry_id, action, text, change_id, created_by) VALUES (?, 'link_change', ?, ?, ?)", [eid, '随转正式变更结论挂靠变更', input.changeId, uid]);
        await emit(q, user, entry.project_id, 'entry', eid, 'entry_action_recorded', {
          action_id: lr.lastID, action: 'link_change', conclusion_kind: null, sys_issue_no: null, assignee_text: null, task_id: null, notice_id: null, closed_revision_ids: [], change_id: input.changeId, via: 'conclude_to_change', conclude_action_id: actionId,
        });
      }
      const row = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
      return { entry: await detailView(q, access, identity, row, user), action_id: actionId, task, notice, closed_revision_ids: closed, children: children.map((k) => ({ entry_id: k.entry_id, part_no: k.part_no, route: k.route })) };
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/my/notices：我作为接收人的知会（只读，不写浏览记录）──────────────────────────────
  //   C6b：列表取数抽成 myNoticeItems(q, user)，GET /my/todo 的 notice 类读同一个函数（与本端点同源）；改期知会（kind = schedule_change）的视图见 scheduleNoticeView。
  async function myNoticeItems(q, user) {
    const uid = Number(user.id);
    {
      const asRecipient = await q.all(
        `SELECT n.id AS id, n.project_id AS project_id, n.kind AS kind, n.ref_type AS ref_type, n.ref_id AS ref_id, n.recipient_member_id AS recipient_member_id, n.created_at AS created_at,
                p.system_name AS system_name
           FROM sysbuild_notices n JOIN sysbuild_members m ON m.id = n.recipient_member_id JOIN sysbuild_projects p ON p.id = n.project_id
          WHERE m.user_id = ? ORDER BY n.id DESC`,
        [uid]
      );
      // L6：除接收人外，「我是来源方现任负责人」的仅供参考知会也列出（本方负责人可对其提异议，方案 §5.2）。as = recipient（我是接收人，优先）/ party_owner（我是来源方现任负责人）
      const asOwner = await q.all(
        `SELECT n.id AS id, n.project_id AS project_id, n.kind AS kind, n.ref_type AS ref_type, n.ref_id AS ref_id, n.recipient_member_id AS recipient_member_id, n.created_at AS created_at,
                p.system_name AS system_name
           FROM sysbuild_notices n JOIN sysbuild_entries e ON e.id = n.ref_id AND n.ref_type = 'entry'
                JOIN sysbuild_appointments a ON a.party_id = e.source_party_id AND a.status = 'active'
                JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_projects p ON p.id = n.project_id
          WHERE n.kind = 'for_reference' AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL} ORDER BY n.id DESC`,
        [uid]
      );
      // codex 25 M1：再列出「我是来源方生效代表人」和「我是原登记人」的仅供参考知会（与知会异议资格同源，entries-core.objectorBasisOf）。as 优先级：recipient > party_owner > source_party > registrant
      const asDelegate = await q.all(
        `SELECT n.id AS id, n.project_id AS project_id, n.kind AS kind, n.ref_type AS ref_type, n.ref_id AS ref_id, n.recipient_member_id AS recipient_member_id, n.created_at AS created_at,
                p.system_name AS system_name
           FROM sysbuild_notices n JOIN sysbuild_entries e ON e.id = n.ref_id AND n.ref_type = 'entry'
                JOIN sysbuild_delegations d ON d.party_id = e.source_party_id AND d.status = 'active'
                JOIN sysbuild_members m ON m.id = d.member_id JOIN sysbuild_projects p ON p.id = n.project_id
          WHERE n.kind = 'for_reference' AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL} ORDER BY n.id DESC`,
        [uid]
      );
      const asRegistrant = await q.all(
        `SELECT n.id AS id, n.project_id AS project_id, n.kind AS kind, n.ref_type AS ref_type, n.ref_id AS ref_id, n.recipient_member_id AS recipient_member_id, n.created_at AS created_at,
                p.system_name AS system_name
           FROM sysbuild_notices n JOIN sysbuild_entries e ON e.id = n.ref_id AND n.ref_type = 'entry' JOIN sysbuild_projects p ON p.id = n.project_id
          WHERE n.kind = 'for_reference' AND e.operator_user_id = ? ORDER BY n.id DESC`,
        [uid]
      );
      const rows = asRecipient.map((r) => Object.assign({}, r, { as: 'recipient' }));
      for (const r of asOwner) {
        if (!rows.some((x) => x.id === r.id)) rows.push(Object.assign({}, r, { as: 'party_owner' }));
      }
      for (const r of asDelegate) {
        if (!rows.some((x) => x.id === r.id)) rows.push(Object.assign({}, r, { as: 'source_party' }));
      }
      for (const r of asRegistrant) {
        if (!rows.some((x) => x.id === r.id)) rows.push(Object.assign({}, r, { as: 'registrant' }));
      }
      rows.sort((a, b) => b.id - a.id);
      const items = [];
      const projects = {};
      for (const n of rows) {
        if (!hasKey(projects, n.project_id)) {
          const pc = await rules.loadProjectAccess(q, n.project_id, user, accessOpts());
          projects[n.project_id] = rules.canViewProject(pc) ? { access: pc, identity: await rules.completeIdentity(q, pc, user) } : null;
        }
        const pj = projects[n.project_id];
        if (pj === null) continue; // 项目已不可见（被移出等）：不列
        const item = { id: n.id, project_id: n.project_id, system_name: n.system_name, kind: n.kind, ref_type: n.ref_type, ref_id: n.ref_id, created_at: n.created_at, as: n.as };
        const objection = await q.get('SELECT reason, actor_user_id, member_id, mode, objection_entry_id, created_at FROM sysbuild_notice_objections WHERE notice_id = ?', [n.id]);
        item.objected = !!objection;
        item.objection = objection || null;
        if (n.ref_type === 'entry') {
          const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [n.ref_id]);
          if (!entry) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会所指的登记不存在');
          const facts = await entries.loadEntryFacts(q, entry);
          item.entry = {
            id: entry.id, type: entry.type, title: entry.title, body: entry.body, conclusion_state: facts.derived.conclusion_state, current_conclusion: currentConclusionOf(facts.derived),
          };
          const nbasis = await entries.objectorBasisOf(q, entry, facts, pj.identity, user);
          item.actions = { object: rules.opAllowed('notice_object', pj.identity, pj.access.project, noticeTarget(pj.identity, entry, facts, n, objection, n.recipient_member_id, uid, await recipientUserOf(q, n.recipient_member_id), nbasis)) };
        } else if (n.ref_type === notifySchedule.NOTICE_REF_SCHEDULE) {
          // C6b：改期知会——改期前后日期、原因、批次与里程碑名；actions.object 与 POST /notices/:nid/object 同一个 OBJECT_OPS 判定（scheduleNoticeTarget）
          const view = await scheduleNoticeView(q, n);
          if (view === null) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会所指的改期记录不存在');
          item.schedule = view;
          item.actions = { object: rules.opAllowed('schedule_notice_object', pj.identity, pj.access.project, await scheduleNoticeTarget(q, n, objection, uid)) };
        }
        items.push(item);
      }
      return items;
    }
  }
  router.get('/sysbuild/my/notices', handle(async (req, res) => {
    const out = await db.withRead(async (q) => ({ items: await myNoticeItems(q, req.user) }));
    res.json(out);
  }));
  router.get('/sysbuild/notices/:nid', handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '知会编号');
    const out = await db.withRead(async (q) => {
      const notice = await q.get('SELECT id, project_id, kind, ref_type, ref_id, recipient_member_id, created_at FROM sysbuild_notices WHERE id = ?', [nid]);
      if (!notice) throw rules.notFound();
      const { access, identity } = await loadProjectCtx(q, notice.project_id, req.user);
      const project = await q.get('SELECT system_name FROM sysbuild_projects WHERE id = ?', [notice.project_id]);
      const objection = await q.get('SELECT reason, actor_user_id, member_id, mode, objection_entry_id, created_at FROM sysbuild_notice_objections WHERE notice_id = ?', [nid]);
      const uid = Number(req.user.id);
      if (notice.kind === 'for_reference' && notice.ref_type === 'entry') {
        const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [notice.ref_id, notice.project_id]);
        if (!entry) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会所指登记不存在');
        const facts = await entries.loadEntryFacts(q, entry);
        const view = await noticeView(q, notice, objection, { access, identity, entry, facts, uid });
        return { notice: Object.assign(view, { system_name: project.system_name, entry: { id: entry.id, title: entry.title, body: entry.body, current_conclusion: currentConclusionOf(facts.derived) } }) };
      }
      if (notice.kind === notifySchedule.NOTICE_KIND_SCHEDULE && notice.ref_type === notifySchedule.NOTICE_REF_SCHEDULE) {
        const recipient = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ? AND project_id = ?', [notice.recipient_member_id, notice.project_id]);
        if (!access.isPm && !access.isAdmin && (!recipient || Number(recipient.user_id) !== uid)) throw rules.notFound();
        return { notice: Object.assign({}, notice, { system_name: project.system_name, recipient_name: await entries.memberNameOf(q, notice.recipient_member_id), objection, schedule: await scheduleNoticeView(q, notice), actions: { object: rules.opAllowed('schedule_notice_object', identity, access.project, await scheduleNoticeTarget(q, notice, objection, uid)) } }) };
      }
      throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会类型未识别');
    });
    res.json(out);
  }));
  // C6b 改期知会的视图：改期记录（改后计划、原因、记录时刻）+ 改前计划（同一节点上该记录之前最后一条 baseline / plan_change）+ 节点名、批次名。记录不存在返回 null。
  async function scheduleNoticeView(q, n) {
    const rec = await q.get('SELECT id, node_id, planned_start, planned_end, reason, created_at FROM sysbuild_node_schedule_records WHERE id = ?', [n.ref_id]);
    if (!rec) return null;
    const prev = await q.get(
      "SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND id < ? AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1",
      [rec.node_id, rec.id]
    );
    const node = await q.get('SELECT n.name AS node_name, n.batch_id AS batch_id, b.name AS batch_name FROM sysbuild_nodes n LEFT JOIN sysbuild_batches b ON b.id = n.batch_id WHERE n.id = ?', [rec.node_id]);
    return {
      record_id: rec.id, node_id: rec.node_id, node_name: node ? node.node_name : null, batch_id: node ? node.batch_id : null, batch_name: node ? node.batch_name : null,
      before: prev ? { start: prev.planned_start, end: prev.planned_end } : null, after: { start: rec.planned_start, end: rec.planned_end }, reason: rec.reason, changed_at: rec.created_at,
    };
  }
  // 改期知会异议的 target（读接口 actions.object 与写端点同一份）：接收人本人 + 仍是需求部门现任负责人 + 该知会还没有异议
  async function scheduleNoticeTarget(q, n, objection, uid) {
    const f = await notifySchedule.scheduleNoticeObjectorFacts(q, n);
    return { isRecipient: f.recipientUserId !== null && f.recipientUserId === Number(uid), stillOwner: f.stillOwner, objected: !!objection };
  }
  const recipientUserOf = async (q, memberId) => {
    const m = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [memberId]);
    return m ? m.user_id : null;
  };
  // notice_object 的 target（读接口 actions 与写端点同一份）
  //   codex 25 M1：资格 = 接收人本人，或 entries-core.objectorBasisOf 给出的依据（原登记人 / 当前结论确认人 / 来源方现任负责人或代表人），basis 由调用方算好传入（异步）。
  function noticeTarget(identity, entry, facts, notice, objection, recipientMemberId, uid, recipientUserId, basis) {
    const latest = facts.latestNotice;
    return {
      isRecipient: recipientUserId !== null && recipientUserId !== undefined && Number(recipientUserId) === Number(uid),
      objectorBasis: basis,
      objected: !!objection,
      entryVoided: facts.derived.voided,
      entryState: facts.derived.conclusion_state,
      isLatest: latest !== null && latest.notice.id === notice.id,
    };
  }

  // ── POST /sysbuild/notices/:nid/object：对知会提异议 ──────────────────────────────────────────────
  // 接收人本人，或来源方现任负责人（本方）；理由必填；同一知会只能异议一次。效果：仅供参考的知会被异议 → 登记结论状态 = 仅供参考被异议，回到正常办理（PM 须给结论并经确认）。
  //   项目状态类别 resolve（四态都允许）。非接收人、非本方负责人的项目成员得 403；非项目成员 404（可见性一步）。
  router.post('/sysbuild/notices/:nid/object', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '知会编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason']);
    const reason = readText(body.reason, 'reason', '异议原因', REASON_MAX, true);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const n = await q.get('SELECT id, project_id, kind, ref_type, ref_id, recipient_member_id, created_by, created_at FROM sysbuild_notices WHERE id = ?', [nid]);
      if (!n) throw rules.notFound();
      const { access, identity } = await loadProjectCtx(q, n.project_id, user);
      if (n.kind === notifySchedule.NOTICE_KIND_SCHEDULE) {
        // C6b（P158，替换 C5 的占位）：改期知会的异议按知会来源判资格——只有接收人本人、且仍是需求部门现任负责人（rules.schedule_notice_object）；其他人 403（含 PM、其他需求部门负责人、已卸任的接收人）。
        //   异议转 PM（mode = to_pm，objection_entry_id 为空），不生成异议补充登记、不拉任何登记回办理、不阻塞改期；每条知会至多一条异议（权限 403 → 项目状态 409 → 已异议 409）。
        const objection = await q.get('SELECT id FROM sysbuild_notice_objections WHERE notice_id = ?', [nid]);
        const starget = await scheduleNoticeTarget(q, n, objection, uid);
        rules.assertOp('schedule_notice_object', identity, access.project, starget);
        const sins = await q.run(
          'INSERT INTO sysbuild_notice_objections (notice_id, actor_user_id, member_id, reason, mode, objection_entry_id) VALUES (?, ?, ?, ?, ?, NULL)',
          [nid, uid, n.recipient_member_id, reason, 'to_pm']
        );
        await emit(q, user, n.project_id, 'notice', nid, 'notice_objected', {
          objection_id: sins.lastID, record_id: n.ref_id, reason, member_id: n.recipient_member_id, as: 'recipient', mode: 'to_pm', objection_entry_id: null,
        });
        const srow = await q.get('SELECT reason, actor_user_id, member_id, mode, objection_entry_id, created_at FROM sysbuild_notice_objections WHERE notice_id = ?', [nid]);
        const sview = n.ref_type === notifySchedule.NOTICE_REF_SCHEDULE ? await scheduleNoticeView(q, n) : null;
        return {
          notice: { id: n.id, project_id: n.project_id, kind: n.kind, ref_type: n.ref_type, ref_id: n.ref_id, created_at: n.created_at, objected: true, objection: srow, schedule: sview },
          mode: 'to_pm', objection_entry_id: null,
        };
      }
      if (n.kind !== 'for_reference' || n.ref_type !== 'entry') throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会类型未识别');
      const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [n.ref_id]);
      if (!entry) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会所指的登记不存在');
      const facts = await entries.loadEntryFacts(q, entry);
      const objection = await q.get('SELECT id FROM sysbuild_notice_objections WHERE notice_id = ?', [nid]);
      const target = noticeTarget(identity, entry, facts, n, objection, n.recipient_member_id, uid, await recipientUserOf(q, n.recipient_member_id), await entries.objectorBasisOf(q, entry, facts, identity, user));
      rules.assertOp('notice_object', identity, access.project, target);
      // 提异议的人是接收人本人时挂接收人的成员行；否则挂其本人的成员行（原登记人 / 确认人 / 来源方负责人或代表人）
      const memberId = target.isRecipient ? n.recipient_member_id : identity.memberId;
      if (memberId === null || memberId === undefined) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：提异议的人没有成员行');
      // S-S1b（D34）：关联节点还没收口 → 原登记回到办理（mode = return_to_handling，同 S-S1a）；节点已收口（项目整体挂靠的：项目已终止 / 已结项）→ 不拉回办理、不阻塞已收口节点，
      //   改为生成一条异议补充登记（走与写登记同一个 createEntryCore：分流、拆分、判定快照），原登记保持仅供参考。关联条目所在批次已上线时整笔 409（引导系统迭代）。
      const eNode = entry.node_id === null ? null : ((await q.get('SELECT id, project_id, status, closed_at FROM sysbuild_nodes WHERE id = ?', [entry.node_id])) || null);
      const per = await entries.decideEntryPeriod(q, access.project, eNode, today());
      const mode = per.period === 'supplement' ? 'supplement_entry' : 'return_to_handling';
      let objectionEntryId = null;
      if (mode === 'supplement_entry') {
        const input = {
          objectsEntryId: entry.id, type: 'feedback', purpose: 'general', title: Array.from(`对第 ${entry.id} 条仅供参考登记的异议：${entry.title}`).slice(0, TITLE_MAX).join(''), text: reason,
          businessDate: null, commitment: 0, isRisk: 0, nodeId: entry.node_id, sourcePartyId: null, itemIds: Array.from(new Set(facts.currentItemRows.map((r) => r.item_id))), attachmentIds: [],
          ev: { noEvidence: false, noEvidenceReason: null },
        };
        const ownParty = identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined && identity.partyId !== undefined ? identity.partyId : null;
        objectionEntryId = (await createEntryCore(q, user, access, identity, n.project_id, { input, per, sourcePartyId: ownParty, objectsEntryId: entry.id })).entry_id;
      }
      const ins = await q.run(
        'INSERT INTO sysbuild_notice_objections (notice_id, actor_user_id, member_id, reason, mode, objection_entry_id) VALUES (?, ?, ?, ?, ?, ?)',
        [nid, uid, memberId, reason, mode, objectionEntryId]
      );
      await emit(q, user, n.project_id, 'notice', nid, 'notice_objected', {
        objection_id: ins.lastID, entry_id: entry.id, reason, member_id: memberId, as: target.isRecipient ? 'recipient' : target.objectorBasis, mode, objection_entry_id: objectionEntryId,
      });
      const after = await entries.loadEntryFacts(q, entry);
      const row = after.noticeRows.find((x) => x.notice.id === nid);
      return {
        notice: await noticeView(q, n, row ? row.objection : null, { access, identity, entry, facts: after, uid }), entry: { id: entry.id, conclusion_state: after.derived.conclusion_state },
        mode, objection_entry_id: objectionEntryId,
      };
    });
    res.status(201).json(out);
  }));

  return { router, myNoticeItems }; // myNoticeItems：C6b GET /my/todo 的 notice 类用（与 GET /my/notices 同源）
}

module.exports = { createEntryRoutes, assertEvidence }; // assertEvidence 供 changes.js 复用（方向类证据同一口径）
