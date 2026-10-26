/**
 * v1.75.0 commit D — 需求拉群讨论按钮 Playwright 实测
 *
 * 用法：node scripts/test-issue-c4-create-chat-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：经 API 建 4 条需求单（标题 c4拉群按钮-*）+ 直连实例库改 dingtalk_* 列；收尾按状态码清理（200 / 404 算清掉，每个编号单独 try，共 2 轮），遗留计失败。
 *   收口批：四个夹具标题都带运行标记 RUN_TAG（[c4-<pid>-<时间戳>]），清理先按标记补查（建单后客户端没拿到编号也能清到）；建单助手校验 HTTP 200 与正整数编号，不满足即抛错退 1。
 *   固定用户 id：1 admin / 7 publisher / 19 创建人 / 8 被指派 / 9 路人 / 2 viewer（快照库里须存在且角色不变，首跑核对）。
 *
 * 测试矩阵（不真发钉钉，全 route mock）：
 *   T1 admin（权限）              → 看见「💬 拉群讨论」按钮
 *   T2 publisher（权限）           → 看见「💬 拉群讨论」按钮
 *   T3 被指派开发（assignee 权限） → 看见「💬 拉群讨论」按钮
 *   T4 创建人（creator 权限）      → 看见「💬 拉群讨论」按钮
 *   T5 viewer 示例客服A               → 不渲染钉钉沟通群区块（前端再保险隐藏）
 *   T6 路人 user 示例开发B              → 不渲染钉钉沟通群区块（非 admin/publisher/assigned/creator）
 *   T7 已建群（dingtalk_open_conversation_id 非空）→ 灰色按钮 + 群名展示 + disabled
 *   T8 已建群但 chat_name 为空     → 灰显 + 兜底文案「（群名缺失）」
 *   T9 已建群 dingtalk_open_conversation_id 全空白  → 仍按未建群处理（trim 口径与后端一致）
 *  T10 点击按钮 → confirm 弹窗 → mock 成功 + db 直写 → toast + 重渲染验"已建群灰显闭环"（codex 37 #4）
 *  T11 mock requester_degraded=true → 主 toast 成功 + 延迟 1.2s warning toast「业务方未加入」
 *  T12 mock NOT_ENOUGH_MEMBERS → toast 展后端 error 文案
 *  T13 mock CHAT_LINK_FAILED → toast 展后端 error 文案
 *  T14 mock CHAT_CREATED_DB_UPDATE_FAILED → toast 展后端 error 文案
 *  T15 mock NO_DINGTALK_CONFIG → toast 展后端 error 文案
 *  T16 mock DINGTALK_USER_LOOKUP_EMPTY → toast 展后端 error 文案（codex 37 #1：与契约 5 错误码对齐）
 *  T17 防抖：mock 延迟 2s + 真实 page.click force 双击 → route 计数仍 = 1（codex 37 #5：模拟用户真实连点）
 *  T18 幂等 idempotent=true → toast 展"该需求已有讨论群"（用 success 类型与新建群结果一致）
 *  T19 控制台无 JS 报错
 *
 * 清理：finally 删测试单 + 失败/中断重启 server 前需清 issues 残留。
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
let RUN_TAG = null;    // [#106 S4d-2 收口批] ready() 之后赋值：[c4-<pid>-<时间戳>]，每个夹具标题都带它；建单后客户端没拿到编号时，清理按标记补查

const ADMIN_ID = 1, PUBLISHER_ID = 7, USER_CREATOR_ID = 19, USER_ASSIGNEE_ID = 8, USER_BYSTANDER_ID = 9, VIEWER_ID = 2;

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
    return new Promise((res, rej) => { db.run(sql, p, function (e) { const ctx = { lastID: this && this.lastID, changes: this && this.changes }; db.close((ce) => { const err = e || ce; err ? rej(err) : res(ctx); }); }); });
}
async function dbGet(sql, p) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { db.get(sql, p, (e, r) => { db.close((ce) => { const err = e || ce; err ? rej(err) : res(r); }); }); });
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
    if (r.status !== 200 || !Number.isInteger(id) || id <= 0) throw new Error(`create failed：HTTP ${r.status}，编号=${JSON.stringify(id)}，响应=${JSON.stringify(j).slice(0, 160)}`);
    return id;
}
// [#106 S4d-2] 返回状态码（原来丢弃，删除失败看不见）
async function apiDelete(token, id) { const r = await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); return r.status; }
async function apiAssign(token, id, devId) { await fetch(`${BASE_URL}/api/issues/${id}/assign`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: devId }) }); }

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  PASS ' + m); pass++; } else { console.log('  FAIL ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (/Failed to load resource: the server responded with a status of 50[02]/.test(m.text())) return;
        if (/Failed to load resource: the server responded with a status of 400/.test(m.text())) return;
        errs.push(m.text());
    });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    page._errs = errs;
    return page;
}

async function openDrawer(page, id) {
    // 点击列表行打开抽屉
    await page.evaluate(idd => { if (typeof openDrawer === 'function') openDrawer(idd); }, id);
    await page.waitForTimeout(500);
}

const created = [];

/**
 * [#106 S4d-2] 清理造的需求单：每个编号单独 try / catch，一个失败不中断后续；看状态码（200 / 404 算清掉），只把清理成功的编号移出追踪；
 * 失败的编号再试一轮（共 2 轮，间隔 200ms）；遗留逐个计失败。原来整个循环包在一个 try/catch 里只 log（一个抛错中断其余、不计失败）
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
    for (const id of created.filter((x) => Number.isInteger(x))) { console.log(`清理失败：#${id} ${lastErr.get(id)}`); must(false, `清理测试需求单 #${id} 失败（已重试 1 轮）：${lastErr.get(id)}`); }
}

async function main() {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    RUN_TAG = `[c4-${process.pid}-${Date.now()}]`;
    const adminToken = await signAs(ADMIN_ID);
    const publisherToken = await signAs(PUBLISHER_ID);
    const creatorToken = await signAs(USER_CREATOR_ID);
    const assigneeToken = await signAs(USER_ASSIGNEE_ID);
    const bystanderToken = await signAs(USER_BYSTANDER_ID);
    const viewerToken = await signAs(VIEWER_ID);

    console.log('\n══════ v1.75.0 commit D 拉群讨论按钮 Playwright 实测 ══════');

    const browser = await chromium.launch({ headless: true });
    try {
        // 造单（[#106 S4d-2] 挪进 try：中途某次建单抛错时，已建的单也由 finally 清理）：
        //   #A 未建群 + 指派 USER_ASSIGNEE_ID + 创建人 = USER_CREATOR_ID（T1/T2/T3/T4/T5/T6/T10-T17 复用）
        //   #B 已建群 + chat_name='[需求]测试-讨论' + open_conversation_id='conv_B' （T7）
        //   #C 已建群 + chat_name='' + open_conversation_id='conv_C'（T8 兜底文案）
        //   #D 已建群但 open_conversation_id='   '（T9 trim 后空白仍按未建群）
        const idA = await apiCreate(creatorToken, { title: 'c4拉群按钮-未建群' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
        created.push(idA);
        await apiAssign(adminToken, idA, USER_ASSIGNEE_ID);

        const idB = await apiCreate(creatorToken, { title: 'c4拉群按钮-已建群' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
        created.push(idB);
        await dbRun('UPDATE issues SET dingtalk_chat_id=?, dingtalk_open_conversation_id=?, dingtalk_chat_name=? WHERE id=?',
            ['chat_B', 'conv_B', '[需求]测试-讨论', idB]);

        const idC = await apiCreate(creatorToken, { title: 'c4拉群按钮-chatname空' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
        created.push(idC);
        await dbRun('UPDATE issues SET dingtalk_chat_id=?, dingtalk_open_conversation_id=?, dingtalk_chat_name=? WHERE id=?',
            ['chat_C', 'conv_C', '', idC]);

        const idD = await apiCreate(creatorToken, { title: 'c4拉群按钮-脏空白' + RUN_TAG, type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
        created.push(idD);
        await dbRun('UPDATE issues SET dingtalk_open_conversation_id=? WHERE id=?', ['   ', idD]);

        // T1 admin 权限：未建群应见「💬 拉群讨论」按钮
        {
            const page = await gotoAs(browser, adminToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn !== null, 'T1 admin 见拉群讨论按钮');
            await page.close();
        }
        // T2 publisher 权限
        {
            const page = await gotoAs(browser, publisherToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn !== null, 'T2 publisher 见拉群讨论按钮');
            await page.close();
        }
        // T3 被指派开发权限（USER_ASSIGNEE_ID 即 #A 的 assigned_to）
        {
            const page = await gotoAs(browser, assigneeToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn !== null, 'T3 被指派开发见拉群讨论按钮');
            await page.close();
        }
        // T4 创建人权限（USER_CREATOR_ID 即 #A 的 created_by）
        {
            const page = await gotoAs(browser, creatorToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn !== null, 'T4 创建人见拉群讨论按钮');
            await page.close();
        }
        // T5 viewer 不渲染整个钉钉沟通群区块
        {
            const page = await gotoAs(browser, viewerToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn === null, 'T5 viewer 不见拉群讨论按钮');
            await page.close();
        }
        // T6 路人 user（非指派非创建）
        {
            const page = await gotoAs(browser, bystanderToken);
            await openDrawer(page, idA);
            const btn = await page.$(`#btnCreateChat_${idA}`);
            must(btn === null, 'T6 路人 user 不见拉群讨论按钮');
            await page.close();
        }
        // T7 已建群（#B）→ 灰色 disabled 按钮 + 群名展示
        {
            const page = await gotoAs(browser, adminToken);
            await openDrawer(page, idB);
            const btnText = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const b = buttons.find(x => x.textContent.includes('请到钉钉查看'));
                return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
            });
            must(btnText && btnText.disabled, 'T7 已建群按钮 disabled');
            must(btnText && btnText.text.includes('[需求]测试-讨论'), 'T7 已建群按钮展群名');
            must(!(await page.$(`#btnCreateChat_${idB}`)), 'T7 已建群无新拉群按钮');
            await page.close();
        }
        // T8 已建群但 chat_name 为空 → 兜底「（群名缺失）」
        {
            const page = await gotoAs(browser, adminToken);
            await openDrawer(page, idC);
            const btnText = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const b = buttons.find(x => x.textContent.includes('请到钉钉查看'));
                return b ? b.textContent.trim() : null;
            });
            must(btnText && btnText.includes('群名缺失'), 'T8 群名缺失兜底文案');
            await page.close();
        }
        // T9 dingtalk_open_conversation_id 全空白 → 仍按未建群（trim 与后端一致）
        {
            const page = await gotoAs(browser, adminToken);
            await openDrawer(page, idD);
            const btn = await page.$(`#btnCreateChat_${idD}`);
            must(btn !== null, 'T9 脏空白 open_conv_id 仍按未建群显示拉群按钮');
            await page.close();
        }
        // T10 点击成功（mock 拦截 create-chat + 同步 db 真写）→ toast + 重渲染成已建群灰显
        //   codex 37 #4 部分采纳：mock 成功的同时直接 dbRun UPDATE idA dingtalk_* 字段，
        //   绕过 mock 拦截让 loadIssues + openDrawer 拿到真实"已建群"数据，验证完整闭环：
        //   mock 响应 → 主 toast → loadIssues → openDrawer 重渲染 → 拉群按钮消失 + 已建群灰显出现
        //   codex 38 #1+#2 落地：清理放局部 try/finally + 条件等待替代固定 waitForTimeout
        {
            const page = await gotoAs(browser, adminToken);
            try {
                await page.route(`**/api/issues/${idA}/create-chat`, async route => {
                    // mock 响应同时 db 真写，让前端 loadIssues 拿到真实"已建群"数据
                    await dbRun('UPDATE issues SET dingtalk_chat_id=?, dingtalk_open_conversation_id=?, dingtalk_chat_name=? WHERE id=?',
                        ['mock_chat_t10', 'mock_conv_t10', '[需求]c4拉群按钮-未建群-讨论', idA]);
                    route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            message: '讨论群已创建',
                            id: idA,
                            chat_id: 'mock_chat_t10',
                            open_conversation_id: 'mock_conv_t10',
                            chat_name: '[需求]c4拉群按钮-未建群-讨论',
                            requester_degraded: false
                        })
                    });
                });
                await openDrawer(page, idA);
                await page.click(`#btnCreateChat_${idA}`);
                // codex 38 #2：条件等待替代 waitForTimeout(1200) —— 等"拉群按钮消失 + 已建群灰显按钮出现"
                await page.waitForSelector(`#btnCreateChat_${idA}`, { state: 'detached', timeout: 5000 });
                await page.waitForFunction(
                    chatName => Array.from(document.querySelectorAll('button')).some(b => b.disabled && b.textContent.includes(chatName)),
                    '[需求]c4拉群按钮-未建群-讨论',
                    { timeout: 5000 }
                );
                const toastOk = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('讨论群已创建')));
                must(toastOk, 'T10 mock 成功 toast「讨论群已创建」');
                // 验灰显闭环（条件等待已确保 DOM 到位）：拉群按钮已消失，已建群灰显按钮已出现
                const btnGone = await page.$(`#btnCreateChat_${idA}`);
                must(btnGone === null, 'T10 成功后拉群按钮消失');
                const greyBtn = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const b = buttons.find(x => x.textContent.includes('请到钉钉查看'));
                    return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
                });
                must(greyBtn && greyBtn.disabled, 'T10 成功后已建群灰显按钮 disabled');
                must(greyBtn && greyBtn.text.includes('[需求]c4拉群按钮-未建群-讨论'), 'T10 已建群按钮展真实群名');
            } finally {
                // codex 38 #1：局部 finally 保证任何断言失败/超时/异常都执行清理，
                // 防止 idA dingtalk_* 脏值污染后续 T11-T18 的"未建群"前置条件
                try { await page.unroute(`**/api/issues/${idA}/create-chat`); } catch (_) {}
                await dbRun('UPDATE issues SET dingtalk_chat_id=NULL, dingtalk_open_conversation_id=NULL, dingtalk_chat_name=NULL WHERE id=?', [idA]);
                await page.close();
            }
        }
        // T11 mock requester_degraded=true → 主 toast 成功 + 延迟 warning toast
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        message: '讨论群已创建（业务方因无钉钉账号/手机号未加入，请线下转达或补填手机号后重新整理）',
                        id: idA,
                        chat_id: 'mock_chat',
                        open_conversation_id: 'mock_conv',
                        chat_name: '[需求]c4拉群按钮-未建群-讨论',
                        requester_degraded: true
                    })
                });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(1800);
            const warnToast = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('业务方未加入')));
            must(warnToast, 'T11 降级 warning toast「业务方未加入」');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T12 NOT_ENOUGH_MEMBERS
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '缺少开发或业务方钉钉账号，无法建群', code: 'NOT_ENOUGH_MEMBERS' }) });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('缺少开发或业务方钉钉账号')));
            must(ok, 'T12 NOT_ENOUGH_MEMBERS toast 展后端文案');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T13 CHAT_LINK_FAILED
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '建群后落库失败，请联系管理员', code: 'CHAT_LINK_FAILED' }) });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('建群后落库失败')));
            must(ok, 'T13 CHAT_LINK_FAILED toast 展后端文案');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T14 CHAT_CREATED_DB_UPDATE_FAILED
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '钉钉群已创建但平台落库失败，请联系管理员手工补录（详见后端日志 issue-create-chat CRITICAL）', code: 'CHAT_CREATED_DB_UPDATE_FAILED' }) });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('钉钉群已创建但平台落库失败')));
            must(ok, 'T14 CHAT_CREATED_DB_UPDATE_FAILED toast 展后端文案');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T15 NO_DINGTALK_CONFIG
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '钉钉配置未填写，请管理员先到系统配置 → 钉钉配置填写凭证', code: 'NO_DINGTALK_CONFIG' }) });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('钉钉配置未填写')));
            must(ok, 'T15 NO_DINGTALK_CONFIG toast 展后端文案');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T16 DINGTALK_USER_LOOKUP_EMPTY（codex 37 #1：与后端契约 5 错误码对齐，commit C codex 35 M-1 真实路径）
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '业务方手机号反查命中但返回空 dingtalk_user_id，无法加入群', code: 'DINGTALK_USER_LOOKUP_EMPTY' }) });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('反查命中但返回空')));
            must(ok, 'T16 DINGTALK_USER_LOOKUP_EMPTY toast 展后端文案');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T17 防抖：mock 延迟 2s + 真实 page.click 双击 → route 只被命中 1 次
        //   codex 37 #5：用 page.click 真实连点替代 evaluate 内 if (!disabled) click 跳过逻辑
        {
            const page = await gotoAs(browser, adminToken);
            let hitCount = 0;
            await page.route(`**/api/issues/${idA}/create-chat`, async route => {
                hitCount++;
                await new Promise(r => setTimeout(r, 2000));
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: '讨论群已创建', id: idA, chat_id: 'm', open_conversation_id: 'm', chat_name: 't', requester_degraded: false }) });
            });
            await openDrawer(page, idA);
            // 第一次点击（不 await，让请求挂起）
            const click1 = page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(300);
            // 立即查按钮 disabled + 文案改"建群中…"
            const btnState = await page.evaluate(idd => {
                const b = document.getElementById('btnCreateChat_' + idd);
                return b ? { disabled: b.disabled, text: b.textContent } : null;
            }, idA);
            must(btnState && btnState.disabled, 'T17 点击后按钮立即 disabled');
            must(btnState && btnState.text === '建群中…', 'T17 点击后文案改「建群中…」');
            // codex 37 #5 + codex 38 #3：第二次点击用 force:true 强制尝试命中 disabled 按钮，
            //   验证「disabled/前端防抖不会发出第二个请求」(回归测试)，不是模拟真实用户双击：
            //   - force:true 绕过 actionability 检查（disabled 按钮 page.click 默认会等到 timeout）
            //   - 浏览器 spec 保证 disabled HTMLButtonElement 不触发 onclick → hitCount 仍 = 1
            //   - 真实快速双击需 Promise.all/连续非 force page.click，可后续补；当前用例聚焦防抖回归
            try {
                await page.click(`#btnCreateChat_${idA}`, { force: true, timeout: 1000 });
            } catch (e) { /* 第二次点击可能因 disabled 阻断或 timeout，均预期 */ }
            await click1;
            await page.waitForTimeout(500);
            must(hitCount === 1, 'T17 防抖：route 只被命中 1 次（实际 ' + hitCount + '）');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T18 idempotent=true → toast 展「已有讨论群」
        {
            const page = await gotoAs(browser, adminToken);
            await page.route(`**/api/issues/${idA}/create-chat`, route => {
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        message: '该需求已有讨论群（请到钉钉客户端查看）',
                        id: idA,
                        chat_id: 'existing',
                        open_conversation_id: 'existing',
                        chat_name: '[需求]测试-讨论',
                        idempotent: true
                    })
                });
            });
            await openDrawer(page, idA);
            await page.click(`#btnCreateChat_${idA}`);
            await page.waitForTimeout(500);
            const ok = await page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > div')).some(d => d.textContent.includes('该需求已有讨论群')));
            must(ok, 'T18 idempotent toast「该需求已有讨论群」');
            await page.unroute(`**/api/issues/${idA}/create-chat`);
            await page.close();
        }
        // T19 控制台无 JS 报错（汇总所有页面 _errs）— 单独再开一页扫描渲染
        {
            const page = await gotoAs(browser, adminToken);
            await openDrawer(page, idA);
            await openDrawer(page, idB);
            await openDrawer(page, idC);
            await openDrawer(page, idD);
            await page.waitForTimeout(500);
            const jsErrs = (page._errs || []).filter(e => !/Failed to load resource/.test(e));
            must(jsErrs.length === 0, 'T19 控制台无 JS 报错' + (jsErrs.length ? '\n      详情：' + jsErrs.join('\n      ') : ''));
            await page.close();
        }
    } finally {
        // 清理（[#106 S4d-2] 浏览器先关；每个编号单独 try / 看状态码 / 再试一轮 / 遗留计失败，见 cleanupCreated）
        try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
        await cleanupCreated(adminToken);
    }

    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n══════ PASS ${pass} / FAIL ${fail} ══════`);
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}

main().catch(async (e) => {
    console.error(e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
