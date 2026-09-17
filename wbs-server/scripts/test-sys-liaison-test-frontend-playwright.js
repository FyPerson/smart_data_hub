/**
 * test-sys-liaison-test-frontend-playwright.js — 工期对接测试与风险等级拆分 方案 v1.1 §7·C4b 前端冒烟
 *
 * 循 test-sys-effort-days-playwright.js / test-sys-commit-cols-playwright.js 套件范式（直接 SQL 造夹具
 * 落态「待对接测试」+ JWT 注入 + login.html 中继跳转 + 外部 server:3000 + 真实 task_pool.db）。
 *
 * ⚠️ 范围收紧（同项目历次 sys playwright 惯例）：本地 task_pool.db 的 dingtalk_app_key/app_secret/
 *   robot_code 三项均已 SET（真实生产凭证）——本脚本**只断言按钮可见性/文案/弹窗行为，不点击任何会触发
 *   notify-liaison-test 真实预占+外呼的「发送通知」按钮**（即便 system_configs.sys_notify_dry_run 已被
 *   本轮 C4b 置 'on'，该开关只保护 notify-liaison-test 一个端点，其余四通道仍会真实外呼——为避免误触其他
 *   通道，本脚本对"发送通知"类按钮统一只验证渲染，不点击）。dry-run 的真实调用行为由
 *   verify-sys-liaison-test.js [11d]（打桩计数断言）独立覆盖。
 *
 * 用法：本地 server（3000）已重启到含 C4b 前后端改动的代码后：
 *   node scripts/test-sys-liaison-test-frontend-playwright.js
 *
 * 覆盖：
 *   [LT-T1] 列表页「待对接测试」状态徽章：class=si-s-liaisontest + 文案精确
 *   [LT-T2] 详情页状态徽章同上 + 通知区出现「对接测试 示例对接人」行
 *   [LT-T3] 开发视角（在册·非受理人·非 admin）：看到「发送通知」按钮；不看到「对接测试通过/打回」两按钮
 *   [LT-T4] 对接人视角（示例对接人·非在册·非 admin）：看到「对接测试通过」+「对接测试打回」两按钮；不看到本单「发送通知」按钮（非在册非admin）
 *   [LT-T5] 自指场景：示例对接人同时在册 → 仍看不到「发送通知」按钮（前端自指硬隐藏，即便他现在也是在册开发）
 *   [LT-T6] 「对接测试打回」弹窗：原因必填拦截（空原因点确定不关弹窗+toast）+ 非空原因真实提交成功（弹窗关闭+落库 开发中）
 *   [LT-T7] 全程无非预期 console error
 *   [LT-T8a] codex 278/279 号审 M-3/H-1：writeback_failed:true ∧ sent_externally:true——route 拦截
 *            接管请求（不触达真实后端/外呼），断言 toast + 通知区行内持续红字警示（「请勿重发」）
 *   [LT-T9]  codex 279 号审 M-2：前端警示跨周期清理——新周期渲染时不复现旧周期的持续性警示
 *   [LT-T8b] codex 279 号审 H-1：writeback_failed:true ∧ sent_externally:false——独立提示「可稍后
 *            重试」，不加入持续警示（不劝阻重发）
 *   [LT-D1] 281 号对抗审 N7 采纳：sending+attempt_started_at=NULL → 按钮不禁用（后端 CAS 视 NULL 为
 *           立即可抢占，前端方向须一致，防永久死按钮；纯渲染断言，不点击）
 *   [LT-D2] 281 号对抗审 N1+R8 采纳：ns='sent'+message_key 以 'dryrun-' 开头 → 行内出现「（演练）」标记
 *   [LT-D3] 281 号对抗审 N1 采纳：ns='sending' 但单据已离开「待对接测试」→ 出现「发送结果未知（单据
 *           已离开测试段）」提示，纯展示不加按钮
 *   [LT-T10] D-L1·2026-09-10 决策记录：对接测试通过版本锁两步采用——对接人弹层打开 → 开发经 API
 *            直调 amend 修正交付内容 → 点「确定」撞真实 409 DELIVERY_CHANGED → 不关弹层、阻断横幅
 *            可见、确认键 disabled → 点「加载最新交付」→ 候选区块含修正后内容 → 点「已查看以上交付，
 *            采用此版本」→ 确认键恢复可点、横幅隐藏 → 再点一次「确定」200 成功，落「待验证」
 *   [LT-T11] codex 542·M1：详情响应缺 delivery_rev（route 拦截删掉该字段）→ 打开「对接测试通过」
 *            弹层点「确定」→ fail-closed 拦截，不发起 liaison-test-pass 请求 + toast「详情版本信息
 *            缺失，请刷新详情后重试」，弹层不关闭
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

let passed = 0, failed = 0;
let fatalError = null;
function must(cond, msg) {
  if (cond) { passed++; console.log('  ✅ ' + msg); return true; }
  failed++; console.log('  ❌ ' + msg); return false;
}

const RUN_TAG = Date.now();
const TITLE_A = `LT-对接测试冒烟A-${RUN_TAG}`;   // 示例对接人非在册（常规场景）
const TITLE_B = `LT-对接测试冒烟B-自指-${RUN_TAG}`;   // 示例对接人同时在册（自指隐藏场景）
const TITLE_C = `LT-对接测试冒烟C-版本锁-${RUN_TAG}`;   // [LT-T10·D-L1] 版本锁两步采用专用
const TITLE_D = `LT-对接测试冒烟D-基准缺失-${RUN_TAG}`;   // [LT-T11·codex 542 M1] 基准 delivery_rev 缺失专用
let idA = null, idB = null, idC = null, idD = null;

// 落态「待对接测试」的最小夹具——直接 SQL 造（同 test-sys-effort-days-playwright.js 惯例，不经过
// 完整 GATE 决策树链路，聚焦本次改动本身：前端徽章/按钮/弹窗）。
async function seedLiaisonTestIssue(title, devUserId, devUserName, extraMembers = []) {
  const ins = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name,
            assigned_to, assigned_to_name, assigned_at, intake_required, oa_number, intake_liaison_id,
            liaison_test_cycle_no, liaison_test_notify_cycle_no, liaison_test_recipient_id, liaison_test_recipient_name,
            liaison_test_notify_status)
     VALUES ('feature', '待对接测试', ?, 'BMS', '内部', ?, '管理员',
             ?, ?, datetime('now','localtime'), 1, '2026080099', 13,
             1, 1, 13, '示例对接人',
             'not_sent')`,
    [title, 1, devUserId, devUserName]
  );
  const id = ins.lastID;
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'code_submitted', datetime('now','localtime'))`,
    [id, devUserId, devUserName]
  );
  for (const m of extraMembers) {
    await run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
       VALUES (?, ?, ?, 0, 'code_submitted', datetime('now','localtime'))`,
      [id, m.id, m.name]
    );
  }
  return id;
}

// [LT-T10·D-L1·2026-09-10 决策记录] seedLiaisonTestIssue 造的花名册行是直连 SQL 插入（无真实 submit
// 事件）——amend 端点的"三源读取"写前不变量要求 dev_status=code_submitted 时必有一条真实 submit/
// no_code 事件行支撑（否则 500「查无 submit/no_code 事件」）。本 helper 在 seedLiaisonTestIssue 基础
// 上额外补一条真实 sys_issue_dev_commits 行 + 一条真实 sys_issue_dev_events(action='submit') 行，仅供
// LT-T10 版本锁两步采用场景使用（该场景需要真调 POST /submit/amend）。
async function seedLiaisonTestIssueWithSubmitEvent(title, devUserId, devUserName) {
  const id = await seedLiaisonTestIssue(title, devUserId, devUserName);
  const daRow = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id, devUserId]);
  const commitIns = await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
     VALUES (?, ?, ?, 'backend', ?, datetime('now','localtime'))`,
    [id, daRow.id, devUserId, `lt-fixture-${id}`]
  );
  await run(
    `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, to_status, operator_id, payload_json, created_at)
     VALUES (?, ?, 'submit', '待对接测试', ?, ?, datetime('now','localtime'))`,
    [id, daRow.id, devUserId, JSON.stringify({ mode: 'commits', commits: [{ commit_id: commitIns.lastID, component: 'backend', commit_ref: `lt-fixture-${id}` }], dev_assignee_id: daRow.id, self_tested: true, test_env_deployed: true })]
  );
  // liaison_test_pass 的①b复查会重新核 isGateEligibleForVerify——除 dev_estimated_at 非空 + needs_
  // feasibility 不为 1 外，feature/improvement 两类型还必须 estimated_effort_days 通过
  // normalizeSysEffortDays 校验（C7 工时评估补全，index.js isGateEligibleForVerify 末段）。
  // seedLiaisonTestIssue 的原始 INSERT 三列全不带，直接调用 liaison-test-pass 会撞 409
  // LIAISON_TEST_PASS_INVARIANT（工期资格未过），故本 helper 额外补齐，仅供 LT-T10 使用。
  await run(`UPDATE sys_issues SET dev_estimated_at = datetime('now','localtime','+7 day'), needs_feasibility = 0, estimated_effort_days = 3 WHERE id = ?`, [id]);
  return { id, daId: daRow.id };
}

(async () => {
  let browser;
  try {
    const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
    if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
    // 开发角色：取一个非 13（示例对接人）的 active user（同 test-sys-effort-days-playwright.js 动态查法）。
    const devUser = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'user' AND status = 'active' AND id != 13 ORDER BY id LIMIT 1`);
    if (!devUser) throw new Error('库中无 active 非示例对接人普通用户，无法造 dev token');
    const liaisonUser = await get(`SELECT id, username, display_name, role FROM users WHERE id = 13 AND status = 'active'`);
    if (!liaisonUser) throw new Error('库中 id=13（示例对接人）不存在或非 active，SYS_INTAKE_LIAISON_IDS 前提不成立');

    const devTok = jwt.sign({ id: devUser.id, username: devUser.username, display_name: devUser.display_name, role: devUser.role }, JWT_SECRET, { expiresIn: '1h' });
    const liaisonTok = jwt.sign({ id: liaisonUser.id, username: liaisonUser.username, display_name: liaisonUser.display_name, role: liaisonUser.role }, JWT_SECRET, { expiresIn: '1h' });
    const adminTok = jwt.sign({ id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });

    idA = await seedLiaisonTestIssue(TITLE_A, devUser.id, devUser.display_name);
    idB = await seedLiaisonTestIssue(TITLE_B, devUser.id, devUser.display_name, [{ id: liaisonUser.id, name: liaisonUser.display_name }]);
    idC = (await seedLiaisonTestIssueWithSubmitEvent(TITLE_C, devUser.id, devUser.display_name)).id;
    idD = (await seedLiaisonTestIssueWithSubmitEvent(TITLE_D, devUser.id, devUser.display_name)).id;

    browser = await chromium.launch({ headless: true });

    // ⚠️ 每个身份用独立 browser context 登录（admin/dev/liaison 三种权限各开一个），console-error 与
    // 403 豁免的记账**按 context 独立**（不像 test-sys-effort-days-playwright.js 那样单 context 用一份
    // 全程共享的 statusesByUrl——那个范式假设"全程只有一个身份"；本文件跨三个身份，admin 对
    // intake-liaisons 的合法 200 与 dev/liaison 的预期 403 若共用同一份 Map，会互相污染"该 URL 是否
    // 全部 403"的判定）。attachTracking(pg) 返回该 context 专属的检查函数，调用方在每个 context 收尾时
    // 立即校验，不拖到脚本最后合并判断。
    const SI_EXPECTED_403_PATH = '/api/sys-issues/intake-liaisons';
    function attachTracking(pg) {
      const statusesByUrl = new Map();
      const consoleErrorsRaw = [];
      pg.on('response', r => { const u = r.url(); if (!statusesByUrl.has(u)) statusesByUrl.set(u, []); statusesByUrl.get(u).push(r.status()); });
      pg.on('console', m => { if (m.type() !== 'error') return; const loc = (typeof m.location === 'function') ? m.location() : null; consoleErrorsRaw.push({ text: m.text(), url: loc && loc.url }); });
      pg.on('pageerror', e => consoleErrorsRaw.push({ text: 'pageerror: ' + e.message, url: null }));
      pg.on('dialog', d => d.accept());
      function isExpected403Url(url) {
        if (!url) return false;
        let pathname;
        try { pathname = new URL(url).pathname; } catch (e) { return false; }
        return pathname === SI_EXPECTED_403_PATH;
      }
      function urlAllResponsesAre403(url) {
        const statuses = statusesByUrl.get(url) || [];
        return statuses.length > 0 && statuses.every(s => s === 403);
      }
      // label：仅用于断言文案区分身份；allow403：该身份是否预期会撞 intake-liaisons 的 403（admin 不会，dev/liaison 会）。
      // extraIgnoreSpec：[codex 542·M3] { text, maxCount }——旧写法按文本子串豁免整段追踪期内**任意
      //   次数**的匹配项，会连带盖住"别的端点也撞了 409"这种真实异常（浏览器"Failed to load
      //   resource...409"这条 console 提示本身不含 URL，无法按端点精确区分）。改为**次数上限豁免**：
      //   只豁免至多 maxCount 次匹配，超出次数的同一文本、或任何不匹配该文本的条目一律不豁免、正常
      //   报错——既不放宽为"允许任意 409"，也不要求逐条按 URL 精确匹配（该文本本身做不到）。调用方
      //   须自行用 page.on('response') 独立核实"这一次 409 确实来自预期的那个端点、且恰好 1 次"
      //   （见 LT-T10 内 acceptStatusesT10/acceptReqCountT10 的独立核验），本函数只管 console 噪音过滤。
      function assertNoUnexpectedConsoleErrors(label, allow403, extraIgnoreSpec) {
        if (allow403) {
          // [codex 276 号审 L-1] some→every：statusesByUrl 按**完整 URL**（含查询串）分组，isExpected403Url
          //   只判 pathname——若该 pathname 曾以多个不同查询串出现（多条不同的完整 URL key），some() 只要
          //   其中一条全 403 就判"前提自洽"，会放过**另一条**掺了非 403 状态码的 URL（真实异常被漏判）。
          //   改 every()：命中该 pathname 的**每一条**完整 URL 都必须自身全 403，逐一断言，不留漏网之鱼。
          const expectedUrlsSeen = [...statusesByUrl.keys()].filter(isExpected403Url);
          const expected403Occurred = expectedUrlsSeen.length === 0 || expectedUrlsSeen.every(urlAllResponsesAre403);
          must(expected403Occurred, `[LT-T7 前置·${label}] intake-liaisons 豁免前提自洽（未出现或全部匹配 URL 逐一均为403），实得=${JSON.stringify(expectedUrlsSeen.map(u => ({ url: u, statuses: statusesByUrl.get(u), allAre403: urlAllResponsesAre403(u) })))}`);
        }
        const consoleErrorsAfter403 = consoleErrorsRaw
          .filter(e => !(allow403 && isExpected403Url(e.url) && urlAllResponsesAre403(e.url)))
          .map(e => e.text);
        let consoleErrors = consoleErrorsAfter403;
        if (extraIgnoreSpec && extraIgnoreSpec.text) {
          let remaining = extraIgnoreSpec.maxCount || 0;
          consoleErrors = [];
          for (const t of consoleErrorsAfter403) {
            if (remaining > 0 && t.includes(extraIgnoreSpec.text)) { remaining--; continue; }
            consoleErrors.push(t);
          }
        }
        must(consoleErrors.length === 0, `[LT-T7·${label}] 全程无非预期 console error，实得：${JSON.stringify(consoleErrors)}`);
      }
      // [codex 542·M3] 供调用方独立核实"某端点的某次 409 确实是预期的那一次"——按完整 URL 从
      //   statusesByUrl 取该 URL 全部响应状态码（不限于 409，暴露真相供调用方自行断言次数/其余状态）。
      function statusesOf(url) { return statusesByUrl.get(url) || []; }
      return { assertNoUnexpectedConsoleErrors, statusesOf };
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const trackAdmin = attachTracking(page);

    // ── 以 admin 打开，验证列表徽章 [LT-T1] ─────────────────────────────
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => localStorage.setItem('token', t), adminTok);
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    must(page.url().includes('Sys_Iteration.html'), '前置：admin 打开系统迭代页（未被鉴权重定向）');

    // 列表按 ID 搜索定位（同项目既有套件搜索框范式：#siSearchInput，防被分页挤到看不见）。
    const searchBox = await page.$('#siSearchInput');
    if (searchBox) { await page.fill('#siSearchInput', String(idA)); await page.waitForTimeout(400); }
    const badgeInfoA = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('#sysIterationListTable tbody tr')];
      const row = rows.find(r => r.textContent.includes('#' + id) || r.querySelector('td') && r.cells[0] && r.cells[0].textContent.trim() === String(id));
      if (!row) return null;
      const badge = row.querySelector('.u-status-badge');
      return badge ? { cls: badge.className, text: badge.textContent.trim() } : null;
    }, idA);
    must(!!badgeInfoA, `[LT-T1] 前置：列表能定位到夹具 #${idA} 所在行`);
    must(!!badgeInfoA && badgeInfoA.cls.includes('si-s-liaisontest'), `[LT-T1] 列表徽章 class 含 si-s-liaisontest，实得="${badgeInfoA && badgeInfoA.cls}"`);
    must(!!badgeInfoA && badgeInfoA.text === '待对接测试', `[LT-T1] 列表徽章文案精确="待对接测试"，实得="${badgeInfoA && badgeInfoA.text}"`);

    // ── [LT-T2] 详情页：状态徽章 + 通知区「对接测试 示例对接人」行 ─────────────
    await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await page.waitForTimeout(600);
    const detailBadge = await page.evaluate(() => {
      const b = document.querySelector('#siDBody .u-status-badge, #siDTitle .u-status-badge, .si-drawer .u-status-badge');
      return b ? { cls: b.className, text: b.textContent.trim() } : null;
    });
    must(!!detailBadge && detailBadge.cls.includes('si-s-liaisontest') && detailBadge.text === '待对接测试',
      `[LT-T2] 详情页状态徽章 class 含 si-s-liaisontest 且文案="待对接测试"，实得=${JSON.stringify(detailBadge)}`);
    const notifyRowText = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#siDBody .u-notify-row')];
      const row = rows.find(r => r.textContent.includes('对接测试'));
      return row ? row.textContent : null;
    });
    must(!!notifyRowText && notifyRowText.includes('示例对接人'), `[LT-T2] 通知区出现「对接测试 示例对接人」行，实得="${notifyRowText}"`);
    trackAdmin.assertNoUnexpectedConsoleErrors('admin', false);   // admin 对 intake-liaisons 是 200，不豁免，须严格零 error
    await ctx.close();

    // ── [LT-T3] 开发视角：看到「发送通知」按钮；不看到 pass/return 两按钮 ──────
    const ctxDev = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageDev = await ctxDev.newPage();
    const trackDev = attachTracking(pageDev);
    await pageDev.goto(`${BASE_URL}/login.html`);
    await pageDev.evaluate((t) => localStorage.setItem('token', t), devTok);
    await pageDev.goto(`${BASE_URL}/Sys_Iteration.html`);
    await pageDev.waitForLoadState('networkidle');
    await pageDev.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageDev.waitForTimeout(600);
    const devView = await pageDev.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const hasNotifyBtn = !!(notifyRow && [...notifyRow.querySelectorAll('button')].some(b => /发送通知|重发/.test(b.textContent)));
      const actionTexts = [...document.querySelectorAll('#siDActions button')].map(b => b.textContent.trim());
      return { hasNotifyBtn, actionTexts };
    });
    must(devView.hasNotifyBtn === true, `[LT-T3] 在册开发（非受理人非admin）看到「发送通知/重发」按钮，实得 hasNotifyBtn=${devView.hasNotifyBtn}`);
    must(!devView.actionTexts.some(t => t.includes('对接测试通过')), `[LT-T3] 开发视角不出现「对接测试通过」按钮，实得动作按钮=${JSON.stringify(devView.actionTexts)}`);
    must(!devView.actionTexts.some(t => t.includes('对接测试打回')), `[LT-T3] 开发视角不出现「对接测试打回」按钮，实得动作按钮=${JSON.stringify(devView.actionTexts)}`);

    // ── [LT-D1] 281 号对抗审 N7 采纳（siLiaisonTestNotifySendingIsStale 的孪生前端断言）：
    //   sending 态但 liaison_test_attempt_started_at=NULL（脏数据/异常场景，理论上不该发生但可能因
    //   历史数据/手工介入出现）——后端 preemptLiaisonTestNotifySend CAS（index.js :11132）把 NULL
    //   视为**立即可抢占**，前端此前 !startedAt 时判定"未超窗"永久禁用按钮，方向与后端相反，会造成
    //   死按钮（真实回归见 Sys_Iteration.html siLiaisonTestNotifySendingIsStale 修复注释）。
    //   本用例只做纯渲染断言，不点击按钮（不触发真实预占/外呼）。
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='d1-null-started', liaison_test_attempt_started_at=NULL WHERE id=?`, [idA]);
    await pageDev.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageDev.waitForTimeout(600);
    const d1 = await pageDev.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      // 〔断言同步·通知统一 S10 改名连带·2026-08-09〕原正则只认 `发送通知|重发`。S10（N3-1·commit 9dbcf98）
      //   把 failed/sending 态的按钮文案由「重发」统一改成「**重试**」（§3.2 三态模板：首发=发送通知 /
      //   sent=重新通知 / failed=重试），本用例的夹具恰是 sending 态 ⇒ 渲染出的按钮写着「重试」，
      //   旧正则匹配不到，`hasBtn:false` 让本组两条断言级联红。
      //   ⚠️ 排查留痕：红的是**选择器老化**，不是行为回归——N7 要的"NULL 视为可立即抢占、按钮不禁用"完好：
      //   siLiaisonTestNotifySendingIsStale(null) 首行 `if (!startedAt) return true` ⇒ 判 stale ⇒ 走 else
      //   分支渲染**可点击**按钮（disabled 分支只在 sending 且未超窗时才走，那支现在显「发送中…」）。
      const btn = notifyRow ? [...notifyRow.querySelectorAll('button')].find(b => /发送通知|重新通知|重试|重发/.test(b.textContent)) : null;
      return { hasBtn: !!btn, disabled: btn ? btn.disabled : null };
    });
    must(d1.hasBtn === true, `[LT-D1] 前置：sending+started_at=NULL 场景仍渲染发送/重发按钮，实得=${JSON.stringify(d1)}`);
    must(d1.disabled === false, `[LT-D1] ⭐ N7 采纳：sending+started_at=NULL 时按钮不应被禁用（后端 CAS 视 NULL 为立即可抢占，:11132，方向须与前端一致）——修复前此断言应为 disabled=true（永久死按钮），实得 disabled=${d1.disabled}`);

    // ── [LT-T8a] codex 278 号审 M-3 + 279 号审 H-1：writeback_failed:true ∧ sent_externally:true 分支 ──
    //   ——toast + 行内持续红字警示（「请勿重发」）。
    // ⚠️ 与本文件头部"不点击真实外呼按钮"的既定政策不冲突：本用例用 Playwright route 拦截彻底接管
    // 这一个请求，真实后端 notify-liaison-test 端点/钉钉外呼**完全不会被触达**（拦截发生在浏览器网络层，
    // 请求根本不会离开浏览器）——测的是前端收到 `writeback_failed:true` 响应后的展示契约本身，与
    // 是否真实外呼无关，不违反该政策的安全意图。
    // 先把库内真实状态直接置成 sending（模拟"确实发生过一次卡在 sending 的回写失败"）——POST 本身被
    // 上面的 route 拦截接管，但点击后 siAfterAction 会发一次**真实** GET 详情请求刷新抽屉，若不预先
    // 把库内状态摆成 sending，前端持续警示的渲染条件（ns==='sending'）不会命中，测的就不是真场景。
    const cycleA = (await get('SELECT liaison_test_cycle_no AS c FROM sys_issues WHERE id=?', [idA])).c;
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='t8a-token', liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [idA]);
    await pageDev.route('**/api/sys-issues/*/notify-liaison-test', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: idA, writeback_failed: true, sent_externally: true, error: '通知可能已发出，但结果回写失败，请勿重复点击发送，请联系管理员核实' }),
      });
    });
    await pageDev.click('.u-notify-row:has-text("对接测试") button');
    await pageDev.waitForTimeout(500);
    const t8a = await pageDev.evaluate(() => {
      const toastEl = document.getElementById('toast-container');
      const toastText = toastEl ? toastEl.textContent : '';
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const warnEl = notifyRow ? notifyRow.nextElementSibling : null;
      return { toastText, warnText: warnEl ? warnEl.textContent : null };
    });
    // 〔断言同步·通知统一 矩阵 T8·A 类删·2026-08-09〕这条 toast **已按 A 类删除**：同一句话由
    //   `siRenderLiaisonTestNotifyRow` 的 siLiaisonTestWritebackFailedIds 分支以**行内驻留红字**承担，
    //   逐字同文案且**持续驻留**（比 3 秒就飘走的 toast 强）。删除前提不是推理——本套件下一条断言
    //   （[LT-T8a] 通知区红字）已实测到 "⚠️ 通知已发出但留痕失败，请勿重发，联系管理员核对" 在场，
    //   即"失败绝不静默"红线由行内那条守住。故本条从"必须有 toast"改为"**必须没有**重复的 toast"，
    //   把 A 类删除的成果反向钉死（将来谁把 toast 加回来＝重复反馈，这里会红）。
    must(!t8a.toastText.includes('留痕失败'),
        `[LT-T8a] 留痕失败 toast 已按矩阵 T8 删除（反馈迁到行内驻留红字·下一条断言实测其在场），实得toast="${t8a.toastText}"`);
    must(!!t8a.warnText && t8a.warnText.includes('请勿重发'), `[LT-T8a] 通知区出现「请勿重发」持续性红字警示（非仅一闪而过的 toast），实得="${t8a.warnText}"`);
    await pageDev.unroute('**/api/sys-issues/*/notify-liaison-test');

    // ── [LT-T9] codex 279 号审 M-2：前端警示跨周期清理——换新周期后旧警示不应复现 ──
    //   模拟"打回重开→重新进入待对接测试"的真实换轮：cycle_no 自增 + 通知列组重置为 not_sent（与
    //   runWGate ⑦ 落库的字段组一致）。旧周期（cycleA）的警示键 `${idA}:${cycleA}` 仍留在 Set 里
    //   （代码故意不主动扫描删除旧键，靠"键不匹配新周期"天然失效），但一旦渲染时状态非 sending，
    //   siRenderLiaisonTestNotifyRow 会顺手把**当前周期**对应的键删掉（这里当前周期是新周期，键本就
    //   不存在，删除是 no-op，行为仍正确）。
    await run(`UPDATE sys_issues SET liaison_test_cycle_no = liaison_test_cycle_no + 1, liaison_test_notify_cycle_no = liaison_test_cycle_no + 1,
                 liaison_test_notify_status='not_sent', liaison_test_attempt_token=NULL, liaison_test_attempt_started_at=NULL,
                 liaison_test_notified_at=NULL, liaison_test_notify_message_key=NULL, liaison_test_notify_error=NULL
               WHERE id=?`, [idA]);
    const cycleA2 = (await get('SELECT liaison_test_cycle_no AS c FROM sys_issues WHERE id=?', [idA])).c;
    must(cycleA2 === cycleA + 1, `[LT-T9] 前置：cycle_no 已自增（${cycleA} → ${cycleA2}）`);
    await pageDev.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageDev.waitForTimeout(600);
    const t9 = await pageDev.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const warnEl = notifyRow ? notifyRow.nextElementSibling : null;
      const warnIsOurs = !!(warnEl && warnEl.className && warnEl.className.indexOf('u-hint') !== -1 && warnEl.textContent.indexOf('留痕失败') !== -1);
      return { warnIsOurs };
    });
    must(t9.warnIsOurs === false, `[LT-T9] ⭐ M-2 跨周期清理：新周期（${cycleA2}）渲染时不应复现旧周期（${cycleA}）的持续性警示，实得 warnIsOurs=${t9.warnIsOurs}`);

    // ── [LT-T8b] codex 279 号审 H-1：writeback_failed:true ∧ sent_externally:false 分支 ──
    //   ——独立提示「可稍后重试」，**不**加入持续警示（不劝阻重发，因为这次确定没送达）。复用 idA 新周期
    //   （cycleA2），同样先把库内状态摆成 sending 模拟"这一轮也卡住了"。
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='t8b-token', liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [idA]);
    await pageDev.route('**/api/sys-issues/*/notify-liaison-test', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: idA, writeback_failed: true, sent_externally: false, error: '通知发送失败，且结果回写也失败，可稍后重试或联系管理员' }),
      });
    });
    await pageDev.click('.u-notify-row:has-text("对接测试") button');
    await pageDev.waitForTimeout(500);
    const t8b = await pageDev.evaluate(() => {
      const toastEl = document.getElementById('toast-container');
      const toastText = toastEl ? toastEl.textContent : '';
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const warnEl = notifyRow ? notifyRow.nextElementSibling : null;
      const warnIsOurs = !!(warnEl && warnEl.className && warnEl.className.indexOf('u-hint') !== -1 && warnEl.textContent.indexOf('留痕失败') !== -1);
      return { toastText, warnIsOurs };
    });
    must(t8b.toastText.includes('可稍后重试'), `[LT-T8b] toast 显示「可稍后重试」独立提示（非「请勿重发」），实得="${t8b.toastText}"`);
    must(t8b.warnIsOurs === false, `[LT-T8b] ⭐ H-1：sent_externally=false 不应出现「请勿重发」持续性警示（明确未投递，不劝阻重发），实得 warnIsOurs=${t8b.warnIsOurs}`);
    await pageDev.unroute('**/api/sys-issues/*/notify-liaison-test');

    // ── [LT-D2] 281 号对抗审 N1+R8 采纳：演练标记——ns='sent' 且 message_key 以 'dryrun-' 开头 → 行内
    //   追加「（演练）」，避免用户把 dry-run 演练态误读成真实已送达钉钉。⚠️ 位置刻意放在 [LT-T8b] 之后：
    //   ns='sent' 时通知行不再渲染任何按钮（可发条件枚举不含 'sent'），而 [LT-T8a]/[LT-T8b] 的点击
    //   靠的是"drawer 未重新整体刷新前，旧 not_sent 渲染仍留在 DOM 里"这一隐含前提——若本用例放在
    //   它们之前触发一次真实 siOpenDrawer 刷新，会把那颗按钮从 DOM 里刷掉，连累后续点击超时
    //   （已实测踩过一次，见交付报告红/绿证据段）。放在最后，不再有后续步骤依赖该行按钮存在。
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sent', liaison_test_notify_message_key='dryrun-${RUN_TAG}', liaison_test_notified_at=datetime('now','localtime') WHERE id=?`, [idA]);
    await pageDev.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageDev.waitForTimeout(600);
    const d2 = await pageDev.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      return { rowText: notifyRow ? notifyRow.textContent : null };
    });
    // 〔断言同步·通知统一 J20/D-1·2026-08-09〕dry-run 后缀全站统一为「（演练·未真实发送）」——
    //   收敛此前三种写法（`（演练）`/`（演练模式，未真实外呼）`/`（未真实发送钉钉）`）。语义不变、更明确，
    //   属**断言该改**。仍断言"行内有 dry-run 标记"这一原意，只把期望串换成统一后的那一个。
    must(!!d2.rowText && d2.rowText.includes('（演练·未真实发送）'), `[LT-D2] ⭐ N1+R8 采纳：dry-run 已发送记录（message_key=dryrun-前缀）行内出现「（演练·未真实发送）」标记（J20 后缀统一），实得="${d2.rowText}"`);

    trackDev.assertNoUnexpectedConsoleErrors('dev', true);   // dev 打开建单弹窗缓存会背景触发 intake-liaisons 403（既有噪音，非本次改动引入）
    await ctxDev.close();

    // ── [LT-T4] 对接人视角（示例对接人·非在册·非admin，用 idA）：看到 pass/return 两按钮；不看到发送通知按钮 ──
    const ctxLiaison = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageLiaison = await ctxLiaison.newPage();
    const trackLiaison = attachTracking(pageLiaison);
    await pageLiaison.goto(`${BASE_URL}/login.html`);
    await pageLiaison.evaluate((t) => localStorage.setItem('token', t), liaisonTok);
    await pageLiaison.goto(`${BASE_URL}/Sys_Iteration.html`);
    await pageLiaison.waitForLoadState('networkidle');
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageLiaison.waitForTimeout(600);
    const liaisonViewA = await pageLiaison.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const hasNotifyBtn = !!(notifyRow && [...notifyRow.querySelectorAll('button')].some(b => /发送通知|重发/.test(b.textContent)));
      const actionTexts = [...document.querySelectorAll('#siDActions button')].map(b => b.textContent.trim());
      return { hasNotifyBtn, actionTexts };
    });
    must(liaisonViewA.actionTexts.some(t => t.includes('对接测试通过')), `[LT-T4] 对接人视角看到「对接测试通过」按钮，实得动作按钮=${JSON.stringify(liaisonViewA.actionTexts)}`);
    must(liaisonViewA.actionTexts.some(t => t.includes('对接测试打回')), `[LT-T4] 对接人视角看到「对接测试打回」按钮，实得动作按钮=${JSON.stringify(liaisonViewA.actionTexts)}`);
    must(liaisonViewA.hasNotifyBtn === false, `[LT-T4] 对接人（非在册非admin）不出现「发送通知」按钮（D19：触发者=在册开发∨admin，受理人本身不在此集合），实得 hasNotifyBtn=${liaisonViewA.hasNotifyBtn}`);

    // ── [LT-T5] 自指场景（idB：示例对接人同时在册）：以示例对接人身份打开 idB，「发送通知」按钮仍应隐藏 ──
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idB);
    await pageLiaison.waitForTimeout(600);
    const liaisonViewB = await pageLiaison.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const hasNotifyBtn = !!(notifyRow && [...notifyRow.querySelectorAll('button')].some(b => /发送通知|重发/.test(b.textContent)));
      return { hasNotifyBtn };
    });
    must(liaisonViewB.hasNotifyBtn === false, `[LT-T5] 自指场景：示例对接人同时在册开发+身为收件人本人 → 前端仍隐藏「发送通知」按钮（自指硬隐藏，即便在册身份满足 D19 触发者授权），实得 hasNotifyBtn=${liaisonViewB.hasNotifyBtn}`);

    // ── [LT-T6] 「对接测试打回」弹窗：空原因拦截 + 非空原因真实提交成功 ──────
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageLiaison.waitForTimeout(600);
    await pageLiaison.click('#siDActions button:has-text("对接测试打回")');
    await pageLiaison.waitForSelector('#siModalOverlay.open textarea[name="reason"], #siModalOverlay.open #f_reason', { timeout: 3000 }).catch(() => {});
    const reasonSelector = await pageLiaison.evaluate(() => {
      const ta = document.querySelector('#siModalOverlay.open textarea');
      return ta ? '#' + ta.id : null;
    });
    must(!!reasonSelector, `[LT-T6] 前置：弹窗内出现原因 textarea，实得 selector=${reasonSelector}`);
    // 空原因点确定——modal 不应关闭（siModalReason 内部校验拦截 + toast，不调用后端）
    await pageLiaison.click('#siMConfirm');
    await pageLiaison.waitForTimeout(500);
    const stillOpenAfterEmpty = await pageLiaison.evaluate(() => document.getElementById('siModalOverlay').classList.contains('open'));
    must(stillOpenAfterEmpty === true, '[LT-T6] 空原因点「确定」→ 弹窗仍打开（前端必填校验拦截，未提交空原因）');
    // 填写原因后真实提交
    if (reasonSelector) await pageLiaison.fill(reasonSelector, 'Playwright 冒烟：模拟测试发现问题');
    await pageLiaison.click('#siMConfirm');
    await pageLiaison.waitForTimeout(800);
    const closedAfterFill = await pageLiaison.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
    must(closedAfterFill === true, '[LT-T6] 填写原因后点「确定」→ 弹窗关闭（提交成功）');
    const rowAfterReturn = await get('SELECT status, return_count FROM sys_issues WHERE id = ?', [idA]);
    must(!!rowAfterReturn && rowAfterReturn.status === '开发中', `[LT-T6] 服务端落库 status=开发中（liaison_test_return 生效），实得="${rowAfterReturn && rowAfterReturn.status}"`);

    // ── [LT-D3] 281 号对抗审 N1 采纳：离态限定提示——ns='sending' 但单据已离开「待对接测试」──
    //   复用 idA：LT-T6 打回后 status 已真实变为「开发中」（非模拟）。纯展示提醒，不新增按钮/不改
    //   按钮显隐逻辑本身（sendable=status==='待对接测试' 早已为 false，本条只验证新增 u-hint 渲染）。
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='d3-stale-away', liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [idA]);
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idA);
    await pageLiaison.waitForTimeout(600);
    const d3 = await pageLiaison.evaluate(() => {
      const notifyRow = [...document.querySelectorAll('#siDBody .u-notify-row')].find(r => r.textContent.includes('对接测试'));
      const hasSendBtn = !!(notifyRow && [...notifyRow.querySelectorAll('button')].some(b => /发送通知|重发/.test(b.textContent)));
      const hintEl = notifyRow ? notifyRow.nextElementSibling : null;
      return { hasSendBtn, hintText: hintEl ? hintEl.textContent : null };
    });
    must(d3.hasSendBtn === false, `[LT-D3] 前置：已离开待对接测试，本就不出现发送/重发按钮（sendable 门未变），实得 hasSendBtn=${d3.hasSendBtn}`);
    must(!!d3.hintText && d3.hintText.includes('发送结果未知（单据已离开测试段）'), `[LT-D3] ⭐ N1 采纳：离态限定提示正确渲染，实得="${d3.hintText}"`);

    // ── [LT-T10·D-L1·2026-09-10 决策记录] 版本锁两步采用 ─────────────────────────────────────
    //   对接人打开「对接测试通过」弹层 → 开发经 API 直调 amend 修正交付内容（顶高 delivery_rev）→
    //   点「确定」撞真实 409 DELIVERY_CHANGED → 不关弹层，阻断横幅可见 + 确认键 disabled → 点「加载
    //   最新交付」→ 候选区块含修正后内容 → 点「已查看以上交付，采用此版本」→ 确认键恢复可点、横幅
    //   隐藏 → 再点一次「确定」应 200 成功，落「待验证」。用独立夹具 idC（seedLiaisonTestIssueWithSubmitEvent，
    //   带真实 submit 事件，满足 amend 端点写前不变量）。
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idC);
    await pageLiaison.waitForTimeout(600);
    await pageLiaison.click('#siDActions button:has-text("对接测试通过")');
    await pageLiaison.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
    const testNoteSelectorT10 = await pageLiaison.evaluate(() => {
      const ta = document.querySelector('#siModalOverlay.open textarea');
      return ta ? '#' + ta.id : null;
    });
    if (testNoteSelectorT10) await pageLiaison.fill(testNoteSelectorT10, 'LT-T10：手工验证通过，测试说明');

    let acceptReqCountT10 = 0;
    const acceptStatusesT10 = [];
    // [codex 542·M3] 独立核实该路径的每次响应体 code——供下方精确断言"409 恰 1 次且 code=DELIVERY_CHANGED"，
    //   不依赖 console error 文本反推。
    const acceptCodesT10 = [];
    const onReqT10 = (req) => { if (req.method() === 'POST' && /\/liaison-test-pass$/.test(new URL(req.url()).pathname)) acceptReqCountT10++; };
    const onRespT10 = (resp) => {
      if (resp.request().method() !== 'POST' || !/\/liaison-test-pass$/.test(new URL(resp.url()).pathname)) return;
      acceptStatusesT10.push(resp.status());
      resp.json().then(j => acceptCodesT10.push(j && j.code)).catch(() => acceptCodesT10.push(undefined));
    };
    pageLiaison.on('request', onReqT10);
    pageLiaison.on('response', onRespT10);

    // 点「确定」前，用 route 拦第一次 liaison-test-pass 请求：放行前让开发本人（devTok）完成一次修正，
    // 制造真实 409（同 accept 侧 T4 手法，仅拦第一次）。
    let routeHitCountT10 = 0, amendBeforePassStatus = null;
    await pageLiaison.route(`**/api/sys-issues/${idC}/liaison-test-pass`, async route => {
      routeHitCountT10++;
      if (routeHitCountT10 === 1) {
        const amendR = await fetch(`${BASE_URL}/api/sys-issues/${idC}/submit/amend`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${devTok}` },
          body: JSON.stringify({ mode: 'no_code', no_code_reason: 'LT-T10：开发在对接人弹层打开期间完成的修正说明' }),
        });
        amendBeforePassStatus = amendR.status;
      }
      await route.continue();
      if (routeHitCountT10 === 1) await pageLiaison.unroute(`**/api/sys-issues/${idC}/liaison-test-pass`);
    });

    await pageLiaison.click('#siMConfirm');   // 首次点击——命中真实 409
    await pageLiaison.waitForTimeout(800);   // 留够时间让 onRespT10 内 resp.json() 异步解析完成

    must(amendBeforePassStatus === 200, `[LT-T10] 竞态注入：开发 amend 在真实 liaison-test-pass 请求放行前应 200 成功，实得=${amendBeforePassStatus}`);
    must(acceptReqCountT10 === 1, `[LT-T10] 首次点击应恰发出 1 次 liaison-test-pass 请求，实得 ${acceptReqCountT10}`);
    must(acceptStatusesT10[0] === 409, `[LT-T10] 首次 liaison-test-pass 应 409 DELIVERY_CHANGED，实得=${acceptStatusesT10[0]}`);
    // [codex 542·M3] 精确核实：这一次 409 确实是预期的那一个（code=DELIVERY_CHANGED），且该路径
    //   目前为止恰好只响应过 1 次——console error 的文本豁免上限（maxCount:1）与这里的事实核验对齐，
    //   不是"凭感觉给个上限"。
    must(acceptCodesT10[0] === 'DELIVERY_CHANGED', `[LT-T10] 首次 409 响应体 code 应为 DELIVERY_CHANGED，实得=${acceptCodesT10[0]}`);
    const liaisonPassUrlT10 = `${BASE_URL}/api/sys-issues/${idC}/liaison-test-pass`;
    const liaisonPassStatusesSoFarT10 = trackLiaison.statusesOf(liaisonPassUrlT10);
    must(liaisonPassStatusesSoFarT10.length === 1 && liaisonPassStatusesSoFarT10[0] === 409, `[LT-T10] 该路径（独立 statusesByUrl 追踪）目前应恰有 1 次响应且为 409，实得=${JSON.stringify(liaisonPassStatusesSoFarT10)}`);

    const overlayStillOpenT10 = await pageLiaison.locator('#siModalOverlay.open').count();
    must(overlayStillOpenT10 === 1, '[LT-T10] 409 后弹层不应关闭');
    const bannerVisibleT10 = await pageLiaison.locator('#siAcceptConflictBanner').isVisible().catch(() => false);
    must(bannerVisibleT10, '[LT-T10] 409 后阻断横幅应可见');
    const confirmDisabledT10 = await pageLiaison.locator('#siMConfirm').isDisabled().catch(() => false);
    must(confirmDisabledT10, '[LT-T10] 冲突态下确认按钮 disabled');

    // 步骤①「加载最新交付」——候选区块应含开发刚修正的内容。
    await pageLiaison.click('#siAcceptLoadLatestBtn');
    await pageLiaison.waitForTimeout(700);
    const candidateTextT10 = await pageLiaison.locator('#siAcceptCandidateBox').innerText().catch(() => '');
    must(candidateTextT10.includes('LT-T10：开发在对接人弹层打开期间完成的修正说明'), `[LT-T10]「加载最新交付」候选区块应含修正后内容，实得片段="${candidateTextT10.slice(0, 200)}"`);
    const confirmStillDisabledT10 = await pageLiaison.locator('#siMConfirm').isDisabled().catch(() => false);
    must(confirmStillDisabledT10, '[LT-T10] 加载完成、尚未点「采用」时确认按钮仍 disabled');

    // 步骤②「已查看以上交付，采用此版本」——确认键恢复可点、横幅隐藏。
    await pageLiaison.click('#siAcceptAdoptBtn');
    await pageLiaison.waitForTimeout(200);
    const confirmEnabledAfterAdoptT10 = await pageLiaison.locator('#siMConfirm').isDisabled().catch(() => true);
    must(confirmEnabledAfterAdoptT10 === false, '[LT-T10] 点「采用此版本」后确认按钮恢复可点');
    const bannerHiddenAfterAdoptT10 = await pageLiaison.locator('#siAcceptConflictBanner').isVisible().catch(() => true);
    must(bannerHiddenAfterAdoptT10 === false, '[LT-T10] 采用后阻断横幅隐藏');

    // 再点一次「确定」——baseline 已被采用为候选 rev，本次应真正成功（200），落「待验证」。
    await pageLiaison.click('#siMConfirm');
    await pageLiaison.waitForTimeout(800);
    must(acceptReqCountT10 === 2, `[LT-T10] 采用后再次点击应发出第 2 次 liaison-test-pass 请求，实得 ${acceptReqCountT10}`);
    must(acceptStatusesT10[1] === 200, `[LT-T10] 第二次 liaison-test-pass 应 200（baseline 已随采用更新），实得=${acceptStatusesT10[1]}`);
    const finalRowT10 = await get('SELECT status FROM sys_issues WHERE id = ?', [idC]);
    must(!!finalRowT10 && finalRowT10.status === '待验证', `[LT-T10] 最终应落「待验证」，实得="${finalRowT10 && finalRowT10.status}"`);

    pageLiaison.off('request', onReqT10);
    pageLiaison.off('response', onRespT10);

    // ── [LT-T11·codex 542 M1] 详情响应缺 delivery_rev → 打开「对接测试通过」弹层点「确定」──────
    //   fail-closed 拦截，不发起 liaison-test-pass 请求 + toast「详情版本信息缺失，请刷新详情后重试」，
    //   弹层不关闭。用独立夹具 idD（同 idC 一样带真实 submit 事件，但本用例根本不会真的提交）。
    await pageLiaison.route(`**/api/sys-issues/${idD}`, async (route) => {
      const resp = await route.fetch();
      const json = await resp.json().catch(() => null);
      if (json && json.issue) delete json.issue.delivery_rev;
      await route.fulfill({ response: resp, json: json || {} });
    });
    await pageLiaison.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), idD);
    await pageLiaison.waitForTimeout(600);

    let passReqCountT11 = 0;
    const onReqT11 = (req) => { if (req.method() === 'POST' && /\/liaison-test-pass$/.test(new URL(req.url()).pathname)) passReqCountT11++; };
    pageLiaison.on('request', onReqT11);

    await pageLiaison.click('#siDActions button:has-text("对接测试通过")');
    await pageLiaison.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
    const testNoteSelectorT11 = await pageLiaison.evaluate(() => {
      const ta = document.querySelector('#siModalOverlay.open textarea');
      return ta ? '#' + ta.id : null;
    });
    if (testNoteSelectorT11) await pageLiaison.fill(testNoteSelectorT11, 'LT-T11：应被 fail-closed 拦截');
    await pageLiaison.evaluate(() => { document.querySelectorAll('#toast-container > *').forEach(el => { el.dataset.pwSeen = '1'; }); });
    await pageLiaison.click('#siMConfirm');
    await pageLiaison.waitForTimeout(500);

    must(passReqCountT11 === 0, `[LT-T11] 详情缺 delivery_rev 时点确定不应发起 liaison-test-pass 请求，实得请求数=${passReqCountT11}`);
    const toastTextT11 = await pageLiaison.evaluate(() => {
      const el = Array.from(document.querySelectorAll('#toast-container > *')).find(n => !n.dataset.pwSeen);
      return el ? el.textContent : '';
    }).catch(() => '');
    must((toastTextT11 || '').includes('详情版本信息缺失，请刷新详情后重试'), `[LT-T11] 应提示"详情版本信息缺失，请刷新详情后重试"，实得="${toastTextT11}"`);
    const overlayStillOpenT11 = await pageLiaison.locator('#siModalOverlay.open').count();
    must(overlayStillOpenT11 === 1, '[LT-T11] 拦截后弹层不应关闭（留给用户刷新详情后重试）');

    pageLiaison.off('request', onReqT11);
    await pageLiaison.unroute(`**/api/sys-issues/${idD}`);
    await pageLiaison.click('#siModalOverlay button:has-text("取消")');

    // ── [LT-T7] 全程无非预期 console error（liaison 段，含 idB 自指切换 + idC 版本锁场景 + idD 基准缺失场景）──
    // [codex 542·M3] 首次 liaison-test-pass 故意撞 409 DELIVERY_CHANGED（被测行为本身，上方已独立核实
    //   code=DELIVERY_CHANGED 且该路径恰响应 1 次）——豁免其网络层 console error 时改按**次数上限 1**
    //   过滤，不再是"这段文本永远不算错"：若追踪期内还有第二条同文本 console error（无论来自哪个
    //   端点），会因超出上限而正常报错，不再被这条豁免连带盖住。
    trackLiaison.assertNoUnexpectedConsoleErrors('liaison', true, { text: 'Failed to load resource: the server responded with a status of 409', maxCount: 1 });   // 示例对接人非 admin，同样会背景触发 intake-liaisons 403
    await ctxLiaison.close();

  } catch (e) {
    fatalError = e;
    failed++;
    console.error('[FATAL]', e && (e.stack || e));
  } finally {
    if (browser) await browser.close();
    const cleanupErrs = [];
    const safeDelete = async (sql, params, step) => {
      try { await run(sql, params); } catch (e) { cleanupErrs.push({ step, message: e && e.message }); }
    };
    for (const id of [idA, idB, idC, idD]) {
      if (!id) continue;
      // [LT-T10] idC 额外带真实 dev_commits/dev_events 行（seedLiaisonTestIssueWithSubmitEvent 所插），
      //   两表均无 issue_id 级联外键（同 index.js dev_commits/dev_events 表定义），须显式清理，否则
      //   残留孤儿行——idA/idB 从未写过这两张表，多出的两条 DELETE 对它们是零命中的安全 no-op。
      await safeDelete('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id], 'dev_commits#' + id);
      await safeDelete('DELETE FROM sys_issue_dev_events WHERE issue_id = ?', [id], 'dev_events#' + id);
      await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id], 'dev_assignees#' + id);
      await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id], 'timeline#' + id);
      await safeDelete('DELETE FROM sys_issues WHERE id = ?', [id], 'issues#' + id);
    }
    const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title IN (?, ?, ?, ?)`, [TITLE_A, TITLE_B, TITLE_C, TITLE_D]);
    console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0：#${idA}, #${idB}, #${idC}, #${idD}）`);
    must(cleanupErrs.length === 0, `夹具清理 SQL 全部无错误，实得 errs=${JSON.stringify(cleanupErrs)}`);
    must(!!left && left.c === 0, `夹具清理后 sys_issues 残留应为 0，实得 ${left ? left.c : '(查询失败)'}`);
    db.close();
    console.log(`\n  合计 ${passed} PASS / ${failed} FAIL${fatalError ? '  ⚠️ FATAL：套件中途抛出未捕获异常，见上方完整堆栈' : ''}`);
    process.exit(failed === 0 && !fatalError ? 0 : 1);
  }
})().catch(e => {
  console.error('[顶层兜底] finally 段或未捕获 rejection：\n', e && (e.stack || e));
  process.exit(1);
});
