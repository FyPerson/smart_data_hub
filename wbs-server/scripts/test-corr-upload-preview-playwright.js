/**
 * 数据修正 · 上传交互优化 + 创建人搜索 Playwright 行为实测（2026-07-23）
 *
 * 用法：node scripts/test-corr-upload-preview-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 覆盖：
 *   U1 attachModal 追加式选择+预览：选 1 图片+1 xlsx → 缩略图+占位各 1；再追加 1 图片 → 3 项；
 *      重复选同一文件 → 数量不变（去重）；移除 1 项 → 2 项；openAttach 重开 → 预览清空
 *   U2 提交按钮仍在（两段式保留：选完预览确认 → 提交）；不点提交（不污染本地库）
 *   U3 内联补传入口：renderErrProofPicked 函数存在（详情按钮显隐依赖单据状态，函数级断言）
 *   S1 创建人搜索回归：filterSearch 填创建人 → 命中 >0（① 改动）
 *   全程 0 console error
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

// 造临时测试文件（1x1 PNG + 假 xlsx）
function makeTmpFiles() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-up-'));
    const png1 = path.join(dir, 'proof_a.png');
    const png2 = path.join(dir, 'proof_b.png');
    const xlsx = path.join(dir, 'list.xlsx');
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000-1f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082'.replace(/-/g, ''), 'hex');
    fs.writeFileSync(png1, pngBytes);
    fs.writeFileSync(png2, pngBytes);
    fs.writeFileSync(xlsx, Buffer.from('PKfake-xlsx-for-preview-test'));
    return { dir, png1, png2, xlsx };
}

(async () => {
    console.log('=== 数据修正 上传交互优化+创建人搜索 Playwright 实测 ===\n');
    const tmp = makeTmpFiles();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto('http://localhost:3000/login.html', { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto('http://localhost:3000/Data_Correction.html', { waitUntil: 'load' });
        await page.waitForTimeout(1000);

        // ===== U1 attachModal 预览 =====
        console.log('U1. attachModal 追加式选择+预览');
        await page.evaluate(() => openAttach(allItems[0] ? allItems[0].id : 1));
        await page.setInputFiles('#formAttachFiles', [tmp.png1, tmp.xlsx]);
        await page.waitForTimeout(200);
        let n = await page.evaluate(() => corrAttachFiles.length);
        let imgs = await page.locator('#corrAttachPreview img').count();
        expect(n === 2, `选 1 图+1 xlsx → 数组 2 项（实际 ${n}）`);
        expect(imgs === 1, `图片渲染缩略图 1 个（实际 ${imgs}）`);
        const hasPlaceholder = await page.evaluate(() => document.getElementById('corrAttachPreview').innerHTML.includes('📊'));
        expect(hasPlaceholder, 'xlsx 渲染 📊 占位');

        await page.setInputFiles('#formAttachFiles', [tmp.png2]);
        await page.waitForTimeout(200);
        n = await page.evaluate(() => corrAttachFiles.length);
        expect(n === 3, `追加 1 图 → 3 项（追加式非覆盖，实际 ${n}）`);

        await page.setInputFiles('#formAttachFiles', [tmp.png1]);
        await page.waitForTimeout(200);
        n = await page.evaluate(() => corrAttachFiles.length);
        expect(n === 3, `重复选同一文件 → 仍 3 项（去重，实际 ${n}）`);

        await page.evaluate(() => removeCorrAttachFile(0));
        await page.waitForTimeout(100);
        n = await page.evaluate(() => corrAttachFiles.length);
        expect(n === 2, `移除 1 项 → 2 项（实际 ${n}）`);

        await page.evaluate(() => { closeModal('attachModal'); openAttach(allItems[0] ? allItems[0].id : 1); });
        n = await page.evaluate(() => corrAttachFiles.length);
        const previewEmpty = await page.evaluate(() => document.getElementById('corrAttachPreview').innerHTML === '');
        expect(n === 0 && previewEmpty, '重开弹窗 → 数组与预览清空');

        // ===== U1b 含双引号文件名不逃逸属性（escapeHtml 不转义引号 → safeAttr &quot; 处理）=====
        //   Windows 文件系统不允许 " 字符 → 用 Playwright buffer 形式注入（不经真实文件系统）
        await page.setInputFiles('#formAttachFiles', [{
            name: 'a"onmouseover=x.png',
            mimeType: 'image/png',
            buffer: fs.readFileSync(tmp.png1),
        }]);
        await page.waitForTimeout(200);
        const x = await page.evaluate(() => {
            const wrap = document.getElementById('corrAttachPreview');
            const div = [...wrap.querySelectorAll('div[title]')].find(d => (d.getAttribute('title') || '').includes('onmouseover'));
            return {
                titleIntact: !!div && div.getAttribute('title') === 'a"onmouseover=x.png',
                noInjectedAttr: ![...wrap.querySelectorAll('*')].some(el => el.hasAttribute('onmouseover')),
            };
        });
        expect(x.titleIntact, '含 " 文件名 title 属性完整不截断');
        expect(x.noInjectedAttr, '未逃逸出 onmouseover 属性（XSS 防线）');
        await page.evaluate(() => { corrAttachFiles = corrAttachFiles.filter(f => !f.name.includes('onmouseover')); renderCorrAttachPreview(); });

        // ===== U2 提交按钮在位（两段式保留）=====
        console.log('\nU2. 提交入口');
        const btnVisible = await page.locator('#btnSubmitAttach').isVisible();
        expect(btnVisible, '提交按钮在位（选完预览确认 → 提交 两段式保留）');
        await page.evaluate(() => closeModal('attachModal'));

        // ===== U2b 上传中切换上下文竞态（codex M-3）：route mock 延迟响应，期间关弹窗为另一单重开选新文件，
        //   旧响应返回后不得清空新选择/关闭新弹窗 =====
        console.log('\nU2b. 上传响应竞态（codex M-3）');
        await page.route('**/api/corrections/*/attachments', async route => {
            await new Promise(r => setTimeout(r, 1200));
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        });
        const raceR = await page.evaluate(async (pngName) => {
            const idA = allItems[0] ? allItems[0].id : 1;
            const idB = allItems[1] ? allItems[1].id : 2;
            openAttach(idA);
            corrAttachFiles = [new File([new Uint8Array(10)], 'race_a.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            const p = submitAttachments();          // 旧请求（被 route 延迟 1.2s）
            await new Promise(r => setTimeout(r, 300));
            closeModal('attachModal');              // 用户放弃等待
            openAttach(idB);                        // 为另一单重开
            corrAttachFiles = [new File([new Uint8Array(10)], 'race_b.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            await p;                                // 等旧响应返回
            return {
                modalOpen: document.getElementById('attachModal').classList.contains('open'),
                keptFiles: corrAttachFiles.length,
                curId: document.getElementById('attachCorrId').value,
                expectB: String(idB),
            };
        });
        expect(raceR.modalOpen === true, '旧响应返回后新弹窗未被误关');
        expect(raceR.keptFiles === 1, `新弹窗的选择未被清空（实际 ${raceR.keptFiles} 项）`);
        expect(raceR.curId === raceR.expectB, `弹窗上下文仍是单 B（实际 ${raceR.curId}）`);
        await page.unroute('**/api/corrections/*/attachments');
        await page.evaluate(() => { corrAttachFiles = []; renderCorrAttachPreview(); closeModal('attachModal'); });

        // ===== U3 内联补传预览函数 =====
        console.log('\nU3. 内联补传入口');
        const fnOk = await page.evaluate(() => typeof renderErrProofPicked === 'function');
        expect(fnOk, 'renderErrProofPicked 函数存在（内联入口已选文件列表预览）');

        // ===== S1 创建人搜索回归 =====
        console.log('\nS1. 创建人搜索（① 改动回归）');
        const s = await page.evaluate(() => {
            const creator = allItems.map(it => it.created_by_name).find(Boolean);
            if (!creator) return { skip: true };
            document.getElementById('filterSearch').value = creator;
            const hit = getFilteredItems().length;
            document.getElementById('filterSearch').value = '';
            return { creator, hit };
        });
        if (s.skip) { console.log('  - 本地无创建人数据，跳过'); }
        else expect(s.hit > 0, `搜创建人「${s.creator}」命中 ${s.hit} 条（>0）`);

        // ===== console 健康 =====
        console.log('\nP. console 健康');
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length}${consoleErrors.length ? '：' + consoleErrors.slice(0, 3).join(' | ') : ''}）`);
    } finally {
        await browser.close();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    }

    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
