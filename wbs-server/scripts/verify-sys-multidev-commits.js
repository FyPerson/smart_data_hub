// scripts/verify-sys-multidev-commits.js — C4 验收：commit 行编辑三端点（补充/改/删，四守卫+固定事务序）
//   SSOT = 方案 v2.9 §6.3（四守卫+固定事务序）+ §3 events 规格（commit 事件载荷）+ §10 API 契约 +
//   联合 SSOT §13 验收表 S17/S18/S19/S27/S29/S30/S33/S38。
//   用法：node scripts/verify-sys-multidev-commits.js
//
// 覆盖验收表 S17/S18/S19/S27/S29/S30/S33/S38（四负例）+ 字段校验附加负例（DELETE 缺 reason / POST 字段非法）。
// in-process app + 内存库 + 自签 token，同 verify-sys-multidev-submit.js 范式；每个主要场景 mutate 后跑
// runProbes 自证（复用 C0 探针 P1-P15，非新增探针）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-multidev-commits-secret';
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

async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || '2026-07-01 10:00:00');
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est]
  );
  return r.lastID;
}
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
async function seedCommit(issueId, daId, userId, component, ref) {
  const r = await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [issueId, daId, userId, component, ref]
  );
  return r.lastID;
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  assert.strictEqual(failed.length, 0, `${label}：应满足全部 P1-P15 恒真，实际失败：${JSON.stringify(failed)}`);
  return results;
}
async function devEventsOf(issueId, action) {
  return all(`SELECT id, dev_assignee_id, action, reason, payload_json FROM sys_issue_dev_events WHERE issue_id = ? AND action = ? ORDER BY id`, [issueId, action]);
}
async function commitsOf(issueId) {
  return all(`SELECT id, dev_assignee_id, dev_user_id, component, commit_ref, updated_at FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id`, [issueId]);
}
async function commitRow(commitId) {
  return get(`SELECT id, issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at FROM sys_issue_dev_commits WHERE id = ?`, [commitId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(8,'dev8','开发戊','user')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // S30：补充 commit 正常成功——行落库+event 载荷+归属三元组正确
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');   // 自带 1 条种子 commit（backend）
    const r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 'feat/xyz' });
    assert.strictEqual(r.status, 200, `S30：POST 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const commits = await commitsOf(id);
    assert.strictEqual(commits.length, 2, 'S30：2 条 commit 行（种子1+新增1）');
    const newRow = commits.find(c => c.component === 'frontend');
    assert.strictEqual(newRow.dev_assignee_id, daId, 'S30：归属三元组 dev_assignee_id 正确');
    assert.strictEqual(newRow.dev_user_id, 5, 'S30：归属三元组 dev_user_id 正确');
    const events = await devEventsOf(id, 'add-commit');
    assert.strictEqual(events.length, 1, 'S30：恰 1 条 add-commit 事件');
    const payload = JSON.parse(events[0].payload_json);
    assert.strictEqual(payload.component, 'frontend', 'S30：payload.component 正确');
    assert.strictEqual(payload.commit_ref, 'feat/xyz', 'S30：payload.commit_ref 正确');
    assert.strictEqual(payload.dev_assignee_id, daId, 'S30：payload.dev_assignee_id 正确');
    assert.strictEqual(payload.commit_id, newRow.id, 'S30：payload.commit_id 正确');
    await selfCertifyProbes('S30');
    ok('S30：POST 补充 commit 正常成功——行落库+add-commit 事件载荷+归属三元组正确');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S17：commit 改（DEV∪VERIFY∧本人在册）成功+event(old→new)+updated_at；冻结态→409
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');
    const before = await commitsOf(id);
    const commitId = before[0].id;
    const r = await call('PUT', `/api/sys-issues/${id}/dev/commits/${commitId}`, devTok(5), { component: 'backend', commit_ref: 'r-updated' });
    assert.strictEqual(r.status, 200, `S17：PUT 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const after = await commitRow(commitId);
    assert.strictEqual(after.commit_ref, 'r-updated', 'S17：commit_ref 已更新');
    assert.ok(after.updated_at, 'S17：updated_at 写入');
    const events = await devEventsOf(id, 'edit-commit');
    assert.strictEqual(events.length, 1, 'S17：恰 1 条 edit-commit 事件');
    const payload = JSON.parse(events[0].payload_json);
    assert.strictEqual(payload.old.commit_ref, `fix/seed-${daId}`, 'S17：payload.old 正确');
    assert.strictEqual(payload.new.commit_ref, 'r-updated', 'S17：payload.new 正确');
    await selfCertifyProbes('S17-成功');

    // 冻结态（待上线，RELEASE 族）→ 409
    await run(`UPDATE sys_issues SET status = '待上线' WHERE id = ?`, [id]);
    const r2 = await call('PUT', `/api/sys-issues/${id}/dev/commits/${commitId}`, devTok(5), { component: 'backend', commit_ref: 'r-frozen-attempt' });
    assert.strictEqual(r2.status, 409, `S17：冻结态 PUT 应 409，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_STATUS', 'S17：冻结态错误码 INVALID_STATUS');
    const afterFrozen = await commitRow(commitId);
    assert.strictEqual(afterFrozen.commit_ref, 'r-updated', 'S17：冻结态拒绝后行未被误改');
    ok('S17：commit 改（DEV，本人在册）成功+event(old→new)+updated_at；冻结态（待上线）→409 INVALID_STATUS');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S18：commit 删至 0（code_submitted 实例）→400 GATE_INVARIANT；剩≥1 成功+event 载荷含被删行
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');   // 唯一 1 条种子 commit
    const seedRow = (await commitsOf(id))[0];
    const reasonBody = { reason: '误提交，删除测试' };

    // 删至 0 → 400 GATE_INVARIANT
    const r1 = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${seedRow.id}`, devTok(5), reasonBody);
    assert.strictEqual(r1.status, 400, `S18：删至 0 应 400，实际 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'GATE_INVARIANT', 'S18：错误码 GATE_INVARIANT');
    const stillThere = await commitRow(seedRow.id);
    assert.ok(stillThere, 'S18：删至 0 被拒绝，行仍存在');
    const noEvent = await devEventsOf(id, 'delete-commit');
    assert.strictEqual(noEvent.length, 0, 'S18：删至 0 被拒绝，无 delete-commit 事件');

    // 补一条 commit，剩余 2 条，删其中 1 条 → 成功
    const secondId = await seedCommit(id, daId, 5, 'frontend', 'feat/second');
    const r2 = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${secondId}`, devTok(5), reasonBody);
    assert.strictEqual(r2.status, 200, `S18：剩≥1 应 200，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    const afterCommits = await commitsOf(id);
    assert.strictEqual(afterCommits.length, 1, 'S18：删除后剩 1 条');
    const events = await devEventsOf(id, 'delete-commit');
    assert.strictEqual(events.length, 1, 'S18：恰 1 条 delete-commit 事件');
    assert.strictEqual(events[0].reason, '误提交，删除测试', 'S18：delete-commit 事件 reason 必填且正确');
    const payload = JSON.parse(events[0].payload_json);
    assert.strictEqual(payload.commit_id, secondId, 'S18：payload 含被删行 commit_id');
    assert.strictEqual(payload.component, 'frontend', 'S18：payload 含被删行 component');
    assert.strictEqual(payload.commit_ref, 'feat/second', 'S18：payload 含被删行 commit_ref');
    await selfCertifyProbes('S18');
    ok('S18：commit 删至 0（code_submitted 实例）→400 GATE_INVARIANT；剩≥1 成功+event 载荷含被删行');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S19：增改删他人 user_id 行 → 403 COMMIT_SCOPE（PUT/DELETE 两个子场景；POST 天然自限本人实例，不构成"他人行"）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'code_submitted');   // dev5 own commit
    await mkMember(id, 6, '开发乙', 'code_submitted');   // dev6 rostered（守卫①通过），编辑 dev5 的行触发守卫②
    const dev5Row = (await commitsOf(id)).find(c => c.dev_user_id === 5);

    const rPut = await call('PUT', `/api/sys-issues/${id}/dev/commits/${dev5Row.id}`, devTok(6), { component: 'backend', commit_ref: 'hijack-attempt' });
    assert.strictEqual(rPut.status, 403, `S19：他人行 PUT 应 403，实际 ${rPut.status} ${JSON.stringify(rPut.body)}`);
    assert.strictEqual(rPut.body.code, 'COMMIT_SCOPE', 'S19：PUT 错误码 COMMIT_SCOPE');
    const afterPut = await commitRow(dev5Row.id);
    assert.strictEqual(afterPut.commit_ref, dev5Row.commit_ref, 'S19：PUT 越权后行未被改动');

    const rDel = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${dev5Row.id}`, devTok(6), { reason: '越权删除尝试' });
    assert.strictEqual(rDel.status, 403, `S19：他人行 DELETE 应 403，实际 ${rDel.status} ${JSON.stringify(rDel.body)}`);
    assert.strictEqual(rDel.body.code, 'COMMIT_SCOPE', 'S19：DELETE 错误码 COMMIT_SCOPE');
    const afterDel = await commitRow(dev5Row.id);
    assert.ok(afterDel, 'S19：DELETE 越权后行仍存在');
    await selfCertifyProbes('S19');
    ok('S19：增改删他人 user_id 行 → 403 COMMIT_SCOPE（PUT/DELETE 零副作用；POST 因自限本人在册实例天然无法构造"他人行"）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S27：单人待验证改自己 ref 成功（编辑放宽）；进冻结态再改→409
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');   // 单人 code_submitted 即满足 VERIFY 族（在册≥1∧无pending）
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const row = (await commitsOf(id))[0];
    const r = await call('PUT', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { component: 'backend', commit_ref: 'verify-stage-edit' });
    assert.strictEqual(r.status, 200, `S27：VERIFY 态 PUT 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    await selfCertifyProbes('S27-成功');

    await run(`UPDATE sys_issues SET status = '已上线' WHERE id = ?`, [id]);
    const r2 = await call('PUT', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { component: 'backend', commit_ref: 'released-attempt' });
    assert.strictEqual(r2.status, 409, `S27：已上线态 PUT 应 409，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_STATUS', 'S27：已上线态错误码 INVALID_STATUS');
    ok('S27：单人待验证改自己 ref 成功（编辑放宽）；进冻结态（已上线）再改→409 INVALID_STATUS');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S29：PUT 查重两用例——改成另一行自然键→400；规范化后与自身无变化→400 且无 event/updated_at
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const backendId = await seedCommit(id, daId, 5, 'backend', 'r-backend');
    const frontendId = await seedCommit(id, daId, 5, 'frontend', 'r-frontend');

    // 用例①：改成另一行自然键 → 400
    const r1 = await call('PUT', `/api/sys-issues/${id}/dev/commits/${backendId}`, devTok(5), { component: 'frontend', commit_ref: 'r-frontend' });
    assert.strictEqual(r1.status, 400, `S29①：改成另一行自然键应 400，实际 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'VALIDATION', 'S29①：错误码 VALIDATION');
    const afterR1 = await commitRow(backendId);
    assert.strictEqual(afterR1.component, 'backend', 'S29①：拒绝后行未被改动（component 仍 backend）');
    assert.strictEqual(afterR1.updated_at, null, 'S29①：拒绝后 updated_at 仍 NULL');

    // 用例②：规范化后与自身无变化 → 400，且无 event/updated_at
    const beforeEvents = (await devEventsOf(id, 'edit-commit')).length;
    const r2 = await call('PUT', `/api/sys-issues/${id}/dev/commits/${backendId}`, devTok(5), { component: 'backend', commit_ref: '  r-backend  ' });   // trim 后与自身相同
    assert.strictEqual(r2.status, 400, `S29②：无变化应 400，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'VALIDATION', 'S29②：错误码 VALIDATION');
    const afterR2 = await commitRow(backendId);
    assert.strictEqual(afterR2.updated_at, null, 'S29②：无变化拒绝后 updated_at 仍 NULL（不写 updated_at）');
    const afterEvents = (await devEventsOf(id, 'edit-commit')).length;
    assert.strictEqual(afterEvents, beforeEvents, 'S29②：无变化拒绝后无新增 edit-commit 事件');
    await selfCertifyProbes('S29');
    ok('S29：PUT 查重两用例——改成另一行自然键→400 VALIDATION；规范化后与自身无变化→400 VALIDATION 且无 event/updated_at');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S33：不在册用户编辑旧行 → 403（不在册即冻结）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');
    await mkMember(id, 6, '开发乙', 'pending');   // 保证移除 dev5 后在册仍≥1（P12 恒真）
    const row = (await commitsOf(id))[0];
    await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 12:00:00' WHERE id = ?`, [daId]);   // dev5 变历史参与者

    const r = await call('PUT', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { component: 'backend', commit_ref: 'not-rostered-attempt' });
    assert.strictEqual(r.status, 403, `S33：不在册用户 PUT 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'COMMIT_SCOPE', 'S33：错误码 COMMIT_SCOPE（守卫①，非默认 NOT_ROSTERED）');
    const after = await commitRow(row.id);
    assert.strictEqual(after.commit_ref, row.commit_ref, 'S33：拒绝后行未被改动');
    await selfCertifyProbes('S33');
    ok('S33：不在册用户编辑旧行 → 403 COMMIT_SCOPE（不在册即冻结，守卫①先于守卫②拦下）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S38：commit 编辑负例组（四负例）
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① re-add 为 pending 且名下有旧 commit：POST 拒（新旧实例都不写）
    {
      const id = await mkIssue('feature', '开发中');
      const oldDaId = await mkMember(id, 5, '开发甲', 'code_submitted');   // 首个实例，1 条种子 commit
      await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 09:00:00' WHERE id = ?`, [oldDaId]);
      await mkMember(id, 5, '开发甲', 'pending');   // re-add：新实例 pending
      const before = await commitsOf(id);
      const r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 're-add-try' });
      assert.strictEqual(r.status, 400, `S38①：re-add pending POST 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S38①：错误码 INVALID_STATUS（当前实例非 code_submitted）');
      const after = await commitsOf(id);
      assert.strictEqual(after.length, before.length, 'S38①：新旧实例的 commit 行数均未变化（新旧实例都不写）');
      const events = await devEventsOf(id, 'add-commit');
      assert.strictEqual(events.length, 0, 'S38①：无 add-commit 事件');
    }

    // ② 当前实例 no_code/excused：POST 拒
    {
      const id = await mkIssue('feature', '开发中');
      await mkMember(id, 5, '开发甲', 'no_code');
      const r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 'no-code-try' });
      assert.strictEqual(r.status, 400, `S38②a：no_code 实例 POST 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S38②a：错误码 INVALID_STATUS');
      const commits = await commitsOf(id);
      assert.strictEqual(commits.length, 0, 'S38②a：无 commit 行落库');

      const id2 = await mkIssue('feature', '开发中');
      await mkMember(id2, 6, '开发乙', 'excused');
      const r2 = await call('POST', `/api/sys-issues/${id2}/dev/commits`, devTok(6), { component: 'frontend', commit_ref: 'excused-try' });
      assert.strictEqual(r2.status, 400, `S38②b：excused 实例 POST 应 400，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.code, 'INVALID_STATUS', 'S38②b：错误码 INVALID_STATUS');
      const commits2 = await commitsOf(id2);
      assert.strictEqual(commits2.length, 0, 'S38②b：无 commit 行落库');
    }

    // ③ 跨 issue 路由 PUT/DELETE 他单 commit_id → 403 零副作用
    {
      const idA = await mkIssue('feature', '开发中', { title: 'issueA' });
      await mkMember(idA, 5, '开发甲', 'code_submitted');
      const idB = await mkIssue('feature', '开发中', { title: 'issueB' });
      const daB = await mkMember(idB, 5, '开发甲', 'code_submitted');   // 同一 user_id=5，但挂在 issueB
      const rowB = (await commitsOf(idB))[0];

      // 路由走 issueA（dev5 在 issueA 也在册，守卫①能过），但 commitId 属于 issueB → 守卫②拦下
      const rPut = await call('PUT', `/api/sys-issues/${idA}/dev/commits/${rowB.id}`, devTok(5), { component: 'backend', commit_ref: 'cross-issue-try' });
      assert.strictEqual(rPut.status, 403, `S38③：跨 issue PUT 应 403，实际 ${rPut.status} ${JSON.stringify(rPut.body)}`);
      assert.strictEqual(rPut.body.code, 'COMMIT_SCOPE', 'S38③：PUT 错误码 COMMIT_SCOPE');
      const afterPut = await commitRow(rowB.id);
      assert.strictEqual(afterPut.commit_ref, rowB.commit_ref, 'S38③：PUT 跨 issue 拒绝后行未被改动');

      const rDel = await call('DELETE', `/api/sys-issues/${idA}/dev/commits/${rowB.id}`, devTok(5), { reason: '跨 issue 删除尝试' });
      assert.strictEqual(rDel.status, 403, `S38③：跨 issue DELETE 应 403，实际 ${rDel.status} ${JSON.stringify(rDel.body)}`);
      assert.strictEqual(rDel.body.code, 'COMMIT_SCOPE', 'S38③：DELETE 错误码 COMMIT_SCOPE');
      const afterDel = await commitRow(rowB.id);
      assert.ok(afterDel, 'S38③：DELETE 跨 issue 拒绝后行仍存在');
      assert.strictEqual(afterDel.dev_assignee_id, daB, 'S38③：行归属未变化');
    }

    // ④ 历史参与者 PUT/DELETE 本人旧行 → 403 且行/updated_at/event 零变化
    {
      const id = await mkIssue('feature', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'code_submitted');
      await mkMember(id, 6, '开发乙', 'pending');   // 保证移除 dev5 后在册仍≥1
      const row = (await commitsOf(id))[0];
      await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 12:00:00' WHERE id = ?`, [daId]);

      const rPut = await call('PUT', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { component: 'backend', commit_ref: 'historical-put-try' });
      assert.strictEqual(rPut.status, 403, `S38④：历史参与者 PUT 应 403，实际 ${rPut.status} ${JSON.stringify(rPut.body)}`);
      assert.strictEqual(rPut.body.code, 'COMMIT_SCOPE', 'S38④：PUT 错误码 COMMIT_SCOPE');
      const afterPut = await commitRow(row.id);
      assert.strictEqual(afterPut.commit_ref, row.commit_ref, 'S38④：PUT 拒绝后行未被改动');
      assert.strictEqual(afterPut.updated_at, null, 'S38④：PUT 拒绝后 updated_at 仍 NULL');

      const rDel = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { reason: '历史参与者删除尝试' });
      assert.strictEqual(rDel.status, 403, `S38④：历史参与者 DELETE 应 403，实际 ${rDel.status} ${JSON.stringify(rDel.body)}`);
      assert.strictEqual(rDel.body.code, 'COMMIT_SCOPE', 'S38④：DELETE 错误码 COMMIT_SCOPE');
      const afterDel = await commitRow(row.id);
      assert.ok(afterDel, 'S38④：DELETE 拒绝后行仍存在');
      const events = await devEventsOf(id, 'edit-commit');
      const delEvents = await devEventsOf(id, 'delete-commit');
      assert.strictEqual(events.length, 0, 'S38④：无 edit-commit 事件');
      assert.strictEqual(delEvents.length, 0, 'S38④：无 delete-commit 事件');
    }

    await selfCertifyProbes('S38');
    ok('S38：commit 编辑负例组全四例——①re-add pending POST拒 ②当前实例no_code/excused POST拒 ③跨issue PUT/DELETE 403零副作用 ④历史参与者PUT/DELETE 403零变化');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 附加负例：DELETE 缺 reason → 400；POST 字段非法（component 枚举外/commit_ref 超长/多余字段）→ 400
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const row = (await commitsOf(id))[0];

    // DELETE 缺 reason
    let r = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), {});
    assert.strictEqual(r.status, 400, `DELETE 缺 reason 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'DELETE 缺 reason 错误码 VALIDATION');
    r = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { reason: '   ' });
    assert.strictEqual(r.status, 400, 'DELETE reason 全空白应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'DELETE reason 全空白错误码 VALIDATION');
    let stillThere = await commitRow(row.id);
    assert.ok(stillThere, 'DELETE 缺 reason 拒绝后行仍存在');

    // POST component 枚举外
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'database', commit_ref: 'x' });
    assert.strictEqual(r.status, 400, 'POST component 枚举外应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'POST component 枚举外错误码 VALIDATION');

    // POST commit_ref 超长（201 字符）
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 'x'.repeat(201) });
    assert.strictEqual(r.status, 400, 'POST commit_ref 超长应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'POST commit_ref 超长错误码 VALIDATION');

    // POST commit_ref 空白
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: '   ' });
    assert.strictEqual(r.status, 400, 'POST commit_ref 空白应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'POST commit_ref 空白错误码 VALIDATION');

    // POST 多余字段
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 'x', dev_assignee_id: 999 });
    assert.strictEqual(r.status, 400, 'POST 多余字段应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'POST 多余字段错误码 VALIDATION');

    // POST commit_ref 非字符串（null）
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: null });
    assert.strictEqual(r.status, 400, 'POST commit_ref=null 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'POST commit_ref=null 错误码 VALIDATION');

    // PUT 同款字段校验（component 枚举外）
    r = await call('PUT', `/api/sys-issues/${id}/dev/commits/${row.id}`, devTok(5), { component: 'database', commit_ref: 'x' });
    assert.strictEqual(r.status, 400, 'PUT component 枚举外应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'PUT component 枚举外错误码 VALIDATION');

    const finalCommits = await commitsOf(id);
    assert.strictEqual(finalCommits.length, 1, '全部字段非法负例均写库前拒绝，commit 行数未变化（仍 1 条种子）');
    await selfCertifyProbes('附加字段校验负例');
    ok('附加：DELETE 缺 reason/全空白 → 400 VALIDATION；POST/PUT 字段非法（枚举外/超长/空白/多余字段/null）→ 均 400 VALIDATION（写库前拒绝，§6.1 子集复用）');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-commits 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-commits 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
