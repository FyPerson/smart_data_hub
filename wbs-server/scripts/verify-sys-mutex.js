// 验证脚本：系统迭代 C4.5 状态机串行化 mutex（sysTxnMutex）
//   用法：node scripts/verify-sys-mutex.js
//
// 目的：证明并发 sys 事务被 mutex 串行化——**无 nested-transaction 500、无部分提交脏态**。
//   对照 C4 审 ultracode CONFIRMED：并发双击 publish 原会交错→R2 ROLLBACK 回滚 R1 事务→
//   "已发布批次 release_note=NULL 违反闸门③"脏态 + 双 500。加锁后应：恰一胜（200）一负（409 非 500），脏态不可达。
// in-process express app（挂真实 router）+ 内存库（parallel 模式，与生产同源）+ 自签 token。
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-mutex-secret';
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
  return new Promise((res, rej) => { let n = 0; const t = setInterval(() => {
    if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
    else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
    else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
  }, 10); });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
// C3：并发双击 execute 用例的第二位执行人（本组测的是"两个不同人同批次并发确认"这一并发面本身，需要
// 至少 2 人才谈得上"两人并发"；[决策 7 三修同步更正] 与系统性下限无关——R-GATE 现只需在册人数≥1，
// 单人批次本身已合法，本组选 2 人纯粹是"并发"这个测试主题自身要求，非闸门强制）。
const dev6Tok = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);
let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const png = Buffer.from('89504e470d0a1a0a', 'hex');
// multipart 上传（F3：附件写串行化证明）
function upload(p, tok, fields, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysMutexBoundary' + (p.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(png); chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
let passed = 0; const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 推到「开发中」（create→assign→estimate·受理排期改造：schedule 退场·建单直落待指派），供附件上传
async function seedInProgress() {
  const id = (await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'a', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 })).body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  //   ⚠️ 本 seed 原先各步均不断言，一旦前置态错就只在最终断言处露出一个**看不懂的**结果
  //     （C2.5 编码期实测：publish 用例报 [409,409]，真因是 seed 早就断在这里）。新增步一律断言。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」→ 补一步受理（→待指派）才能 assign
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  const oa1 = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(oa1.status, 200, `夹具补 OA 号 200, got ${oa1.status} ${JSON.stringify(oa1.body)}`);
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  // 2026-08-01 修复：原调用未断言返回值，estimate 若因日期字面量到期而 400 会被静默吞掉，症状漂移到
  //   下游（本文件 ②「安排上线」断言处才炸出 RELEASE_EMPTY，掩盖真根因）——补断言让同类问题当场炸出。
  const estR = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(estR.status, 200, `夹具 seedInProgress estimate 200, got ${estR.status} ${JSON.stringify(estR.body)}`);
  return id;
}

