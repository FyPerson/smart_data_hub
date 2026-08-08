// 验证脚本：C7 工时评估补全（上线执行人多选随批五项 · 方案 v1.7 §9.1）
//   用法：node scripts/verify-sys-effort-c7.js
//
// 背景：C2（工期对接测试与风险等级拆分 v1.1 §3.2）落地 estimated_effort_days 时，必填面只覆盖了
//   「needs_feasibility=1 的 feature」一个格子——improvement 选填、nf=0 的单**根本没有工期写点**
//   （nf=0 走 estimate 端点，而 estimate 从不收工期），于是 nf=0 的变更类单据一路走到上线都可以零工期。
//   C7 把这块补齐，四处后端改动构成一个矩阵：
//     ① estimate 端点新增工期收参+写入（承接 nf=0 的 feature/improvement）——**新写点**
//     ② feasibility 端点必填面 feature → feature+improvement（承接 nf=1）
//     ③ submit 硬闸：工期检查从「nf=1 ∧ feature」外提到「两类型 × nf 两值」
//     ④ GATE isGateEligibleForVerify：同款外提（非 submit 路径的深层兜底）
//   ②③④ 三层必须同构——同一套 issue 级不变量三处实现，任一处漏改就会出现"这条路能过、那条路过不去"
//   的分裂态（C2 遗留的正是这种分裂：写入口只认 feature，GATE 也只认 feature，两处一起错所以测不出来）。
//
// 覆盖组：
//   [1] estimate 新写点正例：nf=0 feature/improvement 收参落库 + 响应回带 + timeline 不变形
//   [2] estimate 负例：缺工期 EFFORT_REQUIRED / 脏值 INVALID_EFFORT_DAYS / 零副作用
//   [3] estimate 适用面闸：nf=1 单传工期 400 EFFORT_NOT_APPLICABLE（不开旁路）+ 不传仍是原 409 封口
//   [4] estimate 适用面闸：bug（无工期维度）传值即拒 + 不传照常放行且不动该列
//   [5] estimate 同值 no-op 双字段口径：时间不变只改工期必须真写入（C7 引入的双字段写点回归网）
//   [6] feasibility improvement 必填同构（与 feature 同码 EFFORT_REQUIRED）
//   [7] submit 闸全链：nf=0 存量单（工期为空）被拦 → 按文案补填 → 放行
//   [8] submit 闸 nf=1 improvement 同构 + 存量脏值 EFFORT_INVALID 分支
//   [9] GATE 静默 defer 语义保持：非 submit 路径（excuse 触发 W-GATE）工期缺失时不推进、不报错、打
//       gate_deferred_at 标；补填后经消费点原子推进
//   [10] 弹回场景：待验证 → return 弹回「开发中」后新规则仍生效（换轮清空工期 → 重填才能再提交）
//
// 断言纪律：精确状态码 + 精确 error code；负例断言"零副作用"（落库列/状态/timeline 三查），不止看状态码。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-effort-c7-secret';
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
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 硬编码未来日期会到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹，本仓 221a 批次的既有教训）——动态生成，勿回退
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

