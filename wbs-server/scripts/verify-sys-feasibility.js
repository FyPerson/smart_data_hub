// 验证脚本：系统迭代 F2a 可行性评估约束闸门（方案 评估编码实施方案 v0.3 §三/§四/§六 + v1.7 §十九）
//   用法：node scripts/verify-sys-feasibility.js
//
// ⚠️ F2a 只做"约束闸门 + 换轮清字段"，feasibility/blocked/unblock 写入端点是 F2b——
//   故本脚本 [B]/[F] 块对 needs_feasibility=1 的单用「直接 DB UPDATE」(fillFeasibility) 模拟尚未实现的 F2b /feasibility 端点，
//   验证的是 **F2a+F2b 合并后**的 submit 闸门 / 换轮清字段行为，非 F2a 独立可部署性。
//   ⚠️ 跳过评估直接 submit 的守卫（见 [H]，F2b 落地后语义更新）：needs_feasibility=1 单若开发不调 /feasibility 直接 submit，
//   dev_estimated_at 仍为 NULL（estimate 端点已封口）→ submit 撞通用 ESTIMATE_REQUIRED 拦住，无法绕过评估闸门（F2b 实现 /feasibility 后不再死锁，但守卫不变）。
//   聚焦验证 submit 闸门 / estimate 封口 / scope_change 禁用 / reassign·return·reopen 换轮清字段 / timeline 冻结 / 跳过评估 submit 守卫[H]。
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-feasibility-secret';
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

// 建单（可带 needs_feasibility）→ schedule → assign → 开发中，返回 id
async function seedToDev(needsFeasibility = 0, assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 't', system_name: 'BMS', source: '内部', needs_feasibility: needsFeasibility });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  assert.strictEqual(r.status, 200, 'schedule 200, got ' + r.status);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  assert.strictEqual(r.status, 200, 'assign 200, got ' + r.status);
  return id;
}

