// scripts/verify-sys-submit-amend.js — C3 验收：开发提交原地修正（POST /sys-issues/:id/submit/amend）
//   SSOT = 方案 docs/local/系统迭代/提交修正与config指派OA守卫_方案_20260909_v1.5.md §B（B.2 D5-D12/
//   B.3 四格契约表/B.4 事务七步/B.5 版本锁/B.6 读者核查表/B.8 验证矩阵）
//   用法：SYS_TEST_HOOKS=1 由本文件自行设置（先于 require 路由模块），直接 `node scripts/verify-sys-submit-amend.js`
//
// in-process app + 内存库 + 自签 token，同 verify-sys-multidev-submit.js 范式。夹具一律走真实 HTTP 端点
// （建单直连 SQL + POST /submit 拿到真实 submit/no_code 事件），不直接 SQL 伪造 dev_status/事件——amend
// 端点的"三源读取"依赖真实存在的最新事件行，直连 SQL 伪造会绕过这条不变量本身。
'use strict';

process.env.SYS_TEST_HOOKS = '1';   // 必须在 require 路由模块之前设置——SYS_TEST_HOOKS_ENABLED 是模块加载时求值一次的常量

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-submit-amend-secret';
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
// [C3c·M5·538 回卷] 真实附件上传端点（multipart），同 verify-sys-multidev-attachments.js upload() 范式——
// 版本锁组附件用例改走本函数，不再直连 SQL 伪造附件行绕过 sysPersistAttachments 的 recheckFn 校验。
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
function upload(p, tok, fields, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysSubmitAmendBoundary' + (p.length * 7919 + Date.now());
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(PNG_BYTES); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}

let passed = 0;
const failDetails = [];
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function must(cond, msg) {
  if (cond) { ok(msg); } else { console.log('  ✗ ' + msg); failDetails.push(msg); }
  return cond;
}

function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 夹具 ──────────────────────────────────────────────────────────────
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, estimated_effort_days, intake_liaison_id)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, 13)`,
    [type, status, extra.title || `${type}-${status}-单`, est, effort]
  );
  return r.lastID;
}
async function mkPending(issueId, userId, userName) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
    [issueId, userId, userName]
  );
  return r.lastID;
}
async function memberRowOf(issueId, userId) {
  return get(`SELECT * FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [issueId, userId]);
}
async function latestEventOf(daId) {
  return get(`SELECT id, action, payload_json, created_at FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daId]);
}
async function commitsOf(daId) {
  return all(`SELECT id, component, commit_ref FROM sys_issue_dev_commits WHERE dev_assignee_id=? ORDER BY id`, [daId]);
}
// 部分夹具刻意用直连 SQL 把状态硬改成"结构上不自洽"的态（如 D_PRE/FROZEN 族门探针，团队并未真正完成/
// 清空即被打上「已上线」），只为测族门本身、不代表真实业务路径能到达——事后必须整单清理，否则会永久
// 污染 P14/P15 等"全库扫描"型探针，殃及后续所有 selfCertifyProbes 调用（本文件全程共用一个 :memory: 库）。
async function deleteIssueFully(issueId) {
  await run(`DELETE FROM sys_issue_dev_events WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_dev_commits WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_attachments WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [issueId]);
  await run(`DELETE FROM sys_issues WHERE id=?`, [issueId]);
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  must(failed.length === 0, `${label}：应满足全部 P1-P16 恒真，实际失败：${JSON.stringify(failed)}`);
  return results;
}

