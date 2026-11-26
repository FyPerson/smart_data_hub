// routes/sysbuild/golive.js — 项目管理（系统建设记录）模块：上线前置读接口、确认试运行结束（上线 / 再上线）、撤销上线端点（C6a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §3.2（:466–469）、§4.5、§5.2（:855–857）、§7（:991）。
//   派单 = docs/local/系统建设记录/送审准备/C6_C6a_上线交接结项_派单_20261107.md。
//
// 工厂 createGoliveRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（todayProvider：里程碑节点收口自动记的实际日期，缺省 = 服务器本地日期）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 批次 / 对象状态 409 → 业务前置 409（上线前置带 blockers 列表）。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp / checkOp（OBJECT_OPS + OP_KIND）；读接口的 actions 用 rules.opAllowed 与同一份 blockers 算——标志与执行同源，前端不推算。
// 写端点全部在 withWriteTxn 内「加载 → 按当时状态重核 → 写 → 写事件」；上线与撤销的批次状态转移用条件 UPDATE（WHERE 带旧状态），影响行数 0 → 409。读接口不写浏览记录。
'use strict';
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const core = require('./confirm-core');
const entries = require('./entries-core');
const golive = require('./golive-core');
const completion = require('./node-completion');

const REASON_MAX = 500;

const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
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

