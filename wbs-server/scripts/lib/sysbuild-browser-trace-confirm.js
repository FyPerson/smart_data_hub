'use strict';
const assert = require('assert');
const path = require('path');
const BASIS = 'L3 确认页立项依据与冻结版本';
const ASSESS = 'L3 确认页固定评估与勘误';
const VARIANTS = 'L3 确认页评估旧版豁免及不可读提示';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function defineCases(T) {
    const { people, api, project, invite, visit, env, suffix, out, token, target } = T;
    const basisReason = '立项中的部分决策为口头批准，尚未形成完整书面原件';
    async function upload(pid) {
        const body = new FormData(); body.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), '立项原始依据.png');
        const res = await fetch(env.baseUrl + '/api/sysbuild/projects/' + pid + '/attachments/stage', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(people.pm) }, body });
        const data = await res.json(); assert.strictEqual(res.status, 200, JSON.stringify(data)); return data.attachment.id;
    }
    async function participant(pid, person, side) {
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side, name: side === 'dev' ? '浏览器开发方' : '浏览器需求方' }, 201)).party.id;
        const joined = await invite(pid, person, party);
        await api(person, 'POST', '/my/invitations/' + joined.invitation.id + '/accept', {});
        const appointed = await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: joined.member.id }, 201);
        await api(person, 'POST', '/my/invitations/' + appointed.invitation.id + '/accept', {});
        if (side === 'demand') {
            const delegate = await invite(pid, people.delegate, party);
            await api(people.delegate, 'POST', '/my/invitations/' + delegate.invitation.id + '/accept', {});
            const delegation = (await api(person, 'POST', '/parties/' + party + '/delegations', { member_id: delegate.member.id }, 201)).delegation.id;
            await api(people.delegate, 'POST', '/delegations/' + delegation + '/accept', {});
        }
        return { party, member: joined.member.id };
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
        // 声明前置始终由界面填写与保存，不能用夹具 PATCH 绕过 L3 的编辑链。
        await visit(page, '#project=' + pid + '&tab=setup&step=3');
        await page.getByRole('button', { name: '建立立项草稿', exact: true }).click();
        await page.locator('[name="text"]').waitFor();
        await page.locator('[name="text"]').fill('由界面保存的立项确认内容');
        await page.locator('[name="no_written_basis"]').check();
        await page.locator('[name="no_written_basis_reason"]').fill(basisReason);
        await page.getByRole('button', { name: '保存本版立项内容', exact: true }).click();
        await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).waitFor();
        const packages = await api(people.pm, 'GET', '/projects/' + pid + '/packages');
        const vid = packages.packages.find((p) => p.type === 'initiation').versions[0].id;
        await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
        await page.getByText('本版已发起，等待必需确认人处理。', { exact: true }).waitFor();
        const task = (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks[0].task_id;
        return { plan, node, vid, task, selected };
    }
    async function changeScene(page) {
        const pid = await project('L3评估确认_' + suffix); await participant(pid, people.owner, 'demand');
        const ini = await initiation(page, pid, false); await confirmVersion(pid, ini.vid);
        const plan = ini.plan;
        for (const n of plan.nodes) await api(people.pm, 'POST', '/nodes/' + n.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
        const item = (await api(people.pm, 'POST', '/projects/' + pid + '/items', { content: '部门汇总报表原始需求', proposer_name: '无账号提出人', no_written_evidence: true, no_evidence_reason: '当面讨论形成原始需求，尚无独立书面依据' }, 201)).item;
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'overall' }, 201)).package.id;
        const overall = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        await api(people.pm, 'POST', '/package-versions/' + overall + '/items', { op: 'add', item_version_id: item.versions[0].id, committed_batch_id: plan.batches[0].id }, 201);
        await api(people.pm, 'POST', '/package-versions/' + overall + '/submit', {}); await confirmVersion(pid, overall);
        await participant(pid, people.member, 'dev');
        const ch = await api(people.pm, 'POST', '/projects/' + pid + '/changes', { title: '报表范围追加', body: '业务要求增加部门汇总列并补验收样例', affects: { scope: '增加部门汇总列', schedule: '联调顺延三天', acceptance: '追加三组边界验收样例' }, no_written_evidence: true, no_evidence_reason: '经业务会议确认范围追加，尚未形成独立原件' }, 201);
        const assessment = (await api(people.member, 'POST', '/projects/' + pid + '/entries', { form: { kind: 'dev_assessment', about_change_id: ch.change.id, feasible: 'partial', extra_person_days: 2.5, schedule_impact_days: 3, impact_note: '接口联调和验收节点需要顺延三天', premise: '需要业务提供完整边界样例' }, self_confirm_text: '我已阅读以上全部内容，确认无误' }, 201)).entry;
        await api(people.pm, 'POST', '/package-versions/' + ch.version.id + '/submit', {});
        await api(people.pm, 'POST', '/entries/' + assessment.id + '/actions', { action: 'correct', text: '后续勘误：联调范围按评估原文字段核对' }, 201);
        const later = await api(people.pm, 'POST', '/projects/' + pid + '/changes', { title: '另一份后续草稿', body: '后续草稿不应替换此前提交时的评估', no_written_evidence: true, no_evidence_reason: '后续讨论形成另一项范围调整，尚无书面原件' }, 201);
        await api(people.member, 'POST', '/projects/' + pid + '/entries', { form: { kind: 'dev_assessment', about_change_id: later.change.id, feasible: 'yes', extra_person_days: 99, schedule_impact_days: 0 }, self_confirm_text: '我已阅读以上全部内容，确认无误' }, 201);
        const task = (await api(people.pm, 'GET', '/package-versions/' + ch.version.id + '/confirm-tasks')).tasks[0].task_id;
        return { pid, vid: ch.version.id, task, assessment };
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
            await target('l3-basis-declaration', async () => { const text = await basis.textContent(); assert.ok(text.includes('无书面依据')); assert.ok(text.includes(basisReason)); });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-confirm-initiation.png'), fullPage: true });
            await page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
            await page.frameLocator('iframe').locator('#sec-initiation-basis').waitFor();
            const sheet = await page.frameLocator('iframe').locator('#sec-initiation-basis').textContent();
            assert.ok(sheet.includes(basisReason) && sheet.includes('提交时选入的第一版立项材料'));
        }],
        [ASSESS, async (page) => {
            const s = await changeScene(page); await visit(page, '#task=' + s.task);
            const assessment = page.locator('[data-l3-assessment]');
            await target('l3-assessment-fields', async () => {
                assert.strictEqual(await assessment.count(), 1); const text = await assessment.textContent();
                for (const expected of ['部分能做', '2.5 人日', '3 天', '接口联调和验收节点需要顺延三天', '需要业务提供完整边界样例']) assert.ok(text.includes(expected), '评估缺少 ' + expected);
                assert.ok(!text.includes('99 人日'), '后续评估不得替换提交时固定的评估');
            });
            await target('l3-assessment-approval', async () => { const text = await assessment.textContent(); assert.ok(text.includes(people.member.display_name)); assert.ok(text.includes('认可时间')); });
            await target('l3-assessment-correction', async () => { const text = await assessment.textContent(); assert.ok(text.includes('后续勘误：联调范围按评估原文字段核对')); assert.ok(text.includes('原评估字段及原认可记录不变')); });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-confirm-assessment.png'), fullPage: true });
            await page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
            await page.frameLocator('iframe').locator('#sec-change-impact').waitFor();
            const impact = await page.frameLocator('iframe').locator('#sec-change-impact').textContent();
            assert.ok(impact.includes('增加部门汇总列') && impact.includes('联调顺延三天') && impact.includes('追加三组边界验收样例'));
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-confirm-sheet-impact.png'), fullPage: true });
        }],
        [VARIANTS, async (page) => {
            const s = await changeScene(page);
            const original = await api(people.pm, 'GET', '/confirm-tasks/' + s.task);
            const url = '**/api/sysbuild/confirm-tasks/' + s.task;
            // 三种历史/不可读呈现采用读响应替身；不改后端状态、不把替身当业务生成链证明。
            const states = [
                ['legacy', { legacy: true, exempt: null, unreadable: false, message: '提交时没有开发评估记录（旧版）' }, '提交时没有开发评估记录（旧版）'],
                ['exempt', { legacy: false, exempt: 'dev_never_joined', unreadable: false, message: '开发方尚未入场，本次变更未做开发评估' }, '开发方尚未入场，本次变更未做开发评估'],
                ['unreadable', { ...original.object.assessment, unreadable: true, form: null, message: '提交时的开发评估记录无法读取，请核实原始记录' }, '提交时的开发评估记录无法读取，请核实原始记录'],
            ];
            for (const [kind, value, message] of states) {
                await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...original, object: { ...original.object, assessment: value } }) }));
                // 不同同源 query 强制重新加载文档，避免复用前一态，也不触发 about:blank 的存储权限错误。
                await visit(page, '?l3_variant=' + kind + '#task=' + s.task);
                await target('l3-assessment-' + kind, async () => { const text = await page.locator('[data-l3-assessment]').textContent(); assert.ok(text.includes(message)); if (kind === 'unreadable') assert.ok(text.includes('后续勘误：联调范围按评估原文字段核对')); });
                await page.unroute(url);
            }
        }],
    ];
}
const MUTATIONS = [
    { id: 'l3-confirm-basis-filter', from: 'const materials = (o.materials || []).filter((m) => initiationNodeIds.includes(m.node_id));', to: 'const materials = [];', expect: BASIS, expectFailure: '[l3-basis-frozen]' },
    { id: 'l3-confirm-basis-declaration', from: "if (reason) body.push(A.panel('无书面依据', [prose(reason)]));", to: 'if (false) body.push(A.panel("无书面依据", [prose(reason)]));', expect: BASIS, expectFailure: '[l3-basis-declaration]' },
    { id: 'l3-confirm-assessment-fields', from: "['增加工时', f.extra_person_days + ' 人日']", to: "['增加工时', '0 人日']", expect: ASSESS, expectFailure: '[l3-assessment-fields]' },
    { id: 'l3-confirm-assessment-approval', from: "['认可人', a.approved_by_name]", to: "['认可人', '未记录']", expect: ASSESS, expectFailure: '[l3-assessment-approval]' },
    { id: 'l3-confirm-assessment-corrections', from: 'if (a.has_correction) body.push', to: 'if (false) body.push', expect: ASSESS, expectFailure: '[l3-assessment-correction]' },
    { id: 'l3-confirm-assessment-legacy', from: "if (a.legacy) body.push(A.hint('提交时没有开发评估记录（旧版）'));", to: "if (a.legacy) body.push(A.hint('无评估'));", expect: VARIANTS, expectFailure: '[l3-assessment-legacy]' },
    { id: 'l3-confirm-assessment-exempt', from: "else if (a.exempt) body.push(A.hint('开发方尚未入场，本次变更未做开发评估'));", to: "else if (a.exempt) body.push(A.hint('无评估'));", expect: VARIANTS, expectFailure: '[l3-assessment-exempt]' },
    { id: 'l3-confirm-assessment-unreadable', from: "else if (a.unreadable) body.push(A.hint('提交时的开发评估记录无法读取，请核实原始记录'));", to: "else if (a.unreadable) body.push(A.hint('无评估'));", expect: VARIANTS, expectFailure: '[l3-assessment-unreadable]' },
].map((mutation) => ({ ...mutation, file: 'sysbuild-confirm.js' }));
module.exports = { defineCases, MUTATIONS };
