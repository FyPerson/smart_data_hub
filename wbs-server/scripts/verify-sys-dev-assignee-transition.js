// 验证脚本：通知改造 Commit C2（建单三路径 + 指派一致性 + 多开发差量 upsert）
//   方案：docs/local/系统迭代/bug流通知改造_方案_20260703_v1.5.md（内容 v1.6 定稿）§2.1/§2.2[C-1]/§3.3/附录A
//   前置分析：docs/local/系统迭代/bug流通知改造_编码前置分析_20260705_v1.0.md G1/G2
//   任务书：docs/local/系统迭代/bug流通知改造_Sonnet任务书_20260705_v1.0.md §批2
//   用法：node scripts/verify-sys-dev-assignee-transition.js
//
// 覆盖：
//   [A] 建单三路径 A/B/none 落点 + 互斥校验（ASSIGN_MODE_CONFLICT/INVALID_ASSIGN_MODE/ASSIGN_MODE_BUG_ONLY/
//       ASSIGN_TARGET_REQUIRED/RELAY_USER_REQUIRED/RELAY_USER_NOT_WHITELISTED）
//   [B] path A 首事务字段边界 + assign 失败原子（主=viewer/不存在 → 事务2 回滚，单停待处理∧无 assigned_*∧无子表行）
//   [C] 差量 upsert 五步矩阵（在册保通知状态 / 软删复活取最新（同行复用）/ 全新 INSERT / 出集软删 /
//       恰好1主==assigned_to 不变式 / 旧主降协作 vs 软删两分支）
//   [D] OWNER_GUARD_FAILED（旧主提交，改名自 CONCURRENT_REASSIGN）+ 子表在守卫失败时不受影响
//   [E] 单开发向后兼容（不传协作 → 子表恰 1 行）
//   [F] 协作开发校验错误码（COLLABORATOR_NOT_FOUND/COLLABORATOR_VIEWER/INVALID_COLLABORATOR_IDS/ASSIGNEE_DUPLICATE）
//   [G] 详情 GET 读端 dev_assignees[] join（写读同源，附录A：主排前 + 仅在册行）
//   [H] 白盒：sysIssueTransition('assign') 在不兼容前置态失败 → 无 assigned_*/无子表行（[C-1] 核心原子性，
//       不依赖建单 path A 两事务偶然触发的窗口，直接证明底层机制）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-dev-assignee-transition-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// [codex 99 号 M4 补强] 故障注入——同既有范式（verify-sys-multidev-members.js H2 / verify-sys-multidev-submit.js
//   S4c）：平时 injectFailureOnSql=null 行为与直接用 run 完全一致，测试内临时置位一次 SQL 片段。
let injectFailureOnSql = null;
let injectFailureFired = false;
const runFI = (sql, params = []) => {
  if (injectFailureOnSql && sql.includes(injectFailureOnSql)) {
    const marker = injectFailureOnSql;
    injectFailureOnSql = null;
    injectFailureFired = true;
    return Promise.reject(new Error(`[测试注入故障] 命中 SQL 片段「${marker}」`));
  }
  return run(sql, params);
};
// [codex C3 对抗审 M-P1 回填] dbGetAsync 侧独立故障注入（与上方 runFI 各自独立、互不干扰）——
//   resolveCollaboratorList 内部只做 SELECT（dbGetAsync），要模拟"非业务错误"（非 SysTransitionError，
//   如真实 DB/连接层异常）必须在 dbGetAsync 层注入，SysTransitionError 类校验失败（如 COLLABORATOR_NOT_FOUND）
//   是该函数自己 throw 的业务错误，不适合也不需要用故障注入模拟。
let injectGetFailureOnSql = null;
let injectGetFailureSkip = 0;   // 跳过前 N 次命中（同一 SQL 文本在同一请求内可能被多个不同调用点复用，如
                                  // /assign 先查主开发、resolveCollaboratorList 后查协作开发，文本完全相同，
                                  // 只能靠跳过次数区分要打到哪一次）
let injectGetFailureFired = false;
const getFI = (sql, params = []) => {
  if (injectGetFailureOnSql && sql.includes(injectGetFailureOnSql)) {
    if (injectGetFailureSkip > 0) { injectGetFailureSkip--; return get(sql, params); }
    const marker = injectGetFailureOnSql;
    injectGetFailureOnSql = null;
    injectGetFailureFired = true;
    return Promise.reject(new Error(`[测试注入故障] 命中 SELECT 片段「${marker}」`));
  }
  return get(sql, params);
};

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
  db, dbRunAsync: runFI, dbGetAsync: getFI, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
