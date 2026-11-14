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
const confirmCore = require('./confirm-core');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { G_STAGES } = require('./templates');
const { effectiveOverallVersionId } = require('./packages');
const entriesCore = require('./entries-core'); // C5 S-S1b：收口前置读登记事实（entries-core 只依赖 rules / db / events / confirm-core，不依赖本文件，不成环）
const goliveCore = require('./golive-core'); // C6a：批次视图的上线信息与 actions、项目上线进度（golive-core 不依赖本文件，不成环）
const notifySchedule = require('./notify-schedule'); // C6b：改期知会的生成（只依赖 events / confirm-core / notify-core，不成环）

const NAME_MAX = 60;
const REASON_MAX = 500;
const EVIDENCE_REASON_MIN = 10;
// 草稿期计划（形成基线之前）原因可选；库内 plan_change 的 CHECK 要求原因非空，所以没填时写这句固定文案。
const DRAFT_PLAN_REASON = '草稿期计划';

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

// ── 收口前置检查（读接口与收口端点共用这一个函数）──────────────────────────────────────────
// 输入 = 本项目全部节点的精简视图 [{ id, batch_id, template_key, status, current_plan }]（调用方先取数 + deriveSchedule）。
// 返回阻塞项数组 [{ code, message, node_ids }]；空数组 = 前置满足。
//   C3a 只有两条（方案 v1.2 §4.4）：
//     ① 收口「批次需求确认」（b_req）：本批全部未取消节点都须有当前计划（起止都有）；
//     ② 收口「总体范围与批次规划」（p_overall）：全部未取消的项目层节点都须有当前计划。
//   C4a 修订批加「内容包已生效」（方案 §3.1 / §3.2 / §4.4；C4 增项），code = PACKAGE_NOT_EFFECTIVE，node_ids = [本节点]，排在 PLAN_MISSING 之后：
//     ③ 收口「立项与授权」（p_initiation）：项目立项包须有生效版本；
//     ④ 收口「总体范围与批次规划」（p_overall）：总体规划包须有生效版本；
//     ⑤ 收口「需求确认」（批次层 b_req）：第一期单批由总体规划包（合并形态）承载批次需求（P19），以总体规划包已有生效版本为前置；
//        C5 / 第二期交接：开放多批次后，批次层需求确认应改看**本批**的批次需求包（batch_req）是否生效，而不是项目级的总体规划包（P41 同一条交接）；
//     ⑥ 收口「用户验收测试」（b_uat）：本批批次验收包须有生效版本。批次验收包的提交在 C6 才开放，所以 C6 之前该节点（外包类）收口恒被阻塞——这是有意的收紧，
//        不是缺陷（自研没有 b_uat 节点，采购类的验收并入 b_training，本批不覆盖，C6 另定）。
//   facts = 本项目已生效内容包的事实（loadPlanData 取数）：{ initiation: bool, overall: bool, batchAccept: { [批次编号]: true } }；缺失按「都未生效」处理（fail-closed）。
//   C5 再加：「本节点办理类过程登记均有结论」（方案 §4.1、§4.5）。
function closeBlockers(node, allNodes, facts) {
  const f = facts || {};
  const out = [];
  let scope = null;
  let message = '';
  if (node.template_key === 'b_req') {
    scope = allNodes.filter((n) => n.batch_id === node.batch_id && n.status !== 'cancelled');
    message = '本批全部未取消的节点都须先有计划起止日期，才能收口需求确认';
  } else if (node.template_key === 'p_overall') {
    scope = allNodes.filter((n) => n.batch_id === null && n.status !== 'cancelled');
    message = '全部未取消的项目层节点都须先有计划起止日期，才能收口总体范围与批次规划';
  }
  if (scope !== null) {
    const missing = scope.filter((n) => !n.current_plan).map((n) => n.id);
    if (missing.length > 0) out.push({ code: 'PLAN_MISSING', message, node_ids: missing });
  }
  // 注意 b_req 一行（⑤）：第一期单批，项目级总体规划包承载批次需求；开放多批次后必须改看本批的批次需求包（见上面 ⑤ 的交接说明），不能沿用 f.overall。
  let pkgMessage = null;
  if (node.template_key === 'p_initiation' && f.initiation !== true) pkgMessage = '项目立项包还没有生效版本，不能收口立项与授权';
  else if (node.template_key === 'p_overall' && f.overall !== true) pkgMessage = '总体规划包还没有生效版本，不能收口总体范围与批次规划';
  else if (node.template_key === 'b_req' && f.overall !== true) pkgMessage = '总体规划包（第一期单批由它承载本批需求）还没有生效版本，不能收口需求确认';
  else if (node.template_key === 'b_uat' && !(f.batchAccept && f.batchAccept[node.batch_id] === true)) pkgMessage = '本批批次验收包还没有生效版本，不能收口用户验收测试';
  else if (node.template_key === 'p_closing' && !(f.closing && typeof f.closing.closingEffectiveAt === 'string')) pkgMessage = '结项包还没有生效版本，不能收口整体验收结项'; // C6a
  if (pkgMessage !== null) out.push({ code: 'PACKAGE_NOT_EFFECTIVE', message: pkgMessage, node_ids: [node.id] });
  // C6a 整体验收结项（p_closing）的收口前置（方案 §2.3 :443、§4.3 v1.5；facts.closing = entries-core.closingFactsOf，与结项包提交前置同一个函数）：
  //   ② 每个有效批次（非已转出 / 被替代）都已正式上线（batchLiveState，P106 口径），已转出批次须有已生效的变更包（第一期不可达，照写）；
  //   ③ 结项包的生效时刻晚于每个批次最后一条上线事件（撤销后再上线，结项包须重新确认，P141）；
  //   ①（结项包已生效）在上面的 PACKAGE_NOT_EFFECTIVE，④（项目整体的未结过程登记）在下面的 ENTRY_UNRESOLVED。事实没取到（不是对象）fail-closed 报 CLOSING_FACTS_MISSING。
  if (node.template_key === 'p_closing') {
    const cl = f.closing;
    if (!cl || typeof cl !== 'object' || !Array.isArray(cl.notLive) || !Array.isArray(cl.transferNoChange) || !Array.isArray(cl.goliveNewer)
      || typeof cl.closingStale !== 'boolean' || !Array.isArray(cl.packagePending)) {
      out.push({ code: 'CLOSING_FACTS_MISSING', message: '无法确定批次上线情况，请刷新后重试', node_ids: [node.id] });
    } else {
      const names = (arr) => arr.map((b) => b.name).join('、');
      // P168：结项包确认时引用的总体规划已被正式变更换版，须在现行规划上重新确认结项包；P164：项目里有待确认的内容包版本时先处理完（任何类型）。
      if (cl.closingStale === true && typeof cl.closingEffectiveAt === 'string') {
        out.push({ code: 'CLOSING_STALE', message: '结项包确认时引用的总体规划已被变更替换，须基于现行总体规划重新提交结项包并确认', node_ids: [node.id] });
      }
      if (cl.packagePending.length > 0) {
        out.push({ code: 'PACKAGE_PENDING', message: `项目里还有待确认的内容包（${cl.packagePending.map((t) => rules.PACKAGE_TYPE_LABELS[t] || t).join('、')}），须先处理完再整体验收结项`, node_ids: [node.id] });
      }
      if (cl.notLive.length > 0) out.push({ code: 'BATCH_NOT_LIVE', message: `以下批次还没有正式上线，不能整体验收结项：${names(cl.notLive)}`, node_ids: [node.id], batch_ids: cl.notLive.map((b) => b.id) });
      if (cl.transferNoChange.length > 0) out.push({ code: 'TRANSFER_CHANGE_MISSING', message: `以下已转出的批次没有已生效的变更包：${names(cl.transferNoChange)}`, node_ids: [node.id], batch_ids: cl.transferNoChange.map((b) => b.id) });
      if (cl.goliveNewer.length > 0) {
        out.push({
          code: 'CLOSING_BEFORE_GOLIVE', message: `结项包的生效时刻不晚于以下批次最后一条上线事件，须重新确认结项包：${names(cl.goliveNewer)}`, node_ids: [node.id], batch_ids: cl.goliveNewer.map((b) => b.id),
        });
      }
    }
  }
  // C5 S-S1b（方案 §4.1、§4.5）：本节点下「过程登记里办理类（意见与反馈、问题与处理）、未作废、没有有效结论」的登记（含拆出的处理项；已拆分容器按子项判；有未解决异议都算未结）阻塞收口；
  //   知悉类不阻塞。项目整体（node_id 为空）的过程登记阻塞「整体验收结项」（p_closing）——该节点的收口随 C6 开放，这里先写好。
  //   取数由 loadPlanData 做（entries-core.unresolvedProcessEntriesOf，「已结」口径只有 entries-core.entryResolved 一份）。fail-closed：facts 没带登记事实（不是数组）→ 报 ENTRY_FACTS_MISSING，
  //   不静默当作「没有未结登记」。
  if (!Array.isArray(f.entryUnresolved)) {
    out.push({ code: 'ENTRY_FACTS_MISSING', message: '无法确定本节点的过程登记是否都有结论，请刷新后重试', node_ids: [node.id] });
  } else {
    const mine = f.entryUnresolved.filter((e) => e.node_id === node.id || (node.template_key === 'p_closing' && e.node_id === null));
    if (mine.length > 0) {
      out.push({ code: 'ENTRY_UNRESOLVED', message: `本节点还有 ${mine.length} 条过程登记（意见与反馈、问题与处理）没有有效结论，须先办理完`, node_ids: [node.id], entry_ids: mine.map((e) => e.id) });
    }
  }
  return out;
}

