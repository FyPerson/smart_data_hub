// scripts/verify-sys-liaison-return-commit-cleanup.js — #55 修复验收：liaison_test_return（对接测试打回）
//   花名册重置同时精确删除 commit 行
//   SSOT = docs/local/系统迭代/开发撤回提交_方案_20260910_v1.2.md §5.4「commit 行处置（照抄 F8 范式·
//   顺带修 #55）」+ §7「#55 回归」
//
// 背景：liaison_test_return 原实现（index.js :6767 一带）只做
//   `dev_status='pending', resolved_at=NULL, no_code_reason=NULL`，不删 sys_issue_dev_commits 行，
//   造成两个真实症状：① `pending ∧ commit 行≥1` 违反 sys-multidev-probes 的 P2 配对不变量
//   ② liaison_test_return **原地重置同一 dev_assignee_id**（不像 return/reopen 走 remove+re-add 开
//   新实例），旧 commit 行不删，该开发用同一 commit_ref 重新提交 commits 模式时会在同一 daId 上撞
//   assertCommitNaturalKeyFree（dev_assignee_id+component+commit_ref）自然键查重 400。
//
// 修复范围要求精确：事务内先 SELECT 出「本次真正从 code_submitted/no_code 改为 pending」的在册实例
//   id 集合（与 UPDATE 同 WHERE，必须在 UPDATE 之前查），只删该集合对应的 commit 行——不得按 issue_id
//   或 dev_user_id 整体删除（会误删同单未被本次重置的 pending/excused 成员，以及已移除历史实例的记录）。
//
// 覆盖：
//   [1] 单人回归：code_submitted 打回后 pending∧commit=0，P1-P16 探针全程恒真，逐行 delete-commit
//       审计（via='liaison_test_return'）字段可回溯
//   [2] 精确范围：A=code_submitted/B=no_code/C=pending/D=excused 混合态打回，只删 A/B 的 commit 行，
//       C/D 不受影响（人为在 C/D 上挂造极端态 commit 行，专测"删除范围是否精确到 id 集合"）
//   [3] 已移除历史实例（removed_at 非空）的 dev_status/commit 行/事件均不受本次打回影响
//   [4] 重提不撞查重：打回后同一开发用同一 commit_ref 重新提交 commits 模式应 200（非 400 自然键查重）
//   [变异自证 M1] 去掉 commit 行删除段 ⇒ P2 探针必须判红
//   [变异自证 M2] 精确 id 集合换成按 issue_id 整体删 ⇒ 多人混合状态用例必须判红（C 的行被误删）
//
// 独立成文而非并入 verify-sys-liaison-test.js 的原因：该文件多个既有用例组（如 [3]/[6d]）故意在共享
// 内存库里留下非法 dev_status/配对脏值用于测负向分支且不清理，与本文件需要的"全表 P1-P16 探针可信"
// 互斥。本文件照抄 verify-sys-submit-withdraw.js 范式：每个用例块跑完 deleteIssueFully，保证全表探针
// 在任意时刻都能反映"当前存活单据"的真实状态。
//
// in-process app + 内存库 + 自签 token，同 verify-sys-submit-withdraw.js / verify-sys-liaison-test.js 范式。
// 用法：node scripts/verify-sys-liaison-return-commit-cleanup.js
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-liaison-return-commit-cleanup-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const failDetails = [];
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function must(cond, msg) {
  if (cond) { ok(msg); } else { console.log('  ✗ ' + msg); failDetails.push(msg); }
  return cond;
}

