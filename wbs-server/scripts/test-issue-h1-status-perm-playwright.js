/**
 * v1.74.0 C8 合并审 H-1 修复实测 — 状态按钮权限对齐后端状态机
 *
 * 用法：node scripts/test-issue-h1-status-perm-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：经 API 建的需求单（标题 H1被指派需求 / H1他人需求），收尾按状态码清理（200 / 404 算清掉，每个编号单独 try，共 2 轮），遗留计失败。
 *   收口批：两个夹具标题都带运行标记 RUN_TAG（[h1-<pid>-<时间戳>]），清理先按标记补查（本脚本为此新增一个只读写已存在实例库的 openInstanceDb）；建单助手校验 HTTP 200 与正整数编号，不满足即抛错退 1。
 *   固定用户 id：1 admin / 19 / 8（快照库里须存在，首跑核对）。
 *
 * 验证 H-1 修复（前端状态按钮从 if(isManager) 解耦，按 isAdmin||(isAssignee&&目标∈{处理中,待验证}) 过滤）：
 *   H1-1 被指派 user 打开详情 → 能看到「转为待验证」推进按钮（修复前零入口）
 *   H1-2 被指派 user 看不到终态按钮（已暂缓等仅 admin）
 *   H1-3 非指派 user 打开详情 → 看不到任何状态按钮（后端 NOT_ASSIGNEE）
 *   H1-4 admin 打开详情 → 看到全部合法转换按钮（不变）
 *   H1-5 控制台无 JS 报错
 *
 * 临时实测脚本（H-1 验收用），实测通过后可删。
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2 收口批] ready() 之后赋值：testEnv.env().dbPath（实例库，只用于清理时按运行标记补查）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[h1-<pid>-<时间戳>]，每个夹具标题都带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN_ID = 1, DEV1_ID = 19, DEV2_ID = 8;

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(uid) {
    return testEnv.signToken(uid);
}
// [#106 S4d-2 收口批] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}
// close 等回调落定，关库错误不丢（语句错误优先）
async function dbAll(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.all(sql, p, (e, r) => { db.close((ce) => { const err = e || ce; err ? rej(err) : res(r); }); }); });
}
// [#106 S4d-2 收口批] 建单助手校验状态码与正整数编号，不满足即抛错（原来 undefined 编号被清理过滤器静默忽略）；服务端已落库而这里没拿到编号的，由 cleanupCreated 按 RUN_TAG 补查
async function apiCreate(token, body) {
    const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    const id = j && j.id;
    if (r.status !== 200 || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败：HTTP ${r.status}，编号=${JSON.stringify(id)}，响应=${JSON.stringify(j).slice(0, 160)}`);
    return id;
}
// [#106 S4d-2] 返回状态码（原来丢弃，删除失败看不见）
async function apiDelete(token, id) { const r = await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); return r.status; }
async function apiAssign(token, id, devId) { await fetch(`${BASE_URL}/api/issues/${id}/assign`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: devId }) }); }
async function apiStatus(token, id, status) { await fetch(`${BASE_URL}/api/issues/${id}/status`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); }

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    page._errs = errs;
    return page;
}
// 读详情抽屉里的状态按钮文案列表
async function statusButtons(page, id) {
    await page.evaluate(i => openDrawer(i), id);
    await page.waitForTimeout(500);
    return page.evaluate(() => {
        const bar = document.querySelector('#drawerBody .action-bar');
        if (!bar) return [];
        return [...bar.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t.startsWith('转为') || t === '打回处理');
    });
}

const created = [];

/**
 * [#106 S4d-2] 清理造的需求单：每个编号单独 try / catch，一个失败不中断后续；看状态码（200 / 404 算清掉），只把清理成功的编号移出追踪；
 * 失败的编号再试一轮（共 2 轮，间隔 200ms）；遗留逐个计失败。原来 `for (...) await apiDelete(...)` 不看状态码，一个抛错还会中断后面的清理
 */
