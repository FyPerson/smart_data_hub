// 验证脚本：项目管理（系统建设记录）模块 C1c——附件端点、最小权限助手、事件助手、绑定 / 冻结助手、上传失败回读门
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §5 / §7 / §10.3
//   派单：docs/local/系统建设记录/送审准备/C1c_附件_派单说明_20261028.md
//
// 用法：node scripts/verify-sysbuild-attachments.js                        跑全部用例
//       node scripts/verify-sysbuild-attachments.js --self-test            对 routes/sysbuild/ 下被测文件逐一注入变异，
//         每个变异在子进程里重跑全部用例，必须至少一条判红（否则说明对应断言没有判别力）
//       node scripts/verify-sysbuild-attachments.js --module-dir <目录>    被测模块目录（缺省 routes/sysbuild）
//
// 夹具：不起整站、不连业务库。每个夹具 = 进程私有临时目录里的一份一次性库 + UPLOAD_DIR，真实 db.js / schema.js /
//   attachments.js，挂在自建 express 应用上（测试鉴权替身按请求头 x-test-user 设 req.user），回环端口经
//   scripts/lib/listen-safe-port.js 的 listenOnSafePort 取 20000–49999（不用系统分配端口，见 PROJECT_STATUS #95）。
//   种子数据（项目、成员、越界改写、引用行）用外部 sqlite 连接直接写。不使用 test-env（本脚本是单元级，
//   不起整站；接入后的整站冒烟在 verify-sysbuild-e2e.js）。
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { listenOnSafePort } = require('./lib/listen-safe-port');

const DEFAULT_DIR = path.join(__dirname, '..', 'routes', 'sysbuild');
const argDirIdx = process.argv.indexOf('--module-dir');
const MODULE_DIR = argDirIdx > 0 ? path.resolve(process.argv[argDirIdx + 1]) : DEFAULT_DIR;
const SELF_TEST = process.argv.includes('--self-test');
// 变异自检的子进程带 --no-keep：用例判红是预期，现场不保留（直接运行时失败仍保留现场便于取证）。
const NO_KEEP = process.argv.includes('--no-keep');

// 照 server.js:15325-15331 原文复制。
function normalizeAttachmentExt(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) return '';
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return '';
  return path.extname(trimmed).toLowerCase().trim();
}
// 夹具传给 createAttachmentRoutes 的 COLLAB_ALLOWED_EXTS_UNION 的测试子集（真实值在 server.js，另含压缩包扩展名）。
//   生产口径的白名单 = 这份联合白名单 ∪ .zip .rar .7z：压缩包三项由被测模块自己追加（EXTRA_EXTS），
//   所以这里故意不列，「压缩包可上传」的用例靠它证明追加生效；.exe 不在任何一边。
const TEST_EXTS = ['.txt', '.pdf', '.xlsx', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

// ── 小工具 ───────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`超时 ${ms}ms: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(t));
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function listFiles(dir) {
  const out = [];
  function walk(d, rel) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  }
  walk(dir, '');
  return out.sort();
}
function removeTree(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // 目录联接 / 符号链接只摘链接本身，绝不进入（lstat 不跟随）；Windows 上联接用 rmdirSync 摘除。
    if (fs.lstatSync(p).isSymbolicLink()) {
      try { fs.unlinkSync(p); } catch (_) { fs.rmdirSync(p); }
    } else if (e.isDirectory()) removeTree(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}
const extDb = {
  open(file) {
    return new Promise((resolve, reject) => {
      const c = new sqlite3.Database(file, (err) => {
        if (err) return reject(err);
        c.run('PRAGMA busy_timeout = 300', (e) => (e ? reject(e) : resolve(c)));
        return undefined;
      });
    });
  },
  run: (c, sql, p) => new Promise((res, rej) => c.run(sql, p || [], function cb(e) { if (e) rej(e); else res(this); })),
  get: (c, sql, p) => new Promise((res, rej) => c.get(sql, p || [], (e, r) => (e ? rej(e) : res(r)))),
  all: (c, sql, p) => new Promise((res, rej) => c.all(sql, p || [], (e, r) => (e ? rej(e) : res(r)))),
};
function closeConn(c) {
  return new Promise((res) => { try { sqlite3.Database.prototype.close.call(c, () => res()); } catch (_) { res(); } });
}

let MODS = null;
function loadModules() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  MODS = {
    dbMod: require(path.join(MODULE_DIR, 'db.js')),
    schema: require(path.join(MODULE_DIR, 'schema.js')),
    att: require(path.join(MODULE_DIR, 'attachments.js')),
    events: require(path.join(MODULE_DIR, 'events.js')),
    rules: require(path.join(MODULE_DIR, 'rules.js')),
  };
  return MODS;
}

// ── 用户与文件样例 ────────────────────────────────────────────────────────────────────
const U = {
  ADMIN: { id: 1, role: 'admin', display_name: 'admin' },
  PM: { id: 11, role: 'user', display_name: 'pm' },
  M1: { id: 12, role: 'user', display_name: 'member1' },
  RO: { id: 13, role: 'user', display_name: 'readonly-member' },
  OUT: { id: 14, role: 'user', display_name: 'outsider' },
  REMOVED: { id: 15, role: 'user', display_name: 'removed' },
  RO_OUT: { id: 16, role: 'user', display_name: 'readonly-outsider' },
  PENDING: { id: 17, role: 'user', display_name: 'pending' },
  PM_RO: { id: 18, role: 'user', display_name: 'pm-readonly' },
  M2: { id: 19, role: 'user', display_name: 'member2' },
  M3: { id: 20, role: 'user', display_name: 'member3' },
  ADMIN_RO: { id: 21, role: 'admin', display_name: 'admin-readonly' }, // admin 角色且在只读名单里（M-2）
};
const READONLY_IDS = [U.RO.id, U.RO_OUT.id, U.PM_RO.id, U.ADMIN_RO.id];
const TXT = Buffer.from('hello 项目管理\n', 'utf8');
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF_1X1 = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
const JPEG_MIN = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(16, 1), Buffer.from([0xFF, 0xD9])]);
const WEBP_MIN = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8L', 'latin1'), Buffer.alloc(18, 0)]);

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────
async function makeFixture() {
  const { dbMod, schema, att, events } = MODS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-att-'));
  const UPLOAD_DIR = path.join(root, 'uploads');
  fs.mkdirSync(UPLOAD_DIR);
  const DB_FILE = path.join(root, 'case.db');
  const logs = [];
  const mk = (level) => (...a) => { logs.push({ level, msg: a.map(String).join(' ') }); };
  const logger = { info: mk('info'), warn: mk('warn'), error: mk('error') };
  const deletes = [];
  const exitCalls = [];
  // 测试版 safeDeleteFileSync：只允许删 UPLOAD_DIR 子树内的文件，并记录每次调用。
  const safeDeleteFileSync = (rel, base) => {
    deletes.push(rel);
    if (base !== UPLOAD_DIR) return false;
    const full = path.resolve(base, rel);
    if (!full.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return false;
    try { fs.unlinkSync(full); return true; } catch (_) { return false; }
  };
  const db = dbMod.createSysbuildDb({
    logger, DB_FILE, schemaObjects: schema.SCHEMA_OBJECTS, busyTimeoutMs: 300, lockTimeoutMs: 1500,
    processExit: (c) => exitCalls.push(c), enableTestHooks: true,
    beforePublish: () => { fs.mkdirSync(path.join(UPLOAD_DIR, 'sysbuild'), { recursive: true }); },
  });
  await db.initSchema();
  assert.strictEqual(db.getReadiness().ready, true, '夹具库应初始化就绪');
  // 回读门测试用：只在回读阶段把 withRead 换成故障 / 畸形结果。
  const override = { withRead: null, withWriteTxn: null }; // withWriteTxn：Q8 L-1 用例用它在暂存事务里把读到的行改成「已遮蔽」
  const dbForRoutes = Object.assign({}, db, {
    withRead: (fn) => (override.withRead ? override.withRead(fn) : db.withRead(fn)),
    withWriteTxn: (fn) => (override.withWriteTxn ? override.withWriteTxn(fn) : db.withWriteTxn(fn)),
  });
  const routes = att.createAttachmentRoutes({
    db: dbForRoutes, logger, UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync,
    COLLAB_ALLOWED_EXTS_UNION: TEST_EXTS, readonlyIds: READONLY_IDS, nowProvider: () => new Date(), enableTestHooks: true,
  });
  const app = express();
  app.use((req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ code: 'UNAUTHORIZED' });
    req.user = JSON.parse(h);
    return next();
  });
  // 模拟 send / 文件系统在下载阶段抛出的系统错误（带 status 与字符串 code，message 里有路径）：
  //   请求头 x-test-sim-download-error 存在时把 res.download 换成直接回调这个错误。
  app.use((req, res, next) => {
    if (req.headers['x-test-sim-download-error']) {
      res.download = (p, name, cb) => cb(Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { status: 500, code: 'EACCES' }));
    }
    // 模拟下载已写出首块之后才出错（M-5）：先写一点内容把头发出去，再回调错误。
    if (req.headers['x-test-sim-download-midway']) {
      res.download = (p, name, cb) => {
        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.write('partial-first-chunk');
        setImmediate(() => cb(Object.assign(new Error(`EIO: i/o error, read '${p}'`), { code: 'EIO' })));
      };
    }
    // 模拟「成功附件响应的那一次 res.json 本身抛错」（11-R L-1）：一次性，只在写出带 attachment 的成功响应时抛，
    //   随后的错误 JSON 正常返回。
    if (req.headers['x-test-sim-json-throw']) {
      const origJson = res.json.bind(res);
      let thrown = false;
      res.json = (b) => {
        if (!thrown && b && b.attachment) { thrown = true; throw new Error('boom-json-write'); }
        return origJson(b);
      };
    }
    next();
  });
  app.use('/api', routes.router);
  const server = await listenOnSafePort(app);
  const port = server.address().port;
  const ext = await extDb.open(DB_FILE);
  const fx = {
    root, UPLOAD_DIR, DB_FILE, logs, deletes, exitCalls, db, port, override, events, rules: MODS.rules,
    routes, helpers: routes.helpers, hooks: routes._internals,
    SUB: path.join(UPLOAD_DIR, 'sysbuild'),
    run: (sql, p) => extDb.run(ext, sql, p),
    get: (sql, p) => extDb.get(ext, sql, p),
    all: (sql, p) => extDb.all(ext, sql, p),
    failed: false,
    async dispose() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
      const mc = db._internals.getConnForTest && db._internals.getConnForTest();
      if (mc) await closeConn(mc);
      await closeConn(ext);
      if (this.failed && !NO_KEEP) { console.log(`  [保留现场] ${root}`); return; }
      try { removeTree(root); } catch (e) { console.log(`  [清理] 临时目录未删除: ${root} — ${e.message}`); }
    },
  };
  // 种子：项目与成员。
  const proj = async (status, pm) => (await fx.run("INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, status, created_by) VALUES ('t', 'inhouse', ?, ?, 1)", [pm, status])).lastID;
  const member = (pid, uid, opts) => fx.run(
    'INSERT INTO sysbuild_members (project_id, user_id, joined_at, removed_at, removed_reason, added_by) VALUES (?, ?, ?, ?, ?, 1)',
    [pid, uid, (opts && opts.pending) ? null : '2026-10-01 10:00:00', (opts && opts.removed) ? '2026-10-02 10:00:00' : null, (opts && opts.removed) ? '离项' : null]
  );
  fx.P1 = await proj('active', U.PM.id);
  await member(fx.P1, U.M1.id); await member(fx.P1, U.M2.id); await member(fx.P1, U.RO.id);
  await member(fx.P1, U.REMOVED.id, { removed: true }); await member(fx.P1, U.PENDING.id, { pending: true });
  fx.P2 = await proj('active', U.PM.id); await member(fx.P2, U.M1.id);
  fx.PP = await proj('paused', U.PM.id); await member(fx.PP, U.M1.id);
  fx.PT = await proj('terminated', U.PM.id); await member(fx.PT, U.M1.id);
  fx.PC = await proj('closed', U.PM.id); await member(fx.PC, U.M1.id);
  fx.PF = await proj('active', U.PM.id); // 用于「被拒绝的暂存」：从未有人成功上传，上传目录不应被创建
  await member(fx.PF, U.RO.id); await member(fx.PF, U.REMOVED.id, { removed: true }); await member(fx.PF, U.PENDING.id, { pending: true });
  fx.PRO = await proj('active', U.PM_RO.id);
  fx.PX = await proj('active', U.PM.id); await member(fx.PX, U.M3.id); // M2 用：暂存途中把 M3 标记为已移出
  fx.PD = await proj('active', U.PM.id); await member(fx.PD, U.M1.id); // L1 用：上传目录位置被一个普通文件占住
  return fx;
}

// ── HTTP 客户端 ──────────────────────────────────────────────────────────────────────
async function call(fx, user, method, urlPath, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (user) headers['x-test-user'] = JSON.stringify(user);
  let body;
  if (o.form) body = o.form;
  else if (o.rawJson !== undefined) { headers['content-type'] = 'application/json'; body = o.rawJson; }
  else if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  const r = await fetch(`http://127.0.0.1:${fx.port}/api${urlPath}`, { method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  let parsed = null;
  if (ct.includes('application/json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; } }
  return { status: r.status, headers: r.headers, buf, body: parsed };
}
function formOf(buf, filename, field) {
  const f = new FormData();
  f.append(field || 'file', new Blob([buf]), filename);
  return f;
}
const stage = (fx, user, pid, buf, filename, field) => call(fx, user, 'POST', `/sysbuild/projects/${pid}/attachments/stage`, { form: formOf(buf, filename, field) });
async function stageOk(fx, user, pid, buf, filename) {
  const r = await stage(fx, user, pid, buf, filename);
  assert.strictEqual(r.status, 200, `暂存前提失败 ${filename}: ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
  return r.body.attachment;
}
const del = (fx, user, aid) => call(fx, user, 'POST', `/sysbuild/attachments/${aid}/delete`);
const mask = (fx, user, aid, reason) => call(fx, user, 'POST', `/sysbuild/attachments/${aid}/mask`, { json: { reason } });
const download = (fx, user, aid) => call(fx, user, 'GET', `/sysbuild/attachments/${aid}/download`);
const preview = (fx, user, aid) => call(fx, user, 'GET', `/sysbuild/attachments/${aid}/preview`);
function expectErr(r, status, code, label) {
  assert.strictEqual(r.status, status, `${label || ''} 状态码应为 ${status}，实际 ${r.status} ${r.buf.toString('utf8').slice(0, 200)}`);
  assert.ok(r.body && r.body.code === code, `${label || ''} code 应为 ${code}，实际 ${JSON.stringify(r.body)}`);
}
async function expectReject(promise, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: 应当失败却成功了`);
  return err;
}
const attRow = (fx, id) => fx.get('SELECT * FROM sysbuild_attachments WHERE id = ?', [id]);
const onDisk = (fx, row) => fs.existsSync(path.join(fx.UPLOAD_DIR, row.file_name));
const eventsOf = (fx, aid, type) => fx.all('SELECT * FROM sysbuild_events WHERE object_type = ? AND object_id = ? AND event_type = ? ORDER BY id', ['attachment', aid, type]);

// ── 用例 ─────────────────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn, opts) => cases.push({ name, fn, fresh: !!(opts && opts.fresh) });

test('暂存：合法 txt 成功；sha256 / 大小与文件内容一致；行、事件、落盘位置正确', async (fx) => {
  const delBefore = fx.deletes.length;
  const r = await stage(fx, U.M1, fx.P1, TXT, 'hello.txt');
  assert.strictEqual(r.status, 200, r.buf.toString('utf8'));
  const a = r.body.attachment;
  assert.deepStrictEqual(Object.keys(a).sort(), ['id', 'is_image', 'original_name', 'sha256', 'size', 'staged_at']);
  assert.strictEqual(a.sha256, sha(TXT));
  assert.strictEqual(a.size, TXT.length);
  assert.strictEqual(a.is_image, 0);
  assert.strictEqual(a.original_name, 'hello.txt');
  const row = await attRow(fx, a.id);
  assert.strictEqual(row.project_id, fx.P1);
  assert.strictEqual(row.uploaded_by, U.M1.id);
  assert.strictEqual(row.mime_type, 'application/octet-stream');
  assert.ok(row.file_name.startsWith(`sysbuild/${fx.P1}/`) && row.file_name.endsWith('_hello.txt'), row.file_name);
  assert.ok(onDisk(fx, row), '文件应在 UPLOAD_DIR/sysbuild/<pid>/ 下');
  assert.strictEqual(sha(fs.readFileSync(path.join(fx.UPLOAD_DIR, row.file_name))), a.sha256, '落盘内容的 sha256 应与返回值一致');
  const evs = await eventsOf(fx, a.id, 'attachment_staged');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].project_id, fx.P1);
  assert.strictEqual(evs[0].operator_id, U.M1.id);
  assert.strictEqual(evs[0].operator_name, 'member1');
  assert.strictEqual(JSON.parse(evs[0].payload_json).sha256, a.sha256);
  assert.strictEqual(fx.deletes.length, delBefore, '成功的暂存不应触发任何删除');
});

test('暂存：中文原名完整保留；落盘名里的 Windows 非法字符被替换', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, '需求说明 截图（终稿）.txt');
  assert.strictEqual(a.original_name, '需求说明 截图（终稿）.txt');
  const b = await stageOk(fx, U.M1, fx.P1, TXT, 'a:b?c.txt');
  assert.strictEqual(b.original_name, 'a:b?c.txt');
  const row = await attRow(fx, b.id);
  const tail = row.file_name.slice(`sysbuild/${fx.P1}/`.length);
  assert.ok(/^\d+_[0-9a-f]{24}_a_b_c\.txt$/.test(tail), `落盘名应为 <时间戳>_<24 位十六进制>_a_b_c.txt，实际 ${tail}`);
  assert.ok(onDisk(fx, row));
});

