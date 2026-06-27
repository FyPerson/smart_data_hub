// verify-correction-rework-gate.js — 归档单返工 Commit C 留证闸门四组合 e2e
//   覆盖方案 §5.1（双必填不外溢 single）+ §5.2（error_proof 继承只读）+ §10.1 四组合 + M-4 探针。
//   门逻辑全在 correctionTransition 的 FIXED/REFIXED case，故直接调 _internals.correctionTransition 测门
//   （预插 correction_attachments 控制 uploaded_by/created_at），error_proof 继承走真实 GET /:id 端点。
//   A 普通 single 不外溢（红线：文字仍选填）  B 普通 batch 不外溢（无需 fix_proof）
//   C 返工 single 双必填（截图必传 + 文字必填≥5）  D 返工 batch 双必填（重灾：新增 fix_proof 截图必传）
//   E error_proof 继承（返工子单 detail 返组主单 error_proof）  F M-4 脏数据探针
// 用法：node scripts/verify-correction-rework-gate.js
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
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk1' }),
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

// 造一张指定状态/类型/返工维度的单（绕端点，精确控制 assigned_to/group_id/rework_parent_id/fixed_at）
async function mkReq(o = {}) {
  const base = { source_system: 'BMS', location_info: 'loc', correction_count: 1, reason: '原始修正原因占位文本足够长',
    correction_type: 'single', requester_name: '业务张', requester_phone: '13800000001',
    status: 'IN_PROGRESS', created_by: 1, created_by_name: '管理员', assigned_to: 99, assigned_to_name: '开发99' };
  const row = { ...base, ...o };
  const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return r.lastID;
}
// 插一张合规 fix_proof 附件（uploaded_by=99 默认=assigned_to，命中 H-2 归属）；createdAt 省略=now
async function addFixProof(reqId, createdAt) {
  const cols = ['correction_request_id', 'attachment_type', 'file_name', 'original_name', 'file_size', 'mime_type', 'uploaded_by', 'uploaded_by_name'];
  const vals = [reqId, 'fix_proof', 'fp_' + reqId + '.png', '结果.png', 100, 'image/png', 99, '开发99'];
  if (createdAt) { cols.push('created_at'); vals.push(createdAt); }
  const r = await dbRunAsync(`INSERT INTO correction_attachments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  return r.lastID;
}
async function addErrorProof(reqId) {
  const r = await dbRunAsync(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
    VALUES (?, 'error_proof', ?, '错误.png', 100, 'image/png', 99, '开发99')`, [reqId, 'ep_' + reqId + '.png']);
  return r.lastID;
}
// 调门并归一化为 { ok|code }（transition 成功返 {ok:true}，业务错误抛 CorrectionTransitionError）
async function callGate(id, from, to, payload) {
  try { const r = await I.correctionTransition(id, from, to, ADMIN, payload); return { ok: !!(r && r.ok) }; }
  catch (e) { return { code: e.code || 'ERR', status: e.httpStatus, msg: e.message }; }
}

