// routes/sysbuild/golive-core.js — 项目管理（系统建设记录）模块：上线的共用助手（C6a；上线前置、上线与撤销的写入）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §3.2（:466–469 上线 / 试运行结束 / 里程碑）、§4.5（状态机与项目状态 × 动作）、§5.2（:855–857）。
//
// 本文件只放「在调用方 withRead / withWriteTxn 回调里用 q 调用」的助手，不注册路由：golive.js（上线 / 撤销端点与上线前置读接口）、plan.js（批次视图、收口前置）共用。
//   依赖只有 db / events / confirm-core / entries-core / packages（只取 effectiveOverallVersionId，packages 不依赖本文件），不依赖其余路由文件，避免成环。
'use strict';
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const entries = require('./entries-core');
const packages = require('./packages'); // 现行总体规划版本的唯一来源（effectiveOverallVersionId）；packages 不依赖本文件，不成环

const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const internalError = (message) => makeError(500, 'SYSBUILD_INTERNAL', `内部错误：${message}`);
const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
  projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
});

// 项目里有待确认的总体规划版本？（P164 / P169）：普通上线前置 PLAN_PENDING、plan.js 的排期冻结（P34）共用这一个函数。
async function planPendingOf(q, projectId) {
  const r = await q.get(
    `SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'pending' LIMIT 1`,
    [projectId]
  );
  return !!r;
}
// 上线前置未满足项（P143 / P144，读接口 actions.golive 与执行共用）：本批除里程碑外、未取消的节点须全部已收口；本批批次验收包须已生效；项目里没有待确认的范围包。
//   返回 [{ code, message, … }]，空数组 = 满足。
async function goliveBlockersOf(q, batch) {
  const out = [];
  const acc = await q.get(
    `SELECT v.id AS id, v.parent_overall_version_id AS parent_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.batch_id = ? AND p.type = 'batch_accept' AND v.status = 'effective' LIMIT 1`,
    [batch.id]
  );
  if (!acc) { out.push({ code: 'ACCEPT_NOT_EFFECTIVE', message: '本批批次验收包还没有生效版本' }); }
  // P168：验收包确认时引用的总体规划版本（parent）必须仍是现行总体规划版本；总体规划换版后，验收包确认的是旧规划，须基于现行规划重新提交并确认（草稿、提交时 parent 都按现行重写）。
  else if (acc.parent_id !== (await packages.effectiveOverallVersionId(q, batch.project_id))) {
    out.push({ code: 'ACCEPT_STALE', message: '本批批次验收包引用的版本不是现行范围版本，须基于现行范围版本重新提交批次验收并确认' });
  }
  // P164：项目里有待确认的总体规划版本时不能上线（它生效会换掉验收依据的规划版本）。
  if (await planPendingOf(q, batch.project_id)) out.push({ code: 'PLAN_PENDING', message: '项目里有待确认的总体规划，须等确认完成或撤回后再上线' });
  return out;
}

