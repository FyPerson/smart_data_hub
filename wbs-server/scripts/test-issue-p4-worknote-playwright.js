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

// [P5 收口·2026-08-06 协调人指令：原样对齐 test-sys-effort-days-playwright.js 的 C2 硬化版豁免范式]
//   GET /sys-issues/intake-liaisons 是 admin-only 端点（index.js:3019 requireAdmin），dev 角色浏览本页面
//   时的既有背景噪音（前端建单弹窗缓存逻辑在页面初始化时无条件预取一次），与本文件要验证的 work_note/
//   双勾提交功能无关，非本次改动引入的新回归——出处 codex 269/270 号 L-1 两轮收口结论，同款范式照搬：
//   ① pathname 精确锚定（非 URL 子串正则，防误命中）② 按 URL 记录全部响应状态码（非只记"出现过 403"）
//   ③ 豁免条件=该 URL 命中路径 且 它收到的全部响应都是 403（任一非 403 都不豁免）④ 显式断言"预期的
//   403 真的发生过"（若未来该端点鉴权放宽、403 不再出现，本断言会变红提醒豁免规则已过期）。
//   本文件与 effort 脚本的差异：effort 只开一个 page，本文件 p1/p2/p3 三个 page 各自独立（gotoAs 开新页），
//   故 statusesByUrl/consoleErrorsRaw 挂在每个 page 实例上，main() 末尾三页合并后统一判定。
const SI_EXPECTED_403_PATH = '/api/sys-issues/intake-liaisons';
function isExpectedIntakeLiaisonsUrl(url) {
  if (!url) return false;
  let pathname;
  try { pathname = new URL(url).pathname; } catch (e) { return false; }
  return pathname === SI_EXPECTED_403_PATH;
}
function urlAllResponsesAre403(url, statusesByUrl) {
  const statuses = statusesByUrl.get(url) || [];
  return statuses.length > 0 && statuses.every(s => s === 403);
}

