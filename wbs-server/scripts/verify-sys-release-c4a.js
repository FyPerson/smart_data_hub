// 验证脚本：上线执行人多选与多人双确认 C4a（方案 20260806 v1.7 §4.4 改造 5/5b/6/7/8/11 + 登记①④⑥）
//   用法：node scripts/verify-sys-release-c4a.js
//
// 背景：C0-C3 已落地建表/迁移/候选端点/PUT executors 四道闸/行级通知/行级执行确认+R-GATE。C4a 收口既有
//   机制的连带改造——批次级/迭代单级读写点从"批次表单列比对"切到"执行人子表 EXISTS"，覆盖 cancel-schedule
//   撤销全体软删、详情端点非首位执行人放行、applyReleaseChange 差量重置子表软删、remove-issues keepExecutor
//   多人版契约、mine 过滤两个维度（批次/迭代单）的 EXISTS 判据、hotfix-publish 重复调用分支的通知态聚合语义。
//
// 覆盖组：
//   [1] cancel-schedule 撤销全体软删 + confirm_discard_done 闸（改造 5）：基础撤销/准入不看聚合态（partial
//       也能撤）/有 done 未带确认→409/带确认→200 全体软删+timeline 记丢弃/软删行不回带（新代次）
//   [2] 详情端点非首位执行人放行 + 入口 stale 批量刷新（改造 5b·登记⑤）：非首位在册 EXISTS 正例/软删负例/
//       超窗 sending 行经详情入口被批量转 stale
//   [3] applyReleaseChange 差量非空子表软删全员（改造 6）：add-issues / update-planned-date 两条触发路径
//   [4] remove-issues keepExecutor 保留全体在册行（改造 7）：非 actor 的同批次执行人不被牵连软删
//   [5] mine 过滤两维度 EXISTS（改造 8）：批次维度 GET /sys-releases（e.release_id=r.id）+ 迭代单维度
//       GET /sys-issues（e.release_id=i.release_id）各自正例+反例
//
// 断言纪律：精确状态码 + 精确 error code；正例断言真实落库副作用（子表行/timeline），非仅状态码；
//   负例同样断言"零副作用"，不止看状态码本身。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const SECRET = 'verify-sys-release-c4a-secret';
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

