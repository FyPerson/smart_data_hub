/**
 * 前端统一 #12 · 吸顶操作栏 Playwright 行为实测
 *
 * 用法：node scripts/test-unify12-sticky-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 覆盖：
 *   P1 computed style 生效（缓存串 bump 后新 CSS 真加载）：
 *      - Data_Collab / Data_Correction / Issue_Lite：u-drawer-body 内挂类元素 position=sticky + top=-20px
 *      - Sys_Iteration：si-drawer-body 内挂类元素 top=-18px（页内条件覆盖压过共享 -20px）
 *   P2 真滚动吸顶（Data_Collab）：detailBody 注入长内容+action-bar，滚动后 bar 的
 *      getBoundingClientRect().top 稳定贴容器顶（sticky 生效），且滚回顶部后复位
 *   全程 0 console error
 */
'use strict';

const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = fx.BASE;

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

async function openPage(browser, token, pagePath, consoleErrors) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${pagePath}: ${m.text()}`); });
    page.on('pageerror', e => consoleErrors.push(`${pagePath} pageerror: ${e.message}`));
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/${pagePath}`, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    return { context, page };
}

// 在指定容器内插入挂类探针元素，返回 computed {position, top, beforeTop, beforeHeight}
async function probeComputed(page, containerSelector) {
    return page.evaluate((sel) => {
        const host = document.querySelector(sel);
        if (!host) return { error: `container ${sel} not found` };
        const el = document.createElement('div');
        el.className = 'u-action-bar u-action-bar-sticky';
        el.textContent = 'x'; // 非空避开 :empty 隐藏
        host.appendChild(el);
        const cs = getComputedStyle(el);
        const csb = getComputedStyle(el, '::before');
        const out = { position: cs.position, top: cs.top, beforeTop: csb.top, beforeHeight: csb.height };
        el.remove();
        return out;
    }, containerSelector);
}

