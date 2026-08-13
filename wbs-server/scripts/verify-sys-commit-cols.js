// scripts/verify-sys-commit-cols.js — C1 验收：列表端点 frontend/backend commit 编码聚合两列
//   SSOT = 锚点 docs/local/系统迭代/任务_commit号两列_20260803.md §3（D3/D4）
//   用法：node scripts/verify-sys-commit-cols.js
//
// 覆盖 C1 契约七条：
//   [A1] 字段存在且值协议 = 合法 JSON 数组字符串（非分隔符拼接明文）
//   [A2] 零命中 → '[]'（非 NULL / 非空串）——SQLite json_group_array 空集特例，前端 JSON.parse 才不炸
//   [A3] 前后端分组不串（component 精确分流）
//   [A4] 顺序 = id ASC（录入顺序，与发布快照 snapshotReleaseCommitsInTxn 同源）
//   [A5] ⭐ commit_ref 含分号时内容不被破坏——D4 的核心防线：若改用 GROUP_CONCAT(';') 拼接，
//        本条必红（同 89 号审 dev_roster_names 人名含逗号被 split 错拆的同款坑）
//   [A6] 成员已 removed（removed_at 非空）其 commit 仍出现——与快照 §8「含 removed 实例」同口径
//   [A7] 多单据互不串（子查询按 issue_id 正确隔离）
//
// [Y] 件②（2026-08-12）commit 记录展示层去重——后端契约 + 前端实现 双向验证：
//   [Y1] 后端聚合查询源码不含去重关键字（DISTINCT/GROUP BY）——raw 层必须保留跨轮重复
//   [Y2] 前端 siNormalizeCommitRefs 真实具备保序首现去重能力（直接 eval 页面源码里的函数体调用）
//   [Y3] 对照组：证明 [Y1]/[Y2] 判据不是恒真——分别构造"注入了去重关键字的假源码"与
//        "改动前未去重的旧实现"，证明两条判据在这些反例上确实会判红
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-commit-cols-secret';
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

async function mkIssue(title) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('bug', '处理中', ?, 'BMS', '内部', 1, '管理员')`, [title]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, removedAt = null) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, removed_at)
     VALUES (?, ?, ?, 0, 'pending', ?)`, [issueId, userId, userName, removedAt]
  );
  return r.lastID;
}
async function seedCommit(issueId, daId, userId, component, ref) {
  const r = await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`, [issueId, daId, userId, component, ref]
  );
  return r.lastID;
}
// 从列表响应里取指定单据行
function rowOf(items, issueId) {
  const row = items.find(x => x.id === issueId);
  assert.ok(row, `列表里应能取到 issue #${issueId}`);
  return row;
}
// 解析并断言"是合法 JSON 数组"——顺带就是 A1 的判据
function parseArr(val, label) {
  assert.strictEqual(typeof val, 'string', `${label} 应为字符串（JSON 数组字符串协议），实际 ${typeof val}`);
  let arr;
  try { arr = JSON.parse(val); } catch (e) { assert.fail(`${label} 不是合法 JSON：${JSON.stringify(val)}`); }
  assert.ok(Array.isArray(arr), `${label} JSON.parse 后应为数组，实际 ${JSON.stringify(arr)}`);
  return arr;
}

