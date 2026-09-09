/**
 * 附件压缩包支持方案 C5a：§5 V12 三页前端 Playwright 实测。
 * 范式照抄 test-sys-bug-hold-frontend-playwright.js（直接 SQL 造夹具 + JWT 注入 localStorage +
 * login.html 中继跳转 + 真实本地 server:3000 + 真实 task_pool.db）。
 *
 * 用法：本地 server（3000，已含 C1-C4 代码）就绪后：node scripts/test-attach-archive-frontend-playwright.js
 *
 * 覆盖：
 *   1 accept 属性逐入口（系统迭代 spec/delivery/screenshot 三键位 + 三处专用标签入口；修正 7 个 input；
 *     协作 f_files/f_data_scope/f_delivery_extra/f_admin_submit_extra 含，f_template/f_export_screenshot/
 *     f_delivery_script/f_delivery_data 不含）
 *   2 大小提示分流（51MB .zip→超过50MB；21MB .pdf→超过20MB；协作原始单据 11MB .pdf→超过10MB）
 *   3 标签文案（系统迭代通用弹窗按 key 分流 + 三处专用标签；修正完成/重提；协作两处 hint）
 *   4 协作交付弹窗联合计数（单类型超5 + 三类合计超15）
 *   5 非图片渲染（协作详情页 screenshot 类型 .zip 记录 → 📦 分支；result_extra 记录 → 补充材料行）
 *
 * 全程不点击会真实外呼钉钉/真实执行 SQL smoke test 的按钮（只做 accept/toast/label 静态与客户端校验观测，
 * 不提交任何表单到会触发 smoke test 或钉钉外呼的端点）。
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
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'attach-archive-playwright-shots');

const ADMIN_ID = 1;
const SYS_DEV_ID = 8;      // 示例开发A，既有 sys Playwright 脚本复用账号
const COLLAB_DEV_ID = 19;  // 示例用户B demo_user_b（_test-fixture.js DEV1_ID），既有 collab 脚本复用账号
const CORR_DEV_ID = 8;     // 复用同一账号即可（修正模块与系统迭代共用 users 表，无跨模块限制）
const TARGET_DB_CONN_ID = 2;

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
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
        const p = path.join(SCREENSHOT_DIR, `attach-archive-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图本身失败不影响主流程 */ }
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
async function toastText(page) {
    return (await page.locator('#toast-container').textContent().catch(() => '')).trim();
}
// 既有惯例（同 test-sys-bug-hold-frontend-playwright.js consoleErrorsExcludingKnown）：直插夹具跳过了完整
// 建单流程（估时/OA号/受理等），页面加载时一些非本次测试目标的辅助数据请求（如提交弹窗联动的完成超期
// 原因区块探测）可能命中权限或数据缺失的 403/404，这些是「探针夹具不完整」导致的已知噪音，非附件压缩包
// 改动引入的回归——按既有套件手法只过滤 403/404 资源加载失败，不放行其它任何 console error。
function consoleErrorsExcludingResourceErrors(page) {
    return (page._consoleErrors || []).filter(e => !/Failed to load resource.*40[034]/.test(e));
}
// 落盘构造指定大小的文件（内容全 0x41，MIME 不重要——三页校验均只看扩展名）。
// ⚠️ playwright setInputFiles 的 {name,mimeType,buffer} 内存传参上限 50MB（>50MB 抛异常），
//   本文件需要 51MB 用例，统一改走临时文件路径传参，避免这条硬限制。
const TMP_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-archive-pw-'));
function bigFile(name, sizeBytes) {
    const p = path.join(TMP_UPLOAD_DIR, name);
    fs.writeFileSync(p, Buffer.alloc(sizeBytes, 0x41));
    return p;
}

const RUN_TAG = Date.now();

// ═══════════════════════════════════════════════════════════════════════════
// 夹具登记（finally 统一清理）
// ═══════════════════════════════════════════════════════════════════════════
const createdSysIssueIds = [];
const createdCorrectionIds = [];
const createdCollabIds = [];

