// probe-process-type.js — 数据修正「流程类型」(process_type) 字段正向验证（2026-06-30）
//   覆盖：建单入库 + 列表 SELECT 返回 + 详情返回 + 3 条子单继承（跨系统 system2 / link-new 追加 / 返工）+ 非必填 NULL + ≤100 校验。
//   harness 同 verify-correction-cross-system-e2e.js：require-cache mock 钉钉 + in-memory sqlite + 真实 router + HTTP。
//   用法：node scripts/probe-process-type.js
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
const CONFIG = { dingtalk_app_key: 'k', dingtalk_app_secret: 's', dingtalk_robot_code: 'r' };

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
  readSystemConfig: async (key) => (CONFIG[key] != null ? CONFIG[key] : null),
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
const baseBody = (extra) => Object.assign({ source_system: 'BMS', location_info: '某表某字段错，应改为X', correction_type: 'single', reason: '流程类型字段验证原因≥5字', requesters: [{ name: '主业务方', phone: '13800000001' }] }, extra);

(async () => {
  console.log('=== 数据修正·流程类型(process_type) 字段验证 ===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone) VALUES (1,'admin','管理员','admin','13900000001')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // [A] 建单入库 + 详情 + 列表 SELECT 返回 process_type
  const A = await reqJson('POST', '/api/corrections', baseBody({ process_type: '报销流程' }), ADMIN);
  ok(A.status === 200 && A.body.id, `[A] 建单带 process_type='报销流程' → 200（#${A.body.id}）`);
  const aRow = await dbGetAsync('SELECT process_type FROM correction_requests WHERE id=?', [A.body.id]);
  ok(aRow.process_type === '报销流程', '[A] DB 行 process_type 入库正确');
  const aDetail = await reqJson('GET', `/api/corrections/${A.body.id}`, null, ADMIN);
  ok(aDetail.status === 200 && aDetail.body.request && aDetail.body.request.process_type === '报销流程', '[A] 详情 GET /:id 返回 process_type（body.request.{...row}，前端 r.process_type 同源）');
  const list = await reqJson('GET', '/api/corrections', null, ADMIN);
  const aInList = (list.body.items || []).find(it => it.id === A.body.id);
  ok(aInList && aInList.process_type === '报销流程', '[A] 列表 GET / 返回 process_type（前端搜索/显示依赖此字段）');

  // [B] 非必填：省略 process_type → NULL
  const B = await reqJson('POST', '/api/corrections', baseBody({}), ADMIN);
  const bRow = await dbGetAsync('SELECT process_type FROM correction_requests WHERE id=?', [B.body.id]);
  ok(B.status === 200 && bRow.process_type === null, '[B] 非必填：省略 process_type → 入库 NULL');

  // [C] ≤100 校验：超长 400
  const C = await reqJson('POST', '/api/corrections', baseBody({ process_type: '流'.repeat(101) }), ADMIN);
  ok(C.status === 400 && C.body.code === 'PROCESS_TYPE_TOO_LONG', '[C] process_type 超 100 字 → 400 PROCESS_TYPE_TOO_LONG');
  const C2 = await reqJson('POST', '/api/corrections', baseBody({ process_type: '流'.repeat(100) }), ADMIN);
  ok(C2.status === 200, '[C] process_type 恰 100 字 → 放行 200（边界）');

  // [D] 跨系统继承：system2 子单继承主单 process_type
  const D = await reqJson('POST', '/api/corrections', baseBody({ process_type: '采购流程', cross_system: true, system2: { source_system: 'CRM', location_info: '系统2同字段错' } }), ADMIN);
  ok(D.status === 200 && D.body.child_ids && D.body.child_ids.length === 1, `[D] 跨系统建两单 → 200（master #${D.body.master_id} + child #${D.body.child_ids && D.body.child_ids[0]}）`);
  const dChild = await dbGetAsync('SELECT process_type FROM correction_requests WHERE id=?', [D.body.child_ids[0]]);
  ok(dChild.process_type === '采购流程', '[D] 跨系统 system2 子单继承主单 process_type=采购流程');

  // [E] link-new 追加单继承主单 process_type
  const E = await reqJson('POST', '/api/corrections', baseBody({ process_type: '合同审批' }), ADMIN);
  const eLink = await reqJson('POST', `/api/corrections/${E.body.id}/link-new`, { source_system: '财务系统', location_info: '第三系统同字段错' }, ADMIN);
  ok(eLink.status === 200 && eLink.body.id, `[E] link-new 追加单 → 200（#${eLink.body.id}）`);
  const eChild = await dbGetAsync('SELECT process_type FROM correction_requests WHERE id=?', [eLink.body.id]);
  ok(eChild.process_type === '合同审批', '[E] link-new 追加单继承主单 process_type=合同审批');

  // [F] 返工子单继承被返工单 process_type
  const F = await reqJson('POST', '/api/corrections', baseBody({ process_type: '入职流程' }), ADMIN);
  await setStatus(F.body.id, 'ARCHIVED', 'normal');   // 直推 ARCHIVED（返工前置态）
  const fRework = await reqJson('POST', `/api/corrections/${F.body.id}/reopen-rework`, { reopen_reason: '归档后发现金额仍未改对，需返工重处理' }, ADMIN);
  ok(fRework.status === 200 && fRework.body.id, `[F] reopen-rework 派生返工子单 → 200（#${fRework.body.id}）`);
  const fChild = await dbGetAsync('SELECT process_type, rework_parent_id FROM correction_requests WHERE id=?', [fRework.body.id]);
  ok(fChild.rework_parent_id === F.body.id && fChild.process_type === '入职流程', '[F] 返工子单继承被返工单 process_type=入职流程');

  console.log(`\n✅ 流程类型字段验证通过：${pass} 项断言全绿（建单入库 + 详情 + 列表 + 非必填NULL + ≤100校验 + 跨系统/link-new/返工 三路继承）`);
  srv.close();
  process.exit(0);
})().catch(e => { console.error('❌ 验证失败：', e.message); try { srv && srv.close(); } catch (_) {} process.exit(1); });