async function gotoAs(browser, token) {
  const page = await browser.newPage();
  const statusesByUrl = new Map();   // url -> [status, status, ...]（该 URL 收到过的全部响应状态码）
  page.on('response', r => {
    const u = r.url();
    if (!statusesByUrl.has(u)) statusesByUrl.set(u, []);
    statusesByUrl.get(u).push(r.status());
  });
  const consoleErrorsRaw = [];   // { text, url }（既有 50x 噪音过滤保留，与 403 豁免正交，两条各管各的）
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 50[0-9]/.test(m.text())) return;
    const loc = (typeof m.location === 'function') ? m.location() : null;
    consoleErrorsRaw.push({ text: m.text(), url: loc && loc.url });
  });
  page.on('pageerror', e => consoleErrorsRaw.push({ text: 'pageerror: ' + e.message, url: null }));
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}/Sys_Iteration.html`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  page._statusesByUrl = statusesByUrl;
  page._consoleErrorsRaw = consoleErrorsRaw;
  return page;
}
async function openDrawer(page, id) { await page.evaluate(i => siOpenDrawer(i), id); await page.waitForTimeout(700); }

let issueId = null;
async function main() {
  const adminTok = await sign(ADMIN), devATok = await sign(DEV_A), devBTok = await sign(DEV_B);
  console.log('\n══════ P4 标记我的开发完成 + work_note 端到端冒烟 ══════');

  // 造数：变更流单 → schedule → assign 两开发(示例用户B+示例开发B) → 各自回填 estimate
  const c = await api(adminTok, 'POST', '/api/sys-issues', { intake_contract_version: 2, type: 'feature', title: 'P4冒烟单', system_name: 'BMS', source: '内部', description: 'x', intake_liaison_id: 13 });
  if (c.status !== 200 && c.status !== 201) { console.error('建单失败', c.status, c.j); process.exit(1); }
  issueId = c.j.id;
  // [C3 sweep 时发现的预置漂移·与本任务无关] 本脚本自建成后未跟"受理排期改造"（schedule 端点退场）
  // + OA 号前置校验两轮业务变更同步，按当前所有可跑通脚本的统一范式补齐：intake-accept → set-oa-number
  // → assign（不再走已退场的 schedule）。
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level（否则 400 RISK_LEVEL_REQUIRED）。
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/intake-accept`, { risk_level: '二级' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/set-oa-number`, { oa_number: '2026080001' });
  await api(adminTok, 'POST', `/api/sys-issues/${issueId}/assign`, { assigned_to: DEV_A, collaborator_ids: [DEV_B] });
  // [C3 sweep 时发现的预置漂移·与本任务无关] 原硬编码 '2026-08-0X' 已成日期炸弹（早于当前 assigned_at）
  // → 400 ESTIMATE_BEFORE_ASSIGN，改动态未来日期，同项目其余脚本 futureEst() 范式。
  const futureEst = (days) => { const d = new Date(Date.now() + days * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00`; };
  await api(devATok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: futureEst(30) });
  await api(devBTok, 'POST', `/api/sys-issues/${issueId}/estimate`, { dev_estimated_at: futureEst(31) });

  const browser = await chromium.launch();
  const allPages = [];   // p1/p2/p3 汇总（P5 收口末尾合并各页 statusesByUrl/consoleErrorsRaw 用）
  try {
    // ===== P1 按钮改名（示例用户B视角·开发中态本人有 submit 按钮）=====
    const p1 = await gotoAs(browser, devATok);
    await openDrawer(p1, issueId);
    const actsTxt = await p1.evaluate(() => { const b = document.getElementById('siDActions'); return b ? b.innerText : ''; });
    must(/标记我的开发完成/.test(actsTxt), `P1 操作区按钮文案=「标记我的开发完成」（实际="${actsTxt.replace(/\s+/g, ' ').trim().slice(0, 50)}"）`);
    must(!/(^|\s)提交(\s|$)/.test(actsTxt.replace(/标记我的开发完成/g, '')), `P1b 无裸「提交」按钮（已改名）`);
    allPages.push(p1);
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
      // [工期对接测试与风险等级拆分 方案 v1.1 §3.3·C3] 提交前确认双勾——不勾会被前端 onConfirm 拦截
      // （showToast 提示 + return false，POST /submit 请求根本不会发出），补勾选让浏览器驱动的真实
      // 提交链路走通（同 P4 work_note 场景一样走真实前端交互，非绕过 UI 直调 API）。
      document.getElementById('siSubmitSelfTested').checked = true;
      document.getElementById('siSubmitTestEnvDeployed').checked = true;
    });
    // 点弹窗确认（siModal 确认按钮）
    const [resp] = await Promise.all([
      p2.waitForResponse(r => /\/submit/.test(r.url()), { timeout: 8000 }).catch(() => null),
      p2.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),   // siModal 确认按钮 id=siMConfirm
    ]);
    must(resp && resp.status() === 200, `P2b 示例用户B提交(带work_note) → 200（实际 ${resp && resp.status()}）`);
    allPages.push(p2);
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
    const bres = await api(devBTok, 'POST', `/api/sys-issues/${issueId}/submit`, { mode: 'no_code', no_code_reason: '仅联调无代码', work_note: '示例开发B：联调验证通过', self_tested: true, test_env_deployed: true });
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
    allPages.push(p3);
    await p3.close();

    // ── [P5] 全程无（非预期）console error——p1/p2/p3 三页各自独立判定后再汇总 ──
    // ⚠️ 三页身份不同（p1/p2=devA，p3=admin），不能把三页的 statusesByUrl 合并成一张全局 Map 再判定——
    //   同一 URL 在 devA 页恒 403、在 admin 页恒 200，合并后该 URL 的状态码数组会变成 [403,403,200]，
    //   "全部为 403" 条件被 admin 的合法 200 拖累而失真（跑出来才发现，非纸面推导）。豁免判定必须
    //   锚定"发起该请求的这一页自己观测到的历史"，与 effort 脚本单页场景的差异正在这里。
    // 先显式断言"预期豁免的前提条件"确实发生过——豁免不是凭空假设，是因为真的观测到了这个 403
    // （且该 URL 在发生 403 的那一页收到的**全部**响应都是 403，没有夹杂其他状态码）。
    function pageHasExpected403(p) {
      const urls = [...p._statusesByUrl.keys()].filter(isExpectedIntakeLiaisonsUrl);
      return urls.some(u => urlAllResponsesAre403(u, p._statusesByUrl));
    }
    const expected403Occurred = allPages.some(pageHasExpected403);
    must(expected403Occurred, `P5 前置：预期豁免的 intake-liaisons 403 应确实发生过且该 URL 在其所在页面收到的全部响应均为 403（否则豁免规则已过期，需要重新核实），实得各页该路径状态码=${JSON.stringify(allPages.map(p => [...p._statusesByUrl.keys()].filter(isExpectedIntakeLiaisonsUrl).map(u => ({ url: u, statuses: p._statusesByUrl.get(u) }))))}`);
    // 精判：逐页过滤——console error 的 URL 命中路径精确锚定 **且** 该 URL 在同一页收到的全部响应均为
    // 403，两者同时成立才豁免；任一非 403（哪怕只有一次）或未命中路径的，一律计入失败。
    const allErrs = allPages.reduce((acc, p) => acc.concat(
      p._consoleErrorsRaw
        .filter(e => !(isExpectedIntakeLiaisonsUrl(e.url) && urlAllResponsesAre403(e.url, p._statusesByUrl)))
        .map(e => e.text)
    ), []);
    must(allErrs.length === 0, `P5 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    await browser.close();
    if (issueId) { const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' }); console.log(`  · 清理测试单 #${issueId}（${d.status}）`); }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 P4 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('P4 冒烟异常:', e); process.exit(1); });
