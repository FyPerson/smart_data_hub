// 验证脚本：系统迭代 批量通知上线开发（POST /sys-issues/notify-release-executor-batch）
//   用法：node scripts/verify-sys-notify-release-batch.js
//
// 覆盖（真实 HTTP + 落库状态 + 注入可控 sendIssueDingtalkRaw stub 断言"合并一条"）：
//   [B1] 同执行人多单合并一条：3 单同 dev → sendIssueDingtalkRaw 只调 1 次 + 3 单全 sent + message_key 一致
//   [B2] 跨执行人各发一条：dev5 两单 + dev6 两单 → 2 次调用（每组一条）+ 全 sent
//   [B3] ②态闸（H-2）：sent 单 → ALREADY_NOTIFIED（不进发送）；failed 单 → 纳入发送重发
//   [B4] skipped：非 bug / 非待上线 / 未指派 release_assignee / 不存在 id → skipped
//   [B5] 执行人查不到（release_assignee_id 无 users 行）→ 组内全 failed
//   [B6] 钉钉发送失败（stub ok:false）→ 组内 failed + notify_error 落库 + read_at 清
//   [B7] concurrent_changed：发送期间（锁外）某单被并发离态 → 该单 concurrent_changed，其余 sent
//   [B8] 参数校验：空数组/超限/非法 id → 400；非 admin → 403
//   [B9] M-2 截断：25 单同执行人 → 合并 markdown 只列前 20 条 + "其余 5 条请登录平台查看"
//   [B10] 聚合计数：混合批次 results 明细 + sent/failed/skipped/already_notified/concurrent_changed 计数
//   [L-1 回归] 单条端点 notify-release-executor 对 sent 单仍可重发（批量强制②态不外溢单条）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-notify-release-batch-secret';
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

