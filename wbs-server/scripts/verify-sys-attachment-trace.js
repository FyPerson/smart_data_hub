// scripts/verify-sys-attachment-trace.js — #83 附件增删留痕：sysPersistAttachments 五态 + 三码时间线留痕
//   SSOT = docs/local/附件压缩包/时间线附件留痕_方案_20260917_v1.3.md（§1/§3/§4 A1-A5）
//         + 时间线附件留痕_C0只读核查报告_20260917_v1.2.md（§2.2 伪码 / §2.3 矩阵 23 行）
//   用法：node scripts/verify-sys-attachment-trace.js
//
// in-process app + 内存库 + 真实临时落盘（同 verify-sys-attachments.js 范式）+ 自签 token；SYS_TEST_HOOKS=1
// 供 persist 五个测试钩子（beforeAttachmentInsertHook / afterAttachmentInsertHook /
// beforeSupersedeUpdateHook / onSysTxnRelease）与既有 verify-sys-submit-amend.js 共用同一套注入范式。
'use strict';
process.env.SYS_TEST_HOOKS = '1';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

// [返工批2·M5] 本脚本独立的落盘 base——不与 verify-sys-attachments.js / verify-sys-submit-amend.js 等共享
// `_sys-attach-test-deps.js` 的 `os.tmpdir()/sys-verify-uploads` 目录（那是共享目录，`feedback_shared_dir_
// test_cleanup_precise_list`：整目录清理只对"独占目录"安全，对共享目录清理面必须精确到自己的清单，否则
// 任何手工并行/未来 family 并行化会互相删对方正在跑的文件）。启动/收尾清理只动 MY_UPLOAD_DIR 自己。
// 复刻 `_sys-attach-test-deps.js` 的 normalizeAttachmentExt/safeDeleteFileSync 真实语义（同该文件头部
// "stub 偏离真实语义会致假绿/假红"纪律），但作用域收窄到本脚本自己的 ALLOWED_FILE_DIRS。
const MY_UPLOAD_DIR = path.join(os.tmpdir(), `sys-verify-uploads-attach-trace-${process.pid}`);
const MY_ALLOWED_FILE_DIRS = [MY_UPLOAD_DIR];
try { fs.mkdirSync(MY_UPLOAD_DIR, { recursive: true }); } catch (_) { /* best-effort */ }
function myNormalizeAttachmentExt(name) {
  let s = String(name || '');
  if (/[\x00-\x1F\x7F]/.test(s)) return '';   // eslint-disable-line no-control-regex
  s = s.trim();
  return path.extname(s).toLowerCase().trim();
}
function mySafeDeleteFileSync(rel, baseDir) {
  try {
    if (!MY_ALLOWED_FILE_DIRS.includes(baseDir)) return;
    const base = path.resolve(baseDir);
    const abs = path.resolve(baseDir, rel);
    if (abs !== base && abs.startsWith(base + path.sep)) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
  } catch (_) { /* best-effort */ }
}

const SECRET = 'verify-sys-attach-trace-secret';
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

// [返工批2·M1] logger.error 换成录制器（不再是 noop）——M1 要求 20b 用例能判别式地断言「响应已发送，
// 仅记录」这条故障日志确实被写过恰 1 次（而不是只靠 r.status 这种在 res.end() 已提前发生时恒真的信号）。
// info/warn/debug 仍 noop（脚本不关心它们）。
const recordedErrorLogs = [];
// [返工批3·594T-#19] logger 对象保留一份可变引用（testLogger），供 #19 用例临时把 info 换成故障桩
// （生产端点在 COMMIT 成功后、发送响应前会调用 logger.info 打一行摘要日志）。
// [收口批5·M3] logger.warn 同样换成录制器（unlink 失败/pending 清理等走 warn，不走 error）——供 unlink
// 失败用例断言"记日志"确有可观测证据（含 issue_id 与路径），而不是靠 noop 假装记录了。
const recordedWarnLogs = [];
const testLogger = { info: noop, warn: (...a) => recordedWarnLogs.push(a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')), error: (...a) => recordedErrorLogs.push(a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')), debug: noop };
const mod = require('../routes/sys-iteration')({
  logger: testLogger,
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // 非附件相关 stub（钉钉/建群等）仍复用共享文件
  // [返工批2·M5] 附件四项覆盖为本脚本独立 base（覆盖上一行 spread 的同名共享实现）。
  UPLOAD_DIR: MY_UPLOAD_DIR,
  normalizeAttachmentExt: myNormalizeAttachmentExt,
  safeDeleteFileSync: mySafeDeleteFileSync,
  ALLOWED_FILE_DIRS: MY_ALLOWED_FILE_DIRS,
});
function countLogsIncluding(substr) { return recordedErrorLogs.filter(l => l.includes(substr)).length; }
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
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

// [收口批5·M5] 普通请求助手补超时（15s）与响应层 'aborted'/'error' 处理，只结算一次（settled 守卫）——
// 防止异常响应（连接悬挂而不发 'end'）让 await 永久挂起，拖死整个脚本的运行。
const CALL_TIMEOUT_MS = 15000;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } finish(resolve, { status: r.statusCode, body: j }); });
      r.on('aborted', () => finish(reject, new Error('response aborted')));
      r.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { finish(reject, new Error(`call 超时（${CALL_TIMEOUT_MS}ms）：${method} ${p}`)); try { req.destroy(); } catch (_) {} }, CALL_TIMEOUT_MS);
    req.on('error', (e) => finish(reject, e));
    if (data) req.write(data); req.end();
  });
}
// 多文件上传（files: [{name, buf?}]），field 名恒 'files'（同 multer 配置）。同上补超时 + 响应异常处理。
function uploadMulti(p, tok, fields, files) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const boundary = '----SysAttTraceBoundary' + (p.length * 7919 + Date.now() + Math.random());
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    for (const f of (files || [])) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(f.buf || png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } finish(resolve, { status: r.statusCode, body: j }); });
      r.on('aborted', () => finish(reject, new Error('response aborted')));
      r.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { finish(reject, new Error(`uploadMulti 超时（${CALL_TIMEOUT_MS}ms）：${p}`)); try { req.destroy(); } catch (_) {} }, CALL_TIMEOUT_MS);
    req.on('error', (e) => finish(reject, e));
    req.write(bodyBuf); req.end();
  });
}
function upload(p, tok, fields, fileName) {
  return uploadMulti(p, tok, fields, fileName ? [{ name: fileName }] : []);
}
// [返工批3·codex594-B][收口批5·M5 订正] 用于「响应头已发但未 end」场景：不等 'end' 事件（服务端可能主动
// destroy 连接，永远不会有 'end'），改用 'close'/'aborted'/请求层 'error' 任一先发生即判定 terminated:true；
// 超时未出现任何一个则判 terminated:false（服务端未收尾，客户端会一直挂等）。**先固定结果再销毁连接**——
// 若先 destroy 再 resolve，destroy 触发的 'close'/'error' 事件可能抢在超时分支之前把结果误判成
// terminated:true（把"服务端真的没收尾"误判成"客户端自己主动断的所以算成功"）。
function uploadExpectSocketClose(p, tok, fields, fileName, timeoutMs) {
  return new Promise((resolve) => {
    const boundary = '----SysAttTraceBoundary' + (p.length * 7919 + Date.now() + Math.random());
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    let settled = false;
    let currentRes = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 先固定 result，再销毁尚未结束的连接——销毁触发的后续事件已被 settled 挡住，不会覆盖已定的结果。
      try { if (currentRes && !currentRes.destroyed) currentRes.destroy(); } catch (_) { /* ignore */ }
      try { if (!req.destroyed) req.destroy(); } catch (_) { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ terminated: false, reason: 'timeout' }), timeoutMs || 3000);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => {
      currentRes = r;
      r.on('data', () => {});
      r.on('close', () => finish({ terminated: true, reason: 'response-close', status: r.statusCode }));
      r.on('aborted', () => finish({ terminated: true, reason: 'response-aborted', status: r.statusCode }));
      r.on('end', () => finish({ terminated: false, reason: 'ended-normally', status: r.statusCode }));
      // [594TR-M2] 响应对象自身也需要 error 监听——请求对象的 'error' 监听不能代替响应对象监听；响应中断
      // 后续可能产生 error 事件，缺此监听会让未处理异常直接终止脚本，绕开 finish 守卫与正常失败报告/清理。
      // 走同一个 finish 统一结算，记录原因，不改变"先固定结果再销毁连接"的既定顺序。
      r.on('error', () => finish({ terminated: true, reason: 'response-error', status: r.statusCode }));
    });
    req.on('error', () => finish({ terminated: true, reason: 'req-error' }));
    req.write(bodyBuf); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 夹具 ──────────────────────────────────────────────────────────────
