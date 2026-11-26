// 结构化登记表单：校验、规范化、派生与读取集中在此；登记写入后表单不再改写。
'use strict';
const { makeError } = require('./db');
const rules = require('./rules');

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), { field });
const DEFINITIONS = Object.freeze({
  progress_report: Object.freeze({ label: '进度汇报', type: 'note', purpose: 'general', fields: ['kind', 'due_on', 'done', 'next', 'risks', 'milestone_impact'], conditions: '开发方负责人、代表人或项目经理代登；来源方为开发方；关联进行中的开发节点；影响里程碑须方向类证据' }),
  report_cycle: Object.freeze({ label: '汇报节奏', type: 'note', purpose: 'general', fields: ['kind', 'cycle', 'first_due_on', 'note'], conditions: '项目经理登记；关联未开始或进行中的开发节点；修改节奏请新登，原登记不可作废' }),
  report_request: Object.freeze({ label: '临时汇报要求', type: 'note', purpose: 'general', fields: ['kind', 'due_on', 'reason'], conditions: '项目经理登记；关联进行中的开发节点；应交日在今天至未来31天内' }),
});
const CYCLE_LABELS = Object.freeze({ weekly: '每周', biweekly: '每两周', monthly: '每月' });

function dateField(form, key, optional) {
  const value = form[key];
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw invalid(`${key} 须为有效日期（2000–2099）`, `form.${key}`);
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) throw invalid(`${key} 须为有效日期（2000–2099）`, `form.${key}`);
  return value;
}

function textField(form, key, min, max) {
  const raw = form[key];
  if ((raw === undefined || raw === null) && min === 0) return null;
  if (typeof raw !== 'string') throw invalid(`${key} 必须是文本`, `form.${key}`);
  const value = raw.trim();
  const length = Array.from(value).length;
  if (length < min || length > max || rules.hasControlChar(value)) throw invalid(`${key} 须为 ${min}–${max} 字且不含控制字符`, `form.${key}`);
  return value === '' ? null : value;
}
function validateForm(form) {
  if (!object(form)) throw invalid('form 必须是对象', 'form');
  if (typeof form.kind !== 'string' || !hasKey(DEFINITIONS, form.kind)) throw invalid('不认识的表单种类', 'form.kind');
  const def = DEFINITIONS[form.kind];
  const allowed = def.fields;
  for (const key of Object.keys(form)) if (!allowed.includes(key)) throw invalid(`不支持的表单字段 ${key}`, `form.${key}`);
  if (form.kind === 'progress_report') {
    if (hasKey(form, 'milestone_impact') && typeof form.milestone_impact !== 'boolean') throw invalid('milestone_impact 必须是布尔值', 'form.milestone_impact');
    return { kind: form.kind, due_on: dateField(form, 'due_on', true), done: textField(form, 'done', 10, 2000), next: textField(form, 'next', 0, 2000), risks: textField(form, 'risks', 0, 1000), milestone_impact: form.milestone_impact === true };
  }
  if (form.kind === 'report_cycle') {
    if (typeof form.cycle !== 'string' || !hasKey(CYCLE_LABELS, form.cycle)) throw invalid('周期须为 weekly / biweekly / monthly', 'form.cycle');
    return { kind: form.kind, cycle: form.cycle, first_due_on: dateField(form, 'first_due_on', false), note: textField(form, 'note', 0, 500) };
  }
  if (form.kind === 'report_request') return { kind: form.kind, due_on: dateField(form, 'due_on', false), reason: textField(form, 'reason', 10, 500) };
  throw invalid('不认识的表单种类', 'form.kind');
}

function generateEntryText(form) {
  if (form.kind === 'progress_report') return {
    title: `进度汇报（${form.due_on ? '应交日 ' + form.due_on : '主动汇报'}）`,
    body: `本期进展\n${form.done}\n\n下期计划\n${form.next || '未填写'}\n\n风险\n${form.risks || '未填写'}\n\n是否影响里程碑：${form.milestone_impact ? '是' : '否'}`,
  };
  if (form.kind === 'report_cycle') {
    const title = `汇报节奏：${CYCLE_LABELS[form.cycle]}，首次应交 ${form.first_due_on}`;
    return { title, body: title + (form.note ? '\n\n' + form.note : '') };
  }
  if (form.kind === 'report_request') return { title: `临时汇报要求：${form.due_on} 前`, body: form.reason };
  throw invalid('不认识的表单种类', 'form.kind');
}

// 第一处规范化：后续权限、证据与 INSERT 只能使用这份有效输入。
function normalizeEntryRequest(body) {
  if (!hasKey(body, 'form')) return body;
  const form = validateForm(body.form);
  for (const key of ['title', 'body']) if (hasKey(body, key)) throw invalid(`带表单的登记不能同时填写 ${key}`, key);
  const def = DEFINITIONS[form.kind];
  for (const key of ['type', 'purpose']) if (hasKey(body, key) && body[key] !== def[key]) throw invalid(`表单 ${form.kind} 的 ${key} 必须为 ${def[key]}`, key);
  return Object.assign({}, body, generateEntryText(form), { type: def.type, purpose: def.purpose, form });
}

