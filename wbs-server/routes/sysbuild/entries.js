// routes/sysbuild/entries.js — 项目管理（系统建设记录）模块：登记与办理、改期知会的接收人查看（C5 S-S1a；C6 起办理只剩更正与作废）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §4.1（登记规则表、过程 / 补充登记、办理结论的确认、仅供参考）、§4.2「办理结论」「异议裁定」、§4.5、§5.2–5.3、§6.2、§6.3、§7「登记与办理」「知会」。
//   派单 = docs/local/系统建设记录/送审准备/C5_S-S1a_登记与办理_派单_20261105.md（本文口径与方案冲突时以派单为准，冲突点在交付报告里列出）。方案与派单里的办理结论 / 仅供参考 / 异议裁定 / 知会异议 / 分流与拆分条款已随 #212 C6 删除，上面 §4.2「办理结论」「异议裁定」等引用只作历史出处。
//
// 工厂 createEntryRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（todayProvider：业务日期上限与「收口后第 N 天」用，缺省取服务器本地日期）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 对象状态 / 业务规则 409 → 证据与引用对象 400。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp（OBJECT_OPS + OP_KIND）；读接口逐对象 actions 用 rules.opAllowed 与同一个 target 构造函数（entries-core.entryTarget），标志与执行同源。
// 登记与办理记录只追加（sysbuild_entries / sysbuild_entry_actions 不在 UPDATABLE_COLUMNS）；登记当前状态（是否作废）由服务端派生，不落列。
// C6 起登记只剩三类入口：通用登记、三张保留表单（进度汇报、汇报节奏、临时汇报要求）与补充登记；办理动作只剩更正（correct）与作废（void）。
//   结论确认、仅供参考知会、分流与拆分、开发方认可、知会异议已随 C6 删除；改期知会的接收人查看（GET /my/notices、GET /notices/:nid）保留。
// 仍不做（代码里遇到的明确 409，不做半套）：评论与评论转登记（第二期）。
'use strict';
const { attachmentStateFields } = require('./attachments');
const express = require('express');
const rules = require('./rules');
const schema = require('./schema');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { attachmentDisplayName } = require('./attachments');
const core = require('./confirm-core');
const entries = require('./entries-core');
const forms = require('./entry-forms');
const reports = require('./report-core');
const { reportRecipientsOf } = require('./report-recipients');
const notifySchedule = require('./notify-schedule'); // C6b：改期知会的视图（只依赖 events / confirm-core / notify-core，不成环）

const TITLE_MAX = 100;
const BODY_MAX = 4000;
const TEXT_MAX = 2000; // 更正说明
const REASON_MAX = 500; // 作废、无书面证据原因
const EVIDENCE_REASON_MIN = 10;
const ID_LIST_MAX = 20;
// 登记请求键白名单。C6（P-R9 = A、P-R6E = A）退出六键（涉及承诺标记、风险标记、关联条目、异议对象、修订来源、本人确认说明）：不在白名单里，出现即 400（onlyKeys，不看值）。
const CREATE_KEYS = Object.freeze([
  'node_id', 'type', 'purpose', 'title', 'body', 'business_date', 'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason', 'form',
]);
// 登记类型：七类去掉「更正」——更正走办理动作 correct，不作独立登记（派单 §3）
const REGISTERABLE_TYPES = Object.freeze(schema.ENUMS.entryType.filter((x) => x !== 'correction'));
// 办理动作 → 允许的请求字段（其余字段 400）。动作名 = OBJECT_OPS 里 entry_<动作>。C6 起只剩更正与作废。
const ACTION_FIELDS = Object.freeze({
  correct: Object.freeze(['text']),
  void: Object.freeze(['reason']),
});
// 需要写「原因」的动作：reason 存进办理记录的 text 列
const REASON_ACTIONS = Object.freeze(['void']);
// 每个动作的 OBJECT_OPS 名与 actions 标志名（标志名 = 请求里的动作名）
const ACTION_FLAGS = Object.freeze(['correct', 'void']);

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

