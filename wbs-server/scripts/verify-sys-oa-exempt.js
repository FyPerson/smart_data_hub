// 验证脚本：系统迭代 建单优化批 C3b — 三类需求方缺省固化 + 免 OA 声明（oa_exempt）
//   （方案 docs/local/系统迭代/系统迭代_建单优化批_方案_20260801_v1.3.md §6c）
//   用法：node scripts/verify-sys-oa-exempt.js
//
// 行为面清单制（对齐 verify-sys-intake-liaison.js / verify-sys-edit-window.js 范式）：
//   [①] 三类（feature/improvement/bug）建单缺省需求方三字段 → 整组固化：姓名=建单人 display_name /
//        部门=「信息技术部」/ 电话=建单人 users.phone
//   [②] 任一字段有值 → 整组按提交值落库（不逐字段混填默认，其余未提交字段落 null 非默认值）
//   [③] 三字段全部提供 → 提供值优先，原样落库
//   [④] 建单人本人无 phone → requester_phone 落 null（不造假值）
//   [⑤] exempt=1 无号变更单 assign 放行（200）
//   [⑥] exempt=0（默认）无号变更单 assign 仍 409 ASSIGN_REQUIRES_OA_NUMBER
//   [⑦] bug 类型无号恒放行（不受 oa_exempt 取值影响——bug 结构性不进 OA 守卫）
//   [⑧] oa_exempt 非法值 400 INVALID_OA_EXEMPT
//   [⑨] 衍生入口 oa_exempt 恒 0（不继承 origin 的 exempt=1）
//   [⑩] exempt 单仍可正常 set-oa-number 填号（200，填号不清 exempt 标志，号与豁免正交）
//   [⑪] timeline 免 OA 标注：exempt 单 assign 成功 summary 含"（免 OA 单）"；非 exempt 单不含
//
// 断言纪律：钉确切 HTTP 码 + code；固化正例断言三字段精确值（非仅非空）。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-oa-exempt-secret';
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

// 两个 admin：id=1 有电话（正例）/ id=2 无电话（[④] 负例：固化不造假值）。都是 role=admin
// （主建单端点 requireAdmin，"建单人"在本模块业务语境下恒为 admin 账号）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '管理员乙', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const issueRow = (id) => get('SELECT * FROM sys_issues WHERE id=?', [id]);
// assign 端点写 timeline 只落 event_type='assign'，不落 action_code（该列留 NULL）——查询按 event_type 过滤。
const timelineLastByEventType = (id, eventType) => get('SELECT * FROM sys_issue_timeline WHERE issue_id=? AND event_type=? ORDER BY id DESC LIMIT 1', [id, eventType]);