async function seedToReady() {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段·断言不省
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, `夹具补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本文件测并发事务串行化（mutex），与
  // 「待对接测试」段本身无关（后者由专门的 verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时
  // 失效，触发 §3.0-⑥ 降级路径，使 submit 仍直落"待验证"→可立即 accept 到"待上线"——本文件其余断言
  // 零改动，这也是方案承认的合法真实场景（非造假绕过）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  // 2026-08-01 修复：同 seedInProgress，补返回值断言（原静默吞 400 会让本函数产出的"待上线"单实际上
  //   卡在开发中，症状要到下游用例才炸出）。
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, `夹具 seedToReady estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-22' }], self_tested: true, test_env_deployed: true });
  await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  // status 列：C3 后端批新增用例需要 hasReleaseEligibility(userId)（SELECT status, role FROM users），
  //   该函数原不在本文件的 sys 覆盖范围内，users 夹具此前无需 status 列——现补上（DEFAULT 'active'）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),(6,'dev6','开发乙','user','active'),(13,'wangtaotao','示例对接人','user','active')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });

  // ── 1. 并发建单（30 并发）：全 201 + id 互异 + 零 500（无 nested-transaction 交错）──────────
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, (_, k) =>
    call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'concurrent-' + k, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 })));
  const created201 = results.filter(r => r.status === 201);
  const errs500 = results.filter(r => r.status === 500);
  assert.strictEqual(errs500.length, 0, `并发建单不应有 500（nested-transaction），实际 ${errs500.length} 个：` + JSON.stringify(errs500.map(e => e.body)));
  assert.strictEqual(created201.length, N, `${N} 并发建单应全 201，实际 ${created201.length}`);
  const ids = new Set(created201.map(r => r.body.id));
  assert.strictEqual(ids.size, N, '并发建单 id 应全互异（无丢失/覆盖）');
  const dbCount = (await get("SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE 'concurrent-%'")).c;
  assert.strictEqual(dbCount, N, `库内应恰好 ${N} 条并发单（无部分提交丢失）`);
  ok(`并发建单 ${N} 个：全 201 + id 互异 + 库内 ${N} 条 + 零 500（mutex 串行化无交错）`);

  // ── 2. ⭐ 并发双击 execute（C4 审 finding 直击场景，C3 后端批改造，C3 行级子表重写）──────────
  //   ⚠️ 原用例并发双击 legacy /sys-releases/:id/publish——C3（上线体统一重构）已把该端点收窄为全类型
  //   409（LEGACY_RELEASE_FLOW_DISABLED，见 index.js 路由处注释），响应体不再触发任何 DB 写入/事务，
  //   mutex 串行化在该端点上已无"并发交错"这个风险面可测。finding 的真实关注点——"两个并发请求同时
  //   写同一行的多步事务，mutex 是否真的把它们串行化、不出现 nested-transaction 脏态"——现由
  //   _publishReleaseCoreInTxn 唯一 HTTP 可达入口 /sys-releases/:id/execute 承接，改测它：**同一执行人
  //   行**两次并发 execute（同 devTok、同 executor_row_id，走真实 API，非 SQL 捷径）。
  //   ⭐ C3 语义变化（301-M3 过渡夹具兑现 + 断言过时→改写）：新模型 R-GATE 要求在册人数≥1 且全员
  //   done（决策 7 三修下限 2→1）——本组仍选 2 人在册（同 :46 一带说明，"并发"这个测试主题本身需要
  //   至少 2 人才谈得上"两人并发"），先让第二位执行人（user 6）非并发地确认完，铺垫成"只差 devTok(5)
  //   一人"的局面，再对 5 的
  //   同一行发起两次并发确认。旧版本"败者 409 RELEASE_NOT_PLANNING"这条断言不再成立——新模型下"败者"
  //   落进 §4.3 幂等三分诊②（done 优先于通知态），是 200 幂等成功（already:true）而非报错，这是"确认"
  //   语义（非"发布"语义）与"双击不报错"设计哲学的直接体现，非实现缺陷。
  const relId = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
  const iss = await seedToReady();
  await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [iss] });
  // RELEASE 中心守卫要求在册开发≥1 且全完成态——seedToReady()（本文件既有）的 assign 步骤已经给
  //   devTok(5) 建了一条 dev_assignees 在册行（dev_status 默认 'pending'），这里只需把它推成完成态
  //   （UPDATE 而非 INSERT——重复 INSERT 会撞 idx_sys_dev_assignee_active 部分唯一索引）。
  await run(
    `UPDATE sys_issue_dev_assignees SET dev_status='no_code', resolved_at=datetime('now')
       WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`,
    [iss]
  );
  // C3：行级子表两人在册（PUT executors 真实 API + 置 sent，非 SQL 直钉批次级列）。
  const rSetExec = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5, 6] });
  assert.strictEqual(rSetExec.status, 200, `夹具 PUT executors 200, got ${rSetExec.status} ${JSON.stringify(rSetExec.body)}`);
  const execRowsMutex = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  const rowIdOf5 = execRowsMutex.find(r => r.user_id === 5).id;
  const rowIdOf6 = execRowsMutex.find(r => r.user_id === 6).id;
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
  // 第二位执行人（6）先非并发确认完，铺垫成"只差 5 一人"的局面。
  const rPre6 = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { executor_row_id: rowIdOf6 });
  assert.strictEqual(rPre6.status, 200, `夹具 6 先确认 200, got ${rPre6.status} ${JSON.stringify(rPre6.body)}`);
  assert.strictEqual(rPre6.body.released, false, '夹具 6 先确认，还差 5 一人');

  const [p1, p2] = await Promise.all([
    call('POST', `/api/sys-releases/${relId}/execute`, devTok, { release_note: '并发上线说明', version_tag: 'v9.9.9', executor_row_id: rowIdOf5 }),
    call('POST', `/api/sys-releases/${relId}/execute`, devTok, { release_note: '并发上线说明', version_tag: 'v9.9.9', executor_row_id: rowIdOf5 }),
  ]);
  const pubStatuses = [p1.status, p2.status].sort();
  assert.deepStrictEqual(pubStatuses, [200, 200], `并发双击 execute（同一行）应两次均 200（赢家真翻牌 + 败者幂等成功），实际 ${JSON.stringify(pubStatuses)}（500=nested-transaction 脏态；409=旧模型残留断言，C3 后败者是幂等 200 不是报错）`);
  const winner = [p1, p2].find(r => r.body.released === true);
  const idempotentLoser = [p1, p2].find(r => r.body.already === true);
  assert.ok(winner, '并发双击应恰有一方 released=true（真正触发发布的赢家）');
  assert.ok(idempotentLoser, '并发双击应恰有一方 already=true（幂等成功的败者，§4.3 分诊②，非报错）');
  assert.strictEqual(idempotentLoser.body.released, true, '败者的幂等响应 released 如实反映批次已发布=true（读到赢家已提交的终态）');
  const relRow = await get('SELECT status, release_note, version_tag FROM sys_releases WHERE id=?', [relId]);
  assert.strictEqual(relRow.status, '已发布', '批次终态=已发布');
  assert.strictEqual(relRow.release_note, '并发上线说明', '⭐ release_note 完好非 NULL（脏态不可达，闸门③ 不被违反）');
  assert.strictEqual(relRow.version_tag, 'v9.9.9', 'version_tag 完好');
  const issRow = await get('SELECT status, released_at FROM sys_issues WHERE id=?', [iss]);
  assert.strictEqual(issRow.status, '已上线', '组内单翻已上线');
  assert.ok(issRow.released_at, 'released_at 落');
  const relTl = await all("SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'", [iss]);
  assert.strictEqual(relTl.length, 1, 'release timeline 恰 1 条（无重复写入）');
  ok('⭐ 并发双击 execute（同一行，C3 行级子表改写）：两次均 200（赢家 released=true 真翻牌 + 败者 already=true 幂等成功，非 409 报错）+ 批次已发布 release_note 完好 + 单翻已上线 + release timeline 仅 1 条（finding 脏态不可达，C3 改测新唯一发布入口，败者走§4.3幂等分诊而非错误）');

  // ── 3. 并发混合事务（建单 + 建批次 + assign 各 10）：零 500 ──────────
  //   受理排期改造：schedule 退场·并发写目标改用 assign（建单直落待指派→并发指派各进开发中·10 个独立单不互斥）。
  const drafts = await Promise.all(Array.from({ length: 10 }, (_, k) =>
    call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'improvement', title: 'mix-' + k, system_name: 'OA', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 })));
  // ⭐ 角色权限重构 C0：建单恒落受理门前段 → 并发 assign 前先串行推到「待指派」（assign 的合法前置态）。
  //   ⭐ v2.1（C2.5 撤销）：improvement 属变更流，建单落「待受理」→ 直接 intake-accept；随后补 OA 号
  //   （assign 前置校验，§4）——三步都串行。
  //   刻意串行：本用例测的是 **assign 并发**不产生 500，前置只是夹具，串行可排除夹具本身的并发噪音。
  for (const d of drafts) {
    // ⭐ 用户拍板批1改造B：improvement 受理必填 risk_level（原空 body 会 400，本组夹具全是 improvement）。
    const a = await call('POST', `/api/sys-issues/${d.body.id}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(a.status, 200, `夹具受理 200, got ${a.status} ${JSON.stringify(a.body)}`);
    const oa = await call('POST', `/api/sys-issues/${d.body.id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(oa.status, 200, `夹具补 OA 号 200, got ${oa.status} ${JSON.stringify(oa.body)}`);
  }
  const mixed = await Promise.all([
    ...Array.from({ length: 10 }, (_, k) => call('POST', '/api/sys-releases', adminTok, { title: 'mix-rel-' + k })),
    ...drafts.map(d => call('POST', `/api/sys-issues/${d.body.id}/assign`, adminTok, { assigned_to: 5 })),
  ]);
  const mix500 = mixed.filter(r => r.status === 500);
  assert.strictEqual(mix500.length, 0, '并发混合事务零 500，实际：' + JSON.stringify(mix500.map(e => e.body)));
  const allAssigned = mixed.filter(r => r.body && r.body.status === '开发中').length;
  assert.strictEqual(allAssigned, 10, '10 个 assign 全成功（开发中）');
  ok('并发混合事务（建单/建批次/assign 各 10）：零 500 + assign 全成（schedule 退场后改测 assign 并发）');

  // ── 4. F3a：事务内错误早退（inline sysRollback return）后锁不泄漏 ──────────
  const badRel = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
  for (let k = 0; k < 5; k++) {
    const r = await call('POST', `/api/sys-releases/${badRel}/add-issues`, adminTok, { issue_ids: [990000 + k] });   // 不存在/不可加 → 409 inline rollback
    assert.strictEqual(r.status, 409, '不可加单 → 409 inline rollback');
  }
  const afterErr = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'after-err', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(afterErr.status, 201, '错误早退 5 次后建单仍 201（inline rollback 未泄漏锁）');
  ok('F3a：事务内错误早退后建单成功（inline sysRollback 锁不泄漏）');

  // ── 5. ⭐ F3b：附件写串行化（F1 修复直证）——并发上传交付附件 + 并发建单，全成 + 行全持久 + 零 500 ──────────
  const att1 = await seedInProgress(); const att2 = await seedInProgress();
  const attRes = await Promise.all([
    ...Array.from({ length: 6 }, (_, k) => upload(`/api/sys-issues/${att1}/attachments`, devTok, { attachment_type: 'delivery' }, `a${k}.png`)),
    ...Array.from({ length: 6 }, (_, k) => upload(`/api/sys-issues/${att2}/attachments`, devTok, { attachment_type: 'delivery' }, `b${k}.png`)),
    ...Array.from({ length: 6 }, (_, k) => call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'cc' + k, system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 })),
  ]);
  const att500 = attRes.filter(r => r.status === 500);
  assert.strictEqual(att500.length, 0, '并发上传+建单零 500（附件 INSERT 已纳入 mutex 不交错），实际：' + JSON.stringify(att500.map(e => e.body)));
  const okUploads = attRes.filter(r => r.status === 200 && r.body && r.body.ok).length;
  assert.strictEqual(okUploads, 12, '12 个并发上传全 200');
  const rowCnt = (await get("SELECT COUNT(*) AS c FROM sys_issue_attachments WHERE issue_id IN (?,?) AND status='active'", [att1, att2])).c;
  assert.strictEqual(rowCnt, 12, `两单共 12 行附件全持久（无被并发事务回滚丢失），实际 ${rowCnt}`);
  ok('⭐ F3b：并发上传 12 附件 + 并发建单 6：全成 + 12 行全持久 + 零 500（附件写已串行化，不被他事务回滚）');

  console.log(`\n✅ verify-sys-mutex 全部通过（${passed} 项断言）`);
  server.close();
}
main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
