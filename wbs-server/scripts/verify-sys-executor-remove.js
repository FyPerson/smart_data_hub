// 验证脚本：系统迭代 执行人移单（2026-07-31 用户拍板·执行人移单四口径）
//   用法：node scripts/verify-sys-executor-remove.js
//
// 背景：POST /sys-releases/:id/remove-issues 此前是纯 admin 专属（路由级 requireAdmin）。2026-07-31
//   用户拍板四口径：① 移单不再是 admin 专属，被通知的执行人本人也可在执行环节移单 ② 仅执行人分支
//   原因必填（admin 分支原因可选） ③ 全类型（含 bug 应急批次）均适用（本批不改 R5⑤ 既有裁定，不重复
//   覆盖，见 verify-sys-bug-transitions.js） ④ 仅时间线留痕（不新增审计表/通知）。
//   核心新增行为：执行人分支剩余成员>0 时保留执行人身份（opts.keepExecutor，不重置通知六列/执行人两列/
//   token）；剩余=0（移空）时走现行完整重置——保住"正常流程 sent∧空成员不可达"性质。
//
// 覆盖组（对齐 index.js remove-issues 端点 + applyReleaseChange keepExecutor 分支）：
//   [A] 执行人移单成功（剩余>0，保留身份）：200 + remaining_count/executor_kept 正确；rel 通知六列/
//       执行人两列/token 全部未变；timeline 含 reason 且不含"已重置"；被移单回「待上线」release_id=NULL
//   [A2] [M3·2026-07-31 codex API 审采纳] 移单后当场继续执行：保留的执行人身份可真实走完 /execute——
//       发布成功 + 批次转已发布 + 快照仅含剩余单（被移除单不被带入）+ 被移除单仍「待上线」release_id=NULL
//   [B] 执行人移单致移空（剩余=0）：200 + executor_kept=false；rel 通知六列/执行人两列全重置+token 换新；
//       release_type 复位 NULL（F-4）；timeline 含"批次已移空，通知与执行人已重置"
//   [C] 执行人无 reason → 400 REMOVE_REASON_REQUIRED（无副作用：release_id/timeline/rel 通知列全不变）
//   [D] 非执行人（普通用户，非本批执行人）→ 403 EXECUTOR_GUARD_FAILED；通知态非 sent → 409
//       EXECUTOR_REMOVE_NOT_NOTIFIED（ns 检查先于 assignee 匹配，镜像 /execute 守卫顺序）；均零副作用
//   [D3] [M5·2026-07-31 codex API 审采纳] 执行人资格失效（离职）→ 403 EXECUTOR_NOT_ELIGIBLE，零副作用
//       （release_id/执行人两列/通知态/token/timeline 全不变，按 hasReleaseEligibility 实际判据构造）
//   [E] admin 回归：无 reason 移单现行重置语义不变（timeline 文案逐字不变）；带 reason 移单 timeline 含原因
//   [F] 批次非「计划中」→ 409 RELEASE_NOT_PLANNING（回归，两分支共用同一前置守卫——admin 与"原执行人
//       身份"两种请求身份均验证）
//   [G] [M4·2026-07-31 codex API 审采纳] GET /sys-releases include_members=1：admin+flag 返回 members
//       （字段=id/type/title/status，对齐旧契约）+ issue_count/source/degraded 一致（已发布快照态）；
//       非 admin+flag 响应不含 members 键；admin 不传 flag 旧契约不变（原 ad-hoc smoke 正式化）
//
// 断言纪律：精确状态码 + 精确 error code，不用 status>=400 弱判据；正例断言真实落库副作用，非仅状态码；
//   负例同样断言"零副作用"（release_id/执行人两列/通知列/token/timeline 全不变），不止看状态码本身。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-executor-remove-secret';
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

