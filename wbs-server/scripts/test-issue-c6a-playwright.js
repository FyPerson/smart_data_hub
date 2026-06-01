/**
 * v1.74.0 C6a — 前端清理（改名/删死引用/枚举对齐）Playwright UI 实测
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c6a-playwright.js
 * 复用 JWT 注入范式（goto login.html → localStorage token → goto 业务页）。
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN_ID = 1;

async function signAs(userId) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
async function apiCreate(token, body) {
    const r = await fetch(`${BASE_URL}/api/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); return j.id;
}
async function apiDelete(token, id) {
    await fetch(`${BASE_URL}/api/issues/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } }

async function main() {
    const adminToken = await signAs(ADMIN_ID);
    console.log('\n══════ v1.74.0 C6a 前端清理 Playwright 实测 ══════');

    // 造 2 条不同类型/状态的需求验证渲染
    const id1 = await apiCreate(adminToken, { title: 'C6a看板需求', type: '看板/报表需求', requester_dept: '市场营销部', requester_name: '张三', description: 'x' });
    const id2 = await apiCreate(adminToken, { title: 'C6a平台bug', type: '平台 bug', requester_dept: '信息技术部', requester_name: '李四', description: 'y' });

    const browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
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
        const rowOk = await page.evaluate((tid) => {
            const rows = [...document.querySelectorAll('#needTableBody tr, #issueTableBody tr, tbody tr')];
            const row = rows.find(r => r.textContent.includes('C6a看板需求'));
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
        }, id1);
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
        await browser.close();
        await apiDelete(adminToken, id1);
        await apiDelete(adminToken, id2);
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C6a 前端清理实测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('实测脚本异常:', e); process.exit(1); });
