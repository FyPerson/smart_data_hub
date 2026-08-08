// verify-sys-bug-derive.js —— bug 流 Commit ⑤：派生双描述 + M5 反向约束 + fix_gap_note 首提闸门
//   （bug流_方案_20260702_v1.2 §4；承 ① 临时闸 SYS_BUG_DERIVE_PENDING 放开）
// 覆盖：
//   [D1] ① 临时闸已放开：bug 已上线 → 派生 bug 新单（带 derive_reason）→ 201
//   [D2] M5 反向约束：bug 非已上线（处理中/待上线）→ 派生 → 409 SYS_DERIVE_ORIGIN_NOT_ONLINE
//   [D3] derive_reason 必填仅 bug 语境：bug 已上线派生缺 reason → 400 DERIVE_REASON_REQUIRED；feature 原单派生免填 → 201
//   [D4] 默认 new.type=bug：bug 已上线派生省略 type → 新单 type=bug（M5 默认）
//   [D5] derive_reason 落列 + timeline summary（Q2 取代 derive_note）
//   [D6] fix_gap_note 首提闸门：bug 派生 bug 新单首提缺 fix_gap_note → 400；带则落列；返工重提不再要求也不覆写
//   [D7] 跨类型 bug→feature 派生：新单 feature 首提免 fix_gap_note（M5 跳过）；feature→bug 派生首提亦跳过（origin.type≠bug）
//   [D8] 写读同源：详情 GET 返回 derive_reason + fix_gap_note
//   [D9] 防环（① 起逻辑，⑤ 仅移位未改）：派生链成环 → 409 DERIVE_CYCLE
//   [D10] fix_gap_note 闸门 fail-closed（codex M-1 采纳）：origin 查不到 → 409 SYS_ORIGIN_MISSING
//   （codex 100 号 HIGH-2：D6/D7/D8/D10 在 C3 一度被误判"随旧 submit 退场"而移除，现按 e39e65b 版旧 case
//    'submit' 逐字复刻回填 first_submitted_at/fix_gap_note 后已恢复，本文件断言相应改回真实路由验证）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-derive-secret';
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
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }

