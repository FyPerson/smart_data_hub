/**
 * 数据修正 · 上传交互优化 + 创建人搜索 Playwright 行为实测（2026-07-23）
 *
 * 用法：node scripts/test-corr-upload-preview-playwright.js
 * 前置：本地 server 已启动（默认 localhost:3000，可用 TEST_BASE_URL 环境变量覆盖，如 http://localhost:3100）
 *
 * 覆盖：
 *   U1 attachModal 追加式选择+预览：选 1 图片+1 xlsx → 缩略图+占位各 1；再追加 1 图片 → 3 项；
 *      重复选同一文件 → 数量不变（去重）；移除 1 项 → 2 项；openAttach 重开 → 预览清空
 *   U2 提交按钮仍在（两段式保留：选完预览确认 → 提交）；不点提交（不污染本地库）
 *   U2c H-1 会话令牌：同单同类型重开弹窗，旧响应不清新选择、不误关新弹窗
 *   U2d H-2 控件会话隔离：旧请求挂起中重开立即可提交；新请求在途时旧 finally 不复位控件
 *   U3 弹窗泛化（U1 2026-07-23 二期）：openAttach(id,'error_proof') 标题/类型切换、缺省回落 fix_proof、
 *      旧两步式函数（uploadErrorProof/renderErrProofPicked）已退役
 *   U3b error_proof 提交契约：请求体带 attachment_type=error_proof（route 捕获）；
 *      fix_proof 负向契约：请求体不含 attachment_type（后端缺省）；409 主单引导：选择保留+弹窗不关
 *   U4 裸 input chips 预览：完成/重修弹窗+建单表单选文件 → chips 渲染；重开弹窗 → chips 清空
 *   U5 附件 lightbox 预览（U2 commit）：openLightbox/ESC/滚动锁、委托监听引号文件名无逃逸、抽屉真实渲染冒烟
 *   U5b 生产渲染链路（M-2）：route mock 详情附件（a"&<图.png / 字面量 &quot; 名），真实 renderAtts 渲染后
 *       从实际 DOM 断言 title/caption/href/target/rel/download + 点击缩略图 lightbox 原始名
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
    // 409 负向用例（U3b 主单引导 mock）会让浏览器打一条网络层 resource 日志——页面代码处理正常，
    // 属预期噪音。L-3（codex 复审）：豁免仅在 allow409 标志开启的用例段内生效，防全局豁免掩盖
    // 其他接口意外 409 的回归；其他 console error 一律计数。
    let allow409 = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allow409 && /Failed to load resource.*409/.test(m.text())) return;
        consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Data_Correction.html`, { waitUntil: 'load' });
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

        // ===== U2c H-1 会话令牌：同单同类型重开（条件比对时代的盲区）=====
        console.log('\nU2c. 同单同类型重开竞态（H-1 会话令牌）');
        await page.route('**/api/corrections/*/attachments', async route => {
            await new Promise(r => setTimeout(r, 1200));
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        });
        const raceR2 = await page.evaluate(async () => {
            const idA = allItems[0] ? allItems[0].id : 1;
            openAttach(idA);                        // fix_proof
            corrAttachFiles = [new File([new Uint8Array(10)], 'race_c.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            const p = submitAttachments();          // 旧请求（被 route 延迟 1.2s）
            await new Promise(r => setTimeout(r, 300));
            closeModal('attachModal');              // 用户放弃等待
            openAttach(idA);                        // 同一单、同一类型重开（id+type+open 三条件全同）
            corrAttachFiles = [new File([new Uint8Array(10)], 'race_d.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            await p;                                // 等旧响应返回
            return {
                modalOpen: document.getElementById('attachModal').classList.contains('open'),
                keptFiles: corrAttachFiles.length,
                inputEnabled: !document.getElementById('formAttachFiles').disabled,
            };
        });
        expect(raceR2.modalOpen === true, 'H-1 同单同类型重开：旧响应返回后新弹窗未被误关');
        expect(raceR2.keptFiles === 1, `H-1 同单同类型重开：新选择未被清空（实际 ${raceR2.keptFiles} 项）`);
        expect(raceR2.inputEnabled, 'H-1 旧请求结束后文件选择恢复可用（finally 复位）');
        await page.unroute('**/api/corrections/*/attachments');
        await page.evaluate(() => { corrAttachFiles = []; renderCorrAttachPreview(); closeModal('attachModal'); });

        // ===== U2d H-2 控件禁用状态按会话隔离（重叠请求，复审拍板补）=====
        // M-5（codex 三轮审）：第二个响应改闸门控制——断言完才释放，消除"p1 的真实 loadList 必须
        //   在固定 2000ms 内收尾"的时序依赖（慢机 flake 隐患）。
        console.log('\nU2d. 重叠请求控件隔离（H-2）');
        let h2Seq = 0;
        let releaseSecond = null;
        const secondGate = new Promise(r => { releaseSecond = r; });
        await page.route('**/api/corrections/*/attachments', async route => {
            const n = ++h2Seq;
            if (n === 1) await new Promise(r => setTimeout(r, 800));
            else await secondGate;                        // 新请求挂在闸门上，测试侧显式放行
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        });
        const afterReopen = await page.evaluate(async () => {
            const idA = allItems[0] ? allItems[0].id : 1;
            openAttach(idA);
            corrAttachFiles = [new File([new Uint8Array(10)], 'h2_a.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            window.__h2p1 = submitAttachments();          // 旧请求（800ms 后返回）
            await new Promise(r => setTimeout(r, 200));
            closeModal('attachModal');
            openAttach(idA);                              // 旧请求挂起中重开新会话
            const snap = {
                btnEnabled: !document.getElementById('btnSubmitAttach').disabled,
                inputEnabled: !document.getElementById('formAttachFiles').disabled,
            };
            corrAttachFiles = [new File([new Uint8Array(10)], 'h2_b.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            window.__h2p2 = submitAttachments();          // 新请求（被闸门挂住）
            return snap;
        });
        expect(afterReopen.btnEnabled && afterReopen.inputEnabled, 'H-2① 旧请求挂起中重开：按钮+输入立即可用');
        await page.evaluate(() => window.__h2p1);         // 等旧请求完整收尾（含其 loadList）；新请求仍被闸门挂住
        const afterOldDone = await page.evaluate(() => ({
            btnDisabled: document.getElementById('btnSubmitAttach').disabled,
            inputDisabled: document.getElementById('formAttachFiles').disabled,
            keptFiles: corrAttachFiles.length,
        }));
        expect(afterOldDone.btnDisabled && afterOldDone.inputDisabled, 'H-2② 新请求在途时旧 finally 不复位控件');
        expect(afterOldDone.keptFiles === 1, `H-2② 旧成功响应不清新会话选择（实际 ${afterOldDone.keptFiles} 项）`);
        releaseSecond();                                  // 断言完毕，放行新请求
        await page.evaluate(() => window.__h2p2);
        const afterNewDone = await page.evaluate(() => ({
            btnEnabled: !document.getElementById('btnSubmitAttach').disabled,
            modalClosed: !document.getElementById('attachModal').classList.contains('open'),
        }));
        expect(afterNewDone.btnEnabled && afterNewDone.modalClosed, 'H-2③ 新请求完成：本会话正常收尾（关弹窗+复位控件）');
        await page.unroute('**/api/corrections/*/attachments');
        await page.evaluate(() => { delete window.__h2p1; delete window.__h2p2; corrAttachFiles = []; renderCorrAttachPreview(); closeModal('attachModal'); });

        // ===== U3 弹窗泛化（内联两步式退役 → openAttach(id,'error_proof') 弹窗）=====
        console.log('\nU3. 待修复数据弹窗入口');
        const u3 = await page.evaluate(() => {
            const id = allItems[0] ? allItems[0].id : 1;
            openAttach(id, 'error_proof');
            const r1 = {
                title: document.getElementById('attachModalTitle').textContent,
                type: document.getElementById('attachType').value,
                open: document.getElementById('attachModal').classList.contains('open'),
            };
            closeModal('attachModal');
            openAttach(id);   // 缺省 = fix_proof
            const r2 = {
                title: document.getElementById('attachModalTitle').textContent,
                type: document.getElementById('attachType').value,
            };
            closeModal('attachModal');
            return { r1, r2, legacyGone: typeof window.uploadErrorProof === 'undefined' && typeof window.renderErrProofPicked === 'undefined' };
        });
        expect(u3.r1.open && u3.r1.title === '上传待修复数据' && u3.r1.type === 'error_proof', `error_proof 入口：弹窗开+标题/类型切换（实际 ${u3.r1.title}/${u3.r1.type}）`);
        expect(u3.r2.title === '补充附件' && u3.r2.type === 'fix_proof', `缺省入口：标题/类型回落 fix_proof（实际 ${u3.r2.title}/${u3.r2.type}）`);
        expect(u3.legacyGone, '旧两步式函数已退役（uploadErrorProof/renderErrProofPicked 不存在）');

        // ===== U3b error_proof 提交契约：请求体带 attachment_type =====
        console.log('\nU3b. error_proof 提交契约');
        let capturedBody = null;
        await page.route('**/api/corrections/*/attachments', async route => {
            capturedBody = route.request().postData() || '';
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        });
        await page.evaluate(async () => {
            openAttach(allItems[0] ? allItems[0].id : 1, 'error_proof');
            corrAttachFiles = [new File([new Uint8Array(10)], 'ep.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            await submitAttachments();
        });
        expect(!!capturedBody && capturedBody.includes('attachment_type') && capturedBody.includes('error_proof'), 'error_proof 提交带 attachment_type=error_proof');

        // fix_proof 负向契约：不带 attachment_type 字段（后端缺省 fix_proof，M-2 拍板补）
        capturedBody = null;
        await page.evaluate(async () => {
            openAttach(allItems[0] ? allItems[0].id : 1);   // 缺省 fix_proof
            corrAttachFiles = [new File([new Uint8Array(10)], 'fp.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            await submitAttachments();
        });
        expect(!!capturedBody && !capturedBody.includes('attachment_type'), 'fix_proof 提交不带 attachment_type（后端缺省契约）');
        await page.unroute('**/api/corrections/*/attachments');

        // 409 主单引导：选择保留 + 弹窗不关（可换单重试，M-2 拍板补）；豁免标志仅包本用例段（L-3）
        allow409 = true;
        await page.route('**/api/corrections/*/attachments', route => route.fulfill({
            status: 409, contentType: 'application/json',
            body: '{"error":"错误证明只能传到主单","code":"ERROR_PROOF_ON_MASTER_ONLY","master_id":99}',
        }));
        const r409 = await page.evaluate(async () => {
            openAttach(allItems[0] ? allItems[0].id : 1, 'error_proof');
            corrAttachFiles = [new File([new Uint8Array(10)], 'e409.png', { type: 'image/png' })];
            renderCorrAttachPreview();
            await submitAttachments();
            return { kept: corrAttachFiles.length, open: document.getElementById('attachModal').classList.contains('open') };
        });
        expect(r409.kept === 1 && r409.open, `409 主单引导：选择保留+弹窗不关（实际 kept=${r409.kept} open=${r409.open}）`);
        await page.unroute('**/api/corrections/*/attachments');
        await page.waitForTimeout(150);   // 等 409 的 console 日志落地后再关豁免
        allow409 = false;
        await page.evaluate(() => { corrAttachFiles = []; renderCorrAttachPreview(); closeModal('attachModal'); });

        // ===== U4 裸 input chips 预览（完成弹窗 + 建单表单）=====
        console.log('\nU4. 裸 input 已选 chips 预览');
        expect(await page.evaluate(() => typeof renderPickedChips === 'function'), 'renderPickedChips 共享渲染器存在');
        await page.evaluate(() => openComplete(allItems[0] ? allItems[0].id : 1, 'single', false));
        await page.setInputFiles('#formCompleteFiles', [tmp.png1, tmp.xlsx]);
        await page.waitForTimeout(150);
        const chips = await page.evaluate(() => document.getElementById('completeFilesPicked').querySelectorAll('div').length);
        expect(chips === 2, `完成弹窗选 2 文件 → chips 2（实际 ${chips}）`);
        await page.evaluate(() => { closeModal('completeModal'); openComplete(allItems[0] ? allItems[0].id : 1, 'single', false); });
        expect(await page.evaluate(() => document.getElementById('completeFilesPicked').innerHTML === ''), '重开完成弹窗 → chips 清空');
        await page.evaluate(() => closeModal('completeModal'));
        await page.evaluate(() => openCreateModal());
        await page.setInputFiles('#formErrorProofFiles', [tmp.xlsx]);
        await page.waitForTimeout(150);
        const createChips = await page.evaluate(() => document.getElementById('createErrProofPicked').querySelectorAll('div').length);
        expect(createChips === 1, `建单表单待修复数据选 1 文件 → chips 1（实际 ${createChips}）`);
        await page.evaluate(() => closeCreateModal());
        // 重修弹窗 chips 重开清空（M-2 拍板补）
        await page.evaluate(() => openResubmit(allItems[0] ? allItems[0].id : 1, 'single', false));
        await page.setInputFiles('#formResubmitFiles', [tmp.png1]);
        await page.waitForTimeout(150);
        const rsChips = await page.evaluate(() => document.getElementById('resubmitFilesPicked').querySelectorAll('div').length);
        expect(rsChips === 1, `重修弹窗选 1 文件 → chips 1（实际 ${rsChips}）`);
        await page.evaluate(() => { closeModal('resubmitModal'); openResubmit(allItems[0] ? allItems[0].id : 1, 'single', false); });
        expect(await page.evaluate(() => document.getElementById('resubmitFilesPicked').innerHTML === ''), '重开重修弹窗 → chips 清空');
        await page.evaluate(() => closeModal('resubmitModal'));

        // ===== U5 已上传附件 lightbox 预览（U2 commit）=====
        console.log('\nU5. 附件 lightbox 预览');
        // U5/U5b 全段统一 mock 附件静态资源（lightbox img.src / 缩略图 src 都会真发请求，防 404 console 噪音）
        const pngBuf = fs.readFileSync(tmp.png1);
        await page.route('**/uploads/correction/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: pngBuf }));
        const lb1 = await page.evaluate(() => {
            openLightbox('/uploads/correction/1/demo.png', 'demo"图.png');
            return {
                shown: document.getElementById('imgLightbox').classList.contains('show'),
                src: document.getElementById('imgLightboxImg').getAttribute('src'),
                caption: document.getElementById('imgLightboxCaption').textContent,
                bodyLocked: document.body.style.overflow === 'hidden',
            };
        });
        expect(lb1.shown && lb1.src === '/uploads/correction/1/demo.png', 'openLightbox 展示图片');
        expect(lb1.caption === 'demo"图.png' && lb1.bodyLocked, '含引号 caption 完整展示 + 页面滚动锁定');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const lb2 = await page.evaluate(() => ({
            shown: document.getElementById('imgLightbox').classList.contains('show'),
            srcCleared: !document.getElementById('imgLightboxImg').getAttribute('src'),
            bodyUnlocked: document.body.style.overflow === '',
        }));
        expect(!lb2.shown && lb2.srcCleared && lb2.bodyUnlocked, 'ESC 关闭 + src 清空 + 滚动解锁');
        // 委托监听：注入含双引号文件名的缩略图节点，点击 → lightbox 以解码后原始名开启（无属性逃逸）
        const lb3 = await page.evaluate(() => {
            const host = document.createElement('div');
            host.innerHTML = `<a href="/uploads/correction/1/a.png" target="_blank" rel="noopener" class="corr-att-thumb" id="u5Thumb" data-lightbox-url="/uploads/correction/1/a.png" data-lightbox-caption="a&quot;onmouseover=x.png">t</a>`;
            document.body.appendChild(host);
            document.getElementById('u5Thumb').click();
            const r = {
                shown: document.getElementById('imgLightbox').classList.contains('show'),
                caption: document.getElementById('imgLightboxCaption').textContent,
            };
            closeLightbox(null); host.remove();
            return r;
        });
        expect(lb3.shown && lb3.caption === 'a"onmouseover=x.png', '委托监听开启 + 引号文件名解码正确（无逃逸面）');
        // 详情抽屉真实渲染冒烟（renderAtts 分层分支跑真数据，靠 P 段 0 console error 兜底）
        await page.evaluate(() => openDrawer(allItems[0] ? allItems[0].id : 1));
        await page.waitForTimeout(600);
        expect(await page.evaluate(() => document.getElementById('drawer').classList.contains('open')), '详情抽屉真实渲染打开（renderAtts 新分支冒烟）');
        await page.evaluate(() => closeDrawer());

        // ===== U5b 生产渲染链路断言（M-2 拍板补：route mock 详情接口附件，真实 renderAtts 渲染）=====
        console.log('\nU5b. 附件渲染链路（真实 renderAtts + 恶意文件名）');
        await page.route(/\/api\/corrections\/\d+$/, async route => {
            const resp = await route.fetch();
            const json = await resp.json();
            json.attachments = [
                { id: 9001, attachment_type: 'error_proof', file_name: 'correction/999/img.png', original_name: 'a"&<图.png', uploaded_by_name: '测试', created_at: '2026-07-23 12:00:00' },
                { id: 9002, attachment_type: 'error_proof', file_name: 'correction/999/doc.pdf', original_name: '说明.pdf', uploaded_by_name: '测试', created_at: '2026-07-23 12:00:00' },
                { id: 9003, attachment_type: 'error_proof', file_name: 'correction/999/list.xlsx', original_name: '清单&quot;怪.xlsx', uploaded_by_name: '测试', created_at: '2026-07-23 12:00:00' },
            ];
            await route.fulfill({ response: resp, json });
        });
        await page.evaluate(() => openDrawer(allItems[0] ? allItems[0].id : 1));
        await page.waitForTimeout(600);
        const u5b = await page.evaluate(() => {
            const body = document.getElementById('drawerBody');
            const thumb = body.querySelector('img.corr-att-thumb');
            const nameLink = [...body.querySelectorAll('a.corr-att-thumb')].find(a => (a.textContent || '').includes('图.png'));
            const pdfLink = [...body.querySelectorAll('a')].find(a => (a.textContent || '').includes('说明.pdf'));
            const xlsxLink = [...body.querySelectorAll('a')].find(a => (a.getAttribute('download') || '').includes('清单'));
            const injected = [...body.querySelectorAll('*')].some(el => el.hasAttribute('onmouseover'));
            return {
                thumbTitle: thumb && thumb.getAttribute('title'),
                thumbCaption: thumb && thumb.getAttribute('data-lightbox-caption'),
                nameHref: nameLink && nameLink.getAttribute('href'),
                nameTarget: nameLink && nameLink.getAttribute('target'),
                pdfTarget: pdfLink && pdfLink.getAttribute('target'),
                pdfRel: pdfLink && pdfLink.getAttribute('rel'),
                xlsxDownload: xlsxLink && xlsxLink.getAttribute('download'),
                injected,
            };
        });
        expect(u5b.thumbTitle === 'a"&<图.png（点击放大）', `恶意图片名 title 解码完整（实际 ${u5b.thumbTitle}）`);
        expect(u5b.thumbCaption === 'a"&<图.png', 'data-lightbox-caption 无双重转义/欠转义');
        expect(!u5b.injected, '未逃逸出任何 onmouseover 属性（生产链路 XSS 防线）');
        expect(!!u5b.nameHref && u5b.nameHref.startsWith('/uploads/') && u5b.nameTarget === '_blank', '图片名链接=真实 URL + 新标签回退（L-2）');
        expect(u5b.pdfTarget === '_blank' && u5b.pdfRel === 'noopener', 'PDF 链接 target/rel 正确');
        expect(u5b.xlsxDownload === '清单&quot;怪.xlsx', `xlsx download 属性=字面量 &quot; 原名无二次解码（实际 ${u5b.xlsxDownload}）`);
        await page.evaluate(() => { document.querySelector('#drawerBody img.corr-att-thumb').click(); });
        const u5bCap = await page.evaluate(() => ({
            shown: document.getElementById('imgLightbox').classList.contains('show'),
            caption: document.getElementById('imgLightboxCaption').textContent,
        }));
        expect(u5bCap.shown && u5bCap.caption === 'a"&<图.png', '点击真实渲染缩略图 → lightbox caption=原始名');
        await page.evaluate(() => closeLightbox(null));
        await page.unroute(/\/api\/corrections\/\d+$/);
        await page.unroute('**/uploads/correction/**');
        await page.evaluate(() => closeDrawer());

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
