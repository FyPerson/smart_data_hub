/**
 * commit 记录改造（2026-07-19）— Playwright 端到端冒烟
 * 用法：node scripts/test-issue-commit-groups-playwright.js
 * [#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖 localhost:3000 / 业务库 / .env。
 *   造数：直连实例库插 1 张 sys_issues 单（标题 commit改造冒烟单）+ 1 条 dev_assignees；收尾先走 API DELETE（200 / 404 算清掉），否则直连库兜底删主表与两张子表（兜底即计失败：服务端删单要删 7 张子表 + 物理附件），并回查主表行，
 *   共 2 轮间隔 200ms，遗留计失败（原来兜底的三条 DELETE 都是 `.catch(() => {})` 吞错、也不回查）；入口 .catch 也会尽力清理。
 *   固定值：用户 id 1 admin / 19。
 *
 * 改造口径（HANDOFF §A）：提交弹窗「Commit 记录」由「下拉选前端/后端 + 固定两槽」改为——
 *   ① 固定「前端组 / 后端组」两分组（去下拉·组固定 component）
 *   ② 每组可加多行（组内动态加/删行·删「同 component 至多 1 条」限制）
 *   ③ SVN/GIT 软提示（前端组=GIT commit·后端组=SVN 版本号·填反黄警告不拦截）
 *   ④ commits 模式：前端组或后端组至少一行有效数据才允许提交
 *
 * ⭐ S4（2026-08-04 用户拍板）：GIT/SVN 口径对调——此前「前端组=SVN·后端组=GIT」全反了，
 *   正确口径是「前端组填 GIT commit，后端组填 SVN 版本号」。本文件的软提示测点（原 C4）已跟着
 *   对调方向重写；C6 的示例数据/落库校验也同步换成新口径下的代表性取值。
 *
 * 测点：
 *   C1 分组渲染：两分组容器 + 组标签「前端组/后端组」+ 各默认 1 行 + 无 component 下拉（无 select）
 *   C2 加行：前端组「+ 加一行」→ 该组 2 行
 *   C3 删行：删到只剩 1 行时删除按钮隐藏（组内至少留 1 行）
 *   C4 软提示：前端组填纯数字(SVN)→黄警告；后端组填 GIT 哈希→黄警告；正常填法无警告
 *   C5 至少一行拦截：两组全空 → 提交被前端拦（不发请求）
 *   C6 同 component 多行提交 → 200 且落库多行（后端去重限制已删）
 *   C7 控制台无 JS 报错
 */
'use strict';
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB = null;     // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）
const ADMIN = 1, DEV_A = 19;   // 示例用户B

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
async function dbAll(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.all(s, p, (e, x) => { d.close((ce) => { const err = e || ce; err ? j(err) : r(x); }); }); });
}
async function dbRun(s, p) {
  const d = await openInstanceDb(DB);
  return new Promise((r, j) => { d.run(s, p, function (e) { const ctx = { lastID: this && this.lastID, changes: this && this.changes }; d.close((ce) => { const err = e || ce; err ? j(err) : r(ctx); }); }); });
}
// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function sign(uid) { return testEnv.signToken(uid); }
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
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 50[0-9]/.test(m.text())) return;
    // 预存量豁免（与本次 S4 GIT/SVN 对调无关）：/sys-issues/intake-liaisons 是「建单优化批 C2」加的
    // admin-only 端点，DOMContentLoaded 无条件预热拉取（Sys_Iteration.html 注释原话「非 admin 会 403，
    // 符合预期，不提示」）——该功能晚于本脚本（2026-07-19），本文件用 DEV_A（非 admin）登录，必然触发
    // 一次网络层 403 日志。只豁免这一个具体 URL，不放宽成"忽略所有 403"，避免掩盖真实回归。
    if (m.location() && m.location().url === `${BASE}/api/sys-issues/intake-liaisons`) return;
    errs.push(m.text());
  });
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
async function openSubmit(page) { await page.evaluate(() => siModalSubmit(siDetail.issue)); await page.waitForTimeout(400); }