// 建 bug 单 → 指派 devId → 返回 id（处理中态）
async function seedBugToDev(devId = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
// bug 单 → 待上线（指派→estimate→submit→accept）
async function seedBugToReady(devId = 5) {
  const id = await seedBugToDev(devId);
  let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200, `bug estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-1' }], self_tested: true, test_env_deployed: true });
  assert.strictEqual(r.status, 200, `bug submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `bug accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
// bug 单 → 已上线（待上线 → 直接 SQL 打状态）
//   ⚠️ C3（上线体统一重构）后端批：execute-release 全类型 409 退场（旧 G5 hotfix/G6 publish 两模式随
//   "全类型统一"一并收口，bug 现与其他类型同走 hotfix-publish/排班+安排上线+执行上线），本 helper
//   （用于给"派生"功能造一个已上线的 origin 样本，不测发布机制本身）改走直接 SQL 构造，不依赖已退场
//   端点——循 verify-sys-bug-notify.js:139-144 bugOnlineNoRelease 同款先例（release_id 保持 NULL，
//   与 bug 流"hotfix 不建批次"的既有语义一致）。
async function seedBugToOnline(devId = 5) {
  const id = await seedBugToReady(devId);
  await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [id]);
  assert.strictEqual(await statusOf(id), '已上线', 'seedBugToOnline 应停在 已上线');
  return id;
}
// feature 单 → 待上线（走变更流）
async function seedFeatureToReady(devId = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'feat单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, `feature 补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本 helper 只是拿一个"待上线" feature 单
  // 当 bug 派生（D7 跨类型 bug↔feature）的 origin，与「待对接测试」段本身无关（后者由专门的
  // verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时失效，触发 §3.0-⑥ 降级路径，使 submit
  // 仍直落"待验证"→可立即 accept 到"待上线"——本文件其余断言零改动，这也是方案承认的合法真实场景。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-2' }], self_tested: true, test_env_deployed: true });
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `feature accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [D1] ① 临时闸放开：bug 已上线 → 派生 bug 新单（带 derive_reason）201 ═══
  {
    const originId = await seedBugToOnline();
    const r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '同源导出再复现', system_name: 'BMS', source: '生产故障', derive_reason: '上次只修单表导出，多表 join 复现' });
    assert.strictEqual(r.status, 201, `bug 已上线派生应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.type, 'bug');
    // ⭐ 角色权限重构 C0：derive 新单走创建路径唯一入口（resolveSysInitialStatusForCreate）→ 恒落「待受理」。
    //   原「新单默认 intake_required=0 直落待处理」正是 v1.5 §2.2-A 认定的"derive 绕过受理门"缺口。
    assert.strictEqual(r.body.status, '待受理', 'C0：派生 bug 新单落 待受理（派生单同样必经受理）');
    const drvRow = await get('SELECT intake_required FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(drvRow.intake_required, 1, 'C0：derive INSERT 显式落 intake_required=1（防「待受理+ir0」矛盾单卡死受理）');
    assert.strictEqual(r.body.origin_issue_id, originId);
    const child = await get('SELECT origin_issue_id FROM sys_issues WHERE id=?', [r.body.id]);
    assert.strictEqual(child.origin_issue_id, originId, '新单 origin_issue_id 指向原单');
    ok('[D1] bug 已上线 → 派生 bug 新单（带 derive_reason）201，origin_issue_id 正确、初始态待处理');
  }

  // ═══ [D2] M5 反向约束：bug 非已上线 → 派生 409 SYS_DERIVE_ORIGIN_NOT_ONLINE ═══
  {
    const devBug = await seedBugToDev();        // 处理中
    let r = await call('POST', `/api/sys-issues/${devBug}/derive`, adminTok,
      { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', derive_reason: 'r' });
    assert.strictEqual(r.status, 409, `处理中 bug 派生应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SYS_DERIVE_ORIGIN_NOT_ONLINE');
    const readyBug = await seedBugToReady();    // 待上线
    r = await call('POST', `/api/sys-issues/${readyBug}/derive`, adminTok,
      { type: 'bug', title: 'y', system_name: 'BMS', source: '内部', derive_reason: 'r' });
    assert.strictEqual(r.status, 409, `待上线 bug 派生应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SYS_DERIVE_ORIGIN_NOT_ONLINE');
    assert.strictEqual((await all('SELECT id FROM sys_issues WHERE origin_issue_id=?', [devBug])).length, 0, '被拒未建新单（事务回滚）');
    ok('[D2] M5 反向约束：处理中 / 待上线 bug 派生均 409 SYS_DERIVE_ORIGIN_NOT_ONLINE + 无脏新单（§4 仅从已上线派生）');
  }

  // ═══ [D3] derive_reason 必填仅 bug 语境 ═══
  {
    const originId = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '缺原因', system_name: 'BMS', source: '内部' });      // 无 derive_reason
    assert.strictEqual(r.status, 400, `bug 派生缺 derive_reason 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DERIVE_REASON_REQUIRED');
    r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '空白原因', system_name: 'BMS', source: '内部', derive_reason: '   ' });   // trim 后空
    assert.strictEqual(r.status, 400, `derive_reason 纯空白应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DERIVE_REASON_REQUIRED');
    // feature 原单派生免填 derive_reason（Q1 仅 bug 语境）
    const featId = await seedFeatureToReady();
    r = await call('POST', `/api/sys-issues/${featId}/derive`, adminTok,
      { type: 'feature', title: 'feat 迭代', system_name: 'BMS', source: '内部' });   // 无 derive_reason
    assert.strictEqual(r.status, 201, `feature 派生免 derive_reason 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[D3] derive_reason 必填仅 bug 语境：bug 缺原因/纯空白 → 400 DERIVE_REASON_REQUIRED；feature→feature 派生免填 201');
  }

  // ═══ [D4] 默认 new.type=bug（M5）═══
  {
    const originId = await seedBugToOnline();
    const r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { title: '省略 type', system_name: 'BMS', source: '内部', derive_reason: '默认 bug' });   // 省略 type
    assert.strictEqual(r.status, 201, `省略 type 应默认 bug 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.type, 'bug', 'origin=bug 省略 type → 新单默认 bug');
    ok('[D4] M5 默认 new.type=bug：origin=bug + 省略 type → 新单 type=bug（201）');
  }

  // ═══ [D5] derive_reason 落列 + timeline summary（Q2 取代 derive_note）═══
  {
    const originId = await seedBugToOnline();
    const reason = '上次遗漏并发写入路径';
    const r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '并发再现', system_name: 'BMS', source: '内部', derive_reason: reason });
    assert.strictEqual(r.status, 201);
    const newId = r.body.id;
    assert.strictEqual((await get('SELECT derive_reason FROM sys_issues WHERE id=?', [newId])).derive_reason, reason, 'derive_reason 落新单列');
    const dtl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='derive'`, [newId]);
    assert.strictEqual(dtl.summary, reason, 'derive timeline summary = derive_reason（取代 derive_note）');
    // derive_note 旧字段应被忽略（合并后不再消费）：即便传 derive_note 也不影响 summary（以 derive_reason 为准）
    const r2 = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '旧字段忽略', system_name: 'BMS', source: '内部', derive_reason: reason, derive_note: '这是旧字段不该被采纳' });
    const dtl2 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='derive'`, [r2.body.id]);
    assert.strictEqual(dtl2.summary, reason, 'derive_note 已废弃：summary 仍取 derive_reason');
    ok('[D5] derive_reason 落列 + 作 derive timeline summary（Q2 取代 derive_note；旧 derive_note 传入被忽略）');
  }

  // ═══ [codex 100 号 HIGH-2 回填] [D6] fix_gap_note 首提闸门 + 仅首提 ═══
  //   新 submit handler 曾静默遗漏此不变量（与 98 号 HIGH 同类回归），已按 e39e65b 版旧 case 'submit'
  //   （index.js:1385-1396）逐字复刻恢复，本文件断言改回真实路由验证（非"多余字段 400"的临时降级）。
  {
    const originId = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '派生修复单', system_name: 'BMS', source: '内部', derive_reason: '需再修' });
    const newId = r.body.id;
    // ⭐ 角色权限重构 C0：派生新单同样恒落「待受理」→ 先受理（→待处理）才能 assign
    await call('POST', `/api/sys-issues/${newId}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${newId}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${newId}/estimate`, devTok, { dev_estimated_at: EST });
    // 首提缺 fix_gap_note → 400
    r = await call('POST', `/api/sys-issues/${newId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-3' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `派生 bug 首提缺 fix_gap_note 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'FIX_GAP_NOTE_REQUIRED');
    assert.strictEqual((await get('SELECT first_submitted_at FROM sys_issues WHERE id=?', [newId])).first_submitted_at, null, '首提被拒 first_submitted_at 未盖（整事务回滚）');
    // ⭐ [C9-fix L5] 同批补：被拒的 submit 不得留下 commit 行。
    //   原先只查了 first_submitted_at 一个字段，而这条请求 body 里**带着一条 commits**——"整事务回滚"这个
    //   声称真正要保证的是 payload 里所有落库项都没写进去，只验一个时间戳列是抽样不是证明。
    //   ⚠️ 与 C9 直接相关：commit 行残留会让本单**永久失去**免上线直翻资格（准入条件① active 行数=0），
    //     而这条残留来自一次**被拒绝**的请求——用户会遇到"我那次提交明明报错了，怎么这单再也不能免上线"
    //     这种无从排查的现象。零残留断言把这条链堵在最前面。
    assert.strictEqual(
      Number((await get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [newId])).c), 0,
      '首提被拒 → commit 行零残留（请求 body 带 commits，整事务回滚须连它一起回，否则残留行会永久剥夺该单的 C9 免上线直翻资格）');
    // 首提带 fix_gap_note → 200 + 落列 + first_submitted_at 盖章
    r = await call('POST', `/api/sys-issues/${newId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-4' }], fix_gap_note: '上版漏了 join 空指针', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `带 fix_gap_note 首提应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterFirst = await get('SELECT fix_gap_note, first_submitted_at FROM sys_issues WHERE id=?', [newId]);
    assert.strictEqual(afterFirst.fix_gap_note, '上版漏了 join 空指针', 'fix_gap_note 落列');
    assert.ok(afterFirst.first_submitted_at, 'first_submitted_at 首次提交原子盖章');
    // 打回 → 返工重提不再要求 fix_gap_note（first_submitted_at 已盖），且不覆写原值
    r = await call('POST', `/api/sys-issues/${newId}/return`, adminTok, { reason: '还有问题' });
    assert.strictEqual(r.status, 200, `打回 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // §1 不变量1「完成态不回 pending」：return 不重置 roster dev_status（同 verify-sys-bug-transitions.js
    //   「二轮」场景已验证的既有事实），单开发不能直接 remove 自己（LAST_ASSIGNEE）——需先加协作解除限制→
    //   remove 旧完成态实例→re-add 同一开发（全新 pending 实例，方案 §4.4）才能真正重提。
    r = await call('POST', `/api/sys-issues/${newId}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, '临时加协作(6) 200, got ' + JSON.stringify(r.body));
    const oldDa = r.body.dev_assignees.find(d => d.user_id === 5);
    r = await call('DELETE', `/api/sys-issues/${newId}/dev-assignees/${oldDa.id}`, adminTok, { reason: '二轮重置旧完成态实例' });
    assert.strictEqual(r.status, 200, 'remove 旧完成态实例 200, got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${newId}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, 're-add(5) 200, got ' + JSON.stringify(r.body));
    // 协作(6) 仍在册 pending（不影响本节断言，仅验证 5 的 fix_gap_note/first_submitted_at 行为，故不必撤回）
    await call('POST', `/api/sys-issues/${newId}/estimate`, devTok, { dev_estimated_at: EST });
    r = await call('POST', `/api/sys-issues/${newId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-5' }], self_tested: true, test_env_deployed: true });   // 无 fix_gap_note
    assert.strictEqual(r.status, 200, `返工重提免 fix_gap_note 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const afterSecond = await get('SELECT fix_gap_note, first_submitted_at FROM sys_issues WHERE id=?', [newId]);
    assert.strictEqual(afterSecond.fix_gap_note, '上版漏了 join 空指针', '返工重提不覆写首版 fix_gap_note');
    assert.strictEqual(afterSecond.first_submitted_at, afterFirst.first_submitted_at, 'first_submitted_at 首次永不变（返工不重盖）');
    ok('[D6] fix_gap_note 首提闸门：派生 bug 首提缺则 400 FIX_GAP_NOTE_REQUIRED / 带则落列 + first_submitted_at 原子盖章 / 返工重提不再要求也不覆写（一次性首版留痕）');
  }

  // ═══ [codex 100 号 HIGH-2 回填] [D7] 跨类型派生首提跳过 fix_gap_note（M5）═══
  {
    // bug→feature：新单 feature，走变更流首提不要 fix_gap_note
    const bugOrigin = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${bugOrigin}/derive`, adminTok,
      { type: 'feature', title: '升级为需求', system_name: 'BMS', source: '内部', derive_reason: '不是缺陷是新需求' });
    assert.strictEqual(r.status, 201, `bug→feature 跨类型派生应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const featChild = r.body.id;
    assert.strictEqual(r.body.type, 'feature');
    // ⭐ 角色权限重构 C2.5 撤销（v2.1）：派生出的**变更流**新单同建单一样直落「待受理」——预沟通段整体撤销，
    //   不再需要 pre-discuss-pass 中转。
    // ⭐ 角色权限重构 C0：派生新单恒 intake_required=1 → 先受理（feature → 待指派）才能 assign
    //   （schedule 早已退场，此处调用是历史遗留 no-op，保留不动以免扩大 C0 diff）
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    await call('POST', `/api/sys-issues/${featChild}/intake-accept`, adminTok, { risk_level: '二级' });
    await call('POST', `/api/sys-issues/${featChild}/schedule`, adminTok, {});
    // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
    const oaChild = await call('POST', `/api/sys-issues/${featChild}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(oaChild.status, 200, `派生 feature 子单补 OA 号 200, got ${oaChild.status} ${JSON.stringify(oaChild.body)}`);
    await call('POST', `/api/sys-issues/${featChild}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${featChild}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
    r = await call('POST', `/api/sys-issues/${featChild}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-6' }], self_tested: true, test_env_deployed: true });   // 无 fix_gap_note
    assert.strictEqual(r.status, 200, `bug→feature 派生单首提应免 fix_gap_note 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT fix_gap_note FROM sys_issues WHERE id=?', [featChild])).fix_gap_note, null, '跨类型派生单 fix_gap_note 保持 NULL');
    // feature→bug：新单 bug 但 origin.type=feature，首提亦跳过（谓词要求 origin.type=bug）
    const featOrigin = await seedFeatureToReady();
    r = await call('POST', `/api/sys-issues/${featOrigin}/derive`, adminTok,
      { type: 'bug', title: '迭代出的 bug', system_name: 'BMS', source: '内部' });   // feature 原单免 derive_reason
    assert.strictEqual(r.status, 201, `feature→bug 派生应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const bugChild = r.body.id;
    // ⭐ 角色权限重构 C0：派生新单恒落「待受理」→ 先受理（bug → 待处理）才能 assign
    await call('POST', `/api/sys-issues/${bugChild}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${bugChild}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${bugChild}/estimate`, devTok, { dev_estimated_at: EST });
    r = await call('POST', `/api/sys-issues/${bugChild}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-7' }], self_tested: true, test_env_deployed: true });   // 无 fix_gap_note
    assert.strictEqual(r.status, 200, `feature→bug 派生单首提应免 fix_gap_note（origin.type≠bug）200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[D7] 跨类型派生跳过 fix_gap_note（M5）：bug→feature 新单 feature 首提免填；feature→bug 新单 bug 但 origin≠bug 亦免填');
  }

  // ═══ [codex 100 号 HIGH-2 回填] [D8] 写读同源：详情 GET 返回 derive_reason + fix_gap_note ═══
  {
    const originId = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '同源单', system_name: 'BMS', source: '内部', derive_reason: '读端可见性验证' });
    const newId = r.body.id;
    // ⭐ 角色权限重构 C0：派生新单同样恒落「待受理」→ 先受理（→待处理）才能 assign
    await call('POST', `/api/sys-issues/${newId}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${newId}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${newId}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${newId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-8' }], fix_gap_note: '缺口在边界判断', self_tested: true, test_env_deployed: true });
    r = await call('GET', `/api/sys-issues/${newId}`, adminTok);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.issue.derive_reason, '读端可见性验证', '详情读端返回 derive_reason');
    assert.strictEqual(r.body.issue.fix_gap_note, '缺口在边界判断', '详情读端返回 fix_gap_note');
    assert.ok(r.body.origin_issue && r.body.origin_issue.type === 'bug', '详情 origin_issue.type 供前端判 fix_gap_note 条件');
    ok('[D8] 写读同源：详情 GET 返回 derive_reason + fix_gap_note + origin_issue.type（前端条件判定所需）');
  }

  // ═══ [D9] 防环（① 逻辑，⑤ 仅移位）：派生链成环 → 409 DERIVE_CYCLE ═══
  {
    const a = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${a}/derive`, adminTok,
      { type: 'bug', title: 'B', system_name: 'BMS', source: '内部', derive_reason: 'r' });
    const bId = r.body.id;
    // 手工污染：令 a.origin_issue_id = B，构造 A→B→A 环（模拟脏库；正常路径不会出现）
    await run('UPDATE sys_issues SET origin_issue_id=? WHERE id=?', [bId, a]);
    r = await call('POST', `/api/sys-issues/${a}/derive`, adminTok,
      { type: 'bug', title: '成环', system_name: 'BMS', source: '内部', derive_reason: 'r' });
    assert.strictEqual(r.status, 409, `成环派生应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'DERIVE_CYCLE', '防环 M-1 在 ⑤ 移位后仍生效');
    ok('[D9] 防环 M-1 移位后仍生效：派生链成环 → 409 DERIVE_CYCLE');
  }

  // ═══ [codex 100 号 HIGH-2 回填] [D10] fix_gap_note 闸门 fail-closed（codex M-1 采纳）：origin 查不到 → 409 SYS_ORIGIN_MISSING ═══
  {
    const originId = await seedBugToOnline();
    let r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
      { type: 'bug', title: '孤儿单', system_name: 'BMS', source: '内部', derive_reason: 'r' });
    const newId = r.body.id;
    // ⭐ 角色权限重构 C0：派生新单同样恒落「待受理」→ 先受理（→待处理）才能 assign
    await call('POST', `/api/sys-issues/${newId}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${newId}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${newId}/estimate`, devTok, { dev_estimated_at: EST });
    // 手工污染：令 origin_issue_id 指向不存在的行（模拟脏谱系；正常 API 不可达——无硬删除端点）
    await run('UPDATE sys_issues SET origin_issue_id=999999 WHERE id=?', [newId]);
    r = await call('POST', `/api/sys-issues/${newId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-9' }], fix_gap_note: '缺口', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 409, `origin 缺失首提应 fail-closed 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SYS_ORIGIN_MISSING');
    assert.strictEqual(await statusOf(newId), '处理中', 'fail-closed 后仍停处理中（事务未推进）');
    ok('[D10] fix_gap_note 闸门 fail-closed：origin_issue_id 指向不存在行 → 409 SYS_ORIGIN_MISSING（不静默放行绕过留痕）');
  }

  console.log(`\n✅ verify-sys-bug-derive 全绿：${passed} 项`);
  server.close();
  db.close();
}

main().catch(e => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
