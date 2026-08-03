// scripts/verify-sys-bug-hold-notify.js — S3 验收：bug 暂缓通知两向（暂缓通知建单人 / 重启通知开发）
//   SSOT = 系统迭代_bug暂缓_方案_20260803_v0.4.md §7（全节）+ §13-8 + §10.6
//   用法：node scripts/verify-sys-bug-hold-notify.js
//
// ⚠️ 命名说明：本文件覆盖 S3（两个通知端点 + §7.4 事务内重置）；`verify-sys-bug-hold.js` 是 S5 的全流程
//   收口脚本名，本文件不占用该名字。
//
// ⚠️ 不触发真实钉钉：`_sys-attach-test-deps.js` 的 sendIssueDingtalkRaw 默认 stub 恒返回
//   { ok: true, message_key: 'stub-dev' }，本文件全程走该 stub，全部断言基于落库状态判定，不验证钉钉侧真实送达。
//
// 覆盖（真实 HTTP 端点 + in-process app + 内存库）：
//   [1] 暂缓通知负向四例：非 bug / 非已暂缓 / 非在册非 admin / 本轮已发送
//   [2] 重启通知：普通「处理中」单（从未 hold 过）→ 拒绝
//   [3] ⭐ 暂缓→resume→(submit→)return→处理中 → 拒绝（最近入边 return，action_code=NULL）
//   [4] ⭐ 暂缓→resume→…→close→reopen→处理中 → 拒绝（最近入边 reopen，action_code=NULL）
//   [5] ⭐ 暂缓→resume→处理中（正常路径）→ 放行（正例，防判据过严）
//   [6] 变更流暂缓单 → 两个通知端点均拒绝（type 门限）
//   [7] ⭐ 跨场景污染反证：单先经模拟的"其他场景通知成功"（creator_notify_status='sent'）→ 走真实 hold
//       事务 → §7.4 已重置 → 暂缓通知仍可发送
//   [8] ⭐ 子表重置反证：resume 前把子表某在册行 notify_status/read_at 等置脏 → 走真实 resume 事务 →
//       §7.4 已把该行重置回本轮初始态
//   [9] 同轮重复点击 → 明确拒绝（NOTIFY_ALREADY_SENT）；新一轮（真实 hold/resume 走一遍）→ 状态确为 not_sent
//   [10] self-guard：操作者==建单人时跳过发送，列状态保持 not_sent（不写 sent）
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-hold-notify-secret';
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

// S3b2·M-1：可计数的 sendIssueDingtalkRaw stub——覆盖 _sys-attach-test-deps.js 的默认版本（同样恒成功，
//   非真实钉钉），用于并发 CAS 断言"钉钉 stub 只被调用 N 次"（证明没有重复真实发送）。
let dingtalkCallCount = 0;
async function countingSendIssueDingtalkRaw(_targetUser, _title, _md) {
  dingtalkCallCount++;
  return { ok: true, message_key: `stub-dev-${dingtalkCallCount}` };
}

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // sendIssueDingtalkRaw stub（恒成功，非真实钉钉）
  sendIssueDingtalkRaw: countingSendIssueDingtalkRaw,   // 覆盖上一行 spread 里的默认 stub（对象属性顺序，后者生效）
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

