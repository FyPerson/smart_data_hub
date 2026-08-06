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
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

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
let idA = null, idB = null;

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
      function assertNoUnexpectedConsoleErrors(label, allow403) {
        if (allow403) {
          // [codex 276 号审 L-1] some→every：statusesByUrl 按**完整 URL**（含查询串）分组，isExpected403Url
          //   只判 pathname——若该 pathname 曾以多个不同查询串出现（多条不同的完整 URL key），some() 只要
          //   其中一条全 403 就判"前提自洽"，会放过**另一条**掺了非 403 状态码的 URL（真实异常被漏判）。
          //   改 every()：命中该 pathname 的**每一条**完整 URL 都必须自身全 403，逐一断言，不留漏网之鱼。
          const expectedUrlsSeen = [...statusesByUrl.keys()].filter(isExpected403Url);
          const expected403Occurred = expectedUrlsSeen.length === 0 || expectedUrlsSeen.every(urlAllResponsesAre403);
          must(expected403Occurred, `[LT-T7 前置·${label}] intake-liaisons 豁免前提自洽（未出现或全部匹配 URL 逐一均为403），实得=${JSON.stringify(expectedUrlsSeen.map(u => ({ url: u, statuses: statusesByUrl.get(u), allAre403: urlAllResponsesAre403(u) })))}`);
        }
        const consoleErrors = consoleErrorsRaw
          .filter(e => !(allow403 && isExpected403Url(e.url) && urlAllResponsesAre403(e.url)))
          .map(e => e.text);
        must(consoleErrors.length === 0, `[LT-T7·${label}] 全程无非预期 console error，实得：${JSON.stringify(consoleErrors)}`);
      }
      return { assertNoUnexpectedConsoleErrors };
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
      const btn = notifyRow ? [...notifyRow.querySelectorAll('button')].find(b => /发送通知|重发/.test(b.textContent)) : null;
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
    must(t8a.toastText.includes('留痕失败'), `[LT-T8a] toast 显示留痕失败警示，实得="${t8a.toastText}"`);
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
    must(!!d2.rowText && d2.rowText.includes('（演练）'), `[LT-D2] ⭐ N1+R8 采纳：dry-run 已发送记录（message_key=dryrun-前缀）行内出现「（演练）」标记，实得="${d2.rowText}"`);

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

    // ── [LT-T7] 全程无非预期 console error（liaison 段，含 idB 自指切换）──────
    trackLiaison.assertNoUnexpectedConsoleErrors('liaison', true);   // 示例对接人非 admin，同样会背景触发 intake-liaisons 403
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
    for (const id of [idA, idB]) {
      if (!id) continue;
      await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id], 'dev_assignees#' + id);
      await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id], 'timeline#' + id);
      await safeDelete('DELETE FROM sys_issues WHERE id = ?', [id], 'issues#' + id);
    }
    const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title IN (?, ?)`, [TITLE_A, TITLE_B]);
    console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0：#${idA}, #${idB}）`);
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
