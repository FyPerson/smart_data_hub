/**
 * 系统迭代·开发撤回提交（W2 前端）——浏览器冒烟
 * 方案：docs/local/系统迭代/开发撤回提交_方案_20260910_v1.2.md §5.10（前端）+ §7（验证矩阵，前端子集）
 * 后端契约（W1，已 commit `1cc5156`）：POST /sys-issues/:id/submit/withdraw——七级校验顺序 §5.6、
 *   令牌来源契约（详情端点 devAssignees[].latest_submit_event_id，与交付内容同一快照返回，任意
 *   dev_status 均含该字段）。前端 W2 已 commit `9c5abf2`。后端正确性已由
 *   scripts/verify-sys-submit-withdraw.js 覆盖，本文件只测前端。
 *
 * 骨架抄 test-sys-submit-amend-playwright.js：JWT 注入登录 + 直查库/直调 API 断言范式 +
 *   registerCreatedId 收尾清理（直连 SQL 级联删除，不经业务 DELETE 端点软闸）。
 *
 * [2026-09-10 codex 553 三条 MEDIUM 回卷] 本轮重写动机——三点判别力缺口：
 *   ① T1"未在册"用例主状态本就落在待指派（不在准入集），与"未在册"两条件同时为假，证明不了"在册"
 *      这一条；改为"主状态允许（待验证）+ 交付属于另一开发 + 登录人不在花名册"，且先证详情加载无异常
 *      （区分"按钮未出现"与"页面炸了"）。
 *   ② T3 只改服务端、不刷新页面 siCaps，"打开时固定"与"确认时读 siCaps 旧值"两种写法拿到的是同一个
 *      旧令牌，测不出差异；改为直接断言请求体字段值 + 弹窗打开后显式刷新页面内 siCaps（制造两者分岔）
 *      再点确定，断言仍提交打开时的旧值；并补令牌缺失 fail-closed 用例（唯一一条前端 fail-closed 守卫，
 *      删掉它整套测试原本全绿）。
 *   ③ 固定 waitForTimeout 换成 window.__siTestHooks 完成信号（modalConfirmSettleCount/lastSettledInstance，
 *      Sys_Iteration.html:1002-1015 明文供测试 waitForFunction 用）+ 结果态用 waitForFunction/waitForSelector
 *      驱动而非二次固定等待；负向断言（请求数=0）必须在 settle 信号之后才检查，不能靠"睡得比它慢"赌时序。
 *   ④ T4 主状态断言此前取整个 #siDrawer innerText 找"开发中"——但 W-GATE 弹回行的存量转译文案本身就含
 *      "开发中"三个字（"出现新的待提交成员，自动退回开发中"），断言对着过期的顶部徽标也能通过；改锚到
 *      顶部状态徽标元素 #siDMeta .u-status-badge。补：提交时带唯一标记的工作说明，撤回后断言"当前交付"
 *      区块（.si-worknote-block）不再显示该标记（历史审计留痕不在本文件断言范围，后端已覆盖）；补
 *      no_code 模式撤回用例（方案 §5.6：no_code 模式不产生新 dev_events、rev 不变，是"靠主状态闸兜底"
 *      的唯一路径，此前五个用例全是 commits 模式，未覆盖）。
 *
 * 覆盖：
 *   T1 按钮显隐 × 3 态（判别力修正版）：
 *      - 本人 code_submitted（待验证）可见
 *      - 本人 pending（未提交，主状态已在允许族内）不可见——隔离"自己未交付"这一条件
 *      - 主状态允许（待验证）但本人未进花名册（交付属于另一开发）不可见——隔离"未在册"这一条件，
 *        且先证详情加载成功无异常（siCaps 结构完整 + myRow===null + 控制台无报错）再断按钮
 *   T2 弹层理由必填校验——空理由点确定：settle 信号后确认零请求、toast 提示、弹层不关闭
 *   T3 令牌来源契约（判别力修正版）：
 *      - 直接断言 withdraw 请求体 expected_submit_event_id 字段值精确等于"打开弹窗那一刻"记下的编号
 *      - 打开弹窗后：外部 amend 推进服务端最新事件号 → 页面内显式刷新 siCaps（siRenderDrawer 重取详情，
 *        令 siCaps.myRow.latest_submit_event_id 前进到新值）→ 点击（未重开的）旧弹窗确定 → 断言请求体
 *        仍是打开弹窗时的旧值（非刷新后的新值）、响应 409 WITHDRAW_TARGET_CHANGED、库值未被误撤回
 *      - 令牌缺失 fail-closed：详情响应里 latest_submit_event_id 为 null 时点击按钮——不打开弹层、
 *        不发请求、toast 提示刷新
 *   T4 撤回成功 × 2 模式（commits / no_code）：
 *      - 主状态徽标（#siDMeta .u-status-badge，非整页 innerText）由「待验证」精确变为「开发中」
 *      - 时间线出现「撤回提交」徽标（中文文案 + si-tl-amber 配色类）
 *      - 提交时植入的唯一标记文本，撤回前存在于"当前交付"展示区，撤回后从该区消失（展示失效渲染层证明）
 *      - no_code 模式：本人 dev_status 回 pending、无代码交付说明块的标记同样消失
 *   T5 理由长度码点边界（W1 遗留 LOW）——中文+emoji 混合串（非 ASCII）测 300/301，证明按码点计数而非
 *      UTF-16 长度：300 码点提交成功（真实撤回），301 码点被前端拦截（settle 后确认零请求）
 *
 * 用法：node scripts/test-sys-submit-withdraw-playwright.js（需先启动 node server.js，端口 3000）
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码

const ADMIN_ID = 1;
const DEV_ID = 8;         // 示例开发A——本文件的「本人」开发账号（登录人）
const SECOND_DEV_ID = 9;  // 示例开发B——"交付属于另一开发"场景的实际提交者

const RUN_TAG = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const RUN_TAG_MARKER = `RT-WITHDRAW-${RUN_TAG}`;
const TITLE_PREFIX = '[pw-submit-withdraw]';

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
function jsonHeaders(tok) { return { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }; }
function futureEstStr(days) {
    const d = new Date(Date.now() + (days || 30) * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 中文+emoji 混合串（非 ASCII）按精确码点数构造——emoji 在 JS 字符串里是代理对（2 个 UTF-16 code unit /
// 1 个码点），用于证明前端校验用的是 [...s].length（码点计数）而非 s.length（UTF-16 长度）：若前端误用
// 后者，300 码点（含若干 emoji）的 s.length 会 >300，被误判超限拦下，T5 300 码点成功用例会假红。
function makeReasonOfCodepoints(n) {
    const units = [];
    for (let i = 0; i < n; i++) units.push((i % 7 === 0) ? '🎉' : '测');
    return units.join('');
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
        const p = path.join(os.tmpdir(), 'sys-playwright-shots', `withdraw-fail-${name}.png`);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`     📸 失败截图: ${p}`); }
        catch (_) { /* 截图失败不影响主流程 */ }
    }
}

