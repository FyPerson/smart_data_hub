'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const REVIEW_TASK = '第五步四角色意见评估与阶段任务走查';
const CUT_AND_CLOSE = '第五步砍需求本人表态、调整与结项待办走查';

function defineCases({ people, api, project, assignParty, pageFor, visit, contains, options, out, suffix, target, declareViaCard, preparePairVersion }) {
    return [[REVIEW_TASK, async (pm) => {
        const pid = await project('第五步意见任务_' + suffix);
        await assignParty(pid, 'demand', '走查需求方', people.owner, people.delegate);
        await assignParty(pid, 'dev', '走查开发方', people.member, people.outsider);
        const dialog = (page) => page.locator('#sbuiDialog');
        const field = (page, key) => dialog(page).locator('[name="' + key + '"]');
        const button = (page, name) => page.getByRole('button', { name, exact: true });
        const dialogButton = (page, name) => dialog(page).getByRole('button', { name, exact: true });
        const shot = async (page, marker, name) => {
            await marker.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(out, 'step5-' + name + '.png') });
        };
        const title = '本期补一个库存对账入口';
        await visit(pm, '#project=' + pid);
        await button(pm, '提意见或需求').click();
        await field(pm, 'title').fill(title);
        await field(pm, 'body').fill('请保留对账流水结果，并汇报相应的工作量。');
        assert.strictEqual(await dialog(pm).locator('[name="node"]').count(), 0);
        await dialogButton(pm, '提交意见').click();
        await pm.getByRole('heading', { name: title, exact: true }).waitFor();
        const href = new URL(pm.url()).hash;
        const id = Number(new URLSearchParams(href.slice(1)).get('opinion'));
        assert.ok(id);
        await button(pm, 'PM 初判').click();
        await field(pm, 'category').selectOption('requirement');
        await field(pm, 'text').fill('请开发核算对账流程与前端页面工作量。');
        await dialogButton(pm, '保存初判').click();
        await contains(pm, '待开发给意见与工时');
        for (const [account, role] of [[people.owner, '领导'], [people.delegate, '负责人']]) {
            const view = await pageFor(account, options.mutation);
            try {
                await visit(view.page, href);
                const state = view.page.locator('.sbui-drawer').getByText('待开发给意见与工时', { exact: true });
                await state.waitFor();
                assert.strictEqual(await button(view.page, '填写开发意见与工时').count(), 0);
                await shot(view.page, state, role + '-意见进度');
            } finally {
                await view.context.close();
            }
        }
        const developer = await pageFor(people.outsider, options.mutation);
        try {
            await visit(developer.page, '#project=' + pid);
            await target('step5-opinion-todo-link', () => developer.page.getByRole('link', { name: '查看本项目意见待办', exact: true }).click());
            const matching = developer.page.getByRole('row').filter({ hasText: title });
            await matching.getByRole('link', { name: '查看意见', exact: true }).click();
            await button(developer.page, '填写开发意见与工时').click();
            await field(developer.page, 'text').fill('可以复用现有查询，补一个项目内入口。');
            await field(developer.page, 'estimated_hours').fill('1.5');
            await dialogButton(developer.page, '提交开发意见').click();
            await shot(developer.page, developer.page.getByText('1.5 小时', { exact: true }), '开发负责人-评估');
            await pm.reload({ waitUntil: 'domcontentloaded' });
            await target('step5-disposal', () => button(pm, 'PM 定去向').click());
            await field(pm, 'outcome').selectOption('now');
            await field(pm, 'text').fill('本期做，并按已记录的工时追踪完成。');
            await dialogButton(pm, '保存去向').click();
            const resolved = pm.getByRole('heading', { name: '结论 · 本期做', exact: true });
            await shot(pm, resolved, 'PM-本期结论');
            const link = pm.getByRole('link', { name: '查看已生成任务', exact: true });
            const taskHref = await link.getAttribute('href');
            await target('step5-task-link', async () => {
                assert.ok(taskHref?.includes('&work_task='));
                await visit(developer.page, taskHref);
                await button(developer.page, '标为完成').click();
            });
            await field(developer.page, 'text').fill('对账入口联调完成。');
            await dialogButton(developer.page, '标为完成').click();
            const task = Number(new URLSearchParams(new URL(developer.page.url()).hash.slice(1)).get('work_task'));
            await shot(developer.page, developer.page.getByText('对账入口联调完成。', { exact: true }), '开发负责人-任务完成');
            const saved = await api(people.pm, 'GET', '/tasks/' + task);
            assert.deepStrictEqual([saved.task.source_opinion_id, saved.task.assignee_user_id, saved.task.status], [id, people.outsider.id, 'done']);
        } finally {
            await developer.context.close();
        }
    }], [CUT_AND_CLOSE, async (pm) => {
        const pid = await project('砍需求与结项走查_' + suffix);
        await assignParty(pid, 'demand', '范围原确认需求部门', people.owner, people.delegate);
        await assignParty(pid, 'dev', '提出调整的开发方', people.member, people.outsider);
        const projectPath = '/projects/' + pid;
        const call = (method, route, body, expected) => api(people.pm, method, route, body, expected);
        const plan = await call('GET', projectPath + '/plan');
        const closingNode = plan.nodes.find((n) => n.template_key === 'p_closing');
        const milestone = plan.nodes.find((n) => n.is_golive_milestone);
        const batch = plan.batches[0].id;
        const versionPath = (id) => '/package-versions/' + id;
        const packageHref = (id) => '#project=' + pid + '&tab=packages&version=' + id;
        const opinionHref = (id) => '#project=' + pid + '&tab=opinions&opinion=' + id;
        const stageHref = '#project=' + pid + '&tab=plan&node=' + closingNode.id;
        const dialog = (page) => page.locator('#sbuiDialog');
        const button = (page, name) => page.getByRole('button', { name, exact: true });
        const save = (page, name) => dialog(page).getByRole('button', { name, exact: true });
        const field = (page, name) => dialog(page).locator('[name="' + name + '"]');
        const shot = async (page, item, name) => {
            await item.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(out, 'step5-' + name + '.png') });
        };
        async function draft(type, batchId) {
            const pkg = (await call('POST', projectPath + '/packages', { type, ...(batchId ? { batch_id: batchId } : {}) }, 201)).package.id;
            const id = (await call('POST', '/packages/' + pkg + '/versions', {}, 201)).version.id;
            if (type === 'overall' || type === 'batch_accept') await preparePairVersion(pid, id, type);
            else {
                const saved = await call('GET', versionPath(id));
                await call('PATCH', versionPath(id), { snapshot_json: { ...saved.snapshot_json, text: '第五步走查确认正文' } });
            }
            return id;
        }
        async function makeEffective(vid, person) {
            await call('POST', versionPath(vid) + '/submit', {});
            const tasks = (await call('GET', versionPath(vid) + '/confirm-tasks')).tasks;
            assert.strictEqual(tasks.length, 1);
            const id = tasks[0].task_id;
            const seen = await api(person, 'GET', '/confirm-tasks/' + id);
            await api(person, 'POST', '/confirm-tasks/' + id + '/decide', {
                revision_id: seen.revision.id, object_version_id: seen.task.object_version_id,
                decision: 'confirm', checkbox_text: seen.checkbox_texts.confirm,
            });
        }
        await declareViaCard(pm, pid);
        await makeEffective(await draft('initiation'), people.owner);
        for (const node of [closingNode, milestone]) await call('POST', '/nodes/' + node.id + '/schedule',
            { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
        const scope = await draft('overall');
        await makeEffective(scope, people.delegate);
        await makeEffective(await draft('batch_accept', batch), people.delegate);
        await call('POST', '/batches/' + batch + '/golive', {});
        await call('POST', '/nodes/' + milestone.id + '/materials/operations-handover/not-applicable', { reason: '走查样本由原值班人员覆盖运维交接' }, 201);
        await call('POST', '/nodes/' + closingNode.id + '/start', {});
        const closing = await draft('closing');
        const lead = await pageFor(people.owner, options.mutation);
        const resp = await pageFor(people.delegate, options.mutation);
        const dev = await pageFor(people.outsider, options.mutation);
        try {
            const title = '本期移出库存提醒短信';
            await visit(dev.page, '#project=' + pid + '&tab=opinions');
            await button(dev.page, '提意见或需求').click();
            await field(dev.page, 'title').fill(title);
            await field(dev.page, 'body').fill('本期继续站内提醒，短信配套按后续范围决定。');
            await field(dev.page, 'estimated_hours').fill('0');
            await save(dev.page, '提交意见').click();
            await dev.page.getByRole('heading', { name: title, exact: true }).waitFor();
            const url = new URL(dev.page.url()).hash;
            const opinion = Number(new URLSearchParams(url.slice(1)).get('opinion'));
            assert.equal(url, opinionHref(opinion));
            await visit(pm, url);
            await button(pm, 'PM 初判').click();
            await field(pm, 'category').selectOption('cut');
            await field(pm, 'text').fill('请原需求部门负责人核对这条本期范围调整。');
            await save(pm, '保存初判').click();
            await contains(pm, '待需求方负责人同意');

            await visit(pm, packageHref(closing));
            const blocker = pm.locator('section').filter({ has: pm.getByRole('heading', { name: '待处理任务和意见', exact: true }) }).last();
            await target('step5-closing-version-link', async () => {
                const link = blocker.getByRole('link', { name: title, exact: true });
                await shot(pm, link, 'PM-结项版本待办');
                await link.click();
                await pm.getByRole('heading', { name: title, exact: true }).waitFor();
            });
            await visit(pm, stageHref);
            await target('step5-closing-stage-link', async () => {
                const link = pm.locator('ul.sbui-checklist').getByRole('link', { name: title, exact: true });
                await shot(pm, link, 'PM-结项阶段待办');
                await link.click();
                await pm.getByRole('heading', { name: title, exact: true }).waitFor();
            });

            await visit(lead.page, url);
            const table = lead.page.getByRole('heading', { name: '需求部门表态', exact: true });
            await table.waitFor();
            assert.equal(await button(lead.page, '本人表态').count(), 0);
            await shot(lead.page, table, '领导-砍需求只读');
            await visit(resp.page, '#project=' + pid);
            await resp.page.getByRole('link', { name: '查看本项目意见待办', exact: true }).click();
            await resp.page.getByRole('row').filter({ hasText: title }).getByRole('link', { name: '查看意见', exact: true }).click();
            await target('step5-cut-personal', () => button(resp.page, '本人表态').click());
            await field(resp.page, 'decision').selectOption('agree');
            await shot(resp.page, field(resp.page, 'decision'), '负责人-本人表态');
            await save(resp.page, '提交本人表态').click();
            await resp.page.getByRole('heading', { name: '结论 · 同意本期移出范围', exact: true }).waitFor();
            await visit(pm, packageHref(scope));
            const adjustment = pm.locator('section').filter({ has: pm.getByRole('heading', { name: '确认之后的调整', exact: true }) }).last();
            await shot(pm, adjustment.getByRole('link', { name: title, exact: true }), 'PM-范围调整记录');
            assert.deepStrictEqual((await call('GET', versionPath(scope))).scope_adjustments.map((row) => row.opinion_id), [opinion]);
            await visit(pm, '#project=' + pid + '&tab=notifications');
            await shot(pm, pm.getByText('砍需求待同意知悉', { exact: true }).first(), 'PM-砍需求知悉');

            const next = (await api(people.outsider, 'POST', projectPath + '/opinions', { title: '保持原范围的对照意见', body: '对照撤回同意请求。', estimated_hours: 0 }, 201)).opinion;
            await call('POST', '/opinions/' + next.id + '/actions', { action: 'triage', decision: 'continue', category: 'cut', text: '对照记录已进入待同意。' });
            await visit(pm, opinionHref(next.id));
            await button(pm, '撤回同意请求').click();
            await field(pm, 'text').fill('经复核，本期保留原范围。');
            await save(pm, '确认撤回').click();
            await pm.getByRole('heading', { name: '结论 · 维持原范围', exact: true }).waitFor();
            assert.deepStrictEqual((await call('GET', versionPath(scope))).scope_adjustments.map((row) => row.opinion_id), [opinion]);
        } finally {
            await dev.context.close();
            await resp.context.close();
            await lead.context.close();
        }
    }]];
}

