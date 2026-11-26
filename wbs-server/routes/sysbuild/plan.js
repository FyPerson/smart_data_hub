// routes/sysbuild/plan.js — 项目管理（系统建设记录）模块：批次、节点、排期与改期端点（C3a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.3（批次）、§3（节点模板）、§4.4（排期与改期）、§4.5（状态机与项目状态 × 动作）、§5.3（检查顺序）、§7（接口）。
//   派单 = docs/local/系统建设记录/送审准备/C3a_批次节点排期_派单_20261030.md。
//
// 工厂 createPlanRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }。
//   todayProvider 可选：返回 'YYYY-MM-DD' 字符串或 Date，缺省 = 服务器本地日期（节点开始 / 收口自动记的实际日期、逾期天数都用它）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
//
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY
//   → 对象状态 409 SYSBUILD_STATE → 业务规则（收口前置 409 SYSBUILD_CLOSE_BLOCKED、证据 400 等）。权限 / 项目状态 / 对象状态三步全部经
//   rules.assertOp（OBJECT_OPS + OP_KIND），读接口的逐对象 actions 用 rules.opAllowed——同一张表同一个顺序，前端不推算。
//   端点里不另写「暂停时不能收口」之类的特例：暂停拒绝收口只来自状态表的 close 类别。
// 写端点全部在 withWriteTxn 内完成「加载 → 校验 → 写 → 写事件」；状态转移用条件 UPDATE（WHERE 带改前状态），影响行数 0 → 409。
'use strict';
const stageCards = require('./stage-cards');
const confirmCore = require('./confirm-core');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { G_STAGES } = require('./templates');
const { effectiveOverallVersionId } = require('./packages');
const entriesCore = require('./entries-core'); // C6：结项阶段的收口前置事实（批次上线判据等，closingFactsOf；办理类登记已不再进收口前置）（entries-core 只依赖 rules / db / events / confirm-core，不依赖本文件，不成环）
const goliveCore = require('./golive-core'); // C6a：批次视图的上线信息与 actions、项目上线进度（golive-core 不依赖本文件，不成环）
const notifySchedule = require('./notify-schedule'); // C6b：改期知会的生成（只依赖 events / confirm-core / notify-core，不成环）
const completion = require('./node-completion');
const { pendingClosingWork, pendingWorkMessage } = require('./work-core');
const reports = require('./report-core');
const { goliveEventView } = require('./golive');

const NAME_MAX = 60;
const REASON_MAX = 500;
const START_NOTE_MAX = 2000;
const EVIDENCE_REASON_MIN = 10;
// 初次和草稿期排期的原因可选；库内 plan_change 的 CHECK 要求原因非空。
const DRAFT_PLAN_REASON = '草稿期计划';
const FIRST_PLAN_REASON = '范围生效后首次排期';

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// 请求体：没有请求体（undefined / null）按空对象；存在却不是普通对象（express.json 的 strict 模式仍会放行数组根值）→ 400（codex 17 号 L-1：数组不能被悄悄当成空对象）。
function bodyOf(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
  return b;
}
const invalid =(message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);

// 文本：undefined / null / 空白 → null（必填则 400）；非字符串 400；trim 后按码点计长。
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
  if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field); // 预筛 L1：NUL 等控制字符否则落到库内 CHECK 以 500 暴露
  if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
  return v;
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
function readDate(raw, field, label) {
  if (raw === undefined || raw === null || raw === '') throw invalid(`${label}必填`, field);
  if (!validDate(raw)) throw invalid(`${label}必须是 YYYY-MM-DD 格式的有效日期（2000–2099）`, field);
  return raw;
}
function utcDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}
// 天数差 b − a（b 晚于 a 为正）。
function daysBetween(a, b) {
  return utcDay(b) - utcDay(a);
}
function localDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 派生（纯函数，不读库）────────────────────────────────────────────────────────────────
// recs = 该节点全部排期记录，按 id 升序。
//   当前计划 = baseline 与 plan_change 中最后一条；基线 = baseline 记录；与基线差 = 当前计划止 − 基线止（天，无基线为 null）；
//   实际开始 = 最后一条 actual_start 或更正它的 actual_correct；实际结束 = 仅当节点 status = closed 时取最后一条 actual_end 或更正它的 actual_correct，否则 null；
//   逾期天数 = 节点未开始 / 进行中（已收口、已取消不算）且当前计划止 < 今天时的天数差，否则 0。
function lastActual(recs, kind) {
  let v = null;
  for (const r of recs) {
    if (r.kind === kind || (r.kind === 'actual_correct' && r.corrects_kind === kind)) v = r.actual_date;
  }
  return v;
}
function deriveSchedule(node, recs, today) {
  let current = null;
  let baseline = null;
  for (const r of recs) {
    if (r.kind === 'baseline') { baseline = { start: r.planned_start, end: r.planned_end }; current = { start: r.planned_start, end: r.planned_end }; }
    if (r.kind === 'plan_change') current = { start: r.planned_start, end: r.planned_end };
  }
  const diff = current && baseline ? daysBetween(baseline.end, current.end) : null;
  const overdue = (node.status === 'not_started' || node.status === 'in_progress') && current && current.end < today ? daysBetween(current.end, today) : 0;
  return {
    current_plan: current,
    baseline,
    diff_days: diff,
    actual_start: lastActual(recs, 'actual_start'),
    actual_end: node.status === 'closed' ? lastActual(recs, 'actual_end') : null,
    overdue_days: overdue,
  };
}

function projectCompletion(status, closing, today) {
  const date = closing?.current_plan?.end ?? null;
  const active = status === 'active';
  const days = active && date ? daysBetween(today, date) : null;
  const tone = days === null ? null : days <= 3 ? 'danger' : days <= 14 ? 'warning' : null;
  const delay = active && closing?.diff_days > 0 ? closing.diff_days : null;
  return { date, days_remaining: days, tone, delay_days: delay, as_of: today };
}

