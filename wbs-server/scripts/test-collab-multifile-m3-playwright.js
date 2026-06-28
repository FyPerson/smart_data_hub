/**
 * 数据协作·多文件上传 M3 前端 Playwright UI 实测
 *
 * 用法：node scripts/test-collab-multifile-m3-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 覆盖（纯客户端，无需 warehouse）：
 *   T1 建单·数据范围多选 3 文件 → 预览 3 项
 *   T2 去重：重复选同 3 文件 → 仍 3 项（name+size+lastModified 去重，RC2-L2）
 *   T3 移除 1 个 → 2 项
 *   T4 超 5 个 → 截到 5 + toast
 *   T5 非法扩展名(.pdf) → 不入列
 *   T6 交付弹窗：脚本多选 2 + 数据多选 2 → 两预览各 2 项
 *   T7 交付校验：清空后点提交 → toast「请至少选择 1 个 SQL 脚本」（不发请求）
 *   + 全程 0 个 console error（JS 语法/运行时健康）
 */
'use strict';

const fs = require('fs');
const os = require('os');
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
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

// 造测试文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-pw-'));
function mk(name, content = 'x') { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; }
const ds1 = mk('ds1.txt'), ds2 = mk('ds2.xlsx'), ds3 = mk('ds3.xls'), ds4 = mk('ds4.txt'), ds5 = mk('ds5.txt'), ds6 = mk('ds6.txt');
const bad = mk('bad.pdf');
const sc1 = mk('s1.sql'), sc2 = mk('s2.txt');
const da1 = mk('d1.xlsx'), da2 = mk('d2.xls');

async function previewCount(page, wrapId) {
    return await page.$$eval(`#${wrapId} .file-item`, els => els.length);
}

(async () => {
    console.log('=== M3 前端多文件 Playwright UI 实测 ===\n');
    const token = await signAs(ADMIN_ID);
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const consoleErrors = [];
    // 过滤 route.abort() 故意中断 submit 请求引起的资源加载失败（测试制品，非 app JS 错误）
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR_FAILED|ERR_ABORTED/.test(t)) return;
        consoleErrors.push(t);
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE_URL}/Data_Collab.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        // 打开新建协作单弹窗
        console.log('1. 建单·数据范围多文件');
        await page.click('button:has-text("新建协作单")');
        await page.waitForSelector('#newModal.show', { timeout: 3000 });
        await page.waitForTimeout(200);

        // T1: 多选 3 文件
        await page.setInputFiles('#f_data_scope', [ds1, ds2, ds3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 3, 'T1 数据范围多选 3 文件 → 预览 3 项');

        // T2: 重复选同 3 → 去重仍 3
        await page.setInputFiles('#f_data_scope', [ds1, ds2, ds3]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 3, 'T2 重复选同文件 → 去重后仍 3 项');

        // T3: 移除第 1 个 → 2 项
        await page.click('#dataScopePreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 2, 'T3 移除 1 个 → 2 项');

        // T4: 再加到超 5 → 截到 5
        await page.setInputFiles('#f_data_scope', [ds1, ds4, ds5, ds6]); // 当前 2(ds2,ds3) + 尝试加 4 → ds1 新+ds4+ds5 到 5，ds6 被拒
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === 5, 'T4 超 5 → 截到 5 项');

        // T5: 非法扩展名 .pdf 不入列
        const before = await previewCount(page, 'dataScopePreview');
        await page.setInputFiles('#f_data_scope', [bad]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'dataScopePreview') === before, 'T5 .pdf 非法扩展名 → 不入列（数量不变）');

        // 关闭新建弹窗
        await page.evaluate(() => { const m = document.getElementById('newModal'); if (m) m.classList.remove('show'); });

        // T6: 交付弹窗多文件（直接调 openSubmitDeliveryDialog 打开 UI，不依赖真实指派单）
        console.log('\n2. 交付结果多文件');
        await page.evaluate(() => openSubmitDeliveryDialog(999999));
        await page.waitForSelector('#submitDeliveryModal.show', { timeout: 3000 });
        await page.waitForTimeout(200);
        await page.setInputFiles('#f_delivery_script', [sc1, sc2]);
        await page.setInputFiles('#f_delivery_data', [da1, da2]);
        await page.waitForTimeout(150);
        expect(await previewCount(page, 'deliveryScriptPreview') === 2, 'T6 SQL 脚本多选 2 → 预览 2 项');
        expect(await previewCount(page, 'deliveryDataPreview') === 2, 'T6 结果数据多选 2 → 预览 2 项');

        // T7: 清空脚本后点提交 → 校验拦截（toast，不发请求）
        let submitFetchCalled = false;
        await page.route('**/api/collab/requests/**/submit', route => { submitFetchCalled = true; route.abort(); });
        await page.click('#deliveryScriptPreview .file-item:first-child .remove-btn');
        await page.click('#deliveryScriptPreview .file-item:first-child .remove-btn');
        await page.waitForTimeout(100);
        expect(await previewCount(page, 'deliveryScriptPreview') === 0, 'T7 脚本清空 → 0 项');
        await page.click('#btnSubmitDelivery');
        await page.waitForTimeout(300);
        expect(submitFetchCalled === false, 'T7 无脚本点提交 → 客户端校验拦截，未发 submit 请求');

        // T8: 单文件回归——各选 1 个 → 预览各 1 项（零回归）
        console.log('\n3. 单文件回归 + FormData 顺序');
        await page.evaluate(() => openSubmitDeliveryDialog(999998));
        await page.waitForTimeout(150);
        await page.setInputFiles('#f_delivery_script', [sc1]);
        await page.setInputFiles('#f_delivery_data', [da1]);
        await page.waitForTimeout(120);
        expect((await previewCount(page, 'deliveryScriptPreview')) === 1 && (await previewCount(page, 'deliveryDataPreview')) === 1,
            'T8 单文件各 1 → 预览各 1 项（零回归）');

        // T9: FormData 顺序——全部脚本在全部数据之前 append（对齐后端 smoke 取首脚本=上传首个）
        await page.evaluate(() => openSubmitDeliveryDialog(999997));
        await page.waitForTimeout(150);
        await page.setInputFiles('#f_delivery_script', [sc1, sc2]);
        await page.setInputFiles('#f_delivery_data', [da1, da2]);
        await page.waitForTimeout(120);
        let capturedBody = null;
        await page.unroute('**/api/collab/requests/**/submit');
        await page.route('**/api/collab/requests/**/submit', route => { capturedBody = route.request().postData(); route.abort(); });
        await page.click('#btnSubmitDelivery');
        await page.waitForTimeout(300);
        const iS1 = capturedBody ? capturedBody.indexOf('s1.sql') : -1;
        const iS2 = capturedBody ? capturedBody.indexOf('s2.txt') : -1;
        const iD1 = capturedBody ? capturedBody.indexOf('d1.xlsx') : -1;
        expect(iS1 >= 0 && iS2 >= 0 && iD1 >= 0 && iS1 < iD1 && iS2 < iD1,
            `T9 FormData 全部脚本在全部数据之前（s1=${iS1},s2=${iS2},d1=${iD1}）`);

        // console 健康
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);

    } catch (e) {
        console.error('\n!! 运行异常：', e.message);
        fail++;
    } finally {
        await browser.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
        console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
        process.exit(fail === 0 ? 0 : 1);
    }
})();
