// 验证脚本：系统迭代 角色权限重构 C1 — 权限收敛（方案 v1.5 §4-C1）
//   用法：node scripts/verify-sys-role-perm-c1.js
//
// C1 把权限模型从「bug 对接人白名单[7,13] 且仅 bug」收敛为「受理人[13] 且全类型」：
//   · 受理人示例对接人[13]：受理 + 指派/改派（**全类型**）+ 开发成员 + 附件 + 通知（**全类型**）+ 发起技术咨询
//   · 技术负责人示例发布者[7]：**失去全部协调人动作**（指派/改派/开发成员/附件/通知），保留 bug 可见性（为 C3 评估留言）
//     ⚠️ 「失去协调人动作」≠「不能当开发」：示例发布者仍可**被 admin/受理人指派**为某单开发（用户 2026-07-27 复审时
//     拍板：他会兼任开发）。届时他按 ownerGuard='assignee' 拿到**该单**的 estimate/submit 与开发侧读写——那是
//     开发角色的权，与 C1 收走的协调人权正交，且无自提权路径（assign 本身已收归 admin∨受理人）。
//     既有断言见 verify-sys-liaison [M3]（admin 指派 feature 给 id=7 → 200 + 读权不削弱）。
//   · admin：额外独占 验收(accept) / 暂缓(hold) / 关闭(close)
//     （本模块无「配置」端点——config 是第 4 种单据类型，不是管理面配置项，勿写进 admin 专属族清单）
//     ⚠️ 2026-07-30 用户裁定：旧上线编排家族 4 端点（assign-release-dev / reassign-release-dev /
//     notify-release-executor / notify-release-executor-batch）全部封禁退场——不再是"仅 admin"的
//     专属族成员，改为任意已登录角色一律 409 LEGACY_RELEASE_FLOW_DISABLED（见 [M2]④⑤ 封禁契约两格）。
//
// 本脚本是 C1 的**表驱动权限矩阵**（codex C1 审 MED：既有脚本只覆盖 bug+feature、admin 专属动作只测了 accept）：
//   [M1] 协调人族 × 三类型 × 四角色（assign / reassign / dev-assignees / 附件上传）
//   [M2] admin 专属族 × 四角色（accept×3类型 / hold / close）—— 证受理人拿到的不是泛化 admin 权；
//        另附④⑤两格上线编排封禁契约（assign-release-dev / reassign-release-dev，2026-07-30 全封，
//        四角色一律 409，已不是"admin 专属"语义，只是挂在 M2 组里顺带回归）
//   [M3] 通知三通道 × 三类型 × 四角色（developer / creator / requester）
//   [M4] 查已读通道差异：dev/creator/requester = admin∨受理人；relay/release_executor = **仅 admin**（死按钮防线）
//   [M5] ⭐ 角色轴 × 开发轴正交：示例发布者兼任开发后，开发动作放行、协调人动作仍全拒（把方案 §3 口径测死）
//   [V]  可见性：受理人对**未指派的三类型**列表可见 + 详情可开（否则"能指派却找不到单"功能断裂）
//   [G]  sysManualNotifyGuard 未知通道 fail-closed
//
// ⚠️ 断言纪律（C1 复审 MED-2/MED-3 回填·[[feedback_test_assertion_self_error]]）：
//   ① **正例不许只断言「不是 403」**——本模块大量端点在角色闸之后还有状态闸，`!==403` 会把 409/400 当成放行，
//      36 格通知矩阵曾因此有 24 格是空跑。正例一律断言**精确状态码 + 落库副作用**；若该格必然停在业务闸上，
//      就断言**那个业务错误码**（如 NOTIFY_NOT_SENT）——它同样证明"角色闸已过"，但不会把 403 混进来。
//   ② **每格独立夹具**——不许靠"前一个角色跑成功后 break"省夹具，那会让后续角色一格都不跑。
//   ③ 负例除状态码外还要断言**状态没被改动**（403 之后落库必须原样）。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-role-perm-c1-secret';
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
async function mockSend() { return { ok: true, message_key: 'stub-key' }; }
async function mockBaseUrl() { return ''; }

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSend,
  getSafePlatformBaseUrl: mockBaseUrl,
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

