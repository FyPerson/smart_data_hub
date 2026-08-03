// 验证脚本：系统迭代 受理排期改造 C10 末次审 #1 — 建单受理门入口（codex149·合并前收口）
//   用法：node scripts/verify-sys-intake-schedule-c10.js
//
// 背景：C10 末次合并审 codex149 #1（HIGH）——建单后端曾恒传 resolveInitialStatus(type,0)、前端无受理控件，
//   导致受理门在正常建单流程进不去。本 commit 收口：建单受控解析 intake_required(严格0/1·默认0) + 显式 INSERT 落库
//   + 受理门与建单即指派(A/B)互斥。本 verify 证建单入口真正把单送进受理门。
//
// 覆盖（真实 HTTP POST /sys-issues）：
//   [A] intake_required=1 建单 → 201 + 落态「待受理」(feature/improvement/bug 三类) + 入库 intake_required=1
//   [B] 不传 / 显式 0 建单 → 无受理落态（feature/improvement=待指派·bug=待处理）+ intake_required=0（回归·零行为变化）
//   [C] intake_required 非法值（'yes' / 2 / 'true'）→ 400 INVALID_INTAKE_REQUIRED（严格归一·不静默落 0）
//   [D] intake_required=1 + assign_mode=A/B（bug）→ 400 INTAKE_WITH_ASSIGN_CONFLICT（防绕过·先受理再指派）
//   [E] 端到端：建单 intake_required=1 → 待受理 → admin intake-accept → 待指派（受理门真正贯通）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-c10-secret';
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

