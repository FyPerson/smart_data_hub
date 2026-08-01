/**
 * 零星事项台账 Playwright 冒烟——独立页 Quick_Log.html
 * 原方案 docs/local/系统迭代/系统迭代_零星事项台账_方案_20260801_v0.1.md §四（内嵌 Sys_Iteration.html
 * 弹层面板）；2026-08-02 用户浏览器验收后裁定改独立页（平铺列表，不再是弹层），本套件随迁移改造：
 * URL 从 Sys_Iteration.html 换成 Quick_Log.html，DOM 选择器 si- 前缀 / #siQuickLog 系列换 ql- 前缀 /
 * #ql 系列（随页面迁移的 si→ql 统一改名），T1 从"入口按钮可见性"改"admin-only 页面级守卫"（照 Periodic_Fetch.html
 * 同款 alert+跳转范式），T1d 深链用例整体删除（独立页不再支持 ?quicklog=1 深链），M2（面板关闭期间
 * 防抖定时器）整体删除（独立页没有"面板可关"这个前提条件，该用例的验证对象已不存在）。
 * 对齐 test-sys-paste-playwright.js / test-sys-intake-liaison-playwright.js 套件范式：
 *   JWT 注入 + login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）。
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-quick-log-playwright.js
 *
 * 覆盖：
 *   T1  admin-only 守卫：非 admin 直接访问 Quick_Log.html 被拒（alert+跳转 Task_Pool.html）+ 全程零
 *       /api/quick-logs 请求；admin 正常进入（不跳转，列表加载）；全局导航 admin 头像下拉含「零星事项」
 *       → /Quick_Log.html 入口，非 admin 下拉不含
 *   T2  新建：前端校验拦截（描述必填/结果说明必填）+ 成功建单后列表出现（标题=描述首行）
 *   T3  类型「其他」联动备注显隐 + 切回非其他时清空
 *   T4  筛选（类型+关键词）+ 需求方留空显示「自主发起」
 *   T5  编辑回填 + 改 description 后保存 → 列表标题同步刷新
 *   T6  附件：追加上传 → 附件数 +1 → 清单展示 → 下载端点 200（鉴权 fetch）→ 删除 → 附件数归零
 *   L2  附件上传失败 → toast 点名具体文件名
 *   T7  贴图直通：DataTransfer 模拟 paste 图片到新建弹窗 → 文件进入 qlPickerFiles('ql-create') 预览区
 *   T8  删除记录 → 列表消失
 *   T9  全程 0 console error（admin 页面按内容精确扣除 L2 故意制造的 500 噪音；非 admin 页面因守卫在
 *       DOMContentLoaded 最前面拦截、不再有 Sys_Iteration.html 遗留的无条件预热探测调用，口径改回笼统零）
 *
 * 清理：测试记录 description 统一带前缀 [QLPWTEST]，跑完直连 sqlite3 按前缀物理删除
 *   （含级联删附件表行 + 磁盘文件），不依赖 UI 删完整个数据集。
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
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');
const PREFIX = '[QLPWTEST]';

const ADMIN_ID = 1;
const NONADMIN_ID = 3;   // demo_user_a，role=user（S1 verify 同款非 admin fixture）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `quicklog-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: p });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图失败不影响主流程 */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    // codex S6 复审 MED-2/LOW-1 采纳：条目从纯文本升级为 {text, url}——Chromium 对 fetch()/XHR 收到非 2xx
    // 响应会注入一条 console error"Failed to load resource: the server responded with a status of NNN"，
    // 其 msg.location().url 就是那次失败请求的真实 URL（已用探针脚本对本项目实际接口验证：403/500 均如实
    // 携带对应 endpoint URL）。有了 url 才能对"哪条噪音属于哪个已知接口"做精确匹配，而非只按数量/关键词猜。
    page.on('console', m => {
        if (m.type() === 'error') {
            const loc = m.location() || {};
            consoleErrors.push({ text: m.text(), url: loc.url || '' });
        }
    });
    page.on('pageerror', e => consoleErrors.push({ text: 'pageerror: ' + e.message, url: '' }));
    // dialogs（alert/confirm）：统一 accept 放行，同时记录消息文本——T1 需要断言 admin-only 守卫弹出的
    // 「需要管理员权限」提示确实出现过，其余用例（qlDelete/qlDeleteAtt 的 confirm）沿用旧行为直接放行。
    const dialogMessages = [];
    page.on('dialog', d => { dialogMessages.push(d.message()); d.accept(); });
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    page._dialogMessages = dialogMessages;
    return page;
}

