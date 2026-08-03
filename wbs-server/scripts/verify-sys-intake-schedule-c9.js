// 验证脚本：系统迭代 受理排期改造 C9 — verify 全套「系统性覆盖」
//   用法：node scripts/verify-sys-intake-schedule-c9.js
//
// 定位（方案 §14.2 C9）：C3-C8 各自增量写了专项 verify，本脚本做**系统性收口**——补齐三块，
//   核心价值 = 补 C3-C8 分散 verify 的真空，不重抄已覆盖的断言（诚实标注重叠段的性质）。
//
//   [H] INTAKE→hold 跨状态回归（129-H1·⭐ 当前完全零覆盖·C9 首次覆盖的真空）：
//       待受理/待修改 hold → 被拒（hold.from 去 INTAKE·§4.2/§B），堵「待受理→暂缓(D_PRE)→加减成员→resume 回
//       待受理」绕过受理门链的**第一道闸**（hold 本身进不去）。与既有 verify-sys-multidev-members S28c（INTAKE 态
//       直接成员动作 409）形成双闸——本块验「暂缓侧门」入口断，S28c 验「直接成员动作」断。
//       ⚠️ 归因用**常量层 + HTTP 行为两层**（codex 145 MED-1）：H-0 直读 transitions 真源锁「hold.from 去 INTAKE /
//       bug hold 条目存在但 from 不含 INTAKE 态」（bug暂缓方案 20260803 v0.4 §4.2 更正："bug 无 hold" 旧表述已随
//       该方案推翻——bug 现有 hold，只是 from 不含待受理/待修改）这个常量约束，使 H-1/H-2 的 400 不只靠 HTTP、有
//       独立归因（防「另一守卫也返 400 导致归因失真」）。H-3 再用真实 HTTP 路径(intake_return)产生待修改态，证
//       H-1 拒绝非「UPDATE 夹具不合法」假象。
//   [M] §11 权限回归矩阵「系统 canary」（真 HTTP·四类用户×四能力单点汇总·定位=权限烟雾测试）：
//       ⚠️ 诚实声明：矩阵多数格 verify-sys-liaison([P]bug assign/变更流越界) + c3([A]intake/[C]resubmit) +
//       c5([R]被选技术负责人) 已真 HTTP 逐格验过（含落态/无副作用）。本段**不是重新发现**，而是把分散断言收敛成
//       矩阵级单点 canary（任何角色划分改动→一处红）；对**唯一新覆盖格**（示例对接人13 变更流 assign→403）单独强化
//       错误标识 + 无副作用（M-1b·codex 145 MED-3）。
//   [F] 六族双向集合断言汇总（读后端真源·常量层+引擎层·与 S28c 端点层互补）：
//       ①根因(INTAKE 态归独立 'INTAKE' 族·该族不在任何成员动作允许族) ②常量层(展开集合不含 INTAKE)
//       ③引擎层(assertMemberActionFamilyAllowed 抛 409 INVALID_STATUS)。动作集合用**精确契约**枚举（F-0·codex 145
//       HIGH-1）——不从被测矩阵反射，防「删动作后覆盖自动缩水仍绿」假绿。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const SF = require('../routes/sys-iteration/status-families');

const SECRET = 'verify-sys-intake-c9-secret';
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

// 通知桩（矩阵段 request_tech_consult / intake_return 会触发首发·稳定 ok·本脚本只验权限 status 不验通知内容）
async function mockSendIssueDingtalkRaw(user, title, md) { return { ok: true, message_key: 'stub-c9' }; }
async function mockGetSafePlatformBaseUrl() { return ''; }

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
  getSafePlatformBaseUrl: mockGetSafePlatformBaseUrl,
});
const I = mod._internals;
const T = I.transitions;

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

