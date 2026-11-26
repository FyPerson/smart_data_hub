'use strict';

const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { ACTIVE_BATCH_STATUSES } = require('./templates');
const ineligibleSelection = () => Object.assign(makeError(409, 'SYSBUILD_STATE', '有阶段已不能一并完成，请刷新后重新选择'), { field: 'complete_node_ids' });

function readCompletionIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(value).size !== value.length) {
    throw Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', '请选择有效且不重复的阶段'), { field: 'complete_node_ids' });
  }
  return value;
}

// 上线只查本批，结项包括本项目的项目层与已上线批次。
async function completionCandidates(q, projectId, { batchId, excludeId } = {}) {
  return q.all(
    `SELECT n.id, n.name, n.status FROM sysbuild_nodes n
      LEFT JOIN sysbuild_batches b ON b.id = n.batch_id AND b.project_id = n.project_id
      WHERE n.project_id = ? AND n.status IN ('not_started', 'in_progress') AND n.is_golive_milestone = 0
        AND (n.batch_id IS NULL OR b.status IN (${ACTIVE_BATCH_STATUSES.map(() => '?').join(', ')}))
        AND (? IS NULL OR n.batch_id = ?) AND (? IS NULL OR n.id <> ?)
      ORDER BY n.batch_id IS NOT NULL, b.seq, n.sort_order, n.id`,
    [projectId, ...ACTIVE_BATCH_STATUSES, batchId ?? null, batchId ?? null, excludeId ?? null, excludeId ?? null]
  );
}

async function completeSelected(q, { projectId, batchId, excludeId, ids, day, operatorId, operatorName, via }) {
  if (ids.length === 0) return ids;
  const candidates = Object.fromEntries((await completionCandidates(q, projectId, { batchId, excludeId })).map((node) => [node.id, node]));
  if (ids.some((id) => !Object.hasOwn(candidates, id))) throw ineligibleSelection();
  for (const id of ids) {
    const start = await q.get(
      `SELECT actual_date FROM sysbuild_node_schedule_records WHERE node_id = ?
        AND (kind = 'actual_start' OR (kind = 'actual_correct' AND corrects_kind = 'actual_start'))
        ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (start && start.actual_date > day) throw makeError(409, 'SYSBUILD_STATE', '实际开始晚于收口日期，请先更正实际开始');
    const done = await q.run(
      `UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(opened_at, datetime('now','localtime')),
        closed_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
        WHERE id = ? AND project_id = ? AND status = ?`,
      [id, projectId, candidates[id].status]
    );
    if (done.changes !== 1) throw makeError(409, 'SYSBUILD_STATE', '节点状态已变化，请刷新后重试');
    await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [id, day, operatorId]);
    await writeEvent(q, { projectId, objectType: 'node', objectId: id, eventType: 'node_closed', payload: { actual_date: day, via }, operatorId, operatorName });
  }
  return ids;
}

module.exports = { readCompletionIds, completionCandidates, completeSelected, ineligibleSelection };
