/**
 * 附件融入各模块 — Playwright 端到端冒烟（用户 2026-07-19）
 * 用法：本地 server(3000) 已启动后 node scripts/test-att-inline-playwright.js
 *
 * 改造：取消独立「附件」区，需求材料(spec)融入「基本信息」、交付物+截图合并为「开发交付」区。
 *   展示对齐数据协作：图片=缩略图(点击放大)/非图片=图标+文件名(点击下载)/无=「-」。上传走弹窗·权限不变。
 * 测点：
 *   T1 无附件：基本信息含「需求材料」行显「-」+「开发交付」区含「交付物/补充截图」各显「-」
 *   T2 无独立「附件」区（旧区已删）
 *   T3 admin 上传 spec 图片 → 基本信息「需求材料」显缩略图（img.si-att-thumb 异步 authFetch 填 src）
 *   T4 点击缩略图 → lightbox 放大（siImgLightbox.show）
 *   T5 上传走弹窗（siOpenUploadModal·「＋ 上传需求材料」按钮 → siModal）
 *   T6 控制台无 JS 报错
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
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
async function api(tok, m, u, b) { const r = await fetch(BASE + u, { method: m, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; } return { status: r.status, j }; }
let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

// 生成一个最小合法 PNG（1x1 红点）供上传
function writeTinyPng(p) {
  const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(p, b);
}

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
async function openDrawer(page, id) { await page.evaluate(i => siOpenDrawer(i), id); await page.waitForTimeout(700); }
async function sectionByTitle(page, title) {
  return page.evaluate(t => {
    const secs = [...document.querySelectorAll('.u-detail-section')];
    const s = secs.find(x => { const h = x.querySelector('h3'); return h && h.innerText.trim() === t; });
    return s ? s.innerHTML : null;
  }, title);
}

let issueId = null;
const tmpPng = path.join(os.tmpdir(), 'si_att_test_' + Date.now() + '.png');
async function main() {
  const adminTok = await sign(ADMIN);
  console.log('\n══════ 附件融入各模块 端到端冒烟 ══════');
  writeTinyPng(tmpPng);

  // 造数：变更流单（admin=协调人·可传 spec；非终态）
  const c = await api(adminTok, 'POST', '/api/sys-issues', { type: 'feature', title: '附件融入冒烟单', system_name: '智数协同', source: '内部', description: '测试描述' });
  if (c.status !== 200 && c.status !== 201) { console.error('建单失败', c.status, c.j); process.exit(1); }
  issueId = c.j.id;
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    // ===== T1/T2 无附件态 =====
    const p1 = await gotoAs(browser, adminTok);
    await openDrawer(p1, issueId);
    const info1 = await sectionByTitle(p1, '基本信息');
    must(info1 && /需求材料/.test(info1), `T1a 基本信息含「需求材料」行`);
    must(info1 && />-<\/div>|>-<\/span>|>-</.test(info1.replace(/\s/g, '')), `T1b 无 spec 时需求材料显「-」`);
    const deliv1 = await sectionByTitle(p1, '开发交付');
    must(deliv1 !== null, `T1c 存在「开发交付」区`);
    must(deliv1 && /交付物/.test(deliv1) && /补充截图/.test(deliv1), `T1d 开发交付区含「交付物」「补充截图」两小组`);
    const hasOldAtt = await sectionByTitle(p1, '附件');
    must(hasOldAtt === null, `T2 无独立「附件」区（旧区已删）`);
    // T5 上传走弹窗
    must(info1 && /＋ 上传需求材料/.test(info1), `T5a 需求材料含「＋ 上传需求材料」按钮（admin=协调人）`);
    allErrs = allErrs.concat(p1._errs);
    await p1.close();

    // ===== T3/T4 上传 spec 图片 → 缩略图 + lightbox =====
    const p2 = await gotoAs(browser, adminTok);
    await openDrawer(p2, issueId);
    // 点「＋ 上传需求材料」→ 弹窗 → 选文件 → 上传
    await p2.evaluate(id => siOpenUploadModal(id, 'spec', '需求材料'), issueId);
    await p2.waitForTimeout(400);
    const modalInput = await p2.$('#siPickerInput_modal-spec');
    must(!!modalInput, `T5b 上传弹窗含文件选择组件（弹窗式）`);
    await modalInput.setInputFiles([tmpPng]);
    await p2.waitForTimeout(400);
    const [upResp] = await Promise.all([
      p2.waitForResponse(r => /\/attachments/.test(r.url()) && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
      p2.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),
    ]);
    must(upResp && upResp.status() === 200, `T3a spec 图片上传 → 200（实际 ${upResp && upResp.status()}）`);
    await p2.waitForTimeout(1200);   // 等详情重渲 + 缩略图异步 authFetch 填 src
    // 缩略图 img 存在且 src 已填（objectURL blob）
    const thumb = await p2.evaluate(() => {
      const secs = [...document.querySelectorAll('.u-detail-section')];
      const info = secs.find(x => { const h = x.querySelector('h3'); return h && h.innerText.trim() === '基本信息'; });
      if (!info) return { found: false };
      const img = info.querySelector('img.si-att-thumb');
      return { found: !!img, srcFilled: !!(img && img.src && img.src.startsWith('blob:')), clickable: !!(img && img.classList.contains('si-clickable-thumb')) };
    });
    must(thumb.found, `T3b 基本信息需求材料含缩略图 img.si-att-thumb`);
    must(thumb.srcFilled, `T3c 缩略图 src 已异步填充 blob objectURL（authFetch 鉴权成功）`);
    must(thumb.clickable, `T3d 缩略图含 si-clickable-thumb（可点击放大）`);
    // T4 点击缩略图 → lightbox
    await p2.evaluate(() => {
      const secs = [...document.querySelectorAll('.u-detail-section')];
      const info = secs.find(x => { const h = x.querySelector('h3'); return h && h.innerText.trim() === '基本信息'; });
      const img = info.querySelector('img.si-att-thumb');
      if (img) img.click();
    });
    await p2.waitForTimeout(400);
    const lbShown = await p2.evaluate(() => { const lb = document.getElementById('siImgLightbox'); return !!(lb && lb.classList.contains('show')); });
    must(lbShown, `T4 点击缩略图 → lightbox 放大（siImgLightbox.show）`);
    allErrs = allErrs.concat(p2._errs);
    await p2.close();

    must(allErrs.length === 0, `T6 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    await browser.close();
    try { fs.unlinkSync(tmpPng); } catch (_) {}
    if (issueId) { const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`); console.log(`  · 清理测试单 #${issueId}（${d.status}）`); }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 附件融入各模块 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('附件融入冒烟异常:', e); process.exit(1); });