// ── 批次视图的上线信息 ─────────────────────────────────────────────────────────────────────────────────────────
// 最后一条上线事件（kind、时刻、操作人、原因）与「是否已正式上线」（entries-core.batchLiveState，唯一判定）。operator_name 取用户显示名。
async function goliveInfoOf(q, batchId) {
  const st = await entries.batchLiveState(q, batchId);
  let last = null;
  if (st.last) {
    const u = await q.get('SELECT COALESCE(display_name, username) AS n FROM users WHERE id = ?', [st.last.created_by]);
    last = { id: st.last.id, kind: st.last.kind, at: st.last.created_at, by: st.last.created_by, by_name: u ? u.n : null, reason: st.last.reason };
  }
  return { live: st.live, last_event: last };
}
// 本项目是否有待确认的结项包版本（撤销上线的前置，P150）。
async function closingPendingOf(q, projectId) {
  const r = await q.get(
    "SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'closing' AND v.status = 'pending' LIMIT 1",
    [projectId]
  );
  return !!r;
}
// 项目上线进度（§2.3 :443 / §6.3）：已正式上线的有效批次数 / 有效批次数；撤销上线按当前有效上线状态计数。返回 { live, total }。
async function goliveProgressOf(q, projectId) {
  const bs = await q.all('SELECT id, status FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
  let live = 0;
  let total = 0;
  for (const b of bs) {
    total += 1;
    if ((await entries.batchLiveState(q, b.id)).live) live += 1;
  }
  return { live, total };
}

// ── 上线 / 撤销的写入（同一写事务内）──────────────────────────────────────────────────────────────────
// 实际日期：节点收口自动记的日期（与 plan.js 收口端点同口径）；最后一条实际开始（含更正）。
function lastActualStart(recs) {
  let v = null;
  for (const r of recs) {
    if (r.kind === 'actual_start' || (r.kind === 'actual_correct' && r.corrects_kind === 'actual_start')) v = r.actual_date;
  }
  return v;
}
async function milestoneOf(q, batchId) {
  return q.get(
    'SELECT id, project_id, name, status, opened_at FROM sysbuild_nodes WHERE batch_id = ? AND is_golive_milestone = 1',
    [batchId]
  );
}
// 里程碑节点 → 已收口（P145：未开始或进行中都可；照节点收口端点的做法记实际结束，写节点事件）。o：{ dateStr（实际日期）、atText（收口 / 开始时刻文本，缺省 = 此刻）、via、goliveEventId }。
async function closeMilestoneForGolive(q, user, projectId, batchId, o) {
  const node = await milestoneOf(q, batchId);
  if (!node) throw internalError('批次没有正式上线里程碑节点');
  const at = o.atText === undefined ? null : o.atText;
  if (node.status === 'in_progress') {
    const recs = await q.all("SELECT kind, actual_date, corrects_kind FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start', 'actual_correct') ORDER BY id", [node.id]);
    const start = lastActualStart(recs);
    if (start !== null && start > o.dateStr) throw stateError('里程碑节点的实际开始晚于上线日期，请先更正实际开始');
    const r = await q.run(
      "UPDATE sysbuild_nodes SET status = 'closed', closed_at = COALESCE(?, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'in_progress'",
      [at, node.id]
    );
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
  } else if (node.status === 'not_started') {
    const r = await q.run(
      "UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(?, datetime('now','localtime')), closed_at = COALESCE(?, datetime('now','localtime')), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'not_started'",
      [at, at, node.id]
    );
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
    await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_start', ?, ?)", [node.id, o.dateStr, Number(user.id)]);
  } else {
    throw stateError('正式上线里程碑节点的状态不允许上线');
  }
  await q.run("INSERT INTO sysbuild_node_schedule_records (node_id, kind, actual_date, created_by) VALUES (?, 'actual_end', ?, ?)", [node.id, o.dateStr, Number(user.id)]);
  await emit(q, user, projectId, 'node', node.id, 'node_closed', { actual_date: o.dateStr, via: o.via, golive_event_id: o.goliveEventId, from: node.status });
  return node.id;
}
// 上线事件落库 + 批次 进行中 → 已上线（条件更新）+ 里程碑节点收口 + 事件。o：{ batch, kind（golive / regolive）, dateStr,
//   createdAt（上线事件时刻，null = 此刻）, milestoneAt（里程碑节点的收口 / 开始时刻，null = 此刻）, via }。
//   返回 { goliveEventId, milestoneNodeId }。调用方负责权限 / 状态 / 前置（golive.js 端点在写事务里按当时状态重核）。
async function recordGolive(q, user, o) {
  const b = o.batch;
  const uid = Number(user.id);
  const ins = o.createdAt === null || o.createdAt === undefined
    ? await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, created_by) VALUES (?, ?, ?)', [b.id, o.kind, uid])
    : await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, created_by, created_at) VALUES (?, ?, ?, ?)', [b.id, o.kind, uid, o.createdAt]);
  const up = await q.run('UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['live', b.id, 'active']);
  if (up.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
  const milestoneNodeId = await closeMilestoneForGolive(q, user, b.project_id, b.id, { dateStr: o.dateStr, atText: o.milestoneAt === null ? undefined : o.milestoneAt, via: o.via, goliveEventId: ins.lastID });
  await emit(q, user, b.project_id, 'batch', b.id, 'golive_recorded', { kind: o.kind, golive_event_id: ins.lastID, via: o.via, milestone_node_id: milestoneNodeId });
  await emit(q, user, b.project_id, 'batch', b.id, 'batch_status_changed', { from: 'active', to: 'live', via: o.via, golive_event_id: ins.lastID });
  return { goliveEventId: ins.lastID, milestoneNodeId };
}
// 撤销上线（用户已拍板 T-D3）：revoke 事件（只追加）+ 批次 已上线 → 进行中 + 里程碑 已收口 → 进行中（写节点事件）；本批其他已收口节点不动（需要时 PM 按 D45 重开）。
async function recordRevoke(q, user, batch, reason) {
  const uid = Number(user.id);
  const ins = await q.run('INSERT INTO sysbuild_golive_events (batch_id, kind, reason, created_by) VALUES (?, ?, ?, ?)', [batch.id, 'revoke', reason, uid]);
  const up = await q.run('UPDATE sysbuild_batches SET status = ? WHERE id = ? AND status = ?', ['active', batch.id, 'live']);
  if (up.changes === 0) throw stateError('批次状态已变化，请刷新后重试');
  const node = await milestoneOf(q, batch.id);
  if (!node) throw internalError('批次没有正式上线里程碑节点');
  if (node.status === 'closed') {
    const r = await q.run("UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'", [node.id]);
    if (r.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
    await emit(q, user, batch.project_id, 'node', node.id, 'node_reopened', { reason, via: 'revoke_golive', golive_event_id: ins.lastID });
  }
  await emit(q, user, batch.project_id, 'batch', batch.id, 'golive_revoked', { golive_event_id: ins.lastID, reason, milestone_node_id: node.id });
  await emit(q, user, batch.project_id, 'batch', batch.id, 'batch_status_changed', { from: 'live', to: 'active', via: 'revoke_golive', golive_event_id: ins.lastID });
  return { goliveEventId: ins.lastID, milestoneNodeId: node.id };
}

module.exports = {
  planPendingOf, goliveBlockersOf,
  goliveInfoOf, closingPendingOf, goliveProgressOf, closeMilestoneForGolive, recordGolive, recordRevoke,
};
