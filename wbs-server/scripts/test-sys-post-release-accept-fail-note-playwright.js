/**
 * 系统迭代·F-3「补验收弹窗 fail 说明必填」前端 Playwright 冒烟
 * （用户拍板 P8·后端已改 400 POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-post-release-accept-fail-note-playwright.js
 *
 * 夹具：真实链路造出「先行上线待补验收」态（不用 SQL 造态）——受理→指派→估时→授权(fast-release-authorize)
 *   →submit(direct_release=true) 落地 online_source_kind='authorized_fastlane' ∧ post_release_acceptance=
 *   'pending'，与 scripts/verify-sys-post-release-accept.js 的 bugAtFastlanePending() 同源同序（该脚本已
 *   验证此序列在当前后端下能稳定落地目标态，本文件直接复用同一套 API 调用，不重新摸索）。
 *
 * 覆盖：
 *   T1 初始态：verdict 默认 pass，说明栏 label 无必填星号（选填）
 *   T2 切换 fail：verdict 切到 fail → label 动态改写为必填星号（体验层标注随选择联动）
 *   T3 前端拦截零副作用：fail + 说明留空 → 点确定被前端拦截（toast 提示，未发起网络请求）→ 弹窗仍打开、
 *       库内 post_release_acceptance 仍为 pending
 *   T4 补填说明提交成功：fail + 填写说明 → 提交成功，库内 post_release_acceptance='failed_derived' +
 *       post_derive_issue_id 落库
 *   T5 ★对照组：另造一张独立夹具单，pass + 说明留空 → 提交成功（证明必填只挂在 fail 分支，不是恒必填）
 *   T1c/T4b/T5b【追加批·2026-08-13·列表页「补验收未通过」徽章，用户实测拍板】成对断言：pending 阶段
 *       列表仍显示既有「先行上线待补验收」且「补验收未通过」尚未出现（T1c，回归对照）；fail 提交成功后
 *       列表该单出现「补验收未通过」徽章 + title 含"已派生 #N"，pending 徽章随之消失（T4b）；★对照组
 *       pass 态列表既不出现「补验收未通过」也不残留「先行上线待补验收」（T5b，闭环干净不制造噪音）。
 *   （各 T 段末尾均各自断言"全程无非预期 console error"，非独立编号项）
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人
const DEV_ID = 8;        // 示例开发A（本地真实 active 非 viewer 账号，同 test-sys-eta-generation-playwright.js 既有复用账号）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `pra-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
// [追加批·2026-08-13·列表页「补验收未通过」徽章] 列表行定位——renderSysIterationRows 给每行 <tr>
//   挂 onclick="siOpenDrawer(<id>)"（Sys_Iteration.html :1956），唯一可靠的行选择器锚点（无独立
//   data-id 属性）。返回该行内 .si-flag 徽章集合的 Locator，供后续按文案 filter。
function siFlagsInRow(page, issueId) {
    return page.locator(`tr[onclick="siOpenDrawer(${issueId})"] .si-flag`);
}

let seq = 0;
async function mkFastlanePendingBug(adminTok, devTok) {
    seq++;
    const r = await fetch(`${BASE_URL}/api/sys-issues`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
        body: JSON.stringify({
            intake_contract_version: 2, type: 'bug', title: `PRA-探针-${seq}`, system_name: 'BMS', source: '内部',
            description: `补验收 fail 说明必填前端探针夹具-${seq}`, intake_liaison_id: LIAISON_ID,
        }),
    });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(body)}`);
    const id = body.id;

    let resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: '{}' });
    if (resp.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: JSON.stringify({ assigned_to: DEV_ID }) });
    if (resp.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);

    const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${devTok}` }, body: JSON.stringify({ dev_estimated_at: futureEst }) });
    if (resp.status !== 200) throw new Error(`[夹具-估时] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);

    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/fast-release-authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` }, body: JSON.stringify({ note: 'PRA 探针-授权' }) });
    if (resp.status !== 200) throw new Error(`[夹具-授权] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);

    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${devTok}` },
        body: JSON.stringify({
            mode: 'commits', self_tested: true, test_env_deployed: true,
            bug_cause_note: 'PRA 探针：bug 产生原因',
            commits: [{ component: 'backend', commit_ref: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
            direct_release: true,
        }),
    });
    const submitBody = await resp.json();
    if (resp.status !== 200) throw new Error(`[夹具-直上] 应 200，实得 ${resp.status} ${JSON.stringify(submitBody)}`);
    if (submitBody.online_source !== 'authorized_fastlane') throw new Error(`[夹具-直上] online_source 应为 authorized_fastlane，实得 ${submitBody.online_source}`);

    const row = await dbGet('SELECT online_source, post_release_acceptance FROM sys_issues WHERE id=?', [id]);
    if (row.online_source !== 'authorized_fastlane' || row.post_release_acceptance !== 'pending') {
        throw new Error(`[夹具-前置] 期望 online_source=authorized_fastlane∧post_release_acceptance=pending，实得 ${JSON.stringify(row)}`);
    }
    return id;
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    console.log('\n══════ 系统迭代·F-3 补验收弹窗 fail 说明必填 前端 Playwright 冒烟 ══════');

    const createdIds = [];
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1-T4：单条真实链路——一张 fastlane pending 单，先验前端拦截再验补填成功
        // ═══════════════════════════════════════════════════════════════
        const id = await mkFastlanePendingBug(adminTok, devTok);
        createdIds.push(id);

        const page = await loginPage(browser, adminTok);   // post-release-accept 要求 admin，同建单人身份打开
        await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);

        await page.click('#siDActions button:has-text("补验收")');
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);

        // ── T1：初始态——verdict 默认 pass，说明栏无必填星号 ──────────────────────────
        console.log('\n── T1：补验收弹窗初始打开——verdict=pass，说明栏无必填星号 ──');
        const verdictVal = await page.locator('#f_verdict').inputValue();
        await shotOnFail(page, verdictVal === 'pass', 't1-verdict-default-pass', `verdict 默认选中 pass（实得="${verdictVal}"）`);
        const noteLabelHtml1 = await page.locator('#f_note').locator('xpath=preceding-sibling::label[1]').innerHTML();
        await shotOnFail(page, !/u-req/.test(noteLabelHtml1), 't1-note-not-required', `说明栏 label 初始无必填星号（实得="${noteLabelHtml1}"）`);
        // ── T1c【追加批·2026-08-13·列表徽章·回归对照】列表页 pending 态既有徽章不受影响——本次改动
        //   只在 siPostAcceptFlagHtml 的 pending 判断之前插了一个平行分支（failed_derived），未触碰
        //   pending 分支本身；夹具单刚创建，未过 48h，应仍是非超时文案「先行上线待补验收」。
        const pendingFlagText1 = await siFlagsInRow(page, id).filter({ hasText: '先行上线待补验收' }).first().textContent().catch(() => '');
        await shotOnFail(page, pendingFlagText1 === '先行上线待补验收', 't1c-pending-flag-unaffected', `追加批·pending 单列表徽章仍是"先行上线待补验收"（非超48h，未被新分支误伤），实得="${pendingFlagText1}"`);
        const failFlagBeforeCount1 = await siFlagsInRow(page, id).filter({ hasText: '补验收未通过' }).count();
        await shotOnFail(page, failFlagBeforeCount1 === 0, 't1c-fail-flag-not-yet-shown', `追加批：pending 阶段不应出现「补验收未通过」徽章（实得 ${failFlagBeforeCount1} 个）`);

        // ── T2：切换 fail——label 动态改写为必填星号 ──────────────────────────────
        console.log('\n── T2：verdict 切到 fail → 说明栏 label 动态改写为必填星号 ──');
        await page.selectOption('#f_verdict', 'fail');
        await page.waitForTimeout(100);
        const noteLabelHtml2 = await page.locator('#f_note').locator('xpath=preceding-sibling::label[1]').innerHTML();
        await shotOnFail(page, /u-req/.test(noteLabelHtml2), 't2-note-required', `切到 fail 后 label 含必填星号（实得="${noteLabelHtml2}"）`);

        // ── T3：前端拦截零副作用（fail + 说明留空）──────────────────────────────
        console.log('\n── T3：fail + 说明留空 → 点确定被前端拦截，零副作用 ──');
        const requestsBeforeT3 = [];
        const onReq = (req) => { if (req.url().includes('/post-release-accept')) requestsBeforeT3.push(req.url()); };
        page.on('request', onReq);
        await page.click('#siMConfirm');
        await page.waitForTimeout(400);
        page.off('request', onReq);
        const toastT3 = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, /补验收不通过必须填写说明/.test(toastT3), 't3-frontend-reject-toast', `fail+留空点确定 → toast 含前端拦截文案（实得："${toastT3}"）`);
        await shotOnFail(page, requestsBeforeT3.length === 0, 't3-no-network-call', `前端拦截应在发起网络请求之前——未观测到 /post-release-accept 请求（实得 ${requestsBeforeT3.length} 次）`);
        const modalStillOpenT3 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalStillOpenT3 === 1, 't3-modal-stays-open', '被前端拦截后弹窗仍打开');
        const rowT3 = await dbGet('SELECT post_release_acceptance FROM sys_issues WHERE id=?', [id]);
        await shotOnFail(page, rowT3.post_release_acceptance === 'pending', 't3-zero-side-effect', `零副作用：库内 post_release_acceptance 仍 pending（实得=${rowT3.post_release_acceptance}）`);

        // ── T4：补填说明提交成功 ───────────────────────────────────────────────
        console.log('\n── T4：补填说明后提交成功，库内落 failed_derived + 派生单 id ──');
        await page.fill('#f_note', 'Playwright T4 前端探针：补验收不通过原因说明');
        await page.click('#siMConfirm');
        await page.waitForTimeout(600);
        const modalClosedT4 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalClosedT4 === 0, 't4-submit-success', '补填说明后提交成功，弹窗关闭');
        const rowT4 = await dbGet('SELECT post_release_acceptance, post_derive_issue_id FROM sys_issues WHERE id=?', [id]);
        await shotOnFail(page, rowT4.post_release_acceptance === 'failed_derived', 't4-status-updated', `库内 post_release_acceptance=failed_derived（实得=${rowT4.post_release_acceptance}）`);
        await shotOnFail(page, !!rowT4.post_derive_issue_id, 't4-derived-id', `派生单 id 已落库（实得=${rowT4.post_derive_issue_id}）`);
        if (rowT4.post_derive_issue_id) createdIds.push(rowT4.post_derive_issue_id);

        // ── T4b【追加批·2026-08-13·修复：列表页「补验收未通过」徽章】提交成功后 siAfterAction 已
        //   重跑 siLoadList（同 siRenderDrawer 一并刷新），列表该单应出现新徽章，title 含派生单号。
        console.log('\n── T4b：追加批·fail 后列表该单应出现「补验收未通过·已派生#N」徽章（单号在正文非仅 title）──');
        const failFlagLoc = siFlagsInRow(page, id).filter({ hasText: '补验收未通过' });
        await shotOnFail(page, (await failFlagLoc.count()) === 1, 't4b-fail-flag-shown', '追加批：fail 提交成功后列表该单应出现「补验收未通过」徽章');
        // [用户实测二次拍板·2026-08-13] 派生单号必须在徽章**正文**可见（"未通过之后在哪跟进"藏在
        //   title 里发现率≈0）——断言正文含"·已派生#N"；title 改为跟进指引句式，单号同样断言。
        const failFlagText = await failFlagLoc.textContent().catch(() => '');
        const derivedTextRe = new RegExp(`·已派生#${rowT4.post_derive_issue_id}\\b`);
        await shotOnFail(page, derivedTextRe.test(failFlagText || ''), 't4b-fail-flag-text-derived', `追加批：徽章正文应含"·已派生#${rowT4.post_derive_issue_id}"，实得="${failFlagText}"`);
        const failFlagTitle = await failFlagLoc.getAttribute('title').catch(() => '');
        const derivedIdRe = new RegExp(`派生单 #${rowT4.post_derive_issue_id}\\b`);
        await shotOnFail(page, derivedIdRe.test(failFlagTitle || ''), 't4b-fail-flag-title', `追加批：徽章 title 应含"派生单 #${rowT4.post_derive_issue_id}"跟进指引，实得="${failFlagTitle}"`);
        // 原 pending 徽章应随状态转出而消失（三态互斥，不会同时出现两个补验收徽章）。
        const pendingFlagAfterCount = await siFlagsInRow(page, id).filter({ hasText: '先行上线待补验收' }).count();
        await shotOnFail(page, pendingFlagAfterCount === 0, 't4b-pending-flag-gone', `追加批：转出 pending 后「先行上线待补验收」徽章应消失（实得 ${pendingFlagAfterCount} 个）`);

        const t1t4UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
        await shotOnFail(page, t1t4UnexpectedErrors.length === 0, 't1t4-console-clean', `T1-T4 全程无非预期 JS 报错（实得 ${t1t4UnexpectedErrors.length} 个 / 原始 ${page._consoleErrors.length} 个）${t1t4UnexpectedErrors.length ? '：' + JSON.stringify(t1t4UnexpectedErrors) : ''}`);
        await page.close();

        // ═══════════════════════════════════════════════════════════════
        // T5：★对照组——独立夹具单，pass + 说明留空 → 提交成功（必填只挂 fail，非恒必填）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5：★对照组·pass + 说明留空 → 提交成功（证明必填不是恒必填） ──');
        const id5 = await mkFastlanePendingBug(adminTok, devTok);
        createdIds.push(id5);
        const page5 = await loginPage(browser, adminTok);
        await page5.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5}`);
        await page5.waitForLoadState('networkidle');
        await page5.waitForTimeout(600);

        await page5.click('#siDActions button:has-text("补验收")');
        await page5.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5.waitForTimeout(200);
        // verdict 保持默认 pass，note 留空，直接确定
        await page5.click('#siMConfirm');
        await page5.waitForTimeout(600);
        const modalClosedT5 = await page5.locator('#siModalOverlay.open').count();
        await shotOnFail(page5, modalClosedT5 === 0, 't5-pass-blank-note-success', 'pass + 说明留空 → 提交成功，弹窗关闭（对照：必填只挂 fail 分支）');
        const rowT5 = await dbGet('SELECT post_release_acceptance FROM sys_issues WHERE id=?', [id5]);
        await shotOnFail(page5, rowT5.post_release_acceptance === 'passed', 't5-status-updated', `库内 post_release_acceptance=passed（实得=${rowT5.post_release_acceptance}）`);
        // ── T5b【追加批·2026-08-13·修复：列表页「补验收未通过」徽章·对照组】pass 态明确不加徽章
        //   （干净闭环不制造噪音，用户拍板例外驱动口径）——与 T4b 成对，证明徽章只在 failed_derived 出现。
        const passFailFlagCount = await siFlagsInRow(page5, id5).filter({ hasText: '补验收未通过' }).count();
        await shotOnFail(page5, passFailFlagCount === 0, 't5b-pass-no-fail-flag', `追加批·对照组：pass 态列表不应出现「补验收未通过」徽章（实得 ${passFailFlagCount} 个）`);
        const passPendingFlagCount = await siFlagsInRow(page5, id5).filter({ hasText: '先行上线待补验收' }).count();
        await shotOnFail(page5, passPendingFlagCount === 0, 't5b-pass-no-pending-flag', `追加批·对照组：pass 态列表不应仍显示「先行上线待补验收」（实得 ${passPendingFlagCount} 个）`);

        const t5UnexpectedErrors = page5._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
        await shotOnFail(page5, t5UnexpectedErrors.length === 0, 't5-console-clean', `T5 全程无非预期 JS 报错（实得 ${t5UnexpectedErrors.length} 个 / 原始 ${page5._consoleErrors.length} 个）`);
        await page5.close();

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
    } finally {
        await browser.close();
        // 夹具清理（issue 删除会级联相关子表，同既有 verify-sys-*/test-sys-* 惯例；派生单同批清理）
        const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
        for (const id of createdIds) {
            try {
                await dbRun('DELETE FROM sys_issue_timeline WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issue_dev_events WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issue_dev_assignees WHERE issue_id=?', [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        const remain = await dbGet(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${createdIds.map(() => '?').join(',') || 'NULL'})`, createdIds);
        console.log(`  🧹 夹具已清理（残留 ${remain ? remain.c : 0} 条，应为 0）`);
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) process.exit(1);
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
