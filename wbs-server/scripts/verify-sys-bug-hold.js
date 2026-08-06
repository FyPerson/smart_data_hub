// scripts/verify-sys-bug-hold.js — S5 收口：bug 暂缓方案 §10 全 39 条测试计划的"真实缺口"补齐
//   SSOT = 系统迭代_bug暂缓_方案_20260803_v0.4.md §10（全节，39 条）
//   用法：node scripts/verify-sys-bug-hold.js
//
// ⚠️⚠️ 本文件不是"从零覆盖 §10 全部 39 条"——S1b/S2/S2b/S3/S3b2/S4/S4b 已散落覆盖了绝大多数：
//   verify-sys-bug-hold-guard.js（§5.2/§4.5/§10.2/§10.4，五角色矩阵+越权反证+冻结五路由+死锁反证）
//   verify-sys-bug-hold-notify.js（§7/§10.6，两端点负向+误发四路径+跨场景污染+子表重置+并发CAS+self-guard）
//   test-sys-bug-hold-frontend-playwright.js（§6/§10.8，类型分流+可见性矩阵+两流resume真实点击+N天角标+新409码）
//   verify-sys-flow.js（S1b 扩展，resume 审计落库+专用路由负向+校验顺序，变更流侧）
//   verify-sys-multidev-members.js（S1b 扩展，resume 降级路径三要素）
//   verify-sys-meta.js（六族双向集合断言 + reassign.from 声明侧收窄）
//   verify-sys-bug-transitions.js（bug 状态/动作集 meta 层）
//   verify-sys-pre-discuss.js（set-oa-number × bug×已暂缓 显式集外反例）
//   verify-sys-edit-window.js（edit-in-revision 冻结态负例，但其 bug 子集抽样未含已暂缓——本文件补上）
//
// 本文件只补经逐条核对后判定为**真实缺口**的条目（覆盖矩阵见交付报告），按 §10 小节分组：
//   [1] §10.1 正向流程缺口：bug hold/void/resume 空理由 400 + timeline from_status 精确值 +
//       spec 附件在暂缓期的授权边界 + 完整回环（处理中→暂缓→重启→处理中→暂缓→作废，单一 issue 连续演绎）
//   [2] §10.5 状态集负向断言缺口：7 个集合逐项显式断言「已暂缓」不在其中（此前只有六族结构性证明，
//       非逐项具名断言）+ 暂缓期 6 个动作负向（estimate/submit/set_scheduled_start/再次hold/
//       edit_in_revision/delivery附件——set-oa-number 已被 verify-sys-pre-discuss.js 覆盖，不重复）+
//       add-issues 负向（§13-4 核实为"天然禁"，按项目规则"天然禁"仍须补负向断言）
//   [3] §10.7 附件缺口：resume 成功但附件上传失败 → 状态不回滚（口径 #11 best-effort 契约的后端侧证据）
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const T = require('../routes/sys-iteration/transitions');
const SF = require('../routes/sys-iteration/status-families');

