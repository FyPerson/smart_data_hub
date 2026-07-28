// 验证脚本：系统迭代 受理排期改造 C5 — 技术负责人通知（request_tech_consult + resend + 请求版本/结果归属）
//   用法：node scripts/verify-sys-intake-schedule-c5.js
//
// 覆盖（真实 HTTP + 条件落库直测）：
//   ⚠️ 角色权限重构 v2.1（C2.5 撤销）：request_tech_consult 的开放态谓词全类型统一为「待受理」
//     （sysTechConsultGateStatus）——预沟通段/「待商议」整体撤销，seedIntake 默认状态与本组断言同步改为
//     「待受理」；bug 侧不变（另见 verify-sys-tech-lead-comment.js [M] 组回归）。
//   ⭐⭐ 角色权限重构 v2.1 §6（S5 通知手动化·方案 v2.1 §6·用户拍板 D4）：request_tech_consult 首发/换轮
//     不再自动发钉钉——响应/落库恒 tech_lead_notify_status='not_sent'，投递字段整组 NULL，response 不再含
//     superseded。真实发送改经既有 resend-tech-consult 端点（机制不变：expected_request_event_id 围栏/
//     已留言 409/条件落库），首发也从"not_sent"态调它。原先挂在 request 上的发送结果场景（失败注入/
//     message_key 缺失降级/reset 观察）全部改经 resend 触发。
//   [R] request_tech_consult（待受理·requireIntakeLiaison·选技术负责人）：
//       受理人(13)/admin 200 + tech_lead_id/name 派生 + request_event_id 设 + not_sent（S5：不再自动发）+
//       timeline(note/request_tech_consult/summary含技术负责人) + 非白名单 tech_lead 400 / 缺 tech_lead_id 400 /
//       非受理人(dev5) 403 中间件 / 非开放态 409 + resend 才真正发送(sent)
//   [V] 请求版本 + 结果归属（§6·codex 128-M/130-H）：换人/同人连发生成新 request_event_id + 重置投递字段（sent_by/read_at/error 清·
//       落 not_sent 非 failed）；resend 触发失败注入 → failed + sent_by 非空（§8.3 failed⟹sent_by）；sent⟹notified_at+message_key+sent_by
//   [S] 拒过期回写（条件 request_event_id）：直测 recordSysTechLeadNotify 旧 request_event_id → changes=0（不覆盖新版本投递态，S5 下该态是 not_sent）
//   [RS] resend-tech-consult（admin∨受理人∨建单人·expected_request_event_id）：
//       admin/受理人/建单人 200 / 非授权(dev6) 403 / expected 不一致 409 VERSION_CONFLICT / 未发起 409 NO_TECH_CONSULT / 缺 expected 400
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-c5-secret';
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

// 可控通知桩：sendBehavior 决定发送结果·lastSent 捕获收件人
let sendBehavior = { mode: 'ok' };   // 'ok' | 'fail' | 'ok_nokey'（ok 但漏 message_key·测 HIGH-3 降级）
let lastSent = null;
async function mockSendIssueDingtalkRaw(user, title, md) {
  lastSent = { userId: user && user.id, title, md };
  if (sendBehavior.mode === 'fail') return { ok: false, reason: 'no_phone' };
  if (sendBehavior.mode === 'ok_nokey') return { ok: true };   // 送达但无 message_key
  return { ok: true, message_key: 'stub-tl' };
}
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人
// 技术负责人 id=7 示例发布者（SYS_TECH_LEAD_IDS=[7]）

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