// 方向类证据校验（至少一个附件，或声明无书面证据并写明原因 ≥ 10 字，两者互斥）。mode：
//   material = 补交材料（必有附件，「无书面证据」不能代替，缺 → 400 SYSBUILD_EVIDENCE_REQUIRED）；direction = 影响里程碑的进度汇报（表单 milestone_impact === true，附件或声明二选一）；optional = 证据可选（声明了就按同样规则校验）。
function assertEvidence(count, ev, mode) {
  if (mode === 'material' && count === 0) throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '补交材料必须上传附件');
  if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');
  if (!ev.noEvidence && ev.noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');
  if (mode === 'direction' && !ev.noEvidence && count === 0) {
    throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '影响里程碑的进度汇报须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）');
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
  const today = () => reports.todayOf(ctx.todayProvider);

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
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
  // 每条登记的 actions：标志与写端点同一张 OBJECT_OPS 表、同一个 target 构造函数（entries-core.entryTarget），前端不推算。C6 起只有更正与作废两个办理动作。
  async function actionsOf(q, access, identity, entry, facts, user) {
    const t = await entries.entryTarget(q, access.project, entry, facts, user);
    const out = {};
    for (const a of ACTION_FLAGS) out[a] = rules.opAllowed(`entry_${a}`, identity, access.project, t);
    return out;
  }
  async function baseView(q, access, identity, entry, facts, user) {
    const d = facts.derived;
    const actions = await actionsOf(q, access, identity, entry, facts, user);
    const formView = forms.entryFormView(entry, facts.actions);
    return {
      id: entry.id, project_id: entry.project_id, node_id: entry.node_id, type: entry.type,
      source_party_id: entry.source_party_id, source_name: entry.source_name,
      operator_user_id: entry.operator_user_id, operator_name: await userNameOf(q, entry.operator_user_id), operator_identity: entries.parseSnapshot(entry),
      period: entry.period, days_after_close: entry.days_after_close, business_date: entry.business_date, title: entry.title, body: entry.body,
      no_written_evidence: entry.no_written_evidence === 1, no_evidence_reason: entry.no_evidence_reason,
      voided: d.voided,
      created_at: entry.created_at,
      actions,
      ...formView,
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
    view.attachments = await attachmentsOfEntry(q, entry.id);
    view.records = [];
    for (const a of facts.actions) {
      view.records.push({ id: a.id, action: a.action, text: a.text, created_by: a.created_by, created_by_name: await userNameOf(q, a.created_by), created_at: a.created_at });
    }
    return view;
  }

  // ── POST /sysbuild/projects/:id/entries：写登记 ───────────────────────────────────────────────
  function readCreateInput(body) {
    body = forms.normalizeEntryRequest(body);
    const type = body.type;
    if (typeof type !== 'string' || type === '') throw invalid('登记类型必填', 'type');
    if (type === 'correction') throw invalid('更正走办理动作（POST /entries/:eid/actions，action = correct），不作独立登记', 'type');
    if (!REGISTERABLE_TYPES.includes(type)) throw invalid(`登记类型必须是 ${REGISTERABLE_TYPES.join(' / ')} 之一`, 'type');
    // C6（P-R9 = A）：通用登记的用途只剩 general；取值集合与元数据 registration.purposes 同读 rules.ENTRY_PURPOSES_FINAL（读写同源）
    const purpose = body.purpose === undefined || body.purpose === null ? 'general' : body.purpose;
    if (typeof purpose !== 'string' || !rules.ENTRY_PURPOSES_FINAL.includes(purpose)) throw invalid(`用途必须是 ${rules.ENTRY_PURPOSES_FINAL.join(' / ')}`, 'purpose');
    const title = readText(body.title, 'title', '标题', TITLE_MAX, true);
    // 表单正文由已逐字段校验的原文生成，字段上限之和可达 4000，模板标题不占字段额度。
    const text = body.form ? body.body : readText(body.body, 'body', '内容', BODY_MAX, true);
    let businessDate = null;
    if (body.business_date !== undefined && body.business_date !== null && body.business_date !== '') {
      if (!validDate(body.business_date)) throw invalid('业务日期必须是 YYYY-MM-DD 格式的有效日期（2000–2099）', 'business_date');
      businessDate = body.business_date;
    }
    const nodeId = body.node_id === undefined || body.node_id === null ? null : readIdParam(body.node_id, 'node_id', '节点');
    const sourcePartyId = body.source_party_id === undefined || body.source_party_id === null ? null : readIdParam(body.source_party_id, 'source_party_id', '来源方');
    const attachmentIds = readIdList(body.attachment_ids, 'attachment_ids', '附件编号', ID_LIST_MAX);
    if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
    const ev = { noEvidence: body.no_written_evidence === true, noEvidenceReason: readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', REASON_MAX, false) };
    return { type, purpose, title, text, businessDate, nodeId, sourcePartyId, attachmentIds, ev, form: body.form || null };
  }

  // 登记写入：写登记行 → 附件 → 事件。c = { input, per, sourcePartyId }：input 是 readCreateInput 的结果，per = 时段判定。
  async function createEntryCore(q, user, access, identity, pid, c) {
    const { input, per, sourcePartyId } = c;
    const uid = Number(user.id);
    const snapshot = entries.operatorSnapshotOf(identity);
    const eid = await entries.insertEntryRow(q, {
      projectId: pid, nodeId: input.nodeId, type: input.type,
      sourcePartyId, operatorUserId: uid, snapshotJson: JSON.stringify(snapshot), period: per.period, days: per.days, businessDate: input.businessDate, title: input.title, body: input.text,
      noEvidence: input.ev.noEvidence ? 1 : 0, noEvidenceReason: input.ev.noEvidenceReason, form: input.form,
    });
    const bound = input.attachmentIds.length > 0
      ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid, userId: uid, attachmentIds: input.attachmentIds, ownerType: 'entry', ownerId: eid, operatorName: core.operatorNameOf(user) })
      : [];
    await emit(q, user, pid, 'entry', eid, 'entry_created', {
      type: input.type, purpose: input.purpose, node_id: input.nodeId, period: per.period, days_after_close: per.days, source_party_id: sourcePartyId,
      attachment_ids: bound, no_written_evidence: input.ev.noEvidence, operator_identity: snapshot,
    });
    const row = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
    return { entry: await detailView(q, access, identity, row, user), entry_id: eid };
  }

  router.post('/sysbuild/projects/:id/entries', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, CREATE_KEYS);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const input = readCreateInput(body);
      const { access, identity } = await loadProjectCtx(q, pid, user);
      await forms.assertFormRegistrant(q, pid, input.form, identity, access.project);
      const todayStr = today();
      // 时段由服务端判定（§4.1，登记人不能选）：先取节点算时段，才能按时段对应的项目状态类别判（已终止 / 已结项只能写补充登记）。节点不存在 / 不属于本项目的 400 在权限与状态检查之后。
      const node = input.nodeId === null ? null : (await q.get('SELECT id, project_id, status, closed_at FROM sysbuild_nodes WHERE id = ? AND project_id = ?', [input.nodeId, pid])) || null;
      const per = await entries.decideEntryPeriod(q, access.project, node, todayStr);
      rules.assertOp(per.period === 'process' ? 'entry_create_process' : 'entry_create_supplement', identity, access.project, {});
      if (input.nodeId !== null && node === null) throw invalid('节点不存在或不属于本项目', 'node_id');
      if (node !== null && node.status === 'cancelled') throw stateError('该节点已取消，不能再关联新登记');
      if (input.businessDate !== null && input.businessDate > todayStr) throw invalid(`业务日期不能晚于今天（${todayStr}）`, 'business_date');
      // 来源方：PM（含平台管理员）可代登并填真实来源方（不填 = 本人登记，来源方为空）；其他人填了 400；成员本人取其成员行的参与方（可空 = 信息技术部内部成员）；admin 非成员来源方为空。
      let sourcePartyId = null;
      if (input.sourcePartyId !== null) {
        if (!rules.canActAsPm(identity)) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');
        const party = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [input.sourcePartyId, pid]);
        if (!party) throw invalid('来源方不是本项目的参与方', 'source_party_id');
        sourcePartyId = party.id;
      } else if (identity.isPm !== true && identity.memberId !== null && identity.memberId !== undefined) {
        sourcePartyId = identity.partyId === undefined ? null : identity.partyId;
      }
      // 证据：补交材料必有附件；影响里程碑的进度汇报（表单 milestone_impact === true）是方向类（附件或「无书面证据」+ 原因 ≥ 10 字）；其余可选
      assertEvidence(input.attachmentIds.length, input.ev, input.type === 'material' ? 'material' : (input.form !== null && input.form.kind === 'progress_report' && input.form.milestone_impact === true ? 'direction' : 'optional'));
      input.form = await forms.deriveEntryForm(q, pid, input.form, { identity, project: access.project, nodeId: input.nodeId, sourcePartyId, today: todayStr });
      // 写登记行 → 附件 → 事件：见上面的 createEntryCore
      const created = await createEntryCore(q, user, access, identity, pid, { input, per, sourcePartyId });
      const response = { entry: created.entry };
      if (input.form && input.form.kind === 'report_request' && (await reportRecipientsOf(q, pid)).due.length === 0) response.no_recipient = true;
      if (input.form && input.form.kind === 'progress_report' && input.form.milestone_impact) response.milestone_warning = '本次汇报影响里程碑，请 PM 评估是否发起改期';
      return response;
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
    // P-W9：登记列表没有 routing 筛选（待判定列表随 C6 删除），routing 键出现即拒（含空串），不静默忽略——静默忽略会把「只看待分流」变成「返回全部」而调用方不知情（fail-open）。
    if (hasKey(qs, 'routing')) throw invalid('不支持的查询参数 routing', 'routing');
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const { access, identity } = await loadProjectCtx(q, pid, user);
      const rows = await q.all(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE ${conds.join(' AND ')} ORDER BY id DESC`, params);
      const list = [];
      for (const entry of rows) {
        const facts = await entries.loadEntryFacts(q, entry);
        list.push(await baseView(q, access, identity, entry, facts, user));
      }
      const devPartyId = await entries.devPartyIdOf(q, pid);
      const devAllowed = rules.opAllowed('entry_create_dev', identity, access.project, { devPartyId });
      const sources = identity.isPm === true || rules.canActAsPm(identity) ? [{ id: null, label: identity.isPm === true ? 'PM 本人登记' : '管理员本人登记' }, ...(await q.all('SELECT id, name FROM sysbuild_parties WHERE project_id = ? ORDER BY sort_order, id', [pid])).map((p) => ({ id: p.id, label: '代登：' + p.name }))] : null;
      return {
        project_id: pid, entries: list,
        registration: { types: REGISTERABLE_TYPES, purposes: rules.ENTRY_PURPOSES_FINAL, source_choices: sources, forms: forms.availableForms({ generalAllowed: rules.opAllowed('entry_create_process', identity, access.project, {}) || rules.opAllowed('entry_create_supplement', identity, access.project, {}), devAllowed, isPm: rules.canActAsPm(identity) }) },
        actions: { create_entry: rules.opAllowed('entry_create_process', identity, access.project, {}) || rules.opAllowed('entry_create_supplement', identity, access.project, {}) },
      };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/entries/:eid：详情（办理记录、附件、逐对象 actions）──────────────────────────────────
  router.get('/sysbuild/entries/:eid', handle(async (req, res) => {
    const eid = readIdParam(req.params.eid, 'eid', '登记编号');
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const { entry, access, identity } = await loadEntryCtx(q, eid, user);
      return { entry: await detailView(q, access, identity, entry, user) };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/entries/:eid/actions：办理动作（C6 起只有更正与作废）─────────────────────────────
  function readActionInput(body) {
    const action = body.action;
    if (typeof action !== 'string' || action === '') throw invalid('办理动作必填', 'action');
    if (!schema.ENUMS.entryAction.includes(action)) throw invalid(`不支持的办理动作 ${action}`, 'action');
    if (!hasKey(ACTION_FIELDS, action)) throw invalid(`不支持的办理动作 ${action}`, 'action');
    onlyKeys(body, ['action', ...ACTION_FIELDS[action]]);
    const out = { action, text: null };
    if (REASON_ACTIONS.includes(action)) {
      out.text = readText(body.reason, 'reason', '原因', REASON_MAX, true);
    } else if (action === 'correct') {
      out.text = readText(body.text, 'text', '更正内容', TEXT_MAX, true);
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
      const facts = await entries.loadEntryFacts(q, entry);
      const target = await entries.entryTarget(q, access.project, entry, facts, user);
      rules.assertOp(`entry_${input.action}`, identity, access.project, target);
      const ins = await q.run(
        'INSERT INTO sysbuild_entry_actions (entry_id, action, text, created_by) VALUES (?, ?, ?, ?)',
        [eid, input.action, input.text, uid]
      );
      const actionId = ins.lastID;
      await emit(q, user, entry.project_id, 'entry', eid, 'entry_action_recorded', {
        action_id: actionId, action: input.action,
        ...(input.action === 'void' && target.formUnreadable ? { form_unreadable: true, form_note: '表单不可读' } : {}),
      });
      const row = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ?`, [eid]);
      return { entry: await detailView(q, access, identity, row, user), action_id: actionId };
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/my/notices：我作为接收人的知会（只读，不写浏览记录）──────────────────────────────
  //   列表取数抽成 myNoticeItems(q, user)（C6 起 GET /my/todo 不再读它，函数与导出保留）；改期知会（kind = schedule_change）的视图见 scheduleNoticeView。
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
      const rows = asRecipient.map((r) => Object.assign({}, r, { as: 'recipient' }));
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
        if (n.ref_type === notifySchedule.NOTICE_REF_SCHEDULE) {
          // C6b：改期知会——改期前后日期、原因、批次与里程碑名
          const view = await scheduleNoticeView(q, n);
          if (view === null) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：知会所指的改期记录不存在');
          item.schedule = view;
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
      const { access } = await loadProjectCtx(q, notice.project_id, req.user);
      const project = await q.get('SELECT system_name FROM sysbuild_projects WHERE id = ?', [notice.project_id]);
      const uid = Number(req.user.id);
      if (notice.kind === notifySchedule.NOTICE_KIND_SCHEDULE && notice.ref_type === notifySchedule.NOTICE_REF_SCHEDULE) {
        const recipient = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ? AND project_id = ?', [notice.recipient_member_id, notice.project_id]);
        if (!access.isPm && !access.isAdmin && (!recipient || Number(recipient.user_id) !== uid)) throw rules.notFound();
        return { notice: Object.assign({}, notice, { system_name: project.system_name, recipient_name: await entries.memberNameOf(q, notice.recipient_member_id), schedule: await scheduleNoticeView(q, notice) }) };
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

  return { router, myNoticeItems }; // myNoticeItems 与 GET /my/notices 同源；C6 起不再传给 notify（index.js 不传参）
}

module.exports = { createEntryRoutes };
