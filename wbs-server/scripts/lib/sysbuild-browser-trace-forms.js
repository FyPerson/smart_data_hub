'use strict';
// L3 五种结构化登记、汇报事实与上线凭据；浏览器动作验证公开接口实际保存的结果。
const assert = require('assert');
const path = require('path');
const REQUEST = 'L3 汇报表单与勘误及补交材料';
const REPORT = 'L3 节奏临时要求与进度汇报';
const WARNINGS = 'L3 汇报不可读与无收件人提示';
const GOLIVE = 'L3 上线与撤销附件';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const png = (name) => ({ name: name || 'trace-proof.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });

function defineCases(T) {
    const { people, api, project, assignParty, pageFor, visit, contains, options, out, suffix, target, declareViaCard, preparePairVersion, savePackageDraft } = T;
    const dialog = (page) => page.locator('#sbuiDialog');
    async function screenshot(page, name) {
        await page.evaluate(() => new Promise((resolve) => { window.scrollTo(0, 0); requestAnimationFrame(() => resolve()); }));
        await page.screenshot({ path: path.join(out, name), fullPage: true });
    }
    async function settled(page) { await dialog(page).waitFor({ state: 'hidden' }); await page.locator('#sbuiView[aria-busy="false"]').waitFor(); }
    async function showReportDetails(page) {
        const details = page.locator('.sbui-report-details');
        await details.waitFor();
        if (await details.getAttribute('open') === null) await details.locator('summary').click();
    }
    async function ownerFor(pid, side, person) {
        const party = await assignParty(pid, side, side === 'dev' ? '浏览器开发方' : '浏览器需求方', person, side === 'demand' ? people.delegate : null);
        return { party: party.id, member: party.owner.member_id };
    }
    async function confirmVersion(pid, vid) {
        const detail = await api(people.pm, 'GET', '/projects/' + pid);
        for (const task of (await api(people.pm, 'GET', '/package-versions/' + vid + '/confirm-tasks')).tasks) {
            const member = detail.members.find((m) => m.id === task.current_revision.required_member_id);
            const person = Object.values(people).find((p) => p.id === member.user_id);
            const opened = await api(person, 'GET', '/confirm-tasks/' + task.task_id);
            await api(person, 'POST', '/confirm-tasks/' + task.task_id + '/decide', { revision_id: opened.revision.id, object_version_id: opened.task.object_version_id, decision: 'confirm', checkbox_text: opened.checkbox_texts.confirm });
        }
    }
    async function overall(page) {
        const pid = await project('L3完整前置_' + suffix);
        await ownerFor(pid, 'demand', people.owner);
        const pk = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
        await declareViaCard(page, pid, '线下会议已经讨论明确立项范围，目前尚无书面原件');
        await visit(page, '#project=' + pid + '&tab=packages&version=' + vid);
        const text = '通过真实界面登记本次立项确认内容';
        await page.locator('[name="text"]').fill(text);
        await savePackageDraft(page, vid, text);
        await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
        await page.getByRole('heading', { name: '立项与授权 v1 · 待确认', exact: true }).waitFor();
        await confirmVersion(pid, vid);
        const date = (await api(people.pm, 'GET', '/projects/' + pid)).project.created_at.slice(0, 10);
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        for (const node of plan.nodes) await api(people.pm, 'POST', '/nodes/' + node.id + '/schedule', { kind: 'plan', planned_start: date, planned_end: date }, 201);
        const op = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'overall' }, 201)).package.id;
        const ov = (await api(people.pm, 'POST', '/packages/' + op + '/versions', {}, 201)).version.id;
        await preparePairVersion(pid, ov, 'overall');
        await api(people.pm, 'POST', '/package-versions/' + ov + '/submit', {}); await confirmVersion(pid, ov);
        return { pid, date, batch: plan.batches[0].id, nodes: plan.nodes };
    }
    // devPerson：开发方负责人。待办页（#todo=report_due）不按项目过滤，同一账号在别的项目里有当天应交汇报与勘误时会混进本场景的待办断言（[trace-todo-source-correction] 的「勘误说明」标题会匹配到两个），
    //   所以「汇报表单与勘误及补交材料」场景用 people.outsider 当开发方负责人，不占用 REPORT 场景断言待办的 people.member。
    async function reportScene(withOwner, devPerson) {
        const pid = await project('L3汇报_' + suffix);
        const dev = withOwner ? await ownerFor(pid, 'dev', devPerson || people.member) : null;
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'b_dev');
        const date = (await api(people.pm, 'GET', '/projects/' + pid)).project.created_at.slice(0, 10);
        return { pid, dev, node, date };
    }
    async function cycleAndStart(page, s) {
        await api(people.pm, 'POST', '/nodes/' + s.node.id + '/schedule', { kind: 'plan', planned_start: s.date, planned_end: s.date }, 201);
        await visit(page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
        await page.getByRole('button', { name: '设定汇报节奏', exact: true }).click();
        await dialog(page).locator('[name="first_due_on"]').fill(s.date);
        await dialog(page).locator('[name="note"]').fill('按既定节奏提交开发进度与风险');
        await dialog(page).getByRole('button', { name: '保存汇报节奏', exact: true }).click();
        await target('trace-cycle', async () => { await settled(page); await showReportDetails(page); await contains(page, '按既定节奏提交开发进度与风险'); });
        const entries = await api(people.pm, 'GET', '/projects/' + s.pid + '/entries');
        const saved = entries.entries.find((e) => e.form_kind === 'report_cycle');
        assert.deepStrictEqual(saved.form, { kind: 'report_cycle', cycle: 'weekly', first_due_on: s.date, note: '按既定节奏提交开发进度与风险' }, '[trace-cycle] 节奏字段逐项保存');
        await page.getByRole('button', { name: '开始阶段', exact: true }).click();
        await dialog(page).getByRole('button', { name: '确认开始', exact: true }).click();
        await page.getByRole('heading', { name: s.node.name + ' · 进行中', exact: true }).waitFor();
    }
    return [
        [REQUEST, async (page) => {
            // C5：需求变更申请与开发评估表单已删，本场景保留与它们无关的行为——勘误（载体改用临时汇报要求登记）、补交材料（载体改用通用登记）、
            //   登记页无「需求变更申请」入口、进度汇报带附件保存（普通汇报：不影响里程碑，附件落库并显示上传文件名；另有一条影响里程碑汇报：开发方负责人勾认可声明、带凭据保存）。
            const s = await reportScene(true, people.outsider);
            await api(people.pm, 'POST', '/nodes/' + s.node.id + '/schedule', { kind: 'plan', planned_start: s.date, planned_end: s.date }, 201);
            await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { node_id: s.node.id, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: s.date, note: '按既定节奏提交开发进度与风险' } }, 201);
            await api(people.pm, 'POST', '/nodes/' + s.node.id + '/start', {});
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
            await page.getByRole('button', { name: '登记临时汇报要求', exact: true }).click();
            const d = dialog(page);
            await d.locator('[name="due_on"]').waitFor();
            await target('trace-generated-text', async () => { assert.strictEqual(await d.locator('[name="title"], [name="body"]').count(), 0, '[trace-generated-text] 表单不让用户另填标题正文'); });
            await d.locator('[name="due_on"]').fill(s.date);
            await d.locator('[name="reason"]').fill('请补充当天风险的处理进度与下一步安排');
            // 保存时捕获该项目登记 POST 的请求体：共享提交代码即使悄悄多发 title / body / commitment_flag，页面上没有对应输入项的断言发现不了
            const registerBodies = [];
            const onRequest = (r) => { if (r.method() === 'POST' && new RegExp('/api/sysbuild/projects/' + s.pid + '/entries$').test(new URL(r.url()).pathname)) registerBodies.push(r.postData()); };
            page.on('request', onRequest);
            try {
                await d.getByRole('button', { name: '保存临时汇报要求', exact: true }).click();
                await settled(page);
            } finally { page.off('request', onRequest); }
            await target('trace-generated-text', async () => {
                assert.strictEqual(registerBodies.length, 1, '[trace-generated-text] 保存只发一次登记 POST，实际 ' + registerBodies.length);
                const sent = JSON.parse(registerBodies[0]);
                for (const key of ['title', 'body', 'commitment_flag']) assert.strictEqual(Object.prototype.hasOwnProperty.call(sent, key), false, '[trace-generated-text] 登记请求体不得带 ' + key + '（实际键 ' + Object.keys(sent).join(' / ') + '）');
            });
            const request = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'report_request');
            await visit(page, '#project=' + s.pid + '&tab=entries&entry=' + request.id);
            await page.getByRole('button', { name: '追加更正', exact: true }).click();
            await dialog(page).locator('[name="text"]').fill('勘误：临时汇报要求中的风险范围按最新核对清单理解');
            await dialog(page).getByRole('button', { name: '追加更正', exact: true }).click();
            await target('trace-correction', async () => { await settled(page); await page.getByRole('heading', { name: '勘误说明', exact: true }).waitFor(); });
            // C6（变异 B3）：登记详情已渲染（B3 的按钮追加在「附件与原始凭据」面板之后，等到该面板标题即详情已画完）后核对「对已有结论提异议」按钮已删
            await page.getByRole('heading', { name: '附件与原始凭据', exact: true }).waitFor();
            await target('c6-object-button-retired', async () => { assert.strictEqual(await page.getByRole('button', { name: '对已有结论提异议', exact: true }).count(), 0, '[c6-object-button-retired] 登记详情不再有对已有结论提异议按钮'); });
            // C6（清单 8.2，CA5c 反向核对 browser-stage8:291；CA5f M-1）：办理类登记（意见与反馈，无归属，旧版 route 为 pending）的详情页没有「给出办理结论」「对已有结论提异议」「判定归属」按钮
            //   （「判定归属」只在登记详情的办理面板里渲染，列表页的卡片只有「打开登记」链接，所以断言放在详情页，不放列表页）；等详情渲染完再断言「不存在」
            const plainFeedback = (await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { type: 'feedback', title: '不再有办理结论入口的意见', body: '办理类登记详情页不再出现办理结论与异议入口', no_written_evidence: true, no_evidence_reason: '线下会议提出，尚无书面原件' }, 201)).entry;
            await visit(page, '#project=' + s.pid + '&tab=entries&entry=' + plainFeedback.id);
            await page.getByRole('heading', { name: '附件与原始凭据', exact: true }).waitFor();
            await target('c6-conclusion-buttons-retired', async () => {
                for (const name of ['给出办理结论', '对已有结论提异议', '判定归属']) assert.strictEqual(await page.getByRole('button', { name, exact: true }).count(), 0, '[c6-conclusion-buttons-retired] 办理类登记详情不再有「' + name + '」');
            });
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + request.id)).entry.form.reason, '请补充当天风险的处理进度与下一步安排', '勘误不得改写临时要求的原字段');
            // 补交材料（C6）：办理结论入口随 S4 删（原借「给出办理结论 → 先补交材料」入口，及其冻结清单说明 [trace-material-scope]），
            //   改为通用登记弹窗：登记页点「追加登记」、类型选补交材料、选附件保存，材料作为独立登记保留、附件 1 个（目标 [trace-supplement] 保留）。
            //   （清单 4.2 写的「登记补交材料」独立入口按钮前端没有，用通用「追加登记」弹窗代替，差异记入回报。）
            await visit(page, '#project=' + s.pid + '&tab=entries');
            await page.getByRole('button', { name: '追加登记', exact: true }).click();
            const rd = dialog(page);
            await rd.locator('[name="type"]').selectOption('material');
            await rd.locator('[name="source_party"]').selectOption('self');
            await rd.locator('[name="title"]').fill('结论处理材料索引');
            await rd.locator('[name="body"]').fill('供PM明确引用的补交材料');
            await rd.locator('[name="files"]').setInputFiles(png());
            await rd.getByRole('button', { name: '保存登记', exact: true }).click();
            await target('trace-supplement', async () => {
                await settled(page);
                const material = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.type === 'material');
                assert.ok(material, '[trace-supplement] 补交材料登记已保存');
                assert.strictEqual((await api(people.pm, 'GET', '/entries/' + material.id)).entry.attachments.length, 1, '[trace-supplement] 材料作为独立登记保留');
            });
            await screenshot(page, 'l3-entry-correction-material.png');
            // 登记页没有「需求变更申请」入口（C5 删除）
            await visit(page, '#project=' + s.pid + '&tab=entries');
            await page.getByRole('heading', { name: '登记与办理', exact: true }).waitFor();
            await target('trace-form-retired', async () => { assert.strictEqual(await page.getByRole('button', { name: '需求变更申请', exact: true }).count(), 0, '[trace-form-retired] 登记页不再有需求变更申请入口'); });
            // 只读账号不显示结构化登记入口：只读样本与可写对照取同一业务身份（本项目开发方负责人）与同一节点条件（有计划、有汇报节奏、进行中），
            //   差别只在账号是否只读——这样即便只读能力判断失效，样本也不会因为「不是 PM / 不是开发方负责人」而碰巧看不到按钮。先断言可写对照显示按钮，再断言只读样本隐藏。
            //   （「登记临时汇报要求」只给 PM，而只读账号做 PM 只能在 API 套件里改库造，浏览器场景走不到；所以入口取开发方负责人也有的「提交进度汇报」，同一身份下比较可写与只读。）
            const roScene = await reportScene(true, people.readonly);
            await api(people.pm, 'POST', '/nodes/' + roScene.node.id + '/schedule', { kind: 'plan', planned_start: roScene.date, planned_end: roScene.date }, 201);
            await api(people.pm, 'POST', '/projects/' + roScene.pid + '/entries', { node_id: roScene.node.id, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: roScene.date, note: '按既定节奏提交开发进度与风险' } }, 201);
            await api(people.pm, 'POST', '/nodes/' + roScene.node.id + '/start', {});
            // 152-M2：「同一业务身份」是被断言的前提——两侧项目各读一次项目详情，断言被测账号就是该项目开发方现任负责人（成员行已加入），再比较按钮
            for (const [sideName, sidePid, sideUser] of [['只读侧', roScene.pid, people.readonly], ['可写对照侧', s.pid, people.outsider]]) {
                const detail = await api(people.pm, 'GET', '/projects/' + sidePid);
                const devParty = (detail.parties || []).find((p) => p.side === 'dev');
                assert.ok(devParty && devParty.owner, '[trace-form-capability] 项目 ' + sidePid + '（' + sideName + '）：没有开发方现任负责人');
                const ownerMember = (detail.members || []).find((m) => m.id === devParty.owner.member_id);
                assert.ok(ownerMember, '[trace-form-capability] 项目 ' + sidePid + '（' + sideName + '）：成员列表里找不到现任负责人');
                assert.strictEqual(ownerMember.user_id, sideUser.id, '[trace-form-capability] 项目 ' + sidePid + '（' + sideName + '）：账号不是开发方现任负责人');
                assert.strictEqual(ownerMember.status, 'joined', '[trace-form-capability] 项目 ' + sidePid + '（' + sideName + '）：现任负责人成员行未处于已加入');
            }
            const writable = await pageFor(people.outsider, options.mutation);
            try {
                await visit(writable.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                await writable.page.getByRole('heading', { name: '进度汇报', exact: true }).waitFor();
                assert.strictEqual(await writable.page.getByRole('button', { name: '提交进度汇报', exact: true }).count(), 1, '[trace-form-capability] 可写对照（开发方负责人）显示「提交进度汇报」入口');
            } finally { await writable.context.close(); }
            const readonly = await pageFor(people.readonly, options.mutation);
            try {
                await visit(readonly.page, '#project=' + roScene.pid + '&tab=plan&node=' + roScene.node.id);
                await readonly.page.getByRole('heading', { name: '进度汇报', exact: true }).waitFor();
                assert.strictEqual(await readonly.page.getByRole('button', { name: '提交进度汇报', exact: true }).count(), 0, '[trace-form-capability] 只读账号（同为开发方负责人）不显示结构化登记入口');
            } finally { await readonly.context.close(); }
            // 进度汇报带附件保存，附件落库 1 个且页面显示上传文件名（原评估场景里独立于评估的附件绑定）。
            //   载体用「不勾影响里程碑」的进度汇报：影响里程碑的汇报缺证据会被服务端拒绝、对话框关不掉，绑定失效时首个失败会落在对话框关闭超时而不是附件数断言；
            //   普通汇报没有附件也能保存，所以绑定失效时对话框照常关闭，失败落在下面的附件数断言上
            const owner = await pageFor(people.outsider, options.mutation);
            try {
                await visit(owner.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                await owner.page.getByRole('button', { name: '提交进度汇报', exact: true }).click();
                const od = dialog(owner.page);
                await od.locator('[name="done"]').fill('开发负责人核对并补充当天完成事项与凭据');
                await od.locator('[name="next"]').fill('开发负责人安排后续联调与边界检查工作');
                assert.strictEqual(await od.locator('[name="milestone_impact"]').isChecked(), false, '前置：本载体不影响里程碑');
                await od.locator('[name="files"]').setInputFiles(png('汇报凭据.png'));
                await od.getByRole('button', { name: '保存进度汇报', exact: true }).click();
                let savedId = null;
                await target('trace-form-attachment', async () => {
                    await settled(owner.page);
                    const saved = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'progress_report');
                    savedId = saved.id;
                    assert.strictEqual((await api(people.pm, 'GET', '/entries/' + saved.id)).entry.attachments.length, 1, '[trace-form-attachment] 表单 helper 须把已选凭据绑定到登记');
                });
                await target('trace-form-attachment-name', async () => {
                    await visit(owner.page, '#project=' + s.pid + '&tab=entries&entry=' + savedId);
                    await contains(owner.page, '汇报凭据.png');
                });
                // 影响里程碑的汇报（C6 R6 / 152-L2）：开发方负责人勾「影响里程碑」、带凭据保存——本段整体重写（原本人确认控件 self_ack 与 self_confirm_text 随 R6 删），
                //   打开表单、勾影响里程碑、选附件、点保存整段放进同一个 target('trace-milestone-save', …)（附件数断言仍在前，附件绑定失效时首个失败仍落在附件数断言）；
                //   请求体断言改为「不带 self_confirm_text、commitment_flag」，落库断言改为「影响里程碑为真、附件 1 个、无认可任务」（读出没有 dev_confirm 键）。
                await visit(owner.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                await owner.page.getByRole('button', { name: '提交进度汇报', exact: true }).click();
                const impactBodies = [];
                const onImpactRequest = (r) => { if (r.method() === 'POST' && new RegExp('/api/sysbuild/projects/' + s.pid + '/entries$').test(new URL(r.url()).pathname)) impactBodies.push(r.postData()); };
                owner.page.on('request', onImpactRequest);
                try {
                    await target('trace-milestone-save', async () => {
                        const md = dialog(owner.page);
                        await md.locator('[name="done"]').fill('开发负责人确认本期工作将影响里程碑并附上凭据');
                        await md.locator('[name="next"]').fill('开发负责人申请项目经理评估并安排改期事项');
                        await md.locator('[name="milestone_impact"]').check();
                        await md.locator('[name="files"]').setInputFiles(png('里程碑影响凭据.png'));
                        await md.getByRole('button', { name: '保存进度汇报', exact: true }).click();
                        await settled(owner.page);
                        assert.strictEqual(impactBodies.length, 1, '[trace-milestone-save] 保存只发一次登记 POST，实际 ' + impactBodies.length);
                        const sent = JSON.parse(impactBodies[0]);
                        for (const key of ['self_confirm_text', 'commitment_flag']) assert.strictEqual(Object.prototype.hasOwnProperty.call(sent, key), false, '[trace-milestone-save] 登记请求体不得带 ' + key + '（实际键 ' + Object.keys(sent).join(' / ') + '）');
                        const impact = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'progress_report' && e.id !== savedId);
                        assert.ok(impact, '[trace-milestone-save] 第二条汇报已保存');
                        const detail = (await api(people.pm, 'GET', '/entries/' + impact.id)).entry;
                        assert.strictEqual(detail.form.milestone_impact, true, '[trace-milestone-save] 登记为影响里程碑');
                        assert.strictEqual(detail.attachments.length, 1, '[trace-milestone-save] 凭据附件 1 个');
                        assert.ok(!('dev_confirm' in detail), '[trace-milestone-save] 没有认可任务（读出无 dev_confirm 键）');
                    });
                } finally { owner.page.off('request', onImpactRequest); }
            } finally { await owner.context.close(); }
        }],
        [REPORT, async (page) => {
            const s = await reportScene(true);
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
            await page.getByRole('button', { name: '开始阶段', exact: true }).click();
            await target('trace-start-reason', () => contains(page, '范围尚未确认。可补充开工说明及沟通记录。'));
            await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
            await cycleAndStart(page, s);
            const summary = page.locator('.sbui-report-summary');
            await target('step6-report-period', async () => {
                await summary.getByText('登记周期：每周', { exact: true }).waitFor();
                await summary.getByText('本期应交 ' + s.date + ' · 今天应交', { exact: true }).waitFor();
            });
            await page.getByRole('button', { name: '登记临时汇报要求', exact: true }).click();
            await dialog(page).locator('[name="due_on"]').fill(s.date);
            await dialog(page).locator('[name="reason"]').fill('请补充当天风险的处理进度与下一步安排');
            await dialog(page).getByRole('button', { name: '保存临时汇报要求', exact: true }).click();
            await target('trace-request-due', async () => { await settled(page); await contains(page, '请补充当天风险的处理进度与下一步安排'); });
            const request = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((entry) => entry.form_kind === 'report_request');
            await api(people.pm, 'POST', '/entries/' + request.id + '/actions', { action: 'correct', text: '勘误：本次临时要求中的风险范围按最新核对清单理解' }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await showReportDetails(page);
            const sourceRow = page.locator('.sbui-report-source').filter({ has: page.getByRole('link', { name: '临时要求 #' + request.id, exact: true }) });
            await target('trace-source-correction', async () => {
                await sourceRow.getByText('请补充当天风险的处理进度与下一步安排', { exact: true }).waitFor();
                await sourceRow.getByRole('heading', { name: '勘误说明', exact: true }).waitFor();
                await sourceRow.getByText('勘误：本次临时要求中的风险范围按最新核对清单理解', { exact: true }).waitFor();
                const original = (await api(people.pm, 'GET', '/entries/' + request.id)).entry;
                assert.strictEqual(original.form.reason, '请补充当天风险的处理进度与下一步安排', '勘误不得改写临时要求的原字段');
            });
            const recipient = await pageFor(people.member, options.mutation);
            try {
                await visit(recipient.page, '#todo=report_due');
                const duePanel = recipient.page.locator('section.sbui-panel').filter({ has: recipient.page.getByRole('heading', { name: /^应交进度汇报 · / }) });
                await target('trace-todo-source-correction', async () => {
                    await duePanel.getByText('请补充当天风险的处理进度与下一步安排', { exact: false }).first().waitFor();
                    await duePanel.getByRole('heading', { name: '勘误说明', exact: true }).waitFor();
                    await duePanel.getByText('勘误：本次临时要求中的风险范围按最新核对清单理解', { exact: true }).waitFor();
                });
                // 55 号 LOW-2：入口按元数据 allowed 显示——开发方只见提交汇报，不见 PM 的节奏与临时要求入口。
                await visit(recipient.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                const devPanel = recipient.page.locator('section.sbui-panel').filter({ has: recipient.page.getByRole('heading', { name: '进度汇报', exact: true }) });
                await devPanel.getByRole('button', { name: '提交进度汇报', exact: true }).first().waitFor();
                assert.strictEqual(await devPanel.getByRole('button', { name: /^(设定汇报节奏|登记临时汇报要求)$/ }).count(), 0, '[trace-dev-entry-capability] 开发方不显示 PM 的节奏与临时要求入口');
            } finally { await recipient.context.close(); }
            // 55 号 LOW-1：节奏出现在多个应交日，勘误只在「当前汇报节奏」整段显示一次，各行只给标记（放在待办检查之后，不改变待办的勘误数量）。
            const cycleEntry = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((entry) => entry.form_kind === 'report_cycle');
            const cycleText = '勘误：节奏说明以本条为准，原周期字段不变';
            await api(people.pm, 'POST', '/entries/' + cycleEntry.id + '/actions', { action: 'correct', text: cycleText }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await showReportDetails(page);
            const reportPanelLocator = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '进度汇报', exact: true }) }).last();
            await target('trace-correction-once', async () => {
                await reportPanelLocator.getByText(cycleText, { exact: true }).first().waitFor();
                const cycleRows = reportPanelLocator.locator('.sbui-report-source').filter({ has: page.getByRole('link', { name: '周期要求 #' + cycleEntry.id, exact: true }) });
                const rows = await cycleRows.count();
                assert.ok(rows >= 2, '[trace-correction-once] 夹具应让节奏出现在至少两个应交日，实际 ' + rows);
                assert.strictEqual(await reportPanelLocator.getByText(cycleText, { exact: true }).count(), 1, '[trace-correction-once] 同一来源的勘误整段只显示一次');
                assert.strictEqual(await cycleRows.getByText('有勘误说明，见上方登记 #' + cycleEntry.id + ' 处。', { exact: true }).count(), rows, '[trace-correction-once] 每个节奏来源行都给标记');
            });
            // 57 号 MEDIUM：节奏面板（/plan）读到的是较旧快照、来源列表（/entries）多一条勘误时，新勘误仍须恰好显示一次。
            const cycleText2 = '勘误：两次读取之间追加的节奏勘误';
            await api(people.pm, 'POST', '/entries/' + cycleEntry.id + '/actions', { action: 'correct', text: cycleText2 }, 201);
            const planRoute = '**/api/sysbuild/projects/' + s.pid + '/plan';
            await page.route(planRoute, async (route) => {
                const response = await route.fetch();
                const json = await response.json();
                for (const n of json.nodes || []) if (n.report && n.report.current_cycle) n.report.current_cycle.corrections = (n.report.current_cycle.corrections || []).filter((r) => r.text !== cycleText2);
                await route.fulfill({ response, json });
            });
            try {
                await page.reload({ waitUntil: 'domcontentloaded' });
                await showReportDetails(page);
                await target('trace-correction-merge', async () => {
                    await reportPanelLocator.getByText(cycleText, { exact: true }).first().waitFor();
                    assert.strictEqual(await reportPanelLocator.getByText(cycleText2, { exact: true }).count(), 1, '[trace-correction-merge] 节奏面板缺的新勘误由来源行补显示且只显示一次');
                    assert.strictEqual(await reportPanelLocator.getByText(cycleText, { exact: true }).count(), 1, '[trace-correction-merge] 已在节奏面板显示的勘误不在来源行重复');
                });
            } finally { await page.unroute(planRoute); }
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('button', { name: '提交进度汇报', exact: true }).click();
            await dialog(page).locator('[name="due_on"]').selectOption(s.date);
            await dialog(page).locator('[name="done"]').fill('已经完成部门汇总接口并核对数据样例');
            await dialog(page).locator('[name="next"]').fill('下一步完成前端页面联调与业务验收');
            await dialog(page).locator('[name="risks"]').fill('业务样例仍需补齐边界情况');
            await dialog(page).locator('[name="milestone_impact"]').check();
            await dialog(page).locator('[name="no_written_evidence"]').check();
            await dialog(page).locator('[name="no_evidence_reason"]').fill('与开发负责人线下沟通的调整尚无独立书面原件');
            await dialog(page).getByRole('button', { name: '保存进度汇报', exact: true }).click();
            await target('trace-report', async () => { await settled(page); await showReportDetails(page); await contains(page, '已经完成部门汇总接口并核对数据样例'); });
            const saved = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'progress_report');
            assert.deepStrictEqual([saved.form.due_on, saved.form.done, saved.form.next, saved.form.milestone_impact], [s.date, '已经完成部门汇总接口并核对数据样例', '下一步完成前端页面联调与业务验收', true], '[trace-report] 汇报字段实际保存');
            await target('trace-milestone-warning', () => contains(page, '本次汇报影响里程碑，请 PM 评估是否发起改期'));
            const due = (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.find((n) => n.id === s.node.id).report.due_items[0];
            assert.deepStrictEqual([due.submitted, due.sources.length, due.report_entry_ids], [true, 2, [saved.id]]);
            await target('step6-report-delivered', () => summary.getByText('已交 1 期', { exact: true }).waitFor());
            await target('trace-submitted-view', () => contains(page, '已交'));
            await screenshot(page, 'l3-report-panel.png');
            const owner = await pageFor(people.member, options.mutation);
            try {
                await visit(owner.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                await owner.page.getByRole('button', { name: '提交进度汇报', exact: true }).click();
                await dialog(owner.page).locator('[name="done"]').fill('开发负责人亲自核对并补充当天完成事项');
                await dialog(owner.page).locator('[name="next"]').fill('开发负责人安排后续联调与边界检查工作');
                await dialog(owner.page).locator('[name="milestone_impact"]').check();
                // C6（R6）：本人确认控件随 R6 删，勾「影响里程碑」后表单联动（无书面证据声明显示）执行完，该控件不存在；整段写进同一个 target，
                //   先等联动完成再断言 count() === 0（不在联动完成前取 count，防止读到零而放回控件的变异 B1 存活）；取消勾选那一步的「不可见」断言随控件删去
                await target('trace-self-ack-retired', async () => {
                    await dialog(owner.page).locator('[name="no_written_evidence"]').waitFor({ state: 'visible' });
                    assert.strictEqual(await dialog(owner.page).locator('[name="self_ack"]').count(), 0, '[trace-self-ack-retired] 本人确认控件已删除');
                });
            } finally { await owner.context.close(); }
        }],
        [WARNINGS, async (page) => {
            const s = await reportScene(false); await cycleAndStart(page, s);
            await page.getByRole('button', { name: '登记临时汇报要求', exact: true }).click();
            await dialog(page).locator('[name="due_on"]').fill(s.date);
            await dialog(page).locator('[name="reason"]').fill('开发方尚未加入平台，需要线下提醒本次汇报');
            await dialog(page).getByRole('button', { name: '保存临时汇报要求', exact: true }).click();
            await target('trace-no-recipient', async () => { await settled(page); await contains(page, '开发方没有可接收待办的人，请线下通知'); });
            const pattern = '**/api/sysbuild/projects/' + s.pid + '/plan';
            await page.route(pattern, async (route) => {
                const response = await route.fetch(); const data = await response.json(); const node = data.nodes.find((n) => n.id === s.node.id);
                node.report.current_cycle = null; node.report.warning = '节奏登记无法读取'; node.report.unreadable_request_ids = [901]; node.report.unreadable_report_ids = [902];
                node.report.unreadable_entry_ids = [901, 902]; node.report.due_items = [{ due_on: '2001-01-01', sources: [{ kind: 'request', entry_id: 901, reason: '独立提示样本' }], submitted: false, report_entry_ids: [], overdue: true }];
                await route.fulfill({ response, json: data });
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await showReportDetails(page);
            await target('trace-unreadable', async () => { await contains(page, '节奏登记无法读取'); await contains(page, '无法读取的临时汇报要求'); await page.getByRole('link', { name: '登记 #901', exact: true }).first().waitFor(); await contains(page, '无法读取的进度汇报'); await page.getByRole('link', { name: '登记 #902', exact: true }).first().waitFor(); });
            await target('trace-overdue', () => contains(page, '逾期未交'));
            await target('step6-report-red', () => page.locator('.sbui-report-summary .sbui-report-late').filter({ hasText: /^逾期 1 期$/ }).waitFor());
            await page.unroute(pattern);
            await page.route(pattern, async (route) => {
                const response = await route.fetch();
                const data = await response.json();
                const node = data.nodes.find((item) => item.id === s.node.id);
                node.status = 'not_started';
                node.report.current_cycle = null;
                node.report.default_cycle = { cycle: 'biweekly', first_due_on: s.date };
                node.report.warning = null;
                await route.fulfill({ response, json: data });
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await target('step6-report-existing-default', async () => {
                const summary = page.locator('.sbui-report-summary');
                await summary.getByText('默认周期：每两周，首次应交 ' + s.date, { exact: true }).waitFor();
                assert.strictEqual(await summary.getByText('当前没有汇报节奏。', { exact: true }).count(), 0);
            });
            await page.unroute(pattern);
        }],
        [GOLIVE, async (page) => {
            const s = await overall(page);
            const pk = (await api(people.pm, 'POST', '/projects/' + s.pid + '/packages', { type: 'batch_accept', batch_id: s.batch }, 201)).package.id;
            const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
            await preparePairVersion(s.pid, vid, 'batch_accept');
            await api(people.pm, 'POST', '/package-versions/' + vid + '/submit', {}); await confirmVersion(s.pid, vid);
            for (const n of (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.filter((n) => n.batch_id === s.batch && !n.is_golive_milestone)) {
                if (n.template_key === 'b_dev') await api(people.pm, 'POST', '/projects/' + s.pid + '/entries', { node_id: n.id, form: { kind: 'report_cycle', cycle: 'weekly', first_due_on: s.date } }, 201);
                await api(people.pm, 'POST', '/nodes/' + n.id + '/start', {}); await api(people.pm, 'POST', '/nodes/' + n.id + '/close', {});
            }
            await visit(page, '#project=' + s.pid + '&tab=handover');
            await page.getByRole('button', { name: '确认试运行结束并正式上线', exact: true }).click();
            await dialog(page).locator('[name="checked"]').check(); await dialog(page).locator('[name="files"]').setInputFiles(png('上线凭据.png'));
            await dialog(page).getByRole('button', { name: '记录正式上线', exact: true }).click();
            await target('trace-golive-proof', async () => { await settled(page); await contains(page, '上线凭据.png'); });
            let batch = (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).batches[0];
            assert.strictEqual(batch.last_golive_event.attachments.length, 1, '[trace-golive-proof] 上线事件实际绑定凭据');
            // #228：面板的「发生时间」取接口字段 at（golive-core.js 的 goliveInfoOf）；期望值读自接口，不从页面反推。
            assert.ok(typeof batch.last_golive_event.at === 'string' && batch.last_golive_event.at !== '', '接口应给出上线事件的发生时间');
            await target('golive-event-time', async () => {
                const fact = page.locator('.sbui-panel').filter({ has: page.getByRole('heading', { name: '最近一次上线事件与凭据', exact: true }) }).locator('.sbui-fact').filter({ has: page.locator('.sbui-label', { hasText: /^发生时间$/ }) });
                assert.strictEqual(await fact.locator('span:not(.sbui-label)').textContent(), batch.last_golive_event.at, '上线事件面板显示接口给出的发生时间');
            });
            const admin = await pageFor(people.admin, options.mutation);
            try {
                await visit(admin.page, '#project=' + s.pid + '&tab=handover');
                await admin.page.getByRole('button', { name: '撤销正式上线', exact: true }).click();
                await dialog(admin.page).locator('[name="reason"]').fill('重新核对上线结果后登记撤销依据');
                await dialog(admin.page).locator('[name="files"]').setInputFiles(png('撤销上线凭据.png'));
                await dialog(admin.page).getByRole('button', { name: '记录撤销上线', exact: true }).click();
                await target('trace-revoke-proof', async () => { await settled(admin.page); await contains(admin.page, '撤销上线凭据.png'); });
                batch = (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).batches[0];
                assert.deepStrictEqual([batch.last_golive_event.kind, batch.last_golive_event.attachments.length], ['revoke', 1], '[trace-revoke-proof] 撤销事件独立绑定凭据');
                await screenshot(admin.page, 'l3-golive-attachments.png');
            } finally { await admin.context.close(); }
        }],
    ];
}

// from 字符串与被测实现逐条对应；目标文字由测试手写。
const MUTATIONS = [
    { id: 'c5-entries-change-request-restored', file: 'sysbuild-entries.js', from: "host.appendChild(A.panel('登记与办理', [A.hint(", to: "controls.appendChild(A.command('需求变更申请', () => {}, '', c)); host.appendChild(A.panel('登记与办理', [A.hint(", expect: REQUEST, expectFailure: '[trace-form-retired]' },
    { id: 'l3-form-generated-fields', file: 'sysbuild-entries.js', from: 'const form = A.dialog(formNames[kind], defs,', to: "defs.push({ name: 'title', label: '错误的手填标题' }); const form = A.dialog(formNames[kind], defs,", expect: REQUEST, expectFailure: '[trace-generated-text]' },
    { id: 'l3-form-correction-hidden', file: 'sysbuild-entries.js', from: 'if (entry.has_correction === true || (entry.corrections || []).length) host.appendChild', to: 'if (false) host.appendChild', expect: REQUEST, expectFailure: '[trace-correction]' },
    { id: 'l3-progress-current-cycle', file: 'sysbuild-plan.js', from: "report.current_cycle ? A.panel('当前汇报节奏", to: "false ? A.panel('当前汇报节奏", expect: REPORT, expectFailure: '[trace-cycle]' },
    { id: 'l3-progress-request-source', file: 'sysbuild-plan.js', from: 's.reason ? A.hint(s.reason) : null', to: 'null', expect: REPORT, expectFailure: '[trace-request-due]' },
    { id: 'l3-progress-source-correction', file: 'sysbuild-plan.js', from: 'return A.entryCorrectionsView(ids.length ? Object.assign({}, entry, { corrections: fresh }) : entry);', to: 'return null;', expect: REPORT, expectFailure: '[trace-source-correction]' },
    { id: 'l3-progress-correction-once', file: 'sysbuild-plan.js', from: 'if (ids.length && ids.every((x) => shownCorrectionIds.has(x))) return A.hint(', to: 'if (false) return A.hint(', expect: REPORT, expectFailure: '[trace-correction-once]' },
    { id: 'l3-progress-cycle-counted', file: 'sysbuild-plan.js', from: 'if (report.current_cycle) correctionIds(report.current_cycle).forEach((x) => shownCorrectionIds.add(x));', to: 'void 0;', expect: REPORT, expectFailure: '[trace-correction-once]' },
    { id: 'l3-progress-correction-by-entry', file: 'sysbuild-plan.js', from: 'ids.every((x) => shownCorrectionIds.has(x))', to: 'ids.some((x) => shownCorrectionIds.has(x))', expect: REPORT, expectFailure: '[trace-correction-merge]' },
    { id: 'l3-todo-source-correction', file: 'sysbuild-page.js', from: 'A.entryCorrectionsView(sourceEntry)', to: 'null', expect: REPORT, expectFailure: '[trace-todo-source-correction]' },
    { id: 'l3-progress-report-next', file: 'sysbuild-entries.js', from: "if (kind === 'progress_report') f.due_on = v.due_on || null;", to: "if (kind === 'progress_report') { f.due_on = v.due_on || null; f.next = '错误覆盖的下一步安排信息'; }", expect: REPORT, expectFailure: '[trace-report]' },
    { id: 'l3-progress-milestone-warning', file: 'sysbuild-entries.js', from: 'result.milestone_warning].filter(Boolean)', to: 'null].filter(Boolean)', expect: REPORT, expectFailure: '[trace-milestone-warning]' },
    { id: 'l3-progress-submitted', file: 'sysbuild-plan.js', from: "item.submitted ? '已交' : item.overdue ? '逾期未交' : '待交'", to: "false ? '已交' : item.overdue ? '逾期未交' : '待交'", expect: REPORT, expectFailure: '[trace-submitted-view]' },
    // #212 C6 新增（A.3 B1，主会话裁定方案 (a)）：只放回「本人确认」复选框（不设 required）——放回的复选框使 [trace-self-ack-retired] 目标内的 count() === 0 失败；[trace-milestone-save] 在 B1 下不失败（控件放回但提交不读取它），所以不以它为 expectFailure。目标放在本套件的 REPORT 场景里（清单 A.3 的 expect 栏写 REQUEST 场景名，与目标实际所在场景不一致，按目标所在场景登记）
    { id: 'c6-progress-self-ack-restored', file: 'sysbuild-entries.js', from: "milestone.addEventListener('change', syncMilestone); syncMilestone();", to: "milestone.addEventListener('change', syncMilestone); syncMilestone(); { const ack = document.createElement('input'); ack.type = 'checkbox'; ack.name = 'self_ack'; form.appendChild(ack); }", expect: REPORT, expectFailure: '[trace-self-ack-retired]' },
    // #212 C6 新增（A.3 B3）：登记详情无条件放回「对已有结论提异议」按钮（不保留 e.actions.object === true 条件：C6 后接口不再返回该键，带条件的写法是等价变异）
    { id: 'c6-entry-detail-object-button-restored', file: 'sysbuild-entries.js', from: "host.appendChild(A.panel('附件与原始凭据', [A.attachmentList(e.attachments, c)]));", to: "host.appendChild(A.panel('附件与原始凭据', [A.attachmentList(e.attachments, c)])); host.appendChild(A.row(A.command('对已有结论提异议', () => {}, '', c)));", expect: REQUEST, expectFailure: '[c6-object-button-retired]' },
    { id: 'l3-report-no-recipient', file: 'sysbuild-entries.js', from: 'result.no_recipient === true ?', to: 'false ?', expect: WARNINGS, expectFailure: '[trace-no-recipient]' },
    { id: 'l3-report-unreadable-details', file: 'sysbuild-plan.js', from: "if ((report[key] || []).length) body.appendChild", to: 'if (false) body.appendChild', expect: WARNINGS, expectFailure: '[trace-unreadable]' },
    { id: 'l3-report-overdue', file: 'sysbuild-plan.js', from: "item.overdue ? '逾期未交' : '待交'", to: "false ? '逾期未交' : '待交'", expect: WARNINGS, expectFailure: '[trace-overdue]' },
    { id: 'step6-report-no-delivered-count', file: 'sysbuild-plan.js', from: "A.text('已交 ' + delivered + ' 期')", to: "A.text('已交 0 期')", expect: REPORT, expectFailure: '[step6-report-delivered]' },
    { id: 'step6-report-overdue-not-red', file: 'sysbuild-plan.js', from: "overdue ? 'sbui-report-late' : ''", to: "''", expect: WARNINGS, expectFailure: '[step6-report-red]' },
    { id: 'step6-report-ignores-existing-default', file: 'sysbuild-plan.js', from: "node.status === 'not_started' ? [A.text('未开始'), cycle || ", to: "node.status === 'not_started' ? [A.text('未开始'), null || ", expect: WARNINGS, expectFailure: '[step6-report-existing-default]' },
    { id: 'l3-progress-entry-allowed', file: 'sysbuild-plan.js', from: 'if (definition && definition.allowed === true) ops.appendChild', to: 'if (definition) ops.appendChild', expect: REPORT, expectFailure: '[trace-dev-entry-capability]' },
    { id: 'l3-dev-start-reason', file: 'sysbuild-plan.js', from: '范围尚未确认。可补充开工说明及沟通记录。', to: '错误的开始提示', expect: REPORT, expectFailure: '[trace-start-reason]' },
    { id: 'l3-form-attachment-binding', file: 'sysbuild-entries.js', from: 'attachment_ids: await A.stageFiles(detail.project.id, v.files, cc) }', to: 'attachment_ids: [] }', expect: REQUEST, expectFailure: '[trace-form-attachment]' },
    { id: 'l3-golive-attachment', file: 'sysbuild-plan.js', from: "body: { attachment_ids, complete_node_ids: (v.complete_node_ids || []).map(A.id) }", to: 'body: { attachment_ids: [], complete_node_ids: (v.complete_node_ids || []).map(A.id) }', expect: GOLIVE, expectFailure: '[trace-golive-proof]' },
    { id: 'l3-revoke-attachment', file: 'sysbuild-plan.js', from: 'body: { reason: v.reason, attachment_ids }', to: 'body: { reason: v.reason, attachment_ids: [] }', expect: GOLIVE, expectFailure: '[trace-revoke-proof]' },
    { id: 'golive-event-time-field', file: 'sysbuild-plan.js', from: "['发生时间', event.at]", to: "['发生时间', event.created_at]", expect: GOLIVE, expectFailure: '[golive-event-time]' },
];
module.exports = { defineCases, MUTATIONS };
