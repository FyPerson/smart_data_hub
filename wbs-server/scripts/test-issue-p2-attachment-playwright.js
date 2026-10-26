/**
 * P2（附件组件通用化 + 提交弹窗附件顺带传）— Playwright 冒烟
 * 用法：node scripts/test-issue-p2-attachment-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   ⚠️ 已知既有红：建单缺 intake_contract_version（本脚本建 sys-issues 单时没带，服务端返回 400 CLIENT_CONTRACT_OUTDATED，见 routes/sys-iteration/index.js:7354-7361），
 *   且估时写死过去日期 2026-08-01（:93），登记 PROJECT_STATUS，契约修复另起小提交；本次迁移只改环境层，不修业务契约。
 *   收口批：建单助手同时校验状态码与正整数编号，红的表现变为「建单失败」抛错退 1（原来 issueId 为空、B 段后续断言失败）；夹具标题带运行标记 RUN_TAG（[p2-<pid>-<时间戳>]），清理先按标记补查。
 *   造数（建单修好之后）：经 API 建 1 张 sys-issues 单（标题 P2冒烟单）+ 3 个临时 PNG（os.tmpdir() 下 mkdtempSync 建的私有目录 p2-attach-*，收尾整目录删、删失败计失败）；收尾 DELETE 看状态码（200 / 404 算清掉，2 轮间隔 200ms）。
 *
 * 测点：
 *   A 建单不回归：建单弹窗 create-spec 组件选文件→预览→删除→追加（通用化后仍工作）
 *   B 抽屉三块：开发中单 spec/delivery/screenshot 三块用 C1 同款组件（选→预览→上传→附件区出现）
 *   C 提交顺带传：提交弹窗选佐证附件→标记完成→delivery 落库（附件区出现）
 *   D 控制台无 JS 报错
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
let RUN_TAG = null;   // [#106 S4d-2 收口批] ready() 之后赋值：[p2-<pid>-<时间戳>]，夹具标题带它；建单后客户端没拿到编号时，清理按标记补查
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
async function api(tok, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; }
  return { status: r.status, j };
}
let pass = 0, fail = 0;
function must(c, m) { if (c) { console.log('  ✅ ' + m); pass++; } else { console.log('  ❌ ' + m); fail++; } }

// 造一个内存图片文件（1x1 PNG）供 setInputFiles 用
// [#106 S4d-2] 顶层只放纯声明（守卫 R5 / R6）：Buffer.from 挪进 tmpPng
// [#106 S4d-2 送审前小修] 临时 PNG 放进 mkdtempSync 建的私有目录（不再用 os.tmpdir() 下的固定文件名：两个工作树同时跑时先结束的一方会删掉另一方正在用的文件），收尾整目录删（见 removeTmpFiles）
const PNG_1x1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let tmpDir = null;   // 私有临时目录：第一次 tmpPng 时建，removeTmpFiles 删净才置空
function tmpPng(name) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-attach-'));   // 先赋值再写文件：写一半失败，目录也由收尾删
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, Buffer.from(PNG_1x1_B64, 'base64'));
  return p;
}
/** 删目录树：逐项 lstat，链接只删链接本身不进入，文件 unlink、目录递归后 rmdir（不用 fs.rmSync：Node v24 对含中文路径静默不删）；目录不存在视为已清；删后 lstat 确认，仍存在则抛错（调用方计失败）。写法同 verify-collab-multifile-datascope.js 的 removeTreeChecked */
function removeTreeChecked(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(dir); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir); else throw e; }
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(dir)) removeTreeChecked(path.join(dir, name));
    fs.rmdirSync(dir);
  } else {
    fs.unlinkSync(dir);
  }
  try { fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  throw new Error(`删除后仍存在：${dir}`);
}
/** 删私有临时目录（含 3 个 PNG）：删净才把 tmpDir 置空；返回仍失败的说明数组（调用方计失败）。原来写出去就不删 */
function removeTmpFiles() {
  const errs = [];
  if (!tmpDir) return errs;
  try { removeTreeChecked(tmpDir); tmpDir = null; } catch (e) { errs.push(`${tmpDir}: ${(e && e.message) || e}`); }
  return errs;
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
  await page.waitForTimeout(700);
  page._errs = errs;
  return page;
}
async function openDrawer(page, id) { await page.evaluate(i => siOpenDrawer(i), id); await page.waitForTimeout(700); }

