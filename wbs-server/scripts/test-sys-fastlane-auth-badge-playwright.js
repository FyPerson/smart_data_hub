/**
 * 系统迭代·「已授权先行上线」列表徽章回归（2026-09-11 用户拍板新增）
 *
 * 用法：node scripts/test-sys-fastlane-auth-badge-playwright.js
 * 前置：① 本地 server 已启动（localhost:3000）
 *       ② 本地 .env 有 SYS_FASTLANE_ENABLE=1 —— A 组**走真实授权 API** 写授权六列（不猜字段形态），
 *          闸关时授权端点返 403 FAST_RELEASE_FEATURE_DISABLED，A1 断言即红并提示原因。
 *
 * 覆盖的缺口：admin 授权后到开发 submit 挂牌之间，该单在列表上与普通 bug 单毫无区别（flags 链里没有
 *   任何授权态标识），而授权是当天时段性通道、次日 8:00 自动收回，这段时间授权可能悄悄过期而无人察觉。
 *   新徽章「已授权先行上线」补的就是这一段。
 *
 * ── 三组分工（codex 审 20260911 H-1/M-1/M-3 收口后的结构）────────────────────────
 * A 组·真实链路：真实建单 + 真实授权 API + 真实列表渲染，证明整条链通。
 * B 组·⭐ 残留但已过期：**本套件的核心判别用例**。真实授权后把 fast_release_auth_at 改成两天前
 *   （六列其余不动 ⇒ 授权记录仍“残留”，但已过次日 8:00 消费窗口）。此时：
 *     · 若后端该列算“可消费” ⇒ 布尔=0 ⇒ 徽章不显示（期望）
 *     · 若后端退化成只判“残留”  ⇒ 布尔=1 ⇒ 徽章仍显示（本组判红）
 *   ⚠️ 为什么不能靠 A 组的“撤销后消失”来证这件事（codex 审 M-1 指出的判别力误判）：撤销会**清空六列**，
 *     残留判据与可消费判据**都会**变假，两种实现都能通过——那条断言只证明“撤销路径影响显示”。
 * C 组·门控矩阵：直调 helper 传构造对象，逐格验证 type/status/布尔三重门控。用纯函数输入而非制造
 *   业务上非法的授权记录（如给 feature 单造授权行——授权端点本就 409 拒绝），既快又不污染数据。
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

const dbGet = (sql, p = []) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.get(sql, p, (e, row) => { d.close(); e ? j(e) : r(row); }); });
const dbRun = (sql, p = []) => new Promise((r, j) => { const d = new sqlite3.Database(DB); d.run(sql, p, function (e) { d.close(); e ? j(e) : r(this); }); });

let pass = 0, fail = 0;
// 夹具清理未收口清单（codex 二轮 L）：清理失败原先只打日志、退出码仍 0 ⇒ 只读退出码的调用方
//   会把"夹具残留"当成完全成功。改为计入本清单并走文件末尾的退出码分层。
const cleanupFailures = [];
const must = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? pass++ : fail++; return c; };

async function signAs(id) {
  const u = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [id]);
  return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, SECRET, { expiresIn: '1h' });
}
async function api(method, url, token, body) {
  const r = await fetch(`${BASE}${url}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
// 读列表页某单那一行；找不到返回 null（调用方必须先断言非 null——见 codex 审 H-1）
async function rowBadges(page, issueId) {
  return await page.evaluate((id) => {
    const rows = [...document.querySelectorAll('#siTable tbody tr, table tbody tr')];
    for (const tr of rows) {
      const first = tr.querySelector('td');
      if (first && new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(first.textContent || '')) {
        return { badges: [...tr.querySelectorAll('.u-status-badge')].map(b => (b.textContent || '').trim()) };
      }
    }
    return null;
  }, issueId);
}
// 等目标行真正出现再读，避免"列表还没渲染完 → 行不存在 → 断言被跳过"（H-1 同族：缺失不得当通过）
async function waitRow(page, issueId, timeout = 8000) {
  try {
    await page.waitForFunction((id) => {
      const rows = [...document.querySelectorAll('#siTable tbody tr, table tbody tr')];
      return rows.some(tr => {
        const first = tr.querySelector('td');
        return first && new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(first.textContent || '');
      });
    }, issueId, { timeout });
  } catch (_) { /* 超时交由调用方的存在性断言判红 */ }
  return await rowBadges(page, issueId);
}
async function openList(page, token) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}/Sys_Iteration.html`);
  await page.waitForLoadState('networkidle');
}
// ⚠️ 登记时机（codex 二轮 L）：建单成功后**立即**把 id 推进 created 再返回——早先写法是两张单都建完
//   才统一登记，第二张建单抛错会让第一张永远漏清。故 created 由本函数内部负责，调用方不再自行 push。
async function mkBug(admin, lid, tag, created) {
  const r = await api('POST', '/api/sys-issues', admin, {
    intake_contract_version: 2, type: 'bug',
    description: `[验证·已授权徽章-${tag}] ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    intake_liaison_id: Number(lid), system_name: 'BMS', source: '内部', priority: 'P2', oa_exempt: 1,
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`建单失败 ${r.status} ${JSON.stringify(r.body)}`);
  created.push(r.body.id);
  return r.body.id;
}

