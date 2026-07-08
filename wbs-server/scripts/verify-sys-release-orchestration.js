// 验证脚本：系统迭代 bug 流上线编排（通知改造 v1.6 §2.3，C3b G3-G6）
//   用法：node scripts/verify-sys-release-orchestration.js
//
// 覆盖（真实 HTTP + 落库状态）：
//   [G3] assign-release-dev：批量指定上线开发——成功批量写入 + timeline + 同人幂等重提成功 +
//        非 bug/非待上线/已挂批次/已指定他人 各类 409 + viewer/不存在 dev 400 + 批量原子性（一条失败整批不落库）+
//        权限（非 admin 403）+ 参数校验（空数组/超限/非法 id/缺 release_assignee_id）
//   [G4] reassign-release-dev：批量换人——成功换人 + timeline 记新旧 + 未指定人须先 assign（409）+
//        已挂批次不可换（409）+ 权限 403
//   [G5] execute-release(mode=hotfix)：仅被指定开发本人可执行（H-1，admin 无隐式执行权）+ 单条限定
//        （HOTFIX_SINGLE_ONLY）+ 成功后 release_id/version_tag 均 NULL（H-2，不建批次）+ 并发/重复执行 409
//   [G6] execute-release(mode=publish)：请求级前置全批一致性（RELEASE_BATCH_ASSIGNEE_MISMATCH：状态不齐/
//        assignee 不同/未指定/非 bug）+ 成功后单事务建批次(release_type=bug)+批次持执行人(created_by=actor)+
//        全部转已上线 + 复用 _publishReleaseCoreInTxn 核心（release timeline ref_id=批次）
//   [H-1] 越权矩阵：admin 无隐式执行权（除非 admin 恰被指定）/ 非指定开发（含协作者）不可执行
//   [M-1] assign vs reassign 边界：assign 仅"未指定"或"同人幂等"；改人须走 reassign
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-orchestration-secret';
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
const dev3Tok = jwt.sign({ id: 8, username: 'dev3', display_name: '开发赵', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 7, username: 'viewer1', display_name: '观察员', role: 'viewer' }, SECRET);   // id7 ∈ bug 对接人白名单[7,13]（M-1 正向覆盖）

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const EST = '2026-08-01 10:00';

async function issueRow(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }
async function relRow(id) { return await get('SELECT * FROM sys_releases WHERE id=?', [id]); }

