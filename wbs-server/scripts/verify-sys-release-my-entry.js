// 验证脚本：系统迭代 执行人入口批（2026-07-31 用户拍板·v1.130.0 部署首日实测反馈）
//   用法：node scripts/verify-sys-release-my-entry.js
//
// 背景：执行人入口此前只活在钉钉深链（?release=）上——列表端点锁 admin∨对接人、单据详情端点不返回
//   批次级执行人字段（「前往上线单」按钮判不了权只能"宁可少显示"）。本批三处收口：
//   ① GET /sys-releases 三分支：admin∨对接人=全量(scope='all')；其他登录用户=仅"执行人=我"的批次
//      含全部状态历史(scope='mine')；无关普通用户拿空数组非 403
//   ② 详情端点新增 release_brief（批次简要：id/release_no/status/release_kind/release_assignee_*）
//   ③ isReleaseExecutor 批次级收口：新机制执行人（批次表字段）可打开成员单据——不叠 type='bug'
//      （C3 全类型统一后 feature/improvement 成员单执行人同样要能打开；issue 级同名列是旧机制只读残留）
//
// 覆盖组：
//   [1] 列表分支：admin 全量+scope=all / 对接人全量+scope=all / 执行人仅本人批次(含已发布历史)+scope=mine
//       / 无关用户空数组 200+scope=mine / 未登录 401
//   [2] 列表新 3 列（release_assignee_id/name/notify_status）真实返回
//   [3] 列表 status 筛选与 mine 过滤正确组合（AND 语义）
//   [4] 详情 release_brief：有批次→六字段齐；无批次→null
//   [5] 执行人可见性收口：feature 成员单（issue 级执行人列恒 NULL）批次执行人可打开(200)；
//       无关用户仍 403（releaseBrief 查询不放宽既有边界）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-my-entry-secret';
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人白名单
const execTok = jwt.sign({ id: 8, username: 'liulinhang', display_name: '示例开发A', role: 'user' }, SECRET);       // 批次执行人
const otherTok = jwt.sign({ id: 99, username: 'nobody', display_name: '路人', role: 'user' }, SECRET);          // 无关普通用户

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };

