/**
 * v1.120.0 Commit C 前端 UI 验证（Playwright）：直派大文件行政闭环前端配套
 *
 * 验证（UI 渲染/交互 + 一条端到端，后端逻辑由 verify-collab-direct-close-no-file 等覆盖）：
 *   C-UI-1 导出人·真直派单：提交弹框附件 * 隐藏 + 无附件提示条显示 + 概要标签变必填
 *   C-UI-2 admin·真直派 EXPORTING 单：footer 出现「🗂️ 直接行政闭环」按钮
 *   C-UI-3 normal 单（已三级转发·#45 形态）：
 *          ✅ 已放开 → 附件 * 隐藏 + 提示条显示 + 概要标签写明「不传附件时必填」
 *          ⛔ 未放开 → 概要红星不亮（有附件时可选）+ admin 仍无「直接行政闭环」按钮
 *   C-UI-4 端到端·normal 单：不传附件 + 概要≥10字 → 真实提交成 DONE + 详情页显示「行政闭环」
 *
 * 沿革：v1.120.0 Commit C 建立（当时 C-UI-3 断言「normal 不放开」）；
 *   2026-09-01 v1.164.2 无附件闭环放开到导出人本人后，C-UI-3 前两条断言翻转、新增 C-UI-4。
 *
 * 前置：dev 服务器运行 + 先跑 `node scripts/_seed-dc-ui-fixtures.js` 播种两张测试单
 *   （产出 <tmp>/dc-testsingle.json 真直派 + <tmp>/dc-testnormal.json normal 已转发）。
 * 前置：dev 服务器运行即可——**夹具由本脚本每次自动播种**（require ./make-dc-ui-fixtures）。
 *   原先硬读 <tmp>/dc-testsingle.json，夹具丢失即 ENOENT 崩溃、整套回归跑不了（2026-09-01 实遇）；
 *   且 C-UI-4 会把 normal 单真实闭环成 DONE，复用旧夹具必判红 → 恒新播种最稳。跑完自动清理测试单。
 * 运行：node scripts/test-collab-direct-close-c-playwright.js
 */
'use strict';

const { chromium } = require('playwright');
const sqlite3 = require('sqlite3').verbose();
const fixtures = require('./make-dc-ui-fixtures');
const fx = require('./_test-fixture');

// codex 审 MED 采纳：复用 _test-fixture 的 BASE，不再重复硬编码
//   （两处各写一份地址时，一旦其一改动就会「在 A 播种、在 B 断言」静默误报）
const BASE_URL = fx.BASE;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${detail || ''}`); }
}

// 直查库断言终态——UI 文案断言不足以证明状态真的变了（见 C-UI-4 注释）
function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(fx.DB_PATH);
        db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(fx.DB_PATH);
        db.all(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
}

async function loginAs(context, token, id) {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE_URL}/Data_Collab.html?id=${id}`, { waitUntil: 'load' });
    return page;
}

