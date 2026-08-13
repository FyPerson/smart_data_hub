// scripts/verify-sys-estimate-stale.js — 系统迭代估时/评估两端点并发乐观锁 expected_dev_estimated_at 验收
//   背景缺陷：/sys-issues/:id/estimate 与 /sys-issues/:id/feasibility 的乐观锁只绑 status（WHERE 条件），
//   两个在册开发在**同一状态内**先后填 dev_estimated_at 时，后填直接覆盖先填且无感知——status 锁对此
//   完全无感（status 从头到尾没变过）。本次改动补一把**值级**乐观锁：调用方可选传
//   expected_dev_estimated_at（"我打开弹窗时看到的现值"），后端在写入前比对，不符则 409 ESTIMATE_STALE。
//   用法：node scripts/verify-sys-estimate-stale.js
//
// 覆盖（双向，每组都证"改动真发生"与"真被拦下且零副作用"两面——对照组思路见各组注释）：
//   [S] /estimate 端点：
//     S1 null↔null 通过 / S2 expected 不符→409+库值&timeline 零副作用 / S3 expected 等于现值→200 正常写入
//     / S4 不传 expected→200 兼容（旧前端零行为变化） / S5 类型闸非 string/null→400 VALIDATION+零副作用
//     / S6 现值非空+expected=null→409（方向性：null 不是通配符） / S7 真实双开发覆盖场景（复现背景缺陷→证明已修）
//     / S8 排序钉死：同值 no-op 前提下过期 expected 仍 409（stale 判定先于 no-op）
//   [F] /feasibility 端点：F1-F7 同款一组（resubmission 全量覆盖语境下更要证"半份都没写"）/ F8（328a 回卷新增）
//     对称钉死：本端点无 no-op 分支，同值提交+过期 expected 依然 409（不因"值恰好相同"网开一面）
//   [328a 回卷] S6/F6/S8 补齐完整零副作用 snapshot（row 全字段深比对 + timeline 计数，此前 S6 只比对
//     dev_estimated_at 单字段、S8 完全没有 snapshot）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-estimate-stale-secret';
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

// 2026-08-01 日期炸弹教训：远期字面量迟早到期，动态生成（同既有 verify-sys-* 惯例，勿回退此写法）
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 14:30`;
}

// 建一个「开发中 + 已指派」的 nf=0 feature 单，供 /estimate 组使用（流程照搬 verify-sys-time-precision.js
// 的 setupAssignedIssue：建单恒落「待受理」→ intake-accept → set-oa-number → assign）。
async function setupEstimateIssue(title, oaNumber) {
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'feature', title, system_name: 'BMS',
    source: '内部', description: '并发乐观锁 verify 夹具（nf=0）', intake_liaison_id: 13,
  });
  assert.strictEqual(r.status, 201, `[夹具-S] 建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `[夹具-S] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: oaNumber });
  assert.strictEqual(r.status, 200, `[夹具-S] 补 OA 号应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-S] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  // [组A·2026-08-12] intake-accept 现会按默认 SLA 自动生成 dev_estimated_at——本文件测的是并发乐观锁
  //   （expected_dev_estimated_at）语义，需要干净 null 基线做起点，故 fixture 收尾显式清空。
  // [组A·HIGH-1 登记] 生产第 1 轮已不可达（新受理单受理即自动生成，恒非空——部署前已在 DEV 族且
  //   ETA 为空的存量单不适用，那些单没有"受理"这一步可触发自动生成），本清空只模拟"return/reopen
  //   清空后的第 2 轮"状态，断言只覆盖第 2 轮语义（第 1 轮 GATE 恒满足新行为见 verify-sys-eta-generation.js [H1]）。
  await run(`UPDATE sys_issues SET dev_estimated_at = NULL WHERE id = ?`, [id]);
  return id;
}

