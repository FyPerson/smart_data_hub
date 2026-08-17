// verify-correction-rework-detail.js — 归档单返工 Commit D 读侧 e2e（list 补字段 + detail 返工链回溯 + M-1 数据）
//   router-mount + in-memory db + require-cache mock 钉钉（同 verify-correction-rework-transition 范式）。覆盖方案 §5.3/§八/§9.2#6：
//   A list 端点补 4 rework 字段（rework_parent_id/rework_root_id/rework_seq/rework_child_count）
//   B detail rework_chain 组装（原单 is_root + 全部返工子单按 seq 平铺 + 各 fix_proof 摘要 + reopen_reason）
//   C 普通单 rework_chain=null（防 N+1：非返工链单零链查询路径）
//   D M-1 区分数据（list 可推断「组内非返工成员数」：纯返工组=1 vs 跨系统组≥2）
//   E 递归链不漂移（child2 parent=child1 但 chain 仍按 root 平铺，非嵌套）
// 用法：node scripts/verify-correction-rework-detail.js
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
  sendMarkdownToUser: async () => ({ errcode: 0, processQueryKey: 'mk_1' }),
  sendFileToUser: async () => ({ errcode: 0 }), uploadMedia: async () => 'media1',
  getReadStatus: async () => ({ readDetails: [] }), escapeMarkdown: (x) => x,
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
  safeDeleteFileSync: noop, maskPhone: (x) => x,
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
// 直插一张修正单（精确控制 rework 字段），返回 id
async function mkRow(o = {}) {
  const base = { source_system: 'BMS', location_info: 'loc', correction_count: 1, reason: '修正原因占位文本足够长',
    correction_type: 'single', requester_name: '业务张', status: 'ARCHIVED', closure_type: 'normal',
    created_by: 1, created_by_name: '管理员', assigned_to: 99, assigned_to_name: '开发99' };
  const row = { ...base, ...o };
  const keys = Object.keys(row);
  const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return r.lastID;
}
// 直插一条 fix_proof 附件（摘要测试用）
async function mkFixProof(cid, name) {
  await dbRunAsync(
    `INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
     VALUES (?, 'fix_proof', ?, ?, 1024, 'image/png', 99, '开发99')`,
    [cid, `2026/06/${name}`, name]);
}

