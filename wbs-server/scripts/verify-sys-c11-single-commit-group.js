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
//   E config 覆盖（replace 语义 + 默认兜底 + JSON 形态）：写 config 即以 config 为准；空/畸形回落代码
//     默认清单（transitions.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 四成员，本组以 HRD 为代表验证命中）。
//   F 与 §10.1（C9）交互：HRD 无 commit（no_code）→ 表内 0 行（component 无关），C9 行数判据天然覆盖。
//   G 前端静态（2026-08-19 RPA程序 批·不起浏览器·纯源码文本）：单组路径文案已中性化（不写死 SVN）+
//     软提示在单组路径整体豁免且判据早于双组两条判定；**双组路径 SVN 文案原样保留**作对照面。
//   H 小程序-智荟人力 专项（2026-09-02 接入 S2·方案 v1.2 §3）：DTO 三字段契约（H1）+ 发版标识 YYYYMMDD-N
//     形态端到端入库与归一 backend + 可选版本号第二行并存（H2）+ BMS 反证不归一（H3）+ 与清单无关的既有闸
//     行为级留痕：空 commits 400 VALIDATION / 删光最后一条 400 GATE_INVARIANT（H4a/H4b）+ 主提交路径/PUT
//     两写入口的单组归一复核（H8/H9）。
//   I 脚本执行级守卫（2026-09-02 S2c·codex 493 H1）：真跑子进程验证一次性运维脚本
//     _set-sys-single-commit-group.js——无参数拒绝/缺清单成员拒绝（可 --allow-drop 放行）/--check-only
//     只读不写库/DB_ENCRYPTION_KEY fail-closed；I0 钉判定源上移后 transitions 常量与 A4 仍同源。
//
// in-process app + 内存库 + 自签 token，同 verify-sys-multidev-commits.js 范式。readSystemConfig 用可控
// 覆盖桩（configValue 闭包变量）——默认 null（→回落 transitions.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 四
// 成员默认清单·以生产常量为权威源），E 组显式改值测 replace/JSON/回落。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');
const { spawnSync } = require('child_process');                            // [I] 脚本执行级守卫组用
const os = require('os');                                                  // [I] 临时 db 路径用
const crypto = require('crypto');                                          // [I] I7 解密回读用（同脚本 aes-256-cbc 口径）
const fs = require('fs');                                                  // [G]/[I] 用
const path = require('path');                                              // [G]/[I] 用
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