(async () => {
  const created = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const admin = await signAs(1);
    const liaisons = await api('GET', '/api/sys-issues/intake-liaisons', admin);
    const lid = liaisons.body.items[0].id;

    // ═══ A 组：真实链路 ═══════════════════════════════════════════
    console.log('\n── A 组：真实授权 → 徽章出现 / 对照 / 互斥 / 撤销后刷新不再显示 ──');
    const idAuth = await mkBug(admin, lid, 'A-授权', created);
    const idPlain = await mkBug(admin, lid, 'A-对照', created);
    for (const id of [idAuth, idPlain]) await dbRun(`UPDATE sys_issues SET status='处理中' WHERE id=?`, [id]);

    const auth = await api('POST', `/api/sys-issues/${idAuth}/fast-release-authorize`, admin, { note: '验证徽章' });
    // 授权失败则后续断言全部失去意义（会给出"徽章没出现"的误导性结论），直接终止本组
    if (!must(auth.status === 200, `A1 真实授权 API 200（实得 ${auth.status}；若为 403 请确认本地 .env 的 SYS_FASTLANE_ENABLE=1）`)) {
      throw new Error('授权失败，终止——继续跑只会产生误导性结论');
    }

    const page = await browser.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await openList(page, admin);

    const rAuth = await waitRow(page, idAuth);
    const rPlain = await waitRow(page, idPlain);
    must(!!rAuth, `A2 列表能定位到已授权单 #${idAuth}`);
    must(!!rPlain, `A3 列表能定位到对照单 #${idPlain}`);
    if (rAuth) must(rAuth.badges.some(b => b.includes('已授权先行上线')), `A4 ⭐ 已授权单出现「已授权先行上线」（实得 ${JSON.stringify(rAuth.badges)}）`);
    if (rPlain) must(!rPlain.badges.some(b => b.includes('已授权先行上线')), `A5 ⭐ 未授权对照单**不**出现（实得 ${JSON.stringify(rPlain.badges)}）`);
    if (rAuth) must(!rAuth.badges.some(b => b.includes('待先行部署')), `A6 「处理中」不出现「待先行部署 x/N」（两徽章状态集互斥）`);

    // 撤销后：⚠️ 先硬断言行仍在，再断言徽章消失（codex 审 H-1：原写法 rAfter 为 null 时断言被整条跳过，
    //   列表加载失败/筛选变化/行丢失都会让套件"零失败"通过——缺失不得当通过）
    const rev = await api('POST', `/api/sys-issues/${idAuth}/fast-release-revoke`, admin, { reason: '验证撤销后不再显示' });
    must(rev.status === 200, `A7 撤销 API 200（实得 ${rev.status}）`);
    await page.reload();
    await page.waitForLoadState('networkidle');
    const rAfter = await waitRow(page, idAuth);
    // 注：本条只证明"撤销路径影响显示"，**不**证明可消费语义——那由 B 组承担（codex 审 M-1）
    if (must(!!rAfter, `A8 撤销后目标行**仍在列表中**（行缺失即判红，不再让下一条断言被跳过）`)) {
      must(!rAfter.badges.some(b => b.includes('已授权先行上线')), `A9 撤销后重新拉取列表，徽章不再显示（实得 ${JSON.stringify(rAfter.badges)}）`);
    }
    await page.close();

    // ═══ B 组：⭐ 残留但已过期（真正区分"残留"与"可消费"）═══════════
    console.log('\n── B 组：授权残留但已过消费窗口 → 布尔=0 且徽章不显示 ──');
    const idStale = await mkBug(admin, lid, 'B-过期', created);
    await dbRun(`UPDATE sys_issues SET status='处理中' WHERE id=?`, [idStale]);
    const authB = await api('POST', `/api/sys-issues/${idStale}/fast-release-authorize`, admin, { note: '验证过期' });
    must(authB.status === 200, `B1 真实授权 200（实得 ${authB.status}）`);
    // 把授权时刻推到两天前：消费截止 = 授权日次日 08:00 ⇒ 已过；六列其余不动 ⇒ 残留判据仍为真
    await dbRun(`UPDATE sys_issues SET fast_release_auth_at = datetime('now','localtime','-2 days') WHERE id=?`, [idStale]);
    const stale = await dbGet(
      `SELECT fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at FROM sys_issues WHERE id=?`, [idStale]);
    // 先坐实夹具形态=“残留在、只是过期了”，否则下面的"不显示"可能是因为六列被清（那就退化成 A 组）
    must(!!stale && !!stale.fast_release_auth_at && !stale.fast_release_revoked_at && !stale.fast_release_consumed_at,
      `B2 ⭐ 夹具前提：授权记录**仍残留**（auth_at 非空、未撤销、未消费）——实得 ${JSON.stringify(stale)}`);

    const pageB = await browser.newPage();
    const errsB = [];
    pageB.on('console', m => { if (m.type() === 'error') errsB.push(m.text()); });
    pageB.on('pageerror', e => errsB.push('pageerror: ' + e.message));
    await openList(pageB, admin);
    // 后端布尔层断言：可消费=0（若后端退化为只判残留，这里会是 1）
    // ⚠️ 返回**原始值**而非 Number() 转换结果（codex 二轮 M）：`Number(null)`/`Number('')`/`Number(false)`
    //   统统等于 0，若字段缺投影或返回异常值，转换后的断言会**假通过**，而前端同样隐藏徽章 ⇒ B5 也跟着
    //   假通过，两条一起绿、无人报警。这里按该列声明的「SQL 数字布尔只出 1/0」契约**严格比较数字 0**。
    const listRaw = await pageB.evaluate(async (id) => {
      const r = await fetch(`/api/sys-issues?page=1&page_size=200`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
      const j = await r.json();
      const row = (j.items || []).find(x => Number(x.id) === Number(id));
      if (!row) return { present: false };
      return { present: true, raw: row.fast_release_active_auth, type: typeof row.fast_release_active_auth };
    }, idStale);
    must(listRaw.present, `B3a 列表响应里能找到该单（找不到则下面的布尔断言无从谈起，不得跳过）`);
    must(listRaw.present && listRaw.raw === 0,
      `B3 ⭐ 后端列表布尔 fast_release_active_auth **严格等于数字 0**（可消费语义；退化为仅判残留会是 1；null/''/缺投影一律判红）——实得 ${JSON.stringify(listRaw.raw)}（typeof ${listRaw.type}）`);
    const rStale = await waitRow(pageB, idStale);
    must(!!rStale, `B4 列表能定位到过期授权单 #${idStale}`);
    if (rStale) must(!rStale.badges.some(b => b.includes('已授权先行上线')), `B5 ⭐ 过期授权**不**显示徽章（实得 ${JSON.stringify(rStale.badges)}）`);
    // ⚠️ 事后复核夹具仍是"残留态"（codex 二轮建议）：若将来列表加载链路新增了惰性清理（把过期授权的
    //   六列清空），本组会**悄悄退化**成"清空授权后不显示"——那就和 A 组重复、不再验可消费语义。
    //   这条断言让那种退化当场可见。
    const staleAfter = await dbGet(
      `SELECT fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at FROM sys_issues WHERE id=?`, [idStale]);
    must(!!staleAfter && !!staleAfter.fast_release_auth_at && !staleAfter.fast_release_revoked_at && !staleAfter.fast_release_consumed_at,
      `B5b ⭐ 读列表后授权**仍保持残留态**（防将来新增惰性清理让本组退化为"清空后不显示"）——实得 ${JSON.stringify(staleAfter)}`);
    must(errsB.length === 0, `B6 B 组无 JS 报错（${errsB.length} 个）`);
    await pageB.close();

    // ═══ C 组：门控矩阵（直调 helper·纯函数输入）═════════════════
    console.log('\n── C 组：type / status / 布尔 三重门控矩阵 ──');
    const pageC = await browser.newPage();
    await openList(pageC, admin);
    const matrix = await pageC.evaluate(() => {
      const cases = [
        { name: 'bug + 待处理 + 授权',   arg: { type: 'bug', status: '待处理', fast_release_active_auth: 1 }, expect: true },
        { name: 'bug + 处理中 + 授权',   arg: { type: 'bug', status: '处理中', fast_release_active_auth: 1 }, expect: true },
        { name: 'bug + 待受理 + 授权',   arg: { type: 'bug', status: '待受理', fast_release_active_auth: 1 }, expect: false },
        { name: 'bug + 待验证 + 授权',   arg: { type: 'bug', status: '待验证', fast_release_active_auth: 1 }, expect: false },
        { name: 'bug + 已上线 + 授权',   arg: { type: 'bug', status: '已上线', fast_release_active_auth: 1 }, expect: false },
        { name: 'feature + 处理中 + 授权', arg: { type: 'feature', status: '处理中', fast_release_active_auth: 1 }, expect: false },
        { name: 'config + 处理中 + 授权',  arg: { type: 'config', status: '处理中', fast_release_active_auth: 1 }, expect: false },
        { name: 'bug + 处理中 + 无授权',  arg: { type: 'bug', status: '处理中', fast_release_active_auth: 0 }, expect: false },
        { name: 'bug + 处理中 + 布尔为字符串 "0"', arg: { type: 'bug', status: '处理中', fast_release_active_auth: '0' }, expect: false },
      ];
      return cases.map(c => ({ name: c.name, expect: c.expect, actual: siFastlaneAuthFlagHtml(c.arg).includes('已授权先行上线') }));
    });
    for (const c of matrix) must(c.actual === c.expect, `C ${c.name} → ${c.expect ? '显示' : '不显示'}（实得 ${c.actual ? '显示' : '不显示'}）`);
    await pageC.close();

    must(errs.length === 0, `A 组无 JS 报错（${errs.length} 个${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`);
  } finally {
    await browser.close().catch(() => {});
    for (const id of created) {
      try {
        await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [id]);
        await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [id]);
        await dbRun(`DELETE FROM sys_fast_release_executors WHERE issue_id=?`, [id]);
        await dbRun(`DELETE FROM sys_issues WHERE id=?`, [id]);
        console.log(`  🧹 已清理 #${id}`);
      } catch (e) {
        console.log(`  ❗ #${id} 清理失败，可能残留：${e.message}`);
        cleanupFailures.push(`#${id}: ${e.message}`);
      }
    }
  }
  console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
  // 退出码分层（codex 二轮 L）：功能失败=1（优先、不被清理状态覆盖）；功能全绿但夹具清理失败=2。
  if (fail > 0) {
    if (cleanupFailures.length) console.log(`  ❗ 另有 ${cleanupFailures.length} 个夹具清理失败`);
    process.exit(1);
  }
  if (cleanupFailures.length) {
    console.log(`  ❗❗ 功能断言全通过，但 ${cleanupFailures.length} 个夹具清理失败——退出码 2（勿当作完全成功）`);
    cleanupFailures.forEach(x => console.log(`     - ${x}`));
    process.exit(2);
  }
  process.exit(0);
})().catch(e => { console.error('实测脚本异常:', e.stack || e); process.exit(1); });
