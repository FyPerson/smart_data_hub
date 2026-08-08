// scripts/verify-sys-multidev-snapshots.js — C6 验收：发布快照本体 + 去 version_tag 必填 + 只读快照端点
//   SSOT = 方案 v2.9 §8「发布与快照」（快照基数/插入语义/changes 读取纪律 Lz-1/零 commit Mz-5）+
//   §10 API 契约（GET .../releases/:id/commit-snapshots）+ 联合 SSOT §13 验收表 S21/S25/S26/S37。
//   用法：node scripts/verify-sys-multidev-snapshots.js
//
// 覆盖：
//   S21：发布无 version_tag 允许（+批次 version_tag 落 NULL）；首次产快照（字段=版本1固定七字段，commit_id 升序）；
//        全员 no_code 零 commit 首发 changes=1 且快照恰为 []（Mz-5）；ON CONFLICT 幂等（直调
//        snapshotReleaseCommitsInTxn 两次同 pair）；changes=0 已冻结继续（预插同 (release_id,issue_id) 行后
//        发布仍成功，不重复插不覆盖，Lz-1）。
//        ⚠️ C3（上线体统一重构）改造：legacy /sys-releases/:id/publish 与旧 execute-release 全类型 409 退场，
//        发布唯一入口收窄为 /sys-releases/:id/execute（中心守卫）；原"S21b execute-release mode=hotfix
//        不产快照"子用例随之整条退场（新统一入口下发布必经 _publishReleaseCoreInTxn，无"绕过共用内核"
//        路径可测），S21b 现测 bug 类型经统一入口（hotfix-publish 建单+execute 发布）仍正确产快照 v2。
//   S25：提交→remove→re-add→编辑旧实例行→(accept)→发布：快照含更正后行
//   S26：提交→remove→不 re-add→(accept)→发布：快照含 removed 实例行
//   S37：accept/resume 进待上线不产快照
//   GET /sys-releases/:id/commit-snapshots：200 内容正确 / 非 admin 403 / 批次不存在 404 / 零快照 200+[]
//
// 治具风格同 verify-sys-multidev-commits.js（direct SQL 种子 roster/commit 状态，聚焦本 commit 范围——
// 发布快照内容正确性，不重复造轮子测 submit/remove/re-add 本身，那些已由其余 verify-sys-multidev-*.js 覆盖）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-multidev-snapshots-secret';
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
// codex 221a HIGH 收口（验证层残余日期字面量·全文扫描收尾）：dev_estimated_at 默认值原硬编码
// '2026-07-01 10:00:00'，本文件是直连 SQL 造数（不经 /estimate 端点闸门，当前潜伏未触发
// ESTIMATE_BEFORE_ASSIGN），但远期字面量迟早到期，同 P4/221a 范式统一改动态生成，不留隐患。
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 治具：同 verify-sys-multidev-commits.js 范式（direct SQL 种子）──────────
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
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
}
const issueRow = (id) => get('SELECT status, release_id, released_at FROM sys_issues WHERE id=?', [id]);
const relRow = (id) => get('SELECT status, version_tag, release_note FROM sys_releases WHERE id=?', [id]);
const snapshotRows = (relId) => all('SELECT id, release_id, issue_id, snapshot_json, created_at FROM sys_issue_release_commit_snapshots WHERE release_id=? ORDER BY issue_id ASC', [relId]);
const snapshotRow = (relId, issueId) => get('SELECT id, release_id, issue_id, snapshot_json, created_at FROM sys_issue_release_commit_snapshots WHERE release_id=? AND issue_id=?', [relId, issueId]);

