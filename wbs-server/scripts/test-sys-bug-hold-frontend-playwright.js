/**
 * bug 暂缓方案（20260803 v0.4）S4 前端 Playwright 冒烟——对齐 test-sys-intake-liaison-playwright.js /
 * test-sys-release-c7-playwright.js 套件范式（直接 SQL 造夹具 + JWT 注入 + login.html 中继跳转 + 真实
 * 本地 server:3000 + 真实 task_pool.db，全程不点击会真实外呼钉钉的按钮）。
 *
 * 用法：本地 server（3000）已重启到最新 S4 前端代码后：node scripts/test-sys-bug-hold-frontend-playwright.js
 *
 * 覆盖（对应 S4 任务书验证要求 1-4）：
 *   T1 siIsDevAction 运行时硬断言——缺 type / 非法 type → false + console.error（不静默落回变更流分支）
 *   T2 全动作可见性回归矩阵（siRenderActions 是全页按钮渲染公共路径，抽样覆盖 type×role×status）：
 *     - bug/处理中：admin 见暂缓／在册开发见暂缓／非在册不见暂缓
 *     - bug/待验证：admin 与在册开发均不见暂缓（state-gating：hold.from=['处理中'] 唯一）
 *     - feature/开发中：admin 见暂缓／本单在册开发（非 admin）不见暂缓（变更流 hold 仍纯 admin，无 roster 例外）
 *   T3 bug 流暂缓→通知→恢复→再暂缓 全链路真实 UI 点击（siModalResume 取代破损的 siConfirmSimple 分发·
 *     codex 238 risk-1 回归锁）+「已暂缓 N 天」角标生命周期（渲染/消失/重新计数）
 *   T4 变更流（feature）暂缓→恢复 真实 UI 点击（证明 siConfirmSimple 修复对两条流同时生效，非只修了 bug 一侧）
 *   T5 作废后角标不显示（已暂缓 → 作废，列表角标应消失，不残留陈旧天数）
 *   T6 两个新 409 码的前端友好提示——均在真正外呼钉钉之前被拒绝，点击安全：
 *     - RESUME_ANCHOR_NOT_FOUND：从未暂缓过的「处理中」bug 单点「重启通知开发」
 *     - NOTIFY_CLAIM_CONFLICT：SQL 预置 creator_notify_message_key 造成"被占坑"态，点「暂缓通知建单人」发送
 *   全程 console error 清零断言
 *
 * ⚠️⚠️ 钉钉安全边界（同源自 test-sys-intake-liaison-playwright.js 头部说明，本脚本逐字遵守）：本地
 * task_pool.db 的 system_configs 表钉钉三项凭证均已 SET，任何会走到 sendIssueDingtalkRaw() 的按钮点击都会
 * 真实外呼。本脚本两类通知按钮点击（T6）均利用后端"锚点/claim 检查先于外呼"的实现顺序，在到达
 * sendIssueDingtalkRaw 之前就被 409 拒绝——不产生真实外呼副作用，这是复用既定安全手法，非新发明。
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
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;       // 管理员
const ROSTER_DEV_ID = 3;  // 示例用户A——用作 bug 单在册开发（非 admin）
// ⚠️ "非在册" 测试对象不能随手挑一个普通用户：GET /sys-issues/:id 详情可见性门槛=admin∨受理人∨
//   bug对接人∨assigned_to∨在册成员∨上线执行人∨技术负责人，普通无关用户会先被 403 拦在详情页外，
//   "看不到暂缓按钮"就失去意义（页面根本没渲染出来，不是 siRenderActions 过滤的结果）。改用受理人
//   示例对接人（id=13，SYS_INTAKE_LIAISON_IDS 唯一值）——她因受理人身份能看详情，但不在 bugProcessing
//   的 dev_assignees 里、也非 admin，是"能看见页面、但不该看见暂缓按钮"的真实反例主体。
const AUTHORIZED_NONROSTER_ID = 13;   // 示例对接人——受理人（可查看详情）但非本单在册、非 admin
const VARIANT_DEV_ID = 8; // 示例开发A——用作变更流单在册开发（非 admin），证明变更流 hold 对其仍不可见
// M-1 回归对象（codex 239 审，主会话核实成立）：这两类人正是 siCaps.isRosterMember/后端 isRosterMember 会
// "多显示"暂缓按钮、但 can_bug_hold（同 assertBugHoldActor 判据）会正确排除的对象——旧实现的 bug 由他们暴露。
const EXCUSED_DEV_ID = 10;   // 示例开发C——已被开脱（dev_status='excused'，removed_at 仍 NULL）
const REMOVED_DEV_ID = 12;   // 示例开发D——已被移除（removed_at 非空，历史参与者，读可见性仍保留）

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
// 实测核实（debug 支线 + git stash 对照确认，见交付说明）：page 对非 admin/非受理人角色打开详情页时，会
// 无条件请求 GET /api/sys-issues/intake-liaisons（受理人下拉候选查询），该端点仅 admin/受理人可读，非此
// 两类角色恒 403——**改动前就存在**的既有行为（stash 掉本次 S4 全部改动后复现同一 403，与 hold/resume
// 无关，非本方案引入），越权修它是任务书明确禁止的"改无关生产代码"。故豁免只在断言层做，且做得精确：
// 只豁免"实际观测到的、且全部确认来自 intake-liaisons 的 403"所对应的那几条通用 console 文案，条数封顶
// 等于观测到的已知 403 响应数——任何一个非 intake-liaisons 的 403、或超出该配额的错误，一律不豁免、如实
// 报告（不是无差别吞掉所有"Failed to load resource...403"文案，避免掩盖本方案自己引入的真实回归）。
function consoleErrorsExcludingKnown(page) {
    const errs = page._consoleErrors || [];
    const forbidden = page._403Urls || [];
    const allKnown = forbidden.length > 0 && forbidden.every(u => u.includes('/intake-liaisons'));
    if (!allKnown) return errs;
    let budget = forbidden.length;
    return errs.filter(e => {
        if (budget > 0 && /Failed to load resource.*403/.test(e)) { budget--; return false; }
        return true;
    });
}
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `bughold-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: p });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图本身失败不影响主流程 */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    const forbiddenUrls = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('response', r => { if (r.status() === 403) forbiddenUrls.push(r.url()); });
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    page._403Urls = forbiddenUrls;
    return page;
}