async function cleanupTestRows() {
    try {
        const rows = await dbAll(`SELECT id FROM sys_quick_log WHERE description LIKE ?`, [PREFIX + '%']);
        for (const r of rows) {
            const atts = await dbAll(`SELECT file_name FROM sys_quick_log_attachments WHERE quick_log_id = ?`, [r.id]);
            for (const a of atts) {
                try { const p = path.join(ROOT, 'uploads', a.file_name); if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
            }
        }
        await dbRun(`DELETE FROM sys_quick_log_attachments WHERE quick_log_id IN (SELECT id FROM sys_quick_log WHERE description LIKE ?)`, [PREFIX + '%']);
        await dbRun(`DELETE FROM sys_quick_log WHERE description LIKE ?`, [PREFIX + '%']);
    } catch (e) { console.error('[清理] 失败（非致命）：', e.message); }
}

// 同 test-sys-paste-playwright.js 的 dispatchPaste（1x1 透明 PNG + DataTransfer 构造 + 合成 paste 事件）
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function dispatchPaste(page, { withImage = true, focusSelector = null } = {}) {
    return page.evaluate(({ b64, withImage, focusSelector }) => {
        const dt = new DataTransfer();
        if (withImage) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], 'clipboard-image', { type: 'image/png' }));
        }
        if (focusSelector) { const el = document.querySelector(focusSelector); if (el) el.focus(); }
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        document.dispatchEvent(evt);
        return { defaultPrevented: evt.defaultPrevented };
    }, { b64: TINY_PNG_B64, withImage, focusSelector });
}