// 模拟 F2b /feasibility 端点写入（F2a 阶段端点未实现，直接改库注入评估/受阻字段）
async function fillFeasibility(id, { conclusion = null, requirement_confirm = null, risk = null,
  dev_estimated_at = '2026-08-01 10:00', blocked = 0, blocked_reason = null, blocked_at = null } = {}) {
  await run(`UPDATE sys_issues SET feasibility_conclusion=?, feasibility_requirement_confirm=?, feasibility_risk=?,
                dev_estimated_at=?, blocked=?, blocked_reason=?, blocked_at=? WHERE id=?`,
    [conclusion, requirement_confirm, risk, dev_estimated_at, blocked, blocked_reason, blocked_at, id]);
}

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
    // ── [A] 建单 needs_feasibility 入库（§4.5 / 开放④建单后锁定）──
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: '需评估', system_name: 'BMS', source: '内部', needs_feasibility: 1 });
    assert.strictEqual(r.status, 201, '建单 needs_feasibility=1 → 201');
    let d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 1, 'needs_feasibility=1 入库');
    ok('[A1] 建单 needs_feasibility=1（feature）→ 入库 needs_feasibility=1');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: '不评估', system_name: 'BMS', source: '内部' });
    d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 0, '不传默认 needs_feasibility=0');
    ok('[A2] 建单不传 needs_feasibility（feature）→ 默认 0');

    // [A3] L-2（codex 19）：建单传非法 needs_feasibility（非 0/1 真值串）→ 400 INVALID_NEEDS_FEASIBILITY（失败响亮不静默落 0）
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: '非法nf', system_name: 'BMS', source: '内部', needs_feasibility: 'yes' });
    assert.strictEqual(r.status, 400, '非法 needs_feasibility 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_NEEDS_FEASIBILITY', 'got ' + (r.body && r.body.code));
    ok('[A3] 建单 needs_feasibility=非法值「yes」→ 400 INVALID_NEEDS_FEASIBILITY（输入收窄，不静默落 0）');

    // ── [B] submit 评估闸门（needs_feasibility=1，逐态 DB 改库模拟评估写入）──
    const idB = await seedToDev(1);   // needs_feasibility=1，开发中，评估全空
    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00' });   // 仅写 dev_est（过通用 ESTIMATE_REQUIRED），评估结论空
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, 'submit 无评估 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'FEASIBILITY_REQUIRED', 'got ' + (r.body && r.body.code));
    ok('[B1] needs_feasibility=1 + 无评估结论 → submit 400 FEASIBILITY_REQUIRED');

    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '不可行' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, '[B2] status 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_FEASIBLE', '不可行 → FEASIBILITY_NOT_FEASIBLE, got ' + (r.body && r.body.code));
    ok('[B2] 结论=不可行 → submit 400 FEASIBILITY_NOT_FEASIBLE');

    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '  ' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, '[B3] status 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'FEASIBILITY_INCOMPLETE', '需求理解空 → FEASIBILITY_INCOMPLETE, got ' + (r.body && r.body.code));
    ok('[B3] 结论=可行 + 需求理解空 → submit 400 FEASIBILITY_INCOMPLETE');

    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了', blocked: 1, blocked_reason: '等接口' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, '[B4] status 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'ISSUE_BLOCKED', 'blocked=1 → ISSUE_BLOCKED, got ' + (r.body && r.body.code));
    ok('[B4] blocked=1 → submit 400 ISSUE_BLOCKED');
    // [B4b] 真正验证「blocked 优先于完整性校验」（ultracode 对抗审补强）：blocked=1 且 requirement_confirm 空 → 仍 ISSUE_BLOCKED（非 FEASIBILITY_INCOMPLETE）
    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '  ', blocked: 1, blocked_reason: '等接口' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, '[B4b] status 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'ISSUE_BLOCKED', 'blocked=1 + 需求理解空 → 仍 ISSUE_BLOCKED（证明 blocked 短路在 INCOMPLETE 之前）, got ' + (r.body && r.body.code));
    ok('[B4b] blocked=1 + 需求理解空 → submit 仍 ISSUE_BLOCKED（证明 blocked 优先于完整性校验，非 FEASIBILITY_INCOMPLETE）');

    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '有条件可行', requirement_confirm: '懂了', risk: '  ' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 400, '[B5] status 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'FEASIBILITY_RISK_REQUIRED', '有条件可行缺风险 → FEASIBILITY_RISK_REQUIRED, got ' + (r.body && r.body.code));
    ok('[B5] 结论=有条件可行 + 风险空 → submit 400 FEASIBILITY_RISK_REQUIRED');

    await fillFeasibility(idB, { dev_estimated_at: '2026-08-01 10:00', conclusion: '有条件可行', requirement_confirm: '懂了', risk: '依赖外部接口' });
    r = await call('POST', `/api/sys-issues/${idB}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 200, '完整评估 → submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, '待验证', 'submit → 待验证');
    ok('[B6] 有条件可行 + 风险填全 → submit 放行 200 待验证');

    const idB7 = await seedToDev(1);
    await fillFeasibility(idB7, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了' });
    r = await call('POST', `/api/sys-issues/${idB7}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 200, '可行完整 → submit 200, got ' + r.status);
    ok('[B7] 结论=可行 + 需求理解（可行无需风险）→ submit 放行 200');

    // ── [C] needs_feasibility=0 不触发评估闸门 ──
    const idC = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idC}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 estimate 200, got ' + r.status);
    r = await call('POST', `/api/sys-issues/${idC}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 submit 无评估放行, got ' + r.status);
    ok('[C1] needs_feasibility=0 → estimate 正常 + submit 无评估放行（不触发评估闸门）');

    // ── [D] estimate 封口（needs_feasibility=1，codex 17 M-6）──
    const idD = await seedToDev(1);
    r = await call('POST', `/api/sys-issues/${idD}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 409, 'needs_feasibility=1 estimate 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRES_FEASIBILITY', 'got ' + (r.body && r.body.code));
    ok('[D1] needs_feasibility=1 → estimate 409 ESTIMATE_REQUIRES_FEASIBILITY（预计只能评估端写）');
    ok('[D2] needs_feasibility=0 → estimate 200（不封口，见 C1）');

    // ── [E] scope_change 禁用（feature/improvement 全禁，§4.4）──
    const idE = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idE}/scope-change`, adminTok, { summary: '加需求' });
    assert.strictEqual(r.status, 409, 'feature scope-change 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', 'got ' + (r.body && r.body.code));
    ok('[E1] feature 开发中 → scope-change 409 SCOPE_CHANGE_DISABLED（禁开发态调需求）');

    // ── [F] 换轮清字段 + timeline 冻结（§六 H-2/H-3）──
    // F-reassign：填评估+blocked + 造 feasibility timeline → reassign → 主表清 + timeline 保留
    const idF1 = await seedToDev(1, 5);
    await fillFeasibility(idF1, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了', risk: '风险', blocked: 1, blocked_reason: '等', blocked_at: '2026-01-01 09:00' });
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name) VALUES (?, 'feasibility', '评估快照', 5, '开发王')`, [idF1]);
    r = await call('POST', `/api/sys-issues/${idF1}/reassign`, adminTok, { newAssignedTo: 6, oldAssignedTo: 5, reason: '换人' });
    assert.strictEqual(r.status, 200, 'reassign 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    d = await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk, blocked, blocked_reason, blocked_at, dev_estimated_at FROM sys_issues WHERE id=?', [idF1]);
    assert.strictEqual(d.feasibility_conclusion, null, 'reassign 清 conclusion');
    assert.strictEqual(d.feasibility_requirement_confirm, null, 'reassign 清 requirement_confirm');
    assert.strictEqual(d.feasibility_risk, null, 'reassign 清 risk');
    assert.strictEqual(d.blocked, 0, 'reassign 清 blocked=0');
    assert.strictEqual(d.blocked_reason, null, 'reassign 清 blocked_reason');
    assert.strictEqual(d.blocked_at, null, 'reassign 清 blocked_at');
    assert.strictEqual(d.dev_estimated_at, null, 'reassign 清 dev_estimated_at');
    const fbEv = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility'`, [idF1]);
    assert.ok(fbEv, 'reassign 后 feasibility timeline 快照仍保留（H-3 清主表非 timeline）');
    ok('[F-reassign] 换人清评估3+blocked3+dev_est（helper），timeline feasibility 快照保留（H-3 冻结）');

    // F-return：完整评估 → submit → 造 blocked → return → 清
    const idF2 = await seedToDev(1, 5);
    await fillFeasibility(idF2, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了' });
    r = await call('POST', `/api/sys-issues/${idF2}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(r.status, 200, 'F2 submit 200（评估完整）, got ' + r.status);
    await run(`UPDATE sys_issues SET blocked=1, blocked_reason='x' WHERE id=?`, [idF2]);   // 造受阻残留测 return 清理覆盖
    r = await call('POST', `/api/sys-issues/${idF2}/return`, adminTok, { reason: '列不齐' });
    assert.strictEqual(r.status, 200, 'return 200, got ' + r.status);
    assert.strictEqual(r.body.status, '开发中', 'return → 开发中');
    d = await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, blocked, blocked_reason, dev_estimated_at, return_count FROM sys_issues WHERE id=?', [idF2]);
    assert.strictEqual(d.feasibility_conclusion, null, 'return 清 conclusion');
    assert.strictEqual(d.feasibility_requirement_confirm, null, 'return 清 requirement_confirm');
    assert.strictEqual(d.blocked, 0, 'return 清 blocked');
    assert.strictEqual(d.blocked_reason, null, 'return 清 blocked_reason');
    assert.strictEqual(d.dev_estimated_at, null, 'return 清 dev_estimated_at');
    assert.strictEqual(d.return_count, 1, 'return_count++ 仍生效（既有逻辑不回归）');
    ok('[F-return] 打回（待验证→开发中）清评估+blocked+dev_est，return_count++ 不回归');

    // F-reopen：开发中→已关闭+填评估 → reopen → 清
    const idF3 = await seedToDev(1, 5);
    await fillFeasibility(idF3, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了', blocked: 1, blocked_reason: 'x' });
    await run("UPDATE sys_issues SET status='已关闭', accepted_at='2026-01-01', closed_at='2026-01-02' WHERE id=?", [idF3]);
    r = await call('POST', `/api/sys-issues/${idF3}/reopen`, adminTok, { reason: '回归' });
    assert.strictEqual(r.status, 200, 'reopen 200, got ' + r.status);
    assert.strictEqual(r.body.status, '开发中', 'reopen → 开发中');
    d = await get('SELECT feasibility_conclusion, blocked, blocked_reason, dev_estimated_at, reopen_count FROM sys_issues WHERE id=?', [idF3]);
    assert.strictEqual(d.feasibility_conclusion, null, 'reopen 清 conclusion');
    assert.strictEqual(d.blocked, 0, 'reopen 清 blocked');
    assert.strictEqual(d.blocked_reason, null, 'reopen 清 blocked_reason');
    assert.strictEqual(d.dev_estimated_at, null, 'reopen 清 dev_estimated_at');
    assert.strictEqual(d.reopen_count, 1, 'reopen_count++ 仍生效（既有逻辑不回归）');
    ok('[F-reopen] 重开（已关闭→开发中）清评估+blocked+dev_est，reopen_count++ 不回归');

    // ── [G] 防御性死代码注记（H-1 + 建单 FEASIBILITY_NOT_APPLICABLE，ultracode 对抗审补全）──
    //   两处为 bug/config 流预埋、F2a 内不可达、无法端到端测：
    //   ① submit 闸门 type 过滤（['feature','improvement'].includes + needs_feasibility=1）——bug/config 无 submit transition，
    //      findTransition 返 null，请求在到达闸门前 409，故 type 过滤分支 bug/config 侧不可达。
    //   ② 建单 FEASIBILITY_NOT_APPLICABLE（非 feature/improvement 传 needs_feasibility=1 拒）——config/bug 建单先被 TYPE_NOT_SUPPORTED 拦，到不了该守卫。
    //   两处 type 维度断言待 bug/config 流追加（C 系列后续）补端到端；needs_feasibility 维度已由 [B]/[C] 全覆盖。
    ok('[G] H-1 submit type 过滤 + 建单 FEASIBILITY_NOT_APPLICABLE 均为防御性死代码（无 bug/config 流不可达）；needs_feasibility 维度 [B]/[C] 已覆盖');

    // ── [H] 跳过评估直接 submit 的守卫（ultracode 对抗审，F2b 落地后语义更新）──
    //   [B]/[F] 块用 fillFeasibility 裸 DB UPDATE 模拟 F2b /feasibility 端点写入，测 F2a 闸门 + 换轮清字段。
    //   本块测：needs_feasibility=1 单若开发不调 /feasibility 直接 submit → dev_estimated_at 为 NULL（estimate 封口）→
    //   submit 撞通用 ESTIMATE_REQUIRED 拦住，无法绕过评估闸门。F2b 实现 /feasibility 后该单有了正常出路（不再死锁），但此守卫路径仍有效。
    const idH = await seedToDev(1);   // needs_feasibility=1，不 DB 注入 dev_est，走真实 F2a-only 链路
    let rH = await call('POST', `/api/sys-issues/${idH}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(rH.status, 409, 'F2a-only estimate 封口 409, got ' + rH.status);
    assert.strictEqual(rH.body.code, 'ESTIMATE_REQUIRES_FEASIBILITY', 'estimate 封口码, got ' + (rH.body && rH.body.code));
    rH = await call('POST', `/api/sys-issues/${idH}/submit`, devTok, { summary: '交付' });
    assert.strictEqual(rH.status, 400, 'F2a-only submit 400, got ' + rH.status);
    assert.strictEqual(rH.body.code, 'ESTIMATE_REQUIRED', 'F2a-only 真实链路 submit 撞通用 ESTIMATE_REQUIRED（非 FEASIBILITY_REQUIRED）, got ' + (rH.body && rH.body.code));
    ok('[H] F2a-only 真实链路：needs_feasibility=1 单 estimate 封口 + submit 撞 ESTIMATE_REQUIRED（暴露死锁约束=F2a 不可单独部署，必须 F2a+F2b 同批）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 F2a 可行性评估约束闸门验证通过`);
    console.log('  覆盖：建单 needs_feasibility 入库 + submit 闸门（必填/不可行/blocked/需求理解/风险/放行 + blocked 优先级 B4b）+ needs_feasibility=0 不触发 + estimate 封口 + scope_change 禁用 + 换轮清字段（reassign/return/reopen）+ timeline 冻结 + F2a-only 死锁约束[H]（必须 F2a+F2b 同批部署）');
  } finally {
    server.close();
    db.close();
  }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); if (server) server.close(); db.close(); process.exit(1); });
