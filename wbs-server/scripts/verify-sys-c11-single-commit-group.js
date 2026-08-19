// scripts/verify-sys-c11-single-commit-group.js — C11 验收：HRD 类系统 commit 提交不分前后端（单组「版本号」）
//   SSOT = 上线执行人多选与双确认 方案 v1.7 §10.3（配置化清单 + DTO 契约后端唯一权威 + 读路径合并展示 +
//   统计派生函数 + 校验复用 SVN + 与 §10.1 交互）。
//   用法：node scripts/verify-sys-c11-single-commit-group.js
//
// 覆盖：
//   A 判定源与 DTO 契约（默认配置=HRD）：详情/列表下发 single_commit_group/group_label/allowed_components；
//     命中 HRD=三字段命中态、非命中 BMS=两组照旧。
//   B 提交归一 component=backend（无视客户端传值）：submit / POST commits / PUT commits 三写入口。
//   C 存量 frontend 合并展示 + 统计不进分母：列表命中系统 backend_commit_refs=全 commit 合并（id 序）、
//     frontend_commit_refs 置空；非命中系统仍按 component 分两列；详情 dev_commits 原样返回（不迁移数据）。
//   D 校验复用 SVN（零新增）：SVN 样例合法、超长 400、空白 400——复用既有 backend commit_ref trim 1..200 口径。
//   E config 覆盖（replace 语义 + 默认兜底 + JSON 形态）：写 config 即以 config 为准；空/畸形回落默认 HRD。
//   F 与 §10.1（C9）交互：HRD 无 commit（no_code）→ 表内 0 行（component 无关），C9 行数判据天然覆盖。
//   G 前端静态（2026-08-19 RPA程序 批·不起浏览器·纯源码文本）：单组路径文案已中性化（不写死 SVN）+
//     软提示在单组路径整体豁免且判据早于双组两条判定；**双组路径 SVN 文案原样保留**作对照面。
//
// in-process app + 内存库 + 自签 token，同 verify-sys-multidev-commits.js 范式。readSystemConfig 用可控
// 覆盖桩（configValue 闭包变量）——默认 null（→回落代码默认 HRD），E 组显式改值测 replace/JSON/回落。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');
const fs = require('fs');                                                  // [G] 前端静态组用
const path = require('path');                                              // [G] 前端静态组用
const { extractFunctionBody } = require('./lib/extract-function-body');     // [G] 前端静态组用

const SECRET = 'verify-sys-c11-single-commit-group-secret';
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