async function main() {
    // codex 审 MED 采纳（生命周期）：播种与浏览器启动都纳入 try/finally，
    //   且 browser.close() 与夹具清理各自独立 try——任一步抛错都不能吃掉另一步。
    //   原实现里 seed() 在 try 外，chromium.launch() 失败会残留测试单；
    //   browser.close() 抛错也会阻止 cleanupSeeded。
    let seeded = null;
    let browser = null;
    try {
        seeded = await fixtures.seed({ quiet: true });   // 内嵌调用不落 JSON（token 不外泄到临时目录）
        const single = seeded.single;
        const normal = seeded.normal;
        console.log(`（夹具：真直派单 #${single.id} / normal 已转发单 #${normal.id}）`);

        browser = await chromium.launch();
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

        // ===== C-UI-3 normal 单（已三级转发·#45 形态）=====
        // ⚠️ 2026-09-01 v1.164.2：本段前两条断言由「normal 不放开」翻转为「normal 也放开」。
        //   原契约=无附件闭环仅真直派单；新契约=**导出人本人**在任意 EXPORTING 单都可无附件闭环。
        //   ⭐ 第三、四条断言**刻意保持不变**，它们钉住的是本次**未放开**的部分：
        //     · 概要红星只对真直派亮（normal 单有附件时概要仍可选）
        //     · admin 的「🗂️ 直接行政闭环」按钮对 normal 单仍不出现
        //       ——即 codex 02 审 HIGH-1「防 admin 越过 exporter 闭环」的收严原样保留。
        {
            console.log('\n=== C-UI-3 normal EXPORTING 单：附件 UI 已放开（v1.164.2）+ admin 仍无「直接行政闭环」按钮 ===');
            // 导出人视角：附件 * 隐藏、无附件提示条显示、概要红星仍不亮（有附件时可选）
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.exporterToken, normal.id);
                await page.waitForTimeout(1500);
                const uploadBtn = page.locator('button:has-text("提交导出物")').first();
                const btnVisible = await uploadBtn.isVisible().catch(() => false);
                ok('C-UI-3 「提交导出物」按钮可见', btnVisible);
                if (btnVisible) {
                    await uploadBtn.click();
                    await page.waitForTimeout(500);
                    const tipVisible = await page.locator('#exportNoFileTip').isVisible().catch(() => false);
                    ok('C-UI-3 无附件提示条显示（v1.164.2 normal 也放开）', tipVisible);
                    const dataStarDisplay = await page.locator('#exportDataStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                    ok('C-UI-3 结果数据 * 隐藏（v1.164.2 附件不再必填）', dataStarDisplay === 'none', `display=${dataStarDisplay}`);
                    // codex 审 MED 采纳：截图红星原先没被断言（只测了结果数据那颗），补齐两颗都测
                    const shotStarDisplay = await page.locator('#exportShotStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                    ok('C-UI-3 截图 * 隐藏（v1.164.2 附件不再必填）', shotStarDisplay === 'none', `display=${shotStarDisplay}`);
                    const summaryStar = await page.locator('#exportSummaryStar').evaluate(el => getComputedStyle(el).display).catch(() => 'error');
                    ok('C-UI-3 概要红星隐藏（normal 有附件时概要仍可选·未放开项）', summaryStar === 'none', `display=${summaryStar}`);
                    const summaryLabel = await page.locator('#exportSummaryLabel').textContent().catch(() => '');
                    ok('C-UI-3 概要标签写明「不传附件时必填」', summaryLabel.includes('不传附件时必填'), `label="${summaryLabel}"`);
                }
                await ctx.close();
            }
            // admin 视角：仍无「直接行政闭环」按钮（本次**不放开** admin 越权路径）
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.adminToken, normal.id);
                await page.waitForTimeout(1500);
                const closeBtnVisible = await page.locator('button:has-text("直接行政闭环")').first().isVisible().catch(() => false);
                ok('C-UI-3 admin 仍无「直接行政闭环」按钮（HIGH-1 收严保留·未放开项）', !closeBtnVisible);
                await ctx.close();
            }

            // ===== C-UI-4 端到端：normal 单导出人不传附件 + 概要≥10字 → 真实闭环成 DONE =====
            // 光验 UI 形态不够（[分层实现「层内全绿」≠功能可用]）——这里走完整真实链路：
            //   点按钮 → 只填概要 → 提交 → 断言页面进入完成态且落「行政闭环」标识。
            // ===== C-UI-5 前端负向：normal 单无附件 + 概要不足 10 字 → 前端拦住，不发请求 =====
            // codex 审 MED 采纳：原先只覆盖正向，若前端那条 `(gd || noFiles) && length<10` 校验被删掉，
            //   请求会落到后端 400、弹框不关，Playwright 仍可能"看起来没事"——前端校验等于没有守卫。
            //   这里**统计 submit-export 请求数**来证明前端真的拦在了发请求之前。
            console.log('\n=== C-UI-5 前端负向·normal 单：不传附件 + 概要<10字 → 前端拦截且不发请求 ===');
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.exporterToken, normal.id);
                let submitReqCount = 0;
                page.on('request', (r) => {
                    if (r.method() === 'POST' && r.url().includes('/submit-export')) submitReqCount++;
                });
                await page.waitForTimeout(1500);
                const uploadBtn = page.locator('button:has-text("提交导出物")').first();
                const btnVisible = await uploadBtn.isVisible().catch(() => false);
                ok('C-UI-5 「提交导出物」按钮可见', btnVisible);
                if (btnVisible) {
                    await uploadBtn.click();
                    await page.waitForTimeout(500);
                    await page.fill('#f_export_summary', '太短');
                    await page.click('#btnExportUpload');
                    await page.waitForTimeout(1200);
                    const modalStillOpen = await page.locator('#exportUploadModal.open').isVisible().catch(() => false);
                    ok('C-UI-5 弹框仍打开（被前端拦下）', modalStillOpen);
                    ok('C-UI-5 未发出 submit-export 请求（拦在发请求之前）', submitReqCount === 0, `发出了 ${submitReqCount} 次`);
                    const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [normal.id]);
                    ok('C-UI-5 库内状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
                }
                await ctx.close();
            }

            // ===== C-UI-6 前端负向：只选 1 个附件（半残）→ 前端拦住，不发请求 =====
            // codex 审 MED 采纳：后端有 PARTIAL_ATTACHMENTS 兜底（verify T6 覆盖），
            //   但前端 hasData !== hasShot 这条同样要有守卫，否则半残组合会一路打到后端。
            console.log('\n=== C-UI-6 前端负向·只选 1 个附件 → 前端拦截且不发请求 ===');
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.exporterToken, normal.id);
                let submitReqCount = 0;
                page.on('request', (r) => {
                    if (r.method() === 'POST' && r.url().includes('/submit-export')) submitReqCount++;
                });
                await page.waitForTimeout(1500);
                const uploadBtn = page.locator('button:has-text("提交导出物")').first();
                const btnVisible = await uploadBtn.isVisible().catch(() => false);
                ok('C-UI-6 「提交导出物」按钮可见', btnVisible);
                if (btnVisible) {
                    await uploadBtn.click();
                    await page.waitForTimeout(500);
                    // 只挂 result_data，不挂截图
                    await page.setInputFiles('#f_export_result_data', {
                        name: 'result.xlsx',
                        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        buffer: Buffer.from('PK\x03\x04 fake xlsx'),
                    });
                    await page.fill('#f_export_summary', '只传了结果数据没传截图，应被前端拦下');
                    await page.click('#btnExportUpload');
                    await page.waitForTimeout(1200);
                    const modalStillOpen = await page.locator('#exportUploadModal.open').isVisible().catch(() => false);
                    ok('C-UI-6 弹框仍打开（被前端拦下）', modalStillOpen);
                    ok('C-UI-6 未发出 submit-export 请求', submitReqCount === 0, `发出了 ${submitReqCount} 次`);
                    const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [normal.id]);
                    ok('C-UI-6 库内状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
                }
                await ctx.close();
            }

            // ===== C-UI-4 端到端：normal 单不传附件 + 概要≥10字 → 真实闭环成 DONE =====
            // ⚠️ codex 审 MED 采纳（假绿修复）：原断言用 body.textContent().includes('行政闭环') 判成功，
            //   而本次改动**恰好往提交弹窗的静态文案里加了「行政闭环」四个字**，且 textContent
            //   包含 display:none 元素的文本 → 该断言在提交前就已成立，是「断言永远成立」的假绿。
            //   改为直查库精确断言终态四项，UI 只作辅助。放在 C-UI-5 之后跑（它会把单闭环掉）。
            console.log('\n=== C-UI-4 端到端·normal 单：不传附件 + 概要≥10字 → 真实提交成 DONE ===');
            {
                const ctx = await browser.newContext();
                const page = await loginAs(ctx, normal.exporterToken, normal.id);
                await page.waitForTimeout(1500);
                const uploadBtn = page.locator('button:has-text("提交导出物")').first();
                // 无条件断言按钮可见：原先包在 if 里，按钮不可见时整段端到端会被静默跳过（假绿）
                const btnVisible = await uploadBtn.isVisible().catch(() => false);
                ok('C-UI-4 「提交导出物」按钮可见', btnVisible);
                if (btnVisible) {
                    const SUMMARY = '大文件线下已转交，平台只做闭环登记';
                    await uploadBtn.click();
                    await page.waitForTimeout(500);
                    await page.fill('#f_export_summary', SUMMARY);
                    await page.click('#btnExportUpload');
                    await page.waitForTimeout(2500);
                    const modalStillOpen = await page.locator('#exportUploadModal.open').isVisible().catch(() => false);
                    ok('C-UI-4 弹框已关闭（提交成功）', !modalStillOpen, '弹框未关说明被前端校验或后端拒了');
                    // 直查库：终态四项精确断言（UI 文案不足以证明状态真的变了）
                    const row = await dbGet(
                        'SELECT status, sql_validation_status, export_summary, done_at FROM collab_requests WHERE id=?',
                        [normal.id]);
                    ok('C-UI-4 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
                    ok('C-UI-4 库内 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
                    ok('C-UI-4 库内 export_summary 与填写完全一致', row && row.export_summary === SUMMARY, `got: ${row && row.export_summary}`);
                    ok('C-UI-4 库内 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
                    const atts = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [normal.id]);
                    ok('C-UI-4 无 active 附件（确为无附件闭环）', atts.length === 0, `got ${atts.length} 行`);
                }
                await ctx.close();
            }
        }

        console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
        if (fail > 0) { console.log('失败项：', fails.join(' | ')); process.exitCode = 1; }
        else console.log('✓ Commit C 前端 UI 全部通过');
    } finally {
        // 两段各自独立 try：关浏览器失败不能吃掉夹具清理
        if (browser) {
            try { await browser.close(); }
            catch (e) { console.warn(`⚠️ 关闭浏览器失败: ${e.message}`); }
        }
        if (seeded) {
            // codex 审 MED 采纳：清理失败不再静默吞，改为判红——
            //   残留测试单会污染后续回归（也会让人误以为库里的脏单是业务数据）
            const cleanupErrs = await fixtures.cleanupSeeded(seeded.ids);
            if (cleanupErrs.length) {
                fail += cleanupErrs.length;
                cleanupErrs.forEach((m) => fails.push(m));
                console.log(`\n✗ 夹具清理未完成：\n  ${cleanupErrs.join('\n  ')}`);
                process.exitCode = 1;
            }
        }
    }
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
