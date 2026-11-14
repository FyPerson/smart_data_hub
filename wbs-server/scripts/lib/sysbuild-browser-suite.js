'use strict';
// Intended destination: wbs-server/scripts/lib/sysbuild-browser-suite.js.
// Test only the browser-facing contract; permissions/state machines remain in the API suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const stage8 = require('./sysbuild-browser-stage8');
// 只标记单个目标断言 / 等待；长场景其他位置失败不能冒作该变异的目标失败。
async function target(id, task) {
    try { return await task(); }
    catch (error) { error.message = '[' + id + '] ' + error.message; throw error; }
}

const FRONT_MUTATIONS = [
    { id: 'text-sink', file: 'sysbuild-ui.js', from: 'n.textContent = String(text);', to: 'n.innerHTML = String(text);', expect: '文字按原文显示', expectFailure: '[literal-text]' },
    { id: 'session-clear', file: 'sysbuild-ui.js', from: "if (e.key !== 'token' && e.key !== 'user' && e.key !== null) return;\n        clearSession();", to: "if (e.key !== 'token' && e.key !== 'user' && e.key !== null) return;\n        void 0;", expect: '换号清理', expectFailure: '[session-cleared]' },
    { id: 'request-session-guard', file: 'sysbuild-ui.js', from: 'if (!valid(c)) throw new StaleView();', to: 'if (false) throw new StaleView();', expect: '旧表单不能跨登录提交', expectFailure: 'account change must be rejected before issuing a write' },
    { id: 'form-repeat', file: 'sysbuild-ui.js', from: 'if (busy || !f.reportValidity()) return;', to: 'if (!f.reportValidity()) return;', expect: '重复提交', expectFailure: 'only the first submit may issue a POST' },
    { id: 'invite-route-priority', file: 'sysbuild-ui.js', from: "const key = params.has('invitation') ? 'invitation'", to: "const key = params.has('project') ? 'project' : params.has('invitation') ? 'invitation'", expect: '邀请窄范围入口', expectFailure: '[invitation-context]' },
    { id: 'query-link', file: 'sysbuild-ui.js', from: "if (!location.hash && location.search) history.replaceState(null, '', location.pathname + '#' + location.search.slice(1));", to: 'if (false) history.replaceState(null, "", location.pathname);', expect: '邀请窄范围入口', expectFailure: '[invitation-context]' },
    { id: 'new-project-capability', file: 'sysbuild-page.js', from: 'if (data.actions && data.actions.create === true) ops.appendChild', to: 'if (true) ops.appendChild', expect: '只读账号的入口', expectFailure: '[readonly-create]' },
    { id: 'pending-join-label', file: 'sysbuild-members.js', from: "pending: '待本人接受'", to: "pending: '已生效'", expect: '成员加入与任职分开', expectFailure: '[pending-join]' },
    { id: 'platform-nav', file: 'app.js', from: "projectLink.textContent = '项目管理';", to: "projectLink.textContent = '错误入口';", expect: '平台导航入口', expectFailure: '[platform-nav]' },
    { id: 'delegation-submit-target', file: 'sysbuild-members.js', from: "save('/parties/' + p.id + '/' + kind, { member_id: A.id(v.member_id) }, c)", to: "save('/parties/' + p.id + '/appointments', { member_id: A.id(v.member_id) }, c)", expect: '任职与授权完整链', expectFailure: '[delegation-submitted]' },
    { id: 'proxy-drop-evidence', file: 'sysbuild-ui.js', from: 'ids.push(result.attachment.id);', to: 'void result.attachment.id;', expect: '无账号任职代录', expectFailure: '[proxy-appointment-active]' },
    { id: 'empty-role-as-waiting', file: 'sysbuild-members.js', from: "member ? member.name : '暂无生效记录'", to: "member ? member.name : '等待本人接受'", expect: '成员加入与任职分开', expectFailure: '没有任职提议时不得伪造等待本人接受' },
    { id: 'dialog-generation', file: 'sysbuild-ui.js', from: ' && (c.dialog === undefined || c.dialog === state.dialog)', to: '', expect: '异步弹窗不串参与方', expectFailure: '晚到的旧请求不能覆盖最后选择的参与方' },
    { id: 'dialog-close-while-submitting', file: 'sysbuild-ui.js', from: 'if (closeButton) closeButton.disabled = true;', to: 'if (closeButton) closeButton.disabled = false;', expect: '提交中保留弹窗', expectFailure: '[dialog-close-disabled]' },
    { id: 'readonly-member-description', file: 'sysbuild-page.js', from: '当前账号不提供登记与维护权限。', to: '可以登记事实与个人意见。', expect: '只读账号的入口', expectFailure: '[readonly-description]' },
    { id: 'g0-snapshot-content', file: 'sysbuild-page.js', from: '{ ...v.snapshot_json, text: values.text }', to: '{ ...v.snapshot_json, ignored_text: values.text }', expect: '新建三步保存与恢复', expectFailure: '[g0-saved-content]' },
    { id: 'g0-submit-version', file: 'sysbuild-page.js', from: "'/package-versions/' + version.id + '/submit'", to: "'/package-versions/' + (version.id + 999999) + '/submit'", expect: '新建三步保存与恢复', expectFailure: '[g0-submitted]' },
    { id: 'g0-pending-hint', file: 'sysbuild-page.js', from: '本版已发起，等待必需确认人处理。', to: '如需提交，请先补齐需求方现任负责人及服务端列明的前置条件。', expect: '新建三步保存与恢复', expectFailure: '[g0-submitted]' },
    { id: 'g0-unsaved-submit', file: 'sysbuild-page.js', from: 'assertSavedInitiation(); await A.request', to: 'await A.request', expect: '未保存立项内容阻止发起', expectFailure: '[g0-unsaved-submit]' },
    { id: 'package-unsaved-submit', file: 'sysbuild-packages.js', from: 'assertSavedDraft(); await A.request', to: 'await A.request', expect: '未保存草稿正文与材料阻止发起', expectFailure: '[package-unsaved-text]' },
    { id: 'package-unsaved-materials', file: 'sysbuild-packages.js', from: ' || JSON.stringify(materials) !== JSON.stringify(savedMaterials)', to: '', expect: '未保存草稿正文与材料阻止发起', expectFailure: '[package-unsaved-materials]' },
    ...stage8.MUTATIONS,
];
function cleanupArtifacts(dir) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !/^sysbuild-browser-/.test(path.basename(resolved))) throw new Error('Refuse artifact cleanup outside the private test directory');
    for (const name of fs.readdirSync(resolved)) {
        const item = path.join(resolved, name);
        const st = fs.lstatSync(item);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unexpected artifact type: ' + name);
        fs.unlinkSync(item);
    }
    fs.rmdirSync(resolved);
}

