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
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
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
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'none路径', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r.status, 201, 'none 路径建单 201');
    let row = await get('SELECT status, assigned_to, relay_notified_user_id FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.status, '待处理', 'none：状态停留待处理');
    assert.strictEqual(row.assigned_to, null, 'none：无 assigned_to');
    assert.strictEqual(row.relay_notified_user_id, null, 'none：无 relay');
    assert.deepStrictEqual(await activeDevAssignees(r.body.id), [], 'none：无子表行');

    // A（主开发 + 2 协作）
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'pathA', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6, 8] });
    assert.strictEqual(r.status, 201, 'pathA 建单 201, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, '处理中', 'pathA：事务2 成功，状态直达处理中');
    assert.strictEqual(r.body.assigned_to, 5, 'pathA：响应含主开发');
    assert.ok(!r.body.assign_failed, 'pathA：无 assign_failed 标记');
    const pathAId = r.body.id;
    const daA = await activeDevAssignees(pathAId);
    assert.strictEqual(daA.length, 3, 'pathA：子表 3 行（主+2协作）');
    assert.deepStrictEqual(daA.filter(d => d.is_primary === 1).map(d => d.user_id), [5], 'pathA：恰好1主=5');
    assert.deepStrictEqual(daA.filter(d => d.is_primary === 0).map(d => d.user_id).sort(), [6, 8], 'pathA：协作=[6,8]');
    assert.ok(daA.every(d => d.notify_status === 'not_sent'), 'pathA：全部 notify_status=not_sent（建单不自动发钉钉）');

    // B（对接人，示例发布者 id=7）
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'pathB', system_name: 'BMS', source: '内部', assign_mode: 'B', relay_user_id: 7 });
    assert.strictEqual(r.status, 201, 'pathB 建单 201');
    assert.strictEqual(r.body.relay_notified_user_id, 7, 'pathB：relay_notified_user_id=7');
    assert.strictEqual(r.body.relay_notified_user_name, '示例发布者', 'pathB：relay_notified_user_name 反规范化正确');
    row = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.status, '待处理', 'pathB：状态停留待处理（无自动发钉钉/无自动指派）');
    assert.strictEqual(row.assigned_to, null, 'pathB：无 assigned_to');
    assert.deepStrictEqual(await activeDevAssignees(r.body.id), [], 'pathB：无子表行');

    // 互斥/校验错误码
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', assigned_to: 5, relay_user_id: 7 });
    assert.strictEqual(r.status, 400, '同传 A+B 参数应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_CONFLICT', 'code=ASSIGN_MODE_CONFLICT');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', assign_mode: 'C' });
    assert.strictEqual(r.status, 400, 'assign_mode=C 非法应 400');
    assert.strictEqual(r.body.code, 'INVALID_ASSIGN_MODE');

    const cntBefore = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'x', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5 });
    assert.strictEqual(r.status, 400, 'feature + assign_mode=A 应 400（变更流不适用三路径）');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_BUG_ONLY');
    const cntAfter = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    assert.strictEqual(cntAfter, cntBefore, 'ASSIGN_MODE_BUG_ONLY：拒绝时不创建任何行');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', assign_mode: 'A' });
    assert.strictEqual(r.status, 400, 'mode=A 缺 assigned_to 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_TARGET_REQUIRED');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', assign_mode: 'B' });
    assert.strictEqual(r.status, 400, 'mode=B 缺 relay_user_id 应 400');
    assert.strictEqual(r.body.code, 'RELAY_USER_REQUIRED');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', assign_mode: 'B', relay_user_id: 6 });
    assert.strictEqual(r.status, 400, '非白名单 relay_user_id 应 400');
    assert.strictEqual(r.body.code, 'RELAY_USER_NOT_WHITELISTED');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', collaborator_ids: [6] });
    assert.strictEqual(r.status, 400, 'mode=none 却传 collaborator_ids 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_MODE_CONFLICT');

    ok('[A] 建单三路径 none/A(主+2协作)/B(对接人白名单+反规范化名) 落点全对 + 6 种互斥/校验错误码精确');
  }

  // ═══ [B] path A 首事务字段边界 + assign 失败原子（主=viewer/不存在） ═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '主是viewer', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 9 });
    assert.strictEqual(r.status, 201, '主=viewer：事务1 仍提交，单已建，201');
    assert.strictEqual(r.body.assign_failed, true, '主=viewer：assign_failed=true');
    assert.strictEqual(r.body.assign_error.code, 'ASSIGN_TARGET_VIEWER', '主=viewer：assign_error.code 正确');
    let row = await get('SELECT status, assigned_to, assigned_to_name, assigned_at FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.status, '待处理', '主=viewer：单停留待处理（首事务字段边界）');
    assert.strictEqual(row.assigned_to, null, '主=viewer：assigned_to 仍 NULL（事务2 回滚，无 owner 漂移）');
    assert.strictEqual(row.assigned_to_name, null, '主=viewer：assigned_to_name 仍 NULL');
    assert.strictEqual(row.assigned_at, null, '主=viewer：assigned_at 仍 NULL');
    assert.deepStrictEqual(await allDevAssigneeRows(r.body.id), [], '主=viewer：无任何子表行（含软删）');

    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '主不存在', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 999 });
    assert.strictEqual(r.status, 201, '主不存在：事务1 仍提交，201');
    assert.strictEqual(r.body.assign_error.code, 'ASSIGN_TARGET_NOT_FOUND', '主不存在：正确错误码');
    row = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.status, '待处理', '主不存在：单停留待处理');
    assert.strictEqual(row.assigned_to, null, '主不存在：无 owner 漂移');
    assert.deepStrictEqual(await allDevAssigneeRows(r.body.id), [], '主不存在：无子表行');

    ok('[B] path A 首事务字段边界：主开发 viewer/不存在 → 事务2 回滚，单已建但停留待处理∧无 assigned_*∧无子表行（含软删）');
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

  // ═══ [C]+[D] 差量 upsert 五步矩阵 + OWNER_GUARD_FAILED（连贯剧本，同一张单反复改派）═══
  let mainId, dev5RowId;
  {
    // 建单 path A：主=5，协作=[6]
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '剧本单', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6] });
    mainId = r.body.id;
    let da = await activeDevAssignees(mainId);
    assert.strictEqual(da.length, 2, '剧本①：子表 2 行（5主+6协作）');
    dev5RowId = da.find(d => d.user_id === 5).id;
    const dev6RowId = da.find(d => d.user_id === 6).id;

    // 模拟 dev6 已被通知（供步骤1"保留通知状态"断言）
    await run(`UPDATE sys_issue_dev_assignees SET notify_status='sent', notified_at='2026-01-01 10:00:00', notify_message_key='mk1' WHERE id=?`, [dev6RowId]);

    // OWNER_GUARD_FAILED：oldAssignedTo 传错（旧主停留旧页面提交场景）
    r = await call('POST', `/api/sys-issues/${mainId}/reassign`, adminTok, { newAssignedTo: 8, oldAssignedTo: 999, reason: '测试乐观锁' });
    assert.strictEqual(r.status, 409, 'oldAssignedTo 不匹配应 409');
    assert.strictEqual(r.body.code, 'OWNER_GUARD_FAILED', 'code 已改名为 OWNER_GUARD_FAILED（非旧 CONCURRENT_REASSIGN）');
    da = await activeDevAssignees(mainId);
    assert.strictEqual(da.length, 2, 'OWNER_GUARD_FAILED：守卫先于差量 upsert，子表未受影响');

    // 剧本②：reassign 8(主)+[6,10]（6=在册保留/step1；10=全新/step3；5=旧主不在协作集→软删/step4）
    r = await call('POST', `/api/sys-issues/${mainId}/reassign`, adminTok, { newAssignedTo: 8, oldAssignedTo: 5, reason: '第一次改派', collaboratorIds: [6, 10] });
    assert.strictEqual(r.status, 200, '剧本②改派 200, got ' + JSON.stringify(r.body));
    da = await activeDevAssignees(mainId);
    assert.strictEqual(da.length, 3, '剧本②：在册 3 行（8主+6,10协作）');
    assert.deepStrictEqual(da.filter(d => d.is_primary === 1).map(d => d.user_id), [8], '剧本②：恰好1主=8');
    const dev6After2 = da.find(d => d.user_id === 6);
    assert.strictEqual(dev6After2.notify_status, 'sent', '步骤1：dev6 在册保留 → notify_status 未被清零');
    assert.strictEqual(dev6After2.notify_message_key, 'mk1', '步骤1：dev6 notify_message_key 保留');
    const dev5Row = await get(`SELECT is_primary, removed_at FROM sys_issue_dev_assignees WHERE id=?`, [dev5RowId]);
    assert.ok(dev5Row.removed_at, '步骤4：旧主5不在新协作集 → 软删（旧主去向分支①：软删）');
    const dev10Row = da.find(d => d.user_id === 10);
    assert.strictEqual(dev10Row.notify_status, 'not_sent', '步骤3：dev10 全新 INSERT，notify_status=not_sent');

    // 剧本③：reassign 回 5(主)+[6]（5=软删复活取最新/step2，同一行id；8=旧主不在协作集→软删；10=协作出集→软删）
    r = await call('POST', `/api/sys-issues/${mainId}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 8, reason: '复活旧主', collaboratorIds: [6] });
    assert.strictEqual(r.status, 200, '剧本③改派 200, got ' + JSON.stringify(r.body));
    da = await activeDevAssignees(mainId);
    assert.strictEqual(da.length, 2, '剧本③：在册 2 行（5主+6协作）');
    const dev5Reactivated = await get(`SELECT id, is_primary, removed_at FROM sys_issue_dev_assignees WHERE user_id=5 AND issue_id=?`, [mainId]);
    assert.strictEqual(dev5Reactivated.id, dev5RowId, '步骤2：复活的是同一行（id 不变，非新 INSERT）');
    assert.strictEqual(dev5Reactivated.removed_at, null, '步骤2：removed_at 复位 NULL（复活）');
    assert.strictEqual(dev5Reactivated.is_primary, 1, '步骤2：复活即为主（is_primary=1）');
    const dev8RowAfter3 = await get(`SELECT removed_at FROM sys_issue_dev_assignees WHERE user_id=8 AND issue_id=?`, [mainId]);
    assert.ok(dev8RowAfter3.removed_at, '步骤4：旧主8不在新协作集 → 软删（旧主去向分支①，第二次验证）');
    const dev10RowAfter3 = await get(`SELECT removed_at FROM sys_issue_dev_assignees WHERE user_id=10 AND issue_id=?`, [mainId]);
    assert.ok(dev10RowAfter3.removed_at, '步骤4：协作 10 出集 → 软删（非仅主开发才走此分支）');
    const dev6Row3 = da.find(d => d.user_id === 6);
    assert.strictEqual(dev6Row3.notify_status, 'sent', '步骤1：dev6 连续两轮改派后通知状态仍保留（幂等）');

    // 剧本④：reassign 6(主，原协作提升)+[5]（原主降协作，旧主去向分支②：仍在协作集→降协作，非软删）
    r = await call('POST', `/api/sys-issues/${mainId}/reassign`, adminTok, { newAssignedTo: 6, oldAssignedTo: 5, reason: '协作转正', collaboratorIds: [5] });
    assert.strictEqual(r.status, 200, '剧本④改派 200, got ' + JSON.stringify(r.body));
    da = await activeDevAssignees(mainId);
    assert.strictEqual(da.length, 2, '剧本④：在册 2 行（6主+5协作）');
    const dev6Promoted = da.find(d => d.user_id === 6);
    assert.strictEqual(dev6Promoted.is_primary, 1, '步骤1：dev6（原在册协作）提升为主');
    const dev5Demoted = await get(`SELECT id, is_primary, removed_at FROM sys_issue_dev_assignees WHERE user_id=5 AND issue_id=?`, [mainId]);
    assert.strictEqual(dev5Demoted.id, dev5RowId, '旧主降协作：仍是同一行（第三次复用，非新建）');
    assert.strictEqual(dev5Demoted.is_primary, 0, '旧主去向分支②：仍在目标集 → 降协作（is_primary 0），非软删');
    assert.strictEqual(dev5Demoted.removed_at, null, '旧主去向分支②：降协作后仍在册（removed_at NULL）');

    // 恰好1主不变式：全程每一步之后都应满足（逐一复核最终态）
    const finalPrimaries = await all(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND is_primary=1 AND removed_at IS NULL`, [mainId]);
    assert.strictEqual(finalPrimaries.length, 1, '[G12/step5] 最终态恰好 1 条在册 primary');
    const finalRow = await get('SELECT assigned_to FROM sys_issues WHERE id=?', [mainId]);
    assert.strictEqual(finalPrimaries[0].user_id, finalRow.assigned_to, '[step5] 在册 primary user_id == sys_issues.assigned_to');

    ok('[C] 差量 upsert 五步矩阵：在册保留通知状态(step1×3轮幂等) + 全新INSERT(step3) + 软删复活取最新且同行复用(step2×2次) + 出集软删含协作非仅主(step4) + 旧主两分支(降协作 vs 软删各验2次) + 恰好1主不变式(step5)全程保持');
    ok('[D] OWNER_GUARD_FAILED：旧命名 CONCURRENT_REASSIGN 已改名，守卫失败时子表差量 upsert 不触发（未受影响）');
  }

  // ═══ [E] 单开发向后兼容 ═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '单开发', system_name: 'BMS', source: '内部' });
    const id = r.body.id;
    const a = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(a.status, 200, '单开发 assign（不传协作）200');
    const da = await activeDevAssignees(id);
    assert.strictEqual(da.length, 1, '单开发向后兼容：子表恰 1 行');
    assert.strictEqual(da[0].user_id, 5, '子表行=主开发');
    assert.strictEqual(da[0].is_primary, 1, '子表行 is_primary=1');
    ok('[E] 单开发向后兼容：assign 不传 collaborator_ids → 子表恰 1 行（对齐既有 19 套 verify 的单开发语义）');
  }

  // ═══ [F] 协作开发校验错误码 ═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'F校验', system_name: 'BMS', source: '内部' });
    const id1 = r.body.id;
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
    assert.strictEqual(das.length, 2, '详情 dev_assignees：仅在册 2 行（历史软删的 8/10 不出现）');
    assert.strictEqual(das[0].is_primary, 1, '详情 dev_assignees：主开发排第一（is_primary DESC）');
    assert.strictEqual(das[0].user_id, 6, '详情 dev_assignees：当前主开发=6（剧本④终态）');
    assert.ok(!das.some(d => d.user_id === 8 || d.user_id === 10), '详情 dev_assignees：软删的 8/10 不出现（写读同源）');
    // [修④] mutation 响应（reassign 剧本④ 的响应体）应含 notify_status 等全列字段
    assert.ok(das.every(d => 'notify_status' in d && 'notified_at' in d && 'read_at' in d && 'notify_message_key' in d && 'notify_error' in d),
      '详情 dev_assignees 含全列字段（notify_status/notified_at/read_at/notify_message_key/notify_error）');
    // [修B·轮2] 真验 mutation 响应形（非只 GET）：/assign 端点响应体 dev_assignees[0] 含全列字段
    const freshBug = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'mutation响应形', system_name: 'BMS', source: '内部' });
    const mres = await call('POST', `/api/sys-issues/${freshBug.body.id}/assign`, adminTok, { assigned_to: 5, collaborator_ids: [6] });
    assert.strictEqual(mres.status, 200, 'assign 200');
    assert.ok(Array.isArray(mres.body.dev_assignees) && mres.body.dev_assignees.length >= 1, 'assign 响应含 dev_assignees 非空');
    const m0 = mres.body.dev_assignees[0];
    for (const col of ['id', 'user_id', 'user_name', 'is_primary', 'notify_status', 'notified_at', 'read_at', 'notify_message_key', 'notify_error']) {
      assert.ok(col in m0, `assign mutation 响应 dev_assignees[0] 含 ${col}（真锁修④ 响应形，非只 GET）`);
    }
    ok('[G] 详情 GET + assign mutation 响应体 dev_assignees[] 均含全列字段 + 仅在册行 + 主开发排前（附录A 契约·修④ 真断言响应形）');
  }

  // ═══ [I] 留主改协作（修①·集成审收口）：不换主、只增删协作 → 不清进度不流转 ═══
  {
    // 建 bug path A：主=5、协作=[6]；estimate 填预计完成（进度），确认留主改协作后进度不丢
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '留主改协作', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6] });
    const id = r.body.id;
    const EST = '2026-09-01 10:00';
    r = await call('POST', `/api/sys-issues/${id}/estimate`, dev5Tok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, '主开发 estimate 填预计完成 200');
    let issue = await get('SELECT status, dev_estimated_at, assigned_to FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(issue.status, '处理中', '前置：status=处理中');
    assert.strictEqual(issue.dev_estimated_at, EST, '前置：dev_estimated_at 已填');

    // 留主改协作：newAssignedTo=5(不变)、oldAssignedTo=5、协作 [6]→[6,8]（带 expectedCollaboratorIds=当前在册协作集 [6]，修A collab 集乐观锁）
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '加个协作', collaboratorIds: [6, 8], expectedCollaboratorIds: [6] });
    assert.strictEqual(r.status, 200, '留主改协作 200, got ' + JSON.stringify(r.body));
    // [轮3 收口·codex-LOW] 真验 /reassign 端点响应体 dev_assignees[] 全列（非只 GET / assign）
    assert.ok(Array.isArray(r.body.dev_assignees) && r.body.dev_assignees.length >= 1, 'reassign 响应含 dev_assignees 非空');
    for (const col of ['id', 'user_id', 'user_name', 'is_primary', 'notify_status', 'notified_at', 'read_at', 'notify_message_key', 'notify_error']) {
      assert.ok(col in r.body.dev_assignees[0], `reassign mutation 响应 dev_assignees[0] 含 ${col}（真锁修④ reassign 响应形）`);
    }
    const da = await activeDevAssignees(id);
    assert.deepStrictEqual(da.filter(d => d.is_primary === 1).map(d => d.user_id), [5], '① 主开发仍=5（未换主）');
    assert.deepStrictEqual(da.filter(d => d.is_primary === 0).map(d => d.user_id).sort(), [6, 8], '① 协作集 [6,8]（8 进子表在册）');
    issue = await get('SELECT status, dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(issue.dev_estimated_at, EST, '② dev_estimated_at 未清（留主改协作保留进度）');
    assert.strictEqual(issue.status, '处理中', '③ status 未流转（仍处理中）');
    const tl = await all(`SELECT event_type, from_status, to_status, summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='reassign' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(/编辑协作开发/.test(tl[0].summary), '④ timeline summary 含"编辑协作开发"');
    assert.strictEqual(tl[0].from_status, tl[0].to_status, '④ timeline from==to（不流转）');
    const finalPrim = await all(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND is_primary=1 AND removed_at IS NULL`, [id]);
    assert.strictEqual(finalPrim.length, 1, '⑤ 恰好1主');
    assert.strictEqual(finalPrim[0].user_id, 5, '⑤ 恰好1主==assigned_to=5');

    // [I-d 轮3 收口·codex-LOW] expectedCollaboratorIds 严格校验（非数组/脏元素显式拒，不静默丢弃）：
    //   collaboratorIds=[6] 与当前在册 [6,8] 不同 → 过 NO_CHANGE guard，到 expectedCollaboratorIds 校验
    let rBad = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '脏参', collaboratorIds: [6], expectedCollaboratorIds: 'x' });
    assert.strictEqual(rBad.body.code, 'INVALID_EXPECTED_COLLABORATORS', '非数组 expectedCollaboratorIds → INVALID_EXPECTED_COLLABORATORS');
    rBad = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '脏元素', collaboratorIds: [6], expectedCollaboratorIds: [6, 'bad'] });
    assert.strictEqual(rBad.body.code, 'INVALID_EXPECTED_COLLABORATORS', '含非法元素 expectedCollaboratorIds → INVALID_EXPECTED_COLLABORATORS');
    assert.deepStrictEqual((await activeDevAssignees(id)).filter(d => d.is_primary === 0).map(d => d.user_id).sort(), [6, 8], 'INVALID 拒绝后子表未变（仍 [6,8]）');

    // [I-b] 真无变更（主+协作都不变）→ REASSIGN_NO_CHANGE（NO_CHANGE guard 先于 collab 集乐观锁，故无需 expected 也拒）
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '啥都没改', collaboratorIds: [6, 8], expectedCollaboratorIds: [6, 8] });
    assert.strictEqual(r.status, 400, '主+协作都不变应 400');
    assert.strictEqual(r.body.code, 'REASSIGN_NO_CHANGE', 'code=REASSIGN_NO_CHANGE');
    // 进度仍未被 NO_CHANGE 分支意外触碰
    issue = await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(issue.dev_estimated_at, EST, 'NO_CHANGE 拒绝后进度仍在（事务已 rollback）');

    // [I-c] 留主改协作缺 expectedCollaboratorIds → 400 EXPECTED_COLLABORATORS_REQUIRED（修A：collab 集乐观锁必填）
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '缺乐观锁', collaboratorIds: [6] });
    assert.strictEqual(r.status, 400, '缺 expectedCollaboratorIds 应 400');
    assert.strictEqual(r.body.code, 'EXPECTED_COLLABORATORS_REQUIRED', 'code=EXPECTED_COLLABORATORS_REQUIRED');
    ok('[I] 留主改协作：不换主只增删协作 → 8 进子表在册 + dev_estimated_at 未清 + status 未流转 + timeline"编辑协作开发"(from==to) + 恰好1主；真无变更→REASSIGN_NO_CHANGE；缺 expectedCollaboratorIds→EXPECTED_COLLABORATORS_REQUIRED');
  }

  // ═══ [J] 换主仍清进度（回归护住换主分支）═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '换主清进度', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6] });
    const id = r.body.id;
    const EST = '2026-09-02 11:00';
    await call('POST', `/api/sys-issues/${id}/estimate`, dev5Tok, { dev_estimated_at: EST });
    let issue = await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(issue.dev_estimated_at, EST, '前置：dev_estimated_at 已填');
    // 换主：5→8
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 8, oldAssignedTo: 5, reason: '换个人', collaboratorIds: [6] });
    assert.strictEqual(r.status, 200, '换主 200');
    issue = await get('SELECT status, dev_estimated_at, assigned_to FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(issue.dev_estimated_at, null, '换主=新一轮：dev_estimated_at 被清');
    assert.strictEqual(Number(issue.assigned_to), 8, '换主：assigned_to=8');
    const tl = await all(`SELECT summary, from_status, to_status FROM sys_issue_timeline WHERE issue_id=? AND event_type='reassign' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(/改派 旧#5→新#8/.test(tl[0].summary), '换主 timeline summary "改派 旧→新"');
    ok('[J] 换主回归：newAssignedTo≠old → dev_estimated_at 清 + assigned_to 换 + timeline"改派 旧→新"（换主分支未被留主改协作逻辑破坏）');
  }

  // ═══ [K] assign viewer 拦截（users 表存在时强制校验，不被传入名绕过）═══
  {
    // 本 harness users 表存在且含 viewer(id=9) → assign 该 viewer → ASSIGN_TARGET_VIEWER
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'assign viewer', system_name: 'BMS', source: '内部' });
    const id = r.body.id;
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 9 });
    assert.strictEqual(r.status, 400, 'assign viewer 应 400');
    assert.strictEqual(r.body.code, 'ASSIGN_TARGET_VIEWER', 'users 表存在 → 强制校验拦 viewer');
    // 白盒直证：即便通过 sysIssueTransition 直传 assigned_to_name 也无法绕过（users 表存在时忽略传入名走 db 校验）
    const ADMIN = { id: 1, name: 'admin', role: 'admin' };
    const seed = await run(`INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name) VALUES ('bug','待处理','绕过测试','BMS','内部',1,'admin')`);
    await assert.rejects(
      I.sysIssueTransition(seed.lastID, 'assign', null, ADMIN, { assigned_to: 9, assigned_to_name: '伪造名绕过' }),
      e => e instanceof I.SysTransitionError && e.code === 'ASSIGN_TARGET_VIEWER',
      'users 表存在时传 assigned_to_name 不能绕过 viewer 校验');
    ok('[K] assign viewer 拦截（修②）：users 表存在 → 强制查库校验，传入名/伪造名无法绕过 viewer 闸（ASSIGN_TARGET_VIEWER）');
  }

  // ═══ [L] 并发丢更新防护（修A·轮2）：留主改协作传与实际不符的 expectedCollaboratorIds → REASSIGN_STALE ═══
  {
    // 建 bug path A：主=5、协作=[6]（实际当前协作集 = {6}）
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '并发丢更新', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6] });
    const id = r.body.id;
    const before = await allDevAssigneeRows(id);
    // B 拿旧页面（误以为当前协作是 [6,8]）想改成 [6,10]：expected [6,8] ≠ 实际 [6] → 409 REASSIGN_STALE
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 5, reason: '并发提交', collaboratorIds: [6, 10], expectedCollaboratorIds: [6, 8] });
    assert.strictEqual(r.status, 409, '协作集乐观锁不匹配应 409, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'REASSIGN_STALE', 'code=REASSIGN_STALE');
    // 子表未被改动（乐观锁生效、事务已 rollback）：行集逐字不变 + 10 未进子表
    const after = await allDevAssigneeRows(id);
    assert.strictEqual(JSON.stringify(after), JSON.stringify(before), '子表逐字未变（事务 rollback）');
    assert.ok(!after.some(d => d.user_id === 10), '10 未进子表（丢更新被拦，未静默覆盖）');
    const activeC = await activeDevAssignees(id);
    assert.deepStrictEqual(activeC.filter(d => d.is_primary === 0).map(d => d.user_id).sort(), [6], '在册协作仍=[6]（未被 B 的 [6,10] 覆盖）');
    ok('[L] 并发丢更新防护：留主改协作传 expectedCollaboratorIds=[6,8] 但实际=[6] → 409 REASSIGN_STALE + 子表逐字未变（声明式全集替换的丢更新被 collab 集乐观锁拦住）');
  }

  server.close();
  console.log(`\n✅ verify-sys-dev-assignee-transition 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-dev-assignee-transition 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