// [重要口径] feature 单人团队全完成后 W-GATE 会自动推进到「待对接测试」（LIAISON_TEST 族，非 VERIFY）——
// bug/improvement 无此中转态，单人全完成直接到「待验证」（VERIFY 族）。故：
//   · 需要"仍停在 DEV 族"的夹具（准入组 DEV 族、移出重加入等）：extra.keepInDev=true 额外加一名
//     不提交的搭子（userId+1000，永远 pending），使团队"未全完成"，主状态天然停在 DEV 族。
//   · 需要"落到 VERIFY 族"的夹具：用 bug/improvement 单人团队（不传 keepInDev）。
//   · 需要"落到 LIAISON_TEST 族"的夹具：用 feature 单人团队（不传 keepInDev），天然到「待对接测试」。
// 建 code_submitted 实例：pending → 真实 /submit(mode=commits) → 返回 {issueId, daId, userId, tok}
async function mkCommitsSubmitted(type, status, userId, extra = {}) {
  const issueId = extra.issueId || await mkIssue(type, status, extra);
  if (extra.keepInDev) await mkPending(issueId, userId + 1000, `搭子${userId}`);
  await mkPending(issueId, userId, `开发${userId}`);
  const tok = devTok(userId);
  const body = { mode: 'commits', commits: extra.commits || [{ component: 'backend', commit_ref: `svn-${issueId}-${userId}` }], self_tested: true, test_env_deployed: true };
  if (type === 'bug') body.bug_cause_note = 'verify 夹具：bug 产生原因';
  const r = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
  if (r.status !== 200) throw new Error(`[夹具-commits 提交] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const daId = r.body.dev_assignee_id;
  return { issueId, daId, userId, tok };
}
// 建 no_code 实例
async function mkNoCodeSubmitted(type, status, userId, extra = {}) {
  const issueId = extra.issueId || await mkIssue(type, status, extra);
  if (extra.keepInDev) await mkPending(issueId, userId + 1000, `搭子${userId}`);
  await mkPending(issueId, userId, `开发${userId}`);
  const tok = devTok(userId);
  const reason = extra.reason || (type === 'config' ? '配置已在测试环境验证完成，符合上线要求' : 'verify 夹具：无代码交付说明');
  const body = { mode: 'no_code', no_code_reason: reason, self_tested: true, test_env_deployed: true };
  if (type === 'bug') body.bug_cause_note = 'verify 夹具：bug 产生原因';
  const r = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
  if (r.status !== 200) throw new Error(`[夹具-no_code 提交] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const daId = r.body.dev_assignee_id;
  return { issueId, daId, userId, tok };
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev5','开发甲','user','13800000005'),
    (6,'dev6','开发乙','user','13800000006'),(13,'liaison13','示例对接人','user','19900000024')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务（SYS_TEST_HOOKS=1）');
  must(!!I.__testHooks, '_internals.__testHooks 已导出（供后续回滚组注入）');
  must(typeof I.computeDeliveryRev === 'function', '_internals.computeDeliveryRev 已导出（供版本锁组核对四处调用点同源）');

  // ══════════════════════════════════════════════════════════════════════
  // 【准入组】
  // ══════════════════════════════════════════════════════════════════════
  {
    // DEV 族：bug 双人团队，5 提交 commits、搭子（1005）留 pending，主状态停在「处理中」（DEV 族）。
    const { issueId, tok } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '补充说明' });
    must(r.status === 200, `[准入] DEV 族 code_submitted amend 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    must(r.body.amend_no === 1, `[准入] 首次修正 amend_no=1，实得=${r.body.amend_no}`);
    must(typeof r.body.delivery_rev === 'string' && /^e\d+-a\d+-n\d+$/.test(r.body.delivery_rev), `[准入] 响应含合法 delivery_rev，实得=${JSON.stringify(r.body.delivery_rev)}`);
  }
  {
    // VERIFY 族：improvement 单人团队，no_code 提交后 W-GATE 全完成自动进「待验证」（improvement 无
    // LIAISON_TEST 中转态，不同于 feature）。
    const { issueId, tok } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const detail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detail.body.issue.status === '待验证', `[准入] improvement 单人团队 no_code 提交后 W-GATE 应自动进「待验证」，实得=${detail.body.issue.status}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: 'VERIFY 族修正后的新说明，长度已过10字' });
    must(r.status === 200, `[准入] VERIFY 族 no_code amend 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // [D-L1·2026-09-10 决策记录] 待对接测试（feature 独有）——单人团队全完成后 W-GATE 天然自动进
    // 「待对接测试」（LIAISON_TEST 族，非 DEV/VERIFY），不需手工 UPDATE。推翻 v1.5 原「LIAISON_TEST
    // 锁死」已决点后应 200；主状态/cycle_no/watermark 三者不变，事件 +1（决策记录 §5 验证矩阵首行）。
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5);
    const detail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detail.body.issue.status === '待对接测试', `[准入] 夹具前置：feature 单人团队提交后应天然到「待对接测试」，实得=${detail.body.issue.status}`);
    const before = await get(`SELECT status, liaison_test_cycle_no, liaison_test_attachment_watermark FROM sys_issues WHERE id=?`, [issueId]);
    const eventsBefore = await all(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=?`, [daId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '待对接测试态修正（D-L1）' });
    must(r.status === 200, `[准入·D-L1] 待对接测试态 amend 应 200（推翻 v1.5 锁死）, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await get(`SELECT status, liaison_test_cycle_no, liaison_test_attachment_watermark FROM sys_issues WHERE id=?`, [issueId]);
    must(after.status === before.status, `[准入·D-L1] 主状态不变（D-L2），前=${before.status}，后=${after.status}`);
    must(after.liaison_test_cycle_no === before.liaison_test_cycle_no, `[准入·D-L1] liaison_test_cycle_no 不变（D-L2），前=${before.liaison_test_cycle_no}，后=${after.liaison_test_cycle_no}`);
    must(after.liaison_test_attachment_watermark === before.liaison_test_attachment_watermark, `[准入·D-L1] liaison_test_attachment_watermark 不变（D-L2），前=${before.liaison_test_attachment_watermark}，后=${after.liaison_test_attachment_watermark}`);
    const eventsAfter = await all(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=?`, [daId]);
    must(eventsAfter.length === eventsBefore.length + 1, `[准入·D-L1] 事件 +1，前=${eventsBefore.length}，后=${eventsAfter.length}`);
  }
  {
    // [D-L1·决策记录 §5] 待上线（RELEASE 族）——负向对照，防集合扩容后无人盯 STATE 守卫（族矩阵仍不含
    // RELEASE，只是 LIAISON_TEST 从锁死改放开，不代表连带放开了别的族）。断言后整单清理（同 D_PRE/
    // FROZEN 两组同款范式，防污染全库扫描型探针）。
    const { issueId, tok } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: 'x' });
    must(r.status === 409 && r.body.code === 'INVALID_STATUS', `[准入] 待上线态 amend 应 409 INVALID_STATUS（负向对照）, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // D_PRE（bug 的 D_PRE 态标签是「待处理」，非「待指派」——后者是 feature/improvement 的标签，
    // status-families.js SYS_D_PRE_STATUSES.bug=['待处理','已暂缓']）。提交成功后手工 UPDATE 覆盖，
    // 只测族门本身；断言后整单清理，防污染 P14/P15 等全库扫描型探针（该单团队"未真正完成"却被强改成
    // 已完成态族的状态字符串，结构上不自洽，不能留在库里）。
    const { issueId, tok } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    await run(`UPDATE sys_issues SET status='待处理' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: 'x' });
    must(r.status === 409 && r.body.code === 'INVALID_STATUS', `[准入] D_PRE（待处理）态 amend 应 409 INVALID_STATUS, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // FROZEN（已上线）——同上，断言后整单清理。
    const { issueId, tok } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    await run(`UPDATE sys_issues SET status='已上线' WHERE id=?`, [issueId]);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: 'x' });
    must(r.status === 409 && r.body.code === 'INVALID_STATUS', `[准入] FROZEN（已上线）态 amend 应 409 INVALID_STATUS, got ${r.status} ${JSON.stringify(r.body)}`);
    await deleteIssueFully(issueId);
  }
  {
    // 本人 pending（未提交过）
    const issueId = await mkIssue('bug', '处理中');
    await mkPending(issueId, 5, '开发甲');
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, devTok(5), { mode: 'commits', work_note: 'x' });
    must(r.status === 409 && r.body.code === 'INVALID_STATUS', `[准入] 本人 pending（未提交过）amend 应 409 INVALID_STATUS, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // 非在册
    const { issueId } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, devTok(999), { mode: 'commits', work_note: 'x' });
    must(r.status === 403 && r.body.code === 'NOT_ROSTERED', `[准入] 非在册 amend 应 403 NOT_ROSTERED, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // 移出再加入后修正：只动新实例，旧实例事件链不变（bug 双人团队全程停在 DEV 族「处理中」）。
    const { issueId, daId: oldDaId } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    const oldLatest = await latestEventOf(oldDaId);
    await run(`UPDATE sys_issue_dev_assignees SET removed_at=datetime('now','localtime') WHERE id=?`, [oldDaId]);
    const { daId: newDaId } = await mkCommitsSubmitted('bug', '处理中', 5, { issueId });
    must(Number(newDaId) !== Number(oldDaId), `[准入] 重新加入应产生新实例 id（旧=${oldDaId}，新=${newDaId}）`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, devTok(5), { mode: 'commits', work_note: '新实例的修正' });
    must(r.status === 200, `[准入] 新实例 amend 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const oldLatestAfter = await latestEventOf(oldDaId);
    must(oldLatestAfter.id === oldLatest.id, `[准入] 旧实例事件链未被本次 amend 影响（事件 id 不变：${oldLatest.id}）`);
  }
  // ══════════════════════════════════════════════════════════════════════
  // 【B.6 四字段组】（C3b·M1）：普通提交行 amend_no=0/changed=[]/amended_at=null/first_submitted_at=
  // resolved_at；一次 amend 后 amend_no=1/changed 含预期维度/amended_at 非空/first_submitted_at 不变。
  // ══════════════════════════════════════════════════════════════════════
  {
    const { issueId, daId, tok } = await mkCommitsSubmitted('bug', '处理中', 5, { keepInDev: true });
    const detailBefore = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    const rowBefore = detailBefore.body.dev_assignees.find(d => d.id === daId);
    must(!!rowBefore, '[B.6] 夹具前置：详情 dev_assignees 应含目标实例');
    must(rowBefore.amend_no === 0, `[B.6] 普通提交行 amend_no 应为 0，实得=${rowBefore.amend_no}`);
    must(Array.isArray(rowBefore.changed) && rowBefore.changed.length === 0, `[B.6] 普通提交行 changed 应为空数组，实得=${JSON.stringify(rowBefore.changed)}`);
    must(rowBefore.amended_at === null, `[B.6] 普通提交行 amended_at 应为 null，实得=${rowBefore.amended_at}`);
    must(!!rowBefore.first_submitted_at && rowBefore.first_submitted_at === rowBefore.resolved_at, `[B.6] 普通提交行 first_submitted_at 应等于 resolved_at，实得 first=${rowBefore.first_submitted_at}，resolved=${rowBefore.resolved_at}`);

    const amendR = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: 'B.6 四字段夹具' });
    must(amendR.status === 200, `[B.6] 夹具前置：amend 应 200, got ${amendR.status} ${JSON.stringify(amendR.body)}`);
    const detailAfter = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    const rowAfter = detailAfter.body.dev_assignees.find(d => d.id === daId);
    must(rowAfter.amend_no === 1, `[B.6] 修正后 amend_no 应为 1，实得=${rowAfter.amend_no}`);
    must(Array.isArray(rowAfter.changed) && rowAfter.changed.includes('work_note'), `[B.6] 修正后 changed 应含预期维度 work_note，实得=${JSON.stringify(rowAfter.changed)}`);
    must(!!rowAfter.amended_at, `[B.6] 修正后 amended_at 应非空，实得=${rowAfter.amended_at}`);
    must(rowAfter.first_submitted_at === rowBefore.first_submitted_at, `[B.6] 修正不改变 first_submitted_at，修正前=${rowBefore.first_submitted_at}，修正后=${rowAfter.first_submitted_at}`);
  }
  await selfCertifyProbes('[B.6 四字段组收尾]');

  await selfCertifyProbes('[准入组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【契约组】四格 + config + 字段边界 + null/多余键/全同值
  // ══════════════════════════════════════════════════════════════════════
  {
    // commits→commits 带 commits → 400
    const { issueId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true });
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'nope' }] });
    must(r.status === 400 && r.body.code === 'VALIDATION', `[契约] commits→commits 带 commits 应 400 VALIDATION, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // no_code→commits 无 commits → 400；带 1 条 → 200，dev_status=code_submitted，reason NULL，commit 行 1
    const { issueId, daId, tok } = await mkNoCodeSubmitted('feature', '开发中', 5, { keepInDev: true });
    const r1 = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits' });
    must(r1.status === 400 && r1.body.code === 'VALIDATION', `[契约] no_code→commits 无 commits 应 400 VALIDATION, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'switch-to-commits' }] });
    must(r2.status === 200, `[契约] no_code→commits 带 1 条应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const row = await get('SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE id=?', [daId]);
    must(row.dev_status === 'code_submitted', `[契约] 切至 commits 后 dev_status=code_submitted，实得=${row.dev_status}`);
    must(row.no_code_reason === null, `[契约] 切至 commits 后 no_code_reason 应为 NULL，实得=${row.no_code_reason}`);
    const rows = await commitsOf(daId);
    must(rows.length === 1 && rows[0].commit_ref === 'switch-to-commits', `[契约] commit 行应恰 1 条且为新填值，实得=${JSON.stringify(rows)}`);
  }
  {
    // commits→no_code：dev_status=no_code，commit 行 0，delete-commit 事件 N 条带 via，P4/P11/P16 绿
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true, commits: [{ component: 'backend', commit_ref: 'a' }, { component: 'frontend', commit_ref: 'b' }] });
    const before = await commitsOf(daId);
    must(before.length === 2, `[契约] 夹具前置：commits→no_code 前应有 2 条 commit 行，实得=${before.length}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '切换为无代码交付的原因说明，已过10字' });
    must(r.status === 200, `[契约] commits→no_code 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT dev_status, no_code_reason FROM sys_issue_dev_assignees WHERE id=?', [daId]);
    must(row.dev_status === 'no_code', `[契约] 切至 no_code 后 dev_status=no_code，实得=${row.dev_status}`);
    const after = await commitsOf(daId);
    must(after.length === 0, `[契约] 切至 no_code 后 commit 行应为 0，实得=${after.length}`);
    const delEvents = await all(`SELECT reason, payload_json FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action='delete-commit' ORDER BY id`, [daId]);
    must(delEvents.length === 2, `[契约] 应写 2 条 delete-commit 事件，实得=${delEvents.length}`);
    for (const e of delEvents) {
      must(e.reason === '提交修正：切换为无代码交付', `[契约] delete-commit reason 精确文案，实得=${e.reason}`);
      const p = JSON.parse(e.payload_json);
      must(p.via === 'amend_mode_switch' && p.amend_no === 1 && p.dev_assignee_id === daId && typeof p.commit_id === 'number' && typeof p.component === 'string' && typeof p.commit_ref === 'string',
        `[契约] delete-commit payload 形状精确（via/amend_no/commit_id/component/commit_ref/dev_assignee_id 五键），实得=${e.payload_json}`);
    }
    await selfCertifyProbes('[契约组 commits→no_code 后]');
  }
  {
    // config 切 commits → 400 CONFIG_NO_COMMITS
    const { issueId, tok } = await mkNoCodeSubmitted('config', '处理中', 5);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'x' }] });
    must(r.status === 400 && r.body.code === 'CONFIG_NO_COMMITS', `[契约] config 切 commits 应 400 CONFIG_NO_COMMITS, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // config reason 9 码点 / 10 码点
    const { issueId: id9, tok: tok9 } = await mkNoCodeSubmitted('config', '处理中', 5);
    const r9 = await call('POST', `/api/sys-issues/${id9}/submit/amend`, tok9, { mode: 'no_code', no_code_reason: '123456789' });
    must(r9.status === 400 && r9.body.code === 'VALIDATION', `[契约] config 9 码点应 400 VALIDATION, got ${r9.status} ${JSON.stringify(r9.body)}`);
    const { issueId: id10, tok: tok10 } = await mkNoCodeSubmitted('config', '处理中', 5);
    const r10 = await call('POST', `/api/sys-issues/${id10}/submit/amend`, tok10, { mode: 'no_code', no_code_reason: '1234567890' });
    must(r10.status === 200, `[契约] config 10 码点应 200, got ${r10.status} ${JSON.stringify(r10.body)}`);
  }
  {
    // work_note 1000 / 1001 码点；空串清除
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true });
    const r1000 = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '字'.repeat(1000) });
    must(r1000.status === 200, `[契约] work_note 1000 码点应 200, got ${r1000.status} ${JSON.stringify(r1000.body)}`);
    const { issueId: id2, tok: tok2 } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true });
    const r1001 = await call('POST', `/api/sys-issues/${id2}/submit/amend`, tok2, { mode: 'commits', work_note: '字'.repeat(1001) });
    must(r1001.status === 400 && r1001.body.code === 'VALIDATION', `[契约] work_note 1001 码点应 400 VALIDATION, got ${r1001.status} ${JSON.stringify(r1001.body)}`);
    // 空串清除：先写非空，再传空串验证快照 work_note 键消失
    const latestBefore = await latestEventOf(daId);
    must(JSON.parse(latestBefore.payload_json).work_note !== undefined, '[契约] 夹具前置：修正前 work_note 键应存在');
    const rClear = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '' });
    must(rClear.status === 200, `[契约] work_note 空串清除应 200, got ${rClear.status} ${JSON.stringify(rClear.body)}`);
    const latestAfter = await latestEventOf(daId);
    const afterPayload = JSON.parse(latestAfter.payload_json);
    must(afterPayload.work_note === undefined, `[契约] work_note 空串清除后快照不含该键（仅有值时加键），实得=${JSON.stringify(afterPayload.work_note)}`);
  }
  {
    // null 字段 / 多余键 / 全同值
    const { issueId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true });
    const rNull = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: null });
    must(rNull.status === 400 && rNull.body.code === 'VALIDATION', `[契约] work_note:null 应 400 VALIDATION, got ${rNull.status} ${JSON.stringify(rNull.body)}`);
    const rExtra = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', extra_field: 1 });
    must(rExtra.status === 400 && rExtra.body.code === 'VALIDATION', `[契约] 多余字段应 400 VALIDATION, got ${rExtra.status} ${JSON.stringify(rExtra.body)}`);
    const rSame = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits' });
    must(rSame.status === 400 && rSame.body.code === 'VALIDATION' && /无变化/.test(rSame.body.error), `[契约] 全同值（无任何字段变化）应 400 VALIDATION「无变化」, got ${rSame.status} ${JSON.stringify(rSame.body)}`);
  }
  await selfCertifyProbes('[契约组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【快照组】
  // ══════════════════════════════════════════════════════════════════════
  {
    // 先 PUT 改 commit → 再 amend work_note → 快照 commits 为改后值
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true, commits: [{ component: 'backend', commit_ref: 'orig-ref' }] });
    const rows = await commitsOf(daId);
    const commitId = rows[0].id;
    const put = await call('PUT', `/api/sys-issues/${issueId}/dev/commits/${commitId}`, tok, { component: 'backend', commit_ref: 'edited-ref' });
    must(put.status === 200, `[快照] 夹具前置：PUT 改 commit 应 200, got ${put.status} ${JSON.stringify(put.body)}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '只改说明不动 commits' });
    must(r.status === 200, `[快照] amend work_note 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const latest = await latestEventOf(daId);
    const payload = JSON.parse(latest.payload_json);
    must(Array.isArray(payload.commits) && payload.commits.length === 1 && payload.commits[0].commit_ref === 'edited-ref',
      `[快照] 快照 commits 应反映 PUT 后的最新值（edited-ref），实得=${JSON.stringify(payload.commits)}`);
  }
  {
    // no_code→commits 带 3 条 commit → 快照 commits 含全部 3 个新生成的 commit_id
    const { issueId, daId, tok } = await mkNoCodeSubmitted('feature', '开发中', 5, { keepInDev: true });
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }, { component: 'backend', commit_ref: 'r2' }, { component: 'frontend', commit_ref: 'r3' }],
    });
    must(r.status === 200, `[快照] no_code→commits 带 3 条应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const dbRows = await commitsOf(daId);
    must(dbRows.length === 3, `[快照] 库内应恰 3 条 commit 行，实得=${dbRows.length}`);
    const latest = await latestEventOf(daId);
    const payload = JSON.parse(latest.payload_json);
    const dbIds = new Set(dbRows.map(r2 => r2.id));
    const payloadIds = payload.commits.map(c => c.commit_id);
    must(payloadIds.length === 3 && payloadIds.every(id => dbIds.has(id)), `[快照] 快照 commits 含全部 3 个新生成的 commit_id（击穿"复用写前空集合"变异），实得=${JSON.stringify(payload.commits)}，库内 id 集=${JSON.stringify([...dbIds])}`);
  }
  await selfCertifyProbes('[快照组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【版本锁组】
  // ══════════════════════════════════════════════════════════════════════
  {
    // 修正后 admin accept 带旧 expected_delivery_rev → 409 DELIVERY_CHANGED；带新值 → 200；不带 → 200（对照）
    const { issueId, tok } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const detailBefore = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detailBefore.status === 200 && typeof detailBefore.body.issue.delivery_rev === 'string', `[版本锁] 详情端应带合法 delivery_rev, got ${JSON.stringify(detailBefore.body.issue && detailBefore.body.issue.delivery_rev)}`);
    const oldRev = detailBefore.body.issue.delivery_rev;
    const amendR = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '版本锁夹具：修正后的新说明' });
    must(amendR.status === 200, `[版本锁] 夹具前置：amend 应 200, got ${amendR.status} ${JSON.stringify(amendR.body)}`);
    const newRev = amendR.body.delivery_rev;
    must(newRev !== oldRev, `[版本锁] amend 后 delivery_rev 应变化（旧=${oldRev}，新=${newRev}）`);
    const acceptOld = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: oldRev });
    must(acceptOld.status === 409 && acceptOld.body.code === 'DELIVERY_CHANGED', `[版本锁] 带旧 rev accept 应 409 DELIVERY_CHANGED, got ${acceptOld.status} ${JSON.stringify(acceptOld.body)}`);
    const acceptNew = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: newRev });
    must(acceptNew.status === 200, `[版本锁] 带新 rev accept 应 200, got ${acceptNew.status} ${JSON.stringify(acceptNew.body)}`);
  }
  {
    // 不带 expected_delivery_rev → 200（缺省放行对照，D3/29 处既有脚本兼容）
    const { issueId } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const r = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, {});
    must(r.status === 200, `[版本锁] 不带 expected_delivery_rev accept 应 200（缺省放行）, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // 格式非法 → 400 VALIDATION
    const { issueId } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const r = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: 'not-a-rev' });
    must(r.status === 400 && r.body.code === 'VALIDATION', `[版本锁] 格式非法 expected_delivery_rev 应 400 VALIDATION, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // [C3c·M5·538 回卷] 在册开发上传 delivery 附件后 accept 带旧 rev → 409；对接人（非在册开发）上传后
    // accept 带旧 rev → 200（不计入）——改走真实上传端点 POST /sys-issues/:id/attachments（multipart），
    // 不再直连 SQL 伪造附件行（旧写法绕过了 sysPersistAttachments 的 recheckFn，测不出该函数本身是否
    // 正确写入/计入 rev）。
    const { issueId, userId } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const detail1 = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    const revBeforeUpload = detail1.body.issue.delivery_rev;
    const upReal = await upload(`/api/sys-issues/${issueId}/attachments`, devTok(userId), { attachment_type: 'delivery' }, 'real-upload.png');
    must(upReal.status === 200, `[版本锁] 真实上传端点应 200, got ${upReal.status} ${JSON.stringify(upReal.body)}`);
    const acceptStale = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: revBeforeUpload });
    must(acceptStale.status === 409 && acceptStale.body.code === 'DELIVERY_CHANGED', `[版本锁] 在册开发上传 delivery 附件后旧 rev accept 应 409, got ${acceptStale.status} ${JSON.stringify(acceptStale.body)}`);

    const id2 = (await mkNoCodeSubmitted('improvement', '开发中', 6)).issueId;
    const detail2 = await call('GET', `/api/sys-issues/${id2}`, adminTok);
    const rev2Before = detail2.body.issue.delivery_rev;
    // 对接人（用户 13，本单 intake_liaison_id 恒 13，见 mkIssue 夹具）上传 screenshot 类附件——真实端点：
    // 对接人非在册开发但满足 isBoundLiaisonEligibleOrAdmin，走 coordinator 分支，不计入 delivery_rev。
    const upNonRoster = await upload(`/api/sys-issues/${id2}/attachments`, devTok(13), { attachment_type: 'screenshot' }, 'liaison-upload.png');
    must(upNonRoster.status === 200, `[版本锁] 对接人真实上传端点应 200, got ${upNonRoster.status} ${JSON.stringify(upNonRoster.body)}`);
    const acceptNonRoster = await call('POST', `/api/sys-issues/${id2}/accept`, adminTok, { expected_delivery_rev: rev2Before });
    must(acceptNonRoster.status === 200, `[版本锁] 非在册（对接人）上传附件后旧 rev accept 应仍 200（不计入 rev）, got ${acceptNonRoster.status} ${JSON.stringify(acceptNonRoster.body)}`);
  }
  {
    // [C3c·M5·538 回卷] 附件持久化前状态变化——beforeAttachmentInsertHook 在 sysPersistAttachments 的
    // rename/INSERT 循环前把上传者移出在册，既有 recheckFn（INSERT 之后、COMMIT 之前重验）应捕获并
    // 同事务回滚：409 定向码（INVALID_STATE_FOR_ATTACHMENT）+ 附件行未提交（COUNT 不变）+ 已移动文件
    // 清理（最终目录文件数不变）+ 随后（撤销移出、钩子清空）一次正常写请求 200。
    const { issueId, userId } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const finalDir = path.join(I.SYS_UPLOAD_BASE, String(issueId));
    const filesBefore = fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : [];
    const countBefore = (await get('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [issueId])).c;
    I.__testHooks.beforeAttachmentInsertHook = async () => {
      await run(`UPDATE sys_issue_dev_assignees SET removed_at=datetime('now','localtime') WHERE issue_id=? AND user_id=?`, [issueId, userId]);
    };
    const upMutated = await upload(`/api/sys-issues/${issueId}/attachments`, devTok(userId), { attachment_type: 'delivery' }, 'mutated-mid-persist.png');
    I.__testHooks.beforeAttachmentInsertHook = null;
    must(upMutated.status === 409 && upMutated.body.code === 'INVALID_STATE_FOR_ATTACHMENT', `[版本锁/M5] 持久化前把上传者移出在册应 409 定向码, got ${upMutated.status} ${JSON.stringify(upMutated.body)}`);
    const countAfter = (await get('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [issueId])).c;
    must(countAfter === countBefore, `[版本锁/M5] 附件行未提交（COUNT 不变），前=${countBefore}，后=${countAfter}`);
    const filesAfter = fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : [];
    must(filesAfter.length === filesBefore.length, `[版本锁/M5] 已移动文件应被同事务清理（最终目录文件数不变），前=${filesBefore.length}，后=${filesAfter.length}`);
    // 撤销移出 + 钩子已清空——随后一次正常写请求应 200（证明本次 409 是钩子造成的状态变化所致，非结构性
    // 卡死；released 后该实例仍能正常上传）。
    await run(`UPDATE sys_issue_dev_assignees SET removed_at=NULL WHERE issue_id=? AND user_id=?`, [issueId, userId]);
    const upRecovered = await upload(`/api/sys-issues/${issueId}/attachments`, devTok(userId), { attachment_type: 'delivery' }, 'after-recovery.png');
    must(upRecovered.status === 200, `[版本锁/M5] 撤销移出+钩子清空后，正常写请求应 200, got ${upRecovered.status} ${JSON.stringify(upRecovered.body)}`);
  }
  {
    // 移出成员后 admin 删除其 delivery 附件 → accept 带移出后捕获的 rev → 200
    //   两人团队（5 上传附件后被移出，6 留任并完成）——RELEASE 族门要求"在册≥1 且无 pending"，若把
    //   唯一成员移出会连累 accept 结构性走不到（团队清零），故留 6 撑住在册完成态，隔离出"5 的附件
    //   退出保护范围"这一件事本身。
    const issueId = await mkIssue('improvement', '开发中');
    await mkPending(issueId, 5, '开发甲');
    await mkPending(issueId, 6, '开发乙');
    const sub5 = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '版本锁夹具：开发甲的交付说明', self_tested: true, test_env_deployed: true });
    if (sub5.status !== 200) throw new Error(`[夹具] 开发甲提交应 200，实得 ${sub5.status} ${JSON.stringify(sub5.body)}`);
    const sub6 = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(6), { mode: 'no_code', no_code_reason: '版本锁夹具：开发乙的交付说明', self_tested: true, test_env_deployed: true });
    if (sub6.status !== 200) throw new Error(`[夹具] 开发乙提交应 200，实得 ${sub6.status} ${JSON.stringify(sub6.body)}`);
    const attIns = await run(
      `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'delivery', 'c.txt', 'c.txt', 5, '开发甲')`,
      [issueId]
    );
    const attId = attIns.lastID;
    const daRow5 = await memberRowOf(issueId, 5);
    await run(`UPDATE sys_issue_dev_assignees SET removed_at=datetime('now','localtime') WHERE id=?`, [daRow5.id]);
    // [C3b·M3] 补真实 DELETE 调用（原用例只标签写"删附件"，实际从未调用删除端点）——移出后该成员的附件
    // 已退出"在册开发"范围，删前删后 rev 应恒一致（该附件从未计入过 rev），证明"移出者附件不计"这条
    // 结论不是"巧合地删了之后才对"，而是从移出那一刻起就已经不计。
    const revBeforeDelete = (await call('GET', `/api/sys-issues/${issueId}`, adminTok)).body.issue.delivery_rev;
    const delR = await call('DELETE', `/api/sys-issues/${issueId}/attachments/${attId}`, adminTok, {});
    must(delR.status === 200, `[版本锁] admin 删除已移出成员的 delivery 附件应 200, got ${delR.status} ${JSON.stringify(delR.body)}`);
    const revAfterDelete = (await call('GET', `/api/sys-issues/${issueId}`, adminTok)).body.issue.delivery_rev;
    must(revAfterDelete === revBeforeDelete, `[版本锁] 删除"移出者上传的附件"前后 rev 应一致（该附件从未计入过 rev），删前=${revBeforeDelete}，删后=${revAfterDelete}`);
    const r = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: revAfterDelete });
    must(r.status === 200, `[版本锁] 移出成员+admin 真删附件后——带当前 rev accept 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // computeDeliveryRev 四处调用点同源：详情/amend 响应/accept 校验对同一状态给出同一串
    const { issueId, tok } = await mkNoCodeSubmitted('improvement', '开发中', 5);
    const detailRev = (await call('GET', `/api/sys-issues/${issueId}`, adminTok)).body.issue.delivery_rev;
    const directRev = await I.computeDeliveryRev(issueId);
    must(detailRev === directRev, `[版本锁] 详情端 delivery_rev 与 computeDeliveryRev 直调结果一致，详情=${detailRev}，直调=${directRev}`);
    const amendRev = (await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '同源核对夹具：新说明内容' })).body.delivery_rev;
    const directRevAfter = await I.computeDeliveryRev(issueId);
    must(amendRev === directRevAfter, `[版本锁] amend 响应 delivery_rev 与 computeDeliveryRev 直调结果一致，amend=${amendRev}，直调=${directRevAfter}`);
  }
  await selfCertifyProbes('[版本锁组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【详情持锁排队组】（C3b·H2 订正 → C3c·M3·538 回卷收紧）——C3b 版只证明"获锁顺序"（amend 获锁时刻
  //   ≥ barrier 释放时刻），未证明"两者在同一临界区互斥"（理论上即便无互斥，凑巧的调度顺序也能满足
  //   该弱断言）。538 回卷改用 __testHooks.detailMidHook（挂在详情临界区**中途**——devAssignees/commit
  //   行/workNoteRows/noCodeRecords/bugCauseRecords 均已读完、附件 SELECT 之前，见路由文件调用点注释）
  //   卡住 sysTxnMutex 持有中的详情请求，验证：① 详情卡在临界区中途期间，amend 事务（争用同一把
  //   sysTxnMutex）确凿尚未获锁（afterAmendBeginHook 未打点，非只比较时刻先后）；② 释放屏障后详情请求
  //   完成，其响应内容（work_note/delivery_rev）对应修正前状态——因为详情持锁横跨"读取→计算 rev"全程，
  //   amend 必须等详情释放锁才能写入，读到的天然是修正前快照；③ 用该修正前 rev 去 accept 应 409
  //   DELIVERY_CHANGED（amend 已在详情释放锁之后真正提交，内容已变）；④ 变异对照——把
  //   deliveryLockRelease() 提前到交付查询之前调用会让本组红（人工验证后已改回原实现，此处只留文字
  //   记录，不留持久化的自动变异断言，避免生产代码被测试脚本反向牵动）。
  // ══════════════════════════════════════════════════════════════════════
  {
    // 单人 improvement 团队（不传 keepInDev）——W-GATE 全完成后自动进「待验证」（VERIFY 族），
    // 与版本锁组既有夹具同款（:401 一带），使本组末尾的 accept 调用落在合法状态窗口内。
    const { issueId, daId, tok } = await mkCommitsSubmitted('improvement', '开发中', 5, { commits: [{ component: 'backend', commit_ref: 'pre-amend-ref' }] });
    let amendLockAcquiredAt = null;
    let midEnteredResolve;
    const midEntered = new Promise((r) => { midEnteredResolve = r; });
    let releaseMid, midReleasedAt = null;
    const barrier = new Promise((resolve) => { releaseMid = () => { if (midReleasedAt === null) midReleasedAt = Date.now(); resolve(); }; });
    I.__testHooks.detailMidHook = async () => {
      midEnteredResolve();
      await Promise.race([
        barrier,
        new Promise((r) => setTimeout(() => { if (midReleasedAt === null) midReleasedAt = Date.now(); r(); }, 3000)),
      ]);
    };
    I.__testHooks.afterAmendBeginHook = () => { amendLockAcquiredAt = Date.now(); };
    const detailPromise = call('GET', `/api/sys-issues/${issueId}`, adminTok);
    await midEntered;   // 事件通知替代原 100ms 定时等待——确知详情请求已进入临界区中途、卡在 mid barrier 里
    must(amendLockAcquiredAt === null, '[排队/mid] 详情卡在临界区中途时，amend 事务应尚未获锁（同一把 sysTxnMutex 互斥）');
    const amendPromise = call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '排队夹具-修正后' });
    await new Promise((r) => setTimeout(r, 80));   // 给 amend 请求一点时间窗口证明它确系排队卡住，非瞬间完成后巧合仍为 null
    must(amendLockAcquiredAt === null, '[排队/mid] amend 请求发出后短暂等待，仍应因同一临界区被阻塞、尚未获锁');
    releaseMid();
    const [detailResult, amendResult] = await Promise.all([detailPromise, amendPromise]);
    I.__testHooks.detailMidHook = null;
    I.__testHooks.afterAmendBeginHook = null;
    must(detailResult.status === 200, `[排队/mid] 详情请求本身应 200, got ${detailResult.status}`);
    must(amendResult.status === 200, `[排队/mid] amend 请求本身应 200, got ${amendResult.status}`);
    must(!!amendLockAcquiredAt && !!midReleasedAt, '[排队/mid] amend 真实获锁时刻/mid barrier 释放时刻均应被记录');
    must(amendLockAcquiredAt >= midReleasedAt, `[排队/mid] amend 事务真实获锁时刻（${amendLockAcquiredAt}）应不早于 mid barrier 真正释放时刻（${midReleasedAt}）`);
    // 详情响应内容对应修正前状态——work_note 不应是排队中 amend 写入的新值，devAssignees 命中行按 daId 定位。
    const devRowInDetail = (detailResult.body.dev_assignees || []).find((d) => d.id === daId);
    must(!!devRowInDetail, '[排队/mid] 详情响应 dev_assignees 应含本实例行（按 daId 定位）');
    must(devRowInDetail && devRowInDetail.work_note !== '排队夹具-修正后', `[排队/mid] 详情响应内容应对应修正前状态（work_note 不应等于排队中 amend 写入的新值），实得=${devRowInDetail && devRowInDetail.work_note}`);
    const detailRevDuringQueue = detailResult.body.issue.delivery_rev;
    const amendRevAfter = amendResult.body.delivery_rev;
    must(detailRevDuringQueue !== amendRevAfter, `[排队/mid] 详情响应 delivery_rev（修正前=${detailRevDuringQueue}）应不同于 amend 提交后的新 rev（${amendRevAfter}）——证明详情读到的确是修正前快照`);
    // 用修正前 rev 去 accept 应 409 DELIVERY_CHANGED（内容已被排队中完成的 amend 变更）。
    const acceptWithStaleRev = await call('POST', `/api/sys-issues/${issueId}/accept`, adminTok, { expected_delivery_rev: detailRevDuringQueue });
    must(acceptWithStaleRev.status === 409 && acceptWithStaleRev.body.code === 'DELIVERY_CHANGED', `[排队/mid] 用排队期间读到的修正前 rev 去 accept 应 409 DELIVERY_CHANGED, got ${acceptWithStaleRev.status} ${JSON.stringify(acceptWithStaleRev.body)}`);
  }
  await selfCertifyProbes('[排队组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【回滚组】三注入点——列/commit 行/全部事件/delivery_rev 全部回滚到修正前
  // ══════════════════════════════════════════════════════════════════════
  async function snapshotFor(issueId, daId) {
    // [C3c·M5·538 回卷] 花名册列补 resolved_at（原只比对 dev_status/no_code_reason 两列，resolved_at
    // 是花名册第三个会被 amend 事务写动的列——遗漏它会让"resolved_at 未回滚"这类半回滚静默过关）；
    // events 从"仅计数"改为全部事件行（id+action+payload_json）逐行比对——计数相同不代表内容相同
    // （旧行被删、等量新行顶替，COUNT 不变但内容早已不是修正前那几条）。
    const roster = await get('SELECT dev_status, no_code_reason, resolved_at FROM sys_issue_dev_assignees WHERE id=?', [daId]);
    const commits = await commitsOf(daId);
    const events = await all('SELECT id, action, payload_json FROM sys_issue_dev_events WHERE dev_assignee_id=? ORDER BY id', [daId]);
    const rev = await I.computeDeliveryRev(issueId);
    return { roster, commits, events, rev };
  }
  {
    // 注入点①：__afterCommitRowsDeletedHook（commits→no_code：行已删、delete-commit 事件未写）
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true, commits: [{ component: 'backend', commit_ref: 'rollback-a' }] });
    const before = await snapshotFor(issueId, daId);
    I.__testHooks.afterCommitRowsDeletedHook = async () => { throw new Error('[注入①] commits 行已删，故意在此中断'); };
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '注入①触发的修正尝试说明' });
    I.__testHooks.afterCommitRowsDeletedHook = null;
    must(r.status === 500, `[回滚①] 注入点触发后端点应 500（未预期错误经 sendSysTransitionError 兜底）, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await snapshotFor(issueId, daId);
    must(JSON.stringify(after) === JSON.stringify(before), `[回滚①] 列/commit 行/事件数/delivery_rev 全部回滚到修正前，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}`);
  }
  {
    // 注入点②：__afterDeleteEventsHook（delete-commit 事件已写、最终 no_code 事件未写）
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true, commits: [{ component: 'backend', commit_ref: 'rollback-b' }] });
    const before = await snapshotFor(issueId, daId);
    I.__testHooks.afterDeleteEventsHook = async () => { throw new Error('[注入②] delete-commit 事件已写，故意在此中断'); };
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '注入②触发的修正尝试说明' });
    I.__testHooks.afterDeleteEventsHook = null;
    must(r.status === 500, `[回滚②] 注入点触发后端点应 500, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await snapshotFor(issueId, daId);
    must(JSON.stringify(after) === JSON.stringify(before), `[回滚②] 列/commit 行/事件数/delivery_rev 全部回滚到修正前，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}`);
  }
  {
    // 注入点③：__beforeFinalEventHook（最终 submit/no_code 事件写入前，任意方向均可测——用 no_code→no_code 最简单）
    const { issueId, daId, tok } = await mkNoCodeSubmitted('feature', '开发中', 5, { keepInDev: true });
    const before = await snapshotFor(issueId, daId);
    I.__testHooks.beforeFinalEventHook = async () => { throw new Error('[注入③] 最终事件写入前，故意在此中断'); };
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: '注入③触发的修正尝试说明' });
    I.__testHooks.beforeFinalEventHook = null;
    must(r.status === 500, `[回滚③] 注入点触发后端点应 500, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await snapshotFor(issueId, daId);
    must(JSON.stringify(after) === JSON.stringify(before), `[回滚③] 列/commit 行/事件数/delivery_rev 全部回滚到修正前，before=${JSON.stringify(before)}，after=${JSON.stringify(after)}`);
  }
  {
    // [C3c·M5·538 回卷] 注入点④：no_code→commits 方向，__beforeFinalEventHook 抛错——本方向在最终事件
    // 写入前已先 INSERT 新 commit 行（B.4 步骤：no_code→commits 先落新 commits，再写最终 submit 事件），
    // 是③号既有用例（no_code→no_code，不涉及新增 commit 行）未覆盖的一条独立路径：验证新插入的 commit
    // 行随事务整体撤销（回滚快照 commits 数组恢复空）、dev_status 仍为 no_code（未被中途改写的中间值污染）、
    // no_code_reason 未被清空。
    const { issueId, daId, tok } = await mkNoCodeSubmitted('feature', '开发中', 5, { keepInDev: true });
    const before = await snapshotFor(issueId, daId);
    must(before.roster.dev_status === 'no_code' && before.commits.length === 0, `[回滚④] 夹具前置：修正前应为 no_code 且零 commit 行，实得=${JSON.stringify(before.roster)}，commits=${JSON.stringify(before.commits)}`);
    I.__testHooks.beforeFinalEventHook = async () => { throw new Error('[注入④] no_code→commits 新 commit 行已插入、最终事件写入前，故意在此中断'); };
    const r = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'rollback-d-注入④' }] });
    I.__testHooks.beforeFinalEventHook = null;
    must(r.status === 500, `[回滚④] 注入点触发后端点应 500, got ${r.status} ${JSON.stringify(r.body)}`);
    const after = await snapshotFor(issueId, daId);
    must(JSON.stringify(after) === JSON.stringify(before), `[回滚④] no_code→commits 中断后应整体回滚（新 commit 行撤销/dev_status 仍 no_code/no_code_reason 未清），before=${JSON.stringify(before)}，after=${JSON.stringify(after)}`);
  }
  await selfCertifyProbes('[回滚组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【打回组】liaison_test_return 后再 submit：新链 amend_no 从 1 重新开始（#55 既有隐患不在本方案范围，不断）
  // ══════════════════════════════════════════════════════════════════════
  {
    // 双人团队：5 先提交（团队未完成，仍在 DEV 族，可先做一次 amend）；搭子（1005）随后补交完成团队，
    // 触发 W-GATE 到「待对接测试」；liaison-test-return 打回「开发中」（dev_estimated_at 被清空，重开
    // 新链前须先 /estimate 补填，同 liaison-test-return sideEffects 既有行为）；重新 submit 后新链
    // amend_no 应从 1 重新开始。
    const { issueId, daId, tok } = await mkCommitsSubmitted('feature', '开发中', 5, { keepInDev: true });
    const amend1 = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'commits', work_note: '第一链修正' });
    must(amend1.status === 200 && amend1.body.amend_no === 1, `[打回] 第一链修正 amend_no=1，实得=${JSON.stringify(amend1.body)}`);
    // 搭子走 no_code 完成（非 commits）——liaison_test_return 的花名册重置只清 resolved_at/no_code_reason，
    // **不清 commit 行**（commit 是历史事实，既有先例见本文件 :4300 附近注释）；若搭子走 commits 完成，
    // 打回后其行虽被清回 pending，仍挂着一条历史 commit 行，会撞上 P2「pending 态不得挂 commit 行」——
    // 这是系统真实存在的边界（历史留痕 vs 状态复位的既有张力），换 no_code 完成规避、不代表该边界被验证过。
    const buddySubmit = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(1005), { mode: 'no_code', no_code_reason: '打回组搭子夹具：先完成占位说明', self_tested: true, test_env_deployed: true });
    must(buddySubmit.status === 200, `[打回] 夹具前置：搭子补交应 200, got ${buddySubmit.status} ${JSON.stringify(buddySubmit.body)}`);
    const detail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detail.body.issue.status === '待对接测试', `[打回] 夹具前置：团队全完成后应进「待对接测试」，实得=${detail.body.issue.status}`);
    const ret = await call('POST', `/api/sys-issues/${issueId}/liaison-test-return`, jwt.sign({ id: 13, username: 'liaison13', display_name: '示例对接人', role: 'user' }, SECRET), { reason: '打回重做' });
    must(ret.status === 200, `[打回] liaison-test-return 应 200, got ${ret.status} ${JSON.stringify(ret.body)}`);
    const est = await call('POST', `/api/sys-issues/${issueId}/estimate`, tok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    must(est.status === 200, `[打回] 夹具前置：打回后重新回填预计完成时间应 200, got ${est.status} ${JSON.stringify(est.body)}`);
    const reSubmit = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'new-chain-commit' }], self_tested: true, test_env_deployed: true });
    must(reSubmit.status === 200, `[打回] 打回后重新 submit 应 200, got ${reSubmit.status} ${JSON.stringify(reSubmit.body)}`);
    const newDaId = reSubmit.body.dev_assignee_id;
    // [实测澄清] liaison_test_return 走"花名册重置"（同实例 dev_status CAS 回 pending），非 remove+re-add——
    // 与 B.2 D8/D12 依据的"移出旧实例→加入新实例"心智模型不同，重开后 daId 与 newDaId 实为**同一实例**。
    // 不改变本组结论：新 submit 事件不携带 amend_of/amend_no（走的是 /submit 非 /submit/amend），故下方
    // amend_no 计算天然从 1 重新起算——D12"修正链在新 submit 起重新计数"对"同实例重置"与"新实例"两种
    // 底层实现同样成立，只需断言链重新起算这一件事，不必断言必须换实例。
    must(newDaId !== undefined, `[打回] 打回重开后应返回 dev_assignee_id（同实例=${daId} 或新实例，均可），实得=${JSON.stringify(newDaId)}`);
    const amend2 = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, devTok(5), { mode: 'commits', work_note: '打回后新链首次修正' });
    must(amend2.status === 200 && amend2.body.amend_no === 1, `[打回] 打回重开后新链首次 amend_no 应重新从 1 开始，实得=${JSON.stringify(amend2.body)}`);
  }
  await selfCertifyProbes('[打回组收尾]');

  // ══════════════════════════════════════════════════════════════════════
  // 【探针组】P1-P16 全绿（跑一遍最终库状态自证）
  // ══════════════════════════════════════════════════════════════════════
  await selfCertifyProbes('[探针组终检]');

  console.log(`\n=== ${failDetails.length === 0 ? 'PASS' : 'FAIL'}：${passed} 项通过 / ${failDetails.length} 项失败 ===`);
  if (failDetails.length > 0) {
    console.log('失败明细：');
    for (const d of failDetails) console.log('  - ' + d);
  }
  server.close();
  if (failDetails.length > 0) process.exit(1);
}

main().catch(e => { console.error('❌ verify-sys-submit-amend 失败:', e && e.stack || e); server && server.close(); process.exit(1); });
