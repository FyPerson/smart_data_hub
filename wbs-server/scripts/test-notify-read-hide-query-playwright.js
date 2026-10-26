/**
 * 通知已读态隐藏「查询已读」按钮 — Playwright 冒烟（用户 2026-07-19）
 * 用法：node scripts/test-notify-read-hide-query-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：经 API 建 1 张 sys-issues 单（标题 通知已读隐藏查询冒烟单）并直连实例库改 dev_assignees 通知列；收尾 DELETE 看状态码（200 / 404 算清掉，2 轮间隔 200ms），遗留计失败；入口 .catch 也会尽力清理。
 *   收口批：夹具标题带运行标记 RUN_TAG（[nrh-<pid>-<时间戳>]），清理先按标记补查（建单后客户端没拿到编号也能清到）；建单助手校验状态码与正整数编号，不满足即抛错退 1。
 *   固定值：用户 id 1 admin / 19；intake_liaison_id 13（快照库里须存在对应对接人，首跑核对）。
 *
 * 需求：通知已读后，「查询已读」按钮不再显示（未读时仍显示）。5 类收件人统一（dev/relay/creator/release_executor/requester）。
 * 本冒烟用 dev 侧验证（最易造数）：admin 视角 + 变更流单可发 dev 通知。
 *   T1 未读态：发通知后 read_at 空 → 通知区含「查询已读」按钮
 *   T2 已读态：DB 置 read_at → 重渲染详情 → 通知区无「查询已读」按钮（重新通知按钮不受影响）
 *   T3 控制台无 JS 报错
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB = null;     // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
let RUN_TAG = null;   // [#106 S4d-2 收口批] ready() 之后赋值：[nrh-<pid>-<时间戳>]，夹具标题带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN = 1, DEV_A = 19;

// [#106 S4d-2] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
  });
}
// close 等回调落定，关库错误不丢（语句错误优先）
async function dbGet(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.get(s, p, (e, x) => { d.close((ce) => { const err = e || ce; err ? j(err) : r(x); }); }); });
}
async function dbRun(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.run(s, p, function (e) { const ctx = { lastID: this && this.lastID, changes: this && this.changes }; d.close((ce) => { const err = e || ce; err ? j(err) : r(ctx); }); }); });
}
async function dbAll(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.all(s, p, (e, x) => { d.close((ce) => { const err = e || ce; err ? j(err) : r(x); }); }); });
}
// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function sign(uid) { return testEnv.signToken(uid); }
async function api(tok, m, u, b) { const r = await fetch(BASE + u, { method: m, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; } return { status: r.status, j }; }
// [#106 S4d-2 收口批] 建单助手：状态码须为 200 / 201 且编号为正整数，不满足即抛错（原来编号 undefined 会被后面静默忽略）；服务端已落库而这里没拿到编号的，由 cleanupIssue 按 RUN_TAG 补查
async function createSysIssue(tok, body) {
  const c = await api(tok, 'POST', '/api/sys-issues', body);
  const id = c.j && c.j.id;
  if ((c.status !== 200 && c.status !== 201) || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败 ${c.status} ${JSON.stringify(c.j)}`);
  return id;
}
let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

async function gotoAs(browser, token) {
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 50[0-9]/.test(m.text())) errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}/Sys_Iteration.html`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  page._errs = errs;
  return page;
}
async function openDrawer(page, id) { await page.evaluate(i => siOpenDrawer(i), id); await page.waitForTimeout(600); }
// 取通知区 HTML（含「查询已读」「重新通知」按钮）
async function notifyHtml(page) {
  return page.evaluate(() => {
    const secs = [...document.querySelectorAll('.u-detail-section')];
    const s = secs.find(x => /通知/.test(x.querySelector('h3') ? x.querySelector('h3').innerText : ''));
    return s ? s.innerHTML : '';
  });
}

let issueId = null;
let adminTok = null;   // [#106 S4d-2] 提到模块级，供入口 .catch 里尽力清理用

/**
 * [#106 S4d-2] 清理造的 sys-issues 单：DELETE 看状态码（200 / 404 算清掉），失败再试一轮（共 2 轮，间隔 200ms）；
 * 清掉才把 issueId 置空（入口 .catch 里再调一次是幂等的）；返回 null = 已清，否则返回失败说明。原来不看状态码、抛错会中断收尾
 */
