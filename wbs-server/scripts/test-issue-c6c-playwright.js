/**
 * v1.74.0 C6c — 列表12列/筛选栏/详情区块/通知按钮/M-3权限 Playwright UI 实测
 *
 * 用法：node scripts/test-issue-c6c-playwright.js
 * 分场景验收（codex G）：列表/筛选 + 详情区块 + 附件异步 + 通知动作 + viewer 只读。
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：经 API 建 3 条需求单（C6c完整需求 / C6c已关闭需求 / C6cXSS测试），收尾按状态码清理（200 / 404 算清掉，每个编号单独 try，共 2 轮），遗留计失败。
 *   OA 单号原为固定的 OA-C6C-1，共享实例上会与残留 / 并行运行撞号，改为 `OA-C6C-<时间戳>`（OA_NO，每次运行唯一；建单、详情断言都用新值），
 *   崩溃遗留的单由 cleanupCreated 按 OA_NO 兜底查出来一并清（同 c6b 做法）。
 *   收口批：三个夹具标题都带运行标记 RUN_TAG（[c6c-<pid>-<时间戳>]），清理再按标记补查（建单后客户端没拿到编号也能清到）；建单助手校验 HTTP 200 与正整数编号，不满足即抛错退 1。
 *
 * 验证：
 *   列表/筛选
 *     C1 列表 12 列表头 + notify 列徽章渲染
 *     C2 部门筛选下拉含"系统自动" + 数据域筛选下拉存在
 *     C3 列表行渲染无 undefined + 类型色块/通知徽章正常
 *   详情区块
 *     C4 详情页：业务方部门/姓名 + OA 行（有值）+ 原始诉求区
 *     C5 详情页：状态时间线（from→to + 操作人）
 *     C6 详情页：附件区异步加载（暂无附件 → "暂无附件"）
 *   通知动作
 *     C7 通知开发按钮：assigned_to 非空 + 处理中 → 按钮出现
 *     C8 通知业务方完成按钮：已关闭 → 按钮出现
 *   M-3 viewer 权限
 *     C9 viewer 详情页：无操作栏（状态/指派/通知/编辑/删除）+ 评论输入区隐藏（"只读账号不可评论"）
 *   C10 控制台无 JS 报错
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
let OA_NO = null;      // [#106 S4d-2] ready() 之后赋值：OA-C6C-<时间戳>，每次运行唯一（原固定值 OA-C6C-1）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[c6c-<pid>-<时间戳>]，每个夹具标题都带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN_ID = 1, VIEWER_ID = 2, DEV1_ID = 19;

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(uid) {
    return testEnv.signToken(uid);
}
// [#106 S4d-2] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}
// close 等回调落定，关库错误不丢（语句错误优先）
async function dbRun(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.run(sql, p, function (e) { const ctx = { changes: this && this.changes }; db.close((ce) => { const err = e || ce; err ? rej(err) : res(ctx); }); }); });
}
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
async function apiStatus(token, id, status, reason) { const b = { status }; if (reason) b.last_transition_reason = reason; await fetch(`${BASE_URL}/api/issues/${id}/status`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
async function apiAssign(token, id, devId) { await fetch(`${BASE_URL}/api/issues/${id}/assign`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: devId }) }); }

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    page._errs = errs;
    return page;
}
const isVisible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);

const created = [];

/**
 * [#106 S4d-2] 清理造的需求单：先按 OA_NO 兜底查出「已建成功但脚本在登记 id 之前就失败」的单；再每个编号单独 try / catch，一个失败不中断后续；
 * 看状态码（200 / 404 算清掉），只把清理成功的编号移出追踪；失败的编号再试一轮（共 2 轮，间隔 200ms）；遗留逐个计失败。
 * 原来 `for (...) await apiDelete(...)` 不看状态码，一个抛错还会中断后面的清理
 */
