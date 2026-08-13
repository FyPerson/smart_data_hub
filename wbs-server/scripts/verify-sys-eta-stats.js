// scripts/verify-sys-eta-stats.js — 系统迭代·组 C「期望对表与准时统计」SC2 阶段验收（一期两指标）
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §3C.6
//   用法：node scripts/verify-sys-eta-stats.js
//
// 覆盖（正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [A] 端点结构：GET /sys-issues/eta-stats 任意登录用户可读（无需 admin），响应体含
//       overall.coverage / overall.achievement 同屏（353-M4）+ by_type + generated_at。
//   [B] 覆盖率分子分母：仅 deadline 非空的「已上线」单计入覆盖率分子；未上线单（处理中）完全不计入
//       released_total（分母）——正反各一例。
//   [C] 达成率：released_at ≤ deadline（未晚于）→ 计入达成率分子；released_at > deadline（超期）→
//       不计入分子、落 overdue_examples 明细（按单，非聚合）。deadline 未填的已上线单不参与达成率
//       分母（与覆盖率分子同源——达成率分母=覆盖率分子，方案 §3C.6 定义式原文）。
//   [D] 样本不足阈值：达成率分母（=覆盖率分子）< SYS_ETA_STATS_SAMPLE_THRESHOLD 时
//       overall.achievement.insufficient_sample=true；跨过阈值后翻 false——同一批数据累积增量验证，
//       不是两次独立起点各说各话。
//   [E] byType 细分：与总计同一份 computeSysEtaStatsForRows 计算（RC-L2 直调，非复刻）——用两种
//       type（bug/improvement）各自独立造数据，核对每个 type 分组的 released_total/coverage/
//       achievement 与总计正确累加（Σ byType.released_total === overall.released_total）。
//   [F] 直调 computeSysEtaStatsForRows/round1Pct 边界：released_total=0（无样本）→ rate=null 非
//       NaN/Infinity；deadline 畸形（理论不可达，防御性）→ 不计入分子分母，不抛异常。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-eta-stats-secret';
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
// 非 admin 普通登录用户——用于 [A] 断言"任意登录用户可读"（无需 admin/对接人）。
const plainUserTok = jwt.sign({ id: 6, username: 'dev6', display_name: '开发李', role: 'user' }, SECRET);

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
function fail(msg) { console.error('\n❌ verify-sys-eta-stats 失败: ' + msg); process.exit(1); }