async function mockSendIssueDingtalkRaw() { return { ok: true, message_key: 'stub' }; }
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
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);              // 无受理/重发权（非 admin/非受理人/非建单人）

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

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 建单（admin），可带任意额外字段（intake_required / assign_mode 等）
function create(extra) {
  return call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '测试单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] 建单恒落「待受理」+ 入库 1（角色权限重构 C0 焊死受理门·方案 v1.5 §4-C0）═══
  //   ⚠️ 原 [A]/[B]/[C]/[D] 四组（intake=1 建单 / 显式 0 走无受理分支 / 非法值归一 / intake=1+assignA/B 冲突）
  //     随 C0「参数面封死」整体重写：客户端不再能选受理门开关，"选或不选"这条业务规则本身消失，
  //     原真值表不再有被测对象。新覆盖 = 恒定落态（本组）+ 参数拒绝（[A2]）+ path A/B 结构性关闭（[D]）。
  {
    // ⭐ 角色权限重构 C2.5 撤销（v2.1）：落态全类型归一「待受理」（预沟通段整体撤销）。
    //   **C0 的不变量是「intake_required 恒 1」，不是「status 恒待受理」**——DB 触发器只判 intake_required
    //   （intake-gate-sql.js·与 status 无关），故新态不削弱 C0；下面把两条分开断言，别再混为一谈。
    const EXPECT_CREATE_STATUS = { feature: '待受理', improvement: '待受理', bug: '待受理' };
    for (const type of ['feature', 'improvement', 'bug']) {
      const r = await create({ type });
      assert.strictEqual(r.status, 201, `${type} 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, EXPECT_CREATE_STATUS[type], `v2.1：${type} 建单落态应为「${EXPECT_CREATE_STATUS[type]}」（实际 ${row.status}）`);
      assert.strictEqual(row.intake_required, 1, `C0：${type} 入库 intake_required=1（实际 ${row.intake_required}）`);
    }
    ok('[A] C0 受理门焊死 + v2.1 落态归一：三类型入库 intake_required=1 恒成立（C0 不变量）· 全类型落待受理（C2.5 撤销）');
  }

  // ═══ [A2] intake_required 参数面封死：任何传值（含原本合法的 0/1）→ 400 INTAKE_REQUIRED_FIXED ═══
  //   ⚠️ 刻意不做"静默忽略后恒 1"：旧前端/缓存页面传 0 时若静默 201，调用方会误以为自己关掉了受理门，
  //     而实际开着——受理门是安全边界，失败必须响亮（沿用本模块 INVALID_INTAKE_REQUIRED 的失败响亮范式）。
  {
    for (const v of [1, 0, '1', '0', true, false, 'yes', 2, null, '', '  ']) {
      const r = await create({ intake_required: v });
      assert.strictEqual(r.status, 400, `intake_required=${JSON.stringify(v)} → 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INTAKE_REQUIRED_FIXED', `intake_required=${JSON.stringify(v)} code=INTAKE_REQUIRED_FIXED`);
    }
    ok('[A2] intake_required 参数面封死：0/1/\'0\'/\'1\'/true/false/\'yes\'/2/null/\'\'/空白 一律 400 INTAKE_REQUIRED_FIXED（含原合法值·失败响亮不静默）');
  }

  // ═══ [D] assign_mode A/B（bug）→ 400 INTAKE_WITH_ASSIGN_CONFLICT（受理门恒开 ⟹「建单即指派」结构性关闭）═══
  //   与原组的差别：不再需要显式传 intake_required=1 来触发冲突——受理门恒开，A/B 任何情况下都被拒。
  {
    let r = await create({ type: 'bug', assign_mode: 'A', assigned_to: 5 });
    assert.strictEqual(r.status, 400, `assign A → 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'assign A code=INTAKE_WITH_ASSIGN_CONFLICT');
    r = await create({ type: 'bug', assign_mode: 'B', relay_user_id: 13 });
    assert.strictEqual(r.status, 400, `assign B → 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'assign B code=INTAKE_WITH_ASSIGN_CONFLICT');
    ok('[D] C0：path A/B 结构性关闭——assign_mode A/B 无需显式 intake=1 即 400 INTAKE_WITH_ASSIGN_CONFLICT');
  }

  // ═══ [E] 端到端：建单 → 待受理 → 受理人 intake-accept → 待指派（受理门贯通）═══
  {
    const r = await create({ type: 'feature' });
    const id = r.body.id;
    let row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    // ⭐ v2.1（C2.5 撤销）：变更流建单直落「待受理」（预沟通段整体撤销），受理门是唯一必经关口
    assert.strictEqual(row.status, '待受理', '建单落 待受理（v2.1：C2.5 已撤销）');
    const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(acc.status, 200, `受理人 intake-accept 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
    row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待指派', 'intake-accept → 待指派（受理门贯通）');
    ok('[E] 端到端：建单 → 待受理 → 受理人 intake-accept → 待指派（受理门真正生效）');
  }

  // ═══ [F] #2 resume 存量兼容：历史 hold from_status=待评估/已排期 → resume 映射待指派 ═══
  //   收口审 LOW（codex149-B）：旧态「待评估/已排期」仅 feature/improvement 有（bug 无·C1 迁移不动 bug），
  //   两类均须能恢复（都以「待指派」为变更流前段活跃态）→ 循环覆盖 feature+improvement。
  {
    for (const type of ['feature', 'improvement']) {
      for (const legacy of ['待评估', '已排期']) {
        // ⭐ 角色权限重构 C0：ir 由 0 改 1——本组被测点是"历史 hold 的 from_status 能否映射回待指派"，
        //   与 ir 无关；而 C0 后 ir=0 已是非法态（DB 触发器 ABORT），夹具须合规。
        const ins = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
          VALUES (?,'已暂缓','P2',?, 'BMS','内部',1,1,'管理员','native')`, [type, `存量暂缓单-${type}-${legacy}`]);
        const id = ins.lastID;
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, action_code, operator_id, operator_name)
          VALUES (?, 'status_change', ?, '已暂缓', 'hold', 1, '管理员')`, [id, legacy]);
        // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1] resume requiredPayload 从 [] 改 ['reason']，补传 reason
        const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: `验证存量暂缓单(${type}/${legacy})恢复映射` });
        assert.strictEqual(r.status, 200, `resume 存量(${type}/${legacy}) 200, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.status, '待指派', `${type} 历史 hold from_status=${legacy} → resume 映射待指派（实际 ${r.body.status}）`);
      }
    }
    ok('[F] #2 resume 存量兼容：feature/improvement 历史 hold from_status=待评估/已排期 → 映射待指派（兑现方案 §12.7·防存量单永久卡死）');
  }

  // ═══ [G] #5 resend-tech-consult 状态门：仅开放态可重发·离开该态 → 409 ═══
  {
    // ⭐ 角色权限重构 v2.1（C2.5 撤销）：request_tech_consult 的开放态谓词全类型统一为「待受理」，
    //   直接在建单落态（待受理）上发起咨询——预沟通段整体撤销，无需再经中转。
    const cr = await create({ type: 'feature' });
    const id = cr.body.id;
    const req = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(req.status, 200, `request-tech-consult 200, got ${req.status} ${JSON.stringify(req.body)}`);
    const eid = req.body.request_event_id;
    // 待受理态重发 → 过状态门（200·发送 best-effort stub ok）
    let r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: eid });
    assert.strictEqual(r.status, 200, `待受理态 resend 200（过状态门）, got ${r.status} ${JSON.stringify(r.body)}`);
    // ⭐ codex Round-B 审 MED（采纳）：关闭态负例改表驱动——原实现只造了一个"相邻态"就断言 409，覆盖不到
    //   "离得更远的态是否也 409"这条更强的性质。⭐ v2.1：开放态本身已改「待受理」，原"待受理"远态例随之
    //   失去意义（它现在就是开放态），改用「待指派」（紧邻的下一站）+「开发中」（更远态）两个关闭态覆盖近远。
    //   对每个状态各自独立造一份夹具（各自 request 一次拿到新鲜 eid，避免共用同一单据的状态跳变互相干扰），
    //   逐个断言 409 + 确切码，保住"任意离开开放态（不论远近）都应被拒"的覆盖面。
    for (const farStatus of ['待指派', '开发中']) {
      const crFar = await create({ type: 'feature' });
      const idFar = crFar.body.id;
      const reqFar = await call('POST', `/api/sys-issues/${idFar}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
      assert.strictEqual(reqFar.status, 200, `[远态=${farStatus}] 夹具 request-tech-consult 200, got ${reqFar.status} ${JSON.stringify(reqFar.body)}`);
      const eidFar = reqFar.body.request_event_id;
      await run(`UPDATE sys_issues SET status=? WHERE id=?`, [farStatus, idFar]);
      const rFar = await call('POST', `/api/sys-issues/${idFar}/resend-tech-consult`, liaisonTok, { expected_request_event_id: eidFar });
      assert.strictEqual(rFar.status, 409, `[远态=${farStatus}] resend 应 409, got ${rFar.status} ${JSON.stringify(rFar.body)}`);
      assert.strictEqual(rFar.body.code, 'TECH_CONSULT_RESEND_LATE', `[远态=${farStatus}] code 应为 TECH_CONSULT_RESEND_LATE，实际 ${rFar.body.code}`);
    }
    // 收口审 LOW（codex149-B）：权限先于状态门——无权限用户(dev5·非admin/受理人/建单人)对非开放态单 resend 仍先得 403（不借状态码侧信道泄露单据态）
    // ⭐ v2.1：开放态本身已改「待受理」，本组要造的是"非开放态"夹具 → 改用「待指派」（不能再用「待受理」，
    //   那现在恰是开放态本身，达不到"非开放态"这个前提）。
    await run(`UPDATE sys_issues SET status='待指派' WHERE id=?`, [id]);
    const r403 = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, devTok, { expected_request_event_id: eid });
    assert.strictEqual(r403.status, 403, `无权限 resend 403（权限先于状态门）, got ${r403.status} ${JSON.stringify(r403.body)}`);
    assert.strictEqual(r403.body.code, 'NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND', 'code=NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND（权限校验先执行）');
    // bug 侧不受本次撤销影响：仍锚定「待受理」（bug 从未走过预沟通段，§3）——回归哨兵防日后误把 bug 挪走。
    const crb = await create({ type: 'bug' });
    const idb = crb.body.id;
    const reqb = await call('POST', `/api/sys-issues/${idb}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(reqb.status, 200, `bug 待受理态 request-tech-consult 200（不受本次谓词前移影响）, got ${reqb.status} ${JSON.stringify(reqb.body)}`);
    // ⭐ codex Round-B 审 LOW（采纳）：本组此前只测了 bug 的 request，没独立守住 bug 的 resend 分流——
    //   补一次 bug resend-tech-consult 调用（用 reqb 拿到的 request_event_id），不依赖跨脚本覆盖
    //   （resend 的 bug 场景另在 verify-sys-tech-lead-comment.js [M] 组测过，但那属另一文件，本组独立自洽）。
    const rb = await call('POST', `/api/sys-issues/${idb}/resend-tech-consult`, liaisonTok, { expected_request_event_id: reqb.body.request_event_id });
    assert.strictEqual(rb.status, 200, `bug 待受理态 resend-tech-consult 200（本组独立守住分流）, got ${rb.status} ${JSON.stringify(rb.body)}`);
    ok('[G] #5 resend 状态门：变更流待受理可重发（v2.1：C2.5 撤销）·离开该态(表驱动·待指派/开发中两个远态均 409 TECH_CONSULT_RESEND_LATE)·无权限用户 → 403（权限先于状态门·防侧信道）；bug 侧 request+resend 均 200（本组独立守住分流）');
  }

  // ═══ [H] #3 组合：受理门（恒开）+ needs_feasibility=1 —— 两个正交开关互不吞噬 ═══
  //   ⭐ C0 后受理门恒开，本组不再传 intake_required（参数已封）；被测点收敛为
  //     「needs_feasibility 独立入库、且受理通过后仍保留（评估在开发中做·不被受理门跳过）」。
  {
    for (const type of ['feature', 'improvement']) {
      const r = await create({ type, needs_feasibility: 1 });
      assert.strictEqual(r.status, 201, `${type} needs_feas=1 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const id = r.body.id;
      let row = await get('SELECT status, intake_required, needs_feasibility FROM sys_issues WHERE id=?', [id]);
      // ⭐ v2.1（C2.5 撤销）：变更流落「待受理」；needs_feasibility 仍须独立入库（不被落态吞掉）
      assert.strictEqual(row.status, '待受理', `${type} 组合 → 待受理`);
      assert.strictEqual(row.intake_required, 1, `${type} 组合 intake_required=1`);
      assert.strictEqual(row.needs_feasibility, 1, `${type} 组合 needs_feasibility=1 独立入库（不被 intake 吞掉）`);
      // 受理通过 → 待指派·needs_feasibility 保留（评估在开发中做·不被受理门跳过）
      const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
      assert.strictEqual(acc.status, 200, `${type} 组合 intake-accept 200`);
      row = await get('SELECT status, needs_feasibility FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(row.status, '待指派', `${type} 组合受理通过 → 待指派`);
      assert.strictEqual(row.needs_feasibility, 1, `${type} 受理通过后 needs_feasibility 仍=1（评估环节不被跳过）`);
    }
    ok('[H] #3 组合 intake_required=1 + needs_feasibility=1 → 待受理 + 两字段独立入库·受理通过后评估标记保留');
  }

  server.close();
  console.log(`\n✅ verify-sys-intake-schedule-c10 全部通过（${passed} 组·C10 收口 #1建单受理门入口 + #2resume存量兼容 + #5resend状态门 + 收口审加固）`);
  process.exit(0);
}
main().catch(e => { console.error('❌ verify 失败：', e && e.stack || e); try { server && server.close(); } catch {} process.exit(1); });