// ⭐ 可控配置桩：sys_single_commit_group_systems 返回 configValue（默认 null → 回落
//   transitions.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 四成员默认清单·以生产常量为权威源）；
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
  // A：判定源 + DTO 契约（默认配置 configValue=null → 回落 transitions.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 四成员默认清单·以生产常量为权威源）
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
    //   2026-09-02 追加「小程序-智荟人力」（用户拍板·发版无版本号不分前后端，同档走单组「版本号」；
    //   发版标识约定与既有守卫的行为级复核见下方 [H] 组）。
    const EXPECTED_DEFAULT_SINGLE = new Set(['HRD', '电子签', 'RPA程序', '小程序-智荟人力']);
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
    assert.strictEqual((await detailIssue(bms)).issue.single_commit_group, false, 'E4：config 畸形 JSON → BMS 不命中（默认清单不含 BMS）');
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

  // ══════════════════════════════════════════════════════════════════════
  // H：小程序-智荟人力 专项（2026-09-02·S2 发版标识约定）
  //   SSOT=小程序智荟人力接入_方案_20260831_v1.2.md §3。A4 已把「小程序-智荟人力」纳入 BIZ_SYSTEMS
  //   全集交叉钉死（命中/不命中两态），本组补 A4 覆盖不到的**发版标识 YYYYMMDD-N 形态端到端行为**——
  //   即 §3.2 表格"标识可能缺失"担忧的行为级复核（H4）+ 归一判据究竟是清单成员身份还是 commit_ref
  //   字符串形态本身（H3 反证）。
  // ══════════════════════════════════════════════════════════════════════
  configValue = null;
  {
    // H1：DTO 三字段契约（对应方案 §3.2 表述）——feature 单 + code_submitted 在册（同一张单供 H2/H4b 复用）
    const mp = await mkIssue('feature', '开发中', { system_name: '小程序-智荟人力', title: 'H1-小程序 DTO 契约' });
    await mkMember(mp, 5, '开发甲', 'code_submitted', { skipCommit: true });   // skipCommit：H2 自行 POST 两行

    const dMp = await detailIssue(mp);
    assert.strictEqual(dMp.issue.single_commit_group, true, 'H1：小程序详情 single_commit_group=true');
    assert.strictEqual(dMp.issue.group_label, '版本号', 'H1：小程序详情 group_label=版本号（D2 拍板沿用不改）');
    assert.deepStrictEqual(dMp.issue.allowed_components, ['backend'], 'H1：小程序详情 allowed_components=[backend]');
    const rMp = await listRow(mp);
    assert.strictEqual(rMp.single_commit_group, true, 'H1：小程序列表 single_commit_group=true');
    assert.strictEqual(rMp.group_label, '版本号', 'H1：小程序列表 group_label=版本号');
    assert.deepStrictEqual(rMp.allowed_components, ['backend'], 'H1：小程序列表 allowed_components=[backend]');
    ok('H1：小程序-智荟人力 DTO 三字段契约（详情+列表同款）——清单漏加成员/group_label 改错/allowed_components 未归一 backend 任一坏了本条会红');

    // H2：发版标识形态端到端入库——commit_ref='YYYYMMDD-N'、客户端故意传 component='frontend'（应被强制归一）
    const rDate = await call('POST', `/api/sys-issues/${mp}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: '20260902-1' });
    assert.strictEqual(rDate.status, 200, `H2：POST 发版标识行应 200，实际 ${rDate.status} ${JSON.stringify(rDate.body)}`);
    assert.strictEqual(rDate.body.commit.component, 'backend', 'H2：响应 component 归一 backend（无视客户端 frontend）');
    const rowDate = await get('SELECT component, commit_ref FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['20260902-1', mp]);
    assert.ok(rowDate, 'H2：发版标识行应已落库');
    assert.strictEqual(rowDate.component, 'backend', 'H2：落库 component 归一 backend（D1 拍板=不做格式校验，仅 component 归一）');
    assert.strictEqual(rowDate.commit_ref, '20260902-1', 'H2：commit_ref 原样入库（YYYYMMDD-N 无格式正则拦截）');

    // 可选第二行：同组再加一行小程序版本号（§3.2「零额外改造」）
    const rVer = await call('POST', `/api/sys-issues/${mp}/dev/commits`, devTok(5), { component: 'backend', commit_ref: 'v1.2.3' });
    assert.strictEqual(rVer.status, 200, `H2：POST 可选版本号行应 200，实际 ${rVer.status} ${JSON.stringify(rVer.body)}`);
    const rowsMp = await commitsOf(mp);
    const refsMp = rowsMp.map(r => r.commit_ref).sort();
    assert.deepStrictEqual(refsMp, ['20260902-1', 'v1.2.3'], `H2：同实例两行并存（发版标识+可选版本号），实际 ${JSON.stringify(refsMp)}`);
    assert.ok(rowsMp.every(r => r.component === 'backend'), 'H2：两行均归一 backend');
    ok('H2：发版标识 YYYYMMDD-N 形态无格式校验放行 + 归一 backend 落库 + 同实例可选版本号第二行并存——误加格式正则会拒此形态/归一失效会落 frontend/查重键算错会拒第二行，任一坏了本条会红');

    // H3：反证对照——同样 body 打到 BMS（双组系统）→ component 不归一，证明归一判据是清单成员身份而非 commit_ref 形态
    const bmsH = await mkIssue('improvement', '开发中', { system_name: 'BMS', title: 'H3-BMS 反证对照' });
    await mkMember(bmsH, 5, '开发甲', 'code_submitted', { skipCommit: true });
    const rBmsDate = await call('POST', `/api/sys-issues/${bmsH}/dev/commits`, devTok(5), { component: 'frontend', commit_ref: '20260902-1' });
    assert.strictEqual(rBmsDate.status, 200, `H3：BMS POST 应 200，实际 ${rBmsDate.status} ${JSON.stringify(rBmsDate.body)}`);
    const rowBmsDate = await get('SELECT component FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['20260902-1', bmsH]);
    assert.ok(rowBmsDate, 'H3：BMS 发版标识行应已落库（前置存在性——缺行时判红而非裸解引用砸套件·codex 123-M 同款）');
    assert.strictEqual(rowBmsDate.component, 'frontend', `H3：BMS（双组）同样的 commit_ref 形态不触发归一，component 保留 frontend，实际 ${rowBmsDate && rowBmsDate.component}`);
    ok('H3：反证对照——同一 commit_ref 形态（20260902-1）在 BMS（双组系统）不归一，证明归一判据是清单成员身份而非字符串形态——若误改判据看 commit_ref 格式，本条会红');

    // H4：既有守卫不受新成员影响
    // H4a：commits 模式 0 条 → 400「commits 至少 1 条」（validateSubmitBody 内·S2 前 :9649，S2 注释 +3 行后 :9652）
    const mpEmpty = await mkIssue('feature', '开发中', { system_name: '小程序-智荟人力', title: 'H4a-小程序空 commits' });
    await mkMember(mpEmpty, 5, '开发甲', 'pending');
    const rEmpty = await call('POST', `/api/sys-issues/${mpEmpty}/submit`, devTok(5), {
      mode: 'commits', commits: [], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rEmpty.status, 400, `H4a：小程序 commits 空数组应 400，实际 ${rEmpty.status} ${JSON.stringify(rEmpty.body)}`);
    assert.strictEqual(rEmpty.body.error, 'commits 至少 1 条', `H4a：错误文案应精确匹配，实际 ${JSON.stringify(rEmpty.body)}`);
    assert.strictEqual(rEmpty.body.code, 'VALIDATION', `H4a：错误码应精确匹配 VALIDATION，实际 ${JSON.stringify(rEmpty.body)}`);
    ok('H4a：小程序单 commits 空数组仍 400「commits 至少 1 条」——本条钉的是与单组清单无关的既有 body 校验闸不被后续改动放宽（validateSubmitBody 不读 system_name，清单编辑在结构上不影响此闸；若该闸被删/改弱本条会红）');

    // H4b：DELETE 到剩余 1 条时再删 → 400 GATE_INVARIANT（既有 DELETE 端点守卫）
    const c1 = await get('SELECT id FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['20260902-1', mp]);
    const c2 = await get('SELECT id FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['v1.2.3', mp]);
    assert.ok(c1 && c2, 'H4b：两行 commit 应都在库（前置存在性——缺行时判红而非 c1.id/c2.id 裸解引用砸套件）');
    const rDel1 = await call('DELETE', `/api/sys-issues/${mp}/dev/commits/${c2.id}`, devTok(5), { reason: '清理测试用第二行（占位理由）' });
    assert.strictEqual(rDel1.status, 200, `H4b：删到剩 1 条应 200，实际 ${rDel1.status} ${JSON.stringify(rDel1.body)}`);
    const rDel2 = await call('DELETE', `/api/sys-issues/${mp}/dev/commits/${c1.id}`, devTok(5), { reason: '尝试删光最后一条（占位理由）' });
    assert.strictEqual(rDel2.status, 400, `H4b：删光最后一条应 400，实际 ${rDel2.status} ${JSON.stringify(rDel2.body)}`);
    assert.strictEqual(rDel2.body.code, 'GATE_INVARIANT', `H4b：错误码应精确匹配 GATE_INVARIANT，实际 ${JSON.stringify(rDel2.body)}`);
    const remain = await commitsOf(mp);
    assert.strictEqual(remain.length, 1, 'H4b：拒绝后仍剩 1 条（未被删空）');
    ok('H4b：小程序单删到剩余 1 条 commit 行时再删 → 400 GATE_INVARIANT，行未被删空——本条钉的是与单组清单无关的既有 DELETE 守卫不被后续改动放宽（守卫只按 dev_assignee_id+code_submitted 计数，与 component 归一无关；若守卫失效会 200 且行数归零，本条会红）');

    // H8（2026-09-02 S2c·codex 493 M1 采纳）：H2/H3 测的是 POST /dev/commits 补充行入口，本条覆盖
    //   submit 首次提交（三写入口之一、也是最常走的一条）——防止 submit 分支与 POST/PUT 分支各自维护
    //   一份归一判据、彼此漂移。
    const mp8 = await mkIssue('feature', '开发中', { system_name: '小程序-智荟人力', title: 'H8-小程序 submit 归一' });
    await mkMember(mp8, 5, '开发甲', 'pending');
    const rSub8 = await call('POST', `/api/sys-issues/${mp8}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'frontend', commit_ref: '20260903-1' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(rSub8.status, 200, `H8：小程序 submit 应 200，实际 ${rSub8.status} ${JSON.stringify(rSub8.body)}`);
    const row8 = await get('SELECT component, commit_ref FROM sys_issue_dev_commits WHERE commit_ref = ? AND issue_id = ?', ['20260903-1', mp8]);
    assert.ok(row8, 'H8：submit 落库的发版标识行应存在（前置存在性）');
    assert.strictEqual(row8.component, 'backend', 'H8：主提交路径（submit）同样归一 backend');
    assert.strictEqual(row8.commit_ref, '20260903-1', 'H8：commit_ref 原样入库');
    ok('H8：小程序 pending 成员经真实 /submit（mode:commits，发版标识行 commit_ref=20260903-1）提交 → 落库归一 backend、commit_ref 原样入库——若 submit 分支漏用单组判定保留 frontend，本条会红');

    // H9（2026-09-02 S2c·codex 493 M1 采纳）：对 H2 已落的 20260902-1 行（此刻正是 mp 上仅剩的那一条，
    //   H4b 已删掉第二行、删光最后一条被拒）走 PUT /dev/commits/:id 编辑，客户端仍故意传 frontend。
    //   ⚠️ commit_ref 须换成新值——PUT 端点有「规范化后与自身相同→400 无实际变化」的既有守卫（:10292），
    //   若沿用同一 commit_ref，归一后 (backend, 20260902-1) 与库中现值完全相同，会被该守卫拦成 400，
    //   测不到归一分支本身。
    const rPut9 = await call('PUT', `/api/sys-issues/${mp}/dev/commits/${c1.id}`, devTok(5), { component: 'frontend', commit_ref: '20260902-1v2' });
    assert.strictEqual(rPut9.status, 200, `H9：PUT 应 200，实际 ${rPut9.status} ${JSON.stringify(rPut9.body)}`);
    assert.strictEqual(rPut9.body.commit.component, 'backend', 'H9：PUT 响应 component 归一 backend');
    const row9 = await get('SELECT component, commit_ref FROM sys_issue_dev_commits WHERE id = ?', [c1.id]);
    assert.ok(row9, 'H9：PUT 编辑的行应仍存在（前置存在性）');
    assert.strictEqual(row9.component, 'backend', 'H9：PUT 落库仍归一 backend');
    assert.strictEqual(row9.commit_ref, '20260902-1v2', 'H9：commit_ref 已更新为新值（证明真走了修改分支，非被无变化守卫拦截后误判绿）');
    ok('H9：小程序既有发版标识行经 PUT /dev/commits 编辑（客户端传 frontend、commit_ref 换新值）→ 落库仍归一 backend——PUT 与 POST/submit 三写入口判据一致，若 PUT 分支漏用单组判定把该行改回 frontend，本条会红');

    await selfCertifyProbes('H');
  }

  // ══════════════════════════════════════════════════════════════════════
  // I：脚本执行级守卫（2026-09-02 S2c/S2d·codex 493/493-R H/M 采纳）—— _set-sys-single-commit-group.js
  //   存在理由：codex 493 H1 指出该一次性运维脚本默认参数 'HRD' 是单组清单 config replace 语义失败
  //   路径（config 一旦写入即整体覆盖代码默认）的**唯一现成入口**，脚本头部注释警告不构成运行时保护
  //   ——不带参数直接跑会把当时代码默认清单里除 HRD 外的全部成员静默踢出单组。S2c 收口=①删除默认参数
  //   （无参数直接拒绝）②DB_ENCRYPTION_KEY fail-closed（同 server.js 2026-08-26 约定，删硬编码回退）
  //   ③写入值须 ⊇ 代码默认清单（可 --allow-drop 显式放行）④--check-only 只读不写库。
  //   S2d 复审（codex 493-R）再补两处：H＝开关解析当时只是"识别到就用、识别不到就忽略"的白名单式判断
  //   （`.includes('--allow-drop')` 风格），对**未登记**的 `--` 开头参数（拼错的 --checkonly/--allowdrop、
  //   重复开关、位置参数数量≠1）不拒绝——脚本改为**开关白名单 fail-closed**，见下方 I6/I6b/I6c；
  //   M＝清单判定源虽已上移 transitions.js，但① I0 当时只 deepStrictEqual 值、没证明"引用同一个对象"（万一
  //   index.js 哪天又切回 `[...T.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS]` 浅拷贝，值仍相等但已经是两份副本，
  //   deepStrictEqual 测不出来）；②此前只验证了"拒绝路径不写库"，没有任何用例验证"允许路径真的写对了
  //   db"（脚本加了 SYS_SINGLE_COMMIT_GROUP_DB_PATH 测试专用路径注入后，才有安全的真写口子），见下方
  //   I0/I7。本组真起子进程（spawnSync）+ 真开临时 sqlite 文件验证这些保护，而非改读脚本源码文本
  //   ——文本断言证不了"跑起来对不对"（层内全绿 ≠ 功能可用，本仓 guard_static_analysis_gotchas 沉淀同款）。
  //   S2e 复审（codex 493-R2）再补两处：M2＝I7 当时只证明"能解密回读"，没证明"二次同参数真的走了 UPDATE
  //   而非提前退出/no-op"——加密用随机 IV，同明文两次密文必不同，故补 c1≠c2 断言；M3＝
  //   SYS_SINGLE_COMMIT_GROUP_DB_PATH 本身没有门槛，脚本改为**仅在同时带 --allow-db-override 时生效**，
  //   env 存在但缺开关直接拒绝（见下方 I8），且写库前（含 --check-only）恒打印 TARGET_DB 绝对路径供审计
  //   （见 I8b）。⇒ 本组所有依赖 runScript() 注入临时路径的用例（I1-I7）都必须在 args 里显式带上
  //   --allow-db-override，否则会被这道新加的门槛拦在半路、测不到各自原本要测的分支。
  //   S2f 末次合并审（codex 496）再补两处：H＝S2e 只堵了"有 env 无开关"一半，没堵"有开关无 env（或
  //   env 拼错/未导出/被清空）"——这种情况 dbPath 会静默回落默认 task_pool.db，若又没带 --check-only
  //   就是真写生产库，见下方 I9/I9b；M1＝密钥长度校验用的是 UTF-16 字符数不是字节数，含非 ASCII 字符的
  //   密钥可能"凑够 32 个字符"却通不过真实字节要求，见下方 I10/I10b。
  // ══════════════════════════════════════════════════════════════════════
  {
    const SCRIPT_PATH = path.join(__dirname, '_set-sys-single-commit-group.js');
    const CWD = path.join(__dirname, '..');
    const VALID_KEY = 'x'.repeat(32);
    const FULL_LIST = 'HRD,电子签,RPA程序,小程序-智荟人力';

    // 每次调用生成一个独立、大概率不存在的临时 db 路径（pid+时间戳+随机段），供"拒绝路径不得触达 db"
    // 类断言使用——断言该路径始终不存在，就证明了脚本在拒绝分支里从未走到打开 db 那一步。
    function makeTmpDbPath() {
      return path.join(os.tmpdir(), `verify-sys-c11-scg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    }
    // dbPath 显式传参（默认自动生成一个），返回值挂 dbPath 供调用方断言。
    function runScript(args, envOverride, dbPath) {
      const targetDbPath = dbPath !== undefined ? dbPath : makeTmpDbPath();
      const env = { ...process.env, DB_ENCRYPTION_KEY: VALID_KEY, SYS_SINGLE_COMMIT_GROUP_DB_PATH: targetDbPath, ...(envOverride || {}) };
      const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: CWD, env, encoding: 'utf8' });
      result.dbPath = targetDbPath;
      return result;
    }
    // 逐字复刻脚本内 decryptPassword 的对偶（脚本只有 encrypt，没有 decrypt——本组解密回读用同款
    // aes-256-cbc/iv:hex 拼接口径逆向解出，验证"真加密真能解"而非只看密文非空）。
    function decryptLikeScript(encryptedStr, key) {
      const parts = encryptedStr.split(':');
      const iv = Buffer.from(parts[0], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.padEnd(32).slice(0, 32)), iv);
      let dec = decipher.update(parts[1], 'hex', 'utf8');
      dec += decipher.final('utf8');
      return dec;
    }

    // I0：判定源上移后仍单一——三重断言，缺一不足以证明"真的没有第二份副本"：
    //   ①引用同一对象（=== 而非 deepStrictEqual——值相等但对象不同=浅拷贝出的第二份，测不出来）；
    //   ②值恰为四成员（对象同一之外，内容本身也要对）；
    //   ③脚本源码零系统名数组字面量（防脚本内部另抄一份清单——那样"判定源单一"只是嘴上说说）。
    assert.strictEqual(I.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS, I.transitions.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS,
      'I0①：index.js 消费的 DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 应与 transitions.js 导出的是同一个数组引用（=== 而非仅值相等）');
    assert.deepStrictEqual(I.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS, ['HRD', '电子签', 'RPA程序', '小程序-智荟人力'],
      'I0②：DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS 应恰为四成员清单');
    const scriptSrc = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.ok(scriptSrc.includes('T.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS'), 'I0③：脚本源码应含 T.DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS（引用 transitions 导出，非自行拼一份）');
    assert.ok(!/\[\s*'(HRD|电子签|RPA程序|小程序-智荟人力)'/.test(scriptSrc), 'I0③：脚本源码不应出现系统名数组字面量（如 [\'HRD\', ...]）——出现即说明脚本自行硬编码了一份清单副本');
    ok('I0：判定源上移后仍单一——index.js 消费者与 transitions 导出同一个数组对象（非浅拷贝副本）+ 值恰四成员 + 脚本源码零系统名字面量清单（不是自行另抄一份）——三者任一坏了本条会红');

    // I1：无参数（仅带 --allow-db-override 使其通过 M3 门槛，不干扰本条要测的"位置参数数量≠1"拒绝）→
    //   status 1（不设默认参数，杜绝"忘记传参=静默用旧清单"入口）；db 文件不得被创建。
    const r1 = runScript(['--allow-db-override']);
    assert.strictEqual(r1.status, 1, `I1：无参数应 exit 1，实际 ${r1.status}\nstdout=${r1.stdout}\nstderr=${r1.stderr}`);
    assert.ok(!fs.existsSync(r1.dbPath), 'I1：拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I1：脚本无参数直接 exit 1（打印用法）+ 未创建 db 文件——若默认参数回归（如硬编码 \'HRD\'），本条会红（status 变 0 或 db 文件被创建）');

    // I2："HRD" 不带 --allow-drop（带 --allow-db-override 过 M3 门槛）→ status 1，且缺项列出「电子签」
    //   「RPA程序」「小程序-智荟人力」；db 文件不得被创建。
    const r2 = runScript(['HRD', '--allow-db-override']);
    assert.strictEqual(r2.status, 1, `I2：缺成员未带 --allow-drop 应 exit 1，实际 ${r2.status}`);
    const r2Out = (r2.stdout || '') + (r2.stderr || '');
    assert.ok(r2Out.includes('电子签'), `I2：缺项应含「电子签」，实际输出：${r2Out}`);
    assert.ok(r2Out.includes('RPA程序'), `I2：缺项应含「RPA程序」，实际输出：${r2Out}`);
    assert.ok(r2Out.includes('小程序-智荟人力'), `I2：缺项应含「小程序-智荟人力」，实际输出：${r2Out}`);
    assert.ok(!fs.existsSync(r2.dbPath), 'I2：拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I2：写入值缺代码默认清单成员且未带 --allow-drop → exit 1 且缺项逐项列出 + 未创建 db 文件——若 ⊇ 校验被删/放宽，本条会红');

    // I3（2026-09-02 S2d 改造）：全量清单 + --check-only（带 --allow-db-override 过 M3 门槛）→ status 0 +
    //   输出含 CHECK_OK + 注入的临时 db 文件始终不存在（比"不出现已写入字样"更硬——直接证明进程从未在磁盘
    //   上创建/打开过那个文件）。
    const r3 = runScript([FULL_LIST, '--check-only', '--allow-db-override']);
    assert.strictEqual(r3.status, 0, `I3：全量清单 + --check-only 应 exit 0，实际 ${r3.status}\nstderr=${r3.stderr}`);
    assert.ok((r3.stdout || '').includes('CHECK_OK'), `I3：输出应含 CHECK_OK，实际：${r3.stdout}`);
    assert.ok(!fs.existsSync(r3.dbPath), 'I3：--check-only 不应创建/打开 db 文件（临时路径应始终不存在）');
    ok('I3：全量清单 + --check-only → exit 0 + CHECK_OK + 临时 db 文件始终不存在——若 --check-only 判据失效会真打开 db（文件会被 sqlite3 创建出来），本条会红；判据方向写反（该放行的反而拦截）会 status 非 0');

    // I4："HRD" + --allow-drop + --check-only + --allow-db-override → status 0（显式开关放行缺项）；
    //   db 文件不得被创建。
    const r4 = runScript(['HRD', '--allow-drop', '--check-only', '--allow-db-override']);
    assert.strictEqual(r4.status, 0, `I4：--allow-drop 应放行缺项校验，实际 exit ${r4.status}\nstderr=${r4.stderr}`);
    assert.ok((r4.stdout || '').includes('CHECK_OK'), `I4：输出应含 CHECK_OK，实际：${r4.stdout}`);
    assert.ok(!fs.existsSync(r4.dbPath), 'I4：--check-only 不应创建/打开 db 文件（临时路径应始终不存在）');
    ok('I4：缺项但显式 --allow-drop + --check-only → exit 0 + 未创建 db 文件——若 --allow-drop 判据方向写反（对缺项仍拦截，或对全量清单也误拦截），本条会红');

    // I5：DB_ENCRYPTION_KEY 缺失/非法 → status 1（fail-closed）。⚠️ 不能靠"从 spawnSync env 里删掉该键"
    //   模拟缺失——脚本内部 require('dotenv').config() 会从磁盘上真实的 wbs-server/.env 文件回填该键
    //   （dotenv 默认只填充 process.env 里"尚未存在"的键；本地实测过，.env 里恰好留着一个历史值，删键
    //   测试会静默通过、验证不到 fail-closed）。改为显式把该键覆盖为空串（''）——空串在 process.env 里
    //   "已存在"，dotenv 不会覆盖，脚本内 `!ENCRYPTION_KEY` 判真触发。db 文件不得被创建。带 --allow-db-override
    //   过 M3 门槛（否则会被环境变量门槛先一步拦截，测不到本条真正要测的 fail-closed 分支）。
    const r5 = runScript([FULL_LIST, '--check-only', '--allow-db-override'], { DB_ENCRYPTION_KEY: '' });
    assert.strictEqual(r5.status, 1, `I5：DB_ENCRYPTION_KEY 为空应 exit 1（fail-closed），实际 ${r5.status}\nstdout=${r5.stdout}`);
    assert.ok((r5.stderr || '').includes('DB_ENCRYPTION_KEY'), `I5：错误信息应提及 DB_ENCRYPTION_KEY，实际：${r5.stderr}`);
    assert.ok(!fs.existsSync(r5.dbPath), 'I5：fail-closed 拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I5：DB_ENCRYPTION_KEY 为空（模拟缺失）→ exit 1 fail-closed + 未创建 db 文件——若硬编码回退值回归，本条会红（status 变 0）');

    // I6（2026-09-02 S2d·codex 493-R H 采纳）：未知开关（拼错 --checkonly）→ status 1，输出含「未知」
    //   或「非法」，db 文件不得被创建——旧版 `.includes('--check-only')` 式判断会把 --checkonly 当成一个
    //   普通"未识别 flag"直接忽略（既不算开启 check-only，也不报错），静默按默认路径继续，本条钉的正是这个坑。
    const r6 = runScript([FULL_LIST, '--checkonly', '--allow-db-override']);
    assert.strictEqual(r6.status, 1, `I6：拼错开关 --checkonly 应 exit 1，实际 ${r6.status}\nstdout=${r6.stdout}\nstderr=${r6.stderr}`);
    const r6Out = (r6.stdout || '') + (r6.stderr || '');
    assert.ok(r6Out.includes('未知') || r6Out.includes('非法'), `I6：输出应含「未知」或「非法」，实际：${r6Out}`);
    assert.ok(!fs.existsSync(r6.dbPath), 'I6：未知开关拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I6：全量清单 + 拼错开关 --checkonly → exit 1 + 输出含未知/非法提示 + 未创建 db 文件——若开关解析退化为"识别到就用、识别不到就忽略"，本条会红（status 变 0 或误当默认路径放行）');

    // I6b：拼错组合 "HRD" --allow-drop --checkonly → status 1（未知开关优先于缺项校验被拦，不因
    //   --allow-drop 已给而侥幸放行；且不得写库——即便这条 body 本身缺成员，也不该是"缺项 400"，
    //   而应是"未知开关拒绝"，两种拒绝原因不能混）。
    const r6b = runScript(['HRD', '--allow-drop', '--checkonly', '--allow-db-override']);
    assert.strictEqual(r6b.status, 1, `I6b：拼错组合应 exit 1，实际 ${r6b.status}\nstdout=${r6b.stdout}\nstderr=${r6b.stderr}`);
    assert.ok(!fs.existsSync(r6b.dbPath), 'I6b：拼错组合拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I6b："HRD" --allow-drop --checkonly（合法开关+拼错开关混用）→ exit 1 + 未创建 db 文件——拼错组合不得因另一个开关合法而侥幸放行，本条会红时说明未知开关判据只挑着看');

    // I6c：两个位置参数 → status 1（位置参数数量≠1 直接拒绝），db 文件不得被创建。
    const r6c = runScript(['HRD', '电子签', '--allow-db-override']);
    assert.strictEqual(r6c.status, 1, `I6c：两个位置参数应 exit 1，实际 ${r6c.status}\nstdout=${r6c.stdout}\nstderr=${r6c.stderr}`);
    assert.ok(!fs.existsSync(r6c.dbPath), 'I6c：位置参数数量非法的拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I6c：两个位置参数（"HRD" "电子签"）→ exit 1 + 未创建 db 文件——若位置参数数量校验被删/放宽（例如只取 argv[0] 忽略多余参数），本条会红');

    // I7（2026-09-02 S2d·codex 493-R M2 采纳，S2e·codex 493-R2 M2 补强）：真写临时库双向——此前的绿灯
    //   全部止步于"进程 exit code 对不对"，从未验证"允许路径真的把值写对了 db"。本条：①在临时路径建
    //   system_configs 表（DDL 照 server.js:2150-2156 五列）；②首次真写（无 --check-only，带
    //   --allow-db-override 过 M3 门槛）→ 用与脚本同款 aes-256-cbc 解密回读，得到的明文必须与写入串逐字
    //   相等；③二次同参数再跑一次 → 走 ON CONFLICT 更新分支不报错、仍恰 1 行（幂等，非插入第二行）+
    //   密文与首次不同（随机 IV，证明真执行了 UPDATE 而非提前退出/no-op）。[rec 采纳] 临时库关闭与文件
    //   删除放 try/finally，任一断言失败也不遗留文件/连接。
    {
      const dbPath7 = makeTmpDbPath();
      let setupDb = null;
      let readDb = null;
      try {
        setupDb = new sqlite3.Database(dbPath7);
        await new Promise((resolve, reject) => {
          setupDb.run(
            `CREATE TABLE system_configs (
              config_key TEXT PRIMARY KEY,
              config_value_encrypted TEXT,
              updated_by INTEGER,
              updated_by_name TEXT,
              updated_at DATETIME DEFAULT (datetime('now','localtime'))
            )`,
            (e) => (e ? reject(e) : resolve())
          );
        });
        await new Promise((resolve, reject) => setupDb.close((e) => (e ? reject(e) : resolve())));
        setupDb = null;

        const rWrite1 = runScript([FULL_LIST, '--allow-db-override'], undefined, dbPath7);
        assert.strictEqual(rWrite1.status, 0, `I7：首次真写应 exit 0，实际 ${rWrite1.status}\nstdout=${rWrite1.stdout}\nstderr=${rWrite1.stderr}`);
        assert.ok(fs.existsSync(dbPath7), 'I7：首次真写后临时 db 文件应存在（前置存在性——反证 I1-I6 的"不存在"判据不是恒真）');

        readDb = new sqlite3.Database(dbPath7);
        const row1 = await new Promise((resolve, reject) => {
          readDb.get(`SELECT config_value_encrypted FROM system_configs WHERE config_key = 'sys_single_commit_group_systems'`, (e, r) => (e ? reject(e) : resolve(r)));
        });
        assert.ok(row1, 'I7：首次写入后应能读到该行（前置存在性）');
        const c1 = row1.config_value_encrypted;
        const decrypted1 = decryptLikeScript(c1, VALID_KEY);
        assert.strictEqual(decrypted1, FULL_LIST, `I7：解密回读应等于原始写入清单串，实际 ${decrypted1}`);

        const rWrite2 = runScript([FULL_LIST, '--allow-db-override'], undefined, dbPath7);
        assert.strictEqual(rWrite2.status, 0, `I7：二次同参数真写（ON CONFLICT 更新）应 exit 0，实际 ${rWrite2.status}\nstderr=${rWrite2.stderr}`);
        const rowsAfter = await new Promise((resolve, reject) => {
          readDb.all(`SELECT config_key FROM system_configs WHERE config_key = 'sys_single_commit_group_systems'`, (e, rows) => (e ? reject(e) : resolve(rows)));
        });
        assert.strictEqual(rowsAfter.length, 1, `I7：二次写入后仍恰 1 行（ON CONFLICT 更新非插入新行），实际 ${rowsAfter.length}`);
        const row2 = await new Promise((resolve, reject) => {
          readDb.get(`SELECT config_value_encrypted FROM system_configs WHERE config_key = 'sys_single_commit_group_systems'`, (e, r) => (e ? reject(e) : resolve(r)));
        });
        const c2 = row2.config_value_encrypted;
        // [S2e·codex 493-R2 M2 采纳] 加密用随机 IV——同一明文两次加密密文必不同。若二次写入退化为提前
        //   退出/no-op（例如误加了一条"已存在则跳过"分支），c2 会等于 c1——rowsAfter.length===1 只能证明
        //   "没插入第二行"，证不了"真的执行了 UPDATE"，本条断言专门补这个缺口。
        assert.notStrictEqual(c2, c1, 'I7：二次写入密文应与首次不同（同明文随机 IV 加密两次密文必不同）——若相同，说明二次写入未真正执行 UPDATE（提前退出/no-op）');
        const decrypted2 = decryptLikeScript(c2, VALID_KEY);
        assert.strictEqual(decrypted2, FULL_LIST, 'I7：二次写入解密回读仍等于原始清单串');

        ok('I7：真写临时库双向验证——首次写入解密回读等于原始清单串 + 二次同参数写入走 ON CONFLICT 更新（密文因随机 IV 与首次不同、解密仍等于原串、仍恰 1 行）——若脚本内加密/写入分支有误，或二次写入退化为 no-op，或 ON CONFLICT 子句被破坏产生重复行，本条会红');
      } finally {
        if (readDb) { await new Promise((resolve) => readDb.close(() => resolve())); }
        if (setupDb) { await new Promise((resolve) => setupDb.close(() => resolve())); }
        if (fs.existsSync(dbPath7)) { try { fs.unlinkSync(dbPath7); } catch (_) { /* best-effort cleanup */ } }
      }
    }

    // I8（2026-09-02 S2e·codex 493-R2 M3 采纳）：env 设了 SYS_SINGLE_COMMIT_GROUP_DB_PATH（runScript()
    //   恒注入）但**不带** --allow-db-override → status 1，输出含「allow-db-override」，db 文件不得被创建
    //   ——钉住"部署环境残留该变量却没人显式确认覆盖"这一场景必须硬拒绝，而非静默用了被污染的路径。
    const r8 = runScript([FULL_LIST, '--check-only']);
    assert.strictEqual(r8.status, 1, `I8：设 env 不带 --allow-db-override 应 exit 1，实际 ${r8.status}\nstdout=${r8.stdout}\nstderr=${r8.stderr}`);
    const r8Out = (r8.stdout || '') + (r8.stderr || '');
    assert.ok(r8Out.includes('allow-db-override'), `I8：输出应提及 allow-db-override，实际：${r8Out}`);
    assert.ok(!fs.existsSync(r8.dbPath), 'I8：env 门槛拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I8：设 SYS_SINGLE_COMMIT_GROUP_DB_PATH 但未带 --allow-db-override → exit 1 + 输出含 allow-db-override 提示 + 未创建 db 文件——若该门槛被删/放宽，本条会红（status 变 0 或提示消失）');

    // I8b（2026-09-02 S2e·codex 493-R2 M3 采纳）：env + --allow-db-override + --check-only → status 0，
    //   输出含 TARGET_DB= 且精确等于本次注入的临时路径——不只是"没报错"，而是证明脚本真的解析到了
    //   覆盖路径（而非静默落回生产 task_pool.db 却照样打印一个看似正常的 TARGET_DB）。
    const r8b = runScript([FULL_LIST, '--allow-db-override', '--check-only']);
    assert.strictEqual(r8b.status, 0, `I8b：env+开关+check-only 应 exit 0，实际 ${r8b.status}\nstderr=${r8b.stderr}`);
    assert.ok((r8b.stdout || '').includes('TARGET_DB='), `I8b：输出应含 TARGET_DB=，实际：${r8b.stdout}`);
    assert.ok((r8b.stdout || '').includes(r8b.dbPath), `I8b：TARGET_DB 应精确含本次注入的临时路径 ${r8b.dbPath}，实际：${r8b.stdout}`);
    ok('I8b：env + --allow-db-override + --check-only → exit 0 + TARGET_DB 精确等于注入的临时路径——若路径解析/覆盖逻辑有误（如仍打印生产路径），本条会红');

    // I9（2026-09-02 S2f·codex 496 H 采纳 → 496-R H 改安全失败形态）：传 --allow-db-override 但 env 被彻底
    //   删除（非空串，是真的不存在）→ 必须命中对称拒绝分支的**精确文案**。⚠️ 安全失败设计（496-R）：本条**同时注入
    //   一个非法短密钥**——对称分支在密钥校验之前，正确实现下先打印对称 REJECT 文案退出；若对称分支被删/回归，
    //   执行会落到密钥校验 [FATAL] 安全退出，**绝不会打开任何 db**，而本条因文案不符仍判红。首版曾以真实
    //   task_pool.db 的 mtime/size 作探针——保护分支回归时测试自身会先真写默认库再判红（变异自证实测
    //   changes=1），依赖外部备份还原覆盖不了崩溃/强杀/并发，故删除对真实库的一切依赖。
    //   为什么不能只删 DB_ENCRYPTION_KEY：脚本 dotenv 会从 ../.env 回填缺失的变量，显式非法值才能压过 dotenv。
    const REJECT_PAIR_TEXT = '带了 --allow-db-override 但未设置 SYS_SINGLE_COMMIT_GROUP_DB_PATH';
    const r9 = runScript([FULL_LIST, '--allow-db-override'], { SYS_SINGLE_COMMIT_GROUP_DB_PATH: undefined, DB_ENCRYPTION_KEY: 'short-invalid-key' });
    assert.strictEqual(r9.status, 1, `I9：--allow-db-override 但 env 缺失应 exit 1，实际 ${r9.status}\nstdout=${r9.stdout}\nstderr=${r9.stderr}`);
    const r9Out = (r9.stdout || '') + (r9.stderr || '');
    assert.ok(r9Out.includes(REJECT_PAIR_TEXT), `I9：输出应含对称拒绝精确文案「${REJECT_PAIR_TEXT}」（证明拒绝发生在密钥校验之前），实际：${r9Out}`);
    assert.ok(!r9Out.includes('[FATAL] 环境变量 DB_ENCRYPTION_KEY'), `I9：不应走到密钥校验（对称拒绝在前）——若出现 FATAL 说明对称分支已失效、仅靠安全网兜住，实际：${r9Out}`);
    // 用行首锚定：printUsage 的帮助文本里也含「TARGET_DB=」字样（描述该开关行为），裸 includes 会把帮助文本误计
    //   （首版即踩此坑=断言写错非实现错）；真正的路径打印是独立一行 `TARGET_DB=<绝对路径>`。
    assert.ok(!/^TARGET_DB=/m.test(r9Out), `I9：拒绝路径不应打印独立行 TARGET_DB=<路径>（不应解析/打开任何 db），实际：${r9Out}`);
    ok('I9：--allow-db-override 但 env 缺失（真删除）→ exit 1 + 对称拒绝精确文案 + 未到密钥校验 + 无 TARGET_DB——若对称校验被删，执行落到非法密钥 FATAL 安全退出（不开库），本条因文案不符判红');

    // I9b（2026-09-02 S2f·codex 496 H 采纳 → 496-R 同款安全失败形态）：env 置空串 + --allow-db-override → 同样
    //   命中对称拒绝精确文案（空串与"未设置"同等对待，不是"非空即算设置"）；同样注入非法短密钥作安全网。
    const r9b = runScript([FULL_LIST, '--allow-db-override'], { SYS_SINGLE_COMMIT_GROUP_DB_PATH: '', DB_ENCRYPTION_KEY: 'short-invalid-key' });
    assert.strictEqual(r9b.status, 1, `I9b：env 空串 + --allow-db-override 应 exit 1，实际 ${r9b.status}\nstdout=${r9b.stdout}\nstderr=${r9b.stderr}`);
    const r9bOut = (r9b.stdout || '') + (r9b.stderr || '');
    assert.ok(r9bOut.includes(REJECT_PAIR_TEXT), `I9b：输出应含对称拒绝精确文案，实际：${r9bOut}`);
    assert.ok(!/^TARGET_DB=/m.test(r9bOut), `I9b：拒绝路径不应打印独立行 TARGET_DB=<路径>，实际：${r9bOut}`);
    ok('I9b：env 空串 + --allow-db-override → exit 1 + 对称拒绝精确文案——若空串被误判为"已设置"，执行落到非法密钥 FATAL（安全退出不开库），本条因文案不符判红');

    // I10（2026-09-02 S2f·codex 496 M1 采纳）：DB_ENCRYPTION_KEY 含中文字符、UTF-16 长度恰 40（已用
    // Buffer.byteLength 实测=54 字节，两个口径均"看起来够长"，专门测的是 ASCII 口径本身）→ status 1
    //   且输出含「ASCII」，且不触达 db（临时文件不存在）——既有 .length<32 分支测不到这类"字符数达标但
    //   非 ASCII"的密钥。
    const CJK_KEY_40 = 'abcdefghijklmnopqrstuvwxyz中文字符占位符ABCDEFG';   // .length===40（UTF-16 单元）
    const r10 = runScript([FULL_LIST, '--allow-db-override', '--check-only'], { DB_ENCRYPTION_KEY: CJK_KEY_40 });
    assert.strictEqual(r10.status, 1, `I10：含中文的密钥应 exit 1，实际 ${r10.status}\nstdout=${r10.stdout}\nstderr=${r10.stderr}`);
    assert.ok((r10.stderr || '').includes('ASCII'), `I10：输出应含「ASCII」，实际：${r10.stderr}`);
    assert.ok(!fs.existsSync(r10.dbPath), 'I10：拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I10：DB_ENCRYPTION_KEY 含中文字符（UTF-16 长度达标）→ exit 1 + 输出含 ASCII 提示 + 未创建 db 文件——若 ASCII 正则被删，本条会红（既有 .length<32 分支对这类密钥恒放行，测不出来）');

    // I10b（2026-09-02 S2f·codex 496 M1 采纳）：31 个 ASCII 字符（既有长度分支仍在，未被新增校验顶替）
    //   → status 1，走的应是原有「未设置或长度不足 32 字节」FATAL，不是新增的 ASCII 提示。
    const KEY_31_ASCII = 'x'.repeat(31);
    const r10b = runScript([FULL_LIST, '--allow-db-override', '--check-only'], { DB_ENCRYPTION_KEY: KEY_31_ASCII });
    assert.strictEqual(r10b.status, 1, `I10b：31 个 ASCII 字符应 exit 1，实际 ${r10b.status}\nstdout=${r10b.stdout}\nstderr=${r10b.stderr}`);
    assert.ok((r10b.stderr || '').includes('长度不足'), `I10b：应命中既有长度分支（含"长度不足"），实际：${r10b.stderr}`);
    assert.ok(!fs.existsSync(r10b.dbPath), 'I10b：拒绝路径不得触达 db（临时文件应始终不存在）');
    ok('I10b：31 个纯 ASCII 字符密钥仍 exit 1（既有长度分支未被新增 ASCII 校验顶替/绕过）——若既有分支被误删只剩新校验，本条会红（错误文案会变成 ASCII 提示而非长度不足）');
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
