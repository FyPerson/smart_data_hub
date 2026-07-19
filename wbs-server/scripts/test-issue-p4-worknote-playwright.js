/**
 * P4（标记我的开发完成 + 工作说明 work_note）— Playwright 端到端冒烟
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-p4-worknote-playwright.js
 *
 * 测点（读侧全链：前端弹窗→后端落库→详情端补查→前端展示）：
 *   P1 按钮改名：操作区提交按钮文案=「标记我的开发完成」（非「提交」）
 *   P2 提交带 work_note → 后端落 payload_json → 详情端 dev_assignees[].work_note 返回 → 成员区「工作说明」块展示
 *   P3 多开发各自 work_note 不覆盖（两 dev 各提交不同说明·成员区各自展示）
 *   P4 弹窗说明含「仅标记你本人的开发项完成」
 *   P5 控制台无 JS 报错
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
const ADMIN = 1, DEV_A = 19, DEV_B = 9;   // 示例用户B / 示例开发B

const dbGet = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.get(s, p, (e, x) => { d.close(); e ? j(e) : r(x); }); });
async function sign(uid) { const u = await dbGet('SELECT id,username,display_name,role FROM users WHERE id=?', [uid]); return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, SECRET, { expiresIn: '4h' }); }
async function api(tok, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; }
  return { status: r.status, j };
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
  await page.waitForTimeout(700);
  page._errs = errs;
  return page;
}
async function openDrawer(page, id) { await page.evaluate(i => siOpenDrawer(i), id); await page.waitForTimeout(700); }

let issueId = null;
async function main() {
  const adminTok = await sign(ADMIN), devATok = await sign(DEV_A), devBTok = await sign(DEV_B);
  console.log('\n══════ P4 标记我的开发完成 + work_note 端到端冒烟 ══════');

  // 造数：变更流单 → schedule → assign 两开发(示例用户B+示例开发B) → 各自回填 estimate
  const c = await api(adminTok, 'POST', '/api/sys-issues', { type: 'feature', title: 'P4冒烟单', system_name: '智数协同', source: '内部', description: 'x' });
  if (c.status !== 200 && c.status !== 201) { console.error('建单失败', c.status, c.j); process.exit(1); }
  issueId = c.j.id;
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: DEV_A, collaborator_ids: [DEV_B] });
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: '2026-08-01 10:00' });
  await api(devBTok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: '2026-08-02 10:00' });

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    // ===== P1 按钮改名（示例用户B视角·开发中态本人有 submit 按钮）=====
    const p1 = await gotoAs(browser, devATok);
    await openDrawer(p1, issueId);
    const actsTxt = await p1.evaluate(() => { const b = document.getElementById('siDActions'); return b ? b.innerText : ''; });
    must(/标记我的开发完成/.test(actsTxt), `P1 操作区按钮文案=「标记我的开发完成」（实际="${actsTxt.replace(/\s+/g, ' ').trim().slice(0, 50)}"）`);
    must(!/(^|\s)提交(\s|$)/.test(actsTxt.replace(/标记我的开发完成/g, '')), `P1b 无裸「提交」按钮（已改名）`);
    allErrs = allErrs.concat(p1._errs);
    await p1.close();

    // ===== P2/P4 示例用户B提交带 work_note =====
    const p2 = await gotoAs(browser, devATok);
    await openDrawer(p2, issueId);
    // 打开提交弹窗
    await p2.evaluate(() => { siModalSubmit(siDetail.issue); });
    await p2.waitForTimeout(500);
    const modalHtml = await p2.evaluate(() => { const m = document.querySelector('.u-modal, .si-modal, [class*="modal"]'); return document.body.innerText; });
    must(/仅标记.*本人.*开发项完成|仅标记你本人/.test(modalHtml), `P4 弹窗含「仅标记你本人的开发项完成」说明`);
    const hasWorkNoteInput = await p2.evaluate(() => !!document.getElementById('siSubmitWorkNote'));
    must(hasWorkNoteInput, `P2a 弹窗含「工作说明」输入框（两模式共用）`);
    // 填 commit + work_note 提交（commit 记录改造 2026-07-19：commit 输入改为「前端组/后端组」分组多行·无固定 id·
    //   往前端组第一行输入，并触发 oninput 同步状态快照）
    await p2.evaluate(() => {
      const inp = document.querySelector('#siSubmitRows-frontend .si-commit-row input[type="text"]');
      inp.value = 'r-fe-001';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('siSubmitWorkNote').value = '示例用户B：重构了登录页组件';
    });
    // 点弹窗确认（siModal 确认按钮）
    const [resp] = await Promise.all([
      p2.waitForResponse(r => /\/submit/.test(r.url()), { timeout: 8000 }).catch(() => null),
      p2.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),   // siModal 确认按钮 id=siMConfirm
    ]);
    must(resp && resp.status() === 200, `P2b 示例用户B提交(带work_note) → 200（实际 ${resp && resp.status()}）`);
    allErrs = allErrs.concat(p2._errs);
    await p2.close();

    // 后端落库核对
    const ev = await dbGet(`SELECT json_extract(payload_json,'$.work_note') AS wn FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [issueId]);
    must(ev && ev.wn === '示例用户B：重构了登录页组件', `P2c 后端 submit 事件 payload_json.work_note 落库正确（实际="${ev && ev.wn}"）`);

    // 详情端补查返回 work_note
    const detail = await api(adminTok, 'GET', `/api/sys-issues/${issueId}`);
    const devA = (detail.j.dev_assignees || []).find(d => Number(d.user_id) === DEV_A);
    must(devA && devA.work_note === '示例用户B：重构了登录页组件', `P2d 详情端 dev_assignees[示例用户B].work_note 回填正确（实际="${devA && devA.work_note}"）`);
    must(devA && !!devA.work_note_submitted_at, `P2e 详情端返回 work_note_submitted_at 时刻`);

    // ===== P3 示例开发B也提交不同 work_note（多开发不覆盖）=====
    const bres = await api(devBTok, 'POST', `/api/sys-issues/${issueId}/submit`, { mode: 'no_code', no_code_reason: '仅联调无代码', work_note: '示例开发B：联调验证通过' });
    must(bres.status === 200, `P3a 示例开发B提交(no_code+work_note) → 200（实际 ${bres.status}）`);
    const detail2 = await api(adminTok, 'GET', `/api/sys-issues/${issueId}`);
    const dA = (detail2.j.dev_assignees || []).find(d => Number(d.user_id) === DEV_A);
    const dB = (detail2.j.dev_assignees || []).find(d => Number(d.user_id) === DEV_B);
    must(dA && dA.work_note === '示例用户B：重构了登录页组件', `P3b 示例用户B work_note 未被示例开发B覆盖`);
    must(dB && dB.work_note === '示例开发B：联调验证通过', `P3c 示例开发B work_note 独立正确`);

    // ===== 成员区展示（admin 视角看两人工作说明块）=====
    const p3 = await gotoAs(browser, adminTok);
    await openDrawer(p3, issueId);
    const memberSecHtml = await p3.evaluate(() => {
      const secs = [...document.querySelectorAll('.u-detail-section')];
      const s = secs.find(x => /开发成员/.test(x.innerText));
      return s ? s.innerHTML : '';
    });
    must(/工作说明/.test(memberSecHtml), `P3d 开发成员区含「工作说明」块`);
    must(/示例用户B：重构了登录页组件/.test(memberSecHtml) && /示例开发B：联调验证通过/.test(memberSecHtml), `P3e 成员区展示两人各自工作说明（不覆盖）`);
    allErrs = allErrs.concat(p3._errs);
    await p3.close();

    must(allErrs.length === 0, `P5 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    await browser.close();
    if (issueId) { const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`); console.log(`  · 清理测试单 #${issueId}（${d.status}）`); }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 P4 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('P4 冒烟异常:', e); process.exit(1); });
