// scripts/verify-sys-hold-note.js — #208 暂缓单备注 阶段一（文字备注：新增 / 编辑 / 作废）验收
//   SSOT = docs/local/系统迭代/暂缓备注_方案_20261109_v1.1.md 第五节 1–9
//   用法：node scripts/verify-sys-hold-note.js（进程内 :memory: 库 + 进程内 HTTP，不碰任何业务库与固定端口）
//
//   威胁模型：只证明「诚实实现写错会判红」——校验写在锁外、轮次比较用错 id、能力位漏状态门、编辑目标没限定原备注、
//   字数按 UTF-16 码元数等。对抗性绕过不在范围内。
'use strict';
process.env.SYS_TEST_HOOKS = '1';   // 必须先于 require 路由模块（SYS_TEST_HOOKS_ENABLED 是模块加载时求值的常量）

const { listenOnSafePort } = require('./lib/listen-safe-port');
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-hold-note-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); } catch { return res.status(401).json({ error: 'token 无效' }); }
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

const tok = (id, role, name) => jwt.sign({ id, username: 'u' + id, display_name: name, role }, SECRET);
const A1 = tok(1, 'admin', '管理员甲');   // 建单人（多数单）+ 备注作者
const A2 = tok(2, 'admin', '管理员乙');   // 管理员，非作者
const U7 = tok(7, 'user', '建单人丙');    // 非管理员建单人（D3 的「建单人」分支）
const U8 = tok(8, 'user', '无关人丁');    // 无关用户

let server, port;
function call(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const expectCode = (r, status, code, msg) => {
  assert.strictEqual(r.status, status, `${msg}：期望 ${status}，实得 ${r.status} ${JSON.stringify(r.body)}`);
  if (code) assert.strictEqual(r.body && r.body.code, code, `${msg}：期望错误码 ${code}，实得 ${JSON.stringify(r.body)}`);
};

// ── 造数 ──────────────────────────────────────────────────────────────
const ACTIVE_BY_TYPE = { feature: '开发中', improvement: '开发中', bug: '处理中', config: '处理中' };
async function mkIssue(type, status, createdBy = 1) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, assigned_at)
     VALUES (?, ?, ?, 'BMS', '内部', ?, ?, datetime('now','localtime'))`,
    [type, status, `${type}-${status}-暂缓备注验证单`, createdBy, createdBy === 7 ? '建单人丙' : '管理员甲']);
  // 开发执行态要求在册成员 ≥ 1（resume 回到开发态时的 GATE_INVARIANT），统一补一个在册开发。
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, 5, '开发戊', 1, 'pending')`, [r.lastID]);
  await run('UPDATE sys_issues SET assigned_to = 5, assigned_to_name = ? WHERE id = ?', ['开发戊', r.lastID]);
  return r.lastID;
}
async function hold(id) { const r = await call('POST', `/api/sys-issues/${id}/hold`, A1, { reason: '验证暂缓备注' }); expectCode(r, 200, null, `hold #${id}`); }
async function resume(id) { const r = await call('POST', `/api/sys-issues/${id}/resume`, A1, { reason: '验证恢复' }); expectCode(r, 200, null, `resume #${id}`); }
async function heldIssue(type = 'feature', createdBy = 1) { const id = await mkIssue(type, ACTIVE_BY_TYPE[type], createdBy); await hold(id); return id; }
const addNote = (id, token, body) => call('POST', `/api/sys-issues/${id}/hold-notes`, token, body);
const editNote = (id, nid, token, body) => call('POST', `/api/sys-issues/${id}/hold-notes/${nid}/edit`, token, body);
const voidNote = (id, nid, token, body) => call('POST', `/api/sys-issues/${id}/hold-notes/${nid}/void`, token, body);
const tlCount = async (id) => (await get('SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE issue_id = ?', [id])).n;
const tlRow = (eid) => get('SELECT * FROM sys_issue_timeline WHERE id = ?', [eid]);
const today = async () => (await get(`SELECT date('now','localtime') AS d`)).d;
const tomorrow = async () => (await get(`SELECT date('now','localtime','+1 day') AS d`)).d;
async function goodNote(id, token = A1, content = '等待业务方确认需求') {
  const r = await addNote(id, token, { note_date: await today(), content });
  expectCode(r, 200, null, `addNote #${id}`);
  return r.body.note_id;
}

