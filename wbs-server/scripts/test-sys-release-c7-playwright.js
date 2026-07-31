/**
 * 上线体统一重构 C7（前端收尾）Playwright 冒烟——本批新增 UI 行为的真浏览器验证，与既有
 * test-sys-release-panel-c2b2-playwright.js 互补（后者覆盖 C2b/C3 既有面板，本脚本只测 C7 新增/变更点）：
 *   T1 术语「已归档」：close 归档后状态徽标显示「已归档」（数据值仍是「已关闭」，siStatusDisplay 展示层映射）
 *   T2 归档 + 重开真实全链路（feature）：关闭按钮可见可点 → 徽标「已归档」→「重开」按钮出现可点 → 回「开发中」
 *       + 重开后 release_id 清空、旧上线单的 getReleaseMembers 仍 snapshot（红线，API 层核对，非 UI 断言）
 *   T3 「安排上线」/「上线单管理」/「值班排班」在 META_OK 异常态仍可达（拦截 /api/sys-issues/meta 返 500）
 *       + 反向：「新建迭代单」/「删除审计」/「上线编排」/「流程说明」/「上线日志」（2026-07-31 新增，
 *       与删除审计同门槛）五个入口此时应隐藏（§6.7 边界）
 *   T4 降级历史显著提示：构造快照缺失的已发布上线单，详情页应出现红底提示 + 成员行「不可用」占位
 *   T5 排班维护只读预览（非对接人视角）：无写表单/无「操作」列 + 出现「只读预览」提示文案
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-release-c7-playwright.js
 *
 * ⚠️ 钉钉安全边界（复核确认，同 c2b2 脚本头部说明）：
 *   - close/reopen 两动作的 notifyAfterCommit 标记（'notifyAssignedDeveloper'）走 dispatchSysNotify，
 *     其内 isAutoNotifyEnabled() 硬编码 return false（index.js:9075-9079），任何 type 均早返回、不触发
 *     外呼——本脚本对 close/reopen 两个按钮做真实点击全链路验证，安全（同 execute 的既有安全先例）。
 *   - 本脚本全程不点击 hotfix-publish / notify-executor / notify-release-executor(-batch) 任何确认按钮
 *     （这几个走 sendIssueDingtalkRaw 直连，会真实外呼）——不涉及则不构造，非"点了但没点确定"。
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = 'C:\\Users\\FY\\AppData\\Local\\Temp\\claude\\E-------------\\a54adce7-08ae-486c-ad80-5602b9b49bf0\\scratchpad';

const ADMIN_ID = 1;
const LIAISON_ID = 13;    // 示例对接人（受理人白名单·排班写权）
const OTHER_ID = 8;       // 示例开发A（active·role=user·非白名单·非对接人，供只读预览视角）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
async function api(token, method, p, body) {
    const r = await fetch(`${BASE_URL}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* 无 body */ }
    return { status: r.status, body: j };
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `c7-fail-${name}.png`);
        try { await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); } catch (_) { /* 截图本身失败不影响主流程 */ }
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
    const adminTok = await signAs(ADMIN_ID);
    const otherTokForExec = await signAs(OTHER_ID);   // 执行人须非 admin/viewer（hasReleaseEligibility 排除两者）
    console.log('\n══════ 上线体统一重构 C7（前端收尾）Playwright 冒烟 ══════');

    // ── 夹具：feature 单，SQL 快进到「待上线」+ 补一条已完成态 dev_assignee（供 execute 的 roster 门通过，
    //    同 c2b2 脚本 issue2 既有手法）+ 补 assigned_to（legacy 单值列，供 close/reopen 走的 ADMIN_TRANSITION/
    //    sysIssueTransition [4] RC-M5 不变量用——「进入 REQUIRES_ASSIGNEE_STATUSES 前必须有开发负责人」
    //    检的是 row.assigned_to 这个旧列，非 sys_issue_dev_assignees 多开发表；execute 走 RELEASE
    //    routeKind 独立路径不经此检查，故 c2b2 脚本的同款夹具从未补过 assigned_to 也能过 execute，但
    //    close/reopen 走 ADMIN_TRANSITION 会经过 [4]，本脚本首次实测踩坑后补上）。
    const mkIssue = async (title, type) => {
        const r = await api(adminTok, 'POST', '/api/sys-issues', {
            type: type || 'feature', title, system_name: '智数协同', source: '内部', intake_contract_version: 2,
        });
        if (r.status !== 201) throw new Error(`建单失败: ${JSON.stringify(r.body)}`);
        const id = r.body.id;
        await dbRun(`UPDATE sys_issues SET status='待上线', assigned_to=?, assigned_to_name=? WHERE id=?`, [OTHER_ID, '示例开发A', id]);
        await dbRun(
            `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, 'code_submitted')`,
            [id, OTHER_ID, '示例开发A']
        );
        return id;
    };
    // 标题带时间戳后缀防碰撞——若前次运行异常中断（在 try/finally 覆盖范围之外，如夹具搭建阶段本身
    // 失败），残留的旧夹具标题若与本次固定字面量相同，会让 Playwright 的 :has-text() 定位到多个元素
    // （strict mode violation，首次实测踩坑）。加时间戳后缀使每次运行标题唯一，比"依赖清理必然成功"更稳。
    const RUN_TAG = Date.now();
    const issueA = await mkIssue(`C7冒烟-归档重开A-${RUN_TAG}`);
    const issueDegraded = await mkIssue(`C7冒烟-降级B-${RUN_TAG}`);

    const mkBatch = async (title) => {
        const r = await api(adminTok, 'POST', '/api/sys-releases', { title });
        if (r.status !== 201) throw new Error(`建上线单失败: ${JSON.stringify(r.body)}`);
        return r.body.id;
    };
    const relA = await mkBatch(`C7冒烟批A-${RUN_TAG}`);
    const relDeg = await mkBatch(`C7冒烟批B-降级-${RUN_TAG}`);
    await api(adminTok, 'POST', `/api/sys-releases/${relA}/add-issues`, { issue_ids: [issueA] });
    await api(adminTok, 'POST', `/api/sys-releases/${relDeg}/add-issues`, { issue_ids: [issueDegraded] });

    // 真实发布两个上线单（execute 端点，isAutoNotifyEnabled=false，零外呼，同 c2b2 既有安全先例）：
    // 中心守卫要求 notify_status='sent' + release_assignee_id=actor.id + 实时资格（非 admin/viewer），
    // 直接 SQL 钉好三前提（同 verify-sys-release.js 的 publishRelease() 手法），走真实 /execute 走完整
    // 内核（快照写入等）。执行人用示例开发A（8，role=user·active，非 admin/viewer，满足 hasReleaseEligibility）。
    for (const rid of [relA, relDeg]) {
        await dbRun(`UPDATE sys_releases SET release_assignee_id=?, release_assignee_name='示例开发A', release_assignee_notify_status='sent' WHERE id=?`, [OTHER_ID, rid]);
    }
    const execA = await api(otherTokForExec, 'POST', `/api/sys-releases/${relA}/execute`, { release_note: 'C7冒烟发布A', version_tag: 'v-c7-a' });
    const execDeg = await api(otherTokForExec, 'POST', `/api/sys-releases/${relDeg}/execute`, { release_note: 'C7冒烟发布B', version_tag: 'v-c7-b' });
    if (execA.status !== 200 || execDeg.status !== 200) throw new Error('夹具发布失败: ' + JSON.stringify([execA.body, execDeg.body]));
    console.log(`  夹具就绪：issueA=#${issueA} issueDegraded=#${issueDegraded} relA=#${relA} relDeg=#${relDeg}`);

    // T4 前置：人为破坏 relDeg 的发布留痕，制造 degraded 态（快照行 + release_published timeline 行均删）——
    // 与 verify-sys-release.js/verify-sys-bug-transitions.js 的 degraded 构造手法同源（直接 SQL，非新发明）。
    await dbRun(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [relDeg]);
    await dbRun(`DELETE FROM sys_issue_timeline WHERE ref_id=? AND event_type='scope_change' AND action_code='release_published'`, [relDeg]);
    const degCheck = await dbGet(`SELECT COUNT(*) AS n FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [relDeg]);
    must(degCheck.n === 0, 'T4 前置：relDeg 快照表已清空（构造 degraded 态成功）');

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1+T2：归档「已归档」展示 + 归档/重开真实全链路（feature，admin 视角）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1+T2：归档「已归档」展示 + 归档/重开真实全链路 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueA}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const badgeBefore = await page.locator('#siDrawer .u-status-badge').first().textContent();
            await shotOnFail(page, badgeBefore.includes('已上线'), 't2-status-before-close', `归档前状态徽标显示「已上线」（实得："${badgeBefore.trim()}"）`);

            // close 走 siConfirmSimple → siModal 自定义弹窗（非浏览器原生 confirm()），须点弹窗自带的
            // #siMConfirm「确定」按钮；siModal 内 note() 无输入字段，直接点确定即可。
            // 按钮文案：[C7·术语] close 的按钮标签已从「关闭」改「归档」（siRenderActions 内 lbl 覆盖，
            // 与状态展示层「已归档」呼应），仅 action=close 本身（后端 action code/API 路径不变）。
            const closeBtn = page.locator('button:has-text("归档")').first();
            await shotOnFail(page, (await closeBtn.count()) > 0, 't2-close-btn-visible', '「归档」按钮可见（已上线态·admin，[C7] 原「关闭」按钮文案已改）');
            await closeBtn.click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);

            const badgeAfterClose = await page.locator('#siDrawer .u-status-badge').first().textContent();
            await shotOnFail(page, badgeAfterClose.includes('已归档'), 't1-status-badge-archived',
                `[C7·术语] 归档后状态徽标显示「已归档」（数据值仍是「已关闭」，siStatusDisplay 展示层映射；实得："${badgeAfterClose.trim()}"）`);
            await shotOnFail(page, !badgeAfterClose.includes('已关闭'), 't1-status-badge-not-raw-closed', '归档后徽标不应出现原始值「已关闭」字样');

            const dbStatusAfterClose = await dbGet('SELECT status FROM sys_issues WHERE id=?', [issueA]);
            await shotOnFail(page, dbStatusAfterClose.status === '已关闭', 't1-db-status-raw', `[C7·写读同源] 数据库层原始值仍是「已关闭」（展示层改名不影响数据，实得："${dbStatusAfterClose.status}"）`);

            const reopenBtn = page.locator('button:has-text("重开")').first();
            await shotOnFail(page, (await reopenBtn.count()) > 0, 't2-reopen-btn-visible', '「重开」按钮出现（已关闭态·admin）');
            await reopenBtn.click();
            // reopen 走 siModalReason → siModal 自定义弹窗，字段 id 规律为 f_<key>（siModal 内 fields.forEach
            // 用 'f_' + f.k 取值），reason 字段即 #f_reason；填完点 #siMConfirm 提交。
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonInput = page.locator('#f_reason');
            await shotOnFail(page, (await reasonInput.count()) > 0, 't2-reopen-reason-field', '重开弹窗出现「重开原因」输入框（#f_reason）');
            await reasonInput.fill('C7冒烟-验证归档重开全链路');
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);

            const dbStatusAfterReopen = await dbGet('SELECT status, release_id, released_at, closed_at, reopen_count FROM sys_issues WHERE id=?', [issueA]);
            await shotOnFail(page, dbStatusAfterReopen.status === '开发中', 't2-reopen-target-status', `重开后落库状态=开发中（change 流目标态，实得："${dbStatusAfterReopen.status}"）`);
            await shotOnFail(page, dbStatusAfterReopen.release_id === null, 't2-reopen-clears-release-id', 'release_id 已清空（脱离旧上线单）');
            await shotOnFail(page, dbStatusAfterReopen.released_at === null, 't2-reopen-clears-released-at', 'released_at 已清空');
            await shotOnFail(page, dbStatusAfterReopen.closed_at === null, 't2-reopen-clears-closed-at', 'closed_at 已清空');
            await shotOnFail(page, dbStatusAfterReopen.reopen_count === 1, 't2-reopen-count', `reopen_count=1（实得：${dbStatusAfterReopen.reopen_count}）`);

            // 红线核对（API 层，非 UI）：旧上线单本身未被拖回计划中，仍是「已发布」。
            const relRowAfter = await dbGet('SELECT status FROM sys_releases WHERE id=?', [relA]);
            await shotOnFail(page, relRowAfter.status === '已发布', 't2-release-not-reverted',
                `[红线] 重开后旧上线单 #${relA} 仍「已发布」（未被拖回计划中，实得："${relRowAfter.status}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't2-console-clean', `页面全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3：META_OK 异常态边界——「上线单管理」/「值班排班」仍可达；其余四入口隐藏（§6.7）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T3：META_OK 异常态边界（拦截 /api/sys-issues/meta 返 500） ──');
            const page = await loginPage(browser, adminTok);
            await page.route('**/api/sys-issues/meta', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟 meta 加载失败' }) }));
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const metaOkVal = await page.evaluate(() => window.META_OK !== undefined ? META_OK : null).catch(() => null);
            // META_OK 是模块内 let 变量非 window 属性，取不到属正常；改用按钮可见性间接验证（更贴近用户视角）。
            await shotOnFail(page, (await page.locator('button:has-text("上线单管理")').count()) > 0, 't3-batch-mgmt-visible-degraded', '「上线单管理」在 meta 加载失败时仍可见（§6.7 断言）');
            await shotOnFail(page, (await page.locator('button:has-text("值班排班")').count()) > 0, 't3-duty-roster-visible-degraded', '「值班排班」在 meta 加载失败时仍可见（§6.15 登录即可见）');
            await shotOnFail(page, (await page.locator('button:has-text("新建迭代单")').count()) === 0, 't3-create-hidden-degraded', '「新建迭代单」在 meta 加载失败时应隐藏（依赖 typeFlows）');
            await shotOnFail(page, (await page.locator('button:has-text("删除审计")').count()) === 0, 't3-audit-hidden-degraded', '「删除审计」在 meta 加载失败时应隐藏（与 meta 一起降级，非应急路径）');
            await shotOnFail(page, (await page.locator('button:has-text("上线日志")').count()) === 0, 't3-release-log-hidden-degraded', '「上线日志」（2026-07-31 新增）在 meta 加载失败时应隐藏（与删除审计同门槛，非应急路径）');
            await shotOnFail(page, (await page.locator('button:has-text("上线编排")').count()) === 0, 't3-orch-hidden-degraded', '「上线编排」legacy 面板在 meta 加载失败时应隐藏');
            await shotOnFail(page, (await page.locator('button:has-text("流程说明")').count()) === 0, 't3-guide-hidden-degraded', '「流程说明」在 meta 加载失败时应隐藏');

            // 「上线单管理」在此状态下点开仍应可用（不依赖 meta），验证真正"可达"而非只是"可见但点了报错"。
            await page.click('button:has-text("上线单管理")');
            await page.waitForTimeout(400);
            await shotOnFail(page, (await page.locator(`.si-batch-item:has-text("C7冒烟批A-${RUN_TAG}")`).count()) > 0, 't3-batch-mgmt-usable-degraded', '「上线单管理」面板在 meta 加载失败时仍能正常加载列表（真正可达，非仅可见）');

            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4：降级历史的显著提示（relDeg，快照+timeline 均已被清空）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T4：降级历史显著提示 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click('button:has-text("上线单管理")');
            await page.waitForTimeout(300);

            // 列表视图：degraded 角标可见
            const listItemText = await page.locator(`.si-batch-item:has-text("C7冒烟批B-降级-${RUN_TAG}")`).textContent();
            await shotOnFail(page, listItemText.includes('历史记录不完整'), 't4-list-degraded-badge', `[C7·§6.6b] 列表视图 degraded 上线单出现「历史记录不完整」标记（实得摘要："${listItemText.replace(/\s+/g, ' ').trim().slice(0, 80)}"）`);

            await page.click(`.si-batch-item:has-text("C7冒烟批B-降级-${RUN_TAG}")`);
            await page.waitForTimeout(400);

            const bodyHtml = await page.locator('#siBatchBody').innerHTML();
            const alertVisible = await page.locator('#siBatchBody .si-notify-alert').count();
            await shotOnFail(page, alertVisible > 0, 't4-alert-present', '详情页出现红底显著提示（si-notify-alert，非弱提示 si-gate-hint）');
            await shotOnFail(page, bodyHtml.includes('历史记录不完整'), 't4-alert-wording', '提示文案含「历史记录不完整」（准确措辞，非"没有历史"）');
            await shotOnFail(page, /不可用/.test(bodyHtml), 't4-unavailable-not-blank', '不可用字段显式渲染「不可用」而非空白（不伪造）');
            await shotOnFail(page, !/undefined|null(?!\w)/.test(bodyHtml.replace(/si-muted|onclick|siOpenDrawer\(null\)/g, '')), 't4-no-raw-null-leak', '页面不泄漏原始 "undefined"/"null" 字面量（应转成中文占位文案）');

            await shotOnFail(page, page._consoleErrors.length === 0, 't4-console-clean', `页面全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T5：排班维护只读预览（非对接人视角）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T5：排班维护只读预览（非对接人视角） ──');
            const otherTok = await signAs(OTHER_ID);
            const page = await loginPage(browser, otherTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click('button:has-text("值班排班")');
            await page.waitForTimeout(400);

            await shotOnFail(page, (await page.locator('#siDutyRosterBody').textContent()).includes('只读预览'), 't5-readonly-hint', '非对接人视角出现「只读预览」提示文案');
            await shotOnFail(page, (await page.locator('#siDutyRosterBody button:has-text("新增/调班")').count()) === 0, 't5-no-write-form', '非对接人视角不出现「新增/调班」写表单按钮');
            await shotOnFail(page, (await page.locator('#siDutyRosterBody button:has-text("批量设置")').count()) === 0, 't5-no-batch-form', '非对接人视角不出现「批量设置」写表单按钮');
            await shotOnFail(page, (await page.locator('#siDutyRosterBody th:has-text("操作")').count()) === 0, 't5-no-action-column', '非对接人视角表格不出现「操作」列（无移除按钮）');

            await shotOnFail(page, page._consoleErrors.length === 0, 't5-console-clean', `页面全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }
    } finally {
        // 🧹 清理测试夹具
        for (const rid of [relA, relDeg]) {
            await dbRun(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [rid]);
            await dbRun(`DELETE FROM sys_issue_timeline WHERE ref_id=? AND event_type='scope_change'`, [rid]);
        }
        for (const iid of [issueA, issueDegraded]) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [iid]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [iid]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [iid]);
        }
        for (const rid of [relA, relDeg]) {
            await dbRun(`DELETE FROM sys_releases WHERE id=?`, [rid]);
        }
        console.log('\n  🧹 测试夹具已清理（issueA/issueDegraded、relA/relDeg）');
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ C7 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 C7 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
