/**
 * ⚠️【S3·新链已接·S8 活体验证】⚠️
 * codex 382-6 曾在此记录"S2 拆直上后本夹具结构性断裂，跑前必读，此前请勿运行"——**该警示已解除**：
 * S3 落地了确认端点 POST /sys-issues/:id/fast-release-exec-confirm + 共享翻牌内核，本文件夹具已同批
 * 改造为真实新链路（受理→指派→估时→授权→submit 挂牌→值班执行人 confirm 翻牌→
 * post_release_acceptance='pending'），不再依赖已拆除的 submit direct_release=true 分支。
 * ⚠️ 本次改造只做到 **node -c 语法检查通过**（S3 阶段无 live server，见 S3 §4 交付范围）——**尚未真实
 * 跑过一次**，代码逻辑经过设计推导但未经真实浏览器/真实 HTTP 往返验证，S8（活体验证阶段）首个待办
 * 就是启动本地 server 后真跑一次本文件，确认 T1-T5/T1c/T4b/T5b 全绿，并核对夹具新增的"当日值班"探测
 * /插入逻辑（见 mkFastlanePendingBug 函数内注释）在真实库上表现符合预期（尤其"当日已有别人值班"这条
 * 防御分支，本地测试环境很可能触发不到，需刻意构造一次覆盖）。
 *
 * 系统迭代·F-3「补验收弹窗 fail 说明必填」前端 Playwright 冒烟
 * （用户拍板 P8·后端已改 400 POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-post-release-accept-fail-note-playwright.js
 *
 * 夹具：真实链路造出「先行上线待补验收」态（不用 SQL 造态）——受理→指派→估时→授权(fast-release-authorize)
 *   →submit（普通提交，无 direct_release 字段——S2 已拆直上分支）挂牌 → 值班执行人
 *   fast-release-exec-confirm 确认执行（唯一执行人=末位，触发共享翻牌内核翻牌）落地
 *   online_source='authorized_fastlane' ∧ post_release_acceptance='pending'。与
 *   scripts/verify-sys-eta-overrun-snapshot.js 新增的 [F2] 组（S3 同批重建）走同一条确认端点，但该组
 *   为效率用 SQL 造态省略"如何走到待验证"的过程；本文件是 Playwright 前端冒烟，全程走真实 API+真实
 *   浏览器交互，不省略任何一步（补验收弹窗测的正是"翻牌之后"这层前端交互，前置链路必须是真实产物）。
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
const net = require('net');
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
// [S3 收口新增] dbRun——新链需要在夹具里造"当日值班"这一条真实数据（submit 挂牌逻辑读的是真实
//   sys_release_duty_roster，非 mock），此前文件只读不写，现补写通道。
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

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
// [R7 补漏] 见 mkFastlanePendingBug 内注释——非 null 时记录本文件测试运行期间真正插入的当日值班行 id，
// 供 main() 的 finally 精确回滚（仅删本次插入的那一行，不做"当日日期全表扫"这类可能误删真实数据的操作）。
let dutyInsertTracking = null;
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

    // [S3 收口·新链] submit 挂牌需要"当日值班"这一条真实数据才会真落一个执行人行（0/0 语义否则不挂牌，
    //   confirm 端点也就无人可确认）。partial UNIQUE(duty_date) WHERE removed_at IS NULL 保证同日至多一
    //   人在册——若运行环境当日已有别人在值班（真实生产/开发库常见），直接插入会撞唯一索引崩溃。防御：
    //   先查当日是否已有在册值班人，有则复用其 user_id/user_name 做本次确认的操作者（不新插行、不改变
    //   任何既有真实数据）；没有才插入 DEV_ID 作为当日值班人（测试环境常见的干净状态）。
    let dutyUserId = DEV_ID, dutyToken = devTok;
    const existingDuty = await dbGet(`SELECT user_id, user_name FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    if (existingDuty) {
        dutyUserId = Number(existingDuty.user_id);
        // 已有值班人未必是 DEV_ID（本文件固定账号）——若非同一人，签一个该值班人身份的 token 供后续
        // confirm 步骤使用（避免"提交是 devTok，确认要另一个人"这种跨账号麻烦，直接以真实值班人身份走完）。
        dutyToken = dutyUserId === DEV_ID ? devTok : await signAs(dutyUserId);
    } else {
        // [R7 补漏] 此前本分支插入的值班行从未被 finally 清理——本文件调用 mkFastlanePendingBug 两次
        // （T1-T4/T5），但 partial UNIQUE(duty_date) 保证同日至多一行，故本 INSERT 分支全程最多真正
        // 执行一次（第二次调用时 existingDuty 已非空，命中上面的 if 分支）。用模块级 dutyInsertTracking
        // 记录本次真正插入的行 id，供 main() 的 finally 精确回滚（同 test-sys-fastlane-playwright.js 的
        // duty.insertedRowId 范式）——不删会让本地库永久残留一条测试插入的"今天谁值班"记录。
        const insRes = await dbRun(
            `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name)
             VALUES (date('now','localtime'), ?, '示例开发A', ?, '管理员')`,
            [DEV_ID, ADMIN_ID]
        );
        dutyInsertTracking = { insertedRowId: insRes.lastID };
    }

    // submit 普通提交（不再有 direct_release 字段——S2 已拆直上分支，该字段即便传了也零效果，本夹具
    // 干脆不传，与真实前端一致）：花名册全完成 + 活跃授权 ⇒ 同事务挂牌，产出一条 sys_fast_release_executors
    // 行（值班人=上面解出的 dutyUserId）+ timeline fast_release_staged。
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${devTok}` },
        body: JSON.stringify({
            mode: 'commits', self_tested: true, test_env_deployed: true,
            bug_cause_note: 'PRA 探针：bug 产生原因',
            commits: [{ component: 'backend', commit_ref: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
        }),
    });
    const submitBody = await resp.json();
    if (resp.status !== 200) throw new Error(`[夹具-提交] 应 200，实得 ${resp.status} ${JSON.stringify(submitBody)}`);
    if (submitBody.main_status !== '待验证') throw new Error(`[夹具-提交] main_status 应为「待验证」，实得 ${submitBody.main_status}`);

    const execRow = await dbGet(
        `SELECT id FROM sys_fast_release_executors WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL`,
        [id, dutyUserId]
    );
    if (!execRow) throw new Error(`[夹具-挂牌] 未查到值班人(user_id=${dutyUserId})的挂牌执行人行——当日值班配置可能未生效`);

    // 值班执行人（唯一，本夹具花名册只有一名开发=唯一值班人）确认执行 ⇒ 末位翻牌，共享翻牌内核落
    // released_at/online_source='authorized_fastlane'/post_release_acceptance='pending'。
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/fast-release-exec-confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dutyToken}` }, body: '{}',
    });
    const confirmBody = await resp.json();
    if (resp.status !== 200) throw new Error(`[夹具-确认翻牌] 应 200，实得 ${resp.status} ${JSON.stringify(confirmBody)}`);
    if (confirmBody.flipped !== true) throw new Error(`[夹具-确认翻牌] 应为末位翻牌（flipped=true），实得 ${JSON.stringify(confirmBody)}`);
    if (confirmBody.main_status !== '已上线') throw new Error(`[夹具-确认翻牌] main_status 应为「已上线」，实得 ${confirmBody.main_status}`);

    const row = await dbGet('SELECT online_source, post_release_acceptance FROM sys_issues WHERE id=?', [id]);
    if (row.online_source !== 'authorized_fastlane' || row.post_release_acceptance !== 'pending') {
        throw new Error(`[夹具-前置] 期望 online_source=authorized_fastlane∧post_release_acceptance=pending，实得 ${JSON.stringify(row)}`);
    }
    return id;
}

// [S8-S10 合并收口批 F9] 同既有 test-sys-release-panel-c2b2-playwright.js:188-195 范式（playwright_suite_gotchas.md
// 第4条）：本套件契约=外部已启动的 dev server:3000。跑前用端口 Listen 探测代替"直接 goto 然后让
// Playwright 自己超时"，给出精确的"server 未起"错误而非含糊卡在某条断言上。探测放在 main() 最前面、
// try/finally 块之外——server 未监听时直接 throw，永不会进入下方拥有 createdIds 清理逻辑的 try/finally，
// 避免对一个从未真正建过任何夹具的空/不完整 createdIds 数组跑 DELETE。
// [R4] host/port 从 BASE_URL 派生（new URL），不再硬编码 127.0.0.1:3000——探测目标须与后续所有
// fetch/goto 请求打到同一处，否则"探测通过"对本次真正要用的 BASE_URL 毫无意义。
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
// [R4] TCP 连接成功只证明"有进程在监听端口"，不证明"监听者是目标 server.js"（同 MEMORY「生产 PM2
// 孤儿监听恢复」踩坑：孤儿进程也能外网 200）。追加一次应用层 readiness 探测——命中本模块专属挂载的
// /api/sys-issues/_readiness，不带 token 应得到 authenticateToken 中间件产出的 401，精确错误形状即
// "这是目标 server.js 且路由已挂载"的证据。
async function ensureAppReadinessEndpoint() {
    const r = await fetch(`${BASE_URL}/api/sys-issues/_readiness`).catch((e) => {
        throw new Error(`应用 readiness 探测请求失败（${e.message}）——端口监听者可能不是目标 server.js`);
    });
    if (r.status !== 401) {
        throw new Error(`应用 readiness 探测异常：期望 401（authenticateToken 未登录，证明路由存在且是本模块），实得 ${r.status}——监听该端口的可能不是目标 server.js（孤儿进程/端口被其它服务占用）`);
    }
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ [R4] 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');
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
        // 【2026-08-14 NEW-6】browser.close 独立 try/catch——此前直接 `await browser.close()` 不带
        // 自己的兜底：若它抛错（浏览器进程已崩溃/被杀等），异常会从本 finally 块整体冒出，导致下方
        // 库清理（issue 五子表+主表 DELETE/残留核对/值班表回滚/db.close）全部被跳过，本地库残留本次
        // 测试插入的孤儿数据——同 test-sys-fastlane-playwright.js 的同款问题（该文件此前也未修，本次
        // 一并同修，见该文件同位置注释）。改为 close 失败只计入 fail + 打印警告，不阻断后续清理——
        // 库清理是"无论浏览器关得干不干净都必须做"的独立职责，不能被 close 失败连带吞掉。
        try {
            await browser.close();
        } catch (e) {
            fail++;
            console.warn('浏览器关闭失败:', e && e.message || e);
        }
        // [S8-S10 合并收口批 F3 收口] 夹具清理——⚠️ 原注释"issue 删除会级联相关子表"不实：本项目 SQLite
        //   未开 PRAGMA foreign_keys/未声明 ON DELETE CASCADE，DELETE sys_issues 单表不会带走任何子表行，
        //   逐表显式 DELETE 才是清理生效的唯一路径（此前 dev_commits/sys_fast_release_executors 两张漏配，
        //   已在本地库残留孤儿行，见本批一次性清扫报告）。夹具走 submit(mode:'commits') + 授权+挂牌+末位
        //   翻牌全链路，实际触达 sys_issue_dev_commits（commits 提交）+ sys_fast_release_executors（挂牌行）
        //   两张，本次一并补齐；attachments/delete_audit/release_commit_snapshots 三张本夹具未上传附件/
        //   未删单/未触发批次发布，结构性够不着，无需清理。
        const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
        // [R7] 清理异常汇总——此前逐条 catch(e) => console.warn 只打印不影响退出码，一次清理失败很容易
        // 被大量正常输出淹没而被忽略，进程仍以 0 退出。改为累计计数，非零即拉低最终 exit code。
        let cleanupErrorCount = 0;
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_fast_release_executors', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        for (const id of createdIds) {
            try {
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        // [R7] 逐表核对 createdIds 对应行数=0（不止查主表，五张子表各自独立核对——子表 DELETE 若单独
        // 抛错但被上面 try/catch 吞掉继续跑主表 DELETE，旧写法只报"issue 已清理"不会暴露子表孤儿行）。
        const idList = createdIds.length ? createdIds : [-1];
        const placeholders = idList.map(() => '?').join(',');
        let totalResidual = 0;
        const residualDetail = {};
        for (const t of [...CHILD_TABLES, 'sys_issues']) {
            const col = t === 'sys_issues' ? 'id' : 'issue_id';
            const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
            const c = r ? r.c : 0;
            residualDetail[t] = c;
            totalResidual += c;
        }
        console.log(`  🧹 夹具清理完成（共创建 ${createdIds.length} 条，清理异常 ${cleanupErrorCount} 次，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            console.warn(`[R7] 夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        // [R7 补漏] 当日值班表测试插入行精确回滚——见 mkFastlanePendingBug 内 dutyInsertTracking 注释：
        // 此前本文件从未清理这行数据，每跑一次就在本地库永久留下一条测试插入的"今天谁值班"记录。
        if (dutyInsertTracking && dutyInsertTracking.insertedRowId) {
            try {
                await dbRun('DELETE FROM sys_release_duty_roster WHERE id=?', [dutyInsertTracking.insertedRowId]);
                const dutyRemain = await dbGet('SELECT COUNT(*) c FROM sys_release_duty_roster WHERE id=?', [dutyInsertTracking.insertedRowId]);
                if (dutyRemain && dutyRemain.c > 0) {
                    fail++;
                    console.warn(`[R7] 值班表测试插入行 #${dutyInsertTracking.insertedRowId} 清理后仍残留（应为 0，实得 ${dutyRemain.c}）`);
                }
            } catch (e) {
                fail++;
                console.warn(`夹具清理失败 duty roster #${dutyInsertTracking.insertedRowId}: ${e.message}`);
            }
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) process.exit(1);
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