// [codex 602 R-2] 有限等待：请求提前失败、没走到钩子时不让脚本一直挂着。
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}：${ms}ms 内未完成`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
// 可控交错：把指定请求停在拿锁之前（holdNoteBeforeLockHook），返回 {reached, release}。
//   reached 带 5 秒超时；调用方在 finally 里 release()（幂等）并清钩子，失败时也不留悬空的屏障。
function pauseAt(match) {
  let reachedResolve, releaseResolve;
  const reachedRaw = new Promise(r => { reachedResolve = r; });
  const reached = withTimeout(reachedRaw, 5000, `等待 ${match.action} 请求到达拿锁前钩子`);
  reached.catch(() => {});   // 由调用方 await 时处理，这里只防未处理拒绝
  const gate = new Promise(r => { releaseResolve = r; });
  I.__testHooks.holdNoteBeforeLockHook = async (info) => {
    if (info.action === match.action && info.issueId === match.issueId) {
      I.__testHooks.holdNoteBeforeLockHook = null;   // 只拦第一次
      reachedResolve();
      await gate;
    }
  };
  return { reached, release: () => { I.__testHooks.holdNoteBeforeLockHook = null; releaseResolve(); } };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'u1','管理员甲','admin'),(2,'u2','管理员乙','admin'),(5,'u5','开发戊','user'),(7,'u7','建单人丙','user'),(8,'u8','无关人丁','user')`);
  { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = await listenOnSafePort(app, null); port = server.address().port; }
  ok('readiness + 进程内 HTTP（SYS_TEST_HOOKS=1）');

  // ══ [1] 新增 ══════════════════════════════════════════════════════
  {
    const id = await heldIssue('feature', 1);
    const d = await today();
    let r = await addNote(id, A1, { note_date: d, content: '  等待业务方确认  ' });
    expectCode(r, 200, null, '[1] 建单人（管理员）新增');
    const row = await tlRow(r.body.note_id);
    assert.deepStrictEqual(
      { event_type: row.event_type, action_code: row.action_code, ref_id: row.ref_id, operator_id: row.operator_id, operator_name: row.operator_name, summary: row.summary, issue_id: row.issue_id },
      { event_type: 'note', action_code: 'hold_note', ref_id: null, operator_id: 1, operator_name: '管理员甲', summary: '等待业务方确认', issue_id: id }, '[1] 落库字段全等');
    assert.deepStrictEqual(JSON.parse(row.payload_json), { note_date: d, content: '等待业务方确认', added_attachments: [], removed_attachments: [] }, '[1] payload 全等（内容已去首尾空白，C2 附件变动为空）');
    ok('[1] 建单人新增成功，流水 event_type / action_code / ref_id / operator / summary / payload 全等');

    r = await addNote(id, A2, { note_date: d, content: '管理员乙补记' });
    expectCode(r, 200, null, '[1] 非建单人的管理员新增');
    ok('[1] 非建单人的管理员也可新增（D3）');

    const id7 = await heldIssue('improvement', 7);
    r = await addNote(id7, U7, { note_date: d, content: '非管理员建单人记录' });
    expectCode(r, 200, null, '[1] 非管理员建单人新增');
    ok('[1] 非管理员建单人可新增（D3 建单人分支）');

    let before = await tlCount(id);
    r = await addNote(id, U8, { note_date: d, content: '无关人员' });
    expectCode(r, 403, 'NOT_AUTHORIZED_FOR_HOLD_NOTE', '[1] 无关用户');
    assert.strictEqual(await tlCount(id), before, '[1] 被拒不留流水');
    ok('[1] 无关用户 403 且不留流水');

    const idActive = await mkIssue('feature', '开发中');
    r = await addNote(idActive, A1, { note_date: d, content: '非暂缓态' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[1] 非暂缓态');
    ok('[1] 非暂缓态 409 HOLD_NOTE_INVALID_STATE');

    const bad = [
      [{ note_date: await tomorrow(), content: 'x' }, '未来日期'],
      [{ note_date: '2023-02-29', content: 'x' }, '不存在的日期 2023-02-29'],
      [{ note_date: '2026-13-01', content: 'x' }, '不存在的月份'],
      [{ note_date: '2026/11/01', content: 'x' }, '格式错'],
      [{ content: 'x' }, '缺日期'],
      [{ note_date: d, content: '   ' }, '纯空白内容'],
      [{ note_date: d }, '缺内容'],
      [{ note_date: d, content: 'a'.repeat(501) }, '501 字'],
      [{ note_date: d, content: '😀'.repeat(501) }, '501 个表情'],
    ];
    before = await tlCount(id);
    for (const [body, label] of bad) {
      r = await addNote(id, A1, body);
      expectCode(r, 400, 'HOLD_NOTE_INVALID_INPUT', `[1] ${label}`);
    }
    assert.strictEqual(await tlCount(id), before, '[1] 输入非法不留流水');
    ok(`[1] ${bad.length} 种非法输入均 400 HOLD_NOTE_INVALID_INPUT 且不留流水`);

    r = await addNote(id, A1, { note_date: '2024-02-29', content: 'a'.repeat(500) });
    expectCode(r, 200, null, '[1] 闰日 + 恰好 500 字');
    r = await addNote(id, A1, { note_date: d, content: '😀'.repeat(500) });
    expectCode(r, 200, null, '[1] 500 个表情（1000 个 UTF-16 码元）');
    assert.strictEqual([...(await tlRow(r.body.note_id)).summary].length, 80, '[1] summary 按字符截 80');
    ok('[1] 闰日、恰好 500 字、500 个表情均通过；summary 按字符截取 80');
  }

  // ══ [2] 编辑 ══════════════════════════════════════════════════════
  {
    const id = await heldIssue('feature', 1);
    const d = await today();
    const nid = await goodNote(id, A1, '第一版');
    let r = await editNote(id, nid, A1, { note_date: '2026-01-05', content: '第二版' });
    expectCode(r, 200, null, '[2] 作者编辑');
    const ev = await tlRow(r.body.event_id);
    assert.deepStrictEqual({ event_type: ev.event_type, action_code: ev.action_code, ref_id: ev.ref_id, operator_id: ev.operator_id },
      { event_type: 'note', action_code: 'hold_note_edit', ref_id: nid, operator_id: 1 }, '[2] 编辑事件字段');
    assert.deepStrictEqual(JSON.parse(ev.payload_json), { note_date: '2026-01-05', content: '第二版', added_attachments: [], removed_attachments: [] }, '[2] 编辑 payload');
    assert.deepStrictEqual(JSON.parse((await tlRow(nid)).payload_json), { note_date: d, content: '第一版', added_attachments: [], removed_attachments: [] }, '[2] 原备注未被修改（只追加）');
    r = await editNote(id, nid, A1, { note_date: d, content: '第三版' });
    expectCode(r, 200, null, '[2] 第二次编辑');
    ok('[2] 作者连续编辑两次，各追加一条 hold_note_edit（ref_id 指原备注），原备注不变');

    let before = await tlCount(id);
    r = await editNote(id, nid, A2, { note_date: d, content: '管理员非作者' });
    expectCode(r, 403, 'HOLD_NOTE_NOT_AUTHOR', '[2] 管理员非作者');
    assert.strictEqual(await tlCount(id), before, '[2] 被拒不留流水');
    ok('[2] 管理员非作者 403 HOLD_NOTE_NOT_AUTHOR（D4）');

    // 目标约束（M-1）：编辑事件 id / 别的单的备注 / 非备注流水
    const editEventId = r.body ? (await get(`SELECT MAX(id) AS m FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'hold_note_edit'`, [id])).m : null;
    r = await editNote(id, editEventId, A1, { note_date: d, content: '编辑的编辑' });
    expectCode(r, 404, 'HOLD_NOTE_NOT_FOUND', '[2] 目标是编辑事件');
    const otherId = await heldIssue('feature', 1);
    const otherNid = await goodNote(otherId, A1, '别的单');
    r = await editNote(id, otherNid, A1, { note_date: d, content: '跨单' });
    expectCode(r, 404, 'HOLD_NOTE_NOT_FOUND', '[2] 目标是别的单的备注');
    const holdEvId = (await get(`SELECT id FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'hold'`, [id])).id;
    r = await editNote(id, holdEvId, A1, { note_date: d, content: '非备注' });
    expectCode(r, 404, 'HOLD_NOTE_NOT_FOUND', '[2] 目标是暂缓事件');
    assert.strictEqual(await tlCount(id), before, '[2] 目标非法不留流水');
    ok('[2] 目标是编辑事件 / 别的单的备注 / 非备注流水均 404 HOLD_NOTE_NOT_FOUND（M-1）');

    r = await voidNote(id, nid, A1, { reason: '写错了' });
    expectCode(r, 200, null, '[2] 作废');
    r = await editNote(id, nid, A1, { note_date: d, content: '作废后编辑' });
    expectCode(r, 409, 'HOLD_NOTE_VOIDED', '[2] 作废后编辑');
    ok('[2] 作废后编辑 409 HOLD_NOTE_VOIDED');

    const id2 = await heldIssue('feature', 1);
    const n2 = await goodNote(id2, A1, '恢复前写的');
    await resume(id2);
    r = await editNote(id2, n2, A1, { note_date: d, content: '恢复后编辑' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[2] 恢复后编辑');
    ok('[2] 恢复后编辑 409 HOLD_NOTE_INVALID_STATE');
  }

  // ══ [3] 作废 ══════════════════════════════════════════════════════
  {
    const id = await heldIssue('bug', 1);
    const d = await today();
    const nid = await goodNote(id, A1, '要作废的');
    let r = await voidNote(id, nid, A1, { reason: '   ' });
    expectCode(r, 400, 'HOLD_NOTE_INVALID_INPUT', '[3] 原因纯空白');
    r = await voidNote(id, nid, A1, { reason: 'x'.repeat(201) });
    expectCode(r, 400, 'HOLD_NOTE_INVALID_INPUT', '[3] 原因 201 字');
    r = await voidNote(id, nid, A2, { reason: '非作者' });
    expectCode(r, 403, 'HOLD_NOTE_NOT_AUTHOR', '[3] 非作者作废');
    r = await voidNote(id, nid, A1, { reason: '  内容写错  ' });
    expectCode(r, 200, null, '[3] 作者作废');
    const ev = await tlRow(r.body.event_id);
    assert.deepStrictEqual({ event_type: ev.event_type, action_code: ev.action_code, ref_id: ev.ref_id, operator_id: ev.operator_id, summary: ev.summary },
      { event_type: 'note', action_code: 'hold_note_void', ref_id: nid, operator_id: 1, summary: '内容写错' }, '[3] 作废事件字段');
    assert.deepStrictEqual(JSON.parse(ev.payload_json), { reason: '内容写错' }, '[3] 作废 payload');
    r = await voidNote(id, nid, A1, { reason: '再作废一次' });
    expectCode(r, 409, 'HOLD_NOTE_VOIDED', '[3] 重复作废');
    ok('[3] 原因空 / 超长 400，非作者 403，作者作废落库全等，重复作废 409 HOLD_NOTE_VOIDED');

    // [codex 602 R-1] 作废端点的目标约束（与编辑端点共用判定函数，但端点接线各自独立验证）
    const idT = await heldIssue('bug', 1);
    const nT = await goodNote(idT, A1, '目标约束用');
    const editEv = (await editNote(idT, nT, A1, { note_date: d, content: '改一次' })).body.event_id;
    const otherIssue = await heldIssue('bug', 1);
    const otherNote = await goodNote(otherIssue, A1, '别的单');
    const holdEv = (await get(`SELECT id FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'hold'`, [idT])).id;
    const beforeT = await tlCount(idT);
    const beforeOther = await tlCount(otherIssue);
    for (const [target, label] of [[editEv, '编辑事件'], [otherNote, '别的单的备注'], [holdEv, '暂缓事件']]) {
      r = await voidNote(idT, target, A1, { reason: '非法目标' });
      expectCode(r, 404, 'HOLD_NOTE_NOT_FOUND', `[3] 作废目标是${label}`);
    }
    assert.strictEqual(await tlCount(idT), beforeT, '[3] 非法目标不留流水');
    assert.strictEqual(await tlCount(otherIssue), beforeOther, '[3] 别的单未被写入');
    ok('[3] 作废目标是编辑事件 / 别的单的备注 / 非备注流水均 404 HOLD_NOTE_NOT_FOUND，且不留流水（R-1）');

    const id2 = await heldIssue('bug', 1);
    const n2 = await goodNote(id2, A1, '恢复前');
    await resume(id2);
    r = await voidNote(id2, n2, A1, { reason: '恢复后作废' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[3] 恢复后作废');
    const id3 = await heldIssue('feature', 1);
    const n3 = await goodNote(id3, A1, '单据作废前');
    r = await call('POST', `/api/sys-issues/${id3}/void`, A1, { reason: '单据作废' });
    expectCode(r, 200, null, '[3] 单据作废');
    r = await editNote(id3, n3, A1, { note_date: d, content: '单据作废后编辑' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[3] 单据作废后编辑');
    r = await addNote(id3, A1, { note_date: d, content: '单据作废后新增' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[3] 单据作废后新增');
    ok('[3] 单据恢复后作废备注 409；单据作废（终态）后编辑 / 新增均 409');
  }

  // ══ [5] 详情能力位 ══════════════════════════════════════════════════
  {
    const id = await heldIssue('feature', 1);
    const d = await today();
    const nA1 = await goodNote(id, A1, '甲写的');
    const nA2 = (await addNote(id, A2, { note_date: d, content: '乙写的' })).body.note_id;
    const nVoid = await goodNote(id, A1, '甲写后作废');
    expectCode(await voidNote(id, nVoid, A1, { reason: '作废' }), 200, null, '[5] 准备作废');
    let r = await call('GET', `/api/sys-issues/${id}`, A1);
    expectCode(r, 200, null, '[5] 甲看详情');
    assert.strictEqual(r.body.issue.can_add_hold_note, true, '[5] 甲 can_add');
    assert.deepStrictEqual(r.body.issue.hold_note_editable_ids, [nA1], '[5] 甲只能改自己未作废的');
    r = await call('GET', `/api/sys-issues/${id}`, A2);
    assert.strictEqual(r.body.issue.can_add_hold_note, true, '[5] 乙 can_add');
    assert.deepStrictEqual(r.body.issue.hold_note_editable_ids, [nA2], '[5] 乙只能改自己的');
    // 非管理员用户看不到这张单的详情（读可见性），能力位直接调共用判定函数
    const row = await get('SELECT * FROM sys_issues WHERE id = ?', [id]);
    const tl = await all('SELECT id, event_type, action_code, ref_id, to_status, operator_id FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id', [id]);
    assert.deepStrictEqual(I.holdNoteCapabilities(row, { id: 8, role: 'user' }, tl), { can_add_hold_note: false, hold_note_editable_ids: [] }, '[5] 无关用户');
    assert.deepStrictEqual(I.holdNoteCapabilities({ ...row, created_by: 7 }, { id: 7, role: 'user' }, tl), { can_add_hold_note: true, hold_note_editable_ids: [] }, '[5] 非管理员建单人');
    // [codex 602 M-1·已知限制，用户 11-09 定不放宽] 详情接口刻意不把「建单人」算作可见身份（index.js 详情端点
    //   「不含 isCreator」注释），非管理员建单人打开详情仍 403，页面上没有入口；建单接口要求管理员，现实中不存在此类人。
    //   这里把现状钉住：若将来有人放宽了详情可见性，本断言会提醒同步核对方案 D3 与页面入口。
    const id7 = await heldIssue('improvement', 7);
    r = await call('GET', `/api/sys-issues/${id7}`, U7);
    expectCode(r, 403, 'NOT_AUTHORIZED_TO_VIEW', '[5] 非管理员建单人打开详情（已知限制）');
    await resume(id);
    r = await call('GET', `/api/sys-issues/${id}`, A1);
    assert.strictEqual(r.body.issue.can_add_hold_note, false, '[5] 恢复后 can_add=false');
    assert.deepStrictEqual(r.body.issue.hold_note_editable_ids, [], '[5] 恢复后 editable 为空数组（M-2）');
    await hold(id);
    const nNew = await goodNote(id, A1, '再暂缓后写的');
    r = await call('GET', `/api/sys-issues/${id}`, A1);
    assert.strictEqual(r.body.issue.can_add_hold_note, true, '[5] 再暂缓 can_add');
    assert.deepStrictEqual(r.body.issue.hold_note_editable_ids, [nNew], '[5] 再暂缓后只含本轮备注');
    ok('[5] 能力位：作者 / 管理员非作者 / 无关用户 / 非管理员建单人 × 暂缓 / 恢复后 / 再暂缓 全部符合');
  }

  // ══ [6] 缺失暂缓锚点（M-4）════════════════════════════════════════
  {
    const id = await mkIssue('feature', '已暂缓');   // 直接置态，不写暂缓事件
    const d = await today();
    const fakeNote = await run(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name, payload_json)
       VALUES (?, 'note', '历史备注', 'hold_note', NULL, 1, '管理员甲', ?)`, [id, JSON.stringify({ note_date: d, content: '历史备注' })]);
    const before = await tlCount(id);
    expectCode(await addNote(id, A1, { note_date: d, content: 'x' }), 409, 'HOLD_NOTE_NO_HOLD_ANCHOR', '[6] 新增');
    expectCode(await editNote(id, fakeNote.lastID, A1, { note_date: d, content: 'x' }), 409, 'HOLD_NOTE_NO_HOLD_ANCHOR', '[6] 编辑');
    expectCode(await voidNote(id, fakeNote.lastID, A1, { reason: 'x' }), 409, 'HOLD_NOTE_NO_HOLD_ANCHOR', '[6] 作废');
    assert.strictEqual(await tlCount(id), before, '[6] 不留流水');
    const r = await call('GET', `/api/sys-issues/${id}`, A1);
    assert.deepStrictEqual({ a: r.body.issue.can_add_hold_note, e: r.body.issue.hold_note_editable_ids }, { a: false, e: [] }, '[6] 详情不开放');
    ok('[6] 已暂缓但无暂缓事件：三个写接口 409 HOLD_NOTE_NO_HOLD_ANCHOR，详情能力位关闭，不兜底成 0');
  }

  // ══ [7] 跨轮 × 四种类型（D10）════════════════════════════════════
  for (const type of ['feature', 'improvement', 'bug', 'config']) {
    const id = await heldIssue(type, 1);
    const d = await today();
    const old = await goodNote(id, A1, `${type} 第一轮`);
    await resume(id);
    await hold(id);
    let r = await editNote(id, old, A1, { note_date: d, content: '改上一轮' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', `[7] ${type} 上一轮编辑`);
    r = await voidNote(id, old, A1, { reason: '作废上一轮' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', `[7] ${type} 上一轮作废`);
    const cur = await goodNote(id, A1, `${type} 第二轮`);
    r = await editNote(id, cur, A1, { note_date: d, content: '改本轮' });
    expectCode(r, 200, null, `[7] ${type} 本轮编辑`);
    // 本轮备注被编辑多次后，轮次仍按原备注 id 判断（不因编辑事件 id 更大而放行上一轮）
    r = await editNote(id, old, A1, { note_date: d, content: '再试上一轮' });
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', `[7] ${type} 本轮有编辑后上一轮仍锁定`);
  }
  ok('[7] feature / improvement / bug / config：暂缓→写→恢复→再暂缓，上一轮编辑 / 作废 409，本轮可编辑');

  // ══ [8] 可控交错（M-6）════════════════════════════════════════════
  {
    const d = await today();
    // 一次交错：X 停在拿锁前 → middle() 完整提交 → 放行 X，返回 X 的响应。任何一步失败都先放行屏障（R-2）。
    async function interleave(match, startX, middle, label) {
      const p = pauseAt(match);
      const pending = startX();
      pending.catch(() => {});
      try {
        await p.reached;
        await withTimeout(middle(), 10000, `${label} 中间请求`);   // [codex 603 M-1] 中间请求阻塞也限时失败，finally 照常放行屏障
      } finally {
        p.release();
      }
      return withTimeout(pending, 10000, `${label} 放行后的响应`);
    }
    // ① 编辑停在拿锁前 → 恢复完整提交 → 放行编辑 → 409
    const id1 = await heldIssue('feature', 1);
    const n1 = await goodNote(id1, A1, '交错①');
    let r = await interleave({ action: 'edit', issueId: id1 }, () => editNote(id1, n1, A1, { note_date: d, content: '交错①编辑' }),
      () => resume(id1), '[8①]');
    expectCode(r, 409, 'HOLD_NOTE_INVALID_STATE', '[8①] 恢复先提交后的编辑');
    assert.strictEqual((await get(`SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'hold_note_edit'`, [id1])).n, 0, '[8①] 无编辑事件');
    // ② 作废#1 停在拿锁前 → 作废#2 完整提交 → 放行#1 → 409，恰一条作废事件
    const id2 = await heldIssue('feature', 1);
    const n2 = await goodNote(id2, A1, '交错②');
    r = await interleave({ action: 'void', issueId: id2 }, () => voidNote(id2, n2, A1, { reason: '作废#1' }),
      async () => expectCode(await voidNote(id2, n2, A1, { reason: '作废#2' }), 200, null, '[8②] 作废#2'), '[8②]');
    expectCode(r, 409, 'HOLD_NOTE_VOIDED', '[8②] 作废#1');
    assert.strictEqual((await get(`SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'hold_note_void'`, [id2])).n, 1, '[8②] 恰一条作废事件');
    // ③ 编辑停在拿锁前 → 作废完整提交 → 放行编辑 → 409
    const id3 = await heldIssue('feature', 1);
    const n3 = await goodNote(id3, A1, '交错③');
    r = await interleave({ action: 'edit', issueId: id3 }, () => editNote(id3, n3, A1, { note_date: d, content: '交错③编辑' }),
      async () => expectCode(await voidNote(id3, n3, A1, { reason: '先作废' }), 200, null, '[8③] 作废'), '[8③]');
    expectCode(r, 409, 'HOLD_NOTE_VOIDED', '[8③] 作废后的编辑');
    // 锁已释放：普通请求照常成功
    expectCode(await addNote(id3, A1, { note_date: d, content: '交错后普通请求' }), 200, null, '[8] 锁已释放');
    ok('[8] 三条可控交错：恢复先提交→编辑 409；并发作废恰一条；作废先提交→编辑 409；之后普通请求正常（锁已释放）');
  }

  // ══ [9] 不影响恢复与「已暂缓 N 天」══════════════════════════════════
  {
    const id = await heldIssue('bug', 1);
    // 把暂缓事件拨到过去，备注是「现在」写的——若列表的「已暂缓 N 天」取数误把备注事件算进去，会得到现在的时刻。
    const heldAt = '2026-01-01 08:00:00';
    await run(`UPDATE sys_issue_timeline SET created_at = ? WHERE issue_id = ? AND action_code = 'hold'`, [heldAt, id]);
    await goodNote(id, A1, '不影响统计');
    const r = await call('GET', '/api/sys-issues', A1);
    expectCode(r, 200, null, '[9] 列表');
    const item = (r.body.items || []).find(x => Number(x.id) === id);
    assert.ok(item, '[9] 列表含该单');
    assert.strictEqual(item.last_held_at, heldAt, '[9] last_held_at 仍取暂缓事件时刻，不受备注事件影响');
    // [codex 602 L-3] 效率统计用真实统计函数做前后比较。统计的「响应时刻」取 estimate / feasibility 的最早时刻，
    //   所以把一条 estimate 事件放到备注**之后**（2099 年）：若统计误把备注事件算进来，最早时刻会变成备注的时刻，
    //   前后结果就不相等。nowIso 固定，排除「进行中」单据随墙钟变化。
    const { EFFICIENCY_LOADERS } = require('../utils/efficiency-stats');
    const idS = await heldIssue('feature', 1);
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name, created_at)
               VALUES (?, 'estimate', '2099-01-02 10:00', 1, '管理员甲', '2099-01-01 08:00:00')`, [idS]);
    const NOW = '2099-12-31 23:59:59';
    const statOf = async () => (await EFFICIENCY_LOADERS.sys(all, null, null, NOW)).find(x => x.id === idS);
    const statBefore = await statOf();
    assert.ok(statBefore && statBefore.stageHours, '[9] 统计记录存在');
    const nS = await goodNote(idS, A1, '统计前后比较');
    expectCode(await editNote(idS, nS, A1, { note_date: await today(), content: '改一次' }), 200, null, '[9] 编辑');
    expectCode(await voidNote(idS, nS, A1, { reason: '作废' }), 200, null, '[9] 作废');
    assert.deepStrictEqual(await statOf(), statBefore, '[9] 新增 / 编辑 / 作废备注前后，效率统计结果全等');
    await resume(id);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id = ?', [id])).status, '处理中', '[9] 恢复回暂缓前状态');
    ok('[9] 写备注后 last_held_at 不变，效率统计（真实统计函数）前后全等，恢复仍回到暂缓前状态');
  }

  // ══ 纯函数补充：孤立 / 异常关联不被当作原备注 ══════════════════════════
  {
    const row = { status: '已暂缓', created_by: 1 };
    const tl = [
      { id: 10, event_type: 'status_change', action_code: 'hold', to_status: '已暂缓', operator_id: 1 },
      { id: 11, event_type: 'note', action_code: 'hold_note', ref_id: null, operator_id: 1 },
      { id: 12, event_type: 'note', action_code: 'hold_note', ref_id: 11, operator_id: 1 },   // 带 ref_id 的「原备注」不算
      { id: 13, event_type: 'note', action_code: 'hold_note_void', ref_id: 12, operator_id: 1 }, // 指向非原备注的作废不生效
    ];
    assert.deepStrictEqual(I.holdNoteCapabilities(row, { id: 1, role: 'admin' }, tl).hold_note_editable_ids, [11], '[纯函数] 只认合法原备注');
    assert.strictEqual(I.holdNoteModifyVerdict(row, { id: 1, role: 'admin' }, tl, 12).code, 'HOLD_NOTE_NOT_FOUND', '[纯函数] ref_id 非空不是原备注');
    assert.strictEqual(I.findHoldAnchorId([{ id: 5, event_type: 'note', action_code: 'hold', to_status: '已暂缓' }]), null, '[纯函数] 非 status_change 的 hold 不算锚点');
    ok('[纯函数] ref_id 非空的 hold_note 不算原备注；指向非原备注的作废不生效；锚点只认 status_change');
  }

  server.close();
  console.log(`\n[全部通过] ${passed} 项 ✓ #208 暂缓单备注阶段一验收`);
}

main().catch((e) => { console.error('\n✗ 失败：', e && e.stack || e); try { server && server.close(); } catch (_) {} process.exit(1); });
