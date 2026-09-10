/**
 * 系统迭代·C4 前端——修正入口 + 验收两步采用 + 静态守卫的浏览器冒烟
 * （538 方案 v1.5 §B.7 前端段 + D-L1·2026-09-10 决策记录：待对接测试态放开提交修正 + 对接测试通过
 * 同款版本锁两步采用 + 用户 2026-09-10 拍板去掉修正徽标）
 *
 * 方案：docs/local/系统迭代/提交修正与config指派OA守卫_方案_20260909_v1.5.md §B（前端段）+
 *   docs/local/系统迭代/待对接测试态放开提交修正_决策记录_20260910_v1.0.md（D-L1）
 * 后端契约：C3/C3b/C3c（POST /sys-issues/:id/submit/amend、详情 delivery_rev 与
 *   dev_assignees[].amend_no/changed/first_submitted_at/amended_at、accept/liaison-test-pass
 *   expected_delivery_rev → 409 DELIVERY_CHANGED）——均已在当前分支落地并通过
 *   verify-sys-submit-amend.js/verify-sys-liaison-test.js 等后端验证。
 *
 * 骨架抄 test-sys-config-flow-playwright.js：JWT 注入登录 + login.html 中继跳转 + 直查库断言范式 +
 * registerCreatedId 收尾清理（本文件清理走**直连 SQL 级联删除**而非真实 DELETE 端点——同
 * verify-sys-submit-amend.js 的 deleteIssueFully 范式，测试夹具清理不必走业务软删闸门）。
 *
 * 覆盖：
 *   T1 按钮显隐 × 5 态：开发中✓ / 处理中✓ / 待验证✓ / 待对接测试✓（D-L1 翻转·独立断言）/ 待上线✗
 *      （负向对照）/ 待指派✗
 *   T2（用户拍板去掉徽标）修正后 chip 不再出现「已修正」文案，时间 span 仍存在（回退为最新提交时刻）
 *   T3 切到「无代码交付」二次确认——commits→no_code 方向弹出 window.confirm，取消则不提交（请求数
 *      为零、库值不变），确认则提交成功
 *   T4 验收版本锁两步采用：admin 打开验收弹层上传凭证 → 另一开发通过 API 直调 amend 修改交付内容 →
 *      accept 409 DELIVERY_CHANGED → 「加载最新交付」区块含修正后说明/commit → 未点「采用」前确认
 *      按钮 disabled（JS 直调 siModalConfirm() 也应因按钮态被前端逻辑一并拒绝）→ 点「采用」→ accept
 *      200，且本次未再调用附件上传接口、accept 请求体携带首次上传的附件 id
 *   T5 步骤①（加载）后、步骤②（采用）前再次发生修正——采用后 accept 仍 409，回到步骤①、uploadedIds
 *      不丢（无需重新上传）
 */
'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;
const DEV_ID = 8;         // 示例开发A——本文件的「本人」开发账号
const SECOND_DEV_ID = 9;  // 示例开发B——两人团队场景的搭子/T4 的「他人」修正来源

const RUN_TAG = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const RUN_TAG_MARKER = `[RT-AMEND:${RUN_TAG}]`;
const TITLE_PREFIX = '[pw-submit-amend]';

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
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
        const p = path.join(os.tmpdir(), 'sys-playwright-shots', `amend-fail-${name}.png`);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}

// registerCreatedId：登记本次运行创建的迭代单 id，finally 统一级联清理（同 verify-sys-submit-amend.js
// deleteIssueFully 范式——测试夹具走直连 SQL 删除，不经业务 DELETE 端点软闸）。
const createdIds = [];
function registerCreatedId(id) { if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id); }
async function deleteIssueFully(issueId) {
    await dbRun(`DELETE FROM sys_issue_dev_events WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_dev_commits WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_attachments WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issues WHERE id=?`, [issueId]);
}

const _defaultDialogHandler = (d) => d.accept();
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', _defaultDialogHandler);   // 默认自动接受
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
// T3 需要精确断言 confirm() 弹窗文案并分别测试"取消"/"确认"两条分支——Playwright 同一个 dialog
// 事件若被多个监听器各自 accept/dismiss 会抛 "already handled" 异常（第二个监听器晚到时对话框
// 已被第一个处理掉）。用法：先摘掉 loginPage 装的默认 accept 监听器，装一次性精确处理器，用完后
// 装回默认监听器（不影响该 page 后续其它可能弹出的对话框）。
function withOneShotDialog(page, handler) {
    page.off('dialog', _defaultDialogHandler);
    page.once('dialog', async (d) => { try { await handler(d); } finally { page.on('dialog', _defaultDialogHandler); } });
}

function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js`)); });
    });
}

// ── API 夹具 ──────────────────────────────────────────────────────────────
let seq = 0;
async function apiCreate(adminTok, type, extra = {}) {
    seq++;
    const body = {
        intake_contract_version: 2, type,
        title: `${TITLE_PREFIX}-${type}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部',
        description: `C4 修正入口/验收版本锁 Playwright 夹具 ${RUN_TAG_MARKER}`,
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
async function apiEstimate(devTok, id, days) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr(30), estimated_effort_days: days || 1 }) });
    if (r.status !== 200) throw new Error(`[夹具 estimate] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSubmitCommits(devTok, id, ref) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: ref }], self_tested: true, test_env_deployed: true }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(`[夹具 submit-commits] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(j)}`);
    return j;
}

// F1：两人 improvement 团队，DEV_ID 提交 commits、SECOND_DEV_ID 留 pending——主状态停在「开发中」。
async function mkFixtureDevFamily(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910300 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    // 补第二名开发（pending，未提交）——阻止 W-GATE 自动推进到「待验证」。
    const reassignR = await fetch(`${BASE_URL}/api/sys-issues/${id}/reassign`, {
        method: 'POST', headers: jsonHeaders(adminTok),
        body: JSON.stringify({ member_ids: [DEV_ID, SECOND_DEV_ID], reason: 'Playwright 夹具：补第二名开发凑齐 DEV 族未完成态' }),
    });
    if (reassignR.status !== 200) throw new Error(`[夹具-DEV族] reassign 补搭子应 200，实得 ${reassignR.status} ${JSON.stringify(await reassignR.json().catch(() => null))}`);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-amend-dev-${id}`);
    if (sub.main_status !== '开发中') throw new Error(`[夹具-DEV族] main_status 应停在「开发中」，实得 ${sub.main_status}`);
    return id;
}
// F2：两人 bug 团队，DEV_ID 提交、SECOND_DEV_ID 留 pending——主状态停在「处理中」。
async function mkFixtureBugFamily(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'bug');
    await apiIntakeAccept(adminTok, id);
    await apiAssign(adminTok, id, DEV_ID);
    const reassignR = await fetch(`${BASE_URL}/api/sys-issues/${id}/reassign`, {
        method: 'POST', headers: jsonHeaders(adminTok),
        body: JSON.stringify({ member_ids: [DEV_ID, SECOND_DEV_ID], reason: 'Playwright 夹具：补第二名开发凑齐 DEV 族未完成态' }),
    });
    if (reassignR.status !== 200) throw new Error(`[夹具-bug族] reassign 补搭子应 200，实得 ${reassignR.status} ${JSON.stringify(await reassignR.json().catch(() => null))}`);
    const submitR = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: `pw-amend-bug-${id}` }], self_tested: true, test_env_deployed: true, bug_cause_note: 'Playwright 夹具：bug 产生原因' }),
    });
    const j = await submitR.json().catch(() => null);
    if (submitR.status !== 200) throw new Error(`[夹具-bug族] submit 应 200，实得 ${submitR.status} ${JSON.stringify(j)}`);
    if (j.main_status !== '处理中') throw new Error(`[夹具-bug族] main_status 应停在「处理中」，实得 ${j.main_status}`);
    return id;
}
// F3：单人 improvement，全完成自动进「待验证」。
async function mkFixtureVerify(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910400 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-amend-verify-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-待验证] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// [C4b·Opus 预筛 M-5] F3b：两名在册开发共同完成，全完成自动进「待验证」——供 T4/T5 使用，让"他人 amend"
// 真的是**另一名在册开发**（secondDevTok/SECOND_DEV_ID）而非验收人自己那份夹具的提交者本人（DEV_ID/
// devTok）。覆盖"两名在册开发互相顶版本"这一真实场景（此前 T4/T5 注释声称"另一开发直调 amend"但实际
// 传的是 devTok，secondDevTok 全程是从未被使用过的死变量）。
async function mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910700 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    const reassignR = await fetch(`${BASE_URL}/api/sys-issues/${id}/reassign`, {
        method: 'POST', headers: jsonHeaders(adminTok),
        body: JSON.stringify({ member_ids: [DEV_ID, SECOND_DEV_ID], reason: 'Playwright 夹具：两名在册开发共同完成，供他人 amend 用例使用' }),
    });
    if (reassignR.status !== 200) throw new Error(`[夹具-两人待验证] reassign 补第二名开发应 200，实得 ${reassignR.status} ${JSON.stringify(await reassignR.json().catch(() => null))}`);
    await apiEstimate(devTok, id, 1);
    const sub1 = await apiSubmitCommits(devTok, id, `pw-amend-verify2-${id}-a`);
    if (sub1.main_status !== '开发中') throw new Error(`[夹具-两人待验证] 第一人提交后应仍在「开发中」（第二人未完成），实得 ${sub1.main_status}`);
    const submit2R = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(secondDevTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: `pw-amend-verify2-${id}-b` }], self_tested: true, test_env_deployed: true }),
    });
    const sub2 = await submit2R.json().catch(() => null);
    if (submit2R.status !== 200 || !sub2 || sub2.main_status !== '待验证') throw new Error(`[夹具-两人待验证] 第二人提交后应落「待验证」，实得 ${submit2R.status} ${JSON.stringify(sub2)}`);
    return id;
}
// [C4d·codex 539 H1] F3c：admin 本人同时是唯一在册开发（真实业务上可行——探针实测 assign 端点不拒绝
// user_id=1）。供 T11 使用：同一个浏览器会话（admin token）既能看到「修正我的提交」（自己是在册开发），
// 又能看到「验收打回」（admin 身份），才能在同一页面里测"取消修正弹层→改开打回弹层"这条真实路径，
// 不必伪造跨用户会话切换。
async function mkFixtureVerifyAdminDev(adminTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910800 + seq);
    const assignR = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, {
        method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: ADMIN_ID }),
    });
    if (assignR.status !== 200) throw new Error(`[夹具-admin自任开发] assign 应 200，实得 ${assignR.status} ${JSON.stringify(await assignR.json().catch(() => null))}`);
    await apiEstimate(adminTok, id, 1);
    const sub = await apiSubmitCommits(adminTok, id, `pw-amend-admindev-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-admin自任开发] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F4：单人 feature，全完成自动进「待对接测试」（LIAISON_TEST 族，D-L1·2026-09-10 决策记录后已在
// SI_AMEND_STATUSES 里，推翻 v1.5 原「LIAISON_TEST 锁死」已决点）。
async function mkFixtureLiaisonTest(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'feature');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910500 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-amend-liaison-${id}`);
    if (sub.main_status !== '待对接测试') throw new Error(`[夹具-待对接测试] main_status 应为「待对接测试」，实得 ${sub.main_status}`);
    return id;
}
// F5：单人 improvement 到「待验证」后 admin 直接 accept（无附件/说明，走软确认二次调用）→「待上线」。
async function mkFixtureRelease(adminTok, devTok) {
    // [夹具-待上线] 「软确认二次点击」是前端 siModalAccept 自己的 UX 拦截（未填说明/无附件时先警示、
    // 第二次点确定才真提交），不是后端契约——直调 API 一次即真实提交，无需模拟两次点击。
    const id = await mkFixtureVerify(adminTok, devTok);
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || j.status !== '待上线') throw new Error(`[夹具-待上线] accept 应 200 且落「待上线」，实得 ${r.status} ${JSON.stringify(j)}`);
    return id;
}
// F6：新建 + 受理通过，未指派——DEV_ID 从未进入花名册。
async function mkFixturePending(adminTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    return id;
}

