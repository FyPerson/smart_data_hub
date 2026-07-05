// verify-correction-rework-datafix-e2e.js — 返工子单 datafix 自洽补号 e2e（codex 84 L-2 修复回归）
//   验证 insertReworkChildCorrection 的 oa_number 补号分支（2026-07-05 拍板自洽方向）：
//   A 父单为 datafix 占位号 → 子单不继承、补自身 datafix-{childId}（号=自己 id，自洽）
//   B 父单为真实 OA 号 → 子单照常继承（返工单属同一 OA 流程）
//   C 父单 oa_number 为 NULL → 子单 NULL（边界，不触发补号，不误伤）
//   D 多级返工链 → 每级子单各自 datafix-{自己 id}（不整链复制同一号——修复前的病症）
// 用法：node scripts/verify-correction-rework-datafix-e2e.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── require-cache mock 钉钉（必须在 require corrections 之前）──
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => ({ ok: true, userid: 'uid_' + phone }),
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk' }),
  sendFileToUser: async () => ({ errcode: 0 }),
  uploadMedia: async () => 'media1',
  getReadStatus: async () => ({ readDetails: [] }),
  escapeMarkdown: (x) => x,
  classifyError: () => ({ reason: 'exception', hint: 'err' }),
} };

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: (req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ error: 'no user' });
    try { req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return next(); } catch (e) { return res.status(401).json({ error: 'bad user' }); }
  },
  requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' }),
  requirePublisherOrAdmin: (req, res, next) => (req.user && ['admin', 'publisher'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'pub/admin only' }),
  sendIssueDingtalkRaw: async () => ({}),
  UPLOAD_DIR: require('os').tmpdir(),
  readSystemConfig: async () => null,
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: async (ak, as, tk, fn) => fn(tk),
  normalizeAttachmentExt: (name) => path.extname(String(name || '')).toLowerCase(),
  safeDeleteFileSync: noop,
  maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };
const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };

let PORT, srv;
function reqJson(method, p, body, user) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, method, path: p,
      headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}
async function waitReady() {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}
const setStatus = (id, status, ct) => dbRunAsync(`UPDATE correction_requests SET status=?, closure_type=? WHERE id=?`, [status, ct || null, id]);
async function mkArchived(o = {}) {
  const base = { source_system: 'BMS', location_info: 'loc', correction_count: 1, reason: '原始修正原因占位文本足够长',
    correction_type: 'single', requester_name: '业务张', requester_phone: '13800000001',
    status: 'ARCHIVED', closure_type: 'normal', created_by: 1, created_by_name: '管理员', assigned_to: 99, assigned_to_name: '开发99' };
  const row = { ...base, ...o };
  const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return r.lastID;
}

(async () => {
  console.log('=== 返工子单 datafix 自洽补号 e2e（codex 84 L-2 修复回归）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, status TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone,status) VALUES
    (1,'admin','管理员','admin','13900000001','active'),
    (99,'dev99','开发99','user','13900000099','active')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ── A 父单为 datafix 占位号 → 子单自洽补号 datafix-{childId} ──
  console.log('— A datafix 父单返工 → 子单补自身占位号 —');
  const pDf = await mkArchived();                                        // oa_number 默认 NULL
  await dbRunAsync(`UPDATE correction_requests SET oa_number='datafix-'||id WHERE id=?`, [pDf]);  // 模拟自发现单回填后 = datafix-{自己id}
  const pDfRow = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [pDf]);
  ok(pDfRow.oa_number === 'datafix-' + pDf, `A0 父单是自发现单 oa_number=datafix-${pDf}`);
  const rDf = await reqJson('POST', `/api/corrections/${pDf}/reopen-rework`, { reopen_reason: 'datafix 单返工子单应补自身占位号' }, ADMIN);
  ok(rDf.status === 200 && rDf.body.ok, 'A1 datafix 父单返工 → 200');
  const cDf = await dbGetAsync('SELECT id, oa_number FROM correction_requests WHERE id=?', [rDf.body.id]);
  ok(cDf.oa_number === 'datafix-' + cDf.id, `A2 ⭐子单 oa_number=datafix-${cDf.id}（自己 id，自洽）`);
  ok(cDf.oa_number !== pDfRow.oa_number, `A3 ⭐子单不继承父单号 datafix-${pDf}（修复核心：修复前会显示父单号）`);

  // ── B 父单为真实 OA 号 → 子单照常继承 ──
  console.log('— B 真实 OA 父单返工 → 子单继承 —');
  const pReal = await mkArchived({ oa_number: '364265' });
  const rReal = await reqJson('POST', `/api/corrections/${pReal}/reopen-rework`, { reopen_reason: '真实OA单返工子单应继承同一OA流程号' }, ADMIN);
  ok(rReal.status === 200, 'B1 真实 OA 父单返工 → 200');
  const cReal = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [rReal.body.id]);
  ok(cReal.oa_number === '364265', 'B2 子单继承父单真实 OA 号 364265（返工属同一 OA 流程，继承正确不受修复影响）');

  // ── C 父单 oa_number 为 NULL → 子单 NULL（边界，不触发补号）──
  console.log('— C NULL 父单返工 → 子单 NULL —');
  const pNull = await mkArchived({ oa_number: null });
  const rNull = await reqJson('POST', `/api/corrections/${pNull}/reopen-rework`, { reopen_reason: 'oa为空的历史单返工子单应保持空号' }, ADMIN);
  ok(rNull.status === 200, 'C1 NULL oa 父单返工 → 200');
  const cNull = await dbGetAsync('SELECT oa_number FROM correction_requests WHERE id=?', [rNull.body.id]);
  ok(cNull.oa_number === null, 'C2 子单 oa_number 保持 NULL（非 datafix 前缀不触发补号，边界不误伤）');

  // ── D 多级返工链 → 每级各自 datafix-{自己 id} ──
  console.log('— D 多级返工链 → 每级自洽 —');
  await setStatus(cDf.id, 'ARCHIVED', 'normal');                        // cDf 归档（结束第 1 次返工，解除链级去重）
  const rDf2 = await reqJson('POST', `/api/corrections/${cDf.id}/reopen-rework`, { reopen_reason: '第二次返工子单仍应补自身占位号非父串' }, ADMIN);
  ok(rDf2.status === 200, 'D1 datafix 子单再返工（第 2 级）→ 200');
  const cDf2 = await dbGetAsync('SELECT id, oa_number FROM correction_requests WHERE id=?', [rDf2.body.id]);
  ok(cDf2.oa_number === 'datafix-' + cDf2.id, `D2 ⭐第 2 级子单 oa_number=datafix-${cDf2.id}（自己 id，非父 datafix-${cDf.id}）`);
  ok(cDf2.oa_number !== cDf.oa_number && cDf2.oa_number !== pDfRow.oa_number, 'D3 ⭐整链每级各自号，不整链复制同一 datafix（修复前会全链=datafix-根）');

  srv.close();
  console.log(`\n✅ 返工子单 datafix 自洽补号全部通过：${pass} 断言`);
  process.exit(0);
})().catch(e => { console.error('❌ 失败:', e && e.message); if (srv) srv.close(); process.exit(1); });
