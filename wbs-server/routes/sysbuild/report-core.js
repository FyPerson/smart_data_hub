// 汇报事实与应交日：只读。节点视图、开始条件、待办和登记校验共用本文件。
'use strict';
const { makeError } = require('./db');
const { DEVELOPMENT_NODE_KEYS } = require('./templates');
const forms = require('./entry-forms');

const NODE_COLS = 'id, project_id, batch_id, template_key, name, g_stage, sort_order, is_golive_milestone, status, opened_at, closed_at';
const DAY_MS = 86400000;
const DEFAULT_CYCLE = Object.freeze({ outsource: 'weekly', procurement: 'weekly', inhouse: 'biweekly' });
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 9999 && d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
}
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayOf(todayProvider) {
  const value = typeof todayProvider === 'function' ? todayProvider() : new Date();
  const day = value instanceof Date && !Number.isNaN(value.getTime()) ? localDay(value) : value;
  if (!validDay(day)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：日期提供者返回值不合法');
  return day;
}
const utcDay = (day) => Date.parse(day + 'T00:00:00Z');
function addDays(day, days) {
  if (!validDay(day) || !Number.isInteger(days)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：汇报日期不合法');
  return new Date(utcDay(day) + days * DAY_MS).toISOString().slice(0, 10);
}

// §6.1 唯一开发节点判定：模板优先；其次自定义 G3 中最小编号；不读 sort_order。
async function developmentNodeOf(q, batchId) {
  if (!Number.isSafeInteger(batchId) || batchId <= 0) return null;
  const nodes = await q.all(`SELECT ${NODE_COLS} FROM sysbuild_nodes WHERE batch_id = ? AND status <> 'cancelled' ORDER BY id`, [batchId]);
  const template = nodes.find((node) => DEVELOPMENT_NODE_KEYS.includes(node.template_key)); // L2 dev template priority
  if (template) return template;
  return nodes.find((node) => node.template_key === null && typeof node.g_stage === 'string' && node.g_stage.split('+').includes('G3')) || null; // L2 dev custom minimum id
}

function unreadableState(node, today = null) {
  return {
    node, today, is_dev: null, unreadable: true, project: null, batch: null,
    current_plan: null, current_cycle: null, default_cycle: null, cycle_unreadable: false, cycle_unknown: false,
    started_on: null, start_unreadable: true, requests: [], reports: [], latest_report: null,
    unreadable_request_ids: [], unreadable_report_ids: [], unreadable_entry_ids: [],
  };
}
function displayedEntry(entry, actions) {
  return Object.assign({ entry_id: entry.id, title: entry.title, body: entry.body, created_at: entry.created_at }, forms.entryFormView(entry, actions));
}
function reopenDay(event) {
  // 重开日期沿用现有事件的服务端本地时刻；不增加或改写旧事件载荷。
  const day = typeof event.created_at === 'string' ? event.created_at.slice(0, 10) : null;
  return validDay(day) ? day : null;
}

// 状态一次读取可交给同事务内的多个调用方复用；不可读只向视图暴露标志，不泄露底层错误。
async function reportStateOf(q, node, todayProvider) {
  let today = null;
  try {
    today = todayOf(todayProvider);
    const state = unreadableState(node, today);
    if (!node || !Number.isSafeInteger(node.id) || !Number.isSafeInteger(node.project_id)) return state;
    const dev = await developmentNodeOf(q, node.batch_id);
    state.is_dev = !!dev && dev.id === node.id;
    state.unreadable = false;
    if (!state.is_dev) return state;
    state.project = await q.get('SELECT id, status, build_type FROM sysbuild_projects WHERE id = ?', [node.project_id]);
    state.batch = await q.get('SELECT id, project_id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [node.batch_id, node.project_id]);
    if (!state.project || !state.batch) return unreadableState(node, today);
    const recs = await q.all('SELECT id, kind, planned_start, planned_end, actual_date, corrects_kind FROM sysbuild_node_schedule_records WHERE node_id = ? ORDER BY id', [node.id]);
    // 与节点现有视图同源；require 延后，避免 plan → report-core 的初始化环。
    state.current_plan = require('./plan').deriveSchedule(node, recs, today).current_plan;
    if (state.current_plan && (!validDay(state.current_plan.start) || !validDay(state.current_plan.end))) state.current_plan = null;
    const starts = recs.filter((record) => record.kind === 'actual_start'); // L2 start uses actual_start, not corrected date
    const latestStart = starts.length ? starts[starts.length - 1].actual_date : null;
    const events = await q.all("SELECT id, event_type, created_at FROM sysbuild_events WHERE project_id = ? AND object_type = 'node' AND object_id = ? AND event_type IN ('node_reopened', 'node_cascade_reopened') ORDER BY id DESC", [node.project_id, node.id]);
    const direct = events.find((event) => event.event_type === 'node_reopened');
    const cascade = events.find((event) => event.event_type === 'node_cascade_reopened');
    const startDays = [latestStart, direct ? reopenDay(direct) : null, cascade ? reopenDay(cascade) : null];
    state.start_unreadable = (latestStart !== null && !validDay(latestStart)) || (direct && !startDays[1]) || (cascade && !startDays[2]) || !startDays.some(validDay);
    state.started_on = state.start_unreadable ? null : startDays.filter(validDay).sort().slice(-1)[0]; // L2 start maximum of three sources
    const { ENTRY_COLS } = require('./entries-core');
    const entries = await q.all(`SELECT ${ENTRY_COLS} FROM sysbuild_entries WHERE project_id = ? AND node_id = ? ORDER BY id DESC`, [node.project_id, node.id]);
    const actionRows = await q.all('SELECT id, entry_id, action, text, created_by, created_at FROM sysbuild_entry_actions WHERE entry_id IN (SELECT id FROM sysbuild_entries WHERE project_id = ? AND node_id = ?) ORDER BY id', [node.project_id, node.id]);
    const actions = Object.create(null);
    for (const action of actionRows) {
      if (!own(actions, action.entry_id)) actions[action.entry_id] = [];
      actions[action.entry_id].push(action);
    }
    let latestUnreadableCycleId = 0;
    let latestUnknownId = 0;
    for (const entry of entries) {
      const entryActions = actions[entry.id] || [];
      if (entryActions.some((action) => action.action === 'void')) continue; // L2 voided reports and requests never count
      const parsed = forms.readEntryForm(entry);
      const view = displayedEntry(entry, entryActions);
      if (parsed.form_unreadable) {
        const hint = forms.formKindHint(entry);
        state.unreadable_entry_ids.push(entry.id);
        if (hint === 'report_cycle') latestUnreadableCycleId = Math.max(latestUnreadableCycleId, entry.id);
        if (hint === 'report_request') state.unreadable_request_ids.push(entry.id);
        if (hint === 'progress_report') {
          state.unreadable_report_ids.push(entry.id);
          if (!state.latest_report) state.latest_report = view;
        }
        // 完全无法判种类的 note/general 仅视为未知候选，不冒充某一类表单事实。
        if (hint === null && entry.type === 'note') {
          latestUnknownId = Math.max(latestUnknownId, entry.id);
          state.unreadable_request_ids.push(entry.id);
          state.unreadable_report_ids.push(entry.id);
        }
        continue; // L2 unreadable progress never satisfies a due item
      }
      if (parsed.form_kind === 'report_cycle' && !state.current_cycle) state.current_cycle = view;
      if (parsed.form_kind === 'report_request') state.requests.push(view);
      if (parsed.form_kind === 'progress_report') {
        state.reports.push(view);
        if (!state.latest_report) state.latest_report = view;
      }
    }
    const latestCycleId = state.current_cycle ? state.current_cycle.entry_id : 0;
    state.cycle_unreadable = latestUnreadableCycleId > latestCycleId;
    state.cycle_unknown = latestUnknownId > latestCycleId;
    if (state.cycle_unreadable || state.cycle_unknown) state.current_cycle = null; // L2 unreadable cycle cannot fall back
    state.start_unreadable = !!state.start_unreadable;
    const cycle = DEFAULT_CYCLE[state.project.build_type];
    if (cycle && !state.current_cycle && !state.cycle_unreadable && !state.cycle_unknown && state.started_on) {
      state.default_cycle = { cycle, first_due_on: addDays(state.started_on, cycle === 'weekly' ? 7 : 14) };
    }
    return state;
  } catch (_) {
    return unreadableState(node, today);
  }
}

async function devStartReadyOf(q, node, todayProvider, state) {
  const facts = state || await reportStateOf(q, node, todayProvider);
  if (facts.unreadable || facts.is_dev === null) return 'unknown';
  if (!facts.is_dev) return 'not_dev_node';
  return 'ok';
}

// 第 k 个月恒从原锚点算，不从被截到月底的上一期续算。
function monthlyDate(anchor, k) {
  const [year, month, day] = anchor.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + k, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10); // L2 monthly clamps original anchor
}

// 唯一应交日生成器；传 state 只用于同事务复用，调用方不能自行拼装另一套应交事实。
async function dueDatesOf(q, node, cutoff, todayProvider, state) {
  // 大量历史/未开始节点的待办扫描无需读取表单与排期；不影响视图单独读取历史和警示。
  if (!node || node.status !== 'in_progress') return [];
  const facts = state || await reportStateOf(q, node, todayProvider);
  if (facts.unreadable || !facts.is_dev || !validDay(cutoff) || facts.start_unreadable || !validDay(facts.started_on)) return []; // L2 unavailable generator returns empty
  if (facts.project.status !== 'active') return []; // L2 generator lifecycle preconditions
  const byDate = Object.create(null);
  const add = (day, source) => {
    if (day < facts.started_on || day > cutoff) return; // L2 inclusive reporting window
    if (!own(byDate, day)) byDate[day] = { due_on: day, sources: [], submitted: false, report_entry_ids: [], overdue: false };
    byDate[day].sources.push(source); // L2 same day keeps every source
  };
  const form = facts.current_cycle?.form || facts.default_cycle;
  if (form) {
    const source = facts.current_cycle
      ? { kind: 'cycle', entry_id: facts.current_cycle.entry_id, reason: form.note || null }
      : { kind: 'default_cycle' };
    const anchor = form.first_due_on;
    const lower = anchor > facts.started_on ? anchor : facts.started_on;
    if (validDay(anchor) && lower <= cutoff) {
      if (form.cycle === 'weekly' || form.cycle === 'biweekly') {
        const step = form.cycle === 'weekly' ? 7 : 14; // L2 weekly and biweekly intervals
        const firstIndex = Math.max(0, Math.ceil((utcDay(lower) - utcDay(anchor)) / (step * DAY_MS)));
        for (let day = addDays(anchor, firstIndex * step); day <= cutoff; day = addDays(day, step)) add(day, source);
      } else if (form.cycle === 'monthly') {
        const [ay, am] = anchor.split('-').map(Number);
        const [ly, lm] = lower.split('-').map(Number);
        let index = Math.max(0, (ly - ay) * 12 + lm - am);
        for (let day = monthlyDate(anchor, index); day <= cutoff; day = monthlyDate(anchor, ++index)) {
          if (day >= lower) add(day, source);
        }
      }
    }
  }
  for (const request of facts.requests) add(request.form.due_on, { kind: 'request', entry_id: request.entry_id, reason: request.form.reason }); // L2 requests independent of cycle
  for (const report of facts.reports) {
    const item = byDate[report.form.due_on];
    if (item) item.report_entry_ids.push(report.entry_id); // L2 voluntary report never offsets another due date
  }
  for (const item of Object.values(byDate)) {
    item.report_entry_ids.sort((a, b) => a - b);
    item.sources.sort((a, b) => (a.entry_id ?? 0) - (b.entry_id ?? 0));
    item.submitted = item.report_entry_ids.length > 0; // L2 recognition status does not affect submission
    item.overdue = item.due_on < facts.today && !item.submitted; // L2 today is not overdue
  }
  return Object.values(byDate).sort((a, b) => a.due_on.localeCompare(b.due_on));
}

async function reportViewOf(q, node, todayProvider, state) {
  const facts = state || await reportStateOf(q, node, todayProvider);
  if (facts.is_dev === false) return null;
  const cutoff = facts.today ? addDays(facts.today, 31) : null;
  let warning = null;
  if (facts.unreadable) warning = '汇报事实无法读取';
  else if (facts.cycle_unreadable) warning = '节奏登记无法读取';
  else if (facts.cycle_unknown) warning = '登记无法读取，当前汇报节奏未知';
  if (!warning && node.status === 'in_progress' && facts.start_unreadable) warning = '节点最近开工日期无法读取';
  if (!warning && node.status === 'in_progress' && !facts.current_cycle && !facts.default_cycle) warning = '当前没有可用的汇报节奏';
  return {
    current_cycle: facts.current_cycle,
    default_cycle: facts.default_cycle,
    cycle_source: facts.current_cycle ? 'registered' : facts.default_cycle ? 'default' : null,
    due_items: await dueDatesOf(q, node, cutoff, todayProvider, facts),
    latest_report: facts.latest_report,
    warning,
    unreadable_request_ids: facts.unreadable_request_ids,
    unreadable_report_ids: facts.unreadable_report_ids,
    unreadable_entry_ids: facts.unreadable_entry_ids,
    facts_unreadable: facts.unreadable,
    started_on: facts.started_on,
    cutoff,
  };
}

module.exports = { developmentNodeOf, reportStateOf, devStartReadyOf, dueDatesOf, reportViewOf, todayOf, addDays };
