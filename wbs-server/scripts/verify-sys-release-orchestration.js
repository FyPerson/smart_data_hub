// 验证脚本：系统迭代 旧上线编排家族封禁契约
//   用法：node scripts/verify-sys-release-orchestration.js
//
// 历史：本文件原为通知改造 v1.6 §2.3（C3b G3-G6）的"上线编排"行为测试——覆盖 assign-release-dev
//   （批量指定上线开发）/ reassign-release-dev（批量换人）两个端点的成功路径 + 各类拒绝 + 权限矩阵，
//   以及 execute-release（G5/G6，C3 上线体统一重构时已退场为 409）。
//
// ⚠️ 2026-07-30 用户裁定：上线体统一重构收尾，「旧上线编排家族」4 个端点全部封禁退场——
//     POST /api/sys-issues/assign-release-dev
//     POST /api/sys-issues/reassign-release-dev
//     POST /api/sys-issues/:id/notify-release-executor
//     POST /api/sys-issues/notify-release-executor-batch
//   中间件收敛为 authenticateToken + requireSysSchemaReady（requireAdmin 已摘除），任何已登录角色
//   （admin/受理人/技术负责人/普通 dev）一律 409 { code: 'LEGACY_RELEASE_FLOW_DISABLED' }，且该判定
//   置于一切参数校验之前（空 body/非法 body/合法 body 同一结果），零落库副作用。原 G3/G4 的成功路径、
//   各类业务拒绝码（RELEASE_ASSIGN_TYPE_INVALID / RELEASE_ASSIGNEE_VIEWER / RELEASE_ASSIGNEE_ALREADY_SET
//   等）连同批量原子性、timeline 记录等旧断言全部随端点封禁作废——业务逻辑已不可达，测它们只是测空气。
//   本文件转为**封禁契约锁定**（防日后被重新接活却没人发现回归）：4 端点 × 多角色 × 多种 body 形态
//   一律 409 同一个 code，且事后回读落库零副作用。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-orchestration-secret';
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人（原对接人白名单角色）
const techLeadTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);   // 技术负责人
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);               // 普通开发

// 覆盖契约里点名的四类角色：admin/对接人(受理人)/普通dev/示例发布者 —— 逐一验证「任何已登录角色一律 409」
const ROLES = [
  ['admin', adminTok],
  ['受理人(13)', liaisonTok],
  ['示例发布者(7)', techLeadTok],
  ['普通dev(5)', devTok],
];

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      ...(tok ? { 'Authorization': 'Bearer ' + tok } : {}), 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const EST = '2026-08-01 10:00';

async function issueRow(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }

