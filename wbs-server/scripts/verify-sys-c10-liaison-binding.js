// 验证脚本：C10 对接人绑单精判（方案 v1.7 §10.2 · 权限核心）
//   用法：node scripts/verify-sys-c10-liaison-binding.js
//
// C10 四裁定落地的回归网：
//   裁定1 候选判据 isIntakeLiaisonEligible = active ∧ role∈{user,publisher}（allowlist·废止白名单[13]）
//   裁定2 绑单精判：单据动作仅 admin ∨ 该单 intake_liaison_id 本人（NOT_BOUND_LIAISON 403）；存量空单
//         （intake_liaison_id NULL）受理时 CAS 绑自己（WHERE intake_liaison_id IS NULL ∧ changes===1 抢一）
//   裁定3 cancel-schedule/requireLiaisonOnly：**C10-fix M1 收回窄集合[13]**（release/roster 级授权不随候选池扩大·admin 排除保持）
//   裁定4 通知路由收件人=该单 intake_liaison_id
//
// 覆盖组（六负例 + 正例流 + 白名单废止正/负）：
//   [1] 白名单废止：旧池外 user(5)/publisher(7) 可被选为对接人 + 可受理空单；viewer/admin 不可选（INVALID_INTAKE_LIAISON）
//   [2] ⭐ 空单 CAS 抢一：两 eligible 同时受理同一存量空单 → 一成一 409（绑定唯一·矛盾态不出现）
//   [3] A 受理后 B 再受理 → 409（已离开待受理·前置态 CAS）
//   [4] 空单准入：ineligible(viewer) 受理空单 → 403；已绑单被非绑定 eligible 受理 → 403
//   [4b] ⭐ C10-fix2 MED-1：admin 代办受理空单 → 200 状态推进但 intake_liaison_id 保持 NULL（不绑成 admin id=1）
//   [5] ⭐ 换对接人后旧对接人操作（assign）→ 403 NOT_BOUND_LIAISON；新对接人 → 200
//   [6] ⭐ admin 与对接人同时操作 → 一成一 409（状态 CAS）
//   [7] 通知路由（notify-developer）绑单精判：绑定对接人可发、非绑定 eligible → 403；换绑后新对接人可发
//   [8] cancel-schedule/requireLiaisonOnly：窄集合[13]放行、admin/其他 eligible 均排除（C10-fix M1 收回放宽）
//   [9] ⭐ MED-2（C10-fix3）：admin 受理空单→NULL 绑定**不死单**——admin assign/通知/退回均 200（代管推进）；
//       eligible 非 admin 成员对 NULL 单 403 NOT_BOUND_LIAISON（只 admin 能推进直到 admin 指派定对接人）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-c10-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); } catch { return res.status(401).json({ error: 'token 无效' }); }
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

// 角色矩阵：admin(1) / u5,u6,u13=user（eligible·u13 曾是唯一白名单示例对接人）/ pub7=publisher（eligible）/ viewer9=viewer（ineligible）
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const u5Tok = jwt.sign({ id: 5, username: 'u5', display_name: '开发五', role: 'user' }, SECRET);
const u6Tok = jwt.sign({ id: 6, username: 'u6', display_name: '开发六', role: 'user' }, SECRET);
const pub7Tok = jwt.sign({ id: 7, username: 'pub7', display_name: '发布七', role: 'publisher' }, SECRET);
const viewer9Tok = jwt.sign({ id: 9, username: 'viewer9', display_name: '查看九', role: 'viewer' }, SECRET);
const u13Tok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

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
let oaSeq = 0;