(async () => {
    console.log('=== 前端统一 #12 吸顶操作栏 Playwright 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const adminToken = await fx.signAs(fx.ADMIN_ID);

    try {
        // ===== P1 computed style 四页 =====
        console.log('P1. computed style（新 CSS 经 bump 后的缓存串真实加载）');
        const shared = [
            ['Data_Collab.html', '#detailBody', '-20px'],
            ['Data_Correction.html', '#drawerBody', '-20px'],
            ['Issue_Lite.html', '#drawerBody', '-20px'],
        ];
        for (const [pagePath, sel, expectBefore] of shared) {
            const { context, page } = await openPage(browser, adminToken, pagePath, consoleErrors);
            const r = await probeComputed(page, sel);
            expect(!r.error && r.position === 'sticky', `${pagePath}：position=sticky（实际 ${r.error || r.position}）`);
            expect(r.top === '0px', `${pagePath}：top=0（零位移·实际 ${r.top}）`);
            expect(r.beforeTop === expectBefore, `${pagePath}：::before 遮布 top=${expectBefore}（实际 ${r.beforeTop}）`);
            await context.close();
        }
        {
            const { context, page } = await openPage(browser, adminToken, 'Sys_Iteration.html', consoleErrors);
            const r = await probeComputed(page, '#siDBody');
            expect(!r.error && r.position === 'sticky', `Sys_Iteration.html：position=sticky（实际 ${r.error || r.position}）`);
            expect(r.top === '0px', `Sys_Iteration.html：top=0（零位移·实际 ${r.top}）`);
            expect(r.beforeTop === '-18px' && r.beforeHeight === '18px', `Sys_Iteration.html：::before 遮布 -18px/18px 页内覆盖生效（实际 ${r.beforeTop}/${r.beforeHeight}）`);
            await context.close();
        }

        // ===== P2 真滚动吸顶（Data_Collab detailBody）=====
        console.log('\nP2. 真滚动吸顶（Data_Collab 注入长内容）');
        {
            const { context, page } = await openPage(browser, adminToken, 'Data_Collab.html', consoleErrors);
            const r = await page.evaluate(() => {
                const drawer = document.getElementById('detailDrawer');
                const body = document.getElementById('detailBody');
                if (!drawer || !body) return { error: 'drawer/body not found' };
                // 手动开抽屉（绕过 openDetail 的数据依赖；仅测布局，不触业务逻辑）
                drawer.classList.add('open');
                drawer.removeAttribute('inert');
                drawer.setAttribute('aria-hidden', 'false');
                document.getElementById('detailDrawerOverlay')?.classList.add('open');
                body.innerHTML = '<div class="u-action-bar u-action-bar-sticky" id="_stickyProbe">'
                    + '<button class="btn">探针按钮</button></div>'
                    + '<div style="height:3000px;background:linear-gradient(#fff,#eee);">长内容</div>';
                const bar = document.getElementById('_stickyProbe');
                const bodyTop = body.getBoundingClientRect().top;
                const beforeTop = bar.getBoundingClientRect().top;
                body.scrollTop = 800;
                const afterTop = bar.getBoundingClientRect().top;
                body.scrollTop = 1600;
                const afterTop2 = bar.getBoundingClientRect().top;
                body.scrollTop = 0;
                const resetTop = bar.getBoundingClientRect().top;
                return { bodyTop, beforeTop, afterTop, afterTop2, resetTop };
            });
            expect(!r.error, `抽屉/容器就绪（${r.error || 'ok'}）`);
            if (!r.error) {
                // top:0 零位移（用户实测修正）：初始位置即吸附阈值，任意滚动量 bar 完全钉死不动
                expect(Math.abs(r.beforeTop - (r.bodyTop + 20)) <= 1, `未滚动时 bar 在内容顶（bodyTop+20≈${(r.bodyTop + 20).toFixed(1)}，实际 ${r.beforeTop.toFixed(1)}）`);
                expect(Math.abs(r.afterTop - r.beforeTop) <= 1, `滚动 800 后 bar 完全不动（零位移·${r.beforeTop.toFixed(1)}，实际 ${r.afterTop.toFixed(1)}）`);
                expect(Math.abs(r.afterTop2 - r.beforeTop) <= 1, `继续滚动 bar 仍不动（实际 ${r.afterTop2.toFixed(1)}）`);
                expect(Math.abs(r.resetTop - r.beforeTop) <= 1, `滚回顶部 bar 位置不变（实际 ${r.resetTop.toFixed(1)}）`);
            }

            // C4 inert 回归：走真实 closeDetailModal()（syncDrawerInert 链路），断言关闭后 inert/aria-hidden 恢复
            const c = await page.evaluate(() => {
                if (typeof closeDetailModal !== 'function') return { error: 'closeDetailModal not found' };
                closeDetailModal();
                const drawer = document.getElementById('detailDrawer');
                return {
                    hasOpen: drawer.classList.contains('open'),
                    inert: drawer.hasAttribute('inert'),
                    ariaHidden: drawer.getAttribute('aria-hidden'),
                };
            });
            expect(!c.error && !c.hasOpen, `closeDetailModal 后抽屉关闭（${c.error || 'open=' + c.hasOpen}）`);
            expect(c.inert === true, `关闭后 inert 恢复（C4 焦点管理回归，实际 ${c.inert}）`);
            expect(c.ariaHidden === 'true', `关闭后 aria-hidden=true（实际 ${c.ariaHidden}）`);

            // codex #12 审 L-3：footer 删除后关闭入口=header × + 遮罩，须真实点击验证（非直接调函数）
            // 复用当前 page：重新手动开抽屉 → 点 header × → 断言关闭；再开 → 点遮罩 → 断言关闭
            const reopen = () => page.evaluate(() => {
                const drawer = document.getElementById('detailDrawer');
                drawer.classList.add('open');
                drawer.removeAttribute('inert');
                drawer.setAttribute('aria-hidden', 'false');
                document.getElementById('detailDrawerOverlay')?.classList.add('open');
            });
            await reopen();
            await page.click('#detailDrawer .u-drawer-close');
            const afterX = await page.evaluate(() => document.getElementById('detailDrawer').classList.contains('open'));
            expect(afterX === false, '真实点击 header × 关闭抽屉');
            await reopen();
            await page.click('#detailDrawerOverlay', { position: { x: 10, y: 300 } });
            const afterOverlay = await page.evaluate(() => document.getElementById('detailDrawer').classList.contains('open'));
            expect(afterOverlay === false, '真实点击遮罩关闭抽屉');

            // L-1 兜底回归：空 action-bar（:empty）不显示，不产生吸顶白条
            const emptyBar = await page.evaluate(() => {
                const body = document.getElementById('detailBody');
                body.innerHTML = '<div class="u-action-bar u-action-bar-sticky" id="_emptyProbe"></div><div style="height:100px;">内容</div>';
                const cs = getComputedStyle(document.getElementById('_emptyProbe'));
                return cs.display;
            });
            expect(emptyBar === 'none', `空操作栏 :empty 隐藏（codex L-1，实际 display=${emptyBar}）`);
            await context.close();
        }

        // ===== console 健康 =====
        console.log('\nP3. console 健康');
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? '：' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);
    } finally {
        await browser.close();
    }

    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
