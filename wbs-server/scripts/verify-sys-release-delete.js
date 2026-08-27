// 验证脚本：上线单管理体验优化 R-C6 —— DELETE /sys-releases/:id 删除上线单（方案 20260824_v1.3 §3 O4）
//   用法：node scripts/verify-sys-release-delete.js
//
// 覆盖范围（方案 §6 O4 断言逐条 + spec 硬约束 + S11 预筛拦截①/②收口 + codex 474 HIGH-1/MED-1/MED-2 收口）：
//   非 admin 403 / 不存在 404 / 非法 ID 400 / 已发布 409 RELEASE_NOT_PLANNING（零写入）/
//   通知已启动 409 RELEASE_NOTIFY_STARTED（本闸无 D8 例外，title 为空同样硬拒）/
//   reason 缺失·超长·空白串 400 RELEASE_DELETE_REASON_REQUIRED /
//   450-M1 脏数据用例（S11 拦截①收口后判据）：成员 status ∉ {「待上线」,「已作废」} → 409
//   RELEASE_MEMBER_STATE_DIRTY 且整体回滚 / 成员为「已作废」不算脏、放行且拆分退回分支（③④）/
//   级联完整性 N=0/1/3：待上线成员 release_id 全 NULL 且 status 仍「待上线」/ 每张成员恰增一条
//   release_deleted / ⭐ 混合成员用例（codex 474 MED-2）：同批次 1 待上线+1 已作废 → 两支分别生效、
//   互不干扰，留痕/审计对两类一视同仁 /
//   450-H3 执行人行物理删除无孤儿（含 2 在册+1 已软删的全量快照对拍）/
//   sys_issue_release_commit_snapshots 兜底清理（非天然空批次场景下真实验证 DELETE 执行）/
//   审计表 action='delete' 恰 1 条；reason／release_json／operator_id+operator_name／release_no 四类
//   字段与删除前实际值/提交值/JWT actor 身份逐一回读对拍（非仅存在性判断，S11 拦截②收口）；
//   member_count／member_issue_ids／executors_json 另有专项断言（见 N=0/1/3 与执行人快照两组）/
//   空批次删除仍走通且审计恰 1 条 /
//   删除后 GET 404 / 幂等二次删 404 / 反向证明：其他批次成员与执行人不受影响 /
//   ⭐ 死锁端到端断言（O4 立命之本）：删批次 → 对原待上线成员单发 DELETE /sys-issues/:id → 200 且行消失 /
//   ⭐ 受困态解除端到端断言：批次成员 void 后（release_id 仍挂，status='已作废'）→ 删批次 200 → 该单
//   release_id 已清且 status 仍「已作废」（终态不因批次删除而位移）/
//   ⭐ 归属守卫交叉断言（codex 474 HIGH-1）：两批次各带一张已作废成员，只删其中一个 → 另一批次的已作废
//   成员 release_id/status 完全不受影响（跨批次隔离，验证已作废分支 UPDATE 改单条 release_id=? 集合谓词
//   后仍精确限定本批次） /
//   四组变异自证（级联漏步→红 / 审计形态坏→CHECK 拒 / ③放宽判据收窄回卷→受困态断言翻红 / ④已作废分支
//   剥除 release_id 归属守卫→跨批次误清红，坐实 HIGH-1 原始风险）。
//   ⚠️ commit 后路径隔离（codex 474 MED-1 + 复审 MED-1）：committed 标志 + 收尾日志独立 try/catch + 外层
//   catch 的 committed 分支降级返回成功；⭐ 复审 LOW-1：成功响应体（successBody）提前构造一次，正常路径
//   与 committed 降级路径共用同一个对象，极端路径响应契约与正常路径逐字段一致。⭐ [10] 已用真实抛错
//   logger（info 方法 throw）行为级验证"日志异常绝不改变已提交删除的结果"这条 logger 故障面（200 +
//   successBody 三键完整 + 批次行已删 + 审计行已落）；**仍未覆盖**的只剩 `res.json`/`headersSent` 序列化
//   本身异常这类几乎不可达的边缘路径（无法在不侵入运行时的前提下可靠构造），如实保留未覆盖。
//   ⚠️ 变异字符串定位脆弱性（codex 474 复审 LOW-2）：登记接受，不动——[9]/[10] 全部变异均已配 occurrences
//   ===1 的锚点计数前置校验（源码结构一旦变化会先在 `-pre` 步骤显式报错，不会静默失效），是本文件与
//   verify-sys-release-edit.js 等同族守卫共同的既定取舍（文本锚点 + 计数自证，非 AST 解析），非本批引入
//   的新债务。
//
// 真实 HTTP 层验证（对齐 verify-sys-release-edit.js 范式：真实 express app + http.Server + JWT 多角色
//   夹具 + `:memory:` 工厂注入档）；issue/release 前置态优先走真实端点（POST /sys-releases、add-issues、
//   PUT executors、POST /sys-issues/:id/void），仅"批次已发布""成员脏状态"这类无法经正常业务流程构造的
//   异常前置态用直连 SQL 捷径。
//
// 断言纪律：全程精确状态码 + 精确 error code，不用 status>=400 弱判据；正例断言真实落库副作用，非仅状态码。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET = 'verify-sys-release-delete-secret';
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
const testDeps = () => require('./_sys-attach-test-deps');

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...testDeps(),
});
const I = mod._internals;
function waitReadyOn(internals) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (internals.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (internals.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(internals.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}
const waitReady = () => waitReadyOn(I);

// ── 多角色 JWT 夹具（对齐 verify-sys-release-edit.js：测试 id 与生产 users.id 无对应关系）──────────
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const userTok = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);   // 非 admin，403 用例

let server, port;
function makeCaller(getPort) {
  return (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: getPort(), path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const call = makeCaller(() => port);
const deleteRelease = (id, tok, body) => call('DELETE', `/api/sys-releases/${id}`, tok, body);
const getRelease = (id, tok) => call('GET', `/api/sys-releases/${id}`, tok);

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 直连 SQL / HTTP 混合夹具（对齐 verify-sys-release-edit.js 范式）──────────
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员')`,
    [type, status, extra.title || `${type}-${status}-单`]
  );
  return r.lastID;
}
async function mkRelease(extra = {}) {
  const body = { planned_date: extra.plannedDate || undefined };
  if (Object.prototype.hasOwnProperty.call(extra, 'title')) body.title = extra.title;
  if (Object.prototype.hasOwnProperty.call(extra, 'version_tag')) body.version_tag = extra.version_tag;
  if (Object.prototype.hasOwnProperty.call(extra, 'release_note')) body.release_note = extra.release_note;
  const r = await call('POST', '/api/sys-releases', adminTok, body);
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function addIssuesTo(relId, issueIds) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: issueIds });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
async function setExecutors(relId, userIds) {
  const r = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: userIds });
  assert.strictEqual(r.status, 200, `setExecutors PUT 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
}
async function markSent(relId) {
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
}
async function setReleaseStatus(id, status) {
  await run(`UPDATE sys_releases SET status=? WHERE id=?`, [status, id]);
}
// S11 预筛拦截①：走真实迁移引擎作废一张单——`from:'*'`（任意态，见 transitions.js case 'void'）+
// 不清 release_id（既有历史行为，本批未改），用于构造"已作废但仍挂批次"的受困态前置。
async function voidIssue(id, tok, reason) {
  const r = await call('POST', `/api/sys-issues/${id}/void`, tok, { reason });
  assert.strictEqual(r.status, 200, `voidIssue(#${id}) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const deleteIssue = (id, tok, body) => call('DELETE', `/api/sys-issues/${id}`, tok, body);
const releaseRow = (id) => get(`SELECT * FROM sys_releases WHERE id=?`, [id]);
const issueRow = (id) => get(`SELECT * FROM sys_issues WHERE id=?`, [id]);
const deleteTimelineRows = (relId) => all(
  `SELECT * FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_deleted' ORDER BY id`, [relId]
);
const auditRows = (relId) => all(`SELECT * FROM sys_release_audit WHERE release_id=? AND action='delete' ORDER BY id`, [relId]);
const executorRows = (relId) => all(`SELECT * FROM sys_release_executors WHERE release_id=? ORDER BY id`, [relId]);

// ── [变异] 变异自证公共设施：现场读取真实 index.js 源码 → 定点文本替换 → 写临时兄弟文件（同目录，保证
//   相对 require 不失效）→ 独立实例加载 → 用回调跑场景断言 → finally 清理临时文件与 server/db。
//   （逐字对齐 verify-sys-release-edit.js 既有范式）
const REAL_INDEX_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
const REAL_SRC = fs.readFileSync(REAL_INDEX_PATH, 'utf8');

async function buildMutantInstance(mutantFactory, deps) {
  const mmod = mutantFactory(deps);
  const MI = mmod._internals;
  mmod.initSchema();
  await waitReadyOn(MI);
  let mserver = null;
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mmod.router); mserver = app.listen(0, '127.0.0.1', res); });
  const mcall = makeCaller(() => mserver.address().port);
  return { mod: mmod, internals: MI, call: mcall, close: () => { try { mserver.close(); } catch (_) { /* ignore */ } } };
}