const RUN_TAG = Date.now();
// 本脚本全部创建的 sys_issues.id，finally 里统一清理（含子表级联）。
const createdIssueIds = [];

async function mkIssue({ type, status, title, createdBy = ADMIN_ID, createdByName = '管理员', assignedTo = null, assignedToName = null }) {
    const r = await dbRun(
        // intake_required 必须为 1（角色权限重构 C0 焊死受理门：全类型必经受理，0 为非法态，CHECK 约束拒 0）——
        // 本脚本夹具全部直落已过受理门的活跃态（处理中/开发中/待验证等），语义上"已经受理过"，故写 1。
        `INSERT INTO sys_issues (type, status, priority, title, description, system_name, source,
            created_by, created_by_name, assigned_to, assigned_to_name, intake_required)
         VALUES (?, ?, 'P2', ?, ?, 'BMS', '内部', ?, ?, ?, ?, 1)`,
        [type, status, title, `${title}｜Playwright冒烟-${RUN_TAG}`, createdBy, createdByName, assignedTo, assignedToName]
    );
    const id = r.lastID;
    createdIssueIds.push(id);
    return id;
}
async function mkDevAssignee(issueId, userId, userName, { isPrimary = 0, devStatus = 'pending' } = {}) {
    await dbRun(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, ?, ?)`,
        [issueId, userId, userName, isPrimary, devStatus]
    );
}
async function mkTimelineRow(issueId, { toStatus, actionCode, operatorId = ADMIN_ID, operatorName = '管理员', summary = '', createdAt = null }) {
    await dbRun(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, to_status, summary, action_code, operator_id, operator_name${createdAt ? ', created_at' : ''})
         VALUES (?, 'status_change', ?, ?, ?, ?, ?${createdAt ? ', ?' : ''})`,
        createdAt ? [issueId, toStatus, summary, actionCode, operatorId, operatorName, createdAt] : [issueId, toStatus, summary, actionCode, operatorId, operatorName]
    );
}
async function issueRow(id) { return dbGet('SELECT * FROM sys_issues WHERE id=?', [id]); }

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    const rosterDevTok = await signAs(ROSTER_DEV_ID);
    const authorizedNonRosterTok = await signAs(AUTHORIZED_NONROSTER_ID);
    const variantDevTok = await signAs(VARIANT_DEV_ID);
    console.log('\n══════ bug暂缓方案 S4 前端 Playwright 冒烟 ══════');

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：siIsDevAction 运行时硬断言——缺 type / 非法 type → false + console.error
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1：siIsDevAction 运行时硬断言（fail-closed，非静默落回变更流分支） ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);

            const r1 = await page.evaluate(() => {
                const errs = [];
                const orig = console.error;
                console.error = (...a) => { errs.push(a.join(' ')); orig.apply(console, a); };
                const ret = window.siIsDevAction ? siIsDevAction('hold') : siIsDevAction('hold');   // 缺 type
                console.error = orig;
                return { ret, errCount: errs.length, errText: errs.join('|') };
            });
            await shotOnFail(page, r1.ret === false, 't1-missing-type-returns-false', `缺 type 调用 siIsDevAction('hold') 返回 false（实得=${r1.ret}）`);
            await shotOnFail(page, r1.errCount >= 1 && r1.errText.includes('siIsDevAction'), 't1-missing-type-console-error', `缺 type 触发 console.error（实得条数=${r1.errCount}，内容="${r1.errText}"）`);

            const r2 = await page.evaluate(() => siIsDevAction('hold', 'not_a_real_type'));
            await shotOnFail(page, r2 === false, 't1-illegal-type-returns-false', `非法 type 调用返回 false（实得=${r2}）`);

            const r3 = await page.evaluate(() => siIsDevAction('hold', 'bug'));
            await shotOnFail(page, r3 === true, 't1-bug-hold-is-dev-action', `type='bug' 时 hold 是开发动作（实得=${r3}）`);

            const r4 = await page.evaluate(() => siIsDevAction('hold', 'feature'));
            await shotOnFail(page, r4 === false, 't1-feature-hold-not-dev-action', `type='feature' 时 hold 不是开发动作（应落 admin 分支，实得=${r4}）`);

            const r5 = await page.evaluate(() => siIsDevAction('estimate', 'bug'));
            await shotOnFail(page, r5 === true, 't1-estimate-still-dev-action', `其余动作（estimate）两流同源不受影响（实得=${r5}）`);

            await shotOnFail(page, page._consoleErrors.filter(e => !e.includes('[siIsDevAction]')).length === 0, 't1-no-unexpected-console-error', `T1 除本测试主动触发的 siIsDevAction 断言外无其他 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T2：全动作可见性回归矩阵（抽样覆盖 type×role×status，重点抓 hold 授权模型的两流分岔）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T2：动作可见性回归矩阵 ──');
        // ⚠️ REQUIRES_ASSIGNEE_STATUSES（transitions.js §[4] RC-M5，pre-existing 不变量，非本方案引入）：
        //   处理中/开发中/待验证/待上线/已上线/已关闭 均要求主表 assigned_to 非空，与去主次后的 roster
        //   子表授权是两套并行机制——本脚本夹具落在这些态时必须同时把 assigned_to 也填上，否则后续任何
        //   会重新校验该不变量的转移（如 resume 落回处理中）会被 409 NO_ASSIGNEE_FOR_DEV_STATE 拒绝
        //   （实测踩坑：T3/T4 最初未填，resume 全部 409，见 debug 脚本核实）。
        const bugProcessing = await mkIssue({ type: 'bug', status: '处理中', title: `T2-bug处理中-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugProcessing, ROSTER_DEV_ID, '示例用户A');

        const bugVerify = await mkIssue({ type: 'bug', status: '待验证', title: `T2-bug待验证-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugVerify, ROSTER_DEV_ID, '示例用户A');

        const featureDev = await mkIssue({ type: 'feature', status: '开发中', title: `T2-feature开发中-${RUN_TAG}`, assignedTo: VARIANT_DEV_ID, assignedToName: '示例开发A' });
        await mkDevAssignee(featureDev, VARIANT_DEV_ID, '示例开发A');

        // L-2（codex 239 审，主会话核实成立）：单纯"找不到 #siDActions button:has-text(label)"这种负向断言，
        //   页面没加载出来 / 选择器写错也会绿——无法区分"环境正常但目标真不存在"和"环境坏了所以什么都没有"。
        //   改为先抓取操作区**全部**按钮文案，显式断言该数组非空（证明操作区确实渲染了内容），再断言数组
        //   不包含目标 label——正向断言场景该前提天然满足（找到了目标本身就证明非空），负向场景才是这条
        //   前置断言真正发挥作用的地方。
        async function actionButtonTexts(page, issueId) {
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            return page.locator('#siDActions button').allTextContents();
        }
        // 部分角色在特定夹具上合法地"一个按钮都没有"（例如仅有历史参与权、无任何操作权的已移除成员，
        // 会命中 siRenderActions 的 `<span class="si-muted">当前状态/身份下无可执行动作</span>` 兜底文案，
        // 而非任何 <button>）——这类场景不能用"按钮数组非空"当前置断言（会对着真实合法的空态误判为
        // "环境坏了"）。改用 #siDActions 的整体渲染文本是否非空作为前置断言：兜底文案本身就是"环境正常，
        // 只是这个身份在这张单上确实无事可做"的证据，与"页面加载失败/选择器写错导致整块空白"能区分开。
        async function actionAreaText(page, issueId) {
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            return (await page.locator('#siDActions').textContent().catch(() => '')).trim();
        }

        {
            const page = await loginPage(browser, adminTok);
            const t1 = await actionButtonTexts(page, bugProcessing);
            await shotOnFail(page, t1.length > 0, 't2-bug-processing-admin-actions-rendered', `bug/处理中：admin 视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, v1, 't2-bug-processing-admin-sees-hold', `bug/处理中：admin 可见「暂缓」按钮（实得=${v1}）`);
            const t2 = await actionButtonTexts(page, bugVerify);
            await shotOnFail(page, t2.length > 0, 't2-bug-verify-admin-actions-rendered', `bug/待验证：admin 视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t2)}）`);
            const v2 = t2.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v2, 't2-bug-verify-admin-no-hold', `bug/待验证：admin **不**可见「暂缓」按钮（state-gating，hold.from 只含处理中，实得=${v2}）`);
            const t3 = await actionButtonTexts(page, featureDev);
            await shotOnFail(page, t3.length > 0, 't2-feature-dev-admin-actions-rendered', `feature/开发中：admin 视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t3)}）`);
            const v3 = t3.some(t => t.includes('暂缓'));
            await shotOnFail(page, v3, 't2-feature-dev-admin-sees-hold', `feature/开发中：admin 可见「暂缓」按钮（变更流 hold 仍纯 admin，实得=${v3}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2-admin-console-clean', `T2 admin 视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }
        {
            const page = await loginPage(browser, rosterDevTok);
            const t1 = await actionButtonTexts(page, bugProcessing);
            await shotOnFail(page, t1.length > 0, 't2-bug-processing-rosterdev-actions-rendered', `bug/处理中：在册开发视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, v1, 't2-bug-processing-rosterdev-sees-hold', `bug/处理中：在册开发（非 admin）可见「暂缓」按钮（口径 #6 任一活跃在册∨admin，实得=${v1}）`);
            const t2 = await actionButtonTexts(page, bugVerify);
            await shotOnFail(page, t2.length > 0, 't2-bug-verify-rosterdev-actions-rendered', `bug/待验证：在册开发视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t2)}）`);
            const v2 = t2.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v2, 't2-bug-verify-rosterdev-no-hold', `bug/待验证：在册开发**不**可见「暂缓」按钮（state-gating，实得=${v2}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2-rosterdev-console-clean', `T2 在册开发视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }
        {
            const page = await loginPage(browser, authorizedNonRosterTok);
            const t1 = await actionButtonTexts(page, bugProcessing);
            await shotOnFail(page, t1.length > 0, 't2-bug-processing-nonroster-actions-rendered', `bug/处理中：受理人视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v1, 't2-bug-processing-nonroster-no-hold', `bug/处理中：受理人（可查看详情但非本单在册、非 admin）**不**可见「暂缓」按钮（实得=${v1}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2-nonroster-console-clean', `T2 非在册（受理人）视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }
        {
            const page = await loginPage(browser, variantDevTok);
            const t1 = await actionButtonTexts(page, featureDev);
            await shotOnFail(page, t1.length > 0, 't2-feature-dev-assignee-actions-rendered', `feature/开发中：本单在册开发视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v1, 't2-feature-dev-assignee-no-hold', `feature/开发中：本单在册开发（非 admin）**不**可见「暂缓」按钮（变更流 hold 无 roster 例外，与 bug 侧刻意不同，实得=${v1}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2-variantdev-console-clean', `T2 变更流开发视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T2b（M-1 回归钉，codex 239 审）：已 excuse 的成员 / 已移除的历史成员——这是旧实现（用
        // siCaps.isRosterMember 顶替授权判定）会"多显示"暂缓按钮的两种人（该字段既不判 removed_at IS NULL
        // 也不判 dev_status != 'excused'，是拿读可见性冒充写授权）。改用后端下发的 iss.can_bug_hold
        // （与 assertBugHoldActor 同一谓词 canBugHold）后，这两类人应看不到「暂缓」按钮。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T2b：M-1 回归钉——已 excuse / 已移除的历史成员不应看到暂缓按钮 ──');
        const bugWithExcusedRemoved = await mkIssue({ type: 'bug', status: '处理中', title: `T2b-bug已excuse已移除-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugWithExcusedRemoved, ROSTER_DEV_ID, '示例用户A');   // 活跃在册（对照组，应仍可见）
        await mkDevAssignee(bugWithExcusedRemoved, EXCUSED_DEV_ID, '示例开发C', { devStatus: 'excused' });
        await mkDevAssignee(bugWithExcusedRemoved, REMOVED_DEV_ID, '示例开发D');
        await dbRun(`UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime') WHERE issue_id = ? AND user_id = ?`, [bugWithExcusedRemoved, REMOVED_DEV_ID]);
        {
            const excusedTok = await signAs(EXCUSED_DEV_ID);
            const page = await loginPage(browser, excusedTok);
            const t1 = await actionButtonTexts(page, bugWithExcusedRemoved);
            await shotOnFail(page, t1.length > 0, 't2b-excused-actions-rendered', `已 excuse 成员视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v1, 't2b-excused-no-hold', `已 excuse 的成员（dev_status='excused'，removed_at 仍 NULL）**不**可见「暂缓」按钮（M-1 回归钉，实得=${v1}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2b-excused-console-clean', `T2b 已 excuse 成员视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }
        {
            const removedTok = await signAs(REMOVED_DEV_ID);
            const page = await loginPage(browser, removedTok);
            // 已移除成员仍保留"历史参与者"读可见性（isRosterMember 读判定不含 removed_at 过滤），故仍能打开详情页——
            // 这正是本回归钉要验证的场景本身：能看到页面，但不该看到暂缓按钮。
            // ⚠️ 实测核实：该成员在本夹具上除"曾经在册"外无任何其他角色（非 admin/非受理人/非建单人），
            // 暂缓一撤，操作区**合法地一个按钮都没有**，命中 siRenderActions 的"当前状态/身份下无可执行
            // 动作"兜底文案——故前置断言不能用"按钮数组非空"（那对这个身份天然为空，会把真实合法的空态误判
            // 成"环境坏了"），改用 actionAreaText 断言操作区渲染文本非空（兜底文案本身即证据）。
            const areaText = await actionAreaText(page, bugWithExcusedRemoved);
            await shotOnFail(page, areaText.length > 0, 't2b-removed-area-rendered', `已移除历史成员视角操作区确实渲染出内容（前置断言，非"环境坏了导致整块空白"，实得文本："${areaText}"）`);
            const t1 = await page.locator('#siDActions button').allTextContents();
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, !v1, 't2b-removed-no-hold', `已移除的历史成员（removed_at 非空）**不**可见「暂缓」按钮（M-1 回归钉，实得=${v1}，按钮数组=${JSON.stringify(t1)}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2b-removed-console-clean', `T2b 已移除历史成员视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }
        {
            // 对照组：同单活跃在册成员（示例用户A）仍应看到暂缓按钮——证明本回归钉不是"整单权限坏了"，
            // 而是精确排除了 excused/removed 这两类人。
            const page = await loginPage(browser, rosterDevTok);
            const t1 = await actionButtonTexts(page, bugWithExcusedRemoved);
            await shotOnFail(page, t1.length > 0, 't2b-active-actions-rendered', `活跃在册成员（对照组）视角操作区确实渲染出按钮（前置断言，实得按钮文案：${JSON.stringify(t1)}）`);
            const v1 = t1.some(t => t.includes('暂缓'));
            await shotOnFail(page, v1, 't2b-active-still-sees-hold', `同单活跃在册成员（对照组，示例用户A）仍可见「暂缓」按钮（证明本回归钉是精确排除非整单坏权限，实得=${v1}）`);
            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't2b-active-console-clean', `T2b 对照组视角全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3：bug 流 暂缓→通知行可见→恢复（真实 UI 点击）→再暂缓，验证：
        //   ① siModalResume 取代 siConfirmSimple（恢复原因必填拦截生效，不再走恒传空 body 的旧函数）
        //   ② 「已暂缓 N 天」角标：渲染 → 恢复后消失 → 再暂缓后重新计数（非累加）
        //   ③ 两个新通知行的可见性
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3：bug 流 暂缓→恢复→再暂缓 全链路真实 UI 点击 + N 天角标生命周期 ──');
        const bugCycle = await mkIssue({ type: 'bug', status: '处理中', title: `T3-bug暂缓恢复循环-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugCycle, ROSTER_DEV_ID, '示例用户A');
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 第一轮暂缓
            await page.click('#siDActions button:has-text("暂缓")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `第一轮暂缓原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterHold1 = await issueRow(bugCycle);
            await shotOnFail(page, afterHold1.status === '已暂缓', 't3-hold1-status', `第一轮暂缓后 DB status=已暂缓（实得=${afterHold1.status}）`);

            // 暂缓通知建单人行可见（admin 视角）
            const holdNotifyRow = page.locator('.u-notify-row:has-text("暂缓通知建单人")');
            await shotOnFail(page, (await holdNotifyRow.count()) > 0, 't3-hold-notify-row-visible', '「已暂缓」态下「暂缓通知建单人」通知行可见');
            const holdNotifyBtnText = await holdNotifyRow.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, holdNotifyBtnText.includes('发送通知'), 't3-hold-notify-btn-label', `「暂缓通知建单人」行按钮文案含「发送通知」（实得："${holdNotifyBtnText}"）`);

            // 列表角标：已暂缓 0 天（当天暂缓）
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const badgeRow1 = page.locator(`tr:has-text("T3-bug暂缓恢复循环-${RUN_TAG}")`);
            const badgeText1 = await badgeRow1.textContent();
            await shotOnFail(page, /已暂缓\s*0\s*天/.test(badgeText1), 't3-badge-shows-after-hold', `暂缓后列表行显示「已暂缓 0 天」角标（实得摘要含："${badgeText1.replace(/\s+/g, ' ').slice(0, 120)}"）`);

            // 第一轮恢复（siModalResume：先测原因必填拦截，再正常提交）
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("恢复")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.click('#siMConfirm');   // 留空原因直接点确定
            await page.waitForTimeout(300);
            const stillOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, stillOpen === 1, 't3-resume-reason-required-blocks', `恢复原因留空点确定 → 弹窗仍打开（siModalResume 必填拦截生效，非 siConfirmSimple 恒空 body 提交，实得开启数=${stillOpen}）`);
            const toastEmpty = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, toastEmpty.includes('必填'), 't3-resume-reason-required-toast', `留空恢复原因 → toast 提示必填（实得："${toastEmpty}"）`);

            await page.fill('#f_reason', `第一轮恢复原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterResume1 = await issueRow(bugCycle);
            await shotOnFail(page, afterResume1.status === '处理中', 't3-resume1-status', `恢复后 DB status 回到处理中（实得=${afterResume1.status}）`);

            // 暂缓通知建单人行应消失（回 processing 态），重启通知开发行应出现
            const holdNotifyRowAfter = page.locator('.u-notify-row:has-text("暂缓通知建单人")');
            await shotOnFail(page, (await holdNotifyRowAfter.count()) === 0, 't3-hold-notify-row-gone-after-resume', '恢复后「暂缓通知建单人」通知行消失（非 已暂缓 态不再渲染）');
            const resumeNotifyRow = page.locator('.u-notify-row:has-text("重启通知开发")');
            await shotOnFail(page, (await resumeNotifyRow.count()) > 0, 't3-resume-notify-row-visible', '恢复后「重启通知开发（批量）」通知行可见');

            // 列表角标：恢复后消失
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const badgeRow2 = page.locator(`tr:has-text("T3-bug暂缓恢复循环-${RUN_TAG}")`);
            const badgeText2 = await badgeRow2.textContent();
            await shotOnFail(page, !/已暂缓\s*\d+\s*天/.test(badgeText2), 't3-badge-gone-after-resume', `恢复后列表行**不**显示「已暂缓 N 天」角标（last_held_at 非 NULL 但 status 已非已暂缓，实得摘要："${badgeText2.replace(/\s+/g, ' ').slice(0, 120)}"）`);

            // 第二轮暂缓——验证角标重新计数（非累加），只显示最近一轮
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("暂缓")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `第二轮暂缓原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterHold2 = await issueRow(bugCycle);
            await shotOnFail(page, afterHold2.status === '已暂缓', 't3-hold2-status', `第二轮暂缓后 DB status=已暂缓（实得=${afterHold2.status}）`);

            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const badgeRow3 = page.locator(`tr:has-text("T3-bug暂缓恢复循环-${RUN_TAG}")`);
            const badgeText3 = await badgeRow3.textContent();
            await shotOnFail(page, /已暂缓\s*0\s*天/.test(badgeText3), 't3-badge-recount-on-rehold', `第二轮暂缓后角标重新计数为「已暂缓 0 天」（非沿用/累加第一轮，实得摘要含："${badgeText3.replace(/\s+/g, ' ').slice(0, 120)}"）`);

            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't3-console-clean', `T3 全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4：变更流（feature）暂缓→恢复 真实 UI 点击——证明 siConfirmSimple 修复对两条流同时生效
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T4：变更流 暂缓→恢复 真实 UI 点击（siConfirmSimple 修复回归·两流同验） ──');
        const featureCycle = await mkIssue({ type: 'feature', status: '开发中', title: `T4-feature暂缓恢复-${RUN_TAG}`, assignedTo: VARIANT_DEV_ID, assignedToName: '示例开发A' });
        await mkDevAssignee(featureCycle, VARIANT_DEV_ID, '示例开发A');
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${featureCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('#siDActions button:has-text("暂缓")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `变更流暂缓原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterHold = await issueRow(featureCycle);
            await shotOnFail(page, afterHold.status === '已暂缓', 't4-hold-status', `变更流暂缓后 DB status=已暂缓（实得=${afterHold.status}）`);

            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${featureCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("恢复")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.click('#siMConfirm');   // 留空原因——同 T3，证明修复非 bug 单侧特例
            await page.waitForTimeout(300);
            const stillOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, stillOpen === 1, 't4-resume-reason-required-blocks', `变更流恢复原因留空 → 弹窗仍打开（实得开启数=${stillOpen}）`);

            await page.fill('#f_reason', `变更流恢复原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterResume = await issueRow(featureCycle);
            await shotOnFail(page, afterResume.status === '开发中', 't4-resume-status', `变更流恢复后 DB status 回到开发中（实得=${afterResume.status}）`);

            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't4-console-clean', `T4 全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T5：已暂缓 → 作废，列表角标应消失（不残留陈旧天数）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5：已暂缓单作废后角标不显示 ──');
        const bugVoidCycle = await mkIssue({ type: 'bug', status: '处理中', title: `T5-bug暂缓后作废-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugVoidCycle, ROSTER_DEV_ID, '示例用户A');
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugVoidCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('#siDActions button:has-text("暂缓")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `待作废前的暂缓原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterHold = await issueRow(bugVoidCycle);
            await shotOnFail(page, afterHold.status === '已暂缓', 't5-hold-status', `作废前先暂缓成功（实得=${afterHold.status}）`);

            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugVoidCycle}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("作废")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `作废原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterVoid = await issueRow(bugVoidCycle);
            await shotOnFail(page, afterVoid.status === '已作废', 't5-void-status', `作废后 DB status=已作废（实得=${afterVoid.status}）`);

            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            // 已作废单默认不入列表（siVisibleTypeList 过滤 status!=='已作废'，见 Sys_Iteration.html:1105）——
            // 须先勾选「含已作废」（#siFVoided，admin/受理人筛选项，2026-08-17 起开放受理人）才能定位到该行，否则会误读成"行不存在/角标不显示"，
            // 而实际是行根本没渲染，断言会名不副实地"意外通过"。
            await page.check('#siFVoided');
            await page.waitForTimeout(500);
            const badgeRowVoid = page.locator(`tr:has-text("T5-bug暂缓后作废-${RUN_TAG}")`);
            await shotOnFail(page, (await badgeRowVoid.count()) > 0, 't5-void-row-visible-with-filter', '勾选「含已作废」后能定位到已作废单据所在行（断言前提显式化）');
            const badgeTextVoid = await badgeRowVoid.textContent();
            await shotOnFail(page, !/已暂缓\s*\d+\s*天/.test(badgeTextVoid), 't5-badge-gone-after-void', `作废后列表行**不**显示「已暂缓 N 天」角标（实得摘要："${badgeTextVoid.replace(/\s+/g, ' ').slice(0, 120)}"）`);

            await shotOnFail(page, consoleErrorsExcludingKnown(page).length === 0, 't5-console-clean', `T5 全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingKnown(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T6：两个新 409 码的前端友好提示（均在真实外呼钉钉之前被拒绝，点击安全）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T6：RESUME_ANCHOR_NOT_FOUND / NOTIFY_CLAIM_CONFLICT 友好提示 ──');
        // T6a：从未暂缓过的「处理中」bug 单点「重启通知开发」→ 409 RESUME_ANCHOR_NOT_FOUND
        const bugNeverHeld = await mkIssue({ type: 'bug', status: '处理中', title: `T6a-bug从未暂缓-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugNeverHeld, ROSTER_DEV_ID, '示例用户A');
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugNeverHeld}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const resumeNotifyRow = page.locator('.u-notify-row:has-text("重启通知开发")');
            await shotOnFail(page, (await resumeNotifyRow.count()) > 0, 't6a-row-visible', '从未暂缓过的处理中单「重启通知开发」行仍可见（前端不重复实现§7.3锚点算法，只提供入口）');
            await resumeNotifyRow.locator('button:has-text("发送通知")').click();
            await page.waitForTimeout(500);
            const toastText = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, toastText.includes('并非通过重启') || toastText.includes('重启'), 't6a-friendly-toast', `点击后 toast 显示后端友好中文提示（实得："${toastText}"）`);
            const afterClick = await issueRow(bugNeverHeld);
            await shotOnFail(page, afterClick.status === '处理中', 't6a-no-side-effect', `409 拒绝后单据状态未变（无副作用，实得=${afterClick.status}）`);
            // 注：本小节故意点击触发 409（这正是要验证的行为，非意外），浏览器会为该次失败的 fetch 记一条
            // "Failed to load resource...409" console 消息——这是**预期噪音**而非回归信号，不纳入本节 console
            // 断言（真正要验证的是 toastText 显示了友好中文提示，已在上一条断言核实）。
            await page.close();
        }

        // T6b：暂缓态 + SQL 预置 creator_notify_message_key 造成"被占坑"态 → 409 NOTIFY_CLAIM_CONFLICT
        const bugClaimStuck = await mkIssue({ type: 'bug', status: '处理中', title: `T6b-bug认领冲突-${RUN_TAG}`, assignedTo: ROSTER_DEV_ID, assignedToName: '示例用户A' });
        await mkDevAssignee(bugClaimStuck, ROSTER_DEV_ID, '示例用户A');
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugClaimStuck}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("暂缓")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_reason', `认领冲突场景暂缓原因-${RUN_TAG}`);
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const afterHold = await issueRow(bugClaimStuck);
            await shotOnFail(page, afterHold.status === '已暂缓', 't6b-hold-status', `暂缓成功（实得=${afterHold.status}）`);

            // SQL 模拟"已被占坑但未完成"：creator_notify_message_key 非空 + status 仍 not_sent
            //   （安全改写，不经真实外呼——同源自既有套件"SQL 直接模拟通知态"手法，见文件头部说明）
            await dbRun(`UPDATE sys_issues SET creator_notify_message_key='stuck-claim-token-${RUN_TAG}' WHERE id=?`, [bugClaimStuck]);
            await page.close();

            // ⚠️ 点击者必须换成在册开发（非 admin）——本单 created_by 默认落 ADMIN_ID（mkIssue 默认值），
            //   若仍用 adminTok 点击，会命中 §7.3 端点检查顺序里**更早**的一步"操作者==建单人→self-guard
            //   跳过发送"（SELF_NOTIFY_SKIPPED），claim-conflict 那一步根本走不到——实测踩坑：用 admin 点击
            //   toast 显示的是"无需通知自己"而非认领冲突提示。换成在册开发（actor≠建单人）才能真正触达
            //   claim 校验这一步。
            const page2 = await loginPage(browser, rosterDevTok);
            await page2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${bugClaimStuck}`);
            await page2.waitForLoadState('networkidle');
            await page2.waitForTimeout(500);
            const holdNotifyRow = page2.locator('.u-notify-row:has-text("暂缓通知建单人")');
            await shotOnFail(page2, (await holdNotifyRow.count()) > 0, 't6b-row-visible', '「已暂缓」态下「暂缓通知建单人」行对在册开发仍可见（message_key 被占不影响行渲染，只影响点击结果）');
            await holdNotifyRow.locator('button:has-text("发送通知")').click();
            await page2.waitForTimeout(500);
            const toastText = await page2.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page2, toastText.includes('认领') || toastText.includes('发送中'), 't6b-friendly-toast', `点击后 toast 显示后端友好中文提示（实得："${toastText}"）`);
            const afterClick = await issueRow(bugClaimStuck);
            await shotOnFail(page2, afterClick.creator_notify_status === 'not_sent', 't6b-no-side-effect', `409 拒绝后 creator_notify_status 仍为 not_sent（未被真实发送改写，实得=${afterClick.creator_notify_status}）`);
            // 注：同 T6a，本节故意点击触发 409（认领冲突正是要验证的目标），"Failed to load resource...409"
            // 是预期噪音，不纳入本节 console 断言。
            await page2.close();
        }
    } finally {
        // 🧹 清理测试夹具（不依赖存量数据，自建自清；含子表级联）
        for (const id of createdIssueIds) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [id]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [id]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [id]);
        }
        console.log(`\n  🧹 测试夹具已清理（${createdIssueIds.length} 个 issue：${createdIssueIds.join(', ')}）`);
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ bug暂缓方案 S4 前端 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 bug暂缓方案 S4 前端 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