async function cleanupIssue() {
  // [#106 S4d-2 收口批] 待清集合 = 已登记的 issueId ∪ 按运行标记补查到的单（建单请求服务端已落库而客户端没拿到编号的）；补查失败计失败
  const ids = new Set();
  const errs = [];
  if (issueId) ids.add(issueId);
  if (RUN_TAG && DB) {
    try { for (const r of await dbAll(`SELECT id FROM sys_issues WHERE title LIKE '%' || ? || '%'`, [RUN_TAG])) ids.add(r.id); }
    catch (e) { errs.push(`按运行标记补查失败：${(e && e.message) || e}`); }
  }
  for (const id of ids) {
    let ok = false, lastErr = null;
    for (let round = 0; round < 2 && !ok; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, 200));
      try {
        const d = await api(adminTok, 'DELETE', `/api/sys-issues/${id}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' });
        console.log(`  · 清理测试单 #${id}（${d.status}）`);
        // 成功 200（routes/sys-iteration/index.js:14080 `res.json({ ok: true, id })`）/ 不存在 404（:13953）；其余（400 / 409 / 503 / 500）一律算失败
        if (d.status === 200 || d.status === 404) ok = true;
        else lastErr = `HTTP ${d.status} ${JSON.stringify(d.j).slice(0, 120)}`;
      } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    if (ok) { if (id === issueId) issueId = null; }   // 清掉才置空（入口 .catch 里再调一次是幂等的）
    else errs.push(`#${id}: ${lastErr}`);
  }
  return errs.length ? errs.join(' | ') : null;
}

async function main() {
  await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
  BASE = testEnv.env().baseUrl;
  DB = testEnv.env().dbPath;
  RUN_TAG = `[nrh-${process.pid}-${Date.now()}]`;
  adminTok = await sign(ADMIN);
  const devATok = await sign(DEV_A);
  console.log('\n══════ 通知已读态隐藏「查询已读」冒烟 ══════');

  // 造数：变更流单 → schedule → assign 示例用户B → estimate → submit(no_code) → accept → 进「待验证」后 dev 可发通知
  // [#106 S4d-2] 原 process.exit(1) 改 throw：入口 .catch 里 teardown 后以 1 退出
  issueId = await createSysIssue(adminTok, { intake_contract_version: 2, type: 'feature', title: '通知已读隐藏查询冒烟单' + RUN_TAG, system_name: 'BMS', source: '内部', description: 'x', intake_liaison_id: 13 });
  // [C3 sweep 时发现的预置漂移·与本任务无关] 同 test-issue-p4-worknote-playwright.js 的三处修法：
  // schedule 端点已退场改 intake-accept+set-oa-number → assign；硬编码日期已成炸弹改动态未来日期。
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level（否则 400 RISK_LEVEL_REQUIRED）。
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/intake-accept`, { risk_level: '二级' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/set-oa-number`, { oa_number: '2026080002' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: DEV_A });
  const futureEst = (days) => { const d = new Date(Date.now() + days * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00`; };
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: futureEst(30) });
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/submit`, { mode: 'no_code', no_code_reason: '联调无代码', self_tested: true, test_env_deployed: true });
  // 此时进「待验证」——dev 侧 sendable（siNotifyStatusesFor feature developer 含待验证）

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    // admin 发 dev 通知（真钉钉会发·此处仅本地·可能失败但会写 notify_status；改用直接置库更稳）
    // 直接置库模拟「已发送·未读」：dev_assignee notify_status=sent + message_key + read_at=NULL
    const da = await dbGet('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=?', [issueId, DEV_A]);
    await dbRun("UPDATE sys_issue_dev_assignees SET notify_status='sent', notify_message_key='test_key_001', notified_at=datetime('now','localtime'), read_at=NULL WHERE id=?", [da.id]);

    // ===== T1 未读态：有「查询已读」按钮 =====
    const p1 = await gotoAs(browser, adminTok);
    await openDrawer(p1, issueId);
    const h1 = await notifyHtml(p1);
    must(/查询已读/.test(h1), `T1 未读态·通知区含「查询已读」按钮`);
    allErrs = allErrs.concat(p1._errs);
    await p1.close();

    // ===== T2 已读态：DB 置 read_at → 无「查询已读」按钮 =====
    await dbRun("UPDATE sys_issue_dev_assignees SET read_at=datetime('now','localtime') WHERE id=?", [da.id]);
    const p2 = await gotoAs(browser, adminTok);
    await openDrawer(p2, issueId);
    const h2 = await notifyHtml(p2);
    must(/📖 已读/.test(h2), `T2a 已读态·通知区显示「📖 已读」文字`);
    must(!/查询已读/.test(h2), `T2b 已读态·通知区无「查询已读」按钮（已隐藏）`);
    allErrs = allErrs.concat(p2._errs);
    await p2.close();

    must(allErrs.length === 0, `T3 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
    const keepId = issueId;
    const cleanupErr = await cleanupIssue();
    if (cleanupErr) must(false, `清理测试单 #${keepId} 失败（已重试 1 轮）：${cleanupErr}`);
  }
  try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 通知已读态隐藏「查询已读」冒烟全部通过\n' : '  🚫 存在失败项\n');
  testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
  console.error('冒烟异常:', e);
  try { await cleanupIssue(); } catch (_) { /* 已在报错路径，尽力清理 */ }
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
