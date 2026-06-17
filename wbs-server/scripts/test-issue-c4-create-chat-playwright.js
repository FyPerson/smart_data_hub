/**
 * v1.75.0 commit D — 需求拉群讨论按钮 Playwright 实测
 *
 * 用法：本地 server(3000) 启动后 node scripts/test-issue-c4-create-chat-playwright.js
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1, PUBLISHER_ID = 7, USER_CREATOR_ID = 19, USER_ASSIGNEE_ID = 8, USER_BYSTANDER_ID = 9, VIEWER_ID = 2;

async function signAs(uid) {
    const u = await new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id,username,display_name,role FROM users WHERE id=?', [uid], (e, r) => { db.close(); e ? rej(e) : res(r); });
    });
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}

function dbRun(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.run(sql, p, function (e) { db.close(); e ? rej(e) : res(this); }); }); }
function dbGet(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }

async function apiCreate(token, body) {
    const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.id;
}
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
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

async function main() {
    const adminToken = await signAs(ADMIN_ID);
    const publisherToken = await signAs(PUBLISHER_ID);
    const creatorToken = await signAs(USER_CREATOR_ID);
    const assigneeToken = await signAs(USER_ASSIGNEE_ID);
    const bystanderToken = await signAs(USER_BYSTANDER_ID);
    const viewerToken = await signAs(VIEWER_ID);

    console.log('\n══════ v1.75.0 commit D 拉群讨论按钮 Playwright 实测 ══════');

    // 造单：
    //   #A 未建群 + 指派 USER_ASSIGNEE_ID + 创建人 = USER_CREATOR_ID（T1/T2/T3/T4/T5/T6/T10-T17 复用）
    //   #B 已建群 + chat_name='[需求]测试-讨论' + open_conversation_id='conv_B' （T7）
    //   #C 已建群 + chat_name='' + open_conversation_id='conv_C'（T8 兜底文案）
    //   #D 已建群但 open_conversation_id='   '（T9 trim 后空白仍按未建群）
    const idA = await apiCreate(creatorToken, { title: 'c4拉群按钮-未建群', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idA);
    await apiAssign(adminToken, idA, USER_ASSIGNEE_ID);

    const idB = await apiCreate(creatorToken, { title: 'c4拉群按钮-已建群', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idB);
    await dbRun('UPDATE issues SET dingtalk_chat_id=?, dingtalk_open_conversation_id=?, dingtalk_chat_name=? WHERE id=?',
        ['chat_B', 'conv_B', '[需求]测试-讨论', idB]);

    const idC = await apiCreate(creatorToken, { title: 'c4拉群按钮-chatname空', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idC);
    await dbRun('UPDATE issues SET dingtalk_chat_id=?, dingtalk_open_conversation_id=?, dingtalk_chat_name=? WHERE id=?',
        ['chat_C', 'conv_C', '', idC]);

    const idD = await apiCreate(creatorToken, { title: 'c4拉群按钮-脏空白', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idD);
    await dbRun('UPDATE issues SET dingtalk_open_conversation_id=? WHERE id=?', ['   ', idD]);

    const browser = await chromium.launch({ headless: true });
    try {
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
        // 清理
        try {
            for (const id of created) await apiDelete(adminToken, id);
        } catch (e) {
            console.log('清理失败：', e.message);
        }
        await browser.close();
    }

    console.log(`\n══════ PASS ${pass} / FAIL ${fail} ══════`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
