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
  assert.strictEqual(r.status, 200, 'assign 200');
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本文件测 feasibility/blocked/unblock
  //   端点机制与 F2a+F2b 闭环，与「待对接测试」段无关（后者由专门的 verify-sys-liaison-test.js 覆盖）。
  //   让对接人在 GATE 判定时失效（模拟受理人后续停用/移出白名单），触发 §3.0-⑥ 降级路径，使 submit
  //   仍直落"待验证"——本文件其余断言零改动，这也是方案承认的合法真实场景（非造假绕过）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  // [组A·2026-08-12] intake-accept 现会按默认 SLA 自动生成 dev_estimated_at（受理时刻通常远未超时，
  //   走"为空×SLA未超"分支）——本文件测的是 /feasibility、/estimate 等端点自身对 dev_estimated_at
  //   的写入/校验语义，需要一个干净的 null 基线才测得出"这些端点自己写了什么"，故 fixture 收尾显式
  //   清空（Group A 自身的自动生成行为由 verify-sys-eta-generation.js 专门覆盖，不在本文件重复验证）。
  // [组A·HIGH-1 登记] 本清空模拟的"第 1 轮受理刚完成、尚未回填任何 ETA"这一状态，在生产真实链路下
  //   已不可达（新受理单受理即自动生成，第 1 轮 dev_estimated_at 恒非空——部署前已在 DEV 族且 ETA
  //   为空的存量单不适用，那些单没有"受理"这一步可触发自动生成）——本文件的 null 基线断言实际只覆盖
  //   "return/reopen 清空后的第 2 轮"语义，与生产第 1 轮的 GATE 恒满足新行为不冲突（该新行为见
  //   verify-sys-eta-generation.js [H1] 成对断言）。
  await run(`UPDATE sys_issues SET dev_estimated_at = NULL WHERE id = ?`, [id]);
  return id;
}
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

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
    // ── [F] feasibility 端点 ──
    const idF = await seedToDev(1);
    // F1 正常填（可行 + 需求理解，无需 risk）
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] feature+nf=1 起工期必填，F1 起全部改走成功路径的调用
    // 补传 estimated_effort_days（下同，凡本文件里期望 200/继续往下走的 feasibility 调用均需补）。
    let r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已理解需求', dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 200, 'feasibility 可行 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    let d = await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk, dev_estimated_at, estimated_effort_days, status FROM sys_issues WHERE id=?', [idF]);
    assert.strictEqual(d.feasibility_conclusion, '可行', 'conclusion 写入');
    assert.strictEqual(d.feasibility_requirement_confirm, '已理解需求', 'requirement_confirm 写入');
    // 时间格式统一 S3（D4）：库内到秒——提交分钟级、后端补 ':00'（同 verify-sys-flow 的口径）
    assert.strictEqual(d.dev_estimated_at, EST + ':00', 'dev_estimated_at 一并写入（D4：补秒到 HH:MM:00）');
    // [v1.1 §3.2·C2] estimated_effort_days 一并写入
    assert.strictEqual(d.estimated_effort_days, 3, 'estimated_effort_days 一并写入（v1.1 §3.2）');
    assert.strictEqual(d.status, '开发中', 'feasibility 不改 status');
    ok('[F1] feasibility 可行+需求理解+工期 → 200，评估字段+dev_estimated_at+estimated_effort_days 写入，status 不变');
    // feasibility timeline 快照
    const fbEv = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility' ORDER BY id DESC LIMIT 1`, [idF]);
    assert.ok(fbEv && /结论：可行/.test(fbEv.summary), 'feasibility timeline 快照含结论');
    // [v1.1 §3.2·C2] 快照含工期文本
    assert.ok(fbEv && /工期：3人日/.test(fbEv.summary), 'feasibility timeline 快照含工期（v1.1 §3.2 快照扩展）');
    ok('[F2] feasibility timeline 快照写入（含结论/需求理解/风险/预计完成/工期）');
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
    // F6 不可行 + risk → 200 + not_feasible（[v1.1 §3.2] 工期必填不因结论「不可行」豁免——方案逐字
    //   "必填=仅 nf=1 的 feature"未对结论值做例外，字面执行，不自行推测"不可行就不用填工期"）
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '不可行', requirement_confirm: 'x', risk: '技术不支持', dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 200, '不可行 200'); assert.strictEqual(r.body.not_feasible, true, 'not_feasible=true');
    ok('[F6] 不可行 + 风险 + 工期 → 200 not_feasible=true（不阻断本动作，阻断在 submit；工期必填不因不可行豁免，v1.1 §3.2 字面口径）');
    // F7 非本人（C3：W06 ownerGuard→assertDevMember，非在册 → 403 NOT_ROSTERED，非旧 NOT_AUTHORIZED_FOR_TRANSITION）
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, dev2Tok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '非本人 403'); assert.strictEqual(r.body.code, 'NOT_ROSTERED');
    ok('[F7] 非在册开发（dev6）→ 403 NOT_ROSTERED（C3 assertDevMember 严格在册）');
    // F8 needs_feasibility=0 单
    const idF0 = await seedToDev(0);
    r = await call('POST', `/api/sys-issues/${idF0}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, 'needs_feasibility=0 → 409'); assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_REQUIRED');
    ok('[F8] needs_feasibility=0 单填评估 → 409 FEASIBILITY_NOT_REQUIRED');
    // F9 非开发态填评估仍应拒 → 409 FEASIBILITY_STATUS_INVALID
    // ⭐⭐ [C8-fix2 H·夹具订正] 原夹具用的是"刚建单、从未指派"的待指派单 + dev5。C8-fix2 把 assertDevMember
    //   提到状态闸**之前**后，那个单据上 dev5 **根本不在册**（从未 assign ⇒ 无 roster 行），于是先撞 403
    //   NOT_ROSTERED——本条实测由 409 变 403。诊断：**实现按 316-C 表态一正确重排，是夹具把两个变量（"非开发态"
    //   与"非在册"）混在了一条用例里**，它此前能测到状态闸纯粹因为鉴权排在状态闸后面。
    //   订正=把"在册"这个前提补上，让本条只剩"状态不对"一个变量：seedToDev 拿到在册的 dev5 + 开发中，
    //   再直连 SQL 把状态推到非 W06 白名单态（'待验证'，见 status-families.js:197 feasibility 仅 from=['开发中']）。
    const idF9 = await seedToDev(1);
    await run(`UPDATE sys_issues SET status = '待验证' WHERE id = ?`, [idF9]);
    r = await call('POST', `/api/sys-issues/${idF9}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 409, '[F9] 在册成员 + 非开发态 → 409, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'FEASIBILITY_STATUS_INVALID', '[F9] 确切码 FEASIBILITY_STATUS_INVALID，实得 ' + r.body.code);
    ok('[F9] **在册成员** + 非开发态（待验证）填评估 → 409 FEASIBILITY_STATUS_INVALID（夹具补上"在册"前提，使本条只测状态闸这一个变量）');
    // F9b ⭐ [C8-fix2 H 新行为] 同一形态但**非在册**（从未指派的待指派单）→ 现在先撞鉴权，恒 403 NOT_ROSTERED。
    //   这正是本次重排要的效果：未授权者不再能从「409 状态码」里读出"这单存在且是 nf=1 的变更类"。
    let rr = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '待指派', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: 1 });
    r = await call('POST', `/api/sys-issues/${rr.body.id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '[F9b] 非在册 + 非开发态 → 403（鉴权先于状态闸）, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'NOT_ROSTERED', '[F9b] 确切码 NOT_ROSTERED，实得 ' + r.body.code);
    ok('[F9b] ⭐ [C8-fix2 H] 非在册 + 非开发态 → 403 NOT_ROSTERED（**鉴权先于状态闸**·重排前此处报 409 FEASIBILITY_STATUS_INVALID，等于把单据存在性与属性漏给未授权者）');
    // F10 早于 assigned_at（补 estimated_effort_days，否则会先撞新增的 EFFORT_REQUIRED 而非本测试要测的
    //   ESTIMATE_BEFORE_ASSIGN——EFFORT_REQUIRED 检查在 assigned_at 校验之前，v1.1 §3.2 C2 新增顺序）
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: '2020-01-01 10:00', estimated_effort_days: 3 });
    assert.strictEqual(r.body.code, 'ESTIMATE_BEFORE_ASSIGN', 'got ' + (r.body && r.body.code));
    ok('[F10] dev_estimated_at 早于 assigned_at → 400 ESTIMATE_BEFORE_ASSIGN');

    // ── [EF] 工期字段正反例（工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2）：与 DDL CHECK 同口径
    //   （有限数、0<v≤365、0.5 整数倍）；错误码统一 INVALID_EFFORT_DAYS（normalizeSysEffortDays）──
    const idEF = await seedToDev(1);
    // EF1 边界值 0（拒，下界不含 0）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 0 });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=0 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF1] estimated_effort_days=0 → 400 INVALID_EFFORT_DAYS（下界不含 0）');
    // EF2 边界值 366（拒，超上界 365）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 366 });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=366 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF2] estimated_effort_days=366 → 400 INVALID_EFFORT_DAYS（超上界 365）');
    // EF3 非 0.5 整数倍
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 1.3 });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=1.3 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF3] estimated_effort_days=1.3（非 0.5 整数倍）→ 400 INVALID_EFFORT_DAYS');
    // EF4 非数字字符串
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 'abc' });
    assert.strictEqual(r.status, 400, 'estimated_effort_days="abc" 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF4] estimated_effort_days="abc"（非数字）→ 400 INVALID_EFFORT_DAYS');
    // EF5 边界值 0.5（下界，合法）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 0.5 });
    assert.strictEqual(r.status, 200, 'estimated_effort_days=0.5 应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    d = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [idEF]);
    assert.strictEqual(d.estimated_effort_days, 0.5, '0.5 应原样落库');
    ok('[EF5] estimated_effort_days=0.5（下界）→ 200，原样落库');
    // EF6 边界值上界 365 + 字符串数字归一化（"365"）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: '365' });
    assert.strictEqual(r.status, 200, 'estimated_effort_days="365"（字符串数字）应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    d = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [idEF]);
    assert.strictEqual(d.estimated_effort_days, 365, '字符串"365"归一化为数字 365 落库（上界同时验证）');
    ok('[EF6] estimated_effort_days="365"（字符串数字，上界 365）→ 200，归一化为数字落库');
    // EF7【C7 语义反转·断言随实现同步改判，非实现错】improvement+nf=1 **必填**：不传 estimated_effort_days
    //   → 400 EFFORT_REQUIRED，与 feature 完全同构。
    //   原断言（C2 口径）是"improvement 选填 → 200 且落 NULL"，C7 工时评估补全按方案 v1.7 §9.1 把工期必填面
    //   从 feature-only 扩到 feature+improvement（对齐 risk_level 批1改造B 的同款扩围，两个字段自此在变更类
    //   单据上口径一致）。本组由此从"必填 vs 选填对照组"翻转为"两类型同构组"——**旧断言不是被绕过，是它
    //   描述的业务口径已被用户拍板废止**，故整组连注释重写而非注掉了事。
    let rImp = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'improvement', title: 'imp-ef', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: 1 });
    assert.strictEqual(rImp.status, 201, 'improvement 建单 201, got ' + rImp.status);
    const idImp = rImp.body.id;
    // ⭐ 用户拍板批1改造B：improvement 受理必填 risk_level（原为空 body，此前该调用返回未检查·静默 400
    //   导致单据卡在「待受理」，下游 set-oa-number/assign/feasibility 三连锁式失败——本次一并补上返回值
    //   检查，防同类"调用未检查状态码"的坑再次隐藏真实失败）。
    const accImp = await call('POST', `/api/sys-issues/${idImp}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(accImp.status, 200, `EF7 前置：improvement 受理应 200，实得 ${accImp.status} ${JSON.stringify(accImp.body)}`);
    await call('POST', `/api/sys-issues/${idImp}/set-oa-number`, adminTok, { oa_number: '2026070099' });
    await call('POST', `/api/sys-issues/${idImp}/assign`, adminTok, { assigned_to: 5 });
    // [组A·2026-08-12] 同 seedToDev 处已注：intake-accept 现会自动生成 dev_estimated_at，本组断言的是
    //   "EFFORT_REQUIRED 拒绝零副作用（含 dev_estimated_at 未落库）"，需要干净 null 基线才测得出，故清空。
    // [组A·HIGH-1 登记] 生产第 1 轮已不可达（新受理单受理即自动生成，恒非空——部署前已在 DEV 族且
    //   ETA 为空的存量单不适用，那些单没有"受理"这一步可触发自动生成），本清空只模拟"return/reopen
    //   清空后的第 2 轮"状态，断言只覆盖第 2 轮语义（第 1 轮 GATE 恒满足新行为见 verify-sys-eta-generation.js [H1]）。
    await run(`UPDATE sys_issues SET dev_estimated_at = NULL WHERE id = ?`, [idImp]);
    r = await call('POST', `/api/sys-issues/${idImp}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 400, 'C7：improvement 不传工期应 400（已改必填）, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `C7：improvement 缺工期确切码应为 EFFORT_REQUIRED（与 feature 同码），实得 ${r.body && r.body.code}`);
    d = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [idImp]);
    assert.strictEqual(d.estimated_effort_days, null, 'C7：400 被拒后零副作用——工期列仍 NULL（整个 feasibility 事务应回滚，不留半份评估）');
    const dImpFeas = await get('SELECT feasibility_conclusion, dev_estimated_at FROM sys_issues WHERE id=?', [idImp]);
    assert.strictEqual(dImpFeas.feasibility_conclusion, null, 'C7：400 被拒后零副作用——评估结论未落库（证明 EFFORT_REQUIRED 是在写入前拦下的，不是写完再报错）');
    assert.strictEqual(dImpFeas.dev_estimated_at, null, 'C7：400 被拒后零副作用——预计完成时间未落库');
    // 补齐正例：同一张单补上工期后应放行并落库，证明拦截可解除（防"只测拦得住、没测填了能过"的半向验证）
    r = await call('POST', `/api/sys-issues/${idImp}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 2.5 });
    assert.strictEqual(r.status, 200, 'C7：improvement 补上工期后应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    d = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [idImp]);
    assert.strictEqual(d.estimated_effort_days, 2.5, 'C7：improvement 工期 2.5 归一化后落库');
    ok('[EF7·C7 反转] improvement+nf=1 工期**必填**：不传 → 400 EFFORT_REQUIRED + 三项零副作用断言（工期/结论/预计完成均未落库）；补填 2.5 → 200 且落库——与 EF1-6 的 feature 完全同构（C2 的"improvement 选填"口径已废止）');

    // ── [codex 269 号 M-2] normalizeSysEffortDays 类型收紧补用例——裸 Number(raw) 会把布尔/单元素数组/
    //   十六进制字符串都静默转成合法数字，这批用例专门锁死"仅接受 number 或纯十进制格式字符串"这条收窄。
    // EF8 布尔值 true（Number(true)===1，此前会被误判合法）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: true });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=true 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF8] estimated_effort_days=true（布尔）→ 400 INVALID_EFFORT_DAYS（M-2：Number(true)===1 此前会误判合法）');
    // EF9 单元素数组 [1]（Number([1])===1，此前会被误判合法）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: [1] });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=[1] 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF9] estimated_effort_days=[1]（数组）→ 400 INVALID_EFFORT_DAYS（M-2：Number([1])===1 此前会误判合法）');
    // EF10 十六进制字符串 '0x10'（Number('0x10')===16，此前会被误判合法）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: '0x10' });
    assert.strictEqual(r.status, 400, `estimated_effort_days="0x10" 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF10] estimated_effort_days="0x10"（十六进制字符串）→ 400 INVALID_EFFORT_DAYS（M-2：Number("0x10")===16 此前会误判合法）');
    // EF11 纯空白字符串 '  '（trim 后按未填处理，与前端"留空不传"语义一致——feature 必填故报 EFFORT_REQUIRED，
    //   非 INVALID_EFFORT_DAYS，因为这不是"格式错"而是"等同没填"）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: '   ' });
    assert.strictEqual(r.status, 400, `estimated_effort_days="   " 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `got ${r.body && r.body.code}（纯空白应归一为未填=null，feature 必填触发 EFFORT_REQUIRED，非格式错误码）`);
    ok('[EF11] estimated_effort_days="   "（纯空白）→ 400 EFFORT_REQUIRED（trim 后按未填处理，非 INVALID_EFFORT_DAYS）');
    // EF12 科学计数法字符串 '5e-1'（=0.5，但业务场景无此写法，从严拒绝）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: '5e-1' });
    assert.strictEqual(r.status, 400, `estimated_effort_days="5e-1" 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF12] estimated_effort_days="5e-1"（科学计数法字符串）→ 400 INVALID_EFFORT_DAYS（M-2：从严拒绝，人日场景无此写法）');
    // EF13 数字 365.5（格式合法但超上界——0.5 整数倍成立，但 >365，走边界检查而非格式检查）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 365.5 });
    assert.strictEqual(r.status, 400, 'estimated_effort_days=365.5 应 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF13] estimated_effort_days=365.5（0.5 整数倍成立但超上界 365）→ 400 INVALID_EFFORT_DAYS');
    // EF14 字符串 'Infinity'（JS Number('Infinity')===Infinity，被 typeof number 分支的 isFinite 挡，
    //   本次改走字符串正则分支直接格式不匹配拒绝——殊途同归，仍是 INVALID_EFFORT_DAYS）
    r = await call('POST', `/api/sys-issues/${idEF}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 'Infinity' });
    assert.strictEqual(r.status, 400, `estimated_effort_days="Infinity" 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', 'got ' + (r.body && r.body.code));
    ok('[EF14] estimated_effort_days="Infinity"（字符串）→ 400 INVALID_EFFORT_DAYS（正则格式不匹配直接拒，不落入 isFinite 判断）');

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
    await call('POST', `/api/sys-issues/${idHV1}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    await call('POST', `/api/sys-issues/${idHV1}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）', self_tested: true, test_env_deployed: true });   // → 待验证
    r = await call('POST', `/api/sys-issues/${idHV1}/blocked`, devTok, { reason: '待验证标受阻' });
    assert.strictEqual(r.status, 409, '待验证标受阻 409'); assert.strictEqual(r.body.code, 'BLOCKED_STATUS_INVALID');
    ok('[BL7] 待验证态标受阻 → 409 BLOCKED_STATUS_INVALID（仅开发中可受阻）');
    // BL8 ⭐ hold 清 blocked + 留评估：受阻单暂缓 → blocked 三件套归零、评估保留（§⑥ 不动原评估）+ resume 回开发中不卡死
    const idHV2 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idHV2}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已评估', dev_estimated_at: EST, estimated_effort_days: 3 });
    await call('POST', `/api/sys-issues/${idHV2}/blocked`, devTok, { reason: '阻塞' });
    r = await call('POST', `/api/sys-issues/${idHV2}/hold`, adminTok, { reason: '暂缓' });
    assert.strictEqual(r.status, 200, 'hold 200'); assert.strictEqual(r.body.status, '已暂缓', 'hold → 已暂缓');
    d = await get('SELECT blocked, blocked_reason, blocked_at, feasibility_conclusion FROM sys_issues WHERE id=?', [idHV2]);
    assert.strictEqual(d.blocked, 0, 'hold 清 blocked=0'); assert.strictEqual(d.blocked_reason, null, 'hold 清 blocked_reason'); assert.strictEqual(d.blocked_at, null, 'hold 清 blocked_at');
    assert.strictEqual(d.feasibility_conclusion, '可行', '⭐ hold 不动评估（§⑥ 留作问责对照，只清 blocked 非换轮）');
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    r = await call('POST', `/api/sys-issues/${idHV2}/resume`, adminTok, { reason: '验证暂缓后恢复到开发中不残留受阻' });
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

    // ── [BL-NR] ⭐⭐ [C7-fix3 补批 ①②·/blocked 防探知矩阵] 非在册 × 五形态 → 恒 403 NOT_ROSTERED ──
    //   本端点是 W06 族**第三个**同款侧漏（前两个：/feasibility C8-fix2 H、/estimate C7-fix3 H），
    //   由「按模式而非名单」的普查判定表抓出（[[feedback_pattern_sweep_not_symptom_list]]）。
    //   ⭐ 侧漏面**以修前/修后对照探针实测为准**（非推断）——重排前 assertDevMember 位于
    //     BLOCKED_NOT_APPLICABLE / BLOCKED_STATUS_INVALID **之后**、ISSUE_ALREADY_BLOCKED **之前**，故：
    //       · bug 单   → 409 BLOCKED_NOT_APPLICABLE  ← 泄露 type
    //       · nf=0 单  → 409 BLOCKED_NOT_APPLICABLE  ← 泄露 needs_feasibility
    //       · 状态不对 → 409 BLOCKED_STATUS_INVALID  ← 泄露状态，且**文案里直接带着状态名**
    //                    （实测原文：「当前状态「待验证」不可标记受阻」）
    //       · 已受阻   → 403 NOT_ROSTERED  ← **修前就没漏**（该闸本就排在鉴权之后）
    //       · 全合法   → 403 NOT_ROSTERED  ← 修前即 403
    //     即真实泄露面是**前三格**，不是"五格全漏"。后两格保留在本组里作**回归看守**（证明重排没把
    //     原本就正确的两格改坏），不充当"本次修好了什么"的证据。
    //   重排后：五种形态一律 403 NOT_ROSTERED。
    //   ⚠️ 逐形态断**确切码**——只断 403 的话，中间件层的别的 403 也能让它绿。
    {
      const BL_NR_BODY = { reason: 'C7-fix3 补批：非在册探针' };
      const snapBL = async (iid) => ({
        row: await get('SELECT blocked, blocked_reason, blocked_at, status FROM sys_issues WHERE id=?', [iid]),
        tl: Number((await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [iid])).c)
      });
      // 五形态：bug 单 / nf=0 单 / 状态不对 / 已受阻 / 全合法（后者=重排前唯一已经 403 的那格）
      const idNrBug = await seedToDev(1);
      // ⚠️ type 与 status 必须**成对**改：assertKnownIssueStatus（排在鉴权之前，属"数据完整性自检"层）会拒绝
      //   「bug + 开发中」这种族外组合并抛 409 GATE_INVARIANT——首版只改 type 不改 status，实测撞到该异常，
      //   属**夹具造了一张现实中不存在的脏单**，不是实现错。bug 流的开发态是「处理中」。
      await run(`UPDATE sys_issues SET type='bug', status='处理中' WHERE id=?`, [idNrBug]);
      const idNrNf0 = await seedToDev(0);
      const idNrBadStatus = await seedToDev(1);
      await run(`UPDATE sys_issues SET status='待验证' WHERE id=?`, [idNrBadStatus]);
      const idNrBlocked = await seedToDev(1);
      let rb = await call('POST', `/api/sys-issues/${idNrBlocked}/blocked`, devTok, { reason: '先由在册开发标记受阻' });
      assert.strictEqual(rb.status, 200, `[BL-NR 前置] 在册 dev 标记受阻应 200, got ${rb.status} ${JSON.stringify(rb.body)}`);
      const idNrOk = await seedToDev(1);

      for (const [label, iid, leakCode] of [
        ['bug 单', idNrBug, 'BLOCKED_NOT_APPLICABLE（修前实测：泄露 type）'],
        ['nf=0 单', idNrNf0, 'BLOCKED_NOT_APPLICABLE（修前实测：泄露 needs_feasibility）'],
        ['状态不对', idNrBadStatus, 'BLOCKED_STATUS_INVALID（修前实测：泄露状态，文案带状态名）'],
        ['已受阻', idNrBlocked, '任何 409（本格**修前即 403**，此处为回归看守而非修复证据）'],
        ['全合法', idNrOk, '任何 409（本格修前即 403，回归看守）']
      ]) {
        const before = await snapBL(iid);
        const r2 = await call('POST', `/api/sys-issues/${iid}/blocked`, dev2Tok, BL_NR_BODY);
        assert.strictEqual(r2.status, 403, `[BL-NR-${label}] 非在册期望 403, got ${r2.status} ${JSON.stringify(r2.body)}`);
        assert.strictEqual(r2.body.code, 'NOT_ROSTERED',
          `[BL-NR-${label}] ⭐ 确切码必须是 NOT_ROSTERED，而不是 ${leakCode}，实得 ${r2.body.code}`);
        // 零副作用四查
        const after = await snapBL(iid);
        assert.strictEqual(after.row.blocked, before.row.blocked, `[BL-NR-${label}] 零副作用：blocked 未变`);
        assert.strictEqual(after.row.blocked_reason, before.row.blocked_reason, `[BL-NR-${label}] 零副作用：blocked_reason 未被写入`);
        assert.strictEqual(after.row.blocked_at, before.row.blocked_at, `[BL-NR-${label}] 零副作用：blocked_at 未被写入`);
        assert.strictEqual(after.row.status, before.row.status, `[BL-NR-${label}] 零副作用：状态未变`);
        assert.strictEqual(after.tl, before.tl, `[BL-NR-${label}] 零副作用：timeline 零新增`);
      }
      ok('[BL-NR] ⭐⭐ [C7-fix3 补批] /blocked 非在册 × 五形态（bug/nf=0/状态不对/已受阻/全合法）→ **恒 403 NOT_ROSTERED** + 逐形态零副作用五查——修前/修后对照探针实测：前三格原本分别回 BLOCKED_NOT_APPLICABLE×2 与 BLOCKED_STATUS_INVALID（后者文案里带状态名），后两格原本即 403（保留作回归看守）');

      // 配对正例（双向证明：403 只对非在册者生效，三道闸本身逐字未改坏）
      let rp = await call('POST', `/api/sys-issues/${idNrBadStatus}/blocked`, devTok, BL_NR_BODY);
      assert.strictEqual(rp.status, 409, `[BL-NR 配对①] 在册 + 状态不对应 409, got ${rp.status} ${JSON.stringify(rp.body)}`);
      assert.strictEqual(rp.body.code, 'BLOCKED_STATUS_INVALID', `[BL-NR 配对①] 确切码 BLOCKED_STATUS_INVALID，实得 ${rp.body.code}`);
      rp = await call('POST', `/api/sys-issues/${idNrBug}/blocked`, devTok, BL_NR_BODY);
      assert.strictEqual(rp.status, 409, `[BL-NR 配对②] 在册 + bug 单应 409, got ${rp.status} ${JSON.stringify(rp.body)}`);
      assert.strictEqual(rp.body.code, 'BLOCKED_NOT_APPLICABLE', `[BL-NR 配对②] 确切码 BLOCKED_NOT_APPLICABLE，实得 ${rp.body.code}`);
      rp = await call('POST', `/api/sys-issues/${idNrBlocked}/blocked`, devTok, BL_NR_BODY);
      assert.strictEqual(rp.status, 409, `[BL-NR 配对③] 在册 + 已受阻应 409, got ${rp.status} ${JSON.stringify(rp.body)}`);
      assert.strictEqual(rp.body.code, 'ISSUE_ALREADY_BLOCKED', `[BL-NR 配对③] 确切码 ISSUE_ALREADY_BLOCKED，实得 ${rp.body.code}`);
      ok('[BL-NR 配对] ⭐ 双向证明：**在册** dev 打同三张单仍分别拿到 BLOCKED_STATUS_INVALID / BLOCKED_NOT_APPLICABLE / ISSUE_ALREADY_BLOCKED——三道闸相对序与错误码逐字未变，403 只对非在册者生效（非"dev2 恒被拒"的单向观察）');
    }

    // ── [E2E] F2a 闸门 + F2b 端点真实联动闭环 ⭐ ──
    // E1 建单评估→submit 放行（真实链路，验证 F2a 闸门读 F2b 写入）
    const idE1 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE1}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    r = await call('POST', `/api/sys-issues/${idE1}/submit`, devTok, { mode: 'no_code', no_code_reason: '功能完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'E1 submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', 'E1 → 待验证（main_status 字段，C2/C3 惯例）');
    ok('[E2E-1] ⭐ 建单(评估)→assign→feasibility(可行)→submit 放行 200 待验证（F2a 闸门 + F2b 端点真实联动，非 DB 模拟）');
    // [codex 98 号 HIGH 回填] E2/E3：blocked/feasibility 闸门已在新 submit handler 内逐条复刻恢复
    //   （routes/sys-iteration/index.js 「[codex 98 号 HIGH 回填] submit 资格不变量」注释块，对照 e39e65b
    //   版旧 case 'submit' 逐条照搬判定与错误码），本轮改回真实路由断言，替代上一轮"如实记录现状"的临时降级。
    const idE2 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE2}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    await call('POST', `/api/sys-issues/${idE2}/blocked`, devTok, { reason: '阻塞中' });
    r = await call('POST', `/api/sys-issues/${idE2}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'E2 受阻 submit 拒, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'ISSUE_BLOCKED', 'E2 受阻 submit 拒 code=ISSUE_BLOCKED');
    await call('POST', `/api/sys-issues/${idE2}/unblock`, adminTok, { reason: '解除' });
    r = await call('POST', `/api/sys-issues/${idE2}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'E2 解除后 submit 200');
    assert.strictEqual(r.body.main_status, '待验证', 'E2 解除后 submit → 待验证');
    ok('[E2E-2] ⭐ 受阻闭环：feasibility→blocked→submit 拒 400 ISSUE_BLOCKED→unblock→submit 放行（真实路由，闸门已恢复）');
    const idE3 = await seedToDev(1);
    await call('POST', `/api/sys-issues/${idE3}/feasibility`, devTok, { conclusion: '不可行', requirement_confirm: '确认', risk: '做不了', dev_estimated_at: EST, estimated_effort_days: 3 });
    r = await call('POST', `/api/sys-issues/${idE3}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）', self_tested: true, test_env_deployed: true });
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
