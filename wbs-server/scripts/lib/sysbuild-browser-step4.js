'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const EARLY = '第四步 PM、领导、负责人查看先开工与默认汇报节奏';

function defineCases({ people, pageFor, visit, contains, api, fillDemand, options, out, suffix, target }) {
    return [[EARLY, async (pm) => {
        const dialog = pm.locator('#sbuiDialog');
        const shot = (page, name) => page.screenshot({ path: path.join(out, 'step4-' + name + '.png') });
        await visit(pm, '#new=1');
        await dialog.locator('[name="system_name"]').fill('第四步早开工走查_' + suffix);
        await dialog.locator('[name="build_type"]').selectOption('inhouse');
        await fillDemand(pm, '第四步走查需求部门');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await pm.getByRole('heading', { name: '立项确认', exact: true }).last().waitFor();
        const pid = Number(new URLSearchParams(new URL(pm.url()).hash.slice(1)).get('project'));
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const n = plan.nodes.find((node) => node.template_key === 'b_dev');
        const href = '#project=' + pid + '&tab=plan&node=' + n.id;
        await visit(pm, href);
        assert.strictEqual(n.current_plan, null);
        await contains(pm, '当前没有汇报节奏。');
        await pm.getByRole('button', { name: '开始阶段', exact: true }).click();
        await contains(pm, '范围尚未确认。可补充开工说明及沟通记录。');
        const note = '先按现场已有样例准备联调，范围确认后核对交付项。';
        const file = '早开工沟通记录.txt';
        await dialog.locator('[name="start_note"]').fill(note);
        await dialog.locator('[name="files"]').setInputFiles({ name: file, mimeType: 'text/plain', buffer: Buffer.from(note) });
        await shot(pm, 'PM-开工说明');
        await dialog.getByRole('button', { name: '确认开始', exact: true }).click();
        await target('step4-default-cycle', async () => {
            await pm.getByText(/^默认周期：每两周，首次应交 /).scrollIntoViewIfNeeded();
            assert.strictEqual(await pm.getByRole('link', { name: /周期要求 #undefined/ }).count(), 0);
        });
        await shot(pm, 'PM-默认汇报');
        const current = (await api(people.pm, 'GET', '/projects/' + pid + '/plan')).nodes.find((node) => node.id === n.id);
        assert.strictEqual(current.range_unconfirmed_started, true);
        assert.strictEqual(current.report.cycle_source, 'default');
        const persisted = (await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries.find((entry) => entry.node_id === n.id);
        assert.strictEqual(persisted.body, note);
        for (const [account, who] of [[people.owner, '领导'], [people.delegate, '负责人']]) {
            const role = await pageFor(account, options.mutation);
            try {
                await visit(role.page, href);
                await role.page.getByText(/^默认周期：每两周，首次应交 /).scrollIntoViewIfNeeded();
                assert.strictEqual(await role.page.getByRole('button', { name: '设置草稿计划', exact: true }).count(), 0);
                await shot(role.page, who + '-默认汇报');
                await visit(role.page, '#project=' + pid + '&tab=entries&entry=' + persisted.id);
                await contains(role.page, '范围确认前开工说明');
                await role.page.getByText(note, { exact: true }).last().scrollIntoViewIfNeeded();
                await shot(role.page, who + '-开工记录');
            } finally {
                await role.context.close();
            }
        }
    }]];
}

const MUTATIONS = [
    { id: 'step4-default-cycle', file: 'sysbuild-plan.js', from: "report.default_cycle ? A.hint('默认周期：'", to: "report.default_cycle ? A.hint('手工周期：'", expect: EARLY, expectFailure: '[step4-default-cycle]' },
];

module.exports = { defineCases, MUTATIONS };
