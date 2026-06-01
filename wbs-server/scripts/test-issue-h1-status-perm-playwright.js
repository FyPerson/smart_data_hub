/**
 * v1.74.0 C8 合并审 H-1 修复实测 — 状态按钮权限对齐后端状态机
 *
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-h1-status-perm-playwright.js
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1, DEV1_ID = 19, DEV2_ID = 8;

async function signAs(uid) {
    const u = await new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get('SELECT id,username,display_name,role FROM users WHERE id=?', [uid], (e, r) => { db.close(); e ? rej(e) : res(r); }); });
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}
async function apiCreate(token, body) { const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).id; }
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
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
async function main() {
    const adminToken = await signAs(ADMIN_ID);
    const dev1Token = await signAs(DEV1_ID);
    console.log('\n══════ H-1 修复实测：状态按钮权限对齐后端 ══════');

    // 造一条指派给 dev1 + 处理中的需求（dev1 是被指派人，可推进到待验证）
    const idAssigned = await apiCreate(adminToken, { title: 'H1被指派需求', type: '数据质量', requester_dept: '市场营销部', requester_name: '王', description: 'x' });
    created.push(idAssigned);
    await apiAssign(adminToken, idAssigned, DEV1_ID);
    await apiStatus(adminToken, idAssigned, '处理中');  // 现在 dev1 应能「转为待验证」

    const browser = await chromium.launch();
    let allErrs = [];
    try {
        // H1-1/H1-2 被指派 user(dev1)
        const dp = await gotoAs(browser, dev1Token);
        const devBtns = await statusButtons(dp, idAssigned);
        must(devBtns.includes('转为待验证'), `H1-1 被指派 user 能看到「转为待验证」推进按钮（实际 [${devBtns.join(', ')}]）`);
        must(!devBtns.some(b => /已暂缓|已拒绝|已关闭|待处理/.test(b)), `H1-2 被指派 user 看不到终态/激活按钮（实际 [${devBtns.join(', ')}]）`);
        allErrs = allErrs.concat(dp._errs);
        await dp.close();

        // H1-3 非指派 user：造另一条指派给 dev2 的单，dev1 看
        const idOther = await apiCreate(adminToken, { title: 'H1他人需求', type: '数据质量', requester_dept: '市场营销部', requester_name: '李', description: 'x' });
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
        await browser.close();
        for (const id of created) await apiDelete(adminToken, id);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 H-1 修复实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('H-1 实测异常:', e); process.exit(1); });
