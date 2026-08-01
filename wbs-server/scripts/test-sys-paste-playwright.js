/**
 * 建单优化批 C4 前端 Playwright 冒烟——Ctrl+V 贴图直传（通用组件层）
 * （方案 v1.3 §5，对齐 test-sys-intake-liaison-playwright.js 套件范式：JWT 注入 + login.html 中继）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-paste-playwright.js
 *
 * 覆盖：
 *   T1 建单弹窗打开时仅图片粘贴 → 附件区出现"粘贴截图_*.png"预览
 *   T2 图片+文本混合、焦点在描述 textarea → 不收附件（不拦截，e.defaultPrevented=false）
 *   T3 纯文本粘贴 → 不拦截（e.defaultPrevented=false，无 preventDefault 调用）
 *   T4 连续两次粘贴同一张图 → 两次均成功入选、各自独立命名（不撞车，非误判为重复）
 *   T5 无弹窗场景：0 个可见实例（真实可构造：关闭弹窗后粘贴）+ ≥2 个可见实例（DOM 注入构造，
 *      见下方 T5 段头部说明——现状 UI 全部 picker 实例都建在 siModal 内，"多实例同时可见"在正常
 *      用户操作路径下无法触达，故用页面内注入两个假 siPreview_ 容器来精确触达该分支）
 *      → 两种情形均应 toast「请先点击目标附件区再粘贴」
 *   T6 全程 0 console error
 *
 * ⚠️⚠️ ClipboardEvent 构造方式说明（Playwright 安全限制的实测应对，如实记录）：
 *   `document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt}))` 是**程序化派发**的
 *   合成事件，`isTrusted` 恒为 false（真实 OS 级粘贴才会是 true，Playwright/CDP 无法伪造 isTrusted=true
 *   的用户输入事件）。经实测验证：
 *     - 本模块 paste 监听器不检查 e.isTrusted，合成事件能正常驱动 `siPasteResolveTargetKey` /
 *       `siPickerCollect` / `e.preventDefault()` 等被测逻辑——核心行为断言（是否收附件/是否拦截/
 *       文件名生成/toast）均可用合成事件可靠验证，不受 isTrusted 限制。
 *     - 但 Chromium 对**未信任事件**是否触发"浏览器内置的默认粘贴动作"（即把 clipboardData 的
 *       text/plain 自动写入聚焦的 textarea/input.value）行为不稳定/不可依赖——这是浏览器内部实现，
 *       不是本模块代码逻辑的一部分。故 T2 的断言口径改为：直接读取 `evt.defaultPrevented`
 *       （dispatchEvent 后同步可读，100% 确定性，不依赖浏览器是否真的执行了默认动作）来证明"混合
 *       内容+可编辑焦点分支未调用 preventDefault"，这是本模块代码自身行为的精确度量，且不受合成
 *       事件信任等级影响；textarea 是否真被写入文本作为**附加信息**记录但不作为断言通过/失败的
 *       判据（避免把"浏览器是否执行原生动作"这件不可控的事实伪装成"本模块逻辑正确"的证据）。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
// codex 220 L-4：原硬编码指向某次会话的临时目录，会话结束即失效——失败截图会静默写失败（目录不存在）
// 且无从查阅。改用系统临时目录下固定子目录，每次运行前 mkdirSync recursive 确保存在。
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `paste-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });   // codex 220 L-4：目录可能不存在，截图前确保存在
            await page.screenshot({ path: p });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图本身失败不影响主流程 */ }
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

