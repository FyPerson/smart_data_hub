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
    // U4c（S1 max=5 真实拦截用例）：超5个文件提交触发后端 multer 400，浏览器同样打一条网络层
    // resource 日志——同上豁免范式，仅在该用例段内生效，防掩盖其他接口意外 400 的回归。
    let allow400 = false;
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (allow409 && /Failed to load resource.*409/.test(m.text())) return;
        if (allow400 && /Failed to load resource.*400/.test(m.text())) return;
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

        // ===== U4 裸 input 类附件 picker（S1 2026-08-04：数组持态 + 缩略图预览 + 单张删除）=====
        //   取代原"裸 input chips 预览"（renderPickedChips，纯展示 input.files，重选即覆盖、无删除入口）——
        //   用户痛点：Ctrl+V 贴图是追加语义，但没有删除入口，贴错一张只能重选清空全部。
        console.log('\nU4. 裸 input 类附件 picker（数组+缩略图预览+单张删除）');
        expect(await page.evaluate(() => typeof renderPickedChips === 'undefined'), '旧 renderPickedChips 已退役');
        expect(await page.evaluate(() => typeof corrAppendFilesToInput === 'undefined'), '旧 corrAppendFilesToInput 已退役（S4 贴图追加改走 corrPickerCollect）');
        expect(await page.evaluate(() => typeof corrPickerOnPick === 'function' && typeof corrPickerRemove === 'function' && typeof corrPickerReset === 'function' && typeof corrPickerFiles === 'function'), 'corrPickerOnPick/Remove/Reset/Files 共享处理器均存在');
        const anyId = await page.evaluate(() => (window.allItems && allItems[0] && allItems[0].id) || 1);

        // ── U4a 建单表单：OA 截图（图片缩略图分支）+ 待修复数据（非图片图标分支）──
        //   codex LOW 复审同款隐患自查：oaProofGroup（含 formOaProofFiles/createOaProofPicked）默认
        //   display:none，仅填写真实 OA 流程号触发 toggleOaMode() 才会显示（见 L1751）——不先填号直接
        //   setInputFiles 同样是"测隐藏 input"，故这里补上前置步骤，对齐用户真实可达路径。
        await page.evaluate(() => openCreateModal());
        await page.fill('#formOaNumber', '364265');
        await page.evaluate(() => toggleOaMode());
        await page.waitForTimeout(100);
        const oaGroupVisible = await page.locator('#formOaProofFiles').isVisible();
        expect(oaGroupVisible, `填真实 OA 流程号后 formOaProofFiles 确实可见（实际 ${oaGroupVisible}）`);
        await page.setInputFiles('#formOaProofFiles', [tmp.png1]);
        await page.waitForTimeout(150);
        let oaArr = await page.evaluate(() => corrPickerFiles('createOaProofPicked').length);
        let oaItems = await page.evaluate(() => document.querySelectorAll('#createOaProofPicked .corr-picker-item').length);
        let oaImgs = await page.evaluate(() => document.querySelectorAll('#createOaProofPicked img').length);
        expect(oaArr === 1 && oaItems === 1, `OA截图选1文件 → picker数组1项+预览1项（实际 ${oaArr}/${oaItems}）`);
        expect(oaImgs === 1, `OA截图图片渲染缩略图（实际 ${oaImgs}）`);

        await page.setInputFiles('#formErrorProofFiles', [tmp.xlsx]);
        await page.waitForTimeout(150);
        let epArr = await page.evaluate(() => corrPickerFiles('createErrProofPicked').length);
        let epItems = await page.evaluate(() => document.querySelectorAll('#createErrProofPicked .corr-picker-item').length);
        let epIcon = await page.evaluate(() => document.getElementById('createErrProofPicked').innerHTML.includes('📊'));
        expect(epArr === 1 && epItems === 1, `待修复数据选1文件 → picker数组1项+预览1项（实际 ${epArr}/${epItems}）`);
        expect(epIcon, '待修复数据 xlsx 渲染 📊 占位图标（非图片分支）');

        // 追加而非覆盖（贴图/重选均走追加语义）+ 单张删除（其余保留）
        await page.setInputFiles('#formOaProofFiles', [tmp.png2]);
        await page.waitForTimeout(150);
        let oaArr2 = await page.evaluate(() => corrPickerFiles('createOaProofPicked').length);
        expect(oaArr2 === 2, `再次选择 → 追加而非覆盖（实际 ${oaArr2}）`);
        await page.evaluate(() => corrPickerRemove('createOaProofPicked', 0));
        await page.waitForTimeout(100);
        const afterRemove = await page.evaluate(() => {
            const f = corrPickerFiles('createOaProofPicked');
            return { len: f.length, name: f[0] && f[0].name };
        });
        expect(afterRemove.len === 1 && afterRemove.name === 'proof_b.png', `删除第1项 → 剩1项且保留其余未删项（实际 ${afterRemove.len}/${afterRemove.name}）`);

        // display 切换①：新建态 createErrProofPicked 显示（对齐 L1550）
        const createDisplay = await page.evaluate(() => document.getElementById('createErrProofPicked').style.display);
        expect(createDisplay !== 'none', `新建态 createErrProofPicked 显示（实际 display="${createDisplay}"）`);

        // 清理点①：重开建单弹窗 → OA截图+待修复数据两个 picker 数组与预览均清空（corrPickerReset）
        await page.evaluate(() => { closeCreateModal(); openCreateModal(); });
        const createReset = await page.evaluate(() => ({
            oaLen: corrPickerFiles('createOaProofPicked').length,
            epLen: corrPickerFiles('createErrProofPicked').length,
            oaHtml: document.getElementById('createOaProofPicked').innerHTML,
            epHtml: document.getElementById('createErrProofPicked').innerHTML,
        }));
        expect(createReset.oaLen === 0 && createReset.epLen === 0 && createReset.oaHtml === '' && createReset.epHtml === '', '重开建单弹窗 → OA截图+待修复数据 picker 数组与预览均清空');

        // display 切换②：编辑态 createErrProofPicked+input 隐藏（mock 详情接口 can_edit=true 进 openEditCorrection）
        //   先在可见态选1个文件，制造"有文件待清"的前置条件（若不选，数组本就是空，测不出清空是否真发生）。
        //   ⭐ 本用例验证的是**不变量**「进入编辑态后该 picker 必为空」，而不是某一行代码的必要性。
        //   codex 审 15 M-2 曾建议在 openEditCorrection 的隐藏分支补 corrPickerReset 防"隐藏态附件仍被提交"；
        //   实测反证（补上后再注释掉，断言不变红）证明该路径不可达——openEditCorrection 第一步即调
        //   openCreateModal()，其中的 corrPickerReset('createErrProofPicked') 已先一步清空数组/预览/input。
        //   故该防御行**已删除**（死代码 + 声称超实现的注释=双重误导），不变量改由 openCreateModal 内那行
        //   reset 承担，该处已加 ⭐ 注释标明这一依赖。若将来出现绕开 openCreateModal() 直接隐藏该区的路径，
        //   本断言会变红——那正是它存在的意义。
        await page.setInputFiles('#formErrorProofFiles', [tmp.xlsx]);
        await page.waitForTimeout(150);
        const epBeforeEdit = await page.evaluate(() => corrPickerFiles('createErrProofPicked').length);
        expect(epBeforeEdit === 1, `进入编辑态前置：待修复数据已选1个文件（实际 ${epBeforeEdit}）`);
        await page.route(/\/api\/corrections\/\d+$/, route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                can_edit: true,
                request: { id: 88888, correction_type: 'single', oa_number: '364265', source_system: '其他', source_system_other: '测试', location_info: 'x', correction_count: null, reason: 'r', error_proof_note: '', expected_deadline: null, requester_dept: '' },
                requesters: [], group: null,
            }),
        }));
        await page.evaluate(() => openEditCorrection(88888));
        await page.waitForTimeout(150);
        const editDisplay = await page.evaluate(() => ({
            input: document.getElementById('formErrorProofFiles').style.display,
            wrap: document.getElementById('createErrProofPicked').style.display,
        }));
        expect(editDisplay.wrap === 'none' && editDisplay.input === 'none', `编辑态 createErrProofPicked+input 均隐藏（实际 wrap="${editDisplay.wrap}" input="${editDisplay.input}"）`);
        const epAfterEdit = await page.evaluate(() => corrPickerFiles('createErrProofPicked').length);
        expect(epAfterEdit === 0, `进入编辑态（隐藏）后 createErrProofPicked picker 数组已清空，防隐藏态仍被提交（实际 ${epAfterEdit}）`);
        // 切回新建态（重新可见）→ 断言仍为空，不会诈尸复活
        await page.evaluate(() => { closeCreateModal(); openCreateModal(); });
        const epAfterBack = await page.evaluate(() => ({
            len: corrPickerFiles('createErrProofPicked').length,
            html: document.getElementById('createErrProofPicked').innerHTML,
        }));
        expect(epAfterBack.len === 0 && epAfterBack.html === '', `切回新建态（重新可见）→ createErrProofPicked picker 仍为空，不会诈尸复活（实际 ${epAfterBack.len}）`);
        await page.unroute(/\/api\/corrections\/\d+$/);
        await page.evaluate(() => closeCreateModal());

        // ── U4b 完成弹窗（single）：图片+非图片混合预览 + 输入即清空 + 删除 + 清理点② ──
        await page.evaluate((id) => openComplete(id, 'single', false), anyId);
        await page.setInputFiles('#formCompleteFiles', [tmp.png1, tmp.xlsx]);
        await page.waitForTimeout(150);
        const cfLen = await page.evaluate(() => corrPickerFiles('completeFilesPicked').length);
        const cfItems = await page.evaluate(() => document.querySelectorAll('#completeFilesPicked .corr-picker-item').length);
        const cfImgs = await page.evaluate(() => document.querySelectorAll('#completeFilesPicked img').length);
        expect(cfLen === 2 && cfItems === 2, `完成弹窗(single)选2文件 → picker数组2项+预览2项（实际 ${cfLen}/${cfItems}）`);
        expect(cfImgs === 1, `完成弹窗图片渲染缩略图1个（实际 ${cfImgs}）`);
        const cfInputCleared = await page.evaluate(() => document.getElementById('formCompleteFiles').value === '');
        expect(cfInputCleared, '选择后裸 input.value 立即清空（数组才是真相源，防两个真相源打架）');

        await page.evaluate(() => corrPickerRemove('completeFilesPicked', 0));
        await page.waitForTimeout(100);
        const afterCfRemove = await page.evaluate(() => {
            const f = corrPickerFiles('completeFilesPicked');
            return { len: f.length, name: f[0] && f[0].name };
        });
        expect(afterCfRemove.len === 1 && afterCfRemove.name === 'list.xlsx', `完成弹窗删除第1项 → 剩1项且保留其余未删项（实际 ${afterCfRemove.len}/${afterCfRemove.name}）`);

        // 清理点②：重开完成弹窗 → completeFilesPicked 数组与预览均清空
        await page.evaluate((id) => { closeModal('completeModal'); openComplete(id, 'single', false); }, anyId);
        const cfReset = await page.evaluate(() => corrPickerFiles('completeFilesPicked').length === 0 && document.getElementById('completeFilesPicked').innerHTML === '');
        expect(cfReset, '重开完成弹窗 → completeFilesPicked 数组与预览均清空');

        // ── U4c 完成弹窗(batch)：附件点基本选择 + max=5 警示文案 + 提交时后端 multer 真实拦截 ──
        //   （切到 batch 类型弹窗——formBatchNote/formCompleteBatchFiles 只在 batch 类型下可见/可交互；
        //   codex LOW 复审要求核实"测隐藏 input"这类问题是否成对出现——本段已用 openComplete(id,'batch',...)
        //   切模式，先显式断言确实可见，排除"模式切换没生效"的可能，证明这里没有 U4d 那款问题）
        console.log('\nU4c. 完成弹窗(batch) picker + max=5 警示文案 + 提交时后端真实拦截');
        await page.evaluate((id) => openComplete(id, 'batch', false), anyId);
        const cbfVisible = await page.locator('#formCompleteBatchFiles').isVisible();
        expect(cbfVisible, `完成弹窗切到 batch 模式后 formCompleteBatchFiles 确实可见（实际 ${cbfVisible}）`);
        await page.setInputFiles('#formCompleteBatchFiles', [tmp.png2]);
        await page.waitForTimeout(150);
        const cbfLen = await page.evaluate(() => corrPickerFiles('completeBatchFilesPicked').length);
        expect(cbfLen === 1, `完成弹窗(batch附件)选1文件 → picker数组1项（实际 ${cbfLen}）`);

        await page.setInputFiles('#formCompleteBatchFiles', [tmp.png1, tmp.xlsx, tmp.png2, tmp.png1, tmp.xlsx]);   // 追加到已有1个，累计6个（无去重/数量前端校验，硬约束3）
        await page.waitForTimeout(150);
        const overLen = await page.evaluate(() => corrPickerFiles('completeBatchFilesPicked').length);
        expect(overLen === 6, `连续选择不做前端去重/数量校验，累计6个（实际 ${overLen}）`);
        const warnShown = await page.evaluate(() => document.getElementById('completeBatchFilesPicked').innerHTML.includes('最多 5 个文件'));
        expect(warnShown, '超过 max=5 时预览区显示警示文案（沿用原 renderPickedChips 文案）');
        await page.fill('#formBatchNote', '测试批量完成说明超过5个字用于触发后端multer拦截');
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        allow400 = true;   // 本次真实提交预期后端 400（multer limits.files=5），豁免这一条网络层日志
        await page.evaluate(() => submitComplete());
        await page.waitForTimeout(600);
        const toastAfterOver = await page.locator('#toast-container').textContent().catch(() => '');
        const stillOpen = await page.evaluate(() => document.getElementById('completeModal').classList.contains('open'));
        expect(toastAfterOver.includes('上传文件失败'), `超5个文件真实提交 → 后端 multer(limits.files=5) 拒绝，toast 报错（实际="${toastAfterOver}"）`);
        expect(stillOpen, '提交被拒后完成弹窗仍打开（未被误判成功关闭）');
        await page.waitForTimeout(150);   // 等 400 的 console 日志落地后再关豁免（对齐 allow409 范式）
        allow400 = false;
        await page.evaluate(() => closeModal('completeModal'));

        // ── U4d 重修弹窗（single）：选择+预览 + 清理点③ ──
        await page.evaluate((id) => openResubmit(id, 'single', false), anyId);
        await page.setInputFiles('#formResubmitFiles', [tmp.png1]);
        await page.waitForTimeout(150);
        const rsLen = await page.evaluate(() => corrPickerFiles('resubmitFilesPicked').length);
        const rsItems = await page.evaluate(() => document.querySelectorAll('#resubmitFilesPicked .corr-picker-item').length);
        expect(rsLen === 1 && rsItems === 1, `重修弹窗选1文件 → picker数组1项+预览1项（实际 ${rsLen}/${rsItems}）`);
        await page.evaluate((id) => { closeModal('resubmitModal'); openResubmit(id, 'single', false); }, anyId);
        const rsReset = await page.evaluate(() => corrPickerFiles('resubmitFilesPicked').length === 0 && document.getElementById('resubmitFilesPicked').innerHTML === '');
        expect(rsReset, '重开重修弹窗 → resubmitFilesPicked 数组与预览均清空（清理点③）');
        await page.evaluate(() => closeModal('resubmitModal'));

        // ── U4e 重修弹窗（batch）：codex LOW 复审指出——formResubmitBatchFiles 在 single 模式下位于
        //   resubmitBatchGroup（display:none）内，用户走不到；必须先切到 batch 模式该 input 才真实可见，
        //   否则测的是"脚本强行给隐藏 input 赋值"而非真实路径。切模式后先断言确实可见，防"模式切换没生效"
        //   被误判成"选择成功"。
        await page.evaluate((id) => openResubmit(id, 'batch', false), anyId);
        const rbVisible = await page.locator('#formResubmitBatchFiles').isVisible();
        expect(rbVisible, `重修弹窗切到 batch 模式后 formResubmitBatchFiles 确实可见（实际 ${rbVisible}）`);
        await page.setInputFiles('#formResubmitBatchFiles', [tmp.xlsx]);
        await page.waitForTimeout(150);
        const rbLen = await page.evaluate(() => corrPickerFiles('resubmitBatchFilesPicked').length);
        expect(rbLen === 1, `重修弹窗(batch附件)选1文件 → picker数组1项（实际 ${rbLen}）`);
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

        // ===== U6 picker 预览图点击放大（hotfix 20260806·贴图四件②，289-M 收口后更新）=====
        //   建单/编辑弹窗 picker（corrPickerRender）预览图此前 img 无 onclick/无 zoom 光标，点不开大图；
        //   cursor/show 两条断言在修复前必红。
        //   [289-M] lightbox 大图改用独立 URL.createObjectURL(file)（corrZoomUrl），不再复用 picker 缩
        //   略图自身的 CORR_PICKER_URLS[key][idx]——两者现应是不同的 blob URL，关闭后 corrZoomUrl 应被
        //   revoke，picker 缩略图自己的 URL 不受影响。
        console.log('\nU6. picker 预览图点击放大（对齐详情抽屉 lightbox 行为 + 289-M 独立 URL 生命周期）');
        await page.evaluate(() => openCreateModal());
        await page.fill('#formOaNumber', '364266');
        await page.evaluate(() => toggleOaMode());
        await page.waitForTimeout(100);
        await page.setInputFiles('#formOaProofFiles', [tmp.png1]);
        await page.waitForTimeout(150);
        const u6Before = await page.evaluate(() => {
            const img = document.querySelector('#createOaProofPicked .corr-picker-item img');
            return {
                cursor: img ? getComputedStyle(img).cursor : null,
                lightboxShowBefore: document.getElementById('imgLightbox').classList.contains('show'),
                thumbSrcBefore: img ? img.src : null,
            };
        });
        expect(u6Before.cursor === 'zoom-in', `picker 预览图 cursor 为 zoom-in（对齐详情抽屉悬停行为，实际="${u6Before.cursor}"）`);
        expect(!u6Before.lightboxShowBefore, `前置：点击前 imgLightbox 未 show（实际 ${u6Before.lightboxShowBefore}）`);

        // 打点：hook revokeObjectURL（本文件此前未用过该钩子，全局安装不影响其余用例）
        await page.evaluate(() => {
            window.__corrRevokeCalls = [];
            const orig = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = function (u) { window.__corrRevokeCalls.push(u); return orig(u); };
        });

        await page.click('#createOaProofPicked .corr-picker-item img');
        await page.waitForTimeout(150);
        const u6After = await page.evaluate(() => {
            const lb = document.getElementById('imgLightbox');
            const img = document.getElementById('imgLightboxImg');
            const thumb = document.querySelector('#createOaProofPicked .corr-picker-item img');
            return { show: lb.classList.contains('show'), lbSrc: img.src, thumbSrc: thumb.src, caption: document.getElementById('imgLightboxCaption').textContent };
        });
        expect(u6After.show, `点击 picker 预览图后 imgLightbox 出现 show 态（改前 img 无 onclick，本断言红→绿，实际 ${u6After.show}）`);
        expect(u6After.lbSrc.startsWith('blob:'), `lightbox 大图是 blob URL（独立 URL.createObjectURL，实际前缀="${u6After.lbSrc.slice(0, 24)}…"）`);
        expect(u6After.lbSrc !== u6After.thumbSrc, `【289-M】lightbox 大图与 picker 缩略图是两个不同的 objectURL（各自独立生命周期，实际 lbSrc="${u6After.lbSrc.slice(0, 30)}…" thumbSrc="${u6After.thumbSrc.slice(0, 30)}…"）`);
        expect(u6After.caption === 'proof_a.png', `lightbox caption 为文件名（实际="${u6After.caption}"）`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const u6Closed = await page.evaluate(() => document.getElementById('imgLightbox').classList.contains('show'));
        expect(!u6Closed, `ESC 关闭 imgLightbox 后恢复（实际 show=${u6Closed}）`);

        const corrRevokeState = await page.evaluate(() => {
            const thumb = document.querySelector('#createOaProofPicked .corr-picker-item img');
            return { revokeCalls: window.__corrRevokeCalls, thumbSrcAfterClose: thumb ? thumb.src : null };
        });
        expect(corrRevokeState.revokeCalls.includes(u6After.lbSrc), `【289-M】关闭 lightbox 后 URL.revokeObjectURL 被调用且参数恰为 zoom 大图的 URL（实际调用序列=${JSON.stringify(corrRevokeState.revokeCalls)}）`);
        expect(!corrRevokeState.revokeCalls.includes(u6Before.thumbSrcBefore), `【289-M】关闭 lightbox 未误 revoke picker 缩略图自身的 URL（CORR_PICKER_URLS 生命周期不受影响）`);
        expect(corrRevokeState.thumbSrcAfterClose === u6Before.thumbSrcBefore, `【289-M】picker 缩略图 src 关闭前后不变（未被牵连 revoke 导致失效）`);

        await page.evaluate(() => closeCreateModal());

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
