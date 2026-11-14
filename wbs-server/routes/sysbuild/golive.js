// routes/sysbuild/golive.js — 项目管理（系统建设记录）模块：上线交接集合、交接确认发起、确认试运行结束（上线 / 再上线）、撤销上线端点（C6a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §3.2（:466–469）、§4.2（:613）、§4.3（上线交接清单与上线判定 P106）、§4.5、§5.2（:855–857）、§7（:991）。
//   派单 = docs/local/系统建设记录/送审准备/C6_C6a_上线交接结项_派单_20261107.md。
//
// 工厂 createGoliveRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（todayProvider：里程碑节点收口自动记的实际日期，缺省 = 服务器本地日期）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 批次 / 对象状态 409 → 业务前置 409（上线前置带 blockers 列表）。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp / checkOp（OBJECT_OPS + OP_KIND）；读接口的 actions 用 rules.opAllowed 与同一个 target 构造（golive-core）——标志与执行同源，前端不推算。
// 写端点全部在 withWriteTxn 内「加载 → 按当时完整集合重核 → 写 → 写事件」；上线与撤销的批次状态转移用条件 UPDATE（WHERE 带旧状态），影响行数 0 → 409。读接口不写浏览记录。
'use strict';
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const entries = require('./entries-core');
const golive = require('./golive-core');

const REASON_MAX = 500;
const REPLY_MIN = 10; // P174：答复文字至少 10 字

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
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

function createGoliveRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/golive 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) throw new Error('routes/sysbuild/golive 参数 readonlyIds 必须是数组或 Set');
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/golive 参数 writeRoles 必须是数组或 Set');
  if (typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') throw new Error('routes/sysbuild/golive 参数 attachmentHelpers 必须带 freezeAttachmentSet');
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
    logger.error(`[sysbuild] 上线交接接口内部错误: ${(cause && cause.message) || String(err)}`);
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
    return { id: batch.id, seq: batch.seq, name: batch.name, status: batch.status, live: info.live, last_golive_event: info.last_event };
  }
  // 交接集合每项的视图：判定 + 任务（补参与方名）+ 逐项 actions.handover_request（与发起端点同一个 target 构造 + 同一条 OBJECT_OPS 判定）。
  async function itemViews(q, access, batch, view) {
    const names = {};
    for (const p of view.parties) names[p.id] = p.name;
    const out = [];
    for (const it of view.items) {
      // P174：确认状态为 declined 时按「会带答复」算（reply_required）：标志为真 ⇔ 带合法答复发起会成功
      const target = await golive.handoverRequestTarget(q, batch, it, view.parties, it.reply_required === true);
      out.push(Object.assign({}, it, {
        last_reply: await golive.lastReplyOf(q, it.entry_id), // codex 27 M1：最近一次 PM 答复（文字、答复人、时间），没有为 null；只读
        confirm: Object.assign({}, it.confirm, { tasks: it.confirm.tasks.map((t) => Object.assign({}, t, { party_name: hasKey(names, t.party_id) ? names[t.party_id] : null })) }),
        actions: { handover_request: rules.opAllowed('handover_request', access, access.project, target) },
      }));
    }
    return out;
  }
  async function batchActions(q, access, batch, view) {
    return {
      golive: rules.opAllowed('golive', access, access.project, { batchStatus: batch.status, blockers: view.blockers }),
      revoke_golive: rules.opAllowed('revoke_golive', access, access.project, { batchStatus: batch.status, closingPending: await golive.closingPendingOf(q, batch.project_id) }),
    };
  }

  // ── GET /sysbuild/batches/:bid/handover：上线交接集合（项目成员可读，不写浏览记录）──────────────────────────────
  router.get('/sysbuild/batches/:bid/handover', handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const out = await db.withRead(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, req.user);
      const view = await golive.handoverViewOf(q, batch);
      return {
        batch: await batchView(q, batch),
        items: await itemViews(q, access, batch, view),
        summary: view.summary,
        blockers: view.blockers,
        actions: await batchActions(q, access, batch, view),
      };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/batches/:bid/handover/requests：发起交接确认（PM；body { entry_id, reply? }，用途由该项的判定自动决定；该登记有未解除的不认可时必带 reply，P174）─────────────────
  router.post('/sysbuild/batches/:bid/handover/requests', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['entry_id', 'reply']);
    const entryId = readIdParam(body.entry_id, 'entry_id', '登记编号');
    // P174：reply = PM 对代表人「不认可 / 有异议」的答复文字（可选；该登记有未解除的不认可时必带）：trim 后 10–500 字、无控制字符（400，与别的参数同批校验）
    const reply = readText(body.reply, 'reply', '答复', REASON_MAX, false);
    if (body.reply !== undefined && body.reply !== null && reply === null) throw invalid('答复不能是空白', 'reply'); // 给了 reply 但 trim 后为空：400，不当作没带
    if (reply !== null && Array.from(reply).length < REPLY_MIN) throw invalid(`答复至少 ${REPLY_MIN} 个字`, 'reply');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      const entry = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [entryId, batch.project_id]);
      if (!entry) {
        // 请求体里的引用对象不存在：先过权限 / 项目状态（403 / 409 先于 400，不借 400 探测登记），再报 400
        const pre = rules.checkOp('handover_request', access, access.project, {});
        if (pre && (pre.status === 403 || pre.code === 'SYSBUILD_PROJECT_READONLY')) throw errorOf(pre);
        throw invalid('登记不存在或不属于本项目', 'entry_id');
      }
      const view = await golive.handoverViewOf(q, batch);
      const item = view.items.find((i) => i.entry_id === entry.id) || null;
      const target = await golive.handoverRequestTarget(q, batch, item, view.parties, reply !== null);
      const v = rules.checkOp('handover_request', access, access.project, target);
      if (v) throw errorOf(v);
      // P174：带答复 = 先记答复并给被不认可的任务生成新修订（同一任务改发），再给还没有当前任务的参与方建新任务。
      //   P175（修订批 4）：不再有「不需要确认时只记答复」的路——handover_request 在 needKind 为空时一律 409，走到这里的项必然需要确认（createHandoverTasks 对空用途抛 500 兜底）
      const replied = reply === null ? null : await golive.recordHandoverReply(q, user, batch, entry, item, reply);
      const made = await golive.createHandoverTasks(q, user, attachmentHelpers, entry, item, view.parties);
      const replyLinks = golive.answerLinksOf(replied, made);
      await emit(q, user, batch.project_id, 'entry', entry.id, 'handover_requested', {
        batch_id: batch.id, purpose: item.confirm.purpose === null ? golive.HANDOVER_PURPOSE_OF[item.need_confirm] : item.confirm.purpose, need_confirm: item.need_confirm,
        fingerprint: item.confirm.fingerprint, task_ids: made.map((t) => t.task_id).concat(replied ? replied.reissued.map((t) => t.task_id) : []),
        party_ids: made.map((t) => t.party_id).concat(replied ? replied.reissued.map((t) => t.party_id) : []), replied: replied !== null,
        // J1（27-R M1）：答复与修订的直接关联（答复事件编号 + 本次新建 / 改发的 任务、修订、参与方 映射），current_reply 先按它解析；新增字段，不改上面已有字段
        reply_event_id: replyLinks.reply_event_id, reply_links: replyLinks.reply_links,
      });
      const after = await golive.handoverViewOf(q, batch);
      const views = await itemViews(q, access, batch, after);
      return { item: views.find((i) => i.entry_id === entry.id), tasks: made, reissued: replied ? replied.reissued : [], summary: after.summary };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/batches/:bid/golive：确认试运行结束（正式上线 / 再上线）──────────────────────────────────────
  // PM（admin 接管后）；项目状态只允许进行中（暂停 409 SYSBUILD_PROJECT_READONLY）。前置全部在写事务内按当时完整集合重核（不信页面传来的任何清单），任一不满足 409 SYSBUILD_GOLIVE_BLOCKED
  //   并在 blockers 里列出每一项：本批除里程碑外、未取消的节点全部已收口；批次验收包已生效；交接集合每项已清。
  //   执行（同一事务）：上线事件（最后一条事件是 revoke 时 kind = regolive，否则 golive；handover_snapshot_json = 重核时的完整集合与每项判定）、批次 进行中 → 已上线（条件更新）、
  //   里程碑节点 → 已收口（记实际结束，写节点事件）、事件。上线事件时刻 = 此刻；「已正式上线」从严格晚于该时刻起算（P106）。
  router.post('/sysbuild/batches/:bid/golive', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    onlyKeys(bodyOf(req), []);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      // 先过权限 / 项目状态 / 批次状态（blockers 先给空数组：不为没权限的人白算整个交接集合），再按当时完整集合重核
      const pre = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: [] });
      if (pre) throw errorOf(pre);
      const view = await golive.handoverViewOf(q, batch);
      const v = rules.checkOp('golive', access, access.project, { batchStatus: batch.status, blockers: view.blockers });
      if (v) throw errorOf(v, view.blockers);
      const last = (await entries.batchLiveState(q, batch.id)).last;
      const kind = last !== null && last.kind === 'revoke' ? 'regolive' : 'golive';
      const rec = await golive.recordGolive(q, user, {
        batch, kind, snapshotJson: golive.snapshotOf(view), dateStr: today(), createdAt: null, milestoneAt: null, via: 'golive',
      });
      const fresh = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ?', [batch.id]);
      return { batch: await batchView(q, fresh), golive_event: { id: rec.goliveEventId, kind }, milestone_node_id: rec.milestoneNodeId, summary: view.summary };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/batches/:bid/revoke-golive：撤销正式上线（admin，body { reason }）───────────────────────────────
  // 前置：批次状态 = 已上线；项目状态为进行中或已暂停（已终止 / 已结项 409，已结项须先由 admin 重开项目）；本项目有待确认的结项包 409（P150）。
  //   执行（同一事务，用户已拍板 T-D3）：revoke 事件（只追加）、批次 已上线 → 进行中、里程碑节点 已收口 → 进行中（写节点事件）；本批其他已收口节点不动。
  router.post('/sysbuild/batches/:bid/revoke-golive', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason']);
    const reason = readText(body.reason, 'reason', '撤销原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      const v = rules.checkOp('revoke_golive', access, access.project, { batchStatus: batch.status, closingPending: await golive.closingPendingOf(q, batch.project_id) });
      if (v) throw errorOf(v);
      const rec = await golive.recordRevoke(q, user, batch, reason);
      const fresh = await q.get('SELECT id, project_id, seq, name, is_default, status FROM sysbuild_batches WHERE id = ?', [batch.id]);
      return { batch: await batchView(q, fresh), golive_event: { id: rec.goliveEventId, kind: 'revoke' }, milestone_node_id: rec.milestoneNodeId };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createGoliveRoutes };