// 建单（走真实端点·intake_liaison_id 必填且须 eligible）——返回 id，落「待受理」。
async function createTicket(type, liaisonId, extra = {}) {
  const payload = {
    intake_contract_version: 2, type, title: `c10-${type}-${++oaSeq}`, system_name: 'BMS', source: '内部',
    description: 'C10 绑单精判 verify 建单', intake_liaison_id: liaisonId, ...extra,
  };
  if (type !== 'bug') payload.needs_feasibility = extra.needs_feasibility != null ? extra.needs_feasibility : 0;
  const r = await call('POST', '/api/sys-issues', adminTok, payload);
  return r;
}
// 存量空单：建单（合法对接人）后直连 SQL 把 intake_liaison_id 置 NULL（模拟存量·CAS 兜底目标）。
async function makeOrphan(type, seedLiaison = 5) {
  const r = await createTicket(type, seedLiaison);
  assert.strictEqual(r.status, 201, `[空单夹具] 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  await run('UPDATE sys_issues SET intake_liaison_id = NULL WHERE id = ?', [r.body.id]);
  return r.body.id;
}
const liaisonOf = async (id) => (await get('SELECT intake_liaison_id AS l FROM sys_issues WHERE id=?', [id])).l;
const statusOf = async (id) => (await get('SELECT status AS s FROM sys_issues WHERE id=?', [id])).s;

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (5,'u5','开发五','user','active'),
    (6,'u6','开发六','user','active'),
    (7,'pub7','发布七','publisher','active'),
    (9,'viewer9','查看九','viewer','active'),
    (13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin/u5·u6·u13=user / pub7=publisher / viewer9=viewer）');

  // ═══ [1] ⭐ 白名单废止：候选池 = allowlist（旧池外 user/publisher 可选可受理·viewer/admin 不可选）═══
  {
    // 下拉候选：eligible 全在（5/6/7/13），viewer9/admin 不在
    const rList = await call('GET', '/api/sys-issues/intake-liaisons', adminTok);
    assert.strictEqual(rList.status, 200, `[1] 候选下拉 200, got ${rList.status}`);
    const ids = (rList.body.items || rList.body || []).map(x => x.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [5, 6, 7, 13], `[1] 候选池应恰含全部 eligible（user 5/6/13 + publisher 7），不含 viewer9/admin，实得 ${JSON.stringify(ids)}`);
    // 旧池外 user(5) 可被选为对接人（白名单废止正向）
    const rOk = await createTicket('bug', 5);
    assert.strictEqual(rOk.status, 201, `[1] 旧池外 user5 作对接人建单应 201（白名单废止·非仅[13]），got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    assert.strictEqual(await liaisonOf(rOk.body.id), 5, '[1] 落库 intake_liaison_id=5');
    // publisher(7) 同样可选
    const rPub = await createTicket('bug', 7);
    assert.strictEqual(rPub.status, 201, '[1] publisher7 作对接人建单应 201');
    // viewer(9) 不可选 → 400 INVALID_INTAKE_LIAISON
    const rViewer = await createTicket('bug', 9);
    assert.strictEqual(rViewer.status, 400, `[1] viewer9 不 eligible 应 400, got ${rViewer.status} ${JSON.stringify(rViewer.body)}`);
    assert.strictEqual(rViewer.body.code, 'INVALID_INTAKE_LIAISON', `[1] 确切码 INVALID_INTAKE_LIAISON，实得 ${rViewer.body.code}`);
    // admin(1) 不可选（admin∉{user,publisher}）→ 400
    const rAdmin = await createTicket('bug', 1);
    assert.strictEqual(rAdmin.status, 400, `[1] admin 不 eligible 应 400, got ${rAdmin.status}`);
    assert.strictEqual(rAdmin.body.code, 'INVALID_INTAKE_LIAISON', `[1] admin 确切码 INVALID_INTAKE_LIAISON，实得 ${rAdmin.body.code}`);
    ok('[1] ⭐ 白名单废止：候选池=全 eligible(5/6/7/13)；旧池外 user5/publisher7 可被选为对接人（201）；viewer9/admin 不可选（400 INVALID_INTAKE_LIAISON）');
  }

  // ═══ [2] ⭐⭐ 空单 CAS 抢一：两 eligible 同时受理同一存量空单 → 一成一败 ═══
  {
    const id = await makeOrphan('bug');
    assert.strictEqual(await liaisonOf(id), null, '[2-前置] 存量空单 intake_liaison_id 为 NULL');
    assert.strictEqual(await statusOf(id), '待受理', '[2-前置] 待受理');
    const [r5, r6] = await Promise.all([
      call('POST', `/api/sys-issues/${id}/intake-accept`, u5Tok, {}),
      call('POST', `/api/sys-issues/${id}/intake-accept`, u6Tok, {}),
    ]);
    const wins = [r5, r6].filter(r => r.status === 200);
    const losses = [r5, r6].filter(r => r.status !== 200);
    assert.strictEqual(wins.length, 1, `[2] ⭐ 恰一人受理成功（抢一），实得 win=${wins.length} r5=${r5.status} r6=${r6.status}`);
    assert.strictEqual(losses.length, 1, '[2] 恰一人失败');
    // ⚠️ 后到者的确切码取决于写锁串行化时序（同 c9 [6] 范式）：单连接 + BEGIN IMMEDIATE 下写事务串行，
    //   后到者读到的是**前者已提交的状态**（bug 已到待处理）⇒ findTransition(intake_accept,待处理)=null ⇒
    //   400 INVALID_TRANSITION（状态闸先于空单 CAS 触发）。若两者都在提交前读到待受理（多连接部署），
    //   则由 `whereFrags intake_liaison_id IS NULL` 的 changes!==1 兜底给 409。两种都是"抢一"的合法终局，
    //   本组接受 {400 INVALID_TRANSITION | 409}——真正钉死的是**绑定唯一 + 无双绑**（下方三断言）。
    assert.ok(losses[0].status === 400 || losses[0].status === 409, `[2] 后到者应 4xx（400 状态闸 / 409 CAS 兜底），实得 ${losses[0].status} ${JSON.stringify(losses[0].body)}`);
    const boundNow = await liaisonOf(id);
    const winnerId = r5.status === 200 ? 5 : 6;
    assert.strictEqual(boundNow, winnerId, `[2] ⭐⭐ 绑定的 intake_liaison_id 必等于受理成功那个人（受理即绑自己·矛盾态"两人都绑上"不出现），胜者=${winnerId} 绑定=${boundNow}`);
    assert.strictEqual(await statusOf(id), '待处理', '[2] bug 受理后落待处理（恰推进一次）');
    ok('[2] ⭐⭐ 空单抢一：u5/u6 并发受理同一存量空单 → 恰一 200（绑自己）+ 一 4xx（状态闸/CAS 兜底）+ 绑定值=胜者身份（无双绑·状态恰进一次）');
  }

  // ═══ [3] A 受理后 B 再受理 → 409（已离开待受理·前置态守卫）═══
  {
    const id = await makeOrphan('bug');
    const rA = await call('POST', `/api/sys-issues/${id}/intake-accept`, u5Tok, {});
    assert.strictEqual(rA.status, 200, `[3] u5 首受理 200, got ${rA.status} ${JSON.stringify(rA.body)}`);
    assert.strictEqual(await liaisonOf(id), 5, '[3] 绑定 u5');
    const rB = await call('POST', `/api/sys-issues/${id}/intake-accept`, u6Tok, {});
    // 单已离开待受理（bug→待处理）⇒ findTransition(intake_accept,待处理)=null ⇒ 400 INVALID_TRANSITION（状态闸）。
    assert.strictEqual(rB.status, 400, `[3] u6 再受理应 400（单已离开待受理·状态闸），got ${rB.status} ${JSON.stringify(rB.body)}`);
    assert.strictEqual(rB.body.code, 'INVALID_TRANSITION', `[3] 确切码 INVALID_TRANSITION，实得 ${rB.body.code}`);
    assert.strictEqual(await liaisonOf(id), 5, '[3] 绑定仍是 u5（未被 u6 覆盖）');
    ok('[3] A(u5) 受理后 B(u6) 再受理 → 400 INVALID_TRANSITION（已离开待受理·状态闸先于空单兜底）+ 绑定不被覆盖');
  }

  // ═══ [4] 空单准入：ineligible 拒 + 已绑单被非绑定 eligible 受理拒 ═══
  {
    // ① viewer9（ineligible）受理空单 → 403（非 eligible·空单兜底不给它）
    const idOrphan = await makeOrphan('bug');
    const rViewer = await call('POST', `/api/sys-issues/${idOrphan}/intake-accept`, viewer9Tok, {});
    assert.strictEqual(rViewer.status, 403, `[4①] viewer 受理空单应 403, got ${rViewer.status} ${JSON.stringify(rViewer.body)}`);
    assert.strictEqual(await liaisonOf(idOrphan), null, '[4①] 零副作用：空单未被 viewer 绑上');
    // ② 已绑单（bound u5）被**非绑定但 eligible** 的 u6 受理 → 403（空单兜底只对 NULL·已绑单走绑单精判）
    const idBound = await createTicket('bug', 5);
    const rU6 = await call('POST', `/api/sys-issues/${idBound.body.id}/intake-accept`, u6Tok, {});
    assert.strictEqual(rU6.status, 403, `[4②] 非绑定 eligible 受理已绑单应 403 NOT_BOUND_LIAISON, got ${rU6.status} ${JSON.stringify(rU6.body)}`);
    assert.strictEqual(rU6.body.code, 'NOT_BOUND_LIAISON', `[4②] 确切码 NOT_BOUND_LIAISON，实得 ${rU6.body.code}`);
    assert.strictEqual(await liaisonOf(idBound.body.id), 5, '[4②] 绑定仍 u5');
    ok('[4] 空单准入：viewer(ineligible) 受理空单 → 403；已绑单(u5)被非绑定 eligible(u6)受理 → 403 NOT_BOUND_LIAISON（空单兜底只对 NULL·已绑单走绑单精判）');
  }

  // ═══ [4b] ⭐ C10-fix2 MED-1：admin 代办受理空单**不绑自己**（intake_liaison_id 保持 NULL·非 admin id=1）═══
  {
    // admin 走 isAdmin 准入放行受理空单，但 admin ∉ eligible 候选（role='admin' 不在 allowlist）——受理成功
    //   推进状态，但**不写入 intake_liaison_id**（保持 NULL=合法态·后续 admin 指派对接人时再定），不破坏
    //   「绑定值来自 eligible 候选」数据不变量（修复前无条件绑 actor → 绑成 admin id=1）。
    const id = await makeOrphan('bug');
    assert.strictEqual(await liaisonOf(id), null, '[4b-前置] 存量空单 intake_liaison_id 为 NULL');
    const rAdmin = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(rAdmin.status, 200, `[4b] admin 受理空单应 200（isAdmin 准入放行）, got ${rAdmin.status} ${JSON.stringify(rAdmin.body)}`);
    assert.strictEqual(await statusOf(id), '待处理', '[4b] bug 受理后推进到待处理（状态照常推进）');
    assert.strictEqual(await liaisonOf(id), null, '[4b] ⭐ intake_liaison_id 仍为 NULL——admin 代办受理空单不绑自己（非 admin id=1·守「绑定值来自 eligible 候选」不变量）');
    ok('[4b] ⭐ C10-fix2 MED-1：admin 代办受理空单 → 200 状态推进，但 intake_liaison_id 保持 NULL（不绑成 admin id=1·仅 eligible 成员受理空单才 CAS 绑自己·admin 后续指派再定对接人）');
  }

  // ═══ [5] ⭐⭐ 换对接人后旧对接人操作（assign）→ 403；新对接人 → 200 ═══
  {
    // feature：建单(绑 u5)→受理(u5)→补 OA→到待指派。然后换绑 u6。
    const c = await createTicket('feature', 5, { needs_feasibility: 0 });
    const id = c.body.id;
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, u5Tok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, `[5-前置] u5(绑定)受理 feature 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026080000 + oaSeq) });
    assert.strictEqual(r.status, 200, `[5-前置] 补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '待指派', '[5-前置] 待指派');
    // 换对接人：绑定改到 u6（直连 SQL·模拟换对接人）
    await run('UPDATE sys_issues SET intake_liaison_id = 6 WHERE id = ?', [id]);
    // 旧对接人 u5 assign → 403 NOT_BOUND_LIAISON
    const rOld = await call('POST', `/api/sys-issues/${id}/assign`, u5Tok, { assigned_to: 5 });
    assert.strictEqual(rOld.status, 403, `[5] ⭐ 旧对接人 u5 换绑后 assign 应 403, got ${rOld.status} ${JSON.stringify(rOld.body)}`);
    assert.strictEqual(rOld.body.code, 'NOT_BOUND_LIAISON', `[5] 确切码 NOT_BOUND_LIAISON，实得 ${rOld.body.code}`);
    assert.strictEqual(await statusOf(id), '待指派', '[5] 零副作用：u5 被拒后状态未变');
    // 新对接人 u6 assign → 200
    const rNew = await call('POST', `/api/sys-issues/${id}/assign`, u6Tok, { assigned_to: 5 });
    assert.strictEqual(rNew.status, 200, `[5] ⭐ 新对接人 u6 assign 应 200, got ${rNew.status} ${JSON.stringify(rNew.body)}`);
    assert.strictEqual(await statusOf(id), '开发中', '[5] 新对接人操作后真推进到开发中');
    ok('[5] ⭐⭐ 换对接人后：旧对接人 u5 assign → 403 NOT_BOUND_LIAISON + 零副作用；新对接人 u6 assign → 200（绑单精判按当前 intake_liaison_id 判·非历史）');
  }

  // ═══ [6] ⭐ admin 与对接人同时操作 → 一成一 409（状态 CAS）═══
  {
    const c = await createTicket('feature', 5, { needs_feasibility: 0 });
    const id = c.body.id;
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, u5Tok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, '[6-前置] 受理 200');
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026080000 + oaSeq) });
    assert.strictEqual(r.status, 200, '[6-前置] 补 OA 200');
    // admin 与绑定对接人 u5 并发 assign（都有权）→ 状态 CAS 抢一
    const [rAdmin, rU5] = await Promise.all([
      call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 6 }),
      call('POST', `/api/sys-issues/${id}/assign`, u5Tok, { assigned_to: 5 }),
    ]);
    const wins = [rAdmin, rU5].filter(x => x.status === 200);
    const losses = [rAdmin, rU5].filter(x => x.status !== 200);
    assert.strictEqual(wins.length, 1, `[6] ⭐ admin 与对接人并发 assign 恰一成功，实得 admin=${rAdmin.status} u5=${rU5.status}`);
    // ⚠️ 后到者**非 403**（两者都有操作权·排除 NOT_BOUND_LIAISON）——是状态类拒绝：单连接串行下后到者读到
    //   已提交的「开发中」⇒ assign 的状态前置不满足 ⇒ 4xx（409 状态 CAS / 或 assign 端点的状态闸码）。
    //   关键钉死：**不是 403 NOT_BOUND_LIAISON**（证明两者都过了绑单精判·输在状态而非权限）。
    assert.notStrictEqual(losses[0].body && losses[0].body.code, 'NOT_BOUND_LIAISON', `[6] ⭐ 后到者不得是 NOT_BOUND_LIAISON（admin 与绑定对接人都有权·输在状态 CAS 非权限），实得 ${losses[0].status} ${JSON.stringify(losses[0].body)}`);
    assert.ok(losses[0].status >= 400, `[6] 后到者应 4xx，实得 ${losses[0].status}`);
    assert.strictEqual(await statusOf(id), '开发中', '[6] 终态开发中（恰进一次）');
    ok('[6] ⭐ admin 与绑定对接人 u5 并发 assign（两者都有权）→ 恰一 200 + 一 4xx（状态抢一·后到者**非 403 NOT_BOUND_LIAISON**·证明输在状态而非权限）');
  }

  // ═══ [7] 通知路由（notify-developer）绑单精判 + 换绑后新对接人可发 ═══
  {
    // 造一个开发中的 feature（绑 u5·有在册开发），试 notify-developer
    const c = await createTicket('feature', 5, { needs_feasibility: 0 });
    const id = c.body.id;
    await call('POST', `/api/sys-issues/${id}/intake-accept`, u5Tok, { risk_level: '二级' });
    await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026080000 + oaSeq) });
    await call('POST', `/api/sys-issues/${id}/assign`, u5Tok, { assigned_to: 6 });   // 开发=u6
    // 非绑定 eligible 的 pub7 发开发通知 → 403 NOT_BOUND_LIAISON
    const rPub = await call('POST', `/api/sys-issues/${id}/notify-developer`, pub7Tok, { dev_user_id: 6 });
    assert.strictEqual(rPub.status, 403, `[7①] 非绑定 eligible 发开发通知应 403, got ${rPub.status} ${JSON.stringify(rPub.body)}`);
    assert.strictEqual(rPub.body.code, 'NOT_BOUND_LIAISON', `[7①] 确切码 NOT_BOUND_LIAISON，实得 ${rPub.body.code}`);
    // 绑定对接人 u5 发 → 200（stub dingtalk）
    const rU5 = await call('POST', `/api/sys-issues/${id}/notify-developer`, u5Tok, { dev_user_id: 6 });
    assert.strictEqual(rU5.status, 200, `[7②] 绑定对接人 u5 发开发通知应 200, got ${rU5.status} ${JSON.stringify(rU5.body)}`);
    // 换绑到 u6 → 旧对接人 u5 发 → 403；新对接人 u6 发 → 200（读当前 intake_liaison_id）
    await run('UPDATE sys_issues SET intake_liaison_id = 7 WHERE id = ?', [id]);   // 换绑到 pub7
    const rU5After = await call('POST', `/api/sys-issues/${id}/notify-developer`, u5Tok, { dev_user_id: 6 });
    assert.strictEqual(rU5After.status, 403, `[7③] 换绑后旧对接人 u5 发通知应 403, got ${rU5After.status}`);
    assert.strictEqual(rU5After.body.code, 'NOT_BOUND_LIAISON', '[7③] 确切码 NOT_BOUND_LIAISON');
    const rPub7After = await call('POST', `/api/sys-issues/${id}/notify-developer`, pub7Tok, { dev_user_id: 6 });
    assert.strictEqual(rPub7After.status, 200, `[7④] 换绑后新对接人 pub7 发通知应 200（绑单精判读当前值）, got ${rPub7After.status} ${JSON.stringify(rPub7After.body)}`);
    ok('[7] notify-developer 绑单精判：非绑定 eligible → 403 NOT_BOUND_LIAISON；绑定对接人 → 200；换绑后旧对接人 403、新对接人 200（读当前 intake_liaison_id·裁定2 通知重发绑单）');
  }

  // ═══ [8] cancel-schedule/requireLiaisonOnly：窄集合[13]放行·admin/其他 eligible 均排除（C10-fix M1 收回放宽）═══
  {
    // ⭐ [C10-fix M1·收回权限放宽] requireLiaisonOnly 收回**窄集合[13]**（isSysIntakeLiaison）——release/roster 级
    //   授权刻意不随候选池扩大：仅 id∈[13] 过；admin/viewer/**旧池外 eligible u5** 一律 403 INTAKE_LIAISON_ONLY。
    //   用一个不存在的 release id 触达中间件即可验判据（过判据者后续因 release 不存在得别的 4xx·非 INTAKE_LIAISON_ONLY）。
    const rAdmin = await call('POST', '/api/sys-releases/999999/cancel-schedule', adminTok, {});
    assert.strictEqual(rAdmin.status, 403, `[8①] admin cancel-schedule 应被 requireLiaisonOnly 403（admin 排除·§6.8）, got ${rAdmin.status} ${JSON.stringify(rAdmin.body)}`);
    assert.strictEqual(rAdmin.body.code, 'INTAKE_LIAISON_ONLY', `[8①] 确切码 INTAKE_LIAISON_ONLY（admin 被中间件排除），实得 ${rAdmin.body.code}`);
    // viewer9（ineligible）→ 同样被中间件 403 INTAKE_LIAISON_ONLY
    const rViewer = await call('POST', '/api/sys-releases/999999/cancel-schedule', viewer9Tok, {});
    assert.strictEqual(rViewer.status, 403, `[8②] viewer cancel-schedule 应 403, got ${rViewer.status}`);
    assert.strictEqual(rViewer.body.code, 'INTAKE_LIAISON_ONLY', `[8②] viewer 确切码 INTAKE_LIAISON_ONLY（ineligible 被中间件排除），实得 ${rViewer.body.code}`);
    // ⭐ [C10-fix M1] 旧池外 eligible u5(role=user·非[13]) → 现应**被拒** 403 INTAKE_LIAISON_ONLY（收回被动放宽·
    //   candidate 口径扩大不延伸到 release 级·守边界）。
    const rU5 = await call('POST', '/api/sys-releases/999999/cancel-schedule', u5Tok, {});
    assert.strictEqual(rU5.status, 403, `[8③] ⭐ eligible u5(role=user·非窄集合[13]) 应被 requireLiaisonOnly 403（M1 收回放宽）, got ${rU5.status} ${JSON.stringify(rU5.body)}`);
    assert.strictEqual(rU5.body.code, 'INTAKE_LIAISON_ONLY', `[8③] u5 确切码 INTAKE_LIAISON_ONLY（非[13]被排除），实得 ${rU5.body && rU5.body.code}`);
    // ⭐ [C10-fix M1] 窄集合成员 u13(id=13·示例对接人) → 过判据（后续因 release 999999 不存在得别的 4xx·**非** INTAKE_LIAISON_ONLY）
    const rU13 = await call('POST', '/api/sys-releases/999999/cancel-schedule', u13Tok, {});
    assert.notStrictEqual(rU13.body && rU13.body.code, 'INTAKE_LIAISON_ONLY', `[8④] ⭐ 窄集合 u13(id=13) 应过 requireLiaisonOnly（不得被 INTAKE_LIAISON_ONLY 拦），实得 ${rU13.status} ${JSON.stringify(rU13.body)}`);
    ok('[8] cancel-schedule/requireLiaisonOnly（C10-fix M1 收回窄集合[13]）：admin/viewer/旧池外 eligible u5 均 403 INTAKE_LIAISON_ONLY；仅窄集合 u13(13) 过判据（release/roster 级不随候选池扩大·守边界）');
  }

  // ═══ [9] ⭐ MED-2（codex 319-R）：admin 受理空单→NULL 绑定后**不死单**——admin 代管推进 + eligible 成员被绑单精判拦 ═══
  //   codex 担心「已受理但 intake_liaison_id=NULL」成死单。核实结论=**非死单**（isBoundLiaisonOrAdmin 与引擎
  //   roleGuard='intake_liaison' 的 admin 分支均无条件放行·不看绑定·index.js:423/:3217）：admin 可对 NULL 绑定
  //   单继续 assign/退回/通知推进，直到 admin 后续指派/换绑把 intake_liaison_id 定下来；eligible 非 admin 成员
  //   对 NULL 单一律 403 NOT_BOUND_LIAISON（NULL != actor.id·只 admin 能推进）。三条断言证明「NULL 合法态 +
  //   admin 代管 + 非死锁」。⚠️ 若发现某状态守卫真禁止 NULL 绑定单指派=真死锁 → 该断言会红（回报主会话改逻辑）。
  {
    // 前置：feature 空单（NULL）→ admin 受理（NULL 保持·[4b]）→ set-oa → 待指派
    const idA = await makeOrphan('feature', 5);
    let r = await call('POST', `/api/sys-issues/${idA}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(r.status, 200, `[9-前置] admin 受理 feature 空单 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await liaisonOf(idA), null, '[9-前置] 受理后 intake_liaison_id 仍 NULL（[4b]·admin 不绑自己）');
    r = await call('POST', `/api/sys-issues/${idA}/set-oa-number`, adminTok, { oa_number: String(2026081000 + oaSeq) });
    assert.strictEqual(r.status, 200, `[9-前置] 补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(idA), '待指派', '[9-前置] 待指派（NULL 绑定）');

    // ③ eligible 非 admin 成员 u5 对 NULL 单 assign → 403 NOT_BOUND_LIAISON（NULL != actor.id·只 admin 能推进）
    const rU5 = await call('POST', `/api/sys-issues/${idA}/assign`, u5Tok, { assigned_to: 6 });
    assert.strictEqual(rU5.status, 403, `[9③] eligible u5 对 NULL 绑定单 assign 应 403, got ${rU5.status} ${JSON.stringify(rU5.body)}`);
    assert.strictEqual(rU5.body.code, 'NOT_BOUND_LIAISON', `[9③] 确切码 NOT_BOUND_LIAISON，实得 ${rU5.body.code}`);
    assert.strictEqual(await statusOf(idA), '待指派', '[9③] 零副作用：u5 被拒后状态未变（NULL 单仍待指派）');

    // ① admin 对 NULL 绑定单 assign → 200（admin 代管推进·NULL 非死锁）
    const rAdminAssign = await call('POST', `/api/sys-issues/${idA}/assign`, adminTok, { assigned_to: 6 });
    assert.strictEqual(rAdminAssign.status, 200, `[9①] ⭐ admin 对 NULL 绑定单 assign 应 200（代管推进·非死单）, got ${rAdminAssign.status} ${JSON.stringify(rAdminAssign.body)}`);
    assert.strictEqual(await statusOf(idA), '开发中', '[9①] admin 推进到开发中（NULL 单未死锁）');

    // ② 通知：admin 对 NULL 绑定单 notify-developer → 200（admin 不被 NULL 绑定拦·代管发通知）
    const rNotify = await call('POST', `/api/sys-issues/${idA}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(rNotify.status, 200, `[9②-通知] admin 对 NULL 绑定单 notify-developer 应 200, got ${rNotify.status} ${JSON.stringify(rNotify.body)}`);

    // ② 退回：另造 feature 空单（待受理·NULL）→ admin intake-return → 200（待修改）（admin 退回不被 NULL 拦）
    const idR = await makeOrphan('feature', 5);
    const rReturn = await call('POST', `/api/sys-issues/${idR}/intake-return`, adminTok, { reason: 'MED-2 admin 退回空单测试原因' });
    assert.strictEqual(rReturn.status, 200, `[9②-退回] admin 对 NULL 绑定单 intake-return 应 200, got ${rReturn.status} ${JSON.stringify(rReturn.body)}`);
    assert.strictEqual(await statusOf(idR), '待修改', '[9②-退回] intake-return 后落待修改（admin 退回 NULL 单正常）');

    ok('[9] ⭐ MED-2：admin 受理空单→NULL 绑定非死单——③ eligible u5 对 NULL 单 assign→403 NOT_BOUND_LIAISON（只 admin 能推进）；① admin assign→200 推进开发中；② admin notify-developer→200 + admin intake-return→200 待修改（admin 代管推进/通知/退回均不被 NULL 绑定拦·后续 admin 指派时定对接人·非死单）');
  }

  // ═══ [10] ⭐⭐⭐ C10-fix5 HIGH：撤销候选资格同步撤销存量绑单操作权（fail-closed·红绿双验·三分组各一负例）═══
  //   缺陷（codex 322 末次审）：对接人 role 改 viewer（移出候选·仍 active）后仍是该单 intake_liaison_id ⇒ 旧实现
  //   isBoundLiaisonOrAdmin 只判身份=true ⇒ 仍能执行受保护动作（fail-open 残留操作权）；而通知端
  //   resolveValidBoundLiaisonForNotify 已校验 active+role∈allowlist 立即失效（两端不对称）。修法=绑单精判叠加当前
  //   isIntakeLiaisonEligible。覆盖三分组：Group A（直连 handler·assign）+ Group C（引擎 roleGuard='intake_liaison'·
  //   intake_accept）+ Group B（同步守卫 sysManualNotifyGuard·opts.actorEligible·notify-developer）。
  //   每组=正例(eligible 200) + 负例(撤销候选资格后同动作 403 NOT_BOUND_LIAISON·零副作用) + admin 旁路不受影响。
  //   ⚠️ 关键机制：撤销走 `UPDATE users SET role='viewer'`（DB 层·仍 active），JWT 里 role 仍 'user' 故过粗筛
  //     middleware（requireIntakeLiaison 读 JWT）；精判读 DB（isIntakeLiaisonEligible）→ viewer → 403。粗筛放宽+精判收紧。
  {
    // ── Group C（引擎 roleGuard='intake_liaison'·intake_accept）：绑定 u5 → 撤销资格受理 403 → 恢复受理 200 ──
    const crC = await createTicket('bug', 5);
    assert.strictEqual(crC.status, 201, `[10C-前置] 建 bug 绑 u5 应 201, got ${crC.status} ${JSON.stringify(crC.body)}`);
    const idC = crC.body.id;
    assert.strictEqual(await liaisonOf(idC), 5, '[10C-前置] 绑定 intake_liaison_id=5');
    await run(`UPDATE users SET role='viewer' WHERE id=5`);      // 移出候选·仍 active（撤销候选资格）
    let r = await call('POST', `/api/sys-issues/${idC}/intake-accept`, u5Tok, {});
    assert.strictEqual(r.status, 403, `[10C·负例] 撤销资格后绑定人受理应 403（引擎绑单精判叠 eligibility）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body && r.body.code, 'NOT_BOUND_LIAISON', `[10C·负例] 确切码 NOT_BOUND_LIAISON，实得 ${r.body && r.body.code}`);
    assert.strictEqual(await statusOf(idC), '待受理', '[10C·负例] 零副作用：403 后仍待受理');
    await run(`UPDATE users SET role='user' WHERE id=5`);        // 恢复候选资格
    r = await call('POST', `/api/sys-issues/${idC}/intake-accept`, u5Tok, {});
    assert.strictEqual(r.status, 200, `[10C·正例] 恢复 eligible 后绑定人受理应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(idC), '待处理', '[10C·正例] bug 受理落待处理');

    // ── Group A（直连 handler·assign）──
    // 正例：eligible u5 assign（idC 待处理 → 处理中）
    r = await call('POST', `/api/sys-issues/${idC}/assign`, u5Tok, { assigned_to: 6 });
    assert.strictEqual(r.status, 200, `[10A·正例] eligible 绑定人 assign 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(idC), '处理中', '[10A·正例] bug assign 落处理中');
    // 负例：另造 bug 绑 u5·u5 受理→待处理·撤销→assign 403（零副作用）·admin 旁路 200
    const crA = await createTicket('bug', 5);
    assert.strictEqual(crA.status, 201, `[10A-前置] 建 bug 绑 u5 应 201, got ${crA.status}`);
    const idA = crA.body.id;
    r = await call('POST', `/api/sys-issues/${idA}/intake-accept`, u5Tok, {});
    assert.strictEqual(r.status, 200, `[10A-前置] u5 受理 idA 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE users SET role='viewer' WHERE id=5`);
    r = await call('POST', `/api/sys-issues/${idA}/assign`, u5Tok, { assigned_to: 6 });
    assert.strictEqual(r.status, 403, `[10A·负例] 撤销资格后 assign 应 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body && r.body.code, 'NOT_BOUND_LIAISON', `[10A·负例] 确切码 NOT_BOUND_LIAISON，实得 ${r.body && r.body.code}`);
    assert.strictEqual(await statusOf(idA), '待处理', '[10A·负例] 零副作用：assign 403 后仍待处理');
    r = await call('POST', `/api/sys-issues/${idA}/assign`, adminTok, { assigned_to: 6 });
    assert.strictEqual(r.status, 200, `[10A·admin 旁路] admin assign 应 200（撤销他人资格不影响 admin）, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE users SET role='user' WHERE id=5`);        // 恢复

    // ── Group B（同步守卫 sysManualNotifyGuard·opts.actorEligible·notify-developer）──
    //   idC 现 处理中·assigned 6·绑定 u5。正例：eligible u5 notify-developer(6) 200；撤销→403（守卫 opts.actorEligible=false·fail-closed）；admin 旁路 200。
    r = await call('POST', `/api/sys-issues/${idC}/notify-developer`, u5Tok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, `[10B·正例] eligible 绑定人 notify-developer 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE users SET role='viewer' WHERE id=5`);
    r = await call('POST', `/api/sys-issues/${idC}/notify-developer`, u5Tok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 403, `[10B·负例] 撤销资格后 notify-developer 应 403（守卫 opts.actorEligible=false·fail-closed）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body && r.body.code, 'NOT_BOUND_LIAISON', `[10B·负例] 确切码 NOT_BOUND_LIAISON，实得 ${r.body && r.body.code}`);
    r = await call('POST', `/api/sys-issues/${idC}/notify-developer`, adminTok, { dev_user_id: 6 });
    assert.strictEqual(r.status, 200, `[10B·admin 旁路] admin notify-developer 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE users SET role='user' WHERE id=5`);        // 恢复（防污染后续/全量）

    ok('[10] ⭐⭐⭐ C10-fix5 HIGH 三分组红绿：Group A(assign)/Group C(引擎 intake_accept)/Group B(notify-developer 守卫) 均——eligible 绑定人 200(正)、撤销候选资格(role→viewer·仍 active)后同动作 403 NOT_BOUND_LIAISON(负·零副作用)、admin 旁路不受影响 200（撤销资格同步撤销存量绑单操作权·与通知端失效对称·fail-closed）');
  }

  // ═══ [11] ⭐⭐ C10-fix5 MED-1：可见性写读同源——非[13] eligible 成员被绑对接人 → 有读权（列表可见 + 详情 200）═══
  //   缺陷：非[13] eligible 成员被绑对接人后有操作权（isBoundLiaisonEligibleOrAdmin）但列表看不到该单/详情 403
  //   （[[feedback_write_read_same_semantic]]）。修法=列表 where 加 `intake_liaison_id=uid` 析取（uid>0 守卫）+ 详情
  //   canView 加同源 isBoundLiaison。⚠️ 可见性=**纯绑定身份**（不叠 isIntakeLiaisonEligible·读比写宽·有意设计：被撤销
  //   资格的旧对接人仍能看名下旧单但操作已被 HIGH 403 挡）。红绿：绑定前不可见 → 绑定后可见 → 改绑他人后失可见。
  {
    const cr = await createTicket('feature', 5);   // 绑 u5（非 u6）→ u6 初始与该单无任何关系
    assert.strictEqual(cr.status, 201, `[11-前置] 建 feature 绑 u5 应 201, got ${cr.status} ${JSON.stringify(cr.body)}`);
    const idV = cr.body.id;
    const listHas = async (tok) => {
      const rr = await call('GET', '/api/sys-issues?type=feature', tok);
      assert.strictEqual(rr.status, 200, `[11] 列表查询 200, got ${rr.status} ${JSON.stringify(rr.body)}`);
      return (rr.body.items || []).some(x => Number(x.id) === Number(idV));
    };
    const detailStatus = async (tok) => (await call('GET', `/api/sys-issues/${idV}`, tok)).status;

    // ① 绑定前（bound=u5·u6 无关系）：u6 列表看不到 + 详情 403
    assert.strictEqual(await listHas(u6Tok), false, '[11①·负] u6 绑定前列表不含该单');
    assert.strictEqual(await detailStatus(u6Tok), 403, '[11①·负] u6 绑定前详情 403');
    // ② 改绑到 u6：u6 列表可见 + 详情 200（MED-1 授读权）
    await run('UPDATE sys_issues SET intake_liaison_id = 6 WHERE id = ?', [idV]);
    assert.strictEqual(await listHas(u6Tok), true, '[11②·正] u6 绑定后列表含该单（列表 intake_liaison_id 析取放行）');
    assert.strictEqual(await detailStatus(u6Tok), 200, '[11②·正] u6 绑定后详情 200（canView isBoundLiaison 放行）');
    // ③ 改绑他人（u5）：u6 失可见（列表不含 + 详情 403·证明 keyed on intake_liaison_id=uid）
    await run('UPDATE sys_issues SET intake_liaison_id = 5 WHERE id = ?', [idV]);
    assert.strictEqual(await listHas(u6Tok), false, '[11③·负] 改绑他人后 u6 列表不再含该单');
    assert.strictEqual(await detailStatus(u6Tok), 403, '[11③·负] 改绑他人后 u6 详情 403');

    ok('[11] ⭐⭐ C10-fix5 MED-1 写读同源红绿：非[13] eligible u6 绑对接人前不可见（列表无/详情403）→绑定后可见（列表有/详情200·列表 intake_liaison_id 析取 + 详情 canView isBoundLiaison）→改绑他人后失可见（读=纯身份 keyed on intake_liaison_id=uid·读写不对称有意设计）');
  }

  console.log(`\n✅ verify-sys-c10-liaison-binding 全部通过（${passed} 组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