async function main() {
    await ensureServerListening();
    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const secondDevTok = await signAs(SECOND_DEV_ID);
    const browser = await chromium.launch();
    try {
        console.log('=== 系统迭代 C4：修正入口 + 验收两步采用——前端 Playwright ===');

        // ══════════════════════════════════════════════════════════════════
        // T1：按钮显隐 × 5 态
        // ══════════════════════════════════════════════════════════════════
        {
            const idDev = await mkFixtureDevFamily(adminTok, devTok);
            const idBug = await mkFixtureBugFamily(adminTok, devTok);
            const idVerify = await mkFixtureVerify(adminTok, devTok);
            const idLiaison = await mkFixtureLiaisonTest(adminTok, devTok);
            const idRelease = await mkFixtureRelease(adminTok, devTok);
            const idPending = await mkFixturePending(adminTok);

            async function amendBtnVisible(id) {
                const page = await loginPage(browser, devTok);
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                const visible = await page.locator('#siDActions button:has-text("修正我的提交")').count();
                await page.close();
                return visible > 0;
            }
            must(await amendBtnVisible(idDev) === true, 'T1 开发中态（DEV 族，本人 code_submitted）「修正我的提交」按钮可见');
            must(await amendBtnVisible(idBug) === true, 'T1 处理中态（bug DEV 族，本人 code_submitted）「修正我的提交」按钮可见');
            must(await amendBtnVisible(idVerify) === true, 'T1 待验证态（VERIFY 族，本人 code_submitted）「修正我的提交」按钮可见');
            must(await amendBtnVisible(idLiaison) === true, 'T1【独立断言·D-L1 翻转】待对接测试态（LIAISON_TEST 族，已在 SI_AMEND_STATUSES 里，推翻 v1.5 锁死）「修正我的提交」按钮可见');
            must(await amendBtnVisible(idRelease) === false, 'T1 待上线态「修正我的提交」按钮不可见（负向对照，防集合扩容后无人盯，决策记录 §5）');
            must(await amendBtnVisible(idPending) === false, 'T1 待指派态（本人未进花名册）「修正我的提交」按钮不可见');
        }

        // ══════════════════════════════════════════════════════════════════
        // T2（用户 2026-09-10 拍板：去掉「已修正 ×N」徽标）：修正后 chip 不应再出现徽标文案，时间
        //   显示回退"最新提交时刻"；后端 amend_no/changed 修正链留痕不受影响（仍写库，只是前端不再
        //   单独渲染），本条只断言 UI 侧、DB 侧留痕由 verify-sys-submit-amend.js 覆盖。
        // T3：切到「无代码交付」二次确认（commits→no_code 删 commit 行警示）
        // ══════════════════════════════════════════════════════════════════
        {
            // [codex 542·M2] 用两人夹具——DEV_ID（示例开发A）做修正，SECOND_DEV_ID（示例开发B）从不修正，供下方
            //   「无修正成员回退显示首次提交时刻」对照。
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            // [codex 543·M-a] 首次提交时间的「改早 1 小时」必须发生在 page.goto **之前**——若在页面加载后才改，
            //   页面已缓存未改早的首次提交时刻，首次提交与修正同秒完成时，chip 即便根本没刷新也会同时满足
            //   「= 最新修正时刻」与「≠ 改早后的首次时刻」，断言恒真。改早后先断言 chip 显示的就是改早值
            //   （证明页面读到的是 DB 现值），再修正、再断言更新。
            const daRowT2 = await dbGet(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(!!daRowT2, 'T2 前置：应能查到示例开发A的在册行');
            const firstEventT2 = await dbGet(`SELECT id, created_at FROM sys_issue_dev_events WHERE dev_assignee_id=? ORDER BY id ASC LIMIT 1`, [daRowT2.id]);
            must(!!firstEventT2, 'T2 前置：应能查到首次提交事件');
            await dbRun(`UPDATE sys_issue_dev_events SET created_at = datetime(created_at, '-1 hour') WHERE id=?`, [firstEventT2.id]);
            await dbRun(`UPDATE sys_issue_dev_assignees SET resolved_at = datetime(resolved_at, '-1 hour') WHERE id=?`, [daRowT2.id]);
            const firstEventT2Shifted = await dbGet(`SELECT created_at FROM sys_issue_dev_events WHERE id=?`, [firstEventT2.id]);
            const eventsBeforeT2 = await dbAll(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=?`, [daRowT2.id]);
            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            // [codex 543·M-a] 修正前的基线断言：chip 时间 title 应等于改早后的首次提交时刻——证明页面持有的是
            //   DB 现值而非陈旧缓存；「实现坏成什么样这条会红」：timeSpan 若不读 first_submitted_at 或页面
            //   读的是别的列，此处即红。
            const preChipTitleT2 = await page.locator('.si-dev-chip', { hasText: '示例开发A' }).first().locator('.si-dev-chip-time').first().getAttribute('title').catch(() => '');
            const preExpectedTitleT2 = await page.evaluate((v) => (typeof siFmtDTSec === 'function' ? siFmtDTSec(v) : ''), firstEventT2Shifted.created_at);
            must(preChipTitleT2 === preExpectedTitleT2, `T2 修正前 chip 时间 title 应等于改早后的首次提交时刻，实得="${preChipTitleT2}"，期望="${preExpectedTitleT2}"`);

            // [codex 542·M2] 判别力改造：旧断言只查「dev_status 仍 code_submitted」（修正前就恒成立）+
            //   「时间 span 存在」，改前改后同样能通过，没有判别力。改为：① dev_events 最新事件
            //   payload_json.work_note 精确等于本次修正值 + 事件数 +1；② 把首次提交事件的 created_at
            //   （连同 dev_assignees.resolved_at——两者同一次写入同源，first_submitted_at 读的是
            //   resolved_at）一并改早 1 小时，制造与修正后事件明显不同的时间戳，断言目标成员时间 span
            //   的 title 精确等于"最新修正事件时刻"（siFmtDTSec 格式）且不等于"首次提交时刻"；③ 补无
            //   修正成员（示例开发B）应回退显示首次提交时刻的对照组。
            // T2：做一次「只改工作说明」的修正（commits→commits 方向，不触发二次确认）。
            await page.click('#siDActions button:has-text("修正我的提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#siAmendWorkNote', 'Playwright T2：补充工作说明');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);

            const eventsAfterT2 = await dbAll(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=?`, [daRowT2.id]);
            must(eventsAfterT2.length === eventsBeforeT2.length + 1, `T2 前置：amend 应新增恰 1 条 dev_events，前=${eventsBeforeT2.length}，后=${eventsAfterT2.length}`);
            const latestEventT2 = await dbGet(`SELECT payload_json, created_at FROM sys_issue_dev_events WHERE dev_assignee_id=? ORDER BY id DESC LIMIT 1`, [daRowT2.id]);
            let latestPayloadT2 = null; try { latestPayloadT2 = JSON.parse(latestEventT2.payload_json); } catch (_) { /* ignore */ }
            must(!!latestPayloadT2 && latestPayloadT2.work_note === 'Playwright T2：补充工作说明', `T2 前置：最新事件 payload_json.work_note 应精确等于本次修正值，实得=${JSON.stringify(latestPayloadT2)}`);

            const chipText = await page.locator('.si-dev-chip', { hasText: '示例开发A' }).first().innerText().catch(() => '');
            must(!chipText.includes('已修正'), `T2 修正后 chip 不应再出现"已修正"徽标文案（用户拍板已去掉），实得="${chipText}"`);
            const chipTitleUnused = await page.locator('.si-dev-chip', { hasText: '示例开发A' }).first().locator('.si-dev-chip-time', { hasText: '已修正' }).count();
            must(chipTitleUnused === 0, `T2 不应存在带"已修正"文案的时间 span，实得计数=${chipTitleUnused}`);

            const chipTitleT2 = await page.locator('.si-dev-chip', { hasText: '示例开发A' }).first().locator('.si-dev-chip-time').first().getAttribute('title').catch(() => '');
            const expectedAmendedTitleT2 = await page.evaluate((v) => (typeof siFmtDTSec === 'function' ? siFmtDTSec(v) : ''), latestEventT2.created_at);
            const firstSubmitTitleT2 = await page.evaluate((v) => (typeof siFmtDTSec === 'function' ? siFmtDTSec(v) : ''), firstEventT2Shifted.created_at);
            must(chipTitleT2 === expectedAmendedTitleT2, `T2 chip 时间 span title 应精确等于最新修正事件时刻（siFmtDTSec 格式），实得="${chipTitleT2}"，期望="${expectedAmendedTitleT2}"`);
            must(chipTitleT2 !== firstSubmitTitleT2, `T2 chip 时间 span title 不应仍等于首次提交时刻（应已随修正更新为最新事件时刻），实得="${chipTitleT2}"，首次提交时刻="${firstSubmitTitleT2}"`);

            // 无修正成员（示例开发B/SECOND_DEV_ID，从未 amend）——回退显示首次提交时刻，与上方形成对照。
            const secondDaRowT2 = await dbGet(`SELECT id, resolved_at FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, SECOND_DEV_ID]);
            must(!!secondDaRowT2, 'T2 前置：应能查到示例开发B的在册行');
            const secondChipTitleT2 = await page.locator('.si-dev-chip', { hasText: '示例开发B' }).first().locator('.si-dev-chip-time').first().getAttribute('title').catch(() => '');
            const expectedSecondTitleT2 = await page.evaluate((v) => (typeof siFmtDTSec === 'function' ? siFmtDTSec(v) : ''), secondDaRowT2.resolved_at);
            must(secondChipTitleT2 === expectedSecondTitleT2, `T2 无修正成员（示例开发B）chip 时间 span title 应回退显示首次提交时刻，实得="${secondChipTitleT2}"，期望="${expectedSecondTitleT2}"`);

            // T3：再修正一次，这次切到「无代码交付」——commits→no_code 应弹出二次确认，取消则不提交。
            await page.click('#siDActions button:has-text("修正我的提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.click('input[name="si-amend-mode"][value="no_code"]');
            await page.fill('#siAmendNoCodeReason', 'Playwright T3：切换为无代码交付说明，trim 后需 ≥1 字');
            let confirmMsg = '';
            withOneShotDialog(page, async d => { confirmMsg = d.message(); await d.dismiss(); });   // 取消——不提交
            let amendReqCountCancel = 0;
            const onReqCancel = req => { if (req.method() === 'POST' && /\/submit\/amend$/.test(new URL(req.url()).pathname)) amendReqCountCancel++; };
            page.on('request', onReqCancel);
            await page.click('#siMConfirm');
            await page.waitForTimeout(400);
            page.off('request', onReqCancel);
            await shotOnFail(page, confirmMsg.includes('commit') && /\d/.test(confirmMsg), 't3-confirm-text', `T3 二次确认弹窗文案含 commit 条数提示，实得="${confirmMsg}"`);
            must(amendReqCountCancel === 0, 'T3 取消二次确认后未发起 amend 请求（零副作用）');
            const rowAfterCancel = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(rowAfterCancel && rowAfterCancel.dev_status === 'code_submitted', 'T3 取消后库值仍为 code_submitted（未被切换）');
            // window.confirm 被取消后 onConfirm 返回 false——siModal 框架不关弹层（同其余弹窗"校验不过
            // 不关窗"的既有范式），须显式点「取消」关闭，才能重新打开一次干净的弹层测确认分支。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(200);

            // 再来一次，这次确认——应正常提交成功，落 no_code。
            await page.click('#siDActions button:has-text("修正我的提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.click('input[name="si-amend-mode"][value="no_code"]');
            await page.fill('#siAmendNoCodeReason', 'Playwright T3：切换为无代码交付说明（确认分支）');
            withOneShotDialog(page, async d => { await d.accept(); });
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const rowAfterConfirm = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(rowAfterConfirm && rowAfterConfirm.dev_status === 'no_code', 'T3 确认后库值切为 no_code');
            const commitsAfter = await dbAll(`SELECT id FROM sys_issue_dev_commits WHERE issue_id=? AND dev_user_id=?`, [id, DEV_ID]);
            must(commitsAfter.length === 0, 'T3 确认后原 commit 行已被删除');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T4/T5：验收版本锁两步采用
        // ══════════════════════════════════════════════════════════════════
        {
            // [C4b·Opus 预筛 M-5] 两名在册开发共同完成的夹具——"他人 amend"下面真用 secondDevTok（示例开发B），
            // 覆盖"两名在册开发互相顶版本"这一真实场景，不再是 devTok（本夹具的第一提交者）自己顶自己。
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            let acceptReqCount = 0, uploadReqCount = 0;
            let lastAcceptBody = null;
            const onReq = async (req) => {
                if (req.method() !== 'POST') return;
                const p = new URL(req.url()).pathname;
                if (p === `/api/sys-issues/${id}/accept`) { acceptReqCount++; try { lastAcceptBody = JSON.parse(req.postData() || '{}'); } catch (_) { lastAcceptBody = null; } }
                else if (p === `/api/sys-issues/${id}/attachments`) uploadReqCount++;
            };
            page.on('request', onReq);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            // 上传一个凭证文件（PNG 最小合法字节）。
            const tmpPng = path.join(os.tmpdir(), `pw-amend-evidence-${id}.png`);
            fs.writeFileSync(tmpPng, Buffer.from('89504e470d0a1a0a', 'hex'));
            await page.setInputFiles('#siPickerInput_accept-evidence', tmpPng);
            await page.fill('#f_note', 'Playwright T4：验收说明');

            // 点「确定」——本次会先上传凭证（1 次 /attachments），随后 accept 因为下面这行「他人 amend」
            // 尚未发生，本次应 200 成功……为制造 409，改为：先点确定触发上传+首次 accept 成功前，
            // 在浏览器发出 accept 请求之前用 API 直调完成一次「他人 amend」——用 page.route 拦截
            // accept 请求，在放行前先完成 amend，制造货真价实的竞态（比先后调用顺序更贴近真实并发）。
            let routeHitCount = 0, amendBeforeAcceptStatus = null;
            await page.route(`**/api/sys-issues/${id}/accept`, async route => {
                routeHitCount++;
                if (routeHitCount === 1) {
                    // 第一次拦截：先让"另一名在册开发"（secondDevTok/示例开发B，非本夹具第一提交者 devTok）
                    // 完成一次修正（changed 交付内容与 delivery_rev），再放行原请求。
                    const amendR = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                        method: 'POST', headers: jsonHeaders(secondDevTok),
                        body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T4：他人在验收弹层打开期间完成的修正说明' }),
                    });
                    amendBeforeAcceptStatus = amendR.status;
                }
                await route.continue();
                await page.unroute(`**/api/sys-issues/${id}/accept`);
            });
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            must(amendBeforeAcceptStatus === 200, `T4 竞态注入：他人 amend（secondDevTok 直调，另一名在册开发）在真实 accept 请求放行前应 200 成功，实得=${amendBeforeAcceptStatus}`);

            must(uploadReqCount === 1, `T4 首次提交应恰上传 1 次凭证，实得 ${uploadReqCount} 次`);
            // [C4b·Opus 预筛 M-4] 原判据 `lastAcceptBody.code === undefined` 恒真（请求体是本页面自己
            // 构造发出的 JSON，从不含 code 键——那是响应体才有的字段，断言判据点错了报文方向，实现
            // 无论对错这条都会绿）。改判"确实发出了这次 accept 请求"这个真正想证明的事：acceptReqCount。
            const firstAttemptAttachmentIds = lastAcceptBody && Array.isArray(lastAcceptBody.attachment_ids) ? lastAcceptBody.attachment_ids.slice() : null;
            await shotOnFail(page, acceptReqCount >= 1, 't4-first-accept-sent', `T4 首次 accept 请求已发出（实得请求数=${acceptReqCount}）`);
            must(!!(firstAttemptAttachmentIds && firstAttemptAttachmentIds.length === 1), `T4 首次 accept 请求体应携带恰 1 个刚上传的附件 id，实得=${JSON.stringify(firstAttemptAttachmentIds)}`);

            const bannerVisible = await page.locator('#siAcceptConflictBanner').isVisible().catch(() => false);
            await shotOnFail(page, bannerVisible, 't4-conflict-banner', 'T4 accept 409 DELIVERY_CHANGED 后阻断横幅应可见（弹层未关闭）');
            const confirmDisabled = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmDisabled, 'T4 冲突态下确认按钮 disabled（DOM 属性级）');
            // [C4c·codex 538 M3] 原判据只证明"浏览器不会对 disabled 元素触发 .click() 绑定的 onclick"
            // ——这是任何 <button disabled> 元素的通用浏览器行为，与本功能是否正确实现无关，换成一个
            // 完全没做版本锁的弹层同样会通过这条断言。改为**直接调用** siModalConfirm()（跳过 DOM
            // disabled 属性这层，模拟"万一有别的代码路径绕过按钮直接调用这个函数"），断言真正的业务
            // 副作用（accept/上传请求计数）确实没有发生——这才是"确认键在冲突态下不可用"这句话的
            // 真正含义（siModalConfirm 是本页面顶层 let 声明，同一 script 全局词法作用域内可被
            // page.evaluate 新注入的代码直接按名引用，无需 window. 前缀）。
            const acceptCountBeforeNoOp1 = acceptReqCount, uploadCountBeforeNoOp1 = uploadReqCount;
            await page.evaluate(() => siModalConfirm());
            await page.waitForTimeout(300);
            must(acceptReqCount === acceptCountBeforeNoOp1, 'T4 冲突态下直调 siModalConfirm() 不应发起新的 accept 请求');
            must(uploadReqCount === uploadCountBeforeNoOp1, 'T4 冲突态下直调 siModalConfirm() 不应发起新的上传请求');
            const confirmStillDisabledAfterNoOp1 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmStillDisabledAfterNoOp1, 'T4 冲突态下直调 siModalConfirm() 之后确认按钮仍 disabled');

            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            const candidateText = await page.locator('#siAcceptCandidateBox').innerText().catch(() => '');
            await shotOnFail(page, candidateText.includes('无代码交付') && candidateText.includes('T4：他人在验收弹层打开期间完成的修正说明'), 't4-candidate-content', `T4「加载最新交付」区块含修正后内容，实得="${candidateText.slice(0, 200)}"`);
            // [codex 542·第4条] 候选视图去掉「已修正 ×N」次数字样，只留改动清单——断言同步改为查
            //   "本次修正改动：" 前缀存在（具体维度由后端 changed[] 决定，不在此处硬编码猜测字段名）。
            await shotOnFail(page, candidateText.includes('本次修正改动：'), 't4-candidate-amend', `T4 候选区块含修正链改动清单（不含次数字样），实得="${candidateText.slice(0, 200)}"`);
            must(!candidateText.includes('已修正 ×'), 'T4 候选区块不应再出现「已修正 ×」次数字样（用户拍板已去掉，与 chip 同口径）');

            const confirmStillDisabled = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmStillDisabled, 'T4 加载完成、尚未点「采用」时确认按钮仍 disabled');
            // [C4c·codex 538 M3] 第二种状态——加载完成、候选已渲染但尚未点「采用」——同样直调
            // siModalConfirm()，断言仍无业务副作用（区别于冲突态：这里 candidateRev 已非空，若
            // candidateAdopted 的判定逻辑有漏洞，这个状态最容易被误放行）。
            const acceptCountBeforeNoOp2 = acceptReqCount, uploadCountBeforeNoOp2 = uploadReqCount;
            await page.evaluate(() => siModalConfirm());
            await page.waitForTimeout(300);
            must(acceptReqCount === acceptCountBeforeNoOp2, 'T4「加载完成未采用」态下直调 siModalConfirm() 不应发起新的 accept 请求');
            must(uploadReqCount === uploadCountBeforeNoOp2, 'T4「加载完成未采用」态下直调 siModalConfirm() 不应发起新的上传请求');
            const confirmStillDisabledAfterNoOp2 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmStillDisabledAfterNoOp2, 'T4「加载完成未采用」态下直调 siModalConfirm() 之后确认按钮仍 disabled');

            await page.click('#siAcceptAdoptBtn');
            await page.waitForTimeout(200);
            const confirmEnabledAfterAdopt = await page.locator('#siMConfirm').isDisabled().catch(() => true);
            must(confirmEnabledAfterAdopt === false, 'T4 点「采用此版本」后确认按钮恢复可点');
            const bannerHiddenAfterAdopt = await page.locator('#siAcceptConflictBanner').isVisible().catch(() => true);
            must(bannerHiddenAfterAdopt === false, 'T4 采用后阻断横幅隐藏');

            const acceptCountBeforeSecond = acceptReqCount;
            const uploadCountBeforeSecond = uploadReqCount;
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            must(acceptReqCount === acceptCountBeforeSecond + 1, 'T4 采用后再次点确定发起了第二次 accept 请求');
            must(uploadReqCount === uploadCountBeforeSecond, 'T4 采用后重新提交未再调用上传接口（凭证复用首次上传的 id）');
            // [C4b·Opus 预筛 M-4] 补第二次（采用后真正成功的那次）accept 请求体的 attachment_ids 与首次
            // 请求体逐值比对——"未再调用上传接口"只证明没发第二次上传请求，不证明第二次 accept 请求体
            // 携带的还是**同一批**附件 id（万一前端在某个分支悄悄把 uploadedIds 清空/替换，这条会漏检）。
            const secondAttemptAttachmentIds = lastAcceptBody && Array.isArray(lastAcceptBody.attachment_ids) ? lastAcceptBody.attachment_ids : null;
            let deepEqOk = false;
            try { assert.deepStrictEqual(secondAttemptAttachmentIds, firstAttemptAttachmentIds); deepEqOk = true; } catch (_) { deepEqOk = false; }
            must(deepEqOk, `T4 采用后第二次 accept 请求体 attachment_ids 应与首次逐值相同（凭证 id 未变），首次=${JSON.stringify(firstAttemptAttachmentIds)}，本次=${JSON.stringify(secondAttemptAttachmentIds)}`);
            const finalStatus = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [id]);
            // [C4b·Opus 预筛 M-5 连带更正] 两人夹具下，"他人"（secondDevTok）修正把自己的 commits→
            // no_code，但另一名开发（devTok/DEV_ID）名下仍有 1 条 commit——不满足 C9 免上线直翻的
            // "零 commit"条件，故落常规「待上线」而非「已上线」（单人夹具时代的旧断言"命中零 commit
            // 免上线直翻"已随夹具改为两人不再成立，按实际业务结果核验，非测试预期写死错误）。
            must(finalStatus && finalStatus.status === '待上线', `T4 最终 accept 成功，落「待上线」（两人夹具下仍有另一人的 commit，不满足零 commit 免上线直翻条件），实得=${finalStatus && finalStatus.status}`);
            const finalTl = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id]);
            let finalPayload = null; try { finalPayload = JSON.parse(finalTl.payload_json); } catch (_) { /* ignore */ }
            must(!!(finalPayload && Array.isArray(finalPayload.attachment_ids) && finalPayload.attachment_ids.length === 1), `T4 最终 accept 落库 payload_json.attachment_ids 恰含首次上传的 1 个附件 id，实得=${JSON.stringify(finalPayload)}`);

            page.off('request', onReq);
            try { fs.unlinkSync(tmpPng); } catch (_) { /* ignore */ }
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T5：步骤①（加载）后、步骤②（采用）前再次发生修正——采用后 accept 仍应 409，回到步骤①，
        //   uploadedIds 不丢（无需重新上传）。
        // ══════════════════════════════════════════════════════════════════
        {
            // [C4b·Opus 预筛 M-5] 同 T4——两人夹具，"他人 amend"真用 secondDevTok（另一名在册开发）。
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            let uploadReqCount = 0, acceptReqCount = 0;
            let lastAcceptBody = null;
            const onReq = req => {
                if (req.method() !== 'POST') return;
                const p = new URL(req.url()).pathname;
                if (p === `/api/sys-issues/${id}/attachments`) uploadReqCount++;
                else if (p === `/api/sys-issues/${id}/accept`) { acceptReqCount++; try { lastAcceptBody = JSON.parse(req.postData() || '{}'); } catch (_) { lastAcceptBody = null; } }
            };
            page.on('request', onReq);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const tmpPng = path.join(os.tmpdir(), `pw-amend-evidence-t5-${id}.png`);
            fs.writeFileSync(tmpPng, Buffer.from('89504e470d0a1a0a', 'hex'));
            await page.setInputFiles('#siPickerInput_accept-evidence', tmpPng);
            await page.fill('#f_note', 'Playwright T5：验收说明');
            // 制造首次冲突：点确定前先让"另一名在册开发"（secondDevTok）完成一次修正。
            await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T5：第一次他人修正' }),
            });
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const firstAttemptAttachmentIds = lastAcceptBody && Array.isArray(lastAcceptBody.attachment_ids) ? lastAcceptBody.attachment_ids.slice() : null;
            must(!!(firstAttemptAttachmentIds && firstAttemptAttachmentIds.length === 1), `T5 首次 accept 请求体应携带恰 1 个刚上传的附件 id，实得=${JSON.stringify(firstAttemptAttachmentIds)}`);
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            // 步骤①（加载）已完成、步骤②（采用）尚未点击——此刻再来一次修正，制造"候选版本又过期"。
            await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T5：加载后、采用前的第二次他人修正' }),
            });
            await page.click('#siAcceptAdoptBtn');
            await page.waitForTimeout(200);
            const uploadCountBeforeThird = uploadReqCount;
            // [C4c·codex 538 M1] 记录点击「确定」前的 toast 状态——第二次冲突应弹出"交付仍在更新，请
            // 稍后重试"（consecutiveConflicts 此刻应为 1→2，不再是 adopt() 把它清零后的 0→1）。
            await page.evaluate(() => { document.querySelectorAll('#toast-container > *').forEach(el => { el.dataset.pwSeen = '1'; }); });
            await page.click('#siMConfirm');   // 采用的是已过期的候选——accept 应再次 409
            await page.waitForTimeout(800);
            const bannerVisibleAgain = await page.locator('#siAcceptConflictBanner').isVisible().catch(() => false);
            must(bannerVisibleAgain, 'T5 采用过期候选后 accept 仍 409，重新回到阻断态（横幅再次可见）');
            must(uploadReqCount === uploadCountBeforeThird, 'T5 第二次冲突未触发重新上传（uploadedIds 未丢失）');
            const toastTextSecondConflict = await page.evaluate(() => {
                const el = Array.from(document.querySelectorAll('#toast-container > *')).find(n => !n.dataset.pwSeen);
                return el ? el.textContent : '';
            }).catch(() => '');
            must((toastTextSecondConflict || '').includes('交付仍在更新，请稍后重试'), `T5 第二次冲突应提示"交付仍在更新，请稍后重试"（M1：consecutiveConflicts 不再被 adopt() 清零），实得="${toastTextSecondConflict}"`);

            // [C4c·codex 538 M1/M3] 第二次冲突后直调「采用」应无效——此刻 candidateRev 已被 409 分支
            // 清空（同 loadLatest 里"进入加载中即清空"同一状态机规则：409 之后视同"候选已失效，须
            // 重新加载"），确认键应仍 disabled。
            const acceptCountBeforeNoOpAdopt = acceptReqCount;
            await page.evaluate(() => siAcceptAdoptCandidate());
            await page.waitForTimeout(200);
            must(acceptReqCount === acceptCountBeforeNoOpAdopt, 'T5 第二次冲突后直调 siAcceptAdoptCandidate() 不应发起新的 accept 请求');
            const confirmDisabledAfterNoOpAdopt = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmDisabledAfterNoOpAdopt, 'T5 第二次冲突后直调采用应无效，确认按钮仍 disabled');

            // 重新走一遍「加载→采用→提交」，这次应真正成功（没有第三次外部修正插入）。
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            await page.click('#siAcceptAdoptBtn');
            await page.waitForTimeout(200);
            const uploadCountBeforeFinal = uploadReqCount;
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            must(uploadReqCount === uploadCountBeforeFinal, 'T5 最终提交未再调用上传接口（凭证复用首次上传的 id）');
            const finalAttachmentIds = lastAcceptBody && Array.isArray(lastAcceptBody.attachment_ids) ? lastAcceptBody.attachment_ids : null;
            let finalDeepEqOk = false;
            try { assert.deepStrictEqual(finalAttachmentIds, firstAttemptAttachmentIds); finalDeepEqOk = true; } catch (_) { finalDeepEqOk = false; }
            must(finalDeepEqOk, `T5 最终 accept 请求体 attachment_ids 应与首次逐值相同，首次=${JSON.stringify(firstAttemptAttachmentIds)}，最终=${JSON.stringify(finalAttachmentIds)}`);
            const finalStatusT5 = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [id]);
            must(finalStatusT5 && finalStatusT5.status === '待上线', `T5 最终提交应成功落「待上线」，实得=${finalStatusT5 && finalStatusT5.status}`);
            const finalTlT5 = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id]);
            let finalPayloadT5 = null; try { finalPayloadT5 = JSON.parse(finalTlT5.payload_json); } catch (_) { /* ignore */ }
            must(!!(finalPayloadT5 && Array.isArray(finalPayloadT5.attachment_ids) && finalPayloadT5.attachment_ids.length === 1 && finalPayloadT5.attachment_ids[0] === firstAttemptAttachmentIds[0]), `T5 最终 accept 落库 payload_json.attachment_ids 应恰含首次上传的附件 id，实得=${JSON.stringify(finalPayloadT5)}`);

            page.off('request', onReq);
            try { fs.unlinkSync(tmpPng); } catch (_) { /* ignore */ }
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T6（C4b·Opus 预筛 M-1 回归）：「加载最新交付」GET 在途时关闭验收弹层、改开另一个弹层——
        //   迟到的 GET 响应不应把全局 #siMConfirm 钉死禁用。原实现只判 acceptLoading/acceptLoadSeq
        //   （防"重复点加载"），未防"弹层已换"这种更粗的竞态：旧闭包持有的 candidateRev/adopt() 已经
        //   不是当前弹层在用的那个，但 dataset.keepDisabled='1' 是全局单例 DOM 属性，一旦被设置且没人
        //   再解开，任何后续新弹层的确定键都会被永久点不动。修法见 siModalAccept 内 myFlow 身份令牌 +
        //   siCloseModal 清空 siAcceptFlow。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 制造一次版本冲突，让「加载最新交付」按钮出现。
            const amendR = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T6：制造冲突以露出加载最新交付按钮' }),
            });
            must(amendR.status === 200, `T6 前置：制造冲突的 amend 应 200, got ${amendR.status}`);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T6：验收说明（避开软确认二次点击）');
            await page.click('#siMConfirm');   // 闭包捕获的 baselineRev 已过期——应 409
            await page.waitForTimeout(600);
            const bannerVisibleT6 = await page.locator('#siAcceptConflictBanner').isVisible().catch(() => false);
            await shotOnFail(page, bannerVisibleT6, 't6-conflict-banner', 'T6 前置：冲突横幅可见（「加载最新交付」按钮已露出）');

            // 拦截详情 GET（仅精确匹配 /api/sys-issues/{id} 本身，不影响 /accept、/submit/amend 等其它
            // 路径）——人为延迟响应，制造"GET 在途"窗口。
            let releaseDetailGet;
            const detailGetHeld = new Promise((resolve) => { releaseDetailGet = resolve; });
            await page.route(`**/api/sys-issues/${id}`, async (route) => { await detailGetHeld; await route.continue(); });
            await page.click('#siAcceptLoadLatestBtn');   // 触发 GET，被上面的 route 拦住不放行
            await page.waitForTimeout(300);

            // GET 仍在途时关闭验收弹层（点「取消」——siCloseModal 应清空 siAcceptFlow），随即改开
            // 另一个弹层（验收打回）——**此刻迟到的 GET 尚未放行**，模拟"响应回来之前用户已经在操作
            // 下一个弹层"这个更贴近真实竞态的顺序（比"先放行 GET 等它处理完、再开新弹层"更严格：
            // 后者顺序下，新弹层是在 loadLatest 的续体已经跑完之后才打开，即便 myFlow 守卫失效，
            // siModal() 开新弹层时也会重置 dataset.keepDisabled，测不出 loadLatest 续体本身有没有
            // 弄脏共享 DOM 这件事）。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(150);
            await page.click('#siDActions button:has-text("验收打回")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 现在才放行被拦住的 GET——迟到响应在打回弹层已经打开、可交互之后才到达。
            releaseDetailGet();
            await page.waitForTimeout(500);
            await page.unroute(`**/api/sys-issues/${id}`);

            const returnConfirmDisabled = await page.locator('#siMConfirm').isDisabled().catch(() => true);
            await shotOnFail(page, returnConfirmDisabled === false, 't6-return-confirm-enabled', 'T6：加载在途关弹层→打开打回弹层→迟到响应到达后，打回弹层确定键仍可用（未被残留 keepDisabled 卡死）');
            const candidateBoxLeaked = await page.locator('#siAcceptCandidateBox').count();
            must(candidateBoxLeaked === 0, 'T6：打回弹层 DOM 内不应残留验收弹层的候选区块元素（确认弹层内容已被替换，非仅确定键可点）');
            // 收尾：不提交，直接取消关闭，避免污染后续断言/残留副作用。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T7（C4c·codex 538 H2 回归①）：accept 请求本身在途时关闭验收弹层、改开打回弹层——迟到的 409
        //   到达后，打回弹层确定键应可用、不出现（属于验收弹层的）冲突横幅。区别于 T6（T6 卡的是
        //   loadLatest 的 GET）：本条卡的是 onConfirm 内**真正的 accept POST**，验证 onConfirm 自身
        //   在 await 之后的实例核对（modalInstanceAtStart 一带），不止是 myFlow 身份令牌那一层。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 先让"另一名在册开发"完成一次修正，确保稍后放行的 accept 请求命中真实的 409。
            const amendR7 = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T7：制造真实 409 用于迟到响应回归' }),
            });
            must(amendR7.status === 200, `T7 前置：制造冲突的 amend 应 200, got ${amendR7.status}`);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T7：验收说明（避开软确认二次点击）');

            let releaseAcceptReq;
            const acceptHeld = new Promise((resolve) => { releaseAcceptReq = resolve; });
            await page.route(`**/api/sys-issues/${id}/accept`, async (route) => { await acceptHeld; await route.continue(); });
            await page.click('#siMConfirm');   // 触发真实 accept 请求，被 route 拦住不放行
            await page.waitForTimeout(300);

            // accept 仍在途时关闭验收弹层，随即改开打回弹层——此刻迟到响应尚未放行。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(150);
            await page.click('#siDActions button:has-text("验收打回")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 现在才放行——迟到的 409 在打回弹层已经打开之后才到达。
            releaseAcceptReq();
            await page.waitForTimeout(600);
            await page.unroute(`**/api/sys-issues/${id}/accept`);

            const returnConfirmDisabledT7 = await page.locator('#siMConfirm').isDisabled().catch(() => true);
            await shotOnFail(page, returnConfirmDisabledT7 === false, 't7-return-confirm-enabled', 'T7：accept 在途关弹层→开打回弹层→迟到 409 到达后，打回弹层确定键可用');
            const conflictBannerLeakedT7 = await page.locator('#siAcceptConflictBanner').count();
            must(conflictBannerLeakedT7 === 0, 'T7：打回弹层 DOM 内不应出现验收弹层的冲突横幅（迟到 409 未污染新弹层）');
            const modalTitleT7 = await page.locator('#siMHead').textContent().catch(() => '');
            must((modalTitleT7 || '').includes('验收打回'), `T7：当前弹层标题仍为打回弹层（未被迟到响应意外关闭/替换），实得="${modalTitleT7}"`);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T8（C4c·codex 538 H2 回归②）：同上时序，但迟到的是**成功的 200**——打回弹层不应被这次迟到的
        //   accept 成功响应误关闭、也不应触发 siAfterAction() 列表/详情刷新（那是"上一个弹层提交成功"
        //   该做的事，不该发生在用户已经在操作的下一个弹层身上）。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerify(adminTok, devTok);   // 单人夹具——不外部制造冲突，accept 应真实 200
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T8：验收说明（避开软确认二次点击）');

            let releaseAcceptReq8;
            const acceptHeld8 = new Promise((resolve) => { releaseAcceptReq8 = resolve; });
            await page.route(`**/api/sys-issues/${id}/accept`, async (route) => { await acceptHeld8; await route.continue(); });
            await page.click('#siMConfirm');   // 触发真实 accept 请求（会成功），被 route 拦住不放行
            await page.waitForTimeout(300);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(150);
            await page.click('#siDActions button:has-text("验收打回")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const titleBeforeReleaseT8 = await page.locator('#siMHead').textContent().catch(() => '');

            releaseAcceptReq8();
            await page.waitForTimeout(800);   // 给迟到的 200 + 若误触发的 siAfterAction() 足够时间跑完
            await page.unroute(`**/api/sys-issues/${id}/accept`);

            const overlayStillOpenT8 = await page.locator('#siModalOverlay.open').count();
            must(overlayStillOpenT8 === 1, 'T8：迟到的 200 响应不应把打回弹层关闭（弹层仍处于 open 态）');
            const titleAfterReleaseT8 = await page.locator('#siMHead').textContent().catch(() => '');
            must(titleAfterReleaseT8 === titleBeforeReleaseT8 && (titleAfterReleaseT8 || '').includes('验收打回'), `T8：打回弹层标题未被替换/未被重开，前="${titleBeforeReleaseT8}"，后="${titleAfterReleaseT8}"`);
            // 库值应确已真正验收成功（迟到响应本身对后端而言是一次真实成功的写入，只是前端不该拿它
            // 去刷新/关闭"当前"这个不相关的弹层）。
            const finalStatusT8 = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [id]);
            must(finalStatusT8 && finalStatusT8.status === '待上线', `T8：迟到的 accept 200 在后端应已真实生效（库值落待上线），实得=${finalStatusT8 && finalStatusT8.status}`);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T9（C4c·codex 538 H1 回归①）：第一次加载成功、候选已渲染后，再次点「加载最新交付」——第二次
        //   请求仍在途时直调 siAcceptAdoptCandidate()（模拟"点采用"）应无效，确认键仍 disabled（状态机
        //   规则：一旦进入加载中，候选应已被同步清空，不存在"可采用的候选"）。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const amendR9 = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T9：制造首次冲突' }),
            });
            must(amendR9.status === 200, `T9 前置：制造冲突的 amend 应 200, got ${amendR9.status}`);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T9：验收说明（避开软确认二次点击）');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            await shotOnFail(page, await page.locator('#siAcceptConflictBanner').isVisible().catch(() => false), 't9-conflict-banner', 'T9 前置：冲突横幅可见');

            // 第一次加载——应成功，候选渲染出来。
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            const candidateVisibleT9 = await page.locator('#siAcceptCandidateBox').isVisible().catch(() => false);
            must(candidateVisibleT9, 'T9 前置：第一次加载成功，候选区块已渲染');

            // 第二次加载——用 route 拦住让它"在途"，此时直调 siAcceptAdoptCandidate() 应无效。
            let releaseSecondLoad;
            const secondLoadHeld = new Promise((resolve) => { releaseSecondLoad = resolve; });
            await page.route(`**/api/sys-issues/${id}`, async (route) => { await secondLoadHeld; await route.continue(); });
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(200);
            // 状态机规则：点击第二次加载的一刻应已同步清空候选——候选区应已隐藏、确认键应仍 disabled。
            const candidateHiddenDuringSecondLoad = await page.locator('#siAcceptCandidateBox').isVisible().catch(() => true);
            must(candidateHiddenDuringSecondLoad === false, 'T9：第二次加载在途时候选区块应已被同步隐藏（不等待响应）');
            const confirmDisabledDuringSecondLoad = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmDisabledDuringSecondLoad, 'T9：第二次加载在途时确认按钮仍 disabled');

            await page.evaluate(() => siAcceptAdoptCandidate());
            await page.waitForTimeout(200);
            const confirmStillDisabledAfterAdoptCallT9 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            await shotOnFail(page, confirmStillDisabledAfterAdoptCallT9, 't9-adopt-noop-during-load', 'T9：第二次加载在途时直调 siAcceptAdoptCandidate() 应无效，确认键仍 disabled');

            releaseSecondLoad();
            await page.waitForTimeout(600);
            await page.unroute(`**/api/sys-issues/${id}`);
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T10（C4c·codex 538 H1 回归② → C4d·codex 539 M3 改造）：**先成功加载一次**（断候选区/采用键
        //   可见）→ 再装 500 拦截 → 第二次加载失败——确认键仍 disabled、候选区隐藏、直调「采用」与
        //   siModalConfirm() 均无效（无新的上传/accept 请求）。相比原版直接从"从未成功加载过"的态测
        //   失败，本版额外覆盖"曾经有过一个合法候选，紧接着的下一次加载又失败"这条更容易漏检的路径
        //   （若失败分支不小心保留了上一次的候选/未清空 adoptBtn，这里才测得出来）。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const amendR10 = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T10：制造首次冲突' }),
            });
            must(amendR10.status === 200, `T10 前置：制造冲突的 amend 应 200, got ${amendR10.status}`);

            let acceptReqCountT10 = 0, uploadReqCountT10 = 0;
            const onReqT10 = req => {
                if (req.method() !== 'POST') return;
                const p = new URL(req.url()).pathname;
                if (p === `/api/sys-issues/${id}/accept`) acceptReqCountT10++;
                else if (p === `/api/sys-issues/${id}/attachments`) uploadReqCountT10++;
            };
            page.on('request', onReqT10);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T10：验收说明（避开软确认二次点击）');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);

            // 第一次加载——应成功，候选区块与「采用」按钮均应可见。
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            const candidateVisibleFirstLoadT10 = await page.locator('#siAcceptCandidateBox').isVisible().catch(() => false);
            must(candidateVisibleFirstLoadT10, 'T10 前置：第一次加载成功，候选区块可见');
            const adoptBtnVisibleFirstLoadT10 = await page.locator('#siAcceptAdoptBtn').isVisible().catch(() => false);
            must(adoptBtnVisibleFirstLoadT10, 'T10 前置：第一次加载成功，「采用此版本」按钮可见');

            // 第二次加载——拦成 500。
            await page.route(`**/api/sys-issues/${id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'T10 模拟服务端异常' }) }));
            await page.click('#siAcceptLoadLatestBtn');
            await page.waitForTimeout(700);
            await page.unroute(`**/api/sys-issues/${id}`);

            const confirmDisabledAfterFailT10 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            await shotOnFail(page, confirmDisabledAfterFailT10, 't10-confirm-disabled-after-load-fail', 'T10：曾成功加载一次后，第二次加载失败（500）——确认键仍 disabled（保持阻断，不恢复采用键）');
            const candidateVisibleAfterFailT10 = await page.locator('#siAcceptCandidateBox').isVisible().catch(() => true);
            must(candidateVisibleAfterFailT10 === false, 'T10：第二次加载失败后候选区块应隐藏（不留着上一次成功的候选）');
            const adoptBtnVisibleAfterFailT10 = await page.locator('#siAcceptAdoptBtn').isVisible().catch(() => true);
            must(adoptBtnVisibleAfterFailT10 === false, 'T10：第二次加载失败后「采用此版本」按钮应隐藏');

            // [C4e·codex 540 L1] 加载失败后先选一个待上传文件——若 candidateAdopted 判据出现漏洞，
            // 有待上传文件时最容易连带把"确认按钮不该可提交"这件事伪装成"提交了但反正没传附件所以
            // 看起来没事"；选中文件后再直调，才是"这条路径真的走不到上传/accept"的完整证据。
            const tmpPngT10 = path.join(os.tmpdir(), `pw-amend-evidence-t10-${id}.png`);
            fs.writeFileSync(tmpPngT10, Buffer.from('89504e470d0a1a0a', 'hex'));
            await page.setInputFiles('#siPickerInput_accept-evidence', tmpPngT10);
            // [C4f·Opus 复核 M1] 前置自证——picker 白名单/大小闸可能静默拒收非法文件，若被拒 siPickerFiles
            //   队列会仍是空的，下面"选了待上传文件的情况下确认键仍 disabled"这条断言会在"其实根本没选中
            //   任何文件"的假前提下也一样通过（伪造证据）。先证真的进了队列，后面的断言才有意义。
            const pickerQueueLenT10 = await page.evaluate(() => siPickerFiles('accept-evidence').length);
            must(pickerQueueLenT10 === 1, `T10 前置：待上传文件已进入 picker 队列，实得队列长度=${pickerQueueLenT10}`);

            const acceptCountBeforeNoOpT10 = acceptReqCountT10, uploadCountBeforeNoOpT10 = uploadReqCountT10;
            await page.evaluate(() => siAcceptAdoptCandidate());
            await page.waitForTimeout(200);
            must(acceptReqCountT10 === acceptCountBeforeNoOpT10, 'T10：加载失败后直调「采用」不应发起 accept 请求（候选已被清空，adopt() 应 no-op）');
            const confirmDisabledBeforeNoOpConfirmT10 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmDisabledBeforeNoOpConfirmT10, 'T10：直调「采用」之后（选了待上传文件的情况下）确认键仍 disabled');
            await page.evaluate(() => siModalConfirm());
            await page.waitForTimeout(300);
            must(acceptReqCountT10 === acceptCountBeforeNoOpT10, 'T10：加载失败后（已选待上传文件）直调 siModalConfirm() 不应发起新的 accept 请求');
            must(uploadReqCountT10 === uploadCountBeforeNoOpT10, 'T10：加载失败后（已选待上传文件）直调 siModalConfirm() 不应发起新的上传请求');
            const confirmDisabledAfterNoOpConfirmT10 = await page.locator('#siMConfirm').isDisabled().catch(() => false);
            must(confirmDisabledAfterNoOpConfirmT10, 'T10：直调 siModalConfirm() 之后确认键仍 disabled');

            page.off('request', onReqT10);
            try { fs.unlinkSync(tmpPngT10); } catch (_) { /* ignore */ }
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T11（C4d·codex 539 H1 回归）：siModalAmendSubmission 的 amend POST 在途（route 拦住）→
        //   取消修正弹层 → 打开打回弹层并填内容 → 放行迟到 409 → 断打回弹层仍 open、输入保留、无刷新。
        //   409 由直连改库（把 admin 自己在册行的 dev_status 改成 'pending'）精确构造，命中 amend 端点
        //   判定④（dev_status ∉ {code_submitted,no_code}）——这是唯一会真正触发 `siCloseModal()+
        //   siAfterAction()` 的分支（400 分支只弹 toast，不关不刷新，测不出本条要防的东西）。
        //   同一浏览器会话用 mkFixtureVerifyAdminDev——admin 本人既是唯一在册开发（能看到「修正我的
        //   提交」）又是 admin（能看到「验收打回」），不需要伪造跨用户切换就能在同一页面测这条真实路径。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyAdminDev(adminTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('#siDActions button:has-text("修正我的提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            // [C4f·Opus 复核 L4] 记下"修正"弹层自己的实例号——后面判定"迟到续体已 settle"时不能只看
            //   modalConfirmSettleCount 前进（并发场景下恰好有别的弹层续体同时 settle 也会推它前进，
            //   造成假绿），须同时核对 lastSettledInstance 就是这次被延迟的续体所属的那个实例。
            const amendModalInstanceT11 = await page.evaluate(() => siModalInstanceSeq);
            await page.fill('#siAmendWorkNote', 'T11：待拦截的修正内容');

            let releaseAmendReq, delayedAmendStatus = null;
            const amendHeld = new Promise((resolve) => { releaseAmendReq = resolve; });
            await page.route(`**/api/sys-issues/${id}/submit/amend`, async (route) => { await amendHeld; const resp = await route.fetch(); delayedAmendStatus = resp.status(); await route.fulfill({ response: resp }); });
            await page.click('#siMConfirm');   // 触发真实 amend 请求，被 route 拦住不放行
            await page.waitForTimeout(300);

            // amend 仍在途时，直接改库把 admin 自己这行的 dev_status 改成 'pending'——amend 端点的
            // 判定④（memberRow.dev_status ∉ {code_submitted,no_code}）先于四格契约执行，命中后精确
            // 409 INVALID_STATUS，不会被四格契约的 400 分支截胡（直连 API 二次调用会撞四格契约先触发
            // 400，测不到真正要测的 409 close+refresh 分支，见 codex 539 H1 交付报告）。直接改库属于
            // "构造后端已经这样响应"的前提条件，不代表业务上真能这样并发产生——本条要测的是前端收到
            // 409 之后的行为，不依赖后端如何产生这个 409。
            const daRowT11 = await dbGet(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, ADMIN_ID]);
            must(!!daRowT11, 'T11 前置：应能查到 admin 自己的在册行');
            await dbRun(`UPDATE sys_issue_dev_assignees SET dev_status='pending' WHERE id=?`, [daRowT11.id]);

            // 取消修正弹层——不等浏览器那次 amend 请求的结果。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(150);

            // 打开打回弹层并填入内容。
            await page.click('#siDActions button:has-text("验收打回")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const returnReasonText = 'T11：打回原因（应在迟到响应到达后原样保留）';
            await page.fill('#f_reason', returnReasonText);
            const titleBeforeT11 = await page.locator('#siMHead').textContent().catch(() => '');

            // [C4e·codex 540 M2] 固定 sleep 改完成信号——放行前先记两个计数器基线（本次修正弹层的
            // onConfirm settle 计数、siAfterAction 调用计数），放行后用 waitForFunction 精确等到
            // "这次迟到的 amend 续体确已跑完"，不再靠"等够 700ms 应该够了"这种猜测。
            const settleBeforeT11 = await page.evaluate(() => window.__siTestHooks.modalConfirmSettleCount);
            const afterActionCountBeforeT11 = await page.evaluate(() => window.__siTestHooks.afterActionCount);

            // 现在才放行——迟到的 amend 响应在打回弹层已经打开、已经填了内容之后才到达。
            releaseAmendReq();
            await page.waitForFunction((base) => window.__siTestHooks.modalConfirmSettleCount > base, settleBeforeT11, { timeout: 5000 });
            await page.unroute(`**/api/sys-issues/${id}/submit/amend`);
            // [C4f·Opus 复核 L4] 计数器前进只证明"有某个续体 settle 了"，须同时核对是"修正弹层那个实例"
            //   settle 的，才能排除"并发场景下恰好撞上别的续体也 settle、计数照样前进"的假绿。
            const lastSettledInstanceT11 = await page.evaluate(() => window.__siTestHooks.lastSettledInstance);
            must(lastSettledInstanceT11 === amendModalInstanceT11, `T11：settle 的应恰是"修正"弹层自己的续体（其实例号=${amendModalInstanceT11}），实得 lastSettledInstance=${lastSettledInstanceT11}`);
            must(delayedAmendStatus === 409, `T11：迟到的 amend 响应应恰为 409（dev_status 已被改为 pending，命中判定④），实得状态码=${delayedAmendStatus}`);
            const afterActionCountAfterT11 = await page.evaluate(() => window.__siTestHooks.afterActionCount);
            must(afterActionCountAfterT11 === afterActionCountBeforeT11, `T11：迟到的修正续体不应触发 siAfterAction()（无刷新），调用计数前=${afterActionCountBeforeT11}，后=${afterActionCountAfterT11}`);

            const overlayStillOpenT11 = await page.locator('#siModalOverlay.open').count();
            must(overlayStillOpenT11 === 1, 'T11：迟到的非预期响应不应把打回弹层关闭（弹层仍处于 open 态）');
            const titleAfterT11 = await page.locator('#siMHead').textContent().catch(() => '');
            must(titleAfterT11 === titleBeforeT11 && (titleAfterT11 || '').includes('验收打回'), `T11：打回弹层标题未被替换/未被重开，前="${titleBeforeT11}"，后="${titleAfterT11}"`);
            const reasonValAfterT11 = await page.locator('#f_reason').inputValue().catch(() => '');
            must(reasonValAfterT11 === returnReasonText, `T11：打回弹层输入内容应原样保留（未被迟到响应清空/覆盖），实得="${reasonValAfterT11}"`);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T12（C4d·codex 539 M1 回归）：不调 siCloseModal，直接调用 siModal(...) 替换验收弹层——迟到的
        //   loadLatest GET 到达后，新弹层的确定键应仍可用（siModal() 内部现在无条件重置 siAcceptFlow，
        //   不依赖显式 siCloseModal() 才失效旧 flow）。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyTwoDev(adminTok, devTok, secondDevTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const amendR12 = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
                method: 'POST', headers: jsonHeaders(secondDevTok),
                body: JSON.stringify({ mode: 'no_code', no_code_reason: 'T12：制造冲突以露出加载最新交付按钮' }),
            });
            must(amendR12.status === 200, `T12 前置：制造冲突的 amend 应 200, got ${amendR12.status}`);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T12：验收说明（避开软确认二次点击）');
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            await shotOnFail(page, await page.locator('#siAcceptConflictBanner').isVisible().catch(() => false), 't12-conflict-banner', 'T12 前置：冲突横幅可见');

            let releaseGetT12;
            const getHeldT12 = new Promise((resolve) => { releaseGetT12 = resolve; });
            await page.route(`**/api/sys-issues/${id}`, async (route) => { await getHeldT12; await route.continue(); });
            await page.click('#siAcceptLoadLatestBtn');   // 触发 GET，被拦住不放行
            await page.waitForTimeout(300);

            // 不调 siCloseModal——直接调用 siModal(...) 打开一个全新的、与 accept 完全无关的弹层，
            // 模拟"某处代码路径直接换弹层内容、没走标准关闭流程"这种边界情况。
            await page.evaluate(() => {
                siModal('T12：直接替换的弹层', [{ k: null, html: '<div>T12 探针内容</div>' }], async () => true, '确定');
            });
            await page.waitForTimeout(200);
            const titleAfterReplaceT12 = await page.locator('#siMHead').textContent().catch(() => '');
            must((titleAfterReplaceT12 || '').includes('T12：直接替换的弹层'), `T12 前置：新弹层已替换（未经 siCloseModal），实得标题="${titleAfterReplaceT12}"`);

            // [C4e·codex 540 M2] 固定 sleep 改完成信号——放行前记 loadLatest 的响应计数基线，放行后
            // waitForFunction 精确等到"这次被延迟的 GET 确已被 loadLatest 处理完"。
            // [C4f·Opus 复核 L1] 紧跟 waitForFunction 之后再 must 同一个条件（count 前进）是永远成立的
            //   重复断言——waitForFunction 已经保证了它，不为本条测试目标提供任何额外判别力。真正要测的
            //   是"迟到响应到达后，新弹层的态有没有被污染"，改为断新弹层仍 open + 确定键可用（后面两条
            //   本就是这条用例的核心断言，这里不再重复计数器判据，直接补一条"弹层仍 open"）。
            const loadRespBeforeT12 = await page.evaluate(() => window.__siTestHooks.loadLatestResponseCount);
            releaseGetT12();
            await page.waitForFunction((base) => window.__siTestHooks.loadLatestResponseCount > base, loadRespBeforeT12, { timeout: 5000 });
            await page.unroute(`**/api/sys-issues/${id}`);

            const overlayStillOpenT12 = await page.locator('#siModalOverlay.open').count();
            must(overlayStillOpenT12 === 1, 'T12：迟到的 GET 到达后，新弹层（未经 siCloseModal 直接替换）仍处于 open 态');
            const confirmDisabledT12 = await page.locator('#siMConfirm').isDisabled().catch(() => true);
            await shotOnFail(page, confirmDisabledT12 === false, 't12-new-modal-confirm-enabled', 'T12：迟到的 GET 到达后，新弹层（未经 siCloseModal 直接替换）确定键仍可用');
            const titleStillT12 = await page.locator('#siMHead').textContent().catch(() => '');
            must((titleStillT12 || '').includes('T12：直接替换的弹层'), `T12：新弹层未被迟到响应意外改写/关闭，实得标题="${titleStillT12}"`);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T13（C4e·codex 540 M1 回归）：旧弹层的 amend 请求延迟 reject（route.abort 延时，模拟网络异常）
        //   → 取消旧弹层、改开新弹层 → 放行延迟的 reject → 断新弹层上不出现「操作异常」toast、新弹层不
        //   被关闭。原实现的 catch 块无条件 showToast，不核实例——旧弹层的异常会在"当前"（此刻已是别的）
        //   弹层上弹出，属于同一类"迟到响应污染新弹层"问题，只是载体是 catch 分支而非 then 分支。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerifyAdminDev(adminTok);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // [C4f·Opus 复核 L3] 收集 console.error——route.abort('failed') 会让浏览器的 fetch 抛出
            //   "Failed to fetch"，这条应该只落在 console.error 里被 catch(e){console.error(e)} 记下，
            //   不该冒泡成用户可见的 toast（那条由下面 M2 的聚合 toast 断言钉住）。两条断言分别钉守卫
            //   的"该出现在哪"与"不该出现在哪"两端。
            const consoleErrorsT13 = [];
            page.on('console', (msg) => { if (msg.type() === 'error') consoleErrorsT13.push(msg.text()); });

            await page.click('#siDActions button:has-text("修正我的提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            // [C4f·Opus 复核 L4] 同 T11——记下"修正"弹层自己的实例号，供后面核 settle 的续体确实是这次
            //   被延迟的那一个（而非并发场景下别的续体恰好同时 settle 造成的假绿）。
            const amendModalInstanceT13 = await page.evaluate(() => siModalInstanceSeq);
            await page.fill('#siAmendWorkNote', 'T13：待 abort 的修正内容');

            let releaseAbortT13;
            const abortHeldT13 = new Promise((resolve) => { releaseAbortT13 = resolve; });
            await page.route(`**/api/sys-issues/${id}/submit/amend`, async (route) => { await abortHeldT13; await route.abort('failed'); });
            await page.evaluate(() => { document.querySelectorAll('#toast-container > *').forEach((el) => { el.dataset.pwSeen = '1'; }); });
            await page.click('#siMConfirm');   // 触发真实 amend 请求，被 route 拦住（稍后 abort）
            await page.waitForTimeout(300);

            // 取消旧的修正弹层，改开一个不相关的新弹层——不等旧请求的结果。
            await page.click('#siModalOverlay button:has-text("取消")');
            await page.waitForTimeout(150);
            await page.click('#siDActions button:has-text("验收打回")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const titleBeforeT13 = await page.locator('#siMHead').textContent().catch(() => '');

            const settleBeforeT13 = await page.evaluate(() => window.__siTestHooks.modalConfirmSettleCount);
            releaseAbortT13();
            await page.waitForFunction((base) => window.__siTestHooks.modalConfirmSettleCount > base, settleBeforeT13, { timeout: 5000 });
            await page.unroute(`**/api/sys-issues/${id}/submit/amend`);

            // [C4f·Opus 复核 L4] 计数器前进只证明"有某个续体 settle 了"，须核对 lastSettledInstance
            //   就是"修正"弹层自己的实例号，排除并发续体撞车的假绿。
            const lastSettledInstanceT13 = await page.evaluate(() => window.__siTestHooks.lastSettledInstance);
            must(lastSettledInstanceT13 === amendModalInstanceT13, `T13：settle 的应恰是"修正"弹层自己的续体（其实例号=${amendModalInstanceT13}），实得 lastSettledInstance=${lastSettledInstanceT13}`);

            // [C4f·Opus 复核 M2] 原写法只取"第一条未标记 toast"——若迟到续体连环触发多条 toast（如异常
            //   toast 之外还夹了别的成功/提示 toast），只看第一条会漏检排在后面的"操作异常"。改为聚合
            //   全部未标记 toast 的文本再整体断言不含"操作异常"。
            const newToastTextT13 = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('#toast-container > *'))
                    .filter((n) => !n.dataset.pwSeen)
                    .map((n) => n.textContent)
                    .join(' | ');
            }).catch(() => '');
            await shotOnFail(page, !(newToastTextT13 || '').includes('操作异常'), 't13-no-error-toast-on-new-modal', `T13：迟到 reject 不应在替换后的弹层上弹出"操作异常" toast，实得新增 toast（聚合）="${newToastTextT13}"`);
            const overlayStillOpenT13 = await page.locator('#siModalOverlay.open').count();
            must(overlayStillOpenT13 === 1, 'T13：迟到 reject 不应关闭替换后的弹层');
            const titleAfterT13 = await page.locator('#siMHead').textContent().catch(() => '');
            must(titleAfterT13 === titleBeforeT13 && (titleAfterT13 || '').includes('验收打回'), `T13：替换后的弹层标题未被改写，前="${titleBeforeT13}"，后="${titleAfterT13}"`);
            // [C4f·Opus 复核 L3] "Failed to fetch" 应已被 catch(e){console.error(e)} 钉在诊断日志里——
            //   若这条断言反而红了，说明该异常没有被正常的 catch 路径捕获（走了别的、未预期的路径）。
            must(consoleErrorsT13.some((t) => (t || '').includes('Failed to fetch')), `T13：console.error 中应至少一条含 "Failed to fetch"（route.abort('failed') 触发的真实网络异常），实得 console 错误=${JSON.stringify(consoleErrorsT13)}`);

            await page.click('#siModalOverlay button:has-text("取消")');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T14（codex 542·M1）：详情响应缺 delivery_rev（route 拦截把 GET /sys-issues/:id 响应体里的
        //   issue.delivery_rev 删掉，模拟异常/旧响应缺该字段）→ 打开验收弹层点「确定」→ fail-closed
        //   拦截，不发起 accept 请求 + toast「详情版本信息缺失，请刷新详情后重试」，弹层不关闭。
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerify(adminTok, devTok);
            const page = await loginPage(browser, adminTok);
            await page.route(`**/api/sys-issues/${id}`, async (route) => {
                const resp = await route.fetch();
                const json = await resp.json().catch(() => null);
                if (json && json.issue) delete json.issue.delivery_rev;
                await route.fulfill({ response: resp, json: json || {} });
            });
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            let acceptReqCountT14 = 0;
            const onReqT14 = (req) => { if (req.method() === 'POST' && /\/accept$/.test(new URL(req.url()).pathname)) acceptReqCountT14++; };
            page.on('request', onReqT14);

            await page.click('#siDActions button:has-text("验收通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_note', 'T14：验收说明（应被 fail-closed 拦截）');
            await page.evaluate(() => { document.querySelectorAll('#toast-container > *').forEach(el => { el.dataset.pwSeen = '1'; }); });
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);

            must(acceptReqCountT14 === 0, `T14 详情缺 delivery_rev 时点确定不应发起 accept 请求，实得请求数=${acceptReqCountT14}`);
            const toastTextT14 = await page.evaluate(() => {
                const el = Array.from(document.querySelectorAll('#toast-container > *')).find(n => !n.dataset.pwSeen);
                return el ? el.textContent : '';
            }).catch(() => '');
            await shotOnFail(page, (toastTextT14 || '').includes('详情版本信息缺失，请刷新详情后重试'), 't14-baseline-missing-toast', `T14 应提示"详情版本信息缺失，请刷新详情后重试"，实得="${toastTextT14}"`);
            const overlayStillOpenT14 = await page.locator('#siModalOverlay.open').count();
            must(overlayStillOpenT14 === 1, 'T14 拦截后弹层不应关闭（留给用户刷新详情后重试）');

            page.off('request', onReqT14);
            await page.unroute(`**/api/sys-issues/${id}`);
            await page.close();
        }

    } finally {
        await browser.close();
        for (const id of createdIds) {
            try { await deleteIssueFully(id); } catch (e) { console.warn(`⚠️ 清理 issue #${id} 失败：${e.message}`); }
        }
        const leftover = await dbAll(`SELECT id FROM sys_issues WHERE description LIKE ?`, [`%${RUN_TAG_MARKER}%`]);
        must(leftover.length === 0, `收尾清理：本轮标记（${RUN_TAG}）零残留，实得残留 id=${JSON.stringify(leftover.map(r => r.id))}`);
        db.close();
        // 收尾清理断言（可能改变 fail 计数）必须先跑完，报告汇总才是最终真实结果——原实现把这行
        // console.log 放在 try 块末尾、清理之前，会把清理阶段的失败漏进汇总数字。
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (failDetails.length) console.log('失败明细：\n  - ' + failDetails.join('\n  - '));
        if (fail > 0) process.exitCode = 1;
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
