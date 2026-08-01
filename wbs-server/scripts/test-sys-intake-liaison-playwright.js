/**
 * 建单优化批 C1/C2 前端 Playwright 冒烟——对接人下拉 + title 派生 + intake 通知按钮三态
 * （方案 v1.2 §3.6/§4.8/§6b.1，对齐 test-sys-release-c7-playwright.js 套件范式）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-intake-liaison-playwright.js
 *
 * 覆盖：
 *   T1 建单弹窗结构+校验：无 #f_title 输入框 / 描述必填拦截（留空点确定→toast「描述必填」+弹窗不关）/
 *       对接人下拉默认选中「示例对接人」（本地唯一 active 受理人=13）
 *   T2 无 title 建单成功：description 首行经 esc/trim 后 = 落库 title（列表 + 详情 + DB 三处核对，非猜测）
 *   T3 详情页「对接人」行显示"示例对接人"
 *   T4 通知按钮三态（**安全改写，见下方说明**）
 *   T5 全程 0 console error
 *
 * ⚠️⚠️ 钉钉安全边界（本脚本执行前实测发现，与任务书原文假设不同，务必先读）：
 *   任务书原文假设"本地无钉钉配置发送会 failed"，让本脚本真点「发送通知」按钮验证。
 *   **实测核验：本地 task_pool.db 的 system_configs 表 dingtalk_app_key/app_secret/robot_code 三项均已
 *   SET（非空）**——sendIssueDingtalkRaw() 不会走 no_config 快速失败分支，而是会真实发起
 *   dingtalkNotify.getAccessToken() 外呼。这与本仓库其余 Playwright 脚本已反复实测确认的结论完全一致：
 *     - test-sys-release-panel-c2b2-playwright.js:13 "（均 SET），点击会真实外呼——本脚本只断言该按钮的
 *       可见性/文案，绝不点击"
 *     - test-periodic-fetch-playwright.js:14 "本地 db 副本含生产系统真实凭证，避免任何真实外部副作用"
 *     - test-sys-release-c7-playwright.js:15-20 明确列出"走 sendIssueDingtalkRaw 直连会真实外呼"的按钮
 *       一律不点击
 *   notify-intake 端点同样直连 sendIssueDingtalkRaw（S1 后端实现，见 index.js notify-intake 路由），与
 *   上述被规避的通道属同一风险类别。**本脚本据此不点击真实「发送通知」/「重发」按钮**，改用与
 *   c2b2 脚本 :217/:271 完全同源的「直接 SQL 模拟通知态」手法验证三态渲染逻辑（not_sent 初始态用真实
 *   建单产出的自然状态；failed 态用 SQL UPDATE 模拟，不经真实外呼）——这是本仓库对"零真实外呼"纪律的
 *   既定、可验证、可复用解法，非本脚本新发明，也不是回避测试深度（UI 渲染逻辑与真实点击后的渲染逻辑
 *   完全一致，siRenderIntakeNotifyRow 只读 iss.intake_notify_status 三态字段，不关心状态如何产生）。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
// codex 220 L-4：原硬编码指向某次会话的临时目录，会话结束即失效——失败截图会静默写失败（目录不存在）
// 且无从查阅。改用系统临时目录下固定子目录，每次运行前 mkdirSync recursive 确保存在。
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人，本地唯一 active 受理人（SYS_INTAKE_LIAISON_IDS=[13]）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
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
        const p = path.join(SCREENSHOT_DIR, `intake-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });   // codex 220 L-4：目录可能不存在，截图前确保存在
            await page.screenshot({ path: p });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图本身失败不影响主流程 */ }
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

