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
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

// 建单（可带 needs_feasibility）→ assign → 开发中，返回 id（受理排期改造：schedule 退场·建单直落待指派）
async function seedToDev(needsFeasibility = 0, assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: needsFeasibility });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level（否则 400 RISK_LEVEL_REQUIRED）。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  assert.strictEqual(r.status, 200, 'assign 200, got ' + r.status);
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本文件测的是可行性评估闸门/换轮清字段，
  //   与「待对接测试」段无关（后者由专门的 verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时
  //   失效（模拟受理人后续停用/移出白名单），触发 §3.0-⑥ 降级路径，使 submit 仍直落"待验证"——本文件
  //   其余断言零改动，这也是方案承认的合法真实场景（非造假绕过）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  return id;
}

// 模拟 F2b /feasibility 端点写入（F2a 阶段端点未实现，直接改库注入评估/受阻字段）
// [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] 新增 estimated_effort_days 参数（默认 3——非零默认值，
//   同 dev_estimated_at 默认 EST 一惯做法：submit 现要求 feature+nf=1 单必填工期，本 helper 不补默认值的话
//   现有调用点会在 submit 时撞新增的 400 EFFORT_REQUIRED，与本文件测试意图（验证换轮清字段等）无关。
async function fillFeasibility(id, { conclusion = null, requirement_confirm = null, risk = null,
  dev_estimated_at = EST, estimated_effort_days = 3, blocked = 0, blocked_reason = null, blocked_at = null } = {}) {
  await run(`UPDATE sys_issues SET feasibility_conclusion=?, feasibility_requirement_confirm=?, feasibility_risk=?,
                dev_estimated_at=?, estimated_effort_days=?, blocked=?, blocked_reason=?, blocked_at=? WHERE id=?`,
    [conclusion, requirement_confirm, risk, dev_estimated_at, estimated_effort_days, blocked, blocked_reason, blocked_at, id]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  // 建单优化批 C3b（方案 §6c）：主建单端点需求方三字段全空时会 SELECT users.phone 做固化——
  //   users 夹具须含该列，否则撞 SQLITE_ERROR: no such column: phone（本次一并补齐）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer'),(13,'wangtaotao','示例对接人','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ── [A] 建单 needs_feasibility 入库（§4.5 / 开放④建单后锁定）──
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '需评估', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: 1 });
    assert.strictEqual(r.status, 201, '建单 needs_feasibility=1 → 201');
    let d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 1, 'needs_feasibility=1 入库');
    ok('[A1] 建单 needs_feasibility=1（feature）→ 入库 needs_feasibility=1');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '不评估', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    d = await get('SELECT needs_feasibility FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(d.needs_feasibility, 0, '不传默认 needs_feasibility=0');
    ok('[A2] 建单不传 needs_feasibility（feature）→ 默认 0');

    // [A3] L-2（codex 19）：建单传非法 needs_feasibility（非 0/1 真值串）→ 400 INVALID_NEEDS_FEASIBILITY（失败响亮不静默落 0）
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '非法nf', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: 'yes' });
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
    r = await call('POST', `/api/sys-issues/${idC}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 estimate 200, got ' + r.status);
    r = await call('POST', `/api/sys-issues/${idC}/submit`, devTok, { mode: 'no_code', no_code_reason: 'feasibility 测试占位理由', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'needs_feasibility=0 submit 放行, got ' + r.status + ' ' + JSON.stringify(r.body));
    ok('[C1] needs_feasibility=0 → estimate 正常 + submit 放行（新模型不查 feasibility，C3 起恒放行）');

    // ── [D] estimate 封口（needs_feasibility=1，codex 17 M-6）──
    const idD = await seedToDev(1);
    r = await call('POST', `/api/sys-issues/${idD}/estimate`, devTok, { dev_estimated_at: EST });
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
    await fillFeasibility(idF2, { dev_estimated_at: EST, conclusion: '可行', requirement_confirm: '懂了' });
    r = await call('POST', `/api/sys-issues/${idF2}/submit`, devTok, { mode: 'no_code', no_code_reason: 'feasibility 测试占位理由', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'F2 submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    await run(`UPDATE sys_issues SET blocked=1, blocked_reason='x' WHERE id=?`, [idF2]);   // 造受阻残留测 return 清理覆盖
    r = await call('POST', `/api/sys-issues/${idF2}/return`, adminTok, { reason: '列不齐' });
    assert.strictEqual(r.status, 200, 'return 200, got ' + r.status);
    assert.strictEqual(r.body.status, '开发中', 'return → 开发中');
    d = await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, blocked, blocked_reason, dev_estimated_at, estimated_effort_days, return_count FROM sys_issues WHERE id=?', [idF2]);
    assert.strictEqual(d.feasibility_conclusion, null, 'return 清 conclusion');
    assert.strictEqual(d.feasibility_requirement_confirm, null, 'return 清 requirement_confirm');
    assert.strictEqual(d.blocked, 0, 'return 清 blocked');
    assert.strictEqual(d.blocked_reason, null, 'return 清 blocked_reason');
    assert.strictEqual(d.dev_estimated_at, null, 'return 清 dev_estimated_at');
    // [v1.1 §3.2/§8·C2] estimated_effort_days 加入 SYS_CLEAR_FEASIBILITY_FIELDS_SQL 常量本体后，return 应
    // 随评估三字段一并清空（fillFeasibility 已写入 3，此处验证其被换轮清空，非从未写入的伪阳性）。
    assert.strictEqual(d.estimated_effort_days, null, 'return 清 estimated_effort_days（v1.1 §8 新增）');
    assert.strictEqual(d.return_count, 1, 'return_count++ 仍生效（既有逻辑不回归）');
    ok('[F-return] 打回（待验证→开发中）清评估+blocked+dev_est+工期，return_count++ 不回归');

    // F-reopen：开发中→已关闭+填评估 → reopen → 清
    const idF3 = await seedToDev(1, 5);
    await fillFeasibility(idF3, { dev_estimated_at: EST, conclusion: '可行', requirement_confirm: '懂了', blocked: 1, blocked_reason: 'x' });
    await run("UPDATE sys_issues SET status='已关闭', accepted_at='2026-01-01', closed_at='2026-01-02' WHERE id=?", [idF3]);
    r = await call('POST', `/api/sys-issues/${idF3}/reopen`, adminTok, { reason: '回归' });
    assert.strictEqual(r.status, 200, 'reopen 200, got ' + r.status);
    assert.strictEqual(r.body.status, '开发中', 'reopen → 开发中');
    d = await get('SELECT feasibility_conclusion, blocked, blocked_reason, dev_estimated_at, estimated_effort_days, reopen_count FROM sys_issues WHERE id=?', [idF3]);
    assert.strictEqual(d.feasibility_conclusion, null, 'reopen 清 conclusion');
    assert.strictEqual(d.blocked, 0, 'reopen 清 blocked');
    assert.strictEqual(d.blocked_reason, null, 'reopen 清 blocked_reason');
    assert.strictEqual(d.dev_estimated_at, null, 'reopen 清 dev_estimated_at');
    // [v1.1 §3.2/§8·C2] 同 F-return，reopen 也复用 SYS_CLEAR_FEASIBILITY_FIELDS_SQL，一并验证清空。
    assert.strictEqual(d.estimated_effort_days, null, 'reopen 清 estimated_effort_days（v1.1 §8 新增）');
    assert.strictEqual(d.reopen_count, 1, 'reopen_count++ 仍生效（既有逻辑不回归）');
    ok('[F-reopen] 重开（已关闭→开发中）清评估+blocked+dev_est+工期，reopen_count++ 不回归');

    // ── [FC] 源码断言锁调用点（工期对接测试与风险等级拆分 方案 v1.1 §3.2/§8·C2/C4；C0 矩阵验证清单 §F-5）──
    //   SYS_CLEAR_FEASIBILITY_FIELDS_SQL 常量本体已含 estimated_effort_days，本组锁定其消费点数，防未来
    //   新增 ADMIN_TRANSITION 分支忘记复用本常量（各自另起 SQL 片段导致工期字段清空口径与评估三字段/
    //   blocked 三件套不同步漂移）——同本文件 verify-sys-pre-discuss.js 的"源码存在性哨兵"写法：直接读
    //   index.js 源码文本断言引用次数，非仅靠行为断言（那类断言只能证明"现有几处生效"，证明不了"没有
    //   遗漏没复用常量的手写清空"）。
    //   [方案 v1.1 §3.1b·C4 收口] 消费点从 2 处（return/reopen）增至 **3 处**——liaison_test_return 新增
    //   引用（C0 §F-5 登记项："SYS_CLEAR_FEASIBILITY_FIELDS_SQL 现两调用点...liaison_test_return 新 case
    //   引用+源码断言锁调用点"），本条随 C4 落地同批更新为 3。
    {
      const fs2 = require('fs');
      const path2 = require('path');
      const src = fs2.readFileSync(path2.join(__dirname, '../routes/sys-iteration/index.js'), 'utf8');
      const constDeclMatch = src.match(/const SYS_CLEAR_FEASIBILITY_FIELDS_SQL = \[([\s\S]*?)\];/);
      assert.ok(constDeclMatch, '[FC] 源码应能定位 SYS_CLEAR_FEASIBILITY_FIELDS_SQL 常量声明');
      assert.ok(/estimated_effort_days\s*=\s*NULL/.test(constDeclMatch[1]),
        '[FC] SYS_CLEAR_FEASIBILITY_FIELDS_SQL 常量体应含 estimated_effort_days = NULL（v1.1 §8 新增）');
      const usageMatches = src.match(/\.\.\.SYS_CLEAR_FEASIBILITY_FIELDS_SQL/g) || [];
      assert.strictEqual(usageMatches.length, 3,
        `[FC] SYS_CLEAR_FEASIBILITY_FIELDS_SQL 消费点应恰 3 处（return/reopen/liaison_test_return，C4 新增第 3 处），实际 ${usageMatches.length} 处——新增/减少均需回头核实工期清空口径是否随之同步`);
      ok('[FC] 源码断言锁调用点：SYS_CLEAR_FEASIBILITY_FIELDS_SQL 常量体含 estimated_effort_days=NULL + 消费点恰 3 处（return/reopen/liaison_test_return，C4 新增），防第 4 处遗漏复用（C0 §F-5）');
    }

    // ── [G] 防御性死代码注记（H-1 + 建单 FEASIBILITY_NOT_APPLICABLE，ultracode 对抗审补全）──
    //   两处为 bug/config 流预埋、F2a 内不可达、无法端到端测：
    //   ① submit 闸门 type 过滤（['feature','improvement'].includes + needs_feasibility=1）——bug/config 无 submit transition，
    //      findTransition 返 null，请求在到达闸门前 409，故 type 过滤分支 bug/config 侧不可达。
    //   ② 建单 FEASIBILITY_NOT_APPLICABLE（非 feature/improvement 传 needs_feasibility=1 拒）——config/bug 建单先被 TYPE_NOT_SUPPORTED 拦，到不了该守卫。
    //   两处 type 维度断言待 bug/config 流追加（C 系列后续）补端到端；needs_feasibility 维度已由 [B]/[C] 全覆盖。
    ok('[G] H-1 submit type 过滤 + 建单 FEASIBILITY_NOT_APPLICABLE 均为防御性死代码（无 bug/config 流不可达）；needs_feasibility 维度 [A]/[C] 已覆盖');

    // [284 号 B4] 补齐上方注释标记的历史缺口——「两处 type 维度断言待 bug/config 流追加（C 系列后续）
    //   补端到端」此前从未真正落地。C2 已实现"bug 无工期"（/feasibility 端点 type 检查早于
    //   needs_feasibility/字段级校验，见 index.js :6854 一带），但此前从未有测试真调用过该端点验证——
    //   只靠"bug 单结构上到不了这里"的推导代替了实测。这里直接 raw SQL 构造一张 needs_feasibility=1
    //   的 bug 单（绕过建单时的 TYPE_NOT_SUPPORTED 早期拦截，模拟"万一有脏数据/未来某条口子松动"场景），
    //   真调用 /feasibility 端点携带 estimated_effort_days，验证类型闸门在字段闸门之前生效 + 零副作用。
    {
      const rBug = await run(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, assigned_at, needs_feasibility)
         VALUES ('bug', '处理中', 'B4-bug无工期', 'BMS', '内部', 1, '管理员', datetime('now','localtime'), 1)`
      );
      const bugId = rBug.lastID;
      const rFeasBug = await call('POST', `/api/sys-issues/${bugId}/feasibility`, devTok,
        { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: futureEst(30), estimated_effort_days: 5 });
      assert.strictEqual(rFeasBug.status, 409, `[G-bug] bug 单调 /feasibility 应 409，实际 ${rFeasBug.status} ${JSON.stringify(rFeasBug.body)}`);
      assert.strictEqual(rFeasBug.body.code, 'FEASIBILITY_NOT_APPLICABLE', '[G-bug] 错误码 FEASIBILITY_NOT_APPLICABLE（类型闸门先于字段闸门）');
      const rowBug = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [bugId]);
      assert.strictEqual(rowBug.estimated_effort_days, null, '[G-bug] ⭐ 284 号 B4：bug 单 estimated_effort_days 零副作用，仍 NULL（未被半写入）');
      ok('[G-bug] 284 号 B4 补齐：bug 单真调 /feasibility 端点（此前仅靠"结构不可达"推导，未实测）→ 409 FEASIBILITY_NOT_APPLICABLE + estimated_effort_days 保持 NULL（type 闸门先于字段闸门生效，历史缺口补齐）');
    }

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
