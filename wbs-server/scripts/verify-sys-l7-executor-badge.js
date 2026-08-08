// 验证脚本：系统迭代 L7「待执行徽标精度」（sys-batch-c7-c11 · 待执行徽标按本人 executor 行状态精化）
//   用法：node scripts/verify-sys-l7-executor-badge.js
//
// 背景：v1.140 上线执行人多选后，一个上线单可有多名执行人。此前「待执行」徽标（mine 视角列表行 +
//   「📦 我的上线单（N 待执行）」入口计数）按**批次级** executor_notify_summary（sent/partial）判定——
//   多执行人下，某执行人自己确认上线完成（exec_status='done'）后，其个人徽标仍亮（因为徽标看的是批次级
//   聚合，没看本人这一行是否 done）。
//
// L7 精化：
//   ① 列表 DTO（GET /sys-releases）mine 视角每行补 my_executor_status/my_executor_done——从
//      sys_release_executors 按 (release_id, 当前 user_id, removed_at IS NULL) 取本人在册行的 exec_status。
//   ② 前端「待执行」徽标判据：批次级（status='计划中' ∧ summary∈{sent,partial}）∧ **本人行未 done**。
//      本人 done → 个人徽标熄灭；他人 done 不影响本人；all 视角（admin/对接人 full scope）不下发该字段、
//      不受影响（前端另按 isMine 门控）。
//
// done 唯一语义源：本人在册行 exec_status='done'（DDL 2.12 段 CHECK 值域仅 pending/done，done 必有合法
//   executed_at；与 R-GATE 双确认 §4.3「在册全员 exec_status='done'」判据同源）。
//
// 覆盖组：
//   [1] mine DTO 扩字段：本人在册行 exec_status 如实回填 my_executor_status + 派生 my_executor_done
//   [2] 本人 done → 徽标熄灭（同批他人仍 pending，本人徽标独立熄灭）
//   [3] 他人 done 不影响本人（本人未 done → 徽标仍亮）
//   [4] 本人未 done → 徽标亮（基线正例）
//   [5] done gate 独立于 notify 维度：summary='partial' 下本人 done 亦熄灭
//   [6] all 视角（admin/对接人 full scope）不下发 my_executor_*，批次级徽标不受影响
//   [7] 入口计数（siProbeMyReleasesEntry 同款过滤）：本人 done 的批次不计入"待执行"数
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-l7-executor-badge-secret';
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);  // full scope（对接人白名单）
const aTok = jwt.sign({ id: 8, username: 'liulinhang', display_name: '示例开发A', role: 'user' }, SECRET);          // 执行人 A（mine 视角）
const bTok = jwt.sign({ id: 9, username: 'zhangqi', display_name: '示例开发B', role: 'user' }, SECRET);               // 执行人 B（mine 视角）

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

// ── 复刻前端「待执行」徽标判据（Sys_Iteration.html 列表行 + 入口计数同款，写读同源）──────────────
//   awaitingExec = status==='计划中' ∧ summary∈{sent,partial} ∧ ¬(isMine ∧ my_executor_done===true)
//   all 视角 isMine=false ⇒ myDone 恒 false ⇒ 退化为纯批次级判据（L7 前的旧行为）。
function awaitingExecBadge(item, isMine) {
  const myDone = isMine && item.my_executor_done === true;
  return item.status === '计划中' && ['sent', 'partial'].includes(item.executor_notify_summary) && !myDone;
}
const rowOf = (resp, no) => resp.body.items.find(x => x.release_no === no);

