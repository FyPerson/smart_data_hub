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

  server.close();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ commit 编码两列 后端契约验证通过（C1 列表端点 + C2 批次成员列表 + X1 跨端点一致性）`);
  console.log('  C1：A1 值协议(JSON数组) + A2 零命中[] + A3 前后端分流 + A4 录入顺序(+static 合同锁) + A5 ⭐含分号不错拆 + A6 含removed实例 + A7 多单隔离 + 既有字段回归');
  console.log('  C2：B1 live 分支 + B2 ⭐snapshot 防漂移(不回查 live) + B3 degraded 返回 null 不伪造 + B4 零 commit 返回 [] 对照 + B5 既有契约');
  process.exit(0);
})().catch(e => { console.error('\n[失败]', e && e.message); if (server) server.close(); process.exit(1); });