// ── 多角色 JWT 夹具（对齐 verify-sys-release-batch.js：测试 id 与生产 users.id 无对应关系）──────────
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const dev5Tok  = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);   // 有资格
const dev6Tok  = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);   // 有资格

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 直连 SQL 夹具（对齐 verify-sys-release-batch.js 范式）──────────
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员')`,
    [type, status, extra.title || `${type}-${status}-单`]
  );
  return r.lastID;
}
// RELEASE 中心守卫（assertMainStatusTransition）要求在册成员数≥1 且全员完成态（无 pending）才允许进「已上线」——
//   凡是本脚本会走到 execute/_publishReleaseCoreInTxn 的 issue 都必须先补一条完成态 dev_assignee 行。
async function mkCompleteRoster(issueId, userId, userName) {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
    [issueId, userId, userName]
  );
}
async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, {
    title: extra.title || '执行人移单测试批次', planned_date: extra.plannedDate || undefined,
  });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function addIssuesTo(relId, issueIds) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: issueIds });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const relRow = (id) => get(
  `SELECT id, status, release_type, planned_date, release_assignee_id, release_assignee_name,
          release_assignee_notify_status AS ns, release_assignee_notify_started_at AS started,
          release_assignee_notified_at AS notified, release_assignee_notify_message_key AS mkey,
          release_assignee_notify_error AS err, release_assignee_notify_token AS tok, release_assignee_read_at AS readAt
     FROM sys_releases WHERE id=?`, [id]
);
const issueRow = (id) => get(`SELECT id, status, release_id FROM sys_issues WHERE id=?`, [id]);
async function seedRoster(dutyDate, userId, userName) {
  await run(
    `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, ?, ?, 1, '管理员')`,
    [dutyDate, userId, userName]
  );
}
let dutyDateSeq = 1;
function nextDutyDate() { return `2032-01-${String(dutyDateSeq++).padStart(2, '0')}`; }
const lastReleaseRemoveTimeline = (issueId) => get(
  `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' AND action_code='release_remove' ORDER BY id DESC LIMIT 1`,
  [issueId]
);