async function main() {
    // 前置：确认本地唯一 active 受理人事实（否则「默认选中」断言的前提就不成立，不能盲测）。
    const activeLiaisons = await dbAll(`SELECT id, display_name, status FROM users WHERE id=? AND status='active'`, [LIAISON_ID]);
    if (activeLiaisons.length !== 1) throw new Error(`前置条件不满足：预期本地恰有 1 个 active 受理人(id=${LIAISON_ID})，实得 ${JSON.stringify(activeLiaisons)}`);
    console.log(`  前置确认：唯一 active 受理人 = ${activeLiaisons[0].display_name}(${LIAISON_ID})`);

    const adminTok = await signAs(ADMIN_ID);
    console.log('\n══════ 建单优化批 C1/C2 前端 Playwright 冒烟 ══════');

    const RUN_TAG = Date.now();
    const descFirstLine = `Playwright冒烟首行标题-${RUN_TAG}`;
    const descFull = `${descFirstLine}\n第二行不应影响标题（仅首行截取）`;
    let createdIssueId = null;
    let oaExemptIssueId = null;   // T1.5（建单优化批 C3b）独立夹具，finally 里与 createdIssueId 一并清理

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：建单弹窗结构 + 校验（无标题输入框 / 描述必填拦截 / 对接人默认选中）
        //   + T2：无 title 建单成功（description 首行 = 落库 title）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1：建单弹窗结构 + 描述必填拦截 + 对接人默认选中 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            await shotOnFail(page, (await page.locator('#f_title').count()) === 0, 't1-no-title-field', '建单弹窗无 #f_title 输入框（标题输入框已撤）');
            const descField = page.locator('#f_description');
            await shotOnFail(page, (await descField.count()) === 1, 't1-description-field-exists', '建单弹窗存在 #f_description 描述 textarea');
            const descLabel = await page.locator('label:has-text("描述")').first().textContent();
            await shotOnFail(page, descLabel.includes('*'), 't1-description-required-star', `描述字段 label 含必填星号（实得："${descLabel.trim()}"）`);
            const descPlaceholder = await descField.getAttribute('placeholder');
            await shotOnFail(page, descPlaceholder && descPlaceholder.includes('标题将自动取首行'), 't1-description-placeholder', `描述 placeholder 提示标题自动取首行（实得："${descPlaceholder}"）`);

            const liaisonSel = page.locator('#f_intake_liaison_id');
            await shotOnFail(page, (await liaisonSel.count()) === 1, 't1-liaison-field-exists', '建单弹窗存在 #f_intake_liaison_id 对接人下拉');
            const liaisonVal = await liaisonSel.inputValue();
            await shotOnFail(page, liaisonVal === String(LIAISON_ID), 't1-liaison-default-selected', `对接人下拉默认选中 id=${LIAISON_ID}（实得 value="${liaisonVal}"）`);
            const liaisonText = await page.locator('#f_intake_liaison_id option:checked').textContent();
            await shotOnFail(page, liaisonText.includes('示例对接人'), 't1-liaison-default-name', `对接人下拉默认选项显示"示例对接人"（实得："${liaisonText}"）`);

            // codex 217 MED：补候选数与下拉 option 数量一致断言——"唯一候选默认选中"这条断言依赖本地固定数据，
            //   之前只靠脚本头部前置 dbAll 核对 users 表，没直接核对建单弹窗实际调用的 GET intake-liaisons
            //   接口返回值与渲染出的 option 数量是否一致（两者理论同源但没断言过，此处补上）。
            const liaisonResp = await fetch(`${BASE_URL}/api/sys-issues/intake-liaisons`, { headers: { Authorization: `Bearer ${adminTok}` } });
            const liaisonRespData = await liaisonResp.json().catch(() => null);
            const liaisonCandidates = (liaisonResp.ok && liaisonRespData && Array.isArray(liaisonRespData.items)) ? liaisonRespData.items : null;
            await shotOnFail(page, Array.isArray(liaisonCandidates) && liaisonCandidates.length === 1, 't1-liaison-candidates-count-one', `GET intake-liaisons 恰返回 1 个候选（"默认选中"断言的前提显式化，实得：${JSON.stringify(liaisonCandidates)}）`);
            const liaisonOptionCount = await liaisonSel.locator('option').count();
            await shotOnFail(page, Array.isArray(liaisonCandidates) && liaisonOptionCount === liaisonCandidates.length, 't1-liaison-option-count-matches', `对接人下拉 option 数量（${liaisonOptionCount}）= 接口候选数（${liaisonCandidates ? liaisonCandidates.length : 'N/A'}）（唯一候选时不加空白占位项，见 siIntakeLiaisonFieldHtml）`);

            // 描述必填拦截：留空点确定 → toast「描述必填」+ 弹窗不关闭（siModal onConfirm 返回 false）。
            await page.click('#siMConfirm');
            await page.waitForTimeout(300);
            const toastText1 = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, toastText1.includes('描述必填'), 't1-description-required-toast', `留空描述点确定 → toast 含「描述必填」（实得："${toastText1}"）`);
            const modalStillOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalStillOpen === 1, 't1-modal-stays-open', '描述必填拦截后弹窗仍处于打开态（未静默关闭/未误提交）');

            console.log('\n── T2：无 title 建单成功，description 首行 = 落库 title ──');
            await descField.fill(descFull);
            // 对接人已默认选中、所属系统已有 META 默认值，无需额外操作，直接提交。
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);

            const modalClosedAfterSubmit = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedAfterSubmit === 0, 't2-modal-closed-after-success', '合法提交后弹窗已关闭（建单成功）');

            const row = await dbGet(`SELECT id, title, description, intake_liaison_id, status FROM sys_issues WHERE description LIKE ?`, [`${descFirstLine}%`]);
            await shotOnFail(page, !!row, 't2-db-row-created', `DB 中已建出对应单据（按描述首行匹配），实得：${JSON.stringify(row)}`);
            if (row) {
                createdIssueId = row.id;
                await shotOnFail(page, row.title === descFirstLine, 't2-db-title-derived', `落库 title = 描述首行（未截断，未超40字符），预期="${descFirstLine}"，实得="${row.title}"`);
                await shotOnFail(page, row.intake_liaison_id === LIAISON_ID, 't2-db-intake-liaison-id', `落库 intake_liaison_id=${LIAISON_ID}（实得=${row.intake_liaison_id}）`);
                await shotOnFail(page, row.status === '待受理', 't2-db-status', `落库 status=待受理（实得=${row.status}）`);
            }

            // 详情页（siOpenDrawer 建单成功后自动打开）header 标题核对。
            const drawerTitle = await page.locator('#siDTitle').textContent().catch(() => '');
            await shotOnFail(page, createdIssueId && drawerTitle.includes(`#${createdIssueId}`) && drawerTitle.includes(descFirstLine), 't2-detail-title', `详情页 header 显示 "#${createdIssueId} ${descFirstLine}"（实得："${drawerTitle}"）`);

            // 列表视图标题核对：关闭详情抽屉回到列表，搜索/滚动定位到该行。
            const listRowText = await page.locator(`tr:has-text("${descFirstLine}")`).count();
            await shotOnFail(page, listRowText > 0, 't2-list-title', `列表视图存在含派生标题的行（"${descFirstLine}"）`);

            console.log('\n── T3：详情页「对接人」行显示"示例对接人" ──');
            const intakeKvText = await page.locator('.u-kv-item:has-text("对接人")').first().textContent();
            await shotOnFail(page, intakeKvText.includes('示例对接人'), 't3-intake-liaison-name', `详情页「对接人」行显示"示例对接人"（实得："${intakeKvText.trim()}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't1t2t3-console-clean', `T1-T3 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T1.5（建单优化批 C3b·方案 20260801_v1.3 §6c）：「本单无需 OA 号」勾选框存在 + 默认联动
        //   （需求方留空↔勾选）+ 手动改后提交落库核对。独立开一个页面/夹具，不复用 T1-T3 的
        //   createdIssueId（避免与既有 35 断言的流程状态耦合，改动面收窄到新增内容本身）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1.5：oa_exempt 勾选框存在 + 默认联动（需求方留空↔勾选）+ 手动改后提交落库核对 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            const oaChk = page.locator('#f_oa_exempt');
            await shotOnFail(page, (await oaChk.count()) === 1, 't1.5-checkbox-exists', '建单弹窗存在 #f_oa_exempt 勾选框（本单无需 OA 号）');
            await shotOnFail(page, await oaChk.isChecked(), 't1.5-default-checked-when-empty', '需求方三字段皆空时，勾选框默认勾选（弹窗打开时的初始联动态）');

            // 联动①：填需求方姓名 → 自动取消勾选
            await page.fill('#f_requester_name', '业务方老王');
            await page.waitForTimeout(150);
            await shotOnFail(page, !(await oaChk.isChecked()), 't1.5-uncheck-on-requester-filled', '填入需求方姓名后，勾选框自动取消勾选（联动生效）');

            // 联动②：清空需求方姓名 → 自动恢复勾选（未手动碰过勾选框，联动持续生效）
            await page.fill('#f_requester_name', '');
            await page.waitForTimeout(150);
            await shotOnFail(page, await oaChk.isChecked(), 't1.5-recheck-on-requester-cleared', '清空需求方姓名后，勾选框自动恢复勾选（联动持续生效，未被手动碰过）');

            // 手动改：用户显式点击勾选框（切到未勾选）——此后联动应停止覆盖（"联动只设初始/未触碰态"）
            await oaChk.uncheck();
            await page.waitForTimeout(100);
            await shotOnFail(page, !(await oaChk.isChecked()), 't1.5-manual-uncheck', '用户手动取消勾选后，勾选框呈未勾选态');
            await page.fill('#f_requester_name', '');   // 需求方字段回到"皆空"（若联动未停止会被强制勾回）
            await page.waitForTimeout(150);
            await shotOnFail(page, !(await oaChk.isChecked()), 't1.5-manual-touch-stops-linkage', '手动碰过勾选框后，需求方字段变化不再覆盖用户的手动选择（联动只设初始/未触碰态，非持续同步）');

            // 手动改后提交：勾选框保持手动设的"未勾选"，提交后核对落库 oa_exempt=0（与前端手动态一致，
            //   非被联动悄悄改回的 1）。
            const oaExemptTag = `Playwright-oa豁免冒烟-${RUN_TAG}`;
            await page.fill('#f_description', oaExemptTag);
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const oaRow = await dbGet(`SELECT id, oa_exempt, requester_name FROM sys_issues WHERE description LIKE ?`, [`${oaExemptTag}%`]);
            await shotOnFail(page, !!oaRow, 't1.5-db-row-created', `DB 中已建出勾选框测试单据，实得：${JSON.stringify(oaRow)}`);
            if (oaRow) {
                oaExemptIssueId = oaRow.id;
                await shotOnFail(page, oaRow.oa_exempt === 0, 't1.5-db-oa-exempt-matches-manual', `落库 oa_exempt=0（手动取消勾选后提交，与前端手动态一致，非被联动覆盖回 1，实得=${oaRow.oa_exempt}）`);
            }

            await shotOnFail(page, page._consoleErrors.length === 0, 't1.5-console-clean', `T1.5 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4：通知按钮三态（安全改写：not_sent 用真实建单产出的自然态；failed 态用 SQL 模拟，
        //   不点击真实「发送通知」按钮——见文件头部安全边界说明）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T4：intake 通知按钮三态（not_sent 真实态 → SQL 模拟 failed 态，不点真实发送） ──');
            if (!createdIssueId) throw new Error('T4 前置失败：createdIssueId 未取得（T2 建单断言已失败，跳过 T4 会产生误导性绿灯）');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            // not_sent 初始态：按钮文案「发送通知」，状态文字「未发送钉钉通知」。
            const notifyRowInit = page.locator('.u-notify-row:has-text("对接人受理")');
            await shotOnFail(page, (await notifyRowInit.count()) > 0, 't4-row-visible-pending', '「待受理」态下对接人受理通知行可见');
            const initBtnText = await notifyRowInit.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, initBtnText.includes('发送通知'), 't4-init-btn-label', `初始态按钮文案「发送通知」（实得："${initBtnText}"）`);
            const initStatusText = await notifyRowInit.textContent();
            await shotOnFail(page, initStatusText.includes('未发送'), 't4-init-status-text', `初始态状态文字含「未发送」（实得摘要："${initStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            // 安全改写：SQL 直接模拟 failed 态（不经真实 sendIssueDingtalkRaw 外呼，见文件头说明）。
            await dbRun(`UPDATE sys_issues SET intake_notify_status='failed', intake_notify_error='no_config' WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);   // 重新整页加载，读全新 DB 状态
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowFailed = page.locator('.u-notify-row:has-text("对接人受理")');
            const failedStatusText = await notifyRowFailed.textContent();
            await shotOnFail(page, failedStatusText.includes('失败'), 't4-failed-status-text', `SQL 模拟 failed 后状态文字含「失败」（实得摘要："${failedStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);
            const retryBtnText = await notifyRowFailed.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, retryBtnText.includes('重发'), 't4-retry-btn-label', `failed 态按钮文案「重发」（实得："${retryBtnText}"）`);
            const retryBtnEnabled = await notifyRowFailed.locator('button').first().isEnabled().catch(() => false);
            await shotOnFail(page, retryBtnEnabled, 't4-retry-btn-enabled', '「重发」按钮可点（非 disabled，验证"重发可点"，但本脚本不实际点击——点击会真实外呼钉钉）');

            // codex 217 HIGH 收口：sent 态零断言补齐——本 commit 最关键语义（sent 是本轮终态，不可重发；
            //   仅回受理门归零才恢复可发）此前完全没有回归锁。SQL 直接模拟 sent（不经真实外呼，同上方 failed
            //   态手法）：status='sent' + message_key 非空 + read_at NULL（未读态）。
            await dbRun(`UPDATE sys_issues SET intake_notify_status='sent', intake_notify_message_key='intake-c2-test-mk', intake_notify_error=NULL, intake_read_at=NULL WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowSentUnread = page.locator('.u-notify-row:has-text("对接人受理")');
            const sentUnreadBtnCount = await notifyRowSentUnread.locator('button').count();
            await shotOnFail(page, sentUnreadBtnCount === 1, 't4-sent-unread-btn-count', `sent+未读态通知行仅 1 个按钮——无「发送通知/重发」（sent 即本轮终态，不可重发，实得按钮数=${sentUnreadBtnCount}）`);
            const sentUnreadBtnText = await notifyRowSentUnread.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, sentUnreadBtnText.includes('查询已读'), 't4-sent-unread-btn-is-queryread', `sent+未读态唯一按钮为「查询已读」（实得："${sentUnreadBtnText}"）`);
            const sentUnreadStatusText = await notifyRowSentUnread.textContent();
            await shotOnFail(page, sentUnreadStatusText.includes('已通知'), 't4-sent-unread-status-text', `sent+未读态状态文字含「已通知」（实得摘要："${sentUnreadStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            // codex 复审(20260801_111901) L1：上方「按钮总数=1 且唯一按钮为查询已读」是对"无发送/重发"的间接证明——
            //   未来该行若新增其他按钮或 DOM 顺序调整，失败信息不够直接。此处显式锁死：行数=1 前置 + 两类操作按钮各自计数=0。
            const sentUnreadRowCount = await notifyRowSentUnread.count();
            await shotOnFail(page, sentUnreadRowCount === 1, 't4-sent-unread-row-count-one', `sent+未读态「对接人受理」通知行恰 1 行（按钮计数断言的前提显式化，实得=${sentUnreadRowCount}）`);
            const sentUnreadSendCount = await notifyRowSentUnread.locator('button:has-text("发送通知")').count();
            await shotOnFail(page, sentUnreadSendCount === 0, 't4-sent-unread-no-send-btn', `sent+未读态显式无「发送通知」按钮（实得=${sentUnreadSendCount}）`);
            const sentUnreadRetryCount = await notifyRowSentUnread.locator('button:has-text("重发")').count();
            await shotOnFail(page, sentUnreadRetryCount === 0, 't4-sent-unread-no-retry-btn', `sent+未读态显式无「重发」按钮（实得=${sentUnreadRetryCount}）`);

            // 再置 read_at 非空 → 已读态。⚠️ 实现语义核实（写断言前先读 Sys_Iteration.html 源码确认，非按 codex
            //   修法原文直接照抄）：siRenderIntakeNotifyRow 的「查询已读」按钮条件含 `!iss.intake_read_at`——
            //   已读后按钮不渲染（非仅置灰/disabled）；同时 siNotifyStatusText 的 sent+readAt 分支切换文案为
            //   「📖 已读 · 于 <时刻>」（intake 通道不传 notifiedAt，故不含"通知于"前半段）。即：已读态 = 按钮从
            //   有(查询已读)变为无 + 状态文字从「已通知」变为「已读」，两者同时发生，断言两头都锁。
            await dbRun(`UPDATE sys_issues SET intake_read_at=datetime('now','localtime') WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowSentRead = page.locator('.u-notify-row:has-text("对接人受理")');
            const sentReadBtnCount = await notifyRowSentRead.locator('button').count();
            await shotOnFail(page, sentReadBtnCount === 0, 't4-sent-read-btn-count-zero', `sent+已读态通知行无任何按钮（发送/重发/查询已读全隐藏，实得按钮数=${sentReadBtnCount}）`);
            const sentReadStatusText = await notifyRowSentRead.textContent();
            await shotOnFail(page, sentReadStatusText.includes('已读'), 't4-sent-read-status-text', `sent+已读态状态文字含「已读」（实得摘要："${sentReadStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't4-console-clean', `T4 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }
    } finally {
        // 🧹 清理测试夹具（不依赖存量数据，自建自清）
        if (createdIssueId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [createdIssueId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [createdIssueId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [createdIssueId]);
            console.log(`\n  🧹 测试夹具已清理（issue #${createdIssueId}）`);
        }
        if (oaExemptIssueId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [oaExemptIssueId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [oaExemptIssueId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [oaExemptIssueId]);
            console.log(`  🧹 T1.5 测试夹具已清理（issue #${oaExemptIssueId}）`);
        }
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 建单优化批 C1/C2 前端 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 建单优化批 C1/C2 前端 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
