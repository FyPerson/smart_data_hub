// 验证脚本：系统迭代 受理排期改造 C4 — 待修改编辑（edit_in_revision）+ 切换受理模式（change_intake_mode·§5.4 真值表）
//   用法：node scripts/verify-sys-intake-schedule-c4.js
//
// 覆盖（真实 HTTP）：
//   [E] edit_in_revision（旁路·待修改态·created_by∨admin·白名单字段）：
//       建单人/admin 改字段 200+timeline(note/edit_in_revision/payload_json) / 受理人他人单 403 / 非建单人非 admin 403 /
//       非待修改态 409 EDIT_STATUS_INVALID / 未知字段 400 EDIT_FIELD_NOT_ALLOWED / 幂等同值 200 unchanged /
//       字段校验(优先级/系统/deadline/needs_feasibility bug 拒) / 多字段改动集
//   [M-feat] change_intake_mode 变更流真值表（admin·reason 必填）：
//       待指派+ir0→开1→待受理 / 待受理+ir1→关0→待指派 / 待修改+ir1→关0→待指派 /
//       待指派+ir1→关0→409 LOCKED / 幂等同值 200 unchanged / 开发中→409 LATE
//   [M-bug] change_intake_mode bug 真值表：待处理+ir0→开→待受理 / 待受理+ir1→关→待处理
//   [M-perm] 非 admin(受理人/dev)→403 / reason 缺→400 / target 非 0/1→400 / 脏数据 curIr null→409
//   [M-tl] timeline status_change/change_intake_mode/summary 含 reason + 原子(status+intake_required 同事务)
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
  const r = await call('POST', '/api/sys-issues', adminTok, { type, title: `${type}单`, system_name: 'BMS', source: '内部' });
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
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
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

    // 非待修改态(待受理) → 409 EDIT_STATUS_INVALID
    id = await createIssue('feature');
    await seed(id, { status: '待受理', intake_required: 1, created_by: 5 });
    r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, devTok, { title: 'x' });
    assert.strictEqual(r.status, 409, '待受理态 edit 409');
    assert.strictEqual(r.body.code, 'EDIT_STATUS_INVALID', '409 code=EDIT_STATUS_INVALID');

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

  // ═══ [M-feat] change_intake_mode 变更流真值表（admin·reason 必填）═══
  {
    // 待指派+ir0 → 开1 → 待受理
    let id = await createIssue('feature');   // 天然 待指派+ir0
    let r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: '需外包受理' });
    assert.strictEqual(r.status, 200, `待指派→开受理 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待受理', '开受理门 → 待受理');
    assert.strictEqual(r.body.intake_required, 1, 'intake_required=1');

    // 待受理+ir1 → 关0 → 待指派
    id = await createIssue('feature'); await seed(id, { status: '待受理', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: '撤受理' });
    assert.strictEqual(r.status, 200, '待受理→关受理 200');
    assert.strictEqual(r.body.status, '待指派', '关受理门 → 待指派');
    assert.strictEqual(r.body.intake_required, 0, 'intake_required=0');

    // 待修改+ir1 → 关0 → 待指派
    id = await createIssue('feature'); await seed(id, { status: '待修改', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: '撤受理' });
    assert.strictEqual(r.body.status, '待指派', '待修改关受理门 → 待指派');

    // 待指派+ir1（已过受理门）→ 关0 → 409 LOCKED
    id = await createIssue('feature'); await seed(id, { status: '待指派', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    assert.strictEqual(r.status, 409, '待指派+ir1 关受理 409');
    assert.strictEqual(r.body.code, 'INTAKE_MODE_LOCKED', '409 code=INTAKE_MODE_LOCKED（已过受理门）');

    // 幂等：待受理+ir1 → 开1（同值）→ 200 unchanged
    id = await createIssue('feature'); await seed(id, { status: '待受理', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 200, '同值 200');
    assert.strictEqual(r.body.unchanged, true, '同值 unchanged:true（前段态零写入）');

    // 开发中 → 409 LATE（无论 target）
    id = await createIssue('feature'); await seed(id, { status: '开发中', intake_required: 0 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 409, '开发中 change_intake_mode 409');
    assert.strictEqual(r.body.code, 'INTAKE_MODE_LATE', '409 code=INTAKE_MODE_LATE（已过受理阶段）');

    // LATE 优先于幂等（codex MED-5）：开发中+ir1·target=1（同值）仍 → 409 LATE（非 unchanged）
    id = await createIssue('feature'); await seed(id, { status: '开发中', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.body.code, 'INTAKE_MODE_LATE', '开发中同值也 409 LATE（LATE 优先于幂等·§5.4）');

    // INTAKE_MODE_INVALID（codex MED-5）：待受理+ir0（脏数据）·target=1 → 409 INVALID（受理态不可再开·非 noIntakeLanding）
    id = await createIssue('feature'); await seed(id, { status: '待受理', intake_required: 0 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.body.code, 'INTAKE_MODE_INVALID', '待受理+ir0 开受理 → 409 INTAKE_MODE_INVALID');

    // improvement 类型（codex MED-5）：待指派+ir0 → 开1 → 待受理（与 feature 同落态）
    id = await createIssue('improvement');
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.body.status, '待受理', 'improvement 待指派→开→待受理（同 feature 落态）');
    ok('[M-feat] 变更流真值表：待指派→开→待受理 / 待受理·待修改→关→待指派 / 待指派+ir1→409 LOCKED / 同值 unchanged / 开发中→409 LATE(同值也LATE) / 待受理+ir0→409 INVALID / improvement 同落态');
  }

  // ═══ [M-bug] change_intake_mode bug 真值表（无受理落态=待处理）═══
  {
    // 待处理+ir0 → 开1 → 待受理
    let id = await createIssue('bug');   // 天然 待处理+ir0
    let r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: 'bug 需受理' });
    assert.strictEqual(r.status, 200, 'bug 待处理→开 200');
    assert.strictEqual(r.body.status, '待受理', 'bug 开受理门 → 待受理');

    // 待受理+ir1 → 关0 → 待处理（bug 无受理落态）
    id = await createIssue('bug'); await seed(id, { status: '待受理', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: '撤' });
    assert.strictEqual(r.body.status, '待处理', 'bug 关受理门 → 待处理（非待指派）');

    // 待处理+ir1（已过受理门）→ 关0 → 409 LOCKED
    id = await createIssue('bug'); await seed(id, { status: '待处理', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    assert.strictEqual(r.body.code, 'INTAKE_MODE_LOCKED', 'bug 待处理+ir1 关受理 409 LOCKED');

    // bug 待修改+ir1 → 关0 → 待处理（codex MED-5·bug 待修改关闭落无受理态=待处理）
    id = await createIssue('bug'); await seed(id, { status: '待修改', intake_required: 1 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    assert.strictEqual(r.body.status, '待处理', 'bug 待修改关受理门 → 待处理');
    ok('[M-bug] bug 真值表：待处理→开→待受理 / 待受理·待修改→关→待处理(非待指派) / 待处理+ir1→409 LOCKED');
  }

  // ═══ [M-perm/校验] 权限 + reason + target + 脏数据 ═══
  {
    // 非 admin(受理人13) → 403（requireAdmin 中间件）
    let id = await createIssue('feature');
    let r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, liaisonTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 403, '受理人 change_intake_mode 403（仅 admin）');
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, devTok, { intake_required: 1, reason: 'x' });
    assert.strictEqual(r.status, 403, 'dev change_intake_mode 403');

    // reason 缺 → 400
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1 });
    assert.strictEqual(r.body.code, 'CHANGE_INTAKE_MODE_REASON_REQUIRED', 'reason 缺 400');
    // target 非 0/1 → 400
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 2, reason: 'x' });
    assert.strictEqual(r.body.code, 'INVALID_TARGET_INTAKE_MODE', 'target 非 0/1 400');

    // 脏数据 curIr=2（非 0/1·列无 CHECK 可写）→ 409 INTAKE_REQUIRED_INVARIANT
    id = await createIssue('feature'); await seed(id, { status: '待受理', intake_required: 2 });
    r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    assert.strictEqual(r.body.code, 'INTAKE_REQUIRED_INVARIANT', '脏数据 curIr=2 → 409 INTAKE_REQUIRED_INVARIANT');
    ok('[M-perm] 非 admin 403 + reason 缺 400 + target 非0/1 400 + 脏数据 curIr 非0/1 → 409 INVARIANT');
  }

  // ═══ [M-tl] timeline 落痕 + 原子性 ═══
  {
    const id = await createIssue('feature');   // 待指派+ir0
    const r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: '外包项目需受理确认' });
    assert.strictEqual(r.status, 200, '开受理 200');
    const tl = await get(`SELECT event_type, action_code, from_status, to_status, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='change_intake_mode' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl, 'change_intake_mode 写 timeline');
    assert.strictEqual(tl.event_type, 'status_change', 'event_type=status_change');
    assert.strictEqual(tl.from_status, '待指派', 'from=待指派');
    assert.strictEqual(tl.to_status, '待受理', 'to=待受理');
    assert.ok(tl.summary.includes('外包项目需受理确认'), 'summary 含 reason');
    // 原子性：status + intake_required 同事务生效
    const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待受理', 'status 落 待受理');
    assert.strictEqual(row.intake_required, 1, 'intake_required 落 1（同事务原子）');
    ok('[M-tl] change_intake_mode timeline(status_change/change_intake_mode/summary含reason) + status+intake_required 原子同事务');
  }

  // ═══ [M-rollback] 原子回滚证明（codex MED-5）：timeline INSERT 失败 → 主表 status/intake_required 整体回滚 ═══
  {
    // 临时触发器：change_intake_mode 的 timeline INSERT 触发 RAISE(ABORT)（模拟落库失败）
    await run(`CREATE TRIGGER IF NOT EXISTS _fail_cim_tl BEFORE INSERT ON sys_issue_timeline
               WHEN NEW.action_code='change_intake_mode' BEGIN SELECT RAISE(ABORT,'boom-timeline'); END`);
    const id = await createIssue('feature');   // 待指派+ir0
    const before = await get('SELECT status, intake_required, updated_at FROM sys_issues WHERE id=?', [id]);
    const r = await call('POST', `/api/sys-issues/${id}/change-intake-mode`, adminTok, { intake_required: 1, reason: '触发回滚' });
    assert.strictEqual(r.status, 500, 'timeline 失败 → 500');
    assert.strictEqual(r.body.code, 'INTERNAL_ERROR', 'MED-4：500 返通用码不泄露 SQLite 细节');
    assert.ok(!/boom-timeline|RAISE|SQLITE/i.test(JSON.stringify(r.body)), 'MED-4：响应不含 SQLite/触发器内部信息');
    const after = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(after.status, before.status, 'timeline 失败 → status 回滚（未变 待指派）');
    assert.strictEqual(after.intake_required, before.intake_required, 'timeline 失败 → intake_required 回滚（未变 0·原子）');
    const tlCnt = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='change_intake_mode'`, [id]);
    assert.strictEqual(tlCnt.c, 0, 'timeline 失败 → 无残留 change_intake_mode 事件');
    await run(`DROP TRIGGER IF EXISTS _fail_cim_tl`);
    // 无副作用回归（错误路径·LOCKED）：待指派+ir1 关受理 409 后 status/intake_required/timeline 全不变
    const id2 = await createIssue('feature'); await seed(id2, { status: '待指派', intake_required: 1 });
    const b2 = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id2]);
    const c2before = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id2]);
    const rr = await call('POST', `/api/sys-issues/${id2}/change-intake-mode`, adminTok, { intake_required: 0, reason: 'x' });
    assert.strictEqual(rr.body.code, 'INTAKE_MODE_LOCKED', 'LOCKED 409');
    const a2 = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id2]);
    assert.strictEqual(a2.status, b2.status, '409 后 status 不变');
    assert.strictEqual(a2.intake_required, b2.intake_required, '409 后 intake_required 不变');
    const c2after = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id2]);
    assert.strictEqual(c2after.c, c2before.c, '409 后无新增 timeline（无副作用）');
    ok('[M-rollback] timeline INSERT 失败 → status+intake_required 原子回滚+无残留事件+500通用码不泄露 / LOCKED 409 后无副作用');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c4 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
