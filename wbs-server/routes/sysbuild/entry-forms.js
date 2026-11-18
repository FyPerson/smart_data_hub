// 结构化登记表单：校验、规范化、派生与读取集中在此；登记写入后表单不再改写。
'use strict';
const { makeError } = require('./db');
const rules = require('./rules');

const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), { field });
const DEFINITIONS = Object.freeze({
  change_request: Object.freeze({ label: '需求变更申请', type: 'feedback', purpose: 'general', fields: ['kind', 'change_kind', 'content', 'reason', 'problem'], conditions: '沿用意见与反馈登记权限；修改、取消须关联需求条目；须附方向类证据；混合归属须分开登记' }),
  dev_assessment: Object.freeze({ label: '开发评估', type: 'note', purpose: 'dev_note', fields: ['kind', 'about_change_id', 'feasible', 'extra_person_days', 'schedule_impact_days', 'impact_note', 'premise'], conditions: '开发方负责人、代表人或项目经理代登；来源方须为开发方且有现任负责人；变更须有草稿版本' }),
  progress_report: Object.freeze({ label: '进度汇报', type: 'note', purpose: 'general', fields: ['kind', 'due_on', 'done', 'next', 'risks', 'milestone_impact'], conditions: '开发方负责人、代表人或项目经理代登；来源方为开发方；关联进行中的开发节点；影响里程碑须方向类证据与负责人认可' }),
  report_cycle: Object.freeze({ label: '汇报节奏', type: 'note', purpose: 'general', fields: ['kind', 'cycle', 'first_due_on', 'note'], conditions: '项目经理登记；关联未开始或进行中且已有当前计划的开发节点；修改节奏请新登，原登记不可作废' }),
  report_request: Object.freeze({ label: '临时汇报要求', type: 'note', purpose: 'general', fields: ['kind', 'due_on', 'reason'], conditions: '项目经理登记；关联进行中的开发节点；应交日在今天至未来31天内' }),
});
const CHANGE_LABELS = Object.freeze({ add: '新增', modify: '修改', cancel: '取消' });
const FEASIBLE_LABELS = Object.freeze({ yes: '能做', partial: '部分能做', no: '不能做' });
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
function numberField(form, key, max, integer) {
  const value = form[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer ? !Number.isInteger(value) : Math.round(value * 10) / 10 !== value)) {
    throw invalid(`${key} 须为 0–${max} 的${integer ? '整数' : '数字，至多一位小数'}`, `form.${key}`);
  }
  return value;
}
function validateForm(form, stored) {
  if (!object(form)) throw invalid('form 必须是对象', 'form');
  if (typeof form.kind !== 'string' || !hasKey(DEFINITIONS, form.kind)) throw invalid('不认识的表单种类', 'form.kind');
  const def = DEFINITIONS[form.kind];
  const allowed = stored && form.kind === 'dev_assessment' ? [...def.fields, 'scope_digest', 'package_version_id'] : def.fields;
  for (const key of Object.keys(form)) if (!allowed.includes(key)) throw invalid(`不支持的表单字段 ${key}`, `form.${key}`);
  if (form.kind === 'change_request') {
    if (typeof form.change_kind !== 'string' || !hasKey(CHANGE_LABELS, form.change_kind)) throw invalid('变更种类须为 add / modify / cancel', 'form.change_kind');
    return { kind: form.kind, change_kind: form.change_kind, content: textField(form, 'content', 1, 2000), reason: textField(form, 'reason', 10, 1000), problem: textField(form, 'problem', 10, 1000) };
  }
  if (form.kind === 'progress_report') {
    if (typeof form.milestone_impact !== 'boolean') throw invalid('milestone_impact 必须是布尔值', 'form.milestone_impact');
    return { kind: form.kind, due_on: dateField(form, 'due_on', true), done: textField(form, 'done', 10, 2000), next: textField(form, 'next', 10, 2000), risks: textField(form, 'risks', 0, 1000), milestone_impact: form.milestone_impact };
  }
  if (form.kind === 'report_cycle') {
    if (typeof form.cycle !== 'string' || !hasKey(CYCLE_LABELS, form.cycle)) throw invalid('周期须为 weekly / biweekly / monthly', 'form.cycle');
    return { kind: form.kind, cycle: form.cycle, first_due_on: dateField(form, 'first_due_on', false), note: textField(form, 'note', 0, 500) };
  }
  if (form.kind === 'report_request') return { kind: form.kind, due_on: dateField(form, 'due_on', false), reason: textField(form, 'reason', 10, 500) };
  if (!Number.isSafeInteger(form.about_change_id) || form.about_change_id <= 0) throw invalid('变更编号必须是正整数', 'form.about_change_id');
  if (typeof form.feasible !== 'string' || !hasKey(FEASIBLE_LABELS, form.feasible)) throw invalid('能否做须为 yes / partial / no', 'form.feasible');
  const days = numberField(form, 'schedule_impact_days', 3650, true);
  const result = {
    kind: form.kind, about_change_id: form.about_change_id, feasible: form.feasible,
    extra_person_days: numberField(form, 'extra_person_days', 9999, false), schedule_impact_days: days,
    impact_note: textField(form, 'impact_note', days > 0 || form.feasible !== 'yes' ? 10 : 0, 1000), premise: textField(form, 'premise', 0, 1000),
  };
  if (stored) {
    if (typeof form.scope_digest !== 'string' || !/^[a-f0-9]{64}$/.test(form.scope_digest)) throw invalid('评估范围指纹缺失或不合法', 'form.scope_digest');
    if (!Number.isSafeInteger(form.package_version_id) || form.package_version_id <= 0) throw invalid('评估版本编号缺失或不合法', 'form.package_version_id');
    result.scope_digest = form.scope_digest;
    result.package_version_id = form.package_version_id;
  }
  return result;
}

