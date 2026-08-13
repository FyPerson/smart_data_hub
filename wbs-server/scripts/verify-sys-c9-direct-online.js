// 验证脚本：C9 无 commit 单验收通过自动直翻「已上线」（方案 v1.7 §10.1·含四订纠偏）
//   用法：node scripts/verify-sys-c9-direct-online.js
//
// 背景：配置/数据/文档类工作没有任何 commit 提交，走"验收通过→待上线→挂批次→批次发布"这条路是空转
//   （批次里躺着一个没有任何部署动作的单）。C9 让这类单在验收通过当场直翻「已上线」。
//
// 准入四条件（§10.1·全部在验收通过的**同一写事务**内判定）：
//   ① sys_issue_dev_commits 该单行数=0
//      ⚠️ 方案原文写的是 `removed_at IS NULL`，但该表**没有 removed_at 列**——删除是物理 DELETE
//        （C0 盘点实测纠偏，方案 v1.7 四订已订正）。故 active 判定=表内行数，行存在即 active。
//   ② 无 active 批次关联（双侧 NOT EXISTS：release_id IS NULL ∨ 指向的批次不在 active 状态集合内；
//      当前 schema 下 sys_releases.status 全集=计划中/已发布，两者都算 active）
//   ③ 状态 CAS：主 UPDATE 带 `WHERE id=? AND status=?(fromStatus)` + changes===1
//   ④ 「曾有 commit 但已删光」允许直翻，timeline 附记「该单曾发生过 N 次删除提交动作」（N>0 时·317-M2 文案订正）
//      ⚠️ 同④的连带纠偏：物删后 commits 表不留痕，N 只能数 sys_issue_dev_events 的 delete-commit 事件，
//        语义是「删除动作次数」而非「已软删行数」（当前等价，写实登记）。
//
// 覆盖组：
//   [1] 正例全链：无 commit 单验收通过 → 已上线 + online_source + released_at + release_id 仍 NULL + timeline
//   [2] 两条 409 硬负例：直翻后补 commit → 409；直翻后挂批次 → 409
//   [3] 有 commit 单验收通过 → **不直翻**，落「待上线」，零行为变化（online_source 仍 NULL）
//   [4] 挂 active 批次的单 → 不直翻（条件②）
//   [5] 删光单 → 直翻 + timeline 附记 N + 响应体 deleted_commit_count
//   [6] 并发竞态：验收通过 vs 补 commit —— CAS 抢一
//   [7] DTO 分支各现形（release_publish / no_commit_acceptance / unknown_legacy——本文件覆盖范围，
//       [预筛 LOW-3] 第四分支 authorized_fastlane 归 verify-sys-fastlane-submit.js [7a] 覆盖，不在此文件重复）
//   [8] 守卫负例：NO_COMMIT_ONLINE 之外的边进「已上线」被拒（[预筛 LOW-3] 红线已更新=进已上线现有三条明示
//       入口 RELEASE/NO_COMMIT_ONLINE/FAST_RELEASE_DIRECT，本组仅覆盖前二者的边界，FAST_RELEASE_DIRECT
//       routeKind 单元覆盖归 verify-sys-fastlane-submit.js [8] 组，不在此文件重复）
//   [9] 读点分支断言：列表 DTO 与详情 DTO 同源派生
//
// 断言纪律：精确状态码 + 精确 error code；负例断言"零副作用"（状态/列值/timeline 三查）。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-c9-direct-online-secret';
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

