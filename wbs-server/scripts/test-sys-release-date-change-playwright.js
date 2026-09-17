/**
 * 上线逾期留痕（方案 20260910 v1.2）·C4 B 块前端 Playwright 活体验证——改期弹层反应式理由块
 * 用法：外部 server:3000 已起（本文件不自拉服务，见下方"server 编排"约定）后：
 *   node scripts/test-sys-release-date-change-playwright.js
 *
 * ⚠️ 一次只跑一个写 db 的 Playwright——本文件直连 task_pool.db 造夹具（同 test-sys-release-mgmt-
 *   playwright.js/test-sys-release-overdue-playwright.js 既有同族范式：外部 server:3000 + 真实
 *   task_pool.db + 标题前缀隔离，非独立端口+db 副本）。
 *
 * 数据隔离：全部造数标题恒 RELDC- 前缀（共享面隔离约定，与 RELMG-/RELOD-/其它前缀区分）。
 *
 * 前端契约（siReleaseUpdatePlannedDateModal/Impl，Sys_Iteration.html）：理由块**反应式**展开——
 *   仅当用户真的把日期输入框改到与原值不同（dirty）且原值已过期才展开，不是"批次逾期就恒展开"（那样
 *   会让「打开→直接确认」这个本该零摩擦的 no-op 操作被逼着瞎填一段理由，与服务端"同值 no-op 不受理由
 *   闸影响"的契约意图相悖——C0 核查报告 ③ 头号回归用例）。
 *   [C4e·codex 560 M1] 预判层（首开，forceReason=false）只做视觉展开+格式校验，**不阻断提交**——浏览器
 *   时钟可能领先服务端，误判逾期时若客户端硬拦会逼用户填一段服务端根本不需要的理由，剥夺服务端做权威
 *   判定的机会（方案 §5.1.5"预判层=体验、权威层=正确，不能只靠前端"）。只有补弹阶段（forceReason=true，
 *   已是服务端 400 确认过的真实逾期）且仍 dirty 时才严格必填。
 *
 * 覆盖（任务书 Playwright 验证节逐条）：
 *   ① 打开逾期批次改期弹层 → 改动日期 → 理由块展开 → 填新日期+理由 → 200 → 时间线摘要含"原计划日
 *      已过 N 天，原因"
 *   ② 打开逾期批次直接确认（不碰日期输入框，同值）→ 理由块不展开 → 200 no-op，无新 timeline 行
 *   ③（C4e·codex 560 M1·改回真实路径）改动日期、理由留空直接提交（预判层不阻断）→ 请求真的打到
 *      服务端 → 真实 400 → 补弹保留新日期 → 补填理由 → 再次确认 → 200
 *   ④ 逾期后清空日期（dirty） → 理由块展开 → 填理由 → 200，摘要含"→ 未设定"
 *   ⑤ 未逾期批次改期（即使改动日期）→ 理由块不展开 → 200
 *   ⑥ 打开时未逾期（理由块从未渲染）→ 改动日期后 page.route 把响应伪造成 400 REQUIRED（模拟跨零点
 *      服务端已判定过期）→ 前端从"未展开"进"展开"（补弹静态展开）且保留新日期 → 闭环填理由提交 → 200
 *      → 时间线摘要含原因（rec1 收口）
 *   ⑦（C4c·codex 558 M1，C4e·560 M1 改回真实路径）逾期批次改日期、理由留空直接提交（预判层不阻断）→
 *      真实 400 补弹 → 改回原日期、理由留空 → 200 changed=false、无新 timeline 行（补弹路径的同值豁免
 *      须与首开同一判据，不是"forceReason=true 就恒必填"）
 *   ⑧（C4e·codex 560 M1 新增）预判层判逾期但服务端不判：`page.addInitScript` 把浏览器 Date 拨快 1 天
 *      + planned_date=今天（真实服务端口径同日不算逾期）→ 预判层仍误判展开理由块（视觉提示） → 理由
 *      留空直接提交 → 200（服务端按真实时钟判定不逾期，不因前端误判而被拦）
 *
 * 断言纪律：先想"实现坏成什么样这条会红"；断言对象写明（DOM hidden 属性/输入值、库值 summary/
 *   payload_json、timeline 行数）。
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
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-release-date-change-playwright-shots');
const TITLE_PREFIX = 'RELDC-';

const ADMIN_ID = 1;

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
        const p = path.join(SCREENSHOT_DIR, `reldc-fail-${name}.png`);
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
// 服务端"这一真实存在的场景（跨零点/系统时钟没校准），供覆盖"预判层判逾期但服务端权威判定不逾期"
// 这条方案 §5.1.5 明文的分支：0 参构造与 `Date.now()` 走偏移分支（页面 JS 认为的"现在"），带参构造
// （`new Date(y,m,d)` 这类按分量构造）保持原生语义不叠加偏移——否则"从已偏移的 now 里取出年月日再构造"
// 会被二次偏移，语义就错了。addInitScript 在该 page 每次导航的新文档执行任何页面脚本之前运行，覆盖
// login.html 与随后跳转的 Sys_Iteration.html 全程生效。
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
function futureDateStr(daysAhead) { return pastDateStr(-daysAhead); }
// [C4b·L7] 日历日整日差——与后端 releaseOverdueCalendarDayDiff 同一算法（UTC ms 构造避 DST），供断言
// 摘要"原计划日已过 N 天"时**现算**期望值，而非写死构造时刻的 daysAgo 常量（构造夹具与断言执行之间
// 若恰好跨零点，写死值会与服务端现算值差 1，误判真实实现为失败）。
function calendarDayDiff(laterDayStr, earlierDayStr) {
    const toUtcMs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((toUtcMs(laterDayStr) - toUtcMs(earlierDayStr)) / 86400000);
}

// [C4g·codex 563 H1 收口] 精确清单：本轮夹具的批次/成员 id 在创建成功的那一刻立即登记，finally 清理
// 与残留核验只认这份清单，不再按标题前缀在结束时"扫一遍全表"——按前缀扫会把同前缀的**历史**记录（上一轮
// 跑残留的/被后续手工改过标题但仍中招前缀的）一并删掉，属于 [[feedback_shared_dir_test_cleanup_precise_list]]
// 明文点名的反模式（"精确清单"不是"过滤条件足够精确"，是"物理上只登记本轮真造出来的 id"）。
const createdReleaseIds = [];
const createdIssueIds = [];
// [S4c·⑬ 局部清理面·主会话 2026-09-17 裁定] sys_issue_dev_assignees 不在既有五表清单内——/estimate 的
// 鉴权 assertDevMember（index.js:3435-3444）硬依赖该表存在一条在册行，与 sys_issues.assigned_to 无关；
// 该表 FK 未启用级联（全仓未开 PRAGMA foreign_keys=ON，server.js:1533/:12216），故本组自建自删自核：
// 记下本组唯一一行的 id + 所属 issue_id，finally 里先于外层五表清理执行 DELETE + 局部残留核验。
let devAssigneeId13 = null;
let devAssigneeIssueId13 = null;
// ── 夹具 helper（同 test-sys-release-overdue-playwright.js 同款范式）────────────────────────────
async function mkRelease(adminTok, title, extra = {}) {
    const r = await fetchJson('/api/sys-releases', adminTok, { method: 'POST', body: { title } });
    if (r.status !== 201) throw new Error(`建批次失败 ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    createdReleaseIds.push(id);
    if (extra.plannedDate !== undefined) await dbRun('UPDATE sys_releases SET planned_date=? WHERE id=?', [extra.plannedDate, id]);
    return id;
}
async function mkIssue(title) {
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
async function mkOneMemberRelease(adminTok, titleSuffix, plannedDate) {
    const relId = await mkRelease(adminTok, `${TITLE_PREFIX}${titleSuffix}`, { plannedDate });
    const issueId = await mkIssue(`${TITLE_PREFIX}成员-${titleSuffix}`);
    await addIssueTo(adminTok, relId, issueId);
    return relId;
}
async function openBatchDetail(page, relId) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${relId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
}
async function dateChangeTimeline(relId) {
    return dbAll(`SELECT summary, payload_json FROM sys_issue_timeline WHERE ref_id = ? AND action_code = 'release_date_change' ORDER BY id`, [relId]);
}

(async () => {
    console.log('═══ 上线逾期留痕 C4·B 块（改期弹层反应式理由块）Playwright 活体验证 ═══\n');
    try {
        await ensureServerListening();
        await ensureAppReadinessEndpoint();
    } catch (e) {
        console.error('❌ server 编排前置探测失败：' + e.message);
        process.exit(1);
    }

    const adminTok = await signAs(ADMIN_ID);
    // [C4h·codex 563-R M1 收口] 外层 try/finally 从"首次创建夹具之前"就开始包裹——历史夹具本身就是一次
    // 真实写库动作，旧写法把它放在受保护 try **之前**：若它之后、进入内层 try 之前发生任何异常（含
    // chromium.launch 失败），整段都不会进清理分支，历史夹具会永久遗留在共享库里。`browser` 声明为
    // 可空变量：launch 失败时它仍是 null，finally 里对它的 close 调用需要判空跳过，不能让"没有浏览器
    // 可关"变成一次新异常，把后面的库清理又带崩。
    const historicalIds = [];
    let browser = null;
    try {
        // [C4g·codex 563 H1 变异证据] 预先植入一条"历史"同前缀记录——先走真实建批次端点保证 schema 合法
        // （release_no 等自动生成字段不用手抄），再把它从 createdReleaseIds 里摘除，模拟"不属于本轮精确
        // 清单、但恰好命中同一个标题前缀"的既有数据（如上一轮异常退出遗留 / 其它并行进程的同前缀夹具）。
        // 本轮结束后必须仍然存在——若清理退回按前缀扫全表，这条会被一起删掉。
        const historicalReleaseId = await mkRelease(adminTok, `${TITLE_PREFIX}历史遗留记录-不属于本轮`);
        const historicalIdx = createdReleaseIds.indexOf(historicalReleaseId);
        if (historicalIdx >= 0) createdReleaseIds.splice(historicalIdx, 1);
        historicalIds.push(historicalReleaseId);

        browser = await chromium.launch({ headless: true });
    try {
        // ═══════════════════════════════════════════════════════════
        // ① 打开逾期批次改期弹层 → 改动日期 → 理由块展开 → 填新日期+理由 → 200 → 摘要含"原计划日已过 N 天，原因"
        // ═══════════════════════════════════════════════════════════
        console.log('── ① 逾期批次·改动日期：理由块反应式展开 → 提交成功 → 摘要含逾期天数与原因 ──');
        {
            const oldDate = pastDateStr(3);
            const relId = await mkOneMemberRelease(adminTok, `逾期改期-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonHiddenAtOpen = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAtOpen === true, '① 打开时（未改动日期）理由块应 hidden（反应式，未 dirty 不展开）');

            const newDate = futureDateStr(3);
            await page.fill('#f_planned_date', newDate);
            await page.waitForTimeout(150);
            const reasonHiddenAfterChange = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAfterChange === false, '① 改动日期后理由块应展开（hidden=false）');

            await page.fill('#f_reason', 'RELDC 夹具·业务方要求延后');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1000);

            const relRow = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.planned_date === newDate, `① 提交成功，planned_date 应更新为 ${newDate}，实得 ${JSON.stringify(relRow)}`);
            const tl = await dateChangeTimeline(relId);
            must(tl.length === 1, `① timeline 恰 1 条，实得 ${tl.length}`);
            if (tl.length) {
                const expectDays = calendarDayDiff(pastDateStr(0), oldDate);   // 断言前现算，不写死构造时刻的 3
                must(new RegExp(`原计划日已过 ${expectDays} 天，原因：RELDC 夹具·业务方要求延后`).test(tl[0].summary), `① 摘要含"原计划日已过 ${expectDays} 天，原因：..."，实得 ${tl[0].summary}`);
            }
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ② 打开逾期批次直接确认（不碰日期输入框，同值）→ 理由块不展开 → 200 no-op，无新 timeline 行
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ② 逾期批次·直接确认（同值）：理由块不展开 → 200 no-op，无新 timeline 行 ──');
        {
            const oldDate = pastDateStr(4);
            const relId = await mkOneMemberRelease(adminTok, `逾期同值-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonHidden = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHidden === true, '② 未改动日期，理由块应 hidden');

            // [C4g·codex 563 M3 收口] 原写法只检"弹层关了/日期没变/零留痕"——若前端压根没发请求就直接
            // 关弹层（比如 onConfirm 被改成同值时提前 return true 而不调 siApi），这三条断言照样全过，
            // 测不出"请求真的到达服务端并被服务端判定为 no-op"这件事。改为点击前注册
            // waitForResponse，断该批次 update-planned-date 的响应真的到达且 200 changed===false，
            // 再等界面处理完、查库核对。
            const respP2 = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/update-planned-date`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp2 = await respP2;
            const resp2Body = await resp2.json().catch(() => null);
            must(resp2.status() === 200, `② 同值确认应到达服务端且 200，实得 ${resp2.status()} ${JSON.stringify(resp2Body)}`);
            must(resp2Body && resp2Body.changed === false, `② 响应体应 changed===false，实得 ${JSON.stringify(resp2Body)}`);
            await page.waitForTimeout(300);   // 响应到达后前端仍需一拍处理 DOM（关弹层）

            const modalClosed = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed, '② 同值确认应正常关闭弹层（未被理由闸拦下）');
            const relRow = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.planned_date === oldDate, '② planned_date 未变');
            const tl = await dateChangeTimeline(relId);
            must(tl.length === 0, `② 无新 timeline 行（no-op），实得 ${tl.length}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ③（C4e·codex 560 M1 收口·改回真实路径）改动日期、理由留空直接提交（预判层不阻断）→ 请求真的
        //    打到服务端 → 服务端权威判定逾期 → 真实 400 → 补弹保留新日期（理由为空，非借 route 伪造保留
        //    的假值）→ 补填理由 → 再次确认 → 200
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ③ 改动日期+理由留空直接提交（预判层不阻断）→ 真实 400 → 补弹保留新日期 → 补填理由 → 200 ──');
        {
            const oldDate = pastDateStr(2);
            const relId = await mkOneMemberRelease(adminTok, `真实路径400-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const newDate = futureDateStr(2);
            await page.fill('#f_planned_date', newDate);
            await page.waitForTimeout(150);
            const reasonVisibleBeforeSubmit3 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden === false);
            must(reasonVisibleBeforeSubmit3, '③ 改动日期后理由块应展开（预判层视觉提示，仍不阻断提交）');
            // 理由留空——[M1] 预判层不再客户端拦截，点击应真的发出请求，真的打到服务端。
            // [C4g·codex 563 M2 收口] 拿到 400 响应不代表页面已经处理完它——若旧弹层本身就显示同一批次
            // 的日期且理由块本就可见（预判层展开），"补弹已打开"这两条判据可能在**旧实例**上原样为真，
            // 测不出补弹是否真的重开。改为：点击前记 siModalInstanceSeq，收到目标批次的 400 后
            // waitForFunction 等实例号真的变化（siCloseModal+siModal 各自 +1），确认已经是新弹层实例，
            // 再去检 DOM。
            const modalSeqBefore3 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const respP3 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3 = await respP3;
            must(resp3.status() === 400, `③ 理由留空直接提交应命中服务端真实 400，实得 ${resp3.status()}`);
            const resp3Body = await resp3.json();
            must(resp3Body && resp3Body.code === 'RELEASE_DATE_CHANGE_REASON_REQUIRED', `③ 400 应确切为 RELEASE_DATE_CHANGE_REASON_REQUIRED，实得 ${JSON.stringify(resp3Body)}`);
            // [C4h·codex 563-R rec 收口] "实例号变化"与"新弹层已 open"合并成联合等待条件——实例号先自增
            // 不代表 DOM 已经渲染完，两个都等到才去读字段更稳。
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore3, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            // 400 RELEASE_DATE_CHANGE_REASON_REQUIRED 后应重开弹层（静态展开，保留新日期；理由本就是空的，
            // 不是借 route 伪造保留下来的假值）。
            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, '3-retry-open', '③ 400 后应重新展开弹层');
            const retriedDateVal = await page.locator('#f_planned_date').inputValue();
            must(retriedDateVal === newDate, `③ 补弹应保留已选新日期 ${newDate}，实得 ${retriedDateVal}`);
            const retryReasonHidden = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(retryReasonHidden === false, '③ 补弹理由块应静态展开（可见）');

            await page.fill('#f_reason', 'RELDC 夹具·补弹后填理由');
            const respP3b = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/update-planned-date`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp3b = await respP3b;
            must(resp3b.status() === 200, `③ 补填理由后再次确认应到达服务端且 200，实得 ${resp3b.status()}`);
            await page.waitForTimeout(300);
            const relRow = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.planned_date === newDate, `③ 补填理由后再次确认应提交成功，实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ④ 逾期后清空日期（dirty）→ 理由块展开 → 填理由 → 200，摘要含"→ 未设定"
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ④ 逾期后清空日期：理由块展开 → 200，摘要含"→ 未设定" ──');
        {
            const oldDate = pastDateStr(1);
            const relId = await mkOneMemberRelease(adminTok, `逾期清空-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.fill('#f_planned_date', '');
            await page.waitForTimeout(150);
            const reasonHidden = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHidden === false, '④ 清空日期（dirty）应展开理由块');
            await page.fill('#f_reason', 'RELDC 夹具·清空原因');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);

            const relRow = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.planned_date === null, '④ planned_date 已清空');
            const tl = await dateChangeTimeline(relId);
            must(tl.length === 1 && /未设定/.test(tl[0].summary), `④ 摘要含"→ 未设定"，实得 ${tl.length ? tl[0].summary : '(无)'}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑤ 未逾期批次改期（改动日期）→ 理由块不展开 → 200
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑤ 未逾期批次·改动日期：理由块不展开 → 200 ──');
        {
            const oldDate = futureDateStr(5);
            const relId = await mkOneMemberRelease(adminTok, `未逾期改期-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonFieldAbsentOrHidden = (await page.locator('#f_reason').count()) === 0;
            must(reasonFieldAbsentOrHidden, '⑤ 未逾期批次不应渲染理由字段（reasonEligible=false）');

            const newDate = futureDateStr(8);
            await page.fill('#f_planned_date', newDate);
            await page.waitForTimeout(150);
            const stillAbsent = (await page.locator('#f_reason').count()) === 0;
            must(stillAbsent, '⑤ 改动日期后理由字段仍不应出现（未逾期不问理由）');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(800);
            const relRow = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow && relRow.planned_date === newDate, `⑤ 提交成功，实得 ${JSON.stringify(relRow)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑥ 打开时未逾期（理由块从未渲染）→ 改动日期后 route 伪造 400 REQUIRED（模拟跨零点）→
        //    前端从"未展开"进"展开"（补弹静态展开）保留新日期
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑥ 打开时未逾期 → route 伪造 400 REQUIRED（模拟跨零点）→ 补弹从未展开进展开，保留新日期 ──');
        {
            // 用今天作为 planned_date：前端 siDateOnly 同日不算逾期（reasonEligible=false，无理由字段）；
            // 服务端侧用 route 伪造响应模拟"跨零点后判定过期"，不依赖真实系统时钟推进。
            const todayDate = pastDateStr(0);
            const relId = await mkOneMemberRelease(adminTok, `跨零点模拟-${Date.now()}`, todayDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonAbsentAtOpen = (await page.locator('#f_reason').count()) === 0;
            must(reasonAbsentAtOpen, '⑥ 打开时（同日不算逾期）理由字段不应存在');

            const newDate = futureDateStr(1);
            await page.fill('#f_planned_date', newDate);

            await page.route('**/api/sys-releases/*/update-planned-date', async (route) => {
                if (route.request().method() === 'POST') {
                    await route.fulfill({
                        status: 400, contentType: 'application/json',
                        body: JSON.stringify({
                            error: '原计划上线日已逾期，改期须填写理由', code: 'RELEASE_DATE_CHANGE_REASON_REQUIRED',
                            date_change_reason_required: true, planned_date_old: todayDate, overdue_days: 1,
                        }),
                    });
                } else {
                    await route.continue();
                }
            });
            // [C4g·codex 563 M2 收口] 同 ③/⑨：固定等待换成状态等待——等 siModalInstanceSeq 真的变化。
            const modalSeqBefore6 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const respP6 = page.waitForResponse(r => r.url().includes(`/sys-releases/${relId}/update-planned-date`) && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            await respP6;
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore6, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, '6-retry-open', '⑥ 400 后应重新展开弹层');
            const retriedDateVal = await page.locator('#f_planned_date').inputValue();
            must(retriedDateVal === newDate, `⑥ 补弹应保留用户已选新日期 ${newDate}，实得 ${retriedDateVal}`);
            const reasonNowPresent = (await page.locator('#f_reason').count()) === 1;
            must(reasonNowPresent, '⑥ 补弹后理由字段应出现（从"未展开"进"展开"）');
            if (reasonNowPresent) {
                const reasonHidden = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
                must(reasonHidden === false, '⑥ 补弹理由块应可见（静态展开）');
            }
            // [C4c·rec1] 闭环：不只测到"理由字段出现"，继续填理由 → 提交 → 200 → 时间线摘要含原因。
            //   此处 route 拦截已在上面注册且未设 once/一次性开关，仍会命中第二次 POST——但第二次请求体
            //   带了 reason，伪造的固定 400 响应体不校验请求内容照样返回 400，会导致本次提交假性再撞 400
            //   死循环。改为先撤销拦截（unroute），让第二次提交打到真实后端（此时前端判据已同 M1 收口为
            //   `reasonEligible && dirty`，真实旧值 todayDate 未逾期，第二次提交理论上不会再触发理由闸——
            //   但这条闭环用例的目的是验证"补弹展开后正常走完提交流程"，不是复测服务端逾期判定，故撤销
            //   拦截让请求走真实端点最贴近用户实际操作）。
            // ⚠️ todayDate（今天）在真实服务端并不逾期（同日不算），撤销拦截后若原样提交，服务端的理由闸
            //   条件 `oldInfo.dayStr < todayStr` 不成立，会静默忽略客户端带的 reason（不校验/不落库/摘要
            //   不含原因）——这不是 bug，是"跨零点只是前端错判、服务端权威判定才是真相"的正确行为，但会让
            //   本闭环断言"摘要含原因"必然落空。为让闭环场景在服务端也"确已跨零点"，直接把 planned_date
            //   往前拨 1 天（模拟"这段时间里零点确已过去"）——之后服务端重新 SELECT 读到的就是真实过期值，
            //   理由闸按其权威判定真实生效，闭环断言才有意义（不是绕过判定，是让模拟场景在服务端也成立）。
            await dbRun('UPDATE sys_releases SET planned_date=? WHERE id=?', [pastDateStr(1), relId]);
            await page.unroute('**/api/sys-releases/*/update-planned-date');
            await page.fill('#f_reason', 'RELDC 夹具·跨零点补弹闭环理由');
            await page.locator('#siMConfirm').click();
            await page.waitForTimeout(1000);
            const modalClosed6 = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed6, '⑥ 闭环：填理由提交后弹层应正常关闭（200 成功）');
            const relRow6 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow6 && relRow6.planned_date === newDate, `⑥ 闭环：planned_date 应更新为 ${newDate}，实得 ${JSON.stringify(relRow6)}`);
            const tl6 = await dateChangeTimeline(relId);
            must(tl6.length === 1 && /RELDC 夹具·跨零点补弹闭环理由/.test(tl6[0].summary), `⑥ 闭环：时间线摘要含理由原文，实得 ${tl6.length ? tl6[0].summary : '(无)'}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑦（C4c·codex 558 M1 收口）逾期批次首次改日期缺理由 → 400 补弹 → 改回原日期、理由留空 →
        //    提交 → 200 changed=false、无新 timeline 行（补弹路径的同值豁免必须与首开同一判据）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑦ 逾期批次改日期缺理由 → 400 补弹 → 改回原日期留空理由 → 200 changed=false、无新 timeline ──');
        {
            const oldDate = pastDateStr(3);
            const relId = await mkOneMemberRelease(adminTok, `补弹改回原值-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const newDate = futureDateStr(2);
            await page.fill('#f_planned_date', newDate);
            await page.waitForTimeout(150);
            const reasonVisibleAfterChange = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden === false);
            must(reasonVisibleAfterChange, '⑦ 改动日期后理由块应展开');

            // [C4e·codex 560 M1 收口·改回真实路径] 预判层不再客户端阻断提交——理由留空直接点确认，请求
            // 真的打到服务端，服务端权威判定真逾期返回真实 400，前端据此重开补弹（forceReason=true）。
            // 不再需要 ③ 组旧写法里那套"填一个理由绕过客户端拦截、再用 route 剥掉"的迂回手法。
            // [C4d·codex 559 M1 收口] 顶到出口层：点击前注册 `page.waitForResponse` 精确匹配
            // update-planned-date 的 POST，点击后 await 它，显式断言状态码与错误码；随后等
            // siModalInstanceSeq 真的变化（siCloseModal+siModal 各自自增一次，弹层确已被"关旧开新"替换成
            // 补弹实例）才继续操作 DOM，不靠"应该差不多处理完了"的固定等待猜测时序。
            const modalSeqBeforeFirstSubmit = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const firstRespP = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const firstResp = await firstRespP;
            must(firstResp.status() === 400, `⑦ 理由留空直接提交应命中服务端真实 400，实得 ${firstResp.status()}`);
            const firstRespBody = await firstResp.json();
            must(firstRespBody && firstRespBody.code === 'RELEASE_DATE_CHANGE_REASON_REQUIRED', `⑦ 首提 400 应确切为 RELEASE_DATE_CHANGE_REASON_REQUIRED，实得 ${JSON.stringify(firstRespBody)}`);
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBeforeFirstSubmit, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, '7-retry-open', '⑦ 缺理由 400 后应重新展开弹层');
            const reasonHiddenAfterRetryOpen = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAfterRetryOpen === false, '⑦ 补弹（forceReason）打开时应展开理由块（此刻日期仍是刚提交的 dirty 值）');

            // [M1 核心断言] 补弹（forceReason=true）后把日期改回 original + 理由留空——理由块应收起，且
            // 提交不应再要求理由（同值豁免在补弹路径同样贯彻，不是"forceReason=true 就恒必填"）。首提本就
            // 没填过理由（真实路径，非借 route 剥离制造假值），此处显式确认字段仍为空，再改日期。
            await page.fill('#f_reason', '');   // 显式确认留空（此刻仍可见），再改日期——改完会被反应式监听器隐藏，隐藏元素 fill() 会因"不可见"超时
            await page.fill('#f_planned_date', oldDate);
            await page.waitForTimeout(150);
            const reasonHiddenAfterRevert = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAfterRevert === true, '⑦ 改回原日期后理由块应收起（反应式监听在补弹路径同样生效）');

            const tlBefore7 = await dateChangeTimeline(relId);
            // [C4d·M1] 第二次提交同样顶到出口层：精确匹配这次 POST 的响应，断状态码与 changed 字段，
            // 不靠固定等待猜测"应该处理完了"。
            const secondRespP = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const secondResp = await secondRespP;
            must(secondResp.status() === 200, `⑦ 改回原值留空理由再提交应 200，实得 ${secondResp.status()}`);
            const secondRespBody = await secondResp.json();
            must(secondRespBody && secondRespBody.changed === false, `⑦ 二次提交响应体应 changed===false，实得 ${JSON.stringify(secondRespBody)}`);
            await page.waitForTimeout(300);   // 响应到达后前端仍需一拍处理 DOM（关弹层），留出时间
            const modalClosed7 = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed7, '⑦ 改回原值+理由留空提交应成功关闭弹层（同值 no-op，不应被理由闸拦下）');
            const relRow7 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow7 && relRow7.planned_date === oldDate, `⑦ planned_date 未变（仍为 ${oldDate}），实得 ${JSON.stringify(relRow7)}`);
            const tlAfter7 = await dateChangeTimeline(relId);
            must(tlAfter7.length === tlBefore7.length, `⑦ 无新 timeline 行（changed=false no-op），实得 ${tlBefore7.length}→${tlAfter7.length}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑧（C4e·codex 560 M1）预判层判逾期但服务端不判：浏览器时钟领先服务端 1 天 + planned_date=今天
        //    （真实服务端口径同日不算逾期）→ 预判层仍把它误判为"已逾期"、展开理由块（视觉提示不撤）→
        //    理由留空直接提交 → 服务端按真实时钟判定不逾期 → 200（不阻断，方案 §5.1.5"预判层=体验、
        //    权威层=正确，不能只靠前端"）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑧ 预判层判逾期但服务端不判（浏览器时钟领先 1 天）：理由留空直接提交 → 200 ──');
        {
            const todayDate = pastDateStr(0);
            const relId = await mkOneMemberRelease(adminTok, `预判逾期服务端不判-${Date.now()}`, todayDate);
            const page = await loginPageWithFakedDate(browser, adminTok, 1);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const newDate8 = futureDateStr(3);
            await page.fill('#f_planned_date', newDate8);
            await page.waitForTimeout(150);
            const reasonVisible8 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden === false);
            must(reasonVisible8, '⑧ 预判层（浏览器时钟领先）应把今天误判为已逾期，展开理由块（视觉提示）');

            const respP8 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp8 = await respP8;
            const resp8Body = await resp8.json().catch(() => null);
            must(resp8.status() === 200, `⑧ 理由留空提交应 200（预判层不阻断，服务端按真实时钟判定同日不算逾期），实得 ${resp8.status()} ${JSON.stringify(resp8Body)}`);
            must(resp8Body && resp8Body.changed === true, `⑧ changed 应为 true，实得 ${JSON.stringify(resp8Body)}`);
            await page.waitForTimeout(300);
            const modalClosed8 = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed8, '⑧ 提交成功后弹层应正常关闭');
            const relRow8 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow8 && relRow8.planned_date === newDate8, `⑧ planned_date 应更新为 ${newDate8}，实得 ${JSON.stringify(relRow8)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑨（C4e·codex 560 M2 收口）补弹分支的 dirty 判据基准须用响应携带的 planned_date_old，不能继续
        //    沿用首开时快照的 original——首开 → 他人并发把计划日改成过期日 → 提交首开时看到的日期（对
        //    服务端而言这现在是一次真实变更）→ 400 → 补弹 → 理由块仍应展开（基准已更新为服务端真实旧值，
        //    不会把"首开日期"误判成"和基准同值"）→ 填理由 → 200，摘要含"前天 → 首开日期"
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑨ 补弹并发基准更新：首开日期在提交前被他人改成前天 → 400 → 补弹理由块仍展开（基准=服务端旧值）→ 200 ──');
        {
            const firstOpenDate = futureDateStr(5);   // 首开时看到的日期——预判层判不逾期，不展开理由块
            const relId = await mkOneMemberRelease(adminTok, `并发改期基准-${Date.now()}`, firstOpenDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const reasonAbsentAtOpen9 = (await page.locator('#f_reason').count()) === 0;
            must(reasonAbsentAtOpen9, '⑨ 首开（未逾期）不应渲染理由字段');

            // 并发：他人（或另一会话）直接把该批次计划日改成"前天"（模拟服务端真实值已变，前端毫不知情）。
            const concurrentDate = pastDateStr(2);
            await dbRun('UPDATE sys_releases SET planned_date=? WHERE id=?', [concurrentDate, relId]);

            // 用户不碰日期输入框（仍是首开预填的 firstOpenDate），直接点确认——对前端而言这是"同值"，
            // 但对服务端而言 rel.planned_date 已经是 concurrentDate，与提交值不同 ⇒ 真实变更 ⇒ 命中理由闸。
            // [C4g·codex 563 M2 收口] 同 ③：拿到 400 响应不能立刻断言补弹字段——补弹渲染可能还没跑完，
            // 断言就在"旧弹层"或"半渲染的新弹层"上读到巧合正确的值。改为等 siModalInstanceSeq 真的变化。
            const modalSeqBefore9 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const respP9 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp9 = await respP9;
            must(resp9.status() === 400, `⑨ 首提（服务端已并发变更）应命中 400，实得 ${resp9.status()}`);
            const resp9Body = await resp9.json();
            must(resp9Body && resp9Body.code === 'RELEASE_DATE_CHANGE_REASON_REQUIRED' && resp9Body.planned_date_old === concurrentDate,
                `⑨ 400 应确切为 RELEASE_DATE_CHANGE_REASON_REQUIRED 且 planned_date_old 应为并发后的真实旧值 ${concurrentDate}，实得 ${JSON.stringify(resp9Body)}`);
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore9, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });

            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, '9-retry-open', '⑨ 400 后应重新展开弹层');
            const dateValAfterRetry9 = await page.locator('#f_planned_date').inputValue();
            must(dateValAfterRetry9 === firstOpenDate, `⑨ 补弹应保留用户提交的首开日期 ${firstOpenDate}，实得 ${dateValAfterRetry9}`);
            // [M2 核心断言] 补弹理由块应展开——若基准仍误用首开时的 original（=firstOpenDate），dirty 会
            // 被算成 false（当前输入值 firstOpenDate === 旧 original firstOpenDate），理由块被错误收起。
            const reasonHiddenAfterRetry9 = await page.locator('#f_reason').evaluate(el => {
                const g = el.closest('.u-form-group');
                return g ? g.hidden : null;
            });
            must(reasonHiddenAfterRetry9 === false, '⑨ 补弹理由块应展开（基准已更新为服务端返回的 planned_date_old，当前值≠新基准 ⇒ dirty=true）');

            await page.fill('#f_reason', 'M2 夹具·并发改期后补理由');
            const respP9b = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp9b = await respP9b;
            must(resp9b.status() === 200, `⑨ 补填理由后再次提交应 200，实得 ${resp9b.status()}`);
            await page.waitForTimeout(300);
            const relRow9 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow9 && relRow9.planned_date === firstOpenDate, `⑨ planned_date 应更新为首开日期 ${firstOpenDate}，实得 ${JSON.stringify(relRow9)}`);
            const tl9 = await dateChangeTimeline(relId);
            must(tl9.length === 1 && tl9[0].summary.includes(`${concurrentDate} → ${firstOpenDate}`),
                `⑨ 摘要应含"${concurrentDate} → ${firstOpenDate}"（旧值=服务端并发后的真实值，非首开时前端以为的旧值），实得 ${tl9.length ? tl9[0].summary : '(无)'}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑩（C4f·codex 560-R M1 收口·首开路径）改日期（dirty，展开理由块）→ 填 250 字超长理由 → 改回
        //    基准日期（dirty=false，理由块隐藏，用户看不到那段超长文本）→ 提交 → 不该被"隐藏字段里的
        //    陈旧输入"挡住：请求应真的到达服务端，200 changed===false（同值 no-op）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑩ 首开：改日期填超长理由→改回基准（理由块隐藏）→ 提交应到达服务端且 200 changed=false ──');
        {
            const oldDate = pastDateStr(3);
            const relId = await mkOneMemberRelease(adminTok, `隐藏字段陈旧输入-首开-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const newDate10 = futureDateStr(2);
            await page.fill('#f_planned_date', newDate10);
            await page.waitForTimeout(150);
            const reasonVisibleAfterChange10 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden === false);
            must(reasonVisibleAfterChange10, '⑩ 改动日期后理由块应展开');
            await page.fill('#f_reason', '测'.repeat(250));   // 超过 SI_RELEASE_DATE_CHANGE_REASON_MAX(200)

            // 改回基准日期——理由块应收起（用户此刻看不到那段超长文本），但 DOM 里 #f_reason 的 value 仍是
            // 那 250 字（fill 不会因为字段变 hidden 就自动清空）。
            await page.fill('#f_planned_date', oldDate);
            await page.waitForTimeout(150);
            const reasonHiddenAfterRevert10 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAfterRevert10 === true, '⑩ 改回基准日期后理由块应收起');
            const reasonValStillThere10 = await page.locator('#f_reason').inputValue();
            must(reasonValStillThere10.length === 250, `⑩ 前置确认：隐藏后 DOM 里仍留着 250 字陈旧输入（未被自动清空），实得长度 ${reasonValStillThere10.length}`);

            // [M1 核心断言] 点击前注册 waitForResponse——旧实现会在 onConfirm 内部因超长校验 return false，
            // 请求根本不会发出，这里会等到超时；修复后请求应真的到达服务端并拿到同值 no-op 的 200。
            const respP10 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const resp10 = await respP10;
            const resp10Body = await resp10.json().catch(() => null);
            must(resp10.status() === 200, `⑩ 提交应到达服务端且 200，实得 ${resp10.status()} ${JSON.stringify(resp10Body)}`);
            must(resp10Body && resp10Body.changed === false, `⑩ changed 应为 false（同值 no-op，隐藏字段里的陈旧超长理由不该被读取/提交），实得 ${JSON.stringify(resp10Body)}`);
            await page.waitForTimeout(300);
            const modalClosed10 = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed10, '⑩ 提交成功后弹层应正常关闭');
            const relRow10 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow10 && relRow10.planned_date === oldDate, `⑩ planned_date 应未变（仍为 ${oldDate}），实得 ${JSON.stringify(relRow10)}`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════
        // ⑪（C4f·codex 560-R M1 收口·补弹路径）首提改日期（理由留空，真实 400）→ 补弹（forceReason=true）
        //    → 填 250 字超长理由 → 改回基准日期（M2 已更新的 planned_date_old，理由块隐藏）→ 提交 → 应
        //    到达服务端且 200 changed===false，补弹路径同样不受隐藏字段里的陈旧输入阻断
        // ═══════════════════════════════════════════════════════════
        console.log('\n── ⑪ 补弹：改日期缺理由→400 补弹→填超长理由→改回基准（理由块隐藏）→ 提交应到达服务端且 200 changed=false ──');
        {
            const oldDate = pastDateStr(3);
            const relId = await mkOneMemberRelease(adminTok, `隐藏字段陈旧输入-补弹-${Date.now()}`, oldDate);
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, relId);

            await page.locator('button:has-text("改期")').first().click();
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const newDate11 = futureDateStr(2);
            await page.fill('#f_planned_date', newDate11);
            await page.waitForTimeout(150);

            // 理由留空直接提交（预判层不阻断）→ 服务端真实 400 → 补弹（forceReason=true）。
            const modalSeqBefore11 = await page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
            const firstRespP11 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const firstResp11 = await firstRespP11;
            must(firstResp11.status() === 400, `⑪ 首提理由留空应命中真实 400，实得 ${firstResp11.status()}`);
            await page.waitForFunction((seq) => siModalInstanceSeq !== seq, modalSeqBefore11, { timeout: 5000 });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, '11-retry-open', '⑪ 400 后应重新展开弹层');

            const reasonVisibleAtRetry11 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden === false);
            must(reasonVisibleAtRetry11, '⑪ 补弹打开时理由块应展开（prefill=newDate11 ≠ 基准 oldDate，dirty=true）');
            await page.fill('#f_reason', '测'.repeat(250));

            // 改回基准日期（M2 已把补弹基准更新为服务端返回的 planned_date_old，本场景等同 oldDate）——
            // 理由块应收起，DOM 里 250 字陈旧输入仍留着。
            await page.fill('#f_planned_date', oldDate);
            await page.waitForTimeout(150);
            const reasonHiddenAfterRevert11 = await page.locator('#f_reason').evaluate(el => el.closest('.u-form-group').hidden);
            must(reasonHiddenAfterRevert11 === true, '⑪ 改回基准日期后理由块应收起');
            const reasonValStillThere11 = await page.locator('#f_reason').inputValue();
            must(reasonValStillThere11.length === 250, `⑪ 前置确认：隐藏后 DOM 里仍留着 250 字陈旧输入，实得长度 ${reasonValStillThere11.length}`);

            const secondRespP11 = page.waitForResponse(r => r.url().includes('/update-planned-date') && r.request().method() === 'POST');
            await page.locator('#siMConfirm').click();
            const secondResp11 = await secondRespP11;
            const secondResp11Body = await secondResp11.json().catch(() => null);
            must(secondResp11.status() === 200, `⑪ 补弹路径提交应到达服务端且 200，实得 ${secondResp11.status()} ${JSON.stringify(secondResp11Body)}`);
            must(secondResp11Body && secondResp11Body.changed === false, `⑪ changed 应为 false，实得 ${JSON.stringify(secondResp11Body)}`);
            await page.waitForTimeout(300);
            const modalClosed11 = (await page.locator('#siModalOverlay.open').count()) === 0;
            must(modalClosed11, '⑪ 提交成功后弹层应正常关闭');
            const relRow11 = await dbGet('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
            must(relRow11 && relRow11.planned_date === oldDate, `⑪ planned_date 应未变（仍为 ${oldDate}），实得 ${JSON.stringify(relRow11)}`);
            await page.close();
        }

        // ── ⑫ [#67 C6·2026-09-16] 改期行的**展开区 DOM 实证**（本组是 #67 在浏览器层的唯一落点）──
        //   为什么加在本文件而不新建脚本：本文件已有一套**经过 H1 变异自证的精确清理清单**
        //   （createdReleaseIds/createdIssueIds + 逐表残留核验），而 #67 要验的改期行正是本文件的
        //   夹具天然会产生的。新建脚本要把清理面重新实现一遍，那正是
        //   feedback_shared_dir_test_cleanup_precise_list 警告的"半个清理"高发处。
        //   方案 C6 指定的脚本就是本文件。
        //   ⚠️ 与 S2 守卫的分工：守卫是**隔离装配直调真实 siRenderTimeline**（证明渲染函数本身对
        //   各种数据形态都对），本组证明的是**真实页面把真实 payload 喂进了那个函数**——两层都要。
        {
            console.log('\n── ⑫ [#67 C6] 改期行展开区 DOM：✎ 徽章 + 变更对象头行 + 计划上线日期 旧→新 ──');
            const oldDate12 = pastDateStr(3);
            const newDate12 = futureDateStr(6);
            const relId12 = await mkRelease(adminTok, `${TITLE_PREFIX}C6展开区`, { plannedDate: oldDate12 });
            const issueId12 = await mkIssue(`${TITLE_PREFIX}成员-C6展开区`);
            await addIssueTo(adminTok, relId12, issueId12);
            // 走真实端点改期（带理由，因旧值已过期）——UI 路径由 ①③ 覆盖，本组专注渲染
            const r12 = await fetchJson(`/api/sys-releases/${relId12}/update-planned-date`, adminTok,
                { method: 'POST', body: { planned_date: newDate12, reason: 'C6 展开区 DOM 实证' } });
            must(r12.status === 200, `⑫ 前置：改期应 200，实得 ${r12.status} ${JSON.stringify(r12.body)}`);
            const relNo12 = (await dbGet('SELECT release_no FROM sys_releases WHERE id=?', [relId12]) || {}).release_no;
            const tl12 = await dateChangeTimeline(relId12);
            must(tl12.length === 1, `⑫ 前置：应恰 1 条 release_date_change，实得 ${tl12.length}`);
            const p12 = JSON.parse(tl12[0].payload_json || 'null');
            must(p12 && Array.isArray(p12.changes) && p12.changes.length === 1,
                `⑫ 前置：#67 B1 应已写 changes（库层），实得 ${JSON.stringify(p12 && p12.changes)}`);

            const page12 = await loginPage(browser, adminTok);
            await page12.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId12}`);
            await page12.waitForLoadState('networkidle');
            await page12.waitForTimeout(500);

            // 按**写点保证的 summary 文本**定位改期行——不用徽章文本：S2 起徽章被无条件覆盖为
            //   「✎ 变更留痕」，拿旧文案「上线单改期」定位会得到 0 条（c2b2 的同款回归已一并修正）。
            const DC12 = '上线计划日期变更：';
            const rowInfo12 = await page12.$$eval('.si-tl-item', (els, key) => els
                .filter((e) => e.textContent.includes(key))
                .map((e) => {
                    const evt = e.querySelector('.si-tl-evt');
                    const det = e.querySelector('details.si-tl-release-json');
                    const head = e.querySelector('.si-tl-change-head');
                    const rows = [...e.querySelectorAll('.si-tl-change-row')].map((r) => ({
                        field: (r.querySelector('.si-tl-change-field') || {}).textContent || null,
                        old: (r.querySelector('.si-tl-change-old .si-tl-change-val') || {}).textContent || null,
                        neu: (r.querySelector('.si-tl-change-new .si-tl-change-val') || {}).textContent || null,
                    }));
                    return {
                        evtLabel: evt ? evt.textContent.trim() : null,
                        evtCls: evt ? evt.className : null,
                        hasDetails: !!det,
                        detailsOpen: det ? det.open : null,
                        summaryText: det && det.querySelector('summary') ? det.querySelector('summary').textContent.trim() : null,
                        headText: head ? head.textContent.trim() : null,
                        rows,
                        rowText: e.textContent.replace(/\s+/g, ' ').trim(),
                        note: e.textContent.includes('修改明细不可用') || e.textContent.includes('历史记录，未保存修改明细'),
                    };
                }), DC12);
            await shotOnFail(page12, rowInfo12.length === 1, 'c6-row-present',
                `⑫ 页面时间线应恰有 1 条改期行（按 summary 定位），实得 ${rowInfo12.length} —— 为 0 则下面全是空转`);
            const row12 = rowInfo12[0] || {};
            await shotOnFail(page12, row12.evtLabel === '✎ 变更留痕', 'c6-badge',
                `⑫ 改期行徽章应被覆盖为「✎ 变更留痕」（#67 A5 进 changes 分支），实得「${row12.evtLabel}」`);
            await shotOnFail(page12, /si-tl-rose/.test(String(row12.evtCls)), 'c6-badge-cls',
                `⑫ 徽章类应含 si-tl-rose（玫红，不与 release_published 的绿撞色），实得「${row12.evtCls}」`);
            await shotOnFail(page12, row12.hasDetails === true, 'c6-details-present',
                '⑫ 改期行应出现「查看改动」折叠（#67 B1 写了 changes ⇒ 前端 §6.2 分支 1 展开）');
            await shotOnFail(page12, row12.detailsOpen === false, 'c6-details-closed',
                '⑫ 折叠默认收起（与既有 release_published 折叠一致，不抢占版面）');
            await shotOnFail(page12, /查看改动（1 项）/.test(String(row12.summaryText)), 'c6-details-summary',
                `⑫ 折叠摘要应为「查看改动（1 项）」，实得「${row12.summaryText}」`);
            await shotOnFail(page12, row12.note === false, 'c6-no-note',
                '⑫ 正常展开时不得出现「修改明细不可用」/「历史记录，未保存修改明细」任何一句');
            // 头行（A8）：改期码拼批次号
            // [578-M3] 批次号要**精确等于本次夹具的批次**——原写法 `批次 #\d+` 匹配任意数字，
            //   头行挂错批次发现不了。
            // ⚠️ **按实现的真相断，不按建议的字面断**：codex 578-M3 说「头行批次号应与实际 release_no
            //   精确对应」，但核到实现（Sys_Iteration.html A8）拼的是 **`ref_id` = 批次内部数字 id**，
            //   不是 `release_no`（业务编号）。首版照建议写成比对 release_no，实测红出了这个差异：
            //   头行显「批次 #1464」而 summary 显「批次 R-20260916-13」。
            // ⚠️ **同时登记一处既有不一致**（非本批引入、交审查裁定）：同一条时间线行里，
            //   summary 用**业务编号** `release_no`、展开区头行用**内部 id** —— 用户会看到两个不同的
            //   "批次号"。这是 v1.172.0 就有的口径（`release_info_edit` 那支同样拼内部 id，
            //   见 :4611），A8 只是沿用既有模式，方案 A8 也是这么写的。
            await shotOnFail(page12, String(row12.headText || '').includes(`变更对象：上线批次（批次 #${relId12}）`), 'c6-head-object',
                `⑫ 展开区头行应落 A8 的改期分支且批次号**精确等于本批次 id** #${relId12}（A8 拼 ref_id，非 release_no=${relNo12}），实得「${row12.headText}」`);
            // [578-R risks2 / 578-R2 L1] 这两条要分开：库里的 summary 文本 **和** 页面那一行的 DOM 文本。
            //   ⚠️ **声明范围**（578-R2 L1 又收窄了一次）：`textContent` **包含隐藏后代的文本** ⇒ 它只能
            //   证明「**匹配事件行的 DOM 文本包含业务编号**」，**不能**证明编号"实际显示"给用户看到。
            //   要证明那个，得定位摘要的实际显示节点再查可见性——本组不做，故措辞收到 DOM 文本层面。
            //   ⭐ 另记一条 codex 578-R2 对我的**纠正**：我原先在材料里把这条断言的价值**评低了**
            //   （说它「定位成功即意味着 summary 已渲染，故近乎恒真」）——**不对**：定位用的前缀
            //   「上线计划日期变更：」与业务编号是**两个不同条件**，「保留前缀但遗漏/改错编号」
            //   能通过定位却被本条捕获 ⇒ 独立判别力**高于**我原来的论证。已为此跑了针对性变异
            //   （只删 summary 里的批次号段、保留前缀）：定位器照样成功，本条与库层那条**各红一次**。
            await shotOnFail(page12, tl12[0].summary.includes(`批次 ${relNo12}`), 'c6-summary-relno-db',
                `⑫ 库层对照：summary 用的是**业务编号** ${relNo12}，实得「${tl12[0].summary}」`);
            await shotOnFail(page12, String(row12.rowText || '').includes(`批次 ${relNo12}`), 'c6-summary-relno-dom',
                `⑫ **DOM 文本层**对照：该事件行的 DOM 文本里应含业务编号「批次 ${relNo12}」（与头行的内部 id 在 DOM 文本层面并存——**不等于**已证明用户看见），实得「${String(row12.rowText || '').slice(0, 120)}」`);
            await shotOnFail(page12, /变更字段：计划上线日期（1 项）/.test(String(row12.headText)), 'c6-head-fields',
                `⑫ 头行字段清单应是 A2 的中文名「计划上线日期」，实得「${row12.headText}」`);
            // 明细行**逐单元格**核对（不在整页 text 里 includes——summary 里就有这两个日期，
            //   整页 includes 会恒真，这是 codex 577-R 在守卫侧抓过的同一个假绿形态）
            await shotOnFail(page12, row12.rows && row12.rows.length === 1, 'c6-rows-count',
                `⑫ 展开区应恰 1 行明细，实得 ${row12.rows && row12.rows.length}`);
            const cell12 = (row12.rows || [])[0] || {};
            await shotOnFail(page12, cell12.field === '计划上线日期', 'c6-cell-field',
                `⑫ 明细行字段名应是「计划上线日期」，实得「${cell12.field}」`);
            await shotOnFail(page12, cell12.old === oldDate12, 'c6-cell-old',
                `⑫ 「修改前」单元格应是旧日期 ${oldDate12}，实得「${cell12.old}」`);
            await shotOnFail(page12, cell12.neu === newDate12, 'c6-cell-new',
                `⑫ 「修改后」单元格应是新日期 ${newDate12}，实得「${cell12.neu}」`);
            // 与库层同源：DOM 显示的两个值必须等于 payload.changes[0] 里的两个值
            await shotOnFail(page12, cell12.old === p12.changes[0].old && cell12.neu === p12.changes[0].new, 'c6-dom-db-same',
                `⑫ DOM 显示值应与库里 payload.changes[0] **逐值相等**（写端→读端同源），DOM=${JSON.stringify([cell12.old, cell12.neu])} DB=${JSON.stringify([p12.changes[0].old, p12.changes[0].new])}`);
            // ── [578-M3] **真的点开折叠**再验一遍 ──
            //   上面所有明细断言读的是 textContent，而 `<details>` **收起时 textContent 依然可读**
            //   ⇒ 展开交互失效、明细被样式永久隐藏、或「修改前/修改后」标题缺失，那些断言照样全过
            //   （codex 578-M3 指出，成立）。这里点开 summary，断 open 翻转 + 单元格**实际可见** +
            //   两个标题在位。
            await page12.click(`.si-tl-item:has-text("${DC12}") details.si-tl-release-json summary`);
            await page12.waitForTimeout(250);
            const opened12 = await page12.$$eval('.si-tl-item', (els, key) => {
                const row = els.find((e) => e.textContent.includes(key));
                if (!row) return null;
                const det = row.querySelector('details.si-tl-release-json');
                const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
                const cell = row.querySelector('.si-tl-change-row');
                return {
                    open: det ? det.open : null,
                    rowVisible: vis(cell),
                    fieldVisible: vis(row.querySelector('.si-tl-change-field')),
                    oldVisible: vis(row.querySelector('.si-tl-change-old .si-tl-change-val')),
                    newVisible: vis(row.querySelector('.si-tl-change-new .si-tl-change-val')),
                    tags: [...row.querySelectorAll('.si-tl-change-tag')].map((t) => t.textContent.trim()),
                };
            }, DC12);
            await shotOnFail(page12, opened12 && opened12.open === true, 'c6-opened',
                `⑫ 点击「查看改动」后 details.open 应翻为 true，实得 ${JSON.stringify(opened12 && opened12.open)}`);
            // ⚠️ [578-R L] 措辞收窄：本条查的是**常见隐藏与布局**（display / visibility / 有布局矩形），
            //   **不等于**"像素层面可读"——`opacity:0`、裁剪、父级 overflow 裁切、零字号、被遮挡都可能漏过。
            //   不为穷举这些假设加检查，但声明范围要准（codex 578-R L）。
            await shotOnFail(page12, opened12 && opened12.rowVisible && opened12.fieldVisible && opened12.oldVisible && opened12.newVisible, 'c6-cells-visible',
                `⑫ 展开后明细行与三个单元格应通过**常见隐藏与布局可见性检查**（display/visibility/有布局矩形；不含 opacity/裁剪/遮挡），实得 ${JSON.stringify(opened12)}`);
            await shotOnFail(page12, opened12 && opened12.tags.length === 2 && opened12.tags[0] === '修改前' && opened12.tags[1] === '修改后', 'c6-cell-tags',
                `⑫ 两个单元格标题应按序为「修改前」「修改后」，实得 ${JSON.stringify(opened12 && opened12.tags)}`);

            // A3/A4 语义：改期行不带可隐藏 class（S1 的核心语义，这里在真实页面再证一次）
            const dcHidable12 = await page12.$$eval('.si-tl-item.si-tl-release-scope', (els, key) => els.filter((e) => e.textContent.includes(key)).length, DC12);
            await shotOnFail(page12, dcHidable12 === 0, 'c6-not-hidable',
                `⑫ 改期行**不带** si-tl-release-scope（#67 A3：改期是对外承诺变更、不属批次编排），实得 ${dcHidable12} 条带了`);
            // ── [578-risks1] **勾选过滤器后改期行仍可见** ──
            //   这条本该由 c2b2 的 G3 覆盖，但那段因 `:553` 夹具债（排班 2032 撞 F1 闸）跑不到
            //   ⇒ 在**能跑**的本文件把它关掉。只断「带 class 的行全被藏」不足以证明改期没被藏
            //   （改期行已不带该 class、天然不在那个选择器里），必须**正面**断它仍可见。
            const hasToggle12 = await page12.locator('label:has-text("隐藏批次编排记录")').count();
            await shotOnFail(page12, hasToggle12 > 0, 'c6-toggle-present',
                '⑫ 时间线区应出现「隐藏批次编排记录」过滤开关（本单确有 release_add 事件）');
            const scopeBefore12 = await page12.locator('.si-tl-release-scope').count();
            await shotOnFail(page12, scopeBefore12 > 0, 'c6-scope-rows-present',
                `⑫ 前置：应存在至少 1 条可隐藏的批次编排记录，实得 ${scopeBefore12} —— 为 0 则下面的过滤断言是空转`);
            // ── [579-R3 rec3] 勾选**之前**先断初始态：复选框未勾选 ∧ 编排行全部可见 ──
            //   这样本组走的是完整的**关闭 → 开启 → 关闭**三态：否则若复选框初始就是勾选的，
            //   后面的 `uncheck` 才是第一次状态变化，而"勾选生效"那半其实没验到。
            // ⚠️ [S4e 修正] `sampleAfter` 的定义**必须在初始态采样之前**——我加初始态断言时
            //   把它用在了 `const` 声明之前，实跑直接 TDZ 报错
            //   `Cannot access 'sampleAfter' before initialization`（一次真实的即时反馈：
            //   语法检查 `node --check` 过得去、跑起来才炸）。故整块上移。
            // [578-R2 L2] 原先是 `waitForTimeout(250)` 后**一次性采样**——若过滤涉及异步重绘/过渡，
            //   可能在未稳定时**假红**。改为**有超时上限的轮询**：
            // ⚠️ [579-R2 rec7] 但要说准：轮询**遇首次满足即退出**，只证明「条件曾在超时内成立」，
            //   **不能**保证之后不再变错——原注释里"也可能在最终错误态出现前先通过"那句反过来写成了
            //   轮询能避免它，是过强的保证，已删。
            //   条件一满足就停（同步实现下第一轮即返回，不增加耗时），超时则拿**最后一次真实快照**
            //   去断言（失败信息仍是真实快照，不是"轮询超时"这种无信息报错）。
            const sampleAfter = (els, key) => {
                const hidden = (el) => {
                    const cs = getComputedStyle(el);
                    return cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0;
                };
                const scopeRows = els.filter((e) => e.classList.contains('si-tl-release-scope'));
                const dcRows = els.filter((e) => e.textContent.includes(key));
                const dcRow = dcRows[0];
                const det = dcRow ? dcRow.querySelector('details.si-tl-release-json') : null;
                const cell = dcRow ? dcRow.querySelector('.si-tl-change-row') : null;
                return {
                    scopeTotal: scopeRows.length,
                    scopeStillShown: scopeRows.filter((e) => !hidden(e)).length,
                    dcMatched: dcRows.length,
                    dcShown: dcRows.filter((e) => !hidden(e)).length,
                    // [578-R2 rec] 外层行可见**不等于**明细还展开着——外层里还有摘要文本，
                    //   收起/藏掉明细它照样通过。故过滤后**单独**再查一次 details.open 与明细单元格。
                    dcDetailsOpen: det ? det.open : null,
                    dcCellShown: cell ? !hidden(cell) : null,
                    // [579-R4 rec3] 行标识也放进**同一次采样**——原先它是独立的 $$eval，
                    //   轮询等不到它 ⇒ 「数量先恢复、身份稍后恢复」时会提前退出再报错（假红）。
                    scopeTexts: scopeRows.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).sort(),
                };
            };
            const cb12 = page12.locator('label:has-text("隐藏批次编排记录") input[type="checkbox"]');
            await shotOnFail(page12, (await cb12.isChecked()) === false, 'c6-toggle-initially-unchecked',
                '⑫ 初始态：过滤开关应**未勾选**（否则下面"勾选→隐藏"这半验的不是真的状态变化）');
            const before12 = await page12.$$eval('.si-tl-item', sampleAfter, DC12);
            await shotOnFail(page12, before12.scopeStillShown === scopeBefore12, 'c6-scope-initially-visible',
                `⑫ 初始态：${scopeBefore12} 条编排行应全部可见，实得可见 ${before12.scopeStillShown} 条`);
            // [579-R3 rec6 / 579-R4 M] 采集编排行的**行文本多重集**（变量名也用 Texts 而非 Ids——codex 579-R5 rec6：避免维护者再把它误读成事件身份）——纯数量相等证不出"原有的那些行
            //   回来了"：等量**替换成别的事件**照样通过数量与可见性检查。
            // ⚠️ **能力边界（579-R4 指出，如实写明）**：这比较的是**文本多重集**，**不是事件身份集合**。
            //   `.si-tl-item` 在生产渲染里**没有任何稳定标识属性**（只有 class 与可选 style，
            //   见 Sys_Iteration.html 的 si-tl-item 模板）⇒ DOM 侧拿不到事件 id。
            //   ⇒ 两条**文本完全相同**的编排行互换，本条**检测不到**；空白归一化还会合并"仅空白不同"
            //   的文本。**不为了测试给生产渲染加 data-id**（那是渲染输出变更、超出 #67 范围）。
            //   变异 X1 只证明「能检测那一次文本替换」，不证明任意身份替换都能检测。
            const scopeTextsBefore12 = before12.scopeTexts;
            await cb12.check();
            // ⚠️ [578-R M-new1] 勾选后的判断**不能只看元素自身的 display**：若过滤器改成隐藏
            //   **时间线父容器**，改期行自身仍是 `display:block` ⇒ 旧写法 `dcVisible12 === 1` 照样通过，
            //   而用户其实什么都看不到（codex 578-R 指出，成立）。改为：
            //   · 编排行断的是「**已隐藏**」这个结果（自身 display:none **或** 无布局矩形），
            //     不限定必须由自身 display:none 实现；
            //   · 改期行断「文本匹配总数恰 1」**且**那一行通过与展开时同一套可见性检查（含布局矩形）。
            let after12 = await page12.$$eval('.si-tl-item', sampleAfter, DC12);
            // ⚠️ [579-R3 L1] `scopeTotal === scopeBefore12` **必须也进轮询成功条件**——它原先只在
            //   最终断言里。若异步重绘**暂时**移除了编排行而其他条件已满足，轮询会**立即退出**，
            //   然后因数量不足报错，等不到行恢复 ⇒ 假红（与"用轮询消除时序假红"的初衷相反）。
            const afterOk = (x) => x && x.scopeTotal === scopeBefore12 && x.scopeStillShown === 0
                && x.dcMatched === 1 && x.dcShown === 1
                && x.dcDetailsOpen === true && x.dcCellShown === true;
            for (let t = 0; t < 30 && !afterOk(after12); t += 1) {
                await page12.waitForTimeout(100);
                after12 = await page12.$$eval('.si-tl-item', sampleAfter, DC12);
            }
            // ⚠️ [579-R2 rec6] 只断「可见数为 0」**不够**：若过滤实现是**把编排行从 DOM 里删掉**，
            //   这个条件同样成立 ⇒ 先断**勾选后采样时编排行总数与勾选前相同**，再断可见数为 0。
            // ⚠️ [579-R4 L 订正] 原先写"删掉就再也恢复不了"——**不成立**（删掉 DOM 行后完全可以从
            //   保留的数据重新渲染）。而且"数量相等"本身只证明**采样那一刻数量没变**，
            //   并不证明节点从未被删除过。本条要的是「过滤=隐藏而非移除」这个**当前实现口径**，
            //   不是"DOM 节点必须持久存在"这种更强的需求。
            await shotOnFail(page12, after12.scopeTotal === scopeBefore12, 'c6-filter-not-remove',
                `⑫ 勾选后编排行应**仍在 DOM 里**（隐藏 ≠ 删除），勾选前 ${scopeBefore12} 条、勾选后 ${after12.scopeTotal} 条`);
            await shotOnFail(page12, after12.scopeStillShown === 0, 'c6-filter-hides',
                `⑫ 勾选后 ${after12.scopeTotal} 条批次编排记录应全部**不可见**（自身 display:none 或无布局矩形皆可），实得仍可见 ${after12.scopeStillShown} 条`);
            await shotOnFail(page12, after12.dcMatched === 1, 'c6-datechange-matched-one',
                `⑫ 勾选后按 summary 文本匹配的改期行应仍恰 1 条（防出现隐藏的重复行），实得 ${after12.dcMatched} 条`);
            await shotOnFail(page12, after12.dcShown === 1, 'c6-datechange-still-visible',
                `⑫ 勾选「隐藏批次编排记录」后改期行**仍通过可见性检查**（#67 A3 的核心语义；过滤器若改成隐藏父容器，本条会红而只看自身 display 的写法不会），实得可见 ${after12.dcShown} 条（应为 1）`);
            // [578-R2 rec] 过滤后明细应**仍展开且仍可见**——上面那条只证明"外层行没被藏"，
            //   外层里还有摘要文本，收起或藏掉明细它照样通过。
            await shotOnFail(page12, after12.dcDetailsOpen === true, 'c6-datechange-details-still-open',
                `⑫ 勾选过滤器后改期行的折叠应**保持展开**（本组上一步点开过），实得 ${JSON.stringify(after12.dcDetailsOpen)}`);
            await shotOnFail(page12, after12.dcCellShown === true, 'c6-datechange-cell-still-visible',
                `⑫ 勾选过滤器后明细单元格应**仍通过可见性检查**，实得 ${JSON.stringify(after12.dcCellShown)}`);

            // ── [579-R2 M1] **取消勾选后恢复**——这是此前整条链上唯一没验的方向 ──
            //   codex 579-R2 原话：「关闭态**初始渲染**不能证明**已经隐藏的现有 DOM 在取消勾选后恢复**。
            //   若开关处理器只执行隐藏、关闭时不恢复，所示渲染层两态检查与浏览器单向勾选检查仍可通过。」
            //   说得对：`siToggleTlReleaseScope(hide)` 现在写的是 `el.style.display = hide ? 'none' : ''`
            //   （会恢复），但若有人改成 `if (hide) el.style.display = 'none'`，**本轮之前所展示的
            //   单向检查无法捕获**（渲染层两态测的是**初始渲染**、浏览器层只点了一次勾选）。
            //   ⚠️ [579-R4 L] 原先写"当前所有断言都抓不住"——那与**现在已经存在的**恢复断言自相矛盾，
            //   措辞已按"修正前的单向检查无法捕获"订正。故补反向交互。
            //   不新增夹具，复用同一页面与同一套采样/轮询。
            await cb12.uncheck();
            let restored12 = await page12.$$eval('.si-tl-item', sampleAfter, DC12);
            // [579-R4 rec3] **标识一致也纳入轮询成功条件**——否则"数量先恢复、文本稍后恢复"时
            //   轮询会提前退出，再在最终断言里报错（假红）。
            const restoredOk = (x) => x && x.scopeTotal === scopeBefore12 && x.scopeStillShown === scopeBefore12
                && x.dcMatched === 1 && x.dcShown === 1 && x.dcDetailsOpen === true && x.dcCellShown === true
                && JSON.stringify(x.scopeTexts) === JSON.stringify(scopeTextsBefore12);
            for (let t = 0; t < 30 && !restoredOk(restored12); t += 1) {
                await page12.waitForTimeout(100);
                restored12 = await page12.$$eval('.si-tl-item', sampleAfter, DC12);
            }
            await shotOnFail(page12, restored12 && restored12.scopeTotal === scopeBefore12, 'c6-restore-not-remove',
                `⑫ 取消勾选后编排行数量应不变，勾选前 ${scopeBefore12} 条、取消后 ${restored12 && restored12.scopeTotal} 条`);
            await shotOnFail(page12, restored12 && restored12.scopeStillShown === scopeBefore12, 'c6-restore-visible',
                `⑫ **取消勾选后原先被隐藏的 ${scopeBefore12} 条编排行应全部恢复可见**（只隐藏不恢复的实现在这里会红），实得可见 ${restored12 && restored12.scopeStillShown} 条`);
            // ⚠️ [579-R3 M1] **轮询成功条件里的每一项都要有对应的最终断言**——`restoredOk` 含
            //   `dcMatched === 1`，但我原先的最终断言漏了它 ⇒ 若取消勾选后出现「一条可见改期行 +
            //   一条隐藏的重复改期行」，轮询会耗尽超时，而随后所有恢复断言**仍会通过**（codex 579-R3
            //   指出，成立）。补上，并把这条当纪律：afterOk / restoredOk 的每个条件逐一对应。
            await shotOnFail(page12, restored12 && restored12.dcMatched === 1, 'c6-restore-datechange-matched-one',
                `⑫ 取消勾选后按 summary 匹配的改期行应仍恰 1 条（防出现隐藏的重复行），实得 ${restored12 && restored12.dcMatched} 条`);
            await shotOnFail(page12, restored12 && restored12.dcShown === 1, 'c6-restore-datechange-visible',
                `⑫ 取消勾选后改期行当然仍可见，实得 ${restored12 && restored12.dcShown} 条`);
            // [579-R3 rec6 / 579-R4 M+rec3] 行文本多重集前后一致——数量相等证不出"原有的那些行回来了"。
            //   取值来自**与上面同一次采样**（不再另发 $$eval），故它也受轮询等待。
            const scopeTextsAfter12 = restored12 && restored12.scopeTexts;
            await shotOnFail(page12, JSON.stringify(scopeTextsAfter12) === JSON.stringify(scopeTextsBefore12), 'c6-restore-same-rows',
                `⑫ 取消勾选后编排行的**行文本多重集**应与勾选前一致（比纯数量强；但**不是**事件身份比对——DOM 无稳定标识，同文本行互换检测不到），前=${JSON.stringify(scopeTextsBefore12)} 后=${JSON.stringify(scopeTextsAfter12)}`);
            await shotOnFail(page12, restored12 && restored12.dcDetailsOpen === true && restored12.dcCellShown === true, 'c6-restore-details-open',
                `⑫ 取消勾选后改期行的明细应仍展开且可见，实得 ${JSON.stringify(restored12 && { open: restored12.dcDetailsOpen, cell: restored12.dcCellShown })}`);
            await page12.close();
        }

        // ── ⑬ [S4c·#67 C4a] estimate 行浏览器实证：真实两次估时 → 徽章/展开区/可见性断言 ──────────
        //   本组局部扩清理面（主会话 2026-09-17 裁定，方案 1）：/estimate 鉴权（assertDevMember，
        //   routes/sys-iteration/index.js:3435-3444）唯一判据是 sys_issue_dev_assignees 存在一条
        //   `issue_id=? AND user_id=? AND removed_at IS NULL` 的在册行，**不看** sys_issues.assigned_to
        //   （核实过：设 assigned_to 列不能满足鉴权，走 /assign 会引入该表之外的额外副作用面，故不走
        //   /assign，改为 SQL 直接 INSERT 一行满足鉴权，本组自建自删自核，见文件顶部 devAssigneeId13 声明
        //   与下方 finally 里先于外层五表清理执行的局部清理）。
        //   /estimate 端点本身的写点已核（index.js:14319-14364 + writeDevEstimatedFirstSnapshot:3211-3216）：
        //   只有 sys_issues UPDATE + sys_issue_timeline INSERT 两处，均已在既有五表清单内；
        //   dispatchSysNotify 现网 isAutoNotifyEnabled 恒 false（:20302-20306），早返回不写库——无第三张
        //   清单外的表需要收，不再扩清理面。
        {
            console.log('\n── ⑬ [S4c·#67 C4a] estimate 行浏览器实证：两次估时 → 徽章/展开区/可见性 ──');
            const DEV_ID_13 = 8;   // 示例开发A——与 test-sys-eta-generation-playwright.js 既有测试同一「测试开发」身份
            // [S4c2·Opus 预筛 M1] 日期**现算**不钉死（memory feedback_tests_decouple_wall_clock）：/estimate 唯一时间闸是
            //   estMin >= assignedMin（assigned_at=本组刚写的 now），钉死绝对日期在其之后必红。取 now+21d / now+23d 的 10:00，
            //   日期分量不同以维持展开区两栏与 isEtaValueChangedForNotify 语义；mkIssue 不写 deadline ⇒ 容差闸不适用，与日期无关。
            const fmtEta13 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 10:00`;
            const plusDays13 = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
            const eta1_13 = fmtEta13(plusDays13(21));
            const eta2_13 = fmtEta13(plusDays13(23));

            // 前置：造一个「已加入批次」的迭代单——只为让「隐藏批次编排记录」过滤开关渲染出来（该开关
            // 仅当本单确有 release_add 一类可隐藏事件才出现，siRenderDrawer :3946 hasReleaseScopeTl），
            // 批次本身走既有五表清理清单（createdReleaseIds），不额外扩清理面。
            const relId13 = await mkRelease(adminTok, `${TITLE_PREFIX}估时展示`);
            const issueId13 = await mkIssue(`${TITLE_PREFIX}成员-估时展示`);
            await addIssueTo(adminTok, relId13, issueId13);   // 要求 status='待上线'（mkIssue 默认值），此刻满足
            // 加单后手工把单据推进到 W06「开发中」态并补 assigned_at（/estimate 的 SF.isW06Allowed('estimate',
            // 'feature','开发中') 与 assignedMin 前置都要）——不经 /assign，避免其额外写点。
            await dbRun(`UPDATE sys_issues SET status='开发中', assigned_at=datetime('now','localtime') WHERE id=?`, [issueId13]);
            const devUser13 = await dbGet('SELECT display_name FROM users WHERE id=?', [DEV_ID_13]);
            must(!!devUser13, `⑬ 前置：测试开发用户 id=${DEV_ID_13} 应存在，实得 ${JSON.stringify(devUser13)}`);
            if (!devUser13) throw new Error(`⑬ 前置中断：测试开发用户 id=${DEV_ID_13} 不存在（must 不中断，避免下一行 TypeError 掩盖人话）`);   // [S4c2·L3]
            const devAssigneeIns13 = await dbRun(
                // [S4c2·Opus 预筛 M2] 夹具形态改为生产可达：生产里 is_primary=1 只由迁移写且必与 sys_issues.assigned_to 同在，
                //   其余在册行恒 is_primary=0 + round_no=正整数（addOrReaddMembers/assertValidRoundNo）——本组 assigned_to 恒 NULL，故用 0/1。
                `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, round_no, dev_status) VALUES (?, ?, ?, 0, 1, 'pending')`,
                [issueId13, DEV_ID_13, devUser13.display_name]
            );
            devAssigneeId13 = devAssigneeIns13.lastID;
            devAssigneeIssueId13 = issueId13;
            const devTok13 = await signAs(DEV_ID_13);

            // 真实端点：首次估时 + 更新估时（两次都走库层真实 /estimate，不伪造响应）。
            const r13a = await fetchJson(`/api/sys-issues/${issueId13}/estimate`, devTok13, { method: 'POST', body: { dev_estimated_at: eta1_13, estimated_effort_days: 3 } });
            must(r13a.status === 200, `⑬ 前置：首次估时应 200，实得 ${r13a.status} ${JSON.stringify(r13a.body)}`);
            const r13b = await fetchJson(`/api/sys-issues/${issueId13}/estimate`, devTok13, { method: 'POST', body: { dev_estimated_at: eta2_13, estimated_effort_days: 5 } });
            must(r13b.status === 200, `⑬ 前置：更新估时应 200，实得 ${r13b.status} ${JSON.stringify(r13b.body)}`);

            const tl13 = await dbAll(`SELECT summary, payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='estimate_eta' ORDER BY id`, [issueId13]);
            must(tl13.length === 2, `⑬ 前置：库层应恰 2 条 estimate_eta timeline，实得 ${tl13.length}`);

            const page13 = await loginPage(browser, devTok13);
            await page13.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId13}`);
            await page13.waitForLoadState('networkidle');
            await page13.waitForTimeout(500);

            // 定位 estimate 行：不用徽章文本（A 类恒被覆盖为「✎ 变更留痕」，且改期行也用同一徽章）——
            //   用 estimate 事件类型专属前缀「预计完成：」定位（B3，baseSummaryHtml），该前缀是紧跟在
            //   .si-tl-evt 徽章 span 之后的纯文本节点（不在 <details><summary> 里），故取
            //   `evt.nextSibling` 的文本节点值做前缀匹配，同时记录该行在全部 .si-tl-item 中的下标
            //   （供随后精确点击「查看改动」，不用 :has-text 文本匹配——第二条行的「修改前」单元格文本
            //   恰好也含第一条的新值，纯文本匹配会撞车）。
            const EST_PREFIX_13 = '预计完成：';
            const rowInfo13 = await page13.$$eval('.si-tl-item', (els, prefix) => {
                const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
                const esc4re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const results = [];
                for (let i = 0; i < els.length; i++) {
                    const e = els[i];
                    const body = e.querySelector('.si-tl-body');
                    const evt = body ? body.querySelector('.si-tl-evt') : null;
                    const prefixNode = evt ? evt.nextSibling : null;
                    const prefixText = (prefixNode && prefixNode.nodeType === 3) ? prefixNode.textContent : '';
                    if (!prefixText.startsWith(prefix)) continue;
                    const det = e.querySelector('details.si-tl-release-json');
                    const rows = [...e.querySelectorAll('.si-tl-change-row')].map((r) => ({
                        field: (r.querySelector('.si-tl-change-field') || {}).textContent || null,
                        old: (r.querySelector('.si-tl-change-old .si-tl-change-val') || {}).textContent || null,
                        neu: (r.querySelector('.si-tl-change-new .si-tl-change-val') || {}).textContent || null,
                    }));
                    results.push({
                        idx: i,
                        evtLabel: evt ? evt.textContent.trim() : null,
                        evtCls: evt ? evt.className : null,
                        prefixText,
                        prefixOccurrences: (e.textContent.match(new RegExp(esc4re(prefix), 'g')) || []).length,
                        hasDetails: !!det,
                        detailsOpen: det ? det.open : null,
                        summaryText: det && det.querySelector('summary') ? det.querySelector('summary').textContent.trim() : null,
                        note: e.textContent.includes('修改明细不可用'),
                        rowVisibleBeforeOpen: vis(e),
                        rows,
                    });
                }
                return results;
            }, EST_PREFIX_13);
            await shotOnFail(page13, rowInfo13.length === 2, '13-rows-present',
                `⑬ 页面时间线应恰有 2 条 estimate 行（按「预计完成：」前缀定位），实得 ${rowInfo13.length} —— 非 2 则下面全是空转`);
            const first13 = rowInfo13[0] || {};
            const second13 = rowInfo13[1] || {};

            // ── 第一条（首次）──
            await shotOnFail(page13, first13.evtLabel === '✎ 变更留痕', '13-badge-1',
                `⑬ 第一条徽章应为「✎ 变更留痕」，实得「${first13.evtLabel}」`);
            await shotOnFail(page13, /si-tl-rose/.test(String(first13.evtCls)), '13-badge-cls-1',
                `⑬ 第一条徽章类应含 si-tl-rose，实得「${first13.evtCls}」`);
            await shotOnFail(page13, first13.prefixText === EST_PREFIX_13 + eta1_13, '13-prefix-1',
                `⑬ 第一条应以「${EST_PREFIX_13}${eta1_13}」开头，实得「${first13.prefixText}」`);
            await shotOnFail(page13, first13.prefixOccurrences === 1, '13-prefix-once-1',
                `⑬ 第一条「预计完成：」应恰出现 1 次，实得 ${first13.prefixOccurrences}`);
            await shotOnFail(page13, first13.hasDetails === true && first13.detailsOpen === false, '13-details-1',
                `⑬ 第一条应出现默认收起的「查看改动」折叠，实得 hasDetails=${first13.hasDetails} open=${first13.detailsOpen}`);
            await shotOnFail(page13, /查看改动（2 项）/.test(String(first13.summaryText)), '13-summary-1',
                `⑬ 第一条折叠摘要应为「查看改动（2 项）」，实得「${first13.summaryText}」`);
            await shotOnFail(page13, first13.note === false, '13-no-note-1', '⑬ 第一条不应出现「修改明细不可用」');
            await shotOnFail(page13, first13.rows && first13.rows.length === 2, '13-rows-count-1',
                `⑬ 第一条展开区应恰 2 行明细，实得 ${first13.rows && first13.rows.length}`);
            const c13a1 = (first13.rows || [])[0] || {};
            const c13a2 = (first13.rows || [])[1] || {};
            await shotOnFail(page13, c13a1.field === '预计完成时间' && c13a1.old === '（空）' && c13a1.neu === eta1_13, '13-cell-1-1',
                `⑬ 第一条明细行 1 应为「预计完成时间」（空）→${eta1_13}，实得 ${JSON.stringify(c13a1)}`);
            await shotOnFail(page13, c13a2.field === '预计工期（人日）' && c13a2.old === '（空）' && c13a2.neu === '3', '13-cell-1-2',
                `⑬ 第一条明细行 2 应为「预计工期（人日）」（空）→3，实得 ${JSON.stringify(c13a2)}`);

            // ── 第二条（更新）──
            // [S4c2·Opus 预筛 L1] 徽章/折叠初始态对第二条同样断（否则「只给首条命中行换徽章」的错误实现能穿过）
            await shotOnFail(page13, second13.evtLabel === '✎ 变更留痕', '13-badge-2',
                `⑬ 第二条徽章应为「✎ 变更留痕」，实得「${second13.evtLabel}」`);
            await shotOnFail(page13, /si-tl-rose/.test(String(second13.evtCls)), '13-badge-cls-2',
                `⑬ 第二条徽章类应含 si-tl-rose，实得「${second13.evtCls}」`);
            await shotOnFail(page13, second13.hasDetails === true && second13.detailsOpen === false, '13-details-2',
                `⑬ 第二条应出现默认收起的「查看改动」折叠，实得 hasDetails=${second13.hasDetails} open=${second13.detailsOpen}`);
            await shotOnFail(page13, second13.note === false, '13-no-note-2', '⑬ 第二条不应出现「修改明细不可用」');
            await shotOnFail(page13, second13.prefixText === EST_PREFIX_13 + eta2_13, '13-prefix-2',
                `⑬ 第二条应以「${EST_PREFIX_13}${eta2_13}」开头，实得「${second13.prefixText}」`);
            await shotOnFail(page13, second13.prefixOccurrences === 1, '13-prefix-once-2',
                `⑬ 第二条「预计完成：」应恰出现 1 次，实得 ${second13.prefixOccurrences}`);
            await shotOnFail(page13, /查看改动（2 项）/.test(String(second13.summaryText)), '13-summary-2',
                `⑬ 第二条折叠摘要应为「查看改动（2 项）」，实得「${second13.summaryText}」`);
            await shotOnFail(page13, second13.rows && second13.rows.length === 2, '13-rows-count-2',
                `⑬ 第二条展开区应恰 2 行明细，实得 ${second13.rows && second13.rows.length}`);
            const c13b1 = (second13.rows || [])[0] || {};
            const c13b2 = (second13.rows || [])[1] || {};
            await shotOnFail(page13, c13b1.field === '预计完成时间' && c13b1.old === eta1_13 && c13b1.neu === eta2_13, '13-cell-2-1',
                `⑬ 第二条明细行 1 应为「预计完成时间」${eta1_13}→${eta2_13}，实得 ${JSON.stringify(c13b1)}`);
            await shotOnFail(page13, c13b2.field === '预计工期（人日）' && c13b2.old === '3' && c13b2.neu === '5', '13-cell-2-2',
                `⑬ 第二条明细行 2 应为「预计工期（人日）」3→5，实得 ${JSON.stringify(c13b2)}`);

            // ── 真的点开折叠，逐单元格核对可见性（同 ⑫ 组纪律：收起时 textContent 依然可读，
            //   必须实际点开再查 display/visibility/布局矩形）──
            async function openAndCheckEstimateRow13(idx) {
                const rowLoc = page13.locator('.si-tl-item').nth(idx);
                await rowLoc.locator('details.si-tl-release-json summary').click();
                await page13.waitForTimeout(200);
                return rowLoc.evaluate((e) => {
                    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
                    const det = e.querySelector('details.si-tl-release-json');
                    const cells = [...e.querySelectorAll('.si-tl-change-row')];
                    return {
                        open: det ? det.open : null,
                        rowCount: cells.length,
                        allVisible: cells.length > 0 && cells.every((c) => vis(c)
                            && vis(c.querySelector('.si-tl-change-field'))
                            && vis(c.querySelector('.si-tl-change-old .si-tl-change-val'))
                            && vis(c.querySelector('.si-tl-change-new .si-tl-change-val'))),
                    };
                });
            }
            const opened13a = await openAndCheckEstimateRow13(first13.idx);
            await shotOnFail(page13, opened13a.open === true, '13-opened-1', `⑬ 第一条点击后 details.open 应为 true，实得 ${JSON.stringify(opened13a.open)}`);
            await shotOnFail(page13, opened13a.allVisible === true, '13-visible-1', `⑬ 第一条展开后明细行与三单元格应通过可见性检查，实得 ${JSON.stringify(opened13a)}`);
            const opened13b = await openAndCheckEstimateRow13(second13.idx);
            await shotOnFail(page13, opened13b.open === true, '13-opened-2', `⑬ 第二条点击后 details.open 应为 true，实得 ${JSON.stringify(opened13b.open)}`);
            await shotOnFail(page13, opened13b.allVisible === true, '13-visible-2', `⑬ 第二条展开后明细行与三单元格应通过可见性检查，实得 ${JSON.stringify(opened13b)}`);

            // ── 勾选「隐藏批次编排记录」后两条估时行仍应可见（estimate 不在可隐藏集合，A3/A4 语义）──
            const hasToggle13 = await page13.locator('label:has-text("隐藏批次编排记录")').count();
            await shotOnFail(page13, hasToggle13 > 0, '13-toggle-present',
                '⑬ 前置：本单已加入批次（release_add），过滤开关应出现');
            const cb13 = page13.locator('label:has-text("隐藏批次编排记录") input[type="checkbox"]');
            await cb13.check();
            await page13.waitForTimeout(250);
            const afterToggle13 = await page13.$$eval('.si-tl-item', (els, prefix) => {
                const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
                return els.filter((e) => {
                    const body = e.querySelector('.si-tl-body');
                    const evt = body ? body.querySelector('.si-tl-evt') : null;
                    const pn = evt ? evt.nextSibling : null;
                    const pt = (pn && pn.nodeType === 3) ? pn.textContent : '';
                    return pt.startsWith(prefix);
                }).map((e) => vis(e));
            }, EST_PREFIX_13);
            await shotOnFail(page13, afterToggle13.length === 2 && afterToggle13.every(Boolean), '13-visible-after-toggle',
                `⑬ 勾选「隐藏批次编排记录」后两条估时行仍应可见，实得 ${JSON.stringify(afterToggle13)}`);

            await page13.close();
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
        // [S4c·⑬ 局部清理面·主会话 2026-09-17 裁定] sys_issue_dev_assignees 不在既有五表清单内——先于
        // 下方外层五表清理执行：DELETE 本组唯一一行、按 issue_id 精确核验残留=0，另起一行打印（不并入
        // 下方五表 residual JSON，不改外层五表数组本身，见文件顶部 devAssigneeId13/devAssigneeIssueId13 声明）。
        if (devAssigneeId13 !== null) {
            try {
                await dbRun('DELETE FROM sys_issue_dev_assignees WHERE id=?', [devAssigneeId13]);
                const devAssigneeResidual13 = await dbGet(
                    'SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id=?', [devAssigneeIssueId13]
                );
                const c13 = devAssigneeResidual13 ? devAssigneeResidual13.c : -1;
                if (c13 !== 0) {
                    fail++;
                    failDetails.push(`⑬ 局部清理：sys_issue_dev_assignees(issue_id=${devAssigneeIssueId13}) 残留应为 0，实得 ${c13}`);
                    console.error(`❌ ⑬ 局部残留核验未通过：sys_issue_dev_assignees(issue_id=${devAssigneeIssueId13}) = ${c13}`);
                } else {
                    console.log(`🧹 ⑬ 局部残留核验通过：sys_issue_dev_assignees(issue_id=${devAssigneeIssueId13}) = 0`);
                }
            } catch (localCleanupErr) {
                fail++;
                failDetails.push('⑬ 局部清理异常（sys_issue_dev_assignees）：' + (localCleanupErr && localCleanupErr.message));
                console.error('❌ ⑬ 局部清理异常：' + (localCleanupErr && localCleanupErr.message));
            }
        }
        // [C4c·codex 558 M2 收口，同 test-sys-release-overdue-playwright.js C3c·557 M3 同款范式]
        // 清理异常与"删完后仍有残留"此前只 warn 不计入失败——那等于允许本文件悄悄泄漏测试数据到共享
        // 生产库却仍报绿。改为：清理异常记入 fail（非零退出），清理后逐表精确按本轮夹具的 id 集合
        // SELECT 残留行数，非 0 同样计入失败（不信"删语句跑完了"就等于"删干净了"）。
        // [C4g·codex 563 H1 收口] 本轮集合直接取 createdReleaseIds/createdIssueIds（创建成功当刻登记，
        // 见文件顶部定义）——不再在这里按 TITLE_PREFIX 现查一遍：现查会把"本轮批次被中途改过标题但仍
        // 命中前缀"之外的**其它轮次**残留（上一次跑崩溃没清干净的/其它并行会话同前缀的夹具）一并当成
        // "本轮"删掉，那是在清别人的数据，不是精确清单（feedback_shared_dir_test_cleanup_precise_list）。
        let rels = createdReleaseIds.slice();
        let issues = createdIssueIds.slice();
        try {
            for (const rid of rels) {
                await dbRun('DELETE FROM sys_release_executors WHERE release_id=?', [rid]);
                await dbRun('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?', [rid]);
            }
            for (const iid of issues) {
                await dbRun('DELETE FROM sys_issue_timeline WHERE issue_id=?', [iid]);
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
        // 残留核验：按本轮实际造过的 id 集合精确查（rels/issues 此刻已从 sys_releases/sys_issues 删掉，
        // title 前缀查询会天然查不到，必须落到子表 + 原始 id 列表上）。
        try {
            const relPlaceholders = rels.length ? rels.map(() => '?').join(',') : null;
            const issuePlaceholders = issues.length ? issues.map(() => '?').join(',') : null;
            const residual = {};
            residual.sys_releases = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_releases WHERE id IN (${relPlaceholders})`, rels)).c : 0;
            residual.sys_issues = issues.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${issuePlaceholders})`, issues)).c : 0;
            residual.sys_release_executors = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_release_executors WHERE release_id IN (${relPlaceholders})`, rels)).c : 0;
            residual.sys_issue_timeline = issues.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id IN (${issuePlaceholders})`, issues)).c : 0;
            residual.sys_issue_release_commit_snapshots = rels.length ? (await dbGet(`SELECT COUNT(*) c FROM sys_issue_release_commit_snapshots WHERE release_id IN (${relPlaceholders})`, rels)).c : 0;
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
        // 精确删除它——不再用空 catch 吞掉删除失败，删除失败计入失败，删除成功后再查一次确认零残留。
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
