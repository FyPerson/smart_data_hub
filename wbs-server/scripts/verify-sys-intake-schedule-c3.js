// 验证脚本：系统迭代 受理排期改造 C3 — 受理三出口后端（intake_accept / intake_return / resubmit_intake）
//   用法：node scripts/verify-sys-intake-schedule-c3.js
//
// 覆盖（真实 HTTP 端点 + 引擎 [3] 权限精判 + timeline 落痕 + 建单人退改通知）：
//   ⚠️ 前置态构造：建单端点当前恒传 intake_required=0（选对接人 UI 属 C7-8·白名单写值属后续），无路径产出「待受理」单，
//      故本 verify 用直接 UPDATE 播种（intake_required=1 + status='待受理'/'待修改'）——这正是 C7-8 建单(选对接人)落地后的合法态，
//      是测试夹具而非非法态（迁移后验已保证 intake_required∈{0,1}）。
//   [A] intake_accept（待受理→待指派/待处理）：admin/受理人(13) 200 + 落态对（feature=待指派·bug=待处理）+ intake_required 不变(仍1)
//       + 非 admin 非受理人(dev5) 403 中间件 NOT_ADMIN_OR_INTAKE_LIAISON
//       + 技术负责人(示例发布者 7·非受理人) 403（三名单隔离：7=技术负责人/bug对接人 ≠ 受理人[13]）
//       + 非待受理态(待指派) intake_accept → 400 INVALID_TRANSITION（状态机拒）
//   [B] intake_return（待受理→待修改·原因必填）：受理人(13) 带 reason 200 + timeline(status_change/intake_return/summary=reason)
//       + 建单人(admin1≠13) 自动通知 creator_notify_status='sent'（stub ok）
//       + 缺 reason 400 INTAKE_RETURN_REASON_REQUIRED
//       + 非 admin 非受理人(dev5) 403 中间件
//       + self-guard：admin(建单人本人) intake_return 自己单 200 但 creator_notify_status 仍 'not_sent'（跳过发送）
//   [C] resubmit_intake（待修改→待受理·created_by∨admin·受理人不获）：
//       + 建单人(dev5·播种 created_by=5) 200 → 待受理（**不挂 requireIntakeLiaison·中间件放行·引擎 creator_or_admin 精判**）
//       + admin 200（代办）
//       + 受理人(13) resubmit 他人单 → 403 NOT_AUTHORIZED_FOR_TRANSITION（§11 回归·受理人不获重提他人单权）
//       + 非建单人非 admin(dev6) → 403
//   [D] 竞态/状态机守卫：intake_accept 成功后再 accept 同单 → 400 INVALID_TRANSITION（双条件 WHERE + findTransition 状态机守·防重放/竞态）
//   [E] meta 单一真相：buildMeta/ACTION_LABELS 含三动作 + roleGuard 后端实现齐（intake_liaison/creator_or_admin ∈ KNOWN_ROLE_GUARDS）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-c3-secret';
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

// 可控通知桩（codex C3 常规审 MED-3）：sendBehavior 决定发送结果·lastSent 捕获收件人/markdown 供断言。
//   函数身份稳定（构造期捕获）但行为读外层可变态·测试间翻 sendBehavior 即切换 ok/fail/throw。
let sendBehavior = { mode: 'ok' };   // 'ok' | 'fail' | 'throw'
let lastSent = null;
async function mockSendIssueDingtalkRaw(user, title, md) {
  lastSent = { userId: user && user.id, title, md };
  if (sendBehavior.mode === 'throw') throw new Error('mock 钉钉发送异常');
  if (sendBehavior.mode === 'fail') return { ok: false, reason: 'no_phone' };
  return { ok: true, message_key: 'stub-dev' };
}
// 复审 HIGH 收口验证：通知准备阶段（baseUrl 获取）抛异常也须落 failed（不停 not_sent）。
let baseUrlBehavior = { mode: 'ok' };   // 'ok' | 'throw'
async function mockGetSafePlatformBaseUrl() {
  if (baseUrlBehavior.mode === 'throw') throw new Error('mock baseUrl 获取异常');
  return '';
}
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,       // 覆盖 stub（可控发送失败注入）
  getSafePlatformBaseUrl: mockGetSafePlatformBaseUrl,   // 覆盖 stub（可控准备阶段异常注入）
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

