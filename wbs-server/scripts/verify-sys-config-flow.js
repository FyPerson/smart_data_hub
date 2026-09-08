// 验证脚本：系统迭代 config（配置变更）第 4 类型激活 · 后端状态机与端点（S1a）
//   用法：node scripts/verify-sys-config-flow.js
//   真相源：docs/local/系统迭代/config流激活_方案_20260907_v1.0.md（§3 动作级对照表、§4 常量与读侧）
//
// 覆盖（编号对应报告用）：
//   [A] 建单（对接人必填 400 / 正向 → 待受理）
//   [B] 受理（risk_level 缺 400 / 提供 → 待处理 D15）
//   [C] 指派 exec_mode/vendor_name 契约（缺/非法/vendor 必填名称/非 config 携带 400）
//   [D] 两成员逐次 no_code 提交 + 成员增删重算
//   [E] no_code_reason 长度分层（9/10/500/501 码点 + 补充平面字符）
//   [F] submit 带 commits → 400 CONFIG_NO_COMMITS
//   [G] add/edit/delete-commit 对 config 三端点 → 400 CONFIG_NO_COMMITS
//   [H] accept online_mode 契约（缺/非法/release 不直翻/direct 直翻/非 config 携带 400）
//   [H-close] config close 正向（有 assignee 200）+ reopen 仍 400（补丁 U·与 bug-transitions 无 assignee 负例镜像）
//   [I] reassign exec_mode/vendor_name（仅方式变化 200 不动成员/三者不变 409/非 config 携带 400）
//   [J] hold 四态 + resume 逐态回原态
//   [K] issue_reject 前置守卫（无 tech_lead_comment 409 / 有 → 200）+ reactivate
//   [L] void
//   [M] reopen 唯一错误码（跨态同码）
//   [N] feasibility/blocked/unblock/scope_change/liaison_test_* 对 config 拒绝
//   [O] 通知（developer/creator/requester/intake 四通道状态白名单）
//   [P] RELEASABLE_TYPES/RELEASE_FAMILY_BY_TYPE 常量 + add-issues 200（S1b 翻转：DB CHECK 已移除）
//   [U] 上线单整行（S1b 验收条件）：纯 config 批次 execute / 混批 / 撤单重挂 / 撤批 / 执行失败路径 /
//       DIRECT_ONLINE_NOT_ELIGIBLE 端到端负例 / [U7]待上线挂批次后 hold / [U8]同 void（S1d 新增，
//       方案 §7「待上线挂批次后 hold/void」缺口——真实 add-issues 挂批次后核 hold/void 实际行为：
//       均放行且不清 release_id，遗留的悬空批次关联由 [U5] 同款 execute 安全网兜底）
//   [Q] 对照组：improvement 关键节点零回归
//   [R] set-oa-number 对 config 的可填窗口（补丁 R，SYS_OA_ALLOWED_STATUSES.config）
//   [S] config reassign 族门 override（补丁 T·T3/H4，待处理/已暂缓均拒）
//   [T] config return（验收打回 待验证→处理中，补丁 T·M4）
//   [L4] 通知状态白名单前后端字面量对拍（S1d 新增，S1c 预筛转入）：SI_NOTIFY_*/SYS_NOTIFY_* 八对
//       常量逐值对拍，覆盖 config 专属 1 对 + 既有 bug/feature+improvement 三类型共 7 对，防第 4 份
//       （及既有 3 份）手抄副本漂移
//   [V] config × 验收附件两步链（S1d 新增，方案 §7「打回后重提旧截图不误绑」缺口）：return 携附件
//       200+payload_json 精确形状；打回→重提跨轮后旧截图仍 active；二轮 accept 复用旧截图 id 200
//       （引擎无 round 概念）+ attachment_ids/online_mode 两键共存精确形状；跨单附件仍 400
//   [X] accept 重复请求与状态竞争（S1d 新增，方案 §7 缺口；补丁AJ·AJ4 订正措辞·codex 515-M4）：
//       并发两次 accept 恰一成功一失败（400 INVALID_TRANSITION），无 expected_status 前置锁靠状态机
//       fromStatus 精确匹配天然堵重复推进——本组证明的是"调用生命周期重叠 + 重复请求下的最终一致"，
//       **不是**独立证明 sysTxnMutex 事务级串行化本身（未做服务端插桩记录两请求进入临界区的实际
//       顺序，不把本测试当作 mutex 判别证据）
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');   // [S1d·L4] 前后端常量对拍需读取 Sys_Iteration.html 源文件
const fs = require('fs');       // [S1d·L4] 同上
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-config-flow-secret';
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
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

