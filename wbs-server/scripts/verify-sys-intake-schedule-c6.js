// 验证脚本：系统迭代 受理排期改造 C6 — 排期 scheduled_start（set_scheduled_start + return/reopen 清除）
//   用法：node scripts/verify-sys-intake-schedule-c6.js
//
// 覆盖（真实 HTTP）：
//   [SS] set_scheduled_start（admin·dev 工作态·须 estimate·YYYY-MM-DD 严格）：
//        admin 开发中(feature)/处理中(bug) 设值 200 + timeline(note/set_scheduled_start) / 非 admin 403 /
//        非 dev 态(待指派/待受理) 409 STATUS_INVALID / 无 estimate 设值 409 REQUIRES_ESTIMATE / 清除(null) 200(无需 estimate) /
//        非法格式(日期时间/2026-02-30) 400 / 幂等同值 200 unchanged
//   [CLR] return/reopen 清除 scheduled_start（§7.2·补声明未实现缺口）：
//        待验证+roster+scheduled_start → return → 开发中 + scheduled_start NULL /
//        已关闭+roster+scheduled_start → reopen → scheduled_start NULL
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-c6-secret';
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
// codex 221a HIGH 收口（验证层残余日期字面量·P4 教训漏网）：硬编码 '2026-08-01 10:00' 已随日历滚到
// 当天到期——本文件里仅被 seedDevWork 用于 raw SQL 直写 dev_estimated_at（不经 /estimate 端点闸门，
// 当前潜伏未触发 ESTIMATE_BEFORE_ASSIGN），但远期字面量迟早到期，同 P4 范式统一改动态生成，不留隐患。
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

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
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status}`);
  return r.body.id;
}
// 造 dev 工作态（开发中/处理中）+ dev_estimated_at + roster（复刻 verify-sys-transition fastForward 范式）
async function seedDevWork(type, { estimate = EST, scheduled_start = null } = {}) {
  const id = await createIssue(type);
  const devStatus = (type === 'bug') ? '处理中' : '开发中';
  await run(`UPDATE sys_issues SET status=?, dev_estimated_at=?, scheduled_start=?, assigned_to=5, assigned_to_name='开发王', assigned_at=datetime('now','localtime') WHERE id=?`,
    [devStatus, estimate, scheduled_start, id]);
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, 5, '开发王', 1, 'no_code')`, [id]);
  return id;
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
  ok('readiness ready + HTTP harness');

  // ═══ [SS] set_scheduled_start ═══
  {
    // admin 开发中(feature)+estimate → 200 + timeline
    let id = await seedDevWork('feature');
    let r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-01' });
    assert.strictEqual(r.status, 200, `admin set-scheduled-start 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.scheduled_start, '2026-09-01', 'scheduled_start=2026-09-01');
    let row = await get('SELECT status, scheduled_start FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '开发中', 'set_scheduled_start 不改 status（旁路）');
    assert.strictEqual(row.scheduled_start, '2026-09-01', 'scheduled_start 落库');
    const tl = await get(`SELECT event_type, action_code, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_scheduled_start' ORDER BY id DESC LIMIT 1`, [id]);
    assert.strictEqual(tl.event_type, 'note', 'timeline event_type=note');
    assert.ok(tl.summary.includes('2026-09-01'), 'summary 含开工日');

    // bug 处理中 → 200
    id = await seedDevWork('bug');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-02' });
    assert.strictEqual(r.status, 200, 'bug 处理中 set-scheduled-start 200');
    // improvement 开发中 → 200（MED-4：三类全覆盖·同 feature 落 dev 态）
    id = await seedDevWork('improvement');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-03' });
    assert.strictEqual(r.status, 200, 'improvement 开发中 set-scheduled-start 200');

    // 非 admin → 403
    id = await seedDevWork('feature');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, devTok, { scheduled_start: '2026-09-01' });
    assert.strictEqual(r.status, 403, '非 admin 403');

    // 非 dev 态（待指派）→ 409 STATUS_INVALID（LOW-5：断 status+code）
    id = await createIssue('feature');   // 待指派
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-01' });
    assert.strictEqual(r.status, 409, '非 dev 态 409 状态');
    assert.strictEqual(r.body.code, 'SCHEDULED_START_STATUS_INVALID', '非 dev 态 code');

    // 无 estimate 设值 → 409 REQUIRES_ESTIMATE
    id = await seedDevWork('feature', { estimate: null });
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-01' });
    assert.strictEqual(r.status, 409, '无 estimate 设值 409 状态');
    assert.strictEqual(r.body.code, 'SCHEDULED_START_REQUIRES_ESTIMATE', '无 estimate code');

    // codex HIGH-3：真实非空→null 清除（无 estimate 亦可清）：造 scheduled_start 非空+estimate 空 → 显式 null 清除 → 落库 null+timeline
    id = await seedDevWork('feature', { estimate: null, scheduled_start: '2026-09-20' });
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: null });
    assert.strictEqual(r.status, 200, '真实非空→null 清除 200');
    assert.strictEqual(r.body.scheduled_start, null, '清除 → null');
    assert.ok(!('unchanged' in r.body), '真实清除非 unchanged（有写入·action 分支）');
    assert.strictEqual(r.body.action, 'set_scheduled_start', 'action=set_scheduled_start');
    let clrRow = await get('SELECT scheduled_start FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(clrRow.scheduled_start, null, '库中 scheduled_start 已清 null');
    const clrTl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_scheduled_start' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(clrTl.summary.includes('清除'), 'timeline summary=清除计划开工日');

    // codex HIGH-1/MED-2：字段缺失 → 400 REQUIRED / 非 string 非 null → 400 INVALID
    id = await seedDevWork('feature', { scheduled_start: '2026-09-15' });
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, {});
    assert.strictEqual(r.status, 400, '缺字段 400 状态');
    assert.strictEqual(r.body.code, 'SCHEDULED_START_REQUIRED', '缺字段 code=SCHEDULED_START_REQUIRED（不静默清除）');
    let keepRow = await get('SELECT scheduled_start FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(keepRow.scheduled_start, '2026-09-15', '缺字段未清除已有开工日（HIGH-1 防静默清除）');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: ['2026-09-01'] });
    assert.strictEqual(r.status, 400, '数组 400 状态');
    assert.strictEqual(r.body.code, 'INVALID_SCHEDULED_START', '数组 code（MED-2·非 string 非 null）');

    // 非法格式：日期时间 / 溢出日期 → 400（LOW-5 断 status+code）
    id = await seedDevWork('feature');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-01 10:00' });
    assert.strictEqual(r.status, 400, '日期时间 400 状态');
    assert.strictEqual(r.body.code, 'INVALID_SCHEDULED_START', '日期时间 code');
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-02-30' });
    assert.strictEqual(r.body.code, 'INVALID_SCHEDULED_START', '溢出日期(2026-02-30) 400');

    // 幂等同值 → 200 unchanged
    id = await seedDevWork('feature', { scheduled_start: '2026-09-05' });
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-05' });
    assert.strictEqual(r.status, 200, '幂等 200');
    assert.strictEqual(r.body.unchanged, true, '同值 unchanged:true');
    // null==null 幂等（本来就 null·显式传 null）
    id = await seedDevWork('feature');   // scheduled_start 默认 null
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: null });
    assert.strictEqual(r.body.unchanged, true, 'null==null 幂等 unchanged');
    ok('[SS] set_scheduled_start：admin feature/improvement/bug 200+timeline / 非 admin 403 / 非 dev 态 409 / 无 estimate 409 / 真实非空→null清除 200+timeline / 缺字段 400 不清除(HIGH-1) / 非string 400(MED-2) / 非法格式 400 / 幂等(值/null) unchanged');
  }

  // ═══ [CLR] return/reopen 清除 scheduled_start（§7.2·补声明未实现缺口）═══
  {
    // return：待验证+roster+scheduled_start → 开发中 + scheduled_start NULL
    let id = await seedDevWork('feature', { scheduled_start: '2026-09-10' });
    // 快进到待验证（roster 已 no_code·非 pending）
    await run(`UPDATE sys_issues SET status='待验证', first_submitted_at=datetime('now','localtime') WHERE id=?`, [id]);
    let r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '需返工' });
    assert.strictEqual(r.status, 200, `return 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '开发中', 'return → 开发中');
    let row = await get('SELECT scheduled_start, dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.scheduled_start, null, 'return 清除 scheduled_start（§7.2·补缺口）');
    assert.strictEqual(row.dev_estimated_at, null, 'return 同时清 dev_estimated_at（既有）');

    // reopen：已关闭+roster+scheduled_start → scheduled_start NULL
    id = await seedDevWork('feature', { scheduled_start: '2026-09-11' });
    await run(`UPDATE sys_issues SET status='已关闭', first_submitted_at=datetime('now','localtime'), closed_at=datetime('now','localtime') WHERE id=?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '重开' });
    assert.strictEqual(r.status, 200, `reopen 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT scheduled_start FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.scheduled_start, null, 'reopen 清除 scheduled_start（§7.2·补缺口）');

    // bug return 清除（MED-4·两族都清·bug 无受理落态但 dev 工作态=处理中·return: 待验证→处理中）
    id = await seedDevWork('bug', { scheduled_start: '2026-09-12' });
    await run(`UPDATE sys_issues SET status='待验证', first_submitted_at=datetime('now','localtime') WHERE id=?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: 'bug 返工' });
    assert.strictEqual(r.status, 200, `bug return 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', 'bug return → 处理中');
    row = await get('SELECT scheduled_start FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.scheduled_start, null, 'bug return 清除 scheduled_start（两族都清）');
    ok('[CLR] return/reopen 清除 scheduled_start：feature return→开发中+清 / feature 已关闭 reopen→清 / bug return→处理中+清（§7.2 声明未实现缺口·两族全覆盖）');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c6 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