let issueId = null;
let adminTok = null;   // [#106 S4d-2] 提到模块级，供入口 .catch 里尽力清理用

/**
 * [#106 S4d-2] 清理造的 sys_issues 单：先走 API DELETE（200 / 404 算清掉）；否则直连实例库兜底删主表与 dev_commits / dev_assignees 两张子表（其余 5 张子表 + 物理附件不删，兜底即计失败），并回查主表行确已不在；
 * 兜底一旦开始（fallbackTried），之后哪怕回查抛错、下一轮 API 返回 404 或 200，也仍返回同一条「兜底即计失败」说明（用首次触发兜底的状态码），不判成功；API 200 / 404 都先按 id 回查主表确已不在；
 * 失败再试一轮（共 2 轮，间隔 200ms）；清掉才把 issueId 置空（入口 .catch 里再调一次是幂等的）；返回 null = API 已删净（200 / 404），否则返回失败说明（兜底成功也返回说明）。
 * 原来兜底的三条 DELETE 都是 `.catch(() => {})` 吞错、不回查，兜底失败也退出 0
 */
async function cleanupIssue() {
  if (!issueId) return null;
  let lastErr = null;
  let fallbackTried = false;   // [#106 S4d-2 送审前小修] 兜底开始前置 true：兜底的 DELETE sys_issues 可能已生效而回查抛错，下一轮 API 会返回 404，此时不能判成功
  let fallbackStatus = null;   // 触发兜底的那次 API 状态码（说明文字用）
  const fallbackNote = (st) => `API DELETE 返回 ${st}；已直连兜底删主表与 dev_commits / dev_assignees，dev_events / release_commit_snapshots / fast_release_executors / attachments / timeline 可能残留`;
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 200));
    try {
      const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' });
      console.log(`  · 清理测试单 #${issueId}（${d.status}）`);
      if (d.status === 200 || d.status === 404) {
        // [#106 S4d-2 收口批] 200 与 404 合并处理：按 id 回查确认主表已清才置空；兜底已开始过（fallbackTried）时，下一轮 API 无论 200 还是 404 都不能判成功——
        // 前一轮兜底只删了主表与两张子表，其余 5 张子表 + 物理附件可能残留，返回的说明用「首次」触发兜底的状态码（重试不覆盖）
        const still = await dbGet(`SELECT id FROM sys_issues WHERE id = ?`, [issueId]);
        if (still) { lastErr = `API 返回 ${d.status}，但主表行仍在`; continue; }
        issueId = null;
        return fallbackTried ? fallbackNote(fallbackStatus) : null;
      }
      // 兜底：夹具改直连落库后，DELETE 端点在新版受理流程下的状态门尚未逐一核实过，
      // 若 API 删除未成功（非 200），直接落库兜底删主表与 dev_commits / dev_assignees 两张子表，防残留（同 test-sys-commit-cols-playwright.js 范式；其余 5 张子表 + 物理附件不删，兜底即计失败）。
      fallbackTried = true; if (fallbackStatus === null) fallbackStatus = d.status;   // 首次触发兜底的状态码，重试不覆盖
      await dbRun(`DELETE FROM sys_issue_dev_commits WHERE issue_id = ?`, [issueId]);
      await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?`, [issueId]);
      await dbRun(`DELETE FROM sys_issues WHERE id = ?`, [issueId]);
      const left = await dbGet(`SELECT id FROM sys_issues WHERE id = ?`, [issueId]);
      // [#106 S4d-2 修复批] 兜底即计失败：服务端删单要删 7 张子表 + 物理附件（routes/sys-iteration/index.js DELETE 端点），这里只删了主表与两张子表，不能判清理成功
      if (!left) {
        console.log(`  · API 删除未 200（${d.status}），已直连落库兜底清理 #${issueId}`);
        issueId = null;
        return fallbackNote(fallbackStatus);
      }
      lastErr = `API 返回 ${d.status}，直连兜底后主表行仍在`;
    } catch (e) { lastErr = (e && e.message) || String(e); }
  }
  return lastErr;
}

