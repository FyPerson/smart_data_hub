// scripts/verify-sys-bug-hold-guard.js — S2 验收：bug 暂缓授权守卫 + roster 冻结 + 死锁反证 + bug-only 回归防线
//   SSOT = 系统迭代_bug暂缓_方案_20260803_v0.4.md §4.5 / §4.5b / §5.2 / §10.2 / §10.4
//   用法：node scripts/verify-sys-bug-hold-guard.js
//
// ⚠️ 命名说明：本文件覆盖 S2（引擎内授权守卫 + roster 冻结）；`verify-sys-bug-hold.js` 是 S5 的全流程/
//   全权限矩阵/通知契约收口脚本名，本文件不占用该名字，两者不重复（S2 只测 hold 授权 + 冻结 + 死锁反证 +
//   bug-only 回归，S5 另覆盖 hold→resume→void 全流程/附件/通知）。
//
// 覆盖（真实 HTTP 端点 + in-process app + 内存库）：
//   [A] hold 五角色矩阵（§5.2 必测角色矩阵/§10.2 #6-11）：代表开发/非代表在册开发/admin 允许；
//       非在册开发/失效成员（已移除·已 excuse）403
//   [B] ⭐ 通用路由越权反证（§5.2/§10.2 #12·最重要）：非在册开发直调 /hold（bug hold 唯一 HTTP 入口）
//       → 403 + 状态/timeline/通知列组三者均无变化，证明 assertBugHoldActor 在 UPDATE 之前生效
//   [C] roster 冻结五路由（§4.5/§10.4 #16）：暂缓态 加人/移人(含自移除)/改派/开脱/开脱恢复 全部 409 HOLD_ROSTER_FROZEN
//   [D] ⭐ 死锁反证（§4.5/§10.4 #17）：暂缓 → 尝试移空成员被 409 拦下 → resume 成功
//   [E] 「处理中」态不误伤（§10.4 #18）：非暂缓态五类成员操作正常
//   [F] ⭐ bug-only 回归防线（§4.5/§10.4 #19）：变更流（feature）暂缓单成员操作不受影响
//
// [reassign meta/from 声明侧双向收窄见 verify-sys-meta.js [6]/[6b]（族门-状态级排除唯一权威函数
//   memberActionAuthoritativeStatuses 的写读同源断言），本文件不重复，只测运行时冻结行为侧。]
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-hold-guard-secret';
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
  ...require('./_sys-attach-test-deps'),   // 过工厂期 REQUIRED_DEPS 校验
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
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 造数 helper（同 verify-sys-multidev-members.js 范式：raw SQL 直插，绕开建单端点直接构造目标态）──────
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  // feature/improvement 默认带 OA 号（v2.1 起任何进过指派/开发态的变更流单必有号，同 verify-sys-multidev-members.js 范式）；bug 恒不带。
  const oa = (type === 'feature' || type === 'improvement')
    ? (extra.oaNumber === null ? null : (extra.oaNumber || '20260728300')) : null;
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, oa_number)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est, oa]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueId, userId, userName, extra.isPrimary ? 1 : 0, devStatus,
     extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  return r.lastID;
}
async function setRep(issueId, userId, userName) {
  await run('UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?, assigned_at = datetime(\'now\',\'localtime\') WHERE id = ?', [userId, userName, issueId]);
}
async function activeRoster(issueId) {
  return all(`SELECT id, user_id, dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY user_id ASC`, [issueId]);
}
async function statusOf(issueId) {
  const row = await get('SELECT status FROM sys_issues WHERE id = ?', [issueId]);
  return row && row.status;
}
async function timelineCount(issueId, actionCode) {
  const row = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code=?`, [issueId, actionCode]);
  return row.c;
}

// ── S2b·L-1：完整通知列组快照（主表 creator_notify_* 6 列 + notify_* 6 列 + 子表逐 dev notify_* 6 列）──────
//   越权反证要证"通知列组三者均无变化"，此前只查了 creator_notify_status 一列，名不副实（codex 237 L-1）。
//   S3 即将往 hold/resume 事务里加 §7.4 通知列重置，子表 sys_issue_dev_assignees.notify_* 正是那组要被
//   动的列——先把完整快照钉死，S3 落地后本组断言即是现成的回归防线。
const MAIN_CREATOR_NOTIFY_COLS = ['creator_notify_status', 'creator_notified_at', 'creator_notify_message_key', 'creator_notify_error', 'creator_read_at', 'creator_notify_sent_by'];
const MAIN_DEV_NOTIFY_COLS = ['notify_status', 'notified_at', 'notify_message_key', 'notify_error', 'read_at', 'notify_sent_by'];
const SUB_DEV_NOTIFY_COLS = ['notify_status', 'notified_at', 'read_at', 'notify_message_key', 'notify_error', 'notify_sent_by'];
async function snapshotNotifyGroups(issueId) {
  const mainCols = [...MAIN_CREATOR_NOTIFY_COLS, ...MAIN_DEV_NOTIFY_COLS];
  const main = await get(`SELECT ${mainCols.join(', ')} FROM sys_issues WHERE id = ?`, [issueId]);
  const subRows = await all(
    `SELECT id, user_id, ${SUB_DEV_NOTIFY_COLS.join(', ')} FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id ASC`,
    [issueId]
  );   // 不加 removed_at IS NULL：已移除行的通知痕迹也是"通知列组"的一部分，越权拒绝更不该动它
  return { main, subRows };
}
function assertNotifyGroupsUnchanged(before, after, label) {
  for (const col of [...MAIN_CREATOR_NOTIFY_COLS, ...MAIN_DEV_NOTIFY_COLS]) {
    assert.strictEqual(after.main[col], before.main[col], `${label}：主表 ${col} 无变化`);
  }
  assert.strictEqual(after.subRows.length, before.subRows.length, `${label}：子表 dev_assignees 行数无变化`);
  for (let i = 0; i < before.subRows.length; i++) {
    for (const col of SUB_DEV_NOTIFY_COLS) {
      assert.strictEqual(after.subRows[i][col], before.subRows[i][col], `${label}：子表第${i}行 ${col} 无变化`);
    }
  }
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),
    (5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(8,'dev8','开发丙','user'),
    (10,'dev10','开发丁','user'),(11,'dev11','开发戊','user'),(9,'viewer9','观察员','viewer')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务（admin1 / dev5,6,8,10,11 / viewer9）');

  // ══════════════════════════════════════════════════════════════════════
  // [A] hold 五角色矩阵（方案 §5.2 必测角色矩阵 / §10.2 #6-11）
  // ══════════════════════════════════════════════════════════════════════
  {
    // A1：代表开发（assigned_to 本人）hold → 200
    const id1 = await mkIssue('bug', '处理中');
    await mkMember(id1, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id1}/hold`, devTok(5), { reason: 'A1 代表开发暂缓' });
    assert.strictEqual(r.status, 200, `A1：代表开发 hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已暂缓', 'A1：hold → 已暂缓');
    ok('[A1] 代表开发（assigned_to 本人）hold → 200（口径 #6）');

    // A2：非代表的在册开发 hold → 200
    const id2 = await mkIssue('bug', '处理中');
    await mkMember(id2, 5, '开发甲', 'pending', { isPrimary: true });
    await mkMember(id2, 6, '开发乙', 'pending');
    await setRep(id2, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id2}/hold`, devTok(6), { reason: 'A2 非代表在册开发暂缓' });
    assert.strictEqual(r.status, 200, `A2：非代表在册开发 hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[A2] 非代表的在册开发 hold → 200（口径 #6：任一活跃在册成员，非仅代表）');

    // A3：非在册开发 hold → 403
    const id3 = await mkIssue('bug', '处理中');
    await mkMember(id3, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id3, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id3}/hold`, devTok(8), { reason: 'A3 非在册尝试暂缓' });
    assert.strictEqual(r.status, 403, `A3：非在册开发 hold 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_HOLD', 'A3：错误码 NOT_AUTHORIZED_FOR_HOLD');
    assert.strictEqual(await statusOf(id3), '处理中', 'A3：拒绝后状态未变');
    ok('[A3] 非在册开发 hold → 403 NOT_AUTHORIZED_FOR_HOLD（状态未变）');

    // A4：admin hold → 200（不在册也放行）
    const id4 = await mkIssue('bug', '处理中');
    await mkMember(id4, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id4, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id4}/hold`, adminTok, { reason: 'A4 admin 暂缓' });
    assert.strictEqual(r.status, 200, `A4：admin hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[A4] admin hold → 200（admin 不在册也放行）');

    // A5：失效成员（已移除 removed_at 非空）hold → 403
    const id5 = await mkIssue('bug', '处理中');
    await mkMember(id5, 5, '开发甲', 'pending', { isPrimary: true });
    await mkMember(id5, 10, '开发丁', 'pending', { removedAt: '2026-08-01 00:00:00' });
    await setRep(id5, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id5}/hold`, devTok(10), { reason: 'A5 已移除成员尝试暂缓' });
    assert.strictEqual(r.status, 403, `A5：已移除成员 hold 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_HOLD', 'A5：错误码 NOT_AUTHORIZED_FOR_HOLD');
    ok('[A5] 失效成员（已移除，removed_at 非空）hold → 403 NOT_AUTHORIZED_FOR_HOLD');

    // A6：失效成员（已 excuse，removed_at 仍 NULL）hold → 403
    //   ⚠️ 与方案 §5.2 示例 SQL 的刻意加严一致（见 index.js assertBugHoldActor 注释）：excuse 只改
    //   dev_status 不动 removed_at，若照抄示例 SQL（仅 removed_at IS NULL）会误放行，与 §5.2 必测矩阵
    //   "失效（已移除或已 excuse）403"矛盾——本用例即锁定该加严行为。
    const id6 = await mkIssue('bug', '处理中');
    await mkMember(id6, 5, '开发甲', 'pending', { isPrimary: true });
    await mkMember(id6, 11, '开发戊', 'excused');
    await setRep(id6, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id6}/hold`, devTok(11), { reason: 'A6 已excuse成员尝试暂缓' });
    assert.strictEqual(r.status, 403, `A6：已 excuse 成员 hold 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_HOLD', 'A6：错误码 NOT_AUTHORIZED_FOR_HOLD');
    ok('[A6] 失效成员（已 excuse，dev_status=excused·removed_at 仍 NULL）hold → 403（assertBugHoldActor 加严不照抄 §5.2 示例 SQL，锁定业务意图）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [B] ⭐ 通用路由越权反证（方案 §5.2/§10.2 #12·最重要）：非在册开发直调 /hold（bug hold 唯一 HTTP 入口，
  //   无其它"专用端点"分流）→ 403 + 状态/timeline/通知列组三者均无任何变化，证明 assertBugHoldActor
  //   在 UPDATE 之前生效、无授权真空。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('bug', '处理中');
    await mkMember(id, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id, 5, '开发甲');
    const statusBefore = await statusOf(id);
    const notifyBefore = await snapshotNotifyGroups(id);   // S2b·L-1：完整通知列组快照（主表 12 列 + 子表逐行 6 列）
    const tlBefore = await timelineCount(id, 'hold');
    const r = await call('POST', `/api/sys-issues/${id}/hold`, devTok(8), { reason: 'B 越权尝试' });
    assert.strictEqual(r.status, 403, `B：非在册开发直调 hold 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_HOLD', 'B：错误码 NOT_AUTHORIZED_FOR_HOLD');
    assert.strictEqual(await statusOf(id), statusBefore, 'B：状态无变化');
    const notifyAfter = await snapshotNotifyGroups(id);
    assertNotifyGroupsUnchanged(notifyBefore, notifyAfter, 'B');
    assert.strictEqual(await timelineCount(id, 'hold'), tlBefore, 'B：timeline 无新增 hold 行');
    ok('[B] ⭐ 通用路由越权反证：非在册开发直调 /hold → 403 + 状态/timeline/完整通知列组（主表 creator_notify_*6+notify_*6 + 子表逐 dev notify_*6）均无变化（assertBugHoldActor 在 UPDATE 之前生效，无授权真空，方案 §5.2/§10.2 #12；S2b·L-1 升级为完整快照，为 S3 的 §7.4 通知列重置预置回归防线）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C] roster 冻结五路由（方案 §4.5/§10.4 #16）：bug 单「已暂缓」态下，加人/移人(含自移除)/改派/开脱/
  //   开脱恢复全部 409 HOLD_ROSTER_FROZEN
  // ══════════════════════════════════════════════════════════════════════
  {
    // C1：加人
    const idAdd = await mkIssue('bug', '已暂缓');
    await mkMember(idAdd, 5, '开发甲', 'pending', { isPrimary: true });
    let r = await call('POST', `/api/sys-issues/${idAdd}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 409, `C1：暂缓期加人应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C1：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await activeRoster(idAdd)).length, 1, 'C1：roster 未变（仍 1 人，无副作用）');
    ok('[C1] 暂缓期加人 → 409 HOLD_ROSTER_FROZEN（roster 无副作用）');

    // C2：移人（协调人移除他人）
    const idRemove = await mkIssue('bug', '已暂缓');
    const daRemove = await mkMember(idRemove, 5, '开发甲', 'pending', { isPrimary: true });
    r = await call('DELETE', `/api/sys-issues/${idRemove}/dev-assignees/${daRemove}`, adminTok, { reason: '尝试移除' });
    assert.strictEqual(r.status, 409, `C2：暂缓期移人应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C2：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await activeRoster(idRemove)).length, 1, 'C2：roster 未变');
    ok('[C2] 暂缓期移人（协调人操作） → 409 HOLD_ROSTER_FROZEN');

    // C3：本人自移除（死锁链的真实触发点，不需要误操作即可复现·方案 §4.5 原文）
    const idSelf = await mkIssue('bug', '已暂缓');
    const daSelf = await mkMember(idSelf, 6, '开发乙', 'pending');
    r = await call('DELETE', `/api/sys-issues/${idSelf}/dev-assignees/${daSelf}`, devTok(6), { reason: '本人尝试自移除' });
    assert.strictEqual(r.status, 409, `C3：暂缓期本人自移除应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C3：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await activeRoster(idSelf)).length, 1, 'C3：roster 未变（本人仍在册）');
    ok('[C3] 暂缓期本人自移除 → 409 HOLD_ROSTER_FROZEN（DELETE 授权「协调人∨本人」下，本人自移除同样被冻结拦住）');

    // C4：改派
    const idReassign = await mkIssue('bug', '已暂缓');
    await mkMember(idReassign, 5, '开发甲', 'pending', { isPrimary: true });
    r = await call('POST', `/api/sys-issues/${idReassign}/reassign`, adminTok, { member_ids: [6], reason: '尝试改派' });
    assert.strictEqual(r.status, 409, `C4：暂缓期改派应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C4：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await activeRoster(idReassign))[0].user_id, 5, 'C4：roster 未变（仍是开发甲）');
    ok('[C4] 暂缓期改派 → 409 HOLD_ROSTER_FROZEN');

    // C5：开脱
    const idExcuse = await mkIssue('bug', '已暂缓');
    const daExcuse = await mkMember(idExcuse, 5, '开发甲', 'pending', { isPrimary: true });
    r = await call('POST', `/api/sys-issues/${idExcuse}/dev-assignees/${daExcuse}/excuse`, adminTok, { reason: '尝试开脱' });
    assert.strictEqual(r.status, 409, `C5：暂缓期开脱应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C5：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id=?', [daExcuse])).dev_status, 'pending', 'C5：dev_status 未变（仍 pending）');
    ok('[C5] 暂缓期开脱 → 409 HOLD_ROSTER_FROZEN');

    // C6：开脱恢复（先构造一个已 excused 的成员，再暂缓，再尝试 supersede-excuse）
    const idSupersede = await mkIssue('bug', '已暂缓');
    const daSupersede = await mkMember(idSupersede, 5, '开发甲', 'excused', { isPrimary: true });
    r = await call('POST', `/api/sys-issues/${idSupersede}/dev-assignees/${daSupersede}/supersede-excuse`, adminTok, { reason: '尝试开脱恢复' });
    assert.strictEqual(r.status, 409, `C6：暂缓期开脱恢复应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'C6：错误码 HOLD_ROSTER_FROZEN');
    const rowC6 = await get('SELECT dev_status, superseded_by FROM sys_issue_dev_assignees WHERE id=?', [daSupersede]);
    assert.strictEqual(rowC6.dev_status, 'excused', 'C6：dev_status 未变（仍 excused）');
    assert.strictEqual(rowC6.superseded_by, null, 'C6：superseded_by 未被写入（无新增行，无副作用）');
    ok('[C6] 暂缓期开脱恢复 → 409 HOLD_ROSTER_FROZEN（五路由全覆盖：加人/移人(含自移除)/改派/开脱/开脱恢复）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [D] ⭐ 死锁反证（方案 §4.5/§10.4 #17）：暂缓 → 尝试移空成员被 409 拦下 → resume 成功
  //   旧死锁链：D_PRE 允许移空 → resume 撞 enteringDev（rosterActiveCount>=1）→ 400 → 永久卡死，
  //   唯一出口只剩不可逆 void。冻结方案下，"移空"这一步本身先被拦住，roster 从未真的变空，resume 自然
  //   不会撞门——本用例直接证明链条已断。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('bug', '处理中');
    const daId = await mkMember(id, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: 'D 暂缓准备验证死锁反证' });
    assert.strictEqual(r.status, 200, `D：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId}`, adminTok, { reason: 'D 尝试移空成员' });
    assert.strictEqual(r.status, 409, `D：尝试移空成员应被拦 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ROSTER_FROZEN', 'D：错误码 HOLD_ROSTER_FROZEN');
    assert.strictEqual((await activeRoster(id)).length, 1, 'D：roster 从未真的变空');
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'D 验证 resume 成功' });
    assert.strictEqual(r.status, 200, `D：⭐ resume 应 200（死锁已消除）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', 'D：resume 回到处理中');
    ok('[D] ⭐ 死锁反证：暂缓 → 尝试移空成员被 409 拦下 → resume 成功（roster 从未真的变空，死锁链已断，方案 §4.5）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [E] 「处理中」态成员操作仍正常（方案 §10.4 #18·冻结不误伤非暂缓态）
  // ══════════════════════════════════════════════════════════════════════
  {
    // E1：加人
    const idAdd = await mkIssue('bug', '处理中');
    await mkMember(idAdd, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(idAdd, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${idAdd}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `E1：处理中态加人应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[E1] 「处理中」态加人仍正常（200，未被冻结误伤）');

    // E2：移人
    const idRemove = await mkIssue('bug', '处理中');
    await mkMember(idRemove, 5, '开发甲', 'pending', { isPrimary: true });
    const daRemove6 = await mkMember(idRemove, 6, '开发乙', 'pending');
    await setRep(idRemove, 5, '开发甲');
    r = await call('DELETE', `/api/sys-issues/${idRemove}/dev-assignees/${daRemove6}`, adminTok, { reason: '移除测试' });
    assert.strictEqual(r.status, 200, `E2：处理中态移人应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[E2] 「处理中」态移人仍正常（200）');

    // E3：改派
    const idReassign = await mkIssue('bug', '处理中');
    await mkMember(idReassign, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(idReassign, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${idReassign}/reassign`, adminTok, { member_ids: [8], reason: '改派测试' });
    assert.strictEqual(r.status, 200, `E3：处理中态改派应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[E3] 「处理中」态改派仍正常（200）');

    // E4：开脱
    const idExcuse = await mkIssue('bug', '处理中');
    const daExcuse = await mkMember(idExcuse, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(idExcuse, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${idExcuse}/dev-assignees/${daExcuse}/excuse`, adminTok, { reason: '开脱测试' });
    assert.strictEqual(r.status, 200, `E4：处理中态开脱应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[E4] 「处理中」态开脱仍正常（200）');

    // E5：开脱恢复
    const idSupersede = await mkIssue('bug', '处理中');
    const daSupersede = await mkMember(idSupersede, 5, '开发甲', 'excused', { isPrimary: true });
    await setRep(idSupersede, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${idSupersede}/dev-assignees/${daSupersede}/supersede-excuse`, adminTok, { reason: '开脱恢复测试' });
    assert.strictEqual(r.status, 200, `E5：处理中态开脱恢复应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[E5] 「处理中」态开脱恢复仍正常（200，方案 §10.4 #18：冻结不误伤非暂缓态）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [F] ⭐ bug-only 回归防线（方案 §4.5/§10.4 #19）：变更流（feature）暂缓单成员操作不受影响——
  //   assertRosterNotFrozen 只在 issueType==='bug' 时生效，变更流「已暂缓」的成员操作是既有已上线行为，
  //   绝不能受本方案影响（S2 新增守卫的唯一回归风险点）。
  //   ⚠️ 范围说明（试跑首次实测发现，非猜测）：变更流「已暂缓」归 D_PRE 族，五类成员动作里只有
  //   add/remove 的族门含 D_PRE（MEMBER_ACTION_FAMILY_MATRIX 基础矩阵）；reassign 对 feature/improvement
  //   有 TYPE_OVERRIDE 排除 D_PRE（既有设计，S1 之前就有——"变更流声明式改派仅开放 DEV/VERIFY"）；
  //   excuse（族=['DEV']）/supersede（族=['DEV','VERIFY']）从未把 D_PRE 纳入族门，与 hold/暂缓无关。
  //   故这三个动作在变更流「已暂缓」态**从来就是** 409 INVALID_STATUS（族不匹配，早于本方案存在），
  //   与本方案的 bug-only 冻结守卫无关，不属于本条回归断言的覆盖范围——只测 add/remove 这两个真正
  //   "暂缓期仍可达"的动作，确认它们未被 S2 新增的 assertRosterNotFrozen（bug-only）误伤。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '已暂缓');
    await mkMember(id, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `F：变更流暂缓单加人应 200（bug-only 不误伤）, got ${r.status} ${JSON.stringify(r.body)}`);
    const da6 = (await activeRoster(id)).find(m => m.user_id === 6).id;
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${da6}`, adminTok, { reason: '移除测试' });
    assert.strictEqual(r.status, 200, `F：变更流暂缓单移人应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[F] ⭐ 变更流（feature）暂缓单加人/移人（族门真含 D_PRE 的两类动作）仍 200，未被 bug-only 守卫误伤（方案 §4.5/§10.4 #19，回归防线；reassign/excuse/supersede 因既有族门设计本就不含 D_PRE，与本方案无关，不纳入本用例）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [G] S2b·M-1（codex 237）：dev_status 只读脏值扫描——全库 sys_issue_dev_assignees.dev_status 须
  //   非 NULL 且 ∈ ('pending','code_submitted','no_code','excused')。
  //   背景：assertBugHoldActor 的 SQL 用 `AND dev_status != 'excused'` 精确排除已开脱成员；SQLite 里
  //   `NULL != 'excused'` 不为 true，若真出现 dev_status IS NULL 的行，该行会被这条件连带排除（即被误判
  //   为"非活跃"，403 拒绝一个本该合法的在册开发）。主会话已核实前提不成立：`index.js:1048` 该列 ALTER
  //   是 `TEXT NOT NULL DEFAULT 'pending'`（ADD COLUMN 带 NOT NULL DEFAULT 会自动回填旧行），本地库
  //   实测 37 行、NULL 行数 0，生产 sys_issues 0 行——**不改 assertBugHoldActor 的 SQL**（改成
  //   `dev_status IS NULL OR dev_status != 'excused'` 会把"真出现 NULL"这个信号吞掉，而 NULL 出现
  //   意味着 ALTER 迁移出了问题，那是该响亮失败的事，不该被静默兼容）。
  //   本组断言是 NOT NULL 约束的**可观测性补偿**（范式同 v1.133.0 verify-sys-oa-exempt.js [⑭]）——
  //   一旦红灯，说明迁移出了问题（列迁移未生效/被绕过），而非业务数据异常，需要立即排查迁移路径，
  //   不是去改 assertBugHoldActor 的 SQL 来"兼容" NULL。
  // ══════════════════════════════════════════════════════════════════════
  {
    const dirty = await get(
      `SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE dev_status IS NULL OR dev_status NOT IN ('pending','code_submitted','no_code','excused')`
    );
    assert.strictEqual(dirty.c, 0, `[G] dev_status 脏值扫描应为 0，实际=${dirty.c}（NULL 或值域外——若非 0，说明 ALTER 迁移出了问题，需排查迁移路径，不是改 assertBugHoldActor 的 SQL 兼容）`);
    ok('[G] 脏值扫描：全库 sys_issue_dev_assignees.dev_status 非 NULL 且 ∈ (pending/code_submitted/no_code/excused)（NOT NULL 约束的可观测性补偿，S2b·M-1）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 bug 暂缓授权守卫 + roster 冻结 + 死锁反证 + bug-only 回归防线验证通过（S2/S2b）`);
  console.log('  覆盖：[A]hold五角色矩阵(代表/非代表在册/非在册/admin/失效已移除/失效已excuse) + [B]通用路由越权反证(状态/timeline/完整通知列组三者无变化) + [C]roster冻结五路由(加人/移人含自移除/改派/开脱/开脱恢复) + [D]死锁反证(移空被拦→resume成功) + [E]处理中态不误伤 + [F]变更流bug-only回归防线 + [G]dev_status脏值扫描');
  server.close();
  db.close();
}

main().catch((err) => {
  console.error('\n[失败]', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  try { server && server.close(); } catch (_) {}
  process.exitCode = 1;
});
