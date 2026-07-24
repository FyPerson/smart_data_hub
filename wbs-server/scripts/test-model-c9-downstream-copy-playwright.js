/**
 * 模型中心 C9 · 下游引用扩到 DIM/DWD + 字段清单一键复制 Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c9-downstream-copy-playwright.js
 * 前置：本地 server 已启动
 *
 * 设计背景（实探得出，非假设）：
 *   复刻后端 /downstream SQL 探测本地库 —— DWD 全部只从 ODS 加工、不 JOIN 任何 DIM
 *   （#52 的 12 张源表全是 ods_*），DIM↔DWD 的关联发生在 PowerBI 语义层而非数仓 ETL。
 *   故 DIM 的下游候选恒为 0 → 给 DIM/DWD 传 hideWhenEmpty，无候选时整段撤掉，不留恒空区块；
 *   ODS 保留空态文案（「确认无下游」正是 ODS 下线决策要看的结论）。
 *
 * 覆盖：
 *   N1 DWD #52 有候选 → 渲染下游区且可点击导航
 *   N2 DIM #50/#55 无候选 → **整段不渲染**（不留空区块）
 *   N3 ODS #6 无候选时仍保留空态文案（与 DIM/DWD 行为区分）
 *   N4 mock 令 DIM 有候选 → 区段正常出现（证明不是「DIM 永远不查」）
 *   N5 字段复制：内容 === 当前可见字段，格式「名\t类型」逐行
 *   N6 搜索过滤后复制内容跟着变（复制的是所见，不是全量）
 *   N7 复制按钮反馈态（已复制 N 个字段 → 复原）
 *   N8 ODS 字段表同样有复制按钮且可用
 *   全程 0 console error
 */
'use strict';