async function cleanupCreated(adminToken) {
    try {
        const left = await dbAll('SELECT id FROM issues WHERE oa_number=?', [OA_NO]);
        for (const r of left) if (!created.includes(r.id)) created.push(r.id);
    } catch (e) { must(false, `清理前按 OA 单号兜底查询失败：${e && e.message}`); }
    try {   // [#106 S4d-2 收口批] 再按运行标记补查：建单请求服务端已落库、客户端读响应 / 解析失败而没登记编号的单
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
    OA_NO = 'OA-C6C-' + Date.now();
    RUN_TAG = `[c6c-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    const viewerToken = await signAs(VIEWER_ID);
    console.log('\n══════ v1.74.0 C6c 列表/详情/通知/权限 Playwright 实测 ══════');

    const browser = await chromium.launch();
    let allErrs = [];
    try {
        // 造数据：一条完整需求（含 OA/原始诉求/指派 dev1/处理中）+ 一条已关闭
        // （[#106 S4d-2] 挪进 try：中途某次建单抛错时，已建的单也由 finally 清理）
        const idFull = await apiCreate(adminToken, { title: 'C6c完整需求' + RUN_TAG, type: '看板/报表需求', requester_dept: '市场营销部', requester_name: '王业务', requester_phone: '13800000000', oa_number: OA_NO, raw_requirement: '业务方原话：要销售看板', description: '梳理后', data_domain: '合同' });
        created.push(idFull);
        await apiAssign(adminToken, idFull, DEV1_ID);
        await apiStatus(adminToken, idFull, '处理中');
        const idClosed = await apiCreate(adminToken, { title: 'C6c已关闭需求' + RUN_TAG, type: '数据质量', requester_dept: '财务管理部', requester_name: '李业务', description: 'x' });
        created.push(idClosed);
        await apiStatus(adminToken, idClosed, '处理中');
        await apiStatus(adminToken, idClosed, '待验证');
        await apiStatus(adminToken, idClosed, '已关闭', '已交付验收');

        // ===== 列表/筛选 + 详情 + 通知（admin 视角）=====
        const ap = await gotoAs(browser, adminToken);

        // C1 列表 12 列表头
        const headers = await ap.$$eval('thead th', ths => ths.map(t => t.textContent.trim()));
        must(headers.length === 12, `C1 列表 12 列表头（实际 ${headers.length}）`);
        must(headers.includes('通知') && headers.includes('业务方部门') && headers.includes('数据域') && headers.includes('OA 单号'), 'C1 含通知/业务方部门/数据域/OA 列');

        // C2 筛选下拉
        const deptOpts = await ap.$$eval('#filterDept option', os => os.map(o => o.value));
        must(deptOpts.includes('系统自动'), 'C2 部门筛选含"系统自动"');
        must(await isVisible(ap, '#filterDomain'), 'C2 数据域筛选下拉存在');

        // C3 列表行渲染
        const rowOk = await ap.evaluate(({ tag }) => {
            const rows = [...document.querySelectorAll('#issueTableBody tr')];
            const row = rows.find(r => r.textContent.includes('C6c完整需求' + tag));   // [#106 S4d-2] 带本轮运行标记定位，共享实例上有别轮同名单时不会取错行
            if (!row) return { found: false };
            return { found: true, hasUndefined: row.textContent.includes('undefined'), hasNotify: !!row.querySelector('.notify-badge'), hasType: !!row.querySelector('.type-tag'), tdCount: row.querySelectorAll('td').length };
        }, { tag: RUN_TAG });
        must(rowOk.found && rowOk.tdCount === 12, `C3 列表行 12 td（实际 ${rowOk.tdCount}）`);
        must(rowOk.hasNotify && rowOk.hasType && !rowOk.hasUndefined, 'C3 行渲染通知徽章/类型色块正常无 undefined');

        // C4-C8 详情（idFull 处理中+指派）
        await ap.evaluate(id => openDrawer(id), idFull);
        await ap.waitForTimeout(800); // 等附件异步
        const drawerText = await ap.evaluate(() => document.getElementById('drawerBody').innerText);
        must(drawerText.includes('王业务') && drawerText.includes('市场营销部'), 'C4 详情：业务方姓名/部门');
        must(drawerText.includes(OA_NO) && drawerText.includes('要销售看板'), 'C4 详情：OA 行 + 原始诉求区');
        must(drawerText.includes('状态时间线') && drawerText.includes('→ 处理中'), 'C5 详情：状态时间线 from→to');
        must(drawerText.includes('暂无附件') || drawerText.includes('录入附件'), 'C6 详情：附件区异步加载（暂无附件）');
        must(drawerText.includes('通知开发'), 'C7 通知开发按钮（assigned_to 非空+处理中）出现');

        // C8 已关闭单 → 通知业务方完成按钮
        await ap.evaluate(id => openDrawer(id), idClosed);
        await ap.waitForTimeout(600);
        const closedText = await ap.evaluate(() => document.getElementById('drawerBody').innerText);
        must(closedText.includes('通知业务方完成'), 'C8 通知业务方完成按钮（已关闭）出现');
        allErrs = allErrs.concat(ap._errs);
        await ap.close();

        // ===== M-3 viewer 权限 =====
        const vp = await gotoAs(browser, viewerToken);
        await vp.evaluate(id => openDrawer(id), idFull);
        await vp.waitForTimeout(700);
        const vText = await vp.evaluate(() => document.getElementById('drawerBody').innerText);
        const vHasActionBar = await vp.evaluate(() => !!document.querySelector('#drawerBody .action-bar'));
        must(!vHasActionBar, 'C9 viewer 详情无操作栏（状态/指派/通知/编辑/删除）');
        must(!vText.includes('通知开发') && !vText.includes('转为'), 'C9 viewer 无通知/状态按钮');
        must(vText.includes('只读账号不可评论') && !(await isVisible(vp, '#commentInput')), 'C9 viewer 评论输入区隐藏 + 只读提示');
        // viewer 仍能看详情读区块（读透明）
        must(vText.includes('市场营销部') && vText.includes('状态时间线'), 'C9 viewer 仍可读详情/时间线（读透明）');
        allErrs = allErrs.concat(vp._errs);
        await vp.close();

        must(allErrs.length === 0, `C10 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);

        // ===== C11 H-1 XSS 转义验证（DB 直插恶意字段绕后端校验，验前端 escapeHtml 防御）=====
        const xssId = await apiCreate(adminToken, { title: 'C6cXSS测试' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: 'x', description: 'y' });
        created.push(xssId);
        // DB 直接注入含 <img onerror> 的 requester_name（绕过后端录入校验，模拟脏数据/历史数据）
        await dbRun("UPDATE issues SET requester_name = ? WHERE id = ?", ['<img src=x onerror=window.__xss__=1>', xssId]);
        const xp = await gotoAs(browser, adminToken);
        await xp.evaluate(id => openDrawer(id), xssId);
        await xp.waitForTimeout(600);
        const xssVal = await xp.evaluate(() => window.__xss__ || false);
        const escaped = await xp.evaluate(() => document.getElementById('drawerBody').innerHTML.includes('&lt;img'));
        must(!xssVal && escaped, `C11 H-1：恶意 requester_name 被 escapeHtml 转义未执行（xss=${xssVal} escaped=${escaped}）`);
        allErrs = allErrs.concat(xp._errs);
        await xp.close();
    } finally {
        try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
        await cleanupCreated(adminToken);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6c 列表/详情/通知/权限实测全部通过\n' : '  🚫 存在失败项\n');
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
    console.error('实测脚本异常:', e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
