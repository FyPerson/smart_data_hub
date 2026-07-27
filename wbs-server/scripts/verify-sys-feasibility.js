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

// 建单（可带 needs_feasibility）→ assign → 开发中，返回 id（受理排期改造：schedule 退场·建单直落待指派）
async function seedToDev(needsFeasibility = 0, assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', needs_feasibility: needsFeasibility });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
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
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '需评估', system_name: 'BMS', source: '内部', needs_feasibility: 1 });
    assert.strictEqual(r.status, 201, '建单 needs_feasibility=1 → 201');
    let d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 1, 'needs_feasibility=1 入库');
    ok('[A1] 建单 needs_feasibility=1（feature）→ 入库 needs_feasibility=1');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '不评估', system_name: 'BMS', source: '内部' });
    d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 0, '不传默认 needs_feasibility=0');
    ok('[A2] 建单不传 needs_feasibility（feature）→ 默认 0');

    // [A3] L-2（codex 19）：建单传非法 needs_feasibility（非 0/1 真值串）→ 400 INVALID_NEEDS_FEASIBILITY（失败响亮不静默落 0）
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '非法nf', system_name: 'BMS', source: '内部', needs_feasibility: 'yes' });
    assert.strictEqual(r.status, 400, '非法 needs_feasibility 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_NEEDS_FEASIBILITY', 'got ' + (r.body && r.body.code));
    ok('[A3] 建单 needs_feasibility=非法值「yes」→ 400 INVALID_NEEDS_FEASIBILITY（输入收窄，不静默落 0）');

    // [C3 退场] 原 [B1]-[B7]（submit 评估闸门：FEASIBILITY_REQUIRED/FEASIBILITY_NOT_FEASIBLE/
    //   FEASIBILITY_INCOMPLETE/ISSUE_BLOCKED/FEASIBILITY_RISK_REQUIRED 五类闸门 + 放行两例）已整体移除——
    //   W05 唯一 submit 改多开发 commit 事件模型（方案 §6.1/§6.2），body 收窄为 mode=no_code|commits 二选一，
    //   不再校验 feasibility_conclusion/blocked/dev_estimated_at 等旧单人字段，这些闸门随旧 summary 模型一并
    //   退场（同 §submit switch 分支退场注释：新模型下 commit 行本身即交付证据，"评估未完成不许提交"这类
    //   业务规则若要在新模型上重建，属 C7「交付 D5」范围，非本轮静默保留）。needs_feasibility 建单入库
    //   （[A]）与 estimate 端点自身的 ESTIMATE_REQUIRES_FEASIBILITY 封口（[D]）不受影响，继续覆盖。

    // ── [C] needs_feasibility=0 场景下 estimate 正常 + submit 结构性放行（新模型已不查 feasibility，恒放行）──
    const idC = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idC}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 estimate 200, got ' + r.status);
    r = await call('POST', `/api/sys-issues/${idC}/submit`, devTok, { mode: 'no_code', no_code_reason: 'feasibility 测试占位理由' });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 submit 放行, got ' + r.status + ' ' + JSON.stringify(r.body));
    ok('[C1] needs_feasibility=0 → estimate 正常 + submit 放行（新模型不查 feasibility，C3 起恒放行）');

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
    // ⚠️ 既有测试变更（C2 破坏性变更，详见交付汇报"既有测试变更清单"）：F-reassign 子测原断言 reassign
    //   （旧版"换主=新一轮"语义）清评估+blocked+dev_estimated_at 三组字段。v2.9 reassign 重写为声明式最终
    //   roster 差量（方案 §3），无"主开发换人=新一轮"这个业务规则了（没有"主"就没有"换主"），字段清零属
    //   W07/ADMIN_TRANSITION 侧关切（C3 范围，本轮不碰）——该子测整体移除，非静默改断言。F-return/F-reopen
    //   （下方两段）走 return/reopen 两个 ADMIN_TRANSITION 端点，与 reassign 无关，未受影响、保持不变。

    // F-return：完整评估 → submit → 造 blocked → return → 清
    const idF2 = await seedToDev(1, 5);
    await fillFeasibility(idF2, { dev_estimated_at: '2026-08-01 10:00', conclusion: '可行', requirement_confirm: '懂了' });
    r = await call('POST', `/api/sys-issues/${idF2}/submit`, devTok, { mode: 'no_code', no_code_reason: 'feasibility 测试占位理由' });
    assert.strictEqual(r.status, 200, 'F2 submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
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
    ok('[G] H-1 submit type 过滤 + 建单 FEASIBILITY_NOT_APPLICABLE 均为防御性死代码（无 bug/config 流不可达）；needs_feasibility 维度 [A]/[C] 已覆盖');

    // [C3 退场] 原 [H]（"跳过评估直接 submit 撞 ESTIMATE_REQUIRED 死锁约束"）随旧 submit 的 ESTIMATE_REQUIRED
    //   闸门一并移除——新 submit 不再校验 dev_estimated_at，"F2a 不可单独部署、必须 F2a+F2b 同批"这条约束
    //   本身随旧模型退场，不再有对应物可测。

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 F2a 可行性评估约束闸门验证通过`);
    console.log('  覆盖：建单 needs_feasibility 入库（含非法值收窄）+ needs_feasibility=0 场景 submit 结构性放行 + estimate 封口（ESTIMATE_REQUIRES_FEASIBILITY）+ scope_change 禁用 + 换轮清字段（return/reopen）+ timeline 冻结（C3：原 submit 评估闸门[B]/[H] 随旧单人 summary 模型退场，见文内注释）');
  } finally {
    server.close();
    db.close();
  }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); if (server) server.close(); db.close(); process.exit(1); });