const createdIds = [];
function registerCreatedId(id) { if (Number.isInteger(id) && id > 0 && !createdIds.includes(id)) createdIds.push(id); }
async function deleteIssueFully(issueId) {
    await dbRun(`DELETE FROM sys_fast_release_executors WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_dev_events WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_dev_commits WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_attachments WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [issueId]);
    await dbRun(`DELETE FROM sys_issues WHERE id=?`, [issueId]);
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    // "Failed to load resource" 这类浏览器原生控制台报错，URL 不在 m.text() 里（Chrome 只给固定文案
    // "Failed to load resource: the server responded with a status of 403 (Forbidden)"），要靠
    // m.location().url 才能定位到底是哪个请求——同时记两者，供调用方按 URL 精确过滤已知噪音。
    page.on('console', m => { if (m.type() === 'error') { const loc = (m.location && m.location()) || {}; consoleErrors.push(m.text() + (loc.url ? ` @ ${loc.url}` : '')); } });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js`)); });
    });
}
// 未标记 toast 聚合读取——同 test-sys-submit-amend-playwright.js 范式：先标记现存 toast，动作后取未标记的。
async function markExistingToasts(page) {
    await page.evaluate(() => { document.querySelectorAll('#toast-container > *').forEach(el => { el.dataset.pwSeen = '1'; }); });
}
async function newToastText(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#toast-container > *'))
        .filter(n => !n.dataset.pwSeen).map(n => n.textContent).join(' | '));
}
// [codex 554 LOW-2] "当前交付"展示区精确定位——工作说明与无代码交付说明共用同一个外层 class
// `.si-worknote-block`（Sys_Iteration.html siRenderDevMemberChips :4740/:4778），只能靠内部
// `.si-worknote-title` 的文案区分是哪一块。不对整个 #siDrawer 要求"不含标记"：① 若详情页将来在别处
// （如时间线审计载荷展开）展示历史提交内容，那里正确保留的历史标记会被误判成回归；② 撤回前若只对
// 整页做正向搜索，证明不了标记确实出现在"当前交付"区（可能是从页面别处偶然命中）。"当前交付展示
// 失效"与"历史审计保留"是两件分开判断的事——本文件只断言前者（精确定位到这两个容器），后者由后端
// scripts/verify-sys-submit-withdraw.js 覆盖（payload_json 冻结快照），不在本文件断言范围内。
function currentWorkNoteBlock(page) {
    return page.locator('.si-worknote-block', { has: page.locator('.si-worknote-title', { hasText: '工作说明' }) });
}
function currentNoCodeBlock(page) {
    return page.locator('.si-worknote-block', { has: page.locator('.si-worknote-title', { hasText: '无代码交付说明' }) });
}
// [codex 553 MEDIUM-③] 完成信号钩子——Sys_Iteration.html:1002-1015 的 window.__siTestHooks
// modalConfirmSettleCount/lastSettledInstance："供测试 waitForFunction 精确等到迟到响应确实已被处理完，
// 替代固定 sleep"；lastSettledInstance 配合调用点记录的弹层实例号，防"计数前进但不是我在等的那次"。
// 用法：打开弹层后立即记录 currentModalInstance(page)，点确定后 waitForModalSettle(page, 该值)——
// 覆盖三条分支（成功/409/前端校验提前 return false）：onConfirm 内**任意**返回路径都会让
// siModalConfirm() 的 `await onConfirm(v)` resolve，随即写这两个钩子，与是否真的发过网络请求无关。
async function currentModalInstance(page) {
    return page.evaluate(() => (typeof siModalInstanceSeq === 'number' ? siModalInstanceSeq : null));
}
async function waitForModalSettle(page, instanceAtOpen, timeout = 8000) {
    await page.waitForFunction(
        (inst) => window.__siTestHooks && window.__siTestHooks.lastSettledInstance === inst,
        instanceAtOpen,
        { timeout }
    );
}

