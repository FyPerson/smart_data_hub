'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const HOME = '第六步首页单次读取与本人默认落点';
const DRAWER = '第六步阶段卡片抽屉、上传期路由与生效章';
const LEGACY = '第六步旧链接路由优先级和项目边界';
const VISUAL = '第六步四角色和三个宽度的终态走查';

function homeAndDrawerCases({ people, api, project, pageFor, visit, env, sql, suffix, options, target }) {
    return [[HOME, async () => {
        const title = '首页计数与落点走查_' + suffix;
        const pid = await project(title);
        const username = 'sbui_home_reader_' + suffix;
        await sql(env.dbPath, 'INSERT INTO users(username,password,display_name,role,status) VALUES (?,?,?,?,?)',
            [username, 'private-fixture', '首页走查成员', 'user', 'active']);
        const [reader] = await sql(env.dbPath, 'SELECT id,username,display_name,role FROM users WHERE username=?', [username]);
        await api(people.pm, 'POST', '/projects/' + pid + '/members', { user_id: reader.id, party_id: null }, 201);
        const holder = await pageFor(reader, options.mutation);
        try {
            const seen = [];
            const track = (request) => {
                const pathname = new URL(request.url()).pathname;
                if (pathname.startsWith('/api/sysbuild/')) seen.push(pathname);
            };
            holder.page.on('request', track);
            await visit(holder.page, '');
            await holder.page.getByRole('heading', { name: '我参与的项目', exact: true }).waitFor();
            holder.page.off('request', track);
            assert.deepStrictEqual(seen, ['/api/sysbuild/project-cards']);
            const card = holder.page.locator('article.sbui-project-card').filter({ hasText: title });
            await card.getByRole('link', { name: '等我处理 0 件', exact: true }).waitFor();
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            await api(people.pm, 'POST', '/nodes/' + plan.nodes[0].id + '/tasks', { title: '本人待处理实测', assignee_user_id: reader.id }, 201);
            await target('step6-default-view', async () => {
                await visit(holder.page, '');
                await holder.page.getByRole('heading', { name: '等我处理', exact: true }).waitFor();
                await holder.page.getByText('本人待处理实测', { exact: true }).waitFor();
            });
            await target('step6-explicit-home', async () => {
                await holder.page.locator('#sbuiNav').getByRole('link', { name: '项目列表', exact: true }).click();
                await card.getByRole('link', { name: '等我处理 1 件', exact: true }).waitFor();
            });
        } finally {
            await holder.context.close();
        }
    }], [DRAWER, async (page) => {
        const title = '阶段卡片和抽屉走查_' + suffix;
        const pid = await project(title);
        const projectPath = '/projects/' + pid;
        const call = (method, route, body, expected) => api(people.pm, method, route, body, expected);
        const plan = await call('GET', projectPath + '/plan');
        const node = plan.nodes.find((item) => item.template_key === 'p_initiation');
        const stageUrl = '#project=' + pid + '&tab=plan&node=' + node.id;
        const drawer = page.locator('.sbui-drawer');
        const card = (name) => page.locator('section.sbui-stage-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).first();
        await visit(page, '#scope=mine');
        await page.getByRole('link', { name: title, exact: true }).click();
        await page.locator('.sbui-project-rail a[href$="&node=' + node.id + '"]').click();
        await page.waitForURL((url) => url.hash === stageUrl);
        const basis = card('立项依据');
        await target('step6-basis-drawer-only', async () => {
            await basis.waitFor();
            assert.strictEqual(await basis.locator('[type="file"]').count(), 0, '立项依据表单仅在抽屉');
        });
        await basis.getByRole('link', { name: '查看卡片', exact: true }).click();
        await drawer.getByRole('heading', { name: '立项依据', exact: true }).waitFor();
        await target('step6-drawer-tab-cycle', async () => {
            const first = drawer.getByRole('button', { name: '关闭抽屉', exact: true });
            const last = drawer.getByRole('button', { name: '填写无书面依据原因', exact: true });
            await first.focus();
            await page.keyboard.press('Shift+Tab');
            assert.strictEqual(await last.evaluate((node) => document.activeElement === node), true);
            await page.keyboard.press('Tab');
            assert.strictEqual(await first.evaluate((node) => document.activeElement === node), true);
        });
        const currentHash = new URL(page.url()).hash;
        const upload = drawer.locator('[name="files"]');
        await upload.setInputFiles({ name: '立项依据.txt', mimeType: 'text/plain', buffer: Buffer.from('立项依据卡片的真实上传') });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const url = '**/api/sysbuild/projects/' + pid + '/attachments/stage';
        const bindingUrl = '**/api/sysbuild/nodes/' + node.id + '/materials/initiation-basis/versions';
        let releaseBinding;
        const holdBinding = new Promise((resolve) => { releaseBinding = resolve; });
        const waitForUpload = async (route) => { await gate; await route.continue(); };
        await page.route(url, waitForUpload);
        await page.route(bindingUrl, async (route) => { await holdBinding; await route.continue(); });
        try {
            await Promise.all([
                page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/projects/' + pid + '/attachments/stage')),
                drawer.getByRole('button', { name: '保存立项依据版本', exact: true }).click(),
            ]);
            await drawer.locator('form[data-submitting="true"]').waitFor();
            const rail = page.locator('.sbui-project-rail');
            await rail.locator('a[href*="tab=opinions"]').evaluate((link) => link.click());
            assert.strictEqual(new URL(page.url()).hash, currentHash);
            await target('step6-drawer-focus', async () => {
                const more = page.locator('.sbui-project-more summary');
                assert.strictEqual(await more.evaluate((node) => !!node.closest('[inert]')), true, '抽屉打开时背景命令不可交互');
                await more.evaluate((node) => node.focus());
                await page.keyboard.press('Tab');
                assert.strictEqual(await page.evaluate(() => !!document.activeElement.closest('.sbui-drawer')), true);
            });
            await target('step6-drawer-kept', async () => {
                await page.evaluate(() => new Promise((resolve) => {
                    window.addEventListener('hashchange', () => resolve(), { once: true });
                    history.back();
                }));
                await page.waitForFunction((hash) => location.hash === hash, currentHash, { timeout: 2500 });
                await drawer.locator('form[data-submitting="true"]').waitFor();
                await page.evaluate(() => new Promise((resolve) => {
                    window.addEventListener('hashchange', () => resolve(), { once: true });
                    location.hash = '#help=1';
                }));
                await page.waitForFunction((hash) => location.hash === hash, currentHash, { timeout: 2500 });
                await drawer.locator('form[data-submitting="true"]').waitFor();
                await page.evaluate(() => new Promise((resolve) => {
                    Object.defineProperty(window, 'navigation', { value: undefined, configurable: true });
                    window.addEventListener('hashchange', () => resolve(), { once: true });
                    history.back();
                }));
                assert.strictEqual(new URL(page.url()).hash, currentHash);
                const binding = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/nodes/' + node.id + '/materials/initiation-basis/versions'));
                release();
                await binding;
                await page.keyboard.press('Escape');
                assert.strictEqual(await drawer.isVisible(), true);
                await page.locator('.sbui-drawer-shade').evaluate((shade) => shade.click());
                assert.strictEqual(await drawer.isVisible(), true);
                await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
                assert.strictEqual(new URL(page.url()).hash, currentHash);
            });
        } finally {
            release();
            releaseBinding();
        }
        await drawer.getByText('已完成', { exact: true }).waitFor();
        await page.unroute(url, waitForUpload);
        await page.unroute(bindingUrl);
        await target('step6-drawer-fallback-history', async () => {
            await page.evaluate(() => history.back());
            await drawer.waitFor({ state: 'hidden', timeout: 3000 });
            assert.strictEqual(new URL(page.url()).hash, stageUrl);
        });
        const material = (await call('GET', projectPath + '/materials')).materials.find((m) => m.node_id === node.id && m.material_key === 'initiation-basis');
        assert.strictEqual(material.versions.length, 1);
        const packageId = (await call('POST', projectPath + '/packages', { type: 'initiation' }, 201)).package.id;
        const versionId = (await call('POST', '/packages/' + packageId + '/versions', {}, 201)).version.id;
        await call('PATCH', '/package-versions/' + versionId, { snapshot_json: { text: '本项目实际立项依据', material_version_ids: [material.versions[0].id] } });
        await call('POST', '/package-versions/' + versionId + '/submit', {});
        const task = (await call('GET', '/package-versions/' + versionId + '/confirm-tasks')).tasks[0];
        const opened = await api(people.fixtureOwner, 'GET', '/confirm-tasks/' + task.task_id);
        await api(people.fixtureOwner, 'POST', '/confirm-tasks/' + task.task_id + '/decide', {
            revision_id: opened.revision.id, object_version_id: opened.task.object_version_id,
            decision: 'confirm', checkbox_text: opened.checkbox_texts.confirm,
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        const confirmation = card('立项确认');
        await confirmation.getByText('已生效', { exact: true }).waitFor();
        assert.strictEqual(await confirmation.getByRole('button', { name: '重新发起确认' }).count(), 0);
        await confirmation.getByRole('link', { name: '查看卡片', exact: true }).click();
        await drawer.getByRole('button', { name: '重新发起确认', exact: true }).click();
        await drawer.getByRole('heading', { name: /立项与授权 v2/ }).waitFor();
        const newId = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('version'));
        assert.ok(newId && newId !== versionId);
        const v2 = await call('GET', '/package-versions/' + newId);
        assert.strictEqual(v2.version.status, 'draft');
        if (!v2.actions.submit) {
            await call('PATCH', '/package-versions/' + newId, { snapshot_json: { text: '第二次立项确认内容', material_version_ids: [material.versions[0].id] } });
        }
        await call('POST', '/package-versions/' + newId + '/submit', {});
        await visit(page, stageUrl);
        await target('step6-card-effective-state', async () => {
            await confirmation.getByText('已生效', { exact: true }).waitFor();
            assert.strictEqual(await confirmation.getByText('待确认', { exact: true }).count(), 0);
        });
        await confirmation.getByRole('link', { name: '查看卡片', exact: true }).click();
        await drawer.getByText('待确认', { exact: true }).waitFor();
        await drawer.getByText('已生效', { exact: true }).waitFor();
    }]];
}

function handoffCases({ people, api, project, assignParty, pageFor, visit, suffix, options, target, out, env, sql, preparePairVersion }) {
    const pmCall = (method, url, data, status) => api(people.pm, method, url, data, status);
    const projectHref = (id, tail) => '#project=' + id + (tail ? '&' + tail : '');
    const drawer = (page) => page.locator('.sbui-drawer');
    const rail = (page) => page.locator('.sbui-project-rail');
    async function rejectedAddress(page, href, message) {
        const address = new URL(href, env.baseUrl + '/Sys_Build.html');
        await page.goto(address.toString(), { waitUntil: 'domcontentloaded' });
        const notice = page.locator('#sbuiNotice .sbui-notice.error');
        if (message) await notice.filter({ hasText: new RegExp('^' + message + '$') }).waitFor();
        else await page.getByRole('heading', { name: '当前操作不可用', exact: true }).waitFor();
        assert.strictEqual(await drawer(page).count(), 0);
    }
    async function assertProjectReadDenial(page, href, paths) {
        const results = new Map();
        let complete;
        let timer;
        const settled = new Promise((resolve, reject) => {
            complete = resolve;
            timer = setTimeout(() => reject(new Error('部分项目读取没有结束：' + JSON.stringify(Object.fromEntries(results)))), 10000);
        });
        function record(url, outcome) {
            const path = new URL(url).pathname;
            if (!paths.includes(path) || results.has(path)) return;
            results.set(path, outcome);
            if (results.size === paths.length) complete();
        }
        const response = (item) => record(item.url(), { status: item.status() });
        const failed = (item) => record(item.url(), { error: item.failure()?.errorText });
        page.on('response', response);
        page.on('requestfailed', failed);
        try {
            await Promise.all([rejectedAddress(page, href), settled]);
            assert.ok([...results.values()].some((result) => result.status === 404), '浏览器须收到本项目的实际 404');
            for (const [path, result] of results) {
                if (result.status !== undefined) assert.strictEqual(result.status, 404, path);
                else assert.strictEqual(result.error, 'net::ERR_ABORTED', path);
            }
        } finally {
            clearTimeout(timer);
            page.off('response', response);
            page.off('requestfailed', failed);
        }
    }
    async function setParties(pid) {
        await assignParty(pid, 'demand', '库存管理需求部门', people.owner, people.delegate);
        await assignParty(pid, 'dev', '系统开发组', people.member, people.outsider);
    }
    async function confirmVersion(id, person, submitOnly = false) {
        await pmCall('POST', '/package-versions/' + id + '/submit', {});
        const { tasks } = await pmCall('GET', '/package-versions/' + id + '/confirm-tasks');
        assert.strictEqual(tasks.length, 1);
        if (submitOnly) return tasks[0].current_revision.id;
        const task = await api(person, 'GET', '/confirm-tasks/' + tasks[0].task_id);
        await api(person, 'POST', '/confirm-tasks/' + tasks[0].task_id + '/decide', {
            revision_id: task.revision.id, object_version_id: task.task.object_version_id,
            decision: 'confirm', checkbox_text: task.checkbox_texts.confirm,
        });
        return id;
    }
    async function makeVersion(pid, type, batch, content = '库存项目走查用的真实确认正文') {
        const packageBody = batch ? { type, batch_id: batch } : { type };
        const { package: pkg } = await pmCall('POST', '/projects/' + pid + '/packages', packageBody, 201);
        const { version: { id } } = await pmCall('POST', '/packages/' + pkg.id + '/versions', {}, 201);
        if (type === 'overall' || type === 'batch_accept') await preparePairVersion(pid, id, type);
        else await pmCall('PATCH', '/package-versions/' + id, { snapshot_json: { text: content } });
        return id;
    }
    async function prepareInitiation(pid, stage, text) {
        await pmCall('POST', '/nodes/' + stage.id + '/materials/initiation-basis/not-applicable',
            { reason: '立项经过线下讨论，暂时没有独立书面凭据' }, 201);
        return makeVersion(pid, 'initiation', null, text);
    }
    async function planRange(pid, nodePlan) {
        const { project: detail } = await pmCall('GET', '/projects/' + pid);
        const start = detail.created_at.slice(0, 10);
        const future = new Date(start + 'T00:00:00Z');
        future.setUTCDate(future.getUTCDate() + 10);
        const deadline = future.toISOString().slice(0, 10);
        const milestone = nodePlan.nodes.find((node) => node.is_golive_milestone);
        const closing = nodePlan.nodes.find((node) => node.template_key === 'p_closing');
        for (const node of [milestone, closing]) {
            await pmCall('POST', '/nodes/' + node.id + '/schedule',
                { kind: 'plan', planned_start: start, planned_end: deadline }, 201);
        }
        await confirmVersion(await makeVersion(pid, 'overall'), people.delegate);
        return { milestone, closing, deadline, batch: nodePlan.batches[0].id };
    }
    async function findBox(locator, width) {
        await locator.waitFor();
        await locator.evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)); });
        const box = await locator.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify({ width, box }));
        return box;
    }
    async function snap(page, width, label) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const app = page.locator('#sysbuildApp');
        assert.strictEqual(await app.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false, label + ' 主区出现横向溢出');
        assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, label + ' 文档出现横向滚动');
        await page.screenshot({ path: path.join(out, 'step6-' + width + '-' + label + '.png'), animations: 'disabled' });
    }
    return [[LEGACY, async (page) => {
        const pid = await project('既有地址_' + suffix);
        const plan = await pmCall('GET', '/projects/' + pid + '/plan');
        const node = plan.nodes.find((n) => n.template_key === 'p_initiation');
        const dev = plan.nodes.find((n) => n.template_key === 'b_dev');
        const record = (await pmCall('POST', '/projects/' + pid + '/entries',
            { type: 'note', node_id: node.id, title: '地址测试原登记', body: '地址测试的历史登记原文' }, 201)).entry;
        const material = (await pmCall('POST', '/nodes/' + node.id + '/materials/route-test/versions',
            { name: '地址测试材料', body: '地址测试保留的材料原文' }, 201)).version;
        const packageText = '旧通知准确到达的确认全文';
        const version = await prepareInitiation(pid, node, packageText);
        const confirmationRevision = await confirmVersion(version, people.fixtureOwner, true);
        const taskId = (await pmCall('GET', '/package-versions/' + version + '/confirm-tasks')).tasks[0].task_id;
        await target('step6-legacy-drawers', async () => {
            await visit(page, '?project=' + pid + '&tab=overview&version=' + version);
            await drawer(page).getByText(packageText, { exact: true }).waitFor();
            assert.strictEqual(await rail(page).locator('[aria-current="page"]').innerText(), '全部记录');
            await drawer(page).getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await page.getByRole('heading', { name: '对方确认', exact: true }).waitFor();
            await visit(page, projectHref(pid, 'tab=other&material_version=' + material.id));
            await drawer(page).getByText('地址测试保留的材料原文', { exact: true }).waitFor();
            await drawer(page).getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await page.getByRole('heading', { name: '材料版本与采纳依据', exact: true }).waitFor();
            await visit(page, projectHref(pid, 'entry=' + record.id));
            await drawer(page).getByText('地址测试的历史登记原文', { exact: true }).waitFor();
        });
        await target('step6-retired-before-detail', async () => {
            for (const tail of ['tab=items&entry=' + record.id, 'tab=history', 'tab=setup&step=3&entry=' + record.id, 'invitation=1', 'delegation=1', 'tab=unknown']) {
                await visit(page, projectHref(pid, tail));
                await page.getByRole('heading', { name: '节点推进', exact: true }).waitFor();
                assert.strictEqual(await drawer(page).count(), 0);
            }
        });
        const leader = await pageFor(people.fixtureOwner, options.mutation);
        try {
            await target('step6-revision-first', async () => {
                await visit(leader.page, '?project=' + pid + '&tab=materials&material_version=' + material.id + '&rev=' + confirmationRevision);
                await leader.page.getByRole('heading', { name: '本人作出决定', exact: true }).waitFor();
                await leader.page.getByText(packageText, { exact: true }).waitFor();
                assert.strictEqual(await drawer(leader.page).count(), 0);
            });
            await target('step6-task-first', async () => {
                await visit(leader.page, '?project=' + pid + '&tab=materials&material_version=' + material.id + '&task=' + taskId);
                await leader.page.getByRole('heading', { name: '本人作出决定', exact: true }).waitFor();
                await leader.page.getByText(packageText, { exact: true }).waitFor();
                assert.strictEqual(await drawer(leader.page).count(), 0);
            });
            await target('step6-direct-disallowed-tab', async () => {
                const reads = [];
                const track = (request) => { if (new URL(request.url()).pathname.endsWith('/send-intents')) reads.push(request.url()); };
                leader.page.on('request', track);
                try {
                    await visit(leader.page, projectHref(pid, 'tab=notifications'));
                    await leader.page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).waitFor();
                    await leader.page.getByText('当前账号不能查看该项目页签。', { exact: true }).waitFor();
                    assert.strictEqual(await rail(leader.page).locator('a[href*="tab=notifications"]').count(), 0);
                    assert.deepStrictEqual(reads, []);
                } finally { leader.page.off('request', track); }
                await api(people.fixtureOwner, 'GET', '/projects/' + pid + '/send-intents', undefined, 403);
            });
        } finally { await leader.context.close(); }
        await visit(page, '?invitation=1');
        await page.getByRole('heading', { name: '我参与的项目', exact: true }).waitFor();
        await pmCall('POST', '/nodes/' + dev.id + '/cancel', { reason: '用历史地址查取消后的阶段' });
        await visit(page, projectHref(pid, 'tab=plan&node=' + dev.id));
        await page.getByRole('heading', { name: dev.name + ' · 已取消', exact: true }).waitFor();
        assert.strictEqual(await rail(page).locator('a[href*="node=' + dev.id + '"]').count(), 0);
        const other = await project('旧地址项目边界_' + suffix);
        const otherPlan = await pmCall('GET', '/projects/' + other + '/plan');
        const task = (await pmCall('POST', '/nodes/' + node.id + '/tasks', { title: '地址测试项目内任务', assignee_user_id: people.pm.id }, 201)).task;
        const opinion = (await pmCall('POST', '/projects/' + pid + '/opinions', { title: '旧地址项目内意见', body: '用来确认外项目抽屉不会读取本项目原文。' }, 201)).opinion;
        await rejectedAddress(page, projectHref(pid, 'tab=plan&node=' + otherPlan.nodes[0].id + '&card=initiation-basis'), '该节点不属于当前项目');
        await rejectedAddress(page, projectHref(pid, 'tab=plan&node=' + dev.id + '&card=initiation-basis'), '该卡片不属于当前阶段');
        await rejectedAddress(page, projectHref(other, 'tab=plan&work_task=' + task.id), '该任务不属于当前项目阶段');
        assert.strictEqual(await page.getByText(task.title, { exact: true }).count(), 0);
        await rejectedAddress(page, projectHref(other, 'entry=' + record.id), '该登记不属于当前项目');
        assert.strictEqual(await page.getByText('地址测试的历史登记原文', { exact: true }).count(), 0);
        await rejectedAddress(page, projectHref(other, 'version=' + version), '该内容包版本不属于当前项目');
        assert.strictEqual(await page.getByText(packageText, { exact: true }).count(), 0);
        await rejectedAddress(page, projectHref(other, 'material_version=' + material.id), '该材料版本不属于当前项目');
        assert.strictEqual(await page.getByText('地址测试保留的材料原文', { exact: true }).count(), 0);
        await rejectedAddress(page, projectHref(other, 'tab=opinions&opinion=' + opinion.id), '该意见不属于当前项目');
        assert.strictEqual(await page.getByText(opinion.title, { exact: true }).count(), 0);
        assert.strictEqual(await page.getByText(opinion.body, { exact: true }).count(), 0);
        const member = (await pmCall('POST', '/projects/' + pid + '/members', { user_id: people.outsider.id, party_id: null }, 201)).member;
        const reads = ['', '/plan', '/materials', '/opinions'].map((tail) => '/projects/' + pid + tail);
        for (const route of reads) await api(people.outsider, 'GET', route);
        await pmCall('POST', '/members/' + member.id + '/remove', { reason: '核实项目资料不会继续显示给已移出成员' });
        for (const route of reads) {
            const denied = await api(people.outsider, 'GET', route, undefined, 404);
            assert.strictEqual(denied.code, 'SYSBUILD_NOT_FOUND', route);
        }
        const outsider = await pageFor(people.outsider, options.mutation);
        try {
            await assertProjectReadDenial(outsider.page, projectHref(pid, 'invitation=1&entry=' + record.id), reads.map((route) => '/api/sysbuild' + route));
            assert.strictEqual(await outsider.page.getByRole('heading', { name: '节点推进' }).count(), 0);
            assert.strictEqual(await outsider.page.getByText('地址测试的历史登记原文', { exact: true }).count(), 0);
        } finally { await outsider.context.close(); }
    }], [VISUAL, async () => {
        const names = { pm: '李敏', owner: '陈洁', delegate: '赵倩', member: '王远', outsider: '周宁', fixtureOwner: '许宁', fixtureDelegate: '孙阳' };
        for (const [role, displayName] of Object.entries(names)) {
            await sql(env.dbPath, 'UPDATE users SET display_name=? WHERE id=?', [displayName, people[role].id]);
            people[role].display_name = displayName;
        }
        const title = '库存协同平台 · ' + suffix.slice(0, 4);
        const active = await project(title + ' · 进行中');
        const paused = await project(title + ' · 暂停');
        const closed = await project(title + ' · 已结项');
        for (const pid of [active, closed]) await setParties(pid);
        const activePlan = await pmCall('GET', '/projects/' + active + '/plan');
        const start = activePlan.nodes.find((node) => node.template_key === 'p_initiation');
        const development = activePlan.nodes.find((node) => node.template_key === 'b_dev');
        await confirmVersion(await prepareInitiation(active, start), people.owner);
        await planRange(active, activePlan);
        await pmCall('POST', '/nodes/' + development.id + '/start', {});
        const doneTitle = '已经有结论的库存核对意见';
        const pendingTitle = '请负责人核对库存短信调整';
        const dismissed = (await pmCall('POST', '/projects/' + active + '/opinions',
            { title: doneTitle, body: '库存核对的旧流程已经覆盖本事项。' }, 201)).opinion.id;
        await pmCall('POST', '/opinions/' + dismissed + '/actions',
            { action: 'triage', category: 'problem', decision: 'no', text: '继续沿用已有的库存记录' });
        const pending = (await api(people.outsider, 'POST', '/projects/' + active + '/opinions',
            { title: pendingTitle, body: '保留站内提醒，短信接口建议从本期范围移出。', estimated_hours: 0 }, 201)).opinion.id;
        await pmCall('POST', '/opinions/' + pending + '/actions',
            { action: 'triage', category: 'cut', decision: 'continue', text: '请原范围需求部门核对替代方案。' });
        const pausedPlan = await pmCall('GET', '/projects/' + paused + '/plan');
        await pmCall('POST', '/nodes/' + pausedPlan.nodes.find((n) => n.template_key === 'b_dev').id + '/start', {});
        await api(people.admin, 'POST', '/projects/' + paused + '/status', { to: 'paused', reason: '演示暂缓后恢复前的阶段状态' });
        const closedPlan = await pmCall('GET', '/projects/' + closed + '/plan');
        await confirmVersion(await prepareInitiation(closed, closedPlan.nodes.find((n) => n.template_key === 'p_initiation')), people.owner);
        const done = await planRange(closed, closedPlan);
        await confirmVersion(await makeVersion(closed, 'batch_accept', done.batch), people.delegate);
        await pmCall('POST', '/batches/' + done.batch + '/golive', {});
        let live = false;
        for (let attempt = 0; attempt < 25 && !live; attempt += 1) {
            const data = await pmCall('GET', '/projects/' + closed + '/materials');
            live = data.cards.some((card) => card.key === 'golive' && card.complete);
            if (!live) await delay(200);
        }
        assert.ok(live, '上线事件已进入结项可核对的事实');
        await pmCall('POST', '/nodes/' + done.milestone.id + '/materials/operations-handover/not-applicable',
            { reason: '演示项目由原值守人员继续维护' }, 201);
        await pmCall('POST', '/nodes/' + done.closing.id + '/start', {});
        await confirmVersion(await makeVersion(closed, 'closing'), people.delegate);
        await pmCall('POST', '/nodes/' + done.closing.id + '/close', {});
        const developer = await pageFor(people.outsider, options.mutation);
        const responsible = await pageFor(people.delegate, options.mutation);
        const leader = await pageFor(people.owner, options.mutation);
        const manager = await pageFor(people.pm, options.mutation);
        const page = manager.page;
        try {
            for (const width of [1440, 1280, 1024]) {
                for (const p of [page, developer.page, responsible.page, leader.page]) await p.setViewportSize({ width, height: 1050 });
                await visit(page, '#scope=mine');
                await page.getByRole('searchbox', { name: '搜索项目', exact: true }).fill(title);
                await page.locator('article.sbui-project-card').filter({ hasText: title + ' · 进行中' }).waitFor();
                await page.locator('article.sbui-project-card').filter({ hasText: title + ' · 暂停' }).getByText('范围未确认已开工', { exact: true }).waitFor();
                const archived = page.getByRole('row').filter({ hasText: title + ' · 已结项' });
                await archived.getByText(done.deadline, { exact: true }).waitFor();
                assert.strictEqual(await archived.locator('.sbui-countdown').count(), 0);
                const archivedBox = await archived.boundingBox();
                assert.ok(archivedBox.y + archivedBox.height <= 1050, '首页截图包含紧凑结项行');
                await page.getByRole('heading', { name: '我参与的项目', exact: true }).click();
                const geometry = await page.evaluate(() => {
                    const top = document.querySelector('nav[aria-label="平台导航"]');
                    return { viewport: innerWidth, document: document.documentElement.scrollWidth, top: top.clientWidth, topContent: top.scrollWidth };
                });
                console.log('    第六步页宽（视口、文档、共享顶栏、顶栏内容） ' + JSON.stringify(geometry));
                await snap(page, width, '首页-PM');

                await visit(developer.page, projectHref(active, 'tab=plan&node=' + development.id));
                await developer.page.locator('.sbui-report-summary').getByText(/^默认周期：每两周/).waitFor();
                await developer.page.getByRole('button', { name: '提交进度汇报', exact: true }).waitFor();
                const head = await findBox(developer.page.locator('.sbui-project-header'), width);
                assert.ok(head.height < 64, '项目头部须保持一行');
                await developer.page.locator('.sbui-head-estimate .sbui-countdown.warning').waitFor();
                await snap(developer.page, width, '阶段-开发负责人');

                await visit(responsible.page, projectHref(active, 'tab=opinions'));
                const row = responsible.page.getByRole('row').filter({ hasText: pendingTitle });
                await target('step6-pending-opinion', async () => {
                    await row.getByText('待需求方负责人同意', { exact: true }).waitFor();
                    await row.getByText(development.name + ' #' + development.id, { exact: true }).waitFor();
                    await row.getByText('库存管理需求部门 · ' + people.delegate.display_name, { exact: true }).waitFor();
                    assert.strictEqual(await responsible.page.getByRole('link', { name: doneTitle, exact: true }).count(), 0);
                    assert.strictEqual(await rail(responsible.page).getByRole('link', { name: /^意见/ }).locator('.sbui-rail-count').innerText(), '1');
                });
                await snap(responsible.page, width, '意见-需求负责人');

                await visit(page, projectHref(active, 'tab=plan&node=' + start.id + '&card=initiation-basis'));
                await drawer(page).getByRole('button', { name: '保存立项依据版本', exact: true }).waitFor();
                const box = await findBox(drawer(page), width);
                assert.ok(Math.abs(box.width - 600) <= 1 && Math.abs(box.y - 64) <= 1, JSON.stringify(box));
                await snap(page, width, '立项依据抽屉-PM');
            }
            await responsible.page.getByRole('link', { name: '全部意见', exact: true }).click();
            await responsible.page.getByRole('link', { name: doneTitle, exact: true }).waitFor();
            await responsible.page.getByRole('row').filter({ hasText: pendingTitle }).getByRole('link', { name: pendingTitle, exact: true }).click();
            await drawer(responsible.page).getByRole('button', { name: '本人表态', exact: true }).waitFor();
            await drawer(responsible.page).getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await responsible.page.getByRole('link', { name: doneTitle, exact: true }).waitFor();
            await visit(leader.page, projectHref(active, 'tab=opinions&opinion=' + pending));
            await drawer(leader.page).getByRole('heading', { name: '需求部门表态', exact: true }).waitFor();
            assert.strictEqual(await leader.page.getByRole('button', { name: '本人表态', exact: true }).count(), 0);
            assert.strictEqual(await rail(leader.page).locator('a[href*="tab=notifications"]').count(), 0);
            await snap(leader.page, 1024, '意见抽屉-需求领导');
        } finally {
            await developer.context.close();
            await responsible.context.close();
            await leader.context.close();
            await manager.context.close();
        }
    }]];
}