test('暂存：白名单外扩展名 400 UPLOAD_ERROR，无文件残留、无行', async (fx) => {
  const files = listFiles(fx.SUB);
  const n = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  expectErr(await stage(fx, U.M1, fx.P1, TXT, 'evil.exe'), 400, 'UPLOAD_ERROR');
  expectErr(await stage(fx, U.M1, fx.P1, TXT, 'noext'), 400, 'UPLOAD_ERROR');
  assert.deepStrictEqual(listFiles(fx.SUB), files);
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n);
});

test('暂存：原名 201 码点 400 SYSBUILD_FILENAME_TOO_LONG；200 码点（含 BMP 外字符）通过且原名不截断', async (fx) => {
  const files = listFiles(fx.SUB);
  expectErr(await stage(fx, U.M1, fx.P1, TXT, `${'a'.repeat(197)}.txt`), 400, 'SYSBUILD_FILENAME_TOO_LONG', 'ascii 201');
  expectErr(await stage(fx, U.M1, fx.P1, TXT, `${'\u{20000}'.repeat(197)}.txt`), 400, 'SYSBUILD_FILENAME_TOO_LONG', '扩展 B 区 201');
  assert.deepStrictEqual(listFiles(fx.SUB), files, '被拒绝的长名不得留文件');
  const name200 = `${'a'.repeat(196)}.txt`;
  const a = await stageOk(fx, U.M1, fx.P1, TXT, name200);
  assert.strictEqual(Array.from(a.original_name).length, 200);
  assert.strictEqual(a.original_name, name200);
  const nameAstral = `${'\u{20000}'.repeat(196)}.txt`; // 200 个码点、396 个 UTF-16 单元
  const b = await stageOk(fx, U.M1, fx.P1, TXT, nameAstral);
  assert.strictEqual(b.original_name, nameAstral, '按码点计数：200 码点应通过，且原名不截断');
});

test('暂存：.png 扩展名但内容不是 png → 400 SYSBUILD_INVALID_INPUT，文件被清理；类型与扩展名不符同样拒绝', async (fx) => {
  const files = listFiles(fx.SUB);
  const del0 = fx.deletes.length;
  const n = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  expectErr(await stage(fx, U.M1, fx.P1, Buffer.from('this is not a png'), 'fake.png'), 400, 'SYSBUILD_INVALID_INPUT', '文本冒充 png');
  expectErr(await stage(fx, U.M1, fx.P1, JPEG_MIN, 'fake2.png'), 400, 'SYSBUILD_INVALID_INPUT', 'jpeg 冒充 png');
  expectErr(await stage(fx, U.M1, fx.P1, PNG_1X1, 'fake3.jpg'), 400, 'SYSBUILD_INVALID_INPUT', 'png 冒充 jpg');
  expectErr(await stage(fx, U.M1, fx.P1, Buffer.alloc(0), 'empty.gif'), 400, 'SYSBUILD_INVALID_INPUT', '空文件冒充 gif');
  assert.deepStrictEqual(listFiles(fx.SUB), files, '无文件残留');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n);
  assert.strictEqual(fx.deletes.length - del0, 4, '四个已落盘文件都应经回读门清理');
});

test('暂存：真实 png / jpg / jpeg / gif / webp 成功，is_image=1 且 mime_type 取识别出的类型', async (fx) => {
  const samples = [[PNG_1X1, 'a.png', 'image/png'], [JPEG_MIN, 'b.jpg', 'image/jpeg'], [JPEG_MIN, 'c.jpeg', 'image/jpeg'], [GIF_1X1, 'd.gif', 'image/gif'], [WEBP_MIN, 'e.webp', 'image/webp']];
  for (const [buf, name, mime] of samples) {
    const a = await stageOk(fx, U.M1, fx.P1, buf, name);
    assert.strictEqual(a.is_image, 1, name);
    const row = await attRow(fx, a.id);
    assert.strictEqual(row.mime_type, mime, name);
    assert.strictEqual(row.is_image, 1);
  }
  // 图片头配普通扩展名 / 配另一种图片扩展名：一律拒绝（M-3），无文件残留、无行。
  const files = listFiles(fx.SUB);
  const n = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  expectErr(await stage(fx, U.M1, fx.P1, PNG_1X1, 'sneaky.txt'), 400, 'SYSBUILD_INVALID_INPUT', 'png 头 + .txt');
  expectErr(await stage(fx, U.M1, fx.P1, PNG_1X1, 'sneaky.jpg'), 400, 'SYSBUILD_INVALID_INPUT', 'png 头 + .jpg');
  expectErr(await stage(fx, U.M1, fx.P1, JPEG_MIN, 'sneaky.png'), 400, 'SYSBUILD_INVALID_INPUT', 'jpeg 头 + .png');
  expectErr(await stage(fx, U.M1, fx.P1, GIF_1X1, 'sneaky.pdf'), 400, 'SYSBUILD_INVALID_INPUT', 'gif 头 + .pdf');
  assert.deepStrictEqual(listFiles(fx.SUB), files, '无文件残留');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n);
  // 普通文件（无图片头）仍是普通文件
  assert.strictEqual((await stageOk(fx, U.M1, fx.P1, TXT, 'plain-ok.txt')).is_image, 0);
});

test('暂存：识别为图片时大小 > 20MB → 400，无残留', async (fx) => {
  const files = listFiles(fx.SUB);
  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  PNG_1X1.copy(big);
  const r1 = await stage(fx, U.M1, fx.P1, big, 'big.png');
  expectErr(r1, 400, 'SYSBUILD_INVALID_INPUT');
  assert.ok(r1.body.message.includes('20MB'), r1.body.message);
  // 20MB 上限按文件头识别结果判，与扩展名无关：png 头 + .txt 超过 20MB，拒绝原因是大小
  const r2 = await stage(fx, U.M1, fx.P1, big, 'big.txt');
  expectErr(r2, 400, 'SYSBUILD_INVALID_INPUT');
  assert.ok(r2.body.message.includes('20MB'), `png 头 + .txt 超过 20MB 应按大小拒绝，实际: ${r2.body.message}`);
  assert.deepStrictEqual(listFiles(fx.SUB), files);
});

test('暂存权限：非成员 / 已移出 / 未加入 → 404 且 multer 没有落盘（上传目录未创建）；只读账号 → 403；不存在 / 非法项目号', async (fx) => {
  const del0 = fx.deletes.length;
  expectErr(await stage(fx, U.OUT, fx.PF, TXT, 'x.txt'), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  expectErr(await stage(fx, U.REMOVED, fx.PF, TXT, 'x.txt'), 404, 'SYSBUILD_NOT_FOUND', '已移出');
  expectErr(await stage(fx, U.PENDING, fx.PF, TXT, 'x.txt'), 404, 'SYSBUILD_NOT_FOUND', '未加入');
  expectErr(await stage(fx, U.RO, fx.PF, TXT, 'x.txt'), 403, 'SYSBUILD_FORBIDDEN', '只读账号成员');
  expectErr(await stage(fx, U.RO_OUT, fx.PF, TXT, 'x.txt'), 403, 'SYSBUILD_FORBIDDEN', '只读账号非成员（可见但不可写）');
  assert.strictEqual(fs.existsSync(path.join(fx.SUB, String(fx.PF))), false, '被拒绝的请求不得创建上传目录（multer 未落盘）');
  assert.strictEqual(fx.deletes.length, del0, '预检拒绝时不应走到清理');
  expectErr(await stage(fx, U.M1, 999999, TXT, 'x.txt'), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
  assert.strictEqual(fs.existsSync(path.join(fx.SUB, '999999')), false);
  expectErr(await stage(fx, U.M1, 'abc', TXT, 'x.txt'), 400, 'SYSBUILD_INVALID_INPUT', '非法项目号');
  assert.strictEqual((await call(fx, null, 'POST', `/sysbuild/projects/${fx.P1}/attachments/stage`, { form: formOf(TXT, 'x.txt') })).status, 401);
});

test('暂存权限：admin 非成员成功；PM 无成员行成功；成员成功；active / paused / terminated / closed 四态都能暂存', async (fx) => {
  assert.strictEqual((await attRow(fx, (await stageOk(fx, U.ADMIN, fx.P1, TXT, 'admin.txt')).id)).uploaded_by, U.ADMIN.id);
  assert.strictEqual(await fx.get('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [fx.P1, U.PM.id]), undefined, '前提：PM 在 P1 无成员行');
  await stageOk(fx, U.PM, fx.P1, TXT, 'pm.txt');
  for (const pid of [fx.P1, fx.PP, fx.PT, fx.PC]) await stageOk(fx, U.M1, pid, TXT, 'state.txt');
});

test('下载：成员成功（内容一致、头部带 nosniff 与原名）；只读非成员也能下载；admin 成功；非成员 404；参数与不存在', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'dl.txt');
  const r = await download(fx, U.M1, a.id);
  assert.strictEqual(r.status, 200);
  assert.ok(r.buf.equals(TXT));
  assert.ok((r.headers.get('content-disposition') || '').includes('dl.txt'));
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'L5 下载不得被缓存');
  assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream', 'L2 Content-Type 取存储的 mime_type，不按 .txt 推断为 text/plain');
  const pic = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'dl.png');
  const rp = await download(fx, U.M1, pic.id);
  assert.strictEqual(rp.headers.get('content-type'), 'image/png');
  assert.strictEqual(rp.headers.get('cache-control'), 'private, no-store');
  assert.strictEqual((await download(fx, U.RO_OUT, a.id)).status, 200, '§5.2 只读账号可下载');
  assert.strictEqual((await download(fx, U.ADMIN, a.id)).status, 200);
  expectErr(await download(fx, U.OUT, a.id), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  expectErr(await download(fx, U.REMOVED, a.id), 404, 'SYSBUILD_NOT_FOUND', '已移出');
  expectErr(await download(fx, U.M1, 'x'), 400, 'SYSBUILD_INVALID_INPUT');
  expectErr(await download(fx, U.M1, 999999), 404, 'SYSBUILD_NOT_FOUND');
});

test('下载：软删除后 404（含 admin）；遮蔽后成员 / PM 403 SYSBUILD_ATTACHMENT_MASKED、admin 成功', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'gone.txt');
  assert.strictEqual((await del(fx, U.PM, a.id)).status, 200);
  expectErr(await download(fx, U.M1, a.id), 404, 'SYSBUILD_NOT_FOUND', '软删除后成员');
  expectErr(await download(fx, U.ADMIN, a.id), 404, 'SYSBUILD_NOT_FOUND', '软删除后 admin');
  const b = await stageOk(fx, U.M1, fx.P1, TXT, 'masked.txt');
  assert.strictEqual((await mask(fx, U.PM, b.id, '含个人信息')).status, 200);
  expectErr(await download(fx, U.M1, b.id), 403, 'SYSBUILD_ATTACHMENT_MASKED', '遮蔽后成员');
  expectErr(await download(fx, U.PM, b.id), 403, 'SYSBUILD_ATTACHMENT_MASKED', '遮蔽后 PM');
  expectErr(await download(fx, U.RO_OUT, b.id), 403, 'SYSBUILD_ATTACHMENT_MASKED', '遮蔽后只读账号');
  const r = await download(fx, U.ADMIN, b.id);
  assert.strictEqual(r.status, 200);
  assert.ok(r.buf.equals(TXT));
});

test('下载：file_name 被改成越界路径 → 403（外部文件真实存在，只有子树校验能拦住）；文件缺失 → 404', async (fx) => {
  fs.writeFileSync(path.join(fx.root, 'outside.txt'), 'outside-of-uploads');
  fs.writeFileSync(path.join(fx.UPLOAD_DIR, 'other.txt'), 'inside-uploads-outside-sysbuild');
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'tamper.txt');
  const row = await attRow(fx, a.id);
  for (const evil of ['../outside.txt', 'sysbuild/../other.txt', path.join(fx.root, 'outside.txt')]) {
    await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [evil, a.id]);
    const r = await download(fx, U.M1, a.id);
    expectErr(r, 403, 'SYSBUILD_FORBIDDEN', evil);
    assert.ok(!r.buf.toString('utf8').includes('outside'), '不得泄漏越界文件内容');
  }
  // 目标文件根本不存在时：文本前缀检查先于存在性检查，仍是 403（不是 404）——真实路径检查对不存在的文件帮不上忙
  for (const evil of ['../does-not-exist.txt', 'sysbuild/../does-not-exist.txt']) {
    await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [evil, a.id]);
    expectErr(await download(fx, U.M1, a.id), 403, 'SYSBUILD_FORBIDDEN', `不存在的越界路径 ${evil}`);
  }
  await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [row.file_name, a.id]);
  assert.strictEqual((await download(fx, U.M1, a.id)).status, 200, '还原后恢复');
  fs.unlinkSync(path.join(fx.UPLOAD_DIR, row.file_name));
  expectErr(await download(fx, U.M1, a.id), 404, 'SYSBUILD_NOT_FOUND', '文件缺失');
});

