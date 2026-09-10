// scripts/verify-sys-submit-withdraw.js — 开发撤回提交验收（POST /sys-issues/:id/submit/withdraw）
//   SSOT = docs/local/系统迭代/开发撤回提交_方案_20260910_v1.2.md §5（七级校验顺序§5.6/事务十步§5.3/
//   审计载荷冻结§5.9/验证矩阵§7）
//   用法：直接 `node scripts/verify-sys-submit-withdraw.js`
//
// in-process app + 内存库 + 自签 token，同 verify-sys-submit-amend.js 范式。夹具一律走真实 HTTP 端点
// （建单直连 SQL + POST /submit 拿到真实 submit/no_code 事件），仅"查无事件 500"用例刻意直连 SQL 伪造
// dev_status（模拟数据不变量被绕过的异常态，验证 fail-closed 行为，非常规路径）。
'use strict';

process.env.SYS_TEST_HOOKS = '1';   // 与其余 sys verify 脚本一致（虽本脚本未用注入钩子，保持环境一致）

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-submit-withdraw-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// [事务回滚·补审] 单点失败注入——本模块无 __testHooks（那是 amend 端点专属的生产钩子），改在 sqlite3
// 驱动层拦截：`run()` 包装器每次调用都经 `db.run(...)`（属性动态查找，非闭包捕获的函数引用），故临时
// 替换 `db.run` 属性即可让"匹配的 SQL 第 N 次出现时"在真正执行前失败，且不改动任何生产代码。
// matcher：字符串＝对 sql 文本做子串匹配；函数＝`(sql, params) => boolean`，用于需要按绑定参数区分
// （如 insertDevEvent 对不同 action 复用同一句 SQL 文本，只能靠 params[3]===action 区分）。occurrence
// （默认 1）＝匹配命中的第几次才真正失败，之前的命中放行——用于"第一条已落库、第二条才失败"这类场景。
// 返回 `{ result, injected }`——injected 显式告知调用方注入是否真的命中过，调用方必须断言它为 true，
// 防止匹配条件写错导致"根本没触发注入，端点因别的原因失败"的假通过。finally 无条件复原 db.run，防
// 某个用例异常时驱动层被永久污染、拖坏后续所有用例。
async function withInjectedDbRunFailure(matcher, fn, occurrence = 1) {
  const test = typeof matcher === 'function' ? matcher : (sql) => typeof sql === 'string' && sql.includes(matcher);
  const originalRun = db.run.bind(db);
  let seen = 0;
  let injected = false;
  db.run = function (sql, params, cb) {
    if (!injected && test(sql, params)) {
      seen++;
      if (seen === occurrence) {
        injected = true;
        return cb(new Error('INJECTED_TEST_FAILURE: ' + (typeof matcher === 'string' ? matcher : `occurrence#${occurrence}`)));
      }
    }
    return originalRun(sql, params, cb);
  };
  let result;
  try {
    result = await fn();
  } finally {
    db.run = originalRun;
  }
  return { result, injected };
}

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