// ── 多角色 JWT 夹具──────────
const adminTok   = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人白名单（cancel-schedule 唯一合法身份）
const dev5Tok    = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);
const dev6Tok    = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);
const dev7Tok    = jwt.sign({ id: 7, username: 'dev7', display_name: '开发丙', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, { title: extra.title || 'C4a 测试批次', planned_date: extra.plannedDate });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function mkIssue(extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('feature', '待上线', ?, 'BMS', '内部', 1, '管理员')`,
    [extra.title || 'C4a 测试成员单']
  );
  return r.lastID;
}
async function addIssueTo(relId, issueId) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [issueId] });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
}
async function putExecutors(relId, userIds) {
  const r = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: userIds });
  assert.strictEqual(r.status, 200, `PUT executors 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function activeExecRows(relId) {
  return all(`SELECT id, user_id, user_name, notify_status, exec_status, removed_at, removed_by FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY user_id`, [relId]);
}
async function allExecRows(relId) {
  return all(`SELECT id, user_id, user_name, notify_status, exec_status, removed_at, removed_by FROM sys_release_executors WHERE release_id = ? ORDER BY id`, [relId]);
}
async function cancelScheduleTimeline(relId) {
  return all(`SELECT summary FROM sys_issue_timeline WHERE ref_id = ? AND action_code = 'release_schedule_cancel' ORDER BY id`, [relId]);
}
// C4b 预筛 MED-1：通用按 action_code 查询（供 [3a]/[3b] 的 release_add/release_date_change 断言复用，
//   同 cancelScheduleTimeline 一样按 ref_id=releaseId 关联）+ 不分 action_code 的全量计数（供 [3c] 的
//   "零新增"哨兵——同值改期应连一条 timeline 都不写，不止是 release_date_change 这一个 action_code 不写）。
async function timelineByCode(relId, actionCode) {
  return all(`SELECT summary FROM sys_issue_timeline WHERE ref_id = ? AND action_code = ? ORDER BY id`, [relId, actionCode]);
}
async function timelineTotal(relId) {
  return all(`SELECT id FROM sys_issue_timeline WHERE ref_id = ?`, [relId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (13,'wangtaotao','示例对接人','user','active'),
    (5,'dev5','开发甲','user','active'),
    (6,'dev6','开发乙','user','active'),
    (7,'dev7','开发丙','user','active')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 示例对接人13 / dev5,6,7）');

  // ═══ [1] cancel-schedule 撤销全体软删 + confirm_discard_done 闸（改造 5）═══
  {
    // [1a] 基础撤销：2 人在册（not_sent/pending，PUT executors 刚建）→ 撤销 → 200 全体软删 + timeline
    const rel1a = await mkRelease({ title: 'C4a-1a-基础撤销' });
    const issue1a = await mkIssue({ title: 'C4a-1a-成员单' });
    await addIssueTo(rel1a, issue1a);
    await putExecutors(rel1a, [5, 6]);
    const before1a = await activeExecRows(rel1a);
    assert.strictEqual(before1a.length, 2, '[1a-前置] 在册 2 行');
    const r1a = await call('POST', `/api/sys-releases/${rel1a}/cancel-schedule`, liaisonTok, { reason: '临时调整' });
    assert.strictEqual(r1a.status, 200, `[1a] 期望 200, got ${r1a.status} ${JSON.stringify(r1a.body)}`);
    assert.strictEqual(r1a.body.discarded_done_count, 0, '[1a] 无 done 行，discarded_done_count=0');
    const namesSorted1a = [r1a.body.old_assignee_name].map(s => (s || '').split('、').sort().join('、'))[0];
    assert.strictEqual(namesSorted1a, ['开发甲', '开发乙'].sort().join('、'), '[1a] old_assignee_name 含两人姓名（顿号连接）');
    const after1a = await activeExecRows(rel1a);
    assert.strictEqual(after1a.length, 0, '[1a] 撤销后在册 0 行（全体软删）');
    const allRows1a = await allExecRows(rel1a);
    assert.strictEqual(allRows1a.length, 2, '[1a] 物理行仍是 2（软删非物理删除）');
    assert.ok(allRows1a.every(r => r.removed_at && r.removed_by === 13), '[1a] 两行均软删且 removed_by=撤销操作者(13)');
    const tl1a = await cancelScheduleTimeline(rel1a);
    assert.strictEqual(tl1a.length, 1, '[1a] timeline 恰 1 条（本批次仅 1 个成员单）');
    assert.ok(tl1a[0].summary.includes('开发甲') && tl1a[0].summary.includes('开发乙'), '[1a] timeline 含两位原执行人姓名');
    assert.ok(tl1a[0].summary.includes('临时调整'), '[1a] timeline 含撤销原因');
    ok('[1a] 基础撤销：2 人在册 → 200，子表全体软删（物理行仍在但 removed_at/removed_by 均落）+ old_assignee_name 含两人 + timeline 含两人姓名与原因');

    // [1e] 软删行不回带：撤销后重新 PUT executors 选回同一人（5）→ 新行 id 与旧行不同（新代次，§4.1a）
    const oldRow5Id = allRows1a.find(r => r.user_id === 5).id;
    const putAgain = await putExecutors(rel1a, [5, 7]);
    const newRow5 = putAgain.executors.find(r => r.user_id === 5);
    assert.ok(newRow5, '[1e] 重新选回 5 号成功建新行');
    assert.notStrictEqual(newRow5.id, oldRow5Id, '[1e] 新行 id 与旧行不同（不是复活旧行，是全新一轮 INSERT，§4.1a 代次语义）');
    assert.strictEqual(newRow5.notify_status, 'not_sent', '[1e] 新行 notify_status=not_sent（不回带旧代次的已通知态）');
    ok('[1e] 软删行不回带：撤销后重新选回同一人 → 新行 id 与旧行不同（新代次），notify_status 从 not_sent 重新起步');
  }

  {
    // [1b] 准入不看聚合态：一人 sent、一人 failed（partial 组合，无 sending/无全 sent/无全 not_sent）→
    //   ⭐ L2（Opus 预筛，自贬纠正）：这**本身就是**一个有效证伪点，不是"旧闸本就会放行、真正证伪点在
    //   1b-2"（上一版这句话是错的）——本组批次经 mkRelease 建出后从未碰过 release_assignee_notify_status，
    //   该旧列停在 DDL 默认值 'not_sent'；旧闸判据是 `!['sent','stale','failed'].includes(rel.ns)`，
    //   'not_sent' 不在这个白名单里，旧闸会直接 409 CANCEL_SCHEDULE_STATUS_INVALID——子表的 sent/failed
    //   partial 组合根本救不了它（旧闸压根不读子表）。[1b-2] 是**另一个独立场景**（子表为空的批次），
    //   两者一起覆盖"旧闸恒读旧列、新闸恒读子表状态与批次准入"这条切换的两侧，不是同一个点的重复。
    const rel1b = await mkRelease({ title: 'C4a-1b-partial态撤销' });
    const issue1b = await mkIssue({ title: 'C4a-1b-成员单' });
    await addIssueTo(rel1b, issue1b);
    await putExecutors(rel1b, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel1b]);
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='测试失败' WHERE release_id=? AND user_id=6`, [rel1b]);
    const r1b = await call('POST', `/api/sys-releases/${rel1b}/cancel-schedule`, liaisonTok, { reason: 'partial态撤销' });
    assert.strictEqual(r1b.status, 200, `[1b] partial 态期望 200, got ${r1b.status} ${JSON.stringify(r1b.body)}`);
    ok('[1b] partial 态（一 sent 一 failed）撤销：200 成功');

    // [1b-2] 核心证伪点：子表为空（旧批次级列 release_assignee_notify_status 恒 'not_sent' DDL 默认，新
    //   机制批次从不写它）——旧闸「!IN(sent,stale,failed)」会命中 not_sent 直接 409，新闸只看 status='计划中'。
    //   ⚠️ L1（Opus 预筛 305 号）文案订正：子表为空**不是 no-op**——cancel-schedule 依然真实走完整套流程
    //   （CAS 通过 + applyReleaseChange 的 schedule_cancelled 分支对 currentMembers 逐条写 timeline），
    //   只是这次子表软删 0 行（本来就没有）。"200"体现在"流程真实跑通且不产生错误的执行人/丢弃计数"，
    //   不体现在"什么都没发生"——timeline 计数 +1 就是这次真实执行的证据。
    const rel1b2 = await mkRelease({ title: 'C4a-1b2-子表为空的批次' });
    const issue1b2 = await mkIssue({ title: 'C4a-1b2-成员单' });
    await addIssueTo(rel1b2, issue1b2);
    const emptyRows = await activeExecRows(rel1b2);
    assert.strictEqual(emptyRows.length, 0, '[1b2-前置] 子表确实为空（从未 PUT executors）');
    const tlCountBefore1b2 = (await cancelScheduleTimeline(rel1b2)).length;
    const r1b2 = await call('POST', `/api/sys-releases/${rel1b2}/cancel-schedule`, liaisonTok, { reason: '子表为空也能撤' });
    assert.strictEqual(r1b2.status, 200, `[1b2] 子表为空（旧闸会 409 CANCEL_SCHEDULE_STATUS_INVALID）期望新闸放行 200, got ${r1b2.status} ${JSON.stringify(r1b2.body)}`);
    assert.strictEqual(r1b2.body.old_assignee_name, null, '[1b2] 子表为空，old_assignee_name=null（MED-1 兜底：旧列同样从未写过，回落也是 null）');
    assert.strictEqual(r1b2.body.discarded_done_count, 0, '[1b2] 子表为空，discarded_done_count=0（没有 done 行可丢）');
    const tlCountAfter1b2 = (await cancelScheduleTimeline(rel1b2)).length;
    assert.strictEqual(tlCountAfter1b2, tlCountBefore1b2 + 1, `[1b2] 200 是完整撤销流程真实跑通（非 no-op）：timeline 确实新增 1 条 release_schedule_cancel，实际 ${tlCountBefore1b2}→${tlCountAfter1b2}`);
    ok('[1b2] 准入闸只看批次 status=计划中（v1.2 H1）：子表为空的批次（旧聚合态闸会 409 CANCEL_SCHEDULE_STATUS_INVALID）新闸下仍是 200 完整撤销流程（非 no-op，timeline 真实新增 1 条）——partial/空表均有恢复路径');
  }

  {
    // [1c]/[1d] 有 done 行：未带 confirm_discard_done → 409 且零副作用；带 → 200 全体软删 + timeline 丢弃留痕
    const rel1c = await mkRelease({ title: 'C4a-1c-有done行' });
    const issue1c = await mkIssue({ title: 'C4a-1c-成员单' });
    await addIssueTo(rel1c, issue1c);
    await putExecutors(rel1c, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel1c]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime'), exec_status='done', executed_at=datetime('now','localtime') WHERE release_id=? AND user_id=6`, [rel1c]);

    const r1cNeg = await call('POST', `/api/sys-releases/${rel1c}/cancel-schedule`, liaisonTok, { reason: '不带确认' });
    assert.strictEqual(r1cNeg.status, 409, `[1c] 期望 409, got ${r1cNeg.status} ${JSON.stringify(r1cNeg.body)}`);
    assert.strictEqual(r1cNeg.body.code, 'CONFIRM_DISCARD_DONE_REQUIRED', '[1c] 确切码 CONFIRM_DISCARD_DONE_REQUIRED');
    assert.deepStrictEqual(r1cNeg.body.done_executor_names, ['开发乙'], '[1c] done_executor_names 含真实姓名');
    const midRows = await activeExecRows(rel1c);
    assert.strictEqual(midRows.length, 2, '[1c] 零副作用：在册仍 2 行（未被软删）');
    assert.strictEqual(midRows.find(r => r.user_id === 6).exec_status, 'done', '[1c] 零副作用：6 号仍是 done（未被动过）');
    ok('[1c] 在册已有 done 行、未带 confirm_discard_done：409 CONFIRM_DISCARD_DONE_REQUIRED + done_executor_names 含真实姓名，且零副作用（子表未被软删）');

    const r1d = await call('POST', `/api/sys-releases/${rel1c}/cancel-schedule`, liaisonTok, { reason: '带确认丢弃', confirm_discard_done: true });
    assert.strictEqual(r1d.status, 200, `[1d] 带确认期望 200, got ${r1d.status} ${JSON.stringify(r1d.body)}`);
    assert.strictEqual(r1d.body.discarded_done_count, 1, '[1d] discarded_done_count=1（6 号的完成确认被丢弃）');
    const after1d = await activeExecRows(rel1c);
    assert.strictEqual(after1d.length, 0, '[1d] 撤销后在册 0 行（含 done 行也被软删）');
    const tl1d = await cancelScheduleTimeline(rel1c);
    const lastTl1d = tl1d[tl1d.length - 1];
    assert.ok(/已丢弃 1 条完成确认：开发乙/.test(lastTl1d.summary), `[1d] timeline 如实记"已丢弃 1 条完成确认：开发乙"，实际 ${lastTl1d.summary}`);
    ok('[1d] 带 confirm_discard_done:true：200，子表全体软删（含 done 行）+ timeline 如实记"已丢弃 1 条完成确认：开发乙"（不静默丢事实）');
  }

  {
    // [1f]（C4b 预筛 M3 补实证）：staleTransitionForExecutorRelease 挪到 sysBeginImmediate + 状态校验之后
    // 这件事本身要有正面证据，不能只靠"代码挪了位置"这句话——构造一个已发布（非「计划中」）批次 + 一行
    // 超窗 sending，验证撤销请求被批次态闸 409 拒绝后，该行仍原样是 sending（未被误转 stale）。这证明拒绝
    // 的请求确实零写库：stale 批量转换是"过了状态校验这道闸之后"才会跑的专属动作，不会在请求最终被拒绝
    // 前抢跑一次转换（若还是旧代码位置——校验之前就转——这里会转成 stale，本组能把顺序错误坐实成红灯）。
    const rel1f = await mkRelease({ title: 'C4a-1f-已发布批次拒绝零写库' });
    const issue1f = await mkIssue({ title: 'C4a-1f-成员单' });
    await addIssueTo(rel1f, issue1f);
    await putExecutors(rel1f, [5, 6]);
    const row1f = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5`, [rel1f]);
    await run(
      `UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime','-6 minutes'), notify_token='tok-1f'
         WHERE id=?`, [row1f.id]
    );
    // 批次改已发布——须晚于 putExecutors（putExecutors 本身要求批次仍「计划中」）。
    await run(`UPDATE sys_releases SET status='已发布', released_at=datetime('now','localtime') WHERE id=?`, [rel1f]);
    const before1f = await get(`SELECT notify_status FROM sys_release_executors WHERE id=?`, [row1f.id]);
    assert.strictEqual(before1f.notify_status, 'sending', '[1f-前置] 构造出的行确是超窗（-6 分钟）sending 态，防夹具自己变假');
    const r1f = await call('POST', `/api/sys-releases/${rel1f}/cancel-schedule`, liaisonTok, { reason: '已发布批次撤销尝试' });
    assert.strictEqual(r1f.status, 409, `[1f] 已发布批次撤销期望 409, got ${r1f.status} ${JSON.stringify(r1f.body)}`);
    assert.strictEqual(r1f.body.code, 'RELEASE_NOT_PLANNING', `[1f] 确切码 RELEASE_NOT_PLANNING，实际 ${r1f.body.code}`);
    const after1f = await get(`SELECT notify_status FROM sys_release_executors WHERE id=?`, [row1f.id]);
    assert.strictEqual(after1f.notify_status, 'sending', `[1f] 409 拒绝后超窗 sending 行仍是 sending（未被误转 stale），实际=${after1f.notify_status}`);
    ok('[1f]（M3 补实证）已发布批次撤销请求被 409 RELEASE_NOT_PLANNING 拒绝：预造的超窗 sending 行不受影响仍是 sending——staleTransitionForExecutorRelease 挪到 sysBeginImmediate+状态校验之后确实生效，被拒绝的请求零写库（stale 转换不会在拒绝前抢跑）');
  }

  // ═══ [2] 详情端点非首位执行人放行 + 入口 stale 批量刷新（改造 5b·登记⑤）═══
  {
    const rel2 = await mkRelease({ title: 'C4a-2-详情放行' });
    const issue2 = await mkIssue({ title: 'C4a-2-成员单' });
    await addIssueTo(rel2, issue2);
    const putRes2 = await putExecutors(rel2, [5, 6]);
    const row6 = putRes2.executors.find(r => r.user_id === 6);

    // [2a] 非首位（第二个被选中的）执行人 6 号访问详情 → 200（旧判据下只有"单列比对到的那一个人"能过）
    const r2a = await call('GET', `/api/sys-releases/${rel2}`, dev6Tok);
    assert.strictEqual(r2a.status, 200, `[2a] 非首位执行人期望 200, got ${r2a.status} ${JSON.stringify(r2a.body)}`);
    ok('[2a] 非首位在册执行人（6 号）访问批次详情：200（子表 EXISTS 判定，方案 §4.4 改造 5b 收口"示例开发L打不开详情"缺口）');

    // [2d]（C5·唯一后端改动点）详情响应新增 executors 数组 + executor_notify_summary 聚合——前端多人
    // 执行人区块的唯一数据源，字段形状须与 PUT executors/hotfix-publish 两端点同构（写读同源）。
    assert.ok(Array.isArray(r2a.body.executors), '[2d] 详情响应应含 executors 数组');
    assert.strictEqual(r2a.body.executors.length, 2, '[2d] executors 数组长度=2（5/6 两人在册）');
    const r2dRow5 = r2a.body.executors.find(e => e.user_id === 5);
    const r2dRow6 = r2a.body.executors.find(e => e.user_id === 6);
    assert.ok(r2dRow5 && r2dRow6, '[2d] executors 数组含 5 号与 6 号两行');
    for (const field of ['id', 'user_id', 'user_name', 'notify_status', 'exec_status', 'read_at']) {
      assert.ok(field in r2dRow5, `[2d] executors 行应含字段 ${field}，实际键=${Object.keys(r2dRow5).join(',')}`);
    }
    assert.strictEqual(r2dRow5.notify_status, 'not_sent', '[2d] 5 号行 notify_status 为 DDL 默认 not_sent（PUT executors 刚建，未通知）');
    assert.strictEqual(r2dRow5.exec_status, 'pending', '[2d] 5 号行 exec_status 为 DDL 默认 pending');
    assert.strictEqual(r2a.body.executor_notify_summary, 'not_sent', `[2d] 两人皆 not_sent → 聚合态应为 'not_sent'，实际=${r2a.body.executor_notify_summary}`);
    ok('[2d] 详情端点 executors 数组（含 id/user_id/user_name/notify_status/exec_status/read_at 六字段）+ executor_notify_summary 聚合字段正确落地（C5 唯一后端改动点）');

    // [2d-none] 从未 PUT executors 的全新批次：详情响应 executors 应为空数组、聚合态应为 'none'
    // （方案 §4.3/v1.3 M-c 明文第 6 态——前端 none 态契约的数据源头，必须在这里先坐实）。
    const rel2dNone = await mkRelease({ title: 'C4a-2d-none态' });
    const issue2dNone = await mkIssue({ title: 'C4a-2d-none-成员单' });
    await addIssueTo(rel2dNone, issue2dNone);
    const r2dNone = await call('GET', `/api/sys-releases/${rel2dNone}`, adminTok);
    assert.strictEqual(r2dNone.status, 200, `[2d-none] admin 查详情期望 200, got ${r2dNone.status}`);
    assert.deepStrictEqual(r2dNone.body.executors, [], '[2d-none] 从未设置执行人的批次，executors 应为空数组');
    assert.strictEqual(r2dNone.body.executor_notify_summary, 'none', `[2d-none] 聚合态应为 'none'，实际=${r2dNone.body.executor_notify_summary}`);
    ok('[2d-none] 从未 PUT executors 的批次：详情响应 executors=[] + executor_notify_summary=\'none\'（none 态契约的数据源头）');

    // [2b] 曾在册后被移除（换人软删）的用户再访问 → 403
    await putExecutors(rel2, [5, 7]);   // 6 号被换掉（软删）
    const row6After = await get(`SELECT removed_at FROM sys_release_executors WHERE id=?`, [row6.id]);
    assert.ok(row6After.removed_at, '[2b-前置] 6 号的行确已软删');
    const r2b = await call('GET', `/api/sys-releases/${rel2}`, dev6Tok);
    assert.strictEqual(r2b.status, 403, `[2b] 已软删的旧执行人期望 403, got ${r2b.status}`);
    assert.strictEqual(r2b.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON_OR_ASSIGNEE', '[2b] 确切码');
    ok('[2b] 已被换人软删的旧执行人（6 号）再访问详情：403（软删行不构成在册，子表 EXISTS 精确排除）');

    // [2c] 详情入口 stale 批量刷新：构造超窗 sending 行（6 分钟前）→ GET 详情 → 该行应被批量转 stale
    const rowRel2 = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5`, [rel2]);
    await run(
      `UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime','-6 minutes'), notify_token='tok-2c'
         WHERE id=?`, [rowRel2.id]
    );
    const beforeStale = await get(`SELECT notify_status FROM sys_release_executors WHERE id=?`, [rowRel2.id]);
    assert.strictEqual(beforeStale.notify_status, 'sending', '[2c-前置] 构造出的行确是 sending 态（未刷新前）');
    const r2c = await call('GET', `/api/sys-releases/${rel2}`, adminTok);
    assert.strictEqual(r2c.status, 200, `[2c] admin 查详情期望 200, got ${r2c.status}`);
    const afterStale = await get(`SELECT notify_status FROM sys_release_executors WHERE id=?`, [rowRel2.id]);
    assert.strictEqual(afterStale.notify_status, 'stale', '[2c] 详情入口调用后，超窗 sending 行已被批量转 stale（登记⑤：打开详情先兜底刷新，前端拿到的行级状态才是新鲜的）');
    ok('[2c] 详情端点入口接线 staleTransitionForExecutorRelease：超窗（>5 分钟）sending 行经 GET 详情后被批量转 stale');

    // L4（Opus 预筛 305 号 MED-4）反向断言：未超窗（2 分钟前，仍在 5 分钟阈值内）的 sending 行不应被转
    // stale——只测"超窗会转"不能排除"函数其实不看窗口、见 sending 就转"这种更粗暴的假实现，必须同批测
    // 一个不转的负例。⚠️ MED-4 订正：必须用**在册**行打靶——用户 6 的行已在 [2b] 被 putExecutors 换人
    // 软删（removed_at 非空），staleTransitionForExecutorRelease 的 WHERE 本就带 removed_at IS NULL，
    // 拿一条已软删的行来证明"不转"根本打不到靶（它不转是因为软删，不是因为窗口）——改用 7 号（[2b] 换人
    // 后仍在册的那个人）的行。
    const row7Rel2 = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=7 AND removed_at IS NULL`, [rel2]);
    assert.ok(row7Rel2, '[2c-反例-前置] 7 号行确实在册（防夹具自己变假——若查无此行，说明打靶对象选错了）');
    await run(
      `UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime','-2 minutes'), notify_token='tok-2c-fresh'
         WHERE id=?`, [row7Rel2.id]
    );
    const r2cFresh = await call('GET', `/api/sys-releases/${rel2}`, adminTok);
    assert.strictEqual(r2cFresh.status, 200, `[2c-反例] admin 查详情期望 200, got ${r2cFresh.status}`);
    const afterFresh = await get(`SELECT notify_status FROM sys_release_executors WHERE id=?`, [row7Rel2.id]);
    assert.strictEqual(afterFresh.notify_status, 'sending', '[2c-反例] 未超窗（2 分钟前）的在册 sending 行经详情入口后仍是 sending，未被误转 stale（证明转换真的按 -5 分钟窗口判定，不是"见 sending 就转"）');
    ok('[2c-反例] 未超窗（<5 分钟）的**在册** sending 行（7 号，非已软删的 6 号）经详情入口后不转 stale——与 [2c] 正例互补，坐实窗口判定确实生效（305 号 MED-4：改用在册行才是真打靶）');
  }

  // ═══ [3] applyReleaseChange 差量非空子表软删全员（改造 6）═══
  {
    // [3a] add-issues 触发：2 人在册（sent）+ 已有 1 单在批次 → 加第 2 单 → 子表全体软删
    const rel3a = await mkRelease({ title: 'C4a-3a-加单触发软删' });
    const issueKeep3a = await mkIssue({ title: 'C4a-3a-成员单1' });
    const issueNew3a = await mkIssue({ title: 'C4a-3a-成员单2' });
    await addIssueTo(rel3a, issueKeep3a);
    await putExecutors(rel3a, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel3a]);
    // C4b 预筛 MED-1：额外把 6 号钉成 done，让本组同时覆盖"release_add 分支也会附 resetDiscardSuffix"——
    //   此前该丢弃附记只在 [1d]（schedule_cancelled 分支）验过，index.js 里 resetDoneNames/resetDiscardSuffix
    //   是 add-issues/update-planned-date/remove-issues/schedule_cancelled 四条分支共用同一份计算（见 :8831
    //   注释"供下方 release_add/release_date_change/release_remove..."），只测过其中一条分支不足以证明
    //   共用逻辑在别的调用方一样生效。
    await run(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE release_id=? AND user_id=6 AND removed_at IS NULL`, [rel3a]);
    const before3a = await activeExecRows(rel3a);
    assert.strictEqual(before3a.length, 2, '[3a-前置] 在册 2 行（5 号 sent，6 号 sent+done）');
    // addIssueTo(rel3a, issueKeep3a) 已在上面跑过一次真实 add-issues（非直连 SQL），本身就写了 1 条
    //   release_add（issueKeep3a）；这里量的是"即将发生的这次加单"前后差，不能从 0 开始算。
    const tlAddBefore3a = (await timelineByCode(rel3a, 'release_add')).length;

    const r3a = await call('POST', `/api/sys-releases/${rel3a}/add-issues`, adminTok, { issue_ids: [issueNew3a] });
    assert.strictEqual(r3a.status, 200, `[3a] 加单期望 200, got ${r3a.status} ${JSON.stringify(r3a.body)}`);
    const after3a = await activeExecRows(rel3a);
    assert.strictEqual(after3a.length, 0, '[3a] 加单成功后子表在册 0 行（applyReleaseChange 差量非空触发全体软删，方案 §4.4 改造 6）');
    const allRows3a = await allExecRows(rel3a);
    assert.ok(allRows3a.every(r => r.removed_at), '[3a] 物理行仍在但均已软删');
    // C4b 预筛 MED-1：timeline 断言——release_add 恰为新加入的 issueNew3a 那一行新增 1 条（addedIds 只含
    //   本次新加的单，不含批次里已有的 issueKeep3a），且这条新记录如实带上"已丢弃 1 条完成确认：开发乙"
    //   （resetDoneNames 在软删前算好，随本次 release_add 一并写入，证明该丢弃附记不是 [1d] 独有的孤例）。
    const tlAdd3a = await timelineByCode(rel3a, 'release_add');
    assert.strictEqual(tlAdd3a.length, tlAddBefore3a + 1, `[3a] release_add timeline +1（本次仅 issueNew3a 一条新记录），实际 ${tlAddBefore3a}→${tlAdd3a.length}`);
    const lastTlAdd3a = tlAdd3a[tlAdd3a.length - 1];
    assert.ok(/已丢弃 1 条完成确认：开发乙/.test(lastTlAdd3a.summary), `[3a] release_add 记录如实附"已丢弃 1 条完成确认：开发乙"，实际 ${lastTlAdd3a.summary}`);
    ok('[3a] add-issues（差量非空）触发子表软删全员：2 名在册执行人（sent+done）在加单后全部被软删；release_add timeline +1 且含"已丢弃 1 条完成确认：开发乙"（与旧六列重置同步，并存期两边一致；丢弃附记非 schedule_cancelled 分支独有）');

    // [3b] update-planned-date 触发同款效果
    const rel3b = await mkRelease({ title: 'C4a-3b-改期触发软删', plannedDate: '2032-06-01' });
    const issue3b = await mkIssue({ title: 'C4a-3b-成员单' });
    await addIssueTo(rel3b, issue3b);
    await putExecutors(rel3b, [5, 6]);
    const before3b = await activeExecRows(rel3b);
    assert.strictEqual(before3b.length, 2, '[3b-前置] 在册 2 行');
    const tlDateBefore3b = (await timelineByCode(rel3b, 'release_date_change')).length;
    assert.strictEqual(tlDateBefore3b, 0, '[3b-前置] release_date_change 尚无记录（本批次只发生过一次 add-issues，从未改期）');
    const r3b = await call('POST', `/api/sys-releases/${rel3b}/update-planned-date`, adminTok, { planned_date: '2032-07-01' });
    assert.strictEqual(r3b.status, 200, `[3b] 改期期望 200, got ${r3b.status} ${JSON.stringify(r3b.body)}`);
    const after3b = await activeExecRows(rel3b);
    assert.strictEqual(after3b.length, 0, '[3b] 改期成功后子表在册 0 行（差量非空同样触发子表软删全员）');
    const tlDate3b = await timelineByCode(rel3b, 'release_date_change');
    assert.strictEqual(tlDate3b.length, 1, `[3b] release_date_change timeline +1（批次仅 1 个成员单 issue3b），实际 ${tlDate3b.length}`);
    ok('[3b] update-planned-date（差量非空）触发子表软删全员：2 名在册执行人在改期后全部被软删；release_date_change timeline 从 0 新增 1 条');

    // [3c]（L5·Opus 预筛）同值改期哨兵：差量为空（改期传的是同一个日期）时 applyReleaseChange 的
    // isEmpty 短路应生效——子表不应被软删。用一批全新夹具（3b 的批次此刻子表已空，测不出"不变"这件事）。
    const rel3c = await mkRelease({ title: 'C4a-3c-同值改期不触发软删', plannedDate: '2032-08-01' });
    const issue3c = await mkIssue({ title: 'C4a-3c-成员单' });
    await addIssueTo(rel3c, issue3c);
    await putExecutors(rel3c, [5, 6]);
    const before3c = await activeExecRows(rel3c);
    assert.strictEqual(before3c.length, 2, '[3c-前置] 在册 2 行');
    // C4b 预筛 MED-1：全仓（不分 action_code）计数哨兵——原 verify-sys-release-batch.js ④组"同值改期幂等"
    //   曾是全项目唯一验这件事的看守，本组随①-⑭收编分诊被删（见 batch.js 收编清单），此处补回等价物：
    //   不只测 release_date_change 这一个 action_code 没新增，而是本批次整条 timeline 一行都没多，防的是
    //   "isEmpty 短路漏判某个分支、悄悄从另一个 action_code 溜进去写了一条"这类更隐蔽的失败模式。
    const tlTotalBefore3c = (await timelineTotal(rel3c)).length;
    const r3c = await call('POST', `/api/sys-releases/${rel3c}/update-planned-date`, adminTok, { planned_date: '2032-08-01' });   // 与建批次时同一天
    assert.strictEqual(r3c.status, 200, `[3c] 同值改期期望 200, got ${r3c.status} ${JSON.stringify(r3c.body)}`);
    assert.strictEqual(r3c.body.changed, false, '[3c] changed=false（差量为空，applyReleaseChange isEmpty 短路）');
    const after3c = await activeExecRows(rel3c);
    assert.strictEqual(after3c.length, 2, '[3c] 同值改期（差量为空）后子表在册行数不变，仍是 2 行——证明软删是被"差量非空"这个条件真正把关的，不是逢改期必删');
    const tlTotalAfter3c = (await timelineTotal(rel3c)).length;
    assert.strictEqual(tlTotalAfter3c, tlTotalBefore3c, `[3c] timeline 零新增（全仓哨兵，不分 action_code），实际 ${tlTotalBefore3c}→${tlTotalAfter3c}——isEmpty 短路是整段 timelineTargets 循环都没跑，不只是子表软删这一件事没发生`);
    ok('[3c] 同值改期（无实际变化）：changed=false + 子表在册行数不变 + timeline 全仓零新增（isEmpty 短路未触发软删也未触发任何 timeline 写入，与 [3a]/[3b] 的"真变化→全体软删+timeline+1"互补对照）');
  }

  // ═══ [4] remove-issues keepExecutor 保留全体在册行（改造 7）═══
  {
    const rel4 = await mkRelease({ title: 'C4a-4-keepExecutor保留全体' });
    const issueKeep4 = await mkIssue({ title: 'C4a-4-成员单1' });
    const issueRemove4 = await mkIssue({ title: 'C4a-4-成员单2' });
    await addIssueTo(rel4, issueKeep4);
    await addIssueTo(rel4, issueRemove4);
    await putExecutors(rel4, [5, 6, 7]);   // 三人在册，其中 actor=6 移除一单，5/7 应原样保留
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel4]);
    const row5_4 = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5`, [rel4]);
    await run(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE id=?`, [row5_4.id]);   // 5 号（非 actor）已 done，验证"含各自 exec_status"保留

    const r4 = await call('POST', `/api/sys-releases/${rel4}/remove-issues`, dev6Tok, { issue_ids: [issueRemove4], reason: '不该随本批发布' });
    assert.strictEqual(r4.status, 200, `[4] 执行人移单期望 200, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.executor_kept, true, '[4] executor_kept=true（剩余>0）');
    const after4 = await activeExecRows(rel4);
    assert.strictEqual(after4.length, 3, '[4] 移单（keepExecutor）后在册仍是 3 行（5/6/7 全体保留，不只 actor 6 号一人，方案 §4.4 改造 7）');
    const row5_4After = after4.find(r => r.user_id === 5);
    assert.strictEqual(row5_4After.exec_status, 'done', '[4] 5 号（非 actor）的 exec_status=done 原样保留（含各自 exec_status，非重置）');
    const row7_4After = after4.find(r => r.user_id === 7);
    assert.strictEqual(row7_4After.exec_status, 'pending', '[4] 7 号（非 actor）的 exec_status=pending 原样保留');
    const row6_4After = after4.find(r => r.user_id === 6);
    assert.strictEqual(row6_4After.exec_status, 'pending', '[4] 6 号（actor 本人）的 exec_status 未被 remove-issues 动过，仍 pending');
    ok('[4] remove-issues keepExecutor：actor（6 号）移单后在册仍是全体 3 行（5/6/7），5 号 done / 7 号 pending 各自 exec_status 原样保留，不只保留 actor 一人');
  }

  // ═══ [5] mine 过滤两维度 EXISTS（改造 8）═══
  {
    // [5a] 批次维度：GET /sys-releases（e.release_id = r.id）
    const rel5a = await mkRelease({ title: 'C4a-5a-批次维度mine正例' });
    await putExecutors(rel5a, [5, 6]);
    const relNoExec5a = await mkRelease({ title: 'C4a-5a-批次维度mine反例（无执行人）' });

    const r5aMine = await call('GET', '/api/sys-releases', dev5Tok);
    assert.strictEqual(r5aMine.status, 200, `[5a] 期望 200, got ${r5aMine.status}`);
    assert.strictEqual(r5aMine.body.scope, 'mine', '[5a] scope=mine');
    assert.ok(r5aMine.body.items.length > 0, '[5a] mine 视角非空（正例真实咬合，防 every 在空集上恒真）');
    assert.ok(r5aMine.body.items.some(x => x.id === rel5a), '[5a] 正例：5 号在册的批次出现在 mine 视角（e.release_id=r.id）');
    assert.ok(r5aMine.body.items.every(x => x.id !== relNoExec5a), '[5a] 反例：无执行人的批次不出现');
    // MED-5（Opus 预筛）断言升级：不满足于"挑一个正例出现、挑一个反例不出现"，逐行反查子表在册——
    // 返回集里的**每一条**都必须真有 5 号的在册行，全体命中才算过，防"过滤条件其实更宽松（比如漏判
    // 了某类历史批次）"这种只测单点样本测不出的系统性泄漏。
    for (const item of r5aMine.body.items) {
      const rosterHit = await get(
        `SELECT 1 FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`,
        [item.id]
      );
      assert.ok(rosterHit, `[5a] MED-5 逐行反查：返回集中批次 #${item.id}（${item.release_no}）必须有 5 号的在册行，未命中即判定过滤条件泄漏`);
    }
    ok('[5a] mine 过滤·批次维度（GET /sys-releases）：EXISTS(e.release_id=r.id) 正例命中在册批次 + 反例排除无执行人批次 + MED-5 返回集逐行反查子表在册全命中');

    // [5b] 迭代单维度：GET /sys-issues（e.release_id = i.release_id）——issue 本身没有独立执行人身份，
    //   可见性经由其所属批次的子表在册行判定。
    const rel5b = await mkRelease({ title: 'C4a-5b-迭代单维度mine正例' });
    const issue5b = await mkIssue({ title: 'C4a-5b-成员单（批次执行人=6号）' });
    await addIssueTo(rel5b, issue5b);
    await putExecutors(rel5b, [6, 7]);   // 6 号在册，5 号不在册
    const issueNoRelease5b = await mkIssue({ title: 'C4a-5b-对照单（无批次）' });

    const r5bList = await call('GET', '/api/sys-issues', dev6Tok);
    assert.strictEqual(r5bList.status, 200, `[5b] 期望 200, got ${r5bList.status}`);
    assert.ok(r5bList.body.items.some(x => x.id === issue5b), '[5b] 正例：6 号（本批次在册执行人）能在列表看到该 issue（e.release_id=i.release_id）');

    const r5bListOther = await call('GET', '/api/sys-issues', dev5Tok);
    assert.strictEqual(r5bListOther.status, 200, `[5b-反例] 期望 200, got ${r5bListOther.status}`);
    assert.ok(r5bListOther.body.items.every(x => x.id !== issue5b), '[5b] 反例：5 号（非本批次执行人）看不到该 issue');
    assert.ok(r5bListOther.body.items.every(x => x.id !== issueNoRelease5b), '[5b] 反例：无批次的对照单，普通用户 5 号本就看不到（非本人建单/非在册）');
    ok('[5b] mine 过滤·迭代单维度（GET /sys-issues 列表可见性）：EXISTS(e.release_id=i.release_id) 正例命中批次在册执行人 + 反例排除非在册用户');
  }

  // ═══ [6]（HIGH-1·Opus 预筛）通知态聚合六态全表 + 三方交叉一致性（防复刻漂移的真防线）═══
  //   方案 §4.3 六态：none/sending/sent/not_sent/partial/failed。三个独立实现必须逐态一致：
  //   ① I.deriveExecutorNotifySummary(execRows) —— 纯函数直调，JS 版
  //   ② I.getReleaseNotifySummary(releaseId) —— DB 查询版（内部复用①，但独立调用路径，防止两者被
  //      分别改出分歧）
  //   ③ GET /sys-issues 响应体的 executor_notify_summary —— 内联 SQL CASE 版（列表端点走的是纯 SQL，
  //      与①②完全独立实现，是"复刻漂移"最容易发生的地方——业务逻辑改了 JS 版，SQL 版忘了跟着改）
  //   每态各建一批次+一成员单，三版本各查一次，互相比对且都必须等于期望值。
  {
    async function assertTriState(label, releaseId, issueId, execRows, expected) {
      const jsVal = I.deriveExecutorNotifySummary(execRows);
      const dbVal = await I.getReleaseNotifySummary(releaseId);
      const listRes = await call('GET', '/api/sys-issues', adminTok);
      assert.strictEqual(listRes.status, 200, `[6-${label}] GET /sys-issues 期望 200, got ${listRes.status}`);
      const issueRow = listRes.body.items.find(x => x.id === issueId);
      assert.ok(issueRow, `[6-${label}] 列表应含本组构造的成员单 #${issueId}`);
      const sqlVal = issueRow.executor_notify_summary;
      assert.strictEqual(jsVal, expected, `[6-${label}] JS 版(deriveExecutorNotifySummary)应为 '${expected}'，实际 '${jsVal}'`);
      assert.strictEqual(dbVal, expected, `[6-${label}] DB 版(getReleaseNotifySummary)应为 '${expected}'，实际 '${dbVal}'`);
      assert.strictEqual(sqlVal, expected, `[6-${label}] SQL CASE 版(GET /sys-issues 的 executor_notify_summary)应为 '${expected}'，实际 '${sqlVal}'`);
      ok(`[6-${label}] 三方交叉一致：JS 版=DB 版=SQL CASE 版='${expected}'`);
    }

    // [6-none]：0 在册行（从未 PUT executors）。
    const rel6none = await mkRelease({ title: 'C4a-6-none' });
    const issue6none = await mkIssue({ title: 'C4a-6-none-成员单' });
    await addIssueTo(rel6none, issue6none);
    await assertTriState('none', rel6none, issue6none, [], 'none');

    // [6-sending]：一行 sent、一行 sending——命中优先级最高的"存在 sending"分支。
    const rel6sending = await mkRelease({ title: 'C4a-6-sending' });
    const issue6sending = await mkIssue({ title: 'C4a-6-sending-成员单' });
    await addIssueTo(rel6sending, issue6sending);
    await putExecutors(rel6sending, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel6sending]);
    await run(`UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime'), notify_token='tok-6a' WHERE release_id=? AND user_id=6`, [rel6sending]);
    const rows6sending = await activeExecRows(rel6sending);
    await assertTriState('sending', rel6sending, issue6sending, rows6sending, 'sending');

    // [6-sent]：全部 sent。
    const rel6sent = await mkRelease({ title: 'C4a-6-sent' });
    const issue6sent = await mkIssue({ title: 'C4a-6-sent-成员单' });
    await addIssueTo(rel6sent, issue6sent);
    await putExecutors(rel6sent, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel6sent]);
    const rows6sent = await activeExecRows(rel6sent);
    await assertTriState('sent', rel6sent, issue6sent, rows6sent, 'sent');

    // [6-not_sent]：全部 not_sent（DDL 默认，PUT executors 刚建的新行原样）。
    const rel6notSent = await mkRelease({ title: 'C4a-6-not_sent' });
    const issue6notSent = await mkIssue({ title: 'C4a-6-not_sent-成员单' });
    await addIssueTo(rel6notSent, issue6notSent);
    await putExecutors(rel6notSent, [5, 6]);
    const rows6notSent = await activeExecRows(rel6notSent);
    await assertTriState('not_sent', rel6notSent, issue6notSent, rows6notSent, 'not_sent');

    // [6-partial]：一行 sent、一行 failed（有 sent 但不全、无 sending）。
    const rel6partial = await mkRelease({ title: 'C4a-6-partial' });
    const issue6partial = await mkIssue({ title: 'C4a-6-partial-成员单' });
    await addIssueTo(rel6partial, issue6partial);
    await putExecutors(rel6partial, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel6partial]);
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='测试失败' WHERE release_id=? AND user_id=6`, [rel6partial]);
    const rows6partial = await activeExecRows(rel6partial);
    await assertTriState('partial', rel6partial, issue6partial, rows6partial, 'partial');

    // [6-failed]：全部 failed（无 sent/sending，不全 not_sent，兜底分支）。
    const rel6failed = await mkRelease({ title: 'C4a-6-failed' });
    const issue6failed = await mkIssue({ title: 'C4a-6-failed-成员单' });
    await addIssueTo(rel6failed, issue6failed);
    await putExecutors(rel6failed, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='全员失败' WHERE release_id=? AND removed_at IS NULL`, [rel6failed]);
    const rows6failed = await activeExecRows(rel6failed);
    await assertTriState('failed', rel6failed, issue6failed, rows6failed, 'failed');

    // [6-stale归并]：全部 stale——方案 §4.3 明文"stale 归入 failed 是刻意归并"，不是独立的第七态。
    const rel6stale = await mkRelease({ title: 'C4a-6-stale归并' });
    const issue6stale = await mkIssue({ title: 'C4a-6-stale归并-成员单' });
    await addIssueTo(rel6stale, issue6stale);
    await putExecutors(rel6stale, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='stale' WHERE release_id=? AND removed_at IS NULL`, [rel6stale]);
    const rows6stale = await activeExecRows(rel6stale);
    await assertTriState('stale归并', rel6stale, issue6stale, rows6stale, 'failed');

    // [6-partial含stale]：一行 sent、一行 stale（无 sending，有 sent 但不全）——partial 分支不因掺了
    // stale 而漏判，进一步坐实"partial 判据=有 sent 但不全、且无 sending"，与 failed 分支的具体成因无关。
    const rel6partialStale = await mkRelease({ title: 'C4a-6-partial含stale' });
    const issue6partialStale = await mkIssue({ title: 'C4a-6-partial含stale-成员单' });
    await addIssueTo(rel6partialStale, issue6partialStale);
    await putExecutors(rel6partialStale, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel6partialStale]);
    await run(`UPDATE sys_release_executors SET notify_status='stale' WHERE release_id=? AND user_id=6`, [rel6partialStale]);
    const rows6partialStale = await activeExecRows(rel6partialStale);
    await assertTriState('partial含stale', rel6partialStale, issue6partialStale, rows6partialStale, 'partial');

    // [6-脏值]（Opus 预筛 305 号 M2）：构造 notify_status 为值域外脏字符串的行——PRAGMA
    // ignore_check_constraints 绕过本表 CHECK(notify_status IN (...))（正常写路径因该 CHECK 结构性不可达，
    // 此处专为验证 fail-closed 而人工造脏）。⚠️ 实测订正：该列还叠了 NOT NULL 约束，PRAGMA
    // ignore_check_constraints **只放宽 CHECK、不放宽 NOT NULL**——真 NULL 在这张表物理写不进去，改用
    // "值域外脏字符串"（如同一件事：既不是 'sent' 也不是其余四个合法值的"未知态"）达到同等验证目的。
    // 验证正向计数法（COUNT(*)=SUM(...)）在这种输入下不会像原先的"<>"比对写法那样把脏行悄悄放过、误判
    // 成"全部 sent"——JS 版（execRows.every 天然对未知字符串严格不等，本就 fail-closed）与 SQL CASE 版
    // 必须三方一致，且都不能是 'sent'。
    const rel6dirty = await mkRelease({ title: 'C4a-6-脏值' });
    const issue6dirty = await mkIssue({ title: 'C4a-6-脏值-成员单' });
    await addIssueTo(rel6dirty, issue6dirty);
    await putExecutors(rel6dirty, [5, 6]);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel6dirty]);
    await run(`PRAGMA ignore_check_constraints = ON`);
    try {
      await run(`UPDATE sys_release_executors SET notify_status='CORRUPTED_UNKNOWN' WHERE release_id=? AND user_id=6`, [rel6dirty]);
    } finally {
      await run(`PRAGMA ignore_check_constraints = OFF`);   // 立即复位，避免残留放宽全局约束影响本文件其余用例
    }
    const rows6dirty = await activeExecRows(rel6dirty);
    const dirtyRow = rows6dirty.find(r => r.user_id === 6);
    assert.strictEqual(dirtyRow.notify_status, 'CORRUPTED_UNKNOWN', '[6-脏值-前置] 6 号行 notify_status 确已被构造成值域外脏字符串（绕过 CHECK 的脏值场景，防夹具自己变假）');
    const jsValDirty = I.deriveExecutorNotifySummary(rows6dirty);
    const dbValDirty = await I.getReleaseNotifySummary(rel6dirty);
    const listResDirty = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(listResDirty.status, 200, `[6-脏值] GET /sys-issues 期望 200, got ${listResDirty.status}`);
    const issueRowDirty = listResDirty.body.items.find(x => x.id === issue6dirty);
    assert.ok(issueRowDirty, '[6-脏值] 列表应含本组构造的成员单');
    const sqlValDirty = issueRowDirty.executor_notify_summary;
    assert.strictEqual(jsValDirty, dbValDirty, `[6-脏值] JS 版与 DB 版应相等（同一份 deriveExecutorNotifySummary 实现，交叉核对夹具本身无误），JS=${jsValDirty} DB=${dbValDirty}`);
    assert.strictEqual(jsValDirty, sqlValDirty, `[6-脏值] JS 版与 SQL CASE 版在值域外脏值下仍须相等——三方交叉防"两套独立实现在异常值处理上分道扬镳"这条复刻漂移风险，JS=${jsValDirty} SQL=${sqlValDirty}`);
    assert.notStrictEqual(sqlValDirty, 'sent', `[6-脏值] 脏值场景绝不能被误判为 'sent'（fail-closed 底线：宁可报 partial/failed 也不能假装"全部正常"），实际=${sqlValDirty}`);
    // C4b 预筛 MED-3：ok() 文案措辞订正——本组是"三方（JS/DB/SQL CASE）脏值一致性回归网"，不是 M2 那个
    //   具体 SQL 三值逻辑 bug 场景的红灯回归证据。M2 原本要修的判别输入是"notify_status 为真 NULL 时
    //   `<>` 比对求值为 NULL（非 TRUE），导致 EXISTS 误判"；但该列同时叠着 NOT NULL 约束，真 NULL 在当前
    //   schema 下结构性不可达（PRAGMA ignore_check_constraints 只放宽 CHECK、不放宽 NOT NULL），本组只能
    //   构造非 NULL 的脏字符串代替——若把 SQL CASE 换回原始的 `<>` 写法，脏字符串（如 'CORRUPTED_UNKNOWN'）
    //   在 SQL 三值逻辑下 `<> 'sent'` 依然稳定求值为 TRUE（不是 NULL），旧写法照样能正确处理，本组不会因此
    //   变红——真正会让旧写法变红的只有 NULL 本身，而 NULL 在这张表里根本插不进去。本组的价值是验证"正向
    //   计数法在脏字符串输入下三方仍保持一致、且不会被误判成 sent"，是一般性健壮性回归网，非 M2 bug 复现。
    ok(`[6-脏值] 三方（JS/DB/SQL CASE）脏值一致性回归网：notify_status 值域外脏字符串（PRAGMA ignore_check_constraints 绕过 CHECK 构造；NOT NULL 独立于 CHECK 无法绕过，真 NULL 在此列结构性不可达，改用脏字符串验证一般性健壮性，非 M2 原 bug 场景的红灯证据）下，JS 版=SQL CASE 版=DB 版 三方仍一致（均='${sqlValDirty}'，非 'sent'）——正向计数法（COUNT(*)=SUM(...)）不会被脏值悄悄计入"已完成"`);

    // [6-JS直调脏值向量]（307 号 M2·codex 对抗审）：上面 [6-脏值] 走的是"真实 DB 行→HTTP→三方交叉"整条
    // 链路，构造不出"数组元素本身是 null"或"对象缺 notify_status 字段"这类形状——DB 查询结果永远是形状
    // 规整的行对象。deriveExecutorNotifySummary 是纯函数，`execRows` 参数不受 SQL 查询形状约束，理论上能
    // 收到畸形输入（调用方拼装错误/上游数据源变化等）——这层"纯函数自身要不要崩"的健壮性，只有绕过 DB、
    // 在 JS 层直接调用 I.deriveExecutorNotifySummary(...) 才能真正打到。三个向量对齐 307-M2 原文点名的
    // 三类："域外串"/"缺 notify_status 字段的行对象"/"null 元素"，逐一断言：不抛异常 + 结果落 failed 或
    // partial（fail-closed 底线），绝不能是 sent 或 not_sent（那两个分支要求"全数组同构成立"，畸形元素
    // 天然凑不齐这个条件——若凑齐了，说明实现把畸形值悄悄计成了合法值，是真正的红灯）。
    {
      const vDomain = I.deriveExecutorNotifySummary([{ notify_status: 'sent' }, { notify_status: 'CORRUPTED_JS_DIRECT' }]);
      assert.ok(vDomain === 'failed' || vDomain === 'partial', `[6-JS直调-域外串] 域外字符串行不应崩溃且须落 failed/partial，实际=${vDomain}`);
      assert.notStrictEqual(vDomain, 'sent', '[6-JS直调-域外串] 绝不能被域外串"凑成"全 sent');
      assert.notStrictEqual(vDomain, 'not_sent', '[6-JS直调-域外串] 绝不能被域外串"凑成"全 not_sent');
      ok(`[6-JS直调-域外串] deriveExecutorNotifySummary 直调（非经 DB/HTTP）：混入 notify_status='CORRUPTED_JS_DIRECT' 的行不抛异常，落=${vDomain}（fail-closed）`);

      const vMissingField = I.deriveExecutorNotifySummary([{ user_id: 5 }, { user_id: 6 }]);   // 两行均缺 notify_status 字段
      assert.ok(vMissingField === 'failed' || vMissingField === 'partial', `[6-JS直调-缺字段] 全体缺 notify_status 字段不应崩溃且须落 failed/partial，实际=${vMissingField}`);
      assert.notStrictEqual(vMissingField, 'sent', '[6-JS直调-缺字段] 绝不能因字段缺失（undefined）被误判全 sent');
      assert.notStrictEqual(vMissingField, 'not_sent', '[6-JS直调-缺字段] 绝不能因字段缺失（undefined）被误判全 not_sent');
      ok(`[6-JS直调-缺字段] deriveExecutorNotifySummary 直调：行对象整体缺 notify_status 字段（非 null 是 undefined）不抛异常，落=${vMissingField}（fail-closed）`);

      const vNullElement = I.deriveExecutorNotifySummary([{ notify_status: 'sent' }, null]);   // 数组元素本身是 null（非对象缺字段）
      assert.ok(vNullElement === 'failed' || vNullElement === 'partial', `[6-JS直调-null元素] 数组含 null 元素不应崩溃且须落 failed/partial，实际=${vNullElement}`);
      assert.notStrictEqual(vNullElement, 'sent', '[6-JS直调-null元素] 绝不能因 null 元素被误判全 sent');
      assert.notStrictEqual(vNullElement, 'not_sent', '[6-JS直调-null元素] 绝不能因 null 元素被误判全 not_sent');
      ok(`[6-JS直调-null元素] deriveExecutorNotifySummary 直调：数组元素本身是 null（\`r && r.notify_status\` 防护对象）不抛异常，落=${vNullElement}（fail-closed，验证的是"不崩溃"这条底线本身，比 DB 链路更贴近函数真实签名边界）`);
    }
  }

  // ═══ [7]（307 号 M3①·codex 对抗审）sys_release_executors 全体写点静态普查 ═══
  //   目的：全项目对 sys_release_executors 的每一处 UPDATE/INSERT，要么处于 sysBeginImmediate() 全局互斥
  //   事务保护下，要么是有明文设计理由的刻意例外——本组不重新证明每条写路径的业务正确性（那是上面 [1]-[6]
  //   组的事），只钉住"写点清单本身"与"各自的保护机制归类"，防未来新增/挪动写点时悄悄漏掉加锁却没人发现。
  //   白名单式：写点集合变化（新增/删除/跨上下文挪动/写点首行被改）→ 清单比对直接红；保护机制归类
  //   变化（比如某条从"直接持锁"改成"调用方持锁"却忘了同步改调用方）→ 对应分类断言红。
  //   ⭐ S0-a 起判定基准是「锚点键」不是行号（详见下方注释）：上游纯行号位移**不再**红——那是设计意图，
  //   不是漏判；写点在源码里往下挪 50 行但仍在同一个函数/路由里，语义上并没有多一处或少一处写。
  {
    // S0-a（codex 312-L2 建议 + 2026-08-07 长任务「系统迭代随批五项 C7-C11」启动门用户拍板）：本组判定
    // 基准从「index.js 行号数组」整体改为「锚点键 = 上下文标签 :: 语句签名」。理由不是"行号维护太烦"，
    // 而是"例行更白名单"这个动作本身有害——行号随 index.js 任何上游编辑（哪怕只是上方多写两行注释）整体
    // 位移，每个 commit 都红一次、每次都照抄实际值贴回去，久而久之红灯就退化成一道无脑抄写的手续，真正
    // 新增的写点混在位移里没人会去分辨。锚点键不含行号，对上游位移天然免疫，红灯不再由纯行号位移触发
    //（S0-fix 预筛 LOW-1 措辞收窄：写点首行的纯排版改动也会改键，"只剩一种成因"原话过强），红了就必须实质审视。
    //
    // ⚠️ SYS_C4A_INDEX_SRC 只供本组的变异自检注入（构造假写点/删真写点/挪写点，证明断言真会红）。正式跑
    // 一律不设该变量；一旦命中会打印醒目告警并把实际路径写进 ok() 文案，避免"指着别的文件跑出一片绿"。
    // ⭐ S0-fix2·313-L5 双钥匙：光靠"告警文案"防不住残留——CI 的环境变量、开发机的 shell profile、
    //   docker-compose 的 env 段都可能把 SYS_C4A_INDEX_SRC 带进正式跑，而告警只是 stdout 里一行字，
    //   套件照样全绿退出、CI 照样打勾，没有任何机制阻止它。改成两把钥匙：路径变量单独设置**直接
    //   assert.fail 响亮红**，必须同时显式 SYS_C4A_ALLOW_INJECT=1 才生效。这样"残留一个变量"的失败
    //   模式从"静默对着替身文件全绿"翻转成"红灯逼人处理"，方向是 fail-closed。
    const DEFAULT_SRC_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const srcPath = process.env.SYS_C4A_INDEX_SRC || DEFAULT_SRC_PATH;
    const srcOverridden = srcPath !== DEFAULT_SRC_PATH;
    if (srcOverridden && process.env.SYS_C4A_ALLOW_INJECT !== '1') {
      assert.fail(`[7-注入口] SYS_C4A_INDEX_SRC 已设为 ${srcPath}，但未同时设置 SYS_C4A_ALLOW_INJECT=1——` +
        `本组的静态普查会去扫那个替身文件而非真实 index.js，全绿也毫无意义。若这是有意的变异自检，两个变量一起设；` +
        `若是 CI/环境残留（正是本闸要防的情形），清掉 SYS_C4A_INDEX_SRC 再跑。`);
    }
    if (srcOverridden) console.log(`  ⚠️ [7] 静态普查源码被 SYS_C4A_INDEX_SRC 覆盖为 ${srcPath}（仅变异自检用，正式跑必须不设该变量）`);
    const src = fs.readFileSync(srcPath, 'utf8');
    const srcLines = src.split('\n');

    // 308 号①（非阻塞加固）：改整篇正则扫描（/gi + matchAll），不再逐行用 `.test(line)`——原逐行版本对
    // "UPDATE"/"INSERT INTO"与"sys_release_executors"跨行分写（如 `UPDATE\n  sys_release_executors SET`，
    // SQL 模板字符串里合法但常见的换行排版）会漏扫，是静态普查本身的一个绕过缺口。改用
    // `/(UPDATE|INSERT\s+INTO)\s+sys_release_executors\b/gi` 整篇匹配后，把每个匹配的字符 offset 换算回
    // 行号（数 offset 之前的换行符个数 +1）。排除注释：只看**匹配起始那一行**trim 后是否以 `//` 开头——
    // 跨行匹配理论上可能起于非注释行、中间穿过注释行，但本文件的注释/代码从不夹杂到这种程度，起始行判据
    // 已足够且比逐行判据覆盖面更宽（不会像逐行版本那样连"UPDATE"三个字都碰不到而彻底漏判）。
    function scanRealStatementLines(pattern) {
      const hits = [];
      let m;
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      while ((m = re.exec(src)) !== null) {
        const lineNo = src.slice(0, m.index).split('\n').length;   // 1-based
        const lineText = srcLines[lineNo - 1] || '';
        if (lineText.trim().startsWith('//')) continue;
        hits.push(lineNo);
        if (m.index === re.lastIndex) re.lastIndex++;   // 防零宽匹配死循环
      }
      // L15（codex 预筛）：去掉 Set 去重——原版本对"同一行出现两处匹配"（如一行内塞了
      // `UPDATE ...; INSERT INTO sys_release_executors ...` 这种紧凑写法）会静默把两个独立写点合并成
      // 一个，白名单比对照样能过，实际上漏计了一条真实写点。不去重后，若未来真出现同行双写点，
      // writeLineNumbers 里会带重复行号，长度/内容与白名单对不上，deepStrictEqual 直接报红，逼着显式
      // 认领这条新写点（而不是被去重悄悄吃掉）。当前全部 11 处写点各自独占一行，不去重不改变现状输出。
      return hits;
    }
    // L15（codex 预筛）：正则窗口扩 DELETE FROM / REPLACE INTO——预防性加固，本表当前无任何删除/替换
    // 写法（307 号 L1 已用 `grep DELETE FROM sys_releases` 核实生产路径零删除，本表同理确认现全仓 0
    // 命中），扩了窗口后白名单集合不变，这里只是让"万一将来真出现"这种写点也逃不过普查，不是发现了
    // 遗漏。
    const writeLineNumbers = scanRealStatementLines(/(UPDATE|INSERT\s+INTO|DELETE\s+FROM|REPLACE\s+INTO)\s+sys_release_executors\b/gi);

    // ── S0-a 锚点定位：把上面扫到的行号换算成不含行号的稳定键 ──────────
    // 上下文标签：从写点起始行向上扫，最先命中者胜——
    //   ① `router.<method>('<path>'` 声明 → `METHOD /path`（写点的宿主路由；路径须与声明同行=现行全仓
    //      风格，该前提由下方「前置风格锁」断言钉死，拆写形态先红再谈）
    //   ② 具名函数声明 `[async] function <name>(` → `fn:<name>`（写点的宿主函数；嵌套函数会先于外层路由
    //      命中，这正是要的语义——写点真正的宿主是那个函数，"从函数体挪进路由体"必须体现为键变化）
    //   ②b 函数表达式/箭头助手声明 `const|let|var <name> = [async] (…)=>／function` → `fn:<name>`
    //      （S0-fix·预筛 HIGH-1：缺此条时写点搬进箭头助手会把宿主错落到上方旧声明，键不变=静默逃逸锁
    //      分类。基线 11 键实测零误伤——正则只认"赋值右侧是函数形态"，普通局部 const 不命中）
    //   ③ 都扫不到时回落最近的 `// ═══` 区段标题 → `§<标题>`；再没有就 `<file-top>`
    //   仍不识别的宿主形态：对象字面量方法/类方法（全仓路由文件现无此风格；出现时归属回落上层，双射
    //   仍能检出增删、标签精度下降）。
    // 语句签名：写点起始行 trim → 连续空白压成单空格 → 剥掉模板字符串起首/结尾定界符（结尾可带尾逗号）
    //   → 截断 200 字符。⚠️ 签名只覆盖写点**起始行**——SET 续行与 WHERE 子句不参与判定（改 WHERE 不红；
    //   写路径语义正确性由 [1]-[6] 组承担，本组只钉写点集合·预筛 MED-2 去声称）。
    // 双射语义：新增写点 → 多一个键（同上下文同语句则该键计数 +1）；删除 → 少一个；跨上下文挪动 → 旧键
    //   消失 + 新键出现。写点数组不去重（承接 L15 决定），排序后 deepStrictEqual 比的就是 multiset，
    //   因此"在同一个函数里复制一条一模一样的写"照样红，不会被"键相同"吃掉。
    const ANCHOR_ROUTE = /^\s*router\.(get|post|put|delete|patch|all)\(\s*(['"`])([^'"`]+)\2/;
    const ANCHOR_FN    = /^\s*(?:async\s+)?function\s+(\w+)\s*\(/;
    const ANCHOR_ARROW = /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b|\w+\s*=>)/;
    const ANCHOR_SECT  = /^\s*\/\/\s*═+/;
    // ⭐ S0-fix2·313-H2 作用域感知：原实现是"向上最近的声明"，而语义上要的是"最近的**外层宿主**"。两者
    //   在这种真实排版下会分岔：
    //       router.post('/x', async (req, res) => {
    //         const helper = () => { ... };          ← 声明在前，但写点不在它体内
    //         await sysBeginImmediate();
    //         await dbRunAsync(`UPDATE sys_release_executors ...`);   ← 向上最近声明=helper（错）
    //       });
    //   错归属的后果不是"标签难看"，是**逃出锁分类**：该写点的 kind 变成 function，直接被 A类a 的
    //   `kind === 'route'` 过滤掉，从此不受任何窗口检查（313-H1 的闭环断言会兜住"没人管"这一层，但归属
    //   本身仍该修对，否则闭环断言只会逼人去补一份错分类）。
    //   修法：函数类候选（ANCHOR_FN/ANCHOR_ARROW）命中后，用 balanced-brace 求出它的函数体跨度，只有当
    //   写点行确实落在跨度内才接受这个宿主，否则视为"平级的兄弟声明"继续向上扫。
    //   ⚠️ 两条刻意的边界（写实登记，不假装已闭合）：
    //     · 声明行内找不到 `{` 时（表达式体箭头 `const f = x => x + 1`、跨行参数列表把 `{` 挤到下一行等）
    //       **回退现行为直接接受**——这类声明要么没有块体（不可能包含写点，接受它只会让标签退化成兄弟名，
    //       不影响 kind 之外的判定），要么形态罕见到本仓当前零命中。宁可保守接受也不引入跨行解析。
    //     · balanced-brace 是裸字符计数，不解析字符串/模板/注释里的花括号（同本文件既有 extractFunctionBody
    //       范式）。SQL 模板串里出现 `{` 会让跨度算长——方向是"多接受"，与上一条同侧，不会漏掉真宿主。
    //   ⭐ S0-fix3·313-B【M】ANCHOR_ROUTE 同样纳入跨度校验（推翻上一版"路由不校验"的取舍）：上一版的理由
    //   是"路由体必然包住其内所有写点"，但那句话只覆盖了**路由体之内**的写点，漏了**路由之后**的——顶层
    //   `setInterval(async () => { ... })`、模块尾部的定时任务/初始化回调里的写点，向上扫最先撞到的仍是那个
    //   已经闭合的路由声明，于是被冒领成 `POST /xxx` 并混进 directRouteAnchors，拿路由体里的锁给自己背书
    //   （窗口从路由声明行起，必然包含那把锁）＝ 假绿。这与 H2 修的是同一个病（"最近声明"≠"外层宿主"），
    //   只是发生在路由这一侧。
    //   路由跨度用 **balanced-paren**（不是 brace）：`router.post('/x', mw1, mw2, async (req,res) => {...})`
    //   的回调体花括号全在这对圆括号里，paren 配平即整个注册调用结束，比找 `{` 稳（中间件参数个数不定）。
    const fnSpanCache = new Map();
    const routeSpanCache = new Map();
    function routeCallEndLine(declLine) {
      if (routeSpanCache.has(declLine)) return routeSpanCache.get(declLine);
      const t = srcLines[declLine - 1] || '';
      const openCol = t.indexOf('(');   // `router.post(` 的这个 `(` 必是行内首个（method 名不含括号）
      let result = null;
      if (openCol >= 0) {
        let offset = 0;
        for (let i = 0; i < declLine - 1; i++) offset += srcLines[i].length + 1;
        offset += openCol;
        let depth = 0, end = -1;
        for (let i = offset; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        result = end < 0 ? null : src.slice(0, end).split('\n').length;
      }
      // 不可判（行内无 `(`，或 paren 至文件尾仍不配平——裸字符计数会被字符串/注释里的孤立括号带偏）
      // → null → 回退接受，与 fnBodyEndLine 的边界处置同侧（宁可多接受，不引入词法分析）。
      routeSpanCache.set(declLine, result);
      return result;
    }
    function fnBodyEndLine(declLine) {
      if (fnSpanCache.has(declLine)) return fnSpanCache.get(declLine);
      const t = srcLines[declLine - 1] || '';
      // ⚠️ 函数体起始 `{` ≠ 声明行的**首个** `{`——`async function applyReleaseChange(releaseId, actor,
      //   delta, opts = {}) {` 的首个 `{` 是默认参数 `opts = {}` 里的那个，它下一字符就闭合，跨度会被算成
      //   "只有声明行本身"，宿主随即被误判为兄弟声明、写点一路上溯错归属（本仓实测：applyReleaseChange 的
      //   写点会错落到 fn:releaseFamilyOf）。正确判据=**圆括号深度为 0 时遇到的首个 `{`**：参数列表内的
      //   花括号 parenDepth≥1 天然被跳过，箭头函数 `(a,b) => {` / 函数表达式 `function (a) {` 同样适用。
      let braceCol = -1, parenDepth = 0;
      for (let c = 0; c < t.length; c++) {
        const ch = t[c];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        else if (ch === '{' && parenDepth <= 0) { braceCol = c; break; }
      }
      let result;
      if (braceCol < 0) {
        result = null;   // 声明行无块体起始 → 回退接受（见上方边界①）
      } else {
        // 换算成全文字符 offset：前 declLine-1 行的长度 + 换行符（srcLines 由 split('\n') 得到，故每行补 1）
        let offset = 0;
        for (let i = 0; i < declLine - 1; i++) offset += srcLines[i].length + 1;
        offset += braceCol;
        let depth = 0, end = -1;
        for (let i = offset; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        result = end < 0 ? null : src.slice(0, end).split('\n').length;   // 括号不平衡也回退接受
      }
      fnSpanCache.set(declLine, result);
      return result;
    }
    function anchorContextFor(lineNo) {
      for (let i = lineNo - 1; i >= 1; i--) {
        const t = srcLines[i - 1] || '';
        let m;
        if ((m = ANCHOR_ROUTE.exec(t))) {
          const routeEnd = routeCallEndLine(i);
          if (routeEnd === null || lineNo <= routeEnd) return { kind: 'route', label: `${m[1].toUpperCase()} ${m[3]}`, at: i };
          continue;   // 该路由的注册调用已在写点之前闭合——写点在它之后而非之内，不是宿主，继续上溯
        }
        if ((m = ANCHOR_FN.exec(t)) || (m = ANCHOR_ARROW.exec(t))) {
          const endLine = fnBodyEndLine(i);
          if (endLine === null || lineNo <= endLine) return { kind: 'function', label: `fn:${m[1]}`, at: i };
          continue;   // 兄弟声明（其函数体已在写点之前闭合）——不是宿主，继续向上找真正的外层
        }
        if (ANCHOR_SECT.test(t)) return { kind: 'section', label: `§${t.replace(/[═\s]+/g, ' ').replace(/^\s*\/\/\s*/, '').trim().slice(0, 60)}`, at: i };
      }
      return { kind: 'file', label: '<file-top>', at: 1 };
    }
    // 前置风格锁（S0-fix·预筛 MED-4）：锚点归属正确性依赖「router.<method>( 与其路径字符串同行」这一现行
    // 风格（ffd26f4 时点 90/90 全符合）。未来若出现多行拆写的 router 声明，写点会被静默错归属到上方另一
    // 宿主——与其做两行解析，不如把风格前提钉成断言：拆写形态在这里先红，逼着同步升级 anchorContextFor。
    srcLines.forEach((t, idx) => {
      if (/^\s*router\.(get|post|put|delete|patch|all)\(/.test(t)) {
        assert.ok(ANCHOR_ROUTE.test(t), `[7-前置] index.js :${idx + 1} 的 router 声明未在同一行给出路径字符串（多行拆写）——锚点归属前提被破坏，须先升级 anchorContextFor 的路由识别再更新本断言`);
      }
    });
    function statementSignatureFor(lineNo) {
      return (srcLines[lineNo - 1] || '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^[`'"]/, '')
        .replace(/`,?$/, '')
        .trim()
        .slice(0, 200);
    }
    const writeAnchors = writeLineNumbers.map((ln) => {
      const ctx = anchorContextFor(ln);
      const sig = statementSignatureFor(ln);
      return { line: ln, kind: ctx.kind, label: ctx.label, anchorAt: ctx.at, sig, key: `${ctx.label} :: ${sig}` };
    });
    // 行号只进诊断输出，不进判定（这是 S0-a 的分水岭：判定看键、定位看行号）。
    const anchorTableText = writeAnchors
      .map((a) => `    :${String(a.line).padStart(6)}  (宿主声明 :${a.anchorAt})  ${a.key}`)
      .join('\n');

    // 白名单（307 号 M3① 立、S0-a 换口径）：钉死当前全部真实写点的**锚点键**。任何新增/删除/跨上下文挪动
    // 都会让下面 deepStrictEqual 变红，逼着改动者显式认领并更新本清单——不允许"顺手加一条写"悄悄溜过静态
    // 普查。清单里刻意不写行号（含"仅供参考"的行号注释也不写）：DIRECT_ROUTE_WRITES 的前车之鉴就是"不参与
    // 判定的参考行号"必然过时且过时了没人发现（见下方 A 类细分注释）。要定位就跑一次看红灯里的诊断全表。
    const WHITELIST_KEYS = [
      // B 类（2 处）：惰性 stale 转换两助手，刻意的架构例外（见下方 B 类分诊）
      "fn:staleTransitionForExecutorRow :: UPDATE sys_release_executors SET notify_status = 'stale'",
      "fn:staleTransitionForExecutorRelease :: UPDATE sys_release_executors SET notify_status = 'stale'",
      // A 类（9 处）：均受全局互斥保护，a/b/c/d 四种保护形态细分见下
      "fn:applyReleaseChange :: UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?",
      "fn:preemptReleaseExecutorNotifySend :: UPDATE sys_release_executors SET",
      "fn:sendReleaseExecutorNotifyAndWriteback :: UPDATE sys_release_executors SET",
      "POST /sys-releases/:id/cancel-schedule :: UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?",
      "PUT /sys-releases/:id/executors :: UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?",
      "PUT /sys-releases/:id/executors :: INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)",
      "GET /sys-releases/:id/executors/:userId/read-status :: UPDATE sys_release_executors SET read_at = ?",
      "POST /sys-releases/:id/execute :: UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime')",
      "POST /sys-issues/:id/hotfix-publish :: INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)",
    ];
    assert.deepStrictEqual(
      writeAnchors.map((a) => a.key).sort(),
      [...WHITELIST_KEYS].sort(),
      `[7-普查] sys_release_executors 真实写点集合与锚点键白名单不一致（新增/删除/跨上下文挪动任一处都会红）。\n` +
        `  实际扫描到的 (锚点键, 行号) 全表（行号仅供定位，不参与判定）：\n${anchorTableText}\n` +
        `  白名单键（${WHITELIST_KEYS.length} 条）：\n${WHITELIST_KEYS.map((k) => `    ${k}`).join('\n')}`
    );
    ok(`[7-普查] sys_release_executors 全体 UPDATE/INSERT/DELETE/REPLACE 写点=白名单钉死的 ${WHITELIST_KEYS.length} 个锚点键（上下文标签 :: 语句签名），按 multiset 比对零差异${srcOverridden ? `【⚠️ 源码来自注入路径 ${srcPath}】` : ''}`);

    // 提取具名函数体（从声明到匹配的右括号，balanced-brace，同 verify-sys-release-panel-static.js 既有
    // extractFunctionBody 范式）——用于 B 类"函数体自身是否持锁"的判定。
    function extractFunctionBody(source, fnName) {
      const m = new RegExp(`async function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
      if (!m) return null;
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
      }
      return null;
    }
    // 找具名函数/方法的全部真实调用点行号（排除注释行；`fnName(` 前必须是 `await ` 或行首空白，防止匹配到
    // 函数自身的声明行 `async function fnName(...)`）。
    // 308 号②（非阻塞加固）：调用点识别正则从 `(?:await\s+)fnName\(`（要求紧邻 "await "）放宽为
    // `\bfnName\s*\(`——原版本对 `return fnName(...)`、`Promise.all([fnName(...), ...])`、甚至"忘了写
    // await 就调用"这类不以 "await " 直接打头的真实调用形态会漏扫，而"漏扫"恰恰会让"某处调用忘了在
    // 事务里"这类真正的 bug 从静态普查的窗口检测里静默溜走（找不到调用点=不会去检查它的事务窗口）。
    // `\b` 前缀防止匹配到更长标识符的后缀片段；`\s*\(` 要求名字后（跳过可选空白）紧跟左括号，天然不会
    // 匹配进另一个更长标识符的中间。
    function findRealCallSites(fnName) {
      const callRe = new RegExp(`\\b${fnName}\\s*\\(`);
      const declRe = new RegExp(`async function\\s+${fnName}\\(`);
      const hits = [];
      srcLines.forEach((line, idx) => {
        if (line.trim().startsWith('//')) return;
        if (declRe.test(line)) return;
        if (callRe.test(line)) hits.push(idx + 1);
      });
      return hits;
    }
    // 事务窗口 = 「宿主声明行 → 目标行」这段源码，判定其中是否出现过 sysBeginImmediate()——回答"这个
    // 写点/调用点当时是不是已经在事务里"。
    // ⭐ S0-fix2·313-M3：窗口起点原先走一个独立的 nearestAnchorLine（判据是 `router.(get|post|put|delete)(`
    //   或 `async function`，比 anchorContextFor 少 patch/all、少非 async function、少箭头助手、且完全没有
    //   跨度校验），与锚点归属用的是**两套不同口径**。同一个"谁是宿主"的问题在同一组里给出两个答案，就是
    //   313 反杀我们此前"登记接受"的地方：口径分岔时窗口会比归属更宽，宽窗口=更容易碰到一个 sysBeginImmediate
    //   而假绿。现已整体删除 nearestAnchorLine，窗口起点统一取 anchorContextFor 的 `at`（A类a 直接用
    //   writeAnchors 里已算好的 a.anchorAt，A类d 现算 anchorContextFor(callLine).at）。
    // ⭐ S0-fix3·313-B【H】统一"活代码锁检测"：S0-fix2 的 313-M4 只给**窗口**这一处加了行注释过滤，
    //   函数体那三处（A类b sendBack / A类c sysNotifyWrite / A类d 裸助手负向）仍是裸正则直打全文——同一个
    //   "这里到底有没有锁"的问题在同一组里又出现了两套口径，正是 313-M3 刚反杀过的病。且函数体检查恰恰是
    //   最容易被块注释骗的地方（把一整段连锁带业务 `/* ... */` 掉是重构时的常见中间态）。
    //   现统一走 containsLiveBeginImmediate：先剥两类注释再匹配。
    //   剥注释顺序：先整行 `//`（行首形态最常见，也最省事），再 `/* ... */`（`[\s\S]*?` 非贪婪，跨行有效）。
    //   ⚠️ 两条边界分开登记，别混为一谈：
    //     · **注释**边界：本函数已处理（整行 `//`、**行尾 `//`**、跨行 `/* */` 三形态）。行尾形态是 313-C
    //       MED 补修——「该行已有活代码」≠「已有活的 sysBeginImmediate 调用」，`const x = 1; // await
    //       sysBeginImmediate()` 若真锁已删，旧逻辑会拿注释文本当活锁假绿（B4 变异修前实证）。剥法=每行
    //       从首个 `//` 起截断：字符串里含 `//`（如 URL 字面量）会把其后文本一并剥掉，但方向上只可能
    //       **少算锁 → 假红**（fail-closed 侧，红了人会来看），不会假绿；本仓写点窗口零命中。
    //     · **字符串字面量**边界（313-B/313-C 均已明确接受，不实现）：`logger.info('sysBeginImmediate() 失败')`
    //       这类字面量里的调用文本仍会假命中。真要防需引入词法分析，收益不抵复杂度；本仓当前零命中。
    function stripComments(text) {
      return text
        .split('\n')
        .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
    }
    function containsLiveBeginImmediate(text) {
      // 调用名与括号间容空白（313-C 建议）：格式化把 `sysBeginImmediate()` 改成 `sysBeginImmediate ()` 时不误判无锁
      return /sysBeginImmediate\s*\(\s*\)/.test(stripComments(text));
    }
    function windowContainsBeginImmediate(fromLine, toLine) {
      return containsLiveBeginImmediate(srcLines.slice(fromLine - 1, toLine).join('\n'));
    }

    // A 类细分：
    //   a) 路由体直写（自身窗口须含 sysBeginImmediate）：cancel-schedule / PUT executors×2 / execute / hotfix-publish
    //   b) 自持事务的函数（函数体自身须含 sysBeginImmediate）：sendReleaseExecutorNotifyAndWriteback
    //   c) 经 sysNotifyWrite/sysNotifyWriteRun 包装（写点紧邻处出现该包装调用，且包装函数自身持锁）：read-status 路由
    //   d) 调用方持锁的裸助手（函数体自身不持锁，但**全部**调用点各自窗口须含 sysBeginImmediate）：
    //      applyReleaseChange / preemptReleaseExecutorNotifySend
    //
    // S0-a：a 类原先是一条硬编码行号数组 `DIRECT_ROUTE_WRITES = [9911, 10256, ...]`，已整体删除，改为从
    // writeAnchors 按"宿主是路由 && 不是 c 类的 read-status 写点"动态派生。删它不只为免行号漂移——L1 扫尾
    // 记录过：该数组虽自称"仅供定位参考、非断言事实来源"，值却曾与旧行号白名单同批漂移且没人发现
    // （windowContainsBeginImmediate 的窗口足够宽松，拿一个漂移后的行号照样能命中某个含锁的窗口，红不了；
    // L1 扫尾已订正过一轮——删除时刻的值本身是准的，删的是"必然再次过时"的机制，不是一份错值·预筛 LOW-3）。
    // 这就是"不参与判定的参考行号"的典型结局：既不能证伪什么，又一定会过时。派生后它恒等于真相。
    // 派生集合非空是必须单独钉的（防"过滤条件写错导致空集，for 循环恒真绿"这类空转假绿）；集合内容本身
    // 已由上面的 WHITELIST_KEYS 双射钉死，此处不再复述一份路由清单（复述=第二处要手工同步的真相源）。
    const READ_STATUS_SQL_FEATURE = /read_at = \?/;   // read-status 路由写点的识别特征（子串命中·唯一性不靠注释声称，由下一行断言钉死）
    // S0-fix·预筛 MED-3：唯一性前提升级为断言（同仓先例=verify-sys-liaison-test.js 的计数断言范式）。若无
    // 此断言，未来第 2 处含 `read_at = ?` 的写点会在白名单红灯被"照抄补键"后，永久静默脱离 A类a 窗口检查。
    const rsMatches = writeAnchors.filter((a) => READ_STATUS_SQL_FEATURE.test(a.sig));
    assert.strictEqual(rsMatches.length, 1, `[7-A类c-前置] \`read_at = ?\` 特征应恰命中 1 处写点，实际 ${rsMatches.length} 处——唯一性是 A类a 排除条件与 A类c 定位的共同前提；出现第 2 处含 read_at 的写点时须重审其锁分类归属，不能只把新键补进白名单了事`);
    const directRouteAnchors = writeAnchors.filter((a) => a.kind === 'route' && !READ_STATUS_SQL_FEATURE.test(a.sig));
    assert.ok(directRouteAnchors.length > 0, '[7-A类a-前置] 路由体直写派生集合不应为空（空集会让下面的 for 循环恒真空转，是假绿）');

    // ── 分类名单常量（A类b/A类d/B类）：上提到此处，供下方「分类覆盖闭环」与各自的分类断言**共用同一份** ──
    const SELF_TXN_FN = 'sendReleaseExecutorNotifyAndWriteback';                                   // A 类 b
    const CALLER_HELD = [{ fnName: 'applyReleaseChange' }, { fnName: 'preemptReleaseExecutorNotifySend' }];   // A 类 d
    const B_CLASS_FNS = ['staleTransitionForExecutorRow', 'staleTransitionForExecutorRelease'];     // B 类

    // ═══ ⭐ S0-fix2·313-H1：分类覆盖闭环断言 ═══
    //   上面的 WHITELIST_KEYS 只回答"这条写点被人认领过没有"，**不回答"它被哪个锁分类管着"**。两者之间
    //   有个真实的缝：白名单红灯时最省事的处置是把实际键照抄补进 WHITELIST_KEYS——若那条新写点恰好落在
    //   一个具名函数里（键形如 `fn:someNewHelper :: UPDATE ...`），它既不进 directRouteAnchors（kind 不是
    //   route）、也不在 SELF_TXN_FN/CALLER_HELD/B_CLASS_FNS 任何一份名单里，于是**全套锁检查一条都不会
    //   跑到它头上**，套件却全绿。补键这个动作本身还会让人产生"我已经认领过了"的错觉。
    //   闭环判据：五个分类源各自"实际管到了哪些键"合并起来，必须与写点全集**逐条对上**（multiset）。
    //   ⚠️ 覆盖集**全部从既有分类常量/派生集合反查 writeAnchors 得来**，一个字面键都不新写——若这里手写
    //   第二份键清单，就等于把 WHITELIST_KEYS 的维护负担复制一份，两份还会各自漂移，那正是本组从行号数组
    //   一路重构过来要消灭的东西（313 对 C 项表态的核心）。
    const keysOfLabel = (label) => writeAnchors.filter((a) => a.label === label).map((a) => a.key);
    const coveredKeys = [
      ...directRouteAnchors.map((a) => a.key),                              // A 类 a：路由体直写（派生自 kind==='route'）
      ...rsMatches.map((a) => a.key),                                       // A 类 c：read-status（唯一性已由上方计数断言钉死）
      ...keysOfLabel(`fn:${SELF_TXN_FN}`),                                  // A 类 b：自持事务函数
      ...CALLER_HELD.flatMap(({ fnName }) => keysOfLabel(`fn:${fnName}`)),  // A 类 d：调用方持锁的裸助手
      ...B_CLASS_FNS.flatMap((fnName) => keysOfLabel(`fn:${fnName}`)),      // B 类：惰性 stale 转换两助手
    ];
    // multiset 差集（同键多写点要按出现次数对账，不能用 Set/includes——那会把"同函数里多了一条一模一样的写"吃掉）
    const multisetDiff = (from, minus) => {
      const cnt = new Map();
      for (const k of minus) cnt.set(k, (cnt.get(k) || 0) + 1);
      const out = [];
      for (const k of from) { const c = cnt.get(k) || 0; if (c > 0) cnt.set(k, c - 1); else out.push(k); }
      return out;
    };
    const allWriteKeys = writeAnchors.map((a) => a.key);
    const uncoveredKeys = multisetDiff(allWriteKeys, coveredKeys);
    const phantomKeys = multisetDiff(coveredKeys, allWriteKeys);
    assert.deepStrictEqual(
      [...coveredKeys].sort(),
      [...allWriteKeys].sort(),
      `[7-闭环] 写点集合与"被锁分类实际覆盖的键"不一致——存在没有任何锁检查管的写点（或分类名单指向了不存在的写点）。\n` +
        `  ❌ 未被任何分类覆盖的键（${uncoveredKeys.length} 条）：\n${uncoveredKeys.map((k) => `    ${k}`).join('\n') || '    （无）'}\n` +
        // 覆盖集全部反查自 writeAnchors，故"名单指向不存在的写点"不会产生 phantom（那种情况下 keysOfLabel
        // 直接返回空数组）。phantom 非空只有一种成因：**同一条写点被两个分类同时认领**（重复计数），那会
        // 恰好抵消掉另一条真正没人管的写点，让总数对上而闭环失效——所以这一侧必须一起对账，不能只看 uncovered。
        `  ❌ 被两个分类重复认领的键（${phantomKeys.length} 条·重复计数会掩盖另一条真正没人管的写点）：\n${phantomKeys.map((k) => `    ${k}`).join('\n') || '    （无）'}\n` +
        `  处置：给新写点判定它属于 A类a/b/c/d 还是 B 类，把宿主函数名加进对应名单（SELF_TXN_FN / CALLER_HELD / B_CLASS_FNS），\n` +
        `       或确认它是路由体直写（宿主标签为 "METHOD /path"）。只把键补进 WHITELIST_KEYS 是**不够**的——那只认领不上锁。`
    );
    ok(`[7-闭环] ⭐ 分类覆盖闭环：${allWriteKeys.length} 处写点逐条被五个锁分类源（A类a 路由直写 ${directRouteAnchors.length} / A类b 自持事务 ${keysOfLabel(`fn:${SELF_TXN_FN}`).length} / A类c 包装 ${rsMatches.length} / A类d 裸助手 ${CALLER_HELD.flatMap(({ fnName }) => keysOfLabel(`fn:${fnName}`)).length} / B类 惰性转换 ${B_CLASS_FNS.flatMap((f) => keysOfLabel(`fn:${f}`)).length}）之一覆盖，无"只认领不上锁"的漏网写点——覆盖集全部由分类常量反查派生，非第二份手写键清单`);

    for (const a of directRouteAnchors) {
      assert.ok(windowContainsBeginImmediate(a.anchorAt, a.line), `[7-A类a] 路由体直写「${a.key}」(:${a.line}，事务锚点 :${a.anchorAt}) 窗口内应含 sysBeginImmediate()，未命中——可能保护丢失`);
    }
    ok(`[7-A类a] ${directRouteAnchors.length} 处路由体直写（${directRouteAnchors.map((a) => a.label).join(' / ')}）逐个确认自身窗口含 sysBeginImmediate()`);

    const sendBackBody = extractFunctionBody(src, SELF_TXN_FN);
    assert.ok(sendBackBody, `[7-A类b-前置] ${SELF_TXN_FN} 函数体应能被提取（防函数改名导致本组静默失效）`);
    assert.ok(containsLiveBeginImmediate(sendBackBody), `[7-A类b] ${SELF_TXN_FN} 自身函数体应含**活代码**的 sysBeginImmediate()（MED-3 自持独立小事务，先于 timeline 写提交；313-B【H】：注释掉的锁不算锁）`);
    ok(`[7-A类b] ${SELF_TXN_FN}（自持事务）函数体内确认含 sysBeginImmediate()`);

    const wrapperBody = extractFunctionBody(src, 'sysNotifyWrite');
    assert.ok(wrapperBody, '[7-A类c-前置] sysNotifyWrite 函数体应能被提取');
    assert.ok(containsLiveBeginImmediate(wrapperBody), '[7-A类c] sysNotifyWrite 包装函数自身应含**活代码**的 sysBeginImmediate()（通知落库写串行化进 sys mutex，ultracode 审 #1；313-B【H】：注释掉的锁不算锁）');
    // 按 SQL 文本特征（READ_STATUS_SQL_FEATURE = `read_at = ?`，本表全部写点里唯一只更新这一列的语句）从
    // 写点清单里动态定位，不依赖硬编码行号——写点清单本身已被上面的锚点键白名单钉死，这里只是从中"认出哪
    // 一条是它"。S0-a：判据抽成上面那个共享常量，与 A 类 a 的排除条件同源（同一个"哪条是 read-status 写点"
    // 的事实只在一处写死，避免两边各写一份 `read_at = ?` 日后改了一边漏另一边）。
    const rsLine = rsMatches[0].line;   // 唯一性已由上方 [7-A类c-前置] 计数断言钉死，此处直取
    const nearbyBeforeRs = srcLines.slice(rsLine - 4, rsLine - 1).join('\n');   // 写点前 3 行内应能看到包装调用
    assert.ok(/sysNotifyWrite\(/.test(nearbyBeforeRs), `[7-A类c] read-status 写点（:${rsLine}）紧邻处应出现 sysNotifyWrite( 包装调用，未命中——可能被改成裸 dbRunAsync 直写（脱离串行化）。附近文本：${JSON.stringify(nearbyBeforeRs)}`);
    ok(`[7-A类c] read-status 路由的已读固化写回（:${rsLine}）经 sysNotifyWrite 包装调用，包装函数自身确认持锁——写点虽不在路由自身事务窗口内，但受包装函数的独立小事务保护`);

    // CALLER_HELD 已上提到「分类名单常量」段（与分类覆盖闭环共用同一份，避免两处各写一份函数名）
    for (const { fnName } of CALLER_HELD) {
      const body = extractFunctionBody(src, fnName);
      assert.ok(body, `[7-A类d-前置] ${fnName} 函数体应能被提取`);
      // 313-B【H】口径统一（判据本身不变，仍是 `sysBeginImmediate()`，只多剥一层注释）：注释掉的锁不该
      //   让这条**负向**断言误红——"函数体里留了一句 `// await sysBeginImmediate()` 的历史注释"不等于
      //   "这个裸助手改成自持事务了"。
      assert.ok(!containsLiveBeginImmediate(body), `[7-A类d] ${fnName} 函数体自身不应含活代码的 sysBeginImmediate()（应是裸助手，事务由调用方持有——若这条断言红了，说明函数改成自持事务，上面"调用方须持锁"这条分类已经过时该改判定方式）`);
      const callSites = findRealCallSites(fnName);
      assert.ok(callSites.length > 0, `[7-A类d] ${fnName} 应至少有 1 个真实调用点（否则死代码不该出现在写点白名单里）`);
      for (const callLine of callSites) {
        // 313-M3：窗口起点与锚点归属同源——同样走 anchorContextFor（含跨度校验/箭头助手识别），
        //   不再走那个判据更窄、无跨度校验的 nearestAnchorLine（已删）。
        const anchor = anchorContextFor(callLine).at;
        assert.ok(windowContainsBeginImmediate(anchor, callLine), `[7-A类d] ${fnName} 调用点 :${callLine}（锚点 :${anchor}）窗口内应含 sysBeginImmediate()，未命中——存在无锁调用该助手的路径`);
      }
      ok(`[7-A类d] ${fnName}（写点所在裸助手，函数体自身不持锁）全部 ${callSites.length} 个真实调用点（:${callSites.join('/:')}）逐个确认各自窗口含 sysBeginImmediate()`);
    }

    // B 类（2 处）：惰性 stale 转换两助手——staleTransitionForExecutorRow/Release 函数体本身刻意不持锁，
    // 调用点是否在事务内视上下文而定（cancel-schedule 内那一处确实在事务内；详情端点入口/单行通知入口两处
    // 刻意在事务外跑，源码内已有明文设计理由"单条 UPDATE，非事务写路径"——鉴权后才做的幂等惰性状态转换，
    // 不需要也不该占用全局互斥）。断言：① 两个函数体自身都不含 sysBeginImmediate（确认是裸助手）；
    // ② 全文仍能找到"非事务写路径"这条设计理由原文（防止这条关键依据被未来重构悄悄删掉，导致后人误判
    // "这俩函数被非事务调用是遗漏加锁的 bug"而错误地"顺手"补锁，反而违背了"鉴权后不该有写副作用"的初衷）。
    {
      // B_CLASS_FNS 已上提到「分类名单常量」段（与分类覆盖闭环共用同一份）——改逐个遍历，函数名只写一次
      for (const fnName of B_CLASS_FNS) {
        const body = extractFunctionBody(src, fnName);
        assert.ok(body, `[7-B类-前置] ${fnName} 函数体应能被提取（防函数改名/签名变化导致本组静默失效）`);
        assert.ok(!/sysBeginImmediate/.test(stripComments(body)), `[7-B类] ${fnName} 函数体自身不应含 sysBeginImmediate（裸助手，事务与否由调用方上下文决定）`);
      }
      assert.ok(/非事务写路径/.test(src), '[7-B类] 全文应仍能找到"非事务写路径"这条设计理由原文（详情端点入口刻意在鉴权后、事务外调用 staleTransitionForExecutorRelease 的书面依据）');
      ok(`[7-B类] ${B_CLASS_FNS.join('/')} 两个惰性 stale 转换助手：函数体自身确认不持锁（裸助手）+ "非事务写路径"设计理由原文仍在全文中——是刻意的架构例外，不是遗漏加锁`);
    }
  }

  console.log(`\n✅ verify-sys-release-c4a 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
