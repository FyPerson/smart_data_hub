'use strict';
// L3 五种结构化登记、汇报事实与上线凭据；浏览器动作验证公开接口实际保存的结果。
const assert = require('assert');
const path = require('path');
const REQUEST = 'L3 需求变更表单与勘误及补交材料';
const REPORT = 'L3 节奏临时要求与进度汇报';
const WARNINGS = 'L3 汇报不可读与无收件人提示';
const ASSESSMENT = 'L3 开发评估表单绑定变更草稿';
const GOLIVE = 'L3 上线与撤销附件';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const png = (name) => ({ name: name || 'trace-proof.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });

function defineCases(T) {
    const { people, api, project, invite, pageFor, visit, contains, options, out, suffix, target } = T;
    const dialog = (page) => page.locator('#sbuiDialog');
    async function screenshot(page, name) {
        await page.evaluate(() => new Promise((resolve) => { window.scrollTo(0, 0); requestAnimationFrame(() => resolve()); }));
        await page.screenshot({ path: path.join(out, name), fullPage: true });
    }
    async function settled(page) { await dialog(page).waitFor({ state: 'hidden' }); await page.locator('#sbuiView[aria-busy="false"]').waitFor(); }
    async function ownerFor(pid, side, person) {
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side, name: side === 'dev' ? '浏览器开发方' : '浏览器需求方' }, 201)).party.id;
        const joined = await invite(pid, person, party);
        await api(person, 'POST', '/my/invitations/' + joined.invitation.id + '/accept', {});
        const appointment = await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: joined.member.id }, 201);
        await api(person, 'POST', '/my/invitations/' + appointment.invitation.id + '/accept', {});
        if (side === 'demand') {
            const representative = await invite(pid, people.delegate, party);
            await api(people.delegate, 'POST', '/my/invitations/' + representative.invitation.id + '/accept', {});
            const delegation = (await api(person, 'POST', '/parties/' + party + '/delegations', { member_id: representative.member.id }, 201)).delegation.id;
            await api(people.delegate, 'POST', '/delegations/' + delegation + '/accept', {});
        }
        return { party, member: joined.member.id };
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
        await visit(page, '#project=' + pid + '&tab=setup&step=3');
        await page.locator('[name="text"]').fill('通过真实界面登记本次立项确认内容');
        await page.locator('[name="no_written_basis"]').check();
        await page.locator('[name="no_written_basis_reason"]').fill('线下会议已经讨论明确立项范围，目前尚无书面原件');
        await page.getByRole('button', { name: '保存本版立项内容', exact: true }).click();
        await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).waitFor();
        await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
        await page.getByRole('heading', { name: '立项包 v1 · 待确认', exact: true }).waitFor();
        await confirmVersion(pid, vid);
        const date = (await api(people.pm, 'GET', '/projects/' + pid)).project.created_at.slice(0, 10);
        const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        for (const node of plan.nodes) await api(people.pm, 'POST', '/nodes/' + node.id + '/schedule', { kind: 'plan', planned_start: date, planned_end: date }, 201);
        const item = (await api(people.pm, 'POST', '/projects/' + pid + '/items', { content: '本次正式确认范围中的需求条目', proposer_name: '会议提出人', no_written_evidence: true, no_evidence_reason: '线下会议讨论确认，暂未形成独立书面原件' }, 201)).item;
        const op = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'overall' }, 201)).package.id;
        const ov = (await api(people.pm, 'POST', '/packages/' + op + '/versions', {}, 201)).version.id;
        await api(people.pm, 'POST', '/package-versions/' + ov + '/items', { op: 'add', item_version_id: item.versions[0].id, committed_batch_id: plan.batches[0].id }, 201);
        await api(people.pm, 'POST', '/package-versions/' + ov + '/submit', {}); await confirmVersion(pid, ov);
        return { pid, date, batch: plan.batches[0].id, nodes: plan.nodes };
    }
    async function reportScene(withOwner) {
        const pid = await project('L3汇报_' + suffix);
        const dev = withOwner ? await ownerFor(pid, 'dev', people.member) : null;
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
        await target('trace-cycle', async () => { await settled(page); await contains(page, '按既定节奏提交开发进度与风险'); });
        const entries = await api(people.pm, 'GET', '/projects/' + s.pid + '/entries');
        const saved = entries.entries.find((e) => e.form_kind === 'report_cycle');
        assert.deepStrictEqual(saved.form, { kind: 'report_cycle', cycle: 'weekly', first_due_on: s.date, note: '按既定节奏提交开发进度与风险' }, '[trace-cycle] 节奏字段逐项保存');
        await page.getByRole('button', { name: '开始节点', exact: true }).click();
        await page.getByRole('heading', { name: s.node.name + ' · 进行中', exact: true }).waitFor();
    }
    return [
        [REQUEST, async (page) => {
            const pid = await project('L3需求申请_' + suffix);
            const writes = [];
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/projects/' + pid + '/entries')) writes.push(req.postDataJSON()); });
            await visit(page, '#project=' + pid + '&tab=entries');
            await page.getByRole('button', { name: '需求变更申请', exact: true }).click();
            const d = dialog(page);
            await d.locator('[name="content"]').waitFor();
            assert.strictEqual(await d.locator('[name="title"], [name="body"]').count(), 0, '[trace-generated-text] 表单不让用户另填标题正文');
            await d.locator('[name="source_party"]').selectOption('self');
            await d.locator('[name="content"]').fill('新增可核对的部门汇总导出功能');
            await d.locator('[name="reason"]').fill('当前汇总依靠人工复制，容易遗漏');
            await d.locator('[name="problem"]').fill('解决各部门汇总口径不一致的问题');
            await d.locator('[name="no_written_evidence"]').check();
            await d.locator('[name="no_evidence_reason"]').fill('本次需求来自线下会议讨论，尚无书面原件');
            await d.getByRole('button', { name: '保存需求变更申请', exact: true }).click();
            await target('trace-request', async () => { await settled(page); await contains(page, '新增可核对的部门汇总导出功能'); });
            const entry = (await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries[0];
            assert.strictEqual(entry.form.content, '新增可核对的部门汇总导出功能', '[trace-request] 变更内容保留原文');
            assert.strictEqual(entry.form.change_kind, 'add', '[trace-request] 变更种类保存');
            assert.ok(!Object.hasOwn(writes[0], 'title') && !Object.hasOwn(writes[0], 'body') && !Object.hasOwn(writes[0], 'commitment_flag'), '[trace-generated-text] 请求不得传生成字段或承诺标记');
            await page.getByRole('button', { name: '追加更正', exact: true }).click();
            await dialog(page).locator('[name="text"]').fill('勘误：部门汇总导出中的部门名称应以最新组织目录为准');
            await dialog(page).getByRole('button', { name: '追加更正', exact: true }).click();
            await target('trace-correction', async () => { await settled(page); await page.getByRole('heading', { name: '勘误说明', exact: true }).waitFor(); });
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + entry.id)).entry.form.content, '新增可核对的部门汇总导出功能');
            await page.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await target('trace-supplement', () => dialog(page).getByRole('button', { name: '先补交材料', exact: true }).click());
            await dialog(page).locator('[name="source_party"]').selectOption('self');
            assert.strictEqual(await dialog(page).locator('[name="type"]').inputValue(), 'material', '[trace-supplement] 入口预选补交材料');
            await dialog(page).locator('[name="title"]').fill('结论处理材料索引');
            await dialog(page).locator('[name="body"]').fill('供PM在办理结论中明确引用的补交材料');
            await dialog(page).locator('[name="files"]').setInputFiles(png());
            await dialog(page).getByRole('button', { name: '保存登记', exact: true }).click();
            await settled(page);
            const material = (await api(people.pm, 'GET', '/projects/' + pid + '/entries')).entries.find((e) => e.type === 'material');
            assert.strictEqual((await api(people.pm, 'GET', '/entries/' + material.id)).entry.attachments.length, 1, '[trace-supplement] 材料作为独立登记保留');
            await visit(page, '#project=' + pid + '&tab=entries&entry=' + entry.id);
            await page.getByRole('button', { name: '给出办理结论', exact: true }).click();
            await target('trace-material-scope', () => page.getByText(/不进入本轮结论确认的冻结清单/).first().waitFor());
            await screenshot(page, 'l3-entry-correction-material.png');
            const joined = await invite(pid, people.readonly);
            await api(people.readonly, 'POST', '/my/invitations/' + joined.invitation.id + '/accept', {});
            const readonly = await pageFor(people.readonly, options.mutation);
            try {
                await visit(readonly.page, '#project=' + pid + '&tab=entries');
                await readonly.page.getByRole('heading', { name: '登记与办理', exact: true }).waitFor();
                assert.strictEqual(await readonly.page.getByRole('button', { name: '需求变更申请', exact: true }).count(), 0, '[trace-form-capability] 只读账号不显示结构化登记入口');
            } finally { await readonly.context.close(); }
        }],
        [REPORT, async (page) => {
            const s = await reportScene(true);
            await visit(page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
            await target('trace-start-reason', () => contains(page, '请先确定开工日（开发节点的计划开始）'));
            await cycleAndStart(page, s);
            await page.getByRole('button', { name: '登记临时汇报要求', exact: true }).click();
            await dialog(page).locator('[name="due_on"]').fill(s.date);
            await dialog(page).locator('[name="reason"]').fill('请补充当天风险的处理进度与下一步安排');
            await dialog(page).getByRole('button', { name: '保存临时汇报要求', exact: true }).click();
            await target('trace-request-due', async () => { await settled(page); await contains(page, '请补充当天风险的处理进度与下一步安排'); });
            const request = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((entry) => entry.form_kind === 'report_request');
            await api(people.pm, 'POST', '/entries/' + request.id + '/actions', { action: 'correct', text: '勘误：本次临时要求中的风险范围按最新核对清单理解' }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
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
            await target('trace-report', async () => { await settled(page); await contains(page, '已经完成部门汇总接口并核对数据样例'); });
            const saved = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'progress_report');
            assert.deepStrictEqual([saved.form.due_on, saved.form.done, saved.form.next, saved.form.milestone_impact], [s.date, '已经完成部门汇总接口并核对数据样例', '下一步完成前端页面联调与业务验收', true], '[trace-report] 汇报字段实际保存');
            await target('trace-milestone-warning', () => contains(page, '本次汇报影响里程碑，请 PM 评估是否发起改期'));
            const due = (await api(people.pm, 'GET', '/projects/' + s.pid + '/plan')).nodes.find((n) => n.id === s.node.id).report.due_items[0];
            assert.deepStrictEqual([due.submitted, due.sources.length, due.report_entry_ids], [true, 2, [saved.id]]);
            await target('trace-submitted-view', () => contains(page, '已交'));
            await screenshot(page, 'l3-report-panel.png');
            const owner = await pageFor(people.member, options.mutation);
            try {
                await visit(owner.page, '#project=' + s.pid + '&tab=plan&node=' + s.node.id);
                await owner.page.getByRole('button', { name: '提交进度汇报', exact: true }).click();
                await dialog(owner.page).locator('[name="done"]').fill('开发负责人亲自核对并补充当天完成事项');
                await dialog(owner.page).locator('[name="next"]').fill('开发负责人安排后续联调与边界检查工作');
                await dialog(owner.page).locator('[name="milestone_impact"]').check();
                await target('trace-self-ack', () => dialog(owner.page).locator('[name="self_ack"]').waitFor({ state: 'visible' }));
                assert.strictEqual(await dialog(owner.page).locator('[name="self_ack"]').evaluate((n) => n.required), true, '[trace-self-ack] 本人关键事项须勾认可声明');
                await dialog(owner.page).locator('[name="milestone_impact"]').uncheck();
                assert.strictEqual(await dialog(owner.page).locator('[name="self_ack"]').isVisible(), false, '[trace-self-ack] 普通汇报不要求认可');
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
            await target('trace-unreadable', async () => { await contains(page, '节奏登记无法读取'); await contains(page, '无法读取的临时汇报要求'); await page.getByRole('link', { name: '登记 #901', exact: true }).first().waitFor(); await contains(page, '无法读取的进度汇报'); await page.getByRole('link', { name: '登记 #902', exact: true }).first().waitFor(); });
            await target('trace-overdue', () => contains(page, '逾期未交'));
            await page.unroute(pattern);
        }],
        [ASSESSMENT, async (page) => {
            const s = await overall(page); await ownerFor(s.pid, 'dev', people.member);
            const change = await api(people.pm, 'POST', '/projects/' + s.pid + '/changes', { title: '增加导出范围', body: '需求方要求增加部门汇总导出，并核对实施代价', no_written_evidence: true, no_evidence_reason: '需求来自业务会议沟通，尚无独立书面原件' }, 201);
            const developer = await pageFor(people.member, options.mutation);
            try {
                await visit(developer.page, '#project=' + s.pid + '&tab=packages&version=' + change.version.id);
                await target('trace-assessment-entry', () => developer.page.getByRole('button', { name: '登记开发评估', exact: true }).click());
                const d = dialog(developer.page);
                await d.locator('[name="feasible"]').selectOption('partial');
                await d.locator('[name="extra_person_days"]').fill('2.5');
                await d.locator('[name="schedule_impact_days"]').fill('3');
                await d.locator('[name="impact_note"]').fill('接口联调增加三天，需要调整开发节点计划');
                await d.locator('[name="premise"]').fill('需求方须先补齐部门汇总样例数据');
                await d.locator('[name="files"]').setInputFiles(png('评估凭据.png'));
                await d.locator('[name="self_ack"]').check();
                await d.getByRole('button', { name: '保存开发评估', exact: true }).click();
                await target('trace-assessment', async () => { await settled(developer.page); await contains(developer.page, '接口联调增加三天，需要调整开发节点计划'); });
                const saved = (await api(people.pm, 'GET', '/projects/' + s.pid + '/entries')).entries.find((e) => e.form_kind === 'dev_assessment');
                assert.deepStrictEqual([saved.form.about_change_id, saved.form.feasible, saved.form.extra_person_days, saved.form.schedule_impact_days, saved.dev_confirm.status], [change.change.id, 'partial', 2.5, 3, 'approved'], '[trace-assessment] 评估绑定草稿并由负责人本人认可');
                await target('trace-assessment-proof', async () => {
                    assert.strictEqual((await api(people.pm, 'GET', '/entries/' + saved.id)).entry.attachments.length, 1, '新表单helper须把已选凭据绑定到登记');
                    await contains(developer.page, '评估凭据.png');
                });
                await screenshot(developer.page, 'l3-assessment-entry.png');
            } finally { await developer.context.close(); }
        }],
        [GOLIVE, async (page) => {
            const s = await overall(page);
            const pk = (await api(people.pm, 'POST', '/projects/' + s.pid + '/packages', { type: 'batch_accept', batch_id: s.batch }, 201)).package.id;
            const vid = (await api(people.pm, 'POST', '/packages/' + pk + '/versions', {}, 201)).version.id;
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
    { id: 'l3-form-generated-fields', file: 'sysbuild-entries.js', from: 'const form = A.dialog(formNames[kind], defs,', to: "defs.push({ name: 'title', label: '错误的手填标题' }); const form = A.dialog(formNames[kind], defs,", expect: REQUEST, expectFailure: '[trace-generated-text]' },
    { id: 'l3-form-capability', file: 'sysbuild-entries.js', from: 'if (changeForm && changeForm.allowed === true) controls.appendChild', to: 'if (changeForm) controls.appendChild', expect: REQUEST, expectFailure: '[trace-form-capability]' },
    { id: 'l3-change-request-content', file: 'sysbuild-entries.js', from: "if (kind === 'change_request') body.item_ids = ids(v.item_ids);", to: "if (kind === 'change_request') { body.item_ids = ids(v.item_ids); body.form.content = '错误覆盖的变更内容'; }", expect: REQUEST, expectFailure: '[trace-request]' },
    { id: 'l3-form-correction-hidden', file: 'sysbuild-entries.js', from: 'if (entry.has_correction === true || (entry.corrections || []).length) host.appendChild', to: 'if (false) host.appendChild', expect: REQUEST, expectFailure: '[trace-correction]' },
    { id: 'l3-conclusion-supplement-entry', file: 'sysbuild-entries.js', from: "{ type: 'material', node_id: e.node_id }", to: "{ type: 'note', node_id: e.node_id }", expect: REQUEST, expectFailure: '[trace-supplement]' },
    { id: 'l3-conclusion-material-scope', file: 'sysbuild-entries.js', from: '不进入本轮结论确认的冻结清单', to: '错误声称作为确认凭据', expect: REQUEST, expectFailure: '[trace-material-scope]' },
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
    { id: 'l3-progress-self-ack', file: 'sysbuild-entries.js', from: 'ack.required = milestone.checked;', to: 'ack.required = false;', expect: REPORT, expectFailure: '[trace-self-ack]' },
    { id: 'l3-report-no-recipient', file: 'sysbuild-entries.js', from: 'result.no_recipient === true ?', to: 'false ?', expect: WARNINGS, expectFailure: '[trace-no-recipient]' },
    { id: 'l3-report-unreadable-details', file: 'sysbuild-plan.js', from: "if ((report[key] || []).length) body.appendChild", to: 'if (false) body.appendChild', expect: WARNINGS, expectFailure: '[trace-unreadable]' },
    { id: 'l3-report-overdue', file: 'sysbuild-plan.js', from: "item.overdue ? '逾期未交' : '待交'", to: "false ? '逾期未交' : '待交'", expect: WARNINGS, expectFailure: '[trace-overdue]' },
    { id: 'l3-progress-entry-allowed', file: 'sysbuild-plan.js', from: 'if (definition && definition.allowed === true) ops.appendChild', to: 'if (definition) ops.appendChild', expect: REPORT, expectFailure: '[trace-dev-entry-capability]' },
    { id: 'l3-dev-start-reason', file: 'sysbuild-plan.js', from: "no_plan: '请先确定开工日（开发节点的计划开始）'", to: "no_plan: '错误的开始提示'", expect: REPORT, expectFailure: '[trace-start-reason]' },
    { id: 'l3-assessment-days', file: 'sysbuild-entries.js', from: 'f.extra_person_days = Number(v.extra_person_days);', to: 'f.extra_person_days = 0;', expect: ASSESSMENT, expectFailure: '[trace-assessment]' },
    { id: 'l3-form-attachment-binding', file: 'sysbuild-entries.js', from: 'attachment_ids: await A.stageFiles(detail.project.id, v.files, cc) }', to: 'attachment_ids: [] }', expect: ASSESSMENT, expectFailure: '[trace-assessment-proof]' },
    { id: 'l3-golive-attachment', file: 'sysbuild-plan.js', from: "body: { attachment_ids }", to: 'body: { attachment_ids: [] }', expect: GOLIVE, expectFailure: '[trace-golive-proof]' },
    { id: 'l3-revoke-attachment', file: 'sysbuild-plan.js', from: 'body: { reason: v.reason, attachment_ids }', to: 'body: { reason: v.reason, attachment_ids: [] }', expect: GOLIVE, expectFailure: '[trace-revoke-proof]' },
];
module.exports = { defineCases, MUTATIONS };