// ⚠️ **测试 id 与生产 users.id 无对应关系**（2026-07-27 踩坑）：授权判定只看 JWT 的 `role` 与三个白名单常量
//   （`SYS_INTAKE_LIAISON_IDS=[13]` / `SYS_TECH_LEAD_IDS=[7]` / `SYS_BUG_LIAISON_USER_IDS=[7,13]`），
//   本文件的 dev5/dev6 只是夹具编号，别据此推断生产里 id=5/6 是什么角色（生产 id=5 实为 admin）。
//   ⭐ **admin 是多人**：生产 `users` 实有 **6 个 role='admin' 且 active** 的账户，彼此独立、互为"他人"。
//   此前本脚本只有一个 admin token，导致所有"两个 admin 互为他人"的语义（self-guard / 代办 / 审计归属）
//   一格都没测到，[M3] 的 `admin → skipped===true` 因此是条**永远成立**的空断言。故此处补第二个 admin。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '管理员乙', role: 'admin' }, SECRET);   // 第二个 admin（生产 6 个 admin 的最小建模）
const intakeTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);      // 技术负责人
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// multipart 上传（field=files + attachment_type）
function upload(id, tok, attachmentType, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----c1vfy' + Date.now();
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="attachment_type"\r\n\r\n${attachmentType}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nfake\r\n`,
      `--${boundary}--\r\n`,
    ];
    const data = Buffer.from(parts.join(''), 'utf8');
    const req = http.request({ host: '127.0.0.1', port, path: `/api/sys-issues/${id}/attachments`, method: 'POST', headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': data.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.write(data); req.end();
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
const TYPES = ['bug', 'feature', 'improvement'];
const ROLES = [
  { who: 'admin(1)',   tok: adminTok,  isAdmin: true,  isIntake: false },
  { who: '示例对接人(13)', tok: intakeTok, isAdmin: false, isIntake: true },
  { who: '示例发布者(7)',    tok: techTok,   isAdmin: false, isIntake: false },
  { who: 'dev(5)',     tok: devTok,    isAdmin: false, isIntake: false },
];

// ── 夹具：每一步都断言状态码**并核对真实落态**（C1 复审 MED-3：夹具只看状态码会让后续断言跑在错误前置态上假绿）──
const ASSIGNABLE_STATUS = { bug: '待处理', feature: '待指派', improvement: '待指派' };   // 受理后落态（bug 前段最短，无排期）
const DEV_STATUS        = { bug: '处理中', feature: '开发中', improvement: '开发中' };   // 指派后落态

async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }

// 建单（C0 后恒落待受理）→ 受理 → 落「待指派」(变更流) /「待处理」(bug)
async function mkAssignable(type) {
  const r = await call('POST', '/api/sys-issues', adminTok,
    { intake_contract_version: 2, type, title: `${type}-C1`, system_name: 'BMS', source: '内部', requester_phone: '13800000009',
      description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：三类型建单均直落「待受理」，预沟通段整体撤销，无需按 type 分支中转。
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level（否则 400 RISK_LEVEL_REQUIRED）。
  const acc = await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, adminTok, (type === 'feature' || type === 'improvement') ? { risk_level: '二级' } : {});
  assert.strictEqual(acc.status, 200, `${type} 受理 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
  assert.strictEqual(await statusOf(r.body.id), ASSIGNABLE_STATUS[type],
    `夹具 mkAssignable(${type})：受理后须真落「${ASSIGNABLE_STATUS[type]}」`);
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验（bug 不受限）→ 本 helper 名为
  //   "可指派"，把 OA 前置一并做进来，使所有调用点的 assign 测的都是"权限/状态"本身，不被"忘设 OA"
  //   这个无关变量污染。⚠️ 这个分支本身就是被测语义之一：若哪天 bug 也被误拉进 OA 门槛，这里会因
  //   set-oa-number 未被调用而在下游 assign 处当场红灯（bug 分支不调用，故不受影响）。
  if (type !== 'bug') {
    const oa = await call('POST', `/api/sys-issues/${r.body.id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(oa.status, 200, `${type} 补 OA 号 200, got ${oa.status} ${JSON.stringify(oa.body)}`);
  }
  return r.body.id;
}
// 推进到开发态（已指派 dev5）
//   ⚠️ [C10 涟漪修复] 本 helper 产物**保持 intake_liaison_id=13（绑定受理人）**——原实现在此置 999999
//   使 GATE 降级（供 mkVerifying 的 submit 直落待验证），但 C10 绑单精判后，[M1]/[M3] 的协调人/通知矩阵
//   要按「受理人=13 本人」判权限，若产物是 999999（未绑 13）则示例对接人(13) 会被判「非该单对接人」而 403，
//   矩阵全塌。故把 999999 失效窗口收窄到「仅 submit 期间」（下移进 mkVerifying），mkInDev 产物恒绑 13。
async function mkInDev(type) {
  const id = await mkAssignable(type);
  const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `${type} assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(await statusOf(id), DEV_STATUS[type], `夹具 mkInDev(${type})：指派后须真落「${DEV_STATUS[type]}」`);
  return id;
}
// 推进到「待验证」（开发本人回填预计完成 + 提交）——accept 的合法前置态，也是 creator/requester 通道的可发状态
async function mkVerifying(type) {
  const id = await mkInDev(type);
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] feature 的 submit 走 §3.0-⑥ 降级路径直落
  //   「待验证」（跳过「待对接测试」）需 submit 时 intake_liaison_id 失效——**仅 submit 期间置 999999**，
  //   submit 后立即复位为 13（bound），使下游 [M1]/[M3] 断言按真实绑定态（受理人=13 本人）判权限（C10 绑单精判）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  const e = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), ...(type === 'bug' ? {} : { estimated_effort_days: 1 }) });
  assert.strictEqual(e.status, 200, `夹具 mkVerifying(${type}) estimate 200, got ${e.status} ${JSON.stringify(e.body)}`);
  // [B4b 全仓扫净] mkVerifying(type) 是跨三类型共用的通用夹具（TYPES=['bug','feature','improvement']）——
  //   type==='bug' 时必填 bug_cause_note（C6 拍板生效后），其余类型不加（加了会撞 NOT_APPLICABLE）。
  const s = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-28' }], self_tested: true, test_env_deployed: true, ...(type === 'bug' ? { bug_cause_note: 'verify 夹具：bug 产生原因（role-perm-c1）' } : {}) });
  assert.strictEqual(s.status, 200, `夹具 mkVerifying(${type}) submit 200, got ${s.status} ${JSON.stringify(s.body)}`);
  assert.strictEqual(await statusOf(id), '待验证', `夹具 mkVerifying(${type})：提交后须真落「待验证」`);
  await run(`UPDATE sys_issues SET intake_liaison_id = 13 WHERE id = ?`, [id]);   // 复位绑定为受理人 13（submit 降级已完成）
  return id;
}
// 推进到「待上线」（admin 验收）——close / assign-release-dev 的前置
async function mkPendingRelease(type) {
  const id = await mkVerifying(type);
  const a = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(a.status, 200, `夹具 mkPendingRelease(${type}) accept 200, got ${a.status} ${JSON.stringify(a.body)}`);
  assert.strictEqual(await statusOf(id), '待上线', `夹具 mkPendingRelease(${type})：验收后须真落「待上线」`);
  return id;
}
// 推进到「已上线」（[C6·方案 v3.4 §6.5 起三类型通用]：bug 补「已关闭」终态后 close 不再是变更流专属）——
//   C3（上线体统一重构）后端批改造：hotfix-publish 收窄为两阶段"建单+加单+抢占发送权"，本身不再直接把
//   单翻到「已上线」（真正发布现移到 /sys-releases/:id/execute，须由被排班通知的值班执行人本人调用，
//   且要求 notify_status='sent'）——本文件只关心"已上线"这个**终态**对权限矩阵的影响（如 close/reopen
//   的前置态判断），不关心怎么走到这个终态，故改走直接 SQL 构造，不依赖已改语义的端点（循
//   verify-sys-bug-notify.js:139-144 bugOnlineNoRelease 同款先例：那里也是"已上线路径本身由别的脚本
//   覆盖，本文件只需要一个已上线态样本"）。
async function mkOnline(type) {
  const id = await mkPendingRelease(type);
  await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime') WHERE id=?`, [id]);
  assert.strictEqual(await statusOf(id), '已上线', `夹具 mkOnline(${type})：直造后须真落「已上线」`);
  return id;
}
// [C4 合并修复批 275-M5] 真实 ⑦ 路径代表夹具（仅 feature——LIAISON_TEST 对 improvement/bug 恒空）——
// 本文件其余全部走 mkInDev 的 999999 降级(⑥) 简化路径（角色权限矩阵本身与走⑥/⑦无关，见 mkInDev
// 注释）。保留有效 intake_liaison_id=13，走真实 GATE ⑦（待对接测试）+ liaison-test-pass 落到待验证，
// 供下方跑 [M2/accept] 同款角色矩阵代表断言，防真实⑦链路本身与角色权限矩阵的交互回归被全 ⑥ 化的
// 夹具集合掩盖。
async function mkVerifyingViaRealLiaisonTest() {
  const id = await mkAssignable('feature');
  const a = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(a.status, 200, `[275-M5] feature assign 200, got ${a.status} ${JSON.stringify(a.body)}`);
  assert.strictEqual(await statusOf(id), '开发中', '[275-M5] 指派后须真落「开发中」');
  const e = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(e.status, 200, `[275-M5] estimate 200, got ${e.status} ${JSON.stringify(e.body)}`);
  const s = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-29' }], self_tested: true, test_env_deployed: true });
  assert.strictEqual(s.status, 200, `[275-M5] submit 200, got ${s.status} ${JSON.stringify(s.body)}`);
  assert.strictEqual(s.body.main_status, '待对接测试', '[275-M5] submit → 待对接测试（真实 ⑦ 路径，非 999999 降级）');
  // ⭐ D22-④ 批2：pass 现须凭证二选一，本夹具补 test_note。
  const p = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, intakeTok, { test_note: '275-M5 夹具测试通过' });
  assert.strictEqual(p.status, 200, `[275-M5] liaison-test-pass 200, got ${p.status} ${JSON.stringify(p.body)}`);
  assert.strictEqual(p.body.status, '待验证', '[275-M5] liaison-test-pass → 待验证');
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(2,'admin2','管理员乙','admin','13800000002'),
    (5,'dev','开发王','user','13800000005'),
    (6,'dev2','开发李','user','13800000006'),(7,'shenjun','示例发布者','publisher','13800000007'),
    (13,'wangtaotao','示例对接人','user','19900000024')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 受理人13 / 技术负责人7 / dev5,6）');

  // ═══ [M1] 协调人族 × 三类型 × 四角色 ═══
  //   期望：admin ∨ 受理人 → 允许；示例发布者 与 dev → 拒绝。**三类型一致**（C1 去掉了 type 精判）。
  {
    for (const type of TYPES) {
      for (const role of ROLES) {
        const allow = role.isAdmin || role.isIntake;
        // ① assign
        let id = await mkAssignable(type);
        let r = await call('POST', `/api/sys-issues/${id}/assign`, role.tok, { assigned_to: 5 });
        assert.strictEqual(r.status, allow ? 200 : 403,
          `[M1/assign] ${role.who} × ${type} 期望 ${allow ? 200 : 403}, got ${r.status} ${JSON.stringify(r.body)}`);
        if (allow) {
          const row = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [id]);
          assert.strictEqual(Number(row.assigned_to), 5, `[M1/assign] ${role.who} × ${type} 真落 assigned_to（非仅状态码放行）`);
        }
        // ② reassign（需先有开发态单）
        id = await mkInDev(type);
        r = await call('POST', `/api/sys-issues/${id}/reassign`, role.tok, { member_ids: [6], reason: '换人' });
        assert.strictEqual(r.status, allow ? 200 : 403,
          `[M1/reassign] ${role.who} × ${type} 期望 ${allow ? 200 : 403}, got ${r.status} ${JSON.stringify(r.body)}`);
        // ③ dev-assignees（加人）
        id = await mkInDev(type);
        r = await call('POST', `/api/sys-issues/${id}/dev-assignees`, role.tok, { user_ids: [6] });
        assert.strictEqual(r.status, allow ? 200 : 403,
          `[M1/dev-assignees] ${role.who} × ${type} 期望 ${allow ? 200 : 403}, got ${r.status} ${JSON.stringify(r.body)}`);
        // ④ 附件上传（spec 通道·协调人语义）
        id = await mkInDev(type);
        r = await upload(id, role.tok, 'spec', `s-${type}.pdf`);
        assert.strictEqual(r.status, allow ? 200 : 403,
          `[M1/附件spec] ${role.who} × ${type} 期望 ${allow ? 200 : 403}, got ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    ok('[M1] 协调人族 × 3 类型 × 4 角色 = 48 格：admin/受理人(13) 全 200（assign 还验真落 assigned_to）；示例发布者(7)/dev(5) 全 403 —— C1 去 type 精判后三类型一致');
  }

  // ═══ [M2] admin 专属族：受理人拿到的不是泛化 admin 权 ═══
  //   ⚠️ C1 复审 MED-2 重构：原实现四角色共用同一张单，admin 排第一、成功后 `break` —— 结果**三个非 admin 的
  //     accept 负例一格都没跑**，close 与 admin 正例更是完全缺失，"admin 专属族 × 四角色"这个声称是假的。
  //     现改为**每格独立夹具**：正例断言 200 + 真落态，负例断言 403 + 状态未被改动。
  {
    let m2Cells = 0;
    // ① accept（验收：待验证 → 待上线）—— 三类型 × 四角色，每格一张新单
    for (const type of TYPES) {
      for (const role of ROLES) {
        const id = await mkVerifying(type);
        const r = await call('POST', `/api/sys-issues/${id}/accept`, role.tok, {});
        assert.strictEqual(r.status, role.isAdmin ? 200 : 403,
          `[M2/accept] ${role.who} × ${type} 期望 ${role.isAdmin ? 200 : 403}（验收仅 admin）, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(await statusOf(id), role.isAdmin ? '待上线' : '待验证',
          `[M2/accept] ${role.who} × ${type} 落态须与授权结果一致（403 后状态必须原样）`);
        m2Cells++;
      }
    }
    // ② hold（暂缓：活跃态 → 已暂缓）—— 变更流专属（bug 流有意无 hold/resume·transitions.js §2.2）
    for (const type of ['feature', 'improvement']) {
      for (const role of ROLES) {
        const id = await mkInDev(type);
        const r = await call('POST', `/api/sys-issues/${id}/hold`, role.tok, { reason: '暂缓一下' });
        assert.strictEqual(r.status, role.isAdmin ? 200 : 403,
          `[M2/hold] ${role.who} × ${type} 期望 ${role.isAdmin ? 200 : 403}（暂缓仅 admin）, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(await statusOf(id), role.isAdmin ? '已暂缓' : DEV_STATUS[type],
          `[M2/hold] ${role.who} × ${type} 落态须与授权结果一致`);
        m2Cells++;
      }
    }
    // ③ close（关闭：已上线 → 已关闭）—— [C6·方案 v3.4 §6.5] bug 补「已关闭」终态后三类型都测
    //   （原"变更流专属·bug 已上线即终态"设计已作废，close 现全类型统一同一套 admin-only 闸门，C1 三轮审 MED-3 起底）
    for (const type of TYPES) {
      for (const role of ROLES) {
        const id = await mkOnline(type);
        const r = await call('POST', `/api/sys-issues/${id}/close`, role.tok, {});
        assert.strictEqual(r.status, role.isAdmin ? 200 : 403,
          `[M2/close] ${role.who} × ${type} 期望 ${role.isAdmin ? 200 : 403}（关闭仅 admin）, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(await statusOf(id), role.isAdmin ? '已关闭' : '已上线',
          `[M2/close] ${role.who} × ${type} 落态须与授权结果一致`);
        m2Cells++;
      }
    }
    // ④ 上线编排 assign-release-dev —— ⚠️ 2026-07-30 用户裁定：旧上线编排家族 4 端点全封退场，
    //    本格语义从"仅 admin 200/其余 403"改写为"封禁契约"：任意角色（含 admin）一律 409
    //    LEGACY_RELEASE_FLOW_DISABLED，且落库零副作用（release_assignee_id 调用后必须仍为空，
    //    不因角色不同而有别）。不再证"受理人拿到的不是泛化 admin 权"，只回归"封禁不分角色"。
    for (const role of ROLES) {
      const id = await mkPendingRelease('bug');
      const r = await call('POST', '/api/sys-issues/assign-release-dev', role.tok, { issue_ids: [id], release_assignee_id: 5 });
      assert.strictEqual(r.status, 409,
        `[M2/assign-release-dev·封禁契约] ${role.who} 期望 409（旧上线编排家族全封，2026-07-30 裁定）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED',
        `[M2/assign-release-dev·封禁契约] ${role.who} code 须为 LEGACY_RELEASE_FLOW_DISABLED, got ${JSON.stringify(r.body)}`);
      const row = await get('SELECT release_assignee_id FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(row.release_assignee_id, null,
        `[M2/assign-release-dev·封禁契约] ${role.who} 调用后 release_assignee_id 必须仍为空（任何角色·零副作用）`);
      m2Cells++;
    }
    // ⑤ 上线编排换人 reassign-release-dev（同④封禁契约）—— 前置的"已指定上线开发"改用 SQL 直写
    //    造夹具（assign-release-dev 端点本身已封，不能再靠调它来建立"已指定"前置态）。
    for (const role of ROLES) {
      const id = await mkPendingRelease('bug');
      await run(`UPDATE sys_issues SET release_assignee_id=5, release_assignee_name='开发王' WHERE id=?`, [id]);
      const r = await call('POST', '/api/sys-issues/reassign-release-dev', role.tok, { issue_ids: [id], release_assignee_id: 6, reason: '换人' });
      assert.strictEqual(r.status, 409,
        `[M2/reassign-release-dev·封禁契约] ${role.who} 期望 409（旧上线编排家族全封，2026-07-30 裁定）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED',
        `[M2/reassign-release-dev·封禁契约] ${role.who} code 须为 LEGACY_RELEASE_FLOW_DISABLED, got ${JSON.stringify(r.body)}`);
      const row = await get('SELECT release_assignee_id FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(Number(row.release_assignee_id), 5,
        `[M2/reassign-release-dev·封禁契约] ${role.who} 调用后必须仍是预指派的 dev5（任何角色·零副作用，未被换成 dev6）`);
      m2Cells++;
    }
    // [C6] close 由 2 类型扩为 3 类型（+bug），36→40 格。④⑤ 转封禁契约后格数不变（仍各 4 角色）。
    assert.strictEqual(m2Cells, 3 * 4 + 2 * 4 + 3 * 4 + 4 + 4, `[M2] 应跑满 40 格，实跑 ${m2Cells}（防再次出现 break 跳格）`);
    ok(`[M2] admin 专属族 ${m2Cells} 格（accept×3类型 / hold×2类型 / close×3类型[C6] 仍是"仅 admin 200/其余 403"专属族闸；assign-release-dev / reassign-release-dev 两格 2026-07-30 起转"旧上线编排家族封禁契约"——四角色一律 409 LEGACY_RELEASE_FLOW_DISABLED + 落库零副作用，各 4 角色·每格独立夹具）：专属族部分 admin 200 真落态、受理人(13)/示例发布者(7)/dev(5) 403 状态原样，证 C1 只放开协调人族未泛化为 admin 权；上线编排两格证封禁不分角色`);
  }

  // ═══ [M3] 通知三通道 × 三类型 × 四角色（C1 删除了「变更流仅 admin」特判）═══
  //   ⚠️ C1 复审 MED-3 重构：原实现三通道共用**开发态**夹具且正例只断言 `status!==403`。但 creator/requester 的
  //     可发状态白名单是「待验证/待上线/已上线」（sysNotifyStatusesFor），开发态调用**必然 409 STATUS_NOT_NOTIFIABLE**
  //     —— 36 格里 24 格正例其实一次都没真正走通授权后的发送路径，却因为"不是 403"全绿。
  //     现改为：developer 用开发态夹具、creator/requester 用**待验证**夹具，正例断言 **200 + 落库 notify_status='sent'**。
  {
    let m3Cells = 0;
    for (const type of TYPES) {
      for (const role of ROLES) {
        const allow = role.isAdmin || role.isIntake;
        // ① developer 通道（开发态·目标 dev6 避开自指守卫）
        {
          const id = await mkInDev(type);
          const add = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
          assert.strictEqual(add.status, 200, `[M3/developer] 夹具加协作开发 dev6 须 200, got ${add.status} ${JSON.stringify(add.body)}`);
          const r = await call('POST', `/api/sys-issues/${id}/notify-developer`, role.tok, { dev_user_id: 6 });
          if (allow) {
            assert.strictEqual(r.status, 200, `[M3/developer] ${role.who} × ${type} 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
            const row = await get('SELECT notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6 AND removed_at IS NULL', [id]);
            assert.strictEqual(row && row.notify_status, 'sent', `[M3/developer] ${role.who} × ${type} 须真落 notify_status='sent'（非仅状态码放行）`);
          } else {
            assert.strictEqual(r.status, 403, `[M3/developer] ${role.who} × ${type} 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
            // 负例无副作用（C1 三轮审 MED-4）：403 之后不得留下任何发送痕迹，否则"先写状态再拒绝"的顺序回归测不出来
            const row = await get('SELECT notify_status, notify_message_key FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6 AND removed_at IS NULL', [id]);
            assert.strictEqual(row && row.notify_status, 'not_sent', `[M3/developer] ${role.who} × ${type} 被拒后子表 notify_status 须仍为 not_sent`);
            assert.strictEqual(row.notify_message_key, null, `[M3/developer] ${role.who} × ${type} 被拒后不得留下 message_key`);
          }
          m3Cells++;
        }
        // ② creator 通道（须「待验证/待上线/已上线」态）
        //    self-guard **按人不按角色**：夹具单由 admin(1) 建，故 admin(1) 触发命中 self-guard 返 200 {skipped:true}；
        //    受理人触发是真发送。两者都算"授权通过"，但断言必须分开写死，否则又退化成"不是 403 就算过"。
        //    ⚠️ 另一个 admin 触发**不跳过、真发送**——见本组末尾的 [M3/多admin] 交叉用例。
        {
          const id = await mkVerifying(type);
          const r = await call('POST', `/api/sys-issues/${id}/notify-creator`, role.tok);
          if (role.isAdmin) {
            assert.strictEqual(r.status, 200, `[M3/creator] admin × ${type} 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body && r.body.skipped, true, `[M3/creator] admin 本人=建单人 → 须 self-guard 跳过（skipped:true）`);
            assert.strictEqual(r.body.code, 'SELF_NOTIFY_SKIPPED', '[M3/creator] admin 跳过码须为 SELF_NOTIFY_SKIPPED');
          } else if (allow) {
            assert.strictEqual(r.status, 200, `[M3/creator] ${role.who} × ${type} 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.creator_notify_status, 'sent', `[M3/creator] ${role.who} × ${type} 须真落 creator_notify_status='sent'`);
          } else {
            assert.strictEqual(r.status, 403, `[M3/creator] ${role.who} × ${type} 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
            const row = await get('SELECT creator_notify_status, creator_notify_message_key FROM sys_issues WHERE id=?', [id]);
            assert.strictEqual(row.creator_notify_status, 'not_sent', `[M3/creator] ${role.who} × ${type} 被拒后 creator_notify_status 须仍为 not_sent`);
            assert.strictEqual(row.creator_notify_message_key, null, `[M3/creator] ${role.who} × ${type} 被拒后不得留下 message_key`);
          }
          m3Cells++;
        }
        // ③ requester 通道（须「待验证/待上线/已上线」态 + 报障人手机号·建单夹具已带）
        {
          const id = await mkVerifying(type);
          const r = await call('POST', `/api/sys-issues/${id}/notify-requester`, role.tok);
          if (allow) {
            assert.strictEqual(r.status, 200, `[M3/requester] ${role.who} × ${type} 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.requester_notify_status, 'sent', `[M3/requester] ${role.who} × ${type} 须真落 requester_notify_status='sent'`);
          } else {
            assert.strictEqual(r.status, 403, `[M3/requester] ${role.who} × ${type} 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
            const row = await get('SELECT requester_notify_status, requester_notify_message_key, requester_notify_phone_snapshot FROM sys_issues WHERE id=?', [id]);
            assert.strictEqual(row.requester_notify_status, 'not_sent', `[M3/requester] ${role.who} × ${type} 被拒后 requester_notify_status 须仍为 not_sent`);
            assert.strictEqual(row.requester_notify_message_key, null, `[M3/requester] ${role.who} × ${type} 被拒后不得留下 message_key`);
            assert.strictEqual(row.requester_notify_phone_snapshot, null, `[M3/requester] ${role.who} × ${type} 被拒后不得落收件人快照`);
          }
          m3Cells++;
        }
      }
    }
    // ═══ [M3/多admin] ⭐ 两个 admin 互为"他人"：self-guard 按人不按角色 ═══
    //   生产实有 6 个 active admin。上面 creator 通道的 admin 格全部由 admin(1) 触发**自己建的单**，
    //   命中 self-guard 返 skipped —— 那条断言在只有一个 admin 的夹具下**永远成立、测不出东西**。
    //   这里补真正的交叉：admin(1) 建单 → **admin(2)** 触发 → 应**不跳过、真发送给建单人 admin(1)**。
    {
      const id = await mkVerifying('feature');
      const before = await get('SELECT created_by, creator_notify_status FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(Number(before.created_by), 1, '[M3/多admin] 夹具：单须由 admin(1) 建');
      assert.strictEqual(before.creator_notify_status, 'not_sent', '[M3/多admin] 夹具：初始 not_sent');

      // admin(1)＝建单人本人 → 跳过
      const self = await call('POST', `/api/sys-issues/${id}/notify-creator`, adminTok);
      assert.strictEqual(self.status, 200, '[M3/多admin] 建单人本人触发 200');
      assert.strictEqual(self.body.skipped, true, '[M3/多admin] 建单人本人触发须 skipped');
      assert.strictEqual((await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id])).creator_notify_status,
        'not_sent', '[M3/多admin] self-guard 跳过后不得落发送态');

      // admin(2)＝另一个 admin → **不跳过，真发送给 admin(1)**
      const cross = await call('POST', `/api/sys-issues/${id}/notify-creator`, admin2Tok);
      assert.strictEqual(cross.status, 200, `⭐ [M3/多admin] 另一 admin 触发应 200, got ${cross.status} ${JSON.stringify(cross.body)}`);
      assert.notStrictEqual(cross.body.skipped, true,
        '⭐ [M3/多admin] 另一 admin **不是**建单人，绝不能命中 self-guard（此前"admin 总被跳过"的注释即错在这里）');
      assert.strictEqual(cross.body.creator_notify_status, 'sent',
        '⭐ [M3/多admin] 另一 admin 触发须真发送给建单人（creator_notify_status=sent）');

      // 协调人族：另一 admin 对他人建的单同样有全权（T-M1「任意 admin 可代办」）——锁定该语义，
      //   免得日后有人以为 admin 权是绑 created_by 的。
      const id2 = await mkAssignable('feature');
      const a2 = await call('POST', `/api/sys-issues/${id2}/assign`, admin2Tok, { assigned_to: 5 });
      assert.strictEqual(a2.status, 200, '[M3/多admin] 另一 admin 可指派他人建的单（T-M1 任意 admin 可代办）');
      assert.strictEqual(Number((await get('SELECT assigned_to FROM sys_issues WHERE id=?', [id2])).assigned_to), 5,
        '[M3/多admin] 代办须真落库');
      ok('⭐ [M3/多admin] 两个 admin 互为"他人"：建单人本人触发 → self-guard skipped 且不落发送态；**另一 admin 触发 → 不跳过、真发送 sent**；另一 admin 可代办他人建单的指派并真落库（T-M1）—— 修掉"admin 总被跳过"这条只在单 admin 下成立的旧断言');
    }

    assert.strictEqual(m3Cells, 3 * 4 * 3, `[M3] 应跑满 36 格，实跑 ${m3Cells}`);
    ok(`[M3] 通知三通道 × 3 类型 × 4 角色 = ${m3Cells} 格：admin/受理人 **200 且真落 notify_status='sent'**（admin creator 走 self-guard skipped）、示例发布者/dev 403 —— 证「变更流仅 admin」特判已删、三通道全类型统一`);
  }

  // ═══ [M4] 查已读的**通道差异**（写读同源 + 死按钮防线）═══
  //   dev/creator/requester = admin ∨ 受理人；relay / release_executor = **仅 admin**。
  //   ⚠️ C1 复审 MED-3 重构：① 原实现漏了声称覆盖的 **dev 通道**；② 正例用 `notStrictEqual(403)`，
  //     而未发送过的通知必然停在 400 NOTIFY_NOT_SENT —— "不是 403" 无法区分"授权通过"与"别的原因没 403"。
  //     现在正例改为断言 **400 + code=NOTIFY_NOT_SENT**：该码位于授权闸**之后**，命中它就等价于"角色闸已放行"，
  //     且不会把任何 403 混进来。
  {
    const id = await mkInDev('bug');
    const add = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(add.status, 200, '[M4] 夹具加协作开发 dev6 须 200（dev 通道需在册行才走到授权后的业务闸）');
    const q = (ch) => ch === 'dev' ? 'type=dev&dev_user_id=6' : `type=${ch}`;
    const passedAuth = async (ch, tok, who) => {
      const r = await call('GET', `/api/sys-issues/${id}/notify-read-status?${q(ch)}`, tok);
      assert.strictEqual(r.status, 400, `[M4] ${who} 查 ${ch} 已读：授权应放行、停在业务闸（400），got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body && r.body.code, 'NOTIFY_NOT_SENT',
        `[M4] ${who} 查 ${ch} 已读须命中 NOTIFY_NOT_SENT（该码在授权闸之后，证明真过了闸，而非"碰巧不是 403"），got ${JSON.stringify(r.body)}`);
    };
    const denied = async (ch, tok, who) => {
      const r = await call('GET', `/api/sys-issues/${id}/notify-read-status?${q(ch)}`, tok);
      assert.strictEqual(r.status, 403, `[M4] ${who} 查 ${ch} 已读应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    };
    // ① dev / creator / requester：admin ∨ 受理人 放行；示例发布者 与 dev5 拒绝
    for (const ch of ['dev', 'creator', 'requester']) {
      await passedAuth(ch, adminTok, 'admin(1)');
      await passedAuth(ch, intakeTok, '示例对接人(13)');
      await denied(ch, techTok, '示例发布者(7)');
      await denied(ch, devTok, 'dev(5)');
    }
    // ② relay / release_executor：**仅 admin**（受理人也要挡——否则前端会给他画一个必然 403 的死按钮）
    for (const ch of ['relay', 'release_executor']) {
      await passedAuth(ch, adminTok, 'admin(1)');
      await denied(ch, intakeTok, '⭐示例对接人(13)');
      await denied(ch, techTok, '示例发布者(7)');
    }
    // ③ ⭐ 单据存在性预言机回归（C1 三轮审 MED-1 修的**安全性质本身**·四轮审 LOW：修了但没测住等于没修）
    //    未授权者对「真实存在的 id」与「不存在的 id」必须拿到**完全相同**的 403 + 相同 code；
    //    只要有一侧返 404，就又能靠状态码差异枚举出哪些单号真实存在。
    const ghostId = 999999;
    assert.strictEqual(Number((await get('SELECT COUNT(*) c FROM sys_issues WHERE id=?', [ghostId])).c), 0,
      '[M4] 夹具：ghostId 必须确实不存在，否则本组测的不是预言机');
    const oracleCases = [
      ['dev(5)', devTok, 'creator'], ['dev(5)', devTok, 'dev'],
      ['示例发布者(7)', techTok, 'requester'],
      ['示例对接人(13)', intakeTok, 'relay'], ['示例对接人(13)', intakeTok, 'release_executor'],
    ];
    for (const [who, tok, ch] of oracleCases) {
      const real = await call('GET', `/api/sys-issues/${id}/notify-read-status?${q(ch)}`, tok);
      const ghost = await call('GET', `/api/sys-issues/${ghostId}/notify-read-status?${q(ch)}`, tok);
      assert.strictEqual(real.status, 403, `[M4/预言机] ${who} × ${ch} 对存在单据须 403, got ${real.status}`);
      assert.strictEqual(ghost.status, 403,
        `⭐ [M4/预言机] ${who} × ${ch} 对**不存在**的 id 也须 403（若返 404 即可枚举真实单号）, got ${ghost.status} ${JSON.stringify(ghost.body)}`);
      assert.strictEqual(ghost.body && ghost.body.code, real.body && real.body.code,
        `⭐ [M4/预言机] ${who} × ${ch} 存在与不存在两侧 code 必须一致（实得 存在=${real.body && real.body.code} / 不存在=${ghost.body && ghost.body.code}）`);
    }
    ok('[M4] 查已读通道差异 5 通道 × 角色：dev/creator/requester = admin∨受理人放行（断言 400 NOTIFY_NOT_SENT 证真过闸）、示例发布者/dev5 403；relay 与 release_executor **仅 admin**，受理人 403；⭐ 并回归单据存在性预言机——未授权者对存在/不存在 id 拿到同一 403 同一 code');
  }

  // ═══ [M5] ⭐ 角色轴 × 开发轴正交性：示例发布者[7] 兼任开发后，仍不得取得任何协调人动作 ═══
  //   背景（方案 v1.5 §3 补充段·用户 2026-07-27 拍板）：C1 收走的是示例发布者的**协调人**权，不禁止他被指派为开发。
  //   codex C1 二轮审据此报过 HIGH，判为业务口径缺口；但"口径澄清"不等于"代码守得住"——本组把它测死：
  //     · 开发轴：被指派后 estimate / submit 应放行（ownerGuard='assignee' 本人门）
  //     · 协调人轴：assign / reassign / dev-assignees 加人 / excuse / 附件 / 三通知 一律仍 403（开发身份不得穿透）
  //     · 边界：DELETE dev-assignees **自移除**放行、**移除他人** 403（该端点授权=协调人 ∨ 本人，有意不挂中间件）
  {
    const type = 'feature';
    // 由 admin 把示例发布者[7] 指派为主开发 + 另加 dev5 为协作（供"移除他人"用例）
    const id = await mkAssignable(type);
    const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 7 });
    assert.strictEqual(asg.status, 200, `[M5] admin 指派 ${type} 给示例发布者(7) 须 200（角色不排斥开发身份）, got ${asg.status} ${JSON.stringify(asg.body)}`);
    assert.strictEqual(await statusOf(id), DEV_STATUS[type], '[M5] 指派后须真落开发态');
    const addDev5 = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(addDev5.status, 200, '[M5] admin 加协作开发 dev5 须 200');

    // ① 开发轴：示例发布者以 assignee 身份可 estimate（态内旁路动作）
    const est31 = futureEst(31);
    const est = await call('POST', `/api/sys-issues/${id}/estimate`, techTok, { dev_estimated_at: est31, estimated_effort_days: 1 });
    assert.strictEqual(est.status, 200, `[M5/开发轴] 示例发布者被指派后 estimate 应放行（ownerGuard=assignee）, got ${est.status} ${JSON.stringify(est.body)}`);
    // 时间格式统一 S3（D4）：库内到秒——提交分钟级 est31、后端补 ':00'
    assert.strictEqual((await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id])).dev_estimated_at, est31 + ':00',
      '[M5/开发轴] estimate 须真落 dev_estimated_at（证明确实以开发身份走通，而非被静默吞·D4 补秒到 HH:MM:00）');

    // ② 协调人轴：开发身份不得穿透成协调人权
    const otherRow = await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    const selfRow = await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=7 AND removed_at IS NULL', [id]);
    assert.ok(otherRow && selfRow, '[M5] 夹具：示例发布者与 dev5 须都在册');
    const coordCases = [
      ['assign',         () => call('POST', `/api/sys-issues/${id}/assign`, techTok, { assigned_to: 6 })],
      ['reassign',       () => call('POST', `/api/sys-issues/${id}/reassign`, techTok, { member_ids: [6], reason: '换人' })],
      ['dev-assignees',  () => call('POST', `/api/sys-issues/${id}/dev-assignees`, techTok, { user_ids: [6] })],
      ['excuse',         () => call('POST', `/api/sys-issues/${id}/dev-assignees/${otherRow.id}/excuse`, techTok, { reason: '开脱' })],
      ['supersede-excuse', () => call('POST', `/api/sys-issues/${id}/dev-assignees/${otherRow.id}/supersede-excuse`, techTok, { reason: '撤销开脱' })],
      ['移除他人',        () => call('DELETE', `/api/sys-issues/${id}/dev-assignees/${otherRow.id}`, techTok, { reason: '移除他人' })],
      ['notify-developer', () => call('POST', `/api/sys-issues/${id}/notify-developer`, techTok, { dev_user_id: 5 })],
      ['notify-creator',   () => call('POST', `/api/sys-issues/${id}/notify-creator`, techTok)],
      ['notify-requester', () => call('POST', `/api/sys-issues/${id}/notify-requester`, techTok)],
      ['附件spec',        () => upload(id, techTok, 'spec', 'm5.pdf')],
    ];
    for (const [label, fn] of coordCases) {
      const r = await fn();
      assert.strictEqual(r.status, 403,
        `⭐ [M5/协调人轴] 示例发布者(7) 已是本单开发，但 ${label} 仍须 403（开发身份不得穿透为协调人权）, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    // 协调人动作全被拒后，**四类落点**必须原样（只断言名单不足以发现"先写后拒"的顺序回归·C1 四轮审 MED-3）
    const roster = await all('SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY user_id', [id]);
    assert.deepStrictEqual(roster.map(x => Number(x.user_id)), [5, 7],
      '[M5/协调人轴] 全部被拒后在册名单须仍为 {dev5, 示例发布者7}');
    const m5Issue = await get(
      `SELECT assigned_to, creator_notify_status, creator_notify_message_key,
              requester_notify_status, requester_notify_message_key, requester_notify_phone_snapshot
         FROM sys_issues WHERE id=?`, [id]);
    assert.strictEqual(Number(m5Issue.assigned_to), 7, '[M5/协调人轴] assign/reassign 被拒后 assigned_to 须仍是示例发布者(7)');
    assert.strictEqual(m5Issue.creator_notify_status, 'not_sent', '[M5/协调人轴] notify-creator 被拒后不得留发送痕迹');
    assert.strictEqual(m5Issue.creator_notify_message_key, null, '[M5/协调人轴] notify-creator 被拒后不得留 message_key');
    assert.strictEqual(m5Issue.requester_notify_status, 'not_sent', '[M5/协调人轴] notify-requester 被拒后不得留发送痕迹');
    assert.strictEqual(m5Issue.requester_notify_phone_snapshot, null, '[M5/协调人轴] notify-requester 被拒后不得落收件人快照');
    // 开脱落点是 dev_status='excused'（+ resolved_at），无 excused_at 列——被拒后 dev5 须仍是 pending
    const m5Dev5 = await get('SELECT notify_status, dev_status, resolved_at FROM sys_issue_dev_assignees WHERE id=?', [otherRow.id]);
    assert.strictEqual(m5Dev5.notify_status, 'not_sent', '[M5/协调人轴] notify-developer 被拒后子表不得留发送痕迹');
    assert.strictEqual(m5Dev5.dev_status, 'pending', '[M5/协调人轴] excuse/supersede-excuse 被拒后 dev5 须仍 pending（未被开脱）');
    assert.strictEqual(m5Dev5.resolved_at, null, '[M5/协调人轴] excuse 被拒后不得写 resolved_at');
    const m5Att = await get(`SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?`, [id]);
    assert.strictEqual(Number(m5Att.c), 0, '[M5/协调人轴] 附件上传被拒后不得留附件行');

    // ②b 开发轴另一半：submit —— 用**独立单**测（提交会推进状态，与上面的协调人断言互相干扰）
    {
      const sid = await mkAssignable('improvement');
      const a2 = await call('POST', `/api/sys-issues/${sid}/assign`, adminTok, { assigned_to: 7 });
      assert.strictEqual(a2.status, 200, '[M5/开发轴] 夹具：admin 指派 improvement 给示例发布者(7) 须 200');
      const e2 = await call('POST', `/api/sys-issues/${sid}/estimate`, techTok, { dev_estimated_at: futureEst(32), estimated_effort_days: 1 });
      assert.strictEqual(e2.status, 200, `[M5/开发轴] 示例发布者 estimate 应放行, got ${e2.status} ${JSON.stringify(e2.body)}`);
      const s2 = await call('POST', `/api/sys-issues/${sid}/submit`, techTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-30' }], self_tested: true, test_env_deployed: true });
      assert.strictEqual(s2.status, 200, `⭐ [M5/开发轴] 示例发布者 submit 应放行（ownerGuard=assignee 本人门）, got ${s2.status} ${JSON.stringify(s2.body)}`);
      assert.strictEqual(await statusOf(sid), '待验证', '[M5/开发轴] 示例发布者提交后须真落「待验证」（证明确实走通提交链，非被静默吞）');
    }

    // ③ 边界：本人自移除放行（该端点授权 = 协调人 ∨ 本人；先加回 dev6 以免触发"最后一名开发"闸）
    const addDev6 = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(addDev6.status, 200, '[M5] 夹具：admin 加 dev6 须 200（避免自移除撞 LAST_ASSIGNEE 闸）');
    const selfRm = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${selfRow.id}`, techTok, { reason: '本人退出' });
    assert.strictEqual(selfRm.status, 200,
      `⭐ [M5/边界] 示例发布者自移除应放行（DELETE dev-assignees 授权=协调人∨本人·故有意不挂 requireIntakeLiaison）, got ${selfRm.status} ${JSON.stringify(selfRm.body)}`);
    assert.strictEqual((await get('SELECT removed_at FROM sys_issue_dev_assignees WHERE id=?', [selfRow.id])).removed_at !== null, true,
      '[M5/边界] 自移除须真落 removed_at');

    ok(`⭐ [M5] 角色轴 × 开发轴正交：示例发布者(7) 被指派为开发后 —— 开发轴 estimate + submit 均放行且真落库（提交后落「待验证」）；协调人轴 ${coordCases.length} 类动作（assign/reassign/加人/excuse/supersede-excuse/移除他人/三通知/附件）仍全 403，且名单·assigned_to·三侧通知字段·开脱态·附件行**全部原样**；边界：自移除放行（授权=协调人∨本人）—— 方案 v1.5 §3「兼任开发」口径被代码测住`);
  }

  // ═══ [V] 可见性：受理人对未指派的三类型必须列表可见 + 详情可开 ═══
  //   若缺这一层，C1 的"全类型指派权"就是空的——后端能指派、界面找不到单（写读不同源的功能断裂）。
  {
    const ids = {};
    for (const type of TYPES) ids[type] = await mkAssignable(type);   // 停在待指派/待处理·未指派任何人
    const list = await call('GET', '/api/sys-issues', intakeTok);
    assert.strictEqual(list.status, 200, '受理人列表 200');
    const listIds = (list.body.items || []).map(x => x.id);
    for (const type of TYPES) {
      assert.ok(listIds.includes(ids[type]), `⭐ [V] 受理人列表应含未指派的 ${type} 单 #${ids[type]}（否则"能指派却找不到单"）`);
      const d = await call('GET', `/api/sys-issues/${ids[type]}`, intakeTok);
      assert.strictEqual(d.status, 200, `⭐ [V] 受理人应能打开未指派的 ${type} 单详情, got ${d.status} ${JSON.stringify(d.body)}`);
    }
    // 对照：普通开发看不到未指派单（可见性没有被顺带放宽）
    const devList = await call('GET', '/api/sys-issues', dev2Tok);
    const devIds = (devList.body.items || []).map(x => x.id);
    for (const type of TYPES) {
      assert.ok(!devIds.includes(ids[type]), `[V] 对照：普通开发不应看到未指派的 ${type} 单（可见性未被顺带放宽）`);
    }
    ok('[V] 可见性写读同源：受理人对未指派的 bug/feature/improvement 列表可见 + 详情可开；普通开发仍看不到（放宽范围精确）');
  }

  // ═══ [G] sysManualNotifyGuard 未知通道 fail-closed ═══
  {
    const issue = { type: 'bug' };
    const actorIntake = { id: 13, role: 'user' };
    const r1 = I.sysManualNotifyGuard(issue, 'developer', actorIntake);
    assert.strictEqual(r1, null, '[G] 已知通道 developer + 受理人 → 放行');
    const r2 = I.sysManualNotifyGuard(issue, 'release_executor', actorIntake);
    assert.ok(r2 && r2.status === 400 && r2.body.code === 'MANUAL_NOTIFY_CHANNEL_UNKNOWN',
      `[G] ⭐ 未纳入白名单的通道必须 fail-closed 400（原实现会 fallthrough 放行受理人），实得 ${JSON.stringify(r2)}`);
    const r3 = I.sysManualNotifyGuard(issue, 'whatever_new_channel', actorIntake);
    assert.ok(r3 && r3.status === 400 && r3.body.code === 'MANUAL_NOTIFY_CHANNEL_UNKNOWN', '[G] 任意未知通道同样 400');
    ok('[G] 通知守卫 fail-closed：未知/未纳入白名单的通道一律 400 MANUAL_NOTIFY_CHANNEL_UNKNOWN（防未来加通道时静默放行）');
  }

  // ═══ [C4 合并修复批 275-M5] 真实 ⑦ 路径代表夹具：跑 [M2/accept] 同款角色矩阵代表断言（2 格即可）═══
  {
    const idAdmin = await mkVerifyingViaRealLiaisonTest();
    let r = await call('POST', `/api/sys-issues/${idAdmin}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[275-M5/accept] admin × feature（真实⑦路径）期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(idAdmin), '待上线', '[275-M5/accept] admin 验收后须真落「待上线」');

    const idDev = await mkVerifyingViaRealLiaisonTest();
    r = await call('POST', `/api/sys-issues/${idDev}/accept`, devTok, {});
    assert.strictEqual(r.status, 403, `[275-M5/accept] dev(5) × feature（真实⑦路径）期望 403（验收仅 admin）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(idDev), '待验证', '[275-M5/accept] dev 403 后状态须原样（仍待验证）');
    ok('[275-M5] 真实⑦路径代表夹具：submit→待对接测试→liaison-test-pass→待验证 全走真实链路（非 999999 降级）后，[M2/accept] 角色矩阵代表断言（admin 200/dev 403）仍成立（防真实⑦链路与角色权限矩阵交互回归被全 ⑥ 化的夹具集合掩盖）');
  }

  console.log(`\n✅ verify-sys-role-perm-c1 全部通过（${passed} 组·角色权限重构 C1 权限收敛）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