(async () => {
  mod.initSchema();   // ⚠️ 必须显式调用（index.js:400 注释：server.js 启动 db 回调内调用）——漏了则 serialize
                      //    末条 DDL 的 callback 永不触发 runSysMigration，readiness 永久 false 且 error 为 null
  await waitReady();

  // ⭐ codex 审 C1 MED-1 收口（断言永远成立的假绿）：A4「顺序 = 录入顺序」原先只是插入两条后断言返回序，
  //   但 SQLite 在当前 rowid 访问路径下，**即使删掉内层 ORDER BY id ASC 也仍会按 rowid 升序返回** ——
  //   那条断言恒真、测不住"必须显式排序"这个裁定。两道防线补齐：
  //   ① 行为化：reverse_unordered_selects=ON 让**无 ORDER BY 的查询故意逆序返回**，删排序即 A4 必红；
  //      （不影响本用例其余断言：主查询自带 ORDER BY id DESC、内层子查询自带 ORDER BY id ASC，均有序）
  //   ② 合同锁：见下方 [A4-static]，直接读源码断言两个子查询都写了 ORDER BY id ASC。
  await run('PRAGMA reverse_unordered_selects = ON');
  ok('[前置] PRAGMA reverse_unordered_selects=ON —— 无序查询将逆序返回，使隐式顺序依赖暴露为红灯');
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', () => { port = server.address().port; res(); }); });
  console.log('  ✓ readiness ready + HTTP harness 起服务');

  // ── 夹具 ────────────────────────────────────────────────────────────
  // #1 正常单：前端 2 条 + 后端 1 条（含顺序与分流判据）
  const i1 = await mkIssue('C1-正常-前2后1');
  const m1 = await mkMember(i1, 5, '开发五');
  await seedCommit(i1, m1, 5, 'frontend', 'fe-first');
  await seedCommit(i1, m1, 5, 'backend', 'be-only');
  await seedCommit(i1, m1, 5, 'frontend', 'fe-second');

  // #2 零 commit 单
  const i2 = await mkIssue('C1-零commit');
  await mkMember(i2, 6, '开发六');

  // #3 commit_ref 含分号（D4 核心防线）
  const i3 = await mkIssue('C1-含分号');
  const m3 = await mkMember(i3, 7, '开发七');
  await seedCommit(i3, m3, 7, 'frontend', 'feat/a;b');   // 单个 ref 内部含分号
  await seedCommit(i3, m3, 7, 'frontend', 'plain');

  // #4 成员已移除但 commit 仍在
  const i4 = await mkIssue('C1-成员已移除');
  const m4 = await mkMember(i4, 8, '开发八', '2026-08-01 10:00:00');
  await seedCommit(i4, m4, 8, 'backend', 'be-by-removed');

  const res = await call('GET', '/api/sys-issues', adminTok);
  assert.strictEqual(res.status, 200, `列表端点应 200，实得 ${res.status}：${JSON.stringify(res.body)}`);
  const items = res.body && res.body.items;
  assert.ok(Array.isArray(items), '响应应含 items 数组');

  // ── [A1] 字段存在 + 值协议是 JSON 数组字符串 ──────────────────────
  const r1 = rowOf(items, i1);
  assert.ok('frontend_commit_refs' in r1, '列表行应含 frontend_commit_refs 字段');
  assert.ok('backend_commit_refs' in r1, '列表行应含 backend_commit_refs 字段');
  const fe1 = parseArr(r1.frontend_commit_refs, 'frontend_commit_refs');
  const be1 = parseArr(r1.backend_commit_refs, 'backend_commit_refs');
  ok('[A1] 两字段存在且值协议为合法 JSON 数组字符串（非分隔符拼接明文·D4）');

  // ── [A3] 前后端分组不串 ────────────────────────────────────────────
  assert.deepStrictEqual(fe1, ['fe-first', 'fe-second'], `前端组应只含 frontend 的两条，实际 ${JSON.stringify(fe1)}`);
  assert.deepStrictEqual(be1, ['be-only'], `后端组应只含 backend 的一条，实际 ${JSON.stringify(be1)}`);
  ok('[A3] component 精确分流：前端组不含后端 ref、后端组不含前端 ref');

  // ── [A4] 顺序 = id ASC（录入顺序）───────────────────────────────────
  // fe-first 先于 fe-second 录入 → 数组顺序必须一致（而非 SQLite 无序聚合的偶然结果）
  assert.strictEqual(fe1[0], 'fe-first', '首元素应是先录入的 fe-first（ORDER BY id ASC）');
  assert.strictEqual(fe1[1], 'fe-second', '次元素应是后录入的 fe-second');
  ok('[A4] 聚合顺序 = 录入顺序（id ASC·与发布快照同源）——已在 reverse_unordered_selects=ON 下断言，删排序即红');

  // ── [A4-static] 合同锁：直接读源码确认两个子查询显式写了 ORDER BY id ASC ──────
  //   与 A4 行为断言互补：行为断言证明"当前结果有序"，本条证明"有序不是碰巧、是写死的契约"。
  const srcPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
  const src = fs.readFileSync(srcPath, 'utf8');
  for (const comp of ['frontend', 'backend']) {
    // 不用一整条大正则——SQL 里的 `trim(commit_ref)` 自带右括号，`[^)]*?` 会被它提前截断（已踩）。
    // 改为：先按锚点切出该子查询的片段，再在片段内逐条断言，直白且不易写错。
    const anchor = `component = '${comp}'`;
    const at = src.indexOf(anchor);
    assert.ok(at > 0, `源码中应能定位 ${comp} 子查询锚点 "${anchor}"（找不到说明 SQL 结构已变，合同锁需同步更新）`);
    const seg = src.slice(at, at + 400);   // 覆盖到该子查询结束足够
    assert.ok(/ORDER\s+BY\s+id\s+ASC/i.test(seg),
      `index.js 的 ${comp} commit 子查询必须显式写 "ORDER BY id ASC"（合同锁·删除或改序即本条红）`);
    // ⭐ 末次合并审 246 MED-1 的**结构级回归锁**：脏值过滤一旦被删，X1b 的跨端点一致性会在
    //   "恰好没有脏数据"的库上静默通过；这条从源码层面锁死，与 X1b 行为断言互补。
    //   ⚠️ 必须锁**双参** trim(X, chars)：SQLite 单参 trim() 只去空格，JS .trim() 去所有空白，
    //   写成单参会让 '\t\n ' 在两端口径不一致（本次实测踩到，X1b 交叉断言暴露）。
    //   复审 246-B LOW-1：连字符集一起锁——只锁"双参"仍可能被换成漏掉 Tab/LF 的字符集而静默退化。
    for (const code of ['32', '9', '10', '13']) {
      assert.ok(new RegExp("char\\(\\s*" + code + "\\s*\\)").test(seg),
        `${comp} 子查询的 trim 字符集必须含 char(${code})（32/9/10/13 = 空格/Tab/LF/CR），否则与 JS .trim() 口径又会分叉`);
    }
    assert.ok(/commit_ref\s+IS\s+NOT\s+NULL/i.test(seg) && /trim\(\s*commit_ref\s*,[^\n]*\)\s*<>\s*''/i.test(seg),
      `index.js 的 ${comp} commit 子查询必须含元素级脏值过滤，且 trim 必须是**双参形式** trim(commit_ref, char(32)||char(9)||char(10)||char(13))——单参 trim 只去空格，与 refsByComponent 的 JS .trim() 口径不一致（末次审 246 MED-1）`);
  }
  ok('[A4-static] 合同锁：两个子查询均显式含 ORDER BY id ASC **且**含元素级脏值过滤（与 refsByComponent 同口径）');

  // ── [A2] 零命中 → '[]' 而非 NULL/空串 ─────────────────────────────
  const r2 = rowOf(items, i2);
  assert.strictEqual(r2.frontend_commit_refs, '[]', `零 commit 时前端组应为 '[]'，实际 ${JSON.stringify(r2.frontend_commit_refs)}`);
  assert.strictEqual(r2.backend_commit_refs, '[]', `零 commit 时后端组应为 '[]'，实际 ${JSON.stringify(r2.backend_commit_refs)}`);
  assert.deepStrictEqual(parseArr(r2.frontend_commit_refs, '零命中前端组'), [], '零命中 JSON.parse 后应是空数组');
  ok("[A2] 零命中返回合法空数组 '[]'（非 NULL/非空串）——前端 JSON.parse 不炸、可直接判 length");

  // ── [A5] ⭐ commit_ref 含分号内容不被破坏（D4 核心防线）──────────
  const r3 = rowOf(items, i3);
  const fe3 = parseArr(r3.frontend_commit_refs, '含分号单前端组');
  assert.strictEqual(fe3.length, 2, `应恰好 2 个元素（含分号的 ref 不得被拆成两截），实际 ${fe3.length} 个：${JSON.stringify(fe3)}`);
  assert.strictEqual(fe3[0], 'feat/a;b', `含分号的 ref 应原样保留，实际 ${JSON.stringify(fe3[0])}`);
  assert.strictEqual(fe3[1], 'plain', '第二条应为 plain');
  ok('[A5] ⭐ commit_ref 内部含分号时原样保留、不被错拆为两截（89 号审同款坑；改用裸 GROUP_CONCAT(\';\') 时**本脚本必红**——实际多半先在 A1 的 JSON 协议断言拦下，codex 审 C1 建议的措辞修正）');

  // ── [A6] 成员已移除，其 commit 仍出现 ─────────────────────────────
  const r4 = rowOf(items, i4);
  const be4 = parseArr(r4.backend_commit_refs, '成员已移除单后端组');
  assert.deepStrictEqual(be4, ['be-by-removed'], `成员 removed_at 非空时其 commit 仍应显示（commit 是已发生的事实），实际 ${JSON.stringify(be4)}`);
  ok('[A6] 成员已移除（removed_at 非空）其 commit 仍在聚合结果内——与发布快照「含 removed 实例」同口径');

  // ── [A7] 多单据互不串 ──────────────────────────────────────────────
  assert.ok(!parseArr(r1.frontend_commit_refs, 'i1 前端组').includes('plain'), 'i1 不应含 i3 的 commit');
  assert.ok(!parseArr(r3.backend_commit_refs, 'i3 后端组').includes('be-only'), 'i3 不应含 i1 的 commit');
  assert.strictEqual(r3.backend_commit_refs, '[]', 'i3 无后端 commit，应为空数组');
  ok('[A7] 子查询按 issue_id 正确隔离，多单据聚合结果互不串');

  // ── 回归：既有字段未被破坏 ────────────────────────────────────────
  assert.ok('dev_roster_names' in r1, '既有 dev_roster_names 字段应仍在（本次为追加非替换）');
  assert.ok('last_held_at' in r1, '既有 last_held_at 字段应仍在（新字段插在其后，逗号未写错）');
  assert.deepStrictEqual(parseArr(r1.dev_roster_names, 'dev_roster_names'), ['开发五'], '既有成员名聚合行为不变');
  ok('[回归] 既有 dev_roster_names / last_held_at 字段与行为未受影响');

  // ═══════════════════════════════════════════════════════════════════
  // C2：批次详情成员列表两列（getReleaseMembers 三分支派生·锚点 D1/D5）
  //   与 C1 的值形态**刻意不同**：这里是 JS 层派生的真数组（非 JSON 字符串），
  //   因为无需序列化往返；前端共享 helper 统一接受"已解析的数组"。
  // ═══════════════════════════════════════════════════════════════════

  let relSeq = 0;
  async function mkRelease(status) {
    const r = await run(
      `INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name)
       VALUES (?, ?, ?, 0, 1, '管理员')`, [`R-COLS-${++relSeq}`, `批次${relSeq}`, status]
    );
    return r.lastID;
  }
  const attachToRelease = (issueId, relId, st) =>
    run(`UPDATE sys_issues SET release_id = ?, status = ? WHERE id = ?`, [relId, st, issueId]);
  const mkSnapshot = (relId, issueId, payload) =>
    run(`INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at)
         VALUES (?, ?, ?, datetime('now'))`, [relId, issueId, JSON.stringify(payload)]);
  const mkPublishedTl = (relId, issueId, summaryObj) =>
    run(`INSERT INTO sys_issue_timeline (issue_id, event_type, action_code, ref_id, summary, operator_id, operator_name)
         VALUES (?, 'scope_change', 'release_published', ?, ?, 1, '管理员')`,
        [issueId, relId, JSON.stringify(summaryObj)]);
  const issuesOf = (body) => { assert.ok(body && Array.isArray(body.issues), '批次详情应返回 issues 数组'); return body.issues; };

  // ── [B1] live 分支（计划中批次）：真数组 + 前后端分流 + 录入顺序 ──────────
  const relLive = await mkRelease('计划中');
  const i5 = await mkIssue('C2-live-前2后1');
  await attachToRelease(i5, relLive, '待上线');
  const m5 = await mkMember(i5, 9, '开发九');
  await seedCommit(i5, m5, 9, 'frontend', 'live-fe-1');
  await seedCommit(i5, m5, 9, 'backend', 'live-be-1');
  await seedCommit(i5, m5, 9, 'frontend', 'live-fe-2');

  const rLive = await call('GET', `/api/sys-releases/${relLive}`, adminTok);
  assert.strictEqual(rLive.status, 200, '批次详情应 200');
  assert.strictEqual(rLive.body.source, 'live', '计划中批次读源应为 live');
  const memLive = issuesOf(rLive.body).find(x => x.id === i5);
  assert.ok(memLive, '成员清单应含该单');
  assert.ok(Array.isArray(memLive.frontend_commit_refs), 'C2 侧应为真数组（非 JSON 字符串）');
  assert.deepStrictEqual(memLive.frontend_commit_refs, ['live-fe-1', 'live-fe-2'], '前端组应按录入顺序且不含后端 ref');
  assert.deepStrictEqual(memLive.backend_commit_refs, ['live-be-1'], '后端组应只含 backend ref');
  ok('[B1] live 分支（计划中批次）：两列为真数组 + component 分流正确 + 录入顺序');

  // ── [B2] ⭐ snapshot 分支 + 防漂移：已发布批次读快照，不回查 live ───────────
  //   造法：快照里写 snap-*，同时把 live 表的 commit 改成完全不同的值。
  //   若实现回查了 live 表（违反 D5），本条必红——这是 D5 唯一的真判据。
  const relPub = await mkRelease('已发布');
  const i6 = await mkIssue('C2-snapshot-防漂移');
  await attachToRelease(i6, relPub, '已上线');
  const m6 = await mkMember(i6, 10, '开发十');
  await seedCommit(i6, m6, 10, 'frontend', 'LIVE-CHANGED-AFTER-PUBLISH');   // 发布后被改动的 live 值
  await mkSnapshot(relPub, i6, {
    schema_version: 2, type: 'bug', title_snapshot: 'C2-snapshot-防漂移', status_at_publish: '已上线',
    commits: [
      { commit_id: 1, dev_user_id: 10, component: 'frontend', commit_ref: 'snap-fe-1' },
      { commit_id: 2, dev_user_id: 10, component: 'backend', commit_ref: 'snap-be-1' },
      { commit_id: 3, dev_user_id: 10, component: 'frontend', commit_ref: 'snap-fe-2' },
    ],
  });
  await mkPublishedTl(relPub, i6, { schema_version: 2, type: 'bug', title_snapshot: 'C2-snapshot-防漂移', status_at_publish: '已上线', commits: [] });

  const rPub = await call('GET', `/api/sys-releases/${relPub}`, adminTok);
  assert.strictEqual(rPub.status, 200, '已发布批次详情应 200');
  assert.strictEqual(rPub.body.source, 'snapshot', `已发布且快照完整时读源应为 snapshot，实际 ${rPub.body.source}`);
  assert.strictEqual(rPub.body.degraded, false, '快照完整不应 degraded');
  const memPub = issuesOf(rPub.body).find(x => x.id === i6);
  assert.deepStrictEqual(memPub.frontend_commit_refs, ['snap-fe-1', 'snap-fe-2'],
    `已发布批次必须读快照值，实际 ${JSON.stringify(memPub.frontend_commit_refs)}——若含 LIVE-CHANGED-AFTER-PUBLISH 说明回查了 live 表，违反 D5`);
  assert.deepStrictEqual(memPub.backend_commit_refs, ['snap-be-1'], '后端组同样取自快照');
  assert.ok(!JSON.stringify(memPub).includes('LIVE-CHANGED'), '响应中不得出现发布后被改动的 live 值');
  ok('[B2] ⭐ snapshot 分支防漂移：已发布批次读发布快照、不回查 live 表（live 已被改成不同值仍不泄漏·D5 唯一真判据）');

  // ── [B3] degraded 分支：commits 不可用 → null 而非 []（不伪造事实）────────
  const relDeg = await mkRelease('已发布');
  const i7 = await mkIssue('C2-degraded');
  await attachToRelease(i7, relDeg, '已上线');
  // 只写 timeline 不写快照 → complete=false → 回落 degraded；且载荷 commits 非数组 → member.commits=null
  await mkPublishedTl(relDeg, i7, { schema_version: 2, type: 'bug', title_snapshot: 'C2-degraded', status_at_publish: '已上线', commits: null });

  const rDeg = await call('GET', `/api/sys-releases/${relDeg}`, adminTok);
  assert.strictEqual(rDeg.status, 200, 'degraded 批次详情仍应 200（不静默当空）');
  assert.strictEqual(rDeg.body.source, 'degraded', `快照缺失应回落 degraded，实际 ${rDeg.body.source}`);
  assert.strictEqual(rDeg.body.degraded, true, 'degraded 标志应为 true');
  assert.ok(Array.isArray(rDeg.body.unavailable_fields) && rDeg.body.unavailable_fields.includes('commits'),
    `unavailable_fields 应含 'commits'，实际 ${JSON.stringify(rDeg.body.unavailable_fields)}`);
  const memDeg = issuesOf(rDeg.body).find(x => x.id === i7);
  assert.strictEqual(memDeg.frontend_commit_refs, null,
    `degraded 且 commits 不可用时应为 null（"读不出来"），不得伪造成 []（"确实没有"），实际 ${JSON.stringify(memDeg.frontend_commit_refs)}`);
  assert.strictEqual(memDeg.backend_commit_refs, null, '后端组同理应为 null');
  ok("[B3] degraded 分支：commits 不可用时两列为 null 而非 []——「读不出来」与「确实没有」不混为一谈（§6.6a 不伪造字段）");

  // ── [B4] 零 commit 的正常单 → [] （与 B3 的 null 形成对照）───────────────
  const relEmpty = await mkRelease('计划中');
  const i8 = await mkIssue('C2-零commit');
  await attachToRelease(i8, relEmpty, '待上线');
  await mkMember(i8, 11, '开发十一');
  const rEmpty = await call('GET', `/api/sys-releases/${relEmpty}`, adminTok);
  const memEmpty = issuesOf(rEmpty.body).find(x => x.id === i8);
  assert.deepStrictEqual(memEmpty.frontend_commit_refs, [], '确实没有 commit 的单应为空数组 []');
  assert.deepStrictEqual(memEmpty.backend_commit_refs, [], '后端组同理');
  ok('[B4] 零 commit 正常单返回 [] —— 与 B3 的 null 语义严格区分（对照断言）');

  // ── [B6] snapshot 且 commits 为空数组 → 两列均 []（codex 审 242 建议的可选加强）────
  const relPubEmpty = await mkRelease('已发布');
  const i9 = await mkIssue('C2-snapshot-零commit');
  await attachToRelease(i9, relPubEmpty, '已上线');
  await mkSnapshot(relPubEmpty, i9, {
    schema_version: 2, type: 'bug', title_snapshot: 'C2-snapshot-零commit', status_at_publish: '已上线', commits: [],
  });
  await mkPublishedTl(relPubEmpty, i9, { schema_version: 2, type: 'bug', title_snapshot: 'C2-snapshot-零commit', status_at_publish: '已上线', commits: [] });
  const rPubEmpty = await call('GET', `/api/sys-releases/${relPubEmpty}`, adminTok);
  assert.strictEqual(rPubEmpty.body.source, 'snapshot', '零 commit 的完整快照仍应判 snapshot（空数组是合法快照内容）');
  const memPubEmpty = issuesOf(rPubEmpty.body).find(x => x.id === i9);
  assert.deepStrictEqual(memPubEmpty.frontend_commit_refs, [], 'snapshot 且 commits=[] 应返回 []（非 null）');
  assert.deepStrictEqual(memPubEmpty.backend_commit_refs, [], '后端组同理');
  ok('[B6] snapshot 分支零 commit → [] 而非 null（发布时确实没提交代码，是可判定的事实）');

  // ── [B7] degraded 且 commits 元素缺 commit_ref → 丢弃坏元素，不产出 [null] ────
  //   codex 审 242 risks-2：脏 timeline 载荷若元素缺 commit_ref，无元素级过滤会 map 出 undefined
  //   → JSON 序列化成 null → 前端渲染空白/字面量 "null"。
  const relDirty = await mkRelease('已发布');
  const i10 = await mkIssue('C2-degraded-脏元素');
  await attachToRelease(i10, relDirty, '已上线');
  await mkPublishedTl(relDirty, i10, {
    schema_version: 2, type: 'bug', title_snapshot: 'C2-degraded-脏元素', status_at_publish: '已上线',
    commits: [
      { component: 'frontend' },                                  // 缺 commit_ref（坏元素）
      { component: 'frontend', commit_ref: 'good-fe' },           // 正常元素
      { component: 'frontend', commit_ref: '   ' },               // 全空白（等价于没有）
      { component: 'backend', commit_ref: null },                 // 显式 null
    ],
  });
  const rDirty = await call('GET', `/api/sys-releases/${relDirty}`, adminTok);
  assert.strictEqual(rDirty.body.source, 'degraded', '无快照应回落 degraded');
  const memDirty = issuesOf(rDirty.body).find(x => x.id === i10);
  assert.deepStrictEqual(memDirty.frontend_commit_refs, ['good-fe'],
    `坏元素应被丢弃、好元素保留，实际 ${JSON.stringify(memDirty.frontend_commit_refs)}`);
  assert.ok(!memDirty.frontend_commit_refs.includes(null) && !memDirty.frontend_commit_refs.includes(undefined),
    '结果数组中不得出现 null/undefined 元素');
  assert.deepStrictEqual(memDirty.backend_commit_refs, [], 'commit_ref 为 null 的元素应被丢弃，该组结果为空数组');
  ok('[B7] degraded 脏载荷：缺失/空白/null 的 commit_ref 元素被丢弃且不连坐好元素，响应中无 null 元素');

  // ── [B5] 既有契约未破坏：四个旧字段名仍在 ──────────────────────────────
  for (const k of ['id', 'type', 'title', 'status']) {
    assert.ok(k in memLive, `批次详情成员应保留既有字段 ${k}（前端 siOpenBatchDetail 逐字消费旧键名）`);
  }
  ok('[B5] 既有返回契约未破坏：id/type/title/status 四个旧键名原样保留（本次只增不改）');

  // ═══════════════════════════════════════════════════════════════════
  // [X1] ⭐ 末次合并审（codex 246 MED-1）：**两个后端端点对脏 commit_ref 必须同口径**
  //   跨阶段接缝——C2 收口时给 refsByComponent 加了元素级过滤（codex 242 risks-2），
  //   但没回头同步 C1 的 SQL 聚合 ⇒ 同一张脏单，列表端点出 '["   "]'、批次详情出 '[]'。
  //   前端 helper 恰好把两者过滤成同样显示，所以**单页冒烟全绿、问题被掩盖**——只有把两个
  //   端点的 raw 输出摆在一起比对才看得见。本组即该比对。
  //   ⭐ 造脏数据说明（复审 246-B LOW-2 更正，此前表述不准确）：
  //     · 纯空格 '   '：表上的 CHECK (length(trim(commit_ref)) BETWEEN 1 AND 200) 能挡住
  //       （trim 去掉空格后长度 0），故需临时 `PRAGMA ignore_check_constraints` 绕过；
  //     · Tab/LF 类 '<Tab><LF><空格>'：**CHECK 本身挡不住** —— 该 CHECK 用的也是 SQLite
  //       **单参 trim()（只去空格）**，length(trim(...)) = 3 > 0 判定合法 ⇒ **当前写入端就能
  //       合法产生这类脏值**，不只是"历史遗留/手工写库"。这让本组断言从纵深防御升级为
  //       真实可达路径的防线（本用例一并模拟两类）。
  //   ⚠️ NULL 值造不出来——那是 NOT NULL 列约束，该 PRAGMA 只影响 CHECK 不影响 NOT NULL，
  //     **如实记录不假装测过**。`ignore_check_constraints` 是连接作用域，此处 ON 后立即 OFF。
  // ═══════════════════════════════════════════════════════════════════
  const relDirty2 = await mkRelease('计划中');
  const iDirty = await mkIssue('X1-脏ref两端点一致');
  await attachToRelease(iDirty, relDirty2, '待上线');
  const mDirty = await mkMember(iDirty, 20, '开发廿');
  await seedCommit(iDirty, mDirty, 20, 'frontend', 'clean-ref-1');
  await run('PRAGMA ignore_check_constraints = ON');
  await seedCommit(iDirty, mDirty, 20, 'frontend', '   ');          // 全空白（CHECK 本应拦）
  await seedCommit(iDirty, mDirty, 20, 'backend', '\t\n ');         // 仅空白字符
  await run('PRAGMA ignore_check_constraints = OFF');

  const listAgain = await call('GET', '/api/sys-issues', adminTok);
  const dirtyRow = rowOf(listAgain.body.items, iDirty);
  const listFe = parseArr(dirtyRow.frontend_commit_refs, 'X1 列表端点前端组');
  const listBe = parseArr(dirtyRow.backend_commit_refs, 'X1 列表端点后端组');
  // ⭐ 复审 246-B MED-1：**每组都要有显式期望**。原版只显式断言了 frontend，backend 仅参与
  //   X1b 的"两端相等"——而"逐字相同"只能证明两端一致、**不能证明两端都对**：若将来两个端点
  //   同时回退成 ["<Tab><LF><空格>"]，X1b 照样绿。交叉断言必须与每组的显式期望配套才算锁死。
  assert.deepStrictEqual(listFe, ['clean-ref-1'],
    `列表端点前端组应已滤掉空白 ref（末次审 246 MED-1 修复点），实际 ${JSON.stringify(listFe)}`);
  assert.deepStrictEqual(listBe, [],
    `列表端点后端组只有一条纯空白 ref，应被全部滤掉得空数组，实际 ${JSON.stringify(listBe)}`);
  for (const [label, arr] of [['前端组', listFe], ['后端组', listBe]]) {
    assert.ok(!arr.some(x => x == null || String(x).trim() === ''), `列表端点${label}不得含 null/空白元素`);
  }
  ok('[X1a] 列表端点 SQL 聚合已做元素级过滤：前端组保留干净 ref、后端组纯空白被滤空，两组均无 null/空白元素');

  const batchAgain = await call('GET', `/api/sys-releases/${relDirty2}`, adminTok);
  const dirtyMember = issuesOf(batchAgain.body).find(x => x.id === iDirty);
  // 两组各自的显式期望（不能只靠"两端相等"，理由见上方 X1a 注释）
  assert.deepStrictEqual(dirtyMember.frontend_commit_refs, ['clean-ref-1'], '批次详情前端组的显式期望');
  assert.deepStrictEqual(dirtyMember.backend_commit_refs, [], '批次详情后端组的显式期望（纯空白全滤掉）');
  assert.deepStrictEqual(dirtyMember.frontend_commit_refs, listFe,
    `⭐ 两个端点对同一张脏单必须给出**逐字相同**的结果：列表 ${JSON.stringify(listFe)} vs 批次详情 ${JSON.stringify(dirtyMember.frontend_commit_refs)}`);
  assert.deepStrictEqual(dirtyMember.backend_commit_refs, listBe,
    `⭐ 后端组同理：列表 ${JSON.stringify(listBe)} vs 批次详情 ${JSON.stringify(dirtyMember.backend_commit_refs)}`);
  ok('[X1b] ⭐ 跨端点一致性：同一张脏单在 GET /sys-issues 与 GET /sys-releases/:id 的结果逐字相同（本条即末次合并审 MED-1 的回归锁）');

  // ═══════════════════════════════════════════════════════════════════
  // [Y] 件②（2026-08-12）commit 记录展示层去重：后端契约 + 前端实现 双向验证
  //   起因：v1.151.1「打回自动重开一轮」会让同一开发在两轮各写一条同值 commit_ref（如同一版本号
  //   22853），raw 层保留全量重复是**有意行为**（分轮事实不能丢），去重只应发生在展示层，且只应
  //   有 siNormalizeCommitRefs 这一处实现。本组守两条：①后端不得偷偷去重 ②前端确实去重。
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n── [Y] 件②：commit 记录展示层去重 契约与实现验证 ──');

  // ── [Y1] 后端聚合查询源码不含去重关键字（DISTINCT/GROUP BY/UNION）──────────
  //   [SD1 预筛 LOW-1 收口] 剥注释先行：防**未来**在扫描区间（commitAggSeg）内新增/改写注释时写出
  //   DISTINCT/GROUP BY 这类字面量（哪怕只是解释"不得用它们"），若不剥注释直接对整段原文做关键字
  //   匹配，注释自身会把 [Y1] 点成假红——是纵深防御，不是在修复本次已发生的问题（当前契约注释落在
  //   扫描区间**之外**、且不含这两个关键字字面量，见 index.js :5698-5706 一带）。这正是 [Y3] ★对照
  //   组①要证明的反例之一。
  // [SD1 预筛 LOW-5·仅注释] 已知局限：不识别字符串字面量内的 `--`（若 SQL 正文出现字符串常量里含
  //   `--` 会被误当注释起点截断）。本文件扫描的 SQL 片段无此类字面量，失败方向朝红（把该行整体当注释
  //   吞掉，顶多让后续关键字判据"漏检"而非"误报"）+ 上层 assert 兜底，属可接受技术债，非本次需修的缺口。
  function stripSqlLineComments(sqlText) {
    return sqlText.split('\n').map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    }).join('\n');
  }
  // [SD1 预筛 LOW-2① 收口] 补 UNION（不含 UNION ALL）——SQLite 的裸 UNION 会对结果集去重，
  //   是"等效偷偷去重"的另一种写法（不靠 DISTINCT/GROUP BY 关键字也能做到同样的事），必须一并拦；
  //   UNION ALL 保留全部行（含重复），不去重，放行不判红。
  function hasRawDedupKeyword(sqlText) {
    const stripped = stripSqlLineComments(sqlText);
    return /\bDISTINCT\b/i.test(stripped) || /\bGROUP\s+BY\b/i.test(stripped) || /\bUNION\b(?!\s+ALL)/i.test(stripped);
  }
  const idxFeSub = src.indexOf('json_group_array(commit_ref)');
  assert.ok(idxFeSub > 0, '[Y1] 前置：源码中应能定位 frontend_commit_refs 子查询锚点 "json_group_array(commit_ref)"');
  const idxAllEnd = src.indexOf('AS all_commit_refs', idxFeSub);
  assert.ok(idxAllEnd > idxFeSub, '[Y1] 前置：源码中应能定位 all_commit_refs 子查询结束锚点');
  const commitAggSeg = src.slice(idxFeSub, idxAllEnd + 'AS all_commit_refs'.length);
  assert.ok(!hasRawDedupKeyword(commitAggSeg),
    '[Y1] ⭐ frontend_commit_refs/backend_commit_refs/all_commit_refs 三个子查询源码（剥注释后）不得含 DISTINCT/GROUP BY/裸UNION——raw 层必须保留跨轮重复，去重只应发生在展示层');
  ok('[Y1] 列表 SELECT 的三个 commit 聚合子查询源码（剥注释后）不含去重关键字（DISTINCT/GROUP BY/裸UNION）——raw 契约未被破坏');

  // [SD1 预筛 LOW-2② 收口] 第二段扫描：GET /sys-releases/:id 的 refsByComponent（发布快照聚合，live
  //   分支的过滤链）——:5698-5706 的契约注释点名了它（"与 GET /sys-releases/:id 的发布快照聚合口径
  //   同样不去重"），但 [Y1] 此前只守了列表端点这一侧，另一侧毫无守卫，正是 246 号 MED-1 曾经真实
  //   出现过的双端漂移形状（一端加了处理、另一端没同步）。锚点定位显式非空校验——抓不到就 assert.ok
  //   失败，不会因为定位落空而让下面的判据"空转判过"。
  const idxRefsByComponent = src.indexOf('function refsByComponent');
  assert.ok(idxRefsByComponent > 0,
    '[Y1] 前置：源码中应能定位 refsByComponent 函数锚点 "function refsByComponent"（找不到说明函数已改名/挪位，本条守卫需同步更新，不能静默跳过）');
  // refsByComponent 是 JS 函数（非 SQL），去重风险点在于是否用了 Set/filter+indexOf 之类做"去重"、
  //   或对聚合来源的 SQL 查询本身加了 DISTINCT/GROUP BY/UNION——函数体本身用同一套关键字判据足够
  //   （JS 里出现 DISTINCT/GROUP BY 字面量的唯一可能就是内嵌 SQL 字符串；UNION 同理）。
  const refsByComponentBraceStart = src.indexOf('{', idxRefsByComponent);
  assert.ok(refsByComponentBraceStart > idxRefsByComponent,
    '[Y1] 前置：应能定位 refsByComponent 函数体起始花括号');
  let rbcDepth = 0, rbcEnd = -1;
  for (let i = refsByComponentBraceStart; i < src.length; i++) {
    if (src[i] === '{') rbcDepth++;
    else if (src[i] === '}') { rbcDepth--; if (rbcDepth === 0) { rbcEnd = i + 1; break; } }
  }
  assert.ok(rbcEnd > 0, '[Y1] 前置：未能定位 refsByComponent 函数体结束花括号（括号计数失衡，说明抽取范围有误）');
  const refsByComponentSeg = src.slice(idxRefsByComponent, rbcEnd);
  assert.ok(!hasRawDedupKeyword(refsByComponentSeg),
    '[Y1b] ⭐ refsByComponent（GET /sys-releases/:id 发布快照聚合，:5698-5706 契约注释点名的另一端）源码（剥注释后）同样不得含 DISTINCT/GROUP BY/裸UNION——两端漂移正是 246 号 MED-1 的教训形状');
  ok('[Y1b] refsByComponent（批次详情 live 分支过滤链）源码（剥注释后）同样不含去重关键字——契约注释点名的另一端补上守卫');

  // [SD1 二轮预筛 MED-4 收口] Y1b 覆盖收口——选**方案 A**（扩判据覆盖 JS 去重形状），非退路方案。
  //   理由：refsByComponentSeg 现有真实内容（见上方 :493-495 一带函数体）不含 `new Set(`/`.indexOf(`
  //   字面量，扩判据不会对当前代码产生误报（已用下方对照组④/⑤实证：正常源码判据为 false，注入后
  //   才判 true），故没有"既有合法命中导致误报"这个退路触发条件，直接采用更强的方案。
  //   DISTINCT/GROUP BY/UNION 是 **SQL 层**去重关键字，只覆盖"聚合来源查询本身用 SQL 去重"这一种
  //   违反契约的写法；refsByComponent 是纯 JS 函数，若有人改成用 `new Set()`（去重容器）或
  //   `.indexOf(x) === i`（"已出现过就跳过"的经典手法）在 JS 层去重，SQL 关键字扫描完全抓不到——
  //   这是 [Y1b] 此前的真实盲区（不是假设性的，是"守卫覆盖面≠实现覆盖面"的具体缺口）。
  function hasJsDedupShape(jsText) {
    return /\bnew\s+Set\s*\(/.test(jsText) || /\.indexOf\s*\(/.test(jsText);
  }
  assert.ok(!hasJsDedupShape(refsByComponentSeg),
    '[Y1b] ⭐ refsByComponent 源码不得含 JS 层去重形状（new Set()/.indexOf()）——SQL 关键字扫描覆盖不到这类实现方式，需单独判据补齐盲区');
  ok('[Y1b] refsByComponent 源码同时不含 JS 层去重形状（new Set()/.indexOf()）——SQL 关键字 + JS 去重手法双维度覆盖，Y1b 盲区已补');

  // ── [Y2] 前端 siNormalizeCommitRefs 真实具备保序首现去重能力 ─────────────
  //   不满足于正则关键字扫描（那只能证明"有没有出现某个词"，证不了函数行为对不对）——直接从页面
  //   源码里把整个函数体抠出来、在 Node 里 eval 成真函数、传真实带重复的输入验证输出，比静态关键字
  //   扫描强得多（等价于把浏览器里的 [T6] 契约测试搬一份到后端守卫里）。
  const pageSrcPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
  const pageSrc = fs.readFileSync(pageSrcPath, 'utf8');
  // [SD1 预筛 LOW-5·仅注释] 已知局限：花括号计数不识别字符串/模板字符串字面量内的 `{`/`}`（若函数体内
  //   出现含花括号的字符串常量会数错深度）。本文件抽取的两个函数（siNormalizeCommitRefs/refsByComponent）
  //   均无此类字面量，失败方向朝红（`end` 定不到正确位置多半直接越界或提前收尾，被下方 assert 拦住而
  //   非静默抽出半截函数体），属可接受技术债，非本次需修的缺口。
  function extractJsFunctionSource(jsSrc, fnName) {
    const startIdx = jsSrc.indexOf(`function ${fnName}(`);
    assert.ok(startIdx >= 0, `[Y2] 前置：页面源码中应能找到 "function ${fnName}("`);
    const braceStart = jsSrc.indexOf('{', startIdx);
    assert.ok(braceStart > startIdx, `[Y2] 前置：应能定位 ${fnName} 函数体起始花括号`);
    let depth = 0, end = -1;
    for (let i = braceStart; i < jsSrc.length; i++) {
      if (jsSrc[i] === '{') depth++;
      else if (jsSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > 0, `[Y2] 前置：未能定位 ${fnName} 函数体结束花括号（括号计数失衡，说明抽取范围有误）`);
    return jsSrc.slice(startIdx, end);
  }
  const normalizeFnSrc = extractJsFunctionSource(pageSrc, 'siNormalizeCommitRefs');
  // eslint-disable-next-line no-new-func
  const siNormalizeCommitRefs = new Function(`return (${normalizeFnSrc});`)();
  assert.strictEqual(typeof siNormalizeCommitRefs, 'function', '[Y2] 前置：抽取并 eval 后应得到一个真函数');

  const dupInput = ['22853', '22853', 'x', '22853', 'y', 'x'];
  const dedupResult = siNormalizeCommitRefs(dupInput);
  assert.deepStrictEqual(dedupResult, ['22853', 'x', 'y'],
    `[Y2] ⭐⭐ siNormalizeCommitRefs 对含重复输入 ${JSON.stringify(dupInput)} 应保序首现去重为 ['22853','x','y']，实得 ${JSON.stringify(dedupResult)}`);
  // JSON 字符串入参路径同样要去重（列表端点出的是 JSON 数组字符串，非真数组）
  const dedupFromJson = siNormalizeCommitRefs(JSON.stringify(dupInput));
  assert.deepStrictEqual(dedupFromJson, ['22853', 'x', 'y'],
    `[Y2] JSON 字符串入参路径同样应去重，实得 ${JSON.stringify(dedupFromJson)}`);
  // 无重复输入应原样保留（不误伤干净数据、不改变既有元素顺序/内容）
  const cleanInput = ['a', 'b', 'c'];
  assert.deepStrictEqual(siNormalizeCommitRefs(cleanInput), ['a', 'b', 'c'],
    '[Y2] 无重复输入应原样保留，去重实现不得误伤干净数据');
  // [SD1 预筛 LOW-4 收口] 判等口径改按 trim 后——正例：'22853' 与 '22853\t' 肉眼相同，trim 后判等
  //   应去重为 1 条；对照：'22853' 与 '22853b' trim 后仍不同，应正常保留 2 条（证明改动没有变成"只要
  //   前缀相同就并"这类过度宽松的误实现）。
  //   [codex 355 三轮插入批 L1 收口·业务已拍板"清洁优先于原值审计"] 期望值改为**trim 后的 canonical
  //   值**（`out.push(x)`→`out.push(key)`，展示/复制链路不许携带隐形字符）——不再断言"保留原值"。
  const tabDupResult = siNormalizeCommitRefs(['22853', '22853\t']);
  assert.deepStrictEqual(tabDupResult, ['22853'],
    `[Y2] ⭐⭐ D组件①随行·L1：['22853','22853\\t'] trim 后判等应去重为 1 条 canonical 值 '22853'，实得 ${JSON.stringify(tabDupResult)}`);
  const notDupResult = siNormalizeCommitRefs(['22853', '22853b']);
  assert.deepStrictEqual(notDupResult, ['22853', '22853b'],
    `[Y2] ⭐ 对照：['22853','22853b'] trim 后仍不同，不应被误判为重复，应保留 2 条，实得 ${JSON.stringify(notDupResult)}`);
  // [codex 355 三轮插入批 L1 收口] 首个为脏值对照——若实现仍是"保留首次出现的原值"（未真正改用
  //   push(key)），当**第一条恰好带隐形字符**时会漏网：['  22853\t','22853'] 若还是 push(x)，输出会是
  //   ['  22853\t']（带前导空格与 Tab，肉眼看不出但会污染复制到部署工具的内容）；改对后应恰好输出
  //   trim 后的 canonical 值 ['22853']，与"首个是干净值"的场景（上方 tabDupResult）结果一致，证明
  //   canonical 化不依赖"谁先出现"这个偶然顺序。
  const dirtyFirstResult = siNormalizeCommitRefs(['  22853\t', '22853']);
  assert.deepStrictEqual(dirtyFirstResult, ['22853'],
    `[Y2] ⭐⭐ L1 对照·首个为脏值：['  22853\\t','22853'] 应去重为 1 条 canonical 值 '22853'（非带隐形字符的原值），实得 ${JSON.stringify(dirtyFirstResult)}`);
  // 既有契约不得被破坏：null/undefined→null，[]/'[]'→[]（回归，同页面 [T6] 但落在后端守卫里再钉一次）
  assert.strictEqual(siNormalizeCommitRefs(null), null, '[Y2] 回归：null 仍应返回 null（不因本次改动被误改）');
  assert.deepStrictEqual(siNormalizeCommitRefs([]), [], "[Y2] 回归：空数组仍应返回 []（不因本次改动被误改）");
  ok('[Y2] ⭐⭐ 前端 siNormalizeCommitRefs 真实执行验证：含重复输入保序首现去重、JSON 字符串入参同理、干净数据不受影响、既有 null/[] 契约不变');

  // ── [Y3] 对照组：证明 [Y1]/[Y2] 判据不是恒真 ─────────────────────────────
  console.log('  -- [Y3] 对照组 --');
  // ★对照组①：注释里提到去重关键字不应被误判——证明 stripSqlLineComments 确实生效，
  //   不会让本次新写的契约注释（含"不得 DISTINCT"这类措辞）把 [Y1] 拖成假红。
  const commentOnlyFake = `
                (SELECT json_group_array(commit_ref) FROM (
                   -- 本行注释提到 DISTINCT/GROUP BY 只是解释不能用，不是真的用了
                   SELECT commit_ref FROM sys_issue_dev_commits
                    WHERE issue_id = sys_issues.id
                 )) AS all_commit_refs`;
  assert.ok(!hasRawDedupKeyword(commentOnlyFake),
    '[Y3] ★对照组①：注释里提到去重关键字不应被误判为真去重（剥注释逻辑生效），若这条断言本身失败说明剥注释坏了');
  ok('[Y3] ★对照组①：注释文本提及去重关键字不会误触发 [Y1]（剥注释逻辑证实有效，不会让本次新写的契约注释把自己拖成假红）');
  // ★对照组②：真的注入 DISTINCT/GROUP BY 到 SQL 正文时，[Y1] 的判据必须能抓到——分别造两种注入
  const distinctInjectedFake = commitAggSeg.replace('SELECT commit_ref FROM sys_issue_dev_commits', 'SELECT DISTINCT commit_ref FROM sys_issue_dev_commits');
  assert.ok(hasRawDedupKeyword(distinctInjectedFake),
    '[Y3] ★对照组②a：真实注入 SELECT DISTINCT 后，判据必须判定为「含去重关键字」（若这条断言失败，说明 [Y1] 的检测逻辑形同虚设）');
  const groupByInjectedFake = commitAggSeg + '\n GROUP BY commit_ref';
  assert.ok(hasRawDedupKeyword(groupByInjectedFake),
    '[Y3] ★对照组②b：真实注入 GROUP BY 后，判据同样必须判红');
  // [SD1 二轮预筛 MED-3 收口] UNION 双向对照——②a/②b 只验证了 DISTINCT/GROUP BY 两个关键字，UNION
  //   是判据里新加的第三个分支（LOW-2①），必须单独证明：裸 UNION 判红、UNION ALL 不判红（不是随手
  //   加了正则就当完事，两个方向都要有反例）。
  const unionInjectedFake = commitAggSeg + '\nUNION SELECT 1';
  assert.ok(hasRawDedupKeyword(unionInjectedFake),
    '[Y3] ★对照组②c：真实注入裸 UNION 后，判据必须判定为「含去重关键字」（UNION 默认对结果集去重，是 DISTINCT/GROUP BY 之外的第三种偷偷去重手法）');
  const unionAllInjectedFake = commitAggSeg + '\nUNION ALL SELECT 1';
  assert.ok(!hasRawDedupKeyword(unionAllInjectedFake),
    '[Y3] ★对照组②d：真实注入 UNION ALL 后，判据不应判红——UNION ALL 保留全部行（含重复），不去重，若判据把它也拦下就是过度收紧，会拦住合法写法');
  ok('[Y3] ★对照组②：真实注入 DISTINCT / GROUP BY / 裸UNION 到 SQL 正文时，[Y1] 判据均能正确判红；UNION ALL 不误判——三正一反四个方向全覆盖（证明不是恒真通过的假守卫）');
  // ★对照组③：改动前的旧实现（只过滤空白、不去重）在同一份重复输入上，与新实现结果不同——
  //   证明 [Y2] 的期望值确实是"改动后才成立"的行为，不是巧合般恒真。
  const OLD_KEEP_ONLY_SRC = `function siNormalizeCommitRefs(raw) {
      if (raw == null) return null;
      const keep = (a) => a.filter(x => typeof x === 'string' && x.trim() !== '');
      if (Array.isArray(raw)) return keep(raw);
      if (typeof raw !== 'string') return null;
      const s = raw.trim();
      if (s === '') return null;
      try { const parsed = JSON.parse(s); return Array.isArray(parsed) ? keep(parsed) : null; } catch (_) { return null; }
    }`;
  // eslint-disable-next-line no-new-func
  const oldImplFn = new Function(`return (${OLD_KEEP_ONLY_SRC});`)();
  const oldResult = oldImplFn(dupInput);
  assert.deepStrictEqual(oldResult, dupInput.filter((x) => x.trim() !== ''),
    '[Y3] ★对照组③ 前置：旧实现（改动前的样子）应原样保留重复（不去重），验证反例本身构造正确');
  assert.notDeepStrictEqual(oldResult, dedupResult,
    `[Y3] ★对照组③：旧实现（未去重）在同一输入 ${JSON.stringify(dupInput)} 上的结果 ${JSON.stringify(oldResult)} 应与新实现的去重结果 ${JSON.stringify(dedupResult)} 不同——证明 [Y2] 的期望值不是恒真，若把当前实现换回旧版，[Y2] 会真的判红`);
  ok('[Y3] ★对照组③：改动前的旧实现（只过滤空白不去重）在同一份重复输入上产出与新实现不同的结果，证明 [Y2] 判据具备判别力，不是形同虚设的恒真检查');

  // [SD1 二轮预筛 LOW-7 收口] ★对照组④：正向注入证明 refsByComponentSeg 真参与判定——[Y1b] 此前
  //   只断言"抽取出的段落不含关键字"，没有反证"这段抽取确实被判据检查过"（万一 idxRefsByComponent/
  //   rbcEnd 抽偏了、抽出一段空字符串或无关文本，`!hasRawDedupKeyword('')` 一样恒真通过，[Y1b] 会
  //   变成形同虚设的假绿）。直接在抽取出的真实段落后面注入 SQL DISTINCT，若判据仍不判红，说明抽取
  //   或判据其中一环出了问题。
  const refsByComponentDistinctInjected = refsByComponentSeg + '\n// SELECT DISTINCT 1';
  assert.ok(hasRawDedupKeyword(refsByComponentDistinctInjected),
    '[Y3] ★对照组④：refsByComponentSeg 注入 SELECT DISTINCT 后，[Y1b] 的 SQL 关键字判据必须判红——证明抽取出的段落是真实参与判定的文本，不是抽偏了的空转判据');
  ok('[Y3] ★对照组④：refsByComponentSeg 抽取段真实参与 [Y1b] 判定（正向注入 DISTINCT 后判据能命中，非抽偏了的空转假绿）');

  // [SD1 二轮预筛 MED-4 收口] ★对照组⑤：JS 去重形状判据的注入反证——分别注入 new Set()/.indexOf()，
  //   证明 hasJsDedupShape 不是恒假的摆设。
  const refsByComponentSetInjected = refsByComponentSeg.replace('return commits', 'const seen = new Set(); return commits');
  assert.ok(hasJsDedupShape(refsByComponentSetInjected),
    '[Y3] ★对照组⑤a：refsByComponentSeg 注入 new Set() 后，JS 去重形状判据必须判红');
  const refsByComponentIndexOfInjected = refsByComponentSeg.replace('.map(c => c.commit_ref)', '.filter((x, i, a) => a.indexOf(x) === i).map(c => c.commit_ref)');
  assert.ok(hasJsDedupShape(refsByComponentIndexOfInjected),
    '[Y3] ★对照组⑤b：refsByComponentSeg 注入 .indexOf() 去重手法后，JS 去重形状判据必须判红');
  ok('[Y3] ★对照组⑤：真实注入 new Set() / .indexOf() 两种 JS 去重手法后，[Y1b] 的 JS 去重形状判据均能正确判红（证明不是恒假通过的假守卫）');

  // [SD1 二轮预筛 LOW-1② 收口] ★守卫：全仓扫描 INSERT INTO sys_issue_dev_assignees，每处列清单必须
  //   含 round_no（D 组件①·round_no 单据级轮次·2026-08-12）——防未来新增/复制粘贴写点漏带该列，
  //   悄悄产生"表里多一行 round_no 恒 NULL"的半成品写点。扫描面非空校验：抓到 0 处 INSERT 本身就是
  //   守卫空转（比如以后 SQL 写法整体重构成 ORM/公共仓储函数，正则再也抓不到字面量），必须先判红
  //   逼人来更新本守卫，不能悄悄通过。
  {
    const ROOT_DA = path.join(__dirname, '..');
    // ⚠️ 扫描范围刻意**不是**"routes/ 全量 + 排除 scripts/"（verify-sys-intake-gate.js [I] 那种排除
    //   全部 scripts/ 的写法在这里不适用）：LOW-1① 修的 backfill-sys-deadlock-reopen-round.js 本身就
    //   在 scripts/ 下、且真实写生产 sys_issue_dev_assignees 表（打回死锁存量修复，会被人在生产库上
    //   实跑 --apply）——若照抄"排除整个 scripts/"，本守卫会连它一起排除掉，[Y4] 就防不住"LOW-1① 这条
    //   修复被后人改回去漏 round_no"这个最直接的回归场景，等于守卫没守住它本该守的那个点。
    //   scripts/ 下其余 test-*/verify-*/_demo-* 文件是测试夹具（如 mkMember 系列 helper），故意用与
    //   生产写点不同的精简列集是正常设计，不该被本守卫误判——故 scripts/ 只白名单式收录这一个真实
    //   生产写点脚本，不做目录级全排除或全收录。
    const SCAN_TARGETS_DA = [
      path.join(ROOT_DA, 'routes'),
      path.join(ROOT_DA, 'scripts', 'backfill-sys-deadlock-reopen-round.js'),
    ];
    const walkDA = (p) => {
      const st = fs.statSync(p);
      if (st.isFile()) return p.endsWith('.js') ? [p] : [];
      return fs.readdirSync(p, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walkDA(path.join(p, e.name)) : (e.name.endsWith('.js') ? [path.join(p, e.name)] : []));
    };
    const daSrcs = SCAN_TARGETS_DA.flatMap(walkDA).map(f => ({ f, s: fs.readFileSync(f, 'utf8') }));
    // 匹配 "INSERT INTO sys_issue_dev_assignees (列清单)"——列清单跨行常见（本仓大量写点都换行排列），
    // 用 [^)]* 抓到右括号为止（sys_issue_dev_assignees 表列清单里没有函数调用，不会有内嵌括号）。
    const DA_INSERT_RE = /insert\s+(?:or\s+\w+\s+)?into\s+sys_issue_dev_assignees\s*\(([^)]*)\)/gi;
    const daInserts = [];
    for (const { f, s } of daSrcs) {
      let m;
      DA_INSERT_RE.lastIndex = 0;
      while ((m = DA_INSERT_RE.exec(s))) {
        daInserts.push({ file: path.relative(ROOT_DA, f), cols: m[1] });
      }
    }
    assert.ok(daInserts.length > 0,
      '[Y4] 前置：扫描面非空校验——全仓应能扫到 ≥1 处 "INSERT INTO sys_issue_dev_assignees(...)"，抓到 0 处说明写法已变（如改用 ORM/公共仓储函数），正则失效不能静默通过，需人工更新本守卫的扫描方式');
    for (const ins of daInserts) {
      assert.ok(/round_no/i.test(ins.cols),
        `[Y4] ⭐ ${ins.file} 的 INSERT INTO sys_issue_dev_assignees 列清单未含 round_no（D 组件①写侧物化契约要求全部写点同步写入）：(${ins.cols.trim()})`);
    }
    ok(`[Y4] 全仓 INSERT INTO sys_issue_dev_assignees 共 ${daInserts.length} 处（跨 ${new Set(daInserts.map(x => x.file)).size} 个文件），列清单均含 round_no——D 组件①写侧物化契约全仓一致`);

    // ★对照组：注入一处"漏带 round_no"的假写点，判据必须能抓到（证明不是恒真通过的假守卫）
    const missingRoundNoSample = daInserts[0];
    const strippedCols = missingRoundNoSample.cols.replace(/,?\s*round_no/i, '');
    assert.ok(!/round_no/i.test(strippedCols),
      '[Y4] ★对照组 前置：构造"去掉 round_no"的假列清单应确实不含 round_no（验证反例本身构造正确）');
    assert.ok(/round_no/i.test(missingRoundNoSample.cols) && !/round_no/i.test(strippedCols),
      `[Y4] ★对照组：真实源列清单含 round_no、人为去掉后的假列清单不含——两者对照证明判据具备判别力，若把任一真实写点的 round_no 删掉，[Y4] 会真的判红`);

    // [codex 355 三轮插入批 L2·仅注释｜D-fix2 MED-3② 收窄措辞] [Y4] 是正则字符串匹配的静态扫描，如实
    //   登记局限：若未来 index.js 内 INSERT INTO sys_issue_dev_assignees 的 7 个写点被重构成动态拼接
    //   SQL（如按条件数组拼列名）或收敛进一个公共仓储函数（如 insertDevAssignee(cols)），本条正则会
    //   失配——要么抓不到（daInserts 为空，[Y4] 前置的"扫描面非空校验"会先判红逼人来更新）、要么抓到
    //   的是拼接模板而非最终列清单（列清单检查可能误判）。这类"对动态 SQL/公共 helper 重构"的脆弱性，
    //   本条静态守卫**不打算**用更复杂的正则/AST 解析去堵——真正兜住这类重构后回归的是**行为级**防线，
    //   但两类写点的兜底组合**不同**（[Y4] 本身只扫 index.js，覆盖范围不含 scripts/ 下的独立进程脚本，
    //   下面按写点位置分开写，不再笼统声称"每个写点"）：
    //     · **index.js 内的 7 个写点**：M2a（index.js `assertValidRoundNo`，挂在每个写点入口/computed
    //       处，与这 7 个写点同进程同函数可 require）——即使 INSERT 语句本身被重构到扫描面之外，只要
    //       写入路径仍会算出 round_no 并落库，运行时断言依然拦得住非法值。
    //     · **scripts/ 下的独立写点**（backfill-sys-dev-assignee-round.js 的 UPDATE、
    //       backfill-sys-deadlock-reopen-round.js 的 INSERT）：这两个脚本是独立 Node 进程直连
    //       sqlite3，不 require index.js、够不着 M2a——**不受 M2a 覆盖**。防线换成脚本自己内联的合法性
    //       校验（backfill-sys-deadlock-reopen-round.js 已在 INSERT 前内联同款正整数判据，见该文件
    //       [D-fix2 MED-3①]；backfill-sys-dev-assignee-round.js 有 M2b 写后探针，见该文件 COMMIT 前
    //       的 scanIllegalRoundNo 复验）。
    //     · **两类写点共同兜底**：M2c（下方 [Y5]）数据探针 + 端到端套件
    //       （test-sys-commit-cols-playwright.js/test-sys-detail-ux-playwright.js 的 round_no 相关
    //       用例）——直接断言"数据库里躺着的值"和"页面真实渲染出的文案"，不关心中间写法怎么变、也不
    //       关心写点在哪个进程，重构后若真的漏写 round_no，这两层会在"结果不对"层面抓到，而不必依赖
    //       "源码文本长得像不像我认识的样子"。
    //   ——静态扫描（[Y4]）+ index.js 运行时断言（M2a）+ scripts/ 脚本内联校验（各脚本自身）+ 数据探针
    //   （M2c/[Y5]）+ 端到端套件，合起来才是完整防线，任何单一层都不该被当成唯一防线来加固。
  }

  // ═══ [Y5]（codex 355 三轮插入批 M2c）round_no 合法性数据探针 ═══
  //   双向证明：① 先在本文件既有内存测试库注入一条非法值，证明判据本身能判红（不是恒 0 的摆设）；
  //   ② 再对真实本地库（task_pool.db）跑同一条查询，断言非法非 NULL round_no 计数=0——这是对 M2a
  //   （写点运行时断言）+ M2b（回填脚本写后探针）两层防线的实际验收：若那两层真的堵住了缺口，本地
  //   库现在不该有任何非法值。
  console.log('\n── [Y5]（M2c）round_no 合法性数据探针 ──');
  let y5EnvSkipped = false;   // [D-fix2 LOW-6] 真实库断言是否因环境原因（无 task_pool.db / round_no 列未就绪）被跳过
  {
    const ILLEGAL_ROUND_NO_SQL = `SELECT COUNT(*) AS c FROM sys_issue_dev_assignees
       WHERE round_no IS NOT NULL AND (typeof(round_no) != 'integer' OR round_no < 1)`;

    // ★对照组：内存库注入一条非法值（round_no=0，<1 非法），证明查询判据具备判别力
    // [D-fix2 LOW-7] issue 行改直接调 mkIssue（本文件头部已有的同一份 INSERT），不再另写一份同源副本——
    //   两处一旦漂移（如 mkIssue 加了新必填列而这里没同步），本处会先于 mkIssue 的调用方悄悄产出一行
    //   字段不全的夹具，且没人会想到来这里比对。dev_assignees 行仍手写：mkMember 不支持传 round_no
    //   （它的 INSERT 列清单里根本没有这一列），本探针恰恰需要显式注入非法值 0，两者诉求不同不能复用。
    const injectIssueId = await mkIssue('Y5-探针注入对照');
    const injectDaId = (await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, round_no)
       VALUES (?, 99, 'Y5探针注入', 0, 'pending', 0)`, [injectIssueId])).lastID;
    const injectedCount = (await get(ILLEGAL_ROUND_NO_SQL)).c;
    assert.ok(injectedCount > 0,
      `[Y5] ★对照组：内存库注入 round_no=0（非法值）后，判据应能判红（计数>0），实得 ${injectedCount}——若这条断言本身失败，说明判据 SQL 有问题，下面对真实库的"计数=0"断言不可信`);
    ok(`[Y5] ★对照组：内存库注入 1 条 round_no=0 的非法行后，判据正确判红（计数=${injectedCount}），证明判据具备判别力`);
    // 清理注入行，不污染本文件后续任何断言
    await run(`DELETE FROM sys_issue_dev_assignees WHERE id = ?`, [injectDaId]);
    await run(`DELETE FROM sys_issues WHERE id = ?`, [injectIssueId]);
    const cleanedCount = (await get(ILLEGAL_ROUND_NO_SQL)).c;
    assert.strictEqual(cleanedCount, 0, `[Y5] 前置：清理注入行后内存库应恢复 0，实得 ${cleanedCount}（清理本身失败会污染后续断言）`);

    // 真实本地库（task_pool.db）——独立只读连接，用完即关，不与本文件其余测试共用连接
    // [D-fix2 LOW-6] 环境相关的跳过分支不许悄悄同绿——两处 console.log 改 ⚠️ 前缀，并用 y5EnvSkipped
    //   标记供末尾总结行读取，在"全部通过"横幅之外再单独喊一句「该条环境相关」，防止有人扫一眼绿色
    //   summary 就以为 [Y5] 的真实库断言真的跑过了。
    const realDbPath = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath)) {
      const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const realGet = (sql) => new Promise((resolve, reject) => realDb.get(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realCols = await realAll(`PRAGMA table_info(sys_issue_dev_assignees)`);
      if (realCols.some(c => c.name === 'round_no')) {
        const realIllegalCount = (await realGet(ILLEGAL_ROUND_NO_SQL)).c;
        assert.strictEqual(realIllegalCount, 0,
          `[Y5] ⭐⭐ 真实本地库 sys_issue_dev_assignees 非法非 NULL round_no 计数应为 0（M2a 写点运行时断言 + M2b 回填脚本写后探针共同兜底），实得 ${realIllegalCount}`);
        ok('[Y5] ⭐⭐ 真实本地库（task_pool.db）round_no 合法性探针：非法非 NULL 计数=0（M2a/M2b 防线验收通过）');
      } else {
        y5EnvSkipped = true;
        console.log('  ⚠️ [Y5] （跳过真实库断言：round_no 列尚不存在，服务从未启动过完成 ALTER）');
      }
      await new Promise((resolve) => realDb.close(resolve));
    } else {
      y5EnvSkipped = true;
      console.log('  ⚠️ [Y5] （跳过真实库断言：本地未找到 task_pool.db）');
    }
  }

  server.close();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ commit 编码两列 后端契约验证通过（C1 列表端点 + C2 批次成员列表 + X1 跨端点一致性 + Y 展示层去重 + Y4 round_no 全仓写点守卫 + Y5 round_no 数据探针）`);
  // [D-fix2 LOW-6] "全部通过"横幅本身不区分"真的跑过"与"环境原因被跳过"——[Y5] 真实库那半条断言若被
  //   跳过，单独喊一句，不许它被绿色 summary 悄悄盖过去。
  if (y5EnvSkipped) {
    console.log('  ⚠️ 注意：[Y5] 真实本地库（task_pool.db）round_no 合法性断言本次未执行（该条环境相关——本地无 task_pool.db 或 round_no 列尚未就绪），以上"全部通过"不含这半条覆盖，请勿据此断言真实库已验收。');
  }
  console.log('  C1：A1 值协议(JSON数组) + A2 零命中[] + A3 前后端分流 + A4 录入顺序(+static 合同锁) + A5 ⭐含分号不错拆 + A6 含removed实例 + A7 多单隔离 + 既有字段回归');
  console.log('  C2：B1 live 分支 + B2 ⭐snapshot 防漂移(不回查 live) + B3 degraded 返回 null 不伪造 + B4 零 commit 返回 [] 对照 + B5 既有契约');
  console.log('  Y：Y1 后端不含去重关键字(含UNION) + Y1b 另一端覆盖(SQL关键字+JS去重形状) + Y2 ⭐⭐前端真实去重（eval 执行验证，含 L1 canonical 值+首个脏值对照）+ Y3 五组对照（剥注释不误判/真注入必判红含UNION双向/新旧实现结果不同/Y1b抽取真参与判定/JS去重形状注入必判红）+ Y4 round_no 全仓写点守卫（登记动态SQL重构脆弱性，兜底=M2a+M2c+端到端）+ Y5 round_no 数据探针（内存库注入判红对照 + 真实本地库计数=0）');
  process.exit(0);
})().catch(e => { console.error('\n[失败]', e && e.message); if (server) server.close(); process.exit(1); });
