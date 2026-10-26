/**
 * test-sys-perdev-done-playwright.js — 「开发逐人完成」时间线真实行前端冒烟（长任务B·S3-C）
 * 方案：docs/local/系统迭代/时间线逐人完成事件_方案_20260916_v1.1.md §4 C4（Playwright）
 * 后端正确性已由 scripts/verify-sys-perdev-done.js 覆盖（in-process 内存库，73 断言全绿）；
 * 前端渲染静态不变量已由 scripts/verify-sys-release-panel-static.js [S3-A] 覆盖（197 断言全绿）。
 * 本文件只测两条必须靠真实浏览器 DOM 才能证明的行为：
 *
 *   [D3] 正向活体带对照组：造 1 条逐人完成行 + 1 条可隐藏批次编排行（release_add）→ 勾选
 *        「隐藏批次编排记录」后，逐人行仍 isVisible()，release_add 行被隐藏（count>0 且被藏）。
 *   [B5] 最后一人提交后的 DOM 顺序：`$$eval('.si-tl-item')` 取文本序列，断言逐人行出现在
 *        整单流转行之前，且两行并存（不去重、不互相替代——B3 语义分工）。
 *
 * 骨架抄 test-sys-submit-withdraw-playwright.js：JWT 注入登录 + API 夹具直调 + registerCreatedId
 * 收尾精确清理（走官方 DELETE /sys-issues/:id 端点，非直连 SQL 级联删除——[[feedback_shared_dir_test_cleanup_precise_list]]
 * 共享目录/共享库清理必须精确清单，本文件严格只删自己 registerCreatedId 记录过的 id，不做任何前缀
 * 通配删除）。
 *
 * ⚠️ [S3-C 环境依赖·2026-09-17 实测记录] 本文件假定被测服务进程已加载长任务B S1/S1b/S2/S2b 全部改动
 * （commit 0303098/08e6249/81d8d2c/716ff6a）。[#106 S4d-3] 迁移后被测服务是 test-env 自起的隔离实例（本检出的代码），
 * 不再有「常驻开发服务器是旧代码」的环境依赖。本文件仍严格只通过 HTTP API（含官方 DELETE 端点清理）操作数据，不直连 sqlite3 写库；
 * 实例库只用 OPEN_READONLY 做两类只读核对（拿 users 行 / 末尾零残留 SELECT）。
 *
 * [#106 S4d-3] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；
 *   · 删除 assertLocalTargetOrExit（MED-5：原来防的是 TEST_BASE_URL 指向远端而本文件直读本机业务库——现在被测服务与库路径同出一源 test-env，
 *     隔离实例本身就是本地目标，该失真假设不再存在）与 ensureServerListening（端口探测，ready() 已核对服务身份 / 就绪）；
 *   · 令牌用 testEnv.signToken；RUN_TAG（含 crypto.randomBytes）、标题前缀等每次运行唯一，清理仍只针对本文件登记过的 id；
 *   · 清理：issue / release 的 DELETE 各自 try，失败再试一轮（共 2 轮，间隔 200ms），遗留计失败（原本就计失败，这里补重试）。
 *
 * 用法：node scripts/test-sys-perdev-done-playwright.js
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-3] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-3] ready() 之后赋值：testEnv.env().dbPath（实例库，只读核对）

const ADMIN_ID = 1;
const DEV_ID = 8;         // 示例开发A——同 test-sys-submit-withdraw-playwright.js 既有夹具账号
const SECOND_DEV_ID = 9;  // 示例开发B

let RUN_TAG = null;         // [#106 S4d-3] ready() 之后赋值（顶层 Date.now() / crypto.randomBytes 会被守卫 R6 判红）
let RUN_TAG_MARKER = null;
const TITLE_PREFIX = '[pw-perdev-done]';

// ⚠️ [S3-C 清理纪律] db 只读——本文件的读操作是 末尾零残留核对（signAs 现在走 testEnv.signToken，不再自己查 users 表）；
// 写操作一律走 HTTP API（含清理，见 registerCreatedId + apiDeleteIssue）。
// [#106 S4d-3] 只读打开实例库（OPEN_READONLY，带打开回调转 Promise），每次查询开关一次，关库等回调、错误不丢；模块顶层不再 new Database(业务库)。
function openInstanceDbReadonly(dbPath) {
    return new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(d)));
    });
}
const dbAll = async (sql, params = []) => {
    const d = await openInstanceDbReadonly(DB_PATH);
    return new Promise((res, rej) => { d.all(sql, params, (e, rows) => { d.close((ce) => { const err = e || ce; err ? rej(err) : res(rows || []); }); }); });
};
/** 最多尝试 2 次（间隔 200ms），成功即返回，失败抛最后一次的错 */
async function twice(fn) {
    try { return await fn(); } catch (e1) {
        await new Promise((r) => setTimeout(r, 200));
        return fn();
    }
}

