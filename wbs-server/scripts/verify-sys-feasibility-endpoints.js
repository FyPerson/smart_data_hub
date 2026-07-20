// 验证脚本：系统迭代 F2b 评估旁路端点 feasibility/blocked/unblock（方案 v0.3 §四 + v1.7 §十九）
//   用法：node scripts/verify-sys-feasibility-endpoints.js
//
// F2b 端点实现后，用真实 HTTP 端点（替代 F2a 的 DB 模拟）测：
//   [F] feasibility 端点（填评估）/ [BL] blocked 端点（受阻，含 M-1 收口）/ [UB] unblock 端点（解除受阻）
//   [E2E] F2a 闸门 + F2b 端点真实联动闭环（建单评估→submit 放行 / 受阻→拒→解除→放行 / 不可行→拒）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-feasibility-endpoints-secret';
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
  ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
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

// 建单（needs_feasibility 默认 1）→ assign → 开发中，返回 id（受理排期改造：schedule 退场·建单直落待指派）
async function seedToDev(needsFeasibility = 1, assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部', needs_feasibility: needsFeasibility });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  assert.strictEqual(r.status, 200, 'assign 200');
  return id;
}
const EST = '2026-08-01 10:00';

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ── [F] feasibility 端点 ──
    const idF = await seedToDev(1);
    // F1 正常填（可行 + 需求理解，无需 risk）
    let r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已理解需求', dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, 'feasibility 可行 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    let d = await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk, dev_estimated_at, status FROM sys_issues WHERE id=?', [idF]);
    assert.strictEqual(d.feasibility_conclusion, '可行', 'conclusion 写入');
    assert.strictEqual(d.feasibility_requirement_confirm, '已理解需求', 'requirement_confirm 写入');
    assert.strictEqual(d.dev_estimated_at, EST, 'dev_estimated_at 一并写入');
    assert.strictEqual(d.status, '开发中', 'feasibility 不改 status');
    ok('[F1] feasibility 可行+需求理解 → 200，评估字段+dev_estimated_at 写入，status 不变');
    // feasibility timeline 快照
    const fbEv = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility' ORDER BY id DESC LIMIT 1`, [idF]);
    assert.ok(fbEv && /结论：可行/.test(fbEv.summary), 'feasibility timeline 快照含结论');
    ok('[F2] feasibility timeline 快照写入（含结论/需求理解/风险/预计完成）');
    // F3 conclusion 非法
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: 'xyz', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 400, 'conclusion 非法 400'); assert.strictEqual(r.body.code, 'INVALID_FEASIBILITY_CONCLUSION');
    ok('[F3] conclusion 非法值 → 400 INVALID_FEASIBILITY_CONCLUSION');
    // F4 需求理解空
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '  ', dev_estimated_at: EST });
    assert.strictEqual(r.body.code, 'FEASIBILITY_REQUIREMENT_REQUIRED', 'got ' + (r.body && r.body.code));
    ok('[F4] 需求理解空 → 400 FEASIBILITY_REQUIREMENT_REQUIRED');
    // F5 有条件可行 + risk 空
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '有条件可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.body.code, 'FEASIBILITY_RISK_REQUIRED', 'got ' + (r.body && r.body.code));
    ok('[F5] 有条件可行 + 风险空 → 400 FEASIBILITY_RISK_REQUIRED');
    // F6 不可行 + risk → 200 + not_feasible
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '不可行', requirement_confirm: 'x', risk: '技术不支持', dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, '不可行 200'); assert.strictEqual(r.body.not_feasible, true, 'not_feasible=true');
    ok('[F6] 不可行 + 风险 → 200 not_feasible=true（不阻断本动作，阻断在 submit）');
    // F7 非本人（C3：W06 ownerGuard→assertDevMember，非在册 → 403 NOT_ROSTERED，非旧 NOT_AUTHORIZED_FOR_TRANSITION）
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, dev2Tok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '非本人 403'); assert.strictEqual(r.body.code, 'NOT_ROSTERED');
    ok('[F7] 非在册开发（dev6）→ 403 NOT_ROSTERED（C3 assertDevMember 严格在册）');
    // F8 needs_feasibility=0 单
    const idF0 = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idF0}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, 'needs_feasibility=0 → 409'); assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_REQUIRED');
    ok('[F8] needs_feasibility=0 单填评估 → 409 FEASIBILITY_NOT_REQUIRED');
    // F9 非开发态（受理排期改造：建单落待指派·非开发态·填评估仍应拒）
    let rr = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: '待指派', system_name: 'BMS', source: '内部', needs_feasibility: 1 });
    r = await call('POST', `/api/sys-issues/${rr.body.id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, '非开发态 409'); assert.strictEqual(r.body.code, 'FEASIBILITY_STATUS_INVALID');
    ok('[F9] 待指派态（非开发态）填评估 → 409 FEASIBILITY_STATUS_INVALID');
    // F10 早于 assigned_at
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: '2020-01-01 10:00' });
    assert.strictEqual(r.body.code, 'ESTIMATE_BEFORE_ASSIGN', 'got ' + (r.body && r.body.code));
    ok('[F10] dev_estimated_at 早于 assigned_at → 400 ESTIMATE_BEFORE_ASSIGN');

    // ── [BL] blocked 端点 ──
    const idBL = await seedToDev(1);
    // BL1 正常标记
    r = await call('POST', `/api/sys-issues/${idBL}/blocked`, devTok, { reason: '等外部接口' });
    assert.strictEqual(r.status, 200, 'blocked 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    d = await get('SELECT blocked, blocked_reason, blocked_at FROM sys_issues WHERE id=?', [idBL]);
    assert.strictEqual(d.blocked, 1, 'blocked=1'); assert.strictEqual(d.blocked_reason, '等外部接口', 'blocked_reason'); assert.ok(d.blocked_at, 'blocked_at');
    ok('[BL1] blocked 开发本人 + reason → 200，blocked=1/reason/at 写入');
    // BL2 ⭐ M-1 收口：needs_feasibility=0 单不可受阻
    const idBL0 = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idBL0}/blocked`, devTok, { reason: '等接口' });
    assert.strictEqual(r.status, 409, 'needs_feasibility=0 blocked 409'); assert.strictEqual(r.body.code, 'BLOCKED_NOT_APPLICABLE');
    ok('[BL2] ⭐ M-1 收口：needs_feasibility=0 单标受阻 → 409 BLOCKED_NOT_APPLICABLE（守「受阻归评估环节」防绕过 submit 闸门）');
    // BL3 reason 空
    const idBL3 = await seedToDev(1);
    r = await call('POST', `/api/sys-issues/${idBL3}/blocked`, devTok, { reason: '  ' });
    assert.strictEqual(r.body.code, 'BLOCKED_REASON_REQUIRED', 'got ' + (r.body && r.body.code));
    ok('[BL3] reason 空 → 400 BLOCKED_REASON_REQUIRED');
    // BL4 重复 blocked（idBL 已 blocked=1）
    r = await call('POST', `/api/sys-issues/${idBL}/blocked`, devTok, { reason: '再次' });
    assert.strictEqual(r.status, 409, '重复 blocked 409'); assert.strictEqual(r.body.code, 'ISSUE_ALREADY_BLOCKED');
    ok('[BL4] 重复 blocked → 409 ISSUE_ALREADY_BLOCKED（防覆盖首次受阻证据 M-4）');
    // BL5 非本人
    r = await call('POST', `/api/sys-issues/${idBL3}/blocked`, dev2Tok, { reason: '换人标' });
    assert.strictEqual(r.status, 403, '非本人 blocked 403');
    ok('[BL5] 非本人开发标受阻 → 403');
    // BL6 blocked 后 feasibility 禁改（idBL 已 blocked）
    r = await call('POST', `/api/sys-issues/${idBL}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, 'blocked 后填评估 409'); assert.strictEqual(r.body.code, 'ISSUE_BLOCKED');
    ok('[BL6] blocked=1 时填评估 → 409 ISSUE_BLOCKED（受阻禁改评估，保流程线性 codex 17b M-3）');

    // ── [UB] unblock 端点 ──
    // UB1 正常解除（idBL 已 blocked）
    r = await call('POST', `/api/sys-issues/${idBL}/unblock`, adminTok, { reason: '接口已就绪' });
    assert.strictEqual(r.status, 200, 'unblock 200');
    d = await get('SELECT blocked, blocked_reason, blocked_at FROM sys_issues WHERE id=?', [idBL]);
    assert.strictEqual(d.blocked, 0, 'unblock 后 blocked=0');
    assert.strictEqual(d.blocked_reason, null, 'unblock 清 blocked_reason（三件套，codex 20 L-3）');
    assert.strictEqual(d.blocked_at, null, 'unblock 清 blocked_at（三件套）');
    ok('[UB1] unblock admin + reason → 200，blocked 三件套全清（blocked=0/reason/at=NULL）');
    // UB2 未受阻解除
    r = await call('POST', `/api/sys-issues/${idBL}/unblock`, adminTok, { reason: '再解除' });
    assert.strictEqual(r.status, 409, '未受阻 unblock 409'); assert.strictEqual(r.body.code, 'NOT_BLOCKED');
    ok('[UB2] 未受阻单解除 → 409 NOT_BLOCKED（M-7 前置）');
    // UB3 reason 空
    const idUB = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idUB}/blocked`, devTok, { reason: '阻塞' });
    r = await call('POST', `/api/sys-issues/${idUB}/unblock`, adminTok, { reason: '  ' });
    assert.strictEqual(r.body.code, 'UNBLOCK_REASON_REQUIRED', 'got ' + (r.body && r.body.code));
    ok('[UB3] reason 空 → 400 UNBLOCK_REASON_REQUIRED');
    // UB4 非 admin
    r = await call('POST', `/api/sys-issues/${idUB}/unblock`, devTok, { reason: '开发解除' });
    assert.strictEqual(r.status, 403, '非 admin unblock 403');
    ok('[UB4] 非 admin（开发）解除受阻 → 403（requireAdmin）');

    // ── [HV] hold/void 处置清 blocked（ultracode 对抗审：F2b 让 blocked=1 可达后必清，否则 resume 卡死/作废脏数据）──
    // BL7 待验证态标受阻 → 409 BLOCKED_STATUS_INVALID（nf=1 单经 feasibility→submit 到待验证）
    const idHV1 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idHV1}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '确认', dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${idHV1}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });   // → 待验证
    r = await call('POST', `/api/sys-issues/${idHV1}/blocked`, devTok, { reason: '待验证标受阻' });
    assert.strictEqual(r.status, 409, '待验证标受阻 409'); assert.strictEqual(r.body.code, 'BLOCKED_STATUS_INVALID');
    ok('[BL7] 待验证态标受阻 → 409 BLOCKED_STATUS_INVALID（仅开发中可受阻）');
    // BL8 ⭐ hold 清 blocked + 留评估：受阻单暂缓 → blocked 三件套归零、评估保留（§⑥ 不动原评估）+ resume 回开发中不卡死
    const idHV2 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idHV2}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已评估', dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${idHV2}/blocked`, devTok, { reason: '阻塞' });
    r = await call('POST', `/api/sys-issues/${idHV2}/hold`, adminTok, { reason: '暂缓' });
    assert.strictEqual(r.status, 200, 'hold 200'); assert.strictEqual(r.body.status, '已暂缓', 'hold → 已暂缓');
    d = await get('SELECT blocked, blocked_reason, blocked_at, feasibility_conclusion FROM sys_issues WHERE id=?', [idHV2]);
    assert.strictEqual(d.blocked, 0, 'hold 清 blocked=0'); assert.strictEqual(d.blocked_reason, null, 'hold 清 blocked_reason'); assert.strictEqual(d.blocked_at, null, 'hold 清 blocked_at');
    assert.strictEqual(d.feasibility_conclusion, '可行', '⭐ hold 不动评估（§⑥ 留作问责对照，只清 blocked 非换轮）');
    r = await call('POST', `/api/sys-issues/${idHV2}/resume`, adminTok, {});
    assert.strictEqual(r.body.status, '开发中', 'resume → 开发中');
    d = await get('SELECT blocked FROM sys_issues WHERE id=?', [idHV2]);
    assert.strictEqual(d.blocked, 0, 'resume 后 blocked=0（不残留受阻致卡死）');
    ok('[BL8] ⭐ 受阻单 hold → blocked 三件套归零 + 评估保留 + resume 回开发中 blocked=0（修复卡死 bug，ultracode 对抗审）');
    // BL9 void 清 blocked：受阻单作废 → blocked 归零（无残留脏数据）
    const idHV3 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idHV3}/blocked`, devTok, { reason: '阻塞' });
    r = await call('POST', `/api/sys-issues/${idHV3}/void`, adminTok, { reason: '作废' });
    assert.strictEqual(r.status, 200, 'void 200'); assert.strictEqual(r.body.status, '已作废', 'void → 已作废');
    d = await get('SELECT blocked, blocked_reason FROM sys_issues WHERE id=?', [idHV3]);
    assert.strictEqual(d.blocked, 0, 'void 清 blocked=0'); assert.strictEqual(d.blocked_reason, null, 'void 清 blocked_reason');
    ok('[BL9] 受阻单 void → blocked 三件套归零（无残留脏数据，ultracode 对抗审）');

    // ── [E2E] F2a 闸门 + F2b 端点真实联动闭环 ⭐ ──
    // E1 建单评估→submit 放行（真实链路，验证 F2a 闸门读 F2b 写入）
    const idE1 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE1}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: EST });
    r = await call('POST', `/api/sys-issues/${idE1}/submit`, devTok, { mode: 'no_code', no_code_reason: '功能完成（占位理由）' });
    assert.strictEqual(r.status, 200, 'E1 submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', 'E1 → 待验证（main_status 字段，C2/C3 惯例）');
    ok('[E2E-1] ⭐ 建单(评估)→assign→feasibility(可行)→submit 放行 200 待验证（F2a 闸门 + F2b 端点真实联动，非 DB 模拟）');
    // [codex 98 号 HIGH 回填] E2/E3：blocked/feasibility 闸门已在新 submit handler 内逐条复刻恢复
    //   （routes/sys-iteration/index.js 「[codex 98 号 HIGH 回填] submit 资格不变量」注释块，对照 e39e65b
    //   版旧 case 'submit' 逐条照搬判定与错误码），本轮改回真实路由断言，替代上一轮"如实记录现状"的临时降级。
    const idE2 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE2}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '确认', dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${idE2}/blocked`, devTok, { reason: '阻塞中' });
    r = await call('POST', `/api/sys-issues/${idE2}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });
    assert.strictEqual(r.status, 400, 'E2 受阻 submit 拒, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'ISSUE_BLOCKED', 'E2 受阻 submit 拒 code=ISSUE_BLOCKED');
    await call('POST', `/api/sys-issues/${idE2}/unblock`, adminTok, { reason: '解除' });
    r = await call('POST', `/api/sys-issues/${idE2}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });
    assert.strictEqual(r.status, 200, 'E2 解除后 submit 200');
    assert.strictEqual(r.body.main_status, '待验证', 'E2 解除后 submit → 待验证');
    ok('[E2E-2] ⭐ 受阻闭环：feasibility→blocked→submit 拒 400 ISSUE_BLOCKED→unblock→submit 放行（真实路由，闸门已恢复）');
    const idE3 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE3}/feasibility`, devTok, { conclusion: '不可行', requirement_confirm: '确认', risk: '做不了', dev_estimated_at: EST });
    r = await call('POST', `/api/sys-issues/${idE3}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });
    assert.strictEqual(r.status, 400, 'E3 不可行 submit 拒, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_FEASIBLE', 'E3 不可行 submit 拒 code=FEASIBILITY_NOT_FEASIBLE');
    ok('[E2E-3] ⭐ 不可行闭环：feasibility(不可行)→submit 拒 400 FEASIBILITY_NOT_FEASIBLE（真实路由，闸门已恢复）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 F2b 评估旁路端点验证通过`);
    console.log('  覆盖：feasibility(填写/枚举/完整性/本人/态/未勾选/早于指派/快照) + blocked(标记/M-1收口/重复/本人/禁改评估/态守卫) + unblock(解除/M-7前置/admin) + hold·void清blocked(留评估·修卡死) + E2E(评估→submit放行/受阻闭环/不可行闭环)');
  } finally {
    server.close();
    db.close();
  }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); if (server) server.close(); db.close(); process.exit(1); });
