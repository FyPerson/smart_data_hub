'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { listenOnSafePort } = require('./listen-safe-port');

const CARDS = 'B6.1 项目卡片、预计完成和未截断本人项';
const DUE = 'B6.1 已逾期的本人应交仍触发落点';
const FIELD_ACCESS = 'B6.1 卡片详情资格独立于允许列出的行';
const STAGE_ORDER = 'B7.1 首页阶段顺序和当前阶段';
const addDays = (day, delta) => {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};

function defineDashboardCases({ test, U, api, sqlRun, sqlGet, addParty, addMember, addAppointment, addDelegation, expectErr, getModuleDir, confirm: H }) {
  const get = (user, route) => api(user, 'GET', '/sysbuild' + route);
  const post = (user, route, body = {}) => api(user, 'POST', '/sysbuild' + route, body);
  const cards = (user, scope = 'mine') => get(user, '/project-cards?scope=' + scope);
  const find = (res, pid) => {
    assert.strictEqual(res.status, 200, res.text);
    return res.body.projects.find((item) => item.id === pid);
  };
  async function seedDev(pid) {
    const id = await addParty(pid, '卡片开发组', 'dev');
    const lead = await addMember(pid, U.x1, { party: id });
    const person = await addMember(pid, U.x2, { party: id });
    await addDelegation(id, person, await addAppointment(id, lead, 'active'), 'active');
  }

  test(STAGE_ORDER, async () => {
    const pid = await H.newProject();
    const response = await get(U.pm, '/projects/' + pid + '/plan');
    assert.strictEqual(response.status, 200, response.text);
    const { nodes } = response.body;
    const stage = (key) => nodes.find((node) => node.template_key === key).id;
    const initiation = stage('p_initiation');
    const overall = stage('p_overall');
    const dev = stage('b_dev');
    const closing = stage('p_closing');
    const custom = await post(U.pm, '/batches/' + response.body.batches[0].id + '/nodes', { name: '本期临时阶段' });
    assert.strictEqual(custom.status, 201, custom.text);
    const cancelled = await post(U.pm, '/nodes/' + custom.body.node.id + '/cancel', { reason: '本期无需此阶段' });
    assert.strictEqual(cancelled.status, 200, cancelled.text);
    for (const id of [initiation, overall]) {
      const started = await post(U.pm, '/nodes/' + id + '/start');
      assert.strictEqual(started.status, 200, started.text);
      const completed = await post(U.pm, '/nodes/' + id + '/close');
      assert.strictEqual(completed.status, 200, completed.text);
    }
    const beforeDev = find(await cards(U.pm), pid).card;
    assert.strictEqual(beforeDev.current_stage.id, dev, '[stage-order] 开发未开始时当前阶段应为开发');
    const delivery = nodes.filter((node) => node.batch_id !== null).map((node) => node.id);
    const expected = [initiation, overall, ...delivery, closing];
    assert.deepStrictEqual(beforeDev.stages.map((node) => node.id), expected, '[stage-order] 首页进度中的结项在批次之后');
    const updated = await get(U.pm, '/projects/' + pid + '/plan');
    assert.strictEqual(updated.status, 200, updated.text);
    assert.deepStrictEqual(updated.body.nodes.map((node) => node.id), [...nodes.map((node) => node.id), custom.body.node.id]);
    assert.deepStrictEqual(updated.body.display_stage_ids, expected, '[stage-order] 左栏使用同一个顺序并排除已取消阶段');
    await seedDev(pid);
    for (const id of [closing, dev]) {
      const started = await post(U.pm, '/nodes/' + id + '/start');
      assert.strictEqual(started.status, 200, started.text);
    }
    assert.strictEqual(find(await cards(U.pm), pid).card.current_stage.id, closing, '[stage-order] 取展示顺序中最后一个进行中阶段');
  });

  test(CARDS, async () => {
    const pid = await H.newProject();
    await H.seedParty(pid, '卡片需求组', U.own, U.del);
    await seedDev(pid);
    const plan = (await get(U.pm, '/projects/' + pid + '/plan')).body;
    const closing = plan.nodes.find((node) => node.template_key === 'p_closing');
    const dev = plan.nodes.find((node) => node.template_key === 'b_dev');
    const first = find(await cards(U.pm), pid).card;
    assert.strictEqual(first.current_stage.id, plan.nodes[0].id);
    assert.strictEqual(first.estimated_completion.date, null);
    assert.strictEqual(first.range_unconfirmed_started, false);
    assert.deepStrictEqual(first.stages.map((stage) => stage.id), plan.display_stage_ids);
    assert.deepStrictEqual(first.parties.map((party) => [party.side, party.name]), [['demand', '卡片需求组'], ['dev', '卡片开发组']]);
    const opened = await post(U.pm, '/nodes/' + dev.id + '/start');
    assert.strictEqual(opened.status, 200, opened.text);
    const day = opened.body.node.actual_start;
    const due = addDays(day, 14);
    const scheduled = await post(U.pm, '/nodes/' + closing.id + '/schedule', { kind: 'plan', planned_start: day, planned_end: due });
    assert.strictEqual(scheduled.status, 201, scheduled.text);
    const active = find(await cards(U.pm), pid).card;
    assert.deepStrictEqual([active.range_unconfirmed_started, active.current_stage.id], [true, dev.id]);
    assert.deepStrictEqual(active.estimated_completion, { date: due, as_of: day, days_remaining: 14, tone: 'warning', delay_days: null });
    const materialCards = (await get(U.pm, '/projects/' + pid + '/materials')).body.cards.filter((card) => card.required);
    assert.deepStrictEqual(active.required, { done: materialCards.filter((card) => card.complete).length, total: materialCards.length });

    const sameNumber = 1000000 + pid;
    await sqlRun("INSERT INTO sysbuild_opinions(id,project_id,author_user_id,author_name,author_side,title,body) VALUES (?,?,?,'项目成员','internal','同编号意见','只用于同编号去重的对照')", [sameNumber, pid, U.pm]);
    for (let i = 0; i < 54; i += 1) {
      await sqlRun("INSERT INTO sysbuild_tasks(id,project_id,node_id,title,assignee_user_id,created_by) VALUES (?,?,?,'卡片计数夹具',?,?)", [sameNumber + i, pid, dev.id, U.pm, U.pm]);
    }
    const todo = (await get(U.pm, '/my/todo')).body;
    assert.strictEqual(todo.items.work_task.length, 50);
    assert.ok(todo.counts.work_task >= 54);
    const response = await cards(U.pm);
    const counted = find(response, pid).card;
    assert.deepStrictEqual([counted.pending_opinions, counted.waiting.count, response.body.default_view], [1, 55, 'todo']);
    const phase = (await get(U.pm, '/projects/' + pid + '/plan')).body.project;
    assert.deepStrictEqual(phase.estimated_completion, counted.estimated_completion);
    const old = await get(U.pm, '/projects?scope=mine');
    assert.deepStrictEqual(response.body.projects.map(({ card, ...fields }) => fields), old.body.projects);
    assert.strictEqual(find(await cards(U.out), pid), undefined, '非成员自己的列表没有该项目');
    expectErr(await cards(U.out, 'all'), 403, 'SYSBUILD_FORBIDDEN');
    assert.strictEqual(find(await cards(U.ro, 'all'), pid).card.pending_opinions, 1, '可列全部且可查看项目详情的只读角色沿旧口径');
    for (const viewer of [U.pm, U.own, U.del, U.x1, U.x2, U.ro, U.admin, U.out]) {
      for (const subpath of ['', '/materials', '/opinions']) {
        const read = await get(viewer, '/projects/' + pid + subpath);
        assert.strictEqual(read.status, viewer === U.out ? 404 : 200, subpath + ' 项目可见性：' + read.text);
      }
    }
    for (const viewer of [U.del, U.x2]) {
      const list = (await get(viewer, '/projects/' + pid + '/opinions')).body.opinions;
      assert.ok(list.some((item) => item.id === sameNumber), '项目成员可读本项目内部成员提出的意见');
      const material = (await get(viewer, '/projects/' + pid + '/materials')).body;
      const need = material.cards.filter((card) => card.required);
      const view = find(await cards(viewer), pid).card;
      assert.deepStrictEqual(view.required, { done: need.filter((card) => card.complete).length, total: need.length });
      assert.strictEqual(view.pending_opinions, list.filter((item) => item.status !== 'concluded').length);
    }

    const cardModule = require(path.join(getModuleDir(), 'dashboard.js'));
    const single = cardModule.projectTodoCounts({
      confirm: [{ project_id: pid, revision_id: 1 }],
      handle: [{ project_id: pid, revision_id: 1 }],
      report_due: [{ project_id: pid, node_id: 3, due_on: day }, { project_id: pid, node_id: 3, due_on: day }],
      work_task: [{ project_id: pid, work_task_id: 1 }],
      overdue: [{ project_id: pid, revision_id: 2 }],
    });
    assert.strictEqual(single[pid].count, 3);
    const deadline = require(path.join(getModuleDir(), 'plan.js')).projectCompletion;
    for (const [delta, tone] of [[-1, 'danger'], [0, 'danger'], [1, 'danger'], [3, 'danger'], [4, 'warning'], [14, 'warning'], [15, null]]) {
      const estimate = deadline('active', { current_plan: { end: addDays(day, delta) }, diff_days: 2 }, day);
      assert.deepStrictEqual([estimate.days_remaining, estimate.tone, estimate.delay_days], [delta, tone, 2]);
    }
    for (const status of ['paused', 'closed', 'terminated']) {
      const estimate = deadline(status, { current_plan: { end: due }, diff_days: 2 }, day);
      assert.deepStrictEqual([estimate.date, estimate.days_remaining, estimate.tone, estimate.delay_days], [due, null, null, null]);
    }
    await H.produceEffectiveOverall(pid);
    const later = addDays(day, 15);
    const moved = await post(U.pm, '/nodes/' + closing.id + '/schedule', {
      kind: 'plan', planned_start: day, planned_end: later, reason: '按实际交付节奏顺延一天',
      no_written_evidence: true, no_evidence_reason: '本次是内部排期沟通后形成的共同安排',
    });
    assert.strictEqual(moved.status, 201, moved.text);
    const estimate = find(await cards(U.pm), pid).card.estimated_completion;
    assert.deepStrictEqual([estimate.date, estimate.delay_days, estimate.tone], [later, 1, null]);
    assert.deepStrictEqual((await get(U.pm, '/projects/' + pid + '/plan')).body.project.estimated_completion, estimate);

    const vid = await H.mkPreparedVersion(await H.mkPackage(pid, 'batch_accept', plan.batches[0].id));
    const submitted = await post(U.pm, '/package-versions/' + vid + '/submit');
    assert.strictEqual(submitted.status, 200, submitted.text);
    assert.strictEqual(find(await cards(U.del), pid).card.waiting.count, 1, '实际产生的待确认修订');
    const task = (await H.tasksOf(vid))[0];
    const rejected = await H.openAndDecide(U.del, task.task_id, 'object');
    assert.strictEqual(rejected.status, 200, rejected.text);
    // 使用真实生成的意图，模拟渠道失败。
    const sent = await sqlGet("SELECT id FROM sysbuild_send_intents WHERE project_id=? AND purpose='confirm_request' ORDER BY id DESC LIMIT 1", [pid]);
    assert.ok(sent?.id);
    await sqlRun("UPDATE sysbuild_send_intents SET status='failed',last_error='隔离样本渠道失败' WHERE id=?", [sent.id]);
    const pmTodo = (await get(U.pm, '/my/todo')).body;
    const handle = pmTodo.items.handle.filter((item) => item.project_id === pid);
    const failed = pmTodo.items.send_failed.filter((item) => item.project_id === pid);
    assert.strictEqual(handle.length, 1, '实际被拒的确认进 PM 办理');
    assert.ok(failed.some((item) => item.intent_id === sent.id));
    assert.deepStrictEqual(find(await cards(U.pm), pid).card.waiting, { count: 55 + handle.length + failed.length, send_failed: true });

    const paused = await post(U.admin, '/projects/' + pid + '/status', { to: 'paused', reason: '暂停时只需显示计划日期' });
    assert.strictEqual(paused.status, 200, paused.text);
    assert.strictEqual(find(await cards(U.pm), pid).card.estimated_completion.days_remaining, null);
    const ended = await post(U.admin, '/projects/' + pid + '/status', { to: 'terminated', reason: '归档区只取计划日期' });
    assert.strictEqual(ended.status, 200, ended.text);
    const compact = find(await cards(U.pm), pid).card;
    assert.deepStrictEqual(Object.keys(compact), ['estimated_completion']);
    assert.deepStrictEqual(compact.estimated_completion, (await get(U.pm, '/projects/' + pid + '/plan')).body.project.estimated_completion);
    assert.deepStrictEqual([compact.estimated_completion.date, compact.estimated_completion.days_remaining], [later, null]);
  });

  test(FIELD_ACCESS, async () => {
    const { createDashboardRoutes } = require(path.join(getModuleDir(), 'dashboard.js'));
    const row = { id: 99, system_name: '只允许列出的行', status: 'active', build_type: 'inhouse' };
    const app = express();
    app.use((req, res, next) => { req.user = { id: 11 }; next(); });
    app.use(createDashboardRoutes({
      db: { withRead: (fn) => fn({ get: async () => null, all: async () => [] }) },
      logger: { error() {} },
      projectRoutes: {
        listProjects: async () => ({ projects: [row], scope: 'all', actions: { list_all: true } }),
        canReadProject: async () => false,
        projectParties: async () => [{ side: 'demand', name: '受保护的项目责任信息', owner: { name: '受保护的姓名' } }],
      },
      notifyRoutes: { todoFor: async () => ({ counts: {}, items: {} }) },
      todayProvider: () => '2026-11-25',
    }).router);
    const server = await listenOnSafePort(app);
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/sysbuild/project-cards?scope=all');
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual((await response.json()).projects, [{ ...row, card: null }]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  test(DUE, async () => {
    const pid = await H.newProject();
    await seedDev(pid);
    const data = (await get(U.pm, '/projects/' + pid + '/plan')).body;
    const dev = data.nodes.find((node) => node.template_key === 'b_dev');
    const opened = await post(U.pm, '/nodes/' + dev.id + '/start');
    assert.strictEqual(opened.status, 200, opened.text);
    const today = opened.body.node.actual_start;
    await sqlRun("UPDATE sysbuild_node_schedule_records SET actual_date=? WHERE node_id=? AND kind='actual_start'", [addDays(today, -15), dev.id]);
    const mine = await cards(U.x2);
    assert.strictEqual(find(mine, pid).card.waiting.count, 1);
    assert.strictEqual(mine.body.default_view, 'todo');
    const me = (await get(U.x2, '/my/todo')).body;
    const due = me.items.report_due.find((row) => row.project_id === pid);
    assert.deepStrictEqual([due.node_id, due.due_on, due.overdue], [dev.id, addDays(today, -1), true]);
    assert.strictEqual(find(await cards(U.pm), pid).card.waiting.count, 0, '只有监管提醒时本项目不增加待办数');
  });
}

const dashboardMutations = [
  { id: 'B7.1 首页恢复项目层结项提前', expect: [STAGE_ORDER], edits: [
    { file: 'dashboard.js', from: 'const stages = displayStages(nodes, batchIds);', to: "const stages = nodes.filter((node) => node.status !== 'cancelled');" },
  ] },
  { id: 'B7.1 当前阶段误取第一个进行中', expect: [STAGE_ORDER], edits: [
    { file: 'dashboard.js', from: "stages.filter((node) => node.status === 'in_progress').at(-1)", to: "stages.find((node) => node.status === 'in_progress')" },
  ] },
  { id: 'B6.1 列表权限绕过卡片详情资格', expect: [FIELD_ACCESS], edits: [
    { file: 'dashboard.js', from: 'if (await projectRoutes.canReadProject(q, row.id, req.user))', to: 'if (true)' },
  ] },
  { id: 'B6.1 卡片待办误用截断清单', expect: [CARDS], edits: [
    { file: 'dashboard.js', from: 'notifyRoutes.todoFor(q, req.user, true)', to: 'notifyRoutes.todoFor(q, req.user)' },
  ] },
  { id: 'B6.1 同编号任务和意见误合并', expect: [CARDS], edits: [
    { file: 'dashboard.js', from: "return 'work_task:' + row.work_task_id", to: "return 'opinion:' + row.work_task_id" },
  ] },
  { id: 'B6.1 卡片漏掉实际早开工', expect: [CARDS], edits: [
    { file: 'dashboard.js', from: 'range_unconfirmed_started: nodes.some((node) => rangeUnconfirmedStarted(node, perNode[node.id] || [], overall))', to: 'range_unconfirmed_started: false' },
  ] },
  { id: 'B6.1 预计完成漏掉14天临界', expect: [CARDS], edits: [
    { file: 'plan.js', from: "days <= 14 ? 'warning' : null", to: "days < 14 ? 'warning' : null" },
  ] },
  { id: 'B6.1 卡片丢提交人自己的逾期', expect: [DUE], edits: [
    { file: 'dashboard.js', from: "if (kind === 'report_due' && row.node_id && row.due_on)", to: "if (kind === 'report_due' && row.node_id && row.due_on && !row.overdue)" },
  ] },
];

module.exports = { defineDashboardCases, dashboardMutations };