async function main() {
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', () => { port = server.address().port; res(); }); });

  // ── 数据构造（直插，intake_required=1 过受理门触发器）──────────────────────────
  // 批次 R1：计划中·已通知执行人 8（新机制：执行人只写批次表）
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_assignee_id, release_assignee_name,
              release_assignee_notify_status, created_by, created_by_name, created_at)
             VALUES ('R-T-1', '批次1·执行人8已通知', '计划中', 0, 8, '示例开发A', 'sent', 1, '管理员', datetime('now'))`);
  const rel1 = (await get(`SELECT id FROM sys_releases WHERE release_no='R-T-1'`)).id;
  // 批次 R2：已发布·历史执行人 8（拍板"含历史"——mine 视角必须能看到）
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_assignee_id, release_assignee_name,
              release_assignee_notify_status, released_at, created_by, created_by_name, created_at)
             VALUES ('R-T-2', '批次2·执行人8已发布', '已发布', 0, 8, '示例开发A', 'sent', datetime('now'), 1, '管理员', datetime('now'))`);
  const rel2 = (await get(`SELECT id FROM sys_releases WHERE release_no='R-T-2'`)).id;
  // 批次 R3：计划中·执行人是别人（9）——用户 8 的 mine 视角不得见
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_assignee_id, release_assignee_name,
              release_assignee_notify_status, created_by, created_by_name, created_at)
             VALUES ('R-T-3', '批次3·执行人9', '计划中', 0, 9, '示例开发B', 'sent', 1, '管理员', datetime('now'))`);
  // 批次 R4：计划中·未指定执行人——mine 视角不得见
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name, created_at)
             VALUES ('R-T-4', '批次4·未指定', '计划中', 0, 1, '管理员', datetime('now'))`);

  // 成员单：feature·挂批次 R1·issue 级 release_assignee_id 恒 NULL（新机制不回写）
  await run(`INSERT INTO sys_issues (id, type, title, status, system_name, source, created_by, created_by_name,
              release_id, intake_required, created_at)
             VALUES (301, 'feature', '成员单·feature·批次1', '待上线', 'BMS', '内部', 1, '管理员', ?, 1, datetime('now'))`, [rel1]);
  // 对照单：无批次
  await run(`INSERT INTO sys_issues (id, type, title, status, system_name, source, created_by, created_by_name,
              intake_required, created_at)
             VALUES (302, 'feature', '对照单·无批次', '待受理', 'BMS', '内部', 1, '管理员', 1, datetime('now'))`);

  // ── [1] 列表分支 ─────────────────────────────────────────────────────────
  const rAdmin = await call('GET', '/api/sys-releases', adminTok);
  assert.strictEqual(rAdmin.status, 200);
  assert.strictEqual(rAdmin.body.scope, 'all', 'admin scope=all');
  assert.strictEqual(rAdmin.body.items.length, 4, 'admin 见全量 4 批次');
  ok('[1] admin：全量 4 批次 + scope=all');

  const rLiaison = await call('GET', '/api/sys-releases', liaisonTok);
  assert.strictEqual(rLiaison.status, 200);
  assert.strictEqual(rLiaison.body.scope, 'all', '对接人 scope=all');
  assert.strictEqual(rLiaison.body.items.length, 4, '对接人见全量 4 批次');
  ok('[1] 对接人：全量 4 批次 + scope=all');

  const rExec = await call('GET', '/api/sys-releases', execTok);
  assert.strictEqual(rExec.status, 200);
  assert.strictEqual(rExec.body.scope, 'mine', '执行人 scope=mine');
  const execNos = rExec.body.items.map(x => x.release_no).sort();
  assert.deepStrictEqual(execNos, ['R-T-1', 'R-T-2'], '执行人仅见本人 2 批次（含已发布历史，不见 R-T-3/R-T-4）');
  ok('[1] 执行人：仅"执行人=我"的 2 批次（含已发布历史）+ scope=mine');

  const rOther = await call('GET', '/api/sys-releases', otherTok);
  assert.strictEqual(rOther.status, 200, '无关用户 200 非 403');
  assert.strictEqual(rOther.body.scope, 'mine');
  assert.strictEqual(rOther.body.items.length, 0, '无关用户空数组');
  ok('[1] 无关普通用户：200 + 空数组（非 403，前端按"空则不显入口"）');

  const rAnon = await call('GET', '/api/sys-releases', null);
  assert.strictEqual(rAnon.status, 401, '未登录 401');
  ok('[1] 未登录：401');

  // ── [2] 列表新 3 列 ──────────────────────────────────────────────────────
  const row1 = rAdmin.body.items.find(x => x.release_no === 'R-T-1');
  assert.strictEqual(Number(row1.release_assignee_id), 8);
  assert.strictEqual(row1.release_assignee_name, '示例开发A');
  assert.strictEqual(row1.release_assignee_notify_status, 'sent');
  ok('[2] 列表返回执行人 3 列（id/name/notify_status）');

  // ── [3] status 筛选 × mine 过滤 AND 组合 ─────────────────────────────────
  const rExecPlan = await call('GET', '/api/sys-releases?status=' + encodeURIComponent('计划中'), execTok);
  assert.strictEqual(rExecPlan.status, 200);
  assert.deepStrictEqual(rExecPlan.body.items.map(x => x.release_no), ['R-T-1'], '执行人+计划中筛选=仅 R-T-1');
  ok('[3] status 筛选与 mine 过滤 AND 组合正确');

  // ── [4] 详情 release_brief ───────────────────────────────────────────────
  const rDetail = await call('GET', '/api/sys-issues/301', adminTok);
  assert.strictEqual(rDetail.status, 200);
  const rb = rDetail.body.release_brief;
  assert.ok(rb, 'release_brief 非空');
  assert.strictEqual(rb.id, rel1);
  assert.strictEqual(rb.release_no, 'R-T-1');
  assert.strictEqual(rb.status, '计划中');
  assert.ok('release_kind' in rb && 'release_assignee_id' in rb && 'release_assignee_name' in rb, 'brief 六字段齐');
  assert.strictEqual(Number(rb.release_assignee_id), 8);
  ok('[4] 有批次单据：release_brief 六字段齐且值正确');

  const rDetail2 = await call('GET', '/api/sys-issues/302', adminTok);
  assert.strictEqual(rDetail2.status, 200);
  assert.strictEqual(rDetail2.body.release_brief, null, '无批次单据 release_brief=null');
  ok('[4] 无批次单据：release_brief=null');

  // ── [5] 执行人可见性收口 ─────────────────────────────────────────────────
  // feature 成员单 + issue 级执行人列 NULL + 批次执行人=8 → 改动前旧判据（issue 级列 + type='bug'）恒 false
  //   会 403；本批批次级判断放行。先断言前提真实成立（issue 级列确实 NULL——防夹具自己变假）。
  const iss301 = await get(`SELECT release_assignee_id FROM sys_issues WHERE id=301`);
  assert.strictEqual(iss301.release_assignee_id, null, '前提：issue 级执行人列恒 NULL（新机制不回写）');
  const rExecView = await call('GET', '/api/sys-issues/301', execTok);
  assert.strictEqual(rExecView.status, 200, 'feature 成员单：批次执行人可打开（旧判据下必 403）');
  assert.ok(rExecView.body.release_brief && Number(rExecView.body.release_brief.release_assignee_id) === 8,
    '批次执行人拿到完整 release_brief（判权放行集内）');
  ok('[5] 批次执行人打开 feature 成员单：200 + release_brief 完整（isReleaseExecutor 批次级收口生效）');

  const rOtherView = await call('GET', '/api/sys-issues/301', otherTok);
  assert.strictEqual(rOtherView.status, 403, '无关用户仍 403');
  ok('[5] 无关用户打开成员单：仍 403（边界未放宽）');

  // ── [6] release_brief 条件下发（codex 审 MED-1 收口）─────────────────────
  //   单据可读集比批次可读集宽——构造"在册开发成员"（能读单据，但非 admin/对接人/批次执行人）：
  //   断言其 200 可读单据、但 release_brief=null（批次元数据不下发），与批次读权放行集精确同源。
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary)
             VALUES (301, 21, '在册成员甲', 0)`);
  const rosterTok = jwt.sign({ id: 21, username: 'roster21', display_name: '在册成员甲', role: 'user' }, SECRET);
  const rRosterView = await call('GET', '/api/sys-issues/301', rosterTok);
  assert.strictEqual(rRosterView.status, 200, '在册成员可读单据（既有 isRosterMember 通道）');
  assert.strictEqual(rRosterView.body.release_brief, null, '在册成员 release_brief=null（批次元数据不无差别下发）');
  ok('[6] 单据可读但批次不可读者：200 读单据 + release_brief=null（MED-1 下发面收口生效）');

  console.log(`\n✅ verify-sys-release-my-entry 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message); if (server) server.close(); process.exit(1); });