// ⭐ 可控配置桩：sys_single_commit_group_systems 返回 configValue（默认 null → 回落代码默认 HRD）；
//   其余键（钉钉/dry_run 等）返回 ''（通知走 best-effort stub，不影响 submit 主流程）。放在
//   _sys-attach-test-deps 之后覆盖其默认 readSystemConfig。
let configValue = null;
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  readSystemConfig: async (key) => (key === 'sys_single_commit_group_systems' ? configValue : ''),
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
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const system = extra.system_name || 'BMS';
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, estimated_effort_days)
     VALUES (?, ?, ?, ?, '内部', 1, '管理员', ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, system, est, effort]
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
async function commitsOf(issueId) {
  return all('SELECT id, dev_assignee_id, dev_user_id, component, commit_ref FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id', [issueId]);
}
async function detailIssue(issueId, tok) {
  const r = await call('GET', `/api/sys-issues/${issueId}`, tok || adminTok);
  assert.strictEqual(r.status, 200, `详情应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function listRow(issueId) {
  const r = await call('GET', '/api/sys-issues', adminTok);
  assert.strictEqual(r.status, 200, `列表应 200，实际 ${r.status}`);
  const row = (r.body.items || []).find(x => x.id === issueId);
  assert.ok(row, `列表应含 issue #${issueId}`);
  return row;
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  assert.strictEqual(failed.length, 0, `${label}：应满足全部探针恒真，实际失败：${JSON.stringify(failed)}`);
}

(async () => {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active')`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),(5,'dev5','开发甲','user','active')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });

  // ══════════════════════════════════════════════════════════════════════
  // A：判定源 + DTO 契约（默认配置 configValue=null → 回落代码默认 HRD）
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    const hrd = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'A-HRD 单' });
    await mkMember(hrd, 5, '开发甲', 'pending');   // 开发中单需 ≥1 在册（P12）
    const bms = await mkIssue('improvement', '开发中', { system_name: 'BMS', title: 'A-BMS 单' });
    await mkMember(bms, 5, '开发甲', 'pending');

    const dHrd = await detailIssue(hrd);
    assert.strictEqual(dHrd.issue.single_commit_group, true, 'A1：HRD 详情 single_commit_group=true');
    assert.strictEqual(dHrd.issue.group_label, '版本号', 'A1：HRD 详情 group_label=版本号');
    assert.deepStrictEqual(dHrd.issue.allowed_components, ['backend'], 'A1：HRD 详情 allowed_components=[backend]');

    const dBms = await detailIssue(bms);
    assert.strictEqual(dBms.issue.single_commit_group, false, 'A2：BMS 详情 single_commit_group=false');
    assert.strictEqual(dBms.issue.group_label, null, 'A2：BMS 详情 group_label=null');
    assert.deepStrictEqual(dBms.issue.allowed_components, ['frontend', 'backend'], 'A2：BMS 详情 allowed_components=[frontend,backend]');
    ok('A1/A2：详情 DTO 契约——HRD 命中三字段（true/版本号/[backend]）、BMS 非命中（false/null/[frontend,backend]）');

    const rHrd = await listRow(hrd);
    assert.strictEqual(rHrd.single_commit_group, true, 'A3：列表 HRD single_commit_group=true');
    assert.strictEqual(rHrd.group_label, '版本号', 'A3：列表 HRD group_label=版本号');
    assert.deepStrictEqual(rHrd.allowed_components, ['backend'], 'A3：列表 HRD allowed_components=[backend]');
    assert.strictEqual(rHrd.all_commit_refs, undefined, 'A3：列表内部合并列 all_commit_refs 不外泄');
    const rBms = await listRow(bms);
    assert.strictEqual(rBms.single_commit_group, false, 'A3：列表 BMS single_commit_group=false');
    ok('A3：列表 DTO 契约逐行下发（HRD 命中/BMS 非命中）+ 内部合并列 all_commit_refs 不外泄');

    // A4（2026-08-12·随 BIZ_SYSTEMS 新增「电子签」同批·codex 341 MED 收口后升级为全集交叉断言）：
    //   代码默认清单 × BIZ_SYSTEMS 全集**逐系统钉死命中/不命中两态**。
    //   ⚠️ 本组存在的理由：E4 只断言「回落默认后 HRD 命中」，**没断言默认集合恰好=哪些系统**——
    //   往 DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 增删非 HRD 项，E4 照样全绿（改默认值时实测确认）。
    //   ⚠️ 首版 A4 只断言「电子签命中」，同样只覆盖单点：**误加**第三个系统进默认清单仍全绿（codex 341
    //   MED-1 打回）。故改为遍历 BIZ_SYSTEMS 全集，期望命中集之外的系统逐个断言**不命中**——
    //   误删（期望命中的没命中）/误加（期望不命中的命中了）双向都判红。
    //   ⚠️ 将来往 BIZ_SYSTEMS 加新系统时，本组会强制作者显式决定它进不进单组清单：新系统默认落在
    //   EXPECTED_DEFAULT_SINGLE 之外，若实现里让它命中了，这里立刻红。**这是有意的摩擦，勿删。**
    //   判定源同源：BIZ_SYSTEMS 走 I.transitions（=mod._internals.transitions，后端唯一权威），
    //   不在测试里另抄一份清单（抄一份的话 BIZ_SYSTEMS 改了这里不会红，退化成永真守卫）。
    //   2026-08-19 追加「RPA程序」（用户拍板·单一流程包交付无前后端之分；其 VCS 是 git 而非 SVN——
    //   单组清单自此不再同构于 SVN，相应的前端文案/软提示豁免见 [G] 组）。
    const EXPECTED_DEFAULT_SINGLE = new Set(['HRD', '电子签', 'RPA程序']);
    const allSystems = I.transitions.BIZ_SYSTEMS;
    assert.ok(Array.isArray(allSystems) && allSystems.length >= 2, 'A4：BIZ_SYSTEMS 应为非空数组（判定源同源自检）');
    for (const sysName of EXPECTED_DEFAULT_SINGLE) {
      assert.ok(allSystems.includes(sysName), `A4：期望命中的「${sysName}」必须在 BIZ_SYSTEMS 内（否则本断言恒不生效=永真守卫）`);
    }
    for (const sysName of allSystems) {
      const shouldHit = EXPECTED_DEFAULT_SINGLE.has(sysName);
      const iss = await mkIssue('improvement', '开发中', { system_name: sysName, title: `A4-${sysName} 单` });
      await mkMember(iss, 5, '开发甲', 'pending');
      const d = await detailIssue(iss);
      assert.strictEqual(d.issue.single_commit_group, shouldHit, `A4：${sysName} 详情 single_commit_group 应=${shouldHit}`);
      assert.strictEqual(d.issue.group_label, shouldHit ? '版本号' : null, `A4：${sysName} 详情 group_label 应=${shouldHit ? '版本号' : 'null'}`);
      assert.deepStrictEqual(d.issue.allowed_components, shouldHit ? ['backend'] : ['frontend', 'backend'],
        `A4：${sysName} 详情 allowed_components 应=${shouldHit ? '[backend]' : '[frontend,backend]'}`);
      const r = await listRow(iss);
      assert.strictEqual(r.single_commit_group, shouldHit, `A4：${sysName} 列表 single_commit_group 应=${shouldHit}`);
      assert.deepStrictEqual(r.allowed_components, shouldHit ? ['backend'] : ['frontend', 'backend'],
        `A4：${sysName} 列表 allowed_components 应=${shouldHit ? '[backend]' : '[frontend,backend]'}`);
    }
    ok(`A4：代码默认清单 × BIZ_SYSTEMS 全集交叉钉死（${allSystems.length} 系统逐个验命中/不命中两态·命中集=${[...EXPECTED_DEFAULT_SINGLE].join('+')}）——误删/误加双向判红`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // B：提交归一 component=backend（无视客户端传值）——submit / POST / PUT 三写入口
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    // B1：HRD submit，客户端传 component=frontend → 落库归一 backend
    const hrd = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'B1-HRD submit 归一' });
    await mkMember(hrd, 5, '开发甲', 'pending');
    const rSub = await call('POST', `/api/sys-issues/${hrd}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'frontend', commit_ref: 'r10001' }, { component: 'backend', commit_ref: 'r10002' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rSub.status, 200, `B1：submit 应 200，实际 ${rSub.status} ${JSON.stringify(rSub.body)}`);
    const cHrd = await commitsOf(hrd);
    assert.strictEqual(cHrd.length, 2, 'B1：2 条 commit 落库');
    assert.ok(cHrd.every(c => c.component === 'backend'), `B1：HRD 全部归一 backend（无视客户端 frontend），实际 ${JSON.stringify(cHrd.map(c => c.component))}`);
    ok('B1：HRD submit——客户端传 frontend/backend 两条，服务端强制全部归一 component=backend');

    // B2：BMS submit，component=frontend → 保持 frontend（非命中系统不归一）
    const bms = await mkIssue('improvement', '开发中', { system_name: 'BMS', title: 'B2-BMS submit 不归一' });
    await mkMember(bms, 5, '开发甲', 'pending');
    const rSub2 = await call('POST', `/api/sys-issues/${bms}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'frontend', commit_ref: 'feat/b2' }, { component: 'backend', commit_ref: 'r20002' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rSub2.status, 200, `B2：submit 应 200，实际 ${rSub2.status} ${JSON.stringify(rSub2.body)}`);
    const cBms = await commitsOf(bms);
    const comps = cBms.map(c => c.component).sort();
    assert.deepStrictEqual(comps, ['backend', 'frontend'], `B2：BMS 保留 frontend/backend 原值，实际 ${JSON.stringify(comps)}`);
    ok('B2：BMS submit——非命中系统 component 原值保留（frontend/backend 两组照旧）');

    // B3：POST /dev/commits HRD，component=frontend → 归一 backend
    const hrd3 = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'B3-HRD POST 归一' });
    await mkMember(hrd3, 5, '开发甲', 'code_submitted', { skipCommit: true });
    await seedCommit(hrd3, (await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5', [hrd3])).id, 5, 'backend', 'r30000');
    const rPost = await call('POST', `/api/sys-issues/${hrd3}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: 'r30001' });
    assert.strictEqual(rPost.status, 200, `B3：POST 应 200，实际 ${rPost.status} ${JSON.stringify(rPost.body)}`);
    assert.strictEqual(rPost.body.commit.component, 'backend', 'B3：POST 响应 component 归一 backend');
    const posted = await get('SELECT component FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['r30001', hrd3]);
    assert.strictEqual(posted.component, 'backend', 'B3：POST 落库 component=backend');
    ok('B3：HRD POST /dev/commits——客户端传 frontend，落库 + 响应均归一 backend');

    // B4：PUT /dev/commits HRD，编辑存量 frontend 行 → 归一 backend（含历史行编辑归一）
    const hrd4 = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'B4-HRD PUT 归一' });
    const da4 = await mkMember(hrd4, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const oldCid = await seedCommit(hrd4, da4, 5, 'frontend', 'legacy-front-1');   // 存量 frontend 行
    const rPut = await call('PUT', `/api/sys-issues/${hrd4}/dev/commits/${oldCid}`, devTok(5), { component: 'frontend', commit_ref: 'r40001' });
    assert.strictEqual(rPut.status, 200, `B4：PUT 应 200，实际 ${rPut.status} ${JSON.stringify(rPut.body)}`);
    assert.strictEqual(rPut.body.commit.component, 'backend', 'B4：PUT 响应 component 归一 backend');
    const putRow = await get('SELECT component, commit_ref FROM sys_issue_dev_commits WHERE id = ?', [oldCid]);
    assert.strictEqual(putRow.component, 'backend', 'B4：PUT 落库把存量 frontend 行归一 backend');
    assert.strictEqual(putRow.commit_ref, 'r40001', 'B4：PUT ref 已更新');
    ok('B4：HRD PUT /dev/commits——存量 frontend 行编辑后归一 backend（合法用户动作·非批量迁移）');

    // B5：HRD submit 两条 frontend+backend 同 ref → 归一后同 backend → 自然键查重 400
    const hrd5 = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'B5-HRD 归一后查重' });
    await mkMember(hrd5, 5, '开发甲', 'pending');
    const rDup = await call('POST', `/api/sys-issues/${hrd5}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'frontend', commit_ref: 'r50001' }, { component: 'backend', commit_ref: 'r50001' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rDup.status, 400, `B5：归一后同 (backend,r50001) 应触发自然键查重 400，实际 ${rDup.status} ${JSON.stringify(rDup.body)}`);
    const c5 = await commitsOf(hrd5);
    assert.strictEqual(c5.length, 0, 'B5：查重 400 → 事务回滚，0 条落库');
    ok('B5：HRD 同 ref 的 frontend+backend 两条归一后同为 (backend,ref) → 自然键查重 400 + 回滚');

    await selfCertifyProbes('B');
  }

  // ══════════════════════════════════════════════════════════════════════
  // C：存量 frontend 合并展示 + 统计不进分母（列表）；详情原样返回不迁移数据
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    // HRD 单：存量 frontend 行（id 较早）+ backend 行（id 较晚）
    const hrd = await mkIssue('improvement', '待验收', { system_name: 'HRD', title: 'C-HRD 合并展示' });
    const da = await mkMember(hrd, 5, '开发甲', 'code_submitted', { skipCommit: true });
    await seedCommit(hrd, da, 5, 'frontend', 'legacy-front-A');   // 历史 frontend（低 id）
    await seedCommit(hrd, da, 5, 'backend', 'r60001');           // backend（高 id）

    const rHrd = await listRow(hrd);
    const feHrd = JSON.parse(rHrd.frontend_commit_refs);
    const beHrd = JSON.parse(rHrd.backend_commit_refs);
    assert.deepStrictEqual(feHrd, [], 'C1：HRD 列表 frontend_commit_refs 置空（不进前后端占比分母）');
    assert.deepStrictEqual(beHrd, ['legacy-front-A', 'r60001'], `C1：HRD 列表 backend_commit_refs=全 commit 合并（id 序·含历史 frontend），实际 ${JSON.stringify(beHrd)}`);
    ok('C1：HRD 列表——历史 frontend 行合并进版本号组（backend_commit_refs 全量 id 序）、frontend_commit_refs 置空');

    // BMS 单：两组照旧分开
    const bms = await mkIssue('improvement', '待验收', { system_name: 'BMS', title: 'C-BMS 两组不变' });
    const daB = await mkMember(bms, 5, '开发甲', 'code_submitted', { skipCommit: true });
    await seedCommit(bms, daB, 5, 'frontend', 'feat/c-bms');
    await seedCommit(bms, daB, 5, 'backend', 'r70001');
    const rBms = await listRow(bms);
    assert.deepStrictEqual(JSON.parse(rBms.frontend_commit_refs), ['feat/c-bms'], 'C2：BMS 列表 frontend_commit_refs 保留');
    assert.deepStrictEqual(JSON.parse(rBms.backend_commit_refs), ['r70001'], 'C2：BMS 列表 backend_commit_refs 保留');
    ok('C2：BMS 列表——非命中系统 frontend/backend 两组各自照旧、不合并');

    // 详情：dev_commits 原样返回全部行（含 frontend·不迁移数据）——前端靠 single_commit_group 显示版本号
    const dHrd = await detailIssue(hrd);
    assert.strictEqual(dHrd.issue.single_commit_group, true, 'C3：HRD 详情 single_commit_group=true（前端据此显示版本号）');
    const compsInDetail = (dHrd.dev_commits || []).map(c => c.component).sort();
    assert.deepStrictEqual(compsInDetail, ['backend', 'frontend'], `C3：HRD 详情 dev_commits 原样保留存量 component（不迁移数据），实际 ${JSON.stringify(compsInDetail)}`);
    ok('C3：HRD 详情 dev_commits 原样返回（含存量 frontend 行·不迁移数据）+ single_commit_group=true 供前端合并显示');

    await selfCertifyProbes('C');
  }

  // ══════════════════════════════════════════════════════════════════════
  // D：校验复用 SVN（零新增）——复用既有 backend commit_ref trim 1..200 口径
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    // D1：SVN 样例合法（纯数字 / r 前缀）
    const hrd = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'D1-SVN 合法' });
    await mkMember(hrd, 5, '开发甲', 'pending');
    const rOk = await call('POST', `/api/sys-issues/${hrd}/submit`, devTok(5), {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r123456' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rOk.status, 200, `D1：SVN 样例 r123456 应 200，实际 ${rOk.status} ${JSON.stringify(rOk.body)}`);
    ok('D1：HRD SVN 样例 commit 号（r123456）合法通过——复用既有 backend commit_ref 口径');

    // D2：超长 400（trim 上限 200·复用既有）
    const hrd2 = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'D2-超长' });
    await mkMember(hrd2, 5, '开发甲', 'pending');
    const rLong = await call('POST', `/api/sys-issues/${hrd2}/submit`, devTok(5), {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r'.repeat(201) }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rLong.status, 400, `D2：超长 commit_ref 应 400，实际 ${rLong.status}`);
    ok('D2：HRD commit_ref 超长（>200）400——复用既有 trim 1..200 口径，零新增校验');

    // D3：空白 400（必填·复用既有）
    const hrd3 = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'D3-空白' });
    await mkMember(hrd3, 5, '开发甲', 'pending');
    const rBlank = await call('POST', `/api/sys-issues/${hrd3}/submit`, devTok(5), {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: '   ' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rBlank.status, 400, `D3：空白 commit_ref 应 400，实际 ${rBlank.status}`);
    ok('D3：HRD commit_ref 纯空白 400——复用既有必填口径');

    await selfCertifyProbes('D');
  }

  // ══════════════════════════════════════════════════════════════════════
  // E：config 覆盖（replace 语义 + 默认兜底 + JSON 形态）
  // ══════════════════════════════════════════════════════════════════════
  {
    const hrd = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'E-HRD' });
    await mkMember(hrd, 5, '开发甲', 'pending');   // 开发中单需 ≥1 在册（P12）
    // 2026-08-17「OA/智数协同」移出 BIZ_SYSTEMS（用户拍板不在维护范围）：本组原用 OA 充当「白名单内、
    //   不在默认单组清单」的代表系统，改用 BMS（同样满足两条件），语义与断言结构不变。
    const bms = await mkIssue('improvement', '开发中', { system_name: 'BMS', title: 'E-BMS' });
    await mkMember(bms, 5, '开发甲', 'pending');

    // E1：config='BMS'（逗号串）→ BMS 命中、HRD 掉出（replace 语义·非并集）
    configValue = 'BMS';
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, true, 'E1：config=BMS → BMS 命中');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, false, 'E1：config=BMS → HRD 掉出（replace 语义·非并集）');
    ok('E1：config 写入即以 config 为准（replace）——config=BMS 使 BMS 命中、HRD 不再命中');

    // E2：config='HRD,BMS' → 两者皆命中
    configValue = 'HRD,BMS';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E2：config=HRD,BMS → HRD 命中');
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, true, 'E2：config=HRD,BMS → BMS 命中');
    ok('E2：config 逗号串多系统——HRD,BMS 两者皆命中');

    // E3：config='["HRD"]' JSON 数组形态 → HRD 命中、BMS 不命中
    configValue = '["HRD"]';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E3：config=JSON ["HRD"] → HRD 命中');
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, false, 'E3：config=JSON ["HRD"] → BMS 不命中');
    ok('E3：config JSON 数组形态——["HRD"] 命中 HRD');

    // E3b（2026-08-12·随「电子签」同批·codex 342 LOW 收口）：**非 ASCII 系统名**走 config 分支。
    //   ⚠️ 存在理由：E1-E3 的系统名全是 ASCII（HRD/BMS），而「电子签」是中文——config 解析链
    //   （split(',') / JSON.parse / trim / Set.has 比对 / 与 system_name 列值等值判定）对多字节
    //   字符串从未被任何用例证明过。A4 只走 config 缺省分支，覆盖不到这里。
    //   注：本组验的是**解析链**；config 值的 AES 加解密往返不在此（E 组用 readSystemConfig 桩，
    //   不经 encrypt/decrypt）。加解密往返另经一次性探针实测确认（中文 hex 往返无损）。
    const esignE = await mkIssue('improvement', '开发中', { system_name: '电子签', title: 'E3b-电子签' });
    await mkMember(esignE, 5, '开发甲', 'pending');
    configValue = 'HRD,电子签';
    assert.strictEqual((await detailIssue(esignE)).issue.single_commit_group, true, 'E3b：config 逗号串含中文 → 电子签命中');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E3b：config=HRD,电子签 → HRD 同时命中');
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, false, 'E3b：config=HRD,电子签 → BMS 不命中（对照组）');
    configValue = '["电子签"]';
    assert.strictEqual((await detailIssue(esignE)).issue.single_commit_group, true, 'E3b：config=JSON ["电子签"] → 电子签命中');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, false, 'E3b：config=JSON ["电子签"] → HRD 掉出（replace 语义对中文同样成立）');
    ok('E3b：非 ASCII 系统名走 config——逗号串/JSON 两形态均命中电子签 + replace 语义对中文成立（对照组 BMS/HRD 不命中）');

    // E4：config 空串 / 畸形 JSON → 回落代码默认 HRD
    configValue = '   ';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E4：config 空白 → 回落默认 HRD');
    configValue = '[not-json';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E4：config 畸形 JSON（[ 前缀）→ 回落默认 HRD');
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, false, 'E4：config 畸形 JSON → BMS 不命中（默认清单只 HRD）');
    // ⭐ [C11-fix2·codex 320 MED] 判据改「JSON.parse 成败」后·各类畸形 JSON 一律回落默认 HRD（修前多类漏网）：
    //   ① { 前缀对象 ② JSON 标量（数字/布尔/null/带引号字符串）③ 数组含非字符串元素——修前①掉 split（C11-fix
    //   补 { 前缀已挡）、②③仍掉 split 或 String 强转成垃圾集静默移除 HRD。两向断言：命中系统 HRD 恒回落 true·
    //   垃圾串/JSON 文本未被当系统名（BMS/非默认恒 false）。
    for (const [cv, tag] of [['{}', '对象{}'], ['{"a":1}', '对象{a}'], ['123', 'JSON数字标量'],
                             ['true', 'JSON布尔标量'], ['null', 'JSONnull标量'], ['"HRD"', 'JSON字符串标量'],
                             ['[123]', '数组含数字'], ['[{}]', '数组含对象']]) {
      configValue = cv;
      assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, `E4b：config=${tag}(${cv}) → 回落默认 HRD（非合法系统名清单一律回落·不硬拆垃圾集）`);
      assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, false, `E4b：config=${tag} → BMS 不命中（未把 JSON 文本/标量当系统名）`);
    }
    // 反向对照：合法 JSON 数组全字符串 + 合法逗号串 仍正常 replace（不被新判据误杀）
    configValue = '["BMS"]';
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, true, 'E4c：合法 JSON 数组 ["BMS"] → BMS 命中（新判据不误杀合法数组）');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, false, 'E4c：["BMS"] replace → HRD 掉出');
    ok('E4：config 空/各类畸形（[ 数组畸形、{ 对象、JSON 标量数字/布尔/null/字符串、数组含非字符串元素、纯空白）一律回落默认 HRD；合法 JSON 数组/逗号串正常 replace（JSON.parse 成败判据·不猜不硬拆垃圾集）');

    configValue = null;   // 复位默认，避免污染 F
  }

  // ══════════════════════════════════════════════════════════════════════
  // F：与 §10.1（C9）交互——HRD 无 commit（no_code）→ 表内 0 行（component 无关），C9 行数判据天然覆盖
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    const hrd = await mkIssue('improvement', '开发中', { system_name: 'HRD', title: 'F-HRD no_code' });
    await mkMember(hrd, 5, '开发甲', 'pending');
    const rNc = await call('POST', `/api/sys-issues/${hrd}/submit`, devTok(5), {
      mode: 'no_code', no_code_reason: 'HRD 本轮无需代码（占位理由）', self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rNc.status, 200, `F：HRD no_code submit 应 200，实际 ${rNc.status} ${JSON.stringify(rNc.body)}`);
    const cF = await commitsOf(hrd);
    assert.strictEqual(cF.length, 0, 'F：HRD no_code → commit 表 0 行（component 无关·C9 行数=0 判据天然覆盖）');
    ok('F：HRD no_code 交付 → 0 commit 行（C9 §10.1 active 行数判据不区分 component·天然覆盖，无需特殊处理）');

    await selfCertifyProbes('F');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [G] 前端静态：单组路径文案中性化 + 软提示单组豁免（2026-08-19「RPA程序」批）
  //   存在理由：RPA程序 入单组清单前，单组成员（HRD/电子签）清一色 SVN，故单组路径把「SVN」写死在
  //   5 处文案里、且软提示（语义=「前端组/后端组填反了」）在单组 component 恒 backend 的前提下会把
  //   git hash 判成误填。RPA程序 的 VCS 是 git——单组清单自此不同构，上述两点从"没人撞上的残留"
  //   变成"必现的误报"。本组把「已中性化」和「单组豁免」钉成源码不变量。
  //   ⚠️ 双组路径（BMS 类）的 SVN/GIT 文案**必须原样保留**，见 G3 对照组——否则"把全文 SVN 删光"
  //   这种改法能让 G2 全绿，是典型的假绿（guard 假绿七坑·对照组证明）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    // 剥注释先行：本批新增的说明注释里大量出现「SVN」「单组」字样，不剥则 G2 零残留断言恒红（假红）。
    //   用删除式 stripComments 而非 lib 的 blankNonCode——后者连字符串字面量内容一起等长掩空，而本组
    //   断言的恰恰是字面量里的**文案文本**。写法照 verify-sys-derive-display.js:57 同款既有范式。
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
    const clean = stripComments(HTML);

    // G1：软提示单组豁免——判据必须在两条 component 判定**之前**（放后面=先返回提示，豁免永不生效）。
    const warnBody = stripComments(extractFunctionBody(HTML, 'siCommitWarnFor'));
    const iSingle = warnBody.indexOf('single_commit_group');
    const iFront = warnBody.indexOf("component === 'frontend'");
    const iBack = warnBody.indexOf("component === 'backend'");
    assert.ok(iSingle >= 0, 'G1：siCommitWarnFor 必须含单组豁免判据 single_commit_group');
    assert.ok(iFront >= 0 && iBack >= 0, 'G1：双组两条判定必须仍在（对照组·防把函数体删空让豁免断言"过关"）');
    assert.ok(iSingle < iFront && iSingle < iBack, `G1：单组豁免必须早于 frontend/backend 两条判定（实测 single=${iSingle} front=${iFront} back=${iBack}·顺序错则豁免不生效）`);
    assert.ok(/single_commit_group\s*\)\s*return\s*''\s*;/.test(warnBody), 'G1：单组豁免必须是 return 空串早退（不是换一套提示文案——平台不掌握各系统 VCS）');
    ok('G1：siCommitWarnFor 单组豁免存在、形态为空串早退、且早于双组两条判定（RPA程序 的 git hash 不再被误报为「应填 SVN 版本号」）');

    // G2：单组路径文案零 SVN（逐个文案点正向钉死 + 回退形态负向钉死）。
    //   ⚠️ [codex 435 LOW-2 登记接受] 上面的 stripComments 是删除式行注释剥离，不是词法级——字符串/
    //   模板/正则字面量里的 `//` 会被误当行注释起点（`https://` 已被 `([^:])` 前缀规避，其余形态没有）。
    //   **不改的依据**：本组的负向断言（G2b/G2d）由**同位置的正向断言背书**——回退写法与正确写法是
    //   替换关系而非新增，任何回退都会先让 G2a 的 `count===2` 或 G2c 的 includes 判红；而 stripComments
    //   若真误删大段文本，同样是正向断言先红。即两个方向的失败面都收敛到**假红**（可见、会被追查），
    //   不产生假绿。⚠️ 残留边界：将来若在本组新增**没有正向断言配对**的孤立负向断言，此背书不成立，
    //   届时须改用词法级剥离或把断言收窄到 extractFunctionBody 抽出的函数体级。
    assert.strictEqual((clean.match(/groupLabel \+ '（trim 1~200 字）'/g) || []).length, 2,
      'G2a：补充/编辑 commit 两弹窗的单组字段标签已去 SVN，且恰 2 处（少于 2=漏改一个弹窗·多于 2=有新入口未纳入本组）');
    assert.ok(!/groupLabel \+ '（SVN/.test(clean), 'G2b：单组字段标签不得回退写死 SVN');
    assert.ok(clean.includes('填「${esc(submitGroupLabel)}」，可加多行'), 'G2c：提交弹窗单组说明文案已去 SVN');
    assert.ok(!/submitGroupLabel\}（SVN/.test(clean), 'G2d：提交弹窗单组组标签不得回退写死 SVN');
    assert.ok(/single \? `\$\{groupLabel\}（1~200字）`/.test(clean), 'G2e：单组行 placeholder 取服务端 group_label，不写死 SVN');
    ok('G2：单组路径 5 个文案点全部中性化（组标签/说明/placeholder/补充弹窗/编辑弹窗）——单组下「SVN」零出现');

    // G3：对照组——双组路径（BMS 类）SVN/GIT 文案原样保留。缺了任何一条都说明改动越界到了双组。
    assert.ok(clean.includes("'后端组（SVN 版本号）'"), 'G3a：双组组标签原样保留');
    assert.ok(clean.includes("'commit_ref（前端 GIT / 后端 SVN）'"), 'G3b：双组 commit 弹窗字段标签原样保留');
    assert.ok(clean.includes("'SVN 版本号（1~200字）'"), 'G3c：双组行 placeholder 原样保留');
    assert.ok(clean.includes('这看起来像 GIT commit；后端组通常填 SVN 版本号'), 'G3d：双组软提示文案原样保留');
    assert.ok(clean.includes('这看起来像 SVN 版本号；前端组通常填 GIT commit'), 'G3e：双组软提示（另一向）原样保留');
    ok('G3：对照组——双组路径 5 处 SVN/GIT 文案全部原样保留（本批不越界·且堵死"删光 SVN 让 G2 假绿"的改法）');

    // G4 [codex 435 LOW-1 采纳]：**行为**断言。G1-G3 全是文本匹配，只证「源码写没写对」，证不了
    //   「跑起来对不对」——codex 指出"保留死代码/无关字符串、破坏真实分支"的变异可能让文本断言假绿，
    //   这正是本仓踩过多次的「层内全绿 ≠ 功能可用」。故把 siCommitWarnFor 抽出来在受控环境真跑。
    //   依赖注入三件全部**从 HTML 同源取**（siDetail 桩由本组构造 + 两个正则从源码解析），
    //   不在本文件另抄正则——抄一份的话 HTML 里正则改了这里不会红，退化成永真守卫。
    //   ⚠️ 登记（非正解）：行为验证的正解位置是 Playwright 层——test-issue-commit-groups-playwright.js
    //   测的正是本函数的软提示 C4。但该套件 2026-08-17 已定案「存量既有红·年久失修·登记不修」，
    //   本探针是短期唯一可落地的行为断言，属绕开该层另起炉灶。Playwright 层修复后应把本组并过去。
    {
      const pickRe = (name) => {
        // [codex 436 risk 采纳] 尾部 flags 段必须一起捕获：漏掉的话 /re/i 会被解析成 /re/，注入的正则
        //   与页面实际行为不同 → G4 变成拿"另一个正则"做的验证（当前两个正则都无 flags，属未来加固）。
        const m = clean.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\/.*?\\/[gimsuy]*)\\s*;'));
        assert.ok(m, `G4：未能从 HTML 解析出 ${name} 定义（同源注入前提失效·勿改成本文件硬编码正则）`);
        return new Function('return ' + m[1])();
      };
      const SVN_RE = pickRe('SI_SVN_REV_RE');
      const GIT_RE = pickRe('SI_GIT_HASH_RE');
      assert.ok(GIT_RE.test('a1b2c3d4e5f') && SVN_RE.test('12345'), 'G4：注入的两正则形态自检（样本须分别命中，否则下方三态验证恒不触发=永真）');

      // 完整函数声明外包一层工厂，闭包注入 siDetail 与两正则
      const fnSrc = extractFunctionBody(HTML, 'siCommitWarnFor');
      const mkWarn = (single) => new Function('siDetail', 'SI_SVN_REV_RE', 'SI_GIT_HASH_RE',
        fnSrc + '\nreturn siCommitWarnFor;')({ issue: { single_commit_group: single } }, SVN_RE, GIT_RE);
      const warnSingle = mkWarn(true);
      const warnDual = mkWarn(false);

      const GIT_SAMPLE = 'a1b2c3d4e5f';   // 7~40 位 hex = RPA程序 开发者会填的真实形态
      const SVN_SAMPLE = '12345';         // 纯数字 = HRD/电子签 的 SVN 版本号形态

      // ⭐ 核心对照：**同一个输入**在单组静默、在双组告警——一次同时证明「豁免真生效」与「功能没被删空」。
      assert.strictEqual(warnSingle('backend', GIT_SAMPLE), '', 'G4a：单组 + git hash → 无提示（RPA程序 主场景·豁免生效）');
      assert.ok(warnDual('backend', GIT_SAMPLE).includes('SVN 版本号'), 'G4b：双组 backend + 同一个 git hash → 仍告警（对照组·豁免没误伤双组）');
      assert.strictEqual(warnSingle('frontend', SVN_SAMPLE), '', 'G4c：单组 + 纯数字 → 无提示（豁免对两个方向都生效，非只挡 backend 一侧）');
      assert.ok(warnDual('frontend', SVN_SAMPLE).includes('GIT commit'), 'G4d：双组 frontend + 同一个纯数字 → 仍告警（对照组·另一向未误伤）');
      assert.strictEqual(warnSingle('backend', ''), '', 'G4e：单组空值 → 无提示');
      assert.strictEqual(warnDual('backend', ''), '', 'G4f：双组空值 → 无提示（空值早退是两态共有的既有行为，本批未改）');
      ok('G4：行为级三态验证——同一 git hash 单组静默/双组告警、同一纯数字单组静默/双组告警、空值两态皆静默（豁免生效 ∧ 双组功能完好，非文本匹配）');
    }
  }

  console.log(`\n✅ verify-sys-c11-single-commit-group 全绿（${passed} 组断言通过）`);
  server.close();
  db.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ verify-sys-c11-single-commit-group 失败：', e && e.stack || e);
  try { server && server.close(); } catch (_) { /* ignore */ }
  try { db.close(); } catch (_) { /* ignore */ }
  process.exit(1);
});