// ── API 夹具 ──────────────────────────────────────────────────────────────
let seq = 0;
async function apiCreate(adminTok, type, extra = {}) {
    seq++;
    const body = {
        intake_contract_version: 2, type,
        title: `${TITLE_PREFIX}-${type}-${RUN_TAG}-${seq}`,
        system_name: 'BMS', source: '内部',
        description: `Sys-Withdraw W2 Playwright 夹具 ${RUN_TAG_MARKER}`,
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
async function apiReassign(adminTok, id, memberIds, reason) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/reassign`, {
        method: 'POST', headers: jsonHeaders(adminTok), body: JSON.stringify({ member_ids: memberIds, reason: reason || 'Playwright 夹具' }),
    });
    if (r.status !== 200) throw new Error(`[夹具 reassign] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(await r.json().catch(() => null))}`);
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
async function apiSubmitNoCode(devTok, id, reason) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit`, {
        method: 'POST', headers: jsonHeaders(devTok),
        body: JSON.stringify({ mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(`[夹具 submit-no_code] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(j)}`);
    return j;
}
// T3 用：外部（非本页面）amend 请求——只改 work_note（commits→commits 方向，不携带 commits 字段），足以
// 让后端写一条新的 submit 事件、令 latest_submit_event_id 前进，而不影响 commit 行本身。
async function apiAmendWorkNote(devTok, id, note) {
    const r = await fetch(`${BASE_URL}/api/sys-issues/${id}/submit/amend`, {
        method: 'POST', headers: jsonHeaders(devTok), body: JSON.stringify({ mode: 'commits', work_note: note }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(`[T3 外部 amend] id=${id} 应 200，实得 ${r.status} ${JSON.stringify(j)}`);
    return j;
}

// F1：单人 improvement，全完成自动进「待验证」，DEV_ID 本人 code_submitted（普通夹具，无标记）。
async function mkFixtureVerify(adminTok, devTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910900 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-withdraw-verify-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-待验证] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F1b：同 F1，但 work_note 携带唯一标记——供 T4 展示失效断言使用。
async function mkFixtureVerifyWithMarker(adminTok, devTok, marker) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910900 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitCommits(devTok, id, `pw-withdraw-marker-${id}`, { work_note: marker });
    if (sub.main_status !== '待验证') throw new Error(`[夹具-待验证+标记] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F1c：no_code 模式，no_code_reason 携带唯一标记——供 T4 no_code 分支使用。
async function mkFixtureVerifyNoCodeWithMarker(adminTok, devTok, marker) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910900 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiEstimate(devTok, id, 1);
    const sub = await apiSubmitNoCode(devTok, id, marker);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-待验证 no_code+标记] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}
// F2：本人已指派但未提交（dev_status=pending，主状态「开发中」——已在允许族内，隔离"自己未交付"这一条件）。
async function mkFixturePendingDev(adminTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910950 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    return id;
}
// F3（判别力修正版）：主状态允许（待验证）且交付属于**另一开发**（SECOND_DEV_ID），DEV_ID（登录人）
// 不在**当前活跃**花名册——隔离"未在册"这一条件（若只用 F3 旧版"待指派+未在册"，两条件同时为假，
// 证明不了"在册"这一条，codex 553 MEDIUM-①点名）。
// ⚠️ 实测发现：GET 详情端点对完全无关联的用户返回 403 NOT_AUTHORIZED_TO_VIEW（isRosterMember 等
// 放行集判据不含"从未打过交道的路人"），若 DEV_ID 从未进过这单的花名册，连详情都加载不了——测不出
// "详情加载成功但按钮不可见"这个判别点。改用**先入册再被 reassign 移出**：DEV_ID 曾是本单花名册
// 成员（历史行 removed_at 非空，满足 GET 详情端点 isRosterMember 判据——该判据不筛 removed_at，
// 历史成员仍保留只读查看权），之后被移出、SECOND_DEV_ID 独立完成——DEV_ID 此刻确定不在**当前活跃**
// 花名册（`fetchActiveDevAssignees` 只返在册行，siCaps.myRow 精确为 null），且详情页对其可正常打开。
async function mkFixtureViewableButRemovedFromRoster(adminTok, secondDevTok) {
    const id = await apiCreate(adminTok, 'improvement');
    await apiIntakeAccept(adminTok, id, { risk_level: '二级' });
    await apiSetOaNumber(adminTok, id, 20260910960 + seq);
    await apiAssign(adminTok, id, DEV_ID);
    await apiReassign(adminTok, id, [SECOND_DEV_ID], 'Playwright 夹具：移出 DEV_ID，只留 SECOND_DEV_ID 完成');
    await apiEstimate(secondDevTok, id, 1);
    const sub = await apiSubmitCommits(secondDevTok, id, `pw-withdraw-removedviewer-${id}`);
    if (sub.main_status !== '待验证') throw new Error(`[夹具-已移出仍可查看] main_status 应为「待验证」，实得 ${sub.main_status}`);
    return id;
}

async function main() {
    await ensureServerListening();
    const adminTok = await signAs(ADMIN_ID);
    const devTok = await signAs(DEV_ID);
    const secondDevTok = await signAs(SECOND_DEV_ID);
    const browser = await chromium.launch();
    try {
        console.log('=== 系统迭代·开发撤回提交 W2：前端 Playwright（codex 553 判别力回卷版）===');

        // ══════════════════════════════════════════════════════════════════
        // T1：按钮显隐 × 3 态（判别力修正版）
        // ══════════════════════════════════════════════════════════════════
        {
            const idVerify = await mkFixtureVerify(adminTok, devTok);
            const idPending = await mkFixturePendingDev(adminTok);
            const idOtherDev = await mkFixtureViewableButRemovedFromRoster(adminTok, secondDevTok);

            async function withdrawBtnVisible(id) {
                const page = await loginPage(browser, devTok);
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                const visible = await page.locator('#siDActions button:has-text("撤回提交")').count();
                await page.close();
                return visible > 0;
            }
            must(await withdrawBtnVisible(idVerify) === true, 'T1 待验证态（本人 code_submitted）「撤回提交」按钮可见');

            // [codex 554 MEDIUM] 判别力核心：pending 这条是**负向**断言（按钮数=0）——固定 500ms 后直接
            //   数按钮，测不出"详情请求失败/抽屉没渲染/能力计算异常"与"真的因为 pending 才隐藏"的区别
            //   （前者同样会让按钮数=0，负向断言照样"通过"）。同下方"未在册"用例一样先证详情真实加载
            //   到目标单据、能力计算正确、本人确是 pending、主状态确在允许族内，再断按钮不可见。
            {
                const page = await loginPage(browser, devTok);
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idPending}`);
                await page.waitForLoadState('networkidle');
                // ⚠️ `siDetail` 是页面 <script> 顶层 `let` 声明，不挂在 window 对象上（同本文件其余
                // page.evaluate 调用一贯写法：直接用裸标识符，不能写 `window.siDetail`——那永远是
                // undefined，会让本等待恒超时）。
                await page.waitForFunction((targetId) => typeof siDetail !== 'undefined' && siDetail && siDetail.issue && Number(siDetail.issue.id) === targetId, idPending, { timeout: 8000 });
                const capsProbePending = await page.evaluate(() => ({
                    hasSiCaps: typeof siCaps === 'object' && siCaps !== null,
                    myRowDevStatus: siCaps && siCaps.myRow ? siCaps.myRow.dev_status : null,
                    statusAllowed: (typeof SI_AMEND_STATUSES !== 'undefined' && Array.isArray(SI_AMEND_STATUSES) && siDetail && siDetail.issue)
                        ? SI_AMEND_STATUSES.includes(siDetail.issue.status) : null,
                    issueStatus: siDetail && siDetail.issue ? siDetail.issue.status : null,
                    drawerTitleText: (document.getElementById('siDTitle') || {}).textContent || '',
                }));
                must(capsProbePending.hasSiCaps === true, 'T1-pending 前置：详情加载成功——siCaps 已是对象（页面未炸，非静默失败）');
                must(capsProbePending.myRowDevStatus === 'pending', `T1-pending 前置：本人在册且 dev_status 精确为 pending（隔离"自己未交付"这一条件），实得=${capsProbePending.myRowDevStatus}`);
                must(capsProbePending.statusAllowed === true, `T1-pending 前置：主状态应在允许族 SI_AMEND_STATUSES 内（证明按钮隐藏不是因为"主状态不允许"），实得 statusAllowed=${capsProbePending.statusAllowed}（issueStatus=${capsProbePending.issueStatus}）`);
                must(capsProbePending.drawerTitleText.length > 0, 'T1-pending 前置：详情标题已渲染（详情页真实加载完成，非空白页）');
                const unexpectedErrorsPending = page._consoleErrors.filter(e => !e.includes('intake-liaisons'));
                must(unexpectedErrorsPending.length === 0, `T1-pending 前置：控制台无（本用例相关的）报错，已过滤已知无关噪音 intake-liaisons 403，实得=${JSON.stringify(unexpectedErrorsPending)}`);
                const visiblePending = await page.locator('#siDActions button:has-text("撤回提交")').count();
                must(visiblePending === 0, 'T1 本人 pending（未提交，主状态已在允许族内）「撤回提交」按钮不可见');
                await page.close();
            }

            // [codex 553 MEDIUM-①] 判别力核心：主状态允许（待验证）+ 交付属于另一开发 + 登录人未进花名册。
            //   先证详情加载成功无异常（siCaps 结构完整、myRow 精确为 null、控制台无报错），
            //   再断按钮不可见——区分"按钮没出现"与"页面炸了导致什么都没渲染"两种情形。
            {
                const page = await loginPage(browser, devTok);
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${idOtherDev}`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                const capsProbe = await page.evaluate(() => ({
                    hasSiCaps: typeof siCaps === 'object' && siCaps !== null,
                    myRowIsNull: siCaps ? siCaps.myRow === null : null,
                    isRosterMember: siCaps ? siCaps.isRosterMember : null,
                    drawerTitleText: (document.getElementById('siDTitle') || {}).textContent || '',
                }));
                must(capsProbe.hasSiCaps === true, 'T1【判别力】详情加载成功——siCaps 已是对象（页面未炸，非静默失败）');
                must(capsProbe.myRowIsNull === true && capsProbe.isRosterMember === false, `T1【判别力】siCaps.myRow 精确为 null 且 isRosterMember=false（登录人确未进花名册），实得=${JSON.stringify(capsProbe)}`);
                must(capsProbe.drawerTitleText.length > 0, 'T1【判别力】详情标题已渲染（详情页真实加载完成，非空白页）');
                // [实测发现·与本次改动无关的既有行为] 页面无条件请求 GET /api/sys-issues/intake-liaisons
                // （供受理人下拉选项用，与撤回功能无关），该端点对非 admin/协调人角色恒 403——每个普通
                // 开发账号访问任意详情页都会打这一条，与本用例是否在册无关。过滤掉这条已知噪音，其余
                // 任何报错仍应为零（真正区分"页面渲染是否正常"与"这条已知的、页面自身早已优雅处理的
                // 403"）。
                const unexpectedErrors = page._consoleErrors.filter(e => !e.includes('intake-liaisons'));
                must(unexpectedErrors.length === 0, `T1【判别力】详情加载期间控制台无（本用例相关的）报错，已过滤已知无关噪音 intake-liaisons 403，实得=${JSON.stringify(unexpectedErrors)}（原始=${JSON.stringify(page._consoleErrors)}）`);
                const visible = await page.locator('#siDActions button:has-text("撤回提交")').count();
                must(visible === 0, 'T1【判别力】主状态允许（待验证）但登录人未进花名册——「撤回提交」按钮不可见（隔离"未在册"这一条件，非"主状态不允许"）');
                await page.close();
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // T2：弹层理由必填校验——空理由点确定不应发请求（完成信号驱动，非固定 sleep）
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerify(adminTok, devTok);
            const page = await loginPage(browser, devTok);
            let withdrawReqCount = 0;
            page.on('request', (r) => { if (/\/submit\/withdraw$/.test(new URL(r.url()).pathname)) withdrawReqCount++; });
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            await page.click('#siDActions button:has-text("撤回提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const instanceAtOpen = await currentModalInstance(page);
            await markExistingToasts(page);
            await page.click('#siMConfirm');
            // [codex 553 MEDIUM-③] settle 信号后再检查请求数——onConfirm 校验失败分支同步 return false，
            //   settle 几乎即时写入；不靠"睡得比错误实现发请求慢"这种时序赌博（负向断言必须等真正完成）。
            await waitForModalSettle(page, instanceAtOpen);
            await shotOnFail(page, withdrawReqCount === 0, 't2-no-request', `T2 空理由点确定不应发出 withdraw 请求，实得请求数=${withdrawReqCount}`);
            const toastT2 = await newToastText(page);
            must(toastT2.includes('请填写撤回理由'), `T2 应提示"请填写撤回理由"，实得="${toastT2}"`);
            const modalOpenT2 = await page.locator('#siModalOverlay.open').count();
            must(modalOpenT2 > 0, 'T2 空理由校验失败后弹层应保持打开（未提交成功、未被误关闭）');
            const rowT2 = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(rowT2 && rowT2.dev_status === 'code_submitted', 'T2 校验失败不应触碰库——本人 dev_status 仍为 code_submitted');
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T3：令牌来源契约（判别力修正版）
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerify(adminTok, devTok);
            const page = await loginPage(browser, devTok);
            const withdrawRequests = [];
            let lastWithdrawStatus = null, lastWithdrawBody = null;
            page.on('request', (r) => { if (/\/submit\/withdraw$/.test(new URL(r.url()).pathname)) withdrawRequests.push(r.postData()); });
            page.on('response', async (resp) => {
                if (/\/submit\/withdraw$/.test(new URL(resp.url()).pathname)) { lastWithdrawStatus = resp.status(); lastWithdrawBody = await resp.json().catch(() => null); }
            });
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 打开撤回弹窗——§5.6 令牌来源契约要求此刻固定 expected_submit_event_id（来自本次已加载的详情）。
            const tokenAtOpen = await page.evaluate(() => siCaps && siCaps.myRow && siCaps.myRow.latest_submit_event_id);
            must(Number.isInteger(tokenAtOpen) && tokenAtOpen > 0, `T3 前置：详情应含正整数 latest_submit_event_id，实得=${tokenAtOpen}`);
            await page.click('#siDActions button:has-text("撤回提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const instanceAtOpen = await currentModalInstance(page);
            await page.fill('#f_reason', 'T3：令牌契约验证用理由');

            // 弹窗仍开着的同时，外部（另一次请求）amend 掉工作说明——使后端 latest_submit_event_id 前进。
            const amendResult = await apiAmendWorkNote(devTok, id, 'T3：外部修正，制造令牌错位');
            const tokenAfterAmend = await dbGet(
                `SELECT e.id FROM sys_issue_dev_events e
                   JOIN sys_issue_dev_assignees da ON da.id = e.dev_assignee_id
                  WHERE da.issue_id=? AND da.user_id=? AND e.action IN ('submit','no_code')
                  ORDER BY e.id DESC LIMIT 1`,
                [id, DEV_ID]
            );
            must(tokenAfterAmend && tokenAfterAmend.id > tokenAtOpen, `T3 前置：外部 amend 后最新事件 id 应前进（${tokenAtOpen} → ${tokenAfterAmend && tokenAfterAmend.id}），amend 响应 amend_no=${amendResult.amend_no}`);

            // [codex 553 MEDIUM-②核心] 弹窗打开后、点确定前，显式刷新页面里的 siCaps（不经按钮/不重开
            //   弹窗）——siRenderDrawer 会重取详情并把 siCaps.myRow.latest_submit_event_id 前进到新值，
            //   人为制造"页面缓存的活值"与"弹窗打开时闭包捕获的旧值"两者出现分岔。若实现是"确认时读
            //   siCaps 里的当前值"（错误写法），此刻会提交新值 tokenAfterAmend.id；若实现是"打开时固定"
            //   （正确写法），仍会提交 tokenAtOpen——只有直接断言请求体字段值才能把这两种写法区分开
            //   （codex 553 指出：光靠"最终变成陈旧令牌"这个结果，两种写法在"从未刷新过 siCaps"的旧版
            //   用例里表现完全一样，测不出差异）。
            await page.evaluate((issueId) => siRenderDrawer(issueId), id);
            const tokenInSiCapsAfterRefresh = await page.evaluate(() => siCaps && siCaps.myRow && siCaps.myRow.latest_submit_event_id);
            must(tokenInSiCapsAfterRefresh === tokenAfterAmend.id, `T3 前置：页面内 siCaps 显式刷新后应反映新令牌（${tokenAfterAmend.id}），实得=${tokenInSiCapsAfterRefresh}（若不相等说明刷新未生效，下面的核心断言会失去意义）`);
            // 刷新详情不应关闭/替换我们已打开的旧弹窗（同一 DOM，独立于 siDetail/siCaps）。
            const modalStillOpenAfterRefresh = await page.locator('#siModalOverlay.open').count();
            must(modalStillOpenAfterRefresh > 0, 'T3 前置：刷新页面详情不应关闭已打开的旧撤回弹窗');
            const instanceStillSame = await currentModalInstance(page);
            must(instanceStillSame === instanceAtOpen, 'T3 前置：刷新详情不应让弹层实例号变化（同一个旧弹窗）');

            // 回到（siCaps 已变、但弹窗本身未重开的）旧弹窗点「确认撤回」。
            await markExistingToasts(page);
            await page.click('#siMConfirm');
            await waitForModalSettle(page, instanceAtOpen);

            must(withdrawRequests.length === 1, `T3 应恰好触发 1 次 withdraw 请求，实得 ${withdrawRequests.length} 次`);
            let requestTokenSubmitted = null;
            try { requestTokenSubmitted = withdrawRequests[0] ? JSON.parse(withdrawRequests[0]).expected_submit_event_id : null; } catch (_) { requestTokenSubmitted = null; }
            // 核心断言：请求体字段值精确等于"打开弹窗那一刻"的旧编号，而不是刚刚被显式刷新过的新编号——
            // 这是唯一能把"打开时固定"与"确认时读 siCaps 当前值"两种实现区分开的断言（codex 553 核心要求）。
            await shotOnFail(page, requestTokenSubmitted === tokenAtOpen, 't3-token-frozen-at-open', `T3【核心】请求体 expected_submit_event_id 应精确等于打开弹窗时的旧编号 ${tokenAtOpen}，实得=${requestTokenSubmitted}（若等于 ${tokenAfterAmend.id} 说明前端在确认时重新读取了 siCaps 当前值，令牌来源契约被违反）`);
            must(lastWithdrawStatus === 409, `T3 提交旧令牌应被服务端拒绝为 409，实得=${lastWithdrawStatus}`);
            must(lastWithdrawBody && lastWithdrawBody.code === 'WITHDRAW_TARGET_CHANGED', `T3 错误码应为 WITHDRAW_TARGET_CHANGED，实得=${lastWithdrawBody && lastWithdrawBody.code}`);
            const toastT3 = await newToastText(page);
            must(toastT3.includes('交付内容已变更') || toastT3.includes('刷新'), `T3 应提示交付已变更/引导刷新，实得="${toastT3}"`);
            const modalOpenT3 = await page.locator('#siModalOverlay.open').count();
            must(modalOpenT3 === 0, 'T3 409 后应自动关闭弹层（同 amend 409 分支范式）');
            // 关键断言：本人 dev_status 未被"陈旧撤回请求"误撤回成 pending——它应仍是 code_submitted。
            const rowT3 = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(rowT3 && rowT3.dev_status === 'code_submitted', `T3 核心断言：陈旧令牌的撤回请求被拒后，本人 dev_status 不应被撤回（新交付未被误撤），实得=${rowT3 && rowT3.dev_status}`);
            const issueRowT3 = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [id]);
            must(issueRowT3 && issueRowT3.status === '待验证', `T3 主状态不应被陈旧撤回请求改变，实得=${issueRowT3 && issueRowT3.status}`);
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T3b：令牌缺失 fail-closed——详情里 latest_submit_event_id 为 null 时不打开弹层、不发请求
        // ══════════════════════════════════════════════════════════════════
        {
            const id = await mkFixtureVerify(adminTok, devTok);
            const page = await loginPage(browser, devTok);
            let withdrawReqCount = 0;
            page.on('request', (r) => { if (/\/submit\/withdraw$/.test(new URL(r.url()).pathname)) withdrawReqCount++; });
            // 拦截详情响应，把本人那一行的 latest_submit_event_id 置 null——模拟"结构上不应发生"的缺口，
            // 专门验证前端这一唯一的 fail-closed 守卫（后端结构上恒不为 null，只有故意伪造响应才能触发）。
            await page.route(new RegExp('/api/sys-issues/' + id + '(\\?.*)?$'), async (route) => {
                const response = await route.fetch();
                let json;
                try { json = await response.json(); } catch (_) { return route.continue(); }
                if (json && Array.isArray(json.dev_assignees)) {
                    json.dev_assignees.forEach((d) => { if (Number(d.user_id) === DEV_ID) d.latest_submit_event_id = null; });
                }
                await route.fulfill({ response, json });
            });
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);
            const tokenProbe = await page.evaluate(() => siCaps && siCaps.myRow && siCaps.myRow.latest_submit_event_id);
            must(tokenProbe === null, `T3b 前置：拦截生效，详情里 latest_submit_event_id 应为 null，实得=${tokenProbe}`);
            const btnCountT3b = await page.locator('#siDActions button:has-text("撤回提交")').count();
            must(btnCountT3b > 0, 'T3b 前置：按钮显隐不依赖令牌字段，仍应可见（准入判据只看 dev_status/主状态）');
            await markExistingToasts(page);
            // siModalWithdrawSubmission 的 fail-closed 分支是同步早退（showToast + return，无 await），
            // click() 本身已等待事件处理完成，不需要额外等待。
            await page.click('#siDActions button:has-text("撤回提交")');
            const modalOpenT3b = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalOpenT3b === 0, 't3b-fail-closed-no-modal', `T3b【核心·fail-closed】令牌缺失时点击按钮不应打开弹层，实得 open 计数=${modalOpenT3b}`);
            must(withdrawReqCount === 0, `T3b【核心·fail-closed】令牌缺失时不应发出撤回请求，实得请求数=${withdrawReqCount}`);
            const toastT3b = await newToastText(page);
            must(toastT3b.includes('刷新'), `T3b 应提示刷新详情后重试，实得="${toastT3b}"`);
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T4：撤回成功 × 2 模式——主状态徽标精确断言 + 展示失效渲染层证明
        // ══════════════════════════════════════════════════════════════════
        // T4a：commits 模式
        {
            const marker = `WORKNOTE-MARK-${RUN_TAG}`;
            const id = await mkFixtureVerifyWithMarker(adminTok, devTok, marker);
            const page = await loginPage(browser, devTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // 撤回前：主状态徽标应为「待验收」，"当前交付"工作说明区应能看到标记（正向对照，证明选取器本身有效）。
            // ⚠️ 显示映射：DB/API 存的是「待验证」，siStatusDisplay() 纯展示层译成「待验收」（Sys_Iteration.html
            //   :1218，存储值/API 不变，仅前端渲染文案不同）——徽标断言按渲染出的文案走，不按内部状态字面量。
            const statusBadgeBefore = (await page.locator('#siDMeta .u-status-badge').first().textContent().catch(() => '')) || '';
            must(statusBadgeBefore.includes('待验收'), `T4a 前置：撤回前顶部状态徽标应为「待验收」（内部状态值「待验证」的展示译名），实得="${statusBadgeBefore}"`);
            const workNoteBlockBefore = currentWorkNoteBlock(page);
            must((await workNoteBlockBefore.count()) > 0, 'T4a 前置：撤回前"当前交付"工作说明区块应存在（精确定位容器，非整页搜索）');
            const workNoteTextBefore = (await workNoteBlockBefore.innerText().catch(() => '')) || '';
            must(workNoteTextBefore.includes(marker), `T4a 前置：撤回前"当前交付"工作说明区块内应能看到标记，实得区块文本${workNoteTextBefore.includes(marker) ? '含' : '未含'} marker`);

            await page.click('#siDActions button:has-text("撤回提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const instanceAtOpen = await currentModalInstance(page);
            await page.fill('#f_reason', 'T4a：自查发现代码有 bug，撤回重做');
            await markExistingToasts(page);
            await page.click('#siMConfirm');
            await waitForModalSettle(page, instanceAtOpen);
            const toastT4a = await newToastText(page);
            must(toastT4a.includes('已撤回提交'), `T4a 应提示"已撤回提交"，实得="${toastT4a}"`);

            // [codex 553 MEDIUM-③] settle 信号只保证 onConfirm 本身 resolve；成功分支的 siCloseModal+
            //   siAfterAction() 刷新是在 settle 信号写入**之后**才执行的（见 siModal() 内 siModalConfirm
            //   的顺序：先写钩子、再判 keep 才 siCloseModal+await siAfterAction），故此处仍需对"真实终态"
            //   做条件等待——但用的是 waitForFunction 驱动的具体终态断言，不是固定 sleep 猜时长。
            // [codex 554 LOW-1] 第二个参数是传给页面函数的 arg，不是 options——写成
            // `waitForFunction(fn, { timeout: 8000 })` 会让 `{timeout:8000}` 被当作 arg，8 秒超时从未
            // 生效，实际走的是默认超时。显式传 `null` 占住 arg 位，第三个参数才是真正的 options（同
            // waitForModalSettle 里的正确写法）。
            await page.waitForFunction(() => {
                const el = document.querySelector('#siDMeta .u-status-badge');
                return !!(el && el.textContent && el.textContent.includes('开发中'));
            }, null, { timeout: 8000 });

            // DB 层：主状态弹回开发族「开发中」，本人 dev_status 回 pending。
            const issueRowT4a = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [id]);
            must(issueRowT4a && issueRowT4a.status === '开发中', `T4a 主状态应弹回「开发中」，实得=${issueRowT4a && issueRowT4a.status}`);
            const devRowT4a = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(devRowT4a && devRowT4a.dev_status === 'pending', `T4a 本人 dev_status 应回 pending，实得=${devRowT4a && devRowT4a.dev_status}`);

            // [codex 553 MEDIUM-④] 主状态断言精确锚到顶部徽标元素（#siDMeta .u-status-badge），不取
            // 整页 innerText——W-GATE 弹回行的存量转译文案本身含"开发中"三字（"出现新的待提交成员，自动
            // 退回开发中"），对着整页文本找子串即便顶部徽标是过期的「待验证」也会通过，是恒真断言。
            const statusBadgeAfter = (await page.locator('#siDMeta .u-status-badge').first().textContent().catch(() => '')) || '';
            must(statusBadgeAfter.trim() === '开发中', `T4a 顶部状态徽标应精确为「开发中」（非子串匹配），实得="${statusBadgeAfter}"`);

            // 时间线徽标：中文文案 + si-tl-amber 配色类，不只断言映射键存在。
            await page.waitForSelector('.si-timeline', { timeout: 5000 });
            const badge = page.locator('.si-timeline .si-tl-evt', { hasText: '撤回提交' }).first();
            const badgeCount = await badge.count();
            await shotOnFail(page, badgeCount > 0, 't4a-timeline-badge', `T4a 时间线应出现"撤回提交"徽标，实得命中数=${badgeCount}`);
            if (badgeCount > 0) {
                const badgeText = (await badge.textContent()) || '';
                const badgeClass = (await badge.getAttribute('class')) || '';
                must(badgeText.includes('撤回提交'), `T4a 徽标文案应含"撤回提交"，实得="${badgeText}"`);
                must(badgeClass.includes('si-tl-amber'), `T4a 徽标配色类应含 si-tl-amber，实得 class="${badgeClass}"`);
            }

            // [codex 553 MEDIUM-④·codex 554 LOW-2 收窄] 展示失效渲染层证明——精确定位到"当前交付"工作
            // 说明区块本身（非整个 #siDrawer）。本单只有 DEV_ID 一名开发，撤回后其 work_note 被后端置
            // null（不再是"当前交付"），wnItems 变空，整块 workNotesBlock 不再渲染——断言区块本身消失，
            // 而非"标记字符串在整页搜不到"（历史审计留痕保留与否不在本文件断言范围，后端 payload_json
            // 已覆盖，见 scripts/verify-sys-submit-withdraw.js）。
            const workNoteBlockAfter = currentWorkNoteBlock(page);
            const workNoteBlockAfterCount = await workNoteBlockAfter.count();
            must(workNoteBlockAfterCount === 0, `T4a【展示失效】撤回后"当前交付"工作说明区块应整体消失（本单唯一 work_note 来源已被清空），实得区块数=${workNoteBlockAfterCount}`);
            await page.close();
        }

        // T4b：no_code 模式——方案 §5.6 "rev 不变、靠主状态闸兜底"的唯一路径，此前从未被覆盖。
        {
            const marker = `NOCODE-MARK-${RUN_TAG}`;
            const id = await mkFixtureVerifyNoCodeWithMarker(adminTok, devTok, marker);
            const page = await loginPage(browser, devTok);
            let withdrawReqCount = 0, lastStatus = null;
            page.on('response', async (resp) => {
                if (/\/submit\/withdraw$/.test(new URL(resp.url()).pathname)) { withdrawReqCount++; lastStatus = resp.status(); }
            });
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            const btnCountT4b = await page.locator('#siDActions button:has-text("撤回提交")').count();
            must(btnCountT4b > 0, 'T4b no_code 模式：本人 dev_status=no_code 时「撤回提交」按钮可见');
            const noCodeBlockBefore = currentNoCodeBlock(page);
            must((await noCodeBlockBefore.count()) > 0, 'T4b 前置：撤回前"无代码交付说明"区块应存在（精确定位容器，非整页搜索）');
            const noCodeTextBefore = (await noCodeBlockBefore.innerText().catch(() => '')) || '';
            must(noCodeTextBefore.includes(marker), `T4b 前置：撤回前"无代码交付说明"区块内应能看到标记，实得区块文本${noCodeTextBefore.includes(marker) ? '含' : '未含'} marker`);

            await page.click('#siDActions button:has-text("撤回提交")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            const instanceAtOpen = await currentModalInstance(page);
            await page.fill('#f_reason', 'T4b：自查发现无代码交付说明有误，撤回重做');
            await markExistingToasts(page);
            await page.click('#siMConfirm');
            await waitForModalSettle(page, instanceAtOpen);
            must(withdrawReqCount === 1 && lastStatus === 200, `T4b no_code 模式撤回应恰好成功一次，实得 请求数=${withdrawReqCount} status=${lastStatus}`);

            // [codex 554 LOW-1] 同 T4a——第二参必须是 null 占住 arg 位，第三参才是真正的 options。
            await page.waitForFunction(() => {
                const el = document.querySelector('#siDMeta .u-status-badge');
                return !!(el && el.textContent && el.textContent.includes('开发中'));
            }, null, { timeout: 8000 });

            const devRowT4b = await dbGet(`SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
            must(devRowT4b && devRowT4b.dev_status === 'pending', `T4b 本人 dev_status 应回 pending，实得=${devRowT4b && devRowT4b.dev_status}`);
            must(devRowT4b && devRowT4b.no_code_reason === null, `T4b 本人 no_code_reason 应被清空（CAS UPDATE 同事务清 NULL），实得=${JSON.stringify(devRowT4b && devRowT4b.no_code_reason)}`);
            // [codex 554 LOW-2 收窄] 精确定位到"无代码交付说明"区块本身——该实例 dev_status 已不再是
            // no_code，noCodeRecords 查询天然过滤掉，整块不再渲染（非"标记字符串整页搜不到"）。
            const noCodeBlockAfter = currentNoCodeBlock(page);
            const noCodeBlockAfterCount = await noCodeBlockAfter.count();
            must(noCodeBlockAfterCount === 0, `T4b【展示失效】撤回后"无代码交付说明"区块应整体消失（该实例 dev_status 已不再是 no_code），实得区块数=${noCodeBlockAfterCount}`);
            await page.close();
        }

        // ══════════════════════════════════════════════════════════════════
        // T5：理由长度码点边界（W1 遗留 LOW）——中文+emoji 混合串测 300/301，证明按码点计数
        // ══════════════════════════════════════════════════════════════════
        {
            // 300 码点：应成功提交（真实撤回一个独立夹具）。
            {
                const id = await mkFixtureVerify(adminTok, devTok);
                const reason300 = makeReasonOfCodepoints(300);
                must([...reason300].length === 300 && reason300.length > 300, `T5 前置：reason300 码点数=300 且 UTF-16 长度=${reason300.length}（应 >300，证明含代理对 emoji）`);
                const page = await loginPage(browser, devTok);
                let withdrawReqCount = 0, lastStatus = null;
                page.on('response', async (resp) => {
                    if (/\/submit\/withdraw$/.test(new URL(resp.url()).pathname)) { withdrawReqCount++; lastStatus = resp.status(); }
                });
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                await page.click('#siDActions button:has-text("撤回提交")');
                await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                const instanceAtOpen = await currentModalInstance(page);
                await page.fill('#f_reason', reason300);
                await markExistingToasts(page);
                await page.click('#siMConfirm');
                await waitForModalSettle(page, instanceAtOpen);
                must(withdrawReqCount === 1 && lastStatus === 200, `T5-300 码点理由应被前端放行并请求成功，实得 请求数=${withdrawReqCount} status=${lastStatus}`);
                await page.close();
            }
            // 301 码点：应被前端拦截，不发请求（settle 后再检查，不靠固定等待）。
            {
                const id = await mkFixtureVerify(adminTok, devTok);
                const reason301 = makeReasonOfCodepoints(301);
                must([...reason301].length === 301, `T5 前置：reason301 码点数应为 301，实得=${[...reason301].length}`);
                const page = await loginPage(browser, devTok);
                let withdrawReqCount = 0;
                page.on('request', (r) => { if (/\/submit\/withdraw$/.test(new URL(r.url()).pathname)) withdrawReqCount++; });
                await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${id}`);
                await page.waitForLoadState('networkidle');
                await page.waitForTimeout(500);
                await page.click('#siDActions button:has-text("撤回提交")');
                await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
                const instanceAtOpen = await currentModalInstance(page);
                await page.fill('#f_reason', reason301);
                await markExistingToasts(page);
                await page.click('#siMConfirm');
                await waitForModalSettle(page, instanceAtOpen);
                must(withdrawReqCount === 0, `T5-301 码点理由应被前端拦截，不应发出请求，实得请求数=${withdrawReqCount}`);
                const toastT5 = await newToastText(page);
                must(toastT5.includes('过长'), `T5-301 应提示理由过长，实得="${toastT5}"`);
                const rowT5 = await dbGet(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, DEV_ID]);
                must(rowT5 && rowT5.dev_status === 'code_submitted', 'T5-301 前端拦截后不应触碰库——本人 dev_status 仍为 code_submitted');
                await page.close();
            }
        }

        console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
        if (fail > 0) { console.log('失败项：'); failDetails.forEach(m => console.log('  - ' + m)); }
    } finally {
        await browser.close();
        for (const id of createdIds) { try { await deleteIssueFully(id); } catch (e) { console.error(`清理 issue=${id} 失败：${e.message}`); } }
        db.close();
    }
    process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('测试运行异常：', e); process.exit(1); });
