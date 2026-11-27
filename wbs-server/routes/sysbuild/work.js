'use strict';

const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { ENUMS } = require('./schema');
const { operatorNameOf } = require('./confirm-core');
const { readId, readText } = require('./membership-people');
const { effectiveOverallVersionId } = require('./packages');
const work = require('./work-core');
const workNotify = require('./work-notify');

const TITLE_MAX = 100;
const BODY_MAX = 4000;
const REASON_MAX = 500;
const SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const has = (body, field) => Object.hasOwn(body, field);
const { invalid, invalidState } = work;

function hoursOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid('工时须为非负数字', 'estimated_hours');
  return value;
}

function optionalReason(body, field, label) {
  const value = body[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return readText(value, field, label, REASON_MAX);
}

function opinionTarget(context, opinion, approval) {
  return {
    opinionStatus: opinion?.status,
    isDevResponsible: context.developer?.userId === context.identity.userId,
    isCutResponsible: approval?.responsible?.userId === context.identity.userId,
    hasCutResponsible: !!approval?.responsible, // 平台管理员代办表态的前置：该部门有现任负责人
    cutStatus: approval?.row?.status,
  };
}
// 开发评估的登记方式：平台管理员代办（不要求截图，2026-11-27 用户定）、PM 代录（须带截图）、开发负责人本人。
//   平台管理员先判：他兼任本项目 PM（比如接管之后）时仍按管理员代办，不因为成了 PM 反而要补截图（codex 290 号 HIGH）；
//   他本人就是现任开发负责人时算本人评估。其余人的判定与原来相同：PM 与参与方身份互斥，是 PM 即代录，否则只可能是开发负责人本人。
function assessModeOf(identity, target) {
  if (rules.canProxyAsSuperAdmin(identity) && !target.isDevResponsible) return 'admin';
  if (identity.isPm) return 'proxy';
  return 'dev';
}

function opinionActions(context, opinion) {
  const { identity } = context;
  const target = opinionTarget(context, opinion);
  const assess = rules.opAllowed('opinion_assess', identity, identity.project, target);
  return {
    triage: rules.opAllowed('opinion_triage', identity, identity.project, target),
    assess,
    assess_mode: assess ? assessModeOf(identity, target) : null,
    dispose: rules.opAllowed('opinion_dispose', identity, identity.project, target),
    cut_withdraw: rules.opAllowed('opinion_cut_withdraw', identity, identity.project, target),
  };
}

function createWorkRoutes({ db, logger, readonlyIds, writeRoles, attachmentHelpers }) {
  const router = express.Router();
  const accessOptions = { readonlyIds, writeRoles };
  function sendError(res, error) {
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      const response = { code: error.code, message: error.message };
      if (error.field) response.field = error.field;
      return res.status(error.status).json(response);
    }
    logger.error('[sysbuild/work]', error);
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const json = express.json({ limit: '64kb' });
  function parseJson(req, res, next) {
    json(req, res, (error) => error ? sendError(res, invalid('请求体须为有效 JSON', 'body')) : next());
  }
  const handle = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((error) => sendError(res, error));

  async function projectContext(q, id, user) {
    const access = await rules.loadProjectAccess(q, id, user, accessOptions);
    rules.assertVisible(access);
    const identity = await rules.completeIdentity(q, access, user);
    const developer = await work.developerResponsible(q, id);
    return { identity, developer };
  }

  const loadOpinion = (q, id) => q.get('SELECT * FROM sysbuild_opinions WHERE id = ?', [id]);
  async function opinionContext(q, id, user) {
    const opinion = await loadOpinion(q, id);
    if (!opinion) throw rules.notFound();
    const context = await projectContext(q, opinion.project_id, user);
    return { opinion, context };
  }

  async function opinionDetail(q, context, opinion) {
    const attachments = await work.attachmentsOf(q, opinion.project_id, 'opinion', opinion.id);
    const assessmentAttachments = await work.attachmentsOf(q, opinion.project_id, 'opinion_assessment', opinion.id);
    const approvals = opinion.cut_scope_version_id === null ? [] : await cutRowsOf(q, opinion);
    for (const row of approvals) {
      const responsible = opinion.status === 'cut_approval' ? await work.responsibleUser(q, opinion.project_id, row.party_id) : null;
      row.can_decide = rules.opAllowed('opinion_cut_decide', context.identity, context.identity.project, opinionTarget(context, opinion, { row, responsible }));
      row.decide_mode = row.can_decide ? (responsible?.userId === context.identity.userId ? 'self' : 'admin') : null; // admin = 平台管理员代办
      row.by_admin_proxy = await cutDecidedByProxy(q, row);
      // 代办表单要写明代的是谁，并把这位负责人的授权编号带回来由写端复核（期间换了负责人就拒绝，codex 290 / 292 号）。只在可代办时给。
      row.proxy_for = row.decide_mode === 'admin'
        ? { delegation_id: responsible.delegationId, name: (await q.get('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [responsible.userId]))?.name ?? null }
        : null;
    }
    // 开发意见是不是平台管理员代办的：库里与 PM 代录同记为 proxy，区别只在评估事件里（by_super_admin）。
    let assessmentByAdmin = false;
    if (opinion.assessment_source === 'proxy') {
      const event = await q.get(
        "SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND object_type = 'opinion' AND object_id = ? AND event_type = 'opinion_assessed' ORDER BY id DESC LIMIT 1",
        [opinion.project_id, opinion.id]
      );
      try { assessmentByAdmin = !!event && JSON.parse(event.payload_json)?.by_super_admin === true; } catch (_) { assessmentByAdmin = false; }
    }
    const task = opinion.outcome === 'now'
      ? await q.get('SELECT id, node_id FROM sysbuild_tasks WHERE project_id = ? AND source_opinion_id = ?', [opinion.project_id, opinion.id]) : null;
    return { ...opinion, assessment_by_admin: assessmentByAdmin, attachments, assessment_attachments: assessmentAttachments, approvals, task: task || null, actions: opinionActions(context, opinion) };
  }
  // 这条砍需求表态是不是平台管理员代办的：表态人不是所依据授权的那位负责人。
  async function cutDecidedByProxy(q, row) {
    if (row.decided_by === null || row.decided_by === undefined || row.delegation_id === null || row.delegation_id === undefined) return false;
    const holder = await q.get('SELECT m.user_id AS user_id FROM sysbuild_delegations d JOIN sysbuild_members m ON m.id = d.member_id WHERE d.id = ?', [row.delegation_id]);
    return !!holder && holder.user_id !== null && Number(holder.user_id) !== Number(row.decided_by);
  }
  async function bind(q, user, projectId, ownerType, ownerId, attachmentIds) {
    if (!attachmentIds.length) return [];
    return attachmentHelpers.bindStagedAttachments(q, {
      projectId, userId: Number(user.id), ownerType, ownerId, attachmentIds, operatorName: operatorNameOf(user),
    });
  }
  async function verifyScreenshot(q, ids) {
    for (const id of ids) {
      const row = await q.get('SELECT mime_type, is_image FROM sysbuild_attachments WHERE id = ?', [id]);
      if (row?.is_image === 1 && SCREENSHOT_TYPES.has(row.mime_type)) return;
    }
    throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '请上传开发方意见截图');
  }

  async function opinionWaiters(q, context, rows) {
    const project = context.identity.project;
    const nameOf = async (id) => {
      if (!id) return null;
      const person = await q.get("SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ? AND status = 'active'", [id]);
      return person?.name ?? null;
    };
    const pm = rows.some((row) => row.status === 'triage' || row.status === 'disposition')
      ? { role: 'pm', name: await nameOf(project.pm_user_id) } : null;
    const developer = rows.some((row) => row.status === 'assessment')
      ? { role: 'developer', name: await nameOf(context.developer?.userId) } : null;
    const demand = Object.create(null);
    const names = Object.create(null);
    if (rows.some((row) => row.status === 'cut_approval')) {
      const approvals = await q.all(
        "SELECT opinion_id, party_id, party_name FROM sysbuild_cut_approvals WHERE project_id = ? AND status = 'pending' ORDER BY party_id",
        [project.id]
      );
      for (const row of approvals) {
        if (!Object.hasOwn(names, row.party_id)) {
          const delegate = await work.responsibleUser(q, project.id, row.party_id);
          names[row.party_id] = await nameOf(delegate?.userId);
        }
        (demand[row.opinion_id] ??= []).push({ party_name: row.party_name, name: names[row.party_id] });
      }
    }
    return (row) => {
      if (row.status === 'triage' || row.status === 'disposition') return pm;
      if (row.status === 'assessment') return developer;
      if (row.status === 'cut_approval') return { role: 'demand', parties: demand[row.id] || [] };
      return null;
    };
  }

  router.get('/sysbuild/projects/:id/opinions', handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id', '项目');
    res.json(await db.withRead(async (q) => {
      const context = await projectContext(q, projectId, req.user);
      const rows = await q.all(`SELECT id, node_id, title, author_name, category, status, outcome, updated_at, ${work.OPINION_PENDING_SQL} AS is_pending
        FROM sysbuild_opinions WHERE project_id = ? ORDER BY id DESC`, [projectId]);
      const waitFor = await opinionWaiters(q, context, rows);
      const canCreate = rules.opAllowed('opinion_create', context.identity, context.identity.project);
      return {
        opinions: rows.map((opinion) => ({
          ...opinion, is_pending: opinion.is_pending === 1, waiting_for: waitFor(opinion), actions: opinionActions(context, opinion),
        })),
        actions: { create: canCreate, self_assess: canCreate && opinionTarget(context).isDevResponsible },
      };
    }));
  }));

  router.get('/sysbuild/opinions/:id', handle(async (req, res) => {
    const id = readId(req.params.id, 'id', '意见');
    res.json(await db.withRead(async (q) => {
      const { opinion, context } = await opinionContext(q, id, req.user);
      return { opinion: await opinionDetail(q, context, opinion) };
    }));
  }));

  router.post('/sysbuild/projects/:id/opinions', parseJson, handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id', '项目');
    const body = req.body;
    work.onlyFields(body, ['title', 'body', 'attachment_ids', 'estimated_hours']);
    const title = readText(body.title, 'title', '标题', TITLE_MAX);
    const text = readText(body.body, 'body', '内容', BODY_MAX);
    const attachmentIds = work.readAttachmentIds(body.attachment_ids);
    const hours = has(body, 'estimated_hours') ? hoursOf(body.estimated_hours) : null;
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const context = await projectContext(q, projectId, user);
      const { identity, developer } = context;
      rules.assertOp('opinion_create', identity, identity.project);
      const selfAssess = opinionTarget(context).isDevResponsible;
      if (selfAssess && hours === null) throw invalid('开发负责人提出意见时请填写工时', 'estimated_hours');
      if (!selfAssess && hours !== null) throw invalid('只有当前开发负责人可在提议时填写工时', 'estimated_hours');
      const party = identity.partyId === null ? null
        : await q.get('SELECT side FROM sysbuild_parties WHERE id = ? AND project_id = ?', [identity.partyId, projectId]);
      const nodeId = await work.lastInProgressNode(q, projectId);
      const row = await q.run(
        `INSERT INTO sysbuild_opinions (project_id, node_id, author_user_id, author_name, author_side, title, body,
           assessment_text, assessment_hours, assessment_source, assessed_by, assessed_at, assessed_for_user_id, assessed_for_delegation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now','localtime') END, ?, ?)`,
        [projectId, nodeId, identity.userId, operatorNameOf(user), party?.side || 'internal', title, text,
          selfAssess ? text : null, hours, selfAssess ? 'self' : null, selfAssess ? identity.userId : null, selfAssess ? 1 : 0,
          selfAssess ? developer.userId : null, selfAssess ? developer.delegationId : null]
      );
      const bound = await bind(q, user, projectId, 'opinion', row.lastID, attachmentIds);
      await work.emit(q, user, projectId, 'opinion', row.lastID, 'opinion_created', {
        node_id: nodeId, author_side: party?.side || 'internal', title, estimated_hours: hours, attachment_ids: bound,
      });
      return { opinion: await opinionDetail(q, context, await loadOpinion(q, row.lastID)) };
    });
    res.status(201).json(out);
  }));

  function readTriage(body) {
    work.onlyFields(body, ['action', 'category', 'text', 'decision', 'needs_assessment', 'skip_reason']);
    if (!ENUMS.opinionCategory.includes(body.category)) throw invalid('请选择意见分类', 'category');
    if (body.decision !== 'continue' && body.decision !== 'no') throw invalid('请选择初判结果', 'decision');
    if (has(body, 'needs_assessment') && typeof body.needs_assessment !== 'boolean') throw invalid('是否需要评估必须是布尔值', 'needs_assessment');
    return {
      category: body.category, text: readText(body.text, 'text', '初判意见', BODY_MAX), decision: body.decision,
      needsAssessment: body.needs_assessment, skipReason: optionalReason(body, 'skip_reason', '跳过评估原因'),
    };
  }
  function readAssessment(body) {
    work.onlyFields(body, ['action', 'text', 'estimated_hours', 'attachment_ids', 'expected_mode']);
    // expected_mode（可选）：打开表单时页面显示的登记方式（本人 dev / PM 代录 proxy / 管理员代办 admin）。带了就由写端核对此刻仍是这种方式。
    const expectedMode = has(body, 'expected_mode') && body.expected_mode !== null ? body.expected_mode : null;
    if (expectedMode !== null && !['dev', 'proxy', 'admin'].includes(expectedMode)) throw invalid('评估的登记方式不合法', 'expected_mode');
    return { text: readText(body.text, 'text', '开发意见', BODY_MAX), hours: hoursOf(body.estimated_hours), attachmentIds: work.readAttachmentIds(body.attachment_ids), expectedMode };
  }

  async function triage(q, user, context, opinion, input) {
    const { identity } = context;
    const rejected = input.decision === 'no';
    const cut = input.category === 'cut';
    const needsAssessment = rejected || cut ? null : input.needsAssessment !== false;
    if (rejected && input.needsAssessment !== undefined) throw invalid('直接答复时无需填写是否评估', 'needs_assessment');
    if (cut && input.needsAssessment !== undefined) throw invalid('砍需求初判合理后由需求方负责人表态', 'needs_assessment');
    if (needsAssessment === false && !input.skipReason) throw invalid('请填写跳过开发评估的原因', 'skip_reason');
    if (needsAssessment !== false && input.skipReason) throw invalid('只有跳过评估时可以填写原因', 'skip_reason');
    let status = 'disposition';
    let cutScope = null;
    if (cut) {
      if (opinion.author_side !== 'dev') throw invalidState('只有开发方提出的意见可归为砍需求', 'category');
      const versionId = await effectiveOverallVersionId(q, opinion.project_id);
      if (versionId === null) throw invalidState('范围尚未确认，可先按需求调整归类', 'category');
      if (!rejected) {
        const roster = await work.originalDemandRoster(q, opinion.project_id, versionId);
        if (!roster.length) throw invalidState('无法核对原范围的需求部门，请核实后再发起同意', 'category');
        for (const party of roster) {
          await q.run('INSERT INTO sysbuild_cut_approvals (project_id, opinion_id, party_id, party_name) VALUES (?, ?, ?, ?)',
            [opinion.project_id, opinion.id, party.party_id, party.name]);
        }
        cutScope = versionId;
        status = 'cut_approval';
      }
    } else if (needsAssessment && opinion.assessment_source !== 'self') {
      status = 'assessment';
    }
    if (rejected) status = 'concluded';
    const updated = await q.run(
      `UPDATE sysbuild_opinions SET category = ?, status = ?, triage_text = ?, triaged_by = ?, triaged_at = datetime('now','localtime'),
         needs_assessment = ?, skip_reason = ?, outcome = ?, outcome_text = ?, resolved_by = ?,
         resolved_at = CASE WHEN ? THEN datetime('now','localtime') END, cut_scope_version_id = ?,
         updated_at = datetime('now','localtime') WHERE id = ? AND status = ?`,
      [input.category, status, input.text, identity.userId, needsAssessment === null ? null : Number(needsAssessment),
        input.skipReason, rejected ? 'no' : null, rejected ? input.text : null, rejected ? identity.userId : null, rejected ? 1 : 0, cutScope, opinion.id, 'triage']
    );
    if (updated.changes !== 1) throw invalidState('这条意见已经处理，请刷新后查看');
    await work.emit(q, user, opinion.project_id, 'opinion', opinion.id, 'opinion_triaged', {
      category: input.category, status, text: input.text, needs_assessment: needsAssessment, skip_reason: input.skipReason,
      outcome: rejected ? 'no' : null, cut_scope_version_id: cutScope,
    });
    await workNotify.afterTriage(q, opinion, status);
  }

  async function assess(q, user, context, opinion, input) {
    const { identity, developer } = context;
    // 项目经理与参与方身份互斥。负责人本人可评估，项目经理代录时保留截图；平台管理员代办不要求截图，库里同记为代录（proxy），事件里另记 by_super_admin。
    const mode = assessModeOf(identity, opinionTarget(context, opinion));
    // 打开表单之后登记方式变了（比如本人不再是开发负责人，此刻只能算管理员代办）：不按新方式悄悄收下，要求重新打开（codex 296 号）。
    if (input.expectedMode !== null && input.expectedMode !== mode) throw invalidState('评估的登记方式已变化，请重新打开后核对');
    const source = mode === 'dev' ? 'dev' : 'proxy';
    const bound = await bind(q, user, opinion.project_id, 'opinion_assessment', opinion.id, input.attachmentIds);
    if (mode === 'proxy') await verifyScreenshot(q, bound);
    const updated = await q.run(
      `UPDATE sysbuild_opinions SET status = ?, assessment_text = ?, assessment_hours = ?, assessment_source = ?,
         assessed_by = ?, assessed_at = datetime('now','localtime'), assessed_for_user_id = ?, assessed_for_delegation_id = ?,
         updated_at = datetime('now','localtime') WHERE id = ? AND status = ?`,
      ['disposition', input.text, input.hours, source, identity.userId, developer?.userId ?? null, developer?.delegationId ?? null, opinion.id, 'assessment']
    );
    if (updated.changes !== 1) throw invalidState('这条意见已经处理，请刷新后查看');
    await work.emit(q, user, opinion.project_id, 'opinion', opinion.id, 'opinion_assessed', {
      text: input.text, estimated_hours: input.hours, source, developer_user_id: developer?.userId ?? null,
      developer_delegation_id: developer?.delegationId ?? null, attachment_ids: bound,
      ...(mode === 'admin' ? { by_super_admin: true } : {}),
    });
    // 开发负责人本人评估、或平台管理员代办之后，都告知 PM 去定去向；评估的人自己就是 PM 时不必告知自己（PM 代录、平台管理员兼任 PM）。
    if (!identity.isPm) await workNotify.afterDeveloperAssessment(q, opinion, context.identity.project);
  }

  const cutRowsOf = (q, opinion) => q.all('SELECT * FROM sysbuild_cut_approvals WHERE project_id = ? AND opinion_id = ? ORDER BY party_id', [opinion.project_id, opinion.id]);

  function readDisposition(body) {
    work.onlyFields(body, ['action', 'outcome', 'text']);
    if (!['now', 'next', 'no'].includes(body.outcome)) throw invalid('请选择意见去向', 'outcome');
    return { outcome: body.outcome, text: readText(body.text, 'text', '去向说明', BODY_MAX) };
  }
  function readCutDecision(body) {
    work.onlyFields(body, ['action', 'party_id', 'decision', 'text', 'expected_delegation_id']);
    if (body.decision !== 'agree' && body.decision !== 'object') throw invalid('请选择是否同意砍需求', 'decision');
    // expected_delegation_id：平台管理员代办时必带（打开表单时看到的那位负责人的授权编号）；负责人本人表态不带。
    const expected = has(body, 'expected_delegation_id') && body.expected_delegation_id !== null ? readId(body.expected_delegation_id, 'expected_delegation_id', '代办对象') : null;
    return { partyId: readId(body.party_id, 'party_id', '需求部门'), decision: body.decision, text: optionalReason(body, 'text', '表态说明'), expectedDelegationId: expected };
  }
  function readCutWithdrawal(body) {
    work.onlyFields(body, ['action', 'text']);
    return { text: readText(body.text, 'text', '撤回原因', REASON_MAX) };
  }
  async function conclude(q, user, opinion, outcome, text, adjustmentId) {
    const result = await q.run(
      `UPDATE sysbuild_opinions SET status = 'concluded', outcome = ?, outcome_text = ?, resolved_by = ?,
         resolved_at = datetime('now','localtime'), updated_at = datetime('now','localtime'), adjustment_version_id = ?
       WHERE id = ? AND status = ?`,
      [outcome, text, Number(user.id), adjustmentId, opinion.id, opinion.status]
    );
    if (result.changes !== 1) throw invalidState('这条意见已经处理，请刷新后查看');
    await work.emit(q, user, opinion.project_id, 'opinion', opinion.id, 'opinion_concluded', { outcome, text, adjustment_version_id: adjustmentId });
    await workNotify.afterConclusion(q, opinion);
  }
  async function dispose(q, user, context, opinion, input) {
    let adjustment = null;
    if (input.outcome === 'now') {
      const pid = opinion.project_id;
      let nodeId = await work.lastInProgressNode(q, pid);
      if (nodeId === null && opinion.node_id !== null) {
        const original = await q.get('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND id = ?', [pid, opinion.node_id]);
        nodeId = original?.id ?? null;
      }
      if (nodeId === null) {
        const closing = await q.get("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS NULL AND template_key = 'p_closing'", [pid]);
        nodeId = closing?.id ?? null;
      }
      if (nodeId === null) throw invalidState('找不到可挂靠任务的阶段，请刷新后重试');
      const developerId = context.developer?.userId;
      const [assignee] = developerId ? await assigneesOf(q, context.identity.project, developerId) : [];
      await createTask(q, user, pid, nodeId, { title: opinion.title, assigneeId: assignee?.id ?? context.identity.project.pm_user_id, plannedOn: null, opinionId: opinion.id });
      if (opinion.category === 'requirement') adjustment = await effectiveOverallVersionId(q, pid);
    }
    await conclude(q, user, opinion, input.outcome, input.text, adjustment);
  }
  async function cutDecision(q, user, context, opinion, input, approval) {
    // 平台管理员代办：必须带回打开表单时看到的授权编号，且与此刻的现任负责人一致；期间换了负责人就拒绝，不把表态记到他没看见的人名下。
    //   反过来，带着代办对象提交、而此刻本人已是这个部门的负责人（打开代办表单之后被任命）：表单写的是「代某人表态」，不按本人表态收下，同样拒绝。
    if (approval.responsible.userId !== context.identity.userId) {
      if (input.expectedDelegationId === null) throw invalid('代办表态须带代办对象', 'expected_delegation_id');
      if (input.expectedDelegationId !== approval.responsible.delegationId) throw invalidState('该需求部门的负责人已变更，请重新打开后核对代办对象');
    } else if (input.expectedDelegationId !== null) {
      throw invalidState('该需求部门的负责人已变更，请重新打开后核对代办对象');
    }
    const updated = await q.run(
      `UPDATE sysbuild_cut_approvals SET status = ?, decided_by = ?, delegation_id = ?, decision_text = ?, decided_at = datetime('now','localtime')
        WHERE id = ? AND status = 'pending'`,
      [input.decision, context.identity.userId, approval.responsible.delegationId, input.text, approval.row.id]
    );
    if (updated.changes !== 1) throw invalidState('该部门已作出表态，请刷新后查看');
    // 平台管理员代办：decided_by 如实记管理员，事件里另记代的是哪位负责人。
    const proxied = approval.responsible.userId !== context.identity.userId;
    await work.emit(q, user, opinion.project_id, 'opinion', opinion.id, 'opinion_cut_decided', {
      party_id: input.partyId, decision: input.decision, text: input.text,
      ...(proxied ? { by_super_admin: true, on_behalf_of_user_id: approval.responsible.userId } : {}),
    });
    // 结论文案不把代办写成负责人本人作出的（codex 290 号 HIGH）：代办不同意、或全部同意里含代办时，文案里写明。
    if (input.decision === 'object') {
      // 代办的不同意，结论里始终带代办标识：没写说明用默认句，写了说明就把说明接在标识后面。
      const proxyText = '管理员代办表态：不同意，' + (input.text ? '说明：' + input.text : '维持原范围');
      await conclude(q, user, opinion, 'scope_kept', proxied ? proxyText : (input.text || '需求方负责人不同意，维持原范围'), null);
      return;
    }
    const approvals = await cutRowsOf(q, opinion);
    if (approvals.length === 0 || !approvals.every((row) => row.status === 'agree')) return;
    const current = await effectiveOverallVersionId(q, opinion.project_id);
    if (current === null || current !== opinion.cut_scope_version_id) throw invalidState('生效范围已变化，请项目经理撤回此事项');
    let anyProxy = false;
    for (const row of approvals) anyProxy = (await cutDecidedByProxy(q, row)) || anyProxy;
    await conclude(q, user, opinion, 'cut_agreed', anyProxy ? '原范围各需求部门均已同意本期移出，其中含管理员代办的表态' : '原范围各需求部门负责人均同意本期移出', current);
  }
  async function cutWithdrawal(q, user, context, opinion, input) {
    await work.emit(q, user, opinion.project_id, 'opinion', opinion.id, 'opinion_cut_withdrawn', { text: input.text });
    await conclude(q, user, opinion, 'scope_kept', input.text, null);
  }

  const actions = {
    triage: { read: readTriage, write: triage }, assess: { read: readAssessment, write: assess },
    dispose: { read: readDisposition, write: dispose },
    cut_decide: { read: readCutDecision, write: cutDecision },
    cut_withdraw: { read: readCutWithdrawal, write: cutWithdrawal },
  };
  router.post('/sysbuild/opinions/:id/actions', parseJson, handle(async (req, res) => {
    const id = readId(req.params.id, 'id', '意见');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('请求体必须是 JSON 对象', 'body');
    const action = body.action;
    if (!has(actions, action)) throw invalid('请选择有效的意见操作', 'action');
    const { read, write } = actions[action];
    const input = read(body);
    const out = await db.withWriteTxn(async (q) => {
      const { opinion, context } = await opinionContext(q, id, req.user);
      let approval = null;
      if (action === 'cut_decide') {
        const row = (await cutRowsOf(q, opinion)).find((item) => item.party_id === input.partyId);
        const responsible = row ? await work.responsibleUser(q, opinion.project_id, row.party_id) : null;
        approval = { row, responsible };
      }
      rules.assertOp('opinion_' + action, context.identity, context.identity.project, opinionTarget(context, opinion, approval));
      await write(q, req.user, context, opinion, input, approval);
      return { opinion: await opinionDetail(q, context, await loadOpinion(q, id)) };
    });
    res.json(out);
  }));

  async function assigneesOf(q, project, userId = null) {
    const rows = await q.all(
      `SELECT u.id, u.role, COALESCE(u.display_name, u.username) AS name FROM users u
        WHERE u.status = 'active' AND (? IS NULL OR u.id = ?) AND (u.id = ? OR EXISTS
          (SELECT 1 FROM sysbuild_members m WHERE m.project_id = ? AND m.user_id = u.id AND ${rules.MEMBER_ACTIVE_SQL}))
        ORDER BY name, u.id`, [userId, userId, project.pm_user_id, project.id]
    );
    return rows.filter((row) => !rules.platformIdentity(row, accessOptions).isReadonly).map(({ id, name }) => ({ id, name }));
  }
  function planDay(value) {
    if (value === undefined || value === null || value === '') return null;
    const bad = () => invalid('请选择有效的计划完成日', 'planned_on');
    if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value)) throw bad();
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw bad();
    return value;
  }
  function taskAction(context, task) {
    const { identity } = context;
    return rules.opAllowed('work_task_result', identity, identity.project, taskTarget(task));
  }
  const taskTarget = (task) => ({ taskStatus: task.status, assigneeUserId: task.assignee_user_id });
  const taskColumnQuery = `SELECT t.*, COALESCE(u.display_name, u.username) AS assignee_name FROM sysbuild_tasks t
     LEFT JOIN users u ON u.id = t.assignee_user_id`;
  const loadTask = (q, id) => q.get(taskColumnQuery + ' WHERE t.id = ?', [id]);
  async function taskContext(q, id, user) {
    const task = await loadTask(q, id);
    if (!task) throw rules.notFound();
    return { task, context: await projectContext(q, task.project_id, user) };
  }
  async function taskDetail(q, context, task) {
    return { ...task, attachments: await work.attachmentsOf(q, task.project_id, 'work_task', task.id), actions: { write_result: taskAction(context, task) } };
  }
  async function createTask(q, user, projectId, nodeId, input) {
    const result = await q.run(
      'INSERT INTO sysbuild_tasks (project_id, node_id, source_opinion_id, title, assignee_user_id, planned_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [projectId, nodeId, input.opinionId ?? null, input.title, input.assigneeId, input.plannedOn, Number(user.id)]
    );
    await work.emit(q, user, projectId, 'work_task', result.lastID, 'work_task_created', { title: input.title, node_id: nodeId, opinion_id: input.opinionId ?? null, assignee_user_id: input.assigneeId, planned_on: input.plannedOn });
    return result.lastID;
  }

  router.get('/sysbuild/projects/:id/tasks', handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id', '项目');
    const nodeId = readId(req.query.node, 'node', '阶段', true);
    res.json(await db.withRead(async (q) => {
      const context = await projectContext(q, projectId, req.user);
      const { identity } = context;
      if (nodeId !== null && !await q.get('SELECT id FROM sysbuild_nodes WHERE id = ? AND project_id = ?', [nodeId, projectId])) throw rules.notFound();
      const tasks = await q.all(taskColumnQuery + ' WHERE t.project_id = ? AND (? IS NULL OR t.node_id = ?) ORDER BY t.id DESC', [projectId, nodeId, nodeId]);
      const canCreate = rules.opAllowed('work_task_create', identity, identity.project);
      return {
        tasks: tasks.map((t) => ({ ...t, actions: { write_result: taskAction(context, t) } })),
        assignees: canCreate ? await assigneesOf(q, identity.project) : [],
        actions: { create: canCreate },
      };
    }));
  }));
  router.get('/sysbuild/tasks/:id', handle(async (req, res) => {
    const id = readId(req.params.id, 'id', '任务');
    res.json(await db.withRead(async (q) => {
      const { task, context } = await taskContext(q, id, req.user);
      return { task: await taskDetail(q, context, task) };
    }));
  }));
  router.post('/sysbuild/nodes/:id/tasks', parseJson, handle(async (req, res) => {
    const nodeId = readId(req.params.id, 'id', '阶段');
    const body = req.body;
    work.onlyFields(body, ['title', 'assignee_user_id', 'planned_on']);
    const input = {
      title: readText(body.title, 'title', '任务标题', TITLE_MAX),
      assigneeId: readId(body.assignee_user_id, 'assignee_user_id', '任务负责人'),
      plannedOn: planDay(body.planned_on),
    };
    const user = req.user;
    const result = await db.withWriteTxn(async (q) => {
      const node = await q.get('SELECT id, project_id FROM sysbuild_nodes WHERE id = ?', [nodeId]);
      if (!node) throw rules.notFound();
      const context = await projectContext(q, node.project_id, user);
      const { identity } = context;
      rules.assertOp('work_task_create', identity, identity.project);
      if (!(await assigneesOf(q, identity.project, input.assigneeId)).length) throw invalid('任务负责人须是本项目可办理的成员或项目经理', 'assignee_user_id');
      const id = await createTask(q, user, node.project_id, nodeId, input);
      return { task: await taskDetail(q, context, await loadTask(q, id)) };
    });
    res.status(201).json(result);
  }));
  router.post('/sysbuild/tasks/:id/result', parseJson, handle(async (req, res) => {
    const id = readId(req.params.id, 'id', '任务');
    const body = req.body;
    work.onlyFields(body, ['status', 'text', 'attachment_ids']);
    if (body.status !== 'done' && body.status !== 'cancelled') throw invalid('请选择完成或取消', 'status');
    const note = optionalReason(body, 'text', body.status === 'done' ? '完成说明' : '取消原因');
    const attachmentIds = work.readAttachmentIds(body.attachment_ids);
    const user = req.user;
    const result = await db.withWriteTxn(async (q) => {
      const { task, context } = await taskContext(q, id, user);
      const { identity } = context;
      rules.assertOp('work_task_result', identity, identity.project, taskTarget(task));
      if (body.status === 'cancelled' && !note) throw invalid('取消任务须填写原因', 'text');
      const updated = await q.run(
        `UPDATE sysbuild_tasks SET status = ?, result_text = ?, resolved_by = ?, resolved_at = datetime('now','localtime')
          WHERE id = ? AND status = 'pending'`, [body.status, note, identity.userId, id]
      );
      if (updated.changes !== 1) throw invalidState('这条任务已有结果，请刷新后查看');
      const bound = await bind(q, user, task.project_id, 'work_task', id, attachmentIds);
      await work.emit(q, user, task.project_id, 'work_task', id, 'work_task_resolved', { status: body.status, text: note, attachment_ids: bound });
      return { task: await taskDetail(q, context, await loadTask(q, id)) };
    });
    res.json(result);
  }));

  return { router };
}

module.exports = { createWorkRoutes };