async function cleanupCreated(adminToken) {
    try {   // [#106 S4d-2 收口批] 先按运行标记补查：建单请求服务端已落库、客户端读响应 / 解析失败而没登记编号的单
        const tagged = RUN_TAG ? await dbAll(`SELECT id FROM issues WHERE title LIKE '%' || ? || '%'`, [RUN_TAG]) : [];
        for (const r of tagged) if (!created.includes(r.id)) created.push(r.id);
    } catch (e) { must(false, `清理前按运行标记补查失败：${e && e.message}`); }
    const lastErr = new Map();
    for (let round = 0; round < 2; round++) {
        const pending = created.filter((id) => Number.isInteger(id));
        if (pending.length === 0) break;
        if (round > 0) await new Promise((r) => setTimeout(r, 200));
        for (const id of pending) {
            try {
                const st = await apiDelete(adminToken, id);
                if (st === 200 || st === 404) { created.splice(created.indexOf(id), 1); lastErr.delete(id); }
                else lastErr.set(id, `HTTP ${st}`);
            } catch (e) { lastErr.set(id, (e && e.message) || String(e)); }
        }
    }
    for (const id of created.filter((x) => Number.isInteger(x))) must(false, `清理测试需求单 #${id} 失败（已重试 1 轮）：${lastErr.get(id)}`);
}

async function main() {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    RUN_TAG = `[h1-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    const dev1Token = await signAs(DEV1_ID);
    console.log('\n══════ H-1 修复实测：状态按钮权限对齐后端 ══════');

    let browser = null;
    let allErrs = [];
    try {
        // 造一条指派给 dev1 + 处理中的需求（dev1 是被指派人，可推进到待验证）
        // [#106 S4d-2 修复批] 造数与 chromium.launch 挪进 try（写法同 c6a）：建单后立即登记编号，中途抛错 finally 里 cleanupCreated 也能清到
        const idAssigned = await apiCreate(adminToken, { title: 'H1被指派需求' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
        created.push(idAssigned);
        await apiAssign(adminToken, idAssigned, DEV1_ID);
        await apiStatus(adminToken, idAssigned, '处理中');  // 现在 dev1 应能「转为待验证」

        browser = await chromium.launch();
        // H1-1/H1-2 被指派 user(dev1)
        const dp = await gotoAs(browser, dev1Token);
        const devBtns = await statusButtons(dp, idAssigned);
        must(devBtns.includes('转为待验证'), `H1-1 被指派 user 能看到「转为待验证」推进按钮（实际 [${devBtns.join(', ')}]）`);
        must(!devBtns.some(b => /已暂缓|已拒绝|已关闭|待处理/.test(b)), `H1-2 被指派 user 看不到终态/激活按钮（实际 [${devBtns.join(', ')}]）`);
        allErrs = allErrs.concat(dp._errs);
        await dp.close();

        // H1-3 非指派 user：造另一条指派给 dev2 的单，dev1 看
        const idOther = await apiCreate(adminToken, { title: 'H1他人需求' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '李', description: 'x' });
        created.push(idOther);
        await apiAssign(adminToken, idOther, DEV2_ID);
        await apiStatus(adminToken, idOther, '处理中');
        const dp2 = await gotoAs(browser, dev1Token);
        const otherBtns = await statusButtons(dp2, idOther);
        must(otherBtns.length === 0, `H1-3 非指派 user 看不到任何状态按钮（实际 [${otherBtns.join(', ')}]）`);
        allErrs = allErrs.concat(dp2._errs);
        await dp2.close();

        // H1-4 admin 看 idAssigned（处理中）→ 应看到全部合法转换（待验证 + 已暂缓）
        const ap = await gotoAs(browser, adminToken);
        const adminBtns = await statusButtons(ap, idAssigned);
        must(adminBtns.includes('转为待验证') && adminBtns.includes('转为已暂缓'),
            `H1-4 admin 看到全部合法转换（处理中→待验证/已暂缓，实际 [${adminBtns.join(', ')}]）`);
        allErrs = allErrs.concat(ap._errs);
        await ap.close();

        must(allErrs.length === 0, `H1-5 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
    } finally {
        if (browser) { try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); } }
        await cleanupCreated(adminToken);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 H-1 修复实测全部通过\n' : '  🚫 存在失败项\n');
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
    console.error('H-1 实测异常:', e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