async function signAs(userId) {
    return testEnv.signToken(userId);   // [#106 S4d-3] 实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
}
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
// [LOW-10] 实测发现：Sys_Iteration.html 详情页无条件拉取 admin-only 的
// GET /api/sys-issues/intake-liaisons（见该文件 :1734 一带，C2 建单优化批遗留——非本文件所属分支
// S1-S3 引入，本文件文件围栏不含该 HTML，不在本次改动范围内修），devTok（普通开发者）打开详情页
// 必现一条 403 console error，与本文件测的逐人完成事件功能无关，是页面既有噪声非新回归。用窄白名单
// 排除这一条已知噪声，其余任何 console error 仍会被下方断言判红——不是放弃断言，是不让已知噪声
// 掩盖真实新增的错误。
const KNOWN_BENIGN_CONSOLE_ERROR_SUBSTRINGS = ['/api/sys-issues/intake-liaisons'];
function unexpectedConsoleErrors(page) {
    return (page._consoleErrors || []).filter((m) => !KNOWN_BENIGN_CONSOLE_ERROR_SUBSTRINGS.some((s) => m.includes(s)));
}
function futureEstStr(days) {
    const d = new Date(Date.now() + (days || 30) * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let pass = 0, fail = 0;
const failDetails = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failDetails.push(msg); }
    return cond;
}
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(os.tmpdir(), 'sys-playwright-shots', `perdev-done-fail-${name}.png`);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') { const loc = (m.location && m.location()) || {}; consoleErrors.push(m.text() + (loc.url ? ` @ ${loc.url}` : '')); } });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