// 建 bug 单 → 指派 devId → estimate → submit → accept，返回 id（待上线态）
async function seedBugToReady(devId = 5, devTokFor = devTok) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建 bug 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200');
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTokFor, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200, 'bug estimate 200, got ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTokFor, { summary: '修复完成' });
  assert.strictEqual(r.status, 200, 'bug submit 200, got ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'bug accept 200, got ' + JSON.stringify(r.body));
  return id;
}
async function seedFeatureToReady(devId = 5, devTokFor = devTok) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'feat单', system_name: 'BMS', source: '内部' });
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  await call('POST', `/api/sys-issues/${id}/estimate`, devTokFor, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, devTokFor, { summary: '交付' });
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'feature accept 200');
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),
    (7,'viewer1','观察员','viewer'),(8,'dev3','开发赵','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [G3] assign-release-dev 成功路径 + timeline ═══
  {
    const id1 = await seedBugToReady(5);
    const id2 = await seedBugToReady(5);
    let r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id1, id2], release_assignee_id: 5 });
    assert.strictEqual(r.status, 200, `[G3] 批量指定 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 2, '[G3] count=2');
    const row1 = await issueRow(id1);
    assert.strictEqual(row1.release_assignee_id, 5, '[G3] id1 release_assignee_id=5');
    assert.strictEqual(row1.release_assignee_name, '开发王', '[G3] id1 release_assignee_name 服务端重算');
    const tl = await get(`SELECT event_type, action_code, summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='assign_release_dev'`, [id1]);
    assert.ok(tl && tl.event_type === 'note', '[G3] timeline event_type=note');
    assert.ok(/开发王/.test(tl.summary), '[G3] timeline summary 含开发姓名');
    ok('[G3] assign-release-dev 批量成功：release_assignee_id/_name 服务端重算 + timeline(note/assign_release_dev) 记录');

    // 同人幂等重提 → 200（M-1：仅允许未指定或同人幂等重提）
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id1], release_assignee_id: 5 });
    assert.strictEqual(r.status, 200, '[G3] 同人幂等重提 200');
    ok('[G3] 同人幂等重提成功（M-1 边界①）');
  }

  // ═══ [C-orch 写读同源·codex41 HIGH#1+MED#2] release_assignee 可见性 + 列表返 release_assignee 列 ═══
  {
    // bug 指派给 dev5（assigned_to），上线执行人指给 dev8（既非 admin/assigned_to/白名单对接人[7,13]）——
    //   写端 execute-release 授权 dev8，读端（列表+详情）必须镜像，否则 dev8 够不到「执行上线」（[[feedback_write_read_same_semantic]]）。
    const visId = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [visId], release_assignee_id: 8 });

    // MED#2：列表 SELECT 返 release_assignee_id/_name 两列（批量面板依赖，原 SELECT 漏列）
    let r = await call('GET', '/api/sys-issues?status=' + encodeURIComponent('待上线'), adminTok);
    assert.strictEqual(r.status, 200, '[C-orch] admin 列表 200');
    const visItem = (r.body.items || []).find(i => i.id === visId);
    assert.ok(visItem, '[C-orch] admin 列表含该单');
    assert.strictEqual(visItem.release_assignee_id, 8, '[C-orch·MED2] 列表返 release_assignee_id');
    assert.strictEqual(visItem.release_assignee_name, '开发赵', '[C-orch·MED2] 列表返 release_assignee_name（服务端反规范化）');

    // HIGH#1 列表读端：dev8（release_assignee，非 admin/assigned_to/白名单）可在列表看到本单
    r = await call('GET', '/api/sys-issues?status=' + encodeURIComponent('待上线'), dev3Tok);
    assert.strictEqual(r.status, 200, '[C-orch] dev8 列表 200');
    assert.ok((r.body.items || []).some(i => i.id === visId), '[C-orch·HIGH1] release_assignee 可在列表看到本单');

    // HIGH#1 详情读端：dev8 可见详情（非 403）
    r = await call('GET', '/api/sys-issues/' + visId, dev3Tok);
    assert.strictEqual(r.status, 200, '[C-orch·HIGH1] release_assignee 详情 200（非 403）');
    assert.strictEqual(r.body.issue.release_assignee_id, 8, '[C-orch] 详情 release_assignee_id=8');

    // 负向（不越放）：无关 dev6（非 assigned_to/非 release_assignee/非白名单）列表看不到 + 详情 403
    r = await call('GET', '/api/sys-issues?status=' + encodeURIComponent('待上线'), dev2Tok);
    assert.ok(!(r.body.items || []).some(i => i.id === visId), '[C-orch] 无关 dev6 列表看不到本单');
    r = await call('GET', '/api/sys-issues/' + visId, dev2Tok);
    assert.strictEqual(r.status, 403, '[C-orch] 无关 dev6 详情 403（可见性不越放）');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_TO_VIEW', '[C-orch] 403 code=NOT_AUTHORIZED_TO_VIEW');

    // 端到端：可见性打通后 dev8 确能执行上线（hotfix）
    r = await call('POST', '/api/sys-issues/execute-release', dev3Tok, { mode: 'hotfix', issue_ids: [visId] });
    assert.strictEqual(r.status, 200, '[C-orch] release_assignee dev8 可执行 hotfix 上线');
    ok('[C-orch·codex41 HIGH1+MED2] release_assignee 列表/详情可见性打通 + 列表返 release_assignee 两列 + 无关 dev 仍 403 + dev8 端到端执行上线');
  }

  // ═══ [G3] assign-release-dev 各类拒绝 ═══
  {
    // 非 bug 类型
    const featId = await seedFeatureToReady(5);
    let r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [featId], release_assignee_id: 5 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGN_TYPE_INVALID');
    ok('[G3] 非 bug 单 → 409 RELEASE_ASSIGN_TYPE_INVALID');

    // 非待上线态
    let rr = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'mid', system_name: 'BMS', source: '内部' });
    const midId = rr.body.id;
    await call('POST', `/api/sys-issues/${midId}/assign`, adminTok, { assigned_to: 5 });   // 处理中
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [midId], release_assignee_id: 5 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGN_STATUS_INVALID');
    ok('[G3] 处理中态（非待上线）→ 409 RELEASE_ASSIGN_STATUS_INVALID');

    // viewer 不能被指定
    const readyForViewer = await seedBugToReady(5);
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [readyForViewer], release_assignee_id: 7 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_VIEWER');
    ok('[G3] 指定 viewer → 400 RELEASE_ASSIGNEE_VIEWER');

    // 不存在的用户
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [readyForViewer], release_assignee_id: 999 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_NOT_FOUND');
    ok('[G3] 指定不存在用户 → 400 RELEASE_ASSIGNEE_NOT_FOUND');

    // 已指定他人 → 须走 reassign
    const alreadySet = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [alreadySet], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [alreadySet], release_assignee_id: 6 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_ALREADY_SET');
    ok('[G3] 已指定他人再 assign（非同人）→ 409 RELEASE_ASSIGNEE_ALREADY_SET（M-1 边界②，须走 reassign）');

    // 已挂批次
    const inRelease = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [inRelease], release_assignee_id: 5 });
    await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [inRelease] });   // 已上线（release_id 仍 NULL，H-2）
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [inRelease], release_assignee_id: 5 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGN_STATUS_INVALID', '[G3] 已上线（非待上线）→ 409 RELEASE_ASSIGN_STATUS_INVALID');
    ok('[G3] 已执行上线（非待上线态）单再次 assign → 409 RELEASE_ASSIGN_STATUS_INVALID');

    // 批量原子性：混入一个非法单 → 整批不落库
    const goodA = await seedBugToReady(5);
    const goodB = await seedBugToReady(5);
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [goodA, goodB, midId], release_assignee_id: 5 });
    assert.strictEqual(r.status, 409, '[G3] 混入非法单应整批 409');
    const rowGoodA = await issueRow(goodA);
    assert.strictEqual(rowGoodA.release_assignee_id, null, '[G3] 批量原子性：合法单 goodA 未被误写（整批回滚）');
    ok('[G3] 批量资格校验先行（H-4）：混入非法单整批 409，合法单也不落库（无部分成功）');

    // 参数校验
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [], release_assignee_id: 5 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'ISSUE_IDS_REQUIRED');
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [goodA] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_REQUIRED');
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [-1], release_assignee_id: 5 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_ISSUE_ID');
    const bigIds = Array.from({ length: 201 }, (_, k) => k + 1);
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: bigIds, release_assignee_id: 5 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'TOO_MANY_ISSUES');
    ok('[G3] 参数校验：空数组/缺 release_assignee_id/非法 id/超 200 条均 400');

    // 权限
    r = await call('POST', '/api/sys-issues/assign-release-dev', devTok, { issue_ids: [goodA], release_assignee_id: 5 });
    assert.strictEqual(r.status, 403, '[G3] 非 admin → 403');
    ok('[G3] 权限：非 admin → 403');
  }

  // ═══ [G4] reassign-release-dev ═══
  {
    const id = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: 5 });
    let r = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: 6 });
    assert.strictEqual(r.status, 200, `[G4] 换人 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.release_assignee_id, 6, '[G4] release_assignee_id 换成新人');
    assert.strictEqual(row.release_assignee_name, '开发李', '[G4] release_assignee_name 服务端重算为新人姓名');
    const tl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='reassign_release_dev'`, [id]);
    assert.ok(tl && /开发王/.test(tl.summary) && /开发李/.test(tl.summary), '[G4] timeline summary 含新旧姓名');
    ok('[G4] reassign-release-dev 成功换人：release_assignee_id/_name 更新 + timeline 记新旧姓名');

    // 换人后旧指定人不再可执行，新指定人可执行
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 403, '[G4] 换人后旧指定人（dev5）不可执行');
    r = await call('POST', '/api/sys-issues/execute-release', dev2Tok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 200, '[G4] 换人后新指定人（dev6）可执行');
    ok('[G4] 换人生效体现在 execute-release 授权判定（旧人失权/新人获权）');

    // 【批量通知 Commit 0 · H-1 同人守卫 + 整批原子性】（codex Commit0 审 M-1 整批不落库 + L-1 拒绝不清零，合并覆盖）
    //   混合批次：一条同人（release_assignee=5，换人目标也是 5）+ 一条非同人（release_assignee=6，本可成功换到 5），
    //   两条均预置非默认通知态（sent+已读+message_key）。一次调用换人到 5 → 同人那条命中守卫 → 整批 409：
    //   ① 非同人那条 assignee 不被改（整批不落库）② 两条 notify 5 列全保持 sent 态（拒绝路径不清零）③ 两条都不写 timeline。
    {
      const sameId = await seedBugToReady(5);
      const otherId = await seedBugToReady(5);
      await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [sameId], release_assignee_id: 5 });
      await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [otherId], release_assignee_id: 6 });
      for (const iid of [sameId, otherId]) {
        await run(`UPDATE sys_issues SET release_assignee_notify_status='sent', release_assignee_notified_at='2026-08-01 08:00',
                     release_assignee_notify_message_key='mk-keep', release_assignee_notify_error=NULL,
                     release_assignee_read_at='2026-08-01 08:30' WHERE id=?`, [iid]);
      }
      const r2 = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [sameId, otherId], release_assignee_id: 5 });
      assert.strictEqual(r2.status, 409, `[G4][C0·H-1] 混合批次含同人应整批 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.code, 'RELEASE_ASSIGNEE_UNCHANGED', '[G4][C0·H-1] code=RELEASE_ASSIGNEE_UNCHANGED');
      assert.strictEqual(r2.body.issue_id, sameId, '[G4][C0·H-1] 409 指向命中同人那条');
      const other = await issueRow(otherId);
      assert.strictEqual(other.release_assignee_id, 6, '[G4][C0·H-1·M-1] 整批 409：非同人那条 assignee 未被改（整批不落库）');
      for (const iid of [sameId, otherId]) {
        const row = await issueRow(iid);
        assert.strictEqual(row.release_assignee_notify_status, 'sent', `[G4][C0·H-1·L-1] #${iid} notify_status 未被清零`);
        assert.strictEqual(row.release_assignee_notified_at, '2026-08-01 08:00', `[G4][C0·H-1·L-1] #${iid} notified_at 未被清零`);
        assert.strictEqual(row.release_assignee_notify_message_key, 'mk-keep', `[G4][C0·H-1·L-1] #${iid} message_key 未被清零`);
        assert.strictEqual(row.release_assignee_read_at, '2026-08-01 08:30', `[G4][C0·H-1·L-1] #${iid} read_at 未被清零`);
      }
      const tlc = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id IN (?,?) AND action_code='reassign_release_dev'`, [sameId, otherId]);
      assert.strictEqual(tlc.c, 0, '[G4][C0·H-1] 同人守卫整批拒绝后两条都不写 reassign timeline');
      ok('[G4][C0·H-1+M-1+L-1] 混合批次含同人 → 整批 409 不落库 + 5 列不清零 + 不写 timeline（整批原子性）');
    }

    // 【批量通知 Commit 0 · C-1】换人原子重置 release_assignee_notify_* 5 列（防新人沿用旧人 sent/已读态）
    {
      const nid = await seedBugToReady(5);
      await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [nid], release_assignee_id: 5 });
      // 模拟旧执行人 dev5 已被通知（sent + message_key + 已读）
      await run(`UPDATE sys_issues SET release_assignee_notify_status='sent', release_assignee_notified_at='2026-08-01 09:00',
                   release_assignee_notify_message_key='mk-old', release_assignee_notify_error=NULL,
                   release_assignee_read_at='2026-08-01 09:30' WHERE id=?`, [nid]);
      const r3 = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [nid], release_assignee_id: 6 });
      assert.strictEqual(r3.status, 200, `[G4][C0·C-1] 换人应 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
      const row2 = await issueRow(nid);
      assert.strictEqual(row2.release_assignee_id, 6, '[G4][C0·C-1] 换成新人 dev6');
      assert.strictEqual(row2.release_assignee_notify_status, 'not_sent', '[G4][C0·C-1] notify_status 重置 not_sent');
      assert.strictEqual(row2.release_assignee_notified_at, null, '[G4][C0·C-1] notified_at 清空');
      assert.strictEqual(row2.release_assignee_notify_message_key, null, '[G4][C0·C-1] message_key 清空');
      assert.strictEqual(row2.release_assignee_notify_error, null, '[G4][C0·C-1] notify_error 清空');
      assert.strictEqual(row2.release_assignee_read_at, null, '[G4][C0·C-1] read_at 清空');
      ok('[G4][C0·C-1] 换人原子重置 release_assignee_notify_* 5 列（新人通知态归零）');
    }

    // 未指定人（none）→ 须走 assign-release-dev，非 reassign
    const noneId = await seedBugToReady(5);
    r = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [noneId], release_assignee_id: 5 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_NOT_SET');
    ok('[G4] 未指定人的单走 reassign → 409 RELEASE_ASSIGNEE_NOT_SET（须先 assign-release-dev）');

    // 已挂批次（已上线）不可换
    const doneId = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [doneId], release_assignee_id: 5 });
    await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [doneId] });
    r = await call('POST', '/api/sys-issues/reassign-release-dev', adminTok, { issue_ids: [doneId], release_assignee_id: 6 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGN_STATUS_INVALID');
    ok('[G4] 已执行上线（非待上线）不可换人 → 409 RELEASE_ASSIGN_STATUS_INVALID');

    // 权限
    r = await call('POST', '/api/sys-issues/reassign-release-dev', devTok, { issue_ids: [noneId], release_assignee_id: 5 });
    assert.strictEqual(r.status, 403, '[G4] 非 admin → 403');
    ok('[G4] 权限：非 admin → 403');
  }

  // ═══ [G5] execute-release(mode=hotfix)：H-1 越权矩阵 + H-2 不建批次 ═══
  {
    const id = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: 5 });

    // H-1：admin 无隐式执行权（未被指定）
    let r = await call('POST', '/api/sys-issues/execute-release', adminTok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 403, `[G5][H-1] admin 无隐式执行权应 403, got ${r.status}`);
    assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_GUARD_FAILED');
    // 非指定的其他开发也不可执行
    r = await call('POST', '/api/sys-issues/execute-release', dev2Tok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 403, '[G5][H-1] 非指定开发不可执行');
    assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_GUARD_FAILED');
    ok('[G5][H-1] 越权矩阵：admin 无隐式执行权 + 非指定开发均 403 RELEASE_ASSIGNEE_GUARD_FAILED');

    // 被指定人本人执行成功
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 200, `[G5] 指定人执行 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.status, '已上线');
    assert.strictEqual(row.release_id, null, '[G5][H-2] hotfix 不建批次，release_id 保持 NULL');
    assert.ok(row.released_at, '[G5] released_at 落');
    assert.strictEqual(row.release_assignee_id, 5, '[G5] release_assignee_id 已上线后保留为历史快照（不清空）');
    const tl = await get(`SELECT event_type, from_status, to_status, action_code FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [id]);
    assert.ok(tl && tl.action_code === 'execute_release_hotfix', '[G5] timeline action_code=execute_release_hotfix');
    assert.strictEqual(tl.from_status, '待上线'); assert.strictEqual(tl.to_status, '已上线');
    ok('[G5] execute-release(hotfix) 成功：release_id 保持 NULL（不建批次）+ release_assignee_id 保留历史快照 + timeline 正确');

    // 重复执行（已上线）→ 409
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_EXECUTABLE');
    ok('[G5] 重复执行已上线单 → 409 ISSUE_NOT_EXECUTABLE');

    // hotfix 不支持多单
    const id2a = await seedBugToReady(5);
    const id2b = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id2a, id2b], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [id2a, id2b] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'HOTFIX_SINGLE_ONLY');
    ok('[G5] hotfix 模式多单 → 400 HOTFIX_SINGLE_ONLY');

    // 未指定任何人 → 403（release_assignee_id 为 NULL，任何人都不匹配）
    const noAssign = await seedBugToReady(5);
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [noAssign] });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'RELEASE_ASSIGNEE_GUARD_FAILED');
    ok('[G5] 未经 assign-release-dev 指定的单 → execute-release 一律 403（release_assignee_id NULL 不匹配任何 actor）');

    // 非 bug 类型
    const featReady = await seedFeatureToReady(5);
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [featReady] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_ASSIGN_TYPE_INVALID');
    ok('[G5] 非 bug 单 execute-release → 409 RELEASE_ASSIGN_TYPE_INVALID（变更流走 legacy hotfix-publish，未受影响）');

    // mode 非法
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'bogus', issue_ids: [1] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_RELEASE_MODE');
    ok('[G5] mode 非法值 → 400 INVALID_RELEASE_MODE');
  }

  // ═══ [G6] execute-release(mode=publish)：请求级前置一致性 + 单事务建批次 ═══
  {
    // 成功路径：3 单同指定 dev(5)，全部转已上线 + 建批次
    const p1 = await seedBugToReady(5);
    const p2 = await seedBugToReady(5);
    const p3 = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [p1, p2, p3], release_assignee_id: 5 });
    let r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [p1, p2, p3], release_note: '批量上线', version_tag: 'v3.0.0' });
    assert.strictEqual(r.status, 201, `[G6] 批量发布 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 3, '[G6] count=3');
    for (const iid of [p1, p2, p3]) {
      const row = await issueRow(iid);
      assert.strictEqual(row.status, '已上线', `[G6] #${iid} 已上线`);
      assert.ok(row.release_id, `[G6] #${iid} release_id 非空`);
      assert.strictEqual(row.release_id, r.body.release_id, `[G6] #${iid} release_id 一致（同批）`);
    }
    const rel = await relRow(r.body.release_id);
    assert.strictEqual(rel.release_type, 'bug', '[G6] 批次 release_type=bug');
    assert.strictEqual(rel.status, '已发布', '[G6] 批次已发布');
    assert.strictEqual(rel.version_tag, 'v3.0.0', '[G6] 批次 version_tag 落库');
    assert.strictEqual(rel.is_hotfix, 0, '[G6] publish 非 hotfix 批次');
    // H-3：批次持执行人——created_by 复用为执行人字段（非建单人 admin）
    assert.strictEqual(rel.created_by, 5, '[G6][H-3] 批次 created_by=执行人（dev5，非 admin，"批次持执行人"语义）');
    assert.strictEqual(rel.created_by_name, '开发王', '[G6] created_by_name 服务端重算');
    // 复用 _publishReleaseCoreInTxn 核心留下的 release timeline（ref_id=批次）
    const tl = await get(`SELECT ref_id, summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [p1]);
    assert.strictEqual(tl.ref_id, r.body.release_id, '[G6] release timeline ref_id=批次 id（内核复用生效）');
    assert.strictEqual(tl.summary, '批量上线', '[G6] release timeline summary=上线说明');
    ok('[G6] execute-release(publish) 批量成功：单事务建批次(release_type=bug/created_by=执行人)+全部转已上线+复用内核写 release timeline');

    // 请求级前置：assignee 不一致 → 整批拒绝
    const mA = await seedBugToReady(5);
    const mB = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [mA], release_assignee_id: 5 });
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [mB], release_assignee_id: 6 });
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [mA, mB], release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_BATCH_ASSIGNEE_MISMATCH');
    assert.strictEqual(await (await issueRow(mA)).status, '待上线', '[G6] 前置失败后 mA 仍待上线（整批回滚，未部分成功）');
    ok('[G6] 请求级前置：批次内 assignee 不一致 → 409 RELEASE_BATCH_ASSIGNEE_MISMATCH（整批拒绝，无部分成功）');

    // 未全部指定（部分单无 release_assignee_id）→ 拒绝
    const uA = await seedBugToReady(5);
    const uB = await seedBugToReady(5);   // 未 assign-release-dev
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [uA], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [uA, uB], release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_BATCH_ASSIGNEE_MISMATCH');
    ok('[G6] 批次内含未指定执行人的单 → 409 RELEASE_BATCH_ASSIGNEE_MISMATCH');

    // 非指定人尝试执行整批（即便批次内部一致，但都不是 actor 本人）→ 拒绝
    const nA = await seedBugToReady(5);
    const nB = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [nA, nB], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/execute-release', dev2Tok, { mode: 'publish', issue_ids: [nA, nB], release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_BATCH_ASSIGNEE_MISMATCH');
    r = await call('POST', '/api/sys-issues/execute-release', adminTok, { mode: 'publish', issue_ids: [nA, nB], release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409, '[G6][H-1] admin 无隐式执行权（批次一致但非 admin 本人）→ 409');
    assert.strictEqual(r.body.code, 'RELEASE_BATCH_ASSIGNEE_MISMATCH');
    ok('[G6][H-1] 批次内部一致但 actor 非指定人（含 admin）→ 409 RELEASE_BATCH_ASSIGNEE_MISMATCH（无隐式执行权）');

    // 非 bug 类型混入 → 拒绝
    const mixFeat = await seedFeatureToReady(5);
    const mixBug = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [mixBug], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [mixBug, mixFeat], release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_BATCH_ASSIGNEE_MISMATCH');
    ok('[G6] 混入非 bug 单 → 409 RELEASE_BATCH_ASSIGNEE_MISMATCH（type 校验纳入前置一致性判断）');

    // 缺 release_note/version_tag
    const noteId = await seedBugToReady(5);
    await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [noteId], release_assignee_id: 5 });
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [noteId] });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [noteId], release_note: 'x' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'VERSION_TAG_REQUIRED');
    ok('[G6] 缺 release_note/version_tag → 400');
  }

  // ═══ [正交] release_assignee 与 dev_assignees 子表相互独立 ═══
  {
    // 建单 path A 带协作，指派 dev5 主 + dev6 协作；上线编排仍以 release_assignee_id 独立决定（可指定协作者 dev6 执行）
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'collab-release', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5, collaborator_ids: [6] });
    const id = r.body.id;
    assert.strictEqual(r.status, 201, '建单 path A 带协作 201');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id}/submit`, devTok, { summary: '修复' });
    await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    // 建单人指定协作开发（dev6，非主开发）为上线执行人——上线编排与开发指派体系正交，允许
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [id], release_assignee_id: 6 });
    assert.strictEqual(r.status, 200, '[正交] 指定协作开发(dev6)为上线执行人 200（release_assignee 独立于 dev_assignees）');
    r = await call('POST', '/api/sys-issues/execute-release', dev2Tok, { mode: 'hotfix', issue_ids: [id] });
    assert.strictEqual(r.status, 200, '[正交] 协作开发本人执行 hotfix 200');
    ok('[正交] release_assignee_id 独立于 dev_assignees 子表：可指定协作开发（非主开发）为上线执行人并由其本人执行');
  }

  // ═══ [H-1 收口·codex40] 纯 bug + release_type=NULL 的脏/历史批次走 legacy /publish → LEGACY（不绕 release_assignee 执行权）═══
  //   codex40 HIGH：R4 端点只查存量 release_type='bug' 会漏"release_type IS NULL 但成员全 bug"的脏批次，
  //   直发即复活旧 admin 发布入口绕过执行权。收口=publishReleaseTransition 按成员实际族别拦 bug。
  {
    const relDirty = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const bugForDirty = await seedBugToReady(5);
    await run('UPDATE sys_issues SET release_id=? WHERE id=?', [relDirty, bugForDirty]);   // 绕过 add-issues（已拦 bug）强塞，release_type 保持 NULL
    const relRec = await relRow(relDirty);
    assert.strictEqual(relRec.release_type, null, 'H-1 构造：批次 release_type 为 NULL（非 bug 字面量，端点早拦挡不住）');
    let r = await call('POST', `/api/sys-releases/${relDirty}/publish`, adminTok, { release_note: '纯bug脏批次', version_tag: 'vdirty' });
    assert.strictEqual(r.status, 409, `H-1：纯 bug NULL 批次 /publish 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', 'H-1：纯 bug NULL 批次 /publish → LEGACY（publishReleaseTransition 按成员实际族别拦，非只看 release_type 字面量）');
    assert.strictEqual((await issueRow(bugForDirty)).status, '待上线', 'H-1：拒后 bug 单未被翻已上线（原子回滚）');
    ok('H-1（收口）：纯 bug 成员 + release_type=NULL 的历史/脏批次走 legacy /publish → 409 LEGACY_RELEASE_FLOW_DISABLED（堵绕 release_assignee 执行权直发；R5g-b 混族别变体同拒，见 verify-sys-bug-transitions.js）');
  }

  // ═══ [M-1 收口·codex40] read-status 权限：非 admin/非白名单[7,13]/非本单主开发 → 403；主开发本人 + admin 放行 ═══
  {
    const rsIssue = await seedBugToReady(5);   // 主开发 = dev5
    // dev6（id6·非 admin·非白名单·非本单主开发）查已读 → 403
    let r = await call('GET', `/api/sys-issues/${rsIssue}/notify-read-status?type=creator`, dev2Tok);
    assert.strictEqual(r.status, 403, `M-1：非授权用户查已读应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_NOTIFY', 'M-1：403 code=NOT_AUTHORIZED_FOR_NOTIFY');
    // 主开发本人（dev5）→ 非 403（未发过则 NOTIFY_NOT_SENT，关键=通过权限闸，写读同源不误挡能发者）
    r = await call('GET', `/api/sys-issues/${rsIssue}/notify-read-status?type=creator`, devTok);
    assert.notStrictEqual(r.status, 403, `M-1：主开发本人查已读不应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    // admin → 非 403
    r = await call('GET', `/api/sys-issues/${rsIssue}/notify-read-status?type=creator`, adminTok);
    assert.notStrictEqual(r.status, 403, `M-1：admin 查已读不应 403, got ${r.status}`);
    // 白名单对接人（id7 ∈ [7,13]）→ 非 403（正向覆盖 codex41 note）
    r = await call('GET', `/api/sys-issues/${rsIssue}/notify-read-status?type=creator`, liaisonTok);
    assert.notStrictEqual(r.status, 403, `M-1：白名单对接人查已读不应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('M-1（权限收口）：read-status 非 admin/非白名单/非主开发 → 403 NOT_AUTHORIZED_FOR_NOTIFY；主开发本人 + admin + 白名单对接人均放行（in-handler 检查与发送侧权限并集对称，不误挡能发者）');
  }

  // ═══ [U-2 收口·ultracode] execute-release 角色下限：指派后被降级 viewer/禁用者不能执行上线（守 viewer-never-write）═══
  {
    const u2Issue = await seedBugToReady(5);   // 主开发 dev5·待上线
    let r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [u2Issue], release_assignee_id: 5 });   // 指定 dev5（此刻 developer 过 viewer 校验）
    assert.strictEqual(r.status, 200, '[U-2] 指定 dev5 为上线开发 200');
    await run(`UPDATE users SET role='viewer' WHERE id=?`, [5]);   // 模拟 admin 事后降级 dev5→viewer（server.js 不清 release_assignee_id）
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [u2Issue] });   // devTok JWT role 仍陈旧=user，但 DB 已 viewer
    assert.strictEqual(r.status, 403, `[U-2] 降级 viewer 执行上线应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EXECUTOR_NOT_ELIGIBLE', '[U-2] 403 code=EXECUTOR_NOT_ELIGIBLE（回查当前 role 拦 viewer，JWT 陈旧不放行）');
    assert.strictEqual((await issueRow(u2Issue)).status, '待上线', '[U-2] 拒后单未被翻已上线');
    await run(`UPDATE users SET role='user' WHERE id=?`, [5]);   // 恢复角色
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [u2Issue] });
    assert.strictEqual(r.status, 200, `[U-2] 恢复角色后正常执行 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[U-2] execute-release 角色下限：指派后被降级 viewer → 403 EXECUTOR_NOT_ELIGIBLE（回查当前 role，不信陈旧 JWT）；恢复角色后正常执行 200（不误伤合法执行人）');
  }

  console.log(`\n✅ verify-sys-release-orchestration 全部通过（${passed} 项断言）`);
  server.close();
}

main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
