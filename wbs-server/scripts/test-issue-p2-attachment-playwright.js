/**
 * P2（附件组件通用化 + 提交弹窗附件顺带传）— Playwright 冒烟
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-p2-attachment-playwright.js
 *
 * 测点：
 *   A 建单不回归：建单弹窗 create-spec 组件选文件→预览→删除→追加（通用化后仍工作）
 *   B 抽屉三块：开发中单 spec/delivery/screenshot 三块用 C1 同款组件（选→预览→上传→附件区出现）
 *   C 提交顺带传：提交弹窗选佐证附件→标记完成→delivery 落库（附件区出现）
 *   D 控制台无 JS 报错
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
const ADMIN = 1;

const dbGet = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.get(s, p, (e, x) => { d.close(); e ? j(e) : r(x); }); });
async function sign(uid) { const u = await dbGet('SELECT id,username,display_name,role FROM users WHERE id=?', [uid]); return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, SECRET, { expiresIn: '4h' }); }
async function api(tok, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; }
  return { status: r.status, j };
}
let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

// 造一个内存图片文件（1x1 PNG）供 setInputFiles 用
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function tmpPng(name) { const p = path.join(require('os').tmpdir(), name); require('fs').writeFileSync(p, PNG_1x1); return p; }

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
  const tok = await sign(ADMIN);
  console.log('\n══════ P2 附件组件通用化 + 提交顺带传 冒烟 ══════');
  const f1 = tmpPng('p2-a.png'), f2 = tmpPng('p2-b.png'), f3 = tmpPng('p2-c.png');

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    // ===== A 建单不回归：create-spec 组件 =====
    const pA = await gotoAs(browser, tok);
    await pA.evaluate(() => siOpenCreate());
    await pA.waitForTimeout(500);
    // 建单弹窗 create-spec 隐藏 input
    let specInput = await pA.$('#siPickerInput_create-spec');
    must(!!specInput, `A1 建单弹窗含 create-spec 组件 input（通用化后）`);
    if (specInput) {
      await specInput.setInputFiles([f1, f2]);
      await pA.waitForTimeout(400);
      let previewCnt = await pA.evaluate(() => document.querySelectorAll('#siPreview_create-spec .si-file-item').length);
      must(previewCnt === 2, `A2 选 2 文件→预览 2 项（实际 ${previewCnt}）`);
      // 删一个
      await pA.evaluate(() => { const btn = document.querySelector('#siPreview_create-spec .si-file-rm'); if (btn) btn.click(); });
      await pA.waitForTimeout(300);
      previewCnt = await pA.evaluate(() => document.querySelectorAll('#siPreview_create-spec .si-file-item').length);
      must(previewCnt === 1, `A3 删一个→预览剩 1（实际 ${previewCnt}）`);
      // 追加
      await specInput.setInputFiles([f3]);
      await pA.waitForTimeout(300);
      previewCnt = await pA.evaluate(() => document.querySelectorAll('#siPreview_create-spec .si-file-item').length);
      must(previewCnt === 2, `A4 追加 1 个→预览 2（实际 ${previewCnt}·追加不覆盖）`);
    }
    allErrs = allErrs.concat(pA._errs);
    await pA.close();

    // 造数：开发中单（admin 指派给自己 + estimate·供 B 三块上传 + C 提交）
    const c = await api(tok, 'POST', '/api/sys-issues', { type: 'feature', title: 'P2冒烟单', system_name: '智数协同', source: '内部', description: 'x' });
    issueId = c.j.id;
    await api(tok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });
    await api(tok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: ADMIN });
    await api(tok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: '2026-08-01 10:00' });

    // ===== B 抽屉三块（弹窗式）：详情页三个上传按钮 → 点开弹窗选文件+预览+确认上传 =====
    const pB = await gotoAs(browser, tok);
    await openDrawer(pB, issueId);
    // 详情页附件区应只有三个上传按钮（无内联 input）
    const hasInlineInput = await pB.evaluate(() => !!document.getElementById('siPickerInput_drawer-delivery'));
    must(!hasInlineInput, `B1 详情页附件区无内联 input（改弹窗式·drawer-delivery 组件已移入弹窗）`);
    const uploadBtns = await pB.evaluate(() => {
      const secs = [...document.querySelectorAll('.u-detail-section')];
      const s = secs.find(x => /附件/.test(x.querySelector('h3') ? x.querySelector('h3').textContent : ''));
      if (!s) return [];
      return [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /上传/.test(t));
    });
    must(uploadBtns.some(t => /上传交付物/.test(t)) && uploadBtns.some(t => /上传需求材料/.test(t)) && uploadBtns.some(t => /上传截图/.test(t)),
      `B1b 详情页含三个上传按钮（需求材料/交付物/截图·实际=${JSON.stringify(uploadBtns)}）`);
    // 点「上传交付物」开弹窗
    await pB.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('上传交付物')); if (b) b.click(); });
    await pB.waitForTimeout(500);
    const modalDelInput = await pB.$('#siPickerInput_modal-delivery');
    must(!!modalDelInput, `B2 点上传交付物→弹窗含 modal-delivery 组件 input`);
    if (modalDelInput) {
      await modalDelInput.setInputFiles([f1]);
      await pB.waitForTimeout(400);
      const cnt = await pB.evaluate(() => document.querySelectorAll('#siPreview_modal-delivery .si-file-item').length);
      must(cnt === 1, `B3 弹窗选 1 文件→预览 1（实际 ${cnt}）`);
      // 点弹窗「上传」确认（siMConfirm）
      const [resp] = await Promise.all([
        pB.waitForResponse(r => /\/attachments$/.test(r.url()) && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
        pB.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),
      ]);
      must(resp && resp.status() === 200, `B4 弹窗点上传→200（实际 ${resp && resp.status()}）`);
      await pB.waitForTimeout(700);
    }
    // 附件区出现 delivery 附件
    const detail = await api(tok, 'GET', `/api/sys-issues/${issueId}`);
    const delAtts = (detail.j.attachments || []).filter(a => a.attachment_type === 'delivery');
    must(delAtts.length === 1, `B5 弹窗上传后后端附件区含 1 个 delivery 附件（实际 ${delAtts.length}）`);

    // B6（codex LOW）：spec/screenshot 也各点按钮开弹窗→验 key 正确→真上传→查落库 type 正确（防单点传参拷贝错）。
    //   uploadViaModal：点触发按钮→弹窗出现对应 modal-<type> key input→选文件→点上传→200。
    const uploadViaModal = async (btnText, key, file) => {
      await pB.evaluate((t) => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(t)); if (b) b.click(); }, btnText);
      await pB.waitForTimeout(400);
      const input = await pB.$('#siPickerInput_' + key);
      const keyOk = !!input;
      if (!input) return { keyOk, status: null };
      await input.setInputFiles([file]);
      await pB.waitForTimeout(300);
      const [r] = await Promise.all([
        pB.waitForResponse(x => /\/attachments$/.test(x.url()) && x.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
        pB.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),
      ]);
      await pB.waitForTimeout(600);
      return { keyOk, status: r && r.status() };
    };
    const specRes = await uploadViaModal('上传需求材料', 'modal-spec', f2);
    must(specRes.keyOk, `B6a 点上传需求材料→弹窗含 modal-spec key（防传参错）`);
    must(specRes.status === 200, `B6b spec 弹窗上传→200（实际 ${specRes.status}）`);
    const shotRes = await uploadViaModal('上传截图', 'modal-screenshot', f3);
    must(shotRes.keyOk, `B6c 点上传截图→弹窗含 modal-screenshot key（防传参错）`);
    must(shotRes.status === 200, `B6d screenshot 弹窗上传→200（实际 ${shotRes.status}）`);
    // 查落库 type 正确（spec 归 spec·screenshot 归 screenshot·证明 type 传参没串）
    const detailB6 = await api(tok, 'GET', `/api/sys-issues/${issueId}`);
    const atts = detailB6.j.attachments || [];
    must(atts.filter(a => a.attachment_type === 'spec').length === 1, `B6e 落库含 1 个 spec 附件（type 传参正确）`);
    must(atts.filter(a => a.attachment_type === 'screenshot').length === 1, `B6f 落库含 1 个 screenshot 附件（type 传参正确）`);
    allErrs = allErrs.concat(pB._errs);
    await pB.close();

    // ===== C 提交弹窗附件顺带传 =====
    const pC = await gotoAs(browser, tok);
    await openDrawer(pC, issueId);
    await pC.evaluate(() => siModalSubmit(siDetail.issue));
    await pC.waitForTimeout(500);
    const submitAttInput = await pC.$('#siPickerInput_submit-delivery');
    must(!!submitAttInput, `C1 提交弹窗含佐证附件组件 input`);
    if (submitAttInput) {
      // commit 记录改造 2026-07-19：commit 输入改分组多行·无固定 id，往前端组第一行填 + 触发 oninput 同步状态。
      await pC.evaluate(() => { const inp = document.querySelector('#siSubmitRows-frontend .si-commit-row input[type="text"]'); inp.value = 'r-fe-p2'; inp.dispatchEvent(new Event('input', { bubbles: true })); });
      await submitAttInput.setInputFiles([f2]);
      await pC.waitForTimeout(400);
      const cnt = await pC.evaluate(() => document.querySelectorAll('#siPreview_submit-delivery .si-file-item').length);
      must(cnt === 1, `C2 提交弹窗附件选 1→预览 1（实际 ${cnt}）`);
      // 点确认提交（会先 submit 再顺带传附件·两个请求）
      const [subResp] = await Promise.all([
        pC.waitForResponse(r => /\/submit$/.test(r.url()), { timeout: 8000 }).catch(() => null),
        pC.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),
      ]);
      must(subResp && subResp.status() === 200, `C3 提交→200（实际 ${subResp && subResp.status()}）`);
      await pC.waitForTimeout(1200);   // 等顺带上传完成
    }
    // 附件区 delivery 应变 2（B 传的 1 + C 顺带传的 1）
    const detail2 = await api(tok, 'GET', `/api/sys-issues/${issueId}`);
    const delAtts2 = (detail2.j.attachments || []).filter(a => a.attachment_type === 'delivery');
    must(delAtts2.length === 2, `C4 提交顺带传后 delivery 附件=2（B 的 1+C 的 1·实际 ${delAtts2.length}）`);
    allErrs = allErrs.concat(pC._errs);
    await pC.close();

    must(allErrs.length === 0, `D 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    await browser.close();
    if (issueId) { const d = await api(tok, 'DELETE', `/api/sys-issues/${issueId}`); console.log(`  · 清理测试单 #${issueId}（${d.status}）`); }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 P2 冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('P2 冒烟异常:', e); process.exit(1); });