(async () => {
  console.log('=== 归档单返工 Commit D 读侧 e2e（list 补字段 + detail 返工链）===\n');
  mod.initSchema();
  await waitReady();
  const app = express(); app.use(express.json()); app.use('/api/corrections', mod.router);
  srv = app.listen(0); PORT = srv.address().port;

  // ── 造链：原单 R（升主单 group_id=R, child_count=2）+ child1(seq1,ARCHIVED)+ child2(seq2,IN_PROGRESS, parent=child1 递归) ──
  const R = await mkRow({ fixed_at: '2026-06-20 10:00:00', archived_at: '2026-06-20 12:00:00' });
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=?, rework_child_count=2 WHERE id=?', [R, R]);
  await mkFixProof(R, 'root_proof.png');
  const child1 = await mkRow({ status: 'ARCHIVED', correction_group_id: R, rework_parent_id: R, rework_root_id: R, rework_seq: 1,
    reopen_reason: '原单只改了表头没改明细数据需返工', fixed_at: '2026-06-21 10:00:00', archived_at: '2026-06-21 12:00:00' });
  await mkFixProof(child1, 'child1_proof.png');
  const child2 = await mkRow({ status: 'IN_PROGRESS', correction_group_id: R, rework_parent_id: child1, rework_root_id: R, rework_seq: 2,
    reopen_reason: '第一次返工后仍有遗留需要再修一次', fixed_at: null, archived_at: null });
  // 普通单 N（无组无返工）
  const N = await mkRow({ correction_group_id: null, assigned_to: 1, assigned_to_name: '管理员' });
  // 跨系统组：master gM + sibling gS（均非返工）+ 一张返工子单 gRw（M-1 边缘：跨系统主单【已派生返工】rework_child_count>0，对抗审点名场景）
  const gM = await mkRow({ status: 'FIXED' });
  await dbRunAsync('UPDATE correction_requests SET correction_group_id=?, rework_child_count=1 WHERE id=?', [gM, gM]);
  const gS = await mkRow({ status: 'FIXED', correction_group_id: gM, source_system: 'HRD' });
  const gRw = await mkRow({ status: 'ASSIGNED_PENDING_ESTIMATE', correction_group_id: gM, rework_parent_id: gM, rework_root_id: gM, rework_seq: 1, reopen_reason: '跨系统组返工子单占位原因文本' });

  // ── A list 端点补 4 rework 字段 ──
  console.log('— A list 端点补 rework 字段 —');
  const list = await reqJson('GET', '/api/corrections', null, ADMIN);
  ok(list.status === 200 && Array.isArray(list.body.items), 'A0 list 200 + items 数组');
  const byId = Object.fromEntries(list.body.items.map(it => [Number(it.id), it]));
  const rootItem = byId[R];
  ok(rootItem && 'rework_parent_id' in rootItem && 'rework_root_id' in rootItem && 'rework_seq' in rootItem && 'rework_child_count' in rootItem,
    'A1 list item 含 4 rework 字段（rework_parent_id/root_id/seq/child_count）');
  ok(rootItem.rework_parent_id == null && Number(rootItem.rework_child_count) === 2,
    'A2 原单 R：rework_parent_id=null + rework_child_count=2（前端 ⟳ 标记数据源）');
  ok(Number(byId[child2].rework_parent_id) === child1 && Number(byId[child2].rework_seq) === 2 && Number(byId[child2].rework_root_id) === R,
    'A3 返工子单 child2：parent=child1 + seq=2 + root=R（前端彩色徽章数据源）');
  ok(byId[N].rework_parent_id == null && (byId[N].rework_child_count == null || Number(byId[N].rework_child_count) === 0),
    'A4 普通单 N：rework_parent_id=null + child_count 空/0（不误标返工）');

  // ── B detail rework_chain 组装（子单侧 + 原单侧）──
  console.log('— B detail rework_chain 组装 —');
  const d2 = await reqJson('GET', `/api/corrections/${child2}`, null, ADMIN);
  ok(d2.status === 200 && Array.isArray(d2.body.rework_chain), 'B0 返工子单详情 200 + rework_chain 数组');
  const ch = d2.body.rework_chain;
  ok(ch.length === 3, 'B1 链长=3（原单 + 2 返工子单，递归扁平不嵌套）');
  ok(Number(ch[0].id) === R && ch[0].is_root === true && ch[0].rework_seq == null,
    'B2 链首=原单 R（is_root=true + 无 rework_seq）');
  ok(Number(ch[1].id) === child1 && Number(ch[1].rework_seq) === 1 && Number(ch[2].id) === child2 && Number(ch[2].rework_seq) === 2,
    'B3 后续按 seq 升序：child1(seq1) → child2(seq2)');
  ok(Array.isArray(ch[0].fix_proofs) && ch[0].fix_proofs.length === 1 && ch[0].fix_proofs[0].original_name === 'root_proof.png',
    'B4 原单 fix_proof 摘要随链返回（上次结果证明只读，含 original_name）');
  ok(ch[1].fix_proofs.length === 1 && ch[1].fix_proofs[0].original_name === 'child1_proof.png' && ch[2].fix_proofs.length === 0,
    'B5 各成员 fix_proof 独立摘要（child1 有 / 进行中 child2 无）');
  ok(ch[0].reopen_reason == null && ch[1].reopen_reason && ch[1].reopen_reason.includes('明细'),
    'B6 reopen_reason：原单无、返工子单有（上次哪里改错）');
  const dR = await reqJson('GET', `/api/corrections/${R}`, null, ADMIN);
  ok(dR.status === 200 && Array.isArray(dR.body.rework_chain) && dR.body.rework_chain.length === 3 && dR.body.rework_chain[0].is_root === true,
    'B7 原单侧详情同样回链（血缘视图，已派生 N 张返工子单）');

  // ── C 普通单 rework_chain=null（防 N+1 路径）──
  console.log('— C 普通单 rework_chain=null —');
  const dN = await reqJson('GET', `/api/corrections/${N}`, null, ADMIN);
  ok(dN.status === 200 && dN.body.rework_chain === null, 'C1 普通单（无 root_id 无 child）rework_chain=null（不走链查询）');

  // ── D M-1 区分数据（后端权威子查询 group_nonrework_count，不受可见性/作废过滤）──
  console.log('— D M-1 区分数据（后端 group_nonrework_count 权威）—');
  ok(Number(byId[R].group_nonrework_count) === 1, 'D1 纯返工组 R：后端 group_nonrework_count=1（前端渲染「原单·组」，不靠 allItems 推断）');
  ok(Number(byId[gM].group_nonrework_count) === 2, 'D2 跨系统组 gM（已派生返工）：group_nonrework_count=2（master+sibling）→ 前端渲染「主单·组」非误标「原单·组」（对抗审 M-1 边缘修复）');
  ok(Number(byId[gRw].rework_seq) === 1 && Number(byId[gRw].correction_group_id) === gM,
    'D3 跨系统组的返工子单 gRw：group_id=gM + seq=1（彩色徽章 + data-group 联动到组）');
  // D4 权威性：作废一张兄弟单（列表 voided_at IS NULL 过滤后它不在 items），子查询查全表 → gM 计数仍=2，不随可见性/作废退化为纯返工组
  await dbRunAsync("UPDATE correction_requests SET voided_at=datetime('now','localtime'), status='VOIDED' WHERE id=?", [gS]);
  const list2 = await reqJson('GET', '/api/corrections', null, ADMIN);
  const byId2 = Object.fromEntries(list2.body.items.map(it => [Number(it.id), it]));
  ok(byId2[gS] === undefined && Number(byId2[gM].group_nonrework_count) === 2,
    'D4 兄弟单 gS 作废后从 items 消失，但 gM.group_nonrework_count 仍=2（子查询查全表，证明 M-1 判定不受列表过滤影响）');
  // D5（末次合并审）审计盲点修复：组主单详情的 group.members 返回 rework_child_count，使关联组区可对有返工成员标 ⟳（消除跨系统主单视角看不到组内返工）
  const dGM = await reqJson('GET', `/api/corrections/${gM}`, null, ADMIN);
  const gmMember = (dGM.body.group && Array.isArray(dGM.body.group.members)) ? dGM.body.group.members.find(m => Number(m.id) === gM) : null;
  ok(dGM.status === 200 && gmMember && Number(gmMember.rework_child_count) === 1,
    'D5 组主单详情 group.members 含 rework_child_count（gM=1）→ 关联组区成员行可标 ⟳ 审计提示（末次合并审 codex MED-1/ultracode seam）');

  // ── E 递归链不漂移（child2 parent=child1 但 chain 仍按 root 拉全）──
  console.log('— E 递归链按 root 拉全 —');
  ok(ch.every(m => m.rework_seq == null || Number(m.rework_root_id) === R), 'E1 链内所有返工子单 rework_root_id 恒=R（不漂移）');
  ok(Number(ch[2].rework_parent_id) === child1, 'E2 child2 血缘父=child1（递归），但仍平铺在 root 链下非嵌套');

  // ── F（codex R3 / H-1）tip 解析数据：原单详情链可定位"最新归档返工子单"，供前端再次返工入口指向 tip 而非 root ──
  console.log('— F tip 解析数据（codex R3 / H-1）—');
  await dbRunAsync("UPDATE correction_requests SET status='ARCHIVED', archived_at=datetime('now','localtime') WHERE id=?", [child2]);   // child2 归档→链全归档无未结
  const dR2 = await reqJson('GET', `/api/corrections/${R}`, null, ADMIN);
  const ch2 = dR2.body.rework_chain || [];
  const archivedKids = ch2.filter(m => m.status === 'ARCHIVED' && m.rework_parent_id != null);
  const tip = archivedKids.reduce((mx, m) => (Number(m.rework_seq) > Number(mx.rework_seq || 0) ? m : mx), { rework_seq: 0 });
  ok(Number(tip.id) === child2 && Number(tip.rework_seq) === 2,
    'F1 原单详情链可定位 tip=最新归档返工子单 child2(seq2)，前端再次返工入口据此 POST 到 tip 而非 root（H-1 修复数据支撑）');
  ok(ch2.some(m => Number(m.id) === child1 && m.status === 'ARCHIVED'),
    'F2 链含中间归档子单 child1（非 tip 历史单仍平铺可见，递归链完整）');
  ok(ch2[0].is_root === true && Number(ch2[0].id) === R,
    'F3 ORDER BY COALESCE 改造后原单仍恒排首（CASE WHEN id=root THEN 0）');

  // ── G（codex 复审 MED-1）最新 seq 子单被作废时，tip 应回退到最近一次【已归档】子单（非作废单），锁定前端 tip 解析语义 ──
  console.log('— G tip 跳过 VOIDED/REJECTED（codex 复审 MED-1）—');
  await dbRunAsync("UPDATE correction_requests SET status='VOIDED', voided_at=datetime('now','localtime') WHERE id=?", [child2]);   // 最新 seq2 子单作废
  const dR3 = await reqJson('GET', `/api/corrections/${R}`, null, ADMIN);
  const ch3 = dR3.body.rework_chain || [];
  const archivedKids3 = ch3.filter(m => m.status === 'ARCHIVED' && m.rework_parent_id != null);
  const tip3 = archivedKids3.reduce((mx, m) => (Number(m.rework_seq) > Number(mx.rework_seq || 0) ? m : mx), { rework_seq: 0 });
  ok(Number(tip3.id) === child1 && Number(tip3.rework_seq) === 1,
    'G1 最新 seq2 子单作废后，tip 回退到最近已归档 child1(seq1)（前端 reopen 落最近完成工作，跳过作废尝试·语义正确）');
  ok(ch3.some(m => Number(m.id) === child2 && m.status === 'VOIDED'),
    'G2 被作废 child2 仍平铺在链里可见（status=VOIDED，链完整不丢历史）');

  console.log(`\n✅ verify-correction-rework-detail 全部通过（${pass} 项）`);
  srv.close(); db.close();
  process.exit(0);
})().catch(e => { console.error('\n❌ 验证失败：', e && (e.stack || e.message)); try { srv && srv.close(); } catch (_) {} process.exit(1); });