function generateEntryText(form) {
  if (form.kind === 'progress_report') return {
    title: `进度汇报（${form.due_on ? '应交日 ' + form.due_on : '主动汇报'}）`,
    body: `已完成\n${form.done}\n\n下一步\n${form.next}\n\n风险\n${form.risks || '无'}\n\n是否影响里程碑：${form.milestone_impact ? '是' : '否'}`,
  };
  if (form.kind === 'report_cycle') {
    const title = `汇报节奏：${CYCLE_LABELS[form.cycle]}，首次应交 ${form.first_due_on}`;
    return { title, body: title + (form.note ? '\n\n' + form.note : '') };
  }
  if (form.kind === 'report_request') return { title: `临时汇报要求：${form.due_on} 前`, body: form.reason };
  if (form.kind === 'change_request') return {
    title: `需求变更申请（${CHANGE_LABELS[form.change_kind]}）：${Array.from(form.content).slice(0, 40).join('')}`,
    body: `变更内容\n${form.content}\n\n原因\n${form.reason}\n\n要解决的问题\n${form.problem}`,
  };
  return {
    title: `开发评估：变更 #${form.about_change_id}（${FEASIBLE_LABELS[form.feasible]}，增加 ${form.extra_person_days} 人日，工期影响 ${form.schedule_impact_days} 天）`,
    body: `能否做\n${FEASIBLE_LABELS[form.feasible]}\n\n增加工时\n${form.extra_person_days} 人日\n\n工期影响与受影响节点\n${form.schedule_impact_days} 天${form.impact_note ? '\n' + form.impact_note : ''}\n\n前提与风险\n${form.premise || '无'}`,
  };
}

