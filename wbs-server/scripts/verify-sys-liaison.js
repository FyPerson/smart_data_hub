// 验证脚本：系统迭代 bug 流 对接人白名单端点隔离 + 关联修正单号（bug流_方案_20260702_v1.2 §3/§7，Commit ④a）
//   用法：node scripts/verify-sys-liaison.js
//
// 覆盖（真实 HTTP 端点 + 常量层三处一致）：
//   [W] 白名单三处字面量一致：后端 _internals.SYS_BUG_LIAISON_USER_IDS + 前端 Sys_Iteration.html SI_BUG_LIAISON_USER_IDS
//       + 本 verify 期望值，全部 = [7,13]（示例发布者 id=7 / 示例对接人 id=13）；isSysBugLiaison 单元 + 成员非 viewer 防御断言
//   [P] 权限精判（真 HTTP）：
//       · admin / 白名单对接人(7,13) assign·reassign bug → 200（新放开路径）
//       · 非白名单非 admin(dev id=5) assign·reassign bug → 403（中间件 NOT_ADMIN_OR_BUG_LIAISON）
//       · 白名单对接人对 feature assign → 403（sysIssueTransition [3] roleGuard='admin' 拒，不越界）
//       · 白名单对接人对 feature reassign → 403（reassign handler type='bug' 精判拒，不越界）
//       · 白名单对接人对其余 admin 动作(accept) → 403（accept 仍 requireAdmin，对接人不获泛化写权限，H-2 隔离）
//   [V] 可见性写读同源（[[feedback_write_read_same_semantic]]）：对接人列表见全部 bug + 详情可开 bug(200)；
//       feature 未指派 → 列表无 + 详情 403（列表看不到即详情打不开，读端一致）
//   [R] 关联修正单号（§7 软引用）：建单收 related_correction_no / >100 拒 400 / 详情软查 active·voided·not_found
//       （纯数字→id / 否则→oa_number；不硬校验不 join；correction 表异常吞为 null 由 try/catch 兜底，此处正路径验证）
//   [C] 变更流零回归 canary：admin assign feature 正常 200 / 非 admin 非白名单(dev5) feature assign 403（中间件层不变）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const SECRET = 'verify-sys-liaison-secret';
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

// ⚠️ 测试用户 id 对齐**生产语义**（非 bug-transitions harness 的 id=7=viewer）：
//   id=7=示例发布者(publisher,对接人) / id=13=示例对接人(user,对接人)——与 correction relay 白名单同两人，与生产一致。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const liaison1Tok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);   // 对接人①
const liaison2Tok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);  // 对接人②

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
const EST = '2026-08-01 10:00';