// 建一个「已通知」批次（notify-executor 成功，assignee=userId），返回 { relId, issueIds }。
async function mkNotifiedRelease(userId, userName, issueTitles) {
  const d = nextDutyDate();
  await seedRoster(d, userId, userName);
  const relId = await mkRelease({ plannedDate: d });
  const issueIds = [];
  for (const t of issueTitles) issueIds.push(await mkIssue('feature', '待上线', { title: t }));
  await addIssuesTo(relId, issueIds);
  const rNotify = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
  assert.strictEqual(rNotify.status, 200, `notify-executor 期望 200, got ${rNotify.status} ${JSON.stringify(rNotify.body)}`);
  assert.strictEqual(rNotify.body.release_assignee_id, userId, `预置：assignee 应=${userId}`);
  return { relId, issueIds };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13800000001'),
    (5,'dev5','开发甲','user','active','13800000005'),
    (6,'dev6','开发乙','user','active','13800000006')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / dev5,6）');

  // ═══ [A] 执行人移单成功（剩余>0，保留身份）═══
  {
    const { relId, issueIds } = await mkNotifiedRelease(5, '开发甲', ['A-成员1', 'A-成员2']);
    const [issue1, issue2] = issueIds;
    const before = await relRow(relId);
    assert.strictEqual(before.ns, 'sent', '[A]前置：notify_status=sent');

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue2], reason: '不该随本批发布' });
    assert.strictEqual(r.status, 200, `[A]执行人移单期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.remaining_count, 1, '[A]remaining_count=1（issue1 仍在册）');
    assert.strictEqual(r.body.executor_kept, true, '[A]executor_kept=true（剩余>0，保留身份）');

    const after = await relRow(relId);
    assert.strictEqual(after.ns, 'sent', '[A]通知状态未被重置，仍 sent');
    assert.strictEqual(after.release_assignee_id, 5, '[A]执行人 id 未被清空');
    assert.strictEqual(after.release_assignee_name, '开发甲', '[A]执行人姓名未被清空');
    assert.strictEqual(after.tok, before.tok, '[A]token 未换新');
    assert.strictEqual(after.started, before.started, '[A]started_at 未变');
    assert.strictEqual(after.notified, before.notified, '[A]notified_at 未变');
    assert.strictEqual(after.mkey, before.mkey, '[A]message_key 未变');
    assert.strictEqual(after.err, before.err, '[A]notify_error 未变（M2 通知六列比对补全，2026-07-31 codex API 审 L1 采纳）');
    assert.strictEqual(after.readAt, before.readAt, '[A]read_at 未变');

    const removedRow = await issueRow(issue2);
    assert.strictEqual(removedRow.release_id, null, '[A]被移单 release_id 已清');
    assert.strictEqual(removedRow.status, '待上线', '[A]被移单主状态仍「待上线」（未受影响）');
    const kept = await issueRow(issue1);
    assert.strictEqual(kept.release_id, relId, '[A]未被移除的 issue1 仍在批次内');

    const tl = await lastReleaseRemoveTimeline(issue2);
    assert.ok(tl, '[A]timeline 已写 release_remove 行');
    assert.strictEqual(tl.summary, '执行人移出上线批次（原因：不该随本批发布）', '[A]timeline 文案含原因且不含"已重置"字样');

    ok('[A] 执行人移单成功（剩余>0）：200 + remaining_count=1 + executor_kept=true；通知六列/执行人两列/token 全部未变；被移单回「待上线」release_id=NULL；timeline 含原因不含"已重置"');

    // ═══ [B] 紧接着把最后一单也移出（剩余=0，移空）═══
    const r2 = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue1], reason: '批次整体作废' });
    assert.strictEqual(r2.status, 200, `[B]执行人移空期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.remaining_count, 0, '[B]remaining_count=0');
    assert.strictEqual(r2.body.executor_kept, false, '[B]executor_kept=false（移空，全重置）');

    const relAfterEmpty = await relRow(relId);
    assert.strictEqual(relAfterEmpty.release_assignee_id, null, '[B]执行人 id 已清空');
    assert.strictEqual(relAfterEmpty.release_assignee_name, null, '[B]执行人姓名已清空');
    assert.strictEqual(relAfterEmpty.ns, 'not_sent', '[B]通知状态回 not_sent');
    assert.strictEqual(relAfterEmpty.started, null, '[B]started_at 已清');
    assert.strictEqual(relAfterEmpty.notified, null, '[B]notified_at 已清');
    assert.strictEqual(relAfterEmpty.mkey, null, '[B]message_key 已清');
    assert.strictEqual(relAfterEmpty.err, null, '[B]error 已清');
    assert.strictEqual(relAfterEmpty.readAt, null, '[B]read_at 已清');
    assert.notStrictEqual(relAfterEmpty.tok, before.tok, '[B]token 已换新');
    assert.strictEqual(relAfterEmpty.release_type, null, '[B]release_type 复位 NULL（F-4，批次已移空）');

    const tl2 = await lastReleaseRemoveTimeline(issue1);
    assert.ok(tl2, '[B]timeline 已写 release_remove 行');
    assert.strictEqual(tl2.summary, '执行人移出上线批次（原因：批次整体作废）；批次已移空，通知与执行人已重置', '[B]timeline 文案含"批次已移空，通知与执行人已重置"');

    ok('[B] 执行人移单致移空（剩余=0）：200 + executor_kept=false；通知六列/执行人两列全重置+token 换新；release_type 复位 NULL（F-4）；timeline 含"批次已移空，通知与执行人已重置"');
  }

  // ═══ [A2] M3：移单后（剩余>0，保留身份）当场继续执行 ═══
  //   独立造一批新夹具（相邻 [A]/[B] 已在同一 relId 上把批次移空发布不出——本组验证的正是"没被移空
  //   前的中间态"，故不能复用其已耗尽的 relId），用 dev6（未在上方 [A]/[B] 出现过）避免与其余组交叉。
  {
    const { relId, issueIds } = await mkNotifiedRelease(6, '开发乙', ['A2-成员1', 'A2-成员2']);
    const [keepIssue, removeIssue] = issueIds;

    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev6Tok, { issue_ids: [removeIssue], reason: '不该随本批发布' });
    assert.strictEqual(rRemove.status, 200, `[A2]前置移单期望 200, got ${rRemove.status} ${JSON.stringify(rRemove.body)}`);
    assert.strictEqual(rRemove.body.executor_kept, true, '[A2]前置：executor_kept=true（剩余>0，保留身份）');

    // RELEASE 中心守卫要求在册成员≥1 且全员完成态——移单**之后**才补，证明"移单保留身份"与"发布前置
    // 条件"互不干扰（不是移单前就已经满足发布条件，是移单后才补齐，再真实走 execute）。
    await mkCompleteRoster(keepIssue, 6, '开发乙');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: '移单后当场继续执行' });
    assert.strictEqual(rExec.status, 200, `[A2]移单后继续执行期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(rExec.body.count, 1, '[A2]发布成功 1 单（仅剩余成员）');
    assert.deepStrictEqual(rExec.body.released, [keepIssue], '[A2]发布名单恰为剩余成员，不含被移除单');

    const relAfter = await relRow(relId);
    assert.strictEqual(relAfter.status, '已发布', '[A2]批次转已发布');

    const allSnaps = await all('SELECT issue_id FROM sys_issue_release_commit_snapshots WHERE release_id=?', [relId]);
    assert.strictEqual(allSnaps.length, 1, '[A2]发布快照仅 1 条（只含剩余单，被移除单未被带入）');
    assert.strictEqual(allSnaps[0].issue_id, keepIssue, '[A2]快照 issue_id=剩余成员');

    const keptRow = await issueRow(keepIssue);
    assert.strictEqual(keptRow.status, '已上线', '[A2]剩余成员真实翻已上线');
    assert.strictEqual(keptRow.release_id, relId, '[A2]剩余成员 release_id 指向本批次');

    const removedRow = await issueRow(removeIssue);
    assert.strictEqual(removedRow.status, '待上线', '[A2]被移除单仍「待上线」（未被带入本次发布）');
    assert.strictEqual(removedRow.release_id, null, '[A2]被移除单 release_id 仍为 NULL（未被带入本次发布）');

    ok('[A2] 移单后当场继续执行（M3）：保留的执行人身份可真实走完 /execute——发布成功 + 批次转已发布 + 快照仅含剩余单 + 被移除单仍「待上线」release_id=NULL（未被带入）');
  }

  // ═══ [C] 执行人无 reason → 400 REMOVE_REASON_REQUIRED（无副作用）═══
  {
    const { relId, issueIds } = await mkNotifiedRelease(6, '开发乙', ['C-成员1']);
    const [issue1] = issueIds;
    const before = await relRow(relId);
    const tlCountBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev6Tok, { issue_ids: [issue1] });
    assert.strictEqual(r.status, 400, `[C]无 reason 期望 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'REMOVE_REASON_REQUIRED', '[C]确切码 REMOVE_REASON_REQUIRED');

    const row = await issueRow(issue1);
    assert.strictEqual(row.release_id, relId, '[C]无副作用：release_id 未被清（校验先于任何写操作）');
    const after = await relRow(relId);
    assert.strictEqual(after.release_assignee_id, before.release_assignee_id, '[C]无副作用：执行人 id 未变（L1 采纳）');
    assert.strictEqual(after.release_assignee_name, before.release_assignee_name, '[C]无副作用：执行人姓名未变（L1 采纳）');
    assert.strictEqual(after.ns, before.ns, '[C]无副作用：通知状态未变（L1 采纳）');
    const tlCountAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;
    assert.strictEqual(tlCountAfter, tlCountBefore, '[C]无副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[C] 执行人无 reason：400 REMOVE_REASON_REQUIRED，且零副作用（release_id/执行人两列/通知态/timeline 全不变）');
  }

  // ═══ [D] 非执行人 403 / 通知态非 sent 409（守卫顺序：ns 先于 assignee 匹配，镜像 /execute）═══
  {
    // D-1：非执行人（dev5 不是本批执行人 dev6）→ 403 EXECUTOR_GUARD_FAILED
    const { relId: relD1, issueIds: idsD1 } = await mkNotifiedRelease(6, '开发乙', ['D1-成员1']);
    const beforeD1 = await relRow(relD1);
    const tlCountBeforeD1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD1[0]])).c;
    const rOther = await call('POST', `/api/sys-releases/${relD1}/remove-issues`, dev5Tok, { issue_ids: [idsD1[0]], reason: '我以为我能移' });
    assert.strictEqual(rOther.status, 403, `[D1]非执行人期望 403, got ${rOther.status}`);
    assert.strictEqual(rOther.body.code, 'EXECUTOR_GUARD_FAILED', '[D1]确切码 EXECUTOR_GUARD_FAILED');
    const afterD1 = await relRow(relD1);
    assert.strictEqual(afterD1.release_assignee_id, beforeD1.release_assignee_id, '[D1]零副作用：执行人 id 未变（L1 采纳）');
    assert.strictEqual(afterD1.release_assignee_name, beforeD1.release_assignee_name, '[D1]零副作用：执行人姓名未变（L1 采纳）');
    assert.strictEqual(afterD1.ns, beforeD1.ns, '[D1]零副作用：通知状态未变（L1 采纳）');
    const rowD1 = await issueRow(idsD1[0]);
    assert.strictEqual(rowD1.release_id, relD1, '[D1]零副作用：release_id 未被清（L1 采纳）');
    const tlCountAfterD1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD1[0]])).c;
    assert.strictEqual(tlCountAfterD1, tlCountBeforeD1, '[D1]零副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[D1] 非执行人（普通用户，非本批执行人）：403 EXECUTOR_GUARD_FAILED，且零副作用（release_id/执行人两列/通知态/timeline 全不变）');

    // D-2：通知态非 sent（人工回退到 failed，assignee 仍是本人）→ 409 EXECUTOR_REMOVE_NOT_NOTIFIED
    const { relId: relD2, issueIds: idsD2 } = await mkNotifiedRelease(6, '开发乙', ['D2-成员1']);
    await run(`UPDATE sys_releases SET release_assignee_notify_status='failed' WHERE id=?`, [relD2]);
    const beforeD2 = await relRow(relD2);
    const tlCountBeforeD2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD2[0]])).c;
    const rNotSent = await call('POST', `/api/sys-releases/${relD2}/remove-issues`, dev6Tok, { issue_ids: [idsD2[0]], reason: '通知都失败了还想移' });
    assert.strictEqual(rNotSent.status, 409, `[D2]通知态非 sent 期望 409, got ${rNotSent.status}`);
    assert.strictEqual(rNotSent.body.code, 'EXECUTOR_REMOVE_NOT_NOTIFIED', '[D2]确切码 EXECUTOR_REMOVE_NOT_NOTIFIED');
    const afterD2 = await relRow(relD2);
    assert.strictEqual(afterD2.release_assignee_id, beforeD2.release_assignee_id, '[D2]零副作用：执行人 id 未变（L1 采纳）');
    assert.strictEqual(afterD2.ns, beforeD2.ns, '[D2]零副作用：通知状态未变（仍是人工构造的 failed，L1 采纳）');
    const rowD2 = await issueRow(idsD2[0]);
    assert.strictEqual(rowD2.release_id, relD2, '[D2]零副作用：release_id 未被清（L1 采纳）');
    const tlCountAfterD2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD2[0]])).c;
    assert.strictEqual(tlCountAfterD2, tlCountBeforeD2, '[D2]零副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[D2] 通知态非 sent（人工回退 failed，assignee 仍是本人）：409 EXECUTOR_REMOVE_NOT_NOTIFIED（ns 检查先于 assignee 匹配），且零副作用');
  }

  // ═══ [D3] M5：执行人资格失效（离职）→ 403 EXECUTOR_NOT_ELIGIBLE，零副作用 ═══
  //   hasReleaseEligibility 判据（grep index.js 确认，约 7158-7162 行）：
  //   `!!(u && u.status === 'active' && u.role !== 'viewer' && u.role !== 'admin')`——用"离职"
  //   （status 由 active 改 disabled）构造：assignee 匹配 + ns=sent，但账号已离职，镜像 /execute
  //   同款实时资格复核用例的既有夹具手法（先 sent 再禁用，验证的是"事务内自读自判"不信调用方旧态）。
  {
    await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (9,'dev9','开发丙','user','active')`);
    const dev9Tok = jwt.sign({ id: 9, username: 'dev9', display_name: '开发丙', role: 'user' }, SECRET);
    const { relId, issueIds } = await mkNotifiedRelease(9, '开发丙', ['D3-成员1']);
    const [issue1] = issueIds;
    await run(`UPDATE users SET status='disabled' WHERE id=9`);   // sent 之后现离职（同 execute 组既有夹具手法）

    const before = await relRow(relId);
    const tlCountBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev9Tok, { issue_ids: [issue1], reason: '我要移单但已经离职' });
    assert.strictEqual(r.status, 403, `[D3]资格失效期望 403, got ${r.status}`);
    assert.strictEqual(r.body.code, 'EXECUTOR_NOT_ELIGIBLE', '[D3]确切码 EXECUTOR_NOT_ELIGIBLE');

    const after = await relRow(relId);
    assert.strictEqual(after.release_assignee_id, before.release_assignee_id, '[D3]零副作用：执行人 id 未变');
    assert.strictEqual(after.release_assignee_name, before.release_assignee_name, '[D3]零副作用：执行人姓名未变');
    assert.strictEqual(after.ns, before.ns, '[D3]零副作用：通知状态未变');
    assert.strictEqual(after.tok, before.tok, '[D3]零副作用：token 未变');
    const row = await issueRow(issue1);
    assert.strictEqual(row.release_id, relId, '[D3]零副作用：release_id 未被清');
    const tlCountAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;
    assert.strictEqual(tlCountAfter, tlCountBefore, '[D3]零副作用：timeline 无新增 release_remove 行');

    await run(`UPDATE users SET status='active' WHERE id=9`);   // 复原，避免污染后续用例
    ok('[D3] 执行人资格失效（离职，M5）：403 EXECUTOR_NOT_ELIGIBLE，且零副作用（release_id/执行人两列/通知态/token/timeline 全部不变）');
  }

  // ═══ [E] admin 回归：无 reason 现行语义不变；带 reason timeline 含原因 ═══
  {
    const { relId, issueIds } = await mkNotifiedRelease(5, '开发甲', ['E-成员1', 'E-成员2']);
    const [issue1, issue2] = issueIds;
    const before = await relRow(relId);

    // 无 reason：现行完整重置语义不变（回归）——即使剩余>0，admin 分支恒不传 keepExecutor。
    const r1 = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue2] });
    assert.strictEqual(r1.status, 200, `[E1]admin 无 reason 期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.remaining_count, 1, '[E1]remaining_count=1（issue1 仍在册）');
    assert.strictEqual(r1.body.executor_kept, false, '[E1]executor_kept=false（admin 分支恒全重置，不受剩余数影响）');
    const afterR1 = await relRow(relId);
    assert.strictEqual(afterR1.ns, 'not_sent', '[E1]admin 无 reason 移单仍触发通知重置为 not_sent（回归）');
    assert.strictEqual(afterR1.release_assignee_id, null, '[E1]执行人已清（回归）');
    assert.notStrictEqual(afterR1.tok, before.tok, '[E1]token 已换新（回归）');
    const tl1 = await lastReleaseRemoveTimeline(issue2);
    assert.strictEqual(tl1.summary, '移出上线批次，通知与执行人已重置', '[E1]admin 无 reason 时 timeline 文案逐字不变（回归）');

    // 带 reason：timeline 含原因，其余重置语义不变。
    const r2 = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue1], reason: '批次作废重建' });
    assert.strictEqual(r2.status, 200, `[E2]admin 带 reason 期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.remaining_count, 0, '[E2]remaining_count=0');
    const tl2 = await lastReleaseRemoveTimeline(issue1);
    assert.strictEqual(tl2.summary, '移出上线批次（原因：批次作废重建），通知与执行人已重置', '[E2]admin 带 reason 时 timeline 含原因');

    ok('[E] admin 回归：无 reason 移单现行完整重置语义逐字不变（timeline 文案/落库副作用）；带 reason 移单 timeline 含原因');
  }

  // ═══ [F] 批次非「计划中」→ 409 RELEASE_NOT_PLANNING（回归，两分支共用同一前置守卫）═══
  {
    const d = nextDutyDate();
    await seedRoster(d, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d, title: '执行人移单-已发布批次回归' });
    const issueId = await mkIssue('feature', '待上线', { title: 'F-成员1' });
    await mkCompleteRoster(issueId, 5, '开发甲');   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: '执行人移单回归-发布' });
    assert.strictEqual(rExec.status, 200, `[F]前置 execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);

    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issueId] });
    assert.strictEqual(rRemove.status, 409, `[F]已发布批次移单（admin 身份）期望 409, got ${rRemove.status}`);
    assert.strictEqual(rRemove.body.code, 'RELEASE_NOT_PLANNING', '[F]admin 身份确切码 RELEASE_NOT_PLANNING（回归）');

    // L1 采纳：已发布单保留执行人=本人（审计对称，见 GET /sys-releases/:id 权限注释）——dev5 此刻仍是
    // release_assignee_id 且 ns 仍是 sent（execute 不清这两列），用"原执行人身份"再发一次请求，证明
    // 批次状态守卫（rel.status!=='计划中'）先于角色分支判定，两分支（admin/执行人）共用同一道前置闸，
    // 不是"admin 单独测过 409、执行人分支从未真正被这道闸拦过"。
    const rRemoveAsExecutor = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issueId], reason: '发布后还想移单' });
    assert.strictEqual(rRemoveAsExecutor.status, 409, `[F]已发布批次移单（原执行人身份）期望 409, got ${rRemoveAsExecutor.status}`);
    assert.strictEqual(rRemoveAsExecutor.body.code, 'RELEASE_NOT_PLANNING', '[F]原执行人身份确切码同样 RELEASE_NOT_PLANNING（证两分支共用同一前置守卫）');

    ok('[F] 批次非「计划中」（已发布）：409 RELEASE_NOT_PLANNING（回归）——admin 身份与"原执行人身份"两种请求身份均命中同一道前置守卫');
  }

  // ═══ [G] M4：GET /sys-releases include_members=1（原 ad-hoc smoke 正式化）═══
  //   admin 专属，非 admin 传了静默忽略；成员读源走 getReleaseMembers() 统一函数，字段映射对齐旧契约
  //   （id/type/title/status，同批次详情端点）。本组构造一个真实"已发布"批次（快照态，非降级读源）。
  {
    await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_assignee_id, release_assignee_name,
                release_assignee_notify_status, released_at, release_note, version_tag, created_by, created_by_name, created_at)
               VALUES ('R-G-SNAP', 'G组冒烟批次', '已发布', 0, 5, '开发甲', 'sent', datetime('now'), '上线说明', 'v1.0', 1, '管理员', datetime('now'))`);
    const relId = (await get(`SELECT id FROM sys_releases WHERE release_no='R-G-SNAP'`)).id;
    const issueRes = await run(
      `INSERT INTO sys_issues (type, title, status, system_name, source, created_by, created_by_name, release_id, created_at)
       VALUES ('feature', 'G组成员单', '已上线', 'BMS', '内部', 1, '管理员', ?, datetime('now'))`,
      [relId]
    );
    const gIssueId = issueRes.lastID;
    await run(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
       VALUES (?, 'scope_change', ?, 'release_published', ?, 1, '管理员')`,
      [gIssueId, JSON.stringify({ schema_version: 2, issue_id: gIssueId, type: 'feature', title_snapshot: 'G组成员单', status_at_publish: '已上线', commits: [] }), relId]
    );
    await run(
      `INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at) VALUES (?, ?, ?, datetime('now'))`,
      [relId, gIssueId, JSON.stringify({ schema_version: 2, type: 'feature', title_snapshot: 'G组成员单', status_at_publish: '已上线', commits: [] })]
    );

    const qsWithFlag = new URLSearchParams({ status: '已发布', include_members: '1' }).toString();
    const rAdmin = await call('GET', `/api/sys-releases?${qsWithFlag}`, adminTok);
    assert.strictEqual(rAdmin.status, 200, `[G]admin+flag 期望 200, got ${rAdmin.status}`);
    const itemAdmin = rAdmin.body.items.find(x => x.release_no === 'R-G-SNAP');
    assert.ok(itemAdmin, '[G]admin 应能看到该批次');
    assert.ok(Array.isArray(itemAdmin.members), '[G]admin+flag：members 为数组');
    assert.deepStrictEqual(itemAdmin.members, [{ id: gIssueId, type: 'feature', title: 'G组成员单', status: '已上线' }], '[G]members 字段映射=id/type/title/status（对齐旧契约）');
    assert.strictEqual(itemAdmin.issue_count, 1, '[G]issue_count 与 members.length 一致');
    assert.strictEqual(itemAdmin.source, 'snapshot', '[G]source=snapshot（已发布快照态读源，至少覆盖一种真实读源）');
    assert.strictEqual(itemAdmin.degraded, false, '[G]degraded=false');

    const rUser = await call('GET', `/api/sys-releases?${qsWithFlag}`, dev5Tok);
    assert.strictEqual(rUser.status, 200, `[G]非 admin+flag 期望 200, got ${rUser.status}`);
    const itemUser = rUser.body.items.find(x => x.release_no === 'R-G-SNAP');
    assert.ok(itemUser, '[G]dev5 是本批执行人，mine 视角应能看到该批次');
    assert.strictEqual('members' in itemUser, false, '[G]非 admin：include_members 被静默忽略，响应不含 members 键');

    const qsNoFlag = new URLSearchParams({ status: '已发布' }).toString();
    const rAdminNoFlag = await call('GET', `/api/sys-releases?${qsNoFlag}`, adminTok);
    const itemNoFlag = rAdminNoFlag.body.items.find(x => x.release_no === 'R-G-SNAP');
    assert.strictEqual('members' in itemNoFlag, false, '[G]admin 不传 flag：旧契约不变，不含 members 键');

    ok('[G] GET /sys-releases include_members=1（M4）：admin+flag 返回 members（字段=id/type/title/status）+ issue_count/source/degraded 一致（已发布快照态）；非 admin+flag 响应不含 members 键；admin 不传 flag 旧契约不变');
  }

  console.log(`\n✅ verify-sys-executor-remove 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message); if (server) server.close(); process.exit(1); });
