/**
 * 模型中心 C1 · 列表 ID 列 Playwright 行为实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c1-id-column-playwright.js
 * 前置：本地 server 已启动（默认 localhost:3000，可用 TEST_BASE_URL 覆盖）
 *
 * 规格来源：模型详情抽屉方案 v1.4 §5.6 + §2-A + D8（docs/local/模型中心/）
 * 覆盖：
 *   A1 表头结构：11 th、首列 ID sortable(data-sort-by=id)、colgroup 11 col 宽度合计 100%
 *   A2 行渲染：每行首列 `#id` 格式、与 tr data-id 一致
 *   A3 admin 操作列表头可见
 *   A4 排序三态：首击 desc(数值降序+图标↓) → 二击 asc(数值升序，非字符串序) → 三击清排序恢复原序
 *   A5 伴生表行同显自己的 id（搜索伴生表名定位，断言 ● 标记行首列 #id）
 *   A6 admin 空态 colspan=11
 *   V1 viewer 操作列表头隐藏(display:none)、每行 10 td（无操作列）
 *   V2 viewer ID 列可见 + 排序可用（全角色）
 *   V3 viewer 空态 colspan=10
 *   全程 0 console error
 */
'use strict';

const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let pass = 0, fail = 0;
function expect(cond, msg, detail) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}${detail ? '  ' + detail : ''}`); fail++; }
}

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function openModelCenter(browser, token, consoleErrors) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
    await page.waitForSelector('#modelListBody tr');
    return { context, page };
}

const getIds = page => page.$$eval('#modelListBody tr[data-id]', rows => rows.map(r => Number(r.dataset.id)));
const getFirstCells = page => page.$$eval('#modelListBody tr[data-id]', rows => rows.map(r => r.cells[0].textContent.trim()));
async function searchAndWait(page, keyword) {
    await page.fill('#searchKeyword', keyword);
    await page.evaluate(() => loadModels());
    await page.waitForTimeout(400);
}

(async () => {
    console.log('=== 模型中心 C1 列表 ID 列 Playwright 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];

    try {
        // ============ admin 视角 ============
        console.log('A. admin 视角');
        const adminToken = await fx.signAs(fx.ADMIN_ID);
        let { context, page } = await openModelCenter(browser, adminToken, consoleErrors);

        // A1 表头结构
        const ths = await page.$$eval('#modelListTable thead th', els => els.map(e => e.textContent.trim()));
        expect(ths.length === 11, 'A1 表头 11 列', `got ${ths.length}`);
        expect(ths[0].startsWith('ID'), 'A1 首列表头为 ID', `got ${ths[0]}`);
        expect(await page.$('#modelListTable thead th.sortable[data-sort-by="id"]') !== null, 'A1 ID 表头 sortable + data-sort-by=id');
        const colWidths = await page.$$eval('#modelListTable colgroup col', els => els.map(e => e.style.width));
        expect(colWidths.length === 11, 'A1 colgroup 11 col', `got ${colWidths.length}`);
        const widthSum = colWidths.reduce((s, w) => s + parseFloat(w), 0);
        expect(Math.abs(widthSum - 100) < 0.01, 'A1 colgroup 宽度合计 100%', `got ${widthSum}`);

        // A2 行渲染
        const cells = await getFirstCells(page);
        const ids = await getIds(page);
        expect(cells.every(c => /^#\d+$/.test(c)), 'A2 每行首列 #id 格式', `sample ${cells.slice(0, 5)}`);
        expect(cells.every((c, i) => c === `#${ids[i]}`), 'A2 首列与 data-id 一致');

        // A3 操作列可见
        const opDisplay = await page.$eval('#modelListTable thead th:last-child', e => e.style.display);
        expect(opDisplay !== 'none', 'A3 admin 操作列表头可见', `display=${opDisplay}`);

        // A4 排序三态
        const initialIds = ids.slice();
        const idTh = await page.$('#modelListTable thead th[data-sort-by="id"]');
        await idTh.click();
        const descIds = await getIds(page);
        expect(descIds.every((v, i) => i === 0 || descIds[i - 1] >= v), 'A4 首击 desc：id 数值降序', `got ${descIds.slice(0, 8)}`);
        const icon = await page.$eval('#modelListTable thead th[data-sort-by="id"] .sort-icon', e => e.textContent);
        expect(icon === '↓', 'A4 desc 图标 ↓', `got ${icon}`);
        await idTh.click();
        const ascIds = await getIds(page);
        expect(ascIds.every((v, i) => i === 0 || ascIds[i - 1] < v), 'A4 二击 asc：id 数值升序（严格递增=非字符串序）', `got ${ascIds.slice(0, 8)}`);
        await idTh.click();
        const clearedIds = await getIds(page);
        expect(JSON.stringify(clearedIds) === JSON.stringify(initialIds), 'A4 三击清排序：恢复原始顺序');

        // A5 伴生表行同显自己的 id
        await searchAndWait(page, 'dwd_contract_header_change_di');
        const compCells = await getFirstCells(page);
        const compDots = await page.$$eval('#modelListBody tr[data-id]',
            rows => rows.map(r => !!r.querySelector('span[title*="变更追踪伴生表"]')));
        expect(compCells.length >= 1 && compDots.some(Boolean), 'A5 伴生行检索到', `rows=${compCells.length}`);
        const compIdx = compDots.indexOf(true);
        expect(compIdx >= 0 && /^#\d+$/.test(compCells[compIdx]), 'A5 伴生行首列显示自己的 #id', `got ${compCells[compIdx]}`);

        // A6 空态
        await searchAndWait(page, 'zzz_no_such_model_xyz');
        const adminColspan = await page.$eval('#modelListBody td[colspan]', e => e.getAttribute('colspan'));
        expect(adminColspan === '11', 'A6 admin 空态 colspan=11', `got ${adminColspan}`);
        await context.close();

        // ============ viewer 视角 ============
        console.log('V. viewer 视角');
        const viewerToken = await fx.signAs(fx.VIEWER_ID);
        ({ context, page } = await openModelCenter(browser, viewerToken, consoleErrors));

        const vOpDisplay = await page.$eval('#modelListTable thead th:last-child', e => e.style.display);
        expect(vOpDisplay === 'none', 'V1 viewer 操作列表头隐藏', `display=${vOpDisplay}`);
        const tdCounts = await page.$$eval('#modelListBody tr[data-id]', rows => rows.map(r => r.cells.length));
        expect(tdCounts.every(n => n === 10), 'V1 viewer 每行 10 td（无操作列）', `got ${[...new Set(tdCounts)]}`);

        const vCells = await getFirstCells(page);
        expect(vCells.every(c => /^#\d+$/.test(c)), 'V2 viewer 首列 #id 可见', `sample ${vCells.slice(0, 5)}`);
        await (await page.$('#modelListTable thead th[data-sort-by="id"]')).click();
        const vIds = await getIds(page);
        expect(vIds.every((v, i) => i === 0 || vIds[i - 1] >= v), 'V2 viewer ID 排序可用（desc）', `got ${vIds.slice(0, 8)}`);

        await searchAndWait(page, 'zzz_no_such_model_xyz');
        const vColspan = await page.$eval('#modelListBody td[colspan]', e => e.getAttribute('colspan'));
        expect(vColspan === '10', 'V3 viewer 空态 colspan=10', `got ${vColspan}`);
        await context.close();

        // ============ console ============
        console.log('C. console');
        expect(consoleErrors.length === 0, 'C1 全程 0 console error', JSON.stringify(consoleErrors.slice(0, 5)));
    } catch (e) {
        console.error('测试异常:', e);
        fail++;
    } finally {
        await browser.close();
    }

    console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
