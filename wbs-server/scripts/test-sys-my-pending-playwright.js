/**
 * 「待我处理」全角色卡（方案 20260825_v1.3）·Phase P Commit 4·多角色 Playwright 活体验证
 * 用法：外部 server:3000 已起（本文件不自拉服务，见下方"server 编排"约定）后：
 *   node scripts/test-sys-my-pending-playwright.js
 *
 * ⚠️ 一次只跑一个写 db 的 Playwright——本文件直连 task_pool.db 造夹具 + 操作 sys_release_duty_roster
 *   全局单例表，与其余 test-sys-*-playwright.js 一样不支持并发跑多份实例（同 test-sys-fastlane-
 *   playwright.js 头部纪律，未重复整段搬运，此处仅点名）。
 *
 * server 编排（无人值守，spec §B）：本文件契约=外部 server:3000 已起（TCP+readiness 双探测照抄
 *   test-sys-fastlane-playwright.js:264-288，本文件内联同款两个探测函数）——本文件自身不 spawn/kill
 *   server 进程，起停 server 是调用方（主会话/agent）的职责：3000 无监听则从 wbs-server 目录起
 *   server（单命令、记 PID）；3000 已被占用则先跑 readiness 探测确认是本项目 server（401）再直接用，
 *   不是则停手报告，不抢占端口。
 *
 * 数据隔离：全部造数标题恒 MPPW- 前缀（共享面隔离约定，与 FLPW-/其它前缀区分）。
 *
 * 覆盖（spec §B + 方案 §6「Playwright 多角色」）：
 *   ① 四角色 token（admin/开发/对接人（受理人·待受理）/值班开发）各自登录，「待我处理」卡：
 *      出现与否（计数相对基线 +1）+ 点卡筛选结果行含本角色夹具单 + 筛选后列表行数与卡面数字一致；
 *      每张夹具单额外在**另一角色**视角下验证"不出现"（负例环：admin→开发/开发→对接人/对接人→值班/
 *      值班→开发），非仅测正例。
 *   ② 空态防困：对接人角色点卡筛选后，admin 侧把该单受理通过（脱离对接人「待受理」身份门），对接人
 *      页面内 siLoadList() 强制刷新（不重新登录/不重置筛选，siActiveStat 本就不进 URL/localStorage，
 *      见方案 N0 第 4 步核查），卡应仍在（不因 count→0 消失，siShouldRenderConditionalCard 的
 *      "count=0 但 activeStat===cardKey 仍渲染"分支）。
 *   ③ 三档视口（1280/1440/1920）：第一排统计卡（含「待我处理」条件卡）与第二排类型卡各自"同排
 *      offsetTop 一致"；两排全部卡 scrollWidth<=clientWidth 无溢出；卡标签 computed white-space=nowrap
 *      且 label 元素 scrollHeight<=clientHeight（真·单行，非仅静态文本扫描——codex 465 rec3：两排都测）。
 *
 * 夹具口径：当日值班读真实 sys_release_duty_roster（同 test-sys-fastlane-playwright.js 既定"当日已有
 * 别人值班"防御模式：先查，有则复用其身份；若该真实值班人恰与本文件另一固定测试角色（admin/开发/
 * 对接人）身份冲突，借用同文件 clearTodayDutyTemporarily 范式临时软删后插入本文件专属候选，finally
 * 精确还原——不改动/不误删任何真实业务数据）。
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
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-my-pending-playwright-shots');
const TITLE_PREFIX = 'MPPW-';

const ADMIN_ID = 1;
const DEV_ID = 8;       // 示例开发A（同既有 fastlane 套件复用账号——开发角色）
const LIAISON_ID = 13;  // 示例对接人（role=user，INTAKE_LIAISON_ELIGIBLE_ROLES 内——对接人/受理人角色）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0, skip = 0;
const failDetails = [];
// [2026-08-27 可跑性门改造] SKIP 必须出现在末尾汇总里，不得静默消失——skipDetails 与 failDetails 同构，
//   供末尾汇总行与失败清单一并打印，防止"改判据后 SKIP 悄悄发生但没人看得到"这种新的假绿面。
const skipDetails = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failDetails.push(msg); }
    return cond;
}
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `mypending-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}
// [平台测试铁律] JWT 注入 + login.html 中继跳转——鉴权页直接 goto 会被 checkAuth 销毁 context。
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
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

// ── server 编排探测（照抄 test-sys-fastlane-playwright.js:264-288，双探测：TCP 监听 + 应用层 readiness） ──
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

// ── 夹具：建单（止步「待受理」，供对接人/受理人身份场景直接用） ──
let seq = 0;
async function createBug(adminTok, titleTag, extra = {}) {
    seq++;
    const r = await fetchJson('/api/sys-issues', adminTok, {
        method: 'POST', body: {
            intake_contract_version: 2, type: 'bug', title: `${TITLE_PREFIX}${titleTag}-${seq}`, system_name: 'BMS', source: '内部',
            description: `「待我处理」全角色卡 Playwright 活体夹具-${seq}`, intake_liaison_id: LIAISON_ID,
            ...extra,
        },
    });
    if (r.status !== 201) throw new Error(`[夹具-建单-${titleTag}] 应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
}
// 建单→受理通过（待受理→待处理）——admin 身份场景止步于此。
async function acceptToDaichuli(adminTok, id) {
    const r = await fetchJson(`/api/sys-issues/${id}/intake-accept`, adminTok, { method: 'POST', body: {} });
    if (r.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}
// 受理→指派（待处理→处理中，dev 在册 dev_status=pending）——开发身份场景止步于此。
async function assignToDev(adminTok, id, devId) {
    const r = await fetchJson(`/api/sys-issues/${id}/assign`, adminTok, { method: 'POST', body: { assigned_to: devId } });
    if (r.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}
// 指派→估时→授权→提交挂牌（处理中→待验证，先行上线执行人集合含当日值班人）——值班身份场景止步于此。
async function estimateAndAuthorizeAndStage(adminTok, devTok, id) {
    const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
    let r = await fetchJson(`/api/sys-issues/${id}/estimate`, devTok, { method: 'POST', body: { dev_estimated_at: futureEst } });
    if (r.status !== 200) throw new Error(`[夹具-估时] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await fetchJson(`/api/sys-issues/${id}/fast-release-authorize`, adminTok, { method: 'POST', body: { note: `MPPW-授权-${id}` } });
    if (r.status !== 200) throw new Error(`[夹具-授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await fetchJson(`/api/sys-issues/${id}/submit`, devTok, {
        method: 'POST', body: {
            mode: 'commits', self_tested: true, test_env_deployed: true,
            bug_cause_note: 'MPPW 探针：bug 产生原因',
            commits: [{ component: 'backend', commit_ref: `mppw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
        },
    });
    if (r.status !== 200) throw new Error(`[夹具-提交挂牌] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    if (r.body.main_status !== '待验证') throw new Error(`[夹具-提交挂牌] main_status 应为「待验证」，实得 ${r.body.main_status}`);
    return r.body;
}

// ── 当日值班（照抄 test-sys-fastlane-playwright.js 同款范式，供 clearTodayDutyTemporarily/ensureTodayDuty 复用） ──
async function getTodayDuty() {
    return dbGet(`SELECT user_id, user_name FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
}
async function ensureTodayDuty(userId) {
    const existing = await getTodayDuty();
    if (existing) return { userId: Number(existing.user_id), userName: existing.user_name, preExisting: true, insertedRowId: null };
    const u = await dbGet('SELECT display_name, username FROM users WHERE id=?', [userId]);
    const userName = (u && (u.display_name || u.username)) || ('#' + userId);
    const r = await dbRun(
        `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name)
         VALUES (date('now','localtime'), ?, ?, ?, '管理员')`,
        [userId, userName, ADMIN_ID]
    );
    return { userId, userName, preExisting: false, insertedRowId: r.lastID };
}
// 临时清空当日值班（当真实值班人与本文件固定角色 id 冲突时借用）——同 fastlane 套件 fail-fast 纪律：
// 只处理"本次调用真正读到、真正软删"的行，不做跨运行启发式自愈；SKIP_DUTY_GUARD=1 显式跳过检查。
async function clearTodayDutyTemporarily() {
    if (process.env.SKIP_DUTY_GUARD !== '1') {
        const suspiciousRemoved = await dbAll(
            `SELECT id, user_id, user_name, removed_at FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NOT NULL AND removed_by = ?`,
            [ADMIN_ID]
        );
        if (suspiciousRemoved.length) {
            throw new Error(
                `[值班冲突处理 fail-fast] 发现 ${suspiciousRemoved.length} 条当日已软删的值班行（removed_by=ADMIN_ID）：${JSON.stringify(suspiciousRemoved)}——` +
                `无法判断是残留还是真实人工撤销，拒绝自动处理。人工核实后设 SKIP_DUTY_GUARD=1 重跑，或明天再跑，或确认残留后手工恢复 removed_at=NULL 再重跑。`
            );
        }
    }
    const before = await dbAll(`SELECT id, user_id, user_name FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    if (before.length) {
        await dbRun(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = '管理员' WHERE duty_date = date('now','localtime') AND removed_at IS NULL`, [ADMIN_ID]);
    }
    return async function restore() {
        for (const row of before) {
            await dbRun(`UPDATE sys_release_duty_roster SET removed_at = NULL, removed_by = NULL, removed_by_name = NULL WHERE id = ?`, [row.id]);
        }
    };
}

// ── DOM 读取小工具 ──
function statCardLoc(page, key) {
    return page.locator(`.u-stat-card[onclick="siSetStatFilter('${key}')"]`);
}
async function readStatCardCount(page, key) {
    const txt = await statCardLoc(page, key).locator('.u-stat-num').textContent().catch(() => null);
    if (txt == null) return null;   // 卡不存在（count=0 且非激活态时可能不渲染，属预期）
    const n = Number(txt.trim());
    return Number.isFinite(n) ? n : null;
}
function issueRowLoc(page, issueId) {
    return page.locator(`tr[onclick="siOpenDrawer(${issueId})"]`);
}
// 负例检查专用：卡若因 count=0∧非激活态而根本不在 DOM 里，对着不存在的元素 .click() 会等满 Playwright
// 默认超时（~30s）才 reject；更关键的是——若因此放弃点击、退化成读"默认（无筛选）视图下该行是否可见"，
// 测出来的其实是"该角色是否对这单有任何可见权限"（通用列表可见性），不是"my_pending 筛选真的排除了它"
// 这件事本身（首版实测撞见：liaison 的夹具单在 duty 角色**未点开筛选**时仍出现在其默认列表里，误判本
// 该通过的负例为失败）。改为直接调用页面函数 siSetStatFilter('key')（点击处理器背后调用的同一个函数，
// 语义完全等价，唯一区别是不要求承载它的 DOM 元素先存在）——卡在不在 DOM 里都能可靠地把筛选真正激活。
async function activateStatFilter(page, key) {
    // [S4 预筛拦截2] 在场证明必答：返回激活后的 siActiveStat 并断言——否则"JS 未加载/函数改名"时
    //   本函数静默不做任何事，负例环的 0 行断言靠"什么都没发生"空转判绿（测出来的是页面没渲染，
    //   不是角色不该看见）。
    const activated = await page.evaluate((k) => {
        if (typeof siSetStatFilter !== 'function') return null;
        siSetStatFilter(k);
        return siActiveStat;
    }, key);
    must(activated === key, `激活筛选在场证明：siSetStatFilter('${key}') 后 siActiveStat 应='${key}'，实得 ${JSON.stringify(activated)}（null=页面 JS 未加载或函数改名）`);
}
// [实测撞见] 卡面数字≠筛选后表格渲染行数——本页 attachPagination 头部注释明写"页码条'共 N 条'按行数
// 装箱、含灰显补根行（isContext:true 家族补显）与搜索广播带出的非命中同族成员，与统计卡（真命中口径）
// 刻意不同源"（Sys_Iteration.html :2160-2164）；叠加分页（默认页大小下 admin 角色真实待办基线可达 30+
// 条，超出单页渲染），"点卡后卡面数字应恰等于当前渲染行数"这条朴素等式在本页设计下不成立（方向也不
// 单一：家族补显会让行数偏多，分页会让行数偏少）。降级为可靠不变量：筛选后渲染行数至少 1（结果非空）+
// 目标夹具行确实在场（由调用方单独断言）——"点卡筛选结果与计数一致"这条 spec 要求落实为"点卡确实筛出
// 了本角色该有的单"，非逐字对拍两个刻意不同源的数字。
function assertFilteredResultNonEmpty(rowCnt, cardNum, label) {
    // [S4 预筛提示1] 本条在全部调用点恒真（前一行已断言目标夹具行 count===1 ⇒ rowCnt>=1 必然成立），
    //   不再计入 must（虚增 PASS 零覆盖增量）；降级为过程日志，保留头部"刻意不同源"设计说明的挂点。
    console.log(`  （${label} 筛选后渲染 ${rowCnt} 行·卡面数字=${cardNum}——两者刻意不同源，见本函数上方注释）`);
}
async function tableBodyRowCount(page) {
    return page.locator('#siTbody tr[onclick^="siOpenDrawer("]').count();
}
// [codex 468 MED-1] 负例的计数路径断言：筛选路径（行不出现）之外，直接在页面内对该单跑 siIsMyPending
// 谓词——若谓词只在统计计数路径误把该单算入而筛选路径正确（两路径理论同源但运行时行为需独立取证），
// 本断言会红。该单不在该角色可见列表里（found=false）同样合法=不进计数基数。
async function assertPredicateMiss(page, issueId, label) {
    const r = await page.evaluate((id) => {
        const list = (typeof siVisibleTypeList === 'function') ? siVisibleTypeList() : null;
        if (!Array.isArray(list)) return { ok: false, reason: 'siVisibleTypeList 不可用' };
        const item = list.find((i) => Number(i.id) === Number(id));
        if (!item) return { ok: true, reason: 'not-visible' };
        return { ok: typeof siIsMyPending === 'function' ? siIsMyPending(item) === false : false, reason: 'predicate' };
    }, issueId);
    // [468 复审 LOW-1] not-visible 判过但输出诊断（该角色可见性未覆盖该单=不进计数基数，语义合法；
    //   显式打出来防"夹具因意外权限/加载问题消失导致谓词路径从未真正执行"无感知）。
    if (r.reason === 'not-visible') console.log(`  （${label} 夹具单对该角色不可见=谓词路径未执行·合法但记录诊断）`);
    must(r.ok, `${label} 计数路径（siIsMyPending 谓词）对该单也不应命中（实得 ${JSON.stringify(r)}——reason=predicate 且 ok=false 表示谓词误算入计数）`);
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');

    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const liaisonTok = await signAs(LIAISON_ID);

    // ── 值班身份解析：先查真实当日值班；若与本文件固定三角色（admin/开发/对接人）冲突，临时软删后
    //    插入本文件专属候选（示例开发B·id=9，同 fastlane 套件 SECOND_EXEC_ID 惯例），finally 精确还原。
    const FIXED_ROLE_IDS = new Set([ADMIN_ID, DEV_ID, LIAISON_ID]);
    const DUTY_FALLBACK_ID = 9; // 示例开发B（role=user）——仅当真实值班冲突或当日无值班时启用
    // [codex 468 HIGH-1] 值班表处理（可能软删真实当日值班行/插入测试行）必须发生在 try/finally 保护
    //   之内——原版在 try 外，chromium.launch()/signAs()/ensureTodayDuty() 任一抛错时 finally 不执行，
    //   轻则遗留测试值班行、重则真实值班行持续 removed_at 非空（真实业务数据污染）。改法：全部资源
    //   获取从 try 顶部开始，声明提外置 null，finally 逐项条件清理。
    let dutyClearRestore = null;
    let duty = null;
    let dutyTok = null;
    const createdIds = [];
    let browser = null;
    try {
        const existingDutyBeforeResolve = await getTodayDuty();
        if (existingDutyBeforeResolve && FIXED_ROLE_IDS.has(Number(existingDutyBeforeResolve.user_id))) {
            console.log(`  ⚠️ 当日真实值班人 user_id=${existingDutyBeforeResolve.user_id} 与本文件固定角色冲突，临时软删后插入候选 #${DUTY_FALLBACK_ID}（finally 精确还原）`);
            dutyClearRestore = await clearTodayDutyTemporarily();
        }
        duty = await ensureTodayDuty(DUTY_FALLBACK_ID);
        console.log(`  （当日值班：user_id=${duty.userId}${duty.preExisting ? '·真实已有，复用' : '·测试插入'}）`);
        if (FIXED_ROLE_IDS.has(duty.userId)) {
            throw new Error(`[值班身份解析异常] 解析后的值班人 user_id=${duty.userId} 仍与固定角色冲突（不应发生——冲突分支应已软删重插），拒绝继续跑`);
        }
        dutyTok = await signAs(duty.userId);

        console.log('\n══════ 「待我处理」全角色卡 Playwright 多角色活体验证 ══════');
        console.log(`  角色映射：admin=#${ADMIN_ID} 开发=#${DEV_ID}(示例开发A) 对接人=#${LIAISON_ID}(示例对接人) 值班开发=#${duty.userId}`);

        browser = await chromium.launch();
        // ═══════════════════════════════════════════════════════════════
        // ① 四角色正例 + 负例环（各断言卡出现与否 + 计数相对基线 + 点卡筛选结果与计数一致）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ① 四角色「待我处理」卡：正例出现 + 负例环不出现 + 点卡筛选行数与卡面数字一致 ──');

        // ①-admin：待处理态（admin 直接状态子条件命中，无需在册）
        let idAdmin;
        {
            const page0 = await loginPage(browser, adminTok);
            await page0.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page0.waitForLoadState('networkidle');
            await page0.waitForTimeout(400);
            const before = (await readStatCardCount(page0, 'my_pending')) || 0;
            await page0.close();

            idAdmin = await createBug(adminTok, 'admin');
            createdIds.push(idAdmin);
            await acceptToDaichuli(adminTok, idAdmin);   // 待受理 → 待处理

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            const after = await readStatCardCount(page, 'my_pending');
            await shotOnFail(page, after === before + 1, '1-admin-count-delta', `①admin 卡计数应比造数前多 1（before=${before}, after=${after}）`);
            await statCardLoc(page, 'my_pending').click();
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idAdmin).count()) === 1, '1-admin-row-present', `①admin 点卡筛选后应看到本单 #${idAdmin}`);
            const cardNum = await readStatCardCount(page, 'my_pending');
            const rowCnt = await tableBodyRowCount(page);
            assertFilteredResultNonEmpty(rowCnt, cardNum, '①admin');
            await page.close();
        }
        // ①-admin 负例：开发视角不应看到 idAdmin（状态=待处理，不在开发家族状态内）
        {
            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            await activateStatFilter(page, 'my_pending');
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idAdmin).count()) === 0, '1-admin-negative-under-dev', `①admin 夹具单 #${idAdmin} 不应出现在开发角色的「待我处理」筛选结果里`);
            await assertPredicateMiss(page, idAdmin, '①admin负例·开发视角');
            await page.close();
        }

        // ①-开发：处理中态 + my_dev_pending=1（在册 pending）
        let idDev;
        {
            const page0 = await loginPage(browser, devTok);
            await page0.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page0.waitForLoadState('networkidle');
            await page0.waitForTimeout(400);
            const before = (await readStatCardCount(page0, 'my_pending')) || 0;
            await page0.close();

            idDev = await createBug(adminTok, 'dev');
            createdIds.push(idDev);
            await acceptToDaichuli(adminTok, idDev);
            await assignToDev(adminTok, idDev, DEV_ID);   // 待处理 → 处理中，DEV_ID 在册 pending

            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            const after = await readStatCardCount(page, 'my_pending');
            await shotOnFail(page, after === before + 1, '1-dev-count-delta', `①开发 卡计数应比造数前多 1（before=${before}, after=${after}）`);
            await statCardLoc(page, 'my_pending').click();
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idDev).count()) === 1, '1-dev-row-present', `①开发 点卡筛选后应看到本单 #${idDev}`);
            const cardNum = await readStatCardCount(page, 'my_pending');
            const rowCnt = await tableBodyRowCount(page);
            assertFilteredResultNonEmpty(rowCnt, cardNum, '①开发');
            await page.close();
        }
        // ①-开发 负例：对接人视角不应看到 idDev（状态=处理中，不在待受理/待对接测试内）
        {
            const page = await loginPage(browser, liaisonTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            await activateStatFilter(page, 'my_pending');
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idDev).count()) === 0, '1-dev-negative-under-liaison', `①开发 夹具单 #${idDev} 不应出现在对接人角色的「待我处理」筛选结果里`);
            await assertPredicateMiss(page, idDev, '①开发负例·对接人视角');
            await page.close();
        }

        // ①-对接人（受理人·待受理态）：is_my_intake_liaison=1 + status=待受理
        let idLiaison;
        {
            const page0 = await loginPage(browser, liaisonTok);
            await page0.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page0.waitForLoadState('networkidle');
            await page0.waitForTimeout(400);
            const before = (await readStatCardCount(page0, 'my_pending')) || 0;
            await page0.close();

            idLiaison = await createBug(adminTok, 'liaison');   // 止步待受理，不 accept
            createdIds.push(idLiaison);

            const page = await loginPage(browser, liaisonTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            const after = await readStatCardCount(page, 'my_pending');
            await shotOnFail(page, after === before + 1, '1-liaison-count-delta', `①对接人 卡计数应比造数前多 1（before=${before}, after=${after}）`);
            await statCardLoc(page, 'my_pending').click();
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idLiaison).count()) === 1, '1-liaison-row-present', `①对接人 点卡筛选后应看到本单 #${idLiaison}`);
            const cardNum = await readStatCardCount(page, 'my_pending');
            const rowCnt = await tableBodyRowCount(page);
            assertFilteredResultNonEmpty(rowCnt, cardNum, '①对接人');
            await page.close();
        }
        // ①-对接人 负例：值班开发视角不应看到 idLiaison（状态=待受理，值班身份门要求 待验证+挂牌）
        {
            const page = await loginPage(browser, dutyTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            await activateStatFilter(page, 'my_pending');
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idLiaison).count()) === 0, '1-liaison-negative-under-duty', `①对接人 夹具单 #${idLiaison} 不应出现在值班开发角色的「待我处理」筛选结果里`);
            await assertPredicateMiss(page, idLiaison, '①对接人负例·值班视角');
            await page.close();
        }

        // ①-值班开发：待验证态 + fast_release_active_auth=1 + fast_release_my_pending=1（挂牌集合含当日值班人）
        let idDuty;
        {
            const page0 = await loginPage(browser, dutyTok);
            await page0.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page0.waitForLoadState('networkidle');
            await page0.waitForTimeout(400);
            const before = (await readStatCardCount(page0, 'my_pending')) || 0;
            await page0.close();

            idDuty = await createBug(adminTok, 'duty');
            createdIds.push(idDuty);
            await acceptToDaichuli(adminTok, idDuty);
            await assignToDev(adminTok, idDuty, DEV_ID);
            await estimateAndAuthorizeAndStage(adminTok, devTok, idDuty);   // 处理中 → 待验证，挂牌
            const feRows = await dbAll('SELECT user_id FROM sys_fast_release_executors WHERE issue_id=? AND removed_at IS NULL', [idDuty]);
            must(feRows.length === 1 && Number(feRows[0].user_id) === duty.userId, `①值班-前置 挂牌应恰 1 行=当日值班人 #${duty.userId}（实得 ${JSON.stringify(feRows)}）`);

            const page = await loginPage(browser, dutyTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            const after = await readStatCardCount(page, 'my_pending');
            await shotOnFail(page, after === before + 1, '1-duty-count-delta', `①值班开发 卡计数应比造数前多 1（before=${before}, after=${after}）`);
            await statCardLoc(page, 'my_pending').click();
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idDuty).count()) === 1, '1-duty-row-present', `①值班开发 点卡筛选后应看到本单 #${idDuty}`);
            const cardNum = await readStatCardCount(page, 'my_pending');
            const rowCnt = await tableBodyRowCount(page);
            assertFilteredResultNonEmpty(rowCnt, cardNum, '①值班开发');
            await page.close();
        }
        // ①-值班开发 负例：开发（DEV_ID）视角不应看到 idDuty（status=待验证不在开发家族内；DEV_ID 在 idDuty
        //   的 roster 里但 dev_status 已推进过 pending，my_dev_pending 应已为 0）
        {
            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            await activateStatFilter(page, 'my_pending');
            await page.waitForTimeout(400);
            await shotOnFail(page, (await issueRowLoc(page, idDuty).count()) === 0, '1-duty-negative-under-dev', `①值班开发 夹具单 #${idDuty} 不应出现在开发角色（DEV_ID 本人虽在 roster 但已过 pending 态）的「待我处理」筛选结果里`);
            await assertPredicateMiss(page, idDuty, '①值班负例·开发视角');
            await page.close();
        }
        // ①-值班开发 收尾：本人确认（末位，唯一执行人）→ 翻牌已上线，idDuty 脱离值班身份门——避免它
        //   一直悬在「待验证」占着值班角色的待办集合，污染下面②空态防困要用到的"真·零基线"前提。
        {
            const confirmR = await fetchJson(`/api/sys-issues/${idDuty}/fast-release-exec-confirm`, dutyTok, { method: 'POST', body: {} });
            must(confirmR.status === 200 && confirmR.body.flipped === true, `①值班开发-收尾 唯一执行人确认应 200 且末位翻牌 flipped=true，实得 ${confirmR.status} ${JSON.stringify(confirmR.body)}`);
        }

        // ═══════════════════════════════════════════════════════════════
        // ② 空态防困：筛选激活时把最后一单处理掉 → 卡仍在（siShouldRenderConditionalCard 转义分支）
        // ═══════════════════════════════════════════════════════════════
        // 角色选择说明：admin/开发/对接人三角色在本地库里均有非零真实历史基线（①组已实测：admin=34、
        //   开发=2、对接人=2），"处理掉最后一单"后计数会回落到基线而非真零，测不到 siShouldRenderConditional
        //   Card 的"count=0"转义分支本身（count>0 时卡本就会渲染，不是转义在起作用）。值班身份是**当日
        //   限定**维度，理论上比其余三角色更贴近"最后一单"字面语义——用它作本组载体，且用真实业务动作
        //   （末位执行确认→翻牌已上线）作"处理掉"手段，比后台直调状态流转更贴近用户真实操作。
        // ⭐ [2026-08-27 实锤·绝对基线断言→可跑性门] 上一句"值班当日基线=0"曾是本组 S4（08-26）编写时点
        //   的真实观测（已删——新增条款必删被推翻的旧表述），但只是**时点巧合**，不是不变量：日期翻转
        //   到 08-27 后，当日真实值班人名下出现 2 张真实存量单命中值班「待我处理」（①组 before=2 可证），
        //   原判据 `baseline!==1` 直接 throw 会中止整个套件——共享观察库的日期漂移会让"最后一单"前提随
        //   时失效，绝对计数断言对此不鲁棒。改判据为**可跑性门**：preReal===0（真·最后一单）时走原版
        //   零态转义分支全量断言（分支 A，逐字不动）；preReal>=1 时显式 SKIP 零态转义分支——该分支覆盖
        //   面另有 verify-sys-fastlane-panel-static.js 对 siShouldRenderConditionalCard 的静态断言 + 本次
        //   S4 时点活体已验证过一次，非从此测试面归零——改跑退化版相对断言（分支 B：count 是否正确
        //   +1/-1、行是否正确出现/消失）。SKIP 必须计入末尾汇总（见 skip 计数器），不得静默消失。
        // ⭐ [Opus 预筛 2f7ed61 回卷·拦截-3+4 收口] 上一版把"preCount=baseline-1"当独立验证点——那其实
        //   是代数恒等式（preCount 本就是从 baseline 反推定义出来的），"断言 baseline===preCount+1"必然
        //   为真，是刚删掉的 `must(true)` 反模式换了个位置又长回来。改结构：**createBug 之前**先开页读
        //   一次真实基线 preReal（readStatCardCount 返回 null 时归 0——null=卡不渲染=零态合法常态，非
        //   "读取失败"）→ 造 idEmpty 走完挂牌流程 → 全新页面会话（非复用上面同一次渲染结果）再读一次
        //   after，两次读数各自独立观测。断言 after===preReal+1 且 after 非 null——若不满足，说明"刚挂
        //   牌的这张唯一执行人=当日值班人的单，没有被正确计入值班「待我处理」计数"，这是 **P 侧真缺陷**
        //   （不是环境漂移类噪音），fail-fast 带清晰信息中止、绝不走 SKIP 通道（SKIP 只应对"基线本身
        //   非零"这类无害的环境漂移，不能用来掩盖"增量算错了"这种真回归）。前提验证通过后，才按
        //   preReal 分流：preReal===0 → 分支 A；preReal>=1 → 分支 B（SKIP + 退化断言，退化断言基于
        //   preReal/after 真实读数，不再有任何代数反推）。
        console.log('\n── ② 空态防困：值班开发筛选激活后把唯一命中单执行确认掉（末位翻牌已上线），卡不应消失 ──');
        {
            // 独立观测①：idEmpty 造出之前的真实基线。
            const prePage = await loginPage(browser, dutyTok);
            await prePage.goto(`${BASE_URL}/Sys_Iteration.html`);
            await prePage.waitForLoadState('networkidle');
            await prePage.waitForTimeout(400);
            const preRealRaw = await readStatCardCount(prePage, 'my_pending');
            const preReal = preRealRaw == null ? 0 : preRealRaw;
            await prePage.close();

            const idEmpty = await createBug(adminTok, 'empty-trap');
            createdIds.push(idEmpty);
            await acceptToDaichuli(adminTok, idEmpty);
            await assignToDev(adminTok, idEmpty, DEV_ID);
            await estimateAndAuthorizeAndStage(adminTok, devTok, idEmpty);   // 处理中 → 待验证，挂牌（唯一执行人=当日值班人）

            // 独立观测②：全新页面会话重新登录+导航（非复用上面 prePage 的渲染结果）——idEmpty 已挂牌
            //   完毕，这次读到的数字是"造出这一单之后"的真实终态，与 preReal 是两次互相独立的观测。
            const page = await loginPage(browser, dutyTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            const afterRaw = await readStatCardCount(page, 'my_pending');
            const after = afterRaw == null ? 0 : afterRaw;

            // 真实增量的独立观测——不满足则 fail-fast 中止（P 侧真缺陷信号，绝不走 SKIP 通道）。下方
            //   preReal===0/>=1 的分流判据建立在"after 增量正确"这个前提上，前提不成立时继续跑只会
            //   产出更多误导性的下游断言，不如在这里就报清楚。
            if (afterRaw == null || after !== preReal + 1) {
                throw new Error(`②-前置 真实增量观测失败：idEmpty #${idEmpty} 挂牌后值班「待我处理」计数应=preReal+1（preReal=${preReal}），实得 after=${afterRaw === null ? 'null（卡未渲染）' : afterRaw}——夹具单未被正确计入基线，疑似 P 侧真缺陷（非日期漂移类环境噪音），停手保留现场，不走 SKIP 通道`);
            }
            console.log(`  （②-前置 真实增量观测通过：preReal=${preReal} → after=${after}，符合 +1 预期，非 must(true) 虚增计数——真正的 PASS 计数在下方 b)/c)/d) 独立断言里）`);

            if (preReal === 0) {
                // ── 分支 A（preReal===0，等价于原版"真·最后一单"语义）：零态转义分支全量断言，逐字不动 ──
                console.log(`  （②-前置 preReal=0——真·最后一单，走原版零态转义分支全量断言）`);
                await statCardLoc(page, 'my_pending').click();
                await page.waitForTimeout(400);
                await shotOnFail(page, (await issueRowLoc(page, idEmpty).count()) === 1, '2-empty-trap-precondition', `②-前置 点卡筛选后应看到夹具单 #${idEmpty}（否则本组"处理掉最后一单"的前提不成立）`);

                // 值班人自己在页面外直调执行确认端点（末位，唯一执行人）——不经该页面按钮，模拟"另一处/
                // 另一会话推进了这单"的真实并发场景，与本组"筛选激活时最后一单被处理掉"要测的现象一致。
                const confirmR = await fetchJson(`/api/sys-issues/${idEmpty}/fast-release-exec-confirm`, dutyTok, { method: 'POST', body: {} });
                must(confirmR.status === 200 && confirmR.body.flipped === true, `②-前置 执行确认应 200 且末位翻牌 flipped=true，实得 ${confirmR.status} ${JSON.stringify(confirmR.body)}`);

                // 页面内强制刷新（siLoadList 不触碰 siActiveStat，见方案 N0 第 4 步核查：该状态本就不进
                // URL/localStorage，纯内存态）——模拟"处理动作触发的列表自动刷新"，非重新登录/重置筛选。
                // [codex 468 MED-2] 返回 siLoadList() 的 Promise 供 evaluate await + waitForFunction 等真实
                //   终态（卡数字归 0）——原版固定 500ms 在慢机/库锁下非确定性失败，且分不清"刷新失效"与
                //   "刷新未完成"。超时独立报错语义。
                await page.evaluate(() => (typeof siLoadList === 'function' ? siLoadList() : null));
                // [468 复审 MED-1] 超时不静默吞：记录诊断标志——"超时必然转化为失败"由紧随其后的
                //   numAfter===0 must 断言承担（读真实数值红灯+截图），本 catch 只补可诊断信息。
                let emptyWaitTimedOut = false;
                await page.waitForFunction(() => {
                    const card = document.querySelector(".u-stat-card[onclick=\"siSetStatFilter('my_pending')\"] .u-stat-num");
                    return !!card && card.textContent.trim() === '0';
                }, { timeout: 8000 }).catch(() => { emptyWaitTimedOut = true; });
                if (emptyWaitTimedOut) console.warn('  ⚠️ ②空态防困：8s 内卡数字未归零（waitForFunction 超时）——下方 numAfter 断言将以真实读数判定');

                const cardCountAfter = await statCardLoc(page, 'my_pending').count();
                await shotOnFail(page, cardCountAfter === 1, '2-empty-trap-card-survives', `②空态防困 处理掉最后一单后「待我处理」卡不应从 DOM 消失（siShouldRenderConditionalCard 的 count=0∧activeStat===cardKey 仍渲染分支），实得 DOM 命中 ${cardCountAfter} 个`);
                const numAfter = await readStatCardCount(page, 'my_pending');
                await shotOnFail(page, numAfter === 0, '2-empty-trap-count-zero', `②空态防困 卡仍在但计数应真归零（实得 ${numAfter}）——证明"仍在"不是因为该单还留在结果里或基线本就非零，而是转义分支真的生效`);
                await shotOnFail(page, (await issueRowLoc(page, idEmpty).count()) === 0, '2-empty-trap-row-gone', `②空态防困 该单已脱离筛选条件（已上线，脱离值班身份门），列表行应已消失`);
            } else {
                // ── 分支 B（preReal>=1）：显式 SKIP 零态转义分支 + 退化版相对断言（基于 preReal/after
                //   真实读数——不再有任何代数反推，preReal 与 after 都是上方两次独立观测的结果） ──
                skip++;
                const skipMsg = `[SKIP] ②零态转义分支：当日真实值班基线=${preReal}≠0，空态归零前提不成立，本次跳过；零态渲染另有覆盖=verify-sys-fastlane-panel-static 对 siShouldRenderConditionalCard 的静态断言+S4 时点活体已证一次`;
                console.log('  ' + skipMsg);
                skipDetails.push(skipMsg);

                await statCardLoc(page, 'my_pending').click();
                await page.waitForTimeout(400);
                await shotOnFail(page, (await issueRowLoc(page, idEmpty).count()) === 1, '2-empty-trap-degraded-precondition', `②-退化 c) 点卡筛选后应看到夹具单 #${idEmpty}`);

                const confirmR = await fetchJson(`/api/sys-issues/${idEmpty}/fast-release-exec-confirm`, dutyTok, { method: 'POST', body: {} });
                must(confirmR.status === 200 && confirmR.body.flipped === true, `②-退化 执行确认应 200 且末位翻牌 flipped=true，实得 ${confirmR.status} ${JSON.stringify(confirmR.body)}`);

                await page.evaluate(() => (typeof siLoadList === 'function' ? siLoadList() : null));
                let degradedWaitTimedOut = false;
                await page.waitForFunction((expected) => {
                    const card = document.querySelector(".u-stat-card[onclick=\"siSetStatFilter('my_pending')\"] .u-stat-num");
                    return !!card && card.textContent.trim() === String(expected);
                }, preReal, { timeout: 8000 }).catch(() => { degradedWaitTimedOut = true; });
                if (degradedWaitTimedOut) console.warn(`  ⚠️ ②-退化：8s 内卡数字未回落至 preReal=${preReal}（waitForFunction 超时）——下方断言将以真实读数判定`);

                const numAfterDegraded = await readStatCardCount(page, 'my_pending');
                await shotOnFail(page, numAfterDegraded === preReal, '2-empty-trap-degraded-count-back', `②-退化 d) 执行确认+强刷后计数应回落至 preReal=${preReal}，实得 ${numAfterDegraded}`);
                await shotOnFail(page, (await issueRowLoc(page, idEmpty).count()) === 0, '2-empty-trap-degraded-row-gone', `②-退化 d) 该单已脱离筛选条件，列表行应已消失`);
                // ⚠️ 证明力边界（如实注明，非回避）：此刻 preReal>=1（否则会走分支 A），卡在 DOM 里
                //   "仍在"是因为 count=preReal>0 本就会渲染（siShouldRenderConditionalCard 的
                //   "count>0 恒渲染"分支，非"count=0∧activeStat 仍渲染"转义分支）——这条在本分支下是
                //   **平凡真**，测不出转义分支本身是否生效；保留是为了"卡不应消失"这条更基础的不变量
                //   在退化分支下也不留死角，但读者必须知道它证明的是弱得多的东西。
                const cardCountAfterDegraded = await statCardLoc(page, 'my_pending').count();
                must(cardCountAfterDegraded === 1, `②-退化 d) my_pending 卡应仍在 DOM（平凡真——count=${preReal}>0 时卡本就会渲染，本分支测不出 siShouldRenderConditionalCard 转义分支本身，见上方边界说明），实得 DOM 命中 ${cardCountAfterDegraded} 个`);
            }
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ③ 三档视口：同排 offsetTop 一致 + 无溢出 + 标签单行（第一排+第二排类型卡都测）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ③ 三档视口（1280/1440/1920）：统计卡+类型卡同排对齐/无溢出/标签单行 ──');
        const VIEWPORTS = [1280, 1440, 1920];
        for (const w of VIEWPORTS) {
            const page = await loginPage(browser, adminTok);
            await page.setViewportSize({ width: w, height: 900 });
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const metrics = await page.evaluate(() => {
                function rowMetrics(sel) {
                    const cards = [...document.querySelectorAll(`${sel} .u-stat-card`)];
                    return cards.map((c) => {
                        const label = c.querySelector('.u-stat-label');
                        const cs = label ? getComputedStyle(label) : null;
                        return {
                            offsetTop: c.offsetTop,
                            scrollWidth: c.scrollWidth,
                            clientWidth: c.clientWidth,
                            labelWhiteSpace: cs ? cs.whiteSpace : null,
                            labelScrollHeight: label ? label.scrollHeight : null,
                            labelClientHeight: label ? label.clientHeight : null,
                        };
                    });
                }
                return { stats: rowMetrics('#siStatsRow'), types: rowMetrics('#siTypeCardsRow') };
            });

            await shotOnFail(page, metrics.stats.length >= 8, `3-${w}-stats-nonempty`, `③视口${w} #siStatsRow 应至少渲染 8 张常驻卡（实得 ${metrics.stats.length}——S4 预筛提示9：>=1 在 siRenderStats 退化成单卡时照样绿）`);
            if (metrics.stats.length) {
                const tops = new Set(metrics.stats.map((m) => m.offsetTop));
                await shotOnFail(page, tops.size === 1, `3-${w}-stats-same-row`, `③视口${w} 统计卡应同排（offsetTop 一致），实得 offsetTop 集合=${JSON.stringify([...tops])}`);
            }
            for (let i = 0; i < metrics.stats.length; i++) {
                const m = metrics.stats[i];
                await shotOnFail(page, m.scrollWidth <= m.clientWidth, `3-${w}-stats-overflow-${i}`, `③视口${w} 统计卡#${i} 不应横向溢出（scrollWidth=${m.scrollWidth} <= clientWidth=${m.clientWidth}）`);
                await shotOnFail(page, m.labelWhiteSpace === 'nowrap', `3-${w}-stats-nowrap-${i}`, `③视口${w} 统计卡#${i} 标签 computed white-space 应为 nowrap（实得 ${m.labelWhiteSpace}）`);
                await shotOnFail(page, m.labelScrollHeight != null && m.labelScrollHeight <= m.labelClientHeight, `3-${w}-stats-singleline-${i}`, `③视口${w} 统计卡#${i} 标签应单行（scrollHeight=${m.labelScrollHeight} <= clientHeight=${m.labelClientHeight}）`);
            }

            if (metrics.types.length) {
                const typeTops = new Set(metrics.types.map((m) => m.offsetTop));
                await shotOnFail(page, typeTops.size === 1, `3-${w}-types-same-row`, `③视口${w} 类型卡应同排（offsetTop 一致），实得 offsetTop 集合=${JSON.stringify([...typeTops])}`);
                for (let i = 0; i < metrics.types.length; i++) {
                    const m = metrics.types[i];
                    await shotOnFail(page, m.scrollWidth <= m.clientWidth, `3-${w}-types-overflow-${i}`, `③视口${w} 类型卡#${i} 不应横向溢出（scrollWidth=${m.scrollWidth} <= clientWidth=${m.clientWidth}）`);
                    await shotOnFail(page, m.labelWhiteSpace === 'nowrap', `3-${w}-types-nowrap-${i}`, `③视口${w} 类型卡#${i} 标签 computed white-space 应为 nowrap（实得 ${m.labelWhiteSpace}）`);
                    await shotOnFail(page, m.labelScrollHeight != null && m.labelScrollHeight <= m.labelClientHeight, `3-${w}-types-singleline-${i}`, `③视口${w} 类型卡#${i} 标签应单行（scrollHeight=${m.labelScrollHeight} <= clientHeight=${m.labelClientHeight}）`);
                }
            } else {
                // [S4 预筛拦截3] 与第一排对称的硬断言：类型卡整排消失（siRenderTypeCards 回归为
                //   display:none+清空）是真回归，不得被"跳过不算失败"静默架空（465 rec3 两排都测）。
                await shotOnFail(page, false, `3-${w}-types-missing`, `③视口${w} #siTypeCardsRow 应至少渲染 1 张卡（实得 0——类型卡整排消失属真回归）`);
            }
            await page.close();
        }

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL / ${skip} SKIP`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
        failDetails.push('顶层异常: ' + (e && e.message || e));
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                fail++;
                failDetails.push('浏览器关闭失败: ' + (e && e.message || e));
                console.warn('浏览器关闭失败:', e && e.message || e);
            }
        }
        let cleanupErrorCount = 0;
        // [S4 预筛提示8] 清理面（本套件写过的 5 张）与残留检查面（库内全部带 issue_id 的 sys_* 子表 8 张）
        //   刻意分离——"清理清单漏一张→残留检查同步漏一张"是结构性盲区：检查面≥清理面，夹具将来扩表
        //   时新残留会先红在检查（提醒把该表纳入清理），而不是静默留库。
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_fast_release_executors', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        const RESIDUAL_CHECK_TABLES = [...CHILD_TABLES, 'sys_issue_attachments', 'sys_issue_release_commit_snapshots', 'sys_issue_delete_audit'];
        for (const id of createdIds) {
            try {
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        const idList = createdIds.length ? createdIds : [-1];
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
        console.log(`  🧹 夹具清理完成（共创建 ${createdIds.length} 条，清理异常 ${cleanupErrorCount} 次，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            failDetails.push(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        // 值班表精确还原：测试插入的候选行按 insertedRowId 定点删除；若为冲突分支软删了真实值班行，restore()。
        if (duty && duty.preExisting === false && duty.insertedRowId) {
            try {
                await dbRun('DELETE FROM sys_release_duty_roster WHERE id=?', [duty.insertedRowId]);
                const remain = await dbGet('SELECT COUNT(*) c FROM sys_release_duty_roster WHERE id=?', [duty.insertedRowId]);
                if (remain && remain.c > 0) { fail++; failDetails.push(`值班表测试插入行 #${duty.insertedRowId} 清理后仍残留（应为 0，实得 ${remain.c}）`); }
            } catch (e) {
                fail++;
                failDetails.push(`值班表测试插入行清理失败 #${duty.insertedRowId}: ${e.message}`);
            }
        }
        if (dutyClearRestore) {
            try { await dutyClearRestore(); }
            catch (e) { fail++; failDetails.push(`真实值班行软删还原失败: ${e.message}`); }
        }
        db.close();
        // [2026-08-27 可跑性门改造] SKIP 必须出现在末尾汇总里，不得静默消失——同 pass/fail 一并打印，
        //   跳过项清单紧跟失败清单之后（SKIP 不影响退出码/PASS-FAIL 判定，但必须可见，防"改判据后
        //   SKIP 悄悄发生但没人看得到"这种新的假绿面）。
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 / ${skip} 项跳过 ===`);
        if (skip > 0) { console.log('跳过清单：'); skipDetails.forEach(m => console.log('  - ' + m)); }
        if (fail > 0) { console.log('失败清单：'); failDetails.forEach(m => console.log('  - ' + m)); process.exit(1); }
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
