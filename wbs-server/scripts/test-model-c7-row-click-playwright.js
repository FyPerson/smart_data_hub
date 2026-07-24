/**
 * 模型中心 C7 · 整行点击打开详情抽屉 Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c7-row-click-playwright.js
 * 前置：本地 server 已启动
 * 覆盖：
 *   R1 点行内非交互区（更新周期/负责人/时间列）→ 打开抽屉且 ID 对应该行
 *   R2 点操作按钮（历史）→ **不**打开抽屉（否则点「删除」会连带弹详情）
 *   R3 点描述列的「设计说明」图标 → 不打开抽屉
 *   R4 表名列 / 描述列按钮原路径不回归
 *   R5 §5.5 焦点归还：整行点击打开 → 关闭 → 焦点落在该行的 .model-open-btn
 *   R6 拖选文本后松开鼠标 → 不打开抽屉（复制表名/负责人不被打断）
 *   R7 既有选中高亮（.selected-row）行为不被破坏
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

const drawerOpen = (page) => page.evaluate(() => document.getElementById('modelDetailDrawer').classList.contains('open'));
const drawerModelId = (page) => page.evaluate(() => {
    const s = document.getElementById('modelDrawerSub');
    const m = s && s.textContent.match(/#(\d+)/);
    return m ? Number(m[1]) : null;
});
// 清掉本脚本操作可能弹出的各类浮层（编辑/验收弹窗、下拉菜单），避免拦截后续点击
async function closeAllOverlays(page) {
    await page.evaluate(() => {
        document.querySelectorAll('.modal').forEach(m => { if (getComputedStyle(m).display !== 'none') { m.style.display = 'none'; } });
        document.querySelectorAll('.dim-edit-menu, .dim-validate-menu').forEach(m => { m.style.display = 'none'; });
        document.querySelectorAll('.design-notes-popover').forEach(e => e.remove());
    });
}
async function closeIfOpen(page) {
    if (await drawerOpen(page)) {
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
    }
}

(async () => {
    console.log('=== 模型中心 C7 整行点击 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1700, height: 950 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        const firstRow = page.locator('#modelListBody tr[data-id]').first();
        const rowId = Number(await firstRow.getAttribute('data-id'));
        expect(Number.isInteger(rowId) && rowId > 0, `首行 data-id 可用（#${rowId}）`, rowId);

        // ===== R1 点非交互区打开 =====
        console.log('R1. 点行内非交互区打开抽屉');
        // 第 7 列 = 更新周期（纯 badge 文本，无按钮）
        await firstRow.locator('td').nth(6).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        expect(await drawerOpen(page), '点更新周期列 → 抽屉打开');
        expect(await drawerModelId(page) === rowId, '抽屉打开的是该行模型', { want: rowId, got: await drawerModelId(page) });
        await closeIfOpen(page);

        // 技术负责人列（含 svg 图标，验证 svg 不干扰 closest 判定）
        await firstRow.locator('td').nth(4).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        expect(await drawerOpen(page), '点技术负责人列（含 svg）→ 抽屉打开');
        await closeIfOpen(page);

        // ===== R2 点操作按钮不打开 =====
        console.log('R2. 点操作按钮不打开抽屉');
        const historyBtn = firstRow.locator('button', { hasText: '历史' }).first();
        const hasHistory = await historyBtn.count() > 0;
        expect(hasHistory, '首行存在「历史」按钮（admin 视角）');
        if (hasHistory) {
            await historyBtn.click();
            await page.waitForTimeout(800);
            expect(!(await drawerOpen(page)), '点「历史」按钮 → 抽屉未打开（否则点删除会连带弹详情）');
            // 清理它弹出的变更历史浮层
            await page.evaluate(() => { const m = document.getElementById('changeLogsModal'); if (m) m.remove(); });
        }

        // ===== R2b 操作列缝隙/padding 不打开（审 15 M：整列排除 .model-row-actions）=====
        console.log('R2b. 操作列按钮缝隙与 padding 不打开抽屉');
        const actionsTd = firstRow.locator('td.model-row-actions');
        expect(await actionsTd.count() > 0, '操作列已带 .model-row-actions 标记');
        if (await actionsTd.count() > 0) {
            const ab = await actionsTd.boundingBox();
            // td 顶部 padding 区（按钮上方）——最容易误点的整片区域
            await page.mouse.click(ab.x + ab.width / 2, ab.y + 3);
            await page.waitForTimeout(500);
            expect(!(await drawerOpen(page)), '点操作列 td padding → 抽屉未打开');
            // 两个按钮之间的 4px gap
            const btns = firstRow.locator('td.model-row-actions button');
            if (await btns.count() >= 2) {
                const b1 = await btns.nth(0).boundingBox();
                const b2 = await btns.nth(1).boundingBox();
                const gapX = (b1.x + b1.width + b2.x) / 2;
                await page.mouse.click(gapX, b1.y + b1.height / 2);
                await page.waitForTimeout(500);
                expect(!(await drawerOpen(page)), '点操作按钮之间的 gap → 抽屉未打开');
            }
            await closeAllOverlays(page);
        }
        await closeIfOpen(page);

        // ===== R3 设计说明图标不打开 =====
        console.log('R3. 点「设计说明」图标不打开抽屉');
        const noteBtn = page.locator('#modelListBody button[title="查看设计说明"]').first();
        if (await noteBtn.count() > 0) {
            await noteBtn.click();
            await page.waitForTimeout(600);
            expect(!(await drawerOpen(page)), '点设计说明图标 → 抽屉未打开');
            await page.keyboard.press('Escape');
            await page.evaluate(() => { document.querySelectorAll('.design-notes-popover').forEach(e => e.remove()); });
        } else {
            expect(true, '（本页无设计说明图标，跳过）');
        }
        await closeIfOpen(page);

        // ===== R4 原按钮路径不回归 =====
        console.log('R4. 表名/描述列按钮原路径');
        await firstRow.locator('.model-open-btn').first().click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        expect(await drawerModelId(page) === rowId, '点表名按钮仍打开对应抽屉');
        await closeIfOpen(page);

        // ===== R5 焦点归还 =====
        console.log('R5. 整行点击后关闭 → 焦点归还打开按钮');
        await firstRow.locator('td').nth(6).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        const focusInfo = await page.evaluate((id) => {
            const el = document.activeElement;
            const row = document.querySelector(`#modelListBody tr[data-id="${id}"]`);
            const target = row ? row.querySelector('.model-open-btn') : null;
            return { isOpenBtn: !!el && el === target, cls: el ? el.className : null };
        }, rowId);
        expect(focusInfo.isOpenBtn, '焦点归还到该行 .model-open-btn（tr 不可聚焦，需代理）', focusInfo);

        // ===== R6 拖选文本不打开 =====
        console.log('R6. 拖选文本后松开不打开抽屉');
        const ownerCell = firstRow.locator('td').nth(4);
        const box = await ownerCell.boundingBox();
        if (box) {
            await page.mouse.move(box.x + 6, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 8 });
            await page.mouse.up();
            await page.waitForTimeout(500);
            const selText = await page.evaluate(() => (window.getSelection() || '').toString().trim());
            const opened = await drawerOpen(page);
            if (selText) {
                expect(!opened, `拖出选区「${selText.slice(0, 12)}」→ 抽屉未打开`, { selText, opened });
            } else {
                // 该单元格文本过短选不中时不误判为通过
                expect(true, '（未形成选区，本环境跳过该断言）');
            }
            await page.evaluate(() => { const s = window.getSelection(); if (s) s.removeAllRanges(); });
        }
        await closeIfOpen(page);

        // ===== R7 选中高亮仍在 =====
        console.log('R7. 既有 .selected-row 高亮不被破坏');
        await firstRow.locator('td').nth(6).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        const highlighted = await page.evaluate((id) => {
            const row = document.querySelector(`#modelListBody tr[data-id="${id}"]`);
            return !!row && row.classList.contains('selected-row');
        }, rowId);
        expect(highlighted, '点击行同时保留选中高亮（原有行为）');
        await closeIfOpen(page);

        // ===== R8 下拉菜单子项不双开（审 13 HIGH：菜单项是裸 div，closest('button') 抓不到）=====
        console.log('R8. 编辑/验收下拉子项不双开抽屉');
        const dimRow = page.locator('#modelListBody tr[data-id]').filter({ has: page.locator('.dim-edit-dropdown') }).first();
        if (await dimRow.count() > 0) {
            const dimRowId = await dimRow.getAttribute('data-id');
            await dimRow.locator('.dim-edit-dropdown button').first().click();
            await page.waitForFunction(() => {
                const m = document.querySelector('.dim-edit-menu');
                return m && getComputedStyle(m).display !== 'none';
            }, {}, { timeout: 5000 });
            expect(true, `找到带编辑下拉的行（#${dimRowId}）并展开菜单`);
            // 点菜单空白区（padding）——既非 button 也非菜单项，最易漏
            const menu = dimRow.locator('.dim-edit-menu');
            const mb = await menu.boundingBox();
            if (mb) {
                await page.mouse.click(mb.x + mb.width - 4, mb.y + 2);
                await page.waitForTimeout(500);
                expect(!(await drawerOpen(page)), '点编辑菜单空白区 → 抽屉未打开');
            }
            // 点空白区可能已被外部点击监听关掉菜单 → 重新展开再点菜单项
            const menuVisible = await dimRow.locator('.dim-edit-menu').isVisible().catch(() => false);
            if (!menuVisible) {
                await dimRow.locator('.dim-edit-dropdown button').first().click();
                await page.waitForFunction(() => {
                    const m = document.querySelector('.dim-edit-menu');
                    return m && getComputedStyle(m).display !== 'none';
                }, {}, { timeout: 5000 });
            }
            // 点真正的菜单项 → 应打开编辑弹窗，但**不**打开抽屉
            const item = dimRow.locator('.dim-edit-menu > div').first();
            if (await item.count() > 0) {
                await item.click();
                await page.waitForTimeout(900);
                expect(!(await drawerOpen(page)), '点编辑菜单项 → 抽屉未打开（HIGH 场景：不与编辑弹窗双开）');
                // 关掉被打开的编辑弹窗，避免污染后续断言
                await page.keyboard.press('Escape');
                await page.evaluate(() => {
                    document.querySelectorAll('.modal').forEach(m => { if (getComputedStyle(m).display !== 'none') m.style.display = 'none'; });
                    document.querySelectorAll('.dim-edit-menu').forEach(m => m.style.display = 'none');
                });
            }
        } else {
            // 审 14 M-1：不得软跳过——缺 DIM/DWD 数据时 HIGH 回归测不到却显示全绿
            expect(false, '未找到带 .dim-edit-dropdown 的行 → HIGH 回归无法验证（需保证列表含至少 1 条可编辑 DIM/DWD）');
        }
        await closeIfOpen(page);

        // 验收下拉（本就带 stopPropagation，容器级排除后应双保险）
        const valRow = page.locator('#modelListBody tr[data-id]').filter({ has: page.locator('.dim-validate-dropdown') }).first();
        if (await valRow.count() > 0) {
            await valRow.locator('.dim-validate-dropdown button').first().click();
            await page.waitForTimeout(400);
            const vMenu = valRow.locator('.dim-validate-menu');
            const vb = await vMenu.boundingBox();
            if (vb) {
                await page.mouse.click(vb.x + vb.width - 4, vb.y + 2);
                await page.waitForTimeout(400);
                expect(!(await drawerOpen(page)), '点验收菜单空白区 → 抽屉未打开');
            }
        } else {
            expect(false, '未找到带 .dim-validate-dropdown 的行 → 验收路径回归无法验证（同 R8 策略：不软跳过）');
        }
        await closeAllOverlays(page); // 空白区点击可能命中菜单项弹出验收弹窗，统一清干净再往下
        await closeIfOpen(page);

        // ===== R9 残留选区不应误挡（审 13 M-2 反向验证）=====
        // codex 担心「先在别处留选区 → 再单击行」被全局选区守卫误挡成「点了没反应」。
        // 实测浏览器行为：mousedown 会先清掉旧选区，故 click 时选区已折叠、不应误挡。
        console.log('R9. 别处残留选区不误挡行点击');
        // 用 Range API 构造选区（比拖拽更严格：保证 click 前选区确实存在且非折叠）
        const leftover = await page.evaluate(() => {
            const host = Array.from(document.querySelectorAll('h1, h2, h3, label, .card-title'))
                .find(el => (el.textContent || '').trim().length > 1);
            if (!host) { return null; }
            const r = document.createRange();
            r.selectNodeContents(host);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
            return s.toString().trim();
        });
        expect(!!leftover, `在行外构造残留选区「${(leftover || '').slice(0, 12)}」`, leftover);
        if (leftover) {
            // 不主动清选区，直接单击行的非交互列
            await firstRow.locator('td').nth(6).click();
            await page.waitForTimeout(700);
            expect(await drawerOpen(page), '残留选区存在时单击行仍能打开（mousedown 已清旧选区，守卫不误挡）');
            await closeIfOpen(page);
        }

        // ===== R10 迭代徽章不双开（审 14 新 HIGH：原为裸 span·已改 button）=====
        console.log('R10. 迭代徽章（vN）不打开抽屉');
        const badgeRow = page.locator('#modelListBody tr[data-id]').filter({ has: page.locator('[title="点击查看迭代历史"]') }).first();
        if (await badgeRow.count() > 0) {
            const badge = badgeRow.locator('[title="点击查看迭代历史"]').first();
            const tagName = await badge.evaluate(el => el.tagName);
            expect(tagName === 'BUTTON', '迭代徽章已是 <button>（自动进 button 排除 + 键盘可达）', tagName);
            await badge.click();
            await page.waitForTimeout(900);
            expect(!(await drawerOpen(page)), '点迭代徽章 → 抽屉未打开（不与迭代历史浮层双开）');
            // 审 15 L：只断言「没开抽屉」不够——onclick 若失效会「双关」也算绿。必须证明本职功能仍在。
            const iterOpened = await page.evaluate(() => {
                const m = document.getElementById('iterationHistoryModal');
                return !!m && getComputedStyle(m).display !== 'none';
            });
            expect(iterOpened, '点迭代徽章 → 迭代历史浮层确实打开（排除「双关」假通过）', iterOpened);
            await closeAllOverlays(page);
            await page.evaluate(() => { const m = document.getElementById('iterationHistoryModal'); if (m) m.remove(); });
        } else {
            // 同 R8：不软跳过，缺数据即视为回归不可验证
            expect(false, '未找到带迭代徽章(vN)的行 → 新 HIGH 回归无法验证（需保证有 archived_task_count>0 的模型）');
        }
        await closeIfOpen(page);

        // ===== R5b 列表重渲染后焦点兜底（审 14 M-2）=====
        console.log('R5b. 重渲染替换 opener 后焦点仍归还');
        // 先抓住打开前那个按钮的 DOM 句柄（mdcCtx 是模块作用域 let、不挂 window，只能这样验证 detach）
        const openerHandle = await firstRow.locator('.model-open-btn').first().elementHandle();
        await firstRow.locator('td').nth(6).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: 8000 });
        // 抽屉打开期间强制重渲染列表 → 原 opener 节点被替换（document.contains 为 false）
        await page.evaluate(() => renderModelsPage());
        await page.waitForTimeout(400);
        const openerDetached = await openerHandle.evaluate(el => !document.contains(el)).catch(() => null);
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        const fb = await page.evaluate((id) => {
            const el = document.activeElement;
            const row = document.querySelector(`#modelListBody tr[data-id="${id}"]`);
            const target = row ? row.querySelector('.model-open-btn') : null;
            return { ok: !!el && el === target, tag: el ? el.tagName : null };
        }, rowId);
        // 前置必须成立：opener 真的被替换掉了，否则走的是快乐路径、兜底分支根本没执行（假通过）
        expect(openerDetached === true, '重渲染确实使原 opener 脱离 DOM（兜底分支被真正触发）', openerDetached);
        expect(fb.ok, '重渲染后焦点仍归还到该行打开按钮（未掉到 body）', { openerDetached, ...fb });

        // ===== R11 行 hover 样式对齐全站范式（用户反馈：要和其他模块一致的米黄色）=====
        console.log('R11. 行 hover 米黄 + 表名/描述无下划线');
        const hoverBg = await page.evaluate(() => {
            const row = document.querySelector('#modelListBody tr[data-id]');
            // 直接读 CSS 规则，避免依赖真实 hover 的时序
            const rules = [];
            for (const sheet of document.styleSheets) {
                let list; try { list = sheet.cssRules; } catch (e) { continue; }
                for (const r of list) {
                    if (r.selectorText && /#modelListBody tr:hover/.test(r.selectorText)) { rules.push(r.style.background || r.style.backgroundColor); }
                }
            }
            return { rules, hasRow: !!row };
        });
        // 浏览器会把 #fffbeb 规范化成 rgb(255, 251, 235)，两种写法都认
        expect(hoverBg.rules.some(v => /#fffbeb/i.test(v || '') || /rgb\(255,\s*251,\s*235\)/.test(v || '')),
            '存在 #modelListBody tr:hover = 米黄规则（对齐 components.css/.data-table 全站范式）', hoverBg.rules);
        // 真实 hover 一次，确认视觉生效
        await firstRow.hover();
        await page.waitForTimeout(250);
        const liveBg = await page.evaluate(() => {
            const row = document.querySelector('#modelListBody tr[data-id]');
            return row ? getComputedStyle(row).backgroundColor : null;
        });
        expect(liveBg === 'rgb(255, 251, 235)', '真实 hover 时计算样式为米黄 rgb(255,251,235)', liveBg);
        // 表名/描述按钮不得有下划线
        const decos = await page.$$eval('#modelListBody .model-open-btn', els => els.slice(0, 4).map(e => getComputedStyle(e).textDecorationLine));
        expect(decos.every(d => d === 'none'), '表名/描述按钮无下划线（含 hover 态规则已移除）', decos);
        const underlineRule = await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
                let list; try { list = sheet.cssRules; } catch (e) { continue; }
                for (const r of list) {
                    if (r.selectorText && /\.model-open-btn:hover/.test(r.selectorText)) { return r.cssText; }
                }
            }
            return null;
        });
        expect(underlineRule === null, '.model-open-btn:hover 下划线规则已删除', underlineRule);

        // ===== R12 normalize.js 版本守卫（防「改了共享 JS 忘 bump 缓存串」静默失败）=====
        console.log('R12. normalize.js 版本印记与缓存串一致');
        const kitCheck = await page.evaluate(() => {
            const src = Array.from(document.querySelectorAll('script[src*="model-detail-normalize"]')).map(s => s.getAttribute('src'))[0] || '';
            return { kitVersion: window.ModelDetailKit && window.ModelDetailKit.KIT_VERSION, src };
        });
        expect(!!kitCheck.kitVersion, 'normalize.js 暴露 KIT_VERSION', kitCheck);
        expect(kitCheck.src.includes(kitCheck.kitVersion), 'HTML 缓存串包含 KIT_VERSION（两处已同步 bump）', kitCheck);
        // 版本不匹配时必须报错（模拟旧缓存 JS 的场景）
        const warnFired = await page.evaluate(() => {
            const real = window.ModelDetailKit.KIT_VERSION;
            let msg = null;
            const origErr = console.error;
            console.error = (...a) => { msg = a.join(' '); };
            try {
                window.ModelDetailKit.KIT_VERSION = 'stale_old';
                mdcCheckKitVersion();
            } finally {
                window.ModelDetailKit.KIT_VERSION = real;
                console.error = origErr;
            }
            return msg;
        });
        expect(/版本不匹配/.test(warnFired || ''), '版本不匹配时 console 明确报错（不再静默显示「—」）', warnFired && warnFired.slice(0, 50));

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
