// scripts/verify-sys-post-release-accept.js — 系统迭代·组 B「bug 先行上线」阶段三（SB3·补验收闭环）验收
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §3.3（补验收闭环+派生契约）+
//          §3.4 不变量⑥（pending ⇒ 禁 close/禁普通 derive）
//   用法：node scripts/verify-sys-post-release-accept.js
//
// 范围声明：本文件覆盖 SB3 全部后端新增面——姊妹文件 verify-sys-fastrelease-auth.js（§3.1 授权/撤销）、
//   verify-sys-fastlane-submit.js（§3.2 submit 直上）已各自覆盖各自阶段，均声明"§3.3 补验收是 SB3 范围，
//   本文件不覆盖"，故本文件是补验收闭环的唯一权威验收，与两姊妹文件正交不重复。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1] pass 正例：fastlane pending → post-release-accept(pass) → 200，post_release_acceptance='passed' +
//       post_accepted_at 落库；**accepted_at 不回填**（方案明文，独立字段）；status/release_id/
//       fast_release_consumed_at 不变（不是新一轮写点）；post_derive_issue_id 仍空；timeline 一条
//       post_release_accept_pass（summary 含 note）；不变量①②③⑦零违例。
//   [2] fail 正例：fastlane pending → post-release-accept(fail, note) → 200，post_release_acceptance=
//       'failed_derived' + post_derive_issue_id=新单 id；post_accepted_at 仍空；原单 status 不变（不因
//       不通过回退）；派生新单 type=bug/status=待受理/origin_issue_id=原单/derive_reason=note；原单
//       timeline 一条 post_release_accept_fail（ref_id=新单 id）；新单 timeline 恰 created+derive 两条
//       （与公开 /derive 端点产出的 timeline 形状逐字同构，证明共用同一份 insertDerivedSysIssue 核心）；
//       不变量①②③⑦零违例。
//   [2b]（B2·P8 用户拍板终裁）fail note 必填：缺失/纯空白 → 400 POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED
//       + 零副作用；超 500 字精确落既有 NOTE_TOO_LONG 码；恰 500 字边界放行；pass 分支不受影响（对照组）。
//   [3] 窗口负例（每条零副作用）：已是 passed 再次处理 → 409 POST_ACCEPTANCE_NOT_PENDING；非 fastlane 单
//       （online_source=NULL）→ 409；verdict 非法/缺失 → 400；note 超长 → 400；单据不存在 → 404；非
//       admin → 403。
//   [4] 不变量⑥·pending 禁 close：fastlane pending → POST /close → 409 POST_ACCEPTANCE_PENDING（零副作用，
//       closed_at 仍空）；pass 收口后 → POST /close → 200（passed 不再阻断）；对照组：failed_derived 同样
//       不阻断 close（仅 pending 一态拦截，非"fastlane 单恒拦"）。
//   [5] 不变量⑥·pending 禁普通 derive：fastlane pending 单作为 origin → POST /derive → 409
//       POST_ACCEPTANCE_PENDING（零副作用，不产生脏新单）；verdict 处理后（pass/failed_derived 任一终态）
//       → POST /derive 恢复可用（bug 类仍需 origin.status='已上线'，此前提天然满足）。
//   [6] derivePostReleaseAcceptDenyReason 精确文案直调（三分支：非 fastlane / 非 pending / 兜底）。
//   [7] 通知 no-op 断言：isAutoNotifyEnabled 恒 false → pass/fail 均不触发真实钉钉，creator_notify_status
//       停留初值 'not_sent'（结构就位但不可达，同组 A P2 既有登记范式）。
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const sysDeriveNumbering = require('../utils/sys-derive-numbering');   // [S12-b] RC-L2：直调真实 sysIssueDisplayNo，非拼字符串猜格式

