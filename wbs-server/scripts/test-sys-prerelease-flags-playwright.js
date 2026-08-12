/**
 * 待上线可见性 · 两 flag 真实 DOM 实测（2026-08-12）
 *
 * 为什么必须走浏览器而不是只跑静态守卫：本项目已三次栽在「守卫全绿但渲染端从未生效」上
 *   （双勾留痕隔 9 版没渲染 / return_count 列表没消费 / blocked 受阻是永不触发的死分支）。
 *   静态断言只能证明「代码里写了」，证明不了「真的显示出来了」——所以这条链路的收口证据
 *   一律是**在真实 DOM 里把徽章找出来**。
 *
 * 覆盖（自造数 → 实测 → 自清理，可重复执行）：
 *   T1 未排期 = 待上线 ∧ release_id 为空 ∧ 无 release_remove 事件 → 显 slate「未排期」，不显「已移出」
 *   T2 已移出 = 待上线 ∧ release_id 为空 ∧ 有 release_remove 事件 → 显红「已移出」，不显「未排期」，
 *              且 title 悬停含 原因 / 操作人 / 时刻 三要素
 *   T3 正常态 = 待上线 ∧ release_id 非空 → 两个 flag 都不出现（D4：加回批次即消失）
 *   T4 非待上线态的 release_id 为空单（开发中）→ 两个 flag 都不出现（防"只判 release_id 不判状态"的误标）
 *   T5 第 14 层橙色在列表行**与详情抽屉**两处渲染面都真生效（computed style 实测）
 *   T6 flag 的 computed 颜色确为 D2/D3 拍板值（已移出 #dc2626 / 未排期 #64748b）
 *
 * 前置：server 已在 3000 起好（本脚本有意不 spawn，端口纪律同 test-badge-computed-playwright.js）。
 * 跑法：node scripts/test-sys-prerelease-flags-playwright.js
 */
const path = require('path');
const http = require('http');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || '3000';
const BASE_URL = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_PATH = process.env.BADGE_DB_PATH || path.join(__dirname, '..', 'task_pool.db');

// 夹具 ID **交给 SQLite 自增分配**（取 this.lastID 记账），只删本次真实创建的那几个 id。
//   ① 原写法是固定 ID 段 9201-9204 + 无条件 DELETE——只要 DB_PATH 指到含真实数据的库、且真实单 id
//      恰好落进那个区间，脚本会在 seed 前与 finally 里静默删掉真单（codex 348 号 HIGH）。
//   ② 中间版改 MAX(id)+1000 仍有并发碰撞面：两个进程同时读到同一个 MAX(id) 会算出同一组 id，
//      后者插入失败、或清理时删掉对方的夹具（codex 349 号 MED）。自增分配彻底消除这个面。
//   与既有同族 test-sys-commit-cols-playwright.js 的清理范式一致（createdIds + RUN_TAG 标题标记
//   核对残留），不是新发明。
const RUN_TAG = `PRF-${process.pid}`;          // 标题标记：清理后按它核对残留必须为 0
const ID = {};                                  // seed 时填充：unsched / removed / normal / devNull / reopened / heldResumed
const createdIssueIds = [];                     // 只清这里面的 id
const createdReleaseIds = [];                   // 本次自造的批次行，同样只清自己造的
const seedErrs = [];                            // 造数阶段的非致命错误，进断言而不是吞掉
const REMOVE_REASON = '执行人移出上线批次（原因：与本批另一张单冲突，先撤下等下一批）';
const REMOVE_BY = '示例开发A';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => (cond ? ok(m) : bad(m));

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

