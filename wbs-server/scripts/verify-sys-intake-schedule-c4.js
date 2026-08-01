// 验证脚本：系统迭代 受理排期改造 C4 — 待修改编辑（edit_in_revision）+ 切换受理模式（change_intake_mode·§5.4 真值表）
//   用法：node scripts/verify-sys-intake-schedule-c4.js
//
// 覆盖（真实 HTTP）：
//   [E] edit_in_revision（旁路·待修改态·created_by∨admin·白名单字段）：
//       建单人/admin 改字段 200+timeline(note/edit_in_revision/payload_json) / 受理人他人单 403 / 非建单人非 admin 403 /
//       非待修改态 409 EDIT_STATUS_INVALID / 未知字段 400 EDIT_FIELD_NOT_ALLOWED / 幂等同值 200 unchanged /
//       字段校验(优先级/系统/deadline/needs_feasibility bug 拒) / 多字段改动集
//   [M-disabled] change_intake_mode 阶段1 下线（角色权限重构 C0·原 M-feat/M-bug/M-perm/M-tl/M-rollback 五组随功能移除）：
//       一律 409 INTAKE_MODE_SWITCH_DISABLED / 拒绝早于参数校验与查库（缺 reason·target 非法·不存在 id 均 409）/
//       requireAdmin 仍在拒绝之前（非 admin 403）/ 零副作用（status·intake_required·timeline 均不变）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-c4-secret';
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
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function createIssue(type) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: `${type}单`, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
// 播种状态 + intake_required + created_by（建单端点无法直接产受理态）
async function seed(id, { status, intake_required, created_by } = {}) {
  const sets = [], params = [];
  if (status !== undefined) { sets.push('status = ?'); params.push(status); }
  if (intake_required !== undefined) { sets.push('intake_required = ?'); params.push(intake_required); }
  if (created_by !== undefined) { sets.push('created_by = ?'); params.push(created_by); }
  if (sets.length) await run(`UPDATE sys_issues SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}
async function mkRevision(type, createdBy) {   // 待修改 + intake_required=1
  const id = await createIssue(type);
  await seed(id, { status: '待修改', intake_required: 1, created_by: createdBy });
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [E] edit_in_revision（待修改态编辑·created_by∨admin·白名单）═══
  {
    // 建单人(dev5) 改标题 → 200 + timeline
    let id = await mkRevision('feature', 5);
    let r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { title: '改后的标题' });
    assert.strictEqual(r.status, 200, `建单人 edit 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(r.body.changed, ['title'], 'changed=[title]');
    let row = await get('SELECT title, status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.title, '改后的标题', 'title 已更新');
    assert.strictEqual(row.status, '待修改', 'edit_in_revision 不改 status（旁路）');
    const tl = await get(`SELECT event_type, action_code, summary, operator_id FROM sys_issue_timeline WHERE issue_id=? AND action_code='edit_in_revision' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl, 'edit 写 timeline');
    assert.strictEqual(tl.event_type, 'note', 'event_type=note');
    assert.ok(tl.summary.includes('标题'), 'summary 含改动字段名（标题）');
    assert.strictEqual(Number(tl.operator_id), 5, 'operator=建单人5');

    // admin 改多字段 → 200 changed 含多项
    id = await mkRevision('feature', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, adminTok, { priority: 'P1', description: '新描述', deadline: '2026-09-01' });
    assert.strictEqual(r.status, 200, 'admin 多字段 edit 200');
    assert.strictEqual(r.body.changed.length, 3, 'changed 3 字段');

    // 受理人(13) 编辑他人单 → 403（created_by∨admin·受理人不获）
    id = await mkRevision('feature', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, liaisonTok, { title: 'x' });
    assert.strictEqual(r.status, 403, '受理人 edit 他人单 403');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_EDIT', '403 code=NOT_AUTHORIZED_FOR_EDIT');

    // 非建单人非 admin(dev6) → 403
    id = await mkRevision('feature', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, dev2Tok, { title: 'x' });
    assert.strictEqual(r.status, 403, '非建单人非 admin edit 403');

    // ⭐ 建单优化批 C3（方案 20260731_v1.2 §6 A 档）：待受理态编辑窗口已从「仅待修改」拓宽为 A 档
    //   （待受理/待修改/待指派/待处理），本断言由旧约束「非待修改态 409」改为「待受理态(A档) 200」——
    //   两档矩阵/待验证起终态族 409/并发终闸 的完整覆盖见 verify-sys-edit-window.js，本脚本不重复展开。
    id = await createIssue('feature');
    await seed(id, { status: '待受理', intake_required: 1, created_by: 5 });
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { title: 'x' });
    assert.strictEqual(r.status, 200, '待受理态(A档) edit 200');
    assert.deepStrictEqual(r.body.changed, ['title'], 'changed=[title]');

    // 未知字段(status) → 400 EDIT_FIELD_NOT_ALLOWED（禁写服务端字段）
    id = await mkRevision('feature', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { status: '开发中' });
    assert.strictEqual(r.status, 400, '未知字段 400');
    assert.strictEqual(r.body.code, 'EDIT_FIELD_NOT_ALLOWED', '400 code=EDIT_FIELD_NOT_ALLOWED');
    // intake_required 也禁写
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { intake_required: 0 });
    assert.strictEqual(r.body.code, 'EDIT_FIELD_NOT_ALLOWED', 'intake_required 禁写');

    // 幂等同值 → 200 unchanged
    id = await mkRevision('feature', 5);
    const cur = await get('SELECT title FROM sys_issues WHERE id=?', [id]);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { title: cur.title });
    assert.strictEqual(r.status, 200, '幂等同值 200');
    assert.strictEqual(r.body.unchanged, true, '同值 unchanged:true（零写入）');

    // 字段校验：非法优先级/系统/deadline
    id = await mkRevision('feature', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { priority: 'P9' });
    assert.strictEqual(r.body.code, 'INVALID_PRIORITY', '非法优先级 400');
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { system_name: '不存在系统' });
    assert.strictEqual(r.body.code, 'INVALID_SYSTEM_NAME', '非法系统 400');
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { deadline: '2026-02-30' });
    assert.strictEqual(r.body.code, 'INVALID_DEADLINE', '非法 deadline 400');
    // bug 单改 needs_feasibility=1 → 400（type guard）
    id = await mkRevision('bug', 5);
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { needs_feasibility: 1 });
    assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE', 'bug needs_feasibility=1 拒 400');
    ok('[E] edit_in_revision：建单人/admin 200+timeline(note/summary改动字段) + 受理人他人单/非建单人 403 + 非待修改 409 + 未知字段 400 + 幂等 unchanged + 字段校验');
  }

  // ═══ [E2] edit_in_revision 自由文本类型安全 + 幂等严格比较（codex MED-2/MED-3）═══
  {
    // MED-2：非字符串非 null（数字/对象/数组）→ 400 INVALID_EDIT_FIELD_TYPE·不静默清空（数据不丢）
    let id = await mkRevision('feature', 5);
    await seed(id);   // no-op（保持）
    await run(`UPDATE sys_issues SET description='原描述' WHERE id=?`, [id]);
    let r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { description: 123 });
    assert.strictEqual(r.status, 400, '数字 description 400');
    assert.strictEqual(r.body.code, 'INVALID_EDIT_FIELD_TYPE', '400 code=INVALID_EDIT_FIELD_TYPE');
    let row = await get('SELECT description FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.description, '原描述', '类型错误未静默清空（数据不丢·MED-2）');
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { requester_name: { a: 1 } });
    assert.strictEqual(r.body.code, 'INVALID_EDIT_FIELD_TYPE', '对象 requester_name 400');

    // 显式 null 清空 → 200（合法·区别于类型错误）
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { description: null });
    assert.strictEqual(r.status, 200, '显式 null 清空 200');
    row = await get('SELECT description FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.description, null, 'null → 清空（合法）');

    // MED-3：DB null vs 文本 "null" 不被误判 unchanged（可保存合法文本 "null"）
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { description: 'null' });
    assert.strictEqual(r.status, 200, '文本 "null" 200');
    assert.deepStrictEqual(r.body.changed, ['description'], 'DB null → 文本"null" 判为改动（非误判 unchanged·MED-3）');
    row = await get('SELECT description FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.description, 'null', '文本 "null" 已保存');
    ok('[E2] 自由文本类型安全(非string非null→400不清空·MED-2) + 幂等严格比较(null vs 文本"null" 不误判·MED-3)');
  }

  // ═══ [M-disabled] change_intake_mode 已下线（角色权限重构 C0 阶段1·方案 v1.5 §4-C0/§14）═══
  //   原 [M-feat]/[M-bug]/[M-perm]/[M-tl]/[M-rollback] 五组真值表用例随功能下线整体移除——受理门焊死为
  //   「全类型必经」（intake_required 恒 1·三创建入口同源）后，「切换受理模式」在新模型下语义消失，
  //   真值表不再有被测对象（保留会变成"测一条已不存在的业务规则"）。本组改测**下线契约本身**。
  //   ⚠️ 阶段2（同发布批次·§14）移除前后端入口与路由时，本组一并删除。
  {
    const id = await createIssue('feature');
    // ① 原 200 场景（开受理门）→ 409 SWITCH_DISABLED
    let r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: '需外包受理' });
    assert.strictEqual(r.status, 409, `下线后一律 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_MODE_SWITCH_DISABLED', '409 code=INTAKE_MODE_SWITCH_DISABLED');

    // ② 拒绝早于参数校验：缺 reason / target 非 0/1 → 仍 409（不是原来的 400）
    //    下线是端点级结论·与入参合法性无关；若先校验会误导调用方「参数写对就能用」。
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1 });
    assert.strictEqual(r.body.code, 'INTAKE_MODE_SWITCH_DISABLED', '缺 reason 也 409 SWITCH_DISABLED（非 CHANGE_INTAKE_MODE_REASON_REQUIRED）');
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 2, reason: 'x' });
    assert.strictEqual(r.body.code, 'INTAKE_MODE_SWITCH_DISABLED', 'target 非 0/1 也 409 SWITCH_DISABLED（非 INVALID_TARGET_INTAKE_MODE）');

    // ③ 权限门仍在拒绝之前：非 admin → 403（下线不放宽鉴权·也不向无权者暴露"端点已下线"这一信息）
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, liaisonTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 403, '受理人仍 403（requireAdmin 在下线拒绝之前）');
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, devTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 403, 'dev 仍 403');

    // ④ 拒绝早于查库：不存在的 id 同样 409（非 404·不泄露单据存在性）
    r = await call('POST', '/api/sys-issues/999999/change-intake-mode', adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 409, '不存在的单 409（非 404·拒绝早于查库）');
    assert.strictEqual(r.body.code, 'INTAKE_MODE_SWITCH_DISABLED', '不存在的单 code 同样 SWITCH_DISABLED');

    // ⑤ 零副作用：被拒后 status / intake_required / timeline 全不变
    const before = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id]);
    const tlBefore = await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]);
    await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    const after = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id]);
    const tlAfter = await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]);
    assert.strictEqual(after.status, before.status, '拒绝后 status 不变');
    assert.strictEqual(after.intake_required, before.intake_required, '拒绝后 intake_required 不变');
    assert.strictEqual(tlAfter.c, tlBefore.c, '拒绝后无新增 timeline（零副作用）');
    ok('[M-disabled] change_intake_mode 阶段1 下线：一律 409 SWITCH_DISABLED + 拒绝早于参数校验与查库（缺reason/非法target/不存在id 均409）+ requireAdmin 仍在前（非admin 403）+ 零副作用');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c4 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
