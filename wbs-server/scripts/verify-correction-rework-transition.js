// verify-correction-rework-transition.js — 归档单返工 Commit B 真实端点 e2e
//   router-mount + in-memory db + require-cache mock 钉钉。覆盖方案 §10.1 + §10.2：
//   A 前置守卫（reason 长度 / 非 ARCHIVED / 权限 / 不存在）
//   B 正常返工（象限④独立单升主单 + M-7 priority1 自动指派 + 子单 5 列 + 不写 requesters + 双 history + 原单 child_count++ 零污染）
//   C M-7 priority3（原开发 disabled / viewer / NULL → 停 PENDING_ASSIGN + 留痕）
//   D 链级去重（未结返工子单存在 → REWORK_ALREADY_OPEN）
//   E 递归返工（parent 固定=被返工 :id / root 不漂移 / seq=MAX+1）
//   F ≥5 次软阈值（REWORK_EXCESSIVE_NEEDS_CONFIRM；confirmed_excessive=true 放行）+ 早返回 ROLLBACK 原子性
//   G group_members 过滤职责拆清（组闸门不被返工子单卡 + 返工子单仍可经 root 查到）
//   H void 链级守卫（组主单分支①阻断 / 返工子单本身分支②排除自身放行 / 作废后放行 / 无权 403）
// 用法：node scripts/verify-correction-rework-transition.js
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

