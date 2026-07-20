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
  return call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: '测试单', system_name: 'BMS', source: '内部', ...extra });
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [A] intake_required=1 建单 → 待受理 + 入库 1（三类）═══
  {
    for (const type of ['feature', 'improvement', 'bug']) {
      const r = await create({ type, intake_required: 1 });
      assert.strictEqual(r.status, 201, `${type} intake=1 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, '待受理', `${type} intake=1 → 待受理（实际 ${row.status}）`);
      assert.strictEqual(row.intake_required, 1, `${type} 入库 intake_required=1（实际 ${row.intake_required}）`);
    }
    // 字符串 '1' / 布尔 true 亦归一为 1
    for (const v of ['1', true]) {
      const r = await create({ intake_required: v });
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, '待受理', `intake_required=${JSON.stringify(v)} → 待受理`);
      assert.strictEqual(row.intake_required, 1, `intake_required=${JSON.stringify(v)} 归一为 1`);
    }
    ok('[A] intake_required=1 建单 → 待受理 + 入库 1（feature/improvement/bug + \'1\'/true 归一）');
  }

  // ═══ [B] 不传 / 显式 0 → 无受理落态 + intake_required=0（回归·零行为变化）═══
  {
    const cases = [
      { type: 'feature', extra: {}, want: '待指派' },
      { type: 'feature', extra: { intake_required: 0 }, want: '待指派' },
      { type: 'improvement', extra: { intake_required: '0' }, want: '待指派' },
      { type: 'improvement', extra: { intake_required: false }, want: '待指派' },
      { type: 'bug', extra: {}, want: '待处理' },
      { type: 'bug', extra: { intake_required: 0 }, want: '待处理' },
    ];
    for (const c of cases) {
      const r = await create({ type: c.type, ...c.extra });
      assert.strictEqual(r.status, 201, `${c.type} ${JSON.stringify(c.extra)} 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, c.want, `${c.type} ${JSON.stringify(c.extra)} → ${c.want}（实际 ${row.status}）`);
      assert.strictEqual(row.intake_required, 0, `${c.type} ${JSON.stringify(c.extra)} 入库 intake_required=0`);
    }
    ok('[B] 不传/显式 0/\'0\'/false → 无受理落态（feature/improvement=待指派·bug=待处理）+ 入库 0');
  }

  // ═══ [C] 非法值 → 400 INVALID_INTAKE_REQUIRED（严格·不静默落 0·含收口审 MED 收严的 null/空串）═══
  {
    // 收口审 MED（codex149-B）：null / '' / 空白串不再静默落 0，须 400（只 undefined 默认 0）
    for (const v of ['yes', 2, 'true', -1, null, '', '  ']) {
      const r = await create({ intake_required: v });
      assert.strictEqual(r.status, 400, `intake_required=${JSON.stringify(v)} → 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_INTAKE_REQUIRED', `intake_required=${JSON.stringify(v)} code=INVALID_INTAKE_REQUIRED`);
    }
    ok('[C] 非法值 \'yes\'/2/\'true\'/-1/null/\'\'/空白 → 400 INVALID_INTAKE_REQUIRED（严格归一·收口审收严 null/空串）');
  }

  // ═══ [D] intake_required=1 + assign_mode A/B（bug）→ 400 INTAKE_WITH_ASSIGN_CONFLICT ═══
  {
    let r = await create({ type: 'bug', intake_required: 1, assign_mode: 'A', assigned_to: 5 });
    assert.strictEqual(r.status, 400, `intake=1 + assign A → 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'assign A code=INTAKE_WITH_ASSIGN_CONFLICT');
    r = await create({ type: 'bug', intake_required: 1, assign_mode: 'B', relay_user_id: 13 });
    assert.strictEqual(r.status, 400, `intake=1 + assign B → 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'assign B code=INTAKE_WITH_ASSIGN_CONFLICT');
    ok('[D] intake_required=1 + assign_mode A/B → 400 INTAKE_WITH_ASSIGN_CONFLICT（防建单绕过受理门）');
  }

  // ═══ [E] 端到端：建单 intake=1 → 待受理 → admin intake-accept → 待指派（受理门贯通）═══
  {
    const r = await create({ type: 'feature', intake_required: 1 });
    const id = r.body.id;
    let row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待受理', '建单落 待受理');
    const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
    assert.strictEqual(acc.status, 200, `受理人 intake-accept 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
    row = await get('SELECT status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.status, '待指派', 'intake-accept → 待指派（受理门贯通）');
    ok('[E] 端到端：建单 intake=1 → 待受理 → 受理人 intake-accept → 待指派（受理门真正生效）');
  }

  // ═══ [F] #2 resume 存量兼容：历史 hold from_status=待评估/已排期 → resume 映射待指派 ═══
  //   收口审 LOW（codex149-B）：旧态「待评估/已排期」仅 feature/improvement 有（bug 无·C1 迁移不动 bug），
  //   两类均须能恢复（都以「待指派」为变更流前段活跃态）→ 循环覆盖 feature+improvement。
  {
    for (const type of ['feature', 'improvement']) {
      for (const legacy of ['待评估', '已排期']) {
        const ins = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
          VALUES (?,'已暂缓','P2',?, 'BMS','内部',0,1,'管理员','native')`, [type, `存量暂缓单-${type}-${legacy}`]);
        const id = ins.lastID;
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, action_code, operator_id, operator_name)
          VALUES (?, 'status_change', ?, '已暂缓', 'hold', 1, '管理员')`, [id, legacy]);
        const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, {});
        assert.strictEqual(r.status, 200, `resume 存量(${type}/${legacy}) 200, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.status, '待指派', `${type} 历史 hold from_status=${legacy} → resume 映射待指派（实际 ${r.body.status}）`);
      }
    }
    ok('[F] #2 resume 存量兼容：feature/improvement 历史 hold from_status=待评估/已排期 → 映射待指派（兑现方案 §12.7·防存量单永久卡死）');
  }

  // ═══ [G] #5 resend-tech-consult 状态门：仅待受理可重发·离开受理阶段 → 409 ═══
  {
    // 建单 intake=1 → 待受理 → 发起技术负责人沟通（示例发布者 7）→ 拿 request_event_id
    const cr = await create({ type: 'feature', intake_required: 1 });
    const id = cr.body.id;
    const req = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(req.status, 200, `request-tech-consult 200, got ${req.status} ${JSON.stringify(req.body)}`);
    const eid = req.body.request_event_id;
    // 待受理态重发 → 过状态门（200·发送 best-effort stub ok）
    let r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: eid });
    assert.strictEqual(r.status, 200, `待受理态 resend 200（过状态门）, got ${r.status} ${JSON.stringify(r.body)}`);
    // 模拟受理通过后离开待受理（→待指派）→ 重发 409 TECH_CONSULT_RESEND_LATE
    await run(`UPDATE sys_issues SET status='待指派' WHERE id=?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, liaisonTok, { expected_request_event_id: eid });
    assert.strictEqual(r.status, 409, `离开受理阶段 resend 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'TECH_CONSULT_RESEND_LATE', 'code=TECH_CONSULT_RESEND_LATE');
    // 收口审 LOW（codex149-B）：权限先于状态门——无权限用户(dev5·非admin/受理人/建单人)对非待受理单 resend 仍先得 403（不借状态码侧信道泄露单据态）
    const r403 = await call('POST', `/api/sys-issues/${id}/resend-tech-consult`, devTok, { expected_request_event_id: eid });
    assert.strictEqual(r403.status, 403, `无权限 resend 403（权限先于状态门）, got ${r403.status} ${JSON.stringify(r403.body)}`);
    assert.strictEqual(r403.body.code, 'NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND', 'code=NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND（权限校验先执行）');
    ok('[G] #5 resend 状态门：待受理可重发·离开受理阶段(待指派) → 409·无权限用户 → 403（权限先于状态门·防侧信道）');
  }

  // ═══ [H] #3 组合：intake_required=1 + needs_feasibility=1（收口审 LOW·此前正常建单无法触达的新可达路径）═══
  {
    for (const type of ['feature', 'improvement']) {
      const r = await create({ type, intake_required: 1, needs_feasibility: 1 });
      assert.strictEqual(r.status, 201, `${type} intake=1+needs_feas=1 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const id = r.body.id;
      let row = await get('SELECT status, intake_required, needs_feasibility FROM sys_issues WHERE id=?', [id]);
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
