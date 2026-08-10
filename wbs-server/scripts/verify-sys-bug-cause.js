// scripts/verify-sys-bug-cause.js — C6「bug 提交必填产生原因」后端全套验收（B4）
//   用户拍板三条口径：①逐人填（各自 submit/no_code 事件独立承载）②每轮必填（打回重提第二轮同样必填，
//   不做首轮豁免）③no_code 模式同样必填（与 no_code_reason 并存，语义不同：no_code_reason=「为何无代码
//   交付」，bug_cause_note=「bug 为何产生」）。仅 type='bug' 适用。
//   用法：node scripts/verify-sys-bug-cause.js
//
// 覆盖（双向，每组都证"改动真发生"与"真被拦下且零副作用"两面）：
//   ①bug+commit mode 缺原因→400 BUG_CAUSE_REQUIRED+零副作用 ②bug+no_code mode 缺原因→400 ③bug 带原因→
//   200+payload_json 落值+详情读侧逐 dev 返回该值（+ bug_cause_records 单轮场景） ④feature 带非空原因→
//   400 BUG_CAUSE_NOT_APPLICABLE ⑤feature 不带→200（不受影响，+ bug_cause_records 恒 []） ⑥501 字→400、
//   恰 500 字→200（328a 回卷：⑥a 补失败即时 snapshot；⑥c 空串/⑥d 全空白→400 BUG_CAUSE_REQUIRED；
//   ⑥e trim 正例→200 落裁剪值；⑥f 500/501 个中文边界，防误用字节长度） ⑦每轮必填：bug 提交→打回(return)→
//   （remove+re-add 重置完成态实例，同 verify-sys-bug-transitions.js 既有"二轮"范式）同 dev 重新提交不带
//   原因→400（第二轮同样拦）→带原因→200（+ bug_cause_records 两轮历史可见性） ⑧非 string 类型→400
//   （328a 回卷：8a/8b 各自失败后独立 snapshot，不再共用一个前后对照）
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-cause-secret';
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

// 2026-08-01 日期炸弹教训：远期字面量迟早到期，动态生成（同既有 verify-sys-* 惯例）
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 建 bug 单 → intake-accept（bug 不带 risk_level）→ assign(devId) → 处理中（照抄 verify-sys-bug-transitions.js
// 的 seedBugToDev，本文件自成一体不 require 它）。
// [328a 回卷] 删未用参数 oaSeed（含全部调用处第三参）：函数体从未引用它——bug 流程不走 set-oa-number，
//   留着一个"看起来在传 OA 号种子"但其实全被丢弃的参数，容易误导后来者以为 bug 单也设了 OA 号。
async function seedBugToDev(devId, title) {
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'bug', title, system_name: 'BMS',
    source: '内部', description: '并发/必填 verify 夹具（bug）', intake_liaison_id: 13,
  });
  assert.strictEqual(r.status, 201, `[夹具-bug] 建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-bug] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, `[夹具-bug] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}

// 建 nf=0 feature 单 → 指派 → 开发中（用于 ④⑤ NOT_APPLICABLE/不受影响两组，需要非 bug 类型对照）。
async function seedFeatureToDev(devId, title, oaNumber) {
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'feature', title, system_name: 'BMS',
    source: '内部', description: '并发/必填 verify 夹具（feature 对照组）', intake_liaison_id: 13,
  });
  assert.strictEqual(r.status, 201, `[夹具-feature] 建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `[夹具-feature] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: oaNumber });
  assert.strictEqual(r.status, 200, `[夹具-feature] 补 OA 号应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, `[夹具-feature] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}

