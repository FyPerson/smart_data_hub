/**
 * test-sys-effort-days-playwright.js — 工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2 前端表单冒烟
 *
 * 循 test-sys-commit-cols-playwright.js 套件范式（直接 SQL 造夹具 + JWT 注入 + login.html 中继跳转 +
 * 外部 server:3000 + 真实 task_pool.db，全程不点击会真实外呼钉钉的按钮——本测试触达的
 * notifyEstimateToCreatorAndRequester 派发点本身也被 isAutoNotifyEnabled 恒 false 短路，不会真发）。
 *
 * 用法：本地 server（3000）已重启到含 C2 后端改动的代码后：
 *   node scripts/test-sys-effort-days-playwright.js
 *
 * 覆盖：
 *   [EF-T1] 可行性评估弹窗出现「工期（人日）」数字输入项，feature 类型带必填星号 + step/min/max=0.5/0.5/365
 *   [EF-T2] 真实点击提交（不绕过 UI），弹窗关闭视为提交成功
 *   [EF-T3] 回显：详情抽屉「工期（人日）」kv 项显示刚提交的值
 *   [EF-T4] 全程无 console error
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
const FIXTURE_TITLE = `EF-工期表单冒烟-${RUN_TAG}`;
let seededIssueId = null;

(async () => {
  let browser;
  try {
    // 动态查真实 active 账号（同 test-sys-commit-cols-playwright.js 惯例，不硬编码 id——本地库账号
    // 集合可能与生产不同，硬编码会让脚本换个环境就跑不动）。
    const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
    if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
    const devUser = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'user' AND status = 'active' ORDER BY id LIMIT 1`);
    if (!devUser) throw new Error('库中无 active 普通用户（role=user），无法造 dev token');
    const devTok = jwt.sign({ id: devUser.id, username: devUser.username, display_name: devUser.display_name, role: devUser.role }, JWT_SECRET, { expiresIn: '1h' });

    // 直接 SQL 造夹具：feature + 开发中 + needs_feasibility=1 + 已指派 devUser（在册·pending）。
    // 不经过建单/受理/指派全链路（本测试焦点在评估弹窗本身，非流转链路——同 mkIssue 系列既有做法）。
    const insIssue = await run(
      `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name,
              needs_feasibility, assigned_to, assigned_to_name, assigned_at, intake_required, oa_number)
       VALUES ('feature', '开发中', ?, 'BMS', '内部', ?, ?, 1, ?, ?, datetime('now','localtime'), 1, '2026080001')`,
      [FIXTURE_TITLE, admin.id, admin.display_name, devUser.id, devUser.display_name]
    );
    seededIssueId = insIssue.lastID;
    await run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
       VALUES (?, ?, ?, 1, 'pending')`,
      [seededIssueId, devUser.id, devUser.display_name]
    );

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    // ⚠️ 预期豁免（精确到具体资源，非泛化忽略，同本项目 allow403/allow400/SI_EXPECTED_CONSOLE_ERR 范式）：
    //   GET /sys-issues/intake-liaisons 是 admin-only 端点（index.js:3011 requireAdmin），前端建单弹窗
    //   缓存逻辑（Sys_Iteration.html:914）在页面初始化时无条件预取一次，与本测试要验证的功能（工期表单）
    //   无关——这是 dev 角色浏览本页面时的既有背景噪音（预先用非 dev 账号验证过：admin 登录同一页面
    //   不会出现此 403），非本次 C2 改动引入的新回归，故按资源 URL 精确豁免，不放宽为忽略全部 error。
    //   [codex 269 号 L-1 精判收口]：仅按 console message 的 URL 字符串匹配还不够精确——万一将来这条
    //   URL 因某种原因返回的不是 403（比如 500/404），豁免逻辑会把一个真实的新故障也悄悄放过。改为
    //   **URL 匹配 + 该 URL 确实收到 403 响应**两个条件同时成立才豁免；且不在事件回调里就地判断（'response'
    //   与 'console' 两个事件的触发顺序不保证谁先到，就地判断可能因为 403 响应事件还没到而漏判），改为
    //   先收集全部原始事件、等交互流程跑完后再统一比对——同时**显式断言这个预期的 403 真的发生过**（若
    //   未来该端点鉴权放宽、403 不再出现，本断言会变红提醒这条豁免规则已经过期，而不是继续静默生效）。
    //   [codex 270 号 L-1 再收口]：① 匹配从"URL 子串正则"改为**路径精确锚定**（new URL().pathname 解析
    //   后与目标路径完全相等）——原正则 /\/sys-issues\/intake-liaisons/ 是子串匹配，理论上会被一个查询串
    //   或路径前缀里恰好带这段文字的其他端点误命中，精确到 pathname 相等才是真正的"就是这一个端点"。
    //   ② 原来只记"该 URL 是否出现过 403"（Set，遇到第一个 403 就记一次，其余状态码信息丢失）——现在
    //   按 URL 记录**该 URL 收到过的全部响应状态码数组**，豁免条件收紧为"这个 URL 命中路径 **且** 它
    //   收到的全部响应都是 403"——如果同一个 URL 这次是 403、下次因为某个偶发原因变成 500，那条 500
    //   不会被豁免规则误吞（任一非 403 状态都会让"全部为 403"这个条件不成立，从而不豁免、正常计入失败）。
    const SI_EXPECTED_403_PATH = '/api/sys-issues/intake-liaisons';
    const statusesByUrl = new Map();   // url -> [status, status, ...]（该 URL 收到过的全部响应状态码）
    page.on('response', r => {
      const u = r.url();
      if (!statusesByUrl.has(u)) statusesByUrl.set(u, []);
      statusesByUrl.get(u).push(r.status());
    });
    function isExpectedIntakeLiaisonsUrl(url) {
      if (!url) return false;
      let pathname;
      try { pathname = new URL(url).pathname; } catch (e) { return false; }
      return pathname === SI_EXPECTED_403_PATH;
    }
    // 该 URL 命中路径 **且** 它收到的全部响应状态码都是 403（数组非空 + every 403）——任一非 403 即不豁免。
    function urlAllResponsesAre403(url) {
      const statuses = statusesByUrl.get(url) || [];
      return statuses.length > 0 && statuses.every(s => s === 403);
    }
    const consoleErrorsRaw = [];   // { text, url }
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const loc = (typeof m.location === 'function') ? m.location() : null;
      consoleErrorsRaw.push({ text: m.text(), url: loc && loc.url });
    });
    page.on('pageerror', e => consoleErrorsRaw.push({ text: 'pageerror: ' + e.message, url: null }));
    page.on('dialog', d => d.accept());

    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => localStorage.setItem('token', t), devTok);
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    must(page.url().includes('Sys_Iteration.html'), '前置：dev 打开系统迭代页（未被鉴权重定向）');

    await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), seededIssueId);
    await page.waitForTimeout(600);
    const titleOk = await page.evaluate(() => {
      const t = document.getElementById('siDTitle');
      return t ? t.textContent : '';
    });
    must(titleOk.includes(`#${seededIssueId}`), `前置：抽屉已切到 #${seededIssueId}（实得标题="${titleOk}"）`);

    // ── [EF-T1] 打开可行性评估弹窗，断言工期字段存在 + feature 必填星号 + step/min/max ──
    await page.click('#siDActions button:has-text("可行性评估")');
    await page.waitForSelector('#f_conclusion', { state: 'visible', timeout: 3000 });
    const effortFieldInfo = await page.evaluate(() => {
      const inp = document.getElementById('f_estimated_effort_days');
      if (!inp) return null;
      const group = inp.closest('.u-form-group');
      const label = group ? group.querySelector('label') : null;
      return {
        present: true,
        type: inp.type,
        step: inp.step,
        min: inp.min,
        max: inp.max,
        hasReqMark: !!(label && label.querySelector('.u-req')),
      };
    });
    must(!!effortFieldInfo && effortFieldInfo.present, '[EF-T1] 可行性评估弹窗出现「工期（人日）」输入框（#f_estimated_effort_days）');
    must(!!effortFieldInfo && effortFieldInfo.type === 'number', `[EF-T1] 工期输入框 type=number，实得 "${effortFieldInfo && effortFieldInfo.type}"`);
    must(!!effortFieldInfo && effortFieldInfo.step === '0.5' && effortFieldInfo.min === '0.5' && effortFieldInfo.max === '365',
      `[EF-T1] 工期输入框 step/min/max=0.5/0.5/365，实得 ${effortFieldInfo && JSON.stringify({ step: effortFieldInfo.step, min: effortFieldInfo.min, max: effortFieldInfo.max })}`);
    must(!!effortFieldInfo && effortFieldInfo.hasReqMark === true, '[EF-T1] feature 类型工期字段带必填星号（.u-req）');

    // ── [EF-T2] 填表并真实点击提交（不绕过 UI）──
    await page.fill('#f_requirement_confirm', 'Playwright 冒烟：已理解需求');
    await page.fill('#f_dev_estimated_at', '2099-12-31T10:00');
    await page.fill('#f_estimated_effort_days', '4.5');
    await page.click('#siMConfirm');
    await page.waitForTimeout(800);
    const modalClosed = await page.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
    must(modalClosed, '[EF-T2] 点击提交后弹窗关闭（onConfirm 返回 true，提交成功）');

    // ── [EF-T3] 回显：详情抽屉「工期（人日）」kv 项显示刚提交的值 ──
    await page.waitForTimeout(400);   // siAfterAction 内 siOpenDrawer 重渲染留出时间
    const kvOf = async (label) => page.evaluate((lbl) => {
      const items = [...document.querySelectorAll('#siDBody .u-kv-item')];
      const item = items.find(el => {
        const l = el.querySelector('label');
        return l && l.textContent.trim() === lbl;
      });
      if (!item) return null;
      const v = item.querySelector('.v');
      return v ? v.textContent.trim() : null;
    }, label);
    const effortKv = await kvOf('工期（人日）');
    must(effortKv === '4.5', `[EF-T3] 详情抽屉「工期（人日）」kv 回显提交值，期望="4.5"，实得="${effortKv}"`);
    // 服务端落库交叉核对（不只信任前端展示层）
    const dbRow = await get('SELECT estimated_effort_days FROM sys_issues WHERE id = ?', [seededIssueId]);
    must(!!dbRow && Number(dbRow.estimated_effort_days) === 4.5, `[EF-T3] 服务端落库 estimated_effort_days=4.5，实得 ${dbRow && dbRow.estimated_effort_days}`);

    // ── [EF-T4] 全程无（非预期）console error ──
    // 先显式断言"预期豁免的前提条件"确实发生过——豁免不是凭空假设，是因为真的观测到了这个 403
    // （且该 URL 收到的**全部**响应都是 403，没有夹杂其他状态码）。
    const expectedUrlsSeen = [...statusesByUrl.keys()].filter(isExpectedIntakeLiaisonsUrl);
    const expected403Occurred = expectedUrlsSeen.some(urlAllResponsesAre403);
    must(expected403Occurred, `[EF-T4 前置] 预期豁免的 intake-liaisons 403 应确实发生过且该 URL 全部响应均为 403（否则豁免规则已过期，需要重新核实），实得该路径下的状态码=${JSON.stringify(expectedUrlsSeen.map(u => ({ url: u, statuses: statusesByUrl.get(u) })))}`);
    // 精判：console error 的 URL 命中路径精确锚定 **且** 该 URL 全部响应均为 403，两者同时成立才豁免；
    // 任一非 403（哪怕只有一次）或未命中路径的，一律计入失败。
    const consoleErrors = consoleErrorsRaw
      .filter(e => !(isExpectedIntakeLiaisonsUrl(e.url) && urlAllResponsesAre403(e.url)))
      .map(e => e.text);
    must(consoleErrors.length === 0, `[EF-T4] 全程无非预期 console error，实得：${JSON.stringify(consoleErrors)}`);

    await ctx.close();
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
    if (seededIssueId) {
      await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [seededIssueId], 'dev_assignees');
      await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [seededIssueId], 'timeline');
      await safeDelete('DELETE FROM sys_issues WHERE id = ?', [seededIssueId], 'issues');
    }
    const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title = ?`, [FIXTURE_TITLE]);
    console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0）`);
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