// 1x1 透明 PNG（业界常用最小测试位图 fixture）。
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// 在页面 JS 上下文内构造 DataTransfer + ClipboardEvent('paste') 并 dispatch 到 document（非真实 OS
// 剪贴板事件，见文件头 isTrusted 说明）。返回 dispatch 后可同步读取的 evt.defaultPrevented，供断言用。
// codex 220 M-5/M-3/M-1 收口后扩展：imageMimes（数组，一次粘贴放几张图/各自 MIME 类型，默认按
// withImage 退化为单张 image/png）+ textType（文本 item 的 MIME，默认 text/plain，M-1 测试用
// text/html 等无 text/plain 的组合）。
async function dispatchPaste(page, { withImage = true, imageMimes = null, withText = false, textValue = '', textType = 'text/plain', focusSelector = null } = {}) {
    const mimes = imageMimes || (withImage ? ['image/png'] : []);
    return page.evaluate(({ b64, mimes, withText, textValue, textType, focusSelector }) => {
        const dt = new DataTransfer();
        for (const mime of mimes) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], 'clipboard-image', { type: mime });
            dt.items.add(file);
        }
        if (withText) dt.items.add(textValue, textType);
        if (focusSelector) {
            const el = document.querySelector(focusSelector);
            if (el) el.focus();
        } else if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.dispatchEvent(evt);
        return { defaultPrevented: evt.defaultPrevented, activeTag: document.activeElement && document.activeElement.tagName };
    }, { b64: TINY_PNG_B64, mimes, withText, textValue, textType, focusSelector });
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    console.log('\n══════ 建单优化批 C4 前端 Playwright 冒烟（Ctrl+V 贴图直传） ══════');

    const browser = await chromium.launch();
    try {
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // ═══════════════════════════════════════════════════════════════
        // T1：建单弹窗打开时仅图片粘贴 → 附件区出现"粘贴截图_*.png"预览
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T1：建单弹窗仅图片粘贴 → 附件区出现"粘贴截图_*.png"预览 ──');
        await page.click('button:has-text("新建迭代单")');
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);

        const beforeCount1 = await page.evaluate(() => (window.siPickerFiles ? siPickerFiles('create-spec').length : -1));
        await shotOnFail(page, beforeCount1 === 0, 't1-pre-empty', `T1 前置：create-spec 附件数=0（实得=${beforeCount1}）`);

        const r1 = await dispatchPaste(page, { withImage: true, withText: false });
        await shotOnFail(page, r1.defaultPrevented === true, 't1-default-prevented', `T1 纯图片粘贴：e.defaultPrevented=true（实得=${r1.defaultPrevented}）`);
        await page.waitForTimeout(200);

        const afterFiles1 = await page.evaluate(() => siPickerFiles('create-spec').map(f => f.name));
        await shotOnFail(page, afterFiles1.length === 1, 't1-file-count', `T1 附件数=1（实得=${JSON.stringify(afterFiles1)}）`);
        const nameOk1 = afterFiles1[0] && /^粘贴截图_\d{8}_\d{6}_\d{3}_\d+\.png$/.test(afterFiles1[0]);
        await shotOnFail(page, nameOk1, 't1-file-name-format', `T1 文件名匹配"粘贴截图_YYYYMMDD_HHMMSS_SSS_N.png"格式（实得="${afterFiles1[0]}"）`);

        const previewImgCount = await page.locator('#siPreview_create-spec img.si-clickable-thumb').count();
        await shotOnFail(page, previewImgCount === 1, 't1-preview-thumb', `T1 预览区出现 1 张缩略图（实得=${previewImgCount}）`);
        const thumbTitle = await page.locator('#siPreview_create-spec img.si-clickable-thumb').first().getAttribute('title');
        await shotOnFail(page, !!(thumbTitle && thumbTitle.startsWith('粘贴截图_')), 't1-preview-title', `T1 缩略图 title 以"粘贴截图_"开头（实得="${thumbTitle}"）`);

        // ═══════════════════════════════════════════════════════════════
        // T2：图片+文本混合、焦点在描述 textarea → 不收附件（不拦截，defaultPrevented=false）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T2：图片+文本混合 + 焦点在描述 textarea → 不收附件（放行默认粘贴） ──');
        const beforeCount2 = (await page.evaluate(() => siPickerFiles('create-spec').length));
        const r2 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '业务方混合粘贴文本', focusSelector: '#f_description' });
        await shotOnFail(page, r2.activeTag === 'TEXTAREA', 't2-focus-is-textarea', `T2 前置：焦点确实在 textarea（实得 activeTag="${r2.activeTag}"）`);
        await shotOnFail(page, r2.defaultPrevented === false, 't2-default-not-prevented', `T2 图片+文本混合+可编辑焦点：e.defaultPrevented=false（放行默认粘贴，实得=${r2.defaultPrevented}）`);
        await page.waitForTimeout(200);
        const afterCount2 = (await page.evaluate(() => siPickerFiles('create-spec').length));
        await shotOnFail(page, afterCount2 === beforeCount2, 't2-no-attachment-added', `T2 未收附件（附件数不变，前=${beforeCount2}/后=${afterCount2}）`);
        // 附加信息（非断言判据，见文件头 isTrusted 说明）：记录浏览器是否真的执行了原生文本插入。
        const textareaVal = await page.locator('#f_description').inputValue().catch(() => '');
        console.log(`     ℹ️ 附加信息（非断言）：合成事件触发后 textarea 实际内容="${textareaVal.replace(/\n/g, '\\n')}"（若浏览器对未信任事件不执行原生粘贴插入，此处可能为空——不影响 T2 通过判定，见文件头说明）`);

        // ═══════════════════════════════════════════════════════════════
        // T3：纯文本粘贴 → 不拦截
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3：纯文本粘贴 → 永不拦截 ──');
        const r3 = await dispatchPaste(page, { withImage: false, withText: true, textValue: '纯文本粘贴内容', focusSelector: '#f_description' });
        await shotOnFail(page, r3.defaultPrevented === false, 't3-default-not-prevented', `T3 纯文本：e.defaultPrevented=false（实得=${r3.defaultPrevented}）`);
        const afterCount3 = (await page.evaluate(() => siPickerFiles('create-spec').length));
        await shotOnFail(page, afterCount3 === afterCount2, 't3-no-attachment-added', `T3 未收附件（附件数不变，实得=${afterCount3}）`);

        // ═══════════════════════════════════════════════════════════════
        // T4：连续两次粘贴同一张图 → 两次均成功入选、各自独立命名（不因序号+毫秒命名而误撞）
        //   ⚠️ 设计口径（如实说明，非踩坑）：本模块文件名生成规则（§5.3）为每次粘贴分配递增序号，
        //   使同一 picker 实例内的合成文件名恒不重复——故"连续粘贴同一张图"不会被既有 name+size+
        //   lastModified 三元去重误判为重复（因为 name 恒不同），两次都会成功加入。这是与"用户从
        //   系统文件选择器重复选中同一物理文件"场景（那种场景 name/lastModified 确实相同，既有去重
        //   逻辑真实生效）刻意不同的行为——去重链本身（siPickerCollect）无差别复用，只是本场景下
        //   它评估出"非重复"这一（对粘贴动作而言）正确结论。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T4：连续两次粘贴同一张图 → 两次均独立成功入选（不误判重复） ──');
        const beforeCount4 = (await page.evaluate(() => siPickerFiles('create-spec').length));
        await dispatchPaste(page, { withImage: true, withText: false, focusSelector: null });
        await page.waitForTimeout(50);
        await dispatchPaste(page, { withImage: true, withText: false, focusSelector: null });
        await page.waitForTimeout(200);
        const afterFiles4 = await page.evaluate(() => siPickerFiles('create-spec').map(f => f.name));
        await shotOnFail(page, afterFiles4.length === beforeCount4 + 2, 't4-both-added', `T4 两次粘贴均成功加入（前=${beforeCount4}，后=${afterFiles4.length}，实得文件名=${JSON.stringify(afterFiles4)}）`);
        const lastTwo = afterFiles4.slice(-2);
        await shotOnFail(page, lastTwo.length === 2 && lastTwo[0] !== lastTwo[1], 't4-distinct-names', `T4 两次粘贴文件名互异（实得=${JSON.stringify(lastTwo)}）`);

        // 关闭建单弹窗（不提交），为 T5 的"无弹窗"场景做准备。直接调用 siCloseModal()（弹窗关闭按钮/
        // 取消按钮 onclick 均绑定此函数，等价于用户点击关闭，且不依赖具体按钮选择器）。
        await page.evaluate(() => siCloseModal());
        await page.waitForTimeout(300);
        const modalClosedForT5 = await page.locator('#siModalOverlay.open').count();
        await shotOnFail(page, modalClosedForT5 === 0, 't4-modal-closed-for-t5', 'T4 后建单弹窗已关闭（为 T5 无弹窗场景做准备）');

        // ═══════════════════════════════════════════════════════════════
        // T5a：无弹窗 + 0 个可见 picker 实例（真实可构造：关闭弹窗后直接粘贴）→ toast 提示
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5a：无弹窗、0 个可见 picker 实例 → toast「请先点击目标附件区再粘贴」 ──');
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r5a = await dispatchPaste(page, { withImage: true, withText: false });
        await shotOnFail(page, r5a.defaultPrevented === true, 't5a-default-prevented', `T5a：无可判定目标仍 preventDefault（实得=${r5a.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast5a = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast5a.includes('请先点击目标附件区再粘贴'), 't5a-toast', `T5a toast 含"请先点击目标附件区再粘贴"（实得="${toast5a}"）`);

        // ═══════════════════════════════════════════════════════════════
        // T5b：无弹窗 + ≥2 个可见 picker 实例 → toast 提示
        //   ⚠️ 如实说明：现状 UI 中所有 picker 实例（create-spec/submit-delivery/modal-spec/
        //   modal-delivery/modal-screenshot）均建在 siModal 弹窗内，同一时刻至多一个可见——
        //   "无弹窗下同时有 ≥2 个可见实例"在正常用户操作路径下**无法通过真实 UI 交互构造**（不存在
        //   能同时打开两个独立、非弹窗的附件区的入口）。为精确触达 siPasteResolveTargetKey() 的
        //   "≥2 候选"分支，这里在页面 document.body 下注入两个符合选择器约定（id 以 siPreview_
        //   开头）的可见 div，模拟"未来若出现非弹窗内联多实例"的场景——这是对被测函数本身的真实
        //   调用（非 mock/stub 被测逻辑），只是构造前置条件的手段是 DOM 注入而非用户点击。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5b：无弹窗 + DOM 注入构造 2 个可见 picker 实例 → toast 提示 ──');
        await page.evaluate(() => {
            const c = document.getElementById('toast-container'); if (c) c.innerHTML = '';
            for (const k of ['siPreview_fakeA', 'siPreview_fakeB']) {
                if (document.getElementById(k)) continue;
                const d = document.createElement('div');
                d.id = k;
                d.className = 'si-file-preview';
                document.body.appendChild(d);
            }
        });
        const r5b = await dispatchPaste(page, { withImage: true, withText: false });
        await shotOnFail(page, r5b.defaultPrevented === true, 't5b-default-prevented', `T5b：≥2 候选无法判定仍 preventDefault（实得=${r5b.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast5b = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast5b.includes('请先点击目标附件区再粘贴'), 't5b-toast', `T5b toast 含"请先点击目标附件区再粘贴"（实得="${toast5b}"）`);
        await page.evaluate(() => { ['siPreview_fakeA', 'siPreview_fakeB'].forEach(k => { const el = document.getElementById(k); if (el) el.remove(); }); });

        // ═══════════════════════════════════════════════════════════════
        // T7（codex 220 M-1）：图片 + 仅 text/html（无 text/plain）+ 焦点 textarea → 放行不收附件
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T7：图片 + 仅 text/html（无 text/plain）+ 焦点 textarea → 放行不收附件 ──');
        await page.click('button:has-text("新建迭代单")');
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        await page.evaluate(() => { siPickerReset('create-spec'); siPickerRender('create-spec'); });
        const beforeCount7 = await page.evaluate(() => siPickerFiles('create-spec').length);
        const r7 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '<b>混合HTML文本</b>', textType: 'text/html', focusSelector: '#f_description' });
        await shotOnFail(page, r7.activeTag === 'TEXTAREA', 't7-focus-is-textarea', `T7 前置：焦点在 textarea（实得="${r7.activeTag}"）`);
        await shotOnFail(page, r7.defaultPrevented === false, 't7-default-not-prevented', `T7 图片+仅text/html+可编辑焦点：e.defaultPrevented=false（codex 220 M-1，原实现漏判会返回 true，实得=${r7.defaultPrevented}）`);
        await page.waitForTimeout(200);
        const afterCount7 = await page.evaluate(() => siPickerFiles('create-spec').length);
        await shotOnFail(page, afterCount7 === beforeCount7, 't7-no-attachment-added', `T7 未收附件（附件数不变，前=${beforeCount7}/后=${afterCount7}）`);

        // ═══════════════════════════════════════════════════════════════
        // T8（codex 220 M-3）：粘贴 image/jpeg → 文件名扩展名为 .jpg（按 MIME 映射，非恒 .png）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T8：粘贴 image/jpeg → 文件名扩展名 .jpg（按 MIME 映射） ──');
        await page.evaluate(() => { siPickerReset('create-spec'); siPickerRender('create-spec'); });
        await dispatchPaste(page, { imageMimes: ['image/jpeg'], withText: false });
        await page.waitForTimeout(200);
        const files8 = await page.evaluate(() => siPickerFiles('create-spec').map(f => ({ name: f.name, type: f.type })));
        await shotOnFail(page, files8.length === 1 && /\.jpg$/.test(files8[0].name), 't8-jpg-ext', `T8 image/jpeg 粘贴后文件名以 .jpg 结尾（实得=${JSON.stringify(files8)}）`);
        await shotOnFail(page, files8[0] && files8[0].type === 'image/jpeg', 't8-type-preserved', `T8 重包装 File 的 type 保持源值 image/jpeg（实得="${files8[0] && files8[0].type}"）`);

        // ═══════════════════════════════════════════════════════════════
        // T9（codex 220 M-2/L-2）：弹窗内注入 display:none 假预览区 → 仍精确判定唯一可见实例
        //   （create-spec）收附件，不被隐藏的假实例干扰成"无法判定"
        //   ⚠️ codex 221a L-4 标注：DOM 注入 display:none 假预览区是**构造分支**手段，非真实用户操作
        //   路径（正常 UI 不会在弹窗内插入隐藏的第二个 picker 实例）——目的与 T5b 相同，精确触达
        //   siPasteResolveTargetKey() 的可见性过滤分支，是对被测函数的真实调用，非 mock。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T9：弹窗内 display:none 假预览区 → 仍精确收附件到唯一可见的 create-spec ──');
        await page.evaluate(() => {
            const body = document.getElementById('siMBody');
            if (body && !document.getElementById('siPreview_fakeHidden')) {
                const d = document.createElement('div');
                d.id = 'siPreview_fakeHidden';
                d.className = 'si-file-preview';
                d.style.display = 'none';
                body.appendChild(d);
            }
        });
        await page.evaluate(() => { siPickerReset('create-spec'); siPickerRender('create-spec'); });
        const r9 = await dispatchPaste(page, { withImage: true, withText: false });
        await shotOnFail(page, r9.defaultPrevented === true, 't9-default-prevented', `T9 defaultPrevented=true（实得=${r9.defaultPrevented}）`);
        await page.waitForTimeout(200);
        const files9Count = await page.evaluate(() => siPickerFiles('create-spec').length);
        await shotOnFail(page, files9Count === 1, 't9-collected-to-visible-instance', `T9 隐藏假实例不干扰判定，图片正确收入唯一可见的 create-spec（实得=${files9Count}，若判定被假实例污染会是 0 且弹 toast）`);
        await page.evaluate(() => { const el = document.getElementById('siPreview_fakeHidden'); if (el) el.remove(); });

        // ═══════════════════════════════════════════════════════════════
        // T10（codex 220 M-5）：一次粘贴多图（同一 paste 事件内 ≥2 个 image item）→ 各自独立命名，全部收入
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T10：一次粘贴 2 张图（同一 paste 事件） → 两个文件各自独立命名，全部收入 ──');
        await page.evaluate(() => { siPickerReset('create-spec'); siPickerRender('create-spec'); });
        const r10 = await dispatchPaste(page, { imageMimes: ['image/png', 'image/jpeg'], withText: false });
        await shotOnFail(page, r10.defaultPrevented === true, 't10-default-prevented', `T10 defaultPrevented=true（实得=${r10.defaultPrevented}）`);
        await page.waitForTimeout(200);
        const files10 = await page.evaluate(() => siPickerFiles('create-spec').map(f => f.name));
        await shotOnFail(page, files10.length === 2, 't10-both-collected', `T10 一次粘贴 2 张图，两个都收入（实得=${JSON.stringify(files10)}）`);
        await shotOnFail(page, files10.length === 2 && files10[0] !== files10[1], 't10-distinct-names', `T10 两个文件名互异（实得=${JSON.stringify(files10)}）`);
        await shotOnFail(page, files10.every(n => /^粘贴截图_/.test(n)), 't10-name-prefix', `T10 两个文件名均以"粘贴截图_"开头（实得=${JSON.stringify(files10)}）`);

        // ═══════════════════════════════════════════════════════════════
        // T11（codex 220 M-5）：超附件数量上限（既有 SI_SPEC_MAX_FILES=5 闸门，先读现状语义再断言：
        //   siPickerCollect 逐个处理，一旦 arr.length>=5 立即 toast「最多 5 个文件」+ break，故"4 个已有
        //   +一次粘贴2张"的结果是恰好收到 5 个（第5个成功、第6个被拒），非"整批拒收"）
        //   ⚠️ codex 221a L-4 标注：下方前置填充 4 个文件**直接调用 siPickerCollect 内部函数**（非模拟
        //   4 次真实粘贴/选择操作），是构造"临近上限"前置状态的手段，非真实用户路径；真正的被测行为
        //   （粘贴 2 张图触发上限）仍走 dispatchPaste 合成事件驱动 paste 监听器的真实代码路径。
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T11：超附件数量上限（5个） → 恰好收到第5个，第6个被拒 + toast「最多 5 个文件」 ──');
        await page.evaluate(() => {
            siPickerReset('create-spec');
            const filler = [];
            for (let i = 0; i < 4; i++) filler.push(new File([new Uint8Array([1, 2, 3])], `filler-${i}.png`, { type: 'image/png' }));
            siPickerCollect('create-spec', filler);
            siPickerRender('create-spec');
        });
        const beforeCap = await page.evaluate(() => siPickerFiles('create-spec').length);
        await shotOnFail(page, beforeCap === 4, 't11-pre-fill', `T11 前置：已直接调用既有 collect 链填充 4 个文件（实得=${beforeCap}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        await dispatchPaste(page, { imageMimes: ['image/png', 'image/png'], withText: false });
        await page.waitForTimeout(300);
        const afterCap = await page.evaluate(() => siPickerFiles('create-spec').length);
        await shotOnFail(page, afterCap === 5, 't11-capped-at-5', `T11 一次粘贴 2 张图但只剩 1 个名额，最终恰好=5（实得=${afterCap}）`);
        const toastCap = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toastCap.includes(`最多 5 个文件`), 't11-cap-toast', `T11 toast 含"最多 5 个文件"（实得="${toastCap}"）`);

        // codex 220 M-4：getAsFile()→null 合成场景——如实说明未能构造，跳过（不造假绿）。
        //   DataTransferItem.getAsFile() 按规范仅在 item.kind!=='file' 时返回 null；本测试添加的 item
        //   均通过 dt.items.add(realFile) 构造，kind 恒为 'file'，公开 API 层面没有制造"kind==='file' 但
        //   getAsFile()仍返回null"这种矛盾状态的手段。唯一理论路径是全局 monkey-patch
        //   DataTransferItem.prototype.getAsFile——但那会污染同一页面后续所有测试对该原型方法的调用
        //   （无法清晰撤销、副作用外溢到其他用例），不是"构造出该场景"而是"篡改被测环境"，故不采用。
        //   M-4 的兜底提示逻辑（"无法读取剪贴板图片，请用文件选择方式上传"）已在源码 review 层面确认
        //   写入（见 Sys_Iteration.html paste 监听器 named.length===0 分支），运行时路径本身与 T1/T10
        //   等已验证的"getAsFile 正常返回"路径同源，只是分支条件在当前公开 API 下无法从测试侧触发。
        console.log('  ⏭️  T-M4（getAsFile→null 兜底提示）：DataTransfer 公开 API 无法构造该场景，跳过（见源码注释确认逻辑已写入，不计入 PASS/FAIL）');

        // ═══════════════════════════════════════════════════════════════
        // T6：全程 0 console error
        // ═══════════════════════════════════════════════════════════════
        await shotOnFail(page, page._consoleErrors.length === 0, 't6-console-clean', `T1-T5 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 建单优化批 C4 前端 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 建单优化批 C4 前端 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
