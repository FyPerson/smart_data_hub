// 验证脚本：系统迭代 建单优化批 C3 — 编辑窗口两档扩展（edit_in_revision）
//   （方案 docs/local/系统迭代/系统迭代_建单优化批_方案_20260731_v1.2.md §6）
//   用法：node scripts/verify-sys-edit-window.js
//
// 行为面清单制（对齐 verify-sys-intake-liaison.js 范式）：
//   [①] 六态×两档字段矩阵正例：待受理/待修改/待指派/待处理（A 档覆盖原 10 字段·C3 建批基线）+ 开发中/
//        处理中（B 档覆盖原 9 字段，剔除 needs_feasibility）——每态各建一单，10/9 字段改动，断言 200 +
//        changed 完整 + 落库。⚠️ [S8-S10 合并收口批 F11 如实化] 两档现各已扩至 12/11 字段（S9 方案 §12
//        新增 source/related_correction_no）——本组仍只测原有 10/9 字段（C3 建批时代基线，未随 S9 扩容
//        改动覆盖面），新两字段的正负例单独在 [⑦] 组覆盖，非本组遗漏。
//   [②] 两档负例：A 档纯未知字段 400 EDIT_FIELD_NOT_ALLOWED；B 档传 needs_feasibility 400
//        EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B（两态各一次）；B 档纯未知字段仍是通用 400（不被
//        needs_feasibility 分支误吞）
//   [③] 待验证起 409：待验证/待上线/已上线/已关闭/已暂缓/已拒绝/已作废（含所有后续态与终态）
//   [④] 终闸谓词负控制（codex C3 审 0ed6fb8 M-2 收口·措辞不再声称"模拟并发"）：本模块 BEGIN IMMEDIATE
//        单写者模型下，跨连接在事务持有期提交现实不可达（会阻塞在 SQLITE_BUSY，不会像"先改后写"那样悄悄
//        插进两条语句之间）——本用例不模拟真实跨连接锁竞争，而是用同连接钩子在 handler 读到「待指派」
//        （A 档）之后、最终 UPDATE 之前，直接改写 DB 侧 status 到「开发中」（B 档），验证**终闸谓词本身
//        是否真的在起作用**（负控制思路：若终闸被弱化/漏挂，本用例会从 409 变成 200 误写——已在实现阶段
//        临时弱化 WHERE 验证过这一点，见 codex 审归档）。断言最终 UPDATE 的 WHERE status IN(该档) 命中
//        失败 → 409 CONCURRENT_EDIT，且零副作用（字段未写、无新 timeline 行）。
//   [⑤] 评估在先标注：当前轮已有技术负责人评估意见 → summary 追加标注；无活动轮 → 不追加；
//        +2 负例（codex C3 审 L-2）：锚点前的旧意见不算「当前轮」/ 锚点后非 tech_lead_comment 的行不算
//   [⑥] 冒烟：404 不存在单 / 403 非建单人非 admin
//   [⑦] 方案 §12 新增字段（source/related_correction_no 纳入两档）：A/B 档正例落库 + 三类负例
//        （source 非法枚举 400 INVALID_SOURCE / related_correction_no 类型非法 400 INVALID_EDIT_FIELD_TYPE /
//        related_correction_no 超 100 字 400 RELATED_CORRECTION_NO_TOO_LONG）
//   [⑧] 方案 §12「同源守卫」：建单集 = 可编辑集 ∪ 排除集（互斥覆盖）+ 排除清单逐项非空理由；
//        含四类偏差（缺口/多余/交集矛盾/空理由）的红灯验证（[[feedback_probe_test_bidirectional_proof]]
//        双向证明：既证真实常量当前自洽，也证 checkCompleteness 本身真的能抓到偏差，不是空转的绿灯）
//   [⑨] 【S8-S10 合并收口批 F4】建单端点 b.<key> 全集整仓源码扫描对拍（范式=verify-sys-intake-gate.js
//        [I] 组整仓正则计数）：POST /sys-issues 端点体内全部 `b.<key>` 消费点 ⊆ SYS_CREATE_FORM_FIELDS ∪
//        SYS_CREATE_PROTOCOL_REJECTED_FIELDS（六项协议/结构性拒绝字段，逐项校验非空理由）；反向红灯
//        证明扫描器真的会抓到新增未登记字段。
//   [⑩] 【S8-S10 合并收口批 F5】source 三值枚举 DDL CHECK 文本 ⟺ SYS_SOURCES 常量集合相等——DDL CHECK
//        是静态 SQL 字面量，无法引用 JS 常量，两处漂移只能靠 verify 兜底（非纯人工自律）。
//
// 断言纪律：钉确切 HTTP 码 + code；[④] 负控制断言零副作用（字段值 + timeline 行数均对比变更前）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-edit-window-secret';
const db = new sqlite3.Database(':memory:');
const rawRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const rawGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// ── [④] 终闸谓词负控制注入钩子（非跨连接并发模拟，见上方 [④] 说明）：仅拦截 edit-in-revision 的行
//   读取语句（用 SELECT 列表里的唯一片段识别，见 index.js「needs_feasibility, requester_dept,
//   requester_name, requester_phone」），命中且 armedRace 已装填、id 匹配时：先按真实值返回给 handler
//   （handler 拿到的是"读到时"的旧状态快照），随后**立即**在同一连接上把 status 改写为注入目标值——
//   一次性触发。目的是制造"handler 内存里的 row 快照"与"DB 实际当前值"之间的落差，从而观测最终 UPDATE
//   的 WHERE 子句是否真的按 DB 现值把关（而不是信任 handler 早前读到的快照）。
let armedRace = null;   // { id, mutateToStatus } | null
const EDIT_ROW_SQL_MARKER = 'needs_feasibility, requester_dept, requester_name, requester_phone';
async function get(sql, params = []) {
  const row = await rawGet(sql, params);
  if (armedRace && sql.includes(EDIT_ROW_SQL_MARKER) && row && Number(params[0]) === armedRace.id) {
    const { mutateToStatus } = armedRace;
    armedRace = null;   // 一次性
    await rawRun(`UPDATE sys_issues SET status=? WHERE id=?`, [mutateToStatus, row.id]);
  }
  return row;
}
const run = rawRun;

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
const creatorTok = jwt.sign({ id: 20, username: 'creator', display_name: '建单人小李', role: 'user' }, SECRET);
const otherTok = jwt.sign({ id: 21, username: 'other', display_name: '路人甲', role: 'user' }, SECRET);
const CREATOR_ID = 20, CREATOR_NAME = '建单人小李';

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const issueRow = (id) => rawGet('SELECT * FROM sys_issues WHERE id=?', [id]);
const timelineRows = (id, actionCode) => all('SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code=? ORDER BY id', [id, actionCode]);

