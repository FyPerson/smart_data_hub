'use strict';

const { makeError } = require('./db');
const { ACCEPTANCE_NODE_KEYS, ACTIVE_BATCH_STATUSES } = require('./templates');

const ROLES = Object.freeze({
  acceptance: Object.freeze(['acceptance']),
  golive: Object.freeze(['golive']),
  combined: Object.freeze(['acceptance', 'golive']),
  closing: Object.freeze(['closing']),
});

const snapshotError = () => makeError(500, 'SYSBUILD_INTERNAL', '范围确认计划快照无法核对');
const planBlocked = (message) => ({ entries: null, blocked: message });
const positiveId = (v) => Number.isSafeInteger(v) && v > 0;

function validDate(s) {
  if (typeof s !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!parts) return false;
  const [year, month, day] = parts.slice(1).map(Number);
  if (year < 2000 || year > 2099) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function validDates(item) {
  return validDate(item.planned_start) && validDate(item.planned_end) && item.planned_start <= item.planned_end;
}

function expectedNodes(buildType, batchId) {
  const accept = ACCEPTANCE_NODE_KEYS[buildType];
  if (!accept) throw snapshotError();
  return [
    ...(buildType === 'inhouse'
      ? [{ batchId, key: accept, milestone: true, label: '验收和正式上线', roles: ROLES.combined }]
      : [{ batchId, key: accept, milestone: false, label: '验收', roles: ROLES.acceptance },
         { batchId, key: 'b_trial', milestone: true, label: '正式上线', roles: ROLES.golive }]),
    { batchId: null, key: 'p_closing', milestone: false, label: '结项', roles: ROLES.closing },
  ];
}

async function currentScopePlans(q, projectId, buildType) {
  const batches = await q.all('SELECT id, name, status FROM sysbuild_batches WHERE project_id = ? ORDER BY seq, id', [projectId]);
  const active = batches.filter((b) => ACTIVE_BATCH_STATUSES.includes(b.status));
  if (active.length !== 1) return planBlocked('范围确认要求恰有一个有效批次，请核对项目批次');
  const [batch] = active;
  const nodes = await q.all(
    'SELECT id, batch_id, name, template_key, is_golive_milestone, status FROM sysbuild_nodes WHERE project_id = ? AND (batch_id IS NULL OR batch_id = ?)',
    [projectId, batch.id]
  );
  const resolved = [];
  const unavailable = [];
  for (const expected of expectedNodes(buildType, batch.id)) {
    const matches = nodes.filter((node) => node.batch_id === expected.batchId
      && (expected.milestone ? node.is_golive_milestone === 1 : node.template_key === expected.key));
    const match = matches.length === 1 ? matches[0] : null;
    if (!match || match.template_key !== expected.key || match.is_golive_milestone !== Number(expected.milestone) || match.status === 'cancelled') {
      unavailable.push(match && match.template_key === expected.key ? match.name : expected.label);
    } else resolved.push({ node: match, roles: expected.roles });
  }
  if (unavailable.length) return planBlocked('范围确认所需阶段缺失、重复或已取消：' + unavailable.join('、'));
  const entries = [];
  const missing = [];
  for (const { node, roles } of resolved) {
    const dates = await q.get(
      "SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1",
      [node.id]
    );
    if (!dates || !validDates(dates)) missing.push(node.batch_id === null ? node.name : `${node.name}（${batch.name}）`);
    else entries.push({
      node_id: node.id, name: node.name, template_key: node.template_key, layer: node.batch_id === null ? 'project' : 'batch',
      batch_id: node.batch_id, batch_name: node.batch_id === null ? null : batch.name,
      planned_start: dates.planned_start, planned_end: dates.planned_end, roles,
    });
  }
  return missing.length ? planBlocked('以下阶段还没有有效的计划起止日期：' + missing.join('、')) : { entries, blocked: null };
}

const sameRoles = (a, b) => Array.isArray(a) && a.length === b.length && a.every((role, i) => role === b[i]);

async function submittedNodePlans(q, projectId, versionId) {
  const row = await q.get(
    `SELECT pr.build_type, p.id AS package_id, e.payload_json
       FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
       JOIN sysbuild_projects pr ON pr.id = p.project_id
       JOIN sysbuild_events e ON e.project_id = pr.id AND e.object_type = 'package_version' AND e.object_id = v.id
        AND e.event_type = 'package_version_submitted'
      WHERE pr.id = ? AND v.id = ? AND p.type = 'overall'
      ORDER BY e.id DESC LIMIT 1`, [projectId, versionId]
  );
  if (!row) throw snapshotError();
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch (_) { throw snapshotError(); }
  if (!payload || payload.package_id !== row.package_id || payload.type !== 'overall' || !Array.isArray(payload.node_plans)) throw snapshotError();
  const plans = payload.node_plans;
  const batchId = plans[0]?.batch_id;
  if (!positiveId(batchId)) throw snapshotError();
  const expected = expectedNodes(row.build_type, batchId);
  const seen = new Set();
  if (plans.length !== expected.length) throw snapshotError();
  for (const [i, item] of plans.entries()) {
    const rule = expected[i];
    if (!item || !positiveId(item.node_id) || seen.has(item.node_id) || item.template_key !== rule.key
      || !sameRoles(item.roles, rule.roles) || item.batch_id !== rule.batchId || item.layer !== (rule.batchId === null ? 'project' : 'batch')
      || typeof item.name !== 'string' || !item.name.trim() || !validDates(item)
      || (rule.batchId === null ? item.batch_name !== null : typeof item.batch_name !== 'string' || !item.batch_name.trim())) throw snapshotError();
    seen.add(item.node_id);
  }
  const batch = await q.get('SELECT id FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, projectId]);
  if (!batch) throw snapshotError();
  for (const [i, item] of plans.entries()) {
    const node = await q.get('SELECT template_key, batch_id, is_golive_milestone FROM sysbuild_nodes WHERE id = ? AND project_id = ?', [item.node_id, projectId]);
    if (!node || node.template_key !== item.template_key || node.batch_id !== item.batch_id || node.is_golive_milestone !== Number(expected[i].milestone)) throw snapshotError();
  }
  return plans;
}

module.exports = { currentScopePlans, submittedNodePlans, snapshotError, validDate };