(async () => {
  console.log('=== 归档单返工 Commit C 留证闸门四组合 e2e（双必填不外溢 + error_proof 继承）===\n');
  await dbRunAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, status TEXT)`);
  await dbRunAsync(`INSERT INTO users (id,username,display_name,role,phone,status) VALUES
    (1,'admin','管理员','admin','13900000001','active'),
    (99,'dev99','开发99','user','13900000099','active')`);
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;
  const PAST = '2020-01-01 00:00:00';   // REFIXED 新增性基线（fixed_at），插的新 fix_proof created_at=now 必 > 此

  // ════ A 普通 single 不外溢（红线：文字仍选填，行为不变）════
  console.log('— A 普通 single 不外溢 —');
  const a1 = await mkReq({ correction_type: 'single' }); await addFixProof(a1);
  ok((await callGate(a1, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '' })).ok, 'A1 普通 single 标完成 + fix_proof 存在 + 文字空 → 放行（完成说明仍选填，未被返工必填外溢）');
  const a2 = await mkReq({ correction_type: 'single', status: 'FIXED', fixed_at: PAST });
  const a2fp = await addFixProof(a2);
  ok((await callGate(a2, 'FIXED', 'REFIXED', { new_fix_proof_attachment_ids: [a2fp], resubmit_note: '' })).ok, 'A2 普通 single 重修 + 新增 fix_proof + 重修说明空 → 放行（resubmit_note 仍选填，未被外溢）');
  const a3 = await mkReq({ correction_type: 'single' }); await addFixProof(a3);
  ok((await callGate(a3, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '好' })).ok, 'A3 普通 single + fix_proof + 文字「好」(1 字) → 放行（返工 ≥5 防敷衍下限未外溢到普通 single，对抗审 NIT-1 钉死）');

  // ════ B 普通 batch 不外溢（无需 fix_proof，行为不变）════
  console.log('— B 普通 batch 不外溢 —');
  const b1 = await mkReq({ correction_type: 'batch' });
  ok((await callGate(b1, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '已修正全部明细数据' })).ok, 'B1 普通 batch 标完成 + 文字≥5 + 无 fix_proof → 放行（batch 本就不要求截图，未被返工截图必传外溢）');
  const b2 = await mkReq({ correction_type: 'batch', status: 'FIXED', fixed_at: PAST });
  ok((await callGate(b2, 'FIXED', 'REFIXED', { resubmit_note: '重新核对并修正了明细' })).ok, 'B2 普通 batch 重修 + 文字 + 无新增 fix_proof → 放行（未被外溢）');

  // ════ C 返工 single 双必填（截图必传 + 文字必填≥5）════
  console.log('— C 返工 single 双必填 —');
  // 每张返工子单挂一张独立新主单（root 唯一），规避 (rework_root_id, rework_seq) 唯一索引在多测试间撞库
  const mkRework = async (o = {}) => {
    const m = await mkReq({ status: 'ARCHIVED', closure_type: 'normal' });
    await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [m, m]);   // 升主单
    return mkReq({ correction_group_id: m, rework_parent_id: m, rework_root_id: m, rework_seq: 1, ...o });
  };

  const c1 = await mkRework({ correction_type: 'single' }); await addFixProof(c1);
  const c1r = await callGate(c1, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '' });
  ok(c1r.code === 'REWORK_COMPLETION_NOTE_REQUIRED', 'C1 返工 single 标完成 + 有 fix_proof + 文字空 → 400 REWORK_COMPLETION_NOTE_REQUIRED（文字必填）');
  const c2 = await mkRework({ correction_type: 'single' }); await addFixProof(c2);
  const c2r = await callGate(c2, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '1' });
  ok(c2r.code === 'REWORK_COMPLETION_NOTE_TOO_SHORT', 'C2 返工 single 文字「1」(<5) → 400 REWORK_COMPLETION_NOTE_TOO_SHORT（防敷衍）');
  const c3 = await mkRework({ correction_type: 'single' }); await addFixProof(c3);
  ok((await callGate(c3, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '已重新修正明细完成' })).ok, 'C3 返工 single + fix_proof + 文字≥5 → 放行');
  const c4 = await mkRework({ correction_type: 'single' });   // 无 fix_proof
  const c4r = await callGate(c4, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '已重新修正明细完成' });
  ok(c4r.code === 'FIX_PROOF_REQUIRED', 'C4 返工 single 文字合规但无 fix_proof → 400 FIX_PROOF_REQUIRED（截图必传仍守，普通 single 同款门未削弱）');
  const c5 = await mkRework({ correction_type: 'single', status: 'FIXED', fixed_at: PAST }); const c5fp = await addFixProof(c5);
  const c5r = await callGate(c5, 'FIXED', 'REFIXED', { new_fix_proof_attachment_ids: [c5fp], resubmit_note: '' });
  ok(c5r.code === 'REWORK_RESUBMIT_NOTE_REQUIRED', 'C5 返工 single 重修 + 新增 fix_proof + 重修说明空 → 400 REWORK_RESUBMIT_NOTE_REQUIRED');
  const c6 = await mkRework({ correction_type: 'single', status: 'FIXED', fixed_at: PAST }); const c6fp = await addFixProof(c6);
  ok((await callGate(c6, 'FIXED', 'REFIXED', { new_fix_proof_attachment_ids: [c6fp], resubmit_note: '本次重新修正了字段' })).ok, 'C6 返工 single 重修 + 新增 fix_proof + 重修说明≥5 → 放行');
  const c7 = await mkRework({ correction_type: 'single', status: 'FIXED', fixed_at: PAST }); const c7fp = await addFixProof(c7);
  const c7r = await callGate(c7, 'FIXED', 'REFIXED', { new_fix_proof_attachment_ids: [c7fp], resubmit_note: '1' });
  ok(c7r.code === 'REWORK_RESUBMIT_NOTE_TOO_SHORT', 'C7 返工 single 重修 + 新增 fix_proof + 重修说明「1」(<5) → 400 REWORK_RESUBMIT_NOTE_TOO_SHORT（对抗审 M-2 补漏档：4 新错误码全覆盖）');

  // ════ D 返工 batch 双必填（重灾：现有 batch 不要求 fix_proof，返工 batch 新增截图必传）════
  console.log('— D 返工 batch 双必填（新增 fix_proof 截图必传）—');
  const d1 = await mkRework({ correction_type: 'batch' });   // 无 fix_proof
  const d1r = await callGate(d1, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '已批量修正全部明细' });
  ok(d1r.code === 'FIX_PROOF_REQUIRED', 'D1 返工 batch 标完成 + 文字≥5 + 无 fix_proof → 400 FIX_PROOF_REQUIRED（返工 batch 额外要求截图）');
  const d2 = await mkRework({ correction_type: 'batch' }); await addFixProof(d2);
  ok((await callGate(d2, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '已批量修正全部明细' })).ok, 'D2 返工 batch + 文字≥5 + fix_proof 存在 → 放行');
  const d3 = await mkRework({ correction_type: 'batch', status: 'FIXED', fixed_at: PAST });
  const d3r = await callGate(d3, 'FIXED', 'REFIXED', { resubmit_note: '批量重新核对修正', new_fix_proof_attachment_ids: [] });
  ok(d3r.code === 'FIX_PROOF_REQUIRED', 'D3 返工 batch 重修 + 文字 + 无新增 fix_proof → 400 FIX_PROOF_REQUIRED');
  const d4 = await mkRework({ correction_type: 'batch', status: 'FIXED', fixed_at: PAST }); const d4fp = await addFixProof(d4);
  ok((await callGate(d4, 'FIXED', 'REFIXED', { resubmit_note: '批量重新核对修正', new_fix_proof_attachment_ids: [d4fp] })).ok, 'D4 返工 batch 重修 + 文字 + 新增 fix_proof → 放行');
  // 返工 batch 文字防敷衍补格（对抗审 NIT-3 矩阵缺格 + L-1 新口径）
  const d5 = await mkRework({ correction_type: 'batch' }); await addFixProof(d5);
  ok((await callGate(d5, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '' })).code === 'BATCH_NOTE_REQUIRED', 'D5 返工 batch 标完成 + fix_proof + 文字空 → 400 BATCH_NOTE_REQUIRED（batch 既有文字必填未被削弱）');
  const d6 = await mkRework({ correction_type: 'batch' }); await addFixProof(d6);
  ok((await callGate(d6, 'IN_PROGRESS', 'FIXED', { batch_completion_note: '1' })).code === 'BATCH_NOTE_TOO_SHORT', 'D6 返工 batch 标完成 + fix_proof + 文字「1」(<5) → 400 BATCH_NOTE_TOO_SHORT（防敷衍）');
  const d7 = await mkRework({ correction_type: 'batch', status: 'FIXED', fixed_at: PAST }); const d7fp = await addFixProof(d7);
  ok((await callGate(d7, 'FIXED', 'REFIXED', { resubmit_note: '1', new_fix_proof_attachment_ids: [d7fp] })).code === 'REWORK_RESUBMIT_NOTE_TOO_SHORT', 'D7 返工 batch 重修 + 新增 fix_proof + 文字「1」(<5) → 400 REWORK_RESUBMIT_NOTE_TOO_SHORT（对抗审 L-1：返工四组合文字 ≥5 全对齐）');

  // ════ G 端点层 files>0 闸门（对抗审 M-1）：返工 batch complete 须本次上传文件，堵并发借用零留证 + 不外溢普通 batch ════
  console.log('— G 端点层 files>0 闸门（对抗审 M-1）—');
  const g1 = await mkRework({ correction_type: 'batch' });   // IN_PROGRESS 返工 batch
  const g1r = await reqJson('POST', `/api/corrections/${g1}/complete`, { batch_completion_note: '已批量修正全部明细' }, ADMIN);   // 无 multipart → req.files=[]
  ok(g1r.status === 400 && g1r.body.code === 'FIX_PROOF_REQUIRED', 'G1 端点：返工 batch complete 无文件 → 400 FIX_PROOF_REQUIRED（胜者必持自身截图，堵并发借用在途 fix_proof 零留证）');
  const g2 = await mkReq({ correction_type: 'batch' });   // 普通 batch IN_PROGRESS
  const g2r = await reqJson('POST', `/api/corrections/${g2}/complete`, { batch_completion_note: '已批量修正全部明细' }, ADMIN);
  ok(g2r.status === 200 && g2r.body.status === 'FIXED', 'G2 端点：普通 batch complete 无文件 → 200 FIXED（files>0 闸门未外溢普通 batch，且真实端点编排 happy-path）');

  // ════ E error_proof 继承只读（§5.2）：返工子单 detail 返组主单 error_proof ════
  console.log('— E error_proof 继承（返工子单读组主单错误证明）—');
  const epMaster = await mkReq({ status: 'ARCHIVED', closure_type: 'normal', error_proof_note: '主单错误证明说明文本' });
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [epMaster, epMaster]);   // 升主单
  await addErrorProof(epMaster);   // error_proof 物理只挂主单
  const epRework = await mkReq({ status: 'ASSIGNED_PENDING_ESTIMATE', correction_group_id: epMaster, rework_parent_id: epMaster, rework_root_id: epMaster, rework_seq: 1 });
  const anchorEp = await I.resolveCorrectionGroupAnchor(epRework);
  ok(anchorEp && Number(anchorEp.master_id) === epMaster, 'E0 返工子单 anchor.master_id = 组主单（detail 据此合并 error_proof）');
  const epDetail = await reqJson('GET', `/api/corrections/${epRework}`, null, ADMIN);
  ok(epDetail.status === 200 && epDetail.body.request.effective_error_proof_note === '主单错误证明说明文本', 'E1 返工子单 detail effective_error_proof_note = 主单 error_proof_note（继承）');
  const epAtts = Array.isArray(epDetail.body.attachments) ? epDetail.body.attachments : [];
  const epInherited = epAtts.filter(a => a.attachment_type === 'error_proof');
  ok(epInherited.length === 1 && epInherited[0].from_master === true, 'E2 返工子单 detail 含组主单 error_proof 附件 1 张 + from_master=true（只读继承）');
  const epSelfFix = epAtts.filter(a => a.attachment_type === 'fix_proof');
  ok(epSelfFix.length === 0, 'E3 返工子单未额外获得主单 fix_proof（接口级不变量：仅继承 error_proof）');

  // ════ F M-4 探针：error_proof 物理只挂主单/无组单（correction_group_id == id 或 NULL）════
  console.log('— F M-4 脏数据探针 —');
  const dirty = await dbAllAsync(`SELECT a.id FROM correction_attachments a JOIN correction_requests r ON r.id = a.correction_request_id
    WHERE a.attachment_type='error_proof' AND r.correction_group_id IS NOT NULL AND r.correction_group_id != r.id`);
  ok(dirty.length === 0, 'F1 M-4 探针：无「error_proof 挂在子单(group_id≠id)」脏数据（error_proof 物理只在主单/无组单，继承靠读时合并）');

  console.log(`\n✅ verify-correction-rework-gate 全部通过（${pass} 项）`);
  srv.close(); db.close();
  process.exit(0);
})().catch(e => { console.error('\n❌ 验证失败：', e && (e.stack || e.message)); try { srv && srv.close(); } catch (_) {} process.exit(1); });
