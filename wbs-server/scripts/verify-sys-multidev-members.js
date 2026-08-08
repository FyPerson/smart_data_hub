// scripts/verify-sys-multidev-members.js — C2 验收：成员 API + supersede + 选举 + W-GATE + assertMainStatusTransition
//   SSOT = 方案 v2.9 §3/§3.6/§4/§5/§10 + 开发计划 v2.9 §2（联合 SSOT）
//   用法：node scripts/verify-sys-multidev-members.js
//
// 覆盖验收表 S10/S11/S12/S13/S14/S15/S16/S22/S24/S28/S31/S32（联合 SSOT §13）；每个主要场景 seed/mutate 后
// 跑一遍 runProbes 自证（复用 C0 探针，非新增探针）。in-process app + 内存库 + 自签 token，照
// verify-sys-multidev-read.js 范式。C2 范围：不碰 W07（/assign /schedule 等）与 RELEASE，故本文件不测这些。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');
const { assertMainStatusTransition, MainStatusGuardError } = require('../routes/sys-iteration/status-transition-guard');

const SECRET = 'verify-sys-multidev-members-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// H2（91 号审）一次性故障注入：verify path A 中途失败时事务整体回滚（无部分写入残留）。
//   平时 injectFailureOnSql=null，dbRunAsync 行为与直接用 run 完全一致；仅测试内临时置位一次，命中后自动复位
//   并置 injectFailureFired=true（供断言"确实命中过"，防 SQL 片段写错导致故障从未注入、测试静默失去意义）。
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
  db, dbRunAsync: runFI, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;
function waitReady() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

