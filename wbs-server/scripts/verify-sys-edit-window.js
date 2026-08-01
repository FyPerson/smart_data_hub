// 验证脚本：系统迭代 建单优化批 C3 — 编辑窗口两档扩展（edit_in_revision）
//   （方案 docs/local/系统迭代/系统迭代_建单优化批_方案_20260731_v1.2.md §6）
//   用法：node scripts/verify-sys-edit-window.js
//
// 行为面清单制（对齐 verify-sys-intake-liaison.js 范式）：
//   [①] 六态×两档字段矩阵正例：待受理/待修改/待指派/待处理（A 档 10 字段全量）+ 开发中/处理中
//        （B 档 9 字段，剔除 needs_feasibility）——每态各建一单，全字段改动，断言 200 + changed 完整 + 落库
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
//
// 断言纪律：钉确切 HTTP 码 + code；[④] 负控制断言零副作用（字段值 + timeline 行数均对比变更前）。
'use strict';
const assert = require('assert');
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

  // ═══ [①] 六态×两档字段矩阵正例：A 档 4 态全量 10 字段 / B 档 2 态 9 字段（剔除 needs_feasibility） ═══
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
      title: '新标题-待修改', description: '新描述2', system_name: 'OA', module_name: '模块2',
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

    ok('[①] A 档四态（待受理/待修改/待指派/待处理）：10 字段全量正例，200 + 落库正确');

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
      title: '新标题-处理中', description: '新描述6', system_name: 'OA', module_name: '模块6',
      priority: 'P0', deadline: '2026-07-31',
      requester_dept: '部门6', requester_name: '姓名6', requester_phone: '13800000006',
    });
    assert.strictEqual(r6.status, 200, `[①处理中] 期望 200, got ${r6.status} ${JSON.stringify(r6.body)}`);
    assert.strictEqual(r6.body.changed.length, 9, `[①处理中] 恰 9 字段，实际=${JSON.stringify(r6.body.changed)}`);

    ok('[①] B 档两态（开发中/处理中）：9 字段正例（不含 needs_feasibility），200 + 落库正确 + 原值保留');
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

  server.close();
  console.log(`\n✅ verify-sys-edit-window 全绿：${passed} 组断言通过`);
  console.log('  覆盖：六态×两档字段矩阵正例 + 两档负例(未知字段/needs_feasibility锁定) + 待验证起终态族409 + 并发窗口WHERE终闸负例 + 评估在先标注(出现/不出现) + 404/403冒烟');
}

main().catch(e => { console.error('❌ verify-sys-edit-window 失败:', e && e.stack || e); process.exit(1); });
