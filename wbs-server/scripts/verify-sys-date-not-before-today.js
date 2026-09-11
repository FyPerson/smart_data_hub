// 验证脚本：C1 —— deadline/planned_date「不早于今天」服务端硬拦（方案 20260910_v1.2 §5.5）
//   用法：node scripts/verify-sys-date-not-before-today.js
//
// 真实 HTTP 层验证（对齐 verify-sys-duty-roster.js 范式：真实 express app + http.Server + JWT 多角色夹具）。
//
// 覆盖：
//   [1] 6 写入点 × {昨天→400 对应码 / 今天→非该码 / 明天→非该码}
//   [2] deadline「今天已过去的时刻」（今天 00:01）→ 允许
//   [3] 反向保护：不拦 scheduled_start/duty_date/date_from（填昨天 → 200）——本 commit 最重要的负向保护
//   [4] edit-in-revision：预填过期 deadline、body 不带 deadline 只改标题 → 200（回归）
//   [5] 改期：旧值已过期+同值提交→200 no-op；清空→200；改成另一过去日期→400；改成今天→200
//   [6] 静态断言：normalizeDeadline/normalizeDeadlineDT 函数体不含新判据字样，行数不变
//   结尾输出 PASS n / FAIL m；跨零点（YESTERDAY/TODAY/TOMORROW 顶层常量与真实"今天"脱节）自动重跑一次
//   子进程（env C1_XMID_RETRY=1 标记），以子进程退出码为准；连续两次跨零点则 ABORT (exit 2)。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');

const SECRET = 'verify-sys-date-not-before-today-secret';
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发甲', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

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

// ── 动态日期生成（远期/近期字面量迟早失效，同 verify-sys-release.js futureEst 写法，勿回退硬编码）──────
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysFromToday(offset) { return ymd(new Date(Date.now() + offset * 86400000)); }
const YESTERDAY = daysFromToday(-1);
const TODAY = daysFromToday(0);
const TOMORROW = daysFromToday(1);
const TODAY_JUST_PAST_MINUTE = `${TODAY} 00:01`;   // 今天已过去的时刻（deadline 精确到分钟口径）

// [561-rec3] 统一收尾函数（同 verify-sys-release-overdue.js 的 finishWithCrossMidnightGuard 同款范式）：
//   正常收尾与异常捕获两条退出路径必须共用同一份跨零点判定，否则"main().catch(...) 直接 process.exit(1)"
//   这条异常出口会绕过重跑保护——若跑到一半真的跨零点又恰好在收尾前抛了别的异常，异常出口会把本该
//   "结果不可信、自动重跑"的这次运行错误地当成"真实失败"上报，两条退出路径不同构即是这里的缺口。
//   TODAY 是模块加载时算死的顶层常量（同 C1_XMID_RETRY 环境变量既有命名，不改名）。
function finishWithCrossMidnightGuard(exitCode) {
  try { server && server.close(); } catch (_) { /* 进程即将退出，尽力关闭 */ }
  try { db.close(); } catch (_) { /* :memory: 无文件句柄，尽力关闭 */ }
  const endDateStr = ymd(new Date());
  if (endDateStr === TODAY) {
    process.exit(exitCode);
  }
  if (process.env.C1_XMID_RETRY === '1') {
    console.log(`\n⛔ ABORT: 连续跨零点（开工日=${TODAY}，收尾日=${endDateStr}），重跑一次仍跨零点，放弃`);
    process.exit(2);
  }
  console.log(`\n⏭️  跨零点（开工日=${TODAY}，收尾日=${endDateStr}），结果不可信，自动重跑一次子进程…`);
  const child = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, C1_XMID_RETRY: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name} —— ${e && e.message}`); console.error(`  ✗ ${name} —— ${e && e.message}`); }
}

const futureEst = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 建单（默认落「待受理」；deadline 缺省不传）
async function createIssue(extra) {
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'feature', title: 'C1 fixture', system_name: 'BMS',
    source: '内部', description: 'C1「不早于今天」硬拦验证 fixture 建单', intake_liaison_id: 13,
    ...extra,
  });
  return r;
}

// 驱动一单到「开发中」+ dev_estimated_at 非空（供 set-scheduled-start 反向保护用例）
async function seedToDevWithEstimate() {
  let r = await createIssue({});
  assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026090001' });
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, `estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const row = await get('SELECT status, dev_estimated_at FROM sys_issues WHERE id=?', [id]);
  assert.strictEqual(row.status, '开发中', 'seed 后应为开发中');
  return id;
}

