/**
 * 模型中心 C6 · ODS 贴源三件套（来源系统 / 源表 / 表行数）Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c6-ods-source-playwright.js
 * 前置：本地 server 已启动 + 数仓连接可达（行数与 columns 同批真连数仓）
 * 覆盖：
 *   S1 ODS 抽屉 kv 区三行齐全：来源系统（code · 中文名）/ 源表（<code>）/ 表行数（千分位 + 近似值 title）
 *   S2 行数与后端 /metadata 返回的 rowCount 一致（不是前端瞎编）
 *   S3 metadata 失败态（500 mock）：行数占位落定为「—」，不留「查询中…」悬停
 *   S4 重试按钮：点击后行数回到「查询中…」再落定
 *   S5 非 ODS（DWD #52 / DIM #50）不渲染这三行（kind 分支正确）
 *   S6 贴源字段为空的 ODS：显示「—」而非空白/undefined
 *   全程 0 console error（500 mock 段内豁免网络层日志）
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
}
async function closeDrawer(page) {
    await page.evaluate(() => closeModelDrawer());
    await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
}
// kv 区按 key 取值（k/v 成对 append，取 k 的下一个兄弟）
async function kvValue(page, key) {
    return page.evaluate(k => {
        const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
        const hit = ks.find(el => el.textContent.trim() === k);
        return hit && hit.nextElementSibling ? hit.nextElementSibling.textContent.trim() : null;
    }, key);
}
async function kvTitle(page, key) {
    return page.evaluate(k => {
        const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
        const hit = ks.find(el => el.textContent.trim() === k);
        if (!hit || !hit.nextElementSibling) { return null; }
        const inner = hit.nextElementSibling.querySelector('[title]');
        return inner ? inner.getAttribute('title') : null;
    }, key);
}
async function waitRowCountSettled(page) {
    await page.waitForFunction(() => {
        const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
        const hit = ks.find(el => el.textContent.trim() === '表行数');
        return hit && hit.nextElementSibling && !/查询中/.test(hit.nextElementSibling.textContent);
    }, {}, { timeout: 30000 });
}

(async () => {
    console.log('=== 模型中心 C6 ODS 贴源三件套 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    let allowNetErr = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allowNetErr && /Failed to load resource.*(400|500|timeout|net::|Failed to fetch)/.test(m.text())) return;
        consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        // ===== S1 三行齐全 =====
        console.log('S1. ODS #6 贴源三件套渲染');
        await openDrawerById(page, 6);
        await waitRowCountSettled(page);

        const ss = await kvValue(page, '来源系统');
        expect(/^BMS( · .+)?$/.test(ss || ''), `来源系统显示 code（含中文名则更佳）：${ss}`, ss);
        expect((ss || '').includes(' · '), '来源系统含中文名（/api/source-systems 映射生效）', ss);

        const st = await kvValue(page, '源表');
        expect(st === 'biz_contract', '源表显示 source_table 原值', st);
        const stIsCode = await page.evaluate(() => {
            const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
            const hit = ks.find(el => el.textContent.trim() === '源表');
            return !!(hit && hit.nextElementSibling && hit.nextElementSibling.querySelector('code'));
        });
        expect(stIsCode, '源表用 <code> 呈现（等宽·与其他表名一致）');

        const rc = await kvValue(page, '表行数');
        expect(/^[\d,]+ 行$/.test(rc || ''), `表行数千分位格式：${rc}`, rc);
        const rcTitle = await kvTitle(page, '表行数');
        expect(/近似/.test(rcTitle || ''), '行数 title 注明近似值（不误导为精确值）', rcTitle);

        // ===== S2 行数与后端返回一致 =====
        console.log('S2. 行数与后端 /metadata 一致');
        const apiRowCount = await page.evaluate(async () => {
            const r = await authFetch('/api/models/6/metadata');
            const j = await r.json();
            return j && j.metadata ? j.metadata.rowCount : null;
        });
        const uiNum = Number(String(rc || '').replace(/[^\d]/g, ''));
        expect(apiRowCount !== null && apiRowCount !== undefined, `后端返回 rowCount（${apiRowCount}）`, apiRowCount);
        expect(uiNum === Number(apiRowCount), 'UI 行数 === 后端 rowCount', { ui: uiNum, api: apiRowCount });
        await closeDrawer(page);

        // ===== S3 失败态行数落定 =====
        console.log('S3. metadata 500 → 行数落定「—」');
        allowNetErr = true;
        await page.route('**/api/models/6/metadata', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
        await openDrawerById(page, 6);
        await page.waitForFunction(() => { const h = document.getElementById('mdcOdsFieldHost'); return h && h.querySelector('.mdc-error'); }, {}, { timeout: 15000 });
        await waitRowCountSettled(page);
        const rcFail = await kvValue(page, '表行数');
        expect(rcFail === '—', '失败态行数显示「—」（不留「查询中…」）', rcFail);
        const rcFailTitle = await kvTitle(page, '表行数');
        expect(/未取到/.test(rcFailTitle || ''), '失败态 title 说明未取到', rcFailTitle);

        // ===== S4 重试回到查询中再落定（含中间态捕获，审 12 双方 LOW）=====
        console.log('S4. 重试按钮重置行数占位');
        await page.unroute('**/api/models/6/metadata');
        // 让重试请求慢下来，才能稳定捕获「查询中…」中间态（否则可能一帧内就落定）
        await page.route('**/api/models/6/metadata', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
        const retryBtn = await page.$('#mdcOdsFieldHost button');
        expect(retryBtn !== null, '失败态存在重试按钮');
        if (retryBtn) {
            await retryBtn.click();
            // 中间态：文本回到「查询中…」+ title 清空 + className 复位 dim-note
            const mid = await page.waitForFunction(() => {
                const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
                const hit = ks.find(el => el.textContent.trim() === '表行数');
                if (!hit || !hit.nextElementSibling) { return null; }
                const span = hit.nextElementSibling.querySelector('span') || hit.nextElementSibling;
                return /查询中/.test(span.textContent) ? { title: span.title || '', cls: span.className || '' } : null;
            }, {}, { timeout: 10000 }).then(h => h.jsonValue()).catch(() => null);
            expect(mid !== null, '重试后捕获到「查询中…」中间态（占位真被重置）', mid);
            expect(mid && mid.title === '', '中间态 title 已清空', mid && mid.title);
            expect(mid && mid.cls === 'dim-note', '中间态 className 复位 dim-note', mid && mid.cls);
            await waitRowCountSettled(page);
            const rcRetry = await kvValue(page, '表行数');
            expect(/^[\d,]+ 行$/.test(rcRetry || ''), `重试后行数恢复真实值：${rcRetry}`, rcRetry);
        }
        await page.unroute('**/api/models/6/metadata');
        allowNetErr = false;
        await closeDrawer(page);

        // ===== S4b rowCount=0 → 「0 行」而非「—」（0 是 falsy，最易被误写）=====
        console.log('S4b. rowCount=0 显示「0 行」');
        await page.route('**/api/models/6/metadata', async (route) => {
            const resp = await route.fetch();
            const json = await resp.json();
            if (json && json.metadata) { json.metadata.rowCount = 0; }
            await route.fulfill({ response: resp, body: JSON.stringify(json) });
        });
        await openDrawerById(page, 6);
        await waitRowCountSettled(page);
        const rcZero = await kvValue(page, '表行数');
        expect(rcZero === '0 行', 'rowCount=0 → 「0 行」（空表 ≠ 未知）', rcZero);
        const zeroTitle = await kvTitle(page, '表行数');
        expect(/近似/.test(zeroTitle || ''), 'rowCount=0 仍用「近似值」title（非未取到）', zeroTitle);
        await page.unroute('**/api/models/6/metadata');
        await closeDrawer(page);

        // ===== S5 非 ODS 不渲染三行 =====
        console.log('S5. 非 ODS kind 不渲染贴源三行');
        for (const [id, label] of [[52, 'DWD #52'], [50, 'DIM #50']]) {
            await openDrawerById(page, id);
            await page.waitForFunction(() => document.querySelector('#modelDrawerBody .kv'), {}, { timeout: 15000 });
            const keys = await page.$$eval('#modelDrawerBody .kv .k', els => els.map(e => e.textContent.trim()));
            const leaked = ['来源系统', '源表', '表行数'].filter(k => keys.includes(k));
            expect(leaked.length === 0, `${label} 不出现贴源三行`, leaked);
            await closeDrawer(page);
        }

        // ===== S6 贴源字段为空 → 「—」 =====
        console.log('S6. 贴源字段为空的 ODS 显示「—」');
        // 用 route mock 把 #6 的模型详情改成 source_system/source_table 皆空（不动真实数据）
        await page.route('**/api/models/6', async (route) => {
            const resp = await route.fetch();
            const json = await resp.json();
            json.source_system = null;
            json.source_table = '';
            await route.fulfill({ response: resp, body: JSON.stringify(json) });
        });
        await openDrawerById(page, 6);
        await page.waitForFunction(() => document.querySelector('#modelDrawerBody .kv'), {}, { timeout: 15000 });
        const ssEmpty = await kvValue(page, '来源系统');
        const stEmpty = await kvValue(page, '源表');
        expect(ssEmpty === '—', '来源系统空 → 「—」', ssEmpty);
        expect(stEmpty === '—', '源表空 → 「—」', stEmpty);
        await page.unroute('**/api/models/6');
        await closeDrawer(page);

        // ===== S7 来源系统中文名懒补（审 12 M-3：grok/gpt 双方最高优先）=====
        // 模拟「页面初始化时 /api/source-systems 失败 → 缓存永久为空」，验证打开 ODS 抽屉时能懒补回来
        console.log('S7. 来源系统缓存为空时懒补中文名');
        allowNetErr = true;
        let ssHits = 0;
        await page.route('**/api/source-systems', route => { ssHits++; route.continue(); });
        await page.evaluate(() => { MDC_SOURCE_SYSTEM_NAMES = {}; MDC_SOURCE_SYSTEM_LOADED = false; }); // 复现失败后的缓存状态
        ssHits = 0;
        await openDrawerById(page, 6);
        await page.waitForFunction(() => {
            const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
            const hit = ks.find(el => el.textContent.trim() === '来源系统');
            return hit && hit.nextElementSibling && / · /.test(hit.nextElementSibling.textContent);
        }, {}, { timeout: 10000 }).catch(() => {});
        const ssLazy = await kvValue(page, '来源系统');
        expect(/^BMS · .+$/.test(ssLazy || ''), `缓存为空时懒补出中文名：${ssLazy}`, ssLazy);
        expect(ssHits >= 1, '懒补真的重发了 /api/source-systems', ssHits);
        await closeDrawer(page);

        // 缓存已就绪后再开抽屉，不应再重复请求（LOADED 标志生效）
        ssHits = 0;
        await openDrawerById(page, 6);
        await page.waitForTimeout(600);
        expect(ssHits === 0, '缓存就绪后不重复请求 source-systems', ssHits);
        await closeDrawer(page);
        await page.unroute('**/api/source-systems');
        allowNetErr = false;

        // ===== console =====
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
