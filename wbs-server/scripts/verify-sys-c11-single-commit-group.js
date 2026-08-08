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
    const oa = await mkIssue('improvement', '开发中', { system_name: 'OA', title: 'E-OA' });
    await mkMember(oa, 5, '开发甲', 'pending');

    // E1：config='OA'（逗号串）→ OA 命中、HRD 掉出（replace 语义·非并集）
    configValue = 'OA';
    assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, true, 'E1：config=OA → OA 命中');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, false, 'E1：config=OA → HRD 掉出（replace 语义·非并集）');
    ok('E1：config 写入即以 config 为准（replace）——config=OA 使 OA 命中、HRD 不再命中');

    // E2：config='HRD,OA' → 两者皆命中
    configValue = 'HRD,OA';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E2：config=HRD,OA → HRD 命中');
    assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, true, 'E2：config=HRD,OA → OA 命中');
    ok('E2：config 逗号串多系统——HRD,OA 两者皆命中');

    // E3：config='["HRD"]' JSON 数组形态 → HRD 命中、OA 不命中
    configValue = '["HRD"]';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E3：config=JSON ["HRD"] → HRD 命中');
    assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, false, 'E3：config=JSON ["HRD"] → OA 不命中');
    ok('E3：config JSON 数组形态——["HRD"] 命中 HRD');

    // E4：config 空串 / 畸形 JSON → 回落代码默认 HRD
    configValue = '   ';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E4：config 空白 → 回落默认 HRD');
    configValue = '[not-json';
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, 'E4：config 畸形 JSON（[ 前缀）→ 回落默认 HRD');
    assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, false, 'E4：config 畸形 JSON → OA 不命中（默认清单只 HRD）');
    // ⭐ [C11-fix2·codex 320 MED] 判据改「JSON.parse 成败」后·各类畸形 JSON 一律回落默认 HRD（修前多类漏网）：
    //   ① { 前缀对象 ② JSON 标量（数字/布尔/null/带引号字符串）③ 数组含非字符串元素——修前①掉 split（C11-fix
    //   补 { 前缀已挡）、②③仍掉 split 或 String 强转成垃圾集静默移除 HRD。两向断言：命中系统 HRD 恒回落 true·
    //   垃圾串/JSON 文本未被当系统名（OA/非默认恒 false）。
    for (const [cv, tag] of [['{}', '对象{}'], ['{"a":1}', '对象{a}'], ['123', 'JSON数字标量'],
                             ['true', 'JSON布尔标量'], ['null', 'JSONnull标量'], ['"HRD"', 'JSON字符串标量'],
                             ['[123]', '数组含数字'], ['[{}]', '数组含对象']]) {
      configValue = cv;
      assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, true, `E4b：config=${tag}(${cv}) → 回落默认 HRD（非合法系统名清单一律回落·不硬拆垃圾集）`);
      assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, false, `E4b：config=${tag} → OA 不命中（未把 JSON 文本/标量当系统名）`);
    }
    // 反向对照：合法 JSON 数组全字符串 + 合法逗号串 仍正常 replace（不被新判据误杀）
    configValue = '["OA"]';
    assert.strictEqual((await detailIssue(oa)).issue.single_commit_group, true, 'E4c：合法 JSON 数组 ["OA"] → OA 命中（新判据不误杀合法数组）');
    assert.strictEqual((await detailIssue(hrd)).issue.single_commit_group, false, 'E4c：["OA"] replace → HRD 掉出');
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
