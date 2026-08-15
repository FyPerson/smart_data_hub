/**
 * 系统迭代·先行上线两步化（S6/S7）前端 Playwright 活体验证（S8 首次真跑）
 * 用法：本地 server（3000）已用最新代码启动后：node scripts/test-sys-fastlane-playwright.js
 *
 * 覆盖（方案 §8 + codex 392 五点双源）：
 *   ① 徽章三态 DOM：1/2（done/total 均非零）· 0/0（待配置执行人）· 消费后消失（status 转出待验证）
 *   ② 四身份按钮矩阵：admin（非在册）/ 普通执行人（在册非 admin）/ admin 兼执行人（SQL 造态，正常流程
 *      结构性不可达——hasReleaseEligibility 显式排除 admin 角色，见 index.js:13416，本组只测前端渲染
 *      逻辑在这一假设组合下是否正确，非声称此业务态可通过正常操作达成）/ 无关用户 403
 *   ③ 三动作双面刷新（加人/移人/确认后抽屉+列表同步）+ 末位确认 flipped 后已上线态 + 补验收入口 + 48h
 *      圈红起点（released_at 刚写入，overdue 应为 false）
 *   ④ 失败响应活体（FROZEN/NOT_STAGED 真实 409 toast）+ 六码 timeline 行 DOM 逐码核对（374-H 收口要求）
 *   ⑤ 其余页面硬刷新烟测（console 零错误 + 徽章 CSS 生效抽一页核对新缓存串）
 *
 * 夹具口径：当日值班读真实 sys_release_duty_roster（同 test-sys-post-release-accept-fail-note-playwright.js
 * 既定"当日已有别人值班"防御模式：先查，有则复用其身份，避免撞 partial UNIQUE 崩溃）；0/0 场景需要"当日
 * 无值班"这一相反前提，用完整 try/finally 包裹临时软删+恢复，防污染真实生产/本地库数据。
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
const DEV_ID = 8;          // 示例开发A（同既有 fail-note 测试复用账号）
// [R2·HIGH] SECOND_EXEC_ID/OUTSIDER_ID 改 let——本文件"四身份互斥"假设（admin/普通执行人/无关用户三个
// 角色互不重叠）依赖这两个固定字面量 id 真的与「当日真实值班人」不是同一个人。之前硬编码 9/10，若
// 运行环境当日值班人恰好是示例开发B(9)或示例开发C(10)，"普通执行人(在册非admin)"与"无关用户403"两组断言会
// 静默测错对象（值班人被误当第二执行人/无关用户，矩阵名不副实但不报错）。main() 起手先探测冲突、
// 冲突时动态换人（见 resolveConflictFreeIdentities），故此处改可重新赋值。
let SECOND_EXEC_ID = 9;  // 示例开发B（默认值，可能被 main() 动态替换）
let OUTSIDER_ID = 10;    // 示例开发C（默认值，可能被 main() 动态替换）——用于「无关用户」403 场景，须确保对目标单无任何关联身份

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
        const p = path.join(SCREENSHOT_DIR, `fastlane-fail-${name}.png`);
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
    page._consoleErrors = consoleErrors;
    return page;
}
function siFlagsInRow(page, issueId) {
    return page.locator(`tr[onclick="siOpenDrawer(${issueId})"] .u-status-badge.sem-fastlane`);
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

let seq = 0;
// 建单→受理→指派→估时→授权，止于"处理中"态（调用方自行决定何时 submit）。
async function mkBugToChulizhong(adminTok, devTok, titleTag) {
    seq++;
    const r = await fetchJson('/api/sys-issues', adminTok, {
        method: 'POST', body: {
            intake_contract_version: 2, type: 'bug', title: `FLPW-${titleTag}-${seq}`, system_name: 'BMS', source: '内部',
            description: `先行上线 Playwright 活体夹具-${seq}`, intake_liaison_id: 13,
        },
    });
    if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    let resp = await fetchJson(`/api/sys-issues/${id}/intake-accept`, adminTok, { method: 'POST', body: {} });
    if (resp.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${resp.status} ${JSON.stringify(resp.body)}`);
    resp = await fetchJson(`/api/sys-issues/${id}/assign`, adminTok, { method: 'POST', body: { assigned_to: DEV_ID } });
    if (resp.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${resp.status} ${JSON.stringify(resp.body)}`);
    const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
    resp = await fetchJson(`/api/sys-issues/${id}/estimate`, devTok, { method: 'POST', body: { dev_estimated_at: futureEst } });
    if (resp.status !== 200) throw new Error(`[夹具-估时] 应 200，实得 ${resp.status} ${JSON.stringify(resp.body)}`);
    resp = await fetchJson(`/api/sys-issues/${id}/fast-release-authorize`, adminTok, { method: 'POST', body: { note: `FLPW-授权-${seq}` } });
    if (resp.status !== 200) throw new Error(`[夹具-授权] 应 200，实得 ${resp.status} ${JSON.stringify(resp.body)}`);
    return id;
}
// submit 挂牌（授权活跃时同事务挂牌）——不预设当日值班身份，调用方自行保证当日值班状态。
async function submitAndStage(id, devTok) {
    const resp = await fetchJson(`/api/sys-issues/${id}/submit`, devTok, {
        method: 'POST', body: {
            mode: 'commits', self_tested: true, test_env_deployed: true,
            bug_cause_note: 'FLPW 探针：bug 产生原因',
            commits: [{ component: 'backend', commit_ref: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
        },
    });
    if (resp.status !== 200) throw new Error(`[夹具-提交] 应 200，实得 ${resp.status} ${JSON.stringify(resp.body)}`);
    if (resp.body.main_status !== '待验证') throw new Error(`[夹具-提交] main_status 应为「待验证」，实得 ${resp.body.main_status}`);
    return resp.body;
}
// 当日值班探测——防御"当日已有别人值班"（partial UNIQUE(duty_date) WHERE removed_at IS NULL）。
async function getTodayDuty() {
    return dbGet(`SELECT user_id, user_name FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
}
// [R2·HIGH·身份矩阵互斥校验] 若当日真实值班人恰好等于 SECOND_EXEC_ID(9)/OUTSIDER_ID(10) 这两个固定
// 测试角色 id，会让"四身份互斥"假设失真：
//   · 值班人=SECOND_EXEC_ID → ①b/①c 挂牌集合与②测试里"加第二执行人"会把同一个人加两次（该单值班人
//     本就在挂牌集合里，再把 SECOND_EXEC_ID 当"新增的第二人"添加，实为同一账号，"非末位/末位确认"两次
//     确认的顺序语义会乱套）。
//   · 值班人=OUTSIDER_ID → ②c"无关用户 403"这条断言测的其实是当日值班人（真实在册执行人），而非真正
//     无关的第三方，该断言会静默失去意义（403 判断变成测"在册者能不能看别的单"而非"无关用户能不能看"）。
// 冲突时不改动真实值班数据本身（那是"复用不改写"的既有防御哲学），而是动态从 users 表挑一个当前未被
// 占用（不等于 ADMIN_ID/DEV_ID/值班人本人）的普通用户账号顶替冲突的那个测试角色。
async function pickAvailableUser(excludeIds) {
    const rows = await dbAll(
        `SELECT id FROM users WHERE status='active' AND role='user' AND id NOT IN (${[...excludeIds].map(Number).join(',') || '0'}) ORDER BY id`
    );
    if (!rows.length) throw new Error(`[R2] 找不到可用的替补普通用户账号（排除集=${JSON.stringify([...excludeIds])}，users 表候选耗尽）`);
    return Number(rows[0].id);
}
async function resolveConflictFreeIdentities() {
    const existingDuty = await getTodayDuty();
    if (!existingDuty) return;   // 当日无值班——本文件后续会插入 DEV_ID 作为值班人，与 9/10 恒不冲突，无需换人。
    const dutyUserId = Number(existingDuty.user_id);
    const dutyUser = await dbGet('SELECT role, status FROM users WHERE id=?', [dutyUserId]);
    console.log(`  （[R2] 当日真实值班人 user_id=${dutyUserId}(${existingDuty.user_name})·role=${dutyUser && dutyUser.role}·status=${dutyUser && dutyUser.status}）`);
    const usedIds = new Set([ADMIN_ID, DEV_ID, dutyUserId]);
    if (dutyUserId === SECOND_EXEC_ID) {
        const replacement = await pickAvailableUser(usedIds);
        console.log(`  ⚠️ [R2] 值班人与 SECOND_EXEC_ID(${SECOND_EXEC_ID}) 冲突，动态换人 → ${replacement}`);
        SECOND_EXEC_ID = replacement;
        usedIds.add(replacement);
    }
    if (dutyUserId === OUTSIDER_ID || OUTSIDER_ID === SECOND_EXEC_ID) {
        const replacement = await pickAvailableUser(usedIds);
        console.log(`  ⚠️ [R2] 值班人或 SECOND_EXEC_ID 与 OUTSIDER_ID(${OUTSIDER_ID}) 冲突，动态换人 → ${replacement}`);
        OUTSIDER_ID = replacement;
    }
    // 值班人本身若恰好是 admin/viewer——结构性不应发生（值班表由业务约定只登记普通执行人角色候选），
    // 仍显式核实一遍（fail-closed 精神同本文件既有纪律），异常时响亮失败而非静默继续跑一套错误矩阵。
    if (dutyUser && (dutyUser.role === 'admin' || dutyUser.role === 'viewer')) {
        throw new Error(`[R2] 当日值班人 user_id=${dutyUserId} 角色异常（role=${dutyUser.role}，应为普通 user）——值班数据可能有误，需人工核实，本文件的身份矩阵假设不成立，拒绝继续跑`);
    }
}
// [S8-S10 合并收口批 F10] userName 不再由调用方硬编码传入——直接查 users 表取真实 display_name/username，
//   防止调用方写死的字面量（此前 '示例开发A'）与库内真实值哪天不同步（改名/换号）时静默插入错误姓名。
//   同时返回本次真正插入行的 id（`insertedRowId`，preExisting=true 时恒 null）——供 main() 的 finally 精确
//   回滚"仅自己插的那一行"，而非本文件此前"一律不删"的粗粒度处置（见 finally 块新注释）。
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
// 临时清空当日值班（0/0 场景需要）——返回一个 restore() 函数，finally 内必调用。
// [R3] ⚠️ 并发警示：本函数操作的是"当日值班"这个**全局单例**状态（partial UNIQUE(duty_date)），同一时刻
// 只允许一份"当前值班人"存在。若两个进程/两次本文件调用在时间上重叠运行，后一个的软删/恢复会与前一个
// 互相踩踏（谁的 before 快照先读到、谁的 restore 后执行，结果取决于时序，不是幂等的）——**禁止并发跑
// 本文件的多个实例**，也不要在 CI 里把本文件配置成可并行的多 job。
async function clearTodayDutyTemporarily() {
    // 【2026-08-14 codex 395 预筛 NEW-2】删除"运行前残留检查+启发式自愈"——`removed_by = ADMIN_ID` 这个
    // 判据**无法区分**"上次本文件运行异常中断留下的残留"与"admin 今天真的手工撤销了值班安排"两种情况
    // （生产/开发库里 admin 撤销值班就是走同一条 UPDATE、同一个 removed_by=1），自动把后者当"残留"一并
    // 恢复，等于**悄悄撤销了一次真实的人工操作**——这比"留一条没清理干净的测试残留"严重得多（后者只是
    // 脏但可见，前者是静默篡改真实业务数据）。改为 fail-fast：检测到"当日已软删且 removed_by=ADMIN_ID"
    // 的行，只输出诊断信息供人工核对是否为残留，不做任何自动恢复——本函数自身的软删/恢复仍按"本次运行
    // 显式记录的行 ID"执行（下方 before 数组是内存记录，只精确操作**这一次调用**真正读到并软删的那些
    // 行，不依赖任何跨运行的启发式猜测）。
    // 【2026-08-14 codex 396 NEW-2】原文案"若是真实撤销记录，本文件不受影响，可直接重跑"与真实场景矛盾
    // ——若真是 admin 今天手工撤销的值班（非测试残留），`duty_date=今天` 这个判据条件不会随时间推移
    // 而消失，同一天内立刻重跑会命中一模一样的行、再次 fail-fast，"直接重跑"这条路径在当天根本走不通、
    // 是一句兑现不了的空承诺。改为如实的三选项文案（不再假装"重跑就能过"）：
    //   ① 人工核实后确认可放行，设环境变量 SKIP_DUTY_GUARD=1 显式跳过本检查（下方支持，跳过时打印醒目
    //      警示——本条路径会让"当日值班"被软删/覆盖，仅限已人工确认当前这些行确属安全可覆盖场景时使用）；
    //   ② 改日再跑——`duty_date = date('now','localtime')` 明天会变成新的日期值，今天遗留的这些行不会
    //      再被本查询命中，是唯一不需要人工介入就能自然解除阻塞的路径；
    //   ③ 人工核实确属测试残留后，手工执行下方给出的 SQL 清理这些行，再重跑。
    if (process.env.SKIP_DUTY_GUARD === '1') {
        console.warn('  ⚠️⚠️⚠️ [NEW-2] SKIP_DUTY_GUARD=1 已显式设置——跳过"当日已软删值班行"残留/真实撤销区分检查，' +
            '直接按"当前在册"（removed_at IS NULL）行执行软删+恢复，不核实那些已软删行的成因。仅限已人工确认' +
            '安全时使用，误用可能覆盖一次真实的人工撤销操作！⚠️⚠️⚠️');
    } else {
        const suspiciousRemoved = await dbAll(
            `SELECT id, user_id, user_name, removed_at FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NOT NULL AND removed_by = ?`,
            [ADMIN_ID]
        );
        if (suspiciousRemoved.length) {
            throw new Error(
                `[NEW-2 fail-fast] 发现 ${suspiciousRemoved.length} 条当日已软删的值班行（removed_by=ADMIN_ID）：${JSON.stringify(suspiciousRemoved)}——` +
                `本文件无法判断这是"上次运行异常中断的残留"还是"admin 今天真实撤销了值班安排"，为避免误"恢复"掉一次真实的人工操作，` +
                `拒绝自动处理。三选一（均需先人工核对 task_pool.db 的 sys_release_duty_roster 表，不建议盲选）：` +
                `① 已人工确认可放行 → 设环境变量 SKIP_DUTY_GUARD=1 后重跑本文件，跳过本检查；` +
                `② 不急的话，明天（新的 duty_date）再跑本文件——今天这些残留行不会再被命中，无需人工介入；` +
                `③ 确认是测试残留 → 手工执行 ` +
                `\`UPDATE sys_release_duty_roster SET removed_at=NULL, removed_by=NULL, removed_by_name=NULL WHERE id IN (${suspiciousRemoved.map(r => r.id).join(',')})\` ` +
                `清理后重跑（⚠️ 若这些行其实是 admin 今天的真实撤销记录，执行这条 SQL 会悄悄恢复一次已被人工撤销的值班安排，务必先核实再执行）。`
            );
        }
    }
    // 内存记录——本次调用真正读到、真正软删的那些行（唯一的"自愈"依据来源，不查询/推断任何跨调用状态）。
    const before = await dbAll(`SELECT id, user_id, user_name FROM sys_release_duty_roster WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
    if (before.length) {
        await dbRun(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = '管理员' WHERE duty_date = date('now','localtime') AND removed_at IS NULL`, [ADMIN_ID]);
    }
    return async function restore() {
        for (const row of before) {
            await dbRun(`UPDATE sys_release_duty_roster SET removed_at = NULL, removed_by = NULL, removed_by_name = NULL WHERE id = ?`, [row.id]);
        }
        const after = await getTodayDuty();
        if (before.length && (!after || Number(after.user_id) !== Number(before[0].user_id))) {
            // [R3] 恢复失败——不能只抛错让人一脸懵，直接给出可以手工执行的恢复 SQL（复制粘贴到 sqlite3
            // task_pool.db 即可救回原状态），减少事故现场排查成本。
            const manualSql = before.map(r => `UPDATE sys_release_duty_roster SET removed_at = NULL, removed_by = NULL, removed_by_name = NULL WHERE id = ${r.id};`).join('\n');
            throw new Error(`[清理] 当日值班恢复失败——恢复前=${JSON.stringify(before)}，恢复后=${JSON.stringify(after)}。请手工在 task_pool.db 执行以下 SQL 恢复原值班状态：\n${manualSql}`);
        }
    };
}

// [S8-S10 合并收口批 F9] 同既有 test-sys-release-panel-c2b2-playwright.js:188-195 范式（playwright_suite_gotchas.md
// 第4条）：本套件契约=外部已启动的 dev server:3000，脚本自己不拉起服务。跑前用端口 Listen 探测代替
// "直接 goto 然后让 Playwright 自己超时"——前者错误信息精确（"server 未起"），后者会含糊地卡在某个
// 具体断言上，排障耗时更久。⚠️ 探测放在 main() 最前面、try/finally 块之外——server 未监听时本函数
// 直接 throw，永远不会进入下方拥有 createdIds 清理逻辑的 try/finally，天然避免"对一个从未真正建过任何
// 夹具的空/不完整 createdIds 数组跑 DELETE"这类无意义甚至可能误伤的清理动作。
// [R4] host/port 从 BASE_URL 派生（new URL），不再硬编码 127.0.0.1:3000——若环境显式配了
// TEST_BASE_URL（如指向另一台机器/另一端口），探测目标须与后续所有 fetch/goto 请求打到同一处，
// 否则"探测通过"证明的是另一个地址，对本次真正要用的 BASE_URL 毫无意义。
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
// [R4] TCP 连接成功只证明"有某个进程在监听这个端口"，不证明"监听者是目标 server.js"——孤儿进程/
// 其它服务误占用同端口都能让裸 TCP 探测通过（同 MEMORY「生产 PM2 孤儿监听恢复」踩坑：孤儿进程也能
// 外网 200）。追加一次应用层 readiness 探测：命中本模块专属挂载的 /api/sys-issues/_readiness 端点
// （该路由仅系统迭代模块注册，非任意 Node 服务都会有），不带 token 应得到该端点的 authenticateToken
// 中间件产出的 401（未登录）——精确的错误形状本身就是"这是目标 server.js 且路由已挂载"的证据，比单纯
// "能连上端口"更接近"这确实是我们要测的那个应用"。
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
    // [R2] 身份矩阵互斥校验须在签发 SECOND_EXEC_ID/OUTSIDER_ID 的 token 之前完成（该函数可能就地
    // 重新赋值这两个模块级变量）。
    await resolveConflictFreeIdentities();
    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const secondTok = await signAs(SECOND_EXEC_ID);
    const outsiderTok = await signAs(OUTSIDER_ID);
    console.log('\n══════ 系统迭代·先行上线两步化 前端 Playwright 活体验证（S8 首跑） ══════');

    const createdIds = [];
    // [S8-S10 合并收口批 F10] 提到 try 块外——finally 需要读 duty.preExisting/insertedRowId 做精确回滚
    // （仅回滚本次真正插入的那一行），必须在 try/finally 两侧都可见。
    let duty = null;
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // ① 徽章三态 DOM
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ① 徽章三态 DOM ──');
        // ①a 0/0：临时清空当日值班
        {
            const restore = await clearTodayDutyTemporarily();
            try {
                const id = await mkBugToChulizhong(adminTok, devTok, 'badge00');
                createdIds.push(id);
                await submitAndStage(id, devTok);
                const feRows = await dbAll('SELECT * FROM sys_fast_release_executors WHERE issue_id=? AND removed_at IS NULL', [id]);
                must(feRows.length === 0, `①a-前置 当日无值班，挂牌集合应恰 0 行（实得 ${feRows.length}）`);

                const page = await loginPage(browser, adminTok);
                await page.goto(`${BASE_URL}/Sys_Iteration.html`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                const badgeText = await siFlagsInRow(page, id).textContent().catch(() => '');
                await shotOnFail(page, /待先行部署\s*0\/0/.test(badgeText || ''), 'badge-00-text', `①a 列表徽章应显示"待先行部署 0/0"（实得="${badgeText}"）`);
                await shotOnFail(page, /待配置执行人/.test(badgeText || ''), 'badge-00-suffix', `①a 0/0 徽章应含"待配置执行人"提示（实得="${badgeText}"）`);
                await page.close();
            } finally {
                await restore();
            }
        }

        // ①b/①c：1/2（done/total 均非零，先 0/2 后 1/2）+ 消费后消失
        duty = await ensureTodayDuty(DEV_ID);
        console.log(`  （当日值班：user_id=${duty.userId}${duty.preExisting ? '·真实已有，复用' : '·测试插入'}）`);
        const dutyTok = duty.userId === DEV_ID ? devTok : await signAs(duty.userId);

        const id12 = await mkBugToChulizhong(adminTok, devTok, 'badge12');
        createdIds.push(id12);
        await submitAndStage(id12, devTok);
        {
            const feRows = await dbAll('SELECT user_id FROM sys_fast_release_executors WHERE issue_id=? AND removed_at IS NULL', [id12]);
            must(feRows.length === 1 && Number(feRows[0].user_id) === duty.userId, `①b-前置 挂牌应恰 1 行=当日值班人（实得 ${JSON.stringify(feRows)}）`);
        }
        // admin 加第二执行人（示例开发B）——API 直调，DOM 验证放在③一并做，这里只需要状态。
        {
            const addR = await fetchJson(`/api/sys-issues/${id12}/fast-release-executors`, adminTok, { method: 'POST', body: { user_id: SECOND_EXEC_ID } });
            must(addR.status === 200, `①b-前置 加第二执行人应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
        }
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const badgeText0 = await siFlagsInRow(page, id12).textContent().catch(() => '');
            await shotOnFail(page, /待先行部署\s*0\/2/.test(badgeText0 || ''), 'badge-02-text', `①b 加人后徽章应为"待先行部署 0/2"（实得="${badgeText0}"）`);
            await page.close();
        }
        // 值班人（示例发布者/示例开发A）确认（非末位，因还有示例开发B pending）
        {
            const rc = await fetchJson(`/api/sys-issues/${id12}/fast-release-exec-confirm`, dutyTok, { method: 'POST', body: {} });
            must(rc.status === 200 && rc.body.flipped === false, `①b-前置 值班人确认应 200 且非末位(flipped=false)，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
        }
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            // [S8-S10 合并收口批 F7] 正控制：先钉 count===1（本单确实有 1 行匹配徽章 locator），再断文案——
            //   与下方"末位确认翻牌后 badgeCountAfter===0"互为正反控制对：若 siFlagsInRow 的 locator 本身写错
            //   （永远匹配不到任何行），下方"0 个"会假通过（其实从未真正观测到过"曾经是 1"）；有这条正控制
            //   在前，"0"才有意义地代表"从 1 变成 0"，而非"locator 一直是空的"。
            const badgeCountBefore = await siFlagsInRow(page, id12).count();
            await shotOnFail(page, badgeCountBefore === 1, 'badge-12-count-before', `①c 末位确认前应恰 1 行匹配待先行部署徽章 locator（实得 ${badgeCountBefore} 行）——正控制，与下方"翻牌后 0 行"成对`);
            const badgeText1 = await siFlagsInRow(page, id12).textContent().catch(() => '');
            await shotOnFail(page, /待先行部署\s*1\/2/.test(badgeText1 || ''), 'badge-12-text', `①c done_count 变化应反映在徽章文案"待先行部署 1/2"（实得="${badgeText1}"）`);
            const t1t1UnexpectedErrors = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
            await shotOnFail(page, t1t1UnexpectedErrors.length === 0, 'badge-console-clean', `①c 徽章三态阶段无非预期 console 报错（实得 ${t1t1UnexpectedErrors.length} 个）`);
            await page.close();
        }
        // 示例开发B（末位）确认 ⇒ 翻牌已上线 ⇒ 徽章应消失
        {
            const rc2 = await fetchJson(`/api/sys-issues/${id12}/fast-release-exec-confirm`, secondTok, { method: 'POST', body: {} });
            must(rc2.status === 200 && rc2.body.flipped === true, `①c-前置 末位确认应 flipped=true，实得 ${rc2.status} ${JSON.stringify(rc2.body)}`);
        }
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const badgeCountAfter = await siFlagsInRow(page, id12).count();
            await shotOnFail(page, badgeCountAfter === 0, 'badge-gone-after-online', `①c 末位确认翻牌已上线后，列表待先行部署徽章应消失（实得 ${badgeCountAfter} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ② 四身份按钮矩阵
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ② 四身份按钮矩阵 ──');
        const id2 = await mkBugToChulizhong(adminTok, devTok, 'matrix');
        createdIds.push(id2);
        await submitAndStage(id2, devTok);
        {
            const feRows = await dbAll('SELECT user_id FROM sys_fast_release_executors WHERE issue_id=? AND removed_at IS NULL', [id2]);
            must(feRows.length === 1 && Number(feRows[0].user_id) === duty.userId, `②-前置 挂牌应恰 1 行=当日值班人`);
        }
        // ②a admin（非在册）：见管理入口，不见本人确认按钮
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id2})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            const addBtnCount = await page.locator('#siDBody button:has-text("添加执行人")').count();
            await shotOnFail(page, addBtnCount === 1, '2a-admin-add-btn', `②a admin（非在册）应见「添加执行人」管理入口（实得 ${addBtnCount} 个）`);
            const myConfirmBtnCount = await page.locator('#siDBody button:has-text("执行先行上线")').count();
            await shotOnFail(page, myConfirmBtnCount === 0, '2a-admin-no-confirm-btn', `②a admin（非在册）不应见「执行先行上线」本人确认按钮（实得 ${myConfirmBtnCount} 个）`);
            await page.close();
        }
        // ②b 普通执行人（在册非 admin）：见本人确认按钮，不见管理入口
        {
            const page = await loginPage(browser, dutyTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id2})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            const myConfirmBtnCount2 = await page.locator('#siDBody button:has-text("执行先行上线")').count();
            await shotOnFail(page, myConfirmBtnCount2 === 1, '2b-exec-confirm-btn', `②b 普通执行人（在册非 admin）应见「执行先行上线」按钮（实得 ${myConfirmBtnCount2} 个）`);
            const addBtnCount2 = await page.locator('#siDBody button:has-text("添加执行人")').count();
            await shotOnFail(page, addBtnCount2 === 0, '2b-exec-no-add-btn', `②b 普通执行人不应见「添加执行人」管理入口（实得 ${addBtnCount2} 个）`);
            await page.close();
        }
        // [S8-S10 合并收口批 F7] ②c 无关用户：403（打不开详情，无法评估内部按钮，本身即结论）——
        //   正控制不是另开一条新断言，而是紧邻的 ②b 块（myConfirmBtnCount2===1/addBtnCount2===0）：同一份
        //   权限矩阵下，"在册非 admin 能看到执行按钮/看不到管理按钮"是正例，"无关用户连详情 403 都进不去"
        //   是负例的更强形式（负例的负例——不仅按钮不可见，连能观察按钮的前提「详情页」本身都被拒绝），
        //   两者互为同一矩阵的正反面，不需要额外造一条"无关用户 200 但按钮都不可见"的中间态断言。
        {
            const detailR = await fetchJson(`/api/sys-issues/${id2}`, outsiderTok);
            must(detailR.status === 403, `②c 无关用户详情接口应 403，实得 ${detailR.status} ${JSON.stringify(detailR.body)}`);
            const page = await loginPage(browser, outsiderTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            const rowCount = await page.locator(`tr[onclick="siOpenDrawer(${id2})"]`).count();
            await shotOnFail(page, rowCount === 0, '2c-outsider-row-hidden', `②c 无关用户列表不应看到该单（实得 ${rowCount} 行）`);
            await page.close();
        }
        // ②d admin 兼执行人（SQL 造态——正常流程结构性不可达，见文件头部注释；仅测前端渲染逻辑）
        {
            const id2d = await mkBugToChulizhong(adminTok, devTok, 'adminexec');
            createdIds.push(id2d);
            await submitAndStage(id2d, devTok);
            // 造态：把当前挂牌行（真实值班人）软删，直接插入 admin 自己作为唯一在册执行人——绕过
            // hasReleaseEligibility（该函数拒绝 admin 角色，见 index.js:13416），纯粹构造前端渲染场景。
            await dbRun(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = '管理员' WHERE issue_id = ? AND removed_at IS NULL`, [ADMIN_ID, id2d]);
            await dbRun(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, ?, '管理员', ?, '管理员')`, [id2d, ADMIN_ID, ADMIN_ID]);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id2d})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            const addBtnCountD = await page.locator('#siDBody button:has-text("添加执行人")').count();
            const confirmBtnCountD = await page.locator('#siDBody button:has-text("执行先行上线")').count();
            await shotOnFail(page, addBtnCountD === 1, '2d-adminexec-add-btn', `②d admin 兼执行人应同时见「添加执行人」管理入口（实得 ${addBtnCountD} 个）`);
            await shotOnFail(page, confirmBtnCountD === 1, '2d-adminexec-confirm-btn', `②d admin 兼执行人应同时见「执行先行上线」本人确认按钮（实得 ${confirmBtnCountD} 个）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ③ 三动作双面刷新 + 末位确认已上线态 + 补验收入口 + 48h 圈红起点
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ③ 三动作双面刷新 + 末位确认落地态 ──');
        const id3 = await mkBugToChulizhong(adminTok, devTok, 'actions');
        createdIds.push(id3);
        await submitAndStage(id3, devTok);
        {
            // admin 加人（通过 UI 弹窗）
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id3})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            await page.click('#siDBody button:has-text("添加执行人")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            await page.selectOption('#f_user_id', String(SECOND_EXEC_ID));
            await page.click('#siMConfirm');
            await page.waitForTimeout(600);
            const rosterNamesAfterAdd = await page.locator('#siDBody .si-att-name').allTextContents();
            await shotOnFail(page, rosterNamesAfterAdd.some(t => t.includes('示例开发B')), '3-add-drawer-refresh', `③ 加人后抽屉应刷新显示新执行人示例开发B（实得 ${JSON.stringify(rosterNamesAfterAdd)}）`);
            await page.close();
            // 列表侧刷新核对（独立开一次列表页，验证是同一份数据非本地缓存假象）
            const page2 = await loginPage(browser, adminTok);
            await page2.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page2.waitForLoadState('networkidle');
            await page2.waitForTimeout(500);
            const badgeAfterAdd = await siFlagsInRow(page2, id3).textContent().catch(() => '');
            await shotOnFail(page2, /待先行部署\s*0\/2/.test(badgeAfterAdd || ''), '3-add-list-refresh', `③ 加人后列表徽章应同步为"0/2"（实得="${badgeAfterAdd}"）`);
            await page2.close();
        }
        {
            // admin 移人（移除刚加的示例开发B）
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id3})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            const removeLink = page.locator('#siDBody .si-att-item', { hasText: '示例开发B' }).locator('.si-att-del');
            await removeLink.click();
            await page.waitForTimeout(600);
            const rosterNamesAfterRemove = await page.locator('#siDBody .si-att-name').allTextContents();
            await shotOnFail(page, !rosterNamesAfterRemove.some(t => t.includes('示例开发B')), '3-remove-drawer-refresh', `③ 移人后抽屉应刷新，示例开发B不再出现（实得 ${JSON.stringify(rosterNamesAfterRemove)}）`);
            await page.close();
            const page2 = await loginPage(browser, adminTok);
            await page2.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page2.waitForLoadState('networkidle');
            await page2.waitForTimeout(500);
            const badgeAfterRemove = await siFlagsInRow(page2, id3).textContent().catch(() => '');
            await shotOnFail(page2, /待先行部署\s*0\/1/.test(badgeAfterRemove || ''), '3-remove-list-refresh', `③ 移人后列表徽章应同步回"0/1"（实得="${badgeAfterRemove}"）`);
            await page2.close();
        }
        {
            // 值班人（唯一剩余在册者）确认 ⇒ 末位翻牌
            const beforeOverdueCheck = Date.now();
            const page = await loginPage(browser, dutyTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id3})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            await page.click('#siDBody button:has-text("执行先行上线")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            await page.click('#siMConfirm');
            await page.waitForTimeout(700);
            const statusBadgeText = await page.locator('#siDMeta .u-status-badge').first().textContent().catch(() => '');
            await shotOnFail(page, /已上线/.test(statusBadgeText || ''), '3-final-confirm-online', `③ 末位确认后详情状态徽章应显示"已上线"（实得="${statusBadgeText}"）`);
            // post_release_accept_overdue 不是物理列（isPostReleaseAcceptOverdue(row) 后端逐行计算的
            // 派生字段，见 index.js），本查询不选它——48h 时钟起点用 released_at 是否"刚刚"来验证即可。
            const row3 = await dbGet('SELECT status, released_at, online_source, post_release_acceptance FROM sys_issues WHERE id=?', [id3]);
            must(row3.status === '已上线', `③ 库内 status 应为已上线（实得=${row3.status}）`);
            must(!!row3.released_at, `③ released_at 应已写入（48h 时钟起点，实得=${row3.released_at}）`);
            const releasedAtMs = new Date((row3.released_at || '').replace(' ', 'T') + '+08:00').getTime();
            must(!Number.isNaN(releasedAtMs) && Math.abs(Date.now() - releasedAtMs) < 5 * 60 * 1000, `③ released_at 应是"刚刚"（5 分钟内），确认 48h 圈红时钟从此刻起算而非历史值（released_at=${row3.released_at}）`);
            // 补验收入口——应出现在操作栏
            // [S8-S10 合并收口批 F7] 本条负例（普通执行人不可见）已自带正控制——同一 issue 紧接着由 admin
            //   token 重开详情页（下方紧邻块 postAcceptBtnCountAdmin===1），两条断言互为一组正反对照，
            //   无需在本处另造新断言（最低风险处置：仅落字说明配对关系）。
            const postAcceptBtnCount = await page.locator('#siDActions button:has-text("补验收")').count();
            await shotOnFail(page, postAcceptBtnCount === 0, '3-post-accept-btn-not-dev-visible', `③ 补验收按钮为 admin 专属，普通执行人视角不应见（实得 ${postAcceptBtnCount} 个，佐证权限镜像正确）`);
            await page.close();
            void beforeOverdueCheck;
        }
        {
            // admin 视角核对补验收入口 + 48h 圈红未触发（刚翻牌，非 overdue）
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click(`tr[onclick="siOpenDrawer(${id3})"]`);
            await page.waitForSelector('#siDrawer.open', { timeout: 5000 });
            await page.waitForTimeout(400);
            const postAcceptBtnCountAdmin = await page.locator('#siDActions button:has-text("补验收")').count();
            await shotOnFail(page, postAcceptBtnCountAdmin === 1, '3-post-accept-btn-admin', `③ admin 视角应见「补验收」入口（实得 ${postAcceptBtnCountAdmin} 个）`);
            await page.close();
            const page2 = await loginPage(browser, adminTok);
            await page2.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page2.waitForLoadState('networkidle');
            await page2.waitForTimeout(500);
            const pendingFlagText = await page2.locator(`tr[onclick="siOpenDrawer(${id3})"] .si-flag`).filter({ hasText: '先行上线待补验收' }).first().textContent().catch(() => '');
            await shotOnFail(page2, pendingFlagText === '先行上线待补验收', '3-post-accept-list-flag-not-overdue', `③ 列表补验收徽章应是非超时文案（刚翻牌，48h 未到，实得="${pendingFlagText}"）`);
            await page2.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ④ 失败响应活体 + 六码 timeline DOM 逐码核对
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ④ 失败响应活体 + 六码 timeline DOM ──');
        // ④a NOT_STAGED：对已上线单（id3，已消费）直调加人函数（绕过 disabled/隐藏按钮，模拟陈旧 UI/竞态）
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);
            await page.evaluate((issueId) => { siFastlaneAddExecutorModal(issueId); }, id3);
            await page.waitForTimeout(500);
            // [S8-S10 合并收口批 F6] 弹窗真开是本组"提交阶段真实 409"的前提——此前 `if (modalOpen)` 静默跳过，
            //   弹窗没开时整段选人/点击/断言全部不执行，toast 断言可能读到上一次操作的残留内容而误判通过。
            //   改为 must 钉死真开（不开=响亮失败，非静默跳过），并抓取实际网络响应状态码，不再只信 toast 文案。
            const modalOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalOpen === 1, '4a-modal-open', `④a 弹窗应真实打开（实得 count=${modalOpen}）——不开视为本组失败，非跳过`);
            const responsesNotStaged = [];
            const onRespNotStaged = (resp) => { if (resp.url().includes('/fast-release-executors') && resp.request().method() === 'POST') responsesNotStaged.push(resp.status()); };
            page.on('response', onRespNotStaged);
            if (modalOpen === 1) {
                // executor-candidates 候选清单成功但目标单已非挂牌态，真正的 409 发生在提交阶段——先选人再确认。
                await page.selectOption('#f_user_id', String(SECOND_EXEC_ID)).catch(() => {});
                await page.click('#siMConfirm');
                await page.waitForTimeout(500);
            }
            page.off('response', onRespNotStaged);
            await shotOnFail(page, responsesNotStaged.includes(409), '4a-real-409', `④a 应观测到加人端点真实 409 响应（实得响应码=${JSON.stringify(responsesNotStaged)}）`);
            const toastNotStaged = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, /不处于先行上线挂牌态/.test(toastNotStaged || ''), '4a-not-staged-toast', `④a 已上线单加人应真实 409 NOT_STAGED，toast 含后端原文（实得="${toastNotStaged}"）`);
            await page.close();
        }
        // ④b FROZEN：构造"1 done+1 pending"混合态（done_count>0，仍挂牌中），直调加人函数
        const id4b = await mkBugToChulizhong(adminTok, devTok, 'frozen');
        createdIds.push(id4b);
        await submitAndStage(id4b, devTok);
        {
            const addR = await fetchJson(`/api/sys-issues/${id4b}/fast-release-executors`, adminTok, { method: 'POST', body: { user_id: SECOND_EXEC_ID } });
            must(addR.status === 200, `④b-前置 加第二人应 200，实得 ${addR.status}`);
            const rc = await fetchJson(`/api/sys-issues/${id4b}/fast-release-exec-confirm`, dutyTok, { method: 'POST', body: {} });
            must(rc.status === 200 && rc.body.flipped === false, `④b-前置 值班人确认应非末位 200，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id4b}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);
            // 冻结态下「添加执行人」按钮应已渲染为 disabled——先确认这一 UI 事实，再直调函数验证后端真闸。
            const addBtnDisabled = await page.locator('#siDBody button:has-text("添加执行人")').first().isDisabled().catch(() => null);
            must(addBtnDisabled === true, `④b UI 应已将「添加执行人」渲染为置灰（doneCount>0），实得 disabled=${addBtnDisabled}`);
            await page.evaluate((issueId) => { siFastlaneAddExecutorModal(issueId); }, id4b);
            await page.waitForTimeout(500);
            // [S8-S10 合并收口批 F6] 同④a：钉弹窗真开 + 抓真实网络响应码，不再静默跳过/只信 toast 文案。
            const modalOpen2 = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalOpen2 === 1, '4b-modal-open', `④b 弹窗应真实打开（实得 count=${modalOpen2}）——不开视为本组失败，非跳过`);
            const responsesFrozen = [];
            const onRespFrozen = (resp) => { if (resp.url().includes('/fast-release-executors') && resp.request().method() === 'POST') responsesFrozen.push(resp.status()); };
            page.on('response', onRespFrozen);
            if (modalOpen2 === 1) {
                const outsiderCandidate = OUTSIDER_ID;
                await page.selectOption('#f_user_id', String(outsiderCandidate)).catch(() => {});
                await page.click('#siMConfirm');
                await page.waitForTimeout(500);
            }
            page.off('response', onRespFrozen);
            await shotOnFail(page, responsesFrozen.includes(409), '4b-real-409', `④b 应观测到加人端点真实 409 响应（实得响应码=${JSON.stringify(responsesFrozen)}）`);
            const toastFrozen = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, /已冻结|已有执行人确认执行/.test(toastFrozen || ''), '4b-frozen-toast', `④b 已有 done 行时加人应真实 409 FROZEN，toast 含后端原文（实得="${toastFrozen}"）`);
            await page.close();
        }
        // ④c 六码逐码 timeline DOM 核对——用 id3（已走完 staged→roster_added→roster_removed→exec_confirm(非末位由值班人自己那次已是末位——用 id12 那条链路已有 exec_online；本单 id3 走的是"加人→移人→末位确认"，天然含 staged/roster_added/roster_removed/exec_online 四码）+ 额外造一单验证 exec_confirm(非末位)与 roster_cleared 两码。
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(700);
            // [S8-S10 合并收口批 F8] locator 从 #siDBody（整个详情区，含字段/按钮/其它区块）收窄到
            //   .si-timeline（siRenderTimeline 自身的渲染容器，见 Sys_Iteration.html:2896）——防止"六码
            //   文案恰好在详情页别处（如某个 note/理由文本）出现"造成的假阳性，让本组真正验证的是时间线区域。
            const tlText = await page.locator('.si-timeline').textContent().catch(() => '');
            await shotOnFail(page, /先行上线挂牌/.test(tlText || ''), '4c-tl-staged', '④c timeline 应含「先行上线挂牌」（fast_release_staged）');
            await shotOnFail(page, /先行上线加入执行人/.test(tlText || ''), '4c-tl-roster-added', '④c timeline 应含「先行上线加入执行人」（fast_release_roster_added）');
            await shotOnFail(page, /先行上线移除执行人/.test(tlText || ''), '4c-tl-roster-removed', '④c timeline 应含「先行上线移除执行人」（fast_release_roster_removed）');
            await shotOnFail(page, /先行上线翻牌上线/.test(tlText || ''), '4c-tl-exec-online', '④c timeline 应含「先行上线翻牌上线」（fast_release_exec_online）');
            await page.close();
        }
        {
            // exec_confirm（非末位）+ roster_cleared 两码：用 id12（多执行人链路中，示例发布者/示例开发A先确认那一步是非末位 exec_confirm）+ 新造一单走 void 触发 roster_cleared。
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id12}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(700);
            const tlText12 = await page.locator('.si-timeline').textContent().catch(() => '');
            await shotOnFail(page, /先行上线执行确认/.test(tlText12 || ''), '4c-tl-exec-confirm', '④c timeline 应含「先行上线执行确认」（fast_release_exec_confirm，非末位那次）');
            await page.close();

            const idVoid = await mkBugToChulizhong(adminTok, devTok, 'cleared');
            createdIds.push(idVoid);
            await submitAndStage(idVoid, devTok);
            const voidR = await fetchJson(`/api/sys-issues/${idVoid}/void`, adminTok, { method: 'POST', body: { reason: 'FLPW 六码核对：roster_cleared 触发' } });
            must(voidR.status === 200, `④c-前置 void 应 200，实得 ${voidR.status} ${JSON.stringify(voidR.body)}`);
            const pageV = await loginPage(browser, adminTok);
            await pageV.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idVoid}`);
            await pageV.waitForLoadState('networkidle');
            await pageV.waitForTimeout(700);
            const tlTextV = await pageV.locator('.si-timeline').textContent().catch(() => '');
            await shotOnFail(pageV, /先行上线执行人集合清空/.test(tlTextV || ''), '4c-tl-roster-cleared', '④c timeline 应含「先行上线执行人集合清空」（fast_release_roster_cleared，void 触发）');
            await pageV.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑤ 其余页面硬刷新烟测
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── ⑤ 其余页面硬刷新烟测（console 零错误 + 缓存串生效抽一页） ──');
        const OTHER_PAGES = ['Data_Collab.html', 'Data_Correction.html', 'Issue_Lite.html', 'Issue_Tracker.html',
            'Model_Center.html', 'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html', 'Statistics.html', 'Task_Pool.html'];
        for (const pg of OTHER_PAGES) {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/${pg}`, { waitUntil: 'networkidle' });
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(500);
            const unexpected = page._consoleErrors.filter(e => !/Failed to load resource.*40[049]/.test(e));
            await shotOnFail(page, unexpected.length === 0, `5-${pg}-console-clean`, `⑤ ${pg} 硬刷新后 console 零非预期报错（实得 ${unexpected.length} 个）${unexpected.length ? '：' + JSON.stringify(unexpected.slice(0, 3)) : ''}`);
            await page.close();
        }
        // 抽一页核对新缓存串生效——components.css 的 ?v= 应为最新登记值，且 sem-fastlane token 真实解析出颜色。
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Data_Collab.html`, { waitUntil: 'networkidle' });
            const cssHref = await page.evaluate(() => {
                const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.href.includes('components.css'));
                return link ? link.href : null;
            });
            must(!!cssHref && cssHref.includes('v1.153.0_fastlanetier15'), `⑤ Data_Collab.html 引用的 components.css 缓存串应为最新登记值 v1.153.0_fastlanetier15（实得="${cssHref}"）`);
            const bgColor = await page.evaluate(() => {
                const el = document.createElement('span');
                el.className = 'u-status-badge sem-fastlane';
                document.body.appendChild(el);
                const bg = getComputedStyle(el).backgroundColor;
                document.body.removeChild(el);
                return bg;
            });
            // #e0e7ff = rgb(224, 231, 255)
            must(bgColor === 'rgb(224, 231, 255)', `⑤ 第 15 层 sem-fastlane token 应真实解析出背景色 rgb(224, 231, 255)（实得="${bgColor}"）`);
            await page.close();
        }

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
        failDetails.push('顶层异常: ' + (e && e.message || e));
    } finally {
        // 【2026-08-14 NEW-6·核对发现 453dc10「已处理」的表述不准确】browser.close 独立 try/catch——此前
        // 直接 `await browser.close()` 未带自己的兜底：若它抛错，异常会从本 finally 块整体冒出，导致
        // 下方库清理（issue 五子表+主表 DELETE/残留核对/值班表回滚/db.close）全部被跳过，本地库残留本次
        // 测试插入的孤儿数据——同 test-sys-post-release-accept-fail-note-playwright.js 的同款问题（该
        // 文件本次一并同修）。改为 close 失败只计入 fail+failDetails，不阻断后续清理——库清理是"无论
        // 浏览器关得干不干净都必须做"的独立职责，不能被 close 失败连带吞掉。
        try {
            await browser.close();
        } catch (e) {
            fail++;
            failDetails.push('浏览器关闭失败: ' + (e && e.message || e));
            console.warn('浏览器关闭失败:', e && e.message || e);
        }
        // [R7] 清理异常汇总——此前逐条 catch(e) => console.warn 只是打印，不影响退出码；一次清理失败
        // 顶多留一条肉眼可见的日志，跑批/CI 场景很容易被淹没在大量正常输出里而被忽略，进程仍以 0 退出，
        // 造成"测试全绿但本地库已残留孤儿行"的假象。改为累计计数，非零即拉低最终 exit code。
        let cleanupErrorCount = 0;
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_fast_release_executors', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        for (const id of createdIds) {
            try {
                // [S8-S10 合并收口批 F2] 补 sys_issue_dev_commits——submitAndStage 走 mode:'commits' 写该表，
                //   此前清单漏配，会在本地库残留 pw- 前缀的孤儿 commit 行。按模式核对（非逐表列举）：本文件
                //   实际触达的写入面 = 建单/受理/指派/估时/授权/submit(commits) 六步，横向核对 index.js 全部
                //   `INSERT INTO sys_issue_*`（attachments/delete_audit/release_commit_snapshots 三张不在此列——
                //   本测试从不上传附件、不删单、不触发批次发布，结构性够不着，无需清理）。
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        // [R7] 逐表核对 createdIds 对应行数=0（不止查主表 sys_issues，五张子表各自独立核对）——主表清理
        //   成功不代表子表也真的清干净了（子表 DELETE 若单独抛错但被上面 try/catch 吞掉继续跑主表 DELETE，
        //   旧写法只报"issue 已清理"不会暴露子表孤儿行）。
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
            failDetails.push(`[R7] 夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        // [S8-S10 合并收口批 F10 收口] 当日值班表——①a 已在自己的 finally 内 restore（软删+恢复，不留痕迹）；
        // ①b 起若为测试插入（duty.preExisting===false），精确回滚**仅本次插入的那一行**（按
        // insertedRowId 定点删除，不做"当日日期+按 removed_at IS NULL 全表扫"这类可能误删其他行的宽粒度
        // 操作）。⚠️ 原注释曾主张"留痕不删——真实新增的值班行是合法事实，删除会抹掉真实记录"，如实改正：
        // 那条论证不成立——这行数据是**测试运行的副作用**（为了让 submitAndStage 走到"当日有值班人"分支
        // 而人工插入），不是任何真人操作产生的排班决策，留着才是在本地库里制造一条以假乱真的"今天谁值班"
        // 记录，该由测试自己收拾干净。preExisting===true（复用真实已有值班人）时不动它——那才是真实数据。
        if (duty && duty.preExisting === false && duty.insertedRowId) {
            try {
                await dbRun('DELETE FROM sys_release_duty_roster WHERE id=?', [duty.insertedRowId]);
                const dutyRemain = await dbGet('SELECT COUNT(*) c FROM sys_release_duty_roster WHERE id=?', [duty.insertedRowId]);
                if (dutyRemain && dutyRemain.c > 0) {
                    fail++;
                    failDetails.push(`[R7] 值班表测试插入行 #${duty.insertedRowId} 清理后仍残留（应为 0，实得 ${dutyRemain.c}）`);
                }
            } catch (e) {
                fail++;
                failDetails.push(`[R7] 夹具清理失败 duty roster #${duty.insertedRowId}: ${e.message}`);
                console.warn(`夹具清理失败 duty roster #${duty.insertedRowId}: ${e.message}`);
            }
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) { console.log('失败清单：'); failDetails.forEach(m => console.log('  - ' + m)); process.exit(1); }
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