async function mkReleaseWithIssues(issueIds, extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, { title: extra.title || 'snap-batch' });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const relId = r.body.id;
  const r2 = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: issueIds });
  assert.strictEqual(r2.status, 200, `加单 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
  return relId;
}
// C3（方案 §4.3 全文）：publish 唯一合法入口收窄为 /sys-releases/:id/execute，语义整体切换为「确认我
//   这一份」+ R-GATE（多人各自确认、在册人数≥1 ∧ 全员 done 才真正翻已发布，决策 7 三修下限 2→1）。
//   本文件关注的是
//   _publishReleaseCoreInTxn 内核本身的快照写入行为（S21/S25/S26/S37/Lz-1），不关心"怎么走到可执行态"
//   这段——**301-M3 过渡夹具标注兑现**（同款改法见 verify-sys-release.js 的 publishRelease 定义处
//   完整论述，此处不重复）。**通用化处理两种起点**：① 批次尚无在册执行人（helper 自建 executorId+
//   固定"影子搭档" SHADOW_EXECUTOR_ID 两人）② 批次已有在册执行人（如 S21b 经 hotfix-publish 建单，
//   本身已带 2 人）——两种情形统一走：把所有 not_sent 的在册行置 sent → 除 executorId 外逐个确认
//   （已 done 的跳过）→ executorId 最后确认，触发 R-GATE 真正发布。外部契约不变，调用方仍只传
//   relId+body（+可选 executorId）。
const SHADOW_EXECUTOR_ID = 999901;
async function publishRelease(relId, body, executorId = 5, executorName = '开发甲') {
  let rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  if (rows.length === 0) {
    await run(`INSERT OR IGNORE INTO users (id, username, display_name, role, status) VALUES (?, 'shadow-partner', '影子搭档', 'user', 'active')`, [SHADOW_EXECUTOR_ID]);
    const rSet = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [executorId, SHADOW_EXECUTOR_ID] });
    if (rSet.status !== 200) return rSet;
    rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  }
  const myRow = rows.find(r => r.user_id === executorId);
  if (!myRow) throw new Error(`publishRelease helper: executorId=${executorId} 不在 release ${relId} 的在册执行人子表中`);
  // 确保全部在册行 notify_status='sent'——不论是本 helper 刚建的，还是调用方经别的路径（如
  // hotfix-publish）已建好的 not_sent/pending 行。CHECK 要求 notified_at 同步非空。
  const notSentIds = rows.filter(r => r.notify_status !== 'sent').map(r => r.id);
  if (notSentIds.length > 0) {
    const ph = notSentIds.map(() => '?').join(',');
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id IN (${ph})`, notSentIds);
  }
  // 除 executorId 外逐个先确认（已 done 的跳过——幂等感知，同一 relId 可能被多次调用）。
  for (const r of rows) {
    if (r.user_id === executorId || r.exec_status === 'done') continue;
    // 303-M2（Opus 对抗审）：中间预确认不许静默吞——断言真成功且未提前触发发布（executorId 自己那行
    //   仍 pending，R-GATE 不可能在这里被满足，released 恒 false），失败带上下文抛错方便定位。
    const rPre = await call('POST', `/api/sys-releases/${relId}/execute`, devTok(r.user_id), { executor_row_id: r.id });
    if (rPre.status !== 200 || rPre.body.released !== false) {
      throw new Error(`publishRelease helper: 预确认异常，relId=${relId} user_id=${r.user_id} row=${r.id} status=${rPre.status} body=${JSON.stringify(rPre.body)}`);
    }
  }
  return call('POST', `/api/sys-releases/${relId}/execute`, devTok(executorId), { ...body, executor_row_id: myRow.id });
}