const MUTATIONS = [
    { id: 'step5-hide-dispose', file: 'sysbuild-work.js', from: 'if (o.actions.dispose === true) actions.appendChild', to: 'if (false) actions.appendChild', expect: REVIEW_TASK, expectFailure: '[step5-disposal]' },
    { id: 'step5-hide-task-result', file: 'sysbuild-work.js', from: "buttons.appendChild(A.command('标为完成'", to: "buttons.appendChild(A.command('错误入口'", expect: REVIEW_TASK, expectFailure: '[step5-task-link]' },
    { id: 'step5-task-url-overwrites-confirmation', file: 'sysbuild-work.js', from: 'work_task: workTask', to: 'task: workTask', expect: REVIEW_TASK, expectFailure: '[step5-task-link]' },
    { id: 'step5-hide-personal-cut', file: 'sysbuild-work.js', from: "row.can_decide === true ? A.command('本人表态'", to: "false ? A.command('本人表态'", expect: CUT_AND_CLOSE, expectFailure: '[step5-cut-personal]' },
    { id: 'step5-missing-closing-version-link', file: 'sysbuild-packages.js', from: 'A.row(...data.submit_block.pending_work.map((item) => A.work.itemLink(detail.project.id, item)))', to: 'null', expect: CUT_AND_CLOSE, expectFailure: '[step5-closing-version-link]' },
    { id: 'step5-missing-closing-stage-link', file: 'sysbuild-plan.js', from: 'if (r.pending_work?.length) item.appendChild', to: 'if (false) item.appendChild', expect: CUT_AND_CLOSE, expectFailure: '[step5-closing-stage-link]' },
    { id: 'step5-missing-opinion-todo-link', file: 'sysbuild-page.js', from: "if (opinions.length) pending.appendChild(A.link('查看本项目意见待办'", to: "if (false) pending.appendChild(A.link('查看本项目意见待办'", expect: REVIEW_TASK, expectFailure: '[step5-opinion-todo-link]' },
];

module.exports = { defineCases, MUTATIONS };