// 夹具用户（id 与生产 users.id 无对应关系，仅按角色白名单常量建模，同本模块既有 verify 脚本惯例）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '管理员乙', role: 'admin' }, SECRET);
const intakeTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);      // 技术负责人
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const dev3Tok = jwt.sign({ id: 8, username: 'dev3', display_name: '开发赵', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// [S1d·补丁AI·AI7 根治·codex 514-M7→补丁AJ·AJ4 订正措辞·codex 515-M4] call() 时间戳变体——供 [X]
// 组证明"两次调用生命周期重叠"（均未等待对方完成即发起）。带 sentAt（`http.request` **创建之前**
// 打点，故仍含 JS 调用点之后到实际连接池排队/DNS/TCP 握手完成之前的这段耗时——不是"字节真正上线"
// 的时刻）/recvAt（收到完整响应后打点），可选传入独立 agent（不依赖 http.globalAgent 的
// maxSockets:Infinity 这一运行时默认，显式声明"两次调用允许并发"这一前提，不把测试的判别力建立在
// 一个可能被外部改动的全局默认值上）。**如实声明限度**：sentAt 的记录时机决定了它不能用来判断
// "请求是否真的同时在网络层飞行"——即便客户端连接池把两次请求强制排成串行（如 maxSockets:1），两次
// `callTimed(...)` 在同一微任务里背靠背同步调用，sentAt 仍会记录得几乎同时，"重叠"判据对这种情形
// 没有分辨力，不能作为"maxSockets 收紧必判红"的证据。
function callTimed(method, p, tok, body, agent) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const sentAt = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null, sentAt, recvAt: Date.now() })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// [S1d·V 组] multipart 上传——同 verify-sys-accept-evidence.js upload() 逐字同源范式（改动仅
//   boundary 前缀，防两文件并发跑时理论上的 boundary 撞车，虽然实际不共享连接/端口）。
const png = Buffer.from('89504e470d0a1a0a', 'hex');
function upload(p, tok, fields, fileName, fileBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysConfigFlowEvidenceBoundary' + (p.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(fileBuf || png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const rowOf = async (id) => get('SELECT * FROM sys_issues WHERE id=?', [id]);

// ── 建单 helper（type 默认 config；requester_phone 供 requester 通道用）──────────
function createBody(type, extra = {}) {
  return { intake_contract_version: 2, type, title: `${type}-S1a`, system_name: 'BMS', source: '内部',
    requester_phone: '13800000009',
    description: 'S1a verify 夹具：config 流激活场景建单', intake_liaison_id: 13, ...extra };
}
async function create(type, extra = {}) {
  return call('POST', '/api/sys-issues', adminTok, createBody(type, extra));
}

// 建单 → 受理（risk_level 必填，D15）→ 落「待处理」（config）/「待指派」（feature/improvement）
async function mkAssignable(type, riskLevel = '二级') {
  const r = await create(type);
  assert.strictEqual(r.status, 201, `建 ${type} 单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const acc = await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, adminTok, { risk_level: riskLevel });
  assert.strictEqual(acc.status, 200, `${type} 受理 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
  // 变更流（feature/improvement）assign 前置要求 OA 号通过校验（bug/config 不受限，assertSysDevCommitmentOaGuard
  // 首行 type guard 直接 return）——本 helper 名为"可指派"，一并补齐，避免下游 assign 调用误撞
  // ASSIGN_REQUIRES_OA_NUMBER（与本文件测试目的无关的噪音），同 verify-sys-role-perm-c1.js mkAssignable 既有范式。
  if (type === 'feature' || type === 'improvement') {
    const oa = await call('POST', `/api/sys-issues/${r.body.id}/set-oa-number`, adminTok, { oa_number: '2026090001' });
    assert.strictEqual(oa.status, 200, `${type} 补 OA 号 200, got ${oa.status} ${JSON.stringify(oa.body)}`);
  }
  return r.body.id;
}

// config 专属指派（exec_mode 必带）
async function assignConfig(id, execMode = 'assigned', extra = {}) {
  return call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, exec_mode: execMode, ...extra });
}
// [S1d·V/W 组] config 单快速夹具：建单 → 受理 → 指派 → estimate → no_code 提交 → 落「待验证」。
//   单开发成员最短路径（同 [D] 组 dev5 单人分支同款调用序列，不含成员增删场景）。
async function mkConfigToVerify(execMode = 'self', reason) {
  const id = await mkAssignable('config');
  const asg = await assignConfig(id, execMode);
  assert.strictEqual(asg.status, 200, `夹具：指派(${execMode}) 200, got ${asg.status} ${JSON.stringify(asg.body)}`);
  const est = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
  assert.strictEqual(est.status, 200, `夹具：estimate 200, got ${est.status} ${JSON.stringify(est.body)}`);
  const sub = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: reason || '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
  assert.strictEqual(sub.status, 200, `夹具：submit no_code 200, got ${sub.status} ${JSON.stringify(sub.body)}`);
  assert.strictEqual(sub.body.main_status, '待验证', `夹具：submit 后应到待验证, got ${sub.body.main_status}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(2,'admin2','管理员乙','admin','13800000002'),
    (5,'dev','开发王','user','13800000005'),(6,'dev2','开发李','user','13800000006'),
    (8,'dev3','开发赵','user','13800000008'),
    (7,'shenjun','示例发布者','publisher','13800000007'),
    (13,'wangtaotao','示例对接人','user','19900000024')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1/admin2 / 受理人13 / 技术负责人7 / dev5,6,8）');

  // ═══ [A] 建单 ═══
  {
    const noLiaison = await call('POST', '/api/sys-issues', adminTok, { ...createBody('config'), intake_liaison_id: undefined });
    assert.strictEqual(noLiaison.status, 400, `[A] config 建单缺对接人应 400, got ${noLiaison.status} ${JSON.stringify(noLiaison.body)}`);
    assert.strictEqual(noLiaison.body.code, 'INTAKE_LIAISON_REQUIRED', '[A] 缺对接人 code=INTAKE_LIAISON_REQUIRED');

    const r = await create('config');
    assert.strictEqual(r.status, 201, `[A] config 正向建单应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(r.body.id), '待受理', '[A] config 建单恒落「待受理」');

    // [S1a 补丁 W·W2①·B1-M2] 在沙箱库直接 UPDATE intake_required=0 → 应被触发器拒绝（SQL 夹具生产
    //   不可达——真实业务从无写路径能把 intake_required 改成 0，这里验证的是 DB 层不变量本身仍然生效，
    //   不是业务流程；同 verify-sys-intake-gate.js [TRG] 既有范式，逐字复用其 /intake_required/ 断言写法）。
    const tlCountBeforeTrg = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [r.body.id])).c;
    // [S1a 补丁 X·X5·codex 506-B #3] 判定函数精确化——不再只匹配错误消息的正则（可能被任何含
    //   "intake_required" 字样的无关错误误判为通过），而是同时要求 err.code==='SQLITE_CONSTRAINT'
    //   （真实约束/触发器失败的驱动层错误码，实测确认 sqlite3 对 RAISE(ABORT,...) 会设置该 code）
    //   且 message 含 "intake_required"，两者同时成立才判定为本触发器命中。
    await assert.rejects(
      run(`UPDATE sys_issues SET intake_required=0 WHERE id=?`, [r.body.id]),
      (err) => err && err.code === 'SQLITE_CONSTRAINT' && /intake_required/.test(err.message || ''),
      '[A] 触发器应拒绝把 config 单的 intake_required 改回 0（C0 焊死受理门，SQL 夹具验证 DB 不变量；err.code=SQLITE_CONSTRAINT 且 message 含 intake_required，补丁 X·X5）'
    );
    const rowAfterTrg = await rowOf(r.body.id);
    assert.strictEqual(rowAfterTrg.intake_required, 1, '[A] 触发器拒绝后 intake_required 仍为 1');
    assert.strictEqual(rowAfterTrg.status, '待受理', '[A] 触发器拒绝后 status 仍为待受理（未被误动）');
    const tlCountAfterTrg = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [r.body.id])).c;
    assert.strictEqual(tlCountAfterTrg, tlCountBeforeTrg, '[A] 触发器拒绝后 timeline 行数不变（零副作用）');

    // [S1a 补丁 W·W2②] GET meta 的 execModes 与 _internals.SYS_EXEC_MODES 同值（同一份真相源，前端读
    //   meta 渲染选项，不硬编码字面量；HTTP 往返经 JSON 序列化，只能证值相等，不证同一引用）。
    const metaResp = await call('GET', '/api/sys-issues/meta', adminTok);
    assert.strictEqual(metaResp.status, 200, `[A] GET /sys-issues/meta 应 200, got ${metaResp.status} ${JSON.stringify(metaResp.body)}`);
    assert.deepStrictEqual(metaResp.body.execModes, ['self', 'assigned', 'vendor'], '[A] meta execModes 恰为 [self,assigned,vendor]');
    assert.deepStrictEqual(metaResp.body.execModes, I.SYS_EXEC_MODES, '[A] meta execModes 与 _internals.SYS_EXEC_MODES 同值（同一份真相源）');

    // [S1a 补丁 X·X1·codex 506-A M1] change_intake_mode 条目已从 config 删除（config 是新类型，无历史
    //   timeline 行/无兼容需求，且路由已全类型恒 409）；improvement 仍含（三既有流阶段 2 才删）。
    //   「实现坏成什么样这条会红」：有人把条目加回 CONFIG_FLOW_TRANSITIONS → 本条会红。
    const configActionsX1 = (metaResp.body.typeFlows.config || []).map(t => t.action);
    assert.ok(!configActionsX1.includes('change_intake_mode'), '[A] typeFlows.config 不含 change_intake_mode（补丁 X·X1）');
    const improvementActionsX1 = (metaResp.body.typeFlows.improvement || []).map(t => t.action);
    assert.ok(improvementActionsX1.includes('change_intake_mode'), '[A] typeFlows.improvement 仍含 change_intake_mode（三既有流未动，阶段 2 才删）');

    ok('[A] 建单：缺对接人 400 INTAKE_LIAISON_REQUIRED；正向 201 → 待受理；触发器拒绝 intake_required=0（DB 不变量，零副作用）；meta execModes 与 _internals.SYS_EXEC_MODES 同值（补丁 W·W2）；typeFlows.config 不含 change_intake_mode，improvement 仍含（补丁 X·X1）');
  }

  // ═══ [B] 受理 ═══
  {
    const r = await create('config');
    const id = r.body.id;
    const noRisk = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(noRisk.status, 400, `[B] config 受理缺 risk_level 应 400, got ${noRisk.status} ${JSON.stringify(noRisk.body)}`);
    assert.strictEqual(noRisk.body.code, 'RISK_LEVEL_REQUIRED', '[B] 缺 risk_level code=RISK_LEVEL_REQUIRED（D15 风险等级适用 config）');

    const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '一级' });
    assert.strictEqual(acc.status, 200, `[B] config 受理（带 risk_level）应 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
    assert.strictEqual(await statusOf(id), '待处理', '[B] config 受理后落「待处理」（状态名替换）');
    assert.strictEqual((await rowOf(id)).risk_level, '一级', '[B] risk_level 落库');
    ok('[B] 受理：缺 risk_level 400 RISK_LEVEL_REQUIRED；提供 → 200 + 待处理 + risk_level 落库（D15）');
  }

  // ═══ [C] 指派 exec_mode/vendor_name 契约 ═══
  {
    const id1 = await mkAssignable('config');
    const noMode = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(noMode.status, 400, `[C] 缺 exec_mode 应 400, got ${noMode.status} ${JSON.stringify(noMode.body)}`);
    assert.strictEqual(noMode.body.code, 'EXEC_MODE_REQUIRED', '[C] 缺 exec_mode code=EXEC_MODE_REQUIRED');

    const badMode = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, exec_mode: 'outsourced' });
    assert.strictEqual(badMode.status, 400, `[C] 非法 exec_mode 应 400, got ${badMode.status} ${JSON.stringify(badMode.body)}`);
    assert.strictEqual(badMode.body.code, 'INVALID_EXEC_MODE', '[C] 非法 exec_mode code=INVALID_EXEC_MODE');

    const vendorNoName = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, exec_mode: 'vendor' });
    assert.strictEqual(vendorNoName.status, 400, `[C] vendor 缺 vendor_name 应 400, got ${vendorNoName.status} ${JSON.stringify(vendorNoName.body)}`);
    assert.strictEqual(vendorNoName.body.code, 'VENDOR_NAME_REQUIRED', '[C] vendor 缺名称 code=VENDOR_NAME_REQUIRED');

    const vendorLongName = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, exec_mode: 'vendor', vendor_name: '甲'.repeat(101) });
    assert.strictEqual(vendorLongName.status, 400, `[C] vendor_name 101 字应 400, got ${vendorLongName.status} ${JSON.stringify(vendorLongName.body)}`);
    assert.strictEqual(vendorLongName.body.code, 'VENDOR_NAME_REQUIRED', '[C] vendor_name 超长同码 VENDOR_NAME_REQUIRED');

    // [S1a 补丁 T·L6] 纯空白 vendor_name → 400（trim 后为空串，同「未填」同码）——边界此前只测了超长单侧。
    const vendorBlankName = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, exec_mode: 'vendor', vendor_name: '   ' });
    assert.strictEqual(vendorBlankName.status, 400, `[C] vendor_name 纯空白应 400, got ${vendorBlankName.status} ${JSON.stringify(vendorBlankName.body)}`);
    assert.strictEqual(vendorBlankName.body.code, 'VENDOR_NAME_REQUIRED', '[C] vendor_name 纯空白同码 VENDOR_NAME_REQUIRED（trim 后为空串）');

    const vendorOk = await call('POST', `/api/sys-issues/${id1}/assign`, adminTok, { assigned_to: 5, exec_mode: 'vendor', vendor_name: '某乙方公司' });
    assert.strictEqual(vendorOk.status, 200, `[C] vendor + 合法名称应 200, got ${vendorOk.status} ${JSON.stringify(vendorOk.body)}`);
    assert.strictEqual(await statusOf(id1), '处理中', '[C] 指派后落「处理中」');
    const row1 = await rowOf(id1);
    assert.strictEqual(row1.exec_mode, 'vendor', '[C] exec_mode 落库=vendor');
    assert.strictEqual(row1.vendor_name, '某乙方公司', '[C] vendor_name 落库');
    // [S1a 补丁 W·W4·变异候选 2] 响应体展开项与落库一致——此前只回读库，若 assign 响应体的
    // exec_mode/vendor_name 展开项被删（响应体仍 200 但缺字段/字段错），只查库仍绿，本条会红。
    assert.strictEqual(vendorOk.body.exec_mode, 'vendor', '[C] 响应体 exec_mode=vendor 与落库一致');
    assert.strictEqual(vendorOk.body.vendor_name, '某乙方公司', '[C] 响应体 vendor_name 与落库一致');

    // [S1a 补丁 T·L6] vendor_name 恰 100 字（上限含边界）→ 200 通过正例——此前只测了 101 字拒绝单侧。
    const id1b = await mkAssignable('config');
    const vendorName100 = '乙'.repeat(100);
    const vendor100 = await call('POST', `/api/sys-issues/${id1b}/assign`, adminTok, { assigned_to: 5, exec_mode: 'vendor', vendor_name: vendorName100 });
    assert.strictEqual(vendor100.status, 200, `[C] vendor_name 恰 100 字应 200（上限含边界）, got ${vendor100.status} ${JSON.stringify(vendor100.body)}`);
    assert.strictEqual((await rowOf(id1b)).vendor_name, vendorName100, '[C] vendor_name 恰 100 字落库全等原文');

    // self / assigned 两值 + 非 vendor 时 vendor_name 清空
    const id2 = await mkAssignable('config');
    const selfOk = await call('POST', `/api/sys-issues/${id2}/assign`, adminTok, { assigned_to: 5, exec_mode: 'self', vendor_name: '应被忽略清空' });
    assert.strictEqual(selfOk.status, 200, `[C] exec_mode=self 应 200, got ${selfOk.status} ${JSON.stringify(selfOk.body)}`);
    const row2 = await rowOf(id2);
    assert.strictEqual(row2.exec_mode, 'self', '[C] exec_mode=self 落库');
    assert.strictEqual(row2.vendor_name, null, '[C] 非 vendor 时 vendor_name 恒清空（即便请求体携带）');
    // [S1a 补丁 W·W4] 响应体展开项与落库一致——非 vendor 模式响应体 vendor_name 应为 null（不回显请求体
    // 携带的「应被忽略清空」字面量，证明响应体读的是归一化后的落库值而非透传请求体）。
    assert.strictEqual(selfOk.body.exec_mode, 'self', '[C] 响应体 exec_mode=self 与落库一致');
    assert.strictEqual(selfOk.body.vendor_name, null, '[C] 响应体 vendor_name=null（非 vendor 恒清空，与落库一致）');

    const id3 = await mkAssignable('config');
    const assignedOk = await call('POST', `/api/sys-issues/${id3}/assign`, adminTok, { assigned_to: 5, exec_mode: 'assigned' });
    assert.strictEqual(assignedOk.status, 200, `[C] exec_mode=assigned 应 200, got ${assignedOk.status} ${JSON.stringify(assignedOk.body)}`);
    assert.strictEqual((await rowOf(id3)).exec_mode, 'assigned', '[C] exec_mode=assigned 落库');
    assert.strictEqual(assignedOk.body.exec_mode, 'assigned', '[C] 响应体 exec_mode=assigned 与落库一致');
    assert.strictEqual(assignedOk.body.vendor_name, null, '[C] 响应体 vendor_name=null（非 vendor，与落库一致）');

    // 非 config 携带 exec_mode → 400 EXEC_MODE_NOT_APPLICABLE
    const impId = await mkAssignable('improvement', '二级');
    const impBad = await call('POST', `/api/sys-issues/${impId}/assign`, adminTok, { assigned_to: 5, exec_mode: 'self' });
    assert.strictEqual(impBad.status, 400, `[C] improvement 携带 exec_mode 应 400, got ${impBad.status} ${JSON.stringify(impBad.body)}`);
    assert.strictEqual(impBad.body.code, 'EXEC_MODE_NOT_APPLICABLE', '[C] 非 config 携带 exec_mode code=EXEC_MODE_NOT_APPLICABLE');
    assert.strictEqual(await statusOf(impId), '待指派', '[C] improvement 被拒后状态原样（仍待指派，未被误指派）');

    ok('[C] 指派 exec_mode/vendor_name：缺/非法/vendor 缺名/超长/纯空白 均 400；恰 100 字边界 200；self/assigned/vendor 三值落库正确+响应体展开项与落库一致（补丁 W·W4）、非 vendor 清空；非 config 携带 400 EXEC_MODE_NOT_APPLICABLE 且状态原样');
  }

  // ═══ [D] 两成员逐次 no_code 提交 + 成员增删重算 ═══
  let dId;   // 供 [E]/[F]/[G]/[H] 等复用一张已到「待验证」的单
  {
    const id = await mkAssignable('config');
    const asg = await assignConfig(id, 'assigned');
    assert.strictEqual(asg.status, 200, 'D 夹具：指派 200');
    const est = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(est.status, 200, `[D] config /estimate 应 200（W06 isW06Allowed 需含 config，见 status-families.js）, got ${est.status} ${JSON.stringify(est.body)}`);

    const add6 = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(add6.status, 200, `[D] 加协作开发 dev6 应 200, got ${add6.status} ${JSON.stringify(add6.body)}`);

    const s1Reason = '已在测试环境完成参数校验与验证';
    const s1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: s1Reason, self_tested: true, test_env_deployed: true });
    assert.strictEqual(s1.status, 200, `[D] dev5 no_code 提交应 200, got ${s1.status} ${JSON.stringify(s1.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[D] 第一人提交后仍「处理中」（dev6 未完成）');
    // [S1a 补丁 T·M3] 断成员行 dev_status/no_code_reason 落库——不止断主状态，防"submit 落
    //   code_submitted 而非 no_code 也能推进全员完成门"这类改坏了也绿的场景（D12 核心不变量）。
    const dev5Row = await get('SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    assert.strictEqual(dev5Row.dev_status, 'no_code', '[D] dev5 落库 dev_status=no_code（非 code_submitted）');
    assert.strictEqual(dev5Row.no_code_reason, s1Reason, '[D] dev5 落库 no_code_reason 为提交原文');

    // 成员增删重算：加 dev8（3 人：dev5 done + dev6 pending + dev8 pending）→ 仍处理中
    const add8 = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(add8.status, 200, `[D] 加协作开发 dev8 应 200, got ${add8.status} ${JSON.stringify(add8.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[D] 加人后仍「处理中」（新增 pending 成员）');
    const rosterAfterAdd = await all('SELECT id, user_id, dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY user_id', [id]);
    assert.strictEqual(rosterAfterAdd.length, 3, '[D] 加人后在册 3 人');

    // 移除 dev8（回到 dev5 done + dev6 pending）→ 仍处理中
    const dev8Row = rosterAfterAdd.find(r => Number(r.user_id) === 8);
    const rm8 = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${dev8Row.id}`, adminTok, { reason: '误加，移除' });
    assert.strictEqual(rm8.status, 200, `[D] 移除 dev8 应 200, got ${rm8.status} ${JSON.stringify(rm8.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[D] 移除 dev8 后仍「处理中」（dev6 仍 pending）');

    const s2Reason = '已完成配置变更并在测试环境确认';
    const s2 = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { mode: 'no_code', no_code_reason: s2Reason, self_tested: true, test_env_deployed: true });
    assert.strictEqual(s2.status, 200, `[D] dev6 no_code 提交应 200, got ${s2.status} ${JSON.stringify(s2.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[D] 全员完成后落「待验证」');
    const dev6Row = await get('SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6 AND removed_at IS NULL', [id]);
    assert.strictEqual(dev6Row.dev_status, 'no_code', '[D] dev6 落库 dev_status=no_code（非 code_submitted）');
    assert.strictEqual(dev6Row.no_code_reason, s2Reason, '[D] dev6 落库 no_code_reason 为提交原文');

    dId = id;
    ok('[D] 两成员逐次 no_code 提交（第一人后仍处理中、全员完成后待验证，各自 dev_status=no_code+no_code_reason 落库原文）+ 成员增删重算（加人不改态、移除已完成前不误判、剩余完成才推进）');
  }

  // ═══ [E] no_code_reason 长度分层（9/10/500/501 码点 + 补充平面字符）═══
  {
    // 独立造一张单（单成员，处理中态）反复测长度边界——失败的长度校验不写库，可重复提交同一实例。
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });

    const attempt = (reason) => call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true });

    const reason9 = '说'.repeat(9);   // 9 codepoints
    const r9 = await attempt(reason9);
    assert.strictEqual([...reason9].length, 9, '[E] 夹具自检：9 码点');
    assert.strictEqual(r9.status, 400, `[E] 9 码点应 400, got ${r9.status} ${JSON.stringify(r9.body)}`);
    assert.strictEqual(r9.body.code, 'VALIDATION', '[E] 9 码点 code=VALIDATION（配置说明需 10..500 字）');
    assert.strictEqual(await statusOf(id), '处理中', '[E] 失败后状态原样（未误推进，dev_status 仍 pending 可重试）');
    ok('[E-9] no_code_reason 9 码点 → 400 VALIDATION（config 10 码点下限，J17）');
  }

  // 重新独立验证 10/500/501 码点与补充平面字符（拆开写，避免上面自检占位句误导断言真值）
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const attempt = (reason) => call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true });

    const reason10 = '十'.repeat(10);
    assert.strictEqual([...reason10].length, 10, '[E] 夹具自检：10 码点');
    const r10 = await attempt(reason10);
    assert.strictEqual(r10.status, 200, `[E-10] 10 码点应 200（下限含边界）, got ${r10.status} ${JSON.stringify(r10.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[E-10] 单成员单据全员完成 → 待验证');
    // [S1a 补丁 T·M3] 回读落库值——不止断 HTTP 200，防"事务内截断/丢弃/写空串仍 200"这类改坏了也绿的场景。
    const rec10 = await get('SELECT no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    assert.strictEqual([...rec10.no_code_reason].length, 10, '[E-10] 落库 no_code_reason 长度=10 码点（未被截断/丢弃）');
    assert.strictEqual(rec10.no_code_reason, reason10, '[E-10] 落库 no_code_reason 与提交原文全等');
    ok('[E-10] no_code_reason 恰 10 码点 → 200（含边界）+ 落库值回读全等原文');
  }
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const attempt = (reason) => call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true });

    const reason500 = '说'.repeat(500);
    assert.strictEqual([...reason500].length, 500, '[E] 夹具自检：500 码点');
    const r500 = await attempt(reason500);
    assert.strictEqual(r500.status, 200, `[E-500] 500 码点应 200（上限含边界）, got ${r500.status} ${JSON.stringify(r500.body)}`);
    // [S1a 补丁 T·M3] 回读落库值——同 [E-10]，防截断/丢弃/写空串仍 200。
    const rec500 = await get('SELECT no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    assert.strictEqual([...rec500.no_code_reason].length, 500, '[E-500] 落库 no_code_reason 长度=500 码点（未被截断）');
    assert.strictEqual(rec500.no_code_reason, reason500, '[E-500] 落库 no_code_reason 与提交原文全等');
    ok('[E-500] no_code_reason 恰 500 码点 → 200（含边界）+ 落库值回读全等原文');
  }
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const attempt = (reason) => call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true });

    const reason501 = '说'.repeat(501);
    assert.strictEqual([...reason501].length, 501, '[E] 夹具自检：501 码点');
    const r501 = await attempt(reason501);
    assert.strictEqual(r501.status, 400, `[E-501] 501 码点应 400（事务前公共上限，所有类型共享）, got ${r501.status} ${JSON.stringify(r501.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[E-501] 失败后状态原样');
    ok('[E-501] no_code_reason 501 码点 → 400（事务前 ≤500 码点公共上限，J17）');
  }
  {
    // 补充平面字符（emoji，每字符 1 码点·2 UTF-16 code unit）：300/500 个应通过（按码点计不超限，
    //   即便 UTF-16 code unit 数翻倍）——直接证明 J17"事务前改按码点判定"生效。
    const emoji = '\u{1F600}';   // 😀，1 码点 / 2 code unit
    const id1 = await mkAssignable('config');
    await assignConfig(id1, 'assigned');
    await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const reason300 = emoji.repeat(300);
    assert.strictEqual([...reason300].length, 300, '[E] 夹具自检：300 码点（emoji）');
    assert.strictEqual(reason300.length, 600, '[E] 夹具自检：600 UTF-16 code unit（emoji，验证码点≠码元）');
    const r300 = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { mode: 'no_code', no_code_reason: reason300, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r300.status, 200, `[E-emoji-300] 300 个补充平面字符（300 码点/600 code unit）应 200, got ${r300.status} ${JSON.stringify(r300.body)}`);
    // [S1a 补丁 T·M3] 回读落库值——防事务内按 code unit 二次截断（emoji 场景最容易漏，码点/码元分层
    //   正是本组要证明的核心）。
    const rec300 = await get('SELECT no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id1]);
    assert.strictEqual([...rec300.no_code_reason].length, 300, '[E-emoji-300] 落库 no_code_reason 长度=300 码点（未被按 code unit 截断）');
    assert.strictEqual(rec300.no_code_reason, reason300, '[E-emoji-300] 落库 no_code_reason 与提交原文全等');

    const id2 = await mkAssignable('config');
    await assignConfig(id2, 'assigned');
    await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const reason500e = emoji.repeat(500);
    assert.strictEqual([...reason500e].length, 500, '[E] 夹具自检：500 码点（emoji）');
    const r500e = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, { mode: 'no_code', no_code_reason: reason500e, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r500e.status, 200, `[E-emoji-500] 500 个补充平面字符（500 码点/1000 code unit）应 200（config 按码点判定，非 code unit）, got ${r500e.status} ${JSON.stringify(r500e.body)}`);
    const rec500e = await get('SELECT no_code_reason FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id2]);
    assert.strictEqual([...rec500e.no_code_reason].length, 500, '[E-emoji-500] 落库 no_code_reason 长度=500 码点（未被按 code unit 截断到 500 code unit≈250 emoji）');
    assert.strictEqual(rec500e.no_code_reason, reason500e, '[E-emoji-500] 落库 no_code_reason 与提交原文全等');
    ok('[E-emoji] 300/500 个补充平面字符（emoji，码点数=字符数但 code unit 数翻倍）均 200 + 落库值回读全等原文——证 J17 事务前公共上限已从码元改判码点');
  }

  // 对照组：非 config 类型仍按原 500 码元（code unit）上限——300 个 emoji（300 码点/600 code unit）
  //   pre-tx 按码点判定会通过（≤500），但 in-tx 对非 config 类型复核码元上限应拒绝（还原改前行为）。
  {
    const impId = await mkAssignable('improvement', '二级');
    const asg = await call('POST', `/api/sys-issues/${impId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asg.status, 200, '对照组夹具：improvement 指派 200');
    await call('POST', `/api/sys-issues/${impId}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const emoji = '\u{1F600}';
    const reason300 = emoji.repeat(300);   // 300 码点 / 600 code unit
    const r = await call('POST', `/api/sys-issues/${impId}/submit`, devTok, { mode: 'no_code', no_code_reason: reason300, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `[Q-长度回归] improvement 300 个 emoji（600 code unit）应仍 400（原 500 码元上限未被放宽）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VALIDATION', '[Q-长度回归] code=VALIDATION');
    ok('[Q-长度回归] 非 config 类型（improvement）仍受原 500 码元（code unit）上限约束，未因 J17 改动被放宽');
  }

  // ═══ [F] submit 带 commits → 400 CONFIG_NO_COMMITS ═══
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `[F] config 提交 commits 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'CONFIG_NO_COMMITS', '[F] code=CONFIG_NO_COMMITS（D12）');
    assert.strictEqual(await statusOf(id), '处理中', '[F] 被拒后状态原样');

    // [S1a 补丁 V·V3·codex 505-A M3] mode='no_code' 但携带非空 commits——此前统一被 validateSubmitBody
    //   事务外拦成 400 VALIDATION（config 到不了事务内的 CONFIG_NO_COMMITS）；现挪到事务内、assertDevMember
    //   之后，config 落 CONFIG_NO_COMMITS（与 mode='commits' 同码，不因 mode 字段写成 no_code 就分类成
    //   别的错误）。「实现坏成什么样这条会红」：若 V3 的事务内 config 分支（noCodeHasNonEmptyCommits 判据）
    //   被删/绕过，本条会从 400 CONFIG_NO_COMMITS 变回 400 VALIDATION（旧行为，事务外拦截）。
    const rNoCodeCommits = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', commits: [{ component: 'backend', commit_ref: 'r2' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(rNoCodeCommits.status, 400, `[F] config mode=no_code 携带非空 commits 应 400, got ${rNoCodeCommits.status} ${JSON.stringify(rNoCodeCommits.body)}`);
    assert.strictEqual(rNoCodeCommits.body.code, 'CONFIG_NO_COMMITS', '[F] mode=no_code 携带非空 commits code=CONFIG_NO_COMMITS（同 mode=commits，非事务外通用 VALIDATION）');
    assert.strictEqual(await statusOf(id), '处理中', '[F] mode=no_code 携带非空 commits 被拒后状态原样');

    // [S1a 补丁 X·X2·codex 506-A M3] 优先级验证：畸形体须先于状态合法性判定——即便单据当前状态非法
    //   （待验证，非 DEV 族），提交畸形体仍应 400（非 409 INVALID_STATUS）。「实现坏成什么样这条会红」：
    //   若 X2 的前置判定被挪回状态检查之后，本条会从 400 变 409 INVALID_STATUS。
    const idFX2 = await mkAssignable('config');
    await assignConfig(idFX2, 'assigned');
    await call('POST', `/api/sys-issues/${idFX2}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const s1FX2 = await call('POST', `/api/sys-issues/${idFX2}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(s1FX2.status, 200, 'X2 config 夹具：submit 200（进入待验证）');
    assert.strictEqual(await statusOf(idFX2), '待验证', 'X2 config 夹具：已到待验证（非 DEV 族，正是本组要验证的非法状态）');
    const rFX2Malformed = await call('POST', `/api/sys-issues/${idFX2}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置说明占位内容', commits: [{ component: 'backend', commit_ref: 'fx2-1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(rFX2Malformed.status, 400, `[F] config 待验证态（状态非法）+ 畸形体应仍 400（非 409）, got ${rFX2Malformed.status} ${JSON.stringify(rFX2Malformed.body)}`);
    assert.strictEqual(rFX2Malformed.body.code, 'CONFIG_NO_COMMITS', '[F] config 畸形体优先于状态合法性：code=CONFIG_NO_COMMITS（补丁 X·X2）');
    // 对照：同单据合法 no_code 体（无 commits）→ 409 INVALID_STATUS（证明只有畸形体优先，合法体仍受状态闸拦）
    const rFX2Legal = await call('POST', `/api/sys-issues/${idFX2}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置说明占位内容二', self_tested: true, test_env_deployed: true });
    assert.strictEqual(rFX2Legal.status, 409, `[F] config 待验证态 + 合法体应 409 INVALID_STATUS（对照组）, got ${rFX2Legal.status} ${JSON.stringify(rFX2Legal.body)}`);
    assert.strictEqual(rFX2Legal.body.code, 'INVALID_STATUS', '[F] config 合法体仍受状态闸拦截（补丁 X·X2 对照组）');

    ok('[F] submit 带 commits 对 config → 400 CONFIG_NO_COMMITS（D12）；mode=no_code 携带非空 commits 同样 400 CONFIG_NO_COMMITS（补丁 V·V3，事务内挪到 assertDevMember 之后）；畸形体优先于状态合法性 400（非 409），合法体仍受状态闸拦（补丁 X·X2）');
  }

  // ═══ [G] add/edit/delete-commit 对 config 三端点 → 400 CONFIG_NO_COMMITS ═══
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'assigned');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });

    // [S1a 补丁 T·T4] 排序验证：非在册用户 POST commit → 403（权限先于业务，T4 把 CONFIG_NO_COMMITS
    //   判定下移到 assertDevMember 之后的直接证据——若排序被误回退，非在册用户会拿到 400
    //   CONFIG_NO_COMMITS 而非 403，凭错误码差异即可探知"这单是 config 类型"）。dev3（id=8）未在本单
    //   roster 中（仅 dev5 已指派）。
    const postForbidden = await call('POST', `/api/sys-issues/${id}/dev/commits`, dev3Tok, { component: 'backend', commit_ref: 'nope' });
    assert.strictEqual(postForbidden.status, 403, `[G] 非在册用户 POST commits 应 403, got ${postForbidden.status} ${JSON.stringify(postForbidden.body)}`);
    assert.strictEqual(postForbidden.body.code, 'COMMIT_SCOPE', '[G] 非在册用户 POST commits code=COMMIT_SCOPE（权限判定，非业务判定）');

    const post = await call('POST', `/api/sys-issues/${id}/dev/commits`, devTok, { component: 'backend', commit_ref: 'x1' });
    assert.strictEqual(post.status, 400, `[G] POST commits 对 config 应 400, got ${post.status} ${JSON.stringify(post.body)}`);
    assert.strictEqual(post.body.code, 'CONFIG_NO_COMMITS', '[G] POST code=CONFIG_NO_COMMITS（在册用户，权限判定通过后才轮到业务判定）');

    // [S1a 补丁 T·M3] PUT/DELETE 改打**真实脏数据**（直接 SQL 塞一行归属该 config 单的 commit 记录），
    //   不再打空表上不存在的 id=1——config 单结构上永远产不出真实 commit 行，PUT/DELETE 命中的纵深防线
    //   唯一有意义的验证场景就是"万一脏数据出现了，闸门仍能拦住"，用不存在的 id 只证明了"空表上的守卫"。
    const devAssigneeRow = await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    assert.ok(devAssigneeRow, '[G] 夹具：dev5 在册行存在');
    const insCommit = await run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 5, 'backend', 'dirty-fixture-ref', datetime('now','localtime'))`,
      [id, devAssigneeRow.id]
    );
    const dirtyCommitId = insCommit.lastID;

    const put = await call('PUT', `/api/sys-issues/${id}/dev/commits/${dirtyCommitId}`, devTok, { component: 'backend', commit_ref: 'x2' });
    assert.strictEqual(put.status, 400, `[G] PUT commits 对 config 应 400, got ${put.status} ${JSON.stringify(put.body)}`);
    assert.strictEqual(put.body.code, 'CONFIG_NO_COMMITS', '[G] PUT code=CONFIG_NO_COMMITS');
    const afterPut = await get('SELECT commit_ref FROM sys_issue_dev_commits WHERE id=?', [dirtyCommitId]);
    assert.ok(afterPut, '[G] PUT 被拒后脏行仍在（零副作用）');
    assert.strictEqual(afterPut.commit_ref, 'dirty-fixture-ref', '[G] PUT 被拒后脏行内容未被改写');

    const del = await call('DELETE', `/api/sys-issues/${id}/dev/commits/${dirtyCommitId}`, devTok, { reason: '试删' });
    assert.strictEqual(del.status, 400, `[G] DELETE commits 对 config 应 400, got ${del.status} ${JSON.stringify(del.body)}`);
    assert.strictEqual(del.body.code, 'CONFIG_NO_COMMITS', '[G] DELETE code=CONFIG_NO_COMMITS');
    const afterDel = await get('SELECT id FROM sys_issue_dev_commits WHERE id=?', [dirtyCommitId]);
    assert.ok(afterDel, '[G] DELETE 被拒后脏行仍在（零副作用，纵深防线真守住脏数据而非只守空表）');

    ok('[G] add/edit/delete-commit 三写入口对 config 均 400 CONFIG_NO_COMMITS（PUT/DELETE 对真实脏数据行验证，零副作用，纵深防线）；非在册用户 POST 先 403 COMMIT_SCOPE（权限先于业务，T4 排序）');
  }

  // ═══ [H] accept online_mode 契约 ═══
  {
    // dId 来自 [D]，此刻处于「待验证」
    const noMode = await call('POST', `/api/sys-issues/${dId}/accept`, adminTok, {});
    assert.strictEqual(noMode.status, 400, `[H] 缺 online_mode 应 400, got ${noMode.status} ${JSON.stringify(noMode.body)}`);
    assert.strictEqual(noMode.body.code, 'ONLINE_MODE_REQUIRED', '[H] 缺 online_mode code=ONLINE_MODE_REQUIRED');

    const badMode = await call('POST', `/api/sys-issues/${dId}/accept`, adminTok, { online_mode: 'now' });
    assert.strictEqual(badMode.status, 400, `[H] 非法 online_mode 应 400, got ${badMode.status} ${JSON.stringify(badMode.body)}`);
    assert.strictEqual(badMode.body.code, 'INVALID_ONLINE_MODE', '[H] 非法值 code=INVALID_ONLINE_MODE');

    // release：零 commit 但不直翻——恒落「待上线」
    const rel = await call('POST', `/api/sys-issues/${dId}/accept`, adminTok, { online_mode: 'release' });
    assert.strictEqual(rel.status, 200, `[H] online_mode=release 应 200, got ${rel.status} ${JSON.stringify(rel.body)}`);
    assert.strictEqual(rel.body.status, '待上线', '[H] release → 待上线（即便零 commit 也不触发免上线直翻）');
    assert.strictEqual(rel.body.online_source, undefined, '[H] release 分支响应体不带 online_source（未直翻）');
    assert.strictEqual((await rowOf(dId)).release_id, null, '[H] release_id 仍为 NULL（未挂批次，只是落待上线）');
    // [S1a 补丁 T·T2·D11「选项写时间线」] release 分支 accept timeline payload_json 应含 online_mode='release'
    //   （actionCode='accept'，同一条 accept 行，非另写），且无 note/attachment_ids 时不写空键。
    const relTl = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept'`, [dId]);
    assert.ok(relTl && relTl.payload_json, '[H] release 分支 timeline payload_json 非空');
    const relPayload = JSON.parse(relTl.payload_json);
    assert.strictEqual(relPayload.online_mode, 'release', '[H] release 分支 payload.online_mode=release');
    assert.ok(!('note' in relPayload) && !('attachment_ids' in relPayload), '[H] release 分支 payload 不含 note/attachment_ids 键（无 note/附件时不写空键）');

    // 另造一单验证 direct：零 commit + 无活跃批次 → 直翻已上线
    const id2 = await mkAssignable('config');
    await assignConfig(id2, 'assigned');
    await call('POST', `/api/sys-issues/${id2}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const s = await call('POST', `/api/sys-issues/${id2}/submit`, devTok, { mode: 'no_code', no_code_reason: '已在测试环境完成配置校验', self_tested: true, test_env_deployed: true });
    assert.strictEqual(s.status, 200, 'H 夹具：submit 200');
    const direct = await call('POST', `/api/sys-issues/${id2}/accept`, adminTok, { online_mode: 'direct' });
    assert.strictEqual(direct.status, 200, `[H] online_mode=direct（零 commit 无批次）应 200, got ${direct.status} ${JSON.stringify(direct.body)}`);
    assert.strictEqual(direct.body.status, '已上线', '[H] direct 且资格满足 → 已上线（同事务改判）');
    assert.strictEqual(direct.body.online_source, 'no_commit_acceptance', '[H] online_source 复用既有免上线直翻值');
    assert.strictEqual((await rowOf(id2)).released_at != null, true, '[H] released_at 已写入');
    // [S1a 补丁 T·T2] direct 分支同样落 online_mode='direct'——即便主状态被 C9 改判「已上线」，本块在
    //   case 'accept' 尾部、break 之前无条件执行（C9 直翻写点只 push setFrags 不提前 return/break），
    //   payload 落的是**同一条 accept timeline 行**，非 C9 另写的行。
    const directTl = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept'`, [id2]);
    assert.ok(directTl && directTl.payload_json, '[H] direct 分支 timeline payload_json 非空');
    const directPayload = JSON.parse(directTl.payload_json);
    assert.strictEqual(directPayload.online_mode, 'direct', '[H] direct 分支 payload.online_mode=direct');

    // [S1a 补丁 U·主会话裁定 §4 候选2 镜像用例] config close 正向用例（id2 已在「已上线」，且经真实
    //   assign 端点带了 assigned_to=5）：admin close → 200 + 已关闭 + closed_at 非空 + 时间线 close 行；
    //   再 reopen → 400 INVALID_TRANSITION（D3「不重开」，config 无 reopen 条目）。与
    //   verify-sys-bug-transitions.js [C6负例]「裸插入无 assignee → 409 NO_ASSIGNEE_FOR_DEV_STATE」
    //   互为镜像：那条证"没有开发负责人时 close 被挡"，本组证"有开发负责人时 close 确实能成功"。
    //   独立成组 [H-close]（而非并入 [H] 末尾 ok）——单据结构直接复用 [H] direct 分支的 id2，不另起新单。
    const closeR = await call('POST', `/api/sys-issues/${id2}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[H-close] config close（有 assignee）应 200, got ${closeR.status} ${JSON.stringify(closeR.body)}`);
    const id2RowAfterClose = await rowOf(id2);
    assert.strictEqual(id2RowAfterClose.status, '已关闭', '[H-close] config close → 已关闭');
    assert.ok(id2RowAfterClose.closed_at, '[H-close] closed_at 已盖');
    const closeTl = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND action_code='close'`, [id2]);
    assert.ok(closeTl, '[H-close] 时间线存在 close 行（action_code=close）');

    const reopenR = await call('POST', `/api/sys-issues/${id2}/reopen`, adminTok, { reason: '试图重开' });
    assert.strictEqual(reopenR.status, 400, `[H-close] config reopen 应 400, got ${reopenR.status} ${JSON.stringify(reopenR.body)}`);
    assert.strictEqual(reopenR.body.code, 'INVALID_TRANSITION', '[H-close] config reopen → INVALID_TRANSITION（D3 不重开，config 无该条目——close 已是合法转换但 reopen 仍不是，两者不对称）');
    ok('[H-close] config close 正向用例（有 assignee）：200+已关闭+closed_at+时间线 close 行；reopen 仍 400 INVALID_TRANSITION（D3 不重开）——与 verify-sys-bug-transitions.js [C6负例] 的「无 assignee→409」互为镜像');

    // [S1b 订正·2026-09-07] DIRECT_ONLINE_NOT_ELIGIBLE（409）条件②（关联活跃批次）需要 release_id 非空——
    //   sys_issues 表级 DB CHECK `type<>'config' OR release_id IS NULL` 已随受控重建移除
    //   （scripts/migrate-sys-issues-drop-config-release-check.js），该 409 分支的真实端到端负例
    //   （SQL 夹具挂活跃批次 + 真实 accept(direct) 调用）见下方 [U6] 组，不在本组重复。

    // 非 config（feature）携带 online_mode → 400
    const featId = await mkAssignable('feature', '二级');
    const fa = await call('POST', `/api/sys-issues/${featId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(fa.status, 200, 'H 对照组夹具：feature 指派 200');
    await call('POST', `/api/sys-issues/${featId}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const fs = await call('POST', `/api/sys-issues/${featId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'feat-1' }], self_tested: true, test_env_deployed: true });
    // feature 默认走 GATE ⑥ 降级到「待验证」（非 LIAISON_TEST）——若落「待对接测试」则用 liaison-test-pass 推进；
    // 此处只需要能到「待验证」测 online_mode 拒绝，具体路径不影响本组断言目的。
    if (fs.body && fs.body.main_status === '待对接测试') {
      const lp = await call('POST', `/api/sys-issues/${featId}/liaison-test-pass`, intakeTok, { test_note: '通过' });
      assert.strictEqual(lp.status, 200, 'H 对照组夹具：liaison-test-pass 200');
    }
    assert.strictEqual(await statusOf(featId), '待验证', 'H 对照组夹具：feature 已到待验证');
    const featBad = await call('POST', `/api/sys-issues/${featId}/accept`, adminTok, { online_mode: 'release' });
    assert.strictEqual(featBad.status, 400, `[H] feature 携带 online_mode 应 400, got ${featBad.status} ${JSON.stringify(featBad.body)}`);
    assert.strictEqual(featBad.body.code, 'ONLINE_MODE_NOT_APPLICABLE', '[H] 非 config 携带 online_mode code=ONLINE_MODE_NOT_APPLICABLE');
    assert.strictEqual(await statusOf(featId), '待验证', '[H] feature 被拒后状态原样');

    ok('[H] accept online_mode：缺/非法 400；release 零 commit 不直翻恒待上线+payload_json.online_mode=release（无空键）；direct 零 commit 无批次直翻已上线+online_source+payload_json.online_mode=direct；非 config 携带 400 ONLINE_MODE_NOT_APPLICABLE（DIRECT_ONLINE_NOT_ELIGIBLE 409 分支真实端到端负例见 [U6]）');
  }

  // ═══ [I] reassign exec_mode/vendor_name（J18）═══
  {
    // [S1a 补丁 V·V1·codex 505-A H1] 切 vendor 未传名称的终态校验——config 已 assign self（exec_mode=
    //   'self'，vendor_name=NULL）→ reassign 仅 exec_mode:'vendor'（不带 vendor_name）：旧逻辑"未传则
    //   沿用现值"会沿用切换前的 NULL，落成 exec_mode='vendor' ∧ vendor_name=NULL 的无名 vendor 脏态；
    //   现按终态校验 → 400 VENDOR_NAME_REQUIRED，写前拦截。「实现坏成什么样这条会红」：若 V1 的终态
    //   校验被删/绕过，本组 v1NoName 会从 400 变 200，且 rowV1AfterReject.exec_mode 会从 'self' 变
    //   'vendor'（无名 vendor 脏态真实落库）。
    const idV1 = await mkAssignable('config');
    await assignConfig(idV1, 'self');
    const tlCountBeforeV1 = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [idV1])).c;
    // [S1a 补丁 X·X3·codex 506-B #1] 成员零写对拍——含已软删行（不加 removed_at IS NULL 过滤），防
    //   "实现先改写/重建成员行再返回 400"这类改坏了也绿的场景（此前只断了 sys_issues 主表两列 + timeline
    //   计数，未覆盖成员子表本身）。「实现坏成什么样这条会红」：若拒绝路径在返回 400 之前已经写过/重建过
    //   sys_issue_dev_assignees 行（即便最终仍 400），rosterV1Before/After 的 deepStrictEqual 会红。
    const rosterV1Before = await all('SELECT id, user_id, dev_status, notify_status, removed_at FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id', [idV1]);
    const eventCountV1Before = (await get(`SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id=?`, [idV1])).c;
    const v1NoName = await call('POST', `/api/sys-issues/${idV1}/reassign`, adminTok, { member_ids: [5], reason: '切乙方但忘填名称', exec_mode: 'vendor' });
    assert.strictEqual(v1NoName.status, 400, `[I] V1 切 vendor 未传名称应 400, got ${v1NoName.status} ${JSON.stringify(v1NoName.body)}`);
    assert.strictEqual(v1NoName.body.code, 'VENDOR_NAME_REQUIRED', '[I] V1 切 vendor 未传名称 code=VENDOR_NAME_REQUIRED（终态校验，非"未传则沿用旧值"落成无名 vendor）');
    const rowV1AfterReject = await rowOf(idV1);
    assert.strictEqual(rowV1AfterReject.exec_mode, 'self', '[I] V1 被拒后 exec_mode 仍 self（终态校验在任何写之前拦截，未落成 vendor+NULL 脏态）');
    assert.strictEqual(rowV1AfterReject.vendor_name, null, '[I] V1 被拒后 vendor_name 仍 NULL');
    const tlCountAfterV1 = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [idV1])).c;
    assert.strictEqual(tlCountAfterV1, tlCountBeforeV1, '[I] V1 被拒后时间线无新 note 行（零副作用）');
    const rosterV1After = await all('SELECT id, user_id, dev_status, notify_status, removed_at FROM sys_issue_dev_assignees WHERE issue_id=? ORDER BY id', [idV1]);
    assert.deepStrictEqual(rosterV1After, rosterV1Before, '[I] V1 被拒后成员表逐字段零写（含已软删行，补丁 X·X3）');
    const eventCountV1After = (await get(`SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id=?`, [idV1])).c;
    assert.strictEqual(eventCountV1After, eventCountV1Before, '[I] V1 被拒后成员事件表（sys_issue_dev_events）计数不变（补丁 X·X3）');

    // 同请求带 vendor_name → 200 且落库两字段
    const v1WithName = await call('POST', `/api/sys-issues/${idV1}/reassign`, adminTok, { member_ids: [5], reason: '切乙方并填名称', exec_mode: 'vendor', vendor_name: '乙方A' });
    assert.strictEqual(v1WithName.status, 200, `[I] V1 切 vendor 带名称应 200, got ${v1WithName.status} ${JSON.stringify(v1WithName.body)}`);
    const rowV1AfterOk = await rowOf(idV1);
    assert.strictEqual(rowV1AfterOk.exec_mode, 'vendor', '[I] V1 落库 exec_mode=vendor');
    assert.strictEqual(rowV1AfterOk.vendor_name, '乙方A', '[I] V1 落库 vendor_name=乙方A');

    // 再 reassign 仅改名称（不带 exec_mode）→ 200，方式仍 vendor（既有语义「vendor→vendor 不传名称/仅改名称」保持）
    const v1RenameOnly = await call('POST', `/api/sys-issues/${idV1}/reassign`, adminTok, { member_ids: [5], reason: '仅改乙方名称', vendor_name: '乙方B' });
    assert.strictEqual(v1RenameOnly.status, 200, `[I] V1 仅改名称应 200, got ${v1RenameOnly.status} ${JSON.stringify(v1RenameOnly.body)}`);
    const rowV1AfterRename = await rowOf(idV1);
    assert.strictEqual(rowV1AfterRename.exec_mode, 'vendor', '[I] V1 仅改名称后 exec_mode 仍 vendor（未传 exec_mode，沿用现值）');
    assert.strictEqual(rowV1AfterRename.vendor_name, '乙方B', '[I] V1 落库 vendor_name 更新为乙方B');

    const id = await mkAssignable('config');
    await assignConfig(id, 'self');

    // 仅方式变化（成员不变）→ 200，不动成员进度/不发通知/不动 roster 行 id 集合/不动 assigned_to（J18）
    const before = await all('SELECT id, user_id, dev_status, notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY id', [id]);
    const rowBefore = await rowOf(id);
    const r1 = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5], reason: '改为乙方跟踪', exec_mode: 'vendor', vendor_name: '新乙方公司' });
    assert.strictEqual(r1.status, 200, `[I] 仅方式变化应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const row1 = await rowOf(id);
    assert.strictEqual(row1.exec_mode, 'vendor', '[I] exec_mode 变更落库');
    assert.strictEqual(row1.vendor_name, '新乙方公司', '[I] vendor_name 变更落库');
    assert.strictEqual(r1.body.exec_mode, 'vendor', '[I] 响应体带新 exec_mode');
    const after = await all('SELECT id, user_id, dev_status, notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY id', [id]);
    // [S1a 补丁 T·M3] execOnlyChange 分支前后对拍——防"execOnlyChange 分支照常调 electRepresentative/
    //   notifyAssignedDeveloper"这类改坏了也绿的场景（J18 三条"跳过"此前只测了"不重置 dev_status"一条）。
    assert.deepStrictEqual(after.map(r => r.id), before.map(r => r.id), '[I] roster 行 id 集合未变（跳过成员增删）');
    assert.strictEqual(after[0].dev_status, before[0].dev_status, '[I] 成员 dev_status 未被重置（跳过成员门重算，J18）');
    assert.strictEqual(after[0].notify_status, before[0].notify_status, '[I] 成员 notify_status 未从 not_sent 翻 sent（跳过 notifyAssignedDeveloper，J18）');
    assert.strictEqual(after[0].notify_status, 'not_sent', '[I] 夹具自检：notify_status 本就是 not_sent（未调用过 notify-developer）');
    assert.strictEqual(row1.assigned_to, rowBefore.assigned_to, '[I] assigned_to 未变（跳过 electRepresentative 重算，J18）');
    // timeline 应新增一条 note 且带 payload_json（exec_mode_from/to）
    const tl = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND event_type='note' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl && tl.payload_json, '[I] 时间线写入 payload_json');
    const payload = JSON.parse(tl.payload_json);
    assert.strictEqual(payload.exec_mode_from, 'self', '[I] payload exec_mode_from=self');
    assert.strictEqual(payload.exec_mode_to, 'vendor', '[I] payload exec_mode_to=vendor');

    // 三者全不变 → 409（config 专属 no-op 判据）
    const r2 = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5], reason: '重复提交', exec_mode: 'vendor', vendor_name: '新乙方公司' });
    assert.strictEqual(r2.status, 409, `[I] 三者全不变应 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'VALIDATION', '[I] 三者全不变 code=VALIDATION（config 专属 409 与其他类型的 400 共用同一错误码，只分 HTTP 状态码）');

    // [S1a 补丁 T·M3·预筛 C-e] 「待验证」态仅改 exec_mode → 200 且主状态仍待验证（不误触主状态联动——
    //   runWGate 被 execOnlyChange 跳过，gateResult 初值 changed:false，此前无用例覆盖该态）。
    const verifyId = await mkAssignable('config');
    await assignConfig(verifyId, 'self');
    await call('POST', `/api/sys-issues/${verifyId}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${verifyId}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(await statusOf(verifyId), '待验证', 'I 待验证夹具：已到待验证');
    const rVerify = await call('POST', `/api/sys-issues/${verifyId}/reassign`, adminTok, { member_ids: [5], reason: '待验证态改执行方式', exec_mode: 'assigned' });
    assert.strictEqual(rVerify.status, 200, `[I] 待验证态仅改 exec_mode 应 200, got ${rVerify.status} ${JSON.stringify(rVerify.body)}`);
    assert.strictEqual(await statusOf(verifyId), '待验证', '[I] 待验证态仅改 exec_mode 后主状态仍待验证（未被误触联动）');
    assert.strictEqual((await rowOf(verifyId)).exec_mode, 'assigned', '[I] 待验证态 exec_mode 变更仍正常落库');

    // 非 config 携带 exec_mode → 400
    const impId = await mkAssignable('improvement', '二级');
    const impAssign = await call('POST', `/api/sys-issues/${impId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(impAssign.status, 200, 'I 对照组夹具：improvement 指派 200');
    const impBad = await call('POST', `/api/sys-issues/${impId}/reassign`, adminTok, { member_ids: [6], reason: '换人', exec_mode: 'self' });
    assert.strictEqual(impBad.status, 400, `[I] improvement 携带 exec_mode 应 400, got ${impBad.status} ${JSON.stringify(impBad.body)}`);
    assert.strictEqual(impBad.body.code, 'EXEC_MODE_NOT_APPLICABLE', '[I] 非 config 携带 code=EXEC_MODE_NOT_APPLICABLE');

    ok('[I] reassign exec_mode/vendor_name：切 vendor 未传名称终态校验 400 VENDOR_NAME_REQUIRED 且零副作用+成员表/事件表逐字段零写（补丁 V·V1 + X·X3）+ 带名称 200 落库 + 仅改名称 200；仅方式变化 200 + 落库 + payload_json 留痕 + roster id 集合/assigned_to/notify_status 三者不变；三者全不变 409 VALIDATION（config 专属 no-op）；待验证态仅改 exec_mode 200 且主状态不联动；非 config 携带 400');
  }

  // ═══ [J] hold 四态 + resume 逐态回原态 ═══
  {
    // [S1a 补丁 T·M3] holdChecks 记录每张单 id + 期望的 hold 前活跃态，下方统一改为对真实落库
    //   sys_issue_timeline.from_status（action_code='hold'）逐条对拍——原 states 数组由本地字面量
    //   push 拼出、与实现无关联，是恒真断言（实现坏了也不会红）；现在断言的是"进入暂缓前活跃态记入
    //   timeline from_status"这条 sideEffects 是否真的落库（同 hold 条目 transitions.js:164 声明）。
    const holdChecks = [];
    // 待处理
    {
      const id = await mkAssignable('config');
      const h = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '暂缓①' });
      assert.strictEqual(h.status, 200, `[J] 待处理 hold 应 200, got ${h.status} ${JSON.stringify(h.body)}`);
      assert.strictEqual(await statusOf(id), '已暂缓', '[J] hold → 已暂缓');
      const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: '恢复①' });
      assert.strictEqual(r.status, 200, `[J] resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(await statusOf(id), '待处理', '[J] resume 回「待处理」');
      holdChecks.push({ id, expected: '待处理' });
    }
    // 处理中
    {
      const id = await mkAssignable('config');
      await assignConfig(id, 'self');
      const h = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '暂缓②' });
      assert.strictEqual(h.status, 200, `[J] 处理中 hold 应 200, got ${h.status} ${JSON.stringify(h.body)}`);
      assert.strictEqual(await statusOf(id), '已暂缓', '[J] hold → 已暂缓');
      const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: '恢复②' });
      assert.strictEqual(await statusOf(id), '处理中', '[J] resume 回「处理中」');
      holdChecks.push({ id, expected: '处理中' });
    }
    // 待验证
    {
      const id = await mkAssignable('config');
      await assignConfig(id, 'self');
      await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
      await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
      const h = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '暂缓③' });
      assert.strictEqual(h.status, 200, `[J] 待验证 hold 应 200, got ${h.status} ${JSON.stringify(h.body)}`);
      const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: '恢复③' });
      assert.strictEqual(await statusOf(id), '待验证', '[J] resume 回「待验证」');
      holdChecks.push({ id, expected: '待验证' });
    }
    // 待上线
    {
      const id = await mkAssignable('config');
      await assignConfig(id, 'self');
      await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
      await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
      const acc = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { online_mode: 'release' });
      assert.strictEqual(acc.status, 200, 'J 夹具：accept release 200');
      const h = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '暂缓④' });
      assert.strictEqual(h.status, 200, `[J] 待上线 hold 应 200, got ${h.status} ${JSON.stringify(h.body)}`);
      const r = await call('POST', `/api/sys-issues/${id}/resume`, adminTok, { reason: '恢复④' });
      assert.strictEqual(await statusOf(id), '待上线', '[J] resume 回「待上线」');
      holdChecks.push({ id, expected: '待上线' });
    }
    assert.strictEqual(holdChecks.length, 4, '[J] 四态全覆盖（夹具本身齐全）');
    // [S1a 补丁 T·M3] 对 4 张单逐条查真实落库 from_status（action_code='hold'，hold 条目
    //   timelineEvent='status_change'/actionCode='hold'，见 transitions.js:165），与期望前活跃态
    //   逐条对拍——这才是"进入暂缓前活跃态记入 timeline from_status"这条 sideEffects 的真实证据。
    for (const { id, expected } of holdChecks) {
      const tl = await get(`SELECT from_status FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold'`, [id]);
      assert.ok(tl, `[J] issue=${id} 应有 action_code='hold' 的 timeline 行`);
      assert.strictEqual(tl.from_status, expected, `[J] issue=${id} hold 前活跃态落库应为「${expected}」，实得「${tl.from_status}」`);
    }

    // [S1a 补丁 V·V4·codex 505-A L1] 跨类型防御负例：bug 单处理中 hold 后，用 SQL 把该 hold timeline
    //   行的 from_status 改成「待处理」（bug 的 hold.from 恰为 ['处理中']，「待处理」从未是 bug 合法的
    //   暂缓前态）→ resume 应 409（V4 新增第三道校验命中），状态仍已暂缓。夹具生产不可达（脏数据防御
    //   用例，正常业务流程产生不出这种 timeline 行）——存在理由：resume 唯一信任 timeline 的
    //   from_status 字段来决定恢复目标，若该字段被污染（脏数据/未来新代码误写），旧两道校验
    //   （ACTIVE_STATES ∧ ALLOWED_STATUSES）仍会放行，只有 V4 新增的「target 须属于该 type hold.from
    //   集合」这道才能拦住。「实现坏成什么样这条会红」：若 V4 的第三道校验被删，本条会从 409 变 200
    //   （bug 单被错误恢复到「待处理」）。
    // bug 不支持 risk_level（RISK_LEVEL_NOT_APPLICABLE），不能复用 mkAssignable（该 helper 恒传
    //   risk_level，专为 feature/improvement/config 设计）——本处手写建单+受理两步。
    const bugCreateV4 = await create('bug');
    assert.strictEqual(bugCreateV4.status, 201, 'V4 夹具：bug 建单 201');
    const bugIdV4 = bugCreateV4.body.id;
    const bugAcceptV4 = await call('POST', `/api/sys-issues/${bugIdV4}/intake-accept`, adminTok, {});
    assert.strictEqual(bugAcceptV4.status, 200, `V4 夹具：bug 受理 200, got ${bugAcceptV4.status} ${JSON.stringify(bugAcceptV4.body)}`);
    const bugAssignV4 = await call('POST', `/api/sys-issues/${bugIdV4}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(bugAssignV4.status, 200, 'V4 夹具：bug assign 200');
    assert.strictEqual(await statusOf(bugIdV4), '处理中', 'V4 夹具：bug 已到处理中');
    const bugHoldV4 = await call('POST', `/api/sys-issues/${bugIdV4}/hold`, adminTok, { reason: 'V4 跨类型防御夹具' });
    assert.strictEqual(bugHoldV4.status, 200, 'V4 夹具：bug hold 200');
    assert.strictEqual(await statusOf(bugIdV4), '已暂缓', 'V4 夹具：bug 已到已暂缓');
    const dirtyUpd = await run(`UPDATE sys_issue_timeline SET from_status='待处理' WHERE issue_id=? AND action_code='hold'`, [bugIdV4]);
    assert.strictEqual(dirtyUpd.changes, 1, 'V4 夹具：脏数据构造应命中恰 1 行 hold timeline');
    const resumeV4 = await call('POST', `/api/sys-issues/${bugIdV4}/resume`, adminTok, { reason: 'V4 尝试恢复到脏态' });
    assert.strictEqual(resumeV4.status, 409, `[J] V4 跨类型防御：bug resume 到脏 from_status「待处理」应 409, got ${resumeV4.status} ${JSON.stringify(resumeV4.body)}`);
    assert.strictEqual(resumeV4.body.code, 'RESUME_TARGET_INVALID', '[J] V4 code=RESUME_TARGET_INVALID（target 不属于 bug hold.from 集合 [处理中]）');
    assert.strictEqual(await statusOf(bugIdV4), '已暂缓', '[J] V4 被拒后状态仍已暂缓（未被误恢复）');

    ok('[J] hold 四态（待处理/处理中/待验证/待上线）各一 + resume 逐态回原态 + timeline from_status 逐条对拍真实落库；跨类型防御负例：bug 脏 timeline from_status「待处理」→ resume 409 RESUME_TARGET_INVALID（补丁 V·V4）');
  }

  // ═══ [K] issue_reject 前置守卫 + reactivate ═══
  {
    const r = await create('config');
    const id = r.body.id;   // 待受理态（未受理）
    const noComment = await call('POST', `/api/sys-issues/${id}/issue-reject`, intakeTok, { reason: '不做' });
    assert.strictEqual(noComment.status, 409, `[K] 无 tech_lead_comment 时 issue_reject 应 409, got ${noComment.status} ${JSON.stringify(noComment.body)}`);
    assert.strictEqual(noComment.body.code, 'REJECT_REQUIRES_TECH_COMMENT', '[K] code=REJECT_REQUIRES_TECH_COMMENT（config 并入 R2 守卫，同 improvement）');
    assert.strictEqual(await statusOf(id), '待受理', '[K] 被拒后状态原样');

    // 发起咨询 + 技术负责人回复后 → 可拒绝
    const consult = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, intakeTok, { tech_lead_id: 7 });
    assert.strictEqual(consult.status, 200, `[K] request-tech-consult 应 200, got ${consult.status} ${JSON.stringify(consult.body)}`);
    const evId = (await get('SELECT tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id])).ev;
    const comment = await call('POST', `/api/sys-issues/${id}/tech-lead-comment`, techTok, { comment: '技术上不建议做，收益低成本高', expected_request_event_id: evId });
    assert.strictEqual(comment.status, 200, `[K] tech-lead-comment 应 200, got ${comment.status} ${JSON.stringify(comment.body)}`);

    const reject = await call('POST', `/api/sys-issues/${id}/issue-reject`, intakeTok, { reason: '技术负责人已给出不建议做的意见' });
    assert.strictEqual(reject.status, 200, `[K] 有意见后 issue_reject 应 200, got ${reject.status} ${JSON.stringify(reject.body)}`);
    assert.strictEqual(await statusOf(id), '已拒绝', '[K] issue_reject → 已拒绝');

    const react = await call('POST', `/api/sys-issues/${id}/reactivate`, adminTok, { reason: '业务方重新提出' });
    assert.strictEqual(react.status, 200, `[K] reactivate 应 200, got ${react.status} ${JSON.stringify(react.body)}`);
    assert.strictEqual(await statusOf(id), '待受理', '[K] reactivate → 待受理');

    ok('[K] issue_reject 前置守卫：无 tech_lead_comment → 409 REJECT_REQUIRES_TECH_COMMENT（config 并入 R2，同 improvement）；有意见后 → 200 已拒绝；reactivate → 200 待受理');
  }

  // ═══ [L] void ═══
  {
    const id = await mkAssignable('config');
    const v = await call('POST', `/api/sys-issues/${id}/void`, adminTok, { reason: '业务方撤回' });
    assert.strictEqual(v.status, 200, `[L] void 应 200, got ${v.status} ${JSON.stringify(v.body)}`);
    assert.strictEqual(await statusOf(id), '已作废', '[L] void → 已作废');
    // [S1e·补丁 AN·codex 520-B6③] 原收尾写「任意态 → 已作废」，但本组只跑了 mkAssignable 产出的
    //   那**一个**起始态——一个场景撑不起「任意态」这个全称描述。按实际覆盖收窄措辞；「待上线（含
    //   挂批次）」这个更硬的起始态由 [U8] 单独覆盖（void 200 落已作废 ∧ release_id 不清空 + 两个
    //   出口 409），两组合起来才构成 transitions.js 里 `from: '*'` 的实证面，不在本条里虚报。
    ok('[L] void：mkAssignable 产出的指派前态 → 已作废（**本条只证这一个起始态**；transitions 声明的 from=\'*\' 未在本条穷尽，待上线+挂批次的 void 见 [U8]）');
  }

  // ═══ [M] reopen 唯一错误码（跨态同码）═══
  {
    // 已上线态
    const id1 = await mkAssignable('config');
    await assignConfig(id1, 'self');
    await call('POST', `/api/sys-issues/${id1}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    await call('POST', `/api/sys-issues/${id1}/accept`, adminTok, { online_mode: 'direct' });
    assert.strictEqual(await statusOf(id1), '已上线', 'M 夹具：id1 已上线');
    const reopen1 = await call('POST', `/api/sys-issues/${id1}/reopen`, adminTok, { reason: '重开试试' });
    assert.strictEqual(reopen1.status, 400, `[M] 已上线态 reopen 应 400（唯一码，非 409 ISSUE_NOT_ARCHIVED）, got ${reopen1.status} ${JSON.stringify(reopen1.body)}`);
    assert.strictEqual(reopen1.body.code, 'INVALID_TRANSITION', '[M] code=INVALID_TRANSITION（config 无 reopen 条目，findTransition 恒 null）');

    // 已关闭态
    await call('POST', `/api/sys-issues/${id1}/close`, adminTok, {});
    assert.strictEqual(await statusOf(id1), '已关闭', 'M 夹具：id1 已关闭');
    const reopen2 = await call('POST', `/api/sys-issues/${id1}/reopen`, adminTok, { reason: '重开试试2' });
    assert.strictEqual(reopen2.status, 400, `[M] 已关闭态 reopen 应同码 400, got ${reopen2.status} ${JSON.stringify(reopen2.body)}`);
    assert.strictEqual(reopen2.body.code, 'INVALID_TRANSITION', '[M] 已关闭态同码 INVALID_TRANSITION（跨态唯一码）');

    ok('[M] reopen 对 config：已上线态与已关闭态均 400 INVALID_TRANSITION（唯一码，D3「不重开」）');
  }

  // ═══ [N] feasibility/blocked/unblock/scope_change/liaison_test_* 对 config 拒绝 ═══
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'self');

    const feas = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: '已确认', dev_estimated_at: futureEst(30) });
    assert.strictEqual(feas.status, 409, `[N] feasibility 对 config 应 409, got ${feas.status} ${JSON.stringify(feas.body)}`);
    assert.strictEqual(feas.body.code, 'FEASIBILITY_NOT_APPLICABLE', '[N] feasibility code=FEASIBILITY_NOT_APPLICABLE（同 bug）');

    const blocked = await call('POST', `/api/sys-issues/${id}/blocked`, devTok, { reason: '卡住了' });
    assert.strictEqual(blocked.status, 409, `[N] blocked 对 config 应 409, got ${blocked.status} ${JSON.stringify(blocked.body)}`);
    // [S1a 补丁 W·W6·B1 次级] 补 code 断言（此前只断 HTTP 状态）：仅 feature/improvement + needs_feasibility=1
    //   可受阻（index.js:13774），config 不满足 type 条件 → BLOCKED_NOT_APPLICABLE。
    assert.strictEqual(blocked.body.code, 'BLOCKED_NOT_APPLICABLE', '[N] blocked code=BLOCKED_NOT_APPLICABLE（仅要求可行性评估的变更类单据可标记受阻，config 不满足）');

    const scope = await call('POST', `/api/sys-issues/${id}/scope-change`, adminTok, { summary: '加个字段' });
    assert.strictEqual(scope.status, 409, `[N] scope-change 对 config 应 409, got ${scope.status} ${JSON.stringify(scope.body)}`);
    assert.strictEqual(scope.body.code, 'SCOPE_STATUS_INVALID', '[N] scope-change code=SCOPE_STATUS_INVALID（非 SCOPE_CHANGE_DISABLED——config 不在 feature/improvement 前置拦截名单，走 findTransition 兜底）');

    const ltp = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, intakeTok, { test_note: '通过' });
    assert.strictEqual(ltp.status, 400, `[N] liaison-test-pass 对 config 应 400, got ${ltp.status} ${JSON.stringify(ltp.body)}`);
    assert.strictEqual(ltp.body.code, 'INVALID_TRANSITION', '[N] liaison-test-pass code=INVALID_TRANSITION（config 无该条目）');

    const ltr = await call('POST', `/api/sys-issues/${id}/liaison-test-return`, intakeTok, { reason: '打回' });
    assert.strictEqual(ltr.status, 400, `[N] liaison-test-return 对 config 应 400, got ${ltr.status} ${JSON.stringify(ltr.body)}`);
    // [S1a 补丁 W·W6] 补 code 断言：generic makeTransitionEndpoint('liaison_test_return')，config 无该
    //   条目，findTransition 恒 null → 与上方 liaison-test-pass 同码 INVALID_TRANSITION。
    assert.strictEqual(ltr.body.code, 'INVALID_TRANSITION', '[N] liaison-test-return code=INVALID_TRANSITION（config 无该条目，同 liaison-test-pass）');

    assert.strictEqual(await statusOf(id), '处理中', '[N] 全部被拒后状态原样');
    ok('[N] feasibility/blocked（409 BLOCKED_NOT_APPLICABLE/FEASIBILITY_NOT_APPLICABLE，同 bug）+ scope-change（409 SCOPE_STATUS_INVALID）+ liaison-test-pass/return（400 INVALID_TRANSITION）对 config 均拒绝，状态原样');
  }

  // ═══ [O] 通知四通道状态白名单 ═══
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'self');

    // developer：处理中可发
    const devNotify = await call('POST', `/api/sys-issues/${id}/notify-developer`, intakeTok, { dev_user_id: 5 });
    assert.strictEqual(devNotify.status, 200, `[O] developer 通道处理中态应 200, got ${devNotify.status} ${JSON.stringify(devNotify.body)}`);
    const devRow = await get('SELECT notify_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL', [id]);
    assert.strictEqual(devRow.notify_status, 'sent', '[O] developer 通道真发送');

    // creator/requester：处理中不可发（409）
    const creatorBad = await call('POST', `/api/sys-issues/${id}/notify-creator`, intakeTok);
    assert.strictEqual(creatorBad.status, 409, `[O] creator 通道处理中态应 409, got ${creatorBad.status} ${JSON.stringify(creatorBad.body)}`);
    assert.strictEqual(creatorBad.body.code, 'STATUS_NOT_NOTIFIABLE', '[O] creator 处理中态 code=STATUS_NOT_NOTIFIABLE');

    // 推进到待验证后 creator/requester 可发
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(await statusOf(id), '待验证', 'O 夹具：已到待验证');

    const creatorOk = await call('POST', `/api/sys-issues/${id}/notify-creator`, intakeTok);
    assert.strictEqual(creatorOk.status, 200, `[O] creator 通道待验证态应 200, got ${creatorOk.status} ${JSON.stringify(creatorOk.body)}`);
    assert.strictEqual(creatorOk.body.creator_notify_status, 'sent', '[O] creator 真发送');

    const requesterOk = await call('POST', `/api/sys-issues/${id}/notify-requester`, intakeTok);
    assert.strictEqual(requesterOk.status, 200, `[O] requester 通道待验证态应 200, got ${requesterOk.status} ${JSON.stringify(requesterOk.body)}`);
    assert.strictEqual(requesterOk.body.requester_notify_status, 'sent', '[O] requester 真发送');

    // [S1a 补丁 T·M3] developer 通道负例：待处理（未进 DEV 工作态）→ 409 STATUS_NOT_NOTIFIABLE
    //   （devStatuses.includes(issue.status) 早于 roster 归属检查，见 index.js notify-developer :19165）。
    const pendingId = await mkAssignable('config');
    const devPendingBad = await call('POST', `/api/sys-issues/${pendingId}/notify-developer`, intakeTok, { dev_user_id: 5 });
    assert.strictEqual(devPendingBad.status, 409, `[O] developer 通道待处理态应 409, got ${devPendingBad.status} ${JSON.stringify(devPendingBad.body)}`);
    assert.strictEqual(devPendingBad.body.code, 'STATUS_NOT_NOTIFIABLE', '[O] developer 待处理态 code=STATUS_NOT_NOTIFIABLE（SYS_NOTIFY_DEV_STATUSES_CONFIG 不含待处理）');

    // developer 通道负例：待上线 → 409 STATUS_NOT_NOTIFIABLE（方案 §7"config 处理中可发、开发中不可发"的
    //   "不可发"半边，此前完全没测）
    const releasedId = await mkAssignable('config');
    await assignConfig(releasedId, 'self');
    await call('POST', `/api/sys-issues/${releasedId}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${releasedId}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    const relAcc = await call('POST', `/api/sys-issues/${releasedId}/accept`, adminTok, { online_mode: 'release' });
    assert.strictEqual(relAcc.status, 200, 'O 负例夹具：accept release 200');
    assert.strictEqual(await statusOf(releasedId), '待上线', 'O 负例夹具：已到待上线');
    const devReleasedBad = await call('POST', `/api/sys-issues/${releasedId}/notify-developer`, intakeTok, { dev_user_id: 5 });
    assert.strictEqual(devReleasedBad.status, 409, `[O] developer 通道待上线态应 409, got ${devReleasedBad.status} ${JSON.stringify(devReleasedBad.body)}`);
    assert.strictEqual(devReleasedBad.body.code, 'STATUS_NOT_NOTIFIABLE', '[O] developer 待上线态 code=STATUS_NOT_NOTIFIABLE');

    // relay 通道：config 恒 400 MANUAL_NOTIFY_TYPE_NA（sysManualNotifyGuard relay 分支兜底，任意态，
    //   早于 relay_notified_user_id/白名单/状态三道后续闸，见 index.js:19309-19313）。
    const relayBad = await call('POST', `/api/sys-issues/${pendingId}/notify-relay`, adminTok, {});
    assert.strictEqual(relayBad.status, 400, `[O] relay 通道对 config 应 400, got ${relayBad.status} ${JSON.stringify(relayBad.body)}`);
    assert.strictEqual(relayBad.body.code, 'MANUAL_NOTIFY_TYPE_NA', '[O] relay 通道 code=MANUAL_NOTIFY_TYPE_NA（config 落 sysManualNotifyGuard relay 分支兜底，同 sysNotifyStatusesFor 的 relay:[] 口径）');

    // intake 通道：待受理态可发（新建一单，未受理）——测试桩 sendIssueDingtalkRaw 恒 {ok:true}，
    //   故本调用结构上必然成功，改用 strictEqual(200) + 回读 intake_notify_status='sent'（原
    //   200||400 近似恒真，且未证真的发送成功，见预筛 M3）。
    const freshId = (await create('config')).body.id;
    const intakeNotify = await call('POST', `/api/sys-issues/${freshId}/notify-intake`, adminTok, {});
    assert.strictEqual(intakeNotify.status, 200, `[O] intake 通道待受理态应 200, got ${intakeNotify.status} ${JSON.stringify(intakeNotify.body)}`);
    // [S1e·补丁 AN·codex 520-B6④ → 补丁 AO·codex 521 问项4④ 再订正] 原描述写「真发送」，AN 收窄成
    //   「服务端落盘状态字段」——**仍不准确**：这一条读的是**响应体**，没有回读数据库，称「落盘」是
    //   第二次能力声明大于实作。两条一起做：①本条如实写成「响应体字段」；②另补一条**真回读**
    //   （`intake_notify_status` 确为库列，DDL 见 index.js:878，CHECK 限 not_sent/sent/failed），
    //   这样「落盘」才是被证过的。两条都不证明钉钉侧真实送达——那需要外部桩，本套件不涉。
    assert.strictEqual(intakeNotify.body.intake_notify_status, 'sent',
      '[O] intake 通道**响应体** intake_notify_status=sent（断言对象＝HTTP 响应体字段，非库值、非外部送达）');
    const intakeRow = await rowOf(freshId);
    assert.strictEqual(intakeRow.intake_notify_status, 'sent',
      `[O] intake 通道**回读库值** sys_issues.intake_notify_status=sent（断言对象＝落盘字段，与上一条响应体断言互补：响应体对了库没写对这种半成品形态由本条抓；仍不证明钉钉侧真实送达，实得=${JSON.stringify(intakeRow.intake_notify_status)}）`);

    // [S1a 补丁 W·W5·核实+补齐] notify-read-status 端点级覆盖——核实：补丁 T 的 T1 只改了产品码
    //   （notify-read-status 白名单加 config，见 index.js:20120），[O] 组此前从未调用过 notify-read-status
    //   端点（grep 全文件确认零命中），本条补齐。creator 通道复用上方已发 creator 通知的 id
    //   （creator_notify_status='sent'）；手工设已读哨兵走 cached 分支，避免依赖钉钉配置（沙箱
    //   readSystemConfig 恒返回空串，同 verify-sys-intake-liaison.js [⑦] 既有范式）。
    //   「实现坏成什么样这条会红」：若 index.js:20120 的白名单被撤掉 config，两条断言均从 200/400 变 400
    //   （config 落回"该类型暂不支持通知查已读"兜底），与产品码 T1 形成回归证据。
    const CREATOR_READ_SENTINEL = '2026-09-07 08:00:00';
    await run(`UPDATE sys_issues SET creator_read_at = ? WHERE id = ?`, [CREATOR_READ_SENTINEL, id]);
    const readCreator = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=creator`, adminTok);
    assert.strictEqual(readCreator.status, 200, `[O] notify-read-status?type=creator 应 200, got ${readCreator.status} ${JSON.stringify(readCreator.body)}`);
    assert.strictEqual(readCreator.body.read, true, '[O] notify-read-status?type=creator 正确读到已读哨兵（cached 分支，不触达钉钉）');
    assert.strictEqual(readCreator.body.read_at, CREATOR_READ_SENTINEL, '[O] notify-read-status?type=creator read_at 精确等于哨兵值');

    // relay 通道：查已读与发送侧同码拒——sysManualNotifyGuard 是发送/查已读共用件（index.js:20194），
    //   config 落 relay 分支兜底 400 MANUAL_NOTIFY_TYPE_NA，写读同源。
    const readRelay = await call('GET', `/api/sys-issues/${id}/notify-read-status?type=relay`, adminTok);
    assert.strictEqual(readRelay.status, 400, `[O] notify-read-status?type=relay 应 400, got ${readRelay.status} ${JSON.stringify(readRelay.body)}`);
    assert.strictEqual(readRelay.body.code, 'MANUAL_NOTIFY_TYPE_NA', '[O] notify-read-status?type=relay code=MANUAL_NOTIFY_TYPE_NA（与发送侧同码，写读同源）');

    ok('[O] 通知四通道：developer 处理中可发/待处理与待上线均 409 STATUS_NOT_NOTIFIABLE；creator+requester 处理中拒待验证可发；relay 通道恒 400 MANUAL_NOTIFY_TYPE_NA；intake 通道待受理态 200+intake_notify_status=sent；notify-read-status：creator 200(cached)/relay 400 MANUAL_NOTIFY_TYPE_NA（补丁 W·W5）');
  }

  // ═══ [P] RELEASABLE_TYPES/RELEASE_FAMILY_BY_TYPE 常量 + add-issues 现状记录 ═══
  {
    assert.ok(I.RELEASABLE_TYPES.includes('config'), '[P] RELEASABLE_TYPES 含 config');
    assert.strictEqual(I.RELEASE_FAMILY_BY_TYPE.config, 'change', '[P] RELEASE_FAMILY_BY_TYPE.config=change（与 feature/improvement 同族）');

    // [S1b 翻转·2026-09-07] 建批次 + 加入待上线的 config 单——sys_issues 表级 DB CHECK
    // (type<>'config' OR release_id IS NULL) 已随受控重建移除（scripts/migrate-sys-issues-drop-config-release-check.js），
    // config 单现应正常挂入批次：200 + release_id=目标批次 + 批次详情端点返回的成员含该单（codex 505-B2 M3 强度要求）。
    const id = await mkAssignable('config');
    await assignConfig(id, 'self');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { online_mode: 'release' });
    assert.strictEqual(await statusOf(id), '待上线', 'P 夹具：待上线');

    const rel = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(rel.status, 201, 'P 夹具：建批次 201');
    const relMemberCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE release_id = ?`, [rel.body.id])).c;
    // [S1a 补丁 X·X6·codex 506-B #4] 批次成员基线精确化——新建批次的调用前基线本应恒为 0（刚建的空
    //   批次），显式断言这一点，不再只是"记下前值供后面比较"，防"前值其实已经不是 0"这种基线本身
    //   已被污染却被"前后相等"掩盖的场景。
    assert.strictEqual(relMemberCountBefore, 0, '[P] 新建批次调用前成员计数基线应为 0（补丁 X·X6）');
    const add = await call('POST', `/api/sys-releases/${rel.body.id}/add-issues`, adminTok, { issue_ids: [id] });
    assert.strictEqual(add.status, 200, `[S1b 翻转] config 加单应 200, got ${add.status} ${JSON.stringify(add.body)}`);
    assert.strictEqual(add.body.count, 1, '[S1b 翻转] add-issues 响应 count=1');
    const rowAfter = await rowOf(id);
    assert.strictEqual(rowAfter.release_id, rel.body.id, '[S1b 翻转] config 单 release_id 已绑目标批次（DB CHECK 已移除，成功挂入）');
    const relMemberCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE release_id = ?`, [rel.body.id])).c;
    assert.strictEqual(relMemberCountAfter, 1, '[S1b 翻转] 该批次成员计数 0→1（config 单真实挂入，非半写）');
    // 批次详情端点返回的成员含该单（codex 505-B2 M3：不能只信 DB 侧字段，端到端核实读侧也一致）。
    const relDetail = await call('GET', `/api/sys-releases/${rel.body.id}`, adminTok);
    assert.strictEqual(relDetail.status, 200, `[S1b 翻转] 批次详情端点应 200, got ${relDetail.status}`);
    assert.ok(Array.isArray(relDetail.body.issues) && relDetail.body.issues.some((it) => it.id === id),
      `[S1b 翻转] 批次详情端点返回的成员含该 config 单, got ${JSON.stringify(relDetail.body.issues && relDetail.body.issues.map((it) => it.id))}`);
    ok('[S1b 翻转] RELEASABLE_TYPES 含 config、RELEASE_FAMILY_BY_TYPE.config=change；add-issues 200 + release_id=目标批次 + 批次成员计数 0→1 + 批次详情端点返回的成员含该单（DB CHECK 已随 S1b 受控重建移除）');
  }

  // ═══ [U] 上线单整行：config 批次 execute（S1b 验收条件·config流激活_方案_v1.0 §5·预筛 M4/G 登记）═══
  //   拆 CHECK 前这组场景结构性不可达（撞表级 CHECK 500），S1b 落地后必须补齐——纯 config 批次发布 /
  //   混批 / 撤单重挂 / 撤批 / 执行失败路径 / DIRECT_ONLINE_NOT_ELIGIBLE 端到端负例。
  {
    // 局部 helper：把批次执行人补齐到位（notify_status=sent，绕过真实钉钉通知——通知本身非本组验证
    //   目标）+ 走 execute() 到最终确认（真实端点调用，同 verify-sys-release.js publishRelease() 同款
    //   范式：PUT executors 建子表行 → 直接 SQL 标记 notify_status=sent → 依次调用 execute()，非最后一人
    //   先确认应 released:false，最后一人确认才真正触发发布）。
    async function publishConfigBatch(relId, body, primaryId, primaryTok, secondId, secondTok) {
      let rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
      if (rows.length === 0) {
        const rSet = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [primaryId, secondId] });
        if (rSet.status !== 200) return rSet;
        rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
      }
      const notSentIds = rows.filter((r) => r.notify_status !== 'sent').map((r) => r.id);
      if (notSentIds.length > 0) {
        const ph = notSentIds.map(() => '?').join(',');
        await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id IN (${ph})`, notSentIds);
        rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
      }
      const secondRow = rows.find((r) => r.user_id === secondId);
      if (secondRow && secondRow.exec_status === 'pending') {
        const rSecond = await call('POST', `/api/sys-releases/${relId}/execute`, secondTok, { executor_row_id: secondRow.id });
        if (rSecond.status !== 200 || rSecond.body.released !== false) {
          throw new Error(`[U] publishConfigBatch: 第二执行人预确认异常 relId=${relId} status=${rSecond.status} body=${JSON.stringify(rSecond.body)}`);
        }
      }
      const primaryRow = rows.find((r) => r.user_id === primaryId);
      if (!primaryRow) throw new Error(`[U] publishConfigBatch: primaryId=${primaryId} 不在批次 ${relId} 在册执行人中`);
      return call('POST', `/api/sys-releases/${relId}/execute`, primaryTok, { ...body, executor_row_id: primaryRow.id });
    }

    async function configToReady() {
      const cid = await mkAssignable('config');
      await assignConfig(cid, 'self');
      await call('POST', `/api/sys-issues/${cid}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
      await call('POST', `/api/sys-issues/${cid}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
      await call('POST', `/api/sys-issues/${cid}/accept`, adminTok, { online_mode: 'release' });
      assert.strictEqual(await statusOf(cid), '待上线', '[U] 夹具：config 单到待上线');
      return cid;
    }
    // 对照：improvement 单同样走到待上线，用于比对 online_source_kind 是否同源（非 config 专属特殊值）。
    async function improvementToReady() {
      const iid = await mkAssignable('improvement', '二级');
      await call('POST', `/api/sys-issues/${iid}/assign`, adminTok, { assigned_to: 5 });
      await call('POST', `/api/sys-issues/${iid}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
      await call('POST', `/api/sys-issues/${iid}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'u-1' }], self_tested: true, test_env_deployed: true });
      await call('POST', `/api/sys-issues/${iid}/accept`, adminTok, {});
      assert.strictEqual(await statusOf(iid), '待上线', '[U] 夹具：improvement 单到待上线');
      return iid;
    }

    // ── [U1] 纯 config 批次 execute → 单翻已上线 + released_at 非空 + online_source_kind 与 improvement 同源 ──
    const uCfg1 = await configToReady();
    const relU1 = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU1.status, 201, '[U1] 建批次 201');
    const addU1 = await call('POST', `/api/sys-releases/${relU1.body.id}/add-issues`, adminTok, { issue_ids: [uCfg1] });
    assert.strictEqual(addU1.status, 200, `[U1] 加单应 200, got ${addU1.status} ${JSON.stringify(addU1.body)}`);
    const pubU1 = await publishConfigBatch(relU1.body.id, { release_note: '纯 config 批次上线', version_tag: 'u1' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU1.status, 200, `[U1] execute 应 200, got ${pubU1.status} ${JSON.stringify(pubU1.body)}`);
    assert.strictEqual(pubU1.body.released, true, '[U1] execute released=true（本次确认即触发发布，两人批次全 done）');
    const rowU1 = await rowOf(uCfg1);
    assert.strictEqual(rowU1.status, '已上线', '[U1] config 单翻已上线');
    assert.ok(rowU1.released_at, '[U1] released_at 非空');
    const detailU1 = await call('GET', `/api/sys-issues/${uCfg1}`, adminTok);
    assert.strictEqual(detailU1.status, 200, '[U1] 详情端点 200');
    assert.strictEqual(detailU1.body.issue.online_source_kind, 'release_publish', '[U1] online_source_kind=release_publish（批次发布路径）');
    // 对照：improvement 走同一批次发布路径，online_source_kind 应同值。
    const uImp1 = await improvementToReady();
    const relU1b = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU1b.status, 201, '[U1 对照] 建对照批次 201');
    await call('POST', `/api/sys-releases/${relU1b.body.id}/add-issues`, adminTok, { issue_ids: [uImp1] });
    const pubU1b = await publishConfigBatch(relU1b.body.id, { release_note: 'improvement 对照批次', version_tag: 'u1b' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU1b.status, 200, `[U1 对照] improvement execute 应 200, got ${pubU1b.status}`);
    const detailU1b = await call('GET', `/api/sys-issues/${uImp1}`, adminTok);
    assert.strictEqual(detailU1b.body.issue.online_source_kind, 'release_publish', '[U1 对照] improvement online_source_kind 同为 release_publish');
    ok('[U1] 纯 config 批次 execute：单翻已上线 + released_at 非空 + online_source_kind=release_publish，与 improvement 走同一批次发布路径得到的 online_source_kind 同源（DB CHECK 已随 S1b 移除，config 可真实进批次发布）');

    // ── [U2] 混批（config + improvement 同 'change' 族）execute ──────────
    const uCfg2 = await configToReady();
    const uImp2 = await improvementToReady();
    const relU2 = await call('POST', '/api/sys-releases', adminTok, {});
    const addU2 = await call('POST', `/api/sys-releases/${relU2.body.id}/add-issues`, adminTok, { issue_ids: [uCfg2, uImp2] });
    assert.strictEqual(addU2.status, 200, `[U2] 混批加单应 200（config+improvement 同 change 族）, got ${addU2.status} ${JSON.stringify(addU2.body)}`);
    assert.strictEqual(addU2.body.count, 2, '[U2] 混批加单 count=2');
    const pubU2 = await publishConfigBatch(relU2.body.id, { release_note: '混批上线', version_tag: 'u2' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU2.status, 200, `[U2] 混批 execute 应 200, got ${pubU2.status} ${JSON.stringify(pubU2.body)}`);
    assert.deepStrictEqual(pubU2.body.released_issue_ids.slice().sort((a, b) => a - b), [uCfg2, uImp2].slice().sort((a, b) => a - b), '[U2] 混批 released_issue_ids 含两单');
    assert.strictEqual((await rowOf(uCfg2)).status, '已上线', '[U2] config 成员翻已上线');
    assert.strictEqual((await rowOf(uImp2)).status, '已上线', '[U2] improvement 成员翻已上线');
    ok('[U2] 混批（config+improvement 同 change 族）execute：200 + 两单同时翻已上线（RELEASE_FAMILY_BY_TYPE.config=change 与 improvement 同族，混批不受族别校验拦截）');

    // ── [U3] 撤单重挂：批次仍「计划中」时移除 config 成员再重新加回 ──────────
    const uCfg3 = await configToReady();
    const relU3 = await call('POST', '/api/sys-releases', adminTok, {});
    await call('POST', `/api/sys-releases/${relU3.body.id}/add-issues`, adminTok, { issue_ids: [uCfg3] });
    assert.strictEqual((await rowOf(uCfg3)).release_id, relU3.body.id, '[U3] 夹具：config 单已挂批次');
    const rmU3 = await call('POST', `/api/sys-releases/${relU3.body.id}/remove-issues`, adminTok, { issue_ids: [uCfg3] });
    assert.strictEqual(rmU3.status, 200, `[U3] 撤单应 200, got ${rmU3.status} ${JSON.stringify(rmU3.body)}`);
    assert.strictEqual((await rowOf(uCfg3)).release_id, null, '[U3] 撤单后 release_id 清空');
    assert.strictEqual((await rowOf(uCfg3)).status, '待上线', '[U3] 撤单后 status 仍待上线（未被误改）');
    const reAddU3 = await call('POST', `/api/sys-releases/${relU3.body.id}/add-issues`, adminTok, { issue_ids: [uCfg3] });
    assert.strictEqual(reAddU3.status, 200, `[U3] 重挂应 200, got ${reAddU3.status} ${JSON.stringify(reAddU3.body)}`);
    assert.strictEqual((await rowOf(uCfg3)).release_id, relU3.body.id, '[U3] 重挂后 release_id 恢复指向同批次');
    ok('[U3] 撤单重挂：remove-issues 清 release_id（status 不变仍待上线）→ add-issues 重新挂回同批次成功（DB CHECK 已移除，来回操作不再撞约束）');

    // ── [U4] 撤批：批次「计划中」且未通知执行人时可整批删除，成员退回待上线 ──────────
    const uCfg4 = await configToReady();
    const relU4 = await call('POST', '/api/sys-releases', adminTok, {});
    await call('POST', `/api/sys-releases/${relU4.body.id}/add-issues`, adminTok, { issue_ids: [uCfg4] });
    const delU4 = await call('DELETE', `/api/sys-releases/${relU4.body.id}`, adminTok, { reason: '[U4] 撤批测试' });
    assert.strictEqual(delU4.status, 200, `[U4] 撤批应 200, got ${delU4.status} ${JSON.stringify(delU4.body)}`);
    assert.strictEqual(delU4.body.member_count, 1, '[U4] 撤批响应 member_count=1');
    const rowU4 = await rowOf(uCfg4);
    assert.strictEqual(rowU4.release_id, null, '[U4] 撤批后 config 单 release_id 清空');
    assert.strictEqual(rowU4.status, '待上线', '[U4] 撤批后 config 单退回待上线（未被误改其它状态）');
    ok('[U4] 撤批：DELETE /sys-releases/:id（计划中+未通知执行人）→ 200 + config 成员退回待上线 + release_id 清空（批次表被物理删除，成员不受牵连）');

    // ── [U5] 执行失败路径：批次内某成员被造脏（非待上线）→ execute 最终确认时 409 + 整体回滚 ──────────
    const uCfg5a = await configToReady();
    const uCfg5b = await configToReady();
    const relU5 = await call('POST', '/api/sys-releases', adminTok, {});
    const addU5 = await call('POST', `/api/sys-releases/${relU5.body.id}/add-issues`, adminTok, { issue_ids: [uCfg5a, uCfg5b] });
    assert.strictEqual(addU5.status, 200, '[U5] 夹具：两单同批 200');
    await run(`UPDATE sys_issues SET status='开发中' WHERE id=?`, [uCfg5b]);   // 造脏：批次成员之一被拉回开发中（release_id 仍在，同 verify-sys-release.js :380 造脏惯例）
    const relU5TlBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [uCfg5a])).c;
    const pubU5 = await publishConfigBatch(relU5.body.id, { release_note: '成员非待上线负例', version_tag: 'u5' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU5.status, 409, `[U5] 成员非待上线，最终确认应 409, got ${pubU5.status} ${JSON.stringify(pubU5.body)}`);
    assert.strictEqual(pubU5.body.code, 'RELEASE_MEMBER_NOT_READY', '[U5] code=RELEASE_MEMBER_NOT_READY');
    assert.strictEqual((await rowOf(uCfg5a)).status, '待上线', '[U5] 整体回滚：未造脏的 config 成员仍待上线（未被提前翻已上线）');
    assert.strictEqual((await get('SELECT status FROM sys_releases WHERE id=?', [relU5.body.id])).status, '计划中', '[U5] 整体回滚：批次仍计划中（未被误翻已发布）');
    const relU5TlAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [uCfg5a])).c;
    assert.strictEqual(relU5TlAfter, relU5TlBefore, '[U5] 整体回滚：release timeline 零新增');
    ok('[U5] 执行失败路径：批次成员之一被造脏为非待上线 → execute 最终确认 409 RELEASE_MEMBER_NOT_READY + 整体回滚（未造脏成员状态/批次状态/timeline 均零变化）');

    // ── [U6] DIRECT_ONLINE_NOT_ELIGIBLE 端到端负例：挂活跃批次后 accept(direct) → 409 ──────────
    //   正常前向流程下 release_id 只在「待上线」态才可能非空（add-issues 状态闸），accept 只在「待验证」
    //   态触发——两者时间上不重叠。本负例用 SQL 夹具把 config 单停在「待验证」的同时提前挂上一个「计划中」
    //   批次（生产不可达的中间态，同 verify-sys-release.js :380 造脏惯例），验证 evaluateNoCommitDirectOnline
    //   条件②（"存在 active 批次关联"）在这种脏组合下确实经真实 accept() 端点拒绝，非仅函数级单测。
    const uCfg6 = await mkAssignable('config');
    await assignConfig(uCfg6, 'self');
    await call('POST', `/api/sys-issues/${uCfg6}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${uCfg6}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(await statusOf(uCfg6), '待验证', '[U6] 夹具：config 单到待验证（尚未 accept）');
    const relU6 = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU6.status, 201, '[U6] 夹具：建一个计划中批次');
    await run(`UPDATE sys_issues SET release_id=? WHERE id=?`, [relU6.body.id, uCfg6]);   // SQL 夹具：提前挂批次（生产不可达的中间态）
    const acceptU6 = await call('POST', `/api/sys-issues/${uCfg6}/accept`, adminTok, { online_mode: 'direct' });
    assert.strictEqual(acceptU6.status, 409, `[U6] 挂活跃批次后 accept(direct) 应 409, got ${acceptU6.status} ${JSON.stringify(acceptU6.body)}`);
    assert.strictEqual(acceptU6.body.code, 'DIRECT_ONLINE_NOT_ELIGIBLE', '[U6] code=DIRECT_ONLINE_NOT_ELIGIBLE');
    const rowU6 = await rowOf(uCfg6);
    assert.strictEqual(rowU6.status, '待验证', '[U6] 拒绝后单仍停在待验证（未被误翻）');
    // [S1e·补丁 AN·codex 520-B6②] 上一行的消息原写「accepted_at 未落」，但断言只查了 status——
    //   描述强于实作。accepted_at 是 accept 的副作用字段，409 拒绝后它必须仍为 NULL；补成独立断言，
    //   否则「状态没翻但副作用字段已写」这种半提交形态本组抓不到。
    assert.strictEqual(rowU6.accepted_at, null,
      `[U6] 拒绝后 accepted_at 仍为 NULL（accept 的副作用字段不得在 409 路径上落库，实得=${JSON.stringify(rowU6.accepted_at)}）`);
    assert.strictEqual(rowU6.release_id, relU6.body.id, '[U6] 拒绝后 release_id 不变（本负例本就是脏关联，拒绝不清它，留证据）');
    ok('[U6] DIRECT_ONLINE_NOT_ELIGIBLE 真实端到端负例：config 单挂活跃批次后（SQL 夹具造脏中间态）accept(online_mode=direct) → 真实 409（非函数级单测），单据状态不被误翻');

    // ── [U7] 待上线挂批次后 hold（S1d·方案 §7「待上线挂批次后 hold/void」缺口·补丁 AH·AH3 补闸门×回路）──
    //   与 [U6] 不同：这里是**真实**经 add-issues 端点挂进一个「计划中」批次（非 SQL 造脏），批次仍
    //   未发布——§3 状态机表列的 hold.from 集合是 ['待处理','处理中','待验证','待上线']，不区分该单
    //   是否已挂批次；本组按引擎实际行为核验 hold 是否真的放行、以及 release_id 是否被清空（不预设
    //   结论，写明实测结果）。[补丁 AH·AH3·Opus 预筛 M3] 原版只钉了"闸门"（execute 409）没钉"回路"
    //   （能否退出这个受困态）——三个出口（execute/remove-issues/DELETE批次）在已暂缓这个中间态下
    //   同时被堵住，本批补齐 resume 解锁验证，逐口核实回路确实存在。
    const uCfg7 = await configToReady();
    const relU7 = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU7.status, 201, '[U7] 夹具：建一个计划中批次');
    const addU7 = await call('POST', `/api/sys-releases/${relU7.body.id}/add-issues`, adminTok, { issue_ids: [uCfg7] });
    assert.strictEqual(addU7.status, 200, `[U7] 真实挂批次应 200, got ${addU7.status} ${JSON.stringify(addU7.body)}`);
    assert.strictEqual((await rowOf(uCfg7)).release_id, relU7.body.id, '[U7] 夹具：config 单已真实挂批次（非 SQL 造脏）');
    const holdU7 = await call('POST', `/api/sys-issues/${uCfg7}/hold`, adminTok, { reason: '[U7] 批次成员暂缓测试' });
    assert.strictEqual(holdU7.status, 200, `[U7] 挂批次后 hold 应 200（§3 待上线∈hold.from，未额外区分批次归属）, got ${holdU7.status} ${JSON.stringify(holdU7.body)}`);
    const rowU7AfterHold = await rowOf(uCfg7);
    assert.strictEqual(rowU7AfterHold.status, '已暂缓', '[U7] hold 后落已暂缓');
    assert.strictEqual(rowU7AfterHold.release_id, relU7.body.id, '[U7] ⭐ hold 未清 release_id（引擎实际行为：hold 是纯状态转移端点，不感知/不联动批次成员关系——留下"已暂缓单仍挂批次"这一中间态，由下方安全网兜底）');

    // [补丁 AH·AH3] 三口同时收紧核验——execute/remove-issues/DELETE批次 均应 409，各断确切 code，
    // 证明"已暂缓成员仍挂批次"这个中间态是真的把三条出口全堵上，不止 execute 一条。
    // [实测踩坑修复] 先测 execute 会经由 publishConfigBatch 的 PUT /executors 副作用给批次挂上执行人
    // （notify_status='sent'），污染后面 DELETE 批次的判据——DELETE 会先撞"已开始通知执行人不可删"
    // 这条与成员脏态无关的闸（实测 code=RELEASE_NOTIFY_STARTED），不是本条要证的
    // RELEASE_MEMBER_STATE_DIRTY。改为**先测无副作用的两口**（remove-issues / DELETE批次），
    // execute（会挂执行人）放最后测。
    const rmU7Blocked = await call('POST', `/api/sys-releases/${relU7.body.id}/remove-issues`, adminTok, { issue_ids: [uCfg7] });
    assert.strictEqual(rmU7Blocked.status, 409, `[U7] 口②remove-issues：已暂缓成员应 409（index.js:16567 硬要求 status='待上线'）, got ${rmU7Blocked.status} ${JSON.stringify(rmU7Blocked.body)}`);
    assert.strictEqual(rmU7Blocked.body.code, 'ISSUE_NOT_REMOVABLE', '[U7] 口②remove-issues code=ISSUE_NOT_REMOVABLE');
    const delU7Blocked = await call('DELETE', `/api/sys-releases/${relU7.body.id}`, adminTok, { reason: '[U7] 已暂缓三口核验-删批次' });
    assert.strictEqual(delU7Blocked.status, 409, `[U7] 口③DELETE批次：已暂缓成员应 409（index.js:16939 白名单只放 待上线∨已作废）, got ${delU7Blocked.status} ${JSON.stringify(delU7Blocked.body)}`);
    assert.strictEqual(delU7Blocked.body.code, 'RELEASE_MEMBER_STATE_DIRTY', '[U7] 口③DELETE批次 code=RELEASE_MEMBER_STATE_DIRTY');
    const pubU7Blocked = await publishConfigBatch(relU7.body.id, { release_note: '[U7] 已暂缓三口核验-execute', version_tag: 'u7-blocked' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU7Blocked.status, 409, `[U7] 口①execute：已暂缓成员仍挂批次时应 409, got ${pubU7Blocked.status} ${JSON.stringify(pubU7Blocked.body)}`);
    assert.strictEqual(pubU7Blocked.body.code, 'RELEASE_MEMBER_NOT_READY', '[U7] 口①execute code=RELEASE_MEMBER_NOT_READY');
    assert.strictEqual(await statusOf(uCfg7), '已暂缓', '[U7] 三口均被拒后单仍已暂缓（三次尝试零副作用）');
    assert.strictEqual((await get('SELECT status FROM sys_releases WHERE id=?', [relU7.body.id])).status, '计划中', '[U7] 三口均被拒后批次仍计划中（未被误翻）');

    // 回路：resume → 断状态回「待上线」∧ release_id 仍为该批次（证明 hold 造成的阻塞是可逆的，非
    // 永久卡死）→ 口①execute 解锁：resume 后同一批次真能 execute 成功落已上线。
    const resumeU7 = await call('POST', `/api/sys-issues/${uCfg7}/resume`, adminTok, { reason: '[U7] 暂缓解除' });
    assert.strictEqual(resumeU7.status, 200, `[U7] resume 应 200, got ${resumeU7.status} ${JSON.stringify(resumeU7.body)}`);
    const rowU7AfterResume = await rowOf(uCfg7);
    assert.strictEqual(rowU7AfterResume.status, '待上线', '[U7] resume 后回到待上线');
    assert.strictEqual(rowU7AfterResume.release_id, relU7.body.id, '[U7] resume 后 release_id 仍指向同一批次（未被 resume 误清）');
    const pubU7Unlocked = await publishConfigBatch(relU7.body.id, { release_note: '[U7] resume 后解锁 execute', version_tag: 'u7-unlocked' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU7Unlocked.status, 200, `[U7] 口①execute：resume 后应 200（已解锁）, got ${pubU7Unlocked.status} ${JSON.stringify(pubU7Unlocked.body)}`);
    assert.strictEqual(pubU7Unlocked.body.released, true, '[U7] resume 后 execute released=true');
    assert.strictEqual(await statusOf(uCfg7), '已上线', '[U7] resume 后 config 单最终落已上线（hold 造成的阻塞已证明可逆）');

    // 口②remove-issues 解锁（独立夹具，避免与上面 execute 路径互相消耗资源）：hold→resume 后应 200。
    const uCfg7b = await configToReady();
    const relU7b = await call('POST', '/api/sys-releases', adminTok, {});
    await call('POST', `/api/sys-releases/${relU7b.body.id}/add-issues`, adminTok, { issue_ids: [uCfg7b] });
    await call('POST', `/api/sys-issues/${uCfg7b}/hold`, adminTok, { reason: '[U7b] 口②解锁核验' });
    await call('POST', `/api/sys-issues/${uCfg7b}/resume`, adminTok, { reason: '[U7b] 暂缓解除' });
    const rmU7bUnlocked = await call('POST', `/api/sys-releases/${relU7b.body.id}/remove-issues`, adminTok, { issue_ids: [uCfg7b] });
    assert.strictEqual(rmU7bUnlocked.status, 200, `[U7b] 口②remove-issues：resume 后应 200（已解锁）, got ${rmU7bUnlocked.status} ${JSON.stringify(rmU7bUnlocked.body)}`);
    assert.strictEqual((await rowOf(uCfg7b)).release_id, null, '[U7b] remove-issues 成功后 release_id 清空');
    assert.strictEqual((await rowOf(uCfg7b)).status, '待上线', '[U7b] remove-issues 成功后 status 仍待上线');

    // 口③DELETE批次 解锁（第三个独立夹具）：hold→resume 后应 200。
    const uCfg7c = await configToReady();
    const relU7c = await call('POST', '/api/sys-releases', adminTok, {});
    await call('POST', `/api/sys-releases/${relU7c.body.id}/add-issues`, adminTok, { issue_ids: [uCfg7c] });
    await call('POST', `/api/sys-issues/${uCfg7c}/hold`, adminTok, { reason: '[U7c] 口③解锁核验' });
    await call('POST', `/api/sys-issues/${uCfg7c}/resume`, adminTok, { reason: '[U7c] 暂缓解除' });
    const delU7cUnlocked = await call('DELETE', `/api/sys-releases/${relU7c.body.id}`, adminTok, { reason: '[U7c] resume 后删批次' });
    assert.strictEqual(delU7cUnlocked.status, 200, `[U7c] 口③DELETE批次：resume 后应 200（已解锁）, got ${delU7cUnlocked.status} ${JSON.stringify(delU7cUnlocked.body)}`);
    assert.strictEqual((await rowOf(uCfg7c)).release_id, null, '[U7c] 删批次成功后 release_id 清空');
    assert.strictEqual((await rowOf(uCfg7c)).status, '待上线', '[U7c] 删批次成功后 status 仍待上线');

    ok('[U7] 待上线挂批次后 hold + 完整闸门×回路（补丁 AH·AH3）：hold 后三口（execute/remove-issues/DELETE批次）均 409，各自确切 code（RELEASE_MEMBER_NOT_READY／ISSUE_NOT_REMOVABLE／RELEASE_MEMBER_STATE_DIRTY）→ resume 回待上线 ∧ release_id 不变 → 三口逐一验证解锁：execute 200/released（主夹具）、remove-issues 200+release_id清空（uCfg7b）、DELETE批次 200+release_id清空（uCfg7c）——hold 造成的受困态被证明完全可逆，非此前"安全网守住即安全"的半截论断');

    // ── [U8] 待上线挂批次后 void（补丁 AH·AH3 补闸门×回路，补丁 AI·AI6 补主夹具完整恢复链，补丁
    //   AJ·AJ7 订正措辞·codex 515 recommendations；已作废是终态，无 resume——本组实测证实的回路是
    //   DELETE 批次（2026-08-26 codex 474 HIGH-1 把它放进白名单），**未穷尽验证过是否存在其它能清
    //   release_id 的路径**，故不再断言这是"唯一"回路，只如实描述本组已证实的这一条；已通知执行人
    //   的批次须先经对接人 cancel-schedule 撤销安排才能走到这条回路，不是"直接删"这一条路，见下方
    //   主夹具恢复链）──────────
    // [实测踩坑规避·同 U7] execute（经 publishConfigBatch）会给批次挂上执行人（notify_status='sent'），
    // 而 DELETE 批次的既有前置条件是"计划中 + 未通知执行人"（见 [U4]）——若在同一批次上先测过
    // execute 再测 DELETE 批次「已作废应放行 200」，会先撞"已通知执行人不可删"这条更早的闸（实测
    // code=RELEASE_NOTIFY_STARTED）。本批（补丁 AI·AI6）把这条也纳入主夹具验证范围（先撞
    // RELEASE_NOTIFY_STARTED → cancel-schedule → 再 DELETE 200），口③另外单独用一个**从未调用过
    // execute** 的独立批次夹具验证"已作废+未通知"这一更简单组合下可以直接删，口①②仍用主夹具。
    const uCfg8 = await configToReady();
    const relU8 = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU8.status, 201, '[U8] 夹具：建一个计划中批次');
    const addU8 = await call('POST', `/api/sys-releases/${relU8.body.id}/add-issues`, adminTok, { issue_ids: [uCfg8] });
    assert.strictEqual(addU8.status, 200, `[U8] 真实挂批次应 200, got ${addU8.status} ${JSON.stringify(addU8.body)}`);
    const voidU8 = await call('POST', `/api/sys-issues/${uCfg8}/void`, adminTok, { reason: '[U8] 批次成员作废测试' });
    assert.strictEqual(voidU8.status, 200, `[U8] 挂批次后 void 应 200（§3 void：任意态 → 已作废）, got ${voidU8.status} ${JSON.stringify(voidU8.body)}`);
    const rowU8AfterVoid = await rowOf(uCfg8);
    assert.strictEqual(rowU8AfterVoid.status, '已作废', '[U8] void 后落已作废');
    assert.strictEqual(rowU8AfterVoid.release_id, relU8.body.id, '[U8] ⭐ void 同样未清 release_id（引擎实际行为，与 hold 一致：批次成员关系不随 void 同步撤销，"批次成员同步撤"在当前实现中不成立——需业务操作者自行先 remove-issues 再 void，否则留悬空关联）');

    // 口②remove-issues：已作废成员应 409（同 hold，status≠待上线即被 index.js:16567 拦）——钉死这条
    // 路走不通（防将来有人误以为能走）。无副作用，放在会挂执行人的 execute 之前测。
    const rmU8Blocked = await call('POST', `/api/sys-releases/${relU8.body.id}/remove-issues`, adminTok, { issue_ids: [uCfg8] });
    assert.strictEqual(rmU8Blocked.status, 409, `[U8] 口②remove-issues：已作废成员应 409, got ${rmU8Blocked.status} ${JSON.stringify(rmU8Blocked.body)}`);
    assert.strictEqual(rmU8Blocked.body.code, 'ISSUE_NOT_REMOVABLE', '[U8] 口②remove-issues code=ISSUE_NOT_REMOVABLE');
    assert.strictEqual((await rowOf(uCfg8)).release_id, relU8.body.id, '[U8] remove-issues 被拒后 release_id 不变');

    // 口①execute：已作废成员仍挂批次 → 409（既有断言；本调用会给批次挂执行人，放在本夹具最后测）。
    const pubU8 = await publishConfigBatch(relU8.body.id, { release_note: '[U8] 已作废成员安全网', version_tag: 'u8' }, 5, devTok, 6, dev2Tok);
    assert.strictEqual(pubU8.status, 409, `[U8] 口①execute：已作废成员仍挂批次时应 409, got ${pubU8.status} ${JSON.stringify(pubU8.body)}`);
    assert.strictEqual(pubU8.body.code, 'RELEASE_MEMBER_NOT_READY', '[U8] 口①execute code=RELEASE_MEMBER_NOT_READY');
    assert.strictEqual(await statusOf(uCfg8), '已作废', '[U8] execute 被拒后单仍已作废（未被误翻）');

    // [S1d·补丁AI·AI6 根治·codex 514-M3] 此前只用"从未通知的独立夹具"(下方 uCfg8c) 证明了 DELETE
    // 批次这条逃生口在"另一种状态"下可用——不证明**本条主夹具**（已挂执行人∧已发通知∧dev2 已预确认
    // 完成，见上方 publishConfigBatch 调用留下的状态）能退出受困态。主会话已亲核这条恢复路存在：
    // POST /sys-releases/:id/cancel-schedule（仅对接人，index.js:17096，头注明"准入不再看聚合通知
    // 态，只要批次『计划中』即可撤销——partial 态必须有恢复路径，否则卡死"）。补齐主夹具自身的完整
    // 恢复链：execute 失败（已证，上方）→ DELETE 先撞 RELEASE_NOTIFY_STARTED（断确切码，不是"已作废
    // 在白名单内放行"这条）→ 不带 confirm_discard_done 时 cancel-schedule 409（dev2 已 done，须二次
    // 确认）→ 带 confirm_discard_done:true 时 cancel-schedule 200（子表整体软删）→ 再 DELETE 批次
    // 200（成功 + 成员关联解除）——证明主夹具能真正退出受困态，不只是"另一种状态下也有逃生口"。
    const delU8Poisoned = await call('DELETE', `/api/sys-releases/${relU8.body.id}`, adminTok, { reason: '[U8] 主夹具恢复链-第一次DELETE（应被通知态拦）' });
    assert.strictEqual(delU8Poisoned.status, 409, `[U8] 主夹具已挂执行人/已发通知，DELETE 批次应先被 RELEASE_NOTIFY_STARTED 拦（早于成员状态门，index.js:16918）, got ${delU8Poisoned.status} ${JSON.stringify(delU8Poisoned.body)}`);
    assert.strictEqual(delU8Poisoned.body.code, 'RELEASE_NOTIFY_STARTED', '[U8] 主夹具第一次 DELETE 被拦，code=RELEASE_NOTIFY_STARTED');
    const cancelU8NoConfirm = await call('POST', `/api/sys-releases/${relU8.body.id}/cancel-schedule`, intakeTok, { reason: '[U8] 主夹具恢复链-撤销上线安排（未带二次确认）' });
    assert.strictEqual(cancelU8NoConfirm.status, 409, `[U8] cancel-schedule：批次已有 dev2 预确认完成（exec_status='done'），不带 confirm_discard_done 应 409, got ${cancelU8NoConfirm.status} ${JSON.stringify(cancelU8NoConfirm.body)}`);
    assert.strictEqual(cancelU8NoConfirm.body.code, 'CONFIRM_DISCARD_DONE_REQUIRED', '[U8] cancel-schedule 不带确认 code=CONFIRM_DISCARD_DONE_REQUIRED');
    const cancelU8 = await call('POST', `/api/sys-releases/${relU8.body.id}/cancel-schedule`, intakeTok, { reason: '[U8] 主夹具恢复链-撤销上线安排', confirm_discard_done: true });
    assert.strictEqual(cancelU8.status, 200, `[U8] cancel-schedule 带 confirm_discard_done:true 应 200, got ${cancelU8.status} ${JSON.stringify(cancelU8.body)}`);
    const relU8AfterCancel = await get('SELECT status FROM sys_releases WHERE id=?', [relU8.body.id]);
    assert.strictEqual(relU8AfterCancel.status, '计划中', '[U8] cancel-schedule 后批次仍「计划中」（撤销的是执行人安排，不是批次本身，§6.8）');
    const execRowsAfterCancel = await all(`SELECT id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relU8.body.id]);
    assert.strictEqual(execRowsAfterCancel.length, 0, '[U8] cancel-schedule 后执行人子表整体软删（在册为空）');
    const delU8Final = await call('DELETE', `/api/sys-releases/${relU8.body.id}`, adminTok, { reason: '[U8] 主夹具恢复链-第二次DELETE（应放行）' });
    assert.strictEqual(delU8Final.status, 200, `[U8] cancel-schedule 后 DELETE 批次应 200（主夹具自身完整恢复链已闭环）, got ${delU8Final.status} ${JSON.stringify(delU8Final.body)}`);
    const rowU8AfterFinalDelete = await rowOf(uCfg8);
    assert.strictEqual(rowU8AfterFinalDelete.status, '已作废', '[U8] 主夹具删批次后 status 不变仍已作废（void 是终态，删批次不改业务状态）');
    assert.strictEqual(rowU8AfterFinalDelete.release_id, null, '[U8] 主夹具删批次后 release_id 已清空（成员关联解除——主夹具自身已证明能退出受困态，非"换一个夹具证明另一种状态可删"）');

    // 口③DELETE批次（独立夹具，从未通知过执行人，未挂执行人）：已作废在白名单内应**直接**放行 200——
    // 这是"已作废∧从未通知"这一更简单组合下的逃生口（无需先 cancel-schedule）。同批次的正常（待上线）
    // 成员应按 [U4] 既有行为正确退回：release_id 清空 + status 回待上线；已作废成员的业务状态不受
    // 影响（release_id 一并清空，但 status 仍是已作废，不会被误翻）。
    const uCfg8c = await configToReady();
    const uCfg8cNormal = await configToReady();   // 同批次的正常（待上线）成员，供"删批次后正确退回"核验
    const relU8c = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relU8c.status, 201, '[U8c] 夹具：建一个计划中批次');
    const addU8c = await call('POST', `/api/sys-releases/${relU8c.body.id}/add-issues`, adminTok, { issue_ids: [uCfg8c, uCfg8cNormal] });
    assert.strictEqual(addU8c.status, 200, `[U8c] 真实挂批次应 200（两单同批）, got ${addU8c.status} ${JSON.stringify(addU8c.body)}`);
    const voidU8c = await call('POST', `/api/sys-issues/${uCfg8c}/void`, adminTok, { reason: '[U8c] 口③解锁核验-作废' });
    assert.strictEqual(voidU8c.status, 200, `[U8c] void 应 200, got ${voidU8c.status} ${JSON.stringify(voidU8c.body)}`);
    const delU8c = await call('DELETE', `/api/sys-releases/${relU8c.body.id}`, adminTok, { reason: '[U8c] 已作废成员出口核验' });
    assert.strictEqual(delU8c.status, 200, `[U8c] 口③DELETE批次：已作废成员应放行 200（白名单含已作废，codex 474 HIGH-1）, got ${delU8c.status} ${JSON.stringify(delU8c.body)}`);
    const rowU8cAfterDelete = await rowOf(uCfg8c);
    assert.strictEqual(rowU8cAfterDelete.status, '已作废', '[U8c] 删批次后已作废单 status 不变仍已作废（void 是终态，删批次不改业务状态）');
    assert.strictEqual(rowU8cAfterDelete.release_id, null, '[U8c] 删批次后已作废单 release_id 已清空（已作废+未通知这一组合下的直接逃生口生效）');
    const rowU8cNormalAfterDelete = await rowOf(uCfg8cNormal);
    assert.strictEqual(rowU8cNormalAfterDelete.status, '待上线', '[U8c] 同批次正常成员按 [U4] 既有行为正确退回「待上线」');
    assert.strictEqual(rowU8cNormalAfterDelete.release_id, null, '[U8c] 同批次正常成员 release_id 一并清空');

    ok('[U8] 待上线挂批次后 void + 完整闸门×回路（补丁 AH·AH3，主夹具恢复链见补丁 AI·AI6）：void 200 落已作废 ∧ release_id 不清空 → 口①execute 409/RELEASE_MEMBER_NOT_READY、口②remove-issues 409/ISSUE_NOT_REMOVABLE（钉死这条路走不通）→ 主夹具（已作废+已通知）：DELETE 先 409/RELEASE_NOTIFY_STARTED → 对接人 cancel-schedule（须 confirm_discard_done）200 → 再 DELETE 200，release_id 清空——主夹具自身证明能退出受困态；独立夹具（已作废+未通知）：DELETE 直接 200（白名单含已作废，钉住 codex 474 HIGH-1 的成果）+ release_id 清空 + 同批次正常成员按 [U4] 既有行为正确退回待上线。结论改写：已作废+未通知→直接删；已作废+已通知→先 cancel-schedule 再删（不再是"唯一逃生口"这一更强措辞）');
  }

  // ═══ [L4] 通知状态白名单前后端对拍——值 + 接线 + intake 第 5 份副本（S1d·S1c 预筛转入 + 补丁
  //     AH·AH4/AH5 扩面，防第 4 份手抄副本漂移）═══
  {
    // 真相源：I.SYS_NOTIFY_*（后端 sysNotifyStatusesFor 用到的字面量，index.js:19088-19106）；前端
    //   Sys_Iteration.html:1433-1448 的 SI_NOTIFY_* 系列是手抄副本。既有 bug 一族 + feature/improvement
    //   共用的 *_CHANGE 一族此前也裸奔（不止 config 新增的 SI_NOTIFY_DEV_STATUSES_CONFIG 一个），本组
    //   一次性覆盖全部 8 对。
    const htmlPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
    const htmlSrc = fs.readFileSync(htmlPath, 'utf8');
    // [补丁 AH·AH5·Opus 预筛 L2] 原实现只取第一处匹配、不校验唯一性——若将来 HTML 里出现第二处同名
    // const，第二份可以静默漂移，而这正是本组要防的事。改 matchAll 计数，非恰一处先红。
    // （同批订正 L2 指出的注释失配：本函数用 JSON.parse 而非 eval，原 eslint-disable 注释文案有误。）
    function extractFrontendArray(constName) {
      const re = new RegExp(`const ${constName} = (\\[[^\\]]*\\]);`, 'g');
      const matches = [...htmlSrc.matchAll(re)];
      assert.strictEqual(matches.length, 1, `[L4] 前端常量 ${constName} 声明应恰出现 1 次（实得 ${matches.length} 次——0 次说明常量已被删/改名，>1 次说明出现了第二份可能漂移的副本，本条判红防两种坏法）`);
      return JSON.parse(matches[0][1].replace(/'/g, '"'));
    }
    const PAIRS = [
      ['SYS_NOTIFY_DEV_STATUSES', 'SI_NOTIFY_DEV_STATUSES'],
      ['SYS_NOTIFY_RELAY_STATUSES', 'SI_NOTIFY_RELAY_STATUSES'],
      ['SYS_NOTIFY_CREATOR_STATUSES', 'SI_NOTIFY_CREATOR_STATUSES'],
      ['SYS_NOTIFY_REQUESTER_STATUSES', 'SI_NOTIFY_REQUESTER_STATUSES'],
      ['SYS_NOTIFY_DEV_STATUSES_CHANGE', 'SI_NOTIFY_DEV_STATUSES_CHANGE'],
      ['SYS_NOTIFY_CREATOR_STATUSES_CHANGE', 'SI_NOTIFY_CREATOR_STATUSES_CHANGE'],
      ['SYS_NOTIFY_REQUESTER_STATUSES_CHANGE', 'SI_NOTIFY_REQUESTER_STATUSES_CHANGE'],
      ['SYS_NOTIFY_DEV_STATUSES_CONFIG', 'SI_NOTIFY_DEV_STATUSES_CONFIG'],
    ];
    for (const [backendKey, frontendKey] of PAIRS) {
      const backendVal = I[backendKey];
      assert.ok(Array.isArray(backendVal), `[L4] 后端常量 _internals.${backendKey} 存在且为数组（导出漂移/改名时先红，实得=${JSON.stringify(backendVal)}）`);
      const frontendVal = extractFrontendArray(frontendKey);
      assert.ok(Array.isArray(frontendVal), `[L4] 能从 Sys_Iteration.html 提取 ${frontendKey} 字面量（正则锚点漂移时先红，源文件未改动本条不应红）`);
      assert.deepStrictEqual(frontendVal, backendVal, `[L4] 前后端字面量逐值相等：${frontendKey}(前端)=${JSON.stringify(frontendVal)} vs ${backendKey}(后端)=${JSON.stringify(backendVal)}——「实现坏成什么样这条会红」：任一侧改状态名/增删值/调换顺序而另一侧未同步，本条判红`);
    }
    ok('[L4-值] 通知状态白名单前后端对拍：8 对常量（bug 一族 4 个 + feature/improvement 共用 *_CHANGE 一族 3 个 + config 专属 1 个）逐值相等，覆盖 config 与既有三类型全族，防第 4 份（及既有 3 份）手抄副本漂移（补丁 AH·AH5：改 matchAll 计数校验唯一性，防第二处同名声明静默漂移）');

    // [补丁 AH·AH5·Opus 预筛 M1] 只对拍 8 个常量的**值**不够——真正决定行为的是
    // sysNotifyStatusesFor(type, channel) 的**分派表**（哪个 type×channel 格子取哪个常量）。若把
    // config 分支的 developer 误改成取 SI_NOTIFY_DEV_STATUSES（bug 的 ['处理中']，实测这一对当前取值
    // 不同——SI_NOTIFY_DEV_STATUSES_CONFIG=['处理中','待验证']），光比 8 个常量的值发现不了这类
    // "分派表接错常量"的坏法（[L4-值] 只逐个核对常量本身，从不关心 dispatch 表里哪个格子取了哪个
    // 常量）。改为：提取前端函数体原文 + 8 个常量声明原文，在沙箱里用真实源码求值，逐格（4 type ×
    // 4 channel，intake 见下方单独处理）跟后端真实函数 I.sysNotifyStatusesFor 对拍——这一步能检出
    // "分派表接错常量"这一坏法，前提是接错的常量**当前取值**与正确常量不同（[补丁AJ·AJ7 订正·codex
    // 515 recommendations] 本组只逐一核实过上面举例的这一对，**未对 8 个常量做过两两取值均不同的
    // 穷尽验证**，此前"本组 8 个常量两两取值均不同，实测成立"这句话缺乏证据支撑，已删除该前提声明；
    // 若两个常量当前取值恰好相等，本条对"用了哪一个"没有分辨力，见下方 [L4-接线] 断言处如实说明该
    // 结构性限度（AI10·codex 514-L1）。
    function extractFunctionBodyRaw(src, fnName) {
      const startMatch = src.match(new RegExp(`function\\s+${fnName}\\s*\\(([^)]*)\\)\\s*\\{`));
      if (!startMatch) return null;
      const bodyOpenIdx = startMatch.index + startMatch[0].length - 1;
      let depth = 0;
      for (let i = bodyOpenIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { params: startMatch[1], body: src.slice(bodyOpenIdx + 1, i) }; }
      }
      return null;
    }
    const NOTIFY_CONST_NAMES = PAIRS.map((p) => p[1]);
    const constDeclsRaw = NOTIFY_CONST_NAMES.map((name) => {
      const m = htmlSrc.match(new RegExp(`const ${name} = \\[[^\\]]*\\];`));
      assert.ok(m, `[L4-接线] 能提取前端常量声明原文 ${name}（供沙箱求值）`);
      return m[0];
    }).join('\n');
    const fnInfo = extractFunctionBodyRaw(htmlSrc, 'siNotifyStatusesFor');
    assert.ok(fnInfo, '[L4-接线] 能定位前端 siNotifyStatusesFor 函数体原文（正则锚点漂移时先红）');
    // eslint-disable-next-line no-new-func -- 受控字面量（本文件源码内的常量声明 + 函数体原文），非外部输入；
    //   目的是在沙箱里对拍前端"接线"逻辑本身，而非重新实现它。
    const frontendDispatch = new Function(fnInfo.params, `${constDeclsRaw}\n${fnInfo.body}`);
    const TYPES = ['bug', 'feature', 'improvement', 'config'];
    const CHANNELS = ['developer', 'relay', 'creator', 'requester'];   // intake 见下方单独处理（前端不走本函数，是已知不对称）
    for (const type of TYPES) {
      for (const channel of CHANNELS) {
        const feVal = frontendDispatch(type, channel);
        const beVal = I.sysNotifyStatusesFor(type, channel);
        // [S1d·补丁AI·AI10 根治·codex 514-L1，补丁AJ·AJ7 订正措辞·codex 515 recommendations]
        // 原文案称"误取其他常量即便值恰好相等也能测出"——deepStrictEqual 只比较求值结果，两个常量
        // 当前取值恰好相等时必然分辨不出"用的是哪一个引用"，这条能力声明本身不成立（结构性限度，
        // 非本组实现缺陷）。改为如实描述：本条检测的是当前可观察输出（真实函数求值结果）不一致——
        // 分派表接错常量时，只要接错的那个常量**当前取值**与正确常量不同，本条就会判红；本组**未**
        // 对 8 个常量做过两两取值均不同的穷尽验证（此前"两两取值均不同，实测成立"一句缺乏证据支撑，
        // 已删除）——若两个常量当前取值恰好相等，本条对"接的是哪一个"没有分辨力，如实登记该限度。
        assert.deepStrictEqual(feVal, beVal, `[L4-接线] type=${type} channel=${channel}：前端 siNotifyStatusesFor 求值=${JSON.stringify(feVal)} vs 后端 sysNotifyStatusesFor=${JSON.stringify(beVal)}——检测的是当前可观察输出不一致（分派表接错常量且接错的常量当前取值与正确值不同时会判红；两常量当前取值恰好相等时本条无分辨力，这是 deepStrictEqual 比较值本身的结构性限度）`);
      }
    }
    ok('[L4-接线] 通知状态白名单前后端「接线」对拍：4 type × 4 channel（developer/relay/creator/requester）= 16 格，逐格用沙箱求值前端 siNotifyStatusesFor 真实源码 vs 后端 sysNotifyStatusesFor 真实函数，检测当前可观察输出不一致——分派表接错常量的坏法（MUT7 变异只证"分支还在"、不证"取对了常量"）在接错常量的当前取值与正确值不同时会被判红；两常量当前取值恰好相等时本条无分辨力（未对本组 8 个常量做过两两取值均不同的穷尽验证，如实登记该结构性限度，不宣称已证引用映射正确，AI10·codex 514-L1，措辞订正见补丁AJ·AJ7）');

    // [补丁 AH·AH4·Opus 预筛 M2] intake 通道是第 5 份手抄副本——前端**没有** SI_NOTIFY_INTAKE_STATUSES
    // 常量，也不走 siNotifyStatusesFor（三 type 分支的 dispatch 表均无 intake 键，恒 [] 回退），可发
    // 窗口是 Sys_Iteration.html 里一句**内联字面量** `iss.status === '待受理'`。这是既有设计（intake
    // 按钮走的是另一套判定路径），不是前端漏接——但也正因为它是唯一以裸字面量形式存在的一份，最容易
    // 漂移，故显式登记对拍，不能因为它不走同一个函数就假装不存在。
    const intakeLiteralMatch = htmlSrc.match(/if \(iss\.status === '([^']+)' && canOperateIntake/);
    assert.ok(intakeLiteralMatch, '[L4-intake] 能定位 intake 通道可发判据的内联字面量（锚点：`iss.status === \'...\' && canOperateIntake`，漂移时先红）');
    assert.deepStrictEqual([intakeLiteralMatch[1]], I.SYS_NOTIFY_INTAKE_STATUSES, `[L4-intake] intake 通道前端内联字面量 [${intakeLiteralMatch[1]}] 与后端 SYS_NOTIFY_INTAKE_STATUSES=${JSON.stringify(I.SYS_NOTIFY_INTAKE_STATUSES)} 一致（第 5 份副本，此前 [L4] 8 对遗漏的那一份）`);
    // 登记已知不对称：intake 通道下前端 siNotifyStatusesFor 恒 []（三 type 分支 dispatch 表均无
    // intake 键），后端恒 ['待受理']——这是"前端不走该函数、走内联判据"的既有设计差异，不是漂移，
    // 显式断言这个不对称的形状本身，供将来有人"补全" siNotifyStatusesFor 的 intake 分支时能对上账
    // （若真补了，这条会红，提醒同时要检查是否与内联判据重复/冲突，而非静默接受）。
    for (const type of TYPES) {
      assert.deepStrictEqual(frontendDispatch(type, 'intake'), [], `[L4-intake 已知不对称] 前端 siNotifyStatusesFor('${type}','intake') 恒 []（既有设计：intake 按钮不走本函数），若此值改变需同步核实是否与内联字面量判据冲突`);
      assert.deepStrictEqual(I.sysNotifyStatusesFor(type, 'intake'), ['待受理'], `[L4-intake 已知不对称] 后端 sysNotifyStatusesFor('${type}','intake') 恒 ['待受理']`);
    }
    ok('[L4-intake] intake 通道第 5 份副本已纳管：前端内联字面量 `iss.status===\'待受理\'` 与后端 SYS_NOTIFY_INTAKE_STATUSES 对拍一致；同时显式登记"前端 siNotifyStatusesFor 不接 intake、后端接"这一已知不对称的具体形状（非漂移，是既有设计），供未来变更时对账');
  }

  // ═══ [V] config × 验收附件两步链（S1d·方案 §7「打回后重提旧截图不误绑」缺口；底层
  //     resolveEvidenceAttachmentIds 已由 verify-sys-accept-evidence.js 对 improvement 类型逐条证过
  //     通用机制——本组只钉 config 特有的组合：online_mode 与 attachment_ids 同 payload_json 共存、
  //     以及 return→重新提交→再次 accept 跨轮引用同一张附件的真实端到端回路）═══
  {
    const idV = await mkConfigToVerify('self', 'V 组夹具：首轮配置说明');
    const upV1 = await upload(`/api/sys-issues/${idV}/attachments`, devTok, { attachment_type: 'screenshot' }, 'v-round1.png');
    assert.strictEqual(upV1.status, 200, `[V] 首轮上传 screenshot 应 200, got ${upV1.status} ${JSON.stringify(upV1.body)}`);
    const attV1 = upV1.body.attachments[0].id;

    // 打回（return）引用首轮截图 + reason——验证 config 的 return 附件闸与 improvement 同源（RETURN_* 码同款）
    const retV = await call('POST', `/api/sys-issues/${idV}/return`, adminTok, { reason: '配置范围需调整', attachment_ids: [attV1] });
    assert.strictEqual(retV.status, 200, `[V] return 携首轮截图 id 应 200, got ${retV.status} ${JSON.stringify(retV.body)}`);
    assert.strictEqual(await statusOf(idV), '处理中', '[V] return 后回到处理中');
    const tlReturnV = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND event_type='return' ORDER BY id DESC LIMIT 1`, [idV]);
    assert.deepStrictEqual(JSON.parse(tlReturnV.payload_json), { attachment_ids: [attV1] }, '[V] return payload_json 精确形状={attachment_ids:[首轮截图 id]}（config 的 return 附件闸与 improvement 同一份 resolveEvidenceAttachmentIds）');

    // 打回后重提——不上传新截图，直接按打回意见重新 estimate + no_code 提交（第二轮）
    const estV2 = await call('POST', `/api/sys-issues/${idV}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(estV2.status, 200, `[V] 打回后重新 estimate 应 200, got ${estV2.status} ${JSON.stringify(estV2.body)}`);
    const subV2 = await call('POST', `/api/sys-issues/${idV}/submit`, devTok, { mode: 'no_code', no_code_reason: '已按打回意见调整并重新验证', self_tested: true, test_env_deployed: true });
    assert.strictEqual(subV2.status, 200, `[V] 打回后二轮 no_code 提交应 200, got ${subV2.status} ${JSON.stringify(subV2.body)}`);
    assert.strictEqual(await statusOf(idV), '待验证', '[V] 二轮提交后回到待验证');

    // 跨轮直接证据：首轮截图未被打回→重提这条回路静默清理/作废。
    const attV1StillActive = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [attV1]);
    assert.strictEqual(attV1StillActive.status, 'active', '[V] 打回→重提回路跨轮后，首轮截图仍 active（未被静默清理/作废）');

    // 二轮 accept 显式再次引用**同一张**首轮截图 id（真实业务场景：admin 验收时把打回时看过的截图也
    //   一并作为最终验收凭证）——引擎侧无"round"概念，只按 issue_id∧active∧type 校验（resolveEvidence
    //   AttachmentIds 定义处逐字确认），故应放行 200；payload_json 同时含 attachment_ids 与 online_mode
    //   两键（config 特有组合，[H]组此前只钉过"两者皆无"这一态，本条补上互补态）。
    const accV2 = await call('POST', `/api/sys-issues/${idV}/accept`, adminTok, { online_mode: 'release', attachment_ids: [attV1] });
    assert.strictEqual(accV2.status, 200, `[V] 二轮 accept 引用首轮截图 id 应 200（引擎无 round 概念，只校验 issue_id∧active∧type，属既有设计非本组新增行为）, got ${accV2.status} ${JSON.stringify(accV2.body)}`);
    const tlAcceptV = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [idV]);
    assert.deepStrictEqual(JSON.parse(tlAcceptV.payload_json), { attachment_ids: [attV1], online_mode: 'release' }, '[V] ⭐ config accept payload_json 三键潜在组合中 attachment_ids+online_mode 两键共存精确形状（note 未传不落键；[H]组此前只钉过"两者皆无"这一态，本条是它的互补态）');

    // 反例：跨单附件 id（另一张 config 单上传的截图）在本单 accept 中应仍 400——config 场景下 issue_id
    //   隔离闸同样生效，非本组新机制豁免（同 verify-sys-accept-evidence.js [A6] 同款负例，换成 config 类型）。
    const idVOther = await mkConfigToVerify('self', 'V 组另一张单（供跨单附件反例）');
    const upVOther = await upload(`/api/sys-issues/${idVOther}/attachments`, devTok, { attachment_type: 'screenshot' }, 'v-other.png');
    assert.strictEqual(upVOther.status, 200, `[V] 另一张单上传 screenshot 应 200, got ${upVOther.status} ${JSON.stringify(upVOther.body)}`);
    const attVOther = upVOther.body.attachments[0].id;
    const idV3 = await mkConfigToVerify('self', 'V 组第三张单（供跨单附件反例的验收对象）');
    const crossAcc = await call('POST', `/api/sys-issues/${idV3}/accept`, adminTok, { online_mode: 'release', attachment_ids: [attVOther] });
    assert.strictEqual(crossAcc.status, 400, `[V] 跨单附件 id 在 config accept 应 400, got ${crossAcc.status} ${JSON.stringify(crossAcc.body)}`);
    assert.strictEqual(crossAcc.body.code, 'ACCEPT_ATTACHMENT_INVALID', '[V] 跨单附件 code=ACCEPT_ATTACHMENT_INVALID（config 与 improvement 共用同一份 resolveEvidenceAttachmentIds，隔离闸不因类型而异）');
    assert.strictEqual(await statusOf(idV3), '待验证', '[V] 跨单附件被拒后 idV3 状态不变（整事务回滚）');

    // [补丁 AH·AH6·Opus 预筛 M4]「不误绑」负例——方案 §7 原文"打回后重提旧截图不误绑"的字面含义是
    // **不自动继承**：打回时挂过附件的单，重提后 accept **不传** attachment_ids 时，payload_json
    // 里不应凭空出现首轮附件。上面 idV 那次 accept 是**显式重传**了 attachment_ids，证的是"可以
    // 复用"，不是"不会被自动绑上"——两件事；[H] 组"两者皆无"态用的是从没挂过附件的单，同样构不成
    // 对照（它从未经历过"打回时有附件"这个前提）。本条补上真正缺的那一面。
    const idV4 = await mkConfigToVerify('self', 'V4 组夹具：首轮配置说明');
    const upV4 = await upload(`/api/sys-issues/${idV4}/attachments`, devTok, { attachment_type: 'screenshot' }, 'v4-round1.png');
    assert.strictEqual(upV4.status, 200, `[V4] 首轮上传 screenshot 应 200, got ${upV4.status} ${JSON.stringify(upV4.body)}`);
    assert.ok(Array.isArray(upV4.body.attachments) && upV4.body.attachments.length === 1 && Number.isInteger(upV4.body.attachments[0].id) && upV4.body.attachments[0].id > 0, `[V4] 上传响应含恰一个正整数 id 的附件（实得=${JSON.stringify(upV4.body)}）`);
    const attV4 = upV4.body.attachments[0].id;
    const retV4 = await call('POST', `/api/sys-issues/${idV4}/return`, adminTok, { reason: '配置范围需调整', attachment_ids: [attV4] });
    assert.strictEqual(retV4.status, 200, `[V4] return 携首轮截图 id 应 200, got ${retV4.status} ${JSON.stringify(retV4.body)}`);
    const estV4b = await call('POST', `/api/sys-issues/${idV4}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(estV4b.status, 200, `[V4] 打回后重新 estimate 应 200, got ${estV4b.status} ${JSON.stringify(estV4b.body)}`);
    const subV4b = await call('POST', `/api/sys-issues/${idV4}/submit`, devTok, { mode: 'no_code', no_code_reason: '已按打回意见调整并重新验证', self_tested: true, test_env_deployed: true });
    assert.strictEqual(subV4b.status, 200, `[V4] 打回后二轮 no_code 提交应 200, got ${subV4b.status} ${JSON.stringify(subV4b.body)}`);
    // 二轮 accept **不传** attachment_ids（也不传 note）——核心断言：引擎不应把打回轮次挂过的附件
    // "自动继承"进这次 accept 的 payload_json。
    const accV4 = await call('POST', `/api/sys-issues/${idV4}/accept`, adminTok, { online_mode: 'release' });
    assert.strictEqual(accV4.status, 200, `[V4] 二轮 accept（不传 attachment_ids）应 200, got ${accV4.status} ${JSON.stringify(accV4.body)}`);
    const tlAcceptV4 = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [idV4]);
    assert.deepStrictEqual(JSON.parse(tlAcceptV4.payload_json), { online_mode: 'release' }, `[V4] ⭐「不误绑」核心断言：accept 不传 attachment_ids 时 payload_json 恰只含 online_mode 一键，不会凭空出现 attachment_ids（实得=${tlAcceptV4.payload_json}）——证明引擎不会把打回轮次挂过的附件自动继承进本次验收，方案 §7"不误绑"的字面含义在此得到独立验证（非靠"引擎无 round 概念"这条推理带过）`);

    ok('[V] config × 验收附件两步链：return 携首轮截图 200+payload_json 精确形状（与 improvement 同源闸）；打回→重提（重新 estimate+no_code 提交）跨轮后首轮截图仍 active；二轮 accept 复用首轮截图 id 200（引擎无 round 概念，issue_id∧active∧type 为唯一校验维度）+ payload_json.attachment_ids/online_mode 两键共存精确形状（[H]组"两者皆无"态的互补态）；跨单附件 id 在 config accept 场景下仍 400 ACCEPT_ATTACHMENT_INVALID（隔离闸不因类型而异）；[补丁 AH·AH6]「不误绑」负例：打回携附件→重提→accept 不传 attachment_ids → payload_json 恰无该键，证明不会自动继承旧附件（方案 §7 原文字面含义独立验证，非本组此前用"可复用"推理代替）');
  }

  // ═══ [X] accept 重复请求与状态竞争（S1d·方案 §7「accept 重复请求与状态竞争」缺口；补丁 AI·AI7
  //   根治 codex 514-M7）═══
  {
    // [S1d·补丁AI·AI7 根治·codex 514-M7→补丁AJ·AJ4 订正措辞·codex 515-M4] AI7 曾声称"sentAt/recvAt
    // 时间戳证明两次请求确有重叠"+"若 maxSockets 被收紧为 1 该断言必判红"——两条声明**都不成立**：
    // `callTimed` 的 `sentAt = Date.now()` 记录在 `http.request(...)` **创建之前**（连接池排队/DNS/
    // TCP 握手等耗时都发生在这一行之后），只反映"JS 调用点被执行的时刻"，不反映"字节真正上线"的时刻。
    // `Promise.all` 里两次 `callTimed(...)` 调用在同一个微任务里背靠背同步执行，无论底层连接是否被
    // 排成串行（哪怕 maxSockets=1 强制真串行），两次 `sentAt` 都会记录得几乎同时——"重叠"断言在两种
    // 情形下（真并发 / 客户端排队串行）都会通过，对"是否真的同时在飞"没有实际分辨力。
    // 如实收窄结论：本组证明的是"**调用生命周期重叠**（两次调用几乎同时发起，均未等待对方完成）+
    // 重复请求下的最终一致"，不是"已证请求真的同时在网络层飞行"，更不是"已证服务端事务级串行化
    // （sysTxnMutex）"——要独立证明后者需要服务端插桩记录两请求进入临界区的实际顺序，本组未做，不
    // 宣称。显式独立 Agent（maxSockets:2）保留——它的作用是**不依赖** `http.globalAgent` 的运行时
    // 默认值这一隐性前提，但不改变"sentAt 测不出真并发"这一结构性限度。
    // direct 场景在通用断言之外补核上线字段（released_at/online_source），不只断 status 字符串。
    const xAgent = new http.Agent({ keepAlive: false, maxSockets: 2 });
    async function runXScenario(label, onlineMode) {
      const idX = await mkConfigToVerify('self');
      const [r1, r2] = await Promise.all([
        callTimed('POST', `/api/sys-issues/${idX}/accept`, adminTok, { online_mode: onlineMode }, xAgent),
        callTimed('POST', `/api/sys-issues/${idX}/accept`, adminTok, { online_mode: onlineMode }, xAgent),
      ]);
      const overlapped = r1.sentAt < r2.recvAt && r2.sentAt < r1.recvAt;
      assert.ok(overlapped, `[X-${label}] 两次调用的生命周期未重叠（r1: sentAt=${r1.sentAt} recvAt=${r1.recvAt}；r2: sentAt=${r2.sentAt} recvAt=${r2.recvAt}）——本组已退化为客户端先后两次调用（连"调用生命周期重叠"这一弱前提都不成立），下方断言即便全绿也不能算作已验证本场景`);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepStrictEqual(statuses, [200, 400], `[X-${label}] 并发两次 accept 应恰一成功一失败（200+400），got ${JSON.stringify([r1.status, r2.status])} bodies=${JSON.stringify([r1.body, r2.body])}`);
      const loser = r1.status === 200 ? r2 : r1;
      assert.strictEqual(loser.body.code, 'INVALID_TRANSITION', `[X-${label}] 落败请求 code 应为 INVALID_TRANSITION（重复请求命中"该态已不再支持该动作"）, got ${JSON.stringify(loser.body)}`);
      const expectStatus = onlineMode === 'direct' ? '已上线' : '待上线';
      const finalRow = await get('SELECT status, released_at, online_source FROM sys_issues WHERE id=?', [idX]);
      assert.strictEqual(finalRow.status, expectStatus, `[X-${label}] 最终状态恰为「${expectStatus}」（未被重复 accept 破坏，非重入两次）`);
      if (onlineMode === 'direct') {
        // [S1d·补丁AJ·AJ4] direct 场景补核上线字段——此前只断 status 字符串，不足以证明"真的走完了
        // 上线这一动作"（若引擎某处退化成"只改状态不写时间戳/来源"，仅看 status 测不出）。
        assert.ok(finalRow.released_at, `[X-direct] released_at 应非空（实得=${JSON.stringify(finalRow.released_at)}）`);
        assert.strictEqual(finalRow.online_source, 'no_commit_acceptance', `[X-direct] online_source 应为 no_commit_acceptance（零 commit 直接生效路径唯一写入值），实得=${JSON.stringify(finalRow.online_source)}`);
      }
      const tlAcceptCount = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept'`, [idX]);
      assert.strictEqual(tlAcceptCount.c, 1, `[X-${label}] timeline 只有一条 accept 行（未被并发重复写入两条）`);
    }
    await runXScenario('release', 'release');
    await runXScenario('direct', 'direct');
    ok('[X] accept 重复请求与状态竞争（release/direct 两场景，补丁 AI·AI7，补丁 AJ·AJ4 订正措辞）：显式独立 Agent（不依赖 http.globalAgent 的运行时默认）+ sentAt/recvAt 证明两次调用生命周期重叠（均未等待对方完成即发起，非先后两次调用）→ 恰一次 200 落对应终态（direct 场景另核 released_at/online_source）+ 落败请求 400 INVALID_TRANSITION（无 expected_status 前置锁，靠状态机 fromStatus 精确匹配天然堵重复推进）+ timeline 仅一条 accept 行。证据边界如实声明：sentAt 记在 http.request 创建前（含连接池排队等待），不能证明字节真的同时在网络层飞行，也不能证明服务端事务级排队（sysTxnMutex）——本组证明的是"调用生命周期重叠 + 重复请求下的最终一致"这一较弱但真实成立的结论，不宣称"已证真并发"或"已证 sysTxnMutex"');
  }

  // ═══ [Q] 对照组：improvement 关键节点零回归 ═══
  {
    const id = await mkAssignable('improvement', '二级');
    const asg = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asg.status, 200, '[Q] improvement assign 应 200（无需 exec_mode）, got ' + asg.status);
    assert.strictEqual(await statusOf(id), '开发中', '[Q] improvement 指派后落「开发中」（状态名未被 config 改动污染）');
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const s = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'q-1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(s.status, 200, '[Q] improvement submit 带 commits 应 200（CONFIG_NO_COMMITS 不误伤）, got ' + s.status);
    assert.strictEqual(await statusOf(id), '待验证', '[Q] improvement 提交后落「待验证」');
    const acc = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acc.status, 200, '[Q] improvement accept 不带 online_mode 应 200（原逻辑不受影响）, got ' + acc.status);
    assert.strictEqual(await statusOf(id), '待上线', '[Q] improvement accept → 待上线');
    const reassign = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, {});
    // [S1a 补丁 T·M3] 精确断言 400+VALIDATION（原 notStrictEqual(500) 是近似恒真——若实现退化成
    //   400 EXEC_MODE_NOT_APPLICABLE 等口径错的码，notStrictEqual(500) 照样通过，测不出真问题）。
    //   上面这次改派缺 member_ids，预期 400 VALIDATION（原有校验，非本次改动，见 index.js:7629）。
    assert.strictEqual(reassign.status, 400, `[Q] improvement reassign 缺 member_ids 应 400, got ${reassign.status} ${JSON.stringify(reassign.body)}`);
    assert.strictEqual(reassign.body.code, 'VALIDATION', '[Q] improvement reassign 缺 member_ids code=VALIDATION（config 改动零回归，非退化成别的码）');

    // [S1a 补丁 V·V2·codex 505-A M2] 字段存在即校验——非 config 类型显式传 null 值也应被判定为"携带"
    //   而拒绝（此前 hasOwnProperty && value != null 的判据会让 null 被当成"未传"而静默放行）。
    //   「实现坏成什么样这条会红」：若 V2 的判据被回退（非 config 分支仍看 != null），三条 null 携带
    //   用例中前两条（improvement）会从 400 变成"当作未传"的既有正常行为（accept 200/assign 200）。
    const idV2Accept = await mkAssignable('improvement', '二级');
    const asgV2 = await call('POST', `/api/sys-issues/${idV2Accept}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asgV2.status, 200, 'V2 accept 夹具：improvement assign 200');
    await call('POST', `/api/sys-issues/${idV2Accept}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const sV2 = await call('POST', `/api/sys-issues/${idV2Accept}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'v2-1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(sV2.status, 200, 'V2 accept 夹具：improvement submit 200');
    assert.strictEqual(await statusOf(idV2Accept), '待验证', 'V2 accept 夹具：已到待验证');
    const acceptNull = await call('POST', `/api/sys-issues/${idV2Accept}/accept`, adminTok, { online_mode: null });
    assert.strictEqual(acceptNull.status, 400, `[Q] improvement accept 带 online_mode:null 应 400, got ${acceptNull.status} ${JSON.stringify(acceptNull.body)}`);
    assert.strictEqual(acceptNull.body.code, 'ONLINE_MODE_NOT_APPLICABLE', '[Q] online_mode:null 也算携带，code=ONLINE_MODE_NOT_APPLICABLE（补丁 V·V2）');

    const idV2Assign = await mkAssignable('improvement', '二级');
    const assignNull = await call('POST', `/api/sys-issues/${idV2Assign}/assign`, adminTok, { assigned_to: 5, exec_mode: null });
    assert.strictEqual(assignNull.status, 400, `[Q] improvement assign 带 exec_mode:null 应 400, got ${assignNull.status} ${JSON.stringify(assignNull.body)}`);
    assert.strictEqual(assignNull.body.code, 'EXEC_MODE_NOT_APPLICABLE', '[Q] exec_mode:null 也算携带，code=EXEC_MODE_NOT_APPLICABLE（补丁 V·V2）');

    const idV2ConfigAssign = await mkAssignable('config');
    const configAssignNull = await call('POST', `/api/sys-issues/${idV2ConfigAssign}/assign`, adminTok, { assigned_to: 5, exec_mode: null });
    assert.strictEqual(configAssignNull.status, 400, `[Q] config assign 带 exec_mode:null 应 400, got ${configAssignNull.status} ${JSON.stringify(configAssignNull.body)}`);
    assert.strictEqual(configAssignNull.body.code, 'EXEC_MODE_REQUIRED', '[Q] config exec_mode:null 视为未携带（缺省），code=EXEC_MODE_REQUIRED（补丁 V·V2，config 分支 null 仍视为缺失，与非 config 分支语义相反）');

    // [S1a 补丁 V·V3] improvement 对照组：mode='no_code' + 非空 commits → 400 VALIDATION，文案与改前逐字相同。
    const idV3Contrast = await mkAssignable('improvement', '二级');
    const asgV3 = await call('POST', `/api/sys-issues/${idV3Contrast}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asgV3.status, 200, 'V3 对照组夹具：improvement assign 200');
    await call('POST', `/api/sys-issues/${idV3Contrast}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const rV3Contrast = await call('POST', `/api/sys-issues/${idV3Contrast}/submit`, devTok, { mode: 'no_code', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'v3-1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(rV3Contrast.status, 400, `[Q] improvement mode=no_code 携带非空 commits 应 400, got ${rV3Contrast.status} ${JSON.stringify(rV3Contrast.body)}`);
    assert.strictEqual(rV3Contrast.body.code, 'VALIDATION', '[Q] improvement mode=no_code 携带非空 commits code=VALIDATION（非 config，未改码）');
    assert.strictEqual(rV3Contrast.body.error, 'no_code 模式不应携带非空 commits', '[Q] 文案与改前逐字相同（对照组，补丁 V·V3）');

    // [S1a 补丁 X·X2·codex 506-A M3] 优先级验证：improvement 在册开发对「待验证」态单据（状态非法，非
    //   DEV 族）提交 no_code+非空 commits 畸形体 → 仍 400 VALIDATION（非 409 INVALID_STATUS），证明畸形体
    //   判定已前移到状态合法性检查之前。「实现坏成什么样这条会红」：若前移被回退，本条从 400 变 409。
    const idX2 = await mkAssignable('improvement', '二级');
    const asgX2 = await call('POST', `/api/sys-issues/${idX2}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(asgX2.status, 200, 'X2 夹具：improvement assign 200');
    await call('POST', `/api/sys-issues/${idX2}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    const s1X2 = await call('POST', `/api/sys-issues/${idX2}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'x2-1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(s1X2.status, 200, 'X2 夹具：improvement submit 200（进入待验证）');
    assert.strictEqual(await statusOf(idX2), '待验证', 'X2 夹具：已到待验证（非 DEV 族，正是本组要验证的非法状态）');
    const rX2Malformed = await call('POST', `/api/sys-issues/${idX2}/submit`, devTok, { mode: 'no_code', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'x2-2' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(rX2Malformed.status, 400, `[Q] improvement 待验证态（状态非法）+ 畸形体应仍 400（非 409）, got ${rX2Malformed.status} ${JSON.stringify(rX2Malformed.body)}`);
    assert.strictEqual(rX2Malformed.body.code, 'VALIDATION', '[Q] improvement 畸形体优先于状态合法性：code=VALIDATION（补丁 X·X2）');
    // 对照：同单据合法 no_code 体（无 commits）→ 409 INVALID_STATUS（证明只有畸形体优先，合法体仍受状态闸拦）
    const rX2Legal = await call('POST', `/api/sys-issues/${idX2}/submit`, devTok, { mode: 'no_code', no_code_reason: 'y', self_tested: true, test_env_deployed: true });
    assert.strictEqual(rX2Legal.status, 409, `[Q] improvement 待验证态 + 合法体应 409 INVALID_STATUS（对照组）, got ${rX2Legal.status} ${JSON.stringify(rX2Legal.body)}`);
    assert.strictEqual(rX2Legal.body.code, 'INVALID_STATUS', '[Q] improvement 合法体仍受状态闸拦截（补丁 X·X2 对照组）');

    ok('[Q] 对照组 improvement：assign 无需 exec_mode、submit 带 commits 不受 CONFIG_NO_COMMITS 影响、accept 不需 online_mode、reassign 缺字段精确 400 VALIDATION —— 逐条同今；null 携带三例（accept/assign/config assign，补丁 V·V2）；mode=no_code 携带非空 commits 400 VALIDATION 文案逐字不变（补丁 V·V3）；畸形体优先于状态合法性 400（非 409），合法体仍受状态闸拦（补丁 X·X2）');
  }

  // ═══ [R] 补丁：set-oa-number 对 config 的可填窗口（2026-09-07 主会话 J 判断，SYS_OA_ALLOWED_STATUSES.config）═══
  //   config 单来源本就是 OA 流入（方案 v1.6 §18.1）——集合＝improvement 复制后状态名替换
  //   （待指派→待处理、开发中→处理中，其余四态逐字保留：待验证/待上线/已上线/已暂缓）。
  {
    // 处理中态：应放行（config 集合含「处理中」）
    const id = await mkAssignable('config');
    await assignConfig(id, 'self');
    assert.strictEqual(await statusOf(id), '处理中', 'R 夹具：config 已到处理中');
    const oaOk = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026090101' });
    assert.strictEqual(oaOk.status, 200, `[R] config 处理中态 set-oa-number 应 200, got ${oaOk.status} ${JSON.stringify(oaOk.body)}`);
    assert.strictEqual((await rowOf(id)).oa_number, '2026090101', '[R] config OA 号落库');

    // 待受理态：应拒绝（不在 config 集合内，沿既有错误码）
    const freshId = (await create('config')).body.id;
    assert.strictEqual(await statusOf(freshId), '待受理', 'R 夹具：config 新单待受理');
    const oaBad = await call('POST', `/api/sys-issues/${freshId}/set-oa-number`, adminTok, { oa_number: '2026090102' });
    assert.strictEqual(oaBad.status, 409, `[R] config 待受理态 set-oa-number 应 409, got ${oaBad.status} ${JSON.stringify(oaBad.body)}`);
    assert.strictEqual(oaBad.body.code, 'OA_NUMBER_STATUS_NOT_ALLOWED', '[R] config 待受理态 code=OA_NUMBER_STATUS_NOT_ALLOWED（沿端点既有错误码）');
    assert.strictEqual((await rowOf(freshId)).oa_number, null, '[R] config 待受理态被拒后 oa_number 仍为 NULL');

    // 对照组：improvement 不受影响——开发中态仍可填（既有行为），待受理态仍拒绝（既有行为，非因本次改动新增）
    const impId = await mkAssignable('improvement', '二级');
    const impAsg = await call('POST', `/api/sys-issues/${impId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(impAsg.status, 200, 'R 对照组夹具：improvement 指派 200');
    assert.strictEqual(await statusOf(impId), '开发中', 'R 对照组夹具：improvement 已到开发中');
    const impOaOk = await call('POST', `/api/sys-issues/${impId}/set-oa-number`, adminTok, { oa_number: '2026090103' });
    assert.strictEqual(impOaOk.status, 200, `[R对照] improvement 开发中态 set-oa-number 仍应 200（不变）, got ${impOaOk.status} ${JSON.stringify(impOaOk.body)}`);

    const impFreshId = (await create('improvement')).body.id;
    const impOaBad = await call('POST', `/api/sys-issues/${impFreshId}/set-oa-number`, adminTok, { oa_number: '2026090104' });
    assert.strictEqual(impOaBad.status, 409, `[R对照] improvement 待受理态 set-oa-number 仍应 409（不变，非本次新增）, got ${impOaBad.status} ${JSON.stringify(impOaBad.body)}`);
    assert.strictEqual(impOaBad.body.code, 'OA_NUMBER_STATUS_NOT_ALLOWED', '[R对照] improvement 待受理态 code 不变');

    ok('[R] set-oa-number 对 config：处理中态 200 落库、待受理态 409 OA_NUMBER_STATUS_NOT_ALLOWED（SYS_OA_ALLOWED_STATUSES.config=improvement 替换状态名）；对照组 improvement 开发中/待受理两态行为不变');
  }

  // ═══ [S] config reassign 族门 override（T3·H4·暂缓期改派冻结 + 待处理不得绕过 assign）═══
  //   MEMBER_ACTION_FAMILY_TYPE_OVERRIDE.reassign.config=['DEV','VERIFY']（index.js:3295 一带）——
  //   config 待处理（D_PRE，受理后未指派）与已暂缓（D_PRE）均不在族门内，assertMemberActionFamilyAllowed
  //   （index.js:7666）应先于任何写操作拒绝（409 INVALID_STATUS，assertRosterNotFrozen 对 config 不生效
  //   ——该函数 bug-only，config 走的是族门本身排除 D_PRE，见 index.js:3513-3517）。
  {
    // 待处理（受理后未指派）：不得绕过 assign 直接改派采集 exec_mode
    const pendingId = await mkAssignable('config');
    assert.strictEqual(await statusOf(pendingId), '待处理', 'S 夹具：config 待处理（未指派）');
    const rPending = await call('POST', `/api/sys-issues/${pendingId}/reassign`, adminTok, { member_ids: [5], reason: '待处理态尝试改派', exec_mode: 'self' });
    assert.strictEqual(rPending.status, 409, `[S] config 待处理态 reassign 应拒（非 500）, got ${rPending.status} ${JSON.stringify(rPending.body)}`);
    assert.strictEqual(rPending.body.code, 'INVALID_STATUS', '[S] config 待处理态 reassign code=INVALID_STATUS（族门排除 D_PRE）');
    const pendingRoster = await all('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [pendingId]);
    assert.strictEqual(pendingRoster.length, 0, '[S] config 待处理态 reassign 被拒后 sys_issue_dev_assignees 零行（未曾 assign，本就零行，验证拒绝发生在任何写之前）');
    assert.strictEqual((await rowOf(pendingId)).exec_mode, null, '[S] config 待处理态 reassign 被拒后 exec_mode 仍 NULL');

    // 已暂缓（处理中 hold 后）：暂缓期改派冻结不变量对 config 同样生效
    const holdId = await mkAssignable('config');
    await assignConfig(holdId, 'self');
    assert.strictEqual(await statusOf(holdId), '处理中', 'S 夹具：config 已到处理中');
    const holdRosterBefore = await all('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY id', [holdId]);
    const h = await call('POST', `/api/sys-issues/${holdId}/hold`, adminTok, { reason: 'S 组暂缓' });
    assert.strictEqual(h.status, 200, 'S 夹具：hold 200');
    assert.strictEqual(await statusOf(holdId), '已暂缓', 'S 夹具：config 已暂缓');
    const rHold = await call('POST', `/api/sys-issues/${holdId}/reassign`, adminTok, { member_ids: [5], reason: '已暂缓态尝试改派', exec_mode: 'vendor', vendor_name: '试图绕过' });
    assert.strictEqual(rHold.status, 409, `[S] config 已暂缓态 reassign 应拒（非 500）, got ${rHold.status} ${JSON.stringify(rHold.body)}`);
    assert.strictEqual(rHold.body.code, 'INVALID_STATUS', '[S] config 已暂缓态 reassign code=INVALID_STATUS（族门排除 D_PRE）');
    const holdRosterAfter = await all('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY id', [holdId]);
    assert.deepStrictEqual(holdRosterAfter.map(r => r.id), holdRosterBefore.map(r => r.id), '[S] config 已暂缓态 reassign 被拒后 roster 行 id 集合前后相等');

    ok('[S] config reassign 族门 override：待处理（未指派）与已暂缓两态均 409 INVALID_STATUS（非 500）——前者 sys_issue_dev_assignees 零行+exec_mode 仍 NULL，后者 roster id 集合前后相等（暂缓期改派冻结不变量对 config 同样生效）');
  }

  // ═══ [T] config return（验收打回 待验证→处理中）═══ [S1a 补丁 T·M4]
  //   方案 §7 验证矩阵明列"打回"是 config 主流程正常回路，也是"受困态恢复路"关键一环，S1a 交付零覆盖。
  {
    const id = await mkAssignable('config');
    await assignConfig(id, 'self');

    // 先 estimate 落 dev_estimated_at
    const est1 = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(est1.status, 200, `[T] 首次 estimate 应 200, got ${est1.status} ${JSON.stringify(est1.body)}`);
    assert.ok((await rowOf(id)).dev_estimated_at, '[T] dev_estimated_at 已落库');

    // admin set_scheduled_start 落值（要求 isDevWorkState 且 dev_estimated_at 非空，两者此刻均满足）
    const schedDate = futureEst(1).slice(0, 10);
    const sched = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: schedDate });
    assert.strictEqual(sched.status, 200, `[T] set-scheduled-start 应 200, got ${sched.status} ${JSON.stringify(sched.body)}`);
    assert.strictEqual((await rowOf(id)).scheduled_start, schedDate, '[T] scheduled_start 落库');

    // 提交到「待验证」
    const s1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '已在测试环境完成配置校验', self_tested: true, test_env_deployed: true });
    assert.strictEqual(s1.status, 200, `[T] submit 应 200, got ${s1.status} ${JSON.stringify(s1.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[T] submit 后落待验证');

    // 缺 reason → 400（不动状态）
    const noReason = await call('POST', `/api/sys-issues/${id}/return`, adminTok, {});
    assert.strictEqual(noReason.status, 400, `[T] 缺 reason 应 400, got ${noReason.status} ${JSON.stringify(noReason.body)}`);
    assert.strictEqual(noReason.body.code, 'RETURN_REASON_REQUIRED', '[T] 缺 reason code=RETURN_REASON_REQUIRED');
    assert.strictEqual(await statusOf(id), '待验证', '[T] 缺 reason 被拒后状态原样');

    // return（带 reason）→ 处理中 + return_count+1 + dev_estimated_at/scheduled_start 清空 + 时间线 return 行存在
    const rowBeforeReturn = await rowOf(id);
    const ret = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '配置参数需调整' });
    assert.strictEqual(ret.status, 200, `[T] return（带 reason）应 200, got ${ret.status} ${JSON.stringify(ret.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[T] return → 处理中（状态名替换）');
    const rowAfterReturn = await rowOf(id);
    assert.strictEqual(rowAfterReturn.return_count, (Number(rowBeforeReturn.return_count) || 0) + 1, '[T] return_count +1');
    assert.strictEqual(rowAfterReturn.dev_estimated_at, null, '[T] dev_estimated_at 清空');
    assert.strictEqual(rowAfterReturn.scheduled_start, null, '[T] scheduled_start 清空');
    // ⚠️ return 条目 timelineEvent='return'、actionCode=null（同 improvement/feature/bug 四流同源，
    //   transitions.js 各流 action:'return' 条目逐字一致）——查真实落库须按 event_type，非 action_code。
    const tlReturn = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='return'`, [id]);
    assert.ok(tlReturn, '[T] 时间线存在 return 行（event_type=return）');

    // 自救回路闭合：打回后 dev5 经 remove+re-add 仍在册（新一轮 pending 实例）——重新 estimate → 再次
    //   no_code 提交 → 回到待验证。
    const est2 = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(est2.status, 200, `[T] 打回后重新 estimate 应 200（dev5 经 remove+re-add 仍在册）, got ${est2.status} ${JSON.stringify(est2.body)}`);
    const s2 = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '已按打回意见调整配置并重新验证', self_tested: true, test_env_deployed: true });
    assert.strictEqual(s2.status, 200, `[T] 打回后重新 no_code 提交应 200, got ${s2.status} ${JSON.stringify(s2.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[T] 自救回路闭合：重新提交后回到待验证');

    ok('[T] config return（验收打回）：estimate+set-scheduled-start 落值 → submit no_code 到待验证 → 缺 reason 400 → return 200+处理中+return_count+1+dev_estimated_at/scheduled_start 清空+时间线 return 行 → 重新 estimate+submit no_code 回到待验证（自救回路闭合）');
  }

  // ═══ [W1] 移除最后一个未完成成员立即触发 W-GATE（补丁 W·W1·B1-M1）═══
  //   「实现坏成什么样这条会红」：若 runWGate 在 reassign 的移除分支被跳过（如 execOnlyChange 误判/
  //   代表选举提前 return），主状态会停在「处理中」，下方 statusOf/main_status 两条断言均会红。
  {
    const idW1 = await mkAssignable('config');
    await assignConfig(idW1, 'self');   // dev5 已指派
    const addW1_6 = await call('POST', `/api/sys-issues/${idW1}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(addW1_6.status, 200, `[W1] 加协作开发 dev6 应 200, got ${addW1_6.status} ${JSON.stringify(addW1_6.body)}`);
    await call('POST', `/api/sys-issues/${idW1}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    const s1W1 = await call('POST', `/api/sys-issues/${idW1}/submit`, devTok, { mode: 'no_code', no_code_reason: '配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(s1W1.status, 200, `[W1] dev5 no_code 提交应 200, got ${s1W1.status} ${JSON.stringify(s1W1.body)}`);
    assert.strictEqual(await statusOf(idW1), '处理中', '[W1] 夹具：dev6 仍 pending，主状态仍处理中');

    const r1 = await call('POST', `/api/sys-issues/${idW1}/reassign`, adminTok, { member_ids: [5], reason: '移除未完成成员 dev6' });
    assert.strictEqual(r1.status, 200, `[W1] reassign 移除 dev6（仅剩 dev5 且已 no_code）应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.main_status, '待验证', '[W1] 响应体 main_status 立即待验证（同事务内 W-GATE 触发，非下一次请求才可见）');
    assert.strictEqual(await statusOf(idW1), '待验证', '[W1] 落库主状态立即待验证');
    const rosterW1 = await all('SELECT user_id, dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [idW1]);
    assert.strictEqual(rosterW1.length, 1, '[W1] 在册只剩 1 人（dev6 已移除）');
    assert.strictEqual(rosterW1[0].user_id, 5, '[W1] 在册剩 dev5');
    assert.strictEqual(rosterW1[0].dev_status, 'no_code', '[W1] dev5 dev_status 仍 no_code（未被移除动作重置）');
    // 两条审计轨迹分工明确（runWGate 函数体注释「codex 裁断 b」）：成员变更只落 sys_issue_dev_events，
    //   主状态变化只落 sys_issue_timeline（event_type='status_change'），reassign 本身不写"成员变更"
    //   timeline 行——故分别在各自真实的表里查，不臆造一条不存在的"时间线成员变更行"。
    const devEventW1 = await get(`SELECT id FROM sys_issue_dev_events WHERE issue_id=? AND action='remove' AND dev_assignee_id IN (SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6) ORDER BY id DESC LIMIT 1`, [idW1, idW1]);
    assert.ok(devEventW1, '[W1] sys_issue_dev_events 存在 dev6 的 remove 成员变更事件行');
    const wgateTlW1 = await get(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='status_change' AND from_status='处理中' AND to_status='待验证' ORDER BY id DESC LIMIT 1`, [idW1]);
    assert.ok(wgateTlW1, '[W1] sys_issue_timeline 存在 W-GATE 状态变更行（处理中→待验证，action_code 恒 NULL，见 runWGate 注释）');

    // 反向：待验证态 reassign 新增 pending 成员 → 回读真实结果（引擎既定规则，不猜）。
    const r2 = await call('POST', `/api/sys-issues/${idW1}/reassign`, adminTok, { member_ids: [5, 8], reason: '待验证态追加新成员' });
    assert.strictEqual(r2.status, 200, `[W1反向] 待验证态新增 pending 成员应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.main_status, '处理中', '[W1反向] 待验证态新增未完成成员后主状态回落「处理中」（runWGate 对 VERIFY 族 roster 不再全完成时降级，实测值，非假设）');
    assert.strictEqual(await statusOf(idW1), '处理中', '[W1反向] 落库主状态同步回落「处理中」');

    ok('[W1] 移除最后一个未完成成员立即触发 W-GATE：主状态立即待验证 + 在册剩 dev5(no_code) + dev_events remove 行 + timeline status_change 行（处理中→待验证）；反向：待验证态追加新 pending 成员 → 主状态回落处理中（回读引擎真实结果）');
  }

  console.log(`\n✅ verify-sys-config-flow 全部通过（${passed} 组·S1a config 流激活后端状态机与端点）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
