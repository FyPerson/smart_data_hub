/**
 * 模型中心 C3 · 详情抽屉外壳 + 请求生命周期 + 焦点管理 Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c3-drawer-playwright.js
 * 前置：本地 server 已启动（默认 localhost:3000，TEST_BASE_URL 可覆盖）
 *
 * 规格：模型详情抽屉方案 v1.4 §5.3（双层 controller/门禁/abortReason）+ §5.5（焦点/inert/Esc）+ D2（button 点击区）
 * 覆盖：
 *   D1 表名按钮打开抽屉：identity 渲染（#id/表名/状态）+ 标题=表名
 *   D2 描述列按钮同样打开；design_notes 图标 stopPropagation 不误开（若样本有）
 *   D3 焦点：打开后焦点=关闭按钮；抽屉 open 时 main inert、抽屉非 inert；关闭后反转 + 焦点回触发按钮
 *   D4 Esc 关闭；overlay 点击关闭
 *   D5 快速 A→B 切换：A 慢返回（route 延迟）仍显示 B（门禁丢弃迟到响应）
 *   D6 关闭中止：慢响应在关闭后到达不落 DOM（迟到响应一律丢弃）
 *   D7 404 → 「模型不存在」+ 重试按钮；重试后正常渲染（新 requestAborter + 门禁重过）
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

(async () => {
    console.log('=== 模型中心 C3 详情抽屉 Playwright 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];

    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    // D7 段内豁免：404 mock 会让浏览器打一条网络层 resource 日志（页面代码处理正常，属预期噪音）。
    // 对齐 test-corr-upload-preview allow409 先例：豁免仅在标志开启的用例段内生效，防掩盖其他意外 404。
    let allow404 = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allow404 && /Failed to load resource.*404/.test(m.text())) return;
        consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        // ===== D1 表名按钮打开 =====
        console.log('D1. 表名按钮打开抽屉');
        // C4：identity #id 移到 header sub（tableComment · #id）；正文 .kv 承载技术负责人/更新周期等
        // 精确断言用 sub 的 #id\b（C3 审 M-5：避免 #1 被 #12 前缀误包含）
        const subHasId = (page, id) => page.$eval('#modelDrawerSub', (e, id) => new RegExp('#' + id + '(?!\\d)').test(e.textContent), id);
        const firstBtn = page.locator('#modelListBody tr[data-id] td:nth-child(3) .model-open-btn').first();
        const firstRowId = await page.$eval('#modelListBody tr[data-id]', r => Number(r.dataset.id));
        await firstBtn.click();
        await page.waitForSelector('#modelDetailDrawer.open');
        await page.waitForFunction(id => { const s = document.getElementById('modelDrawerSub'); return s && new RegExp('#' + id + '(?!\\d)').test(s.textContent); }, firstRowId);
        expect(await subHasId(page, firstRowId), `header sub 含 #${firstRowId}`);
        const title = await page.$eval('#modelDrawerTitle', e => e.textContent);
        expect(title.length > 0 && title !== '模型详情', '标题=表名', title);
        const kvText = await page.$eval('#modelDrawerBody .kv', e => e.textContent);
        expect(kvText.includes('技术负责人'), 'identity kv 含技术负责人行', kvText.slice(0, 80));

        // ===== D3 焦点/inert（open 态）=====
        console.log('D3. 焦点与 inert');
        const inertState = await page.evaluate(() => ({
            drawerInert: document.getElementById('modelDetailDrawer').inert,
            mainInert: document.querySelector('main.workbench-container').inert,
            ariaHidden: document.getElementById('modelDetailDrawer').getAttribute('aria-hidden')
        }));
        expect(inertState.drawerInert === false, 'open 态抽屉非 inert', inertState);
        expect(inertState.mainInert === true, 'open 态 main inert（背景隔离）', inertState);
        expect(inertState.ariaHidden === null, 'open 态无 aria-hidden', inertState);
        const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
        expect(focused === 'modelDrawerCloseBtn', '打开后焦点=关闭按钮', focused);

        // ===== D4 Esc 关闭 + 焦点恢复 =====
        console.log('D4. Esc/overlay 关闭');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        const closedState = await page.evaluate(() => ({
            drawerInert: document.getElementById('modelDetailDrawer').inert,
            mainInert: document.querySelector('main.workbench-container').inert,
            focusedIsOpenBtn: document.activeElement && document.activeElement.classList.contains('model-open-btn')
        }));
        expect(closedState.drawerInert === true, '关闭后抽屉 inert', closedState);
        expect(closedState.mainInert === false, '关闭后 main 恢复', closedState);
        expect(closedState.focusedIsOpenBtn === true, '关闭后焦点回触发按钮', closedState);

        // overlay 点击关闭
        await firstBtn.click();
        await page.waitForSelector('#modelDetailDrawer.open');
        await page.evaluate(() => document.getElementById('modelDrawerOverlay').click());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        expect(true, 'overlay 点击关闭生效');

        // ===== D2 描述列按钮 =====
        console.log('D2. 描述列按钮');
        const commentBtn = page.locator('#modelListBody tr[data-id] td:nth-child(4) .model-open-btn').first();
        await commentBtn.click();
        await page.waitForSelector('#modelDetailDrawer.open');
        await page.waitForFunction(() => document.querySelector('#modelDrawerBody .kv') !== null);
        expect(true, '描述列按钮打开抽屉');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));

        // ===== D5 快速 A→B 切换（A 慢返回仍显示 B）=====
        // 抽屉 open 后 overlay 挡住列表（用户不可能点列表按钮）——真实切换路径=抽屉内导航（C5 下游引用/
        // 主模型链接跳转，§5.3 push）或关闭重开；此处用 evaluate 直调 openModelDrawer 模拟 push 路径
        console.log('D5. 快速切换竞态');
        const ids = await page.$$eval('#modelListBody tr[data-id]', rows => rows.slice(0, 2).map(r => Number(r.dataset.id)));
        const [idA, idB] = ids;
        await page.route(`**/api/models/${idA}`, async route => {
            await new Promise(r => setTimeout(r, 1500)); // A 慢 1.5s
            await route.continue();
        });
        const btnA = page.locator(`#modelListBody tr[data-id="${idA}"] .model-open-btn`).first();
        await btnA.click();          // 打开 A（慢）
        await page.waitForTimeout(150);
        await page.evaluate(id => openModelDrawer(id), idB); // 立即切 B（导航层重建 ctx，旧 ctx abort）
        await page.waitForFunction(id => { const s = document.getElementById('modelDrawerSub'); return s && new RegExp('#' + id + '(?!\\d)').test(s.textContent); }, idB);
        await page.waitForTimeout(1800); // 等 A 的慢响应到达并被丢弃
        expect(await subHasId(page, idB), `竞态后显示 B(#${idB})`);
        expect(!(await subHasId(page, idA)), 'A 的迟到响应未覆盖 B（sub 精确 #idA 匹配·C3 审 M-5）');
        await page.unroute(`**/api/models/${idA}`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));

        // ===== D6 关闭中止（迟到响应不落 DOM）=====
        console.log('D6. 关闭中止');
        await page.route(`**/api/models/${idA}`, async route => {
            await new Promise(r => setTimeout(r, 1200));
            await route.continue();
        });
        await btnA.click();
        await page.waitForSelector('#modelDetailDrawer.open');
        await page.keyboard.press('Escape'); // 响应未到即关闭
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        await page.waitForTimeout(1600);     // 等迟到响应
        const bodyAfterClose = await page.$eval('#modelDrawerBody', e => e.textContent);
        expect(!bodyAfterClose.includes('#' + idA), '迟到响应未落 DOM（body 无 identity）', bodyAfterClose.slice(0, 60));
        await page.unroute(`**/api/models/${idA}`);

        // ===== D7 404 + 重试 =====
        console.log('D7. 404 与重试');
        allow404 = true;
        let mock404 = true;
        await page.route(`**/api/models/${idA}`, async route => {
            if (mock404) { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: '模型不存在' }) }); }
            else { await route.continue(); }
        });
        await btnA.click();
        await page.waitForFunction(() => document.querySelector('#modelDrawerBody .mdc-error') !== null);
        const errText = await page.$eval('#modelDrawerBody .mdc-error', e => e.textContent);
        expect(errText.includes('模型不存在'), '404 渲染「模型不存在」', errText);
        const retryBtn = page.locator('#modelDrawerBody button:has-text("重试")');
        expect(await retryBtn.count() === 1, '错误态带重试按钮');
        mock404 = false;
        await retryBtn.click();
        await page.waitForFunction(id => { const s = document.getElementById('modelDrawerSub'); return s && new RegExp('#' + id + '(?!\d)').test(s.textContent); }, idA);
        expect(await subHasId(page, idA), '重试后正常渲染（新 requestAborter+门禁重过）');
        await page.unroute(`**/api/models/${idA}`);
        allow404 = false;
        await page.keyboard.press('Escape');

        // ===== console =====
        console.log('C. console');
        expect(consoleErrors.length === 0, '全程 0 console error', consoleErrors.slice(0, 5));
    } catch (e) {
        console.error('测试异常:', e);
        fail++;
    } finally {
        await browser.close();
    }

    console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