function createBody(overrides = {}) {
  return {
    intake_contract_version: 2, type: 'feature', system_name: 'BMS', source: '内部',
    intake_liaison_id: 13, description: '建单优化批 C3b fixture：verify 场景建单',
    ...overrides,
  };
}
// 建单 → 受理通过（intake-accept）→ 落「待指派」（feature/improvement）或「待处理」（bug）
async function createAndAccept(actorTok, overrides = {}) {
  const r = await call('POST', '/api/sys-issues', actorTok, createBody(overrides));
  assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(acc.status, 200, `受理通过 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13900000001'),
    (2,'admin2','管理员乙','admin','active', NULL),
    (5,'dev','开发王','user','active', NULL),
    (13,'wangtaotao','示例对接人','user','active', NULL)`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1[有电话] / admin2[无电话] / dev5 / 示例对接人13）');

  // ═══ [①] 三类建单缺省需求方三字段 → 整组固化 ═══
  {
    for (const type of ['feature', 'improvement', 'bug']) {
      const r = await call('POST', '/api/sys-issues', adminTok, createBody({ type }));
      assert.strictEqual(r.status, 201, `[①${type}] 期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const row = await issueRow(r.body.id);
      assert.strictEqual(row.requester_name, '管理员', `[①${type}] requester_name 固化=建单人 display_name`);
      assert.strictEqual(row.requester_dept, '信息技术部', `[①${type}] requester_dept 固化=「信息技术部」`);
      assert.strictEqual(row.requester_phone, '13900000001', `[①${type}] requester_phone 固化=建单人 users.phone`);
    }
    ok('[①] 三类（feature/improvement/bug）建单缺省需求方三字段 → 整组固化：姓名=建单人/部门=信息技术部/电话=建单人手机');
  }

  // ═══ [②] 任一字段有值 → 整组按提交值落库（不逐字段混填默认）═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, createBody({ requester_name: '业务方小张' }));
    assert.strictEqual(r.status, 201, `[②] 期望 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(r.body.id);
    assert.strictEqual(row.requester_name, '业务方小张', '[②] requester_name 按提交值');
    assert.strictEqual(row.requester_dept, null, '[②] requester_dept 未提交 → null（非补默认"信息技术部"，证不逐字段混填）');
    assert.strictEqual(row.requester_phone, null, '[②] requester_phone 未提交 → null（非补默认建单人手机，证不逐字段混填）');
    ok('[②] 需求方任一字段有值（仅传 requester_name）→ 整组按提交值落库，其余未提交字段落 null（不逐字段混填默认，防错配组合）');
  }

  // ═══ [③] 三字段全部提供 → 提供值优先 ═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, createBody({
      requester_dept: '财务部', requester_name: '张三', requester_phone: '13800000001',
    }));
    assert.strictEqual(r.status, 201, `[③] 期望 201, got ${r.status}`);
    const row = await issueRow(r.body.id);
    assert.strictEqual(row.requester_dept, '财务部', '[③] requester_dept 原样落库');
    assert.strictEqual(row.requester_name, '张三', '[③] requester_name 原样落库');
    assert.strictEqual(row.requester_phone, '13800000001', '[③] requester_phone 原样落库');
    ok('[③] 需求方三字段全部提供 → 提供值优先，原样落库（不被建单人身份覆盖）');
  }

  // ═══ [④] 建单人本人无 phone → requester_phone 落 null（不造假值）═══
  {
    const r = await call('POST', '/api/sys-issues', admin2Tok, createBody({}));
    assert.strictEqual(r.status, 201, `[④] 期望 201, got ${r.status}`);
    const row = await issueRow(r.body.id);
    assert.strictEqual(row.requester_name, '管理员乙', '[④] requester_name 固化=建单人乙 display_name');
    assert.strictEqual(row.requester_dept, '信息技术部', '[④] requester_dept 固化=「信息技术部」');
    assert.strictEqual(row.requester_phone, null, '[④] requester_phone 建单人无手机号 → null（不造假值，非空字符串/占位值）');
    ok('[④] 建单人本人 users.phone 为 NULL 时，固化的 requester_phone 保持 null（不造假值）');
  }

  // ═══ [⑤] exempt=1 无号变更单 assign 放行 ═══
  {
    const id = await createAndAccept(adminTok, { type: 'feature', oa_exempt: 1 });
    const row0 = await issueRow(id);
    assert.strictEqual(row0.oa_exempt, 1, '[⑤] 落库 oa_exempt=1');
    assert.strictEqual(row0.oa_number, null, '[⑤] 夹具确认无号');
    const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `[⑤] exempt=1 无号 assign 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    ok('[⑤] exempt=1 无号变更单：assign 放行（200），OA 守卫豁免格式校验');
  }

  // ═══ [⑥] exempt=0（默认）无号变更单 assign 仍 409 ═══
  {
    const id = await createAndAccept(adminTok, { type: 'improvement' });   // oa_exempt 未传 → 默认 0
    const row0 = await issueRow(id);
    assert.strictEqual(row0.oa_exempt, 0, '[⑥] 夹具确认 oa_exempt 默认落 0');
    const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 409, `[⑥] exempt=0 无号 assign 期望 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'ASSIGN_REQUIRES_OA_NUMBER', '[⑥] 确切码 ASSIGN_REQUIRES_OA_NUMBER（现状规则不变）');
    ok('[⑥] exempt=0（默认）无号变更单：assign 仍 409 ASSIGN_REQUIRES_OA_NUMBER（现状规则不变）');
  }

  // ═══ [⑦] bug 类型无号恒放行（不受 oa_exempt 取值影响）═══
  {
    for (const exempt of [undefined, 0, 1]) {
      const overrides = { type: 'bug' };
      if (exempt !== undefined) overrides.oa_exempt = exempt;
      const id = await createAndAccept(adminTok, overrides);
      const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
      assert.strictEqual(r.status, 200, `[⑦oa_exempt=${exempt}] bug 无号 assign 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    ok('[⑦] bug 类型无号恒放行（oa_exempt 未传/0/1 三值结果一致）——bug 结构性不进 OA 守卫（type guard 优先于 exempt 判定）');
  }

  // ═══ [⑧] oa_exempt 非法值 400 ═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, createBody({ oa_exempt: 'yes' }));
    assert.strictEqual(r.status, 400, `[⑧] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_OA_EXEMPT', '[⑧] 确切码 INVALID_OA_EXEMPT');
    const r2 = await call('POST', '/api/sys-issues', adminTok, createBody({ oa_exempt: 2 }));
    assert.strictEqual(r2.status, 400, `[⑧数字2] 期望 400, got ${r2.status}`);
    assert.strictEqual(r2.body.code, 'INVALID_OA_EXEMPT', '[⑧数字2] 确切码同上（非 0/1 的数字同拒）');
    // codex 219 L-2 变体：字符串 'true'（非 JS 布尔 true）钉住拒收——TRUTHY_OA 白名单仅认 `1`/`'1'`/`true`
    // 三个精确值，'true' 字符串不在其中，是刻意契约（防未来无意识放宽成"任何看着像真值的字符串都收"）。
    const r3 = await call('POST', '/api/sys-issues', adminTok, createBody({ oa_exempt: 'true' }));
    assert.strictEqual(r3.status, 400, `[⑧字符串true] 期望 400, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'INVALID_OA_EXEMPT', `[⑧字符串true] 确切码同上（'true' 字符串非 TRUTHY_OA 白名单精确值，刻意拒收）`);
    ok('[⑧] oa_exempt 非法值（字符串"yes"/数字2/字符串"true"）→ 400 INVALID_OA_EXEMPT，不静默降级');
  }

  // ═══ [⑨] 衍生入口 oa_exempt 恒 0（不继承 origin 的 exempt=1）═══
  {
    const originR = await call('POST', '/api/sys-issues', adminTok, createBody({ type: 'feature', oa_exempt: 1, title: '派生源单-exempt' }));
    assert.strictEqual(originR.status, 201, `[⑨] 夹具建源单 201, got ${originR.status}`);
    const originId = originR.body.id;
    assert.strictEqual((await issueRow(originId)).oa_exempt, 1, '[⑨] 夹具确认源单 oa_exempt=1');
    const deriveR = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok, { type: 'feature', title: '派生新单-不继承exempt', system_name: 'BMS', source: '内部' });
    assert.strictEqual(deriveR.status, 201, `[⑨] derive 期望 201, got ${deriveR.status} ${JSON.stringify(deriveR.body)}`);
    const derivedRow = await issueRow(deriveR.body.id);
    assert.strictEqual(derivedRow.oa_exempt, 0, '[⑨] 派生单 oa_exempt 恒 0，不继承 origin 的 exempt=1（fail-closed：衍生单默认须走 OA）');
    ok('[⑨] 衍生入口 oa_exempt 恒 0（不继承 origin 的 exempt=1，靠列 DEFAULT 落 0）');
  }

  // ═══ [⑩] exempt 单仍可正常 set-oa-number 填号（号与豁免正交）═══
  {
    const id = await createAndAccept(adminTok, { type: 'feature', oa_exempt: 1 });
    const r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026080101' });
    assert.strictEqual(r.status, 200, `[⑩] exempt 单 set-oa-number 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.oa_number, '2026080101', '[⑩] oa_number 已落库');
    assert.strictEqual(row.oa_exempt, 1, '[⑩] oa_exempt 标志未被填号联动清除（号与豁免正交）');
    ok('[⑩] exempt=1 单仍可正常 set-oa-number 填号（200），填号不联动清 oa_exempt 标志（号与豁免正交）');
  }

  // ═══ [⑪] timeline 免 OA 标注：exempt 单出现，非 exempt 单不出现 ═══
  {
    // 出现：exempt=1 单成功 assign 的 timeline summary 含"（免 OA 单）"
    const idExempt = await createAndAccept(adminTok, { type: 'feature', oa_exempt: 1 });
    const rExempt = await call('POST', `/api/sys-issues/${idExempt}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(rExempt.status, 200, `[⑪出现] assign 期望 200, got ${rExempt.status}`);
    const tlExempt = await timelineLastByEventType(idExempt, 'assign');
    assert.ok(tlExempt && tlExempt.summary.includes('（免 OA 单）'), `[⑪出现] summary 须含"（免 OA 单）"，实际="${tlExempt && tlExempt.summary}"`);

    // 不出现：非 exempt 单（先补号再 assign）的 timeline summary 不含该标注
    const idNormal = await createAndAccept(adminTok, { type: 'feature' });
    const oaR = await call('POST', `/api/sys-issues/${idNormal}/set-oa-number`, adminTok, { oa_number: '2026080102' });
    assert.strictEqual(oaR.status, 200, `[⑪不出现] 补号期望 200, got ${oaR.status}`);
    const rNormal = await call('POST', `/api/sys-issues/${idNormal}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(rNormal.status, 200, `[⑪不出现] assign 期望 200, got ${rNormal.status}`);
    const tlNormal = await timelineLastByEventType(idNormal, 'assign');
    assert.ok(tlNormal && !tlNormal.summary.includes('免 OA'), `[⑪不出现] summary 不应含免 OA 标注，实际="${tlNormal && tlNormal.summary}"`);

    ok('[⑪] 指派 timeline 免 OA 标注：exempt=1 单 assign 成功 summary 含"（免 OA 单）"；非 exempt 单（正常补号）不含');
  }

  // ═══ [⑫] codex 219 M-1：requester 字段类型非法（数字/对象/数组）→ 400 INVALID_REQUESTER_FIELDS ═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, createBody({ requester_name: 123 }));
    assert.strictEqual(r.status, 400, `[⑫数字] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_REQUESTER_FIELDS', '[⑫数字] 确切码 INVALID_REQUESTER_FIELDS');
    assert.ok(r.body.error.includes('requester_name'), `[⑫数字] 文案须含违规字段名，实际="${r.body.error}"`);

    const r2 = await call('POST', '/api/sys-issues', adminTok, createBody({ requester_phone: { a: 1 }, requester_dept: ['x'] }));
    assert.strictEqual(r2.status, 400, `[⑫多字段混合非法] 期望 400, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_REQUESTER_FIELDS', '[⑫多字段混合非法] 确切码同上');
    assert.ok(r2.body.error.includes('requester_phone') && r2.body.error.includes('requester_dept'),
      `[⑫多字段混合非法] 文案须列出全部违规字段名，实际="${r2.body.error}"`);

    ok('[⑫] codex 219 M-1：requester_dept/name/phone 类型非法（数字/对象/数组）→ 400 INVALID_REQUESTER_FIELDS，不静默当空处理（防误固化为建单人身份）');
  }

  // ═══ [⑬] codex 220 L-3：requester_phone 布尔值同拒（invalidRequesterFields 判定 typeof v!=='string'，
  //   覆盖布尔/数字/对象/数组等一切非字符串类型，独立成组便于单独核对该口径）═══
  {
    const r = await call('POST', '/api/sys-issues', adminTok, createBody({ requester_phone: true }));
    assert.strictEqual(r.status, 400, `[⑬] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_REQUESTER_FIELDS', '[⑬] 确切码 INVALID_REQUESTER_FIELDS（requester_phone:true 布尔值同拒）');
    assert.ok(r.body.error.includes('requester_phone'), `[⑬] 文案须含违规字段名，实际="${r.body.error}"`);
    ok('[⑬] codex 220 L-3：requester_phone:true（布尔）→ 400 INVALID_REQUESTER_FIELDS，与数字/对象/数组同一判定口径');
  }

  // ═══ [⑭] codex 219 L-3：只读脏值扫描——oa_exempt 全库须恒 ∈ {0,1}，非 NULL（ALTER 路径无 CHECK 的可观测性补偿）═══
  {
    const dirty = await get(`SELECT COUNT(*) c FROM sys_issues WHERE oa_exempt NOT IN (0,1) OR oa_exempt IS NULL`);
    assert.strictEqual(dirty.c, 0, `[⑭] oa_exempt 脏值扫描应为 0，实际=${dirty.c}（ALTER 路径无 DB CHECK 约束，服务层 0/1 白名单是唯一防线）`);
    ok('[⑭] 脏值扫描：全库 oa_exempt ∈ {0,1} 且非 NULL（ALTER 路径无 CHECK 的可观测性补偿，服务层白名单校验兜底）');
  }

  server.close();
  console.log(`\n✅ verify-sys-oa-exempt 全绿：${passed} 组断言通过`);
  console.log('  覆盖：三类建单缺省固化 + 任一有值整组按提交 + 提供值优先 + 无电话不造假值 + exempt=1放行/exempt=0仍409 + bug恒过 + 非法值400(含字符串true) + 衍生入口恒0 + exempt单set-oa-number仍200 + timeline免OA标注(出现/不出现) + requester字段类型白名单400 + oa_exempt全库脏值扫描=0');
}

main().catch(e => { console.error('❌ verify-sys-oa-exempt 失败:', e && e.stack || e); process.exit(1); });