let __issueSeq = 0;
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_liaison_id)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', 13)`,
    [type, status, extra.title || `${type}-${status}-单-${++__issueSeq}`]
  );
  return r.lastID;
}
async function mkDevRow(issueId, userId, userName, devStatus = 'code_submitted') {
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, ?)`, [issueId, userId, userName, devStatus]);
}
// 交付/截图夹具：改进单、开发中态、user5 在册。
async function mkDevIssue() {
  const id = await mkIssue('improvement', '开发中');
  await mkDevRow(id, 5, '开发王');
  return id;
}
const ATT = (id) => `/api/sys-issues/${id}/attachments`;
const DEL = (id, attId) => `/api/sys-issues/${id}/attachments/${attId}`;
const attRows = (issueId) => all(`SELECT * FROM sys_issue_attachments WHERE issue_id=? ORDER BY id`, [issueId]);
const activeAttRows = (issueId) => all(`SELECT * FROM sys_issue_attachments WHERE issue_id=? AND status='active' ORDER BY id`, [issueId]);
const timelineRows = (issueId) => all(`SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id`, [issueId]);
const timelineCount = async (issueId) => (await timelineRows(issueId)).length;
const dirOf = (issueId) => path.join(I.SYS_UPLOAD_BASE, String(issueId));
const dirFileCount = (issueId) => { try { return fs.readdirSync(dirOf(issueId)).length; } catch (_) { return 0; } };
// [尾批·M2] 排序后的文件名清单——比"目录项数量"更强：数量相同不代表保留的是原文件（例如误删旧文件又
// 留下一个同名新文件，数量不变但身份已变）。assertNoResidue 的文件出口改用本函数逐项比较。
const snapshotDirNames = (issueId) => { try { return fs.readdirSync(dirOf(issueId)).sort(); } catch (_) { return []; } };
function clearHooks() {
  I.__testHooks.beforeAttachmentInsertHook = null;
  I.__testHooks.afterAttachmentInsertHook = null;
  I.__testHooks.beforeSupersedeUpdateHook = null;
  I.__testHooks.onSysTxnRelease = null;
  I.__testHooks.beforeAttachmentResponseHook = null;
}
// [收口批5·M2] 失败出口统一：调用前拍快照（附件行数/时间线行数/最终目录文件数），失败后统一核对三者
// 均不变。snapshotBaseline 返回 {att,tl,dir}；assertNoResidue 支持两种调用形态——新形态
// `assertNoResidue(id, base, label)`（base=snapshotBaseline 的返回值）与旧形态
// `assertNoResidue(id, beforeAtt, beforeTl, beforeDir, label)`（兼容既有 4 处调用点，未强行改写）。
async function snapshotBaseline(issueId) {
  return { att: (await attRows(issueId)).length, tl: await timelineCount(issueId), dirNames: snapshotDirNames(issueId) };
}
// [尾批·M2] 文件出口从"目录项数量"改为"排序文件名清单逐项相等"（deepStrictEqual）——数量不变不足以
// 证明保留的是原文件（见 snapshotDirNames 处注释）。旧 4 参调用形态的第 4 参数随之改为文件名清单
// （由调用点改用 snapshotDirNames(id) 捕获，不再传 dirFileCount(id) 的数字）。
async function assertNoResidue(issueId, baseOrAtt, tlOrLabel, dirNamesOrLabel, label) {
  let att, tl, dirNames, lbl;
  if (baseOrAtt && typeof baseOrAtt === 'object' && 'att' in baseOrAtt) {
    ({ att, tl, dirNames } = baseOrAtt);
    lbl = tlOrLabel;
  } else {
    att = baseOrAtt; tl = tlOrLabel; dirNames = dirNamesOrLabel; lbl = label;
  }
  assert.strictEqual((await attRows(issueId)).length, att, `${lbl}：附件行应不变`);
  assert.strictEqual(await timelineCount(issueId), tl, `${lbl}：时间线行应不变`);
  assert.deepStrictEqual(snapshotDirNames(issueId), dirNames, `${lbl}：目录文件名清单应逐项不变（非仅数量），实得 ${JSON.stringify(snapshotDirNames(issueId))} 期望 ${JSON.stringify(dirNames)}`);
}

async function main() {
  // [返工批2·M5] 只清本脚本自己的 MY_UPLOAD_DIR（已带 process.pid，天然跨进程不冲突；这里仍先清一次
  // 保证同一 pid 内多次 main() 调用/异常重试不会累积残留），**不再** rmSync 共享目录（该目录本就已随
  // UPLOAD_DIR 覆盖收窄到本脚本独占，不会误删 verify-sys-attachments.js 等其它脚本正在使用的文件）。
  try { fs.rmSync(MY_UPLOAD_DIR, { recursive: true, force: true }); fs.mkdirSync(MY_UPLOAD_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  // [返工批3·594T-edge-case] directPersist 的模拟 multer 源文件曾放在系统临时目录（MY_UPLOAD_DIR 之外）——
  // targetFn 拒绝/第 1 或第 2 个 rename 失败时，未被移动的源文件既不进 movedPaths 也没有真实端点的
  // sysCleanupOrphanFiles 清理，最终只删 MY_UPLOAD_DIR 清不到它们。改为：源文件放本脚本独占的 DIRECT_SRC_DIR
  // 子目录，且每次调用后用 finally 精确清理"本次调用创建的这几个文件"（不管 persist 是否已经把它们 rename
  // 走——rename 走了 unlink 会 ENOENT 静默跳过，是精确清单式清理，不是整目录删）。声明位置放在 main() try
  // 块最前面（而非首次使用处），保证全文所有调用点（B8/H2 等在 M2 之前的用例）都能引用到。
  const DIRECT_SRC_DIR = path.join(MY_UPLOAD_DIR, '_direct-src');
  try { fs.mkdirSync(DIRECT_SRC_DIR, { recursive: true }); } catch (_) { /* best-effort */ }
  async function directPersist(id, files, type, opts) {
    const upFiles = files.map(name => ({
      filename: name, path: path.join(DIRECT_SRC_DIR, 'src-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)), originalname: name, size: 8, mimetype: 'image/png',
    }));
    for (const f of upFiles) fs.writeFileSync(f.path, png);
    try {
      return await I.sysPersistAttachments(id, upFiles, type, null, { id: 1, name: '管理员' }, opts);
    } finally {
      for (const f of upFiles) { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) { /* best-effort */ } }
    }
  }

  try {
    // ══════════════════════════════════════════════════════════════════
    // B1：三类型各一例（矩阵 #1 覆盖态，本脚本正向确认返回形态与留痕）
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      const beforeTl = await timelineCount(id);
      // [594TR-L1] 附件总数基线（非仅信最终 attId/最后一行时间线——额外插入非本次写入的行不会被下面几条
      // 断言察觉，须直接对总数做增量断言）。
      const beforeAttB1 = (await attRows(id)).length;
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'delivery-b1.png');
      assert.strictEqual(r.status, 200, `[B1-delivery] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // [返工批3·594T-LOW] 断一批恰增一行（非仅取最后一行——重复写行同样能通过"看最后一行"这种弱断言）。
      assert.strictEqual(await timelineCount(id), beforeTl + 1, '[B1-delivery] 时间线恰增一条');
      assert.strictEqual((await attRows(id)).length, beforeAttB1 + 1, `[594TR-L1][B1-delivery] 附件总数恰增一行，实得增量 ${(await attRows(id)).length - beforeAttB1}`);
      const attId = r.body.attachments[0].id;
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', '[B1-delivery] action_code=attachment_added');
      assert.strictEqual(tl.event_type, 'note', '[B1-delivery] event_type=note');
      assert.strictEqual(tl.ref_id, attId, '[B1-delivery] ref_id=首个 inserted id');
      assert.ok(tl.summary.startsWith('上传交付附件 1 个：'), `[B1-delivery] summary 类型词+计数前缀, got ${tl.summary}`);
      const payload = JSON.parse(tl.payload_json);
      // 完整 payload 快照深比较（非逐字段摘取判断），K1 根无 attachment_ids 隐含在快照里（缺该键即通过 deepStrictEqual）。
      assert.deepStrictEqual(payload, {
        attachments: [{ id: attId, original_name: 'delivery-b1.png', attachment_type: 'delivery' }],
        count: 1,
      }, `[B1-delivery] payload 完整快照深比较, got ${JSON.stringify(payload)}`);
      ok('[B1] delivery 上传：action_code/summary/payload 完整快照/ref_id 四件套核对通过，时间线恰增一条');
    }
    {
      // [收口批5·L1] 补精确增量（附件恰增 1 行 + 时间线恰增 1 行）+ attachments 快照深比较，不再只取最后一行。
      const id = await mkDevIssue();
      const baseB1s = await snapshotBaseline(id);
      const r = await upload(ATT(id), devTok, { attachment_type: 'screenshot' }, 'shot-b1.png');
      assert.strictEqual(r.status, 200, `[B1-screenshot] 应 200, got ${r.status}`);
      assert.strictEqual((await attRows(id)).length, baseB1s.att + 1, '[B1-screenshot] 附件恰增 1 行');
      assert.strictEqual(await timelineCount(id), baseB1s.tl + 1, '[B1-screenshot] 时间线恰增 1 行');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', '[B1-screenshot] action_code');
      assert.ok(tl.summary.startsWith('上传截图 1 个：'), `[B1-screenshot] summary 类型词, got ${tl.summary}`);
      const attId = r.body.attachments[0].id;
      assert.deepStrictEqual(JSON.parse(tl.payload_json), {
        attachments: [{ id: attId, original_name: 'shot-b1.png', attachment_type: 'screenshot' }],
        count: 1,
      }, `[B1-screenshot] payload 完整快照深比较, got ${tl.payload_json}`);
      ok('[B1] screenshot 上传：action_code/summary/payload 完整快照核对通过，附件恰增1行+时间线恰增1行');
    }
    {
      const id = await mkIssue('improvement', '开发中');
      const baseB1sp = await snapshotBaseline(id);
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'spec-b1.pdf');
      assert.strictEqual(r.status, 200, `[B1-spec] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual((await attRows(id)).length, baseB1sp.att + 1, '[B1-spec] 附件恰增 1 行');
      assert.strictEqual(await timelineCount(id), baseB1sp.tl + 1, '[B1-spec] 时间线恰增 1 行');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', '[B1-spec] action_code');
      assert.ok(tl.summary.startsWith('上传需求材料 1 个：'), `[B1-spec] summary 类型词, got ${tl.summary}`);
      assert.strictEqual(r.body.superseded, false, '[B1-spec] superseded=false（非替换）');
      const attIdSp = r.body.attachments[0].id;
      assert.deepStrictEqual(JSON.parse(tl.payload_json), {
        attachments: [{ id: attIdSp, original_name: 'spec-b1.pdf', attachment_type: 'spec' }],
        count: 1,
      }, `[B1-spec] payload 完整快照深比较, got ${tl.payload_json}`);
      ok('[B1] spec 上传：action_code/summary/superseded/payload 完整快照核对通过，附件恰增1行+时间线恰增1行');
    }
    // N=5 文件：列前 3 + 「 等 5 个」
    {
      const id = await mkDevIssue();
      const baseB1n5 = await snapshotBaseline(id);
      const files = [1, 2, 3, 4, 5].map(n => ({ name: `f${n}.png` }));
      const r = await uploadMulti(ATT(id), devTok, { attachment_type: 'delivery' }, files);
      assert.strictEqual(r.status, 200, `[B1-N5] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.attachments.length, 5, '[B1-N5] 5 个附件行');
      assert.strictEqual((await attRows(id)).length, baseB1n5.att + 5, '[B1-N5] 附件恰增 5 行');
      assert.strictEqual(await timelineCount(id), baseB1n5.tl + 1, '[B1-N5] 时间线恰增 1 行（一批一行，非每文件一行）');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.ok(tl.summary.includes('f1.png、f2.png、f3.png'), `[B1-N5] 前 3 个文件名, got ${tl.summary}`);
      assert.ok(tl.summary.includes(' 等 5 个'), `[B1-N5] 「等 5 个」尾注, got ${tl.summary}`);
      const payload = JSON.parse(tl.payload_json);
      assert.strictEqual(payload.count, 5, '[B1-N5] payload.count=5');
      // [收口批5·L1] attachments 快照深比较——非仅 count，逐条核对 id/original_name/attachment_type 是否与响应体一致。
      const expectedAttachments = r.body.attachments.map((a, i) => ({ id: a.id, original_name: `f${i + 1}.png`, attachment_type: 'delivery' }));
      assert.deepStrictEqual(payload.attachments, expectedAttachments, `[B1-N5] payload.attachments 完整快照深比较, got ${JSON.stringify(payload.attachments)}`);
      ok('[B1] N=5 文件：summary 列前 3 个 + 「等 5 个」，payload.count=5，attachments 完整快照深比较，附件恰增5行+时间线恰增1行');
    }

    // ══════════════════════════════════════════════════════════════════
    // M3：摘要截断边界（单名 60/61 码点；非 BMP 计 1；总长封顶 200）
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      // original_name 全串（含扩展名）参与 60 码点截断判据——用合法扩展名 .png（4 码点）+ 56 个 'a' 恰凑 60。
      const exact60 = 'a'.repeat(56) + '.png';
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, exact60);
      assert.strictEqual(r.status, 200, `[M3-60] 应 200, got ${r.status}`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.ok(tl.summary.includes(exact60), `[M3-60] 恰 60 码点文件名不截断, got ${tl.summary}`);
      assert.ok(!tl.summary.includes('…'), '[M3-60] 恰 60 不应出现省略号');
      ok('[M3] 单文件名恰 60 码点：不截断');
    }
    {
      const id = await mkDevIssue();
      const exact61 = 'b'.repeat(57) + '.png';   // 57+4=61 码点
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, exact61);
      assert.strictEqual(r.status, 200, `[M3-61] 应 200, got ${r.status}`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      const expected = Array.from(exact61).slice(0, 60).join('') + '…';   // 前 60 码点 + 省略号
      assert.ok(tl.summary.includes(expected), `[M3-61] 61 码点应截断为前 60+省略号, got ${tl.summary}`);
      assert.ok(!tl.summary.includes(exact61), '[M3-61] 不应出现完整 61 码点原名');
      ok('[M3] 单文件名 61 码点：截断为前 60 + 省略号');
    }
    {
      // 非 BMP（emoji 代理对）计 1 码点：57 个 emoji + ".png"（=61 码点）→ 按码点截前 60（不是按 UTF-16
      // code unit 截半个代理对）——57 个 emoji 全部保留 + ".pn" 前 3 字符 + 省略号。
      const id = await mkDevIssue();
      const emoji61 = '\u{1F600}'.repeat(57) + '.png';
      assert.strictEqual(Array.from(emoji61).length, 61, '[M3-emoji 夹具自检] 原名恰 61 码点');
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, emoji61);
      assert.strictEqual(r.status, 200, `[M3-emoji] 应 200, got ${r.status}`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      const expected = Array.from(emoji61).slice(0, 60).join('') + '…';
      assert.ok(tl.summary.includes(expected), `[M3-emoji] 61 码点应按码点截前 60+省略号，not 劈开代理对, got ${tl.summary}`);
      assert.ok(!/�/.test(tl.summary), '[M3-emoji] 不应出现代理对断裂产生的乱码替换符');
      ok('[M3] 非 BMP 字符（emoji）按码点计数截断，不劈开代理对');
    }
    {
      // 总长封顶 200：5 个长文件名（各 61 码点截断后 61）+ replace 尾注，验证固定段/尾注不被截、总长≤200
      const id = await mkIssue('improvement', '开发中');
      const specUp = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'orig-spec.pdf');
      assert.strictEqual(specUp.status, 200, '[M3-cap] 夹具：首次 spec 上传应 200');
      const origId = specUp.body.attachments[0].id;
      const longNames = [1, 2, 3, 4, 5].map(n => ({ name: 'x'.repeat(56) + String(n) + '.pdf' }));   // 各恰 61 码点
      const r = await uploadMulti(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(origId) }, longNames);
      assert.strictEqual(r.status, 200, `[M3-cap] 替换上传应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.superseded, true, '[M3-cap] superseded=true');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_replaced', '[M3-cap] action_code=attachment_replaced');
      assert.ok(tl.summary.includes(`（旧附件 #${origId} 已作废）`), `[M3-cap] 替换尾注完整未被截断, got ${tl.summary}`);
      assert.ok(Array.from(tl.summary).length <= 200, `[M3-cap] 总长应封顶 200 码点，实得 ${Array.from(tl.summary).length}`);
      assert.ok(tl.summary.startsWith('替换需求材料 5 个：'), '[M3-cap] 固定段（前缀+类型词+计数）未被截断');
      ok('[M3] 5 长文件名 + 替换尾注同时满足：固定段/尾注不截 + 总长封顶 200 码点');
    }
    // ── M3 三值边界：199/200/201 码点（返工批4·独立模板手算预期串，不穷举搜索被测函数自身）─────────
    //   模板（方案 §3 M3）：fixedHead=`上传需求材料 ${N} 个：`，码点=10+len(String(N))；列表段最多 3 名
    //   用「、」连接；N>3 时补 ` 等 ${N} 个`，码点=5+len(String(N))；单名 ≤60 不截；
    //   avail = 200 − fixedHead 长度（added 无尾注）。预期串在本测试里用字符串拼接独立构造，不调被测函数。
    {
      assert.strictEqual(typeof I.sysBuildAttachSummary, 'function', '[M3-199/200/201 前置] _internals.sysBuildAttachSummary 已导出');
      const K = '甲';   // BMP 单码点汉字，Array.from 与 .length 对纯 BMP 字符串结果一致，避免代理对干扰
      // 199：N=4，名长 60/60/60/1（第 4 个文件内容不影响输出，只贡献"等 4 个"里的计数位）。
      {
        const rows = [K.repeat(60), K.repeat(60), K.repeat(60), K.repeat(1)].map((nm, i) => ({ id: i + 1, original_name: nm }));
        const expected = '上传需求材料 4 个：' + K.repeat(60) + '、' + K.repeat(60) + '、' + K.repeat(60) + ' 等 4 个';
        assert.strictEqual(Array.from(expected).length, 199, `[M3-199 前置自检] 独立构造的预期串本身应恰 199 码点，实得 ${Array.from(expected).length}`);
        const actual = I.sysBuildAttachSummary('attachment_added', 'spec', rows, null);
        assert.strictEqual(Array.from(actual).length, 199, `[M3-199] 实际输出应恰 199 码点，实得 ${Array.from(actual).length}`);
        assert.strictEqual(actual, expected, `[M3-199] 逐字相等，实得 ${actual}`);
        ok('[M3-199] 独立模板构造：N=4，名长 60/60/60/1 → 恰 199 码点，逐字匹配手算预期串');
      }
      // 200：N=10，名长 60/60/59/1×7。
      {
        const names = [K.repeat(60), K.repeat(60), K.repeat(59), ...Array.from({ length: 7 }, () => K.repeat(1))];
        const rows = names.map((nm, i) => ({ id: i + 1, original_name: nm }));
        const expected = '上传需求材料 10 个：' + K.repeat(60) + '、' + K.repeat(60) + '、' + K.repeat(59) + ' 等 10 个';
        assert.strictEqual(Array.from(expected).length, 200, `[M3-200 前置自检] 独立构造的预期串本身应恰 200 码点，实得 ${Array.from(expected).length}`);
        const actual = I.sysBuildAttachSummary('attachment_added', 'spec', rows, null);
        assert.strictEqual(Array.from(actual).length, 200, `[M3-200] 实际输出应恰 200 码点，实得 ${Array.from(actual).length}`);
        assert.strictEqual(actual, expected, `[M3-200] 逐字相等，实得 ${actual}`);
        ok('[M3-200] 独立模板构造：N=10，名长 60/60/59/1×7 → 恰 200 码点，逐字匹配手算预期串');
      }
      // 201（触发去尾）：N=10，名长 60/60/60/1×7——截断前概念长度 201>200，整文件去尾一个（第 3 个不出现）。
      {
        const names = [K.repeat(60), K.repeat(60), K.repeat(60), ...Array.from({ length: 7 }, () => K.repeat(1))];
        const rows = names.map((nm, i) => ({ id: i + 1, original_name: nm }));
        const expected = '上传需求材料 10 个：' + K.repeat(60) + '、' + K.repeat(60) + ' 等 10 个';
        assert.strictEqual(Array.from(expected).length, 140, `[M3-201 前置自检] 独立构造的预期串本身应恰 140 码点，实得 ${Array.from(expected).length}`);
        const actual = I.sysBuildAttachSummary('attachment_added', 'spec', rows, null);
        assert.strictEqual(Array.from(actual).length, 140, `[M3-201] 实际输出应恰 140 码点（截断前概念长度 201 已被去尾），实得 ${Array.from(actual).length}`);
        assert.strictEqual(actual, expected, `[M3-201] 逐字相等，实得 ${actual}`);
        assert.ok(actual.startsWith('上传需求材料 10 个：'), '[M3-201] 固定段完整');
        assert.strictEqual((actual.match(new RegExp(K.repeat(60), 'g')) || []).length, 2, '[M3-201] 恰保留 2 个 60 连字（第 3 个文件已被整文件去尾，不出现）');
        ok('[M3-201] 独立模板构造：N=10，名长 60/60/60/1×7（截断前概念长度 201）→ 整文件去尾到恰 140 码点，第三个文件名不出现，逐字匹配手算预期串');
      }
      // replaced 一例：验证尾注永不截——N=5 名长 60×5，supersedeId=123456。
      // [返工批4·如实登记差异] 协调人给的手算里"尾注 16 码点/avail 173"与本脚本用 Array.from 精确复核的
      // 结果不同：`（旧附件 #123456 已作废）` 实测 17 码点（fixedHead 11 + 尾注 17 = 28，avail=200-28=172，
      // 非 27/173）。按指示"以模板逐字重算，不改被测函数迁就"——但两种算法在本例的最终结果**恰好一致**
      // （无论 avail 是 172 还是 173，去尾到 2 个文件后的 127 码点列表段都能放进去，判定分支不受影响），
      // 故预期串与协调人给出的字面串相同，仅这里如实记录 avail/尾注计算口径的差异，不代表被测函数有问题。
      {
        const bigSupersedeId = 123456;
        const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, original_name: K.repeat(60) }));
        const suffix = `（旧附件 #${bigSupersedeId} 已作废）`;
        assert.strictEqual(Array.from(suffix).length, 17, `[M3-replaced 前置自检] 尾注实测应 17 码点（非协调人手算的 16），实得 ${Array.from(suffix).length}`);
        const expected = '替换需求材料 5 个：' + K.repeat(60) + '、' + K.repeat(60) + ' 等 5 个' + suffix;
        assert.strictEqual(Array.from(expected).length, 155, `[M3-replaced 前置自检] 独立构造的预期串本身应恰 155 码点（11 固定段+127 列表段+17 尾注），实得 ${Array.from(expected).length}`);
        const actual = I.sysBuildAttachSummary('attachment_replaced', 'spec', rows, bigSupersedeId);
        assert.strictEqual(actual, expected, `[M3-replaced] 逐字相等（验证尾注永不截），实得 ${actual}`);
        assert.ok(actual.endsWith(suffix), '[M3-replaced] 替换尾注完整保留在结尾未被截断');
        ok('[M3-replaced] 独立模板构造：N=5 名长 60×5 + supersedeId=123456 → 尾注永不截，逐字匹配手算预期串（155 码点；如实记录尾注 17≠协调人给的 16，见上方注释）');
      }
    }
    // ── 真实 spec 上传 e2e：构造恰好命中 200 码点总长的文件名，走完整 HTTP 路径核对 ─────────────────
    {
      const attachmentType = 'spec', actionCode = 'attachment_added';
      function nameOfDisplayLenReal(displayLen) {
        if (displayLen === 61) return 'z'.repeat(60) + '.pdf';
        return 'z'.repeat(displayLen - 4) + '.pdf';
      }
      // [收口批5·L2] 措辞订正：本例是真实 HTTP 端到端集成补充（构造方式沿用"前 2 个文件名截断上限 61、
      // 第 3 个变长细调"这一套穷举），不是独立预期串验证——独立预期串的精确验证已由上方 M3-199/200/201/
      // replaced 四例用手算模板完成（不调用被测函数生成输入）；本例只负责证明真实 multer/HTTP 路径下也能
      // 落库出同样长度的 summary。multer 单请求最多 5 个文件（sysUpload.array('files',5)），故 N 只能 3..5。
      function searchExactLenReal(targetLen) {
        for (let n = 3; n <= 5; n++) {
          for (let varLen = 4; varLen <= 61; varLen++) {
            const names = [nameOfDisplayLenReal(61), nameOfDisplayLenReal(61), nameOfDisplayLenReal(varLen)];
            for (let i = 3; i < n; i++) names.push(nameOfDisplayLenReal(61));
            const rows = names.map((nm, i) => ({ id: i + 1, original_name: nm }));
            const s = I.sysBuildAttachSummary(actionCode, attachmentType, rows, undefined);
            if (Array.from(s).length === targetLen) return { n, names };
          }
        }
        return null;
      }
      const plan = searchExactLenReal(200);
      assert.ok(plan, '[M3-200-e2e 前置] 应能找到真实可上传（≤5 文件）的参数组合使 summary 恰 200 码点');
      const id = await mkIssue('improvement', '开发中');
      // multer 磁盘文件名 = `${ts}_${rand}_${safeOriginal}`（见 sysStorage.filename），同请求内多个文件
      // 用完全相同的 original_name（multipart filename）不会互相覆盖——ts+rand 前缀保证磁盘唯一，
      // 落库的 original_name 允许重复，与真实业务（同名不同文件多次上传）一致。
      const files = plan.names.map(nm => ({ name: nm }));
      const r = await uploadMulti(ATT(id), adminTok, { attachment_type: attachmentType }, files);
      assert.strictEqual(r.status, 200, `[M3-200-e2e] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(Array.from(tl.summary).length, 200, `[M3-200-e2e] 真实端点落库 summary 应恰 200 码点，实得 ${Array.from(tl.summary).length}：${tl.summary}`);
      assert.ok(tl.summary.startsWith(`上传需求材料 ${plan.n} 个：`), '[M3-200-e2e] 固定段完整');
      ok(`[M3-200-e2e] 真实 spec 上传端到端：${plan.n} 个文件（名长 ${plan.names.map(n => n.length).join('/')}）→ 落库 summary 恰 200 码点`);
    }

    // ══════════════════════════════════════════════════════════════════
    // B3 / B3′：替换成功一行 + 六种无效目标降级
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'old-spec.pdf');
      const oldId = up1.body.attachments[0].id;
      const beforeTl = await timelineCount(id);
      const up2 = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'new-spec.pdf');
      assert.strictEqual(up2.status, 200, `[B3] 替换应 200, got ${up2.status}`);
      assert.strictEqual(up2.body.superseded, true, '[B3] superseded=true');
      const rows = await attRows(id);
      const oldRow = rows.find(a => a.id === oldId);
      assert.strictEqual(oldRow.status, 'superseded', '[B3] 旧附件 status=superseded');
      const newRow = rows.find(a => a.id === up2.body.attachments[0].id);
      assert.strictEqual(newRow.status, 'active', '[B3] 新附件 active');
      assert.strictEqual(await timelineCount(id), beforeTl + 1, '[B3] 只增一行（不写 added，只写 replaced）');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_replaced', '[B3] action_code');
      const payload = JSON.parse(tl.payload_json);
      assert.strictEqual(payload.superseded_id, oldId, '[B3] payload.superseded_id=旧附件 id');
      // [返工批2·L2] K1 对 replaced 也要断（此前只在 added(delivery)/removed 两处断过，方案 K1 写的是
      // "三类 payload"）+ replaced 的 summary 完整模板（此前只断了 payload.superseded_id，没断文案本身）。
      assert.ok(!('attachment_ids' in payload), '[B3/K1] replaced 根对象无 attachment_ids');
      assert.strictEqual(payload.count, payload.attachments.length, '[B3] payload.count===attachments.length');
      assert.strictEqual(tl.summary, `替换需求材料 1 个：new-spec.pdf（旧附件 #${oldId} 已作废）`, `[B3] summary 逐字匹配替换模板, got ${tl.summary}`);
      ok('[B3] 替换成功：旧 superseded / 新 active / 只写一行 replaced / payload.superseded_id 正确 / K1 根无 attachment_ids / summary 逐字匹配模板');
    }
    // B3′ 六种无效目标 → 降级 added，superseded:false，全部 active
    async function b3primeCase(label, supersedeIdBuilder) {
      const id = await mkIssue('improvement', '开发中');
      const supersedeId = await supersedeIdBuilder(id);
      const before = await activeAttRows(id);
      const beforeAttTotal = (await attRows(id)).length;
      const beforeTl = await timelineCount(id);
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec', ...(supersedeId !== undefined ? { supersede_id: String(supersedeId) } : {}) }, `b3p-${label}.pdf`);
      assert.strictEqual(r.status, 200, `[B3′-${label}] 应 200（降级非拒绝）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.superseded, false, `[B3′-${label}] superseded=false`);
      // [收口批5·L1] 附件恰增一行（总行数，非仅 active 行数——若发生重复写入，active 计数可能因巧合仍对但
      // 总行数会多出来，这条断言能拦住这类"重复写入仍碰巧通过"的情况）。
      assert.strictEqual((await attRows(id)).length, beforeAttTotal + 1, `[B3′-${label}] 附件恰增一行`);
      // [返工批3·594T] 通用六类用例统一补：时间线恰增一条 added（非仅取最后一行看 action_code，防重复
      // 写行也能"看起来通过"）+ 新附件在 DB 中确实 active（非仅信响应体）。
      assert.strictEqual(await timelineCount(id), beforeTl + 1, `[B3′-${label}] 时间线恰增一条`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', `[B3′-${label}] action_code 降级为 attachment_added`);
      const newAttId = r.body.attachments[0].id;
      const newRow = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [newAttId]);
      assert.strictEqual(newRow.status, 'active', `[B3′-${label}] 新附件在 DB 中确实 active（非仅信响应体）`);
      const afterActive = await activeAttRows(id);
      for (const a of before) {
        assert.strictEqual(afterActive.some(x => x.id === a.id), true, `[B3′-${label}] 旧附件仍 active`);
      }
      ok(`[B3′] ${label}：降级为 added，superseded:false，全部附件仍 active，时间线恰增一条 added，新附件 DB 确实 active`);
    }
    await b3primeCase('不存在', async () => 999999);
    {
      // 跨单：额外核对被引用的「另一单」附件快照——只查当前单的旧附件不足以证明"跨单"这条隔离真的生效
      // （引用发生在另一张单上，那才是被真正牵涉进来的行）。
      let otherIssueId = null, otherAttId = null, otherSnapshotBefore = null;
      await b3primeCase('跨单', async () => {
        otherIssueId = await mkIssue('improvement', '开发中');
        const r = await upload(ATT(otherIssueId), adminTok, { attachment_type: 'spec' }, 'cross.pdf');
        otherAttId = r.body.attachments[0].id;
        otherSnapshotBefore = await get(`SELECT * FROM sys_issue_attachments WHERE id=?`, [otherAttId]);
        return otherAttId;
      });
      const otherSnapshotAfter = await get(`SELECT * FROM sys_issue_attachments WHERE id=?`, [otherAttId]);
      assert.deepStrictEqual(otherSnapshotAfter, otherSnapshotBefore, '[B3′-跨单] 被引用的另一单附件整行快照不变（跨单隔离生效，非只查当前单未受影响）');
      ok('[B3′-跨单补充] 被引用的另一单附件整行快照核对：跨单 supersede_id 未影响到另一张单据的附件行');
    }
    await b3primeCase('非spec', async (id) => {
      const r = await upload(ATT(id), adminTok, { attachment_type: 'delivery' }, 'notspec.png');   // admin 恒为协调人，绕开在册门
      assert.strictEqual(r.status, 200, `[B3′-非spec 夹具] delivery 上传应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.attachments[0].id;
    });
    await b3primeCase('已superseded', async (id) => {
      const r1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'first.pdf');
      const firstId = r1.body.attachments[0].id;
      await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(firstId) }, 'second.pdf');
      return firstId;   // 已是 superseded 态
    });
    await b3primeCase('参数非法', async () => 'not-a-number');
    // [返工批2·M4] "=本批新 id"：首个/后续新 id 各一（C0 §2.3 13b 原文要求两例，原实作只有首个）——targetFn
    // 在 INSERT 前查询，本批新 id 此刻尚不存在于表中，天然 target:null。出口层补齐 DB 断言（action_code=
    // attachment_added + 本批全部 active），不再只靠与实现耦合的 superseded===false 间接推断。
    async function r2_1Case(label, supersedeIdOffset) {
      const id = await mkIssue('improvement', '开发中');
      const beforeTlR21 = await timelineCount(id);
      let hookCalled = false;
      I.__testHooks.beforeSupersedeUpdateHook = async () => { hookCalled = true; };
      // 预估本批首个新 id：查当前 sqlite_sequence（若无该表历史记录直接用 count+1 近似，仅用于构造"等于本批新 id"场景）
      const seqRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_issue_attachments'`);
      const nextId = (seqRow ? seqRow.seq : 0) + 1 + supersedeIdOffset;   // 首个用 offset=0，后续用 offset=1（本批第 2 个新 id）
      const files = [{ name: `r2-1-${label}-a.pdf` }, { name: `r2-1-${label}-b.pdf` }];
      const r2 = await uploadMulti(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(nextId) }, files);
      assert.strictEqual(r2.status, 200, `[B3′-R2-1-${label}] 应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      // [收口批5·L1] 时间线恰增一行且为 added（非仅取最后一行看 action_code）。
      assert.strictEqual(await timelineCount(id), beforeTlR21 + 1, `[B3′-R2-1-${label}] 时间线恰增一行`);
      assert.strictEqual(r2.body.superseded, false, `[B3′-R2-1-${label}] superseded=false（target 在 INSERT 前查询天然落空）`);
      assert.strictEqual(hookCalled, false, `[B3′-R2-1-${label}] beforeSupersedeUpdateHook 不应被调用（target=null 时 beforeTimeline 早返回）`);
      // 出口层断言（DB 行，非仅响应体）：写 attachment_added、本批全部 active、payload 无 superseded_id。
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', `[B3′-R2-1-${label}] 出口层：时间线行 action_code=attachment_added`);
      const payload = JSON.parse(tl.payload_json);
      assert.ok(!('superseded_id' in payload), `[B3′-R2-1-${label}] 出口层：payload 无 superseded_id`);
      const rows = await activeAttRows(id);
      assert.strictEqual(rows.length, 2, `[B3′-R2-1-${label}] 出口层：本批 2 个附件行`);
      assert.ok(rows.every(a => a.status === 'active'), `[B3′-R2-1-${label}] 出口层：本批附件全部 active`);
      // [594TR-L1] 附件总数恰增二行（非仅信 active 数为二——额外插入非 active 附件不会被上一条断言察觉，
      // 须直接对总数做精确断言）。
      const allRowsR21 = await attRows(id);
      assert.strictEqual(allRowsR21.length, 2, `[594TR-L1][B3′-R2-1-${label}] 附件总数恰增二行（非 active 口径），实得 ${allRowsR21.length}`);
      // [返工批3·594T] 断言 supersede_id 的预测值确实等于实际首个/第二个新附件 id（非仅"预测偏了也会因
      // 降级为普通不存在目标用例而照样绿"这种弱证据）——预测失准时本断言直接判红，而非静默退化。
      const expectedRow = label === '首个' ? rows[0] : rows[1];
      assert.strictEqual(nextId, expectedRow.id, `[B3′-R2-1-${label}] 预测的 supersede_id(${nextId}) 应等于实际${label}新附件 id(${expectedRow.id})`);
      clearHooks();
      ok(`[B3′] supersede_id=本批新 id（${label}）：查询发生在 INSERT 之前，天然落空 → 降级 added，条件 UPDATE 钩子未被调用，出口层（action_code/payload/DB active）核对通过`);
    }
    await r2_1Case('首个', 0);
    await r2_1Case('后续', 1);   // supersede_id = 本批第 2 个新 id（AUTOINCREMENT 预测 nextId+1）

    // ══════════════════════════════════════════════════════════════════
    // B8：授权/状态相关拒绝路径 + 预检后主单被删
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkIssue('improvement', '开发中');
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDirNames = snapshotDirNames(id);
      const r = await upload(ATT(id), devTok, { attachment_type: 'spec' }, 'noauth.pdf');
      assert.strictEqual(r.status, 403, `[B8-预检403] 非协调人上传 spec 应 403, got ${r.status}`);
      await assertNoResidue(id, beforeAtt, beforeTl, beforeDirNames, '[B8-预检403]');
      ok('[B8] 预检 403（非协调人上传 spec）：三件套零残留');
    }
    {
      // 换对接人：预检（isCoordinator，端点入口早算）仍为真（intake_liaison_id=13=liaisonTok），
      // 但在 persist 锁内 targetFn 执行前（beforeAttachmentInsertHook：BEGIN 后、targetFn 前）换对接人——
      // targetFn 内锁内重读 freshRow 应捕获，AUTH_CHANGED。
      const id = await mkIssue('improvement', '开发中');   // mkIssue 默认 intake_liaison_id=13
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDirNames = snapshotDirNames(id);
      I.__testHooks.beforeAttachmentInsertHook = async () => { await run(`UPDATE sys_issues SET intake_liaison_id=999 WHERE id=?`, [id]); };
      const r = await upload(ATT(id), liaisonTok, { attachment_type: 'spec' }, 'stale-liaison.pdf');
      clearHooks();
      assert.strictEqual(r.status, 409, `[B8-换对接人] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'AUTH_CHANGED_FOR_ATTACHMENT', '[B8-换对接人] 错误码 AUTH_CHANGED_FOR_ATTACHMENT');
      assert.strictEqual(r.body.error, '权限已变更，请刷新', '[B8-换对接人] 中文文案');
      await assertNoResidue(id, beforeAtt, beforeTl, beforeDirNames, '[B8-换对接人]');
      ok('[B8] 换对接人：targetFn 走到 AUTH_CHANGED，409 AUTH_CHANGED_FOR_ATTACHMENT + 三件套零残留');
    }
    {
      // 主单预检后被删：admin 一例（dirOf(id) 只按数字目录名解析，与 DB 行是否存在无关，主单删除后仍可测）
      const id = await mkIssue('improvement', '开发中');
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDir = dirFileCount(id);
      // targetFn 内重读会 !freshRow → ISSUE_MISSING；用钩子在 targetFn 之前（beforeAttachmentInsertHook：BEGIN 后、targetFn 前）删主单
      I.__testHooks.beforeAttachmentInsertHook = async () => { await run(`DELETE FROM sys_issues WHERE id=?`, [id]); };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'deleted-mid.pdf');
      clearHooks();
      assert.strictEqual(r.status, 409, `[B8-预检后删单-admin] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT', '[B8-预检后删单-admin] 错误码');
      assert.strictEqual((await attRows(id)).length, beforeAtt, '[B8-预检后删单-admin] 附件行不变（0 增量）');
      assert.strictEqual(await timelineCount(id), beforeTl, '[B8-预检后删单-admin] 时间线未增行（0 增量）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[B8-预检后删单-admin] 目录文件数不变（已 rename 的文件被回滚补偿 unlink）');
      ok('[B8] 预检后主单被 admin 场景删除：targetFn 命中 ISSUE_MISSING → 409 + 附件行 0 + 时间线 0 + 文件 0（三件套）');
    }
    {
      // [返工批1·补做2] 主单预检后被删：对接人（liaison token）一例——同构断言（409 INVALID_STATE_FOR_ATTACHMENT
      // + 附件行 0 + 时间线 0 + 文件 0）。liaison 预检（isCoordinator）通过靠 intake_liaison_id=13=liaisonTok，
      // 与 admin 例走的是不同的预检分支（isBoundLiaisonEligibleOrAdmin 非 admin 旁路），须单独验证。
      const id = await mkIssue('improvement', '开发中');   // mkIssue 默认 intake_liaison_id=13
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDir = dirFileCount(id);
      I.__testHooks.beforeAttachmentInsertHook = async () => { await run(`DELETE FROM sys_issues WHERE id=?`, [id]); };
      const r = await upload(ATT(id), liaisonTok, { attachment_type: 'spec' }, 'deleted-mid-liaison.pdf');
      clearHooks();
      assert.strictEqual(r.status, 409, `[B8-预检后删单-liaison] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT', '[B8-预检后删单-liaison] 错误码');
      assert.strictEqual((await attRows(id)).length, beforeAtt, '[B8-预检后删单-liaison] 附件行不变（0 增量）');
      assert.strictEqual(await timelineCount(id), beforeTl, '[B8-预检后删单-liaison] 时间线未增行（0 增量）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[B8-预检后删单-liaison] 目录文件数不变');
      ok('[B8] 预检后主单被删（对接人 liaison 场景）：targetFn 命中 ISSUE_MISSING → 409 + 附件行 0 + 时间线 0 + 文件 0（三件套）');
    }
    {
      // spec 二次核有效用例（矩阵 #11）：targetFn 通过、INSERT/rename 已发生，afterAttachmentInsertHook 撤资格 → recheckFn 拒
      const id = await mkIssue('improvement', '开发中');
      let insertedCountSeenByHook = -1, filesSeenByHook = -1;
      I.__testHooks.afterAttachmentInsertHook = async () => {
        const row = await get(`SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=? AND status='active'`, [id]);
        insertedCountSeenByHook = row.c;
        filesSeenByHook = dirFileCount(id);
        await run(`UPDATE sys_issues SET intake_liaison_id=999 WHERE id=?`, [id]);   // 撤资格（对接人换人）
      };
      const beforeTl = await timelineCount(id);
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'second-check.pdf');
      clearHooks();
      // admin 恒为协调人（不受 intake_liaison_id 影响），故本用例须用 liaisonTok 才能验证"换对接人"生效——admin 旁路。
      // 用 admin 上传时 recheckFn 复用同一资格函数，admin 分支恒 true，不会被撤资格影响，故本例改验证：
      // INSERT/rename 已发生（钩子内证据）+ 最终成功（因 admin 不受影响）——afterAttachmentInsertHook 位置正确性
      // 的证据在于 insertedCountSeenByHook/filesSeenByHook 已 > 0（rename/INSERT 已执行）。
      assert.ok(insertedCountSeenByHook >= 1, '[B8-二次核] afterAttachmentInsertHook 触发时附件行已插入（INSERT 已发生）');
      assert.ok(filesSeenByHook >= 1, '[B8-二次核] afterAttachmentInsertHook 触发时文件已 rename 落盘');
      assert.strictEqual(r.status, 200, `[B8-二次核] admin 不受换对接人影响仍应 200, got ${r.status}`);
      assert.strictEqual(await timelineCount(id), beforeTl + 1, '[B8-二次核] 正常写入一行');
      ok('[B8] afterAttachmentInsertHook 位置证据：钩子触发时 INSERT/rename 已完成（非 targetFn 前的空事务），admin 分支不受换对接人影响仍 200');
    }
    {
      // [收口批5·M1] 用 liaisonTok（非 admin）验证真正的"二次核拒绝"路径：targetFn 通过后撤资格 →
      // recheckFn 拒 → 回滚。自己的 afterAttachmentInsertHook 先记录附件行数与文件数（断各为 1，证明
      // INSERT/rename 确已发生），再撤资格——不借用相邻 admin 例的证据。
      const id = await mkIssue('improvement', '开发中');
      const beforeDir = dirFileCount(id);
      let attCountSeenByHook = -1, fileCountSeenByHook = -1;
      I.__testHooks.afterAttachmentInsertHook = async () => {
        attCountSeenByHook = (await get(`SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=? AND status='active'`, [id])).c;
        fileCountSeenByHook = dirFileCount(id);
        await run(`UPDATE sys_issues SET intake_liaison_id=999 WHERE id=?`, [id]);
      };
      const r = await upload(ATT(id), liaisonTok, { attachment_type: 'spec' }, 'liaison-revoked.pdf');
      clearHooks();
      assert.strictEqual(attCountSeenByHook, 1, '[B8-liaison二次核] 钩子内附件行数应为 1（本单唯一一个附件行，INSERT 确已发生）');
      assert.strictEqual(fileCountSeenByHook, 1, '[B8-liaison二次核] 钩子内目录文件数应为 1（rename 确已发生）');
      assert.strictEqual(r.status, 409, `[B8-liaison二次核] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'AUTH_CHANGED_FOR_ATTACHMENT', `[B8-liaison二次核] 应 AUTH_CHANGED_FOR_ATTACHMENT, got ${r.body.code}`);
      assert.strictEqual((await attRows(id)).length, 0, '[B8-liaison二次核] 附件行 0（同事务回滚）');
      assert.strictEqual(await timelineCount(id), 0, '[B8-liaison二次核] 时间线行 0');
      assert.strictEqual(dirFileCount(id), beforeDir, '[B8-liaison二次核] 目录文件数不变（补偿 unlink 已执行）');
      ok('[B8] liaison 二次核真正拒绝路径：钩子内自证 INSERT/rename 已发生（行数1/文件数1）→ 撤资格 → recheckFn 拒 → 409 AUTH_CHANGED_FOR_ATTACHMENT + 附件/时间线/文件零增量');
    }
    // ── [返工批3·H1] 矩阵 #4「预检通过后锁内终态」：预检（isCoordinator 早算）通过，但钩子在 targetFn
    // 前把主单翻终态 → targetFn 内锁内重读命中 TERMINAL → 409 INVALID_STATE_FOR_ATTACHMENT + 三件套零增量。
    {
      const id = await mkIssue('improvement', '开发中');
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDirNames = snapshotDirNames(id);
      I.__testHooks.beforeAttachmentInsertHook = async () => { await run(`UPDATE sys_issues SET status='已作废' WHERE id=?`, [id]); };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'terminal-mid.pdf');
      clearHooks();
      assert.strictEqual(r.status, 409, `[B8-矩阵4-锁内终态] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT', '[B8-矩阵4-锁内终态] 错误码');
      await assertNoResidue(id, beforeAtt, beforeTl, beforeDirNames, '[B8-矩阵4-锁内终态]');
      ok('[B8] 矩阵 #4：预检通过后、targetFn 前锁内把主单翻终态 → 409 INVALID_STATE_FOR_ATTACHMENT + 三件套零增量');
    }
    // ── [返工批3·H1] 矩阵 #6「绑定不变但资格撤销」：intake_liaison_id 不变（仍是 liaisonTok=13 本人绑定），
    // 但把 13 的 role 从候选 allowlist（'user'/'publisher'）撤出（改 'viewer'）——targetFn 内锁内重读
    // isBoundLiaisonEligibleOrAdmin 必须读到**最新**的 eligibility，而非预检时刻的旧值。isBoundLiaisonEligibleOrAdmin
    // 本身未导出 _internals，不做函数级包装计数；用行为证据代替：若 targetFn 用的是预检时刻的旧 eligibility
    // （缓存/未重查），本请求会 200（因为预检发生在钩子改 role 之前，那时仍 eligible）——实际得到 409
    // AUTH_CHANGED_FOR_ATTACHMENT 本身就证明了锁内确实重新读取了资格状态（fail-loud：若未来实现改成读缓存，
    // 本用例会从红变绿失去判别力这件事不成立——会从"本该 409"变成"实际 200"直接判红）。
    {
      // [收口批5·M1] 加 afterAttachmentInsertHook 命中标记并断为 false——证明拒绝确实发生在 INSERT 之前
      // （即 targetFn 阶段），而不是让 recheckFn（INSERT 之后才跑）先读到新资格再拒。若拒绝其实发生在
      // recheckFn（比如 targetFn 用了缓存/预检旧值放行），afterAttachmentInsertHook 会被调用到，本断言
      // 判红。另加 intake_liaison_id 前后不变的核对，坐实"绑定确实没变、只有资格变了"这一前提。
      const id = await mkIssue('improvement', '开发中');   // mkIssue 默认 intake_liaison_id=13（绑定不变）
      const beforeAtt = (await attRows(id)).length, beforeTl = await timelineCount(id), beforeDirNames = snapshotDirNames(id);
      const roleBefore = await get(`SELECT role FROM users WHERE id=13`);
      assert.strictEqual(roleBefore.role, 'user', '[B8-矩阵6 前置] liaisonTok(13) 初始 role=user（在候选 allowlist 内）');
      const liaisonIdBefore = (await get(`SELECT intake_liaison_id FROM sys_issues WHERE id=?`, [id])).intake_liaison_id;
      let afterInsertHookCalled = false;
      I.__testHooks.beforeAttachmentInsertHook = async () => { await run(`UPDATE users SET role='viewer' WHERE id=13`); };   // 绑定不动，只撤资格
      I.__testHooks.afterAttachmentInsertHook = async () => { afterInsertHookCalled = true; };
      const r = await upload(ATT(id), liaisonTok, { attachment_type: 'spec' }, 'eligibility-revoked.pdf');
      clearHooks();
      await run(`UPDATE users SET role='user' WHERE id=13`);   // 复原，避免污染后续用例
      assert.strictEqual(afterInsertHookCalled, false, '[B8-矩阵6-资格撤销] afterAttachmentInsertHook（INSERT 之后才会触发）不应被调用——证明拒绝发生在 targetFn 阶段（INSERT 之前），非 recheckFn 阶段');
      const liaisonIdAfter = (await get(`SELECT intake_liaison_id FROM sys_issues WHERE id=?`, [id])).intake_liaison_id;
      assert.strictEqual(liaisonIdAfter, liaisonIdBefore, '[B8-矩阵6-资格撤销] intake_liaison_id 绑定前后不变（只撤资格，不换绑定人）');
      assert.strictEqual(r.status, 409, `[B8-矩阵6-资格撤销] 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'AUTH_CHANGED_FOR_ATTACHMENT', `[B8-矩阵6-资格撤销] 绑定未变但资格撤销应判 AUTH_CHANGED（而非放行），实得 code=${r.body.code}`);
      await assertNoResidue(id, beforeAtt, beforeTl, beforeDirNames, '[B8-矩阵6-资格撤销]');
      ok('[B8] 矩阵 #6：intake_liaison_id 绑定前后不变、仅撤销 role 候选资格 → afterAttachmentInsertHook 零命中（证明拒绝发生在 targetFn/INSERT 之前而非 recheckFn）→ 409 AUTH_CHANGED_FOR_ATTACHMENT + 三件套零增量');
    }
    // ── [返工批3·H2] 矩阵 #10：拦截 sys_issue_attachments 第 2 次 INSERT 抛错——两文件均已 rename、首条已
    // 插入后失败，验证完整回滚补偿：原错误传出、附件/时间线零增量、两个已移动文件均被删除、旧替换目标不变。
    {
      const id = await mkIssue('improvement', '开发中');
      const up0 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'matrix10-old-target.pdf');
      const oldTargetId = up0.body.attachments[0].id;
      const beforeDir = dirFileCount(id);
      // [尾批·M2] 文件身份断言前置：旧目标真实磁盘相对路径（multer 随机化文件名，不能假定字面量），
      // 用于后面区分"数量不变"与"确实是原文件、本批新文件确未残留"。
      const oldTargetFileName = path.basename((await get(`SELECT file_name FROM sys_issue_attachments WHERE id=?`, [oldTargetId])).file_name);
      const oldTargetAbsPath = path.join(dirOf(id), oldTargetFileName);
      assert.ok(fs.existsSync(oldTargetAbsPath), `[H2-矩阵10 前置] 旧目标文件应先存在于磁盘: ${oldTargetAbsPath}`);
      const origDbRun = db.run.bind(db);
      let insertCount = 0;
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.includes('INSERT INTO sys_issue_attachments')) {
          insertCount++;
          if (insertCount === 2) return cb ? cb(new Error('注入：第 2 次 sys_issue_attachments INSERT 失败')) : undefined;
        }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try {
        await directPersist(id, ['matrix10-a.png', 'matrix10-b.png'], 'spec', {
          targetFn: async () => ({ ok: true, target: { id: oldTargetId } }),
          beforeTimeline: async (inserted, target) => {
            const sup = await run(`UPDATE sys_issue_attachments SET status='superseded' WHERE id=? AND status='active' AND id NOT IN (${inserted.map(a => a.id).join(',') || 'NULL'})`, [target.id]);
            return { ok: true, superseded: sup.changes === 1 };
          },
          timeline: { intent: 'replace' },
        });
      } catch (e) { threw = e; }
      db.run = origDbRun;
      assert.strictEqual(insertCount, 2, `[H2-矩阵10] 应命中第 2 次 sys_issue_attachments INSERT（计数证据），实得 ${insertCount}`);
      assert.ok(threw && /第 2 次 sys_issue_attachments INSERT 失败/.test(threw.message), `[H2-矩阵10] 原始注入错误应原样传出, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 1, '[H2-矩阵10] 附件行零增量（只剩夹具的 old-target 1 行，本批两个新行已回滚）');
      assert.strictEqual(await timelineCount(id), 1, '[H2-矩阵10] 时间线行零增量（只剩夹具上传自身写的 1 行）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[H2-矩阵10] 目录文件数不变（两个已移动文件均被补偿删除）');
      // [尾批·M2] 文件身份断言：数量不变不足以证明"保留的是原文件、删除的是本批文件"——逐项核对。
      assert.ok(fs.existsSync(oldTargetAbsPath), `[H2-矩阵10] 旧目标文件身份核对：文件仍应存在于原路径 ${oldTargetAbsPath}`);
      assert.strictEqual(fs.existsSync(path.join(dirOf(id), 'matrix10-a.png')), false, '[H2-矩阵10] 本批文件身份核对：matrix10-a.png 应不存在（已被补偿删除，非被误留）');
      assert.strictEqual(fs.existsSync(path.join(dirOf(id), 'matrix10-b.png')), false, '[H2-矩阵10] 本批文件身份核对：matrix10-b.png 应不存在（已被补偿删除，非被误留）');
      // [收口批5·L2] 措辞订正：第 2 次 INSERT 失败发生在 rename+INSERT 循环内部，早于 recheckFn/beforeTimeline，
      // 所以 beforeTimeline 的条件 UPDATE **根本没机会执行**——本例证明的是"旧目标从未被动过"，不是
      // "UPDATE 执行后又被回滚撤销"（那个更强的场景由 11d 用例覆盖：UPDATE 确已执行、之后业务拒绝仍整体回滚）。
      const oldTargetRow = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [oldTargetId]);
      assert.strictEqual(oldTargetRow.status, 'active', '[H2-矩阵10] 旧替换目标状态不变（beforeTimeline 尚未执行到，UPDATE 从未发生，非"执行后被回滚"）');
      ok('[H2] 矩阵 #10：拦截第 2 次 sys_issue_attachments INSERT 抛错 → 原错误传出 + 附件/时间线零增量 + 两个已移动文件均删除（文件身份逐项核对：旧目标仍存在、本批两个新路径逐个不存在）+ 旧替换目标状态不变');
    }
    // ── [返工批1·补做3] 回调抛错 e2e 两例：spec 真实端点，afterAttachmentInsertHook 抛错 ──────────
    {
      // (a) 普通 Error → 端点 catch 落非 SysTransitionError 分支 → 500，body.error 含原始异常信息
      const id = await mkIssue('improvement', '开发中');
      const beforeDir = dirFileCount(id);
      const beforeTlPlain = await timelineCount(id);
      I.__testHooks.afterAttachmentInsertHook = async () => { throw new Error('boom'); };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'e2e-throw-plain.pdf');
      clearHooks();
      assert.strictEqual(r.status, 500, `[e2e抛错-plain] 应 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body && typeof r.body.error === 'string' && r.body.error.includes('boom'), `[e2e抛错-plain] body.error 应含 boom, got ${JSON.stringify(r.body)}`);
      assert.strictEqual((await attRows(id)).length, 0, '[e2e抛错-plain] 附件行 0（回滚）');
      // [尾批·L] 补时间线零增量——afterAttachmentInsertHook 抛错发生在 beforeTimeline/INSERT INTO
      // sys_issue_timeline 之前，整体回滚不应留下任何时间线行。
      assert.strictEqual(await timelineCount(id), beforeTlPlain, '[e2e抛错-plain] 时间线零增量（整体回滚）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[e2e抛错-plain] 目录文件数不变（补偿 unlink）');
      ok('[e2e抛错] afterAttachmentInsertHook 抛普通 Error → 500，body.error 含原始异常信息，附件/时间线/文件三件套零增量');
    }
    {
      // (b) SysTransitionError(503,'SYS_BUSY') → 端点 catch 走 e instanceof SysTransitionError 分支 → 503 SYS_BUSY
      assert.strictEqual(typeof I.SysTransitionError, 'function', '[e2e抛错-503 前置] _internals.SysTransitionError 已导出');
      const id = await mkIssue('improvement', '开发中');
      const beforeDir = dirFileCount(id);
      const beforeTl503 = await timelineCount(id);
      I.__testHooks.afterAttachmentInsertHook = async () => { throw new I.SysTransitionError(503, 'SYS_BUSY', 'x'); };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'e2e-throw-503.pdf');
      clearHooks();
      assert.strictEqual(r.status, 503, `[e2e抛错-503] 应 503, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SYS_BUSY', `[e2e抛错-503] code 应 SYS_BUSY, got ${JSON.stringify(r.body)}`);
      assert.strictEqual((await attRows(id)).length, 0, '[e2e抛错-503] 附件行 0（回滚）');
      assert.strictEqual(await timelineCount(id), beforeTl503, '[e2e抛错-503] 时间线零增量（整体回滚）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[e2e抛错-503] 目录文件数不变');
      ok('[e2e抛错] afterAttachmentInsertHook 抛 SysTransitionError(503,SYS_BUSY) → 503 code SYS_BUSY，附件/时间线/文件三件套零增量');
    }

    // ══════════════════════════════════════════════════════════════════
    // M2：回调返回协议契约违反 → 500 PERSIST_CALLBACK_CONTRACT + 回滚
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try {
        await directPersist(id, ['x1.png'], 'delivery', { beforeTimeline: async () => ({ ok: true }) });   // 缺 superseded
      } catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[M2-缺superseded] 应抛 PERSIST_CALLBACK_CONTRACT, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[M2-缺superseded]');
      ok('[M2] beforeTimeline 漏 superseded → 抛出契约错误 PERSIST_CALLBACK_CONTRACT + 回滚（三件套零增量）');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try {
        await directPersist(id, ['x2.png'], 'delivery', { beforeTimeline: async () => ({ ok: true, superseded: true }), timeline: { intent: 'add' } });
      } catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[M2-superseded违intent] 应抛契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[M2-superseded违intent]');
      ok('[M2] superseded=true 但 intent=add → 抛出契约错误 PERSIST_CALLBACK_CONTRACT（三件套零增量）');
    }
    {
      // [返工批3·594T-M2 订正] 原用例的 targetFn 恒返回 target:null，insertedIdCapture 从未真正参与构造
      // target——codex 594T 指出：即便删掉 `insertedIds.includes(target.id)` 这条检查，本用例仍会因为
      // target 为空这另一条契约（superseded=true 但 target 为空）而红，判别不到"target.id ∈ inserted"
      // 这条独立检查。改为：用 sqlite_sequence 预测本批第 1 个新 id（同 R2-1 范式），targetFn 直接返回
      // 这个预测 id 作为非空合法 target；beforeTimeline 内先断言 `inserted[0].id === 预测值`（证明目标确实
      // 等于本批插入 id，非巧合），再返回 superseded:true 触发违约。
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      const seqRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_issue_attachments'`);
      const predictedId = (seqRow ? seqRow.seq : 0) + 1;
      let equalityChecked = false;
      let threw = null;
      try {
        await directPersist(id, ['x3.png'], 'delivery', {
          targetFn: async () => ({ ok: true, target: { id: predictedId } }),
          beforeTimeline: async (inserted) => {
            assert.strictEqual(inserted[0].id, predictedId, '[M2-target∈inserted 前置] 目标 id 确实等于本批实际插入 id（非巧合构造）');
            equalityChecked = true;
            return { ok: true, superseded: true };
          },
          timeline: { intent: 'replace' },
        });
      } catch (e) { threw = e; }
      assert.strictEqual(equalityChecked, true, '[M2-target∈inserted] beforeTimeline 确实执行到相等性前置断言');
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[M2-target∈inserted] target.id 等于本批插入 id 却声称 superseded=true 应抛契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[M2-target∈inserted]');
      ok('[M2] target.id 真实等于本批 inserted 的 id（先断相等）却声称 superseded=true → 抛出契约错误 PERSIST_CALLBACK_CONTRACT + 完整回滚（三件套零增量）');
    }
    {
      // 空目标另留一例（target 为空但声称 superseded=true 违约，与上例"target 非空但属于本批"是两条独立的契约分支）。
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try {
        await directPersist(id, ['x3b.png'], 'delivery', {
          targetFn: async () => ({ ok: true, target: null }),
          beforeTimeline: async () => ({ ok: true, superseded: true }),
          timeline: { intent: 'replace' },
        });
      } catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[M2-target为空却superseded] 应抛契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[M2-target为空却superseded]');
      ok('[M2] target 为空但声称 superseded=true → 抛出契约错误 PERSIST_CALLBACK_CONTRACT + 完整回滚（与上例分属独立契约分支，三件套零增量）');
    }
    // ── [返工批3·codex594-A] targetFn 成功时 target 只认 null；undefined/缺键须判契约错误（三例）───
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['594a-1.png'], 'delivery', { targetFn: async () => ({ ok: true }) }); }   // 缺 target 键 → undefined
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[594-A] targetFn 返回 {ok:true}（缺 target 键）应契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[594-A-缺target键]');
      ok('[594-A] targetFn 返回 {ok:true}（缺 target 键，等价 undefined）→ 抛出契约错误 PERSIST_CALLBACK_CONTRACT + 回滚三件套');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['594a-2.png'], 'delivery', { targetFn: async () => ({ ok: true, target: undefined }) }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[594-A] targetFn 返回 {ok:true,target:undefined} 应契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[594-A-target undefined]');
      ok('[594-A] targetFn 返回 {ok:true,target:undefined} 显式 → 抛出契约错误 PERSIST_CALLBACK_CONTRACT + 回滚三件套');
    }
    {
      // 正例：显式 target:null 仍是合法的"无目标"，应正常写 added。
      const id = await mkDevIssue();
      const r = await directPersist(id, ['594a-3.png'], 'delivery', { targetFn: async () => ({ ok: true, target: null }) });
      assert.strictEqual(r.aborted, false, '[594-A 正例] target:null 应正常成功');
      assert.strictEqual(r.actionCode, 'attachment_added', '[594-A 正例] actionCode=attachment_added');
      ok('[594-A] targetFn 显式返回 {ok:true,target:null} → 正常成功，写 added（null 是唯一合法的"无目标"）');
    }

    // ── 缺省回调路径两例 ────────────────────────────────────────────────
    {
      const id = await mkDevIssue();
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'default-cb.png');
      assert.strictEqual(r.status, 200, `[缺省-delivery] 应 200, got ${r.status}`);
      // [尾批·L 订正] delivery/screenshot 端点响应体本就不含 superseded 字段（只有 spec 端点回传该字段，
      // 见 index.js:15896 vs :15932）——不能对着一个契约上不存在的字段断言 false，改为断言"该字段确实
      // 不在响应体里"，坐实"delivery 天然无替换语义"这一前提，而非误判成 undefined!==false 的假红。
      assert.ok(!('superseded' in r.body), '[缺省-delivery] 响应体不含 superseded 字段（delivery 端点契约上无替换语义）');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', '[缺省-delivery] delivery 无 targetFn/beforeTimeline 仍写 added');
      ok('[缺省回调] delivery（无 targetFn/beforeTimeline）→ added（响应体不含 superseded 字段，契约上无替换语义）');
    }
    {
      const id = await mkDevIssue();
      const r = await directPersist(id, ['direct.png'], 'delivery', {});
      assert.strictEqual(r.aborted, false, '[缺省-直调] 不传任何回调应成功');
      assert.strictEqual(r.actionCode, 'attachment_added', '[缺省-直调] actionCode=attachment_added');
      // [尾批·L] 补 superseded===false + 落库出口（直调例非仅信返回对象，另核对 DB 中附件确实 active、
      // 时间线确实写入 added）。
      assert.strictEqual(r.superseded, false, '[缺省-直调] superseded=false');
      const newAttId = r.inserted[0].id;
      const newRow = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [newAttId]);
      assert.strictEqual(newRow.status, 'active', '[缺省-直调] 新附件落库出口：DB 中确实 active');
      const tlDirect = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tlDirect.action_code, 'attachment_added', '[缺省-直调] 时间线落库出口：action_code=attachment_added');
      ok('[缺省回调] _internals 直调不传回调 → added，superseded=false，落库出口（附件 active + 时间线 added）核对通过');
    }
    {
      // [返工批2·L3] files 为空 → persist 自身拒绝为业务拒绝 PersistAbort('NO_FILE')（真实 HTTP 路径不可达，
      // 两端点均已在调 persist 之前挡 400 NO_FILE；`_internals` 直调可达，见 index.js persist try 入口新增
      // 的 `if (!Array.isArray(files) || files.length===0) throw new PersistAbort('NO_FILE')`）。
      const id = await mkDevIssue();
      const r = await I.sysPersistAttachments(id, [], 'delivery', null, { id: 1, name: '管理员' }, {});
      assert.deepStrictEqual(r, { aborted: true, reason: 'NO_FILE', inserted: [], superseded: false }, `[L3] files 为空应业务拒绝 {aborted:true,reason:'NO_FILE'}，实得 ${JSON.stringify(r)}`);
      assert.strictEqual((await attRows(id)).length, 0, '[L3] 附件行 0');
      assert.strictEqual(await timelineCount(id), 0, '[L3] 时间线行 0');
      ok("[L3] _internals 直调 files=[] → persist 自身业务拒绝 {aborted:true,reason:'NO_FILE'}（不再依赖调用方总是先检查，规避 beforeTimeline 里 `id NOT IN (NULL)` 恒 UNKNOWN 的静默降级）");
    }

    // ── 回调抛错三例（非 SysTransitionError）→ 500，与业务拒绝 409 响应不同 ──────
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['thr1.png'], 'delivery', { targetFn: async () => { throw new Error('targetFn 内部异常'); } }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.message === 'targetFn 内部异常', '[抛错-targetFn] 原始异常应继续抛出（非包装成业务拒绝）');
      await assertNoResidue(id, base, '[抛错-targetFn]');
      ok('[抛错] targetFn 抛错 → 原样继续抛出指定异常（HTTP 状态映射由真实端点用例证明，非本例断言范围），非业务拒绝，三件套零增量');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['thr2.png'], 'delivery', { recheckFn: async () => { throw new Error('recheckFn 内部异常'); } }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.message === 'recheckFn 内部异常', '[抛错-recheckFn] 原始异常应继续抛出');
      await assertNoResidue(id, base, '[抛错-recheckFn]');
      ok('[抛错] recheckFn 抛错 → 原样继续抛，三件套零增量');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['thr3.png'], 'delivery', { beforeTimeline: async () => { throw new Error('beforeTimeline 内部异常'); } }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.message === 'beforeTimeline 内部异常', '[抛错-beforeTimeline] 原始异常应继续抛出');
      await assertNoResidue(id, base, '[抛错-beforeTimeline]');
      ok('[抛错] beforeTimeline 抛错 → 原样继续抛，三件套零增量');
    }

    // ── 回调非法协议三例 → 500 PERSIST_CALLBACK_CONTRACT ──────────────
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['bad1.png'], 'delivery', { targetFn: async () => undefined }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[非法协议-targetFn undefined] 应契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[非法协议-targetFn undefined]');
      ok('[非法协议] targetFn 返回 undefined → 抛出契约错误 PERSIST_CALLBACK_CONTRACT，三件套零增量');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['bad2.png'], 'delivery', { recheckFn: async () => ({}) }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[非法协议-recheckFn缺ok] 应契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[非法协议-recheckFn缺ok]');
      ok('[非法协议] recheckFn 返回 {}（缺布尔 ok）→ 抛出契约错误 PERSIST_CALLBACK_CONTRACT，三件套零增量');
    }
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      let threw = null;
      try { await directPersist(id, ['bad3.png'], 'delivery', { targetFn: async () => ({ ok: true, target: { id: 'x' } }) }); }
      catch (e) { threw = e; }
      assert.ok(threw && threw.code === 'PERSIST_CALLBACK_CONTRACT', `[非法协议-target非法] 应契约错误, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[非法协议-target非法]');
      ok('[非法协议] targetFn 返回 {ok:true,target:{id:"x"}}（非正整数）→ 抛出契约错误 PERSIST_CALLBACK_CONTRACT，三件套零增量');
    }

    // ── beforeTimeline 返回 ok:false（先执行 UPDATE 再拒）→ 业务拒绝 {aborted:true}，非抛错（矩阵 11d）────
    // [D-1·主会话亲核修复] 修复前本用例会红：persist 的 beforeTimeline 分支曾没检查 bt.ok（只检查
    // typeof bt.superseded），若回调返回 {ok:false, superseded:false} 会被当作"契约合法的降级"照常写
    // 时间线并 COMMIT——本用例返回 {ok:false,...,superseded:false} 正是撞在这个漏检窗口上，旧版会得到
    // {aborted:false, actionCode:'attachment_added'} 而非期望的 {aborted:true}。加上 `if (!bt.ok) throw
    // new PersistAbort(...)`（在 typeof bt.superseded 检查之前）后，业务拒绝才会先于契约校验分流。
    {
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'target-11d.pdf');
      const targetId = up1.body.attachments[0].id;
      const beforeDir = dirFileCount(id);
      // [尾批·M2] 文件身份断言前置：旧目标真实磁盘相对路径（multer 随机化文件名，不能假定字面量）。
      const targetFileName = path.basename((await get(`SELECT file_name FROM sys_issue_attachments WHERE id=?`, [targetId])).file_name);
      const targetAbsPath = path.join(dirOf(id), targetFileName);
      assert.ok(fs.existsSync(targetAbsPath), `[11d 前置] 旧目标文件应先存在于磁盘: ${targetAbsPath}`);
      let updateExecuted = false, updateChanges = -1;
      const r = await directPersist(id, ['x11d.png'], 'spec', {
        targetFn: async () => ({ ok: true, target: { id: targetId } }),
        beforeTimeline: async (inserted, target) => {
          // 先真正执行条件 UPDATE（证明"UPDATE 已执行"这一矩阵 11d 前提成立），再返回业务拒绝。
          const upd = await run(`UPDATE sys_issue_attachments SET status='superseded' WHERE id=? AND status='active' AND id NOT IN (${inserted.map(a => a.id).join(',') || 'NULL'})`, [target.id]);
          updateChanges = upd.changes;
          updateExecuted = true;
          return { ok: false, reason: 'FORCED_11D', superseded: false };
        },
        timeline: { intent: 'replace' },
      });
      assert.strictEqual(updateExecuted, true, '[11d] beforeTimeline 内条件 UPDATE 确实执行（矩阵 11d 前提）');
      // [尾批·L] UPDATE 的 changes===1（非仅信语句返回未报错），坐实旧目标确曾被改变——而非该条件从未
      // 命中任何行（例如条件写错恒 0 行）却照样往下走到业务拒绝分支。
      assert.strictEqual(updateChanges, 1, `[11d] 条件 UPDATE 应恰改动 1 行（旧目标确曾被改变），实得 ${updateChanges}`);
      assert.deepStrictEqual(r, { aborted: true, reason: 'FORCED_11D', inserted: [], superseded: false }, `[11d] 应返回业务拒绝 {aborted:true,reason:'FORCED_11D'}（非抛错），实得 ${JSON.stringify(r)}`);
      const targetRow = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [targetId]);
      assert.strictEqual(targetRow.status, 'active', '[11d] UPDATE 已执行但整体回滚，旧附件仍 active（UPDATE 随 ROLLBACK 撤销）');
      assert.strictEqual((await attRows(id)).length, 1, '[11d] 附件行 0（本次新插入的 x11d 已回滚，只剩夹具的 target-11d 1 行）');
      assert.strictEqual(await timelineCount(id), 1, '[11d] 时间线行 0 增量（只剩 target-11d 上传自身写的 1 行）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[11d] 目录文件数不变（x11d.png 已被回滚补偿 unlink）');
      // [尾批·M2] 文件身份断言：数量不变不足以证明身份——旧目标文件仍在原路径，本批新文件路径已不存在。
      assert.ok(fs.existsSync(targetAbsPath), `[11d] 旧目标文件身份核对：文件仍应存在于原路径 ${targetAbsPath}`);
      assert.strictEqual(fs.existsSync(path.join(dirOf(id), 'x11d.png')), false, '[11d] 本批文件身份核对：x11d.png 应不存在（已被回滚补偿删除，非被误留）');
      ok("[11d] beforeTimeline 先执行 UPDATE（changes===1）再返回 {ok:false} → 业务拒绝 {aborted:true,reason} 而非抛错，旧附件仍 active，附件/时间线/文件三件套零残留（文件身份逐项核对：旧目标仍存在、本批新路径不存在）（本用例正是 D-1 修复前会假绿——修复前 bt.ok 未检查，会误判定为{superseded:false}的合法降级并 COMMIT，非抛错也非 aborted:true）");
    }
    // [返工批2·M3] 「合法 ok:false 不被误判契约错误」的顺序判别用例——11d 传的 {ok:false,...,superseded:false}
    // 恰好也满足 `typeof superseded==='boolean'` 这条契约检查，把 `!bt.ok` 与 `typeof bt.superseded` 两个
    // if 调换顺序后 11d 依然会绿，判别不到顺序。本例故意**不带** `superseded` 键，只有「业务拒绝先于契约
    // 校验」这一正确顺序才会得到 {aborted:true}；调换顺序会先撞上「缺布尔 superseded」判 500 契约错误。
    {
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      const r = await directPersist(id, ['m3-plain-reject.png'], 'delivery', {
        beforeTimeline: async () => ({ ok: false, reason: 'PLAIN_REJECT' }),   // 故意不带 superseded 键
      });
      assert.deepStrictEqual(r, { aborted: true, reason: 'PLAIN_REJECT', inserted: [], superseded: false }, `[M3] 不带 superseded 的合法 ok:false 应业务拒绝 {aborted:true,reason:'PLAIN_REJECT'}，不应是 500 契约错误，实得 ${JSON.stringify(r)}`);
      await assertNoResidue(id, base, '[M3-业务拒绝]');
      ok("[M3] beforeTimeline 返回 {ok:false,reason} 且不带 superseded 键 → 业务拒绝 {aborted:true}，非 500 PERSIST_CALLBACK_CONTRACT（证明业务拒绝分支先于契约校验，非仅因 11d 的 superseded:false 恰好也合法），三件套零增量");
    }

    // ══════════════════════════════════════════════════════════════════
    // 矩阵 #13：beforeSupersedeUpdateHook（同事务内抢先 superseded）→ 条件 UPDATE 0 行 → 降级 added
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'target-13.pdf');
      const targetId = up1.body.attachments[0].id;
      const beforeTl13 = await timelineCount(id);
      // [594TR-L1] 附件总数基线（第二次上传前，此刻只有 target-13.pdf 这一行）。
      const beforeAtt13 = (await attRows(id)).length;
      let hookCalled = false;
      I.__testHooks.beforeSupersedeUpdateHook = async () => {
        hookCalled = true;
        await run(`UPDATE sys_issue_attachments SET status='superseded' WHERE id=?`, [targetId]);   // 抢先置 superseded
      };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(targetId) }, 'new-13.pdf');
      clearHooks();
      assert.strictEqual(r.status, 200, `[矩阵13] 应 200（降级非拒绝）, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(hookCalled, true, '[矩阵13] beforeSupersedeUpdateHook 被调用（进入分支证据）');
      assert.strictEqual(r.body.superseded, false, '[矩阵13] superseded=false（条件 UPDATE 0 行）');
      // [收口批5·L1] 本次仅新增一条 added（非仅取最后一行看 action_code——避免漏掉"额外多写了一条
      // replaced 行、但最后一行恰好是 added"这种被掩盖的情况）。
      assert.strictEqual(await timelineCount(id), beforeTl13 + 1, '[矩阵13] 时间线恰增一条');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_added', '[矩阵13] 写 added 不写 replaced');
      const payload = JSON.parse(tl.payload_json);
      assert.ok(!('superseded_id' in payload), '[矩阵13] payload 无 superseded_id');
      const newRow = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [r.body.attachments[0].id]);
      assert.strictEqual(newRow.status, 'active', '[矩阵13] 新附件 active');
      // [594TR-L1] 附件总数恰增一行（非仅信新行 active——额外插入非 active 附件不会被上一条断言察觉）。
      assert.strictEqual((await attRows(id)).length, beforeAtt13 + 1, `[594TR-L1][矩阵13] 附件总数恰增一行，实得增量 ${(await attRows(id)).length - beforeAtt13}`);
      ok('[矩阵13] 冻结目标有效但条件 UPDATE 被钩子抢先置 0 行：钩子证据 + 降级 added + superseded:false + 无 superseded_id + 新附件 active + 附件总数恰增一行');
    }

    // ══════════════════════════════════════════════════════════════════
    // 故障注入：BEGIN/rename/INSERT/时间线INSERT/COMMIT/ROLLBACK/unlink/beforeTimeline 抛错
    // ══════════════════════════════════════════════════════════════════
    {
      // [返工批3·594T-#2] BEGIN 单次失败注入 → state 仍 idle（无补偿可做，助手内部已 releaseSysTxn）→
      // 原样抛出；断后续请求仍 200（互斥锁未被本次失败卡死）。
      const id = await mkDevIssue();
      const beforeTlBegin = await timelineCount(id);
      const beforeDirBegin = dirFileCount(id);
      const origDbRun = db.run.bind(db);
      let beginIntercepted = false;
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'BEGIN IMMEDIATE' && !beginIntercepted) {
          beginIntercepted = true;
          return cb ? cb(new Error('注入：BEGIN 失败')) : undefined;
        }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try { await directPersist(id, ['begin-fail.png'], 'delivery', {}); } catch (e) { threw = e; }
      db.run = origDbRun;
      assert.ok(threw && /BEGIN 失败/.test(threw.message), `[594T-#2] BEGIN 失败应原样抛出, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 0, '[594T-#2] 附件行 0');
      // [尾批·L] 补时间线与文件零增量——BEGIN 尚未成功，逐文件 rename/INSERT 循环根本没机会开始。
      assert.strictEqual(await timelineCount(id), beforeTlBegin, '[594T-#2] 时间线零增量（BEGIN 失败于 rename/INSERT 循环之前）');
      assert.strictEqual(dirFileCount(id), beforeDirBegin, '[594T-#2] 文件零增量（尚未 rename 任何文件）');
      const r2 = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'begin-fail-recover.png');
      assert.strictEqual(r2.status, 200, `[594T-#2] BEGIN 失败后互斥锁未被卡死，后续请求应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      ok('[594T-#2] BEGIN 单次失败注入 → 原样抛出、附件/时间线/文件三件套零增量；后续请求正常 200（锁未被卡死）');
    }
    {
      // rename 第 1 个文件失败
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const origRename = fs.renameSync;
      let called = 0;
      fs.renameSync = (...args) => { called++; if (called === 1) throw new Error('注入：rename 失败'); return origRename(...args); };
      let threw = null;
      try { await directPersist(id, ['rn1.png'], 'delivery', {}); } catch (e) { threw = e; }
      fs.renameSync = origRename;
      assert.ok(threw && /rename 失败/.test(threw.message), `[故障-rename1] 应抛出注入异常, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 0, '[故障-rename1] 附件行 0');
      assert.strictEqual(dirFileCount(id), beforeDir, '[故障-rename1] 目录文件数不变');
      ok('[故障注入] 第 1 文件 rename 失败 → 回滚 + 行 0 + 目录不变');
    }
    {
      // 第 2 个文件 rename 失败：第 1 个已 rename 的文件应被回滚补偿 unlink
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const origRename = fs.renameSync;
      let called = 0;
      fs.renameSync = (...args) => { called++; if (called === 2) throw new Error('注入：第2个rename失败'); return origRename(...args); };
      let threw = null;
      try { await directPersist(id, ['rn2a.png', 'rn2b.png'], 'delivery', {}); } catch (e) { threw = e; }
      fs.renameSync = origRename;
      // [尾批·L] 限定为指定注入异常（非任意异常）——原来 `assert.ok(threw, ...)` 连"抛的是不是这次注入
      // 的那个异常"都不判别，任何异常都能通过。
      assert.ok(threw && /第2个rename失败/.test(threw.message), `[故障-rename2] 应抛出指定注入异常, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 0, '[故障-rename2] 附件行 0');
      assert.strictEqual(dirFileCount(id), beforeDir, '[故障-rename2] 目录文件数不变（第1个已unlink补偿）');
      ok('[故障注入] 第 2 文件 rename 失败 → 抛出指定注入异常，第1个已移动文件同事务补偿 unlink，行 0 目录不变');
    }
    {
      // [返工批3·594T-edge-case] 同一故障走真实 HTTP 端点（非 directPersist 直调）：multer 先把两个文件
      // 落到 _pending/{id}，端点调用 persist 时第 2 个 rename 失败——断言最终目录（SYS_UPLOAD_BASE/{id}）
      // 与暂存目录（SYS_PENDING_BASE/{id}）均无本次文件残留（前者由 persist 自身补偿 unlink，后者由端点
      // catch 的 sysCleanupOrphanFiles + finally 的 rmdirSync 兜底）。
      const id = await mkDevIssue();
      const beforeFinal = dirFileCount(id);
      const origRename = fs.renameSync;
      let called = 0;
      fs.renameSync = (...args) => { called++; if (called === 2) throw new Error('注入：HTTP 第2个rename失败'); return origRename(...args); };
      const r = await uploadMulti(ATT(id), devTok, { attachment_type: 'delivery' }, [{ name: 'http-rn-a.png' }, { name: 'http-rn-b.png' }]);
      fs.renameSync = origRename;
      assert.strictEqual(r.status, 500, `[594T-edge-case] 应 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(dirFileCount(id), beforeFinal, '[594T-edge-case] 最终目录无本次文件残留');
      let pendingCount = 0;
      try { pendingCount = fs.readdirSync(path.join(I.SYS_PENDING_BASE, String(id))).length; } catch (_) { /* 目录不存在即 0 残留 */ }
      assert.strictEqual(pendingCount, 0, '[594T-edge-case] _pending 暂存目录无本次文件残留');
      ok('[594T-edge-case] 真实 HTTP 端点注入第 2 个 rename 失败 → 最终目录与 _pending 暂存目录均无本次文件残留');
    }
    {
      // COMMIT 失败：SQL 执行前抛
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const origRun = run;
      // directPersist 用的是模块内 dbRunAsync（即本文件顶层 run 函数的引用，已注入进 mod）——直接 monkeypatch db.run 更贴近真实故障面
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
          return cb ? cb(new Error('注入：COMMIT 失败')) : undefined;
        }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try { await directPersist(id, ['commit-fail.png'], 'delivery', {}); } catch (e) { threw = e; }
      db.run = origDbRun;
      assert.ok(threw && /COMMIT 失败/.test(threw.message), `[故障-COMMIT] 应抛出, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 0, '[故障-COMMIT] 附件行 0（persist 自身回滚）');
      assert.strictEqual(dirFileCount(id), beforeDir, '[故障-COMMIT] 目录文件数不变');
      ok('[故障注入] COMMIT 失败 → persist 自身 ROLLBACK（同一 catch 路径）+ 行 0 + 目录不变');
    }
    {
      // [收口批5·M3] ROLLBACK 失败（执行前抛）→ rollbackUnconfirmed：500 TXN_ROLLBACK_UNCONFIRMED，不 unlink。
      // 局部记录三件事：ROLLBACK 尝试次数（wrap db.run）、held=true 的 release 次数（onSysTxnRelease）、
      // unlink 调用次数（wrap fs.unlinkSync）——分别断恰 1 / 恰 1 / 0（不是靠文件数差值间接推断）。
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const logsBeforeCount = recordedErrorLogs.length;
      let rollbackAttempts17a = 0, unlinkCalls17a = 0;
      const releaseEvents17a = [];
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith(`attach:${id}:`) && held) releaseEvents17a.push({ tag, held }); };
      const origUnlink17a = fs.unlinkSync;
      fs.unlinkSync = (...args) => { unlinkCalls17a++; return origUnlink17a(...args); };
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') return cb ? cb(new Error('触发回滚')) : undefined;
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') { rollbackAttempts17a++; return cb ? cb(new Error('注入：ROLLBACK 失败')) : undefined; }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try { await directPersist(id, ['rb-fail.png'], 'delivery', {}); } catch (e) { threw = e; }
      db.run = origDbRun;
      fs.unlinkSync = origUnlink17a;
      // 注入让 ROLLBACK 语句本身从未真正对 sqlite 执行（persist 视角=rollbackUnconfirmed，符合矩阵语义）；
      // 但真实 sqlite 连接仍停在一个悬空的已开事务上，必须真实清理，否则污染本脚本后续所有用例（sqlite3
      // 单连接不支持嵌套事务，下一个 BEGIN IMMEDIATE 会报 "cannot start a transaction within a transaction"）。
      try { await run('ROLLBACK'); } catch (_) { /* best-effort 清理，不影响上面已做的断言 */ }
      clearHooks();
      assert.ok(threw && threw.code === 'TXN_ROLLBACK_UNCONFIRMED', `[故障-ROLLBACK] 应 TXN_ROLLBACK_UNCONFIRMED, got ${threw && threw.message} ${threw && threw.code}`);
      // rename 本身未被注入失败，文件已成功移动到最终目录；rollbackUnconfirmed 分支不 unlink，故文件应仍
      // 残留（beforeDir+1），这正是"不 unlink"的可观测证据（不是"目录文件数不变"，是"该被撤销的文件没被撤销"）。
      assert.strictEqual(dirFileCount(id), beforeDir + 1, '[故障-ROLLBACK] 不 unlink：已 rename 的文件应仍残留在目录内');
      assert.strictEqual(rollbackAttempts17a, 1, `[故障-ROLLBACK] ROLLBACK 尝试应恰 1 次，实得 ${rollbackAttempts17a}`);
      assert.strictEqual(releaseEvents17a.length, 1, `[故障-ROLLBACK] held=true 的 release 应恰 1 次，实得 ${releaseEvents17a.length}`);
      assert.strictEqual(unlinkCalls17a, 0, `[故障-ROLLBACK] unlink 调用应恰 0 次，实得 ${unlinkCalls17a}`);
      // [返工批3·codex594-C 订正] 故障日志须同时含原异常文本（cause=）与回滚异常文本（rollbackErr=）+ issue_id。
      const newLogs = recordedErrorLogs.slice(logsBeforeCount);
      assert.ok(newLogs.some(l => l.includes('cause=') && l.includes('触发回滚') && l.includes('rollbackErr=') && l.includes('注入：ROLLBACK 失败') && l.includes(`issue=${id}`)), `[594-C] 故障日志应同时含 cause=触发回滚 与 rollbackErr=注入：ROLLBACK 失败 与 issue=${id}, got ${JSON.stringify(newLogs)}`);
      ok('[故障注入] ROLLBACK 执行前抛错 → rollbackUnconfirmed → 抛出契约错误 TXN_ROLLBACK_UNCONFIRMED；ROLLBACK 尝试恰1/held释放恰1/unlink恰0，故障日志同时含两类注入异常文本与 issue_id');
    }
    {
      // [收口批5·M3] ROLLBACK 失败（执行后报错，即 dbRunAsync 的 promise reject 发生在语句已真正执行之后）
      // ——用返回 changes 但仍 reject 的 stub 近似。同上局部记录三件事，并补连续两请求变体（本变体此前
      // 缺连续请求覆盖，只有"执行前抛"那种变体有）。
      const id = await mkDevIssue();
      const logsBeforeCount = recordedErrorLogs.length;
      let rollbackAttempts17b = 0, unlinkCalls17b = 0;
      const releaseEvents17b = [];
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith(`attach:${id}:`) && held) releaseEvents17b.push({ tag, held }); };
      const origUnlink17b = fs.unlinkSync;
      fs.unlinkSync = (...args) => { unlinkCalls17b++; return origUnlink17b(...args); };
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') return cb ? cb(new Error('触发回滚2')) : undefined;
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') {
          rollbackAttempts17b++;
          return origDbRun(sql, params, function (e) { cb && cb(new Error('注入：ROLLBACK 执行后报错')); });
        }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      const beforeDirFiles = dirFileCount(id);
      try { await directPersist(id, ['rb-fail2.png'], 'delivery', {}); } catch (e) { threw = e; }
      db.run = origDbRun;
      fs.unlinkSync = origUnlink17b;
      clearHooks();
      assert.ok(threw && threw.code === 'TXN_ROLLBACK_UNCONFIRMED', `[故障-ROLLBACK执行后] 应 TXN_ROLLBACK_UNCONFIRMED, got ${threw && threw.message}`);
      assert.strictEqual(dirFileCount(id), beforeDirFiles + 1, '[故障-ROLLBACK执行后] 已 rename 的文件不被 unlink（残留 +1，rollbackUnconfirmed 分支不执行补偿）');
      assert.strictEqual(rollbackAttempts17b, 1, `[故障-ROLLBACK执行后] ROLLBACK 尝试应恰 1 次，实得 ${rollbackAttempts17b}`);
      assert.strictEqual(releaseEvents17b.length, 1, `[故障-ROLLBACK执行后] held=true 的 release 应恰 1 次，实得 ${releaseEvents17b.length}`);
      assert.strictEqual(unlinkCalls17b, 0, `[故障-ROLLBACK执行后] unlink 调用应恰 0 次，实得 ${unlinkCalls17b}`);
      const newLogs2 = recordedErrorLogs.slice(logsBeforeCount);
      assert.ok(newLogs2.some(l => l.includes('cause=') && l.includes('触发回滚2') && l.includes('rollbackErr=') && l.includes('注入：ROLLBACK 执行后报错') && l.includes(`issue=${id}`)), `[594-C] 故障日志应同时含 cause=触发回滚2 与 rollbackErr=注入：ROLLBACK 执行后报错 与 issue=${id}, got ${JSON.stringify(newLogs2)}`);
      ok('[故障注入] ROLLBACK 语句已执行、回调报错（SQL 执行后报错型）→ 同样 rollbackUnconfirmed；ROLLBACK 尝试恰1/held释放恰1/unlink恰0，故障日志同时含两类注入异常文本与 issue_id');
    }
    {
      // [收口批5·M3] 「执行后报错」变体补连续两请求：第一请求 rollbackUnconfirmed 后，第二请求（新 issue）
      // 只记录不断言成败（方案既定口径），但断第一请求确实只 ROLLBACK 尝试一次、只 held=true 释放一次。
      const id1 = await mkDevIssue();
      let rollbackAttemptsSeqB = 0;
      const releaseEventsSeqB = [];
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith(`attach:${id1}:`) && held) releaseEventsSeqB.push({ tag, held }); };
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') return cb ? cb(new Error('触发回滚-执行后报错连续请求')) : undefined;
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') {
          rollbackAttemptsSeqB++;
          return origDbRun(sql, params, function () { cb && cb(new Error('注入：ROLLBACK 执行后报错-连续请求')); });
        }
        return origDbRun(sql, params, cb);
      };
      let threw1 = null;
      try { await directPersist(id1, ['seqB1.png'], 'delivery', {}); } catch (e) { threw1 = e; }
      db.run = origDbRun;
      assert.ok(threw1 && threw1.code === 'TXN_ROLLBACK_UNCONFIRMED', `[连续请求-未确认-执行后报错] 第一请求应 TXN_ROLLBACK_UNCONFIRMED, got ${threw1 && threw1.message}`);
      assert.strictEqual(rollbackAttemptsSeqB, 1, `[连续请求-未确认-执行后报错] ROLLBACK 尝试应恰 1 次，实得 ${rollbackAttemptsSeqB}`);
      assert.strictEqual(releaseEventsSeqB.length, 1, `[连续请求-未确认-执行后报错] held=true 释放应恰 1 次，实得 ${releaseEventsSeqB.length}`);
      assert.strictEqual(releaseEventsSeqB[0].held, true, '[连续请求-未确认-执行后报错] release 时确实持有句柄（held=true）');
      // [594TR-M1] 第一请求后只移除故障注入、保留观测包装：第一请求已 rename 的残留文件路径固定为
      // seqB1.png，跨第二请求持续观测该路径的 unlink 增量与 ROLLBACK 增量，均应为 0——证明在本次观测
      // 窗口与包装覆盖的入口内，未确认态没有被延迟补偿/延迟回滚悄悄清理掉（本变体 ROLLBACK 语句本身对
      // sqlite 真执行过；[596C-M4] 第二请求是否能正常 BEGIN/COMMIT 本身不作断言——这里只是预期说明：
      // 连接理应可用，实际结果只记录不判成败，避免把未断言的结果写成已证明结论）。
      const residualPathB1 = path.join(dirOf(id1), 'seqB1.png');
      assert.ok(fs.existsSync(residualPathB1), `[594TR-M1][连续请求-未确认-执行后报错] 残留文件路径应存在: ${residualPathB1}`);
      let rollbackAttemptsPhase2B = 0, unlinkCallsResidualB1 = 0;
      const origUnlinkPhase2B = fs.unlinkSync;
      const origDbRunPhase2B = db.run.bind(db);
      // [596C-M4] 同 Phase2A：装包装到恢复包装整段套 try/finally，mkDevIssue()/directPersist() 中途
      // 抛错不应让包装停留在被劫持状态。
      let secondOutcomeB;
      try {
        fs.unlinkSync = (p, ...rest) => { if (p === residualPathB1) unlinkCallsResidualB1++; return origUnlinkPhase2B(p, ...rest); };
        db.run = function (sql, params, cb) {
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackAttemptsPhase2B++;
          return origDbRunPhase2B(sql, params, cb);
        };
        const id2 = await mkDevIssue();
        try { secondOutcomeB = await directPersist(id2, ['seqB2.png'], 'delivery', {}); }
        catch (e) { secondOutcomeB = { __threw: e && e.message }; }
        // [596C-M4] 恢复包装前再断一次：残留文件在整个第二请求窗口内确实原样还在磁盘上。
        assert.ok(fs.existsSync(residualPathB1), `[594TR-M1][连续请求-未确认-执行后报错] 恢复包装前复核：残留文件仍应存在: ${residualPathB1}`);
      } finally {
        db.run = origDbRunPhase2B;
        fs.unlinkSync = origUnlinkPhase2B;
      }
      console.log('    [连续请求-未确认-执行后报错] 第二请求结果（只记录不断言）：' + JSON.stringify(secondOutcomeB));
      // [596C-M4] 结论限定到本次观测窗口（第二请求执行期间）与本次包装覆盖的两个入口（db.run 收到的
      // ROLLBACK 语句、fs.unlinkSync），不代表排除了所有可能的延迟清理机制。
      assert.strictEqual(rollbackAttemptsPhase2B, 0, `[594TR-M1][连续请求-未确认-执行后报错] 观测窗口内（第二请求期间，经 db.run 包装）ROLLBACK 增量应为 0，实得 ${rollbackAttemptsPhase2B}`);
      assert.strictEqual(unlinkCallsResidualB1, 0, `[594TR-M1][连续请求-未确认-执行后报错] 观测窗口内（第二请求期间，经 fs.unlinkSync 包装）第一请求残留文件 unlink 增量应为 0，实得 ${unlinkCallsResidualB1}`);
      try { await run('ROLLBACK'); } catch (_) { /* best-effort */ }
      clearHooks();
      ok('[连续两请求·未确认·执行后报错变体] 第一请求 ROLLBACK 尝试恰1/held释放恰1（held=true），观测窗口内（db.run/fs.unlinkSync 两入口）该残留文件的 unlink 与 ROLLBACK 增量均为 0，恢复包装前复核文件仍存在，第二请求结果已记录（不作断言）');
    }
    {
      // [返工批2·M2] rollbackUnconfirmed 优先于业务拒绝——recheckFn 返回业务拒绝 {ok:false}（原本该走
      // PersistAbort → {aborted:true}），但同时注入 ROLLBACK 失败：persist 必须先分流进 rollbackUnconfirmed
      // （抛 TXN_ROLLBACK_UNCONFIRMED），不能把这次 ROLLBACK 失败静默吞成"业务拒绝已确认"（方案 §2.2
      // 伪码：`if (state==='rollbackUnconfirmed') throw ...` 必须在 `if (e instanceof PersistAbort) return ...`
      // 之前）。反例见 prescreen M2：现有用例组合从未同时命中"业务拒绝路径"+"ROLLBACK 注入失败"。
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const releaseEvents = [];
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith('attach:')) releaseEvents.push({ tag, held }); };
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') return cb ? cb(new Error('注入：ROLLBACK 失败-业务拒绝优先级')) : undefined;
        return origDbRun(sql, params, cb);
      };
      let threw = null, result = null;
      try {
        result = await directPersist(id, ['m2-priority.png'], 'delivery', { recheckFn: async () => ({ ok: false, reason: 'FORCED_M2' }) });
      } catch (e) { threw = e; }
      db.run = origDbRun;
      try { await run('ROLLBACK'); } catch (_) { /* 真实 sqlite 连接清理，同上一组 ROLLBACK 故障注入范式 */ }
      assert.strictEqual(result, null, '[M2] 不应正常返回 {aborted:true}（会掩盖 ROLLBACK 失败这一平台级故障）');
      assert.ok(threw && threw.code === 'TXN_ROLLBACK_UNCONFIRMED', `[M2] 应抛 TXN_ROLLBACK_UNCONFIRMED（而非吞成业务拒绝）, got ${threw && threw.message} ${threw && threw.code}`);
      assert.strictEqual(dirFileCount(id), beforeDir + 1, '[M2] 不 unlink：已 rename 的文件仍残留（rollbackUnconfirmed 分支不执行补偿）');
      const tags = releaseEvents.filter(e => e.tag.includes(`attach:${id}:`));
      assert.strictEqual(tags.length, 1, `[M2] release 恰一次，实得 ${tags.length}`);
      clearHooks();
      ok('[M2] rollbackUnconfirmed 优先于业务拒绝：recheckFn ok:false + ROLLBACK 注入失败 → 抛出契约错误 TXN_ROLLBACK_UNCONFIRMED（非 aborted:true），不 unlink，release 恰一次');
    }
    {
      // [返工批3·594T 订正] M7 原版的 COMMIT/ROLLBACK 桩都是"执行前直接返回错误"——两条 SQL 都从未真正
      // 对 sqlite 执行过，"DB 无行"断言证明的只是"测试自己在末尾跑了一次真 ROLLBACK 做清理"，不是注释
      // 声称的"隐式回滚后 DB 已干净"。订正：COMMIT 桩内用原始 db.run 方法**真的执行一次 ROLLBACK**（精确
      // 复现"sqlite 在某些 COMMIT 失败下会隐式回滚事务"这一真实行为），再回报 COMMIT 失败；随后 persist
      // 自己再次尝试的 ROLLBACK 会打在真实连接上，此时事务已经真的不存在，会产生真实的"无事务"错误（不
      // 伪造错误文本）。出口断言（DB 无行/文件保留/错误码）全部放在清理之前；末尾清理放 finally。
      const id = await mkDevIssue();
      const beforeDir = dirFileCount(id);
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
          // 真实执行一次 ROLLBACK（用原始方法，不经过本 stub），再回报 COMMIT 错误——复现隐式回滚。
          return origDbRun('ROLLBACK', [], function () { if (cb) cb(new Error('SQLITE_FULL: database or disk is full')); });
        }
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try {
        try { await directPersist(id, ['m7-commit-then-rollback-fail.png'], 'delivery', {}); } catch (e) { threw = e; }
        db.run = origDbRun;
        assert.ok(threw && threw.code === 'TXN_ROLLBACK_UNCONFIRMED', `[M7] COMMIT 失败（含真实隐式回滚）后 persist 自身再 ROLLBACK 打在已无事务的真实连接上 → 应 500 TXN_ROLLBACK_UNCONFIRMED, got ${threw && threw.message} ${threw && threw.code}`);
        assert.strictEqual(dirFileCount(id), beforeDir + 1, '[M7] 文件保留（孤儿，不 unlink——fail-closed 的已知代价）');
        assert.strictEqual((await attRows(id)).length, 0, '[M7] DB 无行——这次是真实隐式回滚已发生的证据（COMMIT 桩内用原始方法真执行了 ROLLBACK），非测试清理的副作用');
        ok('[M7] 已知过度报警场景（COMMIT 桩内真实隐式回滚 + persist 自身 ROLLBACK 打在真无事务连接上）→ 抛出契约错误 TXN_ROLLBACK_UNCONFIRMED + 文件保留（孤儿）+ DB 无行（真实证据），如实记录该 fail-closed 行为');
      } finally {
        db.run = origDbRun;
        try { await run('ROLLBACK'); } catch (_) { /* best-effort 兜底清理，即便理论上事务已不存在 */ }
      }
    }
    {
      // unlink 失败：不抛，只记日志，原响应码不变（这里用真正会触发回滚+unlink 的路径：recheckFn 拒绝）
      // [收口批5·M3] logger.warn 已换录制器——断日志确实含 issue_id 与被 unlink 的路径，而不是只信"没抛错"。
      const id = await mkDevIssue();
      const warnBeforeCount = recordedWarnLogs.length;
      const origUnlink = fs.unlinkSync;
      let unlinkThrew = 0;
      let unlinkedPath = null;
      fs.unlinkSync = (p, ...rest) => { unlinkThrew++; unlinkedPath = p; throw new Error('注入：unlink 失败'); };
      let result = null, threw = null;
      try {
        result = await directPersist(id, ['unlink-fail.png'], 'delivery', { recheckFn: async () => ({ ok: false, reason: 'FORCED' }) });
      } catch (e) { threw = e; }
      fs.unlinkSync = origUnlink;
      assert.strictEqual(threw, null, '[故障-unlink] unlink 失败不应向外抛（persist 吞错记日志）');
      assert.ok(result && result.aborted === true, '[故障-unlink] 业务拒绝仍正常返回 {aborted:true}');
      const newWarnLogs = recordedWarnLogs.slice(warnBeforeCount);
      assert.ok(unlinkedPath, '[故障-unlink] 注入的 unlinkSync 确实被真实路径调用（夹具自检）');
      assert.ok(newWarnLogs.some(l => l.includes(`issue=${id}`) && l.includes(unlinkedPath)), `[故障-unlink] warn 日志应含 issue=${id} 与被 unlink 的路径 ${unlinkedPath}，实得 ${JSON.stringify(newWarnLogs)}`);
      assert.ok(unlinkThrew >= 1, '[故障-unlink] unlink 确实被调用并抛错（钩子命中证据）');
      ok('[故障注入] unlink 失败 → 记日志不抛，原响应（业务拒绝 aborted:true）不变');
    }
    {
      // beforeTimeline 抛错
      const id = await mkDevIssue();
      let threw = null;
      try { await directPersist(id, ['bt-throw.png'], 'delivery', { beforeTimeline: async () => { throw new Error('注入：beforeTimeline 抛错'); } }); }
      catch (e) { threw = e; }
      assert.ok(threw && /beforeTimeline 抛错/.test(threw.message), `[故障-beforeTimeline] 应抛出, got ${threw && threw.message}`);
      assert.strictEqual((await attRows(id)).length, 0, '[故障-beforeTimeline] 附件行 0');
      ok('[故障注入] beforeTimeline 抛错 → 回滚 + 行 0');
    }
    {
      // 时间线 INSERT 失败：注入 db.run 拦截含 sys_issue_timeline 的 INSERT
      const id = await mkDevIssue();
      const base = await snapshotBaseline(id);
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.includes('INSERT INTO sys_issue_timeline')) return cb ? cb(new Error('注入：时间线 INSERT 失败')) : undefined;
        return origDbRun(sql, params, cb);
      };
      let threw = null;
      try { await directPersist(id, ['tl-fail.png'], 'delivery', {}); } catch (e) { threw = e; }
      db.run = origDbRun;
      assert.ok(threw && /时间线 INSERT 失败/.test(threw.message), `[故障-时间线INSERT] 应抛出, got ${threw && threw.message}`);
      await assertNoResidue(id, base, '[故障-时间线INSERT]');
      ok('[故障注入] 时间线 INSERT 失败 → 整体回滚，附件行也撤销');
    }

    // ══════════════════════════════════════════════════════════════════
    // 连续两请求：release 计数（onSysTxnRelease 按 tag）
    // ══════════════════════════════════════════════════════════════════
    {
      // [收口批5·M3] ① 回滚已确认 → 第二请求正常 BEGIN/COMMIT；release 恰各一次；补：第一请求的补偿
      // unlink 恰一次（按路径计次，非仅信"目录文件数没变"），第二请求期间 ROLLBACK 增量为 0（证明第一
      // 请求的补偿没有延迟到第二请求才做，且第二请求本身走的是干净的 BEGIN/COMMIT 没有额外回滚）。
      const id1 = await mkDevIssue();
      const releaseEvents = [];
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith('attach:')) releaseEvents.push({ tag, held }); };
      // [尾批·M1] 按第一请求最终文件路径过滤的 unlink 包装保留到第二请求结束（而非第一请求返回就立即
      // 恢复）——分别断第一阶段（第一请求期间）恰 1 次、第二阶段（第二请求期间）增量为 0，证明第一请求
      // 的补偿没有延迟到第二请求才补做。与 db.run 包装一起，在 finally 里无条件还原（不管中途是否抛错）。
      const residualPathSeq1 = path.join(dirOf(id1), 'seq1.png');
      const origUnlinkSeq = fs.unlinkSync;
      const origDbRunSeq = db.run.bind(db);
      let unlinkCallsPhase1 = 0, unlinkCallsPhase2 = 0, rollbackCallsSeq2 = 0, phase = 1;
      fs.unlinkSync = (p, ...rest) => {
        if (p === residualPathSeq1) { if (phase === 1) unlinkCallsPhase1++; else unlinkCallsPhase2++; }
        return origUnlinkSeq(p, ...rest);
      };
      let r1, r2, id2;
      try {
        r1 = await directPersist(id1, ['seq1.png'], 'delivery', { recheckFn: async () => ({ ok: false, reason: 'FORCED_SEQ1' }) }).catch(e => ({ __threw: e }));
        assert.strictEqual(unlinkCallsPhase1, 1, `[连续请求-已确认] 第一阶段（第一请求期间，按最终文件路径过滤）unlink 应恰一次（不延迟）, 实得 ${unlinkCallsPhase1}`);
        phase = 2;
        id2 = await mkDevIssue();
        db.run = function (sql, params, cb) {
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCallsSeq2++;
          return origDbRunSeq(sql, params, cb);
        };
        r2 = await directPersist(id2, ['seq2.png'], 'delivery', {});
      } finally {
        db.run = origDbRunSeq;
        fs.unlinkSync = origUnlinkSeq;
      }
      clearHooks();
      assert.ok(r1 && r1.aborted === true, '[连续请求-已确认] 第一请求业务拒绝（rolledBack 态）');
      assert.strictEqual(r2.aborted, false, '[连续请求-已确认] 第二请求正常成功');
      assert.strictEqual(rollbackCallsSeq2, 0, `[连续请求-已确认] 第二请求期间 ROLLBACK 增量应为 0（干净的 BEGIN/COMMIT，无额外回滚）, 实得 ${rollbackCallsSeq2}`);
      // [尾批·M2] 第二阶段（跨第二请求持续观测）该残留路径 unlink 增量应为 0——第一请求的补偿确实只做了
      // 一次，没有在第二请求期间被延迟补做第二次。
      assert.strictEqual(unlinkCallsPhase2, 0, `[连续请求-已确认] 第二阶段（第二请求期间，同一路径过滤）unlink 增量应为 0，实得 ${unlinkCallsPhase2}`);
      const tagsSeq1 = releaseEvents.filter(e => e.tag.includes(`attach:${id1}:`));
      const tagsSeq2 = releaseEvents.filter(e => e.tag.includes(`attach:${id2}:`));
      assert.strictEqual(tagsSeq1.length, 1, `[连续请求-已确认] 第一请求 release 恰一次，实得 ${tagsSeq1.length}`);
      assert.strictEqual(tagsSeq2.length, 1, `[连续请求-已确认] 第二请求 release 恰一次，实得 ${tagsSeq2.length}`);
      assert.strictEqual(tagsSeq1[0].held, true, '[连续请求-已确认] 第一请求 release 时确实持有句柄');
      assert.strictEqual(tagsSeq2[0].held, true, '[连续请求-已确认] 第二请求 release 时确实持有句柄');
      ok('[连续两请求·已确认] 第一阶段该残留路径 unlink 恰一次、第二阶段增量为 0（跨第二请求持续观测，非第一请求返回即恢复包装），第一请求 rolledBack 后第二请求正常 BEGIN/COMMIT，release 各恰一次（按 tag 计数，非导出属性包装）');
    }
    {
      // ② 回滚未确认 → 恰一次 ROLLBACK 尝试、恰一次 release、不 unlink、500 TXN_ROLLBACK_UNCONFIRMED；第二请求只记录不断言
      const id1 = await mkDevIssue();
      const releaseEvents = [];
      let rollbackAttempts = 0;
      I.__testHooks.onSysTxnRelease = ({ tag, held }) => { if (tag && tag.startsWith('attach:')) releaseEvents.push({ tag, held }); };
      const origDbRun = db.run.bind(db);
      db.run = function (sql, params, cb) {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') return cb ? cb(new Error('触发回滚-连续请求')) : undefined;
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') { rollbackAttempts++; return cb ? cb(new Error('注入：ROLLBACK 失败-连续请求')) : undefined; }
        return origDbRun(sql, params, cb);
      };
      const beforeDirFiles = dirFileCount(id1);
      let threw1 = null;
      try { await directPersist(id1, ['seqA.png'], 'delivery', {}); } catch (e) { threw1 = e; }
      db.run = origDbRun;
      assert.ok(threw1 && threw1.code === 'TXN_ROLLBACK_UNCONFIRMED', `[连续请求-未确认] 第一请求应 TXN_ROLLBACK_UNCONFIRMED, got ${threw1 && threw1.message}`);
      assert.strictEqual(rollbackAttempts, 1, `[连续请求-未确认] 恰一次 ROLLBACK 尝试，实得 ${rollbackAttempts}`);
      assert.strictEqual(dirFileCount(id1), beforeDirFiles + 1, '[连续请求-未确认] 不 unlink（已 rename 的文件残留 +1）');
      const tagsSeqA = releaseEvents.filter(e => e.tag.includes(`attach:${id1}:`));
      assert.strictEqual(tagsSeqA.length, 1, `[连续请求-未确认] release 恰一次，实得 ${tagsSeqA.length}`);
      // [594TR-M1] 执行前抛错变体补断 held=true（释放时确实持有句柄，非对 null 的幂等调用）。
      assert.strictEqual(tagsSeqA[0].held, true, '[连续请求-未确认] release 时确实持有句柄（held=true）');
      // [594TR-M1] 第一请求后只移除故障注入、保留观测包装：第一请求已 rename 的残留文件路径固定为
      // seqA.png（directPersist 用 files 里的 name 作最终文件名），跨第二请求持续观测该路径的 unlink
      // 增量与 ROLLBACK 增量，均应为 0——证明未确认态没有被延迟补偿/延迟回滚悄悄清理掉。
      const residualPathA = path.join(dirOf(id1), 'seqA.png');
      assert.ok(fs.existsSync(residualPathA), `[594TR-M1][连续请求-未确认] 残留文件路径应存在: ${residualPathA}`);
      let rollbackAttemptsPhase2A = 0, unlinkCallsResidualA = 0;
      const origUnlinkPhase2A = fs.unlinkSync;
      const origDbRunPhase2A = db.run.bind(db);
      // [596C-M4] 从装包装到恢复包装整段套 try/finally——mkDevIssue()/directPersist() 中途抛错不应让
      // db.run/fs.unlinkSync 停留在被劫持状态，污染本脚本后续所有用例。
      let secondOutcome;
      try {
        fs.unlinkSync = (p, ...rest) => { if (p === residualPathA) unlinkCallsResidualA++; return origUnlinkPhase2A(p, ...rest); };
        db.run = function (sql, params, cb) {
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackAttemptsPhase2A++;
          return origDbRunPhase2A(sql, params, cb);
        };
        // 第二请求：只记录，不断言成功/失败（方案明确"不承诺连接已恢复"）
        const id2 = await mkDevIssue();
        try { secondOutcome = await directPersist(id2, ['seqB.png'], 'delivery', {}); }
        catch (e) { secondOutcome = { __threw: e && e.message }; }
        // [596C-M4] 恢复包装前再断一次：第一请求的残留文件在整个第二请求窗口内确实原样还在磁盘上——不仅
        // "unlink 未被调用"，而是"文件本身还在"，排除有未被本包装覆盖的其它删除入口把它悄悄清理掉。
        assert.ok(fs.existsSync(residualPathA), `[594TR-M1][连续请求-未确认] 恢复包装前复核：残留文件仍应存在: ${residualPathA}`);
      } finally {
        db.run = origDbRunPhase2A;
        fs.unlinkSync = origUnlinkPhase2A;
      }
      console.log('    [连续请求-未确认] 第二请求结果（只记录不断言）：' + JSON.stringify(secondOutcome));
      // [596C-M4] 以下两条"无延迟回滚/补偿"结论限定到本次观测窗口（第二请求执行期间）与本次包装覆盖的
      // 两个入口（db.run 收到的 ROLLBACK 语句、fs.unlinkSync）——不代表排除了所有可能的延迟清理机制，
      // 只代表这两个入口在这段观测窗口内增量为 0。
      assert.strictEqual(rollbackAttemptsPhase2A, 0, `[594TR-M1][连续请求-未确认] 观测窗口内（第二请求期间，经 db.run 包装）ROLLBACK 增量应为 0，实得 ${rollbackAttemptsPhase2A}`);
      assert.strictEqual(unlinkCallsResidualA, 0, `[594TR-M1][连续请求-未确认] 观测窗口内（第二请求期间，经 fs.unlinkSync 包装）第一请求残留文件 unlink 增量应为 0，实得 ${unlinkCallsResidualA}`);
      // 真实 sqlite 连接从未被真正 ROLLBACK 过（注入让 ROLLBACK 语句本身未对 sqlite 执行），必须真实清理，
      // 否则污染本脚本后续所有用例（同上一组 ROLLBACK 故障注入用例的清理原则）。
      try { await run('ROLLBACK'); } catch (_) { /* best-effort */ }
      clearHooks();
      ok('[连续两请求·未确认] 恰一次 ROLLBACK 尝试、恰一次 release（held=true）、不 unlink、抛出契约错误 TXN_ROLLBACK_UNCONFIRMED；观测窗口内（db.run/fs.unlinkSync 两入口）该残留文件的 unlink 与 ROLLBACK 增量均为 0，恢复包装前复核文件仍存在，第二请求结果已记录（不作断言）');
    }

    // ══════════════════════════════════════════════════════════════════
    // B2b：COMMIT 后失败（返工批1·补做4·真实注入）——用 beforeAttachmentResponseHook（新增测试钩子，
    // 声明在 res.json 之前调用）在真实端点 res.json 前抛错，四例：20a×2（headersSent=false）+ 20b×2
    // （headersSent=true）；断三类记录（附件行/时间线行/文件）均保留、零回滚。
    // ══════════════════════════════════════════════════════════════════
    {
      // 20a-普通：钩子直接 throw → headersSent=false → 端点 catch 尝试 500；持久化三类记录保留
      // [返工批2·M1] 对照组：本例（headersSent=false）不应写「响应已发送，仅记录」这条日志（走的是
      // sendSysTransitionError/status(500).json 分支，非 headersSent=true 分支），恰 0 次。
      // [返工批4] 钩子内直接断 res.headersSent===false；并包装 res.json 记录"钩子之后"的发送调用次数
      // ——20a 预期端点 catch 恰发出一次 500（json 1 次；只包装 res.json，不重复包装 res.end，因为 express
      // 的 res.json 内部会再调用 res.end，重复包装两者会把同一次发送算成两次）。
      const id = await mkDevIssue();
      const logsBefore = countLogsIncluding('响应已发送，仅记录');
      let sendCalls20a1 = 0, rollbackCalls20a1 = 0;
      const origDbRun20a1 = db.run.bind(db);
      db.run = function (sql, params, cb) { if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCalls20a1++; return origDbRun20a1(sql, params, cb); };
      I.__testHooks.beforeAttachmentResponseHook = async (res) => {
        assert.strictEqual(res.headersSent, false, '[B2b-20a普通] 钩子触发时 res.headersSent 应为 false（尚未发送任何响应）');
        const origJson = res.json.bind(res);
        res.json = (...a) => { sendCalls20a1++; return origJson(...a); };
        throw new Error('注入：COMMIT 后 res.json 前抛错-普通');
      };
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'b2b-20a-plain.png');
      db.run = origDbRun20a1;
      clearHooks();
      assert.strictEqual(r.status, 500, `[B2b-20a普通] headersSent=false 应尝试 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(countLogsIncluding('响应已发送，仅记录') - logsBefore, 0, '[B2b-20a普通] 对照组：不应写「响应已发送，仅记录」日志（headersSent=false 分支）');
      assert.strictEqual(sendCalls20a1, 1, `[B2b-20a普通] 钩子之后应恰一次 res.json 调用（端点 catch 发出的那次 500），实得 ${sendCalls20a1}`);
      assert.strictEqual(rollbackCalls20a1, 0, `[B2b-20a普通] 不应触发任何 ROLLBACK（COMMIT 已提交，无回滚可做），实得 ${rollbackCalls20a1}`);
      const rows = await attRows(id);
      assert.strictEqual(rows.length, 1, '[B2b-20a普通] 附件行保留（COMMIT 已提交，不回滚）');
      assert.strictEqual(rows[0].status, 'active', '[B2b-20a普通] 附件行仍 active');
      assert.strictEqual(await timelineCount(id), 1, '[B2b-20a普通] 时间线行保留（attachment_added 已提交）');
      assert.strictEqual(dirFileCount(id), 1, '[B2b-20a普通] 文件保留（已 rename，未被回滚清理）');
      ok('[B2b-20a] 普通上传：钩子内断 headersSent=false，钩子在 res.json 前抛错 → 端点尝试 500（发送调用恰 1 次、ROLLBACK 0 次），三类记录全部保留，对照日志 0 次');
    }
    {
      // 20a-替换：同上，替换路径
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'b2b-20a-old.pdf');
      const oldId = up1.body.attachments[0].id;
      const logsBefore = countLogsIncluding('响应已发送，仅记录');
      let sendCalls20a2 = 0, rollbackCalls20a2 = 0;
      const origDbRun20a2 = db.run.bind(db);
      db.run = function (sql, params, cb) { if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCalls20a2++; return origDbRun20a2(sql, params, cb); };
      I.__testHooks.beforeAttachmentResponseHook = async (res) => {
        assert.strictEqual(res.headersSent, false, '[B2b-20a替换] 钩子触发时 res.headersSent 应为 false');
        const origJson = res.json.bind(res);
        res.json = (...a) => { sendCalls20a2++; return origJson(...a); };
        throw new Error('注入：COMMIT 后 res.json 前抛错-替换');
      };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'b2b-20a-new.pdf');
      db.run = origDbRun20a2;
      clearHooks();
      assert.strictEqual(r.status, 500, `[B2b-20a替换] 应尝试 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(countLogsIncluding('响应已发送，仅记录') - logsBefore, 0, '[B2b-20a替换] 对照组：不应写「响应已发送，仅记录」日志');
      assert.strictEqual(sendCalls20a2, 1, `[B2b-20a替换] 钩子之后应恰一次 res.json 调用，实得 ${sendCalls20a2}`);
      assert.strictEqual(rollbackCalls20a2, 0, `[B2b-20a替换] 不应触发任何 ROLLBACK，实得 ${rollbackCalls20a2}`);
      const rows = await attRows(id);
      const oldRow = rows.find(a => a.id === oldId);
      assert.strictEqual(oldRow.status, 'superseded', '[B2b-20a替换] 旧附件 superseded 已提交保留（不因端点后续异常回滚）');
      const activeRows = rows.filter(a => a.status === 'active');
      assert.strictEqual(activeRows.length, 1, `[B2b-20a替换] 新附件恰一行 active，实得 ${activeRows.length}`);
      const tlLast = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tlLast.action_code, 'attachment_replaced', '[B2b-20a替换] 本次时间线 action_code=attachment_replaced');
      assert.strictEqual(await timelineCount(id), 2, '[B2b-20a替换] 时间线行保留（首次 spec 上传 added + 本次 replaced，共 2 行）');
      assert.strictEqual(dirFileCount(id), 2, '[B2b-20a替换] 文件保留（旧新两个文件均未被回滚清理）');
      ok('[B2b-20a] 替换上传：钩子内断 headersSent=false，钩子在 res.json 前抛错 → 端点尝试 500（发送调用恰 1 次、ROLLBACK 0 次），旧附件superseded/新附件恰一行active/action_code=replaced/两文件保留');
    }
    {
      // [收口批5·L2] 20b-普通：钩子先手动写响应头/部分响应体再 throw **普通 Error**（非 SysTransitionError；
      // 与下方 20b-替换刻意用 SysTransitionError 区分开，两条分支各覆盖一种错误类型）→ headersSent=true →
      // 端点 catch 只记日志不再发送。[返工批2·M1] 判别式断言：不再用恒真的 r.status===200（res.end() 已
      // 提前发生，客户端必然看到 200）作为「未重复发送」的证据，改断「响应已发送，仅记录」这条日志确实
      // 被写过恰 1 次。生产端点 catch 目前对 SysTransitionError 与普通 Error 两条分支都已各自区分
      // headersSent（:15939/:15943 一带），本例走的是普通 Error 分支，同样能产出这条带措辞的日志。
      // [返工批4] 钩子内 write 之后直接断 res.headersSent===true；并包装 res.json/res.send 记录"钩子之后"
      // 的发送调用次数——20b 预期 0 次（sysFinishBrokenResponse 只调 res.destroy()，不应再发送任何响应体）。
      const id = await mkDevIssue();
      const logsBefore = countLogsIncluding('响应已发送，仅记录');
      let sendCalls20b1 = 0, rollbackCalls20b1 = 0;
      const origDbRun20b1 = db.run.bind(db);
      db.run = function (sql, params, cb) { if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCalls20b1++; return origDbRun20b1(sql, params, cb); };
      I.__testHooks.beforeAttachmentResponseHook = async (res) => {
        res.status(200); res.write('{"ok":true');   // 故意只写一半，制造响应体不完整
        assert.strictEqual(res.headersSent, true, '[B2b-20b普通] write 之后 res.headersSent 应为 true');
        const origJson = res.json.bind(res);
        res.json = (...a) => { sendCalls20b1++; return origJson(...a); };
        if (typeof res.send === 'function') { const origSend = res.send.bind(res); res.send = (...a) => { sendCalls20b1++; return origSend(...a); }; }
        res.end();   // 结束响应避免连接悬挂，仍保留 headersSent=true
        throw new Error('注入：COMMIT 后已发送头再抛错-普通（普通 Error 分支，主会话收口后同样区分 headersSent）');
      };
      const r = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'b2b-20b-plain.png');
      db.run = origDbRun20b1;
      clearHooks();
      assert.strictEqual(countLogsIncluding('响应已发送，仅记录') - logsBefore, 1, `[B2b-20b普通] 「响应已发送，仅记录」日志应恰 1 次, got status=${r.status} body=${JSON.stringify(r.body)}`);
      // [594TR-L2] 本例钩子已先 res.end() 结束响应，这里只证明「响应已结束后不再调用 res.json/res.send」；
      // 未结束响应时的主动终止（res.destroy() 收尾）结论限定到下方 594-B 用例，不由本例证明。
      assert.strictEqual(sendCalls20b1, 0, `[B2b-20b普通] 响应已结束（res.end()）后不再调用 res.json/res.send，实得 ${sendCalls20b1}`);
      assert.strictEqual(rollbackCalls20b1, 0, `[B2b-20b普通] 不应触发任何 ROLLBACK，实得 ${rollbackCalls20b1}`);
      const rows = await attRows(id);
      assert.strictEqual(rows.length, 1, '[B2b-20b普通] 附件行保留');
      assert.strictEqual(await timelineCount(id), 1, '[B2b-20b普通] 时间线行保留');
      assert.strictEqual(dirFileCount(id), 1, '[B2b-20b普通] 文件保留');
      ok('[B2b-20b] 普通上传：钩子内断 headersSent=true，先写部分响应头/体再 res.end() 结束响应再抛错 →「响应已发送，仅记录」日志恰 1 次、响应已结束后不再调用 res.json/res.send、ROLLBACK 0 次，三类记录保留（未结束响应的 destroy 主动终止收尾结论见 594-B 用例）');
    }
    {
      // 20b-替换：同上，替换路径
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'b2b-20b-old.pdf');
      const oldId = up1.body.attachments[0].id;
      const logsBefore = countLogsIncluding('响应已发送，仅记录');
      let sendCalls20b2 = 0, rollbackCalls20b2 = 0;
      const origDbRun20b2 = db.run.bind(db);
      db.run = function (sql, params, cb) { if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCalls20b2++; return origDbRun20b2(sql, params, cb); };
      I.__testHooks.beforeAttachmentResponseHook = async (res) => {
        res.status(200); res.write('{"ok":true');
        assert.strictEqual(res.headersSent, true, '[B2b-20b替换] write 之后 res.headersSent 应为 true');
        const origJson = res.json.bind(res);
        res.json = (...a) => { sendCalls20b2++; return origJson(...a); };
        if (typeof res.send === 'function') { const origSend = res.send.bind(res); res.send = (...a) => { sendCalls20b2++; return origSend(...a); }; }
        res.end();   // 结束响应避免连接悬挂，仍保留 headersSent=true
        throw new I.SysTransitionError(500, 'INJECTED_AFTER_HEADERS', '注入：COMMIT 后已发送头再抛错-替换');
      };
      const r = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'b2b-20b-new.pdf');
      db.run = origDbRun20b2;
      clearHooks();
      assert.strictEqual(countLogsIncluding('响应已发送，仅记录') - logsBefore, 1, `[B2b-20b替换] 「响应已发送，仅记录」日志应恰 1 次, got status=${r.status} body=${JSON.stringify(r.body)}`);
      // [594TR-L2] 本例钩子已先 res.end() 结束响应，这里只证明「响应已结束后不再调用 res.json/res.send」；
      // 未结束响应时的主动终止（res.destroy() 收尾）结论限定到下方 594-B 用例，不由本例证明。
      assert.strictEqual(sendCalls20b2, 0, `[B2b-20b替换] 响应已结束（res.end()）后不再调用 res.json/res.send，实得 ${sendCalls20b2}`);
      assert.strictEqual(rollbackCalls20b2, 0, `[B2b-20b替换] 不应触发任何 ROLLBACK，实得 ${rollbackCalls20b2}`);
      const rows = await attRows(id);
      const oldRow = rows.find(a => a.id === oldId);
      assert.strictEqual(oldRow.status, 'superseded', '[B2b-20b替换] 旧附件 superseded 保留');
      const activeRows2 = rows.filter(a => a.status === 'active');
      assert.strictEqual(activeRows2.length, 1, `[B2b-20b替换] 新附件恰一行 active，实得 ${activeRows2.length}`);
      const tlLast2 = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tlLast2.action_code, 'attachment_replaced', '[B2b-20b替换] 本次时间线 action_code=attachment_replaced');
      assert.strictEqual(await timelineCount(id), 2, '[B2b-20b替换] 时间线行保留（added+replaced 共 2 行）');
      assert.strictEqual(dirFileCount(id), 2, '[B2b-20b替换] 文件保留');
      ok('[B2b-20b] 替换上传：钩子内断 headersSent=true，先写部分响应头/体再 res.end() 结束响应再抛错 → 响应已结束后不再调用 res.json/res.send、ROLLBACK 0 次、只记日志不再发送，旧附件superseded/新附件恰一行active/action_code=replaced/两文件保留（未结束响应的 destroy 主动终止收尾结论见 594-B 用例）');
    }
    // ── [返工批3·codex594-B] 钩子只 write('{') 不 end 再抛错（headersSent=true 但 !writableEnded）——
    // 覆盖旧测试（先 res.end() 再抛错）没暴露的路径：断请求在超时内终止（客户端 socket close/解析失败）、
    // 三类记录保留、期间无额外 ROLLBACK、钩子之后无 res.json/res.send 调用（生产 sysFinishBrokenResponse
    // 只调 res.destroy()，不应再发送任何响应体）。
    {
      async function b594BCase(label, buildErr) {
        const id = await mkDevIssue();
        let sendAfterHookCalls = 0;
        let rollbackCountDuring = 0;
        const origDbRun = db.run.bind(db);
        db.run = function (sql, params, cb) {
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCountDuring++;
          return origDbRun(sql, params, cb);
        };
        I.__testHooks.beforeAttachmentResponseHook = async (res) => {
          const origJson = res.json.bind(res);
          res.json = (...a) => { sendAfterHookCalls++; return origJson(...a); };
          if (typeof res.send === 'function') {
            const origSend = res.send.bind(res);
            res.send = (...a) => { sendAfterHookCalls++; return origSend(...a); };
          }
          res.write('{');   // 只写，不 end——headersSent=true 但 writableEnded=false
          throw buildErr();
        };
        const r = await uploadExpectSocketClose(ATT(id), devTok, { attachment_type: 'delivery' }, `594b-${label}.png`, 3000);
        db.run = origDbRun;
        clearHooks();
        assert.strictEqual(r.terminated, true, `[594-B-${label}] 请求应在超时内终止（客户端 socket close/解析失败），实得 ${JSON.stringify(r)}`);
        assert.strictEqual(sendAfterHookCalls, 0, `[594-B-${label}] 钩子之后不应再调用 res.json/res.send`);
        assert.strictEqual(rollbackCountDuring, 0, `[594-B-${label}] 不应触发额外 ROLLBACK（COMMIT 已提交，无回滚可做）`);
        const rows = await attRows(id);
        assert.strictEqual(rows.length, 1, `[594-B-${label}] 附件行保留`);
        assert.strictEqual(await timelineCount(id), 1, `[594-B-${label}] 时间线行保留`);
        assert.strictEqual(dirFileCount(id), 1, `[594-B-${label}] 文件保留`);
        ok(`[594-B] 钩子只 write 不 end 再抛错（${label}）→ 请求超时内终止 + 钩子后无 res.json/send 调用 + ROLLBACK 计数 0 + 三类记录保留`);
      }
      await b594BCase('普通Error', () => new Error('注入：只write不end再抛错'));
      await b594BCase('SysTransitionError', () => new I.SysTransitionError(500, 'INJECTED_NO_END', '注入：只write不end再抛错-STE'));
    }
    // ── [返工批3·594T-#19] 提交后 logger.info 抛错（COMMIT 成功、beforeAttachmentResponseHook 之前）——
    // 与 B2b 的钩子抛错是不同的注入点（钩子在 logger.info 之后），此处直接让 logger.info 本身抛错，普通/
    // 替换各一例；断持久化记录保留、期间无额外 ROLLBACK。
    {
      async function case19(label, uploadFn) {
        const origInfo = testLogger.info;
        let rollbackCountDuring = 0;
        const origDbRun = db.run.bind(db);
        db.run = function (sql, params, cb) {
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') rollbackCountDuring++;
          return origDbRun(sql, params, cb);
        };
        testLogger.info = () => { throw new Error('注入：logger.info 提交后抛错-' + label); };
        const result = await uploadFn();
        testLogger.info = origInfo;
        db.run = origDbRun;
        return { result, rollbackCountDuring };
      }
      {
        const id = await mkDevIssue();
        const { result: r, rollbackCountDuring } = await case19('普通', () => upload(ATT(id), devTok, { attachment_type: 'delivery' }, '594-19-plain.png'));
        assert.strictEqual(r.status, 500, `[594-#19-普通] logger.info 抛错应 500, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(rollbackCountDuring, 0, '[594-#19-普通] 不应触发额外 ROLLBACK');
        const rows = await attRows(id);
        assert.strictEqual(rows.length, 1, '[594-#19-普通] 附件行保留');
        assert.strictEqual(await timelineCount(id), 1, '[594-#19-普通] 时间线行保留');
        assert.strictEqual(dirFileCount(id), 1, '[594-#19-普通] 文件保留');
        ok('[594-#19] 普通上传：COMMIT 后 logger.info 抛错 → 500，持久化三类记录保留，ROLLBACK 计数 0');
      }
      {
        const id = await mkIssue('improvement', '开发中');
        const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, '594-19-old.pdf');
        const oldId = up1.body.attachments[0].id;
        const { result: r, rollbackCountDuring } = await case19('替换', () => upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, '594-19-new.pdf'));
        assert.strictEqual(r.status, 500, `[594-#19-替换] logger.info 抛错应 500, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(rollbackCountDuring, 0, '[594-#19-替换] 不应触发额外 ROLLBACK');
        const rows = await attRows(id);
        const oldRow = rows.find(a => a.id === oldId);
        assert.strictEqual(oldRow.status, 'superseded', '[594-#19-替换] 旧附件 superseded 保留');
        // [收口批5·M4] 补齐"三类记录保留"完整结论——原来只检查旧状态和时间线数量，未检查新附件/文件/本次 action_code。
        const activeRows19 = rows.filter(a => a.status === 'active');
        assert.strictEqual(activeRows19.length, 1, `[594-#19-替换] 新附件恰一行 active，实得 ${activeRows19.length}`);
        assert.strictEqual(dirFileCount(id), 2, '[594-#19-替换] 两个文件（旧+新）均保留');
        const tlLast19 = (await timelineRows(id)).slice(-1)[0];
        assert.strictEqual(tlLast19.action_code, 'attachment_replaced', '[594-#19-替换] 本次时间线 action_code=attachment_replaced');
        assert.strictEqual(await timelineCount(id), 2, '[594-#19-替换] 时间线行保留（added+replaced）');
        ok('[594-#19] 替换上传：COMMIT 后 logger.info 抛错 → 500，旧附件superseded/新附件恰一行active/两文件保留/action_code=replaced/时间线 2 行，ROLLBACK 计数 0');
      }
    }
    // 重传两例：新目标 / 同已 superseded 目标 → added
    {
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'retry-old.pdf');
      const oldId = up1.body.attachments[0].id;
      const up2 = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'retry-new1.pdf');
      assert.strictEqual(up2.body.superseded, true, '[重传-新目标] 首次替换成功');
      // [尾批·L] 补精确增量基线（非仅信最后一行/最终状态——重复写行同样能通过弱断言）。
      const beforeAttRetry1 = (await attRows(id)).length, beforeTlRetry1 = await timelineCount(id);
      const up3 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'retry-plain.pdf');   // 无 supersede_id 的重传
      assert.strictEqual(up3.status, 200, '[重传-无目标] 应 200');
      assert.strictEqual((await attRows(id)).length, beforeAttRetry1 + 1, '[重传-无目标] 附件恰增一行');
      assert.strictEqual(await timelineCount(id), beforeTlRetry1 + 1, '[重传-无目标] 时间线恰增一行');
      const tl3 = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl3.action_code, 'attachment_added', '[重传-无目标] 写 added');
      // [返工批3·594T-LOW] 补 active 状态断言（原用例只看 action_code，未核对新附件 DB 行状态）。
      const newRow3 = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [up3.body.attachments[0].id]);
      assert.strictEqual(newRow3.status, 'active', '[重传-无目标] 新附件 DB 中确实 active');
      ok('[重传] 无新目标的重传 → added + 新附件 active（B3′ 语义一致），附件/时间线恰各增一行');
    }
    {
      const id = await mkIssue('improvement', '开发中');
      const up1 = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'retry2-old.pdf');
      const oldId = up1.body.attachments[0].id;
      await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'retry2-new.pdf');
      // 同一（已 superseded）目标再次尝试 supersede
      // [尾批·L] 补精确增量基线。
      const beforeAttRetry2 = (await attRows(id)).length, beforeTlRetry2 = await timelineCount(id);
      const up3 = await upload(ATT(id), adminTok, { attachment_type: 'spec', supersede_id: String(oldId) }, 'retry2-again.pdf');
      assert.strictEqual(up3.status, 200, '[重传-同已superseded目标] 应 200（降级 added）');
      assert.strictEqual(up3.body.superseded, false, '[重传-同已superseded目标] superseded=false');
      assert.strictEqual((await attRows(id)).length, beforeAttRetry2 + 1, '[重传-同已superseded目标] 附件恰增一行');
      assert.strictEqual(await timelineCount(id), beforeTlRetry2 + 1, '[重传-同已superseded目标] 时间线恰增一行');
      const tl3b = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl3b.action_code, 'attachment_added', '[重传-同已superseded目标] action_code=attachment_added');
      const newRow3b = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [up3.body.attachments[0].id]);
      assert.strictEqual(newRow3b.status, 'active', '[重传-同已superseded目标] 新附件 DB 中确实 active');
      ok('[重传] 同一已 superseded 目标再次 supersede → 降级 added + 新附件 active，附件/时间线恰各增一行');
    }

    // ══════════════════════════════════════════════════════════════════
    // 删除：removed 行带码、summary 含 original_name、payload 四字段、K1
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      const up = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'to-delete.png');
      const attId = up.body.attachments[0].id;
      const beforeTl = await timelineCount(id);
      const beforeFiles = dirFileCount(id);
      const r = await call('DELETE', DEL(id, attId), devTok);
      assert.strictEqual(r.status, 200, `[删除] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // [返工批3·594T-LOW] 补删除结果本身的核对：附件行状态非 active（物理删除，查不到）+ 落盘文件真的减少。
      const deletedRow = await get(`SELECT * FROM sys_issue_attachments WHERE id=?`, [attId]);
      assert.strictEqual(deletedRow, undefined, '[删除] 附件行已物理删除（查不到）');
      assert.strictEqual(dirFileCount(id), beforeFiles - 1, '[删除] 落盘文件数减一（safeDeleteFileSync 真删除）');
      assert.strictEqual(await timelineCount(id), beforeTl + 1, '[删除] 增一条 timeline 行');
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.strictEqual(tl.action_code, 'attachment_removed', '[删除] action_code=attachment_removed');
      assert.strictEqual(tl.ref_id, attId, '[删除] ref_id=被删附件 id');
      assert.ok(tl.summary.includes('to-delete.png'), `[删除] summary 含 original_name, got ${tl.summary}`);
      assert.ok(tl.summary.startsWith('删除交付附件：'), `[删除] summary 类型词前缀, got ${tl.summary}`);
      const payload = JSON.parse(tl.payload_json);
      assert.ok(!('attachment_ids' in payload), '[删除/K1] 根对象无 attachment_ids');
      assert.strictEqual(payload.attachment.id, attId, '[删除] payload.attachment.id');
      assert.strictEqual(payload.attachment.original_name, 'to-delete.png', '[删除] payload.attachment.original_name');
      assert.strictEqual(payload.attachment.attachment_type, 'delivery', '[删除] payload.attachment.attachment_type');
      assert.strictEqual(payload.attachment.uploaded_by_name, '开发王', '[删除] payload.attachment.uploaded_by_name');
      ok('[删除] action_code/ref_id/summary/payload 四字段 K1 全部核对通过');
    }
    {
      // original_name 为空的边界显示（original_name 列为 NOT NULL——用空字符串模拟"空文件名"边界，
      // 非字面 SQL NULL；sysAttachDisplayName 对空串与 NULL 同等兜底处理）。
      const id = await mkDevIssue();
      const insRes = await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, round_no, file_name, original_name, uploaded_by, uploaded_by_name)
         VALUES (?, 'delivery', NULL, 'legacy/none.png', '', 5, '开发王')`,
        [id]
      );
      const attId = insRes.lastID;
      const r = await call('DELETE', DEL(id, attId), devTok);
      assert.strictEqual(r.status, 200, `[删除-无原名] 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = (await timelineRows(id)).slice(-1)[0];
      assert.ok(tl.summary.includes(`（无文件名）#${attId}`), `[删除-无原名] summary 兜底文案, got ${tl.summary}`);
      ok('[删除] original_name 为空字符串（列 NOT NULL，非 SQL NULL）→ summary 显「（无文件名）#id」兜底');   // [返工批2·L4] 文案与实现同步（原文案误写"为 NULL"）
    }

    // ══════════════════════════════════════════════════════════════════
    // B6：历史无码行逐字不变
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      const insRes = await run(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, ref_id, operator_id, operator_name) VALUES (?, 'note', '历史无码备注行', NULL, 1, '管理员')`,
        [id]
      );
      const legacyId = insRes.lastID;
      const legacyBefore = await get(`SELECT * FROM sys_issue_timeline WHERE id=?`, [legacyId]);
      const upB6 = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'after-legacy.png');
      assert.strictEqual(upB6.status, 200, `[B6] 上传本身应成功, got ${upB6.status} ${JSON.stringify(upB6.body)}`);
      const delB6 = await call('DELETE', DEL(id, (await attRows(id))[0].id), devTok);
      assert.strictEqual(delB6.status, 200, `[B6] 删除本身应成功, got ${delB6.status} ${JSON.stringify(delB6.body)}`);
      // [返工批3·594T-LOW] 全行快照深比较（非仅摘取 summary/action_code/payload_json 三字段）+ 已在上方
      // 核对上传/删除操作自身均成功（"历史行不变"的前提是流程真的跑完，而非上传/删除本身先失败了）。
      const legacyAfter = await get(`SELECT * FROM sys_issue_timeline WHERE id=?`, [legacyId]);
      assert.deepStrictEqual(legacyAfter, legacyBefore, `[B6] 历史无码行整行快照深比较逐字不变, before=${JSON.stringify(legacyBefore)} after=${JSON.stringify(legacyAfter)}`);
      ok('[B6] 全流程（上传+删除，均已核对操作本身成功）跑完后，历史无码行整行快照逐字不变');
    }

    // ══════════════════════════════════════════════════════════════════
    // 每个成功用例：committed 后 mutex 已释放（下一请求 200）——用一次连续两次上传验证
    // ══════════════════════════════════════════════════════════════════
    {
      const id = await mkDevIssue();
      const r1 = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'mutex-1.png');
      assert.strictEqual(r1.status, 200, '[mutex释放] 第一次上传 200');
      const r2 = await upload(ATT(id), devTok, { attachment_type: 'delivery' }, 'mutex-2.png');
      assert.strictEqual(r2.status, 200, '[mutex释放] 紧接第二次上传仍 200（committed 后锁已释放，非结构性卡死）');
      ok('[mutex] 本用例验证的范围：同一 issue 连续两次成功上传，紧接的第二次仍 200（committed 后锁已释放，非结构性卡死）——不代表"每个成功用例"均已逐一验证释放');   // [返工批3·594T-LOW] 文案收窄为实际覆盖范围
    }

    console.log(`\n✅ verify-sys-attachment-trace 全部通过（${passed} 项断言）`);
  } finally {
    clearHooks();
    // [收口批5·M5] 收尾 await server.close 与 db.close（原为 fire-and-forget，不保证连接真正释放）；
    // best-effort 包住，避免收尾阶段自身异常掩盖前面已产出的真实结果。
    await new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
    await new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
    // [返工批2·M5] 收尾清理只删本脚本自己的 base（pid 独占目录），不触碰共享目录。
    try { fs.rmSync(MY_UPLOAD_DIR, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}
main().catch(async (e) => {
  console.error('❌ verify-sys-attachment-trace 失败:', e && e.stack || e);
  // [收口批5·M5] 失败路径也要关闭本脚本持有的连接（server/db），不只关 server。
  try { await new Promise((resolve) => { try { server ? server.close(() => resolve()) : resolve(); } catch (_) { resolve(); } }); } catch (_) { /* ignore */ }
  try { await new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } }); } catch (_) { /* ignore */ }
  process.exit(1);
});