// 项目层结项的业务前置由计划视图和结项端点共用。
function closeBlockers(node, facts) {
  if (node.template_key !== 'p_closing' || node.batch_id !== null) return [];
  const f = facts || {};
  const out = [];
  const closingCards = f.closingCards || [];
  if (!(f.closing && typeof f.closing.closingEffectiveAt === 'string') && !closingCards.some((card) => card.key === 'closing')) {
    out.push({ code: 'PACKAGE_NOT_EFFECTIVE', message: '结项包还没有生效版本，不能结项', node_ids: [node.id] });
  }
  // C6a 整体验收结项（p_closing）的收口前置（方案 §2.3 :443、§4.3 v1.5；facts.closing = entries-core.closingFactsOf，与结项包提交前置同一个函数）：
  //   ② 每个有效批次（非已转出 / 被替代）都已正式上线（batchLiveState，P106 口径）；
  //   ③ 结项包的生效时刻晚于每个批次最后一条上线事件（撤销后再上线，结项包须重新确认，P141）；
  //   ①（结项包已生效）在上面的 PACKAGE_NOT_EFFECTIVE。事实没取到（不是对象）fail-closed 报 CLOSING_FACTS_MISSING。
  if (node.template_key === 'p_closing') {
    const cl = f.closing;
    if (!cl || typeof cl !== 'object' || !Array.isArray(cl.notLive) || !Array.isArray(cl.goliveNewer)
      || typeof cl.closingStale !== 'boolean' || !Array.isArray(cl.packagePending)) {
      out.push({ code: 'CLOSING_FACTS_MISSING', message: '无法确定批次上线情况，请刷新后重试', node_ids: [node.id] });
    } else {
      const names = (arr) => arr.map((b) => b.name).join('、');
      // P168：结项包确认时引用的总体规划已换版，须在现行规划上重新确认结项包；P164：项目里有待确认的内容包版本时先处理完（任何类型）。
      if (cl.closingStale === true && typeof cl.closingEffectiveAt === 'string') {
        out.push({ code: 'CLOSING_STALE', message: '结项包引用的版本不是现行范围版本，须基于现行范围版本重新提交结项包并确认', node_ids: [node.id] });
      }
      if (cl.packagePending.length > 0) {
        out.push({ code: 'PACKAGE_PENDING', message: `项目里还有待确认的内容包（${cl.packagePending.map((t) => rules.PACKAGE_TYPE_LABELS[t] || t).join('、')}），须先处理完再结项`, node_ids: [node.id] });
      }
      const missingLiveCards = new Set(closingCards.filter((card) => card.key === 'golive').map((card) => card.batch_id));
      const unlistedBatches = cl.notLive.filter((batch) => !missingLiveCards.has(batch.id));
      if (unlistedBatches.length > 0) out.push({ code: 'BATCH_NOT_LIVE', message: `以下批次还没有正式上线，不能结项：${names(unlistedBatches)}`, node_ids: [node.id], batch_ids: unlistedBatches.map((b) => b.id) });
      if (cl.goliveNewer.length > 0) {
        out.push({
          code: 'CLOSING_BEFORE_GOLIVE', message: `结项包的生效时刻不晚于以下批次最后一条上线事件，须重新确认结项包：${names(cl.goliveNewer)}`, node_ids: [node.id], batch_ids: cl.goliveNewer.map((b) => b.id),
        });
      }
    }
  }
  if (closingCards.length) {
    const batchIds = [...new Set(closingCards.map((card) => card.batch_id).filter((id) => id !== null))];
    out.push({
      code: 'REQUIRED_CARDS_INCOMPLETE',
      message: '以下必做事项尚未完成，不能结项：' + stageCards.missingCardNames(closingCards),
      node_ids: [...new Set(closingCards.map((card) => card.node_id))],
      ...(batchIds.length ? { batch_ids: batchIds } : {}),
    });
  }
  if (f.pendingWork?.length) {
    out.push({ code: 'PENDING_PROJECT_WORK', message: pendingWorkMessage(f.pendingWork), pending_work: f.pendingWork });
  }
  return out;
}

// 读写共用。基线只由总体规划确认生效形成；范围生效后可以录入尚无计划的阶段，再次修改须写明原因。
function planWriteMode(records, hasEffectiveOverall) {
  const editing = records.some((r) => r.kind === 'baseline') ||
    (hasEffectiveOverall && records.some((r) => r.kind === 'plan_change'));
  return editing ? 'reschedule' : 'draft';
}

function canRecordEarlyStart(node, hasEffectiveOverall) {
  return node.batch_id !== null && !hasEffectiveOverall;
}

function rangeUnconfirmedStarted(node, records, hasEffectiveOverall) {
  return canRecordEarlyStart(node, hasEffectiveOverall) && records.some((record) => record.kind === 'actual_start');
}

function createPlanRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/plan 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/plan 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/plan 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function') {
    throw new Error('routes/sysbuild/plan 参数 attachmentHelpers 必须带 bindStagedAttachments');
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  function today() {
    const v = typeof ctx.todayProvider === 'function' ? ctx.todayProvider() : new Date();
    if (typeof v === 'string' && validDate(v)) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return localDateString(v);
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：日期提供者返回值不合法');
  }

  // ── 统一错误出口（与 projects.js 同款；收口前置未满足时带 blockers）──────────────────────────
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
    logger.error(`[sysbuild] 批次节点接口内部错误: ${(cause && cause.message) || String(err)}`);
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
  function onlyKeys(body, allowed) {
    for (const k of Object.keys(body)) {
      if (!allowed.includes(k)) throw invalid(`不支持的字段 ${k}`, k);
    }
  }

  // ── 读库小助手 ──────────────────────────────────────────────────────────────────────────
  const NODE_COLS = 'id, project_id, batch_id, template_key, name, g_stage, sort_order, is_golive_milestone, status, opened_at, closed_at';
  const REC_COLS = 'id, node_id, kind, planned_start, planned_end, actual_date, corrects_kind, reason, source_party_id, package_version_id, no_written_evidence, no_evidence_reason, created_by, created_at';
  async function loadNodeRow(q, nid) {
    return q.get(`SELECT ${NODE_COLS} FROM sysbuild_nodes WHERE id = ?`, [nid]);
  }
  async function loadBatchRow(q, bid) {
    return q.get('SELECT id, project_id, seq, name, is_default, status, dev_assignee_member_id FROM sysbuild_batches WHERE id = ?', [bid]);
  }
  async function loadRecs(q, nid) {
    return q.all(`SELECT ${REC_COLS} FROM sysbuild_node_schedule_records WHERE node_id = ? ORDER BY id`, [nid]);
  }
  // 节点上下文：节点存在 404 → 项目可见 404（rules.assertVisible）。批次层节点同时取批次行。
  async function loadNodeCtx(q, nid, user) {
    const node = await loadNodeRow(q, nid);
    if (!node) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, node.project_id, user, accessOpts());
    rules.assertVisible(access);
    let batch = null;
    if (node.batch_id !== null) {
      batch = await loadBatchRow(q, node.batch_id);
      if (!batch) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：节点所属批次不存在');
    }
    const recs = await loadRecs(q, nid);
    return { node, batch, recs, access, overallPending: await overallPendingOf(q, node.project_id) };
  }
  async function loadBatchCtx(q, bid, user) {
    const batch = await loadBatchRow(q, bid);
    if (!batch) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, batch.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { batch, access };
  }
  // 整个项目的批次 / 节点 / 排期记录（读接口与收口前置共用）。
  async function loadPlanData(q, projectId) {
    const batches = await q.all('SELECT id, project_id, seq, name, is_default, status, dev_assignee_member_id FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
    const nodes = await q.all(
      `SELECT ${NODE_COLS} FROM sysbuild_nodes WHERE project_id = ? ORDER BY CASE WHEN batch_id IS NULL THEN 0 ELSE 1 END, batch_id, sort_order, id`,
      [projectId]
    );
    const recs = await q.all(
      `SELECT ${REC_COLS} FROM sysbuild_node_schedule_records WHERE node_id IN (SELECT id FROM sysbuild_nodes WHERE project_id = ?) ORDER BY id`,
      [projectId]
    );
    const recsByNode = {};
    for (const r of recs) {
      if (!hasKey(recsByNode, r.node_id)) recsByNode[r.node_id] = [];
      recsByNode[r.node_id].push(r);
    }
    // 承接人仍有效的批次（D5）：承接人成员行已加入、未移出，且属于本项目开发方。成员条件与 rules.MEMBER_ACTIVE_SQL 同源。
    const active = await q.all(
      `SELECT b.id AS id FROM sysbuild_batches b JOIN sysbuild_members m ON m.id = b.dev_assignee_member_id
         JOIN sysbuild_parties p ON p.id = m.party_id
        WHERE b.project_id = ? AND m.project_id = b.project_id AND p.project_id = b.project_id AND p.side = 'dev' AND ${rules.MEMBER_ACTIVE_SQL}`,
      [projectId]
    );
    const activeAssignees = {};
    for (const r of active) activeAssignees[r.id] = true;
    const facts = { overall: (await effectiveOverallVersionId(q, projectId)) !== null };
    // C6a：整体验收结项的收口前置事实（结项包生效时刻、批次上线情况；与结项包提交前置同一个函数 entries-core.closingFactsOf）
    facts.closing = await entriesCore.closingFactsOf(q, projectId);
    const closing = nodes.find((node) => node.template_key === 'p_closing' && node.batch_id === null && node.status === 'in_progress');
    if (closing) {
      const project = await q.get('SELECT id, build_type FROM sysbuild_projects WHERE id = ?', [projectId]);
      facts.closingCards = stageCards.missingCards(await stageCards.loadProjectCards(q, project), true);
      facts.pendingWork = await pendingClosingWork(q, projectId);
      facts.completionCandidates = await completion.completionCandidates(q, projectId, { excludeId: closing.id });
    }
    return { batches, nodes, recsByNode, activeAssignees, facts, overallPending: await overallPendingOf(q, projectId) };
  }
  // 本项目的总体规划包有待确认的版本？（P34：待确认期间排期随包冻结，节点排期 / 取消节点被拒；读接口 actions 与写端点都取这一个事实。）
  //   C6a：与上线前置 PLAN_PENDING 共用 golive-core.planPendingOf（同一个查询，不另写）。
  async function overallPendingOf(q, projectId) {
    return goliveCore.planPendingOf(q, projectId);
  }

  // target 构造（读写两端同一份）：rules.OBJECT_OPS 的 state 只认这些字段。
  const batchTarget = (batch) => ({ batchStatus: batch.status });
  function nodeTarget(node, batch, recs, corrects, overallPending, devStartReady) {
    return {
      devStartReady,
      nodeStatus: node.status,
      templateKey: node.template_key,
      isMilestone: node.is_golive_milestone === 1,
      isProjectLayer: node.batch_id === null,
      batchStatus: batch ? batch.status : null,
      hasBaseline: recs.some((r) => r.kind === 'baseline'),
      hasActual: { actual_start: recs.some((r) => r.kind === 'actual_start'), actual_end: recs.some((r) => r.kind === 'actual_end') },
      corrects: corrects || null,
      overallPending: overallPending === true, // C4a P34：本项目总体规划待确认（只有 node_cancel / schedule_plan 的判定读它）
    };
  }
  // 标志 → [动作, 带的 corrects]：更正实际日期按种类拆成两个标志（预筛 M3 / D7），各自 = opAllowed(schedule_correct, 带对应 corrects)。
  const NODE_ACTION_OPS = Object.freeze([
    ['start', 'node_start', null], ['close', 'node_close', null], ['reopen', 'node_reopen', null], ['cancel', 'node_cancel', null],
    ['rename', 'node_rename', null], ['schedule_plan', 'schedule_plan', null],
    ['correct_actual_start', 'schedule_correct', 'actual_start'], ['correct_actual_end', 'schedule_correct', 'actual_end'],
  ]);

  // 读接口 / 写端点响应共用：把一个项目的批次、节点整理成视图。每个 actions 标志 = opAllowed(同名动作)；close 标志不并入前置检查结果（阻塞项单独给）。
  function buildPlanView(access, data, todayStr) {
    const batchById = {};
    for (const b of data.batches) batchById[b.id] = b;
    const project = access.project;
    const batches = data.batches.map((b) => {
      const t = batchTarget(b);
      const gv = data.golive && hasKey(data.golive, b.id) ? data.golive[b.id] : null;
      return {
        id: b.id, seq: b.seq, name: b.name, is_default: b.is_default === 1, status: b.status, dev_assignee_member_id: b.dev_assignee_member_id,
        // 预筛 D5：承接人是本项目开发方已加入、未移出的成员时为 true；被移出后批次仍指向他，这里变 false，由 PM 重新指定（不级联改成员移出逻辑）。
        dev_assignee_active: hasKey(data.activeAssignees, b.id),
        // C6a：已正式上线（entries-core.batchLiveState，不读 status）与最后一条上线事件（kind / 时刻 / 操作人 / 原因）；只在 GET /plan 带出（planViewFor withGolive）
        live: gv ? gv.info.live : undefined,
        last_golive_event: gv ? gv.info.last_event : undefined,
        actions: Object.assign({
          update: rules.opAllowed('batch_update', access, project, t),
          add_node: rules.opAllowed('node_add', access, project, t),
          reorder: rules.opAllowed('node_reorder', access, project, t),
        }, gv ? {
          // C6a：与 POST …/golive、…/revoke-golive 同一条 OBJECT_OPS 判定、同一个前置函数（goliveCore.goliveBlockersOf / closingPendingOf）
          golive: rules.opAllowed('golive', access, project, { batchStatus: b.status, blockers: gv.blockers }),
          revoke_golive: rules.opAllowed('revoke_golive', access, project, { batchStatus: b.status, closingPending: data.closingPending }),
        } : {}),
      };
    });
    const nodes = data.nodes.map((n) => {
      const recs = data.recsByNode[n.id] || [];
      const batch = n.batch_id === null ? null : (batchById[n.batch_id] || null);
      const actions = {};
      for (const [flag, op, corrects] of NODE_ACTION_OPS) actions[flag] = rules.opAllowed(op, access, project, nodeTarget(n, batch, recs, corrects, data.overallPending, data.devStartReady[n.id]));
      if (n.template_key === 'p_closing' && n.batch_id === null && (data.facts.closingCards?.length || data.facts.pendingWork?.length)) actions.close = false;
      return Object.assign({
        id: n.id, batch_id: n.batch_id, template_key: n.template_key, name: n.name, g_stage: n.g_stage, sort_order: n.sort_order,
        is_golive_milestone: n.is_golive_milestone === 1, status: n.status, opened_at: n.opened_at, closed_at: n.closed_at,
      }, deriveSchedule(n, recs, todayStr), {
        close_blockers: n.status === 'in_progress' ? closeBlockers(n, data.facts) : [],
        ...(n.template_key === 'p_closing' && n.batch_id === null ? { completion_candidates: data.facts.completionCandidates || [] } : {}),
        has_baseline: recs.some((r) => r.kind === 'baseline'),
        plan_write_mode: planWriteMode(recs, data.facts.overall),
        allow_start_note: actions.start === true && canRecordEarlyStart(n, data.facts.overall),
        range_unconfirmed_started: rangeUnconfirmedStarted(n, recs, data.facts.overall),
        report: data.reports[n.id],
        dev_start_ready: data.devStartReady[n.id],
        actions,
      });
    });
    return {
      project: Object.assign({
        id: project.id, build_type: access.buildType, status: project.status,
        estimated_completion: projectCompletion(project.status, nodes.find((node) => node.batch_id === null && node.template_key === 'p_closing'), todayStr),
      }, data.goliveProgress ? { golive_progress: data.goliveProgress } : {}),
      batches, nodes,
    };
  }
  // withGolive = true（GET /plan）：另取各批次的上线信息（最后一条上线事件、是否已正式上线）、actions.golive / revoke_golive 与项目上线进度（C6a）；节点写端点的响应只要节点，不取（上线前置现算较重）。
  async function planViewFor(q, projectId, user, withGolive) {
    const access = await rules.loadProjectAccess(q, projectId, user, accessOpts());
    rules.assertVisible(access);
    const row = await q.get('SELECT build_type FROM sysbuild_projects WHERE id = ?', [projectId]);
    access.buildType = row.build_type;
    const data = await loadPlanData(q, projectId);
    const todayStr = today();
    data.reports = {};
    data.devStartReady = {};
    for (const node of data.nodes) {
      const state = await reports.reportStateOf(q, node, () => todayStr);
      data.devStartReady[node.id] = await reports.devStartReadyOf(q, node, () => todayStr, state);
      data.reports[node.id] = await reports.reportViewOf(q, node, () => todayStr, state);
    }
    if (withGolive === true) {
      data.golive = {};
      for (const b of data.batches) {
        // 只有进行中的批次需要现算上线前置（其余批次 actions.golive 恒由批次状态判假）；与 golive 端点 / 上线前置读接口同一个 goliveCore.goliveBlockersOf
        data.golive[b.id] = {
          info: await goliveCore.goliveInfoOf(q, b.id),
          blockers: b.status === 'active' ? await goliveCore.goliveBlockersOf(q, b) : [],
        };
        data.golive[b.id].info.last_event = await goliveEventView(q, data.golive[b.id].info.last_event);
      }
      data.closingPending = await goliveCore.closingPendingOf(q, projectId);
      data.goliveProgress = await goliveCore.goliveProgressOf(q, projectId);
    }
    const view = buildPlanView(access, data, todayStr);
    if (withGolive === true) {
      view.display_stage_ids = displayStages(view.nodes, view.batches.map((batch) => batch.id)).map((node) => node.id);
    }
    return view;
  }
  async function nodeResponse(q, projectId, nid, user) {
    const view = await planViewFor(q, projectId, user, false);
    return { node: view.nodes.find((n) => n.id === nid) };
  }

  // ── GET /sysbuild/projects/:id/plan ───────────────────────────────────────────────────
  router.get('/sysbuild/projects/:id/plan', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead((q) => planViewFor(q, pid, req.user, true));
    res.json(out);
  }));

  // ── GET /sysbuild/nodes/:nid/schedule：该节点全部排期记录（按 id 升序）────────────────────────
  router.get('/sysbuild/nodes/:nid/schedule', handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const out = await db.withRead(async (q) => {
      const { node, recs } = await loadNodeCtx(q, nid, req.user);
      const records = [];
      // 预筛 D6：is_draft_plan = 该记录写入时节点尚无 baseline（plan_change 且 id 小于 baseline 的 id，或节点至今没有 baseline）。
      //   修订批三 H-1 之后这个标志只回答「写入时有没有基线」，不再等于「草稿期」：总体规划生效后给尚无基线的节点写的改期式计划（带原因与证据）也是 true，
      //   它们的基线在下一次总体规划版本生效时形成；要区分草稿期用 reason / 证据字段或节点视图的 has_baseline。
      const baseline = recs.find((x) => x.kind === 'baseline');
      for (const r of recs) {
        const binds = await q.all("SELECT b.attachment_id AS attachment_id, a.sha256 AS sha256 FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id WHERE b.owner_type = 'schedule_record' AND b.owner_id = ? ORDER BY b.id", [r.id]);
        const actor = await q.get('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [r.created_by]);
        records.push({
          id: r.id, kind: r.kind, planned_start: r.planned_start, planned_end: r.planned_end, actual_date: r.actual_date, corrects_kind: r.corrects_kind,
          reason: r.reason, source_party_id: r.source_party_id, package_version_id: r.package_version_id,
          no_written_evidence: r.no_written_evidence === 1, no_evidence_reason: r.no_evidence_reason,
          is_draft_plan: r.kind === 'plan_change' && (!baseline || r.id < baseline.id),
          attachment_ids: binds.map((b) => b.attachment_id), created_by: r.created_by, created_at: r.created_at,
          attachments: await confirmCore.attachmentView(q, binds), created_by_name: actor ? actor.name : null,
        });
      }
      return { node: { id: node.id, name: node.name, status: node.status }, records };
    });
    res.json(out);
  }));

  // ── PATCH /sysbuild/batches/:bid：改批次名 / 开发承接人 ──────────────────────────────────────
  router.patch('/sysbuild/batches/:bid', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['name', 'dev_assignee_member_id']);
    const givenName = hasKey(body, 'name');
    const givenAssignee = hasKey(body, 'dev_assignee_member_id');
    if (!givenName && !givenAssignee) throw invalid('至少修改一个字段', 'body');
    const name = givenName ? readText(body.name, 'name', '批次名称', NAME_MAX, true) : null;
    let assignee = null;
    if (givenAssignee && body.dev_assignee_member_id !== null) assignee = readIdParam(body.dev_assignee_member_id, 'dev_assignee_member_id', '开发承接人');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      rules.assertOp('batch_update', access, access.project, batchTarget(batch));
      if (givenAssignee && assignee !== null) {
        const ok = await q.get(
          `SELECT m.id AS id FROM sysbuild_members m JOIN sysbuild_parties p ON p.id = m.party_id
            WHERE m.id = ? AND m.project_id = ? AND p.project_id = ? AND p.side = 'dev' AND ${rules.MEMBER_ACTIVE_SQL}`,
          [assignee, batch.project_id, batch.project_id]
        );
        if (!ok) throw stateError('开发承接人须是本项目开发方已加入、未移出的成员');
      }
      const nextName = givenName ? name : batch.name;
      const nextAssignee = givenAssignee ? assignee : batch.dev_assignee_member_id;
      const before = {};
      const after = {};
      if (nextName !== batch.name) { before.name = batch.name; after.name = nextName; }
      if (nextAssignee !== batch.dev_assignee_member_id) { before.dev_assignee_member_id = batch.dev_assignee_member_id; after.dev_assignee_member_id = nextAssignee; }
      const changed = Object.keys(after);
      if (changed.length > 0) {
        const r = await q.run('UPDATE sysbuild_batches SET name = ?, dev_assignee_member_id = ? WHERE id = ? AND status = ?', [nextName, nextAssignee, bid, batch.status]);
        if (r.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
        await emit(q, user, batch.project_id, 'batch', bid, 'batch_updated', { before, after });
      }
      return { batch: { id: bid, name: nextName, dev_assignee_member_id: nextAssignee }, changed };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/start：开始 ───────────────────────────────────────────────────
  router.post('/sysbuild/nodes/:nid/start', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const body = bodyOf(req);
    onlyKeys(body, ['start_note', 'attachment_ids']);
    const note = readText(body.start_note, 'start_note', '开工说明', START_NOTE_MAX, false);
    const submittedIds = body.attachment_ids ?? [];
    if (!Array.isArray(submittedIds) || submittedIds.length > 20) throw invalid('附件编号须为至多 20 项的列表', 'attachment_ids');
    const attachmentIds = submittedIds.map((value) => readIdParam(value, 'attachment_ids', '附件编号'));
    if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('附件编号重复', 'attachment_ids');
    if (!note && attachmentIds.length) throw invalid('附沟通记录时请填写开工说明', 'start_note');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_start', access, access.project, nodeTarget(node, batch, recs, null, undefined, await reports.devStartReadyOf(q, node, today)));
      if (note && !canRecordEarlyStart(node, (await effectiveOverallVersionId(q, node.project_id)) !== null)) {
        throw Object.assign(stateError('当前阶段不需要记录范围确认前的开工说明'), { field: 'start_note' });
      }
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'in_progress', opened_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      const day = today();
      await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [nid, day, Number(user.id)]);
      await emit(q, user, node.project_id, 'node', nid, 'node_started', { actual_date: day });
      if (note) {
        const uid = Number(user.id);
        const snapshot = entriesCore.operatorSnapshotOf(await rules.completeIdentity(q, access, user));
        const eid = await entriesCore.insertEntryRow(q, {
          projectId: node.project_id, nodeId: nid, type: 'note', sourcePartyId: null, operatorUserId: uid,
          snapshotJson: JSON.stringify(snapshot), period: 'process', days: null, businessDate: day,
          title: '范围确认前开工说明', body: note, noEvidence: 0, form: null,
        });
        const bound = attachmentIds.length
          ? await attachmentHelpers.bindStagedAttachments(q, { projectId: node.project_id, userId: uid, attachmentIds, ownerType: 'entry', ownerId: eid, operatorName: operatorNameOf(user) })
          : [];
        await emit(q, user, node.project_id, 'entry', eid, 'entry_created', {
          type: 'note', purpose: 'general', node_id: nid, period: 'process', days_after_close: null,
          source_party_id: null, attachment_ids: bound, no_written_evidence: false, operator_identity: snapshot,
        });
      }
      return nodeResponse(q, node.project_id, nid, user);
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/close：收口 ───────────────────────────────────────────────────
  router.post('/sysbuild/nodes/:nid/close', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const body = bodyOf(req);
    onlyKeys(body, ['complete_node_ids']);
    const completionIds = completion.readCompletionIds(body.complete_node_ids);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_close', access, access.project, nodeTarget(node, batch, recs, null));
      // 业务规则：收口前置检查（与读接口 close_blockers 同一个函数）。
      const day = today();
      const closing = node.template_key === 'p_closing' && node.batch_id === null;
      const blockers = closing ? closeBlockers(node, (await loadPlanData(q, node.project_id)).facts) : [];
      if (blockers.length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });
      if (!closing && completionIds.length) throw completion.ineligibleSelection();
      const completedNodeIds = await completion.completeSelected(q, {
        projectId: node.project_id, excludeId: nid, ids: completionIds, day,
        operatorId: Number(user.id), operatorName: operatorNameOf(user), via: 'closing',
      });
      // codex 17 号 M-1：自动记的实际结束不得早于该节点最后一条实际开始（含更正）——在条件 UPDATE 之前核对。更正端点已拒绝未来日期，
      //   正常路径下不会触发；防御「今天」的取值来源变化（时钟回拨、todayProvider 换源）。
      const lastStart = lastActual(recs, 'actual_start');
      if (lastStart !== null && lastStart > day) throw stateError('实际开始晚于收口日期，请先更正实际开始');
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'closed', closed_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'in_progress'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [nid, day, Number(user.id)]);
      await emit(q, user, node.project_id, 'node', nid, 'node_closed', { actual_date: day });
      // C6a：整体验收结项节点（p_closing）收口 = 整体结项，同一事务里项目 进行中 → 已结项（条件更新）并写项目状态事件（与 projects.js 状态端点的 project_status_changed 同形 { from, to, reason }）；
      //   项目层「结项日」（P95）取最后一条把项目状态改为已结项的事件时刻（entries-core.projectEndedOn）。前置（结项包已生效、批次都已正式上线等）已在上面的 closeBlockers 核过。
      if (closing) {
        const pr = await q.run("UPDATE sysbuild_projects SET status = 'closed', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'active'", [node.project_id]);
        if (pr.changes === 0) throw stateError('项目状态已变化，请刷新后重试');
        await emit(q, user, node.project_id, 'project', node.project_id, 'project_status_changed', { from: 'active', to: 'closed', reason: '整体验收结项节点收口' });
      }
      return Object.assign(await nodeResponse(q, node.project_id, nid, user), { completed_node_ids: completedNodeIds });
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/reopen：只重开指定节点 ───────────────────────────────────
  router.post('/sysbuild/nodes/:nid/reopen', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    onlyKeys(bodyOf(req), ['reason']);
    const reason = readText(bodyOf(req).reason, 'reason', '重开原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_reopen', access, access.project, nodeTarget(node, batch, recs, null));
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      await emit(q, user, node.project_id, 'node', nid, 'node_reopened', { reason });
      const resp = await nodeResponse(q, node.project_id, nid, user);
      resp.cascaded_node_ids = [];
      return resp;
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/cancel：取消（仅批次层、未开始、非里程碑）─────────────────────────
  router.post('/sysbuild/nodes/:nid/cancel', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    onlyKeys(bodyOf(req), ['reason']);
    const reason = readText(bodyOf(req).reason, 'reason', '取消原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access, overallPending } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_cancel', access, access.project, nodeTarget(node, batch, recs, null, overallPending));
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'cancelled', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      await emit(q, user, node.project_id, 'node', nid, 'node_cancelled', { reason });
      return nodeResponse(q, node.project_id, nid, user);
    });
    res.json(out);
  }));

  // ── PATCH /sysbuild/nodes/:nid：改名 ───────────────────────────────────────────────────────
  router.patch('/sysbuild/nodes/:nid', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const body = bodyOf(req);
    onlyKeys(body, ['name']);
    const name = readText(body.name, 'name', '节点名称', NAME_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_rename', access, access.project, nodeTarget(node, batch, recs, null));
      let changed = false;
      if (name !== node.name) {
        const r = await q.run("UPDATE sysbuild_nodes SET name = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status <> 'cancelled'", [name, nid]);
        if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
        await emit(q, user, node.project_id, 'node', nid, 'node_renamed', { before: node.name, after: name });
        changed = true;
      }
      return Object.assign(await nodeResponse(q, node.project_id, nid, user), { changed });
    });
    res.json(out);
  }));

  // ── POST /sysbuild/batches/:bid/nodes：新增自定义节点（追加在本批末尾）───────────────────────────
  router.post('/sysbuild/batches/:bid/nodes', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    const body = bodyOf(req);
    onlyKeys(body, ['name', 'g_stage']);
    const name = readText(body.name, 'name', '节点名称', NAME_MAX, true);
    let gStage = null;
    if (body.g_stage !== undefined && body.g_stage !== null && body.g_stage !== '') {
      if (typeof body.g_stage !== 'string' || !G_STAGES.includes(body.g_stage)) throw invalid(`G 环节必须是 ${G_STAGES.join(' / ')} 之一`, 'g_stage');
      gStage = body.g_stage;
    }
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      rules.assertOp('node_add', access, access.project, batchTarget(batch));
      const mx = await q.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sysbuild_nodes WHERE batch_id = ?', [bid]);
      const ins = await q.run(
        'INSERT INTO sysbuild_nodes (project_id, batch_id, template_key, name, g_stage, sort_order, is_golive_milestone) VALUES (?, ?, NULL, ?, ?, ?, 0)',
        [batch.project_id, bid, name, gStage, mx.m + 10]
      );
      await emit(q, user, batch.project_id, 'node', ins.lastID, 'node_created', {
        template_key: null, name, g_stage: gStage, batch_id: bid, is_golive_milestone: false, source: 'custom',
      });
      return nodeResponse(q, batch.project_id, ins.lastID, user);
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/batches/:bid/node-order：整批重排 ────────────────────────────────────────
  router.post('/sysbuild/batches/:bid/node-order', parseJsonBody, handle(async (req, res) => {
    const bid = readIdParam(req.params.bid, 'bid', '批次编号');
    onlyKeys(bodyOf(req), ['node_ids']);
    const raw = bodyOf(req).node_ids;
    if (!Array.isArray(raw) || raw.length === 0) throw invalid('node_ids 必须是非空数组', 'node_ids');
    const ids = raw.map((v) => readIdParam(v, 'node_ids', '节点编号'));
    if (new Set(ids).size !== ids.length) throw invalid('node_ids 有重复的节点编号', 'node_ids');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { batch, access } = await loadBatchCtx(q, bid, user);
      rules.assertOp('node_reorder', access, access.project, batchTarget(batch));
      // 业务规则：必须恰为本批全部节点（含已取消）的一个排列——缺、多、他批节点都 400。
      const cur = await q.all('SELECT id, sort_order FROM sysbuild_nodes WHERE batch_id = ? ORDER BY sort_order, id', [bid]);
      const curIds = cur.map((n) => n.id);
      if (ids.length !== curIds.length || !ids.every((id) => curIds.includes(id))) throw invalid('node_ids 必须恰为本批全部节点（含已取消）的一个排列', 'node_ids');
      let moved = 0;
      for (let i = 0; i < ids.length; i += 1) {
        const target = (i + 1) * 10;
        const was = cur.find((n) => n.id === ids[i]);
        if (was.sort_order === target) continue;
        const r = await q.run("UPDATE sysbuild_nodes SET sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ? AND batch_id = ?", [target, ids[i], bid]);
        if (r.changes === 0) throw stateError('节点已变化，请刷新后重试');
        moved += 1;
      }
      if (moved > 0) await emit(q, user, batch.project_id, 'batch', bid, 'nodes_reordered', { before: curIds, after: ids });
      return { batch_id: bid, node_ids: ids, changed: moved > 0 };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/schedule：计划（草稿期 / 改期）与实际日期更正 ───────────────────────
  // kind='plan'：按 planWriteMode 处理首排和改期。改期须写原因，推迟项目层结项的计划结束还须证据。
  //   总体规划**待确认**期间（P34）本项目节点一律不能设计划 / 改期（rules.js schedule_plan 的 overallPending）：总体排期基线是确认对象，排期随提交冻结。
  // kind='actual_correct'：corrects（actual_start / actual_end）+ actual_date + reason。
  router.post('/sysbuild/nodes/:nid/schedule', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const body = bodyOf(req);
    // R2（C6）：开发方来源的改期不再引用关键事项，dev_key_entry_id 键出现即 400（不看值，含 null），先于 kind 与其他字段的校验。
    if (hasKey(body, 'dev_key_entry_id')) throw invalid('不支持的字段 dev_key_entry_id', 'dev_key_entry_id');
    const kind = body.kind;
    if (kind !== 'plan' && kind !== 'actual_correct') throw invalid('kind 必须是 plan 或 actual_correct', 'kind');
    // 严格键白名单（预筛 L8）：多余的键 400，不静默忽略。
    if (kind === 'plan') onlyKeys(body, ['kind', 'planned_start', 'planned_end', 'reason', 'source_party_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
    else onlyKeys(body, ['kind', 'corrects', 'actual_date', 'reason']);
    const user = req.user;
    const uid = Number(user.id);
    if (kind === 'actual_correct') {
      if (body.corrects !== 'actual_start' && body.corrects !== 'actual_end') throw invalid('corrects 必须是 actual_start 或 actual_end', 'corrects');
      const corrects = body.corrects;
      const actualDate = readDate(body.actual_date, 'actual_date', '实际日期');
      // codex 17 号 M-1：实际日期 = 已发生的日期，不得晚于今天（today 取自 todayProvider）；否则进行中节点可把实际开始改成未来，当天收口就写出倒置的实际日期。
      if (actualDate > today()) throw invalid('实际日期不能晚于今天', 'actual_date');
      const reason = readText(body.reason, 'reason', '更正原因', REASON_MAX, true);
      const out = await db.withWriteTxn(async (q) => {
        const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
        rules.assertOp('schedule_correct', access, access.project, nodeTarget(node, batch, recs, corrects));
        // 预筛 D7：更正后实际开始不得晚于实际结束（节点已收口时才有实际结束），实际结束不得早于实际开始。
        const startAfter = corrects === 'actual_start' ? actualDate : lastActual(recs, 'actual_start');
        const endAfter = corrects === 'actual_end' ? actualDate : (node.status === 'closed' ? lastActual(recs, 'actual_end') : null);
        if (startAfter !== null && endAfter !== null && startAfter > endAfter) {
          throw invalid(corrects === 'actual_start' ? '更正后的实际开始不能晚于实际结束' : '更正后的实际结束不能早于实际开始', 'actual_date');
        }
        const prev = lastActual(recs, corrects);
        const ins = await q.run(
          "INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, corrects_kind, reason, created_by) VALUES (?, 'actual_correct', ?, ?, ?, ?)",
          [nid, actualDate, corrects, reason, uid]
        );
        await emit(q, user, node.project_id, 'node', nid, 'node_actual_corrected', { record_id: ins.lastID, corrects, before: prev, after: actualDate, reason });
        return Object.assign(await nodeResponse(q, node.project_id, nid, user), { record_id: ins.lastID });
      });
      return res.status(201).json(out);
    }
    // kind = 'plan'
    const plannedStart = readDate(body.planned_start, 'planned_start', '计划开始');
    const plannedEnd = readDate(body.planned_end, 'planned_end', '计划结束');
    if (plannedStart > plannedEnd) throw invalid('计划开始不能晚于计划结束', 'planned_end');
    const reason = readText(body.reason, 'reason', '原因', REASON_MAX, false);
    let sourcePartyId = null;
    if (body.source_party_id !== undefined && body.source_party_id !== null) sourcePartyId = readIdParam(body.source_party_id, 'source_party_id', '提出方');
    let attachmentIds = [];
    if (body.attachment_ids !== undefined && body.attachment_ids !== null) {
      if (!Array.isArray(body.attachment_ids)) throw invalid('附件编号列表格式不对', 'attachment_ids');
      attachmentIds = body.attachment_ids.map((v) => readIdParam(v, 'attachment_ids', '附件编号'));
      if (new Set(attachmentIds).size !== attachmentIds.length) throw invalid('附件编号重复', 'attachment_ids');
    }
    if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
    const noEvidence = body.no_written_evidence === true;
    const noEvidenceReason = readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', REASON_MAX, false);
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access, overallPending } = await loadNodeCtx(q, nid, user);
      rules.assertOp('schedule_plan', access, access.project, nodeTarget(node, batch, recs, null, overallPending));
      const cur = deriveSchedule(node, recs, today()).current_plan;
      const same = !!cur && cur.start === plannedStart && cur.end === plannedEnd;
      const hasEffectiveOverall = (await effectiveOverallVersionId(q, node.project_id)) !== null;
      const mode = planWriteMode(recs, hasEffectiveOverall);
      if (mode === 'draft') {
        // 草稿期或首排只收计划与原因；改期字段返回 400。
        if (sourcePartyId !== null || attachmentIds.length > 0 || body.no_written_evidence !== undefined || noEvidenceReason !== null) {
          const message = hasEffectiveOverall
            ? '首次排期只填写计划日期和可选原因'
            : '形成基线之前的计划修改不需要提出方、证据附件或无书面证据说明';
          throw invalid(message, 'body');
        }
        if (same) throw invalid('新计划与当前计划相同，无需修改', 'planned_start');
        const loggedReason = reason ?? (hasEffectiveOverall ? FIRST_PLAN_REASON : DRAFT_PLAN_REASON);
        const ins = await q.run(
          "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, created_by) VALUES (?, 'plan_change', ?, ?, ?, ?)",
          [nid, plannedStart, plannedEnd, loggedReason, uid]
        );
        await emit(q, user, node.project_id, 'node', nid, 'node_plan_set', {
          record_id: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd }, reason: loggedReason, draft: !hasEffectiveOverall,
        });
        return Object.assign(await nodeResponse(q, node.project_id, nid, user), { record_id: ins.lastID });
      }
      // 统一核对改期原因及所附证据。
      if (reason === null) throw invalid('改期必须填写原因', 'reason');
      if (sourcePartyId !== null) {
        const party = await q.get('SELECT id, side FROM sysbuild_parties WHERE id = ? AND project_id = ?', [sourcePartyId, node.project_id]);
        if (!party) throw invalid('提出方不是本项目的参与方', 'source_party_id');
      }
      if (same) throw invalid('新计划与当前计划相同', 'planned_start');
      if (noEvidence && attachmentIds.length > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');
      if (!noEvidence && noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');
      const evidenceRequired = node.batch_id === null && node.template_key === 'p_closing' && cur && plannedEnd > cur.end;
      if (evidenceRequired && !noEvidence && attachmentIds.length === 0) {
        throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '改期须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）');
      }
      if (noEvidence && (noEvidenceReason === null || Array.from(noEvidenceReason).length < EVIDENCE_REASON_MIN)) {
        throw invalid(`无书面证据原因至少 ${EVIDENCE_REASON_MIN} 个字`, 'no_evidence_reason');
      }
      const ins = await q.run(
        "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, source_party_id, no_written_evidence, no_evidence_reason, created_by) VALUES (?, 'plan_change', ?, ?, ?, ?, ?, ?, ?)",
        [nid, plannedStart, plannedEnd, reason, sourcePartyId, noEvidence ? 1 : 0, noEvidence ? noEvidenceReason : null, uid]
      );
      const bound = attachmentIds.length > 0
        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: node.project_id, userId: uid, attachmentIds, ownerType: 'schedule_record', ownerId: ins.lastID, operatorName: operatorNameOf(user) })
        : [];
      await emit(q, user, node.project_id, 'node', nid, 'node_rescheduled', {
        record_id: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd }, reason, source_party_id: sourcePartyId,
        no_written_evidence: noEvidence, no_evidence_reason: noEvidence ? noEvidenceReason : null, attachment_ids: bound,
      });
      // C6b（§4.4 知会）：正式上线里程碑的计划结束日期推后 → 同一事务给每个需求部门现任负责人生成改期知会与发送意图（提前 / 同日 / 非里程碑不生成）；草稿期分支不走到这里
      await notifySchedule.createScheduleNotices(q, user, { projectId: node.project_id, node, recordId: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd } });
      return Object.assign(await nodeResponse(q, node.project_id, nid, user), { record_id: ins.lastID });
    });
    return res.status(201).json(out);
  }));

  return { router };
}

// 批次顺序由调用方按 seq、id 提供。每组沿用原有阶段顺序，结项单独放在最后。
function displayStages(nodes, batchIds) {
  const project = [];
  const closing = [];
  const batches = Object.fromEntries(batchIds.map((id) => [id, []]));
  for (const node of nodes) {
    if (node.status === 'cancelled') continue;
    if (node.batch_id !== null) batches[node.batch_id]?.push(node);
    else if (node.template_key === 'p_closing') closing.push(node);
    else project.push(node);
  }
  return [...project, ...batchIds.flatMap((id) => batches[id]), ...closing];
}

module.exports = { createPlanRoutes, closeBlockers, deriveSchedule, projectCompletion, rangeUnconfirmedStarted, displayStages };