// ── 造数 helper（同 verify-sys-bug-hold-guard.js 范式：raw SQL 直插直接构造目标态）──────────
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const oa = (type === 'feature' || type === 'improvement')
    ? (extra.oaNumber === null ? null : (extra.oaNumber || '20260728300')) : null;
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, oa_number)
     VALUES (?, ?, ?, 'BMS', '内部', ?, ?, ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, extra.createdBy || 1, extra.createdByName || '管理员', est, oa]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueId, userId, userName, extra.isPrimary ? 1 : 0, devStatus,
     extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  return r.lastID;
}
async function setRep(issueId, userId, userName) {
  await run('UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?, assigned_at = datetime(\'now\',\'localtime\') WHERE id = ?', [userId, userName, issueId]);
}
// 直接造 timeline 主状态入边行（不经真实端点）——用于精确构造 §7.3 算法要辨别的各种"最近入边"场景，
//   逐字对齐真相源：hold/resume 的 action_code 非空，assign/return/reopen 的 action_code 恒 NULL（无该列写入）。
async function seedTimelineRow(issueId, { toStatus, actionCode = null, fromStatus = null, summary = null, operatorName = '造数' }) {
  const r = await run(
    `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name)
     VALUES (?, 'status_change', ?, ?, ?, ?, 1, ?)`,
    [issueId, fromStatus, toStatus, summary, actionCode, operatorName]
  );
  return r.lastID;
}
async function issueRow(issueId) {
  return get('SELECT * FROM sys_issues WHERE id = ?', [issueId]);
}
async function memberRow(daId) {
  return get('SELECT * FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin','dt1'),
    (5,'dev5','开发甲','user','dt5'),(6,'dev6','开发乙','user','dt6'),(8,'dev8','开发丙','user','dt8'),
    (9,'viewer9','观察员','viewer',NULL),
    (20,'creator20','建单人甲','user','dt20'),(21,'creator21','建单人乙','user','dt21')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务（admin1 / dev5,6,8 / creator20,21 / viewer9）');

  // ══════════════════════════════════════════════════════════════════════
  // [1] 暂缓通知负向四例（方案 §10.6 第 23 条）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 1a：非 bug 单 → 409 HOLD_NOTIFY_TYPE_NA
    const id1 = await mkIssue('feature', '已暂缓', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id1, 5, '开发甲', 'pending', { isPrimary: true });
    let r = await call('POST', `/api/sys-issues/${id1}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `1a：非 bug 单应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_NOTIFY_TYPE_NA', '1a：错误码 HOLD_NOTIFY_TYPE_NA');
    ok('[1a] 暂缓通知：非 bug 单 → 409 HOLD_NOTIFY_TYPE_NA');

    // 1b：bug 非已暂缓态 → 409 STATUS_NOT_NOTIFIABLE
    const id1b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id1b, 5, '开发甲', 'pending', { isPrimary: true });
    r = await call('POST', `/api/sys-issues/${id1b}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `1b：非已暂缓态应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '1b：错误码 STATUS_NOT_NOTIFIABLE');
    ok('[1b] 暂缓通知：非已暂缓态 → 409 STATUS_NOT_NOTIFIABLE');

    // 1c：非在册非 admin → 403 NOT_AUTHORIZED_FOR_HOLD（复用 assertBugHoldActor 同款口径）
    const id1c = await mkIssue('bug', '已暂缓', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id1c, 5, '开发甲', 'pending', { isPrimary: true });
    await seedTimelineRow(id1c, { toStatus: '已暂缓', actionCode: 'hold', fromStatus: '处理中', summary: '暂缓' });
    r = await call('POST', `/api/sys-issues/${id1c}/notify-hold-creator`, devTok(8), {});
    assert.strictEqual(r.status, 403, `1c：非在册非 admin 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_HOLD', '1c：错误码 NOT_AUTHORIZED_FOR_HOLD');
    ok('[1c] 暂缓通知：非在册非 admin → 403 NOT_AUTHORIZED_FOR_HOLD');

    // 1d：本轮已发送 → 409 NOTIFY_ALREADY_SENT
    const id1d = await mkIssue('bug', '已暂缓', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id1d, 5, '开发甲', 'pending', { isPrimary: true });
    await seedTimelineRow(id1d, { toStatus: '已暂缓', actionCode: 'hold', fromStatus: '处理中', summary: '暂缓' });
    await run(`UPDATE sys_issues SET creator_notify_status = 'sent' WHERE id = ?`, [id1d]);
    r = await call('POST', `/api/sys-issues/${id1d}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `1d：本轮已发送应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_ALREADY_SENT', '1d：错误码 NOTIFY_ALREADY_SENT');
    ok('[1d] 暂缓通知：本轮已发送 → 409 NOTIFY_ALREADY_SENT');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [2] 重启通知：普通「处理中」单（从未 hold 过）→ 拒绝（方案 §10.6 第 24 条，233 H-5 核心攻击面）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id2 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id2, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id2, 5, '开发甲');
    // 从未 hold 过 → timeline 里没有任何 to_status='处理中' 的行（或即便有，也不是 resume）——这里连造都不造，模拟"从未流转过"。
    const r = await call('POST', `/api/sys-issues/${id2}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[2]：普通处理中单应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_ANCHOR_NOT_FOUND', '[2]：错误码 RESUME_ANCHOR_NOT_FOUND');
    ok('[2] 重启通知：普通「处理中」单（从未 hold 过）→ 409 RESUME_ANCHOR_NOT_FOUND（233 H-5 核心攻击面）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [3] ⭐ 暂缓→resume→return→处理中 → 拒绝（方案 §10.6 第 25 条·234 H-1 教训）
  //   最近一次进入「处理中」的入边是 return（action_code=NULL，非 resume），必须拒绝——
  //   若误用 action_code IN ('resume','return','reopen','assign') 做筛选条件，return 行的 action_code
  //   为 NULL 会被 SQL IN 判定不匹配、一条都选不中，"最近入口"会错误落回更早那条 resume 行，H-1 修复失效。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id3 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id3, 5, '开发甲', 'pending', { isPrimary: true });
    await seedTimelineRow(id3, { toStatus: '已暂缓', actionCode: 'hold', fromStatus: '处理中' });
    await seedTimelineRow(id3, { toStatus: '处理中', actionCode: 'resume', fromStatus: '已暂缓' });
    // submit 本身不写 sys_issue_timeline（写 sys_issue_dev_events，见 index.js handleDevSubmit），故此处无需
    // 为 submit 单独造一行——直接接 return 的入边（这正是 §7.3 算法要考验的"跳过 submit"路径）。
    await seedTimelineRow(id3, { toStatus: '处理中', actionCode: null, fromStatus: '待验证', summary: '打回' });   // return：action_code 结构性恒 NULL
    const r = await call('POST', `/api/sys-issues/${id3}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[3]：return 路径应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_ANCHOR_NOT_FOUND', '[3]：错误码 RESUME_ANCHOR_NOT_FOUND');
    ok('[3] 算法单测（造数）⭐ 暂缓→resume→submit→return→处理中 → 409 RESUME_ANCHOR_NOT_FOUND（最近入边 return，action_code=NULL，234 H-1；本组 raw SQL 直造 timeline，只证明"给定真值表下算法有效"，真实链路是否真写出这张真值表见 [3b]）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [3b] ⭐⭐ S3b2·M-2：真实 HTTP 链路版——hold→resume→submit→return→处理中 走真实端点（不造数），
  //   证明"真实路径确实会写出 [3] 假设的那张真值表"（return 的 action_code 结构性为 NULL），而非只验证
  //   "给定真值表下算法有效"。同时直接断言 action_code IS NULL 本身——锁住真值表，一旦将来有人给 return
  //   补上 action_code（比如为统一审计口径），这里会先红，而不是等到生产误发才发现。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id3b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id3b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id3b, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id3b}/hold`, devTok(5), { reason: '[3b] 真实链路暂缓' });
    assert.strictEqual(r.status, 200, `[3b]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id3b}/resume`, adminTok, { reason: '[3b] 真实链路重启' });
    assert.strictEqual(r.status, 200, `[3b]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[3b]：resume 落处理中');
    r = await call('POST', `/api/sys-issues/${id3b}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '[3b] 真实链路提交（占位理由）' });
    assert.strictEqual(r.status, 200, `[3b]：submit 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[3b]：唯一在册开发全完成 → W-GATE 自动转待验证');
    r = await call('POST', `/api/sys-issues/${id3b}/return`, adminTok, { reason: '[3b] 真实链路打回' });
    assert.strictEqual(r.status, 200, `[3b]：return 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[3b]：return 落处理中');
    // ⭐ 直接锁真值表本身：真实 return 端点写出的最新 to_status='处理中' 行，action_code 必须为 NULL。
    const latestRow3b = await get(`SELECT action_code FROM sys_issue_timeline WHERE issue_id=? AND to_status='处理中' ORDER BY id DESC LIMIT 1`, [id3b]);
    assert.strictEqual(latestRow3b.action_code, null, '[3b]：真实 return 端点写出的行 action_code 确为 NULL（锁定真值表本身，非算法假设）');
    r = await call('POST', `/api/sys-issues/${id3b}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[3b]：真实链路 return 后应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_ANCHOR_NOT_FOUND', '[3b]：真实链路错误码 RESUME_ANCHOR_NOT_FOUND');
    ok('[3b] 真实链路 ⭐⭐ hold→resume→submit→return→处理中（全程走真实端点，不造数）→ notify-resume-dev 409 + 直接锁定 return 行 action_code IS NULL 真值表本身（M-2）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [4] ⭐ 暂缓→resume→…→close→reopen→处理中 → 拒绝（方案 §10.6 第 26 条·同上教训）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id4 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id4, 5, '开发甲', 'pending', { isPrimary: true });
    await seedTimelineRow(id4, { toStatus: '已暂缓', actionCode: 'hold', fromStatus: '处理中' });
    await seedTimelineRow(id4, { toStatus: '处理中', actionCode: 'resume', fromStatus: '已暂缓' });
    await seedTimelineRow(id4, { toStatus: '已上线', actionCode: null, fromStatus: '待上线' });
    await seedTimelineRow(id4, { toStatus: '已关闭', actionCode: 'close', fromStatus: '已上线' });
    await seedTimelineRow(id4, { toStatus: '处理中', actionCode: null, fromStatus: '已关闭', summary: '重开' });   // reopen：action_code 结构性恒 NULL
    const r = await call('POST', `/api/sys-issues/${id4}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[4]：reopen 路径应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_ANCHOR_NOT_FOUND', '[4]：错误码 RESUME_ANCHOR_NOT_FOUND');
    ok('[4] 算法单测（造数）⭐ 暂缓→resume→…→close→reopen→处理中 → 409 RESUME_ANCHOR_NOT_FOUND（最近入边 reopen，action_code=NULL；本组 raw SQL 直造 timeline，真实链路版见 [4b]）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [4b] ⭐⭐ S3b2·M-2：真实 HTTP 链路版——hold→resume→(SQL 快捷跳到已上线)→close→reopen→处理中。
  //   ⚠️ "已上线"之前的发布/批次机制（hotfix-publish/execute-release，需真实排班表等基础设施，已在
  //   verify-sys-bug-transitions.js 的"完整回环"用例覆盖）与本测试点正交，用 SQL 直接落已上线态是合理
  //   的精简范围（不是在"造要验证的那张真值表"，而是跳过一段与本测试无关的既有脚手架）；
  //   **真正要验证的 close/reopen 两步全部走真实端点**，这才是 return/reopen 的 action_code 真值表所在。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id4b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id4b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id4b, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id4b}/hold`, adminTok, { reason: '[4b] 真实链路暂缓' });
    assert.strictEqual(r.status, 200, `[4b]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id4b}/resume`, adminTok, { reason: '[4b] 真实链路重启' });
    assert.strictEqual(r.status, 200, `[4b]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // 精简范围：SQL 直接跳到已上线（发布/批次机制正交于本测试点，不重复实现），close/reopen 两步全走真实端点。
    await run(`UPDATE sys_issues SET status='已上线', accepted_at=datetime('now'), released_at=datetime('now') WHERE id=?`, [id4b]);
    r = await call('POST', `/api/sys-issues/${id4b}/close`, adminTok, {});
    assert.strictEqual(r.status, 200, `[4b]：真实 close 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id4b}/reopen`, adminTok, { reason: '[4b] 真实链路重开' });
    assert.strictEqual(r.status, 200, `[4b]：真实 reopen 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[4b]：reopen 落处理中');
    // ⭐ 直接锁真值表本身：真实 reopen 端点写出的最新 to_status='处理中' 行，action_code 必须为 NULL。
    const latestRow4b = await get(`SELECT action_code FROM sys_issue_timeline WHERE issue_id=? AND to_status='处理中' ORDER BY id DESC LIMIT 1`, [id4b]);
    assert.strictEqual(latestRow4b.action_code, null, '[4b]：真实 reopen 端点写出的行 action_code 确为 NULL（锁定真值表本身，非算法假设）');
    r = await call('POST', `/api/sys-issues/${id4b}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[4b]：真实链路 reopen 后应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_ANCHOR_NOT_FOUND', '[4b]：真实链路错误码 RESUME_ANCHOR_NOT_FOUND');
    ok('[4b] 真实链路 ⭐⭐ hold→resume→(已上线)→close→reopen→处理中（close/reopen 走真实端点，不造数）→ notify-resume-dev 409 + 直接锁定 reopen 行 action_code IS NULL 真值表本身（M-2）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [5] ⭐ 暂缓→resume→处理中（正常路径）→ 放行（方案 §10.6 第 27 条·正例，防判据过严）
  //   走真实 hold/resume 端点（非直接造数）——顺带验证 §7.4 子表重置真的发生了（notify_status 落 not_sent）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id5 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const da5 = await mkMember(id5, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id5, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id5}/hold`, devTok(5), { reason: '[5] 正常路径暂缓' });
    assert.strictEqual(r.status, 200, `[5]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id5}/resume`, adminTok, { reason: '[5] 正常路径重启' });
    assert.strictEqual(r.status, 200, `[5]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await memberRow(da5)).notify_status, 'not_sent', '[5]：resume 后子表 notify_status 已重置 not_sent（§7.4）');
    r = await call('POST', `/api/sys-issues/${id5}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 200, `[5]：正常路径 notify-resume-dev 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.results.length, 1, '[5]：results 含 1 条（在册开发甲）');
    assert.strictEqual(r.body.results[0].ok, true, '[5]：发送 ok=true（stub 恒成功）');
    assert.strictEqual((await memberRow(da5)).notify_status, 'sent', '[5]：发送后子表 notify_status=sent');
    ok('[5] ⭐ 暂缓→resume→处理中（正常路径，真实端点走一遍）→ notify-resume-dev 200，正例锁定判据不过严');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [6] 变更流暂缓单 → 两个通知端点均拒绝（方案 §10.6 第 28 条）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id6 = await mkIssue('feature', '已暂缓', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id6, 5, '开发甲', 'pending', { isPrimary: true });
    await seedTimelineRow(id6, { toStatus: '已暂缓', actionCode: 'hold', fromStatus: '开发中' });
    let r = await call('POST', `/api/sys-issues/${id6}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `[6]：变更流暂缓通知应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_NOTIFY_TYPE_NA', '[6]：暂缓通知错误码 HOLD_NOTIFY_TYPE_NA');
    r = await call('POST', `/api/sys-issues/${id6}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[6]：变更流重启通知应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_NOTIFY_TYPE_NA', '[6]：重启通知错误码 RESUME_NOTIFY_TYPE_NA');
    ok('[6] 变更流暂缓单 → 两个通知端点均 409 type 门限拒绝（不得对变更流生效）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [7] ⭐ 跨场景污染反证（方案 §10.6 第 29 条·234 H-2）：单先经"其他场景"通知成功（模拟 intake_return 等
  //   通道写 creator_notify_status='sent'）→ 走真实 hold 事务 → §7.4 已重置 → 暂缓通知仍可发送
  // ══════════════════════════════════════════════════════════════════════
  {
    const id7 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id7, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id7, 5, '开发甲');
    // 模拟"其他场景"（如 intake_return）已发送成功——直接落库 sent 态（不依赖真实 intake_return 流程，
    // 聚焦验证的是 hold 事务本身会不会重置，非 intake_return 通道本身，同源写法已在其他 verify 覆盖）。
    await run(`UPDATE sys_issues SET creator_notify_status = 'sent', creator_notified_at = datetime('now'), creator_notify_message_key = 'legacy-key' WHERE id = ?`, [id7]);
    let before = await issueRow(id7);
    assert.strictEqual(before.creator_notify_status, 'sent', '[7]：hold 前 creator_notify_status=sent（模拟跨场景污染）');
    const r1 = await call('POST', `/api/sys-issues/${id7}/hold`, devTok(5), { reason: '[7] 验证跨场景污染反证' });
    assert.strictEqual(r1.status, 200, `[7]：hold 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const after = await issueRow(id7);
    assert.strictEqual(after.creator_notify_status, 'not_sent', '[7]：hold 事务后 creator_notify_status 已重置 not_sent（§7.4，跨场景污染已清除）');
    assert.strictEqual(after.creator_notified_at, null, '[7]：creator_notified_at 已清 NULL');
    assert.strictEqual(after.creator_notify_message_key, null, '[7]：creator_notify_message_key 已清 NULL');
    const r2 = await call('POST', `/api/sys-issues/${id7}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r2.status, 200, `[7]：暂缓通知仍应可发送, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.creator_notify_status, 'sent', '[7]：本轮暂缓通知成功后 creator_notify_status=sent');
    ok('[7] ⭐ 跨场景污染反证：单先经其他场景通知成功（sent）→ 走真实 hold 事务 → §7.4 已重置 → 暂缓通知仍可发送（234 H-2）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [8] ⭐ 子表重置反证（方案 §10.6 第 30 条·235 L-1）：resume 前把子表某在册行的 notify_status 等字段置脏
  //   → 走真实 resume 事务 → 该行所有相关字段回到本轮初始态
  // ══════════════════════════════════════════════════════════════════════
  {
    const id8 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const da8 = await mkMember(id8, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id8, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id8}/hold`, adminTok, { reason: '[8] 暂缓准备验证子表重置' });
    assert.strictEqual(r.status, 200, `[8]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // 暂缓期把该在册行的通知列组置脏（模拟"暂缓前已经手动通知过、留有 sent/failed 痕迹"）——
    // 暂缓期成员本身被 S2 冻结禁止变更在册名单，但通知列组是纯展示字段，直接 SQL 造数模拟历史脏态。
    await run(
      `UPDATE sys_issue_dev_assignees SET notify_status='sent', notified_at=datetime('now'), read_at=datetime('now'),
              notify_message_key='old-key', notify_error='old-err', notify_sent_by=1 WHERE id = ?`,
      [da8]
    );
    const beforeResume = await memberRow(da8);
    assert.strictEqual(beforeResume.notify_status, 'sent', '[8]：resume 前子表 notify_status=sent（模拟脏态）');
    r = await call('POST', `/api/sys-issues/${id8}/resume`, adminTok, { reason: '[8] 验证子表重置反证' });
    assert.strictEqual(r.status, 200, `[8]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterResume = await memberRow(da8);
    assert.strictEqual(afterResume.notify_status, 'not_sent', '[8]：resume 后 notify_status 回到 not_sent');
    assert.strictEqual(afterResume.notified_at, null, '[8]：notified_at 已清 NULL');
    assert.strictEqual(afterResume.read_at, null, '[8]：read_at 已清 NULL');
    assert.strictEqual(afterResume.notify_message_key, null, '[8]：notify_message_key 已清 NULL');
    assert.strictEqual(afterResume.notify_error, null, '[8]：notify_error 已清 NULL');
    assert.strictEqual(afterResume.notify_sent_by, null, '[8]：notify_sent_by 已清 NULL');
    ok('[8] ⭐ 子表重置反证：resume 前子表某在册行 notify_status=sent+已读等脏态 → 真实 resume 事务后该行全部字段回到本轮初始态（235 L-1）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [9] 同轮重复点击 → 明确拒绝；新一轮 → 状态确为 not_sent（方案 §10.6 第 31 条）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 暂缓通知侧
    const id9a = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const da9a = await mkMember(id9a, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id9a, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id9a}/hold`, adminTok, { reason: '[9a] 第一轮暂缓' });
    assert.strictEqual(r.status, 200, '[9a]：hold 200');
    r = await call('POST', `/api/sys-issues/${id9a}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 200, `[9a]：首次发送应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id9a}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `[9a]：同轮重复点击应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_ALREADY_SENT', '[9a]：同轮重复错误码 NOTIFY_ALREADY_SENT');
    // 新一轮：resume → 再 hold → creator_notify_status 应回 not_sent
    r = await call('POST', `/api/sys-issues/${id9a}/resume`, adminTok, { reason: '[9a] 先恢复' });
    assert.strictEqual(r.status, 200, '[9a]：resume 200');
    r = await call('POST', `/api/sys-issues/${id9a}/hold`, adminTok, { reason: '[9a] 新一轮暂缓' });
    assert.strictEqual(r.status, 200, '[9a]：新一轮 hold 200');
    assert.strictEqual((await issueRow(id9a)).creator_notify_status, 'not_sent', '[9a]：新一轮 hold 后 creator_notify_status=not_sent');
    ok('[9a] 暂缓通知：同轮重复点击 → 409 NOTIFY_ALREADY_SENT；新一轮 hold 后状态确为 not_sent');

    // 重启通知侧
    const id9b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const da9b = await mkMember(id9b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id9b, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id9b}/hold`, adminTok, { reason: '[9b] 暂缓' });
    assert.strictEqual(r.status, 200, '[9b]：hold 200');
    r = await call('POST', `/api/sys-issues/${id9b}/resume`, adminTok, { reason: '[9b] 第一轮重启' });
    assert.strictEqual(r.status, 200, '[9b]：resume 200');
    r = await call('POST', `/api/sys-issues/${id9b}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 200, `[9b]：首次发送应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id9b}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 409, `[9b]：同轮重复点击应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_ALREADY_SENT', '[9b]：同轮重复错误码 NOTIFY_ALREADY_SENT');
    // 新一轮：再 hold → resume → 子表 notify_status 应回 not_sent
    r = await call('POST', `/api/sys-issues/${id9b}/hold`, adminTok, { reason: '[9b] 再次暂缓' });
    assert.strictEqual(r.status, 200, '[9b]：再次 hold 200');
    r = await call('POST', `/api/sys-issues/${id9b}/resume`, adminTok, { reason: '[9b] 新一轮重启' });
    assert.strictEqual(r.status, 200, '[9b]：新一轮 resume 200');
    assert.strictEqual((await memberRow(da9b)).notify_status, 'not_sent', '[9b]：新一轮 resume 后子表 notify_status=not_sent');
    ok('[9b] 重启通知：同轮重复点击 → 409 NOTIFY_ALREADY_SENT；新一轮 resume 后状态确为 not_sent');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [10] self-guard：操作者==建单人时跳过发送，列状态保持 not_sent（方案 §10.6 第 32 条）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 建单人 dev5 自己反馈的 bug（created_by=5），暂缓后 dev5（在册且是建单人）自己点「发送通知」→ 应跳过。
    const id10 = await mkIssue('bug', '处理中', { createdBy: 5, createdByName: '开发甲' });
    await mkMember(id10, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id10, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id10}/hold`, devTok(5), { reason: '[10] 建单人自己暂缓自己的单' });
    assert.strictEqual(r.status, 200, `[10]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id10}/notify-hold-creator`, devTok(5), {});
    assert.strictEqual(r.status, 200, `[10]：self-guard 应 200(skipped), got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.skipped, true, '[10]：响应体 skipped=true');
    assert.strictEqual(r.body.code, 'SELF_NOTIFY_SKIPPED', '[10]：错误码 SELF_NOTIFY_SKIPPED');
    const after = await issueRow(id10);
    assert.strictEqual(after.creator_notify_status, 'not_sent', '[10]：self-guard 跳过后 creator_notify_status 仍 not_sent（不写 sent，§7.4 明确要求）');
    assert.strictEqual(after.creator_notify_sent_by, null, '[10]：creator_notify_sent_by 仍 NULL（未真实调用发送/落库）');
    ok('[10] self-guard：操作者==建单人 → {skipped:true, code:SELF_NOTIFY_SKIPPED}，creator_notify_status 保持 not_sent（不误读为已发送）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [11] ⭐ S3b：两处 §7.4 重置必须 bug-only（codex 复核推翻 S3 首版"不分 type"判断，对齐 S2 roster 冻结
  //   守卫 [F] 组的同款回归断言）——变更流 hold/resume 从未重置过 creator_notify_*/子表 notify_* 这两组
  //   列，是既有已上线行为；该列组分别被 intake_return（自动通知建单人）/ notify-developer（手动通知开发）
  //   两个既有场景共用，若不收窄会把这些场景已写入的状态（审计痕迹 + UI 徽章）一并抹掉。
  //   ⚠️ 哨兵值用可辨识的非 NULL 值（具体时间戳字符串 + 可识别 message_key/error 字符串 + 非零 sent_by），
  //   不从 NULL 起步——NULL 对 NULL 恒相等会造成假绿（项目 gotchas 已记过的坑）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const SENTINEL_TIME = '2020-06-15 08:00:00';   // 刻意选一个不会被真实业务逻辑产生的过去时刻，与"当前时间戳"类值绝不混淆

    // 11a：变更流单走 hold → creator_notify_* 六列保持不变（先污染成可辨识哨兵值）
    const id11a = await mkIssue('feature', '开发中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id11a, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id11a, 5, '开发甲');
    await run(
      `UPDATE sys_issues SET creator_notify_status='sent', creator_notified_at=?, creator_notify_message_key='sentinel-key-11a',
              creator_notify_error='sentinel-err-11a', creator_read_at=?, creator_notify_sent_by=1 WHERE id=?`,
      [SENTINEL_TIME, SENTINEL_TIME, id11a]
    );
    assert.strictEqual((await issueRow(id11a)).creator_notify_status, 'sent', '11a：hold 前哨兵 creator_notify_status=sent');
    let r = await call('POST', `/api/sys-issues/${id11a}/hold`, adminTok, { reason: '[11a] 变更流暂缓不应清通知列' });
    assert.strictEqual(r.status, 200, `11a：变更流 hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after11a = await issueRow(id11a);
    assert.strictEqual(after11a.creator_notify_status, 'sent', '11a：变更流 hold 后 creator_notify_status 仍 sent（未被清·S3b bug-only 收窄）');
    assert.strictEqual(after11a.creator_notified_at, SENTINEL_TIME, '11a：creator_notified_at 保持哨兵值');
    assert.strictEqual(after11a.creator_notify_message_key, 'sentinel-key-11a', '11a：creator_notify_message_key 保持哨兵值');
    assert.strictEqual(after11a.creator_notify_error, 'sentinel-err-11a', '11a：creator_notify_error 保持哨兵值');
    assert.strictEqual(after11a.creator_read_at, SENTINEL_TIME, '11a：creator_read_at 保持哨兵值');
    assert.strictEqual(after11a.creator_notify_sent_by, 1, '11a：creator_notify_sent_by 保持哨兵值');
    ok('[11a] ⭐ 变更流单走 hold → creator_notify_* 六列全部保持不变（S3b bug-only 收窄，保护 intake_return 等既有场景写入的状态，零回归）');

    // 11b：变更流单走 resume → 子表 notify_* 六列保持不变（先污染成可辨识哨兵值）
    const id11b = await mkIssue('feature', '开发中', { createdBy: 20, createdByName: '建单人甲' });
    const da11b = await mkMember(id11b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id11b, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id11b}/hold`, adminTok, { reason: '[11b] 先暂缓' });
    assert.strictEqual(r.status, 200, `11b：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(
      `UPDATE sys_issue_dev_assignees SET notify_status='sent', notified_at=?, read_at=?,
              notify_message_key='sentinel-key-11b', notify_error='sentinel-err-11b', notify_sent_by=1 WHERE id=?`,
      [SENTINEL_TIME, SENTINEL_TIME, da11b]
    );
    assert.strictEqual((await memberRow(da11b)).notify_status, 'sent', '11b：resume 前哨兵子表 notify_status=sent');
    r = await call('POST', `/api/sys-issues/${id11b}/resume`, adminTok, { reason: '[11b] 变更流重启不应清通知列' });
    assert.strictEqual(r.status, 200, `11b：变更流 resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after11b = await memberRow(da11b);
    assert.strictEqual(after11b.notify_status, 'sent', '11b：变更流 resume 后子表 notify_status 仍 sent（未被清·S3b bug-only 收窄）');
    assert.strictEqual(after11b.notified_at, SENTINEL_TIME, '11b：notified_at 保持哨兵值');
    assert.strictEqual(after11b.read_at, SENTINEL_TIME, '11b：read_at 保持哨兵值');
    assert.strictEqual(after11b.notify_message_key, 'sentinel-key-11b', '11b：notify_message_key 保持哨兵值');
    assert.strictEqual(after11b.notify_error, 'sentinel-err-11b', '11b：notify_error 保持哨兵值');
    assert.strictEqual(after11b.notify_sent_by, 1, '11b：notify_sent_by 保持哨兵值');
    ok('[11b] ⭐ 变更流单走 resume → 子表 notify_* 六列全部保持不变（S3b bug-only 收窄，保护 notify-developer 既有场景写入的状态，零回归）');

    // 11c：bug 单走 hold/resume → 对应组确实被重置（正例，防收窄过头把该做的也关了）
    const id11c = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const da11c = await mkMember(id11c, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id11c, 5, '开发甲');
    await run(
      `UPDATE sys_issues SET creator_notify_status='sent', creator_notified_at=?, creator_notify_message_key='sentinel-key-11c',
              creator_notify_error='sentinel-err-11c', creator_read_at=?, creator_notify_sent_by=1 WHERE id=?`,
      [SENTINEL_TIME, SENTINEL_TIME, id11c]
    );
    r = await call('POST', `/api/sys-issues/${id11c}/hold`, adminTok, { reason: '[11c] bug 暂缓应清通知列（正例）' });
    assert.strictEqual(r.status, 200, `11c：bug hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterHold11c = await issueRow(id11c);
    assert.strictEqual(afterHold11c.creator_notify_status, 'not_sent', '11c：bug hold 后 creator_notify_status 确被重置 not_sent（正例，未收窄过头）');
    assert.strictEqual(afterHold11c.creator_notified_at, null, '11c：creator_notified_at 确被清 NULL');
    assert.strictEqual(afterHold11c.creator_notify_message_key, null, '11c：creator_notify_message_key 确被清 NULL');

    await run(
      `UPDATE sys_issue_dev_assignees SET notify_status='sent', notified_at=?, read_at=?,
              notify_message_key='sentinel-key-11c-dev', notify_error='sentinel-err-11c-dev', notify_sent_by=1 WHERE id=?`,
      [SENTINEL_TIME, SENTINEL_TIME, da11c]
    );
    r = await call('POST', `/api/sys-issues/${id11c}/resume`, adminTok, { reason: '[11c] bug 重启应清子表通知列（正例）' });
    assert.strictEqual(r.status, 200, `11c：bug resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterResume11c = await memberRow(da11c);
    assert.strictEqual(afterResume11c.notify_status, 'not_sent', '11c：bug resume 后子表 notify_status 确被重置 not_sent（正例，未收窄过头）');
    assert.strictEqual(afterResume11c.notified_at, null, '11c：notified_at 确被清 NULL');
    assert.strictEqual(afterResume11c.notify_message_key, null, '11c：notify_message_key 确被清 NULL');
    ok('[11c] bug 单走 hold/resume → 对应通知列组（主表 creator_notify_* / 子表 notify_*）确实被重置（正例，防 S3b 收窄过头把该做的也关了）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [12] ⭐⭐ S3b2·M-1：并发 CAS claim——同一轮两次调用（真并发发起，Promise.all 不等第一个回写完就发第二个）
  //   只应产生一次真实发送、一次 sent 回写；第二次得到明确 409 NOTIFY_CLAIM_CONFLICT。
  //   ⚠️ 单连接 sqlite3 对同一 DB 的写操作天然按提交顺序序列化——两个并发 HTTP 请求各自的 claim UPDATE
  //   仍会被数据库排出确定的先后手，天然验证 CAS 的原子性，不依赖真实多进程/多连接并发。
  // ══════════════════════════════════════════════════════════════════════
  {
    // 12a：暂缓通知并发
    const id12a = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id12a, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id12a, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id12a}/hold`, adminTok, { reason: '[12a] 并发测试暂缓' });
    assert.strictEqual(r.status, 200, `[12a]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    dingtalkCallCount = 0;
    const [rA, rB] = await Promise.all([
      call('POST', `/api/sys-issues/${id12a}/notify-hold-creator`, adminTok, {}),
      call('POST', `/api/sys-issues/${id12a}/notify-hold-creator`, adminTok, {}),
    ]);
    const statuses12a = [rA.status, rB.status].sort();
    assert.deepStrictEqual(statuses12a, [200, 409], `[12a]：并发两次应恰好一 200 一 409, got ${JSON.stringify([rA.status, rB.status])} bodies=${JSON.stringify([rA.body, rB.body])}`);
    const loser12a = rA.status === 409 ? rA : rB;
    assert.strictEqual(loser12a.body.code, 'NOTIFY_CLAIM_CONFLICT', '[12a]：败者错误码 NOTIFY_CLAIM_CONFLICT');
    assert.strictEqual(dingtalkCallCount, 1, '[12a]：钉钉 stub 只被调用 1 次（未重复真实发送）');
    assert.strictEqual((await issueRow(id12a)).creator_notify_status, 'sent', '[12a]：最终落库状态 sent（胜者写入）');
    ok('[12a] ⭐⭐ 并发 CAS：暂缓通知同轮两次并发调用 → 恰好一次 200(真实发送) + 一次 409 NOTIFY_CLAIM_CONFLICT，钉钉 stub 只调用 1 次（M-1）');

    // 12b：重启通知并发
    const id12b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id12b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id12b, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id12b}/hold`, adminTok, { reason: '[12b] 并发测试暂缓' });
    assert.strictEqual(r.status, 200, `[12b]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id12b}/resume`, adminTok, { reason: '[12b] 并发测试重启' });
    assert.strictEqual(r.status, 200, `[12b]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    dingtalkCallCount = 0;
    const [rC, rD] = await Promise.all([
      call('POST', `/api/sys-issues/${id12b}/notify-resume-dev`, adminTok, {}),
      call('POST', `/api/sys-issues/${id12b}/notify-resume-dev`, adminTok, {}),
    ]);
    const statuses12b = [rC.status, rD.status].sort();
    assert.deepStrictEqual(statuses12b, [200, 409], `[12b]：并发两次应恰好一 200 一 409, got ${JSON.stringify([rC.status, rD.status])} bodies=${JSON.stringify([rC.body, rD.body])}`);
    const loser12b = rC.status === 409 ? rC : rD;
    assert.strictEqual(loser12b.body.code, 'NOTIFY_CLAIM_CONFLICT', '[12b]：败者错误码 NOTIFY_CLAIM_CONFLICT');
    assert.strictEqual(dingtalkCallCount, 1, '[12b]：钉钉 stub 只被调用 1 次（唯一在册开发只应被通知一次，未重复真实发送）');
    ok('[12b] ⭐⭐ 并发 CAS：重启通知同轮两次并发调用 → 恰好一次 200(真实发送) + 一次 409 NOTIFY_CLAIM_CONFLICT，钉钉 stub 只调用 1 次（M-1）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [13] S3b2·L-1：hold 侧锚点判据统一——合法 hold 之后若又出现一条更晚的 to_status='已暂缓' 但
  //   action_code 非 hold 的行（模拟"未来某个非 hold 方式进入已暂缓"，当前生产无此路径，纯粹证明判据
  //   不会误判/回落），暂缓通知应拒绝，不静默回落到更早那条真正的 hold 行。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id13 = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    await mkMember(id13, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id13, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id13}/hold`, adminTok, { reason: '[13] 合法暂缓' });
    assert.strictEqual(r.status, 200, `[13]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // 追加一条更晚的 to_status='已暂缓' 但 action_code 非 hold 的行（模拟未来某个假想的非 hold 路径；
    // 当前生产没有这样的路径，本行只是构造出"最近入边不是 hold"这个前提，验证判据不会静默回落）。
    await seedTimelineRow(id13, { toStatus: '已暂缓', actionCode: null, fromStatus: '已暂缓', summary: '模拟非 hold 方式进入已暂缓' });
    r = await call('POST', `/api/sys-issues/${id13}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `[13]：应拒绝, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_ANCHOR_NOT_FOUND', '[13]：错误码 HOLD_ANCHOR_NOT_FOUND（不回落到更早的合法 hold 行）');
    ok('[13] S3b2·L-1：hold 侧锚点统一判据——最近一条 to_status=已暂缓 若非 hold，即使更早存在合法 hold 行也拒绝、不静默回落（与重启侧同构算法）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [14] ⭐⭐ S5b·M-1（末次合并审 codex 239 复审确认真缺陷）：CAS claim 后业务失败必须释放 claim，
  //   否则永久卡死（直到再次 hold/resume 才被 §7.4 重置）。两个端点各构造一次"claim 后失败"场景，
  //   断言：① 错误码正确 ② claim 令牌确已释放为 NULL（非停留在 claimToken）③ 释放后可重新发起，
  //   不会误报 NOTIFY_CLAIM_CONFLICT（证明"卡死"链条已断，而非只是错误码对了但状态仍脏）。
  // ══════════════════════════════════════════════════════════════════════
  {
    // [14a] 暂缓通知建单人：created_by 指向不存在的用户（孤儿 created_by／用户表历史清理的等价场景）。
    //   修法后 creator 查询已提到 claim 之前，claim 从未被占用——用同一条断言链证明"不会卡死"这件事，
    //   不区分"从未占用"与"占用后释放"两种实现方式（对调用方可观测的结果是同一件事：可重试、不卡死）。
    const id14a = await mkIssue('bug', '处理中', { createdBy: 999, createdByName: '幽灵建单人' });   // 999 从未插入 users 表
    const da14a = await mkMember(id14a, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id14a, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id14a}/hold`, devTok(5), { reason: '[14a] 准备验证 claim 后失败释放' });
    assert.strictEqual(r.status, 200, `[14a]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id14a}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `[14a]：建单人不存在应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'CREATOR_NOT_FOUND', '[14a]：错误码 CREATOR_NOT_FOUND');
    let claimAfter14a = (await issueRow(id14a)).creator_notify_message_key;
    assert.strictEqual(claimAfter14a, null, '[14a]：⭐ 第一次失败后 creator_notify_message_key 确为 NULL（未卡死在 claimToken）');
    // 再点一次：若真卡死，这里会得到 NOTIFY_CLAIM_CONFLICT 而非 CREATOR_NOT_FOUND——用第二次调用直接证伪"卡死"。
    r = await call('POST', `/api/sys-issues/${id14a}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 409, `[14a]：第二次调用仍应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'CREATOR_NOT_FOUND', '[14a]：⭐ 第二次调用错误码仍是 CREATOR_NOT_FOUND（非 NOTIFY_CLAIM_CONFLICT，证明未卡死，可重复发起）');
    // 补建单人用户后重试 → 应成功（进一步证明"可恢复"，非只是错误码巧合一致）。
    await run(`INSERT INTO users (id, username, display_name, role, dingtalk_user_id) VALUES (999,'ghost999','幽灵建单人','user','dt999')`);
    r = await call('POST', `/api/sys-issues/${id14a}/notify-hold-creator`, adminTok, {});
    assert.strictEqual(r.status, 200, `[14a]：⭐ 补建用户后应 200（完全恢复，非仅错误码变化）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.creator_notify_status, 'sent', '[14a]：补建用户后成功发送');
    ok('[14a] ⭐⭐ S5b·M-1：暂缓通知建单人——建单人用户不存在（claim 后业务失败等价场景）→ 409 CREATOR_NOT_FOUND + message_key 确为 NULL + 二次调用仍是同一错误码（非 NOTIFY_CLAIM_CONFLICT，证伪卡死）+ 补建用户后可完全恢复发送（index.js:10192 附近，修法：creator 查询提到 claim 之前）');

    // [14b] 重启通知开发（批量）：roster 中一个 dev_assignee 的 user_id 指向不存在的用户（同类 claim 后
    //   dev_not_found 路径）——本路径修法前就已用 recordSysDevAssigneeNotify(...,false,...) 正确释放
    //   （非本次新发现的 bug），但此前从未有断言直接验证过，本组补上 + 复核 S5b 新加的 sendIssueDingtalkRaw
    //   防御性 try/catch 未改变既有正确行为（回归断言）。
    const id14b = await mkIssue('bug', '处理中', { createdBy: 20, createdByName: '建单人甲' });
    const daReal14b = await mkMember(id14b, 5, '开发甲', 'pending', { isPrimary: true });
    const daGhost14b = await mkMember(id14b, 888, '幽灵开发', 'pending');   // 888 从未插入 users 表
    await setRep(id14b, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id14b}/hold`, adminTok, { reason: '[14b] 准备验证批量场景 claim 后失败释放' });
    assert.strictEqual(r.status, 200, `[14b]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id14b}/resume`, adminTok, { reason: '[14b] 重启' });
    assert.strictEqual(r.status, 200, `[14b]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id14b}/notify-resume-dev`, adminTok, {});
    assert.strictEqual(r.status, 200, `[14b]：批量发送应 200（真实成员成功，幽灵成员单独失败，整批不因一行失败而全失败）, got ${r.status} ${JSON.stringify(r.body)}`);
    const ghostResult14b = r.body.results.find(x => x.dev_assignee_id === daGhost14b);
    assert.ok(ghostResult14b, '[14b]：results 含幽灵成员那一行');
    assert.strictEqual(ghostResult14b.ok, false, '[14b]：幽灵成员那一行 ok=false');
    assert.strictEqual(ghostResult14b.reason, 'dev_not_found', '[14b]：幽灵成员那一行 reason=dev_not_found');
    const ghostRow14b = await memberRow(daGhost14b);
    assert.strictEqual(ghostRow14b.notify_message_key, null, '[14b]：⭐ 幽灵成员那一行 notify_message_key 确为 NULL（未卡死）');
    const realRow14b = await memberRow(daReal14b);
    assert.strictEqual(realRow14b.notify_status, 'sent', '[14b]：真实成员那一行已正常发送（未被幽灵成员那行拖累整批失败）');
    // 再点一次：真实成员已 sent 不在 pending 内，幽灵成员仍 not_sent/failed（视 recordSysDevAssigneeNotify
    // 落库值而定）会重新进入 pending——若卡死会得到 claim_conflict，若正常会再次得到 dev_not_found（可重试）。
    r = await call('POST', `/api/sys-issues/${id14b}/notify-resume-dev`, adminTok, {});
    if (r.status === 200) {
      const ghostResult14b2 = r.body.results.find(x => x.dev_assignee_id === daGhost14b);
      assert.ok(ghostResult14b2 && ghostResult14b2.reason === 'dev_not_found', `[14b]：⭐ 二次调用幽灵成员仍可重试并得到 dev_not_found（非卡死）, got ${JSON.stringify(ghostResult14b2)}`);
    } else {
      assert.fail(`[14b]：⭐ 二次调用不应 409（会意味着幽灵成员那行卡死），got ${r.status} ${JSON.stringify(r.body)}`);
    }
    ok('[14b] ⭐⭐ S5b·M-1：重启通知开发（批量）——dev_not_found（claim 后业务失败）路径 message_key 确为 NULL（此前既有实现已正确，本组首次补断言锁定）+ 二次调用可重试不卡死 + S5b 新加 sendIssueDingtalkRaw 防御性 try/catch 未破坏既有正确行为（回归）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 bug 暂缓通知两向验证通过（S3/S3b/S3b2/S5b）`);
  console.log('  覆盖：[1]暂缓通知负向四例 + [2]普通处理中单拒绝 + [3]/[3b]return路径拒绝(算法单测+真实链路) + [4]/[4b]reopen路径拒绝(算法单测+真实链路) + [5]正常路径放行 + [6]变更流双端点拒绝 + [7]跨场景污染反证 + [8]子表重置反证 + [9]同轮拒绝/新轮not_sent + [10]self-guard + [11]S3b bug-only收窄回归断言 + [12]并发CAS claim(M-1) + [13]hold侧锚点统一判据(L-1) + [14]S5b claim后业务失败必释放(两端点各一例+可重试证伪卡死)');
  server.close();
  db.close();
}

main().catch((err) => {
  console.error('\n[失败]', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  try { server && server.close(); } catch (_) {}
  process.exitCode = 1;
});