async function main() {
  await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
  BASE = testEnv.env().baseUrl;
  DB = testEnv.env().dbPath;
  adminTok = await sign(ADMIN);
  const devATok = await sign(DEV_A);
  console.log('\n══════ commit 记录改造 端到端冒烟 ══════');

  // 造数：直接落库到「开发中」+ 本人在册 pending，旁路受理/排期/指派新流程。
  // ⚠️ 预存量修复（与本次 S4 GIT/SVN 对调无关）：本脚本自 2026-07-19 起未跟进「受理排期改造」——
  //   原 create→schedule→assign→estimate 这条 API 序列已被该改造废弃：建单后新起点是「待受理」
  //   （非可直接排期）、schedule 端点直接 409 SCHEDULE_DISABLED、assign 端点改要求先补 OA 号。
  //   完整复现新版受理流程超出本次范围（S4 只改 GIT/SVN 口径 + 复制格式），改用
  //   test-sys-commit-cols-playwright.js 已验证过的「直接落库到目标态」范式，绕开与本次改动无关的
  //   前置步骤断裂——只需 issue 落在 DEV 族状态（SF.SYS_DEV_STATUSES.feature=['开发中']，见
  //   routes/sys-iteration/status-families.js）+ 本人 dev_assignees 在册 pending + dev_estimated_at
  //   非空（/submit 端点的 ESTIMATE_REQUIRED 硬闸），即可直达"可提交 commit"态。
  // ⚠️ **覆盖边界声明**（codex 审 18 MED 采纳）：改直连落库后，**本脚本不再覆盖"真实单据能否走到可提交
  //   commit 态"这条链路** —— 它只验 commit 两列的 UI 与 submit 端点行为。若将来 submit 的前置条件
  //   依赖受理/排期/指派流程写入的其它字段或状态机副产物，本脚本会**继续绿而真实路径已坏**。
  //   真实 create→受理→排期→指派→估时→提交 链路需由独立套件覆盖（当前缺口，见锚点待追认）。
  const insIssue = await dbRun(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required, dev_estimated_at)
     VALUES ('feature', '开发中', ?, 'BMS', '内部', 1, '管理员', 1, '2026-08-01 10:00:00')`,
    ['commit改造冒烟单']);
  issueId = insIssue.lastID;
  await dbRun(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
     VALUES (?, ?, '示例用户B', 0, 'pending')`,
    [issueId, DEV_A]);

  const browser = await chromium.launch();
  let allErrs = [];
  try {
    const p = await gotoAs(browser, devATok);
    await openDrawer(p, issueId);

    // ===== C1 分组渲染 =====
    await openSubmit(p);
    const c1 = await p.evaluate(() => {
      const feBox = document.getElementById('siSubmitRows-frontend');
      const beBox = document.getElementById('siSubmitRows-backend');
      const labels = [...document.querySelectorAll('.si-commit-group-label')].map(x => x.textContent);
      const selectCount = document.querySelectorAll('#siSubmitCommitsBox select').length;
      return {
        hasFe: !!feBox, hasBe: !!beBox,
        feRows: feBox ? feBox.querySelectorAll('.si-commit-row').length : -1,
        beRows: beBox ? beBox.querySelectorAll('.si-commit-row').length : -1,
        labels, selectCount,
      };
    });
    must(c1.hasFe && c1.hasBe, `C1a 前端组/后端组两容器都存在`);
    must(c1.feRows === 1 && c1.beRows === 1, `C1b 两组各默认 1 行（fe=${c1.feRows} be=${c1.beRows}）`);
    must(c1.labels.some(l => /前端组/.test(l)) && c1.labels.some(l => /后端组/.test(l)), `C1c 组标签含「前端组」「后端组」（${c1.labels.join(' / ')}）`);
    must(c1.selectCount === 0, `C1d commit 区无 component 下拉（select 数=${c1.selectCount}）`);

    // ===== C2 加行 =====
    const c2 = await p.evaluate(() => {
      siSubmitAddRow('frontend');
      return document.getElementById('siSubmitRows-frontend').querySelectorAll('.si-commit-row').length;
    });
    must(c2 === 2, `C2 前端组「+ 加一行」→ 2 行（实际 ${c2}）`);

    // ===== C3 删行（删到剩 1 行删除按钮隐藏）=====
    const c3 = await p.evaluate(() => {
      const box = document.getElementById('siSubmitRows-frontend');
      const before = box.querySelectorAll('.si-commit-row').length;
      siSubmitRemoveRow('frontend', 1);   // 删掉刚加的第 2 行
      const after = box.querySelectorAll('.si-commit-row').length;
      const delBtns = box.querySelectorAll('.si-commit-row-del').length;   // 剩 1 行时应无删除按钮
      // 再尝试删最后 1 行——应被拒（组内至少留 1 行）
      siSubmitRemoveRow('frontend', 0);
      const afterLast = box.querySelectorAll('.si-commit-row').length;
      return { before, after, delBtns, afterLast };
    });
    must(c3.before === 2 && c3.after === 1, `C3a 删行 2→1（before=${c3.before} after=${c3.after}）`);
    must(c3.delBtns === 0, `C3b 组内剩 1 行时删除按钮隐藏（delBtns=${c3.delBtns}）`);
    must(c3.afterLast === 1, `C3c 组内至少留 1 行（删最后一行被拒·仍=${c3.afterLast}）`);

    // ===== C4 软提示（S4：GIT/SVN 口径对调后——前端组=GIT commit / 后端组=SVN 版本号）=====
    const c4 = await p.evaluate(() => {
      const feInp = document.querySelector('#siSubmitRows-frontend .si-commit-row input[type="text"]');
      const beInp = document.querySelector('#siSubmitRows-backend .si-commit-row input[type="text"]');
      // 前端组填纯数字(SVN) → 应黄警告（前端组通常填 GIT commit）
      feInp.value = '12345'; feInp.dispatchEvent(new Event('input', { bubbles: true }));
      const feWarn = !!document.querySelector('#siSubmitRows-frontend .si-commit-warn');
      // 后端组填 GIT 哈希 → 应黄警告（后端组通常填 SVN 版本号）
      beInp.value = '3f87d6c'; beInp.dispatchEvent(new Event('input', { bubbles: true }));
      const beWarn = !!document.querySelector('#siSubmitRows-backend .si-commit-warn');
      // 改成正常填法 → 警告消失
      feInp.value = '3f87d6c'; feInp.dispatchEvent(new Event('input', { bubbles: true }));   // 前端组填 GIT → 无警告
      beInp.value = '12345'; beInp.dispatchEvent(new Event('input', { bubbles: true }));     // 后端组填 SVN → 无警告
      const feWarnAfter = !!document.querySelector('#siSubmitRows-frontend .si-commit-warn');
      const beWarnAfter = !!document.querySelector('#siSubmitRows-backend .si-commit-warn');
      // 分支名/tag 不误伤：GIT 检测现在挂在**后端组**（对调后），填 tag 名（含字母非纯 hex）→ 无警告
      beInp.value = 'release-v1.2'; beInp.dispatchEvent(new Event('input', { bubbles: true }));
      const beBranchWarn = !!document.querySelector('#siSubmitRows-backend .si-commit-warn');
      // codex LOW（排除子句对调后跟着挂在后端组）：后端组填 7 位以上纯数字 SVN 版本号（如 1234567·
      // 同时匹配 hex 与 SVN 两个正则）→ 不误报 GIT——这条正是排除子句要守住的东西
      beInp.value = '1234567'; beInp.dispatchEvent(new Event('input', { bubbles: true }));
      const beSvnWarn = !!document.querySelector('#siSubmitRows-backend .si-commit-warn');
      return { feWarn, beWarn, feWarnAfter, beWarnAfter, beBranchWarn, beSvnWarn };
    });
    must(c4.feWarn, `C4a 前端组填纯数字(SVN) → 黄警告出现`);
    must(c4.beWarn, `C4b 后端组填 GIT 哈希 → 黄警告出现`);
    must(!c4.feWarnAfter && !c4.beWarnAfter, `C4c 正常填法（前端GIT/后端SVN）→ 无警告`);
    must(!c4.beBranchWarn, `C4d 分支名/tag（release-v1.2）不误伤后端组的 GIT 检测 → 无警告`);
    must(!c4.beSvnWarn, `C4e ⭐ 后端组填 7 位以上纯数字 SVN 版本号（1234567，合法值·同时匹配 hex 正则）→ 不应被误报「像 GIT」（对调后排除子句的落点，codex LOW 修）`);
    allErrs = allErrs.concat(p._errs);
    await p.close();

    // ===== C5 至少一行拦截（两组全空 → 提交被前端拦，不发请求）=====
    const p5 = await gotoAs(browser, devATok);
    await openDrawer(p5, issueId);
    await openSubmit(p5);
    let submitFired = false;
    p5.on('request', r => { if (/\/submit/.test(r.url())) submitFired = true; });
    await p5.evaluate(() => {
      // 两组都留空 → 点确认
      const b = document.getElementById('siMConfirm'); if (b) b.click();
    });
    await p5.waitForTimeout(600);
    must(!submitFired, `C5 两组全空 → 前端拦截不发 submit 请求`);
    allErrs = allErrs.concat(p5._errs);
    await p5.close();

    // ===== C6 同 component 多行提交 → 200 落库多行 =====
    const p6 = await gotoAs(browser, devATok);
    await openDrawer(p6, issueId);
    await openSubmit(p6);
    await p6.evaluate(() => {
      // 前端组加一行，填两条不同 GIT commit（同 component 多行，S4 对调后前端组=GIT commit）
      siSubmitAddRow('frontend');
      const feInps = document.querySelectorAll('#siSubmitRows-frontend .si-commit-row input[type="text"]');
      feInps[0].value = 'abc1234'; feInps[0].dispatchEvent(new Event('input', { bubbles: true }));
      feInps[1].value = 'def5678'; feInps[1].dispatchEvent(new Event('input', { bubbles: true }));
      // 后端组填一条 SVN（S4 对调后后端组=SVN 版本号）
      const beInp = document.querySelector('#siSubmitRows-backend .si-commit-row input[type="text"]');
      beInp.value = '99001'; beInp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const [subResp] = await Promise.all([
      p6.waitForResponse(r => /\/submit/.test(r.url()), { timeout: 8000 }).catch(() => null),
      p6.evaluate(() => { const b = document.getElementById('siMConfirm'); if (b) b.click(); }),
    ]);
    must(subResp && subResp.status() === 200, `C6a 同 component 多行提交 → 200（实际 ${subResp && subResp.status()}）`);
    allErrs = allErrs.concat(p6._errs);
    await p6.close();

    // 落库核对：前端组 2 行 + 后端组 1 行（S4 对调后前端组=GIT commit，故 2 行多值样例移到前端组）
    const rows = await dbAll(`SELECT component, commit_ref FROM sys_issue_dev_commits WHERE issue_id=? ORDER BY id`, [issueId]);
    const beRefs = rows.filter(r => r.component === 'backend').map(r => r.commit_ref).sort();
    const feRefs = rows.filter(r => r.component === 'frontend').map(r => r.commit_ref).sort();
    must(JSON.stringify(feRefs) === JSON.stringify(['abc1234', 'def5678']), `C6b 前端组同 component 2 行全落库（${JSON.stringify(feRefs)}）`);
    must(JSON.stringify(beRefs) === JSON.stringify(['99001']), `C6c 后端组 1 行落库（${JSON.stringify(beRefs)}）`);

    must(allErrs.length === 0, `C7 控制台无 JS 报错（${allErrs.length} 个${allErrs.length ? ': ' + allErrs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    try { await browser.close(); } catch (e) { must(false, `浏览器关闭失败：${e && e.message}`); }
    const keepId = issueId;
    const cleanupErr = await cleanupIssue();
    if (cleanupErr) must(false, `清理测试单 #${keepId} 未判成功：${cleanupErr}`);
  }
  try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 commit 记录改造 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
}
main().catch(async (e) => {
  console.error('commit 改造冒烟异常:', e);
  try { await cleanupIssue(); } catch (_) { /* 已在报错路径，尽力清理 */ }
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