// ── 官方 API 夹具（同 test-sys-submit-withdraw-playwright.js 范式）──────────────────────
let seq = 0;
const createdIds = [];
const createdReleaseIds = [];
const releaseMembers = new Map();   // relId → 本文件加进去的 issue id 列表（remove-issues 是原子的，混入不在批次的 id 整批 409）
function registerCreatedReleaseId(id) { if (Number.isInteger(id) && id > 0 && !createdReleaseIds.includes(id)) createdReleaseIds.push(id); }
function registerCreatedId(id) { if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id); }
async function apiCreate(adminTok, type, extra = {}) {
    seq++;
    const body = {
        intake_contract_version: 2, type,
        title: `${TITLE_PREFIX}-${type}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部',
        description: `Sys-PerDev-Done S3-C Playwright 夹具 ${RUN_TAG_MARKER}`,
        intake_liaison_id: 13,
        ...extra,
    };
    const r = await fetch(`${BASE_URL}/api/sys-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (r.status !== 201 || !j || !(j.id > 0)) throw new Error(`[夹具建单] type=${type} 应 201，实得 ${r.status} ${JSON.stringify(j)}`);
    registerCreatedId(j.id);
    return j.id;
}
async function apiIntakeAccept(adminTok, id, extra = {}) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(extra) });
    if (r.status !== 200) throw new Error(`[夹具 intake-accept] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSetOaNumber(adminTok, id, oa) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/set-oa-number`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ oa_number: String(oa) }) });
    if (r.status !== 200) throw new Error(`[夹具 set-oa-number] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiAssign(adminTok, id, userId) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: userId }) });
    if (r.status !== 200) throw new Error(`[夹具 assign] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiAddMember(adminTok, id, userId) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/dev-assignees`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ user_ids: [userId] }) });
    if (r.status !== 200) throw new Error(`[夹具 add-member] id=${id} user=${userId} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiEstimate(devTok, id, days) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr(30), estimated_effort_days: days || 1 }) });
    if (r.status !== 200) throw new Error(`[夹具 estimate] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSubmitCommits(devTok, id, ref, extra = {}) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: ref }], self_tested: true, test_env_deployed: true, ...extra }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(`[夹具 submit-commits] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(j)}`);
    return j;
}
// [D3 夹具] 造 1 条可隐藏批次编排行（release_add，event_type='scope_change'）——真实最小路径：
// 建一个「计划中」批次（POST /sys-releases，全字段可选）→ 把目标单加入该批次（POST
// /sys-releases/:id/add-issues，仅要求目标单处于「可发布类型」且当前批次「计划中」——不需要走完整的
// 安排上线通知执行人/执行人确认执行那一整套排班流程，加单本身就会写一条 action_code='release_add' 的
// scope_change 行，恰是本文件需要的最小可达形态）。批次本身不清理（release_add 只是留痕，批次记录
// 与本文件的迭代单清理无关，且当前系统未提供 DELETE /sys-releases/:id 供测试场景清理"计划中·空批次"，
// 遗留一个空的测试批次记录不产生任何业务噪音，同既有 test-sys-release-panel-c2b2-playwright.js 等
// 批次类夹具的既有处置——不在本文件清理范围内扩大化）。
async function apiArrangeRelease(adminTok, id) {
    // 主会话 2026-09-17 14:2x 修：add-issues 只收「待上线」单（index.js H-3 步骤2 :16216），夹具停在「待验证」
    // 时首跑 409——先走官方 accept（待验证→待上线，同 test-sys-submit-amend-playwright.js:283 写法），再建批次加单。
    const accR = await fetch(`${BASE_URL}/api/sys-issues/${id}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
    if (accR.status !== 200) return { status: accR.status, body: await accR.json().catch(() => null), stage: 'accept' };
    const createR = await fetch(`${BASE_URL}/api/sys-releases`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ title: `${TITLE_PREFIX}-release-${RUN_TAG}` }) });
    const createJ = await createR.json().catch(() => null);
    if (createR.status !== 201 || !createJ || !(createJ.id > 0)) return { status: createR.status, body: createJ };
    registerCreatedReleaseId(createJ.id);
    // [LOW-11] 乐观登记放到 add-issues fetch **之前**——此前放在 fetch 之后+`status===200` 判定通过才登记，
    // 若 fetch 本身抛异常（网络层错误，非 HTTP 非 200）会在 `.set()` 之前就中断，id 从此对清理链不可见，
    // 但服务端调用仍可能已经把该单挂进批次（异常发生在收到响应之后、解析之前，这类竞态在真实网络层不可
    // 排除）——遗留单+遗留批次的组合会让后续 apiDeleteIssue 恒 409 SYS_ISSUE_IN_RELEASE 且无人清理。改为
    // 乐观先登记，清理阶段 remove-issues 若返回 409 ISSUE_NOT_REMOVABLE（本就不在批次，加单从未真正成功）
    // 视为可忽略的正常情形，不是清理失败；其余非 200 才真正报错。
    releaseMembers.set(createJ.id, [...(releaseMembers.get(createJ.id) || []), id]);
    const addR = await fetch(`${BASE_URL}/api/sys-releases/${createJ.id}/add-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ issue_ids: [id] }) });
    return { status: addR.status, body: await addR.json().catch(() => null) };
}
// [#106 S4d-3 修复批] treat404AsCleaned：重试（第 2 次）时 404 视为已清掉（第 1 次请求服务端已删、响应丢失 / 抛错的情形）；
//   第 1 次 404 仍抛错进入重试，不直接放过；最终是否真的清净由收尾的磁盘零残留回查裁定
async function apiDeleteIssue(adminTok, id, reason, treat404AsCleaned) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}`, { method: 'DELETE', headers: jsonHeaders(adminTok), body: JSON.stringify({ reason: reason || 'Playwright 夹具清理：S3-C 逐人完成事件测试遗留单，非真实业务数据' }) });
    if (treat404AsCleaned && r.status === 404) return;
    if (r.status !== 200) throw new Error(`[清理] DELETE id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}

// F1：单人 improvement（同 test-sys-submit-withdraw-playwright.js 的 F1 范式），全完成自动进「待验证」，
//   DEV_ID 本人 code_submitted——供 [D3] 用。⚠️ 首跑 2026-09-17 曾写成 bug：bug 受理不定风险等级
//   （409 RISK_LEVEL_NOT_APPLICABLE）且无工期字段（400 EFFORT_NOT_APPLICABLE），两次红都是夹具错非实现错，
//   改回已验证的 improvement 形态。
async function mkFixtureSingleDevVerify(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260917900 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-perdev-verify-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-单人 improvement] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F2：双人 feature，A 先提交，B（最后一人）提交——供 [B5] 断顺序用。
async function mkFixtureTwoDevLastSubmit(adminTok, devTok, secondDevTok) {
    const id = await apiCreate(adminTok, 'feature');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260917950 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiAddMember(adminTok, id, SECOND_DEV_ID);
    await apiEstimate(devTok, id, 1);
    const subA = await apiSubmitCommits(devTok, id, `pw-perdev-b5-a-${id}`);
    if (subA.main_status === '待验证' || subA.main_status === '待对接测试') throw new Error(`[夹具-双人 feature] A 提交后不应已全完成，实得 ${subA.main_status}`);
    const subB = await apiSubmitCommits(secondDevTok, id, `pw-perdev-b5-b-${id}`);
    return id;
}

// [#106 S4d-3] 原 assertLocalTargetOrExit（codex 589 MED-5）已删：它防的是 TEST_BASE_URL 指向远端而本文件直读本机业务库造成校验静默失真；
//   迁移后被测服务与实例库路径同出一源（test-env），不存在两者不一致的情形，隔离实例本身就是本地目标。

async function main() {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    RUN_TAG = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    RUN_TAG_MARKER = `RT-PERDEV-${RUN_TAG}`;
    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const secondDevTok = await signAs(SECOND_DEV_ID);
    const browser = await chromium.launch();
    try {
        console.log('=== 系统迭代·开发逐人完成事件 S3-C：前端 Playwright ===');

        // ══════════════════════════════════════════════════════════════════
        // [D3] 正向活体带对照组：逐人完成行 + 可隐藏批次编排行 → 勾选过滤器后前者仍可见、后者被藏
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureSingleDevVerify(adminTok, devTok);
            // 对照组不可省（Opus 预筛 S2·断言对象 4）：没有可隐藏行，「勾了过滤器逐人行仍可见」对「过滤器根本没生效」
            // 也会绿——arrange 失败直接判红，不降级为 D3b。
            const arr = await apiArrangeRelease(adminTok, id);
            const hidableInjected = arr.status === 200;
            must(hidableInjected, `[D3·前置] 对照组 release_add 行必须造出（accept→建批次→add-issues），实得 status=${arr.status} stage=${arr.stage || 'add-issues'} body=${JSON.stringify(arr.body)}`);

            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForFunction((targetId) => typeof siDetail !== 'undefined' && siDetail && siDetail.issue && Number(siDetail.issue.id) === targetId, id, { timeout: 8000 });

            const perDevLocator = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt.si-tl-teal') });
            await shotOnFail(page, await perDevLocator.count() > 0, 'd3-perdev-present', `[D3] 打开详情后应能看到至少 1 条逐人完成行（si-tl-teal 徽章），实得 count=${await perDevLocator.count()}`);
            must(await perDevLocator.first().isVisible(), '[D3] 勾选过滤器之前，逐人完成行应可见');

            if (hidableInjected) {
                const hidableLocator = page.locator('.si-tl-item.si-tl-release-scope');
                const hidableCountBefore = await hidableLocator.count();
                must(hidableCountBefore > 0, `[D3] 应存在至少 1 条可隐藏批次编排行（si-tl-release-scope），实得 ${hidableCountBefore}`);
                // 勾选「隐藏批次编排记录」
                await page.click('label:has-text("隐藏批次编排记录") input[type="checkbox"]');
                await page.waitForTimeout(300);
                must(await perDevLocator.first().isVisible(), '[D3] 勾选「隐藏批次编排记录」后，逐人完成行仍应可见（D3 不依赖 #67 可隐藏集合）');
                const hidableVisibleAfter = await hidableLocator.first().isVisible();
                must(hidableVisibleAfter === false, '[D3] 勾选后，release_add 批次编排行应被隐藏（对照组：证明过滤器本身在生效，非本断言恒真）');
            } else {
                console.log('  ⚠️ [D3] 待裁定：本次未能构造出可隐藏批次编排行对照组（release_add 需要完整上线批次流程，本文件未搭建该前置），仅验证了「逐人行不受过滤器影响」的正向一半，对照的反向一半（白名单码确实被藏）复用 verify-sys-release-panel-static.js 既有 [S3-A] 覆盖（DOM 层已直调证明），非本文件缺口。');
            }
            // [LOW-10] console error 全程应恒 0——本文件不故意触发任何 4xx/前端异常，若真出现说明页面渲染
            // 本身出了非预期的错（含 D3 勾选过滤器这一交互动作），值得直接判红而非静默收集不看。
            must(unexpectedConsoleErrors(page).length === 0, `[D3] 页面全程 console error（扣除已知噪声）应为 0 条，实得全集=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // [B5] 最后一人提交后 DOM 顺序：逐人行先于整单流转行，且两者并存
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureTwoDevLastSubmit(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForFunction((targetId) => typeof siDetail !== 'undefined' && siDetail && siDetail.issue && Number(siDetail.issue.id) === targetId, id, { timeout: 8000 });

            const items = await page.$$eval('.si-tl-item', (nodes) => nodes.map((n) => ({
                cls: n.className,
                evtCls: (n.querySelector('.si-tl-evt') || {}).className || '',
                evtLabel: (n.querySelector('.si-tl-evt') || {}).textContent || '',
            })));
            const perDevIdx = items.findIndex((x) => x.evtCls.includes('si-tl-teal'));
            await shotOnFail(page, perDevIdx >= 0, 'b5-perdev-found', `[B5] 应能在 DOM 里定位到逐人完成行（si-tl-teal），实得 items=${JSON.stringify(items)}`);
            must(perDevIdx >= 0 && perDevIdx < items.length - 1, `[B5] 逐人完成行不应是最后一行（其后应还有整单流转行），实得 perDevIdx=${perDevIdx}，总行数=${items.length}`);
            // 主会话收紧（2026-09-17）：B5 的准确断言对象是「最后一人 B 的逐人行 → 紧邻其后就是它触发的整单流转行」
            // （同事务内先插逐人行、runWGate 再插 status_change，中间无其他 timeline 写点），不是「后面某处有一条流转行」。
            // 前提：本文件 F2 夹具（mkFixtureTwoDevLastSubmit）predicted ETA 用 futureEstStr(30)——恒为未来，
            // 不会触发 runWGate 的「完成超期理由」defer 分支（index.js :4345 一带，命中时写
            // completion_overrun_reason 独立 note 行而不写本条 status_change 镜像行，'紧邻下一行'就会落空）。
            const lastPerDevIdx = items.map((x) => x.evtCls.includes('si-tl-teal')).lastIndexOf(true);
            const tealCount = items.filter((x) => x.evtCls.includes('si-tl-teal')).length;
            must(tealCount === 2, `[B5] 双人各自提交应恰 2 条逐人完成行（A、B 各一），实得 ${tealCount}`);
            const nextAfterLast = items[lastPerDevIdx + 1];
            must(!!nextAfterLast && nextAfterLast.evtLabel.includes('状态流转'), `[B5] 最后一人的逐人行（idx=${lastPerDevIdx}）紧邻下一行应是整单流转行「状态流转」，实得 ${JSON.stringify(nextAfterLast)}`);
            // 两行并存（不去重）：逐人行本身存在，且逐人行之后确有至少一条非 si-tl-teal 的行。
            const laterNonPerDev = items.slice(perDevIdx + 1).some((x) => !x.evtCls.includes('si-tl-teal'));
            must(laterNonPerDev, `[B5] 逐人完成行之后应存在至少一条非逐人完成行（整单流转行，两者并存不去重），实得 ${JSON.stringify(items.slice(perDevIdx + 1))}`);
            // [LOW-10] 同 D3——全程 console error 恒 0。
            must(unexpectedConsoleErrors(page).length === 0, `[B5] 页面全程 console error（扣除已知噪声）应为 0 条，实得全集=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
        }

        console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
        if (fail > 0) { console.log('失败项：'); failDetails.forEach(m => console.log('  - ' + m)); }
    } finally {
        // [#106 S4d-3 修复批] browser.close() 失败不阻断后续清理，但计失败（原来只打日志，退出码仍为 0）
        try { await browser.close(); } catch (e) { console.error(`browser.close() 失败（不阻断后续清理）：${e.message}`); fail++; failDetails.push(`browser.close() 失败：${e.message}`); }
        // 清理链两半缺一半都是假清理（memory feedback_shared_dir_test_cleanup_precise_list·首跑实锤：加入批次的单 DELETE 409
        // SYS_ISSUE_IN_RELEASE 留下 19155）：① 先把自己造的单从自己造的批次移出（remove-issues）② DELETE 单 ③ DELETE 自己造的空批次
        // （官方 DELETE /sys-releases/:id 存在）。三步都只针对本文件登记过的 id，不做前缀通配。
        // [codex 589 采纳·顺序说明订正] 批次 DELETE /sys-releases/:id（index.js :18204 起）步骤④会把在册成员的
        //   release_id 置 NULL 并写 release_remove 时间线——并**不会**让成员遗留指向已删批次的孤儿指针，直接
        //   反过来先删批次也不会让单卡死。本文件仍保持「先移单、再删单、最后删批次」的顺序，只是为了让批次
        //   删除时留痕尽量干净（remove-issues 已单独写一条 release_remove 记录，避免与批次删除步骤④重复记录）
        //   以及清理路径精确可控，不是为了规避某种孤儿态。
        for (const relId of createdReleaseIds) {
            const members = releaseMembers.get(relId) || [];
            if (!members.length) continue;
            try {
                const r = await fetch(`${BASE_URL}/api/sys-releases/${relId}/remove-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ issue_ids: members }) });
                const j = r.status !== 200 ? await r.json().catch(() => null) : null;
                // [LOW-11] 乐观登记的副作用：登记过的 id 不一定真的进了批次（add-issues 可能从未成功）。
                // remove-issues 返回 409 ISSUE_NOT_REMOVABLE 时，先 GET 该批次核对成员列表确实不含本文件登记的
                // id（真是"本就不在批次"）才可忽略——不核对就直接放过，会把"确实该移出但移出失败"误吞成噪声。
                if (r.status !== 200) {
                    if (r.status === 409 && j && j.code === 'ISSUE_NOT_REMOVABLE') {
                        try {
                            const relR = await fetch(`${BASE_URL}/api/sys-releases/${relId}`, { headers: jsonHeaders(adminTok) });
                            // [长任务B S4c3·codex 591-R M3] 只有在 GET 状态恰为 200 **且**解析出的返回体含
                            // 合法 `issues` 数组时，才允许用它计算交集判"不在册"。非 200 / JSON 解析失败 /
                            // 返回体缺 `issues` 字段（或不是数组）三种情形，此前一律被 `relJ && ... ? ... : []`
                            // 折叠成空数组——空数组与"真的不在册"在下面 filter 交集判定上完全等价，会把"核对
                            // 不了"悄悄当成"核对通过"放行，掩盖真实清理失败。现在三种情形都不折叠，直接计 fail
                            // 并把无法核对的精确 id 列表（本文件登记的 members，而非空集）打印出来。
                            let relJ = null, parseErr = null;
                            try { relJ = await relR.json(); } catch (pe) { parseErr = pe; }
                            const issuesFieldValid = relJ && typeof relJ === 'object' && Array.isArray(relJ.issues);
                            if (relR.status !== 200 || parseErr || !issuesFieldValid) {
                                const why = relR.status !== 200
                                    ? `GET 状态非 200（实得 ${relR.status}）`
                                    : parseErr ? `GET 返回体 JSON 解析失败（${parseErr.message}）`
                                        : `GET 返回体缺合法 issues 数组（实得 ${JSON.stringify(relJ)}）`;
                                console.error(`清理 release=${relId} 移单 409 ISSUE_NOT_REMOVABLE 后 GET 核对不可用（${why}）——判为真清理失败，本文件登记的成员 id 无法确认是否已移出：${JSON.stringify(members)}`);
                                fail++; failDetails.push(`清理 release=${relId} 移单失败：409 后 GET 核对不可用（${why}），未确认 id=${JSON.stringify(members)}`);
                            } else {
                                // GET /api/sys-releases/:id 返回体成员字段名为 `issues`（见 routes/sys-iteration/index.js
                                // :17424-17429 res.json({ release, issues, ... })，每项含 id 字段——非 `members`。
                                const memberIdsInRelease = new Set(relJ.issues.map((m) => Number(m.id)));
                                const stillMember = members.filter((mid) => memberIdsInRelease.has(Number(mid)));
                                if (stillMember.length > 0) {
                                    console.error(`清理 release=${relId} 移单 409 ISSUE_NOT_REMOVABLE，但 GET 批次核对后仍有 ${JSON.stringify(stillMember)} 在册——判为真清理失败`);
                                    fail++; failDetails.push(`清理 release=${relId} 移单失败：409 后核对仍在册 ${JSON.stringify(stillMember)}`);
                                } else {
                                    console.log(`  ℹ️ 清理 release=${relId} 移单 409 ISSUE_NOT_REMOVABLE，GET 批次核对确认本文件登记的 ${JSON.stringify(members)} 均不在册，视为正常噪声`);
                                }
                            }
                        } catch (ge) {
                            console.error(`清理 release=${relId} 移单 409 后 GET 批次核对失败（无法确认是否真安全）：${ge.message}`);
                            fail++; failDetails.push(`清理 release=${relId} 移单 409 后核对失败：${ge.message}`);
                        }
                    } else {
                        console.error(`清理 release=${relId} 移单非 200：${r.status} ${JSON.stringify(j)}`);
                        fail++; failDetails.push(`清理 release=${relId} 移单失败：${r.status} ${JSON.stringify(j)}`);
                    }
                }
            } catch (e) { console.error(`清理 release=${relId} 移单失败：${e.message}`); fail++; failDetails.push(`清理 release=${relId} 移单异常：${e.message}`); }
        }
        // [#106 S4d-3] DELETE 各自 try，失败再试一轮（twice：共 2 次，间隔 200ms），仍失败才计失败
        for (const id of createdIds) {
            let delAttempt = 0;   // 第 2 次起 404 视为已清（见 apiDeleteIssue）
            try { await twice(() => apiDeleteIssue(adminTok, id, undefined, delAttempt++ > 0)); }
            catch (e) { console.error(`清理 issue=${id} 失败：${e.message}`); fail++; failDetails.push(`清理 issue=${id} 失败：${e.message}`); }
        }
        for (const relId of createdReleaseIds) {
            let relDelAttempt = 0;   // 第 2 次起 404 视为已清
            try {
                await twice(async () => {
                    const isRetry = relDelAttempt++ > 0;   // 先于 fetch 计次：第 1 次 fetch 抛错时重试仍按第 2 次算
                    const r = await fetch(`${BASE_URL}/api/sys-releases/${relId}`, { method: 'DELETE', headers: jsonHeaders(adminTok), body: JSON.stringify({ reason: 'Playwright 夹具清理' }) });
                    if (isRetry && r.status === 404) return;
                    if (r.status !== 200) throw new Error(`清理 release=${relId} 删除非 200：${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
                });
            } catch (e) { console.error(`清理 release=${relId} 删除失败：${e.message}`); fail++; failDetails.push(`清理 release=${relId} 删除失败：${e.message}`); }
        }
        // 断言到磁盘：本文件登记过的 id 必须零残留（读端只读 SELECT；[#106 S4d-3] 回查本身失败也计失败，原来会让 finally 抛出而丢掉后续收尾）
        try {
            const leftIssues = createdIds.length ? await dbAll(`SELECT id FROM sys_issues WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds) : [];
            const leftRels = createdReleaseIds.length ? await dbAll(`SELECT id FROM sys_releases WHERE id IN (${createdReleaseIds.map(() => '?').join(',')})`, createdReleaseIds) : [];
            if (leftIssues.length || leftRels.length) { console.error(`清理残留：issues=${JSON.stringify(leftIssues)} releases=${JSON.stringify(leftRels)}`); fail++; failDetails.push(`清理残留：issues=${JSON.stringify(leftIssues)} releases=${JSON.stringify(leftRels)}`); }
            else console.log(`清理完成：issues=${createdIds.length} releases=${createdReleaseIds.length} 零残留`);
        } catch (e) { console.error(`零残留回查失败：${e.message}`); fail++; failDetails.push(`零残留回查失败：${e.message}`); }
    }
    try { await testEnv.teardown(); } catch (e) { console.error(`teardown（收掉自起实例）失败：${e.message}`); fail++; failDetails.push(`teardown 失败：${e.message}`); }
    // [MED-7] 退出码不得被清理残留静默吞掉——清理残留 / 回查失败 / teardown 失败都已同步自增 fail，退出码只由 fail 决定（[#106 S4d-3] 不再用 process.exitCode 旁路）。
    testEnv.finish(fail > 0 ? 1 : 0);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}

main().catch(async (e) => {
    console.error('测试运行异常：', e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
