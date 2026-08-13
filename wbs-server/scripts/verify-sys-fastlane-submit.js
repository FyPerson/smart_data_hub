// scripts/verify-sys-fastlane-submit.js — 系统迭代·组 B「bug 先行上线」阶段二（submit 直上面）验收
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §3.2（开发直上）+ §3.4（不变量七条）
//   用法：node scripts/verify-sys-fastlane-submit.js
//
// 范围声明：本阶段只做 §3.2 submit 端点 direct_release=true 分支（单事务条件更新翻牌）+ §3.4 不变量
//   ①②③⑦（成组约束）。§3.3 补验收端点（passed/failed_derived 分支/48h 圈红/通知）是 SB3 范围，本文件
//   不覆盖（本轮只写 post_release_acceptance='pending' 初值，不构造真实通过/派生场景）。姊妹文件
//   verify-sys-fastrelease-auth.js 覆盖 §3.1 授权面（fast-release-authorize/revoke 两端点），两文件正交、
//   不重复断言（该文件 [7e] 已用 SQL 造态预演本文件将要落地的 online_source='authorized_fastlane' 字面量，
//   本文件是它的真实实现验证）。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1] 直上正例（commits 模式）：授权+处理中→submit(direct_release=true)→已上线五字段原子落库
//       （status/released_at/online_source/post_release_acceptance/fast_release_consumed_at）+ timeline
//       一条 fast_release_direct_online + submit 通用副作用保留（first_submitted_at 首写/commit 记录/
//       dev_status→code_submitted）
//   [1b] 直上正例（no_code 模式）：同上，验证两种 mode 均可触发直上（方案未限定 mode）
//   [2] 并发/重复消费防线：SQL 造态"理论不可达组合"（已消费+处理中并存）409 零副作用 + 顺序双请求（第二次
//       409 零副作用，状态已非处理中）
//   [3] 负例族：无授权/已撤销/已消费(SQL造态)/已有上线标记(SQL造态)/非 bug 类型 —— 各 409 + 整个 submit
//       回滚零残留（dev_status 仍 pending / first_submitted_at 仍空 / 无 commit 行 / timeline 不增）
//   [3b] status≠处理中 分支的函数级直调证明（HTTP 层结构性不可达：bug 的 DEV 族仅含「处理中」一个状态，
//       走到本函数前 step2 家族检查已挡住其余状态；同 index.js 注释"结构性重叠"如实记录，不假装能从
//       HTTP 层触达）
//   [4] direct_release=false / 缺省：现行为零变化回归——即便该单挂着活跃未消费授权，不勾选就不消费，
//       正常走待验证，fast_release_* 五列/online_source/post_release_acceptance 全部保持原样
//   [5] 多开发场景三态（[预筛 M1/M2] 裁定=最后提交者勾选·零行为变更）：[5-a] 非最后提交者勾选
//       direct_release=true → 409 FAST_RELEASE_SUBMIT_ROSTER_INCOMPLETE + 精确引导文案，本人这次提交
//       整体回滚零副作用；[5-b] 全员普通提交（均不勾选）→ 正常推进「待验证」，证明"全完成"本身不隐式
//       触发直上；[5-c] 最后一位提交者勾选 direct_release=true → 一次请求内自身 CAS 完成花名册后闸门
//       放行，直接成功直上（五字段原子+timeline），证明该路径现实现已天然支持
//   [6] 不变量①②③⑦探针（[Y5] 范式）：JS 纯函数用例表（3 正例+8 反例）+ 候选行 SQL 粗筛→
//       I.fastlaneAcceptanceInvariantViolations 逐行精判（内存库注入对照①②③⑦各一条，含空串反例）+
//       真实本地库（task_pool.db）同一判据违例计数=0
//   [7] online_source 消费面：列表端点/详情端点 online_source_kind==='authorized_fastlane'（真实 HTTP）+
//       deriveOnlineSourceKind 直调三/四分支穷举 + SI_ONLINE_SOURCE_LABEL/SI_TL_LABEL 前端字典覆盖（静态源码扫描）
//   [8] assertMainStatusTransition FAST_RELEASE_DIRECT routeKind 单元覆盖：合法边放行 + action≠'submit'拒 +
//       边非法拒 + roster 门（未全完成 400）
//   [9]（预筛 HIGH-1）reopen 清补验收字段组三列：真实链路正向用例——直上 → close → reopen → 三列全清空 +
//       fastlaneAcceptanceInvariantViolations 零违例（非构造行，走真实端点链，区别于 [6] 的构造行用例）
//   [10]（预筛 MED-1）last_completed_at 直上分支：真实直上后列表 + 详情两面均取到直上时刻（等于
//       fast_release_direct_online timeline 行 created_at），两处子查询同源一致
//   [11]（预筛 MED-2·2026-08-13 组 B·B1 授权终结事件制落地后改 SQL 造态）授权须晚于最近一次 reopen
//       （纵深防御，已从"第一道防线"降级）：成对用例——(a) SQL 造态构造悬垂授权跨轮 409 精确文案
//       （经真实状态机路径已结构性不可达，accept 的 C9 直翻分支会先终结活跃授权，故改造态直接验证
//       WHERE 层防线本身）(b) 对照组 reopen 后重新授权正常消费成功
//   [12]（预筛 M3）isActiveFastReleaseAuth 唯一判据 fail-closed：缺列入参抛错——(a) 缺 reopened_at 单列
//       抛 500 FAST_RELEASE_PREDICATE_INPUT_INVARIANT (b) 对照组六列全投影（含显式 null）不误报
//       (c) 六列逐列穷举缺列均抛错 (d) 静态核对生产唯一调用点 SELECT 六列齐全
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-fastlane-submit-secret';
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
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);

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
function fail(msg) { console.error('\n❌ verify-sys-fastlane-submit 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const isChangeType = type === 'feature' || type === 'improvement';
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `FS-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-fastlane-submit 夹具', intake_liaison_id: 13,
    ...(isChangeType ? { needs_feasibility: 0 } : {}),
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// 单开发 bug·处理中态夹具（真实端点链路：建单→受理→指派 dev5）。
async function bugAtChulizhong() {
  const id = await mkIssue('bug');
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `[夹具-受理] 应 200，实得 ${acc.status} ${JSON.stringify(acc.body)}`);
  const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(asg.status, 200, `[夹具-指派] 应 200，实得 ${asg.status} ${JSON.stringify(asg.body)}`);
  return id;
}
// 双开发 bug·处理中态夹具（dev5 + dev6 均在册·pending）。
async function bugAtChulizhongTwoDevs() {
  const id = await mkIssue('bug');
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `[夹具-双开发-受理] 应 200，实得 ${acc.status}`);
  const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(asg.status, 200, `[夹具-双开发-指派] 应 200，实得 ${asg.status}`);
  const add = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
  assert.strictEqual(add.status, 200, `[夹具-双开发-加人] 应 200，实得 ${add.status} ${JSON.stringify(add.body)}`);
  return id;
}
// 给某单填未来预计完成时间（ESTIMATE_REQUIRED 前置）。extraBody 供非 bug 类型补 estimated_effort_days（C7 工期硬闸）。
async function estimateFuture(id, tok = devTok, extraBody = {}) {
  const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
  const r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: futureEst, ...extraBody });
  assert.strictEqual(r.status, 200, `[estimate] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
async function authorize(id, tok = adminTok, note) {
  const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, tok, note ? { note } : {});
  assert.strictEqual(r.status, 200, `[授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
// 提交 body 构造器：commits 模式（默认）或 no_code 模式。
function submitBody({ mode = 'commits', directRelease, extra = {} } = {}) {
  const base = {
    self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因',
    ...(directRelease !== undefined ? { direct_release: directRelease } : {}),
  };
  if (mode === 'no_code') return { ...base, mode: 'no_code', no_code_reason: 'verify 夹具：无提交交付', ...extra };
  return { ...base, mode: 'commits', commits: [{ component: 'backend', commit_ref: `svn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }], ...extra };
}

const issueRow = (id) => get(
  `SELECT id, type, status, released_at, online_source, post_release_acceptance, post_accepted_at,
          post_derive_issue_id, fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at,
          release_id, first_submitted_at, gate_deferred_at
     FROM sys_issues WHERE id=?`, [id]);