// 直连 SQL 造任意状态的测试单（跳过完整流转链路，只关心 edit-in-revision 自身的档位/字段/守卫逻辑）。
async function mkIssue(status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, description, system_name, source, created_by, created_by_name, needs_feasibility, tech_lead_notify_request_event_id)
     VALUES (?, ?, ?, ?, 'BMS', '内部', ?, ?, ?, ?)`,
    [extra.type || 'feature', status, extra.title || `测试单-${status}-${Math.random().toString(36).slice(2, 6)}`,
     extra.description || '测试描述', extra.created_by != null ? extra.created_by : CREATOR_ID,
     extra.created_by_name || CREATOR_NAME, extra.needs_feasibility || 0,
     extra.tech_lead_notify_request_event_id != null ? extra.tech_lead_notify_request_event_id : null]
  );
  return r.lastID;
}
// 造一条任意 timeline 行，返回其 id（供"当前轮请求事件锚点"造数用）。
async function mkTimelineRow(issueId, actionCode) {
  const r = await run(
    `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
     VALUES (?, 'note', ?, ?, 1, '管理员')`,
    [issueId, `测试锚点(${actionCode})`, actionCode]);
  return r.lastID;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 建单人小李20 / 路人甲21）');

  // ═══ [①] 六态×两档字段矩阵正例：A 档 4 态原 10 字段 / B 档 2 态原 9 字段（剔除 needs_feasibility）——
  //   两档现各已扩至 12/11（S9 新增 source/related_correction_no，本组不覆盖，见 [⑦]），本组维持原口径 ═══
  {
    // A 档 · 待受理（feature）：10 字段全改（含 needs_feasibility=1）
    const id1 = await mkIssue('待受理', { type: 'feature' });
    const r1 = await call('POST', `/api/sys-issues/${id1}/edit-in-revision`, creatorTok, {
      title: '新标题-待受理', description: '新描述', system_name: 'HRD', module_name: '新模块',
      priority: 'P1', deadline: '2026-12-31', needs_feasibility: 1,
      requester_dept: '新部门', requester_name: '新姓名', requester_phone: '13800000001',
    });
    assert.strictEqual(r1.status, 200, `[①待受理] 期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.changed.length, 10, `[①待受理] 10 字段全改，实际 changed=${JSON.stringify(r1.body.changed)}`);
    const row1 = await issueRow(id1);
    assert.strictEqual(row1.title, '新标题-待受理', '[①待受理] title 落库');
    assert.strictEqual(row1.needs_feasibility, 1, '[①待受理] needs_feasibility 落库=1');

    // A 档 · 待修改（bug）：10 字段全改（needs_feasibility=0，bug 类型不适用可行性评估）
    const id2 = await mkIssue('待修改', { type: 'bug' });
    const r2 = await call('POST', `/api/sys-issues/${id2}/edit-in-revision`, adminTok, {
      title: '新标题-待修改', description: '新描述2', system_name: '电子签', module_name: '模块2',
      priority: 'P0', deadline: '2026-11-30', needs_feasibility: 0,
      requester_dept: '部门2', requester_name: '姓名2', requester_phone: '13800000002',
    });
    assert.strictEqual(r2.status, 200, `[①待修改] 期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.ok(r2.body.changed.length >= 9, `[①待修改] 至少 9 字段改动（needs_feasibility 0→0 幂等不入 changed），实际=${JSON.stringify(r2.body.changed)}`);
    const row2 = await issueRow(id2);
    assert.strictEqual(row2.priority, 'P0', '[①待修改] priority 落库');

    // A 档 · 待指派（feature）：10 字段全改
    const id3 = await mkIssue('待指派', { type: 'feature' });
    const r3 = await call('POST', `/api/sys-issues/${id3}/edit-in-revision`, creatorTok, {
      title: '新标题-待指派', description: '新描述3', system_name: '其他', module_name: '模块3',
      priority: 'P2', deadline: '2026-10-31', needs_feasibility: 1,
      requester_dept: '部门3', requester_name: '姓名3', requester_phone: '13800000003',
    });
    assert.strictEqual(r3.status, 200, `[①待指派] 期望 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual((await issueRow(id3)).needs_feasibility, 1, '[①待指派] needs_feasibility 落库=1');

    // A 档 · 待处理（bug）：10 字段全改
    const id4 = await mkIssue('待处理', { type: 'bug' });
    const r4 = await call('POST', `/api/sys-issues/${id4}/edit-in-revision`, creatorTok, {
      title: '新标题-待处理', description: '新描述4', system_name: 'BMS', module_name: '模块4',
      priority: 'P3', deadline: '2026-09-30', needs_feasibility: 0,
      requester_dept: '部门4', requester_name: '姓名4', requester_phone: '13800000004',
    });
    assert.strictEqual(r4.status, 200, `[①待处理] 期望 200, got ${r4.status} ${JSON.stringify(r4.body)}`);

    ok('[①] A 档四态（待受理/待修改/待指派/待处理）：原 10 字段正例（A 档现共 12 字段，另 2 个新字段见 [⑦]），200 + 落库正确');

    // B 档 · 开发中（feature）：9 字段（不传 needs_feasibility）
    const id5 = await mkIssue('开发中', { type: 'feature', needs_feasibility: 1 });
    const r5 = await call('POST', `/api/sys-issues/${id5}/edit-in-revision`, creatorTok, {
      title: '新标题-开发中', description: '新描述5', system_name: 'HRD', module_name: '模块5',
      priority: 'P1', deadline: '2026-08-31',
      requester_dept: '部门5', requester_name: '姓名5', requester_phone: '13800000005',
    });
    assert.strictEqual(r5.status, 200, `[①开发中] 期望 200, got ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.changed.length, 9, `[①开发中] 恰 9 字段（无 needs_feasibility），实际=${JSON.stringify(r5.body.changed)}`);
    assert.ok(!r5.body.changed.includes('needs_feasibility'), '[①开发中] changed 不含 needs_feasibility');
    const row5 = await issueRow(id5);
    assert.strictEqual(row5.needs_feasibility, 1, '[①开发中] needs_feasibility 原值不变（未传不动）');

    // B 档 · 处理中（bug）：9 字段
    const id6 = await mkIssue('处理中', { type: 'bug' });
    const r6 = await call('POST', `/api/sys-issues/${id6}/edit-in-revision`, adminTok, {
      title: '新标题-处理中', description: '新描述6', system_name: '电子签', module_name: '模块6',
      priority: 'P0', deadline: '2026-07-31',
      requester_dept: '部门6', requester_name: '姓名6', requester_phone: '13800000006',
    });
    assert.strictEqual(r6.status, 200, `[①处理中] 期望 200, got ${r6.status} ${JSON.stringify(r6.body)}`);
    assert.strictEqual(r6.body.changed.length, 9, `[①处理中] 恰 9 字段，实际=${JSON.stringify(r6.body.changed)}`);

    ok('[①] B 档两态（开发中/处理中）：原 9 字段正例（不含 needs_feasibility；B 档现共 11 字段，另 2 个新字段见 [⑦]），200 + 落库正确 + 原值保留');
  }

  // ═══ [②] 两档负例：A 档未知字段 400 / B 档 needs_feasibility 400（明示原因）/ B 档未知字段仍通用 400 ═══
  {
    // A 档：纯未知字段（'assigned_to' 不在任一档白名单）
    const idA = await mkIssue('待受理', { type: 'feature' });
    const beforeA = await issueRow(idA);
    const rA = await call('POST', `/api/sys-issues/${idA}/edit-in-revision`, creatorTok, { assigned_to: 5 });
    assert.strictEqual(rA.status, 400, `[②A档未知字段] 期望 400, got ${rA.status}`);
    assert.strictEqual(rA.body.code, 'EDIT_FIELD_NOT_ALLOWED', '[②A档未知字段] 确切码 EDIT_FIELD_NOT_ALLOWED');
    assert.strictEqual((await issueRow(idA)).title, beforeA.title, '[②A档未知字段] 零副作用：title 未被改写');

    // B 档 · 开发中（feature）：传 needs_feasibility → 400 EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B
    const idB1 = await mkIssue('开发中', { type: 'feature' });
    const rB1 = await call('POST', `/api/sys-issues/${idB1}/edit-in-revision`, creatorTok, { needs_feasibility: 1 });
    assert.strictEqual(rB1.status, 400, `[②B档开发中 needs_feasibility] 期望 400, got ${rB1.status} ${JSON.stringify(rB1.body)}`);
    assert.strictEqual(rB1.body.code, 'EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B', '[②B档开发中] 确切码 EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B');
    assert.ok(/开发期不得|开发期变更|不可修改/.test(rB1.body.error), `[②B档开发中] 错误信息须明示原因，实际="${rB1.body.error}"`);

    // B 档 · 处理中（bug）：同上
    const idB2 = await mkIssue('处理中', { type: 'bug' });
    const rB2 = await call('POST', `/api/sys-issues/${idB2}/edit-in-revision`, adminTok, { needs_feasibility: 0 });
    assert.strictEqual(rB2.status, 400, `[②B档处理中 needs_feasibility] 期望 400, got ${rB2.status}`);
    assert.strictEqual(rB2.body.code, 'EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B', '[②B档处理中] 确切码同上（即便传 0 仍拒——字段名不在白名单，非值判断）');

    // B 档：纯未知字段（不含 needs_feasibility）→ 仍是通用 400，不被 needs_feasibility 分支误吞
    const idB3 = await mkIssue('开发中', { type: 'feature' });
    const rB3 = await call('POST', `/api/sys-issues/${idB3}/edit-in-revision`, creatorTok, { assigned_to: 5 });
    assert.strictEqual(rB3.status, 400, `[②B档未知字段] 期望 400, got ${rB3.status}`);
    assert.strictEqual(rB3.body.code, 'EDIT_FIELD_NOT_ALLOWED', '[②B档未知字段] 确切码 EDIT_FIELD_NOT_ALLOWED（非 needs_feasibility 专属码）');

    // codex C3 审 L-1 负例：B 档 needs_feasibility 与另一未知字段（status）混传 → 不走专属码
    //   （专属码仅当 extra 恰好只含 needs_feasibility 一项才返回，混传时统一通用码，文案列出全部 extra）。
    const idB4 = await mkIssue('开发中', { type: 'feature' });
    const rB4 = await call('POST', `/api/sys-issues/${idB4}/edit-in-revision`, creatorTok, { needs_feasibility: 1, status: '待验证' });
    assert.strictEqual(rB4.status, 400, `[②B档混传] 期望 400, got ${rB4.status} ${JSON.stringify(rB4.body)}`);
    assert.strictEqual(rB4.body.code, 'EDIT_FIELD_NOT_ALLOWED', '[②B档混传] 确切码通用 EDIT_FIELD_NOT_ALLOWED（非 EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B）');
    assert.ok(rB4.body.error.includes('needs_feasibility') && rB4.body.error.includes('status'),
      `[②B档混传] 文案须列出全部 extra（含 needs_feasibility 与 status），实际="${rB4.body.error}"`);

    ok('[②] 两档负例：A 档未知字段 400 EDIT_FIELD_NOT_ALLOWED / B 档 needs_feasibility 400 EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B（明示原因，含 0 值同拒）/ B 档其余未知字段仍走通用码 / B 档 needs_feasibility 与其他未知字段混传时不被专属码吞掉（通用码+全量文案）');
  }

  // ═══ [③] 待验证起 409（含所有后续态与终态）═══
  {
    const frozenChangeFlow = ['待验证', '待上线', '已上线', '已关闭', '已暂缓', '已拒绝', '已作废'];
    for (const st of frozenChangeFlow) {
      const id = await mkIssue(st, { type: 'feature' });
      const r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, creatorTok, { title: '试图修改' });
      assert.strictEqual(r.status, 409, `[③${st}] 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'EDIT_STATUS_INVALID', `[③${st}] 确切码 EDIT_STATUS_INVALID`);
      assert.strictEqual((await issueRow(id)).title.includes('试图修改'), false, `[③${st}] 零副作用：title 未被改写`);
    }
    // bug 流两态代表性覆盖（逻辑与 type 无关，抽样即可，不需全枚举）
    for (const st of ['待验证', '已关闭']) {
      const id = await mkIssue(st, { type: 'bug' });
      const r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, adminTok, { title: '试图修改' });
      assert.strictEqual(r.status, 409, `[③bug-${st}] 期望 409, got ${r.status}`);
      assert.strictEqual(r.body.code, 'EDIT_STATUS_INVALID', `[③bug-${st}] 确切码 EDIT_STATUS_INVALID`);
    }
    ok('[③] 待验证起（含终态：待验证/待上线/已上线/已关闭/已暂缓/已拒绝/已作废 + bug 流待验证/已关闭抽样）：409 EDIT_STATUS_INVALID + 零副作用');
  }

  // ═══ [④] 终闸谓词负控制：读到 A 档「待指派」后、最终 UPDATE 前 DB 侧被改到「开发中」═══
  //   ⚠️ codex C3 审 0ed6fb8 M-2 收口：本用例**不声称模拟真实跨连接并发**——BEGIN IMMEDIATE 单写者模型下，
  //   另一连接若在本事务持有期尝试提交同一行，只会阻塞在 SQLITE_BUSY，不可能像下方注入那样"悄悄插进
  //   读与写之间"。这里用同连接钩子人为制造"handler 内存快照"与"DB 现值"的落差，只为验证**终闸谓词
  //   本身有没有在起作用**（负控制：实现阶段临时把 WHERE 弱化为仅 `id=?` 重跑过本用例，确认会从 409
  //   变回 200 误写，证明断言有效——细节见 codex 审归档）。
  //   注入技术：钩子在 handler 的行读取语句返回前，通过同一连接对该行执行 UPDATE status。由于该注入
  //   语句与 handler 自身的 BEGIN IMMEDIATE 共享同一连接/同一事务，一旦 handler 的最终 UPDATE 因
  //   WHERE status IN(该档) 不命中而回滚，注入的状态改写也随之整体回滚——**不存在"部分生效"的中间态**，
  //   注入前的 status 值必须被完整恢复，编辑字段必须一个都没有落地，才算真正验证了终闸谓词。
  {
    const id = await mkIssue('待指派', { type: 'feature', needs_feasibility: 0 });
    const before = await issueRow(id);
    const timelineBefore = (await timelineRows(id, 'edit_in_revision')).length;
    armedRace = { id, mutateToStatus: '开发中' };   // 一次性：本请求的行读取一命中即触发注入
    const r = await call('POST', `/api/sys-issues/${id}/edit-in-revision`, creatorTok, {
      title: '并发窗口试图修改', needs_feasibility: 1,   // A 档合法字段（若真落地会成功写入）
    });
    assert.strictEqual(armedRace, null, '[④] 注入钩子已触发（一次性消费）');
    assert.strictEqual(r.status, 409, `[④] 期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'CONCURRENT_EDIT', '[④] 确切码 CONCURRENT_EDIT');
    const after = await issueRow(id);
    // 注入的 UPDATE 与 handler 自身写操作同处一个事务：handler 判定 WHERE 未命中 → sysRollback() 整体回滚，
    // 注入的 status 改写随之撤销——status 应恢复为读取前的原值（并非停留在注入值"开发中"）。
    assert.strictEqual(after.status, before.status, '[④] 整体回滚：status 恢复为读取前原值（注入的外部改写未能"部分生效"）');
    assert.strictEqual(after.title, before.title, '[④] 零副作用：title 未被写入（WHERE status IN(A档) 未命中注入后的真实状态·changes=0）');
    assert.strictEqual(after.needs_feasibility, before.needs_feasibility, '[④] 零副作用：needs_feasibility 未被写入');
    const timelineAfter = (await timelineRows(id, 'edit_in_revision')).length;
    assert.strictEqual(timelineAfter, timelineBefore, '[④] 零留痕：无新增 edit_in_revision timeline 行');
    ok('[④] 终闸谓词负控制：A 档读入后 DB 侧被注入改到 B 档（同连接钩子·非跨连接并发模拟），最终 UPDATE 的 WHERE status IN(该档) 未命中 → 409 CONCURRENT_EDIT + 整体原子回滚（字段零写入 + timeline 零新增 + 注入改写本身也被撤销）');
  }

  // ═══ [⑤] 评估在先标注：当前轮已有意见 → summary 追加；无活动轮 → 不追加 ═══
  {
    // 出现：先建单（NULL 活动轮）→ 造锚点 timeline → 回写 tech_lead_notify_request_event_id → 造"当前轮"回复
    const idYes = await mkIssue('待受理', { type: 'feature' });
    const eventId = await mkTimelineRow(idYes, 'request_tech_consult');
    await run(`UPDATE sys_issues SET tech_lead_notify_request_event_id=? WHERE id=?`, [eventId, idYes]);
    await mkTimelineRow(idYes, 'tech_lead_comment');   // id > eventId，"当前轮已回复"
    const rYes = await call('POST', `/api/sys-issues/${idYes}/edit-in-revision`, creatorTok, { title: '有评估意见后编辑' });
    assert.strictEqual(rYes.status, 200, `[⑤出现] 期望 200, got ${rYes.status} ${JSON.stringify(rYes.body)}`);
    const noteYes = (await timelineRows(idYes, 'edit_in_revision'))[0];
    assert.ok(noteYes && noteYes.summary.includes('（当前轮已有评估意见，评估在先）'), `[⑤出现] summary 须含标注，实际="${noteYes && noteYes.summary}"`);

    // 不出现：无活动轮（tech_lead_notify_request_event_id 恒 NULL）
    const idNo = await mkIssue('待受理', { type: 'feature' });
    const rNo = await call('POST', `/api/sys-issues/${idNo}/edit-in-revision`, creatorTok, { title: '无评估意见编辑' });
    assert.strictEqual(rNo.status, 200, `[⑤不出现] 期望 200, got ${rNo.status}`);
    const noteNo = (await timelineRows(idNo, 'edit_in_revision'))[0];
    assert.ok(noteNo && !noteNo.summary.includes('评估在先'), `[⑤不出现] summary 不应含标注，实际="${noteNo && noteNo.summary}"`);

    // codex C3 审 L-2 负例①：意见先于锚点存在（旧轮遗留）——判定口径要求 timeline.id > 锚点 event_id，
    //   锚点前的旧意见不算"当前轮已回复"。
    const idBeforeAnchor = await mkIssue('待受理', { type: 'feature' });
    await mkTimelineRow(idBeforeAnchor, 'tech_lead_comment');   // 先插一条旧意见（此时尚无锚点）
    const laterEventId = await mkTimelineRow(idBeforeAnchor, 'request_tech_consult');   // 再插锚点，id 更大
    await run(`UPDATE sys_issues SET tech_lead_notify_request_event_id=? WHERE id=?`, [laterEventId, idBeforeAnchor]);
    const rBeforeAnchor = await call('POST', `/api/sys-issues/${idBeforeAnchor}/edit-in-revision`, creatorTok, { title: '锚点前旧意见不算-编辑' });
    assert.strictEqual(rBeforeAnchor.status, 200, `[⑤负例①] 期望 200, got ${rBeforeAnchor.status}`);
    const noteBeforeAnchor = (await timelineRows(idBeforeAnchor, 'edit_in_revision'))[0];
    assert.ok(noteBeforeAnchor && !noteBeforeAnchor.summary.includes('评估在先'),
      `[⑤负例①] 意见先于锚点存在（旧轮遗留）不应标注，实际="${noteBeforeAnchor && noteBeforeAnchor.summary}"`);

    // codex C3 审 L-2 负例②：锚点后只有非 tech_lead_comment 的行——action_code 过滤必须生效，
    //   不能只按"id > 锚点"判定（否则任意锚点后行都会被误判为"已回复"）。
    const idWrongAction = await mkIssue('待受理', { type: 'feature' });
    const anchorEventId = await mkTimelineRow(idWrongAction, 'request_tech_consult');
    await run(`UPDATE sys_issues SET tech_lead_notify_request_event_id=? WHERE id=?`, [anchorEventId, idWrongAction]);
    await mkTimelineRow(idWrongAction, 'other_action');   // 锚点后插入一条非 tech_lead_comment 的行
    const rWrongAction = await call('POST', `/api/sys-issues/${idWrongAction}/edit-in-revision`, creatorTok, { title: '锚点后非评估意见行不算-编辑' });
    assert.strictEqual(rWrongAction.status, 200, `[⑤负例②] 期望 200, got ${rWrongAction.status}`);
    const noteWrongAction = (await timelineRows(idWrongAction, 'edit_in_revision'))[0];
    assert.ok(noteWrongAction && !noteWrongAction.summary.includes('评估在先'),
      `[⑤负例②] 锚点后非 tech_lead_comment 的行不应被误判为已回复，实际="${noteWrongAction && noteWrongAction.summary}"`);

    ok('[⑤] 评估在先标注：当前轮已有意见（活动轮+轮内回复）→ summary 追加"（当前轮已有评估意见，评估在先）"；无活动轮 → 不追加；+2 负例（锚点前旧意见不算 / 锚点后非评估意见行不算）');
  }

  // ═══ [⑥] 冒烟：404 不存在单 / 403 非建单人非 admin ═══
  {
    const r404 = await call('POST', `/api/sys-issues/999999/edit-in-revision`, adminTok, { title: 'x' });
    assert.strictEqual(r404.status, 404, `[⑥404] 期望 404, got ${r404.status}`);
    assert.strictEqual(r404.body.code, 'SYS_ISSUE_NOT_FOUND', '[⑥404] 确切码 SYS_ISSUE_NOT_FOUND');

    const idPerm = await mkIssue('待受理', { type: 'feature' });
    const r403 = await call('POST', `/api/sys-issues/${idPerm}/edit-in-revision`, otherTok, { title: 'x' });
    assert.strictEqual(r403.status, 403, `[⑥403] 期望 403, got ${r403.status}`);
    assert.strictEqual(r403.body.code, 'NOT_AUTHORIZED_FOR_EDIT', '[⑥403] 确切码 NOT_AUTHORIZED_FOR_EDIT');

    ok('[⑥] 冒烟：不存在单 404 SYS_ISSUE_NOT_FOUND / 非建单人非 admin 403 NOT_AUTHORIZED_FOR_EDIT');
  }

  // ═══ [⑦] 方案 §12 新增字段：source / related_correction_no 纳入两档 ═══
  {
    // A 档正例（待受理）：source + related_correction_no 同批写入
    const idA = await mkIssue('待受理', { type: 'feature' });
    const rA = await call('POST', `/api/sys-issues/${idA}/edit-in-revision`, creatorTok, {
      source: '业务方', related_correction_no: 'FIX-2026-0001',
    });
    assert.strictEqual(rA.status, 200, `[⑦A档正例] 期望 200, got ${rA.status} ${JSON.stringify(rA.body)}`);
    assert.deepStrictEqual(rA.body.changed.sort(), ['related_correction_no', 'source'], `[⑦A档正例] changed 恰含两新字段，实际=${JSON.stringify(rA.body.changed)}`);
    const rowA = await issueRow(idA);
    assert.strictEqual(rowA.source, '业务方', '[⑦A档正例] source 落库');
    assert.strictEqual(rowA.related_correction_no, 'FIX-2026-0001', '[⑦A档正例] related_correction_no 落库');

    // B 档正例（开发中）：两字段同在 B 档白名单（非 needs_feasibility 那种 A-only 字段）
    const idB = await mkIssue('开发中', { type: 'feature' });
    const rB = await call('POST', `/api/sys-issues/${idB}/edit-in-revision`, creatorTok, {
      source: '生产故障', related_correction_no: null,
    });
    assert.strictEqual(rB.status, 200, `[⑦B档正例] 期望 200, got ${rB.status} ${JSON.stringify(rB.body)}`);
    assert.strictEqual((await issueRow(idB)).source, '生产故障', '[⑦B档正例] source 落库（B 档同样可编）');

    // related_correction_no：空串归一为 null（幂等比较对齐建单口径，"" 与 null 视为同值 → 幂等零写入分支）
    const idNorm = await mkIssue('待受理', { type: 'feature', related_correction_no: null });
    const rNorm = await call('POST', `/api/sys-issues/${idNorm}/edit-in-revision`, creatorTok, { related_correction_no: '' });
    assert.strictEqual(rNorm.status, 200, `[⑦空串归一] 期望 200, got ${rNorm.status}`);
    assert.strictEqual(rNorm.body.unchanged, true, `[⑦空串归一] ""→null 幂等，须走 {unchanged:true} 分支（无 changed 字段），实际=${JSON.stringify(rNorm.body)}`);

    ok('[⑦] 新字段正例：A/B 两档 source+related_correction_no 同批落库 + related_correction_no 空串/null 幂等归一');

    // 负例①：source 非法枚举
    const idNegSrc = await mkIssue('待受理', { type: 'feature' });
    const beforeNegSrc = await issueRow(idNegSrc);
    const rNegSrc = await call('POST', `/api/sys-issues/${idNegSrc}/edit-in-revision`, creatorTok, { source: '不存在的来源' });
    assert.strictEqual(rNegSrc.status, 400, `[⑦负例source] 期望 400, got ${rNegSrc.status} ${JSON.stringify(rNegSrc.body)}`);
    assert.strictEqual(rNegSrc.body.code, 'INVALID_SOURCE', '[⑦负例source] 确切码 INVALID_SOURCE');
    assert.strictEqual((await issueRow(idNegSrc)).source, beforeNegSrc.source, '[⑦负例source] 零副作用：source 未被改写');

    // 负例②：related_correction_no 类型非法（传数字而非字符串/null）
    const idNegType = await mkIssue('待受理', { type: 'feature' });
    const rNegType = await call('POST', `/api/sys-issues/${idNegType}/edit-in-revision`, creatorTok, { related_correction_no: 12345 });
    assert.strictEqual(rNegType.status, 400, `[⑦负例type] 期望 400, got ${rNegType.status} ${JSON.stringify(rNegType.body)}`);
    assert.strictEqual(rNegType.body.code, 'INVALID_EDIT_FIELD_TYPE', '[⑦负例type] 确切码 INVALID_EDIT_FIELD_TYPE');

    // 负例③：related_correction_no 超 100 字
    const idNegLen = await mkIssue('待受理', { type: 'feature' });
    const rNegLen = await call('POST', `/api/sys-issues/${idNegLen}/edit-in-revision`, creatorTok, { related_correction_no: 'X'.repeat(101) });
    assert.strictEqual(rNegLen.status, 400, `[⑦负例超长] 期望 400, got ${rNegLen.status} ${JSON.stringify(rNegLen.body)}`);
    assert.strictEqual(rNegLen.body.code, 'RELATED_CORRECTION_NO_TOO_LONG', '[⑦负例超长] 确切码 RELATED_CORRECTION_NO_TOO_LONG');

    ok('[⑦] 新字段负例：source 非法枚举 400 INVALID_SOURCE / related_correction_no 类型非法 400 INVALID_EDIT_FIELD_TYPE / 超 100 字 400 RELATED_CORRECTION_NO_TOO_LONG（均零副作用）');
  }

  // ═══ [⑧] 方案 §12「同源守卫」：建单集 = 可编辑集 ∪ 排除集（互斥覆盖）+ 排除清单逐项非空理由 ═══
  //   checkCompleteness 是独立纯函数（不依赖模块内部状态），既拿真实常量跑一次证明"当前自洽"，也拿
  //   人为构造的偏差输入跑一次证明"断言真的会抓"——双向证明，避免"函数写对了但从没见过它报错长什么样"。
  {
    function checkCompleteness(createFields, tierAFields, excludedMap) {
      const createSet = new Set(createFields);
      const editSet = new Set(tierAFields);
      const excludedKeys = Object.keys(excludedMap);
      const excludedSet = new Set(excludedKeys);
      const unionSet = new Set([...editSet, ...excludedSet]);
      const missingFromUnion = [...createSet].filter(f => !unionSet.has(f));
      const extraInUnion = [...unionSet].filter(f => !createSet.has(f));
      const overlap = tierAFields.filter(f => excludedSet.has(f));
      const emptyReasons = excludedKeys.filter(k => !excludedMap[k] || typeof excludedMap[k] !== 'string' || !excludedMap[k].trim());
      return { missingFromUnion, extraInUnion, overlap, emptyReasons };
    }

    // 真实断言：当前生产常量必须自洽
    const real = checkCompleteness(I.SYS_CREATE_FORM_FIELDS, I.EDIT_TIER_A_FIELDS, I.SYS_EDIT_EXCLUDED_FIELDS);
    assert.deepStrictEqual(real.missingFromUnion, [], `[⑧] 建单集含未被编辑集/排除集覆盖的字段：${JSON.stringify(real.missingFromUnion)}`);
    assert.deepStrictEqual(real.extraInUnion, [], `[⑧] 编辑集∪排除集含建单集之外的多余字段：${JSON.stringify(real.extraInUnion)}`);
    assert.deepStrictEqual(real.overlap, [], `[⑧] 可编辑集与排除集出现矛盾交集：${JSON.stringify(real.overlap)}`);
    assert.deepStrictEqual(real.emptyReasons, [], `[⑧] 排除清单存在空理由：${JSON.stringify(real.emptyReasons)}`);
    ok('[⑧] 同源守卫（真实常量）：建单集 = 可编辑集 ∪ 排除集（互斥覆盖）+ 排除清单逐项非空理由');

    // 红灯验证：四类偏差均须被 checkCompleteness 正确捕获（人为构造，不落地到生产常量）
    const brokenMissing = checkCompleteness([...I.SYS_CREATE_FORM_FIELDS, 'fake_new_field'], I.EDIT_TIER_A_FIELDS, I.SYS_EDIT_EXCLUDED_FIELDS);
    assert.deepStrictEqual(brokenMissing.missingFromUnion, ['fake_new_field'], '[⑧红灯] 建单集新增字段未入编辑/排除集 → 断言捕获缺口');

    const brokenExtra = checkCompleteness(I.SYS_CREATE_FORM_FIELDS.filter(f => f !== 'title'), I.EDIT_TIER_A_FIELDS, I.SYS_EDIT_EXCLUDED_FIELDS);
    assert.ok(brokenExtra.extraInUnion.includes('title'), `[⑧红灯] 建单集缺字段而并集仍有 → 断言捕获多余，实际=${JSON.stringify(brokenExtra.extraInUnion)}`);

    const brokenOverlap = checkCompleteness(I.SYS_CREATE_FORM_FIELDS, [...I.EDIT_TIER_A_FIELDS, 'type'], I.SYS_EDIT_EXCLUDED_FIELDS);
    assert.ok(brokenOverlap.overlap.includes('type'), `[⑧红灯] 可编辑集与排除集出现交集 → 断言捕获矛盾归类，实际=${JSON.stringify(brokenOverlap.overlap)}`);

    const brokenReason = checkCompleteness(I.SYS_CREATE_FORM_FIELDS, I.EDIT_TIER_A_FIELDS, { ...I.SYS_EDIT_EXCLUDED_FIELDS, type: '' });
    assert.ok(brokenReason.emptyReasons.includes('type'), `[⑧红灯] 排除项空理由 → 断言捕获，实际=${JSON.stringify(brokenReason.emptyReasons)}`);

    ok('[⑧] 红灯验证：四类偏差（缺口/多余/交集矛盾/空理由）均被 checkCompleteness 正确捕获（双向证明，非空转绿灯）');
  }

  // ═══ [⑨] 【S8-S10 合并收口批 F4】建单端点 b.<key> 全集整仓源码扫描对拍 ═══
  //   范式=verify-sys-intake-gate.js [I] 组"整仓正则计数"——本组只需精确定位单个端点体，直接用两个
  //   `router.post` 注册行做边界切片（该文件同款端点体切片手法已见于 verify-sys-timeline-label-coverage.js
  //   的 locateRealInsertSites 等，非本文件独创）。⚠️ 剥注释后再扫（F1 红灯自证时踩过的坑：注释里提到
  //   的代码片段会被朴素正则误当真实调用——同一教训在本组同样适用，`b.<key>` 若出现在解释性注释里
  //   （如"仅在 assign_mode=A 时可传 b.assigned_to"这类措辞）会被误抓）。
  {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const startMarker = "router.post('/sys-issues', authenticateToken, requireSysSchemaReady, requireAdmin";
    const startIdx = indexSrc.indexOf(startMarker);
    assert.ok(startIdx > 0, '[⑨] 建单端点起点标记应存在（POST /sys-issues 注册行）——若断言失败说明端点签名已变，需同步更新本文件的 startMarker');
    // 下一个 router 注册行 = 端点体结束边界（同 verify-sys-timeline-label-coverage.js 既有窗口截取手法）。
    const nextRouterMatch = /\n  router\.(get|post|put|delete)\(/.exec(indexSrc.slice(startIdx + startMarker.length));
    assert.ok(nextRouterMatch, '[⑨] 未找到建单端点体结束边界（下一个 router 注册行）——端点体可能已变形，需人工核实');
    const endIdx = startIdx + startMarker.length + nextRouterMatch.index;
    const rawBody = indexSrc.slice(startIdx, endIdx);
    const stripComments = (src) => src.split('\n').map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    }).join('\n');
    const cleanBody = stripComments(rawBody);

    function scanBodyKeys(src) {
      const re = /\bb\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
      const keys = new Set();
      let m;
      while ((m = re.exec(src))) keys.add(m[1]);
      return [...keys].sort();
    }
    // 差集计算独立成纯函数（同 [⑧] checkCompleteness 手法）——既拿真实源码跑一次证明当前自洽，也拿
    // 人为构造的"多余字段"跑一次证明扫描器真的会抓（双向证明）。
    function computeUncoveredKeys(bodyKeys, formFields, protocolFields) {
      const covered = new Set([...formFields, ...Object.keys(protocolFields)]);
      return bodyKeys.filter(k => !covered.has(k));
    }

    const bodyKeys = scanBodyKeys(cleanBody);
    assert.ok(bodyKeys.length >= 15, `[⑨] 建单端点体扫描到的 b.<key> 数应 ≥15（实际 ${bodyKeys.length}：${JSON.stringify(bodyKeys)}）——数量过少说明端点体切片边界可能不对`);

    const realUncovered = computeUncoveredKeys(bodyKeys, I.SYS_CREATE_FORM_FIELDS, I.SYS_CREATE_PROTOCOL_REJECTED_FIELDS);
    assert.deepStrictEqual(realUncovered, [], `[⑨] 建单端点体存在未登记的 b.<key> 消费点（不在 SYS_CREATE_FORM_FIELDS 也不在 SYS_CREATE_PROTOCOL_REJECTED_FIELDS）：${JSON.stringify(realUncovered)}——新增字段须补登记到其中一个集合`);
    // 六项协议字段逐项非空理由（同 SYS_EDIT_EXCLUDED_FIELDS 纪律）。
    const protocolKeys = Object.keys(I.SYS_CREATE_PROTOCOL_REJECTED_FIELDS);
    assert.strictEqual(protocolKeys.length, 6, `[⑨] SYS_CREATE_PROTOCOL_REJECTED_FIELDS 应恰 6 项，实际 ${protocolKeys.length}：${JSON.stringify(protocolKeys)}`);
    for (const k of protocolKeys) {
      const reason = I.SYS_CREATE_PROTOCOL_REJECTED_FIELDS[k];
      assert.ok(typeof reason === 'string' && reason.trim(), `[⑨] 协议字段 "${k}" 排除理由不应为空`);
    }
    ok(`[⑨] 建单端点体 b.<key> 全集扫描到 ${bodyKeys.length} 项，全部 ⊆ 建单集(${I.SYS_CREATE_FORM_FIELDS.length}) ∪ 协议字段(${protocolKeys.length})；六项协议字段逐项理由非空`);

    // 红灯验证：人为构造一个"多余字段"（真实源码里不存在的假 key），confirm computeUncoveredKeys 真的会报。
    const brokenBodyKeys = [...bodyKeys, 'totally_unregistered_probe_field'];
    const brokenUncovered = computeUncoveredKeys(brokenBodyKeys, I.SYS_CREATE_FORM_FIELDS, I.SYS_CREATE_PROTOCOL_REJECTED_FIELDS);
    assert.deepStrictEqual(brokenUncovered, ['totally_unregistered_probe_field'], `[⑨红灯] 人为构造的未登记字段应被扫描器抓到，实际=${JSON.stringify(brokenUncovered)}`);
    ok('[⑨红灯] 人为构造未登记字段 → computeUncoveredKeys 正确捕获（双向证明，非空转绿灯）');

    // ═══ [⑨-反向]【NEW-5·2026-08-14 改按字段类别映射】SYS_CREATE_FORM_FIELDS 每项须"真实消费"落地 ═══
    //   [⑨] 只证"端点真实读取的 b.<key> 全部已登记"（正向：消费⊆声明），本身不能防止**反过来**的
    //   偏差——常量数组里躺着一个早已被删除消费点的过期字段名。旧版反向判据用"bodyKeys ∪ 前端控件
    //   集"取并集（任一侧命中即视为"活字段"），这条判据会放过它本该防的**最危险**场景：「前端孤儿
    //   控件+后端已删消费」——前端表单还在渲染这个输入框，用户填了会以为生效，但后端 `if (b.foo)`
    //   消费点早被删掉，值静默丢弃、用户毫无察觉；并集逻辑下 f∈frontendFields 就足够判"活"，完全不
    //   会报警。改按**字段类别**分别映射，不再取并集：
    //   · JSON 字段（普通表单字段，走请求体 b.<key>）：后端消费点(bodyKeys) **且** 前端控件(feFields)
    //     两侧都须在——任一侧缺即判僵尸（红），这样"前端孤儿控件"和"后端死代码"两个方向都能被抓到。
    //   · attachments 类：不走 JSON body（`b.attachments` 结构性不存在，走独立 FormData 二次上传），
    //     显式映射到专属消费代码——后端侧改判"POST /sys-issues/:id/attachments 独立上传端点是否存在"
    //     （而非 bodyKeys.includes('attachments')，否则该字段在 AND 判据下会恒假红），前端侧仍判
    //     siFilePickerHtml('create-spec', ...) 控件是否存在。
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    function extractCreateFormFrontendFields(src) {
      const startMarker = `siModal('新建迭代单', [`;
      const startIdx = src.indexOf(startMarker);
      assert.ok(startIdx > 0, '[⑨-反向前置] 应能定位创建弹窗字段数组起点（siOpenCreate 内 siModal 调用）');
      const endMarker = `], async v => {`;
      const endIdx = src.indexOf(endMarker, startIdx);
      assert.ok(endIdx > startIdx, '[⑨-反向前置] 应能定位创建弹窗字段数组结束边界');
      const fieldsSrc = src.slice(startIdx, endIdx);
      const fields = new Set();
      // f<Xxx>('key', ...) 惯用调用形态（fText/fTextarea/fSelect/fSelectMap/fDateTime/fCheckbox 等）。
      const fCallRe = /\bf[A-Za-z]*\(\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g;
      let m;
      while ((m = fCallRe.exec(fieldsSrc))) fields.add(m[1]);
      // 内联 { k: 'xxx', html: ... } 型字段（非 fXxx 调用包裹）。
      const kFieldRe = /\{\s*k:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g;
      while ((m = kFieldRe.exec(fieldsSrc))) fields.add(m[1]);
      // 部分字段由专属 helper 函数产出（数组里只是一个函数调用，如 siIntakeLiaisonFieldHtml()/
      // siRequesterDeptFieldHtml()），需要二次解析该函数自身定义体内的 k 值。
      const HELPER_FIELD_FUNCS = ['siIntakeLiaisonFieldHtml', 'siRequesterDeptFieldHtml'];
      for (const fnName of HELPER_FIELD_FUNCS) {
        if (fieldsSrc.includes(fnName + '(')) {
          const fnStart = src.indexOf(`function ${fnName}(`);
          assert.ok(fnStart > 0, `[⑨-反向前置] 应能定位 helper 函数 ${fnName} 定义`);
          const fnSlice = src.slice(fnStart, fnStart + 3000);
          const km = /k:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/.exec(fnSlice);
          assert.ok(km, `[⑨-反向前置] helper 函数 ${fnName} 应能解析出 k 字段名`);
          fields.add(km[1]);
        }
      }
      // attachments——独立文件选择器组件（siFilePickerHtml('create-spec', ...)），非 fXxx('attachments',
      // ...) 惯用形态；建单提交时通过独立 FormData 二次请求上传，非本次 JSON body 的一部分，但仍是
      // "建单表单让用户填写"的真实控件（SYS_CREATE_FORM_FIELDS 该字段注释原话），显式识别其存在。
      if (/siFilePickerHtml\('create-spec'/.test(fieldsSrc)) fields.add('attachments');
      return [...fields].sort();
    }
    const frontendFields = extractCreateFormFrontendFields(htmlSrc);
    assert.ok(frontendFields.length >= 10, `[⑨-反向前置] 前端建单表单控件扫描应 ≥10 项，实得 ${frontendFields.length}：${JSON.stringify(frontendFields)}——数量过少说明扫描边界可能不对`);

    // attachments 后端侧改判"独立上传端点是否存在"——文本层面即为该路由注册行字面量（:13016 一带）。
    const ATTACHMENT_TYPE_FIELDS = new Set(['attachments']);
    const attachmentUploadRouteRe = /router\.post\(\s*'\/sys-issues\/:id\/attachments'/;
    // 前端控件"有意不存在"的显式白名单（同 SYS_CREATE_PROTOCOL_REJECTED_FIELDS"逐项非空理由"纪律，
    //   非泛化 OR 例外——实测运行本组时抓到真实存在的这一种：title 后端仍保留 b.title 可选兼容入口
    //   （index.js :6241-6242 一带 rawTitle||deriveSysTitleFromDescription 自动派生），但建单优化批
    //   C2（方案 §6b.1）已撤除主建单弹窗的标题输入框（描述接管唯一内容主字段）——前端无控件是**已拍板
    //   的设计**，不是"删消费忘同步"式僵尸。豁免只免前端侧，后端消费点仍须存在（!bodySet.has(f) 依旧
    //   会判红），故不会掩盖"backend 也被删"这个真正的僵尸场景。
    const FRONTEND_CONTROL_INTENTIONALLY_ABSENT = {
      title: '建单优化批 C2（方案 §6b.1）撤除标题输入框，描述接管唯一内容主字段，标题按描述首行自动派生（deriveSysTitleFromDescription，index.js :6242）；后端保留 b.title 为可选兼容入口（衍生/reactivate 等独立入口自带 title 但走独立代码路径，见该端点 :6235-6236 注释），主建单弹窗故意不提供显式控件，非遗漏。',
    };
    for (const [k, reason] of Object.entries(FRONTEND_CONTROL_INTENTIONALLY_ABSENT)) {
      assert.ok(typeof reason === 'string' && reason.trim(), `[⑨-反向前置] 前端控件豁免字段 "${k}" 理由不应为空`);
    }
    function computeStaleFormFieldsByCategory(formFields, realBodyKeys, feFields, attachmentBackendPresent) {
      const bodySet = new Set(realBodyKeys);
      const feSet = new Set(feFields);
      const stale = [];
      for (const f of formFields) {
        if (ATTACHMENT_TYPE_FIELDS.has(f)) {
          // attachments 类：后端=独立上传端点是否存在，前端=siFilePickerHtml 控件（extractCreateFormFrontendFields 已识别）。
          if (!attachmentBackendPresent || !feSet.has(f)) stale.push(f);
        } else if (FRONTEND_CONTROL_INTENTIONALLY_ABSENT[f]) {
          // 前端控件有意不存在的白名单字段：只判后端消费点这一侧（豁免不含后端，同样能抓"backend 也被删"）。
          if (!bodySet.has(f)) stale.push(f);
        } else {
          // 普通 JSON 字段：后端 b.<key> 消费点 AND 前端控件——双侧都须在，任一侧缺即判僵尸（红）。
          //   这正是本次改造要补的洞——旧版并集判据下，"前端还有孤儿控件但后端消费已删"这个最危险
          //   的方向永远不会被 !bodySet.has(f) 命中拦下（因为 feSet.has(f) 已经满足并集），改 AND
          //   之后任一侧缺都判红，两个方向都能抓到。
          if (!bodySet.has(f) || !feSet.has(f)) stale.push(f);
        }
      }
      return stale;
    }
    const attachmentBackendPresent = attachmentUploadRouteRe.test(indexSrc);
    assert.ok(attachmentBackendPresent, '[⑨-反向前置] 应能定位独立附件上传端点 POST /sys-issues/:id/attachments（attachments 类后端消费落脚点）');
    const staleFields = computeStaleFormFieldsByCategory(I.SYS_CREATE_FORM_FIELDS, bodyKeys, frontendFields, attachmentBackendPresent);
    assert.deepStrictEqual(staleFields, [], `[⑨-反向] SYS_CREATE_FORM_FIELDS 存在按类别映射后判"僵尸"的字段：${JSON.stringify(staleFields)}——普通 JSON 字段须后端消费点(bodyKeys)与前端控件双侧都在，attachments 类须独立上传端点与前端控件都在，白名单字段（title）只须后端消费点在，任一侧缺即需人工核实并同步`);
    ok(`[⑨-反向] SYS_CREATE_FORM_FIELDS 全部 ${I.SYS_CREATE_FORM_FIELDS.length} 项按类别映射逐一核对：14 项普通 JSON 字段=后端消费点(bodyKeys)∧前端控件双侧都在；1 项 attachments=独立上传端点∧前端控件都在；1 项白名单(title)=后端消费点在+前端有意无控件（理由非空），零僵尸字段`);

    // 红灯验证【两方向，NEW-5 核心证据】：分别删后端消费点 / 删前端控件，证明 AND 判据两个方向都能抓到
    // ——旧版并集判据下，方向 A（前端孤儿控件+后端已删消费）是完全抓不到的漏洞，本次改造专防这个方向。
    const sampleJsonField = 'system_name';   // 任取一个真实存在于两侧、且不在白名单里的普通 JSON 字段做探针。
    assert.ok(bodyKeys.includes(sampleJsonField) && frontendFields.includes(sampleJsonField) && !FRONTEND_CONTROL_INTENTIONALLY_ABSENT[sampleJsonField],
      `[⑨-反向红灯前置] 探针字段「${sampleJsonField}」应真实存在于 bodyKeys 与 frontendFields 两侧且不在白名单里（否则以下两个红灯用例的前提不成立）`);

    // 方向 A（最危险）：后端消费点被删，前端控件仍在——旧版并集逻辑因 feFields 命中而判"活"，完全放过；
    //   新版 AND 判据须命中 !bodySet.has(f) 分支，判红。
    const bodyKeysMinusBackend = bodyKeys.filter(k => k !== sampleJsonField);
    const staleA = computeStaleFormFieldsByCategory(I.SYS_CREATE_FORM_FIELDS, bodyKeysMinusBackend, frontendFields, attachmentBackendPresent);
    assert.ok(staleA.includes(sampleJsonField), `[⑨-反向红灯-A] 删后端消费点（保留前端控件）后，「${sampleJsonField}」应被判僵尸，实际未命中=${JSON.stringify(staleA)}——若此断言失败说明判据退回了旧版"并集"逻辑，前端孤儿控件+后端已删消费这个最危险场景又会被放过`);

    // 方向 B：前端控件被删，后端消费点仍在——判红（对称方向，同样不该被并集逻辑放过）。
    const frontendFieldsMinusFe = frontendFields.filter(k => k !== sampleJsonField);
    const staleB = computeStaleFormFieldsByCategory(I.SYS_CREATE_FORM_FIELDS, bodyKeys, frontendFieldsMinusFe, attachmentBackendPresent);
    assert.ok(staleB.includes(sampleJsonField), `[⑨-反向红灯-B] 删前端控件（保留后端消费点）后，「${sampleJsonField}」应被判僵尸，实际未命中=${JSON.stringify(staleB)}`);
    ok(`[⑨-反向红灯] 两方向验证：删后端消费点（保留前端控件，最危险方向）→ 判红；删前端控件（保留后端消费点）→ 判红（探针字段「${sampleJsonField}」，AND 判据两方向均生效，非空转绿灯）`);

    // 保留原"完全不存在任何消费/控件"的基线红灯（真实僵尸字段场景，双侧皆无）。
    const brokenFormFields = [...I.SYS_CREATE_FORM_FIELDS, 'totally_removed_ghost_field'];
    const brokenStale = computeStaleFormFieldsByCategory(brokenFormFields, bodyKeys, frontendFields, attachmentBackendPresent);
    assert.deepStrictEqual(brokenStale, ['totally_removed_ghost_field'], `[⑨-反向红灯-基线] 人为构造的僵尸字段应被扫描器抓到，实际=${JSON.stringify(brokenStale)}`);
    ok('[⑨-反向红灯-基线] 人为构造双侧皆无的僵尸字段 → computeStaleFormFieldsByCategory 正确捕获（非空转绿灯）');
  }

  // ═══ [⑩] 【S8-S10 合并收口批 F5】source 三值枚举：DDL CHECK 文本 ⟺ SYS_SOURCES 常量集合相等 ═══
  {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const ddlMatch = /source TEXT NOT NULL DEFAULT '[^']*' CHECK \(source IN \(([^)]*)\)\)/.exec(indexSrc);
    assert.ok(ddlMatch, '[⑩] 应能定位到 sys_issues.source 列的 DDL CHECK 文本——若断言失败说明 DDL 写法已变，需同步更新本文件正则');
    function parseDdlSourceValues(ddlSql, listExpr) {
      const re = /'([^']*)'/g;
      const values = [];
      let m;
      while ((m = re.exec(listExpr))) values.push(m[1]);
      return values;
    }
    const ddlValues = parseDdlSourceValues(ddlMatch[0], ddlMatch[1]);
    assert.deepStrictEqual([...ddlValues].sort(), [...I.SYS_SOURCES].sort(),
      `[⑩] DDL CHECK 枚举值应与 SYS_SOURCES 常量集合相等，DDL=${JSON.stringify(ddlValues)}，常量=${JSON.stringify(I.SYS_SOURCES)}`);
    ok(`[⑩] source DDL CHECK 文本（${JSON.stringify(ddlValues)}）与 SYS_SOURCES 常量集合相等`);

    // 红灯验证：人为构造一个"DDL 多一个值"的场景，确认比对逻辑真的会报差异（非恒真断言）。
    const brokenDdlValues = [...ddlValues, '测试用假值'];
    assert.notDeepStrictEqual([...brokenDdlValues].sort(), [...I.SYS_SOURCES].sort(),
      '[⑩红灯] 人为构造的多余 DDL 值应与常量集合不相等（证明比对逻辑不是恒真）');
    ok('[⑩红灯] 人为构造 DDL 多余值 → 集合比对正确判不等（非恒真断言）');
  }

  server.close();
  console.log(`\n✅ verify-sys-edit-window 全绿：${passed} 组断言通过`);
  console.log('  覆盖：六态×两档字段矩阵正例 + 两档负例(未知字段/needs_feasibility锁定) + 待验证起终态族409 + 并发窗口WHERE终闸负例 + 评估在先标注(出现/不出现) + 404/403冒烟 + 新字段(source/related_correction_no)正负例 + 同源守卫(建单集=可编辑集∪排除集)含红灯验证');
}

main().catch(e => { console.error('❌ verify-sys-edit-window 失败:', e && e.stack || e); process.exit(1); });
