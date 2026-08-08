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
//       EXECUTOR_REMOVE_NOT_NOTIFIED（C4a 起判序改为**在册身份检查先于通知态检查**——子表查询天然把
//       "身份"和"这一行的通知态"绑在同一次 SELECT 里，不像旧单列世界能分两步查；[D4] 用"不在册+批次
//       通知态非 sent"这一具体组合坐实新判序：老判序会先看批次级 ns 给出 409（对一个根本不是本批执行人
//       的人说"你还没被通知"，语义误导），新判序给 403（如实说"你不是本批执行人"））；均零副作用
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
// [C4b 退场新增] 子表单行查询——批次级通知六列已无任何写路径（H1 根治），本文件的"未变/零副作用"类断言
// 改从这里验证真正在承载状态的子表（只看在册行，removed_at IS NULL；软删后查无此行返回 undefined，
// 供调用方判断"是否已被移出在册"）。
async function execRow(relId, userId) {
  return get(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND user_id=? AND removed_at IS NULL`, [relId, userId]);
}
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

// 建一个「已通知」批次（子表在册行 sent，assignee=userId），返回 { relId, issueIds }。
//   [C4b 退场] 原经由批次级 POST /sys-releases/:id/notify-executor 路由构造前置态——该路由随批次级单
//   执行人通知机制整体退场（H1 根治）已删除。remove-issues 端点非 admin 分支的"我是本批执行人"判据
//   已完全改子表在册行（sys_release_executors），旧批次级单列（release_assignee_id/notify_status）
//   自此再无任何写路径（并存期"两边一致"的兜底注释已随之作废），本函数直接用 PUT executors + 子表
//   UPDATE 构造目标态，不再依赖已删除的旧端点。[决策 7 第三次修正·方案 v1.7 二订同步更正] 本函数仍只
//   建 1 人在册（调用方传入的 userId）——下限已降到 1 人，单人批次现在本身就是生产真实路径可达的合法
//   形态（PUT executors 闸②现只拒空集合），本函数用直接 SQL INSERT 构造目标态单纯是为了绕开通知/资格
//   等与 remove-issues 判据本身无关的前置步骤（同 [D4] 等既有用例手法走最短路径造态），不再是"绕开人数
//   闸"这层含义。
async function mkNotifiedRelease(userId, userName, issueTitles) {
  const d = nextDutyDate();
  await seedRoster(d, userId, userName);
  const relId = await mkRelease({ plannedDate: d });
  const issueIds = [];
  for (const t of issueTitles) issueIds.push(await mkIssue('feature', '待上线', { title: t }));
  await addIssuesTo(relId, issueIds);
  await run(
    `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
     VALUES (?, ?, ?, 'sent', datetime('now','localtime'), 1, '管理员')`,
    [relId, userId, userName]
  );
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
    // [C4b 退场] 前置/未变断言改子表——批次级通知六列已无任何写路径（H1 根治，全项目冻结在 DDL 默认值），
    // "keepExecutor 保留身份"这件事此刻只能也应当从子表在册行验证。
    const before = await execRow(relId, 5);
    assert.strictEqual(before.notify_status, 'sent', '[A]前置：子表 5 号行 notify_status=sent');

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue2], reason: '不该随本批发布' });
    assert.strictEqual(r.status, 200, `[A]执行人移单期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.remaining_count, 1, '[A]remaining_count=1（issue1 仍在册）');
    assert.strictEqual(r.body.executor_kept, true, '[A]executor_kept=true（剩余>0，保留身份）');

    const after = await execRow(relId, 5);
    assert.strictEqual(after.id, before.id, '[A]子表 5 号行 id 未变（未被软删重建，是原地保留，非新代次）');
    assert.strictEqual(after.notify_status, 'sent', '[A]子表 5 号行通知状态未被重置，仍 sent（keepExecutor 保留身份）');
    assert.strictEqual(after.exec_status, before.exec_status, '[A]子表 5 号行 exec_status 未变');

    const removedRow = await issueRow(issue2);
    assert.strictEqual(removedRow.release_id, null, '[A]被移单 release_id 已清');
    assert.strictEqual(removedRow.status, '待上线', '[A]被移单主状态仍「待上线」（未受影响）');
    const kept = await issueRow(issue1);
    assert.strictEqual(kept.release_id, relId, '[A]未被移除的 issue1 仍在批次内');

    const tl = await lastReleaseRemoveTimeline(issue2);
    assert.ok(tl, '[A]timeline 已写 release_remove 行');
    assert.strictEqual(tl.summary, '执行人移出上线批次（原因：不该随本批发布）', '[A]timeline 文案含原因且不含"已重置"字样');

    ok('[A] 执行人移单成功（剩余>0）：200 + remaining_count=1 + executor_kept=true；子表 5 号在册行 id/通知态/exec_status 全部未变（keepExecutor 保留身份）；被移单回「待上线」release_id=NULL；timeline 含原因不含"已重置"');

    // ═══ [B] 紧接着把最后一单也移出（剩余=0，移空）═══
    const r2 = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue1], reason: '批次整体作废' });
    assert.strictEqual(r2.status, 200, `[B]执行人移空期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.remaining_count, 0, '[B]remaining_count=0');
    assert.strictEqual(r2.body.executor_kept, false, '[B]executor_kept=false（移空，全重置）');

    // [C4b 退场] "全重置"的真实信号已从批次级六列迁到子表——移空场景 executor_kept=false，applyReleaseChange
    // 差量非空触发子表软删全员（方案 §4.4 改造 6），验证 5 号那行确已被软删（而非仍在册）。
    const relAfterEmpty = await relRow(relId);
    const execAfterEmpty = await execRow(relId, 5);
    assert.strictEqual(execAfterEmpty, undefined, '[B]子表 5 号行已软删（移空全重置，在册查询查无此行）');
    assert.strictEqual(relAfterEmpty.release_type, null, '[B]release_type 复位 NULL（F-4，批次已移空）');

    const tl2 = await lastReleaseRemoveTimeline(issue1);
    assert.ok(tl2, '[B]timeline 已写 release_remove 行');
    assert.strictEqual(tl2.summary, '执行人移出上线批次（原因：批次整体作废）；批次已移空，通知与执行人已重置', '[B]timeline 文案含"批次已移空，通知与执行人已重置"');

    ok('[B] 执行人移单致移空（剩余=0）：200 + executor_kept=false；通知六列/执行人两列全重置+token 换新；release_type 复位 NULL（F-4）；timeline 含"批次已移空，通知与执行人已重置"');
  }

  // ═══ [A-多人]/[B-多人]（306 号 L1）真实 PUT executors [5,6] 多人在册场景 ═══
  //   上面 [A]/[B] 走的是 mkNotifiedRelease——直接 SQL INSERT 建**单人**在册行（该函数注释里明文承认这
  //   一点，走最短路径聚焦本文件当时的判据焦点，[决策 7 三修同步更正] 单人本身已是生产真实可达形态，
  //   直接 SQL 只是绕开通知/资格等无关前置步骤，非绕开人数闸）。keepExecutor/executor_kept=false 两条
  //   重置分支理论上都该对"在册的每一行"生效，而不是只对
  //   "触发这次请求的那个人"生效——单人夹具测不出"影响面是不是被悄悄收窄到只处理了 actor 自己那一行、
  //   同批其他人的行被漏掉"这类缺陷。本组改用真实 PUT executors [5,6] 建两人在册 + 真实标记双双 sent，
  //   两个 issue，链式验证 keepExecutor=true（两行都保留）与 executor_kept=false（两行都软删）两条路径
  //   下"多人"这个维度真的被覆盖到。
  {
    const relId = await mkRelease({ title: '执行人移单-多人在册' });
    const issue1 = await mkIssue('feature', '待上线', { title: '多人-成员1' });
    const issue2 = await mkIssue('feature', '待上线', { title: '多人-成员2' });
    await addIssuesTo(relId, [issue1, issue2]);
    const rPut = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rPut.status, 200, `[A-多人-fixture] PUT executors 期望 200, got ${rPut.status} ${JSON.stringify(rPut.body)}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
    const before5 = await execRow(relId, 5);
    const before6 = await execRow(relId, 6);
    assert.ok(before5 && before6, '[A-多人-前置] 5 号/6 号均在册且均 sent（真实 PUT executors 构造，非单人 SQL 直插）');

    // [A-多人] 5 号（执行人身份）先移单 issue2，剩余 issue1>0 → keepExecutor=true → 两人的行都应原样保留
    const rA = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue2], reason: '多人在册-部分移单' });
    assert.strictEqual(rA.status, 200, `[A-多人] 执行人移单期望 200, got ${rA.status} ${JSON.stringify(rA.body)}`);
    assert.strictEqual(rA.body.remaining_count, 1, '[A-多人] remaining_count=1');
    assert.strictEqual(rA.body.executor_kept, true, '[A-多人] executor_kept=true（剩余>0，保留身份）');
    const afterA5 = await execRow(relId, 5);
    const afterA6 = await execRow(relId, 6);
    assert.strictEqual(afterA5.id, before5.id, '[A-多人] 5 号（actor 本人）行 id 未变');
    assert.strictEqual(afterA5.notify_status, 'sent', '[A-多人] 5 号（actor 本人）notify_status 未被重置');
    assert.strictEqual(afterA6.id, before6.id, '[A-多人] ⭐ 6 号（同批次非 actor 的另一执行人）行 id 同样未变——keepExecutor 保留的是"整批在册行"而非"只保留 actor 自己那一行"');
    assert.strictEqual(afterA6.notify_status, 'sent', '[A-多人] ⭐ 6 号 notify_status 同样未被重置，仍 sent');
    ok('[A-多人] 真实 PUT executors 建两人在册后执行人移单（剩余>0）：200 + executor_kept=true，5 号(actor)与 6 号(同批另一人)两行 id/notify_status 均原样保留——坐实 keepExecutor 影响面是"整批"不是"只护住 actor 自己"');

    // [B-多人] 5 号紧接着移出最后一单 issue1，剩余=0 → executor_kept=false → 两人的行都应被软删
    const rB = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev5Tok, { issue_ids: [issue1], reason: '多人在册-移空' });
    assert.strictEqual(rB.status, 200, `[B-多人] 执行人移空期望 200, got ${rB.status} ${JSON.stringify(rB.body)}`);
    assert.strictEqual(rB.body.remaining_count, 0, '[B-多人] remaining_count=0');
    assert.strictEqual(rB.body.executor_kept, false, '[B-多人] executor_kept=false（移空，全重置）');
    const afterB5 = await execRow(relId, 5);
    const afterB6 = await execRow(relId, 6);
    assert.strictEqual(afterB5, undefined, '[B-多人] 5 号（actor 本人）行已软删（在册查询查无此行）');
    assert.strictEqual(afterB6, undefined, '[B-多人] ⭐ 6 号（同批次非 actor 的另一执行人）行同样已软删——坐实"移空全重置"影响面是"整批全部软删"，不是只处理了触发这次请求的那一个人');
    const allRowsB = await all(`SELECT user_id, removed_at FROM sys_release_executors WHERE release_id=?`, [relId]);
    assert.strictEqual(allRowsB.length, 2, '[B-多人] 物理行仍是 2 行（软删非物理删除）');
    assert.ok(allRowsB.every(r => r.removed_at), '[B-多人] 两行物理上均已带 removed_at（全体软删，非部分）');
    ok('[B-多人] 真实 PUT executors 建两人在册后执行人移单致移空（剩余=0）：200 + executor_kept=false，5 号(actor)与 6 号(同批另一人)两行均被软删（物理行仍在，仅 removed_at 落）——坐实"移空全重置"是整批多行操作，不是只重置 actor 自己那一行留下同批其他人的行悬空未处理');
  }

  // ═══ [A2] M3：移单后（剩余>0，保留身份）当场继续执行 ═══
  //   独立造一批新夹具（相邻 [A]/[B] 已在同一 relId 上把批次移空发布不出——本组验证的正是"没被移空
  //   前的中间态"，故不能复用其已耗尽的 relId），用 dev6（未在上方 [A]/[B] 出现过）避免与其余组交叉。
  {
    const { relId, issueIds } = await mkNotifiedRelease(6, '开发乙', ['A2-成员1', 'A2-成员2']);
    const [keepIssue, removeIssue] = issueIds;
    // C4a（方案 §4.4 改造 7）夹具改法：mkNotifiedRelease 已在子表插入 6 号(sent)——这里直接再插 5 号
    // (sent) 凑出本组要测的"移除后仍剩 1 人在册（保留身份）"这一目标场景（与决策 7 三修后的系统性
    // 下限 ≥1 无关，纯粹是本用例自身"移除前 2 人→移除 1 人→剩 1 人"叙事需要 2 人起步），
    // **不走 PUT executors**：生命周期闸①（§4.4 改造 1）要求全部在册
    // 行均 not_sent/pending 才可写，6 号此刻已是 sent，PUT executors 会被 409 EXECUTORS_LOCKED 拒绝——
    // 这恰恰是新设计的真实约束（一旦有人被通知，追加执行人只能先 cancel-schedule 整体作废重排），故本
    // 夹具改为直接 SQL 构造"两人都已通知"这一目标状态，不绕业务规则、只是不经过会被规则拦下的入口。
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 1, '管理员')`,
      [relId]
    );

    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev6Tok, { issue_ids: [removeIssue], reason: '不该随本批发布' });
    assert.strictEqual(rRemove.status, 200, `[A2]前置移单期望 200, got ${rRemove.status} ${JSON.stringify(rRemove.body)}`);
    assert.strictEqual(rRemove.body.executor_kept, true, '[A2]前置：executor_kept=true（剩余>0，保留身份）');

    // RELEASE 中心守卫要求在册成员≥1 且全员完成态——移单**之后**才补，证明"移单保留身份"与"发布前置
    // 条件"互不干扰（不是移单前就已经满足发布条件，是移单后才补齐，再真实走 execute）。
    await mkCompleteRoster(keepIssue, 6, '开发乙');
    const execRowsA2 = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
    // C4a（方案 §4.4 改造 7）：keepExecutor 保留**全体**在册行（含各自 exec_status），不只 actor 一人——
    // 移单前 2 行、移单（keepExecutor=true）后仍应是 2 行，5 号（非本次移单操作者）未被牵连软删。
    assert.strictEqual(execRowsA2.length, 2, '[A2]keepExecutor 保留全体在册行：移单后子表在册仍是 2 行（6/5 均在，不只 actor 一人）');
    const rowIdOf6A2 = execRowsA2.find(r => r.user_id === 6).id;
    const rowIdOf5A2 = execRowsA2.find(r => r.user_id === 5).id;
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 5 号真成功且未提前触发发布。
    const rA2Pre5 = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { executor_row_id: rowIdOf5A2 });
    assert.strictEqual(rA2Pre5.status, 200, `[A2-pre]5号预确认期望 200, got ${rA2Pre5.status} ${JSON.stringify(rA2Pre5.body)}`);
    assert.strictEqual(rA2Pre5.body.released, false, '[A2-pre]5号预确认不该提前触发发布');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: '移单后当场继续执行', executor_row_id: rowIdOf6A2 });
    assert.strictEqual(rExec.status, 200, `[A2]移单后继续执行期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(rExec.body.count, 1, '[A2]发布成功 1 单（仅剩余成员）');
    assert.strictEqual(rExec.body.released, true, '[A2]released=true（布尔，C3 新契约）');
    assert.deepStrictEqual(rExec.body.released_issue_ids, [keepIssue], '[A2]发布名单恰为剩余成员，不含被移除单');

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
    const before = await execRow(relId, 6);
    const tlCountBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev6Tok, { issue_ids: [issue1] });
    assert.strictEqual(r.status, 400, `[C]无 reason 期望 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'REMOVE_REASON_REQUIRED', '[C]确切码 REMOVE_REASON_REQUIRED');

    const row = await issueRow(issue1);
    assert.strictEqual(row.release_id, relId, '[C]无副作用：release_id 未被清（校验先于任何写操作）');
    // [C4b 退场] 零副作用改验子表：6 号在册行未被软删/notify_status/exec_status 均未变。
    const after = await execRow(relId, 6);
    assert.strictEqual(after.id, before.id, '[C]无副作用：子表 6 号行未被软删（id 不变）');
    assert.strictEqual(after.notify_status, before.notify_status, '[C]无副作用：子表 6 号行通知状态未变');
    assert.strictEqual(after.exec_status, before.exec_status, '[C]无副作用：子表 6 号行 exec_status 未变');
    const tlCountAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;
    assert.strictEqual(tlCountAfter, tlCountBefore, '[C]无副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[C] 执行人无 reason：400 REMOVE_REASON_REQUIRED，且零副作用（release_id/子表在册行/通知态/timeline 全不变）');
  }

  // ═══ [D] 非执行人 403 / 通知态非 sent 409（C4a 起守卫顺序：在册身份先于通知态，见文件头注释）═══
  {
    // D-1：非执行人（dev5 不是本批执行人 dev6）→ 403 EXECUTOR_GUARD_FAILED
    const { relId: relD1, issueIds: idsD1 } = await mkNotifiedRelease(6, '开发乙', ['D1-成员1']);
    const beforeD1 = await execRow(relD1, 6);
    const tlCountBeforeD1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD1[0]])).c;
    const rOther = await call('POST', `/api/sys-releases/${relD1}/remove-issues`, dev5Tok, { issue_ids: [idsD1[0]], reason: '我以为我能移' });
    assert.strictEqual(rOther.status, 403, `[D1]非执行人期望 403, got ${rOther.status}`);
    assert.strictEqual(rOther.body.code, 'EXECUTOR_GUARD_FAILED', '[D1]确切码 EXECUTOR_GUARD_FAILED');
    // [C4b 退场] 零副作用改验子表：真正的本批执行人（6 号）行不受这次被拒请求影响。
    const afterD1 = await execRow(relD1, 6);
    assert.strictEqual(afterD1.id, beforeD1.id, '[D1]零副作用：子表 6 号行未被软删（id 不变）');
    assert.strictEqual(afterD1.notify_status, beforeD1.notify_status, '[D1]零副作用：子表 6 号行通知状态未变');
    const rowD1 = await issueRow(idsD1[0]);
    assert.strictEqual(rowD1.release_id, relD1, '[D1]零副作用：release_id 未被清（L1 采纳）');
    const tlCountAfterD1 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD1[0]])).c;
    assert.strictEqual(tlCountAfterD1, tlCountBeforeD1, '[D1]零副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[D1] 非执行人（普通用户，非本批执行人）：403 EXECUTOR_GUARD_FAILED，且零副作用（release_id/子表在册行/timeline 全不变）');

    // D-2：通知态非 sent（人工回退到 failed，assignee 仍是本人）→ 409 EXECUTOR_REMOVE_NOT_NOTIFIED
    const { relId: relD2, issueIds: idsD2 } = await mkNotifiedRelease(6, '开发乙', ['D2-成员1']);
    await run(`UPDATE sys_releases SET release_assignee_notify_status='failed' WHERE id=?`, [relD2]);
    // C4a：入口守卫现读子表 notify_status（见 mkNotifiedRelease 注释），同步回退子表这一列，否则子表仍是
    //   'sent'，新守卫读不到这次人工构造的"通知失败"语义。failed 态 CHECK 要求 notify_error 非空，一并给。
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='人工构造失败' WHERE release_id=? AND user_id=6`, [relD2]);
    const beforeD2 = await execRow(relD2, 6);
    const tlCountBeforeD2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD2[0]])).c;
    const rNotSent = await call('POST', `/api/sys-releases/${relD2}/remove-issues`, dev6Tok, { issue_ids: [idsD2[0]], reason: '通知都失败了还想移' });
    assert.strictEqual(rNotSent.status, 409, `[D2]通知态非 sent 期望 409, got ${rNotSent.status}`);
    assert.strictEqual(rNotSent.body.code, 'EXECUTOR_REMOVE_NOT_NOTIFIED', '[D2]确切码 EXECUTOR_REMOVE_NOT_NOTIFIED');
    // [C4b 退场] 零副作用改验子表：6 号行仍是人工构造的 failed 态，未被动过。
    const afterD2 = await execRow(relD2, 6);
    assert.strictEqual(afterD2.id, beforeD2.id, '[D2]零副作用：子表 6 号行未被软删（id 不变）');
    assert.strictEqual(afterD2.notify_status, beforeD2.notify_status, '[D2]零副作用：子表 6 号行通知状态未变（仍是人工构造的 failed）');
    const rowD2 = await issueRow(idsD2[0]);
    assert.strictEqual(rowD2.release_id, relD2, '[D2]零副作用：release_id 未被清（L1 采纳）');
    const tlCountAfterD2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [idsD2[0]])).c;
    assert.strictEqual(tlCountAfterD2, tlCountBeforeD2, '[D2]零副作用：timeline 无新增 release_remove 行（L1 采纳）');
    ok('[D2] 通知态非 sent（人工回退 failed，assignee 仍是本人）：409 EXECUTOR_REMOVE_NOT_NOTIFIED，且零副作用（本例 actor 本就在册，判序先后不影响本例结果，真正打靶判序的是下方 [D4]）');

    // D-4（Opus 预筛 MED-4）：actor 不在册 ∧ 批次通知态非 sent——真正区分新旧判序的组合。旧判序先看
    //   "这一行/这个批次的通知态"再看身份，会对一个根本不是本批执行人的人也给 409 EXECUTOR_REMOVE_
    //   NOT_NOTIFIED（语义误导："你还没被通知"暗示你本该被通知，但你压根不是执行人）；新判序（C4a）
    //   先查子表在册身份，查无此行直接 403 EXECUTOR_GUARD_FAILED——如实说"你不是本批执行人"。
    await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (20,'dev20','开发戊','user','active')`);
    const relD4 = await mkRelease({ title: 'D4-判序打靶' });
    const issueD4 = await mkIssue('feature', '待上线', { title: 'D4-成员1' });
    await addIssuesTo(relD4, [issueD4]);
    const putD4 = await call('PUT', `/api/sys-releases/${relD4}/executors`, adminTok, { user_ids: [6, 20] });
    assert.strictEqual(putD4.status, 200, `[D4-fixture] PUT executors 期望 200, got ${putD4.status} ${JSON.stringify(putD4.body)}`);
    // 6/20 两人在册，notify_status 均为 DDL 默认 not_sent（从未调用 notify-executor/行级通知端点）——
    // dev5 完全不在这批执行人之列，批次通知态也确实非 sent，两个 409 触发条件的"表面理由"同时具备。
    const rD4 = await call('POST', `/api/sys-releases/${relD4}/remove-issues`, dev5Tok, { issue_ids: [issueD4], reason: '我以为我能移' });
    assert.strictEqual(rD4.status, 403, `[D4]不在册+通知态非 sent 期望 403（旧判序会给 409，真打靶）, got ${rD4.status} ${JSON.stringify(rD4.body)}`);
    assert.strictEqual(rD4.body.code, 'EXECUTOR_GUARD_FAILED', `[D4]确切码 EXECUTOR_GUARD_FAILED（新判序：在册身份先于通知态），实际 ${rD4.body.code}`);
    const execRowsD4After = await all(`SELECT user_id, notify_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relD4]);
    assert.strictEqual(execRowsD4After.length, 2, '[D4]零副作用：在册仍是 6/20 两行');
    assert.ok(execRowsD4After.every(r => r.notify_status === 'not_sent'), '[D4]零副作用：两行 notify_status 仍是 not_sent（未被动过）');
    ok('[D4] 判序打靶：actor 不在册 ∧ 批次通知态非 sent（两个 409 触发条件同时具备）→ 403 EXECUTOR_GUARD_FAILED（新判序：在册身份先于通知态；旧判序会先看通知态给出语义误导的 409），且零副作用');
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

    const before = await execRow(relId, 9);
    const tlCountBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;

    const r = await call('POST', `/api/sys-releases/${relId}/remove-issues`, dev9Tok, { issue_ids: [issue1], reason: '我要移单但已经离职' });
    assert.strictEqual(r.status, 403, `[D3]资格失效期望 403, got ${r.status}`);
    assert.strictEqual(r.body.code, 'EXECUTOR_NOT_ELIGIBLE', '[D3]确切码 EXECUTOR_NOT_ELIGIBLE');

    // [C4b 退场] 零副作用改验子表：9 号在册行未被软删/通知态未变。
    const after = await execRow(relId, 9);
    assert.strictEqual(after.id, before.id, '[D3]零副作用：子表 9 号行未被软删（id 不变）');
    assert.strictEqual(after.notify_status, before.notify_status, '[D3]零副作用：子表 9 号行通知状态未变');
    const row = await issueRow(issue1);
    assert.strictEqual(row.release_id, relId, '[D3]零副作用：release_id 未被清');
    const tlCountAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue1])).c;
    assert.strictEqual(tlCountAfter, tlCountBefore, '[D3]零副作用：timeline 无新增 release_remove 行');

    await run(`UPDATE users SET status='active' WHERE id=9`);   // 复原，避免污染后续用例
    ok('[D3] 执行人资格失效（离职，M5）：403 EXECUTOR_NOT_ELIGIBLE，且零副作用（release_id/子表在册行/timeline 全部不变）');
  }

  // ═══ [E] admin 回归：无 reason 现行语义不变；带 reason timeline 含原因 ═══
  {
    const { relId, issueIds } = await mkNotifiedRelease(5, '开发甲', ['E-成员1', 'E-成员2']);
    const [issue1, issue2] = issueIds;

    // 无 reason：现行完整重置语义不变（回归）——即使剩余>0，admin 分支恒不传 keepExecutor。
    const r1 = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue2] });
    assert.strictEqual(r1.status, 200, `[E1]admin 无 reason 期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.remaining_count, 1, '[E1]remaining_count=1（issue1 仍在册）');
    assert.strictEqual(r1.body.executor_kept, false, '[E1]executor_kept=false（admin 分支恒全重置，不受剩余数影响）');
    // [C4b 退场] "全重置"的真实信号已迁到子表——admin 分支恒不传 keepExecutor，差量非空触发子表软删全员。
    const execAfterR1 = await execRow(relId, 5);
    assert.strictEqual(execAfterR1, undefined, '[E1]admin 无 reason 移单仍触发子表软删全员（回归，5 号行不再在册）');
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
    // [C4b 退场] 原此处先调批次级 notify-executor 铺垫旧列——该路由已删除，remove-issues 的执行人身份
    // 判据早已完全改子表（见 [D] 组注释），下方 PUT executors + markSent 已是构造前置态的完整手段，
    // 不需要额外调用。[决策 7 三修同步更正] R-GATE 本身现只需在册人数≥1；本组仍选 2 人（PUT executors
    // [5,6] + markSent + 6 先确认、5 最后确认真翻牌）纯粹是沿用既有夹具形态，非该系统性下限所要求
    // （301-M3 过渡夹具兑现）。
    const rSetExecF = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rSetExecF.status, 200, `[F]夹具 PUT executors 期望 200, got ${rSetExecF.status} ${JSON.stringify(rSetExecF.body)}`);
    const execRowsF = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
    const rowIdOf5F = execRowsF.find(r => r.user_id === 5).id;
    const rowIdOf6F = execRowsF.find(r => r.user_id === 6).id;
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 6 号真成功且未提前触发发布。
    const rFPre6 = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { executor_row_id: rowIdOf6F });
    assert.strictEqual(rFPre6.status, 200, `[F-pre]6号预确认期望 200, got ${rFPre6.status} ${JSON.stringify(rFPre6.body)}`);
    assert.strictEqual(rFPre6.body.released, false, '[F-pre]6号预确认不该提前触发发布');
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: '执行人移单回归-发布', executor_row_id: rowIdOf5F });
    assert.strictEqual(rExec.status, 200, `[F]前置 execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);

    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issueId] });
    assert.strictEqual(rRemove.status, 409, `[F]已发布批次移单（admin 身份）期望 409, got ${rRemove.status}`);
    assert.strictEqual(rRemove.body.code, 'RELEASE_NOT_PLANNING', '[F]admin 身份确切码 RELEASE_NOT_PLANNING（回归）');

    // L1 采纳：已发布单保留执行人=本人（审计对称，见 GET /sys-releases/:id 权限注释）——dev5 此刻仍是
    // 子表在册行（execute 不软删/不清子表，只翻 exec_status）且 notify_status 仍是 sent，用"原执行人
    // 身份"再发一次请求，证明批次状态守卫（rel.status!=='计划中'）先于角色分支判定，两分支（admin/
    // 执行人）共用同一道前置闸，不是"admin 单独测过 409、执行人分支从未真正被这道闸拦过"。
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
    // C4a（方案 §4.4 #8）：GET /sys-releases 的 mine 过滤已改子表 EXISTS——下方 [G] 断言"dev5 是本批执行人，
    //   mine 视角应能看到该批次"依赖子表在册行，旧列（上方 INSERT 里的 release_assignee_id=5）不再驱动可见性。
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 1, '管理员')`,
      [relId]
    );
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
