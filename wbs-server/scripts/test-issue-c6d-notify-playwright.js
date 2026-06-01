/**
 * v1.74.0 C7/c6d — 通知开发按钮「点击 → UI 反馈」端到端 Playwright 实测
 *
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-c6d-notify-playwright.js
 *
 * 背景（盘点 2026-06-01）：c6c 已验通知按钮**存在性**（C7/C8），但未验"点击后 UI 反馈"。
 *   唯一缺的端到端环 = 点通知开发按钮 → 真发/降级 → toast + 详情页通知徽章状态变化。本脚本补这一环。
 *
 * 测法（不骚扰真人钉钉）：
 *   D1 成功态：page.route 拦截 notify-developer 返 mock 成功 → 验 toast「通知已发送」（前端乐观反馈链路）
 *   D2 失败态：指派给**无 phone** 用户(id=8 刘林航)，点击走**真 endpoint** → no_phone 在发送前短路
 *             → 落 notify_status='failed'+notify_error='no_phone'（零真发）→ loadIssues 重读 db
 *             → 详情页徽章真变「失败」+ hover title=no_phone（验真实 db→UI 渲染链路）
 *   D3 异步弹窗踩坑预防：notify-developer **不弹 confirm**（notifyAction 无 confirm），但仍挂 dialog
 *             自动 accept 兜底，且点击用 fire-and-forget 不死等（沿用 c6b reason modal 防 hang 范式）
 *   D4 控制台无 JS 报错
 *
 * ⚠️ 测试残留清理（踩坑预防）：finally 删测试单 + hang/中断后须清 issue 4 表残留再重启 server
 *   （否则下次启动撞 C1 硬门槛标 schema error → 全 endpoint 503）。
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
const ADMIN_ID = 1, DEV_WITH_PHONE = 19, DEV_NO_PHONE = 8;

async function signAs(uid) {
    const u = await new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get('SELECT id,username,display_name,role FROM users WHERE id=?', [uid], (e, r) => { db.close(); e ? rej(e) : res(r); }); });
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}
function dbGet(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, p, (e, r) => { db.close(); e ? rej(e) : res(r); }); }); }
async function apiCreate(token, body) { const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).id; }
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
async function apiAssign(token, id, devId) { await fetch(`${BASE_URL}/api/issues/${id}/assign`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: devId }) }); }
async function apiStatus(token, id, status, reason) { const b = { status }; if (reason) b.last_transition_reason = reason; await fetch(`${BASE_URL}/api/issues/${id}/status`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }

let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => {
        if (m.type() !== 'error') return;
        // D2 故意触发 no_phone → 502，浏览器把 502 资源加载计为 console error；这是预期业务失败非 JS bug，过滤掉。
        // 只保留真正的 JS 运行时报错（非"Failed to load resource"的 HTTP 状态噪声）。
        if (/Failed to load resource: the server responded with a status of 50[02]/.test(m.text())) return;
        errs.push(m.text());
    });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    // D3 踩坑预防：任何弹 dialog（confirm/alert）自动 accept，避免 evaluate 死等
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Issue_Tracker.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(700);
    page._errs = errs;
    return page;
}

const created = [];
async function main() {
    const adminToken = await signAs(ADMIN_ID);
    console.log('\n══════ v1.74.0 c6d 通知按钮「点击→UI 反馈」实测 ══════');

    // 造数：① 指派有 phone 开发 + 处理中（D1 mock 成功用）② 指派无 phone 开发 + 处理中（D2 no_phone 真路径用）
    const idOk = await apiCreate(adminToken, { title: 'c6d通知成功测试', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idOk);
    await apiAssign(adminToken, idOk, DEV_WITH_PHONE);
    await apiStatus(adminToken, idOk, '处理中');

    const idNoPhone = await apiCreate(adminToken, { title: 'c6d通知失败测试', type: '数据质量', requester_dept: '市场营销部', requester_name: '李', description: 'x' });
    created.push(idNoPhone);
    await apiAssign(adminToken, idNoPhone, DEV_NO_PHONE);
    await apiStatus(adminToken, idNoPhone, '处理中');

    const browser = await chromium.launch();
    let allErrs = [];
    try {
        // ===== D1 成功态：page.route mock notify-developer 成功 → toast「通知已发送」=====
        const p1 = await gotoAs(browser, adminToken);
        // 拦截 notify-developer：返 mock 成功（不真打 endpoint、不真发钉钉）
        await p1.route('**/api/issues/*/notify-developer', route =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message_key: 'mock_pqk' }) })
        );
        await p1.evaluate(id => openDrawer(id), idOk);
        await p1.waitForTimeout(600);
        // 详情页应有"通知开发"按钮（前置校验）
        const hasNotifyBtn = await p1.evaluate(() => document.getElementById('drawerBody').innerText.includes('通知开发'));
        must(hasNotifyBtn, 'D1a 详情页含「通知开发」按钮（前置）');
        // fire-and-forget 点击（D3：不 await 会潜在弹窗的链路；notifyAction 内部 async）
        await p1.evaluate(id => { notifyAction(id, 'notify-developer'); }, idOk);
        // 等 toast 出现（成功 toast 文案「通知已发送」）
        const toastOk = await p1.waitForFunction(() => {
            const t = document.body.innerText;
            return t.includes('通知已发送');
        }, { timeout: 5000 }).then(() => true).catch(() => false);
        must(toastOk, 'D1b 点击通知开发 → toast「通知已发送」（乐观反馈链路）');
        allErrs = allErrs.concat(p1._errs);
        await p1.close();

        // ===== D2 失败态：no_phone 真路径 → 徽章真变「失败」+ hover no_phone =====
        const p2 = await gotoAs(browser, adminToken);
        await p2.evaluate(id => openDrawer(id), idNoPhone);
        await p2.waitForTimeout(500);
        // 点击通知开发（真打 endpoint → dev id=8 无 phone → 短路落 failed，零真发钉钉）
        // 用 waitForResponse 锚定 notify-developer 请求真完成（不靠 fire-and-forget 时序猜，避免读 db 太早）
        const [notifyResp] = await Promise.all([
            p2.waitForResponse(r => /\/api\/issues\/\d+\/notify-developer/.test(r.url()), { timeout: 8000 }).catch(() => null),
            p2.evaluate(id => { notifyAction(id, 'notify-developer'); }, idNoPhone),
        ]);
        must(notifyResp && notifyResp.status() === 502, `D2a notify-developer 真打后端返 502（实际 ${notifyResp && notifyResp.status()}）`);
        // 等失败 toast（前端 showToast(body.error)）
        const toastFail = await p2.waitForFunction(() => /未绑定手机号|无法推送/.test(document.body.innerText), { timeout: 5000 }).then(() => true).catch(() => false);
        must(toastFail, 'D2b 失败 toast 含后端 no_phone message（未绑定手机号）');
        // 验后端真落库 failed + no_phone
        const row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [idNoPhone]);
        must(row.notify_status === 'failed' && row.notify_error === 'no_phone', `D2c 后端真落 failed+no_phone（实际 ${row.notify_status}/${row.notify_error}）`);
        // notifyAction 失败分支不 reload+reopen，故手动重开详情验徽章读 db 渲染
        await p2.evaluate(() => loadIssues());
        await p2.waitForTimeout(400);
        await p2.evaluate(id => openDrawer(id), idNoPhone);
        await p2.waitForTimeout(500);
        const badge = await p2.evaluate(() => {
            const b = document.querySelector('#drawerBody .notify-badge');
            return b ? { cls: b.className, text: b.textContent.trim(), title: b.getAttribute('title') } : null;
        });
        must(badge && /notify-failed/.test(badge.cls) && badge.text === '失败', `D2d 详情页通知徽章真变「失败」（实际 ${JSON.stringify(badge)}）`);
        must(badge && badge.title === 'no_phone', `D2e 失败徽章 hover title=notify_error(no_phone)（实际 ${badge && badge.title}）`);
        allErrs = allErrs.concat(p2._errs);
        await p2.close();

        must(allErrs.length === 0, `D4 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
    } finally {
        await browser.close();
        for (const id of created) await apiDelete(adminToken, id);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 c6d 通知按钮点击→UI 反馈实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('c6d 实测异常:', e); process.exit(1); });