const SECRET = 'verify-sys-post-release-accept-secret';
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
function fail(msg) { console.error('\n❌ verify-sys-post-release-accept 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `PRA-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-post-release-accept 夹具', intake_liaison_id: 13,
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function bugAtChulizhong() {
  const id = await mkIssue('bug');
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `[夹具-受理] 应 200，实得 ${acc.status} ${JSON.stringify(acc.body)}`);
  const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(asg.status, 200, `[夹具-指派] 应 200，实得 ${asg.status} ${JSON.stringify(asg.body)}`);
  return id;
}
async function estimateFuture(id, tok = devTok) {
  const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
  const r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: futureEst });
  assert.strictEqual(r.status, 200, `[estimate] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
async function authorize(id, tok = adminTok, note) {
  const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, tok, note ? { note } : {});
  assert.strictEqual(r.status, 200, `[授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
// [组B·S2 订正] 夹具原走真实链路"受理→指派→估时→授权→submit(direct_release=true)"到达 fastlane
//   pending 态——该 submit 分支已随两步化方案 §4-2「整体替代」拍板拆除（详见 verify-sys-fastlane-submit.js
//   头部 S2 语义翻转声明），真实链路已不可达。改为 SQL 造态直接构造终点状态：本文件测的是"补验收闭环"
//   （post-release-accept 端点及其下游 close/derive 联动），起点状态如何抵达（真实提交 vs 造态）与这条
//   下游链路本身的正确性无关——deriveOnlineSourceKind/post-release-accept 端点只读现值字段，不关心
//   历史成因。造态字段组与 verify-sys-fastlane-submit.js [8b]/[10] 两处同款夹具逐字段对齐（写读同源，
//   不在多个文件里各拼一份可能漂移的造态字段清单）。
async function bugAtFastlanePending() {
  const id = await bugAtChulizhong();
  await estimateFuture(id);
  await authorize(id, adminTok, '补验收探针-授权');
  await run(`UPDATE sys_issues SET status='已上线', released_at=datetime('now','localtime'),
    online_source='authorized_fastlane', post_release_acceptance='pending',
    fast_release_consumed_at=datetime('now','localtime') WHERE id=?`, [id]);
  const row = await issueRow(id);
  assert.strictEqual(row.status, '已上线', '[夹具-造态] status 应为「已上线」');
  assert.strictEqual(row.online_source, 'authorized_fastlane', '[夹具-造态] online_source 应为 authorized_fastlane');
  assert.strictEqual(row.post_release_acceptance, 'pending', '[夹具-造态] post_release_acceptance 应初值 pending');
  return id;
}

const issueRow = (id) => get(
  `SELECT id, type, status, released_at, online_source, post_release_acceptance, post_accepted_at,
          post_derive_issue_id, accepted_at, release_id, fast_release_consumed_at, closed_at,
          creator_notify_status, title, derive_reason, origin_issue_id,
          derive_root_id, derive_seq   -- [S12-b] 供 sysIssueDisplayNo 断言取号（timeline「已派生 #根_序」文案核对）
     FROM sys_issues WHERE id=?`, [id]);
const timelineRowsByCode = (id, actionCode) => all(
  `SELECT event_type, from_status, to_status, summary, action_code, ref_id, operator_id, operator_name
     FROM sys_issue_timeline WHERE issue_id=? AND action_code=? ORDER BY id`, [id, actionCode]);
const timelineRowsByEventType = (id, eventType) => all(
  `SELECT event_type, from_status, to_status, summary, action_code, ref_id FROM sys_issue_timeline
    WHERE issue_id=? AND event_type=? ORDER BY id`, [id, eventType]);
const timelineCount = (id) => get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]).then(r => Number(r.c));
const childCount = (originId) => get('SELECT COUNT(*) c FROM sys_issues WHERE origin_issue_id=?', [originId]).then(r => Number(r.c));

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

  // ══════════════════════════ [1] pass 正例 ══════════════════════════
  {
    const id = await bugAtFastlanePending();
    const beforeTl = await timelineCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass', note: '功能核实无误' });
    assert.strictEqual(r.status, 200, `[1] pass 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.post_release_acceptance, 'passed', '[1] 响应 post_release_acceptance 应为 passed');
    assert.ok(r.body.post_accepted_at, '[1] 响应应携带 post_accepted_at');
    assert.strictEqual(r.body.post_derive_issue_id, null, '[1] 响应 post_derive_issue_id 应仍为空');

    const after = await issueRow(id);
    assert.strictEqual(after.post_release_acceptance, 'passed', '[1] post_release_acceptance 应落 passed');
    assert.ok(after.post_accepted_at, '[1] post_accepted_at 应已落库');
    assert.strictEqual(after.accepted_at, null, '[1] accepted_at 不应被回填（方案明文：非常规验收，独立字段）');
    assert.strictEqual(after.status, '已上线', '[1] status 应保持「已上线」不变');
    assert.strictEqual(after.release_id, null, '[1] release_id 应保持空（不因补验收新挂批次关联）');
    assert.strictEqual(after.post_derive_issue_id, null, '[1] post_derive_issue_id 应仍为空');

    const tl = await timelineRowsByCode(id, 'post_release_accept_pass');
    assert.strictEqual(tl.length, 1, `[1] action_code=post_release_accept_pass 的 timeline 行恰 1 条，实得 ${tl.length}`);
    assert.strictEqual(tl[0].event_type, 'note', '[1] timeline event_type 应为 note');
    assert.ok(tl[0].summary.includes('补验收通过') && tl[0].summary.includes('功能核实无误'), `[1] summary 含结论与 note，实得="${tl[0].summary}"`);
    assert.ok((await timelineCount(id)) > beforeTl, '[1] timeline 应有新增');

    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(after), [], `[1] passed 后不变量①②③⑦应零违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(after))}`);
    ok('[1] pass 正例：post_release_acceptance=passed + post_accepted_at 落库 + accepted_at 不回填 + status/release_id 不变 + timeline 一条 + 不变量零违例');
  }

  // ══════════════════════════ [2] fail 正例 ══════════════════════════
  let failOriginId, failDeriveId;
  {
    const id = await bugAtFastlanePending();
    const beforeChild = await childCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'fail', note: '生产复现步骤未覆盖并发场景' });
    assert.strictEqual(r.status, 200, `[2] fail 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.post_release_acceptance, 'failed_derived', '[2] 响应 post_release_acceptance 应为 failed_derived');
    assert.ok(r.body.post_derive_issue_id, '[2] 响应应携带 post_derive_issue_id');
    assert.strictEqual(r.body.post_accepted_at, null, '[2] 响应 post_accepted_at 应仍为空');
    const newId = r.body.post_derive_issue_id;

    const after = await issueRow(id);
    assert.strictEqual(after.post_release_acceptance, 'failed_derived', '[2] post_release_acceptance 应落 failed_derived');
    assert.strictEqual(after.post_derive_issue_id, newId, '[2] post_derive_issue_id 应等于新单 id');
    assert.strictEqual(after.post_accepted_at, null, '[2] post_accepted_at 应仍为空');
    assert.strictEqual(after.status, '已上线', '[2] 原单 status 应保持「已上线」不变（不因不通过回退）');
    assert.strictEqual(await childCount(id), beforeChild + 1, '[2] 应恰新增 1 个派生子单');

    const child = await issueRow(newId);
    assert.strictEqual(child.type, 'bug', '[2] 派生单 type 应为 bug（fastlane 仅 bug 类）');
    assert.strictEqual(child.status, '待受理', '[2] 派生单落态应为「待受理」（创建路径唯一入口）');
    assert.strictEqual(child.origin_issue_id, id, '[2] 派生单 origin_issue_id 应指向原单');
    assert.ok(child.title.includes('先行上线补验收不通过'), `[2] 派生单标题应含来源标注，实得="${child.title}"`);
    assert.strictEqual(child.derive_reason, '生产复现步骤未覆盖并发场景', '[2] 派生单 derive_reason 应等于 note');

    const tlOrig = await timelineRowsByCode(id, 'post_release_accept_fail');
    assert.strictEqual(tlOrig.length, 1, `[2] 原单 action_code=post_release_accept_fail 的 timeline 行恰 1 条，实得 ${tlOrig.length}`);
    assert.strictEqual(tlOrig[0].ref_id, newId, '[2] 原单该行 ref_id 应指向派生单');
    // [S12-b] 该行文案由 sysIssueDisplayNo(newDeriveResult) 拼出「已派生 #根_序」（非旧版裸 #newId）——
    //   直调真实 helper 算出期望值（RC-L2 同源核对，非猜格式硬编码 `_1`）。
    const expectedChildDisplayNo = sysDeriveNumbering.sysIssueDisplayNo(child);
    assert.ok(tlOrig[0].summary.includes('已派生 ' + expectedChildDisplayNo), `[2] summary 含派生子编号 ${expectedChildDisplayNo}，实得="${tlOrig[0].summary}"`);

    // 派生内核复用证据：新单 timeline 恰 created+derive 两条，与公开 /derive 端点产出形状逐字同构
    // （insertDerivedSysIssue 是唯一实现，两条调用路径共用同一份写入逻辑）。
    const childCreated = await timelineRowsByEventType(newId, 'created');
    const childDerive = await timelineRowsByEventType(newId, 'derive');
    assert.strictEqual(childCreated.length, 1, '[2] 派生单应恰 1 条 created timeline');
    assert.strictEqual(childCreated[0].to_status, '待受理', '[2] created 行 to_status 应为待受理');
    assert.strictEqual(childCreated[0].summary, `派生自 #${id}`, '[2] created 行 summary 应为「派生自 #原单id」（与公开 /derive 端点逐字同构）');
    assert.strictEqual(childDerive.length, 1, '[2] 派生单应恰 1 条 derive timeline');
    assert.strictEqual(childDerive[0].ref_id, id, '[2] derive 行 ref_id 应指向原单');
    assert.strictEqual(childDerive[0].summary, '生产复现步骤未覆盖并发场景', '[2] derive 行 summary 应等于 note（与公开 /derive 端点 derive_reason 落 summary 逐字同构）');
    assert.strictEqual((await all('SELECT id FROM sys_issue_timeline WHERE issue_id=?', [newId])).length, 2, '[2] 派生单 timeline 应恰 2 行（created+derive，无多余写入）');

    assert.deepStrictEqual(I.fastlaneAcceptanceInvariantViolations(after), [], `[2] failed_derived 后原单不变量①②③⑦应零违例，实得 ${JSON.stringify(I.fastlaneAcceptanceInvariantViolations(after))}`);
    failOriginId = id; failDeriveId = newId;
    ok('[2] fail 正例：post_release_acceptance=failed_derived + post_derive_issue_id 落库 + 原单 status 不回退 + 派生新单（bug/待受理/继承来源）+ 两侧 timeline 形状与公开 /derive 端点同构（派生内核复用证据）+ 不变量零违例');
  }

  // ══════════════════════════ [2b]（B2·P8 用户拍板 2026-08-13 终裁）fail note 必填 ══════════════════════════
  //   背景变更：codex 363 号 L1 曾登记"fail 无 note 时回落可读默认文案，选填口径待 P8 裁定"——P8 现已
  //   终裁改为**必填**（trim 后长度须 1..500），本组取代旧版"[2b] fail 无 note：默认 derive_reason
  //   非空"（该场景经本端点已结构性不可达，见 index.js post-release-accept 端点内 P8 注释——保留的
  //   default 文案分支是安全网非当前可达路径，不再需要专门经 HTTP 测它）。
  {
    // 缺失 note 键
    const idMissing = await bugAtFastlanePending();
    const rMissing = await call('POST', `/api/sys-issues/${idMissing}/post-release-accept`, adminTok, { verdict: 'fail' });
    assert.strictEqual(rMissing.status, 400, `[2b-缺失] fail 缺 note 应 400，实得 ${rMissing.status} ${JSON.stringify(rMissing.body)}`);
    assert.strictEqual(rMissing.body.code, 'POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED', `[2b-缺失] 确切码，实得 ${rMissing.body.code}`);
    assert.strictEqual((await issueRow(idMissing)).post_release_acceptance, 'pending', '[2b-缺失] 零副作用（仍 pending）');
    assert.strictEqual(await childCount(idMissing), 0, '[2b-缺失] 零副作用（未产生派生子单）');

    // 纯空白 note（trim 后为空）
    const idBlank = await bugAtFastlanePending();
    const rBlank = await call('POST', `/api/sys-issues/${idBlank}/post-release-accept`, adminTok, { verdict: 'fail', note: '   ' });
    assert.strictEqual(rBlank.status, 400, `[2b-空白] fail 纯空白 note 应 400，实得 ${rBlank.status}`);
    assert.strictEqual(rBlank.body.code, 'POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED', `[2b-空白] 确切码，实得 ${rBlank.body.code}`);
    assert.strictEqual((await issueRow(idBlank)).post_release_acceptance, 'pending', '[2b-空白] 零副作用（仍 pending）');

    // 超 500 字（既有上限检查先命中，精确到 NOTE_TOO_LONG 而非 FAIL_NOTE_REQUIRED——两码分工不重叠）
    const idOver = await bugAtFastlanePending();
    const rOver = await call('POST', `/api/sys-issues/${idOver}/post-release-accept`, adminTok, { verdict: 'fail', note: 'x'.repeat(501) });
    assert.strictEqual(rOver.status, 400, `[2b-超长] fail note 超 500 字应 400，实得 ${rOver.status}`);
    assert.strictEqual(rOver.body.code, 'POST_RELEASE_ACCEPT_NOTE_TOO_LONG', `[2b-超长] 应精确到既有 NOTE_TOO_LONG 码（非 FAIL_NOTE_REQUIRED），实得 ${rOver.body.code}`);
    assert.strictEqual((await issueRow(idOver)).post_release_acceptance, 'pending', '[2b-超长] 零副作用（仍 pending）');

    // 对照组①：恰 500 字放行（边界不误伤）
    const idExact = await bugAtFastlanePending();
    const rExact = await call('POST', `/api/sys-issues/${idExact}/post-release-accept`, adminTok, { verdict: 'fail', note: 'y'.repeat(500) });
    assert.strictEqual(rExact.status, 200, `[2b-边界] fail note 恰 500 字应放行，实得 ${rExact.status} ${JSON.stringify(rExact.body)}`);
    const childExact = await issueRow(rExact.body.post_derive_issue_id);
    assert.strictEqual(childExact.derive_reason, 'y'.repeat(500), '[2b-边界] derive_reason 应等于恰 500 字的 note（原样落库，非默认文案）');

    // 对照组②：pass 分支不受本闸影响——沿用既有选填口径，无 note 依旧 200
    const idPassNoNote = await bugAtFastlanePending();
    const rPassNoNote = await call('POST', `/api/sys-issues/${idPassNoNote}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(rPassNoNote.status, 200, `[2b-对照-pass] pass 分支缺 note 应仍 200（P8 只收紧 fail，不动 pass），实得 ${rPassNoNote.status} ${JSON.stringify(rPassNoNote.body)}`);

    ok('[2b] fail note 必填（P8 终裁）：缺失/纯空白 → 400 POST_RELEASE_ACCEPT_FAIL_NOTE_REQUIRED + 零副作用；超 500 字精确落既有 NOTE_TOO_LONG 码；恰 500 字边界放行且原样落库为 derive_reason；pass 分支不受影响（对照组）');
  }

  // ══════════════════════════ [3] 窗口负例族（每条零副作用）══════════════════════════
  {
    // [3a] 已是 passed → 再次处理 409（幂等窗口关闭）
    const id = await bugAtFastlanePending();
    const first = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(first.status, 200, '[3a-前置] 首次 pass 应成功');
    const beforeTl = await timelineCount(id);
    const second = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(second.status, 409, `[3a] 已是 passed 再次处理应 409，实得 ${second.status} ${JSON.stringify(second.body)}`);
    assert.strictEqual(second.body.code, 'POST_ACCEPTANCE_NOT_PENDING', `[3a] 确切码，实得 ${second.body.code}`);
    assert.ok(second.body.error.includes('不可再次处理'), `[3a] 精确原因文案，实得="${second.body.error}"`);
    assert.strictEqual(await timelineCount(id), beforeTl, '[3a] 拒绝请求应零副作用（timeline 不增）');
    ok('[3a] 窗口负例：已是 passed 再次处理 → 409 POST_ACCEPTANCE_NOT_PENDING + 零副作用');

    // [3b] 非 fastlane 单（online_source 为空）→ 409
    const normalId = await bugAtChulizhong();
    const r3b = await call('POST', `/api/sys-issues/${normalId}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(r3b.status, 409, `[3b] 非 fastlane 单应 409，实得 ${r3b.status} ${JSON.stringify(r3b.body)}`);
    assert.strictEqual(r3b.body.code, 'POST_ACCEPTANCE_NOT_PENDING', `[3b] 确切码，实得 ${r3b.body.code}`);
    assert.ok(r3b.body.error.includes('不是先行上线单'), `[3b] 精确原因文案，实得="${r3b.body.error}"`);
    ok('[3b] 窗口负例：非 fastlane 单（online_source 为空）→ 409 POST_ACCEPTANCE_NOT_PENDING「不是先行上线单」');

    // [3c] verdict 非法/缺失 → 400
    const id3c = await bugAtFastlanePending();
    const rMissing = await call('POST', `/api/sys-issues/${id3c}/post-release-accept`, adminTok, {});
    assert.strictEqual(rMissing.status, 400, `[3c-缺失] 应 400，实得 ${rMissing.status}`);
    assert.strictEqual(rMissing.body.code, 'POST_RELEASE_ACCEPT_VERDICT_INVALID', `[3c-缺失] 确切码，实得 ${rMissing.body.code}`);
    const rBad = await call('POST', `/api/sys-issues/${id3c}/post-release-accept`, adminTok, { verdict: 'maybe' });
    assert.strictEqual(rBad.status, 400, `[3c-非法值] 应 400，实得 ${rBad.status}`);
    assert.strictEqual(rBad.body.code, 'POST_RELEASE_ACCEPT_VERDICT_INVALID', `[3c-非法值] 确切码，实得 ${rBad.body.code}`);
    assert.strictEqual((await issueRow(id3c)).post_release_acceptance, 'pending', '[3c] 拒绝请求应零副作用（仍 pending）');
    ok('[3c] 窗口负例：verdict 缺失/非法值 → 400 POST_RELEASE_ACCEPT_VERDICT_INVALID + 零副作用');

    // [3d] note 超长 → 400
    const id3d = await bugAtFastlanePending();
    const rLong = await call('POST', `/api/sys-issues/${id3d}/post-release-accept`, adminTok, { verdict: 'pass', note: 'x'.repeat(501) });
    assert.strictEqual(rLong.status, 400, `[3d] note 超长应 400，实得 ${rLong.status}`);
    assert.strictEqual(rLong.body.code, 'POST_RELEASE_ACCEPT_NOTE_TOO_LONG', `[3d] 确切码，实得 ${rLong.body.code}`);
    assert.strictEqual((await issueRow(id3d)).post_release_acceptance, 'pending', '[3d] 拒绝请求应零副作用（仍 pending）');
    ok('[3d] 窗口负例：note 超 500 字 → 400 POST_RELEASE_ACCEPT_NOTE_TOO_LONG + 零副作用');

    // [3e] 单据不存在 → 404
    const r3e = await call('POST', `/api/sys-issues/999999/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(r3e.status, 404, `[3e] 应 404，实得 ${r3e.status}`);
    ok('[3e] 窗口负例：单据不存在 → 404 SYS_ISSUE_NOT_FOUND');

    // [3f] 非 admin → 403（requireAdmin 中间件粗筛，权限负例）
    const id3f = await bugAtFastlanePending();
    const r3f = await call('POST', `/api/sys-issues/${id3f}/post-release-accept`, devTok, { verdict: 'pass' });
    assert.strictEqual(r3f.status, 403, `[3f] 非 admin 应 403，实得 ${r3f.status}`);
    assert.strictEqual((await issueRow(id3f)).post_release_acceptance, 'pending', '[3f] 拒绝请求应零副作用（仍 pending）');
    ok('[3f] 权限负例：非 admin 调用 → 403 + 零副作用');
  }

  // ══════════════════════════ [4] 不变量⑥·pending 禁 close ══════════════════════════
  {
    const id = await bugAtFastlanePending();
    const r = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(r.status, 409, `[4a] pending 态 close 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'POST_ACCEPTANCE_PENDING', `[4a] 确切码，实得 ${r.body.code}`);
    assert.strictEqual((await issueRow(id)).closed_at, null, '[4a] 拒绝请求应零副作用（closed_at 仍空）');
    ok('[4a] 不变量⑥：pending 补验收态禁止 close → 409 POST_ACCEPTANCE_PENDING + 零副作用');

    // pass 收口后 close 应恢复可用（passed 不阻断）
    const pass = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(pass.status, 200, '[4b-前置] pass 应成功');
    const rClose = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(rClose.status, 200, `[4b] passed 后 close 应恢复 200，实得 ${rClose.status} ${JSON.stringify(rClose.body)}`);
    assert.ok((await issueRow(id)).closed_at, '[4b] closed_at 应已落库');
    ok('[4b] 对照：post_release_acceptance 转为 passed 后 close 恢复可用（仅 pending 一态拦截，非"fastlane 单恒拦"）');

    // 对照组②：failed_derived 同样不阻断 close
    const idFail = await bugAtFastlanePending();
    // [B2·P8] fail 现必填 note——本组测的是"close 是否被 failed_derived 阻断"，与 note 必填闸正交，
    //   补一个合法 note 避免被上游闸门先一步拒绝而拿不到 failed_derived 终态。
    const failR = await call('POST', `/api/sys-issues/${idFail}/post-release-accept`, adminTok, { verdict: 'fail', note: '[4c] close 不阻断对照组' });
    assert.strictEqual(failR.status, 200, '[4c-前置] fail 应成功');
    const rClose2 = await call('POST', `/api/sys-issues/${idFail}/close`, adminTok, {});
    assert.strictEqual(rClose2.status, 200, `[4c] failed_derived 后 close 应可用，实得 ${rClose2.status} ${JSON.stringify(rClose2.body)}`);
    ok('[4c] 对照：post_release_acceptance 转为 failed_derived 后 close 同样可用（两个补验收终态都不阻断关闭）');
  }

  // ══════════════════════════ [5] 不变量⑥·pending 禁普通 derive ══════════════════════════
  {
    const id = await bugAtFastlanePending();
    const beforeChild = await childCount(id);
    const r = await call('POST', `/api/sys-issues/${id}/derive`, adminTok,
      { type: 'bug', title: '普通派生尝试', system_name: 'BMS', source: '内部', derive_reason: '不应成功' });
    assert.strictEqual(r.status, 409, `[5a] pending 态普通 derive 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'POST_ACCEPTANCE_PENDING', `[5a] 确切码，实得 ${r.body.code}`);
    assert.strictEqual(await childCount(id), beforeChild, '[5a] 拒绝请求应零副作用（未产生脏新单）');
    ok('[5a] 不变量⑥：pending 补验收态禁止普通 derive（走公开端点会绕过 failed_derived 语义）→ 409 POST_ACCEPTANCE_PENDING + 零副作用');

    // 终态后 derive 恢复可用（origin.status 仍是「已上线」，天然满足 bug 派生前置）
    const pass = await call('POST', `/api/sys-issues/${id}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(pass.status, 200, '[5b-前置] pass 应成功');
    const rDerive = await call('POST', `/api/sys-issues/${id}/derive`, adminTok,
      { type: 'bug', title: '正常派生', system_name: 'BMS', source: '内部', derive_reason: '补验收通过后正常派生' });
    assert.strictEqual(rDerive.status, 201, `[5b] passed 后普通 derive 应恢复 201，实得 ${rDerive.status} ${JSON.stringify(rDerive.body)}`);
    ok('[5b] 对照：post_release_acceptance 转为 passed 后普通 derive 恢复可用');
  }

  // ══════════════════════════ [6] derivePostReleaseAcceptDenyReason 精确文案直调 ══════════════════════════
  {
    assert.strictEqual(I.derivePostReleaseAcceptDenyReason(null), '迭代单不存在', '[6a] null 行应返回"迭代单不存在"');
    assert.strictEqual(
      I.derivePostReleaseAcceptDenyReason({ online_source: null, post_release_acceptance: null }),
      '该单不是先行上线单，无补验收流程', '[6b] 非 fastlane 单精确文案');
    assert.strictEqual(
      I.derivePostReleaseAcceptDenyReason({ online_source: I.ONLINE_SOURCE_AUTHORIZED_FASTLANE, post_release_acceptance: 'passed' }),
      '补验收状态「passed」不可再次处理（仅待补验收可处理）', '[6c] 非 pending 精确文案（含现值）');
    ok('[6] derivePostReleaseAcceptDenyReason 三分支精确文案直调通过（null 行/非 fastlane/非 pending）');
  }

  // ══════════════════════════ [7] 通知 no-op 断言（isAutoNotifyEnabled 恒 false）══════════════════════════
  {
    const idPass = await bugAtFastlanePending();
    const before = await issueRow(idPass);
    assert.strictEqual(before.creator_notify_status, 'not_sent', '[7-前置] 建单人通知态初值应为 not_sent');
    const rPass = await call('POST', `/api/sys-issues/${idPass}/post-release-accept`, adminTok, { verdict: 'pass' });
    assert.strictEqual(rPass.status, 200, '[7-pass] 应成功');
    const afterPass = await issueRow(idPass);
    assert.strictEqual(afterPass.creator_notify_status, 'not_sent', '[7-pass] pass 分支通知总闸关闭 → creator_notify_status 应保持 not_sent（结构就位但不可达，同组 A P2 既有登记）');

    const idFail = await bugAtFastlanePending();
    // [B2·P8] fail 现必填 note——本组测的是通知总闸 no-op，与 note 必填闸正交，补一个合法 note。
    const rFail = await call('POST', `/api/sys-issues/${idFail}/post-release-accept`, adminTok, { verdict: 'fail', note: '[7] 通知 no-op 对照组' });
    assert.strictEqual(rFail.status, 200, '[7-fail] 应成功');
    const afterFail = await issueRow(idFail);
    assert.strictEqual(afterFail.creator_notify_status, 'not_sent', '[7-fail] fail 分支同样通知总闸关闭 → creator_notify_status 应保持 not_sent');

    // [codex 382 预筛 L8 收口·[7-direct] 组删除，取舍如实登记] 原第三条断言（[7-direct]）已删除，不是
    //   静默丢弃：其历史沿革是"原第三条断言的对象是 submit direct_release 成功分支触发的
    //   notifyFastReleasePendingToCreator marker，该 marker 唯一调用点已随拆直上分支删除，遂改为验证
    //   'SQL 造态构造 fastlane pending 态不经过任何通知调用点，creator_notify_status 天然保持 not_sent'"
    //   ——但这条改写后的断言是**近恒真断言**：它只调用 bugAtFastlanePending()（纯 SQL UPDATE 造态）
    //   后立即读值，全程未调用 post-release-accept 端点，测的是"没执行任何代码时字段没变"，这在
    //   bugAtFastlanePending() 自身实现（只 UPDATE released_at/online_source/post_release_acceptance/
    //   fast_release_consumed_at 四列，从不触碰 creator_notify_status）已结构性保证为真，不需要运行时
    //   断言去发现"造态本身不发通知"这件事——它测不出任何生产代码回归（唯一能让它变红的是有人往
    //   bugAtFastlanePending() 这个测试夹具函数本身里错误地加一行 dispatchSysNotify 调用，那是测试代码
    //   自身的假设改变，不是生产端点行为改变）。与其保留一条不测生产代码的断言制造虚假覆盖感，改为
    //   删除更干净：[7-pass]/[7-fail] 已经用同一个 bugAtFastlanePending() 造态 + **真实调用**
    //   post-release-accept 端点，穷尽了该端点仅有的两个 verdict 分支（不存在第三个"direct"分支），
    //   是本组真正对生产代码的覆盖来源；"direct-submit 通知路径已彻底不存在"这一结论已由 codex 382
    //   修复批的 dispatchSysNotify switch-case 删除 + grep 归零证明覆盖（见该批交付报告），无需在本文件
    //   重复用近恒真断言再证一次。
    ok('[7] 通知 no-op 断言：isAutoNotifyEnabled 恒 false → post-release-accept pass/fail 两分支（穷尽该端点全部 verdict）不触发真实钉钉');
  }

  // ══════════════════════════ [8]（追加批·codex 363 号 M2）48h 圈红判据后端化 ══════════════════════════
  //   isPostReleaseAcceptOverdue 直调（纯函数用例表）+ 真实链路 HTTP 层交叉核对（列表/详情两端点均须
  //   下发 post_release_accept_overdue 字段，与直调判据结果一致）。
  {
    // [8a] 纯函数用例表：4 正例（true/false 各按门控维度成对）
    const baseRow = { online_source: 'authorized_fastlane', post_release_acceptance: 'pending', released_at: null };
    assert.strictEqual(I.isPostReleaseAcceptOverdue(null), false, '[8a] null 行应返回 false（fail-closed 兜底）');
    assert.strictEqual(
      I.isPostReleaseAcceptOverdue({ ...baseRow, released_at: '2000-01-01 00:00:00' }),
      true, '[8a] released_at 远早于 48h 前应判 true（超时）');
    // 对照：released_at 是 5 分钟前 → 未超 48h → false
    const almostNow = (() => { const d = new Date(Date.now() - 5 * 60000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
    assert.strictEqual(
      I.isPostReleaseAcceptOverdue({ ...baseRow, released_at: almostNow }),
      false, '[8a] ★对照组：released_at 是 5 分钟前（远未超 48h）应判 false——证明判据不是恒真');
    // 边界：恰好 47h59m 前 → false；恰好 48h1m 前 → true（跨边界成对，同项目「不变量探针必须双向证明」惯例）
    const just47h59m = (() => { const d = new Date(Date.now() - (48 * 3600000 - 60000)); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
    const just48h01m = (() => { const d = new Date(Date.now() - (48 * 3600000 + 60000)); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
    assert.strictEqual(I.isPostReleaseAcceptOverdue({ ...baseRow, released_at: just47h59m }), false, '[8a] 边界·47h59m 前应判 false（未超）');
    assert.strictEqual(I.isPostReleaseAcceptOverdue({ ...baseRow, released_at: just48h01m }), true, '[8a] 边界·48h01m 前应判 true（已超，与上一条成对跨越 48h 边界）');
    // 门控负例：非 fastlane / 非 pending / released_at 为空——即便"时间上"早已超 48h 也应 false（门控优先于时间判据）
    assert.strictEqual(I.isPostReleaseAcceptOverdue({ online_source: null, post_release_acceptance: 'pending', released_at: '2000-01-01 00:00:00' }), false, '[8a] 非 fastlane 单即便 released_at 很早也应 false（来源门控优先）');
    assert.strictEqual(I.isPostReleaseAcceptOverdue({ online_source: 'authorized_fastlane', post_release_acceptance: 'passed', released_at: '2000-01-01 00:00:00' }), false, '[8a] passed 态（非 pending）即便 released_at 很早也应 false（状态门控优先）');
    assert.strictEqual(I.isPostReleaseAcceptOverdue({ ...baseRow, released_at: null }), false, '[8a] released_at 为空应 false（无起算点）');
    ok('[8a] isPostReleaseAcceptOverdue 纯函数用例表：null 行/来源门控/状态门控/空 released_at 四类负例 + 远期超时正例 + 47h59m/48h01m 成对边界 + 5 分钟前对照组，均正确');
  }

  {
    // [8b] 真实链路：造一个 pending fastlane 单，SQL 回拨 released_at 到 49 小时前，断言列表/详情两端点
    //   均正确下发 post_release_accept_overdue=true；对照组（released_at 保持当前）应为 false。两端点
    //   须与 I.isPostReleaseAcceptOverdue 直调结果一致（读点不分裂）。
    const idOverdue = await bugAtFastlanePending();
    await run(`UPDATE sys_issues SET released_at = datetime('now','localtime','-49 hours') WHERE id = ?`, [idOverdue]);
    const idFresh = await bugAtFastlanePending();   // 对照组：released_at 保持刚落库的当前值

    const listRes = await call('GET', '/api/sys-issues?type=bug', adminTok);
    assert.strictEqual(listRes.status, 200, `[8b-列表] 应 200，实得 ${listRes.status}`);
    const listItems = (listRes.body && listRes.body.items) || [];
    const listOverdueRow = listItems.find(it => it.id === idOverdue);
    const listFreshRow = listItems.find(it => it.id === idFresh);
    assert.ok(listOverdueRow, `[8b-列表] 应能在列表响应中找到超时单 #${idOverdue}`);
    assert.ok(listFreshRow, `[8b-列表] 应能在列表响应中找到对照单 #${idFresh}`);
    assert.strictEqual(listOverdueRow.post_release_accept_overdue, true, `[8b-列表] 超时单 post_release_accept_overdue 应为 true，实得 ${JSON.stringify(listOverdueRow.post_release_accept_overdue)}`);
    assert.strictEqual(listFreshRow.post_release_accept_overdue, false, `[8b-列表] ★对照组：未超时单 post_release_accept_overdue 应为 false，实得 ${JSON.stringify(listFreshRow.post_release_accept_overdue)}`);

    const detOverdue = await call('GET', `/api/sys-issues/${idOverdue}`, adminTok);
    const detFresh = await call('GET', `/api/sys-issues/${idFresh}`, adminTok);
    assert.strictEqual(detOverdue.status, 200, '[8b-详情] 超时单应 200');
    assert.strictEqual(detFresh.status, 200, '[8b-详情] 对照单应 200');
    // ⚠️ 详情端点响应体形状是 { issue: row, timeline, ... }（嵌套，非扁平——见 index.js:7009 res.json 行），
    //   与列表端点 { items: rows, ... } 的行内联平铺不同，字段须从 .body.issue 下取，不能对齐列表端点的取法。
    assert.strictEqual(detOverdue.body.issue.post_release_accept_overdue, true, `[8b-详情] 超时单 post_release_accept_overdue 应为 true，实得 ${JSON.stringify(detOverdue.body.issue.post_release_accept_overdue)}`);
    assert.strictEqual(detFresh.body.issue.post_release_accept_overdue, false, `[8b-详情] ★对照组：未超时单 post_release_accept_overdue 应为 false，实得 ${JSON.stringify(detFresh.body.issue.post_release_accept_overdue)}`);

    // 读点不分裂：详情端点结果与 I.isPostReleaseAcceptOverdue 直调同一行数据的结果一致
    const rawOverdueRow = await issueRow(idOverdue);
    assert.strictEqual(detOverdue.body.issue.post_release_accept_overdue, I.isPostReleaseAcceptOverdue(rawOverdueRow), '[8b] 详情端点下发值应与 I.isPostReleaseAcceptOverdue 直调同一行数据的结果逐字一致（列表/详情/直调三者同一份判据）');

    ok('[8b] 真实链路：列表+详情两端点均正确下发 post_release_accept_overdue（超时单 true / 未超时对照单 false），且与 isPostReleaseAcceptOverdue 直调结果一致（读点不分裂）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ verify-sys-post-release-accept 全绿`);
  console.log('  覆盖：pass/fail 双正例（原子字段+timeline+派生内核复用证据+不变量零违例）+ [B2·P8终裁] fail note 必填（缺失/纯空白400+超长精确落既有码+恰500边界+pass对照组不受影响）+ 窗口负例族(重复处理/非fastlane/verdict非法/note超长/404/403) + 不变量⑥(pending禁close/禁普通derive，含 passed/failed_derived 两终态对照组恢复可用) + 精确文案直调 + 通知 no-op 断言 + [追加批 M2] 48h 圈红后端判据(纯函数用例表+成对边界+真实链路列表/详情两端点交叉核对)');
  server.close();
}

main().catch((e) => { fail(e && e.stack ? e.stack : String(e)); });
