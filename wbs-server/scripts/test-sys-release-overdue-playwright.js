/**
 * 上线逾期留痕（方案 20260910 v1.2）·C3 A 块前端 Playwright 活体验证
 * 用法：外部 server:3000 已起（本文件不自拉服务，见下方"server 编排"约定）后：
 *   node scripts/test-sys-release-overdue-playwright.js
 *
 * ⚠️ 一次只跑一个写 db 的 Playwright——本文件直连 task_pool.db 造夹具（同 test-sys-release-mgmt-
 *   playwright.js/c7/panel-c2b2 既有三个同族文件的约定：外部 server:3000 + 真实 task_pool.db +
 *   标题前缀隔离，非独立端口+db 副本——C3 任务书原写"独立端口+db 副本"与本模块三个既有 Playwright
 *   同胞文件的实际范式不一致，本文件按既有范式实现，偏离已在交付报告第 5 条注明）。
 *
 * 数据隔离：全部造数标题恒 RELOD- 前缀（共享面隔离约定，与 RELMG-/其它前缀区分）。
 *
 * 覆盖（任务书验证节逐条）：
 *   [1] 预判层三态：普通∧isLast∧逾期 → 弹层含理由块；应急 → 不含（仍成功写留痕）；非最后一人 → 不含
 *   [1d]（C4e·codex 560 M1 新增）预判层判逾期但服务端不判：`page.addInitScript` 把浏览器 Date 拨快
 *       1 天 + planned_date=今天 → 预判层误判展开理由块（视觉提示）→ 理由留空直接提交 → 200（服务端按
 *       真实时钟判定不逾期，不因前端误判而被拦——方案 §5.1.5"预判层=体验、权威层=正确"）
 *   [2] 过滤器可见性：逾期留痕行标签「上线逾期」+ si-tl-red，勾选「隐藏上线单调整记录」后仍可见
 *       （对照：release_add scope_change 事件应被同一过滤器隐藏，证明过滤器本身在生效）
 *   [3] 统一重试上下文：
 *       3a 先缺说明（RELEASE_NOTE_REQUIRED=400，route 剥 release_note）→ 补 → 200
 *       3b 先缺理由（RELEASE_OVERDUE_REASON_REQUIRED，route 剥 overdue_reason_code/note）→ 弹层重新
 *          展开且旧输入保留（ctx 未被 route 篡改，前端仍记得用户刚填的理由）→ 补（不剥）→ 200
 *       3e（C3c·codex 557 M2① 新增）完整链——真实并发构造（非 route 篡改）：二人批次，本人打开时
 *          isLast=false（不渲染 note/reason 任何字段）→ 另一执行人并发完成（直接 SQL 转 done，本页
 *          不刷新）→ 本人点确认，裸身请求命中"实为最后一人"→ 400 NOTE_REQUIRED → 补说明 → 409
 *          OVERDUE_REQUIRED → 补理由 → 200（[C4i·563-R2 M1] NOTE_REQUIRED 与 OVERDUE_REQUIRED 状态码
 *          不同——前者 400，后者 409，见 index.js SysTransitionError 首参）。route 纯监听（不篡改）三次
 *          真实请求体，断言
 *          executor_row_id 恒同、release_note 第②次起出现、overdue_reason_* 仅第③次出现且第③次的
 *          release_note 与第②次一致（未丢）
 *       3c（C3c·codex 557 M2② 改写）**补弹阶段**注入 EXECUTOR_NOT_ACTIVE（首提缺说明 400 REQUIRED →
 *          打开重试弹层补说明 → 这次提交才伪造 403）→ 断言 toast 原文 + 链在此终止（无第三次请求）
 *       3d（C3c·codex 557 M2③ 改写）**逾期批次**成功响应丢失后幂等重试：首提带齐说明+理由 →
 *          route.fetch()+abort() 真实达成服务端成功（含理由落库+留痕）但对客户端隐藏响应 → 二次点击 →
 *          断言响应体 already===true、sys_releases 两列理由与首提一致（未被幂等路径重算/覆盖）、
 *          成员单恰一条 release_overdue_reason 留痕行（读库计数，非"至少一条"）
 *   [4]（C3b·Opus 预筛 HIGH-1 新增）迟到响应竞态：route 延迟批次 A 的 execute 响应 1.5s → 点确认后
 *       立即关掉批次 A 的确认弹层并打开批次 B 的确认弹层（同页不刷新，siModalInstanceSeq 递增）→
 *       等批次 A 的迟到响应到达 → 断言批次 B 的弹层仍 open 且内容未被替换/关闭（siReleaseExecuteSubmit
 *       必须在 await siApi 之后核对 siModalInstanceSeq 未变才能继续做 DOM 动作）
 *   [5]（C3c·codex 557 M1 新增）成功分支第二个 await 之后的迟到续体：siReleaseExecuteSubmit 成功分支
 *       在 `await siLoadList()` 期间用户切到批次 B 详情 → 续体不得再用 `siOpenBatchDetail(releaseId)`
 *       顶掉批次 B（同 siAuditGen 批次总览导航令牌核对，同 HIGH-1 的 siModalInstanceSeq 同一条链、
 *       不同 await 点各自需要重核）
 *
 * 断言纪律：先想"实现坏成什么样这条会红"；断言对象写明（DOM class/文本、库值、响应体字段）。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-release-overdue-playwright-shots');
const TITLE_PREFIX = 'RELOD-';

const ADMIN_ID = 1;
const EXEC_ID = 8;     // 示例开发A（role=user，非白名单，供单人在册执行人视角——同族测试既有实例）
const EXEC2_ID = 9;    // 示例开发B——第二执行人（非最后一人分支）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
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
        const p = path.join(SCREENSHOT_DIR, `relod-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    return page;
}
// [C4e·codex 560 M1] 用 addInitScript 把页面里的 `Date` 整体前移 daysAhead 天——模拟"浏览器时钟领先
// 服务端"（同 test-sys-release-date-change-playwright.js 同名 helper），供覆盖"预判层判逾期但服务端
// 权威判定不逾期"这条方案 §5.1.5 明文的分支。0 参构造与 `Date.now()` 走偏移分支，带参构造保持原生
// 语义（不叠加偏移，否则"从已偏移的 now 取年月日再构造"会被二次偏移）。
async function loginPageWithFakedDate(browser, token, daysAhead) {
    const page = await browser.newPage();
    page.on('dialog', d => d.accept());
    await page.addInitScript((days) => {
        const offsetMs = days * 86400000;
        const RealDate = Date;
        class FakedDate extends RealDate {
            constructor(...args) {
                if (args.length === 0) super(RealDate.now() + offsetMs);
                else super(...args);
            }
            static now() { return RealDate.now() + offsetMs; }
        }
        window.Date = FakedDate;
    }, daysAhead);
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    return page;
}
// [C3b·Opus 预筛 M-3 收口] showToast 建的节点挂在 `#toast-container` 下、节点本身无 class（照
// test-sys-release-panel-c2b2-playwright.js:178-183 lastToastText 既有范式），原 `.toast, [class*="toast"]`
// 选择器永不命中——本文件同名复刻一份（未 require 该同族文件，避免跨文件耦合脆弱依赖）。
async function lastToastText(page) {
    return page.evaluate(() => {
        const nodes = document.querySelectorAll('#toast-container > div');
        return nodes.length ? nodes[nodes.length - 1].textContent.trim() : '';
    });
}
async function fetchJson(url, tok, opts = {}) {
    const r = await fetch(`${BASE_URL}${url}`, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let body = null; try { body = await r.json(); } catch (_) { /* ignore */ }
    return { status: r.status, body };
}

function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时（${timeoutMs}ms）——server 未就绪或响应异常`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js 再跑本文件`)); });
    });
}
async function ensureAppReadinessEndpoint() {
    const r = await fetch(`${BASE_URL}/api/sys-issues/_readiness`).catch((e) => {
        throw new Error(`应用 readiness 探测请求失败（${e.message}）`);
    });
    if (r.status !== 401) throw new Error(`应用 readiness 探测异常：期望 401，实得 ${r.status}`);
}

