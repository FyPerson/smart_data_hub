// L1：确认任务与归档确认单共用提交事件固定的评估；绝不重新选择当前最新评估。
'use strict';
const entries = require('./entries-core');
const entryForms = require('./entry-forms');
const { makeError } = require('./db');

async function submittedAssessmentView(q, projectId, versionId) {
  const ev = await q.get(
    "SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND object_type = 'package_version' AND object_id = ? AND event_type = 'package_version_submitted' ORDER BY id DESC LIMIT 1",
    [projectId, versionId]
  );
  let payload = {};
  if (ev) {
    try { payload = JSON.parse(ev.payload_json); }
    catch (_) { throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：提交事件无法解析'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：提交事件格式异常');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'assessment')) return { legacy: true, exempt: null, unreadable: false, message: '提交时没有开发评估记录（旧版）' };
  const a = payload.assessment;
  if (a && a.exempt === 'dev_never_joined') return { legacy: false, exempt: a.exempt, unreadable: false, message: '开发方尚未入场，本次变更未做开发评估' };
  if (!a || !Number.isSafeInteger(a.entry_id) || a.entry_id <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：提交时固定的开发评估格式异常');
  const row = await q.get(`SELECT ${entries.ENTRY_COLS} FROM sysbuild_entries WHERE id = ? AND project_id = ?`, [a.entry_id, projectId]);
  const read = row ? entryForms.readEntryForm(row) : null;
  const corrections = row ? await q.all("SELECT id, text, created_by, created_at FROM sysbuild_entry_actions WHERE entry_id = ? AND action = 'correct' ORDER BY id", [row.id]) : [];
  const unreadable = !read || !read.form || read.form.kind !== 'dev_assessment';
  return {
    legacy: false, exempt: null, unreadable,
    entry_id: a.entry_id, scope_digest: a.scope_digest,
    confirm_task_revision_id: a.confirm_task_revision_id,
    approved_by_member_id: a.approved_by_member_id,
    approved_by_name: await entries.memberNameOf(q, a.approved_by_member_id), approved_at: a.approved_at,
    form: unreadable ? null : read.form,
    title: row ? row.title : null, body: row ? row.body : null,
    has_correction: corrections.length > 0, corrections,
    ...(unreadable ? { message: '提交时的开发评估记录无法读取，请核实原始记录' } : {}),
  };
}
module.exports = { submittedAssessmentView };