// 收口前置里「内容包已生效」那几条（上面 closeBlockers 的 pkgMessage 分支）所依赖的包：{ type, batchId, label }，不依赖内容包的节点返回 null。
//   C4b Q-S2 H4（P68 ⑥）：历史导入收口时除了「现在已生效」（closeBlockers），还要核对收口原日期不早于该包的生效日（history.js loadNodeFact 单独接收原日期）。
//   这张表与 closeBlockers 的 pkgMessage 分支必须一一对应——history 套件有对拍用例，逐模板键证明两件事：① 有 PACKAGE_NOT_EFFECTIVE 的键集合 = 这里非 null 的键集合；
//   ② 对这里每个非 null 的键，只让表里写的那个包生效时 closeBlockers 不报、去掉它或只让别的包生效时报（批次验收包另核按批次）。对拍不会替你改表：改 closeBlockers 的包前置时必须同改本表。
//   C5 改 b_req 前置为「本批批次需求包」（上面 ⑤ 的交接）时，须同改本表。
function closePackageRequirement(node) {
  if (node.template_key === 'p_initiation') return { type: 'initiation', batchId: null, label: '项目立项包' };
  if (node.template_key === 'p_overall') return { type: 'overall', batchId: null, label: '总体规划包' };
  if (node.template_key === 'b_req') return { type: 'overall', batchId: null, label: '总体规划包' }; // 第一期单批：总体规划包承载批次需求（P19，同 closeBlockers ⑤）
  if (node.template_key === 'b_uat') return { type: 'batch_accept', batchId: node.batch_id, label: '批次验收包' };
  if (node.template_key === 'p_closing') return { type: 'closing', batchId: null, label: '结项包' }; // C6a：整体验收结项 ← 结项包（同 closeBlockers 的 p_closing 分支）
  return null;
}