function sql(dbFile, statement, values) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READWRITE, (openError) => {
            if (openError) return reject(openError);
            db.all(statement, values || [], (err, rows) => db.close((closeError) => err || closeError ? reject(err || closeError) : resolve(rows)));
        });
    });
}
async function run(options) {
    const { fx, env } = options;
    const publicDir = path.resolve(__dirname, '../../public');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-browser-'));
    const suffix = crypto.randomBytes(6).toString('hex');
    const people = {};
    for (const role of ['pm', 'owner', 'delegate', 'member', 'outsider', 'admin']) {
        const name = 'sbui_' + role + '_' + suffix;
        await sql(env.dbPath, 'INSERT INTO users (username, password, display_name, role, status) VALUES (?, ?, ?, ?, ?)', [name, 'test-only-not-a-login-password', name, role === 'admin' ? 'admin' : 'user', 'active']);
        const rows = await sql(env.dbPath, 'SELECT id, username, display_name, role FROM users WHERE username = ?', [name]);
        people[role] = rows[0];
    }
    // A read-only leader is configured by platform id, not by role. Only change the private instance copy.
    await sql(env.dbPath, "INSERT OR IGNORE INTO users (id, username, password, display_name, role, status) VALUES (6, ?, 'test-only', 'sbui_readonly', 'viewer', 'active')", ['sbui_ro_' + suffix]);
    await sql(env.dbPath, "UPDATE users SET status = 'active', role = 'viewer', display_name = 'sbui_readonly' WHERE id = 6", []);
    people.readonly = (await sql(env.dbPath, 'SELECT id, username, display_name, role FROM users WHERE id = 6'))[0];
    const tokens = new Map();
    async function token(person) {
        if (!tokens.has(person.id)) tokens.set(person.id, await fx.signAs(person.id));
        return tokens.get(person.id);
    }
    async function api(person, method, route, body, expected) {
        const headers = { Authorization: 'Bearer ' + await token(person) };
        const init = { method, headers };
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        const res = await fetch(env.baseUrl + '/api/sysbuild' + route, init);
        const data = await res.json();
        assert.strictEqual(res.status, expected === undefined ? 200 : expected, method + ' ' + route + ': ' + JSON.stringify(data));
        return data;
    }
    async function project(name) { return (await api(people.pm, 'POST', '/projects', { system_name: name, build_type: 'inhouse', goal: '只供浏览器检查的项目目标' }, 201)).project.id; }
    async function invite(pid, person, partyId) {
        return api(people.pm, 'POST', '/projects/' + pid + '/members', { user_id: person.id, party_id: partyId || null }, 201);
    }
    async function initiationDraft() {
        const pid = await project('未保存内容检查_' + suffix);
        const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '草稿检查需求方' }, 201)).party.id;
        const added = await invite(pid, people.owner, party);
        await api(people.owner, 'POST', '/my/invitations/' + added.invitation.id + '/accept', {});
        const appt = await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: added.member.id }, 201);
        await api(people.owner, 'POST', '/my/invitations/' + appt.invitation.id + '/accept', {});
        const pkg = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pkg + '/versions', {}, 201)).version.id;
        const text = '已保存并待确认的立项范围';
        await api(people.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text } });
        return { pid, vid, text };
    }
    const bundled = fs.existsSync(chromium.executablePath());
    const browser = await chromium.launch(bundled ? { headless: true } : { headless: true, channel: 'chrome' });
    console.log('浏览器：' + (bundled ? 'Playwright Chromium' : '本机 Chrome 通道') + ' ' + browser.version());
    let passed = 0;
    const failures = [];
    const errors = [];
    async function pageFor(person, mutation) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(({ bearer, user }) => { localStorage.setItem('token', bearer); localStorage.setItem('user', JSON.stringify(user)); }, { bearer: await token(person), user: person });
        // Observe the public registration lifecycle without replacing clipboard dispatch or file collection.
        await context.addInitScript(() => {
            let current;
            window.c8PasteStats = { registered: 0, unregistered: 0, reset: 0 };
            Object.defineProperty(window, 'UPaste', { configurable: true, get: () => current, set: (api) => {
                current = api;
                const register = api.register;
                const reset = api.resetSeq;
                api.register = function () {
                    window.c8PasteStats.registered += 1;
                    const dispose = register.apply(this, arguments);
                    return () => { window.c8PasteStats.unregistered += 1; return dispose(); };
                };
                api.resetSeq = function () { window.c8PasteStats.reset += 1; return reset.apply(this, arguments); };
            } });
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        if (mutation) {
            const source = fs.readFileSync(path.join(publicDir, 'assets/js', mutation.file), 'utf8').replace(/\r\n/g, '\n');
            assert.strictEqual(source.split(mutation.from).length - 1, 1, mutation.id + ' anchor must occur once');
            await page.route('**/assets/js/' + mutation.file + '*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: source.replace(mutation.from, options.control === true ? mutation.from : mutation.to) }));
        }
        return { page, context };
    }
    async function visit(page, suffixPath) {
        await page.goto(env.baseUrl + '/Sys_Build.html' + (suffixPath || ''), { waitUntil: 'domcontentloaded' });
        await page.locator('#sbuiView[aria-busy="false"]').waitFor({ timeout: 30000 });
    }
    async function contains(page, text) { await page.getByText(text, { exact: true }).first().waitFor({ timeout: 15000 }); }
    const cases = [
        ['未保存立项内容阻止发起', async (page) => {
            const { pid, vid, text } = await initiationDraft();
            await visit(page, '#project=' + pid + '&tab=setup&step=3');
            let submits = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/package-versions/' + vid + '/submit')) submits += 1; });
            const field = page.getByLabel(/^立项确认内容/);
            await field.fill('尚未保存的立项范围');
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await target('g0-unsaved-submit', () => contains(page, '有未保存的改动，请先保存本版立项内容，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[g0-unsaved-submit] 未保存立项编辑不能发POST');
            assert.strictEqual(await field.inputValue(), '尚未保存的立项范围', '[g0-unsaved-submit] 拦截后保留输入');
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).snapshot_json.text, text, '[g0-unsaved-submit] 拦截后保存快照不变');
            await field.fill(text); // 恢复到保存值后可直接发起。
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await contains(page, '本版已发起，等待必需确认人处理。');
            assert.strictEqual(submits, 1, '恢复保存值后只提交一次');
        }],
        ['未保存草稿正文与材料阻止发起', async (page) => {
            const { pid, vid, text } = await initiationDraft();
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const made = await api(people.pm, 'POST', '/nodes/' + plan.nodes[0].id + '/materials/draft-check/versions', { name: '待保存引用的材料', body: '供本版明确引用的原始材料' }, 201);
            await visit(page, '#project=' + pid + '&tab=packages&version=' + vid);
            let submits = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/package-versions/' + vid + '/submit')) submits += 1; });
            const field = page.getByLabel(/^本版确认正文/);
            await field.fill('尚未保存的包正文');
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await target('package-unsaved-text', () => contains(page, '有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[package-unsaved-text] 未保存正文不能发POST');
            assert.strictEqual(await field.inputValue(), '尚未保存的包正文', '[package-unsaved-text] 拦截后保留正文');
            await field.fill(text);
            const checkbox = page.getByRole('group', { name: /^本版明确引用的材料版本/ }).getByRole('checkbox', { name: '待保存引用的材料 · v1', exact: true });
            await checkbox.check();
            // 清掉第一次提示，第二次必须是材料改动本身触发的新提示。
            await page.evaluate(() => document.getElementById('sbuiNotice').replaceChildren());
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await target('package-unsaved-materials', () => contains(page, '有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[package-unsaved-materials] 未保存材料勾选不能发POST');
            assert.strictEqual(await checkbox.isChecked(), true, '[package-unsaved-materials] 拦截保留勾选');
            await field.fill('明确保存后的包正文');
            await page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
            await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
            const saved = await api(people.pm, 'GET', '/package-versions/' + vid);
            assert.strictEqual(saved.snapshot_json.text, '明确保存后的包正文');
            assert.deepStrictEqual(saved.snapshot_json.material_version_ids, [made.version.id]);
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await page.getByRole('heading', { name: '立项与授权 v1 · 待确认', exact: true }).waitFor();
            assert.strictEqual(submits, 1, '显式保存后发起一次');
        }],
        ['平台导航入口', async (page) => {
            await page.goto(env.baseUrl + '/Task_Pool.html', { waitUntil: 'domcontentloaded' });
            const nav = page.getByRole('navigation').getByRole('link', { name: '项目管理', exact: true });
            await target('platform-nav', () => nav.waitFor());
            assert.ok((await nav.getAttribute('href')).endsWith('/Sys_Build.html'), '[platform-nav] 项目管理入口须指向模块页面');
            await nav.click();
            await page.getByRole('heading', { name: '我参与的项目', exact: true }).waitFor();
        }],
        ['新建三步保存与恢复', async (page) => {
            await visit(page);
            await page.getByRole('link', { name: '新建项目', exact: true }).click();
            await page.getByLabel(/^系统名称/).fill('浏览器新建_' + suffix);
            await page.getByLabel(/^建设方式/).selectOption('inhouse');
            await page.getByLabel(/^建设目标/).fill('新建后必须保留这份目标');
            await page.getByRole('button', { name: '保存并设置需求方', exact: true }).click();
            await page.getByRole('heading', { name: '成员与授权', exact: true }).waitFor();
            const url = new URL(page.url());
            const pid = Number(new URLSearchParams(url.hash.slice(1)).get('project'));
            const detail = await api(people.pm, 'GET', '/projects/' + pid);
            assert.strictEqual(detail.project.goal, '新建后必须保留这份目标');
            assert.strictEqual(detail.project.pm_user_id, people.pm.id);
            assert.strictEqual(detail.members.length, 1, 'no other person is auto-enrolled');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByRole('heading', { name: '成员与授权', exact: true }).waitFor();
            await page.getByRole('button', { name: '添加参与方', exact: true }).click();
            await page.locator('#sbuiDialog select[name="side"]').selectOption('demand');
            await page.locator('#sbuiDialog').getByLabel(/^名称/).fill('新建流程需求方');
            await page.locator('#sbuiDialog').getByRole('button', { name: '保存', exact: true }).click();
            await contains(page, '需求方 · 新建流程需求方');
            const configured = await api(people.pm, 'GET', '/projects/' + pid);
            const party = configured.parties.find((p) => p.name === '新建流程需求方');
            const joined = await invite(pid, people.owner, party.id);
            await api(people.owner, 'POST', '/my/invitations/' + joined.invitation.id + '/accept', {});
            const appointed = await api(people.pm, 'POST', '/parties/' + party.id + '/appointments', { member_id: joined.member.id }, 201);
            await api(people.owner, 'POST', '/my/invitations/' + appointed.invitation.id + '/accept', {});
            await page.getByRole('link', { name: '核对 G0 立项确认', exact: true }).click();
            await page.getByRole('button', { name: '建立立项草稿', exact: true }).click();
            await page.getByLabel(/^立项确认内容/).fill('这份逐字保存的立项范围用于本次G0确认_' + suffix);
            await Promise.all([
                page.waitForResponse((res) => res.request().method() === 'PATCH' && /\/package-versions\/\d+$/.test(new URL(res.url()).pathname)),
                page.getByRole('button', { name: '保存本版立项内容', exact: true }).click(),
            ]);
            await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).waitFor();
            const packages = await api(people.pm, 'GET', '/projects/' + pid + '/packages');
            const version = packages.packages.find((p) => p.type === 'initiation').versions[0];
            const saved = await api(people.pm, 'GET', '/package-versions/' + version.id);
            assert.strictEqual(saved.snapshot_json.text, '这份逐字保存的立项范围用于本次G0确认_' + suffix, '[g0-saved-content] 保存必须包含本次正文');
            await page.getByRole('button', { name: '发起本版 G0 确认', exact: true }).click();
            await target('g0-submitted', () => contains(page, '本版已发起，等待必需确认人处理。'));
            await target('g0-submitted', () => page.getByRole('heading', { name: '立项包 v1 · 待确认', exact: true }).waitFor());
            const submitted = await api(people.pm, 'GET', '/package-versions/' + version.id);
            assert.strictEqual(submitted.version.status, 'pending', '[g0-submitted] 发起后版本须待确认');
            const tasks = await sql(env.dbPath, "SELECT r.id, r.required_member_id, r.status FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.project_id = ? AND t.object_type = 'package_version' AND t.object_version_id = ?", [pid, version.id]);
            assert.strictEqual(tasks.length, 1, 'G0只向本次需求方负责人生成确认任务');
            assert.strictEqual(tasks[0].required_member_id, joined.member.id);
            assert.strictEqual(tasks[0].status, 'pending', '发起不等于代负责人确认');
            const confirmations = await sql(env.dbPath, 'SELECT id FROM sysbuild_confirmations WHERE task_revision_id = ?', [tasks[0].id]);
            assert.strictEqual(confirmations.length, 0);
            assert.strictEqual(await page.getByText('如需提交，请先补齐需求方现任负责人及服务端列明的前置条件。', { exact: true }).count(), 0);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'new-project.png'), fullPage: true });
        }],
        ['文字按原文显示', async (page) => {
            const literal = '<img src=x onerror="window.sbuiXss=1">_' + suffix;
            const pid = await project(literal);
            await visit(page, '#project=' + pid);
            await target('literal-text', async () => {
                assert.strictEqual(await page.locator('#sysbuildApp img').count(), 0, '[literal-text] 用户原文不得生成HTML节点');
                assert.strictEqual(await page.evaluate(() => window.sbuiXss), undefined);
                await page.getByRole('heading', { name: literal, exact: true }).waitFor();
            });
        }],
        ['只读账号的入口', async (page) => {
            await visit(page);
            assert.strictEqual(await page.getByRole('link', { name: '新建项目', exact: true }).count(), 0, '[readonly-create] 只读账号不得出现建项入口');
            await page.getByRole('link', { name: '全部项目', exact: true }).waitFor();
            await page.getByRole('link', { name: '全部项目', exact: true }).click();
            await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
            const pid = await project('只读成员说明_' + suffix);
            const added = await invite(pid, people.readonly);
            await api(people.readonly, 'POST', '/my/invitations/' + added.invitation.id + '/accept', {});
            await visit(page, '#project=' + pid);
            const description = await page.locator('.sbui-identity').innerText();
            await target('readonly-description', async () => {
                assert.ok(description.includes('当前账号不提供登记与维护权限。'), '[readonly-description] 身份说明必须消费只读能力');
                assert.ok(!description.includes('登记事实与个人意见'));
            });
        }, 'readonly'],
        ['成员加入与任职分开', async (page) => {
            const pid = await project('成员链_' + suffix);
            const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '浏览器需求方' }, 201)).party.id;
            await invite(pid, people.member, party);
            await visit(page, '#project=' + pid + '&tab=members');
            const pendingRow = page.locator('.sbui-table tr').filter({ hasText: people.member.display_name });
            await target('pending-join', async () => {
                await contains(page, '待本人接受');
                assert.ok((await pendingRow.innerText()).includes('待本人接受'));
                assert.ok(!(await pendingRow.innerText()).includes('已加入'));
            });
            const state = await api(people.pm, 'GET', '/projects/' + pid);
            assert.strictEqual(state.appointments.length, 0);
            assert.strictEqual(state.parties[0].owner, null);
            assert.strictEqual(await page.locator('.sbui-chain .sbui-stamp strong').first().innerText(), '暂无生效记录', '没有任职提议时不得伪造等待本人接受');
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(out, 'members.png'), fullPage: true });
        }],
        ['任职与授权完整链', async (page) => {
            const pid = await project('任职授权链_' + suffix);
            const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '授权链需求方' }, 201)).party.id;
            const ownerJoin = await invite(pid, people.owner, party);
            const delegateJoin = await invite(pid, people.delegate, party);
            await api(people.owner, 'POST', '/my/invitations/' + ownerJoin.invitation.id + '/accept', {});
            await api(people.delegate, 'POST', '/my/invitations/' + delegateJoin.invitation.id + '/accept', {});
            await visit(page, '#project=' + pid + '&tab=members');
            await page.getByRole('button', { name: '指定负责人', exact: true }).click();
            await page.locator('#sbuiDialog select[name="member_id"]').selectOption(String(ownerJoin.member.id));
            await page.locator('#sbuiDialog').getByRole('button', { name: '提议负责人任职', exact: true }).click();
            await contains(page, '待本人接受');
            const pending = (await api(people.pm, 'GET', '/projects/' + pid)).appointments.find((a) => a.member_id === ownerJoin.member.id);
            assert.strictEqual(pending.status, 'pending');
            const ownerBrowser = await pageFor(people.owner, options.mutation);
            const delegateBrowser = await pageFor(people.delegate, options.mutation);
            try {
                await visit(ownerBrowser.page, '?project=' + pid + '&invitation=' + pending.invitation_id);
                await ownerBrowser.page.getByRole('button', { name: '本人接受任职', exact: true }).click();
                await ownerBrowser.page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).waitFor();
                await ownerBrowser.page.getByRole('link', { name: '成员与授权', exact: true }).click();
                await ownerBrowser.page.getByRole('button', { name: '授权代表人', exact: true }).click();
                await ownerBrowser.page.locator('#sbuiDialog select[name="member_id"]').selectOption(String(delegateJoin.member.id));
                await ownerBrowser.page.locator('#sbuiDialog').getByRole('button', { name: '发起代表人授权', exact: true }).click();
                await target('delegation-submitted', () => contains(ownerBrowser.page, '待代表人接受'));
                const beforeAccept = await api(people.pm, 'GET', '/projects/' + pid);
                const delegation = beforeAccept.delegations.find((d) => d.member_id === delegateJoin.member.id);
                assert.strictEqual(delegation.status, 'pending_accept', '[delegation-submitted] 授权提议须进入待代表人接受');
                await visit(delegateBrowser.page, '?project=' + pid + '&delegation=' + delegation.id);
                await delegateBrowser.page.getByRole('button', { name: '本人接受授权', exact: true }).click();
                await delegateBrowser.page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).waitFor();
                const accepted = await api(people.pm, 'GET', '/projects/' + pid);
                assert.strictEqual(accepted.parties[0].delegate.member_id, delegateJoin.member.id);
                assert.strictEqual(accepted.delegations.find((d) => d.id === delegation.id).appointment_id, pending.id);
                await ownerBrowser.page.reload({ waitUntil: 'domcontentloaded' });
                await ownerBrowser.page.getByRole('button', { name: '撤销授权', exact: true }).click();
                await ownerBrowser.page.locator('#sbuiDialog').getByLabel(/^原因/).fill('浏览器检查：人员轮岗，保留原授权历史');
                await ownerBrowser.page.locator('#sbuiDialog').getByRole('button', { name: '撤销代表人授权', exact: true }).click();
                await contains(ownerBrowser.page, '已撤销');
                const ended = await api(people.pm, 'GET', '/projects/' + pid);
                assert.strictEqual(ended.parties[0].delegate, null);
                assert.strictEqual(ended.delegations.find((d) => d.id === delegation.id).status, 'revoked');
                assert.strictEqual(ended.delegations.find((d) => d.id === delegation.id).revoke_reason, '浏览器检查：人员轮岗，保留原授权历史');
            } finally { await ownerBrowser.context.close(); await delegateBrowser.context.close(); }
        }],
        ['无账号任职代录', async (page) => {
            const pid = await project('无账号代录_' + suffix);
            const party = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '无账号需求方' }, 201)).party.id;
            const member = (await api(people.pm, 'POST', '/projects/' + pid + '/members', { party_id: party, person_name: '无账号负责人' }, 201)).member.id;
            const appointed = (await api(people.pm, 'POST', '/parties/' + party + '/appointments', { member_id: member }, 201)).appointment.id;
            const before = await api(people.pm, 'GET', '/projects/' + pid);
            const createdOn = before.appointments.find((a) => a.id === appointed).created_at.slice(0, 10);
            await visit(page, '#project=' + pid + '&tab=members');
            await page.getByRole('button', { name: '代录接受任职', exact: true }).click();
            const dialog = page.locator('#sbuiDialog');
            await dialog.getByLabel(/^实际确认日期/).fill(createdOn);
            await dialog.getByLabel(/^实际确认人/).fill('无账号负责人');
            await dialog.getByLabel(/^当时任职或授权依据/).fill('本项目负责人任职提议及线下签字确认原始凭据');
            await dialog.getByLabel(/^原始凭据附件/).setInputFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('浏览器检查的代录原始凭据', 'utf8') });
            await dialog.getByRole('button', { name: '提交代录凭据', exact: true }).click();
            await target('proxy-appointment-active', () => contains(page, '已生效'));
            const after = await api(people.pm, 'GET', '/projects/' + pid);
            assert.strictEqual(after.parties[0].owner.member_id, member, '[proxy-appointment-active] 代录须激活正确的负责人任职');
            const records = await sql(env.dbPath, "SELECT method, external_date, actual_confirmer, view_id FROM sysbuild_confirmations WHERE task_revision_id IN (SELECT r.id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ?)", [pid]);
            assert.strictEqual(records.length, 1);
            assert.strictEqual(records[0].method, 'proxy');
            assert.strictEqual(records[0].external_date, createdOn);
            assert.strictEqual(records[0].actual_confirmer, '无账号负责人');
            assert.strictEqual(records[0].view_id, null, '代录不得伪造本人浏览');
            const bindings = await sql(env.dbPath, "SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' AND attachment_id IN (SELECT id FROM sysbuild_attachments WHERE project_id = ?)", [pid]);
            assert.strictEqual(bindings[0].n, 1, '凭据必须绑定到确认记录');
        }],
        ['邀请窄范围入口', async (page) => {
            const pid = await project('窄范围邀请_' + suffix);
            const inv = await invite(pid, people.outsider);
            await visit(page, '?project=' + pid + '&invitation=' + inv.invitation.id);
            await target('invitation-context', async () => {
                await page.getByRole('heading', { name: '接受加入项目', exact: true }).waitFor();
                assert.ok(!(await page.locator('#sbuiView').textContent()).includes('只供浏览器检查的项目目标'));
                assert.strictEqual(await page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).count(), 0);
            });
            await page.getByRole('button', { name: '本人接受加入', exact: true }).click();
            await page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).waitFor();
            await page.getByText('项目基本信息 · PM、目标、OA 与日期', { exact: true }).click();
            await contains(page, '只供浏览器检查的项目目标');
        }, 'outsider'],
        ['换号清理', async (page) => {
            const pid = await project('换号前档案_' + suffix);
            await visit(page, '#project=' + pid);
            await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'token', newValue: 'a-new-account-token' })));
            await target('session-cleared', async () => {
                await page.getByRole('heading', { name: '登录身份已变化', exact: true }).waitFor();
                assert.ok(!(await page.locator('#sbuiView').innerText()).includes('换号前档案_' + suffix));
                assert.strictEqual(await page.locator('#sbuiDialogContent').innerText(), '');
            });
        }],
        ['旧表单不能跨登录提交', async (page) => {
            const pid = await project('旧表单_' + suffix);
            await visit(page, '#project=' + pid);
            await page.getByRole('button', { name: '修改基本信息', exact: true }).click();
            const dialog = page.locator('#sbuiDialog');
            await dialog.getByLabel(/^系统名称/).fill('不得跨身份保存');
            await page.evaluate((projectId) => {
                const original = window.fetch;
                window.sbuiWriteAttempts = 0;
                window.fetch = function (url, init) {
                    if (init && init.method === 'PATCH' && String(url).endsWith('/api/sysbuild/projects/' + projectId)) window.sbuiWriteAttempts += 1;
                    return original.apply(this, arguments);
                };
            }, pid);
            await page.evaluate(() => localStorage.setItem('token', 'changed-without-a-storage-event'));
            await dialog.getByRole('button', { name: '保存', exact: true }).click();
            await page.getByRole('heading', { name: '登录身份已变化', exact: true }).waitFor();
            assert.strictEqual(await page.evaluate(() => window.sbuiWriteAttempts), 0, 'account change must be rejected before issuing a write');
        }],
        ['重复提交', async (page) => {
            await visit(page, '#new=1');
            await page.getByLabel(/^系统名称/).fill('重复提交_' + suffix);
            await page.getByLabel(/^建设方式/).selectOption('inhouse');
            let release;
            const held = new Promise((resolve) => { release = resolve; });
            let writes = 0;
            await page.route('**/api/sysbuild/projects', async (route) => {
                if (route.request().method() !== 'POST') return route.continue();
                writes += 1;
                await held;
                return route.continue();
            });
            const firstWrite = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/api/sysbuild/projects'));
            await page.locator('#sbuiView form').evaluate((f) => { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            await firstWrite;
            release();
            await page.getByRole('heading', { name: '成员与授权', exact: true }).waitFor();
            assert.strictEqual(writes, 1, 'only the first submit may issue a POST');
            await page.unroute('**/api/sysbuild/projects');
        }],
        ['异步弹窗不串参与方', async (page) => {
            const pid = await project('弹窗意图_' + suffix);
            const firstParty = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '先点击的部门' }, 201)).party.id;
            const lastParty = (await api(people.pm, 'POST', '/projects/' + pid + '/parties', { side: 'demand', name: '最后点击的部门' }, 201)).party.id;
            await visit(page, '#project=' + pid + '&tab=members');
            const firstPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '需求方 · 先点击的部门', exact: true }) });
            const lastPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '需求方 · 最后点击的部门', exact: true }) });
            const firstButton = firstPanel.getByRole('button', { name: '添加本方成员', exact: true });
            let release; let seen = 0;
            const held = new Promise((resolve) => { release = resolve; });
            await page.route('**/api/users/active', async (route) => { seen += 1; if (seen === 1) await held; return route.continue(); });
            try {
                const requested = page.waitForRequest((r) => r.url().endsWith('/api/users/active'));
                await firstButton.click(); await requested;
                await lastPanel.getByRole('button', { name: '添加本方成员', exact: true }).click();
                await page.locator('#sbuiDialog[open]').waitFor();
                assert.strictEqual(await page.locator('#sbuiDialog select[name="party_id"]').inputValue(), String(lastParty));
                release();
                const firstHandle = await firstButton.elementHandle();
                await page.waitForFunction((n) => n && !n.disabled, firstHandle);
                assert.strictEqual(await page.locator('#sbuiDialog select[name="party_id"]').inputValue(), String(lastParty), '晚到的旧请求不能覆盖最后选择的参与方');
                assert.notStrictEqual(firstParty, lastParty);
            } finally { release(); await page.unroute('**/api/users/active'); }
        }],
        ['提交中保留弹窗', async (page) => {
            const pid = await project('弹窗提交_' + suffix);
            await visit(page, '#project=' + pid);
            await page.getByRole('button', { name: '修改基本信息', exact: true }).click();
            const dialog = page.locator('#sbuiDialog');
            await dialog.getByLabel(/^建设目标/).fill('提交完成后才可关闭，保留明确结果');
            let release;
            const held = new Promise((resolve) => { release = resolve; });
            await page.route('**/api/sysbuild/projects/' + pid, async (route) => { if (route.request().method() === 'PATCH') await held; return route.continue(); });
            try {
                const requested = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/sysbuild/projects/' + pid));
                await dialog.getByRole('button', { name: '保存', exact: true }).click(); await requested;
                await target('dialog-close-disabled', async () => {
                    assert.strictEqual(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true, '[dialog-close-disabled] 提交在途必须禁用关闭');
                    await page.keyboard.press('Escape');
                    assert.strictEqual(await dialog.evaluate((d) => d.open), true, '在途提交不能被 Escape 误关');
                });
            } finally { release(); }
            await dialog.waitFor({ state: 'hidden' });
            assert.strictEqual((await api(people.pm, 'GET', '/projects/' + pid)).project.goal, '提交完成后才可关闭，保留明确结果');
            await page.unroute('**/api/sysbuild/projects/' + pid);
        }],
        ['新内容区窄宽不溢出', async (page) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await visit(page, '#help=1');
            assert.strictEqual(await page.locator('#sysbuildApp').evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
        }],
    ];
    cases.push(...stage8.defineCases({ people, api, project, invite, pageFor, visit, contains, env, sql, suffix, options, out, token, target }));
    try {
        const selectedName = options.caseName || (options.mutation && options.mutation.expect);
        const selected = selectedName ? cases.filter(([name]) => name === selectedName) : cases;
        assert.ok(selected.length, 'non-empty selected browser cases');
        if (selectedName) assert.strictEqual(selected.length, 1, '目标浏览器场景必须唯一');
        for (const [name, task, who] of selected) {
            const { page, context } = await pageFor(people[who || 'pm'], options.mutation);
            const errorsBefore = errors.length;
            try { await task(page); assert.strictEqual(errors.length, errorsBefore, 'page errors: ' + errors.slice(errorsBefore).join(' / ')); passed += 1; console.log('  ✓ ' + name); }
            catch (e) {
                const shot = 'failure-' + selected.findIndex((item) => item[0] === name) + '.png';
                try { await page.screenshot({ path: path.join(out, shot), fullPage: true }); } catch (_) { /* retain original assertion */ }
                failures.push({ name, error: e.message, stack: e.stack, screenshot: shot }); console.log('  ✗ ' + name + ': ' + (e.stack || e.message));
            }
            finally { await context.close(); }
        }
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed, failures, pageErrors: errors, selected: selected.map(([name]) => name), mutation: options.mutation && { id: options.mutation.id, expect: options.mutation.expect, expectFailure: options.mutation.expectFailure }, control: options.control === true }, null, 2));
        const keep = options.keepArtifacts === true || failures.length > 0;
        if (!keep) cleanupArtifacts(out);
        console.log(`浏览器检查 ${passed}/${selected.length} 通过；${keep ? '证据 ' + out : '成功后已清理进程私有临时目录'}`);
        return { passed, failures, out: keep ? out : null, pageErrors: errors, selected: selected.map(([name]) => name) };
    } finally { await browser.close(); }
}
module.exports = { run, FRONT_MUTATIONS, cleanupArtifacts };