let oaSeq = 0;
// 建单 → 受理 → 补 OA → assign → estimate → submit(可选 commits) → 待验证。
//   withCommit=true 时走 commits 模式（单据带 1 条真实 commit 行 → 不满足准入条件①）。
async function seedToVerify({ type = 'feature', withCommit = false } = {}) {
  oaSeq++;
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `c9-${type}-${oaSeq}`, system_name: 'BMS', source: '内部',
    description: 'C9 免上线直翻 verify 场景建单', intake_liaison_id: 13,
    ...(type === 'bug' ? {} : { needs_feasibility: 0 }),
  });
  assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, type === 'bug' ? {} : { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `受理 200, got ${r.status} ${JSON.stringify(r.body)}`);
  if (type !== 'bug') {
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026070000 + oaSeq) });
    assert.strictEqual(r.status, 200, `补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
  // 让对接人在 GATE 判定时失效 → 走 §3.0-⑥ 降级，submit 直落「待验证」（同 verify-sys-feasibility-endpoints 既有手法）
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  if (type !== 'bug') {
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  } else {
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, `bug estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  // [B4b 全仓扫净] type==='bug' 时必填 bug_cause_note（C6 拍板生效后）；其余类型不加（加了会撞 NOT_APPLICABLE）。
  const bugCauseExtra = type === 'bug' ? { bug_cause_note: 'verify 夹具：bug 产生原因（c9-direct-online）' } : {};
  const submitBody = withCommit
    ? { mode: 'commits', commits: [{ component: 'backend', commit_ref: `c9-ref-${oaSeq}` }], self_tested: true, test_env_deployed: true, ...bugCauseExtra }
    : { mode: 'no_code', no_code_reason: 'C9 无提交交付（配置类工作）', self_tested: true, test_env_deployed: true, ...bugCauseExtra };
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody);
  assert.strictEqual(r.status, 200, `submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.main_status, '待验证', `submit 后应落待验证，实得 ${r.body.main_status}`);
  return id;
}
const issueRow = (id) => get('SELECT status, released_at, online_source, release_id, accepted_at FROM sys_issues WHERE id=?', [id]);
const tlOf = (id) => all(`SELECT summary, action_code, from_status, to_status FROM sys_issue_timeline WHERE issue_id=? ORDER BY id`, [id]);
const commitCount = (id) => get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [id]);

// ⭐⭐ [C9-fix2·316-B 第 6 项] 负例「零副作用」**统一快照模板**（照 verify-sys-effort-c7 [6c] 的 helper 同款思路）。
//   改前各负例只查一列（[2a] 查 commit 数、[2b] 查 release_id、[3] 查 online_source、[4] 查两列…）——那是
//   **局部抽查**：一个被拒的请求若顺手改了别的列（写了 released_at、多插一条 timeline、动了 reopen_count），
//   现有断言一条都察觉不到。改为"调用前后统一快照逐项深比较"。
//   ⚠️ [316-R2 表述收窄] 本快照覆盖=**下列七列 + timeline/commit/删除事件三计数**，不是整行 SELECT *——
//     它证明的是"所列列与所列关联计数无变化 + 任何会推进 updated_at 的写都被哨兵抓到"，**不是**"整行
//     任何列都没动"（未覆盖列若被不推进 updated_at 的方式改写，本快照看不见——SQLite 下正常 UPDATE 均会
//     被写点的 updated_at 惯例带出，该残余面属"旁路直写未覆盖列"级别，如实登记不夸大）。
//   ⚠️ 抽成 helper 而非各组复制：零副作用口径必须**同一份**，复制粘贴迟早漂移（改一处漏五处）。
// ⭐⭐ [C7-fix3 M3'·316-R 指出的同款盲区] C9 的负例快照原先**不含 updated_at**，于是"复写原值的空转写"
//   （六列写回原值 + 只推进时间戳 + 提交）在本文件所有零副作用断言下都是绿的。补进比对面。
//   ⚠️ 且必须走**哨兵值范式**而不是"前后 strictEqual"：本仓写点一律 `datetime('now','localtime')`，
//     **精度只到秒**——夹具建单与被测请求常落在同一秒，空转写把 updated_at 写回同一个字符串，
//     "前后相等"照样成立（跑得越快越容易假绿）。改为快照前把它钉成确定的历史哨兵值，断言"仍是哨兵值"：
//     任何 UPDATE 都会把它变成当前时刻，绝不可能等于 2020 年。
const C9_UPDATED_AT_SENTINEL = '2020-01-01 00:00:00';
const C9_SNAP_COLS = ['status', 'released_at', 'online_source', 'release_id', 'accepted_at', 'reopen_count', 'updated_at'];
const stampSentinelC9 = async (id) => {
  await run(`UPDATE sys_issues SET updated_at = ? WHERE id = ?`, [C9_UPDATED_AT_SENTINEL, id]);
  const chk = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
  assert.strictEqual(chk.updated_at, C9_UPDATED_AT_SENTINEL,
    `[快照前置] updated_at 应已被钉成哨兵值 ${C9_UPDATED_AT_SENTINEL}（钉不进去则"未被推进"的断言退化成恒真），实得 ${JSON.stringify(chk.updated_at)}`);
};
const snapC9 = async (id) => ({
  row: await get(`SELECT ${C9_SNAP_COLS.join(', ')} FROM sys_issues WHERE id=?`, [id]),
  tl: Number((await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id])).c),
  commits: Number((await commitCount(id)).c),
  delEvents: Number((await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=? AND action='delete-commit'`, [id])).c),
});
const assertNoSideEffectC9 = async (id, before, tag) => {
  const after = await snapC9(id);
  // ⭐ [C7-fix3 M3'] 强制"快照前必须钉过哨兵"——否则 updated_at 那一格会退化回"前后相等"，同秒空转写就假绿。
  //   把这条做成 helper 内的硬前置，未来新增负例组时忘了钉哨兵会**当场红**，而不是悄悄少一层保护。
  assert.strictEqual(before.row.updated_at, C9_UPDATED_AT_SENTINEL,
    `${tag} 前置：快照前必须先调 stampSentinelC9(id) 把 updated_at 钉成 ${C9_UPDATED_AT_SENTINEL}（漏钉则 updated_at 比对退化成"前后相等"，秒级精度下空转写会假绿），实得 ${JSON.stringify(before.row.updated_at)}`);
  for (const col of C9_SNAP_COLS) {
    assert.strictEqual(after.row[col], before.row[col],
      `${tag} 零副作用：sys_issues.${col} 未被改动（应仍为 ${JSON.stringify(before.row[col])}，实得 ${JSON.stringify(after.row[col])}）`);
  }
  assert.strictEqual(after.tl, before.tl, `${tag} 零副作用：timeline 零新增（应仍 ${before.tl} 条，实得 ${after.tl}）`);
  assert.strictEqual(after.commits, before.commits, `${tag} 零副作用：commit 行数未变（应仍 ${before.commits}，实得 ${after.commits}）`);
  assert.strictEqual(after.delEvents, before.delEvents, `${tag} 零副作用：delete-commit 事件数未变（应仍 ${before.delEvents}，实得 ${after.delEvents}）`);
};

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  // ═══ [1] 正例全链：无 commit 单验收通过 → 直翻「已上线」═══
  {
    for (const type of ['feature', 'improvement', 'bug']) {
      const id = await seedToVerify({ type });
      assert.strictEqual(Number((await commitCount(id)).c), 0, `[1-${type}-前置] 该单确实零 commit 行（准入条件①的前提，防夹具自己变假）`);
      const before = await issueRow(id);
      assert.strictEqual(before.status, '待验证', `[1-${type}-前置] 验收前是待验证`);
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(r.status, 200, `[1-${type}] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '已上线', `[1-${type}] ⭐ 响应 status 应直接是「已上线」（跳过待上线），实得 ${r.body.status}`);
      assert.strictEqual(r.body.online_source, 'no_commit_acceptance', `[1-${type}] 响应带 online_source，实得 ${r.body.online_source}`);
      assert.strictEqual(r.body.deleted_commit_count, 0, `[1-${type}] 从未有过 commit → deleted_commit_count=0`);
      const row = await issueRow(id);
      assert.strictEqual(row.status, '已上线', `[1-${type}] 落库 status=已上线`);
      assert.ok(row.released_at, `[1-${type}] released_at 已写（与批次发布路径同一列同一写法）`);
      assert.ok(row.accepted_at, `[1-${type}] accepted_at 照常写（accept 的既有 sideEffect 未被直翻吞掉）`);
      assert.strictEqual(row.online_source, 'no_commit_acceptance', `[1-${type}] online_source 落库`);
      assert.strictEqual(row.release_id, null, `[1-${type}] ⭐ release_id 保持 NULL——不伪造批次关联（§10.1 字段契约）`);
      const tl = await tlOf(id);
      const acc = tl.filter(t => t.action_code === 'accept');
      assert.strictEqual(acc.length, 1, `[1-${type}] accept timeline 恰 1 条`);
      assert.strictEqual(acc[0].to_status, '已上线', `[1-${type}] timeline to_status=已上线（留痕与落库同源）`);
      assert.ok(/无提交免上线（验收通过自动结单）/.test(acc[0].summary), `[1-${type}] timeline summary 含「无提交免上线（验收通过自动结单）」，实得 ${acc[0].summary}`);
      assert.ok(!/删除提交动作|已删提交记录/.test(acc[0].summary), `[1-${type}] N=0 时不应出现删光附记`);
      ok(`[1-${type}] ⭐ 无 commit ${type} 单 accept → 直翻「已上线」：status/released_at/online_source 三写原子落库 + release_id 仍 NULL + timeline 留痕含免上线文案（N=0 无附记）`);
    }
  }

  // ═══ [2] 两条 409 硬负例（§10.1 并发封闭·C9 必测）═══
  {
    const id = await seedToVerify({ type: 'feature' });
    let r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, '[2-前置] 直翻成功');
    assert.strictEqual((await issueRow(id)).status, '已上线', '[2-前置] 已在已上线');
    // [2a] 直翻后再补 commit → 409（补 commit 入口的族门：已上线属 RELEASE 族，不在 DEV∪VERIFY）
    const da = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL`, [id]);
    await stampSentinelC9(id); // [C7-fix3 M3'] 钉哨兵后再快照（秒级精度下前后相等会假绿）
    const before2a = await snapC9(id);
    r = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok, { component: 'backend', commit_ref: 'sneak-after-online' });
    assert.strictEqual(r.status, 409, `[2a] 直翻后补 commit 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_STATUS', `[2a] 确切码 INVALID_STATUS（族门 assertMemberActionFamilyAllowed），实得 ${r.body.code}`);
    await assertNoSideEffectC9(id, before2a, '[2a]'); // [316-B 第6项] 由"只查 commit 数"升级为整份快照逐项深比较
    assert.ok(da, '[2a] 夹具 roster 行存在（确认上面拒绝不是因为查无 roster）');
    ok('[2a] ⭐ 硬负例：免上线直翻后再补 commit → 409 INVALID_STATUS + 零副作用统一快照（单据 6 列/timeline/commit 数/删除事件数逐项未变）（并发封闭：直翻后单据不可再回头长出 commit）');
    // [2b] 直翻后挂批次 → 409（add-issues 的逐单 CAS 要求 status='待上线'）
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-2b 批次' });
    assert.strictEqual(relR.status, 201, '[2b-前置] 建批次 201');
    await stampSentinelC9(id); // [C7-fix3 M3'] 钉哨兵后再快照（秒级精度下前后相等会假绿）
    const before2b = await snapC9(id);
    r = await call('POST', `/api/sys-releases/${relR.body.id}/add-issues`, adminTok, { issue_ids: [id] });
    assert.strictEqual(r.status, 409, `[2b] 直翻后挂批次期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE', `[2b] 确切码 ISSUE_NOT_ADDABLE，实得 ${r.body.code}`);
    await assertNoSideEffectC9(id, before2b, '[2b]'); // 含 release_id 仍 NULL（原断言）+ 其余五列/三计数
    ok('[2b] ⭐ 硬负例：免上线直翻后再挂上线批次 → 409 ISSUE_NOT_ADDABLE + 零副作用统一快照（release_id 未被半挂 + 其余列与三项计数同样未动）');
  }

  // ═══ [3] 有 commit 单 → 不直翻，零行为变化 ═══
  {
    const id = await seedToVerify({ type: 'feature', withCommit: true });
    assert.strictEqual(Number((await commitCount(id)).c), 1, '[3-前置] 该单有 1 条 active commit');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[3] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[3] ⭐ 有 commit → 走既有路径落「待上线」，实得 ${r.body.status}`);
    assert.ok(!('online_source' in r.body), `[3] 非直翻路径响应体不带 online_source 键（与 C9 前逐字相同），实得键=${Object.keys(r.body).join(',')}`);
    assert.ok(!('deleted_commit_count' in r.body), '[3] 非直翻路径响应体不带 deleted_commit_count 键');
    // [316-B 第6项] 由"抽查两列"升级为**逐项终态断言**：本组 accept 是成功路径（status 必然变），故不能用
    //   "改前==改后"，改为把快照六列 + 三项计数的**期望终态**逐条写死——直翻路径独有的副作用（released_at/
    //   online_source）必须为空，而与直翻无关的东西（commit 行、删除事件、reopen_count）必须原样。
    const after3 = await snapC9(id);
    assert.strictEqual(after3.row.status, '待上线', '[3] 落库 待上线');
    assert.strictEqual(after3.row.released_at, null, '[3] released_at 未写（还没上线）');
    assert.strictEqual(after3.row.online_source, null, '[3] ⭐ online_source 未写——非直翻路径一个字都不碰这根列');
    assert.strictEqual(after3.row.release_id, null, '[3] release_id 仍 NULL（accept 不挂批次；也证明 H2-a 的置 NULL 只发生在直翻分支）');
    assert.ok(after3.row.accepted_at, '[3] accepted_at 照常写（accept 既有 sideEffect）');
    assert.strictEqual(Number(after3.row.reopen_count), 0, '[3] reopen_count 未被动');
    assert.strictEqual(after3.commits, 1, '[3] ⭐ commit 行仍为 1（accept 不吞不删既有 commit——本组的前提就是"这单有 commit"，测完还得在）');
    assert.strictEqual(after3.delEvents, 0, '[3] 未凭空产生 delete-commit 事件');
    const acc = (await tlOf(id)).filter(t => t.action_code === 'accept');
    assert.strictEqual(acc.length, 1, '[3] ⭐ accept timeline 恰 1 条（不多写不重复写——直翻分支的附记逻辑不该在这条路径上多留痕）');
    assert.strictEqual(acc[0].to_status, '待上线', '[3] timeline to_status=待上线');
    assert.ok(!/免上线/.test(acc[0].summary || ''), '[3] timeline 不含免上线文案');
    ok('[3] ⭐ 有 commit 单 accept → 不直翻，落「待上线」+ 六列终态逐项断言（released_at/online_source/release_id 三空·accepted_at 已写·reopen_count 未动）+ commit 仍 1 + accept timeline 恰 1 条 + 响应体不多键（零行为变化，C9 对既有主路径无侵入）');
  }

  // ═══ [4] 挂 active 批次的单 → 不直翻（准入条件②）═══
  {
    // 构造：单据零 commit（满足①）但已挂在一个「计划中」批次上（不满足②）
    const id = await seedToVerify({ type: 'feature' });
    assert.strictEqual(Number((await commitCount(id)).c), 0, '[4-前置] 零 commit（条件①满足，确保本组只测条件②）');
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-4 active 批次' });
    const relId = relR.body.id;
    // add-issues 要求单据在「待上线」，而本单还在「待验证」——直接建立关联以隔离出"只有条件②不满足"的场景
    await run(`UPDATE sys_issues SET release_id = ? WHERE id = ?`, [relId, id]);
    const relRow = await get(`SELECT status FROM sys_releases WHERE id=?`, [relId]);
    assert.strictEqual(relRow.status, '计划中', '[4-前置] 批次是「计划中」= active 状态集合成员');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[4] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[4] ⭐ 挂 active 批次 → 不直翻（业务已判定它有部署动作），实得 ${r.body.status}`);
    assert.ok(!('online_source' in r.body), '[4] 非直翻路径响应体不带 online_source 键');
    // [316-B 第6项] 逐项终态：直翻独有副作用全空，且 **release_id 必须原样保留**——H2-a 让直翻分支置
    //   release_id=NULL，这条断言钉死"那个置 NULL 只在直翻分支发生"，不会误伤走既有路径的挂批次单。
    const after4 = await snapC9(id);
    assert.strictEqual(after4.row.status, '待上线', '[4] 落库 待上线');
    assert.strictEqual(after4.row.online_source, null, '[4] online_source 未写');
    assert.strictEqual(after4.row.released_at, null, '[4] released_at 未写');
    assert.strictEqual(after4.row.release_id, relId, `[4] ⭐ release_id 原样保留=${relId}（H2-a 的置 NULL 只在直翻分支，绝不能误伤挂批次的正常单），实得 ${after4.row.release_id}`);
    assert.strictEqual(after4.commits, 0, '[4] commit 数仍 0');
    assert.strictEqual(after4.delEvents, 0, '[4] 无 delete-commit 事件');
    const acc4 = (await tlOf(id)).filter(t => t.action_code === 'accept');
    assert.strictEqual(acc4.length, 1, '[4] accept timeline 恰 1 条');
    assert.ok(!/免上线/.test(acc4[0].summary || ''), '[4] timeline 无免上线附记');
    ok('[4] ⭐ 零 commit **但挂「计划中」批次**的单 accept → 不直翻，落「待上线」+ 逐项终态（release_id 原样保留证明 H2-a 置 NULL 只在直翻分支）（准入条件②独立生效：条件①满足不代表能走旁路）');
  }

  // ═══ [4b] ⭐ [C9-fix2·316-B 第 5 项] 条件② 的**另一个 active 状态**：「已发布」批次同样阻止直翻 ═══
  //   SYS_ACTIVE_RELEASE_STATUSES=['计划中','已发布'] 是逐状态核出的集合（[[feedback_status_set_enumerate_not_merge]]），
  //   而 [4] 只测了『计划中』一个成员——集合里第二个成员从未被任何断言碰过。若实现哪天把条件②的
  //   `status IN (...)` 写成 `status='计划中'`，[4] 照绿，本组才会红。
  {
    const id = await seedToVerify({ type: 'feature' });
    assert.strictEqual(Number((await commitCount(id)).c), 0, '[4b-前置] 零 commit（条件①满足，隔离出只有条件②不满足）');
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-4b 已发布批次' });
    const relId = relR.body.id;
    await run(`UPDATE sys_issues SET release_id = ? WHERE id = ?`, [relId, id]);
    await run(`UPDATE sys_releases SET status = '已发布' WHERE id = ?`, [relId]);
    const relRow = await get(`SELECT status FROM sys_releases WHERE id=?`, [relId]);
    assert.strictEqual(relRow.status, '已发布', '[4b-前置] 批次确为「已发布」= active 状态集合的第二个成员（防夹具没改成功导致本组退化成 [4] 的复制）');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[4b] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[4b] ⭐ 挂「已发布」批次同样不直翻，实得 ${r.body.status}`);
    assert.ok(!('online_source' in r.body), '[4b] 响应体不带 online_source 键');
    const after = await snapC9(id);
    assert.strictEqual(after.row.online_source, null, '[4b] online_source 未写');
    assert.strictEqual(after.row.released_at, null, '[4b] released_at 未写');
    assert.strictEqual(after.row.release_id, relId, '[4b] release_id 原样保留');
    ok('[4b] ⭐ [316-B] 挂「已发布」批次的零 commit 单 accept → 同样不直翻落「待上线」——SYS_ACTIVE_RELEASE_STATUSES 两个成员各有一组，集合被逐成员覆盖（写成 status=\'计划中\' 的实现会在本组红）');
  }

  // ═══ [4c] ⭐ [C9-fix2·316-B 第 4 项] 组合负例：删光留痕 N>0 ∧ 零 commit ∧ 挂 active 批次 ═══
  //   条件④（曾删光·放行）与条件②（挂 active 批次·阻断）**同时成立**时，谁说了算？必须是条件②阻断。
  //   这一格此前没有任何断言：[5] 测的是"删光 ∧ 无批次"（放行），[4] 测的是"零 commit ∧ 有批次"（阻断），
  //   两组的交叉点没人碰过。若实现把"曾有删除留痕"错当成放行凭据（或把 N>0 当成免检），本组才会红。
  {
    const id = await seedToVerify({ type: 'feature', withCommit: true });
    const row0 = await get(`SELECT id, dev_assignee_id FROM sys_issue_dev_commits WHERE issue_id=?`, [id]);
    assert.ok(row0, '[4c-前置] 有 1 条 commit');
    await run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [row0.id]);
    await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
       VALUES (?, ?, 'delete-commit', 1, ?, datetime('now','localtime'))`,
      [id, row0.dev_assignee_id, 'C9-4c 构造：删光后又被排进批次']
    );
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-4c active 批次' });
    const relId = relR.body.id;
    await run(`UPDATE sys_issues SET release_id = ? WHERE id = ?`, [relId, id]);
    const pre = await snapC9(id);
    assert.strictEqual(pre.commits, 0, '[4c-前置] 条件①满足（零 active commit）');
    assert.strictEqual(pre.delEvents, 1, '[4c-前置] 条件④成立（有 1 条 delete-commit 留痕）——三个条件同时在场，本组才有意义');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[4c] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[4c] ⭐ 条件②（挂 active 批次）优先阻断——"曾删光"不是绕过批次关联的通行证，实得 ${r.body.status}`);
    assert.ok(!('online_source' in r.body), '[4c] 响应体不带 online_source 键');
    assert.ok(!('deleted_commit_count' in r.body), '[4c] ⭐ 不直翻时连 deleted_commit_count 也不带（N>0 不等于走了直翻路径）');
    const after = await snapC9(id);
    assert.strictEqual(after.row.released_at, null, '[4c] released_at 未写');
    assert.strictEqual(after.row.online_source, null, '[4c] online_source 未写');
    assert.strictEqual(after.row.release_id, relId, '[4c] ⭐ release_id 保留（未被 H2-a 的直翻置 NULL 误伤）');
    assert.strictEqual(after.delEvents, 1, '[4c] 删除事件留痕未被动');
    const acc4c = (await tlOf(id)).filter(t => t.action_code === 'accept');
    assert.strictEqual(acc4c.length, 1, '[4c] accept timeline 恰 1 条');
    assert.ok(!/免上线|删除提交动作|已删提交记录/.test(acc4c[0].summary || ''), `[4c] ⭐ timeline 既无免上线文案也无删光附记（附记只属于直翻分支），实得 ${acc4c[0].summary}`);
    ok('[4c] ⭐ [316-B] 组合负例（删光留痕 N=1 ∧ 零 commit ∧ 挂 active 批次）→ 不直翻、release_id 保留、released_at/online_source 未写、无免上线附记与删光附记——条件②对条件④的优先关系被钉死');
  }

  // ═══ [5] 删光单 → 直翻 + 附记 N（准入条件④·用户拍板"留证不设闸"）═══
  {
    // ⚠️⚠️ **C9 编码期实测发现：条件④的场景在当前实现下端到端「结构性不可达」**（本组因此改直连 SQL 构造，
    //   并把不可达这件事本身写实登记，不假装它是可达路径）。推理链：
    //     · 往单据加 commit 的唯一入口 `POST /sys-issues/:id/dev/commits` 要求实例 `dev_status='code_submitted'`；
    //     · 删 commit 端点有既有不变量：`code_submitted` 实例删后剩余须 ≥1（400 GATE_INVARIANT，index.js:5987）
    //       ⇒ 有过 commit 的 code_submitted 实例**永远删不到 0**；
    //     · `return`（验收打回）**不重置花名册**（重置的是 liaison_test_return），实例仍是 code_submitted；
    //     · 移除实例只置 dev_assignees.removed_at，**不级联删 commit 行**（级联只发生在整单删除，index.js:7091）
    //       ⇒ 换实例也甩不掉旧 commit（条件①按 issue_id 计数，跨实例）。
    //   四条合起来：commit 一旦提交过，`active 行数=0` 就再也回不去了。故条件④当前是**纯防御性分支**——
    //   它防的是"将来 commits 表改软删/可恢复，或删除不变量被放宽"之后出现的场景。用 SQL 构造是**如实
    //   测这段逻辑本身**，不是绕过被测代码（被测的是 C9 的 N 计数与附记拼接，不是删除端点的闸）。
    // ⭐⭐ [C9-fix2·316-B 第 3 项] 本组改为**带干扰数据**：原版只造 1 条 delete-commit 事件、断 N=1——
    //   那个 1 太容易被错误实现蒙对（全表计数、漏 action 过滤、漏 issue_id 过滤，在"全库只有一条事件"
    //   的世界里都能得出 1）。现在：目标单 **2 条 delete-commit + 1 条其他 action 事件**，另有一张单
    //   **3 条 delete-commit**。此时只有"按 issue_id ∧ action='delete-commit' 计数"才能得出 2：
    //     · 漏 action 过滤 → 3（把 add-commit 事件也数进来）
    //     · 漏 issue_id 过滤 → 5 或 6（数到别人家的）
    //     · 全表计数 → ≥5
    //   三种错法各自落到不同的数上，2 是唯一正确答案。
    const idOther = await seedToVerify({ type: 'feature', withCommit: true });
    const otherCommit = await get(`SELECT id, dev_assignee_id FROM sys_issue_dev_commits WHERE issue_id=?`, [idOther]);
    await run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [otherCommit.id]);
    for (let k = 0; k < 3; k++) {
      await run(
        `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
         VALUES (?, ?, 'delete-commit', 1, ?, datetime('now','localtime'))`,
        [idOther, otherCommit.dev_assignee_id, `C9-5 干扰单第 ${k + 1} 条删除事件`]
      );
    }

    const id = await seedToVerify({ type: 'feature', withCommit: true });
    const row0 = await get(`SELECT id, dev_assignee_id, dev_user_id FROM sys_issue_dev_commits WHERE issue_id=?`, [id]);
    assert.ok(row0, '[5-前置] 有 1 条 commit');
    // 直连 SQL 复刻「删 commit」这个动作的两条落库效果（物删行 + 写 append-only 事件），与端点 :5991/:6000 同形
    await run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [row0.id]);
    for (const reason of ['C9-5 构造：填错了删掉重填', 'C9-5 构造：第二次也填错了']) {
      await run(
        `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
         VALUES (?, ?, 'delete-commit', 1, ?, datetime('now','localtime'))`,
        [id, row0.dev_assignee_id, reason]
      );
    }
    // 同单据的**另一种 action** 事件——DDL CHECK 枚举内的合法值，用于逼出"漏 action 过滤"的实现
    await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
       VALUES (?, ?, 'add-commit', 1, ?, datetime('now','localtime'))`,
      [id, row0.dev_assignee_id, 'C9-5 干扰：同单据的非 delete-commit 事件']
    );
    assert.strictEqual(Number((await commitCount(id)).c), 0, '[5-前置] ⭐ 物理删除后表内零行（印证 C0 盘点：该表无 removed_at 软删列）');
    const evCount = await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=? AND action='delete-commit'`, [id]);
    assert.strictEqual(Number(evCount.c), 2, '[5-前置] 目标单 delete-commit 事件恰 2 条（N 的唯一可信来源：append-only 事件表）');
    // ⚠️ 目标单的事件总数**不写死**：seedToVerify(withCommit) 走真实 submit 链路时本就会产生 submit /
    //   add-commit 等事件行（首版把总数断成 3 = 只数了自己插的那几条，属**断言写错**非实现错；具体总数
    //   不落笔——它含本测试手工插入的干扰行，写死数字就是又一处"只数自己插的"）。
    //   这里要证的是"存在非 delete-commit 的同单事件"这个干扰面，故断"总数严格大于删除数"+ 显式点名
    //   add-commit 至少一条——两条都成立才说明"漏 action 过滤"的实现会数出比 2 更大的数。
    const evAll = await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=?`, [id]);
    assert.ok(Number(evAll.c) > Number(evCount.c),
      `[5-前置] 目标单须同时存在**非 delete-commit** 的事件（干扰面），总数 ${evAll.c} 应 > 删除数 ${evCount.c}，否则本组退化回"只有删除事件、漏 action 过滤也蒙得对"的旧形态`);
    const evAdd = await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=? AND action='add-commit'`, [id]);
    assert.ok(Number(evAdd.c) >= 1, `[5-前置] 目标单至少 1 条 add-commit 事件（漏 action 过滤的实现会把它数进 N），实得 ${evAdd.c}`);
    const evOther = await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=? AND action='delete-commit'`, [idOther]);
    assert.strictEqual(Number(evOther.c), 3, '[5-前置] 另一单 3 条删除事件（逼出"漏 issue_id 过滤/全表计数"的实现）');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[5] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已上线', '[5] ⭐ 曾有 commit 但已删光 → **允许**直翻（不卡"填错删掉重填"的正常单）');
    assert.strictEqual(r.body.deleted_commit_count, 2,
      `[5] ⭐ 响应体 deleted_commit_count **精确=2**（不是 3=漏 action 过滤 / 不是 5-6=漏 issue_id 过滤 / 不是全表数），实得 ${r.body.deleted_commit_count}`);
    const acc = (await tlOf(id)).filter(t => t.action_code === 'accept');
    // ⭐ [C9 对抗审 codex 317·M2] 文案订正为「发生过 N 次删除提交动作」（N=动作次数非唯一 commit 数）
    assert.ok(/该单曾发生过 2 次删除提交动作/.test(acc[0].summary), `[5] ⭐ timeline 附记「该单曾发生过 2 次删除提交动作」（留证不设闸，交人判断），实得 ${acc[0].summary}`);
    // 反向：不得再出现旧的"N 条已删提交记录 / N 条提交"措辞（会被读成 commit 计数，317-M2 语义偏移）
    assert.ok(!/条已删提交记录|条提交/.test(acc[0].summary), `[5] ⭐ 不得回退到"N 条已删提交记录/N 条提交"措辞（会被读成"N 条不同提交"），实得 ${acc[0].summary}`);
    // ⭐ [316-B 第3项] 响应值与 timeline 文案**同源**：两处的 N 必须是同一个数，不允许一处 2 一处 1
    //   （响应体走 verdict.deletedCommitCount、timeline 走引擎 switch 里的 deletedN，两者若分家会各错各的）。
    assert.ok(new RegExp(`该单曾发生过 ${r.body.deleted_commit_count} 次删除提交动作`).test(acc[0].summary),
      `[5] ⭐ timeline 里的 N 必须与响应体 deleted_commit_count 同值（同一份裁决的两个出口），响应=${r.body.deleted_commit_count}，timeline=${acc[0].summary}`);
    assert.strictEqual(Number((await snapC9(id)).delEvents), 2, '[5] 直翻不消费/不清理删除留痕（append-only 事实表原样保留）');
    ok('[5] ⭐ 删光单 accept → 直翻放行 + N 精确=2（带干扰数据：同单另有 1 条非删除事件、另一单 3 条删除事件，三种错误实现各落不同的数）+ 响应值与 timeline 文案同源（"发生过 2 次删除提交动作"）+ 留痕未被消费');

    // ═══ [5b] ⭐⭐ [C9 对抗审 codex 317·M2] 「同一 commit ref 重加再删」→ N=2（坐实 N=动作次数·非唯一 commit 数）═══
    //   对抗审的核心构造：**同一个 commit ref** 被「提交→删→用同 ref 重新提交→再删」，两次删除动作落 2 条
    //   delete-commit 事件 ⇒ N=2，而"涉及的不同 commit"其实只有一个 ref。这一组把这个序列真跑一遍，钉死
    //   "N 数的是动作次数，不是去重后的唯一 commit 数"——若哪天有人把 N 改成按 commit_ref DISTINCT 计数
    //   （听起来更"合理"，实则与文案「发生过 N 次删除动作」相悖），本组会红。
    //   ⚠️ commit_ref 是 sys_issue_dev_commits 的稳定文本列（DDL :866），delete-commit 事件的 payload_json
    //     里也带 commit_ref（端点 :6075）；本组用直连 SQL 复刻两轮"加同 ref → 删"的落库效果（同 [5] 手法：
    //     构造端到端不可达的删光态，非绕过被测逻辑——被测的是 N 计数，不是删除端点的闸）。
    {
      const SAME_REF = 'c9-317-same-ref-v1';
      const id5b = await seedToVerify({ type: 'feature', withCommit: true });
      const c0 = await get(`SELECT id, dev_assignee_id FROM sys_issue_dev_commits WHERE issue_id=?`, [id5b]);
      // 第一轮：把种子 commit 的 ref 改成 SAME_REF（模拟"提交了这个 ref"）→ 删 → 记 delete 事件（payload 带同 ref）
      await run(`UPDATE sys_issue_dev_commits SET commit_ref = ? WHERE id = ?`, [SAME_REF, c0.id]);
      await run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [c0.id]);
      await run(
        `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, payload_json, created_at)
         VALUES (?, ?, 'delete-commit', 1, ?, ?, datetime('now','localtime'))`,
        [id5b, c0.dev_assignee_id, 'C9-5b 第一次删（填错）', JSON.stringify({ commit_ref: SAME_REF })]
      );
      // 第二轮：用**同一个 ref** 重新提交（新行，新 id）→ 再删 → 再记 delete 事件（payload 仍是同 ref）
      const reAdd = await run(
        `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
         VALUES (?, ?, ?, 'backend', ?, datetime('now','localtime'))`,
        [id5b, c0.dev_assignee_id, 5, SAME_REF]
      );
      await run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [reAdd.lastID]);
      await run(
        `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, payload_json, created_at)
         VALUES (?, ?, 'delete-commit', 1, ?, ?, datetime('now','localtime'))`,
        [id5b, c0.dev_assignee_id, 'C9-5b 第二次删（同 ref 重填又删）', JSON.stringify({ commit_ref: SAME_REF })]
      );
      // 前置自证：两条 delete 事件的 commit_ref **是同一个**（否则本组测的就不是"同 ref 重删"）
      assert.strictEqual(Number((await commitCount(id5b)).c), 0, '[5b-前置] 两轮加删后表内零 commit 行');
      const delRows = await all(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='delete-commit' ORDER BY id`, [id5b]);
      assert.strictEqual(delRows.length, 2, '[5b-前置] 恰 2 条 delete-commit 事件');
      const refs = delRows.map(x => { try { return JSON.parse(x.payload_json).commit_ref; } catch { return null; } });
      assert.deepStrictEqual(refs, [SAME_REF, SAME_REF], `[5b-前置] ⭐ 两条删除事件的 commit_ref 必须是**同一个** ${SAME_REF}（证明这确是"同 ref 反复删"而非两个不同 commit），实得 ${JSON.stringify(refs)}`);
      const distinctRefs = new Set(refs.filter(Boolean)).size;
      assert.strictEqual(distinctRefs, 1, `[5b-前置] 去重后唯一 ref 数=1（与 N=2 形成对比：这正是"动作次数≠唯一 commit 数"的两个量）`);
      const r5b = await call('POST', `/api/sys-issues/${id5b}/accept`, adminTok, {});
      assert.strictEqual(r5b.status, 200, `[5b] accept 期望 200, got ${r5b.status} ${JSON.stringify(r5b.body)}`);
      assert.strictEqual(r5b.body.status, '已上线', '[5b] 同 ref 反复删的单同样允许直翻');
      assert.strictEqual(r5b.body.deleted_commit_count, 2,
        `[5b] ⭐⭐ N **精确=2**（删除动作次数），而**不是** 1（若按 commit_ref 去重就会是 1）——坐实当前语义是"动作次数"非"唯一 commit 数"，实得 ${r5b.body.deleted_commit_count}`);
      const acc5b = (await tlOf(id5b)).filter(t => t.action_code === 'accept');
      assert.ok(/该单曾发生过 2 次删除提交动作/.test(acc5b[0].summary),
        `[5b] ⭐ timeline 文案「发生过 2 次删除提交动作」与 N=2 一致（不写"2 条提交"——两次删的是同一个 ref），实得 ${acc5b[0].summary}`);
      ok('[5b] ⭐⭐ [C9 对抗审 317·M2] 同一 commit ref「提交→删→同 ref 重提→再删」→ N=2（非去重后的 1）+ 文案「发生过 2 次删除提交动作」——坐实 N 语义=删除动作次数，非唯一 commit 数（改成按 ref DISTINCT 计数会在本组红）');
    }
  }

  // ═══ [6] 并发竞态：验收通过 vs 补 commit —— CAS 抢一 ═══
  {
    const id = await seedToVerify({ type: 'feature' });
    // 两个写路径同时发起：accept（会直翻）与补 commit（要求单据仍在 DEV∪VERIFY 族）。
    //   两者都在 sysBeginImmediate 的同一把写锁下串行化 ⇒ 必然一先一后，后到的那个撞前一个留下的状态。
    //   合法终局只有两种（**不允许**两个都成功——那会造出"已上线单却有 commit"的矛盾态）：
    //     A. accept 先：单据翻已上线 → 补 commit 撞族门 409
    //     B. 补 commit 先：单据有了 active commit → accept 不再满足条件① → 落「待上线」（非 409，是走既有路径）
    // ⭐⭐ [C9-fix L3 前置修复·本次实测发现] 夹具必须先把在册实例置成 `code_submitted`，否则**本组是假的**：
    //   `POST /dev/commits` 有守卫④「actor 当前在册实例 dev_status 必须='code_submitted'」（index.js:5907，
    //   400 INVALID_STATUS）。seedToVerify 走 mode:'no_code' 交付 ⇒ 实例恒为 'no_code' ⇒ 那个补 commit 请求
    //   **无论抢没抢到写锁都不可能返回 200**，于是：
    //     · caseB（要求 rCommit===200）**结构性不可达**——"两种合法终局"这个声称在原夹具下是假的，本组实际
    //       只验证过 caseA；handover 里"CI 偶现 B 属正常"的说法同样站不住（B 在任何机器上都不会出现）。
    //     · 更糟：若补 commit 请求恰好先拿到写锁，它返回的是 **400**（非 409），caseA 与 caseB 同时为假 →
    //       本组**红灯**。也就是说原写法是一颗顺序依赖的哑弹，本地靠"accept 请求先写出去"侥幸恒绿。
    //   置 code_submitted 用直连 SQL（同 [5] 组"端到端不可达的状态用 SQL 如实构造"的既定手法）——
    //   注意这不是绕过被测代码：被测的是 C9 的准入条件①与并发封闭，不是 submit 端点怎么给实例打状态。
    //   置完之后两条路径**都是合法可执行**的，A/B 才真的各有可能，矛盾态不变量也才真的在两种终局上都被检验。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted' WHERE issue_id=? AND removed_at IS NULL`, [id]);
    assert.strictEqual(Number((await commitCount(id)).c), 0, '[6-前置] 仍是零 commit（准入条件①满足）——只改了实例状态，没有凭空造出 commit 行');
    const [rAcc, rCommit] = await Promise.all([
      call('POST', `/api/sys-issues/${id}/accept`, adminTok, {}),
      call('POST', `/api/sys-issues/${id}/dev/commits`, devTok, { component: 'backend', commit_ref: 'race-ref' }),
    ]);
    const row = await issueRow(id);
    const cCount = Number((await commitCount(id)).c);
    // 夹具自证：补 commit 请求不得因"实例状态不对"被 400 挡在门外——那说明上面的前置 UPDATE 没生效，
    //   本组会退化回"caseB 不可达"的假覆盖（[[feedback_probe_test_bidirectional_proof]]：先证探针真的能测到东西）。
    assert.notStrictEqual(rCommit.status, 400,
      `[6-前置] 补 commit 不应被守卫④(dev_status≠code_submitted) 400 挡下——那意味着 caseB 结构性不可达、本组退化为只测 caseA，实得 ${rCommit.status}/${JSON.stringify(rCommit.body)}`);
    const caseA = rAcc.status === 200 && row.status === '已上线' && rCommit.status === 409 && cCount === 0;
    const caseB = rAcc.status === 200 && row.status === '待上线' && rCommit.status === 200 && cCount === 1;
    assert.ok(caseA || caseB,
      `[6] ⭐ 并发终局必须落在两种合法组合之一，实得 accept=${rAcc.status}/${JSON.stringify(rAcc.body)} commit=${rCommit.status}/${JSON.stringify(rCommit.body)} status=${row.status} commitCount=${cCount}`);
    // 无论哪种终局，「已上线 ∧ 有 commit」这个矛盾态都不允许出现——这是本组真正要钉死的不变量
    assert.ok(!(row.status === '已上线' && cCount > 0),
      `[6] ⭐⭐ 矛盾态不变量：不得出现「已上线 ∧ active commit>0」，实得 status=${row.status} commitCount=${cCount}`);
    assert.ok(!(row.status === '已上线' && row.online_source === null),
      `[6] 若落已上线则 online_source 必非空（三写同一条 UPDATE，不存在只翻牌不写来源的中间态）`);
    // ⭐ [C9-fix2·316-B 第 7 项·标题写实] 本组证明的是**写锁串行化 + 两合法终局互斥**，不是"CAS 抢一"。
    //   区别要紧：单连接 sqlite3 + BEGIN IMMEDIATE 下，两个请求根本不会并行进入写事务——它们被写锁排成
    //   先后，后到者读到的是前者已提交的状态，于是各自走到自己那条合法分支。真正被本组钉死的是
    //   "两条路径不会同时成功"（矛盾态不出现），而不是"某个 CAS 在竞争中赢了"。
    //   ⚠️ 引擎主 UPDATE 上那道 `changes !== 1` 的 CAS 分支因此是**防御性的——在当前形态下结构性不可达**
    //     （BEGIN IMMEDIATE 持写锁期间，读到的 status 与 CAS 条件里的 status 之间不可能被第三方插入改写）。
    //   ⭐⭐ [C7-fix3 L1·表述订正] 上一版写「该假设在**多进程/多连接部署**下失效」——**这句是错的**：
    //     SQLite 的 BEGIN IMMEDIATE 写锁是**文件级、跨进程生效**的（锁落在数据库文件上，由所有打开该文件
    //     的连接共同遵守），并不是"只在同一个 Node 进程内有效"的应用级互斥。多开几个进程/连接并不会让
    //     这条串行化假设失效——它们照样在同一把文件锁上排队。把它写成"多进程即失效"会误导后人以为
    //     "上多实例就必须重做并发防护"，方向反了（[[feedback_verify_absolute_claims]]：机制类断言落笔前要
    //     回真相源核，不能凭"多进程=更危险"的直觉推）。
    //     ⭐⭐ [316-R2 二次订正] 上一版把"失效条件"写成「别的连接不走 IMMEDIATE 直接写」——**也是错的**：
    //     SQLite 的写锁由**数据库强制**，别的连接哪怕不显式开事务，其写语句同样要取锁、同样穿不透当前
    //     连接持有的写锁——锁不是靠各写入口"自觉遵守协议"，而是文件锁层面强制的。
    //     **真正能让「读到的 status 到 CAS 之间被改写」发生的情形**：
    //       · **同一事务连接上的旁路语句**——事务内代码自己在读与 CAS 之间又改了该行（应用逻辑缺陷）；
    //       · **事务边界被提前释放**——读后先 COMMIT/ROLLBACK 再继续按旧读数写（锁已放、别人可插入）；
    //       · 绕过 SQLite 锁协议的文件级替换/外部工具直改 db 文件；
    //       · 迁移到其他数据库后**未提供等价隔离保证**（C/S 库≠必失效，是"需按其隔离级别重新验证"）。
    //     出现这些形态时该 CAS 就是真防线。
    //   本条按与「条件④结构性不可达」同一范式**登记而不 stub**：不为了让它"被覆盖"去伪造一条走不到的
    //     路径，如实写下"为什么现在测不到"和"什么时候会变得可测"（[[feedback_probe_test_bidirectional_proof]] 的边界情形）。
    ok(`[6] ⭐ 并发提交（accept 直翻 vs 补 commit）：证明**写锁串行化 + 两合法终局互斥**——终局落在「${caseA ? 'A=accept 先·commit 撞 409' : 'B=commit 先·accept 退回待上线'}」，「已上线∧有 commit」矛盾态未出现（CAS changes!==1 分支=防御性·BEGIN IMMEDIATE 文件级写锁下结构性不可达；失效形态=同连接旁路语句/事务边界提前释放/绕过锁协议的文件直改/迁库后隔离未重验证，**非**"多进程部署"亦**非**"别的连接不走 IMMEDIATE"，见组内两次订正）`);

    // ═══ [6b] ⭐ [C9-fix L3] caseB **直接构造**：不靠并发抽签，确定性地把"commit 先落地"这一终局跑一遍 ═══
    //   ⚠️ 为什么必须补：上面的 [6] 接受 A/B 两种合法终局，而**本地实测恒落 A**（accept 先拿到写锁）——
    //     也就是说 caseB 那条判定路径在本机从来没被真正执行过，它的正确性一直只是"如果发生了应该是这样"
    //     的纸面声称。CI 上偶现 B 不算覆盖：一条只在别人机器上偶尔跑到的分支，等于没有回归保护。
    //     这里把并发拆成**顺序执行**（先补 commit、再 accept），同一段被测逻辑（evaluateNoCommitDirectOnline
    //     的条件① active commit 计数）在确定性条件下走一遍 B 分支。并发组保留不动——两者测的东西不同：
    //     [6] 测"两个写路径不会同时成功"，[6b] 测"B 终局本身的落库形态正确"。
    {
      const id = await seedToVerify({ type: 'feature' });
      assert.strictEqual(Number((await commitCount(id)).c), 0, '[6b-前置] 起点零 commit（否则测的就不是"从可直翻变成不可直翻"这个转折）');
      // 同 [6] 前置：置在册实例为 code_submitted，否则补 commit 会被守卫④ 400 挡下（详见 [6] 处论证）
      await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted' WHERE issue_id=? AND removed_at IS NULL`, [id]);
      // 先补 commit（待验证态属 VERIFY 族，补 commit 入口的族门放行）
      const rc = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok, { component: 'backend', commit_ref: 'c9-6b-commit-first' });
      assert.strictEqual(rc.status, 200, `[6b] 待验证态补 commit 应 200, got ${rc.status} ${JSON.stringify(rc.body)}`);
      assert.strictEqual(Number((await commitCount(id)).c), 1, '[6b] commit 已落地（准入条件①自此不再满足）');
      // 再 accept —— 条件①已被破坏 ⇒ 走既有路径落「待上线」，而不是直翻
      const ra = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(ra.status, 200, `[6b] accept 应 200（非 409——"有 commit"是走另一条正常路径，不是错误）, got ${ra.status} ${JSON.stringify(ra.body)}`);
      assert.strictEqual(ra.body.status, '待上线', `[6b] ⭐ caseB 终局：commit 先落地 → accept 不直翻，落「待上线」，实得 ${ra.body.status}`);
      assert.ok(!('online_source' in ra.body), '[6b] caseB 响应体不带 online_source 键（走的是非直翻路径）');
      const row6b = await issueRow(id);
      assert.strictEqual(row6b.status, '待上线', '[6b] 落库 待上线');
      assert.strictEqual(row6b.online_source, null, '[6b] online_source 未写');
      assert.strictEqual(row6b.released_at, null, '[6b] released_at 未写');
      assert.strictEqual(Number((await commitCount(id)).c), 1, '[6b] commit 行仍在（accept 不动 commit）');
      ok('[6b] ⭐ [C9-fix L3] caseB 确定性构造（先补 commit 再 accept）：不直翻、落「待上线」、online_source/released_at 均未写——补上并发组因本地恒落 A 而从未真正执行过的那条分支');
    }
  }

  // ═══ [7] DTO 三分支各现形 ═══
  {
    // ① release_publish：真走批次发布
    const idPub = await seedToVerify({ type: 'feature', withCommit: true });
    await call('POST', `/api/sys-issues/${idPub}/accept`, adminTok, {});
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-7 发布批次' });
    const relId = relR.body.id;
    let r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [idPub] });
    assert.strictEqual(r.status, 200, `[7-①前置] 加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [idPub]);
    await run(`UPDATE sys_releases SET status='已发布' WHERE id=?`, [relId]);
    // ② no_commit_acceptance：免上线直翻
    const idNoCommit = await seedToVerify({ type: 'feature' });
    await call('POST', `/api/sys-issues/${idNoCommit}/accept`, adminTok, {});
    // ③ unknown_legacy：存量历史（已上线 ∧ 无批次关联 ∧ online_source 空）——直连 SQL 造，模拟早期版本遗留
    const idLegacy = await seedToVerify({ type: 'feature' });
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'), release_id=NULL, online_source=NULL WHERE id=?`, [idLegacy]);

    for (const [label, id, expect] of [
      ['release_publish', idPub, 'release_publish'],
      ['no_commit_acceptance', idNoCommit, 'no_commit_acceptance'],
      ['unknown_legacy', idLegacy, 'unknown_legacy'],
    ]) {
      const d = await call('GET', `/api/sys-issues/${id}`, adminTok);
      assert.strictEqual(d.status, 200, `[7-${label}] 详情 200`);
      assert.strictEqual(d.body.issue.online_source_kind, expect, `[7-${label}] 详情 DTO online_source_kind 应为 ${expect}，实得 ${d.body.issue.online_source_kind}`);
    }
    // ⭐⭐ [C9-fix2·316-B 第 8 项] 两条路径的 **online_source 物理列原始值**断言——只断派生出来的 kind 是
    //   不够的：kind 是 deriveOnlineSourceKind 的输出，而该函数的 ① 分支（release_id 非空）会**先于**列值
    //   认领 release_publish。也就是说"批次发布单的 kind 正确"这件事，在物理列被脏值污染时同样成立
    //   （被 ① 遮住了）。要证明"两条路径各自写对了列"，必须直接看列。
    //   ⚠️ 写实：本组的 idPub 是**夹具直连 SQL** 推到「已上线」的（见上方 :357 一带），不经
    //     _publishReleaseCoreInTxn，故这里断的是"该列从未被写过 ⇒ IS NULL"。**走真实发布端点**的那条链路
    //     由下方 [M2] 回归链断言（那里才验 C9-fix2 M2 给发布 UPDATE 追加的 online_source=NULL 双保险）。
    const pubRaw = await get('SELECT online_source, release_id FROM sys_issues WHERE id=?', [idPub]);
    assert.strictEqual(pubRaw.online_source, null,
      `[7-raw] ⭐ **批次发布形态**的 online_source 物理列 IS NULL（该列只由 C9 直翻分支写，批次路径一个字不碰），实得 ${JSON.stringify(pubRaw.online_source)}`);
    assert.ok(pubRaw.release_id != null, '[7-raw] 批次发布单 release_id 非空（kind=release_publish 的事实依据）');
    const flipRaw = await get('SELECT online_source, release_id FROM sys_issues WHERE id=?', [idNoCommit]);
    assert.strictEqual(flipRaw.online_source, 'no_commit_acceptance',
      `[7-raw] ⭐ **直翻路径**的 online_source 物理列必须精确等于 'no_commit_acceptance'（不是"某个非空值"——M1 起 derive 按严格等值判定），实得 ${JSON.stringify(flipRaw.online_source)}`);
    assert.strictEqual(flipRaw.release_id, null, '[7-raw] 直翻单 release_id 为 NULL（H2-a 同事务置空）');
    ok('[7] ⭐ DTO 三分支各现形 + **物理列原始值**双断（批次发布 online_source IS NULL / 直翻 ==="no_commit_acceptance"）——不只看派生 kind，避免 ① 分支遮蔽掩盖脏列（316-B 第8项）');

    // [9] 读点分支：列表 DTO 与详情 DTO **同源派生**（同一个 deriveOnlineSourceKind）
    const listR = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(listR.status, 200, '[9] 列表 200');
    for (const [label, id, expect] of [['release_publish', idPub, 'release_publish'], ['no_commit_acceptance', idNoCommit, 'no_commit_acceptance'], ['unknown_legacy', idLegacy, 'unknown_legacy']]) {
      const item = listR.body.items.find(x => x.id === id);
      assert.ok(item, `[9-${label}] 列表应含 #${id}`);
      assert.strictEqual(item.online_source_kind, expect, `[9-${label}] 列表 DTO 与详情 DTO 必须同值（同一派生函数，不是两份判据），实得 ${item.online_source_kind}`);
    }
    // 非「已上线」单恒 null——不是"不适用"要用占位串表达
    const idOpen = await seedToVerify({ type: 'feature' });
    const openItem = (await call('GET', '/api/sys-issues', adminTok)).body.items.find(x => x.id === idOpen);
    assert.strictEqual(openItem.online_source_kind, null, `[9] 非已上线单 online_source_kind 恒 null，实得 ${openItem.online_source_kind}`);
    ok('[9] ⭐ 读点分支：列表 DTO 与详情 DTO 三分支逐条同值（同源 deriveOnlineSourceKind，非两份判据）+ 非已上线单恒 null');
  }

  // ═══ [8] 守卫负例：NO_COMMIT_ONLINE 之外的边进「已上线」被拒 ═══
  {
    const SG = require('../routes/sys-iteration/status-transition-guard');
    // ⭐⭐ [C9-fix2·316-B 第 2 项] 四负例由 `assert.throws(fn, /消息正则/)` 升级为**逐个捕获 + 三项精确断言**
    //   （httpStatus / code / 消息片段）。原写法只匹配消息：
    //     · 抛出的若是别的类型的错误（TypeError、别处的 409、甚至 500），只要消息里碰巧含那个词就算通过；
    //     · httpStatus 与 code 这两个**契约面**从未被断过——守卫的 409 形状层 / 400 门禁层分层若被改坏，
    //       四负例照绿（[8f] 只对门禁层断了这两项，形状层没有）。
    //   现在每条都断死"是 MainStatusGuardError ∧ 409 ∧ GATE_INVARIANT ∧ 消息指向正确的拒绝理由"。
    const expectGuardReject = (params, tag, msgRe, expectHttp = 409, expectCode = 'GATE_INVARIANT') => {
      let err = null;
      try { SG.assertMainStatusTransition(params); } catch (e) { err = e; }
      assert.ok(err, `${tag} 必须抛出（放行=防线失效）`);
      assert.strictEqual(err.httpStatus, expectHttp, `${tag} httpStatus 应为 ${expectHttp}（形状类拒绝=409，与门禁类 400 分层），实得 ${err.httpStatus}`);
      assert.strictEqual(err.code, expectCode, `${tag} code 应为 ${expectCode}，实得 ${err.code}`);
      assert.ok(msgRe.test(err.message), `${tag} 消息应指向正确的拒绝理由（${msgRe}），实得 ${err.message}`);
      return err;
    };
    const GUARD_OK = { actionKind: null, issueType: 'feature', rosterActiveCount: 1, rosterAllComplete: true };
    // ① ADMIN_TRANSITION 仍不得直写已上线（C9 未放宽既有分支——这是选项 A 相对"放宽 ADMIN_TRANSITION"的核心优势）
    expectGuardReject(
      { routeKind: 'ADMIN_TRANSITION', action: 'accept', before: '待验证', after: '已上线', ...GUARD_OK },
      '[8a]', /不得直写「已上线」/
    );
    ok('[8a] ⭐ 守卫负例：ADMIN_TRANSITION routeKind 直写「已上线」仍被拒（409 GATE_INVARIANT + 消息指向"不得直写"）——C9 走的是新增的 NO_COMMIT_ONLINE，既有分支逐字未放宽');
    // ② NO_COMMIT_ONLINE 只服务 accept 这一条边：换 action 拒
    expectGuardReject(
      { routeKind: 'NO_COMMIT_ONLINE', action: 'close', before: '待验证', after: '已上线', ...GUARD_OK },
      '[8b]', /action 必须固定为 'accept'/
    );
    // ③ NO_COMMIT_ONLINE 只允许 待验证→已上线：换 before 拒
    expectGuardReject(
      { routeKind: 'NO_COMMIT_ONLINE', action: 'accept', before: '待上线', after: '已上线', ...GUARD_OK },
      '[8c]', /边非法：待上线→已上线/
    );
    // ④ NO_COMMIT_ONLINE 不得写别的目标态
    expectGuardReject(
      { routeKind: 'NO_COMMIT_ONLINE', action: 'accept', before: '待验证', after: '待上线', ...GUARD_OK },
      '[8d]', /边非法：待验证→待上线/
    );
    // ⑤ 正例：合法形状放行（防上面四条 throws 是因为函数恒抛而非真判定——[[feedback_probe_test_bidirectional_proof]]）
    const okRes = SG.assertMainStatusTransition({ routeKind: 'NO_COMMIT_ONLINE', action: 'accept', actionKind: null, issueType: 'feature', before: '待验证', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true });
    assert.strictEqual(okRes.afterFamily, 'RELEASE', `[8e] 合法形状应放行且 afterFamily=RELEASE，实得 ${JSON.stringify(okRes)}`);
    assert.ok(SG.ROUTE_KINDS.includes('NO_COMMIT_ONLINE'), '[8e] NO_COMMIT_ONLINE 已登记进 ROUTE_KINDS 白名单');
    ok('[8b-e] ⭐ 守卫形状约束四负例 + 一正例：NO_COMMIT_ONLINE 仅允许 accept×待验证→已上线，换 action/换 before/换 after 各自被拒，合法形状放行（双向证明，非恒抛）');

    // ⑥ ⭐ [C9-fix L4] enteringRelease roster 门对 NO_COMMIT_ONLINE **同等适用**——零在册 → 400（非 409）。
    //   ⚠️ 为什么必须显式测：本 routeKind 的 afterFamily='RELEASE'，会掉进守卫末尾那个
    //     `enteringRelease = afterFamily === 'RELEASE'` 的门。上面 [8b-e] 五格全都传了
    //     `rosterActiveCount: 1, rosterAllComplete: true`（为了让形状校验成为唯一变量），于是这道门
    //     **一次都没被触发过**——"免上线直翻也要守 roster 门"这条声称此前没有任何断言支撑，纯靠读代码推断。
    //   同时钉死**错误码分层**：形状类问题 409 GATE_INVARIANT（上面四负例），门禁类问题 400 GATE_INVARIANT
    //     （方案 §10「进族零在册=400 一例」）——两者 code 相同、HTTP 状态不同，是刻意的分层，不能混。
    let releaseGateErr = null;
    try {
      SG.assertMainStatusTransition({ routeKind: 'NO_COMMIT_ONLINE', action: 'accept', actionKind: null, issueType: 'feature', before: '待验证', after: '已上线', rosterActiveCount: 0, rosterAllComplete: true });
    } catch (e) { releaseGateErr = e; }
    assert.ok(releaseGateErr, '[8f] NO_COMMIT_ONLINE + 零在册必须被 enteringRelease 门拒（免上线不等于免 roster 门）');
    assert.strictEqual(releaseGateErr.httpStatus, 400, `[8f] 门禁类拒绝应为 400（区别于形状类 409），实得 ${releaseGateErr.httpStatus}`);
    assert.strictEqual(releaseGateErr.code, 'GATE_INVARIANT', `[8f] code 应为 GATE_INVARIANT，实得 ${releaseGateErr.code}`);
    assert.ok(/SYS_RELEASE/.test(releaseGateErr.message), `[8f] 应命中「进入发布控制态（SYS_RELEASE）」那一支（而非别的门），实得 ${releaseGateErr.message}`);
    // 配对负例：在册≥1 但有 pending（未全完成）同样被拒——证明门判的是"两个条件"不是只判计数
    let pendingGateErr = null;
    try {
      SG.assertMainStatusTransition({ routeKind: 'NO_COMMIT_ONLINE', action: 'accept', actionKind: null, issueType: 'feature', before: '待验证', after: '已上线', rosterActiveCount: 1, rosterAllComplete: false });
    } catch (e) { pendingGateErr = e; }
    assert.ok(pendingGateErr && pendingGateErr.httpStatus === 400 && /SYS_RELEASE/.test(pendingGateErr.message),
      `[8f] NO_COMMIT_ONLINE + 在册含 pending 同样应 400 命中 SYS_RELEASE 门，实得 ${pendingGateErr && pendingGateErr.httpStatus} ${pendingGateErr && pendingGateErr.message}`);
    ok('[8f] ⭐ [C9-fix L4] enteringRelease roster 门对 NO_COMMIT_ONLINE 同等适用：零在册 / 在册含 pending 各得 400 GATE_INVARIANT 且命中 SYS_RELEASE 分支（免上线不免 roster 门 + 400门禁 vs 409形状 的错误码分层钉死）');
  }

  // ═══ [10] ⭐⭐ [C9-fix2 H1 + 316-B 第 1 项] 裁决收归引擎后的**引擎语义测试**（三形态直调引擎入口）═══
  //   ⚠️ 本组**整体重写**：旧版是对 index.js 源码跑正则（`assert.ok(/isNoCommitDirectOnline = .../.test(src))`）。
  //     那种断言的根本问题是**它测的是源码文本不是行为**——把整段防线注释掉、或让它变成永不执行的死代码，
  //     正则照样匹配得上，全绿。C9-fix2 H1 把裁决收归引擎之后，这条防线终于变成**可直接驱动的语义**：
  //     引擎自己产生裁决，调用方递什么都不算数，于是三种输入形态都能真跑一遍。
  //   直调 `_internals.sysIssueTransition`（非 HTTP）是必要的：HTTP 层的 accept 端点已经不传任何 opts
  //     （H1 的成果之一），伪造 opts 这件事在 HTTP 面上根本无从发起——只有直调引擎才能扮演"未来某个内部
  //     新调用点"这个攻击者角色（codex 316 H1 攻击面①正是这么设想的）。
  {
    const adminActor = { id: 1, name: '管理员', role: 'admin' };

    // ── [10a] 形态一：**引擎未产生裁决** ——非 accept 的边 + 钩子硬返「已上线」。
    //   引擎的 [1b] 门只对 accept×待验证 自调 evaluate，故这条边的局部裁决恒为 null；钩子把目标态解析成
    //   「已上线」之后，fail-closed 必须当场 500，而不是静默按 ADMIN_TRANSITION 放它去撞守卫的 409
    //   （那样错误信息会指向"状态机边非法"，掩盖真凶="有人开了一条没做准入判定的进已上线通道"）。
    {
      const id = await seedToVerify({ type: 'feature' });
      await stampSentinelC9(id); // [C7-fix3 M3'] 钉哨兵后再快照（秒级精度下前后相等会假绿）
      const before = await snapC9(id);
      let err = null;
      try {
        await I.sysIssueTransition(id, 'return', null, adminActor, { reason: 'C9-fix2 [10a] 构造：钩子越权返已上线' }, {
          async resolveToStatusInTxn() { return '已上线'; },
        });
      } catch (e) { err = e; }
      assert.ok(err, '[10a] 必须抛出（放行=fail-open，等于任何边都能被钩子送进已上线）');
      assert.strictEqual(err.httpStatus, 500, `[10a] ⭐ 应为 500（服务端不变量破坏，非调用方输入错误——报 4xx 会把内部缺陷说成用户的错），实得 ${err.httpStatus}`);
      assert.strictEqual(err.code, 'DIRECT_ONLINE_VERDICT_MISSING', `[10a] ⭐ 确切码 DIRECT_ONLINE_VERDICT_MISSING，实得 ${err.code}`);
      assert.ok(/引擎未产生裁决/.test(err.message), `[10a] 消息应点明"引擎未产生裁决"（区别于"裁决为 false"那一形态），实得 ${err.message}`);
      await assertNoSideEffectC9(id, before, '[10a]');
      ok('[10a] ⭐ 缺裁决形态一（非 accept 边 + 钩子返「已上线」）→ 500 DIRECT_ONLINE_VERDICT_MISSING「引擎未产生裁决」+ 整事务零副作用——**真跑引擎**，不再是源码正则');
    }

    // ── [10b] 形态二：**伪造 opts 注入**（C9-fix2 H1-e 要求的攻击面负例）。
    //   扮演"未来某个内部调用点"：同时伪造 `opts.directOnlineInfo={directFlip:true}` 与一个返回「已上线」
    //   的钩子，目标单**有 active commit**（准入条件①不满足，真实裁决必为 false）。
    //   H1 之前：引擎信 opts 里的那个对象 ⇒ routeKind 认作 NO_COMMIT_ONLINE ⇒ 守卫放行 ⇒ 越权直翻成功。
    //   H1 之后：opts.directOnlineInfo 这个载体在引擎里**已无任何读点**，引擎信的是自己算出来的 false ⇒ 500。
    {
      const id = await seedToVerify({ type: 'feature', withCommit: true });
      assert.strictEqual(Number((await commitCount(id)).c), 1, '[10b-前置] 目标单有 1 条 active commit ⇒ 引擎自算裁决必为 directFlip=false（伪造值与真实值方向相反，本组才有意义）');
      await stampSentinelC9(id); // [C7-fix3 M3'] 钉哨兵后再快照（秒级精度下前后相等会假绿）
      const before = await snapC9(id);
      let err = null;
      try {
        await I.sysIssueTransition(id, 'accept', null, adminActor, {}, {
          directOnlineInfo: { directFlip: true, deletedCommitCount: 99, blockedBy: null }, // ← 伪造载体（H1 前的攻击向量）
          async resolveToStatusInTxn() { return '已上线'; } // ← 伪造目标态
        });
      } catch (e) { err = e; }
      assert.ok(err, '[10b] ⭐⭐ 伪造 opts 必须无效：放行即意味着任何内部调用点都能绕开准入四条件直翻上线');
      assert.strictEqual(err.httpStatus, 500, `[10b] 应为 500，实得 ${err.httpStatus}`);
      assert.strictEqual(err.code, 'DIRECT_ONLINE_VERDICT_MISSING', `[10b] ⭐ 确切码 DIRECT_ONLINE_VERDICT_MISSING，实得 ${err.code}`);
      assert.ok(/directFlip=false/.test(err.message),
        `[10b] ⭐⭐ 消息里的 directFlip 必须是**引擎自算的 false**，而不是伪造进来的 true——这一条直接证明"引擎不读 opts 里的裁决"，实得 ${err.message}`);
      await assertNoSideEffectC9(id, before, '[10b]');
      assert.strictEqual((await snapC9(id)).row.status, '待验证', '[10b] 单据仍在「待验证」（伪造注入零效果，连状态都没动）');
      ok('[10b] ⭐⭐ [H1-e] 伪造 opts 注入负例（directFlip:true + 钩子返已上线，目标单实有 commit）→ 500 DIRECT_ONLINE_VERDICT_MISSING 且**消息里是引擎自算的 directFlip=false** + 整事务零副作用——调用方自报裁决这条攻击面已封死');
    }

    // ── [10c] 形态三：**正例**——零 commit 单直调引擎，同时塞一个数值离谱的伪造载体。
    //   两件事一起证：① 引擎自调裁决把这条边判成 NO_COMMIT_ONLINE 并真的直翻成功（防线不是恒抛）；
    //   ② 伪造的 deletedCommitCount=99 **一点都没漏进来**（响应/timeline 里的 N 恒为引擎自算的 0）——
    //      成功路径同样不读 opts，不是"失败时才不读"。
    {
      const id = await seedToVerify({ type: 'feature' });
      const r = await I.sysIssueTransition(id, 'accept', null, adminActor, {}, {
        directOnlineInfo: { directFlip: false, deletedCommitCount: 99, blockedBy: 'active_commits' }, // ← 与真实裁决相反的伪造值
      });
      assert.strictEqual(r.toStatus, '已上线', `[10c] ⭐ 引擎自调裁决 → 直翻「已上线」（伪造的 directFlip:false 拦不住它），实得 ${r.toStatus}`);
      assert.ok(r.noCommitOnline, '[10c] 返回值须带引擎裁决只读副本 noCommitOnline（端点拼响应体的唯一数据源）');
      assert.strictEqual(r.noCommitOnline.directFlip, true, '[10c] 副本 directFlip=true');
      assert.strictEqual(r.noCommitOnline.deletedCommitCount, 0,
        `[10c] ⭐⭐ N 必须是引擎自算的 0，而**不是伪造的 99**——成功路径同样不读 opts.directOnlineInfo，实得 ${r.noCommitOnline.deletedCommitCount}`);
      assert.ok(Object.isFrozen(r.noCommitOnline), '[10c] 裁决副本须 Object.freeze（"只读"不止是口头约定，调用方改不了它）');
      const row = await snapC9(id);
      assert.strictEqual(row.row.status, '已上线', '[10c] 落库已上线');
      assert.strictEqual(row.row.online_source, 'no_commit_acceptance', '[10c] 物理列写的是本路径标签');
      const acc = (await tlOf(id)).filter(t => t.action_code === 'accept');
      assert.strictEqual(acc.length, 1, '[10c] accept timeline 恰 1 条');
      assert.ok(!/删除提交动作|已删提交记录/.test(acc[0].summary), `[10c] ⭐ timeline 无删光附记（N=0）——伪造的 99 没能拼进留痕，实得 ${acc[0].summary}`);
      ok('[10c] ⭐⭐ 正例：零 commit 单直调引擎（携伪造 directFlip:false + deletedCommitCount:99）→ 引擎自调裁决照样直翻成功，N 恒为自算的 0、timeline 无附记、裁决副本已 Object.freeze——双向证明防线真在判定而非恒抛');
    }
  }


  // ═══ [11] ⭐ [C9-fix hotfix 负例] 免上线直翻后走 hotfix-publish → 409（第三挂批次入口显式入测）═══
  {
    // [2] 已覆盖"直翻后补 commit"与"直翻后 add-issues 挂批次"两条入口；**hotfix-publish 是第三条**能把
    //   单据塞进批次的入口（它自建批次 + 加单 + 抢占执行，见该端点实现），此前没有任何断言碰过它。
    //   预筛证伪③的反向：不能只因为"直翻单看起来已经终态了"就假定所有入口都自然拒绝——每条入口
    //   各有各的前置判据，必须逐条真跑（[[feedback_pattern_sweep_not_symptom_list]]：入口是模式，不是名单）。
    const id = await seedToVerify({ type: 'bug' });
    let r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, '[11-前置] 直翻成功 200');
    assert.strictEqual((await issueRow(id)).status, '已上线', '[11-前置] 已落已上线');
    await stampSentinelC9(id); // [C7-fix3 M3'] 钉哨兵后再快照（秒级精度下前后相等会假绿）
    const before = await snapC9(id); // [316-B 第6项] 改用统一快照（原为 issueRow 五列，现为六列+三计数）
    // ⚠️ 零副作用用**增量**比对，不用全表绝对值：本文件前面的 [2b]/[7] 组已合法建过批次，断言"全库零批次"
    //   会因为无关组的正常产物而红（一次实测踩到：3 !== 0）。取调用前后差值才是"本次调用没造出东西"。
    const relBefore = Number((await get('SELECT COUNT(*) c FROM sys_releases')).c);
    const exeBefore = Number((await get('SELECT COUNT(*) c FROM sys_release_executors')).c);
    r = await call('POST', `/api/sys-issues/${id}/hotfix-publish`, adminTok, { release_note: 'C9-11 直翻后应急上线尝试', executors: [5] });
    assert.strictEqual(r.status, 409, `[11] 已上线单 hotfix-publish 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ISSUE_NOT_HOTFIXABLE', `[11] 确切码 ISSUE_NOT_HOTFIXABLE，实得 ${r.body.code}`);
    // 零副作用：统一快照逐项深比较 + 没新建批次 + 没新插执行人行
    await assertNoSideEffectC9(id, before, '[11]');
    assert.strictEqual(Number((await get('SELECT COUNT(*) c FROM sys_releases')).c), relBefore, '[11] 零副作用：本次调用未新建批次（hotfix-publish 会自建批次，须在建之前就被拒）');
    assert.strictEqual(Number((await get('SELECT COUNT(*) c FROM sys_release_executors')).c), exeBefore, '[11] 零副作用：本次调用未新插执行人行');
    ok('[11] ⭐ [C9-fix] 硬负例：免上线直翻后走 **hotfix-publish**（第三条挂批次入口）→ 409 ISSUE_NOT_HOTFIXABLE + 零副作用统一快照（单据 6 列/timeline/commit/删除事件逐项未动 + 零批次 + 零执行人行）——补齐 [2] 只覆盖 dev/commits 与 add-issues 两条入口的缺口');
  }

  // ═══ [12] ⭐⭐ [C9-fix2 H2] 悬垂 release_id：可直翻，且直翻写点把悬垂指针**清成 NULL** ═══
  //   写读分裂的具体形态（codex 316 攻击面④）：
  //     · 写侧 evaluateNoCommitDirectOnline 条件② 用 `SELECT 1 FROM sys_releases WHERE id=? AND status IN(...)`，
  //       批次行不存在时查不到 ⇒ 判「无 active 关联」**放行直翻**（有意的容忍）；
  //     · 读侧 deriveOnlineSourceKind ① 分支只看 `release_id != null` ⇒ 一律先认 release_publish。
  //   两者叠加：带悬垂指针的单直翻成功后，页面会把它显示成"批次发布"，真实来源被永久遮蔽。
  //   H2-a 的修法是在直翻写点同事务 `release_id = NULL`。本组正是那条修法的看守。
  {
    const id = await seedToVerify({ type: 'feature' });
    // 造悬垂：指向一个**不存在**的批次 id（取当前最大 id + 9999，确保查无此行）
    const maxRel = await get('SELECT COALESCE(MAX(id),0) m FROM sys_releases');
    const ghostRelId = Number(maxRel.m) + 9999;
    await run(`UPDATE sys_issues SET release_id = ? WHERE id = ?`, [ghostRelId, id]);
    const ghostCheck = await get('SELECT COUNT(*) c FROM sys_releases WHERE id = ?', [ghostRelId]);
    assert.strictEqual(Number(ghostCheck.c), 0, '[12-前置] 该 release_id 确实查无此行（悬垂指针成立；若批次真存在，本组测的就是 [4] 而不是悬垂）');
    assert.strictEqual(Number((await issueRow(id)).release_id), ghostRelId, '[12-前置] 单据确实挂着这个悬垂指针');
    const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[12] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已上线', `[12] ⭐ 悬垂 release_id 不阻断直翻（条件② 的容忍语义保持不变），实得 ${r.body.status}`);
    assert.strictEqual(r.body.online_source, 'no_commit_acceptance', '[12] 响应带 online_source');
    const row = await snapC9(id);
    assert.strictEqual(row.row.release_id, null,
      `[12] ⭐⭐ H2-a 核心：直翻写点同事务把悬垂 release_id **清成 NULL**（否则读侧 ① 分支会把这单显示成"批次发布"），实得 ${JSON.stringify(row.row.release_id)}`);
    assert.strictEqual(row.row.online_source, 'no_commit_acceptance', '[12] 物理列写的是本路径标签');
    assert.ok(row.row.released_at, '[12] released_at 已写');
    // 读侧现形：kind 必须是 no_commit_acceptance 而不是 release_publish
    const d = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(d.body.issue.online_source_kind, 'no_commit_acceptance',
      `[12] ⭐⭐ 读侧派生必须是 no_commit_acceptance——这一条就是"写读分裂已闭合"的直接证据（H2-a 不生效时这里会是 release_publish），实得 ${d.body.issue.online_source_kind}`);
    ok('[12] ⭐⭐ [C9-fix2 H2] 悬垂 release_id 单 accept → 允许直翻（条件②容忍不变）+ 写点同事务清 release_id=NULL + 读侧 kind 现形为 no_commit_acceptance——写读分裂（写侧容忍悬垂/读侧一律认批次）已闭合');
  }

  // ═══ [13] ⭐ [C9-fix2 M1] online_source 脏值 → unknown_legacy（不伪装成免上线）═══
  //   本列**无 DDL CHECK**（三条理由见 index.js:1634 一带），直连 SQL / 迁移脚本能写进任意字符串。
  //   改前判据 `!= null && !== ''` 会把任何非空值折叠成 no_commit_acceptance——**把不认识的东西说成认识的**，
  //   比报 unknown 更坏（给出的是看起来确定的错误答案）。M1 收紧为严格等值后，脏值应落 unknown_legacy。
  {
    const id = await seedToVerify({ type: 'feature' });
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'), release_id=NULL, online_source='garbage' WHERE id=?`, [id]);
    const raw = await get('SELECT online_source FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(raw.online_source, 'garbage', '[13-前置] 脏值确已落库（本列无 CHECK，直连 SQL 写得进去——这正是 M1 要防的现实面）');
    const d = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(d.status, 200, '[13] 详情 200');
    assert.strictEqual(d.body.issue.online_source_kind, 'unknown_legacy',
      `[13] ⭐ 脏值 'garbage' 必须落 unknown_legacy（**不是** no_commit_acceptance——非空≠本路径写的），实得 ${d.body.issue.online_source_kind}`);
    const listItem = (await call('GET', '/api/sys-issues', adminTok)).body.items.find(x => x.id === id);
    assert.strictEqual(listItem.online_source_kind, 'unknown_legacy', '[13] 列表 DTO 同值（同源 deriveOnlineSourceKind）');
    // 配对正例：把脏值改成正确字面量 → 立刻回到 no_commit_acceptance（证明判据是"等值"而非"恒 unknown"）
    await run(`UPDATE sys_issues SET online_source='no_commit_acceptance' WHERE id=?`, [id]);
    const d2 = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(d2.body.issue.online_source_kind, 'no_commit_acceptance',
      `[13] 配对正例：列值改成精确字面量后回到 no_commit_acceptance（双向证明：不是把所有值都判成 unknown），实得 ${d2.body.issue.online_source_kind}`);
    ok('[13] ⭐ [C9-fix2 M1] online_source 严格等值：脏值 \'garbage\' → unknown_legacy（详情/列表同值）；改回精确字面量 → no_commit_acceptance——双向证明，非空值不再被折叠成免上线');
  }

  // ═══ [14] ⭐⭐ [C9-fix2 M2] online_source 生命周期回归链：直翻 → reopen 清列 → 批次发布 ═══
  //   一条链把 M2 两处改动串起来验：
  //     ① 直翻 → 列=no_commit_acceptance
  //     ② reopen → 列被清成 NULL（新一轮不继承上一轮"怎么上线的"）
  //     ③ 补 commit 走**真实批次发布端点** → kind=release_publish ∧ 物理列 IS NULL（发布 UPDATE 的双保险）
  //   缺 ② 的后果：重开后若这一轮以 release_id 为空的方式落已上线，陈旧标签会把它冒名成"免上线直翻"。
  {
    const id = await seedToVerify({ type: 'feature' });
    // ① 直翻
    let r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, '[14-①] 直翻 200');
    let row = await snapC9(id);
    assert.strictEqual(row.row.status, '已上线', '[14-①] 已上线');
    assert.strictEqual(row.row.online_source, 'no_commit_acceptance', '[14-①] 列已写本路径标签');
    // ② 归档后 reopen（reopen 的 from 已收窄为仅「已关闭」，故先 close）
    r = await call('POST', `/api/sys-issues/${id}/close`, adminTok, { reason: 'C9-fix2 [14] 归档以便重开' });
    assert.strictEqual(r.status, 200, `[14-②前置] close 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: 'C9-fix2 [14] 重开新一轮' });
    assert.strictEqual(r.status, 200, `[14-②] reopen 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await snapC9(id);
    assert.strictEqual(row.row.online_source, null,
      `[14-②] ⭐⭐ M2 核心：reopen 必须把 online_source 清成 NULL（与相邻的 released_at/release_id 同属"上线事实三件套"，那两件本就在清，本列是漏网的第三件），实得 ${JSON.stringify(row.row.online_source)}`);
    assert.strictEqual(row.row.released_at, null, '[14-②] released_at 同批清（既有行为，回归看守）');
    assert.strictEqual(row.row.release_id, null, '[14-②] release_id 同批清（既有行为）');
    assert.strictEqual(Number(row.row.reopen_count), 1, '[14-②] reopen_count++');
    // 重开后单据在「开发中」，kind 恒 null（非已上线单不派生来源）
    const dMid = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(dMid.body.issue.online_source_kind, null, '[14-②] 非已上线单 online_source_kind 恒 null');
    // ③ 这一轮走**真实批次发布**：带 commit 的 submit → accept（落待上线）→ 建批次加单 → publish
    //   ⚠️ reopen **不重置花名册**（同 return 语义，见 verify-sys-multidev-members S10g）——上一轮 submit 已把
    //     在册实例推成 no_code，直接再 submit 会撞 409 INVALID_STATUS「已提交过或状态已变」（首版实测撞到，
    //     属**夹具写错**非实现错）。正规重置手法是"临时加协作解除 LAST_ASSIGNEE 限制 → remove → re-add"，
    //     但本组聚焦 online_source 生命周期而非 roster 机制（后者已有 verify-sys-multidev-* 全覆盖），
    //     故直连 SQL 重置回 pending——同 verify-sys-effort-c7 [10c] 的既定取舍，只动本组不关注的 roster 字段。
    //   ⚠️ 不单独调 /dev/commits：submit 的 mode:'commits' 自己就会写 commit 行（seedToVerify 同款），
    //     多走一步反而要先把实例置成 code_submitted，与紧接着的 submit 前置态互斥。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending', resolved_at=NULL, no_code_reason=NULL WHERE issue_id=? AND removed_at IS NULL`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `[14-③前置] estimate 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9fix2-14-submit' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `[14-③前置] submit 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[14-③前置] 回到待验证');
    r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[14-③前置] accept 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[14-③前置] ⭐ 这一轮有 commit ⇒ 不直翻，落「待上线」（也证明 reopen 清列没把单据带回直翻路径），实得 ${r.body.status}`);
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'C9-fix2 [14] 发布批次' });
    assert.strictEqual(relR.status, 201, '[14-③前置] 建批次 201');
    const relId = relR.body.id;
    r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [id] });
    assert.strictEqual(r.status, 200, `[14-③前置] 加单 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // ⚠️ `/publish` 端点已下线（409 LEGACY_RELEASE_FLOW_DISABLED，首版实测撞到=**夹具用了退场入口**）。
    //   现行唯一发布链路 = PUT 执行人 → 行级通知（notify_status='sent'）→ 执行人本人 POST /execute。
    //   本组要的是"真跑一遍 _publishReleaseCoreInTxn"，故必须走这条真链路（同 verify-sys-release.js 的
    //   publishRelease helper 范式；通知位直连 SQL 置 sent，避免触发真实钉钉外呼）。
    r = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, `[14-③前置] 安排执行人 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
    const exRow = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
    assert.ok(exRow, '[14-③前置] 执行人行已建');
    r = await call('POST', `/api/sys-releases/${relId}/execute`, devTok, { release_note: 'C9-fix2 [14] 走真实批次发布', executor_row_id: exRow.id });
    assert.strictEqual(r.status, 200, `[14-③] execute 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.released, true, `[14-③] 单人执行人 ⇒ 本次执行即触发发布（released=true），实得 ${JSON.stringify(r.body)}`);
    row = await snapC9(id);
    assert.strictEqual(row.row.status, '已上线', '[14-③] 经批次发布落已上线');
    assert.strictEqual(row.row.release_id, relId, '[14-③] release_id 指向本批次');
    assert.strictEqual(row.row.online_source, null,
      `[14-③] ⭐⭐ M2 双保险：**走真实 _publishReleaseCoreInTxn 的发布 UPDATE** 后 online_source 物理列 IS NULL（不是靠"从没写过"推出来的，是这条链路真跑了一遍），实得 ${JSON.stringify(row.row.online_source)}`);
    const dEnd = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(dEnd.body.issue.online_source_kind, 'release_publish',
      `[14-③] ⭐ 读侧 kind=release_publish（上一轮的免上线标签没有跨轮冒名），实得 ${dEnd.body.issue.online_source_kind}`);
    ok('[14] ⭐⭐ [C9-fix2 M2] online_source 生命周期回归链：直翻(列=no_commit_acceptance) → close→reopen(列清 NULL + released_at/release_id 同清 + reopen_count=1) → 补 commit 走**真实批次发布端点**(kind=release_publish ∧ 物理列 IS NULL) ——两处 M2 改动各被真链路走过一遍，跨轮陈旧标签冒名已堵');
  }

  console.log(`\n✅ verify-sys-c9-direct-online 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