test('预览：图片成功且四个头部全对；非图片 404；删除 / 遮蔽 / 权限与下载一致', async (fx) => {
  const name = '截图 1(终).png';
  const a = await stageOk(fx, U.M1, fx.P1, PNG_1X1, name);
  const r = await preview(fx, U.M1, a.id);
  assert.strictEqual(r.status, 200);
  assert.ok(r.buf.equals(PNG_1X1));
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.strictEqual(r.headers.get('content-disposition'), `inline; filename*=UTF-8''${encodeURIComponent(name).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'");
  assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', 'L5 预览不得被缓存');
  const t = await stageOk(fx, U.M1, fx.P1, TXT, 'plain.txt');
  expectErr(await preview(fx, U.M1, t.id), 404, 'SYSBUILD_NOT_FOUND', '非图片');
  assert.strictEqual((await preview(fx, U.RO_OUT, a.id)).status, 200);
  expectErr(await preview(fx, U.OUT, a.id), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  const m = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'm.png');
  await mask(fx, U.PM, m.id, '遮蔽测试');
  expectErr(await preview(fx, U.M1, m.id), 403, 'SYSBUILD_ATTACHMENT_MASKED');
  assert.strictEqual((await preview(fx, U.ADMIN, m.id)).status, 200);
  const d = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'd.png');
  await del(fx, U.PM, d.id);
  expectErr(await preview(fx, U.M1, d.id), 404, 'SYSBUILD_NOT_FOUND');
});

test('软删除：PM 成功（事件写入、文件仍在）；非 PM 成员 403；非成员 404；只读 PM 403；重复删除 409；已冻结 409 且未删', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'del1.txt');
  expectErr(await del(fx, U.M1, a.id), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
  expectErr(await del(fx, U.OUT, a.id), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  assert.strictEqual((await attRow(fx, a.id)).deleted_at, null);
  const r = await del(fx, U.PM, a.id);
  assert.strictEqual(r.status, 200, r.buf.toString('utf8'));
  const row = await attRow(fx, a.id);
  assert.ok(row.deleted_at, '应写入 deleted_at');
  assert.strictEqual(row.deleted_by, U.PM.id);
  assert.ok(onDisk(fx, row), '软删除不删文件');
  const evs = await eventsOf(fx, a.id, 'attachment_deleted');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].operator_id, U.PM.id);
  expectErr(await del(fx, U.PM, a.id), 409, 'SYSBUILD_STATE', '重复删除');
  assert.strictEqual((await eventsOf(fx, a.id, 'attachment_deleted')).length, 1, '重复删除不再写事件');
  const f = await stageOk(fx, U.M1, fx.P1, TXT, 'frozen.txt');
  await fx.run("INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES ('entry', 1, ?, ?)", [f.id, f.sha256]);
  expectErr(await del(fx, U.PM, f.id), 409, 'SYSBUILD_STATE', '已冻结');
  assert.strictEqual((await attRow(fx, f.id)).deleted_at, null, '被拒绝的删除不得改行');
  const p = await stageOk(fx, U.ADMIN, fx.PRO, TXT, 'ro-pm.txt');
  expectErr(await del(fx, U.PM_RO, p.id), 403, 'SYSBUILD_FORBIDDEN', '只读账号 PM');
  expectErr(await del(fx, U.M1, 999999), 404, 'SYSBUILD_NOT_FOUND');
  expectErr(await del(fx, U.M1, 'x'), 400, 'SYSBUILD_INVALID_INPUT');
});

test('遮蔽：PM 成功（原因 trim 后入库、事件写入）；空 / 超长 / 非字符串原因 400；非 PM 403；重复 409；冻结附件可遮蔽', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'mask1.txt');
  for (const bad of ['', '   ', undefined, 123, 'x'.repeat(501)]) {
    expectErr(await mask(fx, U.PM, a.id, bad), 400, 'SYSBUILD_INVALID_INPUT', `原因 ${JSON.stringify(bad)}`);
  }
  // C3a 预筛 L1：遮蔽原因与其余文本入参同一判定——C0 控制字符（含 NUL）与 DEL 拒收（400 SYSBUILD_INVALID_INPUT，field reason），保留换行 / 回车 / 制表；被拒不改行、不写事件。
  for (const bad of ['含\u0000个人信息', '含\u001F个人信息', '含\u007F个人信息', '\u0000']) {
    const r0 = await mask(fx, U.PM, a.id, bad);
    expectErr(r0, 400, 'SYSBUILD_INVALID_INPUT', `控制字符原因 ${JSON.stringify(bad)}`);
    assert.strictEqual(JSON.parse(r0.buf.toString('utf8')).field, 'reason');
  }
  assert.strictEqual((await attRow(fx, a.id)).masked_at, null, '控制字符被拒后不得改行');
  assert.strictEqual((await eventsOf(fx, a.id, 'attachment_masked')).length, 0, '控制字符被拒后不写事件');
  const nl = await stageOk(fx, U.M1, fx.P1, TXT, 'mask-newline.txt');
  assert.strictEqual((await mask(fx, U.PM, nl.id, '含个人信息\n第二行\t制表')).status, 200, '换行 / 制表保留');
  assert.strictEqual((await attRow(fx, nl.id)).mask_reason, '含个人信息\n第二行\t制表');
  expectErr(await call(fx, U.PM, 'POST', `/sysbuild/attachments/${a.id}/mask`, { rawJson: '{' }), 400, 'SYSBUILD_INVALID_INPUT', '非法 JSON');
  expectErr(await call(fx, U.PM, 'POST', `/sysbuild/attachments/${a.id}/mask`), 400, 'SYSBUILD_INVALID_INPUT', '无请求体');
  expectErr(await mask(fx, U.M1, a.id, '成员想遮蔽'), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
  expectErr(await mask(fx, U.OUT, a.id, '外人'), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  assert.strictEqual((await attRow(fx, a.id)).masked_at, null, '被拒绝的遮蔽不得改行');
  const r = await mask(fx, U.PM, a.id, '  含身份证号  ');
  assert.strictEqual(r.status, 200, r.buf.toString('utf8'));
  const row = await attRow(fx, a.id);
  assert.ok(row.masked_at);
  assert.strictEqual(row.masked_by, U.PM.id);
  assert.strictEqual(row.mask_reason, '含身份证号');
  const evs = await eventsOf(fx, a.id, 'attachment_masked');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(JSON.parse(evs[0].payload_json).reason, '含身份证号');
  expectErr(await mask(fx, U.PM, a.id, '再遮一次'), 409, 'SYSBUILD_STATE', '重复遮蔽');
  assert.strictEqual((await eventsOf(fx, a.id, 'attachment_masked')).length, 1);
  const f = await stageOk(fx, U.M1, fx.P1, TXT, 'mask-frozen.txt');
  await fx.run("INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES ('entry', 2, ?, ?)", [f.id, f.sha256]);
  assert.strictEqual((await mask(fx, U.PM, f.id, '冻结后遮蔽')).status, 200, '冻结的附件可以遮蔽');
  const g = await stageOk(fx, U.M1, fx.P1, TXT, 'mask-500.txt');
  assert.strictEqual((await mask(fx, U.PM, g.id, '字'.repeat(500))).status, 200, '500 字通过');
  const p = await stageOk(fx, U.ADMIN, fx.PRO, TXT, 'ro-pm2.txt');
  expectErr(await mask(fx, U.PM_RO, p.id, '只读 PM'), 403, 'SYSBUILD_FORBIDDEN', '只读账号 PM');
});

// ── Q8（用户裁定 2026-10-29）：事件不写原文件名；附件被遮蔽后任何接口不再返回原文件名 ──────────────────────
const Q8_NAME = '身份证 110101199001011234.png'; // 含中文、空格与一串像证件号的数字，整段与数字片段都能在输出里搜到
const Q8_DIGITS = '110101199001011234';

test('Q8 事件不写原文件名：暂存 / 删除 / 遮蔽三类事件的 payload_json 无 original_name 键，整段文本也不含原名', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  const b = await stageOk(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  const c = await stageOk(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  assert.strictEqual((await del(fx, U.PM, b.id)).status, 200);
  assert.strictEqual((await mask(fx, U.PM, c.id, '含个人信息')).status, 200);
  const cases8 = [
    ['attachment_staged', a.id, { size: PNG_1X1.length, sha256: sha(PNG_1X1), is_image: 1 }],
    ['attachment_deleted', b.id, {}],
    ['attachment_masked', c.id, { reason: '含个人信息' }],
  ];
  for (const [type, aid, expected] of cases8) {
    const evs = await eventsOf(fx, aid, type);
    assert.strictEqual(evs.length, 1, `${type} 应恰好 1 条事件`);
    const text = evs[0].payload_json;
    assert.strictEqual(typeof text, 'string', `${type} 的 payload_json 应是 JSON 文本，实际 ${text}`);
    const parsed = JSON.parse(text);
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'original_name'), `${type} 的 payload 不得有 original_name 键: ${text}`);
    assert.ok(!text.includes(Q8_NAME), `${type} 的 payload_json 不得含原文件名: ${text}`);
    assert.ok(!text.includes(Q8_DIGITS), `${type} 的 payload_json 不得含原文件名里的数字片段: ${text}`);
    assert.deepStrictEqual(parsed, expected, `${type} 的 payload 内容`);
  }
  // 原名仍在行上（不新增可更新列、不删列）：事件不写，不等于库里没有。
  assert.strictEqual((await attRow(fx, c.id)).original_name, Q8_NAME, '原名仍留在 sysbuild_attachments.original_name');
});

test('Q8 遮蔽后下载 / 预览的文件名头不含原名（含 RFC 5987 编码形式），含 attachment-<id>；未遮蔽仍用原名', async (fx) => {
  const enc = encodeURIComponent(Q8_NAME).toLowerCase();
  const leaks = (h) => {
    const v = String(h || '');
    return v.includes(Q8_NAME) || v.toLowerCase().includes(enc) || v.includes(Q8_DIGITS) || v.includes('身份证');
  };
  const a = await stageOk(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  // 遮蔽前：下载与预览都用原名（防止把正常路径也改掉）。
  const d0 = await download(fx, U.M1, a.id);
  assert.strictEqual(d0.status, 200);
  assert.ok(String(d0.headers.get('content-disposition')).toLowerCase().includes(enc), `遮蔽前下载头应含原名的编码形式: ${d0.headers.get('content-disposition')}`);
  const p0 = await preview(fx, U.M1, a.id);
  assert.strictEqual(p0.headers.get('content-disposition'), `inline; filename*=UTF-8''${encodeURIComponent(Q8_NAME)}`, '遮蔽前预览头用原名');
  // 遮蔽后：有权限的人（admin；成员 / PM 本来就 403）下载与预览。
  assert.strictEqual((await mask(fx, U.PM, a.id, '含身份证号')).status, 200);
  const d1 = await download(fx, U.ADMIN, a.id);
  assert.strictEqual(d1.status, 200);
  assert.ok(d1.buf.equals(PNG_1X1), '遮蔽后 admin 仍能取到文件内容');
  assert.ok(!leaks(d1.headers.get('content-disposition')), `遮蔽后下载头不得含原名: ${d1.headers.get('content-disposition')}`);
  assert.strictEqual(d1.headers.get('content-disposition'), `attachment; filename="attachment-${a.id}.png"`, '遮蔽后下载头 = attachment-<id>.png');
  const p1 = await preview(fx, U.ADMIN, a.id);
  assert.strictEqual(p1.status, 200);
  assert.ok(p1.buf.equals(PNG_1X1));
  assert.ok(!leaks(p1.headers.get('content-disposition')), `遮蔽后预览头不得含原名: ${p1.headers.get('content-disposition')}`);
  assert.strictEqual(p1.headers.get('content-disposition'), `inline; filename*=UTF-8''attachment-${a.id}.png`, '遮蔽后预览头 = attachment-<id>.png');
  // 权限口径不变：遮蔽后成员 / PM 仍是 403。
  expectErr(await download(fx, U.M1, a.id), 403, 'SYSBUILD_ATTACHMENT_MASKED', '遮蔽后成员下载');
  expectErr(await preview(fx, U.PM, a.id), 403, 'SYSBUILD_ATTACHMENT_MASKED', '遮蔽后 PM 预览');
  // 扩展名规范为小写：.PNG 上传，遮蔽后头里是 .png。
  const up = await stageOk(fx, U.M1, fx.P1, PNG_1X1, '大写扩展名 110101199001011234.PNG');
  assert.strictEqual((await mask(fx, U.PM, up.id, '含身份证号')).status, 200);
  assert.strictEqual((await download(fx, U.ADMIN, up.id)).headers.get('content-disposition'), `attachment; filename="attachment-${up.id}.png"`, '扩展名取小写');
  // 落盘名里的原名片段被截断到 60 码点时，file_name 的「扩展名」会变成原名的一段。
  //   期望的改动（C2-0 预筛 MED-1）：旧机制取 file_name 的扩展名再用形态正则过滤，此处期望是不加扩展名（attachment-<id>）；
  //   新机制取原名真实扩展名且必须在上传白名单内，原名的 .png 在白名单里，所以期望改为 attachment-<id>.png。
  const cutName = `${'甲'.repeat(10)}.x ${Q8_DIGITS}${'乙'.repeat(40)}.png`;
  const cut = await stageOk(fx, U.M1, fx.P1, PNG_1X1, cutName);
  assert.ok(!(await attRow(fx, cut.id)).file_name.endsWith('.png'), '前提：落盘名里的 .png 已被截断掉');
  assert.strictEqual((await mask(fx, U.PM, cut.id, '含身份证号')).status, 200);
  const dc = await download(fx, U.ADMIN, cut.id);
  assert.strictEqual(dc.headers.get('content-disposition'), `attachment; filename="attachment-${cut.id}.png"`, '截断名遮蔽后下载头整串全等');
  assert.ok(!leaks(dc.headers.get('content-disposition')));
  const pc = await preview(fx, U.ADMIN, cut.id);
  assert.strictEqual(pc.headers.get('content-disposition'), `inline; filename*=UTF-8''attachment-${cut.id}.png`);
});

test('Q8 MED-1 截断点落在原名中间的「.」之后：原名片段（手机号 / 日期前 8 位）不得经扩展名漏出，遮蔽后头部恰为 attachment-<id>.png；扩展名必须在上传白名单内', async (fx) => {
  const cases = [
    // [原名, 截断后 file_name 的 extname（前提断言，证明旧机制会漏出这一段）, 不得出现的片段]
    [`${'A'.repeat(51)}.19900101rest.png`, '.19900101', '19900101'],
    [`${'甲'.repeat(51)}.13800138000.png`, '.13800138', '13800138'],
  ];
  for (const [name, leakExt, frag] of cases) {
    const a = await stageOk(fx, U.M1, fx.P1, PNG_1X1, name);
    assert.strictEqual(path.extname((await attRow(fx, a.id)).file_name), leakExt, `前提：落盘名截断后的 extname 应是 ${leakExt}`);
    assert.strictEqual((await mask(fx, U.PM, a.id, '含个人信息')).status, 200);
    const d = await download(fx, U.ADMIN, a.id);
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.headers.get('content-disposition'), `attachment; filename="attachment-${a.id}.png"`, `${name.slice(0, 6)}… 下载头整串全等`);
    const p = await preview(fx, U.ADMIN, a.id);
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.headers.get('content-disposition'), `inline; filename*=UTF-8''attachment-${a.id}.png`, `${name.slice(0, 6)}… 预览头整串全等`);
    assert.ok(!String(d.headers.get('content-disposition')).includes(frag) && !String(p.headers.get('content-disposition')).includes(frag), '头里不得出现原名片段');
  }
  // 白名单是硬门：把库里的原名改成白名单之外的扩展名（.exe）或原名片段形态（.19900101），遮蔽后一律不加扩展名。
  //   （正常上传进不来这些扩展名，这里用外部连接改行，专测「替代名的扩展名只能是白名单里的词」。）
  const t = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'tamper.png');
  assert.strictEqual((await mask(fx, U.PM, t.id, '含个人信息')).status, 200);
  for (const evil of ['x.exe', 'x.19900101', 'x.EXE', 'noext', 'x.png.']) {
    await fx.run('UPDATE sysbuild_attachments SET original_name = ? WHERE id = ?', [evil, t.id]);
    assert.strictEqual((await download(fx, U.ADMIN, t.id)).headers.get('content-disposition'), `attachment; filename="attachment-${t.id}"`, `原名 ${evil} 不在白名单，不加扩展名`);
    assert.strictEqual((await preview(fx, U.ADMIN, t.id)).headers.get('content-disposition'), `inline; filename*=UTF-8''attachment-${t.id}`, `原名 ${evil} 预览头`);
  }
  await fx.run('UPDATE sysbuild_attachments SET original_name = ? WHERE id = ?', ['x.PNG', t.id]);
  assert.strictEqual((await download(fx, U.ADMIN, t.id)).headers.get('content-disposition'), `attachment; filename="attachment-${t.id}.png"`, '白名单内的大写扩展名取小写');
});

// codex 14 号 L-1：暂存响应里的文件名字段也经 attachmentDisplayName 构造。刚暂存的行必未遮蔽，正常路径值不变（其它用例已断言 original_name 等于上传名）；
//   这里用夹具的 withWriteTxn 替身（只包 q.get，把暂存事务里 SELECT 出来的行改成 masked_at 非空）证明响应真的经过助手：期望字段为 null、响应体里搜不到原名。
//   只在行里有 masked_at 键时才改——SELECT 漏掉该列时不补键，助手会抛 500，同样判红。
test('Q8 L-1 暂存响应的 original_name 经 attachmentDisplayName 构造：事务里读到的行已遮蔽 → 响应字段为 null，响应体不含原名', async (fx) => {
  fx.override.withWriteTxn = (fn) => fx.db.withWriteTxn((q) => fn({
    run: (s, p) => q.run(s, p),
    all: (s, p) => q.all(s, p),
    get: async (s, p) => {
      const r = await q.get(s, p);
      return (r && /^SELECT id, original_name/.test(s) && 'masked_at' in r) ? Object.assign({}, r, { masked_at: '2026-10-29 10:00:00' }) : r;
    },
  }));
  let r;
  try {
    r = await stage(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  } finally {
    fx.override.withWriteTxn = null;
  }
  assert.strictEqual(r.status, 200, r.buf.toString('utf8'));
  assert.deepStrictEqual(Object.keys(r.body.attachment).sort(), ['id', 'is_image', 'original_name', 'sha256', 'size', 'staged_at'], '响应字段名不变');
  assert.strictEqual(r.body.attachment.original_name, null, '已遮蔽的行：响应里的文件名字段应为 null（经助手取名）');
  const text = r.buf.toString('utf8');
  assert.ok(!text.includes(Q8_NAME) && !text.includes(Q8_DIGITS), `响应体不得含原名: ${text}`);
  // 对照：替身撤掉后同样的上传，字段 = 原名（防止把正常路径也改成 null）。
  const ok = await stage(fx, U.M1, fx.P1, PNG_1X1, Q8_NAME);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.attachment.original_name, Q8_NAME);
});

test('Q8 attachmentDisplayName：未遮蔽返回原名；已遮蔽返回 null；masked_at 缺键 / undefined 抛 500 SYSBUILD_INTERNAL（fail-closed），null 视为未遮蔽', async () => {
  const f = MODS.att.attachmentDisplayName;
  assert.strictEqual(typeof f, 'function', 'attachments.js 应导出 attachmentDisplayName');
  assert.strictEqual(f({ original_name: '合同 终稿.pdf', masked_at: null }), '合同 终稿.pdf');
  assert.strictEqual(f({ original_name: '合同 终稿.pdf', masked_at: '2026-10-29 10:00:00' }), null);
  for (const [label, att] of [['缺键', { original_name: '合同 终稿.pdf' }], ['值为 undefined', { original_name: '合同 终稿.pdf', masked_at: undefined }]]) {
    let err = null;
    let got;
    try { got = f(att); } catch (e) { err = e; }
    assert.ok(err, `masked_at ${label} 应抛错，实际返回 ${JSON.stringify(got)}`);
    assert.strictEqual(err.status, 500, `${label} 状态码`);
    assert.strictEqual(err.code, 'SYSBUILD_INTERNAL', `${label} 错误码`);
    assert.strictEqual(err.message, '内部错误：附件显示名缺遮蔽状态', `${label} 文案`);
  }
});

test('事件助手：已登记类型写入（payload 为 JSON）；未登记类型 500 SYSBUILD_INTERNAL 且事务回滚', async (fx) => {
  const { writeEvent, EVENT_TYPES } = fx.events;
  for (const t of ['attachment_staged', 'attachment_bound', 'attachment_frozen', 'attachment_deleted', 'attachment_masked']) assert.ok(EVENT_TYPES.includes(t), t);
  const base = { projectId: fx.P1, objectType: 'attachment', objectId: 1, operatorId: 11, operatorName: 'pm' };
  await fx.db.withWriteTxn((q) => writeEvent(q, Object.assign({ eventType: 'attachment_masked', payload: { k: '值' } }, base)));
  const row = await fx.get("SELECT * FROM sysbuild_events WHERE event_type = 'attachment_masked' AND object_id = 1 AND operator_name = 'pm' ORDER BY id DESC LIMIT 1");
  assert.deepStrictEqual(JSON.parse(row.payload_json), { k: '值' });
  const n0 = (await fx.get('SELECT COUNT(*) n FROM sysbuild_events')).n;
  const e = await expectReject(fx.db.withWriteTxn(async (q) => {
    await writeEvent(q, Object.assign({ eventType: 'attachment_masked', payload: {} }, base));
    await writeEvent(q, Object.assign({ eventType: 'bogus_type', payload: {} }, base));
  }), '未登记类型');
  assert.strictEqual(e.status, 500);
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_events')).n, n0, '同事务内先写的事件一并回滚');
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_events WHERE event_type = 'bogus_type'")).n, 0);
});

test('绑定助手：本人 / 本项目 / 未绑定 / 24 小时内成功；别人的、别的项目的、已绑定的、已删除的、超过 24 小时的各自 400 且整批不写入；ownerType 非法抛错', async (fx) => {
  const bind = (args) => fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, Object.assign({ projectId: fx.P1, userId: U.M1.id, ownerType: 'entry', ownerId: 701, operatorName: 'member1' }, args)));
  const bindings = async (id) => (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [id])).n;
  const a1 = await stageOk(fx, U.M1, fx.P1, TXT, 'b1.txt');
  const a2 = await stageOk(fx, U.M1, fx.P1, TXT, 'b2.txt');
  const ids = await bind({ attachmentIds: [a1.id, a2.id] });
  assert.deepStrictEqual(ids, [a1.id, a2.id]);
  for (const a of [a1, a2]) {
    const b = await fx.get('SELECT * FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [a.id]);
    assert.strictEqual(b.owner_type, 'entry');
    assert.strictEqual(b.owner_id, 701);
    assert.strictEqual(b.bound_by, U.M1.id);
    const evs = await eventsOf(fx, a.id, 'attachment_bound');
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].operator_name, 'member1');
  }
  const good = await stageOk(fx, U.M1, fx.P1, TXT, 'good.txt');
  const others = await stageOk(fx, U.M2, fx.P1, TXT, 'others.txt');
  const otherProject = await stageOk(fx, U.M1, fx.P2, TXT, 'p2.txt');
  const deleted = await stageOk(fx, U.M1, fx.P1, TXT, 'deleted.txt');
  assert.strictEqual((await del(fx, U.PM, deleted.id)).status, 200);
  const bad = [
    ['别人上传的', [good.id, others.id], null],
    ['别的项目的', [good.id, otherProject.id], null],
    ['已绑定的', [good.id, a1.id], null],
    ['已删除的', [good.id, deleted.id], null],
    ['不存在的', [good.id, 99999999], null],
    ['重复编号', [good.id, good.id], null],
  ];
  for (const [label, attachmentIds] of bad) {
    const e = await expectReject(bind({ attachmentIds }), label);
    assert.strictEqual(e.status, 400, label);
    assert.strictEqual(e.code, 'SYSBUILD_INVALID_INPUT', label);
    assert.strictEqual(await bindings(good.id), 0, `${label}：整批不写入`);
  }
  const late = await expectReject(bind({ attachmentIds: [good.id], now: new Date(Date.now() + 25 * 3600 * 1000) }), '超过 24 小时');
  assert.strictEqual(late.status, 400);
  assert.strictEqual(late.code, 'SYSBUILD_INVALID_INPUT');
  assert.ok(late.message.includes('24 小时'), late.message);
  assert.strictEqual(await bindings(good.id), 0);
  const badType = await expectReject(bind({ attachmentIds: [good.id], ownerType: 'bogus_owner' }), 'ownerType 非法');
  assert.strictEqual(badType.code, 'SYSBUILD_INTERNAL');
  assert.strictEqual(await bindings(good.id), 0);
  const ok23 = await bind({ attachmentIds: [good.id], now: new Date(Date.now() + 23 * 3600 * 1000) });
  assert.deepStrictEqual(ok23, [good.id], '23 小时内仍可绑定');
});

test('C3b 预筛 D5(a) 绑定助手拒绝已遮蔽的暂存附件：400 同一句「附件不存在或不可用」、整批不写入；对照：未遮蔽的同批附件照常绑定', async (fx) => {
  const bind = (attachmentIds) => fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds, ownerType: 'entry', ownerId: 705, operatorName: 'member1' }));
  const bindings = async (id) => (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [id])).n;
  const fine = await stageOk(fx, U.M1, fx.P1, TXT, 'd5-fine.txt');
  const masked = await stageOk(fx, U.M1, fx.P1, TXT, 'd5-masked.txt');
  assert.strictEqual((await mask(fx, U.PM, masked.id, '含敏感信息')).status, 200);
  const deleted = await stageOk(fx, U.M1, fx.P1, TXT, 'd5-deleted.txt');
  assert.strictEqual((await del(fx, U.PM, deleted.id)).status, 200);
  const eMasked = await expectReject(bind([fine.id, masked.id]), '已遮蔽的暂存附件');
  const eDeleted = await expectReject(bind([fine.id, deleted.id]), '已删除的暂存附件');
  assert.strictEqual(eMasked.status, 400);
  assert.strictEqual(eMasked.code, 'SYSBUILD_INVALID_INPUT');
  assert.strictEqual(eMasked.field, 'attachment_ids');
  assert.strictEqual(eMasked.message, eDeleted.message, '遮蔽与已删除是同一句提示（不借此探测）');
  assert.strictEqual(await bindings(fine.id), 0, '整批不写入');
  assert.strictEqual(await bindings(masked.id), 0);
  assert.deepStrictEqual(await bind([fine.id]), [fine.id], '对照：未遮蔽的附件照常绑定');
});

test('冻结助手：只冻结已绑定且未删除的；清单 sha256 与附件一致；冻结后不能软删除、可以遮蔽', async (fx) => {
  const b1 = await stageOk(fx, U.M1, fx.P1, Buffer.from('one'), 'f1.txt');
  const b2 = await stageOk(fx, U.M1, fx.P1, Buffer.from('two'), 'f2.txt');
  const b3 = await stageOk(fx, U.M1, fx.P1, Buffer.from('three'), 'f3.txt');
  const b4 = await stageOk(fx, U.M1, fx.P1, Buffer.from('four'), 'f4.txt');
  await fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds: [b1.id, b2.id, b3.id], ownerType: 'entry', ownerId: 702 }));
  assert.strictEqual((await del(fx, U.PM, b3.id)).status, 200, '已绑定但未冻结的可以软删除');
  const freeze = (extra) => fx.db.withWriteTxn((q) => fx.helpers.freezeAttachmentSet(q, Object.assign({ objectType: 'entry', objectVersionId: 9001, ownerType: 'entry', ownerId: 702, operatorId: U.PM.id, operatorName: 'pm', projectId: fx.P1 }, extra)));
  const list = await freeze();
  assert.deepStrictEqual(list, [{ attachment_id: b1.id, sha256: b1.sha256 }, { attachment_id: b2.id, sha256: b2.sha256 }]);
  assert.strictEqual(b1.sha256, sha(Buffer.from('one')));
  const rows = await fx.all('SELECT attachment_id, sha256, object_type, object_version_id FROM sysbuild_frozen_attachments WHERE object_version_id = 9001 ORDER BY attachment_id');
  assert.deepStrictEqual(rows.map((r) => [r.attachment_id, r.sha256, r.object_type]), [[b1.id, b1.sha256, 'entry'], [b2.id, b2.sha256, 'entry']], '未绑定与已删除的不应进入冻结清单');
  assert.strictEqual((await eventsOf(fx, b1.id, 'attachment_frozen')).length, 1);
  assert.strictEqual((await eventsOf(fx, b3.id, 'attachment_frozen')).length, 0);
  const isFrozen = (id) => fx.db.withRead((q) => fx.helpers.isAttachmentFrozen(q, id));
  assert.strictEqual(await isFrozen(b1.id), true);
  assert.strictEqual(await isFrozen(b4.id), false);
  assert.strictEqual(await isFrozen(b3.id), false);
  const frozenDel = await del(fx, U.PM, b1.id);
  expectErr(frozenDel, 409, 'SYSBUILD_STATE', '冻结后软删除');
  assert.strictEqual(frozenDel.body.message, '附件已被确认版本引用，不能删除；如需隐藏请由项目经理遮蔽', '冻结那句文案不变（小修批 F1）');
  assert.strictEqual((await mask(fx, U.PM, b1.id, '冻结后遮蔽')).status, 200);
  assert.deepStrictEqual(await freeze({ ownerId: 799 }), [], '没有绑定的 owner 返回空清单');
  const e = await expectReject(freeze({ objectType: 'bogus_object' }), 'objectType 非法');
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
});

test('C4b 预筛 D1 凭据附件不可普通软删除（不变量 9，同模式全扫 P59）：绑定为 confirmation / history_import / schedule_record 的附件软删除 409 且未删、可遮蔽；绑定为 entry 等非凭据类型的仍可软删除', async (fx) => {
  const bind = (ids, ownerType, ownerId) => fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds: ids, ownerType, ownerId }));
  for (const [ot, oid] of [['confirmation', 801], ['history_import', 802], ['schedule_record', 803], ['event', 805]]) { // C4b Q-S2：历史补录窗口开启 / 关闭 / 重开的凭据以 event 绑定
    const a = await stageOk(fx, U.M1, fx.P1, Buffer.from(`d1-${ot}`), `d1-${ot}.txt`);
    await bind([a.id], ot, oid);
    const r = await del(fx, U.PM, a.id);
    expectErr(r, 409, 'SYSBUILD_STATE', `${ot} 凭据不可软删除`);
    assert.strictEqual(r.body.message, '附件已作为确认 / 改期凭据，不能删除；如需隐藏请由项目经理遮蔽', `${ot} 提示（小修批 F1：凭据另用「确认 / 改期凭据」文案，冻结那句不变）`);
    assert.strictEqual((await fx.get('SELECT deleted_at FROM sysbuild_attachments WHERE id = ?', [a.id])).deleted_at, null, `${ot} 被拒的删除不改附件`);
    assert.strictEqual((await eventsOf(fx, a.id, 'attachment_deleted')).length, 0, `${ot} 被拒的删除不写事件`);
    assert.strictEqual((await mask(fx, U.PM, a.id, `${ot} 凭据遮蔽`)).status, 200, `${ot} 凭据仍可受控遮蔽`);
  }
  const plain = await stageOk(fx, U.M1, fx.P1, Buffer.from('d1-entry'), 'd1-entry.txt');
  await bind([plain.id], 'entry', 804);
  assert.strictEqual((await del(fx, U.PM, plain.id)).status, 200, '绑定为 entry 的非凭据附件仍可软删除');
});

test('C3b 冻结取集 = 绑定 ∪ 引用：引用来的附件进入冻结清单；引用的软删除附件不进；同一附件既绑定又引用只冻结一次；他对象的引用不串入', async (fx) => {
  const own = await stageOk(fx, U.M1, fx.P1, Buffer.from('own-bound'), 'c3b-own.txt');
  const viaRef = await stageOk(fx, U.M1, fx.P1, Buffer.from('via-ref'), 'c3b-ref.txt');
  const refDeleted = await stageOk(fx, U.M1, fx.P1, Buffer.from('ref-deleted'), 'c3b-refdel.txt');
  const other = await stageOk(fx, U.M1, fx.P1, Buffer.from('other-owner'), 'c3b-other.txt');
  await fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds: [own.id, viaRef.id, refDeleted.id, other.id], ownerType: 'item_version', ownerId: 711 }));
  const addRef = (aid, ownerId) => fx.run("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'item_version', ?, ?)", [fx.P1, aid, ownerId, U.M1.id]);
  await addRef(viaRef.id, 712);
  await addRef(refDeleted.id, 712);
  await addRef(own.id, 712);
  await addRef(other.id, 713);
  // 同号但不同类型的所属对象（material_version 712）的引用不得串入 item_version 712 的取集
  await fx.run("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'material_version', 712, ?)", [fx.P1, other.id, U.M1.id]);
  assert.strictEqual((await del(fx, U.PM, refDeleted.id)).status, 200, '被引用但未冻结的附件可以软删除');
  const freeze = (ownerId, versionId) => fx.db.withWriteTxn((q) => fx.helpers.freezeAttachmentSet(q, { objectType: 'item_version', objectVersionId: versionId, ownerType: 'item_version', ownerId, operatorId: U.PM.id, operatorName: 'pm', projectId: fx.P1 }));
  const list712 = await freeze(712, 9712);
  assert.deepStrictEqual(list712.map((x) => x.attachment_id), [own.id, viaRef.id], '712 只有引用：own（绑定在 711，引用到 712）与 viaRef；已删除的引用不进');
  assert.deepStrictEqual(list712.map((x) => x.sha256), [own.sha256, viaRef.sha256]);
  const rows = await fx.all("SELECT attachment_id FROM sysbuild_frozen_attachments WHERE object_type = 'item_version' AND object_version_id = 9712 ORDER BY attachment_id");
  assert.deepStrictEqual(rows.map((r) => r.attachment_id), [own.id, viaRef.id], '冻结清单落库');
  // 711 是绑定来源：own / viaRef / other 在 711 名下（refDeleted 已软删除不进）；引用到 712 / 713 的行不影响 711 的取集，也不重复
  const list711 = await freeze(711, 9711);
  assert.deepStrictEqual(list711.map((x) => x.attachment_id), [own.id, viaRef.id, other.id], '711 只算绑定，且去掉已删除的');
  // 同一附件既绑定又引用到同一对象：只冻结一次（去重）
  await addRef(own.id, 711);
  const list711b = await freeze(711, 9714);
  assert.deepStrictEqual(list711b.map((x) => x.attachment_id), [own.id, viaRef.id, other.id], '既绑定又引用只算一次');
  assert.deepStrictEqual((await freeze(713, 9713)).map((x) => x.attachment_id), [other.id], '713 只拿到自己名下的引用');
  assert.deepStrictEqual(await freeze(799, 9799), [], '没有绑定也没有引用的 owner 返回空清单');
  expectErr(await del(fx, U.PM, viaRef.id), 409, 'SYSBUILD_STATE', '引用来的附件被冻结后不能软删除');
});

test('multer 错误：超限 / 字段名不符 / 无文件 → 400，无残留', async (fx) => {
  const files = listFiles(fx.SUB);
  const n = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  fx.hooks.setFileSizeLimit(10);
  try {
    expectErr(await stage(fx, U.M1, fx.P1, Buffer.alloc(100, 97), 'toolarge.txt'), 400, 'LIMIT_FILE_SIZE');
  } finally { fx.hooks.setFileSizeLimit(0); }
  expectErr(await stage(fx, U.M1, fx.P1, TXT, 'wrongfield.txt', 'files'), 400, 'LIMIT_UNEXPECTED_FILE');
  const empty = new FormData();
  empty.append('note', 'no file here');
  expectErr(await call(fx, U.M1, 'POST', `/sysbuild/projects/${fx.P1}/attachments/stage`, { form: empty }), 400, 'SYSBUILD_INVALID_INPUT');
  assert.deepStrictEqual(listFiles(fx.SUB), files);
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n);
});

// ── 回读门（派单第 5 节 / 09-R3 五条验收条件）──────────────────────────────────────────
function seenName(holder) { assert.ok(holder.name, '钩子应已收到文件名'); return holder.name; }
function orphanLogged(fx, rel) { return fx.logs.some((l) => l.level === 'error' && l.msg.includes('孤儿文件待人工核对') && l.msg.includes(rel.split('/').pop())); }

test('回读门 ①：事务已提交、提交后步骤抛错 → 请求失败，文件保留、行存在、不触发删除', async (fx) => {
  const del0 = fx.deletes.length;
  fx.hooks.setAfterStageCommit(() => { throw new Error('boom-after-commit'); });
  let r;
  try { r = await stage(fx, U.M1, fx.P1, TXT, 'gate1.txt'); } finally { fx.hooks.setAfterStageCommit(null); }
  expectErr(r, 500, 'SYSBUILD_INTERNAL');
  assert.ok(!JSON.stringify(r.body).includes('boom'), '不回内部细节');
  const row = await fx.get("SELECT * FROM sysbuild_attachments WHERE original_name = 'gate1.txt'");
  assert.ok(row, '已提交的行应存在');
  assert.ok(onDisk(fx, row), '被已提交记录引用的文件必须保留');
  assert.strictEqual(fx.deletes.length, del0, '回读看到引用后不得调用删除');
});

test('回读门 ②：事务失败回滚 → 行不存在、文件删除（经回读确认无引用）', async (fx) => {
  const holder = {};
  fx.hooks.setFailStageTxn((info) => { holder.name = info.fileName; throw new Error('boom-in-txn'); });
  let r;
  try { r = await stage(fx, U.M1, fx.P1, TXT, 'gate2.txt'); } finally { fx.hooks.setFailStageTxn(null); }
  expectErr(r, 500, 'SYSBUILD_INTERNAL');
  const rel = seenName(holder);
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_attachments WHERE original_name = 'gate2.txt'")).n, 0, '回滚后无行');
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_events WHERE payload_json LIKE '%gate2.txt%'")).n, 0, '事件一并回滚');
  assert.strictEqual(fs.existsSync(path.join(fx.UPLOAD_DIR, rel)), false, '无引用的文件应被删除');
  assert.deepStrictEqual(fx.deletes.filter((d) => d === rel), [rel], '恰好经 safeDeleteFileSync 删一次');
});

test('回读门 ③：事务失败且回读失败（模块进入故障）→ 文件保留，日志含「孤儿文件待人工核对」', async (fx) => {
  const holder = {};
  fx.hooks.setFailStageTxn((info) => { holder.name = info.fileName; throw new Error('boom-in-txn'); });
  fx.hooks.setBeforeReadback(async () => { await withTimeout(fx.db._internals.enterFaultForTest('回读门③注入'), 5000, '故障关闭落定'); });
  let r;
  try { r = await stage(fx, U.M1, fx.P1, TXT, 'gate3.txt'); } finally { fx.hooks.setFailStageTxn(null); fx.hooks.setBeforeReadback(null); }
  expectErr(r, 500, 'SYSBUILD_INTERNAL');
  const rel = seenName(holder);
  assert.strictEqual(fx.db.getReadiness().ready, false, '前提：模块已进入故障');
  assert.ok(fs.existsSync(path.join(fx.UPLOAD_DIR, rel)), '回读失败时文件必须保留');
  assert.strictEqual(fx.deletes.length, 0, '不得调用删除');
  assert.ok(orphanLogged(fx, rel), '应记「孤儿文件待人工核对」并带文件名');
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_attachments WHERE original_name = 'gate3.txt'")).n, 0, '前提：事务确已回滚（保留的是孤儿）');
}, { fresh: true });

test('回读门 ④：回读到引用（任何一行都算：未删除 / 已软删除并遮蔽）→ 文件保留', async (fx) => {
  for (const variant of ['live', 'deleted-and-masked']) {
    const name = `gate4-${variant}.txt`;
    const holder = {};
    fx.hooks.setFailStageTxn((info) => { holder.name = info.fileName; throw new Error('boom-in-txn'); });
    fx.hooks.setBeforeReadback(async (info) => {
      if (variant === 'live') {
        await fx.run('INSERT INTO sysbuild_attachments (project_id, file_name, original_name, size, sha256, uploaded_by) VALUES (?, ?, ?, 1, ?, 12)', [fx.P1, info.fileName, 'ref.txt', '0'.repeat(64)]);
      } else {
        await fx.run("INSERT INTO sysbuild_attachments (project_id, file_name, original_name, size, sha256, uploaded_by, deleted_at, deleted_by, masked_at, masked_by, mask_reason) VALUES (?, ?, ?, 1, ?, 12, '2026-10-01 10:00:00', 11, '2026-10-01 10:00:00', 11, '测试')", [fx.P1, info.fileName, 'ref.txt', '0'.repeat(64)]);
      }
    });
    const del0 = fx.deletes.length;
    let r;
    try { r = await stage(fx, U.M1, fx.P1, TXT, name); } finally { fx.hooks.setFailStageTxn(null); fx.hooks.setBeforeReadback(null); }
    expectErr(r, 500, 'SYSBUILD_INTERNAL', variant);
    const rel = seenName(holder);
    assert.ok(fs.existsSync(path.join(fx.UPLOAD_DIR, rel)), `${variant}：有引用的文件必须保留`);
    assert.strictEqual(fx.deletes.length, del0, `${variant}：不得调用删除`);
    assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments WHERE file_name = ?', [rel])).n, 1);
  }
});

test('回读门 ⑤：回读查询失败（503）或结果缺失 / 格式异常 → 一律保留并记孤儿日志，绝不当作无引用', async (fx) => {
  const { makeError } = MODS.dbMod;
  const variants = [
    ['查询抛 503', async () => { throw makeError(503, 'SYSBUILD_BUSY', '系统繁忙'); }],
    ['结果为 undefined', async () => undefined],
    ['结果为 null', async () => null],
    ['缺少 n', async () => ({})],
    ['n 是字符串 "0"', async () => ({ n: '0' })],
    ['n 是 null', async () => ({ n: null })],
    ['n 为负数', async () => ({ n: -1 })],
    ['n 非整数', async () => ({ n: 0.5 })],
  ];
  for (const [label, impl] of variants) {
    const holder = {};
    fx.hooks.setFailStageTxn((info) => { holder.name = info.fileName; throw new Error('boom-in-txn'); });
    fx.hooks.setBeforeReadback(async () => { fx.override.withRead = impl; });
    const del0 = fx.deletes.length;
    const logs0 = fx.logs.length;
    let r;
    try { r = await stage(fx, U.M1, fx.P1, TXT, 'gate5.txt'); } finally { fx.hooks.setFailStageTxn(null); fx.hooks.setBeforeReadback(null); fx.override.withRead = null; }
    expectErr(r, 500, 'SYSBUILD_INTERNAL', label);
    const rel = seenName(holder);
    assert.ok(fs.existsSync(path.join(fx.UPLOAD_DIR, rel)), `${label}：文件必须保留`);
    assert.strictEqual(fx.deletes.length, del0, `${label}：不得调用删除`);
    assert.ok(fx.logs.slice(logs0).some((l) => l.level === 'error' && l.msg.includes('孤儿文件待人工核对')), `${label}：应记孤儿日志`);
  }
});

// ── 预筛修订（H1 / M1–M3 / L1–L7）新增用例 ─────────────────────────────────────────────
test('M1 readonlyIds 必填：工厂缺失 / 类型不对抛错；loadProjectAccess 缺失抛 500 SYSBUILD_INTERNAL（不回落为空集合）；Set 与数组都接受', async (fx) => {
  const base = { db: fx.db, logger: { info() {}, warn() {}, error() {} }, UPLOAD_DIR: fx.UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync: () => true, COLLAB_ALLOWED_EXTS_UNION: TEST_EXTS };
  for (const bad of [undefined, null, '13,16', { 0: 13 }, 13]) {
    assert.throws(() => MODS.att.createAttachmentRoutes(Object.assign({}, base, { readonlyIds: bad })), /readonlyIds/, `readonlyIds=${JSON.stringify(bad)}`);
  }
  MODS.att.createAttachmentRoutes(Object.assign({}, base, { readonlyIds: new Set([13]) }));
  MODS.att.createAttachmentRoutes(Object.assign({}, base, { readonlyIds: [] }));
  const load = (opts) => fx.db.withRead((q) => MODS.rules.loadProjectAccess(q, fx.P1, U.M1, opts));
  for (const [label, opts] of [['无 opts', undefined], ['空 opts', {}], ['undefined', { readonlyIds: undefined }], ['null', { readonlyIds: null }], ['字符串', { readonlyIds: '12' }]]) {
    const e = await expectReject(load(opts), `loadProjectAccess ${label}`);
    assert.strictEqual(e.status, 500, label);
    assert.strictEqual(e.code, 'SYSBUILD_INTERNAL', label);
  }
  assert.strictEqual((await load({ readonlyIds: new Set([U.M1.id]) })).isReadonly, true, 'Set 被接受');
  assert.strictEqual((await load({ readonlyIds: [String(U.M1.id)] })).isReadonly, true, '数组元素按数字比较');
  assert.strictEqual((await load({ readonlyIds: [] })).isReadonly, false);
});

test('M2 事务内重做预检：预检之后、事务之前成员被移出 → 404，库里无行，文件经回读门删除恰一次', async (fx) => {
  const holder = {};
  fx.hooks.setBeforeStageTxn(async (info) => {
    holder.name = info.fileName;
    await fx.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = '离项' WHERE project_id = ? AND user_id = ?", [fx.PX, U.M3.id]);
  });
  const del0 = fx.deletes.length;
  let r;
  try { r = await stage(fx, U.M3, fx.PX, TXT, 'm2.txt'); } finally { fx.hooks.setBeforeStageTxn(null); }
  expectErr(r, 404, 'SYSBUILD_NOT_FOUND');
  const rel = seenName(holder);
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_attachments WHERE original_name = 'm2.txt'")).n, 0, '库里不应有行');
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_events WHERE payload_json LIKE '%\"m2.txt\"%'")).n, 0, '不应有事件');
  assert.strictEqual(fs.existsSync(path.join(fx.UPLOAD_DIR, rel)), false, '文件应被回读门删除');
  assert.deepStrictEqual(fx.deletes.slice(del0), [rel], '恰好删一次');
});

test('M3 大文件：1MB 伪随机内容（超过 64KB 读块）→ 返回值与库里的 sha256 / size 都与对原缓冲区直接计算一致', async (fx) => {
  const big = crypto.randomBytes(1024 * 1024);
  const a = await stageOk(fx, U.M1, fx.P1, big, 'big.txt');
  assert.strictEqual(a.size, big.length);
  assert.strictEqual(a.sha256, sha(big));
  const row = await attRow(fx, a.id);
  assert.strictEqual(row.size, big.length);
  assert.strictEqual(row.sha256, sha(big));
  assert.ok(fs.readFileSync(path.join(fx.UPLOAD_DIR, row.file_name)).equals(big), '落盘内容逐字节一致');
});

test('L1 系统错误不外泄：下载阶段 EACCES（status 500）→ SYSBUILD_INTERNAL 通用文案；预览读流出错 → JSON 500 且不带图片头；目录被占 → 500 不是 400', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'l1.txt');
  const r = await call(fx, U.M1, 'GET', `/sysbuild/attachments/${a.id}/download`, { headers: { 'x-test-sim-download-error': '1' } });
  expectErr(r, 500, 'SYSBUILD_INTERNAL', '下载系统错误');
  assert.strictEqual(r.body.message, '内部错误');
  const text = r.buf.toString('utf8');
  assert.ok(!text.includes('EACCES') && !text.includes(fx.root) && !text.includes('l1.txt'), `不得含路径 / 系统错误码: ${text}`);
  assert.ok((r.headers.get('content-type') || '').includes('application/json'), '错误体是 JSON，Content-Type 不能还是文件类型');
  assert.ok(fx.logs.some((l) => l.level === 'error' && l.msg.includes('EACCES')), '原始错误应记日志');
  // 预览：读流出错（替换 fs.createReadStream 一次）
  const img = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'l1.png');
  const orig = fs.createReadStream;
  fs.createReadStream = (p) => new Readable({ read() { this.destroy(Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })); } });
  let rp;
  try { rp = await preview(fx, U.M1, img.id); } finally { fs.createReadStream = orig; }
  expectErr(rp, 500, 'SYSBUILD_INTERNAL', '预览读流出错');
  assert.ok((rp.headers.get('content-type') || '').includes('application/json'), `Content-Type 应恢复为 JSON，实际 ${rp.headers.get('content-type')}`);
  assert.strictEqual(rp.headers.get('content-disposition'), null);
  assert.ok(!rp.buf.toString('utf8').includes('EACCES') && !rp.buf.toString('utf8').includes(fx.root));
  // multer 非 MulterError（目录位置被一个普通文件占住 → mkdir 报 EEXIST）：500，不回原始 message
  fs.writeFileSync(path.join(fx.SUB, String(fx.PD)), 'i am a file, not a directory');
  const files = listFiles(fx.SUB);
  const rd = await stage(fx, U.M1, fx.PD, TXT, 'l1d.txt');
  expectErr(rd, 500, 'SYSBUILD_INTERNAL', 'multer 非 Multer 错误');
  assert.ok(!rd.buf.toString('utf8').includes('EEXIST') && !rd.buf.toString('utf8').includes(fx.root));
  assert.deepStrictEqual(listFiles(fx.SUB), files);
});

// 手工构造 multipart：用 RFC 5987 的 filename*=UTF-8''<百分号编码> 才能让文件名里出现 \r \n（FormData 会把它们转义掉）。
async function rawStage(fx, user, pid, encodedName, content) {
  const boundary = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${encodedName}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'latin1'), content, Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1')]);
  const r = await fetch(`http://127.0.0.1:${fx.port}/api/sysbuild/projects/${pid}/attachments/stage`, {
    method: 'POST', headers: { 'x-test-user': JSON.stringify(user), 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
  return { status: r.status, headers: r.headers, buf, body: parsed };
}
test('L3 原文件名整体含控制字符 → 400 SYSBUILD_INVALID_INPUT，不落盘（前后的 \\r\\n \\t 会被 trim 吃掉，不能只靠扩展名检查）', async (fx) => {
  const ok = await rawStage(fx, U.M1, fx.P1, '%E4%B8%AD.txt', TXT);
  assert.strictEqual(ok.status, 200, `对照：filename* 应被解码，${ok.buf.toString('utf8')}`);
  assert.strictEqual(ok.body.attachment.original_name, '中.txt');
  const files = listFiles(fx.SUB);
  const n = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  for (const [label, enc] of [['\\r\\nfoo.txt', '%0D%0Afoo.txt'], ['\\tbar.txt', '%09bar.txt'], ['中间 \\n', 'a%0Ab.txt'], ['DEL', 'a%7Fb.txt']]) {
    expectErr(await rawStage(fx, U.M1, fx.P1, enc, TXT), 400, 'SYSBUILD_INVALID_INPUT', label);
  }
  assert.deepStrictEqual(listFiles(fx.SUB), files, '无文件残留');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n);
});

test('L4 不存在的提示统一：不存在的编号与他人项目里的编号，响应体逐字节相同（下载 / 预览 / 删除 / 遮蔽 / 暂存）', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, PNG_1X1, 'l4.png');
  const pairs = [
    ['下载', (id) => download(fx, U.OUT, id)],
    ['预览', (id) => preview(fx, U.OUT, id)],
    ['删除', (id) => del(fx, U.OUT, id)],
    ['遮蔽', (id) => mask(fx, U.OUT, id, '外人')],
  ];
  for (const [label, f] of pairs) {
    const exists = await f(a.id);
    const missing = await f(99999999);
    expectErr(exists, 404, 'SYSBUILD_NOT_FOUND', `${label} 存在的`);
    expectErr(missing, 404, 'SYSBUILD_NOT_FOUND', `${label} 不存在的`);
    assert.ok(exists.buf.equals(missing.buf), `${label}：响应体应逐字节相同: ${exists.buf} vs ${missing.buf}`);
  }
  const s1 = await stage(fx, U.OUT, fx.P1, TXT, 'x.txt');
  const s2 = await stage(fx, U.OUT, 99999999, TXT, 'x.txt');
  expectErr(s1, 404, 'SYSBUILD_NOT_FOUND', '暂存 存在的项目');
  assert.ok(s1.buf.equals(s2.buf), `暂存：项目存在与不存在的响应体应相同: ${s1.buf} vs ${s2.buf}`);
  // 附件的 404 与项目的 404 也是同一句
  assert.ok((await download(fx, U.OUT, 99999999)).buf.equals(s2.buf), '附件与项目的不存在提示相同');
});

