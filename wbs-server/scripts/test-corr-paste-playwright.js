/**
 * S4 前端 Playwright 冒烟——数据修正页 Ctrl+V 贴图共享层接入
 * 方案 docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二/§三
 * 对齐 test-sys-paste-playwright.js / test-quick-log-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-corr-paste-playwright.js
 *
 * 覆盖（S4 交付物 §3 最低要求 5 项 + 1 项数组类路径覆盖）：
 *   T1 完成弹窗(single 型)：唯一可见目标 formCompleteFiles/completeFilesPicked → 纯图粘贴自动收入
 *   T1b 补充附件弹窗(attachModal，数组类路径)：粘贴收入 corrAttachFiles 数组 + corrAttachPreview 预览
 *       （验证 corrAttachCollectFiles 校验闸门复用——去重/数量上限/白名单与文件选择完全同源）
 *   T2 完成弹窗内焦点在文字说明 textarea + 图文混合粘贴 → 放行默认粘贴，不收附件
 *   T3 建单弹窗：createOaProofPicked + createErrProofPicked 同时可见（2 候选）→ 不猜，toast 提示
 *   T4 弹窗全部关闭后粘贴 → 不收（0 候选，toast 提示，不误伤任何输入框状态）
 *   T5 全程 0 console error
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `corr-paste-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); } catch (_) { /* ignore */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function dispatchPaste(page, { withImage = true, withText = false, textValue = '', textType = 'text/plain', focusSelector = null } = {}) {
    return page.evaluate(({ b64, withImage, withText, textValue, textType, focusSelector }) => {
        const dt = new DataTransfer();
        if (withImage) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
        }
        if (withText) dt.items.add(textValue, textType);
        if (focusSelector) { const el = document.querySelector(focusSelector); if (el) el.focus(); }
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.dispatchEvent(evt);
        return { defaultPrevented: evt.defaultPrevented };
    }, { b64: TINY_PNG_B64, withImage, withText, textValue, textType, focusSelector });
}

