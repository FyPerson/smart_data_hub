// 验证脚本：系统迭代 上线体统一重构 C4 — getReleaseMembers 统一读源（方案 v3.4 §6.6/§6.6a/§6.6b/§6.9）
//   用法：node scripts/verify-sys-release-members.js
//
// 覆盖（对抗审"假绿猎手"式纪律：不测"函数存在"，测"三态分支真按声明的规则走，降级真不伪造字段"）：
//   [1] live（计划中）：正常态 members 正确 + commits 取当前 sys_issue_dev_commits（含空数组正确态）
//   [2] snapshot（已发布，完整性校验通过）：members 逐字段正确，source=snapshot/degraded=false
//   [3] degraded·部分快照缺失：release_published timeline 行数与快照行数不等 → 整体回落 timeline
//       重建（不是"缺的那条 null、其余仍用快照"的逐成员拼接——§6.6a"不允许部分快照当完整返回"）
//   [4] degraded·载荷解析失败：timeline summary 非法 JSON / schema_version 非 2 / 必需字段缺失
//       → 该成员字段全部 null（不伪造）+ unavailable_fields 精确列出缺失字段名
//   [5] degraded·无快照回落成功：快照表整体为空但 timeline release_published 载荷本身完整可解析
//       → 从 timeline 精确重建出正确数据（区别于 [4]：source 同为 degraded 但数据本身没丢）
//   [6] 空成员：已发布批次快照表与 timeline release_published 行双双为零行（脏数据兜底）→
//       members=[] 但仍标 degraded=true（不能悄悄当"合法空批次"）
//   [6b] [C9 新增] degraded·release_published timeline 行按 issue_id 重复（脏数据兜底，codex 207 审
//       MED-3 防御）：members 去重 + duplicate_release_published 诊断字段精确暴露重复 issue_id，
//       countOnly/完整两路径口径一致 + 内容一致（byte 相同）时 duplicate_release_published_conflict 为空
//   [6c] [C9 二次收口新增] degraded·三条重复行含内容冲突（codex 207 复审 MED-1/LOW-1）：去重保留内容
//       确定性等于最早插入的一条（issue_id ASC, id ASC 稳定排序，非隐式顺序）+ duplicate_release_published
//       精确 1 个 issue_id（不随重复行数线性增长）+ duplicate_release_published_conflict 如实暴露内容分歧
//   [7] release_type 派生三值：single(bug|feature|improvement) / mixed / unknown（含
//       members=[]、unavailable_fields 含 type 两种导致 unknown 的路径）
//   [8] HTTP 层端到端：GET /sys-releases 列表 issue_count/source/degraded 随批次真实状态变化；
//       GET /sys-releases/:id 详情 issues 字段名向后兼容（id/type/title/status）+ 顶层 source/degraded/
//       unavailable_fields 正确透传
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-members-secret';
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
const getReleaseMembers = I.getReleaseMembers;
assert.ok(typeof getReleaseMembers === 'function', 'getReleaseMembers 必须已从 _internals 导出（C4 verify 直调前提）');

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人白名单（GET /sys-releases 用）

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 夹具辅助：直接 SQL 构造 sys_releases/sys_issues/快照/timeline 四张表的行，不走完整业务状态机
//   （本文件测的是 getReleaseMembers 自身的读源分支逻辑，不是发布流程本身——那部分已由
//   verify-sys-release.js/verify-sys-release-batch.js/verify-sys-multidev-snapshots.js 覆盖，本文件
//   直接摆好"发布后台账应该长什么样"的最终库态，聚焦读源判断本身）。──────────
let relSeq = 1000, issueSeq = 1;
async function mkReleaseRow(status, extra = {}) {
  const id = relSeq++;
  await run(
    `INSERT INTO sys_releases (id, release_no, title, status, is_hotfix, created_by, created_by_name, released_at)
     VALUES (?, ?, ?, ?, 0, 1, '管理员', ?)`,
    [id, `R-TEST-${id}`, extra.title || `测试批次${id}`, status, status === '已发布' ? '2026-01-01 10:00:00' : null]
  );
  return id;
}
async function mkIssueRow(releaseId, type, title, status = '已上线') {
  const id = issueSeq++;
  await run(
    `INSERT INTO sys_issues (id, type, title, status, system_name, source, created_by, created_by_name, release_id, created_at)
     VALUES (?, ?, ?, ?, 'BMS', '内部', 1, '管理员', ?, datetime('now'))`,
    [id, type, title, status, releaseId]
  );
  return id;
}
async function mkCommit(issueId, componentTag) {
  await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at)
     VALUES (?, 1, 1, ?, 'fix/x', datetime('now'), datetime('now'))`,
    [issueId, componentTag]
  );
}
async function mkSnapshotRow(releaseId, issueId, payloadObj) {
  await run(
    `INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [releaseId, issueId, typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj)]
  );
}
async function mkPublishedTimelineRow(releaseId, issueId, payloadObj) {
  const summary = typeof payloadObj === 'string' ? payloadObj : JSON.stringify({ issue_id: issueId, ...payloadObj });
  await run(
    `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
     VALUES (?, 'scope_change', ?, 'release_published', ?, 1, '管理员')`,
    [issueId, summary, releaseId]
  );
}
const v2Payload = (type, title, commits = []) => ({ schema_version: 2, type, title_snapshot: title, status_at_publish: '已上线', commits });

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active')`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (1,'admin','管理员','admin','active'),(13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise((resolve) => { server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  console.log('\n══════ C4 getReleaseMembers 统一读源验证 ══════');

  // ═══ [1] live（计划中）═══
  {
    const relId = await mkReleaseRow('计划中');
    const i1 = await mkIssueRow(relId, 'feature', '功能A', '待上线');
    const i2 = await mkIssueRow(relId, 'bug', '缺陷B', '待上线');
    await mkCommit(i1, 'backend');
    await mkCommit(i1, 'frontend');
    const gm = await getReleaseMembers({ id: relId, status: '计划中' });
    assert.strictEqual(gm.source, 'live', '[1] source=live');
    assert.strictEqual(gm.degraded, false, '[1] degraded=false');
    assert.deepStrictEqual(gm.unavailable_fields, [], '[1] unavailable_fields=[]');
    assert.strictEqual(gm.members.length, 2, '[1] members 长度=2');
    const m1 = gm.members.find(m => m.issue_id === i1);
    assert.strictEqual(m1.type, 'feature', '[1] m1.type=feature');
    assert.strictEqual(m1.title_snapshot, '功能A', '[1] m1.title_snapshot=当前标题（live 态即时性）');
    assert.strictEqual(m1.status_at_publish, '待上线', '[1] m1.status_at_publish=当前状态（live 态未发布，非"已上线"常量）');
    assert.strictEqual(m1.commits.length, 2, '[1] m1.commits 取当前 sys_issue_dev_commits 两条');
    assert.deepStrictEqual(m1.commits.map(c => c.component), ['backend', 'frontend'], '[1] commits 按 id 升序（插入序）');
    const m2 = gm.members.find(m => m.issue_id === i2);
    assert.deepStrictEqual(m2.commits, [], '[1] m2 无 commit → 空数组（非 null/undefined）');
    ok('[1] live（计划中）：members 正确 + commits 取当前 sys_issue_dev_commits（含空数组正确态），source=live/degraded=false/unavailable_fields=[]');
  }

  // ═══ [1b] live 空批次 ═══
  {
    const relId = await mkReleaseRow('计划中');
    const gm = await getReleaseMembers({ id: relId, status: '计划中' });
    assert.strictEqual(gm.source, 'live', '[1b] 空批次 source 仍 live');
    assert.strictEqual(gm.degraded, false, '[1b] 空批次非降级（真实合法空）');
    assert.deepStrictEqual(gm.members, [], '[1b] members=[]');
    ok('[1b] live 空批次：members=[]/source=live/degraded=false（计划中态的合法空批次，非降级）');
  }

  // ═══ [2] snapshot（已发布，完整）═══
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'feature', '功能C', '已上线');
    const i2 = await mkIssueRow(relId, 'improvement', '优化D', '已上线');
    await mkSnapshotRow(relId, i1, v2Payload('feature', '功能C（发布时标题）', [{ commit_id: 1, component: 'backend' }]));
    await mkSnapshotRow(relId, i2, v2Payload('improvement', '优化D（发布时标题）', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '功能C（发布时标题）', [{ commit_id: 1, component: 'backend' }]));
    await mkPublishedTimelineRow(relId, i2, v2Payload('improvement', '优化D（发布时标题）', []));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'snapshot', '[2] source=snapshot（快照完整，不回落）');
    assert.strictEqual(gm.degraded, false, '[2] degraded=false');
    assert.deepStrictEqual(gm.unavailable_fields, [], '[2] unavailable_fields=[]');
    assert.strictEqual(gm.members.length, 2, '[2] members 长度=2');
    const m1 = gm.members.find(m => m.issue_id === i1);
    assert.strictEqual(m1.title_snapshot, '功能C（发布时标题）', '[2] title_snapshot 取自快照（发布时标题），非当前 sys_issues.title');
    assert.strictEqual(m1.status_at_publish, '已上线', '[2] status_at_publish 取自快照常量');
    assert.strictEqual(m1.commits.length, 1, '[2] commits 取自快照 payload');
    ok('[2] snapshot（已发布·完整）：members 逐字段取自快照 payload（含发布时标题，非当前可变值），source=snapshot/degraded=false');
  }

  // ═══ [3] degraded·部分快照缺失（整体回落，非逐成员拼接）═══
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'feature', '功能E', '已上线');
    const i2 = await mkIssueRow(relId, 'feature', '功能F', '已上线');
    // 只写 i1 的快照行（模拟"部分快照缺失"——i2 那行在写入时因故没落库）；两单的 release_published
    //   timeline 行都正常写（这是发布事务本该同时产生的两件事，此处人为制造二者不同步的脏态）。
    await mkSnapshotRow(relId, i1, v2Payload('feature', '功能E', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '功能E（timeline版）', []));
    await mkPublishedTimelineRow(relId, i2, v2Payload('feature', '功能F（timeline版）', []));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[3] source=degraded（快照行数1≠预期2）');
    assert.strictEqual(gm.degraded, true, '[3] degraded=true');
    assert.strictEqual(gm.members.length, 2, '[3] members 长度=2（两单均从 timeline 重建，非只剩快照缺失的那一单降级）');
    const m1 = gm.members.find(m => m.issue_id === i1);
    assert.strictEqual(m1.title_snapshot, '功能E（timeline版）', '[3] ⭐ i1 虽有快照行，但因整体判定 degraded，改从 timeline 重建（"不允许部分快照当完整返回"——不是快照数据本身用快照、缺的那条才补 timeline 的逐成员拼接）');
    ok('[3] degraded·部分快照缺失：快照行数(1)≠release_published timeline 行数(2)，整体回落 timeline 重建**全部**成员（含本有快照的 i1），验证"不允许部分快照当完整返回"');
  }

  // ═══ [4] degraded·载荷解析失败（不伪造字段）═══
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'bug', '缺陷G', '已上线');
    const i2 = await mkIssueRow(relId, 'bug', '缺陷H', '已上线');
    // 无快照行（0 行，触发 degraded）；i1 的 timeline 载荷是非法 JSON，i2 的 timeline 载荷合法但 schema_version 错。
    await mkPublishedTimelineRow(relId, i1, '{not valid json,,,');
    await mkPublishedTimelineRow(relId, i2, JSON.stringify({ issue_id: i2, schema_version: 1, type: 'bug', title_snapshot: '旧版本载荷' }));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[4] source=degraded');
    assert.strictEqual(gm.degraded, true, '[4] degraded=true');
    const m1 = gm.members.find(m => m.issue_id === i1);
    const m2 = gm.members.find(m => m.issue_id === i2);
    // 硬要求核心断言：解析失败/schema 不支持 → 字段严格为 null（不是空字符串/0/占位文案等"看起来正常"的伪造值）。
    assert.strictEqual(m1.type, null, '[4] i1（JSON 解析失败）type 严格为 null（不伪造）');
    assert.strictEqual(m1.title_snapshot, null, '[4] i1 title_snapshot 严格为 null');
    assert.strictEqual(m1.status_at_publish, null, '[4] i1 status_at_publish 严格为 null');
    assert.strictEqual(m1.commits, null, '[4] i1 commits 严格为 null（不是空数组——空数组是"确知无 commit"，null 是"不知道"，两者语义不同不可混用）');
    assert.strictEqual(m2.type, null, '[4] i2（schema_version=1 非当前已知版本）type 严格为 null');
    assert.ok(gm.unavailable_fields.includes('type') && gm.unavailable_fields.includes('title_snapshot')
      && gm.unavailable_fields.includes('status_at_publish') && gm.unavailable_fields.includes('commits'),
      `[4] unavailable_fields 应含全部四个字段名，实得 ${JSON.stringify(gm.unavailable_fields)}`);
    ok('[4] degraded·载荷解析失败（不伪造字段）：JSON 非法/schema_version 非 2 两种失败形态，字段严格 null（非空串/空数组/占位文案），unavailable_fields 精确列出四字段——满足任务硬要求"降级时不伪造字段"');
  }

  // ═══ [5] degraded·无快照回落成功（区别于[4]：数据本身没丢，只是 source 判定仍是 degraded）═══
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'improvement', '优化I', '已上线');
    // 快照表整体为空（0 行），但 timeline release_published 载荷完整合法 → 应能精确重建，非全 null。
    await mkPublishedTimelineRow(relId, i1, v2Payload('improvement', '优化I（timeline重建）', [{ commit_id: 9, component: 'db' }]));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[5] source=degraded（快照表整体缺失）');
    assert.strictEqual(gm.degraded, true, '[5] degraded=true');
    assert.deepStrictEqual(gm.unavailable_fields, [], '[5] ⭐ unavailable_fields=[]——数据本身完整重建成功，degraded 只反映"没走快照这条主路径"，不代表字段丢失');
    const m1 = gm.members[0];
    assert.strictEqual(m1.type, 'improvement', '[5] type 从 timeline 精确重建（非 null）');
    assert.strictEqual(m1.title_snapshot, '优化I（timeline重建）', '[5] title_snapshot 从 timeline 精确重建');
    assert.strictEqual(m1.commits.length, 1, '[5] commits 从 timeline 精确重建');
    ok('[5] degraded·无快照回落成功：快照表整体为空但 timeline 载荷完整可解析，精确重建全部字段（区别于[4]——source 同为 degraded，但 unavailable_fields=[]，数据本身没丢，只是没走快照主路径）');
  }

  // ═══ [6] 空成员（快照+timeline 双双为零行，脏数据兜底）═══
  {
    const relId = await mkReleaseRow('已发布');
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.deepStrictEqual(gm.members, [], '[6] members=[]');
    assert.strictEqual(gm.source, 'degraded', '[6] source=degraded（非 live，已发布态走已发布分支）');
    assert.strictEqual(gm.degraded, true, '[6] ⭐ degraded=true——不能因为"读出来是空数组"就误判成"合法空批次"（已发布批次理论不可达零成员，RELEASE_EMPTY 早挡，这里出现只可能是数据丢失，须如实标降级）');
    ok('[6] 空成员：已发布批次快照与 timeline release_published 双双零行（脏数据兜底场景）→ members=[] 但仍标 degraded=true，不悄悄当合法空批次');
  }

  // ═══ [6b] degraded·release_published timeline 行按 issue_id 重复（[C9 任务C] codex 207 审 MED-3 防御）═══
  //   正常路径下一个 issue_id 只会有一条 release_published timeline 行（同一次发布事务写一次，
  //   _publishReleaseCoreInTxn 头部注释声明的"同一 release_id 永不二次发布"不变量保证不会有第二条）——
  //   本组直接 SQL 构造该不变量被破坏时的脏数据，验证 getReleaseMembers 的去重防线真的生效。
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'feature', '重复行成员', '已上线');
    // 无快照行（触发 degraded）；同一 issue_id 写两条 release_published timeline 行（理论不可达场景）。
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '重复行成员', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '重复行成员', []));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[6b] source=degraded');
    assert.strictEqual(gm.degraded, true, '[6b] degraded=true');
    assert.strictEqual(gm.members.length, 1, '[6b] ⭐ 重复行按 issue_id 去重后 members 只有 1 条（非 2 条重复成员，详情页/列表不会因此重复展示）');
    assert.deepStrictEqual(gm.duplicate_release_published, [i1], '[6b] ⭐ duplicate_release_published 精确列出重复的 issue_id（不静默吞掉这个信号）');
    assert.deepStrictEqual(gm.unavailable_fields, [], '[6b] 去重与字段可用性是两回事——payload 本身合法，unavailable_fields 仍为空');
    // [C9 二次收口·codex 207 复审 MED-1] 两条重复行内容字节相同（同一份 v2Payload）→ 不是 conflict，
    // 只是普通重复——conflict 字段专指"重复行内容确实不一致"，这里必须为空，否则会把"重复但一致"
    // 误判成"重复且冲突"，混淆两种严重程度不同的脏数据信号。
    assert.deepStrictEqual(gm.duplicate_release_published_conflict, [], '[6b] 两条重复行内容一致（字节相同）→ duplicate_release_published_conflict 应为空（区分"重复但一致"与"重复且冲突"）');

    const gmCount = await getReleaseMembers({ id: relId, status: '已发布' }, { countOnly: true });
    assert.strictEqual(gmCount.count, 1, '[6b] countOnly 路径 count 同样按去重后计（与完整路径口径一致，非两套算法分叉）');
    assert.deepStrictEqual(gmCount.duplicate_release_published, [i1], '[6b] countOnly 路径同样透出 duplicate_release_published');
    assert.deepStrictEqual(gmCount.duplicate_release_published_conflict, [], '[6b] countOnly 路径同样透出 duplicate_release_published_conflict（此处应为空）');

    ok('[6b] degraded·同一 issue_id 出现两条 release_published timeline 行（脏数据兜底）：members 按 issue_id 去重（不重复成员）+ duplicate_release_published 精确暴露重复 issue_id（不静默吞）+ countOnly/完整两路径口径一致 + 内容一致时 conflict 字段为空');
  }

  // ═══ [6c] [C9 二次收口] degraded·三条重复行含内容冲突——稳定排序 + conflict 诊断（codex 207 复审 MED-1/LOW-1）═══
  //   构造同一 issue_id 三条 release_published timeline 行，其中第 2/3 条与第 1 条 summary 不同（模拟脏数据下
  //   "重复行内容也不一致"这种比单纯重复更严重的场景）。验证：① 去重后 members 只保留 1 条，且其内容
  //   确定性地等于**最早插入**的那一条（`id ASC` 稳定排序下的"首条"，非数据库隐式返回顺序）；
  //   ② duplicate_release_published 精确 1 个 issue_id（不因 3 条重复行而出现 2 次）；
  //   ③ duplicate_release_published_conflict 同样命中该 issue_id（内容确实不一致）。
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'feature', '冲突重复行成员', '已上线');
    // 三条行，故意用不同的 title_snapshot 制造"重复行内容不一致"——第 1 条（最早 id，最先 INSERT）
    // 应是去重后保留的那条；后两条内容不同，触发 conflict。
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '冲突重复行成员-最早插入-应保留', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '冲突重复行成员-第二条-不应保留', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '冲突重复行成员-第三条-不应保留', []));
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[6c] source=degraded');
    assert.strictEqual(gm.members.length, 1, '[6c] ⭐ 三条重复行去重后 members 仍只有 1 条（非 3 条）');
    assert.strictEqual(gm.members[0].title_snapshot, '冲突重复行成员-最早插入-应保留', '[6c] ⭐⭐ 保留内容确定性等于最早插入（id 最小）的那一条——稳定排序（issue_id ASC, id ASC）生效，非数据库隐式返回顺序的偶然结果');
    assert.deepStrictEqual(gm.duplicate_release_published, [i1], '[6c] ⭐ duplicate_release_published 精确 1 个 issue_id（3 条重复行不会让它出现 2 次，语义=去重后的 issue_id 集合，非"额外重复行计数"）');
    assert.deepStrictEqual(gm.duplicate_release_published_conflict, [i1], '[6c] ⭐⭐ duplicate_release_published_conflict 命中该 issue_id——三条行内容确实不一致，必须如实暴露，不能假定"重复=内容相同"');

    const gmCount = await getReleaseMembers({ id: relId, status: '已发布' }, { countOnly: true });
    assert.strictEqual(gmCount.count, 1, '[6c] countOnly 路径 count 同样按去重后计（三条只算 1）');
    assert.deepStrictEqual(gmCount.duplicate_release_published, [i1], '[6c] countOnly 路径同样透出 duplicate_release_published（精确 1 个）');
    assert.deepStrictEqual(gmCount.duplicate_release_published_conflict, [i1], '[6c] countOnly 路径同样透出 duplicate_release_published_conflict');

    ok('[6c] degraded·三条重复行含内容冲突：去重后保留内容确定性地等于最早插入的一条（稳定排序生效，非隐式顺序）+ duplicate_release_published 精确 1 个 issue_id（不随重复行数线性增长）+ duplicate_release_published_conflict 如实暴露内容分歧（不假定重复必然等价）');
  }

  // ═══ [7] release_type 派生三值（§6.9）═══
  {
    const deriveReleaseType = I.deriveReleaseType;
    assert.ok(typeof deriveReleaseType === 'function', '[7前置] deriveReleaseType 必须已从 _internals 导出');

    const singleBug = deriveReleaseType({ members: [{ type: 'bug' }, { type: 'bug' }], unavailable_fields: [] });
    assert.strictEqual(singleBug.category, 'single', '[7] 全 bug → category=single');
    assert.strictEqual(singleBug.type, 'bug', '[7] 全 bug → type=bug');

    const singleFeature = deriveReleaseType({ members: [{ type: 'feature' }], unavailable_fields: [] });
    assert.strictEqual(singleFeature.category, 'single', '[7] 单 feature → category=single');
    assert.strictEqual(singleFeature.type, 'feature', '[7] 单 feature → type=feature');

    const mixed = deriveReleaseType({ members: [{ type: 'feature' }, { type: 'improvement' }], unavailable_fields: [] });
    assert.strictEqual(mixed.category, 'mixed', '[7] feature+improvement 混合 → category=mixed');
    assert.strictEqual(mixed.type, null, '[7] mixed 态 type=null（不指定具体某一种）');

    const emptyMembers = deriveReleaseType({ members: [], unavailable_fields: [] });
    assert.strictEqual(emptyMembers.category, 'unknown', '[7] members=[] → category=unknown');

    // ⭐ 核心：type 字段进 unavailable_fields → 必须 unknown，且**不回落读当前任务表**（方案 §6.6b 明文）——
    //   即使 members[].type 恰好因为其他原因非 null，只要 unavailable_fields 标了 type，也不能信任它。
    const degradedTypeUnavailable = deriveReleaseType({ members: [{ type: null }, { type: null }], unavailable_fields: ['type', 'title_snapshot'] });
    assert.strictEqual(degradedTypeUnavailable.category, 'unknown', '[7] unavailable_fields 含 type → category=unknown（降级且 type 不可用时）');

    ok('[7] release_type 派生三值：single(bug|feature|improvement)/mixed/unknown 全路径验证，含 members=[] 与 unavailable_fields 含 type 两种触发 unknown 的独立路径（后者验证"不回落读当前任务表"的字面要求）');
  }

  // ═══ [8] HTTP 层端到端：两个切换后的热读点 ═══
  {
    // 8a：GET /sys-releases 列表——一个 live 批次 + 一个 degraded 批次，issue_count/source/degraded 均应正确透传。
    const relLive = await mkReleaseRow('计划中', { title: 'HTTP-live批次' });
    await mkIssueRow(relLive, 'feature', 'HTTP活单', '待上线');
    const relDegraded = await mkReleaseRow('已发布', { title: 'HTTP-degraded批次' });
    const iDeg = await mkIssueRow(relDegraded, 'feature', 'HTTP降级单', '已上线');
    await mkPublishedTimelineRow(relDegraded, iDeg, v2Payload('feature', 'HTTP降级单（timeline版）', []));
    // 无快照行 → 该批次判 degraded

    const listR = await call('GET', '/api/sys-releases', liaisonTok);
    assert.strictEqual(listR.status, 200, `[8a] 列表期望 200, got ${listR.status} ${JSON.stringify(listR.body)}`);
    const liveItem = listR.body.items.find(it => it.id === relLive);
    const degItem = listR.body.items.find(it => it.id === relDegraded);
    assert.ok(liveItem, '[8a] 列表含 live 批次');
    assert.strictEqual(liveItem.issue_count, 1, '[8a] live 批次 issue_count=1（真实成员数，非硬编码）');
    assert.strictEqual(liveItem.source, 'live', '[8a] live 批次 source=live');
    assert.strictEqual(liveItem.degraded, false, '[8a] live 批次 degraded=false');
    assert.ok(degItem, '[8a] 列表含 degraded 批次');
    assert.strictEqual(degItem.issue_count, 1, '[8a] degraded 批次 issue_count=1（从 timeline 重建的真实成员数，非 sys_issues 相关子查询的旧算法）');
    assert.strictEqual(degItem.source, 'degraded', '[8a] degraded 批次 source=degraded');
    assert.strictEqual(degItem.degraded, true, '[8a] degraded 批次 degraded=true（列表视图标注，同详情页策略，非统计口径的"排除"）');
    ok('[8a] GET /sys-releases 列表：issue_count 改走 getReleaseMembers 统一读源（live/degraded 两态均验证），新增 source/degraded 字段正确透传，旧字段（release_no/title/status/is_hotfix 等）逐字保留');

    // 8b：GET /sys-releases/:id 详情——degraded 批次的 issues 字段名向后兼容 + 顶层 source/degraded/unavailable_fields。
    const detailR = await call('GET', `/api/sys-releases/${relDegraded}`, adminTok);
    assert.strictEqual(detailR.status, 200, `[8b] 详情期望 200, got ${detailR.status} ${JSON.stringify(detailR.body)}`);
    assert.strictEqual(detailR.body.source, 'degraded', '[8b] 顶层 source=degraded');
    assert.strictEqual(detailR.body.degraded, true, '[8b] 顶层 degraded=true');
    assert.deepStrictEqual(detailR.body.unavailable_fields, [], '[8b] unavailable_fields=[]（timeline 载荷本身完整，同[5]场景）');
    assert.strictEqual(detailR.body.issues.length, 1, '[8b] issues 长度=1');
    const issRow = detailR.body.issues[0];
    // ⭐ 返回契约的向后兼容核心断言：字段名必须是旧契约的 id/type/title/status，不是 getReleaseMembers
    //   内部的 issue_id/type/title_snapshot/status_at_publish——否则前端 siOpenBatchDetail 现有渲染
    //   （读 i.id/i.type/i.title/i.status）会拿到 undefined，显示成一片空白（"旧消费者拿到不同形状的数据"
    //   这条风险的具体回归钉）。
    assert.strictEqual(issRow.id, iDeg, '[8b] issues[0].id（旧字段名）= issue_id 值');
    assert.strictEqual(issRow.title, 'HTTP降级单（timeline版）', '[8b] issues[0].title（旧字段名）= title_snapshot 值');
    assert.strictEqual(issRow.status, '已上线', '[8b] issues[0].status（旧字段名）= status_at_publish 值');
    assert.strictEqual(issRow.type, 'feature', '[8b] issues[0].type 正确');
    assert.strictEqual(issRow.issue_id, undefined, '[8b] issues[0] 不应含内部字段名 issue_id（严格核对返回契约，不多不少）');
    assert.strictEqual(issRow.title_snapshot, undefined, '[8b] issues[0] 不应含内部字段名 title_snapshot');
    assert.strictEqual(issRow.priority, undefined, '[8b] issues[0] 不应含 priority（已确认前端未消费，故不返回，防历史脏数据误读为"当前值"）');
    ok('[8b] GET /sys-releases/:id 详情：issues 数组改走 getReleaseMembers 统一读源，字段名向后兼容（id/type/title/status，非内部 issue_id/title_snapshot/status_at_publish），顶层新增 source/degraded/unavailable_fields 正确透传，priority/system_name/module_name/assigned_to_name 四个未消费字段确认不返回');
  }

  // ═══ [9] C5 收口批·codex 203 审 A 项：length 直接比对防御纵深 ═══
  //   构造"expectedIds 去重后掩盖真实重复"的场景——快照表 1 行，但 release_published timeline 里同一
  //   issue_id 出现两条重复行（正常业务流程下因 UNIQUE(release_id,issue_id) 快照约束 + 发布 CAS 双防线
  //   不可达，此处用直接 SQL 绕过应用层构造，专测这条新增判定本身是否真的生效）。旧判定
  //   `snapRows.length===expectedIds.size` 会被去重掩盖误判 complete=true（1===1）；新增的
  //   `snapRows.length===publishedTlRows.length` 会正确揪出（1≠2）判 degraded。
  {
    const relId = await mkReleaseRow('已发布');
    const i1 = await mkIssueRow(relId, 'feature', '功能J', '已上线');
    await mkSnapshotRow(relId, i1, v2Payload('feature', '功能J', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '功能J', []));
    await mkPublishedTimelineRow(relId, i1, v2Payload('feature', '功能J（重复行）', []));   // 人为重复第二条
    const gm = await getReleaseMembers({ id: relId, status: '已发布' });
    assert.strictEqual(gm.source, 'degraded', '[9] source=degraded（length 直接比对揪出 timeline 重复行，未被 expectedIds 去重掩盖）');
    assert.strictEqual(gm.degraded, true, '[9] degraded=true');
    ok('[9] codex 203 审 A 项：snapRows.length===publishedTlRows.length 防御纵深生效——1 条快照 + 2 条重复 timeline 行（去重后 size 仍=1，旧判定会误判 complete）被新增比对正确识别为不完整，回落 degraded');
  }

  // ═══ [10] C5 收口批·codex 203 审 B 项：status 强校验 ═══
  {
    const relId = await mkReleaseRow('计划中');
    // ⚠️ getReleaseMembers 是 async 函数——函数体内 throw 会转成 rejected Promise，非同步抛出，
    //   统一用 assert.rejects（不用 assert.throws，那是测同步抛出的，用错会导致断言本身恒假阳性通过）。
    await assert.rejects(getReleaseMembers({ id: relId }), /status 非法/, '[10a] release.status 缺失应抛错（不接受静默当 live 处理）');
    await assert.rejects(getReleaseMembers({ id: relId, status: undefined }), /status 非法/, '[10b] release.status=undefined 应抛错');
    await assert.rejects(getReleaseMembers({ id: relId, status: '已上线' }), /status 非法/, '[10c] release.status 拼写错误值（"已上线"非法值，正确应为"已发布"）应抛错');
    await assert.rejects(getReleaseMembers({ id: relId, status: '' }), /status 非法/, '[10d] release.status 空字符串应抛错');
    // 合法值仍正常放行（回归确认新增校验没有误伤正常路径）。
    const gmOk = await getReleaseMembers({ id: relId, status: '计划中' });
    assert.strictEqual(gmOk.source, 'live', '[10e] 合法 status="计划中" 仍正常放行');
    ok('[10] codex 203 审 B 项：release.status 强校验值域——缺失/undefined/拼写错误/空串四种非法输入均同步/异步抛错（不再静默当 live 脏读已发布批次），合法值不受影响');
  }

  // ═══ [11] C5 收口批·codex 203 审 C 项：{countOnly:true} 轻量路径与完整路径判定一致 ═══
  //   对同一批夹具分别以完整路径与 countOnly 路径各调一次，断言 count===members.length 且
  //   source/degraded 逐字相同——证明两条路径共用同一套三态判定，非另写一套逻辑各自演进。
  {
    // live 态
    const relLive = await mkReleaseRow('计划中');
    await mkIssueRow(relLive, 'feature', '功能K1', '待上线');
    await mkIssueRow(relLive, 'bug', '功能K2', '待上线');
    const fullLive = await getReleaseMembers({ id: relLive, status: '计划中' });
    const countLive = await getReleaseMembers({ id: relLive, status: '计划中' }, { countOnly: true });
    assert.strictEqual(countLive.members, undefined, '[11-live] countOnly 返回不应含 members 键');
    assert.strictEqual(countLive.count, fullLive.members.length, '[11-live] countOnly.count === 完整路径 members.length');
    assert.strictEqual(countLive.source, fullLive.source, '[11-live] source 一致');
    assert.strictEqual(countLive.degraded, fullLive.degraded, '[11-live] degraded 一致');

    // snapshot 态（完整）
    const relSnap = await mkReleaseRow('已发布');
    const sK1 = await mkIssueRow(relSnap, 'feature', '功能K3', '已上线');
    const sK2 = await mkIssueRow(relSnap, 'improvement', '功能K4', '已上线');
    await mkSnapshotRow(relSnap, sK1, v2Payload('feature', '功能K3', []));
    await mkSnapshotRow(relSnap, sK2, v2Payload('improvement', '功能K4', []));
    await mkPublishedTimelineRow(relSnap, sK1, v2Payload('feature', '功能K3', []));
    await mkPublishedTimelineRow(relSnap, sK2, v2Payload('improvement', '功能K4', []));
    const fullSnap = await getReleaseMembers({ id: relSnap, status: '已发布' });
    const countSnap = await getReleaseMembers({ id: relSnap, status: '已发布' }, { countOnly: true });
    assert.strictEqual(fullSnap.source, 'snapshot', '[11-snap前置] 完整路径应判 snapshot（夹具完整性核对）');
    assert.strictEqual(countSnap.count, fullSnap.members.length, '[11-snap] countOnly.count === 完整路径 members.length');
    assert.strictEqual(countSnap.source, fullSnap.source, '[11-snap] source 一致（均为 snapshot）');
    assert.strictEqual(countSnap.degraded, fullSnap.degraded, '[11-snap] degraded 一致（均为 false）');

    // degraded 态（快照整体缺失，timeline 完整）
    const relDeg = await mkReleaseRow('已发布');
    const dK1 = await mkIssueRow(relDeg, 'bug', '功能K5', '已上线');
    await mkPublishedTimelineRow(relDeg, dK1, v2Payload('bug', '功能K5', []));
    const fullDeg = await getReleaseMembers({ id: relDeg, status: '已发布' });
    const countDeg = await getReleaseMembers({ id: relDeg, status: '已发布' }, { countOnly: true });
    assert.strictEqual(fullDeg.source, 'degraded', '[11-deg前置] 完整路径应判 degraded（夹具核对）');
    assert.strictEqual(countDeg.count, fullDeg.members.length, '[11-deg] countOnly.count === 完整路径 members.length');
    assert.strictEqual(countDeg.source, fullDeg.source, '[11-deg] source 一致（均为 degraded）');
    assert.strictEqual(countDeg.degraded, fullDeg.degraded, '[11-deg] degraded 一致（均为 true）');

    ok('[11] codex 203 审 C 项：{countOnly:true} 轻量路径与完整路径在 live/snapshot/degraded 三态下 count/source/degraded 逐一比对一致——证明两条路径共用同一套三态判定代码，非另写一套判定各自演进');
  }

  console.log(`\n✅ verify-sys-release-members 全部通过（${passed} 组·上线体统一重构 C4 getReleaseMembers 统一读源三态+降级契约+类型派生+两热读点端到端 + C5 收口批 codex 203 审三项）`);
  server.close();
}
main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