test('L6 补充：冻结助手拒绝他项目附件；压缩包可上传；admin 非 PM 不能遮蔽 / 软删除', async (fx) => {
  const c1 = await stageOk(fx, U.M1, fx.P1, TXT, 'cross1.txt');
  await fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds: [c1.id], ownerType: 'entry', ownerId: 703 }));
  const e = await expectReject(fx.db.withWriteTxn((q) => fx.helpers.freezeAttachmentSet(q, { objectType: 'entry', objectVersionId: 9100, ownerType: 'entry', ownerId: 703, operatorId: 11, operatorName: 'pm', projectId: fx.P2 })), '冻结他项目附件');
  assert.strictEqual(e.status, 500);
  assert.strictEqual(e.code, 'SYSBUILD_INTERNAL');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_frozen_attachments WHERE attachment_id = ?', [c1.id])).n, 0, '整批不写入');
  for (const name of ['pack.zip', 'pack.rar', 'pack.7z']) {
    const a = await stageOk(fx, U.M1, fx.P1, Buffer.from('PK\u0003\u0004 archive-like bytes'), name);
    assert.strictEqual(a.is_image, 0, name);
    assert.strictEqual((await download(fx, U.M1, a.id)).status, 200, name);
  }
  const t = await stageOk(fx, U.M1, fx.P1, TXT, 'admin-try.txt');
  expectErr(await mask(fx, U.ADMIN, t.id, 'admin 想遮蔽'), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM 遮蔽');
  expectErr(await del(fx, U.ADMIN, t.id), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM 软删除');
  const row = await attRow(fx, t.id);
  assert.strictEqual(row.masked_at, null);
  assert.strictEqual(row.deleted_at, null);
});