async function main() {
    const adminTok = await fx.signAs(fx.ADMIN_ID);
    console.log('\n══════ S4 前端 Playwright 冒烟（数据修正 贴图共享层接入） ══════');

    const browser = await chromium.launch();
    try {
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Data_Correction.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        const anyId = await page.evaluate(() => (window.allItems && allItems[0] && allItems[0].id) || 1);

        // ═══════════════════════════════════════════════════════════
        // T1：完成弹窗(single) 唯一可见目标 → 纯图粘贴自动收入
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1：完成弹窗(single) 唯一可见目标自动收入贴图 ──');
        await page.evaluate((id) => openComplete(id, 'single', false), anyId);
        await page.waitForSelector('#completeModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const batchVisible1 = await page.locator('#completeBatchGroup').isVisible();
        await shotOnFail(page, batchVisible1 === false, 't1-batch-hidden', `T1 前置：single 型 completeBatchGroup 隐藏（实得可见=${batchVisible1}）`);
        const r1 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1.defaultPrevented === true, 't1-default-prevented', `T1 defaultPrevented=true（实得=${r1.defaultPrevented}）`);
        await page.waitForTimeout(300);
        // S1（2026-08-04）：裸 input 已升级数组持态——onchange/贴图 collect 后立即清空 input.value
        //   （input 不再是真相源），改断言 corrPickerFiles('completeFilesPicked') 数组 + 预览渲染。
        const filesCount1 = await page.evaluate(() => corrPickerFiles('completeFilesPicked').length);
        await shotOnFail(page, filesCount1 === 1, 't1-file-collected', `T1 completeFilesPicked picker 数组收入 1 个（实得=${filesCount1}）`);
        const inputCleared1 = await page.evaluate(() => document.getElementById('formCompleteFiles').value === '');
        await shotOnFail(page, inputCleared1, 't1-input-cleared', 'T1 裸 input.value 贴图后立即清空（数组才是真相源）');
        const pastedName1 = await page.evaluate(() => { const f = corrPickerFiles('completeFilesPicked'); return f[0] && f[0].name; });
        await shotOnFail(page, /^粘贴截图_.*\.png$/.test(pastedName1 || ''), 't1-pasted-name', `T1 贴图文件名符合命名规则（实得="${pastedName1}"）`);
        const previewImgs1 = await page.locator('#completeFilesPicked img').count();
        await shotOnFail(page, previewImgs1 === 1, 't1-preview-rendered', `T1 预览区渲染贴图缩略图（img 数=${previewImgs1}）`);
        await page.evaluate(() => closeModal('completeModal'));
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T1b：补充附件弹窗（数组类路径）—— corrAttachCollectFiles 校验闸门复用
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1b：补充附件弹窗（数组类路径）贴图收入 corrAttachFiles + 预览 ──');
        await page.evaluate((id) => openAttach(id), anyId);
        await page.waitForSelector('#attachModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const before1b = await page.evaluate(() => corrAttachFiles.length);
        await shotOnFail(page, before1b === 0, 't1b-pre-empty', `T1b 前置：corrAttachFiles=0（实得=${before1b}）`);
        const r1b = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1b.defaultPrevented === true, 't1b-default-prevented', `T1b defaultPrevented=true（实得=${r1b.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const after1b = await page.evaluate(() => corrAttachFiles.length);
        await shotOnFail(page, after1b === 1, 't1b-array-collected', `T1b corrAttachFiles 数组收入 1 项（实得=${after1b}）`);
        const previewImgs1b = await page.locator('#corrAttachPreview img').count();
        await shotOnFail(page, previewImgs1b === 1, 't1b-preview-rendered', `T1b corrAttachPreview 渲染 1 张缩略图（实得=${previewImgs1b}）`);
        // 连续粘贴 2 次同图 → 校验闸门里的"去重"判据（name+size+lastModified）因文件名各自带序号而不同，
        //   两次均应成功入选（与建单优化批贴图既有语义一致，非漏测去重——去重仅拦截真正同名同大小同修改时间的选择）
        await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const after1b2 = await page.evaluate(() => corrAttachFiles.length);
        await shotOnFail(page, after1b2 === 2, 't1b-second-paste-collected', `T1b 再次粘贴 → 累计恰好 2 项（首次1项+本次1项，各自独立命名不误判重复，实得=${after1b2}）`);
        await page.evaluate(() => closeModal('attachModal'));
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // LOW-3（codex S4 复审采纳）：corrAttachCollectFiles 校验闸门同源断言——page.evaluate 直调该函数
        //   （非经由 paste），验证贴图 collect 适配器复用的正是这同一份闸门逻辑：去重/数量上限/白名单/
        //   大小四项。超 20MB 用 Object.defineProperty 复写 File.size（浏览器允许在实例上新建同名 own
        //   property 遮蔽 Blob.prototype 的 size getter）构造，不真造 20MB 内容——更快更轻量，且
        //   corrAttachCollectFiles 判的就是 f.size 这个值本身，复写后读到的正是该函数实际读取的值。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── LOW-3：corrAttachCollectFiles 校验闸门同源断言（直调，非经 paste） ──');
        const gateResults = await page.evaluate(() => {
            const out = {};
            // ① 同 name/size/lastModified 两个 File 只进 1 个（去重）
            corrAttachFiles = [];
            const dupA = new File([new Uint8Array([1, 2, 3])], 'dup.png', { type: 'image/png', lastModified: 1000 });
            const dupB = new File([new Uint8Array([1, 2, 3])], 'dup.png', { type: 'image/png', lastModified: 1000 });
            corrAttachCollectFiles([dupA, dupB]);
            out.dedupCount = corrAttachFiles.length;

            // ② 超数量上限（CORR_ATTACH_MAX=5）：6 个只收 5 个
            corrAttachFiles = [];
            const many = [];
            for (let i = 0; i < 6; i++) many.push(new File([new Uint8Array([i])], `f${i}.png`, { type: 'image/png' }));
            corrAttachCollectFiles(many);
            out.overLimitCount = corrAttachFiles.length;

            // ③ 白名单外扩展名（CORR_ATTACH_EXTS 不含 .exe）
            corrAttachFiles = [];
            const badExt = new File([new Uint8Array([1])], 'evil.exe', { type: 'application/octet-stream' });
            corrAttachCollectFiles([badExt]);
            out.badExtCount = corrAttachFiles.length;

            // ④ 超 20MB（CORR_ATTACH_MAX_SIZE）：Object.defineProperty 复写 size
            corrAttachFiles = [];
            const bigFile = new File([new Uint8Array([1])], 'big.png', { type: 'image/png' });
            Object.defineProperty(bigFile, 'size', { value: 21 * 1024 * 1024, configurable: true });
            out.oversizeActual = bigFile.size;   // 佐证复写生效
            corrAttachCollectFiles([bigFile]);
            out.oversizeCount = corrAttachFiles.length;

            corrAttachFiles = [];   // 收尾清空，不残留进后续用例
            return out;
        });
        await shotOnFail(page, gateResults.dedupCount === 1, 'low3-dedup', `LOW-3① 同name/size/lastModified 两个 File 只进 1 个（实得=${gateResults.dedupCount}）`);
        await shotOnFail(page, gateResults.overLimitCount === 5, 'low3-over-limit', `LOW-3② 超数量上限(6个)只收 5 个（CORR_ATTACH_MAX，实得=${gateResults.overLimitCount}）`);
        await shotOnFail(page, gateResults.badExtCount === 0, 'low3-bad-ext', `LOW-3③ 白名单外扩展名(.exe)被拒（实得=${gateResults.badExtCount}）`);
        await shotOnFail(page, gateResults.oversizeActual === 21 * 1024 * 1024, 'low3-size-override-works', `LOW-3④ 前置：Object.defineProperty 复写 File.size 生效（实得=${gateResults.oversizeActual}）`);
        await shotOnFail(page, gateResults.oversizeCount === 0, 'low3-oversize', `LOW-3④ 超 20MB 文件被拒（实得=${gateResults.oversizeCount}）`);

        // ═══════════════════════════════════════════════════════════
        // T2：完成弹窗内焦点在文字说明 + 图文混合 → 放行，不收附件
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T2：图文混合 + 焦点在完成说明 textarea → 放行默认粘贴，不收附件 ──');
        await page.evaluate((id) => openComplete(id, 'single', false), anyId);
        await page.waitForSelector('#completeModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const beforeCount2 = await page.evaluate(() => document.getElementById('formCompleteFiles').files.length);
        const r2 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '完成说明混合粘贴文本', focusSelector: '#formCompleteSingleNote' });
        await shotOnFail(page, r2.defaultPrevented === false, 't2-default-not-prevented', `T2 图片+文本+可编辑焦点 → e.defaultPrevented=false（实得=${r2.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const afterCount2 = await page.evaluate(() => document.getElementById('formCompleteFiles').files.length);
        await shotOnFail(page, afterCount2 === beforeCount2, 't2-no-attachment-added', `T2 未收附件（前=${beforeCount2}/后=${afterCount2}）`);
        await page.evaluate(() => closeModal('completeModal'));
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T3：建单弹窗 2 目标同时可见（OA截图 + 待修复数据）→ 不猜，toast 提示
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T3：建单弹窗 2 个目标同时可见 → 不猜，toast「请先点击目标附件区再粘贴」 ──');
        await page.evaluate(() => openCreateModal());
        await page.waitForSelector('#createModal.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        // 前置探测发现（非猜测）：新建单默认只有「待修复数据」目标可见——「OA 流程截图」区(oaProofGroup)
        // 默认 display:none，仅填写真实 OA 流程号（OA_NUMBER_RE 命中）后 toggleOaMode() 才会揭示。
        // 要构造"2 目标同时可见"场景须先触发这一联动。
        await page.fill('#formOaNumber', '364265');
        await page.evaluate(() => toggleOaMode());
        await page.waitForTimeout(150);
        // 用 UPaste.isVisible()（被测库的真实可见性判据）而非 Playwright 自带 .isVisible()——两者口径不同：
        // Playwright 的 isVisible() 额外要求非零宽高包围盒，而这两个候选容器是空 chip 预览 div（未选文件时
        // 高度恰为 0，但仍在渲染树里、有真实 getClientRects()），会被 Playwright 误判"不可见"（实测坐实：
        // getBoundingClientRect().height === 0 但 getClientRects().length === 1）。被测库判定用的是后者，
        // 断言口径须与被测代码同源，否则测的是"我以为它测什么"而不是"它实际测什么"。
        const oaVisible = await page.evaluate(() => UPaste.isVisible(document.getElementById('createOaProofPicked')));
        const epVisible = await page.evaluate(() => UPaste.isVisible(document.getElementById('createErrProofPicked')));
        await shotOnFail(page, oaVisible && epVisible, 't3-both-visible', `T3 前置：2 个目标同时可见（UPaste.isVisible 口径，OA=${oaVisible}, 待修复=${epVisible}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r3 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r3.defaultPrevented === true, 't3-default-prevented', `T3 仍 preventDefault（不猜也拦，实得=${r3.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast3 = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast3.includes('请先点击目标附件区再粘贴'), 't3-toast', `T3 toast 含"请先点击目标附件区再粘贴"（实得="${toast3}"）`);
        const oaFiles3 = await page.evaluate(() => document.getElementById('formOaProofFiles').files.length);
        const epFiles3 = await page.evaluate(() => document.getElementById('formErrorProofFiles').files.length);
        await shotOnFail(page, oaFiles3 === 0 && epFiles3 === 0, 't3-neither-collected', `T3 两个目标均未误收（OA=${oaFiles3}, 待修复=${epFiles3}）`);
        await page.evaluate(() => closeModal('createModal'));
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T4：弹窗全部关闭后粘贴 → 不收（0 候选）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T4：弹窗全部关闭后粘贴 → 不收（0 候选，toast 提示） ──');
        const modalOpenCount4 = await page.locator('.u-modal-overlay.open').count();
        await shotOnFail(page, modalOpenCount4 === 0, 't4-no-modal-open', `T4 前置：无弹窗打开（实得=${modalOpenCount4}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r4 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r4.defaultPrevented === true, 't4-default-prevented', `T4 无可判定目标仍 preventDefault（实得=${r4.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast4 = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast4.includes('请先点击目标附件区再粘贴'), 't4-toast', `T4 toast 提示（实得="${toast4}"）`);

        // ═══════════════════════════════════════════════════════════
        // T4b（codex S4 复审 LOW-1 采纳）：两个弹窗人为同时 open（正常操作路径不可达的异常态，防御性
        //   验证）→ corrPasteScopeResolver 不猜、不回落顶层 document，显式空作用域 → 0 候选 → toast，
        //   两个弹窗内所有目标均未被误收。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T4b：两个弹窗人为同时 open（异常态）→ 不猜不回落，toast 提示 ──');
        await page.evaluate(() => {
            document.getElementById('createModal').classList.add('open');
            document.getElementById('completeModal').classList.add('open');
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r4b = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r4b.defaultPrevented === true, 't4b-default-prevented', `T4b 仍 preventDefault（实得=${r4b.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast4b = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast4b.includes('请先点击目标附件区再粘贴'), 't4b-toast', `T4b toast 提示（实得="${toast4b}"）`);
        const oaFiles4b = await page.evaluate(() => document.getElementById('formOaProofFiles').files.length);
        const epFiles4b = await page.evaluate(() => document.getElementById('formErrorProofFiles').files.length);
        const completeFiles4b = await page.evaluate(() => document.getElementById('formCompleteFiles').files.length);
        await shotOnFail(page, oaFiles4b === 0 && epFiles4b === 0 && completeFiles4b === 0, 't4b-nothing-collected', `T4b 两个弹窗内所有目标均未误收（OA=${oaFiles4b}, 待修复=${epFiles4b}, 完成=${completeFiles4b}）`);
        await page.evaluate(() => {
            document.getElementById('createModal').classList.remove('open');
            document.getElementById('completeModal').classList.remove('open');
        });

        // ═══════════════════════════════════════════════════════════
        // T5：全程 0 console error
        // ═══════════════════════════════════════════════════════════
        await shotOnFail(page, page._consoleErrors.length === 0, 't5-console-clean', `T5 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 数据修正贴图接入 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 数据修正贴图接入 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
