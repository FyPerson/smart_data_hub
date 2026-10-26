/**
 * v1.74.0 C6a — 前端清理（改名/删死引用/枚举对齐）Playwright UI 实测
 *
 * 用法：node scripts/test-issue-c6a-playwright.js
 * 复用 JWT 注入范式（goto login.html → localStorage token → goto 业务页）。
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：经 API 建 2 条需求单（标题 C6a看板需求 / C6a平台bug），收尾按状态码清理（200 / 404 算清掉，每个编号单独 try，共 2 轮），遗留计失败。
 *   收口批：两个夹具标题都带运行标记 RUN_TAG（[c6a-<pid>-<时间戳>]），清理先按标记补查（本脚本为此新增一个只读写已存在实例库的 openInstanceDb）；建单助手校验 HTTP 200 与正整数编号，不满足即抛错退 1。
 *
 * 验证：
 *   P1 页面加载无 JS 报错（控制台 error 数=0）
 *   P2 改名生效：title/导航/新建按钮含"需求"不含"问题"
 *   P3 新建弹窗类型下拉 = 7 类（含"看板/报表需求""平台 bug"，无旧"缺陷""变更请求"）
 *   P4 来源下拉 = 4 类（含 FDL自动）
 *   P5 列表表头无"进度"列（删死引用）
 *   P6 造一条需求 → 列表渲染：类型色块 + 状态徽章正常（无 undefined）
 *   P7 详情抽屉打开无报错 + 无"开发进度"滑块
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2 收口批] ready() 之后赋值：testEnv.env().dbPath（实例库，只用于清理时按运行标记补查）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[c6a-<pid>-<时间戳>]，每个夹具标题都带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN_ID = 1;

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(userId) {
    return testEnv.signToken(userId);
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
async function apiDelete(token, id) {
    const r = await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    return r.status;
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } }

const created = [];
/**
 * [#106 S4d-2] 清理造的需求单：每个编号单独 try / catch，一个失败不中断后续；看状态码（200 / 404 算清掉），只把清理成功的编号移出追踪；
 * 失败的编号再试一轮（共 2 轮，间隔 200ms）；遗留逐个计失败。原来两条 `await apiDelete(...)` 顺序执行、不看状态码，第一条抛错会跳过第二条
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
    RUN_TAG = `[c6a-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    console.log('\n══════ v1.74.0 C6a 前端清理 Playwright 实测 ══════');

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        // 造 2 条不同类型/状态的需求验证渲染（[#106 S4d-2] 挪进 try：建第二条失败时第一条也由 finally 清理）
        const id1 = await apiCreate(adminToken, { title: 'C6a看板需求' + RUN_TAG, type: '看板/报表需求', requester_dept: '市场营销部', requester_name: '张三', description: 'x' });
        created.push(id1);
        const id2 = await apiCreate(adminToken, { title: 'C6a平台bug' + RUN_TAG, type: '平台 bug', requester_dept: '信息技术部', requester_name: '李四', description: 'y' });
        created.push(id2);

        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((t) => { localStorage.setItem('token', t); }, adminToken);
        await page.goto(`${BASE_URL}/Issue_Tracker.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800); // 等列表渲染

        // P2 改名
        const title = await page.title();
        must(title.includes('需求') && !title.includes('问题'), `P2 title 改名生效（${title}）`);
        const bodyText = await page.evaluate(() => document.body.innerText);
        must(!bodyText.includes('问题'), 'P2 页面可见文本无"问题"残留');

        // P5 表头无"进度"
        const headers = await page.$$eval('thead th', ths => ths.map(t => t.textContent.trim()));
        must(!headers.includes('进度'), `P5 列表表头无"进度"列（${headers.join('/')}）`);

        // 打开新建弹窗
        await page.click('button:has-text("新建需求")');
        await page.waitForTimeout(300);

        // P3 类型 7 类
        const typeOpts = await page.$$eval('#formType option', os => os.map(o => o.value));
        must(typeOpts.length === 7, `P3 类型下拉 7 类（实际 ${typeOpts.length}）`);
        must(typeOpts.includes('看板/报表需求') && typeOpts.includes('平台 bug'), 'P3 含新类型"看板/报表需求"+"平台 bug"');
        must(!typeOpts.includes('缺陷') && !typeOpts.includes('变更请求'), 'P3 无旧类型"缺陷"/"变更请求"');

        // P4 来源 4 类
        const srcOpts = await page.$$eval('#formSource option', os => os.map(o => o.value));
        must(srcOpts.length === 4 && srcOpts.includes('FDL自动'), `P4 来源下拉 4 类含 FDL自动（${srcOpts.join('/')}）`);

        // 关弹窗
        await page.click('.modal-overlay#createModal .drawer-close');
        await page.waitForTimeout(200);

        // P6 列表渲染：类型色块 + 状态徽章（找造的 id1 行）
        const rowOk = await page.evaluate(({ tag }) => {
            const rows = [...document.querySelectorAll('#needTableBody tr, #issueTableBody tr, tbody tr')];
            const row = rows.find(r => r.textContent.includes('C6a看板需求' + tag));   // [#106 S4d-2] 带本轮运行标记定位，共享实例上有别轮同名单时不会取错行
            if (!row) return { found: false };
            const typeTag = row.querySelector('.type-tag');
            const statusBadge = row.querySelector('.status-badge');
            return {
                found: true,
                typeClass: typeTag ? typeTag.className : '',
                typeText: typeTag ? typeTag.textContent : '',
                statusText: statusBadge ? statusBadge.textContent : '',
                hasUndefined: row.textContent.includes('undefined')
            };
        }, { tag: RUN_TAG });
        must(rowOk.found, 'P6 列表能找到造的需求行');
        must(rowOk.typeClass.includes('t-看板-报表需求'), `P6 类型色块类名规范化正确（${rowOk.typeClass}）`);
        must(rowOk.statusText === '待处理', `P6 状态徽章正常（${rowOk.statusText}）`);
        must(!rowOk.hasUndefined, 'P6 行内无 undefined（删 progress 后无残留）');

        // P7 详情抽屉
        await page.evaluate((tid) => { if (typeof openDrawer === 'function') openDrawer(tid); }, id1);
        await page.waitForTimeout(500);
        const drawerText = await page.evaluate(() => {
            const d = document.getElementById('drawerBody');
            return d ? d.innerText : '';
        });
        must(drawerText.length > 0 && !drawerText.includes('开发进度'), 'P7 详情抽屉打开正常 + 无"开发进度"滑块');

        // P1 控制台无 error（最后查，覆盖全程）
        must(consoleErrors.length === 0, `P1 控制台无 JS 报错（${consoleErrors.length} 个${consoleErrors.length ? ': ' + consoleErrors.slice(0,2).join(' | ') : ''}）`);

    } finally {
        try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
        await cleanupCreated(adminToken);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6a 前端清理实测全部通过\n' : '  🚫 存在失败项\n');
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
    console.error('实测脚本异常:', e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
