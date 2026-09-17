/**
 * 系统迭代·验收通过 accept 说明+附件 / 验收打回 return 附件 前端 Playwright 冒烟
 * （2026-09-06 决策记录 D3/D4/J4-J13·S2b；2026-09-07 J13 修订：三写点统一凭证展示；
 *  2026-09-07 Opus 预筛回卷 1H/3M/5L：H1 uploadedIds 累加+总量闸+可见状态行+失效自愈、
 *  M1 软约束状态复位、M2/L1-L4 见下方 T6/T7 与各段详注）
 *
 * 用法：本地 server（3000，PID 20360，已含 S2a/S2b 后端+前端改动）已就绪后：
 *   node scripts/test-sys-accept-evidence-playwright.js
 *
 * 骨架抄 test-sys-post-release-accept-fail-note-playwright.js（登录/夹具/直查库/console error 断言范式）。
 * 前端改动是静态文件即时生效，不需重启本地 server（本文件只读/只走真实 HTTP+DB，不重启/不 kill 任何进程）。
 * 夹具走真实 API 造「待验证」态：improvement 单 ×6（T1/T2/T3/T5/T6/T7，submit mode=commits 避免触发 C9
 * 无 commit 直翻，保证落「待上线」非「已上线」，便于断言）+ bug 单 ×1（T4，return 目标态=处理中）。
 *
 * 覆盖：
 *   [静态-J13] siRenderTimeline 的 payload_json.attachment_ids 通用渲染块不按 action_code 收窄
 *       （2026-09-07 决策记录 J13 修订：liaison_test_pass/accept/return 三写点统一展示，S2a Opus 预筛
 *        HIGH 指出首版注释"仅 accept/return"与实现矛盾，主会话裁定外溢是期望行为——本断言钉住"条件不
 *        收窄"这件事本身，不复刻完整 feature→待对接测试→liaison_test_pass 真实链路，成本换等价保证）
 *   T1  accept 弹层：#f_note 与 #siPickerInput_accept-evidence 存在；#siAcceptSoftWarn 初始隐藏
 *   T2  软约束：不填不传点确定 → 软提示可见 ∧ 未发出 /accept 请求 ∧ 库内仍待验证；再点确定 → 200 ∧
 *       库内待上线 ∧ 该 accept 行 payload_json/summary 均 NULL
 *   T3  说明+附件真实链路：填说明 + setInputFiles 一张 png → 确定 → 库内 status=待上线；最新 accept 行
 *       payload_json.note===说明 ∧ attachment_ids 长度 1；该附件行 attachment_type='screenshot' ∧
 *       issue_id=本单；重新打开详情，时间线出现「验收说明：」文本与 📎 链接（文件名可见）
 *   T4  return 附件链路（bug 单）：打回弹层填原因+附件 → 库内 status=处理中（bug 流 return 目标态，
 *       transitions.js bug 段 :952-953）∧ payload_json.attachment_ids 长度 1 ∧ summary===原因
 *   T5  上传失败中止：选择 .exe 假文件 → picker collect 拒收（toast，不进 files）；再选合法 png，
 *       page.route 拦截 /attachments 返回 500 模拟上传失败（单据全程保持真实「待验证」，与"能否
 *       流转"解耦，防止误用无关状态闸掩盖问题——见脚本内 T5b 详注）→ 点确定 → 弹窗仍打开 ∧ 库内
 *       状态/accepted_at/accept 时间线行数均未被 accept 改动（证明上传失败真的中止了流转）
 *   T6  H1 修复钉子：填说明+选第一张图 → accept 首次拦成 409（非附件相关）→ 弹窗保留 +
 *       #siAcceptUploadedHint 可见（"已上传 1 个附件"）→ 再选第二张图 → accept 放行 → 库内
 *       payload_json.attachment_ids 长度 2（两张均关联）∧ 附件表恰 2 行（首张未重传）
 *   T7  M1 修复钉子（3 击设计，理由见脚本内详注）：①空态点确定→软提示+零请求；②填说明点确定→
 *       真实发请求（409）+ 旧软提示不残留可见；③清空说明再点确定→须重新出现软提示且不新增请求
 *       （证明 softConfirmed 已在②被非空路径复位，非误用①遗留的陈旧状态静默放行）
 *   （各段末尾均各自断言"全程无非预期 console error"，共用 filterExpectedConsoleErrors 同一口径）
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人
const DEV_ID = 8;        // 示例开发A（本地真实 active 非 viewer 账号，同既有多个 sys Playwright 脚本复用账号）
const RUN_TAG = Date.now();
const TITLE_PREFIX = `PW-验收凭证-${RUN_TAG}`;

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');   // [codex 500 M·磁盘清理] 与 server.js UPLOAD_DIR 同源（path.join(__dirname,'uploads')）

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `sae-fail-${name}.png`);
        try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
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
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEstStr() {
    const d = new Date(Date.now() + 30 * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function siPreviewCount(page, key) {
    return await page.$$eval(`#siPreview_${key} .si-file-item`, els => els.length).catch(() => 0);
}
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');   // 同 verify-sys-attachments.js 既有范式：内容不重要，只测扩展名/流程闸

// [L3·2026-09-07 主会话裁定] T1-T5(-T7) 共用同一套 console error 过滤口径——既有惯例只放行
// "Failed to load resource...40[049]"（4xx 探针场景既有噪音，各 T 段此前各写一份同款正则）；
// extraPattern 供个别段追加放行本段自己制造的预期噪音（如 T5 故意让 /attachments 返回 500）。
function filterExpectedConsoleErrors(errors, extraPattern) {
    return (errors || []).filter(e => {
        if (/Failed to load resource.*40[049]/.test(e)) return false;
        if (extraPattern && extraPattern.test(e)) return false;
        return true;
    });
}

// ═══════════════════════════════════════════════════════════════
// [静态-J13] siRenderTimeline 的 payload_json.attachment_ids 通用渲染块不按 action_code 收窄
//   ——2026-09-07 决策记录 J13 修订：该块须对 liaison_test_pass/accept/return 三写点统一生效，不能
//   收窄成"仅 accept/return"（S2a Opus 预筛 HIGH：首版注释与实现矛盾，主会话裁定外溢是期望行为）。
//   不复刻完整 feature→待对接测试→liaison_test_pass 真实链路（构造成本高：需 risk_level+GATE 全完成
//   +对接人有效等前置），改用源码结构断言钉住"条件不收窄"这件事本身——若未来有人往这块加
//   action_code==='accept' 之类窄化判据，本断言先红。
// ═══════════════════════════════════════════════════════════════
function staticCheckTimelineAttachmentBlockNotNarrowed() {
    const htmlPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
    const src = fs.readFileSync(htmlPath, 'utf8');
    const startMarker = 'if (e.payload_json) {';
    const endMarker = 'const flow = (e.from_status';
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker, startIdx);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
        throw new Error('[静态-J13 前置] 未能在 Sys_Iteration.html 定位 siRenderTimeline 的通用凭证渲染块（锚点缺失，源码结构已变化，需人工核实）');
    }
    const block = src.slice(startIdx, endIdx);
    const narrowedByAction = /action_code\s*===\s*['"](?:accept|return|liaison_test_pass)['"]/.test(block);
    must(!narrowedByAction, '[静态-J13] 通用凭证渲染块不含 action_code===\'accept\'/\'return\'/\'liaison_test_pass\' 之类窄化判据（三写点统一展示，未来窄化本断言先红）');
    const narrowedByEventType = /e\.event_type\s*===\s*['"](?:status_change|return)['"]/.test(block);
    must(!narrowedByEventType, '[静态-J13] 通用凭证渲染块不含 e.event_type 窄化判据（同上，防换一种方式收窄）');
    must(block.includes('Array.isArray(p.attachment_ids)'), '[静态-J13] 渲染块判据锚点 Array.isArray(p.attachment_ids) 仍在位（防未来重构误删本条件本身）');
    must(block.includes("evidenceIdSet.has(a.id)"), '[静态-J13] 渲染块按 id 匹配 atts（evidenceIdSet.has(a.id)）逻辑仍在位');
}

let seq = 0;
let oaSeq = 20260906100;
async function mkImprovementToVerify(adminTok, devTok, suffix) {
    seq++;
    const r = await fetch(`${BASE_URL}/api/sys-issues`, {
        method: 'POST', headers: jsonHeaders(adminTok),
        body: JSON.stringify({
            intake_contract_version: 2, type: 'improvement', title: `${TITLE_PREFIX}-${suffix}-${seq}`,
            system_name: 'BMS', source: '内部', description: '验收说明附件前端探针夹具', intake_liaison_id: LIAISON_ID,
        }),
    });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`[夹具-建单] 应 201，实得 ${r.status} ${JSON.stringify(body)}`);
    const id = body.id;
    let resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ risk_level: '二级' }) });
    if (resp.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/set-oa-number`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ oa_number: String(oaSeq++) }) });
    if (resp.status !== 200) throw new Error(`[夹具-OA号] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: DEV_ID }) });
    if (resp.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr(), estimated_effort_days: 1 }) });
    if (resp.status !== 200) throw new Error(`[夹具-估时] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: `pw-accept-evi-${id}` }], self_tested: true, test_env_deployed: true }),
    });
    const submitBody = await resp.json();
    if (resp.status !== 200) throw new Error(`[夹具-提交] 应 200，实得 ${resp.status} ${JSON.stringify(submitBody)}`);
    if (submitBody.main_status !== '待验证') throw new Error(`[夹具-提交] main_status 应为「待验证」（≥1 条 commit 不触发 C9 直翻），实得 ${submitBody.main_status}`);
    return id;
}
async function mkBugToVerify(adminTok, devTok, suffix) {
    seq++;
    const r = await fetch(`${BASE_URL}/api/sys-issues`, {
        method: 'POST', headers: jsonHeaders(adminTok),
        body: JSON.stringify({
            intake_contract_version: 2, type: 'bug', title: `${TITLE_PREFIX}-${suffix}-${seq}`,
            system_name: 'BMS', source: '内部', description: '验收打回附件前端探针夹具', intake_liaison_id: LIAISON_ID,
        }),
    });
    const body = await r.json();
    if (r.status !== 201) throw new Error(`[夹具-建单] 应 201，实得 ${r.status} ${JSON.stringify(body)}`);
    const id = body.id;
    let resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
    if (resp.status !== 200) throw new Error(`[夹具-受理] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: DEV_ID }) });
    if (resp.status !== 200) throw new Error(`[夹具-指派] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr() }) });
    if (resp.status !== 200) throw new Error(`[夹具-估时] 应 200，实得 ${resp.status} ${JSON.stringify(await resp.json().catch(() => null))}`);
    resp = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', self_tested: true, test_env_deployed: true, bug_cause_note: 'PW 验收凭证探针：bug 产生原因', commits: [{ component: 'backend', commit_ref: `pw-accept-evi-bug-${id}` }] }),
    });
    const submitBody = await resp.json();
    if (resp.status !== 200) throw new Error(`[夹具-提交] 应 200，实得 ${resp.status} ${JSON.stringify(submitBody)}`);
    if (submitBody.main_status !== '待验证') throw new Error(`[夹具-提交] main_status 应为「待验证」，实得 ${submitBody.main_status}`);
    return id;
}

// 同 test-sys-post-release-accept-fail-note-playwright.js 既有范式（playwright_suite_gotchas.md 第4条）：
// 跑前先探测端口 Listen + 应用层 readiness（防孤儿进程/端口误占用），给出精确错误而非含糊超时。
function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时（${timeoutMs}ms）——server 未就绪或响应异常`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js 再跑本文件`)); });
    });
}
async function ensureAppReadinessEndpoint() {
    const r = await fetch(`${BASE_URL}/api/sys-issues/_readiness`).catch((e) => {
        throw new Error(`应用 readiness 探测请求失败（${e.message}）——端口监听者可能不是目标 server.js`);
    });
    if (r.status !== 401) {
        throw new Error(`应用 readiness 探测异常：期望 401（authenticateToken 未登录，证明路由存在且是本模块），实得 ${r.status}——监听该端口的可能不是目标 server.js（孤儿进程/端口被其它服务占用）`);
    }
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');
    console.log('\n══════ 系统迭代·验收说明附件/打回附件 前端 Playwright 冒烟 ══════');

    console.log('\n── [静态-J13] 通用凭证渲染块不按 action_code 收窄 ──');
    staticCheckTimelineAttachmentBlockNotNarrowed();

    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);

    const createdIds = [];
    const tmpFiles = [];
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：accept 弹层字段存在性 + 软提示初始隐藏
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T1：accept 弹层字段存在性 ──');
        const id1 = await mkImprovementToVerify(adminTok, devTok, 'T1');
        createdIds.push(id1);
        const page1 = await loginPage(browser, adminTok);
        await page1.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id1}`);
        await page1.waitForLoadState('networkidle');
        await page1.waitForTimeout(600);
        await page1.click('#siDActions button:has-text("验收通过")');
        await page1.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page1.waitForTimeout(200);

        await shotOnFail(page1, (await page1.locator('#f_note').count()) === 1, 't1-note-field', '#f_note 说明输入框存在');
        await shotOnFail(page1, (await page1.locator('#siPickerInput_accept-evidence').count()) === 1, 't1-picker-input', '#siPickerInput_accept-evidence 附件选择 input 存在');
        const warnDisplay1 = await page1.locator('#siAcceptSoftWarn').evaluate(el => getComputedStyle(el).display);
        await shotOnFail(page1, warnDisplay1 === 'none', 't1-softwarn-hidden', `#siAcceptSoftWarn 初始隐藏（实得 display=${warnDisplay1}）`);
        const t1Errors = filterExpectedConsoleErrors(page1._consoleErrors);
        await shotOnFail(page1, t1Errors.length === 0, 't1-console-clean', `T1 全程无非预期 console error（实得 ${t1Errors.length} 个）${t1Errors.length ? '：' + JSON.stringify(t1Errors) : ''}`);
        await page1.close();

        // ═══════════════════════════════════════════════════════════════
        // T2：软约束——不填不传首次点确定只警示零副作用，二次点确定放行
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T2：软约束 ──');
        const id2 = await mkImprovementToVerify(adminTok, devTok, 'T2');
        createdIds.push(id2);
        const page2 = await loginPage(browser, adminTok);
        await page2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id2}`);
        await page2.waitForLoadState('networkidle');
        await page2.waitForTimeout(600);
        await page2.click('#siDActions button:has-text("验收通过")');
        await page2.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page2.waitForTimeout(200);

        const acceptReqs = [];
        const onAcceptReq = (req) => { if (req.method() === 'POST' && req.url().includes('/accept')) acceptReqs.push(req.url()); };
        page2.on('request', onAcceptReq);
        await page2.click('#siMConfirm');
        await page2.waitForTimeout(400);
        const warnDisplay2 = await page2.locator('#siAcceptSoftWarn').evaluate(el => getComputedStyle(el).display);
        await shotOnFail(page2, warnDisplay2 !== 'none', 't2-softwarn-visible', `首次点确定后软提示应可见（实得 display=${warnDisplay2}）`);
        await shotOnFail(page2, acceptReqs.length === 0, 't2-no-request', `软约束首次点击不应发出 /accept 请求（实得 ${acceptReqs.length} 次）`);
        const row2a = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id2]);
        await shotOnFail(page2, row2a.status === '待验证', 't2-still-verify', `首次点击后库内仍「待验证」（实得=${row2a.status}）`);

        await page2.click('#siMConfirm');
        await page2.waitForTimeout(600);
        page2.off('request', onAcceptReq);
        await shotOnFail(page2, acceptReqs.length === 1, 't2-second-click-request', `二次点击应发出恰 1 次 /accept 请求（实得 ${acceptReqs.length} 次）`);
        const modalClosedT2 = await page2.locator('#siModalOverlay.open').count();
        await shotOnFail(page2, modalClosedT2 === 0, 't2-modal-closed', '二次点击后弹窗关闭（accept 成功）');
        const row2b = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id2]);
        await shotOnFail(page2, row2b.status === '待上线', 't2-status-online-pending', `二次点击后库内「待上线」（实得=${row2b.status}）`);
        const tl2 = await dbGet(`SELECT payload_json, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id2]);
        await shotOnFail(page2, !!tl2 && tl2.payload_json === null, 't2-payload-null', `最新 accept 行 payload_json 应 NULL（实得=${tl2 && tl2.payload_json}）`);
        await shotOnFail(page2, !!tl2 && tl2.summary === null, 't2-summary-null', `最新 accept 行 summary 应 NULL（实得=${tl2 && tl2.summary}）`);
        const t2Errors = filterExpectedConsoleErrors(page2._consoleErrors);
        await shotOnFail(page2, t2Errors.length === 0, 't2-console-clean', `T2 全程无非预期 console error（实得 ${t2Errors.length} 个）${t2Errors.length ? '：' + JSON.stringify(t2Errors) : ''}`);
        await page2.close();

        // ═══════════════════════════════════════════════════════════════
        // T3：说明+附件真实链路
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3：说明+附件真实链路 ──');
        const id3 = await mkImprovementToVerify(adminTok, devTok, 'T3');
        createdIds.push(id3);
        const page3 = await loginPage(browser, adminTok);
        await page3.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
        await page3.waitForLoadState('networkidle');
        await page3.waitForTimeout(600);
        await page3.click('#siDActions button:has-text("验收通过")');
        await page3.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page3.waitForTimeout(200);

        const t3Note = 'Playwright T3 前端探针：验收通过，功能符合预期';
        await page3.fill('#f_note', t3Note);
        const pngPath3 = path.join(os.tmpdir(), `sys-accept-evi-t3-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath3, PNG_BYTES);
        tmpFiles.push(pngPath3);
        await page3.setInputFiles('#siPickerInput_accept-evidence', pngPath3);
        await page3.waitForTimeout(200);
        await shotOnFail(page3, (await siPreviewCount(page3, 'accept-evidence')) === 1, 't3-preview-1', '选择合法 png 后预览区应有 1 项');

        await page3.click('#siMConfirm');
        await page3.waitForTimeout(800);
        const modalClosedT3 = await page3.locator('#siModalOverlay.open').count();
        await shotOnFail(page3, modalClosedT3 === 0, 't3-modal-closed', '说明+附件提交成功，弹窗关闭');
        const row3 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id3]);
        await shotOnFail(page3, row3.status === '待上线', 't3-status', `库内 status=待上线（实得=${row3.status}）`);
        const tl3 = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id3]);
        let payload3 = null;
        try { payload3 = tl3 && JSON.parse(tl3.payload_json); } catch (_) { payload3 = null; }
        await shotOnFail(page3, !!payload3 && payload3.note === t3Note, 't3-payload-note', `payload_json.note===说明（实得=${JSON.stringify(payload3)}）`);
        await shotOnFail(page3, !!payload3 && Array.isArray(payload3.attachment_ids) && payload3.attachment_ids.length === 1, 't3-payload-att-len', `payload_json.attachment_ids 长度 1（实得=${JSON.stringify(payload3 && payload3.attachment_ids)}）`);
        const attId3 = payload3 && payload3.attachment_ids && payload3.attachment_ids[0];
        const attRow3 = attId3 ? await dbGet('SELECT attachment_type, issue_id, original_name FROM sys_issue_attachments WHERE id=?', [attId3]) : null;
        await shotOnFail(page3, !!attRow3 && attRow3.attachment_type === 'screenshot', 't3-att-type', `附件行 attachment_type=screenshot（实得=${attRow3 && attRow3.attachment_type}）`);
        await shotOnFail(page3, !!attRow3 && Number(attRow3.issue_id) === id3, 't3-att-issue', `附件行 issue_id=本单（实得=${attRow3 && attRow3.issue_id}）`);

        // 重新打开详情，时间线出现「验收说明：」文本与 📎 链接（文件名可见）
        await page3.reload();
        await page3.waitForLoadState('networkidle');
        await page3.waitForTimeout(700);
        const tlText3 = await page3.locator('.si-timeline').innerText().catch(() => '');
        await shotOnFail(page3, /验收说明：/.test(tlText3), 't3-timeline-note-text', `重新打开详情后时间线含"验收说明："文本（实得片段="${(tlText3 || '').slice(0, 300)}"）`);
        const attLinkCount3 = await page3.locator('.si-timeline .si-tl-att a').count();
        await shotOnFail(page3, attLinkCount3 >= 1, 't3-timeline-att-link', `时间线出现 📎 附件下载链接（实得 ${attLinkCount3} 个）`);
        const attLinkText3 = await page3.locator('.si-timeline .si-tl-att a').first().textContent().catch(() => '');
        const expectedFileName3 = attRow3 && attRow3.original_name;
        await shotOnFail(page3, !!expectedFileName3 && (attLinkText3 || '').includes(expectedFileName3), 't3-timeline-att-filename', `📎 链接文件名可见（期望含"${expectedFileName3}"，实得="${attLinkText3}"）`);
        const t3Errors = filterExpectedConsoleErrors(page3._consoleErrors);
        await shotOnFail(page3, t3Errors.length === 0, 't3-console-clean', `T3 全程无非预期 console error（实得 ${t3Errors.length} 个）${t3Errors.length ? '：' + JSON.stringify(t3Errors) : ''}`);
        await page3.close();

        // ═══════════════════════════════════════════════════════════════
        // T4：return 附件链路（bug 单）
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T4：return 附件链路（bug 单） ──');
        const id4 = await mkBugToVerify(adminTok, devTok, 'T4');
        createdIds.push(id4);
        const page4 = await loginPage(browser, adminTok);
        await page4.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id4}`);
        await page4.waitForLoadState('networkidle');
        await page4.waitForTimeout(600);
        await page4.click('#siDActions button:has-text("验收打回")');
        await page4.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page4.waitForTimeout(200);

        const t4Reason = 'Playwright T4 前端探针：问题复现，请修复';
        await page4.fill('#f_reason', t4Reason);
        const pngPath4 = path.join(os.tmpdir(), `sys-accept-evi-t4-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath4, PNG_BYTES);
        tmpFiles.push(pngPath4);
        await page4.setInputFiles('#siPickerInput_return-evidence', pngPath4);
        await page4.waitForTimeout(200);
        await shotOnFail(page4, (await siPreviewCount(page4, 'return-evidence')) === 1, 't4-preview-1', '选择合法 png 后预览区应有 1 项');

        await page4.click('#siMConfirm');
        await page4.waitForTimeout(800);
        const modalClosedT4 = await page4.locator('#siModalOverlay.open').count();
        await shotOnFail(page4, modalClosedT4 === 0, 't4-modal-closed', '打回原因+附件提交成功，弹窗关闭');
        const row4 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id4]);
        await shotOnFail(page4, row4.status === '处理中', 't4-status', `库内 status=处理中（bug 流 return 目标态，transitions.js :952-953，实得=${row4.status}）`);
        const tl4 = await dbGet(`SELECT payload_json, summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='return' ORDER BY id DESC LIMIT 1`, [id4]);
        let payload4 = null;
        try { payload4 = tl4 && JSON.parse(tl4.payload_json); } catch (_) { payload4 = null; }
        await shotOnFail(page4, !!payload4 && Array.isArray(payload4.attachment_ids) && payload4.attachment_ids.length === 1, 't4-payload-att-len', `payload_json.attachment_ids 长度 1（实得=${JSON.stringify(payload4 && payload4.attachment_ids)}）`);
        await shotOnFail(page4, !!tl4 && tl4.summary === t4Reason, 't4-summary', `summary===原因（实得=${tl4 && tl4.summary}）`);

        // [L2·2026-09-07 主会话裁定] 复用 T3 同款四行——附件行 attachment_type/issue_id + 重新打开详情后
        // 时间线 📎 计数与文件名（J13 三写点统一展示对 return 行同样成立，此前 T4 只测了 payload_json，
        // 没测到渲染面，覆盖面与 T3 不对称）。
        const attId4 = payload4 && payload4.attachment_ids && payload4.attachment_ids[0];
        const attRow4 = attId4 ? await dbGet('SELECT attachment_type, issue_id, original_name FROM sys_issue_attachments WHERE id=?', [attId4]) : null;
        await shotOnFail(page4, !!attRow4 && attRow4.attachment_type === 'screenshot', 't4-att-type', `附件行 attachment_type=screenshot（实得=${attRow4 && attRow4.attachment_type}）`);
        await shotOnFail(page4, !!attRow4 && Number(attRow4.issue_id) === id4, 't4-att-issue', `附件行 issue_id=本单（实得=${attRow4 && attRow4.issue_id}）`);
        await page4.reload();
        await page4.waitForLoadState('networkidle');
        await page4.waitForTimeout(700);
        const attLinkCount4 = await page4.locator('.si-timeline .si-tl-att a').count();
        await shotOnFail(page4, attLinkCount4 >= 1, 't4-timeline-att-link', `时间线出现 📎 附件下载链接（实得 ${attLinkCount4} 个）`);
        const attLinkText4 = await page4.locator('.si-timeline .si-tl-att a').first().textContent().catch(() => '');
        const expectedFileName4 = attRow4 && attRow4.original_name;
        await shotOnFail(page4, !!expectedFileName4 && (attLinkText4 || '').includes(expectedFileName4), 't4-timeline-att-filename', `📎 链接文件名可见（期望含"${expectedFileName4}"，实得="${attLinkText4}"）`);

        const t4Errors = filterExpectedConsoleErrors(page4._consoleErrors);
        await shotOnFail(page4, t4Errors.length === 0, 't4-console-clean', `T4 全程无非预期 console error（实得 ${t4Errors.length} 个）${t4Errors.length ? '：' + JSON.stringify(t4Errors) : ''}`);
        await page4.close();

        // ═══════════════════════════════════════════════════════════════
        // T5：上传失败中止流转
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5：上传失败中止流转 ──');
        const id5 = await mkImprovementToVerify(adminTok, devTok, 'T5');
        createdIds.push(id5);
        const page5 = await loginPage(browser, adminTok);
        await page5.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5}`);
        await page5.waitForLoadState('networkidle');
        await page5.waitForTimeout(600);
        await page5.click('#siDActions button:has-text("验收通过")');
        await page5.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5.waitForTimeout(200);

        // ── T5a：.exe 假文件 → picker collect 拒收（不进 files），视同无附件路径 ──
        const exePath = path.join(os.tmpdir(), `sys-accept-evi-t5-${RUN_TAG}.exe`);
        fs.writeFileSync(exePath, Buffer.from([0x4d, 0x5a]));   // MZ 头，内容不重要，只测扩展名闸
        tmpFiles.push(exePath);
        await page5.setInputFiles('#siPickerInput_accept-evidence', exePath);
        await page5.waitForTimeout(200);
        const toastAfterExe = await page5.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page5, /不支持的格式/.test(toastAfterExe), 't5-exe-rejected-toast', `.exe 被 picker collect 拒收（toast 含"不支持的格式"，实得="${toastAfterExe}"）`);
        await shotOnFail(page5, (await siPreviewCount(page5, 'accept-evidence')) === 0, 't5-exe-not-in-files', '.exe 未进入 files（预览区仍 0 项，视同无附件路径）');

        // ── T5b：再选合法 png，用 page.route 拦截 /attachments 端点返回 500 模拟上传失败（spec B4 兜底
        //   方案）——⚠️ 刻意不用"SQL 把单据改成已上线"构造真实 409：那样会让单据同时落入
        //   "非待验证态不可 accept"的独立后端闸门，一旦 accept 意外被调用也会被那道闸拦下 200→400，
        //   使本用例失去"专测上传失败是否真的阻断了 accept 调用"的判别力（活体变异①"删掉 return false"
        //   在那种构造下无法被本用例观测到——踩坑记录见开发报告）。改用路由拦截：单据全程保持真实
        //   「待验证」（accept 的合法前置态），upload 失败与"能否流转"两件事解耦，若活体变异①让
        //   流程带着空 attachment_ids 继续调 accept，accept 会真的 200 成功、状态真的滑到「待上线」——
        //   这才是能被断言直接抓到的可观测差异。
        const pngPath5 = path.join(os.tmpdir(), `sys-accept-evi-t5-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath5, PNG_BYTES);
        tmpFiles.push(pngPath5);
        await page5.setInputFiles('#siPickerInput_accept-evidence', pngPath5);
        await page5.waitForTimeout(200);
        await shotOnFail(page5, (await siPreviewCount(page5, 'accept-evidence')) === 1, 't5-png-selected', '合法 png 已选入（预览区 1 项）');

        const rowBefore5 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id5]);
        await shotOnFail(page5, rowBefore5.status === '待验证', 't5-precondition-still-verify', `前置：单据全程保持「待验证」（合法 accept 前置态，不借道无关的状态闸），实得=${rowBefore5.status}`);

        await page5.route(`**/api/sys-issues/${id5}/attachments`, (route) => {
            if (route.request().method() === 'POST') {
                route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟上传服务异常', code: 'SIMULATED_UPLOAD_FAILURE' }) });
            } else {
                route.continue();
            }
        });

        await page5.click('#siMConfirm');
        await page5.waitForTimeout(800);
        const modalStillOpenT5 = await page5.locator('#siModalOverlay.open').count();
        await shotOnFail(page5, modalStillOpenT5 === 1, 't5-modal-stays-open', '上传失败后弹窗仍打开（未被当作"无附件路径"直接放行验收）');
        const toastAfterUploadFail = await page5.locator('#toast-container').textContent().catch(() => '');
        // [M2·2026-09-07 主会话裁定] 断言改具体文案（非仅 length>0）——showToast 停留 3 秒才移除，
        // T5a 的 ".exe 不支持的格式" 拒收 toast 若还没消失，length>0 会被那条旧 toast 兜住恒绿，测不出
        // 本段真正要证明的"上传失败确实报了错"。改钉路由模拟响应体里的 error 原文，只有这次上传失败
        // 触发的新 toast 才会命中。
        await shotOnFail(page5, /模拟上传服务异常/.test(toastAfterUploadFail || ''), 't5-upload-fail-toast', `上传失败 toast 应含具体文案"模拟上传服务异常"（实得="${toastAfterUploadFail}"）`);
        const rowAfter5 = await dbGet('SELECT status, accepted_at FROM sys_issues WHERE id=?', [id5]);
        await shotOnFail(page5, rowAfter5.status === '待验证', 't5-status-unchanged', `上传失败应中止流转——accept 从未被调用，库内状态仍「待验证」（实得=${rowAfter5.status}）`);
        await shotOnFail(page5, !rowAfter5.accepted_at, 't5-accepted-at-not-set', `accepted_at 未被写入（accept 端点从未被调用，实得=${rowAfter5.accepted_at}）`);
        const acceptTlAfter5 = await dbGet(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept'`, [id5]);
        await shotOnFail(page5, acceptTlAfter5.c === 0, 't5-no-accept-timeline', `无 accept 时间线行产生（证明 accept 端点从未被调用，实得 ${acceptTlAfter5.c} 条）`);
        await page5.unroute(`**/api/sys-issues/${id5}/attachments`);
        // T5 专属放宽：本段用 page.route 故意让 /attachments 返回 500（见上方注释），浏览器必记一条
        // "Failed to load resource...500" 控制台噪音——这是本用例自己制造的预期噪音，非真实缺陷信号，
        // 故用 extraPattern 额外放行 500（其余 T 段仍只走 filterExpectedConsoleErrors 的默认口径）。
        const t5Errors = filterExpectedConsoleErrors(page5._consoleErrors, /500/);
        await shotOnFail(page5, t5Errors.length === 0, 't5-console-clean', `T5 全程无非预期 console error（实得 ${t5Errors.length} 个）${t5Errors.length ? '：' + JSON.stringify(t5Errors) : ''}`);
        await page5.close();

        // ═══════════════════════════════════════════════════════════════
        // T8【codex 500 M 采纳】：上传端点异常返回 200 但 attachments 为空 → 前端 fail-closed 中止流转
        //   （不 reset picker、不调 accept、库内仍待验证），防「可选附件」语义掩盖实际上传丢失
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T8：上传响应 200 但 attachments 为空 → 前端 fail-closed 中止 ──');
        const id8 = await mkImprovementToVerify(adminTok, devTok, 'T8');
        createdIds.push(id8);
        const page8 = await loginPage(browser, adminTok);
        await page8.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id8}`);
        await page8.waitForLoadState('networkidle');
        await page8.waitForTimeout(600);
        await page8.click('#siDActions button:has-text("验收通过")');
        await page8.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page8.waitForTimeout(200);
        const pngPath8 = path.join(os.tmpdir(), `sys-accept-evi-t8-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath8, PNG_BYTES);
        tmpFiles.push(pngPath8);
        await page8.setInputFiles('#siPickerInput_accept-evidence', pngPath8);
        await page8.waitForTimeout(200);
        await shotOnFail(page8, (await siPreviewCount(page8, 'accept-evidence')) === 1, 't8-png-selected', '合法 png 已选入（预览区 1 项）');
        let acceptReqCount8 = 0;
        page8.on('request', (r) => { if (r.method() === 'POST' && r.url().includes(`/api/sys-issues/${id8}/accept`)) acceptReqCount8++; });
        await page8.route(`**/api/sys-issues/${id8}/attachments`, (route) => {
            if (route.request().method() === 'POST') {
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: id8, attachment_type: 'screenshot', attachments: [] }) });
            } else {
                route.continue();
            }
        });
        await page8.click('#siMConfirm');
        await page8.waitForTimeout(800);
        await shotOnFail(page8, (await page8.locator('#siModalOverlay.open').count()) === 1, 't8-modal-stays-open', '上传响应不完整后弹窗仍打开（未流转）');
        const toast8 = await page8.locator('#toast-container').textContent().catch(() => '');
        await shotOnFail(page8, /附件上传响应不完整/.test(toast8 || ''), 't8-incomplete-toast', `toast 含具体文案"附件上传响应不完整"（实得="${toast8}"）`);
        await shotOnFail(page8, (await siPreviewCount(page8, 'accept-evidence')) === 1, 't8-picker-kept', '响应不完整时 picker 未被 reset（已选文件保留可重试）');
        await shotOnFail(page8, acceptReqCount8 === 0, 't8-no-accept-request', `未发出 /accept 请求（实得 ${acceptReqCount8} 次）`);
        const rowAfter8 = await dbGet('SELECT status, accepted_at FROM sys_issues WHERE id=?', [id8]);
        await shotOnFail(page8, rowAfter8.status === '待验证' && !rowAfter8.accepted_at, 't8-status-unchanged', `库内仍「待验证」且 accepted_at 空（实得 ${rowAfter8.status}/${rowAfter8.accepted_at}）`);
        await page8.unroute(`**/api/sys-issues/${id8}/attachments`);
        const t8Errors = filterExpectedConsoleErrors(page8._consoleErrors);
        await shotOnFail(page8, t8Errors.length === 0, 't8-console-clean', `T8 全程无非预期 console error（实得 ${t8Errors.length} 个）${t8Errors.length ? '：' + JSON.stringify(t8Errors) : ''}`);
        await page8.close();

        // ═══════════════════════════════════════════════════════════════
        // T6：H1 修复钉子——accept 409 重试后 uploadedIds 累加，两次上传均关联，首张不重传
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T6：H1 修复钉子（uploadedIds 累加，非覆盖） ──');
        const id6 = await mkImprovementToVerify(adminTok, devTok, 'T6');
        createdIds.push(id6);
        const page6 = await loginPage(browser, adminTok);
        await page6.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6}`);
        await page6.waitForLoadState('networkidle');
        await page6.waitForTimeout(600);
        await page6.click('#siDActions button:has-text("验收通过")');
        await page6.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page6.waitForTimeout(200);

        const t6Note = 'Playwright T6 前端探针：验收通过（H1 重试累加）';
        await page6.fill('#f_note', t6Note);
        const pngPath6a = path.join(os.tmpdir(), `sys-accept-evi-t6a-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath6a, PNG_BYTES);
        tmpFiles.push(pngPath6a);
        await page6.setInputFiles('#siPickerInput_accept-evidence', pngPath6a);
        await page6.waitForTimeout(200);

        // accept 首次拦成 409（非附件相关错误码，验证"非 ACCEPT_ATTACHMENT_INVALID 的失败不清 uploadedIds"
        // 这条 H1 分支），第二次放行走真实后端。
        let acceptCallCount6 = 0;
        await page6.route(`**/api/sys-issues/${id6}/accept`, (route) => {
            acceptCallCount6++;
            if (acceptCallCount6 === 1) {
                route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟验收暂时失败（非附件相关）', code: 'SIMULATED_ACCEPT_TRANSIENT_FAIL' }) });
            } else {
                route.continue();
            }
        });

        await page6.click('#siMConfirm');
        await page6.waitForTimeout(800);
        const modalStillOpenT6 = await page6.locator('#siModalOverlay.open').count();
        await shotOnFail(page6, modalStillOpenT6 === 1, 't6-modal-stays-open-after-409', 'accept 首次 409 后弹窗仍打开（H1：非附件相关失败不清 uploadedIds）');
        const hintDisplayT6a = await page6.locator('#siAcceptUploadedHint').evaluate(el => getComputedStyle(el).display).catch(() => 'none');
        await shotOnFail(page6, hintDisplayT6a !== 'none', 't6-uploaded-hint-visible', `409 重试后 #siAcceptUploadedHint 应可见（实得 display=${hintDisplayT6a}）`);
        const hintTextT6a = await page6.locator('#siAcceptUploadedHint').textContent().catch(() => '');
        await shotOnFail(page6, /已上传 1 个附件/.test(hintTextT6a || ''), 't6-uploaded-hint-text-1', `hint 文案应含"已上传 1 个附件"（实得="${hintTextT6a}"）`);
        const attCountAfterFirst6 = await dbGet('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [id6]);
        await shotOnFail(page6, attCountAfterFirst6.c === 1, 't6-att-count-after-first', `首次上传后附件表恰 1 行（实得 ${attCountAfterFirst6.c}）`);

        // 再选第二张图（不同物理文件，首张 picker 已在上传成功后 reset）——H1 修复要求新写法在 uploadedIds
        // 已非空时仍能继续上传新文件（旧写法 `&&!uploadedIds` 会让本次选择被静默跳过）。
        const pngPath6b = path.join(os.tmpdir(), `sys-accept-evi-t6b-${RUN_TAG}.png`);
        fs.writeFileSync(pngPath6b, PNG_BYTES);
        tmpFiles.push(pngPath6b);
        await page6.setInputFiles('#siPickerInput_accept-evidence', pngPath6b);
        await page6.waitForTimeout(200);
        await shotOnFail(page6, (await siPreviewCount(page6, 'accept-evidence')) === 1, 't6-second-file-selected', '第二张 png 已选入（预览区 1 项，首张早已 reset）');

        await page6.click('#siMConfirm');
        await page6.waitForTimeout(800);
        await page6.unroute(`**/api/sys-issues/${id6}/accept`);
        const modalClosedT6 = await page6.locator('#siModalOverlay.open').count();
        await shotOnFail(page6, modalClosedT6 === 0, 't6-modal-closed-after-retry', '第二次点击（accept 放行）后弹窗关闭');
        const row6 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id6]);
        await shotOnFail(page6, row6.status === '待上线', 't6-status', `库内 status=待上线（实得=${row6.status}）`);
        const tl6 = await dbGet(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id6]);
        let payload6 = null;
        try { payload6 = tl6 && JSON.parse(tl6.payload_json); } catch (_) { payload6 = null; }
        await shotOnFail(page6, !!payload6 && Array.isArray(payload6.attachment_ids) && payload6.attachment_ids.length === 2, 't6-payload-att-len-2', `payload_json.attachment_ids 长度 2（两张均关联——H1 核心断言：concat 而非覆盖，实得=${JSON.stringify(payload6 && payload6.attachment_ids)}）`);
        const attCountFinal6 = await dbGet('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [id6]);
        await shotOnFail(page6, attCountFinal6.c === 2, 't6-att-count-final', `附件表恰 2 行（首张未重传，实得 ${attCountFinal6.c}）`);
        const t6Errors = filterExpectedConsoleErrors(page6._consoleErrors);
        await shotOnFail(page6, t6Errors.length === 0, 't6-console-clean', `T6 全程无非预期 console error（实得 ${t6Errors.length} 个）${t6Errors.length ? '：' + JSON.stringify(t6Errors) : ''}`);
        await page6.close();

        // ═══════════════════════════════════════════════════════════════
        // T7：M1 修复钉子——软约束状态随非空路径复位，绕行非空态一轮后清空须重新警示
        // ═══════════════════════════════════════════════════════════════
        // ⚠️ 3 击设计（非 spec 字面 2 击）：经实测验证，2 击版本（先填说明点确定→清空再点确定）对
        // "删掉 M1 复位"这条变异不具判别力——softConfirmed 初值本就是 false，第 1 击（非空）无论有无
        // 复位都不会去动它，第 2 击（清空）看到的仍是"从未被设过 true"的 false，两种实现在这个具体
        // 序列下表现一致。真正会被"删复位"破坏的是"先摸到过一次空态警示（softConfirmed 置 true）→
        // 绕道非空态提交一次→再清空回空态"这条路径——若中间的非空态没有把 softConfirmed 复位，第③次
        // 点击会拿着"过期"的 true 直接静默放行（不再警示、真的发出网络请求），这才是能被断言直接
        // 抓到的可观测差异。
        console.log('\n── T7：M1 修复钉子（softConfirmed 随非空路径复位） ──');
        const id7 = await mkImprovementToVerify(adminTok, devTok, 'T7');
        createdIds.push(id7);
        const page7 = await loginPage(browser, adminTok);
        await page7.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id7}`);
        await page7.waitForLoadState('networkidle');
        await page7.waitForTimeout(600);
        await page7.click('#siDActions button:has-text("验收通过")');
        await page7.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page7.waitForTimeout(200);

        await page7.route(`**/api/sys-issues/${id7}/accept`, (route) => {
            route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟验收暂时失败（非附件相关）', code: 'SIMULATED_ACCEPT_TRANSIENT_FAIL' }) });
        });
        const acceptReqs7 = [];
        const onAcceptReq7 = (req) => { if (req.method() === 'POST' && req.url().includes('/accept')) acceptReqs7.push(req.url()); };
        page7.on('request', onAcceptReq7);

        // 第①击：空态（无说明无附件）——命中软约束，警示 + 不发请求，softConfirmed 置位。
        await page7.click('#siMConfirm');
        await page7.waitForTimeout(400);
        await shotOnFail(page7, acceptReqs7.length === 0, 't7-click1-no-request', `①空态首击不应发 /accept 请求（实得 ${acceptReqs7.length} 次）`);
        const warnAfterClick1 = await page7.locator('#siAcceptSoftWarn').evaluate(el => getComputedStyle(el).display);
        await shotOnFail(page7, warnAfterClick1 !== 'none', 't7-click1-warn-shown', `①空态首击应出现软提示（实得 display=${warnAfterClick1}）`);

        // 第②击：绕行非空态（填了说明）——真实提交一次（撞 409），M1 修复要求这一步把 softConfirmed 复位。
        await page7.fill('#f_note', 'Playwright T7 前端探针：绕行非空态触发一次 409');
        await page7.click('#siMConfirm');
        await page7.waitForTimeout(500);
        await shotOnFail(page7, acceptReqs7.length === 1, 't7-click2-sent-request', `②非空态应真实发出 1 次 /accept 请求（实得累计 ${acceptReqs7.length} 次）`);
        const warnAfterClick2 = await page7.locator('#siAcceptSoftWarn').evaluate(el => getComputedStyle(el).display);
        await shotOnFail(page7, warnAfterClick2 === 'none', 't7-click2-warn-hidden', `②非空态提交时旧的空态警示不应残留可见（M1"回调开头先隐藏"，实得 display=${warnAfterClick2}）`);
        const modalOpenAfterClick2 = await page7.locator('#siModalOverlay.open').count();
        await shotOnFail(page7, modalOpenAfterClick2 === 1, 't7-click2-modal-open', '②非空态遇 409 后弹窗仍打开');

        // 第③击：清空说明重回空态——M1 要求 softConfirmed 已在②被复位为 false，本击应"重新"警示一次，
        //   而非误用①遗留的旧 softConfirmed=true 静默放行直接调用 accept（这正是 M1 要堵的状态残留）。
        await page7.fill('#f_note', '');
        await page7.click('#siMConfirm');
        await page7.waitForTimeout(500);
        page7.off('request', onAcceptReq7);
        await shotOnFail(page7, acceptReqs7.length === 1, 't7-click3-no-new-request', `③清空回到空态应被软约束重新拦下，不应新增 /accept 请求（实得累计 ${acceptReqs7.length} 次，应仍=1）`);
        const warnAfterClick3 = await page7.locator('#siAcceptSoftWarn').evaluate(el => getComputedStyle(el).display);
        await shotOnFail(page7, warnAfterClick3 !== 'none', 't7-click3-warn-reappears', `③清空回到空态应重新出现软提示（M1：softConfirmed 已在②被复位，实得 display=${warnAfterClick3}）`);
        const modalOpenAfterClick3 = await page7.locator('#siModalOverlay.open').count();
        await shotOnFail(page7, modalOpenAfterClick3 === 1, 't7-click3-modal-open', '③再次被软约束拦下后弹窗仍打开');

        await page7.unroute(`**/api/sys-issues/${id7}/accept`);
        const rowT7 = await dbGet('SELECT status FROM sys_issues WHERE id=?', [id7]);
        await shotOnFail(page7, rowT7.status === '待验证', 't7-status-unchanged', `全程库内状态未变，仍「待验证」（实得=${rowT7.status}）`);
        const t7Errors = filterExpectedConsoleErrors(page7._consoleErrors);
        await shotOnFail(page7, t7Errors.length === 0, 't7-console-clean', `T7 全程无非预期 console error（实得 ${t7Errors.length} 个）${t7Errors.length ? '：' + JSON.stringify(t7Errors) : ''}`);
        await page7.close();

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
    } finally {
        try { await browser.close(); } catch (e) { fail++; console.warn('浏览器关闭失败:', e && e.message || e); }
        for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) { /* best-effort */ } }

        // 夹具清理——五子表 + 主表逐条 DELETE（本项目 SQLite 未开 FK 级联，需显式清各表，同
        // test-sys-post-release-accept-fail-note-playwright.js 既有范式）。
        // [codex 500 M 采纳·2026-09-07] 物理上传文件一并清理：删附件行之前先按 file_name（相对 UPLOAD_DIR）
        //   unlink，防反复运行在 uploads/sys-iteration/<id>/ 下累积无元数据可追踪的文件；只删本次夹具
        //   issue 名下的行对应文件（精确清单，不扫目录）。
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_issue_attachments', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        let cleanupErrorCount = 0;
        let unlinkedFiles = 0;
        for (const id of createdIds) {
            try {
                const attRows = await dbAll('SELECT file_name FROM sys_issue_attachments WHERE issue_id=?', [id]);
                for (const a of attRows) {
                    if (!a || !a.file_name) continue;
                    const abs = path.resolve(UPLOAD_ROOT, a.file_name);
                    if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) continue;   // 越界不删
                    try { fs.unlinkSync(abs); unlinkedFiles++; } catch (_) { /* 已不存在或被占用：best-effort */ }
                }
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        const idList = createdIds.length ? createdIds : [-1];
        const placeholders = idList.map(() => '?').join(',');
        let totalResidual = 0;
        const residualDetail = {};
        for (const t of [...CHILD_TABLES, 'sys_issues']) {
            const col = t === 'sys_issues' ? 'id' : 'issue_id';
            const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
            const c = r ? r.c : 0;
            residualDetail[t] = c;
            totalResidual += c;
        }
        console.log(`  🧹 夹具清理完成（共创建 ${createdIds.length} 条，清理异常 ${cleanupErrorCount} 次，物理文件 unlink ${unlinkedFiles} 个，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            console.warn(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) process.exit(1);
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