const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let pass = 0, fail = 0;
function expect(cond, msg, detail) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}${detail !== undefined ? '  got=' + JSON.stringify(detail) : ''}`); fail++; }
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function openDrawerById(page, id) {
    await page.evaluate(i => openModelDrawer(i), id);
    await page.waitForSelector('#modelDetailDrawer.open');
    await page.waitForFunction(i => { const s = document.getElementById('modelDrawerSub'); return s && new RegExp('#' + i + '(?!\\d)').test(s.textContent); }, id);
    await page.waitForFunction(() => document.querySelector('#modelDrawerBody .sec'), {}, { timeout: 15000 });
}
async function closeDrawer(page) {
    await page.evaluate(() => closeModelDrawer());
    await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
}
// 等下游区落定（不再是「加载中…」）
async function waitDownstreamSettled(page) {
    await page.waitForFunction(() => {
        const secs = Array.from(document.querySelectorAll('#modelDrawerBody .sec'));
        const s = secs.find(x => /下游引用/.test((x.querySelector('.sec-title') || {}).textContent || ''));
        return !s || !/加载中/.test(s.textContent);
    }, {}, { timeout: 20000 });
}
const downstreamSec = (page) => page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('#modelDrawerBody .sec'));
    const s = secs.find(x => /下游引用/.test((x.querySelector('.sec-title') || {}).textContent || ''));
    return s ? s.textContent : null;
});
// 读表格里真实渲染出的字段（名 + 类型），用于与复制内容比对
const visibleRows = (page) => page.$$eval('#modelDrawerBody .field-table tbody tr', trs => trs
    .filter(tr => !/无匹配字段/.test(tr.textContent))
    .map(tr => {
        const name = (tr.querySelector('.f-name') || {}).textContent || '';
        const type = (tr.querySelector('.f-type') || {}).textContent || '';
        return { name: name.trim(), type: type.trim() };
    }));

(async () => {
    console.log('=== 模型中心 C9 下游引用扩展 + 字段复制 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        // ===== N1 DWD 有候选 → 渲染 =====
        console.log('N1. DWD #52 下游引用');
        await openDrawerById(page, 52);
        await waitDownstreamSettled(page);
        const ds52 = await downstreamSec(page);
        expect(ds52 !== null, 'DWD 有候选时渲染下游引用区', ds52 && ds52.slice(0, 30));
        const deps52 = await page.$$eval('#modelDrawerBody .mdc-dep-name', els => els.map(e => e.textContent));
        expect(deps52.length >= 1, `DWD 候选 ≥1（${deps52.length}）`, deps52);
        // 点击导航
        await page.locator('#modelDrawerBody .mdc-dep-item').first().click();
        await page.waitForFunction(() => { const s = document.getElementById('modelDrawerSub'); return s && !/#52(?!\d)/.test(s.textContent); }, {}, { timeout: 8000 });
        expect(true, '点下游候选可导航到该模型');
        await closeDrawer(page);

        // ===== N2 DIM 无候选 → 整段不渲染 =====
        console.log('N2. DIM 无候选 → 不留空区块');
        for (const id of [50, 55]) {
            await openDrawerById(page, id);
            await waitDownstreamSettled(page);
            await page.waitForTimeout(500);
            const ds = await downstreamSec(page);
            expect(ds === null, `DIM #${id} 无候选 → 下游引用段整体不渲染`, ds && ds.slice(0, 40));
            await closeDrawer(page);
        }

        // ===== N3 ODS 空态仍保留文案 =====
        console.log('N3. ODS 空态保留文案（与 DIM/DWD 区分）');
        await page.route('**/api/models/6/downstream', route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ table_name: 'ods_contract_df', candidates: [] })
        }));
        await openDrawerById(page, 6);
        await waitDownstreamSettled(page);
        const ds6 = await downstreamSec(page);
        expect(ds6 !== null && /未在平台配置中发现下游引用/.test(ds6 || ''), 'ODS 无候选 → 仍渲染段 + 空态文案（下线决策依据）', ds6 && ds6.slice(0, 50));
        expect(!/无下游依赖/.test(ds6 || ''), '禁写「无下游依赖」（沿用 C5 D5 约定）');
        await page.unroute('**/api/models/6/downstream');
        await closeDrawer(page);

        // ===== N4 mock 令 DIM 有候选 → 应出现 =====
        console.log('N4. DIM 有候选时正常出现（证明不是「DIM 永不查」）');
        await page.route('**/api/models/50/downstream', route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ table_name: 'dim_official_customer', candidates: [{ id: 52, table_name: 'dwd_x_df', table_comment: '假想下游', layer: 'dwd', status: 'ONLINE', config_mode: 'standard' }] })
        }));
        await openDrawerById(page, 50);
        await waitDownstreamSettled(page);
        const ds50 = await downstreamSec(page);
        expect(ds50 !== null && /dwd_x_df/.test(ds50 || ''), 'DIM 一旦有候选就渲染（hideWhenEmpty 只作用于空结果）', ds50 && ds50.slice(0, 50));
        await page.unroute('**/api/models/50/downstream');
        await closeDrawer(page);

        // ===== N5 字段复制内容 === 可见字段 =====
        console.log('N5. 字段复制内容与可见字段严格一致');
        await openDrawerById(page, 52);
        await page.waitForSelector('#modelDrawerBody .field-table tbody tr');
        const copyBtn = page.locator('#modelDrawerBody .field-copy').first();
        expect(await copyBtn.count() > 0, '字段清单出现「复制字段」按钮');
        const rowsBefore = await visibleRows(page);
        await copyBtn.click();
        await page.waitForTimeout(400);
        const clip1 = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        if (clip1 === null) {
            expect(true, '（本环境剪贴板不可读，跳过内容比对——按钮反馈态见 N7）');
        } else {
            // Windows 剪贴板会把 \n 规范化成 \r\n（粘进 Excel/SQL 正常），断言按 /\r?\n/ 切
            const lines = clip1.split(/\r?\n/).filter(Boolean);
            expect(lines.length === rowsBefore.length, `复制行数 === 可见行数（${lines.length} vs ${rowsBefore.length}）`, { lines: lines.length, rows: rowsBefore.length });
            const firstExpected = rowsBefore[0].type && rowsBefore[0].type !== '—'
                ? rowsBefore[0].name + '\t' + rowsBefore[0].type : rowsBefore[0].name;
            expect(lines[0] === firstExpected, '首行格式「名\\t类型」正确', { got: lines[0], want: firstExpected });
        }

        // ===== N6 搜索后复制跟着变 =====
        console.log('N6. 搜索过滤后复制的是所见而非全量');
        const search = page.locator('#modelDrawerBody .field-search').first();
        await search.fill('contract');
        await page.waitForTimeout(400);
        const rowsFiltered = await visibleRows(page);
        expect(rowsFiltered.length > 0 && rowsFiltered.length < rowsBefore.length, `过滤后可见行数减少（${rowsFiltered.length} < ${rowsBefore.length}）`, { filtered: rowsFiltered.length, all: rowsBefore.length });
        await copyBtn.click();
        await page.waitForTimeout(400);
        const clip2 = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        if (clip2 !== null) {
            const lines2 = clip2.split(/\r?\n/).filter(Boolean);
            expect(lines2.length === rowsFiltered.length, `复制行数跟随过滤（${lines2.length} vs ${rowsFiltered.length}）`, { copied: lines2.length, visible: rowsFiltered.length });
            const wantLines = rowsFiltered.map(r => (r.type && r.type !== '—') ? r.name + '	' + r.type : r.name);
            expect(JSON.stringify(lines2) === JSON.stringify(wantLines),
                '复制内容逐行 === 可见行（注：搜索可命中注释，故不能断言每行都含搜索词）',
                { copied: lines2.slice(0, 2), want: wantLines.slice(0, 2) });
        } else {
            expect(true, '（剪贴板不可读，跳过过滤后内容比对）');
        }
        await search.fill('');
        await page.waitForTimeout(300);

        // ===== N7 按钮反馈态 =====
        console.log('N7. 复制按钮反馈态');
        await copyBtn.click();
        await page.waitForTimeout(250); // copyToClipboard 返回 Promise，反馈态在 .then() 里才写
        const feedback = await page.evaluate(() => {
            const b = document.querySelector('#modelDrawerBody .field-copy');
            return b ? { text: b.textContent, disabled: b.disabled } : null;
        });
        expect(feedback && /已复制 \d+ 个字段/.test(feedback.text), '点击后显示「已复制 N 个字段」', feedback);
        // 审 19 M-2：不再 disabled——复制幂等、连点无害，禁用反而挡住「改搜索词后立刻再复制」
        expect(feedback && feedback.disabled === false, '反馈期间按钮仍可用（改了搜索词能立刻再复制）', feedback);
        await page.waitForTimeout(1900);
        const restored = await page.evaluate(() => {
            const b = document.querySelector('#modelDrawerBody .field-copy');
            return b ? { text: b.textContent, disabled: b.disabled } : null;
        });
        expect(restored && restored.text === '复制字段' && restored.disabled === false, '约 1.6s 后文案复原', restored);

        // 审 19 L：搜索无匹配时点复制要有反馈，不能「点了没反应」
        await search.fill('zzz_不存在的字段_zzz');
        await page.waitForTimeout(400);
        const emptyRows = await visibleRows(page);
        expect(emptyRows.length === 0, '构造出无匹配字段状态', emptyRows.length);
        await copyBtn.click();
        await page.waitForTimeout(250);
        const emptyFb = await page.evaluate(() => {
            const b = document.querySelector('#modelDrawerBody .field-copy');
            return b ? b.textContent : null;
        });
        expect(emptyFb === '无可复制字段', '无匹配时给明确反馈（非静默）', emptyFb);
        await search.fill('');
        await page.waitForTimeout(300);
        await closeDrawer(page);

        // ===== N8 ODS 字段表也有复制 =====
        console.log('N8. ODS 字段表同样支持复制');
        await openDrawerById(page, 6);
        await page.waitForFunction(() => { const h = document.getElementById('mdcOdsFieldHost'); return h && h.querySelector('.field-table tbody tr'); }, {}, { timeout: 30000 });
        const odsCopy = page.locator('#mdcOdsFieldHost .field-copy').first();
        expect(await odsCopy.count() > 0, 'ODS 字段表出现复制按钮');
        const odsRows = await visibleRows(page);
        await odsCopy.click();
        await page.waitForTimeout(400);
        const odsFeedback = await page.evaluate(() => {
            const b = document.querySelector('#mdcOdsFieldHost .field-copy');
            return b ? b.textContent : null;
        });
        expect(/已复制 \d+ 个字段/.test(odsFeedback || ''), 'ODS 复制反馈正常', odsFeedback);
        const clip3 = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        if (clip3 !== null) {
            expect(clip3.split(/\r?\n/).filter(Boolean).length === odsRows.length, 'ODS 复制行数 === 可见行数', { copied: clip3.split(/\r?\n/).filter(Boolean).length, visible: odsRows.length });
        } else {
            expect(true, '（剪贴板不可读，跳过 ODS 内容比对）');
        }
        await closeDrawer(page);

        // ===== N9 非安全上下文回退路径（生产 http://192.168.1.100:3000 走的**就是**这条）=====
        // 审 19 M-1/L-3：前面用例授予了 clipboard 权限、走的是 Clipboard API，恰好绕过了生产唯一可用的
        // execCommand 回退。这里强制屏蔽 navigator.clipboard + isSecureContext=false 复现生产条件。
        // 同时验证 M-1 的担心：临时 textarea 挂在 document.body，而 inert 只作用于 drawer 与
        // main.workbench-container（Model_Center.html:12660-12664），textarea 不在隔离范围内。
        console.log('N9. 非安全上下文 execCommand 回退路径');
        const page2 = await context.newPage();
        const p2Errors = [];
        page2.on('console', m => { if (m.type() === 'error') p2Errors.push(m.text()); });
        page2.on('pageerror', e => p2Errors.push('pageerror: ' + e.message));
        await page2.addInitScript(() => {
            Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true });
            Object.defineProperty(window, 'isSecureContext', { get: () => false, configurable: true });
            window.__copyEvents = 0;
            document.addEventListener('copy', () => { window.__copyEvents++; }, true);
        });
        // 与 page1 同 context、localStorage 已有 token —— 不能再走 login.html（已登录会自动跳转，
        // evaluate 期间上下文被销毁），直接进目标页
        await page2.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page2.waitForSelector('#modelListBody tr[data-id]');
        const ctxCheck = await page2.evaluate(() => ({ clip: typeof navigator.clipboard, secure: window.isSecureContext }));
        expect(ctxCheck.clip === 'undefined' && ctxCheck.secure === false, '已复现非安全上下文（clipboard 不可用）', ctxCheck);
        await page2.evaluate(() => openModelDrawer(52));
        await page2.waitForSelector('#modelDetailDrawer.open');
        await page2.waitForSelector('#modelDrawerBody .field-table tbody tr');
        // 抽屉 open 时 main 已被 inert —— 正是 M-1 担心的场景，此时点复制
        const mainInert = await page2.evaluate(() => { const m = document.querySelector('main.workbench-container'); return !!(m && m.inert); });
        expect(mainInert === true, '抽屉打开期间 main.workbench-container 处于 inert（M-1 担心的场景已复现）', mainInert);
        await page2.locator('#modelDrawerBody .field-copy').first().click();
        await page2.waitForTimeout(400);
        const fb2 = await page2.evaluate(() => {
            const b = document.querySelector('#modelDrawerBody .field-copy');
            return { text: b ? b.textContent : null, copyEvents: window.__copyEvents };
        });
        expect(/已复制 \d+ 个字段/.test(fb2.text || ''), 'execCommand 回退路径复制成功（生产 HTTP 环境可用）', fb2);
        expect(fb2.copyEvents >= 1, 'copy 事件被真实触发（textarea 未被 inert 挡住）', fb2.copyEvents);
        expect(p2Errors.length === 0, '回退路径 0 console error', p2Errors.slice(0, 3));
        await page2.close();

        console.log('C. console');
        expect(consoleErrors.length === 0, '全程 0 console error', consoleErrors.slice(0, 3));
    } catch (e) {
        console.error('\n脚本异常:', e.message);
        fail++;
    } finally {
        await browser.close();
    }

    console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