function ts(daysAgo = 0) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function probeServer() {
    return new Promise((resolve) => {
        const req = http.get({ host: 'localhost', port: PORT, path: '/login.html', timeout: 3000 }, (res) => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// 只删本次真实创建的 id，逐个删、单条失败不阻断其余（同 test-sys-commit-cols 的 safeDelete 范式）；
//   删完按标题标记核对残留，残留非 0 要响亮报出来而不是默默留脏数据。
async function cleanup() {
    const errs = [];
    for (const id of createdIssueIds) {
        try { await run(`DELETE FROM sys_issue_timeline WHERE issue_id = ?`, [id]); } catch (e) { errs.push(`timeline#${id}: ${e.message}`); }
        try { await run(`DELETE FROM sys_issues WHERE id = ?`, [id]); } catch (e) { errs.push(`issue#${id}: ${e.message}`); }
    }
    // 批次要在单据之后删（单据的 release_id 指着它）
    for (const rid of createdReleaseIds) {
        try { await run(`DELETE FROM sys_releases WHERE id = ?`, [rid]); } catch (e) { errs.push(`release#${rid}: ${e.message}`); }
    }
    const a = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE ?`, [`%${RUN_TAG}%`]);
    const b = await get(`SELECT COUNT(*) AS c FROM sys_releases WHERE release_no LIKE ?`, [`%${RUN_TAG}%`]);
    return { left: (a ? a.c : -1) + (b ? b.c : -1), errs };
}

async function mkIssue(o) {
    const row = {
        type: 'improvement', status: o.status, priority: 'P2',
        title: `${o.title}【${RUN_TAG}】`, description: o.title,
        system_name: 'BMS', module_name: '待上线实测', source: '内部',
        requester_dept: '信息技术部', requester_name: '示例用户A',
        created_by: 1, created_by_name: '管理员', record_source: 'native',
        reopen_count: 0, return_count: 0, scope_changed: 0, blocked: 0,
        release_id: o.release_id != null ? o.release_id : null,
        intake_required: 1, needs_feasibility: 0, notify_status: 'not_sent',
        requester_notify_status: 'not_sent', creator_notify_status: 'not_sent',
        created_at: ts(2), updated_at: ts(0),
    };
    const cols = Object.keys(row);
    const r = await run(`INSERT INTO sys_issues (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
    createdIssueIds.push(r.lastID);  // 插成功才记账（先记后插会在插失败时误清别人的行）
    return r.lastID;
}

// 进入「待上线」的 timeline 锚点行：后端派生列按"最近一次进入待上线"过滤 release_remove，
//   夹具必须把这条锚点造出来，否则测的是 COALESCE 0 的兼容分支而非真实主路径。
async function mkEnterPrerelease(issueId, daysAgo) {
    await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [issueId, 'status_change', '待验证', '待上线', '验收通过', 'accept', 1, '管理员', ts(daysAgo)]
    );
}

async function mkRemoveEvent(issueId, daysAgo) {
    await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [issueId, 'scope_change', REMOVE_REASON, 'release_remove', 8, REMOVE_BY, ts(daysAgo)]
    );
}

// T3 的批次：**本次自造**而不是借库里现成的（codex 350 号 MED）。借现成的会让 T3 在空库/新 CI 库上
//   静默跳过，而它是唯一覆盖「release_id 非空 → 两 flag 消失」（D4 门控）的浏览器断言——
//   一条关键回归面变成"有数据才测"，脚本却照样 PASS，正是本项目最忌的假绿形态。
//   ⚠️ status 只收 '计划中'/'已发布'（本表 DDL 的 CHECK），不是英文枚举；写错会被 CHECK 当场拒。
async function mkRelease() {
    const cols = ['release_no', 'title', 'planned_date', 'status', 'created_by', 'created_by_name', 'created_at'];
    const vals = [`R-${RUN_TAG}`, `待上线实测批次【${RUN_TAG}】`, ts(0).slice(0, 10), '计划中', 1, '管理员', ts(0)];
    const r = await run(`INSERT INTO sys_releases (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
    createdReleaseIds.push(r.lastID);
    return r.lastID;
}

async function seed() {
    // 自造批次；建不出来（schema 差异等）就如实记 null，下方 T3 会判红而不是静默跳过
    let relId = null;
    try { relId = await mkRelease(); } catch (e) { seedErrs.push(`mkRelease: ${e.message}`); }

    ID.unsched = await mkIssue({ status: '待上线', title: '实测·未排期：从未进过批次' });
    await mkEnterPrerelease(ID.unsched, 3);

    ID.removed = await mkIssue({ status: '待上线', title: '实测·已移出：曾被执行人移出' });
    await mkEnterPrerelease(ID.removed, 3);
    await mkRemoveEvent(ID.removed, 1);

    // T3 挂在**本次自造**的批次上（不借库里现成的，理由见 mkRelease 注释）
    if (relId) {
        ID.normal = await mkIssue({ status: '待上线', release_id: relId, title: `实测·正常态：仍挂批次 #${relId}` });
        await mkEnterPrerelease(ID.normal, 3);
    }
    // T4：开发中且 release_id 为空——不门控状态就会被误标「未排期」的形态
    ID.devNull = await mkIssue({ status: '开发中', title: '实测·非待上线：开发中且无批次' });

    // T6（codex 348 号 MED）：跨轮次污染——**旧一轮**被移出 → 归档 reopen → 新一轮回到「待上线」
    //   但本轮从未进批次。若后端不按轮次锚点过滤，这张单会被历史 release_remove 错标成「已移出」。
    //   事件按真实时序插入：进待上线(旧) → 移出(旧) → 重开 → 进待上线(新)。
    ID.reopened = await mkIssue({ status: '待上线', title: '实测·跨轮次：上一轮曾被移出，本轮从未排期' });
    await mkEnterPrerelease(ID.reopened, 30);
    await mkRemoveEvent(ID.reopened, 28);
    await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [ID.reopened, 'status_change', '已关闭', '开发中', '重开', 'reopen', 1, '管理员', ts(20)]
    );
    await mkEnterPrerelease(ID.reopened, 2);

    // T7（codex 349 号 HIGH）：**同一轮内**被移出后走 暂缓→恢复。resume 也写
    //   event_type='status_change' + to_status='待上线'（actionCode='resume'），若锚点不按 action_code
    //   收窄，它会把锚点推到移出事件之后，把真被移出的单错标成「未排期」。
    //   事件时序：进待上线(accept) → 移出 → 暂缓(hold) → 恢复(resume·回待上线)。
    ID.heldResumed = await mkIssue({ status: '待上线', title: '实测·暂缓恢复：本轮被移出后暂缓又恢复' });
    await mkEnterPrerelease(ID.heldResumed, 10);
    await mkRemoveEvent(ID.heldResumed, 8);
    await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [ID.heldResumed, 'status_change', '待上线', '已暂缓', '等业务方确认', 'hold', 1, '管理员', ts(6)]
    );
    await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [ID.heldResumed, 'status_change', '已暂缓', '待上线', '恢复', 'resume', 1, '管理员', ts(4)]
    );
    return relId;
}

