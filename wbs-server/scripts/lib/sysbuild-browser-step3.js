'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const FOUR_GATES = '第三步 PM、领导、负责人四关口与遮蔽走查';

function defineCases(T) {
    const { people, api, pageFor, visit, contains, options, out, suffix } = T;
    const panel = (page, title) => page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
    const stage = (pid, node) => '#project=' + pid + '&tab=plan&node=' + node.id;
    const confirmation = (page) => page.getByRole('button', { name: '发起本版确认', exact: true });
    const shot = (page, name) => page.screenshot({ path: path.join(out, 'step3-' + name + '.png') });
    async function openProject(page, href) {
        if (new URL(page.url()).hash !== href) return visit(page, href);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#sbuiView[aria-busy="false"]').waitFor();
    }

    async function upload(page, pid, node, card, body, file) {
        await visit(page, stage(pid, node));
        const box = panel(page, card);
        await box.getByRole('button', { name: /^(上传材料|再传一版)$/ }).click();
        const dialog = page.locator('#sbuiDialog');
        await dialog.locator('[name="body"]').fill(body);
        await dialog.locator('[name="files"]').setInputFiles({ name: file, mimeType: 'text/plain', buffer: Buffer.from(body) });
        await dialog.getByRole('button', { name: '保存候选材料版本', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await box.getByText('已完成', { exact: true }).waitFor();
        const data = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
        return data.materials.find((m) => m.name === card && m.node_id === node.id).versions.at(-1);
    }

    async function submit(page, pid, node, title, text, materials) {
        await visit(page, stage(pid, node));
        await panel(page, title).getByRole('button', { name: '建立确认草稿', exact: true }).click();
        await page.locator('[name="text"]').fill(text);
        for (const material of materials) await page.locator('[name="material_version_ids[]"][value="' + material.id + '"]').check();
        await page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
        await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
        const vid = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('version'));
        const saved = await api(people.pm, 'GET', '/package-versions/' + vid);
        assert.strictEqual(saved.snapshot_json.text, text);
        assert.deepStrictEqual(saved.snapshot_json.material_version_ids || [], materials.map((m) => m.id));
        assert.strictEqual(saved.actions.submit, true, JSON.stringify(saved.submit_block));
        await confirmation(page).waitFor();
        await confirmation(page).click();
        await contains(page, '本版已提交，确认人按固定版本与冻结附件作决定。');
        assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).version.status, 'pending');
        await shot(page, title + '-PM');
        return vid;
    }

    async function decide(page, pid, vid, text, who) {
        await openProject(page, '#project=' + pid);
        await page.getByRole('link', { name: '查看本项目待我确认', exact: true }).click();
        const task = page.getByRole('link', { name: '打开确认', exact: true });
        await task.click();
        await contains(page, text);
        await page.getByLabel(/^本人的决定/).selectOption('confirm');
        await page.locator('[name="acknowledged"]').check();
        await shot(page, who);
        await page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
        await contains(page, '当前没有可提交的本人决定');
        assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).version.status, 'effective');
    }

    async function notice(pm, lead, pid, title, count) {
        await visit(pm, '#project=' + pid + '&tab=notifications');
        const keyed = pm.getByRole('row').filter({ has: pm.getByText('确认发起知悉', { exact: true }) })
            .filter({ has: pm.getByText(people.owner.display_name, { exact: true }) });
        assert.strictEqual(await keyed.count(), count, title + '：领导知悉意图按次增加');
        const href = await keyed.first().getByRole('link', { name: '打开项目', exact: true }).getAttribute('href');
        await openProject(lead, href);
        assert.strictEqual(await lead.getByRole('link', { name: '查看本项目待我确认', exact: true }).count(), 0, title + '：领导只有知悉');
        await shot(lead, title + '-领导知悉');
    }

    async function demonstrateMaskedCards(pm, pid, node, vid, material, lead) {
        await visit(lead, stage(pid, node));
        await panel(lead, '验收记录').getByText('已完成', { exact: true }).waitFor();
        await shot(lead, '验收材料遮蔽前');

        const att = material.attachments[0].attachment_id;
        assert.ok(att);
        await visit(pm, stage(pid, node));
        await panel(pm, '验收记录').getByRole('link', { name: 'v' + material.version_no, exact: true }).click();
        await pm.getByRole('button', { name: '查看附件记录', exact: true }).click();
        const dialog = pm.locator('#sbuiDialog');
        await dialog.getByRole('button', { name: '受控遮蔽', exact: true }).click();
        await dialog.locator('[name="reason"]').fill('第三步验收演示原附件受控遮蔽');
        const [masked] = await Promise.all([
            pm.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/attachments/' + att + '/mask')),
            dialog.getByRole('button', { name: '确认受控遮蔽', exact: true }).click(),
        ]);
        assert.strictEqual(masked.status(), 200);
        await dialog.waitFor({ state: 'hidden' });
        await pm.locator('#sbuiView[aria-busy="false"]').waitFor();
        await visit(pm, stage(pid, node));
        await panel(pm, '验收记录').getByText('待补材料', { exact: true }).waitFor();
        await panel(pm, '验收确认').getByText('已生效', { exact: true }).waitFor();
        await shot(pm, '验收附件遮蔽后');
        const frozen = await api(people.pm, 'GET', '/package-versions/' + vid);
        assert.deepStrictEqual([frozen.version.status, frozen.snapshot_json.material_version_ids], ['effective', [material.id]]);

        const replacement = await upload(pm, pid, node, '验收记录', '补传可用验收记录', '替换附件.txt');
        assert.notStrictEqual(replacement.id, material.id);
        await panel(pm, '验收确认').getByText('已生效', { exact: true }).waitFor();
        assert.deepStrictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).snapshot_json.material_version_ids, [material.id]);
        await shot(pm, '验收补传后');
    }

    async function assertReissueInDrawer(page, reader, pid, node, name, vid) {
        await visit(page, stage(pid, node));
        const box = panel(page, name);
        await T.target('step6-reissue-acceptance-and-closing', async () => {
            await box.getByText('已生效', { exact: true }).waitFor();
            assert.strictEqual(await box.getByRole('button', { name: '重新发起确认', exact: true }).count(), 0);
            const drawer = await T.openStageCard(page, name);
            await drawer.getByRole('button', { name: '重新发起确认', exact: true }).waitFor();
            await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await drawer.waitFor({ state: 'hidden' });
        });
        await visit(reader, stage(pid, node));
        const readOnlyDrawer = await T.openStageCard(reader, name);
        await readOnlyDrawer.getByText('已生效', { exact: true }).waitFor();
        assert.strictEqual(await readOnlyDrawer.getByRole('button', { name: '重新发起确认', exact: true }).count(), 0);
        const data = await api(people.pm, 'GET', '/package-versions/' + vid);
        await api(people.delegate, 'POST', '/packages/' + data.package.id + '/versions', {}, 403);
        const submit = '/package-versions/' + vid + '/submit';
        assert.strictEqual((await api(people.delegate, 'POST', submit, {}, 403)).code, 'SYSBUILD_FORBIDDEN');
        assert.strictEqual((await api(people.pm, 'POST', submit, {}, 409)).code, 'SYSBUILD_STATE');
    }

    return [[FOUR_GATES, async (pm) => {
        await visit(pm, '#new=1');
        const dialog = pm.locator('#sbuiDialog');
        await dialog.locator('[name="system_name"]').fill('第三步四关口_' + suffix);
        await dialog.locator('[name="build_type"]').selectOption('inhouse');
        await T.fillDemand(pm, '四关口演示需求部门');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await panel(pm, '立项确认').waitFor();
        const pid = Number(new URLSearchParams(new URL(pm.url()).hash.slice(1)).get('project'));
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const project = await api(people.pm, 'GET', '/projects/' + pid);
        const date = project.project.created_at.slice(0, 10);
        const nodes = Object.fromEntries(plan.nodes.map((n) => [n.template_key, n]));
        const leader = await pageFor(people.owner, options.mutation);
        const owner = await pageFor(people.delegate, options.mutation);
        try {
            await T.declareViaCard(pm, pid, '第三步浏览器走查的立项来自现场会议，暂无书面依据');
            const initiationText = '立项时确认的项目目标与交付范围';
            const initiation = await submit(pm, pid, nodes.p_initiation, '立项确认', initiationText, []);
            await visit(owner.page, '#project=' + pid);
            assert.strictEqual(await owner.page.getByRole('link', { name: '查看本项目待我确认', exact: true }).count(), 0);
            await decide(leader.page, pid, initiation, initiationText, '立项-领导');
            console.log('    四关口：PM 发起立项，领导本人确认，负责人无立项待办');

            for (const node of [nodes.b_dev, nodes.b_golive, nodes.p_closing]) {
                await api(people.pm, 'POST', '/nodes/' + node.id + '/schedule', { kind: 'plan', planned_start: date, planned_end: date }, 201);
            }
            const demand = await upload(pm, pid, nodes.p_overall, '需求文档', '范围确认原需求文档', '需求文档.txt');
            const overallText = '范围确认正文及本次冻结的职责节点';
            const overall = await submit(pm, pid, nodes.p_overall, '范围确认', overallText, [demand]);
            await notice(pm, leader.page, pid, '范围确认', 1);
            await decide(owner.page, pid, overall, overallText, '范围-负责人');
            console.log('    四关口：PM 带需求文档发起范围，领导只有知悉，负责人确认');

            const acceptance = await upload(pm, pid, nodes.b_golive, '验收记录', '验收原始记录和结论', '验收记录.txt');
            const acceptanceText = '验收确认的测试结果与交付记录';
            const accepted = await submit(pm, pid, nodes.b_golive, '验收确认', acceptanceText, [acceptance]);
            await notice(pm, leader.page, pid, '验收确认', 2);
            await decide(owner.page, pid, accepted, acceptanceText, '验收-负责人');
            await assertReissueInDrawer(pm, owner.page, pid, nodes.b_golive, '验收确认', accepted);
            await demonstrateMaskedCards(pm, pid, nodes.b_golive, accepted, acceptance, leader.page);
            console.log('    四关口：验收生效后遮蔽唯一合格附件，材料卡待补、验收仍已生效，补传后材料卡恢复');

            await api(people.pm, 'POST', '/projects/' + pid + '/entries', { node_id: nodes.b_dev.id, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: date } }, 201);
            await api(people.pm, 'POST', '/nodes/' + nodes.b_dev.id + '/start', {});
            const alsoComplete = await api(people.pm, 'POST', '/batches/' + plan.batches[0].id + '/nodes', { name: '上线时一并完成的示例阶段' }, 201);
            await visit(pm, '#project=' + pid + '&tab=handover');
            await pm.getByRole('button', { name: '确认试运行结束并正式上线', exact: true }).click();
            await dialog.locator('[name="checked"]').check();
            await dialog.locator('input[name="complete_node_ids[]"][value="' + alsoComplete.node.id + '"]').check();
            const [live] = await Promise.all([
                pm.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/batches/' + plan.batches[0].id + '/golive')),
                dialog.getByRole('button', { name: '记录正式上线', exact: true }).click(),
            ]);
            assert.strictEqual(live.status(), 200);
            assert.deepStrictEqual((await live.json()).completed_node_ids, [alsoComplete.node.id]);
            await dialog.waitFor({ state: 'hidden' });
            // 上线记录在事件时刻之后才完成。刷新服务端事实，跨过同秒边界再发起结项。
            let liveCardComplete = false;
            for (let attempt = 0; attempt < 25 && !liveCardComplete; attempt++) {
                const data = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
                liveCardComplete = data.cards.some((card) => card.key === 'golive' && card.complete);
                if (!liveCardComplete) await delay(200);
            }
            assert.ok(liveCardComplete, '正式上线记录在规定时点后完成');
            await api(people.pm, 'POST', '/nodes/' + nodes.b_golive.id + '/materials/operations-handover/not-applicable', { reason: '自研演示由现有运维班组继续维护，无需独立交接' }, 201);
            await visit(pm, stage(pid, nodes.p_closing));
            await pm.getByRole('button', { name: '开始阶段', exact: true }).click();
            await pm.getByRole('heading', { name: '结项 · 进行中', exact: true }).waitFor();
            assert.strictEqual(await pm.getByRole('button', { name: '完成阶段', exact: true }).count(), 0);
            const closingText = '结项确认的交接与交付记录';
            const closing = await submit(pm, pid, nodes.p_closing, '结项确认', closingText, []);
            await notice(pm, leader.page, pid, '结项确认', 3);
            await decide(owner.page, pid, closing, closingText, '结项-负责人');
            await assertReissueInDrawer(pm, owner.page, pid, nodes.p_closing, '结项确认', closing);
            await visit(pm, stage(pid, nodes.p_closing));
            await pm.getByRole('button', { name: '完成阶段', exact: true }).click();
            await dialog.locator('[name="checked"]').check();
            await dialog.locator('input[name="complete_node_ids[]"][value="' + nodes.b_dev.id + '"]').check();
            await dialog.getByRole('button', { name: '确认完成', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            const final = await api(people.pm, 'GET', '/projects/' + pid);
            assert.strictEqual(final.project.status, 'closed');
            const finalPlan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            assert.strictEqual(finalPlan.nodes.find((n) => n.id === nodes.b_dev.id).status, 'closed');
            await shot(pm, '项目已结项');
            console.log('    四关口：PM 发起结项，领导只有知悉，负责人确认，PM 完成结项');
        } finally {
            await owner.context.close();
            await leader.context.close();
        }
    }]];
}

module.exports = { defineCases, FOUR_GATES };
