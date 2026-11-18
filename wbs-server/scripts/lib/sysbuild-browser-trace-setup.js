'use strict';
const assert = require('assert');
const path = require('path');
const MATERIAL = 'L3 立项依据版本与自动选入恢复';
const DECLARATION = 'L3 立项声明清除与全部未保存字段';
const MODAL = 'L3 建档弹窗校验关闭与兼容';
const READONLY = 'L3 立项准备只读与帮助规定';
const REASON = 'L3 立项准备未就绪与提交原因';

function defineCases(T) {
    const { people, api, project, invite, visit, contains, pageFor, options, out, suffix, target } = T;
    async function owner(pid) {
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '立项核对需求方' }, 201)).party.id;
        const joined = await invite(pid, people.owner, party);
        await api(people.owner, 'POST', '/my/invitations/' + joined.invitation.id + '/accept', {});
        const appointed = await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: joined.member.id }, 201);
        await api(people.owner, 'POST', '/my/invitations/' + appointed.invitation.id + '/accept', {});
    }
    const getDraft = async (pid) => {
        const packages = await api(people.pm, 'GET', '/projects/' + pid + '/packages');
        const p = packages.packages.find((item) => item.type === 'initiation');
        return p && p.versions.find((v) => v.status === 'draft');
    };
    async function save(page, name) {
        await page.getByRole('button', { name, exact: true }).click();
        await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
        await page.locator('#sbuiView[aria-busy="false"]').waitFor();
    }
    async function material(page, pid, text, filename) {
        await visit(page, '#project=' + pid + '&tab=setup&step=1');
        await page.locator('[name="body"]').fill(text);
        if (filename) await page.locator('[name="files"]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(text) });
        await save(page, '保存立项依据版本');
    }
    return [
        [MODAL, async (page) => {
            await visit(page, '#new=1');
            const dialog = page.locator('#sbuiDialog');
            await target('l3-modal-open', () => dialog.waitFor({ state: 'visible' }));
            await contains(page, '保存后不可更改，将按此方式带出默认批次与节点。');
            assert.strictEqual(await dialog.locator('[name="goal"]').count(), 0, '[l3-modal-fields] 建档不填建设目标');
            await dialog.getByRole('button', { name: '保存并进入立项准备', exact: true }).click();
            assert.ok(await dialog.locator('[name="system_name"]').evaluate((n) => n.validationMessage), '[l3-modal-required] 系统名称必填');
            await dialog.locator('[name="system_name"]').fill('未保存建档_' + suffix);
            await dialog.getByRole('button', { name: '保存并进入立项准备', exact: true }).click();
            assert.ok(await dialog.locator('[name="build_type"]').evaluate((n) => n.validationMessage), '[l3-modal-required] 建设方式必填');
            await dialog.getByRole('button', { name: '关闭', exact: true }).click();
            await target('l3-modal-dirty', () => dialog.getByRole('button', { name: '继续填写', exact: true }).waitFor());
            assert.strictEqual(await dialog.evaluate((n) => n.open), true, '[l3-modal-dirty] 关闭未保存输入应提示');
            await dialog.getByRole('button', { name: '继续填写', exact: true }).click();
            assert.strictEqual(await dialog.locator('[name="system_name"]').inputValue(), '未保存建档_' + suffix);
            await page.keyboard.press('Escape');
            await target('l3-modal-dirty', () => dialog.getByRole('button', { name: '放弃未保存内容', exact: true }).waitFor());
            await dialog.getByRole('button', { name: '放弃未保存内容', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: '新建项目', exact: true }).click();
            await dialog.locator('[name="system_name"]').fill('弹窗建档_' + suffix);
            await dialog.locator('[name="build_type"]').selectOption('inhouse');
            const box = await dialog.boundingBox();
            assert.ok(Math.abs(box.width - 560) < 2 && Math.abs(box.x - (1440 - box.width) / 2) < 2, '[l3-modal-layout] 建档弹窗宽560且居中');
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-create-modal.png') });
            await dialog.getByRole('button', { name: '保存并进入立项准备', exact: true }).click();
            await target('l3-modal-step1', () => page.locator('[name="body"]').waitFor());
            assert.strictEqual(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('step'), '1', '[l3-modal-step1] 建档成功直接进入第一步');
            assert.strictEqual(await dialog.evaluate((n) => n.open), false);
            const admin = await pageFor(people.admin, options.mutation);
            try {
                await visit(admin.page, '#new=1');
                const form = admin.page.locator('#sbuiDialog');
                await form.locator('[name="system_name"]').fill('管理员代建检查');
                await form.locator('[name="build_type"]').selectOption('inhouse');
                await form.getByRole('button', { name: '保存并进入立项准备', exact: true }).click();
                assert.ok(await form.locator('[name="pm_user_id"]').evaluate((n) => n.validationMessage), '[l3-admin-pm] 管理员代建须选PM');
            } finally { await admin.context.close(); }
        }],
        [MATERIAL, async (page) => {
            const pid = await project('依据恢复_' + suffix);
            await owner(pid);
            await material(page, pid, '只有正文的立项依据尚未具备书面附件');
            await visit(page, '#project=' + pid);
            const panel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '立项准备', exact: true }) });
            assert.ok(!(await panel.innerText()).includes('已准备'), '[l3-basis-text-only] 只有正文不算已准备');
            assert.ok((await panel.getByRole('link', { name: '继续立项准备', exact: true }).getAttribute('href')).includes('step=1'), '[l3-basis-text-only] 应引回第一步');
            await material(page, pid, '新版书面依据的正文', '立项依据第二版.txt');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await target('l3-basis-reload', () => contains(page, '新版书面依据的正文'));
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-setup-step1.png'), fullPage: true });
            const materials = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
            assert.strictEqual(materials.materials.length, 1, '[l3-basis-version] 固定材料只追加版本');
            const versions = materials.materials[0].versions;
            assert.strictEqual(versions.length, 2, '[l3-basis-version] 两次保存产生两版');
            const latest = versions.find((v) => v.version_no === 2);
            await visit(page, '#project=' + pid + '&tab=setup&step=2');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('heading', { name: '成员与授权', exact: true }).waitFor();
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-setup-step2.png'), fullPage: true });
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            let intercepted = 0;
            await page.route('**/api/sysbuild/package-versions/*', async (route) => {
                if (route.request().method() === 'PATCH' && !intercepted++) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试注入的自动选入失败' }) });
                return route.continue();
            });
            await page.getByRole('button', { name: '建立立项草稿', exact: true }).click();
            await target('l3-init-recovery', () => page.getByText(/立项依据未能自动选入/).first().waitFor());
            await page.unroute('**/api/sysbuild/package-versions/*');
            const draft = await getDraft(pid);
            assert.ok(draft, '[l3-init-recovery] 初始化失败保留草稿');
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const otherNode = plan.nodes.find((n) => n.template_key === 'b_dev');
            const otherMaterial = await api(people.pm, 'POST', '/nodes/' + otherNode.id + '/materials/retained-proof/versions', { name: '已选入的其它材料', body: '恢复自动选入时不能覆盖的其它材料' }, 201);
            await api(people.pm, 'PATCH', '/package-versions/' + draft.id, { snapshot_json: { text: '本次固定的G0立项确认内容', material_version_ids: [otherMaterial.version.id], retained_key: '其它快照字段须保留' } });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await Promise.all([
                page.waitForResponse((res) => res.request().method() === 'PATCH' && res.url().endsWith('/package-versions/' + draft.id)),
                page.getByRole('button', { name: '选入最新立项依据', exact: true }).click(),
            ]);
            await page.getByRole('button', { name: '选入最新立项依据', exact: true }).waitFor({ state: 'detached' });
            await page.locator('[name="material_version_ids[]"][value="' + latest.id + '"]').waitFor();
            await target('l3-init-recovery', async () => {
                const saved = await api(people.pm, 'GET', '/package-versions/' + draft.id);
                assert.deepStrictEqual(saved.snapshot_json.material_version_ids, [otherMaterial.version.id, latest.id]);
                assert.strictEqual(saved.snapshot_json.retained_key, '其它快照字段须保留');
                assert.strictEqual((await getDraft(pid)).id, draft.id, '补选不能另建版本');
            });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-setup-step3.png'), fullPage: true });
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await contains(page, '本版已发起，等待必需确认人处理。');
            const tasks = (await api(people.pm, 'GET', '/package-versions/' + draft.id + '/confirm-tasks')).tasks;
            const task = await api(people.owner, 'GET', '/confirm-tasks/' + tasks[0].task_id);
            await api(people.owner, 'POST', '/confirm-tasks/' + tasks[0].task_id + '/decide', { revision_id: task.revision.id, object_version_id: task.task.object_version_id, decision: 'confirm', checkbox_text: task.checkbox_texts.confirm });
            await visit(page, '#project=' + pid);
            assert.strictEqual(await page.getByRole('heading', { name: '立项准备', exact: true }).count(), 0, '[l3-effective-panel] 生效后隐藏准备面板');
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            assert.strictEqual(await page.locator('[name="no_written_basis"]').count(), 0, '[l3-effective-readonly] 生效快照只读');
            await page.getByRole('button', { name: '新建立项草稿版本', exact: true }).click();
            await page.locator('[name="text"]').waitFor();
            const second = await getDraft(pid);
            assert.notStrictEqual(second.id, draft.id);
            assert.deepStrictEqual((await api(people.pm, 'GET', '/package-versions/' + second.id)).snapshot_json.material_version_ids, [otherMaterial.version.id, latest.id], '[l3-default-second] 第二个创建入口也选入最新依据且保留其它选择');
        }],
        [DECLARATION, async (page) => {
            const pid = await project('立项声明_' + suffix);
            await owner(pid);
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            await page.getByRole('button', { name: '建立立项草稿', exact: true }).click();
            await page.locator('[name="text"]').fill('明确保存的立项全文');
            assert.strictEqual(await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).count(), 0, '[l3-submit-gate] 未准备依据不可提交');
            await page.locator('[name="no_written_basis"]').check();
            await page.locator('[name="no_written_basis_reason"]').fill('本次立项来源于线下讨论，目前没有书面原件');
            await save(page, '保存本版立项内容');
            const draft = await getDraft(pid);
            const snapshot = (await api(people.pm, 'GET', '/package-versions/' + draft.id)).snapshot_json;
            assert.strictEqual(snapshot.no_written_basis_reason, '本次立项来源于线下讨论，目前没有书面原件', '[l3-basis-declaration] 声明经页面保存');
            await visit(page, '#project=' + pid);
            await target('l3-declared-panel', () => contains(page, '已声明无书面依据'));
            assert.ok((await page.getByRole('link', { name: '继续立项准备', exact: true }).getAttribute('href')).includes('step=3'), '[l3-declared-panel] 已声明且负责人就绪跳到第三步');
            // 56 号建议：可提交的草稿在面板与第 3 步都不出现不能发起的原因。
            const readyRows = await page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '立项准备', exact: true }) }).locator('tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
            assert.ok(readyRows.includes('3 · 核对 G0 立项确认 草稿 · 可提交'), '[l3-submittable] 可提交草稿面板显示可提交：' + JSON.stringify(readyRows));
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).waitFor();
            assert.strictEqual(await page.getByText(/当前不能发起确认|当前账号不能发起本版确认/).count(), 0, '[l3-submittable] 可提交时第 3 步不显示不能发起的原因');
            let submits = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/package-versions/' + draft.id + '/submit')) submits++; });
            await page.locator('[name="no_written_basis_reason"]').fill('已改但没有保存的另一个无书面依据原因');
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await target('l3-unsaved-reason', () => contains(page, '有未保存的改动，请先保存本版立项内容，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[l3-unsaved-reason] 只改原因也不能发请求');
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const node = plan.nodes.find((n) => n.template_key === 'p_initiation');
            const added = await api(people.pm, 'POST', '/nodes/' + node.id + '/materials/another-basis/versions', { name: '另份立项依据', body: '供核对未保存选入状态的文字材料' }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.locator('[name="material_version_ids[]"][value="' + added.version.id + '"]').check();
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await target('l3-unsaved-material', () => contains(page, '有未保存的改动，请先保存本版立项内容，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[l3-unsaved-material] 只改选入材料也不能发请求');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.locator('[name="no_written_basis"]').uncheck();
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await target('l3-unsaved-checkbox', () => contains(page, '有未保存的改动，请先保存本版立项内容，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[l3-unsaved-checkbox] 只改声明勾选也不能发请求');
            await save(page, '保存本版立项内容');
            const saved = (await api(people.pm, 'GET', '/package-versions/' + draft.id)).snapshot_json;
            assert.strictEqual(Object.prototype.hasOwnProperty.call(saved, 'no_written_basis_reason'), false, '[l3-delete-declaration] 取消后必须删键');
            assert.strictEqual(saved.text, snapshot.text, '[l3-delete-declaration] 保留其它键');
            await page.reload({ waitUntil: 'domcontentloaded' });
            assert.strictEqual(await page.locator('[name="no_written_basis"]').isChecked(), false, '[l3-delete-declaration] 重载后不恢复旧声明');
        }],
        [REASON, async (page) => {
            // 55 号 D1 / LOW-2：需求方未就绪时，面板第 2 步「未完成」并引回第 2 步；草稿不能发起时三处展示服务端原因原文。
            const pid = await project('提交原因_' + suffix);
            await material(page, pid, '已有附件的立项依据正文', '提交原因核对依据.txt');
            await visit(page, '#project=' + pid);
            const panel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '立项准备', exact: true }) });
            await target('l3-panel-step2', async () => {
                const rows = await panel.locator('tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
                assert.ok(rows.includes('2 · 需求方与成员 未完成'), '[l3-panel-step2] 没有需求方负责人时第 2 步为未完成：' + JSON.stringify(rows));
                assert.ok((await panel.getByRole('link', { name: '继续立项准备', exact: true }).getAttribute('href')).includes('step=2'), '[l3-panel-step2] 依据已准备、需求方未就绪时引回第 2 步');
            });
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            await page.getByRole('button', { name: '建立立项草稿', exact: true }).click();
            await page.locator('[name="text"]').waitFor();
            const reason = '当前不能发起确认：项目还没有需求部门参与方，无法确定必需确认人';
            await target('l3-submit-reason', () => contains(page, reason));
            assert.strictEqual(await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).count(), 0, '[l3-submit-reason] 不能发起时不显示发起按钮');
            const draft = await getDraft(pid);
            await visit(page, '#project=' + pid);
            await target('l3-panel-step3', async () => {
                const rows = await panel.locator('tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
                assert.ok(rows.includes('3 · 核对 G0 立项确认 草稿 · 当前不能发起确认：项目还没有需求部门参与方，无法确定必需确认人'), '[l3-panel-step3] 面板第 3 步显示服务端原因：' + JSON.stringify(rows));
            });
            await visit(page, '#project=' + pid + '&tab=packages&version=' + draft.id);
            await target('l3-package-reason', () => contains(page, reason));
        }],
        [READONLY, async (page) => {
            await visit(page, '#new=1');
            await contains(page, '当前账号不能新建项目。');
            assert.strictEqual(await page.locator('#sbuiDialog').evaluate((n) => n.open), false, '[l3-readonly-modal] 无权限不能打开建档');
            const pid = await project('只读立项_' + suffix);
            const inv = await invite(pid, people.readonly);
            await api(people.readonly, 'POST', '/my/invitations/' + inv.invitation.id + '/accept', {});
            for (const step of ['1', '2', '3']) {
                await visit(page, '#project=' + pid + '&tab=setup&step=' + step);
                assert.strictEqual(await page.locator('#sbuiView form').count(), 0, '[l3-readonly-setup] 只读不得编辑第' + step + '步');
            }
            await visit(page, '#help=1');
            await target('l3-help-rules', () => page.getByText(/PM 收到后两个工作日内给出评审结论/).waitFor());
            await contains(page, '六、进入开发前，PM 确定开工日和汇报节奏；开发方按节奏提交进度汇报，PM 可以临时要求汇报。');
            await page.setViewportSize({ width: 390, height: 844 });
            assert.strictEqual(await page.locator('#sysbuildApp').evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
        }, 'readonly'],
    ];
}
const MUTATIONS = [
    { id: 'l3-setup-basis-key', from: "'/materials/initiation-basis/versions'", to: "'/materials/wrong-basis/versions'", expect: MATERIAL, expectFailure: '[l3-basis-reload]' },
    { id: 'l3-setup-default-latest', from: 'ids.push(latest.id);', to: 'void latest.id;', expect: MATERIAL, expectFailure: '[l3-default-second]' },
    { id: 'l3-setup-recovery-preserves', from: 'const ids = Array.from(new Set([...(fresh.snapshot_json.material_version_ids || []), latest.id]));', to: 'const ids = [latest.id];', expect: MATERIAL, expectFailure: '[l3-init-recovery]' },
    { id: 'l3-setup-basis-text-only', from: '&& v.attachments.length > 0', to: '', expect: MATERIAL, expectFailure: '[l3-basis-text-only]' },
    { id: 'l3-setup-effective-panel', from: "if (p && p.versions.some((v) => v.status === 'effective')) return null;", to: 'if (false) return null;', expect: MATERIAL, expectFailure: '[l3-effective-panel]' },
    { id: 'l3-setup-declaration-delete', from: 'else delete snapshot.no_written_basis_reason;', to: 'else void 0;', expect: DECLARATION, expectFailure: '[l3-delete-declaration]' },
    { id: 'l3-setup-unsaved-reason', from: "cause: declared ? String(cause || '').trim() : ''", to: "cause: ''", expect: DECLARATION, expectFailure: '[l3-unsaved-reason]' },
    { id: 'l3-setup-unsaved-material', from: 'ids: Array.from(new Set(ids.map(Number))).sort((a, b) => a - b)', to: 'ids: []', expect: DECLARATION, expectFailure: '[l3-unsaved-material]' },
    { id: 'l3-setup-declared-progress', from: "const step = !prepared && !declared ? 1 : !ready ? 2 : 3;", to: 'const step = !prepared ? 1 : !ready ? 2 : 3;', expect: DECLARATION, expectFailure: '[l3-declared-panel]' },
].map((m) => ({ ...m, file: 'sysbuild-page.js' }));
MUTATIONS.push(
    { id: 'l3-modal-unsaved-close', file: 'sysbuild-ui.js', from: 'if (currentForm && currentForm.sbuiCanClose && currentForm.sbuiCanClose() !== true) return;', to: 'void currentForm;', expect: MODAL, expectFailure: '[l3-modal-dirty]' },
    { id: 'l3-modal-first-step', file: 'sysbuild-page.js', from: "project: result.project.id, tab: 'setup', step: '1'", to: "project: result.project.id, tab: 'setup', step: '2'", expect: MODAL, expectFailure: '[l3-modal-step1]' },
    { id: 'l3-modal-admin-pm', file: 'sysbuild-page.js', from: "name: 'pm_user_id', label: '项目负责人（PM）', required: true", to: "name: 'pm_user_id', label: '项目负责人（PM）', required: false", expect: MODAL, expectFailure: '[l3-admin-pm]' },
    { id: 'l3-setup-readonly-material', file: 'sysbuild-page.js', from: 'const allowed = material ? material.actions.new_version === true : source && source.actions.create_version === true;', to: 'const allowed = true;', expect: READONLY, expectFailure: '[l3-readonly-setup]' },
    // 55 号 D1 / LOW-2
    { id: 'l3-prep-step2-ready', file: 'sysbuild-page.js', from: 'const ready = demands.length > 0 && demands.every((party) => !!party.owner);', to: 'const ready = true;', expect: REASON, expectFailure: '[l3-panel-step2]' },
    { id: 'l3-prep-step3-reason', file: 'sysbuild-page.js', from: "version.actions.submit === true ? '草稿 · 可提交' : '草稿 · ' + submitBlockText(version)", to: "'草稿 · 可提交'", expect: REASON, expectFailure: '[l3-panel-step3]' },
    { id: 'l3-setup-submit-reason', file: 'sysbuild-page.js', from: "version.status === 'draft' ? submitBlockText(v) :", to: "version.status === 'draft' ? '当前不能发起确认。' :", expect: REASON, expectFailure: '[l3-submit-reason]' },
    { id: 'l3-prep-step3-submittable', file: 'sysbuild-page.js', from: "version.actions.submit === true ? '草稿 · 可提交'", to: "false ? '草稿 · 可提交'", expect: DECLARATION, expectFailure: '[l3-submittable]' },
    { id: 'l3-package-submit-reason', file: 'sysbuild-packages.js', from: "controls.appendChild(A.hint('当前不能发起确认：' + data.submit_block.message));", to: 'void 0;', expect: REASON, expectFailure: '[l3-package-reason]' },
    { id: 'l3-help-review-deadline', file: 'sysbuild-page.js', from: 'PM 收到后两个工作日内给出评审结论。', to: 'PM 稍后给出评审结论。', expect: READONLY, expectFailure: '[l3-help-rules]' }
);
module.exports = { defineCases, MUTATIONS };