const SECRET = 'verify-sys-bug-hold-secret';
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

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // 真实临时落盘 + sendIssueDingtalkRaw stub（恒成功，非真实钉钉）
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
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// 手搓 multipart 上传（field=files，可带 attachment_type 文本域）——同 verify-sys-bug-transitions.js 范式。
function upload(id, tok, filename, attachmentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----vfy' + Date.now() + Math.random().toString(36).slice(2);
    const parts = [];
    if (attachmentType) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="attachment_type"\r\n\r\n${attachmentType}\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nfake-bytes\r\n`);
    parts.push(`--${boundary}--\r\n`);
    const data = Buffer.from(parts.join(''), 'utf8');
    const req = http.request({ host: '127.0.0.1', port, path: `/api/sys-issues/${id}/attachments`, method: 'POST', headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': data.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 造数 helper（同 verify-sys-bug-hold-guard/-notify 范式：raw SQL 直插直接构造目标态）──────────
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, assigned_at)
     VALUES (?, ?, ?, 'BMS', '内部', ?, ?, ?, datetime('now','localtime'))`,
    [type, status, extra.title || `${type}-${status}-单`, extra.createdBy || 1, extra.createdByName || '管理员', est]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueId, userId, userName, extra.isPrimary ? 1 : 0, devStatus,
     extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  return r.lastID;
}
async function setRep(issueId, userId, userName) {
  await run('UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ? WHERE id = ?', [userId, userName, issueId]);
}
async function issueRow(issueId) { return get('SELECT * FROM sys_issues WHERE id = ?', [issueId]); }
async function statusOf(issueId) { return (await issueRow(issueId)).status; }

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin','dt1'),
    (5,'dev5','开发甲','user','dt5'),(6,'dev6','开发乙','user','dt6')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务（admin1 / dev5,6）');

  // ══════════════════════════════════════════════════════════════════════
  // [1] §10.1 正向流程缺口
  // ══════════════════════════════════════════════════════════════════════
  {
    // [1a] 活跃在册开发在「处理中」hold，理由为空 → 400 HOLD_REASON_REQUIRED（第 1 条第二半，此前只有变更流
    //   侧的空理由校验被测过——verify-sys-flow.js 走的是 feature/improvement 类型；bug 类型专属从未直接断言过）。
    const id1a = await mkIssue('bug', '处理中');
    await mkMember(id1a, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1a, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id1a}/hold`, devTok(5), { reason: '   ' });
    assert.strictEqual(r.status, 400, `[1a]：bug hold 空理由应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'HOLD_REASON_REQUIRED', '[1a]：错误码 HOLD_REASON_REQUIRED');
    assert.strictEqual(await statusOf(id1a), '处理中', '[1a]：拒绝后状态未变');
    ok('[1a] §10.1#1：bug 活跃在册开发 hold 理由为空（纯空白）→ 400 HOLD_REASON_REQUIRED + 状态未变（此前仅变更流侧测过同一机制）');

    // [1b] 「已暂缓」态 void 理由为空 → 400 VOID_REASON_REQUIRED（bug 专属，此前无覆盖）。
    const id1b = await mkIssue('bug', '处理中');
    await mkMember(id1b, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1b, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id1b}/hold`, adminTok, { reason: '[1b] 暂缓准备验证 void 空理由' });
    assert.strictEqual(r.status, 200, `[1b]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id1b}/void`, adminTok, { reason: '' });
    assert.strictEqual(r.status, 400, `[1b]：bug 已暂缓态 void 空理由应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'VOID_REASON_REQUIRED', '[1b]：错误码 VOID_REASON_REQUIRED');
    assert.strictEqual(await statusOf(id1b), '已暂缓', '[1b]：拒绝后仍停在已暂缓');
    ok('[1b] §10.1#2 前半：bug「已暂缓」态 void 理由为空 → 400 VOID_REASON_REQUIRED + 状态未变（bug 专属，此前无覆盖）');

    // [1c] 「已暂缓」态 resume 理由为空 → 400 RESUME_REASON_REQUIRED（bug 专属 HTTP 层直接断言；此前该错误码
    //   只在变更流侧被测过——verify-sys-flow.js M-2 组；前端 Playwright T3 的"重启原因必填"是纯前端拦截，
    //   请求从未真正发出，不构成后端断言）。
    const id1c = await mkIssue('bug', '处理中');
    await mkMember(id1c, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1c, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id1c}/hold`, adminTok, { reason: '[1c] 暂缓准备验证 resume 空理由' });
    assert.strictEqual(r.status, 200, `[1c]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id1c}/resume`, adminTok, {});
    assert.strictEqual(r.status, 400, `[1c]：bug 已暂缓态 resume 空 body 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RESUME_REASON_REQUIRED', '[1c]：错误码 RESUME_REASON_REQUIRED');
    assert.strictEqual(await statusOf(id1c), '已暂缓', '[1c]：拒绝后仍停在已暂缓');
    ok('[1c] §10.1#2 后半：bug「已暂缓」态 resume 空 body → 400 RESUME_REASON_REQUIRED + 状态未变（后端 HTTP 层直接断言，非前端拦截替代）');

    // [1d] resume 目标态恒「处理中」+ hold 事件 timeline 行 from_status 精确为「处理中」（此前只断言过
    //   resume 响应体/落库 status==='处理中'，从未直接读取 hold 那条 timeline 行的 from_status 列值）。
    const id1d = await mkIssue('bug', '处理中');
    const da1d = await mkMember(id1d, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1d, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id1d}/hold`, adminTok, { reason: '[1d] 验证 timeline from_status' });
    assert.strictEqual(r.status, 200, `[1d]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const holdTl = await get(`SELECT from_status, to_status FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold' ORDER BY id DESC LIMIT 1`, [id1d]);
    assert.strictEqual(holdTl.from_status, '处理中', '[1d]：hold timeline 行 from_status 精确为「处理中」');
    assert.strictEqual(holdTl.to_status, '已暂缓', '[1d]：hold timeline 行 to_status 精确为「已暂缓」');
    r = await call('POST', `/api/sys-issues/${id1d}/resume`, adminTok, { reason: '[1d] 验证 resume 目标态' });
    assert.strictEqual(r.status, 200, `[1d]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[1d]：resume 响应体 status 恒为「处理中」');
    assert.strictEqual(await statusOf(id1d), '处理中', '[1d]：resume 落库 status 恒为「处理中」');
    void da1d;
    ok('[1d] §10.1#3：resume 目标态恒「处理中」+ hold timeline 行 from_status 精确为「处理中」（直接读 DB 列值，非仅响应体推断）');

    // [1e] 「已暂缓」态可上传 spec 附件（§4.6/§13-3：授权=协调人（对接人∨admin），不含在册开发；
    //   状态门=∉TERMINAL——已暂缓不在 TERMINAL 内，故非终态放行生效）。
    //   正例：admin（协调人）上传 → 200；反例：在册开发（非协调人）上传 → 403（§4.6b 已知限制的直接证据）。
    const id1e = await mkIssue('bug', '处理中');
    await mkMember(id1e, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id1e, 5, '开发甲');
    r = await call('POST', `/api/sys-issues/${id1e}/hold`, adminTok, { reason: '[1e] 暂缓准备验证附件授权边界' });
    assert.strictEqual(r.status, 200, `[1e]：hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const upAdmin = await upload(id1e, adminTok, 'evidence.png', 'spec');
    assert.strictEqual(upAdmin.status, 200, `[1e]：admin（协调人）已暂缓态上传 spec 应 200, got ${upAdmin.status} ${JSON.stringify(upAdmin.body)}`);
    const upDev = await upload(id1e, devTok(5), 'evidence2.png', 'spec');
    assert.strictEqual(upDev.status, 403, `[1e]：在册开发（非协调人）已暂缓态上传 spec 应 403, got ${upDev.status} ${JSON.stringify(upDev.body)}`);
    assert.strictEqual(upDev.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT', '[1e]：在册开发上传错误码 NOT_AUTHORIZED_FOR_ATTACHMENT');
    ok('[1e] §10.1#4：bug「已暂缓」态可上传 spec 附件——admin（协调人）200 / 在册开发（非协调人）403 NOT_AUTHORIZED_FOR_ATTACHMENT（§4.6b 已知限制的直接证据，非仅文档声明）');

    // [1f] ⭐ 完整回环（单一 issue 连续演绎，§10.1#5）：处理中 → 暂缓 → 重启 → 处理中 → 暂缓 → 作废。
    //   此前 Playwright 套件的 T3（暂缓→恢复→再暂缓）与 T5（暂缓→作废）分别在两个不同 issue 上验证，
    //   从未有一条测试把"暂缓→重启→再暂缓→作废"接成一条连续链路；本用例在后端 HTTP 层补上这条连续回环。
    const id1f = await mkIssue('bug', '处理中');
    await mkMember(id1f, 6, '开发乙', 'pending', { isPrimary: true });
    await setRep(id1f, 6, '开发乙');
    r = await call('POST', `/api/sys-issues/${id1f}/hold`, devTok(6), { reason: '[1f] 完整回环·第一次暂缓' });
    assert.strictEqual(r.status, 200, `[1f]：第一次 hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已暂缓', '[1f]：第一次 hold → 已暂缓');
    r = await call('POST', `/api/sys-issues/${id1f}/resume`, adminTok, { reason: '[1f] 完整回环·重启' });
    assert.strictEqual(r.status, 200, `[1f]：resume 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[1f]：resume → 处理中');
    r = await call('POST', `/api/sys-issues/${id1f}/hold`, adminTok, { reason: '[1f] 完整回环·第二次暂缓' });
    assert.strictEqual(r.status, 200, `[1f]：第二次 hold 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已暂缓', '[1f]：第二次 hold → 已暂缓');
    r = await call('POST', `/api/sys-issues/${id1f}/void`, adminTok, { reason: '[1f] 完整回环·作废' });
    assert.strictEqual(r.status, 200, `[1f]：void 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已作废', '[1f]：void → 已作废');
    const holdCount1f = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold'`, [id1f]);
    assert.strictEqual(holdCount1f.c, 2, '[1f]：timeline 恰有 2 条 hold 记录（两轮暂缓均留痕，非去重/覆盖）');
    ok('[1f] ⭐ §10.1#5：完整回环（单一 issue 连续演绎）处理中→暂缓→重启→处理中→暂缓→作废，全部 200 + 状态精确，timeline 留 2 条 hold 记录');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [2] §10.5 状态集负向断言缺口
  // ══════════════════════════════════════════════════════════════════════
  {
    // [2a] 方案 §4.4 表格 7 个集合逐项显式负向断言——此前 verify-sys-meta.js [7] 的"六族双向集合断言"是
    //   **结构性证明**（六族两两不相交 + 并集=ALLOWED_STATUSES），能推出「已暂缓」不可能同时落在两个基础族，
    //   但从未对每个具名集合做过"「已暂缓」∉ 该集合"这种可直接读出条目名字的断言——按任务书判定标准
    //   （"精神上相关不算覆盖，必须真的断言了那件事"），结构性证明与逐项具名断言是两回事，本组补齐后者。
    assert.ok(!SF.SYS_DEV_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_DEV_STATUSES.bug（暂缓不是开发执行态）');
    assert.ok(!SF.SYS_VERIFY_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_VERIFY_STATUSES.bug（与验收无关）');
    assert.ok(!SF.SYS_RELEASE_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_RELEASE_STATUSES.bug（暂缓单不应进发布控制族）');
    assert.ok(!SF.SYS_NONRELEASE_TERMINAL_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_NONRELEASE_TERMINAL_STATUSES.bug（暂缓非终态，纳入会关掉附件与恢复）');
    assert.ok(!SF.SYS_FROZEN_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_FROZEN_STATUSES.bug（派生族，随上两族排除自动一致）');
    assert.ok(!SF.SYS_TERMINAL_STATUSES.bug.includes('已暂缓'), '[2a] 「已暂缓」不在 SYS_TERMINAL_STATUSES.bug（派生族，同上）');
    assert.ok(!T.REQUIRES_ASSIGNEE_STATUSES.includes('已暂缓'), '[2a] 「已暂缓」不在 REQUIRES_ASSIGNEE_STATUSES（暂缓期不强制有负责人，§4.5 冻结保证实际不会变空）');
    // 附带：DEV_WORK_STATUS_BY_TYPE 单值映射侧的等价负向——isDevWorkState('bug','已暂缓') 应为 false
    //   （暂缓期 estimate/set_scheduled_start 被拒正依赖这一点，[2b] 组会走真实端点复核）。
    assert.strictEqual(T.isDevWorkState('bug', '已暂缓'), false, '[2a] isDevWorkState(bug,已暂缓)=false（DEV_WORK_STATUS_BY_TYPE.bug 仍为处理中，不含已暂缓）');
    // 正向对照（防收窄过头）：「已暂缓」确实落在 SYS_D_PRE_STATUSES.bug（附件放行必需，§4.1）。
    assert.ok(SF.SYS_D_PRE_STATUSES.bug.includes('已暂缓'), '[2a] 正向对照：「已暂缓」确实落在 SYS_D_PRE_STATUSES.bug（未被误收窄出局）');
    ok('[2a] §10.5#20：方案 §4.4 表格 7 个集合逐项显式负向断言（DEV/VERIFY/RELEASE/NONRELEASE_TERMINAL/FROZEN/TERMINAL/REQUIRES_ASSIGNEE_STATUSES 均不含「已暂缓」+ isDevWorkState 单值映射负向 + D_PRE 正向对照）；OA 允许集已由 verify-sys-pre-discuss.js 的运行时 409 断言覆盖，本组不重复造）');

    // [2b] 暂缓期 6 个动作全部拒绝（§10.5#21，跳过 set-oa-number——已被 verify-sys-pre-discuss.js 显式覆盖）。
    //   每个子用例独立造一张「已暂缓」单，只测该动作本身，避免互相干扰。
    {
      // estimate：SF.isW06Allowed('estimate','bug','已暂缓') 为 false → 409 ESTIMATE_STATUS_INVALID
      const idEst = await mkIssue('bug', '处理中');
      await mkMember(idEst, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idEst, 5, '开发甲');
      let r = await call('POST', `/api/sys-issues/${idEst}/hold`, adminTok, { reason: '[2b-estimate] 暂缓准备' });
      assert.strictEqual(r.status, 200, `[2b-estimate]：hold 200, got ${r.status}`);
      r = await call('POST', `/api/sys-issues/${idEst}/estimate`, devTok(5), { dev_estimated_at: futureEst(10) });
      assert.strictEqual(r.status, 409, `[2b-estimate]：已暂缓态 estimate 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ESTIMATE_STATUS_INVALID', '[2b-estimate]：错误码 ESTIMATE_STATUS_INVALID');

      // submit：SF.isInFamily('bug','已暂缓','DEV') 为 false → 409 INVALID_STATUS
      const idSub = await mkIssue('bug', '处理中');
      await mkMember(idSub, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idSub, 5, '开发甲');
      r = await call('POST', `/api/sys-issues/${idSub}/hold`, adminTok, { reason: '[2b-submit] 暂缓准备' });
      assert.strictEqual(r.status, 200, `[2b-submit]：hold 200, got ${r.status}`);
      r = await call('POST', `/api/sys-issues/${idSub}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '尝试在暂缓期提交', self_tested: true, test_env_deployed: true });
      assert.strictEqual(r.status, 409, `[2b-submit]：已暂缓态 submit 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_STATUS', '[2b-submit]：错误码 INVALID_STATUS');

      // set_scheduled_start：T.isDevWorkState('bug','已暂缓') 为 false → 409 SCHEDULED_START_STATUS_INVALID
      const idSched = await mkIssue('bug', '处理中');
      await mkMember(idSched, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idSched, 5, '开发甲');
      r = await call('POST', `/api/sys-issues/${idSched}/hold`, adminTok, { reason: '[2b-sched] 暂缓准备' });
      assert.strictEqual(r.status, 200, `[2b-sched]：hold 200, got ${r.status}`);
      r = await call('POST', `/api/sys-issues/${idSched}/set-scheduled-start`, adminTok, { scheduled_start: '2026-09-01' });
      assert.strictEqual(r.status, 409, `[2b-sched]：已暂缓态 set-scheduled-start 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SCHEDULED_START_STATUS_INVALID', '[2b-sched]：错误码 SCHEDULED_START_STATUS_INVALID');

      // 再次 hold：hold.from=['处理中'] 唯一，已暂缓态再 hold → 400 INVALID_TRANSITION（同 close/reopen 待上线态同构判例）
      const idRehold = await mkIssue('bug', '处理中');
      await mkMember(idRehold, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idRehold, 5, '开发甲');
      r = await call('POST', `/api/sys-issues/${idRehold}/hold`, adminTok, { reason: '[2b-rehold] 第一次暂缓' });
      assert.strictEqual(r.status, 200, `[2b-rehold]：第一次 hold 200, got ${r.status}`);
      r = await call('POST', `/api/sys-issues/${idRehold}/hold`, adminTok, { reason: '[2b-rehold] 尝试再次暂缓' });
      assert.strictEqual(r.status, 400, `[2b-rehold]：已暂缓态再次 hold 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '[2b-rehold]：错误码 INVALID_TRANSITION（hold.from 唯一处理中，不含已暂缓）');
      const holdCountRehold = await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='hold'`, [idRehold]);
      assert.strictEqual(holdCountRehold.c, 1, '[2b-rehold]：拒绝后 timeline 仍只有 1 条 hold 记录（无重复写入）');

      // edit_in_revision：EDIT_TIER_*_BUG 硬编码数组不含「已暂缓」→ 409 EDIT_STATUS_INVALID（bug 类型专属；
      //   verify-sys-edit-window.js [③] 组的 bug 子集抽样是 ['待验证','已关闭']，从未含已暂缓——本组补齐这一具体空档，
      //   而非依赖该文件汇总行文案里"含已暂缓"字样的误导性表述，那行实际指的是同组 feature 循环）。
      const idEdit = await mkIssue('bug', '处理中');
      await mkMember(idEdit, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idEdit, 5, '开发甲');
      r = await call('POST', `/api/sys-issues/${idEdit}/hold`, adminTok, { reason: '[2b-edit] 暂缓准备' });
      assert.strictEqual(r.status, 200, `[2b-edit]：hold 200, got ${r.status}`);
      r = await call('POST', `/api/sys-issues/${idEdit}/edit-in-revision`, adminTok, { title: '尝试在暂缓期编辑' });
      assert.strictEqual(r.status, 409, `[2b-edit]：已暂缓态 edit-in-revision 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'EDIT_STATUS_INVALID', '[2b-edit]：错误码 EDIT_STATUS_INVALID');

      // delivery 附件：isInFamily(DEV)||isInFamily(VERIFY) 均不含「已暂缓」→ 409 INVALID_STATE_FOR_ATTACHMENT
      const idDeliv = await mkIssue('bug', '处理中');
      await mkMember(idDeliv, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idDeliv, 5, '开发甲');
      r = await call('POST', `/api/sys-issues/${idDeliv}/hold`, adminTok, { reason: '[2b-deliv] 暂缓准备' });
      assert.strictEqual(r.status, 200, `[2b-deliv]：hold 200, got ${r.status}`);
      const upDeliv = await upload(idDeliv, adminTok, 'proof.png', 'delivery');
      assert.strictEqual(upDeliv.status, 409, `[2b-deliv]：已暂缓态上传 delivery 应 409, got ${upDeliv.status} ${JSON.stringify(upDeliv.body)}`);
      assert.strictEqual(upDeliv.body.code, 'INVALID_STATE_FOR_ATTACHMENT', '[2b-deliv]：错误码 INVALID_STATE_FOR_ATTACHMENT（DEV∪VERIFY 族门，已暂缓不在内）');

      ok('[2b] §10.5#21：暂缓期 6 动作全部拒绝——estimate(409 ESTIMATE_STATUS_INVALID)/submit(409 INVALID_STATUS)/set_scheduled_start(409 SCHEDULED_START_STATUS_INVALID)/再次hold(400 INVALID_TRANSITION，timeline 未重复写入)/edit_in_revision(409 EDIT_STATUS_INVALID，bug 类型专属，此前 bug 子集抽样未覆盖此态)/delivery附件(409 INVALID_STATE_FOR_ATTACHMENT)（set-oa-number 已由 verify-sys-pre-discuss.js 覆盖，不重复造）');
    }

    // [2c] 暂缓单不能加入上线批次 add-issues（§10.5#22·§13-4 核实为"天然禁"：add-issues 硬编码
    //   WHERE status='待上线' AND release_id IS NULL，changes!==1 即 409——按项目规则"天然禁=现有机制已拦住
    //   （零代码），但必须写负向断言"，此前从未有任何脚本对这一具体组合写过断言，纯粹依赖文档声明）。
    {
      const idAdd = await mkIssue('bug', '处理中');
      await mkMember(idAdd, 5, '开发甲', 'pending', { isPrimary: true });
      await setRep(idAdd, 5, '开发甲');
      let r = await call('POST', `/api/sys-issues/${idAdd}/hold`, adminTok, { reason: '[2c] 暂缓准备验证 add-issues 拒绝' });
      assert.strictEqual(r.status, 200, `[2c]：hold 200, got ${r.status}`);
      const rel = await call('POST', '/api/sys-releases', adminTok, {});
      assert.strictEqual(rel.status, 201, `[2c]：建批次 201, got ${rel.status} ${JSON.stringify(rel.body)}`);
      r = await call('POST', `/api/sys-releases/${rel.body.id}/add-issues`, adminTok, { issue_ids: [idAdd] });
      assert.strictEqual(r.status, 409, `[2c]：已暂缓单 add-issues 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE', '[2c]：错误码 ISSUE_NOT_ADDABLE');
      assert.strictEqual(await statusOf(idAdd), '已暂缓', '[2c]：拒绝后仍停在已暂缓（release_id 未被写入）');
      const releaseIdAfter = (await issueRow(idAdd)).release_id;
      assert.strictEqual(releaseIdAfter, null, '[2c]：release_id 确未被写入');
      ok('[2c] §10.5#22：暂缓单不能加入上线批次——add-issues → 409 ISSUE_NOT_ADDABLE（§13-4 核实"天然禁"的负向断言补齐，release_id 确未写入）');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [3] §10.7 附件缺口
  // ══════════════════════════════════════════════════════════════════════
  {
    // resume 成功但随后附件上传失败（错误扩展名）→ 状态仍为「处理中」，不回滚（口径 #11·§10.7#35）。
    //   两步链是前端职责（先 JSON resume、再 FormData 上传），后端两个端点彼此独立、无补偿事务——
    //   本用例在后端 HTTP 层直接证明这一契约：resume 的效果不会因为后续一次独立的上传失败而被撤销。
    const id35 = await mkIssue('bug', '处理中');
    await mkMember(id35, 5, '开发甲', 'pending', { isPrimary: true });
    await setRep(id35, 5, '开发甲');
    let r = await call('POST', `/api/sys-issues/${id35}/hold`, adminTok, { reason: '[35] 暂缓准备验证两步链不回滚' });
    assert.strictEqual(r.status, 200, `[35]：hold 200, got ${r.status}`);
    r = await call('POST', `/api/sys-issues/${id35}/resume`, adminTok, { reason: '[35] 验证 resume 成功后上传失败不回滚' });
    assert.strictEqual(r.status, 200, `[35]：resume 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[35]：resume 成功，落点处理中');
    // 上传坏扩展名（.exe，不在 SYS_ALLOWED_EXTS 白名单）→ 400，multer fileFilter 防线。
    const upBad = await upload(id35, adminTok, 'evidence.exe', 'spec');
    assert.strictEqual(upBad.status, 400, `[35]：坏扩展名上传应 400（不影响已生效的 resume）, got ${upBad.status} ${JSON.stringify(upBad.body)}`);
    // 核心断言：resume 已生效的状态未被这次独立的上传失败撤销（口径 #11 best-effort，非回滚设计）。
    assert.strictEqual(await statusOf(id35), '处理中', '[35]：⭐ 上传失败后 issue 状态仍为「处理中」（resume 效果未被撤销，两步链不回滚）');
    const attCount35 = await get('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [id35]);
    assert.strictEqual(attCount35.c, 0, '[35]：坏文件确未落库为附件（fileFilter 在写入前拦截）');
    ok('[35] ⭐ §10.7#35：resume 成功但后续附件上传失败（坏扩展名 400）→ issue 状态仍为「处理中」，不回滚（口径 #11 best-effort 契约的后端侧证据；MIME 白名单拒绝复用 verify-sys-attachments.js A9 同一防线，此处验证的是"两步链不回滚"这一新组合，非重复测 MIME 本身）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ bug 暂缓方案 S5 §10 缺口收口验证通过`);
  console.log('  覆盖：[1]§10.1正向流程缺口(bug hold/void/resume空理由400+timeline from_status精确值+spec附件授权边界+完整回环) + [2]§10.5状态集负向断言缺口(7集合逐项显式断言+暂缓期6动作拒绝+add-issues拒绝) + [3]§10.7附件缺口(resume成功但上传失败不回滚)');
  server.close();
  db.close();
}

main().catch((err) => {
  console.error('\n[失败]', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  try { server && server.close(); } catch (_) {}
  process.exitCode = 1;
});
