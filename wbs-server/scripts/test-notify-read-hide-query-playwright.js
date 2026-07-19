/**
 * 通知已读态隐藏「查询已读」按钮 — Playwright 冒烟（用户 2026-07-19）
 * 用法：本地 server(3000) 已启动后 node scripts/test-notify-read-hide-query-playwright.js
 *
 * 需求：通知已读后，「查询已读」按钮不再显示（未读时仍显示）。5 类收件人统一（dev/relay/creator/release_executor/requester）。
 * 本冒烟用 dev 侧验证（最易造数）：admin 视角 + 变更流单可发 dev 通知。
 *   T1 未读态：发通知后 read_at 空 → 通知区含「查询已读」按钮
 *   T2 已读态：DB 置 read_at → 重渲染详情 → 通知区无「查询已读」按钮（重新通知按钮不受影响）
 *   T3 控制台无 JS 报错
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB = path.join(__dirname, '..', 'task_pool.db');
const SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN = 1, DEV_A = 19;

const dbGet = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.get(s, p, (e, x) => { d.close(); e ? j(e) : r(x); }); });
const dbRun = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.run(s, p, function (e) { d.close(); e ? j(e) : r(this); }); });
async function sign(uid) { const u = await dbGet('SELECT id,username,display_name,role FROM users WHERE id=?', [uid]); return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, SECRET, { expiresIn: '4h' }); }
async function api(tok, m, u, b) { const r = await fetch(BASE + u, { method: m, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; } return { status: r.status, j }; }
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
async function main() {
  const adminTok = await sign(ADMIN), devATok = await sign(DEV_A);
  console.log('\n══════ 通知已读态隐藏「查询已读」冒烟 ══════');

  // 造数：变更流单 → schedule → assign 示例用户B → estimate → submit(no_code) → accept → 进「待验证」后 dev 可发通知
  const c = await api(adminTok, 'POST', '/api/sys-issues', { type: 'feature', title: '通知已读隐藏查询冒烟单', system_name: '智数协同', source: '内部', description: 'x' });
  if (c.status !== 200 && c.status !== 201) { console.error('建单失败', c.status, c.j); process.exit(1); }
  issueId = c.j.id;
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: DEV_A });
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: '2026-08-01 10:00' });
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/submit`, { mode: 'no_code', no_code_reason: '联调无代码' });
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
    await browser.close();
    if (issueId) { const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`); console.log(`  · 清理测试单 #${issueId}（${d.status}）`); }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 通知已读态隐藏「查询已读」冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('冒烟异常:', e); process.exit(1); });
