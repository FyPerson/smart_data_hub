// verify-sys-derive-numbering.js —— 派生单子编号「#根_序」数据层核心（S12-a·方案 20260813_v1.8 §15.2/§15.5）
//
// 覆盖（每条用例注释「实现坏成什么样这条会红」；判定有两个相反失败方向的用例成对出现）：
//   [A] schema：三列 + 部分唯一索引存在
//   [B] 取号：连续派生 seq=1,2；删最高 seq 单后再派生不复用旧号（alloc 不下调·378-H2 核心正例）
//       + 对照组（模拟错误的 MAX(seq)+1 实现会复用旧号，证明本组用例真有判别力）
//   [C] 派生事务原子性：UNIQUE 冲突迫使 INSERT 失败 → 整体回滚（alloc 不留半升·无孤儿子单）
//   [H] 重开单不产生子编号（§15.1：重开是同单折返，不参与派生编号体系）
//   [D] 回填 fail-closed 逐类造例（半填×2/自引用/环/断链/超深/错根/seq非正）+ 合法未回填族正例
//       ——全部走独立 :memory: 最小 fixture 直调 classifySysDeriveNumbering（隔离于主 HTTP harness，
//       不污染其状态）；另附一条活体 harness 集成抽查（自引用写入真实库 → runSysMigration 熔断 → 修复 → 恢复）
//   [E] 380-H4'' 三补：删中间序号后重启不熔断（空洞合法）／删最高序号后重启再派生不复用／
//       首次回填事务中断不留半填族
//   [F] 首次回填确定性：同输入跑两次输出恒同
//   [G] 不变量探针双向证明：负例（独立 fixture 证「能检出」）+ 正例（活体库全库扫描零违例）
//   [H3] alloc 探针缺位置/值域校验（位置/类型/值域三类，各配探针负例；类型/值域两类另配活体取号路径
//       500+整体回滚验证——位置类无对应活体闸，取号路径结构上不读非根行的 alloc，如实登记不硬凑）
//   [I] backfill-sys-derive-root-seq.js 独立脚本子进程集成测试（零候选分支 fail-open 修复 + 索引核验/补建）
//
// 本批范围声明：display-no helper 与通知/timeline 接入是下一批 S12-b，本文件不覆盖。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const sysDeriveNumbering = require('../utils/sys-derive-numbering');   // RC-L2：直调真实逻辑，非复刻
const { extractFunctionBody } = require('./lib/extract-function-body');   // [S13 收口 LOW 追-6] DN8 段用