// 第一处规范化：后续权限、证据、认可、分流与 INSERT 只能使用这份有效输入。
function normalizeEntryRequest(body) {
  if (!hasKey(body, 'form')) return body;
  const form = validateForm(body.form, false);
  for (const key of ['title', 'body', 'objects_entry_id', 'revision_of_entry_id']) if (hasKey(body, key)) throw invalid(`带表单的登记不能同时填写 ${key}`, key);
  const def = DEFINITIONS[form.kind];
  for (const key of ['type', 'purpose']) if (hasKey(body, key) && body[key] !== def[key]) throw invalid(`表单 ${form.kind} 的 ${key} 必须为 ${def[key]}`, key);
  if (body.commitment_flag === true || body.commitment_flag === 1) throw invalid('带表单登记的涉及承诺标记由服务端确定，客户端不能传 1', 'commitment_flag');
  if (hasKey(body, 'commitment_flag') && ![0, false, null].includes(body.commitment_flag)) throw invalid('涉及承诺标记必须是 0 / 1', 'commitment_flag');
  const milestone = form.kind === 'progress_report' && form.milestone_impact === true;
  if (form.kind !== 'dev_assessment' && !milestone && hasKey(body, 'self_confirm_text')) throw invalid('self_confirm_text 只适用于开发评估与影响里程碑的汇报', 'self_confirm_text');
  if (form.kind === 'change_request' && form.change_kind !== 'add' && (!Array.isArray(body.item_ids) || body.item_ids.length === 0)) throw invalid('修改或取消需求须关联至少一个需求条目', 'item_ids');
  return Object.assign({}, body, generateEntryText(form), { type: def.type, purpose: def.purpose, commitment_flag: milestone ? 1 : 0, form });
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
      if (!state.current_plan) throw invalid('请先确定开工日（开发节点的计划开始）', 'node_id');
      if (form.first_due_on < state.current_plan.start || (node.status === 'in_progress' && form.first_due_on < today)) throw invalid('首次应交日不能早于计划开始日，进行中节点也不能早于今天', 'form.first_due_on');
    } else if (form.kind === 'report_request') {
      if (form.due_on < today || form.due_on > cutoff) throw invalid('临时汇报应交日须在今天至未来31天内', 'form.due_on');
    } else if (form.due_on !== null) {
      const due = await reports.dueDatesOf(q, node, cutoff, () => today);
      if (!due.some((item) => item.due_on === form.due_on)) throw invalid('应交日不是该节点未来31天截止范围内的真实应交日', 'form.due_on');
    }
    return form;
  }
  if (!form || form.kind !== 'dev_assessment') return form || null;
  const change = await q.get('SELECT id, project_id, status, package_id FROM sysbuild_changes WHERE id = ? AND project_id = ?', [form.about_change_id, projectId]);
  if (!change || change.status !== 'draft') throw invalid('开发评估须指向本项目仍有草稿版本的正式变更', 'form.about_change_id');
  const ver = await q.get('SELECT id, package_id, version_no, status, form, parent_overall_version_id, snapshot_json FROM sysbuild_package_versions WHERE package_id = ? AND status = ? ORDER BY id DESC LIMIT 1', [change.package_id, 'draft']);
  const pkg = ver ? await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ? AND project_id = ? AND type = ?', [ver.package_id, projectId, 'change']) : null;
  if (!ver || !pkg) throw invalid('该变更没有可供评估的草稿版本', 'form.about_change_id');
  const scope = await require('./submission-scope').readSubmissionScope(q, pkg, ver);
  return Object.assign({}, form, { scope_digest: scope.scope_digest, package_version_id: ver.id });
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
    validateForm(payload.form, true);
    return { form: payload.form, form_kind: payload.form.kind, form_label: DEFINITIONS[payload.form.kind].label, form_unreadable: false };
  } catch (_) { return Object.assign({}, empty, { form_unreadable: true }); }
}
function entryFormView(entry, actions) {
  const view = readEntryForm(entry);
  const corrections = (actions || []).filter((a) => a.action === 'correct').map((a) => ({ action_id: a.id, text: a.text, created_by: a.created_by, created_at: a.created_at }));
  return Object.assign(view, { has_correction: corrections.length > 0, corrections });
}
function availableForms({ generalAllowed, devAllowed, hasDevOwner, isPm }) {
  return Object.keys(DEFINITIONS).map((kind) => {
    const d = DEFINITIONS[kind];
    const allowed = kind === 'dev_assessment' ? devAllowed === true && hasDevOwner === true
      : kind === 'progress_report' ? devAllowed === true
        : ['report_cycle', 'report_request'].includes(kind) ? isPm === true : true;
    return { kind, label: d.label, type: d.type, purpose: d.purpose, conditions: d.conditions, allowed: generalAllowed === true && allowed };
  });
}

module.exports = { normalizeEntryRequest, validateForm, generateEntryText, assertFormRegistrant, deriveEntryForm, serializeEntryForm, readEntryForm, formKindHint, entryFormView, availableForms };