const devAssigneeRow = (issueId, userId) => get(
  `SELECT id, dev_status, resolved_at FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, userId]);
const timelineCount = (id) => get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]).then(r => Number(r.c));
const timelineRowsByCode = (id, actionCode) => all(
  `SELECT event_type, from_status, to_status, summary, action_code, operator_id, operator_name
     FROM sys_issue_timeline WHERE issue_id=? AND action_code=? ORDER BY id`, [id, actionCode]);
const commitCount = (issueId) => get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [issueId]).then(r => Number(r.c));

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
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5 / dev2#6 / 受理人13）');

  // ══════════════════════════ [0] schema 三列已就绪（前置自检） ══════════════════════════
  {
    const cols = (await all(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
    for (const c of ['post_release_acceptance', 'post_accepted_at', 'post_derive_issue_id']) {
      assert.ok(cols.includes(c), `[0] sys_issues 应含列 ${c}（alterAddMissingCols [1a-15] 未生效？）`);
    }
    ok('[0] sys_issues 三列（post_release_acceptance/post_accepted_at/post_derive_issue_id）均已就绪');
  }

  // ══════════════════════════ [1] 直上正例（commits 模式）══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '快车道-正例1');
    const beforeTl = await timelineCount(id);
    const before = await issueRow(id);
    assert.strictEqual(before.first_submitted_at, null, '[1-前置] first_submitted_at 应为空');
    assert.strictEqual(before.status, '处理中', '[1-前置] 应处于处理中态');

    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits', directRelease: true }));
    assert.strictEqual(r.status, 200, `[1] submit direct_release=true 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '已上线', `[1] 响应 main_status 应为「已上线」，实得 ${r.body.main_status}`);
    assert.strictEqual(r.body.dev_status, 'code_submitted', `[1] 响应 dev_status 应为 code_submitted，实得 ${r.body.dev_status}`);
    assert.strictEqual(r.body.online_source, 'authorized_fastlane', `[1] 响应应携带 online_source='authorized_fastlane'，实得 ${JSON.stringify(r.body.online_source)}`);

    // 五字段原子落库
    const after = await issueRow(id);
    assert.strictEqual(after.status, '已上线', '[1] status 应落「已上线」');
    assert.ok(after.released_at, '[1] released_at 应已落库');
    assert.strictEqual(after.online_source, 'authorized_fastlane', '[1] online_source 应为 authorized_fastlane');
    assert.strictEqual(after.post_release_acceptance, 'pending', '[1] post_release_acceptance 应初值 pending');
    assert.ok(after.fast_release_consumed_at, '[1] fast_release_consumed_at 应已落库（直上即消费）');
    assert.strictEqual(after.post_accepted_at, null, '[1] post_accepted_at 应仍为空（SB3 才写）');
    assert.strictEqual(after.post_derive_issue_id, null, '[1] post_derive_issue_id 应仍为空（SB3 才写）');
    assert.strictEqual(after.release_id, null, '[1] release_id 应仍为空（快车道单从未进过批次）');
    assert.strictEqual(after.gate_deferred_at, null, '[1] gate_deferred_at 应为空（防御性清空）');

    // submit 通用副作用保留：first_submitted_at 首写 + commit 记录 + dev_status
    assert.ok(after.first_submitted_at, '[1] first_submitted_at 应已首写（submit 通用副作用未被直上路径吞掉）');
    assert.strictEqual(await commitCount(id), 1, '[1] commit 记录应已落库（commits 模式副作用保留）');
    const daRow = await devAssigneeRow(id, 5);
    assert.strictEqual(daRow.dev_status, 'code_submitted', '[1] dev_assignee.dev_status 应为 code_submitted');
    assert.ok(daRow.resolved_at, '[1] dev_assignee.resolved_at 应已落库');

    // timeline：恰新增两条以上（本条测试不断言总数，只断言含 fast_release_direct_online 且字段正确）
    const tl = await timelineRowsByCode(id, 'fast_release_direct_online');
    assert.strictEqual(tl.length, 1, `[1] action_code=fast_release_direct_online 的 timeline 行恰 1 条，实得 ${tl.length}`);
    assert.strictEqual(tl[0].event_type, 'status_change', '[1] timeline event_type 应为 status_change');
    assert.strictEqual(tl[0].from_status, '处理中', '[1] timeline from_status 应为「处理中」');
    assert.strictEqual(tl[0].to_status, '已上线', '[1] timeline to_status 应为「已上线」');
    assert.ok(tl[0].summary.includes('先行上线直上'), `[1] timeline summary 含"先行上线直上"，实得 ${tl[0].summary}`);
    assert.ok((await timelineCount(id)) > beforeTl, '[1] timeline 应有新增（至少含直上镜像行）');

    // 不变量①②③⑦对该行零违例
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(after), [], `[1] 直上后该行应无补验收字段组违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(after))}`);
    ok('[1] 直上正例（commits 模式）：已上线五字段原子落库 + timeline 一条 + submit 通用副作用保留（first_submitted_at/commit 记录/dev_status）+ 不变量零违例');
  }

  // ══════════════════════════ [1b] 直上正例（no_code 模式）══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '快车道-正例1b');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'no_code', directRelease: true }));
    assert.strictEqual(r.status, 200, `[1b] no_code 模式 direct_release=true 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const after = await issueRow(id);
    assert.strictEqual(after.status, '已上线', '[1b] status 应落「已上线」');
    assert.strictEqual(after.online_source, 'authorized_fastlane', '[1b] online_source 应为 authorized_fastlane');
    assert.strictEqual(await commitCount(id), 0, '[1b] no_code 模式不应产生 commit 行');
    const daRow = await devAssigneeRow(id, 5);
    assert.strictEqual(daRow.dev_status, 'no_code', '[1b] dev_assignee.dev_status 应为 no_code');
    ok('[1b] 直上正例（no_code 模式）：mode 与 direct_release 两个独立维度正交，no_code 同样可触发直上');
  }

  // ══════════════════════════ [2] 并发/重复消费防线 ══════════════════════════
  {
    // [2a] SQL 造态：已消费 + 处理中并存（理论不可达组合，同 verify-sys-fastrelease-auth [2-已上线-纵深] 范式，
    //   模拟"另一路径已抢先消费掉这份授权"的并发场景）——precondition 应独立拦下，零副作用。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '并发-a');
    await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime') WHERE id = ?`, [id]);
    const st = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(st.status, '处理中', '[2a-前置] 造态后 status 仍在处理中（授权窗口内）');
    const beforeTl = await timelineCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(r.status, 409, `[2a] 已消费叠加处理中态应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'FAST_RELEASE_SUBMIT_DIRECT_DENIED', `[2a] 确切码，实得 ${r.body.code}`);
    assert.ok(r.body.error.includes('已被消费'), `[2a] 精确原因文案含"已被消费"，实得="${r.body.error}"`);
    const after = await issueRow(id);
    assert.strictEqual(after.status, '处理中', '[2a] 零副作用：status 未变');
    assert.strictEqual(after.first_submitted_at, null, '[2a] 零副作用：first_submitted_at 仍为空（整个 submit 未落半点）');
    assert.strictEqual(await commitCount(id), 0, '[2a] 零副作用：无 commit 行');
    assert.strictEqual(await timelineCount(id), beforeTl, '[2a] 零副作用：timeline 无新增');
    const daAfter = await devAssigneeRow(id, 5);
    assert.strictEqual(daAfter.dev_status, 'pending', '[2a] 零副作用：dev_assignee.dev_status 仍 pending（submit 核心未执行）');
    ok('[2a] 并发纵深防御（SQL 造态·已消费叠加处理中态）：409 FAST_RELEASE_SUBMIT_DIRECT_DENIED + 整个 submit 回滚零残留');

    // [2b] 顺序双请求：真实链路第一次直上成功，紧接第二次同请求体再提交 → 409（状态已非「处理中」，
    //   family 检查先行拦下）+ 零二次消费（released_at/online_source/consumed_at 均不再变化）。
    const id2 = await bugAtChulizhong();
    await estimateFuture(id2);
    await authorize(id2, adminTok, '并发-b');
    const r1 = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(r1.status, 200, `[2b-前置] 首次直上应 200，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    const afterFirst = await issueRow(id2);
    const r2 = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(r2.status, 409, `[2b] 第二次直上应 409，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    const afterSecond = await issueRow(id2);
    assert.deepStrictEqual(afterSecond, afterFirst, '[2b] 第二次请求零副作用：issue 行五字段与首次成功后完全一致（未被二次消费/覆盖）');
    ok('[2b] 并发防线（顺序双请求）：第二次直上请求 409 + 零二次消费（issue 行与首次成功后逐字段一致）');
  }

  // ══════════════════════════ [3] 负例族 ══════════════════════════
  {
    // [3-无授权]
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
      assert.strictEqual(r.status, 409, `[3-无授权] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_SUBMIT_DIRECT_DENIED', `[3-无授权] 确切码，实得 ${r.body.code}`);
      assert.strictEqual(r.body.error, '当前未获得先行上线授权，无法直上', `[3-无授权] 精确原因文案，实得="${r.body.error}"`);
      const after = await issueRow(id);
      assert.strictEqual(after.status, '处理中', '[3-无授权] 零副作用：status 未变');
      assert.strictEqual(after.first_submitted_at, null, '[3-无授权] 零副作用：first_submitted_at 仍空');
      assert.strictEqual(await timelineCount(id), beforeTl, '[3-无授权] 零副作用：timeline 无新增');
      const da = await devAssigneeRow(id, 5);
      assert.strictEqual(da.dev_status, 'pending', '[3-无授权] 零副作用：dev_status 仍 pending');
      ok('[3-无授权] 从未先行上线授权：409 + "当前未获得先行上线授权，无法直上" + 整个 submit 零副作用');
    }
    // [3-已撤销]
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '负例-已撤销');
      const rev = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '负例-已撤销探针' });
      assert.strictEqual(rev.status, 200, `[3-已撤销-前置撤销] 应 200，实得 ${rev.status}`);
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
      assert.strictEqual(r.status, 409, `[3-已撤销] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_SUBMIT_DIRECT_DENIED', `[3-已撤销] 确切码，实得 ${r.body.code}`);
      assert.strictEqual(r.body.error, '先行上线授权已被撤销，无法直上', `[3-已撤销] 精确原因文案，实得="${r.body.error}"`);
      const after = await issueRow(id);
      assert.strictEqual(after.status, '处理中', '[3-已撤销] 零副作用：status 未变');
      assert.strictEqual(after.first_submitted_at, null, '[3-已撤销] 零副作用：first_submitted_at 仍空');
      assert.strictEqual(await timelineCount(id), beforeTl, '[3-已撤销] 零副作用：timeline 无新增（本次请求）');
      ok('[3-已撤销] 授权此前已撤销：409 + "先行上线授权已被撤销，无法直上" + 整个 submit 零副作用');
    }
    // [3-已消费]（SQL 造态：本阶段无真实"二次授权后消费"场景，直连 SQL 模拟）
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '负例-已消费');
      await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime') WHERE id = ?`, [id]);
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
      assert.strictEqual(r.status, 409, `[3-已消费] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error, '先行上线授权已被消费，无法直上', `[3-已消费] 精确原因文案，实得="${r.body.error}"`);
      assert.strictEqual(await timelineCount(id), beforeTl, '[3-已消费] 零副作用：timeline 无新增');
      ok('[3-已消费] 授权已被消费（SQL 造态）：409 + "先行上线授权已被消费，无法直上" + 整个 submit 零副作用');
    }
    // [3-已有上线标记]（SQL 造态：released_at/online_source 非空但 status 仍处理中，理论不可达组合）
    {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, '负例-已有上线标记');
      await run(`UPDATE sys_issues SET released_at = datetime('now','localtime'), online_source = 'no_commit_acceptance' WHERE id = ?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
      assert.strictEqual(r.status, 409, `[3-已有上线标记] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error, '该单已有上线标记，无法先行上线直上', `[3-已有上线标记] 精确原因文案，实得="${r.body.error}"`);
      ok('[3-已有上线标记] released_at/online_source 已非空（SQL 造态）：409 + "该单已有上线标记，无法先行上线直上"');
    }
    // [3-非bug类型]（feature 类型，处理中态等价的「开发中」态，direct_release=true）
    {
      const id = await mkIssue('feature');
      const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '一级' });
      assert.strictEqual(acc.status, 200, `[3-非bug-前置受理] 应 200，实得 ${acc.status} ${JSON.stringify(acc.body)}`);
      const oaR = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '1234567890' });
      assert.strictEqual(oaR.status, 200, `[3-非bug-前置OA] 应 200，实得 ${oaR.status} ${JSON.stringify(oaR.body)}`);
      const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(asg.status, 200, `[3-非bug-前置指派] 应 200，实得 ${asg.status} ${JSON.stringify(asg.body)}`);
      await estimateFuture(id, devTok, { estimated_effort_days: 2 });
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
        mode: 'commits', commits: [{ component: 'backend', commit_ref: 'svn-feature-negtest' }],
        self_tested: true, test_env_deployed: true, direct_release: true,
      });
      assert.strictEqual(r.status, 409, `[3-非bug类型] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_SUBMIT_DIRECT_DENIED', `[3-非bug类型] 确切码，实得 ${r.body.code}`);
      assert.strictEqual(r.body.error, '该单非 bug 类型，不支持先行上线直上（仅 bug 类可用）', `[3-非bug类型] 精确原因文案，实得="${r.body.error}"`);
      const after = await get('SELECT status, first_submitted_at FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(after.status, '开发中', '[3-非bug类型] 零副作用：status 未变（仍开发中，非 bug 单不应被 type 检查放过）');
      assert.strictEqual(after.first_submitted_at, null, '[3-非bug类型] 零副作用：first_submitted_at 仍空');
      assert.strictEqual(await timelineCount(id), beforeTl, '[3-非bug类型] 零副作用：timeline 无新增');
      ok('[3-非bug类型] feature 类型携带 direct_release=true：409 + "该单非 bug 类型，不支持先行上线直上" + 整个 submit 零副作用（B1 拍板仅 bug 类生效）');
    }
  }

  // ══════════════════════════ [3b] status≠处理中 分支：函数级直调证明（HTTP 层结构性不可达）══════════════════════════
  {
    // bug 的 DEV 族仅含「处理中」一个状态（status-families.js SYS_DEV_STATUSES.bug=['处理中']）——submit
    //   端点 §6.2 步骤2 的家族检查已在到达 direct_release 判定前，把任何非「处理中」态的 bug 提交拦成
    //   409 INVALID_STATUS。故 deriveFastReleaseSubmitDenyReason 的"状态非处理中"分支在 HTTP 层对 bug
    //   类型结构性不可达（index.js 注释原话："本条与①存在结构性重叠"）——本组只做函数级直调，
    //   不假装能从 HTTP 层触达，如实记录这条覆盖边界。
    const msg = I.deriveFastReleaseSubmitDenyReason({
      type: 'bug', status: '待处理', fast_release_auth_at: null, fast_release_revoked_at: null,
      fast_release_consumed_at: null, released_at: null, online_source: null,
    });
    assert.strictEqual(msg, '当前状态「待处理」不可先行上线直上（仅「处理中」可直上）', `[3b] 函数级直调应精确报出状态文案，实得="${msg}"`);
    ok('[3b] status≠处理中 分支函数级直调证明：deriveFastReleaseSubmitDenyReason 对非处理中态精确报文案（HTTP 层因 bug DEV 族单值化而结构性不可达，如实登记边界）');
  }

  // ══════════════════════════ [4] direct_release=false / 缺省：现行为零变化回归 ══════════════════════════
  {
    for (const [tag, extraBody] of [['缺省(未传字段)', {}], ['显式 false', { direct_release: false }]]) {
      const id = await bugAtChulizhong();
      await estimateFuture(id);
      await authorize(id, adminTok, `零变化回归-${tag}`);   // 挂着活跃未消费授权，验证不勾选就不消费
      const authSnapshot = await issueRow(id);
      const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: `svn-zero-${tag}-${Date.now()}` }], self_tested: true, test_env_deployed: true, bug_cause_note: '验证零变化', ...extraBody };
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, body);
      assert.strictEqual(r.status, 200, `[4-${tag}] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.main_status, '待验证', `[4-${tag}] 主状态应正常推进到「待验证」（单开发全完成态），实得 ${r.body.main_status}`);
      assert.strictEqual(r.body.online_source, undefined, `[4-${tag}] 响应不应携带 online_source 键，实得 ${JSON.stringify(r.body.online_source)}`);
      const after = await issueRow(id);
      assert.strictEqual(after.status, '待验证', `[4-${tag}] status 应为「待验证」（现行为不受影响）`);
      assert.strictEqual(after.online_source, null, `[4-${tag}] online_source 应仍为空（未勾选不消费授权）`);
      assert.strictEqual(after.post_release_acceptance, null, `[4-${tag}] post_release_acceptance 应仍为空`);
      assert.strictEqual(after.released_at, null, `[4-${tag}] released_at 应仍为空`);
      assert.strictEqual(after.fast_release_consumed_at, null, `[4-${tag}] fast_release_consumed_at 应仍为空（授权仍活跃未消费）`);
      assert.strictEqual(after.fast_release_auth_at, authSnapshot.fast_release_auth_at, `[4-${tag}] fast_release_auth_at 应保持不变`);
      ok(`[4-${tag}] direct_release ${tag}：现行为零变化——正常走待验证，活跃授权原样保留未被静默消费`);
    }
  }

  // ══════════════════════════ [5] 多开发场景三态（预筛 M1/M2·裁定=最后提交者勾选·零行为变更后订正）══════════════════════════
  //   三态覆盖同一条判据（roster 是否在"本次提交后"转为全完成）：
  //   [5-a] 非最后提交者勾选 direct_release → 409（roster 仍不完整）+ 本人这次提交整体回滚零副作用
  //   [5-b] 全员走普通提交（均不勾选）→ 正常推进「待验证」，"全完成"本身不隐式触发直上
  //   [5-c] 最后一位提交者勾选 direct_release → 一次成功直上（与单开发路径逐字同构，仅角色是"多人中的
  //         最后一人"）——现实现本就支持这条路径（roster 完成度门是"本次提交后是否转为全完成"，不是
  //         "提交前是否已全完成"），本组用真实两人夹具补齐这条此前只描述、未断言过的正例。
  {
    const id = await bugAtChulizhongTwoDevs();
    await estimateFuture(id);
    await authorize(id, adminTok, '多开发-未全完成');
    const beforeTl = await timelineCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(r.status, 409, `[5-a] dev6 未提交时 dev5 direct_release 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'FAST_RELEASE_SUBMIT_ROSTER_INCOMPLETE', `[5-a] 确切码，实得 ${r.body.code}`);
    assert.strictEqual(r.body.error, '其余成员尚未全部提交：请由最后完成的开发成员在其提交时勾选先行上线', `[5-a] 精确原因文案（[预筛 M1/M2] 订正后，不再暗示"等待后再补一次勾选"这一不可达路径），实得="${r.body.error}"`);
    const after = await issueRow(id);
    assert.strictEqual(after.status, '处理中', '[5-a] 零副作用：status 未变');
    assert.strictEqual(after.first_submitted_at, null, '[5-a] 零副作用：first_submitted_at 仍空（本人这次提交也整体回滚，不留半个 submit）');
    assert.strictEqual(await commitCount(id), 0, '[5-a] 零副作用：无 commit 行落库');
    assert.strictEqual(await timelineCount(id), beforeTl, '[5-a] 零副作用：timeline 无新增');
    const daDev5 = await devAssigneeRow(id, 5);
    assert.strictEqual(daDev5.dev_status, 'pending', '[5-a] 零副作用：dev5 的 dev_status 仍 pending（本人提交未生效）');
    ok('[5-a] 非最后提交者勾选 direct_release（dev6 仍 pending）：409 FAST_RELEASE_SUBMIT_ROSTER_INCOMPLETE + 精确文案（引导"最后完成者勾选"）+ 本人这次提交整体回滚零副作用');

    // [5-a] 的失败请求已整体回滚——dev5 的 dev_status 仍 pending（上方已断言）。故 roster 要转为全完成，
    //   dev5 与 dev6 都须各自成功提交一次：dev5 普通提交（不勾选直上）+ dev6 普通提交，验证"花名册全完成"
    //   本身不隐式触发直上（direct_release 需下一次显式提交携带才生效）。
    const r5n = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r5n.status, 200, `[5-b-前置a] dev5 普通提交应 200，实得 ${r5n.status} ${JSON.stringify(r5n.body)}`);
    assert.strictEqual(r5n.body.main_status, '处理中', `[5-b-前置a] dev5 提交后 dev6 仍 pending，主状态应维持「处理中」，实得 ${r5n.body.main_status}`);
    const r6 = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r6.status, 200, `[5-b-前置b] dev6 普通提交应 200，实得 ${r6.status} ${JSON.stringify(r6.body)}`);
    assert.strictEqual(r6.body.main_status, '待验证', `[5-b] dev5+dev6 均提交后花名册全完成，主状态应自然推进到「待验证」（正常 GATE 语义），实得 ${r6.body.main_status}`);
    ok('[5-b] 花名册转全完成后，未携带 direct_release 的普通提交仍走正常 GATE（推进待验证，不隐式直上）——证明"全完成"本身不是直上触发条件，必须显式勾选');
  }

  // ══════════════════════════ [5-c]（预筛 M1/M2 正例）最后提交者勾选 direct_release：一次成功直上 ══════════════════════════
  {
    const id = await bugAtChulizhongTwoDevs();
    await estimateFuture(id);
    await authorize(id, adminTok, '多开发-最后提交者勾选');
    // dev5 先普通提交（不勾选）——roster 仍差 dev6，主状态维持处理中，未触发任何 direct-release 判定。
    const r5n = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits' }));
    assert.strictEqual(r5n.status, 200, `[5-c-前置] dev5 普通提交应 200，实得 ${r5n.status} ${JSON.stringify(r5n.body)}`);
    assert.strictEqual(r5n.body.main_status, '处理中', `[5-c-前置] dev5 提交后 dev6 仍 pending，主状态应维持「处理中」，实得 ${r5n.body.main_status}`);
    // dev6 作为最后一位提交者，勾选 direct_release=true——本次提交把 dev6 自身的 dev_status 从 pending
    //   转为 code_submitted，roster 随之在**同一请求内**转为全完成，闸门放行，一次性直上成功。
    const r6 = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, submitBody({ mode: 'commits', directRelease: true }));
    assert.strictEqual(r6.status, 200, `[5-c] dev6 作为最后提交者勾选 direct_release 应一次成功，实得 ${r6.status} ${JSON.stringify(r6.body)}`);
    assert.strictEqual(r6.body.main_status, '已上线', `[5-c] 响应 main_status 应为「已上线」，实得 ${r6.body.main_status}`);
    assert.strictEqual(r6.body.online_source, 'authorized_fastlane', `[5-c] 响应应携带 online_source='authorized_fastlane'，实得 ${JSON.stringify(r6.body.online_source)}`);

    const after = await issueRow(id);
    assert.strictEqual(after.status, '已上线', '[5-c] status 应落「已上线」');
    assert.ok(after.released_at, '[5-c] released_at 应已落库');
    assert.strictEqual(after.online_source, 'authorized_fastlane', '[5-c] online_source 应为 authorized_fastlane');
    assert.strictEqual(after.post_release_acceptance, 'pending', '[5-c] post_release_acceptance 应初值 pending');
    assert.ok(after.fast_release_consumed_at, '[5-c] fast_release_consumed_at 应已落库（直上即消费）');
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(after), [], `[5-c] 直上后该行应无补验收字段组违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(after))}`);

    const daDev5After = await devAssigneeRow(id, 5);
    const daDev6After = await devAssigneeRow(id, 6);
    assert.strictEqual(daDev5After.dev_status, 'code_submitted', '[5-c] dev5（先提交者）dev_status 应为 code_submitted（未受 dev6 的直上影响）');
    assert.strictEqual(daDev6After.dev_status, 'code_submitted', '[5-c] dev6（最后提交者·勾选直上）dev_status 应为 code_submitted');

    const tl = await timelineRowsByCode(id, 'fast_release_direct_online');
    assert.strictEqual(tl.length, 1, `[5-c] action_code=fast_release_direct_online 的 timeline 行恰 1 条，实得 ${tl.length}`);
    assert.strictEqual(tl[0].from_status, '处理中', '[5-c] timeline from_status 应为「处理中」');
    assert.strictEqual(tl[0].to_status, '已上线', '[5-c] timeline to_status 应为「已上线」');
    ok('[5-c] 多开发场景·最后提交者勾选 direct_release：一次请求内自身 CAS 完成花名册 → 闸门放行 → 直上成功（五字段原子落库 + timeline 一条），证明"最后提交者勾选"路径现实现已天然支持，非需另行改造');
  }

  // ══════════════════════════ [6] 不变量①②③⑦探针（[Y5] 范式）══════════════════════════
  {
    assert.strictEqual(typeof I.fastlaneAcceptanceInvariantViolations, 'function', '[6-前置] fastlaneAcceptanceInvariantViolations 应已导出');

    // [6a] JS 纯函数用例表——3 正例 + 9 反例（[预筛 L1] status 并入入参契约，③支新增状态绑定反例）
    const V_PENDING = { online_source: 'authorized_fastlane', post_release_acceptance: 'pending', post_accepted_at: null, post_derive_issue_id: null, released_at: '2026-08-13 10:00:00', release_id: null, fast_release_consumed_at: '2026-08-13 10:00:00', status: '已上线' };
    const V_PASSED = { ...V_PENDING, post_release_acceptance: 'passed', post_accepted_at: '2026-08-14 09:00:00' };
    const V_FAILED_DERIVED = { ...V_PENDING, post_release_acceptance: 'failed_derived', post_derive_issue_id: 999 };
    for (const [tag, row] of [['pending', V_PENDING], ['passed', V_PASSED], ['failed_derived', V_FAILED_DERIVED]]) {
      assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(row), [], `[6a-正例-${tag}] 应无违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(row))}`);
    }
    // 非 fastlane 全空行也应合法（未直上的普通行，status 任意——③支判定不适用非 fastlane 行）
    const V_NON_FASTLANE = { online_source: null, post_release_acceptance: null, post_accepted_at: null, post_derive_issue_id: null, released_at: null, release_id: null, fast_release_consumed_at: null, status: '处理中' };
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(V_NON_FASTLANE), [], '[6a-正例-非fastlane] 全空行应无违例');
    ok('[6a-正例] fastlaneAcceptanceInvariantViolations 4 正例（pending/passed/failed_derived/非fastlane全空）全放行');

    const badCases = [
      ['①-fastlane但acceptance空', { ...V_PENDING, post_release_acceptance: null }],
      ['①-acceptance非空但非fastlane', { ...V_PENDING, online_source: null }],
      ['②-值域外字符串', { ...V_PENDING, post_release_acceptance: 'bogus_value' }],
      ['②-pending但accepted_at非空', { ...V_PENDING, post_accepted_at: '2026-08-14 09:00:00' }],
      ['②-pending但derive_id非空', { ...V_PENDING, post_derive_issue_id: 999 }],
      ['②-passed但accepted_at为空', { ...V_PASSED, post_accepted_at: null }],
      ['②-failed_derived但derive_id为空', { ...V_FAILED_DERIVED, post_derive_issue_id: null }],
      ['③-fastlane但released_at为空', { ...V_PENDING, released_at: null }],
      ['③-fastlane但release_id非空', { ...V_PENDING, release_id: 42 }],
      ['③-fastlane但status非已上线', { ...V_PENDING, status: '处理中' }],
      ['⑦-fastlane但consumed_at为空', { ...V_PENDING, fast_release_consumed_at: null }],
    ];
    for (const [tag, row] of badCases) {
      const v = I.fastlaneAcceptanceInvariantViolations(row);
      assert.ok(v.length > 0, `[6a-反例-${tag}] 应判红，实得 ${JSON.stringify(v)}`);
    }
    ok(`[6a-反例] fastlaneAcceptanceInvariantViolations ${badCases.length} 反例（①双向+②值域与四绑定+③三条[含L1新增状态绑定]+⑦一条）全判红`);

    // [6b] 候选行 SQL 粗筛 → I.fastlaneAcceptanceInvariantViolations 精判（同 fastReleaseGroupInvariantViolations
    //   [8b] 范式：SQL 只做候选粗筛，真正判断转交 JS 判据，两处不各写一份漂移的等价逻辑）
    // [预筛 L1] SELECT 补 status 列——③支新增状态绑定检查读它；漏投影会让每一行的 row.status 恒为
    //   undefined，`undefined !== '已上线'` 恒真，把所有 fastlane 候选行误判成状态违例（假阳性）。
    const FL_CANDIDATE_SQL = `SELECT id, online_source, post_release_acceptance, post_accepted_at, post_derive_issue_id,
              released_at, release_id, fast_release_consumed_at, status
         FROM sys_issues
        WHERE online_source IS NOT NULL OR post_release_acceptance IS NOT NULL
           OR post_accepted_at IS NOT NULL OR post_derive_issue_id IS NOT NULL`;
    const fastlaneViolationCount = async (allFn) => {
      const rows = await allFn(FL_CANDIDATE_SQL);
      let total = 0;
      for (const row of rows) total += I.fastlaneAcceptanceInvariantViolations(row).length;
      return total;
    };

    // 对照组①：fastlane 但 post_release_acceptance 为空（status 一并设已上线，隔离出①单一违例源）
    const inj1 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source = 'authorized_fastlane', status = '已上线' WHERE id = ?`, [inj1]);
    let cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[6b-①] ★对照组：online_source=authorized_fastlane 但 acceptance 空应判红，实得 ${cnt}`);
    ok(`[6b-①] ★对照组：①注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source = NULL WHERE id = ?`, [inj1]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-①] 清理注入行后应恢复 0');

    // 对照组②：pending 但 post_accepted_at 非空（status 一并设已上线，隔离出②单一违例源）
    const inj2 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', post_accepted_at='2026-08-14 09:00:00', released_at='2026-08-13 10:00:00', fast_release_consumed_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj2]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[6b-②] ★对照组：pending 但 accepted_at 非空应判红，实得 ${cnt}`);
    ok(`[6b-②] ★对照组：②注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, post_accepted_at=NULL, released_at=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj2]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-②] 清理注入行后应恢复 0');

    // 对照组③：fastlane 但 release_id 非空（status 一并设已上线，隔离出③-release_id 单一违例源）
    const inj3 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', release_id=42, fast_release_consumed_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj3]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[6b-③] ★对照组：fastlane 但 release_id 非空应判红，实得 ${cnt}`);
    ok(`[6b-③] ★对照组：③注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL, release_id=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj3]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-③] 清理注入行后应恢复 0');

    // 对照组③b（[预筛 L1] 新增）：fastlane 且其余字段合法，唯独 status 停在「处理中」（未真正推进到已上线）——
    //   coordinator 指定形态：online_source=authorized_fastlane ∧ status='处理中' → 应判红。
    const inj3b = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', fast_release_consumed_at='2026-08-13 10:00:00', status='处理中' WHERE id = ?`, [inj3b]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[6b-③b] ★对照组：fastlane 但 status='处理中'（非已上线）应判红，实得 ${cnt}`);
    ok(`[6b-③b] ★对照组：③状态绑定注入（online_source=authorized_fastlane ∧ status='处理中'）后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inj3b]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-③b] 清理注入行后应恢复 0');

    // 对照组⑦：fastlane 但 fast_release_consumed_at 为空（status 一并设已上线，隔离出⑦单一违例源）
    const inj4 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='pending', released_at='2026-08-13 10:00:00', status='已上线' WHERE id = ?`, [inj4]);
    cnt = await fastlaneViolationCount(all);
    assert.ok(cnt > 0, `[6b-⑦] ★对照组：fastlane 但 consumed_at 为空应判红，实得 ${cnt}`);
    ok(`[6b-⑦] ★对照组：⑦注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL, released_at=NULL WHERE id = ?`, [inj4]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-⑦] 清理注入行后应恢复 0');

    // [6b-空串] 空串反例：post_release_acceptance='' 时应视同"空"（①判据用三条件排空串同 fastReleaseGroupInvariantViolations 范式）——
    //   注意：本探针的 acceptancePresent 判据把空串当"缺席"，故 online_source=authorized_fastlane 且 acceptance=''
    //   应命中①"fastlane但acceptance空"这一支（而非误判成②值域外字符串）。
    const inj5 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET online_source='authorized_fastlane', post_release_acceptance='' WHERE id = ?`, [inj5]);
    const rowInj5 = await get(`SELECT online_source, post_release_acceptance, post_accepted_at, post_derive_issue_id, released_at, release_id, fast_release_consumed_at, status FROM sys_issues WHERE id=?`, [inj5]);
    const v5 = I.fastlaneAcceptanceInvariantViolations(rowInj5);
    assert.ok(v5.length > 0 && v5.some(m => m.includes('post_release_acceptance 为空')), `[6b-空串] 空串应判红且落①分支，实得 ${JSON.stringify(v5)}`);
    ok(`[6b-空串] ★对照组：post_release_acceptance='' 视同空（①分支判红），实得 ${JSON.stringify(v5)}`);
    await run(`UPDATE sys_issues SET online_source=NULL, post_release_acceptance=NULL WHERE id = ?`, [inj5]);
    assert.strictEqual(await fastlaneViolationCount(all), 0, '[6b-空串] 清理注入行后应恢复 0');

    // [6c] 真实本地库（task_pool.db）——独立只读连接，用完即关；同一套候选行 SQL 粗筛 + I.fastlaneAcceptanceInvariantViolations 精判
    const realDbPath = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath)) {
      const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      const realCols = await new Promise((resolve, reject) => realDb.all(`PRAGMA table_info(sys_issues)`, (e, r) => e ? reject(e) : resolve(r)));
      const realColNames = realCols.map(c => c.name);
      const needCols = ['online_source', 'post_release_acceptance', 'post_accepted_at', 'post_derive_issue_id', 'released_at', 'release_id', 'fast_release_consumed_at', 'status'];
      if (needCols.every(c => realColNames.includes(c))) {
        const rows = await realAll(FL_CANDIDATE_SQL);
        let total = 0;
        for (const row of rows) total += I.fastlaneAcceptanceInvariantViolations(row).length;
        assert.strictEqual(total, 0, `[6c] 真实本地库补验收字段组违例计数应为 0，实得 ${total}（候选行 ${rows.length} 条）`);
        ok(`[6c] ⭐⭐ 真实本地库（task_pool.db）先行上线补验收字段组探针：${needCols.length} 列全在 + 候选行 ${rows.length} 条，违例计数=0（判据=I.fastlaneAcceptanceInvariantViolations）`);
      } else {
        ok('[6c] 真实本地库缺补验收三列（部署未跑到本次 ALTER）——环境相关跳过，非探针本身问题');
      }
      realDb.close();
    } else {
      ok('[6c] 真实本地库 task_pool.db 不存在——环境相关跳过（CI/新环境无本地库属正常）');
    }
  }

  // ══════════════════════════ [7] online_source 消费面 ══════════════════════════
  {
    // [7a] deriveOnlineSourceKind 直调四分支穷举
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: 10, online_source: null }), 'release_publish', '[7a] release_id 非空应判 release_publish');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'no_commit_acceptance' }), 'no_commit_acceptance', '[7a] no_commit_acceptance 应判 no_commit_acceptance');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'authorized_fastlane' }), 'authorized_fastlane', '[7a] authorized_fastlane 应判 authorized_fastlane（SB2 新分支）');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: null }), 'unknown_legacy', '[7a] 三者皆无应判 unknown_legacy');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '已上线', release_id: null, online_source: 'some_future_kind' }), 'unknown_legacy', '[7a] 未识别的非空值不应被误判为已知分支（严格等值判据）');
    assert.strictEqual(I.deriveOnlineSourceKind({ status: '处理中', release_id: null, online_source: 'authorized_fastlane' }), null, '[7a] status 非「已上线」时恒返回 null（未上线不该有来源）');
    ok('[7a] deriveOnlineSourceKind 直调：四分支穷举（release_publish/no_commit_acceptance/authorized_fastlane/unknown_legacy）+ 非已上线态恒 null + 未识别值严格判 unknown_legacy');

    // [7b] 详情端点：真实直上后 GET 详情，issue.online_source_kind 应为 authorized_fastlane
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, '消费面-详情');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(subR.status, 200, `[7b-前置] 直上应 200，实得 ${subR.status}`);
    const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail.status, 200, `[7b] 详情应 200，实得 ${detail.status}`);
    assert.strictEqual(detail.body.issue.online_source_kind, 'authorized_fastlane', `[7b] 详情端点 issue.online_source_kind 应为 authorized_fastlane，实得 ${detail.body.issue.online_source_kind}`);
    assert.strictEqual(detail.body.issue.status, '已上线', '[7b] 详情端点 issue.status 应为「已上线」');
    ok('[7b] 详情端点消费面：真实直上后 GET 详情 issue.online_source_kind 正确投影为 authorized_fastlane');

    // [7c] 列表端点：同一单据的列表行 online_source_kind 应为 authorized_fastlane
    const listR = await call('GET', '/api/sys-issues?page_size=500', adminTok);
    assert.strictEqual(listR.status, 200, `[7c] 列表应 200，实得 ${listR.status}`);
    const row = (listR.body.items || []).find(x => x.id === id);
    assert.ok(row, `[7c] 列表应含刚直上的单据 id=${id}`);
    assert.strictEqual(row.online_source_kind, 'authorized_fastlane', `[7c] 列表端点该行 online_source_kind 应为 authorized_fastlane，实得 ${row.online_source_kind}`);
    ok('[7c] 列表端点消费面：GET /sys-issues 该行 online_source_kind 正确投影为 authorized_fastlane（与详情端点同一判据 deriveOnlineSourceKind，读点不分裂）');

    // [7d] 前端字典覆盖——静态源码扫描（不起浏览器，纯文本断言，防"后端加了分支前端字典忘同步"）
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    assert.ok(/SI_ONLINE_SOURCE_LABEL\s*=\s*\{[^}]*authorized_fastlane\s*:\s*'先行上线'/.test(htmlSrc),
      '[7d] Sys_Iteration.html 的 SI_ONLINE_SOURCE_LABEL 应含 authorized_fastlane: \'先行上线\' 词条');
    assert.ok(/SI_TL_LABEL\s*=\s*\{[\s\S]*?fast_release_direct_online\s*:\s*'先行上线直上'/.test(htmlSrc),
      '[7d] Sys_Iteration.html 的 SI_TL_LABEL 应含 fast_release_direct_online: \'先行上线直上\' 词条');
    // 与 hotfix 文案区分：grep 全文，"先行上线"/"直上" 与 hotfix 相关文案（应急建单/应急一键）不应出现在同一行
    const hotfixLines = htmlSrc.split('\n').filter(l => /应急建单|应急一键|hotfix-publish/.test(l));
    const overlapLines = hotfixLines.filter(l => /先行上线|直上/.test(l));
    assert.strictEqual(overlapLines.length, 0, `[7d] hotfix 相关文案行不应与"先行上线/直上"措辞出现在同一行，实得重叠 ${overlapLines.length} 行：${JSON.stringify(overlapLines)}`);
    ok('[7d] 前端字典静态覆盖：SI_ONLINE_SOURCE_LABEL/SI_TL_LABEL 均已登记 authorized_fastlane/fast_release_direct_online 词条 + 与 hotfix 文案（应急建单/应急一键）grep 全文无重叠行');

    // [7e] efficiency-stats.js：设计上按 released_at 合并统计、不按 online_source 分流（代码读确认，非运行时用例——
    //   该模块无独立可调用入口按 issue 粒度出结果，verify 层面用静态断言钉住"不新增按 online_source 分支"这条
    //   设计承诺）。[预筛 LOW-3] 该文件的说明性注释现已提及 authorized_fastlane 字面量（登记"三条明示入口"
    //   事实，见 :388 一带），故断言从"全文不得出现该字符串"改为"不得出现在真实代码分支判据里"——只挡
    //   `=== 'authorized_fastlane'` / `== 'authorized_fastlane'` 这类比较运算符紧邻的形态（真正的分支判据），
    //   放行纯注释提及（文档性描述不构成"按来源分流"）。
    const effSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'efficiency-stats.js'), 'utf8');
    assert.ok(!/[=!]==?\s*['"]authorized_fastlane['"]/.test(effSrc), '[7e] efficiency-stats.js 不应出现按 authorized_fastlane 分支判据的代码（有意合并统计，不按来源分流，同既有 no_commit_acceptance 设计一致；注释提及不算违反）');
    ok('[7e] efficiency-stats.js 豁免确认：不消费 online_source（按 released_at 统一合并统计，authorized_fastlane 自动纳入不需改代码，静态断言钉住此设计承诺不被误改）');
  }

  // ══════════════════════════ [8] assertMainStatusTransition FAST_RELEASE_DIRECT routeKind 单元覆盖 ══════════════════════════
  {
    const guardPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'status-transition-guard.js');
    const { assertMainStatusTransition, MainStatusGuardError } = require(guardPath);

    // 合法边放行
    const ok1 = assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_DIRECT', action: 'submit', actionKind: null, issueType: 'bug',
      before: '处理中', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    });
    assert.deepStrictEqual(ok1, { ok: true, afterFamily: 'RELEASE' }, '[8a] 合法边（处理中→已上线，roster 满足）应放行，afterFamily=RELEASE');
    ok('[8a] FAST_RELEASE_DIRECT 合法边（处理中→已上线，roster 在册1/全完成）放行，afterFamily=RELEASE');

    // action≠'submit' 拒
    assert.throws(() => assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_DIRECT', action: 'accept', actionKind: null, issueType: 'bug',
      before: '处理中', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    }), MainStatusGuardError, '[8b] action≠submit 应抛 MainStatusGuardError');
    ok('[8b] FAST_RELEASE_DIRECT action≠\'submit\' 拒绝（fail-closed，本入口只服务一条边）');

    // 边非法（before≠DEV 态）拒
    assert.throws(() => assertMainStatusTransition({
      routeKind: 'FAST_RELEASE_DIRECT', action: 'submit', actionKind: null, issueType: 'bug',
      before: '待验证', after: '已上线', rosterActiveCount: 1, rosterAllComplete: true,
    }), MainStatusGuardError, '[8c] before=待验证 应拒（非 DEV 态起点）');
    ok('[8c] FAST_RELEASE_DIRECT 边非法（before=待验证而非 DEV 态）拒绝');

    // roster 门：allComplete=false 拒（400 语义，同 GATE/RELEASE/NO_COMMIT_ONLINE 三条既有入口）
    let rosterErr = null;
    try {
      assertMainStatusTransition({
        routeKind: 'FAST_RELEASE_DIRECT', action: 'submit', actionKind: null, issueType: 'bug',
        before: '处理中', after: '已上线', rosterActiveCount: 2, rosterAllComplete: false,
      });
    } catch (e) { rosterErr = e; }
    assert.ok(rosterErr instanceof MainStatusGuardError, '[8d] roster 未全完成应抛 MainStatusGuardError');
    assert.strictEqual(rosterErr.httpStatus, 400, `[8d] roster 门失败应为 400 语义，实得 ${rosterErr.httpStatus}`);
    ok('[8d] FAST_RELEASE_DIRECT 进 RELEASE 族 roster 门：rosterAllComplete=false 拒（400，与 GATE/RELEASE/NO_COMMIT_ONLINE 三条既有入口同款"已上线态不应存在未完成开发"不变量）');
  }

  // ══════════════════════════ [9]（预筛 HIGH-1）reopen 清补验收字段组：真实链路正向用例 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, 'HIGH-1 真实链路');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(subR.status, 200, `[9-前置直上] 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    const afterDirect = await issueRow(id);
    assert.strictEqual(afterDirect.online_source, 'authorized_fastlane', '[9-前置直上] online_source 应已落 authorized_fastlane');
    assert.strictEqual(afterDirect.post_release_acceptance, 'pending', '[9-前置直上] post_release_acceptance 应已落 pending');
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(afterDirect), [], '[9-前置直上] 直上刚落库时应无违例');

    // [组 B·SB3·不变量⑥] pending 态禁止 close——先证 gate 生效，再走补验收 pass 收口后 close 才应放行
    //   （SB3 之前本用例直接 close，SB3 起 pending 单必须先经补验收，见下方新增两步）。
    const closeBlocked = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeBlocked.status, 409, `[9-close-被拦] pending 态 close 应 409，实得 ${closeBlocked.status} ${JSON.stringify(closeBlocked.body)}`);
    assert.strictEqual(closeBlocked.body.code, 'POST_ACCEPTANCE_PENDING', `[9-close-被拦] 确切码，实得 ${closeBlocked.body.code}`);
    const praR = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(praR.status, 200, `[9-补验收] pass 应 200，实得 ${praR.status} ${JSON.stringify(praR.body)}`);

    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[9-close] 补验收通过后 close 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: 'HIGH-1 验证重开清补验收字段组' });
    assert.strictEqual(reopenR.status, 200, `[9-reopen] 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);

    const afterReopen = await issueRow(id);
    assert.strictEqual(afterReopen.status, '处理中', '[9-reopen 后] status 应回到「处理中」');
    assert.strictEqual(afterReopen.online_source, null, '[9-reopen 后] online_source 应已清空（既有 C9-fix2 M2 行为，未受本次改动影响）');
    assert.strictEqual(afterReopen.post_release_acceptance, null, '[9-reopen 后] ⭐ post_release_acceptance 应已清空（HIGH-1 新增清空点，SB3 起该行会先经 passed 中间态，reopen 仍应清空）');
    assert.strictEqual(afterReopen.post_accepted_at, null, '[9-reopen 后] ⭐ post_accepted_at 应已清空（HIGH-1 新增清空点，SB3 起该列会先被 post-release-accept 写入，reopen 仍应清空）');
    assert.strictEqual(afterReopen.post_derive_issue_id, null, '[9-reopen 后] ⭐ post_derive_issue_id 应已清空（HIGH-1 新增清空点）');
    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(afterReopen), [], `[9-reopen 后] ⭐ fastlaneAcceptanceInvariantViolations 应零违例（真实链路，非构造行），实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(afterReopen))}`);
    ok('[9] HIGH-1 真实链路正向用例（SB3 更新）：直上（online_source=authorized_fastlane/post_release_acceptance=pending）→ close 被不变量⑥拦下 409 → 补验收 pass → close 放行 → reopen → 三列全清空（含 post_accepted_at 这个 SB3 新增写点）+ fastlaneAcceptanceInvariantViolations 零违例（非构造行，走真实端点链）');
  }

  // ══════════════════════════ [10]（预筛 MED-1）last_completed_at 直上分支：列表 + 详情两面 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, 'MED-1 last_completed_at');
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ directRelease: true }));
    assert.strictEqual(subR.status, 200, `[10-前置] 直上应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    const tlRow = await get(`SELECT created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='fast_release_direct_online'`, [id]);
    assert.ok(tlRow && tlRow.created_at, '[10-前置] 直上应已落一条 fast_release_direct_online timeline 行');

    const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail.status, 200, `[10-详情] 应 200，实得 ${detail.status}`);
    assert.ok(detail.body.issue.last_completed_at, `[10-详情] ⭐ issue.last_completed_at 应非空（直上时刻），实得 ${detail.body.issue.last_completed_at}`);
    assert.strictEqual(detail.body.issue.last_completed_at, tlRow.created_at, `[10-详情] last_completed_at 应等于 fast_release_direct_online 行的 created_at，实得 ${detail.body.issue.last_completed_at} vs ${tlRow.created_at}`);

    const listR = await call('GET', '/api/sys-issues?page_size=500', adminTok);
    assert.strictEqual(listR.status, 200, `[10-列表] 应 200，实得 ${listR.status}`);
    const row = (listR.body.items || []).find(x => x.id === id);
    assert.ok(row, `[10-列表] 应含该单据 id=${id}`);
    assert.ok(row.last_completed_at, `[10-列表] ⭐ 该行 last_completed_at 应非空（直上时刻），实得 ${row.last_completed_at}`);
    assert.strictEqual(row.last_completed_at, tlRow.created_at, `[10-列表] last_completed_at 应等于 fast_release_direct_online 行的 created_at，实得 ${row.last_completed_at} vs ${tlRow.created_at}`);
    ok('[10] MED-1 last_completed_at 直上分支：列表 + 详情两面均正确取到直上时刻（=fast_release_direct_online timeline 行 created_at），两处子查询同源一致');
  }

  // ══════════════════════════ [11]（预筛 MED-2·P7 过渡收紧，2026-08-13 组 B·B1 授权终结事件制落地后
  //   改写为 SQL 造态纵深防御测试）授权须晚于最近一次 reopen：成对用例 ══════════════════════════
  //   ⚠️ 背景推翻：B1 之前，"accept 免上线直翻到已上线"这条边不消费/不终结授权，六列会一路带着活跃标记
  //   漂到 close→reopen，形成真实可达的"悬垂授权跨轮"场景——本组当时靠真实链路（无 SQL 造态）构造它。
  //   B1 落地后，accept 的 C9 直翻分支命中事件①「上线翻牌」，会在同一事务终结掉这份从未消费的活跃
  //   授权（六列清空，见 verify-sys-fastrelease-auth.js [9] 已改写为覆盖这条新行为）——"授权明确早于
  //   reopen 且仍挂着"这个组合，经真实状态机路径已**结构性不可达**（reopen 的唯一合法前置态「已关闭」
  //   必先经过 close，而到达「已上线」的非豁免路径都已被 B1 三事件之一终结）。isActiveFastReleaseAuth
  //   第六个条件（授权须不早于最近一次 reopen）因此从"第一道防线"降级为"纵深防御"（P7 终裁原文，见
  //   index.js FAST_RELEASE_ACTIVE_AUTH_WHERE_SQL 定义处注释），本组同步改用 SQL 造态直接验证这条纵深
  //   防线仍然生效——不再依赖真实链路自然产出该组合，也不再需要真实跨秒等待（原 1100ms sleep 随之删除）。
  {
    // [11a] 负例：SQL 造态构造"reopen 之后仍挂着一份 auth_at 早于 reopened_at 的授权"（正常状态机已
    //   不会产出，此处是主动伪造，专测 WHERE 层纵深防御）→ 勾选直上应仍 409，精确文案。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, adminTok, 'B1 纵深防御负例：授权早于reopen（造态）');
    // 走 no-commit 免上线直翻到达已上线——[B1 新行为] 本次 accept 会同事务终结掉刚授权的六列
    //   （事件①「上线翻牌」命中，见 verify-sys-fastrelease-auth.js [9]），故此处不再断言"悬垂授权得以
    //   保留"（那是 B1 之前的旧行为），只断言直翻本身成功。
    const noCodeR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'no_code' }));
    assert.strictEqual(noCodeR.status, 200, `[11a-前置提交] 应 200，实得 ${noCodeR.status} ${JSON.stringify(noCodeR.body)}`);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[11a-前置验收] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.online_source, 'no_commit_acceptance', '[11a-前置验收] 应走免上线直翻');
    const rowAfterAcceptTermination = await issueRow(id);
    assert.strictEqual(rowAfterAcceptTermination.fast_release_auth_at, null, '[11a-前置] ⭐ [B1 新行为] accept 直翻已上线已同事务终结活跃授权，fast_release_auth_at 应为 NULL（非 B1 之前"悬垂保留"的旧行为）');
    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[11a-前置关闭] 应 200，实得 ${closeR.status}`);
    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: 'MED-2 负例验证（B1 后六列已空，reopen 无事可清）' });
    assert.strictEqual(reopenR.status, 200, `[11a-前置重开] 应 200，实得 ${reopenR.status}`);
    // [B1 后·SQL 造态] 六列此刻已因 accept 终结而全空——用直连 SQL 伪造一份"auth_at 早于 reopened_at"
    //   的授权，专测 isActiveFastReleaseAuth 第六条件（纵深防御）在这个理论组合下仍正确拒绝。
    //   auth_at 用 `datetime(reopened_at, '-1 hour')` 显式早于 reopened_at 一小时，不依赖真实时钟推移。
    await run(
      `UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
              fast_release_auth_at = datetime(reopened_at, '-1 hour')
         WHERE id = ?`, [id]);
    const rowAfterInject = await issueRow(id);
    assert.ok(rowAfterInject.fast_release_auth_at, '[11a-造态] SQL 注入的 fast_release_auth_at 应已落库');
    // ⚠️ first_submitted_at 是"永不变"字段（reopen 明确不清它，方案 §3.5 既有不变量）——本单在 reopen
    //   前已首次提交过，此刻已非空，本组"零副作用"改用**快照比对**而非"仍为空"（那是对新单首轮的判据，
    //   不适用本单这个已重开过的场景，同 fastReleaseGroupInvariantViolations 组"不能假设初始态"的教训）。
    const firstSubmittedBefore = rowAfterInject.first_submitted_at;
    await estimateFuture(id);   // 新一轮需重新回填 ETA（reopen 已清 dev_estimated_at）
    const daBefore = await devAssigneeRow(id, 5);
    assert.strictEqual(daBefore.dev_status, 'pending', '[11a-前置] reopen 后新一轮 dev_assignee 实例应是全新 pending（reopen 隐式重建花名册实例）');
    const beforeTl = await timelineCount(id);
    const dirR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits', directRelease: true }));
    assert.strictEqual(dirR.status, 409, `[11a] 造态授权早于 reopen（纵深防御）应 409，实得 ${dirR.status} ${JSON.stringify(dirR.body)}`);
    assert.strictEqual(dirR.body.code, 'FAST_RELEASE_SUBMIT_DIRECT_DENIED', `[11a] 确切码，实得 ${dirR.body.code}`);
    assert.strictEqual(dirR.body.error, '授权属重开前的上一轮，需重新授权', `[11a] 精确原因文案，实得="${dirR.body.error}"`);
    const rowAfterDenied = await issueRow(id);
    assert.strictEqual(rowAfterDenied.status, '处理中', '[11a] 零副作用：status 未变');
    assert.strictEqual(rowAfterDenied.first_submitted_at, firstSubmittedBefore, '[11a] 零副作用：first_submitted_at 与请求前快照一致（"永不变"字段，本组零副作用改用快照比对而非"仍为空"）');
    const daAfter = await devAssigneeRow(id, 5);
    assert.strictEqual(daAfter.dev_status, 'pending', '[11a] 零副作用：新一轮 dev_assignee 实例的 dev_status 仍 pending（本次提交未生效）');
    assert.strictEqual(await timelineCount(id), beforeTl, '[11a] 零副作用：timeline 无新增');
    ok('[11a·B1 后改 SQL 造态] 纵深防御负例：授权早于最近一次 reopen（造态构造，正常状态机已不可达）→ 409 FAST_RELEASE_SUBMIT_DIRECT_DENIED + "授权属重开前的上一轮，需重新授权" + 整个 submit 零副作用（isActiveFastReleaseAuth 第六条件在 B1 后仍作纵深防御生效）');

    // [11b] 对照组：reopen 之后重新授权（auth_at 晚于 reopened_at）→ 正常消费成功。
    const authAfterReopen = await authorize(id, adminTok, 'MED-2 对照：reopen 后重新授权');
    assert.strictEqual(authAfterReopen.reauthorized, true, '[11b-前置] 应是重新授权（现值 auth_at 非空——[11a] 末尾 SQL 造态注入的那份，B2b 覆盖三件套）');
    const dirR2 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody({ mode: 'commits', directRelease: true }));
    assert.strictEqual(dirR2.status, 200, `[11b] reopen 后重新授权应能正常消费直上，实得 ${dirR2.status} ${JSON.stringify(dirR2.body)}`);
    assert.strictEqual(dirR2.body.online_source, 'authorized_fastlane', '[11b] 直上应成功落库 authorized_fastlane');
    ok('[11b·B1 后] 对照组：reopen 之后重新授权（auth_at 晚于 reopened_at）→ 直上正常消费成功（证明纵深防御只挡"跨轮悬垂"，不误伤"reopen 后已补授权"这条合法路径）');
  }

  // ══════════════════════════ [12]（预筛 M3）isActiveFastReleaseAuth 唯一判据 fail-closed：缺列入参抛错 ══════════════════════════
  {
    // [12a] 缺 reopened_at（coordinator 指名场景）——正例六列全给、唯独漏 reopened_at 一列，其余五列均
    //   构成"活跃授权"（正常判断会返回 true），验证漏投影不会静默判过，而是响亮抛错。
    const rowMissingReopenedAt = {
      fast_release_auth_at: '2026-08-13 10:00:00', fast_release_revoked_at: null,
      fast_release_consumed_at: null, released_at: null, online_source: null,
      // reopened_at 故意不放进对象——`in` 判据应命中"键缺席"
    };
    assert.ok(!('reopened_at' in rowMissingReopenedAt), '[12a-前置] 夹具行确实不含 reopened_at 键（非值为 undefined 的另一种形态，下方 [12b] 单独测那种）');
    let thrown12a = null;
    try { I.isActiveFastReleaseAuth(rowMissingReopenedAt); } catch (e) { thrown12a = e; }
    assert.ok(thrown12a, '[12a] 缺 reopened_at 应抛错，未抛=静默绕过 fail-closed');
    assert.strictEqual(thrown12a.httpStatus, 500, `[12a] 应为 500（开发期不变量违反，非业务 4xx），实得 ${thrown12a.httpStatus}`);
    assert.strictEqual(thrown12a.code, 'FAST_RELEASE_PREDICATE_INPUT_INVARIANT', `[12a] 确切码，实得 ${thrown12a.code}`);
    assert.strictEqual(thrown12a.message, '活跃授权判定缺少 reopened_at 投影（调用方 SELECT 必须含该列）', `[12a] 精确错误文案，实得="${thrown12a.message}"`);
    ok('[12a] isActiveFastReleaseAuth 缺 reopened_at 键（其余五列齐全）：抛 500 FAST_RELEASE_PREDICATE_INPUT_INVARIANT + 精确文案，不静默判过');

    // [12b] 对照：六列全给（reopened_at 显式为 null，键存在只是值为空——这是合法业务态"从未 reopen 过"，
    //   不应触发 fail-closed）——证明本组新增的检查只挡"键缺席"，不误伤"值为 null 的合法态"。
    const rowAllPresent = { ...rowMissingReopenedAt, reopened_at: null };
    assert.strictEqual(I.isActiveFastReleaseAuth(rowAllPresent), true, '[12b] 六列全投影（reopened_at 显式 null）应正常判定为活跃授权=true，不误报缺列');
    ok('[12b] ★对照组：六列全投影（reopened_at 键存在且为 null）不触发 fail-closed，正常判定通过——证明检查只认"键缺席"不认"值为 null"');

    // [12c] 逐列穷举：其余五列各自缺席时同样应抛错（M3 原话"同款检查覆盖谓词消费的全部六列"，不止
    //   reopened_at 一列）。
    const FULL_ROW = { fast_release_auth_at: '2026-08-13 10:00:00', fast_release_revoked_at: null,
      fast_release_consumed_at: null, released_at: null, online_source: null, reopened_at: null };
    for (const col of Object.keys(FULL_ROW)) {
      const partial = { ...FULL_ROW };
      delete partial[col];
      let thrownC = null;
      try { I.isActiveFastReleaseAuth(partial); } catch (e) { thrownC = e; }
      assert.ok(thrownC, `[12c-${col}] 缺 ${col} 应抛错`);
      assert.strictEqual(thrownC.code, 'FAST_RELEASE_PREDICATE_INPUT_INVARIANT', `[12c-${col}] 确切码，实得 ${thrownC.code}`);
      assert.ok(thrownC.message.includes(col), `[12c-${col}] 错误文案应点名缺失的列名 ${col}，实得="${thrownC.message}"`);
    }
    ok(`[12c] isActiveFastReleaseAuth 六列逐列穷举缺列测试：${Object.keys(FULL_ROW).length} 列各自缺席均抛错且文案精确点名对应列（M3"同款检查覆盖全部六列"）`);

    // [12d] 真实调用点核实：submit 端点的初始 SELECT 已含全部六列（不依赖间接推断，直接读源码文本核对）。
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const selectMatch = indexSrc.match(/fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at, released_at, online_source,\s*\n\s*reopened_at/);
    assert.ok(selectMatch, '[12d] submit 端点初始 SELECT 应六列齐全（静态源码核对，防止后续重构悄悄漏列却测不出——[12a-12c] 只证明函数本身 fail-closed 生效，证不了"生产唯一调用点确实喂全了六列"这件事，需要这条独立核对）');
    ok('[12d] 静态核对：submit 端点唯一调用点的初始 SELECT 六列齐全（fast_release_auth_at/_revoked_at/_consumed_at/released_at/online_source/reopened_at）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ verify-sys-fastlane-submit 全绿`);
  console.log('  覆盖：schema 三列就绪 + 直上正例(commits/no_code 两模式·五字段原子落库+timeline+submit通用副作用保留) + 并发防线(SQL造态+顺序双请求) + 负例族(无授权/已撤销/已消费/已有上线标记/非bug类型) + status分支函数级证明 + direct_release=false零变化回归 + 多开发场景三态(非最后提交者409/全普通提交进待验证/最后提交者勾选一次成功直上) + 不变量①②③⑦探针([Y5]范式，含③状态绑定) + online_source消费面(详情/列表/前端字典/efficiency-stats豁免) + FAST_RELEASE_DIRECT routeKind单元覆盖 + [预筛追加]HIGH-1 reopen清补验收字段组真实链路正向 + MED-1 last_completed_at直上分支(列表+详情) + [组B·B1落地后改SQL造态]MED-2纵深防御成对用例(造态悬垂授权跨轮拒/reopen后重授权放行) + M3唯一判据fail-closed缺列断言 + L1不变量③状态绑定');
  server.close();
}

main().catch((e) => { fail(e && e.stack ? e.stack : String(e)); });