// 直插执行人在册行；notify_status='sent' 须带 notified_at（DDL 通知态 CHECK）。
async function seedExec(relId, uid, uname, notifyStatus) {
  if (notifyStatus === 'sent') {
    await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
               VALUES (?, ?, ?, 'sent', datetime('now','localtime'), 1, '管理员')`, [relId, uid, uname]);
  } else {
    // 缺省 not_sent（notified_at/notify_error 恒 NULL 满足 CHECK）
    await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name)
               VALUES (?, ?, ?, 1, '管理员')`, [relId, uid, uname]);
  }
}
// 本人确认上线完成：exec_status='done' 必须同带合法 executed_at（DDL 执行态成组 CHECK）。
async function markDone(relId, uid) {
  const st = await run(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime')
                        WHERE release_id=? AND user_id=? AND removed_at IS NULL`, [relId, uid]);
  assert.strictEqual(st.changes, 1, `markDone 应恰改 1 行（rel=${relId} uid=${uid}）`);
}

async function main() {
  mod.initSchema();
  await waitReady();
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', () => { port = server.address().port; res(); }); });

  // ── 数据构造 ─────────────────────────────────────────────────────────────
  // R-L7-1：计划中·A(8)+B(9) 均已通知（summary=sent）——多执行人主场景
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name, created_at)
             VALUES ('R-L7-1', '多执行人·均已通知', '计划中', 0, 1, '管理员', datetime('now'))`);
  const rel1 = (await get(`SELECT id FROM sys_releases WHERE release_no='R-L7-1'`)).id;
  await seedExec(rel1, 8, '示例开发A', 'sent');
  await seedExec(rel1, 9, '示例开发B', 'sent');

  // R-L7-2：计划中·仅 A(8) 已通知（summary=sent）——单执行人对照（本人未 done→亮）
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name, created_at)
             VALUES ('R-L7-2', '单执行人·已通知', '计划中', 0, 1, '管理员', datetime('now'))`);
  const rel2 = (await get(`SELECT id FROM sys_releases WHERE release_no='R-L7-2'`)).id;
  await seedExec(rel2, 8, '示例开发A', 'sent');

  // R-L7-3：计划中·A(8) sent + B(9) not_sent（summary=partial）——done gate 独立于 notify 维度
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name, created_at)
             VALUES ('R-L7-3', '部分已通知·partial', '计划中', 0, 1, '管理员', datetime('now'))`);
  const rel3 = (await get(`SELECT id FROM sys_releases WHERE release_no='R-L7-3'`)).id;
  await seedExec(rel3, 8, '示例开发A', 'sent');
  await seedExec(rel3, 9, '示例开发B', 'not_sent');

  // ── [0] 前提自证：summary 确如预期（sent/sent/partial），否则后续 done gate 断言失去意义 ──────
  const preA = await call('GET', '/api/sys-releases', aTok);
  assert.strictEqual(preA.body.scope, 'mine', 'A scope=mine');
  assert.strictEqual(rowOf(preA, 'R-L7-1').executor_notify_summary, 'sent', 'R-L7-1 summary=sent');
  assert.strictEqual(rowOf(preA, 'R-L7-2').executor_notify_summary, 'sent', 'R-L7-2 summary=sent');
  assert.strictEqual(rowOf(preA, 'R-L7-3').executor_notify_summary, 'partial', 'R-L7-3 summary=partial（A sent + B not_sent）');
  ok('[0] 前提自证：三批次 executor_notify_summary = sent/sent/partial');

  // ── [1] mine DTO 扩字段：初始全 pending → my_executor_status='pending' / my_executor_done=false ──
  for (const no of ['R-L7-1', 'R-L7-2', 'R-L7-3']) {
    const it = rowOf(preA, no);
    assert.strictEqual(it.my_executor_status, 'pending', `${no} A 初始 my_executor_status=pending`);
    assert.strictEqual(it.my_executor_done, false, `${no} A 初始 my_executor_done=false`);
    assert.strictEqual(awaitingExecBadge(it, true), true, `${no} A 初始徽标亮`);
  }
  ok('[1] mine DTO 扩 my_executor_status/my_executor_done；初始全 pending→徽标亮');

  // ── [2] 本人 done → 徽标熄灭（A 确认完成 R-L7-1）──────────────────────────
  await markDone(rel1, 8);
  const a2 = await call('GET', '/api/sys-releases', aTok);
  const a2r1 = rowOf(a2, 'R-L7-1');
  assert.strictEqual(a2r1.my_executor_status, 'done', 'A done 后 my_executor_status=done');
  assert.strictEqual(a2r1.my_executor_done, true, 'A done 后 my_executor_done=true');
  assert.strictEqual(a2r1.executor_notify_summary, 'sent', '批次 summary 仍 sent（notify 维度未变）');
  assert.strictEqual(awaitingExecBadge(a2r1, true), false, 'A 对 R-L7-1 徽标熄灭（本人 done）');
  ok('[2] 本人 done → 徽标熄灭（批次 summary 仍 sent 也熄，done gate 生效）');

  // ── [3] 他人 done 不影响本人（B 视角 R-L7-1 徽标仍亮）───────────────────────
  const b3 = await call('GET', '/api/sys-releases', bTok);
  const b3r1 = rowOf(b3, 'R-L7-1');
  assert.ok(b3r1, 'B mine 视角可见 R-L7-1');
  assert.strictEqual(b3r1.my_executor_status, 'pending', 'B 自己仍 pending（A done 不改 B 行）');
  assert.strictEqual(b3r1.my_executor_done, false, 'B my_executor_done=false');
  assert.strictEqual(awaitingExecBadge(b3r1, true), true, 'B 对 R-L7-1 徽标仍亮（他人 done 不影响本人）');
  ok('[3] 他人 done 不影响本人：B 视角 R-L7-1 徽标仍亮');

  // ── [4] 本人未 done → 徽标亮（A 视角 R-L7-2 基线正例，未被 R-L7-1 的 done 波及）────
  const a2r2 = rowOf(a2, 'R-L7-2');
  assert.strictEqual(a2r2.my_executor_done, false, 'A 对 R-L7-2 仍 pending（跨批次独立）');
  assert.strictEqual(awaitingExecBadge(a2r2, true), true, 'A 对 R-L7-2 徽标仍亮');
  ok('[4] 本人未 done → 徽标亮（跨批次独立，R-L7-1 的 done 不波及 R-L7-2）');

  // ── [5] done gate 独立于 notify 维度：partial 下本人 done 亦熄灭 ─────────────
  // 先证 partial 下本人 pending 徽标亮
  const a2r3 = rowOf(a2, 'R-L7-3');
  assert.strictEqual(a2r3.executor_notify_summary, 'partial', 'R-L7-3 summary=partial');
  assert.strictEqual(awaitingExecBadge(a2r3, true), true, 'A partial 下 pending→徽标亮');
  // A 确认完成 R-L7-3
  await markDone(rel3, 8);
  const a5 = await call('GET', '/api/sys-releases', aTok);
  const a5r3 = rowOf(a5, 'R-L7-3');
  assert.strictEqual(a5r3.executor_notify_summary, 'partial', 'summary 仍 partial（B 仍 not_sent，notify 维度未变）');
  assert.strictEqual(a5r3.my_executor_done, true, 'A done 后 my_executor_done=true');
  assert.strictEqual(awaitingExecBadge(a5r3, true), false, 'A partial 下本人 done→徽标熄灭（done gate 压过 notify 维度）');
  // B 在 partial 批次仍亮（他人 done 不影响）
  const b5 = await call('GET', '/api/sys-releases', bTok);
  const b5r3 = rowOf(b5, 'R-L7-3');
  assert.strictEqual(b5r3.my_executor_done, false, 'B 对 R-L7-3 仍 pending');
  assert.strictEqual(awaitingExecBadge(b5r3, true), true, 'B 对 R-L7-3 徽标仍亮');
  ok('[5] done gate 独立于 notify 维度：partial 下本人 done 熄灭、他人仍亮');

  // ── [6] all 视角（full scope）不下发 my_executor_*，批次级徽标不受影响 ─────────
  for (const [label, tok] of [['admin', adminTok], ['对接人', liaisonTok]]) {
    const full = await call('GET', '/api/sys-releases', tok);
    assert.strictEqual(full.body.scope, 'all', `${label} scope=all`);
    const r1 = rowOf(full, 'R-L7-1');
    assert.ok(r1, `${label} 可见 R-L7-1`);
    assert.strictEqual('my_executor_status' in r1, false, `${label} 不下发 my_executor_status（full scope）`);
    assert.strictEqual('my_executor_done' in r1, false, `${label} 不下发 my_executor_done（full scope）`);
    // A 已 done，但 all 视角批次级 summary 仍 sent → 徽标（isMine=false）不受影响，仍亮
    assert.strictEqual(r1.executor_notify_summary, 'sent', `${label} R-L7-1 批次级 summary=sent`);
    assert.strictEqual(awaitingExecBadge(r1, false), true, `${label} R-L7-1 批次级徽标不受本人 done 影响（仍亮）`);
  }
  ok('[6] all 视角（admin/对接人）不下发 my_executor_*，批次级徽标不受影响');

  // ── [7] 入口计数（siProbeMyReleasesEntry 同款过滤）：本人 done 的批次不计入 ──────
  //   过滤器 = status==='计划中' ∧ summary∈{sent,partial} ∧ my_executor_done !== true（与前端逐字同源）。
  const entryPending = (resp) => resp.body.items.filter(
    x => x.status === '计划中' && ['sent', 'partial'].includes(x.executor_notify_summary) && x.my_executor_done !== true
  ).length;
  // A：R-L7-1 done + R-L7-3 done，仅 R-L7-2 未 done → 计数=1
  const aFinal = await call('GET', '/api/sys-releases', aTok);
  assert.strictEqual(entryPending(aFinal), 1, 'A 入口计数=1（R-L7-1/R-L7-3 已 done 不计，仅剩 R-L7-2）');
  // B：R-L7-1(pending) + R-L7-3(pending，partial 亦计) → 计数=2
  const bFinal = await call('GET', '/api/sys-releases', bTok);
  assert.strictEqual(entryPending(bFinal), 2, 'B 入口计数=2（R-L7-1 + R-L7-3 均未 done）');
  ok('[7] 入口计数：本人 done 批次不计入待执行数（A=1 / B=2）');

  console.log(`\n✅ verify-sys-l7-executor-badge 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message); if (server) server.close(); process.exit(1); });
