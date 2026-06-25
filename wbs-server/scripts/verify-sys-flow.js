// 验证脚本：系统迭代 C3a 开发动作 + 旁路态端点全流程（方案 §3.4/§3.5/§5/§7）
//   用法：node scripts/verify-sys-flow.js
//
// in-process express app（挂真实 router）+ 内存库 + seed users + 自签 token，测端点链路：
//   1. estimate（回填预计，开发本人，>=assigned_at，旁路不改 status）
//   2. submit/accept/return/close 全流程
//   3. hold/resume（resume 从 timeline 解析暂缓前态，RC-M2）
//   4. reopen（reopen_count++ + 清时间戳）/ reactivate / issue_reject / void
//   5. scope_change（不改 status + scope_changed=1 + deadline 留痕）
//   6. derive（派生新单 + 防环 M-1 + T-L3 先 created 再 derive）
//   7. normalizeSysDatetime 用例表（核实#8 / §6.2 L-2）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-flow-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// authenticateToken mock：解析 Bearer JWT 注入 req.user（对齐 server.js 真实行为）
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

let server, port;
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 用端点建一个 feature 单并推进到指定状态（admin 视角），返回 id
async function seedToDevInProgress(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  assert.strictEqual(r.status, 200, 'schedule 200, got ' + r.status + ' ' + JSON.stringify(r.body));   // codex 15 L-1
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  assert.strictEqual(r.status, 200, 'assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));      // codex 15 L-1
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // seed users 表（assign 端点校验被指派人存在 + 非 viewer）
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin/dev5/dev6/viewer9）');

  try {
    // ── [1] estimate（回填预计）──
    const id1 = await seedToDevInProgress(5);   // 指派给 dev5，开发中
    // estimate 缺/非法格式 → 400
    let r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: '随便' });
    assert.strictEqual(r.status, 400, 'estimate 非法格式 400');
    assert.strictEqual(r.body.code, 'INVALID_ESTIMATE');
    ok('estimate：非法时间格式「随便」→ 400 INVALID_ESTIMATE');
    // 非本人开发 estimate → 403
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, dev2Tok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 403, 'estimate 非本人 403');
    ok('estimate：非本人开发（dev6≠assignee）→ 403 NOT_AUTHORIZED_FOR_TRANSITION');
    // 早于 assigned_at → 400（assigned_at 是 datetime now，传 2020 必早）
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: '2020-01-01 10:00' });
    assert.strictEqual(r.status, 400, 'estimate 早于指派 400');
    assert.strictEqual(r.body.code, 'ESTIMATE_BEFORE_ASSIGN');
    ok('estimate：早于 assigned_at（2020）→ 400 ESTIMATE_BEFORE_ASSIGN');
    // 合法 estimate（本人）→ 200，不改 status（仍开发中）
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 200, 'estimate 合法 200');
    const d1 = await get('SELECT status, dev_estimated_at FROM sys_issues WHERE id=?', [id1]);
    assert.strictEqual(d1.status, '开发中', 'estimate 不改 status');
    assert.strictEqual(d1.dev_estimated_at, '2026-08-01 10:00', 'dev_estimated_at 规范化入库');
    ok('estimate：本人 + 合法时间 → 200，不改 status（仍开发中）+ dev_estimated_at 入库');
    // codex 15b L-1：assigned_at 缺失保护——造一个"开发中但 assigned_at 空"的脏单，estimate 应 409 ASSIGNED_AT_MISSING
    const dirtyId = await seedToDevInProgress(5);
    await run('UPDATE sys_issues SET assigned_at = NULL WHERE id=?', [dirtyId]);   // 模拟 import/人工修库脏单
    r = await call('POST', `/api/sys-issues/${dirtyId}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 409, 'assigned_at 空脏单 estimate 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'ASSIGNED_AT_MISSING', 'assigned_at 空应 ASSIGNED_AT_MISSING');
    ok('L-1(复)：estimate assigned_at 缺失脏单 → 409 ASSIGNED_AT_MISSING（防绕过 >=assigned_at 闸门）');

    // ── [2] submit → accept 全流程 ──
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { summary: '功能 X 完成' });
    assert.strictEqual(r.status, 200, 'submit 200');
    assert.strictEqual(r.body.status, '待验证', 'submit → 待验证');
    ok('submit：开发本人 + summary → 待验证');
    r = await call('POST', `/api/sys-issues/${id1}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, 'accept 200');   // L-1
    assert.strictEqual(r.body.status, '待上线', 'accept → 待上线');
    ok('accept：admin → 待上线');

    // ── [3] return（打回，return_count++）──
    const id2 = await seedToDevInProgress(5);
    await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    await call('POST', `/api/sys-issues/${id2}/submit`, devTok, { summary: '交付' });
    r = await call('POST', `/api/sys-issues/${id2}/return`, adminTok, { reason: '列不齐' });
    assert.strictEqual(r.status, 200, 'return 200');   // L-1
    assert.strictEqual(r.body.status, '开发中', 'return → 开发中');
    const d2 = await get('SELECT return_count, dev_estimated_at FROM sys_issues WHERE id=?', [id2]);
    assert.strictEqual(d2.return_count, 1, 'return_count++ (=1)');
    assert.strictEqual(d2.dev_estimated_at, null, 'return 清 dev_estimated_at（T-M2）');
    ok('return：admin + reason → 开发中，return_count=1 + 清 dev_estimated_at');

    // ── [4] hold → resume（RC-M2 暂缓前态解析）──
    const id3 = await seedToDevInProgress(5);   // 开发中
    r = await call('POST', `/api/sys-issues/${id3}/hold`, adminTok, { reason: '暂缓一下' });
    assert.strictEqual(r.status, 200, 'hold 200');   // L-1
    assert.strictEqual(r.body.status, '已暂缓', 'hold → 已暂缓');
    ok('hold：开发中 → 已暂缓（admin + reason）');
    r = await call('POST', `/api/sys-issues/${id3}/resume`, adminTok, {});
    assert.strictEqual(r.status, 200, 'resume 200');
    assert.strictEqual(r.body.status, '开发中', 'resume 回暂缓前态（开发中）');
    ok('⭐ resume：已暂缓 → 开发中（从 timeline 解析暂缓前态 RC-M2，非静默落任意态）');
    // resume 非暂缓态 → 400 INVALID_TRANSITION（M-1 重构后由 transition findTransition 统一拦截，
    //   与其他动作"非法前置态"行为一致；非暂缓态没有 resume transition，返 400）
    r = await call('POST', `/api/sys-issues/${id3}/resume`, adminTok, {});
    assert.strictEqual(r.status, 400, 'resume 非暂缓态 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', 'resume 非暂缓态 INVALID_TRANSITION');
    ok('resume：非已暂缓态 → 400 INVALID_TRANSITION（M-1 重构后 transition 统一拦截非法前置态）');

    // ── [5] reopen（已关闭 → 开发中，reopen_count++）──
    //   推进 id1（待上线）到已上线需批次（C4），这里直接 DB 改到已关闭测 reopen
    const id4 = await seedToDevInProgress(5);
    await run("UPDATE sys_issues SET status='已关闭', accepted_at='2026-01-01', closed_at='2026-01-02' WHERE id=?", [id4]);
    r = await call('POST', `/api/sys-issues/${id4}/reopen`, adminTok, { reason: '回归 bug' });
    assert.strictEqual(r.status, 200, 'reopen 200');   // L-1
    assert.strictEqual(r.body.status, '开发中', 'reopen → 开发中');
    const d4 = await get('SELECT reopen_count, accepted_at, closed_at, reopened_at FROM sys_issues WHERE id=?', [id4]);
    assert.strictEqual(d4.reopen_count, 1, 'reopen_count++ (=1)');
    assert.strictEqual(d4.accepted_at, null, 'reopen 清 accepted_at');
    assert.strictEqual(d4.closed_at, null, 'reopen 清 closed_at');
    assert.ok(d4.reopened_at, 'reopen 盖 reopened_at');
    ok('reopen：已关闭 → 开发中，reopen_count=1 + 清 accepted_at/closed_at + 盖 reopened_at');

    // ── [6] issue_reject → reactivate（待评估 → 已拒绝 → 待评估）──
    let rr = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'reject测', system_name: 'BMS', source: '内部' });
    const id5 = rr.body.id;   // 待评估
    r = await call('POST', `/api/sys-issues/${id5}/issue-reject`, adminTok, { reason: '不做' });
    assert.strictEqual(r.status, 200, 'issue-reject 200');   // L-1
    assert.strictEqual(r.body.status, '已拒绝', 'issue_reject → 已拒绝');
    r = await call('POST', `/api/sys-issues/${id5}/reactivate`, adminTok, { reason: '重新考虑' });
    assert.strictEqual(r.status, 200, 'reactivate 200');   // L-1
    assert.strictEqual(r.body.status, '待评估', 'reactivate → 待评估（回初始态）');
    const d5 = await get('SELECT reopen_count FROM sys_issues WHERE id=?', [id5]);
    assert.strictEqual(d5.reopen_count, 0, 'reactivate 不计返工（reopen_count 不变 RC-M1）');
    ok('issue_reject → reactivate：待评估 → 已拒绝 → 待评估（回初始态，reopen_count 不变 RC-M1）');

    // ── [7] void（作废）──
    r = await call('POST', `/api/sys-issues/${id5}/void`, adminTok, { reason: '误建' });
    assert.strictEqual(r.status, 200, 'void 200');   // L-1
    assert.strictEqual(r.body.status, '已作废', 'void → 已作废');
    ok('void：→ 已作废（软删除）');

    // ── [8] scope_change（不改 status + scope_changed=1 + deadline 留痕）──
    const id6 = await seedToDevInProgress(5);   // 开发中
    r = await call('POST', `/api/sys-issues/${id6}/scope-change`, adminTok, { summary: '加一个导出功能', deadline: '2026-09-01' });
    assert.strictEqual(r.status, 200, 'scope-change 200');
    const d6 = await get('SELECT status, scope_changed, deadline FROM sys_issues WHERE id=?', [id6]);
    assert.strictEqual(d6.status, '开发中', 'scope_change 不改 status');
    assert.strictEqual(d6.scope_changed, 1, 'scope_changed=1');
    assert.strictEqual(d6.deadline, '2026-09-01', 'deadline 改动');
    const scEv = await get("SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' ORDER BY id DESC LIMIT 1", [id6]);
    assert.ok(/deadline/.test(scEv.summary), 'scope_change summary 含 deadline 留痕');
    ok('scope_change：不改 status + scope_changed=1 + deadline 改动留痕到 summary');
    // scope_change 缺 summary → 400
    r = await call('POST', `/api/sys-issues/${id6}/scope-change`, adminTok, { summary: '  ' });
    assert.strictEqual(r.status, 400, 'scope-change 缺 summary 400');
    ok('scope_change：缺 summary → 400 SCOPE_SUMMARY_REQUIRED');
    // codex 15 M-3：空白 deadline 不清空原 deadline（id6 此时 deadline='2026-09-01'）
    r = await call('POST', `/api/sys-issues/${id6}/scope-change`, adminTok, { summary: '再扩展', deadline: '   ' });
    assert.strictEqual(r.status, 200, 'scope-change 空白 deadline 200');
    const d6b = await get('SELECT deadline FROM sys_issues WHERE id=?', [id6]);
    assert.strictEqual(d6b.deadline, '2026-09-01', '空白 deadline 不清空原值（保持 2026-09-01）');
    ok('M-3：scope_change 空白 deadline「   」→ 不清空原 deadline（防误清空）');

    // ── [9] derive（派生新单 + 防环 + T-L3）──
    const id7 = await seedToDevInProgress(5);
    r = await call('POST', `/api/sys-issues/${id7}/derive`, adminTok, { type: 'feature', title: '迭代需求', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r.status, 201, 'derive 201');
    const derivedId = r.body.id;
    assert.strictEqual(r.body.origin_issue_id, id7, 'derive origin_issue_id=原单');
    // T-L3：先 created 再 derive
    const dtl = await all("SELECT event_type FROM sys_issue_timeline WHERE issue_id=? ORDER BY id", [derivedId]);
    assert.strictEqual(dtl[0].event_type, 'created', '派生新单首条 created（T-L3）');
    assert.strictEqual(dtl[1].event_type, 'derive', '派生新单次条 derive（T-L3）');
    ok('derive：派生新单 201 + origin_issue_id=原单 + T-L3（先 created 再 derive）');
    // 防环：让 id7 的 origin 指向 derivedId，再从 derivedId 派生回 id7 链 → 应拒
    await run('UPDATE sys_issues SET origin_issue_id=? WHERE id=?', [derivedId, id7]);   // id7.origin=derivedId
    r = await call('POST', `/api/sys-issues/${derivedId}/derive`, adminTok, { type: 'feature', title: 'x', system_name: 'BMS', source: '内部' });
    // derivedId.origin=id7, id7.origin=derivedId → 从 derivedId 回溯链含 derivedId 自身 → DERIVE_CYCLE
    assert.strictEqual(r.status, 409, 'derive 成环 409');
    assert.strictEqual(r.body.code, 'DERIVE_CYCLE', 'derive 成环 DERIVE_CYCLE');
    ok('⭐ derive 防环（M-1）：blood 链成环（derivedId→id7→derivedId）→ 409 DERIVE_CYCLE');

    // ── [10] normalizeSysDatetime 用例表（核实#8 / §6.2 L-2 + codex 15 M-2 分钟级）──
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30'), '2026-08-01 10:30', '标准格式');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01T10:30'), '2026-08-01 10:30', 'T 分隔（datetime-local）');
    assert.strictEqual(I.normalizeSysDatetime('  2026-08-01 10:30  '), '2026-08-01 10:30', 'trim');
    assert.strictEqual(I.normalizeSysDatetime(''), null, '空串 null');
    assert.strictEqual(I.normalizeSysDatetime('   '), null, '纯空格 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-13-01 10:00'), null, '非法月份 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-02-30 10:00'), null, '非法日期 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 25:00'), null, '非法小时 null');
    assert.strictEqual(I.normalizeSysDatetime('随便写'), null, '乱码 null');
    // codex 15 M-2：分钟级——带秒判非法（不再吞秒），杜绝 10:30:99 被规范化为 10:30 通过
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30:00'), null, '带秒（合法秒）也判非法（分钟级口径）');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30:99'), null, '带非法秒判非法（不吞秒）');
    // truncToMinute：DB datetime 截分钟（estimate 比较 assigned_at 用）
    assert.strictEqual(I.truncToMinute('2026-08-01 10:30:59'), '2026-08-01 10:30', 'truncToMinute 截秒');
    assert.strictEqual(I.truncToMinute(null), null, 'truncToMinute null 安全');
    ok('normalizeSysDatetime 分钟级（M-2）：标准/T分隔/trim/空/非法月日时/乱码/带秒判非法 + truncToMinute 截秒');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 C3a 开发动作 + 旁路态端点全流程验证通过`);
    console.log('  覆盖：estimate(本人/格式/>=assigned_at) + submit/accept/return(计数) + hold/resume(RC-M2 暂缓前态) + reopen(计数/清时间戳) + reactivate(RC-M1) + void + scope_change(不改status/留痕) + derive(防环 M-1/T-L3) + normalizeSysDatetime');
  } finally {
    server.close();
    db.close();
  }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); if (server) server.close(); db.close(); process.exit(1); });
