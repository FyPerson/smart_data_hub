/**
 * 系统迭代·验收通过 accept 说明+附件 / 验收打回 return 附件 前端 Playwright 冒烟
 * （2026-09-06 决策记录 D3/D4/J4-J13·S2b；2026-09-07 J13 修订：三写点统一凭证展示；
 *  2026-09-07 Opus 预筛回卷 1H/3M/5L：H1 uploadedIds 累加+总量闸+可见状态行+失效自愈、
 *  M1 软约束状态复位、M2/L1-L4 见下方 T6/T7 与各段详注）
 *
 * 用法：node scripts/test-sys-accept-evidence-playwright.js
 * 前置：[#106 S4d-4] 无服务前置——经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   依赖隔离实例（本检出本地库的快照）里存在固定用户 id 1（admin）/ 8（开发）/ 13（受理人）——首跑核对。
 *   验收凭证的物理上传文件在 <实例数据根>/uploads 下（env().dataDir，未知即抛），清理时按附件行精确 unlink（非 ENOENT 的失败计失败）；
 *   临时 png / exe 文件放 os.tmpdir() 下本脚本独有的 sys-accept-evi-* 子目录，收尾用 removeTreeChecked 删并确认（失败计失败）。
 *   失败截图写 os.tmpdir() 下的 sys-playwright-shots（仅断言失败时才创建，保留供查阅，不在收尾删除）。
 *
 * 骨架抄 test-sys-post-release-accept-fail-note-playwright.js（登录/夹具/直查库/console error 断言范式）。
 * 前端改动是静态文件即时生效（本文件只走真实 HTTP+DB，不 kill 任何进程；实例由 test-env 起停）。
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
 *       库内待上线 ∧ 该 accept 行 payload_json 恰只含 delivery_rev 且等于请求发出的 expected_delivery_rev（#216）∧ summary NULL
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
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

// [#106 S4d-4] BASE_URL / DB_PATH / SCREENSHOT_DIR / UPLOAD_ROOT / TMP_DIR / RUN_TAG / TITLE_PREFIX：入口 ready() 之后赋值（顶层只放纯声明，守卫 R5 / R6）；不再写死 localhost:3000 / 业务库 / .env / JWT_SECRET
let BASE_URL = null;
let DB_PATH = null;
let SCREENSHOT_DIR = null;
let UPLOAD_ROOT = null;   // [codex 500 M·磁盘清理] <实例数据根>/uploads（隔离实例的 UPLOAD_DIR 在数据根里）
let TMP_DIR = null;       // 本脚本独有的临时文件目录（os.tmpdir() 下 sys-accept-evi-*），收尾 removeTreeChecked
let RUN_TAG = null;
let TITLE_PREFIX = null;

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人
const DEV_ID = 8;        // 示例开发A（本地真实 active 非 viewer 账号，同既有多个 sys Playwright 脚本复用账号）

// [#106 S4d-4] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源，S4c 提交后可改用夹具导出
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(d)));
    });
}
// 每次调用开一次库；close 等回调落定，关库错误不丢（语句错误优先）
const dbGet = async (sql, params = []) => {
    const d = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { d.get(sql, params, (e, row) => { d.close((ce) => { const err = e || ce; err ? rej(err) : res(row); }); }); });
};
const dbRun = async (sql, params = []) => {
    const d = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { d.run(sql, params, function (e) { const ctx = { lastID: this && this.lastID, changes: this && this.changes }; d.close((ce) => { const err = e || ce; err ? rej(err) : res(ctx); }); }); });
};
const dbAll = async (sql, params = []) => {
    const d = await openInstanceDb(DB_PATH);
    return new Promise((res, rej) => { d.all(sql, params, (e, rows) => { d.close((ce) => { const err = e || ce; err ? rej(err) : res(rows); }); }); });
};

// [#106 S4d-4] 令牌由 test-env 用实例密钥签（读实例库 users 行，用户不存在即抛）
async function signAs(userId) {
    return testEnv.signToken(userId);
}

/** 删目录树：逐项 lstat，链接只删链接本身不进入，文件 unlink、目录递归后 rmdir（不用 fs.rmSync：Node v24 对含中文路径静默不删）；目录不存在视为已清；删后 lstat 确认，仍存在则抛错（调用方计失败）。写法同 verify-collab-multifile-datascope.js 的 removeTreeChecked */
function removeTreeChecked(dir) {
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) {
        try { fs.unlinkSync(dir); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir); else throw e; }
        return;
    }
    if (st.isDirectory()) {
        for (const name of fs.readdirSync(dir)) removeTreeChecked(path.join(dir, name));
        fs.rmdirSync(dir);
    } else {
        fs.unlinkSync(dir);
    }
    try { fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    throw new Error(`删除后仍存在：${dir}`);
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
let PNG_BYTES = null;   // 同 verify-sys-attachments.js 既有范式：内容不重要，只测扩展名/流程闸（Buffer.from(…) 调用不是纯声明，入口 ready() 之后赋值）

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
    // 读的是本检出的 public/Sys_Iteration.html（隔离实例由本检出的 server 起，静态页同源）
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
// [#106 S4d-4 修复批] 夹具单编号登记：建单（201）拿到 id 后立即登记，后续「受理 / 指派 / 估时 / 提交」任一步抛错时，收尾清理仍能清到这张单
//   （原来 id 只在 helper 全部成功返回后才由调用方 push，多步推进中途失败的单会漏清）。幂等（同 submit-withdraw 的 registerCreatedId 写法）
const createdIds = [];
function registerCreatedId(id) { if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id); }
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
    registerCreatedId(id);   // 建单即登记
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
    registerCreatedId(id);   // 建单即登记
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
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——ready() 之后被测实例应已在监听，请查隔离实例的启动日志`)); });
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
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    const dataDir = testEnv.env().dataDir;
    if (!dataDir) throw new Error('实例数据根（env().dataDir）未知：无法定位 uploads 目录——变量组形态下 TEST_DB_PATH 所在目录没有与 TEST_INSTANCE 匹配的 sdh-instance.json');
    UPLOAD_ROOT = path.join(dataDir, 'uploads');
    SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');
    RUN_TAG = Date.now();
    TITLE_PREFIX = `PW-验收凭证-${RUN_TAG}`;
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-accept-evi-'));
    // [codex 609 M-4] 改为可解码的真实 1×1 PNG：T4 时间线预览要断言图片真显示出来（原先只有 8 字节文件头，
    //   放大层空白也能通过）。其余各段只测扩展名 / 流程闸，内容合法与否不影响。
    PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');
    console.log('\n══════ 系统迭代·验收说明附件/打回附件 前端 Playwright 冒烟 ══════');

    console.log('\n── [静态-J13] 通用凭证渲染块不按 action_code 收窄 ──');
    staticCheckTimelineAttachmentBlockNotNarrowed();

    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);

    const tmpFiles = [];   // createdIds / registerCreatedId 在模块级（helper 建单后立即登记，见上）
    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：accept 弹层字段存在性 + 软提示初始隐藏
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T1：accept 弹层字段存在性 ──');
        const id1 = await mkImprovementToVerify(adminTok, devTok, 'T1');
        registerCreatedId(id1);   // 幂等（helper 内已登记）
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
        registerCreatedId(id2);
        const page2 = await loginPage(browser, adminTok);
        await page2.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id2}`);
        await page2.waitForLoadState('networkidle');
        await page2.waitForTimeout(600);
        await page2.click('#siDActions button:has-text("验收通过")');
        await page2.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page2.waitForTimeout(200);

        const acceptReqs = [];
        // [#216·2026-11-22] 同时记下请求体——前端随 /accept 带 expected_delivery_rev（版本锁，Sys_Iteration.html
        //   siModalAccept 内 body.expected_delivery_rev = myFlow.baselineRev），服务端据此打开 payload 并写 delivery_rev。
        const acceptBodies = [];
        const onAcceptReq = (req) => {
            if (req.method() === 'POST' && req.url().includes('/accept')) {
                acceptReqs.push(req.url());
                let b = null; try { b = req.postDataJSON(); } catch (_) { b = null; }
                acceptBodies.push(b);
            }
        };
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
        // [#216·2026-11-22] 原断言「payload_json 应 NULL」过时：验收版本锁（D11·B.5）起前端总带 expected_delivery_rev，
        //   服务端（routes/sys-iteration/index.js case 'accept'）对带锁请求打开 payload 并只追加 delivery_rev。
        //   「不填不传」在现行契约下的含义 = payload 恰只有 delivery_rev 一个键（无 note、无 attachment_ids），
        //   且值就是本次请求发出的 expected_delivery_rev（服务端不等会 409，200 时二者必须相同）。
        const sentRev2 = acceptBodies.length === 1 && acceptBodies[0] ? acceptBodies[0].expected_delivery_rev : undefined;
        await shotOnFail(page2, typeof sentRev2 === 'string' && /^e\d+-a\d+-n\d+$/.test(sentRev2), 't2-req-has-rev', `/accept 请求体应带合法 expected_delivery_rev（实得=${JSON.stringify(acceptBodies)}）`);
        let payload2 = null;
        try { payload2 = tl2 && tl2.payload_json != null ? JSON.parse(tl2.payload_json) : null; } catch (_) { payload2 = null; }
        const keys2 = payload2 && typeof payload2 === 'object' ? Object.keys(payload2).sort() : null;
        await shotOnFail(page2, !!keys2 && keys2.length === 1 && keys2[0] === 'delivery_rev', 't2-payload-only-rev', `最新 accept 行 payload_json 应恰只含 delivery_rev（不填说明、不传凭证；实得=${tl2 && tl2.payload_json}）`);
        await shotOnFail(page2, !!payload2 && payload2.delivery_rev === sentRev2, 't2-payload-rev-eq-sent', `payload_json.delivery_rev 应等于请求发出的 expected_delivery_rev（实得=${payload2 && payload2.delivery_rev}，发出=${sentRev2}）`);
        await shotOnFail(page2, !!tl2 && tl2.summary === null, 't2-summary-null', `最新 accept 行 summary 应 NULL（实得=${tl2 && tl2.summary}）`);
        const t2Errors = filterExpectedConsoleErrors(page2._consoleErrors);
        await shotOnFail(page2, t2Errors.length === 0, 't2-console-clean', `T2 全程无非预期 console error（实得 ${t2Errors.length} 个）${t2Errors.length ? '：' + JSON.stringify(t2Errors) : ''}`);
        await page2.close();

        // ═══════════════════════════════════════════════════════════════
        // T3：说明+附件真实链路
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T3：说明+附件真实链路 ──');
        const id3 = await mkImprovementToVerify(adminTok, devTok, 'T3');
        registerCreatedId(id3);
        const page3 = await loginPage(browser, adminTok);
        await page3.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id3}`);
        await page3.waitForLoadState('networkidle');
        await page3.waitForTimeout(600);
        await page3.click('#siDActions button:has-text("验收通过")');
        await page3.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page3.waitForTimeout(200);

        const t3Note = 'Playwright T3 前端探针：验收通过，功能符合预期';
        await page3.fill('#f_note', t3Note);
        const pngPath3 = path.join(TMP_DIR, `sys-accept-evi-t3-${RUN_TAG}.png`);
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
        registerCreatedId(id4);
        const page4 = await loginPage(browser, adminTok);
        await page4.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id4}`);
        await page4.waitForLoadState('networkidle');
        await page4.waitForTimeout(600);
        await page4.click('#siDActions button:has-text("验收打回")');
        await page4.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page4.waitForTimeout(200);

        const t4Reason = 'Playwright T4 前端探针：问题复现，请修复';
        await page4.fill('#f_reason', t4Reason);
        const pngPath4 = path.join(TMP_DIR, `sys-accept-evi-t4-${RUN_TAG}.png`);
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

        // [时间线图片预览·2026-11-21] T4 凭证是 png：点文件名弹放大层（img 取 blob 地址）且不触发下载；
        //   关掉放大层后点旁边的 ⬇ 仍走原下载，下载文件名为原始文件名。
        let t4Downloads = 0;
        const onT4Download = () => { t4Downloads++; };
        page4.on('download', onT4Download);
        // 页面侧记录：toast 文案、浏览器实际创建 / 撤销的对象地址、每次时间线预览调用结束（codex 609-R M2/L1：
        //   竞态与回收断言等「调用真正结束」与「真的撤销了」，不靠固定延时与数组长度）。内联 onclick 按全局名调用，包装生效。
        await page4.evaluate(() => {
            window.__t4Toasts = []; const ot = showToast; showToast = (m, ...rest) => { window.__t4Toasts.push(String(m)); return ot(m, ...rest); };
            window.__t4Created = []; const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { const u = oc(b); window.__t4Created.push(u); return u; };
            window.__t4Revoked = []; const orv = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = u => { window.__t4Revoked.push(String(u)); return orv(u); };
            window.__t4PreviewDone = 0; const op = siPreviewAttImage; siPreviewAttImage = async (...a) => { try { return await op(...a); } finally { window.__t4PreviewDone++; } };
        });
        const t4ImgLink = () => page4.locator('.si-timeline .si-tl-att a').first();
        const t4LbOpen = async () => (await page4.locator('#siImgLightbox.show').count()) > 0;
        const t4LbSrcNow = () => page4.locator('#siImgLightboxImg').getAttribute('src').catch(() => '');
        const t4DoneCount = () => page4.evaluate(() => window.__t4PreviewDone);
        const t4WaitDone = n => page4.waitForFunction(m => window.__t4PreviewDone >= m, n, { timeout: 8000 }).then(() => true).catch(() => false);
        const t4Bounded = (p, ms) => Promise.race([p.then(() => true), new Promise(r => setTimeout(() => r(false), ms))]);
        // 点一次时间线图片并等这次预览调用结束；返回调用是否结束、放大层是否打开、当前图片地址。
        const t4Preview = async () => { const n = await t4DoneCount(); await t4ImgLink().click(); const done = await t4WaitDone(n + 1); return { done, shown: await t4LbOpen(), src: await t4LbSrcNow() }; };
        // [codex 609-R2 L1] 等本次预览调用结束再判定（下载若被触发，也发生在调用内），不再固定等待。
        const t4N0 = await t4DoneCount();
        await t4ImgLink().click();
        const t4FirstCallDone = await t4WaitDone(t4N0 + 1);
        const t4LbShown = await t4LbOpen();
        const t4LbSrc = await t4LbSrcNow();
        const t4LbCap = await page4.locator('#siImgLightboxCaption').textContent().catch(() => '');
        const t4LbWidth = await page4.waitForFunction(() => { const i = document.getElementById('siImgLightboxImg'); return i && i.complete && i.naturalWidth; }, null, { timeout: 5000 }).then(h => h.jsonValue()).catch(() => 0);
        await shotOnFail(page4, t4FirstCallDone && t4LbShown, 't4-timeline-img-preview', `点时间线上的图片凭证应弹出放大层（调用结束=${t4FirstCallDone}，弹出=${t4LbShown}）`);
        await shotOnFail(page4, /^blob:/.test(t4LbSrc || ''), 't4-timeline-img-src', `放大层图片应为鉴权取回的 blob 地址（实得=${t4LbSrc}）`);
        await shotOnFail(page4, t4LbWidth > 0, 't4-timeline-img-decoded', `放大层图片应真正显示出来（naturalWidth>0，实得=${t4LbWidth}）`);
        await shotOnFail(page4, !!expectedFileName4 && t4LbCap === expectedFileName4, 't4-timeline-img-caption', `放大层标题=原始文件名（实得=${t4LbCap}）`);
        await shotOnFail(page4, t4Downloads === 0, 't4-timeline-img-no-download', `点图片预览不应触发下载（实得 ${t4Downloads} 次）`);
        page4.off('download', onT4Download);
        await page4.keyboard.press('Escape');
        await shotOnFail(page4, !(await t4LbOpen()), 't4-timeline-img-close', 'Esc 应关闭放大层');
        // [codex 609-R2 L2] 下载等待创建时即挂超时处理、按钮点击设上限：按钮点不了或点了没下载都按本条判红，不中断 T4。
        const t4DlEvent = page4.waitForEvent('download', { timeout: 5000 }).catch(() => null);
        const t4DlClicked = await page4.locator('.si-timeline .si-tl-att .si-tl-att-dl').first().click({ timeout: 5000 }).then(() => true).catch(() => false);
        const t4Dl = await t4DlEvent;
        await shotOnFail(page4, t4DlClicked && !!t4Dl && t4Dl.suggestedFilename() === expectedFileName4, 't4-timeline-img-download', `点 ⬇ 应下载原图且文件名为原始文件名（点击=${t4DlClicked}，实得=${t4Dl && t4Dl.suggestedFilename()}）`);

        // 各步若判红后放大层残留，会挡住下一步的点击（点击超时中断 T4）：每步开头先关掉，让各条独立判定。
        const t4ResetLb = async () => { if (await t4LbOpen()) await page4.evaluate(() => siCloseLightbox(null)); };
        const t4DlUrl = `${BASE_URL}/api/sys-issues/${id4}/attachments/${attId4}/download`;

        // [codex 609 L-1] 再预览一次：新地址替换旧地址，旧地址被浏览器实际撤销，且不再留在共享回收数组（只保留最近一次）。
        await t4ResetLb();
        const t4P2 = await t4Preview();
        const t4UrlState = await page4.evaluate(([a, b]) => ({ hasOld: siAttThumbUrls.includes(a), hasNew: siAttThumbUrls.includes(b), latest: siTlPreviewUrl === b, oldRevoked: window.__t4Revoked.includes(a) }), [t4LbSrc, t4P2.src]);
        await shotOnFail(page4, t4P2.done && t4P2.shown && /^blob:/.test(t4P2.src || '') && t4P2.src !== t4LbSrc && !t4UrlState.hasOld && t4UrlState.oldRevoked && t4UrlState.hasNew && t4UrlState.latest, 't4-timeline-img-reuse', `再次预览应只保留最近一次地址且旧地址已撤销（预览=${JSON.stringify(t4P2)}，状态=${JSON.stringify(t4UrlState)}，src1=${t4LbSrc}）`);
        await page4.keyboard.press('Escape');

        // 扣住下一次下载请求的拦截器：返回 { arrived, finished, release, hits }，其余请求放行。
        const t4HoldFirst = async () => {
            const h = { hits: 0 }; let reached, done;
            const gate = new Promise(r => { h.release = r; });
            h.arrived = new Promise(r => { reached = r; });
            h.finished = new Promise(r => { done = r; });
            await page4.route(t4DlUrl, async route => {
                if (h.hits++ === 0) { try { const resp = await route.fetch(); reached(); await gate; await route.fulfill({ response: resp }); } finally { done(); } }
                else await route.continue();
            });
            return h;
        };

        // [codex 609 M-2 / 609-R M2] 连点两次：第一次的响应被扣住，第二次先弹出；关掉后再放行第一次，
        //   等两次预览调用都结束，放大层不应重新弹出、也不应报错。所有等待都有上限，超时即判红。
        await t4ResetLb();
        {
            const h = await t4HoldFirst();
            try {
                const n0 = await t4DoneCount(), toasts0 = await page4.evaluate(() => window.__t4Toasts.length);
                await t4ImgLink().click();
                const arrived = await t4Bounded(h.arrived, 5000);
                await shotOnFail(page4, arrived, 't4-timeline-img-race-arrived', '第一次点击的请求应在 5 秒内到达拦截器');
                if (arrived) {
                    await t4ImgLink().click();
                    const secondDone = await t4WaitDone(n0 + 1);
                    const secondShown = await t4LbOpen();
                    await page4.keyboard.press('Escape');
                    h.release();
                    const firstFinished = await t4Bounded(h.finished, 8000);
                    const allDone = await t4WaitDone(n0 + 2);
                    const stale = await page4.evaluate(n => window.__t4Toasts.slice(n), toasts0);
                    await shotOnFail(page4, h.hits === 2 && secondDone && secondShown, 't4-timeline-img-race-second', `第二次点击应先弹出（请求 ${h.hits} 次，结束=${secondDone}，弹出=${secondShown}）`);
                    await shotOnFail(page4, firstFinished && allDone && !(await t4LbOpen()) && stale.length === 0, 't4-timeline-img-race-stale', `先点的晚到响应不应重新弹出或报错（放行完成=${firstFinished}，两次调用结束=${allDone}，放大层开=${await t4LbOpen()}，toast=${JSON.stringify(stale)}）`);
                }
            } finally { h.release(); await page4.unroute(t4DlUrl); }
        }

        // [codex 609-R2 M1] 连点两次、第二次保持打开时放行第一次：放大层仍是第二次的地址，第一次的地址被实际撤销，无新增提示。
        //   与上一条互补：上一条先关层再放行，关层本身就会作废第一次请求，看不出「新点击不递增序号」的回归。
        await t4ResetLb();
        {
            const h = await t4HoldFirst();
            try {
                const n0 = await t4DoneCount();
                const base = await page4.evaluate(() => ({ toasts: window.__t4Toasts.length, created: window.__t4Created.length }));
                await t4ImgLink().click();
                const arrived = await t4Bounded(h.arrived, 5000);
                await shotOnFail(page4, arrived, 't4-timeline-img-race-keep-arrived', '第一次点击的请求应在 5 秒内到达拦截器');
                if (arrived) {
                    await t4ImgLink().click();
                    const secondDone = await t4WaitDone(n0 + 1);
                    const shown2 = await t4LbOpen(), src2 = await t4LbSrcNow();
                    h.release();
                    const finished = await t4Bounded(h.finished, 8000);
                    const allDone = await t4WaitDone(n0 + 2);
                    const shownAfter = await t4LbOpen(), srcAfter = await t4LbSrcNow();
                    const st = await page4.evaluate(([b, s2]) => {
                        // 第一次的响应晚到时，实现可能在取 blob 前就因已失效退出（不建地址），也可能建了再当场撤销；
                        //   要守的性质是「除第二次的地址外，本次新建的地址都已撤销」，不规定第一次是否建过地址。
                        const mine = window.__t4Created.slice(b.created), others = mine.filter(u => u !== s2);
                        return { mine, hasSecond: mine.includes(s2), othersRevoked: others.every(u => window.__t4Revoked.includes(u)), toasts: window.__t4Toasts.slice(b.toasts) };
                    }, [base, src2]);
                    await shotOnFail(page4, secondDone && shown2 && /^blob:/.test(src2 || '') && finished && allDone && shownAfter && srcAfter === src2 && st.hasSecond && st.othersRevoked && st.toasts.length === 0,
                        't4-timeline-img-race-keep-second', `第二次保持打开时放行第一次，放大层应仍是第二次的地址、第一次地址已撤销、无新增提示（第二次结束=${secondDone}，弹出=${shown2}，放行完成=${finished}，两次结束=${allDone}，仍开=${shownAfter}，src2=${src2}，现 src=${srcAfter}，${JSON.stringify(st)}）`);
                }
            } finally { h.release(); await page4.unroute(t4DlUrl); }
        }

        // [codex 609-R M1] 时间线图片还在加载时，打开并关闭开发交付区的缩略图；放行后时间线预览不应再弹出、不应报错。
        await t4ResetLb();
        {
            const thumb = page4.locator('#siDBody img.si-att-thumb[src^="blob:"]').first();
            const thumbReady = await thumb.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);
            await shotOnFail(page4, thumbReady, 't4-timeline-img-thumb-ready', '开发交付区应有已加载的图片缩略图（本条用例的前置）');
            if (thumbReady) {
                const h = await t4HoldFirst();
                try {
                    const n0 = await t4DoneCount(), toasts0 = await page4.evaluate(() => window.__t4Toasts.length);
                    await t4ImgLink().click();
                    const arrived = await t4Bounded(h.arrived, 5000);
                    await thumb.click();
                    const thumbShown = await t4LbOpen();
                    await page4.keyboard.press('Escape');
                    const closed = !(await t4LbOpen());
                    h.release();
                    const finished = await t4Bounded(h.finished, 8000);
                    const done = await t4WaitDone(n0 + 1);
                    const stale = await page4.evaluate(n => window.__t4Toasts.slice(n), toasts0);
                    await shotOnFail(page4, arrived && thumbShown && closed && finished && done && !(await t4LbOpen()) && stale.length === 0, 't4-timeline-img-thumb-close-cancels', `关掉缩略图放大层后，先前点的时间线预览不应再弹出或报错（到达=${arrived}，缩略图弹出=${thumbShown}，已关=${closed}，放行完成=${finished}，调用结束=${done}，放大层开=${await t4LbOpen()}，toast=${JSON.stringify(stale)}）`);
                } finally { h.release(); await page4.unroute(t4DlUrl); }
            }
        }

        // [codex 609 M-4 / 609-R L1] 接口返回 200 但内容不是可显示的图片：不弹放大层，提示改用 ⬇（本次点击后新增的提示），
        //   本次创建的地址被浏览器实际撤销且不留在共享回收数组。
        await t4ResetLb();
        await page4.route(t4DlUrl, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('not really a png') }));
        try {
            const before = await page4.evaluate(() => ({ toasts: window.__t4Toasts.length, created: window.__t4Created.length }));
            const p = await t4Preview();
            const after = await page4.evaluate(b => {
                const mine = window.__t4Created.slice(b.created);
                return { toasts: window.__t4Toasts.slice(b.toasts), mine, revoked: mine.every(u => window.__t4Revoked.includes(u)), held: mine.some(u => siAttThumbUrls.includes(u)) };
            }, before);
            await shotOnFail(page4, p.done && !p.shown && after.toasts.some(t => t.includes('无法预览')), 't4-timeline-img-undecodable', `内容不是图片时应提示「无法预览」且不弹放大层（预览=${JSON.stringify(p)}，新增 toast=${JSON.stringify(after.toasts)}）`);
            await shotOnFail(page4, after.mine.length === 1 && after.revoked && !after.held, 't4-timeline-img-undecodable-revoke', `解码失败的地址应被实际撤销且不留在回收数组（${JSON.stringify(after)}）`);
        } finally { await page4.unroute(t4DlUrl); }

        // [时间线缩略图·2026-11-22] 时间线图片文件名前的小图：打开详情即显示；凭证（screenshot）同时出现在开发交付区与
        //   时间线打回行，每次渲染只取一次、两处共用一个地址；点小图弹放大层显示该地址且不下载；内容不是图片时换占位、文件名链接仍在。
        await t4ResetLb();
        {
            // [codex 610 建议] 按附件编号定位目标小图：开发交付区与时间线各自的目标占位分开取。
            const tlThumbSel = `.si-timeline .si-tl-att img.si-tl-thumb[data-att-id="${attId4}"]`;
            const dvThumbSel = `#siDBody img.si-att-thumb:not(.si-tl-thumb)[data-att-id="${attId4}"]`;
            const hits = []; const onReq = r => { if (r.url() === t4DlUrl) hits.push(r.method()); };
            page4.on('request', onReq);
            let st = { tl: [], dv: [] }, shown = false;
            try {
                await page4.evaluate(x => siOpenDrawer(x), id4);
                shown = await page4.waitForFunction(s => { const i = document.querySelector(s); return !!i && /^blob:/.test(i.getAttribute('src') || '') && i.complete && i.naturalWidth > 0; }, tlThumbSel, { timeout: 8000 }).then(() => true).catch(() => false);
                st = await page4.evaluate(([a, b]) => ({ tl: [...document.querySelectorAll(a)].map(i => i.getAttribute('src')), dv: [...document.querySelectorAll(b)].map(i => i.getAttribute('src')) }), [tlThumbSel, dvThumbSel]);
            } finally { page4.off('request', onReq); }
            await shotOnFail(page4, shown, 't4-tl-thumb-shown', `打开详情后时间线图片小图应显示出来（${JSON.stringify(st)}）`);
            await shotOnFail(page4, st.tl.length >= 1 && st.dv.length >= 1 && hits.length === 1 && [...st.tl, ...st.dv].every(s => s === st.tl[0]), 't4-tl-thumb-fetch-once', `同一凭证在开发交付区与时间线各一处，每次渲染只取一次、共用一个地址（请求=${JSON.stringify(hits)}，${JSON.stringify(st)}）`);
            const dlEvent = page4.waitForEvent('download', { timeout: 1500 }).catch(() => null);
            const clicked = await page4.locator(tlThumbSel).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
            const lbShown = await page4.locator('#siImgLightbox.show').waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
            const lbSrc = await t4LbSrcNow();
            const dl = await dlEvent;
            await shotOnFail(page4, clicked && lbShown && lbSrc === st.tl[0] && !dl, 't4-tl-thumb-click', `点时间线小图应弹放大层、显示小图地址且不下载（点击=${clicked}，弹出=${lbShown}，放大层=${lbSrc}，小图=${st.tl[0]}，下载=${!!dl}）`);
            await t4ResetLb();
            // [codex 610 M3] 先点文件名（预览请求被扣住），再点已加载的小图：放大层显示小图；放行文件名预览后仍是小图地址。
            const h = await t4HoldFirst();
            try {
                const n0 = await t4DoneCount();
                await t4ImgLink().click();
                const arrived = await t4Bounded(h.arrived, 5000);
                let d = { arrived };
                if (arrived) {
                    d.clicked = await page4.locator(tlThumbSel).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
                    d.thumbShown = await page4.locator('#siImgLightbox.show').waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
                    d.srcBefore = await t4LbSrcNow();
                    h.release();
                    d.finished = await t4Bounded(h.finished, 8000);
                    d.done = await t4WaitDone(n0 + 1);
                    d.open = await t4LbOpen();
                    d.srcAfter = await t4LbSrcNow();
                }
                await shotOnFail(page4, arrived && d.clicked && d.thumbShown && d.srcBefore === st.tl[0] && d.finished && d.done && d.open && d.srcAfter === st.tl[0],
                    't4-tl-thumb-click-wins', `先点文件名、后点小图：最后一次点击（小图）应保持显示（小图=${st.tl[0]}，${JSON.stringify(d)}）`);
            } finally { h.release(); await page4.unroute(t4DlUrl); }
            await t4ResetLb();
            // [codex 610-R M1] 小图还没加载完成（complete=false）时点击：不弹放大层、不递增预览序号（不作废在途的文件名预览）。
            //   做法：把已加载的目标小图改指向一个被扣住不回的地址，使其确定地处于「加载中」，再点击。
            const hangUrl = `${BASE_URL}/__t4_thumb_pending_${Date.now()}.png`;
            let hung = null, reached;
            const hangArrived = new Promise(r => { reached = r; });
            await page4.route(hangUrl, r => { hung = r; reached(); });
            try {
                // [codex 610-R2 L] 先确认被扣请求已到达拦截器，再采样 complete / 预览序号并点击。
                const swapped = await page4.evaluate(([s, u]) => { const i = document.querySelector(s); if (!i) return false; i.setAttribute('src', u); return true; }, [tlThumbSel, hangUrl]);
                const arrivedOk = swapped && await t4Bounded(hangArrived, 5000);
                const before = arrivedOk ? await page4.evaluate(s => { const i = document.querySelector(s); return { complete: i.complete, w: i.naturalWidth, seq: siTlPreviewSeq }; }, tlThumbSel) : null;
                const clicked = await page4.locator(tlThumbSel).first().click({ timeout: 5000 }).then(() => true).catch(() => false);
                const after = await page4.evaluate(() => ({ open: document.getElementById('siImgLightbox').classList.contains('show'), seq: siTlPreviewSeq }));
                // 注：换 src 后浏览器在新图到达前保留旧图尺寸（naturalWidth 仍为 1），「未就绪」以 complete=false 为准。
                await shotOnFail(page4, !!before && !before.complete && clicked && !after.open && after.seq === before.seq,
                    't4-tl-thumb-click-not-ready', `小图未加载完成时点击不应弹放大层、不应作废在途预览（点击前=${JSON.stringify(before)}，点击=${clicked}，点击后=${JSON.stringify(after)}）`);
            } finally {
                await t4ResetLb();
                if (hung) await hung.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }).catch(() => {});   // 用真图放行，不 abort（abort 会留 console 加载错误）
                await page4.unroute(hangUrl);
                await page4.evaluate(x => siOpenDrawer(x), id4);
                const restored = await page4.waitForFunction(s => { const i = document.querySelector(s); return !!i && i.complete && i.naturalWidth > 0; }, tlThumbSel, { timeout: 8000 }).then(() => true).catch(() => false);
                await shotOnFail(page4, restored, 't4-tl-thumb-click-not-ready-restore', '收尾重开详情后目标小图应重新加载完成（后续用例的前置）');
            }
        }
        await page4.route(t4DlUrl, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('not really a png') }));
        try {
            await page4.evaluate(x => siOpenDrawer(x), id4);
            // [codex 610-R L2] 按附件编号定位：目标文件名链接紧前一项应是失败占位，时间线里不再有该附件的小图，链接仍在。
            const linkSel = `.si-timeline .si-tl-att a[onclick="siPreviewAttImage(${id4},${attId4},'att')"]`;
            const ph = await page4.waitForFunction(([l, a]) => { const link = document.querySelector(l); const prev = link && link.previousElementSibling; return !!prev && prev.matches('span.si-pdf-icon') && !document.querySelector(`.si-timeline img.si-tl-thumb[data-att-id="${a}"]`); }, [linkSel, attId4], { timeout: 8000 }).then(() => true).catch(() => false);
            const links = await page4.locator(linkSel).count();
            await shotOnFail(page4, ph && links === 1, 't4-tl-thumb-undecodable', `内容不是图片时目标小图应换「预览加载失败」占位、文件名链接仍在（占位=${ph}，链接=${links}）`);
        } finally { await page4.unroute(t4DlUrl); await page4.evaluate(x => siOpenDrawer(x), id4); await page4.waitForFunction(() => !!document.querySelector('.si-timeline .si-tl-att')); }

        // [codex 609 M-1 / 609-R L1] 放大层开着时详情重渲 / 关抽屉：先确认放大层确实打开，之后放大层随地址回收一起关闭、
        //   滚动锁恢复，当次图片地址被浏览器实际撤销。
        await t4ResetLb();
        const t4Overflow0 = await page4.evaluate(() => document.body.style.overflow);
        {
            const p = await t4Preview();
            await shotOnFail(page4, p.done && p.shown && /^blob:/.test(p.src || ''), 't4-timeline-img-rerender-pre', `重渲前放大层应已打开（${JSON.stringify(p)}）`);
            await page4.evaluate(() => siRenderDrawer(siOpenId));
            const revoked = await page4.evaluate(u => window.__t4Revoked.includes(u), p.src);
            await shotOnFail(page4, !(await t4LbOpen()) && (await page4.evaluate(() => document.body.style.overflow)) === t4Overflow0 && revoked, 't4-timeline-img-rerender-close', `详情重渲时放大层应关闭、滚动锁恢复、当次地址已撤销（撤销=${revoked}）`);
        }
        await t4ResetLb();
        {
            const p = await t4Preview();
            await shotOnFail(page4, p.done && p.shown && /^blob:/.test(p.src || ''), 't4-timeline-img-drawer-pre', `关抽屉前放大层应已打开（${JSON.stringify(p)}）`);
            await page4.evaluate(() => siCloseDrawer());
            const st = await page4.evaluate(u => ({ revoked: window.__t4Revoked.includes(u), empty: siAttThumbUrls.length === 0, latestCleared: siTlPreviewUrl === null }), p.src);
            await shotOnFail(page4, !(await t4LbOpen()) && st.revoked && st.empty && st.latestCleared, 't4-timeline-img-drawer-close', `关抽屉时放大层应关闭、预览地址全部回收（${JSON.stringify(st)}）`);
        }

        const t4Errors = filterExpectedConsoleErrors(page4._consoleErrors);
        await shotOnFail(page4, t4Errors.length === 0, 't4-console-clean', `T4 全程无非预期 console error（实得 ${t4Errors.length} 个）${t4Errors.length ? '：' + JSON.stringify(t4Errors) : ''}`);
        await page4.close();

        // ═══════════════════════════════════════════════════════════════
        // T5：上传失败中止流转
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── T5：上传失败中止流转 ──');
        const id5 = await mkImprovementToVerify(adminTok, devTok, 'T5');
        registerCreatedId(id5);
        const page5 = await loginPage(browser, adminTok);
        await page5.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id5}`);
        await page5.waitForLoadState('networkidle');
        await page5.waitForTimeout(600);
        await page5.click('#siDActions button:has-text("验收通过")');
        await page5.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page5.waitForTimeout(200);

        // ── T5a：.exe 假文件 → picker collect 拒收（不进 files），视同无附件路径 ──
        const exePath = path.join(TMP_DIR, `sys-accept-evi-t5-${RUN_TAG}.exe`);
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
        const pngPath5 = path.join(TMP_DIR, `sys-accept-evi-t5-${RUN_TAG}.png`);
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
        registerCreatedId(id8);
        const page8 = await loginPage(browser, adminTok);
        await page8.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id8}`);
        await page8.waitForLoadState('networkidle');
        await page8.waitForTimeout(600);
        await page8.click('#siDActions button:has-text("验收通过")');
        await page8.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page8.waitForTimeout(200);
        const pngPath8 = path.join(TMP_DIR, `sys-accept-evi-t8-${RUN_TAG}.png`);
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
        registerCreatedId(id6);
        const page6 = await loginPage(browser, adminTok);
        await page6.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id6}`);
        await page6.waitForLoadState('networkidle');
        await page6.waitForTimeout(600);
        await page6.click('#siDActions button:has-text("验收通过")');
        await page6.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        await page6.waitForTimeout(200);

        const t6Note = 'Playwright T6 前端探针：验收通过（H1 重试累加）';
        await page6.fill('#f_note', t6Note);
        const pngPath6a = path.join(TMP_DIR, `sys-accept-evi-t6a-${RUN_TAG}.png`);
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
        const pngPath6b = path.join(TMP_DIR, `sys-accept-evi-t6b-${RUN_TAG}.png`);
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
        registerCreatedId(id7);
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
        // [#106 S4d-4] 临时 png / exe 文件在本脚本独有的 TMP_DIR 里：removeTreeChecked 删并确认，失败计失败（原来逐个 unlink 且吞错）
        try { removeTreeChecked(TMP_DIR); } catch (e) { fail++; console.warn(`临时目录清理失败 ${TMP_DIR}：${e && e.message}`); }

        // 夹具清理——五子表 + 主表逐条 DELETE（本项目 SQLite 未开 FK 级联，需显式清各表，同
        // test-sys-post-release-accept-fail-note-playwright.js 既有范式）。
        // [codex 500 M 采纳·2026-09-07] 物理上传文件一并清理：删附件行之前先按 file_name（相对 UPLOAD_DIR）
        //   unlink，防反复运行在 uploads/sys-iteration/<id>/ 下累积无元数据可追踪的文件；只删本次夹具
        //   issue 名下的行对应文件（精确清单，不扫目录）。
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_issue_attachments', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        let cleanupErrorCount = 0;
        let unlinkedFiles = 0;
        // [#106 S4d-4] 清理失败计失败：每个编号单独 try（先 unlink 该单名下附件物理文件、再按序删子表与主表），失败再试一轮（共 2 轮，间隔 200ms，
        //   删除与 unlink 幂等：ENOENT 视为已清）；两轮后仍失败的编号计清理异常；物理文件除 ENOENT 外的 unlink 失败同样计清理异常（原来吞掉）
        const pendingIds = createdIds.slice();
        const lastErr = new Map();
        for (let round = 0; round < 2 && pendingIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));
            for (const id of pendingIds.slice()) {
                try {
                    const attRows = await dbAll('SELECT file_name FROM sys_issue_attachments WHERE issue_id=?', [id]);
                    const outOfBounds = [];
                    for (const a of attRows) {
                        if (!a || !a.file_name) continue;
                        const abs = path.resolve(UPLOAD_ROOT, a.file_name);
                        if (!abs.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) { outOfBounds.push(`file_name="${a.file_name}" → ${abs}`); continue; }   // 越界不删文件
                        try { fs.unlinkSync(abs); unlinkedFiles++; } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
                    }
                    // [#106 S4d-4 修复批 L1] 越界路径计错误（原来 continue 静默跳过）：抛出使本编号的子表 / 主表行保留（下一轮、清理异常计数与残留回查都会看到），
                    //   其余合法路径已在上面照常 unlink
                    if (outOfBounds.length) throw new Error(`本轮夹具单附件路径越界（file_name 不在 uploads 内），疑似服务端落盘路径异常，越界文件未删: ${outOfBounds.join(' | ')}`);
                    for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                    await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
                    pendingIds.splice(pendingIds.indexOf(id), 1);
                    lastErr.delete(id);
                } catch (e) { lastErr.set(id, (e && e.message) || String(e)); }
            }
        }
        for (const id of pendingIds) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}（已重试 1 轮）: ${lastErr.get(id)}`); }
        const idList = createdIds.length ? createdIds : [-1];
        const placeholders = idList.map(() => '?').join(',');
        let totalResidual = 0;
        const residualDetail = {};
        // 回查本身失败也计失败（原来无 try：库不可读时会抛出并吞掉后面的汇总与退出码）
        try {
            for (const t of [...CHILD_TABLES, 'sys_issues']) {
                const col = t === 'sys_issues' ? 'id' : 'issue_id';
                const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
                const c = r ? r.c : 0;
                residualDetail[t] = c;
                totalResidual += c;
            }
        } catch (e) {
            cleanupErrorCount++;
            console.warn(`夹具清理回查失败: ${e && e.message}`);
        }
        console.log(`  🧹 夹具清理完成（共创建 ${createdIds.length} 条，清理异常 ${cleanupErrorCount} 次，物理文件 unlink ${unlinkedFiles} 个，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            console.warn(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——实例库已被本次测试运行污染，需人工核实`);
        }
    }
    try { await testEnv.teardown(); } catch (e) { fail++; console.warn('teardown（收掉自起实例）失败:', e && e.message || e); }
    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    testEnv.finish(fail > 0 ? 1 : 0);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}

main().catch(async (e) => {
    console.error('顶层异常:', e && e.stack || e);
    try { if (TMP_DIR) removeTreeChecked(TMP_DIR); } catch (_) { /* 已在报错路径，尽力清理 */ }
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
