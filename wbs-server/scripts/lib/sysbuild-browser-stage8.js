'use strict';
const assert = require('assert');
const path = require('path');
const FLOW = 'C8 需求材料与内容包完整链';
const NOTICE = 'C8 旧通知与过期表单不冒认新版';
const ENTRY = 'C8 显式来源补充登记与办理裁定';
const READONLY = 'C8 只读维护限制与本人确认例外';
const PASTE = 'C8 粘贴截图预览与弹窗生命周期';
const PLAN = 'C8 改期收口交接答复与上线撤销';
const HISTORY = 'C8 历史事实原日期与通知补发边界';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function defineCases(T) {
    const { people, api, project, invite, pageFor, visit, contains, env, sql, suffix, options, out, token, target } = T;
    const pngFile = () => ({ name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    async function upload(pid) {
        const body = new FormData(); body.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'original.png');
        const res = await fetch(env.baseUrl + '/api/sysbuild/projects/' + pid + '/attachments/stage', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(people.pm) }, body });
        const data = await res.json(); assert.strictEqual(res.status, 200, JSON.stringify(data)); return data.attachment.id;
    }
    async function noAccountOwner(pid) {
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '线下负责人需求方' }, 201)).party.id;
        const member = (await api(people.pm, 'POST', '/projects/' + pid + '/members', { party_id: party, person_name: '线下负责人' }, 201)).member.id;
        const appointment = (await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: member }, 201)).appointment.id;
        const date = (await api(people.pm, 'GET', '/projects/' + pid)).appointments.find((a) => a.id === appointment).created_at.slice(0, 10);
        await api(people.pm, 'POST', '/appointments/' + appointment + '/proxy-accept', { external_date: date, actual_confirmer: '线下负责人', identity_basis: '部门负责人任职签字原件中的明确身份依据', attachment_ids: [await upload(pid)] });
        return { party, member, date };
    }
    async function paste(page, selector, withText, mime) {
        return page.evaluate(({ selector, withText, mime, encoded }) => {
            const target = document.querySelector(selector); assertTarget(target);
            function assertTarget(node) { if (!node) throw new Error('paste target missing: ' + selector); }
            target.focus();
            const bytes = Uint8Array.from(atob(encoded), (s) => s.charCodeAt(0));
            const dt = new DataTransfer(); dt.items.add(new File([bytes], 'clipboard-image', { type: mime || 'image/png' }));
            if (withText) dt.items.add('剪贴板文本仍由原输入框接收', 'text/plain');
            const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            target.dispatchEvent(event); return event.defaultPrevented;
        }, { selector, withText, mime, encoded: PNG });
    }
    async function demand(pid, owner, delegate) {
        const own = owner || people.owner;
        const rep = delegate || people.delegate;
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '浏览器需求部门' }, 201)).party.id;
        const ownerJoin = await invite(pid, own, party);
        const delegateJoin = await invite(pid, rep, party);
        await api(own, 'POST', '/my/invitations/' + ownerJoin.invitation.id + '/accept', {});
        await api(rep, 'POST', '/my/invitations/' + delegateJoin.invitation.id + '/accept', {});
        const appointed = await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: ownerJoin.member.id }, 201);
        await api(own, 'POST', '/my/invitations/' + appointed.invitation.id + '/accept', {});
        const delegation = (await api(own, 'POST', '/parties/' + party + '/delegations', { member_id: delegateJoin.member.id }, 201)).delegation.id;
        await api(rep, 'POST', '/delegations/' + delegation + '/accept', {});
        return { party, ownerMember: ownerJoin.member.id, delegateMember: delegateJoin.member.id };
    }
    async function initiation(pid) {
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        await api(people.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '浏览器核对的立项全文_' + suffix } });
        await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {});
        const tasks = await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks');
        return { pk, vid, task: tasks.tasks[0] };
    }
    async function decide(page, text) {
        await target('decision-gate', async () => assert.strictEqual(await page.getByRole('button', { name: '提交本人的决定', exact: true }).isDisabled(), true, '未选择并勾选声明前不可点提交'));
        await page.getByLabel(/^本人的决定/).selectOption('confirm');
        assert.strictEqual(await page.getByRole('button', { name: '提交本人的决定', exact: true }).isDisabled(), true, '[decision-gate] 选择决定不等于已勾选声明');
        await page.locator('.sbui-confirmation input[name="acknowledged"]').check();
        await page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
        await target('decision-submitted', () => contains(page, text || '当前没有可提交的本人决定'));
    }
    async function confirmVersion(pid, vid) {
        const detail = await api(people.pm, 'GET', '/projects/' + pid);
        const tasks = (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks;
        for (const task of tasks) {
            const member = detail.members.find((m) => m.id === task.current_revision.required_member_id);
            const person = Object.values(people).find((p) => p.id === member.user_id);
            assert.ok(person, 'fixture must have the actual required account');
            const opened = await api(person, 'GET', '/confirm-tasks/' + task.task_id);
            await api(person, 'POST', '/confirm-tasks/' + task.task_id + '/decide', { revision_id: opened.revision.id, object_version_id: opened.task.object_version_id, decision: 'confirm', checkbox_text: opened.checkbox_texts.confirm });
        }
    }
    async function effectivePlan() {
        const pid = await project('排期交接_' + suffix);
        const role = await demand(pid);
        const ini = await initiation(pid); await confirmVersion(pid, ini.vid);
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        for (const n of plan.nodes) await api(people.pm, 'POST', '/nodes/' + n.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
        const item = (await api(people.pm, 'POST', '/projects/' + pid + '/items', { content: '总体规划明确承诺的需求', proposer_name: '无账号提出人', no_written_evidence: true, no_evidence_reason: '线下讨论形成的需求尚未有书面原件' }, 201)).item;
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'overall' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        await api(people.pm, 'POST', '/package-versions/' + vid + '/items', { op: 'add', item_version_id: item.versions[0].id, committed_batch_id: plan.batches[0].id }, 201);
        await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {});
        await confirmVersion(pid, vid);
        return { pid, role, item, batch: plan.batches[0].id };
    }
    const viewed = async (uid, vid) => (await sql(env.dbPath, "SELECT COUNT(*) AS n FROM sysbuild_views WHERE user_id = ? AND object_type = 'package_version' AND object_version_id = ?", [uid, vid]))[0].n;
    return [
        ['授权代录按钮锁定步骤', async (page) => {
            const pid = await project('按钮代录意图_' + suffix);
            const owner = await noAccountOwner(pid);
            const member = (await api(people.pm, 'POST', '/projects/' + pid + '/members', { party_id: owner.party, person_name: '无账号授权代表人' }, 201)).member.id;
            const did = (await api(people.pm, 'POST', '/parties/' + owner.party + '/delegations', { member_id: member }, 201)).delegation.id;
            const steps = [];
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/delegations/' + did + '/proxy')) steps.push(req.postDataJSON().expected_step); });
            await visit(page, '#project=' + pid + '&tab=members');
            async function record(label, person) {
                await page.getByRole('button', { name: label, exact: true }).click();
                const dialog = page.locator('#sbuiDialog');
                await dialog.getByLabel(/^实际确认日期/).fill(owner.date);
                await dialog.getByLabel(/^实际确认人/).fill(person);
                await dialog.getByLabel(/^当时任职或授权依据/).fill('本次对应授权步骤的原始签字凭据及明确身份依据');
                await dialog.locator('input[type="file"]').setInputFiles(pngFile());
                await dialog.getByRole('button', { name: '提交代录凭据', exact: true }).click();
            }
            await record('代录负责人批准', '线下负责人');
            await target('proxy-grant-intent', () => page.getByRole('button', { name: '代录代表人接受', exact: true }).waitFor());
            assert.deepStrictEqual(steps, ['grant'], '[proxy-grant-intent] 批准按钮必须固定批准步骤');
            assert.strictEqual((await api(people.pm, 'GET', '/projects/' + pid)).delegations.find((d) => d.id === did).status, 'pending_accept', '[proxy-grant-intent] 批准后须停在待代表人接受');
            await record('代录代表人接受', '无账号授权代表人');
            await target('proxy-accept-intent', () => page.locator('#sbuiDialog').waitFor({ state: 'hidden' }));
            assert.deepStrictEqual(steps, ['grant', 'accept'], '[proxy-accept-intent] 接受按钮必须固定接受步骤');
            assert.strictEqual((await api(people.pm, 'GET', '/projects/' + pid)).delegations.find((d) => d.id === did).status, 'active', '[proxy-accept-intent] 本人接受后授权才生效');
        }],
        [FLOW, async (page) => {
            const pid = await project('C8全流程_' + suffix);
            const role = await demand(pid);
            const owner = await pageFor(people.owner, options.mutation);
            const representative = await pageFor(people.delegate, options.mutation);
            try {
                await visit(page, '#project=' + pid + '&tab=items');
                await page.getByRole('button', { name: '登记需求条目', exact: true }).click();
                const dialog = page.locator('#sbuiDialog');
                await dialog.getByLabel(/^本版需求全文/).fill('界面登记的需求原文_' + suffix);
                await dialog.getByLabel(/^提出人记录方式/).selectOption('member');
                await dialog.getByLabel(/^提出人成员/).selectOption(String(role.ownerMember));
                await dialog.getByLabel('确无书面证据', { exact: true }).check();
                await dialog.getByLabel(/^无书面证据原因/).fill('当面讨论确认的需求暂未形成独立书面原件');
                await dialog.getByRole('button', { name: '保存条目', exact: true }).click();
                await page.getByRole('heading', { name: '需求条目与提出人确认', exact: true }).waitFor();
                const items = await api(people.pm, 'GET', '/projects/' + pid + '/items');
                assert.strictEqual(items.items.length, 1);
                const item = items.items[0];
                assert.strictEqual(item.versions[0].content, '界面登记的需求原文_' + suffix, '[item-content] 需求原文必须逐字保存');
                assert.strictEqual(item.versions[0].proposer_status, 'pending');
                await visit(owner.page, '#task=' + item.versions[0].confirm_tasks[0].task_id);
                await decide(owner.page);
                assert.strictEqual((await api(people.pm, 'GET', '/items/' + item.id)).item.versions[0].proposer_status, 'confirmed');
                const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
                const node = plan.nodes.find((n) => n.template_key === 'p_overall');
                await page.getByRole('link', { name: '材料版本', exact: true }).click();
                await page.getByRole('button', { name: '建立候选材料', exact: true }).click();
                await dialog.getByLabel(/^所属节点/).selectOption(String(node.id));
                await dialog.getByLabel(/^材料名称/).fill('界面材料版本');
                const literal = '负责人看到的材料全文 <img src=x onerror="window.c8TextExecuted=1">';
                await dialog.getByLabel(/^本版材料正文/).fill(literal);
                await dialog.getByRole('button', { name: '保存候选材料版本', exact: true }).click();
                await page.getByRole('heading', { name: '材料版本与采纳依据', exact: true }).waitFor();
                assert.strictEqual(await page.locator('#sysbuildApp img').count(), 0);
                const materials = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
                const material = materials.materials[0].versions[0];
                assert.strictEqual(material.body, literal);
                const ini = await initiation(pid);
                await visit(owner.page, '?project=' + pid + '&rev=' + ini.task.current_revision.id);
                await decide(owner.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + ini.vid)).version.status, 'effective');
                for (const n of plan.nodes) await api(people.pm, 'POST', '/nodes/' + n.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
                await page.getByRole('link', { name: '内容包与变更', exact: true }).click();
                await page.getByRole('button', { name: '建立总体范围与批次规划草稿', exact: true }).click();
                await page.getByLabel(/^本版确认正文/).fill('界面保存的完整总体规划_' + suffix);
                await page.getByRole('group', { name: /^本版明确引用的材料版本/ }).getByRole('checkbox', { name: '界面材料版本 · v1', exact: true }).check();
                await page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
                await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
                await page.getByRole('button', { name: '加入需求条目', exact: true }).click();
                await dialog.getByLabel(/^明确选择条目版本/).selectOption(String(item.versions[0].id));
                await dialog.getByRole('button', { name: '加入本版集合', exact: true }).click();
                await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
                await page.getByRole('heading', { name: '总体范围与批次规划 v1 · 待确认', exact: true }).waitFor();
                const versionId = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('version'));
                const saved = await api(people.pm, 'GET', '/package-versions/' + versionId);
                assert.strictEqual(saved.snapshot_json.text, '界面保存的完整总体规划_' + suffix);
                assert.deepStrictEqual(saved.snapshot_json.material_version_ids, [material.id], '[material-refs] 保存必须保留明确勾选的材料版本');
                assert.strictEqual(saved.items[0].item_version_id, item.versions[0].id);
                const tasks = await api(people.pm, 'GET', '/package-versions/' + versionId + '/confirm-tasks');
                assert.strictEqual(tasks.tasks.length, 2);
                await visit(owner.page, '#todo=confirm&project_filter=' + pid);
                assert.strictEqual(await viewed(people.owner.id, versionId), 0, '列表不能预读确认任务');
                await owner.page.getByRole('link', { name: '打开确认', exact: true }).click();
                await owner.page.getByRole('heading', { name: '总体范围与批次规划 · v1', exact: true }).waitFor();
                assert.strictEqual(await viewed(people.owner.id, versionId), 1);
                await contains(owner.page, literal);
                let authenticated = false;
                let injectedSheet = '';
                await owner.page.route('**/api/sysbuild/package-versions/' + versionId + '/confirmation-sheet', async (route) => {
                    authenticated = !!route.request().headers().authorization;
                    const response = await route.fetch();
                    const html = (await response.text()).replace('</body>', '<script>parent.window.c8SheetExecuted=1</script></body>');
                    injectedSheet = html;
                    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
                });
                await owner.page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
                await owner.page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((n) => n.textContent === '加载确认单预览' && !n.disabled));
                const frame = owner.page.locator('iframe.sbui-sheet');
                await frame.waitFor();
                await owner.page.getByRole('button', { name: '打印确认单 / 保存 PDF', exact: true }).waitFor({ state: 'visible' });
                await owner.page.waitForFunction(() => {
                    const node = document.querySelector('iframe.sbui-sheet');
                    return node && node.contentDocument && node.contentDocument.readyState === 'complete' && node.contentDocument.body.textContent.includes('需求确认单');
                });
                assert.ok(injectedSheet.includes('<script>parent.window.c8SheetExecuted=1</script>'), '确认单脚本探针必须已注入');
                const probe = await owner.page.evaluate(async (html) => {
                    const productExecuted = window.c8SheetExecuted;
                    delete window.c8SheetExecuted;
                    const control = document.createElement('iframe');
                    control.hidden = true;
                    const loaded = new Promise((resolve) => { control.onload = resolve; });
                    control.srcdoc = html;
                    document.body.appendChild(control);
                    try { await loaded; return { productExecuted, controlExecuted: window.c8SheetExecuted }; }
                    finally { control.remove(); delete window.c8SheetExecuted; }
                }, injectedSheet);
                assert.strictEqual(probe.controlExecuted, 1, '确认单脚本探针无沙箱正对照必须执行');
                assert.strictEqual(probe.productExecuted, undefined, 'sandbox不能执行响应中的脚本');
                assert.strictEqual(await frame.getAttribute('sandbox'), 'allow-same-origin allow-modals', '确认单sandbox属性必须严格固定');
                assert.strictEqual(authenticated, true);
                assert.strictEqual(await viewed(people.owner.id, versionId), 1, '导出不增加浏览记录');
                await owner.page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
                await owner.page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((n) => n.textContent === '加载确认单预览' && !n.disabled));
                await target('sheet-repeat', () => owner.page.waitForFunction(() => document.querySelectorAll('iframe.sbui-sheet').length === 1 && !document.querySelector('iframe.sbui-sheet').parentElement.querySelector('button').disabled));
                assert.strictEqual(await frame.count(), 1, '[sheet-repeat] 重复加载只保留当前确认单');
                assert.strictEqual(await viewed(people.owner.id, versionId), 1, '重复导出不增加浏览记录');
                await owner.page.screenshot({ path: path.join(out, 'c8-confirmation.png'), fullPage: true });
                await frame.evaluate((node) => { window.c8PrintEvents = 0; node.contentWindow.addEventListener('beforeprint', () => { window.c8PrintEvents += 1; }); });
                await owner.page.getByRole('button', { name: '打印确认单 / 保存 PDF', exact: true }).click();
                assert.ok(await owner.page.evaluate(() => window.c8PrintEvents > 0), '打印应作用于沙盒中的确认单文档');
                await decide(owner.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + versionId)).version.status, 'pending', '一方确认不自动替另一方同意');
                const repTask = tasks.tasks.find((t) => t.current_revision.required_member_id === role.delegateMember);
                await visit(representative.page, '#task=' + repTask.task_id + '&revision_id=' + repTask.current_revision.id);
                await decide(representative.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + versionId)).version.status, 'effective');
                await owner.page.unroute('**/api/sysbuild/package-versions/' + versionId + '/confirmation-sheet');
            } finally { await owner.context.close(); await representative.context.close(); }
        }],
        [ENTRY, async (page) => {
            const pid = await project('登记裁定_' + suffix);
            const role = await demand(pid);
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const node = (await api(people.pm, 'POST', '/batches/' + plan.batches[0].id + '/nodes', { name: '已经收口的登记节点' }, 201)).node;
            await api(people.pm, 'POST', '/nodes/' + node.id + '/start', {});
            await api(people.pm, 'POST', '/nodes/' + node.id + '/close', {});
            await visit(page, '#project=' + pid + '&tab=entries');
            await page.getByRole('button', { name: '追加登记', exact: true }).click();
            const dialog = page.locator('#sbuiDialog');
            await dialog.locator('[name="node_id"]').selectOption(String(node.id));
            await dialog.getByLabel(/^标题/).fill('收口后真实意见');
            await dialog.getByLabel(/^事实、意见或处理说明/).fill('收口后登记的原文必须保留并明确来源');
            await dialog.getByLabel('确无书面证据', { exact: true }).check();
            await dialog.getByLabel(/^无书面证据的原因/).fill('曾在线下讨论但目前还未整理出书面凭据');
            await dialog.getByRole('button', { name: '保存登记', exact: true }).click();
            assert.ok(await dialog.locator('[name="source_party"]').evaluate((n) => n.validationMessage), '来源缺失应由表单就地提示');
            assert.strictEqual((await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries.length, 0, '未选择来源不能提交');
            await dialog.locator('[name="source_party"]').selectOption(String(role.party));
            await dialog.locator('[name="type"]').selectOption('material');
            await dialog.getByRole('button', { name: '保存登记', exact: true }).click();
            assert.ok(await dialog.locator('input[type="file"]').evaluate((n) => n.validationMessage), '补交材料缺附件应由表单就地提示');
            assert.strictEqual((await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries.length, 0, '补交材料必须有附件');
            await dialog.locator('[name="type"]').selectOption('feedback');
            await dialog.getByLabel('确无书面证据', { exact: true }).uncheck();
            assert.strictEqual(await dialog.locator('[name="no_evidence_reason"]').isDisabled(), true);
            await dialog.locator('input[type="file"]').setInputFiles(pngFile());
            await dialog.getByRole('button', { name: '保存登记', exact: true }).click();
            await target('entry-saved', () => page.getByRole('heading', { name: '收口后真实意见', exact: true }).waitFor());
            const e = (await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries[0];
            assert.strictEqual(e.source_party_id, role.party); assert.strictEqual(e.period, 'supplement');
            assert.strictEqual(e.no_written_evidence, false, '[entry-saved] 有书面证据不得保留无证据声明'); assert.strictEqual(e.no_evidence_reason, null, '[entry-saved] 有书面证据不得保留旧原因');
            await page.getByRole('button', { name: '追加更正', exact: true }).click();
            await dialog.locator('[name="text"]').fill('只追加更正，不覆盖收口后的原始意见');
            await dialog.getByRole('button', { name: '追加更正', exact: true }).click();
            await contains(page, '只追加更正，不覆盖收口后的原始意见');
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + e.id)).entry.body, '收口后登记的原文必须保留并明确来源');
            const item = (await api(people.pm, 'POST', '/projects/' + pid + '/items', { content: '待细化的规划需求', proposer_name: '无账号提出人', no_written_evidence: true, no_evidence_reason: '线下讨论形成的需求尚未有书面原件' }, 201)).item;
            await page.getByRole('button', { name: '判定归属', exact: true }).click();
            await dialog.locator('[name="text"]').fill('核对待细化需求后，将本条意见归入项目');
            await dialog.locator('[name="basis_category"]').selectOption('planned_detail');
            await dialog.getByRole('checkbox', { name: new RegExp('^' + item.code + ' ·') }).check();
            await dialog.getByRole('button', { name: '判定归属', exact: true }).click();
            await page.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await dialog.locator('[name="conclusion_kind"]').selectOption('not_adopted');
            await dialog.locator('[name="text"]').fill('核对现有范围及原始事实后，本次暂不采纳');
            await dialog.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await contains(page, '待结论确认');
            const objected = await pageFor(people.delegate, options.mutation);
            const owner = await pageFor(people.owner, options.mutation);
            try {
                let saved = (await api(people.pm, 'GET', '/entries/' + e.id)).entry;
                const task = saved.confirm_tasks.find((t) => t.purpose === 'conclusion_confirm');
                await visit(objected.page, '#task=' + task.task_id);
                await objected.page.getByLabel(/^本人的决定/).selectOption('object');
                await objected.page.locator('[name="reason"]').fill('来源方对不采纳结论持有明确异议，请负责人裁定');
                await objected.page.locator('[name="acknowledged"]').check();
                await objected.page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
                await contains(objected.page, '当前没有可提交的本人决定');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.getByRole('button', { name: '交负责人裁定', exact: true }).click();
                await dialog.locator('[name="text"]').fill('请来源方负责人核对原意见及当前不采纳结论');
                await dialog.getByRole('button', { name: '交负责人裁定', exact: true }).click();
                await contains(page, '负责人裁定中');
                saved = (await api(people.pm, 'GET', '/entries/' + e.id)).entry;
                await visit(owner.page, '#task=' + saved.confirm_tasks.find((t) => t.purpose === 'adjudicate').task_id);
                await decide(owner.page);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await contains(page, '裁定通过');
                await target('entry-method-label', () => contains(page, '平台本人确认 · 确认'));
                assert.strictEqual(await page.getByRole('button', { name: '给出办理结论', exact: true }).count(), 0);
                await page.screenshot({ path: path.join(out, 'c8-entry-adjudicated.png'), fullPage: true });
            } finally { await objected.context.close(); await owner.context.close(); }
        }],
        [READONLY, async (page) => {
            const pid = await project('只读本人确认_' + suffix);
            await demand(pid, people.readonly);
            await visit(page, '#project=' + pid + '&tab=entries');
            assert.strictEqual(await page.getByRole('button', { name: '追加登记', exact: true }).count(), 0, '[readonly-entry] 只读不得出现登记按钮');
            await page.getByRole('link', { name: '材料版本', exact: true }).click();
            await page.getByRole('heading', { name: '材料版本与采纳依据', exact: true }).waitFor();
            assert.strictEqual(await page.getByRole('button', { name: '建立候选材料', exact: true }).count(), 0);
            const pending = await initiation(pid);
            await visit(page, '#task=' + pending.task.task_id);
            await decide(page);
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + pending.vid)).version.status, 'effective', '只读身份不妨碍本人作为必需确认人确认');
        }, 'readonly'],
        [PASTE, async (page) => {
            const pid = await project('粘贴与生命周期_' + suffix);
            const owner = await noAccountOwner(pid);
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const att = await upload(pid);
            const material = (await api(people.pm, 'POST', '/nodes/' + plan.nodes[0].id + '/materials/proof/versions', { name: '带原件的材料', body: '供本次确认复核', attachment_ids: [att] }, 201)).version.id;
            const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
            const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
            await api(people.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '线下负责人原始确认', material_version_ids: [material] } });
            await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {});
            const task = (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks[0];
            await visit(page, '#task=' + task.task_id);
            await page.getByText('PM 按原始凭据代录', { exact: true }).click();
            const inline = page.locator('.sbui-confirmation input[type="file"]');
            const frozen = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '本版冻结附件', exact: true }) });
            await frozen.getByRole('button', { name: '查看附件记录', exact: true }).click();
            await page.locator('#sbuiDialog').getByRole('button', { name: '受控遮蔽', exact: true }).click();
            await paste(page, '#sbuiDialog textarea', true);
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 0, '弹窗开启时不能投递给背景附件区');
            await page.locator('#sbuiDialog').getByRole('button', { name: '关闭', exact: true }).click();
            const prevented = await paste(page, '.sbui-confirmation [name="identity_basis"]', true);
            assert.strictEqual(prevented, false, '混合剪贴板须保留文本输入的默认行为');
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 1);
            const fileName = await inline.evaluate((n) => n.files[0].name);
            assert.match(fileName, /^项目截图_.+_1\.png$/);
            await page.getByRole('button', { name: '预览 ' + fileName, exact: true }).click();
            await page.locator('.sbui-lightbox[open] img').waitFor();
            assert.strictEqual(await page.locator('.sbui-lightbox img').evaluate((n) => n.complete && n.naturalWidth > 0), true);
            await page.keyboard.press('Escape');
            await page.locator('.sbui-lightbox').waitFor({ state: 'detached' });
            await paste(page, '.sbui-confirmation [name="identity_basis"]', false, 'image/bmp');
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 1, '不支持格式不能被收入待上传文件');
            await page.locator('[name="decision"]').selectOption('confirm');
            await page.locator('[name="external_date"]').fill(owner.date);
            await page.locator('[name="identity_basis"]').fill('部门线下负责人签字原件中的本次身份依据');
            await page.getByRole('button', { name: '按原始凭据提交代录', exact: true }).click();
            await page.getByRole('heading', { name: '内容包确认', exact: true }).waitFor();
            await contains(page, '已确认');
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).version.status, 'effective');
            const before = await page.evaluate(() => window.c8PasteStats);
            assert.ok(before.unregistered > 0, '代录后旧字段应注销');
            await page.getByRole('link', { name: '帮助', exact: true }).click();
            await page.getByRole('heading', { name: '项目管理帮助', exact: true }).waitFor();
            const stats = await page.evaluate(() => window.c8PasteStats);
            assert.strictEqual(stats.unregistered, stats.registered, '代录后旧字段应注销：离开页面注销全部附件区域');
            assert.strictEqual(stats.reset, stats.registered + stats.unregistered, '挂载与注销均重置序号和点击记忆');
        }],
        [PLAN, async (page) => {
            const s = await effectivePlan();
            const node = (await api(people.pm, 'POST', '/batches/' + s.batch + '/nodes', { name: '生效后新增的交付节点' }, 201)).node;
            const currentNode = async () => (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.find((n) => n.id === node.id);
            assert.strictEqual((await currentNode()).has_baseline, false);
            assert.strictEqual((await currentNode()).plan_write_mode, 'reschedule');
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + node.id);
            await target('plan-reschedule-mode', () => page.getByRole('button', { name: '改期', exact: true }).click());
            const dialog = page.locator('#sbuiDialog');
            await target('plan-reschedule-mode', () => contains(page, '本节点尚无基线，但总体规划已生效，本次仍须按改期附原因与证据，不直接写成基线。'));
            await dialog.locator('[name="planned_start"]').fill('2026-12-01');
            await dialog.locator('[name="planned_end"]').fill('2026-12-05');
            await dialog.locator('[name="reason"]').fill('明确记录新增节点的安排依据及负责人沟通结果');
            await dialog.locator('[name="source_party_id"]').selectOption('self');
            await dialog.getByLabel('确无书面证据', { exact: true }).check();
            await dialog.locator('[name="no_evidence_reason"]').fill('经现场讨论形成的计划调整尚无独立书面原件');
            await dialog.getByRole('button', { name: '追加改期记录', exact: true }).click();
            await contains(page, '2026-12-01 → 2026-12-05');
            assert.strictEqual((await currentNode()).has_baseline, false, '改期不补造确认基线');
            await page.getByRole('button', { name: '开始节点', exact: true }).click();
            await page.getByRole('heading', { name: node.name + ' · 进行中', exact: true }).waitFor();
            const entryBody = { type: 'issue', title: '本节点待处理问题', body: '核对收口必须先办理本条过程问题', node_id: node.id, source_party_id: null, item_ids: [s.item.id], no_written_evidence: true, no_evidence_reason: '现场沟通记录尚未形成独立书面原件' };
            const entry = (await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', entryBody, 201)).entry;
            await page.getByRole('button', { name: '核对收口', exact: true }).click();
            assert.strictEqual(await dialog.getByRole('button', { name: '确认收口', exact: true }).isDisabled(), true);
            await target('close-entry-link', () => dialog.getByRole('link', { name: '办理登记 #' + entry.id, exact: true }).click());
            await page.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await dialog.locator('[name="conclusion_kind"]').selectOption('handled');
            await dialog.locator('[name="text"]').fill('已逐项核实并完成处理，保留本次处理说明');
            await dialog.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await contains(page, '结论已确定（无需另行确认）');
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + node.id);
            await page.getByRole('button', { name: '核对收口', exact: true }).click();
            await dialog.locator('[name="checked"]').check();
            await dialog.getByRole('button', { name: '确认收口', exact: true }).click();
            await page.getByRole('button', { name: '重开节点', exact: true }).click();
            await dialog.locator('[name="reason"]').fill('为核对新增过程问题而重新打开本节点');
            await dialog.getByRole('button', { name: '重开节点', exact: true }).click();
            await page.getByRole('heading', { name: node.name + ' · 进行中', exact: true }).waitFor();
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + entry.id)).entry.period, 'process', '重开不重写原登记时段');
            const risk = (await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { ...entryBody, title: '待接受的上线风险', is_risk: true }, 201)).entry;
            await api(people.pm, 'POST', '/entries/' + risk.id + '/actions', { action: 'conclude', conclusion_kind: 'deferred', text: '已明确记录遗留风险，拟带着问题上线后继续处理', assignee_text: '后续运维负责人' }, 201);
            await visit(page, '#project=' + s.pid + '&tab=handover');
            await page.getByRole('button', { name: '发起交接确认', exact: true }).click();
            await dialog.getByRole('button', { name: '发起确认', exact: true }).click();
            await contains(page, '待确认');
            const handoverItem = async () => (await api(people.pm, 'GET', '/batches/' + s.batch + '/handover')).items.find((i) => i.entry_id === risk.id);
            assert.strictEqual((await handoverItem()).need_confirm, 'accept_issue');
            const rep = await pageFor(people.delegate, options.mutation);
            try {
                let task = (await handoverItem()).confirm.tasks[0];
                await visit(rep.page, '#task=' + task.task_id + '&revision_id=' + task.revision_id);
                await rep.page.getByLabel(/^本人的决定/).selectOption('reject');
                await rep.page.locator('[name="reason"]').fill('风险处理安排还不充分，请PM明确后续响应责任和时限');
                await rep.page.locator('[name="acknowledged"]').check();
                await rep.page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
                await contains(rep.page, '当前没有可提交的本人决定');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.getByRole('button', { name: '答复后重新发起确认', exact: true }).click();
                const reply = 'PM已明确由运维负责人接续处理，并在正式上线后每周跟进反馈';
                await dialog.locator('[name="reply"]').fill(reply);
                await dialog.getByRole('button', { name: '保存答复并发起', exact: true }).click();
                await target('handover-reply-saved', () => dialog.waitFor({ state: 'hidden' }));
                task = (await handoverItem()).confirm.tasks[0];
                await visit(rep.page, '#task=' + task.task_id + '&revision_id=' + task.revision_id);
                await target('handover-reply-visible', () => rep.page.getByRole('heading', { name: 'PM 对上次决定的答复 · 本次请一并核对', exact: true }).waitFor());
                await contains(rep.page, reply);
                await rep.page.getByLabel(/^本人的决定/).selectOption('confirm');
                await rep.page.getByLabel('我已阅读以上全部内容，确认接受该问题带着上线', { exact: true }).check();
                await rep.page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
                await contains(rep.page, '当前没有可提交的本人决定');
                assert.strictEqual((await handoverItem()).cleared, true);
            } finally { await rep.context.close(); }
            const pk = (await api(people.pm, 'POST', '/projects/' + s.pid + '/packages', { type: 'batch_accept', batch_id: s.batch }, 201)).package.id;
            const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
            await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {}); await confirmVersion(s.pid, vid);
            for (const n of (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.filter((n) => n.batch_id === s.batch && !n.is_golive_milestone && n.status !== 'closed')) {
                if (n.status === 'not_started') await api(people.pm, 'POST', '/nodes/' + n.id + '/start', {});
                await api(people.pm, 'POST', '/nodes/' + n.id + '/close', {});
            }
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('button', { name: '确认试运行结束并正式上线', exact: true }).click();
            await dialog.locator('[name="checked"]').check();
            await dialog.getByRole('button', { name: '记录正式上线', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            await page.locator('#sbuiView[aria-busy="false"]').waitFor();
            const events = await sql(env.dbPath, 'SELECT id, kind FROM sysbuild_golive_events WHERE batch_id = ? ORDER BY id', [s.batch]);
            assert.deepStrictEqual(events.map((e) => e.kind), ['golive'], '[golive-event] 上线必须落正确批次事件');
            const admin = await pageFor(people.admin, options.mutation);
            try {
                await visit(admin.page, '#project=' + s.pid + '&tab=handover');
                await admin.page.getByRole('button', { name: '撤销正式上线', exact: true }).click();
                await admin.page.locator('#sbuiDialog [name="reason"]').fill('核对试运行结果后，由管理员记录本次撤销上线');
                await admin.page.getByRole('button', { name: '记录撤销上线', exact: true }).click();
                await admin.page.locator('#sbuiDialog').waitFor({ state: 'hidden' });
                await admin.page.locator('#sbuiView[aria-busy="false"]').waitFor();
                const changed = await api(people.pm, 'GET', '/projects/' + s.pid + '/plan');
                assert.strictEqual(changed.nodes.find((n) => n.is_golive_milestone).status, 'in_progress');
                assert.deepStrictEqual((await sql(env.dbPath, 'SELECT kind FROM sysbuild_golive_events WHERE batch_id = ? ORDER BY id', [s.batch])).map((e) => e.kind), ['golive', 'revoke']);
                await admin.page.screenshot({ path: path.join(out, 'c8-handover-revoked.png'), fullPage: true });
            } finally { await admin.context.close(); }
        }],
        [HISTORY, async (page) => {
            const pid = await project('历史与通知_' + suffix);
            const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '历史需求方' }, 201)).party.id;
            const member = (await api(people.pm, 'POST', '/projects/' + pid + '/members', { party_id: party, person_name: '历史无账号负责人' }, 201)).member.id;
            const appointment = (await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: member }, 201)).appointment.id;
            await visit(page, '#project=' + pid + '&tab=history');
            const dialog = page.locator('#sbuiDialog');
            await page.getByRole('button', { name: '开启历史补录窗口', exact: true }).click();
            await dialog.locator('[name="reason"]').fill('核对旧系统原件后记录本轮历史补录');
            await dialog.locator('input[type="file"]').setInputFiles(pngFile());
            await dialog.getByRole('button', { name: '开启历史补录窗口', exact: true }).click();
            await page.getByRole('heading', { name: '历史补录 · 历史补录中', exact: true }).waitFor();
            async function historyEvidence(date) {
                await dialog.locator('[type="date"]').fill(date);
                await dialog.locator('[name="actual_confirmer"]').fill('历史原件上的负责人');
                await dialog.locator('[name="identity_basis"]').fill('原始任职文件和签字确认页记载的当时身份依据');
                await dialog.locator('input[type="file"]').setInputFiles(pngFile());
            }
            async function importFact(kind, id, date) {
                await page.getByRole('button', { name: '导入已有历史事实', exact: true }).click();
                await dialog.locator('[name="fact_type"]').selectOption(kind);
                await dialog.locator('[name="object_id"]').selectOption(String(id));
                await historyEvidence(date);
                await dialog.getByRole('button', { name: '按原始凭据恢复历史事实', exact: true }).click();
                await dialog.waitFor({ state: 'hidden' });
                await page.locator('#sbuiView[aria-busy="false"]').waitFor();
            }
            await importFact('appointment', appointment, '2020-01-01');
            const detail = await api(people.pm, 'GET', '/projects/' + pid);
            assert.strictEqual(detail.parties[0].owner.member_id, member);
            assert.strictEqual(detail.appointments.find((a) => a.id === appointment).effective_at.slice(0, 10), '2020-01-01', '[history-original-date] 历史事实必须保留原日期');
            async function draft(type) {
                const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type }, 201)).package.id;
                return (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
            }
            const ini = await draft('initiation');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await importFact('package_effective', ini, '2020-01-02');
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            for (const node of plan.nodes) await api(people.pm, 'POST', '/nodes/' + node.id + '/schedule', { kind: 'plan', planned_start: '2020-01-10', planned_end: '2020-01-31' }, 201);
            const item = (await api(people.pm, 'POST', '/projects/' + pid + '/items', { content: '旧规划原件中的需求', proposer_name: '历史提出人', no_written_evidence: true, no_evidence_reason: '提出人当时口头提出未留单独书面记录' }, 201)).item;
            const overall = await draft('overall');
            await api(people.pm, 'POST', '/package-versions/' + overall + '/items', { op: 'add', item_version_id: item.versions[0].id, committed_batch_id: plan.batches[0].id }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await importFact('package_effective', overall, '2020-01-03');
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + overall)).version.status, 'effective');
            await page.getByRole('button', { name: '补录历史确认', exact: true }).click();
            await dialog.locator('[name="object_type"]').selectOption('package_version');
            await dialog.locator('[name="object_version_id"]').selectOption(String(overall));
            await dialog.locator('[name="decision"]').selectOption('confirm');
            await historyEvidence('2020-01-03');
            await dialog.getByRole('button', { name: '只记录历史确认事实', exact: true }).click();
            await target('history-confirmation-saved', () => dialog.waitFor({ state: 'hidden' }));
            const records = await sql(env.dbPath, "SELECT task_revision_id, view_id, external_date FROM sysbuild_confirmations WHERE object_type = 'package_version' AND object_version_id = ? AND method = 'history'", [overall]);
            assert.deepStrictEqual(records, [{ task_revision_id: null, view_id: null, external_date: '2020-01-03' }], '[history-confirmation-saved] 历史确认不冒充当前任务或浏览');
            const milestone = plan.nodes.find((n) => n.is_golive_milestone);
            await api(people.pm, 'POST', '/nodes/' + milestone.id + '/schedule', { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-15', reason: '核对后明确推迟里程碑安排', source_party_id: null, no_written_evidence: true, no_evidence_reason: '本次线下讨论形成改期安排尚无独立书面记录' }, 201);
            await sql(env.dbPath, 'UPDATE users SET dingtalk_user_id = ? WHERE id = ?', ['browser-stub-recipient-' + suffix, people.member.id]);
            const joined = await invite(pid, people.member, party);
            // The invitation endpoint commits before its asynchronous sender settles. Observe the terminal receipt before injecting a channel failure.
            await page.waitForFunction(async ({ pid, invitationId }) => {
                const response = await fetch('/api/sysbuild/projects/' + pid + '/send-intents', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
                if (!response.ok) throw new Error('Cannot observe private notification receipt: ' + response.status);
                const data = await response.json();
                const item = data.items.find((i) => i.ref_type === 'invitation' && i.ref_id === invitationId);
                return item && item.status !== 'pending';
            }, { pid, invitationId: joined.invitation.id });
            const intent = (await sql(env.dbPath, "SELECT id, attempts FROM sysbuild_send_intents WHERE project_id = ? AND ref_type = 'invitation' AND ref_id = ?", [pid, joined.invitation.id]))[0];
            // A channel failure receipt fixture, not a forged business decision; resend still uses the production stub transport.
            await sql(env.dbPath, "UPDATE sysbuild_send_intents SET status = 'failed', last_error = '浏览器夹具：渠道暂时失败' WHERE id = ?", [intent.id]);
            await page.getByRole('link', { name: '通知处理', exact: true }).click();
            await page.getByRole('heading', { name: '通知发送与线下通知', exact: true }).waitFor();
            const before = await api(people.pm, 'GET', '/projects/' + pid + '/send-intents');
            assert.strictEqual(before.needs_offline_count, 1); assert.strictEqual(before.failed_count, 1);
            await page.getByRole('button', { name: '补发失败及超时待发通知', exact: true }).click();
            await target('notification-resend', () => contains(page, '本次补发完成，请核对通知列表。成功：1；失败：0；跳过：0'));
            const after = await api(people.pm, 'GET', '/projects/' + pid + '/send-intents');
            assert.strictEqual(after.failed_count, 0, '[notification-resend] 成功补发须清除该失败项'); assert.strictEqual(after.needs_offline_count, 1, '补发不能清除无账号的线下通知');
            const sent = after.items.find((i) => i.id === intent.id);
            assert.strictEqual(sent.status, 'sent', '[notification-resend] 补发结果须落为已发送'); assert.strictEqual(sent.attempts, intent.attempts + 1, '[notification-resend] 补发应仅追加本次发送尝试');
            await target('offline-notice-link', () => page.getByRole('link', { name: '核对知会与原改期', exact: true }).click());
            await page.getByRole('heading', { name: '改期知会', exact: true }).waitFor();
            await contains(page, '2026-12-01 → 2026-12-15');
            await visit(page, '#project=' + pid + '&tab=history');
            await page.getByRole('button', { name: '关闭历史补录窗口', exact: true }).click();
            await dialog.locator('input[type="file"]').setInputFiles(pngFile());
            await dialog.getByRole('button', { name: '关闭历史补录窗口', exact: true }).click();
            await page.getByRole('heading', { name: '历史补录 · 已关闭', exact: true }).waitFor();
            const roJoin = await invite(pid, people.readonly);
            await api(people.readonly, 'POST', '/my/invitations/' + roJoin.invitation.id + '/accept', {});
            const ro = await pageFor(people.readonly, options.mutation);
            try {
                await visit(ro.page, '#project=' + pid + '&tab=history');
                await ro.page.getByRole('heading', { name: '负责人任职已生效 · 原日期 2020-01-01', exact: true }).waitFor();
                const imported = ro.page.locator('section.sbui-panel').filter({ has: ro.page.getByRole('heading', { name: '已导入的历史事实', exact: true }) });
                await imported.getByText(people.pm.display_name, { exact: true }).first().waitFor();
                assert.strictEqual(await ro.page.getByRole('button', { name: '补录历史确认', exact: true }).count(), 0);
                assert.strictEqual(await ro.page.getByRole('link', { name: '通知处理', exact: true }).count(), 0);
                await ro.page.screenshot({ path: path.join(out, 'c8-history-readonly.png'), fullPage: true });
            } finally { await ro.context.close(); }
        }],
        [NOTICE, async (page) => {
            const pid = await project('旧通知界面_' + suffix); await demand(pid);
            const pending = await initiation(pid);
            const first = pending.task.current_revision.id;
            const second = await api(people.pm, 'POST', '/confirm-tasks/' + pending.task.task_id + '/reissue', { reason: '浏览器检查的第一次改发', revision_id: first });
            const owner = await pageFor(people.owner, options.mutation);
            try {
                await visit(owner.page, '?project=' + pid + '&rev=' + first);
                await target('stale-notice', () => owner.page.getByRole('heading', { name: '旧通知 · 任务修订已被替代', exact: true }).waitFor());
                assert.strictEqual(await viewed(people.owner.id, pending.vid), 0);
                await owner.page.getByRole('link', { name: '明确打开当前任务', exact: true }).click();
                await owner.page.getByLabel(/^本人的决定/).waitFor();
                assert.strictEqual(await viewed(people.owner.id, pending.vid), 1);
                const third = await api(people.pm, 'POST', '/confirm-tasks/' + pending.task.task_id + '/reissue', { reason: '打开旧表单之后再次改发', revision_id: second.revision.id });
                await owner.page.getByLabel(/^本人的决定/).selectOption('confirm');
                await owner.page.locator('[name="acknowledged"]').check();
                await owner.page.getByRole('button', { name: '提交本人的决定', exact: true }).click();
                await contains(owner.page, '本次决定未提交。任务版本或资格已变化，请明确重新打开后再决定。');
                assert.strictEqual(await viewed(people.owner.id, pending.vid), 1);
                const records = await sql(env.dbPath, 'SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [third.revision.id]);
                assert.strictEqual(records[0].status, 'pending');
                assert.strictEqual((await sql(env.dbPath, 'SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [third.revision.id]))[0].n, 0);
                const racePid = await project('通知定位竞态_' + suffix); await demand(racePid);
                const race = await initiation(racePid);
                let intercepted = false;
                await owner.page.route('**/api/sysbuild/confirm-tasks/' + race.task.task_id + '*', async (route) => {
                    if (!intercepted && route.request().method() === 'GET') { intercepted = true; await api(people.pm, 'POST', '/confirm-tasks/' + race.task.task_id + '/reissue', { reason: '定位之后、读任务之前改发', revision_id: race.task.current_revision.id }); }
                    await route.continue();
                });
                await visit(owner.page, '?project=' + racePid + '&rev=' + race.task.current_revision.id);
                await target('revision-race', () => owner.page.getByRole('heading', { name: '这条通知对应的任务修订已变化', exact: true }).waitFor());
                assert.strictEqual(intercepted, true);
                assert.strictEqual(await viewed(people.owner.id, race.vid), 0);
                await owner.page.unroute('**/api/sysbuild/confirm-tasks/' + race.task.task_id + '*');
            } finally { await owner.context.close(); }
        }],
    ];
}
// 每一条都固定到一个目标断言；其他超时 / pageerror 一律由入口归为异常。
const EXPECTED_FAILURES = Object.freeze({
    'proxy-grant-fixed-step': '[proxy-grant-intent]',
    'proxy-accept-fixed-step': '[proxy-accept-intent]',
    'c8-item-content': '[item-content]',
    'c8-package-material-refs': '[material-refs]',
    'c8-current-sheet-sandbox': 'sandbox不能执行响应中的脚本',
    'c8-sheet-repeat': '[sheet-repeat]',
    'c8-decision-version-binding': '[decision-submitted]',
    'c8-decision-checkbox-gate': '[decision-gate]',
    'c8-notice-auto-current': '[stale-notice]',
    'c8-notice-drop-expected': '[revision-race]',
    'c8-entry-explicit-source': '来源缺失应由表单就地提示',
    'c8-entry-file-requirement': '补交材料缺附件应由表单就地提示',
    'c8-evidence-stale-reason': '[entry-saved]',
    'c8-entry-method-label': '[entry-method-label]',
    'c8-readonly-entry-button': '[readonly-entry]',
    'c8-readonly-confirm-denied': '[decision-gate]',
    'c8-paste-background-scope': '弹窗开启时不能投递给背景附件区',
    'c8-paste-unregister': '代录后旧字段应注销',
    'c8-paste-reset': '挂载与注销均重置序号和点击记忆',
    'c8-plan-mode-from-baseline': '[plan-reschedule-mode]',
    'c8-close-no-entry-links': '[close-entry-link]',
    'c8-handover-drop-reply': '[handover-reply-saved]',
    'c8-handover-hide-reply': '[handover-reply-visible]',
    'c8-golive-target': '[golive-event]',
    'c8-history-date': '[history-original-date]',
    'c8-history-confirmation-kind': '[history-confirmation-saved]',
    'c8-notify-resend-target': '[notification-resend]',
    'c8-notify-offline-items': '[offline-notice-link]',
});
const MUTATIONS = [
    { id: 'proxy-grant-fixed-step', file: 'sysbuild-members.js', from: "'/delegations/' + d.id + '/proxy', 'grant'", to: "'/delegations/' + d.id + '/proxy', 'accept'", expect: '授权代录按钮锁定步骤' },
    { id: 'proxy-accept-fixed-step', file: 'sysbuild-members.js', from: "'/delegations/' + d.id + '/proxy', 'accept'", to: "'/delegations/' + d.id + '/proxy', 'grant'", expect: '授权代录按钮锁定步骤' },
    { id: 'c8-item-content', file: 'sysbuild-content.js', from: 'content: v.content, quote_text:', to: "content: '错误需求正文', quote_text:", expect: FLOW },
    { id: 'c8-package-material-refs', file: 'sysbuild-packages.js', from: 'material_version_ids: (v.material_version_ids || []).map(A.id)', to: 'material_version_ids: []', expect: FLOW },
    { id: 'c8-current-sheet-sandbox', file: 'sysbuild-evidence.js', from: "frame.setAttribute('sandbox', 'allow-same-origin allow-modals');", to: "frame.setAttribute('sandbox', 'allow-same-origin allow-modals allow-scripts');", expect: FLOW },
    { id: 'c8-sheet-repeat', file: 'sysbuild-confirm.js', from: 'A.assertCurrent(cc); sheetHost.replaceChildren(sheet);', to: 'A.assertCurrent(cc); sheetHost.appendChild(sheet);', expect: FLOW },
    { id: 'c8-decision-version-binding', file: 'sysbuild-confirm.js', from: "'/decide', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id, decision:", to: "'/decide', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id + 999999, decision:", expect: FLOW },
    { id: 'c8-decision-checkbox-gate', file: 'sysbuild-confirm.js', from: 'submit.disabled = !allowed.includes(selection.value) || checkbox.checked !== true;', to: 'submit.disabled = false;', expect: FLOW },
    { id: 'c8-notice-auto-current', file: 'sysbuild-confirm.js', from: 'if (found.is_current !== true) return', to: 'if (false) return', expect: NOTICE },
    { id: 'c8-notice-drop-expected', file: 'sysbuild-confirm.js', from: "(expected ? '?revision_id=' + expected : '')", to: "''", expect: NOTICE },
    { id: 'c8-entry-explicit-source', file: 'sysbuild-entries.js', from: "label: '本次登记的真实来源', required: true", to: "label: '本次登记的真实来源', required: false", expect: ENTRY },
    { id: 'c8-entry-file-requirement', file: 'sysbuild-entries.js', from: "fileControl.required = typeControl.value === 'material' || purposeControl.value === 'deliverable';", to: 'fileControl.required = false;', expect: ENTRY },
    { id: 'c8-evidence-stale-reason', file: 'sysbuild-evidence.js', from: 'no_evidence_reason: v.no_written_evidence === true ? v.no_evidence_reason || null : null', to: 'no_evidence_reason: v.no_evidence_reason || null', expect: ENTRY },
    { id: 'c8-entry-method-label', file: 'sysbuild-entries.js', from: 'label(confirmationMethods, r.confirmation.method)', to: 'r.confirmation.method', expect: ENTRY },
    { id: 'c8-readonly-entry-button', file: 'sysbuild-entries.js', from: 'data.actions.create_entry === true ? A.command', to: 'true ? A.command', expect: READONLY },
    { id: 'c8-readonly-confirm-denied', file: 'sysbuild-confirm.js', from: 'if (data.actions.decide === true) host.appendChild', to: "if (data.actions.decide === true && A.state.user.role !== 'viewer') host.appendChild", expect: READONLY },
    { id: 'c8-paste-background-scope', file: 'sysbuild-evidence.js', from: 'if (dialog.open && !dialog.contains(label)) return false;', to: 'if (false) return false;', expect: PASTE },
    { id: 'c8-paste-unregister', file: 'sysbuild-evidence.js', from: 'disposed = true; unregister(); window.UPaste.resetSeq(key);', to: 'disposed = true; window.UPaste.resetSeq(key);', expect: PASTE },
    { id: 'c8-paste-reset', file: 'sysbuild-evidence.js', from: 'disposed = true; unregister(); window.UPaste.resetSeq(key);', to: 'disposed = true; unregister();', expect: PASTE },
    { id: 'c8-plan-mode-from-baseline', file: 'sysbuild-plan.js', from: 'const mode = node.plan_write_mode;', to: "const mode = node.has_baseline ? 'reschedule' : 'draft';", expect: PLAN },
    { id: 'c8-close-no-entry-links', file: 'sysbuild-plan.js', from: "ids(r.entry_ids).map((id) => A.link", to: "ids([]).map((id) => A.link", expect: PLAN },
    { id: 'c8-handover-drop-reply', file: 'sysbuild-plan.js', from: 'if (item.reply_required) body.reply = v.reply;', to: 'if (false) body.reply = v.reply;', expect: PLAN },
    { id: 'c8-handover-hide-reply', file: 'sysbuild-confirm.js', from: "if (o.current_reply) host.appendChild", to: "if (false) host.appendChild", expect: PLAN },
    { id: 'c8-golive-target', file: 'sysbuild-plan.js', from: "'/batches/' + batch.id + '/golive'", to: "'/batches/' + (batch.id + 999999) + '/golive'", expect: PLAN },
    { id: 'c8-history-date', file: 'sysbuild-history.js', from: 'body.original_date = v.original_date;', to: "body.original_date = '2026-11-10';", expect: HISTORY },
    { id: 'c8-history-confirmation-kind', file: 'sysbuild-history.js', from: "(importing ? '/history-imports' : '/history-confirmations')", to: "'/history-imports'", expect: HISTORY },
    { id: 'c8-notify-resend-target', file: 'sysbuild-notify.js', from: "'/projects/' + detail.project.id + '/send-intents/resend'", to: "'/projects/' + (detail.project.id + 999999) + '/send-intents/resend'", expect: HISTORY },
    { id: 'c8-notify-offline-items', file: 'sysbuild-notify.js', from: 'data.offline_items.map((row)', to: '[].map((row)', expect: HISTORY },
].map((mutation) => ({ ...mutation, expectFailure: EXPECTED_FAILURES[mutation.id] }));
module.exports = { defineCases, MUTATIONS };
