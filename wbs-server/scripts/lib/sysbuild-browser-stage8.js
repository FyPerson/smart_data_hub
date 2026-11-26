'use strict';
const assert = require('assert');
const path = require('path');
const FLOW = 'C8 需求材料与内容包完整链';
const NOTICE = 'C8 旧通知与过期表单不冒认新版';
const ENTRY = 'C8 显式来源补充登记';
const READONLY = 'C8 只读维护限制与本人确认例外';
const PASTE = 'C8 粘贴截图预览与弹窗生命周期';
const PLAN = 'C8 改期收口交接答复与上线撤销';
const NOTIFYSCENE = 'C8 通知补发与线下通知边界';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function defineCases(T) {
    const { people, api, project, addMember, assignParty, pageFor, visit, contains, env, sql, suffix, options, out, token, target, declareViaCard, openStageCard, uploadPairMaterial, preparePairVersion } = T;
    const pngFile = () => ({ name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    async function upload(pid) {
        const body = new FormData(); body.append('file', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'original.png');
        const res = await fetch(env.baseUrl + '/api/sysbuild/projects/' + pid + '/attachments/stage', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(people.pm) }, body });
        const data = await res.json(); assert.strictEqual(res.status, 200, JSON.stringify(data)); return data.attachment.id;
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
        const party = await assignParty(pid, 'demand', '浏览器需求部门', owner || people.owner, delegate || people.delegate);
        return { party: party.id, ownerMember: party.owner.member_id, delegateMember: party.delegate.member_id };
    }
    async function initiation(pid) {
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        // L3：用于旧确认链的立项声明也经过实际界面输入，不由API夹具补写。
        const editor = await pageFor(people.pm, options.mutation);
        try {
            await declareViaCard(editor.page, pid);
            await visit(editor.page, '#project=' + pid + '&tab=packages&version=' + vid);
            await editor.page.locator('[name="text"]').fill('浏览器核对的立项全文_' + suffix);
            await editor.page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
            await editor.page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
        } finally { await editor.context.close(); }
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
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'overall' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        await preparePairVersion(pid, vid, 'overall');
        await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {});
        await confirmVersion(pid, vid);
        return { pid, role, batch: plan.batches[0].id };
    }
    const viewed = async (uid, vid) => (await sql(env.dbPath, "SELECT COUNT(*) AS n FROM sysbuild_views WHERE user_id = ? AND object_type = 'package_version' AND object_version_id = ?", [uid, vid]))[0].n;
    return [
        [FLOW, async (page) => {
            const pid = await project('C8全流程_' + suffix);
            const role = await demand(pid);
            const owner = await pageFor(people.owner, options.mutation);
            const representative = await pageFor(people.delegate, options.mutation);
            const second = await pageFor(people.outsider, options.mutation);
            try {
                const dialog = page.locator('#sbuiDialog'); // #212 C7：需求条目页签与提出人确认整段删除，直接从材料版本页签开始
                await visit(page, '#project=' + pid);
                const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
                const node = plan.nodes.find((n) => n.template_key === 'p_overall');
                await page.getByRole('link', { name: '全部记录', exact: true }).click();
                await page.getByRole('link', { name: '材料', exact: true }).click();
                await page.getByRole('button', { name: '建立候选材料', exact: true }).click();
                await dialog.getByLabel(/^所属节点/).selectOption(String(node.id));
                await dialog.getByLabel(/^材料名称/).fill('界面材料版本');
                const literal = '负责人看到的材料全文 <img src=x onerror="window.c8TextExecuted=1">';
                await dialog.getByLabel(/^本版材料正文/).fill(literal);
                await dialog.getByRole('button', { name: '保存候选材料版本', exact: true }).click();
                await page.locator('.sbui-drawer').getByText(literal, { exact: true }).waitFor();
                assert.strictEqual(await page.locator('#sysbuildApp img').count(), 0);
                const materials = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
                const material = materials.materials[0].versions[0];
                assert.strictEqual(material.body, literal);
                const ini = await initiation(pid);
                await visit(owner.page, '?project=' + pid + '&rev=' + ini.task.current_revision.id);
                await decide(owner.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + ini.vid)).version.status, 'effective');
                const secondParty = await assignParty(pid, 'demand', '第二需求部门', people.member, people.outsider);
                const requiredMaterial = await uploadPairMaterial(pid);
                for (const n of plan.nodes) await api(people.pm, 'POST', '/nodes/' + n.id + '/schedule', { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-11-30' }, 201);
                await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
                await page.getByRole('link', { name: '全部记录', exact: true }).click();
                await page.getByRole('link', { name: '对方确认', exact: true }).click();
                // C5：内容包页签没有「建立正式变更」入口（[packages-retired]）
                await page.getByRole('heading', { name: '对方确认', exact: true }).waitFor();
                assert.strictEqual(await page.getByRole('button', { name: '建立正式变更', exact: true }).count(), 0, '[packages-retired] 内容包页签不再有建立正式变更入口');
                await visit(page, '#project=' + pid + '&tab=plan&node=' + node.id);
                await page.getByRole('button', { name: '建立确认草稿', exact: true }).click();
                await page.getByLabel(/^本版确认正文/).fill('界面保存的完整总体规划_' + suffix);
                await page.getByRole('group', { name: /^本版明确引用的材料版本/ }).getByRole('checkbox', { name: '界面材料版本 · v1', exact: true }).check();
                await page.getByRole('group', { name: /^本版明确引用的材料版本/ }).getByRole('checkbox', { name: '需求文档 · v1', exact: true }).check();
                await page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
                await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
                const versionId = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('version'));
                const saved = await api(people.pm, 'GET', '/package-versions/' + versionId);
                assert.strictEqual(saved.snapshot_json.text, '界面保存的完整总体规划_' + suffix);
                assert.deepStrictEqual(saved.snapshot_json.material_version_ids, [material.id, requiredMaterial.id], '[material-refs] 保存必须保留明确勾选的两份材料版本');
                await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
                await page.getByRole('heading', { name: '总体范围与批次规划 v1 · 待确认', exact: true }).waitFor();
                const submitted = await api(people.pm, 'GET', '/package-versions/' + versionId);
                assert.deepStrictEqual(submitted.snapshot_json, saved.snapshot_json, '发起后保留已保存的正文与材料');
                const tasks = await api(people.pm, 'GET', '/package-versions/' + versionId + '/confirm-tasks');
                assert.deepStrictEqual(tasks.tasks.map((task) => task.current_revision.required_member_id), [role.delegateMember, secondParty.delegate.member_id]);
                await visit(representative.page, '#todo=confirm&project_filter=' + pid);
                // C6 清单 8.2 与 194-M3：等最后一个标题渲染，精确核对所有保留和新增类别的顺序，防止退役类别、重复或多出的面板。
                await target('c6-todo-categories-retired', async () => {
                    await representative.page.getByRole('heading', { name: /^超过三天待确认 · / }).waitFor();
                    for (const re of [/^待判定/, /^知会( · |$)/, /^改期知会异议/]) assert.strictEqual(await representative.page.getByRole('heading', { name: re }).count(), 0, '待办页不应再有类别标题 ' + re);
                    assert.strictEqual(await representative.page.getByRole('link', { name: '待判定', exact: true }).count(), 0, '待办页顶部计数区不应再有「待判定」入口');
                    // 保留原有类别，并核第五步新加的意见和任务。
                    const rawHeads = await representative.page.locator('section.sbui-panel > header.sbui-panel-head > h2').allTextContents();
                    assert.strictEqual(rawHeads.length, 8, `待办页八个标题：${JSON.stringify(rawHeads)}`);
                    const heads = rawHeads.map((t) => (t.match(/^(.+) · \d+$/) || [])[1]);
                    assert.deepStrictEqual(heads, ['待我确认', '待我办理', '待我处理的意见', '待完成的任务', '应交进度汇报', '逾期进度汇报', '通知发送失败', '超过三天待确认'], '待办页类别标题精确按序');
                });
                assert.strictEqual(await viewed(people.delegate.id, versionId), 0, '列表不能预读确认任务');
                await representative.page.getByRole('link', { name: '打开确认', exact: true }).click();
                await representative.page.getByRole('heading', { name: '总体范围与批次规划 · v1', exact: true }).waitFor();
                assert.strictEqual(await viewed(people.delegate.id, versionId), 1);
                await contains(representative.page, literal);
                let authenticated = false;
                let injectedSheet = '';
                await representative.page.route('**/api/sysbuild/package-versions/' + versionId + '/confirmation-sheet', async (route) => {
                    authenticated = !!route.request().headers().authorization;
                    const response = await route.fetch();
                    const html = (await response.text()).replace('</body>', '<script>parent.window.c8SheetExecuted=1</script></body>');
                    injectedSheet = html;
                    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
                });
                await representative.page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
                await representative.page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((n) => n.textContent === '加载确认单预览' && !n.disabled));
                const frame = representative.page.locator('iframe.sbui-sheet');
                await frame.waitFor();
                await representative.page.getByRole('button', { name: '打印确认单 / 保存 PDF', exact: true }).waitFor({ state: 'visible' });
                await representative.page.waitForFunction(() => {
                    const node = document.querySelector('iframe.sbui-sheet');
                    return node && node.contentDocument && node.contentDocument.readyState === 'complete' && node.contentDocument.body.textContent.includes('需求确认单');
                });
                assert.ok(injectedSheet.includes('<script>parent.window.c8SheetExecuted=1</script>'), '确认单脚本探针必须已注入');
                const probe = await representative.page.evaluate(async (html) => {
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
                assert.strictEqual(await viewed(people.delegate.id, versionId), 1, '导出不增加浏览记录');
                await representative.page.getByRole('button', { name: '加载确认单预览', exact: true }).click();
                await representative.page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((n) => n.textContent === '加载确认单预览' && !n.disabled));
                await target('sheet-repeat', () => representative.page.waitForFunction(() => document.querySelectorAll('iframe.sbui-sheet').length === 1 && !document.querySelector('iframe.sbui-sheet').parentElement.querySelector('button').disabled));
                assert.strictEqual(await frame.count(), 1, '[sheet-repeat] 重复加载只保留当前确认单');
                assert.strictEqual(await viewed(people.delegate.id, versionId), 1, '重复导出不增加浏览记录');
                await representative.page.screenshot({ path: path.join(out, 'c8-confirmation.png'), fullPage: true });
                await frame.evaluate((node) => { window.c8PrintEvents = 0; node.contentWindow.addEventListener('beforeprint', () => { window.c8PrintEvents += 1; }); });
                await representative.page.getByRole('button', { name: '打印确认单 / 保存 PDF', exact: true }).click();
                assert.ok(await representative.page.evaluate(() => window.c8PrintEvents > 0), '打印应作用于沙盒中的确认单文档');
                await decide(representative.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + versionId)).version.status, 'pending', '一方确认不自动替另一方同意');
                const repTask = tasks.tasks.find((t) => t.current_revision.required_member_id === secondParty.delegate.member_id);
                await visit(second.page, '#task=' + repTask.task_id + '&revision_id=' + repTask.current_revision.id);
                await decide(second.page);
                assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + versionId)).version.status, 'effective');
                await representative.page.unroute('**/api/sysbuild/package-versions/' + versionId + '/confirmation-sheet');
            } finally { await owner.context.close(); await representative.context.close(); await second.context.close(); }
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
            // C6（P-R9 = A，变异 B2）：用途下拉与 node_id 在同一次表单渲染里，等到它即表单已出；选项来自服务端 meta.purposes，只剩「通用」（等价变异的防线：B2 的 to 把 options 整体硬编码成三项）
            await dialog.locator('[name="purpose"]').waitFor();
            await target('c6-purpose-retired', async () => { assert.deepStrictEqual(await dialog.locator('[name="purpose"] option').evaluateAll((o) => o.map((x) => x.value)), ['general'], '[c6-purpose-retired] 登记弹窗用途下拉只有通用'); });
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
            // C6：判定归属 / 给出办理结论 / 异议 / 交负责人裁定随 S4 / S7 删除，场景到此为止（原 :259–293）
        }],
        [READONLY, async (page) => {
            const pid = await project('只读本人确认_' + suffix);
            await demand(pid, people.readonly);
            await visit(page, '#project=' + pid + '&tab=entries');
            assert.strictEqual(await page.getByRole('button', { name: '追加登记', exact: true }).count(), 0, '[readonly-entry] 只读不得出现登记按钮');
            await page.getByRole('link', { name: '全部记录', exact: true }).click();
            await page.getByRole('link', { name: '材料', exact: true }).click();
            await page.getByRole('heading', { name: '材料版本与采纳依据', exact: true }).waitFor();
            assert.strictEqual(await page.getByRole('button', { name: '建立候选材料', exact: true }).count(), 0);
            const pending = await initiation(pid);
            await visit(page, '#task=' + pending.task.task_id);
            await decide(page);
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + pending.vid)).version.status, 'effective', '只读身份不妨碍本人作为必需确认人确认');
        }, 'readonly'],
        [PASTE, async (page) => {
            // 附件记录弹窗打开时，立项依据抽屉表单仍在背景，验证粘贴不会投给它。
            const pid = await project('粘贴与生命周期_' + suffix);
            const ini = (await sql(env.dbPath, "SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [pid]))[0];
            const att = await upload(pid);
            await api(people.pm, 'POST', '/nodes/' + ini.id + '/materials/initiation-basis/versions', { name: '立项依据', body: '供本次粘贴核对的立项依据', attachment_ids: [att] }, 201);
            await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
            const drawer = await openStageCard(page, '立项依据');
            const inline = drawer.locator('input[type="file"][name="files"]');
            const record = drawer.locator('details').filter({ has: page.getByText('立项依据 v1', { exact: true }) });
            await record.getByText('立项依据 v1', { exact: true }).click();
            await record.getByRole('button', { name: '查看附件记录', exact: true }).click();
            await page.locator('#sbuiDialog').getByRole('button', { name: '受控遮蔽', exact: true }).click();
            await paste(page, '#sbuiDialog textarea', true);
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 0, '弹窗开启时不能投递给背景附件区');
            await page.locator('#sbuiDialog').getByRole('button', { name: '关闭', exact: true }).click();
            const prevented = await paste(page, 'textarea[name="body"]', true);
            assert.strictEqual(prevented, false, '混合剪贴板须保留文本输入的默认行为');
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 1);
            const fileName = await inline.evaluate((n) => n.files[0].name);
            assert.match(fileName, /^项目截图_.+_1\.png$/);
            await page.getByRole('button', { name: '预览 ' + fileName, exact: true }).click();
            await page.locator('.sbui-lightbox[open] img').waitFor();
            assert.strictEqual(await page.locator('.sbui-lightbox img').evaluate((n) => n.complete && n.naturalWidth > 0), true);
            await page.keyboard.press('Escape');
            await page.locator('.sbui-lightbox').waitFor({ state: 'detached' });
            await paste(page, 'textarea[name="body"]', false, 'image/bmp');
            assert.strictEqual(await inline.evaluate((n) => n.files.length), 1, '不支持格式不能被收入待上传文件');
            // 保存前先记附件最大编号与注销计数，渲染后核增量
            const maxBefore = (await sql(env.dbPath, 'SELECT COALESCE(MAX(id), 0) AS id FROM sysbuild_attachments WHERE project_id = ?', [pid]))[0].id;
            const statsBefore = await page.evaluate(() => window.c8PasteStats);
            await page.locator('textarea[name="body"]').fill('供本次粘贴核对的立项依据（第二版）');
            await page.getByRole('button', { name: '保存立项依据版本', exact: true }).click();
            await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
            await drawer.getByText('立项依据 v2', { exact: true }).waitFor();
            const statsAfter = await page.evaluate(() => window.c8PasteStats);
            assert.ok(statsAfter.unregistered > statsBefore.unregistered, '提交成功后旧字段应注销（增量）');
            // [paste-staged-evidence]：步骤 1–3 为前置 / 对照，步骤 4 是 M2153 的判红点
            const v2 = await sql(env.dbPath, "SELECT mv.id AS id FROM sysbuild_material_versions mv JOIN sysbuild_materials m ON m.id = mv.material_id WHERE m.node_id = ? AND m.material_key = 'initiation-basis' AND mv.version_no = 2", [ini.id]);
            assert.strictEqual(v2.length, 1, '[paste-v2-created] 立项依据 v2 版本恰一条');
            const v1 = await sql(env.dbPath, "SELECT mv.id AS id FROM sysbuild_material_versions mv JOIN sysbuild_materials m ON m.id = mv.material_id WHERE m.node_id = ? AND m.material_key = 'initiation-basis' AND mv.version_no = 1", [ini.id]);
            assert.strictEqual(v1.length, 1, '[paste-v2-created] 造数的立项依据 v1 恰一条');
            const uploaded = await sql(env.dbPath, 'SELECT id, original_name AS name, size, is_image AS img FROM sysbuild_attachments WHERE project_id = ? AND id > ? ORDER BY id', [pid, maxBefore]);
            assert.strictEqual(uploaded.length, 1, '[paste-v2-created] 粘贴上传恰产生一个新附件');
            assert.match(uploaded[0].name, /^项目截图_.+_1\.png$/);
            assert.ok(uploaded[0].size > 0);
            assert.strictEqual(uploaded[0].img, 1);
            const v1b = await sql(env.dbPath, "SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'material_version' AND owner_id = ?", [v1[0].id]);
            assert.deepStrictEqual(v1b.map((r) => r.attachment_id), [att], '[paste-v1-intact] v1 的绑定仍是造数时的 att');
            const bound = await sql(env.dbPath, "SELECT b.attachment_id AS attachment_id FROM sysbuild_attachment_bindings b WHERE b.owner_type = 'material_version' AND b.owner_id = ?", [v2[0].id]);
            assert.strictEqual(bound.length, 1, '[paste-staged-evidence] v2 恰一条新暂存附件绑定');
            assert.strictEqual(bound[0].attachment_id, uploaded[0].id, '[paste-staged-evidence] v2 绑定的就是本次粘贴上传的附件');
            await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await page.getByRole('link', { name: '帮助', exact: true }).click();
            await page.getByRole('heading', { name: '项目管理帮助', exact: true }).waitFor();
            const stats = await page.evaluate(() => window.c8PasteStats);
            assert.strictEqual(stats.unregistered, stats.registered, '提交成功后旧字段应注销：离开页面注销全部附件区域');
            assert.strictEqual(stats.reset, stats.registered + stats.unregistered, '挂载与注销均重置序号和点击记忆');
        }],
        [PLAN, async (page) => {
            const s = await effectivePlan();
            const node = (await api(people.pm, 'POST', '/batches/' + s.batch + '/nodes', { name: '生效后新增的交付节点' }, 201)).node;
            const currentNode = async () => (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.find((n) => n.id === node.id);
            assert.strictEqual((await currentNode()).has_baseline, false);
            assert.strictEqual((await currentNode()).plan_write_mode, 'draft');
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + node.id);
            await target('plan-reschedule-mode', () => page.getByRole('button', { name: '设置草稿计划', exact: true }).click());
            const dialog = page.locator('#sbuiDialog');
            await target('plan-reschedule-mode', () => contains(page, '保存此次计划。基线随总体规划确认生效形成。'));
            await dialog.locator('[name="planned_start"]').fill('2026-12-01');
            await dialog.locator('[name="planned_end"]').fill('2026-12-05');
            await dialog.getByRole('button', { name: '保存草稿期计划', exact: true }).click();
            await contains(page, '2026-12-01 → 2026-12-05');
            assert.strictEqual((await currentNode()).has_baseline, false, '改期不补造确认基线');
            // C6（R2，清单 4.2 / 168-M9）：改期弹窗不再带 dev_key_entry_id（含 null）。拦截 POST /sysbuild/nodes/:nid/schedule 的请求体，两格：
            //   ① 改期提出方选开发方参与方（原前端在开发方来源时才组装该键，漏改这一行没有别的浏览器用例判红）；② 草稿期排计划弹窗（下面单独建项目）。
            {
                // ② 草稿期排计划弹窗：另建项目（立项包确认后、总体规划未生效，节点 plan_write_mode = draft）
                const dpid = await project('草稿期排计划_' + suffix);
                await demand(dpid);
                const dini = await initiation(dpid); await confirmVersion(dpid, dini.vid);
                const dnode = (await api(people.pm, 'GET', '/projects/' + dpid + '/plan')).nodes.find((n) => n.plan_write_mode === 'draft');
                assert.ok(dnode, '草稿期项目里应有 plan_write_mode = draft 的节点');
                const draftBodies = [];
                await page.route('**/api/sysbuild/nodes/' + dnode.id + '/schedule', async (route) => {
                    if (route.request().method() === 'POST') draftBodies.push(JSON.parse(route.request().postData() || '{}'));
                    await route.continue();
                });
                await visit(page, '#project=' + dpid + '&tab=plan&node=' + dnode.id);
                await page.getByRole('button', { name: '设置草稿计划', exact: true }).click();
                await dialog.locator('[name="planned_start"]').fill('2026-12-07');
                await dialog.locator('[name="planned_end"]').fill('2026-12-09');
                await dialog.getByRole('button', { name: '保存草稿期计划', exact: true }).click();
                await target('plan-draft-body', async () => {
                    await dialog.waitFor({ state: 'hidden' });
                    assert.strictEqual(draftBodies.length, 1, '草稿期排计划恰提交一次');
                    assert.strictEqual('dev_key_entry_id' in draftBodies[0], false, '草稿期排计划提交体不能带 dev_key_entry_id（含 null）');
                    const cur = (await api(people.pm, 'GET', '/projects/' + dpid + '/plan')).nodes.find((n) => n.id === dnode.id).current_plan;
                    assert.deepStrictEqual([cur.start, cur.end], ['2026-12-07', '2026-12-09'], '草稿期节点计划已更新');
                });
            }
            const scheduleBodies = [];
            await page.route('**/api/sysbuild/nodes/' + node.id + '/schedule', async (route) => {
                if (route.request().method() === 'POST') scheduleBodies.push(JSON.parse(route.request().postData() || '{}'));
                await route.continue();
            });
            const devParty = await assignParty(s.pid, 'dev', '改期检查开发方', people.member);
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + node.id);
            await page.getByRole('button', { name: '改期', exact: true }).click();
            await target('plan-reschedule-mode', () => dialog.locator('[name="source_party_id"]').waitFor());
            await dialog.locator('[name="planned_start"]').fill('2026-12-02');
            await dialog.locator('[name="planned_end"]').fill('2026-12-06');
            await dialog.locator('[name="reason"]').fill('开发方提出的改期，核对提交体不带关键事项登记编号');
            await dialog.locator('[name="source_party_id"]').selectOption(String(devParty.id));
            await dialog.getByLabel('确无书面证据', { exact: true }).check();
            await dialog.locator('[name="no_evidence_reason"]').fill('开发方口头提出的调整尚无独立书面原件');
            await dialog.getByRole('button', { name: '追加改期记录', exact: true }).click();
            await target('plan-reschedule-dev-body', async () => {
                await dialog.waitFor({ state: 'hidden' });
                await contains(page, '2026-12-02 → 2026-12-06');
                assert.strictEqual(scheduleBodies.length, 1, '开发方来源改期恰提交一次');
                assert.strictEqual(scheduleBodies[0].source_party_id, devParty.id, '提交体的来源是所选开发方参与方');
                assert.strictEqual('dev_key_entry_id' in scheduleBodies[0], false, '开发方来源的改期提交体不能带 dev_key_entry_id（含 null）');
                const cur = (await currentNode()).current_plan;
                assert.deepStrictEqual([cur.start, cur.end], ['2026-12-02', '2026-12-06'], '节点计划已更新为开发方来源的改期');
            });
            await page.getByRole('button', { name: '开始阶段', exact: true }).click();
            await page.getByRole('heading', { name: node.name + ' · 进行中', exact: true }).waitFor();
            const entryBody = { type: 'issue', title: '本节点待处理问题', body: '核对收口必须先办理本条过程问题', node_id: node.id, source_party_id: null, no_written_evidence: true, no_evidence_reason: '现场沟通记录尚未形成独立书面原件' };
            const entry = (await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', entryBody, 201)).entry;
            // C6（R3）：本节点有未作废的办理类登记不再挡收口（旧版确认收口按钮禁用并带「办理登记 #n」链接，随 R3 删除）：登记留着不办，核对收口后直接成功
            await page.getByRole('button', { name: '完成阶段', exact: true }).click();
            await dialog.locator('[name="checked"]').check();
            await dialog.getByRole('button', { name: '确认完成', exact: true }).click();
            await page.getByRole('button', { name: '重开阶段', exact: true }).click();
            await dialog.locator('[name="reason"]').fill('为核对新增过程问题而重新打开本节点');
            await dialog.getByRole('button', { name: '重开阶段', exact: true }).click();
            await page.getByRole('heading', { name: node.name + ' · 进行中', exact: true }).waitFor();
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + entry.id)).entry.period, 'process', '重开不重写原登记时段');
            // C6（主会话裁定 163-M12）：负向断言改用一条普通登记（无 is_risk、不 conclude）——旧页面对「带风险、已办结」的登记才出现交接事项面板，普通登记在旧页面也不出现，所以下面标题断言只是文档性负向断言；
            //   [golive-retired] 的判红由两个退役按钮断言与汇总 / 旧面板标题断言承担，c4-handover-control-restored（#1647）仍在按钮断言处判红（交接事项面板的数据源 items 已随 C4 删，只恢复前端面板时没有数据可渲染）
            const reg = (await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { ...entryBody, title: '已办结的普通登记' }, 201)).entry;
            await visit(page, '#project=' + s.pid + '&tab=handover');
            // #212 C4（RC22）：上线页签不再有交接事项面板、汇总与「发起交接确认」「答复后重新发起确认」按钮；上面造的普通登记保留：上线页签不出现交接事项面板，[golive-retired] 的前提是页面渲染完（golive-blockers 已可见）。
            //   三个目标共用同一个批次面板定位器（A.panel 渲染 section.sbui-panel，标题 h2 取批次名）；[golive-retired]、[golive-gate] 都放在 [golive-blockers] 已可见之后（页面渲染完才断言「不存在」，否则按钮不存在的断言在渲染完成前就成立，放回按钮的变异会存活）。
            const batchName = (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).batches.find((b) => b.id === s.batch).name;
            const batchPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: batchName, exact: true }) });
            await target('golive-blockers', () => batchPanel.locator('ul.sbui-checklist li.sbui-error').filter({ hasText: '本批批次验收包还没有生效版本' }).waitFor()); // 验收包下面才建，此刻未生效
            await target('golive-retired', async () => {
                for (const name of ['发起交接确认', '答复后重新发起确认']) assert.strictEqual(await page.getByRole('button', { name, exact: true }).count(), 0, '退役按钮不能出现：' + name);
                assert.strictEqual(await page.getByRole('heading', { name: '#' + reg.id + ' · 已办结的普通登记', exact: true }).count(), 0, '登记不再有交接事项面板（普通登记也不出现）');
                assert.strictEqual(await page.locator('.sbui-fact').filter({ has: page.locator('.sbui-label', { hasText: '交接事项' }) }).count(), 0, '交接汇总不能出现');
                assert.strictEqual(await page.getByRole('heading', { name: '收口与上线交接', exact: true }).count(), 0, '旧面板标题不能出现');
            });
            await target('golive-gate', async () => assert.strictEqual(await batchPanel.getByRole('button', { name: '确认试运行结束并正式上线', exact: true }).count(), 0, '前置未满足时批次面板里不能有上线按钮'));
            const pk = (await api(people.pm, 'POST', '/projects/' + s.pid + '/packages', { type: 'batch_accept', batch_id: s.batch }, 201)).package.id;
            const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
            await preparePairVersion(s.pid, vid, 'batch_accept');
            await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {}); await confirmVersion(s.pid, vid);
            for (const n of (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.filter((n) => n.batch_id === s.batch && !n.is_golive_milestone && n.status !== 'closed')) {
                // L2 fixture：这个 inhouse 批次的开发节点已有计划，开始前由 PM 显式登记节奏；不改 start 请求包装器。
                if (n.status === 'not_started' && n.template_key === 'b_dev') await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { node_id: n.id, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: n.current_plan.start, note: '浏览器上线夹具的开发汇报节奏' } }, 201);
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
        [NOTIFYSCENE, async (page) => {
            // #212 C3（清单 4.4 ④、4.6 ①②）：线下通知 / 无账号负责人部分随 S9 删除；场景只剩补发、知会落地与只读账号页，项目级失败计数按夹具独立推算（手写 SQL 前提，不取自被测接口）
            // 夹具（实跑发现，清单 4.4 ⑦ 步骤 3 的前提）：effectivePlan() 里的带账号确认人（owner / delegate / pm）在夹具库里没有钉钉号，邀请 / 确认 / 改期知会的发送意图会全部 failed（「收件人没有钉钉号…」），
            //   使「起点没有 failed / pending 意图」不成立；先给他们写钉钉号（只改收件地址，与 member 一样），让这些意图走替身发送成功。
            //   先读出原值，场景结束（含失败）时在 finally 里还原，不留给后面的场景。
            const dingPeople = [people.owner, people.delegate, people.pm];
            //   people.member 的钉钉号在下面步骤 3 也会被改，同样纳入原值快照并在 finally 还原（codex 102 M1）。
            const dingRestore = [...dingPeople, people.member];
            const dingOrig = await sql(env.dbPath, 'SELECT id, dingtalk_user_id FROM users WHERE id IN (' + dingRestore.map(() => '?').join(', ') + ')', dingRestore.map((p) => p.id));
            assert.deepStrictEqual(dingOrig.map((r) => r.id).sort(), dingRestore.map((p) => p.id).sort(), '[前提] 钉钉号原值快照须覆盖 owner / delegate / pm / member 四人');
            try {
            for (const person of dingPeople) await sql(env.dbPath, 'UPDATE users SET dingtalk_user_id = ? WHERE id = ?', ['browser-stub-recipient-' + person.id + '-' + suffix, person.id]);
            const s = await effectivePlan();
            const pid = s.pid;
            const noticeIds = async () => (await sql(env.dbPath, "SELECT id FROM sysbuild_notices WHERE project_id = ? AND kind = 'schedule_change' ORDER BY id", [pid])).map((r) => r.id);
            const intentsOf = () => api(people.pm, 'GET', '/projects/' + pid + '/send-intents');
            // 1 起点：项目级失败计数按夹具独立推算（手写 SQL 前提，不取自被测接口）
            assert.deepStrictEqual(await noticeIds(), [], '[前提] 起点：项目内没有改期知会');
            const start = await intentsOf();
            assert.strictEqual(start.failed_count, 0, '[count] 起点失败计数应为 0');
            // 2 推后里程碑生成改期知会（单个需求部门：恰 1 条，接收人 = 现任负责人 s.role.ownerMember）
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const milestone = plan.nodes.find((n) => n.is_golive_milestone);
            await api(people.pm, 'POST', '/nodes/' + milestone.id + '/schedule', { kind: 'plan', planned_start: '2026-12-01', planned_end: '2026-12-15', reason: '核对后明确推迟里程碑安排', source_party_id: null, no_written_evidence: true, no_evidence_reason: '本次线下讨论形成改期安排尚无独立书面记录' }, 201);
            const recipients = await sql(env.dbPath, "SELECT id, recipient_member_id AS member FROM sysbuild_notices WHERE project_id = ? AND kind = 'schedule_change' ORDER BY id", [pid]);
            assert.strictEqual(recipients.length, 1, '[前提] 推后后项目内改期知会恰 1 条（单个需求部门，发给现任负责人）');
            assert.strictEqual(recipients[0].member, s.role.ownerMember, '[前提] 该知会的接收人是现任负责人');
            const noticeId = recipients[0].id;
            // 3 补发前提：没有其他符合补发条件的记录（先等本项目没有 pending 意图，再邀请，口径同 notify-core.js intentFailedWhere）
            await sql(env.dbPath, 'UPDATE users SET dingtalk_user_id = ? WHERE id = ?', ['browser-stub-recipient-' + suffix, people.member.id]);
            const waitNoPending = async () => {
                for (let i = 0; i < 50; i += 1) {
                    if ((await sql(env.dbPath, "SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE project_id = ? AND status = 'pending'", [pid]))[0].n === 0) return;
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
                assert.fail('[前提] 等待 10 秒后本项目仍有 pending 发送意图（夹具串扰）');
            };
            await waitNoPending();
            const init = (await api(people.pm, 'GET', '/projects/' + pid + '/packages')).packages.find((p) => p.type === 'initiation');
            const next = (await api(people.pm, 'POST', '/packages/' + init.id + '/versions', {}, 201)).version;
            await api(people.pm, 'POST', '/package-versions/' + next.id + '/submit', {});
            const pending = (await api(people.pm, 'GET', '/package-versions/' + next.id + '/confirm-tasks')).tasks[0].current_revision;
            await waitNoPending();
            const intent = (await sql(env.dbPath, "SELECT id, attempts FROM sysbuild_send_intents WHERE project_id = ? AND ref_type = 'confirm_revision' AND ref_id = ?", [pid, pending.id]))[0];
            const stray = await sql(env.dbPath, "SELECT id, purpose, ref_type, ref_id, recipient_user_id, status, last_error FROM sysbuild_send_intents WHERE project_id = ? AND status IN ('failed', 'pending') ORDER BY id", [pid]);
            assert.deepStrictEqual(stray, [], '[前提] 起点：本项目没有 failed / pending 发送意图：' + JSON.stringify(stray));
            assert.strictEqual((await intentsOf()).failed_count, 0, '[count] 起点失败计数应为 0');
            // A channel failure receipt fixture, not a forged business decision; resend still uses the production stub transport.
            await sql(env.dbPath, "UPDATE sysbuild_send_intents SET status = 'failed', last_error = '浏览器夹具：渠道暂时失败' WHERE id = ?", [intent.id]);
            // 4 改成 failed 之后：失败计数 0 → 1
            const before = await intentsOf();
            assert.deepStrictEqual((await sql(env.dbPath, "SELECT id FROM sysbuild_send_intents WHERE project_id = ? AND status = 'failed'", [pid])).map((r) => r.id), [intent.id], '[前提] failed 意图恰为刚改的这一条');
            assert.strictEqual(before.failed_count, 1, '[count] 改成 failed 后失败计数应为 0 + 1');
            await visit(page, '#project=' + pid);
            assert.strictEqual(await page.getByRole('link', { name: '通知处理', exact: true }).count(), 1, '[前提] PM 页面有「通知处理」入口');
            await page.getByRole('link', { name: '通知处理', exact: true }).click();
            await page.getByRole('heading', { name: '通知发送', exact: true }).waitFor();
            // 补发只处理 failed / 超时 pending 的发送意图：知会条数不变、该知会的发送意图与发送尝试不变（补发不重发已 sent 的知会意图）
            const noticeIntents = () => sql(env.dbPath, "SELECT id, status, attempts FROM sysbuild_send_intents WHERE ref_type = 'notice' AND ref_id = ? ORDER BY id", [noticeId]);
            const noticeAttempts = () => sql(env.dbPath, 'SELECT id, result, response_code FROM sysbuild_notice_attempts WHERE notice_id = ? ORDER BY id', [noticeId]);
            const noticeRows = () => sql(env.dbPath, "SELECT * FROM sysbuild_notices WHERE project_id = ? ORDER BY id", [pid]);
            const intentsBefore = await noticeIntents();
            assert.deepStrictEqual(intentsBefore.map((r) => r.status), ['sent'], '[前提] 补发前目标知会恰有一条 sent 的发送意图');
            const attemptsBefore = await noticeAttempts();
            const noticesBefore = await noticeRows();
            await page.getByRole('button', { name: '补发失败及超时待发通知', exact: true }).click();
            // 完成信号用不含条数的前缀（整句里的条数由下面 target 块在比较之后核）；补发没有发生时（M2190）在这里超时，所以同样挂在 notification-resend 标记上
            await target('notification-resend', () => page.locator('.sbui-notice', { hasText: '本次补发完成，请核对通知列表。' }).waitFor());
            assert.deepStrictEqual(await noticeIntents(), intentsBefore, '[notification-resend] 补发不重发已发送的知会意图（id / status / attempts 全等）');
            assert.deepStrictEqual(await noticeAttempts(), attemptsBefore, '[notification-resend] 补发不重发已发送的知会意图（尝试记录全等）');
            assert.deepStrictEqual(await noticeRows(), noticesBefore, '[notification-resend] 补发不新增、不改动知会');
            await target('notification-resend', () => contains(page, '本次补发完成，请核对通知列表。成功：1；失败：0；跳过：0'));
            // 5 补发后：失败计数 1 → 0
            const after = await intentsOf();
            assert.strictEqual(after.failed_count, 0, '[count] 补发后失败计数应为 1 - 1');
            // 6 指定邀请意图的状态与尝试次数
            const sent = after.items.find((i) => i.id === intent.id);
            assert.strictEqual(sent.status, 'sent', '[notification-resend] 补发结果须落为已发送'); assert.strictEqual(sent.attempts, intent.attempts + 1, '[notification-resend] 补发应仅追加本次发送尝试');
            // 7 知会落地：发送意图列表里该知会意图行的「核对知会」链接（href 指向夹具查出的 noticeId），点击后核 hash、标题、日期与落地面板的接收人 / 节点 / 原因
            const link = page.getByRole('link', { name: '核对知会', exact: true });
            assert.strictEqual(await link.getAttribute('href'), '#notice=' + noticeId, '链接目标应是项目内唯一的那条改期知会');
            await link.click();
            await page.waitForFunction((expected) => new URLSearchParams(location.hash.slice(1)).get('notice') === String(expected), noticeId);
            await page.getByRole('heading', { name: '改期知会', exact: true }).waitFor();
            await contains(page, '2026-12-01 → 2026-12-15');
            const ownerName = (await sql(env.dbPath, 'SELECT COALESCE(u.display_name, u.username) AS n FROM sysbuild_members m JOIN users u ON u.id = m.user_id WHERE m.id = ?', [s.role.ownerMember]))[0].n;
            const milestoneName = (await sql(env.dbPath, 'SELECT name FROM sysbuild_nodes WHERE id = ?', [milestone.id]))[0].name;
            const noticePanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '改期知会', exact: true }) });
            // 「本次改期事实」面板嵌在「改期知会」面板里面，外层也含该标题，所以取最内层那个
            const factsPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '本次改期事实', exact: true }) }).last();
            const fact = (scope, label) => scope.locator('.sbui-fact').filter({ has: page.locator('.sbui-label', { hasText: label }) });
            await target('notice-landing-recipient', async () => {
                assert.strictEqual(await fact(noticePanel, '接收人').textContent(), '接收人' + ownerName, '[notice-landing-recipient] 落地面板的接收人');
            });
            assert.strictEqual(await fact(factsPanel, '节点').textContent(), '节点' + milestoneName, '[notice-landing-node] 原改期记录的节点');
            assert.ok((await factsPanel.textContent()).includes('核对后明确推迟里程碑安排'), '[notice-landing-reason] 原改期记录的原因');
            await target('step6-notice-first', async () => {
                await visit(page, '?project=' + pid + '&tab=overview&notice=' + noticeId);
                await page.getByRole('heading', { name: '改期知会', exact: true }).waitFor();
                await contains(page, '2026-12-01 → 2026-12-15');
            });
            await addMember(pid, people.readonly);
            const ro = await pageFor(people.readonly, options.mutation);
            try {
                await visit(ro.page, '#project=' + pid);
                await ro.page.locator('#sbuiView[aria-busy="false"]').waitFor();
                // 先证明只读用户已加载出该项目（标题可见），再断言入口不存在，否则加载失败也会误绿（codex 102 L1）
                await ro.page.getByRole('heading', { name: '排期交接_' + suffix, exact: true }).waitFor();
                assert.strictEqual(await ro.page.getByRole('link', { name: '通知处理', exact: true }).count(), 0);
            } finally { await ro.context.close(); }
            } finally {
                for (const row of dingOrig) await sql(env.dbPath, 'UPDATE users SET dingtalk_user_id = ? WHERE id = ?', [row.dingtalk_user_id, row.id]);
            }
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
    'c5-packages-change-entry-restored': '[packages-retired]',
    'c8-package-material-refs': '[material-refs]',
    'c8-current-sheet-sandbox': 'sandbox不能执行响应中的脚本',
    'c8-sheet-repeat': '[sheet-repeat]',
    'c8-decision-version-binding': '[decision-submitted]',
    'c8-decision-checkbox-gate': '[decision-gate]',
    'c8-notice-auto-current': '[stale-notice]',
    'c8-notice-drop-expected': '[revision-race]',
    'step6-legacy-notice-loses-to-project': '[step6-notice-first]',
    'c8-entry-explicit-source': '来源缺失应由表单就地提示',
    'c8-entry-file-requirement': '补交材料缺附件应由表单就地提示',
    'c8-evidence-stale-reason': '[entry-saved]',
    'c6-register-purpose-restored': '[c6-purpose-retired]',
    'c8-readonly-entry-button': '[readonly-entry]',
    'c8-readonly-confirm-denied': '[decision-gate]',
    'c8-paste-background-scope': '弹窗开启时不能投递给背景附件区',
    'c8-paste-unregister': '提交成功后旧字段应注销',
    'c8-paste-reset': '挂载与注销均重置序号和点击记忆',
    'c8-plan-mode-from-baseline': '[plan-reschedule-mode]',
    'c4-golive-blockers-hidden': '[golive-blockers]',
    'c4-handover-control-restored': '[golive-retired]',
    'c4-golive-button-ungated': '[golive-gate]',
    'c8-golive-target': '[golive-event]',
    'c8-notify-resend-target': '[notification-resend]',
    'c8-notice-landing-recipient': '[notice-landing-recipient]',
});
const MUTATIONS = [
    { id: 'c5-packages-change-entry-restored', file: 'sysbuild-packages.js', from: "host.appendChild(A.panel('对方确认', [A.hint(", to: "host.appendChild(A.row(A.button('建立正式变更', () => {}, 'primary'))); host.appendChild(A.panel('对方确认', [A.hint(", expect: FLOW, expectFailure: '[packages-retired]' },
    { id: 'c8-package-material-refs', file: 'sysbuild-packages.js', from: 'material_version_ids: (v.material_version_ids || []).map(A.id)', to: 'material_version_ids: []', expect: FLOW },
    { id: 'c8-current-sheet-sandbox', file: 'sysbuild-evidence.js', from: "frame.setAttribute('sandbox', 'allow-same-origin allow-modals');", to: "frame.setAttribute('sandbox', 'allow-same-origin allow-modals allow-scripts');", expect: FLOW },
    { id: 'c8-sheet-repeat', file: 'sysbuild-confirm.js', from: 'A.assertCurrent(cc); sheetHost.replaceChildren(sheet);', to: 'A.assertCurrent(cc); sheetHost.appendChild(sheet);', expect: FLOW },
    { id: 'c8-decision-version-binding', file: 'sysbuild-confirm.js', from: "'/decide', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id, decision:", to: "'/decide', { method: 'POST', body: { revision_id: data.revision.id, object_version_id: data.task.object_version_id + 999999, decision:", expect: FLOW },
    { id: 'c8-decision-checkbox-gate', file: 'sysbuild-confirm.js', from: 'submit.disabled = !allowed.includes(selection.value) || checkbox.checked !== true;', to: 'submit.disabled = false;', expect: FLOW },
    { id: 'c8-notice-auto-current', file: 'sysbuild-confirm.js', from: 'if (found.is_current !== true) return', to: 'if (false) return', expect: NOTICE },
    { id: 'c8-notice-drop-expected', file: 'sysbuild-confirm.js', from: "(expected ? '?revision_id=' + expected : '')", to: "''", expect: NOTICE },
    { id: 'c8-entry-explicit-source', file: 'sysbuild-entries.js', from: "label: '本次登记的真实来源', required: true", to: "label: '本次登记的真实来源', required: false", expect: ENTRY },
    { id: 'c8-entry-file-requirement', file: 'sysbuild-entries.js', from: "fileControl.required = typeControl.value === 'material';", to: 'fileControl.required = false;', expect: ENTRY }, // #212 C6（A.4 M2175）：requireFile 联动去 deliverable，只留 type === material
    // #212 C6 新增（A.3 B2）：登记弹窗用途下拉放回开发方处理说明 / 正式交付物。用途下拉的选项来自服务端 meta.purposes，只在前端放回用途名而不改选项来源是等价变异，所以 to 把 options 整体硬编码成三项；expectFailure 绑 [c6-purpose-retired]
    { id: 'c6-register-purpose-restored', file: 'sysbuild-entries.js', from: 'options: meta.purposes.map((p) => [p, label(purposes, p)])', to: "options: ['general', 'dev_note', 'deliverable'].map((p) => [p, label(purposes, p)])", expect: ENTRY },
    { id: 'c8-evidence-stale-reason', file: 'sysbuild-evidence.js', from: 'no_evidence_reason: v.no_written_evidence === true ? v.no_evidence_reason || null : null', to: 'no_evidence_reason: v.no_evidence_reason || null', expect: ENTRY },
    { id: 'c8-readonly-entry-button', file: 'sysbuild-entries.js', from: 'data.actions.create_entry === true ? A.command', to: 'true ? A.command', expect: READONLY },
    { id: 'c8-readonly-confirm-denied', file: 'sysbuild-confirm.js', from: 'if (data.actions.decide === true) host.appendChild', to: "if (data.actions.decide === true && A.state.user.role !== 'viewer') host.appendChild", expect: READONLY },
    { id: 'c8-paste-background-scope', file: 'sysbuild-evidence.js', from: 'if (dialog.open && !dialog.contains(label)) return false;', to: 'if (false) return false;', expect: PASTE },
    { id: 'c8-paste-unregister', file: 'sysbuild-evidence.js', from: 'disposed = true; unregister(); window.UPaste.resetSeq(key);', to: 'disposed = true; window.UPaste.resetSeq(key);', expect: PASTE },
    { id: 'c8-paste-reset', file: 'sysbuild-evidence.js', from: 'disposed = true; unregister(); window.UPaste.resetSeq(key);', to: 'disposed = true; unregister();', expect: PASTE },
    { id: 'c8-plan-mode-from-baseline', file: 'sysbuild-plan.js', from: 'const mode = node.plan_write_mode;', to: "const mode = node.has_baseline ? 'reschedule' : 'draft';", expect: PLAN },
    // #212 C4 新增：上线页签（收口页）的阻塞原因面板、上线按钮显示条件、已退役按钮；from 在改后的 sysbuild-plan.js 里各恰好出现 1 次
    { id: 'c4-golive-blockers-hidden', file: 'sysbuild-plan.js', from: '[blockers(data.blockers, detail.project.id)]', to: '[]', expect: PLAN },
    { id: 'c4-golive-button-ungated', file: 'sysbuild-plan.js', from: 'if (data.actions.golive === true) part.appendChild', to: 'if (true) part.appendChild', expect: PLAN },
    { id: 'c4-handover-control-restored', file: 'sysbuild-plan.js', from: 'host.appendChild(part);', to: "host.appendChild(part); host.appendChild(A.button('发起交接确认', () => {}));", expect: PLAN },
    { id: 'c8-golive-target', file: 'sysbuild-plan.js', from: "'/batches/' + batch.id + '/golive'", to: "'/batches/' + (batch.id + 999999) + '/golive'", expect: PLAN },
    { id: 'c8-notify-resend-target', file: 'sysbuild-notify.js', from: "'/projects/' + detail.project.id + '/send-intents/resend'", to: "'/projects/' + (detail.project.id + 999999) + '/send-intents/resend'", expect: NOTIFYSCENE },
    { id: 'c8-notice-landing-recipient', file: 'sysbuild-entries.js', from: "['接收人', n.recipient_name]", to: "['接收人', '']", expect: NOTIFYSCENE },
    { id: 'step6-legacy-notice-loses-to-project', file: 'sysbuild-ui.js', from: "params.has('notice') ? 'notice'", to: "params.has('notice') && !params.has('project') ? 'notice'", expect: NOTIFYSCENE },
].map((mutation) => ({ ...mutation, expectFailure: EXPECTED_FAILURES[mutation.id] }));
module.exports = { defineCases, MUTATIONS };