// id 对齐生产语义：1=admin / 5,6=普通开发 / 13=示例对接人(受理人 SYS_INTAKE_LIAISON) / 7=示例发布者(技术负责人 SYS_TECH_LEAD·亦 bug 对接人·非受理人)
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const techLeadTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);   // 技术负责人（非受理人）
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        // codex 145 LOW-2：JSON 解析失败转 reject（附状态码+响应片段），不让截断/HTML 响应形成静默未捕获异常
        try { resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }); }
        catch (e) { reject(new Error(`响应体 JSON 解析失败 (HTTP ${r.statusCode}) ${method} ${p}: ${b.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 建单 → 直接 UPDATE 播种到目标 status/intake_required/created_by（同 c3 夹具惯例）。
//   ⚠️ 非受理态（开发中/待上线…）无公开 HTTP 路径直达，故用 UPDATE 播种——c3-c8 既定夹具范式。
//   ⭐ 角色权限重构 C0：ir 默认由 0 改 **1**——受理门焊死后 intake_required 全表恒 1，0 已是非法态
//     （DB 触发器 ABORT）。本文件各用例的被测点都不是 ir 值本身，改默认即可，无需摘约束。
async function seed(type, { status, ir = 1, createdBy = null } = {}) {
  const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: `${type}单`, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const sets = ['status = ?', 'intake_required = ?'];
  const params = [status, ir];
  if (createdBy !== null) { sets.push('created_by = ?'); params.push(createdBy); }
  await run(`UPDATE sys_issues SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return id;
}

const TYPES = ['feature', 'improvement', 'bug'];
const INTAKE_STATES = ['待受理', '待修改'];
// 成员动作精确契约（codex 145 HIGH-1）：固定集合·不从被测矩阵反射·删/增动作须显式改此处 → 覆盖不随实现缩水。
const EXPECTED_MEMBER_ACTIONS = ['add', 'commit', 'excuse', 'reassign', 'remove', 'supersede'];

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),(6,'dev2','开发李','user','13800000006'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013'),(99,'other','建单人乙','user','13800000099')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务（受理人 13 示例对接人 / 技术负责人 7 示例发布者 / 建单人乙 99）');

  // ═══════════════════════════════════════════════════════════════════════════
  // [H] INTAKE→hold 跨状态回归（129-H1·⭐ C9 首次覆盖的真空·常量层归因 + HTTP 行为两层）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // (H-0) 常量层归因锚（codex 145 MED-1）：直读 transitions 真源锁 129-H1 的具体常量约束，
    //   让 H-1/H-2 的 400 有独立于 HTTP/夹具的归因来源——防「另一守卫也返 400」把归因悄悄替换掉。
    for (const type of ['feature', 'improvement']) {
      assert.ok(T.findTransition(type, 'hold', '待指派'),
        `${type} 待指派 findTransition('hold') 应存在（hold 对该 type 可用·H-canary 常量侧证据）`);
      for (const st of INTAKE_STATES) {
        assert.ok(!T.findTransition(type, 'hold', st),
          `${type} ${st} findTransition('hold') 应无匹配（hold.from 去 INTAKE·129-H1 常量层归因）`);
      }
    }
    // ⭐ [bug暂缓方案 20260803 v0.4 §4.2·断言写错更正] 原断言锁的是"bug 无 hold 条目（§2.2 有意省略）"——
    //   这个旧事实已被本方案推翻，bug 现有 hold 条目（from: ['处理中']，见 transitions.js BUG_FLOW_TRANSITIONS）。
    //   但 INTAKE 态（待受理/待修改）本就不在 bug hold.from 内，改用 findTransition 精确验证"bug hold 条目
    //   确实存在（处理中可用），但不匹配 INTAKE 态"，归因方式与下方 feature/improvement 判定同构
    //   （"存在但 from 排除 INTAKE"），而非旧版的"动作根本不存在"。
    assert.ok(T.findTransition('bug', 'hold', '处理中'),
      "bug 处理中 findTransition('hold') 应存在（bug暂缓方案 20260803 v0.4 §4.2 新增 hold 条目，from=['处理中']）");
    for (const st of INTAKE_STATES) {
      assert.ok(!T.findTransition('bug', 'hold', st),
        `bug ${st} findTransition('hold') 应无匹配（hold.from 不含 INTAKE 态·与 feature/improvement 同一归因方式）`);
    }
    ok("[H-0] 常量层归因：feature/improvement hold.from 有待指派、无待受理/待修改（129-H1 收窄）+ bug hold 条目存在但 from 仅含处理中、同样不含待受理/待修改（bug暂缓方案 20260803 v0.4 §4.2）——H-1/H-2 的 400 有常量层独立归因");

    // (H-canary) HTTP 侧证 hold 对「有 hold 的 type + 白名单态」正常可用（与 H-0 常量侧互印）。
    for (const type of ['feature', 'improvement']) {
      // ⭐ C0：ir 由 0 改 1（本 canary 测的是 hold 可用性，与 ir 无关；C0 后 ir=0 已是非法态）
      const id = await seed(type, { status: '待指派', ir: 1 });
      const r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '正常暂缓（canary）' });
      assert.strictEqual(r.status, 200, `canary：${type} 待指派 hold 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '已暂缓', `canary：${type} 待指派 hold → 已暂缓`);
    }
    ok('[H-canary] feature/improvement 待指派 hold → 200 已暂缓（HTTP 侧证 hold 对白名单态可用·与 H-0 常量侧互印）');

    // (H-1) feature/improvement：hold 存在但 from 去 INTAKE → 待受理/待修改 hold → 400 INVALID_TRANSITION + 态不变
    for (const type of ['feature', 'improvement']) {
      for (const st of INTAKE_STATES) {
        const id = await seed(type, { status: st, ir: 1 });
        const r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '尝试受理阶段暂缓' });
        assert.strictEqual(r.status, 400, `${type} ${st} hold 应 400（hold.from 去 INTAKE）, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'INVALID_TRANSITION', `${type} ${st} hold 400 code=INVALID_TRANSITION`);
        const row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
        assert.strictEqual(row.status, st, `${type} ${st} hold 被拒后态不变（未进 D_PRE·暂缓侧门入口断）`);
      }
    }
    ok('[H-1] feature/improvement × 待受理/待修改 hold → 400 INVALID_TRANSITION + 态不变（hold.from 去 INTAKE·堵暂缓侧门·态未进 D_PRE）');

    // (H-2) bug：hold 条目存在但 from 不含 INTAKE 态（bug暂缓方案 20260803 v0.4 §4.2）→ 待受理/待修改
    //   hold 仍 400 + 态不变（codex 145 LOW-1：补态不变·与 H-1 对齐；HTTP 层行为零回归——findTransition
    //   在"动作不存在"和"动作存在但 from 不匹配"两种情况下同样返回 null → 同一 INVALID_TRANSITION，
    //   本节只是归因表述随 H-0 更正，断言的状态码/错误码/态不变三项结果本身不变）。
    for (const st of INTAKE_STATES) {
      const id = await seed('bug', { status: st, ir: 1 });
      const r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '尝试暂缓' });
      assert.strictEqual(r.status, 400, `bug ${st} hold 应 400（hold.from 不含 INTAKE 态）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_TRANSITION', `bug ${st} hold 400 code=INVALID_TRANSITION`);
      const row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(row.status, st, `bug ${st} hold 被拒后态不变`);
    }
    ok('[H-2] bug × 待受理/待修改 hold → 400 INVALID_TRANSITION + 态不变（bug暂缓方案后 hold 条目已存在但 from 不含 INTAKE 态·与 H-1 归因方式统一：由 H-0 锚定「条目存在但态不匹配」，HTTP 层结果零回归）');

    // (H-3) 夹具有效性锚（codex 145 MED-2）：待修改态用真实 HTTP 路径产生（seed 待受理 → intake_return），
    //   证 H-1 待修改 hold 拒绝不是「UPDATE 夹具不合法致端点提前 400」的假象。
    const realId = await seed('feature', { status: '待受理', ir: 1 });
    let rr = await call('POST', `/api/sys-issues/${realId}/intake-return`, liaisonTok, { reason: '退改后验 hold' });
    assert.strictEqual(rr.status, 200, `真实 intake_return → 200, got ${rr.status} ${JSON.stringify(rr.body)}`);
    assert.strictEqual(rr.body.status, '待修改', '真实 intake_return 产生待修改态');
    rr = await call('POST', `/api/sys-issues/${realId}/hold`, adminTok, { reason: '尝试暂缓' });
    assert.strictEqual(rr.status, 400, '真实路径待修改态 hold → 400（非 UPDATE 夹具假象）');
    assert.strictEqual(rr.body.code, 'INVALID_TRANSITION', '真实待修改 hold 400 INVALID_TRANSITION');
    const realRow = await get('SELECT status FROM sys_issues WHERE id=?', [realId]);
    assert.strictEqual(realRow.status, '待修改', '真实待修改 hold 被拒后态不变');
    ok('[H-3] 夹具有效性锚：真实 HTTP 路径(intake_return)产生的待修改态 hold → 400 + 态不变（证 H-1 拒绝非 UPDATE 夹具不合法假象）');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [M] §11 权限矩阵「系统 canary」（真 HTTP·四类用户 × 四能力·权限烟雾测试）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // 四能力：每次新种对应态单（避免跨格状态污染），调真 HTTP 端点，返回 status。
    const cap = {
      bugAssign: async (tok) => (await call('POST', `/api/sys-issues/${await seed('bug', { status: '待处理' })}/assign`, tok, { assigned_to: 6 })).status,
      featAssign: async (tok) => {
        // R4（C2.5 撤销）：变更流 assign 前置 OA 守卫——夹具用 admin 补号，被测变量仍是"谁能 assign"
        const fid = await seed('feature', { status: '待指派' });
        await call('POST', `/api/sys-issues/${fid}/set-oa-number`, adminTok, { oa_number: '20260728100' });
        return (await call('POST', `/api/sys-issues/${fid}/assign`, tok, { assigned_to: 6 })).status;
      },
      intakeAccept: async (tok) => (await call('POST', `/api/sys-issues/${await seed('feature', { status: '待受理', ir: 1 })}/intake-accept`, tok, {})).status,
      resubmitOther: async (tok) => (await call('POST', `/api/sys-issues/${await seed('feature', { status: '待修改', ir: 1, createdBy: 99 })}/resubmit-intake`, tok, {})).status,
    };
    // §11 期望矩阵（真相=各端点权限实现·非方案文字）
    //   ⭐ 角色权限重构 C1 后的两处反转（方案 v1.5 §3 角色模型）：
    //     · 示例发布者(7) bugAssign  200 → **403**：他失去全部协调人动作，转纯技术负责人（只回一条评估留言）
    //     · 示例对接人(13) featAssign 403 → **200**：受理人指派权扩到全类型（这正是 v1.4 漏改 roleGuard 的那一格）
    //   不变的两格同样是 C1 的边界证据：
    //     · 示例对接人 resubmitOther 仍 403 —— 重提**他人**单属建单人权（creator_or_admin），受理人不获
    //     · 示例发布者 intakeAccept 仍 403 —— 受理是示例对接人专属，三名单按能力拆而非按角色
    const MATRIX = [
      { who: 'admin(1)',    tok: adminTok,    exp: { bugAssign: 200, featAssign: 200, intakeAccept: 200, resubmitOther: 200 } },
      { who: '示例发布者(7)',     tok: techLeadTok, exp: { bugAssign: 403, featAssign: 403, intakeAccept: 403, resubmitOther: 403 } },
      { who: '示例对接人(13)',  tok: liaisonTok,  exp: { bugAssign: 200, featAssign: 200, intakeAccept: 200, resubmitOther: 403 } },
      { who: 'dev(5)',      tok: devTok,      exp: { bugAssign: 403, featAssign: 403, intakeAccept: 403, resubmitOther: 403 } },
    ];
    for (const row of MATRIX) {
      for (const capKey of Object.keys(cap)) {
        const got = await cap[capKey](row.tok);
        assert.strictEqual(got, row.exp[capKey],
          `§11 矩阵：${row.who} 执行 ${capKey} 期望 ${row.exp[capKey]}，实得 ${got}`);
      }
    }
    ok('[M-1] §11 矩阵系统 canary：admin/示例发布者7/王13/dev5 × bugAssign/featAssign/intakeAccept/resubmitOther 全 16 格状态码与期望一致（角色划分漂移单点报警·详格落态验在 liaison/c3/c5）');

    // (M-1b) ⭐ 角色权限重构 C1 反转格强化：原断言「示例对接人13 变更流 assign → 403」是 C1 之前的正确期望，
    //   C1 把 transitions.js 变更流 assign 的 roleGuard 由 'admin' 改为 'intake_liaison' 后，**该格反转为 200**。
    //   这一格正是 v1.4 方案漏改、v1.5 源码核实时补上的那处阻断级缺口——所以这里不只断言 200，
    //   还要断言**落态与副作用真的发生**（若只看状态码，roleGuard 改对但引擎没走到写路径也会"绿"）。
    //   同时保留示例发布者的负例：同一格他必须 403，且 403 来自**中间件层**（他连粗筛都过不去）。
    {
      const featId = await seed('feature', { status: '待指派' });
      // R4（C2.5 撤销）：变更流 assign 前置 OA 守卫——admin 补号，被测变量仍是"示例对接人能否 assign"
      await call('POST', `/api/sys-issues/${featId}/set-oa-number`, adminTok, { oa_number: '20260728101' });
      const r = await call('POST', `/api/sys-issues/${featId}/assign`, liaisonTok, { assigned_to: 6 });
      assert.strictEqual(r.status, 200, `⭐ 示例对接人13 变更流 assign → 200（C1 全类型放开）, got ${r.status} ${JSON.stringify(r.body)}`);
      const after = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [featId]);
      assert.strictEqual(after.status, '开发中', 'C1：变更流 assign 落态 开发中（证真走了引擎写路径·非仅放行状态码）');
      assert.strictEqual(Number(after.assigned_to), 6, 'C1：assigned_to 落 6（选举结果）');

      // 示例发布者同格负例：中间件层就拒（他不在受理人白名单）
      const featId2 = await seed('feature', { status: '待指派' });
      const before2 = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [featId2]);
      const r2 = await call('POST', `/api/sys-issues/${featId2}/assign`, techLeadTok, { assigned_to: 6 });
      assert.strictEqual(r2.status, 403, `⭐ 示例发布者7 变更流 assign → 403, got ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body && r2.body.code, 'NOT_ADMIN_OR_INTAKE_LIAISON',
        '示例发布者 403 来自中间件层 requireIntakeLiaison（精确归因·非无关校验）');
      const after2 = await get('SELECT status, assigned_to FROM sys_issues WHERE id=?', [featId2]);
      assert.strictEqual(after2.status, before2.status, '拒绝后主状态不变（无部分写入）');
      assert.strictEqual(after2.assigned_to, before2.assigned_to, '拒绝后 assigned_to 不变（无部分写入）');
      ok('[M-1b] ⭐ C1 反转格强化：示例对接人13 变更流 assign → 200 且真落「开发中」+assigned_to（证走通引擎写路径）；示例发布者7 同格 403 且来自中间件层 + 零副作用');
    }

    // (M-2) 被选技术负责人白名单（tech_lead_id 白名单·与操作者无关·c5[R] 已验·此处汇总为矩阵 canary）
    //   ⭐ 角色权限重构 v2.1（C2.5 撤销）：request_tech_consult 开放态全类型统一为「待受理」，
    //   种子态同步改「待受理」（否则本组会撞上 REQUEST_TECH_CONSULT_STATUS_INVALID 而非本组要测的白名单 400）。
    {
      const seedIntake = () => seed('feature', { status: '待受理', ir: 1 });
      let r = await call('POST', `/api/sys-issues/${await seedIntake()}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
      assert.strictEqual(r.status, 200, `选示例发布者7 为技术负责人 → 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // ⭐ codex Round-B 审 MED（采纳）：只断 400 太弱（任何 400 都能让它绿）；补确切错误码——
      //   已 grep index.js:4390 request-tech-consult 的白名单校验，实际返回 code='TECH_LEAD_NOT_WHITELISTED'。
      for (const badId of [1, 13, 5]) {
        r = await call('POST', `/api/sys-issues/${await seedIntake()}/request-tech-consult`, liaisonTok, { tech_lead_id: badId });
        assert.strictEqual(r.status, 400, `选非白名单 id=${badId} 为技术负责人 → 400（仅示例发布者7 可被选）, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'TECH_LEAD_NOT_WHITELISTED', `选非白名单 id=${badId} 应为确切码 TECH_LEAD_NOT_WHITELISTED，实际 ${r.body.code}`);
      }
      ok('[M-2] 被选技术负责人白名单 canary：仅示例发布者7 可被选(200)·admin1/王13/dev5 被选→400 TECH_LEAD_NOT_WHITELISTED（确切码·tech_lead_id 白名单·与操作者无关）');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [F] 六族双向集合断言汇总（读后端真源·常量层+引擎层·与 S28c 端点层 409 互补）
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // (F-0) 动作集合精确契约（codex 145 HIGH-1）：断言矩阵键精确等于固定集合，不从被测矩阵反射——
    //   删/增动作会在此立即红，强制显式更新本系统性测试，防「覆盖随实现缩水仍绿」假绿。
    const actualActions = Object.keys(I.MEMBER_ACTION_FAMILY_MATRIX).slice().sort();
    assert.deepStrictEqual(actualActions, EXPECTED_MEMBER_ACTIONS,
      `成员动作矩阵键须精确 = [${EXPECTED_MEMBER_ACTIONS.join(',')}]（删/增动作须显式改本测试·防覆盖缩水假绿），实得 [${actualActions.join(',')}]`);
    ok(`[F-0] 动作集合精确契约：MEMBER_ACTION_FAMILY_MATRIX 键 === [${EXPECTED_MEMBER_ACTIONS.join('/')}]（固定集合·下面 F-1~F-3 基于它遍历·防反射缩水假绿）`);

    // (F-1) 根因（status-families.js:19-28/127）：待受理/待修改 归**独立 'INTAKE' 族**（非并入 D_PRE·128-H1），
    //   且 'INTAKE' 不在任何成员动作允许族里 → assertMemberActionFamilyAllowed 的 !allowedFamilies.includes('INTAKE')
    //   命中 → 受理阶段成员动作天然 409。两条一起锁死根因（族归属 + 族名排除），防未来把 INTAKE 误加进某族允许集。
    for (const type of TYPES) {
      for (const st of INTAKE_STATES) {
        assert.strictEqual(SF.familyOfStatus(type, st), 'INTAKE',
          `${type} 的 INTAKE 态「${st}」应归独立 'INTAKE' 族（非 D_PRE·128-H1），实得 ${SF.familyOfStatus(type, st)}`);
      }
    }
    for (const act of EXPECTED_MEMBER_ACTIONS) {
      for (const type of TYPES) {
        assert.ok(!(I.memberActionFamiliesFor(act, type) || []).includes('INTAKE'),
          `成员动作「${act}」(${type}) 允许族不应含 'INTAKE'（否则受理阶段被放行·绕过受理门）`);
      }
    }
    ok("[F-1] 根因：待受理/待修改 × 三 type 归独立 'INTAKE' 族（非 D_PRE·128-H1）+ 'INTAKE' 不在任何成员动作允许族（→ 受理阶段成员动作天然 409）");

    // (F-2) 常量层：全部成员动作族（固定集合）× 三 type 经 memberActionFamiliesFor 展开为状态集合，均不含待受理/待修改。
    for (const act of EXPECTED_MEMBER_ACTIONS) {
      for (const type of TYPES) {
        const fams = I.memberActionFamiliesFor(act, type) || [];
        const statuses = fams.flatMap(f => SF.getFamilyStatuses(type, f));
        for (const st of INTAKE_STATES) {
          assert.ok(!statuses.includes(st),
            `成员动作「${act}」(${type}) 展开状态集合不应含 INTAKE 态「${st}」，实得 [${statuses.join(',')}]`);
        }
      }
    }
    ok(`[F-2] 常量层：${EXPECTED_MEMBER_ACTIONS.length} 族成员动作(${EXPECTED_MEMBER_ACTIONS.join('/')}) × 三 type 展开集合均不含待受理/待修改（含 INTAKE 被塞入其他允许族也会红）`);

    // (F-3) 引擎层：assertMemberActionFamilyAllowed 对 INTAKE 态直调 → 抛 409 INVALID_STATUS（引擎判定函数层·非重跑 S28c 端点）
    let engineChecks = 0;
    for (const act of EXPECTED_MEMBER_ACTIONS) {
      for (const type of TYPES) {
        for (const st of INTAKE_STATES) {
          assert.throws(
            () => I.assertMemberActionFamilyAllowed(act, type, st),
            (e) => e && e.httpStatus === 409 && e.code === 'INVALID_STATUS',
            `assertMemberActionFamilyAllowed('${act}','${type}','${st}') 应抛 409 INVALID_STATUS`);
          engineChecks++;
        }
      }
    }
    ok(`[F-3] 引擎层：assertMemberActionFamilyAllowed 对 INTAKE 态全 ${engineChecks} 组(${EXPECTED_MEMBER_ACTIONS.length}族×3type×2态) 抛 409 INVALID_STATUS（引擎判定函数层·与 S28c 端点层 409 互补形成纵深）`);
  }

  server.close();
  db.close();   // codex 145 LOW-2：显式关 sqlite·不依赖 process 退出兜底
  console.log(`\n✅ verify-sys-intake-schedule-c9 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-intake-schedule-c9 失败:', e && (e.stack || e.message || e)); if (server) server.close(); try { db.close(); } catch (_) {} process.exit(1); });