// 计划写入的两种方式（读接口节点视图的 plan_write_mode 与 POST schedule 的分支共用这一个函数，读写同源）。codex 19 号 H-1 / P43 撤销了 C3a 预筛 D8 / C4a 交接 ① 的
//   「总体规划生效后首次计划即基线」：基线只能来自被确认的计划，生效后才写的日期从未进入任何版本的确认对象，不能直接引用已生效版本形成基线。现在：
//   'draft'      = 项目还没有生效的总体规划版本（草稿期计划）：原因可选、不要证据，写 plan_change；
//   'reschedule' = 项目已有生效的总体规划版本（节点有没有基线都一样）：改期式写入——原因必填、证据必填（附件或无书面证据声明）、同一套校验与 node_rescheduled 事件，
//                  写 plan_change；**无基线的节点不写 baseline**，它的基线在下一次总体规划版本生效时（confirm-core.formBaselines）由当时的当前计划形成。
//   节点是否已有基线另由节点视图的 has_baseline 给出（页面区分「改的是基线」还是「尚无基线的新计划」）。
function planWriteMode(hasBaseline, hasEffectiveOverall) {
  return hasBaseline || hasEffectiveOverall ? 'reschedule' : 'draft';
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
  const REC_COLS = 'id, node_id, kind, planned_start, planned_end, actual_date, corrects_kind, reason, source_party_id, dev_key_entry_id, package_version_id, no_written_evidence, no_evidence_reason, created_by, created_at';
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
    // C4a 修订批：已生效内容包的事实（收口前置 PACKAGE_NOT_EFFECTIVE 用）与总体规划是否待确认（P34 排期冻结用）。
    const effRows = await q.all(
      `SELECT p.type AS type, p.batch_id AS batch_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
        WHERE p.project_id = ? AND v.status = 'effective'`,
      [projectId]
    );
    //   「有无生效的总体规划」读 packages.js effectiveOverallVersionId——与 POST schedule 写端点（planWriteMode）、现行版本解析同一个来源（修订批二 LOW-3），
    //   读写两端不会各自算出不同的答案；立项包 / 批次验收包的事实仍取自上面这条查询。
    const facts = { initiation: false, overall: (await effectiveOverallVersionId(q, projectId)) !== null, batchAccept: {} };
    for (const r of effRows) {
      if (r.type === 'initiation') facts.initiation = true;
      else if (r.type === 'batch_accept' && r.batch_id !== null) facts.batchAccept[r.batch_id] = true;
    }
    // C5 S-S1b：过程登记里未结的办理类登记（收口前置 ENTRY_UNRESOLVED）与各节点「收口后未结异议」条数（节点视图 post_close_objections_open）
    facts.entryUnresolved = await entriesCore.unresolvedProcessEntriesOf(q, projectId);
    // C6a：整体验收结项的收口前置事实（结项包生效时刻、批次上线情况；与结项包提交前置同一个函数 entries-core.closingFactsOf）
    facts.closing = await entriesCore.closingFactsOf(q, projectId);
    const postCloseObjections = await entriesCore.postCloseObjectionsOf(q, projectId);
    return { batches, nodes, recsByNode, activeAssignees, facts, postCloseObjections, overallPending: await overallPendingOf(q, projectId) };
  }
  // 本项目的总体规划包有待确认的版本？（P34：待确认期间排期随包冻结，节点排期 / 取消节点被拒；读接口 actions 与写端点都取这一个事实。）
  //   C6a：与上线前置 PLAN_PENDING、上线事件历史导入共用 golive-core.planPendingOf（同一个查询，不另写）。
  async function overallPendingOf(q, projectId) {
    return goliveCore.planPendingOf(q, projectId);
  }

  // target 构造（读写两端同一份）：rules.OBJECT_OPS 的 state 只认这些字段。
  const batchTarget = (batch) => ({ batchStatus: batch.status });
  function nodeTarget(node, batch, recs, corrects, overallPending) {
    return {
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
    const derived = {};
    const brief = data.nodes.map((n) => {
      const d = deriveSchedule(n, data.recsByNode[n.id] || [], todayStr);
      derived[n.id] = d;
      return { id: n.id, batch_id: n.batch_id, template_key: n.template_key, status: n.status, current_plan: d.current_plan };
    });
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
      for (const [flag, op, corrects] of NODE_ACTION_OPS) actions[flag] = rules.opAllowed(op, access, project, nodeTarget(n, batch, recs, corrects, data.overallPending));
      return Object.assign({
        id: n.id, batch_id: n.batch_id, template_key: n.template_key, name: n.name, g_stage: n.g_stage, sort_order: n.sort_order,
        is_golive_milestone: n.is_golive_milestone === 1, status: n.status, opened_at: n.opened_at, closed_at: n.closed_at,
      }, derived[n.id], {
        close_blockers: n.status === 'in_progress' ? closeBlockers(n, brief, data.facts) : [],
        // C5 S-S1b（D34）：节点收口后的异议补充登记里还没有结论的条数（节点卡片「收口后有未结异议 N 条」；C6 上线交接读它）
        post_close_objections_open: hasKey(data.postCloseObjections, n.id) ? data.postCloseObjections[n.id] : 0,
        // 计划写入方式（预筛 M2；修订批三 H-1 改为 draft / reschedule 两态）：与 POST schedule 的分支共用 planWriteMode；has_baseline 让页面区分
        //   「改期的是基线」与「总体规划生效后新增、尚无基线的计划」（后者同样要原因与证据，但不写基线）。
        has_baseline: recs.some((r) => r.kind === 'baseline'),
        plan_write_mode: planWriteMode(recs.some((r) => r.kind === 'baseline'), data.facts.overall),
        actions,
      });
    });
    return {
      project: Object.assign({ id: project.id, build_type: access.buildType, status: project.status }, data.goliveProgress ? { golive_progress: data.goliveProgress } : {}),
      batches, nodes,
    };
  }
  // withGolive = true（GET /plan）：另取各批次的上线信息（最后一条上线事件、是否已正式上线）、actions.golive / revoke_golive 与项目上线进度（C6a）；节点写端点的响应只要节点，不取（交接集合现算较重）。
  async function planViewFor(q, projectId, user, withGolive) {
    const access = await rules.loadProjectAccess(q, projectId, user, accessOpts());
    rules.assertVisible(access);
    const row = await q.get('SELECT build_type FROM sysbuild_projects WHERE id = ?', [projectId]);
    access.buildType = row.build_type;
    const data = await loadPlanData(q, projectId);
    if (withGolive === true) {
      data.golive = {};
      for (const b of data.batches) {
        // 只有进行中的批次需要现算上线前置（其余批次 actions.golive 恒由批次状态判假）；与 golive 端点 / 交接读接口同一个 goliveCore.handoverViewOf
        data.golive[b.id] = {
          info: await goliveCore.goliveInfoOf(q, b.id),
          blockers: b.status === 'active' ? (await goliveCore.handoverViewOf(q, b)).blockers : [],
        };
      }
      data.closingPending = await goliveCore.closingPendingOf(q, projectId);
      data.goliveProgress = await goliveCore.goliveProgressOf(q, projectId);
    }
    return buildPlanView(access, data, today());
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
          reason: r.reason, source_party_id: r.source_party_id, dev_key_entry_id: r.dev_key_entry_id, package_version_id: r.package_version_id,
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
    onlyKeys(bodyOf(req), []);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_start', access, access.project, nodeTarget(node, batch, recs, null));
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'in_progress', opened_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      const day = today();
      await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [nid, day, Number(user.id)]);
      await emit(q, user, node.project_id, 'node', nid, 'node_started', { actual_date: day });
      return nodeResponse(q, node.project_id, nid, user);
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/close：收口 ───────────────────────────────────────────────────
  router.post('/sysbuild/nodes/:nid/close', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    onlyKeys(bodyOf(req), []);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_close', access, access.project, nodeTarget(node, batch, recs, null));
      // 业务规则：收口前置检查（与读接口 close_blockers 同一个函数）。
      const data = await loadPlanData(q, node.project_id);
      const day = today();
      const brief = data.nodes.map((n) => ({ id: n.id, batch_id: n.batch_id, template_key: n.template_key, status: n.status, current_plan: deriveSchedule(n, data.recsByNode[n.id] || [], day).current_plan }));
      const blockers = closeBlockers(node, brief, data.facts);
      if (blockers.length > 0) throw Object.assign(makeError(409, 'SYSBUILD_CLOSE_BLOCKED', '收口前置条件未满足'), { blockers });
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
      if (node.template_key === 'p_closing' && node.batch_id === null) {
        const pr = await q.run("UPDATE sysbuild_projects SET status = 'closed', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'active'", [node.project_id]);
        if (pr.changes === 0) throw stateError('项目状态已变化，请刷新后重试');
        await emit(q, user, node.project_id, 'project', node.project_id, 'project_status_changed', { from: 'active', to: 'closed', reason: '整体验收结项节点收口' });
      }
      return nodeResponse(q, node.project_id, nid, user);
    });
    res.json(out);
  }));

  // ── POST /sysbuild/nodes/:nid/reopen：重开（N-D1：同一层排在它之后、已收口的节点一并退回进行中）────────────
  router.post('/sysbuild/nodes/:nid/reopen', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    onlyKeys(bodyOf(req), ['reason']);
    const reason = readText(bodyOf(req).reason, 'reason', '重开原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { node, batch, recs, access } = await loadNodeCtx(q, nid, user);
      rules.assertOp('node_reopen', access, access.project, nodeTarget(node, batch, recs, null));
      // 同一层 = 同一 batch_id（项目层 batch_id 为空，用 IS 比较）；只取 sort_order 更大且已收口的节点。
      const later = await q.all(
        "SELECT id, is_golive_milestone FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS ? AND sort_order > ? AND status = 'closed' ORDER BY sort_order, id",
        [node.project_id, node.batch_id, node.sort_order]
      );
      // 预筛 D2：级联范围里有已收口的正式上线里程碑 → 整个重开不发生（里程碑状态由上线事件 / 撤销上线决定，不能被级联退回；C6 撤销上线时再定）。
      if (later.some((l) => l.is_golive_milestone === 1)) throw stateError('下游含已收口的正式上线里程碑，须先撤销上线');
      const r = await q.run(
        "UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'",
        [nid]
      );
      if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
      await emit(q, user, node.project_id, 'node', nid, 'node_reopened', { reason });
      for (const l of later) {
        const rc = await q.run(
          "UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'",
          [l.id]
        );
        if (rc.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
        await emit(q, user, node.project_id, 'node', l.id, 'node_cascade_reopened', { cause_node_id: nid, reason });
      }
      const resp = await nodeResponse(q, node.project_id, nid, user);
      resp.cascaded_node_ids = later.map((l) => l.id);
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
  // kind='plan'：项目还没有生效的总体规划版本 = 草稿期计划（追加 plan_change，原因可选；只收 planned_start / planned_end / reason）；
  //   已有生效的总体规划版本 = 改期式写入（原因必填、来源参与方可空、开发方来源 409、方向类证据必填；追加 plan_change）——节点已有 baseline 与否一样（planWriteMode，
  //   读接口节点视图的 plan_write_mode / has_baseline 同源）。baseline 只由总体规划包生效时形成（C4a，confirm-core.formBaselines）；本端点任何分支都不写 baseline
  //   （codex 19 号 H-1 / P43：生效后才写的日期从未被确认，不能直接成为基线；无基线的节点下一次总体规划版本生效时由当时的当前计划形成基线）。
  //   总体规划**待确认**期间（P34）本项目节点一律不能设计划 / 改期（rules.js schedule_plan 的 overallPending）：总体排期基线是确认对象，排期随提交冻结。
  // kind='actual_correct'：corrects（actual_start / actual_end）+ actual_date + reason。
  router.post('/sysbuild/nodes/:nid/schedule', parseJsonBody, handle(async (req, res) => {
    const nid = readIdParam(req.params.nid, 'nid', '节点编号');
    const body = bodyOf(req);
    const kind = body.kind;
    if (kind !== 'plan' && kind !== 'actual_correct') throw invalid('kind 必须是 plan 或 actual_correct', 'kind');
    // 严格键白名单（预筛 L8）：多余的键 400，不静默忽略。
    if (kind === 'plan') onlyKeys(body, ['kind', 'planned_start', 'planned_end', 'reason', 'source_party_id', 'dev_key_entry_id', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
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
    // C5 S-S1c：开发方提出的改期引用开发方负责人已认可的关键事项登记（dev_key_entry_id，写入改期记录）；非开发方来源不许带
    let devKeyEntryId = null;
    if (body.dev_key_entry_id !== undefined && body.dev_key_entry_id !== null) devKeyEntryId = readIdParam(body.dev_key_entry_id, 'dev_key_entry_id', '关键事项登记');
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
      const hasBaseline = recs.some((r) => r.kind === 'baseline');
      const cur = deriveSchedule(node, recs, today()).current_plan;
      const same = !!cur && cur.start === plannedStart && cur.end === plannedEnd;
      const mode = planWriteMode(hasBaseline, (await effectiveOverallVersionId(q, node.project_id)) !== null);
      if (mode === 'draft') {
        // 草稿期（项目还没有生效的总体规划版本）：只收计划与原因；带了改期专用的字段就 400，不静默丢弃。
        if (sourcePartyId !== null || devKeyEntryId !== null || attachmentIds.length > 0 || body.no_written_evidence !== undefined || noEvidenceReason !== null) {
          throw invalid('形成基线之前的计划修改不需要提出方、证据附件或无书面证据说明', 'body');
        }
        if (same) throw invalid('新计划与当前计划相同，无需修改', 'planned_start');
        const ins = await q.run(
          "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, created_by) VALUES (?, 'plan_change', ?, ?, ?, ?)",
          [nid, plannedStart, plannedEnd, reason === null ? DRAFT_PLAN_REASON : reason, uid]
        );
        // 预筛 D6：事件里的原因与库内记录一致（没填写固定文案），并标 draft: true。
        await emit(q, user, node.project_id, 'node', nid, 'node_plan_set', {
          record_id: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd }, reason: reason === null ? DRAFT_PLAN_REASON : reason, draft: true,
        });
        return Object.assign(await nodeResponse(q, node.project_id, nid, user), { record_id: ins.lastID });
      }
      // 改期式写入（mode === 'reschedule'）：节点已有基线的改期，或总体规划生效后尚无基线的节点写计划（含之后新增的自定义节点；H-1 / P43，不写 baseline）——同一套校验与事件。
      if (reason === null) throw invalid('改期必须填写原因', 'reason');
      if (sourcePartyId !== null) {
        const party = await q.get('SELECT id, side FROM sysbuild_parties WHERE id = ? AND project_id = ?', [sourcePartyId, node.project_id]);
        if (!party) throw invalid('提出方不是本项目的参与方', 'source_party_id');
        if (party.side === 'dev') {
          if (devKeyEntryId === null) throw stateError('开发方提出的改期须引用开发方负责人已认可的关键事项（dev_key_entry_id）');
          // 引用的登记：本项目（不存在 / 别的项目 400，不借此探测）、来源方就是本次提出方（开发方）、已认可且未作废（否则 409，文案说明原因）
          const ke = await q.get(`SELECT ${entriesCore.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [devKeyEntryId, node.project_id]);
          if (!ke) throw invalid('引用的关键事项登记不存在或不属于本项目', 'dev_key_entry_id');
          if (ke.source_party_id !== sourcePartyId) throw stateError('引用的关键事项必须是本次提出方（开发方）的登记');
          const ap = await entriesCore.devApprovalUsable(q, ke);
          if (!ap.ok) throw stateError(`引用的关键事项未认可：${ap.reason}`);
        } else if (devKeyEntryId !== null) {
          throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');
        }
      } else if (devKeyEntryId !== null) {
        throw invalid('只有开发方提出的改期需要引用关键事项', 'dev_key_entry_id');
      }
      if (same) throw invalid('新计划与当前计划相同', 'planned_start');
      if (noEvidence && attachmentIds.length > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');
      if (!noEvidence && noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');
      if (!noEvidence && attachmentIds.length === 0) {
        throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '改期须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）');
      }
      if (noEvidence && (noEvidenceReason === null || Array.from(noEvidenceReason).length < EVIDENCE_REASON_MIN)) {
        throw invalid(`无书面证据原因至少 ${EVIDENCE_REASON_MIN} 个字`, 'no_evidence_reason');
      }
      const ins = await q.run(
        "INSERT INTO sysbuild_node_schedule_records (node_id, kind, planned_start, planned_end, reason, source_party_id, dev_key_entry_id, no_written_evidence, no_evidence_reason, created_by) VALUES (?, 'plan_change', ?, ?, ?, ?, ?, ?, ?, ?)",
        [nid, plannedStart, plannedEnd, reason, sourcePartyId, devKeyEntryId, noEvidence ? 1 : 0, noEvidence ? noEvidenceReason : null, uid]
      );
      const bound = attachmentIds.length > 0
        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: node.project_id, userId: uid, attachmentIds, ownerType: 'schedule_record', ownerId: ins.lastID, operatorName: operatorNameOf(user) })
        : [];
      await emit(q, user, node.project_id, 'node', nid, 'node_rescheduled', {
        record_id: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd }, reason, source_party_id: sourcePartyId, dev_key_entry_id: devKeyEntryId,
        no_written_evidence: noEvidence, no_evidence_reason: noEvidence ? noEvidenceReason : null, attachment_ids: bound,
      });
      // C6b（§4.4 知会）：正式上线里程碑的计划结束日期推后 → 同一事务给每个需求部门现任负责人生成改期知会与发送意图（提前 / 同日 / 非里程碑不生成）；草稿期分支不走到这里
      await notifySchedule.createScheduleNotices(q, user, { projectId: node.project_id, node, recordId: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd } });
      return Object.assign(await nodeResponse(q, node.project_id, nid, user), { record_id: ins.lastID });
    });
    return res.status(201).json(out);
  }));

  // loadPlanData：历史事实导入的 node_closed（history.js，C4b Q-S2）按收口端点同一份取数 + closeBlockers 核对前置（P57），不复制。
  return { router, loadPlanData };
}

module.exports = { createPlanRoutes, closeBlockers, closePackageRequirement, deriveSchedule };