async function withMutantModule(mutatedSrc, depsOverride, scenario) {
  const tmpName = `.mutant-${crypto.randomBytes(6).toString('hex')}.js`;
  const tmpPath = path.join(path.dirname(REAL_INDEX_PATH), tmpName);
  let inst = null;
  try {
    fs.writeFileSync(tmpPath, mutatedSrc, 'utf8');
    delete require.cache[require.resolve(tmpPath)];
    const mutantFactory = require(tmpPath);
    const baseDeps = {
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      authenticateToken, requireAdmin,
      ...testDeps(),
    };
    inst = await buildMutantInstance(mutantFactory, { ...baseDeps, ...depsOverride });
    await scenario({ call: inst.call, internals: inst.internals, mutantFactory, baseDeps });
  } finally {
    try { inst && inst.close(); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13800000001'),
    (5,'dev5','开发甲','user','active','13800000005'),
    (6,'dev6','开发乙','user','active','13800000006'),
    (7,'dev7','开发丙','user','active','13800000007')`);
  await new Promise(res => {
    const app = express();
    app.use(express.json());
    app.use('/api', mod.router);
    app.use((err, req, res, next) => {
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '无效的JSON格式' });
      }
      next(err);
    });
    server = app.listen(0, '127.0.0.1', res);
  });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / dev5,6,7）');

  // ─────────────────────────────────────────────────────────────────────────
  // [1] 权限 / 存在性 / 参数校验基础负例
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '批次A' });
    const rNonAdmin = await deleteRelease(relId, userTok, { reason: '误建，需要删除' });
    assert.strictEqual(rNonAdmin.status, 403, `[1a] 非 admin 应 403, got ${rNonAdmin.status} ${JSON.stringify(rNonAdmin.body)}`);
    ok('[1a] 非 admin 删除 403（route-level requireAdmin 生效——若守卫被误删/降级此断言会转 200/其它业务码而非 403）');
    const rowAfter1a = await releaseRow(relId);
    assert.ok(rowAfter1a, '[1a] 非 admin 403 拒绝：批次仍在（零写入）');

    const rNotFound = await deleteRelease(999999, adminTok, { reason: '不存在的批次' });
    assert.strictEqual(rNotFound.status, 404, `[1b] 不存在应 404, got ${rNotFound.status}`);
    assert.strictEqual(rNotFound.body.code, 'RELEASE_NOT_FOUND', `[1b] code 应 RELEASE_NOT_FOUND, got ${rNotFound.body.code}`);
    ok('[1b] 批次不存在 404 RELEASE_NOT_FOUND（若 SELECT * 现值查询被误删会在后续步骤 500 而非此处 404）');

    const rBadId = await call('DELETE', '/api/sys-releases/not-a-number', adminTok, { reason: 'x' });
    assert.strictEqual(rBadId.status, 400, `[1c] 非法 ID 应 400, got ${rBadId.status}`);
    assert.strictEqual(rBadId.body.code, 'INVALID_RELEASE_ID', `[1c] code, got ${rBadId.body.code}`);
    ok('[1c] 非法批次 ID 400 INVALID_RELEASE_ID（parsePositiveId 前置闸·不进事务）');

    const rNoReason = await deleteRelease(relId, adminTok, {});
    assert.strictEqual(rNoReason.status, 400, `[1d] reason 缺失应 400, got ${rNoReason.status} ${JSON.stringify(rNoReason.body)}`);
    assert.strictEqual(rNoReason.body.code, 'RELEASE_DELETE_REASON_REQUIRED', `[1d] code, got ${rNoReason.body.code}`);
    ok('[1d] reason 缺失 → 400 RELEASE_DELETE_REASON_REQUIRED');

    const rBlankReason = await deleteRelease(relId, adminTok, { reason: '   ' });
    assert.strictEqual(rBlankReason.status, 400, `[1e] reason 空白串应 400, got ${rBlankReason.status} ${JSON.stringify(rBlankReason.body)}`);
    assert.strictEqual(rBlankReason.body.code, 'RELEASE_DELETE_REASON_REQUIRED', '[1e] code');
    ok('[1e] reason 纯空白串（trim 后为空）→ 400 RELEASE_DELETE_REASON_REQUIRED（不当作"已填写"放行）');

    const rLongReason = await deleteRelease(relId, adminTok, { reason: 'x'.repeat(201) });
    assert.strictEqual(rLongReason.status, 400, `[1f] reason 超长应 400, got ${rLongReason.status} ${JSON.stringify(rLongReason.body)}`);
    assert.strictEqual(rLongReason.body.code, 'RELEASE_DELETE_REASON_REQUIRED', '[1f] code');
    ok('[1f] reason 超长（>200）→ 400 RELEASE_DELETE_REASON_REQUIRED');

    await setReleaseStatus(relId, '已发布');
    const rPublished = await deleteRelease(relId, adminTok, { reason: '已发布批次尝试删除' });
    assert.strictEqual(rPublished.status, 409, `[1g] 已发布应 409, got ${rPublished.status} ${JSON.stringify(rPublished.body)}`);
    assert.strictEqual(rPublished.body.code, 'RELEASE_NOT_PLANNING', `[1g] code 应 RELEASE_NOT_PLANNING, got ${rPublished.body.code}`);
    const rowAfter1g = await releaseRow(relId);
    assert.ok(rowAfter1g, '[1g] 已发布批次被拒绝的 DELETE 不删除任何行（批次仍在）');
    const auditAfter1g = await auditRows(relId);
    assert.strictEqual(auditAfter1g.length, 0, '[1g] 已发布批次拒绝路径：审计表零写入');
    ok('[1g] 已发布批次删除 409 RELEASE_NOT_PLANNING 且零写入（status 门先于一切其它判断生效，已发布批次快照/时间线是历史事实永不可删）');
    await setReleaseStatus(relId, '计划中');   // 复原

    const relNotify = await mkRelease({ title: '通知已启动批次' });   // title 缺省=NULL（对照 O3 的 D8 例外，本端点无此豁免）
    await setExecutors(relNotify, [5]);
    await markSent(relNotify);
    const rNotifyStarted = await deleteRelease(relNotify, adminTok, { reason: '尝试删除已通知批次' });
    assert.strictEqual(rNotifyStarted.status, 409, `[1h] 通知已启动应 409, got ${rNotifyStarted.status} ${JSON.stringify(rNotifyStarted.body)}`);
    assert.strictEqual(rNotifyStarted.body.code, 'RELEASE_NOTIFY_STARTED', `[1h] code, got ${rNotifyStarted.body.code}`);
    const rowAfter1h = await releaseRow(relNotify);
    assert.ok(rowAfter1h, '[1h] 通知已启动批次被拒绝的 DELETE 不删除任何行');
    ok('[1h] 通知已启动（聚合态=sent）→ 409 RELEASE_NOTIFY_STARTED（需请对接人先撤销上线安排）——⚠️ 本闸无 D8 例外：即使 title 现值为空（本批次建单时未填），delete 依然硬拒，不像 O3/PATCH 那样对"补空"网开一面');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [2] 450-M1 fail-closed：成员状态一致性校验——脏数据用例
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '脏数据批次' });
    const goodId = await mkIssue('feature', '待上线');
    const dirtyId = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [goodId, dirtyId]);
    // 绕开正常业务流程，直接把其中一张成员单的 status 改脏（模拟"脏数据/并发前置异常"——正常状态机路径
    // 不会出现"release_id 非空但 status≠待上线"，这里是刻意构造 DB 层没有约束住的边界）。
    await run(`UPDATE sys_issues SET status='开发中' WHERE id=?`, [dirtyId]);

    const auditBefore = await auditRows(relId);
    const r = await deleteRelease(relId, adminTok, { reason: '脏数据批次尝试删除' });
    assert.strictEqual(r.status, 409, `[2a] 脏数据应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RELEASE_MEMBER_STATE_DIRTY', `[2a] code, got ${r.body.code}`);
    assert.ok(Array.isArray(r.body.bad_member_ids) && r.body.bad_member_ids.includes(dirtyId) && !r.body.bad_member_ids.includes(goodId),
      `[2a] bad_member_ids 应恰含脏成员 #${dirtyId}（不含正常成员 #${goodId}），实得 ${JSON.stringify(r.body.bad_member_ids)}`);
    ok('[2a] 450-M1 fail-closed：批次内存在 status≠「待上线」的成员 → 409 RELEASE_MEMBER_STATE_DIRTY，错误体 bad_member_ids 精确列出异常成员');

    const rowAfter = await releaseRow(relId);
    assert.ok(rowAfter, '[2b] 拒绝后批次仍在（整体回滚，未走到硬删）');
    const goodAfter = await issueRow(goodId);
    const dirtyAfter = await issueRow(dirtyId);
    assert.strictEqual(goodAfter.release_id, relId, '[2b] 整体回滚：正常成员 release_id 未被清空');
    assert.strictEqual(goodAfter.status, '待上线', '[2b] 整体回滚：正常成员 status 未被改动');
    assert.strictEqual(dirtyAfter.release_id, relId, '[2b] 整体回滚：脏成员 release_id 同样未被清空（不因它触发了拒绝就单独处理它）');
    assert.strictEqual(dirtyAfter.status, '开发中', '[2b] 整体回滚：脏成员 status 原样保留');
    const auditAfter = await auditRows(relId);
    assert.strictEqual(auditAfter.length, auditBefore.length, '[2b] 整体回滚：审计表零新增');
    ok('[2b] 450-M1 整体回滚验证：拒绝请求不产生任何部分提交——批次/两张成员单/审计表全部保持删除前原状（"宁可拒绝并要求先修数据"不是口号，是真回滚）');

    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [dirtyId]);   // 复原，供后续用例复用 id 空间不冲突（本批次本身不再使用）
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [3] 级联完整性 N=0/1/3：release_id 全 NULL 且 status 仍「待上线」+ 时间线逐成员 + 审计恰 1 条
  // ─────────────────────────────────────────────────────────────────────────
  {
    // N=0：空批次
    const rel0 = await mkRelease({ title: '空批次' });
    const r0 = await deleteRelease(rel0, adminTok, { reason: '空批次删除' });
    assert.strictEqual(r0.status, 200, `[3-N0] 应 200, got ${r0.status} ${JSON.stringify(r0.body)}`);
    assert.strictEqual(r0.body.ok, true, '[3-N0] ok=true');
    assert.strictEqual(r0.body.member_count, 0, '[3-N0] member_count=0');
    const rowGone0 = await releaseRow(rel0);
    assert.strictEqual(rowGone0, undefined, '[3-N0] sys_releases 行硬删（空批次同样真删）');
    const au0 = await auditRows(rel0);
    assert.strictEqual(au0.length, 1, '[3-N0] 空批次：审计表恰 1 条（D9 兜底——空批次的删除仍必须留痕）');
    assert.strictEqual(au0[0].member_count, 0, '[3-N0] 审计 member_count=0');
    assert.deepStrictEqual(JSON.parse(au0[0].member_issue_ids), [], "[3-N0] 审计 member_issue_ids='[]'");
    assert.deepStrictEqual(JSON.parse(au0[0].executors_json), [], '[3-N0] 空批次无执行人：审计 executors_json 为空数组（合法，非 NULL）');
    ok('[3-N0] N=0（空批次）：批次硬删 + 审计恰 1 条（member_count=0/member_issue_ids=[]/executors_json=[]），D9 空批次留痕成立');

    // N=1：单成员批次
    const rel1 = await mkRelease({ title: '单成员批次' });
    const iid1 = await mkIssue('feature', '待上线');
    await addIssuesTo(rel1, [iid1]);
    const r1 = await deleteRelease(rel1, adminTok, { reason: '单成员批次删除' });
    assert.strictEqual(r1.status, 200, `[3-N1] 应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.member_count, 1, '[3-N1] member_count=1');
    const issue1After = await issueRow(iid1);
    assert.strictEqual(issue1After.release_id, null, '[3-N1] D10：成员 release_id 已清空');
    assert.strictEqual(issue1After.status, '待上线', '[3-N1] D10：成员 status 仍为「待上线」（只清 release_id，status 不动）');
    const tl1 = await deleteTimelineRows(rel1);
    assert.strictEqual(tl1.length, 1, '[3-N1] 时间线恰 1 条');
    assert.strictEqual(tl1[0].issue_id, iid1, '[3-N1] 该条挂在唯一成员单上');
    assert.strictEqual(tl1[0].event_type, 'note', "[3-N1] event_type='note'（在 CHECK 15 值域内）");
    assert.strictEqual(tl1[0].action_code, 'release_deleted', "[3-N1] action_code='release_deleted'");
    const au1 = await auditRows(rel1);
    assert.strictEqual(au1.length, 1, '[3-N1] 审计恰 1 条');
    assert.strictEqual(au1[0].member_count, 1, '[3-N1] 审计 member_count=1');
    assert.deepStrictEqual(JSON.parse(au1[0].member_issue_ids), [iid1], '[3-N1] 审计 member_issue_ids 恰含该成员');
    ok('[3-N1] N=1：成员退回「待上线」（release_id=NULL，status 不动）+ 时间线恰 1 条（event_type=note/action_code=release_deleted）+ 审计恰 1 条，member_issue_ids 与实际成员一致');

    // N=3：三成员批次，逐张对拍（不是总数对就行——总数对也可能是集中写给同一张单）
    const rel3 = await mkRelease({ title: '三成员批次' });
    const ids3 = [];
    for (let k = 0; k < 3; k++) ids3.push(await mkIssue('feature', '待上线'));
    await addIssuesTo(rel3, ids3);
    const r3 = await deleteRelease(rel3, adminTok, { reason: '三成员批次删除' });
    assert.strictEqual(r3.status, 200, `[3-N3] 应 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.member_count, 3, '[3-N3] member_count=3');
    for (const iid of ids3) {
      const row = await issueRow(iid);
      assert.strictEqual(row.release_id, null, `[3-N3] 成员 #${iid} release_id 已清空`);
      assert.strictEqual(row.status, '待上线', `[3-N3] 成员 #${iid} status 仍为「待上线」`);
    }
    const tl3 = await deleteTimelineRows(rel3);
    assert.strictEqual(tl3.length, 3, '[3-N3] 时间线恰 3 条');
    const perMemberCount = {};
    for (const row of tl3) perMemberCount[row.issue_id] = (perMemberCount[row.issue_id] || 0) + 1;
    for (const iid of ids3) assert.strictEqual(perMemberCount[iid], 1, `[3-N3] 成员单 #${iid} 应恰 1 条（防总数对但集中写给同一张单）`);
    const au3 = await auditRows(rel3);
    assert.strictEqual(au3.length, 1, '[3-N3] 审计恰 1 条（不随成员数线性增长）');
    assert.strictEqual(au3[0].member_count, 3, '[3-N3] 审计 member_count=3');
    const auditMemberSet3 = new Set(JSON.parse(au3[0].member_issue_ids));
    const timelineMemberSet3 = new Set(tl3.map(r => r.issue_id));
    assert.deepStrictEqual([...auditMemberSet3].sort((a, b) => a - b), [...timelineMemberSet3].sort((a, b) => a - b),
      '[3-N3] 审计 member_issue_ids 集合 === 本次实际写入时间线的 issue_id 集合（同源互证，防"只插必填列⇒非空批次被记成空批次"）');
    ok('[3-N3] N=3：时间线恰 3 条且每张成员各恰 1 条 + 审计恰 1 条 + member_issue_ids 与实际写入时间线的成员集合逐一对拍相等');

    // ⭐ [3-mixed]（codex 474 MED-2）：同批次混合成员——1 待上线 + 1 已作废，验证③④两条分支在**同一次
    // 删除**里各自独立生效、互不干扰，且留痕/审计对两类成员一视同仁（防未来把审计集合悄悄改成只收
    // pendingMemberIds 这类隐蔽回归）。
    const relMix = await mkRelease({ title: '混合成员批次' });
    const iidMixPending = await mkIssue('feature', '待上线');
    const iidMixVoided = await mkIssue('feature', '待上线');
    await addIssuesTo(relMix, [iidMixPending, iidMixVoided]);
    await setExecutors(relMix, [5, 6]);
    await voidIssue(iidMixVoided, adminTok, '混合成员批次：其中一张作废');
    const execBeforeMix = await executorRows(relMix);
    assert.strictEqual(execBeforeMix.length, 2, '[3-mixed-pre] 删除前执行人恰 2 行（5/6 在册）');

    const rMix = await deleteRelease(relMix, adminTok, { reason: '混合成员批次删除' });
    assert.strictEqual(rMix.status, 200, `[3-mixed] 应 200, got ${rMix.status} ${JSON.stringify(rMix.body)}`);
    assert.strictEqual(rMix.body.member_count, 2, '[3-mixed] member_count=2（两类合计）');

    const pendingAfterMix = await issueRow(iidMixPending);
    assert.strictEqual(pendingAfterMix.release_id, null, '[3-mixed] 待上线成员 release_id 已清空');
    assert.strictEqual(pendingAfterMix.status, '待上线', '[3-mixed] 待上线成员 status 原样保留');
    const voidedAfterMix = await issueRow(iidMixVoided);
    assert.strictEqual(voidedAfterMix.release_id, null, '[3-mixed] 已作废成员 release_id 已清空');
    assert.strictEqual(voidedAfterMix.status, '已作废', '[3-mixed] 已作废成员 status 原样保留（终态不因批次删除而位移）');

    const tlMix = await deleteTimelineRows(relMix);
    assert.strictEqual(tlMix.length, 2, '[3-mixed] 时间线恰 2 条（两类成员各一条）');
    const tlPendingRow = tlMix.find(row => row.issue_id === iidMixPending);
    const tlVoidedRow = tlMix.find(row => row.issue_id === iidMixVoided);
    assert.ok(tlPendingRow && !tlPendingRow.summary.includes('已作废'), '[3-mixed] 待上线成员时间线文案不含"已作废"字样（用的是「已退回待上线」版本，非误用已作废文案）');
    assert.ok(tlVoidedRow && tlVoidedRow.summary.includes('已作废'), '[3-mixed] 已作废成员时间线文案含"已作废"字样（用的是专属版本，非误用待上线文案）');

    const auMix = await auditRows(relMix);
    assert.strictEqual(auMix.length, 1, '[3-mixed] 审计恰 1 条');
    assert.strictEqual(auMix[0].member_count, 2, '[3-mixed] 审计 member_count=2');
    const auMixMemberSet = new Set(JSON.parse(auMix[0].member_issue_ids));
    assert.deepStrictEqual([...auMixMemberSet].sort((a, b) => a - b), [iidMixPending, iidMixVoided].sort((a, b) => a - b),
      '[3-mixed] 审计 member_issue_ids 含两类全部成员（不因分支化处理而只收 pendingMemberIds）');
    const auMixExecutors = JSON.parse(auMix[0].executors_json);
    assert.strictEqual(auMixExecutors.length, execBeforeMix.length, '[3-mixed] executors_json 行数与删前快照一致（混合成员场景不影响执行人快照口径）');
    const auMixExecIdSet = new Set(auMixExecutors.map(e => e.id));
    const beforeMixExecIdSet = new Set(execBeforeMix.map(e => e.id));
    assert.deepStrictEqual([...auMixExecIdSet].sort((a, b) => a - b), [...beforeMixExecIdSet].sort((a, b) => a - b),
      '[3-mixed] executors_json 的 id 集合与删前快照逐一相等');
    ok('[3-mixed] codex 474 MED-2：混合成员（1 待上线+1 已作废）→ 删批次 200：两者 release_id 均清、状态各自保持（待上线/已作废）、两版时间线各一条各自文案正确、响应 member_count=2、审计 member_count=2+member_issue_ids 含两类+executors_json 与删前快照一致（防未来审计集合误改为仅 pendingMemberIds）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [4] 450-H3 执行人行物理删除无孤儿：2 在册 + 1 已软删的全量快照对拍
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '执行人快照批次' });
    await setExecutors(relId, [5, 6, 7]);
    // 移除 7 号：PUT /sys-releases/:id/executors 是**全量集合替换**语义（无单独的 DELETE 执行人端点）——
    // 新集合不含 7 号即触发其软删（removed_at/removed_by/removed_by_name 落库），5/6 仍在新集合中故原样
    // 保留在册（同 :16794 一带"集合替换"注释）。
    await setExecutors(relId, [5, 6]);
    const execBeforeDelete = await executorRows(relId);   // 3 行：5/6 在册，7 已软删（removed_at 非空）
    assert.strictEqual(execBeforeDelete.length, 3, '[4-pre] 删除批次前：执行人表恰 3 行（2 在册 + 1 已软删）');
    const softRemoved = execBeforeDelete.find(e => e.user_id === 7);
    assert.ok(softRemoved && softRemoved.removed_at, '[4-pre] 7 号确认已软删（removed_at 非空）');

    const r = await deleteRelease(relId, adminTok, { reason: '执行人快照批次删除' });
    assert.strictEqual(r.status, 200, `[4a] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);

    const execAfterDelete = await executorRows(relId);
    assert.strictEqual(execAfterDelete.length, 0, '[4b] 450-H3：删除批次后 sys_release_executors 恰 0 行（含原本 removed_at 非空的历史行——全量物理删，无孤儿）');
    ok('[4b] 450-H3 无孤儿断言：SELECT COUNT(*) FROM sys_release_executors WHERE release_id=<已删批次> 恰 0（在册行与历史软删行一并物理删除）');

    const au = await auditRows(relId);
    assert.strictEqual(au.length, 1, '[4c] 审计恰 1 条');
    const auExecutors = JSON.parse(au[0].executors_json);
    assert.strictEqual(auExecutors.length, 3, '[4c] 451-M1：executors_json 恰 3 行（含已软删的 7 号，不按 removed_at 过滤）');
    const auIdSet = new Set(auExecutors.map(e => e.id));
    const beforeIdSet = new Set(execBeforeDelete.map(e => e.id));
    assert.deepStrictEqual([...auIdSet].sort((a, b) => a - b), [...beforeIdSet].sort((a, b) => a - b),
      '[4c] 451-M1：executors_json 的 id 集合与删除前 `SELECT * WHERE release_id=?`（不带 removed_at 过滤）逐行相等');
    const auSoftRemoved = auExecutors.find(e => e.user_id === 7);
    assert.ok(auSoftRemoved && auSoftRemoved.removed_at, '[4c] 451-M1：executors_json 中 7 号的 removed_at 原值被如实保留（非被清空/覆盖）');
    ok('[4c] 451-M1 执行人快照全量对拍：executors_json 恰 3 行、id 集合与删除前整行查询（不带 removed_at 过滤）逐行相等，且软删行的 removed_at 原值如实保留（防执行人变更链断裂）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [5] sys_issue_release_commit_snapshots 兜底清理（真实验证 DELETE 执行，非天然空批次的巧合）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '快照兜底批次' });
    const iid = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [iid]);
    // 计划中批次正常路径下不会有快照行（发布后才会产生）——直连 SQL 构造一条"理论上不该出现但万一出现"的
    // 残留行，验证第⑦步的 DELETE 兜底真实执行，而不是永远命中 0 行的空转断言。
    await run(`INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at)
               VALUES (?, ?, '[]', datetime('now','localtime'))`, [relId, iid]);
    const before = await get(`SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [relId]);
    assert.strictEqual(before.c, 1, '[5-pre] 构造的残留快照行确实落库');

    const r = await deleteRelease(relId, adminTok, { reason: '快照兜底批次删除' });
    assert.strictEqual(r.status, 200, `[5a] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await get(`SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [relId]);
    assert.strictEqual(after.c, 0, '[5a] 步骤⑦：sys_issue_release_commit_snapshots 兜底 DELETE 真实清空了残留行');
    ok('[5a] sys_issue_release_commit_snapshots 兜底清理：即使出现"计划中批次不该有快照行"这种异常残留，DELETE 也真实执行并清空（非依赖"恒为空"的间接论证）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [6] GET 404（删除后）+ 幂等二次删 404 + 反向证明（其他批次不受影响）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relA = await mkRelease({ title: '反向对照批次A' });
    const iidA = await mkIssue('feature', '待上线');
    await addIssuesTo(relA, [iidA]);
    await setExecutors(relA, [5]);

    const relB = await mkRelease({ title: '待删批次B' });
    const iidB = await mkIssue('feature', '待上线');
    await addIssuesTo(relB, [iidB]);
    await setExecutors(relB, [6]);

    const r = await deleteRelease(relB, adminTok, { reason: '反向证明：删 B 不影响 A' });
    assert.strictEqual(r.status, 200, `[6a] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);

    const rGet = await getRelease(relB, adminTok);
    assert.strictEqual(rGet.status, 404, `[6b] 删除后 GET 应 404, got ${rGet.status}`);
    assert.strictEqual(rGet.body.code, 'RELEASE_NOT_FOUND', '[6b] code=RELEASE_NOT_FOUND');
    ok('[6b] 删除后 GET /sys-releases/:id → 404 RELEASE_NOT_FOUND（批次已物理不存在）');

    const rDelAgain = await deleteRelease(relB, adminTok, { reason: '幂等二次删除' });
    assert.strictEqual(rDelAgain.status, 404, `[6c] 幂等二次删除应 404, got ${rDelAgain.status} ${JSON.stringify(rDelAgain.body)}`);
    assert.strictEqual(rDelAgain.body.code, 'RELEASE_NOT_FOUND', '[6c] code=RELEASE_NOT_FOUND');
    ok('[6c] 幂等：对已删批次二次 DELETE → 404 RELEASE_NOT_FOUND（非 500/未定义行为，SELECT * 现值查询天然返回"不存在"）');

    const rowA = await releaseRow(relA);
    assert.ok(rowA, '[6d] 反向证明：批次 A 未受批次 B 删除影响，仍在');
    const issueAAfter = await issueRow(iidA);
    assert.strictEqual(issueAAfter.release_id, relA, '[6d] 反向证明：批次 A 的成员 release_id 未被清空');
    const execA = await executorRows(relA);
    assert.strictEqual(execA.length, 1, '[6d] 反向证明：批次 A 的执行人未被物理删除（恰 1 行，5 号）');
    assert.strictEqual(execA[0].user_id, 5, '[6d] 反向证明：批次 A 执行人仍是 5 号');
    ok('[6d] 反向证明：删除批次 B 的整套级联（成员退回/时间线/执行人物理删/审计）完全不影响批次 A 的成员、release_id、执行人在册行');

    // ⭐ [6e] 死锁端到端断言（O4 立命之本，S11 提示 4）：O4 存在的唯一理由是打破"DELETE /sys-issues/:id
    // 守卫②拒删已挂批次的单 + 上线单原无删除端点 ⇒ 建错的批次永久留存"这个真实死锁（方案 §2.4）。本用例
    // 直接端到端验证死锁真被打破：删批次后，对其中一张（原待上线）成员单发 DELETE /sys-issues/:id
    // 必须 200 且行消失——不是"看起来解开"，是"守卫②真的不再拦它"。
    const relDeadlock = await mkRelease({ title: '死锁验证批次' });
    const iidDeadlock = await mkIssue('feature', '待上线');
    await addIssuesTo(relDeadlock, [iidDeadlock]);
    const rDeadlockPre = await deleteIssue(iidDeadlock, adminTok, { reason: '删批次前先探一次，应仍被守卫②拦住' });
    assert.strictEqual(rDeadlockPre.status, 409, `[6e-pre] 批次删除前，该单仍挂 release_id，应被守卫②拒删 409, got ${rDeadlockPre.status} ${JSON.stringify(rDeadlockPre.body)}`);
    assert.strictEqual(rDeadlockPre.body.code, 'SYS_ISSUE_IN_RELEASE', '[6e-pre] code=SYS_ISSUE_IN_RELEASE（坐实"删批次前"这个前提真实存在，不是伪造的死锁）');
    const rDeadlockDel = await deleteRelease(relDeadlock, adminTok, { reason: '死锁验证：先删批次解锁' });
    assert.strictEqual(rDeadlockDel.status, 200, `[6e] 删批次应 200, got ${rDeadlockDel.status} ${JSON.stringify(rDeadlockDel.body)}`);
    const rDeadlockPost = await deleteIssue(iidDeadlock, adminTok, { reason: '批次已删，现在应能真正删除该单' });
    assert.strictEqual(rDeadlockPost.status, 200, `[6e] 批次已删后，DELETE /sys-issues/:id 应 200, got ${rDeadlockPost.status} ${JSON.stringify(rDeadlockPost.body)}`);
    const issueGoneAfterDeadlock = await issueRow(iidDeadlock);
    assert.strictEqual(issueGoneAfterDeadlock, undefined, '[6e] 该单已物理删除（行消失）');
    ok('[6e] 死锁端到端断言（O4 立命之本）：删批次前 DELETE /sys-issues/:id 真实 409 SYS_ISSUE_IN_RELEASE（前提坐实非伪造）→ 删批次 200 → 删批次后同一单 DELETE /sys-issues/:id 200 且行消失——证明 O4 打破的是真实死锁，不是自证的假题');

    // ⭐ [6f] 受困态解除端到端断言（S11 预筛拦截①·提示 4）：建批次 + 成员 void 后（release_id 仍挂，
    // status='已作废'，模拟 void 不清指针的既有行为）→ DELETE 批次应 200（③放宽生效，不再判脏）→
    // 已作废单 release_id 已清且 status 仍「已作废」（终态不因批次删除而位移，D10 分支处置正确）。
    const relTrapped = await mkRelease({ title: '受困态验证批次' });
    const iidTrapped = await mkIssue('feature', '待上线');
    await addIssuesTo(relTrapped, [iidTrapped]);
    await voidIssue(iidTrapped, adminTok, '受困态构造：作废但不清批次指针');
    const trappedBeforeDelete = await issueRow(iidTrapped);
    assert.strictEqual(trappedBeforeDelete.status, '已作废', '[6f-pre] void 后 status=已作废');
    assert.strictEqual(trappedBeforeDelete.release_id, relTrapped, '[6f-pre] void 不清 release_id（既有行为，受困态前提坐实）');
    const rTrapped = await deleteRelease(relTrapped, adminTok, { reason: '受困态解除：批次应可正常删除' });
    assert.strictEqual(rTrapped.status, 200, `[6f] ③放宽后应 200, got ${rTrapped.status} ${JSON.stringify(rTrapped.body)}`);
    const trappedAfterDelete = await issueRow(iidTrapped);
    assert.strictEqual(trappedAfterDelete.release_id, null, '[6f] 已作废单 release_id 已清空（历史批次指针解开）');
    assert.strictEqual(trappedAfterDelete.status, '已作废', '[6f] 已作废单 status 原样保留（终态不因批次删除而复活/位移）');
    const tlTrapped = await deleteTimelineRows(relTrapped);
    assert.strictEqual(tlTrapped.length, 1, '[6f] 已作废成员同样恰增一条 release_deleted 时间线（留痕完整，不因分支化处理而漏记）');
    assert.ok(tlTrapped[0].summary.includes('已作废'), `[6f] 已作废成员的时间线摘要应区别于"退回待上线"文案（不对终态单据错误宣称"退回」），实得 ${JSON.stringify(tlTrapped[0].summary)}`);
    ok('[6f] 受困态解除端到端断言：批次成员先被 void（release_id 仍挂，坐实"void 不清指针"前提）→ DELETE 批次 200（③放宽生效）→ 已作废单 release_id 清空且 status 仍已作废 + 专属时间线文案，证明放宽后的处置分支真实落地');

    // ⭐ [6g] 归属守卫交叉断言（codex 474 HIGH-1 收口验证）：建两个批次各带一张已作废成员，只删其中一个
    // 批次，验证另一批次的已作废单不被误清——直接证明"已作废分支 UPDATE 改单条集合谓词 `release_id=?`"
    // 后仍按批次精确限定，不会跨批次误伤（[9d] 变异进一步证明这条归属守卫是真实生效、非摆设）。
    const relCrossA = await mkRelease({ title: '归属守卫批次A' });
    const iidCrossA = await mkIssue('feature', '待上线');
    await addIssuesTo(relCrossA, [iidCrossA]);
    await voidIssue(iidCrossA, adminTok, '归属守卫批次A：作废');

    const relCrossB = await mkRelease({ title: '归属守卫批次B' });
    const iidCrossB = await mkIssue('feature', '待上线');
    await addIssuesTo(relCrossB, [iidCrossB]);
    await voidIssue(iidCrossB, adminTok, '归属守卫批次B：作废（不应被批次A的删除误清）');

    const rCrossDel = await deleteRelease(relCrossA, adminTok, { reason: '只删批次A' });
    assert.strictEqual(rCrossDel.status, 200, `[6g] 应 200, got ${rCrossDel.status} ${JSON.stringify(rCrossDel.body)}`);
    const crossAAfter = await issueRow(iidCrossA);
    assert.strictEqual(crossAAfter.release_id, null, '[6g] 批次A的已作废成员 release_id 已清空（本批次内，正常处理）');
    const crossBAfter = await issueRow(iidCrossB);
    assert.strictEqual(crossBAfter.release_id, relCrossB, '[6g] 批次B的已作废成员 release_id 完全未受批次A删除影响——归属守卫（release_id=?）精确限定，不会跨批次误清');
    assert.strictEqual(crossBAfter.status, '已作废', '[6g] 批次B的已作废成员 status 未受影响');
    const rowRelCrossB = await releaseRow(relCrossB);
    assert.ok(rowRelCrossB, '[6g] 批次B本身未受影响，仍在');
    ok('[6g] 归属守卫交叉断言：批次A/B 各带一张已作废成员，只删批次A → 批次B 的已作废成员 release_id/status 完全不受影响（跨批次隔离成立，codex 474 HIGH-1 关切的原始风险面在改造后不复现）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [7] 响应体形状
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '响应体批次' });
    const ids = [await mkIssue('feature', '待上线'), await mkIssue('feature', '待上线')];
    await addIssuesTo(relId, ids);
    const r = await deleteRelease(relId, adminTok, { reason: '响应体形状校验' });
    assert.strictEqual(r.status, 200, `[7a] 应 200, got ${r.status}`);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['id', 'member_count', 'ok'].sort(), `[7a] 响应体恰含 {ok,id,member_count} 三键，实得 ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.ok, true, '[7a] ok=true');
    assert.strictEqual(r.body.id, relId, '[7a] id=批次 ID');
    assert.strictEqual(r.body.member_count, 2, '[7a] member_count=实际成员数');
    ok('[7a] 成功响应体恰含 {ok:true, id, member_count} 三键');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [8] 审计四类字段逐一回读对拍（S11 预筛拦截②收口，防"存在性判断"误当"回读对拍"）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '审计回读批次', version_tag: 'v9.9', release_note: '审计回读用批次' });
    const iid = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [iid]);
    await setExecutors(relId, [5]);
    const beforeDeleteRow = await releaseRow(relId);   // 删除前整行快照，供 release_json 逐列对拍
    assert.ok(beforeDeleteRow, '[8-pre] 删除前批次行确实存在（对拍基线）');
    const submittedReason = '审计回读专用原因·含唯一标记 8f3c1a';

    const r = await deleteRelease(relId, adminTok, { reason: submittedReason });
    assert.strictEqual(r.status, 200, `[8a] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);

    const au = await auditRows(relId);
    assert.strictEqual(au.length, 1, '[8a] 审计恰 1 条');
    const row = au[0];

    assert.strictEqual(row.reason, submittedReason, `[8b] reason 与请求体提交原值逐字相等（非仅"非空"判断），实得 ${JSON.stringify(row.reason)}`);
    ok('[8b] 审计 reason === 请求体提交的原始值（含唯一标记，排除"恰好非空"的巧合）');

    const auditReleaseJson = JSON.parse(row.release_json);
    assert.deepStrictEqual(auditReleaseJson, beforeDeleteRow, '[8c] release_json 反序列化后与删除前 `SELECT * FROM sys_releases` 逐列相等（含 title/version_tag/release_note/release_no 等全部列，非仅存在性判断）');
    ok('[8c] 审计 release_json（反序列化后）与删除前整行 SELECT * 逐列相等');

    assert.strictEqual(row.operator_id, 1, `[8d] operator_id 与本次请求 JWT actor 的 id 一致（adminTok payload id=1），实得 ${row.operator_id}`);
    assert.strictEqual(row.operator_name, '管理员', `[8d] operator_name 与本次请求 JWT actor 的 display_name 一致，实得 ${JSON.stringify(row.operator_name)}`);
    ok('[8d] 审计 operator_id/operator_name 与本次请求 JWT actor 身份一致（非固定占位值）');

    assert.strictEqual(row.release_no, beforeDeleteRow.release_no, `[8e] release_no 与删除前快照值一致，实得 ${JSON.stringify(row.release_no)}`);
    ok('[8e] 审计 release_no === 删除前批次的 release_no 快照值');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [9] 三组变异自证（spec 硬约束：≥2 组，S11 提示补至 3 组：级联漏步→红／审计形态坏→CHECK 拒／
  //   ③放宽判据收窄回卷→受困态断言翻红）
  // ─────────────────────────────────────────────────────────────────────────
  {
    // ── 变异①（级联漏步）：摘掉步骤⑥"执行人行物理删除"的那条 DELETE 语句，用与 [4] 完全相同的场景
    //   （批次删除后执行人表应恰 0 行）验证真实代码的"无孤儿"断言在变异后翻红（孤儿行残留）。
    {
      const NEEDLE = "await dbRunAsync('DELETE FROM sys_release_executors WHERE release_id = ?', [id]);";
      const occurrences = REAL_SRC.split(NEEDLE).length - 1;
      assert.strictEqual(occurrences, 1, `[9a-pre] 执行人物理删除语句文本定位必须唯一命中，实得 ${occurrences} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated = REAL_SRC.replace(NEEDLE, "/* [9a 变异：级联漏步] 原执行人物理删除语句已被摘除 */");
      await withMutantModule(mutated, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: '级联漏步变异批次' });
        assert.strictEqual(rCreate.status, 201, `[9a] 变异实例建批次应 201, got ${rCreate.status}`);
        const relId = rCreate.body.id;
        const rSet = await mcall('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5] });
        assert.strictEqual(rSet.status, 200, `[9a] 变异实例设执行人应 200, got ${rSet.status}`);
        const rDel = await mcall('DELETE', `/api/sys-releases/${relId}`, adminTok, { reason: '级联漏步变异删除' });
        assert.strictEqual(rDel.status, 200, `[9a] 变异后删除本身仍应 200（缺步骤不阻断主流程）, got ${rDel.status} ${JSON.stringify(rDel.body)}`);
        const execAfter = await all(`SELECT * FROM sys_release_executors WHERE release_id=?`, [relId]);
        assert.strictEqual(execAfter.length, 1, `[9a] 变异后执行人表残留 1 行孤儿（真实代码应为 0 行）——证明 [4b] 的"恰 0 行无孤儿"断言真实依赖这条 DELETE 语句，不是巧合`);
      });
      ok('[9a] 变异自证①（级联漏步）：摘除步骤⑥"执行人行物理删除"语句后，与 [4b] 完全相同的场景从真实代码的"执行人表恰 0 行"翻转为"残留 1 行孤儿"——证明该无孤儿断言真实依赖这条级联步骤');
    }

    // ── 变异②（审计形态坏→CHECK 拒）：把审计 INSERT 里 executors_json 的取值从 `JSON.stringify(execRows)`
    //   改成字面量 `null`——action='delete' 时 DDL 组合 CHECK 要求 executors_json IS NOT NULL，插入应被
    //   SQLITE_CONSTRAINT 拒绝，导致整个事务失败（真实代码此处为正常 200 成功）。
    {
      const NEEDLE2 = 'JSON.stringify(execRows)';
      const occ2 = REAL_SRC.split(NEEDLE2).length - 1;
      assert.strictEqual(occ2, 1, `[9b-pre] executors_json 取值文本定位必须唯一命中，实得 ${occ2} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated2 = REAL_SRC.replace(NEEDLE2, 'null');
      await withMutantModule(mutated2, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: '审计形态破坏变异批次' });
        assert.strictEqual(rCreate.status, 201, `[9b] 变异实例建批次应 201, got ${rCreate.status}`);
        const relId = rCreate.body.id;
        const rDel = await mcall('DELETE', `/api/sys-releases/${relId}`, adminTok, { reason: '审计形态破坏变异删除' });
        assert.strictEqual(rDel.status, 500, `[9b] 变异后应 500（真实代码是 200 成功；executors_json 被强制写 NULL 撞组合 CHECK 的 delete 分支 executors_json IS NOT NULL 要求，INSERT 被 SQLITE_CONSTRAINT 拒绝，整个事务回滚）, got ${rDel.status} ${JSON.stringify(rDel.body)}`);
        const rowStillThere = await get(`SELECT * FROM sys_releases WHERE id=?`, [relId]);
        assert.ok(rowStillThere, '[9b] 事务整体回滚：批次主表未被删除（不是"审计漏写但业务照删"的半提交）');
      });
      ok('[9b] 变异自证②（审计形态坏→CHECK 拒）：把 executors_json 落库值强制改为 null 后，delete 分支撞 sys_release_audit 组合 CHECK 的 "executors_json IS NOT NULL" 要求，INSERT 被 SQLITE_CONSTRAINT 拒绝，整个事务连带业务删除一并回滚（500，非部分提交）——证明审计表的 DB 层组合 CHECK 是真实生效的最后一道防线，不是摆设');
    }

    // ── 变异③（S11 预筛拦截①收口回卷·③放宽判据收窄回原判据）：把步骤③的宽判据
    //   `m.status !== '待上线' && m.status !== '已作废'` 收窄回旧判据 `m.status !== '待上线'`，用与
    //   [6f] 完全相同的受困态场景（批次成员先 void，release_id 仍挂）验证真实代码的"200 放行"翻红为
    //   "409 RELEASE_MEMBER_STATE_DIRTY"——证明 [6f] 的放行行为真实依赖这条放宽判据，不是巧合。
    {
      const NEEDLE3 = "m.status !== '待上线' && m.status !== '已作废'";
      const occ3 = REAL_SRC.split(NEEDLE3).length - 1;
      assert.strictEqual(occ3, 1, `[9c-pre] ③放宽判据文本定位必须唯一命中，实得 ${occ3} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated3 = REAL_SRC.replace(NEEDLE3, "m.status !== '待上线'");
      // 前置对象图（批次+成员+void）走**主实例**既有 helper 构造——void 端点本身未被本组变异触碰，主/
      // 变异实例代码等价，两个实例共享同一份 :memory: db 连接（depsOverride 传入同一份 db/run/get/all），
      // 故主实例写入的行对变异实例的路由处理函数同样可见。只有最后一步"删批次"才需要真正走**变异实例**
      // 的路由（那正是本组要观察行为翻转的地方）——不必也不应该为了"全程走 mcall"而重新用真实 HTTP 端点
      // 拼一遍建单/加单/void 逻辑（那些端点的契约细节与本组要证明的东西无关，徒增脆弱性）。
      const relIdMut = await mkRelease({ title: '判据回卷变异批次' });
      const issueIdMut = await mkIssue('feature', '待上线');
      await addIssuesTo(relIdMut, [issueIdMut]);
      await voidIssue(issueIdMut, adminTok, '判据回卷变异：构造受困态（void 不清 release_id）');
      const trappedMutBefore = await issueRow(issueIdMut);
      assert.strictEqual(trappedMutBefore.status, '已作废', '[9c-pre] void 后 status=已作废');
      assert.strictEqual(trappedMutBefore.release_id, relIdMut, '[9c-pre] void 不清 release_id（受困态前提坐实）');
      await withMutantModule(mutated3, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rDel = await mcall('DELETE', `/api/sys-releases/${relIdMut}`, adminTok, { reason: '判据回卷变异：删除受困批次' });
        assert.strictEqual(rDel.status, 409, `[9c] 判据收窄回原版后，与 [6f] 完全相同的受困态场景应从真实代码的 200 翻转为 409（真实代码是 200 放行）, got ${rDel.status} ${JSON.stringify(rDel.body)}`);
        assert.strictEqual(rDel.body.code, 'RELEASE_MEMBER_STATE_DIRTY', `[9c] code 应 RELEASE_MEMBER_STATE_DIRTY, got ${rDel.body.code}`);
        const stillTrapped = await get(`SELECT * FROM sys_issues WHERE id=?`, [issueIdMut]);
        assert.strictEqual(stillTrapped.release_id, relIdMut, '[9c] 变异后拒绝路径：release_id 仍未清空（受困态未被解开，坐实"判据收窄=受困态复现"）');
      });
      ok('[9c] 变异自证③（S11 预筛拦截①收口回卷）：把③放宽判据收窄回旧判据后，与 [6f] 完全相同的"批次成员先 void 再删批次"受困态场景从真实代码的 200 放行翻转为 409 RELEASE_MEMBER_STATE_DIRTY——证明 [6f] 的放行行为真实依赖这条放宽判据，不是巧合，也证明了收窄前受困态确实存在');
    }

    // ── 变异④（codex 474 HIGH-1 归属守卫生效性证明）：把已作废分支 UPDATE 的 WHERE 从
    //   `release_id = ? AND status = '已作废'` 剥成 `status = '已作废'`（去掉归属守卫，params 同步清空
    //   为 []）。⚠️ 单独剥这一处还不够——本文件全程共用同一份 `:memory:` db，跑到本组时前面各组已
    //   累积了多张「已作废」单，WHERE 一旦不带 release_id 就会命中全表所有已作废行，changes 计数三件套
    //   （`updVoided.changes !== voidedMemberIds.length`）会先一步识破这一异常并整体回滚——这是**另一条
    //   独立防线**（sibling 安全网）生效，不是归属守卫本身在起作用，会掩盖归属守卫单独的贡献。要干净地
    //   只观测"剥掉归属守卫"这一件事的后果，须同时把这条计数校验短路掉（改判定恒 false，即"永不判定
    //   不一致"），逼出真正被归属守卫单独挡住的那类问题：批次 A 的删除会**静默**把批次 B 的已作废成员
    //   一并清指针——同 codex 474 HIGH-1 指出的"缺 release_id 归属守卫"风险等价复现。
    {
      const START4 = 'const updVoided = await dbRunAsync(';
      const occStart4 = REAL_SRC.split(START4).length - 1;
      assert.strictEqual(occStart4, 1, `[9d-pre] 已作废分支 UPDATE 起点锚点必须唯一命中，实得 ${occStart4} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const startIdx4 = REAL_SRC.indexOf(START4);
      const END4 = ');';
      const endIdx4 = REAL_SRC.indexOf(END4, startIdx4);
      assert.ok(endIdx4 !== -1, '[9d-pre] 已作废分支 UPDATE 终点锚点未找到——源码结构已变，需要人工核实并更新本变异脚本');
      const originalSpan4 = REAL_SRC.slice(startIdx4, endIdx4 + END4.length);
      const WHERE_NEEDLE4 = "WHERE release_id = ? AND status = '已作废'";
      assert.ok(originalSpan4.includes(WHERE_NEEDLE4), '[9d-pre] 切片内未找到预期 WHERE 子句——源码结构已变，需要人工核实并更新本变异脚本');
      assert.ok(originalSpan4.includes('[id]'), '[9d-pre] 切片内未找到预期 params 数组 [id]——源码结构已变，需要人工核实并更新本变异脚本');
      const mutatedSpan4 = originalSpan4
        .replace(WHERE_NEEDLE4, "WHERE status = '已作废'")
        .replace('[id]', '[]');
      const CHANGES_GUARD_NEEDLE4 = 'updVoided.changes !== voidedMemberIds.length';
      const occGuard4 = REAL_SRC.split(CHANGES_GUARD_NEEDLE4).length - 1;
      assert.strictEqual(occGuard4, 1, `[9d-pre] 已作废分支 changes 校验文本定位必须唯一命中，实得 ${occGuard4} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated4 = REAL_SRC.replace(originalSpan4, mutatedSpan4).replace(CHANGES_GUARD_NEEDLE4, 'false');
      // 前置对象图（两批次+两已作废成员）走**主实例**既有 helper 构造——add-issues/void 端点均未被本组
      // 变异触碰，主/变异实例代码等价，两实例共享同一份 :memory: db 连接（depsOverride 传入同一份
      // db/run/get/all），主实例写入的行对变异实例的路由处理函数同样可见。只有最后"删批次A"这一步才
      // 需要真正走**变异实例**的路由（同 [9c] 既有手法）。
      const relIdMutA = await mkRelease({ title: '归属守卫变异批次A' });
      const iidMutA = await mkIssue('feature', '待上线');
      await addIssuesTo(relIdMutA, [iidMutA]);
      await voidIssue(iidMutA, adminTok, '变异：作废A');
      const relIdMutB = await mkRelease({ title: '归属守卫变异批次B' });
      const iidMutB = await mkIssue('feature', '待上线');
      await addIssuesTo(relIdMutB, [iidMutB]);
      await voidIssue(iidMutB, adminTok, '变异：作废B（不应被批次A的删除误清）');
      await withMutantModule(mutated4, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rDelA = await mcall('DELETE', `/api/sys-releases/${relIdMutA}`, adminTok, { reason: '变异：只删批次A' });
        assert.strictEqual(rDelA.status, 200, `[9d] 变异后删批次A仍应 200（归属守卫+计数校验双双剥除，UPDATE 静默"成功"）, got ${rDelA.status} ${JSON.stringify(rDelA.body)}`);
        const rowBAfterMut = await get(`SELECT release_id, status FROM sys_issues WHERE id=?`, [iidMutB]);
        assert.strictEqual(rowBAfterMut.release_id, null, `[9d] 变异后批次B的已作废成员 release_id 被跨批次静默误清为 NULL（真实代码应保持 =批次B id 不变，见 [6g]）——证明 release_id 归属守卫单独承担着"防止跨批次误清"这份职责，不是靠 changes 计数三件套顺带兜底的`);
        assert.strictEqual(rowBAfterMut.status, '已作废', '[9d] status 仍为已作废（本变异只剥指针清空的归属范围，不影响 status 条件本身）');
      });
      ok('[9d] 变异自证④（codex 474 HIGH-1 归属守卫生效性，同步短路 changes 计数三件套以单独隔离归属守卫的贡献）：已作废分支 UPDATE 剥除 release_id 归属守卫后，与 [6g] 完全相同的"两批次各带一张已作废成员，只删批次A"场景，批次B的已作废成员 release_id 从真实代码的"保持不变"翻转为"被跨批次静默误清为 NULL"——证明归属守卫是真实生效、独立于 changes 计数校验之外的防线，直接复现了 codex 474 指出的原始风险面');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [10]（codex 474 复审 MED-1）commit 后路径隔离——行为级用例：depsOverride 注入一个 info 方法会抛错的
  //   logger，建独立实例走完整删除，断言"日志异常绝不改变已提交删除的结果"：200 + successBody 三键完整
  //   （与正常路径逐字段一致，坐实 LOW-1 的"同一对象"契约）+ 批次行确实已删 + 审计行确实已落——不是靠
  //   理论推演，是真的让 logger.info 抛错跑一遍收尾日志的独立 try/catch，观察它真的被吞掉、真的不冒泡到
  //   txErr/committed 分支。
  // ─────────────────────────────────────────────────────────────────────────
  {
    // ⚠️ logger.info 不止本端点收尾一处调用（schema 迁移期 runSysMigration 等启动路径也会打 info 日志）
    //   ——不能无差别对全部 info 调用抛错，否则连 initSchema() 本身都会崩，测的就不是"本端点收尾日志异常"
    //   而是"进程根本起不来"。改为只对命中本端点收尾日志文案特征（"删除上线批次"）的那一次调用抛错，
    //   其余 info 调用照常放行——精确复现"收尾这一句日志异常"这个场景，不牵连其它路径。
    const throwingLogger = {
      info: (msg, ...args) => {
        if (typeof msg === 'string' && msg.includes('删除上线批次')) {
          throw new Error('[10 用例专用] 模拟 logger.info 实现自身故障（委托方日志系统抛错，非本端点业务逻辑问题）');
        }
      },
      warn: noop, error: noop, debug: noop,
    };
    const modThrowLogger = require('../routes/sys-iteration')({
      logger: throwingLogger,
      db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
      authenticateToken, requireAdmin,
      ...testDeps(),
    });
    modThrowLogger.initSchema();
    await waitReadyOn(modThrowLogger._internals);
    let throwServer = null;
    await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', modThrowLogger.router); throwServer = app.listen(0, '127.0.0.1', res); });
    const throwCall = makeCaller(() => throwServer.address().port);
    try {
      // 前置对象图走**主实例**既有 helper 构造（同 [9c]/[9d] 既有手法）——建单/加单端点未被替换 logger，
      // 主/抛错实例代码等价，两实例共享同一份 :memory: db 连接，主实例写入的行对抛错实例的路由处理函数
      // 同样可见。只有最后"删批次"这一步走**抛错实例**的路由，真正触发 logger.info 抛错。
      const relIdThrow = await mkRelease({ title: 'logger 抛错场景批次' });
      const iidThrow = await mkIssue('feature', '待上线');
      await addIssuesTo(relIdThrow, [iidThrow]);
      const rThrow = await throwCall('DELETE', `/api/sys-releases/${relIdThrow}`, adminTok, { reason: 'logger.info 抛错场景验证' });
      assert.strictEqual(rThrow.status, 200, `[10] logger.info 抛错不应改变 HTTP 结果，仍应 200, got ${rThrow.status} ${JSON.stringify(rThrow.body)}`);
      assert.deepStrictEqual(Object.keys(rThrow.body).sort(), ['id', 'member_count', 'ok'].sort(), `[10] 响应体三键完整（与正常路径逐字段一致，非降级成少字段的形状），实得 ${JSON.stringify(rThrow.body)}`);
      assert.strictEqual(rThrow.body.ok, true, '[10] ok=true');
      assert.strictEqual(rThrow.body.id, relIdThrow, '[10] id=批次 ID');
      assert.strictEqual(rThrow.body.member_count, 1, '[10] member_count=实际成员数（logger 抛错不影响这个字段的计算/回填）');
      const rowGoneThrow = await releaseRow(relIdThrow);
      assert.strictEqual(rowGoneThrow, undefined, '[10] 批次行确实已物理删除（logger 抛错发生在 commit 之后，不触发误回滚）');
      const auThrow = await auditRows(relIdThrow);
      assert.strictEqual(auThrow.length, 1, '[10] 审计行确实已落库恰 1 条（同上，未被误回滚）');
      const issueThrowAfter = await issueRow(iidThrow);
      assert.strictEqual(issueThrowAfter.release_id, null, '[10] 成员 release_id 确实已清空（完整级联真实提交，非"业务假装成功但其实回滚了"）');
      ok('[10] codex 474 复审 MED-1：logger.info 抛错场景——200 + successBody 三键完整（{ok,id,member_count}，与正常路径同一对象契约）+ 批次行已删 + 审计行已落 + 成员 release_id 已清，证明日志异常绝不改变已提交删除的结果、不触发误回滚（committed 后路径隔离的行为级证据，非仅理论推演）');
    } finally {
      try { throwServer.close(); } catch (_) { /* ignore */ }
    }
  }

  console.log(`\n✅ verify-sys-release-delete 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
