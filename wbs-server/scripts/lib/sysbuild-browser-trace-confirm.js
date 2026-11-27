'use strict';
const assert = require('assert');
const path = require('path');
const BASIS = 'L3 确认页立项依据与冻结版本';
const PROXY = '平台管理员不接管走完立项并代办确认';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function defineCases(T) {
    const { people, api, project, assignParty, visit, env, suffix, out, token, target, declareViaCard, savePackageDraft } = T;
    const basisReason = '立项中的部分决策为口头批准，尚未形成完整书面原件';
    async function upload(pid) {
        const body = new FormData(); body.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), '立项原始依据.png');
        const res = await fetch(env.baseUrl + '/api/sysbuild/projects/' + pid + '/attachments/stage', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(people.pm) }, body });
        const data = await res.json(); assert.strictEqual(res.status, 200, JSON.stringify(data)); return data.attachment.id;
    }
    async function participant(pid, person, side) {
        const party = await assignParty(pid, side, side === 'dev' ? '浏览器开发方' : '浏览器需求方', person, side === 'demand' ? people.delegate : null);
        return { party: party.id, member: party.owner.member_id };
    }
    async function confirmVersion(pid, vid) {
        const detail = await api(people.pm, 'GET', '/projects/' + pid);
        const tasks = (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks;
        for (const task of tasks) {
            const member = detail.members.find((m) => m.id === task.current_revision.required_member_id);
            const person = Object.values(people).find((p) => p.id === member.user_id); assert.ok(person);
            const opened = await api(person, 'GET', '/confirm-tasks/' + task.task_id);
            await api(person, 'POST', '/confirm-tasks/' + task.task_id + '/decide', { revision_id: opened.revision.id, object_version_id: opened.task.object_version_id, decision: 'confirm', checkbox_text: opened.checkbox_texts.confirm });
        }
    }
    async function initiation(page, pid, withMaterials) {
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'p_initiation');
        let selected = null;
        if (withMaterials) {
            const aid = await upload(pid);
            selected = (await api(people.pm, 'POST', '/nodes/' + node.id + '/materials/initiation-basis/versions', { name: '立项依据', body: '提交时选入的第一版立项材料', attachment_ids: [aid] }, 201)).version;
        }
        if (!withMaterials) await declareViaCard(page, pid, basisReason);
        await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
        await page.getByRole('button', { name: '建立确认草稿', exact: true }).click();
        await page.locator('[name="text"]').waitFor();
        const vid = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('version'));
        const text = '由界面保存的立项确认内容';
        await page.locator('[name="text"]').fill(text);
        await savePackageDraft(page, vid, text);
        await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
        await page.getByText('本版已提交，确认人按固定版本与冻结附件作决定。', { exact: true }).waitFor();
        const task = (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks[0].task_id;
        return { plan, node, vid, task, selected };
    }
    return [
        [BASIS, async (page) => {
            const pid = await project('L3立项确认_' + suffix); await participant(pid, people.owner, 'demand');
            const ini = await initiation(page, pid, true);
            await api(people.pm, 'POST', '/nodes/' + ini.node.id + '/materials/initiation-basis/versions', { name: '立项依据', body: '后来追加的材料版本不属于已提交立项包' }, 201);
            await visit(page, '#task=' + ini.task);
            const basis = page.locator('[data-l3-basis]');
            await target('l3-basis-frozen', async () => {
                assert.strictEqual(await basis.count(), 1, '应显示立项依据专节');
                const text = await basis.textContent();
                for (const expected of ['立项依据', '提交时选入的第一版立项材料', '立项原始依据.png']) assert.ok(text.includes(expected), '立项依据缺少 ' + expected);
                assert.ok(!text.includes('后来追加的材料版本'), '不得展示最新材料代替固定版');
            });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-confirm-initiation.png'), fullPage: true });
            await page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
            await page.frameLocator('iframe').locator('#sec-initiation-basis').waitFor();
            const sheet = await page.frameLocator('iframe').locator('#sec-initiation-basis').textContent();
            assert.ok(sheet.includes('提交时选入的第一版立项材料') && !sheet.includes(basisReason));
            const oral = await project('L3独立声明_' + suffix);
            await participant(oral, people.owner, 'demand');
            const oralInitiation = await initiation(page, oral, false);
            await visit(page, '#task=' + oralInitiation.task);
            await target('l3-basis-declaration', async () => {
                assert.ok((await page.locator('[data-l3-basis]').textContent()).includes(basisReason), '声明模式展示冻结原因');
            });
            await page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
            await page.frameLocator('iframe').locator('#sec-initiation-basis').waitFor();
            assert.ok((await page.frameLocator('iframe').locator('#sec-initiation-basis').textContent()).includes(basisReason));
        }],
        // 页面身份是平台管理员（编号 1，不是本项目 PM 也不是成员）：在界面上填立项依据声明、建草稿、发起确认，再代办需求方领导的确认。
        [PROXY, async (page) => {
            const pid = await project('平台管理员代办_' + suffix); await participant(pid, people.owner, 'demand');
            const ini = await initiation(page, pid, false);
            await visit(page, '#task=' + ini.task);
            await target('super-admin-proxy-panel', async () => {
                await page.getByRole('heading', { name: '管理员代办确认', exact: true }).waitFor();
                assert.strictEqual(await page.getByRole('heading', { name: '本人作出决定', exact: true }).count(), 0, '代办时不显示本人决定面板');
                assert.ok((await page.locator('.sbui-confirmation').textContent()).includes('并标为「管理员代办」'), '代办面板写明记录方式');
            });
            await page.locator('[name="decision"]').selectOption('confirm');
            await page.locator('[name="acknowledged"]').check();
            await page.getByRole('button', { name: '提交代办的决定', exact: true }).click();
            await target('super-admin-proxy-recorded', async () => {
                await page.getByText('已确认', { exact: true }).first().waitFor();
                assert.strictEqual(await page.getByRole('cell', { name: '平台管理员代办', exact: true }).count(), 1, '确认记录的方式标平台管理员代办');
                assert.strictEqual(await page.getByRole('cell', { name: '平台本人确认', exact: true }).count(), 0);
                assert.strictEqual(await page.getByRole('cell', { name: people.superAdmin.display_name, exact: true }).count(), 1, '确认人一栏是平台管理员');
            });
            const recorded = await api(people.pm, 'GET', '/confirm-tasks/' + ini.task);
            assert.deepStrictEqual(recorded.confirmations.map((row) => [row.actor_user_id, row.by_admin_proxy]), [[people.superAdmin.id, true]]);
            assert.strictEqual(recorded.object.version.status, 'effective');
        }, 'superAdmin'],
    ];
}
const MUTATIONS = [
    { id: 'l3-confirm-basis-filter', from: 'const materials = (o.materials || []).filter((m) => initiationNodeIds.includes(m.node_id));', to: 'const materials = [];', expect: BASIS, expectFailure: '[l3-basis-frozen]' },
    { id: 'l3-confirm-basis-declaration', from: "if (reason) body.push(A.panel('无书面依据', [prose(reason)]));", to: 'if (false) body.push(A.panel("无书面依据", [prose(reason)]));', expect: BASIS, expectFailure: '[l3-basis-declaration]' },
    { id: 'super-admin-proxy-shown-as-self', from: "if (data.actions.decide === true && data.actions.decide_mode === 'admin') host.appendChild", to: 'if (false) host.appendChild', expect: PROXY, expectFailure: '[super-admin-proxy-panel]' },
    { id: 'super-admin-proxy-method-as-self', from: "cf.by_admin_proxy === true ? '平台管理员代办' : label(methods, cf.method)", to: 'label(methods, cf.method)', expect: PROXY, expectFailure: '[super-admin-proxy-recorded]' },
].map((mutation) => ({ ...mutation, file: 'sysbuild-confirm.js' }));
module.exports = { defineCases, MUTATIONS };
