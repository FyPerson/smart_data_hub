'use strict';

const express = require('express');
const { loadProjectCards } = require('./stage-cards');
const { pendingClosingWork } = require('./work-core');
const { effectiveOverallVersionId } = require('./packages');
const { deriveSchedule, projectCompletion, rangeUnconfirmedStarted, displayStages } = require('./plan');
const { todayOf } = require('./report-core');

const DEFAULT_TODO_KINDS = ['confirm', 'handle', 'report_due', 'opinion', 'work_task'];
const CARD_TODO_KINDS = [...DEFAULT_TODO_KINDS, 'send_failed'];

function todoObjectKey(kind, row) {
  if ((kind === 'confirm' || kind === 'handle') && row.revision_id) return 'confirmation_revision:' + row.revision_id;
  if (kind === 'handle' && row.entry_id) return 'entry:' + row.entry_id;
  if (kind === 'report_due' && row.node_id && row.due_on) return 'report_due:' + row.node_id + ':' + row.due_on;
  if (kind === 'opinion' && row.opinion_id) return 'opinion:' + row.opinion_id;
  if (kind === 'work_task' && row.work_task_id) return 'work_task:' + row.work_task_id;
  if (kind === 'send_failed' && row.intent_id) return 'send_intent:' + row.intent_id;
  return null;
}

function projectTodoCounts(items) {
  const projects = Object.create(null);
  for (const kind of CARD_TODO_KINDS) {
    for (const row of items[kind] || []) {
      const key = todoObjectKey(kind, row);
      if (key === null) continue;
      const project = projects[row.project_id] ??= { keys: new Set(), send_failed: false };
      project.keys.add(key);
      if (kind === 'send_failed') project.send_failed = true;
    }
  }
  return Object.fromEntries(Object.entries(projects).map(([id, value]) => [id, { count: value.keys.size, send_failed: value.send_failed }]));
}

async function cardFor(q, project, today, roles, waiting) {
  const nodes = await q.all(
    `SELECT n.id, n.name, n.status, n.template_key, n.batch_id FROM sysbuild_nodes n
       LEFT JOIN sysbuild_batches b ON b.id = n.batch_id AND b.project_id = n.project_id
      WHERE n.project_id = ? ORDER BY (n.batch_id IS NOT NULL), b.seq, b.id, n.sort_order, n.id`, [project.id]
  );
  const records = await q.all(
    `SELECT r.node_id, r.kind, r.planned_start, r.planned_end, r.actual_date, r.corrects_kind
       FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id
      WHERE n.project_id = ? AND (n.template_key = 'p_closing' OR r.kind = 'actual_start') ORDER BY r.id`, [project.id]
  );
  const perNode = Object.create(null);
  for (const record of records) {
    (perNode[record.node_id] ??= []).push(record);
  }
  const batchIds = [...new Set(nodes.filter((node) => node.batch_id !== null).map((node) => node.batch_id))];
  const stages = displayStages(nodes, batchIds);
  const current = stages.filter((node) => node.status === 'in_progress').at(-1) || stages.find((node) => node.status === 'not_started');
  const closing = nodes.find((node) => node.batch_id === null && node.template_key === 'p_closing');
  const closingSchedule = closing ? deriveSchedule(closing, perNode[closing.id] || [], today) : null;
  const overall = (await effectiveOverallVersionId(q, project.id)) !== null;
  const required = (await loadProjectCards(q, project)).filter((card) => card.required);
  const pending = await pendingClosingWork(q, project.id);
  return {
    parties: roles.map((row) => ({ name: row.name, side: row.side, leader: row.owner?.name ?? null, responsible: row.delegate?.name ?? null })),
    stages: stages.map(({ id, name, status }) => ({ id, name, status })),
    current_stage: current ? { id: current.id, name: current.name, status: current.status } : null,
    estimated_completion: projectCompletion(project.status, closingSchedule, today),
    range_unconfirmed_started: nodes.some((node) => rangeUnconfirmedStarted(node, perNode[node.id] || [], overall)),
    required: { done: required.filter((card) => card.complete).length, total: required.length },
    pending_opinions: pending.filter((item) => item.kind === 'opinion').length,
    waiting: waiting || { count: 0, send_failed: false },
  };
}

async function compactCardFor(q, project, today) {
  const node = await q.get("SELECT id, status FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS NULL AND template_key = 'p_closing'", [project.id]);
  const records = node ? await q.all(
    'SELECT kind, planned_start, planned_end, actual_date, corrects_kind FROM sysbuild_node_schedule_records WHERE node_id = ? ORDER BY id',
    [node.id]
  ) : [];
  return { estimated_completion: projectCompletion(project.status, node ? deriveSchedule(node, records, today) : null, today) };
}

function createDashboardRoutes({ db, logger, projectRoutes, notifyRoutes, todayProvider }) {
  const router = express.Router();
  router.get('/sysbuild/project-cards', async (req, res) => {
    try {
      const result = await db.withRead(async (q) => {
        const base = await projectRoutes.listProjects(q, req.user, req.query.scope);
        const todo = await notifyRoutes.todoFor(q, req.user, true);
        const counted = projectTodoCounts(todo.items);
        const today = todayOf(todayProvider);
        const projects = [];
        for (const row of base.projects) {
          let card = null;
          if (await projectRoutes.canReadProject(q, row.id, req.user)) {
            card = row.status === 'active' || row.status === 'paused'
              ? await cardFor(q, row, today, await projectRoutes.projectParties(q, row.id), counted[row.id])
              : await compactCardFor(q, row, today);
          }
          projects.push({ ...row, card });
        }
        return {
          ...base, projects,
          default_view: DEFAULT_TODO_KINDS.some((kind) => todo.counts[kind] > 0) ? 'todo' : 'list',
        };
      });
      res.json(result);
    } catch (error) {
      if (Number.isInteger(error.status) && error.status < 500 && error.code?.startsWith('SYSBUILD_')) {
        return res.status(error.status).json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
      }
      logger.error('[sysbuild/dashboard]', error);
      return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
    }
  });
  return { router };
}

module.exports = { createDashboardRoutes, projectTodoCounts };