// ── require-cache mock 钉钉（必须在 require corrections 之前）──
let MK = 100;
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
  getAccessToken: async () => 'tok',
  resolveRequesterDingUserId: async (t, phone) => ({ ok: true, userid: 'uid_' + phone }),
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk_' + (MK++) }),
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
const DEV99 = { id: 99, username: 'dev99', display_name: '开发99', role: 'user' };

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
// B2（OA 截图强制·建单同步上传，H-3）：真OA模式建单须走 multipart 且带 ≥1 张 oa_proof_files
function reqMultipartCreate(fields, user) {
  return new Promise((resolve) => {
    const boundary = '----ReworkCreateBoundary' + Math.floor(1e8 + Math.random() * 1e8);
    const chunks = [];
    for (const [k, val] of Object.entries(fields || {})) {
      if (val === undefined || val === null) continue;
      const strVal = (typeof val === 'object') ? JSON.stringify(val) : String(val);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${strVal}\r\n`));
    }
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="oa_proof_files"; filename="oa_proof.png"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(png);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const r = http.request({ host: 'localhost', port: PORT, method: 'POST', path: '/api/corrections',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64') } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    r.write(bodyBuf); r.end();
  });
}
async function waitReady() {
  const t0 = Date.now();
  while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}
const setStatus = (id, status, ct) => dbRunAsync(`UPDATE correction_requests SET status=?, closure_type=? WHERE id=?`, [status, ct || null, id]);

// 直接造一张 ARCHIVED 被返工单（绕端点，精确控制 assigned_to/created_by/group_id 等）
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
  console.log('=== 归档单返工 Commit B 真实端点 e2e（reopen-rework + group_members 过滤 + void 守卫）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, status TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone,status) VALUES
    (1,'admin','管理员','admin','13900000001','active'),
    (99,'dev99','开发99','user','13900000099','active'),
    (7,'viewer7','查看7','viewer','13900000007','active'),
    (8,'dev8','开发8','user','13900000008','disabled')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ── A 前置守卫 ──
  console.log('— A 前置守卫 —');
  const pA = await mkArchived({ created_by: 1, assigned_to: 99 });
  const a1 = await reqJson('POST', `/api/corrections/${pA}/reopen-rework`, { reopen_reason: '太短' }, ADMIN);
  ok(a1.status === 400 && a1.body.code === 'REOPEN_REASON_REQUIRED', 'A1 reopen_reason <10 字 → 400 REOPEN_REASON_REQUIRED');
  const pFixed = await mkArchived({ status: 'FIXED' });
  const a2 = await reqJson('POST', `/api/corrections/${pFixed}/reopen-rework`, { reopen_reason: '非归档单不应允许返工的测试' }, ADMIN);
  ok(a2.status === 409 && a2.body.code === 'INVALID_STATE_FOR_REWORK', 'A2 非 ARCHIVED → 409 INVALID_STATE_FOR_REWORK');
  const a3 = await reqJson('POST', `/api/corrections/${pA}/reopen-rework`, { reopen_reason: '无权用户发起返工应被拦截' }, DEV99);
  ok(a3.status === 403 && a3.body.code === 'NOT_AUTHORIZED_TO_REOPEN', 'A3 非 admin 非建单人 → 403 NOT_AUTHORIZED_TO_REOPEN');
  const pCreator = await mkArchived({ created_by: 99, created_by_name: '开发99', assigned_to: 99 });
  const a3b = await reqJson('POST', `/api/corrections/${pCreator}/reopen-rework`, { reopen_reason: '建单人本人发起返工应放行' }, DEV99);
  ok(a3b.status === 200, 'A3b 建单人本人（user 角色）→ 200 放行（中间件未挂 requireAdmin）');
  const a4 = await reqJson('POST', `/api/corrections/999999/reopen-rework`, { reopen_reason: '不存在的单返工应返回 404' }, ADMIN);
  ok(a4.status === 404, 'A4 不存在的单 → 404');

  // ── B 正常返工：象限④独立单升主单 + M-7 priority1 自动指派 ──
  console.log('— B 正常返工（独立单升主单 + 自动指派）—');
  const p1 = await mkArchived({ assigned_to: 99, assigned_to_name: '开发99', created_by: 1 }); // group_id NULL（独立单）
  const r1 = await reqJson('POST', `/api/corrections/${p1}/reopen-rework`, { reopen_reason: '上次只改了表头没改明细数据需返工' }, ADMIN);
  ok(r1.status === 200 && r1.body.ok && r1.body.rework_seq === 1 && r1.body.status === 'ASSIGNED_PENDING_ESTIMATE' && r1.body.assigned_to === 99,
    `B1 独立单返工 → 200（升主单 + seq=1 + 自动指派回原开发99）`);
  const c1 = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [r1.body.id]);
  ok(Number(c1.correction_group_id) === p1 && Number(c1.rework_parent_id) === p1 && Number(c1.rework_root_id) === p1 && Number(c1.rework_seq) === 1,
    'B2 返工子单 group_id/parent/root=原单id，seq=1');
  ok(c1.status === 'ASSIGNED_PENDING_ESTIMATE' && Number(c1.assigned_to) === 99 && c1.reopen_reason && c1.reopen_reason.includes('明细'),
    'B3 子单已指派开发99 + reopen_reason 落库');
  ok(c1.requester_name === '业务张' && c1.source_system === 'BMS', 'B4 子单继承被返工单 业务方/系统（主表兼容列）');
  const p1row = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [p1]);
  ok(Number(p1row.correction_group_id) === p1 && p1row.status === 'ARCHIVED' && Number(p1row.rework_child_count) === 1,
    'B5 原单升主单(group_id=自身) + 状态零污染(仍 ARCHIVED) + rework_child_count=1');
  const c1reqs = await dbAllAsync('SELECT * FROM correction_requesters WHERE correction_request_id=?', [r1.body.id]);
  ok(c1reqs.length === 0, 'B6 返工子单不写 correction_requesters 子表（契约 B）');
  const c1hist = await dbAllAsync('SELECT * FROM correction_status_history WHERE correction_request_id=? ORDER BY id', [r1.body.id]);
  ok(c1hist.length === 2 && c1hist[0].from_status === null && c1hist[0].to_status === 'PENDING_ASSIGN'
     && c1hist[1].from_status === 'PENDING_ASSIGN' && c1hist[1].to_status === 'ASSIGNED_PENDING_ESTIMATE',
    'B7 子单 2 条 history（NULL→PENDING_ASSIGN 建单 + PENDING_ASSIGN→ASSIGNED 自动指派）');
  const p1hist = await dbAllAsync("SELECT * FROM correction_status_history WHERE correction_request_id=? AND from_status='ARCHIVED' AND to_status='ARCHIVED' AND reason LIKE '已派生返工子单%'", [p1]);
  ok(p1hist.length === 1, 'B8 原单留派生 history（ARCHIVED→ARCHIVED 同态留痕，不改状态）');

  // ── C M-7 priority3：原开发无效 → 停 PENDING_ASSIGN ──
  console.log('— C M-7 priority3（原开发无效停 PENDING_ASSIGN）—');
  const pDis = await mkArchived({ assigned_to: 8, assigned_to_name: '开发8' }); // 8=disabled
  const rDis = await reqJson('POST', `/api/corrections/${pDis}/reopen-rework`, { reopen_reason: '原开发已禁用应停在待指派态' }, ADMIN);
  ok(rDis.status === 200 && rDis.body.status === 'PENDING_ASSIGN' && rDis.body.assigned_to === null, 'C1 原开发 disabled → 停 PENDING_ASSIGN + 不指派');
  const cDisHist = await dbAllAsync("SELECT * FROM correction_status_history WHERE correction_request_id=? AND reason LIKE '返工自动指派失败%'", [rDis.body.id]);
  ok(cDisHist.length === 1, 'C2 原开发无效留痕"返工自动指派失败"');
  const pView = await mkArchived({ assigned_to: 7, assigned_to_name: '查看7' }); // 7=viewer
  const rView = await reqJson('POST', `/api/corrections/${pView}/reopen-rework`, { reopen_reason: '原开发是查看者应停在待指派态' }, ADMIN);
  ok(rView.status === 200 && rView.body.status === 'PENDING_ASSIGN', 'C3 原开发 viewer → 停 PENDING_ASSIGN');
  const pNull = await mkArchived({ assigned_to: null, assigned_to_name: null });
  const rNull = await reqJson('POST', `/api/corrections/${pNull}/reopen-rework`, { reopen_reason: '原开发为空应停在待指派态测试' }, ADMIN);
  ok(rNull.status === 200 && rNull.body.status === 'PENDING_ASSIGN', 'C4 assigned_to 为空（=admin_closure 从未指派的归档单）→ 停 PENDING_ASSIGN（M-7 弃 priority2 后的预期降级，codex M-2）');

  // ── D 链级去重 ──
  console.log('— D 链级去重 —');
  const rDup = await reqJson('POST', `/api/corrections/${p1}/reopen-rework`, { reopen_reason: '上一张返工还没结束就想再返工' }, ADMIN);
  ok(rDup.status === 409 && rDup.body.code === 'REWORK_ALREADY_OPEN' && Number(rDup.body.open_child_id) === Number(r1.body.id),
    'D1 root 链下有未结返工子单 → 409 REWORK_ALREADY_OPEN（指明 open_child_id）');

  // ── E 递归返工：parent 固定 / root 不漂移 / seq=MAX+1 ──
  console.log('— E 递归返工 —');
  await setStatus(r1.body.id, 'ARCHIVED', 'normal'); // c1 归档（完成第 1 次返工）
  const rRec = await reqJson('POST', `/api/corrections/${r1.body.id}/reopen-rework`, { reopen_reason: '返工后仍未改对需要再返工一次' }, ADMIN);
  ok(rRec.status === 200 && rRec.body.rework_seq === 2, 'E1 递归返工被返工子单 → 200 + seq=2（MAX+1）');
  const c2 = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [rRec.body.id]);
  ok(Number(c2.rework_parent_id) === Number(r1.body.id), 'E2 parent 固定 = 本次被返工的具体单 :id（c1），非原始单');
  ok(Number(c2.rework_root_id) === p1 && Number(c2.correction_group_id) === p1, 'E3 root 不漂移（仍=原始单 p1）+ group_id=组 master(p1)');
  const c1after = await dbGetAsync('SELECT rework_child_count FROM correction_requests WHERE id=?', [r1.body.id]);
  ok(Number(c1after.rework_child_count) === 1, 'E4 被返工单（c1）rework_child_count++ = 1');

  // ── F ≥5 次软阈值 + 早返回原子性 ──
  console.log('— F ≥5 次软阈值 —');
  const fRoot = await mkArchived({ assigned_to: 99 });
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [fRoot, fRoot]); // 升主单
  for (let s = 1; s <= 4; s++) {
    await dbRunAsync(`INSERT INTO correction_requests (source_system,location_info,correction_count,reason,correction_type,requester_name,status,closure_type,created_by,correction_group_id,rework_parent_id,rework_root_id,rework_seq)
      VALUES ('BMS','loc',1,'返工链占位原因文本足够长','single','业务张','ARCHIVED','normal',1,?,?,?,?)`, [fRoot, fRoot, fRoot, s]);
  }
  const childCntBefore = (await dbAllAsync('SELECT id FROM correction_requests WHERE rework_root_id=?', [fRoot])).length;
  const rExc = await reqJson('POST', `/api/corrections/${fRoot}/reopen-rework`, { reopen_reason: '第五次返工应触发软阈值确认拦截' }, ADMIN);
  ok(rExc.status === 409 && rExc.body.code === 'REWORK_EXCESSIVE_NEEDS_CONFIRM' && rExc.body.rework_seq === 5, 'F1 第 5 次返工 → 409 REWORK_EXCESSIVE_NEEDS_CONFIRM(seq=5)');
  const fRootAfter = await dbGetAsync('SELECT rework_child_count FROM correction_requests WHERE id=?', [fRoot]);
  const childCntAfter = (await dbAllAsync('SELECT id FROM correction_requests WHERE rework_root_id=?', [fRoot])).length;
  ok((fRootAfter.rework_child_count == null || Number(fRootAfter.rework_child_count) === 0) && childCntAfter === childCntBefore,
    'F2 EXCESSIVE 早返回原子性：原单 child_count 未变 + 无新子单（ROLLBACK 生效）');
  const rExc2 = await reqJson('POST', `/api/corrections/${fRoot}/reopen-rework`, { reopen_reason: '确认后第五次返工应放行执行', confirmed_excessive: true }, ADMIN);
  ok(rExc2.status === 200 && rExc2.body.rework_seq === 5, 'F3 confirmed_excessive=true → 200 放行（seq=5）');

  // ── G group_members 过滤职责拆清（§9.3 / §10.2）──
  console.log('— G group_members 过滤职责拆清 —');
  // B1（OA 格式闸 + 自发现自动业务方，方案 v1.5 §2.3 H-2/M-7）：留空 OA 会被后端静默覆盖为"业务方=建单人"，
  //   下方 3 处跨系统建单用例依赖自定义 requesters[] 姓名/手机号（notify-done 反查用），须带真实 OA 号。
  const gcb = await reqMultipartCreate( { source_system: 'BMS', location_info: '系统1字段错', correction_type: 'single', oa_number: '900301',
    reason: 'group过滤测试跨系统建单原因文本', requesters: [{ name: '主业务方G', phone: '13800000009' }],
    error_proof_note: 'err', cross_system: true, system2: { source_system: 'CRM', location_info: '系统2字段错', correction_count: 2 } }, ADMIN);
  const gMaster = gcb.body.master_id, gChild = gcb.body.child_ids[0];
  await setStatus(gMaster, 'FIXED'); await setStatus(gChild, 'FIXED'); // 两原成员完成
  // 组内直插一张未结返工子单（挂 gMaster，parent/root=gMaster，seq=1）
  const gRework = await dbRunAsync(`INSERT INTO correction_requests (source_system,location_info,correction_count,reason,correction_type,requester_name,status,created_by,correction_group_id,rework_parent_id,rework_root_id,rework_seq)
    VALUES ('BMS','loc',1,'组内返工子单占位原因文本','single','主业务方G','ASSIGNED_PENDING_ESTIMATE',1,?,?,?,1)`, [gMaster, gMaster, gMaster]);
  const gReworkId = gRework.lastID;
  const anchorObj = await I.resolveCorrectionGroupAnchor(gMaster);
  ok(anchorObj.group_members.length === 2 && !anchorObj.group_members.some(m => Number(m.id) === gReworkId),
    'G1 group_members 过滤掉返工子单（仅 2 原成员，不含返工子单）');
  const greq = await dbGetAsync('SELECT id FROM correction_requesters WHERE correction_request_id=? AND is_primary=1', [gMaster]);
  const gNotify = await reqJson('POST', `/api/corrections/${gMaster}/notify-done`, { requester_id: greq.id }, ADMIN);
  const gSent = await dbGetAsync('SELECT completion_notify_status FROM correction_requesters WHERE id=?', [greq.id]);
  ok(gNotify.status === 200 && gSent && gSent.completion_notify_status === 'sent', 'G2 组闸门不被未结返工子单阻塞（两原成员 FIXED → notify-done 200 且业务方真实落 completion_notify_status=sent，断真实副作用非恒真，codex L-5）');
  const byRoot = await dbAllAsync('SELECT id FROM correction_requests WHERE rework_root_id=? AND rework_parent_id IS NOT NULL', [gMaster]);
  ok(byRoot.some(r => Number(r.id) === gReworkId), 'G3 返工子单仍可经 rework_root_id 单独查到（职责拆清：未从系统消失）');

  // ── H void 链级守卫 ──
  console.log('— H void 链级守卫 —');
  const h1 = await reqJson('POST', `/api/corrections/${gMaster}/void`, { void_reason: '组主单有未结返工子单时作废测试' }, ADMIN);
  ok(h1.status === 409 && h1.body.code === 'VOID_BLOCKED_REWORK_IN_PROGRESS' && h1.body.blockers.includes(gReworkId),
    'H1 void 组主单（有未结返工子单）→ 409 VOID_BLOCKED_REWORK_IN_PROGRESS（含 blockers）');
  const h2 = await reqJson('POST', `/api/corrections/${gReworkId}/void`, { void_reason: '作废返工子单本身应放行测试' }, ADMIN);
  ok(h2.status === 200 && h2.body.status === 'VOIDED', 'H2 void 返工子单本身（分支②排除自身）→ 200 放行');
  const h3 = await reqJson('POST', `/api/corrections/${gMaster}/void`, { void_reason: '返工子单已作废后组主单可作废' }, ADMIN);
  ok(h3.status === 200 && h3.body.status === 'VOIDED', 'H3 返工子单作废后 → 组主单可作废（无未结链）');
  const pH4 = await mkArchived({ created_by: 1 });
  const h4 = await reqJson('POST', `/api/corrections/${pH4}/void`, { void_reason: '无权用户作废应被拦截测试' }, DEV99);
  ok(h4.status === 403 && h4.body.code === 'NOT_AUTHORIZED_TO_VOID', 'H4 无权用户 void → 403 NOT_AUTHORIZED_TO_VOID（守卫前置权限预检）');
  // H5：ARCHIVED 单无返工链 → 仍可作废（不破坏 G-14 归档后可作废旁路）
  const pH5 = await mkArchived({ created_by: 1, assigned_to: 99 });
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [pH5, pH5]);
  const h5 = await reqJson('POST', `/api/corrections/${pH5}/void`, { void_reason: 'ARCHIVED 无返工链应正常作废' }, ADMIN);
  ok(h5.status === 200 && h5.body.status === 'VOIDED', 'H5 ARCHIVED 单无返工链 → 正常作废（G-14 旁路未被守卫破坏）');

  // ── I 象限②：reopen 跨系统子单（group_id 非空 + root 落自身，方案 §9.1 象限② / 对抗审 MEDIUM 补盲）──
  console.log('— I 象限② reopen 跨系统子单 —');
  const icb = await reqMultipartCreate( { source_system: 'BMS', location_info: '系统1象限2字段错', correction_type: 'single', oa_number: '900302',
    reason: '象限2跨系统子单返工测试原因文本', requesters: [{ name: '主业务方I', phone: '13800000019' }],
    error_proof_note: 'err', cross_system: true, system2: { source_system: 'CRM', location_info: '系统2象限2字段错', correction_count: 2 } }, ADMIN);
  const iMaster = icb.body.master_id, iChild = icb.body.child_ids[0];
  await dbRunAsync("UPDATE correction_requests SET status='ARCHIVED', closure_type='normal', assigned_to=99, assigned_to_name='开发99' WHERE id=?", [iChild]); // system2 改完归档后发现没改对
  const rI = await reqJson('POST', `/api/corrections/${iChild}/reopen-rework`, { reopen_reason: 'system2 字段没改对需要返工处理' }, ADMIN);
  ok(rI.status === 200 && rI.body.rework_seq === 1, 'I1 reopen 跨系统子单 → 200 + seq=1');
  const ic = await dbGetAsync('SELECT * FROM correction_requests WHERE id=?', [rI.body.id]);
  ok(Number(ic.correction_group_id) === iMaster, 'I2 象限②：返工子单 group_id=组 master_id（被返工子单所属组，非被返工子单自身、非升主单）');
  ok(Number(ic.rework_parent_id) === iChild && Number(ic.rework_root_id) === iChild, 'I3 象限②：parent=被返工子单 id + root【落自身 iChild】（区别象限③ root=最初原始单）');
  ok(iMaster !== iChild && Number(ic.correction_group_id) !== Number(ic.id), 'I4 象限②：[2g] 成立（group_id=master≠子单≠返工子单自身）');
  // I5 组主单终态（VOIDED/REJECTED）→ 不可对其子单返工（codex M-1）
  const itcb = await reqMultipartCreate( { source_system: 'BMS', location_info: '系统1终态组', correction_type: 'single', oa_number: '900303',
    reason: '终态组主单返工拦截测试原因文本', requesters: [{ name: '主I2', phone: '13800000020' }],
    error_proof_note: 'err', cross_system: true, system2: { source_system: 'CRM', location_info: '系统2终态组', correction_count: 2 } }, ADMIN);
  const itMaster = itcb.body.master_id, itChild = itcb.body.child_ids[0];
  await dbRunAsync("UPDATE correction_requests SET status='ARCHIVED', closure_type='normal', assigned_to=99 WHERE id=?", [itChild]);
  await setStatus(itMaster, 'REJECTED'); // 组主单否决（终态）
  const rIt = await reqJson('POST', `/api/corrections/${itChild}/reopen-rework`, { reopen_reason: '组主单已否决应拦截返工测试' }, ADMIN);
  ok(rIt.status === 409 && rIt.body.code === 'REWORK_GROUP_TERMINAL', 'I5 组主单 REJECTED（终态）→ 子单 reopen 被拦 409 REWORK_GROUP_TERMINAL');

  // ── J 真并发竞态：两个 reopen 同 root → 恰 1 成功 + 恰 1 未结子单（链级去重+唯一索引+单连接串行共同兜底）──
  console.log('— J 真并发竞态 —');
  const jRoot = await mkArchived({ assigned_to: 99 });
  const [jA, jB] = await Promise.all([
    reqJson('POST', `/api/corrections/${jRoot}/reopen-rework`, { reopen_reason: '并发返工竞态测试请求A内容文本' }, ADMIN),
    reqJson('POST', `/api/corrections/${jRoot}/reopen-rework`, { reopen_reason: '并发返工竞态测试请求B内容文本' }, ADMIN),
  ]);
  const jSucc = [jA, jB].filter(r => r.status === 200).length;
  const jLoser = [jA, jB].find(r => r.status !== 200);
  ok(jSucc === 1, `J1 两并发 reopen 同 root → 恰 1 个 200，不会双开`);
  // 败者必须是【设计内失败】（codex L-6 收紧）：① 409 链级去重/seq 冲突（A 先 COMMIT、B 读到已提交子单）；
  //   ② 500 单连接事务嵌套（B 的 BEGIN 撞 A 未结事务报 'transaction within a transaction'——本项目单连接无 mutex 的【系统性】响亮失败，非 Commit B 引入，对抗审已定性）。排除其他异常码混入算通过。
  const jLoserOk = jLoser && (
    (jLoser.status === 409 && ['REWORK_ALREADY_OPEN', 'REWORK_SEQ_CONFLICT'].includes(jLoser.body && jLoser.body.code)) ||
    jLoser.status === 500);
  ok(jLoserOk, `J1b 败者是设计内失败（409 ALREADY_OPEN/SEQ_CONFLICT 或 500 单连接事务嵌套），实际 status=${jLoser ? jLoser.status : '?'} code=${jLoser && jLoser.body ? jLoser.body.code : '?'}`);
  const jOpen = await dbAllAsync("SELECT id FROM correction_requests WHERE rework_root_id=? AND rework_parent_id IS NOT NULL AND status NOT IN ('ARCHIVED','VOIDED','REJECTED')", [jRoot]);
  ok(jOpen.length === 1, 'J2 该 root 下未结返工子单恰 1（无双开 / 无 seq 撞库脏数据）');

  console.log(`\n✅ verify-correction-rework-transition 全部通过（${pass} 项）`);
  srv.close(); db.close();
  process.exit(0);
})().catch(e => { console.error('\n❌ 验证失败：', e && (e.stack || e.message)); try { srv && srv.close(); } catch (_) {} process.exit(1); });
