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

// 建 bug 单 → 受理 →「待处理」（未指派），返回 id
//   ⚠️ 每一步都断言（codex C1 审 MED）：夹具里静默吞掉 4xx 会让后续断言在错误前置态上"假绿"。
async function createBug(extra = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部', ...extra });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  // ⭐ 角色权限重构 C0：建单恒落「待受理」→ 补一步受理，落态回到旧的 待处理（下游断言不变）
  const acc = await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, 'bug 受理 200, got ' + acc.status + ' ' + JSON.stringify(acc.body));
  assert.strictEqual(acc.body.status, '待处理', 'bug 受理后落「待处理」');
  return r.body.id;
}
// ⚠️ 原 createFeatureScheduled 已删除（codex C1 审 MED）：它在受理之后还调用了**早已退场**的 /schedule，
//   该请求必然失败但返回值没被断言，靠"单据恰好停在待指派"蒙混过关——典型的夹具静默失败。
//   统一改用下方 createFeatureAssignable（每步断言 + 断言最终落态）。

// ⭐ C1：建 feature 单并受理到「待指派」（C0 后建单恒落待受理·assign.from=待指派）
async function createFeatureAssignable() {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'feat可指派单', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建 feature 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段。
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, 'feature 受理 200, got ' + acc.status + ' ' + JSON.stringify(acc.body));
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号
  //   （本 helper 名为"可指派"，把 OA 前置一并做进来，使所有调用点的 assign 测的都是"权限/状态"本身，
  //   不会被"忘设 OA"这个无关变量污染）。
  const oa = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(oa.status, 200, 'feature 补 OA 号 200, got ' + oa.status + ' ' + JSON.stringify(oa.body));
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
  //   ⭐ 角色权限重构 C1 后本组的语义收窄：SYS_BUG_LIAISON_USER_IDS **不再是操作权来源**，
  //     仅剩两项非操作权用途 ①列表/详情可见性（技术负责人看 bug 单接咨询）②path B relay 收件人白名单。
  //     操作权已全部迁到 SYS_INTAKE_LIAISON_IDS[13]（见 [W2]/[MW]/[E] 三组）。
  {
    assert.deepStrictEqual(I.SYS_BUG_LIAISON_USER_IDS, [7, 13], '后端 SYS_BUG_LIAISON_USER_IDS 须 = [7,13]（可见性/relay 收件人语义）');
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
    // ⭐ C1 退场断言：requireAdminOrBugLiaison 已删除且**不再导出**——保留一个无人调用的授权中间件是风险，
    //   任何新端点误挂它都会让示例发布者[7] 重新拿回本应撤销的写权限。本断言就是那道防线。
    assert.strictEqual(I.requireAdminOrBugLiaison, undefined,
      '⭐ C1：requireAdminOrBugLiaison 应已退场（不再导出）——若此断言红灯，说明有人把旧中间件加了回来');
    ok('[W] 白名单三处字面量一致([7,13]·**可见性/relay 收件人语义**) + isSysBugLiaison 单元 + 成员非 viewer 防御 + ⭐ requireAdminOrBugLiaison 已退场');
  }

  // ═══ [P] 权限精判（真 HTTP）· ⭐ 角色权限重构 C1 重写 ═══
  //   C1 把指派权从「bug 对接人白名单 [7,13] 且仅 bug」收敛为「受理人 [13] 且**全类型**」：
  //     · 示例发布者[7]  失去 assign/reassign/dev-assignees/附件/通知 全部协调人动作 → 转纯技术负责人（只回一条评估留言）
  //     · 示例对接人[13] 获得 **feature/improvement/bug 三类型**的指派与改派权（原先只有 bug）
  //   故本组由"白名单两人都能操作 bug、但都不能碰变更流"整体反转为下面的矩阵。
  {
    // ── [P1] assign：admin ∨ 受理人[13] 全类型 200；示例发布者[7] 与普通开发一律 403 ──
    for (const [label, mk] of [['bug', createBug], ['feature', createFeatureAssignable]]) {
      // admin
      let id = await mk();
      let r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(r.status, 200, `admin assign ${label} 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // ⭐ 受理人示例对接人[13]：C1 新获全类型指派权（feature 这一条原先是"越界 403"）
      id = await mk();
      r = await call('POST', `/api/sys-issues/${id}/assign`, liaison2Tok, { assigned_to: 6 });
      assert.strictEqual(r.status, 200, `⭐ 受理人(示例对接人13) assign ${label} 应 200（C1 全类型放开）, got ${r.status} ${JSON.stringify(r.body)}`);
      // ⭐ 示例发布者[7]：C1 起失去指派权（原先 bug 可以）
      id = await mk();
      r = await call('POST', `/api/sys-issues/${id}/assign`, liaison1Tok, { assigned_to: 5 });
      assert.strictEqual(r.status, 403, `⭐ 示例发布者(7) assign ${label} 应 403（C1 转纯技术负责人）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', `示例发布者 assign ${label} 被中间件拒（NOT_ADMIN_OR_INTAKE_LIAISON）`);
      // 普通开发
      id = await mk();
      r = await call('POST', `/api/sys-issues/${id}/assign`, devTok, { assigned_to: 6 });
      assert.strictEqual(r.status, 403, `普通开发 assign ${label} 403`);
      assert.strictEqual(r.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON', '中间件层 code 已随 C1 改名');
    }
    ok('[P1] assign 全类型矩阵：admin/受理人(13) bug+feature 均 200（⭐ feature 是 C1 新放开）；示例发布者(7)/普通开发一律 403 NOT_ADMIN_OR_INTAKE_LIAISON');

    // ── [P2] reassign：同一矩阵（走独立事务·中间件 + handler isSysCoordinator 双层）──
    for (const [label, mk] of [['bug', createBug], ['feature', createFeatureAssignable]]) {
      let id = await mk();
      await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      let r = await call('POST', `/api/sys-issues/${id}/reassign`, liaison2Tok, { member_ids: [6], reason: '换人' });
      assert.strictEqual(r.status, 200, `⭐ 受理人(13) reassign ${label} 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const rAssignees = r.body.dev_assignees || [];
      assert.strictEqual(rAssignees.length, 1, `reassign ${label} 后子表恰 1 行`);
      assert.strictEqual(rAssignees[0].user_id, 6, `reassign ${label} 后开发=6（选举结果）`);

      id = await mk();
      await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      r = await call('POST', `/api/sys-issues/${id}/reassign`, liaison1Tok, { member_ids: [6], reason: '换人' });
      assert.strictEqual(r.status, 403, `⭐ 示例发布者(7) reassign ${label} 应 403`);

      id = await mk();
      await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      r = await call('POST', `/api/sys-issues/${id}/reassign`, dev2Tok, { member_ids: [6], reason: '换人' });
      assert.strictEqual(r.status, 403, `普通开发 reassign ${label} 403`);
    }
    ok('[P2] reassign 全类型矩阵：受理人(13) bug+feature 200；示例发布者(7)/普通开发 403');

    // ── [P3] 不越界：受理人拿到的是"协调人"权，不是泛化 admin 权 ──
    //   accept/close/hold 等仍 requireAdmin —— C1 只收敛「指派/改派/成员/附件/通知」这一族，
    //   验收与上线编排仍属甲方 admin（方案 v1.5 §3 角色模型）。
    let id3 = await createBug();
    await call('POST', `/api/sys-issues/${id3}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${id3}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id3}/submit`, devTok, { summary: '修复完成' });   // → 待验证
    let r3 = await call('POST', `/api/sys-issues/${id3}/accept`, liaison2Tok, {});
    assert.strictEqual(r3.status, 403, '⭐ 受理人(13) accept 应 403（验收仍属 admin·不获泛化写权限）');
    r3 = await call('POST', `/api/sys-issues/${id3}/accept`, liaison1Tok, {});
    assert.strictEqual(r3.status, 403, '示例发布者(7) accept 同样 403');
    ok('[P3] 不越界：受理人/技术负责人对 accept（验收）均 403 —— C1 只收敛协调人族动作，验收/上线仍属 admin');
  }

  // ═══ [V] 可见性写读同源 ═══
  {
    // 造一张 feature（对接人不应见）+ 一张 bug（对接人应见）
    const featId = await createFeatureAssignable();
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
    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', related_correction_no: 'A'.repeat(101) });
    assert.strictEqual(r.status, 400, '>100 字关联单号拒 400');
    assert.strictEqual(r.body.code, 'RELATED_CORRECTION_NO_TOO_LONG', '400 code=RELATED_CORRECTION_NO_TOO_LONG');
    ok('[R] 关联单号：落库 + 软查 active/voided/oa_number/not_found/datafix + matched_by 消歧(M-2) + 边界输入 trim/前导零/全零(L-2) + 无值 null + >100 拒 400');
  }

  // ═══ [M3] codex 30 M-3：对接人本人被指派非 bug 单，读权限不被削弱（isAssignee 优先于 isBugLiaison）═══
  {
    // admin 建 feature → schedule → 指派给对接人示例发布者(id=7)（publisher 非 viewer，可被指派）→ 开发中
    const featId = await createFeatureAssignable();
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
    let id = await createFeatureAssignable();
    let r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, 'canary：admin assign feature 200（无回归）');
    assert.strictEqual(r.body.status, '开发中', 'feature assign → 开发中');

    // 非 admin 非白名单(dev5) feature assign → 403（中间件层，与 ④a 前一致）
    id = await createFeatureAssignable();
    r = await call('POST', `/api/sys-issues/${id}/assign`, devTok, { assigned_to: 6 });
    assert.strictEqual(r.status, 403, 'canary：非 admin 非白名单 feature assign 仍 403');
    ok('[C] 变更流零回归：admin assign feature 200 + 非 admin 非白名单 feature assign 403（中间件层不变）');
  }

  // ═══ 受理排期改造 C2：三白名单 + 引擎 intake_liaison roleGuard 单元级 ═══
  //   ⚠️ 边界：受理动作端点属 C3（未建）→ 本段验**单元级**（判定函数 + 引擎 roleGuard 逻辑直调 sysIssueTransition），
  //     真 HTTP 受理端点回归（§11 完整矩阵）留 C3。前端 SI_INTAKE_LIAISON/SI_TECH_LEAD 字面量属 C7-8（未建·此处不验）。
  {
    // [W2] 三白名单字面量 + 独立不共享引用 + 判定函数单元
    assert.deepStrictEqual(I.SYS_INTAKE_LIAISON_IDS, [13], 'SYS_INTAKE_LIAISON_IDS 须 = [13]（示例对接人·受理）');
    assert.deepStrictEqual(I.SYS_TECH_LEAD_IDS, [7], 'SYS_TECH_LEAD_IDS 须 = [7]（示例发布者·技术负责人）');
    // ⭐ 示例发布者 bug 权零回归：SYS_BUG_LIAISON_USER_IDS 不动（仍 [7,13]）·三名单独立不共享引用
    assert.deepStrictEqual(I.SYS_BUG_LIAISON_USER_IDS, [7, 13], 'SYS_BUG_LIAISON_USER_IDS 保持 [7,13]（示例发布者 bug 权零回归·C2 不动）');
    assert.ok(I.SYS_INTAKE_LIAISON_IDS !== I.SYS_BUG_LIAISON_USER_IDS && I.SYS_TECH_LEAD_IDS !== I.SYS_BUG_LIAISON_USER_IDS,
      '三名单独立引用（非共享同一数组·防角色重划撤权连带）');
    // isSysIntakeLiaison：13 示例对接人在·7 示例发布者不在（受理是示例对接人专属）·字符串归一·非法拒
    assert.strictEqual(I.isSysIntakeLiaison(13), true, 'id=13 示例对接人 在受理白名单');
    assert.strictEqual(I.isSysIntakeLiaison('13'), true, '字符串 "13" 也认（Number 归一）');
    assert.strictEqual(I.isSysIntakeLiaison(7), false, 'id=7 示例发布者 不在受理白名单（受理≠bug对接≠技术负责人）');
    assert.strictEqual(I.isSysIntakeLiaison(5), false, 'id=5 普通开发 不在');
    assert.strictEqual(I.isSysIntakeLiaison(0), false, 'id=0 非法');
    assert.strictEqual(I.isSysIntakeLiaison(null), false, 'null 非法');
    // isSysTechLead：7 示例发布者在·13 示例对接人不在
    assert.strictEqual(I.isSysTechLead(7), true, 'id=7 示例发布者 在技术负责人白名单');
    assert.strictEqual(I.isSysTechLead(13), false, 'id=13 示例对接人 不在技术负责人白名单');
    assert.strictEqual(I.isSysTechLead(0), false, 'id=0 非法');
    assert.strictEqual(typeof I.requireIntakeLiaison, 'function', 'requireIntakeLiaison 中间件已导出');
    ok('⭐ [W2] 三白名单：SYS_INTAKE_LIAISON=[13]/SYS_TECH_LEAD=[7]/SYS_BUG_LIAISON=[7,13](零回归)·独立不共享引用 + isSysIntakeLiaison/isSysTechLead 单元(归属/字符串/非法) + 中间件导出');

    // [MW] requireIntakeLiaison 中间件行为（codex C2 MED-1→LOW·mock req/res/next 五组输入·C2 阶段端点未挂→单测保护）
    //   ⚠️ 复刻 requireAdminOrBugLiaison 但白名单是新的（SYS_INTAKE_LIAISON_IDS）·须独立验行为·防 C3 挂路由时被改坏发现不了。
    const runMw = (user) => {
      let nextCalled = false, statusCode = null, jsonBody = null;
      const req = { user };
      const res = { status(c) { statusCode = c; return this; }, json(b) { jsonBody = b; return this; } };
      I.requireIntakeLiaison(req, res, () => { nextCalled = true; });
      return { nextCalled, statusCode, jsonBody };
    };
    // admin → next
    let mw = runMw({ id: 1, role: 'admin' });
    assert.ok(mw.nextCalled && mw.statusCode === null, 'admin → next()（放行·不返 403）');
    // 示例对接人 13 → next（受理白名单）
    mw = runMw({ id: 13, role: 'user' });
    assert.ok(mw.nextCalled && mw.statusCode === null, '示例对接人(13) → next()（受理白名单放行）');
    // 示例发布者 7 → 403（bug 名单但非受理名单·三名单隔离）
    mw = runMw({ id: 7, role: 'publisher' });
    assert.ok(!mw.nextCalled && mw.statusCode === 403 && mw.jsonBody.code === 'NOT_ADMIN_OR_INTAKE_LIAISON', '示例发布者(7) → 403 NOT_ADMIN_OR_INTAKE_LIAISON（三名单隔离·不放行）');
    // 普通开发 5 → 403
    mw = runMw({ id: 5, role: 'user' });
    assert.ok(!mw.nextCalled && mw.statusCode === 403 && mw.jsonBody.code === 'NOT_ADMIN_OR_INTAKE_LIAISON', '普通开发(5) → 403');
    // 无身份（req.user 缺失）→ 403（fail-closed·不 crash）
    mw = runMw(undefined);
    assert.ok(!mw.nextCalled && mw.statusCode === 403, '无身份(req.user 缺失) → 403（fail-closed·不 crash）');
    ok('⭐ [MW] requireIntakeLiaison 中间件行为（mock req/res/next 五组）：admin✅next / 示例对接人13✅next / 示例发布者7❌403 / 普通5❌403 / 无身份❌403(fail-closed)');

    // [E] 引擎 intake_liaison roleGuard 单元级（直调 sysIssueTransition·绕过 HTTP·C3 端点未建）
    //   种一条 feature 待受理单（intake_required=1），用不同 actor 执行 intake_accept，验引擎放行/拒。
    const seedIntakeIssue = async () => {
      const r = await run(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
         VALUES ('feature', '待受理', '受理单', 'BMS', '内部', 1, 'admin', 1)`);
      return r.lastID;
    };
    const actor = (id, role) => ({ id, name: `u${id}`, role });
    // admin → 放行（待受理→待指派）
    let iid = await seedIntakeIssue();
    let res = await I.sysIssueTransition(iid, 'intake_accept', null, actor(1, 'admin'));
    assert.strictEqual(res.toStatus, '待指派', 'admin intake_accept → 待指派（roleGuard 放行）');
    // 示例对接人 id13 → 放行（受理人白名单·C2 放开点）
    iid = await seedIntakeIssue();
    res = await I.sysIssueTransition(iid, 'intake_accept', null, actor(13, 'user'));
    assert.strictEqual(res.toStatus, '待指派', '示例对接人(13) intake_accept → 待指派（受理白名单放行·C2 引擎放开生效）');
    // 示例发布者 id7 → 403（在 bug 名单但不在受理名单·三名单隔离铁证）
    iid = await seedIntakeIssue();
    await assert.rejects(
      () => I.sysIssueTransition(iid, 'intake_accept', null, actor(7, 'publisher')),
      (e) => e && e.httpStatus === 403 && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      '示例发布者(7) intake_accept → 403（在 bug 白名单但不在受理白名单·三名单隔离·非泛化）');
    // 普通开发 id5 → 403
    iid = await seedIntakeIssue();
    await assert.rejects(
      () => I.sysIssueTransition(iid, 'intake_accept', null, actor(5, 'user')),
      (e) => e && e.httpStatus === 403 && e.code === 'NOT_AUTHORIZED_FOR_TRANSITION',
      '普通开发(5) intake_accept → 403');
    ok('⭐ [E] 引擎 intake_liaison roleGuard 放开生效（单元级·直调 sysIssueTransition）：admin✅ / 示例对接人13✅ / 示例发布者7❌403(三名单隔离) / 普通5❌403');
  }

  server.close();
  console.log(`\n✅ verify-sys-liaison 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-liaison 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
