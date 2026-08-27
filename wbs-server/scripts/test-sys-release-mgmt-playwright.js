/**
 * 「上线单管理体验优化」方案 v1.3·Phase R Commit 7（O4 前端 + 三组挂账浏览器断言）·Playwright 活体验证
 * 用法：外部 server:3000 已起（本文件不自拉服务，见下方"server 编排"约定）后：
 *   node scripts/test-sys-release-mgmt-playwright.js
 *
 * ⚠️ 一次只跑一个写 db 的 Playwright——本文件直连 task_pool.db 造夹具 + 写 sys_issues/sys_releases/
 *   sys_release_audit/sys_issue_timeline，与其余 test-sys-*-playwright.js 一样不支持并发跑多份实例
 *   （同 test-sys-my-pending-playwright.js 头部纪律，未重复整段搬运，此处仅点名）。
 *
 * server 编排（无人值守，同 test-sys-my-pending-playwright.js 契约）：本文件契约=外部 server:3000
 *   已起（TCP+readiness 双探测）——本文件自身不 spawn/kill server 进程，起停 server 是调用方（主会话/
 *   agent）的职责：3000 无监听则从 wbs-server 目录起 server（单命令、记 PID）；3000 已被占用则先跑
 *   readiness 探测确认是本项目 server（401）再直接用，不是则停手报告，不抢占端口。
 *
 * 数据隔离：全部造数标题/批次号恒 RELMG- 前缀（共享面隔离约定，与 MPPW-/FLPW-/其它前缀区分）。
 *
 * 覆盖（挂账三件，方案 §6 断言 + N0-R 执行结果节 R-C7 段）：
 *   ① 449-M5 O2 计算样式：打开上线单详情（造 22 张成员长内容强制滚动）断言 #siBatchBox（.si-modal）
 *      computed display=flex、#siBatchBody scrollHeight>clientHeight（真实溢出）、head/foot
 *      getBoundingClientRect 仍在视口内（未被内容顶出）、外层 .si-modal 本身不滚（scrollTop 恒 0，
 *      含主动尝试设置 scrollTop 后仍归零的行为级证明，非仅读初值）。
 *   ② O1 徽章活体：加单弹窗候选行 .u-sys-tag 存在且文本 ∈ 六系统值（BMS/HRD/电子签/客户报销平台/
 *      RPA程序/其他）。
 *   ③ 473 LOW-2 时间线三值：对批次做一次真实 PATCH 编辑（admin）→ 打开成员单详情时间线 →
 *      release_info_edit 事件 display 文案='上线单信息修改' + CSS class 含 si-tl-indigo +
 *      D9=「隐藏上线单调整记录」过滤开关打开后该事件仍可见（同批次的 release_add scope_change 事件
 *      则应被过滤器隐藏，作为"过滤器真的生效"的对照）。
 *   ④ S12 顺带：删除链路活体一条——对①②③复用的同一批次（其时已积累 22 张成员+完整编辑留痕）点击
 *      「删除上线单」→ 填 reason → 确认 → 断言 200 + 列表刷新批次消失 + 全部 22 张成员单 release_id
 *      清空且 status 仍「待上线」（D10：退回，不误动终态）。
 *
 * 夹具口径：22 张成员单直连 SQL 造（type='bug'，status='待上线'，release_id 初始 NULL）——6 张各配一个
 *   不同 system_name（覆盖六系统值域，供②断言），16 张 system_name='BMS' 补量凑到 22（超过方案 §6
 *   "≥20 成员详情 foot 五按钮不滚走"验收阈值，稳定触发①的真实滚动）。全部通过真实 POST .../add-issues
 *   端点（经加单弹窗勾选，非直接 SQL 挂 release_id）加入批次——同一动作顺带覆盖②的候选徽章断言，
 *   不另起夹具。
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
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-release-mgmt-playwright-shots');
const TITLE_PREFIX = 'RELMG-';

const ADMIN_ID = 1;
const BIZ_SYSTEMS = ['BMS', 'HRD', '电子签', '客户报销平台', 'RPA程序', '其他'];
const N_PLAIN_MEMBERS = 16;   // + 6 张系统标签夹具 = 22 张成员（>20 验收阈值）

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
        const p = path.join(SCREENSHOT_DIR, `relmg-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}
// [平台测试铁律] JWT 注入 + login.html 中继跳转——鉴权页直接 goto 会被 checkAuth 销毁 context。
async function loginPage(browser, token) {
    const page = await browser.newPage();
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    return page;
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

// ── server 编排探测（照抄 test-sys-my-pending-playwright.js，双探测：TCP 监听 + 应用层 readiness） ──
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
        throw new Error(`应用 readiness 探测请求失败（${e.message}）——端口监听者可能不是目标 server.js`);
    });
    if (r.status !== 401) {
        throw new Error(`应用 readiness 探测异常：期望 401（authenticateToken 未登录，证明路由存在且是本模块），实得 ${r.status}——监听该端口的可能不是目标 server.js（孤儿进程/端口被其它服务占用）`);
    }
}

// ── 夹具：直连 SQL 造「待上线」成员单（同 verify-sys-release-delete.js mkIssue 范式，仅本文件走真实
//   运行中 server 的 task_pool.db，非 :memory: 测试库）──────────────────────────────────────────
let seq = 0;
async function mkPendingIssue(titleTag, systemName) {
    seq++;
    const title = `${TITLE_PREFIX}${titleTag}-${seq}`;
    // ⚠️ [角色权限重构 C0 焊死受理门] sys_issues.intake_required 列定义为 `INTEGER NOT NULL DEFAULT 0`
    //   （index.js :13667 一带原文），且 trg_sys_issues_intake_gate_ins 触发器对任何 intake_required
    //   不为 1 的 INSERT 一律 RAISE(ABORT)——本表**没有"靠 DEFAULT 落 1"这回事**，一切直连 SQL 造夹具
    //   必须显式补这一列，同 index.js 该处注释警告的既有踩坑同款。
    const r = await dbRun(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
         VALUES ('bug', '待上线', ?, ?, '内部', ?, '管理员', 1)`,
        [title, systemName, ADMIN_ID]
    );
    return { id: r.lastID, title, systemName };
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');

    const adminTok = await signAs(ADMIN_ID);

    const createdIssueIds = [];
    let releaseId = null;
    let releaseNo = null;
    let escReleaseId = null;   // [codex 477 复审 HIGH·⑤] Esc 双防线回归专用夹具批次，独立于①-④b 复用的 releaseId
    let escReleaseNo = null;
    let browser = null;
    try {
        console.log('\n══════ 上线单管理体验优化 R-C7·上线单管理浏览器活体验证（RELMG-）══════');

        // ── 夹具：建批次（title/version_tag/release_note 初值，供③编辑后对拍） ──
        const createR = await fetchJson('/api/sys-releases', adminTok, {
            method: 'POST', body: {
                title: `${TITLE_PREFIX}批次-${Date.now()}`,
                version_tag: 'v0.0.1-relmg',
                release_note: 'RELMG 活体夹具·原始说明',
            },
        });
        if (createR.status !== 201) throw new Error(`[夹具-建批次] 应 201，实得 ${createR.status} ${JSON.stringify(createR.body)}`);
        releaseId = createR.body.id;
        releaseNo = createR.body.release_no;
        console.log(`  （夹具批次 #${releaseId} / ${releaseNo} 已建）`);

        // ── 夹具：6 张系统标签成员（一系统一张）+ 16 张补量成员，全部「待上线」未挂批次 ──
        const taggedMembers = [];
        for (const sys of BIZ_SYSTEMS) {
            const m = await mkPendingIssue(`tag-${sys}`, sys);
            taggedMembers.push(m);
            createdIssueIds.push(m.id);
        }
        const plainMembers = [];
        for (let i = 0; i < N_PLAIN_MEMBERS; i++) {
            const m = await mkPendingIssue('plain', 'BMS');
            plainMembers.push(m);
            createdIssueIds.push(m.id);
        }
        const allMemberIds = [...taggedMembers, ...plainMembers].map(m => m.id);
        console.log(`  （夹具成员单已建：系统标签 ${taggedMembers.length} 张 + 补量 ${plainMembers.length} 张 = ${allMemberIds.length} 张，均「待上线」未挂批次）`);

        browser = await chromium.launch();
        const page = await loginPage(browser, adminTok);
        await page.setViewportSize({ width: 1280, height: 900 });

        // ═══════════════════════════════════════════════════════════════
        // ② O1 徽章活体 + 加单（用同一动作把 22 张成员挂进批次，供①③④复用）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ② O1 徽章活体：加单弹窗候选行 .u-sys-tag 存在且文本 ∈ 六系统值 ──');
        await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${releaseId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        await shotOnFail(page, (await page.locator('#siBatchHead').textContent()).includes(releaseNo), '2-deeplink-detail', `深链 ?release=${releaseId} 应直达详情，siBatchHead 应含 ${releaseNo}`);

        const addBtn = page.locator('#siBatchFoot button', { hasText: '+ 加单' });
        await shotOnFail(page, (await addBtn.count()) === 1, '2-add-btn-present', '「+ 加单」按钮应存在（admin ∧ planning）');
        await addBtn.click();
        await page.waitForSelector(`input.si-add-chk[value="${taggedMembers[0].id}"]`, { timeout: 8000 });

        const renderedTags = [];
        for (const m of taggedMembers) {
            const tagText = await page.evaluate((id) => {
                const el = document.querySelector(`input.si-add-chk[value="${id}"]`);
                const label = el ? el.closest('label.si-chk-row-wide') : null;
                const tag = label ? label.querySelector('.u-sys-tag') : null;
                return tag ? tag.textContent.trim() : null;
            }, m.id);
            await shotOnFail(page, tagText === m.systemName, `2-tag-${m.systemName}`, `候选行 #${m.id}（system_name=${m.systemName}）应渲染 .u-sys-tag 且文本恰等于系统名，实得 ${JSON.stringify(tagText)}`);
            renderedTags.push(tagText);
        }
        // [Opus 预筛 S12 回卷提示2] 原判据 `BIZ_SYSTEMS.every(s => taggedMembers.some(...))` 是恒真式——
        //   taggedMembers 本就是遍历 BIZ_SYSTEMS 逐一构造出来的（见上方 mkPendingIssue 循环），此断言只是
        //   把构造时的输入原样念一遍，不读取任何页面实际渲染结果，页面就算把 .u-sys-tag 全部渲染错也不会
        //   变红。改为对 renderedTags——本组循环里真实从 DOM 读到的 6 个 .u-sys-tag 文本——做值域覆盖
        //   判断：唯有页面真渲染出恰好六个互不相同且逐一命中 BIZ_SYSTEMS 的值才算过。
        const renderedTagSet = new Set(renderedTags);
        await shotOnFail(page, renderedTagSet.size === BIZ_SYSTEMS.length && BIZ_SYSTEMS.every(s => renderedTagSet.has(s)), '2-domain-coverage', `候选行实际渲染的 .u-sys-tag 文本集合应恰好覆盖六系统值域，实得 ${JSON.stringify([...renderedTagSet])}`);

        // 勾选全部 22 张夹具成员（精确按 value 定位，不动任何非本次夹具的真实候选行）。
        for (const id of allMemberIds) {
            const chk = page.locator(`input.si-add-chk[value="${id}"]`);
            await shotOnFail(page, (await chk.count()) === 1, `2-chk-present-${id}`, `候选勾选框 #${id} 应存在于加单弹窗`);
            await chk.check();
        }
        const [addResp] = await Promise.all([
            page.waitForResponse(r => r.url().includes('/add-issues') && r.request().method() === 'POST'),
            page.click('#siMConfirm'),
        ]);
        const addBody = await addResp.json().catch(() => null);
        await shotOnFail(page, addResp.status() === 200 && addBody && addBody.count === allMemberIds.length, '2-add-issues-count', `加单应 200 且 count=${allMemberIds.length}，实得 status=${addResp.status()} body=${JSON.stringify(addBody)}`);
        await page.waitForTimeout(700);
        await shotOnFail(page, (await page.locator('.u-detail-section h3', { hasText: '上线单成员' }).textContent()).includes(String(allMemberIds.length)), '2-member-count-reflected', `详情页「上线单成员」计数应反映 22（实得标题=${await page.locator('.u-detail-section h3', { hasText: '上线单成员' }).textContent().catch(() => '(未取到)')}）`);

        // ═══════════════════════════════════════════════════════════════
        // ① 449-M5 O2 计算样式：22 张成员长内容强制滚动，验证真实运行时（非仅源码文本声明）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ① 449-M5 O2 计算样式：#siBatchBox 结构化滚动运行时验证 ──');
        const metrics = await page.evaluate(() => {
            const box = document.getElementById('siBatchBox');
            const body = document.getElementById('siBatchBody');
            const head = box.querySelector('.si-modal-head');
            const foot = document.getElementById('siBatchFoot');
            const boxCs = getComputedStyle(box);
            const bodyCs = getComputedStyle(body);
            const headRect = head.getBoundingClientRect();
            const footRect = foot.getBoundingClientRect();
            box.scrollTop = 999;   // 行为级证明：主动尝试滚外层，overflow:hidden 应吃掉这次赋值
            const scrollTopAfterAttempt = box.scrollTop;
            return {
                boxDisplay: boxCs.display,
                boxOverflow: boxCs.overflow,
                bodyOverflowY: bodyCs.overflowY,
                bodyScrollHeight: body.scrollHeight,
                bodyClientHeight: body.clientHeight,
                headTop: headRect.top, headBottom: headRect.bottom,
                footTop: footRect.top, footBottom: footRect.bottom,
                viewportHeight: window.innerHeight,
                scrollTopAfterAttempt,
            };
        });
        must(metrics.boxDisplay === 'flex', `#siBatchBox computed display 应为 flex，实得 ${metrics.boxDisplay}`);
        must(metrics.boxOverflow === 'hidden', `#siBatchBox computed overflow 应为 hidden（外层不滚的前提），实得 ${metrics.boxOverflow}`);
        must(metrics.bodyOverflowY === 'auto', `#siBatchBody computed overflow-y 应为 auto，实得 ${metrics.bodyOverflowY}`);
        must(metrics.bodyScrollHeight > metrics.bodyClientHeight, `#siBatchBody 应真实溢出（scrollHeight=${metrics.bodyScrollHeight} > clientHeight=${metrics.bodyClientHeight}）——22 张成员长内容下应触发真实滚动，非仅 CSS 声明`);
        must(metrics.headTop >= 0 && metrics.headBottom <= metrics.viewportHeight, `head 应仍在视口内（top=${metrics.headTop}, bottom=${metrics.headBottom}, viewportH=${metrics.viewportHeight}）——不被 body 溢出内容顶出`);
        must(metrics.footTop >= 0 && metrics.footBottom <= metrics.viewportHeight, `foot 应仍在视口内（top=${metrics.footTop}, bottom=${metrics.footBottom}, viewportH=${metrics.viewportHeight}）——不被 body 溢出内容顶出`);
        must(metrics.scrollTopAfterAttempt === 0, `外层 #siBatchBox 主动设 scrollTop=999 后应仍归零（实得 ${metrics.scrollTopAfterAttempt}）——overflow:hidden 吃掉滚动尝试，证明"不滚"是行为级不变量非仅初值巧合`);

        // ═══════════════════════════════════════════════════════════════
        // ③ 473 LOW-2 时间线三值：真实 PATCH 编辑 → 成员单时间线 display/class/D9 过滤器不移除
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ③ 473 LOW-2 时间线三值：release_info_edit 事件 display/class + D9 过滤器不移除 ──');
        const patchR = await fetchJson(`/api/sys-releases/${releaseId}`, adminTok, {
            method: 'PATCH', body: {
                title: `${TITLE_PREFIX}批次-已编辑-${Date.now()}`,
                version_tag: 'v0.0.2-relmg',
                release_note: 'RELMG 活体夹具·已编辑说明',
            },
        });
        await shotOnFail(page, patchR.status === 200 && patchR.body && patchR.body.changed === true, '3-patch-changed', `PATCH 编辑应 200 且 changed=true，实得 status=${patchR.status} body=${JSON.stringify(patchR.body)}`);

        const probeIssueId = taggedMembers[0].id;   // 该单已由②加单产生 release_add scope_change 事件（供 D9 对照）
        const openedOk = await page.evaluate(async (id) => {
            if (typeof siCloseBatch === 'function') siCloseBatch();
            if (typeof siOpenDrawer !== 'function') return false;
            await siOpenDrawer(id);
            return true;
        }, probeIssueId);
        must(openedOk === true, `siOpenDrawer(#${probeIssueId}) 应可调用（页面 JS 未加载/函数改名会返回 false）`);
        await page.waitForSelector('.si-timeline', { timeout: 8000 });
        await page.waitForTimeout(400);

        const editEvt = page.locator('.si-tl-evt', { hasText: '上线单信息修改' });
        await shotOnFail(page, (await editEvt.count()) >= 1, '3-edit-evt-present', 'release_info_edit 事件应渲染出「上线单信息修改」徽章');
        const editEvtClass = await editEvt.first().getAttribute('class');
        await shotOnFail(page, !!editEvtClass && editEvtClass.includes('si-tl-indigo'), '3-edit-evt-cls', `release_info_edit 徽章 class 应含 si-tl-indigo，实得 ${editEvtClass}`);

        const scopeEvt = page.locator('.si-tl-evt', { hasText: '加入上线单' });
        await shotOnFail(page, (await scopeEvt.count()) >= 1, '3-scope-evt-present', 'release_add scope_change 事件应渲染出「加入上线单」徽章（D9 对照组的前提：先确认过滤器有东西可过滤）');

        const filterChk = page.locator('input[onchange="siToggleTlReleaseScope(this.checked)"]');
        await shotOnFail(page, (await filterChk.count()) === 1, '3-filter-checkbox-present', '「隐藏上线单调整记录」过滤开关应渲染（本单含 release_add scope_change 事件，hasReleaseScopeTl 应为真）');
        await filterChk.check();
        await page.waitForTimeout(200);

        const editItemDisplayAfter = await editEvt.first().evaluate(el => getComputedStyle(el.closest('.si-tl-item')).display);
        await shotOnFail(page, editItemDisplayAfter !== 'none', '3-d9-edit-still-visible', `D9：过滤开关打开后 release_info_edit 所在 .si-tl-item computed display 不应为 none，实得 ${editItemDisplayAfter}`);
        const scopeItemDisplayAfter = await scopeEvt.first().evaluate(el => getComputedStyle(el.closest('.si-tl-item')).display);
        await shotOnFail(page, scopeItemDisplayAfter === 'none', '3-filter-scope-hidden', `对照组：过滤开关打开后 release_add 所在 .si-tl-item computed display 应为 none（证明过滤器真的生效，非摆设），实得 ${scopeItemDisplayAfter}`);

        // 关闭该单详情，回到批次详情供④删除。
        await page.evaluate(() => { if (typeof siCloseDrawer === 'function') siCloseDrawer(); });

        // ═══════════════════════════════════════════════════════════════
        // ④ S12 顺带：删除链路活体——同一批次（已积累 22 张成员 + 编辑留痕）删除
        //   ⭐ [codex 475 回卷 MED-1] 混合成员场景：删除前先用真实 void 端点把 taggedMembers[1] 转「已作废」
        //   （非 probeIssueId=taggedMembers[0]，避免与③/④b 复用的探针单冲突）——void 是"任意态→已作废"
        //   的终态转移且不清 release_id（S11 既有事实），该单转态后仍挂在本批次名下，天然构成 O4 §3 步骤
        //   ③放宽判据要处理的"已作废但仍挂批次"前置形态。选真实端点而非 raw SQL 直改：sys_issues.status
        //   列本身无 DB CHECK（已现场核实，index.js:686 一带定义无枚举约束），raw SQL 技术上可行，但真实
        //   端点更贴近生产路径，且顺带验证了"void 不清指针"这条断言本身。P=21/V=1（22 张里挑 1 张作废）。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ④ S12 删除链路活体（混合成员场景 P=21/V=1）：填 reason → 确认 → 列表刷新批次消失 ──');
        const voidTargetId = taggedMembers[1].id;
        const voidR = await fetchJson(`/api/sys-issues/${voidTargetId}/void`, adminTok, { method: 'POST', body: { reason: 'RELMG-混合场景-作废夹具' } });
        if (voidR.status !== 200) throw new Error(`[夹具-作废] 应 200，实得 ${voidR.status} ${JSON.stringify(voidR.body)}`);
        const voidTargetRowBefore = await dbGet('SELECT release_id, status FROM sys_issues WHERE id=?', [voidTargetId]);
        must(voidTargetRowBefore && voidTargetRowBefore.status === '已作废' && voidTargetRowBefore.release_id === releaseId, `[夹具-作废] #${voidTargetId} 应转「已作废」且 release_id 仍挂 #${releaseId}（void 不清指针，S11 既有事实），实得 ${JSON.stringify(voidTargetRowBefore)}`);
        const expectedPending = allMemberIds.length - 1;   // 21
        const expectedVoided = 1;

        await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${releaseId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        const delBtn = page.locator('#siBatchFoot button', { hasText: '删除上线单' });
        await shotOnFail(page, (await delBtn.count()) === 1, '4-del-btn-present', '「删除上线单」按钮应存在（admin ∧ planning ∧ 通知未启动）');
        await delBtn.click();
        await page.waitForSelector('#f_reason', { timeout: 5000 });
        const impactText = await page.locator('#siMBody').textContent();
        // 混合分支措辞逐字核对（P=21/V=1）：既要两个数字都对，也要两段措辞都在——"退回「待上线」"专属
        // pending 分支，"仅解除与本上线单的关联（保持「已作废」）"专属 voided 分支，同时出现才是混合分支
        // 真正生效（若代码退回旧的"全部退回待上线"单一文案，数字 21 恰好仍会出现在文本里，但不会出现
        // "仅解除与本上线单的关联"这句，故此断言不会被"数字凑巧对"的假象蒙混过关）。
        await shotOnFail(page, impactText.includes(String(expectedPending)) && impactText.includes(String(expectedVoided)) && impactText.includes('张待上线单据会退回「待上线」') && impactText.includes('张已作废单据仅解除与本上线单的关联（保持「已作废」）'), '4-impact-text-mixed', `二次确认弹窗应展示混合分支影响面（P=${expectedPending}/V=${expectedVoided}，两段措辞均须出现），实得文本片段=${impactText.slice(0, 260)}`);

        await page.fill('#f_reason', 'RELMG-删除原因-Playwright活体验证');
        const [delResp] = await Promise.all([
            page.waitForResponse(r => r.url().includes(`/sys-releases/${releaseId}`) && r.request().method() === 'DELETE'),
            page.click('#siMConfirm'),
        ]);
        const delBody = await delResp.json().catch(() => null);
        // member_count 契约不变（474 号既有契约=批次总成员数，非仅"退回待上线"那部分）——混合场景下仍应
        // 等于 22（21 pending + 1 voided），不因引入分状态措辞而拆分这个数字。
        await shotOnFail(page, delResp.status() === 200 && delBody && delBody.ok === true && delBody.id === releaseId && delBody.member_count === allMemberIds.length, '4-delete-response', `DELETE 应 200 且 {ok:true,id,member_count} 三键齐全一致（member_count 恒=批次总成员数，474 契约不变），实得 status=${delResp.status()} body=${JSON.stringify(delBody)}`);
        await page.waitForTimeout(700);

        const bodyAfterDelete = await page.locator('#siBatchBody').textContent();
        // [Opus 预筛 S12 回卷提示3] 原判据"不含 releaseNo"单独存在时是个空转面——「加载中…」「加载失败」
        //   两个过渡/异常态文案同样不含 releaseNo，若渲染卡在其中一态本断言也会误判绿。补一条在场证明：
        //   显式排除这两个过渡态文案，证明我们看到的确实是"成功渲染的列表"而非"看似干净的空转"。
        await shotOnFail(page, !bodyAfterDelete.includes('加载中') && !bodyAfterDelete.includes('加载失败'), '4-list-in-scope', `删除后 #siBatchBody 应已脱离"加载中/加载失败"过渡态（在场证明，排除"看似不含批次号实为空转"假绿），实得文本片段=${bodyAfterDelete.slice(0, 120)}`);
        await shotOnFail(page, !bodyAfterDelete.includes(releaseNo), '4-list-refreshed', `删除后应回列表且 #siBatchBody 不应再含已删批次号 ${releaseNo}`);

        // 权威核对：DB 直查（UI 断言只证"看起来对"，DB 断言证"真的对"）。混合场景下按 pending/voided
        // 两类分别断言（原"全部退回待上线"单一断言在此形态下已不成立，voided 那张应保持终态）。
        const relRow = await dbGet('SELECT id FROM sys_releases WHERE id=?', [releaseId]);
        must(!relRow, `sys_releases #${releaseId} 应已物理删除，实得 ${JSON.stringify(relRow)}`);
        const survivors = await dbAll(`SELECT id, release_id, status FROM sys_issues WHERE id IN (${allMemberIds.map(() => '?').join(',')})`, allMemberIds);
        must(survivors.length === allMemberIds.length, `应查到全部 ${allMemberIds.length} 张成员单，实得 ${survivors.length}`);
        const pendingSurvivors = survivors.filter(r => r.id !== voidTargetId);
        const badPending = pendingSurvivors.filter(r => r.release_id !== null || r.status !== '待上线');
        must(pendingSurvivors.length === expectedPending && badPending.length === 0, `除已作废那张外，其余 ${expectedPending} 张成员单删除后应 release_id=NULL 且 status 仍「待上线」，异常 ${badPending.length} 张：${JSON.stringify(badPending)}`);
        const voidedSurvivor = survivors.find(r => r.id === voidTargetId);
        must(!!voidedSurvivor && voidedSurvivor.release_id === null && voidedSurvivor.status === '已作废', `已作废成员 #${voidTargetId} 删除批次后应 release_id=NULL 且 status 仍「已作废」（D10：终态不因批次删除而位移，不误判为退回待上线），实得 ${JSON.stringify(voidedSurvivor)}`);
        // [Opus 预筛 S12 回卷提示4] 原判据 `!!auditRow`（dbGet 只取首行）只证"至少存在 1 条"，若审计写入
        //   重复（如 bug 导致同一批次写了 2 条 delete 审计），本判据仍会误判绿——"恰 1 条"的措辞需要真的
        //   用 COUNT(*) 严格核对，而非"存在性"代替"计数"。
        const auditCountRow = await dbGet(`SELECT COUNT(*) c FROM sys_release_audit WHERE release_no=? AND action='delete'`, [releaseNo]);
        const auditCount = auditCountRow ? auditCountRow.c : 0;
        must(auditCount === 1, `sys_release_audit 应恰留 1 条 release_no=${releaseNo} 的 action='delete' 记录（COUNT(*) 严格核对，非仅存在性判断），实得 ${auditCount} 条`);

        // ═══════════════════════════════════════════════════════════════
        // ④b release_deleted 徽章活体（[Opus 预筛 S12 回卷提示1] layer_green 收口）：③已给
        //   release_info_edit 补齐 display/class/D9 三值活体，同批新增的 release_deleted 码若不补同款
        //   三值活体，静默降级（如漏注册 SI_TL_CLS 导致灰徽章、或误入 SI_TL_RELEASE_SCOPE_LABEL 导致被
        //   D9 过滤器误伤）不会被任何断言拦住——只有后端 timeline 表里"这行确实写了"，前端"显示对不对"
        //   完全没人管，是典型的分层实现"层内全绿≠功能可用"盲区。probeIssueId（taggedMembers[0]）在
        //   ④的删除中属"待上线"分支成员，会收到一条 action_code='release_deleted' 的独立留痕行。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ④b release_deleted 徽章活体：删除后重开成员单时间线 display/class/D9 ──');
        // ⚠️ 复盘实证（首跑撞见）：siBatchOverlay 此刻仍是 open 态（④删除成功后停在批次列表视图，未曾
        //   关闭）——不先 siCloseBatch() 直接 siOpenDrawer 会让抽屉渲染在批次面板"底下"，siBatchOverlay
        //   （fixed 定位、遮罩层）拦截掉对抽屉内部元素的全部点击，checkbox .check() 因此永久等不到可点
        //   状态而超时。同 ③ 处 siCloseBatch();siOpenDrawer(id) 同款先例，此处补齐。
        const reopenedOk = await page.evaluate(async (id) => {
            if (typeof siCloseBatch === 'function') siCloseBatch();
            if (typeof siOpenDrawer !== 'function') return false;
            await siOpenDrawer(id);
            return true;
        }, probeIssueId);
        must(reopenedOk === true, `删除后重开 siOpenDrawer(#${probeIssueId}) 应可调用（页面 JS 未加载/函数改名会返回 false）`);
        await page.waitForSelector('.si-timeline', { timeout: 8000 });
        await page.waitForTimeout(400);

        const deletedEvt = page.locator('.si-tl-evt', { hasText: '上线单已删除' });
        await shotOnFail(page, (await deletedEvt.count()) >= 1, '4b-deleted-evt-present', 'release_deleted 事件应渲染出「上线单已删除」徽章');
        const deletedEvtClass = await deletedEvt.first().getAttribute('class');
        await shotOnFail(page, !!deletedEvtClass && deletedEvtClass.includes('si-tl-red'), '4b-deleted-evt-cls', `release_deleted 徽章 class 应含 si-tl-red，实得 ${deletedEvtClass}`);

        // D9：过滤开关状态是会话级变量（关抽屉不重置，见 siToggleTlReleaseScope 处注释），③已勾选过；
        //   此处不依赖该隐性状态承接——显式读取当前勾选态，未勾选则主动勾上，使本组断言自洽、不依赖③
        //   的执行顺序或其中间状态。
        const filterChk2 = page.locator('input[onchange="siToggleTlReleaseScope(this.checked)"]');
        await shotOnFail(page, (await filterChk2.count()) === 1, '4b-filter-checkbox-present', '「隐藏上线单调整记录」过滤开关应仍渲染（本单仍含 release_add scope_change 历史事件）');
        if (!(await filterChk2.isChecked())) await filterChk2.check();
        await page.waitForTimeout(200);

        const deletedItemDisplayAfter = await deletedEvt.first().evaluate(el => getComputedStyle(el.closest('.si-tl-item')).display);
        await shotOnFail(page, deletedItemDisplayAfter !== 'none', '4b-d9-deleted-still-visible', `D9：过滤开关打开后 release_deleted 所在 .si-tl-item computed display 不应为 none，实得 ${deletedItemDisplayAfter}`);

        // ═══════════════════════════════════════════════════════════════
        // ⑤ [codex 477 三审终解+四审 HIGH/MED-2] SI_ESC_ROUTER 集中路由器浏览器回归——静态守卫只能证
        //   "代码写没写对"，证不了"浏览器真实按键事件下路由器的运行时行为是否真的如设计"。用真实
        //   page.keyboard.press('Escape') 驱动，拆两类用例：
        //   a) siModal 避让类：批次面板开着 + 其上叠一个通用 siModal（siReleaseDeleteModal，siModalOverlay
        //      在 SI_ESC_LAYERS 里登记为**阻塞层**——close:null）→按一次 Esc→两层都不应关（路由器遍历
        //      到 siModalOverlay 这一项，命中 open 后因 close 为 null 只消费 Esc 不产生关闭动作）；取消
        //      弹窗解除叠层后再按 Esc（正向对照）→批次面板应正常关闭——证明路由器新结构没有连累"没有
        //      叠层时 Esc 本该正常生效"这个基线场景。
        //   b) 路由消费类（[codex 477 四审 MED-2] 改真实生命周期）：验证路由器"从上往下找第一个 open
        //      的层，只关它"这条核心逻辑——批次面板 open 下用 page.evaluate 调用**真实 siOpenLightbox
        //      (dataURL, caption)** 打开（1×1 透明 GIF 内联 data URL，不需要真实附件图，走的是与生产
        //      环境完全相同的函数入口，不再是直接操纵 class 模拟）→按一次 Esc→断言：show 类已摘除、
        //      img.src 已清空、body.overflow 已恢复到打开前的值、批次面板仍 open（只关最上层，不连带
        //      关下层）→再按一次 Esc→批次面板应关闭（级联：上层已清空，这次轮到关它）。断言面依据现场
        //      读到的 siOpenLightbox/siCloseLightbox 真实实现（Sys_Iteration.html :9527/:9540 一带）：
        //      open 时 img.src=url、首次打开快照 body.overflow 到 siLbPrevOverflow 再置 'hidden'；close
        //      时 img.src=''、body.overflow 恢复为 siLbPrevOverflow（非固定空串，故断言用"恢复到打开前
        //      捕获的实际值"而非硬编码 ''）。FlowGuide/DutyRoster 与 Lightbox 三者在 SI_ESC_LAYERS 里是
        //      结构同构的数组项，路由器对它们走的是同一段遍历代码（唯一差异是 id/openClass/close 三个
        //      字段值），覆盖 Lightbox 一层已结构性验证整条路由逻辑，不需要逐层重复同款用例。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ⑤ codex 477 三审终解：SI_ESC_ROUTER 集中路由器浏览器回归 ──');
        const escCreateR = await fetchJson('/api/sys-releases', adminTok, {
            method: 'POST', body: { title: `${TITLE_PREFIX}Esc回归批次-${Date.now()}`, version_tag: 'v0.0.1-relmg-esc' },
        });
        if (escCreateR.status !== 201) throw new Error(`[夹具-Esc回归批次] 应 201，实得 ${escCreateR.status} ${JSON.stringify(escCreateR.body)}`);
        escReleaseId = escCreateR.body.id;
        escReleaseNo = escCreateR.body.release_no;
        console.log(`  （Esc 回归夹具批次 #${escReleaseId} / ${escReleaseNo} 已建，零成员——删除按钮可见性不依赖成员数）`);

        console.log('  — a) siModal 避让类 ──');
        await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${escReleaseId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        const escDelBtn = page.locator('#siBatchFoot button', { hasText: '删除上线单' });
        await shotOnFail(page, (await escDelBtn.count()) === 1, '5a-del-btn-present', '「删除上线单」按钮应存在（Esc 回归夹具，admin ∧ planning ∧ 通知未启动）');
        await escDelBtn.click();
        await page.waitForSelector('#f_reason', { timeout: 5000 });
        const modalOpenBefore = await page.evaluate(() => ({
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, modalOpenBefore.modal === true && modalOpenBefore.batch === true, '5a-pre-state', `按 Esc 前置状态：删除确认弹窗与批次面板应同时 open，实得 ${JSON.stringify(modalOpenBefore)}`);

        // 叠层态：删除确认弹窗（siModal，SI_ESC_LAYERS 阻塞层）叠在批次面板之上——按一次 Esc。
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterFirstEsc = await page.evaluate(() => ({
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, afterFirstEsc.modal === true, '5a-stacked-modal-stays-open', `叠层态按 Esc 后：删除确认弹窗应仍 open（红：若被关闭，说明 Esc 被某处误消费/误路由到了它身上），实得 ${JSON.stringify(afterFirstEsc)}`);
        await shotOnFail(page, afterFirstEsc.batch === true, '5a-stacked-batch-not-closed', `叠层态按 Esc 后：批次面板应仍 open（红：阻塞层机制失效——siModalOverlay open 时应只消费 Esc 不产生关闭动作，若为 false 说明穿透去关了下层批次面板），实得 ${JSON.stringify(afterFirstEsc)}`);

        // 单层态（正向对照）：取消删除确认弹窗解除叠层，仅剩批次面板 open，再按一次 Esc。
        await page.locator('#siModalBox button', { hasText: '取消' }).click();
        await page.waitForTimeout(150);
        const afterCancel = await page.evaluate(() => ({
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, afterCancel.modal === false && afterCancel.batch === true, '5a-cancel-unstack', `取消删除确认弹窗后：叠层应解除（modal=false）、批次面板仍 open（batch=true），实得 ${JSON.stringify(afterCancel)}`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterSecondEsc = await page.evaluate(() => document.getElementById('siBatchOverlay').classList.contains('open'));
        await shotOnFail(page, afterSecondEsc === false, '5a-unstacked-esc-closes', `正向对照：无叠层时按 Esc，批次面板应正常关闭（红：若仍 true，说明路由器新结构误伤了"没有叠层时 Esc 本该正常生效"这一基线场景）——实得 ${afterSecondEsc}`);

        console.log('  — b) 路由消费类：真实 siOpenLightbox 生命周期叠开，验证"只关最上层+逐层级联"——');
        await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${escReleaseId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        const batchOpenForRouteTest = await page.evaluate(() => document.getElementById('siBatchOverlay').classList.contains('open'));
        await shotOnFail(page, batchOpenForRouteTest === true, '5b-batch-open-precondition', `路由消费类前置：重新深链后批次面板应 open，实得 ${batchOpenForRouteTest}`);

        // [codex 477 四审 MED-2] 真实生命周期：调用真实 siOpenLightbox(dataURL, caption)，1×1 透明 GIF
        // 内联 data URL（不需要真实附件图，走与生产环境完全相同的函数入口，非直接操纵 class 模拟）。
        const LIGHTBOX_TEST_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        const overflowBefore = await page.evaluate(() => document.body.style.overflow);
        await page.evaluate((url) => siOpenLightbox(url, 'RELMG-Esc回归-lightbox测试'), LIGHTBOX_TEST_URL);
        const preRouteState = await page.evaluate(() => ({
            lightbox: document.getElementById('siImgLightbox').classList.contains('show'),
            imgSrc: document.getElementById('siImgLightboxImg').src,
            overflow: document.body.style.overflow,
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, preRouteState.lightbox === true, '5b-pre-lightbox-show', `siOpenLightbox 后 lightbox 应带 show 类，实得 ${JSON.stringify(preRouteState)}`);
        await shotOnFail(page, preRouteState.imgSrc === LIGHTBOX_TEST_URL, '5b-pre-img-src', `siOpenLightbox 后 img.src 应等于传入的 data URL，实得 ${preRouteState.imgSrc}`);
        await shotOnFail(page, preRouteState.overflow === 'hidden', '5b-pre-overflow-hidden', `siOpenLightbox 后 body.style.overflow 应为 'hidden'（真实实现行为），实得 ${JSON.stringify(preRouteState.overflow)}`);
        await shotOnFail(page, preRouteState.batch === true, '5b-pre-batch-open', `模拟叠层前置状态：批次面板应仍 open，实得 ${JSON.stringify(preRouteState)}`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterRouteFirstEsc = await page.evaluate(() => ({
            lightbox: document.getElementById('siImgLightbox').classList.contains('show'),
            // [test_assertion_self_error] 这里必须读 getAttribute('src')（原始属性值）而非 .src（IDL
            //   属性）——`img.src = ''` 之后，浏览器的 .src getter 会把空字符串解析成"相对当前文档的
            //   URL"，读回来是当前页面的完整地址（如 http://localhost:3000/Sys_Iteration.html?...），
            //   不是空串。这是 DOM 规范本身的行为，不是 siCloseLightbox 的实现问题——用 getAttribute
            //   才能拿到真正被赋的原始值 ''。首次探测就撞见（现场核实：先跑一次拿到 IDL 属性的真实
            //   返回值，确认是"当前页面 URL"而非破损值，再改用 getAttribute 修正断言，非凭空猜测）。
            imgSrc: document.getElementById('siImgLightboxImg').getAttribute('src'),
            overflow: document.body.style.overflow,
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, afterRouteFirstEsc.lightbox === false, '5b-lightbox-closed-first', `路由器应找到"从上往下第一个 open 的层"（真实打开的 lightbox，z-3000 最高）并关它：按一次 Esc 后 show 类应已摘除，实得 ${JSON.stringify(afterRouteFirstEsc)}`);
        await shotOnFail(page, afterRouteFirstEsc.imgSrc === '', '5b-lightbox-img-cleared', `siCloseLightbox 真实实现会清空 img.src——按 Esc 关闭后 getAttribute('src') 应为空串，实得 ${JSON.stringify(afterRouteFirstEsc.imgSrc)}`);
        await shotOnFail(page, afterRouteFirstEsc.overflow === overflowBefore, '5b-lightbox-overflow-restored', `siCloseLightbox 真实实现会把 body.style.overflow 恢复为打开前捕获的值（非固定空串）——打开前=${JSON.stringify(overflowBefore)}，关闭后实得=${JSON.stringify(afterRouteFirstEsc.overflow)}`);
        await shotOnFail(page, afterRouteFirstEsc.batch === true, '5b-batch-untouched-first', `一次 Esc 只关一层——批次面板（z-1100，非本次被选中的最上层）不应被这次按键连带关闭，实得 ${JSON.stringify(afterRouteFirstEsc)}`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterRouteSecondEsc = await page.evaluate(() => document.getElementById('siBatchOverlay').classList.contains('open'));
        await shotOnFail(page, afterRouteSecondEsc === false, '5b-batch-closed-second', `级联验证：Lightbox 层已摘除，第二次 Esc 应轮到关闭批次面板（路由器每次重新从头找"当前最上层"，不依赖上一次的判断结果），实得 ${afterRouteSecondEsc}`);

        // [codex 477 五审 MED] c) 三层异常同开回归——直接钉住"阻塞层（siModalOverlay）位于 Lightbox
        //   之后"这条优先级语义（HIGH 修复的直接证据用例）：批次面板+删除确认弹窗叠开（真实
        //   siReleaseDeleteModal 路径）之上，再用真实 siOpenLightbox 打开 Lightbox，凑出结构上罕见但
        //   非不可能的三层同开态。第一次 Esc 应先关最上层 Lightbox（modal/批次两层原封不动）；第二次
        //   Esc 此时最上层变成 modal（阻塞层）——只消费不关闭，批次面板仍不受影响。若未来有人把
        //   siModalOverlay 插回 Lightbox 之前，或重新引入遍历前的单独 return 特判，本组用例会翻红。
        console.log('  — c) 三层异常同开回归：Lightbox+modal+批次面板叠开，钉住阻塞层优先级语义——');
        await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${escReleaseId}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        const escDelBtn2 = page.locator('#siBatchFoot button', { hasText: '删除上线单' });
        await shotOnFail(page, (await escDelBtn2.count()) === 1, '5c-del-btn-present', '「删除上线单」按钮应存在（三层同开回归夹具）');
        await escDelBtn2.click();
        await page.waitForSelector('#f_reason', { timeout: 5000 });
        await page.evaluate((url) => siOpenLightbox(url, 'RELMG-三层同开回归-lightbox测试'), LIGHTBOX_TEST_URL);
        const triplePreState = await page.evaluate(() => ({
            lightbox: document.getElementById('siImgLightbox').classList.contains('show'),
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, triplePreState.lightbox === true && triplePreState.modal === true && triplePreState.batch === true, '5c-pre-state-triple-open', `三层同开前置状态：lightbox/modal/batch 应同时为 true，实得 ${JSON.stringify(triplePreState)}`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterTripleFirstEsc = await page.evaluate(() => ({
            lightbox: document.getElementById('siImgLightbox').classList.contains('show'),
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, afterTripleFirstEsc.lightbox === false, '5c-first-esc-lightbox-closed', `三层同开第一次 Esc 应关最上层 Lightbox（z-3000，阻塞层 siModalOverlay 排在它之后不应挡住它），实得 ${JSON.stringify(afterTripleFirstEsc)}`);
        await shotOnFail(page, afterTripleFirstEsc.modal === true, '5c-first-esc-modal-untouched', `三层同开第一次 Esc 不应动 modal（这次轮到的是 Lightbox，非 modal），实得 ${JSON.stringify(afterTripleFirstEsc)}`);
        await shotOnFail(page, afterTripleFirstEsc.batch === true, '5c-first-esc-batch-untouched', `三层同开第一次 Esc 不应动批次面板（一次只关最上层），实得 ${JSON.stringify(afterTripleFirstEsc)}`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterTripleSecondEsc = await page.evaluate(() => ({
            modal: document.getElementById('siModalOverlay').classList.contains('open'),
            batch: document.getElementById('siBatchOverlay').classList.contains('open'),
        }));
        await shotOnFail(page, afterTripleSecondEsc.modal === true, '5c-second-esc-modal-blocked', `三层同开第二次 Esc：Lightbox 已清空，最上层轮到 modal（阻塞层）——应只消费 Esc 不关闭，modal 仍应 open，实得 ${JSON.stringify(afterTripleSecondEsc)}——这正是钉住"阻塞层排在 Lightbox 之后"优先级语义的核心断言：若 siModalOverlay 被插回数组首位或恢复成遍历前的独立 return 特判，本条会因为"根本没走到 Lightbox 那一步就已经被挡住"而在上面 5c-first-esc-lightbox-closed 处翻红，或因为顺序错乱在这里翻红`);
        await shotOnFail(page, afterTripleSecondEsc.batch === true, '5c-second-esc-batch-untouched', `三层同开第二次 Esc：modal 是阻塞层不产生关闭动作，批次面板不应被连带关闭，实得 ${JSON.stringify(afterTripleSecondEsc)}`);

        // 现场清理：取消删除确认弹窗，不留半开状态给后续步骤（本组是⑤的最后一段，之后即汇总，无
        // 下游步骤依赖此状态，但显式清理是既有惯例，同⑤a收尾同款手法）。
        await page.locator('#siModalBox button', { hasText: '取消' }).click();
        await page.waitForTimeout(150);

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
        failDetails.push('顶层异常: ' + (e && e.message || e));
    } finally {
        if (browser) {
            try { await browser.close(); }
            catch (e) { fail++; failDetails.push('浏览器关闭失败: ' + (e && e.message || e)); console.warn('浏览器关闭失败:', e && e.message || e); }
        }
        let cleanupErrorCount = 0;
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_fast_release_executors', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        const RESIDUAL_CHECK_TABLES = [...CHILD_TABLES, 'sys_issue_attachments', 'sys_issue_release_commit_snapshots', 'sys_issue_delete_audit'];
        for (const id of createdIssueIds) {
            try {
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        // 批次若因流程中途异常未走到④的删除步骤，兜底清理（正常路径下批次早已在④内被真实 DELETE 端点删除，
        // 这里只处理"跑到一半异常退出"的残留场景，非重复删除）。
        if (releaseId) {
            try {
                await dbRun('DELETE FROM sys_release_executors WHERE release_id=?', [releaseId]);
                await dbRun('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?', [releaseId]);
                await dbRun('DELETE FROM sys_releases WHERE id=?', [releaseId]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具批次兜底清理失败 #${releaseId}: ${e.message}`); }
        }
        // 审计表留痕按 release_no 精确清（release_id 在批次删除后不再有 sys_releases 行可关联，只能靠冗余存的 release_no 定位）。
        if (releaseNo) {
            try { await dbRun('DELETE FROM sys_release_audit WHERE release_no=?', [releaseNo]); }
            catch (e) { cleanupErrorCount++; console.warn(`审计表清理失败 release_no=${releaseNo}: ${e.message}`); }
        }
        // [codex 477 复审 HIGH·⑤] Esc 回归夹具批次——与 releaseId 不同，⑤全程只打开/取消了删除确认弹窗，
        // 从未真正调用 DELETE 端点，该批次在正常路径下**本就还活着**（非"跑到一半异常退出"才需要的兜底），
        // 这里是唯一、必经的清理点。零成员，无需清 sys_release_executors/commit_snapshots/audit（未产生）。
        if (escReleaseId) {
            try { await dbRun('DELETE FROM sys_releases WHERE id=?', [escReleaseId]); }
            catch (e) { cleanupErrorCount++; console.warn(`Esc 回归夹具批次清理失败 #${escReleaseId}: ${e.message}`); }
        }
        const idList = createdIssueIds.length ? createdIssueIds : [-1];
        const placeholders = idList.map(() => '?').join(',');
        let totalResidual = 0;
        const residualDetail = {};
        for (const t of [...RESIDUAL_CHECK_TABLES, 'sys_issues']) {
            const col = t === 'sys_issues' ? 'id' : 'issue_id';
            const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
            const c = r ? r.c : 0;
            residualDetail[t] = c;
            totalResidual += c;
        }
        if (releaseId) {
            const relResidual = await dbGet('SELECT COUNT(*) c FROM sys_releases WHERE id=?', [releaseId]);
            residualDetail.sys_releases = (relResidual && relResidual.c) || 0;
            totalResidual += residualDetail.sys_releases;
        }
        if (releaseNo) {
            const auditResidual = await dbGet('SELECT COUNT(*) c FROM sys_release_audit WHERE release_no=?', [releaseNo]);
            residualDetail.sys_release_audit = (auditResidual && auditResidual.c) || 0;
            totalResidual += residualDetail.sys_release_audit;
        }
        if (escReleaseId) {
            const escRelResidual = await dbGet('SELECT COUNT(*) c FROM sys_releases WHERE id=?', [escReleaseId]);
            residualDetail.sys_releases_esc = (escRelResidual && escRelResidual.c) || 0;
            totalResidual += residualDetail.sys_releases_esc;
        }
        console.log(`  🧹 夹具清理完成（成员单 ${createdIssueIds.length} 条 + 批次 #${releaseId}，清理异常 ${cleanupErrorCount} 次，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            failDetails.push(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) { console.log('失败清单：'); failDetails.forEach(m => console.log('  - ' + m)); process.exit(1); }
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