test('L7 助手入参：bind 的 attachmentIds 缺省当空数组、非数组 400；freeze 的 ownerId / objectVersionId 必须是正整数', async (fx) => {
  const bind = (attachmentIds) => fx.db.withWriteTxn((q) => fx.helpers.bindStagedAttachments(q, { projectId: fx.P1, userId: U.M1.id, attachmentIds, ownerType: 'entry', ownerId: 704 }));
  assert.deepStrictEqual(await bind(undefined), []);
  assert.deepStrictEqual(await bind(null), []);
  assert.deepStrictEqual(await bind([]), []);
  for (const bad of ['1', {}, 5, true]) {
    const e = await expectReject(bind(bad), `attachmentIds=${JSON.stringify(bad)}`);
    assert.strictEqual(e.status, 400, JSON.stringify(bad));
    assert.strictEqual(e.code, 'SYSBUILD_INVALID_INPUT', JSON.stringify(bad));
  }
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'l7.txt');
  await bind([a.id]);
  const freeze = (extra) => fx.db.withWriteTxn((q) => fx.helpers.freezeAttachmentSet(q, Object.assign({ objectType: 'entry', objectVersionId: 9200, ownerType: 'entry', ownerId: 704, operatorId: 11, operatorName: 'pm', projectId: fx.P1 }, extra)));
  for (const [label, extra] of [['ownerId 0', { ownerId: 0 }], ['ownerId 字符串', { ownerId: '704' }], ['ownerId 小数', { ownerId: 1.5 }], ['ownerId 缺省', { ownerId: undefined }],
    ['objectVersionId 0', { objectVersionId: 0 }], ['objectVersionId 字符串', { objectVersionId: '9200' }], ['objectVersionId 缺省', { objectVersionId: undefined }]]) {
    const e = await expectReject(freeze(extra), label);
    assert.strictEqual(e.status, 500, label);
    assert.strictEqual(e.code, 'SYSBUILD_INTERNAL', label);
  }
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_frozen_attachments WHERE attachment_id = ?', [a.id])).n, 0, '被拒绝的冻结不写入');
  assert.deepStrictEqual((await freeze({})).map((x) => x.attachment_id), [a.id], '合法入参正常冻结');
});