async function mkSysIssue({ type = 'feature', status, title, assignedTo = null, assignedToName = null }) {
    const r = await dbRun(
        `INSERT INTO sys_issues (type, status, priority, title, description, system_name, source,
            created_by, created_by_name, assigned_to, assigned_to_name, intake_required)
         VALUES (?, ?, 'P2', ?, ?, 'BMS', '内部', ?, ?, ?, ?, 1)`,
        [type, status, title, `${title}｜附件压缩包 C5a 前端探针-${RUN_TAG}`, ADMIN_ID, '管理员', assignedTo, assignedToName]
    );
    const id = r.lastID;
    createdSysIssueIds.push(id);
    return id;
}
async function mkSysDevAssignee(issueId, userId, userName) {
    await dbRun(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, 'active')`, [issueId, userId, userName]);
}

async function mkCorrectionRow(overrides = {}) {
    const base = {
        source_system: 'BMS', location_info: `附件压缩包 C5a 前端探针-${RUN_TAG}`, correction_count: 1,
        reason: `C5a 前端探针占位原因文本-${RUN_TAG}`, correction_type: 'single',
        requester_name: '业务张', requester_phone: '13800000001', status: 'IN_PROGRESS',
        created_by: ADMIN_ID, created_by_name: '管理员', assigned_to: CORR_DEV_ID, assigned_to_name: '示例开发A',
        oa_number: `datafix-c5a-${RUN_TAG}`,
    };
    const row = { ...base, ...overrides };
    const keys = Object.keys(row);
    const r = await dbRun(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    createdCorrectionIds.push(r.lastID);
    return r.lastID;
}

async function mkCollabRow(overrides = {}) {
    const base = {
        requester_dept: '市场营销部', requester_name: 'C5a前端探针', request_type: '数据修正',
        description: `C5a-前端探针-${RUN_TAG}`, deadline: '2026-12-31 18:00:00', status: 'PENDING',
        created_by: ADMIN_ID, created_by_name: '管理员', developer_id: COLLAB_DEV_ID, developer_name: '示例用户B',
        target_db_connection_id: TARGET_DB_CONN_ID, submission_version: 0,
    };
    const row = { ...base, ...overrides };
    const keys = Object.keys(row);
    const r = await dbRun(`INSERT INTO collab_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    createdCollabIds.push(r.lastID);
    return r.lastID;
}
async function mkCollabAttachment(reqId, attachmentType, fileName, originalName, status = 'active', submissionVersion = 1) {
    await dbRun(
        `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [reqId, attachmentType, fileName, originalName, ADMIN_ID, '管理员', submissionVersion, status]
    );
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    const sysDevTok = await signAs(SYS_DEV_ID);
    console.log('\n══════ 附件压缩包支持 C5a：三页 Playwright 前端实测 ══════');

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // 模块一：系统迭代 Sys_Iteration.html
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── 模块一：系统迭代 ──');
        const siIssue = await mkSysIssue({ type: 'feature', status: '开发中', title: `SI-C5a-${RUN_TAG}`, assignedTo: SYS_DEV_ID, assignedToName: '示例开发A' });
        await mkSysDevAssignee(siIssue, SYS_DEV_ID, '示例开发A');

        // ── 1a：modal-spec / modal-delivery / modal-screenshot（siOpenUploadModal 三种 type，真实点击打开）──
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${siIssue}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // spec
            await page.click('button:has-text("＋ 上传需求材料")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            let accept = await page.$eval('#siPickerInput_modal-spec', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept) && /\.rar/.test(accept) && /\.7z/.test(accept), 'si-spec-accept', `[1] modal-spec accept 含 .zip/.rar/.7z（实得："${accept}"）`);
            let label = await page.locator('#siMBody label').first().textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z 单个≤50MB/.test(label), 'si-spec-label', `[3] modal-spec 通用弹窗标签含「压缩包 zip/rar/7z 单个≤50MB」（实得："${label}"）`);
            // 大小提示：21MB .pdf → 超过 20MB
            await page.setInputFiles('#siPickerInput_modal-spec', bigFile('big.pdf', 21 * 1024 * 1024));
            await page.waitForTimeout(300);
            let t = await toastText(page);
            await shotOnFail(page, t.includes('超过 20MB'), 'si-spec-size-pdf', `[2] modal-spec 上传 21MB .pdf → toast 含「超过 20MB」（实得："${t}"）`);
            await page.click('.si-modal-foot button:has-text("取消")');
            await page.waitForTimeout(200);

            // delivery
            await page.click('button:has-text("＋ 上传交付物")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            accept = await page.$eval('#siPickerInput_modal-delivery', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept) && /\.rar/.test(accept) && /\.7z/.test(accept), 'si-delivery-accept', `[1] modal-delivery accept 含 .zip/.rar/.7z（实得："${accept}"）`);
            label = await page.locator('#siMBody label').first().textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z 单个≤50MB/.test(label), 'si-delivery-label', `[3] modal-delivery 通用弹窗标签含压缩包句（实得："${label}"）`);
            // 大小提示：51MB .zip → 超过 50MB
            await page.setInputFiles('#siPickerInput_modal-delivery', bigFile('big.zip', 51 * 1024 * 1024));
            await page.waitForTimeout(300);
            t = await toastText(page);
            await shotOnFail(page, t.includes('超过 50MB'), 'si-delivery-size-zip', `[2] modal-delivery 上传 51MB .zip → toast 含「超过 50MB」（实得："${t}"）`);
            await page.click('.si-modal-foot button:has-text("取消")');
            await page.waitForTimeout(200);

            // screenshot（不放开压缩包）
            await page.click('button:has-text("＋ 上传补充截图")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            accept = await page.$eval('#siPickerInput_modal-screenshot', el => el.getAttribute('accept') || '');
            await shotOnFail(page, !/\.zip/.test(accept) && !/\.rar/.test(accept) && !/\.7z/.test(accept), 'si-screenshot-accept', `[1] modal-screenshot accept **不**含 .zip/.rar/.7z（实得："${accept}"）`);
            label = await page.locator('#siMBody label').first().textContent();
            await shotOnFail(page, !/压缩包 zip\/rar\/7z 单个≤50MB/.test(label), 'si-screenshot-label', `[3] modal-screenshot 标签**不**含压缩包句（实得："${label}"）`);
            await page.click('.si-modal-foot button:has-text("取消")');
            await page.waitForTimeout(200);

            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'si-modal-console-clean', `模块一 a 段全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }

        // ── 1b：三处专用标签（create-spec / submit-delivery / resume-spec）──
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // create-spec：点「+ 新建迭代单」
            await page.click('button:has-text("+ 新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            let accept = await page.$eval('#siPickerInput_create-spec', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept) && /\.rar/.test(accept) && /\.7z/.test(accept), 'si-create-spec-accept', `[1] create-spec accept 含三扩展名（实得："${accept}"）`);
            const createLabel = await page.locator('#siMBody label').allTextContents();
            await shotOnFail(page, createLabel.some(l => /压缩包 zip\/rar\/7z 单个≤50MB/.test(l)), 'si-create-spec-label', `[3] 建单需求材料标签含压缩包句（实得：${JSON.stringify(createLabel)}）`);
            await page.click('.si-modal-foot button:has-text("取消")');
            await page.waitForTimeout(200);

            // submit-delivery：siModalSubmit(iss) 的表单本身不校验业务前置态（只读 iss.type/allowed_components
            //   等展示字段），真实「交付」按钮是否可点是另一套权限/状态门（估时/OA号等完整流程，超出 V12
            //   前端 accept/文案观测范围）——直接以开发本人 token 调 siModalSubmit({type:'feature'}) 打开弹窗，
            //   与真实点击「交付」按钮打开的是同一个 siModal 渲染路径，DOM 结构逐字一致。
            await page.close();
            const devPage = await loginPage(browser, sysDevTok);
            await devPage.goto(`${BASE_URL}/Sys_Iteration.html?issue=${siIssue}`);
            await devPage.waitForLoadState('networkidle');
            await devPage.waitForTimeout(500);
            await devPage.evaluate(() => siModalSubmit({ type: 'feature', allowed_components: ['frontend', 'backend'] }));
            await devPage.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            accept = await devPage.$eval('#siPickerInput_submit-delivery', el => el.getAttribute('accept') || '');
            await shotOnFail(devPage, /\.zip/.test(accept) && /\.rar/.test(accept) && /\.7z/.test(accept), 'si-submit-delivery-accept', `[1] submit-delivery accept 含三扩展名（实得："${accept}"）`);
            const submitLabel = await devPage.locator('#siMBody label').allTextContents();
            await shotOnFail(devPage, submitLabel.some(l => /压缩包 zip\/rar\/7z/.test(l)) || (await devPage.locator('#siMBody').textContent()).includes('压缩包 zip/rar/7z 单个≤50MB'), 'si-submit-delivery-label', `[3] 提交交付弹窗标签/hint 含压缩包句（实得 labels：${JSON.stringify(submitLabel)}）`);
            await devPage.click('.si-modal-foot button:has-text("取消")');
            await devPage.waitForTimeout(200);
            await shotOnFail(devPage, consoleErrorsExcludingResourceErrors(devPage).length === 0, 'si-submit-console-clean', `submit-delivery 段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(devPage))}）`);
            await devPage.close();

            // resume-spec：先暂缓再恢复（admin 视角，纯前端弹窗观测，不真正提交恢复表单，取消关闭）
            const page2 = await loginPage(browser, adminTok);
            await page2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${siIssue}`);
            await page2.waitForLoadState('networkidle');
            await page2.waitForTimeout(500);
            const holdBtn = page2.locator('#siDActions button:has-text("暂缓")');
            if (await holdBtn.count() > 0) {
                await holdBtn.click();
                await page2.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                await page2.fill('#f_reason', `C5a 前端探针暂缓原因-${RUN_TAG}`);
                await page2.click('#siMConfirm');
                await page2.waitForTimeout(600);
                const resumeBtn = page2.locator('#siDActions button:has-text("恢复")');
                await shotOnFail(page2, (await resumeBtn.count()) > 0, 'si-resume-btn-visible', '暂缓后「恢复」按钮可见（前置断言）');
                if (await resumeBtn.count() > 0) {
                    await resumeBtn.click();
                    await page2.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                    accept = await page2.$eval('#siPickerInput_resume-spec', el => el.getAttribute('accept') || '');
                    await shotOnFail(page2, /\.zip/.test(accept) && /\.rar/.test(accept) && /\.7z/.test(accept), 'si-resume-spec-accept', `[1] resume-spec accept 含三扩展名（实得："${accept}"）`);
                    const resumeLabel = await page2.locator('#siMBody label').allTextContents();
                    await shotOnFail(page2, resumeLabel.some(l => /压缩包 zip\/rar\/7z 单个≤50MB/.test(l)), 'si-resume-spec-label', `[3] 重启弹窗标签含压缩包句（实得：${JSON.stringify(resumeLabel)}）`);
                    await page2.click('.si-modal-foot button:has-text("取消")');
                    await page2.waitForTimeout(200);
                }
            } else {
                must(false, '「暂缓」按钮不可见（前置条件不满足，resume-spec 子测试跳过=计红）');
            }
            await shotOnFail(page2, consoleErrorsExcludingResourceErrors(page2).length === 0, 'si-resume-console-clean', `resume-spec 段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page2))}）`);
            await page2.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // 模块二：数据修正 Data_Correction.html
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── 模块二：数据修正 ──');
        const corrIP = await mkCorrectionRow({ status: 'IN_PROGRESS' });
        const corrFixed = await mkCorrectionRow({ status: 'FIXED' });
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Data_Correction.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 建单弹窗：formOaProofFiles / formErrorProofFiles
            await page.evaluate(() => openCreateModal());
            await page.waitForTimeout(200);
            let accept1 = await page.$eval('#formOaProofFiles', el => el.getAttribute('accept') || '');
            let accept2 = await page.$eval('#formErrorProofFiles', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept1) && /\.rar/.test(accept1) && /\.7z/.test(accept1), 'corr-oaproof-accept', `[1] formOaProofFiles accept 含三扩展名（实得："${accept1}"）`);
            await shotOnFail(page, /\.zip/.test(accept2) && /\.rar/.test(accept2) && /\.7z/.test(accept2), 'corr-errproof-accept', `[1] formErrorProofFiles accept 含三扩展名（实得："${accept2}"）`);
            await page.evaluate(() => closeCreateModal());
            await page.waitForTimeout(200);

            // 标完成弹窗：formCompleteFiles / formCompleteBatchFiles（single/batch 两组均在 DOM 内）
            await page.evaluate((id) => openComplete(id, 'single', false), corrIP);
            await page.waitForTimeout(200);
            let accept3 = await page.$eval('#formCompleteFiles', el => el.getAttribute('accept') || '');
            let accept4 = await page.$eval('#formCompleteBatchFiles', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept3) && /\.rar/.test(accept3) && /\.7z/.test(accept3), 'corr-complete-accept', `[1] formCompleteFiles accept 含三扩展名（实得："${accept3}"）`);
            await shotOnFail(page, /\.zip/.test(accept4) && /\.rar/.test(accept4) && /\.7z/.test(accept4), 'corr-completebatch-accept', `[1] formCompleteBatchFiles accept 含三扩展名（实得："${accept4}"）`);
            const completeLabel = await page.locator('#completeSingleProofLabel').textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z/.test(completeLabel), 'corr-complete-label', `[3] 标完成 label 含压缩包句（实得："${completeLabel}"）`);
            await page.evaluate(() => closeModal('completeModal'));
            await page.waitForTimeout(200);

            // 重修提交弹窗：formResubmitFiles / formResubmitBatchFiles
            await page.evaluate((id) => openResubmit(id, 'single', false), corrFixed);
            await page.waitForTimeout(200);
            let accept5 = await page.$eval('#formResubmitFiles', el => el.getAttribute('accept') || '');
            let accept6 = await page.$eval('#formResubmitBatchFiles', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept5) && /\.rar/.test(accept5) && /\.7z/.test(accept5), 'corr-resubmit-accept', `[1] formResubmitFiles accept 含三扩展名（实得："${accept5}"）`);
            await shotOnFail(page, /\.zip/.test(accept6) && /\.rar/.test(accept6) && /\.7z/.test(accept6), 'corr-resubmitbatch-accept', `[1] formResubmitBatchFiles accept 含三扩展名（实得："${accept6}"）`);
            const resubmitLabel = await page.locator('#resubmitSingleProofLabel').textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z/.test(resubmitLabel), 'corr-resubmit-label', `[3] 重修提交 label 含压缩包句（实得："${resubmitLabel}"）`);
            await page.evaluate(() => closeModal('resubmitModal'));
            await page.waitForTimeout(200);

            // 补充附件弹窗：formAttachFiles + 大小提示（21MB .pdf → 超过 20MB）
            await page.evaluate((id) => openAttach(id), corrFixed);
            await page.waitForTimeout(200);
            let accept7 = await page.$eval('#formAttachFiles', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(accept7) && /\.rar/.test(accept7) && /\.7z/.test(accept7), 'corr-attach-accept', `[1] formAttachFiles accept 含三扩展名（实得："${accept7}"）`);
            const attachHint = await page.locator('#attachModalHint').textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z/.test(attachHint), 'corr-attach-hint', `[3] 补充附件 hint 含压缩包句（实得："${attachHint}"）`);
            await page.setInputFiles('#formAttachFiles', bigFile('big.pdf', 21 * 1024 * 1024));
            await page.waitForTimeout(300);
            const corrToast = await toastText(page);
            await shotOnFail(page, corrToast.includes('超过 20MB'), 'corr-attach-size', `[2] 补充附件上传 21MB .pdf → toast 含「超过 20MB」（实得："${corrToast}"）`);
            await page.evaluate(() => closeModal('attachModal'));
            await page.waitForTimeout(200);

            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'corr-console-clean', `模块二全程无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // 模块三：数据协作 Data_Collab.html
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── 模块三：数据协作 ──');
        const collabPending = await mkCollabRow({ status: 'PENDING' });
        const collabDone = await mkCollabRow({ status: 'DONE', submission_version: 1 });
        // done_at 用字面量 SQL 表达式写不进参数化 INSERT，改用 UPDATE 补写
        await dbRun(`UPDATE collab_requests SET done_at = datetime('now','localtime') WHERE id = ?`, [collabDone]);
        await mkCollabAttachment(collabDone, 'result_data', `collab/${collabDone}_c5a/data.xlsx`, 'data.xlsx');
        await mkCollabAttachment(collabDone, 'result_script', `collab/${collabDone}_c5a/script.sql`, 'script.sql');
        await mkCollabAttachment(collabDone, 'result_extra', `collab/${collabDone}_c5a/extra.zip`, 'extra.zip');
        await mkCollabAttachment(collabDone, 'screenshot', `collab/${collabDone}_c5a/shot.zip`, 'shot.zip');

        // ── 3a：newModal（f_files / f_data_scope）+ 协作原始单据大小提示 ──
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Data_Collab.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('button:has-text("新建协作单")');
            await page.waitForSelector('#newModal.open', { timeout: 5000 });
            const acceptFiles = await page.$eval('#f_files', el => el.getAttribute('accept') || '');
            const acceptDs = await page.$eval('#f_data_scope', el => el.getAttribute('accept') || '');
            const acceptTpl = await page.$eval('#f_template', el => el.getAttribute('accept') || '');
            await shotOnFail(page, /\.zip/.test(acceptFiles) && /\.rar/.test(acceptFiles) && /\.7z/.test(acceptFiles), 'collab-ffiles-accept', `[1] f_files accept 含三扩展名（实得："${acceptFiles}"）`);
            await shotOnFail(page, /\.zip/.test(acceptDs) && /\.rar/.test(acceptDs) && /\.7z/.test(acceptDs), 'collab-fdatascope-accept', `[1] f_data_scope accept 含三扩展名（实得："${acceptDs}"）`);
            await shotOnFail(page, !/\.zip/.test(acceptTpl), 'collab-ftemplate-accept', `[1] f_template accept **不**含压缩包（实得："${acceptTpl}"）`);
            const hintFiles = await page.locator('#formRow_files div.u-hint').textContent();
            const hintDs = await page.locator('#formRow_dataScope div.u-hint').textContent();
            await shotOnFail(page, /压缩包 zip\/rar\/7z 单个≤50MB/.test(hintFiles), 'collab-ffiles-hint', `[3] f_files hint 含压缩包句（实得："${hintFiles}"）`);
            await shotOnFail(page, /压缩包 zip\/rar\/7z 单个≤50MB/.test(hintDs), 'collab-fdatascope-hint', `[3] f_data_scope hint 含压缩包句（实得："${hintDs}"）`);
            // 大小提示：原始单据 11MB .pdf → 超过 10MB
            await page.setInputFiles('#f_files', bigFile('big.pdf', 11 * 1024 * 1024));
            await page.waitForTimeout(300);
            const collabToast = await toastText(page);
            await shotOnFail(page, collabToast.includes('超过 10MB'), 'collab-ffiles-size', `[2] f_files 上传 11MB .pdf → toast 含「超过 10MB」（实得："${collabToast}"）`);
            await page.click('#newModal button:has-text("取消")');
            await page.waitForTimeout(200);
            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'collab-newmodal-console-clean', `newModal 段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }

        // ── 3b：submitDeliveryModal（f_delivery_extra）——开发本人视角，真实点击「上传交付物」──
        {
            const collabDevTok = await signAs(COLLAB_DEV_ID);
            const page = await loginPage(browser, collabDevTok);
            await page.goto(`${BASE_URL}/Data_Collab.html?id=${collabPending}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(700);
            const uploadBtn = page.locator('button:has-text("上传交付物")');
            await shotOnFail(page, (await uploadBtn.count()) > 0, 'collab-upload-btn-visible', '「上传交付物」按钮可见（PENDING 态开发本人视角，前置断言）');
            if (await uploadBtn.count() > 0) {
                await uploadBtn.first().click();
                await page.waitForSelector('#submitDeliveryModal.open', { timeout: 5000 });
                const acceptExtra = await page.$eval('#f_delivery_extra', el => el.getAttribute('accept') || '');
                const acceptScript = await page.$eval('#f_delivery_script', el => el.getAttribute('accept') || '');
                const acceptData = await page.$eval('#f_delivery_data', el => el.getAttribute('accept') || '');
                await shotOnFail(page, /\.zip/.test(acceptExtra) && /\.rar/.test(acceptExtra) && /\.7z/.test(acceptExtra), 'collab-fdeliveryextra-accept', `[1] f_delivery_extra accept 含三扩展名（实得："${acceptExtra}"）`);
                await shotOnFail(page, !/\.zip/.test(acceptScript), 'collab-fdeliveryscript-accept', `[1] f_delivery_script accept **不**含压缩包（实得："${acceptScript}"）`);
                await shotOnFail(page, !/\.zip/.test(acceptData), 'collab-fdeliverydata-accept', `[1] f_delivery_data accept **不**含压缩包（实得："${acceptData}"）`);

                // 单类型超 5：选 6 个 zip → toast「最多 5 个」
                const sixZips = Array.from({ length: 6 }, (_, i) => bigFile(`e${i}.zip`, 100));
                await page.setInputFiles('#f_delivery_extra', sixZips);
                await page.waitForTimeout(300);
                const t1 = await toastText(page);
                await shotOnFail(page, t1.includes('最多 5 个'), 'collab-extra-max5', `[4] f_delivery_extra 选 6 个 zip → toast 含「最多 5 个」（实现坏成什么样它会红：MULTI_FILE_MAX 判据被删/改错 → 6 个全部通过静默接收），实得："${t1}"`);

                // 三类合计超 15：★实测发现该分支在当前实现下不可达（即便白盒直接注入数组长度也测不到）——
                //   submitDelivery() 的校验顺序是「script>5 / data>5 / extra>5 逐类先各自拦」后才轮到「三类合计
                //   >15」联合检查；而三个 per-type 上限各自都是 5，其数学最大合法组合恰为 5+5+5=15，**等于**
                //   联合上限本身、永远不会**超过**它——所以联合检查这一分支在现有参数下是永远真值为假的死代码
                //   （见交付报告「拿不准的判断」，未按原计划断言，这不是测试写错，是回真相源核实后的诚实结论）。
                await page.click('#submitDeliveryModal button:has-text("取消")');
                await page.waitForTimeout(200);
            }
            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'collab-submitdelivery-console-clean', `submitDeliveryModal 段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }

        // ── 3c：adminSubmitModal（f_admin_submit_extra）——admin 视角，真实点击「📋 行政闭环」──
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Data_Collab.html?id=${collabPending}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(700);
            const adminBtn = page.locator('button:has-text("行政闭环")');
            await shotOnFail(page, (await adminBtn.count()) > 0, 'collab-adminsubmit-btn-visible', '「📋 行政闭环」按钮可见（PENDING 态 admin 视角，前置断言）');
            if (await adminBtn.count() > 0) {
                await adminBtn.first().click();
                await page.waitForSelector('#adminSubmitModal.open', { timeout: 5000 });
                const acceptAdminExtra = await page.$eval('#f_admin_submit_extra', el => el.getAttribute('accept') || '');
                await shotOnFail(page, /\.zip/.test(acceptAdminExtra) && /\.rar/.test(acceptAdminExtra) && /\.7z/.test(acceptAdminExtra), 'collab-fadminextra-accept', `[1] f_admin_submit_extra accept 含三扩展名（实得："${acceptAdminExtra}"）`);
                await page.click('#adminSubmitModal button:has-text("取消")');
                await page.waitForTimeout(200);
            }
            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'collab-adminsubmit-console-clean', `adminSubmitModal 段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }

        // ── 3d：非图片渲染——screenshot 类型 .zip 记录 → 📦 分支；result_extra 记录 → 补充材料行 ──
        {
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Data_Collab.html?id=${collabDone}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(700);
            const detailText = await page.locator('body').textContent();
            await shotOnFail(page, detailText.includes('补充材料（压缩包）'), 'collab-extra-section', `[5] 详情页出现「补充材料（压缩包）」区块（实现坏成什么样它会红：renderDeliverySection 未拼接 renderExtraSectionHtml() → 区块消失），实得片段：${detailText.includes('补充材料') ? '含"补充材料"字样但精确串缺失，需人工核对' : '完全无"补充材料"字样'}`);
            const shotImgCount = await page.locator('.screenshot-item img[src*="shot.zip"], .screenshot-item img[alt*="shot.zip"]').count();
            await shotOnFail(page, shotImgCount === 0, 'collab-shot-no-img', `[5] screenshot 类型 .zip 记录不渲染 <img>（实现坏成什么样它会红：isImg 判定被删/改错 → 试图把 .zip 当图片渲染出坏图），实得 <img> 命中数：${shotImgCount}`);
            const packageIconCount = await page.locator('.screenshot-item span:has-text("📦")').count();
            await shotOnFail(page, packageIconCount >= 1, 'collab-shot-package-icon', `[5] 截图区出现 📦 通用分支图标，实得数量：${packageIconCount}`);
            await shotOnFail(page, consoleErrorsExcludingResourceErrors(page).length === 0, 'collab-detail-console-clean', `详情页渲染段无 console error（实得：${JSON.stringify(consoleErrorsExcludingResourceErrors(page))}）`);
            await page.close();
        }
    } finally {
        // 🧹 清理测试夹具
        for (const id of createdSysIssueIds) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [id]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [id]);
            await dbRun(`DELETE FROM sys_issue_attachments WHERE issue_id=?`, [id]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [id]);
        }
        for (const id of createdCorrectionIds) {
            await dbRun(`DELETE FROM correction_attachments WHERE correction_request_id=?`, [id]);
            await dbRun(`DELETE FROM correction_status_history WHERE correction_request_id=?`, [id]);
            await dbRun(`DELETE FROM correction_requests WHERE id=?`, [id]);
        }
        for (const id of createdCollabIds) {
            await dbRun(`DELETE FROM collab_attachments WHERE collab_request_id=?`, [id]);
            await dbRun(`DELETE FROM collab_operation_logs WHERE collab_request_id=?`, [id]);
            await dbRun(`DELETE FROM collab_requests WHERE id=?`, [id]);
        }
        console.log(`\n  🧹 测试夹具已清理：sys_issues=${createdSysIssueIds.join(',')} correction_requests=${createdCorrectionIds.join(',')} collab_requests=${createdCollabIds.join(',')}`);
        try { fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) { console.log('  ❌ 附件压缩包支持 C5a 前端 Playwright 实测存在失败项'); process.exit(1); }
    console.log('  🎉 附件压缩包支持 C5a 前端 Playwright 实测全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
