/**
 * v1.74.0 C6c — 列表12列/筛选栏/详情区块/通知按钮/M-3权限 Playwright UI 实测
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c6c-playwright.js
 * 分场景验收（codex G）：列表/筛选 + 详情区块 + 附件异步 + 通知动作 + viewer 只读。
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1, VIEWER_ID = 2, DEV1_ID = 19;

async function signAs(uid) {
    const u = await new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.get('SELECT id,username,display_name,role FROM users WHERE id=?', [uid], (e, r) => { db.close(); e ? rej(e) : res(r); }); });
    if (!u) throw new Error(`user ${uid} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}
function dbRun(sql, p) { return new Promise((res, rej) => { const db = new sqlite3.Database(DB_PATH); db.run(sql, p, function (e) { db.close(); e ? rej(e) : res(this); }); }); }
async function apiCreate(token, body) { const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return (await r.json()).id; }
async function apiDelete(token, id) { await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); }
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
async function main() {
    const adminToken = await signAs(ADMIN_ID);
    const viewerToken = await signAs(VIEWER_ID);
    console.log('\n══════ v1.74.0 C6c 列表/详情/通知/权限 Playwright 实测 ══════');

    // 造数据：一条完整需求（含 OA/原始诉求/指派 dev1/处理中）+ 一条已关闭
    const idFull = await apiCreate(adminToken, { title: 'C6c完整需求', type: '看板/报表需求', requester_dept: '市场营销部', requester_name: '王业务', requester_phone: '13800000000', oa_number: 'OA-C6C-1', raw_requirement: '业务方原话：要销售看板', description: '梳理后', data_domain: '合同' });
    created.push(idFull);
    await apiAssign(adminToken, idFull, DEV1_ID);
    await apiStatus(adminToken, idFull, '处理中');
    const idClosed = await apiCreate(adminToken, { title: 'C6c已关闭需求', type: '数据质量', requester_dept: '财务管理部', requester_name: '李业务', description: 'x' });
    created.push(idClosed);
    await apiStatus(adminToken, idClosed, '处理中');
    await apiStatus(adminToken, idClosed, '待验证');
    await apiStatus(adminToken, idClosed, '已关闭', '已交付验收');

    const browser = await chromium.launch();
    let allErrs = [];
    try {
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
        const rowOk = await ap.evaluate((tid) => {
            const rows = [...document.querySelectorAll('#issueTableBody tr')];
            const row = rows.find(r => r.textContent.includes('C6c完整需求'));
            if (!row) return { found: false };
            return { found: true, hasUndefined: row.textContent.includes('undefined'), hasNotify: !!row.querySelector('.notify-badge'), hasType: !!row.querySelector('.type-tag'), tdCount: row.querySelectorAll('td').length };
        }, idFull);
        must(rowOk.found && rowOk.tdCount === 12, `C3 列表行 12 td（实际 ${rowOk.tdCount}）`);
        must(rowOk.hasNotify && rowOk.hasType && !rowOk.hasUndefined, 'C3 行渲染通知徽章/类型色块正常无 undefined');

        // C4-C8 详情（idFull 处理中+指派）
        await ap.evaluate(id => openDrawer(id), idFull);
        await ap.waitForTimeout(800); // 等附件异步
        const drawerText = await ap.evaluate(() => document.getElementById('drawerBody').innerText);
        must(drawerText.includes('王业务') && drawerText.includes('市场营销部'), 'C4 详情：业务方姓名/部门');
        must(drawerText.includes('OA-C6C-1') && drawerText.includes('要销售看板'), 'C4 详情：OA 行 + 原始诉求区');
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
        const xssId = await apiCreate(adminToken, { title: 'C6cXSS测试', type: '数据质量', requester_dept: '市场营销部', requester_name: 'x', description: 'y' });
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
        await browser.close();
        for (const id of created) await apiDelete(adminToken, id);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6c 列表/详情/通知/权限实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('实测脚本异常:', e); process.exit(1); });