// ── codex 11 号审查修订（M-1…M-5 / L-1 / L-2）新增用例 ───────────────────────────────────
test('M-1 独占创建：名字撞上已有附件文件 → 换名重试成功且原文件与引用不变；撞满 5 次 → 500 且原文件不变；_removeFile 不碰无标记的路径', async (fx) => {
  const contentA = Buffer.from('content-of-A');
  const A = await stageOk(fx, U.M1, fx.P1, contentA, 'a-orig.txt');
  const rowA = await attRow(fx, A.id);
  const relA = rowA.file_name;
  const nameA = path.basename(relA);
  const absA = path.join(fx.UPLOAD_DIR, relA);
  const assertAUntouched = async (label) => {
    assert.ok(fs.readFileSync(absA).equals(contentA), `${label}：A 的文件内容必须不变`);
    const again = await attRow(fx, A.id);
    assert.strictEqual(again.file_name, relA, `${label}：A 的库内引用不变`);
    assert.strictEqual(again.sha256, A.sha256);
    assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments WHERE file_name = ?', [relA])).n, 1);
  };
  // ② 第一次撞名、第二次新名 → 成功
  const calls2 = [];
  fx.hooks.setNameGenerator((orig, attempt) => { calls2.push(attempt); return attempt === 0 ? nameA : `fresh-${crypto.randomBytes(6).toString('hex')}_b.txt`; });
  let rb;
  try { rb = await stage(fx, U.M1, fx.P1, Buffer.from('content-of-B'), 'b.txt'); } finally { fx.hooks.setNameGenerator(null); }
  assert.strictEqual(rb.status, 200, rb.buf.toString('utf8'));
  assert.deepStrictEqual(calls2, [0, 1], '撞名后应重新起名一次');
  const rowB = await attRow(fx, rb.body.attachment.id);
  assert.notStrictEqual(rowB.file_name, relA);
  assert.ok(fs.readFileSync(path.join(fx.UPLOAD_DIR, rowB.file_name)).equals(Buffer.from('content-of-B')));
  await assertAUntouched('撞名重试后');
  // ③ 始终撞名 → 耗尽重试，500，没有创建 / 删除任何文件
  const calls3 = [];
  fx.hooks.setNameGenerator((orig, attempt) => { calls3.push(attempt); return nameA; });
  const files = listFiles(fx.SUB);
  const del0 = fx.deletes.length;
  let rc;
  try { rc = await stage(fx, U.M1, fx.P1, Buffer.from('content-of-C'), 'c.txt'); } finally { fx.hooks.setNameGenerator(null); }
  expectErr(rc, 500, 'SYSBUILD_INTERNAL', '重试耗尽');
  assert.deepStrictEqual(calls3, [0, 1, 2, 3, 4], '恰好尝试 5 次');
  assert.strictEqual((await fx.get("SELECT COUNT(*) n FROM sysbuild_attachments WHERE original_name = 'c.txt'")).n, 0);
  assert.deepStrictEqual(listFiles(fx.SUB), files, '没有新增也没有减少任何文件');
  assert.strictEqual(fx.deletes.length, del0);
  await assertAUntouched('重试耗尽后');
  // _removeFile 只删本引擎独占创建并打了标记的路径：对一个只带 path 的文件对象什么都不做
  await new Promise((res, rej) => fx.hooks.stageStorage._removeFile({}, { path: absA, filename: nameA, destination: path.dirname(absA) }, (e) => (e ? rej(e) : res())));
  await assertAUntouched('_removeFile(无标记)后');
});

test('M-2 只读否决 admin：admin 角色且在只读名单 → 暂存 403、下载仍可；普通 admin 不受影响', async (fx) => {
  const files = listFiles(fx.SUB);
  expectErr(await stage(fx, U.ADMIN_RO, fx.P1, TXT, 'ro-admin.txt'), 403, 'SYSBUILD_FORBIDDEN', '只读 admin 暂存');
  assert.deepStrictEqual(listFiles(fx.SUB), files, '被拒绝的暂存不落盘');
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'ro-admin-dl.txt');
  assert.strictEqual((await download(fx, U.ADMIN_RO, a.id)).status, 200, '只读 admin 仍可下载');
  await stageOk(fx, U.ADMIN, fx.P1, TXT, 'normal-admin.txt');
});

test('M-4 原名解码：filename*=UTF-8 的 é / ü 不被二次转码（返回值 / 库 / 下载头一致）；旧式 UTF-8 字节原名仍还原；纯函数边界', async (fx) => {
  for (const [enc, expected] of [['%C3%A9.txt', 'é.txt'], ['%C3%BC.txt', 'ü.txt']]) {
    const r = await rawStage(fx, U.M1, fx.P1, enc, TXT);
    assert.strictEqual(r.status, 200, `${enc}: ${r.buf.toString('utf8')}`);
    assert.strictEqual(r.body.attachment.original_name, expected, `${enc} 返回值`);
    assert.strictEqual((await attRow(fx, r.body.attachment.id)).original_name, expected, `${enc} 库里`);
    const dl = await download(fx, U.M1, r.body.attachment.id);
    // content-disposition 对 ISO-8859-1 可表示的名字直接写 filename="é.txt"（不另写 filename*），所以按原名断言
    assert.ok((dl.headers.get('content-disposition') || '').includes(`filename="${expected}"`), `${enc} 下载头: ${dl.headers.get('content-disposition')}`);
  }
  // 旧式：浏览器把 UTF-8 字节直接放进 filename=（busboy 按 latin1 读出），含 > 0xFF 字符的 UTF-8 序列合法 → 还原
  const legacy = await stageOk(fx, U.M1, fx.P1, TXT, '旧式中文名é.txt');
  assert.strictEqual(legacy.original_name, '旧式中文名é.txt');
  const dec = fx.hooks.decodeOriginalName;
  assert.strictEqual(dec('é.txt'), 'é.txt', '单字节 é 不是合法 UTF-8，原样保留');
  assert.strictEqual(dec('Ã©.txt'), 'é.txt', 'UTF-8 字节 C3 A9 的 latin1 写法 → 还原');
  assert.strictEqual(dec('ÿ.txt'), 'ÿ.txt', '非法 UTF-8 原样保留');
  assert.strictEqual(dec('plain.txt'), 'plain.txt');
  assert.strictEqual(dec('中.txt'), '中.txt', '含 > 0xFF 字符：已是 Unicode，原样');
});

test('M-5 下载已写出首块之后出错 → 连接被断开，客户端在有界时间内得到错误而不是挂起', async (fx) => {
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'midway.txt');
  let outcome;
  try {
    await withTimeout((async () => {
      const r = await fetch(`http://127.0.0.1:${fx.port}/api/sysbuild/attachments/${a.id}/download`, {
        headers: { 'x-test-user': JSON.stringify(U.M1), 'x-test-sim-download-midway': '1' },
      });
      await r.arrayBuffer();
    })(), 5000, '下载中途出错的客户端等待');
    outcome = 'completed';
  } catch (e) {
    outcome = /超时/.test(e.message) ? 'hang' : 'error';
  }
  assert.strictEqual(outcome, 'error', `发头后出错应断开连接（客户端报错），实际: ${outcome}`);
});

test('L-1 真实路径归属：uploads/sysbuild/<pid>/ 下指向目录外的目录联接 → 403；指向基准目录内的联接仍可读', async (fx) => {
  const outside = path.join(fx.root, 'outside-private');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret-outside');
  const a = await stageOk(fx, U.M1, fx.P1, TXT, 'linkcase.txt');
  const row = await attRow(fx, a.id);
  const projDir = path.join(fx.SUB, String(fx.P1));
  const linkOut = path.join(projDir, 'linkout');
  const insideReal = path.join(projDir, 'inside-real');
  const linkIn = path.join(projDir, 'linkin');
  fs.mkdirSync(insideReal);
  fs.writeFileSync(path.join(insideReal, 'ok.txt'), 'inside-ok');
  fs.symlinkSync(outside, linkOut, 'junction');
  fs.symlinkSync(insideReal, linkIn, 'junction');
  try {
    await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [`sysbuild/${fx.P1}/linkout/secret.txt`, a.id]);
    const r = await download(fx, U.M1, a.id);
    expectErr(r, 403, 'SYSBUILD_FORBIDDEN', '联接指向目录外');
    assert.ok(!r.buf.toString('utf8').includes('secret-outside'), '不得泄漏目录外文件内容');
    await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [`sysbuild/${fx.P1}/linkin/ok.txt`, a.id]);
    const ok = await download(fx, U.M1, a.id);
    assert.strictEqual(ok.status, 200, '联接指向基准目录内的目录仍可读');
    assert.strictEqual(ok.buf.toString('utf8'), 'inside-ok');
  } finally {
    await fx.run('UPDATE sysbuild_attachments SET file_name = ? WHERE id = ?', [row.file_name, a.id]);
    for (const l of [linkOut, linkIn]) { try { fs.rmdirSync(l); } catch (_) { try { fs.unlinkSync(l); } catch (__) { /* 留给夹具清理 */ } } }
  }
});

test('L-2 响应写出失败也走回读门：500，文件保留、行存在，回读门看到引用而没有删除', async (fx) => {
  const del0 = fx.deletes.length;
  const logs0 = fx.logs.length;
  fx.hooks.setBeforeRespond(() => { throw new Error('boom-respond'); });
  let r;
  try { r = await stage(fx, U.M1, fx.P1, TXT, 'l2.txt'); } finally { fx.hooks.setBeforeRespond(null); }
  expectErr(r, 500, 'SYSBUILD_INTERNAL');
  assert.ok(!JSON.stringify(r.body).includes('boom'));
  const row = await fx.get("SELECT * FROM sysbuild_attachments WHERE original_name = 'l2.txt'");
  assert.ok(row, '已提交的行应存在');
  assert.ok(onDisk(fx, row), '被已提交记录引用的文件必须保留');
  assert.strictEqual(fx.deletes.length, del0, '不得调用删除');
  assert.ok(fx.logs.slice(logs0).some((l) => l.msg.includes('已被 1 条附件记录引用')), '回读门应已运行并看到引用（证明失败走了统一处理）');
});

// ── codex 11-R 复审修订（M-1 请求级所有权 / L-1 响应写出本身失败）新增用例 ─────────────────────
async function rawMultipart(fx, user, pid, boundary, parts) {
  const body = Buffer.from(parts, 'latin1');
  const r = await fetch(`http://127.0.0.1:${fx.port}/api/sysbuild/projects/${pid}/attachments/stage`, {
    method: 'POST', headers: { 'x-test-user': JSON.stringify(user), 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
  return { status: r.status, headers: r.headers, buf, body: parsed };
}
const filePart = (boundary, name, filename, content) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`;
const OTHERS_BYTES = Buffer.from('others-file-bytes-must-survive');
// 信号 + 有界超时的等待（不用 sleep）：谓词为真即返回，超过 ms 抛错。
async function waitUntil(pred, ms, label) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`等待超时 ${ms}ms: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

// 引擎删掉首文件之后，在「同一路径」写入他人文件（模拟别的请求复用了同名路径且尚未插行）；返回恢复函数与观察结果。
function armOthersFile(fx) {
  const seen = [];
  fx.hooks.setAfterRemoveFile((p) => { seen.push(p); fs.writeFileSync(p, OTHERS_BYTES); });
  return {
    seen,
    disarm() { fx.hooks.setAfterRemoveFile(null); for (const p of seen) { try { fs.unlinkSync(p); } catch (_) { /* 已不在 */ } } },
  };
}

test('M-1(11-R) 多文件超限（首文件已写完、第二个文件 LIMIT_FILE_COUNT）：引擎只删一次，leftover 兜底不得二次删除他人复用的同名文件', async (fx) => {
  const b = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  const parts = `${filePart(b, 'file', 'first-multi.txt', 'first-content')}${filePart(b, 'file', 'second-multi.txt', 'second-content')}--${b}--\r\n`;
  const del0 = fx.deletes.length;
  const n0 = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  const arm = armOthersFile(fx);
  let r;
  try {
    r = await rawMultipart(fx, U.M1, fx.P1, b, parts);
    expectErr(r, 400, 'LIMIT_FILE_COUNT', '多文件超限');
    assert.strictEqual(arm.seen.length, 1, `引擎应恰好清理首文件一次，实际 ${arm.seen.length} 次`);
    const p = arm.seen[0];
    assert.ok(fs.existsSync(p), '他人在同一路径写入的文件必须仍在（不得被二次删除）');
    assert.ok(fs.readFileSync(p).equals(OTHERS_BYTES), '他人文件内容不变');
    assert.strictEqual(fx.deletes.length, del0, 'leftover 兜底不得再调用按名字删除（safeDeleteFileSync）');
    assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n0, '库中无新行');
  } finally { arm.disarm(); }
});

test('M-1(11-R) 流中断同构路径（首文件写完后表单被截断 → busboy 报错）：引擎只删一次，leftover 兜底不得二次删除他人复用的同名文件', async (fx) => {
  const b = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  // 首文件完整，随后开始第二部分但没有结束边界：busboy 在流结束时报 Unexpected end of form。
  const parts = `${filePart(b, 'file', 'first-trunc.txt', 'first-content')}--${b}\r\nContent-Disposition: form-data; name="note"\r\n\r\npartial`;
  const del0 = fx.deletes.length;
  const n0 = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  const arm = armOthersFile(fx);
  try {
    const r = await rawMultipart(fx, U.M1, fx.P1, b, parts);
    // L6：断言到确切状态码与 code。busboy 报 Unexpected end of form 是普通 Error（不是 MulterError、也没有 uploadRejected 标记），
    //   runUpload 对它走 sendError ⇒ 500 SYSBUILD_INTERNAL，不回原始 message。
    expectErr(r, 500, 'SYSBUILD_INTERNAL', '表单截断');
    assert.ok(!r.buf.toString('utf8').includes('Unexpected end'), '不得回显 busboy 的原始错误文本');
    assert.strictEqual(arm.seen.length, 1, `引擎应恰好清理首文件一次，实际 ${arm.seen.length} 次`);
    const p = arm.seen[0];
    assert.ok(fs.existsSync(p), '他人在同一路径写入的文件必须仍在（不得被二次删除）');
    assert.ok(fs.readFileSync(p).equals(OTHERS_BYTES), '他人文件内容不变');
    assert.strictEqual(fx.deletes.length, del0, 'leftover 兜底不得再调用按名字删除');
    assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n0, '库中无新行');
  } finally { arm.disarm(); }
});

test('M-1(11-R) 首文件写完后出现不带 name 的 part（MISSING_FIELD_NAME）：与多文件超限同构——400，引擎只删一次，他人文件不变', async (fx) => {
  const b = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  // 首文件完整，随后一个 Content-Disposition 不带 name 的 part：multer 2.0.2 对 fieldname == null 报 MISSING_FIELD_NAME（MulterError ⇒ 400）。
  const parts = `${filePart(b, 'file', 'first-noname.txt', 'first-content')}--${b}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${b}--\r\n`;
  const del0 = fx.deletes.length;
  const n0 = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  const arm = armOthersFile(fx);
  try {
    const r = await rawMultipart(fx, U.M1, fx.P1, b, parts);
    expectErr(r, 400, 'MISSING_FIELD_NAME', '缺少字段名');
    assert.strictEqual(arm.seen.length, 1, `引擎应恰好清理首文件一次，实际 ${arm.seen.length} 次`);
    const p = arm.seen[0];
    assert.ok(fs.existsSync(p), '他人在同一路径写入的文件必须仍在（不得被二次删除）');
    assert.ok(fs.readFileSync(p).equals(OTHERS_BYTES), '他人文件内容不变');
    assert.strictEqual(fx.deletes.length, del0, 'leftover 兜底不得再调用按名字删除（safeDeleteFileSync）');
    assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n0, '库中无新行');
  } finally { arm.disarm(); }
});