// 建 bug 单 → 指派 devId → estimate → submit → accept，返回 id（待上线态）
async function seedBugToReady(devId = 5, devTokFor = devTok) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建 bug 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200');
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTokFor, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200, 'bug estimate 200, got ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTokFor, { mode: 'no_code', no_code_reason: '修复完成（占位理由）' });
  assert.strictEqual(r.status, 200, 'bug submit 200, got ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'bug accept 200, got ' + JSON.stringify(r.body));
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),(6,'dev2','开发李','user','active'),
    (7,'shenjun','示例发布者','publisher','active'),(13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ 造夹具：bug 单推到「待上线」+ SQL 直写 release_assignee_id=5（模拟历史遗留数据）═══
  //   历史遗留场景：旧编排家族封禁前，生产已有单据带着 release_assignee_id/_name，本组用它来验证
  //   封禁后这些历史数据不会被 4 个端点的任何一次调用改动分毫。
  const id = await seedBugToReady(5);
  await run(`UPDATE sys_issues SET release_assignee_id=5, release_assignee_name='开发王' WHERE id=?`, [id]);
  const beforeAll = await issueRow(id);
  assert.strictEqual(beforeAll.release_assignee_id, 5, '夹具前置：release_assignee_id=5（模拟历史遗留数据）');
  assert.strictEqual(beforeAll.release_assignee_name, '开发王', '夹具前置：release_assignee_name=开发王');
  assert.strictEqual(beforeAll.status, '待上线', '夹具前置：单据处于「待上线」');
  ok('夹具：bug 单推到「待上线」+ SQL 直写 release_assignee_id=5/release_assignee_name=开发王（模拟历史遗留数据）');

  const ENDPOINTS = [
    { name: 'assign-release-dev',            path: () => '/api/sys-issues/assign-release-dev',                  legalBody: () => ({ issue_ids: [id], release_assignee_id: 6 }) },
    { name: 'reassign-release-dev',          path: () => '/api/sys-issues/reassign-release-dev',                legalBody: () => ({ issue_ids: [id], release_assignee_id: 6 }) },
    { name: 'notify-release-executor',       path: () => `/api/sys-issues/${id}/notify-release-executor`,       legalBody: () => ({}) },
    { name: 'notify-release-executor-batch', path: () => '/api/sys-issues/notify-release-executor-batch',       legalBody: () => ({ issue_ids: [id] }) },
  ];

  // ═══ a)+b) 4 端点 × 4 角色（admin/受理人/示例发布者/普通dev）+ 合法 body → 全部 409 + code=LEGACY_RELEASE_FLOW_DISABLED ═══
  //   任何已登录角色一律 409（含 admin 本人）——证明这不是权限闸（403），而是端点级封禁（requireAdmin
  //   已从中间件链摘除，业务逻辑整体不可达）。
  for (const ep of ENDPOINTS) {
    for (const [who, tok] of ROLES) {
      const r = await call('POST', ep.path(), tok, ep.legalBody());
      assert.strictEqual(r.status, 409, `[封禁契约·合法body] ${ep.name} × ${who} 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', `[封禁契约·合法body] ${ep.name} × ${who} code 须为 LEGACY_RELEASE_FLOW_DISABLED, got ${JSON.stringify(r.body)}`);
    }
  }
  ok('[封禁契约 a+b] 4 端点 × 4 角色（admin/受理人/示例发布者/普通dev）+ 合法 body 一律 409 LEGACY_RELEASE_FLOW_DISABLED（非 403，requireAdmin 已摘）');

  // ═══ c) 4 端点空 body → 同样 409 同 code（证明封禁判定置于参数校验之前）═══
  for (const ep of ENDPOINTS) {
    const r = await call('POST', ep.path(), adminTok, {});
    assert.strictEqual(r.status, 409, `[封禁契约·空body] ${ep.name} 空 body 应 409（非参数校验 400）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', `[封禁契约·空body] ${ep.name} code 须为 LEGACY_RELEASE_FLOW_DISABLED, got ${JSON.stringify(r.body)}`);
  }
  ok('[封禁契约 c] 4 端点空 body 同样 409 同 code（封禁闸门置于参数校验之前，空/合法 body 结果一致）');

  // ═══ c2) 非法入参（旧逻辑本应 400/404/业务 409 的形态）→ 仍 409 同 code（codex 208 审 MED-2 补）═══
  //   防未来有人把部分参数校验挪回封禁闸之前——空 body 暴露不了"绕回旧校验码"的所有形态。
  const ILLEGAL = [
    ['assign-release-dev·issue_ids:[0]（旧逻辑 400 INVALID_ISSUE_ID）', () => call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [0], release_assignee_id: 6 })],
    ['assign-release-dev·缺 release_assignee_id（旧逻辑 400 RELEASE_ASSIGNEE_REQUIRED）', () => call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id] })],
    ['reassign-release-dev·issue_ids 超限 201 条（旧逻辑 400 TOO_MANY_ISSUES）', () => call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: Array.from({ length: 201 }, (_, i) => i + 1), release_assignee_id: 6 })],
    ['notify-release-executor·路径 id 非数字（旧逻辑 400 INVALID_SYS_ISSUE_ID）', () => call('POST', '/api/sys-issues/not-a-number/notify-release-executor', adminTok, {})],
    ['notify-release-executor-batch·issue_ids 非数组（旧逻辑 400 ISSUE_IDS_REQUIRED）', () => call('POST', '/api/sys-issues/notify-release-executor-batch', adminTok, { issue_ids: 'x' })],
  ];
  for (const [name, fn] of ILLEGAL) {
    const r = await fn();
    assert.strictEqual(r.status, 409, `[封禁契约·非法入参] ${name} 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', `[封禁契约·非法入参] ${name} code 应 LEGACY_RELEASE_FLOW_DISABLED, got ${JSON.stringify(r.body)}`);
  }
  ok('[封禁契约 c2] 5 组非法入参（0 id/缺参/超限数组/路径非数字/非数组）一律 409 同 code——封禁真的先于一切参数校验（codex 208 MED-2）');

  // ═══ 未带 token → 401（authenticateToken 中间件仍在，封禁只摘了 requireAdmin + 业务逻辑）═══
  for (const ep of ENDPOINTS) {
    const r = await call('POST', ep.path(), null, ep.legalBody());   // tok=null ⇒ call() 不发 Authorization header（非"空 Bearer"，codex 208 LOW-1 显式化）
    assert.strictEqual(r.status, 401, `[封禁契约·无token] ${ep.name} 未带 token 应 401, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  ok('[封禁契约·无token] 4 端点未带 Authorization header 一律 401（authenticateToken 中间件未被一并摘除）');

  // ═══ d) 零落库副作用：以上所有调用后回读夹具行，release_assignee_* 8 列全量快照 + 单据状态原样 ═══
  //   codex 208 审 MED-1：单列断言升 8 列全快照（deepStrictEqual），防"某端点 409 前误写 message_key/error/
  //   read_at/sent_by 之一"从单列断言缝里漏过去。
  const pick8 = (r) => ({
    release_assignee_id: r.release_assignee_id, release_assignee_name: r.release_assignee_name,
    release_assignee_notify_status: r.release_assignee_notify_status, release_assignee_notified_at: r.release_assignee_notified_at,
    release_assignee_notify_message_key: r.release_assignee_notify_message_key, release_assignee_notify_error: r.release_assignee_notify_error,
    release_assignee_read_at: r.release_assignee_read_at, release_assignee_notify_sent_by: r.release_assignee_notify_sent_by,
  });
  const afterAll = await issueRow(id);
  assert.strictEqual(afterAll.release_assignee_id, 5, '[封禁契约 d] 反复调用后 release_assignee_id 仍=5（未被 assign/reassign 改写）');
  assert.deepStrictEqual(pick8(afterAll), pick8(beforeAll), '[封禁契约 d] release_assignee_* 8 列全量快照前后一致（codex 208 MED-1）');
  assert.strictEqual(afterAll.status, '待上线', '[封禁契约 d] 单据状态仍「待上线」（未被误翻）');
  const tl = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code IN ('assign_release_dev','reassign_release_dev')`, [id]);
  assert.strictEqual(tl.length, 0, '[封禁契约 d] 零落库副作用还包含 timeline：未写入 assign_release_dev/reassign_release_dev 事件');
  ok('[封禁契约 d] 4 端点 × 4 角色 × 合法/空 body 全部调用完毕后回读夹具：release_assignee_id/_name/notify 状态/单据状态/timeline 一列未动（零落库副作用）');

  // ═══ e) 清理夹具 ═══
  await run('DELETE FROM sys_issue_timeline WHERE issue_id=?', [id]);
  await run('DELETE FROM sys_issues WHERE id=?', [id]);
  ok('[封禁契约 e] 清理夹具');

  console.log(`\n✅ verify-sys-release-orchestration 全部通过（${passed} 项断言）`);
  server.close();
}

main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
