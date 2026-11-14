// routes/sysbuild/changes.js — 项目管理（系统建设记录）模块：正式变更（范围变更包，C5 S-S1c）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261105_v1.4.md §2.2 不变量 2 / 10（变更包生效同时生成新的完整总体规划版本，单一来源）、§2.3、§4.1 表「正式变更」、
//   §4.2「范围变更包」、§4.4、§4.5「正式变更」与维护类同行、§7「正式变更」。派单 = docs/local/系统建设记录/送审准备/C5_S-S1c_正式变更_派单_20261106.md。
//
// 数据关系：一条 sysbuild_changes ↔ 一个 type = change 的内容包（sysbuild_changes.package_id，每条变更一个包，建变更时同一事务建包与第一版草稿）；变更包版本 = 「提议的下一版完整总体规划」：
//   建草稿时继承**当前生效的总体规划版本**（packages.createChangeDraft，不是上一版变更草稿）；之后 PM 在草稿上做集合修订（沿用 POST /package-versions/:vid/items，对变更包开放）。
// 提交 / 撤回沿用内容包的 submit / withdraw（confirm.js：POST /changes/:cid/submit、POST /package-versions/:vid/withdraw，同一事务回写 changes.status）；生效在 confirm-core.applyChangeEffect。
//   本文件：建变更、出新版本、读（单条 + 项目内列表）。工厂 createChangeRoutes(ctx) 返回 { router }，ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers }。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 → 业务规则 409 → 方向类证据 / 引用对象 400。权限 / 项目状态 / 对象状态全部经 rules.assertOp，读接口 actions 用同一判定。
'use strict';
const { attachmentStateFields } = require('./attachments');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { attachmentDisplayName } = require('./attachments');
const packages = require('./packages');
const core = require('./confirm-core');
const { assertEvidence } = require('./entries'); // 方向类证据校验：与登记 / 条目 / 改期同一口径，不再写第四份

const TITLE_MAX = 100;
const BODY_MAX = 4000;
const REASON_MAX = 500;
const AFFECTS_MAX_BYTES = 16 * 1024;
const ID_LIST_MAX = 20;

const invalid =(message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
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
// 递归检查 affects（与 snapshot_json 同款：字符串值与键名拒收控制字符、数字必须有限、深度有上限）；返回序列化文本
function checkJsonValue(v, depth) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw invalid('affects 的数字必须是有限数', 'affects');
    return;
  }
  if (typeof v === 'string') {
    if (rules.hasControlChar(v)) throw invalid('affects 的文本不能包含控制字符', 'affects');
    return;
  }
  if (v === null || typeof v !== 'object') return;
  if (depth > 32) throw invalid('affects 嵌套不能超过 32 层', 'affects');
  if (Array.isArray(v)) { for (const x of v) checkJsonValue(x, depth + 1); return; }
  for (const k of Object.keys(v)) {
    if (rules.hasControlChar(k)) throw invalid('affects 的键名不能包含控制字符', 'affects');
    checkJsonValue(v[k], depth + 1);
  }
}
const parseJsonOrEmpty = (text) => { try { return JSON.parse(text); } catch (_) { return {}; } };

function createChangeRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/changes 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/changes 参数 readonlyIds 必须是数组或 Set');
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/changes 参数 writeRoles 必须是数组或 Set');
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function') throw new Error('routes/sysbuild/changes 参数 attachmentHelpers 必须带 bindStagedAttachments');
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 正式变更接口内部错误: ${(cause && cause.message) || String(err)}`);
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

  // ── 加载与视图 ───────────────────────────────────────────────────────────────────────────────
  const CHANGE_COLS = 'id, project_id, package_id, title, body, affects_json, package_version_id, status, no_written_evidence, no_evidence_reason, created_by, created_at, updated_at';
  async function loadChangeCtx(q, cid, user) {
    const change = await q.get(`SELECT ${CHANGE_COLS} FROM sysbuild_changes WHERE id = ?`, [cid]);
    if (!change) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, change.project_id, user, accessOpts());
    rules.assertVisible(access);
    const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [change.package_id]);
    if (!pkg) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更没有对应的变更包');
    return { change, access, pkg };
  }
  const listVersions = (q, pkgId) => q.all(
    'SELECT id, version_no, status, form, parent_overall_version_id, effective_at, created_at FROM sysbuild_package_versions WHERE package_id = ? ORDER BY version_no, id', [pkgId]
  );
  async function attachmentsOfChange(q, changeId) {
    const rows = await q.all(
      `SELECT b.attachment_id AS attachment_id, a.original_name AS original_name, a.masked_at AS masked_at, a.deleted_at AS deleted_at,
              a.mime_type AS mime_type, a.size AS size, a.sha256 AS sha256, a.is_image AS is_image,
              a.masked_by AS masked_by, a.mask_reason AS mask_reason, a.deleted_by AS deleted_by,
              COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
         FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id
         LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
        WHERE b.owner_type = 'change' AND b.owner_id = ? ORDER BY b.attachment_id`,
      [changeId]
    );
    return rows.map((a) => ({
      attachment_id: a.attachment_id, masked: !!a.masked_at, deleted: !!a.deleted_at, original_name: attachmentDisplayName(a),
      mime_type: a.mime_type, size: a.size, sha256: a.sha256, is_image: a.is_image === 1,
      ...attachmentStateFields(a),
    }));
  }
  // 出新版本的前置事实（读接口 actions.new_version 与端点同一份）：待确认版本的当前修订里有 有异议 / 不认可；草稿所基于的总体规划版本已被替代。
  async function newVersionFacts(q, change, pkg, versions) {
    const pending = versions.find((v) => v.status === 'pending');
    const draft = versions.find((v) => v.status === 'draft');
    let hasObjection = false;
    if (pending) {
      const revs = await q.all(
        `SELECT r.status AS status FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id
          WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND t.purpose = 'package_confirm'
            AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id)`,
        [pending.id]
      );
      hasObjection = revs.some((r) => r.status === 'objected' || r.status === 'rejected');
    }
    let staleDraft = false;
    if (draft) staleDraft = (await packages.versionFactsOf(q, pkg, draft)).parentSuperseded === true;
    return { changeStatus: change.status, hasObjection, staleDraft };
  }
  async function changeView(q, access, change, pkg) {
    const versions = await listVersions(q, pkg.id);
    const aff = parseJsonOrEmpty(change.affects_json);
    const draft = versions.find((v) => v.status === 'draft') || null;
    const pending = versions.find((v) => v.status === 'pending') || null;
    const effective = versions.find((v) => v.status === 'effective') || null;
    const current = draft || pending || effective || (versions.length > 0 ? versions[versions.length - 1] : null);
    const actions = {
      submit: draft !== null && rules.opAllowed('package_version_submit', access, access.project, packages.versionTarget(draft, pkg, undefined, await packages.versionFactsOf(q, pkg, draft))),
      withdraw: pending !== null && rules.opAllowed('package_version_withdraw', access, access.project, packages.versionTarget(pending, pkg, undefined)),
      new_version: rules.opAllowed('change_new_version', access, access.project, await newVersionFacts(q, change, pkg, versions)),
      // 变更包版本的草稿编辑（snapshot / 集合修订）沿用内容包端点：有草稿且 PM 可改时为真
      edit_draft: draft !== null && rules.opAllowed('package_version_edit', access, access.project, packages.versionTarget(draft, pkg, undefined)),
    };
    // 确认单导出（C4c）：取最近一次提交过的版本（待确认 / 已生效 / 已被替代的提交版本）；没有提交过 = null。
    //   修订批 3 L1：「曾提交」按提交事件（package_version_submitted）判定，不按 status !== 'draft'——未提交的草稿因继承来源过期被置为 superseded 后，不算送审过
    const submittedIds = new Set();
    for (const v of versions) {
      if (await q.get("SELECT id FROM sysbuild_events WHERE object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted' LIMIT 1", [v.id])) submittedIds.add(v.id);
    }
    const submitted = [...versions].reverse().find((v) => submittedIds.has(v.id)) || null;
    return {
      id: change.id, project_id: change.project_id, package_id: change.package_id, package_version_id: change.package_version_id, title: change.title, body: change.body,
      affects: aff.affects === undefined ? {} : aff.affects, from_entry_ids: Array.isArray(aff.from_entry_ids) ? aff.from_entry_ids : [],
      status: change.status, no_written_evidence: change.no_written_evidence === 1, no_evidence_reason: change.no_evidence_reason,
      created_by: change.created_by, created_at: change.created_at, updated_at: change.updated_at,
      attachments: await attachmentsOfChange(q, change.id),
      versions, current_version: current,
      sheet_version_id: submitted ? submitted.id : null,
      actions,
    };
  }

  // ── POST /sysbuild/projects/:id/changes：建变更（同一事务建变更、变更包与第一版草稿）───────────────────────
  router.post('/sysbuild/projects/:id/changes', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['title', 'body', 'affects', 'from_entry_ids', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
    const title = readText(body.title, 'title', '变更标题', TITLE_MAX, true);
    const text = readText(body.body, 'body', '变更内容', BODY_MAX, true);
    let affects = {};
    if (body.affects !== undefined && body.affects !== null) {
      if (typeof body.affects !== 'object' || Array.isArray(body.affects)) throw invalid('affects 必须是 JSON 对象', 'affects');
      checkJsonValue(body.affects, 1);
      affects = body.affects;
    }
    const fromEntryIds = readIdList(body.from_entry_ids, 'from_entry_ids', '引用登记', ID_LIST_MAX);
    const attachmentIds = readIdList(body.attachment_ids, 'attachment_ids', '附件编号', ID_LIST_MAX);
    if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
    const ev = { noEvidence: body.no_written_evidence === true, noEvidenceReason: readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', REASON_MAX, false) };
    const affectsJson = JSON.stringify({ affects, from_entry_ids: fromEntryIds });
    if (Buffer.byteLength(affectsJson, 'utf8') > AFFECTS_MAX_BYTES) throw invalid(`affects 序列化后不能超过 ${AFFECTS_MAX_BYTES / 1024}KB`, 'affects');
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
      rules.assertVisible(access);
      // 前提：总体规划已有生效版本（否则直接修改总体规划草稿）；与读接口 actions.create_change 同一判定
      rules.assertOp('change_create', access, access.project, { overallEffective: (await packages.effectiveOverallVersionId(q, pid)) !== null });
      // 方向类证据（附件，或「无书面证据」+ 原因 ≥ 10 字）与引用登记（本项目办理类登记）：400
      assertEvidence(attachmentIds.length, ev, 'direction');
      for (const eid of fromEntryIds) {
        const e = await q.get('SELECT id, type FROM sysbuild_entries WHERE id = ? AND project_id = ?', [eid, pid]);
        if (!e || !rules.ENTRY_HANDLED_TYPES.includes(e.type)) throw invalid('引用的登记不存在、不属于本项目，或不是意见与反馈 / 问题与处理', 'from_entry_ids');
      }
      const pk = await q.run("INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, NULL, 'change', ?)", [pid, uid]);
      await emit(q, user, pid, 'package', pk.lastID, 'package_created', { type: 'change', batch_id: null });
      const ins = await q.run(
        `INSERT INTO sysbuild_changes (project_id, package_id, title, body, affects_json, status, no_written_evidence, no_evidence_reason, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [pid, pk.lastID, title, text, affectsJson, ev.noEvidence ? 1 : 0, ev.noEvidence ? ev.noEvidenceReason : null, uid]
      );
      const cid = ins.lastID;
      const bound = attachmentIds.length > 0
        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid, userId: uid, attachmentIds, ownerType: 'change', ownerId: cid, operatorName: core.operatorNameOf(user) })
        : [];
      const pkg = { id: pk.lastID, project_id: pid, batch_id: null, type: 'change' };
      const draft = await packages.createChangeDraft(q, user, pkg);
      await emit(q, user, pid, 'change', cid, 'change_created', {
        change_id: cid, package_id: pk.lastID, version_id: draft.id, title, from_entry_ids: fromEntryIds, attachment_ids: bound, no_written_evidence: ev.noEvidence,
        inherited_overall_version_id: draft.parent, copied_items: draft.copied,
      });
      const row = await q.get(`SELECT ${CHANGE_COLS} FROM sysbuild_changes WHERE id = ?`, [cid]);
      return { change: await changeView(q, access, row, pkg), version: { id: draft.id, version_no: draft.version_no, status: 'draft', parent_overall_version_id: draft.parent, copied_items: draft.copied } };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/changes/:cid/new-version：出新版本（有异议后重建草稿 / 草稿基于的总体规划已被替代时重建）──────────
  //   同一事务：旧版本（待确认 / 过期草稿）退位为 superseded（待确认修订 → 已失效，原因 = 出新版本的说明），changes.status 回到 draft（待确认时），建新草稿——继承**当前生效的总体规划版本**。
  router.post('/sysbuild/changes/:cid/new-version', parseJsonBody, handle(async (req, res) => {
    const cid = readIdParam(req.params.cid, 'cid', '变更编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason']);
    const reason = readText(body.reason, 'reason', '出新版本的说明', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { change, access, pkg } = await loadChangeCtx(q, cid, user);
      const versions = await listVersions(q, pkg.id);
      rules.assertOp('change_new_version', access, access.project, await newVersionFacts(q, change, pkg, versions));
      const pending = versions.find((v) => v.status === 'pending');
      const draft = versions.find((v) => v.status === 'draft');
      const old = pending || draft; // assertOp 已保证：待确认且有异议、或草稿过期，二者之一
      if (!old) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：出新版本时找不到要退位的版本');
      const up = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = ?", [old.id, old.status]);
      if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      let closed = [];
      if (pending) {
        const revs = await q.all(
          `SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
            WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND r.status = 'pending' ORDER BY r.id`,
          [old.id]
        );
        for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);
        closed = revs.map((r) => r.id);
        const cu = await q.run("UPDATE sysbuild_changes SET status = 'draft', package_version_id = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [change.id]);
        if (cu.changes === 0) throw stateError('变更状态已变化，请刷新后重试');
      } else {
        await q.run("UPDATE sysbuild_changes SET updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [change.id]);
      }
      const nv = await packages.createChangeDraft(q, user, pkg);
      await emit(q, user, pkg.project_id, 'change', change.id, 'change_new_version', {
        change_id: change.id, from_version_id: old.id, from_status: old.status, new_version_id: nv.id, version_no: nv.version_no, reason,
        inherited_overall_version_id: nv.parent, invalidated_revision_ids: closed,
      });
      const row = await q.get(`SELECT ${CHANGE_COLS} FROM sysbuild_changes WHERE id = ?`, [change.id]);
      return { change: await changeView(q, access, row, pkg), version: { id: nv.id, version_no: nv.version_no, status: 'draft', parent_overall_version_id: nv.parent, copied_items: nv.copied }, invalidated_revision_ids: closed };
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/changes/:cid、GET /sysbuild/projects/:id/changes ───────────────────────────────────
  router.get('/sysbuild/changes/:cid', handle(async (req, res) => {
    const cid = readIdParam(req.params.cid, 'cid', '变更编号');
    const out = await db.withRead(async (q) => {
      const { change, access, pkg } = await loadChangeCtx(q, cid, req.user);
      return { change: await changeView(q, access, change, pkg) };
    });
    res.json(out);
  }));
  router.get('/sysbuild/projects/:id/changes', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead(async (q) => {
      const access = await rules.loadProjectAccess(q, pid, req.user, accessOpts());
      rules.assertVisible(access);
      const rows = await q.all(`SELECT ${CHANGE_COLS} FROM sysbuild_changes WHERE project_id = ? ORDER BY id DESC`, [pid]);
      const changes = [];
      for (const ch of rows) {
        const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ch.package_id]);
        if (!pkg) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更没有对应的变更包');
        changes.push(await changeView(q, access, ch, pkg));
      }
      return {
        project_id: pid, changes,
        actions: { create_change: rules.opAllowed('change_create', access, access.project, { overallEffective: (await packages.effectiveOverallVersionId(q, pid)) !== null }) },
      };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createChangeRoutes };