test('M3(12号审) 请求乙复用请求甲的同一落盘路径：甲的所有权判定按请求身份（=== req），不删乙正在写入的文件', async (fx) => {
  const X = `own-race-${crypto.randomBytes(6).toString('hex')}.txt`;
  const absX = path.join(fx.SUB, String(fx.P1), X);
  const bytesB = Buffer.from('bbbb-own-race-content-from-request-B');
  const half = 10;
  const bA = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  const bB = `----sysbuild${crypto.randomBytes(6).toString('hex')}`;
  const partsA = `${filePart(bA, 'file', 'first-own.txt', 'first-content')}${filePart(bA, 'file', 'second-own.txt', 'second-content')}--${bA}--\r\n`;
  const del0 = fx.deletes.length;
  const n0 = (await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n;
  let reqB = null;
  let respB = null;
  const hookState = { ran: 0, xGoneBeforeB: null };
  // 甲的两个文件：首文件由生成器落在 X；第二个文件触发 LIMIT_FILE_COUNT，引擎随即清理 X 并把登记移出。
  //   在甲的所有权判定之前（钩子里）发起乙：乙的生成器同样给 X，乙经存储引擎独占创建 X（甲刚删过，不会 EEXIST）并登记 createdPaths[X] = 乙的 req，
  //   然后乙的请求体停在半途（不结束）——此刻 X 在登记表里属于乙。放行后甲才做所有权判定：必须判「不属于甲」。
  fx.hooks.setNameGenerator(() => X);
  fx.hooks.setBeforeOwnershipCheck(async () => {
    hookState.ran += 1;
    hookState.xGoneBeforeB = !fs.existsSync(absX);
    reqB = http.request({
      host: '127.0.0.1', port: fx.port, method: 'POST', path: `/api/sysbuild/projects/${fx.P1}/attachments/stage`,
      headers: { 'x-test-user': JSON.stringify(U.M1), 'content-type': `multipart/form-data; boundary=${bB}`, 'transfer-encoding': 'chunked' },
    });
    respB = new Promise((resolve, reject) => {
      reqB.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      });
      reqB.on('error', reject);
    });
    reqB.write(`--${bB}\r\nContent-Disposition: form-data; name="file"; filename="b-own.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'latin1');
    reqB.write(bytesB.subarray(0, half));
    await waitUntil(() => fs.existsSync(absX), 5000, '乙的引擎独占创建 X'); // openSync 与登记在同一同步段里，文件出现 = 登记已完成
  });
  let rA;
  try {
    rA = await withTimeout(rawMultipart(fx, U.M1, fx.P1, bA, partsA), 20000, '甲的请求');
    expectErr(rA, 400, 'LIMIT_FILE_COUNT', '甲：多文件超限');
    assert.strictEqual(hookState.ran, 1, '钩子应恰好运行 1 次');
    assert.strictEqual(hookState.xGoneBeforeB, true, '前提：甲的引擎已清理掉 X，乙才能独占创建同名文件');
    assert.strictEqual(fx.deletes.length, del0, '甲的 leftover 兜底不得调用按名字删除（乙的文件不属于甲）');
    assert.ok(fs.existsSync(absX), '乙正在写入的 X 必须仍在');
  } finally {
    fx.hooks.setBeforeOwnershipCheck(null);
    fx.hooks.setNameGenerator(null);
    if (reqB) {
      // 无论断言成败都把乙的请求体收尾，避免请求悬挂。
      try { reqB.write(bytesB.subarray(half)); reqB.write(`\r\n--${bB}--\r\n`, 'latin1'); reqB.end(); } catch (_) { /* 连接已断 */ }
    }
  }
  const rB = await withTimeout(respB, 20000, '乙的响应');
  assert.strictEqual(rB.status, 200, `乙应正常暂存，实际 ${rB.status} ${rB.buf.toString('utf8').slice(0, 200)}`);
  const rowB = await fx.get("SELECT * FROM sysbuild_attachments WHERE original_name = 'b-own.txt'");
  assert.ok(rowB && rowB.file_name === `sysbuild/${fx.P1}/${X}`, '乙在库里应有行，且指向 X');
  assert.ok(fs.readFileSync(absX).equals(bytesB), '乙的文件内容完整、未被甲删除或改写');
  assert.strictEqual((await fx.get('SELECT COUNT(*) n FROM sysbuild_attachments')).n, n0 + 1, '库里只多了乙的一行（甲没有行）');
  assert.strictEqual(fx.deletes.length, del0, '全程没有删除调用');
});

test('L-1(11-R) 成功附件响应的那一次 res.json 本身抛错：回读门被调用（计数与日志），行存在、文件保留、不删除', async (fx) => {
  const del0 = fx.deletes.length;
  const logs0 = fx.logs.length;
  let readbacks = 0;
  fx.hooks.setBeforeReadback(() => { readbacks += 1; });
  let r;
  try {
    r = await call(fx, U.M1, 'POST', `/sysbuild/projects/${fx.P1}/attachments/stage`, { form: formOf(TXT, 'l1-json.txt'), headers: { 'x-test-sim-json-throw': '1' } });
  } finally { fx.hooks.setBeforeReadback(null); }
  expectErr(r, 500, 'SYSBUILD_INTERNAL', 'res.json 抛错后的错误回复');
  assert.ok(!JSON.stringify(r.body).includes('boom'), '不得回显内部错误文本');
  assert.strictEqual(readbacks, 1, `回读门应恰好被调用 1 次，实际 ${readbacks}`);
  const row = await fx.get("SELECT * FROM sysbuild_attachments WHERE original_name = 'l1-json.txt'");
  assert.ok(row, '已提交的行应存在');
  assert.ok(onDisk(fx, row), '被已提交记录引用的文件必须保留');
  assert.strictEqual(fx.deletes.length, del0, '不得调用删除');
  assert.ok(fx.logs.slice(logs0).some((l) => l.msg.includes('已被 1 条附件记录引用')), '回读门日志应显示看到引用');
});

// ── 运行 ─────────────────────────────────────────────────────────────────────────────
async function runAll() {
  let failed = 0;
  let shared = null;
  try {
    shared = await makeFixture();
  } catch (e) {
    console.log(`夹具创建失败: ${e && e.stack}`);
    return { failed: 1, total: cases.length, fatal: true };
  }
  for (const c of cases) {
    let fx = shared;
    try {
      if (c.fresh) fx = await makeFixture();
      await withTimeout(c.fn(fx), 90000, c.name);
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      fx.failed = true;
      console.log(`  ✗ ${c.name}\n      ${e && e.message}`);
    } finally {
      if (c.fresh && fx !== shared) await fx.dispose();
    }
  }
  await shared.dispose();
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  return { failed, total: cases.length, fatal: false };
}

// 变异清单：每条替换被测文件中恰好出现一次的片段（edits 可多处）；变异后至少一条用例判红才算有判别力。
const MUTATIONS = [
  { id: '回读门-凭 txnOutcome 删除', file: 'attachments.js', from: "      await deleteUploadIfUnreferenced(fileRelPath);\n      if (res.headersSent) {", to: "      if (failure.txnOutcome !== 'uncertain') safeDeleteFileSync(fileRelPath, UPLOAD_DIR); else await deleteUploadIfUnreferenced(fileRelPath);\n      if (res.headersSent) {" },
  { id: '回读门-查询失败当无引用', file: 'attachments.js', from: "        return { deleted: false, reason: 'readback_failed' };", to: '        row = { n: 0 };' },
  { id: '回读门-只算未删除的行', file: 'attachments.js', from: "WHERE file_name = ?', [fileRelPath]", to: "WHERE file_name = ? AND deleted_at IS NULL', [fileRelPath]" },
  { id: '回读门-不看 n 直接删', file: 'attachments.js', from: '      if (row.n !== 0) {', to: '      if (false) {' },
  { id: '回读门-格式异常按数字强转', file: 'attachments.js', edits: [
    { from: "      if (!row || typeof row.n !== 'number' || !Number.isInteger(row.n) || row.n < 0) {", to: '      if (false) {' },
    { from: '      if (row.n !== 0) {', to: '      if (Number(row.n) !== 0) {' },
  ] },
  { id: '预检不拦非成员（multer 落盘）', file: 'attachments.js', from: "rules.assertCan(access, rules.canStageAttachment, { writeKind: 'attachment' }); // 预检", to: 'void access; // 预检' },
  { id: '只读账号可暂存', file: 'rules.js', from: 'return !!(!access.isReadonly && (access.isAdmin || access.isMember));', to: 'return !!(access.isAdmin || access.isMember);' },
  { id: '冻结附件可软删除', file: 'attachments.js', from: 'if (await isAttachmentFrozen(q, aid)) throw', to: 'if (false) throw' },
  // C4b 预筛 D1：凭据附件（代录确认 / 历史导入 / 改期证据）不可普通软删除——三类各一条（各自从 IN 清单里去掉一类），再加整句去掉
  { id: 'C4b D1 代录确认凭据（confirmation）可软删除', file: 'attachments.js', from: "owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\",\n        [aid]", to: "owner_type IN ('history_import', 'schedule_record', 'event') LIMIT 1\",\n        [aid]" },
  { id: 'C4b D1 历史导入凭据（history_import）可软删除', file: 'attachments.js', from: "owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\",\n        [aid]", to: "owner_type IN ('confirmation', 'schedule_record', 'event') LIMIT 1\",\n        [aid]" },
  { id: 'C4b D1 改期证据（schedule_record）可软删除', file: 'attachments.js', from: "owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\",\n        [aid]", to: "owner_type IN ('confirmation', 'history_import', 'event') LIMIT 1\",\n        [aid]" },
  { id: 'C4b Q-S2 窗口凭据（event）可软删除', file: 'attachments.js', from: "owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1\",\n        [aid]", to: "owner_type IN ('confirmation', 'history_import', 'schedule_record') LIMIT 1\",\n        [aid]" },
  { id: 'C4b D1 凭据附件整句不拦', file: 'attachments.js', from: 'if (evidenceBound) throw', to: 'if (false) throw' },
  { id: '遮蔽不限 PM', file: 'rules.js', from: 'function canMaskAttachment(access) {\n  return !!(access.isPm && !access.isReadonly);', to: 'function canMaskAttachment(access) {\n  return !!((access.isPm || access.isMember) && !access.isReadonly);' },
  { id: '软删除不限 PM', file: 'rules.js', from: 'function canSoftDeleteAttachment(access) {\n  return !!(access.isPm && !access.isReadonly);', to: 'function canSoftDeleteAttachment(access) {\n  return !!((access.isPm || access.isMember) && !access.isReadonly);' },
  { id: '预览缺 nosniff', file: 'attachments.js', from: "    res.setHeader('X-Content-Type-Options', 'nosniff');\n    res.setHeader('Content-Security-Policy', \"default-src 'none'\");", to: "    res.setHeader('Content-Security-Policy', \"default-src 'none'\");" },
  { id: '预览缺 CSP', file: 'attachments.js', from: "    res.setHeader('Content-Security-Policy', \"default-src 'none'\");\n", to: '' },
  { id: '预览不查 is_image', file: 'attachments.js', from: 'if (!att.is_image) throw rules.notFound();', to: 'if (false) throw rules.notFound();' },
  { id: '图片文件头不校验', file: 'attachments.js', from: 'if (detected !== expectedMime) throw', to: 'if (false) throw' },
  { id: '图片 20MB 上限不校验', file: 'attachments.js', from: 'if (detected && size > IMAGE_MAX_BYTES) throw', to: 'if (false) throw' },
  { id: '绑定不查 24 小时', file: 'attachments.js', from: 'if (now.getTime() - stagedAt.getTime() > STAGE_TTL_MS) throw', to: 'if (false) throw' },
  { id: '绑定不查本人', file: 'attachments.js', from: 'if (att.uploaded_by !== userId) throw', to: 'if (false) throw' },
  { id: '绑定不查同项目', file: 'attachments.js', from: 'if (!att || att.project_id !== projectId) throw', to: 'if (!att) throw' },
  { id: '绑定不查已绑定', file: 'attachments.js', from: 'if (bound) throw', to: 'if (false) throw' },
  { id: '绑定不查已删除', file: 'attachments.js', from: 'if (att.deleted_at) throw invalid(', to: 'if (false) throw invalid(' },
  { id: 'C3b D5(a) 绑定助手不拒已遮蔽的暂存附件', file: 'attachments.js', from: "if (att.masked_at) throw invalid('附件不存在或不可用', 'attachment_ids');", to: '' },
  { id: 'C3b 冻结取集去掉引用（只算绑定）', file: 'attachments.js', from: 'SELECT r.attachment_id FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND r.owner_id = ?', to: 'SELECT r.attachment_id FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND r.owner_id = ? AND 0' },
  { id: 'C3b 冻结取集去掉绑定（只算引用）', file: 'attachments.js', from: 'SELECT b.attachment_id FROM sysbuild_attachment_bindings b WHERE b.owner_type = ? AND b.owner_id = ?', to: 'SELECT b.attachment_id FROM sysbuild_attachment_bindings b WHERE b.owner_type = ? AND b.owner_id = ? AND 0' },
  { id: 'C3b 冻结取集的引用不看 owner_type', file: 'attachments.js', from: 'FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND r.owner_id = ?', to: 'FROM sysbuild_attachment_refs r WHERE ? IS NOT NULL AND r.owner_id = ?' },
  { id: 'C3b 冻结取集的引用不看 owner_id', file: 'attachments.js', from: 'FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND r.owner_id = ?', to: 'FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND ? IS NOT NULL' },
  { id: '冻结含已删除附件', file: 'attachments.js', from: ' AND a.deleted_at IS NULL\n', to: '\n' },
  { id: '下载不查遮蔽', file: 'attachments.js', from: 'if (att.masked_at && !access.isAdmin) throw', to: 'if (false) throw' },
  { id: '下载不查软删除', file: 'attachments.js', from: 'if (att.deleted_at) throw rules.notFound();', to: '' },
  { id: '下载子树校验去掉', file: 'attachments.js', from: 'if (!abs.startsWith(base + path.sep)) throw deny();', to: 'if (false) throw deny();' },
  { id: '文件名超长不拦', file: 'attachments.js', from: 'if (Array.from(file.originalname).length > ORIGINAL_NAME_MAX_CODEPOINTS) {', to: 'if (false) {' },
  { id: '文件名长度按 UTF-16 计', file: 'attachments.js', from: 'if (Array.from(file.originalname).length > ORIGINAL_NAME_MAX_CODEPOINTS) {', to: 'if (file.originalname.length > ORIGINAL_NAME_MAX_CODEPOINTS) {' },
  { id: '白名单不拦', file: 'attachments.js', from: 'if (!ALLOWED_EXTS.has(ext)) return cb(', to: 'if (false) return cb(' },
  { id: 'sha256 写错', file: 'attachments.js', from: 'mimeType, size, sha256, isImage, uid]', to: "mimeType, size, '0'.repeat(64), isImage, uid]" },
  { id: '遮蔽原因不校验', file: 'attachments.js', from: 'if (reasonLen < 1 || reasonLen > MASK_REASON_MAX) throw', to: 'if (false) throw' },
  { id: '遮蔽原因不拒控制字符（C3a 预筛 L1）', file: 'attachments.js', from: 'if (rules.hasControlChar(reason)) throw invalid(', to: 'if (false) throw invalid(' },
  { id: '控制字符判定漏掉 NUL（C3a 预筛 L1，共用判定）', file: 'rules.js', from: 'const CONTROL_CHAR_RE = /[\\u0000-\\u0008\\u000B', to: 'const CONTROL_CHAR_RE = /[\\u0001-\\u0008\\u000B' },
  { id: '事件类型不校验', file: 'events.js', from: 'if (!ev || !EVENT_TYPES.includes(ev.eventType)) {', to: 'if (false) {' },
  { id: '非成员读不拦（可见性）', file: 'rules.js', from: 'if (!canViewProject(access)) throw NOT_FOUND();', to: 'if (false) throw NOT_FOUND();' },  // C2a 预筛 L3：assertVisible 改调 canViewProject，锚点随之更换
  { id: '只读账号不能查看', file: 'rules.js', from: 'return !!(access.isAdmin || access.isMember || access.isReadonly);', to: 'return !!(access.isAdmin || access.isMember);' },
  { id: '已移出成员仍算成员', file: 'rules.js', from: 'AND joined_at IS NOT NULL AND removed_at IS NULL LIMIT 1', to: 'AND joined_at IS NOT NULL LIMIT 1' },
  { id: '未加入成员算成员', file: 'rules.js', from: 'AND joined_at IS NOT NULL AND removed_at IS NULL LIMIT 1', to: 'AND removed_at IS NULL LIMIT 1' },
  { id: 'PM 不视为成员', file: 'rules.js', from: 'let isMember = isPm;', to: 'let isMember = false;' },
  { id: '项目状态限制只允许 active', file: 'rules.js', from: "attachment: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),", to: "attachment: Object.freeze({ active: true, paused: false, terminated: false, closed: false })," },  // C2a：projectAllowsWrite 改查 PROJECT_ACTION_TABLE，锚点随之换成 attachment 行
  // ── 预筛修订新增 ──
  { id: '冻结不查同项目', file: 'attachments.js', from: 'if (r.project_id !== projectId) throw', to: 'if (false) throw' },
  { id: '白名单去掉压缩包', file: 'attachments.js', from: "const EXTRA_EXTS = ['.zip', '.rar', '.7z'];", to: 'const EXTRA_EXTS = [];' },
  { id: '遮蔽放行 admin', file: 'rules.js', from: 'function canMaskAttachment(access) {\n  return !!(access.isPm && !access.isReadonly);', to: 'function canMaskAttachment(access) {\n  return !!((access.isPm || access.isAdmin) && !access.isReadonly);' },
  { id: '软删除放行 admin', file: 'rules.js', from: 'function canSoftDeleteAttachment(access) {\n  return !!(access.isPm && !access.isReadonly);', to: 'function canSoftDeleteAttachment(access) {\n  return !!((access.isPm || access.isAdmin) && !access.isReadonly);' },
  { id: '事务内不重做预检（M2）', file: 'attachments.js', from: "        rules.assertCan(access, rules.canStageAttachment, { writeKind: 'attachment' });\n        const ins = await q.run(", to: '        void access;\n        const ins = await q.run(' },
  { id: '只哈希第一块（M3）', file: 'attachments.js', from: '      h.update(chunk);\n      size += chunk.length;', to: '      if (size === 0) h.update(chunk);\n      size += chunk.length;' },
  { id: 'readonlyIds 缺失回落为空（M1）', file: 'rules.js', from: 'const ro = opts && opts.readonlyIds;', to: 'const ro = (opts && opts.readonlyIds) || [];' },
  { id: '工厂不校验 readonlyIds（M1）', file: 'attachments.js', from: 'if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {', to: 'if (false) {' },
  { id: '>=500 透传非 SYSBUILD 码（L1）', file: 'attachments.js', from: " && err.code.startsWith('SYSBUILD_'));", to: ');' },
  { id: '非 Multer 错误也回 400（L1）', file: 'attachments.js', from: 'if (!isMulterErr && !(err && err.uploadRejected)) return sendError(res, err);', to: 'if (false) return sendError(res, err);' },
  { id: '预览出错不恢复 Content-Type（L1）', file: 'attachments.js', from: "        res.setHeader('Content-Type', 'application/json; charset=utf-8');\n        sendError(res, e);", to: '        sendError(res, e);' },
  { id: '下载不显式设 Content-Type（L2）', file: 'attachments.js', from: "    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');\n", to: '' },
  { id: '文件名控制字符放行（L3）', file: 'attachments.js', from: 'if (/[\\x00-\\x1F\\x7F]/.test(file.originalname)) { // eslint-disable-line no-control-regex', to: 'if (false) {' },
  { id: '两种不存在提示不同（L4）', file: 'attachments.js', from: "'SELECT id, project_id, file_name, original_name, mime_type, is_image, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [aid]\n      );\n      if (!att) throw rules.notFound();", to: "'SELECT id, project_id, file_name, original_name, mime_type, is_image, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [aid]\n      );\n      if (!att) throw makeError(404, 'SYSBUILD_NOT_FOUND', '附件不存在');" },
  { id: '下载缺 no-store（L5）', file: 'attachments.js', from: "    res.setHeader('Cache-Control', 'private, no-store');\n    // 显式以存储的", to: '    // 显式以存储的' },
  { id: '预览缺 no-store（L5）', file: 'attachments.js', from: "    res.setHeader('Cache-Control', 'private, no-store');\n    res.setHeader('Content-Length', String(size));", to: "    res.setHeader('Content-Length', String(size));" },
  { id: '绑定把非数组当空（L7）', file: 'attachments.js', from: "if (attachmentIds !== undefined && attachmentIds !== null && !Array.isArray(attachmentIds)) throw invalid(", to: 'if (false) throw invalid(' },
  { id: '冻结不校验 ownerId（L7）', file: 'attachments.js', from: "if (!Number.isInteger(ownerId) || ownerId <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：冻结的所属对象编号不合法');", to: '' },
  // ── codex 11 号修订新增 ──
  { id: '独占创建改回覆盖写（M-1）', file: 'attachments.js', from: "fs.openSync(path.join(dir, name), 'wx')", to: "fs.openSync(path.join(dir, name), 'w')" },
  { id: 'EEXIST 不重试（M-1）', file: 'attachments.js', from: "if (!e || e.code !== 'EEXIST') return finish(e);", to: 'return finish(e);' },
  { id: '_removeFile 不看标记（M-1）', file: 'attachments.js', from: "if (typeof p !== 'string' || !(createdPaths[p] === req && delete createdPaths[p])) return;", to: "if (typeof p !== 'string') return;" },
  { id: 'admin 绕过只读（M-2）', file: 'rules.js', from: 'return !!(!access.isReadonly && (access.isAdmin || access.isMember));', to: 'return !!(access.isAdmin || (!access.isReadonly && access.isMember));' },
  { id: '20MB 按扩展名判（M-3）', file: 'attachments.js', from: 'if (detected && size > IMAGE_MAX_BYTES) throw', to: 'if (expectedMime && size > IMAGE_MAX_BYTES) throw' },
  { id: '图片头 + 普通扩展名放行（M-3）', file: 'attachments.js', from: 'if (detected !== expectedMime) throw', to: 'if (expectedMime && detected !== expectedMime) throw' },
  { id: '原名无条件 latin1 转码（M-4）', file: 'attachments.js', from: "  let decoded;\n  try {\n    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1'));\n  } catch (_) {\n    return s;\n  }\n  return decoded !== s ? decoded : s;", to: "  return Buffer.from(s, 'latin1').toString('utf8');" },
  { id: '下载发头后出错不 destroy（M-5）', file: 'attachments.js', from: "      if (res.headersSent) { res.destroy(); return; }\n      res.removeHeader('Content-Disposition');", to: "      if (res.headersSent) { return; }\n      res.removeHeader('Content-Disposition');" },
  { id: '子树只做文本检查（L-1）', file: 'attachments.js', from: 'if (!realAbs.startsWith(realBase + path.sep)) throw deny();', to: '' },
  { id: 'res.json 移出 try（L-2）', file: 'attachments.js', edits: [
    { from: "      if (hooks.beforeRespond) await hooks.beforeRespond({ fileName: fileRelPath, attachment });\n      res.json({ attachment });\n    } catch (err) {", to: '    } catch (err) {' },
    { from: '      return sendError(res, failure);\n    }\n    return undefined;\n  }', to: "      return sendError(res, failure);\n    }\n    if (hooks.beforeRespond) await hooks.beforeRespond({ fileName: fileRelPath, attachment });\n    res.json({ attachment });\n    return undefined;\n  }" },
  ] },
  // ── codex 11-R 复审修订新增 ──
  { id: 'leftover 兜底不看所有权（M-1 11-R）', file: 'attachments.js', from: 'const owned = !!(req.file && req.file.path && createdPaths[req.file.path] === req && delete createdPaths[req.file.path]);', to: 'const owned = !!(req.file && req.file.path);' },
  { id: '所有权判定只看路径是否登记、不比较 req（M3 12 号）', file: 'attachments.js', from: 'createdPaths[req.file.path] === req && delete createdPaths[req.file.path]);\n        const leftover', to: 'createdPaths[req.file.path] && delete createdPaths[req.file.path]);\n        const leftover' },
  { id: '所有权判定只剩 delete（对未登记路径也返回 true，M3 12 号）', file: 'attachments.js', from: 'createdPaths[req.file.path] === req && delete createdPaths[req.file.path]);\n        const leftover', to: 'delete createdPaths[req.file.path]);\n        const leftover' },
  { id: '仅 res.json 移出 try、beforeRespond 留在 try 内（L-1 11-R）', file: 'attachments.js', edits: [
    { from: '      res.json({ attachment });\n    } catch (err) {', to: '    } catch (err) {' },
    { from: '      return sendError(res, failure);\n    }\n    return undefined;\n  }', to: '      return sendError(res, failure);\n    }\n    res.json({ attachment });\n    return undefined;\n  }' },
  ] },
  { id: '冻结不校验 objectVersionId（L7）', file: 'attachments.js', from: "if (!Number.isInteger(objectVersionId) || objectVersionId <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：冻结的对象版本编号不合法');", to: '' },
  // ── Q8 原文件名（2026-10-29）──
  { id: '暂存事件恢复 original_name（Q8）', file: 'attachments.js', from: 'payload: { size, sha256, is_image: isImage },', to: 'payload: { original_name: file.originalname, size, sha256, is_image: isImage },' },
  { id: '删除事件恢复 original_name（Q8）', file: 'attachments.js', edits: [
    { from: "'SELECT id, project_id, deleted_at FROM sysbuild_attachments WHERE id = ?'", to: "'SELECT id, project_id, original_name, deleted_at FROM sysbuild_attachments WHERE id = ?'" },
    { from: 'payload: {}, operatorId: uid', to: 'payload: { original_name: att.original_name }, operatorId: uid' },
  ] },
  { id: '遮蔽事件恢复 original_name（Q8）', file: 'attachments.js', edits: [
    { from: "'SELECT id, project_id, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?'", to: "'SELECT id, project_id, original_name, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?'" },
    { from: 'payload: { reason }, operatorId: uid', to: 'payload: { original_name: att.original_name, reason }, operatorId: uid' },
  ] },
  { id: '遮蔽后下载仍用原名（Q8）', file: 'attachments.js', from: 'res.download(abs, dispositionFileName(att), (err) => {', to: 'res.download(abs, att.original_name, (err) => {' },
  { id: '遮蔽后预览仍用原名（Q8）', file: 'attachments.js', from: 'encodeRfc5987(dispositionFileName(att))', to: 'encodeRfc5987(att.original_name)' },
  { id: 'attachmentDisplayName 对已遮蔽仍返回原名（Q8）', file: 'attachments.js', from: 'return att.masked_at ? null : att.original_name;', to: 'return att.original_name;' },
  { id: 'dispositionFileName 不看遮蔽、一律原名（Q8）', file: 'attachments.js', from: 'return shown === null ? maskedFileName(att) : shown;', to: 'return att.original_name;' },
  // 预筛 MED-1：旧的「扩展名不做形态限制」「扩展名不取小写」两条变异对应的代码已不存在（扩展名不再取 file_name），换成下面两条等价变异。
  { id: '遮蔽替代名的扩展名去掉白名单交集（Q8 MED-1）', file: 'attachments.js', from: "${ALLOWED_EXTS.has(ext) ? ext : ''}", to: '${ext}' },
  { id: '遮蔽替代名的扩展名改回取 file_name（Q8 MED-1，截断的扩展名会漏出原名片段）', file: 'attachments.js', from: 'const ext = normalizeAttachmentExt(att.original_name);', to: "const ext = path.extname(String(att.file_name || '')).toLowerCase();" },
  { id: '遮蔽替代名的扩展名改回取 file_name 且不看白名单（Q8 MED-1）', file: 'attachments.js', edits: [
    { from: 'const ext = normalizeAttachmentExt(att.original_name);', to: "const ext = path.extname(String(att.file_name || '')).toLowerCase();" },
    { from: "${ALLOWED_EXTS.has(ext) ? ext : ''}", to: '${ext}' },
  ] },
  { id: '暂存响应改回直接取 original_name 列（Q8 L-1）', file: 'attachments.js', from: 'original_name: attachmentDisplayName(row), size: row.size', to: 'original_name: row.original_name, size: row.size' },
  { id: '暂存响应的 SELECT 漏掉 masked_at（Q8 L-1）', file: 'attachments.js', from: "'SELECT id, original_name, masked_at, size, sha256, is_image, staged_at FROM", to: "'SELECT id, original_name, size, sha256, is_image, staged_at FROM" },
  { id: 'attachmentDisplayName 去掉 masked_at 缺键 / undefined 检查（Q8 MED-2）', file: 'attachments.js', from: "if (!Object.prototype.hasOwnProperty.call(att, 'masked_at') || att.masked_at === undefined) {", to: 'if (false) {' },
  { id: 'attachmentDisplayName 的缺键检查把 undefined 当未遮蔽（Q8 MED-2）', file: 'attachments.js', from: "|| att.masked_at === undefined) {", to: ') {' },
];

// 09 号 M-4：子进程结果分三类——检出（退出码 1 且汇总行显示有用例失败）/ 未检出（全部通过）/
//   异常（启动失败、被信号终止或整体超时、没有汇总行）。异常不算检出，单列为自检失败。
function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const timer = setTimeout(() => { child.kill(); }, 420000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ kind: 'abnormal', detail: e.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const m = /^(\d+)\/(\d+) 通过\s*$/m.exec(out);
      if (signal || m === null) return resolve({ kind: 'abnormal', detail: signal || (errOut.split('\n').filter(Boolean).slice(-3).join(' | ') || out.split('\n').filter(Boolean).slice(-2).join(' | ') || '无汇总行') });
      const passedN = Number(m[1]);
      const totalN = Number(m[2]);
      if (code === 1 && passedN < totalN) return resolve({ kind: 'red', detail: `${passedN}/${totalN}` });
      if (code === 0 && passedN === totalN) return resolve({ kind: 'green', detail: `${passedN}/${totalN}` });
      return resolve({ kind: 'abnormal', detail: `退出码 ${code} 与汇总 ${passedN}/${totalN} 不一致` });
    });
  });
}

function copyModuleDir(dstDir, transform) {
  const requires = {
    "require('sqlite3')": `require(${JSON.stringify(require.resolve('sqlite3'))})`,
    "require('express')": `require(${JSON.stringify(require.resolve('express'))})`,
    "require('multer')": `require(${JSON.stringify(require.resolve('multer', { paths: [path.join(DEFAULT_DIR, '..', '..')] }))})`,
  };
  for (const f of fs.readdirSync(DEFAULT_DIR)) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    let src = fs.readFileSync(path.join(DEFAULT_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    for (const [from, to] of Object.entries(requires)) src = src.split(from).join(to);
    if (transform) src = transform(f, src);
    fs.writeFileSync(path.join(dstDir, f), src);
  }
}

// 自检模式下子进程一律带 --no-keep（用例判红是预期，不保留现场）；变异目录根在任何出口都清掉。
async function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-att-mut-'));
  try {
    return await selfTestIn(root);
  } finally {
    try { removeTree(root); } catch (e) { console.log(`  [清理] 变异临时目录未删除: ${root} — ${e.message}`); }
  }
}
async function selfTestIn(root) {
  const base = await runChild(['--module-dir', DEFAULT_DIR, '--no-keep']);
  if (base.kind !== 'green') {
    console.log(`  ✗ 未变异基线不是全绿（${base.kind}：${base.detail}），变异自检无意义，终止`);
    return 1;
  }
  console.log(`  ✓ 未变异基线 ${base.detail} 全绿`);
  // 分类器自检：加载不起来的模块必须判为异常，不能被算作检出。
  const brokenDir = path.join(root, 'broken');
  fs.mkdirSync(brokenDir);
  copyModuleDir(brokenDir, (f, src) => (f === 'attachments.js' ? `${src}\n这一行不是合法的 JavaScript(\n` : src));
  const broken = await runChild(['--module-dir', brokenDir, '--no-keep']);
  if (broken.kind !== 'abnormal') {
    console.log(`  ✗ 分类器自检：语法错误的模块被判为 ${broken.kind}（应为异常），变异结果不可信，终止`);
    return 1;
  }
  console.log(`  ✓ 分类器自检：语法错误的模块判为异常（${broken.detail}）`);
  // 先在主进程里准备好全部变异目录（锚点必须恰好出现一次），再有限并发地跑子进程。
  const prepared = [];
  let weak = 0;
  MUTATIONS.forEach((mu, i) => {
    const edits = mu.edits || [{ from: mu.from, to: mu.to }];
    const dir = path.join(root, `m${i}`);
    fs.mkdirSync(dir);
    let bad = null;
    copyModuleDir(dir, (f, src) => {
      if (f !== mu.file) return src;
      let out = src;
      for (const e of edits) {
        const count = out.split(e.from).length - 1;
        if (count !== 1) { bad = `变异锚点出现 ${count} 次（应恰好 1 次）: ${JSON.stringify(e.from.slice(0, 60))}`; return src; }
        out = out.replace(e.from, () => e.to);
      }
      return out;
    });
    if (bad) { console.log(`  ✗ [${mu.id}] ${bad}`); weak += 1; } else prepared.push({ mu, dir });
  });
  const results = new Array(prepared.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next; next += 1;
      if (idx >= prepared.length) return;
      results[idx] = await runChild(['--module-dir', prepared[idx].dir, '--no-keep']);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  prepared.forEach((p, idx) => {
    const res = results[idx];
    const label = res.kind === 'red' ? `判红（${res.detail}）` : res.kind === 'green' ? '未判红（断言无判别力）' : `异常（${res.detail}），不计为检出`;
    console.log(`  ${res.kind === 'red' ? '✓' : '✗'} [${p.mu.id}] ${label}`);
    if (res.kind !== 'red') weak += 1;
  });
  console.log(`\n变异自检：${MUTATIONS.length - weak}/${MUTATIONS.length} 判红`);
  return weak;
}

(async () => {
  if (SELF_TEST) {
    const weak = await selfTest();
    process.exitCode = weak === 0 ? 0 : 1;
    return;
  }
  // 被测模块在用例循环前预加载：加载失败是「异常」不是「用例失败」，独立退出码 3、不打印汇总行。
  try {
    loadModules();
  } catch (e) {
    console.log(`被测模块加载失败（不计为用例失败）: ${e && e.message}`);
    process.exitCode = 3;
    return;
  }
  const res = await runAll();
  process.exitCode = res.failed === 0 ? 0 : 1;
})();