async function main() {
  // [Opus 预筛 L3 收口] YESTERDAY/TODAY/TOMORROW 是模块加载时算死的常量——若整套用例恰好跨零点运行
  //   （凌晨附近，耗时几秒的用例集合完整跑完时日历日已经翻篇），期间构造的数据与彼时的「今天」不再
  //   对应，会整片假红。收尾复算不一致就判定为跨零点，整体 SKIP（不计入 FAIL，非真实回归）——判定
  //   本身现收敛进 finishWithCrossMidnightGuard（[561-rec3]），直接对比模块级 TODAY 常量，不再需要
  //   在 main() 内单独存一份 startDateStr 别名。
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin','active',NULL,NULL),
    (5,'dev','开发甲','user','active',NULL,NULL),
    (13,'wangtaotao','示例对接人','user','active',NULL,NULL)`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  console.log('readiness ready + HTTP harness（admin1 / dev5 / 示例对接人13）');

  // ═══ [1-a] 写点 #1：POST /sys-issues 建单 deadline ═══
  await test('[#1 建单] deadline=昨天 → 400 DEADLINE_BEFORE_TODAY', async () => {
    const r = await createIssue({ deadline: YESTERDAY });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY');
  });
  await test('[#1 建单] deadline=今天 → 201（今天允许）', async () => {
    const r = await createIssue({ deadline: TODAY });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    // [Opus 预筛 M4 收口] 核库值——不能只断 201：若判据被改成"过期值静默置空放行"，状态码同样是 201，
    //   只有核对库内 deadline 确实落了传入值（经 normalizeDeadlineDT 补 :00 秒），才能抓到这类假绿。
    const row = await get('SELECT deadline FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.deadline, `${TODAY} 00:00:00`, `库内 deadline 应为传入值本身（经 normalizeDeadlineDT 规范化），实得 ${row.deadline}`);
  });
  await test('[#1 建单] deadline=明天 → 201', async () => {
    const r = await createIssue({ deadline: TOMORROW });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT deadline FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.deadline, `${TOMORROW} 00:00:00`, `库内 deadline 应为传入值本身，实得 ${row.deadline}`);
  });
  await test('[#1 建单] deadline=今天 00:01（今天已过去的时刻）→ 201（口径=日历日，非精确到分钟晚于当前时刻）', async () => {
    const r = await createIssue({ deadline: TODAY_JUST_PAST_MINUTE });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT deadline FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(row.deadline, `${TODAY} 00:01:00`, `库内 deadline 应为传入值本身（含分钟），实得 ${row.deadline}`);
  });

  // ═══ [1-b] 写点 #2：edit-in-revision（Tier A 态「待受理」直接可改 deadline）═══
  let editId;
  await test('[#2 edit-in-revision] fixture 建单（不传 deadline，落待受理）', async () => {
    const r = await createIssue({});
    assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
    editId = r.body.id;
  });
  await test('[#2 edit-in-revision] body.deadline=昨天 → 400 DEADLINE_BEFORE_TODAY', async () => {
    const r = await call('POST', `/api/sys-issues/${editId}/edit-in-revision`, adminTok, { deadline: YESTERDAY });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY');
  });
  await test('[#2 edit-in-revision] body.deadline=今天 → 200', async () => {
    const r = await call('POST', `/api/sys-issues/${editId}/edit-in-revision`, adminTok, { deadline: TODAY });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // [C1c-4 收口·codex 555 建议] 核库值，同 [#1 建单] 已补的写法。
    const row = await get('SELECT deadline FROM sys_issues WHERE id=?', [editId]);
    assert.strictEqual(row.deadline, `${TODAY} 00:00:00`, `库内 deadline 应为传入值本身，实得 ${row.deadline}`);
  });
  await test('[#2 edit-in-revision] body.deadline=明天 → 200', async () => {
    const r = await call('POST', `/api/sys-issues/${editId}/edit-in-revision`, adminTok, { deadline: TOMORROW });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT deadline FROM sys_issues WHERE id=?', [editId]);
    assert.strictEqual(row.deadline, `${TOMORROW} 00:00:00`, `库内 deadline 应为传入值本身，实得 ${row.deadline}`);
  });
  // 回归：预填过期 deadline（直接落库模拟历史脏值，绕开建单闸），body 不带 deadline 只改标题 → 200
  let editRegressionId;
  await test('[#2 edit-in-revision 回归] 预植过期 deadline（直接 SQL·模拟本闸上线前的历史单），只改标题不传 deadline → 200', async () => {
    const r = await createIssue({});
    assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
    editRegressionId = r.body.id;
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, [`${YESTERDAY} 10:00:00`, editRegressionId]);
    const r2 = await call('POST', `/api/sys-issues/${editRegressionId}/edit-in-revision`, adminTok, { title: '只改标题-不碰deadline' });
    assert.strictEqual(r2.status, 200, `期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const row = await get('SELECT deadline, title FROM sys_issues WHERE id=?', [editRegressionId]);
    assert.strictEqual(row.deadline, `${YESTERDAY} 10:00:00`, '过期 deadline 应原样保留（未被动）');
    assert.strictEqual(row.title, '只改标题-不碰deadline');
  });

  // ═══ [1-c] 写点 #3：scope-change（端点当前不可达，但日期校验发生在状态判定之前，可直接 HTTP 命中）═══
  let scopeChangeProbeId;
  await test('[#3 scope-change] fixture 建单（feature 类型·探测用，scope-change 对 feature 恒 409 SCOPE_CHANGE_DISABLED）', async () => {
    const r = await createIssue({});
    assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
    scopeChangeProbeId = r.body.id;
  });
  await test('[#3 scope-change] 校验顺序=本闸先于「状态/类型不可达」判定，deadline=昨天 → 400 DEADLINE_BEFORE_TODAY（先于 409 触发，实测确认，非按方案字面用例）', async () => {
    const r = await call('POST', `/api/sys-issues/${scopeChangeProbeId}/scope-change`, adminTok, { summary: 'C1 探测', deadline: YESTERDAY });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY');
  });
  await test('[#3 scope-change] deadline=今天 → 非 DEADLINE_BEFORE_TODAY（实际到达 409 SCOPE_CHANGE_DISABLED，因 fixture 是 feature 单）', async () => {
    const r = await call('POST', `/api/sys-issues/${scopeChangeProbeId}/scope-change`, adminTok, { summary: 'C1 探测', deadline: TODAY });
    assert.notStrictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY', `不应命中日期码, got ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.status, 409, `实测到达 409, got ${r.status} ${JSON.stringify(r.body)}`);
    // [C1c-5 收口·codex 555 M] 明确到达的是本用例真正想验证的目标出口（源码实测 index.js :14713：
    //   feature/improvement 类型守卫 → 409 SCOPE_CHANGE_DISABLED），不能只断"是 409"——其余任何撞巧
    //   409 的出口（如 CONCURRENT_SCOPE_CHANGE/SCOPE_STATUS_INVALID）也会被误判为通过。
    assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', `期望 SCOPE_CHANGE_DISABLED, got ${JSON.stringify(r.body)}`);
  });
  await test('[#3 scope-change] deadline=明天 → 非 DEADLINE_BEFORE_TODAY', async () => {
    const r = await call('POST', `/api/sys-issues/${scopeChangeProbeId}/scope-change`, adminTok, { summary: 'C1 探测', deadline: TOMORROW });
    assert.notStrictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY', `不应命中日期码, got ${JSON.stringify(r.body)}`);
    // [Opus 预筛 M2 收口] 照 [#3 今天] 同款收紧：不能只断"不是这个码"，须钉住确切到达的状态码（同
    //   fixture 是 feature 单，恒 409 SCOPE_CHANGE_DISABLED），否则 500/空体时 code 为 undefined 也照样绿。
    assert.strictEqual(r.status, 409, `实测到达 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', `期望 SCOPE_CHANGE_DISABLED, got ${JSON.stringify(r.body)}`);
  });

  // ═══ [1-d] 写点 #4：derive（前端无该控件，恒 undefined；但契约照加，API 直调可达，日期校验先于 origin 查询）═══
  await test('[#4 derive] deadline=昨天 → 400 DEADLINE_BEFORE_TODAY（校验先于 origin 存在性判定，用 id=99999 不存在的 origin 亦可命中）', async () => {
    const r = await call('POST', `/api/sys-issues/99999/derive`, adminTok, { title: 'derive-探测', system_name: 'BMS', source: '内部', deadline: YESTERDAY });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY');
  });
  await test('[#4 derive] deadline=今天 → 非 DEADLINE_BEFORE_TODAY（实际到达 origin 不存在的后续错误）', async () => {
    const r = await call('POST', `/api/sys-issues/99999/derive`, adminTok, { title: 'derive-探测', system_name: 'BMS', source: '内部', deadline: TODAY });
    assert.notStrictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY', `不应命中日期码, got ${JSON.stringify(r.body)}`);
    // [Opus 预筛 M2 收口] 钉住确切到达的状态码/错误码（源码实测 index.js :14927：origin 查无 → 404
    //   ORIGIN_NOT_FOUND），不能只断"不是这个码"。
    assert.strictEqual(r.status, 404, `期望 404, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ORIGIN_NOT_FOUND', `期望 ORIGIN_NOT_FOUND, got ${JSON.stringify(r.body)}`);
  });
  await test('[#4 derive] deadline=明天 → 非 DEADLINE_BEFORE_TODAY', async () => {
    const r = await call('POST', `/api/sys-issues/99999/derive`, adminTok, { title: 'derive-探测', system_name: 'BMS', source: '内部', deadline: TOMORROW });
    assert.notStrictEqual(r.body.code, 'DEADLINE_BEFORE_TODAY', `不应命中日期码, got ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.status, 404, `期望 404, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ORIGIN_NOT_FOUND', `期望 ORIGIN_NOT_FOUND, got ${JSON.stringify(r.body)}`);
  });

  // ═══ [1-e] 写点 #5：POST /sys-releases 建批次 planned_date ═══
  await test('[#5 建批次] planned_date=昨天 → 400 PLANNED_DATE_BEFORE_TODAY', async () => {
    const r = await call('POST', '/api/sys-releases', adminTok, { title: 'C1 批次', planned_date: YESTERDAY });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'PLANNED_DATE_BEFORE_TODAY');
  });
  await test('[#5 建批次] planned_date=今天 → 201', async () => {
    const r = await call('POST', '/api/sys-releases', adminTok, { title: 'C1 批次', planned_date: TODAY });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    // [C1c-4 收口·codex 555 建议] 核库值——normalizeDeadline 是纯日期校验器（不补时分），落库应恒等于传入值。
    const row = await get('SELECT planned_date FROM sys_releases WHERE id=?', [r.body.id]);
    assert.strictEqual(row.planned_date, TODAY, `库内 planned_date 应为传入值本身，实得 ${row.planned_date}`);
  });
  await test('[#5 建批次] planned_date=明天 → 201', async () => {
    const r = await call('POST', '/api/sys-releases', adminTok, { title: 'C1 批次', planned_date: TOMORROW });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT planned_date FROM sys_releases WHERE id=?', [r.body.id]);
    assert.strictEqual(row.planned_date, TOMORROW, `库内 planned_date 应为传入值本身，实得 ${row.planned_date}`);
  });

  // ═══ [1-f] 写点 #6：update-planned-date 改期 ═══
  let relId;
  await test('[#6 改期] fixture 建批次（直接 SQL 预植已过期 planned_date，模拟历史批次）', async () => {
    const r = await call('POST', '/api/sys-releases', adminTok, { title: 'C1 改期 fixture' });
    assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
    relId = r.body.id;
    await run(`UPDATE sys_releases SET planned_date = ? WHERE id = ?`, [YESTERDAY, relId]);
  });
  await test('[#6 改期] 旧值已过期，同值提交 → 200 no-op（changed=false，不触发日期闸，防回归头号用例）', async () => {
    const r = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: YESTERDAY });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, false, 'no-op 应 changed=false');
  });
  await test('[#6 改期] 清空（不传 planned_date）→ 200，changed=true', async () => {
    // [C4·B 块] fixture 旧值 YESTERDAY 已过期 + 本次是真实变更（清空）——命中 C4 逾期理由闸，须带 reason
    // （方案 §5.2.2「清空也算变更」）。本文件只验 F 块「不早于今天」硬拦，理由闸细节见
    // verify-sys-release-date-change.js，这里按新契约补最小必要的 reason 让用例继续验证 F 块本身。
    const r = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { reason: 'C1 fixture 清空（C4 理由闸最小必要输入）' });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, true);
    assert.strictEqual(r.body.planned_date, null);
  });
  await test('[#6 改期] 从空改成另一过去日期 → 400 PLANNED_DATE_BEFORE_TODAY', async () => {
    const anotherPast = daysFromToday(-2);
    const r = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: anotherPast });
    assert.strictEqual(r.status, 400, `期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'PLANNED_DATE_BEFORE_TODAY');
    const row = await get('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
    assert.strictEqual(row.planned_date, null, '400 拒绝后不应写库（仍为清空后的 null）');
  });
  await test('[#6 改期] 改成今天 → 200', async () => {
    const r = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: TODAY });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, true);
    assert.strictEqual(r.body.planned_date, TODAY);
    // [C1c-4 收口·codex 555 建议] 核库值——响应体字段与库内真实值不是同一份证据，须各自核对。
    const row = await get('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
    assert.strictEqual(row.planned_date, TODAY, `库内 planned_date 应为传入值本身，实得 ${row.planned_date}`);
  });
  // [C1c-3 收口·codex 555 M] 补「改成明天 → 200」——此前六写点的"昨天/今天/明天"三态证据描述里改期
  //   端点只覆盖了昨天(400)/今天(200)，缺明天这一态，与「六写点均覆盖昨天/今天/明天」的说法不对齐。
  await test('[#6 改期] 改成明天 → 200', async () => {
    const r = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: TOMORROW });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, true);
    assert.strictEqual(r.body.planned_date, TOMORROW);
    const row = await get('SELECT planned_date FROM sys_releases WHERE id=?', [relId]);
    assert.strictEqual(row.planned_date, TOMORROW, `库内 planned_date 应为传入值本身，实得 ${row.planned_date}`);
  });

  // ═══ [2] 反向保护（本 commit 最重要用例）：不拦 scheduled_start/duty_date/date_from ═══
  await test('[反向] set-scheduled-start 填昨天 → 200（不拦，normalizeDeadline 未被本次改动收紧）', async () => {
    const id = await seedToDevWithEstimate();
    const r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: YESTERDAY });
    assert.strictEqual(r.status, 200, `期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.scheduled_start, YESTERDAY);
  });
  await test('[反向] POST /sys-duty-roster duty_date 昨天 → 201（不拦，补录历史值真实场景）', async () => {
    const r = await call('POST', '/api/sys-duty-roster', liaisonTok, { duty_date: YESTERDAY, user_id: 5 });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
  });
  await test('[反向] POST /sys-duty-roster-batch date_from 昨天 → 201（不拦）', async () => {
    const r = await call('POST', '/api/sys-duty-roster-batch', liaisonTok, {
      date_from: daysFromToday(-5), date_to: daysFromToday(-3), user_id: 5, note: 'C1 反向保护探测',
    });
    assert.strictEqual(r.status, 201, `期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // ═══ [3] 静态断言：normalizeDeadline / normalizeDeadlineDT 函数体不含新判据字样 ═══
  await test('[静态] normalizeDeadline 函数体不含 BEFORE_TODAY 字样（禁塞进公共校验器，C0 核查报告 ⑦-b 红线）', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const m = src.match(/function normalizeDeadline\(raw\) \{[\s\S]*?\n  \}\n\n  \/\/ ── ② 期望完成精确到时分/);
    assert.ok(m, 'normalizeDeadline 函数体锚点匹配失败（源码结构变化，需更新本断言锚点）');
    const body = m[0];
    assert.ok(!/BEFORE_TODAY/.test(body), `normalizeDeadline 函数体不应含 BEFORE_TODAY 字样，实际命中: ${body}`);
    const lineCount = body.split('\n').length;
    assert.strictEqual(lineCount, 13, `normalizeDeadline 函数体+尾随锚点行数应为当前基线 13（本轮 grep 实测），实得 ${lineCount}——若因后续改动变化需人工复核是否误入函数体`);
  });
  await test('[静态] normalizeDeadlineDT 函数体不含 BEFORE_TODAY 字样', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const m = src.match(/function normalizeDeadlineDT\(raw\) \{[\s\S]*?\n  \}\n\n  \/\/ ── C1·「不早于今天」硬拦判据/);
    assert.ok(m, 'normalizeDeadlineDT 函数体锚点匹配失败（源码结构变化，需更新本断言锚点）');
    const body = m[0];
    assert.ok(!/BEFORE_TODAY/.test(body), `normalizeDeadlineDT 函数体不应含 BEFORE_TODAY 字样，实际命中: ${body}`);
    const lineCount = body.split('\n').length;
    assert.strictEqual(lineCount, 25, `normalizeDeadlineDT 函数体+尾随锚点行数应为当前基线 25（本轮 grep 实测），实得 ${lineCount}——若因后续改动变化需人工复核是否误入函数体`);
    // [Opus 预筛 L2 收口] 防判据以"替换式塞进 DT"的方式违反红线（不新增独立函数，直接魔改 DT 本体
    //   变成异步/调用 dbGetAsync）——normalizeDeadlineDT 必须保持纯同步纯函数，不依赖 db 查询。
    assert.ok(!/dbGetAsync|await /.test(body), 'normalizeDeadlineDT 应保持纯同步函数（不应出现 dbGetAsync/await，防判据被改名后原地塞入）');
  });

  // [C1c-2 收口·codex 555 M / 561-rec3 改用统一收尾函数] 收尾复算日历日：与开工时不一致 = 本轮运行跨
  //   了零点，用例里散布的 YESTERDAY/TODAY/TOMORROW 字面量在跑的过程中已与真实"今天"脱节，结果不可信。
  //   ⚠️ 不能无条件 exit(0)——那会把本轮的真实失败（静态断言/权限错等）一起吞掉，制造假绿；也不能各
  //   退出路径各写一份判定——finishWithCrossMidnightGuard 关服务/关库 + 跨零点判定 + 子进程重跑/ABORT
  //   全部收敛到一处，正常收尾与下方 main().catch 异常出口共用同一份逻辑，不再各自为政。
  console.log(`\n${failed === 0 ? '✅' : '❌'} PASS ${passed} / FAIL ${failed}`);
  finishWithCrossMidnightGuard(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 验证脚本自身异常:', e && e.stack || e);
  // [561-rec3] 异常出口不再直接 process.exit(1)——改走同一份 finishWithCrossMidnightGuard，异常发生时
  // 若恰好也跨了零点，同样按"结果不可信"处理（自动重跑一次子进程），不与正常收尾路径分裂成两套判据。
  finishWithCrossMidnightGuard(1);
});
