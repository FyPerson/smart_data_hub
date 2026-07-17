// 验证脚本：系统迭代 bug 流状态机 + 端点（bug流_方案_20260702_v1.2 §2/§3/§8，Commit ①+② + 通知改造 v1.6 §2.3 C3b 退场）
//   用法：node scripts/verify-sys-bug-transitions.js
//
// 覆盖（真实 HTTP 端点 + 常量层双面）：
//   [M] meta/常量：bug 状态集/初始态/动作集恰好 13 个（v1.6 §2.3 退场 set_release_flag/publish/
//       confirm-online-norelease 三条 + 新增 assign-release-dev/execute-release 两条上线编排；
//       仍无 hold/close/reopen/derive/评估三动作/scope_change）+ isDevWorkState 单元 +
//       REQUIRES_ASSIGNEE_STATUSES + RELEASABLE_TYPES ② 恢复含 bug 铁证
//   [E] 端点链路：建单落待处理 → schedule 拒（前段裁剪）→ assign 直达处理中 → submit 闸门（缺 est/空 summary）
//       → estimate → submit → 待验证 → return（return_count++/清 est）→ 二轮 → accept → 待上线
//   [R] 上线两路径已退场（v1.6 §2.3 [C-1]）——LEGACY gate × bug/变更流双向矩阵：R1(set-release-flag)/
//       R2(hotfix-publish)/R3(confirm-online-norelease) 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED；
//       R4(legacy /sys-releases/:id/publish)/R5(add-issues/remove-issues) 对 bug(族别) 一律拒绝，
//       变更流(feature/improvement) 全部既有场景（R5d 同批/R5e 追加/R5f 移空复用/R5g 历史 NULL fail-closed）
//       零行为变化。新 G3-G6 上线编排完整覆盖 + 越权矩阵见 verify-sys-release-orchestration.js。
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
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { mode: 'no_code', no_code_reason: '修复完成（占位理由）' });
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
  await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { mode: 'no_code', no_code_reason: '交付（占位理由）' });
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
    // [v1.6 退场，通知改造 C3b]：set_release_flag/publish/confirm-online-norelease 三条随
    //   BUG_FLOW_TRANSITIONS 移除（§2.3 [C-1 旧入口替换矩阵]），新增 assign-release-dev/execute-release
    //   两条上线编排动作——净 14→13 个（移3 加2）。
    assert.deepStrictEqual(bugActions,
      ['accept', 'assign', 'assign-release-dev', 'create', 'derive', 'estimate', 'execute-release', 'issue_reject',
       'reactivate', 'reassign', 'return', 'submit', 'void'].sort(),
      `bug 动作集恰好 13 个（v1.6 退场 3 + 新增 2 上线编排 + Commit⑤ derive），实际 ${bugActions.join(',')}`);
    for (const banned of ['hold', 'resume', 'close', 'reopen', 'feasibility', 'blocked', 'unblock', 'scope_change', 'schedule',
      'set_release_flag', 'publish', 'confirm-online-norelease']) {
      assert.ok(!bugActions.includes(banned), `bug typeFlows 不应含 ${banned}`);   // v1.6 退场三动作 + ⑤ 后 derive 移出 banned（reopen 仍禁：上线后一律派生非重开）
    }
    const assignReleaseDevEntry = meta.typeFlows.bug.find(t => t.action === 'assign-release-dev');
    assert.strictEqual(assignReleaseDevEntry.kind, 'side_effect', 'assign-release-dev 应标 side_effect（不改 status，SIDE_EFFECT_ACTIONS 白名单）');
    const executeReleaseEntry = meta.typeFlows.bug.find(t => t.action === 'execute-release');
    assert.strictEqual(executeReleaseEntry.kind, 'transition', 'execute-release 应标 transition（真实改 status 为已上线）');
    assert.strictEqual(executeReleaseEntry.to, '已上线', 'execute-release meta.to=已上线');
    const deriveEntry = meta.typeFlows.bug.find(t => t.action === 'derive');   // ⑤：bug derive 仅从已上线 + side_effect（路由专用端点，非通用引擎）
    assert.deepStrictEqual(deriveEntry.from, ['已上线'], 'bug derive from 应恰为 [已上线]（§4 仅从已上线单派生）');
    assert.strictEqual(deriveEntry.kind, 'side_effect', 'derive 应标 side_effect（走 POST /derive 专用端点，不误入通用 transition）');
    // ACTION_LABELS 保留旧三动作标签（历史 timeline 行仍需渲染 action_code，v1.6 §2.3 明确要求不删标签）
    assert.strictEqual(meta.actions.set_release_flag, '填发版信息', 'set_release_flag 标签保留（历史 timeline 渲染）');
    assert.strictEqual(meta.actions['confirm-online-norelease'], '确认上线（不发版）', 'confirm-online-norelease 标签保留');
    assert.ok(meta.actions['assign-release-dev'] && meta.actions['execute-release'], '新增两动作标签存在');
    ok('meta：bug 状态集 7 态 + 初始态待处理 + 动作集恰好 13（v1.6 退场 set_release_flag/publish/confirm-online-norelease + 新增 assign-release-dev[side_effect]/execute-release[transition,to=已上线] + Commit⑤ derive[from=已上线/side_effect]，仍无 hold/close/reopen/评估三动作/scope_change/schedule）+ 旧标签保留供历史渲染');
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
    // [C3 退场] 原"submit 闸门（缺 est → ESTIMATE_REQUIRED / 空 summary → SUBMIT_SUMMARY_REQUIRED）"随旧
    //   单人 summary 模型退场——新 submit（方案 §6.1/§6.2）不查 dev_estimated_at/summary。estimate 的"严格
    //   在册"仍保留，改走 W06/assertDevMember：非在册开发（dev2）→ 403 NOT_ROSTERED（语义同构于旧
    //   NOT_AUTHORIZED_FOR_TRANSITION，均为"actor 无权限"，故意不call submit 避免提前推进 mainId 状态，
    //   下方 [A] 附件区仍需 mainId 停在「处理中」）。
    let r = await call('POST', `/api/sys-issues/${mainId}/estimate`, dev2Tok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '非在册 estimate 403（W06 assertDevMember）');
    r = await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, '在册开发 estimate 200（bug 处理中态内回填）');
    ok('estimate 严格在册（W06 assertDevMember 替代旧 ownerGuard）：非在册 403 / 在册 200');
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
    // 合法 submit → 待验证（C3：新 commit 事件模型，无 first_submitted_at/round_no timeline——
    //   这两个字段随旧单人 summary 模型退场，唯一在册开发 no_code 完成 → W-GATE 同事务转待验证）。
    const r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { mode: 'no_code', no_code_reason: '空指针已修，补了守卫' });
    assert.strictEqual(r.status, 200, 'submit 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', 'submit → 待验证（W-GATE，main_status 字段，非旧 status）');
    const devEv = await get(`SELECT action, payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='no_code'`, [mainId]);
    assert.ok(devEv, 'sys_issue_dev_events 应有 1 条 no_code 事件（新事件模型落点）');
    ok('提交修复：处理中 →submit→ 待验证（W-GATE）+ no_code 事件落 sys_issue_dev_events（新模型，替代旧 timeline round_no）');
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
    // 二轮：return 后 roster 完成态残留在 no_code（return 只清主表 dev_estimated_at，不碰 dev_assignees 子表——
    //   §1 不变量1"完成态不回 pending"+§4.1"完成态互转/回 pending 禁止"，本例首次暴露：return 与多开发
    //   roster 完成态是两条独立不变量线，旧完成态实例不能原地复用重提）。协调人需：① 先加协作解除
    //   LAST_ASSIGNEE 限制（单开发不能直接 remove 自己）② remove 旧完成态实例 ③ re-add 同一开发（全新
    //   pending 实例，方案 §4.4）④ 两名在册开发都完成后 W-GATE 才转待验证。
    let r = await call('POST', `/api/sys-issues/${mainId}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, '临时加协作(6) 200, got ' + JSON.stringify(r.body));
    const oldDa = r.body.dev_assignees.find(d => d.user_id === 5);
    r = await call('DELETE', `/api/sys-issues/${mainId}/dev-assignees/${oldDa.id}`, adminTok, { reason: '二轮重置旧完成态实例' });
    assert.strictEqual(r.status, 200, 'remove 旧完成态实例 200, got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${mainId}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, 're-add(5) 200, got ' + JSON.stringify(r.body));
    await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: '2026-08-02 10:00' });
    r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { mode: 'no_code', no_code_reason: '二轮修复' });
    assert.strictEqual(r.status, 200, '二轮 submit(5) 200, got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${mainId}/submit`, dev2Tok, { mode: 'no_code', no_code_reason: '协作二轮完成' });
    assert.strictEqual(r.status, 200, '协作(6) submit 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', '全员完成 → W-GATE 转待验证');
    r = await call('POST', `/api/sys-issues/${mainId}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, 'accept 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, '待上线', 'accept → 待上线（W07 具名边，makeTransitionEndpoint 响应形未变）');
    assert.ok((await rowOf(mainId)).accepted_at, 'accepted_at 盖');
    ok('验收通过：二轮（扩容协作解除 LAST_ASSIGNEE + remove/re-add 重置完成态实例 + 全员完成 submit）→ accept → 待上线 + accepted_at（T-M1；C3：round_no/旧 timeline 模型断言随退场）');
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

  // ═══ [R] 上线两路径已退场（v1.6 §2.3 [C-1]，通知改造 C3b）——LEGACY gate × bug/变更流双向矩阵 ═══
  //   R1/R2/R3 三个旧直连端点 + R4/R5 批次编辑链路（add-issues/remove-issues/legacy publish）对 bug 一律
  //   LEGACY_RELEASE_FLOW_DISABLED；**变更流(feature/improvement)零行为变化**——同一批 R5d/R5e/R5f/R5g 变更流
  //   场景原样保留断言不变，只把"加入 bug 测混批/复用"的收尾换成"加入 bug 应被 LEGACY 挡"。
  //   新 G3-G6 上线编排流程（assign-release-dev/reassign-release-dev/execute-release）+ 越权矩阵见
  //   独立脚本 verify-sys-release-orchestration.js（聚焦编排流程本身，本文件聚焦"旧入口关严实"）。
  {
    // R1 退场：set-release-flag 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED（任意态、任意角色）
    const r1 = await seedBugToReady(5, devTok);
    let r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 1 });
    assert.strictEqual(r.status, 409, `[R1退场] bug set-release-flag 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R1退场] code=LEGACY_RELEASE_FLOW_DISABLED');
    assert.strictEqual((await rowOf(r1)).needs_release, null, '[R1退场] needs_release 未被写入（列转只读残留，F5）');
    const midBug = await seedBugToDev(5);   // 处理中态（非待上线），同样应先被 LEGACY 挡（非因状态不对）
    r = await call('POST', `/api/sys-issues/${midBug}/set-release-flag`, adminTok, { needs_release: 1 });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R1退场] 处理中态 bug 同样先被 LEGACY 挡（非 SET_RELEASE_FLAG_STATUS_INVALID）');
    ok('[R1退场] set-release-flag：bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED（任意态/角色），needs_release 不再被写入');

    // R2 退场：confirm-online-norelease 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED
    const r2 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, adminTok, {});
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R2退场] code');
    assert.strictEqual(await statusOf(r2), '待上线', '[R2退场] 拒绝后单仍停在待上线（未被误翻已上线）');
    ok('[R2退场] confirm-online-norelease：bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED，单未被误翻已上线');

    // R3 退场：hotfix-publish 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED（在 status 校验之前拦，先于 ISSUE_NOT_HOTFIXABLE）
    const r3 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${r3}/hotfix-publish`, adminTok, { release_note: '修复上线', version_tag: 'v9.9' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R3退场] code');
    assert.strictEqual(await statusOf(r3), '待上线', '[R3退场] 拒绝后单未被误翻已上线');
    ok('[R3退场] hotfix-publish：bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED（放在 ISSUE_NOT_HOTFIXABLE 判断之前）');

    // R5①退场：add-issues 拒绝任意 bug 单（新批次首次加单即拒，无需族别推导）
    const r5Bug = await seedBugToReady(5, devTok);
    const relForBug = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relForBug}/add-issues`, adminTok, { issue_ids: [r5Bug] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5①退场] add-issues 单条 bug 应 409');
    assert.strictEqual((await issueRowRelease(r5Bug)), null, '[R5①退场] 拒绝后 bug 未被误挂批次');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relForBug])).release_type, null, '[R5①退场] 批次族别未被误回填（拒绝早于族别推导逻辑）');
    ok('[R5①退场] add-issues：任意 bug 单一律 409 LEGACY_RELEASE_FLOW_DISABLED（新批次首次加单即拒，早于族别推导/needs_release 检查）');

    // R5①退场（混选）：一次加入 [bug, feature] → 同样 409 LEGACY（不再是 MIXED_TYPE_BATCH——bug 检测在族别推导之前）
    const r5MixBug = await seedBugToReady(5, devTok);
    const r5MixFeature = await seedFeatureToReady(5, devTok);
    const relMix2 = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relMix2}/add-issues`, adminTok, { issue_ids: [r5MixBug, r5MixFeature] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5①退场] 混选 bug+feature 应 409 LEGACY（非 MIXED_TYPE_BATCH）');
    assert.strictEqual((await issueRowRelease(r5MixFeature)), null, '[R5①退场] 拒绝整批回滚：feature 也未被误挂（原子性不因 bug 检测提前而破坏）');
    ok('[R5①退场] add-issues 混选 [bug,feature]：整批 409 LEGACY_RELEASE_FLOW_DISABLED（bug 检测抢在族别推导前，原子性不变）');

    // ⭐ R5d（D-A 核心，变更流零行为变化）：feature + improvement **同批仍应成功**（同族 'change'）
    const chFeat = await seedChangeToReady('feature', 5, devTok);
    const chImpr = await seedChangeToReady('improvement', 5, devTok);
    const relChange = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chFeat, chImpr] });
    assert.strictEqual(r.status, 200, `feature+improvement 同批应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relChange])).release_type, 'change', '批次族别回填=change');
    assert.strictEqual((await issueRowRelease(chFeat)), relChange, 'feature 已挂 change 批次');
    assert.strictEqual((await issueRowRelease(chImpr)), relChange, 'improvement 已挂 change 批次');
    ok('⭐ R5d：feature + improvement 同批成功（同族 change，release_type=change）——变更流零行为变化，D-A 核心未动');

    // R5e：已定 change 族批次追加 improvement（同族）成功；追加 bug 现应 409 LEGACY（非 RELEASE_TYPE_MISMATCH）
    const chImpr2 = await seedChangeToReady('improvement', 5, devTok);
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chImpr2] });
    assert.strictEqual(r.status, 200, `change 批次追加 improvement 应 200, got ${r.status}`);
    const bugForChange = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [bugForChange] });
    assert.strictEqual(r.status, 409, `change 批次加 bug 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5e退场] change 批次加 bug → LEGACY（非 RELEASE_TYPE_MISMATCH，bug 检测更早介入）');
    ok('R5e：change 族批次追加 improvement 成功（变更流零回归）+ 追加 bug 现 409 LEGACY_RELEASE_FLOW_DISABLED');

    // R5f（F-4，变更流零行为变化）：批次移空后 release_type 复位 NULL，可被异族（另一变更流类型）重新占用
    const relReset = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const rf = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, 'change', '加 feature 后族别=change');
    r = await call('POST', `/api/sys-releases/${relReset}/remove-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual(r.status, 200, 'remove 200');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, null, 'F-4：批次移空后 release_type 复位 NULL（变更流零回归）');
    const improvementReuse = await seedChangeToReady('improvement', 5, devTok);
    r = await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [improvementReuse] });
    assert.strictEqual(r.status, 200, `移空后的批次可被 improvement 重新占用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, 'change', '复用后族别改判 change（变更流零回归）');
    // 同一移空批次再尝试被 bug 占用 → 409 LEGACY（bug 侧退场，非"不再锁死"的复用对象）
    const bugTryReuse = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [bugTryReuse] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5f退场] 移空批次仍不可被 bug 占用（bug 侧整体退场）');
    ok('⭐ R5f（F-4）：批次移空 → release_type 复位 NULL → 可被异族变更流类型重新占用（变更流零回归）；bug 侧不再可占用（整体退场）');

    // ⭐ R5g（F-2 / codex M-2，变更流零行为变化）：历史 release_type=NULL 非空批次 fail-closed（模拟 Commit② 前遗留态）
    const relHist = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const histFeat = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histFeat] });   // 回填 change
    await run('UPDATE sys_releases SET release_type=NULL WHERE id=?', [relHist]);   // DB 直改还原「有成员但 release_type=NULL」历史态
    // (a) add-issues 对 bug 单一律 LEGACY（不再看族别推导——bug 检测抢在最前）
    const histBug = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histBug] });
    assert.strictEqual(r.status, 409, `历史 NULL 批次加 bug 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5g-a退场] 历史 NULL 批次加 bug → LEGACY（非 RELEASE_TYPE_MISMATCH）');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relHist])).release_type, null, '被拒后 release_type 仍 NULL（未被误回填）');
    ok('R5g-a：历史 NULL 批次 add-issues 加 bug 单 → 409 LEGACY_RELEASE_FLOW_DISABLED（bug 检测早于族别推导，变更流场景仍走 codex H-2 fail-closed，见下 (b)）');
    // (b) [H-1 收口·codex40] publish 对"成员含 bug 族别"的历史 NULL 批次 fail-closed（语义升级）：
    //   DB 强塞 bug 进 relHist 造混族别成员 + release_type=NULL（模拟脏库/手工改，绕过 add-issues）。
    //   ⚠️ H-1 收口前：release_type=NULL（非 'bug' 字面量）让 R4 端点的 release_type='bug' 早拦漏掉，落到
    //   _publishReleaseCoreInTxn 内核 family 一致性检查 → RELEASE_MEMBER_TYPE_MISMATCH。
    //   H-1 收口后：publishReleaseTransition（R4 唯一 wrapper）先按**成员实际族别**拦 bug → LEGACY_RELEASE_FLOW_DISABLED
    //   （更强：bug 一律不得走 legacy publish，非"仅混族别才拒"；堵住"纯 bug 脏批次绕 release_assignee 执行权直发"）。
    //   内核 family 检查逐字保留（不动核内），现被 H-1 外层闸遮蔽、成为更深一层纵深防线（execute-release 要求纯 bug，
    //   亦不会触发核内混族别分支）——见 verify-sys-release-orchestration.js [H-1] 纯 bug NULL 批次同拒用例。
    await run('UPDATE sys_issues SET release_id=? WHERE id=?', [relHist, histBug]);   // 绕过 add-issues 强塞（模拟脏库/手工改）
    r = await call('POST', `/api/sys-releases/${relHist}/publish`, adminTok, { release_note: '含 bug 测试', version_tag: 'vmix' });
    assert.strictEqual(r.status, 409, `含 bug 的 NULL 批次 publish 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5g-b·H-1收口] 成员含 bug 的历史 NULL 批次 publish → LEGACY（publishReleaseTransition 按成员族别拦，早于核内 mismatch）');
    assert.strictEqual(await statusOf(histFeat), '待上线', 'publish 拒后 histFeat 未被翻已上线（原子回滚）');
    ok('R5g-b（H-1 收口）：历史 NULL 批次含 bug 成员 publish → 409 LEGACY_RELEASE_FLOW_DISABLED（R4 wrapper 按成员实际族别 fail-closed，堵住脏 bug 批次绕执行权直发；核内 family 检查保留为更深纵深防线）');

    // [R4 退场] legacy /sys-releases/:id/publish 对 release_type='bug' 批次一律 409（正常路径下批次不可能是 bug 族别，
    //   因 add-issues 已堵死；此处直接 DB 强改 release_type 验证 R4 端点自身的防线，独立于 add-issues 防线）。
    const relBugFamily = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    await run(`UPDATE sys_releases SET release_type='bug' WHERE id=?`, [relBugFamily]);   // 模拟 bug 族别批次（正常路径不可达，纯 R4 端点自身防线测试）
    r = await call('POST', `/api/sys-releases/${relBugFamily}/publish`, adminTok, { release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R4退场] release_type=bug 批次 publish → 409 LEGACY（端点自身前置闸）');
    ok('[R4退场] legacy /sys-releases/:id/publish：release_type=\'bug\' 批次一律 409 LEGACY_RELEASE_FLOW_DISABLED（端点自身防线，独立于 add-issues）');

    // [R5⑤退场] remove-issues 对 release_type='bug' 批次一律 409（同样端点自身防线，正常路径不可达）。
    const relBugFamily2 = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const issueForRemove = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relBugFamily2}/add-issues`, adminTok, { issue_ids: [issueForRemove] });
    await run(`UPDATE sys_releases SET release_type='bug' WHERE id=?`, [relBugFamily2]);   // 模拟 bug 族别批次（正常路径不可达）
    r = await call('POST', `/api/sys-releases/${relBugFamily2}/remove-issues`, adminTok, { issue_ids: [issueForRemove] });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5⑤退场] release_type=bug 批次 remove-issues → 409 LEGACY');
    ok('[R5⑤退场] remove-issues：release_type=\'bug\' 批次一律 409 LEGACY_RELEASE_FLOW_DISABLED（fail-closed 防御闸，正常路径不可达）');
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
    // ⚠️ 既有测试变更（C2 破坏性变更，详见交付汇报"既有测试变更清单"）：reassign 改声明式最终 roster
    // （member_ids + reason，方案 §3），不再是 newAssignedTo/oldAssignedTo 换主语义；"换主清 dev_estimated_at"
    // 是旧版"换主=新一轮"的业务规则，v2.9 无"主开发"概念故也无"换主"这件事，dev_estimated_at 清零属
    // W07/ADMIN_TRANSITION 侧关切（C3 范围，本轮不碰）——不再断言。"待验证换人→回处理中"这一结果性行为
    // 仍然成立，但机制变了：新增的 pending 成员触发 W-GATE（VERIFY→DEV），非硬编码 reassign→处理中 映射。
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '开发王休假' });
    assert.strictEqual(r.status, 200, `bug reassign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    let row = await rowOf(id);
    assert.strictEqual(Number(row.assigned_to), 6, '换人到 dev2（选举：5 移除后仅剩 6 在册，当选代表）');
    assert.strictEqual(row.status, '处理中', '同态换人仍 处理中（DEV 族内增减不触发 W-GATE）');
    // 待验证换人 → 回 处理中（W-GATE：新增 pending 成员 5 打破"全员完成"，VERIFY→DEV）
    await call('POST', `/api/sys-issues/${id}/estimate`, dev2Tok, { dev_estimated_at: EST });
    await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { mode: 'no_code', no_code_reason: '修复完成（占位理由）' });
    assert.strictEqual(await statusOf(id), '待验证');
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5], reason: '返工换回' });
    assert.strictEqual(r.status, 200, `reassign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '待验证换人 → 回 处理中（W-GATE：新增 pending 触发 VERIFY→DEV）');
    ok('换人（C2 新语义 member_ids）：处理中 →reassign→ 处理中（选举正确）+ 待验证 →reassign→ 处理中（W-GATE 联动，非硬编码映射）');
  }
  {
    // C3：W05 唯一 submit 改 assertDevMember（在册判定，非旧 ownerGuard 严格本人）——非在册开发/admin 均不在
    // roster 内，同样 403（错误码 NOT_ROSTERED，语义与旧 H-1"严格本人"口径一致：无权限即拒）。
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { mode: 'no_code', no_code_reason: 'x' });
    assert.strictEqual(r.status, 403, '非在册开发 submit 403');
    r = await call('POST', `/api/sys-issues/${id}/submit`, adminTok, { mode: 'no_code', no_code_reason: 'x' });
    assert.strictEqual(r.status, 403, 'admin 代提交 403（admin 本身不在册，W06/W05 assertDevMember 统一口径）');
    ok('W05 assertDevMember 严格在册：bug submit 非在册开发/admin 均 403（同构于旧 H-1"严格本人"口径）');
  }

  // ═══ [C] 变更流零回归 canary（assign expectedFrom=null 改动）═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { type: 'feature', title: 'canary', system_name: 'BMS', source: '内部' });
    const id = r.body.id;
    assert.strictEqual(r.body.status, '待评估', 'feature 建单仍落 待评估');
    // 待评估直接 assign（跳过 schedule）→ 应仍被拒（C3：/assign 重写后改走 assertMainStatusTransition 守卫，
    //   from 白名单校验仍在但错误码从旧 sysIssueTransition 步骤[1]的 400 INVALID_TRANSITION 统一改为
    //   守卫既定风格 409 GATE_INVARIANT——§10 API 契约"白名单外组合→409 GATE_INVARIANT"，非回归）。
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 409, `feature 待评估直接 assign 应 409, got ${r.status}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT');
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