// ── 可控 sendIssueDingtalkRaw stub：记录每次调用（收件人/标题/正文）+ 可配置 ok + 发送期并发钩子 ──
let sentCalls = [];
let sendOk = true;                 // 控制 stub 返回 ok
let onSendHook = null;             // 发送期（锁外）执行的并发变更（模拟 TOCTOU）
async function sendIssueDingtalkRaw(targetUser, title, md) {
  if (onSendHook) { const h = onSendHook; onSendHook = null; await h(); }
  sentCalls.push({ userId: targetUser && targetUser.id, title, md });
  return sendOk ? { ok: true, message_key: 'mk-' + sentCalls.length } : { ok: false, reason: 'network_error' };
}

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
};
deps.sendIssueDingtalkRaw = sendIssueDingtalkRaw;   // 覆盖 stub 为可记录版
const mod = require('../routes/sys-iteration')(deps);
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
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let bb = ''; r.on('data', c => bb += c); r.on('end', () => { let j = null; try { j = bb ? JSON.parse(bb) : null; } catch (_) { j = { _raw: bb.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const EST = '2026-08-01 10:00';
async function issueRow(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }

// 建 bug 单 → 指派 devId → estimate → submit → accept → assign-release-dev(releaseDevId)，返回待上线+已指定上线开发的 id
async function seedReady(assignDev, releaseDevId, releaseDevTok) {
  const tokFor = assignDev === 6 ? dev2Tok : devTok;
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建 bug 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignDev });
  await call('POST', `/api/sys-issues/${id}/estimate`, tokFor, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, tokFor, { mode: 'no_code', no_code_reason: '修复完成（占位理由）' });
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'bug accept 200, got ' + JSON.stringify(r.body));
  if (releaseDevId) {
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: releaseDevId });
    assert.strictEqual(r.status, 200, 'assign-release-dev 200, got ' + JSON.stringify(r.body));
  }
  return id;
}
const BATCH = '/api/sys-issues/notify-release-executor-batch';

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin',NULL,NULL),(5,'dev','开发王','user','13100000005','uid5'),
    (6,'dev2','开发李','user','13100000006','uid6')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;

  // ═══ [B1] 同执行人多单合并一条 ═══
  {
    sentCalls = []; sendOk = true;
    const ids = [await seedReady(5, 5), await seedReady(5, 5), await seedReady(5, 5)];
    const r = await call('POST', BATCH, adminTok, { issue_ids: ids });
    assert.strictEqual(r.status, 200, `[B1] 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(sentCalls.length, 1, `[B1] 同执行人 3 单只发 1 条钉钉, got ${sentCalls.length}`);
    assert.strictEqual(sentCalls[0].userId, 5, '[B1] 收件人=dev5');
    assert.strictEqual(r.body.sent, 3, '[B1] sent=3');
    for (const id of ids) {
      const row = await issueRow(id);
      assert.strictEqual(row.release_assignee_notify_status, 'sent', `[B1] #${id} notify_status=sent`);
      assert.strictEqual(row.release_assignee_notify_message_key, 'mk-1', `[B1] #${id} 共享同一 message_key`);
      assert.strictEqual(row.release_assignee_read_at, null, `[B1] #${id} read_at 清空`);
    }
    ok('[B1] 同执行人 3 单合并一条钉钉 + 全 sent + 共享 message_key');
  }

  // ═══ [B2] 跨执行人各发一条 ═══
  {
    sentCalls = []; sendOk = true;
    const ids = [await seedReady(5, 5), await seedReady(5, 5), await seedReady(6, 6), await seedReady(6, 6)];
    const r = await call('POST', BATCH, adminTok, { issue_ids: ids });
    assert.strictEqual(r.status, 200, `[B2] 200`);
    assert.strictEqual(sentCalls.length, 2, `[B2] 两执行人各一条=2 次调用, got ${sentCalls.length}`);
    const recips = sentCalls.map(c => c.userId).sort();
    assert.deepStrictEqual(recips, [5, 6], '[B2] 收件人为 dev5+dev6 各一');
    assert.strictEqual(r.body.sent, 4, '[B2] sent=4');
    ok('[B2] 跨执行人分组各发一条（2 组 = 2 次调用）');
  }

  // ═══ [B3] ②态闸：sent → ALREADY_NOTIFIED；failed → 重发 ═══
  {
    sentCalls = []; sendOk = true;
    const sentId = await seedReady(5, 5);
    await run(`UPDATE sys_issues SET release_assignee_notify_status='sent', release_assignee_notify_message_key='old' WHERE id=?`, [sentId]);
    const failedId = await seedReady(5, 5);
    await run(`UPDATE sys_issues SET release_assignee_notify_status='failed', release_assignee_notify_error='prev' WHERE id=?`, [failedId]);
    const r = await call('POST', BATCH, adminTok, { issue_ids: [sentId, failedId] });
    assert.strictEqual(r.status, 200, '[B3] 200');
    const bySent = r.body.results.find(x => x.id === sentId);
    const byFailed = r.body.results.find(x => x.id === failedId);
    assert.strictEqual(bySent.code, 'ALREADY_NOTIFIED', '[B3] sent 单 → ALREADY_NOTIFIED');
    assert.strictEqual(byFailed.code, 'sent', '[B3] failed 单 → 重发成功 sent');
    assert.strictEqual(sentCalls.length, 1, '[B3] 只对 failed 单发送（sent 单不进分组）');
    const srow = await issueRow(sentId);
    assert.strictEqual(srow.release_assignee_notify_message_key, 'old', '[B3] sent 单未被批量覆盖（②态闸拦住）');
    assert.strictEqual(r.body.already_notified, 1, '[B3] already_notified=1');
    ok('[B3] ②态闸：sent→ALREADY_NOTIFIED 不覆盖 / failed→重发成功');
  }

  // ═══ [B4] skipped：非 bug / 非待上线 / 未指派 / 不存在 ═══
  {
    sentCalls = []; sendOk = true;
    // 非待上线（刚建单 待处理）
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部' });
    const pendingId = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${pendingId}/intake-accept`, adminTok, {});
    // 待上线但未指派 release_assignee
    const noAssigneeId = await seedReady(5, null);
    // 非 bug（feature）
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'f', system_name: 'BMS', source: '内部' });
    const featId = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${featId}/intake-accept`, adminTok, {});
    r = await call('POST', BATCH, adminTok, { issue_ids: [pendingId, noAssigneeId, featId, 999999] });
    assert.strictEqual(r.status, 200, '[B4] 200');
    for (const id of [pendingId, noAssigneeId, featId, 999999]) {
      assert.strictEqual(r.body.results.find(x => x.id === id).code, 'skipped', `[B4] #${id} → skipped`);
    }
    assert.strictEqual(sentCalls.length, 0, '[B4] 无合格单 → 零发送');
    assert.strictEqual(r.body.skipped, 4, '[B4] skipped=4');
    ok('[B4] skipped：非 bug/非待上线/未指派/不存在 id 全归 skipped 且零发送');
  }

  // ═══ [B5] 执行人查不到 → 组内全 failed ═══
  {
    sentCalls = []; sendOk = true;
    const id = await seedReady(5, 5);
    await run(`UPDATE sys_issues SET release_assignee_id=777, release_assignee_name='幽灵' WHERE id=?`, [id]);   // 777 无 users 行
    const r = await call('POST', BATCH, adminTok, { issue_ids: [id] });
    assert.strictEqual(r.status, 200, '[B5] 200');
    assert.strictEqual(r.body.results.find(x => x.id === id).code, 'failed', '[B5] 执行人查不到 → failed');
    assert.strictEqual(sentCalls.length, 0, '[B5] 执行人不存在时不发送');
    const row = await issueRow(id);
    assert.strictEqual(row.release_assignee_notify_status, 'failed', '[B5] 落库 failed');
    assert.strictEqual(row.release_assignee_notify_error, 'executor_not_found', '[B5] notify_error=executor_not_found');
    ok('[B5] 执行人查不到 → 组内 failed + notify_error 落库');
  }

  // ═══ [B6] 钉钉发送失败 → 组内 failed ═══
  {
    sentCalls = []; sendOk = false;
    const ids = [await seedReady(5, 5), await seedReady(5, 5)];
    // 预置已读态验证失败也清 read_at
    await run(`UPDATE sys_issues SET release_assignee_notify_status='failed', release_assignee_read_at='2026-08-01 01:00' WHERE id=?`, [ids[0]]);
    const r = await call('POST', BATCH, adminTok, { issue_ids: ids });
    assert.strictEqual(r.status, 200, '[B6] 200');
    assert.strictEqual(sentCalls.length, 1, '[B6] 合并发送一次（虽失败）');
    for (const id of ids) {
      assert.strictEqual(r.body.results.find(x => x.id === id).code, 'failed', `[B6] #${id} → failed`);
      const row = await issueRow(id);
      assert.strictEqual(row.release_assignee_notify_status, 'failed', `[B6] #${id} 落库 failed`);
      assert.strictEqual(row.release_assignee_notify_error, 'network_error', `[B6] #${id} error=network_error`);
      assert.strictEqual(row.release_assignee_notify_message_key, null, `[B6] #${id} failed 无 message_key`);
      assert.strictEqual(row.release_assignee_read_at, null, `[B6] #${id} read_at 清空`);
    }
    assert.strictEqual(r.body.failed, 2, '[B6] failed=2');
    sendOk = true;
    ok('[B6] 发送失败 → 组内 failed + error 落库 + read_at 清 + 无 message_key');
  }

  // ═══ [B7] concurrent_changed：发送期某单被并发离态 ═══
  {
    sentCalls = []; sendOk = true;
    const stableId = await seedReady(5, 5);
    const raceId = await seedReady(5, 5);
    // 发送期间（锁外、守卫 UPDATE 之前）把 raceId 改成已上线（模拟并发 execute-release）
    onSendHook = async () => { await run(`UPDATE sys_issues SET status='已上线' WHERE id=?`, [raceId]); };
    const r = await call('POST', BATCH, adminTok, { issue_ids: [stableId, raceId] });
    assert.strictEqual(r.status, 200, `[B7] 200, got ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.results.find(x => x.id === stableId).code, 'sent', '[B7] 未变单 → sent');
    const raceRes = r.body.results.find(x => x.id === raceId);
    assert.strictEqual(raceRes.code, 'concurrent_changed', '[B7] 并发离态单 → concurrent_changed');
    const raceRow = await issueRow(raceId);
    assert.strictEqual(raceRow.release_assignee_notify_status, 'not_sent', '[B7] 并发单守卫未命中 → notify_status 保持 not_sent');
    assert.strictEqual(r.body.sent, 1, '[B7] sent=1');
    assert.strictEqual(r.body.concurrent_changed, 1, '[B7] concurrent_changed=1');
    ok('[B7] concurrent_changed：发送期并发离态单守卫未命中 → 独立 code，不误标 sent');
  }

  // ═══ [B7b] concurrent_changed（改派竞态，codex L-1）：发送期某单被并发改派到别的执行人 ═══
  {
    sentCalls = []; sendOk = true;
    const stableId = await seedReady(5, 5);
    const raceId = await seedReady(5, 5);
    onSendHook = async () => { await run(`UPDATE sys_issues SET release_assignee_id=6, release_assignee_name='开发李' WHERE id=?`, [raceId]); };
    const r = await call('POST', BATCH, adminTok, { issue_ids: [stableId, raceId] });
    assert.strictEqual(r.status, 200, '[B7b] 200');
    assert.strictEqual(r.body.results.find(x => x.id === stableId).code, 'sent', '[B7b] 未变单 → sent');
    assert.strictEqual(r.body.results.find(x => x.id === raceId).code, 'concurrent_changed', '[B7b] 并发改派单 → concurrent_changed（release_assignee_id 判别）');
    ok('[B7b] concurrent_changed：发送期并发改派（release_assignee_id 变）守卫未命中 → 独立 code');
  }

  // ═══ [B7c] failed 分支判别（codex M-1）：发送失败 + 发送期改派 → concurrent_changed 非误判 failed ═══
  {
    sentCalls = []; sendOk = false;
    const stableId = await seedReady(5, 5);
    const raceId = await seedReady(5, 5);
    onSendHook = async () => { await run(`UPDATE sys_issues SET release_assignee_id=6 WHERE id=?`, [raceId]); };
    const r = await call('POST', BATCH, adminTok, { issue_ids: [stableId, raceId] });
    assert.strictEqual(r.status, 200, '[B7c] 200');
    assert.strictEqual(r.body.results.find(x => x.id === stableId).code, 'failed', '[B7c] 未变单 → failed');
    assert.strictEqual(r.body.results.find(x => x.id === raceId).code, 'concurrent_changed', '[B7c] failed 分支并发改派单 → concurrent_changed 不误判 failed');
    sendOk = true;
    ok('[B7c] failed 分支：发送期改派单守卫未命中 → concurrent_changed（非误判 failed，codex M-1 佐证）');
  }

  // ═══ [B7d] 写侧 type='bug' 守卫（codex H-1）：发送期该单 type 被改成非 bug → 守卫不命中 concurrent_changed ═══
  {
    sentCalls = []; sendOk = true;
    const stableId = await seedReady(5, 5);
    const raceId = await seedReady(5, 5);
    // 直接改库模拟"假如未来有 type 编辑路径"（当前无端点改 sys_issues.type，守卫 type='bug' 是写读同源防御）
    onSendHook = async () => { await run(`UPDATE sys_issues SET type='feature' WHERE id=?`, [raceId]); };
    const r = await call('POST', BATCH, adminTok, { issue_ids: [stableId, raceId] });
    assert.strictEqual(r.status, 200, '[B7d] 200');
    assert.strictEqual(r.body.results.find(x => x.id === stableId).code, 'sent', '[B7d] 未变单 → sent');
    assert.strictEqual(r.body.results.find(x => x.id === raceId).code, 'concurrent_changed', '[B7d] 发送期变非 bug 单 → 守卫 type=bug 不命中 → concurrent_changed');
    const raceRow = await issueRow(raceId);
    assert.strictEqual(raceRow.release_assignee_notify_status, 'not_sent', '[B7d] 变非 bug 单未被写 sent（type 守卫拦住）');
    ok('[B7d] 写侧 type=bug 守卫：发送期变非 bug 单守卫不命中 → 不误写 sent（codex H-1 同源加固）');
  }

  // ═══ [B8] 参数校验 + 权限 ═══
  {
    let r = await call('POST', BATCH, adminTok, { issue_ids: [] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'ISSUE_IDS_REQUIRED');
    r = await call('POST', BATCH, adminTok, { issue_ids: Array.from({ length: 201 }, (_, i) => i + 1) });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'TOO_MANY_ISSUES');
    r = await call('POST', BATCH, adminTok, { issue_ids: [0] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_ISSUE_ID');
    r = await call('POST', BATCH, devTok, { issue_ids: [1] });
    assert.strictEqual(r.status, 403, '[B8] 非 admin → 403');
    ok('[B8] 参数校验（空/超限/非法 id → 400）+ 非 admin → 403');
  }

  // ═══ [B9] M-2 截断：25 单同执行人 → markdown 列前 20 + 其余 5 ═══
  {
    sentCalls = []; sendOk = true;
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push(await seedReady(5, 5));
    const r = await call('POST', BATCH, adminTok, { issue_ids: ids });
    assert.strictEqual(r.status, 200, '[B9] 200');
    assert.strictEqual(sentCalls.length, 1, '[B9] 25 单同执行人合并一条');
    const md = sentCalls[0].md;
    const lineCount = (md.match(/^- #\d+/gm) || []).length;
    assert.strictEqual(lineCount, 20, `[B9] 正文只列 20 条明细, got ${lineCount}`);
    assert.ok(/其余 5 条请登录平台查看/.test(md), '[B9] 溢出提示"其余 5 条"');
    assert.strictEqual(r.body.sent, 25, '[B9] 25 单全 sent（截断只影响展示不影响落库）');
    ok('[B9] M-2 合并 markdown 截断前 20 条 + "其余 5 条"提示，落库不受影响');
  }

  // ═══ [B10] 聚合计数（混合批次）═══
  {
    sentCalls = []; sendOk = true;
    const s1 = await seedReady(5, 5);                         // sent
    const already = await seedReady(5, 5);
    await run(`UPDATE sys_issues SET release_assignee_notify_status='sent' WHERE id=?`, [already]);   // ALREADY_NOTIFIED
    const skip = await seedReady(5, null);                    // skipped（未指派）
    const r = await call('POST', BATCH, adminTok, { issue_ids: [s1, already, skip] });
    assert.strictEqual(r.status, 200, '[B10] 200');
    assert.strictEqual(r.body.sent, 1, '[B10] sent=1');
    assert.strictEqual(r.body.already_notified, 1, '[B10] already_notified=1');
    assert.strictEqual(r.body.skipped, 1, '[B10] skipped=1');
    assert.strictEqual(r.body.results.length, 3, '[B10] results 覆盖全部入参 3 单');
    ok('[B10] 聚合计数 sent/already_notified/skipped + results 明细完整');
  }

  // ═══ [L-1 回归] 单条端点对 sent 单仍可重发（批量②态闸不外溢单条）═══
  {
    sentCalls = []; sendOk = true;
    const id = await seedReady(5, 5);
    await run(`UPDATE sys_issues SET release_assignee_notify_status='sent', release_assignee_notify_message_key='k1' WHERE id=?`, [id]);
    const r = await call('POST', `/api/sys-issues/${id}/notify-release-executor`, adminTok, {});
    assert.strictEqual(r.status, 200, `[L-1] 单条端点对 sent 单重发应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.release_assignee_notify_status, 'sent', '[L-1] 单条重发后仍 sent');
    assert.strictEqual(sentCalls.length, 1, '[L-1] 单条端点确实又发了一次（sent 单重发有意保留）');
    ok('[L-1 回归] 单条 notify-release-executor 对 sent 单仍可重发（批量②态闸不外溢单条）');
  }

  // ═══ [B11] 集成闭环（末次合并审 L-1）：用列表读口径断言 assign→②→batch→③→reassign→② 跨 commit 写读同源 ═══
  {
    sentCalls = []; sendOk = true;
    const id = await seedReady(5, 5);   // seedReady 内已 assign-release-dev(5)
    // 用真实列表端点（GET /sys-issues·Commit 1 SELECT 补 release_assignee_notify_status）读口径
    const listNotify = async (iid) => {
      const r = await call('GET', '/api/sys-issues?status=' + encodeURIComponent('待上线'), adminTok);
      const row = ((r.body && r.body.items) || []).find(x => x.id === iid);
      return row ? row.release_assignee_notify_status : '__missing__';
    };
    assert.strictEqual(await listNotify(id), 'not_sent', '[B11] 指定后列表读②(not_sent)');
    await call('POST', BATCH, adminTok, { issue_ids: [id] });
    assert.strictEqual(await listNotify(id), 'sent', '[B11] 批量通知后列表读③(sent)');
    const rr = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: 6 });
    assert.strictEqual(rr.status, 200, '[B11] 换人 200');
    assert.strictEqual(await listNotify(id), 'not_sent', '[B11] 换人后列表读重置②(not_sent)（Commit 0 清 5 列 → Commit 1 列表读 → 前端三态回②）');
    ok('[B11] 集成闭环：列表读口径 assign→not_sent(②) → batch→sent(③) → reassign→not_sent(②) 跨 commit 写读同源');
  }

  console.log(`\n✅ verify-sys-notify-release-batch 全部通过（${passed} 项断言）`);
  server.close();
  db.close();
}
main().catch(e => { console.error('❌ 验证失败:', e && e.stack || e); process.exitCode = 1; try { server && server.close(); } catch (_) {} });