async function createIssue(type) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: `${type}单`, system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status}`);
  // ⭐ codex Round-B 审 MED（采纳）：原先这里还有一句 intake-accept 残留调用（C2.5 起对 feature 恒 409、
  //   未断言、静默忽略）——已删除。删除前逐一核实本文件全部 14 处 createIssue() 调用点，确认**每一处**
  //   紧随其后都跟着 seedIntake()（见文件内 grep 结果，无遗漏）；换言之该调用的返回值从未被依赖过，
  //   落态恒由随后的 seedIntake 原子 SQL 强制覆盖。留着的风险：它是一次**未断言的写调用**——若哪天
  //   守卫层意外回归、这句 409 变回 200 真的执行了受理，其副作用（写 timeline/字段）会被 seedIntake
  //   的原子 SQL 覆盖值悄悄掩盖，谁都不会发现；删除它更干净，且不影响任何断言（本就没人读它的返回值）。
  return r.body.id;
}
// ⭐ 角色权限重构 v2.1（C2.5 撤销）：默认状态回归「待受理」——本文件仅测 feature 单，其 request_tech_consult
//   开放态谓词已全类型归一「待受理」；未显式传 status 的调用点全部同步跟随（单点改，防各调用点各自硬编码漂移）。
async function seedIntake(id, { status = '待受理', created_by } = {}) {
  const sets = ['intake_required = 1', 'status = ?']; const params = [status];
  if (created_by !== undefined) { sets.push('created_by = ?'); params.push(created_by); }
  await run(`UPDATE sys_issues SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),(6,'dev2','开发李','user','13800000006'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  assert.deepStrictEqual(I.SYS_TECH_LEAD_IDS, [7], 'SYS_TECH_LEAD_IDS=[7] 示例发布者');
  ok('readiness ready + HTTP harness（受理人 13 / 技术负责人 7）+ SYS_TECH_LEAD_IDS=[7]');

  // ═══ [R] request_tech_consult（待受理·选技术负责人+首发已删·S5 通知手动化）═══
  //   ⭐ 角色权限重构 v2.1 §6（S5·方案 v2.1 §6·用户拍板 D4）：request-tech-consult 不再自动发钉钉——
  //   首发/换轮恒落 not_sent，真实发送改经既有 resend-tech-consult 端点触发（[V]/[RS] 组改走该路径）。
  {
    sendBehavior = { mode: 'ok' };
    // 受理人(13) request tech_lead(7) → 200 + 派生 name + request_event_id + not_sent（不再自动发）
    let id = await createIssue('feature'); await seedIntake(id);
    lastSent = null;
    let r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(r.status, 200, `受理人 request-tech-consult 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.tech_lead_id, 7, 'tech_lead_id=7');
    assert.strictEqual(r.body.tech_lead_name, '示例发布者', 'tech_lead_name 服务端派生=示例发布者');
    assert.ok(r.body.request_event_id > 0, 'request_event_id 已设');
    assert.strictEqual(r.body.tech_lead_notify_status, 'not_sent', 'S5：首发响应恒 not_sent（不再自动发）');
    assert.strictEqual(r.body.superseded, undefined, 'S5：响应不再含 superseded 字段（随首发回写一并退场）');
    assert.strictEqual(lastSent, null, 'S5：首发零外部发送调用（stub 未被触达）');
    // 状态旁路：不改 status（仍待受理）
    let row = await get('SELECT status, tech_lead_id, tech_lead_name, tech_lead_notify_request_event_id, tech_lead_notify_sent_by, tech_lead_notified_at, tech_lead_notify_message_key, tech_lead_read_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待受理', 'request_tech_consult 不改 status（旁路）');
    assert.strictEqual(Number(row.tech_lead_notify_request_event_id), r.body.request_event_id, 'request_event_id 落库');
    // S5：not_sent⟹整组投递字段恒 NULL（首发不再写任何投递结果）
    assert.strictEqual(row.tech_lead_notify_sent_by, null, 'S5：not_sent⟹sent_by 空（首发不落）');
    assert.strictEqual(row.tech_lead_notified_at, null, 'S5：not_sent⟹notified_at 空');
    assert.strictEqual(row.tech_lead_notify_message_key, null, 'S5：not_sent⟹message_key 空');
    assert.strictEqual(row.tech_lead_read_at, null, 'read_at 空（从未发送·未曾读）');
    // timeline note + action_code + summary 含技术负责人（发起动作本身仍留痕，与是否发送正交）
    const tl = await get(`SELECT event_type, action_code, summary, operator_id, id FROM sys_issue_timeline WHERE issue_id=? AND action_code='request_tech_consult' ORDER BY id DESC LIMIT 1`, [id]);
    assert.strictEqual(tl.event_type, 'note', 'timeline event_type=note');
    assert.ok(tl.summary.includes('示例发布者'), 'summary 含技术负责人快照');
    assert.strictEqual(Number(tl.id), r.body.request_event_id, 'request_event_id = timeline 事件 id（结果归属锚点）');
    // ⭐ S5 新增：真实发送改经 resend-tech-consult——本轮 not_sent 态下调用应 200 → sent + 触达 stub
    const rs = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: r.body.request_event_id });
    assert.strictEqual(rs.status, 200, `S5：not_sent 态 resend-tech-consult 应 200, got ${rs.status} ${JSON.stringify(rs.body)}`);
    assert.strictEqual(rs.body.tech_lead_notify_status, 'sent', 'S5：resend 才真正发送 → sent（stub ok）');
    assert.ok(lastSent && Number(lastSent.userId) === 7, 'S5：resend 实际发给技术负责人(7)（首发未发的调用在此触达）');
    const rowAfterResend = await get('SELECT tech_lead_notify_sent_by, tech_lead_notified_at, tech_lead_notify_message_key FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(Number(rowAfterResend.tech_lead_notify_sent_by), 13, 'resend 后 sent_by=操作者13');
    assert.ok(rowAfterResend.tech_lead_notified_at, 'resend 后 notified_at 非空');
    assert.strictEqual(rowAfterResend.tech_lead_notify_message_key, 'stub-tl', 'resend 后 message_key 非空');

    // admin → 200
    id = await createIssue('feature'); await seedIntake(id);
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, adminTok, { tech_lead_id: 7 });
    assert.strictEqual(r.status, 200, 'admin request-tech-consult 200');

    // 非白名单 tech_lead(id=5 开发) → 400
    id = await createIssue('feature'); await seedIntake(id);
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 5 });
    assert.strictEqual(r.body.code, 'TECH_LEAD_NOT_WHITELISTED', '非白名单技术负责人 400');
    // 缺 tech_lead_id → 400
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, {});
    assert.strictEqual(r.body.code, 'TECH_LEAD_ID_REQUIRED', '缺 tech_lead_id 400');
    // 非受理人(dev5) → 403 中间件
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, devTok, { tech_lead_id: 7 });
    assert.strictEqual(r.status, 403, '非受理人 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', '403 中间件层');
    // 非开放态(待指派) → 409（显式强制落态到「待指派」——v2.1 起 feature 裸建单直落「待受理」
    //   与开放态谓词相同，必须显式 seedIntake 到别的态才能测"离开开放态"这条语义）
    id = await createIssue('feature'); await seedIntake(id, { status: '待指派' });
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, adminTok, { tech_lead_id: 7 });
    assert.strictEqual(r.body.code, 'REQUEST_TECH_CONSULT_STATUS_INVALID', '非开放态 409');
    ok('[R] request_tech_consult：受理人/admin 200(派生name+request_event_id+首发sent+§8.3字段) + 非白名单/缺id 400 + 非受理人 403 + 非开放态 409');
  }

  // ═══ [V] 请求版本 + 结果归属（换人/连发新版本+重置·首发失败注入）═══
  {
    // 同人连发（非仅换人·§6 130-H）：request(7) → request(7) 再次 → 新 request_event_id
    sendBehavior = { mode: 'ok' };
    let id = await createIssue('feature'); await seedIntake(id);
    let r1 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const ev1 = r1.body.request_event_id;
    let r2 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const ev2 = r2.body.request_event_id;
    assert.ok(ev2 > ev1, '同人连发也生成新 request_event_id（非仅换人·§6）');
    let row = await get('SELECT tech_lead_notify_request_event_id FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(Number(row.tech_lead_notify_request_event_id), ev2, '主表 request_event_id = 最新 ev2');

    // ⭐ S5：首发失败/降级等"发送结果处理"场景，改经 resend-tech-consult 触发（request 本身不再尝试发送）。
    // 换人（7→7 已测同人；此处验重置：resend 失败注入，再新 request+resend 重置为 sent）
    // 首发（经 resend）失败注入 → failed + sent_by 非空（§8.3 failed⟹sent_by）
    sendBehavior = { mode: 'fail' };
    id = await createIssue('feature'); await seedIntake(id);
    r1 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(r1.body.tech_lead_notify_status, 'not_sent', 'S5：request 恒 not_sent（不再自动发）');
    let rsFail = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: r1.body.request_event_id });
    assert.strictEqual(rsFail.body.tech_lead_notify_status, 'failed', 'S5：resend 触发发送失败 → failed');
    row = await get('SELECT tech_lead_notify_status, tech_lead_notify_error, tech_lead_notify_sent_by, tech_lead_notify_message_key FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.tech_lead_notify_error, 'no_phone', 'failed⟹error 非空');
    assert.strictEqual(Number(row.tech_lead_notify_sent_by), 13, 'failed⟹sent_by 非空（本次投递操作者）');
    assert.strictEqual(row.tech_lead_notify_message_key, null, 'failed⟹message_key 空');
    // 再 request（重置为 not_sent）+ resend 成功 → sent（新版本覆盖旧 failed）
    sendBehavior = { mode: 'ok' };
    r2 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(r2.body.tech_lead_notify_status, 'not_sent', 'S5：换轮后仍 not_sent（重置生效·旧 failed 不残留）');
    const rsOk = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: r2.body.request_event_id });
    assert.strictEqual(rsOk.body.tech_lead_notify_status, 'sent', '重新发起+resend 成功 → sent（覆盖旧 failed·新版本）');

    // 重置观察（MED-7）：预置旧投递字段 → request（不发送，只重置）→ 断言旧 message_key/read_at 被清 + 落 not_sent
    id = await createIssue('feature'); await seedIntake(id);
    await run(`UPDATE sys_issues SET tech_lead_notify_message_key='OLD-KEY', tech_lead_read_at='2026-01-01 00:00', tech_lead_notify_status='sent' WHERE id=?`, [id]);
    await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    row = await get('SELECT tech_lead_notify_message_key, tech_lead_read_at, tech_lead_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.tech_lead_notify_message_key, null, '重置清旧 message_key');
    assert.strictEqual(row.tech_lead_read_at, null, '重置清旧 read_at');
    assert.strictEqual(row.tech_lead_notify_status, 'not_sent', 'S5：request 重置整组为 not_sent（不再落 failed，因为压根不尝试发）');

    // HIGH-3：send ok 但漏 message_key → 降级 failed(message_key_missing)（§8.3 sent⟹message_key）——经 resend 触发
    sendBehavior = { mode: 'ok_nokey' };
    id = await createIssue('feature'); await seedIntake(id);
    r1 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const rsNokey = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: r1.body.request_event_id });
    assert.strictEqual(rsNokey.body.tech_lead_notify_status, 'failed', 'S5：resend 时 send ok 但无 message_key → 降级 failed（HIGH-3）');
    row = await get('SELECT tech_lead_notify_error, tech_lead_notify_message_key FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.tech_lead_notify_error, 'message_key_missing', 'failed error=message_key_missing');
    assert.strictEqual(row.tech_lead_notify_message_key, null, 'message_key 保持 null');

    // 两条 request timeline 保留（连发不删旧·MED-7）
    sendBehavior = { mode: 'ok' };
    id = await createIssue('feature'); await seedIntake(id);
    await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const tlCnt = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='request_tech_consult'`, [id]);
    assert.strictEqual(tlCnt.c, 2, '连发两次 → 保留两条 request_tech_consult timeline（历史不删）');
    ok('[V] 请求版本+结果归属：同人连发新 request_event_id + 首发失败 failed(§8.3) + 重置清旧字段 + HIGH-3 无message_key降级failed + 两 timeline 保留');
  }

  // ═══ [S] 拒过期回写（条件 request_event_id·直测 recordSysTechLeadNotify changes=0）═══
  {
    sendBehavior = { mode: 'ok' };
    const id = await createIssue('feature'); await seedIntake(id);
    const r1 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const evOld = r1.body.request_event_id;
    // 再发起 → request_event_id 变为 evNew（模拟"回写前又 request 换版本"）
    const r2 = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    const evNew = r2.body.request_event_id;
    assert.ok(evNew > evOld, '新版本 evNew>evOld');
    // 直测：用旧 evOld 落库（模拟过期异步回写）→ changes=0（不覆盖 evNew 的投递态）
    const rec = await I.recordSysTechLeadNotify(id, evOld, false, null, 'stale-writeback', 999);
    assert.strictEqual(rec.changes, 0, '旧 request_event_id 落库 → changes=0（拒过期回写·§6）');
    const row = await get('SELECT tech_lead_notify_status, tech_lead_notify_sent_by, tech_lead_notify_request_event_id FROM sys_issues WHERE id=?', [id]);
    // ⭐ S5：两次 request 均不自动发送，此处未曾调用过 resend，新版本投递态本应仍是 not_sent（不是"未被覆盖的
    //   sent"——它从来没被置为 sent 过）；过期回写（evOld·changes=0）同样没能写入，双重确认它保持 not_sent。
    assert.strictEqual(row.tech_lead_notify_status, 'not_sent', 'S5：新版本投递态未被过期回写覆盖（仍 not_sent，从未发送过）');
    assert.notStrictEqual(Number(row.tech_lead_notify_sent_by), 999, 'sent_by 未被过期回写(999)污染');
    assert.strictEqual(Number(row.tech_lead_notify_request_event_id), evNew, 'request_event_id 仍 evNew');
    // 对照：用当前 evNew 落库 → changes=1
    const rec2 = await I.recordSysTechLeadNotify(id, evNew, true, 'stub-tl2', null, 13);
    assert.strictEqual(rec2.changes, 1, '当前 request_event_id 落库 → changes=1');
    // HIGH-3 契约守卫：sentBy 非正整数 → 抛（不静默写违约行）
    await assert.rejects(
      () => I.recordSysTechLeadNotify(id, evNew, true, 'k', null, 0),
      /sent_by 必须为正整数/,
      'sentBy=0 → 抛契约错（§8.3 sent/failed⟹sent_by 非空）');
    ok('[S] 拒过期回写：旧 request_event_id → changes=0(不污染) / 当前 → changes=1 / sentBy 非正整数 → 抛契约错(HIGH-3)');
  }

  // ═══ [RS] resend-tech-consult（admin∨受理人∨建单人·expected_request_event_id）═══
  {
    sendBehavior = { mode: 'ok' };
    // 建单人(dev5) resend（seed created_by=5）：先 request，再 resend with 正确 expected
    let id = await createIssue('feature'); await seedIntake(id, { created_by: 5 });
    let r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, adminTok, { tech_lead_id: 7 });
    const ev = r.body.request_event_id;
    // admin resend → 200
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, { expected_request_event_id: ev });
    assert.strictEqual(r.status, 200, `admin resend 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.tech_lead_notify_status, 'sent', 'resend 成功 sent');
    // 受理人 resend → 200
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: ev });
    assert.strictEqual(r.status, 200, '受理人 resend 200');
    // 建单人(dev5) resend → 200（created_by=5）
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, devTok, { expected_request_event_id: ev });
    assert.strictEqual(r.status, 200, '建单人 resend 200');
    // 非授权(dev6·非建单人非受理人非admin) → 403
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, dev2Tok, { expected_request_event_id: ev });
    assert.strictEqual(r.status, 403, '非授权 resend 403');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND', '403 code');
    // expected 不一致 → 409 VERSION_CONFLICT
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, { expected_request_event_id: ev - 1 });
    assert.strictEqual(r.status, 409, 'expected 不一致 409');
    assert.strictEqual(r.body.code, 'TECH_CONSULT_VERSION_CONFLICT', '409 VERSION_CONFLICT');
    // 缺 expected → 400
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, {});
    assert.strictEqual(r.body.code, 'EXPECTED_REQUEST_EVENT_ID_REQUIRED', '缺 expected 400');
    // 未发起过 → 409 NO_TECH_CONSULT_TO_RESEND
    id = await createIssue('feature'); await seedIntake(id);
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, { expected_request_event_id: 999 });
    assert.strictEqual(r.status, 409, '未发起 resend 409 状态');
    assert.strictEqual(r.body.code, 'NO_TECH_CONSULT_TO_RESEND', '未发起 resend code');

    // MED-5：tech_lead 已不在白名单（脏数据/白名单变）→ 409 TECH_LEAD_NOT_WHITELISTED（不向非白名单发）
    id = await createIssue('feature'); await seedIntake(id);
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, adminTok, { tech_lead_id: 7 });
    const evW = r.body.request_event_id;
    await run(`UPDATE sys_issues SET tech_lead_id=5 WHERE id=?`, [id]);   // 篡改为非白名单 id=5
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, { expected_request_event_id: evW });
    assert.strictEqual(r.status, 409, '非白名单 resend 409 状态');
    assert.strictEqual(r.body.code, 'TECH_LEAD_NOT_WHITELISTED', 'MED-5：resend 重校 isSysTechLead·非白名单 409');

    // MED-6：失败 error 是安全码（no_phone）不含 SQLite/内部信息——S5：request 不再发送，经 resend 触发失败
    sendBehavior = { mode: 'fail' };
    id = await createIssue('feature'); await seedIntake(id);
    r = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, adminTok, { tech_lead_id: 7 });
    const rsErr = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, adminTok, { expected_request_event_id: r.body.request_event_id });
    assert.strictEqual(rsErr.status, 200, `MED-6 夹具：resend 触发失败发送仍应 200（业务层"失败"非 HTTP 错误）, got ${rsErr.status}`);
    const errRow = await get('SELECT tech_lead_notify_error FROM sys_issues WHERE id=?', [id]);
    assert.ok(['no_phone', 'no_config', 'notify_exception', 'other'].includes(errRow.tech_lead_notify_error), 'MED-6：error 是安全码集(no_phone)·不含 raw 内部信息');
    sendBehavior = { mode: 'ok' };
    ok('[RS] resend：admin/受理人/建单人 200 + 非授权 403 + expected 不一致 409 + 缺 expected 400 + 未发起 409 + MED-5 非白名单 409 + MED-6 error 安全码');
  }

  console.log(`\n✅ verify-sys-intake-schedule-c5 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