function pastDateStr(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// [C4g·codex 563 H1 收口] 精确清单——本轮夹具的批次/成员 id 在创建成功的那一刻立即登记，finally 清理
// 与残留核验只认这份清单，不再按标题前缀在结束时"扫一遍全表"（同 test-sys-release-date-change-
// playwright.js 同款范式，见该文件同名注释）。
const createdReleaseIds = [];
const createdIssueIds = [];
// ── 夹具 helper ──────────────────────────────────────────────────────────
async function mkRelease(adminTok, title, extra = {}) {
    const r = await fetchJson('/api/sys-releases', adminTok, { method: 'POST', body: { title } });
    if (r.status !== 201) throw new Error(`建批次失败 ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    createdReleaseIds.push(id);
    if (extra.plannedDate !== undefined) await dbRun('UPDATE sys_releases SET planned_date=? WHERE id=?', [extra.plannedDate, id]);
    if (extra.releaseKind) await dbRun('UPDATE sys_releases SET release_kind=? WHERE id=?', [extra.releaseKind, id]);
    if (extra.releaseNote) await dbRun('UPDATE sys_releases SET release_note=? WHERE id=?', [extra.releaseNote, id]);
    return id;
}
async function mkIssue(title) {
    // intake_required 必须为 1（角色权限重构 C0 焊死受理门：全类型必经受理，0 为非法态）——直接 SQL
    // 造「待上线」夹具须显式补这个列，绕开受理流程只是跳过流转步骤，不代表事实上"未受理过"。
    const r = await dbRun(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
         VALUES ('feature', '待上线', ?, 'BMS', '内部', 1, '管理员', 1)`, [title]
    );
    createdIssueIds.push(r.lastID);
    return r.lastID;
}
async function addIssueTo(adminTok, relId, issueId) {
    const r = await fetchJson(`/api/sys-releases/${relId}/add-issues`, adminTok, { method: 'POST', body: { issue_ids: [issueId] } });
    if (r.status !== 200) throw new Error(`加单失败 ${r.status} ${JSON.stringify(r.body)}`);
}
async function mkCompleteRoster(issueId, userId, userName) {
    await dbRun(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
         VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`, [issueId, userId, userName]
    );
}
async function addExecutor(relId, userId, userName) {
    await dbRun(
        `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
         VALUES (?, ?, ?, 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`, [relId, userId, userName]
    );
}
// 单人单成员批次的一站式搭建（同 verify-sys-release-overdue.js mkOneMemberReadyRelease 手法，
// Playwright 层复刻一份而非 require 该脚本——避免把验证脚本的 in-process 假设带进真实浏览器场景）。
async function mkOneMemberReadyRelease(adminTok, titleSuffix, extra = {}) {
    const relId = await mkRelease(adminTok, `${TITLE_PREFIX}${titleSuffix}`, extra);
    const issueId = await mkIssue(`${TITLE_PREFIX}成员-${titleSuffix}`);
    await addIssueTo(adminTok, relId, issueId);
    await mkCompleteRoster(issueId, extra.userId || EXEC_ID, extra.userName || '示例开发A');
    await addExecutor(relId, extra.userId || EXEC_ID, extra.userName || '示例开发A');
    return { relId, issueId };
}

async function openBatchDetail(page, relId) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${relId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
}

(async () => {
    console.log('═══ 上线逾期留痕 C3 Playwright 活体验证 ═══\n');
    try {
        await ensureServerListening();
        await ensureAppReadinessEndpoint();
    } catch (e) {
        console.error('❌ server 编排前置探测失败：' + e.message);
        process.exit(1);
    }

    const adminTok = await signAs(ADMIN_ID);
    const execTok = await signAs(EXEC_ID);

    // [C4h·codex 563-R M1 收口] 外层 try/finally 从"首次创建夹具之前"就开始包裹——历史夹具本身就是一次
    // 真实写库动作，旧写法把它放在受保护 try **之前**：若它之后、真正进入内层 try 之前发生任何异常
    // （含下面 chromium.launch 失败），整段都不会进清理分支，历史夹具和它之后可能已经产生的数据会
    // 永久遗留在共享库里。`browser` 声明为可空变量：launch 失败时它仍是 null，finally 里对它的 close
    // 调用需要判空跳过，不能让"没有浏览器可关"变成一次新异常，把后面的库清理又带崩。
    const historicalIds = [];
    let browser = null;
    try {
        // [C4g·codex 563 H1 变异证据] 预先植入一条"历史"同前缀记录（同 test-sys-release-date-change-
        // playwright.js 同款手法）——走真实建批次端点保证 schema 合法，随后从 createdReleaseIds 摘除，
        // 模拟不属于本轮精确清单的既有数据。本轮结束后必须仍然存在。
        const historicalReleaseId = await mkRelease(adminTok, `${TITLE_PREFIX}历史遗留记录-不属于本轮`);
        const historicalIdx = createdReleaseIds.indexOf(historicalReleaseId);
        if (historicalIdx >= 0) createdReleaseIds.splice(historicalIdx, 1);
        historicalIds.push(historicalReleaseId);

        browser = await chromium.launch({ headless: true });
    try {
        // ═══════════════════════════════════════════════════════════
        // [1a][2] 普通批次 ∧ isLast ∧ 逾期：预判层展开理由块 → 填写 → 200 → 时间线「上线逾期」
        //   红徽章 + 过滤器打开后仍可见（对照 release_add scope_change 应被隐藏）
        // ═══════════════════════════════════════════════════════════
        console.log('── [1a][2] 普通批次·isLast·逾期：预判层理由块 + 过滤器可见性 ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `普通逾期-${Date.now()}`, {
                plannedDate: pastDateStr(3), releaseNote: 'RELOD 夹具·预填上线说明',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await shotOnFail(page, (await execBtn.count()) >= 1, '1a-exec-btn', '应看到「确认上线完成」按钮');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            const reasonHint = page.locator('#siExecOverdueBlock');
            await shotOnFail(page, (await reasonHint.count()) === 1, '1a-reason-block-present', '预判层应渲染 #siExecOverdueBlock 理由块（普通∧isLast∧逾期三条件同时成立）');
            const blockVisible = await reasonHint.evaluate(el => getComputedStyle(el).display !== 'none');
            must(blockVisible, '理由块应可见（display!==none），非仅存在于 DOM 但隐藏');

            await page.selectOption('#f_siExecOverdueBlock_code', '环境或依赖未就绪');
            await page.fill('#f_siExecOverdueBlock_note', 'RELOD 夹具·环境未就绪');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1200);

            const relRow = await dbGet('SELECT overdue_reason_code, overdue_reason_note, status FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.status === '已发布', `批次应已发布，实得 ${JSON.stringify(relRow)}`);
            must(relRow && relRow.overdue_reason_code === '环境或依赖未就绪' && relRow.overdue_reason_note === 'RELOD 夹具·环境未就绪', `sys_releases 两列应落库真实理由，实得 ${JSON.stringify(relRow)}`);
            const tlRow = await dbGet(`SELECT summary, payload_json FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_overdue_reason'`, [relId]);
            must(!!tlRow, '应产出 release_overdue_reason 留痕行');

            // 过滤器可见性：重开详情看时间线
            await openBatchDetail(page, relId);
            const memberIssueId = await dbGet('SELECT id FROM sys_issues WHERE release_id=?', [relId]);
            const opened = await page.evaluate(async (id) => {
                if (typeof siCloseBatch === 'function') siCloseBatch();
                if (typeof siOpenDrawer !== 'function') return false;
                await siOpenDrawer(id); return true;
            }, memberIssueId.id);
            must(opened === true, 'siOpenDrawer 应可调用');
            await page.waitForSelector('.si-timeline', { timeout: 8000 });
            await page.waitForTimeout(400);

            const overdueEvt = page.locator('.si-tl-evt', { hasText: '上线逾期' });
            await shotOnFail(page, (await overdueEvt.count()) >= 1, '1a-overdue-badge', '时间线应渲染「上线逾期」徽章');
            const overdueCls = await overdueEvt.first().getAttribute('class');
            await shotOnFail(page, !!overdueCls && overdueCls.includes('si-tl-red'), '1a-overdue-cls', `「上线逾期」徽章 class 应含 si-tl-red，实得 ${overdueCls}`);

            const scopeEvt = page.locator('.si-tl-evt', { hasText: '加入上线单' });
            const filterChk = page.locator('input[onchange="siToggleTlReleaseScope(this.checked)"]');
            if (await filterChk.count() === 1) {
                await filterChk.check();
                await page.waitForTimeout(200);
                const overdueDisplayAfter = await overdueEvt.first().evaluate(el => getComputedStyle(el.closest('.si-tl-item')).display);
                must(overdueDisplayAfter !== 'none', `D2/D9：过滤开关打开后「上线逾期」所在 .si-tl-item 仍应可见，实得 display=${overdueDisplayAfter}`);
                // [C4g·codex 563 rec1 收口] 对照组不存在时必须直接判失败，不能条件跳过——静默跳过等于
                // 放弃了"证明过滤器真的在生效"这条断言，会让"release_add 事件其实从未渲染出来"这类
                // 真实回归悄悄溜过去而不报红。
                if (await scopeEvt.count() >= 1) {
                    const scopeDisplayAfter = await scopeEvt.first().evaluate(el => getComputedStyle(el.closest('.si-tl-item')).display);
                    must(scopeDisplayAfter === 'none', `对照组：release_add 应被过滤器隐藏（证明过滤器真的生效），实得 display=${scopeDisplayAfter}`);
                } else {
                    must(false, '对照组 release_add（"加入上线单"事件）应存在于时间线，未找到——无法证明过滤器真的在生效');
                }
            } else {
                must(false, '「隐藏上线单调整记录」过滤开关应渲染');
            }
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [1b] 应急批次·逾期：不展开理由块，直接成功，仍留痕（reason 两列为 null）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [1b] 应急批次·逾期：预判层不展开理由块，直接成功且留痕（理由两列 NULL） ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `应急逾期-${Date.now()}`, {
                plannedDate: pastDateStr(2), releaseKind: 'emergency', releaseNote: 'RELOD 夹具·应急预填说明',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);
            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            const reasonBlock = page.locator('#siExecOverdueBlock');
            must((await reasonBlock.count()) === 0, '应急批次不应渲染理由块（#siExecOverdueBlock 不存在）');

            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1200);
            const relRow = await dbGet('SELECT overdue_reason_code, overdue_reason_note, status, release_kind FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.status === '已发布', `应急批次应已发布，实得 ${JSON.stringify(relRow)}`);
            must(relRow && relRow.overdue_reason_code === null && relRow.overdue_reason_note === null, `应急批次理由两列应保持 NULL（不校验不持久化），实得 ${JSON.stringify(relRow)}`);
            const tlRow = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_overdue_reason'`, [relId]);
            must(!!tlRow, '应急批次仍应产出 release_overdue_reason 留痕行（只留事实，不留理由）');
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [1c] 非最后一人：不展开理由块（confirm 弹层只有"确认后还差 N 人"文案）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [1c] 二人批次·非最后一人：预判层不展开理由块 ──');
        let twoPersonRelId, twoPersonIssueId;
        {
            twoPersonRelId = await mkRelease(adminTok, `${TITLE_PREFIX}二人批次-${Date.now()}`, { plannedDate: pastDateStr(5) });
            twoPersonIssueId = await mkIssue(`${TITLE_PREFIX}成员-二人批次`);
            await addIssueTo(adminTok, twoPersonRelId, twoPersonIssueId);
            await mkCompleteRoster(twoPersonIssueId, EXEC_ID, '示例开发A');
            await addExecutor(twoPersonRelId, EXEC_ID, '示例开发A');
            await addExecutor(twoPersonRelId, EXEC2_ID, '示例开发B');

            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, twoPersonRelId);
            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonBlock = page.locator('#siExecOverdueBlock');
            must((await reasonBlock.count()) === 0, '非最后一人不应渲染理由块');
            must((await page.locator('text=还差').count()) >= 1, '应显示"确认后还差 N 人"文案');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);
            const myRow = await dbGet('SELECT exec_status FROM sys_release_executors WHERE release_id=? AND user_id=?', [twoPersonRelId, EXEC_ID]);
            must(myRow && myRow.exec_status === 'done', `示例开发A行应转 done（非最后一人分支已确认），实得 ${JSON.stringify(myRow)}`);
            const relRow = await dbGet('SELECT status FROM sys_releases WHERE id=?', [twoPersonRelId]);
            must(relRow && relRow.status === '计划中', `批次仍应「计划中」（还差示例开发B一人），实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [1d]（C4e·codex 560 M1 新增）预判层判逾期但服务端不判：浏览器时钟领先服务端 1 天 + planned_date
        //   =今天（真实服务端口径同日不算逾期）→ 预判层仍把它误判为"已逾期"、展开理由块（视觉提示不撤）
        //   → 理由留空直接提交 → 服务端按真实时钟判定不逾期 → 200（不阻断，方案 §5.1.5"预判层=体验、
        //   权威层=正确，不能只靠前端"）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [1d] 预判层判逾期但服务端不判（浏览器时钟领先 1 天）：理由留空直接提交 → 200 ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `预判逾期服务端不判-${Date.now()}`, {
                plannedDate: pastDateStr(0), releaseNote: 'RELOD 夹具·预判但服务端不判',
            });
            const page = await loginPageWithFakedDate(browser, execTok, 1);
            await openBatchDetail(page, relId);

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonBlock1d = page.locator('#siExecOverdueBlock');
            await shotOnFail(page, (await reasonBlock1d.count()) === 1, '1d-predict-block', '预判层（浏览器时钟领先）应把今天误判为已逾期，展开理由块（视觉提示）');

            // 理由留空——[M1] 预判层不再客户端阻断提交，点击应真的发出请求。
            const respP1d = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp1d = await respP1d;
            const resp1dBody = await resp1d.json().catch(() => null);
            must(resp1d.status() === 200, `[1d] 理由留空提交应 200（服务端按真实时钟判定同日不算逾期），实得 ${resp1d.status()} ${JSON.stringify(resp1dBody)}`);
            must(resp1dBody && resp1dBody.released === true, `[1d] 单人批次应本次触发发布，实得 ${JSON.stringify(resp1dBody)}`);

            const relRow1d = await dbGet('SELECT status, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?', [relId]);
            must(relRow1d && relRow1d.status === '已发布', `[1d] 批次应已发布，实得 ${JSON.stringify(relRow1d)}`);
            must(relRow1d && relRow1d.overdue_reason_code === null && relRow1d.overdue_reason_note === null, `[1d] 服务端未判逾期，理由两列应保持 NULL（未被强行要求也未落库任何值），实得 ${JSON.stringify(relRow1d)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [3a] 统一重试上下文——先缺说明：route 剥 release_note，400 RELEASE_NOTE_REQUIRED → 补 → 200
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [3a] 统一重试上下文·先缺说明（route 剥 release_note）→ 补 → 200 ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `重试缺说明-${Date.now()}`, { plannedDate: null });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);

            let stripped = false;
            await page.route('**/api/sys-releases/*/execute', async (route) => {
                if (!stripped && route.request().method() === 'POST') {
                    stripped = true;
                    const body = JSON.parse(route.request().postData() || '{}');
                    delete body.release_note;
                    await route.continue({ postData: JSON.stringify(body) });
                } else {
                    await route.continue();
                }
            });

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_release_note', 'RELOD 夹具·上线说明');
            // [C4h·codex 563-R M2 收口] 原写法固定等 800ms 后就去看 `#f_release_note` 是否存在——旧弹层
            // 本来就有这个字段，"存在"这一条判据在旧实例上也为真，测不出重试弹层是否真的重开。改为：
            // 点击前记 siModalInstanceSeq 快照 + 注册 waitForResponse，收到目标批次 execute 的响应后先断
            // 400 + RELEASE_NOTE_REQUIRED，再 waitForFunction 等实例号变化**且**新弹层已 open，确认
            // 是新弹层实例后才去读字段。
            const modalSeqBefore3a = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const respP3a = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3a = await respP3a;
            must(resp3a.status() === 400, `[3a] 首提缺说明应命中 400（RELEASE_NOTE_REQUIRED 是 400 语义，非 409），实得 ${resp3a.status()}`);
            const resp3aBody = await resp3a.json().catch(() => null);
            must(resp3aBody && resp3aBody.code === 'RELEASE_NOTE_REQUIRED', `[3a] 400 应确切为 RELEASE_NOTE_REQUIRED，实得 ${JSON.stringify(resp3aBody)}`);
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore3a, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            // 应重新展开一个只含「上线说明」的重试弹层
            const retryNoteField = page.locator('#f_release_note');
            await shotOnFail(page, (await retryNoteField.count()) === 1, '3a-retry-note-field', '400 RELEASE_NOTE_REQUIRED 后应重新展开上线说明输入框');
            const retryReasonBlock = page.locator('#siRetryOverdueBlock');
            must((await retryReasonBlock.count()) === 0, '未逾期批次的说明重试弹层不应带出理由块');
            await page.fill('#f_release_note', 'RELOD 夹具·上线说明·重试');
            const respP3a2 = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3a2 = await respP3a2;
            must(resp3a2.status() === 200, `[3a] 补填说明后再次提交应 200，实得 ${resp3a2.status()}`);
            await page.waitForTimeout(300);

            const relRow = await dbGet('SELECT status, release_note FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.status === '已发布' && relRow.release_note === 'RELOD 夹具·上线说明·重试', `补填说明后应发布成功且说明落库为重试值，实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [3b] 统一重试上下文——先缺理由：route 剥 overdue_reason_code/note，409 REQUIRED，
        //   弹层重新展开且旧输入保留（ctx 侧未被剥，用户刚填的理由原样回填）→ 补（不剥）→ 200
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [3b] 统一重试上下文·先缺理由（route 剥理由字段）→ 弹层重新展开且旧输入保留 → 200 ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `重试缺理由-${Date.now()}`, {
                plannedDate: pastDateStr(4), releaseNote: 'RELOD 夹具·已有说明',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);

            let stripped = false;
            await page.route('**/api/sys-releases/*/execute', async (route) => {
                if (!stripped && route.request().method() === 'POST') {
                    stripped = true;
                    const body = JSON.parse(route.request().postData() || '{}');
                    delete body.overdue_reason_code;
                    delete body.overdue_reason_note;
                    await route.continue({ postData: JSON.stringify(body) });
                } else {
                    await route.continue();
                }
            });

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await shotOnFail(page, (await page.locator('#siExecOverdueBlock').count()) === 1, '3b-predict-block', '预判层应展开理由块（批次逾期∧isLast∧普通）');
            await page.selectOption('#f_siExecOverdueBlock_code', '通知到达晚');
            await page.fill('#f_siExecOverdueBlock_note', 'RELOD 夹具·通知晚到夹具说明');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);

            // 弹层应重新展开（剥离生效，服务端 409 overdue_reason_required），且用旧输入回填（因为前端
            // ctx 里仍持有用户刚填的值，只是这次请求被 route 剥走，不是用户真的没填）。
            const retryBlock = page.locator('#siRetryOverdueBlock');
            await shotOnFail(page, (await retryBlock.count()) === 1, '3b-retry-block-present', '409 overdue_reason_required 后应重新展开 #siRetryOverdueBlock 理由块');
            const retriedCodeVal = await page.locator('#f_siRetryOverdueBlock_code').inputValue();
            const retriedNoteVal = await page.locator('#f_siRetryOverdueBlock_note').inputValue();
            must(retriedCodeVal === '通知到达晚', `重试弹层理由码应保留旧输入「通知到达晚」，实得「${retriedCodeVal}」`);
            must(retriedNoteVal === 'RELOD 夹具·通知晚到夹具说明', `重试弹层理由说明应保留旧输入，实得「${retriedNoteVal}」`);
            const retryNoteFieldAbsent = (await page.locator('#f_release_note').count()) === 0;
            must(retryNoteFieldAbsent, '本场景上线说明已齐（RELEASE_NOTE_REQUIRED 未命中），重试弹层不应再要求说明');

            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1000);
            const relRow = await dbGet('SELECT status, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.status === '已发布' && relRow.overdue_reason_code === '通知到达晚', `补交（不再剥离）后应发布成功且理由落库为保留值，实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [3e]（C3c·codex 557 合并审 M2① 新增）完整链：逾期普通批次、无说明、无理由——真实并发场景构造，
        //   不用 route 篡改请求体（[3a]/[3b] 已覆盖"单点缺一项"，本用例覆盖"两项依次缺"的完整链条，
        //   须是货真价实的两步暴露，不是伪造出来的）：
        //     二人批次，本人 EXEC_ID 打开详情时 pendingCount=2（isLast=false，前端只渲染"还差 1 人"文案，
        //     不出 note/reason 任何字段，ctx={executor_row_id} 空壳）→ 页面打开后，模拟第二执行人
        //     EXEC2_ID 并发确认完成（直接 SQL 把其行 exec_status 转 done，模拟另一个会话完成的动作，
        //     不刷新本页——前端仍停留在"非最后一人"的旧渲染上）→ 本人点确认：
        //       第①次请求：{executor_row_id} 裸身——服务端此刻 CAS 成功、pendingCount 结算为 0，
        //         rGateSatisfied 触发发布，但 release_note 为空 → 400 RELEASE_NOTE_REQUIRED（整体回滚，
        //         含本人 CAS 一并撤销）
        //       第②次请求（补说明）：{executor_row_id, release_note}——note 校验通过，发布内核成功，
        //         随后逾期判定触发但请求未带理由 → 409 RELEASE_OVERDUE_REASON_REQUIRED
        //         （overdue_reason_required===true，同样整体回滚）
        //       第③次请求（补理由）：{executor_row_id, release_note, overdue_reason_code,
        //         overdue_reason_note}——全齐，200，真正发布成功
        //   用 page.route **纯监听**（不做任何篡改）三次真实请求体，逐次断言 executor_row_id 恒同、
        //   release_note 从第②次起出现、overdue_reason_code/note 仅第③次出现且与第②次的 release_note
        //   值保持一致（说明未在两轮重试之间丢失——ctx 累计语义的行为级证明）。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [3e] 完整链：逾期批次·无说明·无理由 → 400 NOTE_REQUIRED → 补说明 → 409 OVERDUE_REQUIRED → 补理由 → 200 ──');
        {
            const chainRelId = await mkRelease(adminTok, `${TITLE_PREFIX}完整链-${Date.now()}`, { plannedDate: pastDateStr(3) });
            const chainIssueId = await mkIssue(`${TITLE_PREFIX}成员-完整链`);
            await addIssueTo(adminTok, chainRelId, chainIssueId);
            await mkCompleteRoster(chainIssueId, EXEC_ID, '示例开发A');
            await addExecutor(chainRelId, EXEC_ID, '示例开发A');
            await addExecutor(chainRelId, EXEC2_ID, '示例开发B');

            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, chainRelId);

            const capturedBodies = [];
            await page.route('**/api/sys-releases/*/execute', async (route) => {
                if (route.request().method() === 'POST') {
                    capturedBodies.push(JSON.parse(route.request().postData() || '{}'));
                }
                await route.continue();   // 纯监听，不篡改，请求原样打到真实服务端
            });

            // 打开确认弹层——此刻 pendingCount=2（示例开发B仍 pending），isLast=false，前端只渲染"还差 1 人"，
            // 不出 note/reason 字段。
            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            must((await page.locator('#f_release_note').count()) === 0, '打开时 isLast=false，弹层不应渲染上线说明字段');
            must((await page.locator('#siExecOverdueBlock').count()) === 0, '打开时 isLast=false，弹层不应渲染理由块');

            // 模拟示例开发B并发确认完成（另一会话的真实动作，本页不刷新、不重开弹层——前端仍停留在旧渲染）。
            // CHECK 约束要求 done 态必须同时带合法 executed_at（同 addExecutor 里 notified_at 同款纪律）。
            await dbRun(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE release_id=? AND user_id=?`, [chainRelId, EXEC2_ID]);

            // 第①次：裸身提交 → 400 RELEASE_NOTE_REQUIRED（前端捕获后打开重试弹层，只要说明）。
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);
            must((await page.locator('#f_release_note').count()) === 1, '第①次 400 NOTE_REQUIRED 后应展开上线说明输入框');
            must((await page.locator('#siRetryOverdueBlock').count()) === 0, '第①次 400 是 RELEASE_NOTE_REQUIRED（非 overdue_reason_required 的 409），不应带出理由块');

            // 第②次：补说明提交 → note 校验过、发布内核成功、随后逾期判定触发 → 409
            //   RELEASE_OVERDUE_REASON_REQUIRED（整体回滚，含刚成功的发布）。
            await page.fill('#f_release_note', 'RELOD 夹具·完整链上线说明');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);
            must((await page.locator('#siRetryOverdueBlock').count()) === 1, '第②次 409 overdue_reason_required 后应展开理由块');
            must((await page.locator('#f_release_note').count()) === 0, '第②次之后的重试弹层不应再要求说明（RELEASE_NOTE_REQUIRED 已在第②次通过）');

            // 第③次：补理由提交 → 全齐，200，真正发布成功。
            await page.selectOption('#f_siRetryOverdueBlock_code', '业务方要求延后');
            await page.fill('#f_siRetryOverdueBlock_note', 'RELOD 夹具·完整链逾期理由说明');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1200);

            must(capturedBodies.length === 3, `应恰好观测到 3 次 execute 请求，实得 ${capturedBodies.length} 次：${JSON.stringify(capturedBodies)}`);
            if (capturedBodies.length === 3) {
                const [b1, b2, b3] = capturedBodies;
                const rowId = b1.executor_row_id;
                must(!!rowId && b2.executor_row_id === rowId && b3.executor_row_id === rowId, `三次请求 executor_row_id 应恒同，实得 ${JSON.stringify([b1.executor_row_id, b2.executor_row_id, b3.executor_row_id])}`);
                must(b1.release_note === undefined, `第①次请求不应带 release_note，实得 ${JSON.stringify(b1)}`);
                must(b2.release_note === 'RELOD 夹具·完整链上线说明', `第②次请求应带 release_note，实得 ${JSON.stringify(b2)}`);
                must(b2.overdue_reason_code === undefined && b2.overdue_reason_note === undefined, `第②次请求不应带理由字段，实得 ${JSON.stringify(b2)}`);
                must(b3.release_note === 'RELOD 夹具·完整链上线说明', `第③次请求说明不应丢失（与第②次一致），实得 ${JSON.stringify(b3)}`);
                must(b3.overdue_reason_code === '业务方要求延后' && b3.overdue_reason_note === 'RELOD 夹具·完整链逾期理由说明', `第③次请求应带完整理由字段，实得 ${JSON.stringify(b3)}`);
            }

            const relRow = await dbGet('SELECT status, overdue_reason_code, overdue_reason_note, release_note FROM sys_releases WHERE id=?', [chainRelId]);
            must(relRow && relRow.status === '已发布' && relRow.overdue_reason_code === '业务方要求延后' && relRow.release_note === 'RELOD 夹具·完整链上线说明', `完整链最终应发布成功且理由/说明均落库为提交值，实得 ${JSON.stringify(relRow)}`);
            const tlCountRow = await dbGet(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_overdue_reason'`, [chainIssueId]);
            must(tlCountRow && tlCountRow.c === 1, `完整链最终应恰好一条 release_overdue_reason 留痕行（两次回滚不应留下半截痕迹），实得 ${tlCountRow && tlCountRow.c}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [3c]（C3c·codex 557 合并审 M2② 改写）重试期间代次失效 EXECUTOR_NOT_ACTIVE——原版在"首提"就
        //   伪造失效，覆盖不到"统一重试上下文"本身；改为在**补弹阶段**注入：首提缺说明 400
        //   RELEASE_NOTE_REQUIRED（route 剥 release_note，同 [3a] 手法）→ 打开重试弹层补填说明 → 这次
        //   提交时 route 改判 403 EXECUTOR_NOT_ACTIVE → 断言 toast 原文 + 链在此终止（不产生第三次请求，
        //   即不存在"前端自作主张再重试一次"这种未经用户动作的隐性行为）。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [3c] 补弹阶段代次失效 EXECUTOR_NOT_ACTIVE（首提缺说明→补弹时伪造 403）→ toast 报错、链终止 ──');
        {
            const { relId } = await mkOneMemberReadyRelease(adminTok, `代次失效-${Date.now()}`, { plannedDate: null });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);

            let reqCount = 0;
            await page.route('**/api/sys-releases/*/execute', async (route) => {
                if (route.request().method() !== 'POST') { await route.continue(); return; }
                reqCount++;
                if (reqCount === 1) {
                    const body = JSON.parse(route.request().postData() || '{}');
                    delete body.release_note;   // 首提伪造"缺说明"，逼出 400 RELEASE_NOTE_REQUIRED
                    await route.continue({ postData: JSON.stringify(body) });
                } else if (reqCount === 2) {
                    // 补弹阶段（第二次提交）伪造代次失效——真实场景是"补弹这段等待窗口里，别人把你移出了
                    // 执行人"，用响应级 403 模拟，不需要真的操作 sys_release_executors。
                    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '你已不是本批次执行人，或页面已过期请刷新', code: 'EXECUTOR_NOT_ACTIVE' }) });
                } else {
                    await route.continue();
                }
            });

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_release_note', 'RELOD 夹具·代次失效首提说明');
            // [C4h·codex 563-R M2 收口] 同 [3a]：固定等待+字段存在换成响应断言+实例号变化+新弹层 open
            // 三件套联合等待。
            const modalSeqBefore3c = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const respP3c1 = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3c1 = await respP3c1;
            must(resp3c1.status() === 400, `[3c] 首提缺说明应命中 400（RELEASE_NOTE_REQUIRED 是 400 语义，非 409），实得 ${resp3c1.status()}`);
            // [C4i·codex 563-R2 M1 收口] 原来只断了状态码——任何其它也走 400 且恰好也让弹层重开的错误
            // （如格式校验类 400）都能让这条用例蒙混过关，测不出"确实是 RELEASE_NOTE_REQUIRED 这条分支"。
            // 补读响应体，精确断言错误码。
            const resp3c1Body = await resp3c1.json().catch(() => null);
            must(resp3c1Body && resp3c1Body.code === 'RELEASE_NOTE_REQUIRED', `[3c] 首提 400 应确切为 RELEASE_NOTE_REQUIRED，实得 ${JSON.stringify(resp3c1Body)}`);
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore3c, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const retryNoteField = page.locator('#f_release_note');
            await shotOnFail(page, (await retryNoteField.count()) === 1, '3c-retry-note-field', '首提缺说明后应重新展开上线说明输入框（补弹阶段的前提）');

            await page.fill('#f_release_note', 'RELOD 夹具·代次失效补弹说明');
            // 第二次提交（补弹阶段）同样顶到出口层：断真实 403 EXECUTOR_NOT_ACTIVE，不靠固定等待猜"应该
            // 报错了"。
            const respP3c2 = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3c2 = await respP3c2;
            must(resp3c2.status() === 403, `[3c] 补弹阶段应命中伪造的 403，实得 ${resp3c2.status()}`);
            const resp3c2Body = await resp3c2.json().catch(() => null);
            must(resp3c2Body && resp3c2Body.code === 'EXECUTOR_NOT_ACTIVE', `[3c] 403 应确切为 EXECUTOR_NOT_ACTIVE，实得 ${JSON.stringify(resp3c2Body)}`);
            await page.waitForTimeout(300);   // 响应到达后前端仍需一拍处理 DOM（toast/按钮状态）

            const toastText = await lastToastText(page);
            must(toastText.includes('你已不是本批次执行人，或页面已过期请刷新'), `补弹阶段 EXECUTOR_NOT_ACTIVE 应 toast 报错且文案与后端原文一致，实得toast="${toastText}"`);
            const stillOpen = (await page.locator('#siModalOverlay.open').count()) === 1;
            must(stillOpen, 'EXECUTOR_NOT_ACTIVE 属未识别错误码，应走 siApiErr 兜底，弹层应保持打开（非静默关闭）');
            must(reqCount === 2, `链应在补弹这次 403 后终止，不应有第三次自动重试请求，实得请求数=${reqCount}`);
            const relRow = await dbGet('SELECT status FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.status === '计划中', `两次请求均未真正成功，批次应仍「计划中」，实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [3d]（C3c·codex 557 合并审 M2③ 改写）成功响应丢失后幂等重试——原版是未逾期批次、只断言弹层
        //   关闭，覆盖不到"逾期理由是否也被幂等路径正确保留"。改为**逾期批次**：首提就带齐说明+理由 →
        //   route.fetch()+abort() 真实达成服务端成功（含逾期理由落库+留痕）但对客户端隐藏响应 → 二次
        //   点击 → 断言 already===true、sys_releases 两列理由与首提一致（幂等分诊①提早返回，不会重算/
        //   重写）、每个成员恰一条 release_overdue_reason 留痕行（读库计数，非"至少一条"这种弱断言——
        //   若幂等路径不慎二次写入会在这里落红）。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [3d] 逾期批次·成功响应丢失后幂等重试（route.fetch()+abort() 隐藏首次真实成功响应）──');
        {
            const { relId, issueId } = await mkOneMemberReadyRelease(adminTok, `幂等重试逾期-${Date.now()}`, {
                plannedDate: pastDateStr(3), releaseNote: 'RELOD 夹具·幂等重试逾期场景',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, relId);

            let firstCallDone = false;
            await page.route('**/api/sys-releases/*/execute', async (route) => {
                if (!firstCallDone && route.request().method() === 'POST') {
                    firstCallDone = true;
                    await route.fetch();           // 真实达成服务端写入（executor 行转 done、批次发布、逾期理由落库+留痕）
                    await route.abort('failed');   // 但让客户端看到网络失败，无法读到这次的成功响应
                } else {
                    await route.continue();
                }
            });

            const execBtn = page.locator('button:has-text("确认上线完成")');
            await execBtn.first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await shotOnFail(page, (await page.locator('#siExecOverdueBlock').count()) === 1, '3d-predict-block', '预判层应展开理由块（批次逾期∧isLast∧普通）');
            await page.selectOption('#f_siExecOverdueBlock_code', '值班人员变更');
            await page.fill('#f_siExecOverdueBlock_note', 'RELOD 夹具·幂等重试首提理由说明');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1200);

            // 第一次请求已在服务端真实成功（含理由落库+留痕）——校验落库状态，同时前端因 abort 应仍认为
            // "没成功"（弹层未关）。
            const afterFirst = await dbGet('SELECT status, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?', [relId]);
            must(afterFirst && afterFirst.status === '已发布', `route.fetch() 应已让服务端真实发布成功，实得 ${JSON.stringify(afterFirst)}`);
            must(afterFirst && afterFirst.overdue_reason_code === '值班人员变更' && afterFirst.overdue_reason_note === 'RELOD 夹具·幂等重试首提理由说明', `首提理由应已真实落库，实得 ${JSON.stringify(afterFirst)}`);
            const stillOpenAfterAbort = (await page.locator('#siModalOverlay.open').count()) === 1;
            must(stillOpenAfterAbort, '首次响应被 abort 后前端应判定为网络异常，弹层保持打开（未误判为成功而关闭）');

            // 第二次点击（同一 ctx，executor_row_id/理由字段均不变）——这次不再拦截，直达真实服务端：该
            // 行已 done，命中幂等分诊①（preRow 命中 done），200 { already:true, released:true }，早返回
            // 不会重新评估/重写逾期理由。
            // [C4c·codex 558 M3 收口] 原写法 `page.once('response', ...)` 在回调内才按 URL 过滤——注册
            //   之后、目标响应到达之前若先有任何其它无关响应（同页面在途的轮询/静态资源等），`once` 会被
            //   那个无关响应提前消耗掉，目标响应永远等不到监听者，`secondResponseBody` 静默保持 null 且
            //   断言错误地把"没等到"归因成"already 不是 true"。改用 `page.waitForResponse(predicate)`——
            //   在点击**之前**注册、返回一个按 URL+method 精确过滤的 Promise，点击之后 await 它，天然只
            //   匹配目标响应且不会被无关响应抢先消耗；随后显式 `await resp.json()` 读完整个响应体，不靠
            //   固定 `waitForTimeout` 猜测"应该读完了"。
            const respP = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/execute`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp = await respP;
            const secondResponseBody = await resp.json();
            must(resp.status() === 200, `二次点击响应状态码应 200，实得 ${resp.status()}`);
            await page.waitForTimeout(300);   // 响应到达后前端仍需一拍处理 DOM（关弹层），留出时间
            const closedAfterRetry = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(closedAfterRetry, '二次点击命中幂等 200 后弹层应正常关闭');
            must(!!secondResponseBody && secondResponseBody.already === true, `二次点击响应体应 already===true，实得 ${JSON.stringify(secondResponseBody)}`);

            const afterSecond = await dbGet('SELECT status, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?', [relId]);
            must(afterSecond && afterSecond.overdue_reason_code === afterFirst.overdue_reason_code && afterSecond.overdue_reason_note === afterFirst.overdue_reason_note, `幂等重试后 sys_releases 两列理由应与首提一致（未被重算/覆盖），实得 ${JSON.stringify(afterSecond)}`);
            const tlCountRow = await dbGet(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_overdue_reason'`, [issueId]);
            must(tlCountRow && tlCountRow.c === 1, `成员单应恰好一条 release_overdue_reason 留痕行（幂等分诊①早返回不应二次写入），实得 ${tlCountRow && tlCountRow.c}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // [4]（C3b·Opus 预筛 HIGH-1 新增）迟到响应竞态：siReleaseExecuteSubmit 在 `await siApi(...)`
        //   之后直接做 DOM 动作（关弹层/开重试弹层/刷新列表/开批次详情），但 siModal 自身的实例令牌
        //   核对只包在 onConfirm 调用的外层，救不到 onConfirm *内部*这次 await 之后的续体——可达路径：
        //   点确认→请求在途→用户关掉本弹层并打开了另一个弹层→迟到响应回来，续体在"当前已是别的弹层"
        //   的情况下继续关它/顶掉它。本用例：批次 A 的 execute 响应延迟 1.5s，点确认后立即关闭批次 A
        //   的弹层、打开批次 B 的确认弹层（同页不刷新——刷新会连带销毁旧 Promise 续体，不是本用例要测
        //   的"DOM 令牌"竞态，而是另一种"整个 JS 上下文被销毁"的假阳性安全），批次 A 的迟到响应到达
        //   后必须被 siModalInstanceSeq 校验拦下，不能动批次 B 正打开的弹层。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [4] 迟到响应竞态：批次A确认在途→关闭并开批次B确认弹层→批次A迟到响应不得顶掉批次B ──');
        {
            const fixtureA = await mkOneMemberReadyRelease(adminTok, `迟到响应A-${Date.now()}`, {
                plannedDate: null, releaseNote: 'RELOD 夹具·迟到响应A场景',
            });
            const fixtureB = await mkOneMemberReadyRelease(adminTok, `迟到响应B-${Date.now()}`, {
                plannedDate: null, releaseNote: 'RELOD 夹具·迟到响应B场景',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, fixtureA.relId);

            // [C4g·codex 563 M1 收口] 固定 1.5s 延迟不能证明"切到 B 时批次 A 的请求确实还挂起"——延迟
            // 时长与操作耗时都是猜的，机器慢/卡顿都可能让延迟提前结束，届时这条用例其实什么也没测到却
            // 照样报绿。改用显式屏障：route 内 await 一个测试代码持有 resolve 的 Promise，只有测试显式
            // release() 之后请求才会真正放行——由此确定 A 的响应绝对晚于"B 详情/弹层已就绪"这一时刻，
            // 不依赖任何时长猜测。
            let releaseGateA;
            const gateA = new Promise((r) => { releaseGateA = r; });
            // [C4j·codex 563-R3 M 收口] 把"已进入屏障的 route 处理任务"登记到数组——只 release() 后立即
            // page.close() 存在竞态：页面正在卸载时，被拦截的请求可能还没跑完 `route.continue()`（在途
            // 处理器），Playwright 对已关闭页面上的 route.continue() 可能拒绝。此前 `return task;` 把这个
            // 可能拒绝的 Promise 原样交回 Playwright 的路由调用链——finally 里 `Promise.allSettled` 只是
            // "另外拿一份引用去看它落没落定"，并不能替 Playwright 那条调用链把拒绝吞掉；一旦真拒绝，
            // Playwright 内部那次 await 会产生一次独立的未处理拒绝，绕开这里的 fail++ 记录。改法：
            // 异常在任务**内部** try/catch 就地捕获、记入 fail 后**正常 return**（不再向任何调用方——
            // 无论是 Playwright 还是这里的 routeHandlerTasksA——传出一个会拒绝的 Promise），处理器函数
            // 本身也不再把 task 返回给 page.route，只负责登记供 finally 里 await 确认"已经跑完"。
            const routeHandlerTasksA = [];
            await page.route('**/api/sys-releases/*/execute', (route) => {
                const task = (async () => {
                    try {
                        if (route.request().method() === 'POST' && route.request().url().includes(`/sys-releases/${fixtureA.relId}/execute`)) {
                            await gateA;
                        }
                        await route.continue();
                    } catch (routeErr) {
                        fail++;
                        failDetails.push('[4] route 处理器异常：' + (routeErr && routeErr.message));
                        console.error('❌ [4] route 处理器异常：' + (routeErr && routeErr.message));
                    }
                })();
                routeHandlerTasksA.push(task);
            });

            // [C4h·codex 563-R M3① 收口] 从这里到收尾整段包 try/finally——任何一步 must()/await 抛错
            // 都不能让 gateA 永远悬空：route 处理器里 `await gateA` 若无人 release()，会让这条被拦截的
            // 请求永久挂起，进而可能拖住 page.close()（页面卸载时仍有在途 fetch）。finally 里无条件先
            // release() → 等登记的处理任务全部落定 → 再关页，保证屏障与在途处理器都不会泄漏到下一个用例。
            try {
                // 打开批次 A 确认弹层 → 填写 → 点确认（请求已发出，卡在 gateA 未放行）。
                await page.locator('button:has-text("确认上线完成")').first().click();
                await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                const modalInstanceA = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
                const reqAP = page.waitForRequest(r => r.url().includes(`/sys-releases/${fixtureA.relId}/execute`) && r.method() === 'POST');
                await page.locator('#siMConfirm').click();
                await reqAP;   // 确认请求确已发出（不是靠固定等待猜"应该发出了"）

                // 立即关闭批次 A 的弹层（siCloseModal，siModalInstanceSeq 递增）。
                await page.locator('button:has-text("取消")').click();
                await page.waitForTimeout(100);
                must((await page.locator('#siModalOverlay.open').count()) === 0, '批次 A 弹层应已被「取消」关闭');

                // 同页切到批次 B 详情（不刷新页面，siOpenBatchDetail 直接换 #siBatchBody 内容）→ 打开批次 B
                // 的确认弹层（siModal 再次调用，siModalInstanceSeq 再次递增）。
                const openedB = await page.evaluate(async (id) => {
                    if (typeof siOpenBatchDetail !== 'function') return false;
                    await siOpenBatchDetail(id); return true;
                }, fixtureB.relId);
                must(openedB === true, 'siOpenBatchDetail(批次B) 应可调用（同页切换，不刷新）');
                await page.locator('button:has-text("确认上线完成")').first().click();
                await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                const modalInstanceB = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
                const bHeadTextBeforeStale = await page.locator('#siMHead').textContent();

                // B 的详情/弹层此刻已就绪——现在才放行批次 A 的响应，确保 A 的响应绝对晚于 B 就绪这一时刻
                // （屏障保证的顺序关系，非猜时长）；等 A 的响应真正到达，再等 siModal 的 settle 钩子确认
                // A 的 onConfirm 续体已经跑完（`window.__siTestHooks.lastSettledInstance` 是 siModalConfirm
                // 包装层在 onConfirm resolve/reject 后**无条件**写入的，不受"实例是否匹配"的早退分支影响，
                // 精确标志"A 这次确认的全部同步+异步处理已经落定"，比固定等待更可信）。
                const respAP = page.waitForResponse(r => r.url().includes(`/sys-releases/${fixtureA.relId}/execute`) && r.request().method() === 'POST');
                releaseGateA();
                await respAP;
                await page.waitForFunction((instA) => window.__siTestHooks && window.__siTestHooks.lastSettledInstance === instA, modalInstanceA, { timeout: 5000 });

                // 三者均须属于 B：弹层仍 open、弹层内容未被替换、当前详情编号是 B（不是只比标题这一项）。
                const bStillOpen = (await page.locator('#siModalOverlay.open').count()) === 1;
                must(bStillOpen, '批次 A 迟到响应到达并处理完毕后，批次 B 的确认弹层应仍 open（不得被批次 A 的续体关闭）');
                if (bStillOpen) {
                    const bHeadTextAfterStale = await page.locator('#siMHead').textContent();
                    must(bHeadTextAfterStale === bHeadTextBeforeStale, `批次 B 弹层标题内容不应被批次 A 迟到响应替换，前=${JSON.stringify(bHeadTextBeforeStale)} 后=${JSON.stringify(bHeadTextAfterStale)}`);
                }
                const currentModalInstance = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
                must(currentModalInstance === modalInstanceB, `当前弹层实例号应仍是 B 打开时的实例号 ${modalInstanceB}，实得 ${currentModalInstance}（不得被 A 的续体再次递增/顶替）`);
                const detailIdAfterA = await page.evaluate(() => (typeof siBatchDetailRel !== 'undefined' && siBatchDetailRel && siBatchDetailRel.id) || null);
                must(detailIdAfterA === fixtureB.relId, `当前详情编号（siBatchDetailRel.id）应仍是批次 B（${fixtureB.relId}），实得 ${detailIdAfterA}`);
                // 批次 A 本身的服务端请求最终仍应正常完成（本用例只延迟不拦截，请求最终会打到服务端）——
                // 顺带核实"迟到"不等于"丢失"，A 自己该发生的业务事实照常发生，只是不该越权去动 B 的界面。
                const relARow = await dbGet('SELECT status FROM sys_releases WHERE id=?', [fixtureA.relId]);
                must(relARow && relARow.status === '已发布', `批次 A 自身应仍正常发布成功（迟到响应不代表请求失败），实得 ${JSON.stringify(relARow)}`);
            } finally {
                // [C4i·M2] 顺序：release() 放行卡住的请求 → 等登记的处理任务全部落定（成功/失败都算落定，
                // 不再是"关页时还有在途 route 处理器"这种未定义状态）→ 处理器异常计入失败 → 才关页。
                try { releaseGateA(); } catch (_) { /* 已释放或未及初始化，忽略 */ }
                const settledA = await Promise.allSettled(routeHandlerTasksA);
                for (const s of settledA) {
                    if (s.status === 'rejected') {
                        fail++;
                        failDetails.push('[4] route 处理器异常（execute 拦截器）：' + (s.reason && s.reason.message || s.reason));
                        console.error('❌ [4] route 处理器异常：' + (s.reason && s.reason.message || s.reason));
                    }
                }
                await page.close().catch(() => {});
            }
        }

        // ═══════════════════════════════════════════════════════════
        // [5]（C3c·codex 557 合并审 M1 新增）成功分支第二个 await 之后的迟到续体：[4] 只护住了
        //   `await siApi(...)` 这一个 await（siModalInstanceSeq 核对），557 原话"预筛只护了第一个
        //   await"——成功分支后面还有 `await siLoadList()`，这段等待期间用户完全可以切到批次 B 详情，
        //   续体此时若仍无条件 `siOpenBatchDetail(releaseId)`（批次 A），会把用户正看着的批次 B 顶掉。
        //   本用例延迟的是 `/api/sys-issues` 列表端点（siLoadList 唯一调用的接口），不碰 execute 本身，
        //   构造出"execute 已经真实成功、只是 siLoadList 这一步还没回来"的窗口期。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── [5] siLoadList 迟到续体：execute 成功→立即切到批次B详情→迟到响应到达后不得把详情顶回批次A ──');
        {
            const fixtureA5 = await mkOneMemberReadyRelease(adminTok, `M1迟到A-${Date.now()}`, {
                plannedDate: null, releaseNote: 'RELOD 夹具·M1迟到A场景',
            });
            const fixtureB5 = await mkOneMemberReadyRelease(adminTok, `M1迟到B-${Date.now()}`, {
                plannedDate: null, releaseNote: 'RELOD 夹具·M1迟到B场景',
            });
            const page = await loginPage(browser, execTok);
            await openBatchDetail(page, fixtureA5.relId);

            // [C4g·codex 563 M1 收口] 同 [4]：固定 1.5s 延迟换成显式屏障，不猜时长。
            let releaseGateLoad;
            const gateLoad = new Promise((r) => { releaseGateLoad = r; });
            // [C4j·codex 563-R3 M 收口] 同 [4]：登记在途 route 处理任务，异常在任务内部就地捕获记入
            // fail 后正常 return（不再把可能拒绝的 Promise 交回 Playwright），finally 里等它们全部落定
            // 再关页。
            const routeHandlerTasksLoad = [];
            await page.route('**/api/sys-issues*', (route) => {
                const task = (async () => {
                    try {
                        const url = route.request().url();
                        if (route.request().method() === 'GET' && /\/api\/sys-issues(\?|$)/.test(url)) {
                            await gateLoad;
                        }
                        await route.continue();
                    } catch (routeErr) {
                        fail++;
                        failDetails.push('[5] route 处理器异常：' + (routeErr && routeErr.message));
                        console.error('❌ [5] route 处理器异常：' + (routeErr && routeErr.message));
                    }
                })();
                routeHandlerTasksLoad.push(task);
            });

            // [C4h·codex 563-R M3① 收口] 同 [4]：整段包 try/finally，任何断言/await 抛错都不能让
            // gateLoad 悬空拖住后续用例或 page.close()。
            try {
                await page.locator('button:has-text("确认上线完成")').first().click();
                await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                const modalInstanceA5 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
                const reqLoadP = page.waitForRequest(r => /\/api\/sys-issues(\?|$)/.test(r.url()) && r.method() === 'GET');
                await page.locator('#siMConfirm').click();
                // execute 本身未被延迟——很快成功并 siCloseModal()，随后卡在被拦截的 siLoadList() 里。
                await page.waitForSelector('#siModalOverlay.open', { state: 'hidden', timeout: 5000 });
                await reqLoadP;   // 确认 siLoadList 的请求确已发出、正卡在屏障里（不是靠固定等待猜）

                // 立即切到批次 B 详情（同页不刷新，siAuditGen 递增）。
                const openedB = await page.evaluate(async (id) => {
                    if (typeof siOpenBatchDetail !== 'function') return false;
                    await siOpenBatchDetail(id); return true;
                }, fixtureB5.relId);
                must(openedB === true, 'siOpenBatchDetail(批次B) 应可调用（同页切换，不刷新）');
                const detailIdRightAfterSwitch = await page.evaluate(() => (typeof siBatchDetailRel !== 'undefined' && siBatchDetailRel && siBatchDetailRel.id) || null);
                must(detailIdRightAfterSwitch === fixtureB5.relId, `切换后当前详情应是批次 B，实得 ${detailIdRightAfterSwitch}`);
                const modalInstanceAfterSwitch5 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));

                // B 详情已就绪——现在才放行 siLoadList 响应，确保它绝对晚于 B 就绪这一时刻；等响应真正到达，
                // 再等 siModal 的 settle 钩子确认 A 的 onConfirm 续体（execute 成功分支）已经跑完
                // （lastSettledInstance 是 siModalConfirm 包装层无条件写入的，覆盖"siLoadList 之后可能还有
                // 一次 siOpenBatchDetail(A)"这整条链是否已经落定）。
                const respLoadP = page.waitForResponse(r => /\/api\/sys-issues(\?|$)/.test(r.url()) && r.request().method() === 'GET');
                releaseGateLoad();
                await respLoadP;
                await page.waitForFunction((instA) => window.__siTestHooks && window.__siTestHooks.lastSettledInstance === instA, modalInstanceA5, { timeout: 5000 });

                const detailIdAfterStale = await page.evaluate(() => (typeof siBatchDetailRel !== 'undefined' && siBatchDetailRel && siBatchDetailRel.id) || null);
                must(detailIdAfterStale === fixtureB5.relId, `迟到的 siLoadList 响应到达并处理完毕后，当前详情应仍是批次 B（不得被批次 A 的续体顶回），实得 ${detailIdAfterStale}`);
                const modalInstanceAfterStale5 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
                must(modalInstanceAfterStale5 === modalInstanceAfterSwitch5, `弹层实例号不应被批次 A 的续体再次变动，切换后=${modalInstanceAfterSwitch5}，续体落定后=${modalInstanceAfterStale5}`);
            } finally {
                try { releaseGateLoad(); } catch (_) { /* 已释放或未及初始化，忽略 */ }
                const settledLoad = await Promise.allSettled(routeHandlerTasksLoad);
                for (const s of settledLoad) {
                    if (s.status === 'rejected') {
                        fail++;
                        failDetails.push('[5] route 处理器异常（sys-issues 拦截器）：' + (s.reason && s.reason.message || s.reason));
                        console.error('❌ [5] route 处理器异常：' + (s.reason && s.reason.message || s.reason));
                    }
                }
                await page.close().catch(() => {});
            }
        }

    } catch (e) {
        console.error('❌ 测试执行异常：' + (e && e.stack || e));
        fail++;
        failDetails.push('测试执行异常：' + (e && e.message || e));
    }
    } catch (outerErr) {
        // [C4h·M1] 覆盖"历史夹具创建失败/浏览器启动失败"这类发生在内层 try 之外的异常——不让它们
        // 绕过下面 finally 里的库清理。
        console.error('❌ 外层异常（历史夹具/浏览器启动阶段）：' + (outerErr && outerErr.stack || outerErr));
        fail++;
        failDetails.push('外层异常（历史夹具/浏览器启动阶段）：' + (outerErr && outerErr.message || outerErr));
    } finally {
        // [C4h·M1] 浏览器关闭失败单独记录并继续——不能让 close() 抛错跳过后面的库清理。
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {
                fail++;
                failDetails.push('浏览器关闭异常（不影响后续库清理继续执行）：' + (closeErr && closeErr.message));
                console.error('❌ 浏览器关闭异常：' + (closeErr && closeErr.message));
            }
        }
        // [C3c·codex 557 合并审 M3 收口] 夹具清理（同族三个既有文件的既有纪律）——按 RELOD- 前缀删净
        // 本文件写入的全部批次/成员单及其子表行，避免跨轮残留污染生产库共享面（尤其
        // sys_release_executors 的 pending/done 行可能被其它模块的"我的上线单"聚合查询算进角标）。
        // 清理异常与"删完后仍有残留"此前只 warn 不计入失败——那等于允许本文件悄悄泄漏测试数据到共享
        // 生产库却仍报绿。改为：清理异常记入 fail（非零退出），清理后逐表精确按本轮夹具的 id 集合
        // SELECT 残留行数，非 0 同样计入失败（不信"删语句跑完了"就等于"删干净了"，删语句本身可能因
        // FK/锁/静默失败漏删部分行）。
        // [C4g·codex 563 H1 收口] 本轮集合直接取 createdReleaseIds/createdIssueIds（创建成功当刻登记，
        // 文件顶部定义）——不再按 TITLE_PREFIX 现查一遍：现查会把"本轮之外"同前缀的既有/历史记录一起
        // 当成本轮夹具删掉，不是精确清单（feedback_shared_dir_test_cleanup_precise_list）。
        let rels = createdReleaseIds.slice();
        let issues = createdIssueIds.slice();
        try {
            for (const rid of rels) {
                await dbRun('DELETE FROM sys_release_executors WHERE release_id=?', [rid]);
                await dbRun('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?', [rid]);
            }
            for (const iid of issues) {
                await dbRun('DELETE FROM sys_issue_timeline WHERE issue_id=?', [iid]);
                await dbRun('DELETE FROM sys_issue_dev_assignees WHERE issue_id=?', [iid]);
                await dbRun('UPDATE sys_issues SET release_id=NULL WHERE id=?', [iid]);
            }
            for (const iid of issues) await dbRun('DELETE FROM sys_issues WHERE id=?', [iid]);
            for (const rid of rels) await dbRun('DELETE FROM sys_releases WHERE id=?', [rid]);
            console.log(`\n🧹 夹具已清理：releases=${rels.length} issues=${issues.length}`);
        } catch (cleanupErr) {
            fail++;
            failDetails.push('夹具清理异常（非零退出，非仅 warn）：' + (cleanupErr && cleanupErr.message));
            console.error('❌ 夹具清理异常：' + (cleanupErr && cleanupErr.message));
        }
        // 残留核验：按本轮实际造过的 id 集合精确查（而非再按前缀模糊查——rels/issues 此刻已从
        // sys_releases/sys_issues 里删掉，title 前缀查询会天然查不到，必须落到子表 + 原始 id 列表上）。
        try {
            const relPlaceholders = rels.length ? rels.map(() => '?').join(',') : null;
            const issuePlaceholders = issues.length ? issues.map(() => '?').join(',') : null;
            const residual = {};
            residual.sys_releases = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_releases WHERE id IN (${relPlaceholders})`, rels)).c : 0;
            residual.sys_issues = issues.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${issuePlaceholders})`, issues)).c : 0;
            residual.sys_release_executors = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_release_executors WHERE release_id IN (${relPlaceholders})`, rels)).c : 0;
            residual.sys_issue_timeline = issues.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id IN (${issuePlaceholders})`, issues)).c : 0;
            // [C4g·codex 563 M4 收口] 原残留核验只查四表，漏了本文件清理逻辑里明明有删的两张表——
            // 删除范围与核验范围必须一致，否则这两张表即便真漏删也不会被本核验发现。
            residual.sys_issue_release_commit_snapshots = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issue_release_commit_snapshots WHERE release_id IN (${relPlaceholders})`, rels)).c : 0;
            residual.sys_issue_dev_assignees = issues.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id IN (${issuePlaceholders})`, issues)).c : 0;
            const residualTotal = Object.values(residual).reduce((a, b) => a + b, 0);
            if (residualTotal !== 0) {
                fail++;
                failDetails.push(`夹具清理后仍有残留（应恰为 0）：${JSON.stringify(residual)}`);
                console.error(`❌ 夹具清理后残留核验未通过：${JSON.stringify(residual)}`);
            } else {
                console.log(`🧹 残留核验通过：${JSON.stringify(residual)}（均为 0）`);
            }
        } catch (residualErr) {
            fail++;
            failDetails.push('残留核验查询本身异常：' + (residualErr && residualErr.message));
            console.error('❌ 残留核验查询异常：' + (residualErr && residualErr.message));
        }
        // [C4h·codex 563-R M1 收口] 历史记录必须在清理之后仍然存在（保留性断言）；断言做完后本文件自己
        // 精确删除它——不再用空 catch 吞掉删除失败（那等于允许历史夹具真的删不掉时悄悄留在共享库里却
        // 全程不报错），删除失败计入失败，删除成功后再查一次确认零残留（不信"DELETE 语句跑完了"就等于
        // "真的删掉了"）。
        for (const hid of historicalIds) {
            try {
                const historicalRow = await dbGet('SELECT id FROM sys_releases WHERE id=?', [hid]);
                if (!historicalRow) {
                    fail++;
                    failDetails.push(`H1 变异证据：预先植入的历史记录（id=${hid}）在本轮清理后消失——清理很可能又退回了按 TITLE_PREFIX 扫全表的旧写法`);
                    console.error(`❌ H1 变异证据：历史记录 id=${hid} 被误删`);
                } else {
                    console.log(`🧹 H1 变异证据通过：历史记录 id=${hid} 未被本轮清理误删（精确清单生效）`);
                }
            } catch (historicalErr) {
                fail++;
                failDetails.push('H1 变异证据查询异常：' + (historicalErr && historicalErr.message));
            }
            try {
                await dbRun('DELETE FROM sys_releases WHERE id=?', [hid]);
                const afterDelete = await dbGet('SELECT id FROM sys_releases WHERE id=?', [hid]);
                if (afterDelete) {
                    fail++;
                    failDetails.push(`历史夹具（id=${hid}）自身收尾删除后仍有残留`);
                    console.error(`❌ 历史夹具 id=${hid} 删除后仍存在`);
                }
            } catch (delErr) {
                fail++;
                failDetails.push(`历史夹具（id=${hid}）收尾删除失败：` + (delErr && delErr.message));
                console.error(`❌ 历史夹具 id=${hid} 收尾删除失败：` + (delErr && delErr.message));
            }
        }
        db.close();
    }

    console.log(`\n═══ 结果：${pass} 通过，${fail} 失败 ═══`);
    if (fail > 0) {
        console.log('失败详情：');
        failDetails.forEach(m => console.log('  - ' + m));
        process.exit(1);
    }
})();