// 用户种子：1=admin / 5,6,8,10,11,12=开发 / 9=viewer / 7=对接人白名单（示例发布者，同 SYS_BUG_LIAISON_USER_IDS）
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
//   ⚠️ codex 221a 收口更正（全文扫描收尾）：mkIssue 内 est 默认值虽是**直连 SQL 造数**、不经过 /estimate
//   端点闸门，但字段本身仍是 dev_estimated_at（潜伏型时限炸弹，同 intake-schedule-c6.js 判定口径）——
//   已改用本函数动态生成（见下方 mkIssue）。mkMember 内 resolvedAt 默认值是另一类字段（"该开发何时
//   完成"的历史记录，无 futures 比较语义），维持原样不改，与 est 分开判定。
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 造数 helper（C2 范围内没有 API 能把 issue 推进到"全员完成态待验证"——submit/no_code 是 C3 范围，
//   handleDevSubmit 尚未接线——故 VERIFY 前置状态用 raw SQL 直接构造，测的是 C2 自己的成员 API/W-GATE 反应，
//   非 submit 流程本身）。──────────
async function mkIssue(type, status, extra = {}) {
  // [codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED 现同时受 submit 与 GATE（isGateEligibleForVerify）双重
  //   约束——本文件测的是成员 add/remove/excuse/reassign 机制，非 estimate 本身，默认种占位值避免 GATE 场景
  //   （如 S10 excuse 触发 GATE）被新闸拦下；devEstimatedAt: null 显式传空可测该闸本身。
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  // ⭐ R4 下沉（v2.1·实现变了非断言错·196 号线）：变更流夹具**默认带 OA**——v2.1 后任何进过指派/开发态的
  //   变更流单必有号（三入口共享守卫），raw SQL 直造的无号态是 v2.1 前的人工态。extra.oaNumber:null 可显式造
  //   无号态（测守卫本身用）；bug 恒不带（D2 可选）。
  const oa = (type === 'feature' || type === 'improvement')
    ? (extra.oaNumber === null ? null : (extra.oaNumber || '20260728300')) : null;
  // [C7 工时评估补全·方案 v1.7 §9.1] GATE 的工期资格从「nf=1 ∧ feature」扩到「feature/improvement × nf
  //   两值」——本文件大量夹具是 nf=0 的 feature/improvement，C7 前从不经过工期资格，C7 后 GATE 会因工期
  //   为空而静默 defer（S10 一类"excuse 触发 GATE 转待验证"的断言会全线失守，且失守形态是"状态没动"这种
  //   不报错的静默症状）。同 dev_estimated_at/oa_number 既有处置：默认种合法占位值；effortDays: null 可
  //   显式造"未填工期"态测该闸本身；bug/config 无工期维度恒不种。
  const effort = (type === 'feature' || type === 'improvement')
    ? (extra.effortDays === null ? null : (extra.effortDays || 1)) : null;
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, oa_number, estimated_effort_days)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est, oa, effort]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [issueId, userId, userName, devStatus, extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  const daId = r.lastID;
  // P3 四态配对：code_submitted 要求 commit 行≥1——种子数据全库跑 runProbes 自证，故凡 code_submitted 必须
  // 配一条 commit 行，否则污染其他场景的自证断言（P3 检查的是整库恒真，非本场景局部状态）。
  if (devStatus === 'code_submitted' && extra.skipCommit !== true) {
    await run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, ?, 'backend', ?, datetime('now'))`,
      [issueId, daId, userId, `fix/seed-${daId}`]
    );
  }
  return daId;
}
async function activeMembers(issueId) {
  return all(`SELECT id, user_id, dev_status, is_primary FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY user_id ASC`, [issueId]);
}
async function issueRow(issueId) {
  return get('SELECT type, status, assigned_to, assigned_to_name FROM sys_issues WHERE id = ?', [issueId]);
}
// [codex 270 号 M-1] 共享旧闸前置断言——逐条镜像 routes/sys-iteration/index.js 的
// isGateEligibleForVerify 真实判据集（工期分支之前的部分）。⚠️ 该函数**不读 assigned_at**（已 grep
// 实测源码确认，270 号复审明确交代"按实际判据集为准，别照抄列出的猜测清单"）——本函数只断言
// isGateEligibleForVerify 实际会检查的字段，不发明它不检查的字段。S10n/S10o 均调用：在触发
// excuse 之前证明"唯一缺口是工期"，excuse 之后（S10o）用来证明写脏值那条 UPDATE 没有连带破坏
// 其余字段，红绿只由工期判据决定。
async function assertGateOldConditionsAllPass(label, issueId) {
  const row = await get(
    `SELECT dev_estimated_at, blocked, needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk
       FROM sys_issues WHERE id = ?`, [issueId]);
  assert.ok(row, `${label}：assertGateOldConditionsAllPass 应能查到 issue ${issueId}`);
  assert.ok(row.dev_estimated_at, `${label}：dev_estimated_at 应非空（旧闸条件）`);
  assert.strictEqual(row.blocked, 0, `${label}：blocked 应为 0（旧闸条件）`);
  assert.strictEqual(row.needs_feasibility, 1, `${label}：needs_feasibility 应为 1（旧闸条件，工期分支的前提）`);
  assert.ok(row.feasibility_conclusion, `${label}：feasibility_conclusion 应非空（旧闸条件）`);
  assert.ok(['可行', '有条件可行', '不可行'].includes(row.feasibility_conclusion), `${label}：feasibility_conclusion 应落在合法枚举内（旧闸条件），实得 ${row.feasibility_conclusion}`);
  assert.notStrictEqual(row.feasibility_conclusion, '不可行', `${label}：feasibility_conclusion 不应为「不可行」（旧闸条件）`);
  assert.ok((row.feasibility_requirement_confirm || '').trim(), `${label}：feasibility_requirement_confirm 应非空（旧闸条件）`);
  if (row.feasibility_conclusion === '有条件可行') {
    assert.ok((row.feasibility_risk || '').trim(), `${label}：结论「有条件可行」时 feasibility_risk 应非空（旧闸条件）`);
  }
  return row;
}
// [codex 270 号 L-2] PRAGMA ignore_check_constraints 封装——先读原状态、执行期间临时开启、finally 无条件
// 恢复到进入前的原状态（非硬编码恢复成 OFF：封装本身不应假设调用者的前置状态，虽然本文件目前恒为 OFF
// 进入）。本文件走全新 CREATE TABLE 路径带 DDL CHECK，S10o 需要模拟"脏值已经落在没有 CHECK 的 ALTER
// 旧库路径"这个只在生产旧库才会真实出现的场景，写完立刻恢复，不扩大对其余用例的影响面。
async function withIgnoredCheckConstraints(fn) {
  const before = await get('PRAGMA ignore_check_constraints');
  const beforeOn = !!(before && Number(before.ignore_check_constraints) === 1);
  await run('PRAGMA ignore_check_constraints = ON');
  try {
    return await fn();
  } finally {
    await run(`PRAGMA ignore_check_constraints = ${beforeOn ? 'ON' : 'OFF'}`);
  }
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  assert.strictEqual(failed.length, 0, `${label}：种子/操作后应满足全部 P1-P15 恒真，实际失败：${JSON.stringify(failed)}`);
  return results;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // 建单优化批 C3b（方案 §6c）：主建单端点需求方三字段全空时会 SELECT users.phone 做固化——
  //   users 夹具须含该列，否则撞 SQLITE_ERROR: no such column: phone（本次一并补齐）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),
    (5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(8,'dev8','开发丙','user'),
    (10,'dev10','开发丁','user'),(11,'dev11','开发戊','user'),(12,'dev12','开发己','user'),
    (9,'viewer9','观察员','viewer'),(7,'shenjun','示例发布者','publisher'),(13,'wangtaotao','示例对接人','user')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // S10：excuse 最后一名 pending（D11）→ 允许；可进待验证
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    // [codex 101 号 MED 回填] updated_at 成功断言——种旧值，隔离验证 runWGate 状态转移这一处 UPDATE
    // 自身刷新（excuse 本身的 UPDATE 落在 sys_issue_dev_assignees，无 updated_at 列，此处观测到的刷新
    // 只能来自 runWGate）。
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, `S10：excuse 最后一名 pending 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.dev_status, 'excused', 'S10：目标 dev_status=excused');
    assert.strictEqual(r.body.main_status, '待验证', 'S10：全员开脱=全完成态 → W-GATE 同事务转待验证');
    const row = await get('SELECT status, updated_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '待验证', 'S10：sys_issues.status 已落库为待验证');
    assert.notStrictEqual(row.updated_at, '2020-01-01 00:00:00', 'M2 回填：runWGate 状态转移刷新 sys_issues.updated_at（旧版公共 UPDATE 既有行为，本次在 W-GATE 落点补回）');
    await selfCertifyProbes('S10');
    ok('S10：excuse 允许开脱最后一名 pending（D11）→ 全员完成态 → W-GATE 同事务转「待验证」+ updated_at 刷新');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10b：[codex 98 号 HIGH 回填] GATE 纵深反例——受阻单被 excuse 清空 pending，全员完成态但 blocked=1，
  //   GATE 不应自动推进 DEV→VERIFY（94 号 M4 场景：非 submit 路径无 submit 侧硬闸兜底，需 GATE 自身资格过滤）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await run('UPDATE sys_issues SET blocked = 1, blocked_reason = ? WHERE id = ?', ['GATE 纵深反例：受阻中', id]);
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, `S10b：excuse 本身应仍 200（成员动作不受 blocked 拦截），实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.dev_status, 'excused', 'S10b：目标 dev_status=excused（成员写入不受影响）');
    // 关键反例：全员完成态已达成，但 blocked=1 → GATE 资格过滤拦下，main_status 应仍是「开发中」（未推进待验证）
    assert.strictEqual(r.body.main_status, '开发中', 'S10b：⭐ blocked=1 单全员完成态也不应被 GATE 推进——main_status 仍「开发中」');
    const row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10b：sys_issues.status 落库仍「开发中」（GATE 未触发状态变更）');
    await selfCertifyProbes('S10b');
    ok('S10b：⭐ GATE 纵深反例——受阻单（blocked=1）excuse 清空 pending 达全员完成态，GATE 资格过滤拦下不推进待验证（isGateEligibleForVerify）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10c：[codex 99 号 HIGH 修复回归①] 死锁场景一——blocked=1 单 excuse 清空最后 pending（GATE 保持 DEV，
  //   同 S10b）后，unblock 清 blocked 应在同一事务内重跑 runWGate、原子推进待验证（不再永久卡死）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await run('UPDATE sys_issues SET blocked = 1, blocked_reason = ? WHERE id = ?', ['S10c 死锁复现：受阻中', id]);
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, 'S10c：excuse 200');
    assert.strictEqual(r.body.main_status, '开发中', 'S10c：excuse 后仍卡在开发中（blocked=1 资格未合格，同 S10b）');
    // 修复前：unblock 只清 blocked，GATE 永不重跑，工单卡死；修复后：unblock 事务尾部重跑 runWGate，原子推进
    r = await call('POST', `/api/sys-issues/${id}/unblock`, adminTok, { reason: '误报，已核实可继续' });
    assert.strictEqual(r.status, 200, `S10c：unblock 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT status, blocked FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.blocked, 0, 'S10c：blocked 已清零');
    assert.strictEqual(row.status, '待验证', 'S10c：⭐ unblock 同事务内重跑 runWGate，原子推进待验证（HIGH 修复验证：不再永久卡死 DEV）');
    const tl = await get(`SELECT event_type FROM sys_issue_timeline WHERE issue_id=? AND event_type='status_change' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl, 'S10c：W-GATE 自动转移留痕 timeline');
    await selfCertifyProbes('S10c');
    ok('S10c：⭐ HIGH 修复回归①——blocked 单卡死场景：excuse 达全完成态但资格不合格 → unblock 后同事务原子推进待验证（不再永久卡死）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10d：[codex 99 号 HIGH 修复回归②] 死锁场景二——bug 未填 dev_estimated_at 时 excuse 最后成员（GATE 保持
  //   处理中），之后补 estimate 应在同一事务内重跑 runWGate、原子推进待验证
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('bug', '处理中', { devEstimatedAt: null });
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, 'S10d：excuse 200');
    assert.strictEqual(r.body.main_status, '处理中', 'S10d：全完成态但 dev_estimated_at 未填，GATE 资格纵深拦下仍卡在处理中');
    let row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '处理中', 'S10d：sys_issues.status 落库仍处理中（GATE 未推进）');
    // 修复前：estimate 只写 dev_estimated_at，GATE 永不重跑，工单卡死；修复后：estimate 事务尾部重跑 runWGate
    // [C7] 本组夹具是 **bug** 单（mkIssue('bug', ...)）——bug 无工期维度，estimate 端点对其"传值即拒"
    //   400 EFFORT_NOT_APPLICABLE，故这里刻意不带 estimated_effort_days（与本文件 feature 夹具的 estimate
    //   调用不同源，不是漏加）。
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok(5), { dev_estimated_at: futureEst(30) });
    assert.strictEqual(r.status, 200, `S10d：补填 estimate 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status, dev_estimated_at FROM sys_issues WHERE id = ?', [id]);
    assert.ok(row.dev_estimated_at, 'S10d：dev_estimated_at 已落库');
    assert.strictEqual(row.status, '待验证', 'S10d：⭐ estimate 同事务内重跑 runWGate，原子推进待验证（HIGH 修复验证：bug 流同样不再永久卡死）');
    await selfCertifyProbes('S10d');
    ok('S10d：⭐ HIGH 修复回归②——bug 流卡死场景：excuse 达全完成态但 dev_estimated_at 未填 → 补 estimate 后同事务原子推进待验证');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10e：[codex 100 号 HIGH-1 反例①] submit→return→estimate 应保持 DEV——return 是「新一轮」语义（roster
  //   完成态保留但需重新开发提交，非"资格暂缺待修复"），return 清 gate_deferred_at，estimate 后不应被误判
  //   为消费 deferred 弹回待验证（方案 B 已证伪的死锁场景，方案 A 的核心反例）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'S10e：submit 200');
    assert.strictEqual(r.body.main_status, '待验证', 'S10e：唯一在册开发完成 → 待验证');
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '列不齐' });
    assert.strictEqual(r.status, 200, 'S10e：return 200');
    let row = await get('SELECT status, dev_estimated_at, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10e：return → 开发中');
    assert.strictEqual(row.dev_estimated_at, null, 'S10e：return 清 dev_estimated_at（T-M2）');
    assert.strictEqual(row.gate_deferred_at, null, 'S10e：return 清 gate_deferred_at（新一轮，非 deferred 待修复）');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(memberRow.dev_status, 'no_code', 'S10e：roster 完成态保留（§1 不变量1「完成态不回 pending」，return 不重置）');
    // 关键反例：补 estimate 后不应被误判为 deferred 消费，应保持开发中（非弹回待验证）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok(5), { dev_estimated_at: futureEst(31), estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `S10e：estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10e：⭐ estimate 后仍开发中（未被误弹回待验证——gate_deferred_at 为空，estimate 不重跑 runWGate）');
    ok('S10e：⭐ HIGH-1 反例①——submit→return→estimate 保持开发中（方案 B 死锁场景已证伪，方案 A 不重蹈覆辙）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10f：[codex 100 号 HIGH-1 反例②] submit→return→feasibility 应保持 DEV（同 S10e，经 feasibility 端点验证）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await run(`UPDATE sys_issues SET needs_feasibility = 1, assigned_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    // needs_feasibility=1 单：submit 前需先经 feasibility 端点写 dev_estimated_at（estimate 端点对此类单被
    //   ESTIMATE_REQUIRES_FEASIBILITY 拦截），此处先走一次 feasibility 建立初始合格态
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] feature+nf=1 起工期必填，补 estimated_effort_days。
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok(5), {
      conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: futureEst(32), estimated_effort_days: 2,
    });
    assert.strictEqual(r.status, 200, `S10f：首次 feasibility 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'S10f：submit 200');
    assert.strictEqual(r.body.main_status, '待验证', 'S10f：唯一在册开发完成 → 待验证');
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '评估需重新确认' });
    assert.strictEqual(r.status, 200, 'S10f：return 200');
    let row = await get('SELECT status, feasibility_conclusion, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10f：return → 开发中');
    assert.strictEqual(row.feasibility_conclusion, null, 'S10f：return 清评估（F2a §六，新一轮重评）');
    assert.strictEqual(row.gate_deferred_at, null, 'S10f：return 清 gate_deferred_at');
    // 关键反例：补 feasibility 后不应被误判为 deferred 消费，应保持开发中
    // [v1.1 §3.2·C2] return 已清空 estimated_effort_days（§8 换轮清空），二次 feasibility 须重新补填。
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok(5), {
      conclusion: '可行', requirement_confirm: '重新确认', dev_estimated_at: futureEst(33), estimated_effort_days: 2,
    });
    assert.strictEqual(r.status, 200, `S10f：二次 feasibility 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10f：⭐ feasibility 后仍开发中（未被误弹回待验证）');
    ok('S10f：⭐ HIGH-1 反例②——submit→return→feasibility 保持开发中（同 S10e，经 feasibility 端点验证）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10g：[codex 100 号 HIGH-1 反例③] reopen→estimate 应保持 DEV（reopen 同 return 语义，SQL 快进到"已关闭"
  //   仅作非 submit 场景准备，reopen/estimate 本身走真实路由）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');   // seed 占位态，随后 SQL 快进到已关闭（非 submit 行为，场景准备用途合规）
    const daId = await mkMember(id, 5, '开发甲', 'no_code');   // 已完成态成员（模拟原周期已提交）
    await run(`UPDATE sys_issues SET status='已关闭', assigned_to=5, assigned_to_name='开发甲', assigned_at=datetime('now','localtime'),
               accepted_at='2026-07-01 10:00', closed_at='2026-07-02 10:00', dev_estimated_at='2026-06-25 10:00' WHERE id=?`, [id]);
    let r = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '上线后回归缺陷' });
    assert.strictEqual(r.status, 200, `S10g：reopen 200, got ${r.status} ${JSON.stringify(r.body)}`);
    let row = await get('SELECT status, dev_estimated_at, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10g：reopen → 开发中');
    assert.strictEqual(row.dev_estimated_at, null, 'S10g：reopen 清 dev_estimated_at');
    assert.strictEqual(row.gate_deferred_at, null, 'S10g：reopen 清 gate_deferred_at');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(memberRow.dev_status, 'no_code', 'S10g：roster 完成态保留（reopen 不重置 dev_status，同 return）');
    // 关键反例：补 estimate 后不应被误判为 deferred 消费，应保持开发中
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok(5), { dev_estimated_at: futureEst(34), estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `S10g：estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10g：⭐ estimate 后仍开发中（未被误弹回待验证）');
    ok('S10g：⭐ HIGH-1 反例③——reopen→estimate 保持开发中（同 return 语义，reopen/estimate 走真实路由）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10h：[codex 101 号 HIGH 反例①] hold/resume 跨族死锁——blocked+allComplete+deferred → hold（清 blocked
  //   三件套，保留 deferred）→ resume（恢复目标∈DEV 族，同事务消费 deferred）→ 断言原子进 VERIFY（不再永久卡死）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await run(`UPDATE sys_issues SET needs_feasibility = 1, assigned_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    // [v1.1 §3.2·C2] feature+nf=1 起工期必填，补 estimated_effort_days（后续 resume 触发 GATE 重判需要它非空）。
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok(5), {
      conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: futureEst(35), estimated_effort_days: 2,
    });
    assert.strictEqual(r.status, 200, `S10h：feasibility 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/blocked`, devTok(5), { reason: '等外部接口联调' });
    assert.strictEqual(r.status, 200, `S10h：blocked 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, 'S10h：excuse 200');
    assert.strictEqual(r.body.main_status, '开发中', 'S10h：全完成态但 blocked=1，GATE 拦下仍开发中');
    let row = await get('SELECT gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.ok(row.gate_deferred_at, 'S10h：gate_deferred_at 已置位（excuse 触发 GATE 判定不合格）');
    r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '业务方临时叫停' });
    assert.strictEqual(r.status, 200, `S10h：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status, blocked, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '已暂缓', 'S10h：hold → 已暂缓');
    assert.strictEqual(row.blocked, 0, 'S10h：hold 清 blocked（F2b §⑥ 暂缓即解除受阻）');
    assert.ok(row.gate_deferred_at, 'S10h：⭐ hold 保留 gate_deferred_at（codex 101 号裁断"合理"——resume 消费）');
    // 关键反例：resume 恢复到开发中（DEV 族），同事务消费 deferred——此时 blocked 已清、feasibility/estimate
    //   仍完好，资格已合格，应原子推进待验证（不再是"unblock 因未受阻被拒、submit 因非 pending 被拒"的死锁）
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S10h：验证 deferred 消费' });
    assert.strictEqual(r.status, 200, `S10h：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待验证', 'S10h：⭐ resume 响应体反映 GATE 消费后的最终状态=待验证');
    row = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '待验证', 'S10h：⭐ sys_issues.status 落库=待验证（resume 同事务原子推进）');
    assert.strictEqual(row.gate_deferred_at, null, 'S10h：deferred 标记随进 VERIFY 一并原子清除');
    ok('S10h：⭐ HIGH 反例①——blocked+allComplete+deferred → hold(清blocked,保留deferred) → resume(同事务消费deferred) → 原子进待验证（不再永久卡死）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10i：[codex 101 号 HIGH 反例②] hold 期间加新 pending → resume → 保持 DEV 且 deferred 标记被清（runWGate
  //   自身 inDev∧!allComplete 清标分支覆盖，非额外新代码）
  // ══════════════════════════════════════════════════════════════════════
  {
    // [S12 双路审查 codex 287 号 C 项收口] 原注释曾写"hold 具名边仅定义于 CHANGE_FLOW_TRANSITIONS
    // （feature/improvement），BUG_FLOW_TRANSITIONS 无对应条目（bug 不支持 hold）"——两处均已过期订正：
    // ① CHANGE_FLOW_TRANSITIONS 该数组 C4 起已拆分为 FEATURE_FLOW_TRANSITIONS/IMPROVEMENT_FLOW_TRANSITIONS
    //   两份独立数组；② bug暂缓方案（20260803 v0.4）已给 BUG_FLOW_TRANSITIONS 补上 hold 条目（见
    //   transitions.js:951），"bug 不支持 hold"的旧前提不再成立。本例仍延用 feature 型的真实理由改为
    //   ——与 S10h（同一 HIGH 反例①/②系列，紧邻上方）保持同型延续，场景换成"未估时"触发 deferred
    //   （与 S10h 的"受阻"触发互补，覆盖 isGateEligibleForVerify 的另一维度），非受制于 bug 缺 hold。
    const id = await mkIssue('feature', '开发中', { devEstimatedAt: null });
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假' });
    assert.strictEqual(r.status, 200, 'S10i：excuse 200');
    assert.strictEqual(r.body.main_status, '开发中', 'S10i：全完成态但未估时，GATE 拦下仍开发中');
    let row = await get('SELECT gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.ok(row.gate_deferred_at, 'S10i：gate_deferred_at 已置位');
    r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '暂缓排期' });
    assert.strictEqual(r.status, 200, `S10i：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '已暂缓', 'S10i：hold → 已暂缓');
    assert.ok(row.gate_deferred_at, 'S10i：hold 保留 gate_deferred_at');
    // 暂缓期间加新 pending（D_PRE 族允许，矩阵 §4.3 主状态不动）——打破先前"全完成态"
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `S10i：暂缓期间加人应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '已暂缓', 'S10i：D_PRE 族加人主状态不动，仍已暂缓');
    // 关键反例：resume 恢复到开发中（DEV 族，roster 现含 1 个新 pending，非全完成态）——runWGate 判定
    //   inDev∧!allComplete，自身清标分支处理，不应误进待验证
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S10i：验证新 pending 打破全完成态' });
    assert.strictEqual(r.status, 200, `S10i：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '开发中', 'S10i：⭐ resume 响应体=开发中（新 pending 打破全完成态，未被误进待验证）');
    row = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10i：⭐ sys_issues.status 落库仍开发中');
    assert.strictEqual(row.gate_deferred_at, null, 'S10i：⭐ deferred 标记已被 runWGate 自身 inDev∧!allComplete 分支清除（陈旧标记，非死锁场景复用）');
    ok('S10i：⭐ HIGH 反例②——hold 期间加新 pending → resume 保持开发中 + deferred 标记被清（runWGate 既有清标分支覆盖，无需额外代码）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10j：[codex 102 号 MED 回填] updated_at 回滚断言补真——runWGate 在"状态 UPDATE 后 timeline INSERT 处"
  //   注入失败：状态 UPDATE（含 updated_at）已先执行，随后 timeline INSERT 失败触发整事务回滚，验证
  //   status/updated_at 均回退到种子旧值（"已写后回滚"，非 101 号三处用例的"前置拒绝未误刷"）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    injectFailureFired = false;
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥/D17·C4] runWGate 的 timeline INSERT 新增 action_code 列
    //   （原恒隐式 NULL，H1 技术根源，C4 已修复），VALUES 占位符从 6 个 ? 变 7 个 ?——旧 marker 字面量已不
    //   再是新 SQL 的子串，命中不了注入点，故意让本测试静默失去意义（symptom：500 变 200）。同步更新。
    injectFailureOnSql = `VALUES (?, 'status_change', ?, ?, ?, ?, ?, ?)`;   // 命中 runWGate 自身 timeline INSERT（状态+updated_at UPDATE 之后、commit 之前）
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 500, `S10j：故障注入应 500, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(injectFailureFired, 'S10j：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）');
    injectFailureOnSql = null; injectFailureFired = false;   // 复位
    const row = await get('SELECT status, updated_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10j：⭐ status 回滚到原态（未被误落库为待验证）');
    assert.strictEqual(row.updated_at, '2020-01-01 00:00:00', 'S10j：⭐ updated_at 回滚到种子旧值（runWGate 状态 UPDATE 的 updated_at 一并随事务回滚，非"从未写过"）');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(memberRow.dev_status, 'pending', 'S10j：成员 dev_status 回滚仍 pending（excuse 自身的 UPDATE 同随事务回滚）');
    const tl = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='status_change'`, [id]);
    assert.strictEqual(tl.length, 0, 'S10j：timeline 零残留（INSERT 本身即注入点，未提交）');
    ok('S10j：runWGate 状态 UPDATE 后于自身 timeline INSERT 处注入失败 → 整事务回滚，status/updated_at/成员 dev_status/timeline 全部回到写入前状态（真正"已写后回滚"）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10k：[codex C3 对抗审 HIGH-A 回填 反例①] 待上线单 hold→换血（移除完成态成员+加新 pending）→resume→
  //   200 自动降级恢复到「开发中」，新成员可正常估时+提交走完流程（不再永久 400 卡死）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const daId = await mkMember(id, 5, '开发甲', 'no_code');   // 原完成态成员（模拟已走完 submit→accept 到待上线）
    let r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '业务方临时叫停' });
    assert.strictEqual(r.status, 200, `S10k：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id])).status, '已暂缓', 'S10k：hold → 已暂缓');
    // 暂缓期换血：移除原完成态成员（D_PRE 族允许移到零在册，S15 既有事实），加入新成员（全新 pending）
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId}`, adminTok, { reason: '暂缓期换人' });
    assert.strictEqual(r.status, 200, `S10k：暂缓期移除原成员应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `S10k：暂缓期加新成员应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // 关键：resume 恢复目标本应是「待上线」（RELEASE 族），但当前 roster=[6:pending]（非全完成）→ 自动降级到「开发中」
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    // ⚠️ [S1b·M-1] reason 文案刻意不含「自动降级」「待上线」等断言要检查的关键词，防子断言巧合命中掩盖真实缺陷。
    const s10kResumeReason = 'S10k 降级路径审计留痕验证专用原因';
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: s10kResumeReason });
    assert.strictEqual(r.status, 200, `S10k：⭐ resume 应 200（自动降级，不再永久 400 卡死）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '开发中', 'S10k：⭐ resume 响应体 status=开发中（降级后的实际落点）');
    assert.strictEqual(r.body.degraded, true, 'S10k：⭐ 响应体标记 degraded=true');
    assert.strictEqual(r.body.original_target, '待上线', 'S10k：⭐ 响应体 original_target=待上线（如实记录原目标）');
    const row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10k：sys_issues.status 落库=开发中');
    const tl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='resume' ORDER BY id DESC LIMIT 1`, [id]);
    // ⭐ [S1b·M-1 降级路径审计断言·codex 236 MED-1] 此前只断言「自动降级」+ 原目标两个关键词，未证 reason 原文
    //   也真落库——降级分支的 summary 拼法是 `恢复到「X」（自动降级，原目标「Y」...）｜原因：<reason>`，三者须
    //   同时出现在同一条 resume timeline 行里，缺任一都判定失败（防止只改了拼接前半段却漏了 reason 尾巴）。
    assert.ok(tl && tl.summary && tl.summary.includes('自动降级') && tl.summary.includes('待上线') && tl.summary.includes(s10kResumeReason),
      `S10k：timeline summary 备注自动降级+原目标+reason 原文三者齐全，实际：${tl && tl.summary}`);
    // 新成员可正常走完估时+提交流程（验证降级后不是"死单"，能正常继续干活）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok(6), { dev_estimated_at: futureEst(36), estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `S10k：降级后新成员 estimate 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(6), { mode: 'no_code', no_code_reason: '换血后完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `S10k：降级后新成员 submit 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', 'S10k：⭐ 降级后正常走完流程，全完成 → W-GATE 转待验证（非死单）');
    ok('S10k：⭐ HIGH-A 反例①——待上线单 hold→换血（移除完成态成员+加新 pending）→resume 自动降级到开发中（200，非永久 400）→新成员正常估时+提交走完流程');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10l：[codex C3 对抗审 HIGH-A 回填 反例②] 全完成 hold→resume→照旧回待上线（roster 满足门禁，不降级，不受影响）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    // RC-M5 不变量（[4]）要求 REQUIRES_ASSIGNEE_STATUSES 目标态须有 assigned_to——真实流程由 electRepresentative
    // 选举写入，此处种子直插库需同步补上（否则 resume 恢复到「待上线」会被 NO_ASSIGNEE_FOR_DEV_STATE 拦，
    // 与本用例要验证的降级逻辑无关，纯粹是治具字段缺失）。
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime'), assigned_to = 5, assigned_to_name = '开发甲' WHERE id = ?`, [id]);
    await mkMember(id, 5, '开发甲', 'no_code');   // 全完成态成员，未换血
    let r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '短暂搁置' });
    assert.strictEqual(r.status, 200, `S10l：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S10l：验证全完成态照旧恢复' });
    assert.strictEqual(r.status, 200, `S10l：resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', 'S10l：⭐ roster 满足原门（在册≥1∧全完成）→ 照旧恢复到待上线，不降级');
    assert.ok(!r.body.degraded, 'S10l：⭐ 响应体不含 degraded 标记（未降级路径）');
    const row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '待上线', 'S10l：sys_issues.status 落库=待上线（不受本次改动影响）');
    ok('S10l：⭐ HIGH-A 反例②——全完成态 hold→resume 照旧恢复到待上线（roster 满足门禁不降级，既有正常路径零回归）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10m：[codex C3 对抗审 HIGH-A 回填 反例③] 零在册 hold→resume 400（降级后仍被 enteringDev 拦，合理）→
  //   add 成员补至少 1 名 → resume 降级成功（逃生口：暂缓期先加人再 resume）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const daId = await mkMember(id, 5, '开发甲', 'no_code');
    let r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '搁置' });
    assert.strictEqual(r.status, 200, `S10m：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // 暂缓期移到零在册（D_PRE 族允许，S15 既有事实）
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId}`, adminTok, { reason: '暂缓期清空' });
    assert.strictEqual(r.status, 200, `S10m：暂缓期移除到零在册应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rosterZero = await get(`SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL`, [id]);
    assert.strictEqual(rosterZero.c, 0, 'S10m：确认此刻零在册');
    // 关键反例：resume 降级到「开发中」后仍被 enteringDev 拦（要求在册≥1，零在册不满足）→ 400
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']——reason 必填校验
    //   早于 GATE 判定执行，此处仍须传合法 reason，否则会误命中 RESUME_REASON_REQUIRED 而非本例要验证的
    //   GATE_INVARIANT，把测试意图打偏。
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S10m：验证零在册仍被 GATE 拦' });
    assert.strictEqual(r.status, 400, `S10m：⭐ 零在册 resume 应 400（降级后仍被 enteringDev 拦，合理）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', 'S10m：错误码 GATE_INVARIANT');
    const rowStillHeld = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(rowStillHeld.status, '已暂缓', 'S10m：resume 失败，单仍停在已暂缓（未落库任何变化）');
    // 逃生口：暂缓期先加至少 1 名成员，再 resume → 降级成功
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `S10m：补加成员应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: 'S10m：补加成员后验证降级成功' });
    assert.strictEqual(r.status, 200, `S10m：⭐ 补加成员后 resume 应 200（降级成功）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '开发中', 'S10m：⭐ 降级到开发中，逃生口生效');
    assert.strictEqual(r.body.degraded, true, 'S10m：响应体标记 degraded=true');
    ok('S10m：⭐ HIGH-A 反例③——零在册 hold→resume 400 GATE_INVARIANT（降级仍不满足 enteringDev，合理）→ add 成员补至少 1 名 → resume 降级成功（暂缓期先加人再 resume 的逃生口验证）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10n：[工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] GATE 纵深新增分支——feature+nf=1 单评估已合格
  //   （conclusion/confirm/dev_estimated_at/assigned_at/blocked 全部合格）但 estimated_effort_days
  //   仍缺，全员完成态时 GATE 资格过滤应拦下（不推进待验证），同 S10b（blocked=1）/S10d（bug 缺
  //   dev_estimated_at）的既有 GATE 纵深范式——isGateEligibleForVerify 是与 submit/feasibility 端点
  //   各自独立的实现（同判据、非共享代码，"两处判定同构、非独立设计"范式），需单独验证其自身分支，
  //   不能只信任端点层已测过。
  //   ⚠️ 正常业务路径下"评估已合格但工期未填"不可达（feasibility 端点原子写入两者，缺一即 400 EFFORT_REQUIRED），
  //   此处直接 SQL 造脏模拟——防御性 fail-safe，同 verify-sys-multidev-submit.js mkFeasIssue 系列的既有测法。
  //   ⚠️⚠️ [codex 269 号 H-1 收口] 原版只 UPDATE 了 needs_feasibility/conclusion/confirm/effort=NULL 四列，
  //   隐式依赖 mkIssue 默认会填一个非空的未来 dev_estimated_at——若该默认值将来改变（或被误改成 null），
  //   本测试会变成"测的是别的缺口"而非"仅测工期缺口"这一件事，却仍可能凑巧通过（假绿）。改为**显式**
  //   一次性 UPDATE 齐 assigned_at/dev_estimated_at/blocked/conclusion/confirm 到确定合格值，并在触发
  //   excuse 之前用共享的 assertGateOldConditionsAllPass 断言 isGateEligibleForVerify 真实判据集里除
  //   工期外的全部条件已合格，只留 estimated_effort_days=NULL 这一个显式缺口——测试意图不再依赖任何
  //   隐式默认，未来谁改了 mkIssue 默认值本测试也不会被带偏。
  //   ⚠️⚠️⚠️ [codex 270 号 M-1] assigned_at 不在 assertGateOldConditionsAllPass 断言范围内——已 grep
  //   isGateEligibleForVerify 源码实测确认该函数从未读取 assigned_at，本处仍显式写入它只是为了让
  //   dev_estimated_at 的"晚于指派时间"业务语义在夹具层面保持自洽（非 GATE 判据要求）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime'), dev_estimated_at = ?,
               blocked = 0, needs_feasibility = 1, feasibility_conclusion = '可行',
               feasibility_requirement_confirm = '已确认', estimated_effort_days = NULL WHERE id = ?`,
      [futureEst(40), id]);
    await assertGateOldConditionsAllPass('S10n 前置', id);
    const preEffort = await get('SELECT estimated_effort_days FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(preEffort.estimated_effort_days, null, 'S10n 前置：estimated_effort_days 确为 NULL（本用例唯一缺口，与上方旧闸条件全格形成对照）');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, `S10n：excuse 本身应仍 200（成员动作不受工期缺失拦截），实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.dev_status, 'excused', 'S10n：目标 dev_status=excused（成员写入不受影响）');
    // 关键反例：全员完成态已达成，其余旧闸条件（上方前置断言）全部合格，唯独 estimated_effort_days 缺
    // → GATE 拦下，main_status 仍「开发中」——若把 isGateEligibleForVerify 里新增的工期判据删掉，本例
    // 会因为其余条件全合格而误判 eligible=true 直接放行，这条断言才是真正钉住新判据存在与否的地方。
    assert.strictEqual(r.body.main_status, '开发中', 'S10n：⭐ 工期缺失单全员完成态也不应被 GATE 推进——main_status 仍「开发中」（isGateEligibleForVerify 新分支）');
    const row = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10n：sys_issues.status 落库仍「开发中」（GATE 未触发状态变更）');
    assert.ok(row.gate_deferred_at, 'S10n：gate_deferred_at 已置位（等待 feasibility 补工期消费）');
    // 补工期后应同事务原子推进待验证（同 S10c「补齐条件后重跑消费」范式）
    const r2 = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok(5), {
      conclusion: '可行', requirement_confirm: '补填工期', dev_estimated_at: futureEst(36), estimated_effort_days: 5,
    });
    assert.strictEqual(r2.status, 200, `S10n：补填工期 feasibility 应 200，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    const row2 = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row2.status, '待验证', 'S10n：⭐ 补填工期后同事务重跑 runWGate，原子推进待验证（不再永久卡死）');
    assert.strictEqual(row2.gate_deferred_at, null, 'S10n：deferred 标记随进 VERIFY 一并清除');
    await selfCertifyProbes('S10n');
    ok('S10n：⭐ [v1.1 §3.2] GATE 纵深新分支——feature+nf=1 评估合格但工期缺失（旧闸四项条件显式钉死合格，非隐式默认），全员完成态被 GATE 拦下（isGateEligibleForVerify 独立实现同判据，非 submit 端点代码）→ 补填工期后同事务原子推进待验证（deferred 消费）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S10o：[codex 269 号 H-1 补充反例 + M-1 存储值复查] GATE 存储值复查——estimated_effort_days 非空但
  //   归一失败（脏值，如历史直连 SQL/旧 ALTER 路径无 DDL CHECK 写入的非法值 1.3）时，GATE 仍应视同缺失
  //   不放行——"非 NULL 不等于合法"，同 S10n 但换一种缺口形态（脏值 vs 全空），配合 isGateEligibleForVerify
  //   新增的 normalizeSysEffortDays 存储值复查分支。旧闸条件同 S10n 用共享断言钉死合格。
  //   ⚠️ 本文件的 sys_issues 走**全新 CREATE TABLE 路径**（mod.initSchema() 建全新 :memory: 库），该路径
  //   本就带 DDL CHECK——1.3 直接 UPDATE 会被 SQLite 自身拒绝，测不出"脏值已落库、只能靠服务端 fail-safe"
  //   这个场景（那只在 ALTER 旧库路径无 CHECK 时才会真实发生，见 C1 既有降级拍板）。用共享封装
  //   withIgnoredCheckConstraints 临时关闭本连接的 CHECK 强制、写入脏值后 finally 无条件恢复，模拟"这条
  //   脏数据是通过没有 CHECK 的路径（旧 ALTER 库/历史直连 SQL）进来的"——不影响本文件其余用例仍然享有
  //   CHECK 保护（仅本用例这一次 UPDATE 期间临时开关）。
  //   [codex 270 号 M-1] 写脏值那条 UPDATE 与 S10n 是同一条语句（只有 estimated_effort_days 的值不同），
  //   写完后同样调 assertGateOldConditionsAllPass 复核——证明这条 UPDATE 没有连带把其余旧闸条件写坏，
  //   本用例红/绿只由 estimated_effort_days 这一个字段的合法性决定，不是巧合命中了别的缺口。
  {
    const id = await mkIssue('feature', '开发中');
    await withIgnoredCheckConstraints(async () => {
      await run(`UPDATE sys_issues SET assigned_at = datetime('now','localtime'), dev_estimated_at = ?,
                 blocked = 0, needs_feasibility = 1, feasibility_conclusion = '可行',
                 feasibility_requirement_confirm = '已确认', estimated_effort_days = 1.3 WHERE id = ?`,
        [futureEst(41), id]);
    });
    const preEffort = await get('SELECT estimated_effort_days FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(preEffort.estimated_effort_days, 1.3, 'S10o 前置：estimated_effort_days=1.3 脏值确已直接落库（ALTER 路径无 DDL CHECK，服务端 fail-safe 前必须先证明脏值真能落库，非白测一个数据库本就会拒绝的场景）');
    await assertGateOldConditionsAllPass('S10o 前置', id);
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '请假一周' });
    assert.strictEqual(r.status, 200, `S10o：excuse 本身应仍 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '开发中', 'S10o：⭐ estimated_effort_days=1.3（非 0.5 整数倍脏值）全员完成态也不应被 GATE 推进——main_status 仍「开发中」（存储值复查新分支：非 NULL 不等于合法）');
    const row = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S10o：sys_issues.status 落库仍「开发中」');
    assert.ok(row.gate_deferred_at, 'S10o：gate_deferred_at 已置位');
    await selfCertifyProbes('S10o');
    ok('S10o：⭐ [codex 269 号 M-1] GATE 存储值复查——estimated_effort_days=1.3 脏值（非 0.5 整数倍，历史/ALTER 路径无 CHECK 写入）视同缺失，全员完成态仍被拦下（非 NULL 不等于合法，读侧闸自防）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S11：excuse 非 SYS_DEV → 409
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');   // D_PRE
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/excuse`, adminTok, { reason: '测试' });
    assert.strictEqual(r.status, 409, `S11：D_PRE 态 excuse 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    // M6（91 号审·既有测试变更）：族门不满足从 GATE_INVARIANT 改归 INVALID_STATUS——GATE_INVARIANT 收窄只留
    //   主状态非法边/进族 roster 不满足/W-GATE UPDATE changes 冲突三类"守卫内部不变量"，"当前状态不允许该
    //   成员动作"是业务语义不匹配，应与 §10 契约的 INVALID_STATUS 对齐（S5 submit 族门同码先例）。
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S11：错误码 INVALID_STATUS（主状态族门，M6/91 号审改码）');
    const after = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(after.dev_status, 'pending', 'S11：拒绝后目标 dev_status 未变');
    ok('S11：excuse 仅 SYS_DEV 生效——D_PRE 态调用 → 409 INVALID_STATUS，目标未被修改');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S12：supersede 正常流——先 removed 再 insert 无双在册；新实例同 user_id 且创建时点 pending；
  //       related=superseded_by=newId 三者一致
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'excused');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/supersede-excuse`, adminTok, { reason: '身体恢复，顶替回来' });
    assert.strictEqual(r.status, 200, `S12：supersede-excuse 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const newId = r.body.new_dev_assignee_id;
    assert.ok(newId && newId !== daId, 'S12：新实例 id 与旧实例不同');
    const oldRow = await get('SELECT user_id, dev_status, removed_at, superseded_by FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    const newRow = await get('SELECT user_id, dev_status, removed_at FROM sys_issue_dev_assignees WHERE id = ?', [newId]);
    assert.ok(oldRow.removed_at, 'S12：旧实例已软删');
    assert.strictEqual(oldRow.superseded_by, newId, 'S12：旧实例 superseded_by=newId');
    assert.strictEqual(newRow.user_id, oldRow.user_id, 'S12：新实例 user_id 与旧实例相同（同一开发恢复，非换人）');
    assert.strictEqual(newRow.dev_status, 'pending', 'S12：新实例创建时点 dev_status=pending');
    assert.strictEqual(newRow.removed_at, null, 'S12：新实例在册');
    const activeRows = await activeMembers(id);
    assert.strictEqual(activeRows.filter(a => a.user_id === oldRow.user_id).length, 1, 'S12：同 user_id 在册恰 1 条（无双在册）');
    const ev = await get(`SELECT dev_assignee_id, related_dev_assignee_id, reason FROM sys_issue_dev_events WHERE action='supersede-excuse' AND dev_assignee_id = ?`, [daId]);
    assert.ok(ev, 'S12：supersede-excuse 事件已写');
    assert.strictEqual(ev.related_dev_assignee_id, newId, 'S12：event related=newId');
    assert.strictEqual(ev.related_dev_assignee_id, oldRow.superseded_by, 'S12：event related 与旧行 superseded_by 一致（三者一致）');
    await selfCertifyProbes('S12');
    ok('S12：supersede 正常流——先 removed 再 insert 无双在册 + 新实例同 user_id 创建时点 pending + related=superseded_by=newId 三者一致');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S13：supersede 目标非 excused → 400 SUPERSEDE_PRECONDITION
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');   // 非 excused
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/supersede-excuse`, adminTok, { reason: '误操作测试' });
    assert.strictEqual(r.status, 400, `S13：目标非 excused 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SUPERSEDE_PRECONDITION', 'S13：错误码 SUPERSEDE_PRECONDITION');
    const after = await activeMembers(id);
    assert.strictEqual(after.length, 1, 'S13：拒绝后在册行数未变（未产生新实例）');
    ok('S13：supersede-excuse 目标非 excused（pending）→ 400 SUPERSEDE_PRECONDITION，未产生新实例');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S14：remove/self-remove 最后一名（DEV∪VERIFY）→ 400 LAST_ASSIGNEE
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId}`, adminTok, { reason: '协调人移除测试' });
    assert.strictEqual(r.status, 400, `S14：DEV 态移除最后一名应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LAST_ASSIGNEE', 'S14a（协调人移除）：错误码 LAST_ASSIGNEE');

    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId}`, devTok(5), { reason: '本人自行移除测试' });
    assert.strictEqual(r.status, 400, `S14：DEV 态自行移除最后一名应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LAST_ASSIGNEE', 'S14b（本人 self-remove）：错误码 LAST_ASSIGNEE');
    const after = await activeMembers(id);
    assert.strictEqual(after.length, 1, 'S14：拒绝后在册行数未变');

    // VERIFY 态同理
    const id2 = await mkIssue('feature', '待验证');
    const daId2 = await mkMember(id2, 5, '开发甲', 'code_submitted');
    r = await call('DELETE', `/api/sys-issues/${id2}/dev-assignees/${daId2}`, adminTok, { reason: '测试' });
    assert.strictEqual(r.status, 400, 'S14c（VERIFY 态）：应 400');
    assert.strictEqual(r.body.code, 'LAST_ASSIGNEE', 'S14c：错误码 LAST_ASSIGNEE');
    ok('S14：remove（协调人）/self-remove（本人）移除 DEV∪VERIFY 态在册最后一名 → 均 400 LAST_ASSIGNEE，目标未被修改');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S15：D_PRE 加/移人 → 允许；主状态不动；移最后一名允许
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r.status, 200, `S15：D_PRE 加人应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.added_dev_assignee_ids.length, 2, 'S15：2 人均成功加入');
    let row = await issueRow(id);
    assert.strictEqual(row.status, '待指派', 'S15：加人后主状态不动（D_PRE 矩阵"预指派"）');

    const members = await activeMembers(id);
    for (const m of members) {
      r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${m.id}`, adminTok, { reason: '预指派撤回' });
      assert.strictEqual(r.status, 200, `S15：D_PRE 移人应 200（含最后一名），实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
    row = await issueRow(id);
    assert.strictEqual(row.status, '待指派', 'S15：移空后主状态仍不动');
    assert.strictEqual(row.assigned_to, null, 'S15：移空后 assigned_to=NULL（选举④零在册分支）');
    const remaining = await activeMembers(id);
    assert.strictEqual(remaining.length, 0, 'S15：D_PRE 可移到零在册（无 LAST_ASSIGNEE 限制）');
    await selfCertifyProbes('S15');
    ok('S15：D_PRE 加/移人 → 主状态不动 + 可移最后一名到零在册（无 LAST_ASSIGNEE 限制）+ 选举零在册分支正确');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S16：待验证加 pending → 同事务主状态回 SYS_DEV（W-GATE）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');
    await mkMember(id, 5, '开发甲', 'code_submitted');   // 唯一在册，已完成（满足 P14 恒真前置）
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `S16：待验证加人应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '开发中', 'S16：新增 pending 打破全完成态 → W-GATE 同事务转开发中');
    const row = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S16：sys_issues.status 已落库为开发中');
    await selfCertifyProbes('S16');
    ok('S16：待验证态加人（新 pending）→ 同事务主状态回「开发中」（W-GATE VERIFY→DEV）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S22：代表选举——remove 现代表→确定性补位；零在册→NULL
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r.status, 200);
    let row = await issueRow(id);
    assert.strictEqual(row.assigned_to, 5, 'S22：初始选举——两人均 pending，最小 user_id=5 当选');
    const members1 = await activeMembers(id);
    const daId5 = members1.find(m => m.user_id === 5).id;

    // remove 现代表（5）→ 确定性补位（剩 6）
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId5}`, adminTok, { reason: '代表移除测试' });
    assert.strictEqual(r.status, 200, `S22：移除代表应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.assigned_to, 6, 'S22：移除现代表后确定性补位为剩余唯一在册 6');

    // 移除最后一人（D_PRE 允许）→ 零在册 → NULL
    const members2 = await activeMembers(id);
    const daId6 = members2.find(m => m.user_id === 6).id;
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daId6}`, adminTok, { reason: '清空测试' });
    assert.strictEqual(r.status, 200);
    row = await issueRow(id);
    assert.strictEqual(row.assigned_to, null, 'S22：零在册 → assigned_to=NULL（选举④）');
    assert.strictEqual(row.assigned_to_name, null, 'S22：零在册 → assigned_to_name=NULL');
    ok('S22：代表选举——remove 现代表后确定性补位（剩余唯一在册当选）+ 零在册 → assigned_to/_name 均 NULL');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S24：re-add——曾 removed 用户新实例 pending；uq 索引防双在册
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5] });
    const firstDaId = r.body.added_dev_assignee_ids[0];
    r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${firstDaId}`, adminTok, { reason: '先移除测试 re-add' });
    assert.strictEqual(r.status, 200);

    // re-add 同一 user_id
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, `S24：re-add 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const secondDaId = r.body.added_dev_assignee_ids[0];
    assert.notStrictEqual(secondDaId, firstDaId, 'S24：re-add 产生全新实例 id（非复活旧行，§4.4"新建 pending 实例"）');
    const newRow = await get('SELECT dev_status, removed_at FROM sys_issue_dev_assignees WHERE id = ?', [secondDaId]);
    assert.strictEqual(newRow.dev_status, 'pending', 'S24：新实例 dev_status=pending');
    assert.strictEqual(newRow.removed_at, null, 'S24：新实例在册');
    const oldRow = await get('SELECT removed_at FROM sys_issue_dev_assignees WHERE id = ?', [firstDaId]);
    assert.ok(oldRow.removed_at, 'S24：旧实例仍保持软删（未被复活/覆盖）');

    // uq 索引防双在册：直接绕过端点用原生 SQL 插入重复在册行应被拒（索引在线约束，非探针职责）
    await assert.rejects(
      run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 5, '开发甲-重复', 'pending')`, [id]),
      /UNIQUE|constraint/i,
      'S24：uq_dev_assignee_roster（复用 idx_sys_dev_assignee_active）应拒绝同 (issue_id,user_id) 双在册'
    );
    await selfCertifyProbes('S24');
    ok('S24：re-add 曾 removed 用户 → 全新 pending 实例（非复活旧行）+ 数据库唯一索引防双在册（结构性约束）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S28：进 SYS_DEV 零在册 → 400 GATE_INVARIANT（assertMainStatusTransition 直调）
  //   ⭐ 角色权限重构 C2.5（codex Round-C 审 MED）：本组原用 `CREATE + null→处理中` 触达③层门禁。
  //     C2.5 把 CREATE 的合法落态收敛为「创建路径唯一入口的返回值」单值后，那条边在**①层**就被拒
  //     （409 GATE_INVARIANT），根本走不到③层——再用它测门禁就变成"测了个寂寞"（错误码看着还挺像）。
  //     改用 **GATE routeKind（待验证→处理中）**：①层 GATE 分支放行、②层族白名单含 DEV，
  //     恰好把③层 enteringDev 的零在册门禁单独暴露出来——被测对象与原意图逐字一致，且不依赖已收敛的 CREATE 边。
  // ══════════════════════════════════════════════════════════════════════
  {
    let threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'GATE', action: null, actionKind: null, issueType: 'bug', before: '待验证', after: '处理中', rosterActiveCount: 0 });
    } catch (e) { threw = e; }
    assert.ok(threw, 'S28：零在册进 DEV 应抛错');
    assert.strictEqual(threw.httpStatus, 400, 'S28：HTTP 状态应为 400（请求破坏门禁不变量·非 409 的边非法）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'S28：错误码 GATE_INVARIANT');
    // 反证：同一条边有在册成员时放行——证明上面的 400 确实来自③层 roster 门禁，而不是边本身不合法
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'GATE', action: null, actionKind: null, issueType: 'bug', before: '待验证', after: '处理中', rosterActiveCount: 1 }),
      'S28：同边有在册成员则放行（证明 400 来自③层门禁·非①层边非法）');
    ok('S28：assertMainStatusTransition 直调——进 SYS_DEV 零在册（GATE routeKind）→ 400 GATE_INVARIANT + 有在册则放行（③层门禁被单独暴露）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S28b：受理排期改造 guard 直调——create/reactivate/change_intake_mode 动态目标不被误拒（codex131-M2 + create 契约）
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① create dynamicTarget=initial_status：null→建单落态 均放行
    // ⭐ 角色权限重构 C2.5 撤销（v2.1）：**feature 的 CREATE 落态回归「待受理」**（PRE_DISCUSS 族整体撤销），
    //   与 bug 同源——两条 type 现走同一目标值，仍各测各的 type（防未来再分流时漏一边）。
    // codex132-L2：负向用例加谓词（证明确以 guard 不变量错误拒·非任意异常放水）
    const guard409 = (e) => e instanceof MainStatusGuardError && e.httpStatus === 409 && e.code === 'GATE_INVARIANT';
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: 'feature', before: null, after: '待受理' }), 'S28b①：feature create→待受理(INTAKE) 放行（v2.1：C2.5 撤销）');
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: 'bug', before: null, after: '待受理' }), 'S28b①：bug create→待受理(INTAKE) 放行');
    // ⭐ 角色权限重构 C2.5 + codex Round-A 审 HIGH 收紧：**CREATE 的合法落态收敛为"统一入口返回值"单值**
    //   （bug 额外保留 devStatus 供 path A/B 的死调用点，见 guard 注释）。原先还接受 `(type,0)` 的
    //   「待指派/待处理」——C0 之后没有任何入口产生该落态，留着等于给"绕过受理门"留守卫层后门。
    //   负例把收敛钉死，防日后有人"顺手放宽回去"。
    assert.throws(() => assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: 'feature', before: null, after: '待指派' }), guard409,
      'S28b①：feature create→待指派 拒（C0 后无入口产生该落态·守卫不得留后门）');
    assert.throws(() => assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: 'feature', before: null, after: '开发中', rosterActiveCount: 1 }), guard409,
      'S28b①：feature create→开发中 拒（变更流不得凭空进开发）');
    // ⭐ codex Round-C 审 MED 二次收敛：bug 的建单直置 DEV 例外**也已删除**——留一个没有活调用方的放行分支
    //   就是结构性 fail-open（对 feature 一套标准、对 bug 另一套并不自洽）。path A/B 若要复活，
    //   端点层 INTAKE_WITH_ASSIGN_CONFLICT 与本守卫必须同批放开，那本就该是一次有意决策。
    assert.throws(() => assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: 'bug', before: null, after: '处理中', rosterActiveCount: 1 }), guard409,
      'S28b①：bug create→处理中 亦拒（建单直置 DEV 的守卫后门已关·CREATE 合法落态收敛为单值）');
    // ② reactivate dynamicTarget=initial_status：合法目标同样收敛为单值（v2.1：全类型=待受理）
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'reactivate', actionKind: null, issueType: 'feature', before: '已拒绝', after: '待受理' }), 'S28b②：reactivate feature 已拒绝→待受理 放行（v2.1：C2.5 撤销）');
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'reactivate', actionKind: null, issueType: 'bug', before: '已拒绝', after: '待受理' }), 'S28b②：reactivate bug 已拒绝→待受理 放行');
    assert.throws(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'reactivate', actionKind: null, issueType: 'feature', before: '已拒绝', after: '待指派' }), guard409,
      'S28b②：reactivate feature→待指派 拒（复活落态唯一来源=创建路径统一入口·不得绕过预沟通段）');
    assert.throws(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'reactivate', actionKind: null, issueType: 'feature', before: '已拒绝', after: '开发中' }), guard409, 'S28b②：reactivate→开发中(非初始态) 拒(409 GATE_INVARIANT)');
    // ③ change_intake_mode dynamicTarget=intake_mode（codex131-M2 修·不被误拒为旁路）：待指派↔待受理/待修改 前段态放行·非前段态拒
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'change_intake_mode', actionKind: null, issueType: 'feature', before: '待指派', after: '待受理' }), 'S28b③：change_intake_mode 待指派→待受理 放行(不误拒旁路)');
    assert.doesNotThrow(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'change_intake_mode', actionKind: null, issueType: 'bug', before: '待受理', after: '待处理' }), 'S28b③：bug change_intake_mode 待受理→待处理 放行');
    assert.throws(() => assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'change_intake_mode', actionKind: null, issueType: 'feature', before: '待指派', after: '开发中' }), guard409, 'S28b③：change_intake_mode→开发中(非前段态) 拒(409 GATE_INVARIANT)');
    ok('S28b：guard 动态目标（codex131-M2）——create/reactivate initial_status + change_intake_mode intake_mode 前段态放行·非法目标拒（不误判旁路）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S28c：受理排期改造 §B——INTAKE 族成员动作天然 409（矩阵不含 INTAKE·codex131 关注点2）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 待受理/待修改（INTAKE 族）·五类成员动作全应被 assertMemberActionFamilyAllowed 拒（INVALID_STATUS 409）
    for (const st of ['待受理', '待修改']) {
      for (const act of ['add', 'remove', 'reassign', 'excuse', 'commit']) {
        assert.throws(() => I.assertMemberActionFamilyAllowed(act, 'feature', st),
          e => e && e.httpStatus === 409 && e.code === 'INVALID_STATUS',
          `S28c：INTAKE 态「${st}」成员动作「${act}」应 409 INVALID_STATUS（矩阵不含 INTAKE）`);
        assert.throws(() => I.assertMemberActionFamilyAllowed(act, 'bug', st),
          e => e && e.httpStatus === 409 && e.code === 'INVALID_STATUS',
          `S28c：bug INTAKE 态「${st}」成员动作「${act}」应 409`);
      }
    }
    ok('S28c：INTAKE 族（待受理/待修改）× 五类成员动作 × feature/bug 全 409 INVALID_STATUS（§B 受理阶段天然禁改派/加减成员·写宽读窄防护）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S31：reassign 用例组（时点断言含对称差）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 单人 A→B：不触 LAST_ASSIGNEE，remove+add 共享 operation_id，事件数=对称差，W-GATE 仅一次判定
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '单人换人 A→B' });
    assert.strictEqual(r.status, 200, `S31a：单人换人应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(r.body.added_user_ids, [6], 'S31a：added_user_ids=[6]');
    assert.deepStrictEqual(r.body.removed_user_ids, [5], 'S31a：removed_user_ids=[5]');
    const evRows = await all(`SELECT action, payload_json FROM sys_issue_dev_events WHERE issue_id = ? AND action IN ('add','remove') ORDER BY id`, [id]);
    const opPayloads = evRows.map(e => JSON.parse(e.payload_json));
    assert.strictEqual(evRows.length, 2, 'S31a：事件数=对称差=2（1 remove+1 add）');
    const opIds = new Set(opPayloads.map(p => p.operation_id));
    assert.strictEqual(opIds.size, 1, 'S31a：remove+add 共享同一 operation_id');
    await selfCertifyProbes('S31a');

    // VERIFY 仅移除已完成 → 保持 VERIFY
    const id2 = await mkIssue('feature', '待验证');
    await mkMember(id2, 5, '开发甲', 'code_submitted');
    await mkMember(id2, 6, '开发乙', 'no_code');
    r = await call('POST', `/api/sys-issues/${id2}/reassign`, adminTok, { member_ids: [6], reason: '仅移除已完成成员' });
    assert.strictEqual(r.status, 200, `S31b：仅移除应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    let row2 = await get('SELECT status FROM sys_issues WHERE id = ?', [id2]);
    assert.strictEqual(row2.status, '待验证', 'S31b：仅移除已完成成员、剩余仍全完成 → 保持 VERIFY（无新 pending）');

    // VERIFY 含新增 pending → 转 DEV
    const id3 = await mkIssue('feature', '待验证');
    await mkMember(id3, 5, '开发甲', 'code_submitted');
    r = await call('POST', `/api/sys-issues/${id3}/reassign`, adminTok, { member_ids: [5, 8], reason: '新增协作' });
    assert.strictEqual(r.status, 200, `S31c：新增应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '开发中', 'S31c：新增 pending 成员 8 → W-GATE 转开发中');

    // no-op → 400 VALIDATION
    const id4 = await mkIssue('feature', '开发中');
    await mkMember(id4, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id4}/reassign`, adminTok, { member_ids: [5], reason: '无变化测试' });
    assert.strictEqual(r.status, 400, `S31d：no-op 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'S31d：错误码 VALIDATION');

    // A→空（DEV）→ 400 LAST_ASSIGNEE
    r = await call('POST', `/api/sys-issues/${id4}/reassign`, adminTok, { member_ids: [], reason: '清空测试' });
    assert.strictEqual(r.status, 400, `S31e：DEV 态清空应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'LAST_ASSIGNEE', 'S31e：错误码 LAST_ASSIGNEE');
    // A→空（VERIFY）→ 400 LAST_ASSIGNEE
    const id5 = await mkIssue('feature', '待验证');
    await mkMember(id5, 5, '开发甲', 'code_submitted');
    r = await call('POST', `/api/sys-issues/${id5}/reassign`, adminTok, { member_ids: [], reason: '清空测试2' });
    assert.strictEqual(r.status, 400, `S31f：VERIFY 态清空应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'LAST_ASSIGNEE', 'S31f：错误码 LAST_ASSIGNEE');

    // 连续两次有效 reassign 产生不同 operation_id
    const id6 = await mkIssue('feature', '开发中');
    await mkMember(id6, 5, '开发甲', 'pending');
    let r1 = await call('POST', `/api/sys-issues/${id6}/reassign`, adminTok, { member_ids: [6], reason: '第一次换人' });
    assert.strictEqual(r1.status, 200);
    let r2 = await call('POST', `/api/sys-issues/${id6}/reassign`, adminTok, { member_ids: [8], reason: '第二次换人' });
    assert.strictEqual(r2.status, 200, `S31g：第二次换人应 200，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    const allEv = await all(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id = ? AND action IN ('add','remove') ORDER BY id`, [id6]);
    const allOpIds = [...new Set(allEv.map(e => JSON.parse(e.payload_json).operation_id))];
    assert.strictEqual(allOpIds.length, 2, 'S31g：两次 reassign 请求产生 2 个不同 operation_id（跨请求唯一）');

    await selfCertifyProbes('S31-final');
    ok('S31：reassign 用例组——单人换人(LAST_ASSIGNEE不触发+operation_id组内共享+对称差事件数) + VERIFY仅移除保持/含新增转DEV + no-op→400 VALIDATION + 清空(DEV/VERIFY)→400 LAST_ASSIGNEE + 连续两次请求 operation_id 不同');
  }

  // ══════════════════════════════════════════════════════════════════════
  // M3（C7 回填，94 号对抗审复核降级 backlog·前端改派弹窗重做时补）：reassign expected_member_ids 乐观锁
  //   —— 命中现集正常执行 / 不等→409 REASSIGN_STALE 零副作用 / 不传→向后兼容
  // ══════════════════════════════════════════════════════════════════════
  {
    // 命中现集 → 正常执行（快照=当前在册 user_id 集合，与实际一致）
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: 'M3 命中现集', expected_member_ids: [5] });
    assert.strictEqual(r.status, 200, `M3a：expected_member_ids 命中现集应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    await selfCertifyProbes('M3a');

    // 不等 → 409 REASSIGN_STALE，且同事务零副作用（在册集合与请求前逐字相同——防"部分执行后才发现锁不符"）
    const id2 = await mkIssue('feature', '开发中');
    await mkMember(id2, 5, '开发甲', 'pending');
    const beforeRows = await activeMembers(id2);
    r = await call('POST', `/api/sys-issues/${id2}/reassign`, adminTok, { member_ids: [6], reason: 'M3 不等', expected_member_ids: [5, 8] });
    assert.strictEqual(r.status, 409, `M3b：expected_member_ids 与现集不等应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'REASSIGN_STALE', 'M3b：错误码 REASSIGN_STALE');
    const afterRows = await activeMembers(id2);
    assert.deepStrictEqual(afterRows, beforeRows, 'M3b：409 REASSIGN_STALE 零副作用——在册集合与请求前逐字相同');
    await selfCertifyProbes('M3b');

    // 不传 expected_member_ids（旧调用方/其它未接线场景）→ 完全跳过校验，行为等同该字段接线之前
    const id3 = await mkIssue('feature', '开发中');
    await mkMember(id3, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id3}/reassign`, adminTok, { member_ids: [6], reason: 'M3 不传 expected' });
    assert.strictEqual(r.status, 200, `M3c：不传 expected_member_ids 应 200（向后兼容），实际 ${r.status} ${JSON.stringify(r.body)}`);
    await selfCertifyProbes('M3c');

    ok('M3：reassign expected_member_ids 乐观锁——命中现集放行 / 不等 409 REASSIGN_STALE 零副作用 / 不传向后兼容');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S32：跨类型/族外负例（成员动作侧）
  // ══════════════════════════════════════════════════════════════════════
  {
    // CHANGE 单（feature）被写成「处理中」（bug 专属状态，不在 feature 的 ALLOWED_STATUSES 里）→ 族外拒绝
    const id = await mkIssue('feature', '处理中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 409, `S32a：feature 单状态="处理中"（族外）加人应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', 'S32a：错误码 GATE_INVARIANT（assertKnownIssueStatus 族外拒绝）');

    // 未知状态（数据库层面不存在的字符串）→ 同样族外拒绝
    const id2 = await mkIssue('feature', '这是个不存在的状态');
    await mkMember(id2, 5, '开发甲', 'pending');
    r = await call('DELETE', `/api/sys-issues/${id2}/dev-assignees/1`, adminTok, { reason: '测试' });
    assert.strictEqual(r.status, 409, `S32b：未知状态应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', 'S32b：错误码 GATE_INVARIANT');

    // FROZEN 族（已上线/已作废等）→ 矩阵全 ❌，成员动作一律拒绝（M6/91 号审·既有测试变更：错误码
    //   GATE_INVARIANT → INVALID_STATUS，理由同 S11）
    const id3 = await mkIssue('feature', '已上线');
    const daId3 = await mkMember(id3, 5, '开发甲', 'code_submitted');
    r = await call('POST', `/api/sys-issues/${id3}/dev-assignees/${daId3}/excuse`, adminTok, { reason: '测试' });
    assert.strictEqual(r.status, 409, `S32c：FROZEN 族(已上线) excuse 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S32c：错误码 INVALID_STATUS（FROZEN 矩阵全 ❌，M6 改码）');
    r = await call('DELETE', `/api/sys-issues/${id3}/dev-assignees/${daId3}`, adminTok, { reason: '测试' });
    assert.strictEqual(r.status, 409, 'S32c：FROZEN 族 remove 同样 409');
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S32c：FROZEN 族 remove 错误码 INVALID_STATUS');
    r = await call('POST', `/api/sys-issues/${id3}/reassign`, adminTok, { member_ids: [6], reason: '测试' });
    assert.strictEqual(r.status, 409, 'S32c：FROZEN 族 reassign 同样 409');
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S32c：FROZEN 族 reassign 错误码 INVALID_STATUS');

    ok('S32：跨类型/族外负例——CHANGE 单写入 bug 专属状态（族外）→ 409 + 未知状态 → 409 + FROZEN 族（已上线）全部成员动作 → 409（矩阵全 ❌）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S33（C2c·codex 115 MED 回归）：reassign type 感知族门直调断言——证明「变更流去 D_PRE 不误伤 bug 待处理改派」
  //   assertMemberActionFamilyAllowed 直调（不 seed 整单），逐 (type,status) 验放行/拒绝：
  //   · 变更流 D_PRE(待指派/已暂缓·受理排期改造删已排期/待评估) reassign → 拒（去主次后无在册开发，首次指派走 assign）
  //   · bug D_PRE(待处理) reassign → **放行**（待处理态可 add 预指派/reactivate 带 roster，声明式改派合法·92 号审保留）
  //   · 两 type 的 DEV/VERIFY reassign → 放行（对照·核心改派态不受收窄影响）
  // ══════════════════════════════════════════════════════════════════════
  {
    const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
    const reassignAllowed = (type, status) => I.assertMemberActionFamilyAllowed('reassign', type, status);
    // 变更流 D_PRE 三态 → 拒（INVALID_STATUS）
    for (const st of ['待指派', '已暂缓']) {   // 受理排期改造：变更流 D_PRE 族=待指派/已暂缓（删已排期/待评估）
      assert.ok(throws(() => reassignAllowed('feature', st)), `S33a：feature「${st}」(D_PRE) reassign 应被拒（去 D_PRE）`);
      assert.ok(throws(() => reassignAllowed('improvement', st)), `S33a：improvement「${st}」(D_PRE) reassign 应被拒`);
    }
    // bug 待处理(D_PRE) → 放行（不抛）——关键回归：证明 C2c 未误伤 bug
    assert.ok(!throws(() => reassignAllowed('bug', '待处理')), 'S33b：bug「待处理」(D_PRE) reassign 应放行（预指派后可声明式改派·未被变更流去 D_PRE 误伤）');
    // 两 type DEV/VERIFY → 放行（对照，核心态不受影响）
    assert.ok(!throws(() => reassignAllowed('feature', '开发中')), 'S33c：feature「开发中」(DEV) reassign 放行');
    assert.ok(!throws(() => reassignAllowed('feature', '待验证')), 'S33c：feature「待验证」(VERIFY) reassign 放行');
    assert.ok(!throws(() => reassignAllowed('bug', '处理中')), 'S33c：bug「处理中」(DEV) reassign 放行');
    assert.ok(!throws(() => reassignAllowed('bug', '待验证')), 'S33c：bug「待验证」(VERIFY) reassign 放行');
    // add 对照：变更流 D_PRE add 仍放行（去 D_PRE 只作用于 reassign·不波及 add/remove）——防"改 reassign 波及其他动作"
    assert.ok(!throws(() => I.assertMemberActionFamilyAllowed('add', 'feature', '待指派')), 'S33d：feature「待指派」(D_PRE) add 仍放行（type 覆盖仅作用 reassign，未波及 add）');
    ok('S33（C2c·codex115 MED 回归）：reassign type 感知族门——变更流 D_PRE 拒 / bug 待处理放行（不误伤）/ DEV·VERIFY 放行 / add 不受波及');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 91 号审新增：H1 routeKind 真值表直调负例（resume 动态边 + RELEASE 配对 + RESET fail-closed）
  // ══════════════════════════════════════════════════════════════════════
  {
    // resume 恢复到 D_PRE/DEV/VERIFY（H1 核心修复）：均应放行——修复前会被通用 findTransition 分支的
    //   resolvedTo===null 检查误判成"旁路动作"拒绝（resume 与 estimate 等旁路动作共用 to:null 但语义不同）。
    let threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '待指派' });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-resume→D_PRE：应放行，实际抛错 ${threw && threw.message}`);

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '开发中', rosterActiveCount: 1 });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-resume→DEV：应放行，实际抛错 ${threw && threw.message}`);

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '待验证', rosterActiveCount: 1, rosterAllComplete: true });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-resume→VERIFY：应放行，实际抛错 ${threw && threw.message}`);

    // resume 不得直接恢复到「已上线」（唯一入口=RELEASE routeKind）
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '已上线' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-resume→已上线：应拒绝');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-resume→已上线：错误码 GATE_INVARIANT');

    // MED-1（92 号审）：合法恢复目标收窄为该 issue_type 的 hold.from 集合（活跃态全集），不再放行"任意已知
    //   状态"——4 个非法目标应拒：已暂缓（原地空转）/已拒绝/已作废/已关闭（均非 hold.from 成员）。
    for (const badAfter of ['已暂缓', '已拒绝', '已作废', '已关闭']) {
      threw = null;
      try {
        assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: badAfter });
      } catch (e) { threw = e; }
      assert.ok(threw, `MED-1-resume→${badAfter}：应拒绝（不在 hold.from 白名单内）`);
      assert.strictEqual(threw.code, 'GATE_INVARIANT', `MED-1-resume→${badAfter}：错误码 GATE_INVARIANT`);
    }

    // resume 具名边要求 before=已暂缓
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '开发中', after: '待指派' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-resume before≠已暂缓：应拒绝');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-resume before≠已暂缓：错误码 GATE_INVARIANT');

    ok('H1/MED-1：assertMainStatusTransition 直调——resume 恢复到 D_PRE/DEV/VERIFY(hold.from 白名单内) 均放行 + resume→已上线/已暂缓/已拒绝/已作废/已关闭 均拒绝 + before≠已暂缓拒绝');
  }
  {
    // RELEASE action×actionKind 配对校验（H1）：仅 publish+publish / execute-release+hotfix / execute-release+execute 合法
    let threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RELEASE', action: 'publish', actionKind: 'hotfix', issueType: 'feature', before: '待上线', after: '已上线' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-RELEASE publish+hotfix：应拒绝（配对非法）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-RELEASE publish+hotfix：错误码 GATE_INVARIANT');

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RELEASE', action: 'execute-release', actionKind: 'publish', issueType: 'bug', before: '待上线', after: '已上线' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-RELEASE execute-release+publish：应拒绝（publish 不属 execute-release 合法 actionKind 集合）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-RELEASE execute-release+publish：错误码 GATE_INVARIANT');

    // 合法配对放行（正例对照，防负例断言写反）——95 号复审后 RELEASE routeKind 同样过③层 roster 门（HIGH 收口），
    //   本测试只关心 action×actionKind 配对本身，故传满足门禁的 roster 参数，避免被无关的 roster 门挡住。
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RELEASE', action: 'publish', actionKind: 'publish', issueType: 'feature', before: '待上线', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-RELEASE publish+publish：应放行，实际抛错 ${threw && threw.message}`);

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RELEASE', action: 'execute-release', actionKind: 'hotfix', issueType: 'bug', before: '待上线', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-RELEASE execute-release+hotfix：应放行，实际抛错 ${threw && threw.message}`);

    ok('H1：assertMainStatusTransition 直调——RELEASE action×actionKind 配对校验（publish+hotfix 拒/execute-release+publish 拒/合法配对放行）');
  }
  {
    // RESET fail-closed（H1）：传 action/actionKind → 拒；before≠after → 拒；未知状态 → 拒；合法输入放行
    let threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RESET', action: 'noop', actionKind: null, issueType: 'feature', before: '待指派', after: '待指派' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-RESET 传 action：应拒绝');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-RESET 传 action：错误码 GATE_INVARIANT');

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RESET', action: null, actionKind: null, issueType: 'feature', before: '待指派', after: '开发中' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-RESET before≠after：应拒绝');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-RESET before≠after：错误码 GATE_INVARIANT');

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RESET', action: null, actionKind: null, issueType: 'feature', before: '这是个不存在的状态', after: '这是个不存在的状态' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-RESET 未知状态：应拒绝');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-RESET 未知状态：错误码 GATE_INVARIANT');

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RESET', action: null, actionKind: null, issueType: 'feature', before: '待指派', after: '待指派' });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-RESET 合法输入：应放行，实际抛错 ${threw && threw.message}`);

    ok('H1：assertMainStatusTransition 直调——RESET fail-closed（传 action 拒/before≠after 拒/未知状态拒/合法输入放行）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 对抗审 2026-07-17·H1：进 SYS_RELEASE 族 roster 门（ADMIN_TRANSITION 的 accept/resume 两条具名边进
  //   「待上线」）——缺陷背景：已暂缓归 D_PRE 族，D_PRE 允许 add/remove/reassign 且 W-GATE 天然短路，暂缓
  //   窗口可把新 pending 成员塞进 roster；resume 恢复回「待上线」此前未经任何 roster 门禁（③层只判
  //   enteringDev/enteringVerify，afterFamily=RELEASE 不落在两者之一）。反例必须打到新增门禁分支本身
  //   （而非被更早层拦下产生"假通过"）：resume→待上线 落在 hold.from 白名单内（transitions.js hold.from
  //   含'待上线'）、before='已暂缓' 满足具名边前置、after 属 ADMIN_TRANSITION 允许的 RELEASE 目标族——
  //   一路无阻拦到达③层新增门，故 rosterAllComplete=false 时应恰好在此处被拒。
  // ══════════════════════════════════════════════════════════════════════
  {
    // 反例：resume 恢复到「待上线」但 roster 含 pending（rosterAllComplete=false）→ 400（L3·95 号复审：此前
    //   注释误写 409，实际断言与实现均为 400——请求破坏门禁不变量，同 enteringDev/enteringVerify 二分），
    //   detail 命中新增分支
    let threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '待上线', rosterActiveCount: 2, rosterAllComplete: false });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-新增：resume→待上线 roster 含 pending 应抛错');
    assert.strictEqual(threw.httpStatus, 400, 'H1-新增：HTTP 状态应为 400（请求破坏门禁不变量，同 enteringDev/enteringVerify 二分）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-新增：错误码 GATE_INVARIANT');
    assert.ok(/SYS_RELEASE/.test(threw.message), `H1-新增：detail 应命中「进 SYS_RELEASE 族 roster 门」分支（打到目标分支，非前置层误拦），实际：${threw.message}`);

    // 反例②：rosterActiveCount 缺省（undefined）同样应被拒（Number(undefined)>=1 为 false，双重确认非"漏传即放行"）
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '待上线' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-新增：resume→待上线 未传 roster 参数应抛错（fail-closed，非默认放行）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-新增：未传 roster 参数错误码 GATE_INVARIANT');
    assert.ok(/SYS_RELEASE/.test(threw.message), `H1-新增：未传 roster 参数 detail 同样应命中「进 SYS_RELEASE 族 roster 门」分支，实际：${threw.message}`);

    // 正例：roster 全完成（rosterAllComplete=true）→ 放行（防负例写反，同 S28/H1 既有正例对照惯例）
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'resume', actionKind: null, issueType: 'feature', before: '已暂缓', after: '待上线', rosterActiveCount: 2, rosterAllComplete: true });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-新增：resume→待上线 roster 全完成应放行，实际抛错 ${threw && threw.message}`);

    // accept 具名边同门复用（进「待上线」另一条边，理由同 resume）：pending 拒、全完成放行
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'accept', actionKind: null, issueType: 'bug', before: '待验证', after: '待上线', rosterActiveCount: 1, rosterAllComplete: false });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-新增：accept→待上线 roster 含 pending 应抛错');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-新增：accept 错误码 GATE_INVARIANT');
    assert.ok(/SYS_RELEASE/.test(threw.message), `H1-新增：accept detail 应命中同一「进 SYS_RELEASE 族 roster 门」分支，实际：${threw.message}`);

    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'ADMIN_TRANSITION', action: 'accept', actionKind: null, issueType: 'bug', before: '待验证', after: '待上线', rosterActiveCount: 1, rosterAllComplete: true });
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `H1-新增：accept→待上线 roster 全完成应放行，实际抛错 ${threw && threw.message}`);

    // RELEASE routeKind（publish/hotfix/execute 进「已上线」）95 号复审收口后**同样**过本门（此前"刻意不加"
    //   的豁免理由已被推翻——reset 脚本改为按族状态感知回填后，RELEASE 族单的 roster 不再可能被置成全 pending，
    //   "历史遗留单被堵死"的前提不存在，见 status-transition-guard.js 注释）：三个 actionKind 逐一验证 pending
    //   拒/全完成放行，覆盖发布态排他矩阵（S37）新增的完整真值表。
    for (const [action, actionKind] of [['publish', 'publish'], ['execute-release', 'hotfix'], ['execute-release', 'execute']]) {
      threw = null;
      try {
        assertMainStatusTransition({ routeKind: 'RELEASE', action, actionKind, issueType: 'feature', before: '待上线', after: '已上线', rosterActiveCount: 1, rosterAllComplete: false });
      } catch (e) { threw = e; }
      assert.ok(threw, `H1-新增（95 号复审）：RELEASE routeKind action=${action} actionKind=${actionKind} roster 含 pending 应抛错`);
      assert.strictEqual(threw.code, 'GATE_INVARIANT', `H1-新增：RELEASE ${action}/${actionKind} 错误码 GATE_INVARIANT`);
      assert.ok(/SYS_RELEASE/.test(threw.message), `H1-新增：RELEASE ${action}/${actionKind} detail 应命中同一「进 SYS_RELEASE 族 roster 门」分支，实际：${threw.message}`);

      threw = null;
      try {
        assertMainStatusTransition({ routeKind: 'RELEASE', action, actionKind, issueType: 'feature', before: '待上线', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true });
      } catch (e) { threw = e; }
      assert.strictEqual(threw, null, `H1-新增（95 号复审）：RELEASE routeKind action=${action} actionKind=${actionKind} roster 全完成应放行，实际抛错 ${threw && threw.message}`);
    }

    // 零在册（rosterActiveCount=0）同样应拒——RELEASE routeKind 未传 roster 参数时 fail-closed（非默认放行）
    threw = null;
    try {
      assertMainStatusTransition({ routeKind: 'RELEASE', action: 'publish', actionKind: 'publish', issueType: 'feature', before: '待上线', after: '已上线' });
    } catch (e) { threw = e; }
    assert.ok(threw, 'H1-新增（95 号复审）：RELEASE routeKind 未传 roster 参数应抛错（fail-closed，非默认放行）');
    assert.strictEqual(threw.code, 'GATE_INVARIANT', 'H1-新增：RELEASE 未传 roster 参数错误码 GATE_INVARIANT');

    ok('H1（对抗审 2026-07-17·95 号复审收口）：assertMainStatusTransition 直调——进 SYS_RELEASE 族 roster 门 ADMIN_TRANSITION（accept/resume 两条具名边进「待上线」）与 RELEASE（publish/hotfix/execute 三 actionKind 进「已上线」）同等适用：roster 含 pending/零在册/未传均拒（打到目标分支）+ 全完成放行');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 91 号审新增：H2 CREATE path A 中途失败整体回滚（故障注入 electRepresentative 的 UPDATE，验证已发生的
  //   sys_issues INSERT + sys_issue_dev_assignees INSERT 均随事务一并回滚，无部分写入残留）
  // ══════════════════════════════════════════════════════════════════════
  {
    const issuesCntBefore = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    const assigneesCntBefore = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees')).c;
    // ⭐ 角色权限重构 C0：原用 path A（建单即指派）触发 electRepresentative，该路径已结构性关闭
    //   （受理门恒开 → 400 INTAKE_WITH_ASSIGN_CONFLICT）。改用 C0 后唯一的指派入口 /assign 触发同一函数：
    //   建单（→待受理）→ 受理（→待处理）→ assign（内部走 roster INSERT + electRepresentative）。
    //   ⚠️ 断言随入口调整：单在 assign 之前就已合法存在，故不再断言 sys_issues 零新增，
    //     改断言**故障事务自身零残留**——dev_assignees 不新增 + 主表 status/assigned_to 未被推进。
    const preIssue = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'H2故障注入回滚测试', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    assert.strictEqual(preIssue.status, 201, 'H2 夹具建单 201');
    const h2Id = preIssue.body.id;
    await call('POST', `/api/sys-issues/${h2Id}/intake-accept`, adminTok, {});
    const h2Before = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [h2Id]);
    assert.strictEqual(h2Before.status, '待处理', 'H2 夹具：受理后落 待处理（assign 的合法前置态）');
    const assigneesCntBefore2 = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees')).c;

    injectFailureFired = false;
    injectFailureOnSql = 'SET is_primary = CASE';   // 命中 electRepresentative 的 UPDATE（发生在 roster INSERT 之后）
    const r = await call('POST', `/api/sys-issues/${h2Id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 500, `H2：electRepresentative 中途故障应 500（未预期错误），实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(injectFailureFired, 'H2：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）');
    injectFailureOnSql = null; injectFailureFired = false;   // 复位（防污染后续用例）
    const assigneesCntAfter = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees')).c;
    const h2After = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [h2Id]);
    assert.strictEqual(assigneesCntAfter, assigneesCntBefore2, 'H2：sys_issue_dev_assignees 未残留部分写入行（roster INSERT 随事务回滚）');
    assert.strictEqual(h2After.status, h2Before.status, 'H2：主状态未被推进（仍 待处理·UPDATE 随事务回滚）');
    assert.strictEqual(h2After.assigned_to, null, 'H2：assigned_to 未落（代表位选举失败即整体回滚）');
    const issuesCntAfter = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
    assert.strictEqual(issuesCntAfter, issuesCntBefore + 1, 'H2：仅夹具单 1 行（故障事务本身不新建单）');
    ok('H2：CREATE path A 中途失败（electRepresentative 故障注入）→ 500 + 已发生的 sys_issues/dev_assignees INSERT 均随事务整体回滚，无部分写入残留');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 91 号审新增：M1 reassign 差量应用后 roster 双向判等守卫——正常流程下不误伤，最终在册集合精确=目标集合
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    await mkMember(id, 6, '开发乙', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6, 8, 10], reason: 'M1 roster 判等回归' });
    assert.strictEqual(r.status, 200, `M1-roster：reassign 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const activeRows = await activeMembers(id);
    const actualIds = activeRows.map(m => m.user_id).sort((a, b) => a - b);
    assert.deepStrictEqual(actualIds, [6, 8, 10], 'M1-roster：差量应用后在册集合与目标集合完全一致（双向判等守卫通过，不误伤正常流程）');
    await selfCertifyProbes('M1-roster');
    ok('M1：reassign 差量应用后 roster 双向判等守卫——正常流程下不误伤，最终在册集合精确=目标 member_ids 集合');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 91 号审新增：M1 supersede-excuse 步骤5（superseded_by 回写）changes 守卫——种子"已被 supersede 但未软删"
  //   的不一致态（正常流程不可达，模拟并发/脏数据），验证守卫拒绝且步骤3/4 随事务整体回滚
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'excused');
    await run(`UPDATE sys_issue_dev_assignees SET superseded_by = 999999 WHERE id = ?`, [daId]);   // 人为造不一致态
    const beforeCnt = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ?', [id])).c;
    const r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${daId}/supersede-excuse`, adminTok, { reason: '触发 M1 步骤5守卫' });
    assert.strictEqual(r.status, 409, `M1-supersede：superseded_by 已非空应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SUPERSEDE_PRECONDITION', 'M1-supersede：错误码 SUPERSEDE_PRECONDITION');
    const afterRow = await get('SELECT removed_at, superseded_by FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(afterRow.removed_at, null, 'M1-supersede：拒绝后整体回滚，旧行 removed_at 仍为 NULL（步骤3 UPDATE 未残留）');
    assert.strictEqual(afterRow.superseded_by, 999999, 'M1-supersede：superseded_by 仍是种子值（未被步骤5覆盖）');
    const afterCnt = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ?', [id])).c;
    assert.strictEqual(afterCnt, beforeCnt, 'M1-supersede：拒绝后未产生新实例（步骤4 INSERT 随事务回滚）');
    ok('M1：supersede-excuse 步骤5 changes 守卫——种子 superseded_by 已非空的不一致态 → 409 SUPERSEDE_PRECONDITION，步骤3/4 整体回滚');
    // 清理：daId 的 superseded_by=999999 是本用例故意经原生 SQL 种下的不一致态（P9 违规，验证的是"API 拒绝
    //   写入更坏的状态"，不代表这条种子数据本身该长期存在）——全套用例共享同一份 :memory: db，若不清理，
    //   本用例之后任何一次全库 selfCertifyProbes(P1-P14/P15) 都会被这条历史种子数据拖累亮红（与后续用例本身
    //   改动无关的假阳性）。此前无用例在本条之后调用 selfCertifyProbes，故此问题此前未暴露；本次新增 M2
    //   用例在本条之后调用 selfCertifyProbes 时暴露，随手清理，不改变本用例任何断言。
    await run(`UPDATE sys_issue_dev_assignees SET superseded_by = NULL WHERE id = ?`, [daId]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 91 号审新增：L1 add/re-add user_ids 逐项 parsePositiveId 严格校验——任一非法整请求 400 零副作用
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待指派');
    const beforeCnt = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ?', [id])).c;
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, 'abc'] });
    assert.strictEqual(r.status, 400, `L1a：user_ids 含字符串非法值应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'L1a：错误码 VALIDATION');
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, 0] });
    assert.strictEqual(r.status, 400, `L1b：user_ids 含 0 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'L1b：错误码 VALIDATION');
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, -1] });
    assert.strictEqual(r.status, 400, `L1c：user_ids 含负数应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'L1c：错误码 VALIDATION');
    r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5, 1.5] });
    assert.strictEqual(r.status, 400, `L1d：user_ids 含小数应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'L1d：错误码 VALIDATION');
    const afterCnt = (await get('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ?', [id])).c;
    assert.strictEqual(afterCnt, beforeCnt, 'L1：任一非法值 → 整请求零副作用（合法项 5 也未被部分插入，禁静默过滤）');
    ok('L1：add/re-add user_ids 逐项 parsePositiveId 严格校验——字符串/0/负数/小数任一非法 → 400 VALIDATION 整请求零副作用（与 reassign member_ids 严格度对齐）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 对抗审 2026-07-17·M2：代表实变（electRepresentative 内 assigned_to 变化）→ 同事务原子重置 sys_issues
  //   dev 侧 notify 五列（notify_status/notified_at/notify_message_key/notify_error/read_at，**无前缀**）。
  //   缺陷背景：旧 reassign「换主」分支曾原子重置这五列（05-L3），C2 去主次重写后 electRepresentative
  //   成为所有代表变化路径的唯一收敛点，但重写时遗漏了这一步——旧代表遗留的 sent/已读态会被新代表继承。
  // ══════════════════════════════════════════════════════════════════════
  {
    // 正例：reassign 换代表（5→6）→ 五列重置（含 read_at 原非空场景）
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    await run(
      `UPDATE sys_issues SET assigned_to = 5, assigned_to_name = '开发甲', assigned_at = '2026-07-16 09:00:00',
         notify_status = 'sent', notified_at = '2026-07-16 10:00:00', notify_message_key = 'sys_dev_assign',
         notify_error = '曾经的一次失败记录', read_at = '2026-07-16 11:00:00' WHERE id = ?`,
      [id]
    );
    const before = await get('SELECT assigned_to, notify_status, notified_at, notify_message_key, notify_error, read_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(before.assigned_to, 5, 'M2 前置：代表=开发甲(5)');
    assert.strictEqual(before.notify_status, 'sent', 'M2 前置：notify_status 种子为 sent（模拟旧代表已被通知）');
    assert.ok(before.read_at, 'M2 前置：read_at 种子非空（模拟旧代表已读）');

    const r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: 'M2 换代表清 notify 五列' });
    assert.strictEqual(r.status, 200, `M2：reassign 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const after = await get('SELECT assigned_to, notify_status, notified_at, notify_message_key, notify_error, read_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(after.assigned_to, 6, 'M2：代表已换为开发乙(6)（唯一在册 pending 当选）');
    assert.strictEqual(after.notify_status, 'not_sent', 'M2：代表实变后 notify_status 重置为 not_sent');
    assert.strictEqual(after.notified_at, null, 'M2：代表实变后 notified_at 清空');
    assert.strictEqual(after.notify_message_key, null, 'M2：代表实变后 notify_message_key 清空');
    assert.strictEqual(after.notify_error, null, 'M2：代表实变后 notify_error 清空');
    assert.strictEqual(after.read_at, null, 'M2：代表实变后 read_at 清空（原非空场景专测）');
    await selfCertifyProbes('M2-repChanged');
    ok('M2：reassign 换代表（assigned_to 实变 5→6）→ 同事务原子重置 sys_issues dev 侧 notify 五列（含原 read_at 非空场景清零）');
  }
  {
    // [284 号 B3-①] 方案 v1.1 255-G 七审 5M 项之一「负责人补选 assigned_at COALESCE+排序同源 helper+
    //   回归场景」——核实结论：前两项（COALESCE 语义/排序同源 helper）electRepresentative（index.js
    //   :2153-2197）已落地，只是不是字面 SQL COALESCE 关键字，而是等价的 `if (assignedAtIsNull) {...}
    //   else {...}` 分支（见 :2181-2188，only 在 assigned_at 为 NULL 时才补写 now，否则原样保留）；
    //   候选排序=`activeRows`（ORDER BY user_id ASC，:2157）供①现任在册②pending 最小③全体最小三级
    //   选举复用，electRepresentative 是全部 5+ 代表变化路径（add/remove/excuse/supersede/reassign）
    //   的唯一收敛点，无第二份排序逻辑。**缺的是"回归场景"这一项**——全文 grep 未找到任何测试断言
    //   "代表真实换人后 assigned_at 保持原值不被推进"，M2 组两个用例都只断言 notify 五列，未选
    //   assigned_at 入 SELECT。本组补上：DELETE 移除现任代表触发再选举（换一种触发方式，不与上方
    //   reassign 用例重复），代表实变（5→6），assigned_at 精确保留种子值。
    //   ⚠️ 自决偏离踩坑记录：本条最初用 excuse 端点触发，红灯——excuse 只改 dev_status='excused'，
    //   不设 removed_at，activeRows（`WHERE removed_at IS NULL`）仍含现任，electRepresentative 选举
    //   ①级"现任仍在册"判定只看 removed_at 不看 dev_status，命中后代表原样不变，验证不了"真实换人"
    //   这条回归线。改用 DELETE 移除接口（真正把人移出在册集合）才能让①级落空、落到②级选出新代表。
    const idB3 = await mkIssue('feature', '开发中');
    const da5B3 = await mkMember(idB3, 5, '开发甲', 'pending');
    await mkMember(idB3, 6, '开发乙', 'pending');
    const seedAssignedAt = '2026-07-01 09:00:00';
    await run(`UPDATE sys_issues SET assigned_to = 5, assigned_to_name = '开发甲', assigned_at = ? WHERE id = ?`, [seedAssignedAt, idB3]);
    const beforeB3 = await get('SELECT assigned_to, assigned_at FROM sys_issues WHERE id = ?', [idB3]);
    assert.strictEqual(beforeB3.assigned_to, 5, 'B3-① 前置：代表=开发甲(5)');
    assert.strictEqual(beforeB3.assigned_at, seedAssignedAt, 'B3-① 前置：assigned_at 已种子为固定历史值');

    const rRemoveB3 = await call('DELETE', `/api/sys-issues/${idB3}/dev-assignees/${da5B3}`, adminTok, { reason: 'B3-① 回归：移除现任代表触发再选举' });
    assert.strictEqual(rRemoveB3.status, 200, `B3-①：移除现任代表应 200，实际 ${rRemoveB3.status} ${JSON.stringify(rRemoveB3.body)}`);
    const afterB3 = await get('SELECT assigned_to, assigned_at FROM sys_issues WHERE id = ?', [idB3]);
    assert.strictEqual(afterB3.assigned_to, 6, 'B3-①：代表已实变为开发乙(6)（现任被移出在册集合，①级选举落空，②级 pending 最小 user_id 命中）');
    assert.strictEqual(afterB3.assigned_at, seedAssignedAt, '⭐ 284 号 B3-①：代表实变后 assigned_at 精确保留原值，不被再选举推进（COALESCE 等价语义落地生效）');
    ok('284 号 B3-①：负责人补选回归场景——移除现任代表触发再选举、代表实变(5→6)后 assigned_at 精确保留原值不被推进（此前七审收口项漏了这条回归测试，assigned_at COALESCE 等价语义+排序同源 helper electRepresentative 两项本身已在 C4/C2 落地）');
  }
  {
    // 负例（L2·95 号复审：种子五列全非空 + 断言四组前缀列不受影响）：reassign 仅新增协作成员、原代表仍在册
    //   仍当选（repChanged=false）→ dev 侧 notify 五列应保持不变；requester_/creator_/relay_/release_assignee_
    //   四组前缀列（各 5 列，与 dev 侧同名后缀不同前缀，服务层任何一处误用无前缀写法覆盖了别的前缀列都会被
    //   本断言捕获）也应保持不变——本次修复只碰无前缀（dev 侧）5 列，不应触碰其余 4×5=20 列。
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    await run(
      `UPDATE sys_issues SET assigned_to = 5, assigned_to_name = '开发甲', assigned_at = '2026-07-16 09:00:00',
         notify_status = 'sent', notified_at = '2026-07-16 10:00:00', notify_message_key = 'sys_dev_assign',
         notify_error = '曾经的一次失败记录', read_at = '2026-07-16 11:00:00',
         requester_notify_status = 'sent', requester_notified_at = '2026-07-16 12:00:00',
         requester_notify_message_key = 'sys_dev_assign_requester', requester_notify_error = 'requester侧曾失败',
         requester_read_at = '2026-07-16 12:30:00',
         creator_notify_status = 'sent', creator_notified_at = '2026-07-16 13:00:00',
         creator_notify_message_key = 'sys_dev_assign_creator', creator_notify_error = 'creator侧曾失败',
         creator_read_at = '2026-07-16 13:30:00',
         relay_notify_status = 'sent', relay_notified_at = '2026-07-16 14:00:00',
         relay_notify_message_key = 'sys_dev_assign_relay', relay_notify_error = 'relay侧曾失败',
         relay_read_at = '2026-07-16 14:30:00',
         release_assignee_notify_status = 'sent', release_assignee_notified_at = '2026-07-16 15:00:00',
         release_assignee_notify_message_key = 'sys_dev_assign_release', release_assignee_notify_error = 'release_assignee侧曾失败',
         release_assignee_read_at = '2026-07-16 15:30:00'
       WHERE id = ?`,
      [id]
    );
    const beforeAllCols = await get(
      `SELECT notify_status, notified_at, notify_message_key, notify_error, read_at,
              requester_notify_status, requester_notified_at, requester_notify_message_key, requester_notify_error, requester_read_at,
              creator_notify_status, creator_notified_at, creator_notify_message_key, creator_notify_error, creator_read_at,
              relay_notify_status, relay_notified_at, relay_notify_message_key, relay_notify_error, relay_read_at,
              release_assignee_notify_status, release_assignee_notified_at, release_assignee_notify_message_key, release_assignee_notify_error, release_assignee_read_at
       FROM sys_issues WHERE id = ?`,
      [id]
    );

    const r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5, 8], reason: 'M2 负例：仅新增协作，代表不变' });
    assert.strictEqual(r.status, 200, `M2 负例：reassign 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);

    const after = await get('SELECT assigned_to FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(after.assigned_to, 5, 'M2 负例：代表仍是开发甲(5)（现任仍在册，选举①命中，未实变）');

    const afterAllCols = await get(
      `SELECT notify_status, notified_at, notify_message_key, notify_error, read_at,
              requester_notify_status, requester_notified_at, requester_notify_message_key, requester_notify_error, requester_read_at,
              creator_notify_status, creator_notified_at, creator_notify_message_key, creator_notify_error, creator_read_at,
              relay_notify_status, relay_notified_at, relay_notify_message_key, relay_notify_error, relay_read_at,
              release_assignee_notify_status, release_assignee_notified_at, release_assignee_notify_message_key, release_assignee_notify_error, release_assignee_read_at
       FROM sys_issues WHERE id = ?`,
      [id]
    );
    // dev 侧五列逐列断言（L2：补 notify_message_key/notify_error）
    assert.strictEqual(afterAllCols.notify_status, 'sent', 'M2 负例：代表未变，notify_status 不应被误清零');
    assert.strictEqual(afterAllCols.notified_at, '2026-07-16 10:00:00', 'M2 负例：代表未变，notified_at 不应被误清零');
    assert.strictEqual(afterAllCols.notify_message_key, 'sys_dev_assign', 'M2 负例（L2 新增）：代表未变，notify_message_key 不应被误清零');
    assert.strictEqual(afterAllCols.notify_error, '曾经的一次失败记录', 'M2 负例（L2 新增）：代表未变，notify_error 不应被误清零');
    assert.strictEqual(afterAllCols.read_at, '2026-07-16 11:00:00', 'M2 负例：代表未变，read_at 不应被误清零');
    // 四组前缀列整体 deepStrictEqual（L2 新增：requester_/creator_/relay_/release_assignee_ 共 20 列不应受影响）
    assert.deepStrictEqual(afterAllCols, beforeAllCols, 'M2 负例（L2 新增）：requester_/creator_/relay_/release_assignee_ 四组前缀列（各 5 列）与 dev 侧五列整体应与 reassign 前逐字相同（本次修复只碰无前缀 dev 侧列）');

    await selfCertifyProbes('M2-repUnchanged');
    ok('M2 负例：reassign 仅新增协作成员、代表未实变（repChanged=false）→ dev 侧五列（含 notify_message_key/notify_error）保持不变 + requester_/creator_/relay_/release_assignee_ 四组前缀列（共 20 列）不受影响（防修复误清零/误扩散回归）');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-members 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-members 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
