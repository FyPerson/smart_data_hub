// scripts/verify-sys-eta-generation.js — 系统迭代·组 A「预计完成时间自动生成 + 超时受理/超时指派强制填写」验收
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §2（组 A）
//   用法：node scripts/verify-sys-eta-generation.js
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [P] computeSysDefaultEta 纯函数用例表——15:00:00 边界（14:59:59/15:00:00 两侧）+ 周一~周日全 7 天
//       weekday 边界（周三→当周五 / 周四→下周五）。不依赖 HTTP，直调 I.computeSysDefaultEta。
//   [M] §2.2 受理分支双维度矩阵六格——每格独立造一张全新 bug 单（created_at 可控），调用真实
//       POST /intake-accept，断言响应体 eta 字段 + 库内 dev_estimated_at + timeline.summary 三件套。
//   [M7]【回炉纠偏，2026-08-12 主会话裁定】/assign 超时指派——ETA 来自真实受理链路（POST /intake-accept
//       自动生成，非手写字面量）+ DB 置过期模拟拖延（[LOW-7] 如实登记：本组仍含一步直接 DB UPDATE，
//       不是"全程零 DB 干预"的纯端到端场景，只是与 [M1]-[M6] 相比，ETA 本身的产出方式不同——[M1]-[M6]
//       连 ETA 起点也是手工造的库内状态，本组的起点是真实调用受理接口的产物）：
//       受理自动生成 ETA → 模拟指派被拖延到 ETA 目标之后 → /assign 不带新值 400 ASSIGN_ESTIMATE_REQUIRED
//       零副作用 / 带未来值 200+写入+timeline"超时指派"+真实指派落地；成对对照＝ETA 未过期时不要求必填。
//       与 [M1]-[M6]（直接造态验证分支逻辑本身）互补，证明"真实链路会不会走到这个分支"。
//   [R] §2.3 超时指派——/reassign 端点：不填 400 REASSIGN_ESTIMATE_REQUIRED / 填过去时刻 400
//       ESTIMATE_MUST_BE_FUTURE / 填未来时刻 200 + timeline 新增一行 + 库值更新。
//   [D] ETA 早于 assigned_at 合法性——① 受理时 assigned_at 仍为 NULL，ETA 照常生成成功（结构性证明
//       "从不读 assigned_at"）；② 构造 ETA < assigned_at 的库内状态，GET 详情端点不拒绝（无隐藏校验）。
//   [N] 服务端必填值晚于当前时刻校验负例——intake-accept forced-fill 分支同款负例（与 [R] 的 reassign
//       负例对称，两个写点都要各自证明，不能只证一个就假设另一个"应该也对"）。
//   [H1]【回炉纠偏·HIGH-1 登记接受】GATE（isGateEligibleForVerify/submit ESTIMATE_REQUIRED/
//       set-scheduled-start）第 1 轮恒满足 vs 第 2 轮恢复原语义成对断言：受理自动生成 ETA 后直接
//       submit 不再 400；return 清空 ETA 后未重填 submit 仍 400。
//   [MED-1/MED-5/MED-2·显式输入生效 + 口径收窄成对用例，2026-08-12 SA-fix2 修复批2 改造]（分散在
//       [M1-填值]/[M5-填值]/[M6-填值]/[M7-填值]/[M7-填值-NULL]/[R-填值-NULL]/[R-填值] 七处，各自紧邻
//       对照组）：受理/assign/reassign 三端点选填 ETA 输入统一新规则——**现值 IS NULL**（首次设定）
//       时用户值优先生效（[M1-填值]/[M7-填值-NULL]/[R-填值-NULL]）；**现值非空且未过期**时一律显式
//       拒绝 409 ETA_NOT_EXPIRED（[M5-填值]/[M6-填值]/[M7-填值]/[R-填值]，此前四处均是静默丢弃或误当
//       "用户值优先"接受，本次口径收窄拍板统一改为显式拒绝）；过期分支（必填强制重填）不变。
//   [HIGH-1·必修，同批]（[R-填值-NULL]）：/reassign 的 ETA 值级 CAS 由 `= ?` 改 `IS ?`（SQLite NULL
//       安全比较）——旧写法在既有值为 NULL 时（打回/liaison_test_return/reopen 均会清空 ETA）恒不
//       匹配，误报 409 CONCURRENT_STATE_CHANGE，堵死"打回后改派填值=合法人工设定"路径；用真实
//       /return 而非 DB 直接置空来触发，证明的是真实业务链路而非纯造态。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-eta-generation-secret';
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, headers: {
        'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ verify-sys-eta-generation 失败: ' + msg); process.exit(1); }

// ── 通用时间 helper（同既有 verify-sys-* 惯例：日期炸弹教训，动态生成不硬编码未来/过去字面量）────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmt(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`; }
function addMinutes(dt, m) { return new Date(dt.getTime() + m * 60000); }
function addDays(dt, d) { const c = new Date(dt); c.setDate(c.getDate() + d); return c; }
// datetime-local 格式（前端等价，供 dev_estimated_at 请求体用）：'YYYY-MM-DD HH:MM'
function fmtLocalNoSec(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }

let seq = 0;
async function mkIssue(type, createdAt, extra = {}) {
  seq++;
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `ETA-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-eta-generation 夹具', intake_liaison_id: 13, ...extra,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  if (createdAt) {
    await run(`UPDATE sys_issues SET created_at = ? WHERE id = ?`, [createdAt, id]);
  }
  return id;
}
async function issueRow(id) {
  return get('SELECT status, dev_estimated_at, deadline, assigned_at, created_at FROM sys_issues WHERE id=?', [id]);
}
async function latestTimeline(id) {
  return get(`SELECT summary, event_type, action_code FROM sys_issue_timeline WHERE issue_id=? ORDER BY id DESC LIMIT 1`, [id]);
}
async function timelineCount(id) {
  return Number((await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id])).c);
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
  ok('in-process app 启动 + readiness ready + seed users（admin1 / 受理人13 / dev5,6）');

  // ══════════════════════════ [P] computeSysDefaultEta 纯函数用例表 ══════════════════════════
  assert.strictEqual(typeof I.computeSysDefaultEta, 'function', '[P 前置] computeSysDefaultEta 应已导出');

  // [P1] bug 15:00:00 边界——14:59:59 当天 / 15:00:00 次日（含跨月对照，防"次日"只是简单 +1 数字未处理进位）
  {
    assert.strictEqual(I.computeSysDefaultEta('2026-08-12 14:59:59', 'bug'), '2026-08-12 17:00:00',
      '[P1a] bug 14:59:59 创建 → 当天 17:00:00');
    assert.strictEqual(I.computeSysDefaultEta('2026-08-12 15:00:00', 'bug'), '2026-08-13 17:00:00',
      '[P1b] bug 15:00:00 创建（边界含）→ 次日 17:00:00');
    assert.strictEqual(I.computeSysDefaultEta('2026-08-12 15:00:01', 'bug'), '2026-08-13 17:00:00',
      '[P1c] bug 15:00:01 创建 → 次日 17:00:00（边界之后同归次日档，非只有整点才生效）');
    assert.strictEqual(I.computeSysDefaultEta('2026-08-31 15:30:00', 'bug'), '2026-09-01 17:00:00',
      '[P1d] ⭐ 跨月边界：8/31 15:30 创建 → 9/1 17:00（"次日"须真走日历进位，非月末简单 +1 崩掉）');
    assert.strictEqual(I.computeSysDefaultEta('2026-12-31 15:30:00', 'bug'), '2027-01-01 17:00:00',
      '[P1e] ⭐ 跨年边界：12/31 15:30 创建 → 次年 1/1 17:00');
    ok('[P1] bug 类型 15:00:00 边界（14:59:59 当天 / 15:00:00 边界含 / 15:00:01 次日 / 跨月 / 跨年）全部锁定');
  }

  // [P2] 非 bug 类型 7 天 weekday 全覆盖——周一~周三→当周五 17:00；周四~周日→下周五 17:00。
  //   动态取一个真实的"本周一"作参照（不硬编码某个具体日期，避免日期炸弹），再逐天验证。
  {
    const today = new Date();
    const todayDow = today.getDay();   // 0=周日..6=周六
    const isoDowToday = ((todayDow + 6) % 7) + 1;   // 1=周一..7=周日
    const monday = addDays(today, -(isoDowToday - 1));   // 本周一 00:00 附近
    monday.setHours(9, 0, 0, 0);
    const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    // 索引0=周一..6=周日，值=目标周五相对"本周一参照"的天数偏移（非相对创建日自身的偏移——周一/周二/周三
    // 三天目标是**同一个**日历日「当周五」=Mon+4，周四~周日四天目标是**同一个**日历日「下周五」=Mon+11）。
    const expectedOffsetFromMonday = [4, 4, 4, 11, 11, 11, 11];
    for (let i = 0; i < 7; i++) {
      const created = addDays(monday, i);
      const createdStr = fmt(created);
      const got = I.computeSysDefaultEta(createdStr, 'improvement');
      const expectedDate = addDays(monday, expectedOffsetFromMonday[i]);
      const expected = `${expectedDate.getFullYear()}-${pad2(expectedDate.getMonth() + 1)}-${pad2(expectedDate.getDate())} 17:00:00`;
      assert.strictEqual(got, expected, `[P2-${dayNames[i]}] ${createdStr}（${dayNames[i]}）创建 → 期望 ${expected}，实得 ${got}`);
    }
    ok(`[P2] 非 bug 类型全 7 天 weekday 覆盖：周一~周三→当周五 17:00、周四~周日→下周五 17:00（以本周一 ${fmt(monday)} 为动态参照，不硬编码具体日期）`);
    // ★对照组：周三→周四跨界必须真的切到"下周五"而非仍取"本周五"（防 offset 表被改错却测不出——
    //   周三 offset=2、周四 offset=8，两者差 6 天，若表被误改成周四=1（即"当周五"），本断言会先于上面
    //   循环判红；这里单独复算一遍加固，形成"表内自洽 + 独立复算"双重证据）。
    const wed = addDays(monday, 2), thu = addDays(monday, 3);
    const wedEta = I.computeSysDefaultEta(fmt(wed), 'feature');
    const thuEta = I.computeSysDefaultEta(fmt(thu), 'feature');
    const sameFriday = addDays(monday, 4);
    const nextFriday = addDays(monday, 11);
    assert.strictEqual(wedEta, `${sameFriday.getFullYear()}-${pad2(sameFriday.getMonth() + 1)}-${pad2(sameFriday.getDate())} 17:00:00`, '[P2-对照] 周三→当周五');
    assert.strictEqual(thuEta, `${nextFriday.getFullYear()}-${pad2(nextFriday.getMonth() + 1)}-${pad2(nextFriday.getDate())} 17:00:00`, '[P2-对照] 周四→下周五（与周三差 7 天，非当周）');
    ok('[P2-对照] 周三/周四边界独立复算：两天目标相差恰好 7 天（当周五 vs 下周五），非"当周五"重复值');
  }

  // ══════════════════════════ [M] §2.2 受理分支双维度矩阵六格（真实 HTTP，bug 类型）══════════════════════════
  //   两维度：①既有 ETA 是否过期（非空∧≤now）②默认 SLA 是否已超（受理时刻≥默认值）。
  //   "SLA 未超"构造：created_at=NOW（该算法性质保证 defaultEta(now) 恒 ≥ now，见方案头部注释推导）。
  //   "SLA 已超"构造：created_at=远古日期（默认目标早已成为过去）。
  const FAR_PAST_CREATED = '2020-01-01 08:00:00';   // bug 类型：2020-01-02 17:00 早已过去，稳定判"已超"
  const nowStrForFixture = () => fmt(new Date());

  // [M1] 为空 × SLA未超 → 自动生成默认值，不通知，无需人工填写
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M1] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.ok(eta && eta.auto_generated === true, `[M1] 响应 eta.auto_generated 应为 true，实得 ${JSON.stringify(eta)}`);
    assert.strictEqual(eta.overdue_intake, false, '[M1] 非超时受理');
    assert.strictEqual(eta.notify_estimate, false, '[M1] 自动生成不触发通知（C11：系统动作无可归责的人）');
    const row = await issueRow(id);
    assert.ok(row.dev_estimated_at, `[M1] 库内 dev_estimated_at 应已写入，实得 ${row.dev_estimated_at}`);
    assert.strictEqual(row.dev_estimated_at, eta.dev_estimated_at, '[M1] 库内值与响应值一致');
    const tl = await latestTimeline(id);
    assert.ok(tl && tl.summary && tl.summary.includes('自动生成'), `[M1] timeline.summary 应含"自动生成"，实得 ${JSON.stringify(tl)}`);
    ok(`[M1] 为空×SLA未超 → 自动生成 ${row.dev_estimated_at}，timeline 记"自动生成"，不通知`);
  }

  // [M1-填值]【MED-1/MED-5·成对对照】为空×SLA未超格，若受理弹窗当场显式提供了值 → 用户值优先，
  //   不落自动生成；与 [M1] 的"留空"分支成对（同一格两种输入的两种行为，互为对照）。
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const userVal = fmtLocalNoSec(addDays(new Date(), 6));   // 刻意选一个明显不等于默认 SLA 目标的值
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: userVal });
    assert.strictEqual(r.status, 200, `[M1-填值] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.strictEqual(eta.auto_generated, false, '[M1-填值] 用户显式提供值时不应标记为自动生成');
    assert.strictEqual(eta.notify_estimate, true, '[M1-填值] 人工设定视为真实决定，需通知（与其余人工路径同口径）');
    const row = await issueRow(id);
    const defaultEta = I.computeSysDefaultEta(row.created_at, 'bug');
    assert.notStrictEqual(row.dev_estimated_at, defaultEta, '[M1-填值] ⭐ 库内值应是用户值，不是默认 SLA 算出的值（证明真的没有被自动生成盖过）');
    assert.strictEqual(row.dev_estimated_at, `${userVal}:00`, `[M1-填值] 库内值应精确等于用户提交的值（补秒），实得 ${row.dev_estimated_at}`);
    const tl = await latestTimeline(id);
    assert.ok(tl && tl.summary && tl.summary.includes('人工设定') && !tl.summary.includes('自动生成'),
      `[M1-填值] timeline.summary 应含"人工设定"、不含"自动生成"，实得 ${JSON.stringify(tl)}`);
    ok('[M1-填值] ⭐【MED-1/MED-5】为空×SLA未超格用户显式填值 → 用户值优先写入（非默认 SLA 值），timeline 记"人工设定"，需通知——与 [M1] 留空分支成对');
  }

  // [M2] 为空 × SLA已超 → 弹窗必填（不填 400，填未来值 200+timeline+通知标记）
  {
    const id = await mkIssue('bug', FAR_PAST_CREATED);
    // 建单本身即写 1 条 event_type='created' 的 timeline 行（实测钉死，非假设）——后续零副作用/新增判定
    // 一律用这个基线做差量比较，不裸断言绝对计数。
    const baseTl = await timelineCount(id);
    // 反例：不填 → 400 INTAKE_ESTIMATE_REQUIRED + 零副作用
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 400, `[M2-反] 不填应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_ESTIMATE_REQUIRED', `[M2-反] code 应为 INTAKE_ESTIMATE_REQUIRED，实得 ${r.body.code}`);
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, null, '[M2-反] 零副作用：dev_estimated_at 未落库');
    assert.strictEqual(row.status, '待受理', '[M2-反] 零副作用：status 未变（整个事务回滚，非部分提交）');
    assert.strictEqual(await timelineCount(id), baseTl, '[M2-反] 零副作用：拒绝未新增任何 timeline 行（与建单时的基线相比）');
    // 正例：填未来值 → 200 + 写入 + timeline"超时受理" + notify_estimate=true
    const futureVal = fmtLocalNoSec(addDays(new Date(), 3));
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: futureVal });
    assert.strictEqual(r.status, 200, `[M2-正] 填未来值应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.strictEqual(eta.auto_generated, false, '[M2-正] 非自动生成');
    assert.strictEqual(eta.overdue_intake, true, '[M2-正] 超时受理标记');
    assert.strictEqual(eta.notify_estimate, true, '[M2-正] 人工填写须变化时通知建单人');
    row = await issueRow(id);
    assert.ok(row.dev_estimated_at, '[M2-正] 库内已写入');
    const tl = await latestTimeline(id);
    assert.ok(tl.summary.includes('超时受理'), `[M2-正] timeline 应含"超时受理"，实得 ${JSON.stringify(tl)}`);
    ok('[M2] 为空×SLA已超 → 弹窗必填：不填 400 INTAKE_ESTIMATE_REQUIRED 零副作用；填未来值 200+写入+timeline"超时受理"+notify_estimate');
  }

  // [M3] 非空且已过期 × SLA未超 → 弹窗必填新值（"原预计完成时间已过期"）+覆盖留痕，SLA 未超故 overdue_intake=false
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const expiredVal = fmt(addMinutes(new Date(), -30));   // 30 分钟前，已过期
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);
    // 反例：不填 → 400
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 400, `[M3-反] 不填应 400，实得 ${r.status}`);
    assert.strictEqual(r.body.code, 'INTAKE_ESTIMATE_REQUIRED', '[M3-反] code 应为 INTAKE_ESTIMATE_REQUIRED');
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, expiredVal, '[M3-反] 零副作用：原过期值未被动');
    // 正例：填未来值 → 200 覆盖 + 留痕含原值
    const futureVal = fmtLocalNoSec(addDays(new Date(), 2));
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: futureVal });
    assert.strictEqual(r.status, 200, `[M3-正] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.strictEqual(eta.eta_overwritten, true, '[M3-正] 覆盖标记');
    assert.strictEqual(eta.overdue_intake, false, '[M3-正] SLA 未超，不叠加"超时受理"');
    assert.strictEqual(eta.notify_estimate, true, '[M3-正] 覆盖仍需通知');
    row = await issueRow(id);
    assert.notStrictEqual(row.dev_estimated_at, expiredVal, '[M3-正] 库内值已被新值覆盖');
    const tl = await latestTimeline(id);
    assert.ok(tl.summary.includes('已过期'), `[M3-正] timeline 应含"已过期"字样，实得 ${JSON.stringify(tl)}`);
    assert.ok(!tl.summary.includes('超时受理'), `[M3-正] SLA 未超时 timeline 不应含"超时受理"，实得 ${JSON.stringify(tl)}`);
    ok('[M3] 非空且已过期×SLA未超 → 弹窗必填新值+覆盖留痕含原值，不叠加"超时受理"');
  }

  // [M4] 非空且已过期 × SLA已超 → 弹窗必填新值，且 timeline 同时记"超时受理"
  {
    const id = await mkIssue('bug', FAR_PAST_CREATED);
    const expiredVal = fmt(addMinutes(new Date(), -30));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);
    // 反例：填过去时刻 → 400 ESTIMATE_MUST_BE_FUTURE（[N] 组的姊妹负例，同一入口两种非法输入都要各自证）
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: fmtLocalNoSec(addMinutes(new Date(), -5)) });
    assert.strictEqual(r.status, 400, `[M4-反] 填过去时刻应 400，实得 ${r.status}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_MUST_BE_FUTURE', `[M4-反] code 应为 ESTIMATE_MUST_BE_FUTURE，实得 ${r.body.code}`);
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, expiredVal, '[M4-反] 零副作用：原过期值未被动（防"格式合法但不够未来"绕过必填闸）');
    // 正例：填未来值 → 200，timeline 同时含"已过期"与"超时受理"
    const futureVal = fmtLocalNoSec(addDays(new Date(), 1));
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: futureVal });
    assert.strictEqual(r.status, 200, `[M4-正] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.strictEqual(eta.eta_overwritten, true, '[M4-正] 覆盖标记');
    assert.strictEqual(eta.overdue_intake, true, '[M4-正] SLA 已超，叠加"超时受理"');
    const tl = await latestTimeline(id);
    assert.ok(tl.summary.includes('已过期') && tl.summary.includes('超时受理'), `[M4-正] timeline 应同时含"已过期"与"超时受理"，实得 ${JSON.stringify(tl)}`);
    ok('[M4] 非空且已过期×SLA已超 → 弹窗必填新值；填过去时刻仍 400 零副作用；填未来值 200 且 timeline 同时记"已过期"+"超时受理"');
  }

  // [M5] 非空且未过期 × SLA已超 → 不生成不覆盖，仍记 timeline"超时受理"（无需人工填写，无通知）
  {
    const id = await mkIssue('bug', FAR_PAST_CREATED);
    const futureVal = fmt(addDays(new Date(), 5));   // 未过期
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});   // 不填也应放行——本格不要求人工填写
    assert.strictEqual(r.status, 200, `[M5] 不填也应 200（本格非"必填"），实得 ${r.status} ${JSON.stringify(r.body)}`);
    const eta = r.body.eta;
    assert.strictEqual(eta.auto_generated, false, '[M5] 未生成');
    assert.strictEqual(eta.eta_overwritten, false, '[M5] 未覆盖');
    assert.strictEqual(eta.overdue_intake, true, '[M5] 仍标记超时受理');
    assert.strictEqual(eta.notify_estimate, false, '[M5] 值未变，不通知');
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[M5] 库内值原样保留（不生成不覆盖）');
    const tl = await latestTimeline(id);
    assert.ok(tl.summary.includes('超时受理'), `[M5] timeline 应含"超时受理"，实得 ${JSON.stringify(tl)}`);
    assert.ok(!tl.summary.includes('已过期'), `[M5] 未过期不应出现"已过期"字样，实得 ${JSON.stringify(tl)}`);
    ok('[M5] 非空且未过期×SLA已超 → 不生成不覆盖，值原样保留，timeline 仍记"超时受理"，无需人工填写、不通知');
  }

  // [M5-填值]【MED-2·口径收窄新对照】非空且未过期×SLA已超格，若显式提供了新值 → 显式拒绝 409
  //   ETA_NOT_EXPIRED（不再静默丢弃）——与 [M5] 的"不填"分支成对（同一格两种输入的两种行为）。
  {
    const id = await mkIssue('bug', FAR_PAST_CREATED);
    const futureVal = fmt(addDays(new Date(), 5));   // 未过期
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const baseTl = await timelineCount(id);
    const attemptVal = fmtLocalNoSec(addDays(new Date(), 8));   // 明显不同于现值，证明确未生效
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: attemptVal });
    assert.strictEqual(r.status, 409, `[M5-填值] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_NOT_EXPIRED', `[M5-填值] code 应为 ETA_NOT_EXPIRED，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[M5-填值] 零副作用：ETA 未变（未被 attemptVal 覆盖）');
    assert.strictEqual(row.status, '待受理', '[M5-填值] 零副作用：status 未变');
    assert.strictEqual(await timelineCount(id), baseTl, '[M5-填值] 零副作用：无新增 timeline 行（整个请求回滚，非"接受但不记"）');
    ok('[M5-填值] ⭐【MED-2】非空且未过期×SLA已超格显式提供新值 → 409 ETA_NOT_EXPIRED 零副作用，与 [M5] 不填分支成对（此前静默丢弃，现改显式拒绝）');
  }

  // [M6] 非空且未过期 × SLA未超 → 矩阵空格：无写入、无 timeline 记录（除主行本身）、无提示
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const baseTl = await timelineCount(id);   // 建单已写 1 条 event_type='created'，见 [M2] 处实测钉死
    const futureVal = fmt(addDays(new Date(), 5));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M6] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    // eta 描述块本身恒存在（同 /estimate 端点 unchanged:true 的既有范式——"跑过 ETA 判定"这件事本身
    // 值得回带，不因"本格全无动作"就整个省略字段），但矩阵空格下全部标志位须为 false/null。
    const eta = r.body.eta;
    assert.ok(eta, `[M6] 响应应含 eta 描述块（恒存在，本格全标志位为 false），实得 ${JSON.stringify(r.body)}`);
    assert.strictEqual(eta.auto_generated, false, '[M6] 矩阵空格：未生成');
    assert.strictEqual(eta.overdue_intake, false, '[M6] 矩阵空格：未标记超时受理');
    assert.strictEqual(eta.eta_overwritten, false, '[M6] 矩阵空格：未覆盖');
    assert.strictEqual(eta.notify_estimate, false, '[M6] 矩阵空格：不通知');
    assert.strictEqual(eta.dev_estimated_at, futureVal, '[M6] eta.dev_estimated_at 回带现值（未变）');
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[M6] 库内值原样保留');
    assert.strictEqual(await timelineCount(id), baseTl + 1, '[M6] 仅新增 intake_accept 本身那 1 条 timeline（受理动作本身仍写一行，但 summary 应为 null，本格不额外附加 ETA 文本）');
    const tl = await latestTimeline(id);
    assert.strictEqual(tl.summary, null, `[M6] intake_accept 主行 summary 应为 null（ETA 矩阵空格无附加文本），实得 ${JSON.stringify(tl)}`);
    ok('[M6] 非空且未过期×SLA未超 → 矩阵空格：无写入、无 eta 响应字段、intake_accept 主行 summary 仍为 null');
  }

  // [M6-填值]【MED-2·口径收窄新对照】矩阵空格（非空且未过期×SLA未超），若显式提供了新值 → 显式
  //   拒绝 409 ETA_NOT_EXPIRED——与 [M6] 的"不填"分支成对。
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const futureVal = fmt(addDays(new Date(), 5));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const baseTl = await timelineCount(id);
    const attemptVal = fmtLocalNoSec(addDays(new Date(), 9));
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: attemptVal });
    assert.strictEqual(r.status, 409, `[M6-填值] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_NOT_EXPIRED', `[M6-填值] code 应为 ETA_NOT_EXPIRED，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[M6-填值] 零副作用：ETA 未变');
    assert.strictEqual(await timelineCount(id), baseTl, '[M6-填值] 零副作用：无新增 timeline 行（含 intake_accept 主行本身——整个请求被拒绝回滚，非"允许但不记"）');
    ok('[M6-填值] ⭐【MED-2】矩阵空格显式提供新值 → 409 ETA_NOT_EXPIRED 零副作用，与 [M6] 不填分支成对');
  }

  // ══════════════════════════ [M7]【回炉纠偏】/assign 超时指派——真实路径（非仅六格造态）══════════════════════════
  //   背景：首版报告曾误判"/assign 的超时指派分支结构上不可达"，理由是"dev_estimated_at 只能由 /estimate
  //   回填、且晚于指派"——这条推理只对**组 A 之前**成立。组 A 自己在 intake_accept 新增了"受理时自动生成
  //   ETA"（§2.2），而受理先于指派：受理生成的 ETA（如"当周五 17:00"）一旦指派被拖延到目标之后才发生，
  //   /assign 时 dev_estimated_at 已非空且已过期，本分支就是方案 §2.3 要拦的真实场景。本组不再借道直接
  //   DB 造态（那是 [R] 组的技法，用于证明"分支本身逻辑对不对"），而是走**真实业务链路**——建单→受理
  //   （自动生成）→模拟指派拖延（把生成的值推到过去，等价于"真实等了几天没人来指派"）→ /assign——用来
  //   证明"这条链路本身会不会走到这个分支"，两组证据互补，不是同一件事的重复。
  {
    // 正例前置：created_at=NOW → 受理时 SLA 未超 → 自动生成分支命中，ETA 来自真实受理链路（POST
    //   /intake-accept 产出，非手写字面量）——下一步再用 DB 置过期模拟"指派被拖延"。
    const id = await mkIssue('bug', nowStrForFixture());
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M7 前置] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const acceptedEta = r.body.eta && r.body.eta.dev_estimated_at;
    assert.ok(acceptedEta, `[M7 前置] 受理应已自动生成 ETA，实得 eta=${JSON.stringify(r.body.eta)}`);
    // 模拟"指派被拖延到 ETA 目标之后才发生"——与六格造态同技法（直接改 created_at/dev_estimated_at
    // 都是对"时间已经过去"这件事的等价模拟，唯一区别是这里的 ETA 本身来自真实受理链路而非手工塞入。
    const pastEta = fmt(addMinutes(new Date(), -15));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [pastEta, id]);

    // 反例：不带新值 → 400 必填码，零副作用（ETA/roster/status 三处不动）
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 400, `[M7-反] 不带新值应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ASSIGN_ESTIMATE_REQUIRED', `[M7-反] code 应为 ASSIGN_ESTIMATE_REQUIRED，实得 ${r.body.code}`);
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, pastEta, '[M7-反] 零副作用：ETA 未变');
    assert.strictEqual(row.status, '待处理', '[M7-反] 零副作用：status 未变（受理后的 D_PRE 态，未被部分指派）');
    const rosterReject = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
    assert.strictEqual(rosterReject.length, 0, '[M7-反] 零副作用：roster 仍为空（未部分落地）');

    // 正例：带未来值 → 200，ETA 写入 + timeline"超时指派" + 真实指派落地
    const futureVal = fmtLocalNoSec(addDays(new Date(), 4));
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaisonTok, { assigned_to: 5, dev_estimated_at: futureVal });
    assert.strictEqual(r.status, 200, `[M7-正] 带未来值应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.eta && r.body.eta.overdue_assign === true, `[M7-正] 响应应含 eta.overdue_assign=true，实得 ${JSON.stringify(r.body.eta)}`);
    assert.strictEqual(r.body.eta.source, 'overdue', `[M7-正] eta.source 应为 overdue（双向：voluntary 侧由 [M7-填值-NULL] 断言，防三元恒返一侧），实得 ${r.body.eta.source}`);
    row = await issueRow(id);
    assert.notStrictEqual(row.dev_estimated_at, pastEta, '[M7-正] 库内 ETA 已更新');
    assert.strictEqual(row.status, '处理中', '[M7-正] 真实指派已落地（bug: 待处理→处理中）');
    // [LOW-8] 精确定位——不依赖"latestTimeline=ORDER BY id DESC LIMIT 1 就是我要的那行"这个隐式前提
    //   （若未来 dispatchSysNotify 总闸打开、或本请求链路多写一条别的 timeline 行，最新一条未必还是
    //   assign 事件本身）。/assign 端点的超时指派留痕折叠进 event_type='assign' 那条主行的 summary
    //   （见 index.js "[组A·2.3]" 注释），按 event_type + summary LIKE 精确查这一行。
    const tl = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='assign' AND summary LIKE '%超时指派%' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl && tl.summary && tl.summary.includes('超时指派'), `[M7-正] event_type='assign' 且含"超时指派"的 timeline 行应存在，实得 ${JSON.stringify(tl)}`);
    ok('[M7] ⭐ ETA 来自真实受理链路+DB 置过期模拟拖延：受理自动生成 ETA → 指派被拖延过期 → /assign 不带新值 400 零副作用；带未来值 200+写入+timeline"超时指派"+真实指派落地');

    // ★对照组：ETA 未过期时 /assign 不要求必填（证明必填闸只对"已过期"生效，非逢指派必填，与 [R4] 对称）
    const id2 = await mkIssue('bug', nowStrForFixture());
    r = await call('POST', `/api/sys-issues/${id2}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M7-对照 前置] 受理应 200，实得 ${r.status}`);
    const acceptedEta2 = r.body.eta && r.body.eta.dev_estimated_at;
    r = await call('POST', `/api/sys-issues/${id2}/assign`, liaisonTok, { assigned_to: 6 });   // 不带新值
    assert.strictEqual(r.status, 200, `[M7-对照] ETA 未过期时不带新值也应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(!r.body.eta, `[M7-对照] 响应不应带 eta 字段，实得 ${JSON.stringify(r.body)}`);
    const row2 = await issueRow(id2);
    assert.strictEqual(row2.dev_estimated_at, acceptedEta2, '[M7-对照] ETA 原样保留（未过期，不触发必填闸也不覆盖）');
    ok('[M7-对照] ★受理自动生成的 ETA 仍未过期时，/assign 不带新值照常 200（必填闸只对"已过期"生效，非逢指派必填，与 [R4] 同款对照）');

    // [M7-填值]【MED-2·口径收窄改造，2026-08-12 主会话裁定】未过期格但现值非空（id3 先经 intake-accept
    //   自动生成过 ETA）：指派操作者显式提供新值 → 显式拒绝 409 ETA_NOT_EXPIRED（不再是旧口径的"用户值
    //   优先生效"）——口径收窄拍板：选填 ETA 输入仅在现值为 NULL（首次设定）时生效，现值非空且未过期时
    //   一律拒绝，引导改走开发的 /estimate 三重约束入口。与 [M7-对照] 的"不带新值→原样保留"成对。
    const id3 = await mkIssue('bug', nowStrForFixture());
    r = await call('POST', `/api/sys-issues/${id3}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M7-填值 前置] 受理应 200，实得 ${r.status}`);
    const acceptedEta3 = r.body.eta && r.body.eta.dev_estimated_at;
    assert.ok(acceptedEta3, '[M7-填值 前置] 受理应已自动生成 ETA（现值非空，本测试的前提）');
    const baseTl3 = await timelineCount(id3);
    const voluntaryVal = fmtLocalNoSec(addDays(new Date(), 9));   // 明显不同于受理自动生成的值
    r = await call('POST', `/api/sys-issues/${id3}/assign`, liaisonTok, { assigned_to: 5, dev_estimated_at: voluntaryVal });
    assert.strictEqual(r.status, 409, `[M7-填值] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_NOT_EXPIRED', `[M7-填值] code 应为 ETA_NOT_EXPIRED，实得 ${r.body.code}`);
    const row3 = await issueRow(id3);
    assert.strictEqual(row3.dev_estimated_at, acceptedEta3, '[M7-填值] 零副作用：ETA 未变（未被 voluntaryVal 覆盖）');
    assert.strictEqual(row3.status, '待处理', '[M7-填值] 零副作用：status 未变（指派整体被拒绝，非部分落地）');
    const rosterAfterReject = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id3]);
    assert.strictEqual(rosterAfterReject.length, 0, '[M7-填值] 零副作用：roster 仍为空');
    assert.strictEqual(await timelineCount(id3), baseTl3, '[M7-填值] 零副作用：无新增 timeline 行');
    ok('[M7-填值] ⭐【MED-2】未过期格现值非空时指派操作者显式提供新值 → 409 ETA_NOT_EXPIRED 零副作用（此前旧口径是"用户值优先生效"，本次口径收窄拍板改为显式拒绝）');
  }

  // [M7-填值-NULL]【MED-1/MED-5·成对对照，补测 /assign 的"现值 NULL→写入"分支】现值为 NULL（首次
  //   设定）：指派操作者显式提供了值 → 仍应生效（非必填但仍写入），与 [M7-填值] 的"非空→409"分支成对。
  //   [组A·HIGH-1 登记] 该起点在生产真实链路下结构上不可达（受理即自动生成，dev_estimated_at 恒非空，
  //   见 verify-sys-effort-c7.js 等既有 fixture 同款登记）——本测试借道 DB 直接置空模拟，验证的是"这条
  //   写入分支本身逻辑对不对"，与 [M7] 组验证"真实链路会不会走到这个分支"互补，两者不是同一件事。
  {
    const id4 = await mkIssue('bug', nowStrForFixture());
    let r = await call('POST', `/api/sys-issues/${id4}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[M7-填值-NULL 前置] 受理应 200，实得 ${r.status}`);
    await run(`UPDATE sys_issues SET dev_estimated_at = NULL WHERE id = ?`, [id4]);
    const rowBefore = await issueRow(id4);
    assert.strictEqual(rowBefore.dev_estimated_at, null, '[M7-填值-NULL 前置] 已强制置空（模拟生产不可达的"首次设定"起点）');
    const filledVal = fmtLocalNoSec(addDays(new Date(), 6));
    r = await call('POST', `/api/sys-issues/${id4}/assign`, liaisonTok, { assigned_to: 5, dev_estimated_at: filledVal });
    assert.strictEqual(r.status, 200, `[M7-填值-NULL] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.eta && r.body.eta.overdue_assign === false, `[M7-填值-NULL] 响应应含 eta.overdue_assign=false（非因过期触发，是自愿提供），实得 ${JSON.stringify(r.body.eta)}`);
    assert.strictEqual(r.body.eta.source, 'voluntary', `[M7-填值-NULL] ⭐【LOW-4】响应应含 eta.source='voluntary'，实得 ${JSON.stringify(r.body.eta)}`);
    const row4 = await issueRow(id4);
    assert.strictEqual(row4.dev_estimated_at, `${filledVal}:00`, `[M7-填值-NULL] ⭐ 库内值应等于指派操作者提交的值，实得 ${row4.dev_estimated_at}`);
    assert.strictEqual(row4.status, '处理中', '[M7-填值-NULL] 真实指派已落地（bug: 待处理→处理中）');
    const tl4 = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='assign' AND summary LIKE '%人工设定%' ORDER BY id DESC LIMIT 1`, [id4]);
    assert.ok(tl4 && tl4.summary && !tl4.summary.includes('超时指派') && !tl4.summary.includes('人工更新'),
      `[M7-填值-NULL] timeline 应含"人工设定"、不含"超时指派"/"人工更新"（现值 NULL 是首次设定，非过期触发也非覆盖旧值），实得 ${JSON.stringify(tl4)}`);
    ok('[M7-填值-NULL] ⭐【MED-1/MED-5】现值为 NULL（首次设定）时指派操作者显式提供值 → 200 写入生效，timeline 记"人工设定"，与 [M7-填值] 的"非空→409"分支成对');
  }

  // ══════════════════════════ [R] §2.3 超时指派——/reassign 端点 ══════════════════════════
  async function seedAssignedBug() {
    const id = await mkIssue('bug', nowStrForFixture());
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[R 夹具] 受理应 200，实得 ${r.status}`);
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `[R 夹具] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    return id;
  }
  // [R1] 既有 ETA 已过期 + 不填新值 → 400 REASSIGN_ESTIMATE_REQUIRED，零副作用（含 roster 未变）
  {
    const id = await seedAssignedBug();
    const expiredVal = fmt(addMinutes(new Date(), -20));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);
    const beforeTlCount = await timelineCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, { member_ids: [5, 6], reason: 'ETA 探针-加人' });
    assert.strictEqual(r.status, 400, `[R1] 不填应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'REASSIGN_ESTIMATE_REQUIRED', `[R1] code 应为 REASSIGN_ESTIMATE_REQUIRED，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, expiredVal, '[R1] 零副作用：ETA 未变');
    const rosterRows = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
    assert.strictEqual(rosterRows.length, 1, '[R1] 零副作用：roster 未变（不该出现"member_ids 拒绝了但花名册悄悄改了"这种半成功）');
    assert.strictEqual(await timelineCount(id), beforeTlCount, '[R1] 零副作用：无新增 timeline 行');
    ok('[R1] 既有 ETA 已过期 + 不填新值 → 400 REASSIGN_ESTIMATE_REQUIRED，ETA/roster/timeline 三处零副作用');
  }
  // [R2] 既有 ETA 已过期 + 填过去时刻 → 400 ESTIMATE_MUST_BE_FUTURE，零副作用
  {
    const id = await seedAssignedBug();
    const expiredVal = fmt(addMinutes(new Date(), -20));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, {
      member_ids: [5, 6], reason: 'ETA 探针-过去时刻', dev_estimated_at: fmtLocalNoSec(addMinutes(new Date(), -5)),
    });
    assert.strictEqual(r.status, 400, `[R2] 填过去时刻应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_MUST_BE_FUTURE', `[R2] code 应为 ESTIMATE_MUST_BE_FUTURE，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, expiredVal, '[R2] 零副作用：ETA 未变');
    ok('[R2] 既有 ETA 已过期 + 填过去时刻 → 400 ESTIMATE_MUST_BE_FUTURE，零副作用（与 [R1] 成对：缺失 vs 格式不达标两种非法输入）');
  }
  // [R3] 既有 ETA 已过期 + 填未来时刻 → 200，库值更新 + 新增 timeline 行 + roster 真实变化
  {
    const id = await seedAssignedBug();
    const expiredVal = fmt(addMinutes(new Date(), -20));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [expiredVal, id]);
    const beforeTlCount = await timelineCount(id);
    const futureVal = fmtLocalNoSec(addDays(new Date(), 4));
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, {
      member_ids: [5, 6], reason: 'ETA 探针-正例', dev_estimated_at: futureVal,
    });
    assert.strictEqual(r.status, 200, `[R3] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.eta && r.body.eta.overdue_assign === true, `[R3] 响应应含 eta.overdue_assign=true，实得 ${JSON.stringify(r.body.eta)}`);
    assert.strictEqual(r.body.eta.source, 'overdue', `[R3] eta.source 应为 overdue（双向对：voluntary 侧由 [R-填值-NULL] 断言），实得 ${r.body.eta.source}`);
    const row = await issueRow(id);
    assert.notStrictEqual(row.dev_estimated_at, expiredVal, '[R3] 库内值已更新');
    assert.strictEqual(await timelineCount(id), beforeTlCount + 1, '[R3] 新增恰 1 条 timeline 行（本端点此前从未写过 timeline，这是它第一个写点）');
    // [LOW-8] 精确定位——不依赖"latestTimeline=ORDER BY id DESC LIMIT 1 就是我要的那行"这个隐式前提。
    //   /reassign 的 ETA 留痕走独立行：event_type='note'、action_code='assign_overdue_eta'
    //   （见 index.js "[MED-2·收口]" 注释），按这两列精确查，而非信任"最新一条"。
    const tl = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='note' AND action_code='assign_overdue_eta' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl && tl.summary && tl.summary.includes('超时指派'), `[R3] event_type='note'∧action_code='assign_overdue_eta' 的 timeline 行应存在且含"超时指派"，实得 ${JSON.stringify(tl)}`);
    const rosterRows = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
    assert.strictEqual(rosterRows.length, 2, '[R3] roster 真实变化（member_ids 差量同时生效，非只顾 ETA 忽略主流程）');
    ok('[R3] 既有 ETA 已过期 + 填未来时刻 → 200，库值更新 + 新增 1 条 timeline"超时指派" + roster 差量同时落地');
  }
  // [R4] ★对照组：既有 ETA 未过期时 reassign 不要求填 ETA（不该被本次改造误伤成"逢改派必填"）
  {
    const id = await seedAssignedBug();
    const futureVal = fmt(addDays(new Date(), 5));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, { member_ids: [5, 6], reason: 'ETA 探针-未过期对照' });
    assert.strictEqual(r.status, 200, `[R4] ETA 未过期时不填也应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(!r.body.eta, `[R4] 响应不应带 eta 字段，实得 ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[R4] 未过期时 ETA 原样保留');
    ok('[R4] ★对照组：既有 ETA 未过期时改派不要求填 ETA（证明必填闸只对"已过期"生效，非逢改派必填）');
  }
  // [R-填值-NULL]【HIGH-1·必修·组A预筛修复批2 新对】真实 /return 清空 ETA 后改派填值——这正是 HIGH-1
  //   CAS 修复要救活的真实触发场景（预筛原文：现状是"打回后（return/liaison_test_return/reopen 均清空
  //   ETA）改派时填值，`= NULL` 恒不匹配"）：受理+指派+提交+**真实调用 /return**（非 DB 直接置空，
  //   与其余组用直接 UPDATE 造态的技法不同——本测试要证明的正是"真实业务流程走到这一步"）→ ETA 结构性
  //   变为 NULL → /reassign 带值。修复前（WHERE `dev_estimated_at = ?` 传 NULL 参数）SQL 三值逻辑下
  //   `x = NULL` 永远算不出 true，changes=0 → 误报 409 CONCURRENT_STATE_CHANGE；修复后（`IS ?`）200 +
  //   库内写入 + timeline"人工设定"。与下方 [R-填值]（现值非空半边）成对，覆盖 HIGH-1 CAS 判据的两侧。
  {
    const id = await seedAssignedBug();
    const submitBody = {
      mode: 'no_code', no_code_reason: 'R-填值-NULL 探针-占位交付理由', bug_cause_note: 'R-填值-NULL 探针-产生原因',
      self_tested: true, test_env_deployed: true,
    };
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody);
    assert.strictEqual(r.status, 200, `[R-填值-NULL 前置] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: 'R-填值-NULL 探针-真实打回清空 ETA' });
    assert.strictEqual(r.status, 200, `[R-填值-NULL 前置] return 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const rowAfterReturn = await issueRow(id);
    assert.strictEqual(rowAfterReturn.dev_estimated_at, null, '[R-填值-NULL 前置] 真实 return 已清空 dev_estimated_at（既有行为，非本次改造，与 [H1] 组实测一致）');
    const beforeTlCount = await timelineCount(id);
    const filledVal = fmtLocalNoSec(addDays(new Date(), 7));
    r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, {
      member_ids: [5, 6], reason: 'ETA 探针-打回后改派填值', dev_estimated_at: filledVal,
    });
    assert.strictEqual(r.status, 200, `[R-填值-NULL] ⭐【HIGH-1】应 200（修复前会误报 409 CONCURRENT_STATE_CHANGE），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.eta && r.body.eta.overdue_assign === false, `[R-填值-NULL] 响应应含 eta.overdue_assign=false（非因过期触发），实得 ${JSON.stringify(r.body.eta)}`);
    assert.strictEqual(r.body.eta.source, 'voluntary', `[R-填值-NULL] ⭐【LOW-4】响应应含 eta.source='voluntary'，实得 ${JSON.stringify(r.body.eta)}`);
    const rowAfter = await issueRow(id);
    assert.strictEqual(rowAfter.dev_estimated_at, `${filledVal}:00`, `[R-填值-NULL] ⭐ 库内值应等于改派操作者提交的值，实得 ${rowAfter.dev_estimated_at}`);
    assert.strictEqual(await timelineCount(id), beforeTlCount + 1, '[R-填值-NULL] 新增恰 1 条 timeline 行（本端点的 ETA 留痕写点）');
    const tl = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='note' AND action_code='assign_overdue_eta' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl && tl.summary && tl.summary.includes('人工设定') && !tl.summary.includes('超时指派') && !tl.summary.includes('人工更新'),
      `[R-填值-NULL] timeline 应含"人工设定"、不含"超时指派"/"人工更新"（现值 NULL 是首次设定，非过期触发也非覆盖旧值），实得 ${JSON.stringify(tl)}`);
    ok('[R-填值-NULL] ⭐【HIGH-1】真实 /return 清空 ETA → /reassign 带值 → 200+库内写入+timeline"人工设定"（CAS 由 `= ?` 改 `IS ?` 后修复，验证真实触发链路而非 DB 直接造态）');
  }
  // [R-填值]【MED-2·口径收窄改造，2026-08-12 主会话裁定】未过期格但现值非空：改派操作者显式提供
  //   新值 → 显式拒绝 409 ETA_NOT_EXPIRED（不再是旧口径的"用户值优先生效"）——与 [R-填值-NULL]
  //   （现值 NULL 半边）成对，覆盖 MED-2 ETA_NOT_EXPIRED 判据的两侧。
  {
    const id = await seedAssignedBug();
    const futureVal = fmt(addDays(new Date(), 5));
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [futureVal, id]);
    const beforeTlCount = await timelineCount(id);
    const voluntaryVal = fmtLocalNoSec(addDays(new Date(), 10));   // 明显不同于既有未过期值
    const r = await call('POST', `/api/sys-issues/${id}/reassign`, liaisonTok, {
      member_ids: [5, 6], reason: 'ETA 探针-未过期自愿填值', dev_estimated_at: voluntaryVal,
    });
    assert.strictEqual(r.status, 409, `[R-填值] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_NOT_EXPIRED', `[R-填值] code 应为 ETA_NOT_EXPIRED，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, futureVal, '[R-填值] 零副作用：ETA 未变（未被 voluntaryVal 覆盖）');
    const rosterRows = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id]);
    assert.strictEqual(rosterRows.length, 1, '[R-填值] 零副作用：roster 未变（改派整体被拒绝，非部分落地）');
    assert.strictEqual(await timelineCount(id), beforeTlCount, '[R-填值] 零副作用：无新增 timeline 行');
    ok('[R-填值] ⭐【MED-2】未过期格现值非空时改派操作者显式提供新值 → 409 ETA_NOT_EXPIRED 零副作用（此前旧口径是"用户值优先生效"，本次口径收窄拍板改为显式拒绝），与 [R-填值-NULL] 成对');
  }

  // ══════════════════════════ [D] ETA 早于 assigned_at 合法性（A4 拍板）══════════════════════════
  // [D1] 受理时 assigned_at 结构上恒为 NULL（尚未指派）——ETA 依然生成成功，证明写点从不读/不比较 assigned_at。
  {
    const id = await mkIssue('bug', nowStrForFixture());
    const before = await issueRow(id);
    assert.strictEqual(before.assigned_at, null, '[D1 前置] 受理前 assigned_at 结构上应为 NULL');
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[D1] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const after = await issueRow(id);
    assert.strictEqual(after.assigned_at, null, '[D1] 受理后 assigned_at 仍为 NULL（尚未指派）');
    assert.ok(after.dev_estimated_at, `[D1] ⭐ dev_estimated_at 已成功写入（=${after.dev_estimated_at}），而此刻 assigned_at 仍是 NULL——` +
      `与 /estimate 端点形成对照：那个端点会先拦 ASSIGNED_AT_MISSING（assigned_at 缺失即拒），本写点完全没有这道闸，` +
      `结构性证明"ETA 创建锚 SLA 与 assigned_at 解耦"（A4 拍板）`);
    ok('[D1] ⭐ 受理时 assigned_at 结构上恒为 NULL，ETA 仍生成成功——与 /estimate 的 ASSIGNED_AT_MISSING 闸对照，证明本写点从不比较/依赖 assigned_at');
  }
  // [D2] 构造 dev_estimated_at < assigned_at 的库内状态（模拟"受理后很久才指派"的真实场景），
  //   GET 详情端点不拒绝、不报错——证明这种状态是系统显式接受的合法态，非需要额外兜底的脏数据。
  {
    const id = await seedAssignedBug();   // 受理 + 指派，此刻 dev_estimated_at=自动生成值、assigned_at=刚才
    const row1 = await issueRow(id);
    assert.ok(row1.dev_estimated_at, '[D2 前置] 应已有自动生成的 ETA');
    // 把 assigned_at 显式推到 ETA 目标值之后（模拟指派发生在预计完成时间之后才落地的极端但合法场景）
    const pushedAssignedAt = fmt(addDays(new Date(row1.dev_estimated_at.replace(' ', 'T')), 3));
    await run(`UPDATE sys_issues SET assigned_at = ? WHERE id = ?`, [pushedAssignedAt, id]);
    const row2 = await issueRow(id);
    assert.ok(row2.dev_estimated_at < row2.assigned_at, `[D2] 构造出 dev_estimated_at(${row2.dev_estimated_at}) < assigned_at(${row2.assigned_at}) 的状态`);
    const r = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(r.status, 200, `[D2] GET 详情不应因 ETA 早于 assigned_at 而报错，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[D2] 构造 dev_estimated_at < assigned_at 的库内状态后，GET 详情端点仍 200——证明该状态是显式接受的合法态');
  }

  // ══════════════════════════ [N] 服务端必填值晚于当前时刻校验负例（intake-accept 分支）══════════════════════════
  // 与 [R2] 对称：[R2] 证明 reassign 写点有这道闸，这里独立证明 intake-accept 写点也有（不能只证一处就假设另一处"应该也对"）。
  {
    const id = await mkIssue('bug', FAR_PAST_CREATED);   // SLA 已超，为空分支 → 必填
    const pastVal = fmtLocalNoSec(addMinutes(new Date(), -10));
    const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: pastVal });
    assert.strictEqual(r.status, 400, `[N1] 填过去时刻应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_MUST_BE_FUTURE', `[N1] code 应为 ESTIMATE_MUST_BE_FUTURE，实得 ${r.body.code}`);
    const row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, null, '[N1] 零副作用：未落库');
    assert.strictEqual(row.status, '待受理', '[N1] 零副作用：status 未变');
    // 边界：恰好等于当前时刻（非"晚于"）同样应拒绝——"晚于"是严格大于，不含等于
    const nowRow = await get(`SELECT datetime('now','localtime') AS n`);
    const r2 = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, { dev_estimated_at: nowRow.n.slice(0, 16) });
    assert.strictEqual(r2.status, 400, `[N2] 恰好等于当前时刻（分钟精度）应拒绝，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    ok('[N] intake-accept 必填分支：填过去时刻 400 ESTIMATE_MUST_BE_FUTURE 零副作用；恰好等于当前时刻同样拒绝（严格晚于，非"不早于"）');
  }

  // ══════════════════════════ [H1]【回炉纠偏·HIGH-1 登记接受】GATE 第 1 轮恒满足 vs 第 2 轮恢复原语义 ══════════════════════════
  //   [七轮预筛 LOW-2 登记] 第 2 轮 ESTIMATE_REQUIRED 的满足主体自 HIGH-1（IS ?）修复后扩宽：除开发走
  //   /estimate 外，对接人在改派弹窗代填（NULL→值·人工设定）同样满足——恢复设计意图非缺陷；nf=1 单不受影响（评估闸另拦）。
  //   三处闸门（isGateEligibleForVerify :2715 / handleDevSubmit ESTIMATE_REQUIRED :6668 /
  //   set-scheduled-start SCHEDULED_START_REQUIRES_ESTIMATE :8091）判据均为"dev_estimated_at 非空"。
  //   组 A 后受理即自动生成 ETA，故第 1 轮提交这三处闸恒满足（不再可能因未填 ETA 被拒）；但 return/reopen
  //   会清空 dev_estimated_at（既有行为，非本次改动），第 2 轮起该闸重新可能命中——本组用 **submit 与
  //   set-scheduled-start 两个端点**各钉一对"恒满足→恢复原语义"断言（[356-L2] 采纳：判据字面相同但可达
  //   状态/错误码不同，端点级各证一对）；isGateEligibleForVerify 为内部函数无独立端点面，其判据与 submit
  //   闸同源同数据，行为面由 submit 对捎带覆盖——注释登记非虚构断言。
  {
    const id = await mkIssue('bug', nowStrForFixture());
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(r.status, 200, `[H1 前置] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.eta && r.body.eta.auto_generated, '[H1 前置] 应已自动生成 ETA（第 1 轮起点）');
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `[H1 前置] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);

    // [356-L2] 三闸之二 set-scheduled-start：第 1 轮（自动 ETA·处理中）设值不应因 ESTIMATE 闸被拒；设完清回不扰后续流
    // [358-M2] 日期相对当前时间计算（+30/+31 天），不用固定字面量——固定日期过期后会产生非业务逻辑失败（本仓日期炸弹沉淀同款）
    const schedBase = new Date();
    const schedFmt = (plusDays) => { const t = new Date(schedBase.getFullYear(), schedBase.getMonth(), schedBase.getDate() + plusDays); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: schedFmt(30) });
    assert.strictEqual(r.status, 200, `[H1-第1轮·排期闸] set-scheduled-start 应 200（自动 ETA 满足闸门），实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: null });
    assert.strictEqual(r.status, 200, `[H1-第1轮·排期闸] 清除计划开工日应 200（还原现场），实得 ${r.status}`);
    ok('[H1-第1轮·排期闸] ⭐ 自动 ETA 下 set-scheduled-start 不因 SCHEDULED_START_REQUIRES_ESTIMATE 被拒（三闸之二·与 submit 对同源成对）');

    const submitBody = {
      mode: 'no_code', no_code_reason: 'H1 探针-第1轮占位交付理由', bug_cause_note: 'H1 探针-产生原因',
      self_tested: true, test_env_deployed: true,
    };
    // 第 1 轮：受理自动生成的 ETA 未被 return/reopen 清空过 → submit 不应再因"未填 ETA"被拒
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody);
    assert.notStrictEqual(r.body && r.body.code, 'ESTIMATE_REQUIRED', `[H1-第1轮] ⭐ submit 不应再因 ESTIMATE_REQUIRED 被拒（GATE 第 1 轮恒满足），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.status, 200, `[H1-第1轮] submit 应 200（受理自动生成的 ETA 已满足闸门），实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[H1-第1轮] ⭐ 受理自动生成 ETA 后直接 submit，不再 400 ESTIMATE_REQUIRED（GATE 恒满足，方案 A3/A4 直接推论）');

    // 打回（admin·return，待验证→开发中/处理中）——既有行为：清空 dev_estimated_at，开启第 2 轮
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: 'H1 探针-打回验证 GATE 恢复' });
    assert.strictEqual(r.status, 200, `[H1 打回] return 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const rowAfterReturn = await issueRow(id);
    assert.strictEqual(rowAfterReturn.dev_estimated_at, null, '[H1 打回] 既有行为：return 清空 dev_estimated_at（第 2 轮起点，ETA 归零）');

    // [356-L2] 三闸之二成对：第 2 轮 ETA 清空 → set-scheduled-start 设值应 409（闸恢复）
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: schedFmt(31) });
    assert.strictEqual(r.status, 409, `[H1-第2轮·排期闸] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SCHEDULED_START_REQUIRES_ESTIMATE', `[H1-第2轮·排期闸] code 应为 SCHEDULED_START_REQUIRES_ESTIMATE（闸恢复原语义），实得 ${r.body.code}`);
    ok('[H1-第2轮·排期闸] ⭐ return 清空 ETA 后设排期仍 409（与第 1 轮排期闸成对·三闸之二收口）');

    // 第 2 轮：ETA 已被清空、未重新回填 → submit 应恢复原语义，重新 400 ESTIMATE_REQUIRED（成对对照）
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody);
    assert.strictEqual(r.status, 400, `[H1-第2轮] 未重填 ETA 时 submit 应仍 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', `[H1-第2轮] code 应为 ESTIMATE_REQUIRED（闸恢复原语义），实得 ${r.body.code}`);
    ok('[H1-第2轮] ⭐ return 清空 ETA 后，未重填即 submit 仍 400 ESTIMATE_REQUIRED（第 2 轮闸恢复原语义，与第 1 轮成对）');
  }

  server.close();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代·组A 预计完成时间自动生成 + 超时受理/超时指派强制填写 验收通过`);
  console.log('  P：computeSysDefaultEta 纯函数——15:00:00 边界(14:59:59/15:00:00/15:00:01/跨月/跨年) + 非bug全7天weekday覆盖(周三/周四边界独立复算对照)');
  console.log('  M：§2.2 双维度矩阵六格全覆盖（每格独立造态，断言响应eta字段+库内值+timeline三件套，含必填闸正反双向）');
  console.log('  M7：⭐【回炉纠偏】/assign 超时指派——ETA来自真实受理链路+DB置过期模拟拖延（受理自动生成→指派拖延过期→必填闸触发+真实指派落地）+ 未过期对照');
  console.log('  R：§2.3 超时指派/reassign——不填400/填过去400/填未来200+timeline新增+roster差量同时落地/未过期对照组');
  console.log('  D：ETA早于assigned_at合法性——受理时assigned_at结构性NULL仍生成成功(与/estimate的ASSIGNED_AT_MISSING对照) + 构造早于态GET详情不拒绝');
  console.log('  N：intake-accept必填分支晚于当前时刻校验负例（与R2对称，两个写点各自独立证明）+ 恰好相等边界');
  console.log('  H1：GATE第1轮恒满足vs第2轮恢复原语义——submit 与 set-scheduled-start 两端点各一对（自动ETA后不拒/return清空后恢复拒），isGateEligibleForVerify 同源判据注释登记');
  console.log('  MED-2口径收窄：三端点选填ETA统一新规则——现值NULL首次设定生效([M1/M7/R-填值-NULL])，现值非空且未过期一律409 ETA_NOT_EXPIRED([M5/M6/M7/R-填值])，过期分支不变');
  console.log('  HIGH-1：/reassign值级CAS由 = ? 改 IS ?（[R-填值-NULL] 用真实/return清空ETA→改派填值200，修复前恒误报409 CONCURRENT_STATE_CHANGE）');
}

main().catch((e) => { fail(e && e.stack || e); });
