// 验证脚本：上线单管理体验优化 R-C4 —— PATCH /sys-releases/:id 上线单基本信息编辑（方案 20260824_v1.3 §3 O3）
//   用法：node scripts/verify-sys-release-edit.js
//
// 覆盖范围（方案 §6 O3 断言逐条 + spec 硬约束）：
//   非 admin 403 / 不存在 404 / 已发布 409 / 通知已启动 409 RELEASE_NOTIFY_STARTED /
//   D8 例外正向+三条边界 / 字段存在性三形态 / 全同值 changed:false 零留痕 /
//   留痕 cardinality（N=0/1/3，两载体同源互证）/ 事件契约 / 三字段超长 400 /
//   CAS 并发 409 / 反向一对（有值→null / null→有值）/ 副作用不变量（执行人集合冻结）/
//   审计字段对拍（451-H1）/ 归一化对称（451-M3）/ 短路顺序（451-M3）/
//   长度校验先于 D8 例外 / 三道门优先级（452-M1）/ 两组变异自证（门序调换/CAS 比对制破坏）。
//
// 真实 HTTP 层验证（对齐 verify-sys-release-batch.js 范式：真实 express app + http.Server + JWT 多角色
//   夹具 + `:memory:` 工厂注入档）；issue/release 前置态优先走真实端点（POST /sys-releases、add-issues），
//   仅"批次已发布"这类无关本端点核心机制的前置态用直连 SQL 捷径构造（发布链路本身有独立套件覆盖）。
//
// [8]/[10-②] CAS 并发竞态的构造手法：本端点不接受客户端传入"我以为的旧值"，事务内 beforeRow 恒是**当次
//   读取**的现值，而 sysBeginImmediate() 的全局互斥事务序列化了全部 sys 写路径——这意味着真实两条 HTTP
//   请求之间不存在"A 读到旧值、B 抢先写、A 才写"的窗口（B 必须等 A 完全提交/回滚才能拿到互斥锁）。要证明
//   三字段 CAS 谓词不是摆设，需要精确构造"事务内读→写之间被外部写"这唯一真实存在的窗口——本文件用一个
//   包一层的 dbGetAsync 拦截器：命中本端点的 beforeRow 查询语句时，在返回结果给调用方**之前**，用同一
//   连接对该行做一次旁路 UPDATE（模拟真实存在的并发写者），再把"读时仍是旧值"的快照原样交回调用方。
//   调用方（PATCH 端点）据此计算的差量与随后执行的 CAS UPDATE 会因为行已被真实改写而 0 行命中——这正是
//   CAS 设计要防的场景，不依赖"两条 HTTP 请求恰好错开"这种不可控时序。
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

const SECRET = 'verify-sys-release-edit-secret';
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

// ── 多角色 JWT 夹具（对齐 verify-sys-release-batch.js：测试 id 与生产 users.id 无对应关系）──────────
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
const patchRelease = (id, tok, body) => call('PATCH', `/api/sys-releases/${id}`, tok, body);
// [12d-f 专用] call() 把 JS `null` 特殊处理成"不发送请求体"（GET 等无体请求的既有约定），无法用它发送
// 字面 JSON 文本 "null"——这里另起一个发**原始字节**的 helper，rawText 就是要写进请求体的确切文本
// （不经 JSON.stringify 二次包装），用于测 body-parser 对顶层标量 JSON 的真实拒绝行为。
function callRawBody(method, p, tok, rawText) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(rawText),
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(rawText); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 直连 SQL / HTTP 混合夹具（对齐 verify-sys-release-batch.js 范式）──────────
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
  // 通知已启动：整批置 sent（聚合态 deriveExecutorNotifySummary 对全 sent 返回 'sent'，∉ ('none','not_sent')）。
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
}
async function setReleaseStatus(id, status) {
  // 直连 SQL 构造"已发布"前置态——发布链路本身（快照/成员翻牌）已有独立套件覆盖，本文件只需要一个
  // status≠'计划中' 的批次来证明 PATCH 端点的 status 门，不需要走完整真实发布流程。
  await run(`UPDATE sys_releases SET status=? WHERE id=?`, [status, id]);
}
const releaseRow = (id) => get(`SELECT * FROM sys_releases WHERE id=?`, [id]);
const editTimelineRows = (relId) => all(
  `SELECT * FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_info_edit' ORDER BY id`, [relId]
);
const auditRows = (relId) => all(`SELECT * FROM sys_release_audit WHERE release_id=? ORDER BY id`, [relId]);
const timelineCountAll = () => get(`SELECT COUNT(*) AS c FROM sys_issue_timeline`).then(r => r.c);
const auditCountAll = () => get(`SELECT COUNT(*) AS c FROM sys_release_audit`).then(r => r.c);

// ── [8]/[10-②] 通用：构造"事务内读→写之间被外部并发写命中"的 dbGetAsync 拦截器 ──────────
//   仅对本端点唯一的 `SELECT * FROM sys_releases WHERE id = ?` 语句、且命中目标 release id 时触发一次；
//   其余任何查询原样透传，不影响该 db 实例上的其它端点/内部逻辑。
function makeRaceInterceptingGet(baseGet, baseRun, targetId, injectSql, injectParams) {
  let fired = false;
  return async (sql, params = []) => {
    if (!fired && sql === 'SELECT * FROM sys_releases WHERE id = ?' && Number(params[0]) === Number(targetId)) {
      fired = true;
      const row = await baseGet(sql, params);   // 读到"旧值快照"
      await baseRun(injectSql, injectParams);   // 返回调用方之前，同连接旁路写入（模拟真实并发写者抢先落库）
      return row;
    }
    return baseGet(sql, params);
  };
}

// ── [10] 变异自证公共设施：现场读取真实 index.js 源码 → 定点文本替换 → 写临时兄弟文件（同目录，保证
//   相对 require 不失效）→ 独立实例加载（可选独立 :memory: db，也可复用外部传入的 db+run+get+all）
//   → 用回调跑场景断言 → finally 清理临时文件与 server/db。
const REAL_INDEX_PATH = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
const REAL_SRC = fs.readFileSync(REAL_INDEX_PATH, 'utf8');