async function main() {
    await cleanupTestRows();
    const adminTok = await signAs(ADMIN_ID);
    const nonAdminTok = await signAs(NONADMIN_ID);
    console.log('\n══════ 零星事项台账 Playwright 冒烟（独立页 Quick_Log.html） ══════');

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════
        // T1：admin-only 页面级守卫（照 Periodic_Fetch.html 同款 alert+跳转范式）+ 全局导航入口
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T1：非 admin 访问被拒 + admin 正常进入 + 全局导航 admin 下拉入口 ──');
        const naPage = await loginPage(browser, nonAdminTok);
        const naRequests = [];
        naPage.on('request', req => naRequests.push(req.url()));
        await naPage.goto(`${BASE_URL}/Quick_Log.html`);
        await naPage.waitForLoadState('networkidle');
        await naPage.waitForTimeout(500);
        const naFinalUrl = naPage.url();
        await shotOnFail(naPage, naFinalUrl.includes('/Task_Pool.html'), 't1a-na-redirected', `T1a 非 admin 访问 Quick_Log.html 被拒并跳转 Task_Pool.html（实得落地=${naFinalUrl}）`);
        await shotOnFail(naPage, naPage._dialogMessages.some(m => m.includes('需要管理员权限')), 't1a-na-alert', `T1a 弹出「需要管理员权限」提示（实得=${JSON.stringify(naPage._dialogMessages)}）`);
        const naHitQuickLog = naRequests.some(u => u.includes('/api/quick-logs'));
        await shotOnFail(naPage, naHitQuickLog === false, 't1a-na-no-request', `T1a 非 admin 全程零 /api/quick-logs 请求（实得命中=${naHitQuickLog}，请求数=${naRequests.length}）`);
        // T1c：全局导航 admin 下拉含「零星事项」入口（app.js·置于周期取数下方）；非 admin 下拉不含
        // （naPage 此刻已因跳转落地在 Task_Pool.html，同样渲染共享 navbar+下拉，检查点位置不影响判定）。
        const naMenuCnt = await naPage.locator('.dropdown a[href="/Quick_Log.html"]').count();
        await shotOnFail(naPage, naMenuCnt === 0, 't1c-na-no-menu', `T1c 非 admin 下拉菜单不含「零星事项」入口（实得=${naMenuCnt}）`);

        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Quick_Log.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        const adminFinalUrl = page.url();
        await shotOnFail(page, adminFinalUrl.includes('/Quick_Log.html'), 't1b-admin-not-redirected', `T1b admin 访问 Quick_Log.html 未被跳转（实得落地=${adminFinalUrl}）`);
        const adminTableCount = await page.locator('#qlTbody').count();
        await shotOnFail(page, adminTableCount === 1, 't1b-admin-list-loaded', `T1b admin 页面台账表格已加载（实得 #qlTbody 命中=${adminTableCount}）`);
        const adminMenuCnt = await page.locator('.dropdown a[href="/Quick_Log.html"]').count();
        await shotOnFail(page, adminMenuCnt === 1, 't1c-admin-menu', `T1c admin 下拉菜单含「零星事项」入口（实得=${adminMenuCnt}）`);

        // ═══════════════════════════════════════════════════════════
        // T2：新建校验拦截 + 成功建单后列表出现（标题=描述首行）
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T2：新建前端校验拦截 + 成功建单后列表出现（标题=描述首行） ──');
        await page.click('button:has-text("+ 新建")');
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);

        await page.click('#qlMConfirm');
        await page.waitForTimeout(300);
        let toastText = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toastText.includes('需求描述必填'), 't2-desc-required', `T2 描述为空 → toast 含"需求描述必填"（实得="${toastText}"）`);
        const modalStillOpen1 = await page.locator('#qlModalOverlay.open').count();
        await shotOnFail(page, modalStillOpen1 === 1, 't2-modal-kept-open-1', 'T2 校验失败后弹窗保持打开');

        await page.fill('#f_description', PREFIX + '测试标题行\n第二行详情不影响标题');
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        await page.click('#qlMConfirm');
        await page.waitForTimeout(300);
        toastText = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, toastText.includes('结果说明必填'), 't2-result-note-required', `T2 结果说明为空 → toast 含"结果说明必填"（实得="${toastText}"）`);

        await page.fill('#f_result_note', PREFIX + '测试结果说明文本');
        await page.click('#qlMConfirm');
        await page.waitForTimeout(500);
        const modalClosed2 = await page.locator('#qlModalOverlay.open').count();
        await shotOnFail(page, modalClosed2 === 0, 't2-modal-closed', 'T2 校验通过 → 建单成功 → 弹窗关闭');
        const rowTitleCount = await page.locator('#qlTbody td:has-text("' + PREFIX + '测试标题行")').count();
        await shotOnFail(page, rowTitleCount >= 1, 't2-list-shows-title', `T2 列表出现新单，标题=描述首行「${PREFIX}测试标题行」（实得命中行数=${rowTitleCount}）`);

        // ═══════════════════════════════════════════════════════════
        // T3：类型「其他」联动备注显隐 + 切回非其他时清空
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T3：类型「其他」联动备注显隐 + 切回时清空 ──');
        await page.click('button:has-text("+ 新建")');
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const noteVisibleInit = await page.locator('#qlNoteWrap').isVisible();
        await shotOnFail(page, noteVisibleInit === false, 't3-note-hidden-init', `T3 默认类型(tool) → 备注区初始隐藏（实得可见=${noteVisibleInit}）`);
        await page.selectOption('#f_category', 'other');
        await page.waitForTimeout(100);
        const noteVisibleOther = await page.locator('#qlNoteWrap').isVisible();
        await shotOnFail(page, noteVisibleOther === true, 't3-note-visible-other', `T3 切到"其他" → 备注区显示（实得可见=${noteVisibleOther}）`);
        await page.fill('#f_category_note', '这是一段测试备注');
        await page.selectOption('#f_category', 'tool');
        await page.waitForTimeout(100);
        const noteVisibleBack = await page.locator('#qlNoteWrap').isVisible();
        const noteValueBack = await page.locator('#f_category_note').inputValue();
        await shotOnFail(page, noteVisibleBack === false, 't3-note-hidden-back', `T3 切回"提效工具" → 备注区重新隐藏（实得可见=${noteVisibleBack}）`);
        await shotOnFail(page, noteValueBack === '', 't3-note-cleared', `T3 切回时备注输入已清空（实得值="${noteValueBack}"）`);
        // 不提交，关闭弹窗（本轮只测 UI 联动，不产生额外测试记录）
        await page.click('#qlModalOverlay.open .u-drawer-close');
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T4：筛选（类型+关键词）+ 需求方留空显示「自主发起」
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T4：筛选（类型+关键词）+ 需求方留空显示「自主发起」 ──');
        const requesterCellText = await page.locator('#qlTbody tr', { hasText: PREFIX + '测试标题行' }).locator('td').nth(2).textContent();
        await shotOnFail(page, (requesterCellText || '').includes('自主发起'), 't4-requester-blank', `T4 需求方留空 → 显示"自主发起"（实得="${requesterCellText}"）`);

        await page.fill('#qlFKeyword', PREFIX + '测试标题行');
        await page.waitForTimeout(500);
        const kwRows = await page.locator('#qlTbody tr').count();
        await shotOnFail(page, kwRows >= 1, 't4-keyword-filter', `T4 关键词筛选命中≥1 行（实得=${kwRows}）`);

        await page.selectOption('#qlFCategory', 'demo');
        await page.waitForTimeout(400);
        const catFilterRows = await page.locator('#qlTbody td:has-text("' + PREFIX + '测试标题行")').count();
        await shotOnFail(page, catFilterRows === 0, 't4-category-filter-excludes', `T4 类型筛选=demo 时不含 tool 类型的测试单（实得命中=${catFilterRows}）`);
        await page.selectOption('#qlFCategory', '');
        await page.fill('#qlFKeyword', '');
        await page.waitForTimeout(500);

        // ═══════════════════════════════════════════════════════════
        // T5：编辑回填 + 改 description 后保存 → 列表标题同步刷新
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T5：编辑回填 + 改 description 后保存 → 列表标题刷新 ──');
        await page.locator('#qlTbody tr', { hasText: PREFIX + '测试标题行' }).locator('button:has-text("编辑")').click();
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const descPrefill = await page.locator('#f_description').inputValue();
        await shotOnFail(page, descPrefill.includes(PREFIX + '测试标题行'), 't5-prefill', `T5 编辑弹窗描述已回填原值（实得="${descPrefill.slice(0, 30)}..."）`);
        await page.fill('#f_description', PREFIX + '编辑后新标题\n改动后的详情');
        await page.click('#qlMConfirm');
        await page.waitForTimeout(500);
        const modalClosed5 = await page.locator('#qlModalOverlay.open').count();
        await shotOnFail(page, modalClosed5 === 0, 't5-modal-closed', 'T5 保存成功 → 弹窗关闭');
        const newTitleRow = await page.locator('#qlTbody td:has-text("' + PREFIX + '编辑后新标题")').count();
        await shotOnFail(page, newTitleRow >= 1, 't5-title-updated', `T5 列表标题随 description 变化同步刷新（实得命中=${newTitleRow}）`);
        const oldTitleGone = await page.locator('#qlTbody td:has-text("' + PREFIX + '测试标题行")').count();
        await shotOnFail(page, oldTitleGone === 0, 't5-old-title-gone', `T5 旧标题不再出现（实得残留=${oldTitleGone}）`);

        // ═══════════════════════════════════════════════════════════
        // T6：附件——追加上传 → 附件数+1 → 清单展示 → 下载 200 → 删除 → 附件数归零
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T6：附件追加上传 → 附件数+1 → 清单展示 → 下载200 → 删除 → 归零 ──');
        const attCountBefore = await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('td').nth(5).textContent();
        await shotOnFail(page, (attCountBefore || '').trim() === '0', 't6-count-before', `T6 上传前附件数=0（实得="${attCountBefore}"）`);

        await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('button:has-text("编辑")').click();
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const attEmptyText = await page.locator('#qlEditAttList').textContent();
        await shotOnFail(page, (attEmptyText || '').includes('暂无附件'), 't6-att-empty', `T6 编辑弹窗打开时附件清单显示"暂无附件"（实得="${(attEmptyText || '').trim()}"）`);

        const tmpFilePath = path.join(os.tmpdir(), 'ql-pw-test-attachment.txt');
        fs.writeFileSync(tmpFilePath, 'quick-log playwright test attachment content');
        await page.setInputFiles('#qlPickerInput_ql-edit', tmpFilePath);
        await page.waitForTimeout(300);
        const previewCount = await page.locator('#qlPreview_ql-edit .ql-file-item').count();
        await shotOnFail(page, previewCount === 1, 't6-picker-preview', `T6 追加上传选中文件后预览区出现 1 项（实得=${previewCount}）`);

        await page.click('#qlMConfirm');   // 保存（部署内含"上传新增附件"的两步链）
        await page.waitForTimeout(600);
        const modalClosed6 = await page.locator('#qlModalOverlay.open').count();
        await shotOnFail(page, modalClosed6 === 0, 't6-modal-closed', 'T6 保存后弹窗关闭');
        const attCountAfter = await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('td').nth(5).textContent();
        await shotOnFail(page, (attCountAfter || '').trim() === '1', 't6-count-after', `T6 保存后附件数=1（实得="${attCountAfter}"）`);

        await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('button:has-text("编辑")').click();
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(300);
        const attItemCount = await page.locator('#qlEditAttList .ql-att-item').count();
        await shotOnFail(page, attItemCount === 1, 't6-att-list-shows', `T6 附件清单展示 1 项（实得=${attItemCount}）`);

        // qlEditAttCache 是页面内联 <script> 顶层 `let` 声明——不挂 window（与 `var`/函数声明不同），
        // 故不能写 window.qlEditAttCache（恒 undefined），直接引用变量名即可。
        const attId = await page.evaluate(() => (typeof qlEditAttCache !== 'undefined' && qlEditAttCache[0] && qlEditAttCache[0].id) || null);
        await shotOnFail(page, !!attId, 't6-att-id-resolved', `T6 拿到附件 id（实得=${attId}）`);
        const dlStatus = await page.evaluate(async (id) => {
            const r = await fetch('/api/quick-logs/attachments/' + id + '/download', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            return r.status;
        }, attId);
        await shotOnFail(page, dlStatus === 200, 't6-download-200', `T6 下载端点鉴权 fetch → 200（实得=${dlStatus}）`);

        await page.locator('#qlEditAttList .ql-att-item .ql-att-del').first().click();
        await page.waitForTimeout(400);
        const attTextAfterDel = await page.locator('#qlEditAttList').textContent();
        await shotOnFail(page, (attTextAfterDel || '').includes('暂无附件'), 't6-att-deleted', `T6 删除后附件清单回到"暂无附件"（实得="${(attTextAfterDel || '').trim()}"）`);
        await page.click('#qlModalOverlay.open .u-drawer-close');
        await page.waitForTimeout(300);
        const attCountFinal = await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('td').nth(5).textContent();
        await shotOnFail(page, (attCountFinal || '').trim() === '0', 't6-count-final', `T6 删除后列表附件数归零（实得="${attCountFinal}"）`);

        // ═══════════════════════════════════════════════════════════
        // L2：附件上传失败时 toast 点名具体文件名（非笼统"部分失败"）
        //   拦截 POST .../attachments 强制返回 500，验证新版失败提示文案形状。
        // ═══════════════════════════════════════════════════════════
        console.log('\n── L2：附件上传失败 → toast 点名具体文件名 ──');
        await page.click('button:has-text("+ 新建")');
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        await page.fill('#f_description', PREFIX + 'L2上传失败测试');
        await page.fill('#f_result_note', PREFIX + 'L2结果说明');
        const l2FilePath = path.join(os.tmpdir(), 'ql-pw-l2-fail-attachment.txt');
        fs.writeFileSync(l2FilePath, 'this upload will be forced to fail');
        await page.setInputFiles('#qlPickerInput_ql-create', l2FilePath);
        await page.waitForTimeout(200);
        // 清空 toast 容器——上个步骤（T6 保存/删除）产生的 toast 未必已在 3000ms 自动消失前清场，
        // 不清空会读到"旧 toast 文本 + 新 toast 文本"拼接的假阳性/假阴性（textContent 不分元素边界）。
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        // 拦截期间强制 500 是本用例故意制造的失败，会在浏览器控制台留 1 条"Failed to load resource"
        // 网络层日志——这是预期噪音（验证失败提示文案本就需要真的让它失败一次）；下方 T9 对全量
        // _consoleErrors 按内容精确匹配（URL 命中 .../quick-logs/.../attachments 且文本含 500/Failed
        // to load resource）识别噪音条目，不用前后数量差值口径。
        await page.route('**/api/quick-logs/*/attachments', route => {
            if (route.request().method() === 'POST') {
                return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传失败' }) });
            }
            return route.continue();
        });
        await page.click('#qlMConfirm');
        await page.waitForTimeout(600);
        const l2Toast = await page.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page, l2Toast.includes('ql-pw-l2-fail-attachment.txt'), 'l2-toast-filename', `L2 上传失败 toast 点名具体文件名（实得="${l2Toast}"）`);
        await shotOnFail(page, l2Toast.includes('已新建') && l2Toast.includes('1 个附件上传失败'), 'l2-toast-shape', `L2 toast 文案形如"已新建，N 个附件上传失败：…"（实得="${l2Toast}"）`);
        await page.unroute('**/api/quick-logs/*/attachments');
        // 断言完毕后显式关闭弹窗并等待 .open 消失，给 T7 一个不依赖"L2 保存流程是否已自动关闭弹窗"的
        // 干净起点——用例级状态复位，不指望 finally 里的前缀批量清理兜到这一步。
        const l2StillOpen = await page.locator('#qlModalOverlay.open').count();
        if (l2StillOpen > 0) { await page.click('#qlModalOverlay.open .u-drawer-close'); }
        await page.waitForFunction(() => !document.querySelector('#qlModalOverlay.open'), null, { timeout: 5000 });

        // ═══════════════════════════════════════════════════════════
        // T7：贴图直通——DataTransfer 模拟 paste 到新建弹窗 → 文件进入 qlPickerFiles('ql-create')
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T7：贴图直通（Ctrl+V 模拟）→ 文件进入 qlPickerFiles(ql-create) 预览区 ──');
        await page.click('button:has-text("+ 新建")');
        await page.waitForSelector('#qlModalOverlay.open', { timeout: 5000 });
        await page.waitForTimeout(200);
        const beforePaste = await page.evaluate(() => qlPickerFiles('ql-create').length);
        await shotOnFail(page, beforePaste === 0, 't7-pre-empty', `T7 前置：ql-create 附件数=0（实得=${beforePaste}）`);
        const pasteResult = await dispatchPaste(page, { withImage: true });
        await shotOnFail(page, pasteResult.defaultPrevented === true, 't7-default-prevented', `T7 纯图片粘贴：e.defaultPrevented=true（实得=${pasteResult.defaultPrevented}）`);
        await page.waitForTimeout(300);
        const afterPasteFiles = await page.evaluate(() => qlPickerFiles('ql-create').map(f => f.name));
        await shotOnFail(page, afterPasteFiles.length === 1, 't7-file-collected', `T7 粘贴后 ql-create 附件数=1（实得=${JSON.stringify(afterPasteFiles)}）`);
        const previewImgCount = await page.locator('#qlPreview_ql-create img.ql-clickable-thumb').count();
        await shotOnFail(page, previewImgCount === 1, 't7-preview-thumb', `T7 预览区出现 1 张缩略图（实得=${previewImgCount}）`);
        await page.click('#qlModalOverlay.open .u-drawer-close');   // 不提交，仅验证贴图直通本身
        await page.waitForTimeout(200);

        // ═══════════════════════════════════════════════════════════
        // T8：删除记录 → 列表消失
        // ═══════════════════════════════════════════════════════════
        console.log('\n── T8：删除记录 → 列表消失 ──');
        await page.locator('#qlTbody tr', { hasText: PREFIX + '编辑后新标题' }).locator('button:has-text("删除")').click();
        await page.waitForTimeout(500);
        const rowGoneCount = await page.locator('#qlTbody td:has-text("' + PREFIX + '编辑后新标题")').count();
        await shotOnFail(page, rowGoneCount === 0, 't8-row-gone', `T8 删除后列表不再出现该行（实得残留=${rowGoneCount}）`);

        // ═══════════════════════════════════════════════════════════
        // T9：全程 0 console error——admin page（驱动 T1-T8 全部零星事项交互）是本条断言的主体，口径
        //   按内容精确匹配扣除 L2 用例故意制造的 500 噪音（url 命中 .../quick-logs/.../attachments 且
        //   text 含 500/Failed to load resource），其余任何条目一律计入"意外报错"判失败，不会被数量
        //   差值悄悄一起扣掉。location().url 对"Failed to load resource"确实携带失败请求的真实 URL——
        //   已用独立探针脚本对本项目实际接口验证（403/500 场景均如实携带 endpoint URL），非凭印象假设。
        //   非 admin page：Quick_Log.html 的 admin-only 守卫在 DOMContentLoaded 最前面拦截（isAdmin()
        //   判定早于任何业务调用即 alert+跳转），没有 Sys_Iteration.html 那种"无条件预热探测调用"的
        //   历史包袱（旧版 siLoadIntakeLiaisons() 403 噪音是 Sys_Iteration.html 专属根因，与独立页无关）
        //   ——但实测发现另一类与本次改动完全无关的既有噪音：跳转落地页 Task_Pool.html 本身在 app.js
        //   顶层 DOMContentLoaded 里无条件调用 loadTasks()/loadPendingTransfers()（app.js L712-713，
        //   任意已登录用户、任意页面都会触发，非 admin/Task_Pool 专属逻辑，均经 authFetch 发起），实测
        //   两者都可能报 TypeError: Failed to fetch（网络层中止，非 4xx/5xx）——推断是"Quick_Log.html 用
        //   window.location.href 脚本内跳转 → Task_Pool.html 落地"这一路径下、落地页自身发起的请求与
        //   浏览器导航收尾时序竞争，与零星事项台账改动无关、也不是本次引入的回归。按"经 authFetch 发起
        //   + TypeError: Failed to fetch"这一共同签名精确豁免整类（非按每个调用点各自的错误前缀逐条列
        //   关键词——那样以后 app.js 顶层再挂新的无条件 fetch 调用又要照猫画虎加一条），其余任何报错
        //   （不满足这两个条件同时成立）仍一律计入失败。
        // ═══════════════════════════════════════════════════════════
        const l2InducedErrors = page._consoleErrors.filter(e =>
            /\/api\/quick-logs\/.*\/attachments/.test(e.url) && (/500/.test(e.text) || /Failed to load resource/i.test(e.text)));
        // 收紧为恰 1——多轮实测稳定命中 1 条；若浏览器/Playwright 行为变化导致 500 不再产生 console
        // error，这里红灯逼人回看扣除链路，而非 0 条静默通过削弱证明力。
        await shotOnFail(page, l2InducedErrors.length === 1, 't9-l2-noise-in-range',
            `T9 前置：L2 故意制造的 500 噪音条目数恰为 1（实得=${l2InducedErrors.length}${l2InducedErrors.length ? '：' + l2InducedErrors.map(e => e.text).join(' | ') : ''}）`);
        const adminUnexpectedErrors = page._consoleErrors.filter(e => !l2InducedErrors.includes(e));
        await shotOnFail(page, adminUnexpectedErrors.length === 0, 't9-console-clean-admin',
            `T9 admin page（T1-T8 全流程，已按内容精确匹配扣除 ${l2InducedErrors.length} 条 L2 500 噪音）无意外 JS 报错（实得=${adminUnexpectedErrors.length}，原始总数=${page._consoleErrors.length}${adminUnexpectedErrors.length ? '：' + adminUnexpectedErrors.map(e => e.text).slice(0, 3).join(' | ') : ''}）`);

        // codex 231 M 采纳：豁免加落地时序限定——仅当非 admin 确已被守卫跳转落地 Task_Pool.html 时，
        //   该页 app.js 全局初始化与跳转竞争产生的 authFetch TypeError 才可豁免；守卫未生效/未跳转的
        //   场景下同款报错照常计入失败，防豁免规则吞掉「守卫坏了但报错形状相同」的真实回归。
        const naLandedOnTaskPool = /Task_Pool\.html/.test(naPage.url());
        const naAllowlistedErrors = naPage._consoleErrors.filter(e =>
            naLandedOnTaskPool &&
            /at authFetch \(.*\/assets\/js\/app\.js/.test(e.text) && /TypeError: Failed to fetch/.test(e.text));
        const naUnexpectedErrors = naPage._consoleErrors.filter(e => !naAllowlistedErrors.includes(e));
        await shotOnFail(naPage, naUnexpectedErrors.length === 0, 't9-console-clean-nonadmin',
            `T9 非 admin page（守卫拦截 + 跳转 Task_Pool.html 全流程，已豁免 Task_Pool.html 落地页既有噪音 ${naAllowlistedErrors.length} 条：${naAllowlistedErrors.map(e => e.text.split('\n')[0]).join(' | ')}）无意外 JS 报错（实得=${naUnexpectedErrors.length}，原始总数=${naPage._consoleErrors.length}${naUnexpectedErrors.length ? '：' + naUnexpectedErrors.map(e => e.text).slice(0, 3).join(' | ') : ''}）`);

        await page.close();
        await naPage.close();
    } finally {
        await browser.close();
        await cleanupTestRows();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 零星事项台账 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 零星事项台账 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('❌ 脚本执行异常:', e && e.stack || e); process.exit(1); });
