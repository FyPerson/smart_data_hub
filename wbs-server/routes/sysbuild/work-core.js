'use strict';

const rules = require('./rules');
const confirmations = require('./confirm-core');
const { writeEvent } = require('./events');
const { makeError } = require('./db');

const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), { field });
const invalidState = (message, field) => Object.assign(makeError(409, 'SYSBUILD_STATE', message), field ? { field } : {});
const OPINION_PENDING_SQL = "status <> 'concluded'";

async function responsibleUser(q, projectId, partyId, options) {
  const role = await confirmations.currentDelegate(q, partyId, options);
  if (!role) return null;
  const member = await q.get(
    'SELECT user_id FROM sysbuild_members WHERE id = ? AND project_id = ? AND party_id = ?',
    [role.memberId, projectId, partyId]
  );
  return member && member.user_id !== null ? { userId: member.user_id, delegationId: role.delegationId } : null;
}

async function developerResponsible(q, projectId, options) {
  const party = await q.get("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'dev'", [projectId]);
  return party ? responsibleUser(q, projectId, party.id, options) : null;
}

async function lastInProgressNode(q, projectId) {
  const row = await q.get(
    `SELECT n.id FROM sysbuild_nodes n LEFT JOIN sysbuild_batches b ON b.id = n.batch_id AND b.project_id = n.project_id
      WHERE n.project_id = ? AND n.status = 'in_progress' AND (n.batch_id IS NULL OR b.id IS NOT NULL)
      ORDER BY (n.batch_id IS NOT NULL) DESC, b.seq DESC, n.sort_order DESC, n.id DESC LIMIT 1`,
    [projectId]
  );
  return row?.id ?? null;
}

async function pendingClosingWork(q, projectId) {
  return q.all(
    `SELECT 'task' AS kind, id, title, node_id FROM sysbuild_tasks WHERE project_id = ? AND status = 'pending'
       UNION ALL
       SELECT 'opinion' AS kind, id, title, node_id FROM sysbuild_opinions WHERE project_id = ? AND ${OPINION_PENDING_SQL}
       ORDER BY kind, id`,
    [projectId, projectId]
  );
}

function pendingWorkMessage(items) {
  return '以下任务或意见尚未结束：' + items.map((item) => (item.kind === 'task' ? '任务 #' : '意见 #') + item.id + ' ' + item.title).join('、');
}

async function scopeAdjustments(q, projectId, versionId) {
  return q.all(
    `SELECT id AS opinion_id, title, category, outcome, outcome_text, resolved_at
       FROM sysbuild_opinions WHERE project_id = ? AND adjustment_version_id = ? AND status = 'concluded' ORDER BY id`,
    [projectId, versionId]
  );
}

async function originalDemandRoster(q, projectId, versionId) {
  const rows = await q.all(
    `SELECT t.party_id, p.side, p.name, r.status, c.id AS confirmation_id
       FROM sysbuild_confirm_tasks t
       JOIN sysbuild_package_versions v ON v.id = t.object_version_id AND v.package_id = t.object_id AND v.status = 'effective'
       LEFT JOIN sysbuild_parties p ON p.id = t.party_id AND p.project_id = t.project_id
       LEFT JOIN sysbuild_confirm_task_revisions r ON r.id = (
         SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = t.id ORDER BY rev_no DESC LIMIT 1
       )
       LEFT JOIN sysbuild_confirmations c ON c.task_revision_id = r.id AND c.object_version_id = t.object_version_id AND c.decision = 'confirm'
      WHERE t.project_id = ? AND t.object_type = 'package_version' AND t.object_version_id = ? AND t.purpose = 'package_confirm'
      ORDER BY t.party_id, t.id`,
    [projectId, versionId]
  );
  if (rows.some((row) => row.side === null || (row.side === 'demand' && (row.status !== 'confirmed' || row.confirmation_id === null)))) return [];
  return [...new Map(rows.filter((row) => row.side === 'demand').map((row) => [row.party_id, row])).values()];
}

function onlyFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('请求体必须是 JSON 对象', 'body');
  for (const field of Object.keys(value)) {
    if (!names.includes(field)) throw invalid('不支持的字段 ' + field, field);
  }
}

function readAttachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw invalid('附件编号须为至多 20 项的列表', 'attachment_ids');
  const ids = value.map(rules.parseId);
  if (ids.some((id) => id === null)) throw invalid('附件编号不合法', 'attachment_ids');
  if (new Set(ids).size !== ids.length) throw invalid('附件编号重复', 'attachment_ids');
  return ids;
}

async function attachmentsOf(q, projectId, type, id) {
  const rows = await q.all(
    `SELECT a.id AS attachment_id, a.sha256 FROM sysbuild_attachment_bindings b
       JOIN sysbuild_attachments a ON a.id = b.attachment_id
      WHERE b.owner_type = ? AND b.owner_id = ? AND a.project_id = ? ORDER BY b.id`,
    [type, id, projectId]
  );
  return confirmations.attachmentView(q, rows);
}

function emit(q, user, projectId, objectType, objectId, eventType, payload) {
  return writeEvent(q, { projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: confirmations.operatorNameOf(user) });
}

module.exports = {
  responsibleUser, developerResponsible, lastInProgressNode, pendingClosingWork, pendingWorkMessage, scopeAdjustments,
  OPINION_PENDING_SQL,
  originalDemandRoster, onlyFields, readAttachmentIds, attachmentsOf, emit, invalid, invalidState,
};