const SECRET = 'verify-sys-derive-numbering-secret';
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
// 供 [D]/[E] 的"重启后重新迁移"场景直调——与 waitReady 不同：这里手动重置 ready/error 再调用，
// 模拟服务重启时 runSysMigration 会重新跑一遍全部判定（真实生产重启即走这条路径）。
async function rerunMigration() {
  I.SYS_SCHEMA_STATE.ready = false;
  I.SYS_SCHEMA_STATE.error = null;
  await I.runSysMigration();
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

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
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

// bug 单 → 已上线（同 verify-sys-bug-derive.js seedBugToOnline 同款：直接 SQL 打状态，不依赖已退场的
// 上线编排端点，见该文件 :106-117 的注释背景）。
async function seedBugToOnline() {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部', description: 'verify 夹具', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, 'bug assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200);
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'derive-num-batch' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因' });
  assert.strictEqual(r.status, 200, `bug submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200);
  await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [id]);
  return id;
}
async function deriveBug(originId, extra = {}) {
  return call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
    { type: 'bug', title: extra.title || '派生单', system_name: 'BMS', source: '内部', derive_reason: extra.derive_reason || '需再核实' });
}
const rowOf = async (id) => get('SELECT derive_root_id, derive_seq, derive_seq_alloc, origin_issue_id FROM sys_issues WHERE id=?', [id]);

// ── [D]/[G] 独立最小 fixture：与主 harness `db` 完全隔离的 :memory: 库，仅含 classify/backfill/
//   探针函数实际会触达的列，供逐类造例——不污染活体 harness 的 readiness/HTTP 状态。
async function makeUnitDb() {
  const udb = new sqlite3.Database(':memory:');
  const urun = (sql, params = []) => new Promise((res, rej) => udb.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const uall = (sql, params = []) => new Promise((res, rej) => udb.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const uget = (sql, params = []) => new Promise((res, rej) => udb.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  await urun(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_issue_id INTEGER,
    derive_root_id INTEGER,
    derive_seq INTEGER,
    derive_seq_alloc INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  return { udb, urun, uall, uget, close: () => udb.close() };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] schema：三列 + 部分唯一索引存在 ═══
  {
    const cols = (await all(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
    for (const c of ['derive_root_id', 'derive_seq', 'derive_seq_alloc']) {
      assert.ok(cols.includes(c), `sys_issues 应含列 ${c}（实现坏成什么样这条会红：alterAddMissingCols 漏配该列或列名拼错）`);
    }
    const idxRow = await get(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`);
    assert.ok(idxRow, '部分唯一索引 idx_sys_issues_derive_root_seq 应存在（实现坏成什么样这条会红：迁移链未建索引或建索引步骤被熔断跳过）');
    assert.ok(/WHERE/i.test(idxRow.sql) && /derive_root_id/.test(idxRow.sql) && /derive_seq/.test(idxRow.sql),
      '索引应为 (derive_root_id,derive_seq) 上的部分索引（实现坏成什么样这条会红：误建成全表唯一索引会拒绝多个 root/seq 皆为 NULL 的非派生单共存）');
    ok('[A] 三列 + 部分唯一索引存在，索引 WHERE 子句正确限定非空');
  }

  // ═══ [B] 取号：连续派生 seq=1,2；删最高后再派生不复用；对照组证判别力 ═══
  let originB;
  {
    originB = await seedBugToOnline();
    let r = await deriveBug(originB, { title: '子单1' });
    assert.strictEqual(r.status, 201, `derive1 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const c1 = r.body.id;
    r = await deriveBug(originB, { title: '子单2' });
    assert.strictEqual(r.status, 201, `derive2 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const c2 = r.body.id;
    const row1 = await rowOf(c1), row2 = await rowOf(c2), rootRow = await rowOf(originB);
    assert.strictEqual(row1.derive_root_id, originB, '[B] 子单1 derive_root_id=族根');
    assert.strictEqual(row1.derive_seq, 1, '[B] 子单1 derive_seq=1（实现坏成什么样这条会红：取号从 0 起或未递增）');
    assert.strictEqual(row2.derive_root_id, originB, '[B] 子单2 derive_root_id=族根');
    assert.strictEqual(row2.derive_seq, 2, '[B] 子单2 derive_seq=2（连续递增，非重复取到 1）');
    assert.strictEqual(rootRow.derive_seq_alloc, 2, '[B] 族根 derive_seq_alloc 同步到 2（取号计数器与实际赋号一致）');

    // 删最高 seq 单（子单2）
    r = await call('DELETE', `/api/sys-issues/${c2}`, adminTok, { reason: '验证不复用取号' });
    assert.strictEqual(r.status, 200, `删除子单2 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rootAfterDelete = await rowOf(originB);
    assert.strictEqual(rootAfterDelete.derive_seq_alloc, 2, '[B] 删除子单不回调 derive_seq_alloc（378-H2：alloc 只增不减，删除不触碰它）');

    // 再派生：新号应为 3，而非复用刚被删除的 2
    r = await deriveBug(originB, { title: '子单3' });
    assert.strictEqual(r.status, 201, `derive3 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const c3 = r.body.id;
    const row3 = await rowOf(c3);
    assert.strictEqual(row3.derive_seq, 3, '[B] 378-H2 核心正例：删最高 seq 单后再派生 → 新号=3（不复用被删除的 2）');

    // 对照组：模拟错误实现（按 MAX(derive_seq)+1 重算，非本项目采用的 alloc 计数器）——若生产代码
    // 误用这条口径，删除子单2后 MAX(derive_seq)（此刻只剩子单1的 1）+1 = 2，与被删除的旧号重复。
    // 本行只是**独立计算**、不调用任何生产代码、不写库——纯粹用于证明"若实现选了错误路径，本组用例
    // 会抓到"（对照 [[feedback_probe_test_bidirectional_proof]]：不只证明正例，还证明判别力）。
    const naiveWouldBe = (await get(
      `SELECT COALESCE(MAX(derive_seq),0)+1 AS n FROM sys_issues WHERE derive_root_id=? AND id NOT IN (?)`,
      [originB, c3])).n;   // 排除刚新增的 c3 自身，模拟"删除子单2之后、派生子单3之前"那一刻的 MAX+1
    assert.ok(naiveWouldBe < row3.derive_seq,
      `[B] 对照组判别力：naive MAX+1 方案会算出 ${naiveWouldBe}（与被删除的旧号 2 重复），真实实现取到 ${row3.derive_seq}（严格更大，未复用）——若生产代码退化为 naive 方案，本行会红`);
    ok('[B] 取号：连续 seq=1,2；删最高后再派生=3（不复用）；alloc 删除不回调；对照组证明「若用 MAX+1 会复用旧号」的判别力');

    // [预筛 M3] 二级派生（活体，走真实端点/真实函数链）：把子单1（已是族成员，root=originB/seq=1）推进
    // 到「已上线」，再**从它**（而非从族根 originB）发起派生——断言新单 derive_root_id 落在**族根**
    // originB（非中间单 c1 的 id）、derive_seq 在同族序列里继续递增（非重新从 1 起算一个"子族"）、族根
    // alloc 同步 +1。这条正是 insertDerivedSysIssue 里 `origin.derive_root_id ?? originId` 分支的唯一
    // 覆盖点——此前只测过「从未被派生过的单再派生」（origin.derive_root_id 恒为 null，走 ?? 右侧），
    // 从未测过「从已经是派生单的单再派生」（origin.derive_root_id 非 null，走 ?? 左侧）；两处 SELECT
    // （manual derive 端点 :12921 一带 / post-release-accept fail 分支 :10473 一带）里任一处的
    // derive_root_id 投影被回退删除，本条会红（多跳继承退化为"以直接父为根"）。
    {
      await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [c1]);
      const allocBeforeL2 = (await rowOf(originB)).derive_seq_alloc;
      const rL2 = await deriveBug(c1, { title: '二级派生子单' });
      assert.strictEqual(rL2.status, 201, `[B-L2] 从已派生单 c1 再派生应 201, got ${rL2.status} ${JSON.stringify(rL2.body)}`);
      const c1_1 = rL2.body.id;
      const rowC1_1 = await rowOf(c1_1);
      assert.strictEqual(rowC1_1.derive_root_id, originB, '[B-L2] 二级派生新单 derive_root_id 应落在族根 originB（非中间单 c1 的 id）——实现坏成什么样这条会红：取号逻辑若误用 origin.id/originId 而非 origin.derive_root_id，这里会得到 c1 而非 originB');
      assert.strictEqual(rowC1_1.derive_seq, allocBeforeL2 + 1, '[B-L2] 二级派生 derive_seq 应在同族序列继续递增（非重新从 1 起算独立子族）');
      const rootAfterL2 = await rowOf(originB);
      assert.strictEqual(rootAfterL2.derive_seq_alloc, allocBeforeL2 + 1, '[B-L2] 族根 alloc 同步 +1（二级派生的计数器仍落在唯一的族根上，不是在 c1 上另起一份）');
      ok('[B-L2] 二级派生（活体）：从已派生子单再派生 → 新单 root=族根（非中间单）+ seq 同族继续递增 + 族根 alloc 同步 +1');
    }
  }

  // ═══ [C] 派生事务原子性：UNIQUE 冲突迫使 INSERT 失败 → 整体回滚 ═══
  {
    const originC = await seedBugToOnline();
    let r = await deriveBug(originC, { title: '正常子单' });
    assert.strictEqual(r.status, 201);
    const normalChild = r.body.id;
    const rootBefore = await rowOf(originC);
    assert.strictEqual(rootBefore.derive_seq_alloc, 1, '[C] 前置：族根 alloc=1（唯一一个正常子单）');

    // 制造冲突：借用另一张无关单（新建一张 feature 待受理单即可，不必与本族有血缘），直接把它的
    // derive_root_id/derive_seq 手工改成 (originC, 2)——伪装成"占了 originC 族第2号位"，模拟 UNIQUE
    // 索引冲突场景（真实生产下该冲突结构性不可达，此处人为构造仅为验证纵深防线本身生效）。
    const poisonR = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '占位污染单', system_name: 'BMS', source: '内部', description: 'verify 夹具', intake_liaison_id: 13 });
    const poisonId = poisonR.body.id;
    await run(`UPDATE sys_issues SET derive_root_id=?, derive_seq=2 WHERE id=?`, [originC, poisonId]);

    r = await deriveBug(originC, { title: '本应撞号的子单' });
    assert.strictEqual(r.status, 409, `[C] UNIQUE 冲突应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SYS_DERIVE_SEQ_CONFLICT', '[C] 冲突码精确映射（实现坏成什么样这条会红：INSERT 异常未被捕获，穿透成 500 INTERNAL_ERROR）');

    const rootAfterConflict = await rowOf(originC);
    assert.strictEqual(rootAfterConflict.derive_seq_alloc, 1, '[C] 整体回滚：alloc 未留在被冲突打断前刚写入的 2（不留半升状态）——实现坏成什么样这条会红：若 alloc UPDATE 与 INSERT 不在同一事务，这里会看到 alloc=2 但无对应新子单（半态）');
    const childCountAfter = (await get('SELECT COUNT(*) c FROM sys_issues WHERE origin_issue_id=?', [originC])).c;
    assert.strictEqual(childCountAfter, 1, '[C] 无孤儿子单：冲突后族内子单数仍是 1（只有最初的正常子单）');

    // 清理污染，恢复干净状态（供后续 [G] 正例全库扫描使用）
    await run(`UPDATE sys_issues SET derive_root_id=NULL, derive_seq=NULL WHERE id=?`, [poisonId]);
    const poisonAfterCleanup = await rowOf(poisonId);
    assert.strictEqual(poisonAfterCleanup.derive_root_id, null, '[C] 清理：污染单已复原');
    ok('[C] 派生事务原子性：UNIQUE 冲突 → 409 SYS_DERIVE_SEQ_CONFLICT + alloc 回滚不留半升 + 无孤儿子单');
  }

  // ═══ [H3] alloc 探针缺位置/值域校验 + 取号前置类型闸 ═══
  {
    // ① 位置违例（探针）：派生单自身（derive_root_id 非空）不得持有 alloc——alloc 只属族根。
    //   本类无对应的取号路径活体闸：insertDerivedSysIssue 的取号只读写 `deriveRoot` 这一行自身的
    //   derive_seq_alloc（deriveRoot 恒是"origin.derive_root_id 已继承的真根"或"origin 自身"，两条
    //   路径解析出的 deriveRoot 结构上永远是 derive_root_id 为空的原生单），一个"非根却带 alloc"的
    //   脏行不会被取号路径按 id 命中读取到——这类违例只能被只读探针在健康检查/迁移时刻捕获，如实登记
    //   而非勉强拼一条打不到点上的活体用例。
    {
      const u = await makeUnitDb();
      // 族根 R 自身给一个合法 alloc（=1，与 badIns 的 derive_seq 对齐）——隔离变量：不这样做的话 R
      // 会因为"有子单(badIns, seq=1)却自身 alloc 未初始化"额外触发既有的数量关系违例，混进本条只想
      // 单独测的"位置"维度，让断言的 1 条变成 2 条，测不准到底是哪个判据在起作用。
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, 1)`);
      const rootId = rootIns.lastID;
      const badIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq, derive_seq_alloc) VALUES (?, ?, 1, 5)`, [rootId, rootId]);
      const c = await sysDeriveNumbering.findAllocInvariantViolations(u.uall);
      assert.strictEqual(c.length, 1, 'H3① 位置违例应判 1 条（实现坏成什么样这条会红：探针未校验"该行是否是派生单"这个维度，只看数量关系时会漏判）');
      assert.strictEqual(c[0].id, badIns.lastID, 'H3① 违例清单含目标 id（派生单自身，非族根）');
      assert.ok(/自身持有|派生单/.test(c[0].reason), `H3① 违例原因文案应说明"派生单不得持有 alloc"，实得：${c[0].reason}`);
      u.close();
      ok('[H3①] alloc 位置违例（探针）：派生单自身持有 derive_seq_alloc 被判违例且含目标 id');
    }

    // ② 类型违例（探针 + 活体取号路径）：typeof(derive_seq_alloc) 不是 integer/null。
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, 'abc')`);
      const rootId = rootIns.lastID;
      const c = await sysDeriveNumbering.findAllocInvariantViolations(u.uall);
      assert.strictEqual(c.length, 1, 'H3② 类型违例应判 1 条');
      assert.strictEqual(c[0].id, rootId);
      assert.ok(/存储类型异常|typeof/.test(c[0].reason), `H3② 违例原因文案应说明类型异常，实得：${c[0].reason}`);
      u.close();
      ok('[H3②-探针] alloc 类型违例（探针）：文本值 typeof≠integer/null 被判违例');
    }
    {
      // 活体取号路径：把一个真实族根的 derive_seq_alloc 直连 SQL 改成文本值，再走真实 /derive 端点——
      // 断言 500（插入前置类型闸抛错）+ 事务整体回滚（root 的 alloc 值原样未动、无孤儿子单产生）。
      const originH3b = await seedBugToOnline();
      await run(`UPDATE sys_issues SET derive_seq_alloc = ? WHERE id = ?`, ['abc', originH3b]);
      const r = await deriveBug(originH3b, { title: 'H3②活体畸形取号' });
      assert.strictEqual(r.status, 500, `H3②活体：文本畸形 alloc 应致取号 500, got ${r.status} ${JSON.stringify(r.body)}`);
      const rootAfter = await get('SELECT derive_seq_alloc FROM sys_issues WHERE id=?', [originH3b]);
      assert.strictEqual(rootAfter.derive_seq_alloc, 'abc', 'H3②活体：整体回滚——UPDATE 从未真正执行，root 的畸形值原样未动（实现坏成什么样这条会红：若前置类型闸缺失，COALESCE(\'abc\',0)+1 会把畸形值静默"洗白"成 1，这里会看到 1 而非原样 abc）');
      const childCnt = (await get('SELECT COUNT(*) c FROM sys_issues WHERE origin_issue_id=?', [originH3b])).c;
      assert.strictEqual(childCnt, 0, 'H3②活体：无孤儿子单（INSERT 从未执行到）');
      // 清理污染（同 [C] 小节先例）：畸形 alloc 若遗留在活体库里，会让后续 [G]/[D9] 等全库扫描/重跑
      // 迁移的断言误撞上本组人为构造的脏值。
      await run(`UPDATE sys_issues SET derive_seq_alloc = NULL WHERE id = ?`, [originH3b]);
      ok('[H3②-活体] 类型违例活体取号路径：文本畸形 alloc → 500 + 整体回滚（root 原值未动 + 无孤儿子单）');
    }

    // ③ 值域违例（探针 + 活体取号路径，复用既有 deriveSeq<=0 检查——本批之前已有，非 H3 新增代码，
    //   但此前从未有 verify 直接证过它在取号路径上真的生效）。
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, -3)`);
      const rootId = rootIns.lastID;
      const c = await sysDeriveNumbering.findAllocInvariantViolations(u.uall);
      assert.strictEqual(c.length, 1, 'H3③ 值域违例应判 1 条');
      assert.strictEqual(c[0].id, rootId);
      assert.ok(/≤\s*0|非正/.test(c[0].reason), `H3③ 违例原因文案应说明"非正整数"，实得：${c[0].reason}`);
      u.close();
      ok('[H3③-探针] alloc 值域违例（探针）：负值被判违例');
    }
    {
      const originH3c = await seedBugToOnline();
      await run(`UPDATE sys_issues SET derive_seq_alloc = -5 WHERE id = ?`, [originH3c]);
      const r = await deriveBug(originH3c, { title: 'H3③活体畸形取号' });
      assert.strictEqual(r.status, 500, `H3③活体：负值畸形 alloc 应致取号 500, got ${r.status} ${JSON.stringify(r.body)}`);
      const rootAfter = await get('SELECT derive_seq_alloc FROM sys_issues WHERE id=?', [originH3c]);
      assert.strictEqual(rootAfter.derive_seq_alloc, -5, 'H3③活体：整体回滚——UPDATE 已执行过（COALESCE(-5,0)+1=-4）但取号后验（deriveSeq<=0）抛错触发事务回滚，root 应恢复原值 -5（非停在中间态 -4）');
      const childCnt = (await get('SELECT COUNT(*) c FROM sys_issues WHERE origin_issue_id=?', [originH3c])).c;
      assert.strictEqual(childCnt, 0, 'H3③活体：无孤儿子单');
      // 清理污染（同上）：负值 alloc 遗留会让后续全库不变量扫描误报。
      await run(`UPDATE sys_issues SET derive_seq_alloc = NULL WHERE id = ?`, [originH3c]);
      ok('[H3③-活体] 值域违例活体取号路径：负值畸形 alloc → 500 + 整体回滚（root 恢复原值 -5，非停在中间态 -4 + 无孤儿子单）');
    }
  }

  // ═══ [H] 重开单不产生子编号（§15.1：重开是同单折返，不参与派生编号）═══
  {
    const originH = await seedBugToOnline();
    const totalBefore = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    let r = await call('POST', `/api/sys-issues/${originH}/close`, adminTok, {});
    assert.strictEqual(r.status, 200, `close 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${originH}/reopen`, adminTok, { reason: '验证重开不产生子编号' });
    assert.strictEqual(r.status, 200, `reopen 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const totalAfter = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    assert.strictEqual(totalAfter, totalBefore, '[H] 重开不新增行（对照派生：派生会 +1 行，重开必须是同单折返=0 行变化）');
    const selfRow = await rowOf(originH);
    assert.strictEqual(selfRow.derive_root_id, null, '[H] 重开单自身 derive_root_id 仍为 NULL（非派生单不应有此列值）');
    assert.strictEqual(selfRow.derive_seq, null, '[H] 重开单自身 derive_seq 仍为 NULL');
    const reopenCount = (await get('SELECT reopen_count c FROM sys_issues WHERE id=?', [originH])).c;
    assert.strictEqual(reopenCount, 1, '[H] reopen_count 正常递增（既有行为不受本批改动影响）');
    ok('[H] 重开单不产生子编号：总行数不变 + 自身 root/seq 仍 NULL（与派生形成对照：派生 +1 行 + 落号，重开 0 行 + 不落号）');
  }

  // ═══ [D] 回填 fail-closed 逐类造例（独立 :memory: fixture，隔离于活体 harness）═══
  {
    // D1a：半填——root 非空 seq 空
    {
      const u = await makeUnitDb();
      const rIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (NULL, 5, NULL)`);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D1a 半填应判违例');
      assert.strictEqual(c.violations.halfFilled.length, 1, 'D1a 恰 1 条半填违例');
      assert.strictEqual(c.violations.halfFilled[0].id, rIns.lastID, 'D1a 违例清单含目标 id（实现坏成什么样这条会红：只报数量不报具体 id，人工核实无从下手）');
      u.close();
    }
    // D1b：非派生单（origin 为空）却 root/seq 双非空——同归半填桶，note 字段区分具体原因
    {
      const u = await makeUnitDb();
      const rIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (NULL, 7, 1)`);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D1b 应判违例');
      assert.strictEqual(c.violations.halfFilled.length, 1);
      assert.strictEqual(c.violations.halfFilled[0].id, rIns.lastID);
      assert.ok(c.violations.halfFilled[0].note, 'D1b note 说明"非派生单不应有 root/seq"（实现坏成什么样这条会红：非派生单被错误当成合法族成员参与分配）');
      // [预筛 L1] note 不能只停在内部结构化字段——formatViolationSummary 输出的才是运维/503 响应实际
      //   读到的那句话；此前该函数只拼 label（"半填（root/seq 仅一列非空）"），D1b 这类"非派生单却带
      //   root/seq"的真实原因会被通用标题字面误导（运维会去找"是不是漏填了一列"，而不是去查"这行本不该
      //   有值"）。断言用户可见文案本身含 note 内容，而不只是内部字段存在。
      const summaryText = sysDeriveNumbering.formatViolationSummary(c.violations);
      assert.ok(summaryText.includes('非派生单'), `D1b formatViolationSummary 输出应含 note 关键内容（用户可见那句话），实得：${summaryText}`);
      u.close();
    }
    // D2：自引用
    {
      const u = await makeUnitDb();
      const rIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const selfId = rIns.lastID;
      await u.urun(`UPDATE sys_issues SET origin_issue_id=? WHERE id=?`, [selfId, selfId]);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D2 自引用应判违例');
      assert.strictEqual(c.violations.selfReference.length, 1);
      assert.strictEqual(c.violations.selfReference[0].id, selfId, 'D2 违例清单含目标 id');
      u.close();
    }
    // D3：环（长度2）
    {
      const u = await makeUnitDb();
      const dIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const dId = dIns.lastID;
      const eIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [dId]);
      const eId = eIns.lastID;
      await u.urun(`UPDATE sys_issues SET origin_issue_id=? WHERE id=?`, [eId, dId]);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D3 环应判违例');
      assert.ok(c.violations.cycle.length >= 1, 'D3 至少 1 条环违例');
      const cycleIds = c.violations.cycle.map(v => v.id);
      assert.ok(cycleIds.includes(dId) || cycleIds.includes(eId), 'D3 违例清单含环上目标 id');
      u.close();
    }
    // D4：超深（>50 跳）
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      let prevId = rootIns.lastID;
      let lastId = prevId;
      for (let i = 0; i < 52; i++) {
        const ins = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [prevId]);
        lastId = ins.lastID;
        prevId = lastId;
      }
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D4 超深应判违例');
      assert.ok(c.violations.chainTooDeep.length >= 1, 'D4 至少 1 条超深违例');
      assert.ok(c.violations.chainTooDeep.some(v => v.id === lastId), 'D4 违例清单含链末端 id（实现坏成什么样这条会红：深度阈值判定用 >= 而非 >，或计数从 0 起导致差一错误漏判/误判边界）');
      u.close();
    }
    // [预筛 M4] D4b：恰好 50 跳（阈值边界正例，与 D4 的 52 跳负例成对）——链末端行需要恰好 50 跳才能
    //   求到根，depth=50 时不应判超深，应正常求根成功落入 toBackfill。此前 D4 只证明"跳数明显超过阈值
    //   会被抓"，不能排除阈值判定用了错误的比较符（如 `>=` 而非 `>`）导致把恰好等于阈值的合法边界链也
    //   误杀——补上这条正例后，D4 注释里"深度阈值判定用 >= 而非 >…会红"这句声称才真正成立，不是空话。
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      let prevId = rootId;
      let lastId50 = rootId;
      for (let i = 0; i < 50; i++) {
        const ins = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [prevId]);
        lastId50 = ins.lastID;
        prevId = lastId50;
      }
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.strictEqual(c.hasViolations, false, 'D4b 恰好 50 跳的链不应判任何违例');
      assert.strictEqual(c.violations.chainTooDeep.length, 0, 'D4b 零超深违例（实现坏成什么样这条会红：阈值判定用 >= 而非 >，会把恰好等于阈值的合法边界链也误杀成超深）');
      assert.strictEqual(c.toBackfill.length, 50, 'D4b 链上 50 个派生行应全部落入待回填候选（各自求根成功，跳数从 1 到 50 均未超阈值）');
      const lastEntry = c.toBackfill.find(x => x.id === lastId50);
      assert.ok(lastEntry, 'D4b 链末端（恰好 50 跳）行应在待回填清单里');
      assert.strictEqual(lastEntry.root, rootId, 'D4b 链末端求根结果正确指向真正的根');
      u.close();
      ok('[D4b] 恰好 50 跳（阈值边界正例）：零超深违例 + 全部 50 行正常落入待回填候选，与 D4 的 52 跳负例成对——阈值判定的差一错误双向都能抓');
    }
    // D5：断链（引用不存在的祖先）
    {
      const u = await makeUnitDb();
      const rIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (999999)`);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D5 断链应判违例');
      assert.strictEqual(c.violations.brokenChain.length, 1);
      assert.strictEqual(c.violations.brokenChain[0].id, rIns.lastID);
      u.close();
    }
    // D6：错根（稳态复核：已填行 stored root 与重算 root 不一致）
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const wrongIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, 999888, 1)`, [rootId]);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D6 错根应判违例');
      assert.strictEqual(c.violations.wrongRoot.length, 1);
      assert.strictEqual(c.violations.wrongRoot[0].id, wrongIns.lastID);
      assert.strictEqual(c.violations.wrongRoot[0].recomputed_root, rootId, 'D6 违例记录带重算出的正确根（供人工核对差异）');
      u.close();
    }
    // D7：seq 非正整数（稳态复核；root 本身正确，只有 seq 值非法）
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const badIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 0)`, [rootId, rootId]);
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.ok(c.hasViolations, 'D7 seq 非正应判违例');
      assert.strictEqual(c.violations.seqNonPositive.length, 1);
      assert.strictEqual(c.violations.seqNonPositive[0].id, badIns.lastID);
      assert.strictEqual(c.violations.wrongRoot.length, 0, 'D7 root 本身正确，不应误连带判成错根（两类违例互不误伤，各自独立判定）');
      u.close();
    }
    // D8：合法未回填族（379-H4' 正例）——origin 非空∧root/seq 双空∧链完整可求根 ⇒ 回填而非熔断
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const childIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [rootId]);
      const childId = childIns.lastID;
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.strictEqual(c.hasViolations, false, 'D8 合法未回填族不应判熔断（实现坏成什么样这条会红：v1.6 旧逻辑洞——把「origin 非空∧root/seq 双空」一律当异常，会导致首次上线永不 ready）');
      assert.strictEqual(c.toBackfill.length, 1, 'D8 恰 1 条待回填候选');
      assert.strictEqual(c.toBackfill[0].id, childId);
      assert.strictEqual(c.toBackfill[0].root, rootId, 'D8 求根结果正确');
      u.close();
    }
    // [预筛 M3] D8b：多跳干净族正例（root→A→B 三行链，A/B 均待回填）——断言两条 toBackfill 的 root
    //   均为顶层 root（而非 B 误算成"root=A"）。这是 D8（单跳）之外对多跳 walkDeriveChainRoot 结果被
    //   正确写进 toBackfill.root 字段的独立正例覆盖——D4/D4b 只证明"深度计数正确"，不证明"多跳场景下
    //   toBackfill 携带的 root 值本身正确"，两者是不同的断言面，此前零覆盖（正是本批投影修复的风险面：
    //   若两处 SELECT 或 walkDeriveChainRoot 的 root 回填值被误改成"直接父"，D4/D4b 仍会全绿）。
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const aIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [rootId]);
      const aId = aIns.lastID;
      const bIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [aId]);
      const bId = bIns.lastID;
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.strictEqual(c.hasViolations, false, 'D8b 干净三行族不应判熔断');
      assert.strictEqual(c.toBackfill.length, 2, 'D8b 恰 2 条待回填候选（A/B，root 本身非派生单不入候选）');
      const aEntry = c.toBackfill.find(x => x.id === aId);
      const bEntry = c.toBackfill.find(x => x.id === bId);
      assert.ok(aEntry && bEntry, 'D8b A/B 均应在待回填清单里');
      assert.strictEqual(aEntry.root, rootId, 'D8b A（直接子）求根=顶层 root');
      assert.strictEqual(bEntry.root, rootId, 'D8b B（间接孙）求根=顶层 root（非误算成 A 的 id）——实现坏成什么样这条会红：若多跳求根只返回"直接父"而非"真正顶层根"，这里会得到 aId 而非 rootId');
      u.close();
      ok('[D8b] 多跳干净族正例：root→A→B 三行链，A/B 待回填候选的 root 均正确指向顶层根（非中间单）');
    }
    // [预筛 H2] D8c：混杂族负例——同一族里 A 已完整回填（root=R,seq=1）+ B 全空待回填，应判 mixedFamily
    //   熔断而非像旧版"续号"设计那样把 B 自动接到 A 后面续填。§15.2 只定义了"全空族"（首次回填对象）
    //   与"已填稳态"（只读复核对象）两种合法族态，混杂态不在其中——遇到就该出清单交人工核实，不能自作
    //   主张续填（这正是本条要防的：旧续号逻辑会让这类数据静默"自愈"，掩盖了它本不该出现这一事实）。
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const aIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 1)`, [rootId, rootId]);
      const aId = aIns.lastID;
      const bIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [rootId]);
      const bId = bIns.lastID;
      const c = await sysDeriveNumbering.classifySysDeriveNumbering(u.uall, u.uget);
      assert.strictEqual(c.hasViolations, true, 'D8c 混杂族应判熔断（实现坏成什么样这条会红：mixedFamily 检测缺失或未接入 hasViolations，混杂态被当合法输入放行）');
      assert.strictEqual(c.violations.mixedFamily.length, 1, 'D8c 恰 1 条 mixedFamily 违例');
      const mf = c.violations.mixedFamily[0];
      assert.strictEqual(mf.id, rootId, 'D8c mixedFamily 违例记录的 id 应是族根');
      assert.ok(mf.note.includes(`#${rootId}`) && mf.note.includes(`#${aId}`) && mf.note.includes(`#${bId}`), `D8c 违例文案应含 root/已填成员/待填成员三方 id，实得：${mf.note}`);
      u.close();
      ok('[D8c] 混杂族负例：A 已填(root,1)+B 全空同族 → mixedFamily 熔断（含 root/A/B 三方 id），旧"续号"自动放行行为已收口');
    }
    // H2② 防御性断言直测：若调用方误传入非空 usedMax（跳过 mixedFamily 熔断直接调用赋号），
    //   planFirstBackfillAssignments 应结构性拒绝（throw），不再像旧版那样悄悄续号。
    {
      const toBackfillX = [{ id: 999, root: 500, created_at: '2026-08-14 10:00:00' }];
      assert.throws(
        () => sysDeriveNumbering.planFirstBackfillAssignments(toBackfillX, [{ id: 998, root: 500, seq: 1 }], new Map()),
        /结构性不可达|mixedFamily/,
        'H2② 防御性断言：usedMax>0 时 planFirstBackfillAssignments 应 throw（实现坏成什么样这条会红：若仍按旧"续号"逻辑放行，这里不会抛错，而是安静地把 999 号赋成 seq=2）'
      );
      ok('[H2-defense] planFirstBackfillAssignments 防御性断言：混杂输入（usedMax>0）直接 throw，不再自动续号');
    }
    ok('[D] 回填 fail-closed 逐类造例：半填×2/自引用/环/超深/断链/错根/seq非正 均判熔断且清单含目标 id；合法未回填族判回填非熔断（379-H4\' 正例）');

    // D9：活体 harness 集成抽查——证明 classify() 真的接线进了 runSysMigration 的 readiness 判定
    //   （上面 D1-D8 只证明纯函数本身正确，不证明迁移链真的调用了它；本条补上"调用点"这一环）。
    {
      const originD9 = await seedBugToOnline();
      const rD9 = await deriveBug(originD9, { title: 'D9子单' });
      const childD9 = rD9.body.id;
      const preCorruptSnapshot = await rowOf(childD9);   // 破坏前快照——供"修复"步骤精确复原（而非留白重回填）
      // 手工污染：把这个真实子单的 origin_issue_id 改到指向自身（自引用），root/seq 清空模拟"尚待回填"
      await run(`UPDATE sys_issues SET origin_issue_id=?, derive_root_id=NULL, derive_seq=NULL WHERE id=?`, [childD9, childD9]);
      await rerunMigration();
      assert.strictEqual(I.SYS_SCHEMA_STATE.ready, false, 'D9 活体库自引用应致 ready=false（实现坏成什么样这条会红：迁移链未真正调用 classifySysDeriveNumbering，或调用了但忽略其 hasViolations 结果）');
      assert.ok(I.SYS_SCHEMA_STATE.error && I.SYS_SCHEMA_STATE.error.includes(`#${childD9}`), `D9 熔断文案含目标 id #${childD9}，实得：${I.SYS_SCHEMA_STATE.error}`);
      // 修复：origin_issue_id 恢复 + root/seq 精确复原到破坏前的真实值——**不能**只留空指望"重新走首次
      // 回填"：originD9.derive_seq_alloc 早在首次真实派生时就已初始化过，若 childD9 的 root/seq 留空，
      // 会与 originD9 已初始化的 alloc 同时出现，恰好撞上 [预筛 H2] 新增的 mixedFamily 熔断——这不是
      // 误判，是 mixedFamily 按设计工作（这正是它要拦的"部分已填/已有 alloc + 部分待填"状态），只是
      // 本条测试的"修复"步骤必须把数据修复回破坏之前的真实状态，而非修复成另一个新的异常态。
      await run(`UPDATE sys_issues SET origin_issue_id=?, derive_root_id=?, derive_seq=? WHERE id=?`,
        [originD9, preCorruptSnapshot.derive_root_id, preCorruptSnapshot.derive_seq, childD9]);
      await rerunMigration();
      assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, 'D9 修复污染后重跑迁移应恢复 ready=true');
      ok('[D9] 活体 harness 集成抽查：自引用写入真实库 → runSysMigration 熔断且文案含目标 id → 修复 → 重跑恢复 ready');
    }
  }

  // ═══ [E] 380-H4'' 三补 ═══
  {
    // E1：删中间序号后重启不熔断（空洞合法）
    const originE = await seedBugToOnline();
    let r1 = await deriveBug(originE, { title: 'E-子单1' });
    let r2 = await deriveBug(originE, { title: 'E-子单2' });
    let r3 = await deriveBug(originE, { title: 'E-子单3' });
    const [e1, e2, e3] = [r1.body.id, r2.body.id, r3.body.id];
    assert.strictEqual((await rowOf(e2)).derive_seq, 2, 'E 前置：中间子单 seq=2');
    let del = await call('DELETE', `/api/sys-issues/${e2}`, adminTok, { reason: 'E1 删中间序号' });
    assert.strictEqual(del.status, 200, `E1 删除中间序号应 200, got ${del.status} ${JSON.stringify(del.body)}`);
    await rerunMigration();
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, 'E1 删中间序号后重启（重跑迁移）不应熔断——序号空洞（1,3）是合法状态，不要求稠密名次');
    const remain = await all('SELECT derive_seq FROM sys_issues WHERE derive_root_id=? ORDER BY derive_seq', [originE]);
    assert.deepStrictEqual(remain.map(r => r.derive_seq), [1, 3], 'E1 剩余序号确为 1,3（2 已删且不回填空洞）');
    ok('[E1] 删中间序号后重启不熔断：剩余序号 1,3（空洞合法，不要求稠密名次）');

    // E2：删最高序号后重启再派生不复用（alloc 不下调）——与 [B] 核心场景相同，但**中间插入一次"重启"**
    //   （runSysMigration 重跑），证明 alloc 不会因重启被重新按 MAX(seq) 计算而回落。
    del = await call('DELETE', `/api/sys-issues/${e3}`, adminTok, { reason: 'E2 删最高序号' });
    assert.strictEqual(del.status, 200, `E2 删除最高序号应 200, got ${del.status} ${JSON.stringify(del.body)}`);
    const allocBeforeRestart = (await rowOf(originE)).derive_seq_alloc;
    assert.strictEqual(allocBeforeRestart, 3, 'E2 前置：删除前 alloc=3（已分配到 3，即便 3 号刚被删）');
    await rerunMigration();
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, 'E2「重启」（重跑迁移）后不熔断');
    const allocAfterRestart = (await rowOf(originE)).derive_seq_alloc;
    assert.strictEqual(allocAfterRestart, 3, 'E2 重启后 alloc 仍是 3（实现坏成什么样这条会红：若重启时按现存 MAX(derive_seq)〔此刻只剩 1〕重新初始化 alloc，会回落到 1，下条派生就会复用旧号 2 或 3）');
    const r4 = await deriveBug(originE, { title: 'E-子单4' });
    assert.strictEqual(r4.status, 201);
    const e4row = await rowOf(r4.body.id);
    assert.strictEqual(e4row.derive_seq, 4, 'E2 重启后再派生 → 新号=4（不复用被删除的 2/3）');
    ok('[E2] 删最高序号后重启（重跑迁移）不下调 alloc，再派生取号=4（不复用）');

    // E3：首次回填事务中断不留半填族（独立 fixture 强制第二条 UPDATE 失败，验证 applyFirstBackfillAssignments
    //   在调用方 ROLLBACK 后不留半填状态——targetId=99999 不存在，UPDATE changes≠1 会被函数内部抛出）
    {
      const u = await makeUnitDb();
      const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
      const rootId = rootIns.lastID;
      const realChildIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [rootId]);
      const realChildId = realChildIns.lastID;
      const assignments = [
        { id: realChildId, root: rootId, seq: 1 },
        { id: 999999, root: rootId, seq: 2 },   // 不存在的 id，强制第二条 UPDATE changes=0 → 抛错
      ];
      const allocByRoot = new Map([[rootId, 2]]);
      await u.urun('BEGIN IMMEDIATE');
      let threw = false;
      try {
        await sysDeriveNumbering.applyFirstBackfillAssignments(u.urun, assignments, allocByRoot);
        await u.urun('COMMIT');
      } catch (e) {
        threw = true;
        await u.urun('ROLLBACK');
      }
      assert.ok(threw, 'E3 前置：第二条赋值应因目标行不存在而抛错（测试自身有效性校验）');
      const realChildAfter = await u.uget('SELECT derive_root_id, derive_seq FROM sys_issues WHERE id=?', [realChildId]);
      assert.strictEqual(realChildAfter.derive_root_id, null, 'E3 事务中断整体回滚：先成功的第一条赋值也未落库（实现坏成什么样这条会红：若 applyFirstBackfillAssignments 或调用方各条 UPDATE 各自独立提交而非共享同一事务，这里会看到 real_child 已落号但 alloc 未同步——半填族）');
      assert.strictEqual(realChildAfter.derive_seq, null, 'E3 事务中断整体回滚：derive_seq 同样未落库');
      const rootAfter = await u.uget('SELECT derive_seq_alloc FROM sys_issues WHERE id=?', [rootId]);
      assert.strictEqual(rootAfter.derive_seq_alloc, null, 'E3 根单 alloc 也未初始化（整段回滚，非部分回滚）');
      u.close();
      ok('[E3] 首次回填事务中断不留半填族：强制第二条赋值失败 → 整体 ROLLBACK → 第一条已成功的赋值也未落库');
    }
  }

  // ═══ [F] 首次回填确定性：同输入跑两次输出恒同 ═══
  {
    const toBackfill = [
      { id: 301, root: 100, created_at: '2026-08-14 10:00:00' },
      { id: 302, root: 100, created_at: '2026-08-14 09:00:00' },   // 更早创建，应排在 301 之前
      { id: 303, root: 100, created_at: '2026-08-14 10:00:00' },   // 与 301 同秒——靠 id 兜底排序
      { id: 401, root: 200, created_at: '2026-08-14 11:00:00' },
    ];
    const plan1 = sysDeriveNumbering.planFirstBackfillAssignments(toBackfill, [], new Map());
    const plan2 = sysDeriveNumbering.planFirstBackfillAssignments(toBackfill, [], new Map());
    assert.deepStrictEqual(plan1.assignments, plan2.assignments, '[F] 同输入两次调用的赋号方案逐字节相同（实现坏成什么样这条会红：排序不稳定/依赖 Map 遍历顺序等非确定性因素）');
    assert.deepStrictEqual([...plan1.allocByRoot.entries()], [...plan2.allocByRoot.entries()], '[F] alloc 结果同样确定');
    // 逐条核对排序结果：root=100 族按 (created_at,id) 升序 → 302(09:00) < 301(10:00,id301) < 303(10:00,id303)
    const root100 = plan1.assignments.filter(a => a.root === 100);
    assert.deepStrictEqual(root100.map(a => a.id), [302, 301, 303], '[F] 族内按 (created_at,id) 双键升序：早创建优先，同秒按 id 兜底');
    assert.deepStrictEqual(root100.map(a => a.seq), [1, 2, 3], '[F] 序号连续从 1 起');
    ok('[F] 首次回填确定性：同输入两次调用输出逐字节相同；(created_at,id) 双键排序含同秒兜底正确');

    // [预筛 M1] 成对用例：同族三行其一 created_at=NULL——原始松散比较（a.created_at < b.created_at）
    //   在两侧任一为 NULL 时不构成总序（`null < 'x'` 与 `'x' < null` 可同时为 false），排序结果会随
    //   输入数组的原始顺序漂移，破坏"重跑同输入恒同输出"的确定性声称。归一为空字符串占位后应恒自洽：
    //   对同一组行的两种不同输入顺序喂给 planFirstBackfillAssignments，必须产出逐字节相同的赋号方案。
    const toBackfillWithNull = [
      { id: 501, root: 900, created_at: '2026-08-14 10:00:00' },
      { id: 502, root: 900, created_at: null },
      { id: 503, root: 900, created_at: '2026-08-14 09:00:00' },
    ];
    const order1 = [...toBackfillWithNull];
    const order2 = [toBackfillWithNull[2], toBackfillWithNull[0], toBackfillWithNull[1]];   // 打乱输入顺序
    const planA = sysDeriveNumbering.planFirstBackfillAssignments(order1, [], new Map());
    const planB = sysDeriveNumbering.planFirstBackfillAssignments(order2, [], new Map());
    assert.deepStrictEqual(planA.assignments, planB.assignments, '[F-null] 含 NULL created_at 时两种不同输入顺序应产出逐字节相同的赋号方案（实现坏成什么样这条会红：松散比较在 NULL 参与时不构成总序，结果随输入序漂移，两种顺序会得到不同方案）');
    assert.deepStrictEqual(planA.assignments.map(a => a.id), [502, 503, 501], '[F-null] NULL 应归一排最前（早于任何真实时间戳），其余按时间升序（09:00 早于 10:00）');
    assert.deepStrictEqual(planA.assignments.map(a => a.seq), [1, 2, 3], '[F-null] 序号连续从 1 起');
    ok('[F-null] created_at 含 NULL 的成对用例：两种输入顺序恒产出相同赋号方案（comparator 归一修复确定性契约）');
  }

  // ═══ [G] 不变量探针双向证明 ═══
  {
    // 负例（独立 fixture）：构造 alloc < MAX(seq) 违例，证明探针「能检出」
    const u = await makeUnitDb();
    const rootIns = await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, 1)`);
    const rootId = rootIns.lastID;
    await u.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 5)`, [rootId, rootId]);
    const violations = await sysDeriveNumbering.findAllocInvariantViolations(u.uall);
    assert.strictEqual(violations.length, 1, 'G 负例：alloc(1) < MAX(seq)(5) 应判 1 条违例（实现坏成什么样这条会红：探针恒返回空数组，「没抓到问题」被误当「没有问题」）');
    assert.strictEqual(violations[0].id, rootId, 'G 负例违例清单含根单目标 id');
    u.close();

    // 有子单却 alloc 未初始化——同一探针函数的另一失败方向（成对用例：上面测「alloc 太小」，这里测「alloc 缺失」）
    const u2 = await makeUnitDb();
    const rootIns2 = await u2.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);   // derive_seq_alloc 留 NULL
    const rootId2 = rootIns2.lastID;
    await u2.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 1)`, [rootId2, rootId2]);
    const violations2 = await sysDeriveNumbering.findAllocInvariantViolations(u2.uall);
    assert.strictEqual(violations2.length, 1, 'G 负例（反向）：有子单但 alloc 未初始化应判 1 条违例');
    assert.strictEqual(violations2[0].id, rootId2);
    u2.close();

    // [预筛 M2] 负例（独立 fixture）：构造一对 (derive_root_id,derive_seq) 相同的行，证明
    //   findDuplicateSeqGroups「能检出」——此前 [G] 只有下方活体库的正例（零违例），若探针实现退化成
    //   恒返回空数组，正例会被误判"通过"（[[feedback_probe_test_bidirectional_proof]] 同款缺口）。
    //   unit fixture 无唯一索引约束（makeUnitDb 建表时未建），才能真正插入两条重复行来测——活体库有
    //   idx_sys_issues_derive_root_seq 拦着，这类重复在活体库里插不进去，故本负例必须走独立 fixture。
    const u3 = await makeUnitDb();
    const rootIns3 = await u3.urun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
    const rootId3 = rootIns3.lastID;
    const dupA = await u3.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 1)`, [rootId3, rootId3]);
    const dupB = await u3.urun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (?, ?, 1)`, [rootId3, rootId3]);
    const dupAId = dupA.lastID, dupBId = dupB.lastID;
    const dupViolations = await sysDeriveNumbering.findDuplicateSeqGroups(u3.uall);
    assert.strictEqual(dupViolations.length, 1, 'M2 负例：重复 (root,seq) 应判 1 组违例（实现坏成什么样这条会红：探针恒返回空数组，「能检出」声称不成立）');
    assert.strictEqual(dupViolations[0].derive_root_id, rootId3, 'M2 负例返回值含目标 root');
    assert.strictEqual(dupViolations[0].derive_seq, 1, 'M2 负例返回值含目标 seq');
    assert.strictEqual(dupViolations[0].c, 2, 'M2 负例计数=2（恰好两条重复行）');
    // [预筛 M1] 返回值须补稳定排序的成员 ids——此前只报 root/seq/count，运维拿不到"具体哪两行冲突"，
    //   要靠额外一次 SQL 手工反查。断言 ids 是恰好两个冲突行 id 的升序数组，且据此拼出的熔断摘要串
    //   （index.js 两处 + backfill 脚本熔断文案的共同拼法：`ids=${ids.map(i=>'#'+i).join(',')}`）
    //   确实含两个冲突行 id——不是只断内部字段存在，是断"运维读到的那句话"里真有这两个 id。
    const expectedIds = [dupAId, dupBId].sort((a, b) => a - b);
    assert.deepStrictEqual(dupViolations[0].ids, expectedIds, 'M1 负例：ids 字段应恰为两个冲突行 id（升序）');
    const dupSummaryText = `root=${dupViolations[0].derive_root_id} seq=${dupViolations[0].derive_seq} ids=${dupViolations[0].ids.map((i) => `#${i}`).join(',')}`;
    assert.ok(dupSummaryText.includes(`#${dupAId}`) && dupSummaryText.includes(`#${dupBId}`), `M1 负例：摘要串应含两个冲突行 id，实得：${dupSummaryText}`);
    u3.close();

    // 正例：活体 harness 全库扫描——前面 [C]/[D9] 的污染均已在各自小节内清理复原，此刻应零违例
    const liveViolations = await sysDeriveNumbering.findAllocInvariantViolations(all);
    assert.strictEqual(liveViolations.length, 0, `[G] 正例：活体库全库 alloc 不变量扫描应零违例，实得：${JSON.stringify(liveViolations)}（若非零，说明前面某个测试小节的人为污染未清理干净）`);
    const liveDup = await sysDeriveNumbering.findDuplicateSeqGroups(all);
    assert.strictEqual(liveDup.length, 0, '[G] 正例：活体库无重复 (root,seq) 组');
    const liveClassify = await sysDeriveNumbering.classifySysDeriveNumbering(all, get);
    assert.strictEqual(liveClassify.hasViolations, false, '[G] 正例：活体库 classify 扫描零违例（成组⇔origin 非空等不变量全部满足）');
    ok('[G] 不变量探针双向证明：负例（alloc 过小 / alloc 缺失两个方向）均能检出且清单含目标 id；正例（活体库全库扫描）零违例');
  }

  // ═══ [I] backfill-sys-derive-root-seq.js 独立脚本子进程集成测试（[预筛 H1]）═══
  //   独立脚本是 CLI 工具（读 argv、开真实文件、调 process.exit），不能像 utils 模块那样 require 进本
  //   进程直调——用 child_process.spawnSync 起子进程、指向独立构造的临时 sqlite 文件，断言退出码 +
  //   落盘结果，这是唯一真实反映"部署门禁看退出码"这条使用场景的测法。
  {
    const BACKFILL_SCRIPT = path.join(__dirname, 'backfill-sys-derive-root-seq.js');
    const WBS_ROOT = path.join(__dirname, '..');
    function makeTempDbPath() {
      return path.join(os.tmpdir(), `verify-sys-derive-numbering-i-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
    }
    // [SF-2] EBUSY/EPERM 竞态结构性解——[I1]-[I5] 每组都是"子进程 spawnSync 跑 backfill 脚本（脚本内部
    //   自己开关一份 sqlite3 连接）→ 父进程紧接着 fs.unlinkSync 删同一个临时 db 文件"。子进程退出时
    //   spawnSync 已返回，但 Windows 上文件句柄/防病毒扫描等对刚关闭的文件仍可能有短暂的滞留占用，
    //   紧跟着的 unlinkSync 会在小概率下撞上 EBUSY（文件忙）/EPERM（权限，Windows 下常与文件占用同源）
    //   ——这是 2026-08-14 起 [I4c]/[I5] 反复撞见的已知 flaky 点（此前登记"重跑即绿"，本次做成结构性
    //   解，不再靠运气）。带短退避的重试：绝大多数情况下文件锁在几十毫秒内就会被系统释放，重试等这个
    //   窗口过去即可，不是长时间轮询。只吞 EBUSY/EPERM 两类——其余错误（如真正的权限问题、路径非法）
    //   不是"等一下就好"的竞态，原样抛出不吞，防止把真故障伪装成"重试几次就过去了"。
    async function removeWithRetry(filePath, maxRetries = 5) {
      const delays = [50, 100, 200, 200, 200];
      for (let attempt = 0; ; attempt++) {
        try {
          fs.unlinkSync(filePath);
          return;
        } catch (e) {
          const isRetryable = e && (e.code === 'EBUSY' || e.code === 'EPERM');
          if (!isRetryable || attempt >= maxRetries) throw e;   // 非 EBUSY/EPERM 或重试次数用尽——原样抛出，不静默吞掉
          await new Promise((res) => setTimeout(res, delays[attempt] || 200));
        }
      }
    }
    async function buildMinimalStandaloneDb(dbPath, seedFn) {
      const sq = new sqlite3.Database(dbPath);
      const srun = (sql, params = []) => new Promise((res, rej) => sq.run(sql, params, function (e) { e ? rej(e) : res(this); }));
      await srun(`CREATE TABLE sys_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_issue_id INTEGER,
        derive_root_id INTEGER,
        derive_seq INTEGER,
        derive_seq_alloc INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )`);
      if (seedFn) await seedFn(srun);
      await new Promise((res) => sq.close(res));
    }
    function runBackfillScript(dbPath, extraArgs = []) {
      return spawnSync(process.execPath, [BACKFILL_SCRIPT, '--db', dbPath, ...extraArgs], { encoding: 'utf8', cwd: WBS_ROOT });
    }

    // I1（H1①）：零候选但造 alloc 违例（根 alloc=1 < 现存子单 MAX(seq)=5）⇒ dry-run 退出码非 0
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, 1)`);   // 根 id=1，alloc=1
        await srun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (1, 1, 5)`);   // 已填子单 seq=5（>alloc）
      });
      const result = runBackfillScript(dbPath);   // dry-run，不加 --apply
      assert.notStrictEqual(result.status, 0, `[I1] 零候选+alloc违例应致脚本退出码非 0，实得 status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      await removeWithRetry(dbPath);
      ok('[I1] backfill 脚本零候选分支 fail-open 修复：alloc 不变量违例 → 退出码非 0（实现坏成什么样这条会红：若零候选分支只 console.log 警告仍 exit 0，部署门禁会把这个病库判成功）');
    }

    // I2（H1①）：零候选但造重复 (root,seq) 组 ⇒ dry-run 退出码非 0
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id, derive_seq_alloc) VALUES (NULL, 1)`);   // 根 id=1，alloc=1（=maxSeq，隔离 alloc 判据不联动触发）
        await srun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (1, 1, 1)`);
        await srun(`INSERT INTO sys_issues (origin_issue_id, derive_root_id, derive_seq) VALUES (1, 1, 1)`);   // 与上一行重复 (root=1,seq=1)——本 fixture 无唯一索引，两行都能插进去
      });
      const result = runBackfillScript(dbPath);
      assert.notStrictEqual(result.status, 0, `[I2] 零候选+重复组应致脚本退出码非 0，实得 status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      await removeWithRetry(dbPath);
      ok('[I2] backfill 脚本零候选分支 fail-open 修复：重复 (root,seq) 组 → 退出码非 0');
    }

    // I3（H1②③）：零候选且部分唯一索引缺失 ⇒ dry-run 明确提示「将补建」+ --apply 后索引存在且 UNIQUE
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);   // 一个干净的根单，零违例、零候选
      });

      const dryRunResult = runBackfillScript(dbPath);   // 无 --apply
      assert.strictEqual(dryRunResult.status, 0, `[I3] dry-run 应 exit 0（数据本身无违例），实得 status=${dryRunResult.status}\nstderr=${dryRunResult.stderr}`);
      assert.ok(/补建/.test(dryRunResult.stdout), `[I3] dry-run 输出应明确提示"--apply 将补建"（实现坏成什么样这条会红：零候选分支缺索引存在性核验，静默放过缺索引的库），实得：${dryRunResult.stdout}`);

      // 索引此刻确实还不存在——独立验证，不只信脚本自身输出
      const idxBefore = await new Promise((res, rej) => {
        const checkDb = new sqlite3.Database(dbPath);
        checkDb.get(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`,
          (e, row) => { checkDb.close(); e ? rej(e) : res(row); });
      });
      assert.ok(!idxBefore, '[I3] 前置：--apply 之前索引确实不存在');

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.strictEqual(applyResult.status, 0, `[I3] --apply 应 exit 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);

      const idxAfter = await new Promise((res, rej) => {
        const checkDb2 = new sqlite3.Database(dbPath);
        checkDb2.get(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`,
          (e, row) => { checkDb2.close(); e ? rej(e) : res(row); });
      });
      assert.ok(idxAfter, '[I3] --apply 之后索引应存在（实现坏成什么样这条会红：零候选 --apply 路径未补建索引，仍和旧版一样什么都不做就 return）');
      assert.ok(/UNIQUE/i.test(idxAfter.sql), '[I3] 补建的索引应为 UNIQUE（非普通索引）');

      await removeWithRetry(dbPath);
      ok('[I3] backfill 脚本索引核验/补建：dry-run 明确提示缺失将补建 + --apply 后索引真实存在且 UNIQUE（零候选分支现在真的和迁移链"同路径"）');
    }

    // I4（[预筛 400-H1]）：既有库历史上存在**同名但非 UNIQUE** 的 idx_sys_issues_derive_root_seq
    // （如早期手工建过的普通索引）——dry-run 与 --apply 均应 fail-closed（退出码非 0 + 输出含人工修复
    // 指引），--apply **不得**静默 no-op 后仍报"已补建"，也不得自作主张自动 DROP 重建。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);   // 干净根单，零违例、零候选
        // 预置同名但非 UNIQUE 的索引——模拟"历史上手工建过一个普通索引，后来才引入本批的 UNIQUE 约束"。
        await srun(`CREATE INDEX idx_sys_issues_derive_root_seq ON sys_issues(id)`);
      });

      const dryRunResult = runBackfillScript(dbPath);   // 无 --apply
      assert.notStrictEqual(dryRunResult.status, 0, `[I4] dry-run 遇同名非 UNIQUE 索引应退出码非 0（实现坏成什么样这条会红：若 dry-run 只是打印警告仍 exit 0，部署门禁会放行一个索引实际没有唯一约束的库），实得 status=${dryRunResult.status}\nstdout=${dryRunResult.stdout}`);
      assert.ok(/DROP INDEX|人工/.test(dryRunResult.stdout + dryRunResult.stderr), `[I4] dry-run 输出应含人工修复指引（DROP INDEX 字样），实得 stdout=${dryRunResult.stdout} stderr=${dryRunResult.stderr}`);

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I4] --apply 遇同名非 UNIQUE 索引应退出码非 0（实现坏成什么样这条会红：CREATE UNIQUE INDEX IF NOT EXISTS 对同名索引静默 no-op 不报错，若不做建后二次核验，这里会看到 exit 0 + "已补建"的假成功），实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(/DROP INDEX|人工/.test(applyResult.stdout + applyResult.stderr), `[I4] --apply 输出应含人工修复指引，实得 stdout=${applyResult.stdout} stderr=${applyResult.stderr}`);
      assert.ok(!/已补建|已就位/.test(applyResult.stdout), `[I4] --apply 输出不应出现"已补建/已就位"这类成功措辞（否则就是把 no-op 误报成功），实得：${applyResult.stdout}`);

      // 索引本身应保持原样（非 UNIQUE、未被自动 DROP）——脚本不得擅自做任何自动修复动作。
      const idxRow = await new Promise((res, rej) => {
        const checkDb = new sqlite3.Database(dbPath);
        checkDb.get(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`,
          (e, row) => { checkDb.close(); e ? rej(e) : res(row); });
      });
      assert.ok(idxRow, '[I4] 索引应仍然存在（脚本不自动 DROP）');
      assert.ok(!/UNIQUE/i.test(idxRow.sql), '[I4] 索引应仍然是非 UNIQUE（脚本不自动重建/升级约束——留人工核实处理，同熔断哲学）');

      await removeWithRetry(dbPath);
      ok('[I4] backfill 脚本同名非 UNIQUE 索引 fail-closed：dry-run 与 --apply 均退出码非 0 + 输出含 DROP INDEX 人工修复指引，索引原样未被自动 DROP/静默误报成功');
    }

    // I4b（[预筛 401]）：假阳性变体——同名普通（非 UNIQUE）索引，但其表达式/WHERE 子句里恰好含字符串
    // 字面量 'UNIQUE'。此前 checkDeriveIndexState 用 `/UNIQUE/i.test(sqlite_master.sql)` 文本正则判定，
    // 这类索引的 SQL 文本里确实出现了 "UNIQUE" 这几个字符（只是作为字符串字面量，不是 CREATE UNIQUE
    // INDEX 的关键字），会被误判成健康态——dry-run 放行、apply no-op 却报成功、二次核验也照样误判通过，
    // 三处全部失守。改用 `PRAGMA index_list` 结构化元数据后，索引真实的 unique 列不受表达式内容干扰，
    // 应正确识别为 non_unique。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);   // 干净根单，零违例、零候选
        // 同名非 UNIQUE 的表达式索引，SQL 文本里恰好含字符串字面量 'UNIQUE'（旧文本正则判定的假阳性诱因）。
        await srun(`CREATE INDEX idx_sys_issues_derive_root_seq ON sys_issues((CASE WHEN id > 0 THEN 'UNIQUE' ELSE 'x' END))`);
      });

      const dryRunResult = runBackfillScript(dbPath);
      assert.notStrictEqual(dryRunResult.status, 0, `[I4b] dry-run 遇"SQL 文本含 UNIQUE 字面量但实际非 UNIQUE"的索引应退出码非 0（实现坏成什么样这条会红：若判定依据仍是 sqlite_master.sql 文本正则，这里会被字符串字面量 'UNIQUE' 骗过，误判成健康态放行），实得 status=${dryRunResult.status}\nstdout=${dryRunResult.stdout}`);
      assert.ok(!/已补建|已就位/.test(dryRunResult.stdout), `[I4b] dry-run 输出不应出现"已补建/已就位"，实得：${dryRunResult.stdout}`);

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I4b] --apply 遇假阳性索引应退出码非 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(!/已补建|已就位/.test(applyResult.stdout), `[I4b] --apply 输出不应出现"已补建/已就位"这类成功措辞（这正是文本正则假阳性会导致的错误行为：no-op 后仍误报成功），实得：${applyResult.stdout}`);

      await removeWithRetry(dbPath);
      ok('[I4b] 假阳性变体：同名非 UNIQUE 索引但 SQL 文本含 \'UNIQUE\' 字面量 → dry-run/--apply 仍正确退出码非 0，输出不含"已补建/已就位"（判定依据已改 PRAGMA index_list 结构化元数据，不受索引定义文本内容干扰）');
    }

    // I4c（[预筛 402 终态]）：同名且 UNIQUE，但结构不符目标定义——列组错（只有 id 一列，非
    // [derive_root_id, derive_seq] 两列）且非部分索引（无 WHERE）。此前 helper 只看 unique===1 就判
    // 健康，这类"同名且 UNIQUE 但定义错误"的索引会被误判成功——CREATE UNIQUE INDEX IF NOT EXISTS 照样
    // no-op，目标要求的部分唯一约束实际上没有生效。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);   // 干净根单，零违例、零候选
        // 同名 UNIQUE 索引，但列组/WHERE 均不是目标定义（只在 id 上建了个全表唯一索引）。
        await srun(`CREATE UNIQUE INDEX idx_sys_issues_derive_root_seq ON sys_issues(id)`);
      });

      const dryRunResult = runBackfillScript(dbPath);
      assert.notStrictEqual(dryRunResult.status, 0, `[I4c] dry-run 遇"同名 UNIQUE 但结构不符"的索引应退出码非 0（实现坏成什么样这条会红：若判定只看 unique===1，这类索引会被误判健康态放行），实得 status=${dryRunResult.status}\nstdout=${dryRunResult.stdout}`);
      assert.ok(!/已补建|已就位/.test(dryRunResult.stdout), `[I4c] dry-run 输出不应出现"已补建/已就位"，实得：${dryRunResult.stdout}`);
      assert.ok(/结构不符/.test(dryRunResult.stdout + dryRunResult.stderr), `[I4c] dry-run 输出应说明"结构不符"，实得 stdout=${dryRunResult.stdout} stderr=${dryRunResult.stderr}`);
      assert.ok(/列组不符|非部分索引/.test(dryRunResult.stdout + dryRunResult.stderr), `[I4c] dry-run 输出应指出具体哪项没过（列组不符/非部分索引二者至少一个），实得 stdout=${dryRunResult.stdout} stderr=${dryRunResult.stderr}`);

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I4c] --apply 遇同款索引应退出码非 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(!/已补建|已就位/.test(applyResult.stdout), `[I4c] --apply 输出不应出现"已补建/已就位"这类成功措辞（CREATE UNIQUE INDEX IF NOT EXISTS 对同名索引静默 no-op，目标部分唯一约束实际未生效），实得：${applyResult.stdout}`);
      assert.ok(/结构不符/.test(applyResult.stdout + applyResult.stderr), `[I4c] --apply 输出应说明"结构不符"，实得 stdout=${applyResult.stdout} stderr=${applyResult.stderr}`);

      // 索引本身应保持原样（错误定义未被自动 DROP/重建）。
      const idxRowsAfter = await new Promise((res, rej) => {
        const checkDb = new sqlite3.Database(dbPath);
        checkDb.all(`PRAGMA index_info('idx_sys_issues_derive_root_seq')`,
          (e, rows) => { checkDb.close(); e ? rej(e) : res(rows); });
      });
      assert.strictEqual(idxRowsAfter.length, 1, '[I4c] 索引仍应是原样的单列（id）定义，未被自动纠正为 [derive_root_id,derive_seq] 两列');
      assert.strictEqual(idxRowsAfter[0].name, 'id', '[I4c] 索引仍应建在 id 列上（脚本未自动重建）');

      await removeWithRetry(dbPath);
      ok('[I4c] 同名 UNIQUE 但结构不符（列组错+非部分索引）→ dry-run/--apply 均正确退出码非 0，输出含"结构不符"+具体项说明，索引原样未被自动纠正');
    }

    // I4d（[预筛 403] codex 反例）：列组/partial 全过，但 WHERE 子句多了 `AND 0`——两个 IS NOT NULL
    // 谓词子串都在，若判定仍是"含子串"（402 版本的实现），这里会被误判 'ok'；但 `AND 0` 让整个 WHERE
    // 恒假，索引实际上永远为空，不变量 (derive_root_id,derive_seq) 唯一性形同虚设。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
        await srun(`CREATE UNIQUE INDEX idx_sys_issues_derive_root_seq ON sys_issues(derive_root_id, derive_seq) WHERE derive_root_id IS NOT NULL AND derive_seq IS NOT NULL AND 0`);
      });

      const dryRunResult = runBackfillScript(dbPath);
      assert.notStrictEqual(dryRunResult.status, 0, `[I4d] dry-run 遇"WHERE 恒假"反例应退出码非 0（实现坏成什么样这条会红：若判定仍是"文本含两个 IS NOT NULL 子串"，这条 WHERE 两个子串都在，会被误判 'ok' 放行——而索引实际恒空，唯一性形同虚设），实得 status=${dryRunResult.status}\nstdout=${dryRunResult.stdout}`);
      assert.ok(!/已补建|已就位/.test(dryRunResult.stdout), `[I4d] dry-run 输出不应出现"已补建/已就位"，实得：${dryRunResult.stdout}`);
      assert.ok(/WHERE 非标准形/.test(dryRunResult.stdout + dryRunResult.stderr), `[I4d] dry-run 输出应含"WHERE 非标准形"说明，实得 stdout=${dryRunResult.stdout} stderr=${dryRunResult.stderr}`);

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I4d] --apply 遇同款反例应退出码非 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(!/已补建|已就位/.test(applyResult.stdout), `[I4d] --apply 输出不应出现"已补建/已就位"，实得：${applyResult.stdout}`);
      assert.ok(/WHERE 非标准形/.test(applyResult.stdout + applyResult.stderr), `[I4d] --apply 输出应含"WHERE 非标准形"说明，实得 stdout=${applyResult.stdout} stderr=${applyResult.stderr}`);

      await removeWithRetry(dbPath);
      ok('[I4d] codex 403 反例：WHERE 含两 IS NOT NULL 子串但多了 "AND 0"（恒假）→ dry-run/--apply 均正确退出码非 0，输出含"WHERE 非标准形"说明（判定已从"含子串"改"规范化全等"）');
    }

    // I4e（[预筛 403]）：语义等价变形——`NOT (derive_root_id IS NULL)` 与 `derive_root_id IS NOT NULL`
    // 逻辑等价，但字面不同。判定哲学是"只认标准形不猜语义"，这条变形理应同样 fail-closed（若判定悄悄
    // 做了语义化简/等价判断，这条会被放行，说明判定越权替人工做了本不该由程序判断的"这写法算不算数"）。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
        await srun(`CREATE UNIQUE INDEX idx_sys_issues_derive_root_seq ON sys_issues(derive_root_id, derive_seq) WHERE NOT (derive_root_id IS NULL) AND derive_seq IS NOT NULL`);
      });

      const dryRunResult = runBackfillScript(dbPath);
      assert.notStrictEqual(dryRunResult.status, 0, `[I4e] dry-run 遇语义等价变形应退出码非 0（实现坏成什么样这条会红：若判定做了语义等价判断而非规范化全等比较，这条"NOT (x IS NULL)" 会被当成 "x IS NOT NULL" 放行），实得 status=${dryRunResult.status}\nstdout=${dryRunResult.stdout}`);
      assert.ok(!/已补建|已就位/.test(dryRunResult.stdout), `[I4e] dry-run 输出不应出现"已补建/已就位"，实得：${dryRunResult.stdout}`);
      assert.ok(/WHERE 非标准形/.test(dryRunResult.stdout + dryRunResult.stderr), `[I4e] dry-run 输出应含"WHERE 非标准形"说明，实得 stdout=${dryRunResult.stdout} stderr=${dryRunResult.stderr}`);

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I4e] --apply 遇同款语义等价变形应退出码非 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(!/已补建|已就位/.test(applyResult.stdout), `[I4e] --apply 输出不应出现"已补建/已就位"，实得：${applyResult.stdout}`);

      await removeWithRetry(dbPath);
      ok('[I4e] 语义等价变形（NOT (x IS NULL) 代替 x IS NOT NULL）→ 同样 dry-run/--apply 退出码非 0（证明判定"只认标准形不猜语义"，非语义判断）');
    }

    // I5（[预筛 400-H1] 报告内声明的扩面：本报告主动把同款修复也施加到"有候选待写"主分支，非仅零候选
    // 分支——同一份 CREATE UNIQUE INDEX IF NOT EXISTS DDL 在主分支同样存在"静默 no-op 误报成功"的风险，
    // 修复面理应对称，此条验证主分支的三态核验真的接上了，非只改了零候选分支）：有 1 条真实待回填候选
    // + 同名非 UNIQUE 索引 ⇒ --apply 应 fail-closed（数据回填已提交、索引核验独立失败，退出码非 0）。
    {
      const dbPath = makeTempDbPath();
      await buildMinimalStandaloneDb(dbPath, async (srun) => {
        const rootIns = await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (NULL)`);
        await srun(`INSERT INTO sys_issues (origin_issue_id) VALUES (?)`, [rootIns.lastID]);   // 1 条真实待回填候选
        await srun(`CREATE INDEX idx_sys_issues_derive_root_seq ON sys_issues(id)`);   // 同名非 UNIQUE
      });

      const applyResult = runBackfillScript(dbPath, ['--apply']);
      assert.notStrictEqual(applyResult.status, 0, `[I5] 主分支（有候选待写）遇同名非 UNIQUE 索引，--apply 应退出码非 0，实得 status=${applyResult.status}\nstdout=${applyResult.stdout}\nstderr=${applyResult.stderr}`);
      assert.ok(/DROP INDEX|人工/.test(applyResult.stdout + applyResult.stderr), `[I5] 输出应含人工修复指引，实得 stdout=${applyResult.stdout} stderr=${applyResult.stderr}`);

      // 数据回填本身应已正常完成（索引核验失败发生在数据写入提交之后，两者独立）——同零候选分支
      // "不自动 DROP"一致，索引仍应保持非 UNIQUE 原样。
      const checkDb = new sqlite3.Database(dbPath);
      const filledRow = await new Promise((res, rej) => checkDb.get(
        `SELECT derive_root_id, derive_seq FROM sys_issues WHERE origin_issue_id IS NOT NULL`,
        (e, row) => e ? rej(e) : res(row)));
      const idxRow5 = await new Promise((res, rej) => checkDb.get(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_sys_issues_derive_root_seq'`,
        (e, row) => { checkDb.close(); e ? rej(e) : res(row); }));
      assert.ok(filledRow && filledRow.derive_root_id !== null, '[I5] 数据回填应已正常完成（与索引核验失败相互独立——同 alloc/dup 两条既有探针失败时"数据已写入不回滚"的既定行为一致）');
      assert.ok(idxRow5 && !/UNIQUE/i.test(idxRow5.sql), '[I5] 索引仍应保持非 UNIQUE 原样（主分支同样不自动 DROP/重建）');

      await removeWithRetry(dbPath);
      ok('[I5] 主分支（有候选待写）同款验证：同名非 UNIQUE 索引 --apply fail-closed，数据回填与索引核验独立（回填已提交+索引原样未动），证明 400-H1 修复面扩到主分支真的生效');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // [DN] S12-b：display-no helper 全线接入（方案 20260813_v1.8 §15.3·2026-08-14）+ S13-a MED-1 补批（2026-08-15）
  //   [DN1] fixture 一致性：sysIssueDisplayNo(fixture.input)===fixture.expected 逐行断言（含 seq=0 边界）
  //   [DN2] 真实通知函数链：4 个被修复 SELECT 的端点（resend-tech-consult/tech-lead-comment/
  //       resend-notify/intake-return）各触发一次真实钉钉发送，文案均含正确子编号
  //       （独立 harness+捕获 stub，非拼字符串比对——直接跑生产 handler→真实 builder 函数→真实发送调用）
  //   [DN3]/[DN4] insertDerivedSysIssue timeline 新行子编号（正例：二级派生 created 行含真子编号）
  //       + 历史已落库行不回溯（负例：迁移重跑后旧格式行字节级不变）——正负例成对
  //   [DN5] DTO 投影：GET /sys-issues 列表 + GET /sys-issues/:id 详情两端点真实 HTTP 请求断言两列存在
  //   [DN6] S13-a MED-1 硬验收项：四处裸 `#${id}` 409 文案改经 helper 后的真实 HTTP 场景断言（add-issues
  //       ISSUE_NOT_ADDABLE / remove-issues ISSUE_NOT_REMOVABLE / 发布核内 RELEASE_MEMBER_NOT_READY 三处
  //       真实造出 409；RELEASE_MEMBER_NOT_RELEASABLE 一处经实测证明 DB CHECK 令其结构性不可达，如实登记
  //       「造不了」而非跳过不提）
  //   [DN7] S13-b·B1：「补验收未通过」徽章后端投影——列表 SELECT 新增 post_derive_root_id/post_derive_seq
  //       两条标量子查询，真实 HTTP 走完整 fastlane pending→post-release-accept(fail) 链路后断言列表 DTO
  //       两列值与真实派生子单 root/seq 一致
  //   [DN7b] S13-b·B2：详情端点新投影 derive_family（一次查询取全族）——复用 DN7 同一夹具，断言家族恰含
  //       根单+派生子单两名成员且 root/seq 正确
  //   [DN8] S13-c·C1：前端 siIssueDisplayNo 函数体提取后 node 侧实例化真执行，与后端 fixture 逐字节比对
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  // ─── [DN1] fixture 一致性 ───
  console.log('\n═══ [DN1] fixture 一致性：sysIssueDisplayNo 正负例逐行断言（utils/sys-issue-display-no.fixtures.js） ═══');
  {
    const fixtures = require('../utils/sys-issue-display-no.fixtures');
    assert.ok(Array.isArray(fixtures) && fixtures.length >= 9, 'fixture 文件应导出数组且 ≥9 条用例（S13 前端将吃同一份文件——先确认它本身可 require 且非空）');
    for (const f of fixtures) {
      const got = sysDeriveNumbering.sysIssueDisplayNo(f.input);
      assert.strictEqual(got, f.expected, `fixture「${f.label}」：sysIssueDisplayNo(${JSON.stringify(f.input)}) 期望 ${f.expected}, got ${got}`);
    }
    ok(`[DN1] fixture 一致性：全部 ${fixtures.length} 条 sysIssueDisplayNo(input)===expected 逐行核对通过（实现坏成什么样这条会红：判空逻辑改用真值判断会让 fixture 里 derive_seq=0 那条从 #50_0 误判成 #102 回退）`);
  }

  // ─── [DN2] 真实通知函数链：独立 harness + 捕获 stub ───
  console.log('\n═══ [DN2] 通知文案子编号：真实 HTTP 端点链路（发起咨询→重发→技术负责人评论→补发→受理退改）4 处捕获 ═══');
  {
    const dnCaptured = [];
    async function mockCaptureDingtalk(target, title, md) {
      dnCaptured.push({ target, title, md });
      return { ok: true, message_key: 'stub-dn-' + dnCaptured.length };
    }
    const db2 = new sqlite3.Database(':memory:');
    const run2 = (sql, params = []) => new Promise((res, rej) => db2.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const all2 = (sql, params = []) => new Promise((res, rej) => db2.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const get2 = (sql, params = []) => new Promise((res, rej) => db2.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    const mod2 = require('../routes/sys-iteration')({
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      db: db2, dbRunAsync: run2, dbGetAsync: get2, dbAllAsync: all2,
      authenticateToken, requireAdmin,
      ...require('./_sys-attach-test-deps'),
      sendIssueDingtalkRaw: mockCaptureDingtalk,
      getSafePlatformBaseUrl: async () => '',
    });
    const I2 = mod2._internals;
    mod2.initSchema();
    // [LOW-2] finally 兜底清理——本节内十余处 assert 任一提前抛出都会跳过写在末尾的
    //   server2.close()/db2.close()：独立 harness 起了真实 HTTP server + 独立 sqlite 连接，红灯路径下不
    //   清理会让子进程句柄悬挂（Windows 下同款成因常表现为 EBUSY/端口占用类 flaky）。server2 提到 try 外
    //   声明+初始化为 null，finally 里判空后关闭，不依赖"跑到最后一行才清理"这个乐观假设。
    let server2 = null;
    try {
      await new Promise((res, rej) => {
        let n = 0;
        const t = setInterval(() => {
          if (I2.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
          else if (I2.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I2.SYS_SCHEMA_STATE.error)); }
          else if (++n > 500) { clearInterval(t); rej(new Error('[DN2] harness readiness 超时')); }
        }, 10);
      });
      await run2(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
      await run2(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(7,'shenjun','示例发布者','publisher'),(13,'wangtaotao','示例对接人','user')`);
      const app2 = express();
      app2.use(express.json());
      app2.use('/api', mod2.router);
      let port2;
      await new Promise(res => { server2 = app2.listen(0, '127.0.0.1', res); });
      port2 = server2.address().port;
      function call2(method, p, tok, body) {
        return new Promise((resolve, reject) => {
          const data = body ? JSON.stringify(body) : null;
          const req = http.request({ host: '127.0.0.1', port: port2, path: p, method, headers: {
            'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
          }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
          req.on('error', reject); if (data) req.write(data); req.end();
        });
      }
      const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
      const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);

      // 建根单→上线（admin=actor id1，与主 harness seedBugToOnline 同款手工序列，独立 db2·不污染主 harness 计数）
      let r = await call2('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'DN2 根单', system_name: 'BMS', source: '内部', description: 'DN2 verify 夹具', intake_liaison_id: 13 });
      assert.strictEqual(r.status, 201, `[DN2] 建根单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const dn2RootId = r.body.id;
      await call2('POST', `/api/sys-issues/${dn2RootId}/intake-accept`, adminTok, {});
      r = await call2('POST', `/api/sys-issues/${dn2RootId}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(r.status, 200, `[DN2] assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
      r = await call2('POST', `/api/sys-issues/${dn2RootId}/estimate`, devTok, { dev_estimated_at: EST });
      assert.strictEqual(r.status, 200, `[DN2] estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
      r = await call2('POST', `/api/sys-issues/${dn2RootId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'dn2-batch' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'DN2 verify 夹具：bug 产生原因' });
      assert.strictEqual(r.status, 200, `[DN2] submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
      r = await call2('POST', `/api/sys-issues/${dn2RootId}/accept`, adminTok, {});
      assert.strictEqual(r.status, 200, `[DN2] accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
      await run2(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [dn2RootId]);

      // 派生（admin·created_by=1）→ derive_root_id=dn2RootId/derive_seq=1
      r = await call2('POST', `/api/sys-issues/${dn2RootId}/derive`, adminTok, { type: 'bug', title: 'DN2 派生单', system_name: 'BMS', source: '内部', derive_reason: 'DN2 派生原因' });
      assert.strictEqual(r.status, 201, `[DN2] 派生 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const dn2ChildId = r.body.id;
      const expectSubNo = `#${dn2RootId}_1`;

      // ① 发起技术负责人沟通（liaison·id13，绑定对接人）——S5 手动化：首发/换轮不应触发钉钉发送
      r = await call2('POST', `/api/sys-issues/${dn2ChildId}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
      assert.strictEqual(r.status, 200, `[DN2] request-tech-consult 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const reqEventId = r.body.request_event_id;
      assert.strictEqual(dnCaptured.length, 0, '[DN2] request-tech-consult 首发不应触发钉钉发送（S5 手动化）——若这里已非 0，说明首发段被意外恢复自动发送');

      // ② 重发（liaison）→ 捕获 #1：buildSysTechLeadMarkdown 发给技术负责人（4 处修复 SELECT 之一：resend-tech-consult）
      r = await call2('POST', `/api/sys-issues/${dn2ChildId}/resend-tech-consult`, liaisonTok, { expected_request_event_id: reqEventId });
      assert.strictEqual(r.status, 200, `[DN2] resend-tech-consult 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(dnCaptured.length, 1, '[DN2] resend-tech-consult 应恰好触发 1 次钉钉发送（技术负责人）');
      assert.ok(dnCaptured[0].md.includes(`单号**：${expectSubNo}`), `[DN2]① buildSysTechLeadMarkdown 文案应含子编号 ${expectSubNo}, got「${dnCaptured[0].md}」`);

      // ③ 技术负责人提交评估意见（techTok·id7）→ 捕获 #2：buildSysTechLeadCommentReplyMarkdown 发给对接人
      //   （4 处修复 SELECT 之二：tech-lead-comment）
      r = await call2('POST', `/api/sys-issues/${dn2ChildId}/tech-lead-comment`, techTok, { comment: 'DN2 技术评估意见内容', expected_request_event_id: reqEventId });
      assert.strictEqual(r.status, 200, `[DN2] tech-lead-comment 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(dnCaptured.length, 2, '[DN2] tech-lead-comment 应新增恰好 1 次钉钉发送（受理人·首发）');
      assert.ok(dnCaptured[1].md.includes(`单号**：${expectSubNo}`), `[DN2]② buildSysTechLeadCommentReplyMarkdown（首发）文案应含子编号 ${expectSubNo}, got「${dnCaptured[1].md}」`);

      // ④ 补发通知（liaison）→ 捕获 #3：同一 builder 补发一次（4 处修复 SELECT 之三：tech-lead-comment/resend-notify）
      r = await call2('POST', `/api/sys-issues/${dn2ChildId}/tech-lead-comment/resend-notify`, liaisonTok, {});
      assert.strictEqual(r.status, 200, `[DN2] resend-notify 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(dnCaptured.length, 3, '[DN2] resend-notify 应新增恰好 1 次钉钉发送（受理人·补发）');
      assert.ok(dnCaptured[2].md.includes(`单号**：${expectSubNo}`), `[DN2]③ buildSysTechLeadCommentReplyMarkdown（补发）文案应含子编号 ${expectSubNo}, got「${dnCaptured[2].md}」`);

      // ⑤ 受理退改（liaison·id13≠created_by=1，避免 self-guard 跳过）→ 捕获 #4：buildSysIntakeReturnCreatorMarkdown
      //   发给建单人（4 处修复 SELECT 之四：intake-return）
      r = await call2('POST', `/api/sys-issues/${dn2ChildId}/intake-return`, liaisonTok, { reason: 'DN2 退改原因' });
      assert.strictEqual(r.status, 200, `[DN2] intake-return 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(dnCaptured.length, 4, '[DN2] intake-return 应新增恰好 1 次钉钉发送（建单人）——若仍是 3，说明触发了 self-guard 或权限被拒');
      assert.ok(dnCaptured[3].md.includes(`单号**：${expectSubNo}`), `[DN2]④ buildSysIntakeReturnCreatorMarkdown 文案应含子编号 ${expectSubNo}, got「${dnCaptured[3].md}」`);

      ok(`[DN2] 通知文案子编号：真实 4 端点链路（resend-tech-consult/tech-lead-comment/resend-notify/intake-return）各恰 1 次真实钉钉发送，文案均含 ${expectSubNo}（造真实函数链非拼字符串——4 处 SELECT 投影修复的判别力经真实发送路径验证，非仅经列表/详情 DTO 间接证明）`);
    } finally {
      if (server2) server2.close();
      db2.close();
    }
  }

  // ─── [DN3]/[DN4] timeline 新行子编号 + 历史已落库行不回溯（正负例成对） ───
  console.log('\n═══ [DN3]/[DN4] insertDerivedSysIssue timeline 新行用子编号 + 历史已落库行不回溯 ═══');
  {
    const dnRootId = await seedBugToOnline();
    // 一级派生：origin=根单（从未被派生过，root/seq 双 NULL）→ 新行「派生自 #根」（#id 回退，非子编号——
    //   根单自身没有子编号可用，这是 sysIssueDisplayNo 的正常回退形态）
    const r1 = await deriveBug(dnRootId, { title: 'DN3 一级派生单', derive_reason: 'DN3 一级派生原因' });
    assert.strictEqual(r1.status, 201, `[DN3] 一级派生 201, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const dnChild1Id = r1.body.id;
    // [S13-c·C2 行7 Toast 后端腿] 手动 /derive 端点响应体应追加 derive_root_id/derive_seq（S13-b·B3
    // 新投影，供前端「已派生新单」toast 拼子编号；`id` 字段本身仍是矩阵行11 深链/API 技术锚点不受影响）。
    assert.strictEqual(r1.body.derive_root_id, dnRootId, `[DN3] 响应体 derive_root_id 应=${dnRootId}, got ${r1.body.derive_root_id}`);
    assert.strictEqual(r1.body.derive_seq, 1, `[DN3] 响应体 derive_seq 应=1, got ${r1.body.derive_seq}`);
    const c1row = await rowOf(dnChild1Id);
    assert.strictEqual(c1row.derive_root_id, dnRootId, `[DN3] 一级派生 derive_root_id 应=${dnRootId}, got ${c1row.derive_root_id}`);
    assert.strictEqual(c1row.derive_seq, 1, `[DN3] 一级派生 derive_seq 应=1, got ${c1row.derive_seq}`);
    const c1created = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='created'`, [dnChild1Id]);
    assert.strictEqual(c1created && c1created.summary, `派生自 #${dnRootId}`, `[DN3] 一级派生 created 行应回退 #id（根单无子编号）, got「${c1created && c1created.summary}」`);

    // ⭐ [DN4] 历史已落库行不回溯：手工造一条"旧格式"遗留 timeline 行（模拟 S12-b 上线前已存在的老文案），
    //   下方跑完新链（二级派生 + 迁移重跑）后必须原样不变——证明本批改动只影响新 INSERT，绝无 UPDATE 回写旧行。
    const legacyText = `派生自 #${dnRootId}（DN4-历史遗留格式标记-不可被回溯改写）`;
    const legacyIns = await run(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name) VALUES (?, 'note', ?, 1, 'DN4夹具')`,
      [dnChild1Id, legacyText]);
    const legacyRowId = legacyIns.lastID;

    // bug 类单仅可从「已上线」派生（SYS_DERIVE_ORIGIN_NOT_ONLINE 守卫）——一级派生单本身也是 bug，
    // 要再从它派生二级，须先把它推到「已上线」（与 seedBugToOnline 同款手工序列）。
    let adv = await call('POST', `/api/sys-issues/${dnChild1Id}/intake-accept`, adminTok, {});
    assert.strictEqual(adv.status, 200, `[DN3] 一级派生单 intake-accept 200, got ${adv.status} ${JSON.stringify(adv.body)}`);
    adv = await call('POST', `/api/sys-issues/${dnChild1Id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(adv.status, 200, `[DN3] 一级派生单 assign 200, got ${adv.status} ${JSON.stringify(adv.body)}`);
    adv = await call('POST', `/api/sys-issues/${dnChild1Id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(adv.status, 200, `[DN3] 一级派生单 estimate 200, got ${adv.status} ${JSON.stringify(adv.body)}`);
    adv = await call('POST', `/api/sys-issues/${dnChild1Id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'dn3-batch' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'DN3 verify 夹具：bug 产生原因', fix_gap_note: 'DN3 verify 夹具：派生单修复缺口说明' });
    assert.strictEqual(adv.status, 200, `[DN3] 一级派生单 submit 200, got ${adv.status} ${JSON.stringify(adv.body)}`);
    adv = await call('POST', `/api/sys-issues/${dnChild1Id}/accept`, adminTok, {});
    assert.strictEqual(adv.status, 200, `[DN3] 一级派生单 accept 200, got ${adv.status} ${JSON.stringify(adv.body)}`);
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [dnChild1Id]);

    // 二级派生：origin=一级派生单（此刻 derive_root_id/derive_seq 已双非空）→ 新行「派生自 #根_序」（真子编号，非回退——
    //   本条是 [DN3] 的money assertion：证明 timeline 新行真的能拼出子编号，不是恒定回退 #id）
    const r2 = await deriveBug(dnChild1Id, { title: 'DN3 二级派生单', derive_reason: 'DN3 二级派生原因' });
    assert.strictEqual(r2.status, 201, `[DN3] 二级派生 201, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const dnChild2Id = r2.body.id;
    const c2row = await rowOf(dnChild2Id);
    assert.strictEqual(c2row.derive_root_id, dnRootId, `[DN3] 二级派生 derive_root_id 应继承展平根=${dnRootId}, got ${c2row.derive_root_id}`);
    assert.strictEqual(c2row.derive_seq, 2, `[DN3] 二级派生 derive_seq 应=2（根上取号计数，非中间单局部计数）, got ${c2row.derive_seq}`);
    const c2created = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='created'`, [dnChild2Id]);
    assert.strictEqual(c2created && c2created.summary, `派生自 #${dnRootId}_1`, `[DN3] 二级派生 created 行应含真子编号 #根_序（非 #id 回退）, got「${c2created && c2created.summary}」`);
    ok(`[DN3] timeline 新行子编号：一级派生 created 行回退 #${dnRootId}（根单无子编号）·二级派生 created 行真子编号 #${dnRootId}_1（origin 自身已是派生单）——正负例成对`);

    // 重启迁移（模拟一次与本单表面无关的维护活动：runSysMigration 重跑全部 readiness 判定）后，
    // 历史遗留行必须原样不变——backfill/migration 链只改 sys_issues 三列，从不触碰 sys_issue_timeline。
    await rerunMigration();
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '[DN4] 迁移重跑后应恢复 ready=true（数据本身合法，重跑只是复检不应熔断）');
    const legacyAfter = await get(`SELECT summary FROM sys_issue_timeline WHERE id=?`, [legacyRowId]);
    assert.strictEqual(legacyAfter && legacyAfter.summary, legacyText, `[DN4] 历史遗留 timeline 行应原样不变（不回溯改写）, got「${legacyAfter && legacyAfter.summary}」`);
    ok('[DN4] 历史已落库 timeline 行不回溯：迁移重跑 + 新派生写入后，旧格式遗留行字节级不变（实现坏成什么样这条会红：若日后有人加"批量刷新历史文案"的迁移步骤，这条负例会立即判红）');

    // ─── [DN5] DTO 投影：复用上面已产出的 dnChild2（root=dnRootId/seq=2）验证列表+详情两端点 ───
    console.log('\n═══ [DN5] DTO 投影：GET /sys-issues 列表 + GET /sys-issues/:id 详情两端点均含 derive_root_id/derive_seq（真实 HTTP 请求） ═══');
    const listResp = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(listResp.status, 200, `[DN5] 列表 200, got ${listResp.status}`);
    const listRow = (listResp.body.items || []).find(x => Number(x.id) === Number(dnChild2Id));
    assert.ok(listRow, `[DN5] 列表应含二级派生单 id=${dnChild2Id}（admin 全量可见，若查无此行说明列表 WHERE 或分页把它筛没了）`);
    assert.strictEqual(listRow.derive_root_id, dnRootId, `[DN5] 列表 DTO derive_root_id 应=${dnRootId}, got ${listRow.derive_root_id}`);
    assert.strictEqual(listRow.derive_seq, 2, `[DN5] 列表 DTO derive_seq 应=2, got ${listRow.derive_seq}`);

    const detailResp = await call('GET', `/api/sys-issues/${dnChild2Id}`, adminTok);
    assert.strictEqual(detailResp.status, 200, `[DN5] 详情 200, got ${detailResp.status}`);
    assert.strictEqual(detailResp.body.issue.derive_root_id, dnRootId, `[DN5] 详情 DTO derive_root_id 应=${dnRootId}, got ${detailResp.body.issue.derive_root_id}`);
    assert.strictEqual(detailResp.body.issue.derive_seq, 2, `[DN5] 详情 DTO derive_seq 应=2, got ${detailResp.body.issue.derive_seq}`);
    ok(`[DN5] DTO 投影：GET /sys-issues 列表 + GET /sys-issues/:id 详情均含 derive_root_id=${dnRootId}/derive_seq=2（真实 HTTP 请求验证，实现坏成什么样这条会红：列表/详情 SELECT 漏投影两列任一 → 对应字段 undefined，S13 前端 helper 消费不到数据）`);
  }

  // ─── [DN6] S13-a MED-1 硬验收项：四处 409 文案真实 HTTP 场景（能造几处造几处，造不了处写明原因） ───
  console.log('\n═══ [DN6] MED-1 四处 409 文案子编号：真实 HTTP 场景逐处断言 ═══');
  {
    const dn6Root = await seedBugToOnline();

    // 子单A：只派生，不推进（停在建单初态「待受理」）——专供①②两处场景使用（非待上线/从未加批）。
    const r6a = await deriveBug(dn6Root, { title: 'DN6 子单A（留待受理态）' });
    assert.strictEqual(r6a.status, 201, `[DN6] 派生子单A 201, got ${r6a.status} ${JSON.stringify(r6a.body)}`);
    const dn6ChildA = r6a.body.id;
    const rowA = await rowOf(dn6ChildA);
    const expectA = `#${rowA.derive_root_id}_${rowA.derive_seq}`;
    const statusA = (await get('SELECT status FROM sys_issues WHERE id=?', [dn6ChildA])).status;
    assert.notStrictEqual(statusA, '待上线', `[DN6] 前置：子单A 应停在建单初态非「待上线」（当前「${statusA}」），保证下方 add-issues 命中 ISSUE_NOT_ADDABLE`);

    // 子单B：推进到「待上线」（同 DN3 手工序列）——供①正常加入 + ③④两处场景使用。
    const r6b = await deriveBug(dn6Root, { title: 'DN6 子单B（推进至待上线）' });
    assert.strictEqual(r6b.status, 201, `[DN6] 派生子单B 201, got ${r6b.status} ${JSON.stringify(r6b.body)}`);
    const dn6ChildB = r6b.body.id;
    let adv6 = await call('POST', `/api/sys-issues/${dn6ChildB}/intake-accept`, adminTok, {});
    assert.strictEqual(adv6.status, 200, `[DN6] 子单B intake-accept 200, got ${adv6.status} ${JSON.stringify(adv6.body)}`);
    adv6 = await call('POST', `/api/sys-issues/${dn6ChildB}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(adv6.status, 200, `[DN6] 子单B assign 200, got ${adv6.status} ${JSON.stringify(adv6.body)}`);
    adv6 = await call('POST', `/api/sys-issues/${dn6ChildB}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(adv6.status, 200, `[DN6] 子单B estimate 200, got ${adv6.status} ${JSON.stringify(adv6.body)}`);
    // 派生 bug 首次提交须带 fix_gap_note（FIX_GAP_NOTE_REQUIRED·同 DN3 派生单先例，非根单 seedBugToOnline 缺此参）。
    adv6 = await call('POST', `/api/sys-issues/${dn6ChildB}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'dn6-batch' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'DN6 verify 夹具：bug 产生原因', fix_gap_note: 'DN6 verify 夹具：派生单修复缺口说明' });
    assert.strictEqual(adv6.status, 200, `[DN6] 子单B submit 200, got ${adv6.status} ${JSON.stringify(adv6.body)}`);
    adv6 = await call('POST', `/api/sys-issues/${dn6ChildB}/accept`, adminTok, {});
    assert.strictEqual(adv6.status, 200, `[DN6] 子单B accept 200, got ${adv6.status} ${JSON.stringify(adv6.body)}`);
    const rowB = await rowOf(dn6ChildB);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [dn6ChildB])).status, '待上线', '[DN6] 子单B 应已推进至待上线');
    const expectB = `#${rowB.derive_root_id}_${rowB.derive_seq}`;

    // 建批次（供下方三个真实 HTTP 场景共用）。
    let rRel = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(rRel.status, 201, `[DN6] 建批次 201, got ${rRel.status} ${JSON.stringify(rRel.body)}`);
    const dn6RelId = rRel.body.id;

    // ① add-issues 命中「非待上线」——index.js :15160 一带 ISSUE_NOT_ADDABLE（子单A 仍在待受理态）
    let rAdd = await call('POST', `/api/sys-releases/${dn6RelId}/add-issues`, adminTok, { issue_ids: [dn6ChildA] });
    assert.strictEqual(rAdd.status, 409, `[DN6]① add-issues 命中非待上线应 409, got ${rAdd.status} ${JSON.stringify(rAdd.body)}`);
    assert.strictEqual(rAdd.body.code, 'ISSUE_NOT_ADDABLE');
    assert.ok(rAdd.body.error.includes(expectA), `[DN6]① add-issues 文案应含子编号 ${expectA}（非裸 #${dn6ChildA}）, got「${rAdd.body.error}」`);
    ok(`[DN6]① add-issues ISSUE_NOT_ADDABLE 文案含子编号 ${expectA}（真实 HTTP：子单A 停在待受理态触发，实现坏成什么样这条会红：漏查 dnRow 或直接回退裸 #id）`);

    // 子单B 正常加入（真待上线态，成功，供②③使用）。
    rAdd = await call('POST', `/api/sys-releases/${dn6RelId}/add-issues`, adminTok, { issue_ids: [dn6ChildB] });
    assert.strictEqual(rAdd.status, 200, `[DN6] 子单B 加单应 200, got ${rAdd.status} ${JSON.stringify(rAdd.body)}`);

    // ② remove-issues 命中「不在本批次」——index.js :15265 一带 ISSUE_NOT_REMOVABLE（子单A 从未加入本批次，release_id 仍 NULL）
    let rRemove = await call('POST', `/api/sys-releases/${dn6RelId}/remove-issues`, adminTok, { issue_ids: [dn6ChildA] });
    assert.strictEqual(rRemove.status, 409, `[DN6]② remove-issues 命中不在本批次应 409, got ${rRemove.status} ${JSON.stringify(rRemove.body)}`);
    assert.strictEqual(rRemove.body.code, 'ISSUE_NOT_REMOVABLE');
    assert.ok(rRemove.body.error.includes(expectA), `[DN6]② remove-issues 文案应含子编号 ${expectA}, got「${rRemove.body.error}」`);
    ok(`[DN6]② remove-issues ISSUE_NOT_REMOVABLE 文案含子编号 ${expectA}（真实 HTTP：子单A 从未加入本批次触发，实现坏成什么样这条会红：漏查 dnRow 或直接回退裸 #id）`);

    // ③ 发布核内「批次成员非待上线」——index.js :13706 一带 RELEASE_MEMBER_NOT_READY（子单B 已加批，随后
    //   直连 SQL 造脏：模拟并发把它改回「开发中」但保留 release_id——同 verify-sys-release.js :359-365
    //   既有先例同款手法）。经由真实 /execute 端点触发（非直调内部函数）：单执行人 → CAS 成功 → R-GATE
    //   满足 → 端点内部真调 _publishReleaseCoreInTxn → 命中 members 里的 dn6ChildB 非待上线 → 409 → 整体
    //   回滚（含 CAS 的 done 写入）。
    await run(`UPDATE sys_issues SET status='开发中' WHERE id=?`, [dn6ChildB]);
    let rPut = await call('PUT', `/api/sys-releases/${dn6RelId}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(rPut.status, 200, `[DN6] 设置执行人应 200, got ${rPut.status} ${JSON.stringify(rPut.body)}`);
    const execRow = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`, [dn6RelId]);
    assert.ok(execRow, '[DN6] 应查得 dev 在册执行人行');
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id=?`, [execRow.id]);
    const rExec = await call('POST', `/api/sys-releases/${dn6RelId}/execute`, devTok, { executor_row_id: execRow.id, release_note: 'DN6 验证用上线说明', version_tag: 'dn6' });
    assert.strictEqual(rExec.status, 409, `[DN6]③ execute 触发发布核内成员非待上线应 409, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(rExec.body.code, 'RELEASE_MEMBER_NOT_READY', `[DN6]③ 应精确命中 RELEASE_MEMBER_NOT_READY, got code=${rExec.body.code} body=${JSON.stringify(rExec.body)}`);
    assert.ok(rExec.body.error.includes(expectB), `[DN6]③ 发布核内文案应含子编号 ${expectB}（非裸 #${dn6ChildB}）, got「${rExec.body.error}」`);
    ok(`[DN6]③ 发布核内 RELEASE_MEMBER_NOT_READY 文案含子编号 ${expectB}（真实 HTTP：POST /execute 触发 R-GATE→_publishReleaseCoreInTxn 核内校验，非直调内部函数，实现坏成什么样这条会红：members SELECT 漏投影两列会让 bad 对象取不到 root/seq，helper 静默回退裸 #id）`);

    // ④ RELEASE_MEMBER_NOT_RELEASABLE（index.js :13710 一带 badType 分支）——造不了，如实登记原因：该分支
    //   唯一触发条件是「批次成员 type 不在 RELEASABLE_TYPES 内」，而 sys_issues 表级 DDL 有
    //   `CHECK (type <> 'config' OR release_id IS NULL)`（唯一会落到 badType 的类型是 'config'，其余三类
    //   均在 RELEASABLE_TYPES 内）——任何试图在 release_id 非空时把 type 改成 'config' 的写入都会被该
    //   CHECK 在 DB 层拒绝，结构性不可达，非正常 schema 下可构造的真实 409 场景（:13710 上方注释同款判断）。
    //   不空口白牌，实测证明——若这条断言本身失败（CHECK 未真正拒绝），说明该分支其实可达，需要另行补
    //   真实用例而非继续登记"造不了"：
    let dn6BadTypeErr = null;
    try {
      await run(`UPDATE sys_issues SET type='config' WHERE id=?`, [dn6ChildB]);
    } catch (e) { dn6BadTypeErr = e; }
    assert.ok(dn6BadTypeErr, '[DN6]④ 证据：release_id 非空时把 type 改成 config 应被 DB CHECK 拒绝写入');
    assert.ok(/constraint|CHECK/i.test(dn6BadTypeErr.message), `[DN6]④ 拒绝原因应是 CHECK 约束违例, got「${dn6BadTypeErr.message}」`);
    ok('[DN6]④ RELEASE_MEMBER_NOT_RELEASABLE（:13710）如实登记「造不了」：实测证明 DB CHECK 令该分支在合法 schema 下结构性不可达（非偷懒未测——唯一可触达路径需要先破坏 schema）');
  }

  // ─── [DN7] S13-b·B1 后端投影：post_derive_root_id/post_derive_seq 真实 HTTP DTO 断言（同 DN5 写法） ───
  console.log('\n═══ [DN7] B1「补验收未通过」徽章后端投影：post_derive_root_id/post_derive_seq 真实 HTTP 断言 ═══');
  {
    // 造出 fastlane pending 态——真实 submit(direct_release) 链路已随两步化方案拆除（S2 语义翻转），
    // 结构性不可达；SQL 造态字段组同 verify-sys-post-release-accept.js bugAtFastlanePending 逐字对齐
    // （写读同源，不在两个文件各拼一份可能漂移的造态清单）。
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'DN7 fastlane 根单', system_name: 'BMS', source: '内部', description: 'DN7 verify 夹具', intake_liaison_id: 13 });
    assert.strictEqual(r.status, 201, `[DN7] 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const dn7Id = r.body.id;
    r = await call('POST', `/api/sys-issues/${dn7Id}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[DN7] intake-accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${dn7Id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `[DN7] assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${dn7Id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, `[DN7] estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${dn7Id}/fast-release-authorize`, adminTok, { note: 'DN7 授权' });
    assert.strictEqual(r.status, 200, `[DN7] fast-release-authorize 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'),
      online_source='authorized_fastlane', post_release_acceptance='pending',
      fast_release_consumed_at=datetime('now','localtime') WHERE id=?`, [dn7Id]);

    // 补验收判 fail → 内核自动派生新单（origin=dn7Id 即族根本身，故新单 derive_root_id=dn7Id/derive_seq=1）
    // + 落 post_derive_issue_id 关联字段——这正是 B1 两条标量子查询要投影的目标行。
    r = await call('POST', `/api/sys-issues/${dn7Id}/post-release-accept`, adminTok, { verdict: 'fail', note: 'DN7 补验收未通过' });
    assert.strictEqual(r.status, 200, `[DN7] post-release-accept(fail) 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const dn7ChildId = r.body.post_derive_issue_id;
    assert.ok(dn7ChildId, `[DN7] 响应应携带 post_derive_issue_id, got ${JSON.stringify(r.body)}`);
    // [S13-c·C2 行7 Toast 后端腿] 响应体应直传 post_derive_root_id/post_derive_seq——前端 toast
    // 拼子编号消费的正是这两个字段（S13-b B3 新增，新单此刻不在 siList 里，toast 必须走响应体直传
    // 而非 siList 兜底查找，见 Sys_Iteration.html siIssueDisplayNo(r.data && {...}) 调用点）。
    assert.strictEqual(r.body.post_derive_root_id, dn7Id, `[DN7] 响应体 post_derive_root_id 应=${dn7Id}, got ${r.body.post_derive_root_id}`);
    assert.strictEqual(r.body.post_derive_seq, 1, `[DN7] 响应体 post_derive_seq 应=1, got ${r.body.post_derive_seq}`);
    const childRow = await rowOf(dn7ChildId);
    assert.strictEqual(childRow.derive_root_id, dn7Id, `[DN7] 派生子单 derive_root_id 应=${dn7Id}（族根即 dn7Id 本身), got ${childRow.derive_root_id}`);
    assert.strictEqual(childRow.derive_seq, 1, `[DN7] 派生子单 derive_seq 应=1, got ${childRow.derive_seq}`);

    // 真实 HTTP：GET /sys-issues 列表里根单（dn7Id）行应含 post_derive_root_id/post_derive_seq 两列，
    // 值与派生子单的真实 derive_root_id/derive_seq 一致（标量子查询取的正是这两个值）。
    const listResp = await call('GET', '/api/sys-issues', adminTok);
    assert.strictEqual(listResp.status, 200, `[DN7] 列表 200, got ${listResp.status}`);
    const listRow = (listResp.body.items || []).find((x) => Number(x.id) === Number(dn7Id));
    assert.ok(listRow, `[DN7] 列表应含根单 id=${dn7Id}（admin 全量可见）`);
    assert.strictEqual(listRow.post_derive_root_id, dn7Id, `[DN7] 列表 DTO post_derive_root_id 应=${dn7Id}, got ${listRow.post_derive_root_id}`);
    assert.strictEqual(listRow.post_derive_seq, 1, `[DN7] 列表 DTO post_derive_seq 应=1, got ${listRow.post_derive_seq}`);
    ok(`[DN7] B1 投影：GET /sys-issues 列表 post_derive_root_id=${dn7Id}/post_derive_seq=1（真实 HTTP 请求验证，实现坏成什么样这条会红：标量子查询漏投影/关联列写错 → 字段 undefined 或值与派生子单真实 root/seq 不匹配，前端 siPostAcceptFlagHtml 会因此拿不到权威数据、只能退化到 S13-a 的 siList 兜底路径）`);

    // ─── [DN7b] S13-b·B2 派生链区块数据源：GET /sys-issues/:id 详情应含 derive_family（真实 HTTP，复用同一夹具） ───
    const detailResp7 = await call('GET', `/api/sys-issues/${dn7Id}`, adminTok);
    assert.strictEqual(detailResp7.status, 200, `[DN7b] 详情 200, got ${detailResp7.status}`);
    const family7 = detailResp7.body.derive_family;
    assert.ok(Array.isArray(family7), `[DN7b] 详情应含 derive_family 数组, got ${JSON.stringify(family7)}`);
    assert.strictEqual(family7.length, 2, `[DN7b] 家族应恰 2 名成员（根+1 派生子单）, got ${family7.length}`);
    const familyRoot = family7.find((m) => Number(m.id) === Number(dn7Id));
    const familyChild = family7.find((m) => Number(m.id) === Number(dn7ChildId));
    assert.ok(familyRoot, `[DN7b] 家族应含根单 id=${dn7Id}`);
    assert.ok(familyChild, `[DN7b] 家族应含派生子单 id=${dn7ChildId}`);
    assert.strictEqual(familyRoot.derive_root_id, null, `[DN7b] 根单成员 derive_root_id 应为 NULL, got ${familyRoot.derive_root_id}`);
    assert.strictEqual(familyChild.derive_root_id, dn7Id, `[DN7b] 派生子单成员 derive_root_id 应=${dn7Id}, got ${familyChild.derive_root_id}`);
    assert.strictEqual(familyChild.derive_seq, 1, `[DN7b] 派生子单成员 derive_seq 应=1, got ${familyChild.derive_seq}`);
    ok(`[DN7b] B2 派生链数据源：GET /sys-issues/:id 详情 derive_family 恰 2 名成员且 root/seq 正确（真实 HTTP 请求验证，实现坏成什么样这条会红：resolvedFamilyRootId 算错/WHERE 条件漏一支 → 家族数组缺成员或多算进无关单，前端派生链区块与「已派生#N」链接会漏成员或链接查不到目标行回退真实 id）`);

    // ─── [S13 收口 MED-1] 判别力缺口：以上夹具只有一级派生（dn7Id 根 + dn7ChildId 一级子），详情端点
    //   只曾对**根单**（dn7Id）发过 GET——index.js `resolvedFamilyRootId = row.derive_root_id != null ?
    //   row.derive_root_id : row.id` 里"本单自己就是派生单，改用其 derive_root_id 求根"这一支
    //   （row.derive_root_id != null 为真时）从未被真实覆盖过：DN7b 原断言无论 resolvedFamilyRootId 算
    //   对错，对**根单**发请求时 row.derive_root_id 恒为 NULL，两支写法（row.derive_root_id ?? row.id
    //   vs 误写成 row.id）对根单查询结果完全等价，判别力为零。
    //   补：对 dn7ChildId 再派生一次（复用 deriveBug，同 DN3 二级链造态手法：:1207-1217），产出二级子单
    //   dn7GrandchildId——insertDerivedSysIssue 的 root=origin.derive_root_id??originId 规则决定它的
    //   derive_root_id 展平到族根 dn7Id（非中间单 dn7ChildId），derive_seq 在同族继续递增=2。再对**子单
    //   dn7ChildId 本身**（非根）发 GET 详情，走到此前未覆盖的 resolvedFamilyRootId 分支。
    // bug 类单仅可从「已上线」派生（SYS_DERIVE_ORIGIN_NOT_ONLINE 守卫）——dn7ChildId 此刻仍是新派生单的
    // 建单初态，须先推到「已上线」才能再派生（同 DN3 :1194-1206 同款手工序列，非另起一套）。
    let advL2 = await call('POST', `/api/sys-issues/${dn7ChildId}/intake-accept`, adminTok, {});
    assert.strictEqual(advL2.status, 200, `[DN7b] dn7ChildId intake-accept 200, got ${advL2.status} ${JSON.stringify(advL2.body)}`);
    advL2 = await call('POST', `/api/sys-issues/${dn7ChildId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(advL2.status, 200, `[DN7b] dn7ChildId assign 200, got ${advL2.status} ${JSON.stringify(advL2.body)}`);
    advL2 = await call('POST', `/api/sys-issues/${dn7ChildId}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(advL2.status, 200, `[DN7b] dn7ChildId estimate 200, got ${advL2.status} ${JSON.stringify(advL2.body)}`);
    advL2 = await call('POST', `/api/sys-issues/${dn7ChildId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'dn7b-l2-batch' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'DN7b MED-1 夹具：bug 产生原因', fix_gap_note: 'DN7b MED-1 夹具：派生单修复缺口说明' });
    assert.strictEqual(advL2.status, 200, `[DN7b] dn7ChildId submit 200, got ${advL2.status} ${JSON.stringify(advL2.body)}`);
    advL2 = await call('POST', `/api/sys-issues/${dn7ChildId}/accept`, adminTok, {});
    assert.strictEqual(advL2.status, 200, `[DN7b] dn7ChildId accept 200, got ${advL2.status} ${JSON.stringify(advL2.body)}`);
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [dn7ChildId]);

    const rL2 = await deriveBug(dn7ChildId, { title: 'DN7b 二级派生子单（MED-1 判别力夹具）', derive_reason: 'DN7b MED-1 判别力夹具' });
    assert.strictEqual(rL2.status, 201, `[DN7b] 二级派生 201, got ${rL2.status} ${JSON.stringify(rL2.body)}`);
    const dn7GrandchildId = rL2.body.id;
    const grandRow = await rowOf(dn7GrandchildId);
    assert.strictEqual(grandRow.derive_root_id, dn7Id, `[DN7b] 二级派生单 derive_root_id 应展平到族根=${dn7Id}（非中间单 ${dn7ChildId}）, got ${grandRow.derive_root_id}`);
    assert.strictEqual(grandRow.derive_seq, 2, `[DN7b] 二级派生单 derive_seq 应=2（同族继续递增）, got ${grandRow.derive_seq}`);

    const detailResp7Child = await call('GET', `/api/sys-issues/${dn7ChildId}`, adminTok);
    assert.strictEqual(detailResp7Child.status, 200, `[DN7b] ⭐ 对子单（非根）发详情请求 200, got ${detailResp7Child.status}`);
    const family7Child = detailResp7Child.body.derive_family;
    assert.ok(Array.isArray(family7Child), `[DN7b] ⭐ 子单详情应含 derive_family 数组, got ${JSON.stringify(family7Child)}`);
    assert.strictEqual(family7Child.length, 3, `[DN7b] ⭐ 判别力核心：对**子单**（非根，dn7ChildId）发详情请求，家族应恰 3 名成员（族根+一级子+二级子），实得 ${family7Child.length}——若 resolvedFamilyRootId 误用 row.id（本单自己的 id）而非 row.derive_root_id 求根，WHERE 会变成「id=dn7ChildId OR derive_root_id=dn7ChildId」：dn7GrandchildId 的 derive_root_id 展平后=dn7Id≠dn7ChildId 故查不到、dn7Id 自身 id≠dn7ChildId 也查不到，raw 结果只剩 dn7ChildId 自己一条（length=1），deriveFamily 的「length>1 才算家族」兜底会把它判成空数组`);
    const c7Root = family7Child.find((m) => Number(m.id) === Number(dn7Id));
    const c7Child1 = family7Child.find((m) => Number(m.id) === Number(dn7ChildId));
    const c7Child2 = family7Child.find((m) => Number(m.id) === Number(dn7GrandchildId));
    assert.ok(c7Root, `[DN7b] ⭐ 子单详情家族应含族根 id=${dn7Id}（resolvedFamilyRootId 的 row.derive_root_id != null 分支：本单自己是派生单时应改用 derive_root_id 求根，而非把自己当根）`);
    assert.ok(c7Child1, `[DN7b] 子单详情家族应含自己 id=${dn7ChildId}`);
    assert.ok(c7Child2, `[DN7b] 子单详情家族应含二级子单 id=${dn7GrandchildId}`);
    assert.strictEqual(c7Root.derive_root_id, null, `[DN7b] 族根成员 derive_root_id 应为 NULL, got ${c7Root.derive_root_id}`);
    assert.strictEqual(c7Child1.derive_seq, 1, `[DN7b] 一级子单成员 derive_seq 应=1, got ${c7Child1.derive_seq}`);
    assert.strictEqual(c7Child2.derive_seq, 2, `[DN7b] 二级子单成员 derive_seq 应=2, got ${c7Child2.derive_seq}`);
    ok(`[DN7b] ⭐ MED-1 判别力补强：对二级链的**子单**（非根）发详情请求，derive_family 恰 3 名成员（族根+一级子+二级子）且 root/seq 全对——真实覆盖 resolvedFamilyRootId 的 row.derive_root_id != null 分支（真实 HTTP，正例已在上方跑通，mutation 反证见收尾报告）`);
  }

  // ─── [DN8] S13-c·C1 前端 fixture 一致性（预筛 MED-2·硬验收项）：把 Sys_Iteration.html 的
  //   siIssueDisplayNo 函数体提取出来，在 node 侧实例化编译成真实可调用函数（非仅语法检查——同
  //   verify-sys-post-release-panel-static.js「new Function 编译不执行」姊妹用法的反面：这里编译**且**
  //   真执行），跑 utils/sys-issue-display-no.fixtures.js 全部 fixture，逐条与后端 sysIssueDisplayNo
  //   输出字节级比对。函数体自包含（无外部作用域依赖：只读入参 row 的四个字段+模板字符串拼接），提取后
  //   直接可独立求值，不需要伪造 DOM/window 环境。
  console.log('\n═══ [DN8] C1 前端 fixture 一致性：siIssueDisplayNo 前后端逐条字节级比对（node 侧实例化真执行） ═══');
  {
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    // 提取函数体——[S13 收口 LOW 追-6] 改用 scripts/lib/extract-function-body.js 单点实现（与
    // verify-sys-list-badge-fields.js/verify-sys-derive-display.js 共用同一份，不再各自逐字维护）。
    const fnText = extractFunctionBody(htmlSrc, 'siIssueDisplayNo');
    assert.ok(fnText, '[DN8] siIssueDisplayNo 函数体应可从 Sys_Iteration.html 提取（提不到=守卫空转，不能当通过——同 badge-fields 守卫纪律）');
    // [S13 收口 LOW 追-7] 机械核验上方注释里的"函数体自包含"声称——不能只靠人读注释相信它不碰浏览器
    // 全局。堵的具体假绿：如果 siIssueDisplayNo 未来被改到引用页面全局（如误写 `siList`/`siDetail`/
    // `esc`/`UnifyHelpers`/`document`/`window`/`navigator`），`new Function` 编译本身仍会成功（这些
    // 标识符在 Node 顶层作用域要么是 undefined 的自由变量、要么（`document`/`navigator` 在部分 Node
    // 版本/环境下）被 polyfill/全局垫片顶替出同名但语义不同的对象）——编译不报错、跑起来也可能不炸，
    // 只会在某些 fixture 输入下悄悄算错，字节级比对不一定能覆盖到"错在哪个分支"，是一类"同名异义"
    // 假绿。此处直接扫描提取到的源码文本，不允许出现这些标识符作为独立单词。
    const FORBIDDEN_GLOBAL_RE = /\b(document|window|siList|siDetail|esc|UnifyHelpers|navigator)\b/;
    assert.ok(!FORBIDDEN_GLOBAL_RE.test(fnText), `[DN8] siIssueDisplayNo 函数体不应引用页面全局标识符（document/window/siList/siDetail/esc/UnifyHelpers/navigator），实测命中：${(fnText.match(FORBIDDEN_GLOBAL_RE) || [])[0]}——若命中，说明函数已不再自包含，node 侧实例化的结果不能代表浏览器里的真实行为`);
    let frontendSysIssueDisplayNo;
    try {
      // eslint-disable-next-line no-new-func
      frontendSysIssueDisplayNo = new Function(`return (${fnText});`)();
    } catch (e) {
      frontendSysIssueDisplayNo = null;
      assert.fail(`[DN8] 前端 siIssueDisplayNo 函数体编译失败（提取物本身不是合法可求值的函数表达式）: ${e.message}`);
    }
    assert.strictEqual(typeof frontendSysIssueDisplayNo, 'function', '[DN8] 提取物编译后应为可调用函数');
    const fixtures = require('../utils/sys-issue-display-no.fixtures');
    assert.ok(Array.isArray(fixtures) && fixtures.length >= 10, `[DN8] fixture 文件应导出数组且 ≥10 条（当前含 LOW-3 null 边界一条），实抓 ${fixtures.length}`);
    for (const f of fixtures) {
      const backendGot = sysDeriveNumbering.sysIssueDisplayNo(f.input);
      const frontendGot = frontendSysIssueDisplayNo(f.input);
      assert.strictEqual(backendGot, f.expected, `[DN8] 后端 fixture「${f.label}」应=${JSON.stringify(f.expected)}, got ${JSON.stringify(backendGot)}`);
      assert.strictEqual(frontendGot, f.expected, `[DN8] 前端（node 侧实例化）fixture「${f.label}」应=${JSON.stringify(f.expected)}, got ${JSON.stringify(frontendGot)}（实现坏成什么样这条会红：前端判空逻辑与后端不同源——如误用真值判断 \`if (row.derive_seq)\`——seq=0 边界条会从 #50_0 误判成 #102 回退，字节级比对当场抓到，非仅"两端都有函数"这种结构相似性检查）`);
      assert.strictEqual(frontendGot, backendGot, `[DN8] 前后端「${f.label}」应逐字节完全一致（同规则禁双实现的一致性证据），前端=${JSON.stringify(frontendGot)} 后端=${JSON.stringify(backendGot)}`);
    }
    ok(`[DN8] C1 前端 fixture 一致性：全部 ${fixtures.length} 条 siIssueDisplayNo(前端实例化真执行)===sysIssueDisplayNo(后端直调)===fixture.expected 三方逐字节比对通过`);
  }

  // ─── [DN9] 406-M3② 枚举断言：S12-b「行8」markdown builder 全部直调，输出含子编号非裸 #id ───
  //   背景：S12-b 把"含单号文案的 markdown builder"逐个改成经 sysIssueDisplayNo helper 取号（见
  //   index.js:16672-16887 逐函数 "[S12-b·§15.3 行 8]" 注释）。本组枚举名单硬编码这 10 个函数——
  //   其中 buildSysDevMarkdown 内部两条独立模板分支（默认 assign 分支 / notifyReturnedToDeveloper
  //   分支）各自拼一次单号，逐分支单独覆盖，故枚举共 11 项（对应 S12-b 提交记录"11处markdown builder"
  //   的原始计数口径：按"模板处"计非按"函数"计）。逐个真实直调（非复刻字符串模板去比对——那样测的是
  //   verify 自己的理解，不是产品代码），断言输出（title+md 拼接）含正确的 #根_序 子编号、且不含裸
  //   "#真实id" 形态（若未来某新 builder 忘接 helper、直接拼 issue.id，本组会当场红，与 [C2-S①] 反
  //   双实现扫描互补——那个扫描防"另开一处 #${a}_${b} 拼接"新写点，防不住"某处仍在用裸 #id 没接上
  //   helper"这种忘接场景，两者合起来才闭合）。
  //   ⚠️ 如实登记（非本组遗漏）：buildSysRequesterMarkdown（需求方业务侧文案，方案层面故意不显示内部
  //   单号——业务方不该看到内部编号体系）与 buildSysEtaOverrunReasonMarkdown（超容差理由通知，文案本身
  //   不设单号字段，只有系统/需求/期望/预计/超期原因等描述字段）两者结构上不消费 sysIssueDisplayNo，
  //   见各自定义处（index.js:16692/16756）注释，非本组漏枚举。
  console.log('\n═══ [DN9] 406-M3② markdown builder 枚举：11 处含单号文案全直调，输出含子编号非裸 #id ═══');
  {
    const mdIssue = {
      id: 999, derive_root_id: 5, derive_seq: 2,
      title: 'DN9 markdown builder 枚举夹具标题', system_name: 'BMS', status: '待受理', type: 'bug',
      dev_estimated_at: '2026-08-20 10:00:00', hold_by_name: 'DN9夹具人', resume_by_name: 'DN9夹具人',
    };
    const expectedNo = sysDeriveNumbering.sysIssueDisplayNo(mdIssue);
    assert.strictEqual(expectedNo, '#5_2', `[DN9] 前置：夹具应产出 #5_2, got ${expectedNo}`);
    const bareId = `#${mdIssue.id}`;   // #999——若某 builder 漏接 helper 直拼 issue.id 会落成这个形态
    const baseUrl = 'http://localhost:3000';
    const BUILDERS = [
      ['buildSysDevMarkdown', 'assign 分支', () => I.buildSysDevMarkdown(mdIssue, 'assign', baseUrl)],
      ['buildSysDevMarkdown', 'notifyReturnedToDeveloper 分支', () => I.buildSysDevMarkdown(mdIssue, 'notifyReturnedToDeveloper', baseUrl)],
      ['buildSysRelayMarkdown', null, () => I.buildSysRelayMarkdown(mdIssue, baseUrl)],
      ['buildSysCreatorMarkdown', null, () => I.buildSysCreatorMarkdown(mdIssue, baseUrl)],
      ['buildSysIntakeMarkdown', null, () => I.buildSysIntakeMarkdown(mdIssue, baseUrl)],
      ['buildSysLiaisonTestMarkdown', null, () => I.buildSysLiaisonTestMarkdown(mdIssue, baseUrl)],
      ['buildSysIntakeReturnCreatorMarkdown', null, () => I.buildSysIntakeReturnCreatorMarkdown(mdIssue, 'DN9 退改原因', baseUrl)],
      ['buildSysHoldCreatorMarkdown', null, () => I.buildSysHoldCreatorMarkdown(mdIssue, 'DN9 暂缓原因', baseUrl)],
      ['buildSysResumeDevMarkdown', null, () => I.buildSysResumeDevMarkdown(mdIssue, 'DN9 重启说明', baseUrl)],
      ['buildSysTechLeadMarkdown', null, () => I.buildSysTechLeadMarkdown(mdIssue, baseUrl)],
      ['buildSysTechLeadCommentReplyMarkdown', null, () => I.buildSysTechLeadCommentReplyMarkdown(mdIssue, baseUrl)],
    ];
    assert.strictEqual(BUILDERS.length, 11, '[DN9] 前置：枚举名单应恰 11 项（10 个函数，buildSysDevMarkdown 两条模板分支各记一项）');
    for (const [fnName, branch, call] of BUILDERS) {
      const label = branch ? `${fnName}(${branch})` : fnName;
      assert.strictEqual(typeof I[fnName], 'function', `[DN9] ${fnName} 应已从 _internals 导出可直调`);
      const out = call();
      assert.ok(out && typeof out.md === 'string', `[DN9] ${label} 应返回 { title, md } 结构且 md 为字符串`);
      const combined = `${out.title || ''}\n${out.md}`;
      assert.ok(combined.includes(expectedNo), `[DN9] ${label} 输出应含子编号 ${expectedNo}，实得 title="${out.title}" md="${out.md}"`);
      assert.ok(!combined.includes(bareId), `[DN9] ${label} 输出不应含裸 ${bareId}（若漏接 helper 直拼 issue.id 会落成这个形态），实得 title="${out.title}" md="${out.md}"`);
    }
    ok(`[DN9] 406-M3② markdown builder 枚举：全部 ${BUILDERS.length} 处（10 函数）真实直调，输出均含子编号 ${expectedNo}、均不含裸 ${bareId}（实现坏成什么样这条会红：任一 builder 漏接/绕开 sysIssueDisplayNo helper 直拼 issue.id，该处立即报出裸 id 命中，mutation 自证见收尾报告）`);
  }

  console.log(`\n✅ verify-sys-derive-numbering 全绿：${passed} 项`);
  server.close();
  db.close();
}

main().catch(e => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