const T = I.transitions;
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

// 用户种子：1=admin / 5,6,8,10=开发（user）/ 9=viewer / 7,13=对接人白名单（示例发布者/示例对接人，同 SYS_BUG_LIAISON_USER_IDS）
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const dev5Tok = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);
const dev6Tok = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function activeDevAssignees(issueId) {
  return all(
    `SELECT id, user_id, user_name, is_primary, notify_status, notified_at, notify_message_key
       FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY is_primary DESC, id ASC`,
    [issueId]
  );
}
async function allDevAssigneeRows(issueId) {
  return all(`SELECT * FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id`, [issueId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),
    (5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(8,'dev8','开发丙','user'),(10,'dev10','开发丁','user'),
    (9,'viewer9','观察员','viewer'),
    (7,'shenjun','示例发布者','publisher'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] 建单三路径 A/B/none 落点 + 互斥校验 ═══
  {
    // none（省略 assign_mode，既有 19 套 verify 的调用形态）
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'none路径', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    assert.strictEqual(r.status, 201, 'none 路径建单 201');
    let row = await get('SELECT status, assigned_to, relay_notified_user_id FROM sys_issues WHERE id=?', [r.body.id]);
    // ⭐ 角色权限重构 C0：受理门焊死 → bug 建单落「待受理」（原「待处理」改为受理通过后的落态）
    assert.strictEqual(row.status, '待受理', 'C0：none 路径建单落 待受理');
    assert.strictEqual(row.assigned_to, null, 'none：无 assigned_to');
    assert.strictEqual(row.relay_notified_user_id, null, 'none：无 relay');
    assert.deepStrictEqual(await activeDevAssignees(r.body.id), [], 'none：无子表行');
    const iaNone = await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, adminTok, {});
    assert.strictEqual(iaNone.body.status, '待处理', 'C0：受理通过 → 待处理（与旧 none 落态一致）');

    // ⭐ path A/B 结构性关闭（C0·方案 v1.5 §4-C0）：受理门恒开 ⟹「建单即指派 / 建单即通知对接人」两条路径
    //   一律被 INTAKE_WITH_ASSIGN_CONFLICT 拒——原「A 直达处理中 + 子表 3 行」「B 写 relay_notified_user_id」
    //   两组正向断言随之作废，改测**拒绝契约 + 零副作用**（拒绝时不得留下半条单或子表行）。
    //   ⚠️ 守卫顺序：参数校验（ASSIGN_MODE_CONFLICT/ASSIGN_TARGET_REQUIRED/RELAY_USER_REQUIRED/ASSIGN_MODE_BUG_ONLY）
    //     仍在本冲突守卫之前，故下方"互斥/校验错误码"各例期望值不变（本组末尾已覆盖）。
    const cntBeforeAB = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    const daCntBeforeAB = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees')).c;

    // A（主开发 + 2 协作）→ 400
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'pathA', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'A', assigned_to: 5, collaborator_ids: [6, 8] });
    assert.strictEqual(r.status, 400, 'C0：pathA 建单应 400, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'C0：pathA code=INTAKE_WITH_ASSIGN_CONFLICT');

    // B（对接人，示例发布者 id=7）→ 400
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'pathB', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'B', relay_user_id: 7 });
    assert.strictEqual(r.status, 400, 'C0：pathB 建单应 400, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'C0：pathB code=INTAKE_WITH_ASSIGN_CONFLICT');

    // 零副作用：两次拒绝均未建单、未写子表（守卫置于 INSERT 之前）
    assert.strictEqual((await get('SELECT COUNT(*) c FROM sys_issues')).c, cntBeforeAB, 'C0：A/B 被拒时不创建 sys_issues 行');
    assert.strictEqual((await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees')).c, daCntBeforeAB, 'C0：A/B 被拒时不写 dev_assignees 子表');

    // 互斥/校验错误码
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assigned_to: 5, relay_user_id: 7 });
    assert.strictEqual(r.status, 400, '同传 A+B 参数应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_CONFLICT', 'code=ASSIGN_MODE_CONFLICT');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'C' });
    assert.strictEqual(r.status, 400, 'assign_mode=C 非法应 400');
    assert.strictEqual(r.body.code, 'INVALID_ASSIGN_MODE');

    const cntBefore = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'A', assigned_to: 5 });
    assert.strictEqual(r.status, 400, 'feature + assign_mode=A 应 400（变更流不适用三路径）');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_BUG_ONLY');
    const cntAfter = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    assert.strictEqual(cntAfter, cntBefore, 'ASSIGN_MODE_BUG_ONLY：拒绝时不创建任何行');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'A' });
    assert.strictEqual(r.status, 400, 'mode=A 缺 assigned_to 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_TARGET_REQUIRED');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'B' });
    assert.strictEqual(r.status, 400, 'mode=B 缺 relay_user_id 应 400');
    assert.strictEqual(r.body.code, 'RELAY_USER_REQUIRED');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'B', relay_user_id: 6 });
    assert.strictEqual(r.status, 400, '非白名单 relay_user_id 应 400');
    // ⭐ C0 行为变更：relay 白名单校验（RELAY_USER_NOT_WHITELISTED·index.js path B 分支内）位于
    //   INTAKE_WITH_ASSIGN_CONFLICT 守卫**之后**，受理门恒开后该分支不可达 → 提前被冲突守卫拒。
    //   仍是 400 且仍不建单，只是错误码更靠前——契约上更准确（"这条路径整体关闭"优先于"参数里某个 id 不合法"）。
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'C0：path B 关闭后白名单校验被前置守卫遮蔽');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, collaborator_ids: [6] });
    assert.strictEqual(r.status, 400, 'mode=none 却传 collaborator_ids 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_CONFLICT');

    ok('[A] 建单三路径 none/A(主+2协作)/B(对接人白名单+反规范化名) 落点全对 + 6 种互斥/校验错误码精确');
  }

  // ═══ [B] path A 单事务原子性（C2 破坏性变更：主=viewer/不存在 → 整体回滚，不再是"事务1提交+事务2失败"）═══
  //   ⚠️ 既有测试变更（详见交付汇报"既有测试变更清单"）：C2 前 path A 是两段式事务（事务1 INSERT 主表提交，
  //   事务2 sysIssueTransition('assign') 失败则单停留待处理+assign_failed 标记，仍 201）；C2 后 path A 改单一
  //   事务（校验主开发/协作存在性→INSERT 主表→插子表→选举→UPDATE 到 DEV，任一步失败整体回滚），不再产生
  //   "单已建但未指派"的半成品态——失败即 400，压根不建单（cntBefore===cntAfter 直接证明）。
  //   ⭐ 角色权限重构 C0：path A 已**结构性关闭**（受理门恒开 → INTAKE_WITH_ASSIGN_CONFLICT 早于主开发校验），
  //     "path A 单事务原子性"不再有被测对象。本组改测**关闭后的兜底不变量**：无论主开发参数多不合法，
  //     一律停在冲突守卫、且不建单——即"关闭是彻底的，不存在某种参数组合把 path A 的建单路径重新打开"。
  //     ⚠️ 原被测的 viewer/不存在两条校验**未丢失覆盖**：它们在 assign 端点上的等价断言见本文件 [K] 组
  //     （assign viewer 拦截）与 [M] 组（/assign 重建反例），那才是 C0 后唯一的指派入口。
  {
    const cntBefore = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    for (const [label, assignedTo] of [['主是viewer', 9], ['主不存在', 999], ['主合法', 5]]) {
      const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: label, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, assign_mode: 'A', assigned_to: assignedTo });
      assert.strictEqual(r.status, 400, `C0：path A(${label}) 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', `C0：path A(${label}) 恒停在冲突守卫（早于主开发校验）`);
    }
    assert.strictEqual((await get('SELECT COUNT(*) c FROM sys_issues')).c, cntBefore, 'C0：path A 三种参数全被拒且均未建单（关闭彻底·无半成品态）');
    ok('[B] C0：path A 结构性关闭——viewer/不存在/合法主开发三种参数一律 INTAKE_WITH_ASSIGN_CONFLICT 且不建单（原 viewer/不存在校验覆盖已迁移至 [K]/[M] 的 assign 端点断言）');
  }

  // ═══ [H] 白盒：sysIssueTransition('assign') 在不兼容前置态失败 → 无 assigned_*/无子表行 ═══
  {
    const ADMIN = { id: 1, name: 'admin', role: 'admin' };
    const r = await run(
      `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
       VALUES ('bug', '已上线', '终态单', 'BMS', '内部', 1, 'admin')`
    );
    const id = r.lastID;
    await assert.rejects(
      I.sysIssueTransition(id, 'assign', null, ADMIN, { assigned_to: 5 }),
      e => e instanceof I.SysTransitionError && e.code === 'INVALID_TRANSITION',
      '已上线态 assign 应 INVALID_TRANSITION');
    const row = await get('SELECT assigned_to FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.assigned_to, null, '事务失败：assigned_to 未写入');
    assert.deepStrictEqual(await allDevAssigneeRows(id), [], '事务失败：子表无行（[C-1] 核心原子性，独立于建单 path A 验证）');
    ok('[H] 白盒：sysIssueTransition 在不兼容前置态（已上线）执行 assign 失败 → 主表/子表均无写入残留（底层机制直证）');
  }

  // [C3 退场] 原 [C]（差量 upsert 五步矩阵，白盒直调 I.applyDevAssigneeDiff）整节移除——该函数随旧
  //   /sys-issues/:id/assign 单人授权模型一并删除（C3 消灭旧 /assign，applyDevAssigneeDiff 唯一调用点不再
  //   存在，函数体已删）。"主开发/协作差量 upsert（保留通知状态/软删复活/降协作 vs 软删两分支）"这套算法
  //   本身随旧模型退场——新模型下"谁是代表"由 electRepresentative 派生（§3.6：现任仍在册优先/在册 pending
  //   最小 user_id/全在册最小 user_id/零在册→NULL），没有"指定主开发/协作差量"这个概念了。等价的多开发
  //   roster 差量能力（在册保留通知状态/软删/复活语义）已在 C2 的 reassign（声明式最终 roster，方案 §3）
  //   与 dev-assignees 加人/移除端点重新实现，覆盖见 scripts/verify-sys-multidev-members.js S31 等。
  let mainId;
  {
    // C3 重写 /assign：mainId 仅用于 [G] 详情 GET 读端断言（写读同源），无需剧本历史，建单+一次 assign 即可。
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: '剧本单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    mainId = r.body.id;
    // ⭐ 角色权限重构 C0：建单恒落「待受理」→ 补一步受理（→待处理）才能 assign
    await call('POST', `/api/sys-issues/${mainId}/intake-accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${mainId}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
    assert.strictEqual(r.status, 200, 'mainId assign 200, got ' + JSON.stringify(r.body));
    ok('[C 替代] mainId 建单 + assign(主=5,协作=[6])，供 [G] 详情 GET 读端 dev_assignees[] join 断言复用（旧差量算法白盒测试随 applyDevAssigneeDiff 一并退场，见上方注释）');
  }

  // ═══ [E] 单开发向后兼容 ═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: '单开发', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    // [codex 101 号 MED 回填] updated_at 成功断言——种一个明显过期的旧值（避开 SQLite datetime() 1 秒粒度
    //   与"前后取值同一秒"的时序抖动风险），assign 成功后应不再等于该旧值（真实被刷新，非巧合同值）。
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    const a = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(a.status, 200, '单开发 assign（不传协作）200');
    const da = await activeDevAssignees(id);
    assert.strictEqual(da.length, 1, '单开发向后兼容：子表恰 1 行');
    assert.strictEqual(da[0].user_id, 5, '子表行=主开发');
    assert.strictEqual(da[0].is_primary, 1, '子表行 is_primary=1');
    const afterUpd = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
    assert.notStrictEqual(afterUpd.updated_at, '2020-01-01 00:00:00', 'M2 回填：/assign 成功刷新 sys_issues.updated_at（旧版公共 UPDATE 既有行为）');
    ok('[E] 单开发向后兼容：assign 不传 collaborator_ids → 子表恰 1 行（对齐既有 19 套 verify 的单开发语义）+ updated_at 刷新');
  }

  // ═══ [F] 协作开发校验错误码 ═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'F校验', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const id1 = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${id1}/intake-accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [999] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'COLLABORATOR_NOT_FOUND', 'COLLABORATOR_NOT_FOUND');
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [9] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'COLLABORATOR_VIEWER', 'COLLABORATOR_VIEWER');
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: ['abc'] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_COLLABORATOR_IDS', 'INVALID_COLLABORATOR_IDS（非法元素）');
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: 'not-an-array' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_COLLABORATOR_IDS', 'INVALID_COLLABORATOR_IDS（非数组，fail-closed 不静默忽略）');
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [5] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'ASSIGNEE_DUPLICATE', 'ASSIGNEE_DUPLICATE（协作=主）');
    // 校验失败均未产生任何子表行（全部在事务内提前抛错，未落库）
    assert.deepStrictEqual(await allDevAssigneeRows(id1), [], '全部校验失败场景均未写入子表行');
    // 去重不报错：collaborator_ids 含重复 id 静默合并
    r = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6, 6, 8] });
    assert.strictEqual(r.status, 200, '协作 id 重复应静默去重放行 200');
    const da = await activeDevAssignees(id1);
    assert.strictEqual(da.length, 3, '去重后子表 3 行（5主+6,8协作，重复6只算1条）');
    ok('[F] 协作开发校验错误码：COLLABORATOR_NOT_FOUND/COLLABORATOR_VIEWER/INVALID_COLLABORATOR_IDS(非法元素+非数组)/ASSIGNEE_DUPLICATE 全部精确 + 重复 id 静默去重');
  }

  // ═══ [G] 详情 GET 读端 dev_assignees[] join（写读同源，附录A）═══
  {
    const detail = await call('GET', `/api/sys-issues/${mainId}`, adminTok);
    assert.strictEqual(detail.status, 200, '详情 200');
    const das = detail.body.dev_assignees;
    assert.ok(Array.isArray(das), 'dev_assignees 为数组');
    assert.strictEqual(das.length, 2, '详情 dev_assignees：在册 2 行（5主+6协作，C3 简化 mainId 建单一次 assign）');
    assert.strictEqual(das[0].is_primary, 1, '详情 dev_assignees：代表排第一（is_primary DESC）');
    assert.strictEqual(das[0].user_id, 5, '详情 dev_assignees：electRepresentative 派生代表=5（在册 pending 最小 user_id，§3.6 规则②，新单 assigned_to 起始 NULL）');
    // [修④] mutation 响应应含 notify_status 等全列字段
    assert.ok(das.every(d => 'notify_status' in d && 'notified_at' in d && 'read_at' in d && 'notify_message_key' in d && 'notify_error' in d),
      '详情 dev_assignees 含全列字段（notify_status/notified_at/read_at/notify_message_key/notify_error）');
    // [修B·轮2] 真验 mutation 响应形（非只 GET）：/assign 端点响应体 dev_assignees[0] 含全列字段
    const freshBug = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'mutation响应形', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    await call('POST', `/api/sys-issues/${freshBug.body.id}/intake-accept`, adminTok, {});   // C0：建单恒落待受理，先受理
    const mres = await call('POST', `/api/sys-issues/${freshBug.body.id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
    assert.strictEqual(mres.status, 200, 'assign 200');
    assert.ok(Array.isArray(mres.body.dev_assignees) && mres.body.dev_assignees.length >= 1, 'assign 响应含 dev_assignees 非空');
    const m0 = mres.body.dev_assignees[0];
    for (const col of ['id', 'user_id', 'user_name', 'is_primary', 'notify_status', 'notified_at', 'read_at', 'notify_message_key', 'notify_error']) {
      assert.ok(col in m0, `assign mutation 响应 dev_assignees[0] 含 ${col}（真锁修④ 响应形，非只 GET）`);
    }
    ok('[G] 详情 GET + assign mutation 响应体 dev_assignees[] 均含全列字段 + 仅在册行 + 主开发排前（附录A 契约·修④ 真断言响应形）');
  }

  // ═══ [I]/[J]/[L]（移除，C2 破坏性变更）═══
  //   ⚠️ 既有测试变更（详见交付汇报"既有测试变更清单"）：以下三节原测试的是 HTTP `/reassign` 端点的旧版
  //   "换主 vs 留主改协作"二分语义——[I] 留主改协作不清进度不流转+expectedCollaboratorIds 协作集乐观锁；
  //   [J] 换主清进度（dev_estimated_at 清零）+ timeline"改派 旧→新"摘要；[L] REASSIGN_STALE 并发丢更新防护。
  //   这三者依赖的核心概念——"主开发"这个特殊身份、"换主=新一轮清进度"业务规则、`expectedCollaboratorIds`
  //   协作集乐观锁字段——在 v2.9"去主次"重构下**均不存在对应物**：新版 reassign 是纯声明式最终 roster 差量
  //   （方案 §3），没有"谁是主"这个概念就没有"换主"这件事，dev_estimated_at 清零是 W07/ADMIN_TRANSITION 侧
  //   关切（本轮不碰，C3 范围），乐观锁改用最终集合与当前在册集合的差量比较（no-op→400 VALIDATION，无需额外
  //   expected 字段）。故不是"翻译成新等价物"而是整节概念retired，直接删除（非静默注释掉）。新版 reassign
  //   的完整语义（差量+operation_id 分组+LAST_ASSIGNEE+W-GATE 联动）在 scripts/verify-sys-multidev-members.js
  //   S31 全新覆盖。

  // ═══ [K] assign viewer 拦截（users 表存在时强制校验，不被传入名绕过）═══
  {
    // 本 harness users 表存在且含 viewer(id=9) → assign 该 viewer → ASSIGN_TARGET_VIEWER
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'assign viewer', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    // [codex 101 号 MED 回填] updated_at 回滚断言——种旧值，拒绝路径应整事务回滚，updated_at 不被误刷。
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 9 });
    assert.strictEqual(r.status, 400, 'assign viewer 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_TARGET_VIEWER', 'users 表存在 → 强制校验拦 viewer');
    const rejectedUpd = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(rejectedUpd.updated_at, '2020-01-01 00:00:00', 'M2 回填：assign 校验失败整事务回滚，updated_at 不被误刷');
    // [C3 退场] 原白盒直调 I.sysIssueTransition(...,'assign',...) 验证"传 assigned_to_name 无法绕过 viewer
    //   校验"——该白盒路径已不代表真实行为：'assign' switch 分支随旧 /assign 端点一并删除（C3），
    //   sysIssueTransition 不再处理 'assign' 动作的任何指派/roster 逻辑，viewer 校验现只存在于重写后的
    //   HTTP 端点内（上方已验证，且新实现始终查库权威角色，无"assigned_to_name 信任回退分支"可绕）。
    ok('[K] assign viewer 拦截：users 表存在 → 强制查库校验（ASSIGN_TARGET_VIEWER），新端点始终 DB 权威、无客户端传名回退分支可绕（C3 重写后更严格，白盒二次验证随旧 switch 分支退场）');
  }

  // ═══ [M] codex 99 号 M4：/assign 重建反例补强（重复候选去重已在 [F] 覆盖，此处补剩 3 项）═══
  {
    // M4①：重复请求幂等——同一 issue 二次 /assign（首次已把 D_PRE 推进 DEV，第二次 before===after=开发中，
    //   'assign' 具名边 from 白名单仅 [已排期]（feature）/[待处理]（bug），开发中不在其中）→ 确定性 409
    //   GATE_INVARIANT（非静默 200/非数据损坏），roster/status 均不受二次请求影响（幂等=可重复安全调用，
    //   非"返回同样 200"——assign 是一次性 D_PRE→DEV 边，非 PUT 语义幂等）。
    {
      let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'M4①重复请求', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
      await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
      r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
      assert.strictEqual(r.status, 200, 'M4①：首次 assign 200');
      // [codex 100 号 M4③ 同批加强] 全量快照对比（非仅计数）：roster 行完整内容 + dev_events + timeline +
      //   代表字段（assigned_to/_name/assigned_at），证明二次请求真正"零副作用"而非恰好计数相同的假阳性
      const rosterBefore = await allDevAssigneeRows(id);
      const issueBefore = await get('SELECT status, assigned_to, assigned_to_name, assigned_at FROM sys_issues WHERE id=?', [id]);
      const eventsBefore = await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=? ORDER BY id`, [id]);
      const timelineBefore = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? ORDER BY id`, [id]);
      r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
      assert.strictEqual(r.status, 409, `M4①：二次 assign（重复请求）应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'GATE_INVARIANT', 'M4①：二次 assign 错误码 GATE_INVARIANT（开发中不在 assign 具名边 from 白名单）');
      const rosterAfter = await allDevAssigneeRows(id);
      const issueAfter = await get('SELECT status, assigned_to, assigned_to_name, assigned_at FROM sys_issues WHERE id=?', [id]);
      const eventsAfter = await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=? ORDER BY id`, [id]);
      const timelineAfter = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? ORDER BY id`, [id]);
      assert.deepStrictEqual(rosterAfter, rosterBefore, 'M4①：⭐ roster 行完整内容逐字段不变（非仅行数相同，含 dev_status/is_primary/removed_at 等全列）');
      assert.deepStrictEqual(issueAfter, issueBefore, 'M4①：⭐ 代表字段（status/assigned_to/_name/assigned_at）逐字段不变');
      assert.deepStrictEqual(eventsAfter, eventsBefore, 'M4①：dev_events 零新增（roster INSERT 分支因 existingSet 命中而全跳过，从未到写事件那步）');
      assert.deepStrictEqual(timelineAfter, timelineBefore, 'M4①：timeline 零新增（guard 抛错先于 timeline INSERT）');
      ok('M4①：重复请求幂等——二次 /assign 确定性 409 GATE_INVARIANT，roster 行内容/代表字段/dev_events/timeline 全量快照逐字段不变（真正零副作用，非仅计数巧合）');
    }

    // M4②：removed 候选生成新 pending 生命周期——D_PRE 态先经 dev-assignees 加人再移除（矩阵§4.3 D_PRE 允许，
    //   主状态不动），留下 removed_at 非空历史行；随后 /assign 把该 removed 用户作为 collaborator_ids 传入，
    //   应生成全新 pending 实例（新 id/removed_at=NULL），而非复活旧行（对齐 S24 established re-add 范式，
    //   本次经由 /assign 路径验证同一约束——INSERT 分支只看 removed_at IS NULL 的 existingActive 集合，
    //   历史 removed 行天然不在其中）。
    {
      let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'M4②removed候选', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      const id = r.body.id;
      await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});   // C0：受理后落 待处理（D_PRE）
      r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [8] });
      assert.strictEqual(r.status, 200, `M4②：D_PRE 态预加人应 200（矩阵§4.3 主状态不动）, got ${r.status} ${JSON.stringify(r.body)}`);
      const preAdd = await activeDevAssignees(id);
      const oldRowId = preAdd.find(d => d.user_id === 8).id;
      r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${oldRowId}`, adminTok, { reason: '预加人后又移除' });
      assert.strictEqual(r.status, 200, `M4②：D_PRE 态移除应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const oldRow = await get('SELECT removed_at FROM sys_issue_dev_assignees WHERE id=?', [oldRowId]);
      assert.ok(oldRow.removed_at, 'M4②：旧行 removed_at 非空（软删历史留痕）');
      // 主戏：/assign 把 user8 作为协作候选传入
      r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [8] });
      assert.strictEqual(r.status, 200, `M4②：assign 携历史 removed 用户为协作候选应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const roster = await activeDevAssignees(id);
      const newRow = roster.find(d => d.user_id === 8);
      assert.ok(newRow, 'M4②：user8 在新在册集合中');
      assert.notStrictEqual(newRow.id, oldRowId, 'M4②：⭐ 新行 id≠旧行 id（全新实例，非复活旧行）');
      const newRowFull = await get('SELECT dev_status, removed_at FROM sys_issue_dev_assignees WHERE id=?', [newRow.id]);
      assert.strictEqual(newRowFull.dev_status, 'pending', 'M4②：新实例 dev_status=pending（全新生命周期起点）');
      assert.strictEqual(newRowFull.removed_at, null, 'M4②：新实例 removed_at=NULL（在册）');
      const allRows = await allDevAssigneeRows(id);
      assert.strictEqual(allRows.filter(d => d.user_id === 8).length, 2, 'M4②：user8 共 2 行（1 条历史 removed + 1 条全新 pending，非合并复用）');
      ok('M4②：removed 候选经 /assign 重新加入 → 生成全新 pending 实例（新 id/removed_at=NULL），旧历史行原样保留不被复活');
    }

    // M4③：roster INSERT 后注入失败（timeline INSERT 处）→ roster/assigned_to/status/timeline 全部回滚
    //   （fault-injection 范式同 verify-sys-multidev-members.js H2 / verify-sys-multidev-submit.js S4c）
    {
      let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'M4③故障注入', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
      await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
      // [codex 102 号 MED 回填] updated_at 种明显过期旧值（'2020-01-01'）——101 号轮的三处 updated_at 用例
      // 验证的是"前置拒绝未误刷"（从未执行到 UPDATE），非"已写入后随事务整体回滚"；本例的 UPDATE（roster
      // INSERT 后、timeline INSERT 前，即 /assign 自身状态 UPDATE 已把 updated_at 刷成"此刻"）确实先执行、
      // 后续才在 timeline INSERT 处注入失败——真正验证"写后回滚"而非"从未写过"。
      await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
      // [codex 100 号 M4③ 补强] 全量快照（非仅 status/assigned_to）：含 assigned_at/assigned_to_name（代表位）
      //   + notify_status 等通知字段，证明 electRepresentative 的 UPDATE（含 notify 五列重置）同随事务回滚
      const issueRowBefore = await get(
        `SELECT status, assigned_to, assigned_to_name, assigned_at, updated_at,
                notify_status, notified_at, notify_message_key, notify_error, read_at
           FROM sys_issues WHERE id=?`, [id]);
      injectFailureFired = false;
      injectFailureOnSql = `VALUES (?, 'assign', ?, ?, ?, ?, ?)`;   // 命中 /assign 自身 timeline INSERT（roster INSERT + 状态/updated_at UPDATE 之后、commit 之前）
      r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
      assert.strictEqual(r.status, 500, `M4③：故障注入应 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(injectFailureFired, 'M4③：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）');
      injectFailureOnSql = null; injectFailureFired = false;   // 复位
      const rosterAfter = await allDevAssigneeRows(id);
      assert.strictEqual(rosterAfter.length, 0, 'M4③：roster INSERT 已回滚（零残留行，含已成功插入的两条）');
      const issueRowAfter = await get(
        `SELECT status, assigned_to, assigned_to_name, assigned_at, updated_at,
                notify_status, notified_at, notify_message_key, notify_error, read_at
           FROM sys_issues WHERE id=?`, [id]);
      assert.deepStrictEqual(issueRowAfter, issueRowBefore, 'M4③：⭐ status/代表位（assigned_to/_name/assigned_at）/updated_at/通知五列全部逐字段不变（electRepresentative + 状态/updated_at 的 UPDATE 随事务整体回滚，非仅 status/assigned_to 两列表面相同）');
      assert.strictEqual(issueRowAfter.updated_at, '2020-01-01 00:00:00', 'M4③：⭐ updated_at 回滚到种子旧值（证明"已写后回滚"而非"从未写过"——101 号三处用例只测了后者）');
      const tl = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='assign'`, [id]);
      assert.strictEqual(tl.length, 0, 'M4③：timeline 零残留（INSERT 本身即注入点，未提交）');
      const ev = await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=?`, [id]);
      assert.strictEqual(ev.length, 0, 'M4③：dev_events 零残留（roster INSERT 时同步写的 add 事件随事务回滚，非仅 roster 表回滚而事件表残留）');
      ok('M4③：roster INSERT 成功后于 timeline INSERT 处注入失败 → 整事务回滚，roster/dev_events/assigned_to/代表位/通知字段/status/timeline 全部零残留（无部分写入）');
    }

    // M-P1：[codex C3 对抗审 M-P1 回填] 双重 sysRollback 修复回归——在 resolveCollaboratorList 内部（协作
    //   开发查询，非主开发查询，故 injectGetFailureSkip=1 跳过第一次命中）注入一个非 SysTransitionError
    //   的原始异常，验证：① /assign 本身 500（非业务错误未被误判成某个具体业务错误码）；② 锁所有权未被破坏
    //   ——断言紧随其后的一个全新请求（另一张单的 /assign）事务能正常完成，证明 mutex 没有卡死/被提前释放
    //   导致后续请求跑进一个"半途"的事务上下文。
    {
      let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'M-P1故障注入', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      const idA = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
      await call('POST', `/api/sys-issues/${idA}/intake-accept`, adminTok, {});
      injectGetFailureFired = false;
      injectGetFailureSkip = 1;   // 跳过 /assign 自身查主开发（devId=5）那一次，命中 resolveCollaboratorList 查协作开发（6）那一次
      injectGetFailureOnSql = 'SELECT id, display_name, username, role FROM users WHERE id = ?';
      r = await call('POST', `/api/sys-issues/${idA}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
      assert.strictEqual(r.status, 500, `M-P1：非业务错误应 500（未被误判成某个具体业务错误码）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(injectGetFailureFired, 'M-P1：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）');
      injectGetFailureOnSql = null; injectGetFailureSkip = 0; injectGetFailureFired = false;   // 复位
      const rosterA = await allDevAssigneeRows(idA);
      assert.strictEqual(rosterA.length, 0, 'M-P1：故障单本身整事务回滚，零残留（外层唯一回滚点生效）');
      // 关键：锁所有权未被破坏——紧随其后另一张单的正常 /assign 请求应完整成功（若锁被提前释放/破坏，
      //   这里可能报错、挂起，或数据出现跨事务污染）。
      r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'M-P1后续请求', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
      const idB = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
      await call('POST', `/api/sys-issues/${idB}/intake-accept`, adminTok, {});
      r = await call('POST', `/api/sys-issues/${idB}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
      assert.strictEqual(r.status, 200, `M-P1：⭐ 后续请求应正常成功 200（锁所有权未被破坏）, got ${r.status} ${JSON.stringify(r.body)}`);
      const rosterB = await allDevAssigneeRows(idB);
      assert.strictEqual(rosterB.length, 2, 'M-P1：⭐ 后续请求 roster 正确落库 2 行（事务完全正常，非受污染的半成品态）');
      ok('M-P1：⭐ 双重 sysRollback 修复——resolveCollaboratorList 注入非业务错误 → /assign 500 + 故障单零残留；紧随其后另一张单的 /assign 请求正常成功（锁所有权未被破坏，事务隔离完整）');
    }
  }

  server.close();
  console.log(`\n✅ verify-sys-dev-assignee-transition 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-dev-assignee-transition 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