// [#106 S4d-2 收口批] 建单助手：状态码须为 200 / 201 且编号为正整数，不满足即抛错（原来编号 undefined 会被后面静默忽略）
async function createSysIssue(t, body) {
  const c = await api(t, 'POST', '/api/sys-issues', body);
  const id = c.j && c.j.id;
  if ((c.status !== 200 && c.status !== 201) || !Number.isInteger(id) || id <= 0) throw new Error(`建单失败 ${c.status} ${JSON.stringify(c.j)}`);
  return id;
}

let issueId = null;
let tok = null;   // [#106 S4d-2] 提到模块级，供入口 .catch 里尽力清理用

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
        const d = await api(tok, 'DELETE', `/api/sys-issues/${id}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' });
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
  RUN_TAG = `[p2-${process.pid}-${Date.now()}]`;
  tok = await sign(ADMIN);
  console.log('\n══════ P2 附件组件通用化 + 提交顺带传 冒烟 ══════');

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    const f1 = tmpPng('p2-a.png'), f2 = tmpPng('p2-b.png'), f3 = tmpPng('p2-c.png');   // [#106 S4d-2] 挪进 try：写文件之后的任何失败都由 finally 删它们
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
    // [#106 S4d-2 收口批] 建单助手同时校验状态码与正整数编号（不满足即抛错）；标题带 RUN_TAG，建单后客户端没拿到编号时由 cleanupIssue 按标记补查
    issueId = await createSysIssue(tok, { type: 'feature', title: 'P2冒烟单' + RUN_TAG, system_name: 'BMS', source: '内部', description: 'x', intake_liaison_id: 13 });
    await api(tok, 'POST', `/api/sys-issues/${issueId}/schedule`, { priority: 'P2' });
    await api(tok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: ADMIN });
    await api(tok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: '2026-08-01 10:00' });

    // ===== B 抽屉三块（弹窗式）：详情页三个上传按钮 → 点开弹窗选文件+预览+确认上传 =====
    const pB = await gotoAs(browser, tok);
    await openDrawer(pB, issueId);
    // 详情页附件区应只有三个上传按钮（无内联 input）
    const hasInlineInput = await pB.evaluate(() => !!document.getElementById('siPickerInput_drawer-delivery'));
    must(!hasInlineInput, `B1 详情页附件区无内联 input（改弹窗式·drawer-delivery 组件已移入弹窗）`);
    // 附件融入（2026-07-19）：附件区已取消——需求材料融入基本信息、交付物/截图融入「开发交付」区，故上传按钮
    //   分散在多个 section。codex123 末次审 LOW-2：断言范围收窄到 #siDBody（详情抽屉体），
    //   而非整个 document——否则未来页面新增隐藏弹窗/其他模块同名「上传」按钮时，即使抽屉内漏掉入口断言仍假阳性通过。
    const uploadBtns = await pB.evaluate(() => {
      const body = document.getElementById('siDBody');
      if (!body) return [];
      return [...body.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /上传/.test(t));
    });
    must(uploadBtns.some(t => /上传交付物/.test(t)) && uploadBtns.some(t => /上传需求材料/.test(t)) && uploadBtns.some(t => /上传补充截图/.test(t)),
      `B1b 详情页含三个上传按钮（需求材料/交付物/补充截图·实际=${JSON.stringify(uploadBtns)}）`);
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
    const shotRes = await uploadViaModal('上传补充截图', 'modal-screenshot', f3);
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
    try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
    const fileErrs = removeTmpFiles();
    if (fileErrs.length) must(false, `删除临时 PNG 私有目录失败：${fileErrs.join(' | ')}`);
    const keepId = issueId;
    const cleanupErr = await cleanupIssue();
    if (cleanupErr) must(false, `清理测试单 #${keepId} 失败（已重试 1 轮）：${cleanupErr}`);
  }
  try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 P2 冒烟全部通过\n' : '  🚫 存在失败项\n');
  testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
  console.error('P2 冒烟异常:', e);
  try { await cleanupIssue(); } catch (_) { /* 已在报错路径，尽力清理 */ }
  try { removeTmpFiles(); } catch (_) { /* 已在报错路径，尽力清理 */ }
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
