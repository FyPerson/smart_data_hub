// 验证脚本：系统迭代 C3a 开发动作 + 旁路态端点全流程（方案 §3.4/§3.5/§5/§7）
//   用法：node scripts/verify-sys-flow.js
//
// in-process express app（挂真实 router）+ 内存库 + seed users + 自签 token，测端点链路：
//   1. estimate（回填预计，开发本人，>=assigned_at，旁路不改 status）
//   2. submit/accept/return/close 全流程
//   3. hold/resume（resume 从 timeline 解析暂缓前态，RC-M2）
//   4. reopen（reopen_count++ + 清时间戳）/ reactivate / issue_reject / void
//   5. scope_change（F2a 起 feature/improvement 全禁 → 409 SCOPE_CHANGE_DISABLED）
//   6. derive（派生新单 + 防环 M-1 + T-L3 先 created 再 derive）
//   7. normalizeSysDatetime 用例表（核实#8 / §6.2 L-2）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-flow-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// authenticateToken mock：解析 Bearer JWT 注入 req.user（对齐 server.js 真实行为）
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
  ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
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
// ⚠️ '2020-01-01 10:00' 是刻意的过去时刻（测「早于 assigned_at」400 负例），永远合法地"早于现在"，不属时限炸弹，不改。

// 用端点建一个 feature 单并推进到指定状态（admin 视角），返回 id
async function seedToDevInProgress(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status);
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0（方案 v1.5 §4-C0）：建单**恒落「待受理」**（受理门焊死·intake_required 恒 1），
  //   夹具补一步 intake_accept 把单推回「待指派」——受理后落态与旧建单落态**逐字相同**，故下游用例断言零改动。
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, '夹具受理 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  // 受理排期改造：schedule 退场——受理通过落「待指派」，直接 assign（待指派→开发中）。
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  assert.strictEqual(r.status, 200, 'assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));      // codex 15 L-1
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // seed users 表（assign 端点校验被指派人存在 + 非 viewer）
  // 建单优化批 C3b（方案 §6c）：主建单端点需求方三字段全空时会 SELECT users.phone 做固化——
  //   users 夹具须含该列，否则撞 SQLITE_ERROR: no such column: phone（本次一并补齐）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer'),(13,'wangtaotao','示例对接人','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin/dev5/dev6/viewer9）');

  try {
    // ── [1] estimate（回填预计）──
    const id1 = await seedToDevInProgress(5);   // 指派给 dev5，开发中
    // estimate 缺/非法格式 → 400
    let r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: '随便' });
    assert.strictEqual(r.status, 400, 'estimate 非法格式 400');
    assert.strictEqual(r.body.code, 'INVALID_ESTIMATE');
    ok('estimate：非法时间格式「随便」→ 400 INVALID_ESTIMATE');
    // 非本人开发 estimate → 403
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, dev2Tok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, 'estimate 非本人 403');
    ok('estimate：非本人开发（dev6≠assignee）→ 403 NOT_AUTHORIZED_FOR_TRANSITION');
    // 早于 assigned_at → 400（assigned_at 是 datetime now，传 2020 必早）
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: '2020-01-01 10:00' });
    assert.strictEqual(r.status, 400, 'estimate 早于指派 400');
    assert.strictEqual(r.body.code, 'ESTIMATE_BEFORE_ASSIGN');
    ok('estimate：早于 assigned_at（2020）→ 400 ESTIMATE_BEFORE_ASSIGN');
    // 合法 estimate（本人）→ 200，不改 status（仍开发中）
    r = await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, 'estimate 合法 200');
    const d1 = await get('SELECT status, dev_estimated_at FROM sys_issues WHERE id=?', [id1]);
    assert.strictEqual(d1.status, '开发中', 'estimate 不改 status');
    assert.strictEqual(d1.dev_estimated_at, EST, 'dev_estimated_at 规范化入库');
    ok('estimate：本人 + 合法时间 → 200，不改 status（仍开发中）+ dev_estimated_at 入库');
    // codex 15b L-1：assigned_at 缺失保护——造一个"开发中但 assigned_at 空"的脏单，estimate 应 409 ASSIGNED_AT_MISSING
    const dirtyId = await seedToDevInProgress(5);
    await run('UPDATE sys_issues SET assigned_at = NULL WHERE id=?', [dirtyId]);   // 模拟 import/人工修库脏单
    r = await call('POST', `/api/sys-issues/${dirtyId}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 409, 'assigned_at 空脏单 estimate 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'ASSIGNED_AT_MISSING', 'assigned_at 空应 ASSIGNED_AT_MISSING');
    ok('L-1(复)：estimate assigned_at 缺失脏单 → 409 ASSIGNED_AT_MISSING（防绕过 >=assigned_at 闸门）');

    // ── [2] submit → accept 全流程 ──
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { mode: 'no_code', no_code_reason: '功能 X 完成（占位理由）' });
    assert.strictEqual(r.status, 200, 'submit 200');
    // C3：新 submit 响应体字段为 main_status（同 C2 add/reassign 端点惯例），非旧 makeTransitionEndpoint 的 status。
    assert.strictEqual(r.body.main_status, '待验证', 'submit → 待验证（main_status 字段）');
    ok('submit：在册开发 + no_code → 待验证（W05 唯一 submit，C3 多开发 commit 事件模型）');
    r = await call('POST', `/api/sys-issues/${id1}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, 'accept 200');   // L-1
    assert.strictEqual(r.body.status, '待上线', 'accept → 待上线');
    ok('accept：admin → 待上线');

    // ── [3] return（打回，return_count++）──
    const id2 = await seedToDevInProgress(5);
    await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id2}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付（占位理由）' });
    r = await call('POST', `/api/sys-issues/${id2}/return`, adminTok, { reason: '列不齐' });
    assert.strictEqual(r.status, 200, 'return 200');   // L-1
    assert.strictEqual(r.body.status, '开发中', 'return → 开发中');
    const d2 = await get('SELECT return_count, dev_estimated_at FROM sys_issues WHERE id=?', [id2]);
    assert.strictEqual(d2.return_count, 1, 'return_count++ (=1)');
    assert.strictEqual(d2.dev_estimated_at, null, 'return 清 dev_estimated_at（T-M2）');
    ok('return：admin + reason → 开发中，return_count=1 + 清 dev_estimated_at');

    // ── [4] hold → resume（RC-M2 暂缓前态解析）──
    const id3 = await seedToDevInProgress(5);   // 开发中
    r = await call('POST', `/api/sys-issues/${id3}/hold`, adminTok, { reason: '暂缓一下' });
    assert.strictEqual(r.status, 200, 'hold 200');   // L-1
    assert.strictEqual(r.body.status, '已暂缓', 'hold → 已暂缓');
    ok('hold：开发中 → 已暂缓（admin + reason）');
    // [codex 98 号 MED7① 自检补漏] W07 证据表——hold 此前只有合法通过例，补非法拒绝：缺 reason → 400
    const id3b = await seedToDevInProgress(5);
    r = await call('POST', `/api/sys-issues/${id3b}/hold`, adminTok, { reason: '  ' });
    assert.strictEqual(r.status, 400, `[W07 证据·hold] hold 缺 reason 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[W07 证据·hold] 非法拒绝：hold 缺 reason（trim 空）→ 400（requiredPayload 校验）');
    // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，两流统一必填——补传 reason
    // ⚠️ [S1b·M-1] reason 文案刻意不含「开发中」等状态名词，使下方"summary 同时含目标态字符串 + reason 原文"
    //   两个子断言互不重叠、各自独立可证伪（防止巧合命中掩盖真实缺陷）。
    const resumeReason4 = '验证 resume 审计留痕（reason 需真实落库）';
    r = await call('POST', `/api/sys-issues/${id3}/resume`, adminTok, { reason: resumeReason4 });
    assert.strictEqual(r.status, 200, 'resume 200');
    assert.strictEqual(r.body.status, '开发中', 'resume 回暂缓前态（开发中）');
    ok('⭐ resume：已暂缓 → 开发中（从 timeline 解析暂缓前态 RC-M2，非静默落任意态）');
    // ⭐ [S1b·M-1 非降级路径审计断言·codex 236 MED-1] reason 只进 timeline summary，此前无断言锁定——
    //   查该单最近一条 action_code='resume' 的 timeline 行，断言 summary 同时含恢复目标态字符串与 reason 原文
    //   （index.js case 'resume' 非降级分支拼法：`恢复到「X」｜原因：<reason>`，重构时最容易被顺手改掉的正是这条拼接）。
    const tl4 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='resume' ORDER BY id DESC LIMIT 1`, [id3]);
    assert.ok(tl4 && tl4.summary && tl4.summary.includes('开发中') && tl4.summary.includes(resumeReason4),
      `resume timeline summary 应同时含目标态「开发中」+ reason 原文，实际：${tl4 && tl4.summary}`);
    ok('resume：timeline summary 落库同时含恢复目标态 + reason 原文（非降级路径，S1b·M-1）');
    // resume 非暂缓态 → 400 INVALID_TRANSITION（M-1 重构后由 transition findTransition 统一拦截，
    //   与其他动作"非法前置态"行为一致；非暂缓态没有 resume transition，返 400；findTransition 早于
    //   requiredPayload 校验，故此处空 body 不受 reason 必填变更影响，仍应命中 INVALID_TRANSITION）
    r = await call('POST', `/api/sys-issues/${id3}/resume`, adminTok, {});
    assert.strictEqual(r.status, 400, 'resume 非暂缓态 400, got ' + r.status);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', 'resume 非暂缓态 INVALID_TRANSITION');
    ok('resume：非已暂缓态 → 400 INVALID_TRANSITION（M-1 重构后 transition 统一拦截非法前置态，S1b·M-2 第二条校验顺序在此覆盖）');

    // ⭐ [S1b·M-2 专用 resume 路由负向断言·codex 236 MED-2] 透传 req.body 是 S1 的实现错回填（index.js:6279），
    //   但当时没有断言证明"缺 reason 会稳定返回 RESUME_REASON_REQUIRED"——钉确切错误码，不用 status>=400 弱判据。
    //   覆盖空 body 和纯空白字符串 reason 两种输入（trim 后皆空），且断言拒绝后单仍停在已暂缓（无副作用）。
    const id3c = await seedToDevInProgress(5);
    r = await call('POST', `/api/sys-issues/${id3c}/hold`, adminTok, { reason: 'M-2 夹具：先暂缓待测 resume reason 校验' });
    assert.strictEqual(r.status, 200, 'M-2 夹具：hold 200');
    r = await call('POST', `/api/sys-issues/${id3c}/resume`, adminTok, {});
    assert.strictEqual(r.status, 400, `M-2：已暂缓态 resume 空 body 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_REASON_REQUIRED', `M-2：已暂缓态 resume 空 body 应 code=RESUME_REASON_REQUIRED, got ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id3c])).status, '已暂缓', 'M-2：空 body 拒绝后仍停在已暂缓（无副作用）');
    r = await call('POST', `/api/sys-issues/${id3c}/resume`, adminTok, { reason: '   ' });
    assert.strictEqual(r.status, 400, `M-2：已暂缓态 resume 纯空白 reason 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_REASON_REQUIRED', `M-2：已暂缓态 resume 纯空白 reason 应 code=RESUME_REASON_REQUIRED, got ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id3c])).status, '已暂缓', 'M-2：纯空白 reason 拒绝后仍停在已暂缓（无副作用）');
    ok('resume：已暂缓态缺 reason（空 body / 纯空白）→ 400 RESUME_REASON_REQUIRED 且态不变（S1b·M-2，专用 resume 路由 payload 透传后的负向验证，钉确切错误码非弱判据）');

    // ── [5] reopen（已关闭 → 开发中，reopen_count++）──
    //   推进 id1（待上线）到已上线需批次（C4），这里直接 DB 改到已关闭测 reopen
    const id4 = await seedToDevInProgress(5);
    await run("UPDATE sys_issues SET status='已关闭', accepted_at='2026-01-01', closed_at='2026-01-02' WHERE id=?", [id4]);
    r = await call('POST', `/api/sys-issues/${id4}/reopen`, adminTok, { reason: '回归 bug' });
    assert.strictEqual(r.status, 200, 'reopen 200');   // L-1
    assert.strictEqual(r.body.status, '开发中', 'reopen → 开发中');
    const d4 = await get('SELECT reopen_count, accepted_at, closed_at, reopened_at FROM sys_issues WHERE id=?', [id4]);
    assert.strictEqual(d4.reopen_count, 1, 'reopen_count++ (=1)');
    assert.strictEqual(d4.accepted_at, null, 'reopen 清 accepted_at');
    assert.strictEqual(d4.closed_at, null, 'reopen 清 closed_at');
    assert.ok(d4.reopened_at, 'reopen 盖 reopened_at');
    ok('reopen：已关闭 → 开发中，reopen_count=1 + 清 accepted_at/closed_at + 盖 reopened_at');
    // [codex 98 号 MED7① 自检补漏] W07 证据表——reopen 补非法拒绝：from 白名单仅 [已关闭]（C6·§6.5 收窄前
    //   曾是 [已上线,已关闭]），开发中态 reopen → 400。
    const id4b = await seedToDevInProgress(5);
    r = await call('POST', `/api/sys-issues/${id4b}/reopen`, adminTok, { reason: '误触' });
    assert.strictEqual(r.status, 400, `[W07 证据·reopen] 开发中态 reopen 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', 'reopen from 白名单外应 INVALID_TRANSITION');
    ok('[W07 证据·reopen] 非法拒绝：开发中态 reopen → 400 INVALID_TRANSITION（from 白名单仅已关闭）');
    // [C6·方案 v3.4 §6.5] reopen 收窄：已上线（未归档）→ 409 ISSUE_NOT_ARCHIVED（须先归档），不再是合法
    //   from——直接 DB 改到已上线，隔离测试该态本身，不依赖真实发布/批次基础设施（完整发布→归档→重开
    //   回环见 verify-sys-release.js；本文件只钉这一条 from 收窄的核心负例，与该文件全流程回环互补）。
    const id4c = await seedToDevInProgress(5);
    await run("UPDATE sys_issues SET status='已上线', accepted_at='2026-01-01', released_at='2026-01-02' WHERE id=?", [id4c]);
    r = await call('POST', `/api/sys-issues/${id4c}/reopen`, adminTok, { reason: '未归档误触' });
    assert.strictEqual(r.status, 409, `[C6] 已上线未归档 reopen 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ISSUE_NOT_ARCHIVED', '[C6] code=ISSUE_NOT_ARCHIVED（须先归档）');
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id4c])).status, '已上线', '[C6] 拒绝后仍停在已上线（未被误翻）');
    ok('[C6·§6.5] reopen 收窄：已上线（未归档）→ 409 ISSUE_NOT_ARCHIVED（from 白名单收窄为仅[已关闭]，须先 close 归档才能 reopen，附录 A 明列）');

    // ── [6] issue_reject → reactivate（待受理 → 已拒绝 → 待受理）──
    //   受理排期改造：issue_reject.from 由「待评估」改「待受理」（前段唯一可拒态）。
    //   ⭐ 角色权限重构 C0：建单已**恒落「待受理」**，不再需要 DB 置态造夹具（旧注释「建单只能落待指派」已过期）。
    //   ⭐ 角色权限重构 v2.1 §3（改用 bug 类型）：变更流（feature/improvement）的 issue_reject 已改由
    //   **受理人**操作 + 前置守卫要求当前轮已有 tech_lead_comment——那条权限/前置守卫矩阵由
    //   verify-sys-pre-discuss.js [RJ] 组逐格覆盖，本文件（通用状态机/W07 证据表覆盖）不重复搭建
    //   受理人/技术负责人咨询夹具；改用 bug 类型保留"直接拒绝→reactivate"这条最简路径（bug 的
    //   issue_reject 现状不变：仅 admin、无前置守卫），本组要测的 reactivate 白名单/reopen_count/
    //   intake_required 三条不变量与 type 无关。
    let rr = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'reject测', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const id5 = rr.body.id;   // C0 后：待受理 + intake_required=1
    r = await call('POST', `/api/sys-issues/${id5}/issue-reject`, adminTok, { reason: '不做' });
    assert.strictEqual(r.status, 200, 'issue-reject 200 (待受理→已拒绝)');   // L-1
    assert.strictEqual(r.body.status, '已拒绝', 'issue_reject → 已拒绝');
    r = await call('POST', `/api/sys-issues/${id5}/reactivate`, adminTok, { reason: '重新考虑' });
    assert.strictEqual(r.status, 200, 'reactivate 200');   // L-1
    // ⭐ C0 行为：reactivate 落态**不依赖单据 intake_required**，走 resolveSysInitialStatusForCreate（创建路径唯一入口）。
    //   ⭐ v2.1（C2.5 撤销）：该函数全类型恒返「待受理」——复活 = 回到受理门重新走一遍。
    assert.strictEqual(r.body.status, '待受理', 'reactivate → 待受理（v2.1：C2.5 撤销后全类型归一）');
    const d5r = await get('SELECT reopen_count, intake_required FROM sys_issues WHERE id=?', [id5]);
    assert.strictEqual(d5r.reopen_count, 0, 'reactivate 不计返工（reopen_count 不变 RC-M1）');
    assert.strictEqual(d5r.intake_required, 1, 'C0：reactivate 同事务把 intake_required 置 1（防「待受理+ir0」矛盾组合卡死受理）');
    ok('issue_reject → reactivate：待受理 → 已拒绝 → 待受理（C0 恒回受理门 + intake_required=1 原子同写 + reopen_count 不变 RC-M1）');
    // [codex 98 号 MED7① 自检补漏] W07 证据表——reactivate 补非法拒绝：from 白名单仅 [已拒绝]，非该态 reactivate → 400
    r = await call('POST', `/api/sys-issues/${id5}/reactivate`, adminTok, { reason: '再试一次' });   // id5 此时已是「待受理」（上面刚 reactivate 过），非「已拒绝」
    assert.strictEqual(r.status, 400, `[W07 证据·reactivate] 非已拒绝态 reactivate 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', 'reactivate from 白名单外应 INVALID_TRANSITION');
    ok('[W07 证据·reactivate] 非法拒绝：待受理态（非已拒绝）reactivate → 400 INVALID_TRANSITION');

    // ── [7] void（作废）──
    // [codex 98 号 MED7① 自检补漏] W07 证据表——void from='*'（任意态皆可作废），故唯一可测的"非法拒绝"
    //   维度是权限（roleGuard='admin'）而非 from 状态：非 admin（开发）void → 403。先测负例，再测正例作废
    //   （避免先作废后 id5 状态提前进「已作废」污染负例的可读性）。
    r = await call('POST', `/api/sys-issues/${id5}/void`, devTok, { reason: '开发想删单' });
    assert.strictEqual(r.status, 403, `[W07 证据·void] 非 admin void 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[W07 证据·void] 非法拒绝：非 admin（开发）void → 403（from=* 无状态维度可拒，权限维度替代）');
    r = await call('POST', `/api/sys-issues/${id5}/void`, adminTok, { reason: '误建' });
    assert.strictEqual(r.status, 200, 'void 200');   // L-1
    assert.strictEqual(r.body.status, '已作废', 'void → 已作废');
    ok('void：→ 已作废（软删除）');

    // ── [8] scope_change：F2a 起 feature/improvement 全禁（评估环节"禁开发态调需求"，v1.7 §十九 ⑦）──
    //   ⚠️ 连锁改写：原 C3a「scope_change 改 status/scope_changed=1/deadline 留痕」断言已不适用——
    //   端点内逻辑保留（config 流追加时用），但 feature/improvement 被 type 守卫前置拦 409；summary 校验/deadline 留痕/M-3 等留 config 流测。
    const id6 = await seedToDevInProgress(5);   // 开发中
    r = await call('POST', `/api/sys-issues/${id6}/scope-change`, adminTok, { summary: '加一个导出功能', deadline: '2026-09-01' });
    assert.strictEqual(r.status, 409, 'scope-change feature 全禁 409, got ' + r.status);
    assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', 'feature scope-change 应 SCOPE_CHANGE_DISABLED, got ' + (r.body && r.body.code));
    const d6 = await get('SELECT status, scope_changed FROM sys_issues WHERE id=?', [id6]);
    assert.strictEqual(d6.status, '开发中', 'scope-change 被拒，status 不变（仍开发中）');
    assert.strictEqual(d6.scope_changed, 0, 'scope-change 被拒，scope_changed 不变（仍 0）');
    ok('⭐ scope_change：F2a 起 feature/improvement 全禁 → 409 SCOPE_CHANGE_DISABLED（需求变化走 derive/作废重开）');

    // ── [9] derive（派生新单 + 防环 + T-L3）──
    const id7 = await seedToDevInProgress(5);
    r = await call('POST', `/api/sys-issues/${id7}/derive`, adminTok, { type: 'feature', title: '迭代需求', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r.status, 201, 'derive 201');
    const derivedId = r.body.id;
    assert.strictEqual(r.body.origin_issue_id, id7, 'derive origin_issue_id=原单');
    // T-L3：先 created 再 derive
    const dtl = await all("SELECT event_type FROM sys_issue_timeline WHERE issue_id=? ORDER BY id", [derivedId]);
    assert.strictEqual(dtl[0].event_type, 'created', '派生新单首条 created（T-L3）');
    assert.strictEqual(dtl[1].event_type, 'derive', '派生新单次条 derive（T-L3）');
    ok('derive：派生新单 201 + origin_issue_id=原单 + T-L3（先 created 再 derive）');
    // 防环：让 id7 的 origin 指向 derivedId，再从 derivedId 派生回 id7 链 → 应拒
    await run('UPDATE sys_issues SET origin_issue_id=? WHERE id=?', [derivedId, id7]);   // id7.origin=derivedId
    r = await call('POST', `/api/sys-issues/${derivedId}/derive`, adminTok, { type: 'feature', title: 'x', system_name: 'BMS', source: '内部' });
    // derivedId.origin=id7, id7.origin=derivedId → 从 derivedId 回溯链含 derivedId 自身 → DERIVE_CYCLE
    assert.strictEqual(r.status, 409, 'derive 成环 409');
    assert.strictEqual(r.body.code, 'DERIVE_CYCLE', 'derive 成环 DERIVE_CYCLE');
    ok('⭐ derive 防环（M-1）：blood 链成环（derivedId→id7→derivedId）→ 409 DERIVE_CYCLE');

    // ── [10] normalizeSysDatetime 用例表（核实#8 / §6.2 L-2 + codex 15 M-2 分钟级）──
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30'), '2026-08-01 10:30', '标准格式');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01T10:30'), '2026-08-01 10:30', 'T 分隔（datetime-local）');
    assert.strictEqual(I.normalizeSysDatetime('  2026-08-01 10:30  '), '2026-08-01 10:30', 'trim');
    assert.strictEqual(I.normalizeSysDatetime(''), null, '空串 null');
    assert.strictEqual(I.normalizeSysDatetime('   '), null, '纯空格 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-13-01 10:00'), null, '非法月份 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-02-30 10:00'), null, '非法日期 null');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 25:00'), null, '非法小时 null');
    assert.strictEqual(I.normalizeSysDatetime('随便写'), null, '乱码 null');
    // codex 15 M-2：分钟级——带秒判非法（不再吞秒），杜绝 10:30:99 被规范化为 10:30 通过
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30:00'), null, '带秒（合法秒）也判非法（分钟级口径）');
    assert.strictEqual(I.normalizeSysDatetime('2026-08-01 10:30:99'), null, '带非法秒判非法（不吞秒）');
    // truncToMinute：DB datetime 截分钟（estimate 比较 assigned_at 用）
    assert.strictEqual(I.truncToMinute('2026-08-01 10:30:59'), '2026-08-01 10:30', 'truncToMinute 截秒');
    assert.strictEqual(I.truncToMinute(null), null, 'truncToMinute null 安全');
    ok('normalizeSysDatetime 分钟级（M-2）：标准/T分隔/trim/空/非法月日时/乱码/带秒判非法 + truncToMinute 截秒');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 C3a 开发动作 + 旁路态端点全流程验证通过`);
    console.log('  覆盖：estimate(本人/格式/>=assigned_at) + submit/accept/return(计数) + hold/resume(RC-M2 暂缓前态) + reopen(计数/清时间戳 + [C6]已上线未归档→409 ISSUE_NOT_ARCHIVED) + reactivate(RC-M1) + void + scope_change(F2a 全禁 409) + derive(防环 M-1/T-L3) + normalizeSysDatetime');
  } finally {
    server.close();
    db.close();
  }
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); if (server) server.close(); db.close(); process.exit(1); });
