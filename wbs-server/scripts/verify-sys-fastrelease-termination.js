// scripts/verify-sys-fastrelease-termination.js — 系统迭代·组 B「bug 先行上线」B1（授权终结事件制）验收
//   SSOT = 用户 P7 终裁（2026-08-13，任务锚点见 index.js FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL 定义处注释）
//   + codex 368 号 MED-2 收口（同日）：验收通过 / 验收打回 / 上线翻牌（任意路径）/ 验收拒绝 / 作废——
//   **五事件**任一发生，若该单存在未消费的活跃先行上线授权，同事务清空授权六列 + 写 timeline 留痕行；
//   fastlane 直上消费路径除外（消费记录=审计痕迹，全部保留）。reactivate（已拒绝→初始态）改为断言式
//   fail-closed——前置态「已拒绝」现只能经 issue_reject 到达，该分支已终结掉活跃授权，reactivate 到达
//   时若仍读到活跃授权即视为不变量被破坏，抛 500 而非静默放行复活。
//   用法：node scripts/verify-sys-fastrelease-termination.js
//
// 范围声明：与姊妹文件的分工——verify-sys-fastrelease-auth.js（§3.1 授权/撤销面，[9] 组已改写为覆盖
//   accept 这一条边作回归锚点）、verify-sys-fastlane-submit.js（§3.2 submit 直上，[11] 组已改写为
//   SQL 造态纵深防御测试）均已各自同步过 B1 对既有断言的影响；本文件是 B1 五事件终结逻辑本身的
//   唯一权威验收（五事件成对用例 + reactivate 断言双向证明 + 不变量探针），不重复姊妹文件已覆盖的
//   授权/撤销/直上正常面。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1] 事件②「验收通过」（accept 落「待上线」，非 C9 直翻）：正例（授权→accept→六列清空+留痕）+
//       对照组（授权→hold 暂缓，不经过 case 'accept'/'return'→六列仍活跃未被清空——证明终结逻辑严格
//       限定在这两个 case 分支内，不是"任何 sysIssueTransition 调用"都会触发）。
//   [2] 事件③「验收打回」（return 落「处理中」）：正例（accept 到待上线后 return→六列清空+留痕）+
//       对照组（reassign 端点不经 sysIssueTransition 引擎，不触碰 fast_release_*）。
//   [3] 事件①「上线翻牌」·C9 直翻子路径（accept 落「已上线」，零 commit）：正例+对照组（未授权→
//       accept 直翻→status 正常已上线，但无终结留痕行——授权不存在时不该有"终结"这个动作发生）。
//   [4] 事件①「上线翻牌」·批次发布子路径（_publishReleaseCoreInTxn 内新增的双保险逻辑，SQL 造态）：
//       正例+对照组。⚠️ 本子路径经真实状态机路径已结构性不可达（case 'accept' 已在同事务终结掉活跃
//       授权，批内成员到达「待上线」时六列必已是 NULL）——纯纵深防御，用 SQL 造态直接验证。
//       [4c]（codex 389 号二批 M2·2026-08-14）批级 fail-closed 负例：同批一干净 fastlane 成员 + 一 SQL
//       造态注入未软删 done 行的异常成员——发布应 500 FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH（先行
//       上线两步化 S5 §4-7 L3 防线），错误文案含异常单号（L2 定位信息），且整批零副作用（两成员状态/
//       授权六列/集合行/timeline 全部原值）——清理异常行后重发成功（恢复对照）。
//   [5]（组B·S2 语义重定义）终结后 submit → 正常 200 进入「待验证」+ 零挂牌（原"409
//       FAST_RELEASE_SUBMIT_DIRECT_DENIED"依赖的前置闸已随两步化拆直上分支删除，被保护的不变量本身
//       不变——旧授权已终结，新提交不应被当作活跃授权消费，只是外部可观测形式从"拒绝"变成"正常放行
//       但不挂牌"）。
//   [6]（组B·S2 订正）直上消费（fastlane 例外路径）→ 已上线：消费记录逐列完整保留（不属于"终结"
//       范畴）——原真实 submit direct_release 链路已不可达，改 SQL 造态直接构造消费终态。
//   [7]（codex 368 号 MED-2）事件④「验收拒绝」（issue_reject 落「已拒绝」）：正例（授权活跃→
//       issue-reject→六列清空+留痕）+ 对照组（未授权拒绝零终结留痕）。
//   [8]（codex 368 号 MED-2）事件⑤「作废」（void 落「已作废」，from='*'）：正例+对照组，同款。
//   [9]（codex 368 号 MED-2）reactivate 断言双向证明：正例（干净态复活不被误伤 + 拒绝轮授权未穿透
//       进重新开的下一轮——[组B·S2 订正] 原断言"submit direct_release 仍 409"改为"新一轮 submit 正常
//       200 + 零挂牌"，被保护的不变量不变）+ 反证（SQL 造态"已拒绝残留活跃授权"→
//       reactivate fail-closed 500 拒绝 + 零副作用）。
//   [10] 不变量探针 fastReleaseUnresolvedAtTerminalStateViolations：全库扫描 + 四态（已上线/已关闭/
//        已拒绝/已作废）构造违例行反证判红 + 清理恢复 0（[Y5] 范式，双向证明——不只证"能放行合法态"，
//        也证"能抓出真违例"）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-fastrelease-termination-secret';
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
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const adminActor = { id: 1, name: '管理员' };
// hasReleaseEligibility 对 role='admin' 恒 false（fail-closed denylist：role∉{viewer,admin}才算在职可执行）——
// [4] 组直调 _publishReleaseCoreInTxn 时执行人不能用 admin，须用普通 user 角色（dev5），下方 seedExecutorDone
// 与 publishViaCoreInTxn 均以此账号身份走中心守卫。
const devActor = { id: 5, name: '开发王' };

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
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
function fail(msg) { console.error('\n❌ verify-sys-fastrelease-termination 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `FRT-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-fastrelease-termination 夹具', intake_liaison_id: 13,
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function bugAtDaichuli() {
  const id = await mkIssue('bug');
  const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-待处理] intake-accept 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
async function bugAtChulizhong() {
  const id = await bugAtDaichuli();
  const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-处理中] assign 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
function futureEtaStr() {
  const d = new Date(Date.now() + 30 * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function estimateFuture(id) {
  const r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEtaStr() });
  assert.strictEqual(r.status, 200, `[estimate] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
async function authorize(id, note) {
  const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, note ? { note } : {});
  assert.strictEqual(r.status, 200, `[授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function submitCommits(id, { directRelease } = {}) {
  const body = {
    mode: 'commits', self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因',
    commits: [{ component: 'backend', commit_ref: `svn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
    ...(directRelease !== undefined ? { direct_release: directRelease } : {}),
  };
  return call('POST', `/api/sys-issues/${id}/submit`, devTok, body);
}
async function submitNoCode(id) {
  return call('POST', `/api/sys-issues/${id}/submit`, devTok, {
    mode: 'no_code', no_code_reason: 'verify 夹具：无提交交付（B1 终结断言）', self_tested: true, test_env_deployed: true,
    bug_cause_note: 'verify 夹具：bug 产生原因',
  });
}

const fastReleaseRow = (id) => get(
  `SELECT fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note,
          fast_release_revoked_at, fast_release_consumed_at
     FROM sys_issues WHERE id=?`, [id]);
const issueRow = (id) => get(
  `SELECT id, status, type, released_at, online_source, post_release_acceptance,
          fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note,
          fast_release_revoked_at, fast_release_consumed_at, release_id
     FROM sys_issues WHERE id=?`, [id]);
const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const timelineCount = async (id) => Number((await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id])).c);
const terminatedTlRows = (id) => all(
  `SELECT event_type, summary, action_code, operator_id, operator_name FROM sys_issue_timeline
    WHERE issue_id=? AND action_code='fast_release_auth_terminated' ORDER BY id`, [id]);
function assertAllNull(row, tag) {
  for (const k of Object.keys(row)) {
    assert.strictEqual(row[k], null, `${tag}：${k} 应为 NULL，实得 ${JSON.stringify(row[k])}`);
  }
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5 / 受理人13）');

  // ══════════════════════════ [1] 事件②「验收通过」正例 + 对照组 ══════════════════════════
  {
    // [1a] 正例：授权活跃 → submit(commits，非直上) → 待验证 → accept（正常落待上线，非 C9 直翻）
    //   → 应终结：六列清空 + 1 条 fast_release_auth_terminated 留痕（summary 精确文案）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[1a] 验收通过正例');
    const rowAfterAuth = await fastReleaseRow(id);
    assert.ok(rowAfterAuth.fast_release_auth_at, '[1a-前置] 授权已落库');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[1a-submit] 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual(subR.body.main_status, '待验证', `[1a-submit] 应落待验证，实得 ${subR.body.main_status}`);
    const beforeAcceptTl = await timelineCount(id);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[1a-accept] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '待上线', `[1a-accept] 有 commit 不应 C9 直翻，应落待上线，实得 ${acceptR.body.status}`);
    const rowAfterAccept = await fastReleaseRow(id);
    assertAllNull(rowAfterAccept, '[1a-accept 后] ⭐⭐ 事件②命中：六列应被同事务清空');
    const tl1a = await terminatedTlRows(id);
    assert.strictEqual(tl1a.length, 1, `[1a] 应恰新增 1 条终结留痕，实得 ${tl1a.length}`);
    assert.strictEqual(tl1a[0].event_type, 'note', '[1a] 终结行 event_type=note');
    assert.strictEqual(tl1a[0].summary, '直上授权已失效（验收通过）', `[1a] 终结行 summary 精确文案，实得="${tl1a[0].summary}"`);
    assert.strictEqual(tl1a[0].operator_id, 1, '[1a] 终结行 operator_id=触发动作者（accept 的操作者 admin）');
    assert.strictEqual(await timelineCount(id), beforeAcceptTl + 2, '[1a] timeline 恰新增 2 条（accept 主流转行 + 终结留痕行）');
    ok('[1a] 事件②「验收通过」正例：accept 正常落「待上线」（非 C9 直翻）同事务终结活跃授权——六列清空 + 精确留痕文案 + operator 正确');

    // [1b] 对照组：授权活跃 → hold（暂缓，不经过 case 'accept'/'return'）→ 六列应仍活跃未被清空——
    //   证明终结逻辑严格限定在这两个 case 分支内，不是"任何 sysIssueTransition 调用"都会触发（防
    //   断言永真：若实现错误地把清空逻辑放进了 switch 之外的公共区域，这条负例会抓到）。
    const idCtrl = await bugAtChulizhong();
    await authorize(idCtrl, '[1b] 对照组：hold 不应终结');
    const rowBeforeHold = await fastReleaseRow(idCtrl);
    assert.ok(rowBeforeHold.fast_release_auth_at, '[1b-前置] 授权已落库');
    const holdR = await call('POST', `/api/sys-issues/${idCtrl}/hold`, adminTok, { reason: '对照组：验证 hold 不终结授权' });
    assert.strictEqual(holdR.status, 200, `[1b-hold] 应 200，实得 ${holdR.status} ${JSON.stringify(holdR.body)}`);
    const rowAfterHold = await fastReleaseRow(idCtrl);
    assert.deepStrictEqual(rowAfterHold, rowBeforeHold, '[1b] ★对照组：hold 不经过 case accept/return，六列应逐列原样保留（未被误伤）');
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[1b] 对照组：不应产生任何 fast_release_auth_terminated 留痕行');
    ok('[1b] ★对照组：授权活跃但只 hold（不触发事件②/③）→ 六列原样保留，零终结留痕（证明终结逻辑严格限定在 accept/return 两个 case 内）');
  }

  // ══════════════════════════ [2] 事件③「验收打回」正例 + 对照组 ══════════════════════════
  {
    // [2a] 正例：授权活跃 → submit(commits) → 待验证 → accept（正常，非终结相关文案——但活跃授权已在
    //   accept 这一步被事件②终结，为了单独验证事件③，本组改在**打回之后重新授权再打回一次**，构造
    //   "验收打回时刻仍持有活跃授权"这个组合（accept 已耗掉一次授权，重新授权后走 return）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[2a-submit] 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual(subR.body.main_status, '待验证', `[2a-submit] 应落待验证，实得 ${subR.body.main_status}`);
    // 待验证态不在授权窗口内（授权仅 待处理/处理中），故此处尚不能授权——先 return 打回到处理中
    // （此时无活跃授权，属"事件不发生"式空转），再重新提交到待验证，这次在处理中态补授权，验收打回
    // 时刻即持有活跃授权。
    const primeReturnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '[2a] 前置打回：清场后再授权' });
    assert.strictEqual(primeReturnR.status, 200, `[2a-前置打回] 应 200，实得 ${primeReturnR.status}`);
    assert.strictEqual(await statusOf(id), '处理中', '[2a-前置] 应回到处理中');
    await estimateFuture(id);   // 打回清空 ETA，重新填
    await authorize(id, '[2a] 验收打回正例');
    const rowAfterAuth = await fastReleaseRow(id);
    assert.ok(rowAfterAuth.fast_release_auth_at, '[2a-前置] 授权已落库');
    const subR2 = await submitCommits(id);
    assert.strictEqual(subR2.status, 200, `[2a-再提交] 应 200，实得 ${subR2.status} ${JSON.stringify(subR2.body)}`);
    assert.strictEqual(subR2.body.main_status, '待验证', `[2a-再提交] 应落待验证，实得 ${subR2.body.main_status}`);
    const rowBeforeReturn = await fastReleaseRow(id);
    assert.deepStrictEqual(rowBeforeReturn, rowAfterAuth, '[2a-前置] submit 不触碰 fast_release_*，授权仍活跃');
    const beforeReturnTl = await timelineCount(id);
    const returnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '[2a] 验收打回：终结正例' });
    assert.strictEqual(returnR.status, 200, `[2a-return] 应 200，实得 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[2a-return] bug 打回应落处理中');
    const rowAfterReturn = await fastReleaseRow(id);
    assertAllNull(rowAfterReturn, '[2a-return 后] ⭐⭐ 事件③命中：六列应被同事务清空');
    const tl2a = await terminatedTlRows(id);
    assert.strictEqual(tl2a.length, 1, `[2a] 应恰新增 1 条终结留痕，实得 ${tl2a.length}`);
    assert.strictEqual(tl2a[0].summary, '直上授权已失效（验收打回）', `[2a] 终结行 summary 精确文案，实得="${tl2a[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforeReturnTl + 2, '[2a] timeline 恰新增 2 条（return 主流转行 + 终结留痕行）');
    ok('[2a] 事件③「验收打回」正例：return 落「处理中」同事务终结活跃授权——六列清空 + 精确留痕文案');

    // [2b] 对照组：reassign 端点不经 sysIssueTransition 引擎（独立事务/独立 UPDATE 语句），不应触碰
    //   fast_release_*——即便该单当下持有活跃授权，reassign 后也应原样保留。
    const idCtrl = await bugAtChulizhong();
    await authorize(idCtrl, '[2b] 对照组：reassign 不应终结');
    const rowBeforeReassign = await fastReleaseRow(idCtrl);
    assert.ok(rowBeforeReassign.fast_release_auth_at, '[2b-前置] 授权已落库');
    const reassignR = await call('POST', `/api/sys-issues/${idCtrl}/reassign`, adminTok, {
      reason: '对照组：验证 reassign 不终结授权', member_ids: [5, 13],
    });
    assert.strictEqual(reassignR.status, 200, `[2b-reassign] 应 200，实得 ${reassignR.status} ${JSON.stringify(reassignR.body)}`);
    const rowAfterReassign = await fastReleaseRow(idCtrl);
    assert.deepStrictEqual(rowAfterReassign, rowBeforeReassign, '[2b] ★对照组：reassign 不经引擎 switch，六列应逐列原样保留');
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[2b] 对照组：不应产生任何终结留痕行');
    ok('[2b] ★对照组：授权活跃但只 reassign（独立端点，不经 sysIssueTransition case return）→ 六列原样保留，零终结留痕');
  }

  // ══════════════════════════ [3] 事件①「上线翻牌」·C9 直翻子路径 正例 + 对照组 ══════════════════════════
  {
    // [3a] 正例：零 commit → accept 走 C9 直翻已上线；授权活跃 → 应终结（六列清空+"上线翻牌"文案）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[3a] 上线翻牌正例（C9 直翻）');
    const rowAfterAuth = await fastReleaseRow(id);
    const noCodeR = await submitNoCode(id);
    assert.strictEqual(noCodeR.status, 200, `[3a-submit] 应 200，实得 ${noCodeR.status} ${JSON.stringify(noCodeR.body)}`);
    const beforeAcceptTl = await timelineCount(id);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[3a-accept] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '已上线', `[3a-accept] 零 commit 应 C9 直翻已上线，实得 ${acceptR.body.status}`);
    const rowAfterAccept = await fastReleaseRow(id);
    assertAllNull(rowAfterAccept, '[3a-accept 后] ⭐⭐ 事件①（C9 直翻）命中：六列应被同事务清空');
    const tl3a = await terminatedTlRows(id);
    assert.strictEqual(tl3a.length, 1, `[3a] 应恰新增 1 条终结留痕，实得 ${tl3a.length}`);
    assert.strictEqual(tl3a[0].summary, '直上授权已失效（上线翻牌）', `[3a] 终结行 summary 精确文案，实得="${tl3a[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforeAcceptTl + 2, '[3a] timeline 恰新增 2 条（accept 主流转行 + 终结留痕行）');
    ok('[3a] 事件①「上线翻牌」正例（C9 直翻子路径）：accept 落「已上线」同事务终结活跃授权——六列清空 + "上线翻牌"精确文案');

    // [3b] 对照组：未授权 → 同样走 C9 直翻已上线 → status 正常已上线，但不应产生任何终结留痕（没有
    //   活跃授权可终结，"终结"这个动作不该凭空发生——防断言永真：若实现无条件插入终结行，这条会抓到）。
    const idCtrl = await bugAtChulizhong();
    await estimateFuture(idCtrl);
    const noCodeCtrl = await submitNoCode(idCtrl);
    assert.strictEqual(noCodeCtrl.status, 200, `[3b-submit] 应 200，实得 ${noCodeCtrl.status} ${JSON.stringify(noCodeCtrl.body)}`);
    const acceptCtrl = await call('POST', `/api/sys-issues/${idCtrl}/accept`, adminTok, {});
    assert.strictEqual(acceptCtrl.status, 200, `[3b-accept] 应 200，实得 ${acceptCtrl.status} ${JSON.stringify(acceptCtrl.body)}`);
    assert.strictEqual(acceptCtrl.body.status, '已上线', '[3b-accept] 未授权单同样应 C9 直翻已上线（B1 不影响本就无授权的直翻路径）');
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[3b] ★对照组：未授权单 C9 直翻不应产生任何终结留痕行');
    ok('[3b] ★对照组：未授权单同样 C9 直翻已上线 → status 正常，零终结留痕（证明终结逻辑是条件触发，非无条件插入）');
  }

  // ══════════════════════════ [4] 事件①「上线翻牌」·批次发布子路径（双保险，SQL 造态）正例 + 对照组 ══════════════════════════
  //   ⚠️ 背景：本子路径经真实状态机路径已结构性不可达——case 'accept' 已在同事务终结掉活跃授权，批内
  //   成员到达「待上线」时六列必已是 NULL（见 index.js _publishReleaseCoreInTxn 内该段"双保险"注释）。
  //   本组用 SQL 造态直接验证 _publishReleaseCoreInTxn 这段纵深防御代码本身，直调内核（I._publishReleaseCoreInTxn，
  //   同 publishReleaseTransition 既有导出理由——绕开 execute 端点要求的完整排班通知流程）。
  {
    async function bugAtDaishangxian() {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      const subR = await submitCommits(id);   // 有 commit，accept 不会 C9 直翻
      assert.strictEqual(subR.status, 200, `[夹具-待验证] submit 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
      const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(acceptR.status, 200, `[夹具-待上线] accept 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
      assert.strictEqual(acceptR.body.status, '待上线', `[夹具-待上线] 应落待上线，实得 ${acceptR.body.status}`);
      return id;
    }
    async function mkRelease() {
      const r = await call('POST', '/api/sys-releases', adminTok, {});
      assert.strictEqual(r.status, 201, `[夹具-批次] 建批次应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id;
    }
    async function addToRelease(releaseId, issueId) {
      const r = await call('POST', `/api/sys-releases/${releaseId}/add-issues`, adminTok, { issue_ids: [issueId] });
      assert.strictEqual(r.status, 200, `[夹具-加单] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    }
    // _publishReleaseCoreInTxn 的中心守卫（:11663 一带）要求 actor 在 sys_release_executors 在册且
    // 全员 exec_status='done'——直调内核绕开了 HTTP 层完整的"安排上线通知→执行人确认"多步流程，直接
    // 插入一行已完成态供执行人通过守卫，这与业务真实执行链路正交（本组测的是双保险终结逻辑，不是
    // 执行人排班机制本身，故不重建整套通知/确认流程）。⚠️ **必须放在 add-issues 之后**——
    // applyReleaseChange（加单收尾原语，§6.11）会重置/移除既有执行人子表行（批次成员变了，既有执行人
    // 确认必须作废重来），先插后加单会被加单动作连带清空，实测踩过这个坑。⚠️ 执行人须用 dev5（普通
    // user 角色）——hasReleaseEligibility 对 role='admin' 恒 false（fail-closed denylist：非在职/查看者/
    // 管理员均无执行上线资格），admin 不能充当自己的执行人。
    async function seedExecutorDone(releaseId) {
      await run(
        `INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
         VALUES (?, 5, '开发王', 'done', datetime('now','localtime'), 1, '管理员')`,
        [releaseId]
      );
    }
    async function publishViaCoreInTxn(releaseId) {
      await run('BEGIN IMMEDIATE');
      let out, err = null;
      try {
        out = await I._publishReleaseCoreInTxn(releaseId, devActor, { release_note: 'B1 [4] 组直调发布' }, 'publish', 'publish');
        await run('COMMIT');
      } catch (e) {
        err = e;
        try { await run('ROLLBACK'); } catch (_) { /* ignore */ }
      }
      if (err) throw err;
      return out;
    }

    // [4a] 正例（SQL 造态）：正常到达「待上线」后（此时六列本为 NULL），直接 SQL 注入一份"理论上不该
    //   出现"的活跃授权，模拟"万一有路径绕过了 case accept 的终结检查"这类假设场景——发布应终结它。
    const id = await bugAtDaishangxian();
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime'), fast_release_auth_note = '[4a] SQL 造态注入'
               WHERE id = ?`, [id]);
    const rowAfterInject = await fastReleaseRow(id);
    assert.ok(rowAfterInject.fast_release_auth_at, '[4a-造态] 注入应已落库');
    const relId = await mkRelease();
    await addToRelease(relId, id);
    await seedExecutorDone(relId);
    const beforePublishTl = await timelineCount(id);
    const out = await publishViaCoreInTxn(relId);
    assert.strictEqual(out.count, 1, `[4a] 发布批次应恰含 1 单，实得 ${out.count}`);
    assert.strictEqual(await statusOf(id), '已上线', '[4a] 发布后应落已上线');
    const rowAfterPublish = await fastReleaseRow(id);
    assertAllNull(rowAfterPublish, '[4a-发布后] ⭐⭐ 事件①（批次发布双保险）命中：六列应被同事务清空');
    const tl4a = await terminatedTlRows(id);
    assert.strictEqual(tl4a.length, 1, `[4a] 应恰新增 1 条终结留痕，实得 ${tl4a.length}`);
    assert.strictEqual(tl4a[0].summary, '直上授权已失效（上线翻牌）', `[4a] 终结行 summary 精确文案，实得="${tl4a[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforePublishTl + 3, '[4a] timeline 恰新增 3 条（release 行 + release_published 行 + 终结留痕行）');
    ok('[4a] 事件①「上线翻牌」正例（批次发布双保险子路径，SQL 造态）：_publishReleaseCoreInTxn 同事务终结批内成员的（理论不可达但仍防御性检查的）活跃授权');

    // [4b] 对照组：同样流程但不注入——批次发布应正常成功，六列本就是 NULL，零终结留痕新增。
    const idCtrl = await bugAtDaishangxian();
    const relIdCtrl = await mkRelease();
    await addToRelease(relIdCtrl, idCtrl);
    await seedExecutorDone(relIdCtrl);
    const rowBeforeCtrl = await fastReleaseRow(idCtrl);
    assertAllNull(rowBeforeCtrl, '[4b-前置] 未注入，六列本应全 NULL');
    const outCtrl = await publishViaCoreInTxn(relIdCtrl);
    assert.strictEqual(outCtrl.count, 1, `[4b] 发布批次应恰含 1 单，实得 ${outCtrl.count}`);
    assert.strictEqual(await statusOf(idCtrl), '已上线', '[4b] 发布后应落已上线');
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[4b] ★对照组：未注入活跃授权，发布不应产生任何终结留痕行');
    ok('[4b] ★对照组：批内成员六列本为 NULL（未造态）→ 批次发布正常成功，零终结留痕（证明双保险段是 filter 命中才动作，非无条件扫全批插入）');

    // [4c]（codex 389 号二批 M2）批级 fail-closed 负例：同批一个干净 fastlane 成员 + 一个 SQL 造态注入
    //   未软删 done 行的异常成员——发布应 500 FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH（先行上线两步化
    //   S5·§4-7 双保险点 L3 防线，见 index.js _publishReleaseCoreInTxn 内该段注释），且**整批零副作用**
    //   （两成员状态/授权六列/集合行/timeline 全部原值，不是"干净成员照发、异常成员单独失败"这种半批
    //   语义——同批次事务本就是原子单元）；清理异常行后重发应成功（恢复对照）。
    const idClean = await bugAtDaishangxian();   // 干净成员：到达"待上线"，六列本为 NULL（accept 已终结）
    const idBad = await bugAtDaishangxian();     // 异常成员：同样到达"待上线"，随后 SQL 造态注入活跃授权
    //   六列 + 一行未软删的 fastlane 执行人 done 行——这条 done 行本不该存在（这条边根本没走两步化
    //   confirm 消费路径，产生它纯粹是造态），正是 L3 要拦的"membersWithActiveAuth 假设失效"那种组合。
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime'), fast_release_auth_note = '[4c] SQL 造态注入'
               WHERE id = ?`, [idBad]);
    await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
       VALUES (?, 5, '开发王', 'done', datetime('now','localtime'), 1, '管理员')`,
      [idBad]
    );

    const relId4c = await mkRelease();
    await addToRelease(relId4c, idClean);
    await addToRelease(relId4c, idBad);
    await seedExecutorDone(relId4c);

    // 发布前快照——两成员各自 issueRow 全字段快照 + timeline 计数 + 异常成员的集合行快照，供发布失败
    // 后逐一核对"整批零副作用"。
    const cleanBefore = await issueRow(idClean);
    const badBefore = await issueRow(idBad);
    const cleanTlBefore = await timelineCount(idClean);
    const badTlBefore = await timelineCount(idBad);
    const badRosterBefore = await all(`SELECT id, removed_at, exec_status FROM sys_fast_release_executors WHERE issue_id=?`, [idBad]);
    assert.strictEqual(badRosterBefore.length, 1, '[4c-前置] 异常成员应恰 1 行未软删 done（造态生效）');
    assert.strictEqual(badRosterBefore[0].removed_at, null, '[4c-前置] 该行应未软删');
    // [codex 390 号三批 M2 补全] 干净成员的执行人集合行也要快照——闭合声明说的是"两成员...集合行...
    //   全部原值"，此前只快照+断言了异常成员那份，干净成员那份被漏了（干净成员本无 fastlane 执行人行，
    //   预期恒为空数组，但"预期恒为空"不能替代"真的断言过"——沿用同款 SELECT 形态对齐异常成员）。
    const cleanRosterBefore = await all(`SELECT id, removed_at, exec_status FROM sys_fast_release_executors WHERE issue_id=?`, [idClean]);
    assert.strictEqual(cleanRosterBefore.length, 0, '[4c-前置] 干净成员本不应有任何 fastlane 执行人行');

    let thrown4c = null;
    try { await publishViaCoreInTxn(relId4c); }
    catch (e) { thrown4c = e; }
    assert.ok(thrown4c, '[4c] 发布应抛错（fail-closed 阻断，非静默继续）');
    assert.strictEqual(thrown4c.httpStatus, 500, `[4c] 应为 500，实得 ${thrown4c.httpStatus}`);
    assert.strictEqual(thrown4c.code, 'FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH', `[4c] 确切码，实得 ${thrown4c.code}`);
    // [codex 389 号二批 L2] 定位信息——错误文案应含异常单号（非纯计数），便于 admin 直接定位是哪单出问题。
    assert.ok(thrown4c.message.includes(`#${idBad}`), `[4c] ⭐ 错误文案应含异常单号 #${idBad}（L2 定位信息），实得="${thrown4c.message}"`);
    // [codex 390 号三批 L2 补全] 本用例只造态 1 单，真实总数(COUNT DISTINCT)=采样条数=1——精确断言文案
    // 不带"等共 N 单"后缀（该后缀只应在真实总数 > 展示条数时出现），钉住"等共"分支的边界条件不误触发；
    // 同时用整句相等（非仅 includes）钉死 idsText 精确形态，防止 COUNT 改造引入静默的计数错位。
    assert.ok(!thrown4c.message.includes('等共'), `[4c] ⭐ 单一异常单号场景不应出现"等共 N 单"后缀，实得="${thrown4c.message}"`);
    assert.strictEqual(
      thrown4c.message,
      `批次内单 #${idBad} 存在已确认执行的先行上线执行人集合行，理论上不应发生（本批成员应均未消费）——为防止销毁真实部署留痕，已阻断本次批次发布，请联系管理员核查该批次成员的 fast_release_* 字段与执行人集合状态`,
      `[4c] ⭐ 错误文案应整句精确匹配（L2 补全后 idsText 拼装逻辑改用真实总数 totalIssueCount 判定后缀，需钉死单单号场景不受影响），实得="${thrown4c.message}"`
    );

    // 整批零副作用——两成员状态/授权六列/timeline 计数/异常成员集合行均应与发布前逐字段一致。
    const cleanAfter = await issueRow(idClean);
    const badAfter = await issueRow(idBad);
    assert.deepStrictEqual(cleanAfter, cleanBefore, '[4c] 干净成员应零改动（整批回滚，不因同批另一单出问题就单独早发布）');
    assert.deepStrictEqual(badAfter, badBefore, '[4c] 异常成员应零改动（整批回滚，含刚才注入的活跃授权六列原样保留）');
    assert.strictEqual(await timelineCount(idClean), cleanTlBefore, '[4c] 干净成员 timeline 应零新增');
    assert.strictEqual(await timelineCount(idBad), badTlBefore, '[4c] 异常成员 timeline 应零新增');
    const badRosterAfter = await all(`SELECT id, removed_at, exec_status FROM sys_fast_release_executors WHERE issue_id=?`, [idBad]);
    assert.deepStrictEqual(badRosterAfter, badRosterBefore, '[4c] 异常成员的集合行应零改动（未被销毁，L3 防线在动手清空之前就已拦下）');
    // [codex 390 号三批 M2 补全] 干净成员的集合行同样逐字段核对（补齐此前遗漏的一半断言）。
    const cleanRosterAfter = await all(`SELECT id, removed_at, exec_status FROM sys_fast_release_executors WHERE issue_id=?`, [idClean]);
    assert.deepStrictEqual(cleanRosterAfter, cleanRosterBefore, '[4c] ⭐ 干净成员的集合行应零改动（此前遗漏的断言，补齐后"两成员集合行全部原值"才是完整闭合）');

    // 恢复对照：清理异常行后重新发布应成功（证明红灯确系"异常行存在"所致，非批次/端点本身被搞坏）。
    await run(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员'
               WHERE issue_id = ? AND removed_at IS NULL`, [idBad]);
    const outRetry = await publishViaCoreInTxn(relId4c);
    assert.strictEqual(outRetry.count, 2, `[4c-恢复] 清理后重发应成功且恰含 2 单，实得 ${outRetry.count}`);
    assert.strictEqual(await statusOf(idClean), '已上线', '[4c-恢复] 干净成员应已上线');
    assert.strictEqual(await statusOf(idBad), '已上线', '[4c-恢复] 异常成员清理后重发也应已上线');
    ok(`[4c]（codex 389 号二批 M2）批级 fail-closed 负例：同批一干净成员+一异常成员（SQL 造态注入未软删 done 行）→ 发布 500 FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH（含异常单号 #${idBad} 定位信息）+ 两成员状态/授权六列/集合行/timeline 全部原值（整批零副作用）→ 清理异常行后重发成功（恢复对照）`);
  }

  // ══════════════════════════ [5]（组B·S2 语义重定义）终结后 submit → 正常进入待验证 + 零挂牌 ══════════════════════════
  //   ⚠️ 原语义"终结后 submit direct_release → 409 FAST_RELEASE_SUBMIT_DIRECT_DENIED"依赖的前置闸已随
  //   两步化方案 §4-2「整体替代」拍板整体拆除（见 verify-sys-fastlane-submit.js 头部 S2 语义翻转声明）。
  //   新语义：submit 不再有任何路径因"曾有授权但已终结"而拒绝——六列已清空 ⇒ isActiveFastReleaseAuth
  //   六列判据里 fast_release_auth_at 为 NULL ⇒ 挂牌闸（S2-1 新增）静默不触发，submit 本身正常 200 进入
  //   「待验证」，与从未获得过授权的单外部表现一致（direct_release 字段本身也已彻底停止消费，见
  //   validateSubmitBody 内 ALLOWED_TOP_KEYS 旁注）。
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[5] 终结后验证零挂牌');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[5-submit] 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    const returnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '[5] 打回以终结授权' });
    assert.strictEqual(returnR.status, 200, `[5-return] 应 200，实得 ${returnR.status}`);
    const rowAfterReturn = await fastReleaseRow(id);
    assertAllNull(rowAfterReturn, '[5-前置] 打回后六列应已清空');
    await estimateFuture(id);   // 打回清空 ETA，重新填才能再次 submit
    const beforeTl = await timelineCount(id);
    // 仍带 direct_release=true（legacy payload 兼容负例的另一实例）——若拆分支不干净（旧闸残留任一处
    // 未删），本条会以 409 的形式红；若挂牌闸误把"已终结"当"仍活跃"，本条会以"多插了一行
    // sys_fast_release_executors"的形式红。
    const dirR = await submitCommits(id, { directRelease: true });
    assert.strictEqual(dirR.status, 200, `[5] 终结后 submit 应正常 200（不再是 409——旧闸已随两步化拆除），实得 ${dirR.status} ${JSON.stringify(dirR.body)}`);
    assert.strictEqual(dirR.body.main_status, '待验证', `[5] main_status 应为「待验证」，实得 ${dirR.body.main_status}`);
    assert.strictEqual(dirR.body.online_source, undefined, `[5] 响应不应携带 online_source 键，实得 ${JSON.stringify(dirR.body.online_source)}`);
    const rowAfterSubmit = await issueRow(id);
    assert.strictEqual(rowAfterSubmit.status, '待验证', '[5] status 应为「待验证」');
    assert.strictEqual(rowAfterSubmit.online_source, null, '[5] online_source 应仍为空（未曾走已上线）');
    const feRows = await all('SELECT id FROM sys_fast_release_executors WHERE issue_id=?', [id]);
    assert.strictEqual(feRows.length, 0, `[5] 授权已终结，挂牌闸不应触发：sys_fast_release_executors 应恰 0 行，实得 ${feRows.length}`);
    assert.strictEqual(await timelineCount(id), beforeTl + 1, '[5] timeline 恰新增 1 条（runWGate 镜像行；无挂牌行、无直上拒绝行）');
    ok('[5]（语义重定义）终结后 submit（含 direct_release=true legacy payload）：正常 200 进入「待验证」+ 零挂牌（isActiveFastReleaseAuth 因 fast_release_auth_at 已被终结清空而判 false）+ timeline 恰新增 1 条 runWGate 镜像行');
  }

  // ══════════════════════════ [6]（组B·S2 订正）直上消费（fastlane 例外路径）→ 消费记录逐列完整保留 ══════════════════════════
  //   ⚠️ 原测法走真实 submit direct_release=true 链路，一次请求内同时完成"消费"与"进入已上线"——该
  //   分支已随两步化方案 §4-2 拆除，当前代码库暂无任何写 fast_release_consumed_at 的真实路径（S3+
  //   落地翻牌端点后才会有）。改用 SQL 造态直接构造"消费后"终态：本组要保护的不变量是"B1 三事件的
  //   终结逻辑不应误伤已经处于消费终态的行"，这是数据形态层面的不变量，与消费动作本身走真实端点还是
  //   造态构造正交——被测代码（sysIssueTransition 的终结判据、`isActiveFastReleaseAuth` 的
  //   consumed_at IS NULL 条件）只读现值字段，不关心历史成因。
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    const authResp = await authorize(id, '[6] 直上消费，六列应保留');
    const rowAfterAuth = await fastReleaseRow(id);
    await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'),
      online_source='authorized_fastlane', post_release_acceptance='pending',
      fast_release_consumed_at=datetime('now','localtime') WHERE id=?`, [id]);
    const after = await issueRow(id);
    // 逐列断言（任务②「消费记录完整保留」要求）——不用 deepStrictEqual 整体比对，是因为 consumed_at
    // 这一列在消费瞬间才写入（授权时为 NULL），必须分开断言"哪些列不变/哪些列新增"，不能笼统一句带过。
    assert.strictEqual(after.fast_release_auth_by, rowAfterAuth.fast_release_auth_by, '[6] fast_release_auth_by 应原样保留（未被 B1 清空）');
    assert.strictEqual(after.fast_release_auth_by_name, rowAfterAuth.fast_release_auth_by_name, '[6] fast_release_auth_by_name 应原样保留');
    assert.strictEqual(after.fast_release_auth_at, rowAfterAuth.fast_release_auth_at, '[6] fast_release_auth_at 应原样保留');
    assert.strictEqual(after.fast_release_auth_note, rowAfterAuth.fast_release_auth_note, '[6] fast_release_auth_note 应原样保留');
    assert.strictEqual(after.fast_release_revoked_at, null, '[6] fast_release_revoked_at 应仍为 NULL（未撤销）');
    assert.ok(after.fast_release_consumed_at, '[6] ⭐ fast_release_consumed_at 应已落库（消费戳，非 B1 清空对象）');
    assert.strictEqual(after.online_source, 'authorized_fastlane', '[6] online_source 应保留为 authorized_fastlane（非 B1 清空对象）');
    assert.strictEqual(after.post_release_acceptance, 'pending', '[6] post_release_acceptance 应初值 pending（非 B1 清空对象）');
    assert.strictEqual(after.status, '已上线', '[6] status 应落已上线');
    assert.strictEqual((await terminatedTlRows(id)).length, 0, '[6] 直上消费不属于 B1 三事件之一，不应产生 fast_release_auth_terminated 留痕行');
    ok('[6]（造态构造消费终态）已上线：授权四件套原样保留 + consumed_at 落库 + online_source/post_release_acceptance 保留，零终结留痕（B1 显式例外，逐列断言；消费机制本身当前无真实触发路径，见组头订正说明）');
  }

  // ══════════════════════════ [7] 事件④「验收拒绝」正例 + 对照组 ══════════════════════════
  //   [codex 368 号 MED-2 收口] bug 的 issue_reject from 集合含「待处理」（授权窗口内），拒绝时刻
  //   可能仍持有未消费的活跃授权——此前 B1 只覆盖 accept/return/C9 直翻三事件，本组补齐第四条边。
  {
    // [7a] 正例：待处理态授权活跃 → issue-reject → 落「已拒绝」→ 应终结（六列清空 + "已拒绝"文案）。
    const id = await bugAtDaichuli();
    await authorize(id, '[7a] 验收拒绝正例');
    const rowAfterAuth = await fastReleaseRow(id);
    assert.ok(rowAfterAuth.fast_release_auth_at, '[7a-前置] 授权已落库');
    const beforeRejectTl = await timelineCount(id);
    const rejectR = await call('POST', `/api/sys-issues/${id}/issue-reject`, adminTok, { reason: '[7a] 验收拒绝：终结正例' });
    assert.strictEqual(rejectR.status, 200, `[7a-reject] 应 200，实得 ${rejectR.status} ${JSON.stringify(rejectR.body)}`);
    assert.strictEqual(rejectR.body.status, '已拒绝', `[7a-reject] 应落已拒绝，实得 ${rejectR.body.status}`);
    const rowAfterReject = await fastReleaseRow(id);
    assertAllNull(rowAfterReject, '[7a-reject 后] ⭐⭐ 事件④命中：六列应被同事务清空');
    const tl7a = await terminatedTlRows(id);
    assert.strictEqual(tl7a.length, 1, `[7a] 应恰新增 1 条终结留痕，实得 ${tl7a.length}`);
    assert.strictEqual(tl7a[0].summary, '直上授权已失效（已拒绝）', `[7a] 终结行 summary 精确文案，实得="${tl7a[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforeRejectTl + 2, '[7a] timeline 恰新增 2 条（reject 主流转行 + 终结留痕行）');
    ok('[7a] 事件④「验收拒绝」正例：issue-reject 落「已拒绝」同事务终结活跃授权——六列清空 + 精确留痕文案');

    // [7b] 对照组：未授权的待处理单 → issue-reject → 正常拒绝，零终结留痕（证明终结逻辑是条件触发，
    //   不是"issue-reject 端点恒插入一条终结行"）。
    const idCtrl = await bugAtDaichuli();
    const rejectCtrl = await call('POST', `/api/sys-issues/${idCtrl}/issue-reject`, adminTok, { reason: '对照组：无授权拒绝不应产生终结留痕' });
    assert.strictEqual(rejectCtrl.status, 200, `[7b-reject] 应 200，实得 ${rejectCtrl.status} ${JSON.stringify(rejectCtrl.body)}`);
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[7b] ★对照组：未授权单拒绝不应产生任何终结留痕行');
    ok('[7b] ★对照组：未授权单 issue-reject → status 正常已拒绝，零终结留痕（证明终结逻辑是条件触发）');
  }

  // ══════════════════════════ [8] 事件⑤「作废」正例 + 对照组 ══════════════════════════
  //   [codex 368 号 MED-2 收口] void 的 from='*' 覆盖任意态，同样含授权窗口内的「待处理/处理中」。
  {
    // [8a] 正例：处理中态授权活跃 → void → 落「已作废」→ 应终结（六列清空 + "作废"文案）。
    const id = await bugAtChulizhong();
    await authorize(id, '[8a] 作废正例');
    const rowAfterAuth = await fastReleaseRow(id);
    assert.ok(rowAfterAuth.fast_release_auth_at, '[8a-前置] 授权已落库');
    const beforeVoidTl = await timelineCount(id);
    const voidR = await call('POST', `/api/sys-issues/${id}/void`, adminTok, { reason: '[8a] 作废：终结正例' });
    assert.strictEqual(voidR.status, 200, `[8a-void] 应 200，实得 ${voidR.status} ${JSON.stringify(voidR.body)}`);
    assert.strictEqual(voidR.body.status, '已作废', `[8a-void] 应落已作废，实得 ${voidR.body.status}`);
    const rowAfterVoid = await fastReleaseRow(id);
    assertAllNull(rowAfterVoid, '[8a-void 后] ⭐⭐ 事件⑤命中：六列应被同事务清空');
    const tl8a = await terminatedTlRows(id);
    assert.strictEqual(tl8a.length, 1, `[8a] 应恰新增 1 条终结留痕，实得 ${tl8a.length}`);
    assert.strictEqual(tl8a[0].summary, '直上授权已失效（作废）', `[8a] 终结行 summary 精确文案，实得="${tl8a[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforeVoidTl + 2, '[8a] timeline 恰新增 2 条（void 主流转行 + 终结留痕行）');
    ok('[8a] 事件⑤「作废」正例：void 落「已作废」同事务终结活跃授权——六列清空 + 精确留痕文案');

    // [8b] 对照组：未授权单 → void → 正常作废，零终结留痕。
    const idCtrl = await bugAtChulizhong();
    const voidCtrl = await call('POST', `/api/sys-issues/${idCtrl}/void`, adminTok, { reason: '对照组：无授权作废不应产生终结留痕' });
    assert.strictEqual(voidCtrl.status, 200, `[8b-void] 应 200，实得 ${voidCtrl.status} ${JSON.stringify(voidCtrl.body)}`);
    assert.strictEqual((await terminatedTlRows(idCtrl)).length, 0, '[8b] ★对照组：未授权单作废不应产生任何终结留痕行');
    ok('[8b] ★对照组：未授权单 void → status 正常已作废，零终结留痕（证明终结逻辑是条件触发）');
  }

  // ══════════════════════════ [9] reactivate 断言：无活跃授权可复活 + 违例反证 ══════════════════════════
  //   [codex 368 号 MED-2 收口] reactivate 的唯一前置态「已拒绝」现只能经 issue_reject 到达，[7a] 已
  //   在该分支终结掉活跃授权——本组双向证明新增的 fail-closed 断言：①正常回路不被误伤，且复活后的
  //   新一轮确认拿不到旧授权（[组B·S2 订正] 原断言"submit direct_release 仍 409"依赖的前置闸已随
  //   拆直上分支删除，改断言"新一轮无活跃授权 ⇒ 挂牌闸不触发"，同样堵住 MED-2 要修的"穿透进下一轮"
  //   缺口——只是外部可观测的证据从"409 拒绝"换成"零挂牌"，被保护的不变量本身不变：旧授权确实没有
  //   穿透进新一轮，新一轮的 submit 不会把它当活跃授权消费/挂牌）；
  //   ②SQL 造态构造"已拒绝残留活跃授权"违例行，断言应真的拦下（[[feedback_probe_test_bidirectional_proof]]）。
  {
    // [9a] 正例：授权 → issue-reject 终结 → reactivate（干净态，不应被新断言误拒）→ 重新走完受理/
    //   指派/估时 → submit（不再授权）应正常进入待验证，且零挂牌（旧授权未穿透进重新开的下一轮）。
    const idFromReject = await bugAtDaichuli();
    await authorize(idFromReject, '[9a] reactivate 正例：前置授权');
    const rejectR = await call('POST', `/api/sys-issues/${idFromReject}/issue-reject`, adminTok, { reason: '[9a] 前置拒绝：终结授权' });
    assert.strictEqual(rejectR.status, 200, `[9a-前置拒绝] 应 200，实得 ${rejectR.status}`);
    const rowAfterReject = await fastReleaseRow(idFromReject);
    assertAllNull(rowAfterReject, '[9a-前置] 拒绝后六列应已清空');
    const reactivateR = await call('POST', `/api/sys-issues/${idFromReject}/reactivate`, adminTok, { reason: '[9a] 复活：验证断言不误伤干净态' });
    assert.strictEqual(reactivateR.status, 200, `[9a-reactivate] 应 200（干净态不应被新断言误拒），实得 ${reactivateR.status} ${JSON.stringify(reactivateR.body)}`);
    const rowAfterReactivate = await fastReleaseRow(idFromReject);
    assertAllNull(rowAfterReactivate, '[9a-reactivate 后] 六列仍应全 NULL（reactivate 本身不写这组字段，前置已清空）');
    const intakeR = await call('POST', `/api/sys-issues/${idFromReject}/intake-accept`, adminTok, {});
    assert.strictEqual(intakeR.status, 200, `[9a-intake] 应 200，实得 ${intakeR.status} ${JSON.stringify(intakeR.body)}`);
    const assignR = await call('POST', `/api/sys-issues/${idFromReject}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(assignR.status, 200, `[9a-assign] 应 200，实得 ${assignR.status} ${JSON.stringify(assignR.body)}`);
    await estimateFuture(idFromReject);
    const dirR = await submitCommits(idFromReject, { directRelease: true });
    assert.strictEqual(dirR.status, 200, `[9a] 新一轮 submit 应正常 200（未重新授权，direct_release 字段已不再消费），实得 ${dirR.status} ${JSON.stringify(dirR.body)}`);
    assert.strictEqual(dirR.body.main_status, '待验证', `[9a] main_status 应为「待验证」，实得 ${dirR.body.main_status}`);
    const feRowsAfterReactivate = await all('SELECT id FROM sys_fast_release_executors WHERE issue_id=?', [idFromReject]);
    assert.strictEqual(feRowsAfterReactivate.length, 0, `[9a] 新一轮无活跃授权，挂牌闸不应触发：sys_fast_release_executors 应恰 0 行，实得 ${feRowsAfterReactivate.length}`);
    ok('[9a] reactivate 正例：干净态复活不被新断言误伤 + 拒绝轮的授权未穿透进重新开的下一轮（新一轮 submit 正常 200 进入待验证 + 零挂牌，证明旧授权确实没有被当作活跃授权消费）');

    // [9b]（★对照组·反证）SQL 造态：已拒绝单人为注入一份"理论上不该出现"的活跃授权（模拟本次收口前的
    //   存量脏数据，或未来新增一条到达「已拒绝」的路径却忘了同步终结），reactivate 应 fail-closed 500
    //   拒绝，且零副作用（status 不变、无 timeline 新增——事务整体回滚）。
    const idViolation = await bugAtDaichuli();
    const rejectV = await call('POST', `/api/sys-issues/${idViolation}/issue-reject`, adminTok, { reason: '[9b] 前置拒绝（本次无授权，走干净路径）' });
    assert.strictEqual(rejectV.status, 200, `[9b-前置拒绝] 应 200，实得 ${rejectV.status}`);
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime'), fast_release_auth_note = '[9b] SQL 造态注入'
               WHERE id = ?`, [idViolation]);
    const rowAfterInject = await fastReleaseRow(idViolation);
    assert.ok(rowAfterInject.fast_release_auth_at, '[9b-造态] 注入应已落库');
    const beforeReactivateTl = await timelineCount(idViolation);
    const reactivateV = await call('POST', `/api/sys-issues/${idViolation}/reactivate`, adminTok, { reason: '[9b] 应被断言拦下' });
    assert.strictEqual(reactivateV.status, 500, `[9b] ★对照组：残留活跃授权的已拒绝单 reactivate 应 500，实得 ${reactivateV.status} ${JSON.stringify(reactivateV.body)}`);
    assert.strictEqual(reactivateV.body.code, 'FAST_RELEASE_UNEXPECTED_ACTIVE_AUTH_ON_REACTIVATE', `[9b] 确切码，实得 ${reactivateV.body.code}`);
    const rowAfterDenied = await issueRow(idViolation);
    assert.strictEqual(rowAfterDenied.status, '已拒绝', '[9b] 零副作用：status 未变（事务回滚）');
    assert.strictEqual(await timelineCount(idViolation), beforeReactivateTl, '[9b] 零副作用：timeline 无新增（拒绝的 reactivate 尝试不落任何痕迹）');
    ok('[9b] ★对照组：SQL 造态注入"已拒绝单残留活跃授权"→ reactivate fail-closed 500 拒绝 + 零副作用（证明断言真的在拦，不是摆设）');
    // 清理注入行（防污染下方 [10] 全库探针扫描）。
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL, fast_release_auth_by_name = NULL, fast_release_auth_at = NULL, fast_release_auth_note = NULL WHERE id = ?`, [idViolation]);
  }

  // ══════════════════════════ [10] 不变量探针：全库扫描 + 双向证明（四态） ══════════════════════════
  {
    assert.strictEqual(typeof I.fastReleaseUnresolvedAtTerminalStateViolations, 'function', '[10-前置] 探针函数应已导出');
    const scanSql = `SELECT id, status, fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at FROM sys_issues`;

    // [10a] 正例：当前全库（走完 [1]-[9] 全部真实链路后）应零违例——前面每个正例都已正确终结，
    //   每个对照组本就没有走到终态，没有真正的"终态单残留活跃授权"存在。
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      assert.deepStrictEqual(violations, [], `[10a] 当前全库应零违例（B1 全部正确终结），实得 ${JSON.stringify(violations)}`);
      ok(`[10a] 不变量探针：当前全库（${rows.length} 行）扫描零违例——B1 五事件全部正确终结，无残留`);
    }

    // [10b]（★对照组·反证）SQL 造态构造一个"已上线单残留未消费活跃授权"的违例行——探针应判红，
    //   证明探针真的在检测这件事，不是永远返回空数组的摆设（[[feedback_probe_test_bidirectional_proof]]）。
    const idViolation = await bugAtChulizhong();
    await run(`UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'),
                 fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime')
               WHERE id = ?`, [idViolation]);
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      assert.strictEqual(violations.length, 1, `[10b] ★对照组：注入 1 条违例行后探针应判红（长度=1），实得 ${violations.length}——若为 0 说明探针失效`);
      assert.ok(violations[0].includes(`issue ${idViolation}`), `[10b] 违例文案应点名具体 issue id，实得="${violations[0]}"`);
      ok(`[10b] ★对照组：SQL 造态注入"已上线单残留未消费活跃授权"→ 探针正确判红（违例=${JSON.stringify(violations)}）`);
    }

    // [10c] 清理注入行后应恢复 0（同 [Y5] 范式"注入判红→清理恢复0"闭环）。
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL, fast_release_auth_by_name = NULL, fast_release_auth_at = NULL WHERE id = ?`, [idViolation]);
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      assert.deepStrictEqual(violations, [], `[10c] 清理注入行后应恢复零违例，实得 ${JSON.stringify(violations)}`);
      ok('[10c] 清理注入行后探针恢复零违例（清理本身未污染其余断言前提）');
    }

    // [10d]（★对照组，覆盖"已消费"合法态不误判）：同样已上线但 fast_release_consumed_at 非空
    //   （合法的 fastlane 直上消费态）不应被判违例——探针只认"未撤销且未消费"这一条真正的残留信号，
    //   不该把 [6] 那种合法保留态也误伤。
    const idConsumedLegit = await bugAtChulizhong();
    await run(`UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), online_source = 'authorized_fastlane',
                 fast_release_auth_by = 1, fast_release_auth_by_name = '管理员', fast_release_auth_at = datetime('now','localtime'),
                 fast_release_consumed_at = datetime('now','localtime')
               WHERE id = ?`, [idConsumedLegit]);
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      assert.deepStrictEqual(violations, [], `[10d] ★对照组：已消费的合法态不应误判为违例，实得 ${JSON.stringify(violations)}`);
      ok('[10d] ★对照组：已消费（fast_release_consumed_at 非空）的合法保留态不误判为违例——探针精确区分"残留"与"合法保留"');
    }
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL, fast_release_auth_by_name = NULL, fast_release_auth_at = NULL, fast_release_consumed_at = NULL WHERE id = ?`, [idConsumedLegit]);

    // [10e]（★对照组·反证·codex 368 号 MED-2 新增）SQL 造态构造一个"已拒绝单残留未消费活跃授权"的
    //   违例行——验证 FAST_RELEASE_TERMINAL_STATUSES 扩容后的新状态也被探针正确扫描（非只对旧的
    //   已上线/已关闭生效）。
    const idRejectViolation = await bugAtDaichuli();
    const rejectForViol = await call('POST', `/api/sys-issues/${idRejectViolation}/issue-reject`, adminTok, { reason: '[10e] 前置拒绝（本次无授权）' });
    assert.strictEqual(rejectForViol.status, 200, `[10e-前置拒绝] 应 200，实得 ${rejectForViol.status}`);
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime')
               WHERE id = ?`, [idRejectViolation]);
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      const hit = violations.find(v => v.includes(`issue ${idRejectViolation}`));
      assert.ok(hit, `[10e] ★对照组：注入"已拒绝单残留活跃授权"后探针应判红（命中该 id），实得 ${JSON.stringify(violations)}`);
      assert.ok(hit.includes('已拒绝'), `[10e] 违例文案应点名 status=「已拒绝」，实得="${hit}"`);
      ok(`[10e] ★对照组：SQL 造态注入"已拒绝单残留未消费活跃授权"→ 探针正确判红（终态集合扩容后「已拒绝」同样受扫描）`);
    }
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL, fast_release_auth_by_name = NULL, fast_release_auth_at = NULL WHERE id = ?`, [idRejectViolation]);

    // [10f]（★对照组·反证·codex 368 号 MED-2 新增）同款，验证「已作废」。
    const idVoidViolation = await bugAtChulizhong();
    const voidForViol = await call('POST', `/api/sys-issues/${idVoidViolation}/void`, adminTok, { reason: '[10f] 前置作废（本次无授权）' });
    assert.strictEqual(voidForViol.status, 200, `[10f-前置作废] 应 200，实得 ${voidForViol.status}`);
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime')
               WHERE id = ?`, [idVoidViolation]);
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      const hit = violations.find(v => v.includes(`issue ${idVoidViolation}`));
      assert.ok(hit, `[10f] ★对照组：注入"已作废单残留活跃授权"后探针应判红（命中该 id），实得 ${JSON.stringify(violations)}`);
      assert.ok(hit.includes('已作废'), `[10f] 违例文案应点名 status=「已作废」，实得="${hit}"`);
      ok(`[10f] ★对照组：SQL 造态注入"已作废单残留未消费活跃授权"→ 探针正确判红（终态集合扩容后「已作废」同样受扫描）`);
    }
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL, fast_release_auth_by_name = NULL, fast_release_auth_at = NULL WHERE id = ?`, [idVoidViolation]);

    // 最终收尾：全库应恢复零违例（[10b]/[10e]/[10f] 注入均已清理，[10d] 消费态本就不算违例）。
    {
      const rows = await all(scanSql);
      const violations = I.fastReleaseUnresolvedAtTerminalStateViolations(rows);
      assert.deepStrictEqual(violations, [], `[10-收尾] 全部注入清理完毕后应恢复零违例，实得 ${JSON.stringify(violations)}`);
    }

    ok('[10] 不变量探针 fastReleaseUnresolvedAtTerminalStateViolations：全库扫描 + 四态（已上线/已关闭/已拒绝/已作废）构造违例判红 + 清理恢复0 + 合法保留态不误判（双向证明闭环）');
  }

  server.close();
  console.log(`\n✅ verify-sys-fastrelease-termination 全绿：${passed} 组断言通过`);
  console.log('  覆盖：事件②验收通过(正例+hold对照组) + 事件③验收打回(正例+reassign对照组) + ' +
    '事件①上线翻牌·C9直翻子路径(正例+未授权对照组) + 事件①上线翻牌·批次发布双保险子路径(SQL造态正例+对照组+[4c]批级fail-closed负例含定位信息+恢复对照) + ' +
    '终结后submit零挂牌(语义重定义·不再是409) + 直上消费例外逐列保留(造态构造) + ' +
    '事件④验收拒绝(正例+未授权对照组) + 事件⑤作废(正例+未授权对照组) + ' +
    'reactivate断言(干净态复活+旧授权不穿透新一轮+SQL造态违例500反证) + ' +
    '不变量探针(全库扫描+四态反证判红+清理恢复0+合法态不误判)');
}

main().catch(e => { console.error('❌ verify-sys-fastrelease-termination 失败:', e && e.stack || e); process.exit(1); });