// id 对齐生产语义：1=admin / 5,6=开发 / 13=示例对接人(受理人·SYS_INTAKE_LIAISON) / 7=示例发布者(技术负责人 SYS_TECH_LEAD·亦 bug 对接人·非受理人)
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);      // 受理人
const techLeadTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);     // 技术负责人（非受理人）

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

// 建单（admin·恒 intake_required=0）→ 直接 UPDATE 播种为「待受理」(intake_required=1)。可指定 createdBy 覆盖建单人。
async function seedIntakeIssue(type, { status = '待受理', createdBy = null } = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: `${type}单`, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const sets = ['intake_required = 1', 'status = ?'];
  const params = [status];
  if (createdBy !== null) { sets.push('created_by = ?'); params.push(createdBy); }
  await run(`UPDATE sys_issues SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),(6,'dev2','开发李','user','13800000006'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务（受理人 id=13 示例对接人 / 技术负责人 id=7 示例发布者）');

  // ═══ [A] intake_accept（待受理→待指派/待处理·权限两档 + 落态 + 状态机守）═══
  {
    // admin feature → 200 待指派 + intake_required 不变(仍1·"已过受理门"语义靠 status+intake_required 组合)
    let id = await seedIntakeIssue('feature');
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, `admin intake_accept feature 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待指派', 'feature intake_accept → 待指派');
    let row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.intake_required, 1, 'intake_accept 不改 intake_required（仍 1·受理门语义）');

    // 受理人(13) feature → 200
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, `受理人(13) intake_accept feature 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待指派', '受理人 intake_accept feature → 待指派');

    // 受理人(13) bug → 200 待处理（bug 汇合边）
    id = await seedIntakeIssue('bug');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `受理人 intake_accept bug 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待处理', 'bug intake_accept → 待处理');

    // 非 admin 非受理人(dev5) → 403（C10 绑单精判：单已绑 13·dev5 过粗筛后 handler 拒 NOT_BOUND_LIAISON）
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, devTok, {});
    assert.strictEqual(r.status, 403, 'dev5 intake_accept 403');
    assert.strictEqual(r.body.code, 'NOT_BOUND_LIAISON', '403 handler 绑单精判 NOT_BOUND_LIAISON（seedIntakeIssue 绑 13·dev5 非绑定人·空单兜底不适用于已绑单）');

    // 技术负责人(示例发布者 7·非受理人) → 403（C10：7 过粗筛[publisher eligible]但非该单绑定对接人[13]·handler 拒）
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, techLeadTok, {});
    assert.strictEqual(r.status, 403, '技术负责人(7) intake_accept 403（非绑定对接人）');
    assert.strictEqual(r.body.code, 'NOT_BOUND_LIAISON', '绑单精判：示例发布者(7) 非该单绑定对接人[13]·NOT_BOUND_LIAISON');

    // 非待受理态(待指派) intake_accept → 400 INVALID_TRANSITION（状态机拒·findTransition null）
    id = await seedIntakeIssue('feature', { status: '待指派' });
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 400, '待指派态 intake_accept 400（非待受理·状态机拒）');
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '400 code=INVALID_TRANSITION');
    ok('[A] intake_accept：admin/受理人 200(feature→待指派·bug→待处理) + intake_required 不变 + dev5/技术负责人 403(绑单精判 NOT_BOUND_LIAISON) + 非待受理 400');
  }

  // ═══ [B] intake_return（待受理→待修改·原因必填 + 自动通知建单人 + self-guard）═══
  {
    sendBehavior = { mode: 'ok' };
    // 受理人(13) 带 reason → 200 待修改 + timeline + 通知建单人(admin1≠13) sent
    let id = await seedIntakeIssue('feature');
    lastSent = null;
    let r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '需求描述不清，请补充验收标准' });
    assert.strictEqual(r.status, 200, `受理人 intake_return 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待修改', 'intake_return → 待修改');
    const tl = await get(`SELECT event_type, action_code, from_status, to_status, summary, operator_id FROM sys_issue_timeline
                          WHERE issue_id=? AND action_code='intake_return' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl, 'intake_return 写 timeline');
    assert.strictEqual(tl.event_type, 'status_change', 'timeline event_type=status_change');
    assert.strictEqual(tl.from_status, '待受理', 'timeline from=待受理');
    assert.strictEqual(tl.to_status, '待修改', 'timeline to=待修改');
    assert.strictEqual(tl.summary, '需求描述不清，请补充验收标准', 'timeline summary=退改原因');
    assert.strictEqual(Number(tl.operator_id), 13, 'timeline operator=受理人13');
    let row = await get('SELECT creator_notify_status, creator_notify_message_key FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.creator_notify_status, 'sent', '建单人(admin1) 自动通知已发（stub ok→sent）');
    assert.strictEqual(row.creator_notify_message_key, 'stub-dev', 'creator_notify_message_key=stub-dev');
    // 收件人 + markdown 原因断言（MED-3：证明真的发给建单人 + 退改原因进正文）
    assert.ok(lastSent && Number(lastSent.userId) === 1, '通知实际收件人=建单人 admin(1)');
    assert.ok(lastSent.md.includes('需求描述不清，请补充验收标准'), 'markdown 正文含退改原因');
    assert.ok(lastSent.md.includes(`#${id}`), 'markdown 含单号');

    // 缺 reason → 400
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, {});
    assert.strictEqual(r.status, 400, '缺 reason intake_return 400');
    assert.strictEqual(r.body.code, 'INTAKE_RETURN_REASON_REQUIRED', '400 code=INTAKE_RETURN_REASON_REQUIRED');
    // 空白 reason 也拒（trim 后空）
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '   ' });
    assert.strictEqual(r.status, 400, '空白 reason 也 400');

    // 非 admin 非受理人(dev5) → 403（C10 绑单精判：单已绑 13·dev5 过粗筛后 handler 拒 NOT_BOUND_LIAISON）
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, devTok, { reason: 'x' });
    assert.strictEqual(r.status, 403, 'dev5 intake_return 403');
    assert.strictEqual(r.body.code, 'NOT_BOUND_LIAISON', 'intake_return 403 handler 绑单精判 NOT_BOUND_LIAISON');

    // self-guard：admin(建单人本人·created_by=1) intake_return 自己单 → 200 但不发通知（creator_notify_status 仍 not_sent）
    id = await seedIntakeIssue('feature');   // created_by=admin(1)
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, adminTok, { reason: 'admin 自退改' });
    assert.strictEqual(r.status, 200, 'admin intake_return own 单 200');
    row = await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.creator_notify_status, 'not_sent', 'self-guard：操作者==建单人→跳过发送（creator_notify_status 仍 not_sent）');
    ok('[B] intake_return：受理人 200(待修改)+timeline(reason)+通知建单人 sent(收件人+markdown原因) / 缺 reason 400 / dev5 403 中间件 / self-guard 跳过');
  }

  // ═══ [B2] intake_return 通知失败注入（codex MED-3·证明通知失败不影响已提交流转 + 失败态可观测）═══
  {
    // (a) 发送返回 ok:false → 主流转 200 + creator_notify_status='failed'（不回滚状态）
    sendBehavior = { mode: 'fail' };
    let id = await seedIntakeIssue('feature');
    let r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '退改a' });
    assert.strictEqual(r.status, 200, '发送 ok:false 时主流转仍 200');
    let row = await get('SELECT status, creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待修改', '通知失败不回滚已提交状态');
    assert.strictEqual(row.creator_notify_status, 'failed', 'ok:false → creator_notify_status=failed');

    // (b) 发送抛异常（HIGH-1 兜底）→ 主流转 200 + failed（不停在 not_sent）
    sendBehavior = { mode: 'throw' };
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '退改b' });
    assert.strictEqual(r.status, 200, '发送抛异常时主流转仍 200');
    row = await get('SELECT status, creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待修改', '抛异常不回滚状态');
    assert.strictEqual(row.creator_notify_status, 'failed', 'HIGH-1：抛异常也落 failed（不停 not_sent·审计一致）');

    // (c) creator 缺失（created_by 指向不存在 user）→ 200 + 不发不记（not_sent·warn·MED-2）
    sendBehavior = { mode: 'ok' };
    id = await seedIntakeIssue('feature', { createdBy: 999 });   // user 999 不存在
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '退改c' });
    assert.strictEqual(r.status, 200, 'creator 缺失时主流转仍 200');
    row = await get('SELECT status, creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待修改', 'creator 缺失不回滚状态');
    assert.strictEqual(row.creator_notify_status, 'not_sent', 'creator 缺失→不发不记（not_sent·MED-2 warn）');

    // (d) 通知准备阶段（baseUrl 获取）抛异常（复审 HIGH 收口）→ 主流转 200 + failed（不停 not_sent）
    sendBehavior = { mode: 'ok' };
    baseUrlBehavior = { mode: 'throw' };
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '退改d' });
    assert.strictEqual(r.status, 200, '准备阶段抛异常时主流转仍 200');
    row = await get('SELECT status, creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待修改', '准备阶段异常不回滚状态');
    assert.strictEqual(row.creator_notify_status, 'failed', '复审 HIGH：准备阶段(baseUrl)抛异常也落 failed（不停 not_sent·通知尝试失败必记）');
    baseUrlBehavior = { mode: 'ok' };
    sendBehavior = { mode: 'ok' };
    ok('[B2] 通知失败注入：ok:false/发送throw/准备throw → 200+failed(流转不回滚·HIGH 完整闭合) + creator 缺失 → 200+not_sent');
  }

  // ═══ [C] resubmit_intake（待修改→待受理·created_by∨admin·受理人不获·不挂中间件）═══
  {
    // 建单人(dev5·播种 created_by=5) → 200 待受理（**不挂 requireIntakeLiaison**·中间件放行 dev5·引擎 creator_or_admin 精判放行）
    let id = await seedIntakeIssue('feature', { status: '待修改', createdBy: 5 });
    let r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, devTok, {});
    assert.strictEqual(r.status, 200, `建单人 dev5 resubmit 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待受理', 'resubmit_intake → 待受理');

    // admin → 200（代办）
    id = await seedIntakeIssue('feature', { status: '待修改', createdBy: 5 });
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {});
    assert.strictEqual(r.status, 200, 'admin resubmit 200（代办）');

    // 受理人(13) resubmit 他人单(created_by=5) → 403 引擎精判（§11 回归·受理人不获重提他人单权）
    id = await seedIntakeIssue('feature', { status: '待修改', createdBy: 5 });
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, liaisonTok, {});
    assert.strictEqual(r.status, 403, '受理人 resubmit 他人单 403');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', '403 引擎层 creator_or_admin 精判（非中间件·resubmit 不挂 requireIntakeLiaison）');

    // 非建单人非 admin(dev6) → 403 引擎精判
    id = await seedIntakeIssue('feature', { status: '待修改', createdBy: 5 });
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, dev2Tok, {});
    assert.strictEqual(r.status, 403, '非建单人非 admin resubmit 403');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', '403 引擎层');
    ok('[C] resubmit_intake：建单人(dev5)/admin 200→待受理 + 受理人他人单 403(引擎 creator_or_admin·§11 回归) + 非建单人非 admin 403 + 不挂中间件(dev5 过中间件)');
  }

  // ═══ [F] 受理门不变量（codex MED-1·intake_required=1 才走·fail-closed·堵矛盾组合）═══
  //   ⭐ 角色权限重构 C0：DB 层新增了 intake_required 恒 1 触发器（INSERT/UPDATE 写入 ≠1 一律 ABORT），
  //     本组的脏夹具在 DB 层已造不出来。**两道防线都要保回归**，故这里临时摘掉触发器造脏数据、造完按
  //     原样重建（DDL 从 _internals 取，不手抄——防两处漂移）。
  //     为什么内层防线不能因外层加固而删：触发器可能被误删/旧库升级前就带着历史脏数据，届时引擎层
  //     [3.5] fail-closed 是最后一道闸；且本组还覆盖"不变量置于权限校验之后"的侧信道收口语义。
  //   ⚠️ 整组包在 try/finally 里（codex 三轮审 MED-3）：任一断言抛错也必须重建触发器，
  //     否则后续所有测试组会在**无 DB 约束**的环境下跑，红灯变绿的假阳性比原始失败更难查。
  const dropGateTriggers = async () => {
    for (const n of I.SYS_INTAKE_GATE_TRIGGER_NAMES) await run(`DROP TRIGGER IF EXISTS ${n}`);
  };
  const restoreGateTriggers = async () => {
    for (const sql of I.SYS_INTAKE_GATE_TRIGGERS_SQL) await run(sql);
  };
  try {
    // intake_required=0 + 待受理（不一致夹具·结构上不该出现）→ intake_accept 409 INTAKE_REQUIRED_INVARIANT
    let id = await seedIntakeIssue('feature');
    await dropGateTriggers();
    await run('UPDATE sys_issues SET intake_required=0 WHERE id=?', [id]);   // 破坏不变量
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 409, 'intake_required=0+待受理 intake_accept 409');
    assert.strictEqual(r.body.code, 'INTAKE_REQUIRED_INVARIANT', '409 code=INTAKE_REQUIRED_INVARIANT');
    // intake_return 同拒（同一不一致夹具）
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, adminTok, { reason: 'x' });
    assert.strictEqual(r.status, 409, 'intake_required=0+待受理 intake_return 409');
    assert.strictEqual(r.body.code, 'INTAKE_REQUIRED_INVARIANT', 'intake_return 409 code');
    // intake_required=0 + 待修改 → resubmit 409（否则产「待受理+intake_required=0」矛盾·污染 reactivate 初始态）
    await restoreGateTriggers();                     // 先恢复，证明 seed 走的是合规路径（受理态恒 ir=1）
    id = await seedIntakeIssue('feature', { status: '待修改', createdBy: 5 });
    await dropGateTriggers();                        // 再摘掉去造第二个脏夹具
    await run('UPDATE sys_issues SET intake_required=0 WHERE id=?', [id]);
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {});
    assert.strictEqual(r.status, 409, 'intake_required=0+待修改 resubmit(admin 有权) 409');
    assert.strictEqual(r.body.code, 'INTAKE_REQUIRED_INVARIANT', 'resubmit 409 code');
    // 侧信道收口（复审 MED）：不变量置于权限校验后——无权者(dev6·resubmit 不挂中间件·引擎 creator_or_admin 拒)对脏数据
    //   稳得 403 而非 409，不因字段级 409 侧信道推断工单 intake_required 状态。
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, dev2Tok, {});
    assert.strictEqual(r.status, 403, 'intake_required=0 脏数据·无权者(dev6) resubmit 得 403 而非 409（侧信道收口）');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权者 403（权限先于不变量）');
    ok('[F] 受理门不变量（引擎层纵深）：intake_required=0+受理态 有权者 409 INTAKE_REQUIRED_INVARIANT(fail-closed) + 无权者 403(不变量在权限后·侧信道收口)；DB 层触发器临时摘除→按 _internals DDL 原样重建并自检');
  } finally {
    // 无论断言是否抛错，都必须把 DB 约束恢复到与生产一致（见组头说明）
    await restoreGateTriggers();
  }
  {
    // 收尾自检：触发器确已按原样重建——再造一条脏数据必须被 ABORT。
    //   放在 finally 之外单独成组，因为它本身是断言（失败该让整个脚本红），不属于清理逻辑。
    const probe = await seedIntakeIssue('feature');
    await assert.rejects(run(`UPDATE sys_issues SET intake_required=0 WHERE id=?`, [probe]),
      /intake_required|受理/, '[F 收尾] 触发器已重建：再写 intake_required=0 会被 ABORT');
    ok('[F 收尾] DB 约束已恢复（摘除→重建闭环自检通过·后续组在与生产一致的约束下运行）');
  }

  // ═══ [G] bug 流受理门完整链 + 失败无副作用（codex MED-4）═══
  {
    sendBehavior = { mode: 'ok' };
    // bug intake_return（待受理→待修改）→ resubmit_intake（待修改→待受理）完整链
    let id = await seedIntakeIssue('bug');
    let r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: 'bug 退改' });
    assert.strictEqual(r.status, 200, 'bug intake_return 200');
    assert.strictEqual(r.body.status, '待修改', 'bug intake_return → 待修改');
    r = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {});   // created_by=admin(1)→admin 代办
    assert.strictEqual(r.status, 200, 'bug resubmit_intake 200');
    assert.strictEqual(r.body.status, '待受理', 'bug resubmit → 待受理');

    // 失败无副作用①：无权限(dev5) intake_accept → 403 后 status/timeline 不变
    id = await seedIntakeIssue('feature');
    const cBefore = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, devTok, {});
    assert.strictEqual(r.status, 403, '无权限 intake_accept 403');
    let row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待受理', '403 后 status 不变（无副作用）');
    const cAfter = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id]);
    assert.strictEqual(cAfter.c, cBefore.c, '403 后无新增 timeline');

    // 失败无副作用②：缺 reason intake_return → 400 后 status/通知不变
    id = await seedIntakeIssue('feature');
    r = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, {});
    assert.strictEqual(r.status, 400, '缺 reason 400');
    row = await get('SELECT status, creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待受理', '400 后 status 不变');
    assert.strictEqual(row.creator_notify_status, 'not_sent', '400 后未发通知');
    ok('[G] bug 受理门链(intake_return→resubmit) + 失败无副作用(403/400 后 status/timeline/通知不变)');
  }

  // ═══ [D] 状态机重放守卫（LOW-1 诚实命名：串行重放测试·非真并发竞态）═══
  //   真并发竞态（双条件 WHERE changes≠1→409）靠 sysBeginImmediate 模块级 mutex 串行化保证（引擎设计层·非本单元测试覆盖）；
  //   此处只证串行重放被 findTransition + 双条件 WHERE(status=fromStatus) 双层拒绝（第二次请求已离开待受理）。
  {
    const id = await seedIntakeIssue('feature');
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, '首次 intake_accept 200');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 400, '重复 intake_accept 400（已非待受理）');
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '重放 400 INVALID_TRANSITION（findTransition 层先拒）');
    ok('[D] 状态机重放守卫：intake_accept 串行重放 400（findTransition + 双条件 WHERE 双层守·真竞态靠 mutex 串行化)');
  }

  // ═══ [E] meta 单一真相（三动作 + roleGuard 后端实现齐）═══
  {
    const meta = I.transitions.buildMeta();
    const labels = meta.actions || {};
    for (const a of ['intake_accept', 'intake_return', 'resubmit_intake']) {
      assert.ok(labels[a], `meta.actions 含 ${a} 标签`);
    }
    assert.ok(I.transitions.KNOWN_ROLE_GUARDS.has('intake_liaison'), 'KNOWN_ROLE_GUARDS 含 intake_liaison');
    assert.ok(I.transitions.KNOWN_ROLE_GUARDS.has('creator_or_admin'), 'KNOWN_ROLE_GUARDS 含 creator_or_admin');
    ok('[E] meta 单一真相：三动作有 ACTION_LABELS + intake_liaison/creator_or_admin ∈ KNOWN_ROLE_GUARDS');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c3 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
