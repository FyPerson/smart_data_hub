// 验证脚本：系统迭代 bug 流状态机 + 端点（bug流_方案_20260702_v1.2 §2/§3/§8，Commit ①+②）
//   用法：node scripts/verify-sys-bug-transitions.js
//
// 覆盖（真实 HTTP 端点 + 常量层双面）：
//   [M] meta/常量：bug 状态集/初始态/动作集恰好（Commit② 起含 set_release_flag/publish/confirm-online-norelease，
//       仍无 hold/close/reopen/derive/评估三动作/scope_change）+ isDevWorkState 单元 + REQUIRES_ASSIGNEE_STATUSES
//       + RELEASABLE_TYPES ② 恢复含 bug 铁证
//   [E] 端点链路：建单落待处理 → schedule 拒（前段裁剪）→ assign 直达处理中 → submit 闸门（缺 est/空 summary）
//       → estimate → submit → 待验证 → return（return_count++/清 est）→ 二轮 → accept → 待上线
//   [R] 上线两路径（Commit② §8.2，死端解除）：填发版信息(set_release_flag) 唯一写点/枚举/ownerGuard/锁定 +
//       确认上线·不发版(confirm-online-norelease，release_id 保持 NULL) + 确认上线·发版(hotfix-publish，
//       release_type 回填) + add-issues 批次隔离（needs_release=1 闸门 + release_type 混批拒）
//   [G] 旁路：issue_reject 仅前段 / reactivate 回待处理 / void 任意态 / reassign 两前置态
//   [A] 附件：bug 处理中 delivery 可传（isDevWorkState 放行）/ 待处理拒 409
//   [T→⑤放开] derive ① 临时闸已拆：feature→bug 派生 201（SYS_BUG_DERIVE_PENDING 不再触发）；bug 语境完整覆盖见 verify-sys-bug-derive.js。feasibility·blocked 端点对 bug 仍 409
//   [C] 变更流零回归 canary：feature 建单→schedule→assign 正常（assign expectedFrom=null 改动无回归）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-transitions-secret';
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
const T = I.transitions;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);

