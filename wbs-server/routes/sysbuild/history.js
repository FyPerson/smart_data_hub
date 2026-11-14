// routes/sysbuild/history.js — 项目管理（系统建设记录）模块：「历史补录中」时间窗、历史补录、历史事实导入（C4b Q-S2）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261102_v1.3.md §4.2（历史补录、历史事实导入、冲突检查）、§4.5、§5.2、§6.2、§7「确认」组。
//   派单 = docs/local/系统建设记录/送审准备/C4b_Q-S2_时间窗历史补录导入_派单_20261104.md；锚点 Q3（Q-D2 / Q-D3）与 Q9（P51–P58）。
//
// 工厂 createHistoryRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider?, recheckOverallSet, loadPlanData }
//   recheckOverallSet = confirm.js 提交确认用的条目集合重核（P24）；loadPlanData = plan.js 收口端点用的取数（P57）——历史导入复用它们，不复制。
// 检查顺序（§5.3）：400 参数形态 → 404 项目不存在 / 不可见 → 403 动作权限 → 409 项目状态 / 窗口 / 对象要求与冲突 → 400 日期范围与附件可用性。
// 写端点全部在 withWriteTxn 内「加载 → 重核 → 写 → 写事件」，冲突检查与写入同事务（方案 08-R M-2）；状态转移 UPDATE 带旧状态条件并核影响行数（0 → 409）。
// 三个窗口动作的凭据附件以 owner_type = event 绑定在对应事件行上；历史补录凭据 owner_type = confirmation，历史导入凭据 owner_type = history_import。
'use strict';
const express = require('express');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const membership = require('./membership');
const packages = require('./packages');
const materialsCore = require('./materials-core');
const { closeBlockers, closePackageRequirement, deriveSchedule } = require('./plan');
const goliveCore = require('./golive-core'); // C6a：上线事件导入（与普通上线共用 recordGolive / handoverViewOf）

const REASON_MAX = 500;
const DECISIONS = Object.freeze(['confirm', 'object', 'reject']);
const HISTORY_OBJECT_TYPES = Object.freeze(['package_version', 'item_version']); // P52：第一期只收内容包版本与条目版本
const HISTORY_IMPORT_PACKAGE_TYPES = Object.freeze(['overall', 'initiation']); // P55：可历史生效导入的包类型（预筛 M1：不读「可提交类型」清单）
const IMPORT_KEYS = Object.freeze(['fact_type', 'object_id', 'actual_confirmer', 'identity_basis', 'original_date', 'attachment_ids']);
const NOT_IN_PROJECT = '对象不存在或不属于本项目';
// 历史导入各类事实对应的 history_imports.object_type
const FACT_OBJECT_TYPE = Object.freeze({ appointment: 'appointment', delegation: 'delegation', package_effective: 'package_version', node_closed: 'node', golive: 'batch' });
const WINDOW_ACTIONS = Object.freeze({
  open: Object.freeze({ op: 'history_window_open', to: 'open', event: 'history_window_opened' }),
  close: Object.freeze({ op: 'history_window_close', to: 'closed', event: 'history_window_closed' }),
  reopen: Object.freeze({ op: 'history_window_reopen', to: 'open', event: 'history_window_reopened' }),
});

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
// 可选文本（reason）：缺省 / 空白 → null（required 时 400）；非文本 / 控制字符 / 超长 400
function readReason(raw, label, required) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw invalid(`${label}必填`, 'reason');
    return null;
  }
  return core.readProxyText(raw, 'reason', label, REASON_MAX);
}
const dayStart = (date) => `${date} 00:00:00`; // P54：生效 / 收口时刻写原日期 00:00:00
function operatorNameOf(user) {
  return core.operatorNameOf(user);
}

function createHistoryRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/history 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/history 参数 readonlyIds 必须是数组或 Set');
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/history 参数 writeRoles 必须是数组或 Set');
  if (typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function' || typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') {
    throw new Error('routes/sysbuild/history 参数 attachmentHelpers 必须带 bindStagedAttachments / freezeAttachmentSet');
  }
  for (const k of ['recheckOverallSet', 'loadPlanData']) {
    if (typeof ctx[k] !== 'function') throw new Error('routes/sysbuild/history 缺参数: ' + k);
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
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 历史补录接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: operatorNameOf(user),
  });
  function readIdParam(raw, field, label) {
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }
  async function visibleAccess(q, pid, user) {
    const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
    rules.assertVisible(access);
    return access;
  }
  async function windowOf(q, pid) {
    const r = await q.get('SELECT history_window FROM sysbuild_projects WHERE id = ?', [pid]);
    if (!r) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：项目不存在');
    return r.history_window;
  }

  // 重开冲突检查（P67）：本项目任何「有历史导入或历史补录记录的对象」上，对象仍待确认 / 待接受 → 返回列出对象的文案，否则 null。
  //   「对象仍待确认」按对象本身的状态判，不按任务修订的状态判（预筛 LOW-1：当前修订变为 objected / rejected / invalid 时对象仍卡在待确认，窗口关闭期间的处理也只有改发 / 撤回 / 代录三条路）：
  //   内容包版本 = 版本 status = 'pending'（且有确认任务）；条目版本 = proposer_status = 'pending' 且有提出人任务，并且是该条目的最新版本（按 version_no 取最大，
  //   与 confirm.js resolveReissue 同口径）（旧版本的提出人修订已被替代，proposer_status 仍留 pending，但它不再待确认，列出它会让重开永远过不去）；任职 / 授权保持按行判。
  //   内容包、条目按对象（该包 / 该条目任一版本有历史记录，与 P58 互斥同口径）。开启（never → open）时尚无历史记录，不需要检查。
  async function reopenBlockOf(q, pid) {
    const objs = [];
    const pk = await q.all(
      `SELECT DISTINCT v.id AS id FROM sysbuild_confirm_tasks t
         JOIN sysbuild_package_versions v ON v.id = t.object_version_id AND v.status = 'pending'
        WHERE t.project_id = ? AND t.object_type = 'package_version'
          AND (EXISTS (SELECT 1 FROM sysbuild_history_imports h JOIN sysbuild_package_versions v2 ON v2.id = h.object_id WHERE h.object_type = 'package_version' AND v2.package_id = v.package_id)
            OR EXISTS (SELECT 1 FROM sysbuild_confirmations c JOIN sysbuild_package_versions v3 ON v3.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'package_version' AND v3.package_id = v.package_id))
        ORDER BY v.id`,
      [pid]
    );
    for (const r of pk) objs.push(`内容包版本 #${r.id}（有待确认的任务）`);
    // 修订批 3 L7（codex 26）：变更包的「有历史记录」对象 = 自身 ∪ 总体规划包（confirm-core.historyPackageIdsOf，与 P58 互斥同一来源）——变更生效会替换总体规划包的生效版本，
    //   所以总体规划包有历史记录时，待确认的变更版本同样拦重开（上面的查询只看包自身，对变更包漏掉总体规划包那一半）。上面已列出的版本不重复列。
    const listedPk = new Set(pk.map((r) => r.id));
    const chg = await q.all(
      `SELECT DISTINCT cv.id AS id, cv.package_id AS package_id FROM sysbuild_package_versions cv
         JOIN sysbuild_packages cp ON cp.id = cv.package_id JOIN sysbuild_confirm_tasks ct ON ct.object_version_id = cv.id
        WHERE cv.status = 'pending' AND cp.project_id = ? AND cp.type = 'change' AND ct.object_type = 'package_version' ORDER BY cv.id`,
      [pid]
    );
    for (const r of chg) {
      if (listedPk.has(r.id)) continue;
      const ids = await core.historyPackageIdsOf(q, { id: r.package_id, type: 'change', project_id: pid });
      const marks = ids.map(() => '?').join(', ');
      const hist = (await q.get(`SELECT h.id AS id FROM sysbuild_history_imports h JOIN sysbuild_package_versions hv ON hv.id = h.object_id WHERE h.object_type = 'package_version' AND hv.package_id IN (${marks}) LIMIT 1`, ids))
        || (await q.get(`SELECT c.id AS id FROM sysbuild_confirmations c JOIN sysbuild_package_versions cfv ON cfv.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'package_version' AND cfv.package_id IN (${marks}) LIMIT 1`, ids));
      if (hist) objs.push(`内容包版本 #${r.id}（有待确认的任务）`);
    }
    const it = await q.all(
      `SELECT DISTINCT iv.id AS id FROM sysbuild_confirm_tasks t
         JOIN sysbuild_item_versions iv ON iv.id = t.object_version_id AND iv.proposer_status = 'pending'
        WHERE t.project_id = ? AND t.object_type = 'item_version'
          AND iv.version_no = (SELECT MAX(iv9.version_no) FROM sysbuild_item_versions iv9 WHERE iv9.item_id = iv.item_id)
          AND EXISTS (SELECT 1 FROM sysbuild_confirmations c JOIN sysbuild_item_versions iv2 ON iv2.id = c.object_version_id WHERE c.method = 'history' AND c.object_type = 'item_version' AND iv2.item_id = iv.item_id)
        ORDER BY iv.id`,
      [pid]
    );
    for (const r of it) objs.push(`条目版本 #${r.id}（提出人确认待处理）`);
    const ap = await q.all(
      `SELECT a.id AS id FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id
        WHERE p.project_id = ? AND a.status = 'pending' AND EXISTS (SELECT 1 FROM sysbuild_history_imports h WHERE h.object_type = 'appointment' AND h.object_id = a.id) ORDER BY a.id`,
      [pid]
    );
    for (const r of ap) objs.push(`任职 #${r.id}（待接受）`);
    const dg = await q.all(
      `SELECT d.id AS id FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id
        WHERE p.project_id = ? AND d.status IN ('pending_owner', 'pending_accept') AND EXISTS (SELECT 1 FROM sysbuild_history_imports h WHERE h.object_type = 'delegation' AND h.object_id = d.id) ORDER BY d.id`,
      [pid]
    );
    for (const r of dg) objs.push(`授权 #${r.id}（待处理）`);
    return objs.length === 0 ? null : `以下对象已有历史记录，且仍有待处理的当前任务 / 待接受项，请先处理（改发、撤回或等待确认）后再重开：${objs.join('、')}`;
  }

  // 历史窗口操作的事实与原始凭据，按项目可见授权；不泛化返回任意事件payload。
  router.get('/sysbuild/projects/:id/history-window/events', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead(async (q) => {
      const access = await visibleAccess(q, pid, req.user);
      const project = await q.get('SELECT id, status, pm_user_id, history_window FROM sysbuild_projects WHERE id = ?', [pid]);
      const rows = await q.all("SELECT id, event_type, payload_json, operator_id, operator_name, created_at FROM sysbuild_events WHERE project_id = ? AND event_type IN ('history_window_opened', 'history_window_closed', 'history_window_reopened') ORDER BY id DESC", [pid]);
      const items = [];
      for (const row of rows) {
        const value = row.payload_json === null ? {} : JSON.parse(row.payload_json);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw makeError(500, 'SYSBUILD_INTERNAL', '历史窗口事件格式不正确');
        const bound = await q.all("SELECT b.attachment_id AS attachment_id, a.sha256 AS sha256 FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id WHERE b.owner_type = 'event' AND b.owner_id = ? ORDER BY b.attachment_id", [row.id]);
        items.push({ event_id: row.id, action: row.event_type === 'history_window_opened' ? 'open' : row.event_type === 'history_window_closed' ? 'close' : 'reopen', from: typeof value.from === 'string' ? value.from : null, to: typeof value.to === 'string' ? value.to : null, reason: typeof value.reason === 'string' ? value.reason : null, operator_id: row.operator_id, operator_name: row.operator_name, created_at: row.created_at, attachments: await core.attachmentView(q, bound) });
      }
      const target = { historyWindow: project.history_window };
      const canImport = rules.opAllowed('history_fact_import', access, project, target);
      return { project_id: pid, history_window: project.history_window, items,
        actions: { open: rules.opAllowed('history_window_open', access, project, target), close: rules.opAllowed('history_window_close', access, project, target), reopen: rules.opAllowed('history_window_reopen', access, project, { historyWindow: project.history_window, projectLevel: true }), confirm: rules.opAllowed('history_confirmation_record', access, project, target), import: canImport, import_golive: canImport && rules.goliveImportProjectBlock(project.status) === null },
        options: { fact_types: schema.ENUMS.historyFactType, import_package_types: HISTORY_IMPORT_PACKAGE_TYPES, confirmation_object_types: HISTORY_OBJECT_TYPES, decisions: DECISIONS },
      };
    });
    res.json(out);
  }));
  // ── POST /sysbuild/projects/:id/history-window：开启 / 关闭 / 重开「历史补录中」──────────────────────────
  // open：never → open，本项目 PM；close：open → closed，本项目 PM；reopen：closed → open，admin 且必须写原因（P51）。
  //   三个动作都写事件并把凭据附件（至少 1 个）以 owner_type = event 绑定在该事件行上。开启 / 重开受项目状态限制（已终止 / 已结项 409，history_import 类别）；
  //   关闭不受项目状态限制（P67，history_close 类别：已终止 / 已结项也能关，关闭只收窄能力）；重开另做冲突检查（reopenBlockOf，P67）。
  router.post('/sysbuild/projects/:id/history-window', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['action', 'reason', 'attachment_ids']);
    const action = typeof body.action === 'string' && hasKey(WINDOW_ACTIONS, body.action) ? body.action : null;
    if (action === null) throw invalid('action 必须是 open / close / reopen 之一', 'action');
    const reason = readReason(body.reason, '重开原因', action === 'reopen');
    const attachmentIds = core.readEvidenceAttachmentIds(body.attachment_ids, '时间窗动作');
    const act = WINDOW_ACTIONS[action];
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const access = await visibleAccess(q, pid, user);
      const cur = await windowOf(q, pid);
      // 重开另做冲突检查（P67）：先过一次项目级判定（权限 / 项目状态 / 窗口状态），再现查冲突，非 admin 不借冲突提示探测对象
      rules.assertOp(act.op, access, access.project, action === 'reopen' ? { historyWindow: cur, projectLevel: true } : { historyWindow: cur });
      if (action === 'reopen') rules.assertOp(act.op, access, access.project, { historyWindow: cur, reopenBlock: await reopenBlockOf(q, pid) });
      const up = await q.run(
        "UPDATE sysbuild_projects SET history_window = ?, updated_at = datetime('now','localtime') WHERE id = ? AND history_window = ?",
        [act.to, pid, cur]
      );
      if (up.changes === 0) throw stateError('历史补录窗口状态已变化，请刷新后重试');
      const ev = await emit(q, user, pid, 'project', pid, act.event, { from: cur, to: act.to, reason });
      const bound = await attachmentHelpers.bindStagedAttachments(q, {
        projectId: pid, userId: uid, attachmentIds, ownerType: 'event', ownerId: ev.lastID, operatorName: operatorNameOf(user),
      });
      const row = await q.get('SELECT id, status, pm_user_id, history_window FROM sysbuild_projects WHERE id = ?', [pid]);
      return {
        history_window: row.history_window, event_id: ev.lastID, attachment_ids: bound,
        actions: {
          open: rules.opAllowed('history_window_open', access, row, { historyWindow: row.history_window }),
          close: rules.opAllowed('history_window_close', access, row, { historyWindow: row.history_window }),
          reopen: rules.opAllowed('history_window_reopen', access, row, { historyWindow: row.history_window, projectLevel: true }),
        },
      };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/history-confirmations：历史补录 ───────────────────────────────────────
  // 窗口 open（Q-D2）、本项目 PM、项目进行中或已暂停；只记录已经发生的确认事实（method = history，不挂任务修订，proxy_by = 当前用户），
  //   **不改任何状态**（P53）：不改修订、不改提出人状态、不触发生效，当前待确认任务照旧等当前必需确认人。
  //   外部日期只要求不晚于今天，**没有下限**（P63：对象版本是 3002 切换当天在平台新建的，创建日做下限会挡住全部历史日期；与历史导入 P54 一致）。
  //   P66：内容包版本须已提交过（不是草稿，草稿 409）；条目版本在同一事务里冻结其附件清单（不变量 9，已冻结则跳过）。
  router.post('/sysbuild/projects/:id/history-confirmations', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['object_type', 'object_version_id', 'decision', 'reason', ...core.PROXY_KEYS]);
    const objectType = typeof body.object_type === 'string' && HISTORY_OBJECT_TYPES.includes(body.object_type) ? body.object_type : null;
    if (objectType === null) throw invalid('历史补录第一期只收内容包版本（package_version）与条目版本（item_version）', 'object_type');
    const objectVersionId = readIdParam(body.object_version_id, 'object_version_id', '对象版本编号');
    const decision = typeof body.decision === 'string' && DECISIONS.includes(body.decision) ? body.decision : null;
    if (decision === null) throw invalid('decision 必须是 confirm / object / reject 之一', 'decision');
    const reason = readReason(body.reason, '原因说明', decision !== 'confirm');
    const evidence = core.readProxyEvidence(body, '历史补录');
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const access = await visibleAccess(q, pid, user);
      rules.assertOp('history_confirmation_record', access, access.project, { historyWindow: await windowOf(q, pid) });
      const obj = objectType === 'package_version'
        ? await q.get('SELECT v.status AS status FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE v.id = ? AND p.project_id = ?', [objectVersionId, pid])
        : await q.get('SELECT iv.id AS id FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ? AND it.project_id = ?', [objectVersionId, pid]);
      if (!obj) throw stateError(NOT_IN_PROJECT);
      // P66：草稿内容包版本还没提交过，没有可对应的历史确认（历史确认的对象是一个已提交 / 已生效 / 已被替代的版本）
      if (objectType === 'package_version' && obj.status === 'draft') throw stateError('草稿版本不能补录历史确认，请先让内容包版本进入提交流程或导入历史生效');
      core.assertProxyDate(evidence.externalDate, core.NO_DATE_FLOOR, today());
      // P66：条目版本补录时冻结其附件清单（不变量 9：被确认引用的附件不能再普通软删除）；已冻结（提出人任务生成时）则跳过
      if (objectType === 'item_version') {
        const frozen = await q.get("SELECT id FROM sysbuild_frozen_attachments WHERE object_type = 'item_version' AND object_version_id = ? LIMIT 1", [objectVersionId]);
        if (!frozen) {
          await attachmentHelpers.freezeAttachmentSet(q, {
            objectType: 'item_version', objectVersionId, ownerType: 'item_version', ownerId: objectVersionId, operatorId: uid, operatorName: operatorNameOf(user), projectId: pid,
          });
        }
      }
      const rec = await core.recordProxyConfirmation(q, user, attachmentHelpers, {
        method: 'history', projectId: pid, taskId: null, revisionId: null, objectType, objectVersionId, requiredMemberId: null, actorUserId: null, decision, reason, evidence,
      });
      return {
        confirmation: { id: rec.confirmationId, method: 'history', label: '历史补录', object_type: objectType, object_version_id: objectVersionId, decision, external_date: evidence.externalDate },
        attachment_ids: rec.attachmentIds,
      };
    });
    res.status(201).json(out);
  }));

  // 读：本项目的历史补录记录（可按 object_type + object_version_id 过滤）与历史导入记录；项目可见即可读
  router.get('/sysbuild/projects/:id/history-confirmations', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead(async (q) => {
      await visibleAccess(q, pid, req.user);
      const ot = req.query.object_type;
      const ov = req.query.object_version_id;
      if (ot !== undefined || ov !== undefined) {
        if (typeof ot !== 'string' || !HISTORY_OBJECT_TYPES.includes(ot)) throw invalid('object_type 不合法', 'object_type');
        const vid = readIdParam(ov, 'object_version_id', '对象版本编号');
        // H1（codex 22 号）：按对象版本编号读之前先核版本属路径项目（与写端点同口径 409，不存在与属别的项目同一文案，不让人探测别的项目的对象）；
        //   historyConfirmationsOf 内部另按项目限定查询（第二层）
        const owned = ot === 'package_version'
          ? await q.get('SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE v.id = ? AND p.project_id = ?', [vid, pid])
          : await q.get('SELECT iv.id AS id FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ? AND it.project_id = ?', [vid, pid]);
        if (!owned) throw stateError(NOT_IN_PROJECT);
        return { history_confirmations: await core.historyConfirmationsOf(q, pid, ot, vid) };
      }
      const rows = [];
      for (const t of HISTORY_OBJECT_TYPES) {
        const ids = t === 'package_version'
          ? await q.all('SELECT DISTINCT c.object_version_id AS id FROM sysbuild_confirmations c JOIN sysbuild_package_versions v ON v.id = c.object_version_id JOIN sysbuild_packages p ON p.id = v.package_id WHERE c.method = \'history\' AND c.object_type = ? AND p.project_id = ? ORDER BY 1', [t, pid])
          : await q.all('SELECT DISTINCT c.object_version_id AS id FROM sysbuild_confirmations c JOIN sysbuild_item_versions iv ON iv.id = c.object_version_id JOIN sysbuild_items it ON it.id = iv.item_id WHERE c.method = \'history\' AND c.object_type = ? AND it.project_id = ? ORDER BY 1', [t, pid]);
        for (const r of ids) rows.push(...await core.historyConfirmationsOf(q, pid, t, r.id));
      }
      return { history_confirmations: rows };
    });
    res.json(out);
  }));
  router.get('/sysbuild/projects/:id/history-imports', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead(async (q) => {
      await visibleAccess(q, pid, req.user);
      const rows = await q.all('SELECT DISTINCT object_type, object_id FROM sysbuild_history_imports WHERE project_id = ? ORDER BY object_type, object_id', [pid]);
      const list = [];
      for (const r of rows) list.push(...await core.historyImportsOf(q, pid, r.object_type, r.object_id));
      return { history_imports: list };
    });
    res.json(out);
  }));

  // 目标成员的账号是不是本项目当前 PM（同事务现读 pm_user_id；项目读不到按内部错误，不当作「不是」）
  async function isPmUserOf(q, pid, userId) {
    const pr = await q.get('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid]);
    if (!pr) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：项目不存在');
    return core.isProjectPmUser(userId, pr.pm_user_id);
  }
  // ── 历史事实导入：各类对象要求与冲突（读库，返回 { block, data }；block = 409 文案或 null）──────────────────────
  //   date = 请求的原日期：P68 起历史日期不得与平台上已发生的普通步骤、已导入事实自相矛盾，各类加载函数按对象核对（409，文案写明冲突对象与日期）。
  async function loadAppointmentFact(q, pid, id, date) {
    const a = await q.get(
      `SELECT a.id AS id, a.party_id AS party_id, a.member_id AS member_id, a.status AS status, p.project_id AS project_id, m.joined_at AS joined_at, m.removed_at AS removed_at, m.user_id AS user_id
         FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id JOIN sysbuild_members m ON m.id = a.member_id WHERE a.id = ?`,
      [id]
    );
    if (!a || a.project_id !== pid) return { block: NOT_IN_PROJECT };
    if (a.status !== 'pending') return { block: '只有待接受的任职提议可以导入历史生效' };
    if (a.removed_at !== null || a.joined_at === null) return { block: '该成员已移出或尚未加入本项目，不能导入任职' };
    // H2（codex 22 号）纵深防御：正常路径在更换 PM 时被 rules.pmClash 拦住（待接受任职 / 待处理授权都算 pending proposal），这里防直接写库或以后的改动；
    //   与普通入口（提议 / 邀请重核）「PM 不得兼任参与方负责人」同一判定，导入时同事务重核；无账号成员（user_id 为空）照常支持
    if (await isPmUserOf(q, pid, a.user_id)) return { block: 'PM 不得兼任参与方负责人，该成员已是本项目 PM，不能导入任职' };
    const cur = await q.get("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active' LIMIT 1", [a.party_id]);
    if (cur) return { block: '该参与方已有现任负责人，历史任职不能覆盖当前生效状态' };
    // P68 ③：本方已有结束日期晚于原日期的任职 → 不能导入比已结束任期更早的「现任」
    const ended = await q.get("SELECT ended_at FROM sysbuild_appointments WHERE party_id = ? AND status = 'ended' AND substr(ended_at, 1, 10) > ? ORDER BY ended_at DESC LIMIT 1", [a.party_id, date]);
    if (ended) return { block: `该参与方已有于 ${String(ended.ended_at).slice(0, 10)} 结束的任职，不能导入比它更早（${date}）生效的现任` };
    // P70：原日期与本方已结束任职的结束日同一天时，生效时刻取那条的 ended_at（不写 00:00:00，避免同日任期重叠 / 倒挂）；比较仍按日
    const sameDay = await q.get("SELECT ended_at FROM sysbuild_appointments WHERE party_id = ? AND status = 'ended' AND substr(ended_at, 1, 10) = ? ORDER BY ended_at DESC LIMIT 1", [a.party_id, date]);
    // P65：有账号成员的待接受任职带一条待接受的邀请——导入时在同一事务里把它置为已撤回（applyAppointment），不再要求先撤回
    return { block: null, data: Object.assign({}, a, { sameDayAt: sameDay ? sameDay.ended_at : null }) };
  }
  async function loadDelegationFact(q, pid, id, date) {
    const d = await q.get(
      `SELECT d.id AS id, d.party_id AS party_id, d.member_id AS member_id, d.appointment_id AS appointment_id, d.status AS status, p.project_id AS project_id,
              m.joined_at AS joined_at, m.removed_at AS removed_at, m.user_id AS user_id, (SELECT ap.status FROM sysbuild_appointments ap WHERE ap.id = d.appointment_id) AS appointment_status,
              (SELECT ap.effective_at FROM sysbuild_appointments ap WHERE ap.id = d.appointment_id) AS appointment_effective_at
         FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id JOIN sysbuild_members m ON m.id = d.member_id WHERE d.id = ?`,
      [id]
    );
    if (!d || d.project_id !== pid) return { block: NOT_IN_PROJECT };
    if (d.status !== 'pending_owner' && d.status !== 'pending_accept') return { block: '只有待处理的授权提议可以导入历史生效' };
    if (d.appointment_status !== 'active') return { block: '授权所依据的负责人任职不是现任，不能导入授权' };
    if (d.removed_at !== null || d.joined_at === null) return { block: '被授权人已移出或尚未加入本项目，不能导入授权' };
    // H2 纵深防御：正常路径在更换 PM 时被 rules.pmClash 拦住（待接受任职 / 待处理授权都算 pending proposal），这里防直接写库或以后的改动；
    //   与普通入口（授权提议 / delegationTarget 重核）「PM 不得兼任代表人」同一判定，导入时同事务重核；无账号成员照常支持
    if (await isPmUserOf(q, pid, d.user_id)) return { block: 'PM 不得兼任参与方代表人，被授权人已是本项目 PM，不能导入授权' };
    const cur = await q.get("SELECT id FROM sysbuild_delegations WHERE party_id = ? AND status = 'active' LIMIT 1", [d.party_id]);
    if (cur) return { block: '该参与方已有生效代表人，历史授权不能覆盖当前生效状态' };
    const pend = await q.get(
      `SELECT r.id AS id FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id
        WHERE t.object_type = 'delegation' AND t.object_id = ? AND r.status = 'pending' LIMIT 1`,
      [d.id]
    );
    if (pend) return { block: '该授权有待确认的任务修订（当前有效任务），请先使其失效' };
    // P69：授权的原日期不得早于其依据的负责人任职的生效日（授权是负责人授予的，任职生效之前不存在授权）。fail-closed：现任任职却读不到生效日 → 拒绝，不静默放行
    const baseOn = typeof d.appointment_effective_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.appointment_effective_at) ? d.appointment_effective_at.slice(0, 10) : null;
    if (baseOn === null) return { block: '授权所依据的负责人任职缺少生效日期，不能导入授权' };
    if (date < baseOn) return { block: `该授权依据的负责人任职于 ${baseOn} 生效，不能导入更早（${date}）的授权` };
    // P68 ②：授权已在平台上被负责人批准（非历史导入来源的 delegation_approved 事件）时，原日期不得早于批准日；
    //   批准日 = 代录批准的外部确认日期（凭据上的日期），否则 = 平台批准事件的操作日期；取法与授权代录的接受一步下限共用 confirm-core.js delegationApprovedOn（LOW-3），
    //   这里跳过历史导入自己写的批准事件
    const approvedAt = await core.delegationApprovedOn(q, d.id, { skipHistoryImport: true });
    if (approvedAt !== null) {
      const approvedOn = String(approvedAt).slice(0, 10);
      if (date < approvedOn) return { block: `该授权已于 ${approvedOn} 在平台上由负责人批准，不能导入更早（${date}）的生效` };
    }
    // P68 ③：本方已有撤销日期晚于原日期的授权 → 不能导入比已撤销授权更早的「生效代表人」
    const revoked = await q.get("SELECT revoked_at FROM sysbuild_delegations WHERE party_id = ? AND status = 'revoked' AND substr(revoked_at, 1, 10) > ? ORDER BY revoked_at DESC LIMIT 1", [d.party_id, date]);
    if (revoked) return { block: `该参与方已有于 ${String(revoked.revoked_at).slice(0, 10)} 撤销的授权，不能导入比它更早（${date}）生效的代表人` };
    // P70：原日期与本方已撤销授权的撤销日同一天时，生效时刻取那条的 revoked_at
    const sameDay = await q.get("SELECT revoked_at FROM sysbuild_delegations WHERE party_id = ? AND status = 'revoked' AND substr(revoked_at, 1, 10) = ? ORDER BY revoked_at DESC LIMIT 1", [d.party_id, date]);
    // P70（K3，同对象同日）：授权已由负责人本人在平台批准（批准事件带时刻）且原日期与批准事件同一天时，生效时刻取批准事件的时刻（不写 00:00:00，防「生效」早于「批准」）；
    //   代录批准只有日期（external_date 长度 10），没有时刻，不适用。两个同日来源并存时取较晚的
    const approvedTime = approvedAt !== null && String(approvedAt).length >= 19 && String(approvedAt).slice(0, 10) === date ? String(approvedAt) : null;
    const sameDayCands = [approvedTime, sameDay ? sameDay.revoked_at : null].filter((x) => x !== null).sort();
    return { block: null, data: Object.assign({}, d, { sameDayAt: sameDayCands.length > 0 ? sameDayCands[sameDayCands.length - 1] : null }) };
  }
  async function loadPackageFact(q, pid, id, date) {
    const ver = await q.get('SELECT id, package_id, version_no, parent_overall_version_id, form, status FROM sysbuild_package_versions WHERE id = ?', [id]);
    const pkg = ver ? await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]) : null;
    if (!ver || !pkg || pkg.project_id !== pid) return { block: NOT_IN_PROJECT };
    if (ver.status !== 'draft') return { block: '只有草稿版本可以导入历史生效' };
    // P55：历史生效导入只认 overall / initiation（本文件自己的清单，不读 rules.SUBMITTABLE_PACKAGE_TYPES：
    //   那份是「可提交确认」的类型，C5 S-S1c 起含 change，而变更包的生效 = 生成新的总体规划版本，没有历史导入这条路径；预筛 M1）
    if (pkg.type === 'change') return { block: '正式变更不支持历史生效导入' };
    if (!HISTORY_IMPORT_PACKAGE_TYPES.includes(pkg.type)) return { block: '该类型的内容包不支持历史生效导入' };
    const other = await q.get("SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND status IN ('effective', 'pending') AND id <> ? LIMIT 1", [pkg.id, ver.id]);
    if (other) return { block: '该内容包已有生效或待确认的版本（已走普通路径 / 有当前任务），历史版本不能覆盖' };
    const batchRow = pkg.batch_id === null ? null : await q.get('SELECT status FROM sysbuild_batches WHERE id = ?', [pkg.batch_id]);
    const batchStatus = batchRow ? batchRow.status : undefined;
    // P56：照 C4a 提交的事务内前置核对（草稿 + 类型 + 批次未冻结 + 立项前置 + 计划齐全），**不要求确认人齐全**（confirmersMissing 置 null）；历史互斥对象就是它自己，historyConflict 置 null。
    const facts = await packages.versionFactsOf(q, pkg);
    const target = packages.versionTarget(ver, pkg, batchStatus, Object.assign({}, facts, { confirmersMissing: null, historyConflict: null }));
    const st = rules.OBJECT_OPS.package_version_submit.state(target);
    if (st) return { block: typeof st === 'string' ? st : st.message };
    // P68 ④：总体规划包的原日期不得早于立项包生效日（立项通过之后总体范围才生效，§2.3）。
    //   K4：「生效日」取该包**最早生效的版本**（effective_at 非空的最小值），不取当前版本——立项包 v2 替代 v1 后，v1 生效之后的历史日期仍成立
    if (pkg.type === 'overall') {
      const ini = await q.get(
        `SELECT v.effective_at AS effective_at FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
          WHERE p.project_id = ? AND p.type = 'initiation' AND v.effective_at IS NOT NULL ORDER BY v.effective_at ASC, v.id ASC LIMIT 1`,
        [pid]
      );
      if (ini && date < String(ini.effective_at).slice(0, 10)) return { block: `项目立项包已于 ${String(ini.effective_at).slice(0, 10)} 生效，总体规划不能导入更早（${date}）的生效` };
    }
    // 条目集合重核（总体规划包）：违反时 recheckOverallSet 自己抛 409 带条目编号
    const set = pkg.type === 'overall' ? await ctx.recheckOverallSet(q, pkg, ver) : [];
    return { block: null, data: { ver, pkg, set } };
  }
  async function loadNodeFact(q, pid, id, date) {
    const data = await ctx.loadPlanData(q, pid);
    const node = data.nodes.find((n) => n.id === id);
    if (!node) return { block: NOT_IN_PROJECT };
    if (node.status === 'closed' || node.status === 'cancelled') return { block: '节点已收口或已取消，不能导入收口' };
    // C6a：整体验收结项（p_closing）的收口 = 整体结项（项目转入已结项），历史导入不覆盖（第一期历史导入只覆盖总体规划 / 立项 / 任职授权 / 节点收口，P52）；
    //   rules.node_close 去掉对 p_closing 的拒绝后，这里显式拦下，不让历史导入只关节点、不结项（项目状态与节点状态不一致）
    if (node.template_key === 'p_closing') return { block: '整体验收结项的收口不支持历史导入' };
    const batch = node.batch_id === null ? null : data.batches.find((b) => b.id === node.batch_id) || null;
    // 与收口端点同一套对象规则（里程碑 / 整体验收结项 / 批次冻结）：未开始的节点按「进行中」套用
    const st = rules.OBJECT_OPS.node_close.state({
      nodeStatus: 'in_progress', templateKey: node.template_key, isMilestone: node.is_golive_milestone === 1, isProjectLayer: node.batch_id === null, batchStatus: batch ? batch.status : null,
    });
    if (st) return { block: typeof st === 'string' ? st : st.message };
    const day = today();
    const brief = data.nodes.map((n) => ({ id: n.id, batch_id: n.batch_id, template_key: n.template_key, status: n.status, current_plan: deriveSchedule(n, data.recsByNode[n.id] || [], day).current_plan }));
    // P57：历史状态也须自洽——收口前置检查非空则拒绝
    const blockers = closeBlockers(node, brief, data.facts);
    if (blockers.length > 0) return { block: `收口前置条件未满足：${blockers.map((b) => b.message).join('；')}` };
    // P68 ⑤：节点曾走普通路径收口（平台写过 node_closed 事件；历史导入只写 history_fact_imported，不写它，所以这个事件只来自普通收口）→ 拒绝导入（方案「已走过普通…收口路径时拒绝导入」）。
    //   选事件而不是排期记录：历史导入也会写 actual_end 排期记录，用它判不出来源。
    const closedEv = await q.get("SELECT created_at FROM sysbuild_events WHERE object_type = 'node' AND object_id = ? AND event_type = 'node_closed' ORDER BY id DESC LIMIT 1", [node.id]);
    if (closedEv) return { block: `该节点曾于 ${String(closedEv.created_at).slice(0, 10)} 在平台上走过普通收口路径，不能再导入收口` };
    // P68 ①：进行中的节点在平台上已于 opened_at 开始，不能导入更早的收口
    if (node.status === 'in_progress' && node.opened_at && date < String(node.opened_at).slice(0, 10)) {
      return { block: `节点在平台上于 ${String(node.opened_at).slice(0, 10)} 开始，不能导入更早（${date}）的收口` };
    }
    // P68 ⑥（H4）：收口前置要求某个内容包已生效的节点（以 closeBlockers 的前置为准，plan.js closePackageRequirement 一一对应），收口原日期不得早于该包的生效日；
    //   「现在是否已生效」仍由上面的 closeBlockers 判，这里单独接收原日期、只比日期。fail-closed：依赖包的节点读不到生效版本 → 拒绝（正常路径上 closeBlockers 已先拦住）。
    //   K4：比较的生效日取该包（批次验收包按本批限定）最早生效的版本（effective_at 非空的最小值），不取当前版本
    const need = closePackageRequirement(node);
    if (need !== null) {
      const effPkg = await q.get(
        `SELECT v.id AS id, v.version_no AS version_no, v.effective_at AS effective_at FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
          WHERE p.project_id = ? AND p.type = ? AND (? IS NULL OR p.batch_id = ?) AND v.effective_at IS NOT NULL ORDER BY v.effective_at ASC, v.id ASC LIMIT 1`,
        [pid, need.type, need.batchId, need.batchId]
      );
      if (!effPkg || typeof effPkg.effective_at !== 'string') return { block: `该节点收口依赖的${need.label}没有可核对的生效时间，不能导入收口` };
      const effOn = effPkg.effective_at.slice(0, 10);
      if (date < effOn) return { block: `该节点收口依赖的${need.label}（版本 #${effPkg.id}，第 ${effPkg.version_no} 版）已于 ${effOn} 生效，不能导入更早（${date}）的收口` };
    }
    const recs = data.recsByNode[node.id] || [];
    const startDay = deriveSchedule(node, recs, day).actual_start;
    return { block: null, data: { node, startDay } };
  }
  // 上线事件（C6a，Q-D3 / P151；对象 = 批次）：前置 = 时间窗开启（rules.history_fact_import）+ 批次状态 = 进行中 + 该批还没有任何上线事件（已走过普通上线路径的不能导入，照 node_closed 的做法）
  //   + 原日期不晚于今天（400，在写入前核）。要求本批非里程碑、未取消的节点全部已收口（P166）；**不要求**批次验收包已生效——历史项目没有这些数据（第一期历史导入只覆盖总体规划 / 立项，P52）；
  //   P178（预筛 4 HIGH）：P151 原写的「不要求交接集合已清」作废——交接集合必须全部已清，与普通上线共用同一道闸门（goliveCore.importGateBlockersOf → goliveBlockersOf 的 PLAN_PENDING + HANDOVER_UNCLEARED），
  //   否则 PM 可在代表人不认可、普通上线 409 之后自己开窗口导入上线绕过整个交接闸门；
  //   快照里记 { history_import: true, 导入时的交接集合 } 供复核。里程碑节点须是未开始 / 进行中；进行中的节点不能导入早于它开始日的上线（同 node_closed 的 P68 ①）。
  async function loadGoliveFact(q, pid, id, date) {
    const batch = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [id, pid]);
    if (!batch) return { block: NOT_IN_PROJECT };
    if (batch.status !== 'active') return { block: '只有进行中的批次可以导入上线事件（规划中、已上线、已转出、被替代的批次都不行）' };
    // 预筛 5 LOW-3（修订批 7）：「该批已有上线事件」先于交接闸门判——撤销上线后批次回到进行中、仍带着未清项时，导入报的是真正的原因（已有上线事件，该走再上线），不是交接未清
    const any = await q.get('SELECT id, created_at FROM sysbuild_golive_events WHERE batch_id = ? LIMIT 1', [batch.id]);
    if (any) return { block: `该批已有上线事件（${String(any.created_at).slice(0, 10)}，已走过普通上线路径或已导入过），不能导入` };
    // P169 / P178：与普通上线共用交接闸门——goliveBlockersOf 的同一个函数、同一份交接集合，取 PLAN_PENDING（项目里有待确认的总体规划或变更包版本，变更生效会改写承诺到本批的条目集合）
    //   与 HANDOVER_UNCLEARED（交接集合必须全部已清，含代表人不认可后未解除的项）两个 code；节点前置另按下面导入专用规则（P166 / P171），验收包不要求。
    const gate = await goliveCore.importGateBlockersOf(q, batch);
    if (gate.some((b) => b.code === 'PLAN_PENDING')) return { block: '项目里有待确认的总体规划或变更，须等确认完成或撤回后再导入上线事件' };
    const other = gate.find((b) => b.code !== 'PLAN_PENDING'); // 闸门里除待确认规划外只剩 HANDOVER_UNCLEARED；以后闸门加 code 时同样拦（不静默放行）
    if (other) return { block: `${other.message}，须先清完（与普通上线同一道交接闸门）再导入上线事件` };
    const milestone = await goliveCore.milestoneOf(q, batch.id);
    if (!milestone) return { block: '该批没有正式上线里程碑节点，不能导入上线事件' };
    if (milestone.status !== 'not_started' && milestone.status !== 'in_progress') return { block: '该批的正式上线里程碑节点状态不允许导入上线事件' };
    if (milestone.status === 'in_progress' && milestone.opened_at && date < String(milestone.opened_at).slice(0, 10)) {
      return { block: `里程碑节点在平台上于 ${String(milestone.opened_at).slice(0, 10)} 开始，不能导入更早（${date}）的上线` };
    }
    if (milestone.status === 'in_progress') {
      const recs = await q.all("SELECT kind, actual_date, corrects_kind FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start', 'actual_correct') ORDER BY id", [milestone.id]);
      let start = null;
      for (const r of recs) {
        if (r.kind === 'actual_start' || (r.kind === 'actual_correct' && r.corrects_kind === 'actual_start')) start = r.actual_date;
      }
      if (start !== null && start > date) return { block: '原日期早于里程碑节点的实际开始日期，请先更正实际开始' };
    }
    // P166：本批非里程碑、未取消的节点须全部已收口（与普通上线前置 NODES_NOT_CLOSED 同一口径）：否则导入后批次已上线，b_uat 等节点再也收不了口（验收包无法历史导入、批次已不是进行中）。
    //   P171：b_uat（用户验收测试）豁免——它的收口要求批次验收包已生效，而验收包不能历史导入（P52），外包类历史项目否则永远导不进上线；豁免的节点在批次上线后保持原状，并记进导入快照（exempt_nodes）。
    const allOpen = await q.all(
      "SELECT id, name, template_key FROM sysbuild_nodes WHERE batch_id = ? AND is_golive_milestone = 0 AND status NOT IN ('closed', 'cancelled') ORDER BY sort_order, id",
      [batch.id]
    );
    const exemptNodes = allOpen.filter((n) => n.template_key === 'b_uat').map((n) => ({ id: n.id, name: n.name, template_key: n.template_key }));
    const openNodes = allOpen.filter((n) => n.template_key !== 'b_uat');
    if (openNodes.length > 0) return { block: `本批还有未收口的节点（${openNodes.map((n) => n.name).join('、')}），请先导入这些节点的收口再导入上线事件` };
    return { block: null, data: { batch, milestone, exemptNodes } };
  }
  const FACT_LOADERS = Object.freeze({ appointment: loadAppointmentFact, delegation: loadDelegationFact, package_effective: loadPackageFact, node_closed: loadNodeFact, golive: loadGoliveFact });

  // ── 各类事实的状态写入（同一写事务内，复用既有函数）────────────────────────────────────────────────
  //   每个 apply* 返回 { result, eventExtra }：result 进响应，eventExtra 并入 history_fact_imported 事件的 payload。
  async function applyAppointment(q, user, pid, data, at) {
    // P65：有账号成员的待接受任职带一条待接受的邀请——同一事务里把它置为已撤回（moveInvitation 条件更新带 status = 'pending'，写 invitation_withdrawn 事件留痕），再激活任职
    const invs = await q.all("SELECT id FROM sysbuild_invitations WHERE appointment_id = ? AND status = 'pending' ORDER BY id", [data.id]);
    await membership.withdrawInvitationsOfAppointment(q, user, data.id, { reason: '历史导入', via: 'history_import' });
    // 本方此刻没有现任（冲突检查已拒绝），不走负责人更换级联；生效时刻写原日期 00:00:00，原日期与本方已结束任职的结束日同一天时取那条的 ended_at（P70，data.sameDayAt）
    await membership.activateAppointment(q, user, pid, data, data.sameDayAt || at);
    return { result: { status: 'active', withdrawn_invitation_ids: invs.map((x) => x.id) }, eventExtra: {} };
  }
  async function applyDelegation(q, user, pid, data, at) {
    // 待负责人确认的提议：历史上批准与接受都发生过，先按本人路径的同一写法推进到待接受，再激活
    if (data.status === 'pending_owner') await membership.moveDelegation(q, user, pid, data, 'pending_accept', 'delegation_approved', { via: 'history_import' }, { notify: false }); // C6b 修订批 1（L1）：导入路径随即生效，不写注定被跳过的发送意图
    // 生效时刻同任职：原日期与本方已撤销授权的撤销日同一天时取那条的 revoked_at（P70）
    await membership.activateDelegation(q, user, pid, Object.assign({}, data, { status: 'pending_accept' }), data.sameDayAt || at);
    return { result: { status: 'active' }, eventExtra: {} };
  }
  async function applyPackage(q, user, pid, data, at, uid, opName) {
    const { ver, pkg, set } = data;
    // 提交时的形态重算与回写（P32，packages.js rewriteFormAndParent，与 confirm.js 提交共用；草稿条件，变化项记进导入事件，与提交事件同名）
    const { calc, changed } = await packages.rewriteFormAndParent(q, pkg, ver);
    const pend = await q.run("UPDATE sysbuild_package_versions SET status = 'pending', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [ver.id]);
    if (pend.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
    // 冻结条目版本附件与包材料附件（不变量 9，同提交）
    for (const it of set) {
      await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: ver.id, ownerType: 'item_version', ownerId: it.item_version_id, operatorId: uid, operatorName: opName, projectId: pid });
    }
    await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: ver.id, ownerType: 'package_version', ownerId: ver.id, operatorId: uid, operatorName: opName, projectId: pid });
    await materialsCore.freezeSelectedMaterials(q, { projectId: pid, versionId: ver.id, operatorId: uid, operatorName: opName });
    const plans = pkg.type === 'overall' ? await core.currentNodePlans(q, pid) : undefined;
    // 生效、基线、合并形态推进批次：与普通路径同一个函数（C4a），生效时刻 = 原日期 00:00:00
    const eff = await core.applyPackageEffect(q, user, pid, pkg, Object.assign({}, ver, { form: calc.form, status: 'pending' }), { effectiveAt: at, recordedPlans: plans });
    // MED-2：节点计划快照（与普通提交事件同形）写进导入事件的 node_plans，之后 submittedNodePlans 在没有提交事件时读它（基线来源可复核）
    return {
      result: { status: 'effective', superseded_version_ids: eff.superseded, baseline_node_ids: eff.baselineNodes, advanced_batch_ids: eff.advancedBatches },
      eventExtra: Object.assign({}, changed, plans === undefined ? {} : { node_plans: plans }),
    };
  }
  async function applyNode(q, user, pid, data, date) {
    const { node, startDay } = data;
    const at = dayStart(date);
    if (node.status === 'in_progress') {
      // 历史收口日不能早于实际开始日（历史状态自洽）；与收口端点对「实际开始晚于收口日期」的防御同口径
      if (startDay !== null && startDay > date) throw stateError('原日期早于该节点的实际开始日期，请先更正实际开始');
      // P70：原日期与平台上记的开始时刻 opened_at 同一天时，收口时刻取 opened_at（不写 00:00:00，防 closed_at 早于 opened_at）；比较仍按日
      const closedAt = node.opened_at && String(node.opened_at).slice(0, 10) === date ? node.opened_at : at;
      const r = await q.run("UPDATE sysbuild_nodes SET status = 'closed', closed_at = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'in_progress'", [closedAt, node.id]);
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
    } else {
      const r = await q.run("UPDATE sysbuild_nodes SET status = 'closed', opened_at = ?, closed_at = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'", [at, at, node.id]);
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [node.id, date, Number(user.id)]);
    }
    await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [node.id, date, Number(user.id)]);
    return { result: { status: 'closed', from: node.status }, eventExtra: {} };
  }
  // 上线事件导入（C6a）：golive 事件 kind = golive，时刻 = 原日期 00:00:00（与 P54 的生效 / 收口时刻同取法），快照 = { history_import: true, 导入时的交接集合与每项判定 }，批次 → 已上线、里程碑节点 → 已收口
  //   （同一个 golive-core.recordGolive，与普通上线共用）。里程碑节点是进行中且开始日与原日期同一天时，收口时刻取 opened_at（P70，防 closed_at 早于 opened_at）。
  async function applyGolive(q, user, pid, data, date) {
    const at = dayStart(date);
    const view = await goliveCore.handoverViewOf(q, data.batch);
    const sameDay = data.milestone.status === 'in_progress' && data.milestone.opened_at && String(data.milestone.opened_at).slice(0, 10) === date;
    const rec = await goliveCore.recordGolive(q, user, {
      batch: data.batch, kind: 'golive', snapshotJson: goliveCore.snapshotOf(view, { history_import: true, exempt_nodes: data.exemptNodes }), dateStr: date, createdAt: at,
      milestoneAt: sameDay ? data.milestone.opened_at : at, via: 'history_import',
    });
    return { result: { status: 'live', golive_event_id: rec.goliveEventId, milestone_node_id: rec.milestoneNodeId }, eventExtra: { golive_event_id: rec.goliveEventId } };
  }

  // ── POST /sysbuild/projects/:id/history-imports：历史事实导入（五类；golive = C6a 上线事件，对象 = 批次）──────────────────────
  router.post('/sysbuild/projects/:id/history-imports', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, IMPORT_KEYS);
    if (typeof body.fact_type !== 'string' || !schema.ENUMS.historyFactType.includes(body.fact_type)) {
      throw invalid('fact_type 必须是 appointment / delegation / package_effective / node_closed / golive 之一', 'fact_type');
    }
    const factType = body.fact_type;
    const objectId = readIdParam(body.object_id, 'object_id', '对象编号');
    const actualConfirmer = core.readProxyText(body.actual_confirmer, 'actual_confirmer', '实际确认人', 100);
    const identityBasis = core.readProxyText(body.identity_basis, 'identity_basis', '身份依据', 500);
    const d = body.original_date;
    if (d === undefined || d === null || d === '') throw invalid('原日期必填', 'original_date');
    if (!core.validDate(d)) throw invalid('原日期必须是 YYYY-MM-DD 格式的有效日期（2000–2099）', 'original_date');
    const attachmentIds = core.readEvidenceAttachmentIds(body.attachment_ids, '历史导入');
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const access = await visibleAccess(q, pid, user);
      const historyWindow = await windowOf(q, pid);
      // 项目级前置（权限 / 项目状态 / 窗口开启）先于对象查询，非 PM 不借对象冲突提示探测对象
      rules.assertOp('history_fact_import', access, access.project, { historyWindow });
      // P179：导入上线事件另按 golive 类核项目状态（只有进行中；已暂停 409 SYSBUILD_PROJECT_READONLY），与项目读接口 actions.history_import_golive 同一个 rules.goliveImportProjectBlock
      if (factType === 'golive') {
        const gb = rules.goliveImportProjectBlock(access.project.status);
        if (gb) throw makeError(gb.status, gb.code, gb.message);
      }
      const fact = await FACT_LOADERS[factType](q, pid, objectId, d);
      rules.assertOp('history_fact_import', access, access.project, { historyWindow, factType, importBlock: fact.block });
      // 400：原日期范围（只要求不晚于今天，历史导入没有下限，P54）与附件可用性（bind 内）
      core.assertProxyDate(d, core.NO_DATE_FLOOR, today(), undefined, 'original_date', '原日期');
      const at = dayStart(d);
      const opName = operatorNameOf(user);
      let applied;
      if (factType === 'appointment') applied = await applyAppointment(q, user, pid, fact.data, at);
      else if (factType === 'delegation') applied = await applyDelegation(q, user, pid, fact.data, at);
      else if (factType === 'package_effective') applied = await applyPackage(q, user, pid, fact.data, at, uid, opName);
      else if (factType === 'golive') applied = await applyGolive(q, user, pid, fact.data, d);
      else applied = await applyNode(q, user, pid, fact.data, d);
      const result = applied.result;
      const objectType = FACT_OBJECT_TYPE[factType];
      const ins = await q.run(
        'INSERT INTO sysbuild_history_imports (project_id, object_type, object_id, fact_type, actual_confirmer, identity_basis, original_date, imported_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [pid, objectType, objectId, factType, actualConfirmer, identityBasis, d, uid]
      );
      const bound = await attachmentHelpers.bindStagedAttachments(q, {
        projectId: pid, userId: uid, attachmentIds, ownerType: 'history_import', ownerId: ins.lastID, operatorName: opName,
      });
      await emit(q, user, pid, objectType, objectId, 'history_fact_imported', Object.assign({
        history_import_id: ins.lastID, fact_type: factType, object_type: objectType, object_id: objectId, original_date: d, actual_confirmer: actualConfirmer,
        identity_basis: identityBasis, attachment_ids: bound,
      }, applied.eventExtra));
      return {
        history_import: { id: ins.lastID, fact_type: factType, object_type: objectType, object_id: objectId, original_date: d, label: '历史导入' },
        result, attachment_ids: bound,
      };
    });
    res.status(201).json(out);
  }));

  return { router };
}

module.exports = { createHistoryRoutes };