// ── 夹具（同 verify-sys-submit-amend.js 范式）──────────────────────────────────────────
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, estimated_effort_days, intake_liaison_id)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, 13)`,
    [type, status, extra.title || `${type}-${status}-单`, est, effort]
  );
  return r.lastID;
}
async function mkPending(issueId, userId, userName) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
    [issueId, userId, userName]
  );
  return r.lastID;
}
async function memberRowOf(issueId, userId) {
  return get(`SELECT * FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, userId]);
}
async function issueRowOf(issueId) {
  return get(`SELECT * FROM sys_issues WHERE id=?`, [issueId]);
}
async function commitsOf(daId) {
  return all(`SELECT id, component, commit_ref FROM sys_issue_dev_commits WHERE dev_assignee_id=? ORDER BY id`, [daId]);
}
async function deleteCommitEventsOf(daId) {
  return all(`SELECT id, payload_json FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action='delete-commit' ORDER BY id`, [daId]);
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

// 建 code_submitted 实例：pending → 真实 /submit(mode=commits) → 返回 {issueId, daId, userId, tok, latestEventId}
async function mkCommitsSubmitted(type, status, userId, extra = {}) {
  const issueId = extra.issueId || await mkIssue(type, status, extra);
  if (extra.keepInDev) await mkPending(issueId, userId + 1000, `搭子${userId}`);
  await mkPending(issueId, userId, `开发${userId}`);
  const tok = devTok(userId);
  const body = { mode: 'commits', commits: extra.commits || [{ component: 'backend', commit_ref: `svn-${issueId}-${userId}` }, { component: 'backend', commit_ref: `svn-${issueId}-${userId}-2` }], self_tested: true, test_env_deployed: true };
  if (type === 'bug') body.bug_cause_note = extra.bugCauseNote || 'verify 夹具：bug 产生原因';
  if (extra.workNote) body.work_note = extra.workNote;
  const r = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
  if (r.status !== 200) throw new Error(`[夹具-commits 提交] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const daId = r.body.dev_assignee_id;
  const evtRow = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daId]);
  return { issueId, daId, userId, tok, latestEventId: evtRow.id };
}
// 建 no_code 实例
async function mkNoCodeSubmitted(type, status, userId, extra = {}) {
  const issueId = extra.issueId || await mkIssue(type, status, extra);
  if (extra.keepInDev) await mkPending(issueId, userId + 1000, `搭子${userId}`);
  await mkPending(issueId, userId, `开发${userId}`);
  const tok = devTok(userId);
  const reason = extra.reason || (type === 'config' ? '配置已在测试环境验证完成，符合上线要求' : 'verify 夹具：无代码交付说明');
  const body = { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true };
  if (type === 'bug') body.bug_cause_note = 'verify 夹具：bug 产生原因';
  const r = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
  if (r.status !== 200) throw new Error(`[夹具-no_code 提交] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const daId = r.body.dev_assignee_id;
  const evtRow = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daId]);
  return { issueId, daId, userId, tok, latestEventId: evtRow.id };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev5','开发甲','user','13800000005'),
    (6,'dev6','开发乙','user','13800000006'),(9,'dev9','开发丙（非在册）','user','13800000009'),
    (13,'liaison13','示例对接人','user','19900000024')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // 【准入矩阵】
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① code_submitted 可撤（bug 单人团队，submit 后 W-GATE 自动进「待验证」）
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const before = await issueRowOf(issueId);
    must(before.status === '待验证', `[准入①夹具] bug 单人团队 commits 提交后应自动进「待验证」，实得=${before.status}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '发现遗漏了一处修改，需重新提交', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[准入①] code_submitted 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const member = await memberRowOf(issueId, 5);
    must(member.dev_status === 'pending', `[准入①] 撤回后 dev_status 应回 pending，实得=${member.dev_status}`);
    const after = await issueRowOf(issueId);
    must(after.status === '处理中', `[准入①·W-GATE 弹回] 撤回后主状态应弹回开发族「处理中」，实得=${after.status}`);
    await deleteIssueFully(issueId);
  }
  {
    // ② no_code 可撤（improvement 单人团队）
    const { issueId, tok, latestEventId } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const before = await issueRowOf(issueId);
    must(before.status === '待验证', `[准入②夹具] improvement 单人团队 no_code 提交后应自动进「待验证」，实得=${before.status}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '无代码说明填错了，需要重写', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[准入②] no_code 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const member = await memberRowOf(issueId, 5);
    must(member.dev_status === 'pending' && member.no_code_reason === null, `[准入②] 撤回后 dev_status=pending 且 no_code_reason 已清，实得=${JSON.stringify(member)}`);
    await deleteIssueFully(issueId);
  }
  {
    // ③ pending 撤回 409 NOT_SUBMITTED（在册但从未提交）
    const issueId = await mkIssue('bug', '处理中', {});
    await mkPending(issueId, 5, '开发5');
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(5), { reason: '还没提交就想撤回', expected_submit_event_id: 1 });
    must(r.status === 409 && r.body.code === 'NOT_SUBMITTED', `[准入③] pending 撤回应 409 NOT_SUBMITTED, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // ④ 非在册 403 FORBIDDEN
    const { issueId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(9), { reason: '我不在这单的开发名单里', expected_submit_event_id: 1 });
    must(r.status === 403 && r.body.code === 'FORBIDDEN', `[准入④] 非在册撤回应 403 FORBIDDEN, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // ⑤ 待上线态（RELEASE 族）409 STATE_NOT_ALLOWED_FOR_WITHDRAW——负向对照
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '待上线了还想撤回', expected_submit_event_id: latestEventId });
    must(r.status === 409 && r.body.code === 'STATE_NOT_ALLOWED_FOR_WITHDRAW', `[准入⑤] 待上线态撤回应 409 STATE_NOT_ALLOWED_FOR_WITHDRAW, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【权限先于业务】非在册 ∧ 主状态也不允许 ⇒ 403（非 409）
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId } = await mkCommitsSubmitted('bug', '处理中', 5);
    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(9), { reason: '非在册且主状态也不允许', expected_submit_event_id: 1 });
    must(r.status === 403 && r.body.code === 'FORBIDDEN', `[权限先于业务] 非在册+状态禁止应 403 FORBIDDEN（非 409）, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【理由校验】codex 551 M 回填——把生产代码的理由必填/长度校验整段删掉，此前全部断言无一变红（所有
  //   夹具都带合法理由）。补齐缺失/纯空白/非字符串（数字/对象）/300 码点边界通过/301 码点边界拒绝，
  //   每条断言具体错误码，并断言失败请求没有修改成员状态/commit 行/timeline（失败必须无副作用）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const snap = async () => ({
      member: await memberRowOf(issueId, 5),
      commitsLen: (await commitsOf(daId)).length,
      tlCount: (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length,
    });
    const assertNoSideEffect = async (before, label) => {
      const after = await snap();
      must(JSON.stringify(after.member) === JSON.stringify(before.member), `${label}：成员状态不应被修改，前=${JSON.stringify(before.member)}，后=${JSON.stringify(after.member)}`);
      must(after.commitsLen === before.commitsLen, `${label}：commit 行数不应变化，前=${before.commitsLen}，后=${after.commitsLen}`);
      must(after.tlCount === before.tlCount, `${label}：timeline 行数不应增加，前=${before.tlCount}，后=${after.tlCount}`);
    };

    // ① 缺失 reason
    let before = await snap();
    let r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { expected_submit_event_id: latestEventId });
    must(r.status === 400 && r.body.code === 'WITHDRAW_REASON_REQUIRED', `[理由校验①] 缺失 reason 应 400 WITHDRAW_REASON_REQUIRED, got ${r.status} ${JSON.stringify(r.body)}`);
    await assertNoSideEffect(before, '[理由校验①无副作用]');

    // ② 纯空白字符串（trim 后为空）
    before = await snap();
    r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '   \t\n  ', expected_submit_event_id: latestEventId });
    must(r.status === 400 && r.body.code === 'WITHDRAW_REASON_REQUIRED', `[理由校验②] 纯空白 reason（trim 后为空）应 400 WITHDRAW_REASON_REQUIRED, got ${r.status} ${JSON.stringify(r.body)}`);
    await assertNoSideEffect(before, '[理由校验②无副作用]');

    // ③ 非字符串——数字
    before = await snap();
    r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: 12345, expected_submit_event_id: latestEventId });
    must(r.status === 400 && r.body.code === 'WITHDRAW_REASON_REQUIRED', `[理由校验③] reason 为数字（非字符串）应 400 WITHDRAW_REASON_REQUIRED, got ${r.status} ${JSON.stringify(r.body)}`);
    await assertNoSideEffect(before, '[理由校验③无副作用]');

    // ④ 非字符串——对象
    before = await snap();
    r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: { foo: 'bar' }, expected_submit_event_id: latestEventId });
    must(r.status === 400 && r.body.code === 'WITHDRAW_REASON_REQUIRED', `[理由校验④] reason 为对象（非字符串）应 400 WITHDRAW_REASON_REQUIRED, got ${r.status} ${JSON.stringify(r.body)}`);
    await assertNoSideEffect(before, '[理由校验④无副作用]');

    // ⑤ 300 码点边界——应通过（边界含），并核对 timeline summary 完整落原文（非截断）
    const reason300 = 'x'.repeat(300);
    r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: reason300, expected_submit_event_id: latestEventId });
    must(r.status === 200, `[理由校验⑤] 300 码点理由应通过（边界含），got ${r.status} ${JSON.stringify(r.body)}`);
    const tlRow300 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='dev_withdraw' ORDER BY id DESC LIMIT 1`, [issueId]);
    must(!!tlRow300 && tlRow300.summary === `开发撤回提交：${reason300}`, `[理由校验⑤] timeline summary 应完整落 300 码点理由原文（非截断），实得长度=${tlRow300 && tlRow300.summary.length}`);
    await deleteIssueFully(issueId);
  }
  {
    // ⑥ 301 码点边界——应拒绝（边界不含，独立夹具）
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const before = {
      member: await memberRowOf(issueId, 5),
      commitsLen: (await commitsOf(daId)).length,
      tlCount: (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length,
    };
    const reason301 = 'x'.repeat(301);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: reason301, expected_submit_event_id: latestEventId });
    must(r.status === 400 && r.body.code === 'WITHDRAW_REASON_TOO_LONG', `[理由校验⑥] 301 码点理由应 400 WITHDRAW_REASON_TOO_LONG（边界不含）, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = {
      member: await memberRowOf(issueId, 5),
      commitsLen: (await commitsOf(daId)).length,
      tlCount: (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length,
    };
    must(JSON.stringify(after.member) === JSON.stringify(before.member) && after.commitsLen === before.commitsLen && after.tlCount === before.tlCount,
      `[理由校验⑥无副作用] 失败请求不应修改成员态/commit 行/timeline，前=${JSON.stringify(before)}，后=${JSON.stringify(after)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【错误优先级·pending+状态禁止】方案 §5.6 点名但未测的组合——在册但从未提交（pending）∧ 主状态也
  //   不允许（如「待上线」）⇒ 按七级顺序应先撞第④级主状态准入，返回 409 STATE_NOT_ALLOWED_FOR_WITHDRAW，
  //   不是第⑤级的 409 NOT_SUBMITTED（顺序颠倒会让"是哪个原因不让撤"这条诊断信息失真）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中', {});
    await mkPending(issueId, 5, '开发5');
    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(5), { reason: 'pending+状态禁止组合验证', expected_submit_event_id: 1 });
    must(r.status === 409 && r.body.code === 'STATE_NOT_ALLOWED_FOR_WITHDRAW', `[错误优先级] pending+状态禁止应 409 STATE_NOT_ALLOWED_FOR_WITHDRAW（第④级先于第⑤级 NOT_SUBMITTED），got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【令牌】缺令牌 400 / 错令牌 409 / 查无事件 500
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const r1 = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '缺令牌' });
    must(r1.status === 400 && r1.body.code === 'VALIDATION', `[令牌] 缺 expected_submit_event_id 应 400 VALIDATION, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '令牌非正整数', expected_submit_event_id: 0 });
    must(r2.status === 400 && r2.body.code === 'VALIDATION', `[令牌] expected_submit_event_id=0 应 400 VALIDATION, got ${r2.status} ${JSON.stringify(r2.body)}`);
    // [M4 回填] 令牌重放须用"陈旧但真实"的 id（e1），不用凭空捏造的 999999——999999 只能证明"实现会拒绝
    // 一个不存在的 id"，证明不了"实现真的按『须等于最新那条』判定"（一个错把判据写成"须属于本实例某条
    // 历史事件"而非"须等于最新那条"的实现，喂 999999 照样能正确拒绝，喂真实旧 id 才会露馅：会误判通过）。
    // 构造：submit(e1) → amend(e2，同实例产生第二条 submit 事件） → 带 e1 撤回 ⇒ 应 409（e1 已非最新）。
    const amendR = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: 'M4 令牌回放夹具：修正一次产生新事件 e2' });
    must(amendR.status === 200, `[令牌夹具] amend 应 200（产生新事件 e2，令其晚于 e1）, got ${amendR.status} ${JSON.stringify(amendR.body)}`);
    const r3 = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '令牌不符（携带陈旧但真实存在的旧令牌 e1）', expected_submit_event_id: latestEventId });
    must(r3.status === 409 && r3.body.code === 'WITHDRAW_TARGET_CHANGED', `[令牌·M4] 携带陈旧但真实的旧令牌（e1，已被 amend 产生的 e2 取代）应 409 WITHDRAW_TARGET_CHANGED，非静默放行，got ${r3.status} ${JSON.stringify(r3.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // 查无事件 500：直连 SQL 把 dev_status 硬改成 code_submitted，绕过 submit 端点，不产生任何事件
    // （模拟数据不变量被绕过的异常态——正常业务路径不可达，验证 fail-closed 不静默放行）。
    const issueId = await mkIssue('bug', '处理中', {});
    const daId = await mkPending(issueId, 5, '开发5');
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted' WHERE id=?`, [daId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(5), { reason: '查无提交事件的异常态', expected_submit_event_id: 1 });
    must(r.status === 500 && r.body.code === 'WITHDRAW_NO_SUBMIT_EVENT', `[令牌] 查无 submit/no_code 事件应 500 WITHDRAW_NO_SUBMIT_EVENT, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【done 阻断】有 done 行 ⇒ 409 FAST_RELEASE_EXECUTED
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
       VALUES (?, 1, '管理员', 'done', datetime('now','localtime'), 1, '管理员')`,
      [issueId]
    );
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '已有先行上线执行确认', expected_submit_event_id: latestEventId });
    must(r.status === 409 && r.body.code === 'FAST_RELEASE_EXECUTED', `[done 阻断] 存在 done 行应 409 FAST_RELEASE_EXECUTED, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // [M12 回填] done 阻断三条语义的第二条——历史软删行（removed_at 非空）不阻断：把 `AND removed_at
    // IS NULL` 删掉，本用例应变红（会把已经不算数的历史软删 done 行也当成"部署执行进行中"挡下来）。
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name, removed_at, removed_by, removed_by_name)
       VALUES (?, 1, '管理员', 'done', datetime('now','localtime'), 1, '管理员', datetime('now','localtime'), 1, '管理员')`,
      [issueId]
    );
    const r2 = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '历史软删 done 行不应阻断', expected_submit_event_id: latestEventId });
    must(r2.status === 200, `[done 阻断·M12] 历史软删的 done 行（removed_at 非空）不应阻断撤回，应 200，got ${r2.status} ${JSON.stringify(r2.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【CAS 后效果】dev_status='pending'、resolved_at/no_code_reason 已清、commit 行已删且每行有对应
  //   delete-commit 事件（via='withdraw'）
  // ══════════════════════════════════════════════════════════════════════
  {
    const bugCauseNoteFixture = 'CAS 后效果测试：bug 产生原因';
    const workNoteFixture = 'CAS 后效果测试：工作说明';
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5, { bugCauseNote: bugCauseNoteFixture, workNote: workNoteFixture });
    const commitsBefore = await commitsOf(daId);
    must(commitsBefore.length === 2, `[CAS 后效果夹具] 提交时应有 2 条 commit 行，实得=${commitsBefore.length}`);
    const memberBefore = await memberRowOf(issueId, 5);
    must(memberBefore.resolved_at !== null, `[CAS 后效果夹具] 提交后 resolved_at 应非空`);
    // [M3 回填] 撤回前独立读一次 delivery_rev（走详情端点，与撤回端点内部 computeDeliveryRev 同源
    // 实现——不直接调用内部函数，走真实 HTTP 响应，逼近真实前端读到的值），供下方与审计快照逐字核对。
    const detailBefore = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    const deliveryRevBefore = detailBefore.body.issue.delivery_rev;
    must(typeof deliveryRevBefore === 'string' && /^e\d+-a\d+-n\d+$/.test(deliveryRevBefore), `[CAS 后效果夹具] 撤回前 delivery_rev 应为合法格式，实得=${JSON.stringify(deliveryRevBefore)}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: 'commit 记录填错了，需重新整理', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[CAS 后效果] 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const memberAfter = await memberRowOf(issueId, 5);
    must(memberAfter.dev_status === 'pending', `[CAS 后效果] dev_status 应为 pending，实得=${memberAfter.dev_status}`);
    must(memberAfter.resolved_at === null, `[CAS 后效果] resolved_at 应已清空，实得=${memberAfter.resolved_at}`);
    must(memberAfter.no_code_reason === null, `[CAS 后效果] no_code_reason 应已清空，实得=${memberAfter.no_code_reason}`);
    const commitsAfter = await commitsOf(daId);
    must(commitsAfter.length === 0, `[CAS 后效果] commit 行应已全部删除，实得剩余=${commitsAfter.length}`);
    const delEvents = await deleteCommitEventsOf(daId);
    must(delEvents.length === 2, `[CAS 后效果] 应有 2 条 delete-commit 事件（逐行留痕，非单条汇总），实得=${delEvents.length}`);
    const viaSet = new Set(delEvents.map(e => { try { return JSON.parse(e.payload_json).via; } catch (_) { return null; } }));
    must(viaSet.size === 1 && viaSet.has('withdraw'), `[CAS 后效果] delete-commit 事件 via 应恒为 'withdraw'，实得=${JSON.stringify([...viaSet])}`);
    // [审计完整性回填·codex 551 M] 按 commit_id 精确三方比对（撤回前真实行 / 逐行 delete-commit 事件 /
    // 审计快照 commits），不再只比 component+commit_ref 集合——旧写法"填错 commit_id 编号照样通过"
    // （只要 component/commit_ref 集合凑得齐，编号张冠李戴测不出来）。
    const beforeById = new Map(commitsBefore.map(c => [c.id, { component: c.component, commit_ref: c.commit_ref }]));
    must(beforeById.size === 2, `[审计完整性] 撤回前应有 2 条互不相同 commit_id 的真实行，实得=${JSON.stringify([...beforeById.keys()])}`);
    const delEventById = new Map();
    for (const e of delEvents) {
      let p; try { p = JSON.parse(e.payload_json); } catch (_) { p = {}; }
      delEventById.set(p.commit_id, { component: p.component, commit_ref: p.commit_ref, dev_assignee_id: p.dev_assignee_id });
    }
    must(delEventById.size === 2, `[审计完整性] delete-commit 事件应覆盖 2 个互不相同的 commit_id，实得=${JSON.stringify([...delEventById.keys()])}`);
    for (const [commitId, beforeRow] of beforeById) {
      const ev = delEventById.get(commitId);
      must(!!ev, `[审计完整性] commit_id=${commitId} 应有对应的 delete-commit 事件（非"凑够 2 条但编号对不上"），实得事件覆盖的 commit_id=${JSON.stringify([...delEventById.keys()])}`);
      must(!!ev && ev.component === beforeRow.component && ev.commit_ref === beforeRow.commit_ref, `[审计完整性] commit_id=${commitId} 的 delete-commit 事件 component/commit_ref 应与撤回前真实行逐字一致，真实=${JSON.stringify(beforeRow)}，事件=${JSON.stringify(ev)}`);
      must(!!ev && ev.dev_assignee_id === daId, `[审计完整性] commit_id=${commitId} 的 delete-commit 事件 dev_assignee_id 应等于本实例 id，期望=${daId}，实得=${ev && ev.dev_assignee_id}`);
    }
    // 审计快照 timeline 校验（§5.9）——[M3 回填] 四字段逐字断言（549-M2 原话"漏了 bug_cause_note"，
    // 夹具明明填了却没验），不再只验存在性/双勾。
    const tlRow = await get(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='dev_withdraw' ORDER BY id DESC LIMIT 1`, [issueId]);
    must(!!tlRow && tlRow.event_type === 'note', `[CAS 后效果] 应写一条 event_type='note' + action_code='dev_withdraw' 的 timeline 行`);
    const auditPayload = tlRow ? JSON.parse(tlRow.payload_json) : {};
    must(auditPayload.dev_status_before === 'code_submitted', `[审计快照] dev_status_before 应为 code_submitted，实得=${auditPayload.dev_status_before}`);
    must(auditPayload.withdrawn_event_id === latestEventId, `[审计快照] withdrawn_event_id 应等于令牌值，实得=${auditPayload.withdrawn_event_id}`);
    must(auditPayload.delivery_rev_before === deliveryRevBefore, `[审计快照·M3] delivery_rev_before 应逐字等于撤回前详情端读到的值，期望=${deliveryRevBefore}，实得=${auditPayload.delivery_rev_before}`);
    must(auditPayload.work_note === workNoteFixture, `[审计快照·M3] work_note 应逐字等于夹具填写值，期望=${JSON.stringify(workNoteFixture)}，实得=${JSON.stringify(auditPayload.work_note)}`);
    must(auditPayload.no_code_reason === null, `[审计快照·M3] no_code_reason 应为 null（commits 模式不产生该字段），实得=${JSON.stringify(auditPayload.no_code_reason)}`);
    must(auditPayload.bug_cause_note === bugCauseNoteFixture, `[审计快照·M3] bug_cause_note 应逐字等于夹具填写值，期望=${JSON.stringify(bugCauseNoteFixture)}，实得=${JSON.stringify(auditPayload.bug_cause_note)}`);
    must(auditPayload.checks && auditPayload.checks.self_tested === true && auditPayload.checks.test_env_deployed === true, `[审计快照] checks 双勾应如实映射 true/true，实得=${JSON.stringify(auditPayload.checks)}`);
    // [审计完整性回填] 审计快照 commits 按 commit_id 与撤回前真实行逐字比对（不再只比长度）。
    const auditCommitById = new Map((auditPayload.commits || []).map(c => [c.commit_id, { component: c.component, commit_ref: c.commit_ref }]));
    must(auditCommitById.size === 2, `[审计完整性] 审计快照 commits 应含 2 个互不相同的 commit_id，实得=${JSON.stringify(auditPayload.commits)}`);
    for (const [commitId, beforeRow] of beforeById) {
      const snap = auditCommitById.get(commitId);
      must(!!snap && snap.component === beforeRow.component && snap.commit_ref === beforeRow.commit_ref, `[审计完整性] 审计快照 commits 里 commit_id=${commitId} 应逐字等于撤回前真实行，真实=${JSON.stringify(beforeRow)}，快照=${JSON.stringify(snap)}`);
    }
    // [M1 回填] 探针在真撤回、真删表之前跑一次——终检段跑在全部 deleteIssueFully 之后是恒真断言（空表
    // 上 P1-P16 必然全绿），本处对着刚发生过 commit 行删除+CAS 的真实非空库状态验一次 P2「pending 配对」。
    await selfCertifyProbes('[CAS 后效果段内探针]');
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【历史缺键语义】M3 回填——payload 无双勾键的历史事件撤回后，checks 应映射 null（不得补成 false/
  //   true，§5.9 加粗警告"把未知写成已确认是伪造留痕"）。判别力提示：若把 index.js 的
  //   strictBoolFromPayloadValue 整个换成 `(v)=>!!v`，本组两条断言应翻红（!!undefined===false，会把
  //   "未知"误判成"已确认未通过"）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中', {});
    const daId = await mkPending(issueId, 5, '开发5');
    // 直连 SQL 造"历史缺键"事件（早期数据模型未落双勾字段时的真实历史形态，payload 里根本不存在
    // self_tested/test_env_deployed 两键，非"键存在但值为 false"）。
    const evtRes = await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
       VALUES (?, ?, 'submit', ?, ?, datetime('now','localtime'))`,
      [issueId, daId, 5, JSON.stringify({ mode: 'commits', commits: [{ commit_id: 1, component: 'backend', commit_ref: 'legacy-1' }], dev_assignee_id: daId, bug_cause_note: '历史缺键：bug 原因' })]
    );
    const evtId = evtRes.lastID;
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE id=?`, [daId]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 5, 'backend', 'legacy-1', datetime('now','localtime'))`, [issueId, daId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(5), { reason: '历史缺键语义验证', expected_submit_event_id: evtId });
    must(r.status === 200, `[历史缺键语义] 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const tlRow = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='dev_withdraw' ORDER BY id DESC LIMIT 1`, [issueId]);
    const auditPayload = JSON.parse(tlRow.payload_json);
    must(auditPayload.checks && auditPayload.checks.self_tested === null, `[历史缺键语义] payload 无 self_tested 键时 checks.self_tested 应映射 null（不得补成 false/true），实得=${JSON.stringify(auditPayload.checks)}`);
    must(auditPayload.checks && auditPayload.checks.test_env_deployed === null, `[历史缺键语义] payload 无 test_env_deployed 键时 checks.test_env_deployed 应映射 null，实得=${JSON.stringify(auditPayload.checks)}`);
    must(auditPayload.bug_cause_note === '历史缺键：bug 原因', `[历史缺键语义] bug_cause_note 应仍如实映射（与双勾缺失互不影响），实得=${JSON.stringify(auditPayload.bug_cause_note)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【W-GATE 弹回】feature 单开发单撤回后主状态从「待对接测试」（LIAISON_TEST 族）回到开发族
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('feature', '开发中', 5);
    const before = await issueRowOf(issueId);
    must(before.status === '待对接测试', `[W-GATE 弹回夹具] feature 单人团队提交后应天然到「待对接测试」，实得=${before.status}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '发现漏改了一处，撤回重做', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[W-GATE 弹回] LIAISON_TEST 族撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await issueRowOf(issueId);
    must(after.status === '开发中', `[W-GATE 弹回] 撤回后主状态应弹回开发族「开发中」，实得=${after.status}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【不该动的字段】return_count / sys_issues.first_submitted_at / reopen_count（业务轮次代理列）/
  //   dev_estimated_at 撤回前后不变（W5/W6/§5.8）
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const before = await issueRowOf(issueId);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '验证不该动的字段', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[不该动字段夹具] 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await issueRowOf(issueId);
    must(after.return_count === before.return_count, `[不该动字段] return_count 应不变（W5：自查非打回），前=${before.return_count}，后=${after.return_count}`);
    must(after.reopen_count === before.reopen_count, `[不该动字段] reopen_count 应不变（撤回不是新一轮），前=${before.reopen_count}，后=${after.reopen_count}`);
    must(after.first_submitted_at === before.first_submitted_at && before.first_submitted_at !== null, `[不该动字段] sys_issues.first_submitted_at 应不变（W6：历史事实，issue 级"首次提交"盖章列，非本文件详情端 devAssignee 级同名派生字段），前=${before.first_submitted_at}，后=${after.first_submitted_at}`);
    must(after.dev_estimated_at === before.dev_estimated_at, `[不该动字段] dev_estimated_at 应不变（撤回≠打回，不清 ETA），前=${before.dev_estimated_at}，后=${after.dev_estimated_at}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【代表重选】549-H2——现任代表已不在册时，撤回把该实例改回 pending 会改变选举分支②
  //   「在册 pending 最小 user_id」的候选集合，赢家应据此重算（§5.3 步骤 d）
  // ══════════════════════════════════════════════════════════════════════
  {
    // B(6) 先提交（此刻 A 仍 pending，electRepresentative 选举分支②"在册 pending 最小 user_id"→选中 A，
    // assigned_to=A）；A(5) 后提交完成团队（electRepresentative 分支①"现任仍在册"→维持 A）。此时
    // assigned_to=A，两人均 code_submitted，主状态到「待验证」（bug 双人团队全完成）。
    const issueId = await mkIssue('bug', '处理中', {});
    await mkPending(issueId, 5, '开发A');
    await mkPending(issueId, 6, '开发B');
    const subB = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'backend', commit_ref: `rep-${issueId}-B` }], self_tested: true, test_env_deployed: true, bug_cause_note: 'B 的 bug 原因' });
    must(subB.status === 200, `[代表重选夹具] B 先提交应 200, got ${subB.status} ${JSON.stringify(subB.body)}`);
    const daA = await memberRowOf(issueId, 5);
    const subA = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'backend', commit_ref: `rep-${issueId}-A` }], self_tested: true, test_env_deployed: true, bug_cause_note: 'A 的 bug 原因' });
    must(subA.status === 200, `[代表重选夹具] A 后提交应 200, got ${subA.status} ${JSON.stringify(subA.body)}`);
    const beforeIssue = await issueRowOf(issueId);
    must(beforeIssue.assigned_to === 5 && beforeIssue.status === '待验证', `[代表重选夹具] 双人团队全完成后 assigned_to 应为 A(5)（选举分支①"现任仍在册"维持）且主状态到「待验证」，实得 assigned_to=${beforeIssue.assigned_to} status=${beforeIssue.status}`);
    // 直连 SQL 把 A 标记移出（**不经任何端点**，刻意不触发 electRepresentative——模拟"现任代表已不在册
    // 但 sys_issues.assigned_to 仍是旧值"的既有陈旧态，把"选举重算"这件事完整留给撤回端点自己的
    // electRepresentative 调用去做，不被前置操作提前消化掉）。
    await run(`UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime') WHERE id = ?`, [daA.id]);
    const daB = await memberRowOf(issueId, 6);
    const evtB = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daB.id]);
    // [M2 回填·2026-09-10 Opus 预筛] notify_status 默认即 'not_sent'、notified_at/read_at 默认即 NULL——
    // 若不预先把三列写成非默认值，"应重置为默认值"这条断言全程无判别力（不动它也会通过）。直连 SQL
    // 模拟"代表变更前，dev 侧通知已发送且已被读"的真实前置态，只有 electRepresentative 真的执行了重置
    // 才会把它们打回默认值。
    await run(`UPDATE sys_issues SET notify_status='sent', notified_at=datetime('now','localtime'), read_at=datetime('now','localtime'), notify_message_key='msg-fixture', notify_error='old-error-fixture' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(6), { reason: '代表重选场景：B 撤回', expected_submit_event_id: evtB.id });
    must(r.status === 200, `[代表重选] B 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterIssue = await issueRowOf(issueId);
    must(afterIssue.assigned_to === 6, `[代表重选] 现任代表 A 已不在册（raw SQL 移出）+ B 撤回回 pending → 选举分支②"在册 pending 最小 user_id"应选中 B(6)，实得 assigned_to=${afterIssue.assigned_to}`);
    must(afterIssue.assigned_to_name === '开发B', `[代表重选] assigned_to_name 应同步更新为 B，实得=${afterIssue.assigned_to_name}`);
    must(afterIssue.notify_status === 'not_sent' && afterIssue.notified_at === null && afterIssue.read_at === null && afterIssue.notify_message_key === null && afterIssue.notify_error === null,
      `[代表重选] 代表实变（A→B）前该五列已被 fixture 写成非默认值（sent/非空时刻/非空文本），撤回应同事务把它们重置回默认值，实得 notify_status=${afterIssue.notify_status} notified_at=${afterIssue.notified_at} read_at=${afterIssue.read_at} notify_message_key=${afterIssue.notify_message_key} notify_error=${afterIssue.notify_error}`);
    await deleteIssueFully(issueId);
  }
  // ⚠️ 判别力已用真实变异验证：临时注释掉 index.js 撤回端点内 `await electRepresentative(id);`
  // 那一行后重跑本脚本，上面 [代表重选] 用例组的 3 条断言（assigned_to/assigned_to_name/通知五列）
  // 全部由绿转红（afterIssue.assigned_to 仍是旧值 5，非期望的 6）；复原该行后重跑，同组用例恢复全绿。
  // 红灯原文与复原后的绿灯原文均已贴入本次交付报告，不作为脚本内嵌断言（该行为构造上无法在不改
  // 生产代码的前提下从脚本内部临时摘除——electRepresentative 是本文件内 `function` 声明的直接标识符
  // 引用，非经 _internals 对象转发调用，重赋值 _internals.electRepresentative 不会影响端点内部真实
  // 调用哪个函数体）。

  // ══════════════════════════════════════════════════════════════════════
  // 【授权终结】§5.5——无 done 但有活跃先行上线授权时，撤回应同事务终结授权 + 软删执行人集合 + 独立留痕
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    // 直连 SQL 造"活跃授权但无 done 行"前置态（先行上线仅服务 bug 类型；六列判据同 isActiveFastReleaseAuth）。
    await run(
      `UPDATE sys_issues SET fast_release_auth_at = datetime('now','localtime'), fast_release_auth_by = 1,
              fast_release_auth_by_name = '管理员', fast_release_auth_note = 'verify 授权 fixture' WHERE id = ?`,
      [issueId]
    );
    // 挂一个 pending（非 done）执行人——用于观察 clearFastReleaseRosterOnTermination 是否真的把它软删。
    await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, added_by, added_by_name)
       VALUES (?, 6, '执行人丙', 'pending', 1, '管理员')`,
      [issueId]
    );
    const before = await issueRowOf(issueId);
    must(before.fast_release_auth_at !== null, `[授权终结夹具] 应已挂活跃授权，实得 fast_release_auth_at=${before.fast_release_auth_at}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '有活跃授权但无 done 行，撤回应能成功', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[授权终结] 无 done 有活跃授权时撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await issueRowOf(issueId);
    must(after.fast_release_auth_at === null && after.fast_release_auth_by === null && after.fast_release_auth_by_name === null && after.fast_release_auth_note === null,
      `[授权终结] 六列应已清空，实得 auth_at=${after.fast_release_auth_at} auth_by=${after.fast_release_auth_by} auth_by_name=${after.fast_release_auth_by_name} auth_note=${after.fast_release_auth_note}`);
    const execRow = await get(`SELECT removed_at FROM sys_fast_release_executors WHERE issue_id=? AND user_id=6`, [issueId]);
    must(execRow && execRow.removed_at !== null, `[授权终结] clearFastReleaseRosterOnTermination 应已软删执行人集合行，实得 removed_at=${execRow && execRow.removed_at}`);
    const terminatedTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_auth_terminated'`, [issueId]);
    must(!!terminatedTl, `[授权终结] 应有 action_code='fast_release_auth_terminated' 的独立 timeline 留痕行`);
    const rosterClearedTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_roster_cleared'`, [issueId]);
    must(!!rosterClearedTl, `[授权终结] 应有 action_code='fast_release_roster_cleared' 的独立 timeline 留痕行`);
    // [M1 回填] 同上——对着刚发生过授权终结+执行人软删的真实非空库状态验一次探针（终检段跑在全部
    // deleteIssueFully 之后是恒真断言）。
    await selfCertifyProbes('[授权终结段内探针]');
    await deleteIssueFully(issueId);
  }
  // ⚠️ 判别力已用真实变异验证：临时把 index.js 撤回端点内 `if (isActiveFastReleaseAuth(row)) { ... }`
  // 授权终结整段判空/注释掉（或仅注释其内部清六列 UPDATE 那一句）后重跑本脚本，上面 [授权终结] 用例组
  // 断言（六列清空/执行人软删/两条独立 timeline 留痕）全部由绿转红；复原后重跑恢复全绿。红灯原文与
  // 复原后的绿灯原文均已贴入本次交付报告。

  // ══════════════════════════════════════════════════════════════════════
  // 【过期分叉】HIGH 回填（Opus 预筛）——`isActiveFastReleaseAuth` 只判"六列残留"不含时间。可达场景：
  //   bug 单授权→开发窗口内 submit 挂牌→执行人一直没确认→次日 08:00 授权过期（六列仍残留）→开发撤回。
  //   此刻应走**超时收回**（terminateExpiredFastReleaseAuthInTxn 内核，写 fast_release_auth_expired
  //   留痕），而非误记成**人为终结**（fast_release_auth_terminated）——两者是完全不同的审计事实，
  //   前者统计"超时未启用授权"，后者统计"人为主动终结"，记混了会让前一项统计系统性少计。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    // 造"活跃授权但已过期"——fast_release_auth_at 设为两天前，必然已过"授权日次日 08:00"消费窗口，
    // 但六列本身仍残留（未撤销/未消费/released_at 仍空），isActiveFastReleaseAuth 判定仍为真。
    await run(
      `UPDATE sys_issues SET fast_release_auth_at = datetime('now','localtime','-2 days'), fast_release_auth_by = 1,
              fast_release_auth_by_name = '管理员', fast_release_auth_note = 'HIGH 回填：过期授权 fixture' WHERE id = ?`,
      [issueId]
    );
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '过期分叉验证：授权已过期仍残留', expected_submit_event_id: latestEventId });
    must(r.status === 200, `[过期分叉·HIGH] 撤回应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const expiredTl = await get(`SELECT id, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_auth_expired'`, [issueId]);
    must(!!expiredTl, `[过期分叉·HIGH] 应走超时收回内核，产生 action_code='fast_release_auth_expired' 的独立留痕，实得=${JSON.stringify(expiredTl)}`);
    const terminatedTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_auth_terminated'`, [issueId]);
    must(!terminatedTl, `[过期分叉·HIGH] 不应误记成人为终结 action_code='fast_release_auth_terminated'，实得=${JSON.stringify(terminatedTl)}`);
    const after = await issueRowOf(issueId);
    must(after.fast_release_auth_at === null && after.fast_release_auth_by === null, `[过期分叉·HIGH] 六列应经超时内核清空，实得 auth_at=${after.fast_release_auth_at} auth_by=${after.fast_release_auth_by}`);
    await deleteIssueFully(issueId);
  }
  // ⚠️ 判别力已用真实变异验证：临时把 index.js 撤回端点内 c) 段的"过期分叉判断"强制走窗口内分支
  // （即把 `if (!isConsumableFastReleaseAuth(row, withdrawFastReleaseNowStr))` 改成
  // `if (false)`，逼所有场景（含本组这条"已过期"夹具）都落 else 半边的既有内联三件套）后重跑本脚本，
  // 上面 [过期分叉·HIGH] 用例组 3 条断言全部由绿转红（错误地产生了 fast_release_auth_terminated 而非
  // fast_release_auth_expired，六列虽然也被清空但走的是错误的成因）；复原后重跑恢复全绿。红灯原文与
  // 复原后的绿灯原文均已贴入本次交付报告。

  // ══════════════════════════════════════════════════════════════════════
  // 【展示失效】C0-3——撤回后详情端不得把该成员的旧交付内容当"当前交付"展示；同响应体内仍处
  //   code_submitted 的对照组成员内容不受影响（防"为了过滤把好的也滤掉"）；latest_submit_event_id
  //   任意 dev_status 均如实返回（撤回令牌来源，不受展示过滤影响）
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中', {});
    await mkPending(issueId, 5, '开发A');
    await mkPending(issueId, 6, '开发B');
    const subA = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'backend', commit_ref: `disp-${issueId}-A` }], self_tested: true, test_env_deployed: true, work_note: 'A的工作说明', bug_cause_note: 'A的bug原因' });
    must(subA.status === 200, `[展示失效夹具] A 提交应 200, got ${subA.status} ${JSON.stringify(subA.body)}`);
    const subB = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'backend', commit_ref: `disp-${issueId}-B` }], self_tested: true, test_env_deployed: true, work_note: 'B的工作说明（即将被撤回）', bug_cause_note: 'B的bug原因（即将被撤回）' });
    must(subB.status === 200, `[展示失效夹具] B 提交应 200, got ${subB.status} ${JSON.stringify(subB.body)}`);
    const daB = await memberRowOf(issueId, 6);
    const evtB = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daB.id]);
    const withdrawR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, devTok(6), { reason: '展示失效验证：B 撤回', expected_submit_event_id: evtB.id });
    must(withdrawR.status === 200, `[展示失效夹具] B 撤回应 200, got ${withdrawR.status} ${JSON.stringify(withdrawR.body)}`);

    const detail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detail.status === 200, `[展示失效] 详情 GET 应 200, got ${detail.status}`);
    const das = detail.body.dev_assignees || [];
    const dA = das.find(d => d.user_id === 5);
    const dB = das.find(d => d.user_id === 6);
    must(!!dA && !!dB, `[展示失效] 详情应含 A/B 两条在册实例，实得=${JSON.stringify(das.map(d => d.user_id))}`);
    // 撤回方（B）：旧交付内容不得再被当作"当前交付"展示
    must(dB.dev_status === 'pending', `[展示失效] B 的 dev_status 应为 pending，实得=${dB.dev_status}`);
    must(dB.work_note === null, `[展示失效] 撤回后 B 的 work_note 应为 null（不得展示已撤回历史为当前交付），实得=${JSON.stringify(dB.work_note)}`);
    must(dB.bug_cause_note === null, `[展示失效] 撤回后 B 的 bug_cause_note 应为 null，实得=${JSON.stringify(dB.bug_cause_note)}`);
    must(dB.self_tested === null && dB.test_env_deployed === null, `[展示失效] 撤回后 B 的双勾应为 null，实得 self_tested=${JSON.stringify(dB.self_tested)} test_env_deployed=${JSON.stringify(dB.test_env_deployed)}`);
    must(dB.latest_submit_event_id === evtB.id, `[展示失效] B 的 latest_submit_event_id 应仍如实返回该实例最新事件 id（撤回令牌来源，不受展示过滤影响），期望=${evtB.id}，实得=${dB.latest_submit_event_id}`);
    // 对照组（A）：未受影响，内容照常返回——证明过滤没有"把好的也滤掉"
    must(dA.dev_status === 'code_submitted', `[展示失效·对照组] A 的 dev_status 应仍为 code_submitted，实得=${dA.dev_status}`);
    must(dA.work_note === 'A的工作说明', `[展示失效·对照组] A 的 work_note 应照常返回，实得=${JSON.stringify(dA.work_note)}`);
    must(dA.bug_cause_note === 'A的bug原因', `[展示失效·对照组] A 的 bug_cause_note 应照常返回，实得=${JSON.stringify(dA.bug_cause_note)}`);
    must(dA.self_tested === true && dA.test_env_deployed === true, `[展示失效·对照组] A 的双勾应照常返回 true/true，实得 self_tested=${JSON.stringify(dA.self_tested)} test_env_deployed=${JSON.stringify(dA.test_env_deployed)}`);
    must(typeof dA.latest_submit_event_id === 'number' && dA.latest_submit_event_id > 0, `[展示失效·对照组] A 的 latest_submit_event_id 应如实返回正整数，实得=${JSON.stringify(dA.latest_submit_event_id)}`);
    // [M6 回填] bcRows（bug_cause_records 顶层数组，独立于上面 dev_assignees[].bug_cause_note 的另一条
    // 读路径）同样受 C0-3 过滤——此前【展示失效】只查过 dev_assignees[]，从没读过这个字段，把
    // index.js 里那条 WHERE 追加条件整句删掉，本组用例此前会一条都不变红。
    const bcRecords = detail.body.bug_cause_records || [];
    must(!bcRecords.some(rec => rec.user_id === 6), `[展示失效·M6] bug_cause_records 不应再含 B(6) 已撤回的记录，实得=${JSON.stringify(bcRecords)}`);
    const bcA = bcRecords.find(rec => rec.user_id === 5);
    must(!!bcA && bcA.bug_cause_note === 'A的bug原因' && bcA.removed === false, `[展示失效·M6·对照组] bug_cause_records 应仍含 A(5) 的记录且内容/removed 标记不受影响，实得=${JSON.stringify(bcA)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【展示失效·codex 551 HIGH 回归】上一轮 M7 只改了 workNoteRows，bcRows 仍用旧的 dev_status 判据——
  //   同一详情响应体自相矛盾：workNoteRows 已按"是否真撤回"放行，bcRows 却按旧判据把内容滤掉（或反
  //   过来）。本组用**真实业务动作**（对接测试打回 liaison-test-return）验证 work_note 这一半，用
  //   **等价直连 SQL 构造**验证 bug_cause_note/bug_cause_records 这一半——原因见下方注释。
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① 真实业务场景：feature 单人团队提交（带 work_note）→ 对接测试打回（liaison-test-return，真实
    //   HTTP 调用，非模拟）→ 断言 work_note 仍展示（这正是 M7 最初要修的既有功能回归：开发要照着旧
    //   工作说明改，不该看不到）。
    const liaisonTok = jwt.sign({ id: 13, username: 'liaison13', display_name: '示例对接人', role: 'user' }, SECRET);
    const { issueId: issueId1, tok: tok1 } = await mkCommitsSubmitted('feature', '开发中', 5, { workNote: 'M7 真实场景：对接测试打回前的工作说明' });
    const before1 = await issueRowOf(issueId1);
    must(before1.status === '待对接测试', `[M7 真实场景夹具] feature 单人团队提交后应到「待对接测试」，实得=${before1.status}`);
    const returnR = await call('POST', `/api/sys-issues/${issueId1}/liaison-test-return`, liaisonTok, { reason: 'M7 真实场景：对接测试打回' });
    must(returnR.status === 200, `[M7 真实场景夹具] liaison-test-return 应 200, got ${returnR.status} ${JSON.stringify(returnR.body)}`);
    const detail1 = await call('GET', `/api/sys-issues/${issueId1}`, adminTok);
    const d1 = (detail1.body.dev_assignees || []).find(x => x.user_id === 5);
    must(!!d1 && d1.dev_status === 'pending', `[M7 真实场景] 打回后 dev_status 应为 pending，实得=${d1 && d1.dev_status}`);
    must(!!d1 && d1.work_note === 'M7 真实场景：对接测试打回前的工作说明', `[M7 真实场景] 对接测试打回（非撤回）后 work_note 应仍展示，实得=${JSON.stringify(d1 && d1.work_note)}`);
    // 同一单再走一次真实撤回（此刻 A 已是 pending，需先重新走 submit 才能撤回；改走直连 SQL 精确
    // 复刻"撤回"净效果——直接验证撤回场景下 work_note 应隐藏，不必再绕一次真实 submit 往返）。
    const daId1 = (await memberRowOf(issueId1, 5)).id;
    const evt1 = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daId1]);
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE id=?`, [daId1]);
    const withdrawR1 = await call('POST', `/api/sys-issues/${issueId1}/submit/withdraw`, tok1, { reason: 'M7 真实场景：随后真实撤回', expected_submit_event_id: evt1.id });
    must(withdrawR1.status === 200, `[M7 真实场景] 撤回应 200, got ${withdrawR1.status} ${JSON.stringify(withdrawR1.body)}`);
    const detail1b = await call('GET', `/api/sys-issues/${issueId1}`, adminTok);
    const d1b = (detail1b.body.dev_assignees || []).find(x => x.user_id === 5);
    must(!!d1b && d1b.work_note === null, `[M7 真实场景] 真实撤回后 work_note 应隐藏，实得=${JSON.stringify(d1b && d1b.work_note)}`);
    await deleteIssueFully(issueId1);

    // ② bug_cause_note/bug_cause_records 这一半——⚠️ 说明：codex 点名的字面场景是"bug 单走对接测试
    //   打回"，但该组合在当前代码库结构上不可达：liaison-test-return 只服务 LIAISON_TEST 族，而
    //   status-families.js 明文 `SYS_LIAISON_TEST_STATUSES.bug = []`（bug 单永远到不了「待对接测试」
    //   态）；bug_cause_note/bug_cause_records 反过来只服务 bug 类型（submit 端点按 type 门控，非 bug
    //   携带即 400 BUG_CAUSE_NOT_APPLICABLE）。两个前提互斥，无法用一次真实 HTTP 调用同时满足。改用
    //   与本文件既有"查无事件 500"用例同款的直连 SQL 手法，构造"dev_status 回 pending 但并非经由真
    //   撤回（不产生 dev_withdraw timeline 行）"这一等价前置态——这正是 workNoteRows/bcRows 判据要
    //   处理的真实矛盾维度本身（dev_status 不能再作判据，只有 timeline.dev_withdraw 记录才能），与
    //   具体触发该状态的业务动作叫什么名字无关。若需要针对 bug 类型的百分百真实业务动作复现，目前
    //   代码库里不存在这样的路径，需先确认是否要为 bug 类型另开一条"非撤回的 pending 回退"业务通道
    //   才谈得上"真实复现"——本组用例改证明的是判据本身统一，而非声称找到了这样一条路径。
    const issueId2 = await mkIssue('bug', '处理中', {});
    const daId2 = await mkPending(issueId2, 5, '开发5');
    const evtRes2 = await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
       VALUES (?, ?, 'submit', ?, ?, datetime('now','localtime'))`,
      [issueId2, daId2, 5, JSON.stringify({ mode: 'commits', commits: [{ commit_id: 1, component: 'backend', commit_ref: 'bc-unify-1' }], dev_assignee_id: daId2, bug_cause_note: 'bcRows 判据统一验证：bug 原因', self_tested: true, test_env_deployed: true })]
    );
    const evtId2 = evtRes2.lastID;
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE id=?`, [daId2]);
    await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 5, 'backend', 'bc-unify-1', datetime('now','localtime'))`, [issueId2, daId2]);
    // 非撤回的 pending 回退（不写 dev_withdraw timeline 行）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending', resolved_at=NULL WHERE id=?`, [daId2]);
    const detail2 = await call('GET', `/api/sys-issues/${issueId2}`, adminTok);
    const d2 = (detail2.body.dev_assignees || []).find(x => x.user_id === 5);
    must(!!d2 && d2.bug_cause_note === 'bcRows 判据统一验证：bug 原因', `[bcRows 判据统一] 非撤回的 pending 回退后，成员字段 bug_cause_note 应仍保留，实得=${JSON.stringify(d2 && d2.bug_cause_note)}`);
    const bc2 = (detail2.body.bug_cause_records || []).find(r => r.dev_assignee_id === daId2);
    must(!!bc2 && bc2.bug_cause_note === 'bcRows 判据统一验证：bug 原因', `[bcRows 判据统一] 非撤回的 pending 回退后，顶层 bug_cause_records 也应仍保留该记录（与成员字段判据一致，不再各写一套），实得=${JSON.stringify(detail2.body.bug_cause_records)}`);
    // 现在走真实撤回——两者应双双隐藏。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE id=?`, [daId2]);
    const withdrawR2 = await call('POST', `/api/sys-issues/${issueId2}/submit/withdraw`, devTok(5), { reason: 'bcRows 判据统一验证：真实撤回', expected_submit_event_id: evtId2 });
    must(withdrawR2.status === 200, `[bcRows 判据统一夹具] 真实撤回应 200, got ${withdrawR2.status} ${JSON.stringify(withdrawR2.body)}`);
    const detail2b = await call('GET', `/api/sys-issues/${issueId2}`, adminTok);
    const d2b = (detail2b.body.dev_assignees || []).find(x => x.user_id === 5);
    must(!!d2b && d2b.bug_cause_note === null, `[bcRows 判据统一] 真实撤回后，成员字段 bug_cause_note 应隐藏，实得=${JSON.stringify(d2b && d2b.bug_cause_note)}`);
    const bc2b = (detail2b.body.bug_cause_records || []).find(r => r.dev_assignee_id === daId2);
    must(!bc2b, `[bcRows 判据统一] 真实撤回后，顶层 bug_cause_records 也应不再含该记录，实得=${JSON.stringify(detail2b.body.bug_cause_records)}`);
    await deleteIssueFully(issueId2);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【竞态双向（确定性①②）+ 并发冒烟检查（③）】①②用确定的调用顺序分别证明"撤回先完成⇒旧验收
  //   请求按新状态被拒（无副作用）"与"验收先完成⇒撤回按新状态被拒"两个方向，是本组真正的双向证明；
  //   ③（codex 551 M14 降级）只是外加的并发冒烟检查，不再声称"双向成立"——见③自身注释。
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① 确定性顺序 A：撤回先完成 → 旧验收请求（假定仍是「待验证」的心智）应被新状态拒绝，无副作用。
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const withdrawR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '竞态①：撤回先完成', expected_submit_event_id: latestEventId });
    must(withdrawR.status === 200, `[竞态①] 撤回应先成功, got ${withdrawR.status} ${JSON.stringify(withdrawR.body)}`);
    const acceptR = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, {});
    must(acceptR.status === 400 && acceptR.body.code === 'INVALID_TRANSITION', `[竞态①] 撤回先完成后，旧验收请求应按新状态（已弹回开发族）被拒 400 INVALID_TRANSITION（无副作用），实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    const afterAccept = await issueRowOf(issueId);
    must(afterAccept.status === '处理中', `[竞态①] 失败的验收请求不应改变主状态，实得=${afterAccept.status}`);
    await deleteIssueFully(issueId);
  }
  {
    // ② 确定性顺序 B：验收先完成 → 撤回（携带验收前拿到的旧令牌）应按新状态（待上线）被拒，成员态不受影响。
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const acceptR = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, {});
    must(acceptR.status === 200, `[竞态②] 验收应先成功, got ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    const withdrawR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '竞态②：验收先完成', expected_submit_event_id: latestEventId });
    must(withdrawR.status === 409 && withdrawR.body.code === 'STATE_NOT_ALLOWED_FOR_WITHDRAW', `[竞态②] 验收先完成后，撤回应按新状态（待上线）被拒 409 STATE_NOT_ALLOWED_FOR_WITHDRAW，实得 ${withdrawR.status} ${JSON.stringify(withdrawR.body)}`);
    const memberAfter = await memberRowOf(issueId, 5);
    must(memberAfter.dev_status === 'code_submitted', `[竞态②] 被拒的撤回请求不应改变成员态，实得=${memberAfter.dev_status}`);
    await deleteIssueFully(issueId);
  }
  {
    // ③ 并发冒烟检查（codex 551 M14 降级定位）——Promise.all 同时发出真实 HTTP 请求，不预设谁赢。
    //   ⚠️ 不再声称"双向成立"：codex 指出"两个 Promise.all 数组顺序导致 else 分支恒不执行"这一点无法
    //   严格证明（本进程内谁先拿到 sysTxnMutex 取决于 Node 事件循环/网络栈调度，不是可控变量）；确定
    //   性的两个方向已由上面①②完整覆盖并逐一断言精确错误码，本组只做"并发下确实互斥、不会两个都成功
    //   或两个都失败"这一层冒烟检查，失败分支只接受预期的业务错误码（非 >=400 泛匹配——那会把 500
    //   内部错误也当作"符合预期"放过）。
    const { issueId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const [acceptR, withdrawR] = await Promise.all([
      call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, {}),
      call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '竞态③：并发冒烟检查', expected_submit_event_id: latestEventId }),
    ]);
    const acceptWon = acceptR.status === 200;
    const withdrawWon = withdrawR.status === 200;
    must(acceptWon !== withdrawWon, `[竞态③冒烟] 并发下应恰好一方成功、另一方失败（互斥，非双成功/双失败），实得 accept=${acceptR.status} withdraw=${withdrawR.status}`);
    const after = await issueRowOf(issueId);
    if (acceptWon) {
      must(after.status === '待上线', `[竞态③冒烟·accept 胜出] 主状态应到「待上线」，实得=${after.status}`);
      must(withdrawR.status === 409 && withdrawR.body.code === 'STATE_NOT_ALLOWED_FOR_WITHDRAW', `[竞态③冒烟·accept 胜出] 撤回应按新状态 409 STATE_NOT_ALLOWED_FOR_WITHDRAW（业务错误码，非泛化失败），实得 ${withdrawR.status} ${JSON.stringify(withdrawR.body)}`);
    } else {
      must(after.status === '处理中', `[竞态③冒烟·withdraw 胜出] 主状态应弹回「处理中」，实得=${after.status}`);
      must(acceptR.status === 400 && acceptR.body.code === 'INVALID_TRANSITION', `[竞态③冒烟·withdraw 胜出] 验收应按新状态 400 INVALID_TRANSITION（业务错误码，非 >=400 泛匹配——后者会把 500 内部错误也当成功放过），实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    }
    console.log(`  [竞态③冒烟] 本次实际胜出方：${acceptWon ? 'accept' : 'withdraw'}（仅并发冒烟检查，确定性双方向证明见①②）`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【事务回滚】单点失败注入——timeline 最终写入（'dev_withdraw' 那条）失败，断言成员态/commit 行/
  //   事件/主状态四者共同回滚，无半截态（本注入点覆盖面最广：它是事务倒数第二个写操作，此前的 CAS/
  //   commit 删除/逐行 delete-commit 事件/electRepresentative/runWGate 全部已执行，若整体回滚不彻底，
  //   会在这一点暴露）
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const before = {
      member: await memberRowOf(issueId, 5),
      commits: await commitsOf(daId),
      eventCount: (await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=?`, [issueId])).length,
      issue: await issueRowOf(issueId),
    };
    const { result: r, injected } = await withInjectedDbRunFailure("'dev_withdraw'", () =>
      call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '事务回滚注入：timeline 写入失败', expected_submit_event_id: latestEventId })
    );
    must(injected, `[事务回滚] 注入助手应确实命中目标注入点（'dev_withdraw' 那条 timeline INSERT），否则下方断言可能是别的异常造成的假通过`);
    must(r.status >= 500, `[事务回滚] 注入 timeline 写入失败后端点应失败（500 家族），got ${r.status} ${JSON.stringify(r.body)}`);
    const after = {
      member: await memberRowOf(issueId, 5),
      commits: await commitsOf(daId),
      eventCount: (await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=?`, [issueId])).length,
      issue: await issueRowOf(issueId),
    };
    must(after.member.dev_status === before.member.dev_status && after.member.resolved_at === before.member.resolved_at && after.member.no_code_reason === before.member.no_code_reason,
      `[事务回滚] 成员态应整体回滚，前=${JSON.stringify(before.member)}，后=${JSON.stringify(after.member)}`);
    must(after.commits.length === before.commits.length, `[事务回滚] commit 行应整体回滚（未被删除），前=${before.commits.length}，后=${after.commits.length}`);
    must(after.eventCount === before.eventCount, `[事务回滚] dev_events 行数应整体回滚（无新增 delete-commit 事件残留），前=${before.eventCount}，后=${after.eventCount}`);
    must(after.issue.status === before.issue.status, `[事务回滚] 主状态应整体回滚，前=${before.issue.status}，后=${after.issue.status}`);
    const tlRow = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='dev_withdraw'`, [issueId]);
    must(!tlRow, `[事务回滚] 注入失败的那条 timeline 行不应残留（整体回滚，无半截态）`);
    // 注入点复原后同一单应能正常再撤回一次（证明"回滚干净"而非"连接/锁被污染导致假性通过"）。
    const retryR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '事务回滚：复原后重试应正常成功', expected_submit_event_id: latestEventId });
    must(retryR.status === 200, `[事务回滚] 注入点复原后同一请求重试应 200（证明回滚干净、连接未被污染），got ${retryR.status} ${JSON.stringify(retryR.body)}`);
    await deleteIssueFully(issueId);
  }
  // ══════════════════════════════════════════════════════════════════════
  // 【事务回滚·授权终结路径】M5 回填——上一组用例夹具没有活跃授权，`if (isActiveFastReleaseAuth(row))`
  //   整段从未执行过：清六列 + roster 软删 + 两条独立 timeline 这四个写操作的回滚性此前从未被验证。
  //   本组补一个"有活跃授权 + 注入 'dev_withdraw' 写入失败"的组合，四者应与成员态/commit 行一并回滚。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    await run(
      `UPDATE sys_issues SET fast_release_auth_at = datetime('now','localtime'), fast_release_auth_by = 1,
              fast_release_auth_by_name = '管理员', fast_release_auth_note = 'M5 回滚 fixture' WHERE id = ?`,
      [issueId]
    );
    await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, added_by, added_by_name)
       VALUES (?, 6, '执行人丁', 'pending', 1, '管理员')`,
      [issueId]
    );
    const before = {
      member: await memberRowOf(issueId, 5),
      commits: await commitsOf(daId),
      issue: await issueRowOf(issueId),
      execRow: await get(`SELECT removed_at FROM sys_fast_release_executors WHERE issue_id=? AND user_id=6`, [issueId]),
    };
    must(before.issue.fast_release_auth_at !== null, `[事务回滚·授权终结夹具] 应已挂活跃授权，实得=${before.issue.fast_release_auth_at}`);
    const { result: r, injected } = await withInjectedDbRunFailure("'dev_withdraw'", () =>
      call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '事务回滚·授权终结路径：timeline 写入失败', expected_submit_event_id: latestEventId })
    );
    must(injected, `[事务回滚·授权终结路径] 注入助手应确实命中目标注入点，否则下方断言可能是别的异常造成的假通过`);
    must(r.status >= 500, `[事务回滚·授权终结路径] 注入失败后端点应失败（500 家族），got ${r.status} ${JSON.stringify(r.body)}`);
    const after = {
      member: await memberRowOf(issueId, 5),
      commits: await commitsOf(daId),
      issue: await issueRowOf(issueId),
      execRow: await get(`SELECT removed_at FROM sys_fast_release_executors WHERE issue_id=? AND user_id=6`, [issueId]),
    };
    must(after.member.dev_status === before.member.dev_status, `[事务回滚·授权终结路径] 成员态应整体回滚，前=${before.member.dev_status}，后=${after.member.dev_status}`);
    must(after.commits.length === before.commits.length, `[事务回滚·授权终结路径] commit 行应整体回滚，前=${before.commits.length}，后=${after.commits.length}`);
    must(after.issue.fast_release_auth_at === before.issue.fast_release_auth_at
      && after.issue.fast_release_auth_by === before.issue.fast_release_auth_by
      && after.issue.fast_release_auth_by_name === before.issue.fast_release_auth_by_name
      && after.issue.fast_release_auth_note === before.issue.fast_release_auth_note,
      `[事务回滚·授权终结路径] 先行上线授权六列应整体回滚（未被清空），前=${JSON.stringify(before.issue)}，后=${JSON.stringify(after.issue)}`);
    must(after.execRow.removed_at === before.execRow.removed_at, `[事务回滚·授权终结路径] 执行人集合行的 removed_at 应整体回滚（未被软删），前=${before.execRow.removed_at}，后=${after.execRow.removed_at}`);
    const terminatedTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_auth_terminated'`, [issueId]);
    must(!terminatedTl, `[事务回滚·授权终结路径] fast_release_auth_terminated 留痕行不应残留`);
    const rosterClearedTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_roster_cleared'`, [issueId]);
    must(!rosterClearedTl, `[事务回滚·授权终结路径] fast_release_roster_cleared 留痕行不应残留`);
    await deleteIssueFully(issueId);
  }
  // ══════════════════════════════════════════════════════════════════════
  // 【事务回滚·第二条 delete-commit 事件】codex 551 M 回填——此前只注入了最终 timeline 写入这一个点，
  //   commit 行删除+逐行留痕这一段（§5.3 步骤 b）"第一条已落库、第二条才失败"的中途中断场景从未被
  //   验证过：第一条是否也会跟着整体回滚？insertDevEvent 对不同 action 复用同一句 SQL 文本，无法靠
  //   sql 子串区分两条 delete-commit 语句，改用 `(sql, params)` 匹配器按 params[3]===action 判断，
  //   occurrence=2 只在第二次命中时才失败。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok, latestEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const commitsBefore = await commitsOf(daId);
    must(commitsBefore.length === 2, `[事务回滚·第二条 delete-commit 夹具] 应有 2 条 commit 行，实得=${commitsBefore.length}`);
    const eventCountBefore = (await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=?`, [issueId])).length;
    const { result: r, injected } = await withInjectedDbRunFailure(
      (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO sys_issue_dev_events') && Array.isArray(params) && params[3] === 'delete-commit',
      () => call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '事务回滚·第二条 delete-commit 事件注入', expected_submit_event_id: latestEventId }),
      2   // 第二次命中（第二条 delete-commit 事件）才失败——第一条应已正常写入，随后被整体回滚
    );
    must(injected, `[事务回滚·第二条 delete-commit] 注入助手应确实命中目标注入点（第 2 条 delete-commit 事件），否则下方断言可能是别的异常造成的假通过`);
    must(r.status >= 500, `[事务回滚·第二条 delete-commit] 端点应失败（500 家族），got ${r.status} ${JSON.stringify(r.body)}`);
    const commitsAfter = await commitsOf(daId);
    must(JSON.stringify(commitsAfter) === JSON.stringify(commitsBefore), `[事务回滚·第二条 delete-commit] commit 行应完整恢复（比完整内容，不只比数量），前=${JSON.stringify(commitsBefore)}，后=${JSON.stringify(commitsAfter)}`);
    const delEventsAfter = await deleteCommitEventsOf(daId);
    must(delEventsAfter.length === 0, `[事务回滚·第二条 delete-commit] 第一条已落库的 delete-commit 事件也应随整体事务回滚（非"第一条保留、只回滚失败的第二条"），实得残留=${delEventsAfter.length}`);
    const eventCountAfter = (await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=?`, [issueId])).length;
    must(eventCountAfter === eventCountBefore, `[事务回滚·第二条 delete-commit] dev_events 总行数应回到注入前，前=${eventCountBefore}，后=${eventCountAfter}`);
    const memberAfter = await memberRowOf(issueId, 5);
    must(memberAfter.dev_status === 'code_submitted', `[事务回滚·第二条 delete-commit] 成员态应整体回滚（CAS 也不该生效），实得=${memberAfter.dev_status}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【提交链跨表】撤回后重新提交——新 submit 事件不携带 amend_of（独立链根，§5.9 规则 3）；旧链经
  //   timeline 的 withdrawn_event_id 可回溯（非跨 dev_events/timeline 两表比较编号，§5.9 规则 4）
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok, latestEventId: oldEventId } = await mkCommitsSubmitted('bug', '处理中', 5);
    const withdrawR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '提交链跨表验证：先撤回', expected_submit_event_id: oldEventId });
    must(withdrawR.status === 200, `[提交链跨表夹具] 撤回应 200, got ${withdrawR.status} ${JSON.stringify(withdrawR.body)}`);
    // 重新提交——B 撤回后 dev_status 回 pending，与初次提交前提一致，走**普通** POST /submit（非 amend）。
    const resubmitR = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: `chain-${issueId}-new` }], self_tested: true, test_env_deployed: true, bug_cause_note: '新链的 bug 原因' });
    must(resubmitR.status === 200, `[提交链跨表] 撤回后重新提交应 200, got ${resubmitR.status} ${JSON.stringify(resubmitR.body)}`);
    const newEventId = resubmitR.body.dev_assignee_id ? (await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [resubmitR.body.dev_assignee_id])).id : null;
    must(typeof newEventId === 'number' && newEventId !== oldEventId, `[提交链跨表] 新提交应产生一条与旧链不同的事件，旧=${oldEventId}，新=${newEventId}`);
    const newEventRow = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE id=?`, [newEventId]);
    const newPayload = JSON.parse(newEventRow.payload_json);
    must(!Object.prototype.hasOwnProperty.call(newPayload, 'amend_of'), `[提交链跨表] 新 submit 事件的 payload 不应携带 amend_of 键（天然成为独立链根），实得 payload=${JSON.stringify(newPayload)}`);
    // 旧链可回溯：dev_withdraw timeline 行的 withdrawn_event_id 精确指向旧链尾（oldEventId），不依赖
    // 跨表编号比较或时间戳排序——纯粹的字段引用式回溯。
    const tlRow = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='dev_withdraw' ORDER BY id DESC LIMIT 1`, [issueId]);
    const tlPayload = JSON.parse(tlRow.payload_json);
    must(tlPayload.withdrawn_event_id === oldEventId, `[提交链跨表] timeline 的 withdrawn_event_id 应精确回溯到旧链尾事件 id，期望=${oldEventId}，实得=${tlPayload.withdrawn_event_id}`);
    // [M4 回填] 重提之后，再拿旧链的 oldEventId 撤一次——此刻本实例最新事件已是 newEventId，oldEventId
    // 是"双重陈旧"的令牌（既是旧链尾、又已被新链取代），应稳定 409，不因"曾经合法过"而被放行。
    const staleRetryR = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: '提交链跨表·M4：重提后再用旧链令牌撤回', expected_submit_event_id: oldEventId });
    must(staleRetryR.status === 409 && staleRetryR.body.code === 'WITHDRAW_TARGET_CHANGED', `[提交链跨表·M4] 重提后携带旧链 oldEventId 撤回应 409 WITHDRAW_TARGET_CHANGED，got ${staleRetryR.status} ${JSON.stringify(staleRetryR.body)}`);
    await deleteIssueFully(issueId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 【探针组】P1-P16 全绿终检（跑一遍最终库状态自证——重点覆盖 P2 pending 配对不变量：
  //   commit 行已删 + resolved_at/no_code_reason 已清）
  // ══════════════════════════════════════════════════════════════════════
  await selfCertifyProbes('[探针组终检]');

  console.log(`\n=== ${failDetails.length === 0 ? 'PASS' : 'FAIL'}：${passed} 项通过 / ${failDetails.length} 项失败 ===`);
  if (failDetails.length > 0) {
    console.log('失败明细：');
    for (const d of failDetails) console.log('  - ' + d);
  }
  server.close();
  if (failDetails.length > 0) process.exit(1);
}

main().catch(e => { console.error('❌ verify-sys-submit-withdraw 失败:', e && e.stack || e); server && server.close(); process.exit(1); });