let oaSeq = 0;
// 建单 → 受理 → 补 OA → assign → 开发中；返回 id。
//   intake_liaison_id 建单后置 999999：让 GATE 判定时对接人失效走 §3.0-⑥ 降级，submit 直落「待验证」，
//   本文件才能专注工期闸而不被「待对接测试」段干扰（同 verify-sys-feasibility-endpoints 既有手法）。
async function seedToDev(type, needsFeasibility, opts = {}) {
  const payload = {
    intake_contract_version: 2, type, title: `c7-${type}-${++oaSeq}`, system_name: 'BMS', source: '内部',
    description: 'C7 工时评估补全 verify 场景建单', intake_liaison_id: 13,
  };
  if (type === 'feature' || type === 'improvement') payload.needs_feasibility = needsFeasibility;
  let r = await call('POST', '/api/sys-issues', adminTok, payload);
  assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const acc = (type === 'feature' || type === 'improvement') ? { risk_level: '二级' } : {};
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, acc);
  assert.strictEqual(r.status, 200, `受理 200, got ${r.status} ${JSON.stringify(r.body)}`);
  if (type === 'feature' || type === 'improvement') {
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(20260700 + oaSeq).padStart(10, '2') });
    assert.strictEqual(r.status, 200, `补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: opts.assignTo || 5 });
  assert.strictEqual(r.status, 200, `assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  return id;
}
const SUBMIT_BODY = { mode: 'no_code', no_code_reason: 'C7 验证占位交付理由', self_tested: true, test_env_deployed: true };
async function effortOf(id) { return (await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [id])).estimated_effort_days; }
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }
async function tlCount(id) { return (await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id])).c; }

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  // ═══ [1] estimate 新写点正例（nf=0 两类型）═══
  {
    for (const type of ['feature', 'improvement']) {
      const id = await seedToDev(type, 0);
      assert.strictEqual(await effortOf(id), null, `[1-${type}-前置] 建单后工期应为 NULL（防夹具自己把值种进去，测出个假绿）`);
      const r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 2.5 });
      assert.strictEqual(r.status, 200, `[1-${type}] estimate 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.estimated_effort_days, 2.5, `[1-${type}] 响应回带工期 2.5，实得 ${r.body.estimated_effort_days}`);
      assert.strictEqual(await effortOf(id), 2.5, `[1-${type}] 工期 2.5 真落库（不是只在响应里回显）`);
      const d = await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(d.dev_estimated_at, EST + ':00', `[1-${type}] 同一条 UPDATE 里 dev_estimated_at 照常落库（D4 补秒），双字段原子写`);
      // timeline summary 是纯文本直出（D3：到分不带秒）——C7 只加字段不改留痕格式，这条断言防"顺手把工期
      // 拼进 summary"导致 verify-sys-time-precision 的 D2 断言在别处炸。
      const tl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate' ORDER BY id DESC LIMIT 1`, [id]);
      assert.strictEqual(tl.summary, EST, `[1-${type}] estimate timeline summary 仍是纯预计完成时间文本（C7 不改留痕格式），实得 ${JSON.stringify(tl.summary)}`);
      ok(`[1-${type}] nf=0 ${type} estimate 收工期：200 + 响应回带 + 2.5 落库 + dev_estimated_at 同条 UPDATE 原子落库 + timeline 文本未变形`);
    }
  }

  // ═══ [2] estimate 负例：缺工期 / 脏值 / 零副作用 ═══
  {
    const id = await seedToDev('feature', 0);
    const tlBefore = await tlCount(id);
    // [2a] 完全不传 → EFFORT_REQUIRED
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 400, `[2a] 缺工期期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[2a] 确切码 EFFORT_REQUIRED，实得 ${r.body.code}`);
    let d = await get('SELECT dev_estimated_at, estimated_effort_days FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(d.dev_estimated_at, null, '[2a] 零副作用：被拒后 dev_estimated_at 未落库（证明拦在写入前，不是写完再报错）');
    assert.strictEqual(d.estimated_effort_days, null, '[2a] 零副作用：工期列仍 NULL');
    assert.strictEqual(await tlCount(id), tlBefore, '[2a] 零副作用：timeline 零新增');
    ok('[2a] nf=0 feature estimate 不传工期 → 400 EFFORT_REQUIRED + 三项零副作用（预计完成/工期/timeline 全未动）');
    // [2b] 纯空白字符串（trim 后按未填处理，与前端"留空不传"同语义）→ 仍是 REQUIRED 不是格式错
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: '   ' });
    assert.strictEqual(r.status, 400, `[2b] 纯空白期望 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[2b] 纯空白归一为未填 → EFFORT_REQUIRED（非 INVALID_EFFORT_DAYS），实得 ${r.body.code}`);
    ok('[2b] estimate 工期传纯空白 "   " → 400 EFFORT_REQUIRED（trim 后按未填处理，与 /feasibility 的 EF11 同口径）');
    // [2c] 脏值（非 0.5 整数倍）→ 格式码 INVALID_EFFORT_DAYS（normalizeSysEffortDays 直出，与 /feasibility 同码）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1.3 });
    assert.strictEqual(r.status, 400, `[2c] 脏值期望 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', `[2c] 输入格式错的确切码 INVALID_EFFORT_DAYS（EFFORT_INVALID 是"存量脏值"专用码，两者语义不同不可混用），实得 ${r.body.code}`);
    ok('[2c] estimate 工期 1.3（非 0.5 整数倍）→ 400 INVALID_EFFORT_DAYS（走 normalizeSysEffortDays 直出，与 /feasibility 逐字同码）');
    // [2d] 值域外（>365）与类型外（布尔）——沿用 C2 收窄口径，证明 estimate 复用的是同一个归一函数而非自写一份
    for (const [label, val] of [['上界外 366', 366], ['布尔 true', true], ['单元素数组', [1]], ['十六进制串', '0x10']]) {
      r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: val });
      assert.strictEqual(r.status, 400, `[2d-${label}] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_EFFORT_DAYS', `[2d-${label}] 确切码 INVALID_EFFORT_DAYS，实得 ${r.body.code}`);
    }
    assert.strictEqual(await effortOf(id), null, '[2d] 四种畸形输入全部被拒后工期列仍 NULL');
    ok('[2d] estimate 工期畸形输入四向量（366 越界 / true / [1] / "0x10"）全部 400 INVALID_EFFORT_DAYS——证明本端点复用 normalizeSysEffortDays 的 269 号类型收窄，非另写一份宽松校验');
  }

  // ═══ [3] estimate 适用面闸：nf=1 不开旁路 ═══
  {
    const id = await seedToDev('feature', 1);
    // [3a] nf=1 单传工期 → 400 EFFORT_NOT_APPLICABLE（工期唯一写点在 /feasibility，不许从 estimate 绕进去）
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 400, `[3a] nf=1 传工期期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_NOT_APPLICABLE', `[3a] 确切码 EFFORT_NOT_APPLICABLE，实得 ${r.body.code}`);
    assert.strictEqual(await effortOf(id), null, '[3a] 零副作用：工期未被从 estimate 侧写进去（这正是本闸要防的绕过）');
    ok('[3a] nf=1 feature 从 estimate 传工期 → 400 EFFORT_NOT_APPLICABLE + 零写入（工期唯一写点恒在 /feasibility，estimate 不开旁路）');
    // [3b] nf=1 单不传工期 → 保持 C7 前的原 409 封口，逐字不变（证明适用面闸只对"真传了"的请求生效）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, `[3b] nf=1 不传工期期望 409（原封口），got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRES_FEASIBILITY', `[3b] 确切码 ESTIMATE_REQUIRES_FEASIBILITY（C7 前既有行为逐字保留），实得 ${r.body.code}`);
    ok('[3b] nf=1 feature estimate 不传工期 → 仍是原 409 ESTIMATE_REQUIRES_FEASIBILITY（C7 的新 400 只拦"真传了工期"的请求，既有封口行为零变化）');
  }

  // ═══ [4] estimate 适用面闸：bug 无工期维度 ═══
  {
    const id = await seedToDev('bug', 0);
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 400, `[4a] bug 传工期期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_NOT_APPLICABLE', `[4a] 确切码 EFFORT_NOT_APPLICABLE，实得 ${r.body.code}`);
    ok('[4a] bug estimate 传工期 → 400 EFFORT_NOT_APPLICABLE（对称 intake-accept 里 risk_level "bug 恒 NULL、传值即拒绝" 的既有处理形态，不静默忽略）');
    // [4b] bug 不传 → 照常 200，且响应体**不含**该键、列不被动（C7 对不适用类型行为零变化的正面证据）
    await run(`UPDATE sys_issues SET estimated_effort_days = 7 WHERE id = ?`, [id]);   // 人工造一个"本不该存在"的存量值
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, `[4b] bug 不传工期期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(!('estimated_effort_days' in r.body), `[4b] 不适用类型的响应体不应凭空多一个工期键，实得键=${Object.keys(r.body).join(',')}`);
    assert.strictEqual(await effortOf(id), 7, '[4b] bug 的存量工期值未被 estimate 抹成 NULL——C7 的 SET 片段按类型条件拼接，不追溯改既有数据（禁区：不追溯）');
    ok('[4b] bug estimate 不传工期 → 200 + 响应不含工期键 + 存量列值原样保留（不适用类型的 UPDATE 语句与 C7 前逐字相同，行为零变化）');

    // [4c/4d]（C7-fix MED-1）三态判据：显式 `null` 与空串 `''` 都算「未提供」，不触发适用面闸。
    //   判据与 case 'intake_accept' 的 riskProvided 同源（284 号 L-1 固化：API 调用方显式传 null ≈ 未传；
    //   前端表单在字段不适用时也常留空串）。C7 初版只判 `!== undefined`，这两种输入会被误当成"违规传值"
    //   而 400——拦的恰恰是意图正确的调用方。
    for (const [label, val] of [['显式 null', null], ['空串', '']]) {
      const r4c = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(33), estimated_effort_days: val });
      assert.strictEqual(r4c.status, 200, `[4c-${label}] bug 传 ${label} 应视同未传 → 200（非 400 EFFORT_NOT_APPLICABLE），got ${r4c.status} ${JSON.stringify(r4c.body)}`);
      assert.ok(!('estimated_effort_days' in r4c.body), `[4c-${label}] 响应仍不含工期键`);
      assert.strictEqual(await effortOf(id), 7, `[4c-${label}] 存量列值仍未被动（三态判据不改变"不适用类型不写该列"这条）`);
    }
    ok('[4c] bug estimate 传 `null` / `\'\'` → 均 200 视同未传（MED-1 三态判据，与 intake-accept 的 riskProvided 同源），响应不含工期键、存量列值不动');

    // [4d] nf=1 的 feature 传显式 null：三态判据下同样视同未传 → 应落回**原 409 封口**，而不是 400。
    //   这一条钉的是"MED-1 的放宽没有把封口撞松"——放宽只影响"传没传"的判定，不影响"该不该走 estimate"。
    const id4d = await seedToDev('feature', 1);
    for (const [label, val] of [['显式 null', null], ['空串', '']]) {
      const r4d = await call('POST', `/api/sys-issues/${id4d}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: val });
      assert.strictEqual(r4d.status, 409, `[4d-${label}] nf=1 传 ${label} 应视同未传 → 落回 409 封口, got ${r4d.status} ${JSON.stringify(r4d.body)}`);
      assert.strictEqual(r4d.body.code, 'ESTIMATE_REQUIRES_FEASIBILITY', `[4d-${label}] 确切码仍是 ESTIMATE_REQUIRES_FEASIBILITY（非 EFFORT_NOT_APPLICABLE），实得 ${r4d.body.code}`);
    }
    assert.strictEqual(await effortOf(id4d), null, '[4d] 零副作用：工期未被写入');
    ok('[4d] nf=1 feature estimate 传 `null` / `\'\'` → 仍是原 409 ESTIMATE_REQUIRES_FEASIBILITY（MED-1 的三态放宽只改"传没传"的判定，没把封口撞松）');

    // ═══ [4e/4f]（C7-fix2 L3·314-M1 裁定「不适用优先」的红灯看守）═══
    //   不适用单据传**畸形值**时，报的必须是"这个参数在这里不该出现"（EFFORT_NOT_APPLICABLE），而不是
    //   "你这个数字格式不对"（INVALID_EFFORT_DAYS）。后者会把调用方引到错误的修法上——照着格式码把
    //   1.3 改成 1.5 再试一次，只会撞上第二个错误码，绕一圈才走到真相。本组钉死这条 precedence：
    //   适用面闸在格式校验**之前**，且适用面闸不看值的格式。
    for (const [label, mkId, expectErrFrag] of [
      ['bug', async () => await seedToDev('bug', 0), '该类型单据无工期'],
      ['nf=1 feature', async () => await seedToDev('feature', 1), '该单需在可行性评估中填写工期'],
    ]) {
      const idBad = await mkId();
      const beforeEffort = await effortOf(idBad);
      const beforeStatus = await statusOf(idBad);
      const beforeTl = await tlCount(idBad);
      const rBad = await call('POST', `/api/sys-issues/${idBad}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1.3 });
      assert.strictEqual(rBad.status, 400, `[4e-${label}] 畸形值 1.3 期望 400, got ${rBad.status} ${JSON.stringify(rBad.body)}`);
      assert.strictEqual(rBad.body.code, 'EFFORT_NOT_APPLICABLE',
        `[4e-${label}] ⭐ 确切码必须是 EFFORT_NOT_APPLICABLE（不适用优先），而**不是** INVALID_EFFORT_DAYS${label === 'nf=1 feature' ? '，也不是 409 ESTIMATE_REQUIRES_FEASIBILITY（真传了参数时适用面闸先于封口）' : ''}，实得 ${rBad.body.code}`);
      assert.ok(String(rBad.body.error).includes(expectErrFrag), `[4e-${label}] 错误文案应指向"不该传"而非"格式不对"，实得 ${JSON.stringify(rBad.body.error)}`);
      // 零副作用三查（照 [4a] 范式）
      assert.strictEqual(await effortOf(idBad), beforeEffort, `[4e-${label}] 零副作用：工期列未变`);
      assert.strictEqual(await statusOf(idBad), beforeStatus, `[4e-${label}] 零副作用：状态未变`);
      assert.strictEqual(await tlCount(idBad), beforeTl, `[4e-${label}] 零副作用：timeline 零新增`);
      assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idBad])).dev_estimated_at, null, `[4e-${label}] 零副作用：预计完成也未被写入（整事务回滚）`);
    }
    ok('[4e] ⭐ 不适用优先 precedence（314-M1）：bug + 1.3 → 400 EFFORT_NOT_APPLICABLE（非 INVALID_EFFORT_DAYS）；nf=1 feature + 1.3 → 400 EFFORT_NOT_APPLICABLE（非 INVALID_EFFORT_DAYS、非 409 封口）——两例均附零副作用四查');

    // ═══ [4f]（C7-C9 收口批 M1）同病的另一半：**dev_estimated_at 格式错**也必须让位于不适用面 ═══
    //   C7-fix2 只把 estimated_effort_days 的格式错下沉到适用面闸之后，dev_estimated_at 仍留在事务外
    //   最前面。于是"bug 单/nf=1 单传了工期，顺手把日期也写错了"报的是 INVALID_ESTIMATE——调用方改对
    //   日期再试一次，才撞上真正的 EFFORT_NOT_APPLICABLE，绕的还是 314-M1 要消灭的那一圈。本组钉死
    //   重排后的三条：不适用面闸先于日期格式、封口 409 先于日期格式、**适用单据的日期→工期相对序不变**。
    const BAD_DATE = '随便不是日期';
    {
      // ① 不适用单据 × 畸形日期（且真传了工期，适用面闸才有输入）→ 恒 EFFORT_NOT_APPLICABLE
      for (const [label, mkId, expectErrFrag] of [
        ['bug', async () => await seedToDev('bug', 0), '该类型单据无工期'],
        ['nf=1 feature', async () => await seedToDev('feature', 1), '该单需在可行性评估中填写工期']
      ]) {
        const idBad = await mkId();
        const beforeStatus = await statusOf(idBad);
        const beforeTl = await tlCount(idBad);
        const rBad = await call('POST', `/api/sys-issues/${idBad}/estimate`, devTok, { dev_estimated_at: BAD_DATE, estimated_effort_days: 1 });
        assert.strictEqual(rBad.status, 400, `[4f-${label}] 畸形日期+工期 期望 400, got ${rBad.status} ${JSON.stringify(rBad.body)}`);
        assert.strictEqual(rBad.body.code, 'EFFORT_NOT_APPLICABLE',
          `[4f-${label}] ⭐ 确切码必须是 EFFORT_NOT_APPLICABLE（不适用优先），而**不是** INVALID_ESTIMATE——日期格式错已下沉到适用面闸之后，实得 ${rBad.body.code}`);
        assert.ok(String(rBad.body.error).includes(expectErrFrag), `[4f-${label}] 错误文案应指向"这个参数不该传"而非"日期格式不对"，实得 ${JSON.stringify(rBad.body.error)}`);
        // 零副作用四查（照 [4e] 范式）
        assert.strictEqual(await effortOf(idBad), null, `[4f-${label}] 零副作用：工期列未被写入`);
        assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idBad])).dev_estimated_at, null, `[4f-${label}] 零副作用：预计完成未被写入（整事务回滚）`);
        assert.strictEqual(await statusOf(idBad), beforeStatus, `[4f-${label}] 零副作用：状态未变`);
        assert.strictEqual(await tlCount(idBad), beforeTl, `[4f-${label}] 零副作用：timeline 零新增`);
      }
      ok('[4f-①] ⭐ 不适用优先 precedence 覆盖 dev_estimated_at（收口批 M1）：bug + 畸形日期 → 400 EFFORT_NOT_APPLICABLE；nf=1 feature + 畸形日期 → 400 EFFORT_NOT_APPLICABLE（两例均非 INVALID_ESTIMATE）+ 零副作用四查');

      // ② nf=1 单只写错日期、**不传工期**（适用面闸无输入 → 由封口接住）→ 仍是原 409，不是日期格式码。
      //   这条钉的是"封口 409 也先于日期格式"这半边——只测 ① 的话，封口与日期格式的相对序仍是未钉状态。
      const idSeal = await seedToDev('feature', 1);
      const rSeal = await call('POST', `/api/sys-issues/${idSeal}/estimate`, devTok, { dev_estimated_at: BAD_DATE });
      assert.strictEqual(rSeal.status, 409, `[4f-②] nf=1 只畸形日期期望 409（封口）, got ${rSeal.status} ${JSON.stringify(rSeal.body)}`);
      assert.strictEqual(rSeal.body.code, 'ESTIMATE_REQUIRES_FEASIBILITY',
        `[4f-②] ⭐ 确切码 ESTIMATE_REQUIRES_FEASIBILITY（封口先于日期格式校验），非 INVALID_ESTIMATE，实得 ${rSeal.body.code}`);
      assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idSeal])).dev_estimated_at, null, '[4f-②] 零副作用：预计完成未被写入');
      ok('[4f-②] ⭐ nf=1 feature 只传畸形日期（不传工期）→ 仍是 409 ESTIMATE_REQUIRES_FEASIBILITY——封口 409 同样先于日期格式校验（重排前这里报的是 INVALID_ESTIMATE）');

      // ③ 正向对照：**适用单据**（nf=0 feature）日期与工期同时畸形 → 仍先报 INVALID_ESTIMATE。
      //   重排前 dev_estimated_at 校验在事务外最前面，本就先于工期格式错；下沉后必须把这条先后关系原样
      //   保住，否则"适用单据行为逐字不变"这句声称就是假的（[[feedback_verify_absolute_claims]]）。
      const idOk4f = await seedToDev('feature', 0);
      const tlBefore4f = await tlCount(idOk4f);
      const rOk4f = await call('POST', `/api/sys-issues/${idOk4f}/estimate`, devTok, { dev_estimated_at: BAD_DATE, estimated_effort_days: 1.3 });
      assert.strictEqual(rOk4f.status, 400, `[4f-③] 适用单据双畸形期望 400, got ${rOk4f.status} ${JSON.stringify(rOk4f.body)}`);
      assert.strictEqual(rOk4f.body.code, 'INVALID_ESTIMATE',
        `[4f-③] ⭐ 适用单据（nf=0 feature）日期+工期同时畸形时，**先**报 INVALID_ESTIMATE（相对序与重排前逐字相同，非 INVALID_EFFORT_DAYS），实得 ${rOk4f.body.code}`);
      assert.strictEqual(await effortOf(idOk4f), null, '[4f-③] 零副作用：工期列仍 NULL');
      assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idOk4f])).dev_estimated_at, null, '[4f-③] 零副作用：预计完成未被写入');
      assert.strictEqual(await tlCount(idOk4f), tlBefore4f, '[4f-③] 零副作用：timeline 零新增');
      // 只把日期改对（工期仍畸形）→ 换成工期码：证明上一条不是"日期码把工期错吞了"，两道闸都真在生效
      const rOk4f2 = await call('POST', `/api/sys-issues/${idOk4f}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1.3 });
      assert.strictEqual(rOk4f2.status, 400, `[4f-③b] 日期改对后仍应 400, got ${rOk4f2.status}`);
      assert.strictEqual(rOk4f2.body.code, 'INVALID_EFFORT_DAYS', `[4f-③b] 日期合法后轮到工期格式码 INVALID_EFFORT_DAYS，实得 ${rOk4f2.body.code}`);
      ok('[4f-③] ⭐ 适用单据（nf=0 feature）日期+工期双畸形 → 先 INVALID_ESTIMATE，日期改对后才轮到 INVALID_EFFORT_DAYS——两道格式闸相对序与重排前逐字相同（收口批 M1 只动不适用单据的行为）');
    }
  }

  // ═══ [4g] ⭐⭐ [C7-fix3 H·/estimate 防探知矩阵] **非在册** dev × 四向量 → 恒 403 NOT_ROSTERED ═══
  //   与 /feasibility 的 [6d] 同模板。重排前 /estimate 的侧漏形态：非在册用户拿错误码当探针，
  //     · 状态不在 W06 白名单 → 409 ESTIMATE_STATUS_INVALID，**文案里还带着状态名**（"当前状态「X」不可回填预计"）
  //     · 状态在白名单 + bug/nf=1 单传工期 → 400 EFFORT_NOT_APPLICABLE / 409 ESTIMATE_REQUIRES_FEASIBILITY（漏 type/nf）
  //     · 状态在白名单 + 畸形日期 → 400 INVALID_ESTIMATE（漏"这单在开发中"）
  //     · 全合法 → 才终于 403
  //   重排后（assertDevMember 前移到状态闸之前）：以上四种回答全部收敛成一个 403。
  //   ⚠️ 断言强度：必须逐向量断**确切码 NOT_ROSTERED**——只断 403 的话，中间件层的别的 403 也能让它绿。
  {
    const NR_VECTORS = [
      ['合法', { dev_estimated_at: EST, estimated_effort_days: 2 }],
      ['畸形日期', { dev_estimated_at: '随便不是日期', estimated_effort_days: 2 }],
      ['畸形工期', { dev_estimated_at: EST, estimated_effort_days: 1.3 }],
      ['不传工期', { dev_estimated_at: EST }]
    ];
    // ① 适用单据（nf=0 feature·状态开发中）× 非在册 dev2（id 6；seedToDev 恒指派给 5）
    const idNr = await seedToDev('feature', 0);
    const beforeNr4g = { effort: await effortOf(idNr), status: await statusOf(idNr), tl: await tlCount(idNr), est: (await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idNr])).dev_estimated_at };
    for (const [label, body] of NR_VECTORS) {
      const r = await call('POST', `/api/sys-issues/${idNr}/estimate`, dev2Tok, body);
      assert.strictEqual(r.status, 403, `[4g-①-${label}] 非在册期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'NOT_ROSTERED',
        `[4g-①-${label}] ⭐ 确切码必须是 NOT_ROSTERED——不是 INVALID_ESTIMATE / INVALID_EFFORT_DAYS / EFFORT_REQUIRED 任何一个（那些都会把"这单在开发中且是 nf=0 变更类"漏给未授权者），实得 ${r.body.code}`);
    }
    // 零副作用四查（照 [4e]/[4f] 范式）
    assert.strictEqual(await effortOf(idNr), beforeNr4g.effort, '[4g-①] 零副作用：工期列未变');
    assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [idNr])).dev_estimated_at, beforeNr4g.est, '[4g-①] 零副作用：预计完成未被写入');
    assert.strictEqual(await statusOf(idNr), beforeNr4g.status, '[4g-①] 零副作用：状态未变');
    assert.strictEqual(await tlCount(idNr), beforeNr4g.tl, '[4g-①] 零副作用：timeline 零新增');
    ok('[4g-①] ⭐⭐ [C7-fix3 H] 非在册 dev × 四向量（合法/畸形日期/畸形工期/不传工期）→ **恒 403 NOT_ROSTERED** + 零副作用四查——错误码探针失效（重排前这四格会回 403/400/400/400 四种不同答案）');

    // ② 不适用单据（bug / nf=1）× 非在册 → 403，而不是会漏 type/nf 的 400/409
    for (const [label, mk] of [
      ['bug 单', async () => await seedToDev('bug', 0)],
      ['nf=1 变更单', async () => await seedToDev('feature', 1)]
    ]) {
      const idX = await mk();
      const r = await call('POST', `/api/sys-issues/${idX}/estimate`, dev2Tok, { dev_estimated_at: EST, estimated_effort_days: 2 });
      assert.strictEqual(r.status, 403, `[4g-②-${label}] 期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'NOT_ROSTERED',
        `[4g-②-${label}] ⭐ 非在册者不得拿到 EFFORT_NOT_APPLICABLE / ESTIMATE_REQUIRES_FEASIBILITY（分别泄露 type 与 needs_feasibility），实得 ${r.body.code}`);
    }
    ok('[4g-②] ⭐ 不适用单据（bug / nf=1）× 非在册 → 403 NOT_ROSTERED，而非会泄露 type/needs_feasibility 的 400/409——鉴权先于适用面闸与封口');

    // ③ 状态不对 × 非在册 → 403（鉴权先于状态闸）；配对正例：状态不对 × **在册** → 仍 409 ESTIMATE_STATUS_INVALID
    const idBadStatus = await seedToDev('feature', 0);
    await run(`UPDATE sys_issues SET status = '待验证' WHERE id = ?`, [idBadStatus]);
    let r4g = await call('POST', `/api/sys-issues/${idBadStatus}/estimate`, dev2Tok, { dev_estimated_at: EST, estimated_effort_days: 2 });
    assert.strictEqual(r4g.status, 403, `[4g-③] 非在册 + 状态不对期望 403, got ${r4g.status} ${JSON.stringify(r4g.body)}`);
    assert.strictEqual(r4g.body.code, 'NOT_ROSTERED',
      `[4g-③] ⭐⭐ 确切码 NOT_ROSTERED 而非 ESTIMATE_STATUS_INVALID——后者的错误文案里直接带着状态名（"当前状态「待验证」不可回填预计"），等于把状态字符串念给未授权者听，实得 ${r4g.body.code}`);
    r4g = await call('POST', `/api/sys-issues/${idBadStatus}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 2 });
    assert.strictEqual(r4g.status, 409, `[4g-③配对] 在册 + 状态不对应 409, got ${r4g.status} ${JSON.stringify(r4g.body)}`);
    assert.strictEqual(r4g.body.code, 'ESTIMATE_STATUS_INVALID',
      `[4g-③配对] ⭐ 在册成员照常拿到 ESTIMATE_STATUS_INVALID——证明状态闸本身没被重排改坏，403 只对非在册者生效（双向证明，非"dev2 恒被拒"的单向观察），实得 ${r4g.body.code}`);
    ok('[4g-③] ⭐ 状态不对 × 非在册 → 403 NOT_ROSTERED（鉴权先于状态闸）+ 配对正例：状态不对 × **在册** 仍得 409 ESTIMATE_STATUS_INVALID（双向证明，状态闸未被改坏）');
  }

  // ═══ [5] estimate 同值 no-op 的双字段口径（C7 引入的回归网）═══
  {
    const id = await seedToDev('feature', 0);
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, '[5-前置] 首次 estimate 200');
    const tlAfterFirst = await tlCount(id);
    // [5a] 两个字段都没变 → 仍应短路成 unchanged（原 §7 M-3 同值 no-op 语义保持，防重复推送需求方钉钉）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    assert.strictEqual(r.status, 200, '[5a] 同值重提 200');
    assert.strictEqual(r.body.unchanged, true, `[5a] 两字段皆未变应短路 unchanged=true，实得 ${JSON.stringify(r.body)}`);
    assert.strictEqual(await tlCount(id), tlAfterFirst, '[5a] unchanged 分支 timeline 零新增（§7 M-3 语义保持）');
    ok('[5a] estimate 同值 no-op 保持：预计完成与工期**都**没变 → unchanged=true + timeline 零新增（C7 没把既有的重复推送防护改坏）');
    // [5b] ⭐ 核心：时间不变、只改工期——必须真写入。若 no-op 条件仍是"只比时间"，这里会被短路成
    //   unchanged，工期静默丢失而前端还收到成功提示（C7 双字段写点最容易漏的一个坑）。
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 4 });
    assert.strictEqual(r.status, 200, '[5b] 只改工期 200');
    assert.ok(!r.body.unchanged, `[5b] ⭐ 只改工期不得被判为 unchanged（否则工期静默丢失），实得 ${JSON.stringify(r.body)}`);
    assert.strictEqual(await effortOf(id), 4, '[5b] ⭐ 工期真的从 1 改成了 4 并落库');
    assert.strictEqual(await tlCount(id), tlAfterFirst + 1, '[5b] 真变更照常写 timeline（+1）');
    ok('[5b] ⭐ estimate 时间不变只改工期（1→4）：不被 no-op 短路、值真落库、timeline +1——坐实同值判据已随双字段写点同步扩展（[[feedback_write_read_same_semantic]]）');
  }

  // ═══ [6] feasibility improvement 必填同构 ═══
  {
    const id = await seedToDev('improvement', 1);
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: EST });
    assert.strictEqual(r.status, 400, `[6a] improvement 缺工期期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[6a] 确切码 EFFORT_REQUIRED（与 feature 同码），实得 ${r.body.code}`);
    const d = await get('SELECT feasibility_conclusion, dev_estimated_at, estimated_effort_days FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(d.feasibility_conclusion, null, '[6a] 零副作用：评估结论未落库');
    assert.strictEqual(d.dev_estimated_at, null, '[6a] 零副作用：预计完成未落库');
    assert.strictEqual(d.estimated_effort_days, null, '[6a] 零副作用：工期列仍 NULL');
    ok('[6a] nf=1 improvement feasibility 缺工期 → 400 EFFORT_REQUIRED + 三项零副作用（C2 的"improvement 选填"口径已废止，与 feature 完全同构）');
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 200, `[6b] improvement 补工期期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await effortOf(id), 3, '[6b] improvement 工期 3 落库');
    const fb = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(/工期：3人日/.test(fb.summary), `[6b] feasibility timeline 快照含工期文本（C2 既有快照扩展对 improvement 同样生效），实得 ${fb.summary}`);
    ok('[6b] improvement 补上工期 → 200 + 落库 + timeline 快照含"工期：3人日"（拦截可解除，非只测拦得住的半向验证）');
  }

  // ═══ [6c]（C8-fix Q1·315）/feasibility 端点适用面优先——三类 × 三向量回归矩阵 ═══
  //   重排前：payload 八项在事务外先跑，于是 bug 单传个畸形日期拿到的是 INVALID_ESTIMATE（"日期格式不对"），
  //   而真问题是**这个端点不服务 bug 单**——照格式码改对了也只会撞第二个错误码。与 C7-fix2 M1 修 /estimate
  //   的是同一个病（不适用优先），315 表态要求端点级整体跟进。本组把三类单据 × 三种畸形 payload 全测一遍。
  {
    const VECTORS = [
      ['畸形日期', { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: '随便不是日期', estimated_effort_days: 1 }],
      ['畸形工期', { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 1.3 }],
      ['缺失必填', { conclusion: '可行', dev_estimated_at: EST, estimated_effort_days: 1 }],   // 缺 requirement_confirm
    ];
    // [C7-C9 收口批 L1] 零副作用三查补齐——**①②③ 三组同款**（主会话裁定扩面：原派单以为 ①② 已有，
    //   实际三组都只断了 status+code）。只断"错误码对不对"是半向验证：它不排除**别的字段被写了一半**
    //   ——本端点的 UPDATE 是六列一条语句（评估三列 + dev_estimated_at + estimated_effort_days + updated_at），
    //   畸形 payload 若在错误的位置被拦，完全可能出现"结论没落、预计完成落了"这种半写入，而三组的断言都
    //   看不见。故按本文件既定纪律（落库列 / 状态 / timeline 三查，见文件头「断言纪律」）取前置快照，
    //   三向量跑完后逐项比对。抽成本块内的小 helper 而非复制三遍：三组的零副作用口径必须**同一份**，
    //   复制粘贴迟早漂移（改一处漏两处，正是断言强度悄悄退化的典型来路）。
    //   ⭐⭐ [C8-fix2 M2'·撤回旧推理] 上一版把 updated_at 排除在快照外，理由是"同一条 UPDATE 必同写，五列
    //     任一未变则它也未写"。**该推理已被 codex 316-C 反例推翻**：一个错误实现完全可以把五列**复写成原值**
    //     （值不变）同时把 updated_at 推进——即一次"空转写"。此时五列比对全过、timeline 也可能没新增，
    //     而事务其实真的写了库。排除 updated_at 等于把唯一能看见这种空转写的证据也排除掉了。
    //     现在把它纳入快照，断的是**请求前后 strictEqual**（不是断某个具体时间值、更不是断 NULL）——
    //     不依赖任何预期时间，故**没有时钟脆弱性**；而只要发生空转写，它就会变，本条立刻红。
    //   ⚠️ 前置快照对**五个业务列**断言全 NULL（updated_at 不在此列——它建单时就有值，断 NULL 必假）：
    //     否则夹具若预先种了值，"改前==改后"会自然成立，这条断言就退化成恒真
    //     （[[feedback_test_assertion_self_error]] 的断言永远成立形态）。
    const SIDE_COLS_6C = ['feasibility_conclusion', 'feasibility_requirement_confirm', 'feasibility_risk', 'dev_estimated_at', 'estimated_effort_days'];
    const SNAP_COLS_6C = [...SIDE_COLS_6C, 'updated_at']; // [M2'] 比对面 = 五个业务列 + updated_at
    // ⭐⭐ [C7-fix3 M2'·秒级假绿修·哨兵值范式] 只把 updated_at 纳入"前后 strictEqual"**还不够**：
    //   本仓的写点一律用 `datetime('now','localtime')`，**精度只到秒**。夹具刚建完单、紧接着就发被测请求，
    //   两者极可能落在**同一秒**——此时一次空转写把 updated_at 写回**同一个字符串**，strictEqual 照样成立，
    //   断言假绿（而且是"跑得越快越容易假绿"这种最坏的时序依赖）。
    //   修法=本仓既有的**哨兵值范式**：快照**之前**直连 SQL 把 updated_at 钉成一个确定的历史值，被测请求
    //   跑完后断言它**仍是那个哨兵值**。任何 UPDATE 都会把它改成当前时刻（绝不可能等于 2020 年），
    //   于是"同秒巧合"这条假绿路径被彻底堵死——断言不再依赖两次时间戳是否恰好不同。
    const UPDATED_AT_SENTINEL_6C = '2020-01-01 00:00:00';
    const stampSentinel6c = async (id) => {
      await run(`UPDATE sys_issues SET updated_at = ? WHERE id = ?`, [UPDATED_AT_SENTINEL_6C, id]);
      const chk = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(chk.updated_at, UPDATED_AT_SENTINEL_6C,
        `[6c/6d 哨兵前置] updated_at 应已被钉成哨兵值 ${UPDATED_AT_SENTINEL_6C}（钉不进去则后续"未被推进"的断言退化成恒真），实得 ${JSON.stringify(chk.updated_at)}`);
    };
    const snap6c = async (id) => ({
      row: await get(`SELECT ${SNAP_COLS_6C.join(', ')}, status FROM sys_issues WHERE id=?`, [id]),
      tl: await tlCount(id)
    });
    const assertNoSideEffect6c = async (id, before, tag) => {
      const after = await snap6c(id);
      // ⭐ [C7-fix3 补批 ④·LOW-2·与 c9 的 assertNoSideEffectC9 对称] 硬前置：快照前必须已钉过哨兵。
      //   作用是把两种红灯**在诊断层面分开**——「忘了钉哨兵」在这一行红（消息直接告诉你去补 stampSentinel6c），
      //   「真发生了空转写」在下方那条哨兵断言红。没有这一行的话，忘钉时 updated_at 会退化回"前后相等"，
      //   同秒空转写重新假绿，而且**不会有任何提示**——保护层静默少了一层，是最难发现的一类回归。
      assert.strictEqual(before.row.updated_at, UPDATED_AT_SENTINEL_6C,
        `${tag} 前置：快照前必须先调 stampSentinel6c(id) 把 updated_at 钉成 ${UPDATED_AT_SENTINEL_6C}（漏钉则 updated_at 比对退化成"前后相等"，秒级精度下空转写会假绿），实得 ${JSON.stringify(before.row.updated_at)}`);
      // 查①：六列落库值逐列未变（五个业务列另断前置为 NULL；updated_at 走"前后相等 + 绝对哨兵"双断）
      for (const col of SNAP_COLS_6C) {
        if (col !== 'updated_at') {
          assert.strictEqual(before.row[col], null, `${tag} 前置：${col} 应为 NULL（夹具没有预先种值，比对才有意义）`);
        }
        assert.strictEqual(after.row[col], before.row[col], `${tag} 零副作用：${col} 未被半写入（三次畸形提交后应仍为 ${JSON.stringify(before.row[col])}，实得 ${JSON.stringify(after.row[col])}）`);
      }
      // [M2'] updated_at 单独点名一句：它是**空转写**（五列复写原值 + 推进时间戳）的唯一可见证据。
      //   [C7-fix3 M2'] 断的是"仍等于哨兵值"而非"等于某个刚读到的当前时刻"——后者在同秒场景下会假绿。
      //   ⚠️ [补批 ⑥·LOW-3] updated_at 现为**双断**：上方循环里的"前后相等" + 本行的"绝对等于哨兵值"。
      //     两者不是重复——前者随 SNAP_COLS_6C 统一处理（新增列时自动纳入），后者把哨兵这个绝对基准钉死，
      //     使断言不依赖 before 快照本身是否正确。故此处不能写成"唯一/只"。
      assert.strictEqual(after.row.updated_at, UPDATED_AT_SENTINEL_6C,
        `${tag} 零副作用：updated_at 应仍是哨兵值 ${UPDATED_AT_SENTINEL_6C}——变了就说明发生了"复写原值的空转写"（事务真写了库），这是五列比对看不见的形态（316-C 反例）；用哨兵值而非"前后相等"是因为 datetime('now','localtime') 只到秒，同秒空转写会写回同一字符串造成假绿（316-R）`);
      // 查②：状态未变；查③：timeline 零新增（feasibility 快照是本端点唯一留痕，写了就说明事务没干净回滚）
      assert.strictEqual(after.row.status, before.row.status, `${tag} 零副作用：状态未变（应仍 ${before.row.status}，实得 ${after.row.status}）`);
      assert.strictEqual(after.tl, before.tl, `${tag} 零副作用：timeline 零新增（feasibility 快照未被写入），期望 ${before.tl} 实得 ${after.tl}`);
    };
    // ① bug（端点类型面外）→ 三向量全部 409 FEASIBILITY_NOT_APPLICABLE
    const idBug = await seedToDev('bug', 0);
    await stampSentinel6c(idBug); // [C7-fix3 M2'] 钉哨兵后再快照
    const before6cBug = await snap6c(idBug);
    for (const [label, body] of VECTORS) {
      const r = await call('POST', `/api/sys-issues/${idBug}/feasibility`, devTok, body);
      assert.strictEqual(r.status, 409, `[6c-bug-${label}] 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE', `[6c-bug-${label}] ⭐ 确切码 FEASIBILITY_NOT_APPLICABLE（不是 INVALID_ESTIMATE/INVALID_EFFORT_DAYS/FEASIBILITY_REQUIREMENT_REQUIRED 这些 payload 码），实得 ${r.body.code}`);
    }
    await assertNoSideEffect6c(idBug, before6cBug, '[6c-①]');
    ok('[6c-①] ⭐ bug 单 × 三畸形 payload（畸形日期/畸形工期/缺失必填）→ 全部 409 FEASIBILITY_NOT_APPLICABLE，一条 payload 码都不漏出（端点适用面优先）+ 零副作用三查（五列逐列未变 / 状态未变 / timeline 零新增，收口批 L1 补齐）');
    // ② nf=0 的 feature（类型对但本端点不适用）→ 三向量全部 409 FEASIBILITY_NOT_REQUIRED
    const idNf0 = await seedToDev('feature', 0);
    await stampSentinel6c(idNf0); // [C7-fix3 M2'] 钉哨兵后再快照
    const before6cNf0 = await snap6c(idNf0);
    for (const [label, body] of VECTORS) {
      const r = await call('POST', `/api/sys-issues/${idNf0}/feasibility`, devTok, body);
      assert.strictEqual(r.status, 409, `[6c-nf0-${label}] 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_REQUIRED', `[6c-nf0-${label}] ⭐ 确切码 FEASIBILITY_NOT_REQUIRED，实得 ${r.body.code}`);
    }
    await assertNoSideEffect6c(idNf0, before6cNf0, '[6c-②]');
    ok('[6c-②] ⭐ nf=0 feature × 三畸形 payload → 全部 409 FEASIBILITY_NOT_REQUIRED（第二道适用面闸同样先于 payload）+ 零副作用三查（五列逐列未变 / 状态未变 / timeline 零新增，收口批 L1 补齐）');
    // ③ 适用单据（nf=1 feature）→ 三向量各自拿到**原来的** payload 码（行为逐字不变，重排只挪整块位置）
    const idOk = await seedToDev('feature', 1);
    const EXPECT = { 畸形日期: 'INVALID_ESTIMATE', 畸形工期: 'INVALID_EFFORT_DAYS', 缺失必填: 'FEASIBILITY_REQUIREMENT_REQUIRED' };
    await stampSentinel6c(idOk); // [C7-fix3 M2'] 钉哨兵后再快照
    const before6cOk = await snap6c(idOk);
    for (const [label, body] of VECTORS) {
      const r = await call('POST', `/api/sys-issues/${idOk}/feasibility`, devTok, body);
      assert.strictEqual(r.status, 400, `[6c-适用-${label}] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, EXPECT[label], `[6c-适用-${label}] ⭐ 适用单据行为**逐字不变**：确切码应仍是 ${EXPECT[label]}，实得 ${r.body.code}`);
    }
    await assertNoSideEffect6c(idOk, before6cOk, '[6c-③]');
    ok('[6c-③] ⭐ 适用单据（nf=1 feature）× 三畸形 payload → 各自仍拿原 payload 码（INVALID_ESTIMATE / INVALID_EFFORT_DAYS / FEASIBILITY_REQUIREMENT_REQUIRED）+ 零副作用三查（六列逐列未变含 updated_at / 状态未变 / timeline 零新增，收口批 L1 + C8-fix2 M2-prime）——重排只把整块挪到适用面闸之后，八项相对序与错误码逐字未动');

    // ═══ [6d] ⭐⭐ [C8-fix2 H·防探知矩阵] **非在册** dev × 四向量 → 恒 403 NOT_ROSTERED ═══
    //   这是本次重排真正要证的东西：未授权者**拿不到任何单据属性信息**。
    //   重排前的侧漏形态（codex 316-C 实证）：同一个 id 打不同 payload，非在册用户能靠错误码差异做探针——
    //     bug/config 单回 409 FEASIBILITY_NOT_APPLICABLE（漏 type）、nf=0 回 409 FEASIBILITY_NOT_REQUIRED
    //     （漏 needs_feasibility）、畸形 payload 回 400 payload 码（漏"这单是 nf=1 变更类"，因为它过了前两闸）、
    //     payload 全合法才终于 403。四种回答=四种情报。
    //   重排后：assertDevMember 排在全部业务属性闸之前 ⇒ 四向量恒 403。
    //   ⚠️ [C7-fix3 L2·声称收窄] 准确表述是「不泄露**已存在单据**的业务属性闸结果」，**不是**"一个字都不漏"：
    //     · **404 存在性仍然可见**——单据不存在时先得 404 SYS_ISSUE_NOT_FOUND，非在册者据此仍能区分
    //       "这个 id 有单"与"没单"。这是**既定资源策略**（本仓所有 :id 端点同款），不是本次重排的疏漏，
    //       也不在本批范围内；要改得整仓统一改成"未授权一律 404"，那是另一个量级的决策。
    //     · **assertKnownIssueStatus 抛的状态类异常同理**——它排在鉴权之前，脏状态单会先暴露这一事实。
    //     写死"一个字都不漏"是绝对词，且与实现不符（[[feedback_verify_absolute_claims]]）；本组真正钉的是
    //     "**已存在单据的 type / needs_feasibility / status / payload 合法性四类属性一个都问不出来**"。
    //   ⚠️ 断言强度要点：不能只断 403——必须断**确切码 NOT_ROSTERED**，否则别的 403（如中间件层鉴权）
    //     也能让它绿；且四向量要**各自**断，不能只测"合法 payload"那一格（恰恰是重排前唯一已经 403 的那格）。
    {
      const VECTORS_6D = [
        ['合法 payload', { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 1 }],
        ['畸形日期', { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: '随便不是日期', estimated_effort_days: 1 }],
        ['畸形工期', { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST, estimated_effort_days: 1.3 }],
        ['缺必填', { conclusion: '可行', dev_estimated_at: EST, estimated_effort_days: 1 }],
      ];
      // ① 适用单据（nf=1 feature）× 非在册 dev2（id 6，seedToDev 恒指派给 5）
      const idNr = await seedToDev('feature', 1);
      await stampSentinel6c(idNr); // [C7-fix3 M2'] 钉哨兵后再快照
      const beforeNr = await snap6c(idNr); // [C7-fix3 补批 ⑤·LOW-1] 缩进对齐回块级（原 4 空格是脚本批量插入时的残留）
      for (const [label, body] of VECTORS_6D) {
        const r = await call('POST', `/api/sys-issues/${idNr}/feasibility`, dev2Tok, body);
        assert.strictEqual(r.status, 403, `[6d-①-${label}] 非在册期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'NOT_ROSTERED',
          `[6d-①-${label}] ⭐ 确切码必须是 NOT_ROSTERED——不是 payload 码、不是 FEASIBILITY_* 任何一个（那些都会把单据属性漏给未授权者），实得 ${r.body.code}`);
      }
      await assertNoSideEffect6c(idNr, beforeNr, '[6d-①]');
      ok('[6d-①] ⭐⭐ [C8-fix2 H] 非在册 dev × 四向量（合法 payload/畸形日期/畸形工期/缺必填）→ **恒 403 NOT_ROSTERED** + 零副作用三查——错误码探针失效（重排前这四格会回 403/400/400/400 四种不同的答案）');

      // ② 不适用单据（bug / nf=0）× 非在册 → 同样 403，而不是那两个会漏 type/nf 的 409
      for (const [label, mk] of [
        ['bug 单', async () => await seedToDev('bug', 0)],
        ['nf=0 变更单', async () => await seedToDev('feature', 0)],
      ]) {
        const idX = await mk();
        const r = await call('POST', `/api/sys-issues/${idX}/feasibility`, dev2Tok, VECTORS_6D[0][1]);
        assert.strictEqual(r.status, 403, `[6d-②-${label}] 期望 403, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'NOT_ROSTERED',
          `[6d-②-${label}] ⭐ 非在册者不得拿到 FEASIBILITY_NOT_APPLICABLE / FEASIBILITY_NOT_REQUIRED（它们分别泄露 type 与 needs_feasibility），实得 ${r.body.code}`);
      }
      ok('[6d-②] ⭐ 不适用单据（bug / nf=0）× 非在册 → 403 NOT_ROSTERED，而非会泄露 type/needs_feasibility 的两个 409——鉴权先于适用面闸');

      // ③ 状态不对 / 受阻 × 非在册 → 仍 403（鉴权先于状态闸与受阻闸）
      const idBadStatus = await seedToDev('feature', 1);
      await run(`UPDATE sys_issues SET status = '待验证' WHERE id = ?`, [idBadStatus]);
      let r6d = await call('POST', `/api/sys-issues/${idBadStatus}/feasibility`, dev2Tok, VECTORS_6D[0][1]);
      assert.strictEqual(r6d.status, 403, `[6d-③状态] 期望 403, got ${r6d.status} ${JSON.stringify(r6d.body)}`);
      assert.strictEqual(r6d.body.code, 'NOT_ROSTERED', `[6d-③状态] 确切码 NOT_ROSTERED（非 FEASIBILITY_STATUS_INVALID），实得 ${r6d.body.code}`);
      const idBlocked = await seedToDev('feature', 1);
      r6d = await call('POST', `/api/sys-issues/${idBlocked}/blocked`, devTok, { reason: 'C8-fix2 [6d] 构造受阻单' });
      assert.strictEqual(r6d.status, 200, `[6d-③受阻-前置] 在册 dev 标记受阻应 200, got ${r6d.status} ${JSON.stringify(r6d.body)}`);
      r6d = await call('POST', `/api/sys-issues/${idBlocked}/feasibility`, dev2Tok, VECTORS_6D[0][1]);
      assert.strictEqual(r6d.status, 403, `[6d-③受阻] 期望 403, got ${r6d.status} ${JSON.stringify(r6d.body)}`);
      assert.strictEqual(r6d.body.code, 'NOT_ROSTERED', `[6d-③受阻] 确切码 NOT_ROSTERED（非 ISSUE_BLOCKED），实得 ${r6d.body.code}`);
      // 配对正例（双向证明，防"本组只是因为 dev2 恒被拒"）：**在册** dev 打同一个受阻单 → 拿到 ISSUE_BLOCKED
      r6d = await call('POST', `/api/sys-issues/${idBlocked}/feasibility`, devTok, VECTORS_6D[0][1]);
      assert.strictEqual(r6d.status, 409, `[6d-③配对] 在册 dev 打受阻单应 409, got ${r6d.status} ${JSON.stringify(r6d.body)}`);
      assert.strictEqual(r6d.body.code, 'ISSUE_BLOCKED',
        `[6d-③配对] ⭐ 在册成员照常拿到 ISSUE_BLOCKED——证明受阻闸本身没被重排改坏，403 只对非在册者生效（双向证明），实得 ${r6d.body.code}`);
      ok('[6d-③] ⭐ 状态不对 / 受阻单 × 非在册 → 均 403 NOT_ROSTERED（鉴权先于状态闸与受阻闸）+ 配对正例：**在册** dev 打同一受阻单仍得 409 ISSUE_BLOCKED（双向证明，闸本身未被改坏）');
    }
  }

  // ═══ [7] submit 闸全链：nf=0 存量单被拦 → 补填 → 放行 ═══
  {
    for (const type of ['feature', 'improvement']) {
      const id = await seedToDev(type, 0);
      // 直连 SQL 只写 dev_estimated_at 不写工期——精确复刻本地 5 单在途存量的形态（C7 前合法落库的单）
      await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [EST + ':00', id]);
      assert.strictEqual(await effortOf(id), null, `[7-${type}-前置] 构造出的存量单确是"有预计完成、无工期"（C7 前完全合法）`);
      let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
      assert.strictEqual(r.status, 400, `[7-${type}] 存量单 submit 期望被拦 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[7-${type}] 确切码 EFFORT_REQUIRED，实得 ${r.body.code}`);
      assert.strictEqual(r.body.error, '请先在估时中填写工期（人日）', `[7-${type}] ⭐ nf=0 的报错文案必须指路到「估时」入口（存量在途单的唯一出路），实得 ${JSON.stringify(r.body.error)}`);
      // [C7-fix LOW-1] 原写法是 `type === 'feature' ? '开发中' : '开发中'` —— 两个分支同值的恒等三元，
      //   读起来像"两类型落态不同"其实完全一样，是**假装有区分**的噪音（同 [[feedback_comment_is_review_input]]
      //   的同族问题：形式上的分支在暗示一条并不存在的规则）。直写常量。
      assert.strictEqual(await statusOf(id), '开发中', `[7-${type}] 被拦后状态不动（feature/improvement 的开发态同名，无需按类型分岔）`);
      // 按文案去估时补填 → 再 submit 放行
      r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 2 });
      assert.strictEqual(r.status, 200, `[7-${type}] 按文案走估时补填期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(await effortOf(id), 2, `[7-${type}] 补填后工期落库`);
      r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
      assert.strictEqual(r.status, 200, `[7-${type}] 补填后 submit 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.main_status, '待验证', `[7-${type}] 补填后真推进到待验证，实得 ${r.body.main_status}`);
      ok(`[7-${type}] ⭐ nf=0 ${type} 存量在途单全链：submit 被拦 400 EFFORT_REQUIRED（文案指路"估时"）→ 走估时端点补填 2 人日 → 再 submit 放行到「待验证」——文案指的那条路真的走得通`);
    }
  }

  // ═══ [8] submit 闸 nf=1 improvement 同构 + 存量脏值 EFFORT_INVALID ═══
  {
    // [8a] nf=1 improvement：评估已过但工期被人工清空（模拟历史数据/直连 SQL 改动）→ submit 拦，文案指"可行性评估"
    const id = await seedToDev('improvement', 1);
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 200, '[8a-前置] improvement 评估 200');
    await run(`UPDATE sys_issues SET estimated_effort_days = NULL WHERE id = ?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 400, `[8a] nf=1 improvement 缺工期 submit 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[8a] 确切码 EFFORT_REQUIRED，实得 ${r.body.code}`);
    assert.strictEqual(r.body.error, '请先在可行性评估中填写工期（人日）', `[8a] ⭐ nf=1 的报错文案必须指路到「可行性评估」入口（与 nf=0 的"估时"分岔），实得 ${JSON.stringify(r.body.error)}`);
    ok('[8a] nf=1 improvement submit 缺工期 → 400 EFFORT_REQUIRED 且文案指路「可行性评估」——两条补填入口按 needs_feasibility 正确分岔（C7 前 improvement 在此处根本不受检）');
    // [8b] 存量脏值分支：非 0.5 整数倍的历史值 → EFFORT_INVALID。
    //   ⚠️ 本文件的内存库走的是**新库 CREATE 路径**，DDL CHECK 在位，脏值直连 SQL 也插不进去；而真实缺口
    //   在**旧库 ALTER 路径**（alterAddMissingCols 补列时不带 CHECK，C1 既有降级拍板），那条路径上的生产
    //   库确实能合法落进 1.3 这种值。用 PRAGMA ignore_check_constraints 绕过本地 CHECK 来复现那个环境，
    //   是"构造真实存在但本地 schema 挡住的场景"，不是绕过被测逻辑（被测的是 submit 闸的读侧复查）。
    //   用完立即复位，避免放宽的约束泄漏到本文件后续用例（同 verify-sys-release-c4a [6-脏值] 范式）。
    await run(`PRAGMA ignore_check_constraints = ON`);
    try {
      await run(`UPDATE sys_issues SET estimated_effort_days = 1.3 WHERE id = ?`, [id]);
    } finally {
      await run(`PRAGMA ignore_check_constraints = OFF`);
    }
    assert.strictEqual(await effortOf(id), 1.3, '[8b-前置] 脏值 1.3 确已落库（防夹具自己变假——若 PRAGMA 没生效，这里会先红）');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 400, `[8b] 存量脏值 submit 期望 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'EFFORT_INVALID', `[8b] 存量脏值确切码 EFFORT_INVALID（与"从没填过"的 EFFORT_REQUIRED 区分开，运维能分清两类问题），实得 ${r.body.code}`);
    assert.ok(/可行性评估/.test(r.body.error), `[8b] 脏值文案同样按 nf 指路，实得 ${JSON.stringify(r.body.error)}`);
    ok('[8b] nf=1 improvement 存量脏值 1.3 → 400 EFFORT_INVALID（非 EFFORT_REQUIRED）+ 文案同样指路「可行性评估」——269 号 M-1 的存储值复查对 improvement 同样生效');
    // [8c] 改回合法值 → 放行（证明脏值分支可解除）
    await run(`UPDATE sys_issues SET estimated_effort_days = 1.5 WHERE id = ?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 200, `[8c] 脏值改回合法后 submit 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8c] 脏值改回 1.5 → submit 放行 200（脏值拦截可解除，非死锁）');
  }

  // ═══ [9] GATE 静默 defer 语义保持（非 submit 路径）═══
  {
    // 构造：nf=0 improvement，两名开发在册，其中一人已完成、另一人被 excuse（开脱）→ 触发 W-GATE 判定
    //   "全员完成态"。C7 前 GATE 对 nf=0 单不看工期，会直接推到待验证；C7 后工期为空 → 资格未过 →
    //   **静默 defer**（不报错、打 gate_deferred_at 标）。这条语义必须原样保持——GATE 从来不是给用户
    //   报错的地方，它只负责"够格才推"，不够格就挂起等资格修复（100 号 HIGH-1 方案 A）。
    const id = await seedToDev('improvement', 0);
    await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, [EST + ':00', id]);
    let r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, '[9-前置] 加协作开发 dev2 应 200');
    r = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, SUBMIT_BODY);
    assert.strictEqual(r.status, 400, '[9-前置] dev2 submit 应被工期闸拦（本组要走的是非 submit 路径，先确认 submit 这条路确实堵着）');
    // [C7-fix LOW-2] 补确切码：只断 400 不断码，"被别的闸拦下"（如 ISSUE_BLOCKED / FEASIBILITY_*）也会让
    //   这条绿，本组"submit 这条路是被**工期闸**堵着"的前提就没真验到（[[feedback_test_assertion_self_error]]
    //   的断言强度问题）。
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[9-前置] 拦下 dev2 submit 的必须是工期闸 EFFORT_REQUIRED（不是别的闸顺手挡住），实得 ${r.body && r.body.code}`);
    // 走 excuse（非 submit 路径）把两名开发都变成完成态 → 触发 runWGate
    const rows = await all(`SELECT id, user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY user_id`, [id]);
    assert.strictEqual(rows.length, 2, '[9-前置] 在册 2 名开发');
    for (const row of rows) {
      r = await call('POST', `/api/sys-issues/${id}/dev-assignees/${row.id}/excuse`, adminTok, { reason: 'C7 GATE 静默 defer 验证' });
      assert.strictEqual(r.status, 200, `[9-前置] excuse dev${row.user_id} 应 200（GATE 不够格也不该让 excuse 本身失败），got ${r.status} ${JSON.stringify(r.body)}`);
    }
    let d = await get('SELECT status, gate_deferred_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(d.status, '开发中', `[9a] ⭐ 全员完成态但工期未填 → GATE 资格未过，主状态仍「开发中」未被推到待验证，实得 ${d.status}`);
    assert.ok(d.gate_deferred_at, '[9a] ⭐ GATE 打了 gate_deferred_at 标（静默 defer 的证据：不报错但记下"等资格修复"）');
    ok('[9a] ⭐ GATE 非 submit 路径（excuse 触发 W-GATE）工期缺失：excuse 本身 200 不报错 + 主状态不推进 + gate_deferred_at 打标——静默 defer 语义原样保持（C7 只扩判据覆盖面，没把 GATE 改成会报错的闸）');
    // [9b] 补填工期 → estimate 事务尾部消费 gate_deferred_at 标重跑 runWGate → 同事务原子推进待验证
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(31), estimated_effort_days: 2 });
    assert.strictEqual(r.status, 200, `[9b] 补填工期期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    d = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(d.status, '待验证', `[9b] ⭐ 补填后经 gate_deferred_at 消费点原子推进到「待验证」，实得 ${d.status}`);
    ok('[9b] ⭐ 补填工期后 estimate 事务尾部消费 gate_deferred_at 重跑 runWGate → 同事务原子推进「待验证」——消费链（100 号方案 A）未被 C7 改动破坏，挂起的单能自愈');
  }

  // ═══ [10] 弹回场景：待验证 → return 弹回「开发中」后新规则仍生效 ═══
  {
    const id = await seedToDev('improvement', 1);
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: EST, estimated_effort_days: 3 });
    assert.strictEqual(r.status, 200, '[10-前置] 评估 200');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 200, `[10-前置] submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[10-前置] 已到待验证');
    // 弹回
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: 'C7 弹回专项：验收不通过' });
    assert.strictEqual(r.status, 200, `[10a] return 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '开发中', '[10a] 弹回后回到「开发中」');
    assert.strictEqual(await effortOf(id), null, '[10a] ⭐ 换轮清空：return 把 estimated_effort_days 一并清成 NULL（§8 换轮清字段，工期随评估一起作废）');
    ok('[10a] 待验证 → return 弹回「开发中」：工期被换轮清空为 NULL（§8 既有换轮语义对 improvement 同样生效）');
    // [10b] 弹回后二轮评估仍受 C7 新规则约束：只填结论+预计完成、不填工期 → 400 EFFORT_REQUIRED。
    //   这是"弹回后新规则生效"最直接的打靶方式。刻意**不**用"弹回后直接 submit"来验——那条路会先撞
    //   ESTIMATE_REQUIRED（return 把 dev_estimated_at 也一并清了，且该闸 precedence 在工期闸之前），
    //   拿到的错误码根本不是工期闸给的，用它断言等于没测到本次改动（[[feedback_layer_green_not_feature_ready]]
    //   的变体：测了端到端，但打的不是真正要证的那个分支）。
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '二轮确认', dev_estimated_at: futureEst(32) });
    assert.strictEqual(r.status, 400, `[10b] 弹回后二轮评估缺工期期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `[10b] ⭐ 确切码 EFFORT_REQUIRED，实得 ${r.body.code}`);
    assert.strictEqual(await effortOf(id), null, '[10b] 零副作用：二轮被拒后工期仍 NULL');
    assert.strictEqual(await statusOf(id), '开发中', '[10b] 零副作用：状态仍「开发中」');
    ok('[10b] ⭐ 弹回「开发中」后二轮评估缺工期 → 仍 400 EFFORT_REQUIRED——弹回不是绕过工期闸的后门，improvement 必填在第二轮同样生效（刻意不拿"弹回后直接 submit"当证据：那条路先撞 ESTIMATE_REQUIRED，打不到工期闸）');
    // 顺带如实记录 submit 侧的 precedence（不作为工期闸的证据，只钉住"这条路确实也是堵的"）
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 400, `[10b-2] 弹回后未重填直接 submit 应被拦 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', `[10b-2] 该路径先撞的是 ESTIMATE_REQUIRED（return 把 dev_estimated_at 一并清空，该闸 precedence 在工期闸之前）——如实钉住现状，实得 ${r.body.code}`);
    ok('[10b-2] 弹回后直接 submit → 400 ESTIMATE_REQUIRED（precedence 如实记录：换轮清空了预计完成，先撞该闸；本条不充当工期闸的证据，见 [10b]）');
    // 重走评估（补工期）→ 放行
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '重新确认', dev_estimated_at: futureEst(32), estimated_effort_days: 1.5 });
    assert.strictEqual(r.status, 200, `[10c] 二轮评估期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await effortOf(id), 1.5, '[10c] 二轮工期 1.5 落库');
    // return 不重置 dev_assignees 完成态（同 reopen 语义，见 verify-sys-multidev-members S10g）——首轮 submit
    //   已把 dev(5) 的 roster 行推成 'no_code'，直接再 submit 会撞 INVALID_STATUS。正规重置手法是"临时加
    //   协作解除 LAST_ASSIGNEE 限制 → remove 旧实例 → re-add"（完整范式见 verify-sys-bug-transitions "二轮"），
    //   但本文件聚焦工期闸而非 roster 机制（后者已有 verify-sys-multidev-* 全覆盖），故直连 SQL 重置回
    //   pending——只动本用例不关注的 roster 字段，不触碰本组真正要验的工期/状态链路（同 verify-sys-release.js
    //   C6 回环处的既有取舍）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending', resolved_at=NULL WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, SUBMIT_BODY);
    assert.strictEqual(r.status, 200, `[10c] 二轮 submit 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[10c] 二轮真推进到待验证');
    ok('[10c] 弹回后重走评估补工期 1.5 → submit 放行到「待验证」（第二轮全链闭合，拦截可解除）');
  }

  console.log(`\n✅ verify-sys-effort-c7 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