// 建 bug 单（待处理，未指派），返回 id
async function createBug(extra = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部', ...extra });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.id;
}
// 建 feature 单并推到 已排期（未指派），返回 id
async function createFeatureScheduled() {
  const r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'feat单', system_name: 'BMS', source: '内部' });
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // users 表（assign/reassign 端点查 users 校验被指派人）
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),
    (7,'shenjun','示例发布者','publisher'),(13,'wangtaotao','示例对接人','user'),(9,'viewer','观察员','viewer')`);
  // correction_requests 表（§7 软查目标；最小 schema：id/oa_number/voided_at 对齐 corrections.js）
  await run(`CREATE TABLE IF NOT EXISTS correction_requests (id INTEGER PRIMARY KEY, oa_number TEXT, voided_at DATETIME)`);
  await run(`INSERT INTO correction_requests (id, oa_number, voided_at) VALUES (100,'OA-777',NULL),(101,NULL,datetime('now','localtime'))`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务（对接人 id=7 示例发布者/13 示例对接人，对齐生产语义）');

  // ═══ [W] 白名单三处字面量一致 + isSysBugLiaison 单元 + 成员非 viewer 防御 ═══
  {
    assert.deepStrictEqual(I.SYS_BUG_LIAISON_USER_IDS, [7, 13], '后端 SYS_BUG_LIAISON_USER_IDS 须 = [7,13]');
    // 前端字面量（防三处漂移，对齐 correction relay 白名单纪律）
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    assert.ok(/const\s+SI_BUG_LIAISON_USER_IDS\s*=\s*\[\s*7\s*,\s*13\s*\]/.test(htmlSrc),
      '前端 Sys_Iteration.html SI_BUG_LIAISON_USER_IDS 须 = [7,13]（与后端同源）');
    // isSysBugLiaison 单元
    assert.strictEqual(I.isSysBugLiaison(7), true, 'id=7 示例发布者 在白名单');
    assert.strictEqual(I.isSysBugLiaison(13), true, 'id=13 示例对接人 在白名单');
    assert.strictEqual(I.isSysBugLiaison('7'), true, '字符串 "7" 也认（Number 归一）');
    assert.strictEqual(I.isSysBugLiaison(5), false, 'id=5 开发 不在白名单');
    assert.strictEqual(I.isSysBugLiaison(0), false, 'id=0 非法');
    assert.strictEqual(I.isSysBugLiaison(null), false, 'null 非法');
    // 成员非 viewer 防御（若把 viewer 加入名单会误获指派权，对齐 correction verify 防御断言）
    for (const uid of I.SYS_BUG_LIAISON_USER_IDS) {
      const u = await get('SELECT role FROM users WHERE id=?', [uid]);
      assert.ok(u && u.role !== 'viewer', `白名单成员 id=${uid} 不应是 viewer（防误获指派权）`);
    }
    assert.strictEqual(typeof I.requireAdminOrBugLiaison, 'function', 'requireAdminOrBugLiaison 中间件已导出');
    ok('[W] 白名单三处字面量一致([7,13]) + isSysBugLiaison 单元(7/13/字符串/非法) + 成员非 viewer 防御 + 中间件导出');
  }

  // ═══ [P] 权限精判（真 HTTP）═══
  {
    // admin assign bug → 200
    let id = await createBug();
    let r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, 'admin assign bug 200');

    // 白名单对接人(7) assign bug → 200（新放开）
    id = await createBug();
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaison1Tok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '对接人(示例发布者 id=7) assign bug 200，got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, '处理中', 'assign 直达 处理中');

    // 白名单对接人(13) assign bug → 200
    id = await createBug();
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaison2Tok, { assigned_to: 6 });
    assert.strictEqual(r.status, 200, '对接人(示例对接人 id=13) assign bug 200');

    // 非白名单非 admin(dev id=5) assign bug → 403（中间件）
    id = await createBug();
    r = await call('POST', `/api/sys-issues/${id}/assign`, devTok, { assigned_to: 6 });
    assert.strictEqual(r.status, 403, '非白名单非 admin assign bug 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_BUG_LIAISON', '403 code=NOT_ADMIN_OR_BUG_LIAISON（中间件层）');
    ok('[P1] assign：admin/对接人(7,13) bug 200（新放开）+ 非白名单非 admin 403(中间件 NOT_ADMIN_OR_BUG_LIAISON)');

    // 白名单对接人 reassign bug → 200：先 admin 建单指派到 dev5（处理中），对接人换到 dev6
    //   ⚠️ 既有测试变更（C2：reassign body 改 member_ids+reason 声明式最终 roster，见交付汇报清单）。
    id = await createBug();
    await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    r = await call('POST', `/api/sys-issues/${id}/reassign`, liaison1Tok, { member_ids: [6], reason: '换人' });
    assert.strictEqual(r.status, 200, '对接人 reassign bug 200，got ' + r.status + ' ' + JSON.stringify(r.body));
    const rAssignees = r.body.dev_assignees || [];
    assert.strictEqual(rAssignees.length, 1, 'reassign 后子表恰 1 行');
    assert.strictEqual(rAssignees[0].user_id, 6, 'reassign 后开发=6（选举结果）');

    // 非白名单非 admin reassign bug → 403（中间件）
    id = await createBug();
    await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    r = await call('POST', `/api/sys-issues/${id}/reassign`, dev2Tok, { member_ids: [6], reason: '换人' });
    assert.strictEqual(r.status, 403, '非白名单非 admin reassign bug 403');
    assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_BUG_LIAISON', 'reassign 403 中间件层');
    ok('[P2] reassign：admin/对接人 bug 200 + 非白名单非 admin 403（中间件）');

    // 越界①：对接人 assign FEATURE → 403（[3] roleGuard='admin' 拒）
    id = await createFeatureScheduled();
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaison1Tok, { assigned_to: 5 });
    assert.strictEqual(r.status, 403, '对接人 assign feature 应 403（不越界变更流）');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', 'feature assign 越界 403 code（[3] roleGuard 层）');

    // 越界②：对接人 reassign FEATURE → 403（reassign handler type='bug' 精判拒）
    id = await createFeatureScheduled();
    await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });   // feature → 开发中
    r = await call('POST', `/api/sys-issues/${id}/reassign`, liaison1Tok, { member_ids: [6], reason: '换人' });
    assert.strictEqual(r.status, 403, '对接人 reassign feature 应 403（handler type 精判）');

    // 越界③：对接人对其余 admin 动作(accept) → 403（accept 仍 requireAdmin，对接人不获泛化写权限）
    id = await createBug();
    await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id}/submit`, devTok, { summary: '修复完成' });   // → 待验证
    r = await call('POST', `/api/sys-issues/${id}/accept`, liaison1Tok, {});
    assert.strictEqual(r.status, 403, '对接人 accept 应 403（accept 仍 requireAdmin，不获泛化写权限 H-2 隔离）');
    ok('[P3] 不越界：对接人 assign/reassign feature 403 + accept(其余 admin 动作) 403（白名单仅 bug 指派/换人）');
  }

  // ═══ [V] 可见性写读同源 ═══
  {
    // 造一张 feature（对接人不应见）+ 一张 bug（对接人应见）
    const featId = await createFeatureScheduled();
    const bugId = await createBug();

    // 对接人列表：见 bug，不见 feature（未指派给他）
    let r = await call('GET', '/api/sys-issues', liaison1Tok);
    assert.strictEqual(r.status, 200, '对接人列表 200');
    const ids = (r.body.items || []).map(i => i.id);
    const types = new Set((r.body.items || []).map(i => i.type));
    assert.ok(ids.includes(bugId), '对接人列表含 bug 单');
    assert.ok(!ids.includes(featId), '对接人列表不含未指派 feature 单');
    assert.ok(!types.has('feature'), '对接人列表无任何 feature（仅 bug + 本人指派）');

    // 详情写读同源：bug 可开(200)，feature 不可开(403)
    r = await call('GET', `/api/sys-issues/${bugId}`, liaison1Tok);
    assert.strictEqual(r.status, 200, '对接人可开 bug 详情（与列表同源）');
    r = await call('GET', `/api/sys-issues/${featId}`, liaison1Tok);
    assert.strictEqual(r.status, 403, '对接人不可开 feature 详情（列表看不到→详情打不开，读端一致）');
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_TO_VIEW', 'feature 详情 403 code');

    // 非白名单非 admin(dev6，未被指派) 列表：空集（既不见 bug 也不见 feature）
    r = await call('GET', '/api/sys-issues', jwt.sign({ id: 6, username: 'dev2', role: 'user' }, SECRET));
    const ids6 = (r.body.items || []).map(i => i.id);
    assert.ok(!ids6.includes(bugId) && !ids6.includes(featId), '非白名单非 admin 未指派→列表不含这两单（可见性不放开）');
    ok('[V] 可见性写读同源：对接人列表见 bug 不见 feature + 详情 bug 200/feature 403 + 非白名单不放开');
  }

  // ═══ [R] 关联修正单号（§7 软引用；含 codex 30 M-2 matched_by + L-2 边界输入）═══
  {
    // 建单收 related_correction_no（纯数字 id=100，correction active）→ matched_by='id'
    let id = await createBug({ related_correction_no: '100' });
    let row = await get('SELECT related_correction_no FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.related_correction_no, '100', 'related_correction_no 落库');
    let r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.deepStrictEqual(r.body.related_correction, { found: true, status: 'active', id: 100, matched_by: 'id' }, '软查：id=100 → active + matched_by=id');

    // voided correction（id=101）→ matched_by='id'
    id = await createBug({ related_correction_no: '101' });
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.body.related_correction.status, 'voided', '软查：id=101（voided_at 非空）→ voided');
    assert.strictEqual(r.body.related_correction.matched_by, 'id', 'voided 命中也回 matched_by=id');

    // oa_number 匹配（非纯数字，走 oa_number='OA-777'）→ matched_by='oa_number'（M-2 消歧）
    id = await createBug({ related_correction_no: 'OA-777' });
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.deepStrictEqual(r.body.related_correction, { found: true, status: 'active', id: 100, matched_by: 'oa_number' }, '软查：OA-777 → oa_number 匹配 id=100 active + matched_by=oa_number');

    // 未找到（不存在 id）→ matched_by=null
    id = await createBug({ related_correction_no: '99999' });
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.deepStrictEqual(r.body.related_correction, { found: false, status: 'not_found', matched_by: null }, '软查：不存在 → not_found + matched_by=null');

    // datafix-5（非数字非 oa_number）→ not_found（软引用，不硬校验）
    id = await createBug({ related_correction_no: 'datafix-5' });
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.body.related_correction.status, 'not_found', '软查：datafix-5 无匹配 → not_found（软引用不硬校验）');

    // ── codex 30 L-2 边界输入（把软查语义用例固定成文档）──
    // ' 100 ' → 建单 trim 后落库 '100' → 软查命中 id（trim 由建单端点做）
    id = await createBug({ related_correction_no: '  100  ' });
    row = await get('SELECT related_correction_no FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.related_correction_no, '100', "L-2：' 100 ' 建单 trim 后落库 '100'");
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.body.related_correction.matched_by, 'id', "L-2：trim 后 '100' 命中 id");
    // '00100' 前导零 → 正则不认（首位须 1-9）→ 走 oa_number 无匹配 → not_found
    id = await createBug({ related_correction_no: '00100' });
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.body.related_correction.status, 'not_found', "L-2：'00100' 前导零非纯数字分支 → oa_number 无匹配 → not_found");
    // '000' / '01' 前导零/全零 → not_found（明确预期，非静默按 id）
    for (const edge of ['000', '01']) {
      id = await createBug({ related_correction_no: edge });
      r = await call('GET', `/api/sys-issues/${id}`, adminTok);
      assert.strictEqual(r.body.related_correction.status, 'not_found', `L-2：'${edge}' 前导零 → not_found（不误按 id）`);
    }

    // 无关联单号 → related_correction=null
    id = await createBug();
    r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.body.related_correction, null, '无 related_correction_no → related_correction=null');

    // >100 字拒 400
    r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', related_correction_no: 'A'.repeat(101) });
    assert.strictEqual(r.status, 400, '>100 字关联单号拒 400');
    assert.strictEqual(r.body.code, 'RELATED_CORRECTION_NO_TOO_LONG', '400 code=RELATED_CORRECTION_NO_TOO_LONG');
    ok('[R] 关联单号：落库 + 软查 active/voided/oa_number/not_found/datafix + matched_by 消歧(M-2) + 边界输入 trim/前导零/全零(L-2) + 无值 null + >100 拒 400');
  }

  // ═══ [M3] codex 30 M-3：对接人本人被指派非 bug 单，读权限不被削弱（isAssignee 优先于 isBugLiaison）═══
  {
    // admin 建 feature → schedule → 指派给对接人示例发布者(id=7)（publisher 非 viewer，可被指派）→ 开发中
    const featId = await createFeatureScheduled();
    let r = await call('POST', `/api/sys-issues/${featId}/assign`, adminTok, { assigned_to: 7 });
    assert.strictEqual(r.status, 200, 'admin 指派 feature 给对接人(id=7) 200');
    // 对接人(7) 作为 assignee：列表能看到该 feature + 详情能打开（对接人身份不削弱 assignee 读权限）
    r = await call('GET', '/api/sys-issues', liaison1Tok);
    assert.ok((r.body.items || []).some(i => i.id === featId && i.type === 'feature'), 'M-3：对接人本人被指派的 feature 出现在其列表（isAssignee 分支）');
    r = await call('GET', `/api/sys-issues/${featId}`, liaison1Tok);
    assert.strictEqual(r.status, 200, 'M-3：对接人可开本人被指派的 feature 详情（isAssignee，非 isBugLiaison）');
    ok('[M3] 对接人本人被指派 feature/improvement → 列表可见 + 详情可开（身份不削弱 assignee 读权限，锁写读同源不变量）');
  }

  // ═══ [L1] codex 30 L-1：已作废 bug 对对接人的读权限边界（读端同源 + 已作废例外）═══
  {
    // 建 bug → void（admin，软删除）
    const bugId = await createBug();
    let r = await call('POST', `/api/sys-issues/${bugId}/void`, adminTok, { reason: '误建作废' });
    assert.strictEqual(r.status, 200, 'admin 作废 bug 200');
    // 对接人列表：默认看不到已作废 bug
    r = await call('GET', '/api/sys-issues', liaison1Tok);
    assert.ok(!(r.body.items || []).some(i => i.id === bugId), 'L-1：对接人列表默认不含已作废 bug');
    // 对接人详情：已作废 bug → 403（非 admin，与列表看不到同源）
    r = await call('GET', `/api/sys-issues/${bugId}`, liaison1Tok);
    assert.strictEqual(r.status, 403, 'L-1：对接人开已作废 bug 详情 → 403（读端同源，列表看不到即详情打不开）');
    // admin 详情：仍可查看已作废
    r = await call('GET', `/api/sys-issues/${bugId}`, adminTok);
    assert.strictEqual(r.status, 200, 'L-1：admin 仍可查看已作废 bug 详情');
    ok('[L1] 已作废 bug：对接人列表看不到 + 详情 403（读端同源+已作废例外）+ admin 可查看');
  }

  // ═══ [C] 变更流零回归 canary ═══
  {
    // admin assign feature 正常 200（中间件放开对接人不影响 admin 路径）
    let id = await createFeatureScheduled();
    let r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, 'canary：admin assign feature 200（无回归）');
    assert.strictEqual(r.body.status, '开发中', 'feature assign → 开发中');

    // 非 admin 非白名单(dev5) feature assign → 403（中间件层，与 ④a 前一致）
    id = await createFeatureScheduled();
    r = await call('POST', `/api/sys-issues/${id}/assign`, devTok, { assigned_to: 6 });
    assert.strictEqual(r.status, 403, 'canary：非 admin 非白名单 feature assign 仍 403');
    ok('[C] 变更流零回归：admin assign feature 200 + 非 admin 非白名单 feature assign 403（中间件层不变）');
  }

  server.close();
  console.log(`\n✅ verify-sys-liaison 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-liaison 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