function defineCases(context) {
    return [...homeAndDrawerCases(context), ...handoffCases(context)];
}

const MUTATIONS = [
    { id: 'step6-ignore-default-todo', file: 'sysbuild-page.js', from: "if (!params.toString() && data.default_view === 'todo')", to: 'if (false)', expect: HOME, expectFailure: '[step6-default-view]' },
    { id: 'step6-return-home-redirects-again', file: 'sysbuild-ui.js', from: "link('项目列表', { scope: 'mine' })", to: "link('项目列表', {})", expect: HOME, expectFailure: '[step6-explicit-home]' },
    { id: 'step6-basis-inline', file: 'sysbuild-content.js', from: 'if (basis && cardKey) content.push(materialForm', to: 'if (basis) content.push(materialForm', expect: DRAWER, expectFailure: '[step6-basis-drawer-only]' },
    { id: 'step6-drawer-allows-back-during-upload', file: 'sysbuild-ui.js', from: 'if (drawerBusy() && location.hash !== acceptedHash && location.hash !== programmaticHash)', to: 'if (false)', expect: DRAWER, expectFailure: '[step6-drawer-kept]' },
    { id: 'step6-drawer-background-action-enabled', file: 'sysbuild-page.js', from: 'host.inert = true;', to: 'host.inert = false;', expect: DRAWER, expectFailure: '[step6-drawer-focus]' },
    { id: 'step6-drawer-does-not-cycle-tab', file: 'sysbuild-ui.js', from: "if (event.key !== 'Tab') return;", to: "return;", expect: DRAWER, expectFailure: '[step6-drawer-tab-cycle]' },
    { id: 'step6-reissue-only-initiation', file: 'sysbuild-content.js', from: "['initiation', 'batch_accept', 'closing'].includes(card.key)", to: "card.key === 'initiation'", expect: '第三步 PM、领导、负责人四关口与遮蔽走查', expectFailure: '[step6-reissue-acceptance-and-closing]' },
    { id: 'step6-drawer-fallback-replaces-stage', file: 'sysbuild-ui.js', from: 'if (location.hash === previousHash) history.pushState', to: 'if (false) history.pushState', expect: DRAWER, expectFailure: '[step6-drawer-fallback-history]' },
    { id: 'step6-effective-card-shows-unapproved-as-current', file: 'sysbuild-content.js', from: "open?.status === 'pending' && (!effective || cardKey)", to: "open?.status === 'pending'", expect: DRAWER, expectFailure: '[step6-card-effective-state]' },
    { id: 'step6-legacy-version-prefers-tab', file: 'sysbuild-page.js', from: "if (params.has('version')) return 'packages';", to: "if (params.has('version') && !params.has('tab')) return 'packages';", expect: LEGACY, expectFailure: '[step6-legacy-drawers]' },
    { id: 'step6-retired-collides-with-new-entry', file: 'sysbuild-page.js', from: "if (retiredProjectAddress(params, requestedTab)) return 'overview';", to: "if (retiredProjectAddress(params, requestedTab) && !params.has('entry')) return 'overview';", expect: LEGACY, expectFailure: '[step6-retired-before-detail]' },
    { id: 'step6-direct-unauthorized-tab-is-opened', file: 'sysbuild-page.js', from: "const tab = tabIsVisible(requestedTab, detail) ? requestedTab : 'overview';", to: "const tab = requestedTab;", expect: LEGACY, expectFailure: '[step6-direct-disallowed-tab]' },
    { id: 'step6-legacy-rev-loses-to-project', file: 'sysbuild-ui.js', from: "params.has('rev') ? 'revision'", to: "params.has('rev') && !params.has('project') ? 'revision'", expect: LEGACY, expectFailure: '[step6-revision-first]' },
    { id: 'step6-legacy-task-loses-to-project', file: 'sysbuild-ui.js', from: "params.has('task') ? 'task'", to: "params.has('task') && !params.has('project') ? 'task'", expect: LEGACY, expectFailure: '[step6-task-first]' },
    { id: 'step6-opinion-list-includes-concluded-by-default', file: 'sysbuild-work.js', from: 'filter((item) => all || item.is_pending)', to: 'filter(() => true)', expect: VISUAL, expectFailure: '[step6-pending-opinion]' },
];

module.exports = { defineCases, MUTATIONS };
