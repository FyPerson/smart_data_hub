/**
 * 三模块「查询已读」未读态展示统一 前端 Playwright 实测（2026-07-13）
 *
 * 用法：node scripts/test-notify-read-unify-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
 *
 * 用真实页面函数 + route mock 验证：
 *   [数据修正] ★核心 bug：buildNotifyRow 结果框独立后，查询未读不再覆盖通知时间+按钮
 *   [需求跟踪] 查询按钮常驻（不被结果替换）+ 未读去 label + 无"重查"按钮 + M-3 recipient_unresolved 分支
 *   [数据协作] 未读文案去收件人名
 */
'use strict';
const { chromium } = require('playwright');
const fx = require('./_test-fixture');
const BASE = fx.BASE;
let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

async function newPage(browser, token, url) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(url, { waitUntil: 'load' });
  return { ctx, page };
}

(async () => {
  const token = await fx.signAs(fx.ADMIN_ID);
  const browser = await chromium.launch();

  // ===== 1. 数据修正（核心 bug）=====
  console.log('\n[数据修正] 查询已读未读态不覆盖通知时间+按钮');
  {
    const { ctx, page } = await newPage(browser, token, `${BASE}/Data_Correction.html`);
    await page.waitForFunction(() => typeof buildNotifyRow === 'function', { timeout: 8000 });
    const r = await page.evaluate(() => {
      const t = { key: 'dev', label: '开发通知', recipient: '测试收件人', cid: 999999, canSend: true, sendable: ['ASSIGNED_PENDING_ESTIMATE'], status: 'sent', notifiedAt: '2026-07-13 10:00:00', readAt: null, byPhone: false, noPhone: false };
      const c = document.createElement('div'); c.innerHTML = buildNotifyRow(t, 'ASSIGNED_PENDING_ESTIMATE'); document.body.appendChild(c);
      const box = c.querySelector('#corrReadBox_dev'); const body = box.closest('.u-nr-body');
      const before = { boxIsSpan: box.tagName === 'SPAN' && box.classList.contains('u-nr-read-result'), bodyNoId: !body.id, notifyTime: body.textContent.includes('已于'), btns: body.querySelectorAll('button').length };
      box.innerHTML = '<span style="color:#d97706">👀 尚未读取</span>'; // 模拟 queryReadStatus 未读分支
      const after = { notifyTime: body.textContent.includes('已于'), btns: body.querySelectorAll('button').length, unread: body.textContent.includes('尚未读取') };
      return { before, after };
    });
    expect(r.before.boxIsSpan, 'box 是独立 .u-nr-read-result span（不再是 u-nr-body）');
    expect(r.before.bodyNoId, 'u-nr-body 不再带 id');
    expect(r.before.notifyTime && r.before.btns === 2, `未读前：通知时间在 + 2 按钮（查询已读/重新通知），实=${r.before.btns}`);
    expect(r.after.notifyTime, '★查询未读后：通知时间保留（不被覆盖）');
    expect(r.after.btns === 2, `★查询未读后：2 按钮保留，实=${r.after.btns}`);
    expect(r.after.unread, '查询未读后：追加显示 尚未读取');
    await ctx.close();
  }

  // ===== 2. 需求跟踪 =====
  console.log('\n[需求跟踪] 查询按钮常驻 + 未读/未解析分支');
  {
    const { ctx, page } = await newPage(browser, token, `${BASE}/Issue_Tracker.html`);
    await page.waitForFunction(() => typeof checkIssueReadStatus === 'function', { timeout: 8000 });
    await page.route('**/api/issues/*/notify-read-status*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recipient: 'issue_developer', read: false }) }));
    const r1 = await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', `<div id="tw1"><button id="tb1" onclick="checkIssueReadStatus(888,'issue_developer')">查询开发已读</button><span id="readStatusBox_888_issue_developer" class="issue-read-result"></span></div>`);
      await checkIssueReadStatus(888, 'issue_developer');
      const box = document.getElementById('readStatusBox_888_issue_developer');
      return { btnStays: !!document.getElementById('tb1'), unread: box.textContent.includes('尚未读取'), noLabel: !box.textContent.includes('开发尚未读取'), noRecheck: !document.getElementById('tw1').textContent.includes('重查') };
    });
    expect(r1.btnStays, '未读后：查询按钮常驻（未被结果替换）');
    expect(r1.unread, '未读后：结果 span 显示 尚未读取');
    expect(r1.noLabel, '未读文案去 label（不是"开发尚未读取"）');
    expect(r1.noRecheck, '未读态无"重查"按钮（查询按钮已常驻）');
    await page.unroute('**/api/issues/*/notify-read-status*');
    await page.route('**/api/issues/*/notify-read-status*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recipient: 'issue_developer', read: false, read_status: 'recipient_unresolved' }) }));
    const r2 = await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', `<div id="tw2"><button onclick="checkIssueReadStatus(889,'issue_developer')">查询</button><span id="readStatusBox_889_issue_developer" class="issue-read-result"></span></div>`);
      await checkIssueReadStatus(889, 'issue_developer');
      return document.getElementById('readStatusBox_889_issue_developer').textContent;
    });
    expect(r2.includes('未解析'), `★M-3：recipient_unresolved 显示"收件人钉钉号未解析"，实=${r2}`);
    await ctx.close();
  }

  // ===== 3. 数据协作 =====
  console.log('\n[数据协作] 未读文案去名');
  {
    const { ctx, page } = await newPage(browser, token, `${BASE}/Data_Collab.html`);
    await page.waitForFunction(() => typeof checkReadStatus === 'function', { timeout: 8000 });
    await page.route('**/api/collab/requests/*/notify-read-status*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ read: false, recipient_name: '张三' }) }));
    const r = await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', `<span id="readStatusBox_developer"></span>`);
      await checkReadStatus(999, 'developer');
      return document.getElementById('readStatusBox_developer').textContent;
    });
    expect(r.includes('尚未读取') && !r.includes('张三'), `未读文案去名（不含收件人名），实=${r}`);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n=== PASS ${pass} / FAIL ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