// 建一个「开发中 + 已指派」的 nf=1 feature 单，供 /feasibility 组使用（流程照搬
// verify-sys-feasibility-endpoints.js 的 seedToDev(1)）。
async function setupFeasibilityIssue(title, oaNumber) {
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'feature', title, system_name: 'BMS',
    source: '内部', description: '并发乐观锁 verify 夹具（nf=1）', intake_liaison_id: 13, needs_feasibility: 1,
  });
  assert.strictEqual(r.status, 201, `[夹具-F] 建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `[夹具-F] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: oaNumber });
  assert.strictEqual(r.status, 200, `[夹具-F] 补 OA 号应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-F] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  // [组A·2026-08-12] 同上（setupEstimateIssue 处已注）：清空自动生成的 dev_estimated_at，还原干净基线。
  // [组A·HIGH-1 登记] 生产第 1 轮已不可达（新受理单受理即自动生成，恒非空——部署前已在 DEV 族且
  //   ETA 为空的存量单不适用，那些单没有"受理"这一步可触发自动生成），本清空只模拟"return/reopen
  //   清空后的第 2 轮"状态，断言只覆盖第 2 轮语义（第 1 轮 GATE 恒满足新行为见 verify-sys-eta-generation.js [H1]）。
  await run(`UPDATE sys_issues SET dev_estimated_at = NULL WHERE id = ?`, [id]);
  return id;
}

async function estimateSnapshot(id) {
  return {
    row: await get('SELECT dev_estimated_at, estimated_effort_days FROM sys_issues WHERE id=?', [id]),
    tl: Number((await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate'`, [id])).c),
  };
}
async function feasibilitySnapshot(id) {
  return {
    row: await get('SELECT feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk, dev_estimated_at, estimated_effort_days FROM sys_issues WHERE id=?', [id]),
    tl: Number((await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility'`, [id])).c),
  };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ══════════════════════════ [S] /estimate 端点 ══════════════════════════
    const idS = await setupEstimateIssue('乐观锁-estimate-基线', '2026080101');
    const sBaseline = await estimateSnapshot(idS);
    assert.strictEqual(sBaseline.row.dev_estimated_at, null, '[S 前置] 刚指派单 dev_estimated_at 应为空');

    // S1 null↔null：调用方声明"我看到的是空"，现值确为空 → 通过（对照：不是恒真的宽松判断，S6 会证反向）
    const EST1 = futureEst(10);
    let r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST1, estimated_effort_days: 1, expected_dev_estimated_at: null });
    assert.strictEqual(r.status, 200, `[S1] null↔null 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let snap = await estimateSnapshot(idS);
    assert.strictEqual(snap.row.dev_estimated_at, EST1 + ':00', '[S1] 写入应生效（带秒）');
    ok('[S1] expected_dev_estimated_at=null 且现值确为空 → 200 通过（null↔null 视为相等）');

    // S2 expected 不符现值 → 409 ESTIMATE_STALE + 库值/timeline 零副作用（对照：不该写的确实没写）
    const before2 = await estimateSnapshot(idS);
    const EST2 = futureEst(11);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST2, estimated_effort_days: 1, expected_dev_estimated_at: '2020-01-01 00:00:00' });
    assert.strictEqual(r.status, 409, `[S2] expected 不符应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[S2] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const after2 = await estimateSnapshot(idS);
    assert.strictEqual(after2.row.dev_estimated_at, before2.row.dev_estimated_at, '[S2] 零副作用：库值未变');
    assert.strictEqual(after2.tl, before2.tl, '[S2] 零副作用：estimate timeline 未新增');
    ok('[S2] expected 与现值不符 → 409 ESTIMATE_STALE，库值与 timeline 均零副作用');

    // S3 expected 等于现值 → 200 正常写入（对照：真变更没被误拦——不是"传了 expected 就恒拒"）
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST2, estimated_effort_days: 1, expected_dev_estimated_at: EST1 + ':00' });
    assert.strictEqual(r.status, 200, `[S3] expected 等于现值应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    snap = await estimateSnapshot(idS);
    assert.strictEqual(snap.row.dev_estimated_at, EST2 + ':00', '[S3] 真变更应落新值');
    assert.strictEqual(snap.tl, before2.tl + 1, '[S3] 真变更应新增 1 条 estimate timeline');
    ok('[S3] expected 等于现值 → 200 正常写入，真变更未被误拦');

    // S4 不传 expected → 200（旧前端兼容，行为零变化——键不存在时整段跳过，无论现值是什么都不拦）
    const EST3 = futureEst(12);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST3, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, `[S4] 不传 expected 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    snap = await estimateSnapshot(idS);
    assert.strictEqual(snap.row.dev_estimated_at, EST3 + ':00', '[S4] 不传 expected 时正常写入（未被误拦）');
    ok('[S4] 不传 expected_dev_estimated_at（undefined）→ 200，兼容路径不误拦');

    // S5 类型闸：非 string/null → 400 VALIDATION + 零副作用（数字/数组两个反例）
    const before5 = await estimateSnapshot(idS);
    const EST4 = futureEst(13);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST4, estimated_effort_days: 1, expected_dev_estimated_at: 12345 });
    assert.strictEqual(r.status, 400, `[S5a] expected 传数字应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[S5a] 确切码 VALIDATION，实得 ${r.body.code}`);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST4, estimated_effort_days: 1, expected_dev_estimated_at: ['x'] });
    assert.strictEqual(r.status, 400, `[S5b] expected 传数组应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[S5b] 确切码 VALIDATION，实得 ${r.body.code}`);
    const after5 = await estimateSnapshot(idS);
    assert.strictEqual(after5.row.dev_estimated_at, before5.row.dev_estimated_at, '[S5] 零副作用：类型闸拒绝后库值未变');
    assert.strictEqual(after5.tl, before5.tl, '[S5] 零副作用：类型闸拒绝后 timeline 未新增');
    ok('[S5] expected_dev_estimated_at 非 string/null（数字/数组）→ 400 VALIDATION，零副作用');

    // S6 方向验证：现值非空 + expected=null → 视为不符 → 409（防"null 被当万能通配符"——与 S1 对照，
    //   证明"null 通过"是因为它真等于现值，不是 null 恒被放行）
    // [328a 回卷] 补完整零副作用 snapshot：原先只比对 dev_estimated_at 单字段，estimated_effort_days 与
    //   timeline 计数未纳入对照——若拒绝逻辑意外在 estimated_effort_days 或 timeline 上留了副作用，旧断言
    //   测不出。改用 deepStrictEqual(row) + tl 计数双重覆盖（同 S2/S5 已有写法对齐）。
    const before6 = await estimateSnapshot(idS);
    const EST5 = futureEst(14);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST5, estimated_effort_days: 1, expected_dev_estimated_at: null });
    assert.strictEqual(r.status, 409, `[S6] 现值非空+expected=null 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[S6] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const after6 = await estimateSnapshot(idS);
    assert.deepStrictEqual(after6.row, before6.row, '[S6] 零副作用：库值（dev_estimated_at+estimated_effort_days）全字段未变');
    assert.strictEqual(after6.tl, before6.tl, '[S6] 零副作用：estimate timeline 未新增');
    ok('[S6] 现值非空但 expected=null → 409 ESTIMATE_STALE（null 不是通配符，与 S1 对照证明方向性校验正确）——row 全字段+timeline 计数双重零副作用');

    // S7 真实双开发覆盖场景（复现背景缺陷→证明已修）：dev5 先提交，dev6 用同一份"打开弹窗时看到的值"
    //   提交应被拦（此时已过期），dev6 刷新后重提才放行——正是本次要堵的"后填静默覆盖先填"
    r = await call('POST', `/api/sys-issues/${idS}/reassign`, adminTok, { reason: 'verify 夹具：补第二个在册开发', member_ids: [5, 6] });
    assert.strictEqual(r.status, 200, `[S7 前置] reassign 补 dev6 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const curBeforeRace = (await estimateSnapshot(idS)).row.dev_estimated_at;   // dev5、dev6 打开弹窗时看到的同一份现值
    const EST6 = futureEst(15);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST6, estimated_effort_days: 1, expected_dev_estimated_at: curBeforeRace });
    assert.strictEqual(r.status, 200, `[S7a] dev5 先提交应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, dev2Tok, { dev_estimated_at: futureEst(16), estimated_effort_days: 1, expected_dev_estimated_at: curBeforeRace });
    assert.strictEqual(r.status, 409, `[S7b] dev6 用旧 expected 提交应被拦 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[S7b] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const refreshed = (await estimateSnapshot(idS)).row.dev_estimated_at;
    assert.strictEqual(refreshed, EST6 + ':00', '[S7b 前置] 库值应为 dev5 的提交（证明 dev6 确实没能覆盖）');
    const EST7 = futureEst(17);
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, dev2Tok, { dev_estimated_at: EST7, estimated_effort_days: 1, expected_dev_estimated_at: refreshed });
    assert.strictEqual(r.status, 200, `[S7c] dev6 刷新后重提应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[S7] ⭐ 真实双开发覆盖场景：dev5 提交后 dev6 用过期 expected 被 409 拦下（未静默覆盖）→ dev6 刷新后重提 200——复现并修复背景缺陷');

    // S8 排序钉死（Opus 预筛 MED-2）：stale 判定必须先于同值 no-op——新值与现值同分钟且工期不变（若走到
    //   no-op 会返回 200 {unchanged:true} 不写库不留痕），但 expected 已过期 → 必须 409 而非 200。
    //   活体判据：把 /estimate 的 expected 块整体挪到 no-op 之后，本组即翻红（"巧合同值"的并发覆盖会被
    //   no-op 掩盖成"什么都没发生"，正是实现注释里声称要防的形态——此前该声称零断言覆盖）。
    // [328a 回卷] S8 原先只钉了 dev_estimated_at 单字段的"前置值"，没有真正的 before/after 零副作用
    //   snapshot（既没比对 estimated_effort_days，也没比对 timeline 计数）。补齐后与 S2/S5/S6 同构：
    //   证明"stale 闸拦下"不只是"dev_estimated_at 没变"，是整行 + timeline 计数都没变——若拒绝逻辑意外在
    //   到达 no-op 分支之前就已经写了半步（比如误触发了工期字段的旁路更新），旧断言测不出。
    const before8 = await estimateSnapshot(idS);
    assert.strictEqual(before8.row.dev_estimated_at, EST7 + ':00', '[S8 前置] 现值应为 S7c 写入的 EST7 带秒形态');
    r = await call('POST', `/api/sys-issues/${idS}/estimate`, devTok, { dev_estimated_at: EST7, estimated_effort_days: 1, expected_dev_estimated_at: EST6 + ':00' });
    assert.strictEqual(r.status, 409, `[S8] 同分钟同工期+过期 expected 应 409（stale 先于 no-op），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[S8] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    assert.strictEqual(r.body.unchanged, undefined, '[S8] 不得返回 no-op 的 unchanged 标记（若出现说明先走到了 no-op 分支）');
    const after8 = await estimateSnapshot(idS);
    assert.deepStrictEqual(after8.row, before8.row, '[S8] 零副作用：库值（dev_estimated_at+estimated_effort_days）全字段未变（stale 判定先于 no-op，未落任何写入）');
    assert.strictEqual(after8.tl, before8.tl, '[S8] 零副作用：estimate timeline 未新增');
    ok('[S8] ⭐ 排序钉死：同值 no-op 前提下过期 expected 仍 409（stale 判定先于 no-op·防巧合同值掩盖并发覆盖）——row 全字段+timeline 计数双重零副作用');

    // ══════════════════════════ [F] /feasibility 端点（同款一组）══════════════════════════
    const idF = await setupFeasibilityIssue('乐观锁-feasibility-基线', '2026080102');
    const fBaseline = await feasibilitySnapshot(idF);
    assert.strictEqual(fBaseline.row.dev_estimated_at, null, '[F 前置] 刚指派单 dev_estimated_at 应为空');

    // F1 null↔null → 200
    const FE1 = futureEst(10);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: FE1, estimated_effort_days: 2, expected_dev_estimated_at: null,
    });
    assert.strictEqual(r.status, 200, `[F1] null↔null 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let fsnap = await feasibilitySnapshot(idF);
    assert.strictEqual(fsnap.row.dev_estimated_at, FE1 + ':00', '[F1] 写入应生效（带秒）');
    assert.strictEqual(fsnap.row.feasibility_conclusion, '可行', '[F1] conclusion 一并写入');
    ok('[F1] expected_dev_estimated_at=null 且现值确为空 → 200 通过');

    // F2 expected 不符 → 409 + 全字段零副作用（resubmission 全覆盖语境下更要证"半份都没写"）
    const fbefore2 = await feasibilitySnapshot(idF);
    const FE2 = futureEst(11);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '不可行', requirement_confirm: '改口', risk: '技术不支持', dev_estimated_at: FE2, estimated_effort_days: 3, expected_dev_estimated_at: '2020-01-01 00:00:00',
    });
    assert.strictEqual(r.status, 409, `[F2] expected 不符应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[F2] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const fafter2 = await feasibilitySnapshot(idF);
    assert.deepStrictEqual(fafter2.row, fbefore2.row, '[F2] 零副作用：五个评估字段全未变（resubmission 语义下更要证半份都没写）');
    assert.strictEqual(fafter2.tl, fbefore2.tl, '[F2] 零副作用：feasibility timeline 未新增');
    ok('[F2] expected 与现值不符 → 409 ESTIMATE_STALE，全部评估字段与 timeline 零副作用');

    // F3 expected 等于现值 → 200 正常写入（含 resubmission 全量覆盖，conclusion 也应随之改变）
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '有条件可行', requirement_confirm: '需求已复核', risk: '依赖外部接口', dev_estimated_at: FE2, estimated_effort_days: 3, expected_dev_estimated_at: FE1 + ':00',
    });
    assert.strictEqual(r.status, 200, `[F3] expected 等于现值应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    fsnap = await feasibilitySnapshot(idF);
    assert.strictEqual(fsnap.row.dev_estimated_at, FE2 + ':00', '[F3] 真变更应落新值');
    assert.strictEqual(fsnap.row.feasibility_conclusion, '有条件可行', '[F3] conclusion 应随 resubmission 覆盖');
    assert.strictEqual(fsnap.tl, fbefore2.tl + 1, '[F3] 真变更应新增 1 条 feasibility timeline');
    ok('[F3] expected 等于现值 → 200 正常写入，真变更（含 resubmission 覆盖）未被误拦');

    // F4 不传 expected → 200
    const FE3 = futureEst(12);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '再次确认', dev_estimated_at: FE3, estimated_effort_days: 4,
    });
    assert.strictEqual(r.status, 200, `[F4] 不传 expected 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    fsnap = await feasibilitySnapshot(idF);
    assert.strictEqual(fsnap.row.dev_estimated_at, FE3 + ':00', '[F4] 不传 expected 时正常写入（未被误拦）');
    ok('[F4] 不传 expected_dev_estimated_at（undefined）→ 200，兼容路径不误拦');

    // F5 类型闸 400 + 零副作用（对象/布尔两个反例）
    const fbefore5 = await feasibilitySnapshot(idF);
    const FE4 = futureEst(13);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '不可行', requirement_confirm: 'x5', risk: 'r5', dev_estimated_at: FE4, estimated_effort_days: 5, expected_dev_estimated_at: { foo: 1 },
    });
    assert.strictEqual(r.status, 400, `[F5a] expected 传对象应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[F5a] 确切码 VALIDATION，实得 ${r.body.code}`);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '不可行', requirement_confirm: 'x5', risk: 'r5', dev_estimated_at: FE4, estimated_effort_days: 5, expected_dev_estimated_at: true,
    });
    assert.strictEqual(r.status, 400, `[F5b] expected 传布尔应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[F5b] 确切码 VALIDATION，实得 ${r.body.code}`);
    const fafter5 = await feasibilitySnapshot(idF);
    assert.deepStrictEqual(fafter5.row, fbefore5.row, '[F5] 零副作用：类型闸拒绝后全部评估字段未变');
    assert.strictEqual(fafter5.tl, fbefore5.tl, '[F5] 零副作用：类型闸拒绝后 timeline 未新增');
    ok('[F5] expected_dev_estimated_at 非 string/null（对象/布尔）→ 400 VALIDATION，零副作用');

    // F6 方向验证：现值非空 + expected=null → 409
    // [328a 回卷] 补 timeline 计数比对：row 深比对已有，独缺 feasibility timeline 计数这一半（同 S6/S8 补齐理由）。
    const fbefore6 = await feasibilitySnapshot(idF);
    const FE5 = futureEst(14);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: 'x6', dev_estimated_at: FE5, estimated_effort_days: 6, expected_dev_estimated_at: null,
    });
    assert.strictEqual(r.status, 409, `[F6] 现值非空+expected=null 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[F6] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const fafter6 = await feasibilitySnapshot(idF);
    assert.deepStrictEqual(fafter6.row, fbefore6.row, '[F6] 零副作用：库值未变');
    assert.strictEqual(fafter6.tl, fbefore6.tl, '[F6] 零副作用：feasibility timeline 未新增');
    ok('[F6] 现值非空但 expected=null → 409 ESTIMATE_STALE（方向性校验对，与 F1 对照）——row 全字段+timeline 计数双重零副作用');

    // F7 真实双开发覆盖场景（与 S7 同构）
    r = await call('POST', `/api/sys-issues/${idF}/reassign`, adminTok, { reason: 'verify 夹具：补第二个在册开发', member_ids: [5, 6] });
    assert.strictEqual(r.status, 200, `[F7 前置] reassign 补 dev6 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const fCurBeforeRace = (await feasibilitySnapshot(idF)).row.dev_estimated_at;
    const FE6 = futureEst(15);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: 'dev5 先提交', dev_estimated_at: FE6, estimated_effort_days: 7, expected_dev_estimated_at: fCurBeforeRace,
    });
    assert.strictEqual(r.status, 200, `[F7a] dev5 先提交应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, dev2Tok, {
      conclusion: '可行', requirement_confirm: 'dev6 用旧值', dev_estimated_at: futureEst(16), estimated_effort_days: 8, expected_dev_estimated_at: fCurBeforeRace,
    });
    assert.strictEqual(r.status, 409, `[F7b] dev6 用旧 expected 提交应被拦 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[F7b] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    const fRefreshed = await feasibilitySnapshot(idF);
    assert.strictEqual(fRefreshed.row.dev_estimated_at, FE6 + ':00', '[F7b 前置] 库值应为 dev5 的提交（证明 dev6 确实没能覆盖）');
    const FE7 = futureEst(17);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, dev2Tok, {
      conclusion: '可行', requirement_confirm: 'dev6 刷新后重提', dev_estimated_at: FE7, estimated_effort_days: 9, expected_dev_estimated_at: fRefreshed.row.dev_estimated_at,
    });
    assert.strictEqual(r.status, 200, `[F7c] dev6 刷新后重提应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[F7] ⭐ 真实双开发覆盖场景：dev5 提交后 dev6 用过期 expected 被 409 拦下（未静默覆盖）→ dev6 刷新后重提 200——与 /estimate（S7）同构');

    // F8（328a 回卷新增）：同值提交（现值 FE7 下五个评估字段全部回显不变）+ 过期 expected → 409
    //   ESTIMATE_STALE，且不得有 unchanged 键——本端点本无同值 no-op 分支（resubmission 恒全量覆盖，
    //   §8.1 一带），故这一组不是"证 stale 判定排在 no-op 之前"（那是 S8 的事），而是对称钉死："即便
    //   请求体逐字段与现值完全相同、看起来什么都没改"，脏 expected 依然必须被拦——不能因为 UPDATE 会
    //   写出与现值相同的结果就误以为"反正没变化，放行也无妨"。五个评估字段 + timeline 计数全量比对
    //   （同 F2 的 resubmission 全覆盖语境理由：更要证"半份都没写"）。
    const f8Before = await feasibilitySnapshot(idF);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: f8Before.row.feasibility_conclusion,
      requirement_confirm: f8Before.row.feasibility_requirement_confirm,
      dev_estimated_at: FE7, estimated_effort_days: f8Before.row.estimated_effort_days,
      expected_dev_estimated_at: FE6 + ':00',   // 过期值：F7 系列已证这不是现值（现值是 FE7）
    });
    assert.strictEqual(r.status, 409, `[F8] 同值提交+过期 expected 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_STALE', `[F8] 确切码 ESTIMATE_STALE，实得 ${r.body.code}`);
    assert.strictEqual(r.body.unchanged, undefined, '[F8] 不得出现 unchanged 键（本端点本无该分支，纯粹防将来误加时忘记同步排除 stale 场景）');
    const f8After = await feasibilitySnapshot(idF);
    assert.deepStrictEqual(f8After.row, f8Before.row, '[F8] 零副作用：五个评估字段（结论/需求确认/风险/预计完成/工期）全未变');
    assert.strictEqual(f8After.tl, f8Before.tl, '[F8] 零副作用：feasibility timeline 未新增');
    ok('[F8] ⭐ 对称钉死：请求体字段与现值逐字相同（看似"没有变化"）+ 过期 expected → 409 ESTIMATE_STALE（本端点无 no-op 分支，UPDATE 前最后一道闸不因"值恰好相同"而网开一面）——五字段+timeline 计数双重零副作用');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代估时/评估两端点并发乐观锁 expected_dev_estimated_at 验收通过`);
  } finally {
    if (server) server.close();
    db.close();
  }
}

main().catch((e) => {
  console.error('\n❌ verify-sys-estimate-stale 失败:', e && (e.stack || e.message || e));
  if (server) server.close();
  db.close();
  process.exit(1);
});