async function signAsAdmin() {
    const u = await get(`SELECT id, username, display_name, role FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`);
    if (!u) throw new Error(`${DB_PATH} 里找不到 admin 用户`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '2h' });
}

// 取某一行的 flag 实况（DOM 真相，不看源码）
async function readRow(page, id) {
    return page.evaluate((issueId) => {
        const rows = [...document.querySelectorAll('#siTbody tr')];
        const tr = rows.find((r) => (r.querySelector('td') || {}).textContent === `#${issueId}`);
        if (!tr) return null;
        const pick = (sel) => {
            const el = tr.querySelector(sel);
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { text: el.textContent.trim(), title: el.getAttribute('title') || '', color: cs.color };
        };
        const badge = tr.querySelector('.u-status-badge');
        const bcs = badge ? getComputedStyle(badge) : null;
        return {
            removed: pick('.si-flag.removed'),
            unsched: pick('.si-flag.unsched'),
            statusClass: badge ? badge.className : '',
            statusBg: bcs ? bcs.backgroundColor : '',
            statusFg: bcs ? bcs.color : '',
        };
    }, id);
}

(async function main() {
    console.log('=== 待上线可见性 · 两 flag 真实 DOM 实测 ===\n');
    if (!JWT_SECRET) { console.log('FAIL：.env 缺 JWT_SECRET'); process.exit(1); }
    if (!(await probeServer())) {
        console.log(`未探测到 ${BASE_URL} 上的 server。本脚本有意不自行 spawn（端口纪律）——请先起好：`);
        console.log(`  cd wbs-server && PORT=${PORT} node server.js`);
        process.exit(2);
    }
    console.log(`1. server 探测到（${BASE_URL}）`);

    let browser;
    try {
        const relId = await seed();
        console.log(`2. 夹具已造（单 ${createdIssueIds.join('/')}·批次 ${relId || '(建失败)'}·标记 ${RUN_TAG}）`);
        must(seedErrs.length === 0, `造数阶段无错误${seedErrs.length ? `：${seedErrs.join(' | ')}` : ''}`);

        const token = await signAsAdmin();
        browser = await chromium.launch();
        const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
        const consoleErrors = [];
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push(e.message));

        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((t) => localStorage.setItem('token', t), token);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page.waitForSelector('#siTbody tr', { timeout: 15000 });
        console.log('3. 列表已加载，开始读真实 DOM\n');

        // 扫描面非空（codex 349 号 MED·原注释停留在固定 ID 段时代已订正）：夹具走 SQLite 自增分配，
        //   id 必然大于建单时刻的全部存量单，列表按 id DESC + 每页 25 条 ⇒ 本批 5-6 张理应都在第一页。
        //   T3 可能因库中无 sys_releases 行而少造一张，其余 5 张必须都能在 DOM 里找到（下方逐条断言）。
        const rowsFound = await page.evaluate(() => document.querySelectorAll('#siTbody tr').length);
        must(rowsFound > 0, `列表行实抓 ${rowsFound} 行（抓不到=后面全部断言空转，不能当通过）`);

        // ── T1 未排期 ──
        const r1 = await readRow(page, ID.unsched);
        must(!!r1, `T1 未排期单 #${ID.unsched} 在列表 DOM 中`);
        if (r1) {
            must(!!r1.unsched && r1.unsched.text === '未排期', `T1 显示「未排期」flag（实得 ${r1.unsched ? r1.unsched.text : '无'}）`);
            must(!r1.removed, 'T1 不同时显示「已移出」（两 flag 互斥）');
            must(r1.unsched && r1.unsched.color === 'rgb(100, 116, 139)', `T1 未排期色 = #64748b slate（实得 ${r1.unsched && r1.unsched.color}）`);
        }

        // ── T2 已移出 + 悬停三要素 ──
        const r2 = await readRow(page, ID.removed);
        must(!!r2, `T2 已移出单 #${ID.removed} 在列表 DOM 中`);
        if (r2) {
            must(!!r2.removed && r2.removed.text === '已移出', `T2 显示「已移出」flag（实得 ${r2.removed ? r2.removed.text : '无'}）`);
            must(!r2.unsched, 'T2 不同时显示「未排期」（两 flag 互斥）');
            must(r2.removed && r2.removed.color === 'rgb(220, 38, 38)', `T2 已移出色 = #dc2626 红（实得 ${r2.removed && r2.removed.color}）`);
            const title = (r2.removed && r2.removed.title) || '';
            must(title.includes(REMOVE_REASON), 'T2 悬停含**原因**（后端 summary 原文，不二次拼装）');
            must(title.includes(REMOVE_BY), `T2 悬停含**操作人**（${REMOVE_BY}）`);
            must(/\d{4}-\d{2}-\d{2}/.test(title), 'T2 悬停含**时刻**');
        }

        // ── T3 正常态（仍挂批次）──
        //   ⚠️ 不再"库里没批次就跳过"（codex 350 号 MED）：批次已由本脚本自造，造不出来就是**故障**，
        //   必须红——它是唯一覆盖 D4「挂着批次时两 flag 都不显示」的浏览器断言，静默跳过等于假绿。
        must(!!relId, 'T3 前置：本次自造的批次可用（造不出来则 D4 门控无从验证，判红而非跳过）');
        const r3 = relId ? await readRow(page, ID.normal) : null;
        must(!!r3, `T3 正常态单 #${ID.normal} 在列表 DOM 中`);
        if (r3) must(!r3.removed && !r3.unsched, 'T3 仍挂批次 → 两个 flag 都不出现（D4 加回即消失）');

        // ── T4 状态门控（开发中 + 无批次）──
        const r4 = await readRow(page, ID.devNull);
        must(!!r4, `T4 开发中单 #${ID.devNull} 在列表 DOM 中`);
        if (r4) must(!r4.removed && !r4.unsched, 'T4 开发中且 release_id 为空 → 两 flag 都不出现（状态门控生效，非"只判 release_id"）');

        // ── T6 跨轮次不被历史移出污染（codex 348 号 MED）──
        const r6 = await readRow(page, ID.reopened);
        must(!!r6, `T6 跨轮次单 #${ID.reopened} 在列表 DOM 中`);
        if (r6) {
            must(!r6.removed, 'T6 上一轮曾被移出、本轮从未排期 → **不**显示「已移出」（轮次锚点过滤生效）');
            must(!!r6.unsched && r6.unsched.text === '未排期', `T6 本轮从未进批次 → 显示「未排期」（实得 ${r6.unsched ? r6.unsched.text : '无'}）`);
        }

        // ── T7 暂缓恢复不得冲掉本轮移出（codex 349 号 HIGH）──
        //   这条与 T6 是**反向一对**：T6 要求锚点把旧轮挡在外面，T7 要求锚点别把本轮自己挡掉。
        //   只做 T6 会诱导把锚点放宽到"任何回到待上线的事件"，那正是 349 号抓到的缺陷形态。
        const r7 = await readRow(page, ID.heldResumed);
        must(!!r7, `T7 暂缓恢复单 #${ID.heldResumed} 在列表 DOM 中`);
        if (r7) {
            must(!!r7.removed && r7.removed.text === '已移出',
                `T7 本轮被移出后暂缓又恢复 → 仍显示「已移出」（实得 ${r7.removed ? r7.removed.text : '无'}）——resume 写的 status_change 不得移动轮次锚点`);
            must(!r7.unsched, 'T7 不退化成「未排期」');
            must(((r7.removed && r7.removed.title) || '').includes(REMOVE_BY), 'T7 悬停仍取到本轮那条移出记录（判定列与展示列同源）');
        }

        // ── T5 第 14 层橙色：列表行 + 详情抽屉两个渲染面 ──
        if (r1) {
            must(/si-s-prerelease/.test(r1.statusClass), `T5a 列表行状态徽章类含 si-s-prerelease（实得 ${r1.statusClass}）`);
            must(r1.statusBg === 'rgb(255, 247, 237)', `T5a 列表行底色 = #fff7ed 橙（实得 ${r1.statusBg}）`);
            must(r1.statusFg === 'rgb(194, 65, 12)', `T5a 列表行文字色 = #c2410c（实得 ${r1.statusFg}）`);
        }
        // 详情抽屉是「待上线」徽章的第二个渲染面（Sys_Iteration.html 的抽屉渲染点），
        //   与列表共用 .si-s-prerelease 类——机制上同源，但"同源"是推理，这里亲眼看一次。
        await page.evaluate((id) => window.siOpenDrawer(id), ID.unsched);
        await page.waitForTimeout(1200);
        const drawer = await page.evaluate(() => {
            const el = document.querySelector('#siDrawer .u-status-badge, .drawer-body .u-status-badge, #siDrawerBody .u-status-badge');
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { cls: el.className, bg: cs.backgroundColor, fg: cs.color, text: el.textContent.trim() };
        });
        must(!!drawer, 'T5b 详情抽屉里找到状态徽章（找不到=这个渲染面没被验证到）');
        if (drawer) {
            must(/si-s-prerelease/.test(drawer.cls), `T5b 抽屉徽章类含 si-s-prerelease（实得 ${drawer.cls}）`);
            must(drawer.bg === 'rgb(255, 247, 237)', `T5b 抽屉底色同为 #fff7ed 橙（实得 ${drawer.bg}）——证明第二个渲染面也生效`);
        }

        must(consoleErrors.length === 0, `全程无 console error（实得 ${consoleErrors.length} 条${consoleErrors.length ? '：' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);
    } catch (e) {
        bad(`执行异常：${e && e.message}`);
    } finally {
        if (browser) await browser.close();
        // 清理结果进断言：清不干净要红，不能"跑完就算"（脏夹具会污染后续跑与人工亲验）
        const c = await cleanup();
        must(c.left === 0, `夹具已清理干净（按标记 ${RUN_TAG} 核对残留 ${c.left} 条，须为 0）`);
        if (c.errs.length) bad(`清理报错 ${c.errs.length} 条：${c.errs.join(' | ')}`);
        console.log(`\n4. 夹具清理完成（删 ${createdIssueIds.length} 张）`);
        db.close();
    }

    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    process.exit(fail === 0 ? 0 : 1);
})();
