'use strict';
const assert = require('node:assert/strict');

const STAGES = '第七步首页与左栏顺序和阶段操作文案';
const CLOSEOUT_WORDING = '第七步抽屉遮罩与收尾页面用词';
const WORK_BACK_LINKS = '第七步意见与任务抽屉返回原页';

function defineCases({ people, api, project, visit, suffix, target, env }) {
    return [[STAGES, async (page) => {
        const title = '阶段顺序走查_' + suffix;
        const pid = await project(title);
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const stage = (key) => plan.nodes.find((node) => node.template_key === key);
        const initiation = stage('p_initiation');
        const scope = stage('p_overall');
        const dev = stage('b_dev');
        const closing = stage('p_closing');
        for (const node of [initiation, scope]) {
            await api(people.pm, 'POST', '/nodes/' + node.id + '/start', {});
            await api(people.pm, 'POST', '/nodes/' + node.id + '/close', {});
        }
        const expected = [initiation, scope, ...plan.nodes.filter((node) => node.batch_id !== null), closing];
        await visit(page, '#scope=mine');
        const card = page.locator('article.sbui-project-card').filter({ hasText: title });
        await card.waitFor();
        assert.deepStrictEqual(await card.locator('[aria-label="阶段进度"] > span').evaluateAll((items) => items.map((item) => item.title)),
            expected.map((node, index) => node.name + (index < 2 ? ' · 已完成' : ' · 未开始')));
        const current = card.getByRole('link', { name: dev.name, exact: true });
        await current.click();

        const rail = page.getByRole('navigation', { name: '项目导航' });
        await rail.waitFor();
        const stageLinks = rail.locator('a[href*="&node="]');
        await target('step7-stage-rail-order', async () => {
            assert.deepStrictEqual(await stageLinks.evaluateAll((items) => items.map((item) => Number(new URLSearchParams(item.hash.slice(1)).get('node')))), expected.map((node) => node.id));
        });
        await page.getByRole('button', { name: '开始阶段', exact: true }).waitFor();
        assert.equal(await stageLinks.first().locator('.sbui-rail-dot').getAttribute('title'), '已完成');
        await stageLinks.first().click();
        await target('step7-stage-completed-label', () => page.getByRole('heading', { name: initiation.name + ' · 已完成', exact: true }).waitFor());
        await page.getByRole('button', { name: '重开阶段', exact: true }).click();
        const dialog = page.locator('#sbuiDialog');
        await dialog.locator('[name="reason"]').fill('本次亲验需复核阶段结束');
        await dialog.getByRole('button', { name: '重开阶段', exact: true }).click();
        await page.getByRole('button', { name: '完成阶段', exact: true }).click();
        await dialog.getByRole('heading', { name: '完成阶段 · ' + initiation.name, exact: true }).waitFor();
        await dialog.locator('[name="checked"]').check();
        await dialog.getByRole('button', { name: '确认完成', exact: true }).click();
        await page.getByRole('heading', { name: initiation.name + ' · 已完成', exact: true }).waitFor();
    }], [CLOSEOUT_WORDING, async (page) => {
        const pid = await project('收尾界面走查_' + suffix);
        const projectPath = '/projects/' + pid;
        const plan = await api(people.pm, 'GET', projectPath + '/plan');
        const closing = plan.nodes.find((node) => node.template_key === 'p_closing');
        const initiation = plan.nodes.find((node) => node.template_key === 'p_initiation');
        await api(people.pm, 'POST', '/nodes/' + closing.id + '/start', {});
        const closingAddress = '#project=' + pid + '&tab=plan&node=' + closing.id;
        const pkg = (await api(people.pm, 'POST', projectPath + '/packages', { type: 'initiation' }, 201)).package;
        const { version } = await api(people.pm, 'POST', '/packages/' + pkg.id + '/versions', {}, 201);
        const versionAddress = '#project=' + pid + '&tab=packages&version=' + version.id;

        await visit(page, versionAddress);
        const drawer = page.getByRole('dialog', { name: '确认内容', exact: true });
        const shade = page.getByRole('button', { name: '关闭抽屉遮罩', exact: true });
        await drawer.waitFor();
        await target('step7-drawer-shade-no-visible-text', async () => {
            await shade.waitFor();
            assert.strictEqual(await shade.textContent(), '');
        });
        await shade.click({ position: { x: 16, y: 16 } });
        await drawer.waitFor({ state: 'hidden' });
        assert.strictEqual(new URL(page.url()).hash, '#project=' + pid + '&tab=packages');

        await visit(page, versionAddress);
        const back = drawer.getByRole('link', { name: '返回立项阶段', exact: true });
        await target('step7-initiation-back-link', () => back.waitFor());
        await back.click();
        await page.getByRole('heading', { name: initiation.name + ' · 未开始', exact: true }).waitFor();

        await visit(page, closingAddress);
        const blockers = page.locator('.sbui-checklist').filter({ hasText: '不能结项' });
        const stageLink = blockers.getByRole('link', { name: '查看阶段：' + closing.name, exact: true }).first();
        await target('step7-closing-stage-link', async () => {
            await stageLink.waitFor();
            assert.strictEqual(await stageLink.textContent(), '查看阶段');
            assert.strictEqual(await stageLink.getAttribute('href'), closingAddress);
        });

        await page.getByRole('link', { name: '全部记录', exact: true }).click();
        await page.getByRole('link', { name: '上线与交接', exact: true }).click();
        await target('step7-handover-title', () => page.getByRole('heading', { name: '上线与交接', exact: true }).waitFor());
    }], [WORK_BACK_LINKS, async (page) => {
        const pid = await project('抽屉返回走查_' + suffix);
        const projectPath = '/projects/' + pid;
        const { nodes } = await api(people.pm, 'GET', projectPath + '/plan');
        const node = nodes.find((entry) => entry.template_key === 'p_initiation');
        const { opinion } = await api(people.pm, 'POST', projectPath + '/opinions', {
            title: '返回走查意见', body: '用于核对意见返回地址。',
        }, 201);
        const { task } = await api(people.pm, 'POST', '/nodes/' + node.id + '/tasks', {
            title: '返回走查任务', assignee_user_id: people.pm.id,
        }, 201);

        async function checkReturn(hash, entryName, drawerName, returnName, pageHeading, failure) {
            await visit(page, hash);
            const expected = env.baseUrl + '/Sys_Build.html' + hash;
            const drawer = page.getByRole('dialog', { name: drawerName, exact: true });
            const entry = page.getByRole('link', { name: entryName, exact: true });
            await entry.click();
            await drawer.getByRole('link', { name: returnName, exact: true }).waitFor();
            await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await drawer.waitFor({ state: 'hidden' });
            assert.strictEqual(page.url(), expected, '关闭抽屉应返回原页');

            await entry.click();
            const back = drawer.getByRole('link', { name: returnName, exact: true });
            await back.waitFor();
            const opened = page.url();
            await back.click();
            await page.waitForURL((url) => url.href !== opened);
            await target(failure, async () => {
                assert.strictEqual(page.url(), expected, '返回地址应与关闭抽屉一致');
                await drawer.waitFor({ state: 'hidden' });
                await page.getByRole('heading', { name: pageHeading, exact: true }).waitFor();
            });
        }

        const opinions = '#project=' + pid + '&tab=opinions';
        await checkReturn(opinions + '&opinions=all', opinion.title, '意见', '返回意见', '意见', 'step7-opinion-back-address');
        await checkReturn(opinions, opinion.title, '意见', '返回意见', '意见', 'step7-opinion-back-address');
        await checkReturn('#project=' + pid + '&tab=plan&node=' + node.id, task.title, '任务', '返回阶段',
            node.name + ' · 未开始', 'step7-task-back-address');
    }]];
}

