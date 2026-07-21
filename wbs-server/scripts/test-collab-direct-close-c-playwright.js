/**
 * v1.120.0 Commit C 前端 UI 验证（Playwright）：直派大文件行政闭环前端配套
 *
 * 验证（纯 UI 渲染/交互，前后端逻辑已由 Commit A/B verify 39+31 用例覆盖）：
 *   C-UI-1 导出人视角·真直派单：提交弹框附件 * 隐藏 + 无附件提示条显示 + 概要标签变必填
 *   C-UI-2 admin 视角·真直派 EXPORTING 单：footer 出现「🗂️ 直接行政闭环」按钮
 *
 * 前置：dev 服务器运行 + 传入真直派 EXPORTING 单的 id/token（从 /tmp/dc-testsingle.json 读）
 * 运行：node scripts/test-collab-direct-close-c-playwright.js
 */
'use strict';

const fs = require('fs');
const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const os = require('os');
const path = require('path');
const single = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'dc-testsingle.json'), 'utf8'));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${detail || ''}`); }
}

async function loginAs(context, token, id) {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Data_Collab.html?id=${id}`, { waitUntil: 'load' });
    return page;
}

async function main() {
    const browser = await chromium.launch();
    try {
        // ===== C-UI-1 导出人视角 =====
        console.log('\n=== C-UI-1 导出人·真直派单：提交弹框放开附件 UI ===');
        {
            const ctx = await browser.newContext();
            const page = await loginAs(ctx, single.exporterToken, single.id);
            await page.waitForTimeout(1500); // 等详情渲染
            // 点「📦 提交导出物」按钮
            const uploadBtn = page.locator('button:has-text("提交导出物")').first();
            const btnVisible = await uploadBtn.isVisible().catch(() => false);
            ok('C-UI-1 「提交导出物」按钮可见', btnVisible, '导出人应看到提交按钮');
            if (btnVisible) {
                await uploadBtn.click();
                await page.waitForTimeout(500);
                // 弹框打开后检查 UI 状态
                const modalOpen = await page.locator('#exportUploadModal.open').isVisible().catch(() => false);
                ok('C-UI-1 提交弹框已打开', modalOpen);
                // 无附件提示条应显示
                const tipVisible = await page.locator('#exportNoFileTip').isVisible().catch(() => false);
                ok('C-UI-1 无附件提示条显示（真直派）', tipVisible);
                // 附件 * 应隐藏
                const dataStarDisplay = await page.locator('#exportDataStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                ok('C-UI-1 结果数据 * 隐藏', dataStarDisplay === 'none', `display=${dataStarDisplay}`);
                const shotStarDisplay = await page.locator('#exportShotStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                ok('C-UI-1 截图 * 隐藏', shotStarDisplay === 'none', `display=${shotStarDisplay}`);
                // 概要变必填：红星显示 + 标签含「≥10」
                const summaryStarDisplay = await page.locator('#exportSummaryStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                ok('C-UI-1 导出概要红星 * 显示（直派必填）', summaryStarDisplay !== 'none', `display=${summaryStarDisplay}`);
                const summaryLabel = await page.locator('#exportSummaryLabel').textContent().catch(() => '');
                ok('C-UI-1 概要标签含「≥10」', summaryLabel.includes('≥10') || summaryLabel.includes('10'), `label="${summaryLabel}"`);
            }
            await ctx.close();
        }

        // ===== C-UI-2 admin 视角 =====
        console.log('\n=== C-UI-2 admin·真直派 EXPORTING 单：footer 出现「直接行政闭环」按钮 ===');
        {
            const ctx = await browser.newContext();
            const page = await loginAs(ctx, single.adminToken, single.id);
            await page.waitForTimeout(1500);
            const closeBtn = page.locator('button:has-text("直接行政闭环")').first();
            const closeBtnVisible = await closeBtn.isVisible().catch(() => false);
            ok('C-UI-2 「🗂️ 直接行政闭环」按钮可见', closeBtnVisible, 'admin 应在真直派 EXPORTING 单看到此按钮');
            if (closeBtnVisible) {
                await closeBtn.click();
                await page.waitForTimeout(500);
                const modalOpen = await page.locator('#adminSubmitModal.open').isVisible().catch(() => false);
                ok('C-UI-2 行政闭环弹框已打开', modalOpen);
            }
            await ctx.close();
        }

        // ===== C-UI-3 负向：normal（fallback 重流转）单不放开 =====
        const normalPath = require('path').join(require('os').tmpdir(), 'dc-testnormal.json');
        if (fs.existsSync(normalPath)) {
            const normal = JSON.parse(fs.readFileSync(normalPath, 'utf8'));
            console.log('\n=== C-UI-3 负向·normal EXPORTING 单：附件仍必填 + admin 无「直接行政闭环」按钮 ===');
            // 导出人视角：附件 * 仍显示、无附件提示条隐藏
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.exporterToken, normal.id);
                await page.waitForTimeout(1500);
                const uploadBtn = page.locator('button:has-text("提交导出物")').first();
                if (await uploadBtn.isVisible().catch(() => false)) {
                    await uploadBtn.click();
                    await page.waitForTimeout(500);
                    const tipVisible = await page.locator('#exportNoFileTip').isVisible().catch(() => false);
                    ok('C-UI-3 无附件提示条隐藏（normal 不放开）', !tipVisible);
                    const dataStarDisplay = await page.locator('#exportDataStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                    ok('C-UI-3 结果数据 * 仍显示（normal 附件必填）', dataStarDisplay !== 'none', `display=${dataStarDisplay}`);
                    const summaryStar = await page.locator('#exportSummaryStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                    ok('C-UI-3 概要红星隐藏（normal 概要可选）', summaryStar === 'none', `display=${summaryStar}`);
                }
                await ctx.close();
            }
            // admin 视角：无「直接行政闭环」按钮（normal EXPORTING 不放开）
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.adminToken, normal.id);
                await page.waitForTimeout(1500);
                const closeBtnVisible = await page.locator('button:has-text("直接行政闭环")').first().isVisible().catch(() => false);
                ok('C-UI-3 admin 无「直接行政闭环」按钮（normal 不放开）', !closeBtnVisible);
                await ctx.close();
            }
        }

        console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
        if (fail > 0) { console.log('失败项：', fails.join(' | ')); process.exitCode = 1; }
        else console.log('✓ Commit C 前端 UI 全部通过');
    } finally {
        await browser.close();
    }
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