function readGoliveAttachmentIds(raw) {
  if (raw === undefined || raw === null) return [];
  // L2 golive: at most ten evidence attachments per event.
  if (!Array.isArray(raw) || raw.length > 10) throw invalid('上线事件附件须为至多 10 个编号的列表', 'attachment_ids');
  const ids = raw.map((value) => {
    const id = rules.parseId(value);
    if (!id) throw invalid('附件编号不合法', 'attachment_ids');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw invalid('附件编号重复', 'attachment_ids');
  return ids;
}

// L2：批次视图与上线操作响应共用；旧事件自然返回空附件列表，遮蔽名称沿用统一附件视图。
async function goliveEventView(q, event) {
  if (!event) return null;
  const bound = await q.all("SELECT b.attachment_id AS attachment_id, a.sha256 AS sha256 FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id WHERE b.owner_type = 'golive_event' AND b.owner_id = ? ORDER BY b.id", [event.id]);
  return Object.assign({}, event, { attachment_ids: bound.map((item) => item.attachment_id), attachments: await core.attachmentView(q, bound) });
}

function createGoliveRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/golive 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/golive 参数 readonlyIds 必须是数组或 Set');
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/golive 参数 writeRoles 必须是数组或 Set');
  if (typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function') throw new Error('routes/sysbuild/golive 参数 attachmentHelpers 必须带 bindStagedAttachments');
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  const today = () => {
    const v = typeof ctx.todayProvider === 'function' ? ctx.todayProvider() : core.localDateString(new Date());
    if (typeof v === 'string' && core.validDate(v)) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return core.localDateString(v);
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：日期提供者返回值不合法');
  };

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      if (Array.isArray(err.blockers)) body.blockers = err.blockers;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 上线接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  function readIdParam(raw, field, label) {
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }
  // checkOp 的拒绝结果 → 抛错；上线前置未满足时带 blockers（响应体列出每一项原因）
  function errorOf(v, blockers) {
    const err = makeError(v.status, v.code, v.message);
    if (v.code === 'SYSBUILD_GOLIVE_BLOCKED' && Array.isArray(blockers)) err.blockers = blockers;
    return err;
  }

  async function loadBatchCtx(q, bid, user) {
    const batch = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ?', [bid]);
    if (!batch) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, batch.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { batch, access };
  }
  async function batchView(q, batch) {
    const info = await golive.goliveInfoOf(q, batch.id);
    return { id: batch.id, seq: batch.seq, name: batch.name, status: batch.status, live: info.live, last_golive_event: await goliveEventView(q, info.last_event) };
  }
  async function batchActions(q, access, batch, blockers) {
    return {
      golive: rules.opAllowed('golive', access, access.project, { batchStatus: batch.status, blockers }),
      revoke_golive: rules.opAllowed('revoke_golive', access, access.project, { batchStatus: batch.status, closingPending: await golive.closingPendingOf(q, batch.project_id) }),
    };
  }

  // ── GET /sysbuild/batches/:bid/handover：上线前置阻塞原因与动作标志（项目成员可读，不写浏览记录）──────────────────────────────
  router.get('/sysbuild/batches/:bid/handover', handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const out = await db.withRead(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, req.user);
      const blockers = await golive.goliveBlockersOf(q, batch);
      const completion_candidates = await completion.completionCandidates(q, batch.project_id, { batchId: batch.id });
      return { batch: await batchView(q, batch), blockers, completion_candidates, actions: await batchActions(q, access, batch, blockers) };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/batches/:bid/golive：确认试运行结束（正式上线 / 再上线）──────────────────────────────────────
  // PM（admin 接管后）；项目状态只允许进行中（暂停 409 SYSBUILD_PROJECT_READONLY）。前置全部在写事务内按当时状态重核（不信页面传来的任何清单），任一不满足 409 SYSBUILD_GOLIVE_BLOCKED
  //   并在 blockers 里列出每一项：批次验收包已生效且引用现行总体规划；项目里没有待确认的范围包。其余未完成阶段只提供一并完成的选择。
  //   执行（同一事务）：上线事件（最后一条事件是 revoke 时 kind = regolive，否则 golive）、批次 进行中 → 已上线（条件更新）、
  //   里程碑节点 → 已收口（记实际结束，写节点事件）、事件。上线事件时刻 = 此刻；「已正式上线」从严格晚于该时刻起算（P106）。
  router.post('/sysbuild/batches/:bid/golive', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['attachment_ids', 'complete_node_ids']);
    const attachmentIds = readGoliveAttachmentIds(body.attachment_ids);
    const completionIds = completion.readCompletionIds(body.complete_node_ids);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      // 先过权限 / 项目状态 / 批次状态（blockers 先给空数组：不为没权限的人白算上线前置），再按当时状态重核
      const pre = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: [] });
      if (pre) throw errorOf(pre);
      const blockers = await golive.goliveBlockersOf(q, batch);
      const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers });
      if (v) throw errorOf(v, blockers);
      const day = today();
      const completedNodeIds = await completion.completeSelected(q, {
        projectId: batch.project_id, batchId: bid, ids: completionIds, day,
        operatorId: Number(user.id), operatorName: core.operatorNameOf(user), via: 'golive',
      });
      const last = (await entries.batchLiveState(q, batch.id)).last;
      const kind = last !== null && last.kind === 'revoke' ? 'regolive' : 'golive';
      const rec = await golive.recordGolive(q, user, {
        batch, kind, dateStr: day, createdAt: null, milestoneAt: null, via: 'golive',
      });
      // L2 golive: binding failure rolls back the event and the existing state transitions together.
      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });
      const fresh = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ?', [batch.id]);
      return { batch: await batchView(q, fresh), golive_event: await goliveEventView(q, { id: rec.goliveEventId, kind }), milestone_node_id: rec.milestoneNodeId, completed_node_ids: completedNodeIds };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/batches/:bid/revoke-golive：撤销正式上线（admin，body { reason }）───────────────────────────────
  // 前置：批次状态 = 已上线；项目状态为进行中或已暂停（已终止 / 已结项 409，已结项须先由 admin 重开项目）；本项目有待确认的结项包 409（P150）。
  //   执行（同一事务，用户已拍板 T-D3）：revoke 事件（只追加）、批次 已上线 → 进行中、里程碑节点 已收口 → 进行中（写节点事件）；本批其他已收口节点不动。
  router.post('/sysbuild/batches/:bid/revoke-golive', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason', 'attachment_ids']);
    const attachmentIds = readGoliveAttachmentIds(body.attachment_ids);
    const reason = readText(body.reason, 'reason', '撤销原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      const v = rules.checkOp('revoke_golive', access, access.project, { batchStatus: batch.status, closingPending: await golive.closingPendingOf(q, batch.project_id) });
      if (v) throw errorOf(v);
      const rec = await golive.recordRevoke(q, user, batch, reason);
      // L2 revoke: evidence is appended in the same transaction as the revoke event.
      await attachmentHelpers.bindStagedAttachments(q, { projectId: batch.project_id, userId: Number(user.id), attachmentIds, ownerType: 'golive_event', ownerId: rec.goliveEventId, operatorName: core.operatorNameOf(user) });
      const fresh = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ?', [batch.id]);
      return { batch: await batchView(q, fresh), golive_event: await goliveEventView(q, { id: rec.goliveEventId, kind: 'revoke' }), milestone_node_id: rec.milestoneNodeId };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createGoliveRoutes, goliveEventView };
