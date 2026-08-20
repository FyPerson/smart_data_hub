/**
 * S5 前端 Playwright 冒烟——数据协作模块（Data_Collab.html）Ctrl+V 贴图共享层接入
 * 方案 docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二/§三
 * 对齐 test-corr-paste-playwright.js / test-issue-lite-paste-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 覆盖（S5 交付物 §3 最低要求：图片区正例 + 排除区负例 + 抽屉态 + console 干净）：
 *   T1 建单弹窗(newModal)：唯一目标 #filePreview 可见 → 纯图粘贴自动收入 selectedFiles 数组
 *      （复用 collectIntoSelectedFiles 校验闸门）+ 预览渲染
 *   T2 导出弹窗(exportUploadModal)：#f_export_screenshot 单文件字段 → 贴图替换语义（非追加）
 *   T3（负例·核心）：SQL/xlsx 专用区弹窗(submitDeliveryModal)打开时贴图不收——排除区未注册，
 *      不入候选池，回落 document 后仍 0 可见候选，toast 提示
 *   T4（抽屉态排查）：详情抽屉打开时（.u-drawer position 位移，非 display:none）不干扰候选判定——
 *      诊断断言坐实 #detailDrawer 内容不在候选池，且抽屉打开状态不影响 T1/T2 正例
 *   T5 图文混合 + 焦点在描述 textarea → 放行，不收
 *   T6 全程 0 console error
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-collab-paste-playwright.js
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
        const p = path.join(SCREENSHOT_DIR, `collab-paste-fail-${name}.png`);
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
// S2d·R3（codex 445 M2 收窄版）新增 imageCount：一次粘贴放几张图（默认 1，向后兼容既有全部调用点）——
// T5b 需要一次粘贴 2 张图构造"部分拒收"场景，其余既有调用点不传维持单图行为不变。
async function dispatchPaste(page, { withImage = true, imageCount = 1, withText = false, textValue = '', textType = 'text/plain', focusSelector = null } = {}) {
    return page.evaluate(({ b64, withImage, imageCount, withText, textValue, textType, focusSelector }) => {
        const dt = new DataTransfer();
        if (withImage) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            for (let n = 0; n < imageCount; n++) dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
        }
        if (withText) dt.items.add(textValue, textType);
        if (focusSelector) { const el = document.querySelector(focusSelector); if (el) el.focus(); }
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.dispatchEvent(evt);
        return { defaultPrevented: evt.defaultPrevented };
    }, { b64: TINY_PNG_B64, withImage, imageCount, withText, textValue, textType, focusSelector });
}

async function main() {
    const adminTok = await fx.signAs(fx.ADMIN_ID);
    console.log('\n══════ S5 前端 Playwright 冒烟（数据协作 贴图共享层接入） ══════');

    const browser = await chromium.launch();
    try {
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Data_Collab.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        // 等真实列表数据到位再取 id（networkidle+固定等待曾实测不够：loadList() 是页面初始化流程里
        // 较晚的一步，固定超时下偶发还没写完 lastListBackendOrder，退化用兜底 id=1——但 dev 库里
        // collab_requests 从来没有 id=1（真实数据从 14 起），会话到 openDetail(1) 时 404，脏了 console。
        // 注：lastListBackendOrder 是页面内联 <script> 顶层 `let` 声明——不挂 window（与 `var`/函数声明
        // 不同），故不能写 window.lastListBackendOrder（恒 undefined），直接引用变量名即可（S2 同款踩坑）。
        await page.waitForFunction(() => typeof lastListBackendOrder !== 'undefined' && lastListBackendOrder.length > 0, { timeout: 8000 }).catch(() => {});
        const anyId = await page.evaluate(() => (typeof lastListBackendOrder !== 'undefined' && lastListBackendOrder[0] && lastListBackendOrder[0].id) || 1);

        // ═══════════════════════════════════════════════════════════
        // T1：建单弹窗(newModal) 唯一目标 #filePreview → 纯图粘贴自动收入 selectedFiles
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1：建单弹窗 唯一目标 #filePreview 自动收入贴图 ──');
        await page.evaluate(() => openNewModal());
        await page.waitForSelector('#newModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const target1Visible = await page.evaluate(() => UPaste.isVisible(document.getElementById('filePreview')));
        await shotOnFail(page, target1Visible, 't1-target-visible', `T1 前置：#filePreview 可见（UPaste.isVisible 口径，实得=${target1Visible}）`);
        const before1 = await page.evaluate(() => selectedFiles.length);
        const r1 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r1.defaultPrevented === true, 't1-default-prevented', `T1 defaultPrevented=true（实得=${r1.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const after1 = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, after1 === before1 + 1, 't1-collected', `T1 selectedFiles 数组新增 1 项（前=${before1}，后=${after1}）`);
        const previewImgs1 = await page.locator('#filePreview img, #filePreview .file-item').count();
        await shotOnFail(page, previewImgs1 >= 1, 't1-preview-rendered', `T1 #filePreview 渲染出内容（实得项数=${previewImgs1}）`);
        await page.evaluate(() => closeNewModal());
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T2：导出弹窗(exportUploadModal) #f_export_screenshot 单文件 → 贴图替换语义
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T2：导出弹窗 #f_export_screenshot 单文件贴图替换 ──');
        await page.evaluate((id) => openExportUploadDialog(id, false), anyId);
        await page.waitForSelector('#exportUploadModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const target2Visible = await page.evaluate(() => UPaste.isVisible(document.getElementById('f_export_screenshot')));
        await shotOnFail(page, target2Visible, 't2-target-visible', `T2 前置：#f_export_screenshot 可见（实得=${target2Visible}）`);
        const r2 = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r2.defaultPrevented === true, 't2-default-prevented', `T2 defaultPrevented=true（实得=${r2.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const shotFiles2 = await page.evaluate(() => Array.from(document.getElementById('f_export_screenshot').files || []).map(f => f.name));
        await shotOnFail(page, shotFiles2.length === 1 && /^粘贴截图_/.test(shotFiles2[0] || ''), 't2-collected', `T2 f_export_screenshot 恰好 1 个贴图文件（实得=${JSON.stringify(shotFiles2)}）`);
        // 再贴一次 → 替换（非追加），单文件字段语义验证
        await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const shotFiles2b = await page.evaluate(() => Array.from(document.getElementById('f_export_screenshot').files || []).map(f => f.name));
        await shotOnFail(page, shotFiles2b.length === 1, 't2-replace-not-append', `T2 再次贴图 → 仍恰好 1 个（替换非追加，实得=${JSON.stringify(shotFiles2b)}）`);
        await page.evaluate(() => closeExportUploadModal());
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T3（负例·codex S5 复审 M2 采纳：7/7 排除点逐点覆盖，不只测 2 个）
        //   共同断言口径：① UPaste._resolveCandidates(document) 直接解析候选池，逐点断言该排除点的
        //   元素不在池内（id 比对，非仅数总数）；② 真实 dispatchPaste 后对应 input.files 长度不变。
        // ═══════════════════════════════════════════════════════════
        async function assertExcluded(label, excludedIds) {
            const poolIds = await page.evaluate(() => UPaste._resolveCandidates(document).map(c => c.el.id));
            for (const id of excludedIds) {
                await shotOnFail(page, !poolIds.includes(id), `t3-pool-excludes-${id}`, `${label}：候选池不含 #${id}（实得候选池=${JSON.stringify(poolIds)}）`);
            }
        }

        // ── T3a：submitDeliveryModal（f_delivery_script / f_delivery_data） ──
        console.log('\n── T3a（负例）：submitDeliveryModal 打开 → f_delivery_script/f_delivery_data 不收 ──');
        await page.evaluate((id) => openSubmitDeliveryDialog(id), anyId);
        await page.waitForSelector('#submitDeliveryModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        await assertExcluded('T3a', ['f_delivery_script', 'f_delivery_data']);
        const dlScriptBefore = await page.evaluate(() => document.getElementById('f_delivery_script').files.length);
        const dlDataBefore = await page.evaluate(() => document.getElementById('f_delivery_data').files.length);
        // S1b·R2 预筛修复顺带发现并修正的陈旧断言（与 R1-R5 无关，先核实为基线既有问题——退回 dda7eb5
        // 复测 T3a 同样红且同款空字符串，证明本条不是本批改动引入的回归）：注释原称"本页 showToast 是
        // 页面自有单元素实现（#toast）"，但 Data_Collab.html:1382-1383 的注释明确写着"原 `#toast` 单例
        // 宿主节点已删：全站 toast 走 app.js 共享版，容器 #toast-container"（通知统一 N1·D7 批次）——
        // 本页早已改用共享 app.js#showToast（挂 #toast-container，堆叠范式），旧注释与 #toast 选择器已
        // 双双过期，读取的元素根本不存在，textContent 恒为空字符串，与 MSG_NO_CANDIDATE 文案变更无关。
        // 断言口径改回与其余套件一致的 #toast-container。
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r3a = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r3a.defaultPrevented === true, 't3a-default-prevented', `T3a 无可判定目标仍 preventDefault（实得=${r3a.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const toast3a = await page.locator('#toast-container').textContent().catch(() => '');
        const msgNoCandidate3a = await page.evaluate(() => UPaste.MSG_NO_CANDIDATE);
        await shotOnFail(page, toast3a.includes(msgNoCandidate3a), 't3a-toast', `T3a toast 含 UPaste.MSG_NO_CANDIDATE（同源引用="${msgNoCandidate3a}"，实得="${toast3a}"）`);
        const dlScriptAfter = await page.evaluate(() => document.getElementById('f_delivery_script').files.length);
        const dlDataAfter = await page.evaluate(() => document.getElementById('f_delivery_data').files.length);
        await shotOnFail(page, dlScriptAfter === dlScriptBefore && dlDataAfter === dlDataBefore, 't3a-nothing-collected', `T3a SQL/数据文件区 files 长度不变（script ${dlScriptBefore}→${dlScriptAfter}, data ${dlDataBefore}→${dlDataAfter}）`);
        await page.evaluate(() => closeSubmitDeliveryModal());
        await page.waitForTimeout(200);

        // ── T3b：newModal（f_template / f_data_scope，与已注册的 f_files 同弹窗共存） ──
        console.log('\n── T3b（负例）：newModal 内 f_template/f_data_scope 不收（与 f_files 同弹窗混合） ──');
        await page.evaluate(() => openNewModal());
        await page.waitForSelector('#newModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        await assertExcluded('T3b', ['f_template', 'f_data_scope']);
        const tplBefore = await page.evaluate(() => { const el = document.getElementById('f_template'); return el ? el.files.length : null; });
        const dsBefore = await page.evaluate(() => { const el = document.getElementById('f_data_scope'); return el ? el.files.length : null; });
        const selBefore3b = await page.evaluate(() => selectedFiles.length);
        await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const tplAfter = await page.evaluate(() => { const el = document.getElementById('f_template'); return el ? el.files.length : null; });
        const dsAfter = await page.evaluate(() => { const el = document.getElementById('f_data_scope'); return el ? el.files.length : null; });
        const selAfter3b = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, tplAfter === tplBefore && dsAfter === dsBefore, 't3b-excluded-unchanged', `T3b f_template/f_data_scope files 长度不变（template ${tplBefore}→${tplAfter}, data_scope ${dsBefore}→${dsAfter}）`);
        await shotOnFail(page, selAfter3b === selBefore3b + 1, 't3b-registered-still-works', `T3b 同弹窗内已注册的 f_files 仍正常收入（selectedFiles ${selBefore3b}→${selAfter3b}，验证排除区不误伤同弹窗注册区）`);
        await page.evaluate(() => closeNewModal());
        await page.waitForTimeout(200);

        // ── T3c：adminSubmitModal（f_admin_submit_script / f_admin_submit_data） ──
        //   openAdminSubmitDialog() 依赖 currentDetail 全局态（详情已加载），测试直接置 open class +
        //   复位输入框，等价于该函数的"弹窗可见"这一部分效果，不依赖详情加载副作用。
        console.log('\n── T3c（负例）：adminSubmitModal 打开 → f_admin_submit_script/f_admin_submit_data 不收 ──');
        await page.evaluate(() => {
            document.getElementById('f_admin_submit_script').value = '';
            document.getElementById('f_admin_submit_data').value = '';
            document.getElementById('adminSubmitModal').classList.add('open');
        });
        await page.waitForTimeout(300);
        await assertExcluded('T3c', ['f_admin_submit_script', 'f_admin_submit_data']);
        const asBefore = await page.evaluate(() => document.getElementById('f_admin_submit_script').files.length);
        const adBefore = await page.evaluate(() => document.getElementById('f_admin_submit_data').files.length);
        await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const asAfter = await page.evaluate(() => document.getElementById('f_admin_submit_script').files.length);
        const adAfter = await page.evaluate(() => document.getElementById('f_admin_submit_data').files.length);
        await shotOnFail(page, asAfter === asBefore && adAfter === adBefore, 't3c-nothing-collected', `T3c f_admin_submit_script/data files 长度不变（script ${asBefore}→${asAfter}, data ${adBefore}→${adAfter}）`);
        await page.evaluate(() => document.getElementById('adminSubmitModal').classList.remove('open'));
        await page.waitForTimeout(200);

        // ── T3d（重点·同弹窗混合场景）：exportUploadModal 内 f_export_result_data（排除）
        //   与 f_export_screenshot（已注册）共存——这是最容易误收的场景：两个字段同一弹窗、都是
        //   "结果附件"语义，贴图必须精确只进 screenshot，不能因为都可见就落进 result_data。 ──
        console.log('\n── T3d（负例·重点）：exportUploadModal 内贴图只进 screenshot，不进 result_data（同弹窗混合） ──');
        await page.evaluate((id) => openExportUploadDialog(id, false), anyId);
        await page.waitForSelector('#exportUploadModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        // 候选池应恰好只含 f_export_screenshot 这一个，不含 f_export_result_data
        const poolIds3d = await page.evaluate(() => UPaste._resolveCandidates(document).map(c => c.el.id));
        await shotOnFail(page, !poolIds3d.includes('f_export_result_data'), 't3d-pool-excludes-result-data', `T3d 候选池不含 #f_export_result_data（实得候选池=${JSON.stringify(poolIds3d)}）`);
        await shotOnFail(page, poolIds3d.includes('f_export_screenshot') && poolIds3d.length === 1, 't3d-pool-only-screenshot', `T3d 候选池恰好只含 #f_export_screenshot 1 项（实得=${JSON.stringify(poolIds3d)}）`);
        const resultDataBefore = await page.evaluate(() => document.getElementById('f_export_result_data').files.length);
        const r3d = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, r3d.defaultPrevented === true, 't3d-default-prevented', `T3d defaultPrevented=true（恰 1 候选，实得=${r3d.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const resultDataAfter = await page.evaluate(() => document.getElementById('f_export_result_data').files.length);
        const screenshotAfter3d = await page.evaluate(() => Array.from(document.getElementById('f_export_screenshot').files || []).map(f => f.name));
        await shotOnFail(page, resultDataAfter === resultDataBefore, 't3d-result-data-unchanged', `T3d f_export_result_data files 长度不变（${resultDataBefore}→${resultDataAfter}，未被误收）`);
        await shotOnFail(page, screenshotAfter3d.length === 1 && /^粘贴截图_/.test(screenshotAfter3d[0] || ''), 't3d-screenshot-collected', `T3d 贴图精确落入 f_export_screenshot（实得=${JSON.stringify(screenshotAfter3d)}）`);
        await page.evaluate(() => closeExportUploadModal());
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T4（抽屉态排查）：详情抽屉打开时不干扰候选判定
        //   #detailDrawer 用 .u-drawer（position:fixed 位移出屏，非 display:none，C4 手术后常驻 DOM）——
        //   诊断断言坐实：即便抽屉打开，候选池仍只在 newModal/exportUploadModal 打开时非空；抽屉内容
        //   本身从未注册，不会被误当候选。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T4：详情抽屉打开态不干扰候选判定（诊断 + 正例复测） ──');
        const drawerOpened = await page.evaluate(async (id) => {
            if (typeof openDetail === 'function') { await openDetail(id); return true; }
            return false;
        }, anyId);
        await page.waitForTimeout(400);
        const drawerDiag = await page.evaluate(() => {
            const d = document.getElementById('detailDrawer');
            return {
                hasOpenClass: d ? d.classList.contains('open') : null,
                rectsWhenClosed: d ? d.getClientRects().length : null,   // 位移出屏但仍有布局盒（非 display:none）
                candidatesWithDrawerAlone: UPaste._resolveCandidates(document).length,   // 抽屉打开、两个相关弹窗都未开 → 应为 0
            };
        });
        await shotOnFail(page, drawerOpened, 't4-drawer-open-attempted', `T4 前置：尝试打开详情抽屉（实得=${drawerOpened}）`);
        await shotOnFail(page, drawerDiag.candidatesWithDrawerAlone === 0, 't4-drawer-alone-zero-candidates', `T4 仅抽屉打开（两个相关弹窗均未开）→ 候选池为空（实得=${drawerDiag.candidatesWithDrawerAlone}，抽屉诊断=${JSON.stringify(drawerDiag)}）`);
        // 抽屉开着的同时再打开建单弹窗 → T1 正例应仍然成立（抽屉不干扰）
        await page.evaluate(() => openNewModal());
        await page.waitForSelector('#newModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const before4 = await page.evaluate(() => selectedFiles.length);
        const r4 = await dispatchPaste(page, { withImage: true });
        await page.waitForTimeout(300);
        const after4 = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, r4.defaultPrevented === true && after4 === before4 + 1, 't4-still-works-with-drawer-open', `T4 抽屉打开的同时建单弹窗贴图仍正常收入（前=${before4}，后=${after4}）`);
        await page.evaluate(() => closeNewModal());
        if (typeof drawerOpened === 'boolean' && drawerOpened) {
            await page.evaluate(() => { if (typeof closeDetailModal === 'function') closeDetailModal(); });
        }
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T5（S2·第三缺陷修复语义反转，拍板出处 memory paste_defect_leads.md 2026-08-20 用户决策之二·
        //   双通道投递）：图文混合 + 焦点在描述 textarea → 双通道：文本不拦截 + 图片同步投递（newModal
        //   内此时唯一候选是 filePreview，归属零歧义）。原断言"未收，不收"把丢图钉死在案，需反转。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T5：图文混合 + 焦点在描述 textarea → 双通道（文本不拦截+图片同步投递到 filePreview） ──');
        await page.evaluate(() => openNewModal());
        await page.waitForSelector('#newModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const before5 = await page.evaluate(() => selectedFiles.length);
        const r5 = await dispatchPaste(page, { withImage: true, withText: true, textValue: '协作单描述混合粘贴', focusSelector: '#f_desc' });
        await shotOnFail(page, r5.defaultPrevented === false, 't5-default-not-prevented', `T5 文本通道：e.defaultPrevented=false（不拦截，实得=${r5.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const after5 = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, after5 === before5 + 1, 't5-image-delivered', `T5 图片通道：图片同步投递进 filePreview/selectedFiles，+1（前=${before5}/后=${after5}，若实现退化回旧版丢图这条会红）`);
        await page.evaluate(() => closeNewModal());
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T5b（S2d·R3，codex 445 M2 收窄版，拍派单口径）：newModal filePreview 预填至上限-1（4/5）后，
        //   dual 路径（一次粘贴 2 张图 + 焦点在描述 textarea）→ 页面闸门 collectIntoSelectedFiles 只剩
        //   1 个名额，实际接收 accepted=1（第 2 张被拒收+页面自身"最多上传 5 个文件"toast），共享层按
        //   S2c/S2d 契约应据实提示"已粘贴 1 张图片到附件区"（dualDeliveredMsg(1)），不是按尝试投递的
        //   named.length=2 谎报"已粘贴 2 张"。
        //   坏成什么样会红：若适配器（Data_Collab.html collect: (key, files) => {...return accepted;}）
        //   漏了 return（契约退化成 undefined），或共享层忽略 accepted 契约、一律按 named.length 提示，
        //   会报出"已粘贴 2 张"——这正是预筛描述的"谎报成功"场景，t5b-success-toast-actual-count 这条会红。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T5b：filePreview 预填至上限-1(4/5) + dual 一次粘贴 2 张图 → 成功 toast 按实数「已粘贴 1 张」（非 2 张） ──');
        await page.evaluate(() => openNewModal());
        await page.waitForSelector('#newModal.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const filler = [];
            for (let i = 0; i < 4; i++) filler.push(new File([new Uint8Array([1, 2, 3])], `t5b-filler-${i}.png`, { type: 'image/png' }));
            collectIntoSelectedFiles(filler);
            renderFilePreview();
        });
        const before5b = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, before5b === 4, 't5b-pre-fill', `T5b 前置：filePreview 已预填至 4（上限-1，实得=${before5b}）`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        const r5b = await dispatchPaste(page, { withImage: true, imageCount: 2, withText: true, textValue: '上限-1场景混合粘贴', focusSelector: '#f_desc' });
        await shotOnFail(page, r5b.defaultPrevented === false, 't5b-default-not-prevented', `T5b dual 路径：e.defaultPrevented=false（不拦截事件本身，实得=${r5b.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const after5b = await page.evaluate(() => selectedFiles.length);
        await shotOnFail(page, after5b === 5, 't5b-count-capped', `T5b 附件数恰好收到 1 张后封顶（4→5，第 2 张被拒收，实得=${after5b}）`);
        const toast5b = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toast5b.includes('最多上传 5 个文件'), 't5b-cap-toast-present', `T5b 页面自身「最多上传 5 个文件」拒收 toast 出现（实得="${toast5b}"）`);
        const dualMsg1_5b = await page.evaluate(() => UPaste.dualDeliveredMsg(1));
        const dualMsg2_5b = await page.evaluate(() => UPaste.dualDeliveredMsg(2));
        await shotOnFail(page, toast5b.includes(dualMsg1_5b) && !toast5b.includes(dualMsg2_5b),
            't5b-success-toast-actual-count', `T5b 成功 toast 按实数「已粘贴 1 张」（同源引用 dualDeliveredMsg(1)="${dualMsg1_5b}"），非谎报 2 张（dualDeliveredMsg(2)="${dualMsg2_5b}"，实得 toast="${toast5b}"）`);
        await page.evaluate(() => closeNewModal());
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T6：全程 0 console error
        // ═══════════════════════════════════════════════════════════
        await shotOnFail(page, page._consoleErrors.length === 0, 't6-console-clean', `T6 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 3).join(' | ') : ''}）`);

        await page.close();
    } finally {
        await browser.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 数据协作贴图接入 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 数据协作贴图接入 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