let server, port;
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// 手搓 multipart 上传（field=files，可带 attachment_type 文本域）
function upload(id, tok, filename, attachmentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----vfy' + Date.now();
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
const EST = '2026-08-01 10:00';

// 建 bug 单 → 指派到 devId，返回 id（处理中态）
async function seedBugToDev(devId = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
// 建 bug 单 → 指派 → estimate → submit → accept，返回 id（待上线态，Commit② [R] 测试起点）
async function seedBugToReady(devId = 5, devTok2 = devTok) {
  const id = await seedBugToDev(devId);
  let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok2, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200, `bug estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { summary: '修复完成' });
  assert.strictEqual(r.status, 200, `bug submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `bug accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(await statusOf(id), '待上线', 'seedBugToReady 应停在 待上线');
  return id;
}
// 走变更流（feature/improvement）全流程到待上线（[R] 批次族别测试用）
async function seedChangeToReady(type = 'feature', devId = 5, devTok2 = devTok) {
  let r = await call('POST', '/api/sys-issues', adminTok, { type, title: type + '-mix', system_name: 'BMS', source: '内部' });
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok2, { dev_estimated_at: EST });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { summary: '交付' });
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `${type} accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
const seedFeatureToReady = (devId = 5, devTok2 = devTok) => seedChangeToReady('feature', devId, devTok2);
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }
async function rowOf(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }
async function issueRowRelease(id) { return (await get('SELECT release_id FROM sys_issues WHERE id=?', [id])).release_id; }

async function main() {
  mod.initSchema();
  await waitReady();
  // users 表（assign 端点查 users 校验被指派人）
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(7,'viewer','观察员','viewer')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [M] meta / 常量层 ═══
  {
    const meta = T.buildMeta();
    assert.deepStrictEqual(meta.statusLabels.bug, ['待处理', '处理中', '待验证', '待上线', '已上线', '已拒绝', '已作废'], 'bug 状态集 7 态');
    assert.strictEqual(meta.initialStatusByType.bug, '待处理', 'bug 初始态=待处理');
    const bugActions = meta.typeFlows.bug.map(t => t.action).sort();
    assert.deepStrictEqual(bugActions,
      ['accept', 'assign', 'confirm-online-norelease', 'create', 'derive', 'estimate', 'issue_reject', 'publish',
       'reactivate', 'reassign', 'return', 'set_release_flag', 'submit', 'void'].sort(),
      `bug 动作集恰好 14 个（Commit② 追加 3 + Commit⑤ 追加 derive），实际 ${bugActions.join(',')}`);
    for (const banned of ['hold', 'resume', 'close', 'reopen', 'feasibility', 'blocked', 'unblock', 'scope_change', 'schedule']) {
      assert.ok(!bugActions.includes(banned), `bug typeFlows 不应含 ${banned}`);   // ⑤ 后 derive 移出 banned（reopen 仍禁：上线后一律派生非重开）
    }
    const setFlagEntry = meta.typeFlows.bug.find(t => t.action === 'set_release_flag');
    assert.strictEqual(setFlagEntry.kind, 'side_effect', 'set_release_flag 应标 side_effect（SIDE_EFFECT_ACTIONS 白名单）');
    const confirmEntry = meta.typeFlows.bug.find(t => t.action === 'confirm-online-norelease');
    assert.strictEqual(confirmEntry.kind, 'transition', 'confirm-online-norelease 应标 transition（真实改 status）');
    const deriveEntry = meta.typeFlows.bug.find(t => t.action === 'derive');   // ⑤：bug derive 仅从已上线 + side_effect（路由专用端点，非通用引擎）
    assert.deepStrictEqual(deriveEntry.from, ['已上线'], 'bug derive from 应恰为 [已上线]（§4 仅从已上线单派生）');
    assert.strictEqual(deriveEntry.kind, 'side_effect', 'derive 应标 side_effect（走 POST /derive 专用端点，不误入通用 transition）');
    ok('meta：bug 状态集 7 态 + 初始态待处理 + 动作集恰好 14（Commit② 追加 set_release_flag/publish/confirm-online-norelease + Commit⑤ 追加 derive[from=已上线/side_effect]，仍无 hold/close/reopen/评估三动作/scope_change/schedule）+ kind 标注正确');
  }
  {
    assert.strictEqual(T.isDevWorkState('bug', '处理中'), true, 'bug 处理中=开发工作态');
    assert.strictEqual(T.isDevWorkState('bug', '开发中'), false, 'bug 开发中≠工作态（态名按类型）');
    assert.strictEqual(T.isDevWorkState('feature', '开发中'), true);
    assert.strictEqual(T.isDevWorkState('feature', '处理中'), false);
    assert.strictEqual(T.isDevWorkState('config', '处理中'), false, 'config 未定义 → false（追加 config 流时补）');
    assert.strictEqual(T.isDevWorkState('bug', null), false, 'null status → false');
    assert.ok(T.REQUIRES_ASSIGNEE_STATUSES.includes('处理中') && T.REQUIRES_ASSIGNEE_STATUSES.includes('开发中'), 'RC-M5 全集含 处理中+开发中');
    assert.ok(!T.REQUIRES_ASSIGNEE_STATUSES.includes('待处理'), 'RC-M5 全集不含 待处理（未指派前段）');
    ok('isDevWorkState 单元（bug=处理中/feature=开发中/config 未定义 false/null false）+ REQUIRES_ASSIGNEE_STATUSES 边界');
  }
  {
    assert.ok(I.RELEASABLE_TYPES.includes('bug'), '② 恢复：RELEASABLE_TYPES 含 bug（需 needs_release=1 闸门配套，见 [R]）');
    assert.deepStrictEqual(I.RELEASABLE_TYPES, ['feature', 'improvement', 'bug'], 'RELEASABLE_TYPES=[feature,improvement,bug]');
    ok('⭐ ② 铁证：RELEASABLE_TYPES 恢复含 bug（needs_release=1 闸门在 add-issues/hotfix-publish/_publishReleaseCoreInTxn 三处同步落地，见 [R]）');
  }
  {
    // KEY_COLS 锚点（[审:M1]）：readiness 与新列同源
    for (const c of ['needs_release', 'related_correction_no', 'fix_gap_note', 'dingtalk_chat_id']) {
      assert.ok(I.SYS_ISSUES_KEY_COLS.includes(c), `SYS_ISSUES_KEY_COLS 应含锚点 ${c}`);
    }
    assert.ok(I.SYS_RELEASES_KEY_COLS.includes('release_type'), 'SYS_RELEASES_KEY_COLS 应含 release_type');
    ok('readiness 锚点：needs_release/related_correction_no/fix_gap_note/dingtalk_chat_id + release_type 已入 KEY_COLS（[审:M1]）');
  }

  // ═══ [E] 端点正向链路 ═══
  let mainId;
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '导出按钮报错', system_name: 'BMS', source: '业务方', requester_dept: '财务部', requester_name: '张三', requester_phone: '13800000000' });
    assert.strictEqual(r.status, 201, '建 bug 单 201');
    assert.strictEqual(r.body.status, '待处理', 'bug 建单落 待处理');
    mainId = r.body.id;
    const tl = await all('SELECT * FROM sys_issue_timeline WHERE issue_id=?', [mainId]);
    assert.strictEqual(tl[0].event_type, 'created', '建单写 created timeline');
    ok('建单：type=bug → 201 落「待处理」（前段裁剪，无评估/排期）+ created timeline + 报障人 requester_* 可选录入');
  }
  {
    const r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x', system_name: 'BMS', source: '内部', needs_feasibility: 1 });
    assert.strictEqual(r.status, 400, 'bug + needs_feasibility=1 应 400');
    assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE');
    ok('建单守卫：bug 传 needs_feasibility=1 → 400 FEASIBILITY_NOT_APPLICABLE（评估环节不适用 bug，守卫实弹）');
  }
  {
    const r = await call('POST', `/api/sys-issues/${mainId}/schedule`, adminTok, {});
    assert.strictEqual(r.status, 400, 'bug schedule 应 400');
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION');
    ok('前段裁剪：bug 无 schedule 动作 → 400 INVALID_TRANSITION');
  }
  {
    let r = await call('POST', `/api/sys-issues/${mainId}/assign`, devTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 403, '非 admin 指派应 403（① 白名单=④）');
    r = await call('POST', `/api/sys-issues/${mainId}/assign`, adminTok, { assigned_to: 7 });
    assert.strictEqual(r.status, 400, '指派 viewer 应 400');
    r = await call('POST', `/api/sys-issues/${mainId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, 'bug assign 200');
    assert.strictEqual(r.body.status, '处理中', 'assign 直达 处理中');
    const row = await rowOf(mainId);
    assert.ok(row.assigned_at, 'assigned_at 盖时间');
    ok('指派：待处理 →assign→ 处理中（直达）+ 非 admin 403（对接人白名单=④）+ viewer 拒');
  }
  {
    // submit 闸门顺序：缺 est → ESTIMATE_REQUIRED；estimate 本人回填；空 summary → SUBMIT_SUMMARY_REQUIRED
    let r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { summary: '修好了' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED');
    r = await call('POST', `/api/sys-issues/${mainId}/estimate`, dev2Tok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '非本人 estimate 403');
    r = await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, '本人 estimate 200（bug 处理中态内回填）');
    r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { summary: '   ' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'SUBMIT_SUMMARY_REQUIRED');
    ok('submit 闸门：缺 dev_estimated_at → ESTIMATE_REQUIRED + estimate 严格本人（处理中态内）+ 空 summary 拒');
  }

  // ═══ [A] 附件（isDevWorkState 放行 bug 处理中）═══
  {
    let r = await upload(mainId, devTok, 'fix-evidence.png', 'delivery');
    assert.strictEqual(r.status, 200, `bug 处理中 delivery 上传应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.attachments.length, 1);
    ok('⭐ 附件：bug 单「处理中」开发本人可传 delivery（isDevWorkState 修复——旧硬编码「开发中」会 409 断链）');
    // 负向：待处理 bug 单（未指派）上传 → 403/409（守卫仍在）
    const r2 = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: 'x2', system_name: 'OA', source: '内部' });
    const rUp = await upload(r2.body.id, devTok, 'x.png', 'delivery');
    assert.ok(rUp.status === 403 || rUp.status === 409, `待处理 bug 上传应拒, got ${rUp.status}`);
    ok('附件负向：待处理（非工作态/非本人）上传仍被拒（isDevWorkState 未放松守卫）');
  }

  {
    // 合法 submit → 待验证（first_submitted_at + round_no=1 timeline）
    const r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { summary: '空指针已修，补了守卫' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, '待验证');
    const row = await rowOf(mainId);
    assert.ok(row.first_submitted_at, 'first_submitted_at 盖');
    const sub = await get(`SELECT round_no FROM sys_issue_timeline WHERE issue_id=? AND event_type='submit'`, [mainId]);
    assert.strictEqual(sub.round_no, 1, 'submit round_no=1');
    ok('提交修复：处理中 →submit→ 待验证 + first_submitted_at + round_no=1');
  }
  {
    // return（待验证→处理中，return_count++ 清 est）；打回原因必填
    let r = await call('POST', `/api/sys-issues/${mainId}/return`, adminTok, { reason: ' ' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RETURN_REASON_REQUIRED');
    r = await call('POST', `/api/sys-issues/${mainId}/return`, adminTok, { reason: '还是报错' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, '处理中');
    const row = await rowOf(mainId);
    assert.strictEqual(row.return_count, 1, 'return_count=1');
    assert.strictEqual(row.dev_estimated_at, null, '打回清 dev_estimated_at');
    ok('验收打回：待验证 →return→ 处理中 + return_count++ + 清 dev_estimated_at + 原因必填');
  }
  {
    // 二轮：estimate → submit → accept → 待上线
    await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: '2026-08-02 10:00' });
    let r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { summary: '二轮修复' });
    assert.strictEqual(r.body.status, '待验证');
    const sub2 = await all(`SELECT round_no FROM sys_issue_timeline WHERE issue_id=? AND event_type='submit' ORDER BY id`, [mainId]);
    assert.strictEqual(sub2[1].round_no, 2, '二轮 submit round_no=2');
    r = await call('POST', `/api/sys-issues/${mainId}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, '待上线');
    assert.ok((await rowOf(mainId)).accepted_at, 'accepted_at 盖');
    ok('验收通过：二轮 submit（round_no=2）→ accept → 待上线 + accepted_at（建单人=admin，T-M1）');
  }

  // ═══ [D] 待上线仍无的动作（②后依然如此，非本次范围）═══
  {
    // close/hold/reopen 依旧无 transition（② 只开两条确认上线路径，不改这三个）
    for (const [ep, code] of [['close', 'INVALID_TRANSITION'], ['hold', 'INVALID_TRANSITION'], ['reopen', 'INVALID_TRANSITION']]) {
      const rr = await call('POST', `/api/sys-issues/${mainId}/${ep}`, adminTok, { reason: 'x' });
      assert.strictEqual(rr.status, 400, `bug ${ep} 应 400`);
      assert.strictEqual(rr.body.code, code, `bug ${ep} → ${code}`);
    }
    assert.strictEqual(await statusOf(mainId), '待上线', 'mainId 未被本节改动，仍停在 待上线');
    ok('close/hold/reopen 对 bug 依旧无 transition（② 范围外，零回归）');
  }

  // ═══ [R] 上线两路径（Commit② §8.2，死端解除）═══
  {
    // R1：set_release_flag 基础校验——非本人 403 / 非法枚举 400 / 非待上线态 409 / 本人成功 + 可改值
    const r1 = await seedBugToReady(5, devTok);
    let r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, adminTok, { needs_release: 1 });
    assert.strictEqual(r.status, 403, `admin 代填发版信息应 403, got ${r.status}`);
    r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, dev2Tok, { needs_release: 1 });
    assert.strictEqual(r.status, 403, `非本人填发版信息应 403, got ${r.status}`);
    r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 2 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_NEEDS_RELEASE');
    r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 'yes' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_NEEDS_RELEASE');
    const midBug = await seedBugToDev(5);   // 处理中态（非待上线）
    r = await call('POST', `/api/sys-issues/${midBug}/set-release-flag`, devTok, { needs_release: 1 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'SET_RELEASE_FLAG_STATUS_INVALID');
    r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 0 });
    assert.strictEqual(r.status, 200, `本人填发版信息应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await rowOf(r1)).needs_release, 0, 'needs_release=0 写入');
    r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 1 });
    assert.strictEqual(r.status, 200, '待上线态内可改值（release_id 仍空）');
    assert.strictEqual((await rowOf(r1)).needs_release, 1, 'needs_release 改为 1');
    ok('R1：填发版信息——唯一写点 ownerGuard 严格本人（admin/他人 403）+ 枚举校验（非 0/1 → 400）+ 非待上线态 409 + 本人可改值');

    // R2：确认上线·不发版——未填闸门 409 / roleGuard admin / release_id 保持 NULL / release_id 三段断言之一
    const r2 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, adminTok, {});
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'NEEDS_RELEASE_NOT_SET');
    await call('POST', `/api/sys-issues/${r2}/set-release-flag`, devTok, { needs_release: 0 });
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, devTok, {});
    assert.strictEqual(r.status, 403, '非 admin 确认上线应 403（roleGuard=admin）');
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, adminTok, {});
    assert.strictEqual(r.status, 200, `确认上线·不发版应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const row2 = await rowOf(r2);
    assert.strictEqual(row2.status, '已上线', '确认上线后 status=已上线');
    assert.strictEqual(row2.release_id, null, '⭐ release_id 三段断言：bug+needs_release=0+已上线 ⟹ release_id NULL');
    assert.ok(row2.released_at, 'released_at 落');
    const tl2 = await get(`SELECT event_type, action_code FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [r2]);
    assert.ok(tl2 && tl2.action_code === 'confirm_online_norelease', 'timeline 记 release + action_code=confirm_online_norelease');
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, adminTok, {});
    assert.strictEqual(r.status, 400, `已上线单再确认应 400 INVALID_TRANSITION, got ${r.status}`);
    ok('R2：确认上线·不发版——未填 needs_release 409 NEEDS_RELEASE_NOT_SET + 非 admin 403 + 成功后 release_id 保持 NULL（三段断言）+ timeline 正确 + 终态不可重复');

    // R3：确认上线·发版（hotfix-publish）——未填闸门 409 / 成功后 release_id 非空 + release_type=bug（三段断言之二）
    const r3 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${r3}/hotfix-publish`, adminTok, { release_note: '修复上线', version_tag: 'v9.9' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'BUG_NEEDS_RELEASE_NOT_SET');
    await call('POST', `/api/sys-issues/${r3}/set-release-flag`, devTok, { needs_release: 1 });
    r = await call('POST', `/api/sys-issues/${r3}/hotfix-publish`, adminTok, { release_note: '修复上线', version_tag: 'v9.9' });
    assert.strictEqual(r.status, 201, `bug hotfix-publish 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const row3 = await rowOf(r3);
    assert.strictEqual(row3.status, '已上线');
    assert.ok(row3.release_id, '⭐ release_id 三段断言：bug+needs_release=1+已上线 ⟹ release_id NOT NULL');
    const rel3 = await get('SELECT release_type, is_hotfix FROM sys_releases WHERE id=?', [row3.release_id]);
    assert.strictEqual(rel3.release_type, 'bug', 'hotfix 批次 release_type=族别 bug（D-A：INSERT 写 releaseFamilyOf）');
    assert.strictEqual(rel3.is_hotfix, 1);
    ok('R3：确认上线·发版（hotfix-publish）——未标发版 409 BUG_NEEDS_RELEASE_NOT_SET + 成功后 release_id 非空（三段断言）+ 批次 release_type=族别 bug');

    // R4：填发版信息锁定——release_id 已挂批次后禁改（防绕过 add-issues 一致性）
    const r4 = await seedBugToReady(5, devTok);
    await call('POST', `/api/sys-issues/${r4}/set-release-flag`, devTok, { needs_release: 1 });
    const relEmpty = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relEmpty}/add-issues`, adminTok, { issue_ids: [r4] });
    assert.strictEqual(r.status, 200, `add-issues 加 bug(needs_release=1) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relEmpty])).release_type, 'bug', '批次首次加单回填 release_type=族别 bug');
    r = await call('POST', `/api/sys-issues/${r4}/set-release-flag`, devTok, { needs_release: 0 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_ALREADY_IN_RELEASE');
    ok('R4：填发版信息锁定——已挂批次（release_id 非空）后禁止再改 needs_release → 409 ISSUE_ALREADY_IN_RELEASE');

    // R5：add-issues 批次隔离——needs_release≠1 拒 + 混批拒（新批次首次加单类型不一致）+ 已定类型批次拒异类
    const r5NoFlag = await seedBugToReady(5, devTok);   // 未填 needs_release（NULL）
    const relEmpty2 = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relEmpty2}/add-issues`, adminTok, { issue_ids: [r5NoFlag] });
    assert.strictEqual(r.status, 409, `bug 未标发版加批次应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE');
    ok('R5a：add-issues 拒绝 needs_release≠1 的 bug（SQL 条件 type<>bug OR needs_release=1）');

    const mixBug = await seedBugToReady(5, devTok);
    await call('POST', `/api/sys-issues/${mixBug}/set-release-flag`, devTok, { needs_release: 1 });
    const mixFeature = await seedFeatureToReady(5, devTok);
    const relMix = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relMix}/add-issues`, adminTok, { issue_ids: [mixBug, mixFeature] });
    assert.strictEqual(r.status, 409, `一次加入 bug+feature 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'MIXED_TYPE_BATCH');
    assert.strictEqual((await issueRowRelease(mixBug)), null, '混批拒绝后 mixBug 未被误挂');
    ok('R5b：add-issues 拒绝一次混选 bug 与非 bug（跨族别）→ 409 MIXED_TYPE_BATCH');

    // 已定族别批次（relEmpty 已是 bug）加入 feature（非 bug 族）→ 409 RELEASE_TYPE_MISMATCH
    const otherFeature = await seedFeatureToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relEmpty}/add-issues`, adminTok, { issue_ids: [otherFeature] });
    assert.strictEqual(r.status, 409, `bug 批次加 feature 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'RELEASE_TYPE_MISMATCH');
    ok('R5c：add-issues 拒绝向已定族别批次（bug）加入异族（feature/change）→ 409 RELEASE_TYPE_MISMATCH');

    // ⭐ R5d（D-A 核心）：feature + improvement **同批应成功**（同族 'change'，保住「一个版本一个批次」）
    const chFeat = await seedChangeToReady('feature', 5, devTok);
    const chImpr = await seedChangeToReady('improvement', 5, devTok);
    const relChange = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chFeat, chImpr] });
    assert.strictEqual(r.status, 200, `feature+improvement 同批应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relChange])).release_type, 'change', '批次族别回填=change');
    assert.strictEqual((await issueRowRelease(chFeat)), relChange, 'feature 已挂 change 批次');
    assert.strictEqual((await issueRowRelease(chImpr)), relChange, 'improvement 已挂 change 批次');
    ok('⭐ R5d：feature + improvement 同批成功（同族 change，release_type=change）——D-A 核心，保住一个版本一个批次');

    // R5e：已定 change 族批次追加 improvement（同族）成功；再追加 bug（异族）拒
    const chImpr2 = await seedChangeToReady('improvement', 5, devTok);
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chImpr2] });
    assert.strictEqual(r.status, 200, `change 批次追加 improvement 应 200, got ${r.status}`);
    const bugForChange = await seedBugToReady(5, devTok);
    await call('POST', `/api/sys-issues/${bugForChange}/set-release-flag`, devTok, { needs_release: 1 });
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [bugForChange] });
    assert.strictEqual(r.status, 409, `change 批次加 bug 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'RELEASE_TYPE_MISMATCH');
    ok('R5e：change 族批次追加 improvement 成功 + 追加 bug（异族）拒 409 RELEASE_TYPE_MISMATCH');

    // R5f（F-4）：批次移空后 release_type 复位 NULL，可被异族重新占用
    const relReset = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const rf = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, 'change', '加 feature 后族别=change');
    r = await call('POST', `/api/sys-releases/${relReset}/remove-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual(r.status, 200, 'remove 200');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, null, 'F-4：批次移空后 release_type 复位 NULL');
    const bugReuse = await seedBugToReady(5, devTok);
    await call('POST', `/api/sys-issues/${bugReuse}/set-release-flag`, devTok, { needs_release: 1 });
    r = await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [bugReuse] });
    assert.strictEqual(r.status, 200, `移空后的批次可被 bug 族重新占用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, 'bug', '复用后族别改判 bug');
    ok('⭐ R5f（F-4）：批次移空 → release_type 复位 NULL → 可被异族（bug）重新占用（不再锁死）');

    // ⭐ R5g（F-2 / codex M-2）：历史 release_type=NULL 非空批次 fail-closed（模拟 Commit② 前遗留态）
    const relHist = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const histFeat = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histFeat] });   // 回填 change
    await run('UPDATE sys_releases SET release_type=NULL WHERE id=?', [relHist]);   // DB 直改还原「有成员但 release_type=NULL」历史态
    // (a) add-issues 读已有成员：向 NULL 批次加 bug，应因已有 feature 成员（change 族）被拒，非按本次入参回填成 bug
    const histBug = await seedBugToReady(5, devTok);
    await call('POST', `/api/sys-issues/${histBug}/set-release-flag`, devTok, { needs_release: 1 });
    r = await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histBug] });
    assert.strictEqual(r.status, 409, `历史 NULL 批次加异族应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RELEASE_TYPE_MISMATCH');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relHist])).release_type, null, '被拒后 release_type 仍 NULL（未被误回填成 bug）');
    ok('R5g-a：历史 NULL 批次 add-issues 读已有成员族别，异族加单被拒（F-2 add fail-closed，不按入参误回填）');
    // (b) publish 从成员推导族别：DB 强塞 bug 进 relHist 造混族别成员 + release_type=NULL，publish 应 fail-closed 拒
    await run('UPDATE sys_issues SET release_id=? WHERE id=?', [relHist, histBug]);   // 绕过 add-issues 强塞（模拟脏库/手工改）
    r = await call('POST', `/api/sys-releases/${relHist}/publish`, adminTok, { release_note: '混族别测试', version_tag: 'vmix' });
    assert.strictEqual(r.status, 409, `混族别 NULL 批次 publish 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'RELEASE_MEMBER_TYPE_MISMATCH');
    assert.strictEqual(await statusOf(histFeat), '待上线', 'publish 拒后 histFeat 未被翻已上线（原子回滚）');
    ok('R5g-b：历史 NULL 批次 publish 从成员推导族别，混 bug+非bug 拒发布（F-2 publish fail-closed，不依赖存的 release_type）');
  }

  // ═══ [T→⑤ 放开] derive 双向临时闸已放开（完整派生/双描述/M5 覆盖见 verify-sys-bug-derive.js）═══
  {
    // ⑤ 放开验证：从 feature 原单派生 bug 新单 —— 旧 ① 临时闸 SYS_BUG_DERIVE_PENDING 应已消失（201 成功）。
    //   feature 原单 originIsBug=false，故无 M5 反向约束、derive_reason 免填、fix_gap_note 首提亦跳过（origin.type≠bug）。
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'f', system_name: 'BMS', source: '内部' });
    const featureId = r.body.id;
    r = await call('POST', `/api/sys-issues/${featureId}/derive`, adminTok, { type: 'bug', title: 'd', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r.status, 201, `feature→bug 派生应放开 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.notStrictEqual(r.body.code, 'SYS_BUG_DERIVE_PENDING');
    ok('derive ① 临时闸已放开（⑤）：feature→bug 派生 201，SYS_BUG_DERIVE_PENDING 不再触发（bug 语境完整覆盖见 verify-sys-bug-derive）');
  }
  {
    const bugId = await seedBugToDev(5);
    let r = await call('POST', `/api/sys-issues/${bugId}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE');
    r = await call('POST', `/api/sys-issues/${bugId}/blocked`, devTok, { reason: '卡住了' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'BLOCKED_NOT_APPLICABLE');
    r = await call('POST', `/api/sys-issues/${bugId}/scope-change`, adminTok, { summary: '改范围' });
    assert.ok(r.status === 400 || r.status === 409, `bug scope-change 应拒, got ${r.status}`);
    ok('评估/范围变更不适用 bug：feasibility/blocked → 409 NOT_APPLICABLE + scope-change 拒（需求变化走 ⑤ 派生）');
  }

  // ═══ [G] 旁路：issue_reject / reactivate / void / reassign ═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'bug', title: '误报', system_name: 'OA', source: '内部' });
    const rejId = r.body.id;
    r = await call('POST', `/api/sys-issues/${rejId}/issue-reject`, adminTok, {});
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'REASON_REQUIRED');
    r = await call('POST', `/api/sys-issues/${rejId}/issue-reject`, adminTok, { reason: '非缺陷，操作问题' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(rejId), '已拒绝');
    // reactivate 回 待处理（bug 初始态，非变更流的 待评估）
    r = await call('POST', `/api/sys-issues/${rejId}/reactivate`, adminTok, { reason: '复现了' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(rejId), '待处理');
    ok('拒绝/重新激活：待处理 →issue_reject→ 已拒绝（原因必填）→reactivate→ 回「待处理」（bug 初始态分流正确）');
    // 处理中不可拒（bug 仅前段可拒）
    const midId = await seedBugToDev(5);
    r = await call('POST', `/api/sys-issues/${midId}/issue-reject`, adminTok, { reason: 'x' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_TRANSITION');
    ok('拒绝边界：处理中 bug 不可 issue_reject（仅前段 待处理 可拒）→ 400 INVALID_TRANSITION');
    // void 任意态（处理中 → 已作废）
    r = await call('POST', `/api/sys-issues/${midId}/void`, adminTok, { reason: '重复建单' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(midId), '已作废');
    ok('作废：处理中 →void→ 已作废（from=* 任意态，软删除逃生口）');
  }
  {
    // reassign：处理中换人 + 待验证换人回处理中；清 dev_estimated_at
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 6, oldAssignedTo: 5, reason: '开发王休假' });
    assert.strictEqual(r.status, 200, `bug reassign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    let row = await rowOf(id);
    assert.strictEqual(Number(row.assigned_to), 6, '换人到 dev2');
    assert.strictEqual(row.status, '处理中', '同态换人仍 处理中');
    assert.strictEqual(row.dev_estimated_at, null, '换人清 dev_estimated_at');
    // 待验证换人 → 回 处理中
    await call('POST', `/api/sys-issues/${id}/estimate`, dev2Tok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { summary: '修复完成' });
    assert.strictEqual(await statusOf(id), '待验证');
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { newAssignedTo: 5, oldAssignedTo: 6, reason: '返工换回' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await statusOf(id), '处理中', '待验证换人 → 回 处理中');
    ok('换人：处理中 →reassign→ 处理中（清 est）+ 待验证 →reassign→ 处理中（映射 to 正确）');
  }
  {
    // ownerGuard 严格本人（H-1 同口径）：admin/他人 submit → 403
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { summary: 'x' });
    assert.strictEqual(r.status, 403, '非本人 submit 403');
    r = await call('POST', `/api/sys-issues/${id}/submit`, adminTok, { summary: 'x' });
    assert.strictEqual(r.status, 403, 'admin 代提交 403（严格本人）');
    ok('ownerGuard 严格本人：bug submit 非本人/admin 代办均 403（H-1 口径与变更流一致）');
  }

  // ═══ [C] 变更流零回归 canary（assign expectedFrom=null 改动）═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'canary', system_name: 'BMS', source: '内部' });
    const id = r.body.id;
    assert.strictEqual(r.body.status, '待评估', 'feature 建单仍落 待评估');
    // 待评估直接 assign（跳过 schedule）→ 应仍被拒（findTransition from 白名单守，expectedFrom=null 未放松前置态）
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 400, `feature 待评估直接 assign 应 400, got ${r.status}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION');
    r = await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
    assert.strictEqual(r.status, 200);
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, '开发中');
    ok('⭐ 变更流 canary：assign expectedFrom 改 null 后，feature 待评估直接指派仍被 from 白名单拒 + 正常路径 待评估→schedule→assign→开发中 零回归');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 bug 流状态机 + 端点验证通过（Commit ①+②）`);
  console.log('  覆盖：meta/isDevWorkState/RC-M5全集/RELEASABLE恢复含bug + 建单落待处理 + 前段裁剪 + 全生命周期到待上线 + 上线两路径(填发版信息/确认上线·发版/不发版) + release_id三段断言 + 批次族别隔离(feature+improvement同批✓/bug隔离/移空复位/历史NULL fail-closed) + 附件处理中放行 + derive/评估临时闸 + 拒绝/激活/作废/换人 + ownerGuard + 变更流 canary');
  server.close(); db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); try { server && server.close(); } catch (_) {} db.close(); process.exit(1); });