// 零副作用快照：dev_status/commit 计数/event 计数/主状态，四项一起比对（对照组思路：不该动的一样都不能动）。
async function snapshotDevState(issueId, userId) {
  const da = await get(`SELECT id, dev_status, resolved_at FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, userId]);
  const commitCount = (await get(`SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?`, [issueId])).c;
  const eventCount = (await get(`SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=?`, [issueId])).c;
  const status = (await get(`SELECT status FROM sys_issues WHERE id=?`, [issueId])).status;
  return { daId: da ? da.id : null, devStatus: da ? da.dev_status : null, resolvedAt: da ? da.resolved_at : null, commitCount, eventCount, status };
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
    // ══ ①bug + commit mode 缺原因 → 400 BUG_CAUSE_REQUIRED + 零副作用 ══════════════════════
    const id1 = await seedBugToDev(5, 'bug-cause-①');
    await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const before1 = await snapshotDevState(id1, 5);
    assert.strictEqual(before1.devStatus, 'pending', '[① 前置] estimate 后 dev_status 仍应 pending');
    let r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-1' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 400, `[①] commit 模式缺 bug_cause_note 应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_REQUIRED', `[①] 确切码 BUG_CAUSE_REQUIRED，实得 ${r.body.code}`);
    const after1 = await snapshotDevState(id1, 5);
    assert.deepStrictEqual(after1, before1, '[①] 零副作用：dev_status/commit 计数/event 计数/主状态四项全未变（拒绝发生在 UPDATE dev_status 之前）');
    ok('[①] bug + commit 模式缺 bug_cause_note → 400 BUG_CAUSE_REQUIRED，dev_status 未翻、零副作用');

    // ══ ②bug + no_code mode 缺原因 → 400 BUG_CAUSE_REQUIRED ═════════════════════════════════
    const id2 = await seedBugToDev(5, 'bug-cause-②');
    await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const before2 = await snapshotDevState(id2, 5);
    r = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, {
      mode: 'no_code', no_code_reason: '无需改代码（占位理由）', self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 400, `[②] no_code 模式缺 bug_cause_note 应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_REQUIRED', `[②] 确切码 BUG_CAUSE_REQUIRED，实得 ${r.body.code}`);
    const after2 = await snapshotDevState(id2, 5);
    assert.deepStrictEqual(after2, before2, '[②] 零副作用：no_code 模式同样在写入前拦下');
    ok('[②] bug + no_code 模式缺 bug_cause_note → 400 BUG_CAUSE_REQUIRED（与①同码，两种 mode 都拦）');

    // ══ ③bug 带原因 → 200 + payload_json 落值 + 详情读侧逐 dev 返回该值 ═══════════════════════
    const id3 = await seedBugToDev(5, 'bug-cause-③');
    await call('POST', `/api/sys-issues/${id3}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const CAUSE3 = '第三方接口返回格式变更未同步适配';
    r = await call('POST', `/api/sys-issues/${id3}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-3' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: CAUSE3,
    });
    assert.strictEqual(r.status, 200, `[③] bug 带原因应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const ev3 = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id3]);
    assert.ok(ev3, '[③] 应有 1 条 submit 事件');
    assert.strictEqual(JSON.parse(ev3.payload_json).bug_cause_note, CAUSE3, '[③] payload_json.bug_cause_note 精确落值');
    const detail3 = await call('GET', `/api/sys-issues/${id3}`, devTok);
    assert.strictEqual(detail3.status, 200, `[③] 详情读取应 200，实得 ${detail3.status}`);
    const dev3Row = (detail3.body.dev_assignees || []).find(d => d.user_id === 5);
    assert.ok(dev3Row, '[③] 详情 dev_assignees 应含 user_id=5 该行（提交后仍在册，只是 dev_status 变了）');
    assert.strictEqual(dev3Row.bug_cause_note, CAUSE3, '[③] 详情读侧逐 dev 返回值精确等于写入值（写读同源）');
    ok('[③] bug 带原因 → 200，payload_json 精确落值，详情端点逐 dev 提取区正确回填 bug_cause_note（写读同源）');

    // [B6·MED-1] 单轮场景 bug_cause_records 应恰含 1 条、removed=false（未发生 remove+re-add，⑦组另测两轮场景）。
    const records3 = detail3.body.bug_cause_records;
    assert.ok(Array.isArray(records3), '[③ bug_cause_records] 应为数组');
    assert.strictEqual(records3.length, 1, `[③ bug_cause_records] 单轮场景应恰 1 条，实得 ${JSON.stringify(records3)}`);
    assert.strictEqual(records3[0].removed, false, '[③ bug_cause_records] 未 remove，removed=false');
    assert.strictEqual(records3[0].bug_cause_note, CAUSE3, '[③ bug_cause_records] 原因文本精确');
    assert.strictEqual(records3[0].user_id, 5, '[③ bug_cause_records] user_id 正确');
    assert.strictEqual(records3[0].dev_assignee_id, dev3Row.id, '[③ bug_cause_records] dev_assignee_id 与详情 devAssignees 行一致（同一实例）');
    ok('[③ bug_cause_records] 单轮场景恰 1 条记录，removed=false，字段精确（记录视角与在册视角在单轮场景下一致）');

    // ══ ④feature 带非空原因 → 400 BUG_CAUSE_NOT_APPLICABLE ═════════════════════════════════
    const id4 = await seedFeatureToDev(5, 'bug-cause-④-feature', '2026080204');
    await call('POST', `/api/sys-issues/${id4}/estimate`, devTok, { dev_estimated_at: futureEst(10), estimated_effort_days: 1 });
    const before4 = await snapshotDevState(id4, 5);
    r = await call('POST', `/api/sys-issues/${id4}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-4' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '不应该出现在 feature 单上',
    });
    assert.strictEqual(r.status, 400, `[④] feature 带 bug_cause_note 应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_NOT_APPLICABLE', `[④] 确切码 BUG_CAUSE_NOT_APPLICABLE，实得 ${r.body.code}`);
    const after4 = await snapshotDevState(id4, 5);
    assert.deepStrictEqual(after4, before4, '[④] 零副作用：不适用面拒绝同样发生在写入前');
    ok('[④] feature 带非空 bug_cause_note → 400 BUG_CAUSE_NOT_APPLICABLE（适用面误传一轮知根因，对齐 C7 EFFORT_NOT_APPLICABLE 范式）');

    // ══ ⑤feature 不带 → 200（不受影响，对照组：证①-④不是"全端点更严格"的误伤）═══════════════
    const id5 = await seedFeatureToDev(5, 'bug-cause-⑤-feature', '2026080205');
    await call('POST', `/api/sys-issues/${id5}/estimate`, devTok, { dev_estimated_at: futureEst(10), estimated_effort_days: 1 });
    r = await call('POST', `/api/sys-issues/${id5}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-5' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 200, `[⑤] feature 不带 bug_cause_note 应 200（不受影响），实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[⑤] feature 不带 bug_cause_note → 200，未被误伤（对照组：证明①-④不是全端点通用变严）');

    // [B6·MED-1] 非 bug 单详情 bug_cause_records 恒 []（响应契约的另一半：仅 type='bug' 非空）。
    const detail5 = await call('GET', `/api/sys-issues/${id5}`, devTok);
    assert.strictEqual(detail5.status, 200, `[⑤ bug_cause_records] 详情读取应 200，实得 ${detail5.status}`);
    assert.deepStrictEqual(detail5.body.bug_cause_records, [], '[⑤ bug_cause_records] ⭐ 非 bug 单（feature）详情 bug_cause_records 恒为空数组');
    ok('[⑤ bug_cause_records] feature 单详情 bug_cause_records 恒 []（响应契约"仅 bug 非空"的对照面）');

    // ══ ⑥501 字 → 400、恰 500 字 → 200（Unicode 码点计数，同 work_note 口径） ═══════════════
    const id6 = await seedBugToDev(5, 'bug-cause-⑥');
    await call('POST', `/api/sys-issues/${id6}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    // [328a 回卷] ⑥a 补失败后立即 snapshot 深比对：原先只靠"⑥b 紧接着能成功提交"间接证明⑥a零副作用，
    //   但那只能证明"状态没被污染到无法再提交"，证不了"⑥a 这次拒绝具体在哪个字段上留没留副作用"——
    //   万一长度闸拒绝逻辑意外在四项快照的某一项上留了痕迹，紧接着的成功提交会把它悄悄盖过去，间接证据
    //   看不出来。直接 before/after 深比对定位到"就是这一次拒绝，零副作用"。
    const before6a = await snapshotDevState(id6, 5);
    const note501 = 'x'.repeat(501);
    r = await call('POST', `/api/sys-issues/${id6}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6a' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: note501,
    });
    assert.strictEqual(r.status, 400, `[⑥a] 501 字应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[⑥a] 形状校验回落通用 VALIDATION 码（同 work_note 先例，未单独发码），实得 ${r.body.code}`);
    const after6a = await snapshotDevState(id6, 5);
    assert.deepStrictEqual(after6a, before6a, '[⑥a] 零副作用：dev_status/commit 计数/event 计数/主状态四项全未变（长度闸拒绝发生在写入前）');
    const note500 = 'x'.repeat(500);
    r = await call('POST', `/api/sys-issues/${id6}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6b' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: note500,
    });
    assert.strictEqual(r.status, 200, `[⑥b] 恰 500 字应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[⑥] 501 字 → 400 VALIDATION + 直接 snapshot 深比对零副作用（不再只靠后续成功提交间接证明）；恰 500 字（上限含）→ 200');

    // ══ ⑥c 空串 → 400 BUG_CAUSE_REQUIRED（328a 回卷新增：trim→''→falsy→null，与"完全不传"归同一码） ══
    const id6c = await seedBugToDev(5, 'bug-cause-⑥c-empty');
    await call('POST', `/api/sys-issues/${id6c}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const before6c = await snapshotDevState(id6c, 5);
    r = await call('POST', `/api/sys-issues/${id6c}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6c' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '',
    });
    assert.strictEqual(r.status, 400, `[⑥c] 空串应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_REQUIRED', `[⑥c] ⭐ 实现读侧确认：validateSubmitBody 里 bugCauseNoteRaw=b.bug_cause_note.trim()，bugCauseNote=bugCauseNoteRaw||null——空串 trim 后仍是空串，归一成 null，与"完全不传"落同一条 handler 闸（BUG_CAUSE_REQUIRED），不是独立的 VALIDATION 码，实得 ${r.body.code}`);
    const after6c = await snapshotDevState(id6c, 5);
    assert.deepStrictEqual(after6c, before6c, '[⑥c] 零副作用');
    ok('[⑥c] bug_cause_note: "" → 400 BUG_CAUSE_REQUIRED（trim→null→必填闸路径，非独立校验码）');

    // ══ ⑥d 全空白 → 400 BUG_CAUSE_REQUIRED（同⑥c，证"看起来填了但全是空白"同样绕不过必填闸） ══
    const id6d = await seedBugToDev(5, 'bug-cause-⑥d-whitespace');
    await call('POST', `/api/sys-issues/${id6d}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const before6d = await snapshotDevState(id6d, 5);
    r = await call('POST', `/api/sys-issues/${id6d}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6d' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '   ',
    });
    assert.strictEqual(r.status, 400, `[⑥d] 全空白应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_REQUIRED', `[⑥d] 全空白 trim 后同样归一为空，落同一必填闸，实得 ${r.body.code}`);
    const after6d = await snapshotDevState(id6d, 5);
    assert.deepStrictEqual(after6d, before6d, '[⑥d] 零副作用');
    ok('[⑥d] bug_cause_note: "   "（全空白）→ 400 BUG_CAUSE_REQUIRED（trim 归一后落同一必填闸，"看起来填了"绕不过去）');

    // ══ ⑥e trim 正例 → 200，payload/detail 落裁剪值（328a 回卷新增：固化 trim 契约） ══
    const id6e = await seedBugToDev(5, 'bug-cause-⑥e-trim');
    await call('POST', `/api/sys-issues/${id6e}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    r = await call('POST', `/api/sys-issues/${id6e}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6e' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '  原因X  ',
    });
    assert.strictEqual(r.status, 200, `[⑥e] 前后带空白但内容非空应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const ev6e = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id6e]);
    assert.strictEqual(JSON.parse(ev6e.payload_json).bug_cause_note, '原因X', '[⑥e] ⭐ payload_json 落裁剪值 "原因X"（非原始 "  原因X  "）——固化 trim 契约');
    const detail6e = await call('GET', `/api/sys-issues/${id6e}`, devTok);
    assert.strictEqual(detail6e.status, 200, `[⑥e] 详情读取应 200，实得 ${detail6e.status}`);
    const dev6eRow = (detail6e.body.dev_assignees || []).find(d => d.user_id === 5);
    assert.ok(dev6eRow, '[⑥e] 详情 dev_assignees 应含该行');
    assert.strictEqual(dev6eRow.bug_cause_note, '原因X', '[⑥e] 详情读侧同样是裁剪值（写读同源）');
    ok('[⑥e] bug_cause_note: "  原因X  " → 200，payload/detail 均落裁剪值 "原因X"（前后空白被裁，固化 trim 契约）');

    // ══ ⑥f 长度边界补非 ASCII（328a 回卷新增）：500 个中文过、501 个中文拒——ASCII repeat 测不出这个
    //   维度：ASCII 场景下码点数/UTF-16 码元数/UTF-8 字节数三种计数法恒重合，换成中文后 UTF-8 字节数
    //   （每字 3 字节，500 字=1500 字节）与码点数（500）分道扬镳，本组能实证拆穿"误用字节长度"这类实现
    //   错误。⚠️ 如实标注覆盖边界：常用中文字符落在 BMP 内，每字仍恰好 1 个 UTF-16 码元，故本组测不出
    //   "误用 UTF-16 码元数"这一种误用（要用代理对/非 BMP 字符如 emoji 才能把码点数与 UTF-16 码元数
    //   拆开）——该维度目前只能靠代码审查确认实现用的是 `[...x].length`（码点迭代）而非 `.length`
    //   （UTF-16 码元）站得住，未被本组实证覆盖。══════════════════════════════════════════
    const id6f = await seedBugToDev(5, 'bug-cause-⑥f-cjk');
    await call('POST', `/api/sys-issues/${id6f}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const cjkNote501 = '原'.repeat(501);
    r = await call('POST', `/api/sys-issues/${id6f}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6f-501' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: cjkNote501,
    });
    assert.strictEqual(r.status, 400, `[⑥f-501] 501 个中文应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[⑥f-501] 确切码 VALIDATION，实得 ${r.body.code}`);
    const cjkNote500 = '原'.repeat(500);
    r = await call('POST', `/api/sys-issues/${id6f}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-6f-500' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: cjkNote500,
    });
    assert.strictEqual(r.status, 200, `[⑥f-500] 恰 500 个中文应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[⑥f] 长度边界非 ASCII 对照：500 个中文（合计 1500 UTF-8 字节）过闸，501 个中文拒——证长度闸未误用字节长度（UTF-16 码元维度因中文恰落 BMP 未被本组拆分，见上方注释）');

    // ══ ⑦每轮必填：bug 提交→打回(return)→remove+re-add 重置完成态实例(LAST_ASSIGNEE 需先扩容)
    //     →同 dev 重新提交不带原因→400（第二轮同样拦）→带原因→200 ═══════════════════════════
    const id7 = await seedBugToDev(5, 'bug-cause-⑦');
    await call('POST', `/api/sys-issues/${id7}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    r = await call('POST', `/api/sys-issues/${id7}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-7-r1' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '首轮原因：脚本超时未捕获异常',
    });
    assert.strictEqual(r.status, 200, `[⑦ 前置] 首轮 submit（带原因）应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[⑦ 前置] 单人 bug 单首轮完成 → W-GATE 同事务转「待验证」');
    r = await call('POST', `/api/sys-issues/${id7}/return`, adminTok, { reason: '验收发现遗漏场景，打回重做' });
    assert.strictEqual(r.status, 200, `[⑦ 前置] return 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[⑦ 前置] return 后回「处理中」');
    // 「完成态不回 pending」不变量（verify-sys-bug-transitions.js 既有"二轮"范式逐字照抄）：return 只清
    //   sys_issues 主表字段，不碰 dev_assignees 子表——dev 5 的旧行仍是 code_submitted，必须先扩容(临时加
    //   dev6)才能绕开 LAST_ASSIGNEE 移除旧完成态实例，再 re-add dev5 拿一个全新 pending 实例。
    r = await call('POST', `/api/sys-issues/${id7}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `[⑦ 前置] 临时加协作(6) 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const oldDa7 = r.body.dev_assignees.find(d => d.user_id === 5);
    assert.ok(oldDa7, '[⑦ 前置] 应能定位 dev5 的旧完成态实例');
    assert.strictEqual(oldDa7.dev_status, 'code_submitted', '[⑦ 前置] dev5 旧实例 dev_status 仍是 code_submitted（return 不碰子表，验证不变量本身）');
    r = await call('DELETE', `/api/sys-issues/${id7}/dev-assignees/${oldDa7.id}`, adminTok, { reason: '二轮重置旧完成态实例' });
    assert.strictEqual(r.status, 200, `[⑦ 前置] remove 旧完成态实例应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id7}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, `[⑦ 前置] re-add dev5 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    // return 清了 dev_estimated_at（issue 级字段），二轮需重新回填才能过 ESTIMATE_REQUIRED 闸。
    r = await call('POST', `/api/sys-issues/${id7}/estimate`, devTok, { dev_estimated_at: futureEst(11) });
    assert.strictEqual(r.status, 200, `[⑦ 前置] 二轮重新 estimate 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    // 第二轮：不带原因 → 400（核心断言：证明不是"首轮已填就豁免"）
    const before7 = await snapshotDevState(id7, 5);
    assert.strictEqual(before7.devStatus, 'pending', '[⑦ 前置] re-add 后 dev5 是全新 pending 实例');
    r = await call('POST', `/api/sys-issues/${id7}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-7-r2-noreason' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 400, `[⑦] 二轮不带原因应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'BUG_CAUSE_REQUIRED', `[⑦] ⭐ 每轮必填核心断言：第二轮同样拦，确切码 BUG_CAUSE_REQUIRED，实得 ${r.body.code}`);
    const after7 = await snapshotDevState(id7, 5);
    assert.deepStrictEqual(after7, before7, '[⑦] 零副作用：二轮拒绝同样发生在写入前（commit 计数/event 计数/dev_status 均未变）');
    // 第二轮：带原因 → 200
    const CAUSE7_R2 = '二轮原因：首轮修复未覆盖并发场景';
    r = await call('POST', `/api/sys-issues/${id7}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-7-r2-withreason' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: CAUSE7_R2,
    });
    assert.strictEqual(r.status, 200, `[⑦] 二轮带原因应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const ev7r2 = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND dev_assignee_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id7, before7.daId]);
    assert.strictEqual(JSON.parse(ev7r2.payload_json).bug_cause_note, CAUSE7_R2, '[⑦] 二轮 payload_json 落的是二轮原因（非沿用首轮值——逐次独立承载，非"填过一次就全局记住"）');
    ok('[⑦] ⭐ 每轮必填：首轮完成→return 打回→remove+re-add 重置完成态实例→二轮不带原因仍 400 BUG_CAUSE_REQUIRED（零副作用）→带原因 200，且二轮 payload 是二轮原文（逐人逐轮独立承载，非首轮豁免）');

    // [B6·MED-1] bug_cause_records 历史轮次可见性：详情 GET 应同时看到首轮（已被 remove，removed=true）
    //   与二轮（当前在册，removed=false）两条记录——对齐 noCodeRecords 先例，验证 remove+re-add 不会让
    //   首轮原因从"记录视角"消失（devAssignees 上的 bug_cause_note 只反映在册视角，是"记录视角"的对照）。
    const detail7 = await call('GET', `/api/sys-issues/${id7}`, devTok);
    assert.strictEqual(detail7.status, 200, `[⑦ bug_cause_records] 详情读取应 200，实得 ${detail7.status}`);
    const records7 = detail7.body.bug_cause_records;
    assert.ok(Array.isArray(records7), '[⑦ bug_cause_records] 应为数组');
    assert.strictEqual(records7.length, 2, `[⑦ bug_cause_records] ⭐ 应恰含两轮记录（首轮 removed 实例 + 二轮在册实例），实得 ${JSON.stringify(records7)}`);
    const rec7Round1 = records7.find(r => r.dev_assignee_id === oldDa7.id);
    const rec7Round2 = records7.find(r => r.dev_assignee_id === before7.daId);
    assert.ok(rec7Round1, '[⑦ bug_cause_records] 应含首轮（旧 dev_assignee_id）记录');
    assert.ok(rec7Round2, '[⑦ bug_cause_records] 应含二轮（新 dev_assignee_id）记录');
    assert.strictEqual(rec7Round1.removed, true, '[⑦ bug_cause_records] ⭐ 首轮记录 removed=true（实例已被 remove）');
    assert.strictEqual(rec7Round2.removed, false, '[⑦ bug_cause_records] ⭐ 二轮记录 removed=false（当前在册）');
    assert.strictEqual(rec7Round1.bug_cause_note, '首轮原因：脚本超时未捕获异常', '[⑦ bug_cause_records] 首轮原因文本精确保留（未被二轮覆盖/未丢失）');
    assert.strictEqual(rec7Round2.bug_cause_note, CAUSE7_R2, '[⑦ bug_cause_records] 二轮原因文本精确');
    assert.strictEqual(rec7Round1.user_id, 5, '[⑦ bug_cause_records] 首轮 user_id 正确');
    assert.strictEqual(rec7Round2.user_id, 5, '[⑦ bug_cause_records] 二轮 user_id 正确（同一人两轮）');
    assert.ok(rec7Round1.submitted_at && rec7Round2.submitted_at, '[⑦ bug_cause_records] 两轮均应带 submitted_at');
    assert.ok(records7.indexOf(rec7Round1) < records7.indexOf(rec7Round2), '[⑦ bug_cause_records] ⭐ 按事件 id 升序：首轮应排在二轮之前');
    ok('[⑦ bug_cause_records] ⭐ 详情端点新增顶层字段正确对齐 noCodeRecords 先例：remove+re-add 后两轮原因均可见（首轮 removed=true·二轮 removed=false），按事件 id 升序，文本互不覆盖');

    // ══ ⑧非 string 类型 → 400（数字/数组两个反例，同 work_note/estimate 乐观锁类型闸惯例） ══════
    // [328a 回卷] 8a/8b 各自失败后立即独立 snapshot，不再共用一个跨两次请求的前后对照：原写法只在两次
    //   400 都发生之后才统一比对一次（before8 在两次请求之前，after8 在两次请求之后），若其中恰好只有
    //   一个分支（比如数组类型那条）意外留了副作用，另一个分支的"正常"会把它平均掉——共用快照定位不到
    //   "究竟是哪一次拒绝出的问题"。改成每次请求各自独立 before/after，出错时能精确指向具体是 8a 还是 8b。
    const id8 = await seedBugToDev(5, 'bug-cause-⑧');
    await call('POST', `/api/sys-issues/${id8}/estimate`, devTok, { dev_estimated_at: futureEst(10) });
    const before8a = await snapshotDevState(id8, 5);
    r = await call('POST', `/api/sys-issues/${id8}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-8a' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: 12345,
    });
    assert.strictEqual(r.status, 400, `[⑧a] bug_cause_note 传数字应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[⑧a] 确切码 VALIDATION，实得 ${r.body.code}`);
    const after8a = await snapshotDevState(id8, 5);
    assert.deepStrictEqual(after8a, before8a, '[⑧a] 零副作用：数字类型拒绝后四项全未变（独立于⑧b单独定位）');
    const before8b = await snapshotDevState(id8, 5);
    r = await call('POST', `/api/sys-issues/${id8}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-8b' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: ['x'],
    });
    assert.strictEqual(r.status, 400, `[⑧b] bug_cause_note 传数组应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', `[⑧b] 确切码 VALIDATION，实得 ${r.body.code}`);
    const after8b = await snapshotDevState(id8, 5);
    assert.deepStrictEqual(after8b, before8b, '[⑧b] 零副作用：数组类型拒绝后四项全未变（独立于⑧a单独定位）');
    // 正例收尾：同一 dev 紧接着传合法字符串应能成功，证明前两次失败未污染状态
    r = await call('POST', `/api/sys-issues/${id8}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b4-8c' }], self_tested: true, test_env_deployed: true,
      bug_cause_note: '合法字符串原因',
    });
    assert.strictEqual(r.status, 200, `[⑧c] 类型合法后应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[⑧] bug_cause_note 非 string（数字/数组）→ 400 VALIDATION，8a/8b 各自独立 snapshot 零副作用；改传合法字符串后 200（证明前两次失败未污染状态）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ C6「bug 提交必填产生原因」后端全套验收通过`);
  } finally {
    if (server) server.close();
    db.close();
  }
}

main().catch((e) => {
  console.error('\n❌ verify-sys-bug-cause 失败:', e && (e.stack || e.message || e));
  if (server) server.close();
  db.close();
  process.exit(1);
});