const MUTATIONS = [
    { id: 'step7-rail-restores-old-order', file: 'sysbuild-page.js', from: 'for (const id of plan.display_stage_ids)', to: "for (const id of plan.nodes.filter((node) => node.status !== 'cancelled').map((node) => node.id))", expect: STAGES, expectFailure: '[step7-stage-rail-order]' },
    { id: 'step7-stage-restores-closed-label', file: 'sysbuild-plan.js', from: "closed: '已完成'", to: "closed: '已收口'", expect: STAGES, expectFailure: '[step7-stage-completed-label]' },
    { id: 'step7-drawer-restores-visible-shade-label', file: 'sysbuild-ui.js', from: "const shade = button('', close);", to: "const shade = button('关闭抽屉遮罩', close);", expect: CLOSEOUT_WORDING, expectFailure: '[step7-drawer-shade-no-visible-text]' },
    { id: 'step7-initiation-restores-node-back-link', file: 'sysbuild-packages.js', from: "A.link('返回立项阶段'", to: "A.link('返回立项节点'", expect: CLOSEOUT_WORDING, expectFailure: '[step7-initiation-back-link]' },
    { id: 'step7-closing-restores-node-link', file: 'sysbuild-plan.js', from: "A.link('查看阶段'", to: "A.link('查看节点 #' + id", expect: CLOSEOUT_WORDING, expectFailure: '[step7-closing-stage-link]' },
    { id: 'step7-handover-restores-old-title', file: 'sysbuild-plan.js', from: "A.panel('上线与交接')", to: "A.panel('收口与上线')", expect: CLOSEOUT_WORDING, expectFailure: '[step7-handover-title]' },
    { id: 'step7-opinion-restores-old-back-link', file: 'sysbuild-work.js', from: "A.link('返回意见', back)", to: "A.link('返回意见', href(pid))", expect: WORK_BACK_LINKS, expectFailure: '[step7-opinion-back-address]' },
    { id: 'step7-task-restores-old-back-link', file: 'sysbuild-work.js', from: "A.link('返回阶段', back)", to: "A.link('返回阶段', taskHref(pid, task.node_id))", expect: WORK_BACK_LINKS, expectFailure: '[step7-task-back-address]' },
];

module.exports = { defineCases, MUTATIONS };
