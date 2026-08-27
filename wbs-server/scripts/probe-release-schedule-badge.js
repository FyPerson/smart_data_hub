/**
 * probe-release-schedule-badge.js
 *
 * 「上线排期三态徽章 + 待派执行人待办」的**活体验证**（2026-08-27 用户拍板三态/逾期/进待办卡）。
 *
 * 沙箱断言证的是谓词，本探针证的是**页面真的渲染成那样**——徽章文本要靠真实 DOM 读出来，
 * 「待我处理」的按批次去重也要在真实卡计数上成立（feedback_layer_green_not_feature_ready）。
 *
 * 用法：外部 server:3000 已起后 —— node scripts/probe-release-schedule-badge.js
 *
 * 覆盖（每条都配反例或对照，不做单向断言）：
 *   ① 未排期（release_id 为空）        → 徽章「未排期」
 *   ② 已排期·执行人 0                  → 徽章「待派执行人」
 *   ③ 已排期·执行人 >0                 → 徽章「已排期」
 *   ④ 逾期叠加（planned_date < 今天）  → 徽章变红并含「逾期N天」，且与 ②③ 组合措辞正确
 *   ⑤ 非「待上线」状态                 → 无徽章（范围门）
 *   ⑥ 待办按批次去重                   → 代表单进卡、同批次其它成员不进
 *
 * 夹具纪律：所有改动在 finally 里逐步独立还原（cleanupStep），并到磁盘核实；
 *   **只改本探针自己造的批次与单据**，不碰既有数据。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const TAG = 'PRSB-探针';

const db = new sqlite3.Database(DB_PATH);
const dbGet = (s, p = []) => new Promise((r, j) => db.get(s, p, (e, x) => e ? j(e) : r(x)));
const dbAll = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, x) => e ? j(e) : r(x)));
const dbRun = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this); }));

let pass = 0, fail = 0;
const failMsgs = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failMsgs.push(msg); }
    return cond;
}

async function signAs(userId) {
    const u = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!u) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    page.__errors = [];
    page.on('pageerror', e => page.__errors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => { localStorage.setItem('token', t); }, token);
    return page;
}

// 读某单在列表行里的「排期徽章」文本（状态列内、状态徽章之后的那个 u-status-badge）。
async function readBadge(page, issueId) {
    return await page.evaluate((id) => {
        const tr = document.querySelector(`tr[onclick="siOpenDrawer(${id})"]`);
        if (!tr) return '(行未找到)';
        const tds = tr.querySelectorAll('td');
        // 状态列 = 第 4 列（id/类型/优先级/状态），取其中第 2 个徽章
        const badges = tds[3] ? tds[3].querySelectorAll('.u-status-badge') : [];
        return badges.length < 2 ? '(无排期徽章)' : badges[1].textContent.trim();
    }, issueId);
}

(async () => {
    let browser = null;
    const created = { issues: [], releases: [], execs: [] };
    let ownerId = null;
    try {
        // 批次创建人取 admin（本地 id=1）——待办归属判据是 release_created_by === 当前 uid
        const admin = await dbGet("SELECT id FROM users WHERE username='admin'");
        must(!!admin, "前置：存在 username='admin' 账号");
        if (!admin) throw new Error('无 admin 账号');
        ownerId = admin.id;
        const execUser = await dbGet("SELECT id, display_name FROM users WHERE role='user' AND status='active' ORDER BY id LIMIT 1");
        must(!!execUser, '前置：存在可作执行人的 active user 账号');

        const mkIssue = async (title, releaseId) => {
            const r = await dbRun(
                `INSERT INTO sys_issues (title, type, status, system_name, priority, source, intake_required, created_by, created_by_name, release_id, created_at, updated_at)
                 VALUES (?, 'improvement', '待上线', 'BMS', 'P2', '内部', 1, ?, '管理员', ?, datetime('now','localtime'), datetime('now','localtime'))`,
                [title, ownerId, releaseId]
            );
            created.issues.push(r.lastID);
            return r.lastID;
        };
        const mkRelease = async (no, plannedDate) => {
            const r = await dbRun(
                `INSERT INTO sys_releases (release_no, status, planned_date, created_by, created_by_name, created_at)
                 VALUES (?, '计划中', ?, ?, '管理员', datetime('now','localtime'))`,
                [no, plannedDate, ownerId]
            );
            created.releases.push(r.lastID);
            return r.lastID;
        };

        // ── 夹具 ──
        const yesterday = new Date(Date.now() - 2 * 86400000);
        const pastDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const future = new Date(Date.now() + 5 * 86400000);
        const futureDate = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;

        const idNoRelease = await mkIssue(`${TAG}-未排期`, null);
        const relPending = await mkRelease(`${TAG}-R-未派人`, futureDate);
        const idPendingA = await mkIssue(`${TAG}-已排期未派人-代表`, relPending);
        const idPendingB = await mkIssue(`${TAG}-已排期未派人-非代表`, relPending);
        const relStaffed = await mkRelease(`${TAG}-R-已派人`, futureDate);
        const idStaffed = await mkIssue(`${TAG}-已排期已派人`, relStaffed);
        const execIns = await dbRun(
            `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name, created_at)
             VALUES (?, ?, ?, ?, '管理员', datetime('now','localtime'))`,
            [relStaffed, execUser.id, execUser.display_name, ownerId]
        );
        created.execs.push(execIns.lastID);
        const relOverdue = await mkRelease(`${TAG}-R-逾期未派人`, pastDate);
        const idOverdue = await mkIssue(`${TAG}-逾期未派人`, relOverdue);
        // [codex 481 LOW-2] 逾期 × 已派人 组合——两个维度都成立时措辞必须只报逾期、不误报"待派执行人"
        const relStaffedOverdue = await mkRelease(`${TAG}-R-逾期已派人`, pastDate);
        const idStaffedOverdue = await mkIssue(`${TAG}-逾期已派人`, relStaffedOverdue);
        const soIns = await dbRun(
            `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name, created_at)
             VALUES (?, ?, ?, ?, '管理员', datetime('now','localtime'))`,
            [relStaffedOverdue, execUser.id, execUser.display_name, ownerId]
        );
        created.execs.push(soIns.lastID);
        // [codex 481 LOW-2] 执行人全被软删 ⇒ COUNT(removed_at IS NULL)=0 ⇒ 仍应算"待派执行人"
        const relSoftDel = await mkRelease(`${TAG}-R-执行人已软删`, futureDate);
        const idSoftDeleted = await mkIssue(`${TAG}-执行人已软删`, relSoftDel);
        const sdIns = await dbRun(
            `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name, created_at, removed_at, removed_by, removed_by_name)
             VALUES (?, ?, ?, ?, '管理员', datetime('now','localtime'), datetime('now','localtime'), ?, '管理员')`,
            [relSoftDel, execUser.id, execUser.display_name, ownerId, ownerId]
        );
        created.execs.push(sdIns.lastID);
        // [分支⑨·2026-08-27] 复刻示例开发A形态：**我自己**是该批次在册执行人且 exec_status='pending'。
        //   批次创建人刻意设为别人（ownerId 之外），以证明 ⑨ 的命中来自"我是执行人"而非"我是创建人"
        //   ——若两者混用，这条会因 ⑧ 命中而假绿。
        const relMineToExec = await dbRun(
            `INSERT INTO sys_releases (release_no, status, planned_date, created_by, created_by_name, created_at)
             VALUES (?, '计划中', ?, ?, '他人', datetime('now','localtime'))`,
            [`${TAG}-R-我是执行人`, futureDate, execUser.id]
        );
        created.releases.push(relMineToExec.lastID);
        const idExecMineA = await mkIssue(`${TAG}-我要上线-代表`, relMineToExec.lastID);
        const idExecMineB = await mkIssue(`${TAG}-我要上线-非代表`, relMineToExec.lastID);
        const meExecIns = await dbRun(
            `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name, created_at, exec_status)
             VALUES (?, ?, '管理员', ?, '他人', datetime('now','localtime'), 'pending')`,
            [relMineToExec.lastID, ownerId, execUser.id]
        );
        created.execs.push(meExecIns.lastID);
        // [codex 481 HIGH-1] 孤儿批次：先建后删批次，留下指向已不存在批次的 release_id
        //   （本项目 PRAGMA foreign_keys 恒 OFF，故可构造；生产实查孤儿 0 行，但机制上可发生）
        const relToDelete = await mkRelease(`${TAG}-R-将被删除`, futureDate);
        const idOrphan = await mkIssue(`${TAG}-孤儿批次`, relToDelete);
        await dbRun('DELETE FROM sys_releases WHERE id=?', [relToDelete]);
        created.releases = created.releases.filter(x => x !== relToDelete);   // 已删，不必再清理
        const idNotRelease = await dbRun(
            `INSERT INTO sys_issues (title, type, status, system_name, priority, source, intake_required, created_by, created_by_name, release_id, created_at, updated_at)
             VALUES (?, 'improvement', '开发中', 'BMS', 'P2', '内部', 1, ?, '管理员', ?, datetime('now','localtime'), datetime('now','localtime'))`,
            [`${TAG}-开发中挂批次`, ownerId, relPending]
        );
        created.issues.push(idNotRelease.lastID);
        must(created.issues.length === 11 && created.releases.length === 6, `夹具就绪：${created.issues.length} 单 + ${created.releases.length} 批次（未排期/未派人×2/已派人/逾期未派人/逾期已派人/软删执行人/**我是执行人×2**/孤儿批次/开发中挂批次）`);

        browser = await chromium.launch();
        const tok = await signAs(ownerId);
        const page = await loginPage(browser, tok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);

        console.log('\n— 三态徽章 —');
        must(await readBadge(page, idNoRelease) === '未排期', `① 未挂批次 → 「未排期」（实得「${await readBadge(page, idNoRelease)}」）`);
        must(await readBadge(page, idPendingA) === '待派执行人', `② 已排期·执行人 0 → 「待派执行人」（实得「${await readBadge(page, idPendingA)}」）`);
        must(await readBadge(page, idStaffed) === '已排期', `③ 已排期·执行人 1 → 「已排期」（实得「${await readBadge(page, idStaffed)}」）`);

        console.log('\n— 逾期叠加 —');
        const overdueTxt = await readBadge(page, idOverdue);
        must(/逾期\d+天/.test(overdueTxt) && /待派执行人/.test(overdueTxt),
            `④ 逾期 + 未派人 → 徽章同时含「逾期N天」与「待派执行人」（实得「${overdueTxt}」）——两个维度须在一个徽章里，不并排两个`);
        must(!/逾期/.test(await readBadge(page, idPendingA)),
            `④ 反例·未逾期批次不得显示逾期（计划日在未来，实得「${await readBadge(page, idPendingA)}」）`);

        console.log('\n— [codex 481 LOW-2] 逾期×已派人组合 / 软删执行人 / 孤儿批次 / 红色断言 —');
        const staffedOverdueTxt = await readBadge(page, idStaffedOverdue);
        must(/逾期\d+天/.test(staffedOverdueTxt) && !/待派执行人/.test(staffedOverdueTxt),
            `④b 逾期 + **已派人** → 只报逾期、不得说"待派执行人"（实得「${staffedOverdueTxt}」）——人已派好，说没派就是错话`);
        must(await readBadge(page, idSoftDeleted) === '待派执行人',
            `④c 执行人全被软删（removed_at 非空）→ 仍算"待派执行人"（实得「${await readBadge(page, idSoftDeleted)}」）——COUNT 用 removed_at IS NULL，与 idx_sys_release_exec_active 同口径`);
        must(await readBadge(page, idOrphan) === '批次已失效',
            `④d [HIGH-1] 孤儿批次（release_id 指向已删批次）→ 「批次已失效」而非「待派执行人」（实得「${await readBadge(page, idOrphan)}」）——不是没派人，是这条关联本身失效了`);
        const overdueColor = await page.evaluate((id) => {
            const tr = document.querySelector(`tr[onclick="siOpenDrawer(${id})"]`);
            const b = tr && tr.querySelectorAll('td')[3].querySelectorAll('.u-status-badge')[1];
            return b ? getComputedStyle(b).color : '(无)';
        }, idOverdue);
        must(/rgb\(185,\s*28,\s*28\)/.test(overdueColor),
            `④e 逾期徽章须真的渲染成红色（computed color 实得「${overdueColor}」，期望 rgb(185,28,28)=#b91c1c）——用户拍板"叠加变红"，只改文案不变色等于没做`);

        console.log('\n— 范围门 —');
        must(await readBadge(page, idNotRelease.lastID) === '(无排期徽章)',
            `⑤ 非「待上线」状态（开发中）即便挂了批次也不显示排期徽章（实得「${await readBadge(page, idNotRelease.lastID)}」）`);

        console.log('\n— 「待我处理」按批次去重 —');
        const cardSel = '.u-stat-card[onclick="siSetStatFilter(\'my_pending\')"]';
        const hasCard = (await page.locator(cardSel).count()) > 0;
        must(hasCard, '⑥ 「待我处理」卡应渲染（批次创建人有待派执行人的批次）');
        if (hasCard) {
            await page.locator(cardSel).click();
            await page.waitForTimeout(500);
            const inCard = async (id) => (await page.locator(`tr[onclick="siOpenDrawer(${id})"]`).count()) === 1;
            must(await inCard(idPendingA), `⑥ 代表单 #${idPendingA} 应在卡内（批次待派执行人）`);
            must(!(await inCard(idPendingB)), `⑥ ⭐同批次非代表单 #${idPendingB} 不应在卡内——按批次去重计 1，否则一次派人消掉 N 个计数`);
            must(await inCard(idOverdue), `⑥ 逾期未派人批次的代表单 #${idOverdue} 也应在卡内`);
            must(!(await inCard(idStaffed)), `⑥ 已派执行人的批次不应进卡（无人需要动作）`);
            must(!(await inCard(idNoRelease)), `⑥ 未挂批次的单不应因本分支进卡（那是"未排期"，责任在对接人/admin 加单，非"批次没派人"）`);
            must(!(await inCard(idOrphan)), `⑥ [HIGH-1] 孤儿批次的单不应进卡（无责任人可认领——created_by 已随批次消失，进卡等于"报了警没人负责"）`);
            must(await inCard(idSoftDeleted), `⑥ 执行人全软删的批次代表单应进卡（等同未派人）`);
            must(!(await inCard(idStaffedOverdue)), `⑥ 逾期但已派人的批次不进卡（逾期该催的是"去上线"，不是"去派人"——本分支只管派人）`);
            // [codex 481 LOW-2] 去重的**聚合**证明：逐条"某行在不在"只证明了单点，证明不了"整体上
            //   N 个成员塌缩成 M 个待办"。这里对本探针造的 4 张待派人成员单（分属 3 个批次：未派人
            //   批次含 2 成员、逾期未派人 1、软删 1）做聚合计数——卡内应恰 3 张（每批次 1 个代表），
            //   若未去重会是 4。
            //   ⚠️ 刻意**不用"卡计数 == 点卡后行数"**：列表有分页（实测计数 53 / 首页 25 行），该等式
            //   本身不成立，首版这么写是断言错而非实现错（一日内第三次同类：判据没考虑被测系统的
            //   既有机制）。本聚合判据只数自己造的夹具，不受分页与他人数据影响。
            const myFixtureMembers = [idPendingA, idPendingB, idOverdue, idSoftDeleted];
            const inCardFlags = [];
            for (const id of myFixtureMembers) inCardFlags.push(await inCard(id));
            const inCardCount = inCardFlags.filter(Boolean).length;
            must(inCardCount === 3,
                `⑥ ⭐去重聚合证明：4 张待派人成员单分属 3 个批次，卡内应恰 3 张（每批次 1 个代表），实得 ${inCardCount}——为 4 说明未去重（同批次两个成员都进了卡）`);

            // ── ⑦ 分支⑨：我是执行人且未执行（示例开发A形态）──
            must(await inCard(idExecMineA),
                `⑦ ⭐[分支⑨] 我是在册执行人且 exec_status=pending 的批次，其代表单 #${idExecMineA} 应在卡内——这正是示例开发A在 R-20260824-3 上的处境（钉钉早发过、批次已逾期，持续清单里却没有他这条）`);
            must(!(await inCard(idExecMineB)),
                `⑦ [分支⑨去重] 同批次非代表单 #${idExecMineB} 不应在卡内——执行上线是批次级动作（POST /sys-releases/:id/execute），一次点完整批`);
            must(await readBadge(page, idExecMineA) === '已排期',
                `⑦ 该批次徽章应是「已排期」（执行人已派好，只是还没执行）——⑨ 管的是"该执行了"，与徽章的"该派人了"是两件事，实得「${await readBadge(page, idExecMineA)}」`);
        }
        must(page.__errors.length === 0, `⑥ 页面无 JS 错误（实得 ${page.__errors.length} 条${page.__errors.length ? '：' + page.__errors[0] : ''}）`);
        await page.close();
    } catch (e) {
        fail++; failMsgs.push('异常：' + e.message);
        console.error('\n❌ 探针异常：', e.stack || e.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        async function cleanupStep(label, fn) {
            try { await fn(); return true; }
            catch (e) { console.error(`  ⚠️ 清理失败（${label}）：${e.message}`); fail++; failMsgs.push(`清理失败（${label}）：${e.message}`); return false; }
        }
        console.log('');
        for (const id of created.execs) {
            await cleanupStep(`删执行人行 #${id}`, () => dbRun('DELETE FROM sys_release_executors WHERE id=?', [id]));
        }
        for (const id of created.issues) {
            await cleanupStep(`删单 #${id}`, () => dbRun('DELETE FROM sys_issues WHERE id=?', [id]));
        }
        for (const id of created.releases) {
            await cleanupStep(`删批次 #${id}`, () => dbRun('DELETE FROM sys_releases WHERE id=?', [id]));
        }
        await cleanupStep('残留核实', async () => {
            const li = created.issues.length ? await dbAll(`SELECT id FROM sys_issues WHERE id IN (${created.issues.map(() => '?').join(',')})`, created.issues) : [];
            const lr = created.releases.length ? await dbAll(`SELECT id FROM sys_releases WHERE id IN (${created.releases.map(() => '?').join(',')})`, created.releases) : [];
            const le = created.execs.length ? await dbAll(`SELECT id FROM sys_release_executors WHERE id IN (${created.execs.map(() => '?').join(',')})`, created.execs) : [];
            const desc = [li.length ? `单 ${li.map(x => x.id)}` : null, lr.length ? `批次 ${lr.map(x => x.id)}` : null, le.length ? `执行人行 ${le.map(x => x.id)}` : null].filter(Boolean).join('、');
            must(!li.length && !lr.length && !le.length,
                desc ? `🧹 清理到磁盘核实：仍有残留=${desc}——⚠️ 需人工删除` : '🧹 清理到磁盘核实：三类夹具均已删净（残留 0）');
        });
        db.close();
    }
    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail) { console.log('失败清单：'); failMsgs.forEach(m => console.log('  - ' + m)); process.exit(1); }
})();
