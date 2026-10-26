/**
 * 附件融入各模块 — Playwright 端到端冒烟（用户 2026-07-19）
 * 用法：node scripts/test-att-inline-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   ⚠️ 已知既有红：建单缺 intake_contract_version（本脚本建 sys-issues 单时没带，服务端返回 400 CLIENT_CONTRACT_OUTDATED，见 routes/sys-iteration/index.js:7354-7361，
 *   脚本在建单处抛错、退出码非零），登记 PROJECT_STATUS，契约修复另起小提交；本次迁移只改环境层，不修业务契约。
 *   收口批：建单助手同时校验状态码与正整数编号；红的表现 = 「建单失败」抛错退 1；夹具标题带运行标记 RUN_TAG（[att-<pid>-<时间戳>]），清理先按标记补查。
 *   造数（建单修好之后）：经 API 建 1 张 sys-issues 单（标题 附件融入冒烟单）+ 临时 PNG（os.tmpdir()）；收尾 DELETE 看状态码（200 / 404 算清掉，2 轮间隔 200ms），临时文件删失败计失败。
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
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB = null;     // [#106 S4d-2 收口批] ready() 之后赋值：testEnv.env().dbPath（实例库，只用于清理时按运行标记补查）
let RUN_TAG = null;   // [#106 S4d-2 收口批] ready() 之后赋值：[att-<pid>-<时间戳>]，夹具标题带它；建单后客户端没拿到编号时，清理按标记补查
const ADMIN = 1;

// [#106 S4d-2 收口批] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
  });
}
// close 等回调落定，关库错误不丢（语句错误优先）
async function dbAll(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.all(s, p, (e, x) => { d.close((ce) => { const err = e || ce; err ? j(err) : r(x); }); }); });
}

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库（收口批起仅为清理补查按标记开实例库）
async function sign(uid) { return testEnv.signToken(uid); }
async function api(tok, m, u, b) { const r = await fetch(BASE + u, { method: m, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; } return { status: r.status, j }; }
// [#106 S4d-2 收口批] 建单助手：状态码须为 200 / 201 且编号为正整数，不满足即抛错（原来只看状态码，编号 undefined 会被后面静默忽略）
async function createSysIssue(tok, body) {
  const c = await api(tok, 'POST', '/api/sys-issues', body);
  const id = c.j && c.j.id;
  if ((c.status !== 200 && c.status !== 201) || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败 ${c.status} ${JSON.stringify(c.j)}`);
  return id;
}
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
let adminTok = null;   // [#106 S4d-2] 提到模块级，供入口 .catch 里尽力清理用
let tmpPng = null;     // [#106 S4d-2] 顶层只放纯声明（守卫 R5 / R6）：路径在入口 ready() 之后赋值（os.tmpdir() 下）

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
/** 删临时 PNG：不存在算已清；其余失败返回说明（调用方计失败）。原来 `catch (_) {}` 全部吞掉 */
function removeTmpPng() {
  if (!tmpPng) return null;
  try { fs.unlinkSync(tmpPng); } catch (e) { if (!e || e.code !== 'ENOENT') return (e && e.message) || String(e); }
  return null;
}

async function main() {
  await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
  BASE = testEnv.env().baseUrl;
  DB = testEnv.env().dbPath;
  RUN_TAG = `[att-${process.pid}-${Date.now()}]`;
  tmpPng = path.join(os.tmpdir(), 'si_att_test_' + Date.now() + '.png');
  adminTok = await sign(ADMIN);
  console.log('\n══════ 附件融入各模块 端到端冒烟 ══════');

  // 造数：变更流单（admin=协调人·可传 spec；非终态）
  // [#106 S4d-2] 原 process.exit(1) 改 throw：入口 .catch 里 teardown 后以 1 退出（既有红：建单缺 intake_contract_version，原样保留）
  // [#106 S4d-2 收口批] 建单助手同时校验状态码与正整数编号；标题带 RUN_TAG，建单后客户端没拿到编号时由 cleanupIssue 按标记补查
  issueId = await createSysIssue(adminTok, { type: 'feature', title: '附件融入冒烟单' + RUN_TAG, system_name: 'BMS', source: '内部', description: '测试描述', intake_liaison_id: 13 });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    writeTinyPng(tmpPng);   // [#106 S4d-2] 挪进 try：写文件之后的任何失败都由 finally 删它
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
    try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
    const pngErr = removeTmpPng();
    if (pngErr) must(false, `删除临时 PNG 失败 ${tmpPng}：${pngErr}`);
    const keepId = issueId;
    const cleanupErr = await cleanupIssue();
    if (cleanupErr) must(false, `清理测试单 #${keepId} 失败（已重试 1 轮）：${cleanupErr}`);
  }
  try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 附件融入各模块 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
  console.error('附件融入冒烟异常:', e);
  try { await cleanupIssue(); } catch (_) { /* 已在报错路径，尽力清理 */ }
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