function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 夹具（同 verify-sys-submit-withdraw.js mkIssue 范式）──────────────────────────────────────────
async function mkIssue(type, status, extra = {}) {
  const intakeLiaisonId = Object.prototype.hasOwnProperty.call(extra, 'intakeLiaisonId') ? extra.intakeLiaisonId : 13;
  // [4] 组要走真实 POST /submit 端点——该端点对任意 type 都有 ESTIMATE_REQUIRED 闸（:10356，无 type
  // 限定），缺 dev_estimated_at 会 400；feature/improvement 另有 EFFORT_REQUIRED 闸（:10466，缺
  // estimated_effort_days 会 400）。同 verify-sys-submit-withdraw.js mkIssue 既有夹具口径：默认各种
  // 合法占位值，显式传 null 可测该闸本身（本文件未用到该分支，保留以防未来复用）。
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_liaison_id, dev_estimated_at, estimated_effort_days)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, intakeLiaisonId, est, effort]
  );
  return r.lastID;
}
// devStatus='code_submitted' 且 extra.skipCommit!==true 时自动种 1 条 commit 行（component=backend，
// commit_ref=`fix/seed-${daId}`）——同 verify-sys-liaison-test.js mkMember 逐字同源。
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [issueId, userId, userName, devStatus, extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  const daId = r.lastID;
  if (devStatus === 'code_submitted' && extra.skipCommit !== true) {
    await run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, ?, 'backend', ?, datetime('now'))`,
      [issueId, daId, userId, `fix/seed-${daId}`]
    );
  }
  return daId;
}
async function memberRow(daId) { return get('SELECT * FROM sys_issue_dev_assignees WHERE id = ?', [daId]); }
async function commitsOf(daId) {
  return all(`SELECT id, component, commit_ref FROM sys_issue_dev_commits WHERE dev_assignee_id=? ORDER BY id`, [daId]);
}
async function deleteCommitEventsOf(daId) {
  return all(`SELECT id, dev_assignee_id, payload_json FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action='delete-commit' ORDER BY id`, [daId]);
}
// 把单据推进到「待对接测试」——本文件只测 liaison_test_return 边本身，不经真实 excuse/GATE 路径，
// 直接 raw SQL 落态（同 verify-sys-liaison-test.js [7] 组既有范式），须一并补 assigned_to（否则撞
// REQUIRES_ASSIGNEE_STATUSES 校验 409 NO_ASSIGNEE_FOR_DEV_STATE）。
async function toLiaisonTestState(issueId, assigneeUserId, assigneeUserName) {
  await run(`UPDATE sys_issues SET status='待对接测试', liaison_test_cycle_no=1, assigned_to=?, assigned_to_name=? WHERE id=?`,
    [assigneeUserId, assigneeUserName, issueId]);
}
async function deleteIssueFully(issueId) {
  await run(`DELETE FROM sys_fast_release_executors WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_dev_events WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_dev_commits WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_attachments WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issues WHERE id=?`, [issueId]);
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  must(failed.length === 0, `${label}：应满足全部 P1-P16 恒真，实际失败：${JSON.stringify(failed)}`);
  return results;
}
function p2Of(results) { return results.find(r => r.id === 'P2'); }

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13900000001'),(5,'dev5','开发甲','user','active','13900000005'),
    (6,'dev6','开发乙','user','active','13900000006'),(7,'dev7','开发丙','user','active','13900000007'),
    (8,'dev8','开发丁','user','active','13900000008'),(9,'dev9','开发戊','user','active','13900000009'),
    (13,'wangtaotao','示例对接人','user','active','13900000013')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  await selfCertifyProbes('[前置] 空库应先满足 P1-P16');

  // ══════════════════════════════════════════════════════════════════════
  // [1] 单人回归：code_submitted 打回后 pending∧commit=0，P2 满足 + 审计完整性
  // ══════════════════════════════════════════════════════════════════════
  {
    const id1 = await mkIssue('feature', '开发中');
    const da1 = await mkMember(id1, 5, '开发甲', 'code_submitted');   // 自动种 1 条 commit（fix/seed-${daId}）
    await toLiaisonTestState(id1, 5, '开发甲');
    must((await commitsOf(da1)).length === 1, '[1] 前置：该实例确有 1 条 commit 行（夹具有效）');

    const ret1 = await call('POST', `/api/sys-issues/${id1}/liaison-test-return`, liaisonTok, { reason: '#55 回归：单人打回' });
    must(ret1.status === 200, `[1] return 应 200，实际 ${ret1.status} ${JSON.stringify(ret1.body)}`);
    const m1 = await memberRow(da1);
    must(m1.dev_status === 'pending', `[1] dev_status → pending，实得 ${m1.dev_status}`);
    must((await commitsOf(da1)).length === 0, '[1] ⭐ #55：commit 行随打回一并删除，不再残留');
    await selfCertifyProbes('[1] 打回后');

    const ev1 = await deleteCommitEventsOf(da1);
    must(ev1.length === 1, `[1] ⭐ 审计完整性：写 1 条 delete-commit 事件（逐行而非汇总），实得 ${ev1.length}`);
    if (ev1.length === 1) {
      const p1 = JSON.parse(ev1[0].payload_json);
      must(p1.via === 'liaison_test_return', `[1] ⭐ via 独立来源标识='liaison_test_return'（与撤回'withdraw'、amend'amend_mode_switch'三源可分），实得 ${p1.via}`);
      must(p1.dev_assignee_id === da1, `[1] payload.dev_assignee_id 可回溯，实得 ${p1.dev_assignee_id}`);
      must(p1.component === 'backend', `[1] payload.component 可回溯，实得 ${p1.component}`);
      must(p1.commit_ref === `fix/seed-${da1}`, `[1] payload.commit_ref 可回溯，实得 ${p1.commit_ref}`);
      must(Number(p1.commit_id) > 0, `[1] payload.commit_id 可回溯，实得 ${p1.commit_id}`);
    }
    await deleteIssueFully(id1);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [2] ⭐⭐ 精确范围：A=code_submitted/B=no_code/C=pending/D=excused 混合，只删 A/B
  // ══════════════════════════════════════════════════════════════════════
  {
    const id2 = await mkIssue('feature', '开发中');
    const daA = await mkMember(id2, 5, '开发甲', 'code_submitted');   // 自动种 commit
    const daB = await mkMember(id2, 6, '开发乙', 'no_code');
    const daC = await mkMember(id2, 7, '开发丙', 'pending');
    const daD = await mkMember(id2, 8, '开发丁', 'excused');
    // B/C/D 人为各挂 1 条 commit 行——no_code/pending/excused 在真实生产流程里理论上不该有 commit 行，
    // 此处刻意造出这个"理论不该有"的极端态，专测"删除范围是否精确到 id 集合"：若实现按 issue_id
    // 整体删（未加 dev_status 过滤），C/D 的这两条会被一并误删，用例能抓出来；若实现精确到集合，
    // 只有 A/B 的行消失，C/D 原样保留。
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [id2, daB, 6, 'backend', `fix/seed-${daB}-b`]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [id2, daC, 7, 'backend', `fix/seed-${daC}-c`]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [id2, daD, 8, 'backend', `fix/seed-${daD}-d`]);
    await toLiaisonTestState(id2, 5, '开发甲');
    must((await commitsOf(daA)).length === 1, '[2] 前置 A 有 1 条');
    must((await commitsOf(daB)).length === 1, '[2] 前置 B 有 1 条');
    must((await commitsOf(daC)).length === 1, '[2] 前置 C 有 1 条（人为造的极端态）');
    must((await commitsOf(daD)).length === 1, '[2] 前置 D 有 1 条（人为造的极端态）');

    const ret2 = await call('POST', `/api/sys-issues/${id2}/liaison-test-return`, liaisonTok, { reason: '#55 精确范围：混合状态打回' });
    must(ret2.status === 200, `[2] return 应 200，实际 ${ret2.status} ${JSON.stringify(ret2.body)}`);
    must((await memberRow(daA)).dev_status === 'pending', '[2] A: code_submitted → pending');
    must((await memberRow(daB)).dev_status === 'pending', '[2] B: no_code → pending');
    must((await memberRow(daC)).dev_status === 'pending', '[2] C: 本就 pending，不受影响');
    must((await memberRow(daD)).dev_status === 'excused', '[2] D: excused 不动');
    must((await commitsOf(daA)).length === 0, '[2] ⭐ A 的 commit 行被删');
    must((await commitsOf(daB)).length === 0, '[2] ⭐ B 的 commit 行被删');
    must((await commitsOf(daC)).length === 1, '[2] ⭐⭐ 精确范围：C（本就 pending，非本次被重置）的 commit 行不受影响，未被误删');
    must((await commitsOf(daD)).length === 1, '[2] ⭐⭐ 精确范围：D（excused）的 commit 行不受影响，未被误删');
    must((await deleteCommitEventsOf(daA)).length === 1, '[2] A 写 1 条 delete-commit');
    must((await deleteCommitEventsOf(daB)).length === 1, '[2] B 写 1 条 delete-commit');
    must((await deleteCommitEventsOf(daC)).length === 0, '[2] C 不产生 delete-commit 事件');
    must((await deleteCommitEventsOf(daD)).length === 0, '[2] D 不产生 delete-commit 事件');
    // ⚠️ 本组不跑全表 selfCertifyProbes：C/D 身上刻意人为挂的 commit 行本身就是 P2/P5 视角下的"非法
    // 极端态"（pending/excused 不该有 commit 行），这是本组测试精确范围特意构造出来、且断言要求"原样
    // 不动"的既有状态，不是本次 liaison_test_return 动作造成的新违例——若在此处判全表清白，反而会把
    // "C/D 确实没被误删"（正确行为）误判成"探针发现问题"（信号方向搞反）。A/B 两个真正被本次动作
    // 处理的实例已在上方逐项断言清零，等价覆盖了 P2 对它们的要求；C/D 的清理留给 deleteIssueFully。
    await deleteIssueFully(id2);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [3] ⭐ 已移除历史实例不受影响
  // ══════════════════════════════════════════════════════════════════════
  {
    const id3 = await mkIssue('feature', '开发中');
    const daLive = await mkMember(id3, 5, '开发甲', 'code_submitted');
    const daRemoved = await mkMember(id3, 9, '开发戊（已移除）', 'code_submitted', { removedAt: '2026-09-01 09:00:00' });
    must((await commitsOf(daRemoved)).length === 1, '[3] 前置：已移除历史实例仍留有 1 条 commit（软删不撤回历史 commit）');
    await toLiaisonTestState(id3, 5, '开发甲');

    const ret3 = await call('POST', `/api/sys-issues/${id3}/liaison-test-return`, liaisonTok, { reason: '#55 边界：已移除历史实例不受影响' });
    must(ret3.status === 200, `[3] return 应 200，实际 ${ret3.status} ${JSON.stringify(ret3.body)}`);
    must((await memberRow(daLive)).dev_status === 'pending', '[3] 在册成员正常重置');
    must((await commitsOf(daLive)).length === 0, '[3] 在册成员 commit 行被删');
    const removedRow = await memberRow(daRemoved);
    must(removedRow.dev_status === 'code_submitted', `[3] ⭐⭐ 已移除历史实例 dev_status 原样保持（未被本次 UPDATE 波及，WHERE removed_at IS NULL 挡住），实得 ${removedRow.dev_status}`);
    must((await commitsOf(daRemoved)).length === 1, '[3] ⭐⭐ 已移除历史实例的 commit 行原样保留，未被误删');
    must((await deleteCommitEventsOf(daRemoved)).length === 0, '[3] 已移除历史实例不产生 delete-commit 事件');
    await selfCertifyProbes('[3] 打回后');
    await deleteIssueFully(id3);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [4] ⭐ 重提不撞查重：打回后同一开发用同 ref 重新提交 commits 模式应成功（非 400）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id4 = await mkIssue('feature', '开发中');
    // submit 端点要求本人在册实例当前 dev_status='pending'（:10473 双条件 WHERE），故种 pending
    // （非 code_submitted）——commit 行交给下方真实 /submit 调用产生；assigned_at 必须种（否则打回后
    // 调 /estimate 会撞 ASSIGNED_AT_MISSING，同 verify-sys-liaison-test.js [7b-1] 既有踩坑口径）。
    const da4 = await mkMember(id4, 5, '开发甲', 'pending');
    await run(`UPDATE sys_issues SET assigned_to=5, assigned_to_name='开发甲', assigned_at='2026-07-16 10:00:00' WHERE id=?`, [id4]);
    const dupRef = `svn-dup-${id4}`;
    const firstSub = await call('POST', `/api/sys-issues/${id4}/submit`, devTok(5),
      { mode: 'commits', commits: [{ component: 'backend', commit_ref: dupRef }], self_tested: true, test_env_deployed: true });
    must(firstSub.status === 200, `[4] 前置：首次真实提交应 200，实际 ${firstSub.status} ${JSON.stringify(firstSub.body)}`);
    must(firstSub.body.dev_assignee_id === da4, '[4] 前置：真实提交作用在与 mkMember 造的同一实例上');
    await toLiaisonTestState(id4, 5, '开发甲');

    const ret4 = await call('POST', `/api/sys-issues/${id4}/liaison-test-return`, liaisonTok, { reason: '#55 症状二：重提不应撞查重' });
    must(ret4.status === 200, `[4] return 应 200，实际 ${ret4.status} ${JSON.stringify(ret4.body)}`);
    // liaison_test_return 复用 return 的字段清理套餐，会清空 dev_estimated_at/estimated_effort_days
    // （同 verify-sys-liaison-test.js [7] 组既有断言口径），开发须先回填才能重新提交，同 [7b-1] 既有
    // "打回→回填→重新提交"端到端范式。
    const estR4 = await call('POST', `/api/sys-issues/${id4}/estimate`, devTok(5), { dev_estimated_at: futureEst(20), estimated_effort_days: 1 });
    must(estR4.status === 200, `[4] 前置：打回后回填预计完成时间+工期应 200，实际 ${estR4.status} ${JSON.stringify(estR4.body)}`);
    const resubmit = await call('POST', `/api/sys-issues/${id4}/submit`, devTok(5),
      { mode: 'commits', commits: [{ component: 'backend', commit_ref: dupRef }], self_tested: true, test_env_deployed: true });
    must(resubmit.status === 200, `[4] ⭐⭐ #55 症状二回归：打回后同 ref 重提应 200（修复前会撞自然键查重 400 VALIDATION），实际 ${resubmit.status} ${JSON.stringify(resubmit.body)}`);
    if (resubmit.status === 200) {
      must(resubmit.body.dev_assignee_id === da4, '[4] 重提仍落在同一实例（liaison_test_return 不像 return/reopen 那样开新实例）');
    }
    await selfCertifyProbes('[4] 重提后');
    await deleteIssueFully(id4);
  }

  console.log(`\n（正例小计：${passed} 组断言${failDetails.length ? '，失败 ' + failDetails.length + ' 项' : ''}）`);
  if (failDetails.length > 0) {
    console.error('\n❌ 正例阶段已有失败，跳过变异自证（先修正例）：');
    failDetails.forEach(m => console.error('  - ' + m));
    server.close();
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [变异自证 M1] 去掉 commit 行删除段 ⇒ P2 探针必须判红
  //   直接在测试库里复刻"回退到修复前"的行为：只做花名册 UPDATE，不删 commit 行——不改生产代码，
  //   而是在测试脚本里独立重放"旧实现"的落库效果，验证探针本身对这个坏状态有反应（若探针连这个都
  //   测不出，P2 断言就是空转）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const idM1 = await mkIssue('feature', '开发中');
    const daM1 = await mkMember(idM1, 5, '开发甲', 'code_submitted');
    await toLiaisonTestState(idM1, 5, '开发甲');
    must((await commitsOf(daM1)).length === 1, '[M1] 前置：确有 1 条 commit 行');

    // 复刻"修复前"的 liaison_test_return：只重置花名册，commit 行原样不动（即去掉 §5.4 的删除段）。
    await run(
      `UPDATE sys_issue_dev_assignees SET dev_status='pending', resolved_at=NULL, no_code_reason=NULL
        WHERE id=? AND removed_at IS NULL AND dev_status IN ('code_submitted','no_code')`,
      [daM1]
    );
    must((await memberRow(daM1)).dev_status === 'pending', '[M1] 花名册确已重置为 pending（复刻修复前的半步）');
    must((await commitsOf(daM1)).length === 1, '[M1] 复刻"未删 commit 行"：commit 行仍在（人为制造 #55 症状）');

    const results = await runProbes(db);
    const p2 = p2Of(results);
    const redLine = `id=${idM1} dev_assignee_id=${daM1}：P2 pass=${p2.pass} detail="${p2.detail}"`;
    must(p2.pass === false, `[M1] ⭐⭐ 变异自证：去掉 commit 删除段后 P2 必须判红，${redLine}`);
    console.log(`  🔴 [M1] 红灯原文：${JSON.stringify(p2)}`);

    await deleteIssueFully(idM1);
    await selfCertifyProbes('[M1] 清理后应恢复全绿');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [变异自证 M2] 精确 id 集合换成按 issue_id 整体删 ⇒ 多人混合状态用例必须判红
  //   同 M1：不改生产代码，在测试脚本里独立重放"若实现改成按 issue_id 整体删（不加 dev_status 过滤）"
  //   会产生的落库效果，验证 [2] 组的断言口径本身有判别力——真出现这种误实现会被抓到，不是空转。
  // ══════════════════════════════════════════════════════════════════════
  {
    const idM2 = await mkIssue('feature', '开发中');
    const mA = await mkMember(idM2, 5, '开发甲', 'code_submitted');
    const mB = await mkMember(idM2, 6, '开发乙', 'no_code');
    const mC = await mkMember(idM2, 7, '开发丙', 'pending');
    const mD = await mkMember(idM2, 8, '开发丁', 'excused');
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [idM2, mB, 6, 'backend', `fix/seed-${mB}-b`]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [idM2, mC, 7, 'backend', `fix/seed-${mC}-c`]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?,?,?,?,?,datetime('now'))`,
      [idM2, mD, 8, 'backend', `fix/seed-${mD}-d`]);
    must((await commitsOf(mC)).length === 1, '[M2] 前置：C（pending）有 1 条 commit（人为极端态）');
    must((await commitsOf(mD)).length === 1, '[M2] 前置：D（excused）有 1 条 commit（人为极端态）');

    // 复刻"误实现"：花名册按精确 id 集合重置（这部分对，否则 C/D 的 dev_status 会被误改，噪声太大），
    // 但 commit 行删除**故意改成按 issue_id 整体删**——不加 dev_status/id 集合过滤，这正是方案 §5.4
    // 明文禁止的写法："不得按 issue_id 或 dev_user_id 整体删除"。
    await run(
      `UPDATE sys_issue_dev_assignees SET dev_status='pending', resolved_at=NULL, no_code_reason=NULL
        WHERE issue_id=? AND removed_at IS NULL AND dev_status IN ('code_submitted','no_code')`,
      [idM2]
    );
    await run(`DELETE FROM sys_issue_dev_commits WHERE dev_assignee_id IN (SELECT id FROM sys_issue_dev_assignees WHERE issue_id=?)`, [idM2]);

    const cAfter = await commitsOf(mC);
    const dAfter = await commitsOf(mD);
    const redLine = `issue=${idM2}：C(pending,daId=${mC}) commit 行数=${cAfter.length}（应为 1，误实现下变成 0）；D(excused,daId=${mD}) commit 行数=${dAfter.length}（应为 1，误实现下变成 0）`;
    // 判红条件=[2] 组"C/D 不受影响"那两条断言（commitsOf(daC).length===1 / commitsOf(daD).length===1）
    // 在本次刻意误实现下会失败——直接复用同一谓词判断，而非另造一条新逻辑，确保这就是[2]组本该抓到的
    // 那个误删，不是另一件事。
    const wronglyDeleted = (cAfter.length !== 1) || (dAfter.length !== 1);
    must(wronglyDeleted === true, `[M2] ⭐⭐ 变异自证：按 issue_id 整体删后，[2] 组"C/D 不受影响"断言应判红，${redLine}`);
    console.log(`  🔴 [M2] 红灯原文：${redLine}`);

    await deleteIssueFully(idM2);
    await selfCertifyProbes('[M2] 清理后应恢复全绿');
  }

  server.close();
  if (failDetails.length > 0) {
    console.error(`\n❌ verify-sys-liaison-return-commit-cleanup 存在失败项（${failDetails.length}）：`);
    failDetails.forEach(m => console.error('  - ' + m));
    process.exit(1);
  }
  console.log(`\n✅ verify-sys-liaison-return-commit-cleanup 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-liaison-return-commit-cleanup 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
