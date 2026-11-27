'use strict';
const assert = require('assert');
const path = require('path');
const MATERIAL = 'L3 立项依据版本与自动选入恢复';
const DECLARATION = 'L3 立项声明失效与全部未保存字段';
const MODAL = 'L3 建档弹窗校验关闭与兼容';
const READONLY = 'L3 立项阶段只读与帮助规定';
const REASON = 'L3 立项阶段未就绪与提交原因';

function defineCases(T) {
    const { people, api, project, addMember, assignParty, fillDemand, visit, contains, pageFor, options, out, suffix, target, declareViaCard, openStageCard } = T;
    async function owner(pid) {
        await assignParty(pid, 'demand', '立项核对需求方', people.owner, people.delegate);
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
        await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
        const drawer = await openStageCard(page, '立项依据');
        await drawer.locator('[name="body"]').fill(text);
        if (filename) await drawer.locator('[name="files"]').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(text) });
        await save(page, '保存立项依据版本');
        await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        await basisCard(page).waitFor();
    }
    const stage = (pid) => '#project=' + pid + '&tab=plan&stage=initiation';
    const panelOf = (page, name) => page.locator('.sbui-stage-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const basisCard = (page) => panelOf(page, '立项依据');
    const confirmationCard = (page) => panelOf(page, '立项确认');
    const makeDraft = (page) => confirmationCard(page).getByRole('button', { name: '建立确认草稿', exact: true }).click();
    const openDraft = (page) => confirmationCard(page).getByRole('link', { name: '进入确认草稿', exact: true }).click();
    const submit = (page) => page.getByRole('button', { name: '发起本版确认', exact: true });
    return [
        [MODAL, async (page) => {
            await visit(page, '#new=1');
            const dialog = page.locator('#sbuiDialog');
            await target('l3-modal-open', () => dialog.waitFor({ state: 'visible' }));
            await contains(page, '保存后不可更改，将按此方式带出默认批次与节点。');
            assert.strictEqual(await dialog.locator('[name="goal"]').count(), 0, '[l3-modal-fields] 建档不填建设目标');
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
            assert.ok(await dialog.locator('[name="system_name"]').evaluate((n) => n.validationMessage), '[l3-modal-required] 系统名称必填');
            await dialog.locator('[name="system_name"]').fill('未保存建档_' + suffix);
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
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
            await fillDemand(page, '立项测试需求部门');
            const box = await dialog.boundingBox();
            assert.ok(Math.abs(box.width - 760) < 2 && Math.abs(box.x - (1440 - box.width) / 2) < 2, '[l3-modal-layout] 建档弹窗宽760且居中');
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'l3-create-modal.png') });
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
            await target('b33-create-stage', () => basisCard(page).waitFor());
            assert.strictEqual(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('stage'), 'initiation', '[b33-create-stage] 建档成功直接进入立项节点');
            assert.strictEqual(await dialog.evaluate((n) => n.open), false);
            await page.getByRole('heading', { name: '立项确认', exact: true }).waitFor();

            await visit(page, '#new=1');
            await dialog.locator('[name="system_name"]').fill('建档后读取重试_' + suffix);
            await dialog.locator('[name="build_type"]').selectOption('inhouse');
            await fillDemand(page, '恢复检查需求部门');
            let creates = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/sysbuild/projects')) creates++; });
            const planUrl = '**/api/sysbuild/projects/*/plan';
            await page.route(planUrl, (route) => route.fulfill({ status: 503, json: { message: '模拟建档后排期读取失败' } }));
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
            await contains(page, '模拟建档后排期读取失败');
            const projectHash = new URL(page.url()).hash;
            assert.match(projectHash, /^#project=\d+&tab=plan&stage=initiation$/);
            await page.unroute(planUrl);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('heading', { name: '立项确认', exact: true }).waitFor();
            assert.strictEqual(new URL(page.url()).hash, projectHash, '读取失败后仍打开已建立的同一个项目');
            assert.strictEqual(creates, 1, '恢复读取不重复发送建档');

            const admin = await pageFor(people.admin, options.mutation);
            try {
                await visit(admin.page, '#new=1');
                const form = admin.page.locator('#sbuiDialog');
                await form.locator('[name="system_name"]').fill('管理员代建检查');
                await form.locator('[name="build_type"]').selectOption('inhouse');
                await form.getByRole('button', { name: '保存', exact: true }).click();
                assert.ok(await form.locator('[name="pm_user_id"]').evaluate((n) => n.validationMessage), '[l3-admin-pm] 管理员代建须选PM');
            } finally { await admin.context.close(); }
        }],
        [MATERIAL, async (page) => {
            const pid = await project('依据恢复_' + suffix);
            await owner(pid);
            await material(page, pid, '只有正文的立项依据尚未具备书面附件');
            assert.strictEqual(await basisCard(page).getByText('待补材料', { exact: true }).count(), 1, '[l3-basis-text-only] 只有正文不算完成');
            await material(page, pid, '新版书面依据的正文', '立项依据第二版.txt');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await target('l3-basis-reload', async () => {
                const drawer = await openStageCard(page, '立项依据');
                await drawer.getByText('立项依据 v2', { exact: true }).click();
                await drawer.getByText('新版书面依据的正文', { exact: true }).waitFor();
                await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
                await drawer.waitFor({ state: 'hidden' });
            });
            await basisCard(page).getByText('已完成', { exact: true }).waitFor();
            const materials = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
            assert.strictEqual(materials.materials.length, 1, '[l3-basis-version] 固定材料只追加版本');
            const versions = materials.materials[0].versions;
            assert.strictEqual(versions.length, 2, '[l3-basis-version] 两次保存产生两版');
            assert.strictEqual(versions[0].attachments.length, 0);
            const latest = versions[1];
            assert.strictEqual(latest.attachments.length, 1);
            await page.getByRole('link', { name: '成员', exact: true }).click();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('heading', { name: '项目人员', exact: true }).waitFor();
            await visit(page, stage(pid));
            let intercepted = false;
            await page.route('**/api/sysbuild/package-versions/*', async (route) => {
                if (route.request().method() === 'PATCH' && !intercepted) {
                    intercepted = true;
                    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试注入的自动选入失败' }) });
                }
                return route.continue();
            });
            await makeDraft(page);
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
            await submit(page).click();
            await contains(page, '本版已提交，确认人按固定版本与冻结附件作决定。');
            const tasks = (await api(people.pm, 'GET', '/package-versions/' + draft.id + '/confirm-tasks')).tasks;
            const task = await api(people.owner, 'GET', '/confirm-tasks/' + tasks[0].task_id);
            await api(people.owner, 'POST', '/confirm-tasks/' + tasks[0].task_id + '/decide', { revision_id: task.revision.id, object_version_id: task.task.object_version_id, decision: 'confirm', checkbox_text: task.checkbox_texts.confirm });
            await visit(page, stage(pid));
            await confirmationCard(page).getByText('已生效', { exact: true }).waitFor();
            await target('b33-effective-history', () => confirmationCard(page).getByRole('link', { name: '查看确认记录', exact: true }).click());
            await page.getByRole('heading', { name: '立项与授权 v1 · 已生效', exact: true }).waitFor();
            assert.strictEqual(await page.locator('#sbuiView form').count(), 0, '[l3-effective-readonly] 生效快照只读');
            await page.getByRole('link', { name: '返回对方确认', exact: true }).click();
            await page.getByRole('heading', { name: '对方确认', exact: true }).waitFor();
            assert.strictEqual(await page.getByRole('button', { name: /建立.*草稿/ }).count(), 0, '[b33-one-entry] 内容包只列历史');
            await visit(page, stage(pid));
            const drawer = await openStageCard(page, '立项确认');
            await drawer.getByRole('button', { name: '重新发起确认', exact: true }).click();
            await page.locator('[name="text"]').waitFor();
            const second = await getDraft(pid);
            assert.notStrictEqual(second.id, draft.id);
            assert.deepStrictEqual((await api(people.pm, 'GET', '/package-versions/' + second.id)).snapshot_json.material_version_ids, [otherMaterial.version.id, latest.id], '[l3-default-second] 再建从确认卡入口选入最新依据并保留其它选择');
        }],
        [DECLARATION, async (page) => {
            const pid = await project('立项声明_' + suffix);
            await owner(pid);
            await visit(page, stage(pid));
            await makeDraft(page);
            await page.locator('[name="text"]').fill('明确保存的立项全文');
            assert.strictEqual(await submit(page).count(), 0, '[l3-submit-gate] 未准备依据不可提交');
            await save(page, '保存本版草稿');
            const draft = await getDraft(pid);
            const note = '本次立项来源于线下讨论，目前没有书面原件';
            await declareViaCard(page, pid, note);
            const ready = await api(people.pm, 'GET', '/package-versions/' + draft.id);
            assert.strictEqual(ready.basis_declaration, note, '[l3-basis-declaration] 声明在材料卡写入');
            assert.ok(!Object.hasOwn(ready.snapshot_json, 'no_written_basis_reason'), '草稿不会提前存入声明');
            await target('l3-declared-panel', () => basisCard(page).getByText('已声明无书面依据', { exact: true }).waitFor());
            await target('l3-submittable', () => confirmationCard(page).getByText('草稿 · 可提交', { exact: true }).waitFor());
            await openDraft(page);
            await submit(page).waitFor();
            await target('l3-unsaved-reason', () => contains(page, note));
            assert.strictEqual(await page.locator('[name="no_written_basis_reason"], [name="reason"]').count(), 0, '草稿只读立项声明');
            assert.strictEqual(await page.getByText(/当前不能发起确认|当前账号不能发起本版确认/).count(), 0, '[l3-submittable] 可提交时不显示不能发起的原因');
            let submits = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/package-versions/' + draft.id + '/submit')) submits++; });
            const p = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const node = p.nodes.find((n) => n.template_key === 'p_initiation');
            const added = await api(people.pm, 'POST', '/nodes/' + node.id + '/materials/another-basis/versions', { name: '另份立项依据', body: '供核对未保存选入状态的文字材料' }, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.locator('[name="material_version_ids[]"][value="' + added.version.id + '"]').check();
            await submit(page).click();
            await target('l3-unsaved-material', () => contains(page, '有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[l3-unsaved-material] 未保存材料选择不能发请求');
            await material(page, pid, '一次只有正文的后续上传');
            await target('l3-delete-declaration', () => confirmationCard(page).getByText(/在立项依据卡片填写无书面依据原因/).waitFor());
            await openDraft(page);
            await page.locator('[name="text"]').waitFor();
            assert.strictEqual(await submit(page).count(), 0, '[l3-delete-declaration] 上传使旧声明失效');
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + draft.id)).snapshot_json.text, ready.snapshot_json.text);
        }],
        [REASON, async (page) => {
            const pid = await project('提交原因_' + suffix);
            const party = (await api(people.pm, 'GET', '/projects/' + pid)).parties[0];
            await api(people.pm, 'POST', '/appointments/' + party.owner.appointment_id + '/end', { reason: '模拟暂缺现任领导' });
            await material(page, pid, '已有附件的立项依据正文', '提交原因核对依据.txt');
            await makeDraft(page);
            await page.locator('[name="text"]').waitFor();
            const reason = '当前不能发起确认：以下参与方缺少必需确认人：' + party.name + '（缺现任领导）';
            await target('l3-package-reason', () => contains(page, reason));
            assert.strictEqual(await submit(page).count(), 0, '[l3-package-reason] 不能发起时不显示发起按钮');
            await visit(page, stage(pid));
            await target('l3-panel-step3', () => confirmationCard(page).getByText('草稿 · ' + reason, { exact: true }).waitFor());
            await page.getByRole('link', { name: '成员', exact: true }).click();
            await page.getByRole('heading', { name: '项目人员', exact: true }).waitFor();
        }],
        [READONLY, async (page) => {
            await visit(page, '#new=1');
            await contains(page, '当前账号不能新建项目。');
            assert.strictEqual(await page.locator('#sbuiDialog').evaluate((n) => n.open), false, '[l3-readonly-modal] 无权限不能打开建档');
            const pid = await project('只读立项_' + suffix);
            await addMember(pid, people.readonly);
            await visit(page, stage(pid));
            await basisCard(page).getByText('待补材料', { exact: true }).waitFor();
            const drawer = await openStageCard(page, '立项依据');
            await target('l3-readonly-setup', async () => assert.strictEqual(await drawer.locator('form').count(), 0, '只读不能上传'));
            await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await drawer.waitFor({ state: 'hidden' });
            assert.strictEqual(await page.getByRole('button', { name: /填写无书面依据原因|建立确认草稿/ }).count(), 0, '[l3-readonly-setup] 只读不能编辑两卡');
            const pkg = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package;
            await api(people.pm, 'POST', '/packages/' + pkg.id + '/versions', {}, 201);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await openDraft(page);
            await page.getByRole('heading', { name: '立项与授权 v1 · 草稿', exact: true }).waitFor();
            assert.strictEqual(await page.locator('#sbuiView form').count(), 0, '[l3-readonly-setup] 只读打开草稿也不能编辑');
            assert.strictEqual(await submit(page).count(), 0, '[l3-readonly-setup] 只读不能发起');
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            await target('b33-old-url', () => page.getByRole('heading', { name: '节点推进', exact: true }).waitFor());
            assert.strictEqual(await page.getByText('继续立项准备', { exact: true }).count(), 0, '[b33-old-url] 原三步链接回到项目概览');
            await visit(page, '#help=1');
            const helpPanel = (title) => page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
            const expectedHelp = {
                '留痕规定': [
                    '一、未在平台登记并确认的功能或调整，开发方不安排；已经做了的，不作为验收、结算和工期顺延的依据。由此产生的问题，先补登记再排期；影响业务运行的故障按影响处理，处理后一个工作日内补登记。',
                    '二、需要留痕的范围：涉及范围、验收标准、工期或交付承诺的事项。开发方内部的技术实现调整不在此列。',
                    '三、「平台」包括项目管理与系统迭代：批次正式上线前在项目管理里登记，正式上线后在系统迭代里提单。',
                    '以上规定在本次功能上线后，由项目负责人通知各方生效；此前只作口头要求。第一条的补登记时限属于规定，不由平台自动强制。',
                ],
                '当前操作方式': [
                    '需求方、开发方和 PM 都可在项目中提意见或需求。用意见跟踪评估、去向和后续任务。',
                    '阶段可独立开始和完成。范围确认前也可以开始开发，项目会显示「范围未确认已开工」。涉及交付承诺的事项按对应关口确认。',
                    '开发阶段按登记节奏汇报。未登记时默认每周，自研默认每两周。PM 可登记临时汇报要求，逾期在汇报区和待办中提示。',
                ],
                '四个关口': [
                    '立项：PM 整理立项依据并发起确认，各需求部门的现任领导本人确认。',
                    '范围：各需求部门的现任负责人确认需求文档和验收、正式上线、结项的计划日期。自研使用正式上线、结项两个日期。确认生效后形成这些阶段的基线。',
                    '验收：各需求部门的现任负责人确认本次验收记录。范围和验收都生效后，PM 可记录正式上线。',
                    '结项：核对必须做的事均完成、意见有结论、任务有结果且已正式上线后，可发起结项确认。各需求部门的现任负责人确认后，由 PM 完成结项。',
                    '范围、验收和结项发起时通知需求方领导。负责人从「等我处理」打开确认正文，核对版本和冻结附件后本人作决定。',
                    '本人确认的阅读与声明可以在确认记录中核对。有异议不算确认，不设逾期自动同意。新版本不会继承旧版本确认。',
                ],
                '意见、任务和汇报': [
                    '从项目的「提意见或需求」开始。PM 初判，开发负责人给意见和工时，PM 定去向。PM 初判时可以跳过开发方给意见和工时这一步，填写原因后直接定去向。本期做会生成任务，留到下一期或不做会留下结论。PM 代录开发意见与工时时须附开发方意见截图。',
                    '开发方提出砍需求时，由原范围确认的各需求部门的现任负责人本人表态。同意后的范围调整在原确认的调整记录中查看。',
                    '从对应阶段看任务、写完成结果或取消原因。从开发阶段提交进度汇报，打开「汇报明细与历史」可核对期次来源和勘误。',
                ],
                '材料和确认记录': [
                    '在阶段的必须做的事卡片上传材料。需求文档和验收记录须有带可用附件的版本，且该版全部附件可用。立项依据没有合格版本时可填写无书面依据原因，提交确认时冻结该声明。',
                    '有合格版本时按材料办理。合同或订单、运维交接材料与自建必做材料卡，没有合格版本时可标为不适用。上传一版后，先前声明或不适用失效。仍没有合格版本时可重新填写。',
                    '确认保存对应版本和附件。新上传、补充登记和日期更正继续留痕。打开「全部记录」可查对方确认、材料和登记，已生效版本可按权限查看归档确认单。',
                ],
                '在建项目和上线分界': [
                    '在建项目照常建档，用阶段的「更正实际日期」补记真实日期。已有的书面凭据随材料上传。',
                    '补录时，指定的平台管理员账号（admin，其他管理员角色账号不在内）可以直接做 PM 的操作，并代办对方的确认与表态。代办的记录写明操作人是管理员，并标为「管理员代办」。',
                    '正式上线后，新功能和问题走系统迭代受理渠道，项目可保留单号与链接。迭代单按系统迭代的权限查看。',
                ],
            };
            await target('l3-help-rules', async () => {
                for (const [title, expected] of Object.entries(expectedHelp)) {
                    const panel = helpPanel(title);
                    await panel.waitFor();
                    assert.deepStrictEqual(await panel.locator('p.sbui-hint').allInnerTexts(), expected, title + ' 整段逐字');
                }
                assert.strictEqual(/正式变更|需求变更申请|开发评估|两个工作日|暂不提供修改入口|继续立项准备/.test(await page.locator('#sbuiView').innerText()), false);
            });
            await page.setViewportSize({ width: 390, height: 844 });
            assert.strictEqual(await page.locator('#sysbuildApp').evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
        }, 'readonly'],
    ];
}
const MUTATIONS = [
    { id: 'l3-setup-basis-key', file: 'sysbuild-content.js', from: 'const key = card?.key ?? (material ? material.material_key : newMaterialKey());', to: "const key = inlineBasis ? 'wrong-basis' : card?.key ?? (material ? material.material_key : newMaterialKey());", expect: MATERIAL, expectFailure: '[l3-basis-reload]' },
    { id: 'l3-setup-default-latest', file: 'sysbuild-packages.js', from: 'ids.push(latest.id);', to: 'void latest.id;', expect: MATERIAL, expectFailure: '[l3-default-second]' },
    { id: 'l3-setup-recovery-preserves', file: 'sysbuild-packages.js', from: 'const ids = Array.from(new Set([...(fresh.snapshot_json.material_version_ids || []), latest.id]));', to: 'const ids = [latest.id];', expect: MATERIAL, expectFailure: '[l3-init-recovery]' },
    { id: 'l3-setup-basis-text-only', file: 'sysbuild-content.js', from: 'const status = card.complete ?', to: 'const status = (card.complete || (basis && card.material_id != null)) ?', expect: MATERIAL, expectFailure: '[l3-basis-text-only]' },
    { id: 'l3-setup-declaration-delete', file: 'sysbuild-content.js', from: 'const blocked = draft?.submit_block?.message;', to: "const blocked = data.materials.some((m) => m.material_key === 'initiation-basis' && m.versions.length > 0) ? null : draft?.submit_block?.message;", expect: DECLARATION, expectFailure: '[l3-delete-declaration]' },
    { id: 'l3-setup-unsaved-reason', file: 'sysbuild-packages.js', from: 'if (v.basis_declaration) form.prepend', to: 'if (false) form.prepend', expect: DECLARATION, expectFailure: '[l3-unsaved-reason]' },
    { id: 'l3-setup-unsaved-material', file: 'sysbuild-packages.js', from: 'ids: Array.from(new Set(ids.map(Number))).sort((a, b) => a - b)', to: 'ids: []', expect: DECLARATION, expectFailure: '[l3-unsaved-material]' },
    { id: 'l3-modal-unsaved-close', file: 'sysbuild-ui.js', from: 'if (currentForm && currentForm.sbuiCanClose && currentForm.sbuiCanClose() !== true) return;', to: 'void currentForm;', expect: MODAL, expectFailure: '[l3-modal-dirty]' },
    { id: 'l3-modal-first-step', file: 'sysbuild-page.js', from: "project: result.project.id, tab: 'plan', stage: 'initiation'", to: "project: result.project.id, tab: 'members'", expect: MODAL, expectFailure: '[b33-create-stage]' },
    { id: 'l3-modal-admin-pm', file: 'sysbuild-page.js', from: "name: 'pm_user_id', label: '项目负责人（PM）', required: true", to: "name: 'pm_user_id', label: '项目负责人（PM）', required: false", expect: MODAL, expectFailure: '[l3-admin-pm]' },
    { id: 'l3-setup-readonly-material', file: 'sysbuild-content.js', from: 'if (card.actions.upload) {', to: 'if (basis || card.actions.upload) {', expect: READONLY, expectFailure: '[l3-readonly-setup]' },
    { id: 'l3-prep-step3-reason', file: 'sysbuild-content.js', from: "blocked ? '草稿 · 当前不能发起确认：' + blocked : '草稿'", to: "'草稿'", expect: REASON, expectFailure: '[l3-panel-step3]' },
    { id: 'l3-prep-step3-submittable', file: 'sysbuild-content.js', from: "draft?.actions.submit === true ? '草稿 · 可提交'", to: "false ? '草稿 · 可提交'", expect: DECLARATION, expectFailure: '[l3-submittable]' },
    { id: 'l3-package-submit-reason', file: 'sysbuild-packages.js', from: "controls.appendChild(A.hint('当前不能发起确认：' + data.submit_block.message));", to: 'void 0;', expect: REASON, expectFailure: '[l3-package-reason]' },
    { id: 'b33-declared-card', file: 'sysbuild-content.js', from: "basis ? '已声明无书面依据' : '不适用'", to: "'不适用'", expect: DECLARATION, expectFailure: '[l3-declared-panel]' },
    { id: 'b33-effective-history', file: 'sysbuild-content.js', from: "A.link('查看确认记录'", to: "A.link('无法查看确认记录'", expect: MATERIAL, expectFailure: '[b33-effective-history]' },
    { id: 'b33-old-url', file: 'sysbuild-page.js', from: "if (retiredProjectAddress(params, requestedTab)) return 'overview';", to: "if (retiredProjectAddress(params, requestedTab)) return 'members';", expect: READONLY, expectFailure: '[b33-old-url]' },
    { id: 'step6-help-wrong-default-cycle', file: 'sysbuild-page.js', from: '未登记时默认每周，自研默认每两周。', to: '未登记时默认每周，自研也默认每周。', expect: READONLY, expectFailure: '[l3-help-rules]' },
];
module.exports = { defineCases, MUTATIONS };