// 新表单的登记人权限在证据与节点业务校验前核对；派生入口也复用同一函数。
async function assertFormRegistrant(q, projectId, form, identity, project) {
  if (!form) return;
  if (form.kind === 'progress_report') rules.assertOp('entry_create_dev', identity, project, { devPartyId: await require('./entries-core').devPartyIdOf(q, projectId) });
  if (['report_cycle', 'report_request'].includes(form.kind) && !rules.canActAsPm(identity)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '只有项目经理可以登记汇报节奏或临时汇报要求');
}

// 只读派生；调用方须位于创建登记的写事务中，与随后写入绑定同一现状。
async function deriveEntryForm(q, projectId, form, context) {
  if (form && ['progress_report', 'report_cycle', 'report_request'].includes(form.kind)) {
    const c = context || {};
    const identity = c.identity || {};
    const entries = require('./entries-core');
    await assertFormRegistrant(q, projectId, form, identity, c.project || {});
    if (form.kind === 'progress_report') {
      if (!(await entries.isDevParty(q, c.sourcePartyId))) throw invalid('进度汇报的来源方必须是开发方（项目经理代登请填写开发方参与方）', 'source_party_id');
    }
    const node = c.nodeId ? await q.get('SELECT * FROM sysbuild_nodes WHERE id = ? AND project_id = ?', [c.nodeId, projectId]) : null;
    const reports = require('./report-core');
    const dev = node && node.batch_id !== null ? await reports.developmentNodeOf(q, node.batch_id) : null;
    if (!node || !dev || dev.id !== node.id) throw invalid('关联节点须为该批次的开发节点', 'node_id');
    if (!(form.kind === 'report_cycle' ? ['not_started', 'in_progress'] : ['in_progress']).includes(node.status)) throw invalid('该开发节点状态不允许登记此表单', 'node_id');
    const today = c.today;
    const cutoff = reports.addDays(today, 31);
    if (form.kind === 'report_cycle') {
      const state = await reports.reportStateOf(q, node, () => today);
      if (state.unreadable) throw invalid('汇报事实无法读取，请刷新后重试', 'node_id');
      if (!state.current_plan && form.first_due_on < today) throw invalid('首次应交日不能早于今天', 'form.first_due_on');
      if (state.current_plan && (form.first_due_on < state.current_plan.start || (node.status === 'in_progress' && form.first_due_on < today))) throw invalid('首次应交日不能早于计划开始日，进行中节点也不能早于今天', 'form.first_due_on');
    } else if (form.kind === 'report_request') {
      if (form.due_on < today || form.due_on > cutoff) throw invalid('临时汇报应交日须在今天至未来31天内', 'form.due_on');
    } else if (form.due_on !== null) {
      const due = await reports.dueDatesOf(q, node, cutoff, () => today);
      if (!due.some((item) => item.due_on === form.due_on)) throw invalid('应交日不是该节点未来31天截止范围内的真实应交日', 'form.due_on');
    }
    return form;
  }
  return form || null;
}

function serializeEntryForm(form) {
  return form ? JSON.stringify({ v: 1, form }) : null;
}
// 仅用于不可读载荷的保守分类，不能据此信任字段或将登记视为已交。
function formKindHint(entry) {
  try {
    const payload = JSON.parse(entry.routing_json);
    return object(payload) && object(payload.form) && typeof payload.form.kind === 'string' && hasKey(DEFINITIONS, payload.form.kind) ? payload.form.kind : null;
  } catch (_) { return null; }
}
function readEntryForm(entry) {
  const empty = { form: null, form_kind: null, form_label: null, form_unreadable: false };
  const raw = entry.routing_json;
  if (raw === null || raw === undefined || raw === '') return empty;
  try {
    const payload = JSON.parse(raw);
    if (!object(payload) || payload.v !== 1 || Object.keys(payload).some((key) => !['v', 'form'].includes(key))) throw new Error('unsupported envelope');
    validateForm(payload.form);
    return { form: payload.form, form_kind: payload.form.kind, form_label: DEFINITIONS[payload.form.kind].label, form_unreadable: false };
  } catch (_) { return Object.assign({}, empty, { form_unreadable: true }); }
}
function entryFormView(entry, actions) {
  const view = readEntryForm(entry);
  const corrections = (actions || []).filter((a) => a.action === 'correct').map((a) => ({ action_id: a.id, text: a.text, created_by: a.created_by, created_at: a.created_at }));
  return Object.assign(view, { has_correction: corrections.length > 0, corrections });
}
function availableForms({ generalAllowed, devAllowed, isPm }) {
  return Object.keys(DEFINITIONS).map((kind) => {
    const d = DEFINITIONS[kind];
    const allowed = kind === 'progress_report' ? devAllowed === true
      : ['report_cycle', 'report_request'].includes(kind) ? isPm === true : true;
    return { kind, label: d.label, type: d.type, purpose: d.purpose, conditions: d.conditions, allowed: generalAllowed === true && allowed };
  });
}

module.exports = { normalizeEntryRequest, validateForm, generateEntryText, assertFormRegistrant, deriveEntryForm, serializeEntryForm, readEntryForm, formKindHint, entryFormView, availableForms };
