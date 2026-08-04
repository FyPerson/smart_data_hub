/**
 * commit 记录改造（2026-07-19）— Playwright 端到端冒烟
 * 用法：本地 server(3000) 已启动后 node scripts/test-issue-commit-groups-playwright.js
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
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB = path.join(__dirname, '..', 'task_pool.db');
const SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ADMIN = 1, DEV_A = 19;   // 示例用户B

const dbGet = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.get(s, p, (e, x) => { d.close(); e ? j(e) : r(x); }); });
const dbAll = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.all(s, p, (e, x) => { d.close(); e ? j(e) : r(x); }); });
const dbRun = (s, p) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.run(s, p, function (e) { d.close(); e ? j(e) : r(this); }); });
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
async function main() {
  const adminTok = await sign(ADMIN), devATok = await sign(DEV_A);
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
     VALUES ('feature', '开发中', ?, '智数协同', '内部', 1, '管理员', 1, '2026-08-01 10:00:00')`,
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
    await browser.close();
    if (issueId) {
      const d = await api(adminTok, 'DELETE', `/api/sys-issues/${issueId}`, { reason: '自动化实测收尾清理（C2a 起 reason 必填）' });
      console.log(`  · 清理测试单 #${issueId}（${d.status}）`);
      // 兜底：夹具改直连落库后，DELETE 端点在新版受理流程下的状态门尚未逐一核实过，
      // 若 API 删除未成功（非 200），直接落库删净子表+主表，防残留（同 test-sys-commit-cols-playwright.js 范式）。
      if (d.status !== 200) {
        await dbRun(`DELETE FROM sys_issue_dev_commits WHERE issue_id = ?`, [issueId]).catch(() => {});
        await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?`, [issueId]).catch(() => {});
        await dbRun(`DELETE FROM sys_issues WHERE id = ?`, [issueId]).catch(() => {});
        console.log(`  · API 删除未 200，已直连落库兜底清理 #${issueId}`);
      }
    }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  console.log(fail === 0 ? '  🎉 commit 记录改造 端到端冒烟全部通过\n' : '  🚫 存在失败项\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('commit 改造冒烟异常:', e); process.exit(1); });
