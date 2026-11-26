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
const traceSetup = require('./sysbuild-browser-trace-setup');
const traceForms = require('./sysbuild-browser-trace-forms');
const traceConfirm = require('./sysbuild-browser-trace-confirm');
const step3 = require('./sysbuild-browser-step3');
const step4 = require('./sysbuild-browser-step4');
const step5 = require('./sysbuild-browser-step5');
const step6 = require('./sysbuild-browser-step6');
const step7 = require('./sysbuild-browser-step7');
const rec = require('./sysbuild-mut-record'); // C1c：机器基线输出，只在 SYSBUILD_MUT_RECORD=1 时给失败记录多带一个 errorName（target() 改写了 message，Playwright 的栈首行也不带类名，从栈里取不到类名）
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
    { id: 'query-link', file: 'sysbuild-ui.js', from: "if (!location.hash && location.search) history.replaceState(null, '', location.pathname + '#' + location.search.slice(1));", to: 'if (false) history.replaceState(null, "", location.pathname);', expect: '旧链接遵守项目可见性', expectFailure: '[retired-link-access]' },
    { id: 'new-project-capability', file: 'sysbuild-page.js', from: 'if (data.actions && data.actions.create === true) ops.appendChild', to: 'if (true) ops.appendChild', expect: '只读账号的入口', expectFailure: '[readonly-create]' },
    { id: 'platform-nav', file: 'app.js', from: "projectLink.textContent = '项目管理';", to: "projectLink.textContent = '项目管理（开发中）';", expect: '平台导航入口', expectFailure: '[platform-nav]' },
    // 动态入口的图标：两行必须一起替换，只删第一行会让第二行对 null 取属性而抛错，入口插不进去，失败会落到 [platform-nav]。
    { id: 'platform-nav-icon', file: 'app.js', from: "projectLink.insertAdjacentHTML('afterbegin', SVG_ICONS.clipboard);\n        projectLink.firstElementChild.setAttribute('aria-hidden', 'true');", to: 'void 0;', expect: '平台导航入口', expectFailure: '[platform-nav-icon]' },
    // 去重判据失效：静态入口之外再插一份动态入口，项目管理页的平台导航里会有两个同名链接。
    { id: 'platform-nav-duplicate', file: 'app.js', from: `if (projectNav && !projectNav.querySelector('a[href="/Sys_Build.html"], a[href="Sys_Build.html"]')) {`, to: 'if (projectNav) {', expect: '平台导航入口', expectFailure: '[platform-nav-selected]' },
    { id: 'proxy-drop-evidence', file: 'sysbuild-ui.js', from: 'ids.push(result.attachment.id);', to: 'void result.attachment.id;', expect: 'C8 粘贴截图预览与弹窗生命周期', expectFailure: '[paste-staged-evidence]' },
    { id: 'dialog-generation', file: 'sysbuild-ui.js', from: ' && (c.dialog === undefined || c.dialog === state.dialog)', to: '', expect: '异步弹窗不串参与方', expectFailure: '晚到的旧请求不能覆盖最后选择的参与方' },
    { id: 'dialog-close-while-submitting', file: 'sysbuild-ui.js', from: 'if (closeButton) closeButton.disabled = true;', to: 'if (closeButton) closeButton.disabled = false;', expect: '提交中保留弹窗', expectFailure: '[dialog-close-disabled]' },
    { id: 'readonly-member-description', file: 'sysbuild-page.js', from: '当前账号不提供登记与维护权限。', to: '可以登记事实与个人意见。', expect: '只读账号的入口', expectFailure: '[readonly-description]' },
    { id: 'g0-snapshot-content', file: 'sysbuild-packages.js', from: 'text: values.text, material_version_ids:', to: "text: '', material_version_ids:", expect: '新建立项卡片保存与恢复', expectFailure: '[g0-saved-content]' },
    { id: 'g0-submit-version', file: 'sysbuild-packages.js', from: "'/package-versions/' + data.version.id + '/submit'", to: "'/package-versions/' + (data.version.id + 999999) + '/submit'", expect: '新建立项卡片保存与恢复', expectFailure: '[g0-submitted]' },
    { id: 'g0-pending-hint', file: 'sysbuild-packages.js', from: '本版已提交，确认人按固定版本与冻结附件作决定。', to: '如需提交，请先补齐需求方现任负责人及服务端列明的前置条件。', expect: '新建立项卡片保存与恢复', expectFailure: '[g0-submitted]' },
    { id: 'g0-unsaved-submit', file: 'sysbuild-packages.js', from: 'assertSavedDraft(); await A.request', to: 'await A.request', expect: '未保存立项内容阻止发起', expectFailure: '[g0-unsaved-submit]' },
    { id: 'package-unsaved-submit', file: 'sysbuild-packages.js', from: 'assertSavedDraft(); await A.request', to: 'await A.request', expect: '未保存草稿正文与材料阻止发起', expectFailure: '[package-unsaved-text]' },
    { id: 'package-unsaved-materials', file: 'sysbuild-packages.js', from: 'ids: Array.from(new Set(ids.map(Number))).sort((a, b) => a - b)', to: 'ids: []', expect: '未保存草稿正文与材料阻止发起', expectFailure: '[package-unsaved-materials]' },
    ...stage8.MUTATIONS,
    ...traceSetup.MUTATIONS,
    ...traceForms.MUTATIONS,
    ...traceConfirm.MUTATIONS,
    ...step4.MUTATIONS,
    ...step5.MUTATIONS,
    ...step6.MUTATIONS,
    ...step7.MUTATIONS,
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
    for (const role of ['pm', 'owner', 'delegate', 'member', 'outsider', 'admin', 'fixtureOwner', 'fixtureDelegate']) {
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
    async function project(name) {
        return (await api(people.pm, 'POST', '/projects', {
            system_name: name, build_type: 'inhouse', goal: '只供浏览器检查的项目目标',
            demand_parties: [{ name: '浏览器预置需求部门', leader_user_id: people.fixtureOwner.id, representative_user_id: people.fixtureDelegate.id }],
        }, 201)).project.id;
    }
    async function addMember(pid, person, partyId) {
        return api(people.pm, 'POST', '/projects/' + pid + '/members', { user_id: person.id, party_id: partyId || null }, 201);
    }
    async function assignParty(pid, side, name, owner, representative) {
        const route = '/projects/' + pid;
        const projectView = await api(people.pm, 'GET', route);
        const fixture = side === 'demand' && projectView.parties.find((party) => party.owner?.user_id === people.fixtureOwner.id);
        const rep = representative || (side === 'demand' ? people.fixtureDelegate : null);
        const userIds = { leader_user_id: owner.id, representative_user_id: rep?.id ?? null };
        let partyId;
        if (fixture) {
            partyId = fixture.id;
            await api(people.pm, 'PATCH', '/parties/' + partyId, { name });
            await api(people.pm, 'PUT', '/parties/' + partyId + '/people', {
                ...userIds, expected_appointment_id: fixture.owner.appointment_id, expected_delegation_id: fixture.delegate.delegation_id, reason: '浏览器测试指定人员',
            });
        } else {
            partyId = (await api(people.pm, 'POST', route + '/parties', { side, name, ...userIds }, 201)).party.id;
        }
        return (await api(people.pm, 'GET', route)).parties.find((party) => party.id === partyId);
    }
    async function fillDemand(page, name, owner = people.owner, representative = people.delegate) {
        const dialog = page.locator('#sbuiDialog');
        await dialog.locator('[name="demand_name"]').first().fill(name);
        await dialog.locator('[name="demand_leader_user_id"]').first().selectOption(String(owner.id));
        await dialog.locator('[name="demand_representative_user_id"]').first().selectOption(String(representative.id));
    }
    async function openStageCard(page, name) {
        const card = page.locator('.sbui-stage-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
        await card.getByRole('link', { name: '查看卡片', exact: true }).click();
        const drawer = page.locator('.sbui-drawer');
        await drawer.getByRole('heading', { name, exact: true }).waitFor();
        return drawer;
    }
    async function declareViaCard(page, pid, reason = '本浏览器夹具的立项依据为线下讨论，尚无书面原件') {
        await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
        await page.getByRole('button', { name: '填写无书面依据原因', exact: true }).click();
        const dialog = page.locator('#sbuiDialog');
        await dialog.locator('[name="reason"]').fill(reason);
        const [response] = await Promise.all([
            page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/initiation-basis/not-applicable')),
            dialog.getByRole('button', { name: '填写无书面依据原因', exact: true }).click(),
        ]);
        assert.strictEqual(response.status(), 201);
        await dialog.waitFor({ state: 'hidden' });
    }
    async function uploadPairMaterial(pid, type = 'overall') {
        const p = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
        const node = p.nodes.find((n) => n.template_key === (type === 'overall' ? 'p_overall' : 'b_golive') && (type === 'overall' || n.is_golive_milestone));
        const data = new FormData();
        data.append('file', new Blob(['供浏览器检查的材料附件'], { type: 'text/plain' }), 'browser-basis.txt');
        const staged = await fetch(env.baseUrl + '/api/sysbuild/projects/' + pid + '/attachments/stage', {
            method: 'POST', headers: { Authorization: 'Bearer ' + await token(people.pm) }, body: data,
        });
        const attachment = await staged.json();
        assert.strictEqual(staged.status, 200, JSON.stringify(attachment));
        const key = type === 'overall' ? 'requirements-document' : 'acceptance-record';
        return (await api(people.pm, 'POST', '/nodes/' + node.id + '/materials/' + key + '/versions', { attachment_ids: [attachment.attachment.id] }, 201)).version;
    }
    async function preparePairVersion(pid, vid, type) {
        const saved = await api(people.pm, 'GET', '/package-versions/' + vid);
        const material = await uploadPairMaterial(pid, type);
        await api(people.pm, 'PATCH', '/package-versions/' + vid, { snapshot_json: { text: '该测试路径的版本正文', ...saved.snapshot_json, material_version_ids: [material.id] } });
        return material;
    }
    async function initiationDraft(page) {
        const pid = await project('未保存内容检查_' + suffix);
        await assignParty(pid, 'demand', '草稿检查需求方', people.owner, people.delegate);
        const pkg = (await api(people.pm, 'POST', '/projects/' + pid + '/packages', { type: 'initiation' }, 201)).package.id;
        const vid = (await api(people.pm, 'POST', '/packages/' + pkg + '/versions', {}, 201)).version.id;
        const text = '已保存并待确认的立项范围';
        // L3：新门的声明经真实界面填写，不能再用夹具 PATCH 绕过声明编辑。
        await declareViaCard(page, pid);
        await visit(page, '#project=' + pid + '&tab=packages&version=' + vid);
        await page.getByLabel(/^本版确认正文/).fill(text);
        await page.getByRole('button', { name: '保存本版草稿', exact: true }).click();
        await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
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
        page.on('dialog', async (dialog) => { errors.push('unexpected native dialog: ' + dialog.type()); await dialog.dismiss(); });
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
        const invalidLinks = await page.locator('a[href*="=undefined"], a[href*="=null"]')
            .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
        assert.deepStrictEqual(invalidLinks, [], '页面链接含未定义参数：' + suffixPath);
    }
    async function contains(page, text) { await page.getByText(text, { exact: true }).first().waitFor({ timeout: 15000 }); }
    async function savePackageDraft(page, vid, text) {
        const [response] = await Promise.all([
            page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/package-versions/' + vid)),
            page.getByRole('button', { name: '保存本版草稿', exact: true }).click(),
        ]);
        assert.strictEqual(response.status(), 200, '编辑正文保存成功');
        const snapshot = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '本版确认内容', exact: true }) });
        await snapshot.getByText(text, { exact: true }).waitFor();
    }
    const cases = [
        ['未保存立项内容阻止发起', async (page) => {
            const { pid, vid, text } = await initiationDraft(page);
            await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
            await page.getByRole('link', { name: '进入确认草稿', exact: true }).click();
            let submits = 0;
            page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/package-versions/' + vid + '/submit')) submits += 1; });
            const field = page.getByLabel(/^本版确认正文/);
            await field.fill('尚未保存的立项范围');
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await target('g0-unsaved-submit', () => contains(page, '有未保存的改动，请先保存本版草稿，或放弃改动后再发起确认。'));
            assert.strictEqual(submits, 0, '[g0-unsaved-submit] 未保存立项编辑不能发POST');
            assert.strictEqual(await field.inputValue(), '尚未保存的立项范围', '[g0-unsaved-submit] 拦截后保留输入');
            assert.strictEqual((await api(people.pm, 'GET', '/package-versions/' + vid)).snapshot_json.text, text, '[g0-unsaved-submit] 拦截后保存快照不变');
            await field.fill(text); // 恢复到保存值后可直接发起。
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await contains(page, '本版已提交，确认人按固定版本与冻结附件作决定。');
            assert.strictEqual(submits, 1, '恢复保存值后只提交一次');
        }],
        ['未保存草稿正文与材料阻止发起', async (page) => {
            const { pid, vid, text } = await initiationDraft(page);
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const made = await api(people.pm, 'POST', '/nodes/' + plan.nodes[0].id + '/materials/draft-check/versions', { name: '待保存引用的材料', body: '供本版明确引用的原始材料' }, 201);
            await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
            await page.getByRole('link', { name: '进入确认草稿', exact: true }).click();
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
            // 动态入口：恰好一个图标，且对读屏隐藏（先断言个数，再读属性，避免 0 个时等到超时而丢掉目标标记）。
            assert.strictEqual(await nav.locator('svg').count(), 1, '[platform-nav-icon] 动态项目管理入口内须恰好一个 svg 图标');
            assert.strictEqual(await nav.locator('svg').first().getAttribute('aria-hidden'), 'true', '[platform-nav-icon] 图标须带 aria-hidden="true"');
            await nav.click();
            await page.getByRole('heading', { name: '我参与的项目', exact: true }).waitFor();
            // 项目管理页：静态入口。要守的性质是「adjustNavbarForRole() 在本页不会多插一份入口」，所以直接显式调用它再数，不依赖任何加载期信号：
            //   页面自己那次调用（app.js 的 DOMContentLoaded 链，要先 await loadTaskTips() 与 checkAuth()）可能已发生也可能没发生，没有可靠的信号能区分——
            //   sysbuild-ui.js 的 init() 与 app.js 各有一条 checkAuth() 链，头像区在 adjustNavbarForRole 之前就已填好；app.js 顶层还有一次 loadTasks()，/api/pool 同样更早出现。
            //   显式调用之后：去重判据正确时，不论页面自己那次是否已发生，再调一次都不会多插；判据失效时，这一次调用必然多插（页面自己那次若也发生则更多）。
            //   先决条件必须先核对：adjustNavbarForRole 在 currentUser 为空时直接返回，那样变异会存活。标题出现说明 sysbuild-ui.js 的 checkAuth() 已完成，
            //   它与 app.js 共用顶层 let currentUser，所以此时 currentUser 已赋值；任一条不满足就判失败，不静默继续。
            //   先决条件用独立标记 [platform-nav-precondition]，不包进目标标记：变异运行里它若失败，应被判成「变异异常」，不能冒充目标断言把变异「判红」。
            const precondition = await page.evaluate(() => ({ fn: typeof adjustNavbarForRole === 'function', user: typeof currentUser !== 'undefined' && !!currentUser }));
            assert.ok(precondition.fn, '[platform-nav-precondition] 全局没有 adjustNavbarForRole 函数');
            assert.ok(precondition.user, '[platform-nav-precondition] 全局 currentUser 为空，adjustNavbarForRole 会直接返回');
            await target('platform-nav-selected', () => page.evaluate(() => { adjustNavbarForRole(); }));
            const platform = page.getByRole('navigation', { name: '平台导航', exact: true });
            const own = platform.getByRole('link', { name: '项目管理', exact: true });
            assert.strictEqual(await own.count(), 1, '[platform-nav-selected] 平台导航里「项目管理」链接须恰好一个，不得重复');
            assert.strictEqual(await own.getAttribute('aria-current'), 'page', '[platform-nav-selected] 项目管理页的入口须标 aria-current="page"');
            assert.strictEqual(await own.locator('svg').count(), 1, '[platform-nav-selected] 项目管理页的入口内须恰好一个 svg 图标');
        }],
        ['新建立项卡片保存与恢复', async (page) => {
            await visit(page);
            await page.getByRole('button', { name: '新建项目', exact: true }).click();
            await page.getByLabel(/^系统名称/).fill('浏览器新建_' + suffix);
            await page.getByLabel(/^建设方式/).selectOption('inhouse');
            await fillDemand(page, '新建流程需求方');
            await page.getByRole('button', { name: '保存', exact: true }).click();
            await page.getByRole('heading', { name: '立项依据', exact: true }).waitFor();
            const url = new URL(page.url());
            const pid = Number(new URLSearchParams(url.hash.slice(1)).get('project'));
            const detail = await api(people.pm, 'GET', '/projects/' + pid);
            assert.ok(!detail.project.goal, 'v1.3 建档弹窗不再填写建设目标');
            assert.strictEqual(new URLSearchParams(url.hash.slice(1)).get('stage'), 'initiation');
            assert.strictEqual(detail.project.pm_user_id, people.pm.id);
            assert.strictEqual(detail.members.length, 3, 'PM 和两位指定人员即时加入');
            await page.reload({ waitUntil: 'domcontentloaded' });
            const basis = await openStageCard(page, '立项依据');
            await basis.locator('[name="body"]').waitFor();
            await declareViaCard(page, pid);
            await visit(page, '#project=' + pid + '&tab=members');
            await contains(page, '需求方 · 新建流程需求方');
            await visit(page, '#project=' + pid + '&tab=plan&stage=initiation');
            await page.getByRole('button', { name: '建立确认草稿', exact: true }).click();
            await page.getByLabel(/^本版确认正文/).waitFor();
            await page.getByLabel(/^本版确认正文/).fill('这份逐字保存的立项范围用于本次G0确认_' + suffix);
            await Promise.all([
                page.waitForResponse((res) => res.request().method() === 'PATCH' && /\/package-versions\/\d+$/.test(new URL(res.url()).pathname)),
                page.getByRole('button', { name: '保存本版草稿', exact: true }).click(),
            ]);
            await page.locator('form[data-submitting="true"]').waitFor({ state: 'detached' });
            const packages = await api(people.pm, 'GET', '/projects/' + pid + '/packages');
            const version = packages.packages.find((p) => p.type === 'initiation').versions[0];
            const saved = await api(people.pm, 'GET', '/package-versions/' + version.id);
            assert.strictEqual(saved.snapshot_json.text, '这份逐字保存的立项范围用于本次G0确认_' + suffix, '[g0-saved-content] 保存必须包含本次正文');
            await page.getByRole('button', { name: '发起本版确认', exact: true }).click();
            await target('g0-submitted', () => contains(page, '本版已提交，确认人按固定版本与冻结附件作决定。'));
            await target('g0-submitted', () => page.getByRole('heading', { name: '立项与授权 v1 · 待确认', exact: true }).waitFor());
            const submitted = await api(people.pm, 'GET', '/package-versions/' + version.id);
            assert.strictEqual(submitted.version.status, 'pending', '[g0-submitted] 发起后版本须待确认');
            const tasks = await sql(env.dbPath, "SELECT r.id, r.required_member_id, r.status FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id WHERE t.project_id = ? AND t.object_type = 'package_version' AND t.object_version_id = ?", [pid, version.id]);
            assert.strictEqual(tasks.length, 1, 'G0只向本次需求方负责人生成确认任务');
            assert.strictEqual(tasks[0].required_member_id, detail.parties[0].owner.member_id);
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
            await visit(page, '#scope=mine');
            assert.strictEqual(await page.getByRole('button', { name: '新建项目', exact: true }).count(), 0, '[readonly-create] 只读账号不得出现建项入口');
            await page.getByRole('link', { name: '全部项目', exact: true }).waitFor();
            await page.getByRole('link', { name: '全部项目', exact: true }).click();
            await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
            const pid = await project('只读成员说明_' + suffix);
            await addMember(pid, people.readonly);
            await visit(page, '#project=' + pid);
            const description = await page.locator('.sbui-identity').innerText();
            await target('readonly-description', async () => {
                assert.ok(description.includes('当前账号不提供登记与维护权限。'), '[readonly-description] 身份说明必须消费只读能力');
                assert.ok(!description.includes('登记事实与个人意见'));
            });
        }, 'readonly'],
        ['建档直接指定多个部门与开发方领导', async (page) => {
            await visit(page, '#new=1');
            const dialog = page.locator('#sbuiDialog');
            await dialog.locator('[name="system_name"]').fill('直接建档人员检查_' + suffix);
            await dialog.locator('[name="build_type"]').selectOption('procurement');
            await fillDemand(page, '甲需求部门');
            await dialog.getByRole('button', { name: '再添加一个需求部门', exact: true }).click();
            await dialog.locator('[name="demand_name"]').nth(1).fill('乙需求部门');
            await dialog.locator('[name="demand_leader_user_id"]').nth(1).selectOption(String(people.member.id));
            const secondRepresentative = dialog.locator('[name="demand_representative_user_id"]').nth(1);
            await secondRepresentative.selectOption(String(people.member.id));
            await dialog.locator('[name="dev_name"]').fill('开发侧');
            await dialog.locator('[name="dev_leader_user_id"]').selectOption(String(people.fixtureOwner.id));
            const save = dialog.getByRole('button', { name: '保存', exact: true });
            await save.click();
            await dialog.getByText('领导与负责人须由不同账号担任', { exact: true }).waitFor();
            assert.strictEqual(await dialog.locator('[name="demand_name"]').nth(1).inputValue(), '乙需求部门');
            assert.strictEqual(await dialog.locator('[name="dev_leader_user_id"]').inputValue(), String(people.fixtureOwner.id));
            await secondRepresentative.selectOption(String(people.outsider.id));
            await save.click();
            await page.getByRole('heading', { name: '立项依据', exact: true }).waitFor();
            const pid = Number(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('project'));
            const snapshot = await api(people.pm, 'GET', '/projects/' + pid);
            assert.deepStrictEqual(snapshot.parties.map((party) => [party.name, party.owner.user_id, party.delegate?.user_id ?? null]), [
                ['甲需求部门', people.owner.id, people.delegate.id],
                ['乙需求部门', people.member.id, people.outsider.id],
                ['开发侧', people.fixtureOwner.id, null],
            ]);
        }],
        ['直接指定人员生效与历史', async (page) => {
            const pid = await project('直接指定人员_' + suffix);
            const party = await assignParty(pid, 'demand', '测试需求部门', people.owner, people.delegate);
            await visit(page, '#project=' + pid + '&tab=members');
            await contains(page, people.owner.display_name);
            await page.getByRole('button', { name: '指定或更换人员', exact: true }).click();
            await page.locator('#sbuiDialog select[name="leader_user_id"]').selectOption(String(people.member.id));
            await page.locator('#sbuiDialog textarea[name="reason"]').fill('浏览器检查：人员轮换');
            await page.locator('#sbuiDialog').getByRole('button', { name: '保存人员', exact: true }).click();
            await target('direct-people-saved', async () => {
                const former = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '领导任职 #' + party.owner.appointment_id, exact: true }) });
                await former.getByRole('cell', { name: '已结束', exact: true }).waitFor();
                const detail = await api(people.pm, 'GET', '/projects/' + pid);
                const changed = detail.parties.find((row) => row.id === party.id);
                assert.strictEqual(changed.owner.user_id, people.member.id);
                assert.strictEqual(changed.delegate.user_id, people.delegate.id);
                assert.notStrictEqual(changed.delegate.delegation_id, party.delegate.delegation_id);
            });
        }],
        ['旧链接遵守项目可见性', async (page) => {
            const pid = await project('旧链接访问检查_' + suffix);
            await visit(page, '?project=' + pid + '&invitation=1');
            await target('retired-link-access', async () => {
                assert.ok(!(await page.locator('#sbuiView').textContent()).includes('只供浏览器检查的项目目标'));
                assert.strictEqual(await page.getByRole('button', { name: /本人接受/ }).count(), 0);
                await addMember(pid, people.outsider);
                await visit(page, '?project=' + pid + '&invitation=1');
                await page.getByRole('heading', { name: '我在本项目中的身份', exact: true }).waitFor();
            });
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
            await page.getByText('更多', { exact: true }).click();
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
            await fillDemand(page, '重复提交测试需求方');
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
            await page.locator('#sbuiDialog form').evaluate((f) => { f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            await firstWrite;
            release();
            await page.getByRole('heading', { name: '立项依据', exact: true }).waitFor();
            assert.strictEqual(writes, 1, 'only the first submit may issue a POST');
            await page.unroute('**/api/sysbuild/projects');
        }],
        ['异步弹窗不串参与方', async (page) => {
            const pid = await project('弹窗意图_' + suffix);
            const firstParty = await assignParty(pid, 'demand', '先点击的部门', people.owner, people.delegate);
            const lastParty = await assignParty(pid, 'demand', '最后点击的部门', people.member, people.outsider);
            await visit(page, '#project=' + pid + '&tab=members');
            const firstPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '需求方 · 先点击的部门', exact: true }) });
            const lastPanel = page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name: '需求方 · 最后点击的部门', exact: true }) });
            const firstButton = firstPanel.getByRole('button', { name: '指定或更换人员', exact: true });
            let release; let seen = 0;
            const held = new Promise((resolve) => { release = resolve; });
            await page.route('**/api/users/active', async (route) => { seen += 1; if (seen === 1) await held; return route.continue(); });
            try {
                const requested = page.waitForRequest((r) => r.url().endsWith('/api/users/active'));
                await firstButton.click(); await requested;
                await lastPanel.getByRole('button', { name: '指定或更换人员', exact: true }).click();
                await page.locator('#sbuiDialog[open]').waitFor();
                const leader = page.locator('#sbuiDialog select[name="leader_user_id"]');
                assert.strictEqual(await leader.inputValue(), String(lastParty.owner.user_id));
                release();
                const firstHandle = await firstButton.elementHandle();
                await page.waitForFunction((n) => n && !n.disabled, firstHandle);
                assert.strictEqual(await leader.inputValue(), String(lastParty.owner.user_id), '晚到的旧请求不能覆盖最后选择的参与方');
                assert.notStrictEqual(firstParty.id, lastParty.id);
            } finally { release(); await page.unroute('**/api/users/active'); }
        }],
        ['提交中保留弹窗', async (page) => {
            const pid = await project('弹窗提交_' + suffix);
            await visit(page, '#project=' + pid);
            await page.getByText('更多', { exact: true }).click();
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
        ['B3.2 既有阶段页材料卡操作', async (page) => {
            const pid = await project('阶段卡片操作_' + suffix);
            const plan = await api(people.pm, 'GET', '/projects/' + pid + '/plan');
            const range = plan.nodes.find((node) => node.template_key === 'p_overall');
            await visit(page, '#project=' + pid + '&tab=plan&node=' + range.id);
            const named = (name) => page.locator('section.sbui-panel').filter({ has: page.getByRole('heading', { name, exact: true }) }).last();
            const dialog = page.locator('#sbuiDialog');
            const doc = named('需求文档');
            await doc.getByText('待补材料', { exact: true }).waitFor();
            assert.strictEqual(await doc.getByRole('button', { name: '标为不适用', exact: true }).count(), 0);
            await doc.getByRole('button', { name: '上传材料', exact: true }).click();
            await dialog.locator('[name="files"]').setInputFiles({ name: '需求文档.txt', mimeType: 'text/plain', buffer: Buffer.from('阶段卡片上传的需求文档') });
            await dialog.getByRole('button', { name: '保存候选材料版本', exact: true }).click();
            await doc.getByText('已完成', { exact: true }).waitFor();
            await page.getByRole('button', { name: '自建必做材料卡片', exact: true }).click();
            await dialog.locator('[name="name"]').fill('部门自建材料卡');
            await dialog.getByRole('button', { name: '建立卡片', exact: true }).click();
            const custom = named('部门自建材料卡');
            await custom.getByRole('button', { name: '标为不适用', exact: true }).click();
            await dialog.locator('[name="reason"]').fill('此次范围确认不涉及该部门配套材料');
            await dialog.getByRole('button', { name: '标为不适用', exact: true }).click();
            await custom.getByText('不适用', { exact: true }).waitFor();
            const state = await api(people.pm, 'GET', '/projects/' + pid + '/materials');
            assert.strictEqual(state.cards.find((card) => card.name === '部门自建材料卡').complete, true);
        }],
        ['新内容区窄宽不溢出', async (page) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await visit(page, '#help=1');
            assert.strictEqual(await page.locator('#sysbuildApp').evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
        }],
    ];
    const shared = { people, api, project, addMember, assignParty, fillDemand, pageFor, visit, contains, env, sql, suffix, options, out, token, target, declareViaCard, openStageCard, uploadPairMaterial, preparePairVersion, savePackageDraft };
    cases.push(...stage8.defineCases(shared));
    for (const module of [traceSetup, traceForms, traceConfirm, step3, step4, step5, step6, step7]) cases.push(...module.defineCases(shared));
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
                failures.push({ name, error: e.message, stack: e.stack, screenshot: shot, ...(rec.enabled() ? { errorName: e && e.name } : {}) }); console.log('  ✗ ' + name + ': ' + (e.stack || e.message));
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