// buildMutantInstance：给定同一份 mutantFactory（已从临时兄弟文件 require 得到的工厂函数）+ 一组 deps，
//   起一个全新 { app, server, call } 三件套——供 withMutantModule 场景回调按需用**不同 deps**（如换一个
//   拦截式 dbGetAsync）重复调用，构造出同一处代码突变下的第二个独立实例，而不必重新写文件/重新 require。
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
    // [12d-f 前置] 逐字对齐 server.js:20960-20963 生产全局错误处理器的 JSON 解析错误分支——body-parser
    // strict 模式（默认）拒绝顶层非对象/数组的 JSON（如裸 null/字符串/数字）时抛 SyntaxError，这层
    // 中间件把它统一转成生产真实响应形状 {error:'无效的JSON格式'}（无 code），而不是裸 Express 默认
    // HTML 错误页——没有它，[12d-f] 测的就不是生产行为，是测试哈内斯自身的默认错误页噪声。
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
  // [1] 权限 / 存在性 / 状态门基础负例
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '批次A' });
    const rNonAdmin = await patchRelease(relId, userTok, { title: '改标题' });
    assert.strictEqual(rNonAdmin.status, 403, `[1a] 非 admin 应 403, got ${rNonAdmin.status} ${JSON.stringify(rNonAdmin.body)}`);
    ok('[1a] 非 admin 编辑 403（route-level requireAdmin 生效——若守卫被误删/降级此断言会转 200/CAS 相关码而非 403）');

    const rNotFound = await patchRelease(999999, adminTok, { title: '改标题' });
    assert.strictEqual(rNotFound.status, 404, `[1b] 不存在应 404, got ${rNotFound.status}`);
    assert.strictEqual(rNotFound.body.code, 'RELEASE_NOT_FOUND', `[1b] code 应 RELEASE_NOT_FOUND, got ${rNotFound.body.code}`);
    ok('[1b] 批次不存在 404 RELEASE_NOT_FOUND（若 SELECT * 现值查询被误删会在后续步骤 500 而非此处 404）');
    // [S9 预筛提示 6] 非法 ID 形态 400（parsePositiveId 前置闸·事务外）
    const rBadId = await call('PATCH', '/api/sys-releases/not-a-number', adminTok, { title: 'x' });
    assert.strictEqual(rBadId.status, 400, `[1c] 非法 ID 应 400, got ${rBadId.status}`);
    assert.strictEqual(rBadId.body.code, 'INVALID_RELEASE_ID', `[1c] code, got ${rBadId.body.code}`);
    ok('[1c] 非法批次 ID 400 INVALID_RELEASE_ID（parsePositiveId 前置闸·不进事务）');

    await setReleaseStatus(relId, '已发布');
    const rPublished = await patchRelease(relId, adminTok, { title: '改标题' });
    assert.strictEqual(rPublished.status, 409, `[1c] 已发布应 409, got ${rPublished.status} ${JSON.stringify(rPublished.body)}`);
    assert.strictEqual(rPublished.body.code, 'RELEASE_NOT_PLANNING', `[1c] code 应 RELEASE_NOT_PLANNING, got ${rPublished.body.code}`);
    const afterPub = await releaseRow(relId);
    assert.strictEqual(afterPub.title, '批次A', '[1c] 已发布批次被拒绝的 PATCH 不改任何列（title 原样保留）');
    ok('[1c] 已发布批次编辑 409 RELEASE_NOT_PLANNING 且零写入（status 门先于一切其它判断生效）');
    await setReleaseStatus(relId, '计划中');   // 复原，避免影响后续（本批次此后不再使用）
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [2] 字段存在性三形态（450-H2）：未出现保持原值 / null 显式清空 / '' 清空
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '原标题', version_tag: 'v1.0', release_note: '原说明' });
    const r1 = await patchRelease(relId, adminTok, { title: '新标题' });
    assert.strictEqual(r1.status, 200, `[2a] 单字段编辑应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.changed, true, '[2a] changed=true');
    const row1 = await releaseRow(relId);
    assert.strictEqual(row1.title, '新标题', '[2a] title 已更新');
    assert.strictEqual(row1.version_tag, 'v1.0', '[2a] version_tag 未出现在请求体——必须保持原值，绝不被清空');
    assert.strictEqual(row1.release_note, '原说明', '[2a] release_note 未出现在请求体——必须保持原值，绝不被清空');
    ok('[2a] 字段存在性形态①「未出现」：未提交的字段不进变更集，落库原样保留（防三形态混判把"未出现"误当"清空"）');

    const r2 = await patchRelease(relId, adminTok, { version_tag: null });
    assert.strictEqual(r2.status, 200, `[2b] null 清空应 200, got ${r2.status}`);
    const row2 = await releaseRow(relId);
    assert.strictEqual(row2.version_tag, null, '[2b] version_tag 显式传 null 后落库为 NULL');
    ok('[2b] 字段存在性形态②「出现且为 null」：显式清空，落库 NULL');

    const r3 = await patchRelease(relId, adminTok, { release_note: '' });
    assert.strictEqual(r3.status, 200, `[2c] 空串清空应 200, got ${r3.status}`);
    const row3 = await releaseRow(relId);
    assert.strictEqual(row3.release_note, null, "[2c] release_note 显式传 '' 归一后落库为 NULL（空串=清空意图）");
    ok("[2c] 字段存在性形态③「出现且为 ''」：清空，落库 NULL（与形态②同一归一结果，但走的是不同输入路径）");

    const r4 = await patchRelease(relId, adminTok, { title: 12345 });
    assert.strictEqual(r4.status, 400, `[2d] 非字符串应 400, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.code, 'RELEASE_PATCH_INVALID_TYPE', `[2d] code 应 RELEASE_PATCH_INVALID_TYPE, got ${r4.body.code}`);
    ok('[2d] 出现且非字符串（数字）→ 400 RELEASE_PATCH_INVALID_TYPE（若类型校验被误删，此请求会落库一个数字型 title）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [3] 全同值 changed:false 零留痕；三道门②空变更集短路
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '同值批次', version_tag: 'v2.0', release_note: '说明X' });
    const before = await timelineCountAll();
    const beforeAudit = await auditCountAll();
    const r = await patchRelease(relId, adminTok, { title: '同值批次', version_tag: 'v2.0', release_note: '说明X' });
    assert.strictEqual(r.status, 200, `[3] 全同值应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, false, '[3] changed=false（全同值不算变更）');
    assert.strictEqual(await timelineCountAll(), before, '[3] 全同值：sys_issue_timeline 全仓零新增');
    assert.strictEqual(await auditCountAll(), beforeAudit, '[3] 全同值：sys_release_audit 全仓零新增');
    ok('[3] 三字段与现值完全相同 → changed:false，时间线与审计表均零新增（若空变更集短路失效，此处会误写审计/时间线）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [4] 留痕 cardinality（N=0/1/3）+ 两载体同源互证（451-H1）+ 事件契约
  // ─────────────────────────────────────────────────────────────────────────
  {
    const rel0 = await mkRelease({ title: '空批次' });
    const r0 = await patchRelease(rel0, adminTok, { title: '空批次改名' });
    assert.strictEqual(r0.status, 200, `[4-N0] 应 200, got ${r0.status} ${JSON.stringify(r0.body)}`);
    assert.strictEqual(r0.body.changed, true, '[4-N0] changed=true');
    const tl0 = await editTimelineRows(rel0);
    assert.strictEqual(tl0.length, 0, '[4-N0] 空批次：时间线 0 条（合法，非 bug）');
    const au0 = await auditRows(rel0);
    assert.strictEqual(au0.length, 1, '[4-N0] 空批次：审计表恰 1 条（D9 兜底——空批次的编辑仍必须留痕）');
    assert.strictEqual(au0[0].member_count, 0, '[4-N0] member_count=0');
    assert.deepStrictEqual(JSON.parse(au0[0].member_issue_ids), [], "[4-N0] member_issue_ids='[]'");
    ok('[4-N0] N=0（空批次）：时间线 0 条 + 审计恰 1 条（审计兜底空批次留痕，D9 成立）');

    const rel1 = await mkRelease({ title: '单成员批次' });
    const iid1 = await mkIssue('feature', '待上线');
    await addIssuesTo(rel1, [iid1]);
    const r1 = await patchRelease(rel1, adminTok, { title: '单成员批次改名' });
    assert.strictEqual(r1.status, 200, `[4-N1] 应 200, got ${r1.status}`);
    const tl1 = await editTimelineRows(rel1);
    assert.strictEqual(tl1.length, 1, '[4-N1] N=1：时间线恰 1 条');
    assert.strictEqual(tl1[0].issue_id, iid1, '[4-N1] 该条挂在唯一成员单上');
    assert.strictEqual(tl1[0].event_type, 'note', "[4-N1] event_type='note'（在 CHECK 15 值域内）");
    assert.strictEqual(tl1[0].action_code, 'release_info_edit', "[4-N1] action_code='release_info_edit'");
    assert.ok(tl1[0].payload_json && JSON.parse(tl1[0].payload_json).changes, '[4-N1] payload_json 含结构化 changes 数组');
    const au1 = await auditRows(rel1);
    assert.strictEqual(au1.length, 1, '[4-N1] 审计恰 1 条');
    assert.strictEqual(au1[0].member_count, 1, '[4-N1] member_count=1');
    ok('[4-N1] N=1：时间线恰 1 条挂在唯一成员单上 + 审计恰 1 条；事件契约 event_type=note/action_code=release_info_edit 均成立');

    const rel3 = await mkRelease({ title: '三成员批次' });
    const ids3 = [];
    for (let k = 0; k < 3; k++) ids3.push(await mkIssue('feature', '待上线'));
    await addIssuesTo(rel3, ids3);
    const r3 = await patchRelease(rel3, adminTok, { title: '三成员批次改名' });
    assert.strictEqual(r3.status, 200, `[4-N3] 应 200, got ${r3.status}`);
    const tl3 = await editTimelineRows(rel3);
    assert.strictEqual(tl3.length, 3, '[4-N3] N=3：时间线恰 3 条');
    const perMemberCount = {};
    for (const row of tl3) perMemberCount[row.issue_id] = (perMemberCount[row.issue_id] || 0) + 1;
    for (const iid of ids3) assert.strictEqual(perMemberCount[iid], 1, `[4-N3] 成员单 #${iid} 应恰 1 条（防总数对但集中写给同一张单）`);
    const au3 = await auditRows(rel3);
    assert.strictEqual(au3.length, 1, '[4-N3] 审计恰 1 条（不随成员数线性增长）');
    assert.strictEqual(au3[0].member_count, 3, '[4-N3] member_count=3');
    const auditMemberSet = new Set(JSON.parse(au3[0].member_issue_ids));
    const timelineMemberSet = new Set(tl3.map(r => r.issue_id));
    assert.deepStrictEqual([...auditMemberSet].sort((a, b) => a - b), [...timelineMemberSet].sort((a, b) => a - b),
      '[4-N3] 451-H1：审计 member_issue_ids 集合 === 本次实际写入时间线的 issue_id 集合（同源互证，防"只插必填列⇒非空批次被记成空批次"这类结构合法但数据说谎的行）');
    ok('[4-N3] N=3：时间线恰 3 条且每张成员各恰 1 条 + 审计恰 1 条 + member_issue_ids/member_count 与实际写入时间线的成员集合逐一对拍相等（451-H1）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [5] 三字段超长各 400
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '长度校验批次' });
    const rTitle = await patchRelease(relId, adminTok, { title: 'x'.repeat(I.SYS_RELEASE_TITLE_MAX + 1) });
    assert.strictEqual(rTitle.status, 400, `[5a] title 超长应 400, got ${rTitle.status}`);
    assert.strictEqual(rTitle.body.code, 'RELEASE_TITLE_TOO_LONG', `[5a] code, got ${rTitle.body.code}`);
    ok(`[5a] title 超长（>${I.SYS_RELEASE_TITLE_MAX}）→ 400 RELEASE_TITLE_TOO_LONG`);

    const rVt = await patchRelease(relId, adminTok, { version_tag: 'x'.repeat(I.SYS_VERSION_TAG_MAX + 1) });
    assert.strictEqual(rVt.status, 400, `[5b] version_tag 超长应 400, got ${rVt.status}`);
    assert.strictEqual(rVt.body.code, 'VERSION_TAG_TOO_LONG', `[5b] code, got ${rVt.body.code}`);
    ok(`[5b] version_tag 超长（>${I.SYS_VERSION_TAG_MAX}）→ 400 VERSION_TAG_TOO_LONG`);

    const rNote = await patchRelease(relId, adminTok, { release_note: 'x'.repeat(I.SYS_RELEASE_NOTE_MAX + 1) });
    assert.strictEqual(rNote.status, 400, `[5c] release_note 超长应 400, got ${rNote.status}`);
    assert.strictEqual(rNote.body.code, 'RELEASE_NOTE_TOO_LONG', `[5c] code, got ${rNote.body.code}`);
    ok(`[5c] release_note 超长（>${I.SYS_RELEASE_NOTE_MAX}）→ 400 RELEASE_NOTE_TOO_LONG`);

    const untouchedRow = await releaseRow(relId);
    assert.strictEqual(untouchedRow.title, '长度校验批次', '[5d] 三次超长拒绝均零写入');
    ok('[5d] 三次超长拒绝请求均未落库任何改动（长度校验先于事务/CAS，零写入）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [6] D8：通知已启动 409 + 例外正向 + 三条边界；长度校验先于 D8 例外
  // ─────────────────────────────────────────────────────────────────────────
  {
    const rel = await mkRelease({ title: '有标题批次', version_tag: 'v1', release_note: '说明' });
    await setExecutors(rel, [5, 6]);
    await markSent(rel);
    const rBlocked = await patchRelease(rel, adminTok, { version_tag: 'v2' });
    assert.strictEqual(rBlocked.status, 409, `[6a] 通知已启动应 409, got ${rBlocked.status} ${JSON.stringify(rBlocked.body)}`);
    assert.strictEqual(rBlocked.body.code, 'RELEASE_NOTIFY_STARTED', `[6a] code, got ${rBlocked.body.code}`);
    ok('[6a] 通知已启动（聚合态=sent）+ 非 title 字段变更 → 409 RELEASE_NOTIFY_STARTED（对接人先撤销上线安排）');

    // [6g·S9 预筛拦截 P1] D8 例外判据的另半个合取式（oldTitleBlank）专项——通知已启动 ∧ title 现值
    //   **非空** ∧ 仅 title 实际变更 → 必须 409 且零写入。此前 49 组无一覆盖该组合：把 && oldTitleBlank
    //   摘掉（=通知后任何人仍能随意改标题，正是 D8 要堵的事）全套照绿。本组即其唯一红灯来源。
    const rRetitle = await patchRelease(rel, adminTok, { title: '改后标题' });
    assert.strictEqual(rRetitle.status, 409, `[6g] 非空 title 被改应 409, got ${rRetitle.status} ${JSON.stringify(rRetitle.body)}`);
    assert.strictEqual(rRetitle.body.code, 'RELEASE_NOTIFY_STARTED', `[6g] code, got ${rRetitle.body.code}`);
    const rowRetitle = await releaseRow(rel);
    assert.strictEqual(rowRetitle.title, '有标题批次', '[6g] 拒绝请求零写入——title 仍为原值');
    ok('[6g] D8 例外半合取式专项：通知已启动 + title 现值非空 + 仅 title 变更 → 409 零写入（"补空"例外不为"篡改"开门）');

    const relBlank = await mkRelease({});   // title 缺省 = NULL
    await setExecutors(relBlank, [5]);
    await markSent(relBlank);
    const rFill = await patchRelease(relBlank, adminTok, { title: '忘记写的标题' });
    assert.strictEqual(rFill.status, 200, `[6b] D8 例外正向应 200, got ${rFill.status} ${JSON.stringify(rFill.body)}`);
    assert.strictEqual(rFill.body.changed, true, '[6b] changed=true');
    const rowFill = await releaseRow(relBlank);
    assert.strictEqual(rowFill.title, '忘记写的标题', '[6b] title 已补写落库');
    ok('[6b] D8 例外正向：title 现值为空 + 通知已启动 → 补写放行（"忘记写标题"是填空不是篡改）');

    const relB1 = await mkRelease({ version_tag: 'v1' });   // title 缺省=NULL
    await setExecutors(relB1, [5]);
    await markSent(relB1);
    const rB1 = await patchRelease(relB1, adminTok, { title: '补标题', version_tag: 'v2' });
    assert.strictEqual(rB1.status, 409, `[6c] 边界一应 409, got ${rB1.status} ${JSON.stringify(rB1.body)}`);
    assert.strictEqual(rB1.body.code, 'RELEASE_NOTIFY_STARTED', '[6c] code');
    const rowB1 = await releaseRow(relB1);
    assert.strictEqual(rowB1.title, null, '[6c] 拒绝请求零写入——title 仍为 NULL');
    ok('[6c] D8 例外边界一：title 补空的同时 version_tag 也实际变更（changes 不再 ⊆ {title}）→ 409（例外只开 title 一个口，且零写入）');

    const relB2 = await mkRelease({ version_tag: 'vSame', release_note: '说明Same' });   // title 缺省=NULL
    await setExecutors(relB2, [5]);
    await markSent(relB2);
    const rB2 = await patchRelease(relB2, adminTok, { title: '真变了', version_tag: 'vSame', release_note: '说明Same' });
    assert.strictEqual(rB2.status, 200, `[6d] 边界二应 200, got ${rB2.status} ${JSON.stringify(rB2.body)}`);
    assert.strictEqual(rB2.body.changed, true, '[6d] changed=true');
    assert.strictEqual(rB2.body.changes.length, 1, '[6d] 实际变更集恰含 1 项（title）——判据是"实际变更集"不是"提交字段集"');
    assert.strictEqual(rB2.body.changes[0].field, 'title', '[6d] 唯一变更字段=title');
    ok('[6d] D8 例外边界二：三字段全量提交但 version_tag/release_note 提交值=现值（实际未变）→ 放行（450-H2 判据="实际变更集"非"提交字段集"）');

    const relB3 = await mkRelease({ title: '   ' });   // 空白串 title
    await setExecutors(relB3, [5]);
    await markSent(relB3);
    const rB3a = await patchRelease(relB3, adminTok, { title: '真实标题' });
    assert.strictEqual(rB3a.status, 200, `[6e-1] 空白串视为空应 200, got ${rB3a.status} ${JSON.stringify(rB3a.body)}`);
    ok('[6e-1] D8 例外边界三·正向：title 现值是空白串 "   " 视为空（norm 归一）→ 判定为"补空"，走例外放行');

    const relB3b = await mkRelease({ title: '   ' });
    await setExecutors(relB3b, [5]);
    await markSent(relB3b);
    const rB3b = await patchRelease(relB3b, adminTok, { title: '   ' });   // 新值归一后同样为空——无变更
    assert.strictEqual(rB3b.status, 200, `[6e-2] 新值归一后仍空应 200, got ${rB3b.status} ${JSON.stringify(rB3b.body)}`);
    assert.strictEqual(rB3b.body.changed, false, '[6e-2] changed=false（旧值/新值归一后均为空，无实际变更，不触发例外通道也不 409）');
    ok('[6e-2] D8 例外边界三·反向：新 title 归一后仍为空（空白串→空白串）→ 判无变更，短路 changed:false（不触发例外通道，因为通知门根本没被进入）');

    const relLen = await mkRelease({});   // title=NULL
    await setExecutors(relLen, [5]);
    await markSent(relLen);
    const rLen = await patchRelease(relLen, adminTok, { title: 'x'.repeat(I.SYS_RELEASE_TITLE_MAX + 1) });
    assert.strictEqual(rLen.status, 400, `[6f] 长度校验先于例外应 400, got ${rLen.status} ${JSON.stringify(rLen.body)}`);
    assert.strictEqual(rLen.body.code, 'RELEASE_TITLE_TOO_LONG', '[6f] code=RELEASE_TITLE_TOO_LONG（非 409）');
    ok('[6f] 长度校验先于 D8 例外判定：title 为空 + 通知已启动 + 新 title 超长 → 400（不因符合补空例外条件而放过超长校验）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [7] 归一化对称（451-M3）+ 短路顺序（451-M3）+ 三道门优先级（452-M1）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const rel1Ins = await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, version_tag, created_by, created_by_name)
                                VALUES (?, ?, '计划中', 0, NULL, 1, '管理员')`, [`R-NORM-${Date.now()}-1`, '   ']);
    const relId1 = rel1Ins.lastID;
    const r1 = await patchRelease(relId1, adminTok, { title: '' });
    assert.strictEqual(r1.status, 200, `[7a] 应 200, got ${r1.status}`);
    assert.strictEqual(r1.body.changed, false, "[7a] 旧值'   '（空白）+ 新值''：归一后均为 null，判无变更");
    ok("[7a] 归一化对称正例：旧值'   '（纯空格）与新值''归一后均为 null → 判无变更（changed:false），若只归一新值不归一旧值会误判成有变更");

    const rel2Ins = await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, version_tag, created_by, created_by_name)
                                VALUES (?, NULL, '计划中', 0, NULL, 1, '管理员')`, [`R-NORM-${Date.now()}-2`]);
    const relId2 = rel2Ins.lastID;
    const r2 = await patchRelease(relId2, adminTok, { title: '  x  ' });
    assert.strictEqual(r2.status, 200, `[7b] 应 200, got ${r2.status}`);
    assert.strictEqual(r2.body.changed, true, '[7b] 旧值 null + 新值带前后空格的非空串：判变更');
    const row2 = await releaseRow(relId2);
    assert.strictEqual(row2.title, 'x', "[7b] 落库为归一（trim）后的 'x'，非原始 '  x  '");
    ok("[7b] 归一化对称反例：旧值 null + 新值 '  x  ' → 判变更且落库为 trim 后的 'x'");

    const relNoop = await mkRelease({ title: '短路批次', version_tag: 'vS', release_note: '说明S' });
    await setExecutors(relNoop, [5]);
    await markSent(relNoop);
    const rNoop = await patchRelease(relNoop, adminTok, { title: '短路批次', version_tag: 'vS', release_note: '说明S' });
    assert.strictEqual(rNoop.status, 200, `[7c] 应 200, got ${rNoop.status} ${JSON.stringify(rNoop.body)}`);
    assert.strictEqual(rNoop.body.changed, false, '[7c] changed=false');
    ok('[7c] 短路顺序（451-M3）：通知已启动 + 请求无任何实际变更 → 200 changed:false（空变更集短路在通知门之前，no-op 不该报错为 409）');

    const relPub = await mkRelease({ title: '门序批次', version_tag: 'vP', release_note: '说明P' });
    await setReleaseStatus(relPub, '已发布');
    const rPubNoop = await patchRelease(relPub, adminTok, { title: '门序批次', version_tag: 'vP', release_note: '说明P' });
    assert.strictEqual(rPubNoop.status, 409, `[7d] 已发布+无变更应 409, got ${rPubNoop.status} ${JSON.stringify(rPubNoop.body)}`);
    assert.strictEqual(rPubNoop.body.code, 'RELEASE_NOT_PLANNING', '[7d] code=RELEASE_NOT_PLANNING（不是 200 changed:false）');
    ok('[7d] 452-M1 三道门优先级：已发布批次 + 无任何变更的 PATCH → 409（证明 status 门恒在 no-op 短路之前，不因"没有实际变更"而放行 200）');

    const relCtrl = await mkRelease({ title: '对照批次', version_tag: 'vC', release_note: '说明C' });
    await setExecutors(relCtrl, [5]);
    await markSent(relCtrl);
    const rCtrl = await patchRelease(relCtrl, adminTok, { title: '对照批次', version_tag: 'vC', release_note: '说明C' });
    assert.strictEqual(rCtrl.status, 200, `[7e] 对照组应 200, got ${rCtrl.status} ${JSON.stringify(rCtrl.body)}`);
    assert.strictEqual(rCtrl.body.changed, false, '[7e] changed=false');
    ok('[7e] 452-M1 对照组：计划中 + 通知已启动 + 无变更 → 200 changed:false（证明通知门确实被空变更集短路越过，与 [7d] 对比坐实"只越过通知门，不越过 status 门"）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [8] CAS 并发 409（真实竞态构造，见文件头部说明）+ 反向一对（有值→null / null→有值）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '并发批次', version_tag: 'v1', release_note: '说明1' });
    const raceGet = makeRaceInterceptingGet(get, run, relId,
      `UPDATE sys_releases SET title=? WHERE id=?`, ['并发抢先改写-真实并发写', relId]);
    const modCasReal = require('../routes/sys-iteration')({
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      db, dbRunAsync: run, dbGetAsync: raceGet, dbAllAsync: all,
      authenticateToken, requireAdmin,
      ...testDeps(),
    });
    modCasReal.initSchema();
    await waitReadyOn(modCasReal._internals);
    let casServer;
    await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', modCasReal.router); casServer = app.listen(0, '127.0.0.1', res); });
    const casCall = makeCaller(() => casServer.address().port);
    const rCas = await casCall('PATCH', `/api/sys-releases/${relId}`, adminTok, { title: '我以为现在还是原值时提交的新标题' });
    casServer.close();
    assert.strictEqual(rCas.status, 409, `[8] CAS 并发应 409, got ${rCas.status} ${JSON.stringify(rCas.body)}`);
    assert.strictEqual(rCas.body.code, 'CONCURRENT_STATE_CHANGE', `[8] code, got ${rCas.body.code}`);
    // 拦截器注入的"并发写"与端点自身的 UPDATE 同属一个事务（sysBeginImmediate 的写锁语义使然）——CAS
    // 命中 0 行后端点 sysRollback()，整个事务（含拦截器注入的那次写）一并回滚，行应回到**最初**的值，
    // 而不是拦截器注入的中间值、也不是端点提交的新值——这恰恰证明了"失败阻断不静默吞"（三件套第三条）：
    // 一旦 CAS 判定失败，事务内的一切改动（不管来自谁）都不会有任何一部分被悄悄留下。
    const rowAfterCas = await releaseRow(relId);
    assert.strictEqual(rowAfterCas.title, '并发批次', '[8] CAS 失败 → 整个事务回滚，行回到最初值（拦截器注入的中间写与端点本身的新值均未持久化，验证失败阻断不部分提交）');
    ok('[8] CAS 并发 409：事务内 SELECT 读到旧值快照之后、UPDATE 之前，行被同连接上的另一次写改写（模拟外部并发写）——三字段全比对 CAS 命中 0 行 → 409 CONCURRENT_STATE_CHANGE → 整个事务原子回滚，行回到最初值，无任何部分提交（状态机 UPDATE 三件套：WHERE 含期望前置值 + changes 检查 + 失败阻断不静默吞）');

    const relA = await mkRelease({ title: '有值标题' });
    const rA = await patchRelease(relA, adminTok, { title: null });
    assert.strictEqual(rA.status, 200, `[8a] 应 200, got ${rA.status}`);
    assert.strictEqual(rA.body.changed, true, '[8a] changed=true');
    assert.strictEqual((await releaseRow(relA)).title, null, '[8a] title 落库为 NULL');
    ok('[8a] 反向一对①：title 有值→null（显式清空）→ 落库 NULL 且 changed=true');

    const relB = await mkRelease({});   // title=NULL
    const rB = await patchRelease(relB, adminTok, { title: '新填标题' });
    assert.strictEqual(rB.status, 200, `[8b] 应 200, got ${rB.status}`);
    assert.strictEqual(rB.body.changed, true, '[8b] changed=true');
    assert.strictEqual((await releaseRow(relB)).title, '新填标题', '[8b] title 落库为新值');
    ok('[8b] 反向一对②：title null→有值（填写）→ 落库新值且 changed=true');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [9] 449-M4 副作用不变量：编辑前后执行人集合 + 每行 notify_status/exec_status + 聚合态全等，
  //     除 N 条 note 事件外零新增事件（不调 applyReleaseChange，不重置执行人/通知）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '副作用批次' });
    const iid = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [iid]);
    await setExecutors(relId, [5, 6]);
    await markSent(relId);
    await run(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [relId]);

    const execBefore = await all(`SELECT user_id, notify_status, exec_status, notified_at, executed_at FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [relId]);
    const summaryBefore = await I.getReleaseNotifySummary(relId);
    const timelineCountBefore = await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [iid]).then(r => r.c);

    // D8 状态门对**任意字段的实际变更**生效（不限 title），故此处提交 release_note 变更会被 409 拦下——
    // 用这个必然的 409 拒绝路径验证"拒绝时零副作用"，比强行构造一个能通过 D8 的非 title 编辑更贴近真实：
    // release_note/version_tag 字段本就无法绕开 D8（唯一豁免口子只有 title 补空），此处正是在验证这一点
    // 附带不产生任何执行人/通知副作用。
    const r = await patchRelease(relId, adminTok, { release_note: '新说明（预期会被 D8 拦下）' });
    assert.strictEqual(r.status, 409, '[9-guard] release_note 实际变更 + 通知已启动 → 409（非 title 补空例外，确认本组前提成立）');

    const execAfter = await all(`SELECT user_id, notify_status, exec_status, notified_at, executed_at FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [relId]);
    const summaryAfter = await I.getReleaseNotifySummary(relId);
    const timelineCountAfter = await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [iid]).then(r => r.c);
    assert.deepStrictEqual(execAfter, execBefore, '[9a] 409 拒绝路径：执行人集合 + 每行 notify_status/exec_status/notified_at/executed_at 编辑前后全等');
    assert.strictEqual(summaryAfter, summaryBefore, '[9a] 409 拒绝路径：聚合通知态编辑前后全等');
    assert.strictEqual(timelineCountAfter, timelineCountBefore, '[9a] 409 拒绝路径：时间线零新增');
    ok('[9a] 409 拒绝路径零副作用：执行人集合/通知态/exec_status/时间线计数编辑前后全等（PATCH 不调 applyReleaseChange，不重置执行人通知）');

    const relOk = await mkRelease({});   // title=NULL
    const iidOk = await mkIssue('feature', '待上线');
    await addIssuesTo(relOk, [iidOk]);
    await setExecutors(relOk, [7]);
    await markSent(relOk);
    const execBefore2 = await all(`SELECT user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [relOk]);
    const tlBefore2 = await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [iidOk]).then(r => r.c);
    const rOk = await patchRelease(relOk, adminTok, { title: '补写成功' });
    assert.strictEqual(rOk.status, 200, `[9b] 应 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    const execAfter2 = await all(`SELECT user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [relOk]);
    const tlAfter2 = await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [iidOk]).then(r => r.c);
    assert.deepStrictEqual(execAfter2, execBefore2, '[9b] 成功编辑（D8 例外通道）：执行人集合/notify_status/exec_status 全等（编辑不重置执行人）');
    assert.strictEqual(tlAfter2, tlBefore2 + 1, '[9b] 成功编辑：该成员单时间线恰增 1 条（仅新增本次 note 事件，无副作用事件）');
    ok('[9b] 449-M4 成功路径零多余副作用：D8 例外通道成功编辑后执行人集合/通知态原样不动，仅新增本次 1 条 note 事件');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [10] 两组变异自证（spec 硬约束：≥2 组，门序调换→红／留痕比对制破坏→红）
  // ─────────────────────────────────────────────────────────────────────────
  {
    // ── 变异①（门序调换）：把 status 门神经元置为 `false && (...)`（等价于把该门移出队首/失效），
    //   用与 [7d] 完全相同的场景（已发布 + 无任何变更）验证真实代码的 409 会翻转为 200 changed:false。
    {
      // [R-C6 订正] 单行锚点 `if (beforeRow.status !== '计划中') {` 此前唯一命中，但 R-C6 新增
      //   DELETE /sys-releases/:id 端点复用了完全相同的单行状态门文本（方案 §3 O4 明文"与 O3 同一条闸，
      //   不另起判据"，两端点故意同构）——单纯搜该行本身已不足以唯一定位，改用"起点+PATCH 端点专属错误
      //   文案尾串"组合切片（同 [10b] 起止锚点切片同一范式，避免手写跨行字面量踩 CRLF 坑：曾踩坑手写 \n
      //   版本 0 命中，源文件其实是 \r\n）。PATCH 的 409 文案是"不能编辑"，DELETE 是"不能删除"——两者
      //   错误码同为 RELEASE_NOT_PLANNING 但文案不同，用文案尾串即可把切片精确收窄到 PATCH 独有的那一段。
      const NEEDLE_START = "if (beforeRow.status !== '计划中') {";
      const NEEDLE_PATCH_ONLY_TAIL = "不能编辑', code: 'RELEASE_NOT_PLANNING' });";
      const startIdx0 = REAL_SRC.indexOf(NEEDLE_START);
      assert.ok(startIdx0 !== -1, '[10a-pre] status 门起点锚点未找到——源码结构已变，需要人工核实并更新本变异脚本');
      const tailIdx0 = REAL_SRC.indexOf(NEEDLE_PATCH_ONLY_TAIL, startIdx0);
      assert.ok(tailIdx0 !== -1, '[10a-pre] PATCH 专属错误文案尾串（"不能编辑"）未找到——源码结构已变，需要人工核实并更新本变异脚本');
      const NEEDLE = REAL_SRC.slice(startIdx0, tailIdx0 + NEEDLE_PATCH_ONLY_TAIL.length);
      const occurrences = REAL_SRC.split(NEEDLE).length - 1;
      assert.strictEqual(occurrences, 1, `[10a-pre] status 门文本定位必须唯一命中，实得 ${occurrences} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated = REAL_SRC.replace(NEEDLE, NEEDLE.replace(NEEDLE_START, "if (false && beforeRow.status !== '计划中') {"));
      // depsOverride 显式复用主测试套件的共享 db/run/get/all——变异实例与主套件同一份 `:memory:` 连接，
      // 故下方可直接用外层 run() 改写变异实例创建的批次（同一张 sys_releases 表）。
      await withMutantModule(mutated, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: '门序变异批次', version_tag: 'vM', release_note: '说明M' });
        assert.strictEqual(rCreate.status, 201, `[10a] 变异实例建批次应 201, got ${rCreate.status}`);
        const relId = rCreate.body.id;
        await run(`UPDATE sys_releases SET status='已发布' WHERE id=?`, [relId]);
        const rPatch = await mcall('PATCH', `/api/sys-releases/${relId}`, adminTok, { title: '门序变异批次', version_tag: 'vM', release_note: '说明M' });
        assert.strictEqual(rPatch.status, 200, `[10a] 变异（status 门禁用）后应变成 200（真实代码是 409 RELEASE_NOT_PLANNING）, got ${rPatch.status} ${JSON.stringify(rPatch.body)}`);
        assert.strictEqual(rPatch.body.changed, false, '[10a] 变异后 changed=false（status 门失效后一路走到空变更集短路命中）');
      });
      ok('[10a] 变异自证①（门序调换）：禁用 status 门后，[7d] 同款"已发布+无变更"场景从真实代码的 409 RELEASE_NOT_PLANNING 翻转为 200 changed:false——证明该断言真实依赖 status 门在短路之前生效，非偶然巧合');
    }

    // ── 变异②（留痕比对制破坏）：CAS UPDATE 的 WHERE 子句去掉三字段旧值比对（只留 id+status），
    //   在与 [8] 完全相同的"事务内读→写之间被外部并发写命中"场景下，验证真实代码的 409 会翻转为 200
    //   （证明 [8] 的 409 真实依赖三字段 CAS 比对，不是别的什么巧合让它恰好 409）。
    {
      // 用"起止两条单行锚点 + 现场从真实源码切片"代替手写跨行 NEEDLE——不依赖对齐源文件的真实行尾/
      // 缩进字节（同 [10a] 教训：手写多行文本极易与 CRLF/空白不对齐导致 0 命中）。起点=SQL 文本首行，
      // 终点=params 数组最后一个标识符——把这两个锚点之间的原始文本整体切出来，与"是否唯一命中"一并
      // 断言，再用**显式 \r\n 转义序列**（而非源文件字面换行）构造替换文本，规避行尾编码脆弱性。
      const CAS_ANCHOR_START = "UPDATE sys_releases SET title = ?, version_tag = ?, release_note = ?";
      const CAS_ANCHOR_END = "beforeRow.title, beforeRow.version_tag, beforeRow.release_note]";
      const startIdx = REAL_SRC.indexOf(CAS_ANCHOR_START);
      assert.ok(startIdx !== -1, '[10b-pre] CAS UPDATE 起始锚点未找到——源码结构已变，需要人工核实并更新本变异脚本');
      const endIdx = REAL_SRC.indexOf(CAS_ANCHOR_END, startIdx);
      assert.ok(endIdx !== -1, '[10b-pre] CAS UPDATE 终止锚点未找到——源码结构已变，需要人工核实并更新本变异脚本');
      const originalSpan = REAL_SRC.slice(startIdx, endIdx + CAS_ANCHOR_END.length);
      const occurrences = REAL_SRC.split(originalSpan).length - 1;
      assert.strictEqual(occurrences, 1, `[10b-pre] CAS UPDATE 文本切片必须唯一命中，实得 ${occurrences} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutatedSpan = "UPDATE sys_releases SET title = ?, version_tag = ?, release_note = ?\r\n             WHERE id = ? AND status = '计划中'`,\r\n          [finalTitle, finalVersionTag, finalReleaseNote, id]";
      const mutated2 = REAL_SRC.replace(originalSpan, mutatedSpan);
      const mdb = new sqlite3.Database(':memory:');
      const mrun = (sql, params = []) => new Promise((res, rej) => mdb.run(sql, params, function (e) { e ? rej(e) : res(this); }));
      const mall = (sql, params = []) => new Promise((res, rej) => mdb.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
      const mget = (sql, params = []) => new Promise((res, rej) => mdb.get(sql, params, (e, row) => e ? rej(e) : res(row)));
      try {
        await mrun(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
        await mrun(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES (1,'admin','管理员','admin','active','13800000001')`);
        await withMutantModule(mutated2, { db: mdb, dbRunAsync: mrun, dbGetAsync: mget, dbAllAsync: mall }, async ({ call: mcall, mutantFactory, baseDeps }) => {
          const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: 'CAS变异批次', version_tag: 'vC', release_note: '说明C' });
          assert.strictEqual(rCreate.status, 201, `[10b] 变异实例建批次应 201, got ${rCreate.status}`);
          const relId = rCreate.body.id;
          // 同一份突变工厂（同一处 CAS 破坏），换一副 dbGetAsync（带竞态拦截器）建第二个独立实例，复用同一
          // mdb——不重写文件/不重新 require，只是拿同一个工厂函数再调用一次（工厂本身无状态副作用）。
          const raceGet2 = makeRaceInterceptingGet(mget, mrun, relId,
            `UPDATE sys_releases SET title=? WHERE id=?`, ['CAS变异-并发抢先改写', relId]);
          const inst2 = await buildMutantInstance(mutantFactory, { ...baseDeps, db: mdb, dbRunAsync: mrun, dbGetAsync: raceGet2, dbAllAsync: mall });
          try {
            const rPatch = await inst2.call('PATCH', `/api/sys-releases/${relId}`, adminTok, { title: '我以为现在还是原值时提交的新标题' });
            assert.strictEqual(rPatch.status, 200, `[10b] CAS 比对制被破坏后应变成 200（真实代码是 409 CONCURRENT_STATE_CHANGE）, got ${rPatch.status} ${JSON.stringify(rPatch.body)}`);
            const rowAfter = await mget(`SELECT title FROM sys_releases WHERE id=?`, [relId]);
            assert.strictEqual(rowAfter.title, '我以为现在还是原值时提交的新标题', '[10b] CAS 比对制被破坏后：并发写的结果被本次 PATCH 静默覆盖（数据丢失，正是 CAS 要防的场景）');
          } finally {
            inst2.close();
          }
        });
      } finally {
        try { mdb.close(); } catch (_) { /* ignore */ }
      }
      ok('[10b] 变异自证②（留痕比对制破坏）：CAS UPDATE 去掉三字段旧值比对后，与 [8] 完全相同的"事务内读→写之间被外部并发写命中"场景从真实代码的 409 CONCURRENT_STATE_CHANGE 翻转为 200（且静默覆盖了并发写的结果）——证明 [8] 的 409 真实依赖三字段比对制，不是别的巧合');
    }

    // ── 变异③（S9 预筛拦截 P1·D8 例外半合取式摘除）：oldTitleBlank 恒 true = "补空"例外对任何
    //   title 现值开门（通知发出后仍能随意改标题——正是 D8 要堵的事）。[6g] 同款场景在变异实例下
    //   翻 200，证明 [6g] 的 409 真实依赖 oldTitleBlank 这半个合取式。
    {
      const NEEDLE3 = 'const oldTitleBlank = norm(beforeRow.title) === null;';
      const occ3 = REAL_SRC.split(NEEDLE3).length - 1;
      assert.strictEqual(occ3, 1, `[10c-pre] oldTitleBlank 文本定位必须唯一命中，实得 ${occ3} 处——源码结构已变，需要人工核实并更新本变异脚本`);
      const mutated3 = REAL_SRC.replace(NEEDLE3, 'const oldTitleBlank = true;');
      await withMutantModule(mutated3, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
        const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: '例外变异批次原标题', version_tag: 'vE', release_note: '说明E' });
        assert.strictEqual(rCreate.status, 201, `[10c] 变异实例建批次应 201, got ${rCreate.status}`);
        const relId = rCreate.body.id;
        // 走真实端点+markSent 同款置位（直插缺 added_by 等 NOT NULL 列，且绕过端点校验面）
        const rExec = await mcall('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5] });
        assert.strictEqual(rExec.status, 200, `[10c] 变异实例设执行人应 200, got ${rExec.status}`);
        await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [relId]);
        const rPatch = await mcall('PATCH', `/api/sys-releases/${relId}`, adminTok, { title: '篡改后的标题' });
        assert.strictEqual(rPatch.status, 200, `[10c] 变异（oldTitleBlank 恒真）后应翻成 200（真实代码是 409 RELEASE_NOTIFY_STARTED·[6g] 同款场景）, got ${rPatch.status} ${JSON.stringify(rPatch.body)}`);
      });
      ok('[10c] 变异自证③（D8 例外半合取式摘除）：oldTitleBlank 恒真后，[6g] 同款"通知已启动+非空 title 被改"场景从真实代码的 409 翻转为 200——证明 [6g] 的 409 真实依赖"现值为空才放行"这半个合取式，防"例外为篡改开门"');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [11] codex 472 HIGH-1 回归：最终写入值须由「实际变更集」（changedFields）驱动，非
  //   presentFields 驱动——库内已存在脏空白 title='   '（历史脏数据/其它写点产生，非本端点写入）时，
  //   提交 title=''（归一后与现值同为 null，不算变更）+ version_tag='v2'（真变更）——title 不进
  //   changes，finalTitle 必须原样写回 beforeRow.title='   '（不做无痕归一化），只有 version_tag
  //   落库新值；时间线/审计 changes_json 也必须与响应体 changes 逐字段一致。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '占位H', version_tag: 'v1', release_note: '说明H' });
    // 库内脏数据：绕开本端点写入路径，直接把 title 改成脏空白（模拟历史脏数据/其它写点产生的半空白）。
    await run(`UPDATE sys_releases SET title='   ' WHERE id=?`, [relId]);
    const r = await patchRelease(relId, adminTok, { title: '', version_tag: 'v2' });
    assert.strictEqual(r.status, 200, `[11a] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, true, '[11a] changed=true（version_tag 真变更）');
    assert.strictEqual(r.body.changes.length, 1, '[11a] 实际变更集恰 1 项（title 提交空串与现值"   "归一后同为 null，不算变更；仅 version_tag 真变）');
    assert.strictEqual(r.body.changes[0].field, 'version_tag', '[11a] 唯一变更字段=version_tag');
    const row = await releaseRow(relId);
    assert.strictEqual(row.title, '   ', "[11a] HIGH-1：title 未进变更集，finalTitle 必须原样写回 beforeRow.title='   '（不因 title 出现在 presentFields 里就被 norm() 无痕归一化成 NULL）");
    assert.strictEqual(row.version_tag, 'v2', '[11a] version_tag 落库新值');
    const tl = await editTimelineRows(relId);
    assert.strictEqual(tl.length, 0, '[11a] 空批次：时间线 0 条');
    const au = await auditRows(relId);
    assert.strictEqual(au.length, 1, '[11a] 审计恰 1 条');
    const auChanges = JSON.parse(au[0].changes_json);
    assert.strictEqual(auChanges.length, 1, '[11a] 审计 changes_json 恰含 1 项（裸数组，472-MED-2 CHECK 要求的形状）');
    assert.strictEqual(auChanges[0].field, 'version_tag', '[11a] 审计 changes_json 唯一项=version_tag');
    assert.deepStrictEqual(auChanges, r.body.changes, '[11a] 审计 changes_json（裸数组）与响应体 changes 逐字段一致（同源同一份 changes 数组）');
    const tlN1 = await mkRelease({ title: '占位H2', version_tag: 'v1' });
    const iidH = await mkIssue('feature', '待上线');
    await addIssuesTo(tlN1, [iidH]);
    await run(`UPDATE sys_releases SET title='   ' WHERE id=?`, [tlN1]);
    const rN1 = await patchRelease(tlN1, adminTok, { title: '', version_tag: 'v2' });
    assert.strictEqual(rN1.status, 200, `[11a-tl] 应 200, got ${rN1.status}`);
    const tlRows = await editTimelineRows(tlN1);
    assert.strictEqual(tlRows.length, 1, '[11a-tl] 有成员时时间线恰 1 条');
    const tlPayload = JSON.parse(tlRows[0].payload_json);
    assert.deepStrictEqual(tlPayload.changes, rN1.body.changes, '[11a-tl] 时间线 payload_json.changes 与响应体 changes 逐字段一致');
    ok('[11a] HIGH-1 回归：库内脏空白 title=\'   \' 场景下，PATCH {title:\'\',version_tag:\'v2\'} → title 不进变更集，finalTitle 按 changedFields（非 presentFields）驱动、原样保留脏空白值不被无痕归一化；version_tag 正确落库；时间线 payload_json.changes / 审计 changes_json（裸数组）均与响应体 changes 逐字段一致');
  }

  // HIGH-1 变异自证：finalTitle 改回 presentFields 驱动 → [11a] 场景下 title 会被无痕归一化为 NULL，翻红。
  {
    const NEEDLE = "const finalTitle = changedFields.has('title') ? norm(newRaw.title) : beforeRow.title;";
    const occ = REAL_SRC.split(NEEDLE).length - 1;
    assert.strictEqual(occ, 1, `[11b-pre] finalTitle 文本定位必须唯一命中，实得 ${occ} 处——源码结构已变，需要人工核实并更新本变异脚本`);
    const mutated = REAL_SRC.replace(NEEDLE, "const finalTitle = presentFields.includes('title') ? norm(newRaw.title) : beforeRow.title;");
    await withMutantModule(mutated, { db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, async ({ call: mcall }) => {
      const rCreate = await mcall('POST', '/api/sys-releases', adminTok, { title: '占位H3', version_tag: 'v1', release_note: '说明H3' });
      assert.strictEqual(rCreate.status, 201, `[11b] 变异实例建批次应 201, got ${rCreate.status}`);
      const relId = rCreate.body.id;
      await run(`UPDATE sys_releases SET title='   ' WHERE id=?`, [relId]);
      const rPatch = await mcall('PATCH', `/api/sys-releases/${relId}`, adminTok, { title: '', version_tag: 'v2' });
      assert.strictEqual(rPatch.status, 200, `[11b] 应 200, got ${rPatch.status}`);
      const rowAfter = await releaseRow(relId);
      assert.strictEqual(rowAfter.title, null, "[11b] 变异（presentFields 驱动）后 title 被无痕归一化清空为 NULL（真实代码保留原始脏空白 '   '）——证明 [11a] 的保留行为真实依赖 changedFields 判据，不是 norm() 恰好如此的巧合");
    });
    ok('[11b] 变异自证④（HIGH-1 回卷）：finalTitle 改回 presentFields 驱动后，[11a] 同款"脏空白+补空未变更"场景的 title 从真实代码的原样保留（\'   \'）翻转为被无痕归一化清空（NULL）——证明该保留行为真实依赖 changedFields 判据，不是巧合');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [12] codex 472 MED-1：body 须为非数组对象；未知字段（如 planned_date，本端点不支持，须走
  //   update-planned-date）显式 400，不静默忽略——静默忽略会让调用方把"什么都没做"误判为"操作成功"。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: 'MED1批次' });
    const rUnknown = await patchRelease(relId, adminTok, { planned_date: '2026-08-30' });
    assert.strictEqual(rUnknown.status, 400, `[12a] 未知字段应 400, got ${rUnknown.status} ${JSON.stringify(rUnknown.body)}`);
    assert.strictEqual(rUnknown.body.code, 'RELEASE_PATCH_UNSUPPORTED_FIELD', `[12a] code, got ${rUnknown.body.code}`);
    assert.ok(Array.isArray(rUnknown.body.fields) && rUnknown.body.fields.includes('planned_date'), `[12a] body.fields 应含 'planned_date'，实得 ${JSON.stringify(rUnknown.body.fields)}`);
    const rowUnchanged = await releaseRow(relId);
    assert.strictEqual(rowUnchanged.title, 'MED1批次', '[12a] 拒绝请求零写入');
    ok('[12a] MED-1：提交 planned_date（本端点不支持，须走 update-planned-date）→ 400 RELEASE_PATCH_UNSUPPORTED_FIELD 且 body.fields 含该字段、零写入（不静默忽略误判"操作成功"）');

    const rArray = await patchRelease(relId, adminTok, []);
    assert.strictEqual(rArray.status, 400, `[12b] 数组 body 应 400, got ${rArray.status} ${JSON.stringify(rArray.body)}`);
    assert.strictEqual(rArray.body.code, 'RELEASE_PATCH_INVALID_BODY', `[12b] code, got ${rArray.body.code}`);
    ok('[12b] MED-1：数组 body → 400 RELEASE_PATCH_INVALID_BODY（非数组对象闸）');

    const rEmpty = await patchRelease(relId, adminTok, {});
    assert.strictEqual(rEmpty.status, 200, `[12c] 空对象应 200（既定行为不回归）, got ${rEmpty.status} ${JSON.stringify(rEmpty.body)}`);
    assert.strictEqual(rEmpty.body.changed, false, '[12c] {} 请求体：走 status 门后 changed:false（452-M1 既定行为，MED-1 新增字段闸不破坏此路径）');
    ok('[12c] MED-1 回归防护：空对象 {} 请求体仍 200 changed:false（既定行为未被新增字段闸破坏）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [12d-f] codex 472 复审 MED-1 追加：body 为合法 JSON 但顶层是标量（null/字符串/数字）——
  //   实测行为（见文件头部 [12d-f 前置] 中间件注释）：Express body-parser 默认 strict:true，只接受
  //   顶层 '{' 或 '[' 开头的 JSON；标量顶层值在 body-parser 解析阶段即被拒（SyntaxError），请求根本
  //   不会到达本端点的 RELEASE_PATCH_INVALID_BODY 分支——与 [12b] 的空数组 body 不同（数组顶层合法，
  //   能走到路由内 Array.isArray 判断）。生产 server.js:20960-20963 的全局错误处理器统一把这类
  //   SyntaxError 转成 {error:'无效的JSON格式'}（不带业务 code，因为压根没进业务路由）——本组因此断言
  //   status 400 + 该文案，**不**断言 code==='RELEASE_PATCH_INVALID_BODY'（那个 code 在这三个用例里
  //   永远不会出现，是本端点代码到不了的地方）。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: 'MED1d批次' });
    const casesRaw = [
      { label: '[12d]', raw: 'null', desc: 'body=null（JSON 字面量）' },
      { label: '[12e]', raw: '"str"', desc: 'body=\'"str"\'（JSON 字符串）' },
      { label: '[12f]', raw: '123', desc: 'body=123（JSON 数字）' },
    ];
    for (const c of casesRaw) {
      const r = await callRawBody('PATCH', `/api/sys-releases/${relId}`, adminTok, c.raw);
      assert.strictEqual(r.status, 400, `${c.label} ${c.desc} 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body && r.body.error === '无效的JSON格式', `${c.label} 应命中生产全局 JSON 解析错误处理器兜底文案'无效的JSON格式'，实得 ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, undefined, `${c.label} 不应带业务 code（请求在 body-parser 阶段即被拒，RELEASE_PATCH_INVALID_BODY 分支从未执行），实得 code=${r.body.code}`);
      ok(`${c.label} MED-1 追加：${c.desc} → body-parser strict 模式在到达路由前即拒绝（SyntaxError）——生产全局错误处理器统一转 400 {error:'无效的JSON格式'}（无 code，因未进业务路由，非 RELEASE_PATCH_INVALID_BODY）`);
    }
    const rowUnchanged = await releaseRow(relId);
    assert.strictEqual(rowUnchanged.title, 'MED1d批次', '[12d-f] 三次拒绝均零写入');
    ok('[12d-f] 汇总：三种标量顶层 body 均零写入；与 [12b] 数组 body（顶层合法、能到达路由内 Array.isArray 判断）形成对照——同为"不支持的 body 形态"但拒绝层级不同（body-parser 层 vs 路由业务层）');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [12g] codex 472 复审 MED-1：混合字段——1 个支持字段（title）+ 1 个不支持字段（planned_date）
  //   → 400 RELEASE_PATCH_UNSUPPORTED_FIELD（不因夹带了合法字段就放行部分处理），release 行/时间线/
  //   审计三处零写入（用有成员的批次，确保"时间线零写入"不是空批次天然无处可写的巧合）。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const relId = await mkRelease({ title: '混合字段批次' });
    const iid = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [iid]);
    const before = await releaseRow(relId);
    const r = await patchRelease(relId, adminTok, { title: '新值', planned_date: '2026-08-30' });
    assert.strictEqual(r.status, 400, `[12g] 混合字段应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RELEASE_PATCH_UNSUPPORTED_FIELD', `[12g] code, got ${r.body.code}`);
    assert.ok(Array.isArray(r.body.fields) && r.body.fields.includes('planned_date') && !r.body.fields.includes('title'),
      `[12g] body.fields 应只含不支持字段 planned_date（不含合法字段 title），实得 ${JSON.stringify(r.body.fields)}`);
    const after = await releaseRow(relId);
    assert.strictEqual(after.title, before.title, '[12g] release 行零写入：title 未因夹带了合法字段而被"部分处理"');
    const tl = await editTimelineRows(relId);
    assert.strictEqual(tl.length, 0, '[12g] 时间线零写入');
    const au = await auditRows(relId);
    assert.strictEqual(au.length, 0, '[12g] 审计表零写入');
    ok('[12g] MED-1 混合字段：{title:合法值, planned_date:不支持字段} → 400 RELEASE_PATCH_UNSUPPORTED_FIELD（不因夹带合法字段就放行部分处理，fields 只报不支持的那个）；release 行/时间线/审计三处均零写入');
  }

  console.log(`\n✅ verify-sys-release-edit 全部通过（${passed} 组）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
