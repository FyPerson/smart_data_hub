/**
 * test-sys-attachment-trace-playwright.js — 附件增删三码时间线渲染 C4 Playwright 三隔离+混合（#83 S3）
 * 方案：docs/local/附件压缩包/时间线附件留痕_方案_20260917_v1.3 §4 C4；C0 报告 v1.2 §4 反向清单
 * (c)(d)(e)(i)(k) + §5 写点表。
 * 后端正确性已由 scripts/verify-sys-attachment-trace.js 覆盖（in-process 内存库）；前端渲染静态不变量
 * （SI_TL_HIDABLE_CODES Map/siTlIsHidableScope 行为/label-coverage/summary-escape）已由
 * scripts/verify-sys-release-panel-static.js 等三个守卫覆盖（S2 段 228/18/39 全绿）。
 * 本文件只测必须靠真实浏览器 DOM 才能证明的行为——四页隔离夹具：
 *   ① 只有附件三码行（added/replaced/removed，含畸形 payload 回退 / null 文件名占位 / XSS 文件名转义）
 *   ② 只有改期行（release_add + release_date_change，批次编排 scope_change 类）
 *   ③ 只有逐人完成行（dev_submit_done/dev_no_code，si-tl-teal，天然不可隐藏）
 *   ④ 混合页（三类共存，隐藏开关只影响①②不影响③）
 * 每页验：勾选「隐藏批次编排与附件增删记录」前后 display、切换开关往返、展开区 <details> 存在且列全
 * 名单、original_name null 显「（无文件名）#id」、畸形 payload 回退 esc(summary) 不抛（console 零
 * error）、XSS 文件名被 esc（不出现真实 <img> 节点、不触发 dialog）。
 *
 * 骨架抄 test-sys-perdev-done-playwright.js（JWT 注入登录 + API 夹具直调 + registerCreatedId 精确清理）
 * 与 test-sys-release-panel-c2b2-playwright.js（dbRun 直写测试专属边界数据的既有先例）。
 *
 * [#106 S4b2] 运行面：不再自起 wrapper、不再复制真实库、不再写死端口 3107、不再读真实 .env。经 scripts/lib/test-env 的 ready() 拿到
 * 隔离实例（本检出库快照 + 隔离模式 server.js，uploads 在实例数据根里，teardown 时整目录删除）；token 用 testEnv.signToken 签；
 * 夹具建单逻辑与之前完全一致（用户 id=1 admin / id=8 开发取自快照）。原 doShutdown 里清理真实 ROOT/uploads/sys-iteration 的步骤
 * 与删临时库的步骤随之删除（实例数据根整体删除），HTTP 官方清理保留。
 * [LOW-6 既有纪律] 共享实例下夹具名一律带 RUN_TAG（唯一名字），清理只按本次登记的 id 清单。
 *
 * 用法：node scripts/test-sys-attachment-trace-playwright.js（自包含，不依赖任何已启动的外部服务）
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // ready() 之后赋值（testEnv.env().baseUrl）

const ADMIN_ID = 1;
const DEV_ID = 8; // 示例开发A——同既有套件既有夹具账号

let RUN_TAG = null;          // ready() 之后赋值
let RUN_TAG_MARKER = null;
const TITLE_PREFIX = '[pw-attach-trace]';

// 只读连接：收尾零残留核对与附件清单。写操作一律走 HTTP API，唯一例外是下面 dbRun（畸形/
// null/XSS 三个真实 API 无法自然产出的边界态行，精确写自己新建的 issue_id，见文件头注释）。均指向实例库。
let dbRO, dbRW, dbAll, dbRun;
async function initTempDbHandles(dbPath) {
    const open = (mode) => new Promise((resolve, reject) => { const d = new sqlite3.Database(dbPath, mode, (e) => (e ? reject(e) : resolve(d))); });
    dbRO = await open(sqlite3.OPEN_READONLY);
    dbRW = await open(sqlite3.OPEN_READWRITE);
    dbAll = (sql, params = []) => new Promise((res, rej) => dbRO.all(sql, params, (e, rows) => e ? rej(e) : res(rows || [])));
    dbRun = (sql, params = []) => new Promise((res, rej) => dbRW.run(sql, params, function (e) { e ? rej(e) : res(this); }));
}

// [#106 S4b2] 原 killChildTree / cleanupTempDbFiles（杀 wrapper 进程树、删临时库副本）随自起服务一并删除：实例由 test-env 起停，数据根整体删除。
// L6：等 sqlite 回调真的完成再返回（S4 迁移约定：close 必须等回调完成，共享实例下 teardown 立刻返回，紧接着 process.exit 不能撞上关库进行中）。
// M3（596CR3 处置）：db.close 回调若带 err 参数需真正拒绝——原版无条件 resolve，closeDb 失败会被
// 静默吞掉，doShutdown 里也就无法把它计入 fail / 独立记录（见下方 doShutdown ⑤ 的嵌套 try/finally）。
function closeDb(db) {
    return new Promise((resolve, reject) => { if (!db) return resolve(); db.close((err) => (err ? reject(err) : resolve())); });
}
// M4（596CR3 处置）：doShutdown 步骤②清理阶段当前在途 fetch 的 AbortController——正常 shutdown 已在
// 进行时若又收到一次中断信号，handleTermSignal 据此中止卡住的清理请求，而不是抢开第二套并发清理
// （shutdownPromise 单例已保证只有一个 doShutdown 在跑，这里只中止它内部当前这一步网络请求）。
let currentCleanupAbort = null;
async function withCleanupAbort(fn, timeoutMs = 8000) {
    const ac = new AbortController();
    currentCleanupAbort = ac;
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await fn(ac.signal);
    } finally {
        clearTimeout(t);
        if (currentCleanupAbort === ac) currentCleanupAbort = null;
    }
}
// [#106 S4b2] 原 killPort / snapshotRealDbToTemp / startWrapperServer 随自起服务删除：
//   - 「库快照可打开且含 sys_issues 表」的前置核对由 ready() 内的启动器（VACUUM INTO + 隔离化 + 模块就绪等待）承担；
//   - 「服务已就绪」的判定改为 main() 里一次真实请求的结果断言（未带 token 访问 /api/sys-issues/intake-liaisons 必须 401，证明服务在应答本脚本要测的路由族）。
async function signAs(userId) {
    return testEnv.signToken(userId);
}
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
// L2：端点子串 + 预期状态码组合匹配（不再单靠 URL 子串），避免同端点真出 500 时被一并吞掉——
// F3 用 dev 角色访问 intake-liaisons 命中的是良性 403，白名单只应覆盖那一种状态码。
const KNOWN_BENIGN_CONSOLE_ERRORS = [
    { urlSubstr: '/api/sys-issues/intake-liaisons', statusSubstr: '403' },
];
function unexpectedConsoleErrors(page) {
    return (page._consoleErrors || []).filter((m) => !KNOWN_BENIGN_CONSOLE_ERRORS.some((e) => m.includes(e.urlSubstr) && m.includes(e.statusSubstr)));
}
function futureEstStr(days) {
    const d = new Date(Date.now() + (days || 30) * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let pass = 0, fail = 0;
const failDetails = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failDetails.push(msg); }
    return cond;
}
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(os.tmpdir(), 'sys-playwright-shots', `attach-trace-fail-${name}.png`);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    let dialogTriggered = null;
    page.on('console', m => { if (m.type() === 'error') { const loc = (m.location && m.location()) || {}; consoleErrors.push(m.text() + (loc.url ? ` @ ${loc.url}` : '')); } });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    // XSS 文件名场景的最终判据之一：全程不应弹出任何浏览器原生 dialog（真实 <script>/onerror 执行才会
    // 触发；本文件三处 esc() 路径均应把它当纯文本渲染）——记录后立即 dismiss，不阻塞后续断言。
    page.on('dialog', d => { dialogTriggered = d.message(); d.dismiss().catch(() => {}); });
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    page._dialogTriggered = () => dialogTriggered;
    return page;
}
async function gotoIssue(page, issueId) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction((targetId) => typeof siDetail !== 'undefined' && siDetail && siDetail.issue && Number(siDetail.issue.id) === targetId, issueId, { timeout: 8000 });
}
const HIDE_LABEL_TEXT = '隐藏批次编排与附件增删记录';
// M4：不再用固定 300ms 硬睡赌"同步 DOM 写来得及"——等到出口层状态（sentinel 行的 visible/hidden），
// 一旦渲染改成异步（rAF/动画）也不会假红/假绿。sentinelLocator 传一个"本次操作确实会受影响"的
// 可隐藏行；expectedState 为 'hidden' 或 'visible'。
async function toggleHideCheckbox(page, sentinelLocator, expectedState) {
    await page.click(`label:has-text("${HIDE_LABEL_TEXT}") input[type="checkbox"]`);
    if (sentinelLocator && expectedState) {
        await sentinelLocator.waitFor({ state: expectedState, timeout: 5000 });
    }
}

// ── 官方 API 夹具 ──────────────────────────────────────────────────────
let seq = 0;
const createdIds = [];
const createdReleaseIds = [];
const uploadTouchedIssueIds = []; // 收尾用：本文件自建 issue 里真上传过物理文件的 issue_id（提到模块级，供 SIGINT 清理复用）
const releaseMembers = new Map();
function registerCreatedReleaseId(id) { if (Number.isInteger(id) && id > 0 && !createdReleaseIds.includes(id)) createdReleaseIds.push(id); }
function registerCreatedId(id) { if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id); }
async function apiCreate(adminTok, type, extra = {}) {
    seq++;
    const body = {
        intake_contract_version: 2, type,
        title: `${TITLE_PREFIX}-${type}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部',
        description: `Sys-Attachment-Trace S3-C4 Playwright 夹具 ${RUN_TAG_MARKER}`,
        intake_liaison_id: 13,
        ...extra,
    };
    const r = await fetch(`${BASE_URL}/api/sys-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (r.status !== 201 || !j || !(j.id > 0)) throw new Error(`[夹具建单] type=${type} 应 201，实得 ${r.status} ${JSON.stringify(j)}`);
    registerCreatedId(j.id);
    return j.id;
}
async function apiIntakeAccept(adminTok, id, extra = {}) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/intake-accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify(extra) });
    if (r.status !== 200) throw new Error(`[夹具 intake-accept] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSetOaNumber(adminTok, id, oa) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/set-oa-number`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ oa_number: String(oa) }) });
    if (r.status !== 200) throw new Error(`[夹具 set-oa-number] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiAssign(adminTok, id, userId) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/assign`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ assigned_to: userId }) });
    if (r.status !== 200) throw new Error(`[夹具 assign] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiEstimate(devTok, id, days) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/estimate`, { method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ dev_estimated_at: futureEstStr(30), estimated_effort_days: days || 1 }) });
    if (r.status !== 200) throw new Error(`[夹具 estimate] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
async function apiSubmitCommits(devTok, id, ref, extra = {}) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'commits', commits: [{ component: 'backend', commit_ref: ref }], self_tested: true, test_env_deployed: true, ...extra }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(`[夹具 submit-commits] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(j)}`);
    return j;
}
// multipart 上传——Node 24 原生 fetch/FormData/Blob，不必像 verify-sys-attachment-trace.js 那样手拼 boundary。
async function apiUpload(token, issueId, fields, fileName) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
    if (fileName) fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), fileName);
    const r = await fetch(`${BASE_URL}/api/sys-issues/${issueId}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
}
// M5（codex 596C）：同批多文件上传——原版所有夹具调用都只挂 1 个文件，展开区断言只查
// textContent/innerHTML，测不出"批量列表只渲染首项"这类回归。补一个真正的多文件同批请求。
async function apiUploadMulti(token, issueId, fields, fileNames) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
    for (const fn of fileNames) fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), fn);
    const r = await fetch(`${BASE_URL}/api/sys-issues/${issueId}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
}
async function apiDeleteAttachment(token, issueId, attId) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${issueId}/attachments/${attId}`, { method: 'DELETE', headers: jsonHeaders(token), body: JSON.stringify({}) });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
}
// M4：signal 参数可选——main() 主流程的正常清理调用不传（行为不变，signal=undefined 对 fetch 无影响），
// doShutdown 步骤②的清理阶段调用会传 withCleanupAbort 给的 ac.signal，让该请求可被中途中止。
async function apiDeleteIssue(adminTok, id, reason, signal) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}`, { method: 'DELETE', headers: jsonHeaders(adminTok), body: JSON.stringify({ reason: reason || 'Playwright 夹具清理：S3-C4 附件增删留痕测试遗留单，非真实业务数据' }), signal });
    if (r.status !== 200) throw new Error(`[清理] DELETE id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
}
// 边界态直写（见文件头注释）：畸形 payload / null 文件名 / XSS 文件名，三者真实 API 均无法自然产出。
async function dbInsertNoteRow(issueId, actionCode, summary, payloadObj) {
    await dbRun(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, payload_json, operator_id, operator_name)
         VALUES (?, 'note', ?, ?, ?, ?, ?)`,
        [issueId, summary, actionCode, JSON.stringify(payloadObj), ADMIN_ID, '管理员']
    );
}

// F1：附件三码隔离页——3 条真实 API 产出的 well-formed 行 + 3 条边界态直写行，全部 6 行同为
//   attachment_added/_replaced/_removed（note 型，均已登记进 SI_TL_HIDABLE_CODES）。
async function mkAttachOnlyIssue(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    // M2 修正：登记时点从"整个夹具函数跑完"提前到"刚拿到 id、还没上传"——否则中断刚好落在本函数内部
    // （已经真上传过物理文件，但函数尚未 return）时，SIGINT 处理器看到的 uploadTouchedIssueIds 仍是
    // 空的，uploads 目录清理会整段落空（活体验证 SIGINT 自触发复现过一次真实残留）。
    uploadTouchedIssueIds.push(id);
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260917910 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    // ① added（保留 active，不删）
    const up1 = await apiUpload(adminTok, id, { attachment_type: 'delivery' }, 'trace-a-added.png');
    if (up1.status !== 200) throw new Error(`[F1 夹具·added] 应 200，实得 ${up1.status} ${JSON.stringify(up1.body)}`);
    // ② replaced（先传旧 spec，再带 supersede_id 传新 spec）
    const up2 = await apiUpload(adminTok, id, { attachment_type: 'spec' }, 'trace-a-spec-old.pdf');
    if (up2.status !== 200) throw new Error(`[F1 夹具·spec-old] 应 200，实得 ${up2.status} ${JSON.stringify(up2.body)}`);
    const oldSpecId = up2.body.attachments[0].id;
    const up3 = await apiUpload(adminTok, id, { attachment_type: 'spec', supersede_id: String(oldSpecId) }, 'trace-a-spec-new.pdf');
    if (up3.status !== 200) throw new Error(`[F1 夹具·replaced] 应 200，实得 ${up3.status} ${JSON.stringify(up3.body)}`);
    // ③ removed（另传一份专用于删除，避免与①共用文件名导致断言互相干扰）
    const up4 = await apiUpload(adminTok, id, { attachment_type: 'delivery' }, 'trace-a-remove.png');
    if (up4.status !== 200) throw new Error(`[F1 夹具·remove-upload] 应 200，实得 ${up4.status} ${JSON.stringify(up4.body)}`);
    const removeAttId = up4.body.attachments[0].id;
    const del1 = await apiDeleteAttachment(adminTok, id, removeAttId);
    if (del1.status !== 200) throw new Error(`[F1 夹具·removed] 应 200，实得 ${del1.status} ${JSON.stringify(del1.body)}`);
    // ④ 畸形 payload（缺 attachments 键）→ 前端应静默回退 esc(summary)，不抛、不出展开区。
    await dbInsertNoteRow(id, 'attachment_replaced', 'trace-a-malformed 畸形替换行占位摘要（测试夹具）', {});
    // ⑤ null 文件名/上传人（attachment_removed 显式 null 合法，非缺键）→ 展开区应显「（无文件名）#999001」+「（未知上传人）」。
    await dbInsertNoteRow(id, 'attachment_removed', 'trace-a-nullname 删除附件 1 个：（无文件名）', {
        attachment: { id: 999001, attachment_type: 'spec', original_name: null, uploaded_by_name: null },
    });
    // ⑥ XSS 文件名（well-formed payload，内容含标签字符）→ esc() 后应只是纯文本，不应生成真实 <img> 节点。
    await dbInsertNoteRow(id, 'attachment_added', 'trace-a-xss 上传交付附件 1 个：<img src=x onerror=alert(1)>.png', {
        attachments: [{ id: 999002, attachment_type: 'delivery', original_name: '<img src=x onerror=alert(1)>.png' }],
        count: 1,
    });
    // ⑦（M5）同批 3 文件真实 API 上传——产出一条 attachment_added 行 count=3，供展开区"点击展开→
    // 逐项核对文件名/数量/类型词→再收起"断言，测出"批量列表只渲染首项"这类回归（原版所有夹具均只挂
    // 1 个文件，测不出这层）。
    const upBatch = await apiUploadMulti(adminTok, id, { attachment_type: 'delivery' }, [
        'trace-a-batch3-a.png', 'trace-a-batch3-b.png', 'trace-a-batch3-c.png',
    ]);
    if (upBatch.status !== 200) throw new Error(`[F1 夹具·batch3] 应 200，实得 ${upBatch.status} ${JSON.stringify(upBatch.body)}`);
    return id;
}
// F2：改期隔离页——直接把单钉在「待上线」（同 test-sys-release-panel-c2b2-playwright.js mkIssue 先例，
//   跳过整条 accept/开发链路，避免混入附件/逐人完成码）；建批次→加单（release_add）→改期（release_date_change）。
async function mkReleaseOnlyIssue(adminTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await dbRun(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [id]);
    const createR = await fetch(`${BASE_URL}/api/sys-releases`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ title: `${TITLE_PREFIX}-rel-${RUN_TAG}-${id}` }) });
    const createJ = await createR.json().catch(() => null);
    if (createR.status !== 201 || !createJ || !(createJ.id > 0)) throw new Error(`[F2 夹具·建批次] 应 201，实得 ${createR.status} ${JSON.stringify(createJ)}`);
    const relId = createJ.id;
    registerCreatedReleaseId(relId);
    const addR = await fetch(`${BASE_URL}/api/sys-releases/${relId}/add-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ issue_ids: [id] }) });
    const addJ = await addR.json().catch(() => null);
    if (addR.status !== 200) throw new Error(`[F2 夹具·加单] 应 200，实得 ${addR.status} ${JSON.stringify(addJ)}`);
    releaseMembers.set(relId, [...(releaseMembers.get(relId) || []), id]);
    const dateR = await fetch(`${BASE_URL}/api/sys-releases/${relId}/update-planned-date`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ planned_date: '2032-05-01' }) });
    const dateJ = await dateR.json().catch(() => null);
    if (dateR.status !== 200) throw new Error(`[F2 夹具·改期] 应 200，实得 ${dateR.status} ${JSON.stringify(dateJ)}`);
    return { issueId: id, releaseId: relId };
}
// F3：逐人完成隔离页——单人 improvement 全完成，产出恰 1 条 dev_submit_done/dev_no_code 行，不触碰
//   附件/批次编排（同 test-sys-perdev-done-playwright.js mkFixtureSingleDevVerify 同源）。
async function mkPerDevOnlyIssue(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260917920 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-attach-trace-perdev-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[F3 夹具] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F4：混合页——同一单同时具备三类行：单人完成（perdev）+ 一次附件上传（attachment_added）+ 排入批次并
//   改期（release_add/release_date_change）。
async function mkMixedIssue(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    uploadTouchedIssueIds.push(id); // 同 mkAttachOnlyIssue：登记提前到刚拿到 id，见上方注释
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260917930 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const up = await apiUpload(adminTok, id, { attachment_type: 'delivery' }, 'trace-mix-added.png');
    if (up.status !== 200) throw new Error(`[F4 夹具·attach] 应 200，实得 ${up.status} ${JSON.stringify(up.body)}`);
    const sub = await apiSubmitCommits(devTok, id, `pw-attach-trace-mix-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[F4 夹具] main_status 应为「待验证」，实得 ${sub.main_status}`);
    const accR = await fetch(`${BASE_URL}/api/sys-issues/${id}/accept`, { method: 'POST', headers: jsonHeaders(adminTok), body: '{}' });
    if (accR.status !== 200) throw new Error(`[F4 夹具·accept] 应 200，实得 ${accR.status} ${JSON.stringify(await accR.json().catch(() => null))}`);
    const createR = await fetch(`${BASE_URL}/api/sys-releases`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ title: `${TITLE_PREFIX}-rel-mix-${RUN_TAG}-${id}` }) });
    const createJ = await createR.json().catch(() => null);
    if (createR.status !== 201 || !createJ || !(createJ.id > 0)) throw new Error(`[F4 夹具·建批次] 应 201，实得 ${createR.status} ${JSON.stringify(createJ)}`);
    const relId = createJ.id;
    registerCreatedReleaseId(relId);
    const addR = await fetch(`${BASE_URL}/api/sys-releases/${relId}/add-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ issue_ids: [id] }) });
    if (addR.status !== 200) throw new Error(`[F4 夹具·加单] 应 200，实得 ${addR.status} ${JSON.stringify(await addR.json().catch(() => null))}`);
    releaseMembers.set(relId, [...(releaseMembers.get(relId) || []), id]);
    const dateR = await fetch(`${BASE_URL}/api/sys-releases/${relId}/update-planned-date`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ planned_date: '2032-05-02' }) });
    if (dateR.status !== 200) throw new Error(`[F4 夹具·改期] 应 200，实得 ${dateR.status} ${JSON.stringify(await dateR.json().catch(() => null))}`);
    return { issueId: id, releaseId: relId };
}

let adminTok, devTok;
let browser = null;
let cancelRequested = false;
// M2（596CR1 二次处置）：main() 当前阶段最外层的 Promise——shutdown() 收尾时据此有界等待在途操作
// 落地，而不是无条件抢先关资源；每个 F 阶段的 IIFE 结束后（无论成败）都会把它复位回 null。
let currentInFlight = null;
function checkCancelled(stageName) {
    if (cancelRequested) {
        console.log(`  ⏭️ [取消] 已收到中断信号，跳过阶段 ${stageName}`);
        return true;
    }
    return false;
}
// [#106 S4b2] 原 killChildTreeAndWait（按 PID 树杀自起的 wrapper 进程并等其退出）删除：服务由 test-env 起停，收尾走 testEnv.teardown()。
// M2（596CR1 二次处置）：signal 处理器与 main() 的 finally 不再各自并发跑一套清理（原版竞态：main()
// 自己的 finally 会抢先 closeDb/查询，把信号路径的清理挤成"该删的没删掉"，H1 的精确清单兜底也可能因
// db 连接被并发关闭而查空）——两者现在都只调用同一个幂等 shutdown(reason)，靠一个 Promise 单例保证
// 全局只真正执行一次；后到的调用者拿到同一个 Promise（只有第一次调用的 reason 生效，谁先到谁定调）。
let shutdownPromise = null;
// M3：抽成共享函数——doShutdown 正常收尾的步骤⑨与下面 shutdown() 的兜底 catch 现在打印同一份汇总
// （原版兜底 catch 直接 process.exit，pass/fail 汇总从未被打印，问题被静默吞掉）。
function printSummary(reason) {
    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败（reason=${reason}） ===`);
    if (fail > 0) { console.log('失败项：'); failDetails.forEach((m) => console.log('  - ' + m)); }
}
function shutdown(reason) {
    if (!shutdownPromise) {
        shutdownPromise = doShutdown(reason).catch((e) => {
            console.error('[attach-trace-pw] shutdown 内部异常（不应发生，兜底退出前仍打印同一份汇总）：', e);
            fail++; failDetails.push(`shutdown 内部异常：${e.message}`);
            printSummary(reason);
            // M4：退出码统一按 cancelRequested 决定（而非入参 reason）——正常收尾途中若又收到一次
            // 信号，cancelRequested 会被 handleTermSignal 置真，此处与步骤⑩保持同一判据。
            process.exit(cancelRequested ? 130 : 1);
        });
    }
    return shutdownPromise;
}
// shutdown 唯一实现，固定顺序（596CR3 M2/M3/M4 处置后）：
//   ①有界等在途操作 ③a 官方清理前先存本次附件清单（保存清单，M2） ②（仅 reason==='normal'）官方 HTTP
//   端点清理（release 移单/删单/删批次，走 safeDeleteFileSync 清掉物理文件；每个清理请求带 8s 可取消
//   期限，M4） ③b 停止写入后再读一次并与保存清单取并集（M2：官方删除会把行级联清空，若只在此刻才读
//   一次会拿到空清单，误把"物理删除失败的残留"漏判） ④关浏览器（有界 3s） ⑤关本进程所有 db 句柄
//   （独立错误记录，M3） ⑥[S4b2] await testEnv.teardown()（收实例；原「杀 wrapper 进程树 / 清真实 uploads / 删临时库」三步随自起服务删除，
//   附件物理文件在实例数据根里，teardown 整体删除，所以附件清单（uploadsManifest）改为只用来核对「官方 API 清理后清单内文件是否还在」；
//   teardown 之前另核每个自建 issue 的 uploads/sys-iteration/<id>/ 目录存在且为空，并且拿不到实例数据根时计失败）
//   ⑨输出最终汇总（抽成 printSummary，与 shutdown() 兜底 catch 共用）⑩ process.exit（退出码统一按 cancelRequested 决定，M4：正常收尾
//   途中又收到一次信号也能拿到 130，不再只看入参 reason）。
async function doShutdown(reason) {
    console.log(`\n[attach-trace-pw] shutdown 开始（reason=${reason}）`);

    // ①等待在途操作有界结束（正常收尾时 currentInFlight 早已在各阶段自己的 finally 里清空，此处天然
    // 空转；signal 路径下，服务此刻仍活着，给它 3s 把当前这一步 fetch/page 操作跑完，避免半途斩断。）
    if (currentInFlight) {
        await Promise.race([
            currentInFlight.catch(() => { /* 在途操作自身的错误已在各自 try/catch 里处理，这里只管等它落地 */ }),
            new Promise((r) => setTimeout(r, 3000)),
        ]);
    }

    // ③a/③b（M2）：从临时库读本次夹具附件清单，合并进同一个 Map（并集，不覆盖）。第一次在官方清理
    // 之前调用（这时行还在，是"保存清单"）；第二次在官方清理之后调用（"停止写入后再读一次"——normal
    // 路径下这些行多数已被②的级联删除清空，返回集合与第一次几乎相同，并集不改变内容；signal 路径②被
    // 跳过，两次读到的本就是同一批仍存在的行，并集同样等价）。单个 issue 查询失败只计 fail，不放弃
    // 其它 issue，也不覆盖该 issue 已存的旧清单。
    const uploadsManifest = new Map();
    async function collectManifest() {
        for (const iid of uploadTouchedIssueIds) {
            try {
                const rows = dbAll ? await dbAll(`SELECT file_name FROM sys_issue_attachments WHERE issue_id=?`, [iid]) : [];
                const names = rows.map((r) => r.file_name).filter(Boolean);
                const existing = uploadsManifest.get(iid) || [];
                uploadsManifest.set(iid, [...new Set([...existing, ...names])]);
            } catch (e) {
                console.log(`  ⚠️ 读取 issue=${iid} 附件清单失败（best-effort，不阻断收尾）：${e.message}`);
                fail++; failDetails.push(`读取 issue=${iid} 附件清单失败：${e.message}`);
            }
        }
    }
    await collectManifest(); // 保存清单——必须在官方删除级联清空 sys_issue_attachments 行之前

    // ②（仅正常收尾）官方 HTTP 端点清理：release 移单 → DELETE 单（级联删附件/时间线，含直写的三条
    // 边界态行）→ DELETE 空批次。M3：每步独立 try/catch，任一失败只计 fail，不截断后续步骤。
    // M4：三类请求均经 withCleanupAbort 包一层 8s 可取消期限；若清理进行中又收到一次中断信号，
    // handleTermSignal 会 abort 当前这一个 currentCleanupAbort，不等它自然超时。
    if (reason === 'normal') {
        for (const relId of createdReleaseIds) {
            const members = releaseMembers.get(relId) || [];
            if (!members.length) continue;
            try {
                const r = await withCleanupAbort((signal) => fetch(`${BASE_URL}/api/sys-releases/${relId}/remove-issues`, { method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ issue_ids: members }), signal }));
                if (r.status !== 200) {
                    const j = await r.json().catch(() => null);
                    console.error(`清理 release=${relId} 移单非 200：${r.status} ${JSON.stringify(j)}`);
                    fail++; failDetails.push(`清理 release=${relId} 移单失败：${r.status} ${JSON.stringify(j)}`);
                }
            } catch (e) { console.error(`清理 release=${relId} 移单失败：${e.message}`); fail++; failDetails.push(`清理 release=${relId} 移单异常：${e.message}`); }
        }
        for (const id of createdIds) {
            try { await withCleanupAbort((signal) => apiDeleteIssue(adminTok, id, undefined, signal)); }
            catch (e) { console.error(`清理 issue=${id} 失败：${e.message}`); fail++; failDetails.push(`清理 issue=${id} 失败：${e.message}`); }
        }
        for (const relId of createdReleaseIds) {
            try {
                const r = await withCleanupAbort((signal) => fetch(`${BASE_URL}/api/sys-releases/${relId}`, { method: 'DELETE', headers: jsonHeaders(adminTok), body: JSON.stringify({ reason: 'Playwright 夹具清理' }), signal }));
                if (r.status !== 200) { console.error(`清理 release=${relId} 删除非 200：${r.status} ${JSON.stringify(await r.json().catch(() => null))}`); fail++; failDetails.push(`清理 release=${relId} 删除失败：${r.status}`); }
            } catch (e) { console.error(`清理 release=${relId} 删除失败：${e.message}`); fail++; failDetails.push(`清理 release=${relId} 删除异常：${e.message}`); }
        }
        // M3：残留行核对——两次 dbAll 各自 try/catch，任一失败计 fail 不截断（原版任一抛错会跳过后面
        // 关库/杀服务/删临时库，顶层直接退出）。
        let leftIssues = [], leftRels = [];
        try {
            leftIssues = (createdIds.length && dbRO) ? await dbAll(`SELECT id FROM sys_issues WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds) : [];
        } catch (e) { console.error(`残留核对（issues）失败：${e.message}`); fail++; failDetails.push(`残留核对（issues）失败：${e.message}`); }
        try {
            leftRels = (createdReleaseIds.length && dbRO) ? await dbAll(`SELECT id FROM sys_releases WHERE id IN (${createdReleaseIds.map(() => '?').join(',')})`, createdReleaseIds) : [];
        } catch (e) { console.error(`残留核对（releases）失败：${e.message}`); fail++; failDetails.push(`残留核对（releases）失败：${e.message}`); }
        if (leftIssues.length || leftRels.length) { console.error(`清理残留：issues=${JSON.stringify(leftIssues)} releases=${JSON.stringify(leftRels)}`); fail++; failDetails.push(`清理残留：issues=${JSON.stringify(leftIssues)} releases=${JSON.stringify(leftRels)}`); }
        else console.log(`清理完成：issues=${createdIds.length} releases=${createdReleaseIds.length} 零残留`);
    }
    await collectManifest(); // 停止写入后再读一次，与保存清单取并集（M2）

    // ④关闭浏览器（有界 3s）——与 main() 并发的 page 操作若还占着同一 CDP 连接，超时也不阻塞后续退出。
    if (browser) {
        try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]); }
        catch (e) { console.error(`browser.close() 失败（不阻断后续清理）：${e.message}`); }
    }

    // ⑤-⑥（M3）：嵌套 try/finally——closeDb 拒绝只记独立错误，保证后续的附件核对与 teardown 仍被尝试。
    try {
        // ⑤关闭本进程所有 db 句柄并 await 回调，各自独立 try/catch（L6：等回调真完成才进入下一步；S4 迁移约定：close 等回调完成再 teardown / exit）。
        try { await closeDb(dbRO); } catch (e) { console.error(`closeDb(dbRO) 失败：${e.message}`); fail++; failDetails.push(`closeDb(dbRO) 失败：${e.message}`); }
        try { await closeDb(dbRW); } catch (e) { console.error(`closeDb(dbRW) 失败：${e.message}`); fail++; failDetails.push(`closeDb(dbRW) 失败：${e.message}`); }
    } finally {
        // [S4b2] 原步骤⑦（清理真实 ROOT/uploads/sys-iteration）改为只读核对：官方 API 清理（reason==='normal'）之后，清单内的附件物理文件
        // 在实例数据根的 uploads 下必须都已不存在（safeDeleteFileSync 失败的残留在这里判红）。不再 unlink / rmdir——实例目录由 teardown 整体删除。
        // 数据根拿不到（变量组形态下清单对不上）→ 计失败：这项核对是原「清单内残留」断言的替代，不能静默跳过（codex 18 H1）。
        try {
            if (reason === 'normal') {
                const dataDir = testEnv.env().dataDir;
                if (!dataDir) {
                    console.log('  ⚠️ [收尾] 实例数据根未知（变量组形态下 sdh-instance.json 对不上），附件物理文件残留无法核对');
                    fail++; failDetails.push('实例数据根未知，附件物理文件残留无法核对');
                } else {
                    const uploadsRoot = path.join(dataDir, 'uploads');
                    for (const iid of uploadTouchedIssueIds) {
                        const dirResolved = path.resolve(uploadsRoot, 'sys-iteration', String(iid));
                        let manifestResidual = 0;
                        for (const relName of (uploadsManifest.get(iid) || [])) {
                            const abs = path.resolve(uploadsRoot, relName);
                            const withinDir = abs === dirResolved || abs.startsWith(dirResolved + path.sep);
                            if (!withinDir) {
                                console.log(`  ⚠️ [收尾] 清单项越界（不在 uploads/sys-iteration/${iid}/ 内），跳过核对：${relName}`);
                                fail++; failDetails.push(`清单项越界未核对：${relName}`);
                                continue;
                            }
                            if (fs.existsSync(abs)) manifestResidual++;
                        }
                        if (manifestResidual > 0) {
                            console.log(`  ⚠️ uploads/sys-iteration/${iid} 官方清理后清单内仍有 ${manifestResidual} 个文件存在`);
                            fail++; failDetails.push(`uploads/sys-iteration/${iid} 官方清理后清单内文件残留 ${manifestResidual} 个`);
                        }
                        // 实例 uploads 只属于本实例，目录按本脚本自建的 issue_id 命名；服务端只 unlink 附件文件、从不删 sys-iteration/<id>/ 目录。
                        //   所以官方清理后目录必须**存在且为空**：「存在」是路径正确的正向锚（脚本算出的目录 = 服务端实际写入的目录，否则上面的清单核对与这里都会空转）；
                        //   「为空」在清单为空（元数据丢失 / file_name 为空）时仍然成立，堵住「清单空跑」（codex 18-R M1、预筛 L1）。迁移前共用真实 uploads 树，做不到这一条。
                        //   同一个残留文件会同时计入上面的「清单内残留」和这里的「目录非空」，失败数偏大，不影响判红。
                        if (!fs.existsSync(dirResolved)) {
                            console.log(`  ⚠️ uploads/sys-iteration/${iid} 目录不存在（脚本算出的路径与服务端写入目录不一致？）`);
                            fail++; failDetails.push(`uploads/sys-iteration/${iid} 目录不存在，无法确认附件残留核对的路径`);
                        } else {
                            let leftover = null;
                            try { leftover = fs.readdirSync(dirResolved); } catch (e) {
                                console.log(`  ⚠️ uploads/sys-iteration/${iid} 目录 readdir 失败：${e.message}`);
                                fail++; failDetails.push(`uploads/sys-iteration/${iid} 目录 readdir 失败：${e.message}`);
                            }
                            if (leftover && leftover.length > 0) {
                                console.log(`  ⚠️ uploads/sys-iteration/${iid} 官方清理后目录内仍有 ${leftover.length} 项：${JSON.stringify(leftover)}`);
                                fail++; failDetails.push(`uploads/sys-iteration/${iid} 官方清理后目录非空 ${leftover.length} 项`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`  ⚠️ 附件物理文件残留核对异常：${e.message}`);
            fail++; failDetails.push(`附件物理文件残留核对异常：${e.message}`);
        }
        // ⑥收实例：teardown 失败只记 fail，不阻断汇总与退出。
        try { await testEnv.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); fail++; failDetails.push(`teardown 失败：${e.message}`); }
    }

    // ⑨输出最终汇总（抽成 printSummary，与 shutdown() 兜底 catch 共用同一份，M3）。
    printSummary(reason);
    // 退出（finish / process.exit）之前再确认一次 teardown 已完成（幂等；上面 ⑥ 已调用过，这里让「收尾 → 退出」在本函数内显式成对；finish 也要求 teardown 已落定）。
    try { await testEnv.teardown(); } catch (_) { /* 已在 ⑥ 记过 fail */ }

    // ⑩ 退出：退出码统一按 cancelRequested 决定（M4）——不再只看入参 reason，正常收尾途中
    // 若又收到一次信号，cancelRequested 会被置真，这里同样返回 130（process.exit(130)）；否则 finish(0 / 1)。
    // [#106 S4b2a] 信号路径（cancelRequested）保持 process.exit(130)：此时 main() 可能还卡在某个 await 上，必须立刻终止进程，不能让它在实例拆掉之后继续往下跑。
    //   正常路径改 finish（teardown 已在上面 await 落定）：只设退出码，不终止执行；doShutdown 靠 shutdownPromise 单例保证只执行一次，finish 是本函数的最后一条语句，调用方 main() 的 finally 之后没有语句。
    if (cancelRequested) process.exit(130);
    testEnv.finish(fail > 0 ? 1 : 0);
}
function handleTermSignal(sig) {
    return () => {
        cancelRequested = true;
        console.log(`\n[attach-trace-pw] 收到 ${sig}，执行清理后退出`);
        // M4：shutdown 已在进行（第二次信号，或某次信号落在正常收尾途中）——不再重新触发一套并发
        // 清理，只中止当前清理阶段卡住的网络请求，让在跑的 doShutdown 继续往后走完剩余资源释放步骤；
        // 最终退出码已改由 cancelRequested 决定（见 doShutdown ⑩ 与 shutdown() 兜底 catch）。
        if (shutdownPromise) {
            if (currentCleanupAbort) { try { currentCleanupAbort.abort(); } catch (_) { /* ignore */ } }
            return;
        }
        shutdown('signal');
    };
}
async function main() {
    // [#106 S4b2] ready() 是入口函数里第一条有副作用的语句：拿到隔离实例（本检出库快照 + 隔离模式 server.js）；失败 → 入口 .catch 非零退出。
    //   之后的一切（信号处理器、RUN_TAG、开库、签 token、起浏览器）都在 ready 之后。
    await testEnv.ready();
    BASE_URL = testEnv.env().baseUrl;
    RUN_TAG = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    RUN_TAG_MARKER = `RT-ATTTR-${RUN_TAG}`;
    // 信号处理器放在 ready 之后（test-env 自己的 SIGINT / SIGTERM 清理监听器同样此时才装）；本文件的处理器走 shutdown → doShutdown（含 teardown）。
    process.on('SIGINT', handleTermSignal('SIGINT'));
    process.on('SIGTERM', handleTermSignal('SIGTERM'));
    // M1：启动序列（开库/签发 token/起浏览器）整段挪进 try——任一步失败都要走同一份 finally 清理。
    try {
        await initTempDbHandles(testEnv.env().dbPath);
        // 「服务就绪」的判定：原来靠日志里的 "Task Pool Server running"；改为一次真实请求——未带 token 访问本脚本要测的路由必须 401。
        const probe = await fetch(`${BASE_URL}/api/sys-issues/intake-liaisons`);
        if (probe.status !== 401) throw new Error(`[就绪核对] 未带 token 访问 /api/sys-issues/intake-liaisons 应 401，实得 ${probe.status}（服务没有在应答本脚本要测的路由）`);
        adminTok = await signAs(ADMIN_ID);
        devTok = await signAs(DEV_ID);
        browser = await chromium.launch();
        console.log('=== #83 系统迭代·附件增删留痕 S3-C4：前端 Playwright 三隔离+混合 ===');

        // ══════════════════════════════════════════════════════════════════
        // [F1] 只有附件三码行
        // ══════════════════════════════════════════════════════════════════
        if (!checkCancelled('F1')) {
            // M2（596CR1 二次处置）：整段阶段体包成一个 IIFE 赋给模块级 currentInFlight，shutdown() 收尾
            // 时据此有界等待——不改动阶段体内部任何逻辑，只加一层壳。
            currentInFlight = (async () => {
            const id = await mkAttachOnlyIssue(adminTok, devTok); // uploadTouchedIssueIds 登记已提前到函数内部（见该函数注释）
            const page = await loginPage(browser, adminTok);
            await gotoIssue(page, id);

            const addedRow = page.locator('.si-tl-item:has-text("trace-a-added")');
            const replacedRow = page.locator('.si-tl-item:has-text("trace-a-spec-new")');
            // [自查修正×2] 单独按 "trace-a-remove" 文本会撞上传本身留的 added 行（审计留痕不删旧行，
            // 文件名在两行都出现）；单独按徽章「删除附件」又会撞下方 nullname 边界态行（action_code 同为
            // attachment_removed）。改用「徽章=删除附件」∧「展开区含 trace-a-remove 文件名」组合过滤，
            // 恰定位到这一条真实删除行。
            const removedRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt', { hasText: '删除附件' }) }).filter({ hasText: 'trace-a-remove' });
            const malformedRow = page.locator('.si-tl-item:has-text("trace-a-malformed")');
            const nullnameRow = page.locator('.si-tl-item:has-text("trace-a-nullname")');
            const xssRow = page.locator('.si-tl-item:has-text("trace-a-xss")');

            await shotOnFail(page, await addedRow.count() === 1, 'f1-added-present', `[F1] added 行存在，实得 ${await addedRow.count()}`);
            await shotOnFail(page, await replacedRow.count() === 1, 'f1-replaced-present', `[F1] replaced 行存在，实得 ${await replacedRow.count()}`);
            await shotOnFail(page, await removedRow.count() === 1, 'f1-removed-present', `[F1] removed 行存在，实得 ${await removedRow.count()}`);
            await shotOnFail(page, await malformedRow.count() === 1, 'f1-malformed-present', `[F1] 畸形 payload 行存在（未因异常崩溃丢失），实得 ${await malformedRow.count()}`);
            await shotOnFail(page, await nullnameRow.count() === 1, 'f1-nullname-present', `[F1] null 文件名行存在，实得 ${await nullnameRow.count()}`);
            await shotOnFail(page, await xssRow.count() === 1, 'f1-xss-present', `[F1] XSS 文件名行存在，实得 ${await xssRow.count()}`);

            // 六行均应带 si-tl-release-scope（action_code 已登记进 SI_TL_HIDABLE_CODES，与 payload 是否合法无关）。
            for (const [name, loc] of [['added', addedRow], ['replaced', replacedRow], ['removed', removedRow], ['malformed', malformedRow], ['nullname', nullnameRow], ['xss', xssRow]]) {
                const cls = await loc.getAttribute('class');
                must((cls || '').includes('si-tl-release-scope'), `[F1] ${name} 行带 si-tl-release-scope class（实得 class="${cls}"）`);
            }

            // 展开区：added/replaced/removed 三条 well-formed 行应有 <details class="si-tl-attach-list">，列全名单。
            const addedDetail = await addedRow.locator('details.si-tl-attach-list').textContent();
            must(!!addedDetail && addedDetail.includes('trace-a-added.png') && addedDetail.includes('交付附件'), `[F1] added 展开区含文件名+类型词，实得 "${addedDetail}"`);
            const replacedDetail = await replacedRow.locator('details.si-tl-attach-list').textContent();
            must(!!replacedDetail && replacedDetail.includes('trace-a-spec-new.pdf') && replacedDetail.includes('需求材料'), `[F1] replaced 展开区含新文件名+类型词，实得 "${replacedDetail}"`);
            const removedDetail = await removedRow.locator('details.si-tl-attach-list').textContent();
            must(!!removedDetail && removedDetail.includes('trace-a-remove.png') && removedDetail.includes('交付附件') && removedDetail.includes('原上传人：'), `[F1] removed 展开区含文件名+类型词+原上传人前缀，实得 "${removedDetail}"`);

            // 畸形 payload：不应有 details.si-tl-attach-list（回退 esc(summary)，不抛不显告警）。
            must(await malformedRow.locator('details.si-tl-attach-list').count() === 0, '[F1] 畸形 payload 行不出展开区（回退纯文本 summary）');
            const malformedText = await malformedRow.textContent();
            must(!!malformedText && malformedText.includes('trace-a-malformed'), `[F1] 畸形 payload 行仍展示原始 summary 文本（esc 后），实得 "${malformedText}"`);

            // null 文件名/上传人占位符。
            const nullnameDetail = await nullnameRow.locator('details.si-tl-attach-list').textContent();
            must(!!nullnameDetail && nullnameDetail.includes('（无文件名）#999001') && nullnameDetail.includes('（未知上传人）'), `[F1] null 文件名/上传人占位符正确，实得 "${nullnameDetail}"`);

            // XSS 文件名：展开区应含转义后的纯文本，且不应真的生成 <img> 元素（证明是文本非标签）。
            // M3：负向断言（无真实 img 节点）作用域从「只查 details 内」抬到「整行」——payload 在这条
            // note 型行同时走 summary 路径（baseSummaryHtml，行内直显的摘要文本）和展开区路径
            // （si-tl-attach-list 列表项），回归若打在 summary 路径，details 内计数仍为 0，旧写法会
            // 静默变绿。summary 与展开区各补一条正向转义断言，把"确实转义"和"确实没有节点"两面钉住。
            const xssBodyHtml = await xssRow.locator('.si-tl-body').innerHTML();
            const xssSummaryPart = xssBodyHtml.split('<details')[0];
            must(xssSummaryPart.includes('&lt;img'), `[F1] XSS 文件名在 summary 路径被转义为 &lt;img（正向断言），实得 "${xssSummaryPart}"`);
            const xssDetail = await xssRow.locator('details.si-tl-attach-list').textContent();
            must(!!xssDetail && xssDetail.includes('<img src=x onerror=alert(1)>.png'), `[F1] XSS 文件名以纯文本形式出现在展开区（textContent 解码后应可见原字符），实得 "${xssDetail}"`);
            const xssDetailHtml = await xssRow.locator('details.si-tl-attach-list').innerHTML();
            must(xssDetailHtml.includes('&lt;img'), `[F1] XSS 文件名在展开区路径被转义为 &lt;img（正向断言），实得 "${xssDetailHtml}"`);
            const xssImgCount = await xssRow.locator('img').count();
            must(xssImgCount === 0, `[F1] XSS 文件名在整行（summary + 展开区，非仅 details 内）均未生成真实 <img> 节点，实得 img 节点数=${xssImgCount}`);
            must(!page._dialogTriggered(), `[F1] 全程未触发任何浏览器 dialog（XSS 载荷未被执行），实得 ${page._dialogTriggered()}`);

            // M5（codex 596C）：同批 3 文件上传行——原版所有展开区断言只读 textContent/innerHTML，测不出
            // "展开交互本身失效"或"批量列表只渲染首项"这类回归。改用真实点击展开 → 等 <details> 的
            // open 属性出口层状态 → 核对 <ul> 确实可见 → 逐项比对文件名+类型词 → 再收起断内容隐藏。
            const batchRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt', { hasText: '上传附件' }) }).filter({ hasText: 'trace-a-batch3-a' });
            await shotOnFail(page, await batchRow.count() === 1, 'f1-batch3-present', `[F1] batch3（同批 3 文件）行存在，实得 ${await batchRow.count()}`);
            const batchDetails = batchRow.locator('details.si-tl-attach-list');
            const batchSummary = batchDetails.locator('summary');
            const batchDetailsHandle = await batchDetails.elementHandle();
            must(!!batchDetailsHandle, '[F1] batch3 行应有 details.si-tl-attach-list 展开区');
            await batchSummary.click();
            await page.waitForFunction((el) => !!el && el.open === true, batchDetailsHandle, { timeout: 5000 });
            must(await batchDetails.locator('ul').isVisible() === true, '[F1] batch3 点击展开后 <ul> 列表应可见（非仅 DOM 存在，native <details> 折叠态下不可见）');
            const batchLiTexts = await batchDetails.locator('ul li').allTextContents();
            must(batchLiTexts.length === 3, `[F1] batch3 展开区应列全 3 项（不止渲染首项），实得 ${batchLiTexts.length} 项：${JSON.stringify(batchLiTexts)}`);
            for (const fn of ['trace-a-batch3-a.png', 'trace-a-batch3-b.png', 'trace-a-batch3-c.png']) {
                must(batchLiTexts.some((t) => t.includes(fn) && t.includes('交付附件')), `[F1] batch3 展开区含 ${fn} 及类型词「交付附件」，实得 ${JSON.stringify(batchLiTexts)}`);
            }
            await batchSummary.click();
            await page.waitForFunction((el) => !!el && el.open === false, batchDetailsHandle, { timeout: 5000 });
            must(await batchDetails.locator('ul').isVisible() === false, '[F1] batch3 再次点击收起后 <ul> 列表应隐藏');

            // 隐藏开关往返：勾选后六行（含 batch3）全部 display:none，取消勾选后全部恢复可见。M4：
            // sentinel 用 addedRow（可隐藏行）等到出口层状态，不再硬睡 300ms。
            await toggleHideCheckbox(page, addedRow, 'hidden');
            for (const [name, loc] of [['added', addedRow], ['replaced', replacedRow], ['removed', removedRow], ['malformed', malformedRow], ['nullname', nullnameRow], ['xss', xssRow], ['batch3', batchRow]]) {
                must(await loc.isVisible() === false, `[F1] 勾选后 ${name} 行应被隐藏`);
            }
            await toggleHideCheckbox(page, addedRow, 'visible');
            for (const [name, loc] of [['added', addedRow], ['replaced', replacedRow], ['removed', removedRow], ['malformed', malformedRow], ['nullname', nullnameRow], ['xss', xssRow], ['batch3', batchRow]]) {
                must(await loc.isVisible() === true, `[F1] 取消勾选后 ${name} 行应恢复可见`);
            }

            must(unexpectedConsoleErrors(page).length === 0, `[F1] 页面全程 console error（扣除已知噪声）应为 0 条，实得=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
            })();
            try { await currentInFlight; } finally { currentInFlight = null; }
        }

        // ══════════════════════════════════════════════════════════════════
        // [F2] 只有改期行（release_add + release_date_change，均属批次编排 scope_change 类）
        // ⚠️ [自查修正×3] 实测 + 源码核对（Sys_Iteration.html:4469-4476 SI_TL_HIDABLE_CODES 与
        //   :4458 一带注释「刻意不同：把改期排除在外」）：release_date_change **不在**可隐藏 Map 里——
        //   它虽同属 scope_change 拿到「上线单改期」标签归属（走 isReleaseScope），但可隐藏性判据
        //   （siTlIsHidableScope，只查 SI_TL_HIDABLE_CODES）恰把它排除。这是既有设计（#67 A4 明文），
        //   非本次改造对象也非缺陷——本文件原假设「改期行同批被隐藏」是我测试脚本写错，已按实测修正为
        //   「改期行恒可见，不受隐藏开关影响」（与逐人完成行同类对照）。
        // ══════════════════════════════════════════════════════════════════
        if (!checkCancelled('F2')) {
            currentInFlight = (async () => {
            const { issueId } = await mkReleaseOnlyIssue(adminTok);
            const page = await loginPage(browser, adminTok);
            await gotoIssue(page, issueId);

            const addRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt', { hasText: '加入上线单' }) });
            const dateRow = page.locator('.si-tl-item:has-text("上线计划日期变更")');
            await shotOnFail(page, await addRow.count() === 1, 'f2-add-present', `[F2] release_add 行存在，实得 ${await addRow.count()}`);
            await shotOnFail(page, await dateRow.count() === 1, 'f2-date-present', `[F2] release_date_change 行存在，实得 ${await dateRow.count()}`);
            must(await page.locator('.si-tl-item.si-tl-teal').count() === 0, '[F2] 隔离页不应混入逐人完成行（si-tl-teal 恰 0）');
            must(await page.locator('details.si-tl-attach-list').count() === 0, '[F2] 隔离页不应混入附件展开区');
            const dateCls = await dateRow.getAttribute('class');
            must(!(dateCls || '').includes('si-tl-release-scope'), `[F2] release_date_change 行不带 si-tl-release-scope（既有设计：改期排除在可隐藏集合外），实得 class="${dateCls}"`);

            // M4：sentinel 用 addRow（唯一可隐藏行），dateRow 恒可见不能拿来当出口层状态哨兵。
            await toggleHideCheckbox(page, addRow, 'hidden');
            must(await addRow.isVisible() === false, '[F2] 勾选后 release_add 行应被隐藏');
            must(await dateRow.isVisible() === true, '[F2] 勾选后 release_date_change 行仍应可见（既有设计：改期排除在可隐藏集合外，非本次改造范围）');
            await toggleHideCheckbox(page, addRow, 'visible');
            must(await addRow.isVisible() === true, '[F2] 取消勾选后 release_add 行应恢复可见');
            must(await dateRow.isVisible() === true, '[F2] 取消勾选后 release_date_change 行仍可见');

            must(unexpectedConsoleErrors(page).length === 0, `[F2] 页面全程 console error 应为 0 条，实得=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
            })();
            try { await currentInFlight; } finally { currentInFlight = null; }
        }

        // ══════════════════════════════════════════════════════════════════
        // [F3] 只有逐人完成行（si-tl-teal，天然不可隐藏——不受本次改造影响的对照组）
        // ⚠️ [自查修正] 实测 + 源码核对（Sys_Iteration.html:3969 一带：`hasReleaseScopeTl` 为 false 时
        //   `tlFilterHtml` 恰为空串，过滤器 checkbox 整个不渲染，非"渲染但无效"）：本页无任何登记进
        //   SI_TL_HIDABLE_CODES 的行，checkbox 本身不应存在于 DOM——按此断言，不再尝试点击一个不该
        //   存在的控件（原版本对 30s 超时是我的错误假设，非真实缺陷）。
        // ══════════════════════════════════════════════════════════════════
        if (!checkCancelled('F3')) {
            currentInFlight = (async () => {
            const id = await mkPerDevOnlyIssue(adminTok, devTok);
            const page = await loginPage(browser, devTok);
            await gotoIssue(page, id);

            const perDevRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt.si-tl-teal') });
            await shotOnFail(page, await perDevRow.count() === 1, 'f3-perdev-present', `[F3] 逐人完成行恰 1 条，实得 ${await perDevRow.count()}`);
            const perDevCls = await perDevRow.first().getAttribute('class');
            must(!(perDevCls || '').includes('si-tl-release-scope'), `[F3] 逐人完成行不带 si-tl-release-scope（未登记进可隐藏集合），实得 class="${perDevCls}"`);
            must(await page.locator('details.si-tl-attach-list').count() === 0, '[F3] 隔离页不应混入附件展开区');
            must(await page.locator('.si-tl-item:has-text("上线计划日期变更")').count() === 0, '[F3] 隔离页不应混入改期行');

            must(await perDevRow.isVisible() === true, '[F3] 逐人完成行应可见');
            must(await page.locator(`label:has-text("${HIDE_LABEL_TEXT}")`).count() === 0, '[F3] 本页无任何可隐藏行，过滤器 checkbox 本身不应渲染（既有设计，非死开关）');

            must(unexpectedConsoleErrors(page).length === 0, `[F3] 页面全程 console error 应为 0 条，实得=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
            })();
            try { await currentInFlight; } finally { currentInFlight = null; }
        }

        // ══════════════════════════════════════════════════════════════════
        // [F4] 混合页：三类共存，隐藏开关只影响附件三码+release_add，不影响逐人完成行/改期行
        // ══════════════════════════════════════════════════════════════════
        if (!checkCancelled('F4')) {
            currentInFlight = (async () => {
            const { issueId } = await mkMixedIssue(adminTok, devTok); // uploadTouchedIssueIds 登记已提前到函数内部
            const page = await loginPage(browser, adminTok);
            await gotoIssue(page, issueId);

            const perDevRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt.si-tl-teal') });
            const attachRow = page.locator('.si-tl-item:has-text("trace-mix-added")');
            const addRow = page.locator('.si-tl-item', { has: page.locator('.si-tl-evt', { hasText: '加入上线单' }) });
            const dateRow = page.locator('.si-tl-item:has-text("上线计划日期变更")');

            await shotOnFail(page, await perDevRow.count() === 1, 'f4-perdev-present', `[F4] 逐人完成行存在，实得 ${await perDevRow.count()}`);
            await shotOnFail(page, await attachRow.count() === 1, 'f4-attach-present', `[F4] 附件 added 行存在，实得 ${await attachRow.count()}`);
            await shotOnFail(page, await addRow.count() === 1, 'f4-releaseadd-present', `[F4] release_add 行存在，实得 ${await addRow.count()}`);
            await shotOnFail(page, await dateRow.count() === 1, 'f4-datechange-present', `[F4] release_date_change 行存在，实得 ${await dateRow.count()}`);

            for (const [n, l] of [['perdev', perDevRow], ['attach', attachRow], ['add', addRow], ['date', dateRow]]) {
                must(await l.isVisible() === true, `[F4] 勾选前 ${n} 行应可见`);
            }
            // M4：sentinel 用 attachRow（可隐藏行），等到出口层状态。
            await toggleHideCheckbox(page, attachRow, 'hidden');
            must(await perDevRow.isVisible() === true, '[F4] 勾选后逐人完成行仍应可见（不受隐藏开关影响）');
            must(await attachRow.isVisible() === false, '[F4] 勾选后附件行应被隐藏');
            must(await addRow.isVisible() === false, '[F4] 勾选后 release_add 行应被隐藏');
            must(await dateRow.isVisible() === true, '[F4] 勾选后 release_date_change 行仍应可见（既有设计：改期排除在可隐藏集合外）');
            await toggleHideCheckbox(page, attachRow, 'visible');
            for (const [n, l] of [['perdev', perDevRow], ['attach', attachRow], ['add', addRow], ['date', dateRow]]) {
                must(await l.isVisible() === true, `[F4] 取消勾选后 ${n} 行应恢复可见`);
            }

            must(unexpectedConsoleErrors(page).length === 0, `[F4] 页面全程 console error 应为 0 条，实得=${JSON.stringify(page._consoleErrors)}`);
            await page.close();
            })();
            try { await currentInFlight; } finally { currentInFlight = null; }
        }
    } catch (e) {
        // M2（596CR1 二次处置）：main() 主流程自身异常（含启动序列失败）不再交给模块底部的
        // main().catch 直接 process.exit(1)——那样会跳过统一的 shutdown 收尾。这里记录后交给下面的
        // finally 走同一份 shutdown('normal')。
        console.error('测试运行异常：', e);
        fail++; failDetails.push(`main 主流程异常：${e.message}`);
    } finally {
        // M2：main() 的 finally 与信号处理器现在都只调用同一个幂等 shutdown()——不再各自维护一套清理
        // 逻辑（原版两处并发跑，见 doShutdown 头注释）。[#106 S4b2a] 退出在 doShutdown 内部：信号路径 process.exit(130) 立刻终止；
        // 正常路径是 testEnv.finish(code)（只设退出码、不终止执行），doShutdown 返回后本 finally 即 main() 的最后一段，本行之后没有任何语句，
        // main() 随即结束，进程在事件循环排空后以该退出码结束（finish 自带 10 秒 unref 兜底）。
        await shutdown('normal');
    }
}

main().catch(async (e) => {
    console.error('测试运行异常：', e);
    try { await testEnv.teardown(); } catch (_) { /* 尽力收实例 */ }
    process.exit(1);
});
