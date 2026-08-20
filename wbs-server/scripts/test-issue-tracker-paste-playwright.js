/**
 * S5 前端 Playwright 冒烟——需求跟踪重型页（Issue_Tracker.html）Ctrl+V 贴图共享层接入
 * 方案 docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二/§三
 * 对齐 test-corr-paste-playwright.js / test-issue-lite-paste-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 覆盖（S5 交付物 §2 最低要求：基本流 + 0 console error）：
 *   T1 建单弹窗打开，唯一目标 formAttachments 可见 → 纯图粘贴自动收入（DataTransfer 追加语义，
 *      保留已选文件），走既有提交时读取链路（前端无预校验，全靠后端）
 *   T2 焦点在需求描述 textarea + 图文混合粘贴 → 放行，不收附件
 *   T3 弹窗关闭后粘贴 → 不收（0 候选，toast 提示）
 *   T4 全程 0 console error
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-issue-tracker-paste-playwright.js
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
        const p = path.join(SCREENSHOT_DIR, `tr-paste-fail-${name}.png`);
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
    console.log('\n══════ S5 前端 Playwright 冒烟（需求跟踪 贴图共享层接入） ══════');

    const browser = await chromium.launch();
    try {
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Issue_Tracker.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // ═══════════════════════════════════════════════════════════
        // T1：建单弹窗打开，唯一目标 formAttachments 可见 → 纯图粘贴自动收入
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1：建单弹窗打开，纯图粘贴自动收入 formAttachments ──');
        await page.evaluate(() => openCreateModal());
        await page.waitForSelector('#createModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const targetVisible1 = await page.evaluate(() => UPaste.isVisible(document.getElementById('formAttachments')));
        await shotOnFail(page, targetVisible1, 't1-target-visible', `T1 前置：formAttachments 可见（UPaste.isVisible 口径，实得=${targetVisible1}）`);
        const r1 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1.defaultPrevented === true, 't1-default-prevented', `T1 defaultPrevented=true（实得=${r1.defaultPrevented}）`);
        await page.waitForTimeout(300);
        // S2（2026-08-05）：formAttachments 已升级数组持态——onchange/贴图 collect 后立即清空 input.value
        //   （input 不再是真相源），改断言 trPickerFiles() 数组。
        const files1 = await page.evaluate(() => trPickerFiles().map(f => f.name));
        await shotOnFail(page, files1.length === 1 && /^粘贴截图_/.test(files1[0] || ''), 't1-file-collected', `T1 trPickerFiles() 收入 1 个粘贴截图（实得=${JSON.stringify(files1)}）`);
        const inputCleared1 = await page.evaluate(() => document.getElementById('formAttachments').value === '');
        await shotOnFail(page, inputCleared1, 't1-input-cleared', 'T1 裸 input.value 贴图后立即清空（数组才是真相源）');
        const previewImgs1 = await page.locator('#attachmentPreview img').count();
        await shotOnFail(page, previewImgs1 === 1, 't1-preview-rendered', `T1 预览区渲染贴图缩略图（img 数=${previewImgs1}）`);

        // ═══════════════════════════════════════════════════════════
        // T1b（codex S5 复审 L3 采纳，S2 改用 trPickerFiles() 断言）：追加语义——先用 setInputFiles
        // 模拟用户已经通过文件选择器选过一个（真实触发 onchange/trPickerOnPick，非直接改 input.files
        // 绕过收集链），贴图后原文件必须还在 + 长度 +1（证明是数组追加，不是整体覆盖）；再贴第二次
        // 继续验证单调递增。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1b：追加语义——预置文件 + 两次贴图均追加，不覆盖已选文件 ──');
        await page.setInputFiles('#formAttachments', { name: 'manual-selected.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('a,b\n1,2') });
        await page.waitForTimeout(150);
        const preNames1b = await page.evaluate(() => trPickerFiles().map(f => f.name));
        await shotOnFail(page, preNames1b.length === 2 && preNames1b.includes('manual-selected.xlsx'), 't1b-pre-injected', `T1b 前置：手动预置 1 个已选文件（累计 T1 的贴图，实得=${JSON.stringify(preNames1b)}）`);
        const r1b1 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1b1.defaultPrevented === true, 't1b-first-paste-prevented', `T1b 第一次贴图 defaultPrevented=true（实得=${r1b1.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const afterFirst1b = await page.evaluate(() => trPickerFiles().map(f => f.name));
        await shotOnFail(page, afterFirst1b.length === 3 && afterFirst1b.includes('manual-selected.xlsx'), 't1b-append-not-replace', `T1b 第一次贴图：追加而非覆盖，原文件仍在 + 长度=3（实得=${JSON.stringify(afterFirst1b)}）`);
        await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const afterSecond1b = await page.evaluate(() => trPickerFiles().map(f => f.name));
        await shotOnFail(page, afterSecond1b.length === 4 && afterSecond1b.includes('manual-selected.xlsx'), 't1b-second-append', `T1b 第二次贴图：继续追加，长度=4（实得=${JSON.stringify(afterSecond1b)}）`);

        // ═══════════════════════════════════════════════════════════
        // T1c（S2 新增）：删除单张 → 其余保留
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1c：删除单张 → 其余保留 ──');
        await page.evaluate(() => trPickerRemove(0));
        await page.waitForTimeout(100);
        const afterRemove1c = await page.evaluate(() => trPickerFiles().map(f => f.name));
        await shotOnFail(page, afterRemove1c.length === 3 && !afterRemove1c.includes(files1[0]) && afterRemove1c.includes('manual-selected.xlsx'), 't1c-remove-first', `T1c 删除第0项（原贴图）→ 剩3项、已删项不在、其余（含 manual-selected.xlsx）保留（实得=${JSON.stringify(afterRemove1c)}）`);

        // ═══════════════════════════════════════════════════════════
        // T2（S2·第三缺陷修复语义反转 + 指定为"单候选页 dual 端到端用例"，拍板出处 memory
        //   paste_defect_leads.md 2026-08-20 用户决策之二·双通道投递）：焦点在需求描述 textarea + 图文
        //   混合粘贴 → 双通道：文本不拦截（进输入框）+ 图片同步投递（进附件区）。本页 #formAttachments
        //   是整页唯一注册候选（真·单候选页，非"某弹窗内唯一"），归属零歧义，是本批"单候选页图文混合+
        //   焦点输入框→文本落框+图片落区双断言"新增 dual 端到端用例的落点。原断言"未收附件"把丢图钉死
        //   在案，需反转。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T2：焦点在需求描述 textarea + 图文混合粘贴 → 双通道（文本不拦截+图片同步投递，单候选页端到端） ──');
        const beforeCount2 = await page.evaluate(() => trPickerFiles().length);
        const r2 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '需求描述混合粘贴文本', focusSelector: '#formDescription' });
        // 文本通道：defaultPrevented=false 是文本能落进 textarea 的必要条件——本层监听器未拦截，把默认
        //   粘贴处理权原样交还浏览器（真实 OS 级粘贴场景下这就是文本落框；合成事件在 Chromium 下是否
        //   真执行原生插入是测试工具层面的已知限制，不是本模块行为，不影响这条断言本身的正确性）。
        await shotOnFail(page, r2.defaultPrevented === false, 't2-text-channel-not-prevented', `T2 文本通道：e.defaultPrevented=false（不拦截，实得=${r2.defaultPrevented}）`);
        await page.waitForTimeout(300);
        // 图片通道：S2 双通道投递核心断言——若实现仍是旧版"dual 不拦截=不投递"，afterCount2 会等于
        //   beforeCount2（这条会红，即预筛描述的"图文混合静默丢图"第三缺陷复现）。
        const afterFiles2 = await page.evaluate(() => trPickerFiles().map(f => f.name));
        const afterCount2 = afterFiles2.length;
        await shotOnFail(page, afterCount2 === beforeCount2 + 1, 't2-image-channel-delivered', `T2 图片通道：图片同步投递进 formAttachments，附件数 +1（前=${beforeCount2}/后=${afterCount2}，若实现退化回旧版丢图这条会红）`);
        const pastedName2 = afterFiles2[afterFiles2.length - 1];
        await shotOnFail(page, /^粘贴截图_/.test(pastedName2 || ''), 't2-image-channel-name', `T2 图片通道：新投递文件名以"粘贴截图_"开头（实得="${pastedName2}"）`);

        // ═══════════════════════════════════════════════════════════
        // T3：弹窗关闭后粘贴 → 不收（0 候选，toast 提示）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T3：弹窗关闭后粘贴 → 不收（0 候选，toast 提示） ──');
        await page.evaluate(() => document.getElementById('createModal').classList.remove('open'));
        await page.waitForTimeout(200);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r3 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r3.defaultPrevented === true, 't3-default-prevented', `T3 无可判定目标仍 preventDefault（实得=${r3.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast3 = await page.locator('#toast-container').textContent().catch(() => '');
        const msgNoCandidate3 = await page.evaluate(() => UPaste.MSG_NO_CANDIDATE);
        await shotOnFail(page, toast3.includes(msgNoCandidate3), 't3-toast', `T3 toast 含 UPaste.MSG_NO_CANDIDATE（同源引用="${msgNoCandidate3}"，实得="${toast3}"）`);

        // ═══════════════════════════════════════════════════════════
        // T4：全程 0 console error
        // ═══════════════════════════════════════════════════════════
        await shotOnFail(page, page._consoleErrors.length === 0, 't4-console-clean', `T4 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 需求跟踪贴图接入 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 需求跟踪贴图接入 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