// ── 通用时间 helper（released_at 由服务端在动作发生的"此刻"写入，无法预先摆值——故本脚本的
//   deadline 全部相对"真实现在"取远期偏移，让 released_at(≈现在) 稳定落在 deadline 的一侧，
//   不依赖任何固定锚点日历位置，同既有 verify-sys-* 惯例：日期炸弹教训，动态生成不硬编码字面量）。
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDateOnly(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
function addDays(dt, d) { const c = new Date(dt.getTime()); c.setDate(c.getDate() + d); return c; }
function futureDeadline(days) { return fmtDateOnly(addDays(new Date(), days)); }   // 远期未来 → released_at(≈now) 必早于 → 达标
function pastDeadline(days) { return fmtDateOnly(addDays(new Date(), -days)); }    // 远期过去 → released_at(≈now) 必晚于 → 超期

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `SC2-统计探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-eta-stats 夹具', intake_liaison_id: 13,
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// bug → 处理中 → estimate → submit(no_code，0 commit) → accept：C9 免上线直翻「已上线」，最省心的
// 通用夹具（type 对本端点统计口径无关——不参与容差判定，纯粹图它比 improvement/feature 少两步前置）。
async function bugToReleased(overrides = {}) {
  const id = await mkIssue('bug', overrides);
  let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-受理] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-指派] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureDeadline(1) + ' 10:00' });
  assert.strictEqual(r.status, 200, `[夹具-估时] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
    mode: 'no_code', no_code_reason: 'SC2 统计夹具无提交', self_tested: true, test_env_deployed: true,
    bug_cause_note: 'SC2 统计夹具 bug 产生原因',
  });
  assert.strictEqual(r.status, 200, `[夹具-提交] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-验收] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.status, '已上线', `[夹具-验收] 应直翻已上线（C9），实得 ${r.body.status}`);
  return id;
}
async function getStats() {
  const r = await call('GET', '/api/sys-issues/eta-stats', devTok);
  assert.strictEqual(r.status, 200, `GET eta-stats 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),
    (6,'dev6','开发李','user','active'),(13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  // ══════════════════════════ [A] 端点结构 + 初始空态 ══════════════════════════
  {
    // 空库（尚无任何已上线单）：released_total=0，两指标 rate=null（无样本），不抛 500/NaN。
    let d = await getStats();
    assert.strictEqual(d.overall.released_total, 0, '[A-空态] 尚无已上线单时 released_total=0');
    assert.strictEqual(d.overall.coverage.rate, null, '[A-空态] 分母=0 时覆盖率 rate=null（非 NaN/Infinity）');
    assert.strictEqual(d.overall.achievement.rate, null, '[A-空态] 分母=0 时达成率 rate=null');
    assert.strictEqual(d.overall.achievement.insufficient_sample, true, '[A-空态] 0 < 阈值 → insufficient_sample=true');
    assert.deepStrictEqual(d.overall.overdue_examples, [], '[A-空态] 未达标示例为空数组');
    assert.deepStrictEqual(d.by_type, [], '[A-空态] byType 为空数组');
    assert.ok(typeof d.generated_at === 'string' && d.generated_at, '[A-空态] generated_at 已下发');
    assert.ok(typeof d.sample_threshold === 'number' && d.sample_threshold > 0, '[A-空态] sample_threshold 已下发（正整数）');
    ok('[A-空态] GET /sys-issues/eta-stats 空库返回结构完整：released_total=0、两指标 rate=null、insufficient_sample=true、示例/byType 均为空数组，不抛 500');

    // 任意登录用户可读（非 admin 普通用户 plainUserTok）——同值班排班口径，不挂 requireAdmin。
    const r = await call('GET', '/api/sys-issues/eta-stats', plainUserTok);
    assert.strictEqual(r.status, 200, `[A-权限] 非 admin 普通用户应可读，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[A-权限] 非 admin 普通登录用户可读本端点（无需 admin/对接人身份）');
  }

  // ══════════════════════════ [B] 覆盖率分子分母 + 未上线单不计入分母 ══════════════════════════
  {
    // 未上线单（处理中，不推进到已上线）：应完全不出现在 released_total 里。
    const inflightId = await mkIssue('bug');
    let r = await call('POST', `/api/sys-issues/${inflightId}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 200, '[B-在途前置] 受理成功');
    let d = await getStats();
    const releasedTotalBefore = d.overall.released_total;

    // 一个已上线且 deadline 非空的单——覆盖率分子 +1。
    await bugToReleased({ deadline: futureDeadline(30) });
    d = await getStats();
    assert.strictEqual(d.overall.released_total, releasedTotalBefore + 1, '[B] 在途单（处理中）不计入 released_total；新增 1 单已上线单 released_total 恰好 +1（非 +2，证明在途单确未被计入）');
    assert.strictEqual(d.overall.coverage.numerator, 1, '[B] deadline 非空的已上线单计入覆盖率分子');
    assert.strictEqual(d.overall.coverage.denominator, releasedTotalBefore + 1, '[B] 覆盖率分母=released_total');

    // 再来一个已上线但 deadline 为空的单——released_total +1，覆盖率分子不变。
    const coverageNumBefore = d.overall.coverage.numerator;
    await bugToReleased({});   // 不传 deadline
    d = await getStats();
    assert.strictEqual(d.overall.released_total, releasedTotalBefore + 2, '[B] deadline 为空的单同样计入 released_total（分母）');
    assert.strictEqual(d.overall.coverage.numerator, coverageNumBefore, '[B] ⭐ deadline 为空的单不计入覆盖率分子——numerator 未变化（若误把它也算进分子，这里会变成 coverageNumBefore+1，断言会抓到）');
    ok('[B] 覆盖率分子分母：deadline 非空的已上线单计入分子+分母；deadline 为空的已上线单只计入分母（released_total）；处理中（未上线）单完全不计入分母');
  }

  // ══════════════════════════ [C] 达成率：达标 vs 超期 双向成对 ══════════════════════════
  {
    let d = await getStats();
    const achBefore = { num: d.overall.achievement.numerator, den: d.overall.achievement.denominator };
    const examplesBefore = d.overall.overdue_examples.length;

    // deadline 远期未来 → released_at(≈now) 必早于 deadline → 达标（计入达成率分子）。
    const achievedId = await bugToReleased({ deadline: futureDeadline(30) });
    d = await getStats();
    assert.strictEqual(d.overall.achievement.numerator, achBefore.num + 1, '[C-达标] 达成率分子 +1');
    assert.strictEqual(d.overall.achievement.denominator, achBefore.den + 1, '[C-达标] 达成率分母（=覆盖率分子）同步 +1');
    assert.strictEqual(d.overall.overdue_examples.length, examplesBefore, '[C-达标] 达标单不进入 overdue_examples（示例列表长度不变）');
    const achBefore2 = { num: d.overall.achievement.numerator, den: d.overall.achievement.denominator };

    // deadline 远期过去 → released_at(≈now) 必晚于 deadline → 超期（不计入分子，进 overdue_examples）。
    const overdueId = await bugToReleased({ deadline: pastDeadline(30) });
    d = await getStats();
    assert.strictEqual(d.overall.achievement.numerator, achBefore2.num, '[C-超期] ⭐ 超期单不计入达成率分子——numerator 未变化（若误计入这里会 +1，断言会抓到）');
    assert.strictEqual(d.overall.achievement.denominator, achBefore2.den + 1, '[C-超期] 但仍计入达成率分母（=覆盖率分子，超期单也是"填了期望"的已上线单）');
    const example = d.overall.overdue_examples.find(e => e.id === overdueId);
    assert.ok(example, '[C-超期] 超期单出现在 overdue_examples 明细（按单，非聚合）');
    assert.ok(example.overdue_days > 0, `[C-超期] overdue_days 应为正数，实得 ${example.overdue_days}`);
    assert.ok(!d.overall.overdue_examples.some(e => e.id === achievedId), '[C-达标交叉] 达标单不应混入 overdue_examples');
    ok('[C] 达成率双向成对：deadline 远期未来（达标）→ 计入分子、不进示例；deadline 远期过去（超期）→ 不计入分子但计入分母、进 overdue_examples 明细且 overdue_days>0');
  }

  // ══════════════════════════ [D] 样本不足阈值——同一批数据累积增量验证 ══════════════════════════
  {
    // 重开一个全新的 in-process 实例（独立 DB），从 0 开始精确控制样本量跨过阈值的那一刻。
    const db2 = new sqlite3.Database(':memory:');
    const run2 = (sql, params = []) => new Promise((res, rej) => db2.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const all2 = (sql, params = []) => new Promise((res, rej) => db2.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const get2 = (sql, params = []) => new Promise((res, rej) => db2.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    const mod2 = require('../routes/sys-iteration')({
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      db: db2, dbRunAsync: run2, dbGetAsync: get2, dbAllAsync: all2,
      authenticateToken, requireAdmin,
      ...require('./_sys-attach-test-deps'),
    });
    const I2 = mod2._internals;
    mod2.initSchema();
    await new Promise((res, rej) => {
      let n = 0;
      const t = setInterval(() => {
        if (I2.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
        else if (I2.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I2.SYS_SCHEMA_STATE.error)); }
        else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
      }, 10);
    });
    await run2(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
    await run2(`INSERT INTO users (id, username, display_name, role, status) VALUES
      (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),(13,'wangtaotao','示例对接人','user','active')`);
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', mod2.router);
    const server2 = http.createServer(app2);
    await new Promise((res) => server2.listen(0, '127.0.0.1', res));
    const port2 = server2.address().port;
    function call2(method, p, tok, body) {
      return new Promise((resolve, reject) => {
        const data = body !== undefined ? JSON.stringify(body) : null;
        const req = http.request({
          host: '127.0.0.1', port: port2, path: p, method, headers: {
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
    const threshold = I2.SYS_ETA_STATS_SAMPLE_THRESHOLD;
    assert.ok(Number.isInteger(threshold) && threshold > 0, `[D-前置] SYS_ETA_STATS_SAMPLE_THRESHOLD 应为正整数，实得 ${threshold}`);
    let seq2 = 0;
    async function mkIssue2(overrides = {}) {
      seq2++;
      const r = await call2('POST', '/api/sys-issues', adminTok, {
        intake_contract_version: 2, type: 'bug', title: `SC2-阈值探针-${seq2}`, system_name: 'BMS', source: '内部',
        description: 'verify-sys-eta-stats [D] 夹具', intake_liaison_id: 13, ...overrides,
      });
      assert.strictEqual(r.status, 201, `[D-建单] 应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id;
    }
    async function bugToReleased2(overrides = {}) {
      const id = await mkIssue2(overrides);
      let r = await call2('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
      assert.strictEqual(r.status, 200, '[D-受理] 应 200');
      r = await call2('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(r.status, 200, '[D-指派] 应 200');
      r = await call2('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureDeadline(1) + ' 10:00' });
      assert.strictEqual(r.status, 200, '[D-估时] 应 200');
      r = await call2('POST', `/api/sys-issues/${id}/submit`, devTok, {
        mode: 'no_code', no_code_reason: 'SC2 阈值夹具无提交', self_tested: true, test_env_deployed: true,
        bug_cause_note: 'SC2 阈值夹具 bug 产生原因',
      });
      assert.strictEqual(r.status, 200, '[D-提交] 应 200');
      r = await call2('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(r.status, 200, '[D-验收] 应 200');
      return id;
    }
    async function getStats2() {
      const r = await call2('GET', '/api/sys-issues/eta-stats', devTok);
      assert.strictEqual(r.status, 200, `GET eta-stats 应 200，实得 ${r.status}`);
      return r.body;
    }
    // threshold-1 条已上线+带 deadline 的单 → 未达阈值，insufficient_sample=true。
    for (let i = 0; i < threshold - 1; i++) await bugToReleased2({ deadline: futureDeadline(30) });
    let d = await getStats2();
    assert.strictEqual(d.overall.achievement.denominator, threshold - 1, `[D-未达阈值] 达成率分母应 = ${threshold - 1}`);
    assert.strictEqual(d.overall.achievement.insufficient_sample, true, `[D-未达阈值] 分母=${threshold - 1} < 阈值 ${threshold} → insufficient_sample=true`);
    // 再补 1 条，跨过阈值 → insufficient_sample 翻 false（同一批数据累积增量，非独立起点）。
    await bugToReleased2({ deadline: futureDeadline(30) });
    d = await getStats2();
    assert.strictEqual(d.overall.achievement.denominator, threshold, `[D-达阈值] 达成率分母应 = ${threshold}`);
    assert.strictEqual(d.overall.achievement.insufficient_sample, false, `[D-达阈值] 分母=${threshold} 达到阈值 → insufficient_sample=false（严格不小于即达标，同 evaluateEtaOverrun 类严格边界纪律对齐）`);
    ok(`[D] 样本不足阈值：分母=${threshold - 1}（阈值-1）→ insufficient_sample=true；累积增量到分母=${threshold}（达阈值）→ 翻 false，同一批数据递增验证而非两次独立起点`);
    server2.close();
  }

  // ══════════════════════════ [E] byType 细分与总计一致性 ══════════════════════════
  {
    let d = await getStats();
    const overallBefore = d.overall.released_total;
    const byTypeSumBefore = d.by_type.reduce((s, t) => s + t.released_total, 0);
    assert.strictEqual(byTypeSumBefore, overallBefore, '[E-前置] byType 各组 released_total 之和应等于总计（累加不变量，改动前先验证既有数据自洽）');

    // 新增一个 improvement 类型的已上线单（deadline 达标）——bug 类不能用于本组，因为已有大量 bug
    // 夹具残留，改用未出现过的 type 更容易在 byType 里定位到"恰好 +1"这条断言。
    const impId = await mkIssue('improvement', { needs_feasibility: 0, deadline: futureDeadline(30) });
    let r = await call('POST', `/api/sys-issues/${impId}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, '[E-前置] improvement 受理成功');
    r = await call('POST', `/api/sys-issues/${impId}/set-oa-number`, adminTok, { oa_number: `2026099${seq}` });
    assert.strictEqual(r.status, 200, '[E-前置] 补 OA 成功');
    r = await call('POST', `/api/sys-issues/${impId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '[E-前置] 指派成功');
    r = await call('POST', `/api/sys-issues/${impId}/estimate`, devTok, { dev_estimated_at: futureDeadline(1) + ' 10:00', estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, '[E-前置] 估时成功');
    r = await call('POST', `/api/sys-issues/${impId}/submit`, devTok, {
      mode: 'no_code', no_code_reason: 'SC2 byType 夹具无提交', self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 200, `[E-前置] 提交应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${impId}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[E-前置] 验收应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已上线', '[E-前置] improvement 单同样 C9 直翻已上线（0 commit）');

    d = await getStats();
    const impRow = d.by_type.find(t => t.type === 'improvement');
    assert.ok(impRow, '[E] byType 中出现 improvement 分组');
    assert.strictEqual(impRow.released_total, 1, '[E] improvement 分组 released_total=1（本组首次出现该类型）');
    assert.strictEqual(impRow.coverage.numerator, 1, '[E] improvement 分组覆盖率分子=1');
    assert.strictEqual(impRow.achievement.numerator, 1, '[E] improvement 分组达成率分子=1（deadline 远期未来，达标）');
    const byTypeSumAfter = d.by_type.reduce((s, t) => s + t.released_total, 0);
    assert.strictEqual(byTypeSumAfter, d.overall.released_total, '[E] ⭐ Σ byType.released_total === overall.released_total（累加不变量，与总计同一份 computeSysEtaStatsForRows，非两处各写一份口径）');
    assert.strictEqual(byTypeSumAfter, overallBefore + 1, '[E] 总计确实 +1（新增单据真实计入，非巧合自洽）');
    ok('[E] byType 细分与总计一致性：新增 improvement 分组正确出现且各字段符合预期；Σ byType.released_total === overall.released_total 累加不变量成立');
  }

  // ══════════════════════════ [F] 直调 computeSysEtaStatsForRows/round1Pct 边界 ══════════════════════════
  {
    assert.strictEqual(typeof I.computeSysEtaStatsForRows, 'function', '[F 前置] computeSysEtaStatsForRows 应已导出');
    assert.strictEqual(typeof I.round1Pct, 'function', '[F 前置] round1Pct 应已导出');
    // round1Pct 边界：分母 0/null/undefined → null（非 NaN/Infinity）。
    assert.strictEqual(I.round1Pct(3, 0), null, '[F-1] 分母=0 → null');
    assert.strictEqual(I.round1Pct(0, 0), null, '[F-2] 0/0 → null（非 NaN）');
    assert.strictEqual(I.round1Pct(1, 3), 33.3, '[F-3] 1/3 → 33.3（保留 1 位小数）');
    assert.strictEqual(I.round1Pct(2, 3), 66.7, '[F-4] 2/3 → 66.7');
    ok('[F-1..4] round1Pct 边界：分母 0 → null（非 NaN/Infinity）；正常分数四舍五入到 1 位小数');

    // computeSysEtaStatsForRows：空数组 → released_total=0，两指标 rate=null，不抛异常。
    let stats = I.computeSysEtaStatsForRows([]);
    assert.strictEqual(stats.released_total, 0, '[F-5] 空数组 → released_total=0');
    assert.strictEqual(stats.coverage.rate, null, '[F-5] 空数组 → coverage.rate=null');
    assert.strictEqual(stats.achievement.rate, null, '[F-5] 空数组 → achievement.rate=null');
    assert.strictEqual(stats.achievement.insufficient_sample, true, '[F-5] 空数组分母 0 < 阈值 → insufficient_sample=true');

    // deadline 畸形（理论不可达——deadline 已经过 normalizeDeadlineDT 校验才能入库；此处防御性覆盖，
    //   同 computeEtaDeadlineGapDays 对畸形值的既有降级处置口径 [U-13]）→ 不计入分子分母，不抛异常。
    stats = I.computeSysEtaStatsForRows([
      { id: 1, title: 'malformed', type: 'bug', deadline: '2026-02-31', released_at: '2026-03-01 10:00:00' },
      { id: 2, title: 'valid-achieved', type: 'bug', deadline: '2026-06-01', released_at: '2026-05-01 10:00:00' },
    ]);
    assert.strictEqual(stats.released_total, 2, '[F-6] released_total 按行数计（不因畸形值跳过整行统计，只跳过分子分母计入）');
    assert.strictEqual(stats.coverage.numerator, 1, '[F-6] 畸形 deadline 那行不计入覆盖率分子（只有合法那行计入）');
    assert.strictEqual(stats.achievement.numerator, 1, '[F-6] 畸形 deadline 那行同样不计入达成率分子/分母');
    ok('[F-5..6] computeSysEtaStatsForRows 边界：空数组不抛异常、rate=null；deadline 畸形行降级为"不可判定"（不计入分子分母，不误判达标/超期，released_total 按行数正常计）');
  }

  console.log(`\n✅ verify-sys-eta-stats 全部通过（${passed} 项）`);
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); fail(e.message || String(e)); });
