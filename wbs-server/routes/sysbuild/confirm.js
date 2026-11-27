// routes/sysbuild/confirm.js — 项目管理（系统建设记录）模块：内容包提交确认 / 撤回、确认任务改发 / 浏览 / 决策、待我确认（C4a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 2–5 / 9、§4.2、§4.4、§4.5、§5.2–5.3、§6.2、§7「确认」组、§10.2–10.3。
//   派单 = docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md（P22–P29）。
//
// 工厂 createConfirmRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers }。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序（§5.3）：参数格式 400 → 对象存在 / 可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 对象状态与业务规则 409 → 决策内容校验 400（decide 按派单 P27 最后）。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp（OBJECT_OPS + OP_KIND），读接口的 actions 用 rules.opAllowed 与同一个 target 构造函数。
// 写端点全部在 withWriteTxn 内「加载 → 重核 → 写 → 写事件」；状态转移用条件 UPDATE（WHERE 带旧状态），影响行数 0 → 409。
'use strict';
const materialsCore = require('./materials-core');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { versionTarget, versionFactsOf, rewriteFormAndParent } = require('./packages');
const core = require('./confirm-core');
const entriesCore = require('./entries-core');
const notifyCore = require('./notify-core'); // C6b：改发 / 有异议 · 不认可 时写发送意图

const REASON_MAX = 500;
const DECISIONS = Object.freeze({ confirm: 'confirmed', object: 'objected', reject: 'rejected' });

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
const parseJsonOrEmpty = (text) => { try { return JSON.parse(text); } catch (_) { return {}; } };

function createConfirmRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/confirm 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/confirm 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/confirm 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') {
    throw new Error('routes/sysbuild/confirm 参数 attachmentHelpers 必须带 freezeAttachmentSet');
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      if (err.pending_work) body.pending_work = err.pending_work;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 确认接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
  });
  function readIdParam(raw, field, label) {
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }

  // ── 加载 ───────────────────────────────────────────────────────────────────────────────
  async function batchStatusOf(q, pkg) {
    if (pkg.batch_id === null) return undefined;
    const b = await q.get('SELECT status FROM sysbuild_batches WHERE id = ?', [pkg.batch_id]);
    return b ? b.status : undefined;
  }
  async function loadVersionCtx(q, vid, user) {
    const ver = await q.get(
      'SELECT id, package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json, created_by, created_at, updated_at FROM sysbuild_package_versions WHERE id = ?',
      [vid]
    );
    if (!ver) throw rules.notFound();
    const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    if (!pkg) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, pkg.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { ver, pkg, access, batchStatus: await batchStatusOf(q, pkg) };
  }
  // 提交 / 撤回的 target 用 packages.js 导出的 versionTarget（预筛 L4：与版本详情 actions 同一份，不在本文件再写一份）；提交的项目级事实
  //   （必需确认人是否齐全、立项前置）用 packages.js 的 versionFactsOf，与读接口 actions.submit 同源（修订批二 MED-1），所以对应的 409 都由 rules.assertOp 给出。

  // 任务所在对象：包版本 → status = pending 才算「待确认」。
  async function loadObject(q, task) {
    if (task.object_type === 'package_version') {
      const ver = await q.get(
        'SELECT id, package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json FROM sysbuild_package_versions WHERE id = ?',
        [task.object_version_id]
      );
      const pkg = ver ? await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]) : null;
      if (!ver || !pkg) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的内容包版本不存在');
      return { kind: 'package_version', ver, pkg, batchStatus: await batchStatusOf(q, pkg), pending: ver.status === 'pending', status: ver.status };
    }
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务的对象类型暂不支持');
  }
  async function loadTaskCtx(q, tid, user) {
    const task = await q.get('SELECT id, project_id, object_type, object_id, object_version_id, purpose, party_id, created_at FROM sysbuild_confirm_tasks WHERE id = ?', [tid]);
    if (!task) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, task.project_id, user, accessOpts());
    // 登记残余（C4a 修订批）：必需确认人被移出项目后，若他不是 admin / 只读账号，就不再是项目成员——任务详情按项目可见性对他是 404，
    //   他看不到自己曾经的任务（这是可见性规则的直接结果，不单独放行）；PM 改发后由新人处理。只读账号被移出后仍可见（见 canViewProject），会看到 actions.decide 为假。
    rules.assertVisible(access);
    const latest = await core.latestRevision(q, tid);
    if (!latest) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务没有修订');
    const mem = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [latest.required_member_id]);
    const requiredUserId = mem && mem.user_id !== null ? Number(mem.user_id) : null;
    return { task, access, latest, requiredUserId, obj: await loadObject(q, task) };
  }

  // target 构造（读写两端同一份）。decide：isRequired = 本人是当前（rev_no 最大）修订的必需确认人；请求带的 revision_id / object_version_id 只在执行端点放进去。
  async function decideTarget(q, c, user, given) {
    const isRequired = c.requiredUserId !== null && c.requiredUserId === Number(user.id);
    const loss = c.latest.status === 'pending' ? await core.qualificationLoss(q, c.latest) : null;
    const t = {
      isRequired, currentRevisionId: c.latest.id, revisionStatus: c.latest.status, objectVersionId: c.task.object_version_id, objectPending: c.obj.pending, qualificationLoss: loss,
    };
    if (given) { t.revisionIdGiven = given.revisionId; t.objectVersionIdGiven = given.objectVersionId; }
    return t;
  }
  // 改发的新必需确认人解析（读接口 actions.reissue 与执行端点共用这一个函数，预筛 L3①：标志为真则执行必 2xx）：
  //   内容包任务：按**当前**任职 / 授权重新解析（当前修订依据授权的是代表人任务，否则是负责人任务；「可作为确认人」与提交时同一判定）；解析不到、
  //   或新人在本版本、同一参与方的另一类任务上已确认（P36：同一人不能同时以负责人和代表人身份确认），返回 blocked 文案。
  async function resolveReissue(q, c) {
    if (c.task.object_type !== 'package_version') return { isDelegate: false, cur: null, blocked: null };
    const isDelegate = c.latest.basis_delegation_id !== null;
    const cur = isDelegate ? await core.currentDelegate(q, c.task.party_id) : await core.currentOwner(q, c.task.party_id);
    if (!cur) return { isDelegate, cur: null, blocked: isDelegate ? '该参与方当前没有生效负责人，请先指定人员后再改发' : '该参与方当前没有现任领导，请先指定人员后再改发' };
    if (await core.confirmedOnOtherRoleBySameUser(q, c.task, cur.memberId)) {
      return { isDelegate, cur, blocked: '同一人不能在本版本同时以领导和负责人身份确认，请调整人选或撤回后重新提交' };
    }
    return { isDelegate, cur, blocked: null };
  }
  const reissueTarget = (c, res) => ({
    objectType: c.task.object_type, objectStatus: c.obj.status, revisionStatus: c.latest.status, batchStatus: c.obj.batchStatus, reissueBlocked: res.blocked,
  });

  // ── POST /sysbuild/package-versions/:vid/submit：提交确认（P22–P24）──────────────────
  async function submitVersion(q, user, vid) {
    {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      // 权限 / 项目状态 / 对象状态 / 必需确认人齐全（P23）/ 立项前置（P37）全部在这一个 assertOp 里判（target 的项目级事实与读接口 actions.submit 同源，
      //   MED-1）。
      const facts = await versionFactsOf(q, pkg, ver, access.project);
      rules.assertOp('package_version_submit', access, access.project, versionTarget(ver, pkg, batchStatus, facts));
      const pid = pkg.project_id;
      // 必需确认人的具体名单（assertOp 已核对齐全；同一写事务内与上面的 confirmersMissing 读到的是同一状态）。
      const required = await core.resolvePackageConfirmers(q, pid, pkg.type);
      // P32（主会话 11-01 裁定）：form / parent_overall_version_id 按提交时的项目现状重算（packages.js computeFormAndParent，与建草稿版本同一个函数），
      //   与草稿存的值不同**不再 409**——草稿建好后批次数、总体规划生效情况都可能变化，重算的值才是确认对象的真实形态；不同则在 status = 'draft' 条件下回写
      //   （schema.js UPDATABLE_COLUMNS / CONDITIONAL_UPDATES 已登记 form、parent_overall_version_id；条件更新，影响行数 0 → 409），变化记进提交事件
      //   （form_from / form_to / parent_from / parent_to，只在变化时）。
      //   C5 交接（主会话 11-01 裁定）：批次需求包提交时若 parent 对应的总体版本已被替代，改为 409「请基于现行规划重建草稿」，不静默回写 parent
      //   （C4a 只开放总体规划包 / 立项包提交，批次包 parent 恒为空，这里的回写实际只作用于 form）。
      //   重算与回写（packages.js rewriteFormAndParent）；changed = 变化项（form_from / form_to / parent_from / parent_to，只在变化时）。
      const { calc, changed } = await rewriteFormAndParent(q, pkg, ver);
      const scope = facts.submissionScope;
      let snapshotText = ver.snapshot_json;
      if (pkg.type === 'initiation') {
        const snapshot = { ...scope.snapshot };
        delete snapshot.no_written_basis_reason;
        if (facts.basisDeclaration) snapshot.no_written_basis_reason = facts.basisDeclaration.reason;
        snapshotText = JSON.stringify(snapshot);
      }
      const up = await q.run("UPDATE sysbuild_package_versions SET status = 'pending', snapshot_json = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [snapshotText, vid]);
      if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      // 冻结附件集合（不变量 9）：包版本自己的附件与材料附件，同一个冻结对象（package_version, vid）。
      const opId = Number(user.id);
      const opName = core.operatorNameOf(user);
      const freezeSource = (source) => attachmentHelpers.freezeAttachmentRows(q, { objectType: 'package_version', objectVersionId: vid, ownerType: source.ownerType, ownerId: source.ownerId, operatorId: opId, operatorName: opName, projectId: pid }, source.rows);
      for (const source of scope.attachmentSources) await freezeSource(source);
      await materialsCore.freezeMaterialRows(q, { projectId: pid, versionId: vid, operatorId: opId, operatorName: opName }, scope.materials);
      const frozen = await core.frozenSetOf(q, 'package_version', vid);
      const tasks = [];
      for (const e of required.entries) {
        const t = await core.createTaskWithRevision(q, user, {
          projectId: pid, objectType: 'package_version', objectId: pkg.id, objectVersionId: vid, purpose: 'package_confirm', partyId: e.partyId,
          requiredMemberId: e.memberId, basisAppointmentId: e.appointmentId, basisDelegationId: e.delegationId,
        });
        tasks.push({ task_id: t.taskId, revision_id: t.revisionId, party_id: e.partyId, kind: e.kind, required_member_id: e.memberId });
      }
      if (Object.hasOwn(notifyCore.LEADER_CONFIRMATION_SUBJECTS, pkg.type)) {
        const confirmerUsers = new Set();
        for (const task of tasks) confirmerUsers.add(await notifyCore.userOfMember(q, task.required_member_id));
        for (const task of tasks) {
          const leader = await core.currentDemandLeaderUser(q, pid, task.party_id);
          if (leader === null || confirmerUsers.has(leader)) continue;
          await notifyCore.enqueueSendIntent(q, {
            projectId: pid, purpose: notifyCore.PURPOSES.LEADER_CONFIRMATION_NOTICE, refType: notifyCore.REF_TYPES.REVISION,
            refId: task.revision_id, recipientUserId: leader,
          });
        }
      }
      // 使用通过本次校验的三个职责计划和立项声明。
      const payload = Object.assign({
        package_id: pkg.id, type: pkg.type, version_no: ver.version_no, form: calc.form,
        task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: frozen.map((f) => f.attachment_id),
      }, changed, pkg.type === 'overall' ? { node_plans: facts.plan.entries } : {},
      facts.basisDeclaration ? { initiation_basis_event_id: facts.basisDeclaration.id } : {});
      await emit(q, user, pid, 'package_version', vid, 'package_version_submitted', payload);
      return { version: { id: vid, package_id: pkg.id, version_no: ver.version_no, status: 'pending' }, tasks, frozen_attachments: frozen };
    }
  }
  router.post('/sysbuild/package-versions/:vid/submit', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    onlyKeys(bodyOf(req), []);
    res.json(await db.withWriteTxn((q) => submitVersion(q, req.user, vid)));
  }));

  // ── POST /sysbuild/package-versions/:vid/withdraw：撤回提交（P25）────────────────────────────────────
  router.post('/sysbuild/package-versions/:vid/withdraw', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason']);
    const reason = readText(body.reason, 'reason', '撤回原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      rules.assertOp('package_version_withdraw', access, access.project, versionTarget(ver, pkg, batchStatus));
      const up = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [vid]);
      if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      const revs = await q.all(
        `SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
          WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND r.status = 'pending' ORDER BY r.id`,
        [vid]
      );
      for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);
      await emit(q, user, pkg.project_id, 'package_version', vid, 'package_version_withdrawn', {
        package_id: pkg.id, version_no: ver.version_no, reason, invalidated_revision_ids: revs.map((r) => r.id),
      });
      return { version: { id: vid, package_id: pkg.id, version_no: ver.version_no, status: 'superseded' }, invalidated_revision_ids: revs.map((r) => r.id) };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/package-versions/:vid/confirm-tasks：本版本的确认任务与当前修订 ─────────────────────────
  router.get('/sysbuild/package-versions/:vid/confirm-tasks', handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const out = await db.withRead(async (q) => {
      const { ver } = await loadVersionCtx(q, vid, req.user);
      const tasks = await q.all(
        "SELECT id, party_id, purpose FROM sysbuild_confirm_tasks WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY id",
        [vid]
      );
      const list = [];
      for (const t of tasks) {
        const cur = await core.latestRevision(q, t.id);
        const partyName = t.party_id === null ? null : await q.get('SELECT name FROM sysbuild_parties WHERE id = ?', [t.party_id]);
        list.push({
          task_id: t.id, party_id: t.party_id, purpose: t.purpose,
          current_revision: { id: cur.id, rev_no: cur.rev_no, status: cur.status, status_reason: cur.status_reason, required_member_id: cur.required_member_id },
          required_name: await entriesCore.memberNameOf(q, cur.required_member_id), party_name: partyName ? partyName.name : null,
        });
      }
      return { version: { id: ver.id, status: ver.status }, tasks: list };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/confirm-tasks/:tid/reissue：改发 / 换人（P26）────────────────────────────────────
  router.post('/sysbuild/confirm-tasks/:tid/reissue', parseJsonBody, handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason', 'revision_id']);
    const expectedRevision = body.revision_id === undefined ? null : readIdParam(body.revision_id, 'revision_id', '当前任务修订编号');
    const reason = readText(body.reason, 'reason', '改发原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadTaskCtx(q, tid, user);
      const res = await resolveReissue(q, c);
      rules.assertOp('confirm_reissue', c.access, c.access.project, reissueTarget(c, res));
      if (expectedRevision !== null && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');
      const { isDelegate, cur } = res; // 非空：assertOp 的状态判定已把「解析不到」挡在前面（reissueBlocked）
      if (c.latest.status === 'pending') await core.closePendingRevision(q, c.latest.id, 'superseded', reason);
      const revNo = c.latest.rev_no + 1;
      const ins = await q.run(
        "INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        [tid, revNo, cur.memberId, isDelegate ? null : cur.appointmentId, isDelegate ? cur.delegationId : null, Number(user.id)]
      );
      await emit(q, user, c.task.project_id, 'confirm_task', tid, 'confirm_task_reissued', {
        revision_id: ins.lastID, previous_revision_id: c.latest.id, rev_no: revNo, required_member_id: cur.memberId,
        basis_appointment_id: isDelegate ? null : cur.appointmentId, basis_delegation_id: isDelegate ? cur.delegationId : null, reason,
      });
      await notifyCore.enqueueRevisionIntent(q, { projectId: c.task.project_id, revisionId: ins.lastID, requiredMemberId: cur.memberId, reissue: true }); // C6b：改发后的必需确认人收到新的发送意图
      return { task_id: tid, revision: { id: ins.lastID, rev_no: revNo, status: 'pending', required_member_id: cur.memberId } };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/confirm-tasks/:tid：任务详情；必需确认人本人打开当前待确认修订即写一条浏览记录（P27）──────────────
  // P40（主会话 11-01 裁定，维持方案 §7「GET 打开即写浏览记录」）：C8 前端交接——任务列表与预取**不得**调用本接口（它对必需确认人本人会写浏览记录，
  //   而浏览记录是「已阅读」的证据）；只在用户真正进入确认页时调用一次。后端不为此加参数或分流。
  //   附件视图 attachmentView 已移到 confirm-core.js（C4b Q-S2 预筛 LOW-6：只一份实现）。
  const attachmentView = core.attachmentView;
  async function objectView(q, c) {
    if (c.obj.kind === 'package_version') {
      const { ver, pkg } = c.obj;
      const nodePlans = pkg.type === 'overall' ? await core.submittedNodePlans(q, pkg.project_id, ver.id) : [];
      return {
        type: 'package_version',
        package: { id: pkg.id, type: pkg.type, batch_id: pkg.batch_id },
        version: { id: ver.id, version_no: ver.version_no, form: ver.form, status: ver.status, effective_at: ver.effective_at, parent_overall_version_id: ver.parent_overall_version_id },
        snapshot_json: parseJsonOrEmpty(ver.snapshot_json),
        materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),
        node_plans: nodePlans,
      };
    }
  }
  // record = true（写事务里）才真正插浏览记录。返回 { body, shouldRecord }：shouldRecord = 本人是当前修订的必需确认人且该修订待确认。
  async function buildTaskResponse(q, tid, user, record, expectedRevision) {
    const c = await loadTaskCtx(q, tid, user);
    // C8：通知入口绑定所指修订。两次锁内均核对，尤其不能在定位后改发的竞态中写下新版浏览。
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');
    const frozen = await core.frozenSetOfTask(q, c.task); // 任务自己的冻结清单（confirm-core.frozenKeyOfTask）
    const target = await decideTarget(q, c, user, null);
    // 平台管理员代办确认同样要先有本人（管理员）的浏览记录（确认记录的 view_id 是库内约束），user_id 如实记管理员。
    //   必需确认人本人：修订待确认即写（原规则不变）。平台管理员：此刻确实可以代办（confirm_decide 整条判定通过）才写，随手打开不能代办的任务不留浏览记录。
    const shouldRecord = target.isRequired ? c.latest.status === 'pending' : rules.opAllowed('confirm_decide', c.access, c.access.project, target);
    let viewId = null;
    if (record && shouldRecord) {
      const ins = await q.run(
        "INSERT INTO sysbuild_views (user_id, object_type, object_version_id, source, frozen_attachment_set) VALUES (?, ?, ?, 'page', ?)",
        [Number(user.id), c.task.object_type, c.task.object_version_id, JSON.stringify(frozen)]
      );
      viewId = ins.lastID;
    }
    const revRows = await q.all(
      `SELECT r.id AS id, r.rev_no AS rev_no, r.required_member_id AS required_member_id, r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id,
              r.status AS status, r.status_reason AS status_reason, r.created_at AS created_at
         FROM sysbuild_confirm_task_revisions r WHERE r.task_id = ? ORDER BY r.rev_no`,
      [tid]
    );
    const party = c.task.party_id === null ? null : await q.get('SELECT name FROM sysbuild_parties WHERE id = ? AND project_id = ?', [c.task.party_id, c.task.project_id]);
    const revs = revRows.map((r) => ({
      id: r.id, rev_no: r.rev_no, required_member_id: r.required_member_id, status: r.status, status_reason: r.status_reason, created_at: r.created_at,
    }));
    for (const [index, rev] of revs.entries()) {
      rev.required_name = await entriesCore.memberNameOf(q, rev.required_member_id);
      rev.direct_assignment_role = await core.directAssignmentRole(q, c.task.project_id, c.task.party_id, revRows[index]);
    }
    const confs = await q.all(
      `SELECT c.id AS id, c.task_revision_id AS revision_id, c.decision AS decision, c.method AS method, c.actor_user_id AS actor_user_id, c.reason AS reason, c.created_at AS created_at
         FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id WHERE r.task_id = ? ORDER BY c.id`,
      [tid]
    );
    for (const cf of confs) {
      const actor = cf.actor_user_id === null ? null : await q.get('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [cf.actor_user_id]);
      cf.actor_name = actor ? actor.name : null;
      cf.by_admin_proxy = await core.confirmedByProxy(q, cf.id); // 平台管理员代办的确认：操作人不是该修订的必需确认人
    }
    const projectInfo = await q.get('SELECT id, system_name FROM sysbuild_projects WHERE id = ?', [c.task.project_id]);
    const current = revs.find((revision) => revision.id === c.latest.id);
    const body = {
      project: projectInfo,
      task: { id: c.task.id, project_id: c.task.project_id, object_type: c.task.object_type, object_id: c.task.object_id, object_version_id: c.task.object_version_id, purpose: c.task.purpose, party_id: c.task.party_id, party_name: party?.name ?? null },
      revision: {
        id: c.latest.id, rev_no: c.latest.rev_no, status: c.latest.status, status_reason: c.latest.status_reason, required_member_id: c.latest.required_member_id,
        created_at: c.latest.created_at, required_name: current.required_name, direct_assignment_role: current.direct_assignment_role,
      },
      revisions: revs,
      confirmations: confs,
      object: await objectView(q, c),
      frozen_attachments: await attachmentView(q, frozen),
      checkbox_texts: core.checkboxTextsOf(c.task.purpose), // M-3：三种决策各一条固定文案（确认 / 有异议 / 不认可），页面按所选决策显示，提交时必须逐字带回对应那一条
      allowed_decisions: Object.keys(DECISIONS),
      view_id: viewId,
      actions: {
        decide: rules.opAllowed('confirm_decide', c.access, c.access.project, target),
        decide_mode: null, // 下面按 decide 补：self = 必需确认人本人，admin = 平台管理员代办
        reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),
      },
    };
    body.actions.export_sheet = c.obj.kind === 'package_version' && rules.canExportConfirmationSheet(c.access, c.obj.ver);
    if (body.actions.decide === true) body.actions.decide_mode = target.isRequired ? 'self' : 'admin';
    return { body, shouldRecord };
  }
  // 纯读定位：rev 是通知修订号，不是task id；不调用可能写浏览记录的任务详情。
  router.get('/sysbuild/confirm-task-revisions/:rid', handle(async (req, res) => {
    const revisionId = readIdParam(req.params.rid, 'rid', '任务修订编号');
    const out = await db.withRead(async (q) => {
      const revision = await q.get('SELECT id, task_id, rev_no, status FROM sysbuild_confirm_task_revisions WHERE id = ?', [revisionId]);
      if (!revision) throw rules.notFound();
      const c = await loadTaskCtx(q, revision.task_id, req.user);
      return { revision_id: revision.id, task_id: c.task.id, project_id: c.task.project_id, rev_no: revision.rev_no, status: revision.status, is_current: revision.id === c.latest.id, current_revision_id: c.latest.id };
    });
    res.json(out);
  }));
  router.get('/sysbuild/confirm-tasks/:tid', handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const expectedRevision = req.query.revision_id === undefined ? null : readIdParam(req.query.revision_id, 'revision_id', '任务修订编号');
    const first = await db.withRead((q) => buildTaskResponse(q, tid, req.user, false, expectedRevision));
    if (!first.shouldRecord) return res.json(first.body);
    // 打开即写浏览记录：写事务里重新加载（期间状态可能变化），仍满足条件才写。
    const second = await db.withWriteTxn((q) => buildTaskResponse(q, tid, req.user, true, expectedRevision));
    return res.json(second.body);
  }));

  // ── POST /sysbuild/confirm-tasks/:tid/decide：确认 / 有异议 / 不认可（P27 / P28 / P29）───────────────────
  router.post('/sysbuild/confirm-tasks/:tid/decide', parseJsonBody, handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const body = bodyOf(req);
    onlyKeys(body, ['revision_id', 'object_version_id', 'decision', 'checkbox_text', 'reason']);
    const revisionId = readIdParam(body.revision_id, 'revision_id', '任务修订编号');
    const objectVersionId = readIdParam(body.object_version_id, 'object_version_id', '对象版本编号');
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadTaskCtx(q, tid, user);
      rules.assertOp('confirm_decide', c.access, c.access.project, await decideTarget(q, c, user, { revisionId, objectVersionId }));
      // 浏览证据：本人对该对象版本、打开时间不早于本修订创建时间的最新一条浏览记录；其冻结清单必须等于当前冻结清单。
      //   登记残余（C4a 修订批）：opened_at / created_at 都只到秒，「不早于」按秒比较——必需确认人在本修订创建的**同一秒**内之前的旧浏览（同人改发给同人、
      //   且旧浏览与新修订同秒）会被算作有效浏览。同一人被重新指定且旧浏览恰在同一秒的概率可忽略，且他仍须通过冻结清单比对；不为此加毫秒列。
      const view = await q.get(
        'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_type = ? AND object_version_id = ? AND opened_at >= ? ORDER BY id DESC LIMIT 1',
        [uid, c.task.object_type, c.task.object_version_id, c.latest.created_at]
      );
      if (!view) throw makeError(409, 'SYSBUILD_NOT_VIEWED', '请先打开并查看本版本的全部内容后再作出确认');
      const frozenNow = await core.frozenSetOfTask(q, c.task);
      const seen = parseJsonOrEmpty(view.frozen_attachment_set);
      const seenKey = Array.isArray(seen) ? core.frozenKey(seen) : null;
      if (seenKey !== core.frozenKey(frozenNow)) throw makeError(409, 'SYSBUILD_VERSION_CHANGED', '附件清单与您查看时不一致，请重新打开查看');
      // 决策内容校验（400，派单 P27 放在最后）。
      const decision = body.decision;
      if (typeof decision !== 'string' || !hasKey(DECISIONS, decision)) throw invalid('decision 必须是 confirm / object / reject 之一', 'decision');
      // 勾选文案按**所选决策**严格匹配（M-3）：用 confirm 的文案提交 reject 一样 400。
      if (body.checkbox_text !== core.checkboxTextsOf(c.task.purpose)[decision]) throw invalid('勾选文案与所选决策的固定文案不一致', 'checkbox_text');
      const reason = readText(body.reason, 'reason', '原因', REASON_MAX, decision !== 'confirm');
      const toStatus = DECISIONS[decision];
      const up = await q.run(
        "UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
        [toStatus, c.latest.id]
      );
      if (up.changes === 0) throw stateError('确认任务修订状态已变化，请刷新后重试');
      const ins = await q.run(
        "INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, reason, view_id) VALUES (?, ?, ?, ?, 'platform', ?, ?, ?, ?)",
        [c.latest.id, c.task.object_type, c.task.object_version_id, uid, decision, body.checkbox_text, reason, view.id] // 保存实际提交的文案（上面已校验与该决策的固定文案逐字相等）
      );
      // 操作人不是必需确认人本人 = 平台管理员代办（rules.confirm_decide 只放行这两种人）：确认记录的 actor_user_id 如实记管理员，事件里另记代的是谁。
      const proxied = c.requiredUserId !== uid;
      await emit(q, user, c.task.project_id, 'confirm_task', tid, 'confirmation_recorded', {
        confirmation_id: ins.lastID, revision_id: c.latest.id, object_type: c.task.object_type, object_version_id: c.task.object_version_id,
        decision, method: 'platform', view_id: view.id, reason,
        ...(proxied ? { by_super_admin: true, on_behalf_of_user_id: c.requiredUserId } : {}),
      });
      const result = { decision, revision: { id: c.latest.id, status: toStatus }, confirmation_id: ins.lastID };
      await applyDecisionEffects(q, user, c, decision, reason, ins.lastID, result);
      return result;
    });
    res.json(out);
  }));

  // 决策落库之后的对象侧效果（decide 用）；result 原地补字段。
  async function applyDecisionEffects(q, user, c, decision, reason, confirmationId, result) {
    // C6b（§9.2）：确认人在平台上作出有异议 / 不认可 → 项目 PM 收到发送意图。
    if (decision !== 'confirm') {
      await notifyCore.enqueuePmIntent(q, { projectId: c.task.project_id, purpose: notifyCore.PURPOSES.DECISION_OBJECTED, refType: notifyCore.REF_TYPES.REVISION, refId: c.latest.id, actorUserId: Number(user.id) }); // L6：作出决策的人本人就是 PM 时不写；取实际操作人（必需确认人本人，或代办的平台管理员），不取被代办的人（codex 290 号）
    }
    if (c.task.object_type === 'package_version') {
      if (decision === 'confirm') {
        const eff = await core.takeEffectIfComplete(q, user, c.task.project_id, c.obj.pkg, c.obj.ver);
        result.effective = eff.effective;
        result.superseded_version_ids = eff.superseded;
        result.baseline_node_ids = eff.baselineNodes;
        result.advanced_batch_ids = eff.advancedBatches; // M-1：合并形态总体规划包生效时由「规划中」推进到「进行中」的批次
      } else {
        result.effective = false;
      }
      result.version = { id: c.obj.ver.id, status: result.effective ? 'effective' : 'pending' };
    }
  }

  // ── GET /sysbuild/my/confirmations：我作为必需确认人的待确认修订 ────────────────────────────────────────
  //   C6b：列表取数抽成 myConfirmationItems(q, user)，GET /my/todo 的 confirm 类与顶部角标计数读同一个函数（与本端点同源，不另写第二份口径）。
  async function myConfirmationItems(q, user) {
    const uid = Number(user.id);
    {
      const rows = await q.all(
        `SELECT r.id AS revision_id, r.rev_no AS rev_no, r.created_at AS created_at, r.required_member_id AS required_member_id,
                r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id,
                t.id AS task_id, t.project_id AS project_id, t.object_type AS object_type,
                t.object_id AS object_id, t.object_version_id AS object_version_id, t.purpose AS purpose, t.party_id AS party_id, p.system_name AS system_name
           FROM sysbuild_confirm_task_revisions r
           JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
           JOIN sysbuild_members m ON m.id = r.required_member_id
           JOIN sysbuild_projects p ON p.id = t.project_id
          WHERE r.status = 'pending' AND m.user_id = ?
          ORDER BY r.id`,
        [uid]
      );
      // 只列「此刻我还能作出确认」的修订（预筛 L3②）：项目可见、项目状态允许作出推进类确认（P38：已终止 / 已结项的项目不列）、
      //   且资格复核通过——与 decide 同一个判定（core.qualificationLoss：成员已移出 / 账号停用 / 任职或授权不再生效的都不列）。
      //   C6b 修订批 1（K1）：三项判定抽成 core.confirmAvailabilityBlock，钉钉发送侧（notify.js describeRef）调同一个函数。
      const projectInfo = {};
      const items = [];
      for (const r of rows) {
        if ((await core.confirmAvailabilityBlock(q, r, user, accessOpts(), projectInfo)) !== null) continue;
        items.push({
          task_id: r.task_id, revision_id: r.revision_id, rev_no: r.rev_no, created_at: r.created_at, project_id: r.project_id, system_name: r.system_name,
          object_type: r.object_type, object_id: r.object_id, object_version_id: r.object_version_id, purpose: r.purpose, party_id: r.party_id,
        });
      }
      return items;
    }
  }
  router.get('/sysbuild/my/confirmations', handle(async (req, res) => {
    const out = await db.withRead(async (q) => ({ items: await myConfirmationItems(q, req.user) }));
    res.json(out);
  }));

  // myConfirmationItems：C6b GET /my/todo 的 confirm 类与角标计数用（与 GET /my/confirmations 同源）。
  return { router, myConfirmationItems };
}

module.exports = { createConfirmRoutes };