async function main() {
  mod.initSchema();
  await waitReady();
  // status 列：C3 后端批 publishRelease() 改走 /execute，其中心守卫要走 hasReleaseEligibility(userId)
  //   （SELECT status, role FROM users），补列（DEFAULT 'active'，本文件所有夹具用户天然在职有资格）；
  //   S21b 的 hotfix-publish 执行人闸门②③（C2b 起）同样消费本函数。
  // phone/dingtalk_user_id 列：⭐ MED-1（Opus 预筛）注释写实——原注释描述的路径（S21b 走 hotfix-publish
  //   preempt 成功 → sendReleaseNotifyAndWriteback）已随 C2b 作废：hotfix-publish 自 C2b 起不再复用该
  //   服务（去自动定人，改走独立闸门+子表写入，见 index.js 路由头部注释），本文件也无其它路径真调
  //   sendReleaseNotifyAndWriteback。L1 订正：该函数本体现已随 C4b H1 退场从生产代码整体删除，"本文件
  //   无路径真调"这句话依然成立且更彻底（全项目已无处可调，不只是本文件绕开）。两列现已是历史遗留
  //   （无消费方），继续保留 CREATE TABLE 原样未做清理（不在本次改造范围）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),(5,'dev5','开发甲','user','active'),(6,'dev6','开发乙','user','active'),(8,'dev8','开发戊','user','active')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // S21a：发布无 version_tag 允许（批次 version_tag 落 NULL）；publish 首次产快照，字段=版本1固定七字段，commit_id 升序
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const c1 = await seedCommit(id, daId, 5, 'backend', 'fix/s21-a-1');
    const c2 = await seedCommit(id, daId, 5, 'frontend', 'fix/s21-a-2');
    const relId = await mkReleaseWithIssues([id]);
    const r = await publishRelease(relId, { release_note: 'S21-a 无版本号发布' });   // 不传 version_tag
    assert.strictEqual(r.status, 200, `S21a：无 version_tag 发布应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rel = await relRow(relId);
    assert.strictEqual(rel.version_tag, null, 'S21a：批次 version_tag 落库 NULL（未传值场景，去必填生效）');
    const snap = await snapshotRow(relId, id);
    assert.ok(snap, 'S21a：快照行已产生');
    // ⭐ C2a snapshot v2（方案 §6.6a）：snapshot_json 现为对象 {schema_version:2,type,title_snapshot,status_at_publish,commits}
    const parsed = JSON.parse(snap.snapshot_json);
    assert.strictEqual(parsed.schema_version, 2, 'S21a：snapshot v2 schema_version=2');
    assert.strictEqual(parsed.type, 'feature', 'S21a：v2 type=发布时类型');
    assert.strictEqual(parsed.title_snapshot, 'feature-待上线-单', 'S21a：v2 title_snapshot=发布时标题（mkIssue 默认标题）');
    assert.strictEqual(parsed.status_at_publish, '已上线', 'S21a：v2 status_at_publish=已上线（本函数只在批量翻牌成功后调用）');
    const commits = parsed.commits;
    assert.strictEqual(commits.length, 2, 'S21a：快照含 2 条 commit');
    assert.deepStrictEqual(commits.map(c => c.commit_id), [c1, c2], 'S21a：commit_id 升序');
    const keys = Object.keys(commits[0]).sort();
    assert.deepStrictEqual(keys, ['commit_id', 'commit_ref', 'component', 'created_at', 'dev_assignee_id', 'dev_user_id', 'updated_at'], 'S21a：commits[] 内每条仍是版本1固定七字段（v2 只是外层多包一层元数据，commit 明细字段不变）');
    assert.strictEqual(commits[0].dev_assignee_id, daId, 'S21a：dev_assignee_id 正确');
    assert.strictEqual(commits[0].dev_user_id, 5, 'S21a：dev_user_id 正确');
    await selfCertifyProbes('S21a');
    ok('S21a：发布无 version_tag 允许（200+批次 version_tag NULL）；首次产快照 v2（schema_version=2+type+title_snapshot+status_at_publish），commits[] 字段=版本1固定七字段，commit_id 升序');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S21·Mz-5：全员 no_code 零 commit 首发：changes=1 且快照恰为 []（禁 NULL/聚合误产）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    await mkMember(id, 5, '开发甲', 'no_code');   // 无 commit 行
    const relId = await mkReleaseWithIssues([id]);
    const r = await publishRelease(relId, { release_note: 'S21-Mz5 零commit发布' });
    assert.strictEqual(r.status, 200, `Mz-5：发布应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 1, 'Mz-5：changes=1（单单批次翻已上线）');
    const snap = await snapshotRow(relId, id);
    assert.ok(snap, 'Mz-5：零 commit 也产生快照行（非跳过）');
    // ⭐ C2a snapshot v2：零 commit 场景验证 commits 字段恰为 []（非 null/非全 NULL 聚合对象），外层元数据仍完整。
    const parsed = JSON.parse(snap.snapshot_json);
    assert.strictEqual(parsed.schema_version, 2, 'Mz-5：v2 schema_version=2（零 commit 不影响外层元数据）');
    assert.strictEqual(parsed.type, 'feature', 'Mz-5：v2 type 正确');
    assert.strictEqual(parsed.status_at_publish, '已上线', 'Mz-5：v2 status_at_publish=已上线');
    assert.deepStrictEqual(parsed.commits, [], 'Mz-5：commits 恰为合法空数组 []（非 null/非全 NULL 聚合对象）');
    ok('S21·Mz-5：全员 no_code 零 commit 首发：changes=1 且 snapshot v2 的 commits 恰为 []（JS 层拼数组，非 SQL 聚合，防 LEFT JOIN 误产），外层元数据仍完整');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S21b（C3 改造）：bug 首次产快照 v2——全类型统一后 bug 走与 feature/improvement 相同的
  //   /sys-releases/:id/execute 唯一发布入口（不再是 legacy execute-release 的双模式）。
  //   ⚠️ 原"mode=hotfix 不产快照（release_id 恒 NULL，不经共用内核）"这条子用例随 execute-release 一并
  //   退场——新统一入口下 bug 发布必经 _publishReleaseCoreInTxn（该函数是快照写入的唯一交汇点，见其函数头
  //   注释），"绕过共用内核不产快照"这条旁路已不存在，无对应场景可测，故不做保留式改写、直接删除。
  {
    const id = await mkIssue('bug', '待上线');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const cId = await seedCommit(id, daId, 5, 'backend', 'fix/publish-mode-1');
    // [2026-07-29 双闸拆除后更正] bug 现同样可走 add-issues 进普通批次（见 verify-sys-bug-transitions.js
    //   [R5①放行]）——本用例仍选用 hotfix-publish 建批次，纯粹因为它是"单条应急、一步建单+加单+抢占"
    //   的最短路径，与本用例验证目标（发布快照写入）无关，非因 add-issues 对 bug 仍有闸门。
    // [C3 裁定修正 2026-07-29] 抢占失败（当日无在册值班人）现回滚+409——本用例验证目标是快照写入，
    //   非抢占分支，先补今日排班让 hotfix-publish 走通①全链（幂等：本文件仅这一处调用，不会重复 INSERT）。
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (date('now','localtime'), 5, '开发甲', 1, '管理员')`);
    const rHf = await call('POST', `/api/sys-issues/${id}/hotfix-publish`, adminTok, { release_note: 'bug批次发布', executors: [5, 6] });
    assert.strictEqual(rHf.status, 200, `S21b：bug hotfix-publish 建单应 200, got ${rHf.status} ${JSON.stringify(rHf.body)}`);
    const relId = rHf.body.release_id;
    assert.ok(relId, 'S21b：hotfix-publish 建单后 release_id 非空');
    const r = await publishRelease(relId, { release_note: 'bug批次发布' });
    assert.strictEqual(r.status, 200, `S21b：bug execute 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const snap = await snapshotRow(relId, id);
    assert.ok(snap, 'S21b：execute 快照行产生');
    const parsed = JSON.parse(snap.snapshot_json);
    assert.strictEqual(parsed.schema_version, 2, 'S21b：v2 schema_version=2');
    assert.strictEqual(parsed.type, 'bug', 'S21b：v2 type=bug');
    const commits = parsed.commits;
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].commit_id, cId, 'S21b：快照内容正确');
    await selfCertifyProbes('S21b');
    ok('S21b：bug 经统一 /execute 入口首次产快照 v2（复用共用内核，快照内容正确，全类型统一后 bug/变更流同一条路径）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [Lz-1] ON CONFLICT(release_id,issue_id) DO NOTHING 幂等：直调 snapshotReleaseCommitsInTxn 两次同 pair
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted', { skipCommit: true });
    await seedCommit(id, daId, 5, 'backend', 'fix/idem-1');
    const rRel = await call('POST', '/api/sys-releases', adminTok, { title: 'idem-batch' });
    const relId = rRel.body.id;
    // ⭐ C2a：snapshotReleaseCommitsInTxn 签名从 (releaseId, issueId) 改为 (releaseId, issue={id,type,title})——
    //   直调需按新签名传入 issue 元数据（供 v2 payload 的 type/title_snapshot 使用）。
    const issueForSnap = await get('SELECT id, type, title FROM sys_issues WHERE id=?', [id]);

    await run('BEGIN IMMEDIATE');
    await I.snapshotReleaseCommitsInTxn(relId, issueForSnap);
    await run('COMMIT');
    const rows1 = await snapshotRows(relId);
    assert.strictEqual(rows1.length, 1, '首次调用产生 1 行快照');

    await run('BEGIN IMMEDIATE');
    await I.snapshotReleaseCommitsInTxn(relId, issueForSnap);   // 二次调用同 pair：ON CONFLICT DO NOTHING，changes=0 且 SELECT 命中已存在行
    await run('COMMIT');
    const rows2 = await snapshotRows(relId);
    assert.strictEqual(rows2.length, 1, '[Lz-1] 二次调用不产生新行（ON CONFLICT 幂等）');
    assert.strictEqual(rows2[0].id, rows1[0].id, '[Lz-1] 仍是同一行（id 不变，未被覆盖/重插）');
    ok('[Lz-1] ON CONFLICT(release_id,issue_id) DO NOTHING 幂等：直调 snapshotReleaseCommitsInTxn 两次同 pair，仅产生 1 行且不抛错');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [Lz-1] changes=0 分支：预插同 (release_id,issue_id) 行后发布 → 视为已冻结继续（不重复插不覆盖）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted', { skipCommit: true });
    await seedCommit(id, daId, 5, 'backend', 'fix/frozen-real');
    const relId = await mkReleaseWithIssues([id]);
    // 预插同 (release_id, issue_id) 决胜行（模拟"已冻结"态；内容故意与真实 commit 不同，验证不被覆盖）
    await run(
      `INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at) VALUES (?, ?, '[]', datetime('now'))`,
      [relId, id]
    );
    const r = await publishRelease(relId, { release_note: '预插决胜行后仍应成功' });
    assert.strictEqual(r.status, 200, `changes=0 已冻结：发布应仍成功 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await snapshotRows(relId);
    assert.strictEqual(rows.length, 1, 'changes=0 已冻结：仍只 1 行（未重复插入）');
    assert.strictEqual(rows[0].snapshot_json, '[]', 'changes=0 已冻结：内容为预插值（未被真实 commit 覆盖，证明视为已冻结未重写）');
    const issueAfter = await issueRow(id);
    assert.strictEqual(issueAfter.status, '已上线', 'changes=0 已冻结：主状态仍正常置已上线（发布成功不重复插）');
    ok('[Lz-1] changes=0 分支：预插同 (release_id,issue_id) 行后发布 → 视为已冻结继续（发布成功不重复插，不覆盖预插内容）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S25：提交→remove→re-add→编辑旧实例行→(accept)→发布：快照含更正后行
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');
    const daIdOld = await mkMember(id, 5, '开发甲', 'code_submitted');   // 自动种子 commit
    const oldCommit = (await all('SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?', [daIdOld]))[0];
    await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 09:00:00' WHERE id = ?`, [daIdOld]);   // remove
    // re-add：新实例用 no_code（完成态，满足下方发布所需的"在册≥1∧无 pending"RELEASE 门；PUT 编辑不依赖
    //   当前实例 dev_status，仅需 actor 现时在册，见 §6.1 guard①——no_code 既不触发 P3 的 code_submitted
    //   commit≥1 要求，又是完成态不卡 pending 闸，是本用例唯一自洽选择）
    await mkMember(id, 5, '开发甲', 'no_code');   // re-add（新实例，当前在册）
    const r1 = await call('PUT', `/api/sys-issues/${id}/dev/commits/${oldCommit.id}`, devTok(5), { component: 'backend', commit_ref: 'fix/s25-corrected' });
    assert.strictEqual(r1.status, 200, `S25：re-add 后编辑旧实例行应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    // accept（待验证→待上线，不产快照）：本脚本聚焦发布快照内容，accept 语义本身已由其余 verify 覆盖，此处简化为直接置状态
    await run(`UPDATE sys_issues SET status = '待上线' WHERE id = ?`, [id]);
    const relId = await mkReleaseWithIssues([id]);
    const r2 = await publishRelease(relId, { release_note: 'S25 发布' });
    assert.strictEqual(r2.status, 200, `S25：发布应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const snap = await snapshotRow(relId, id);
    const commits = JSON.parse(snap.snapshot_json).commits;   // C2a snapshot v2：commits 从对象内取
    assert.strictEqual(commits.length, 1, 'S25：快照仅 1 条 commit（旧实例行，未新增）');
    assert.strictEqual(commits[0].commit_id, oldCommit.id, 'S25：快照行 commit_id=被编辑的旧实例行');
    assert.strictEqual(commits[0].commit_ref, 'fix/s25-corrected', 'S25：快照含更正后内容（非原始种子值）');
    assert.strictEqual(commits[0].dev_assignee_id, daIdOld, 'S25：dev_assignee_id 仍指向旧（被移除）实例——commit 行归属不随 re-add 迁移');
    await selfCertifyProbes('S25');
    ok('S25：提交→remove→re-add→编辑旧实例行→(accept)→发布：快照含更正后行（内容=编辑后值，行归属仍属旧实例）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S26：提交→remove→不 re-add→(accept)→发布：快照含 removed 实例行
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');
    const daId1 = await mkMember(id, 5, '开发甲', 'code_submitted');   // 自动种子 commit c1
    const c1 = (await all('SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?', [daId1]))[0].id;
    await mkMember(id, 6, '开发乙', 'code_submitted');   // 保 roster ≥1（不 re-add dev5）
    await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 09:00:00' WHERE id = ?`, [daId1]);   // remove dev5，不 re-add
    await run(`UPDATE sys_issues SET status = '待上线' WHERE id = ?`, [id]);   // accept 简化为直接置状态（同 S25 理由）
    const relId = await mkReleaseWithIssues([id]);
    const r = await publishRelease(relId, { release_note: 'S26 发布' });
    assert.strictEqual(r.status, 200, `S26：发布应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const snap = await snapshotRow(relId, id);
    const commits = JSON.parse(snap.snapshot_json).commits;   // C2a snapshot v2：commits 从对象内取
    assert.strictEqual(commits.length, 2, 'S26：快照含 2 条（dev5 removed 实例行 + dev6 在册行）');
    const removedRow = commits.find(c => c.commit_id === c1);
    assert.ok(removedRow, 'S26：快照含 removed 实例行（dev5 已移除，仍留痕）');
    assert.strictEqual(removedRow.dev_assignee_id, daId1, 'S26：removed 实例行归属仍是被移除的旧 dev_assignee_id');
    await selfCertifyProbes('S26');
    ok('S26：提交→remove→不 re-add→(accept)→发布：快照含 removed 实例行（本人不在册但历史行留痕）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S37：accept/resume 进待上线不产快照
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');
    // RC-M5：accept 进「待上线」（REQUIRES_ASSIGNEE_STATUSES 内）须有 assigned_to，同下方 resume 用例治具范式
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime'), assigned_to = 5, assigned_to_name = '开发甲' WHERE id = ?`, [id]);
    // ⭐ [C9-fix H2①] 夹具从 'no_code' 改 'code_submitted'（mkMember 会自动种一条 commit 行）——**为的是
    //   保住本组原本要测的那件事**。C9（无 commit 单验收直翻）上线后，零 commit 单 accept 会直接翻到
    //   「已上线」而不是「待上线」；本组用 no_code 建的单恰好零 commit，于是 accept 后主状态变成已上线，
    //   下面那条 `status === '待上线'` 断言直接红——但红的原因不是"快照逻辑坏了"，而是**夹具已经不再
    //   构造出本组要测的那个场景**。本组的被测语义是「accept 进待上线**这条路径**不产快照」，前提就是
    //   单据得真能走到待上线，所以正确的修法是让夹具带上 commit（走非直翻路径），而不是把断言改成已上线。
    //   ⚠️ 本处是 C9 那轮"7 套件 30 处 no_code 夹具改 commits 模式"普查的**漏网**（那轮只 grep 了
    //     `mode: 'no_code'` 这种走 submit 端点的写法，本文件用的是 mkMember 直连 SQL 写 dev_status，
    //     模式不同故未被命中）——判定标准应是"accept 时该单是否零 commit"，不是"夹具长什么样"。
    await mkMember(id, 5, '开发甲', 'code_submitted');
    assert.strictEqual((await get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [id])).c, 1,
      'S37 前置：夹具须带 1 条 active commit——否则会命中 C9 免上线直翻，accept 落「已上线」，本组测的"进待上线"路径根本没被走到（防夹具自己变假）');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `S37：accept 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.status, '待上线', 'S37：accept 后主状态=待上线');
    assert.strictEqual(row.release_id, null, 'S37：accept 后 release_id 仍 NULL');
    const cnt = await get('SELECT COUNT(*) c FROM sys_issue_release_commit_snapshots WHERE issue_id=?', [id]);
    assert.strictEqual(cnt.c, 0, 'S37：accept 进待上线不产快照');
    ok('S37：accept 进待上线不产快照（release_id 未落，快照表零残留）');
  }
  {
    const id = await mkIssue('feature', '待上线');
    // RC-M5：resume 恢复目标态若在 REQUIRES_ASSIGNEE_STATUSES 内须有 assigned_to（同 verify-sys-multidev-members.js S10l 治具范式）
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime'), assigned_to = 5, assigned_to_name = '开发甲' WHERE id = ?`, [id]);
    await mkMember(id, 5, '开发甲', 'no_code');
    let r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '短暂搁置' });
    assert.strictEqual(r.status, 200, `S37：hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S37：验证 resume 进待上线不产快照' });
    assert.strictEqual(r.status, 200, `S37：resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', 'S37：resume 恢复到待上线（roster 满足原门，不降级）');
    const cnt = await get('SELECT COUNT(*) c FROM sys_issue_release_commit_snapshots WHERE issue_id=?', [id]);
    assert.strictEqual(cnt.c, 0, 'S37：resume 进待上线不产快照');
    ok('S37：resume 进待上线不产快照（hold→resume 恢复到待上线，快照表零残留）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // GET /sys-releases/:id/commit-snapshots：200 内容正确 / 非 admin 403 / 批次不存在 404 / 零快照 200+[]
  // ══════════════════════════════════════════════════════════════════════
  {
    const idA = await mkIssue('feature', '待上线');
    const daIdA = await mkMember(idA, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const cA1 = await seedCommit(idA, daIdA, 5, 'backend', 'fix/get-1');
    const cA2 = await seedCommit(idA, daIdA, 5, 'frontend', 'fix/get-2');
    const relId = await mkReleaseWithIssues([idA]);
    const rPub = await publishRelease(relId, { release_note: 'GET端点测试批次' });
    assert.strictEqual(rPub.status, 200, `GET 前置发布应 200, got ${rPub.status} ${JSON.stringify(rPub.body)}`);

    let r = await call('GET', `/api/sys-releases/${relId}/commit-snapshots`, adminTok, null);
    assert.strictEqual(r.status, 200, `GET commit-snapshots 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.release_id, relId, 'GET：release_id 字段正确');
    assert.strictEqual(r.body.items.length, 1, 'GET：items 恰 1 条（单单批次）');
    const item = r.body.items[0];
    assert.strictEqual(item.issue_id, idA, 'GET：issue_id 正确');
    assert.strictEqual(item.commits.length, 2, 'GET：commits 数组含 2 条');
    assert.deepStrictEqual(item.commits.map(c => c.commit_id), [cA1, cA2], 'GET：commit_id 升序');
    ok('GET /sys-releases/:id/commit-snapshots：200 + 返回行数/内容正确（issue_id/commits 数组，commit_id 升序）');

    r = await call('GET', `/api/sys-releases/${relId}/commit-snapshots`, devTok(5), null);
    assert.strictEqual(r.status, 403, `GET 非 admin 应 403, got ${r.status}`);
    ok('GET /sys-releases/:id/commit-snapshots：非 admin → 403');

    r = await call('GET', `/api/sys-releases/999999/commit-snapshots`, adminTok, null);
    assert.strictEqual(r.status, 404, `GET 不存在批次应 404, got ${r.status}`);
    assert.strictEqual(r.body.code, 'RELEASE_NOT_FOUND', 'GET：错误码 RELEASE_NOT_FOUND');
    ok('GET /sys-releases/:id/commit-snapshots：批次不存在 → 404 RELEASE_NOT_FOUND');

    const relEmpty = await call('POST', '/api/sys-releases', adminTok, { title: '零快照批次' });
    r = await call('GET', `/api/sys-releases/${relEmpty.body.id}/commit-snapshots`, adminTok, null);
    assert.strictEqual(r.status, 200, `GET 零快照批次应 200, got ${r.status}`);
    assert.deepStrictEqual(r.body.items, [], 'GET：批次存在但未发布 → items 空数组（合法态非错误）');
    ok('GET /sys-releases/:id/commit-snapshots：批次存在但零快照（未发布）→ 200 + items:[]');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-snapshots 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-snapshots 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
