// 验证脚本：系统迭代 角色权限重构 C2b — 通知操作者留痕 sent_by（方案 v1.7 §4-C2b）
//   用法：node scripts/verify-sys-notify-sent-by.js
//
// 背景（codex 167 号 HIGH-2）：生产有 **6 个 active admin** + 受理人[13] = 7 个可能触发者，
//   而 creator / requester / dev(子表) / relay / release_executor 五个通道只记了"发过没、成没成、
//   message_key"，**没记谁发的** —— 事后无法区分是谁给业务方发了那条钉钉。
//   `tech_lead` 通道早有 `tech_lead_notify_sent_by` + 契约守卫，本片是把该范式复刻到其余通道。
//
// ⚠️ 可达性事实（v1.7 §4-C2b 源码核实·勿按"五通道都能手动发"想当然）：
//   · 手动端点可达：creator / requester / dev(子表) / relay
//   · ⚠️ 2026-07-30 更新：release_executor(单条 + 批量) 随旧上线编排家族封禁退场——原本可达的
//     两个写点（notify-release-executor 单条 + notify-release-executor-batch 批量）现一律 409
//     LEGACY_RELEASE_FLOW_DISABLED，不再产生任何 sent_by 落库；本文件对应用例（原 [B] 批量端点
//     整段 + [R]①换上线开发重置点）已删除，release_executor 通道的封禁契约覆盖转交
//     verify-sys-release-orchestration.js（不再验证"谁发的"，只验证"发不出去 + 零副作用"）。
//   · 自动派发路径（dispatchSysNotify）当前**恒早返回**（isAutoNotifyEnabled 全 type 关闭），
//     故 `recordSysDevNotify`（dev 主表）当前**无可达调用路径**；requester 的自动分支同理不可达。
//     它们仍补了 sent_by + 契约守卫：将来恢复自动派发时缺 actor 会**当场抛错**（fail-closed），
//     而不是静默写出一批分不清来源的行。本脚本用直调守卫覆盖这一层。
//
// 覆盖：
//   [S] schema：主表 5 列 + 子表 1 列存在；子表列入 SYS_DEV_ASSIGNEES_KEY_COLS「全列在」锚点
//   [G] ⭐ 契约守卫：sentBy 为 undefined/null/0/-1/'abc'/'12'(字符串数字放行) 的判定 + **抛错时不写库**
//   [N] 四通道手动端点正例：**admin 与受理人分别触发 → sent_by 各记各的**（多操作者归属=本片存在的理由）
//   [B]（已随旧上线编排家族封禁退场，2026-07-30——批量端点 notify-release-executor-batch 现一律
//        409，原"自己拼 UPDATE 不走 record helper"用例随之作废，见文件内 tombstone）
//   [R] 重置点：回受理门(resubmit) → relay 组 sent_by 清空；换代表(electRepresentative) → dev 主表
//        通道 sent_by 清空（原"换上线开发 → release 组归零"子块随封禁退场，见文件内 tombstone）
//   [I] 不变量全表扫描：`sent|failed ⟹ sent_by 非空` 且 `not_sent ⟹ sent_by 空`
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-notify-sent-by-secret';
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

// 钉钉发送 stub：默认成功；置 failNext 可造一次 failed（验证 failed 也必须记 sent_by）
let dingtalkFailNext = false;
async function mockSendIssueDingtalkRaw() {
  if (dingtalkFailNext) { dingtalkFailNext = false; return { ok: false, message_key: null, reason: 'network' }; }
  return { ok: true, message_key: 'stub-key-' + Math.random().toString(36).slice(2, 8) };
}
async function mockSendIssueDingtalkToRequester() {
  if (dingtalkFailNext) { dingtalkFailNext = false; return { ok: false, message_key: null, reason: 'network' }; }
  return { ok: true, message_key: 'stub-req-' + Math.random().toString(36).slice(2, 8) };
}

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
  sendIssueDingtalkToRequester: mockSendIssueDingtalkToRequester,
  getSafePlatformBaseUrl: async () => '',
});
const I = mod._internals;

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

// ⚠️ 测试 id 与生产 users.id 无对应关系（授权只看 JWT role 与白名单常量 SYS_INTAKE_LIAISON=[13]）。
//   **两个 admin 是刻意的**：本片的动机就是"6 个 admin 谁发的分不清"，单 admin 夹具测不出归属
//   （[[feedback_test_assertion_self_error]] 夹具规模不足形态）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '第二管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
// [C10-fix2 LOW-1②] 非绑定 eligible actor（role=user·非本单绑定对接人 13·非 admin）——验证 notify-creator/
//   requester 的 enforceBinding 绑单精判：粗筛放行（user 是候选 allowlist），但 handler 内因非该单对接人拒 403。
const dev5Tok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const CONTRACT_V = 2;

// 主表五通道的 (status 列, sent_by 列)
const MAIN_CHANNELS = [
  ['notify_status', 'notify_sent_by'],
  ['requester_notify_status', 'requester_notify_sent_by'],
  ['creator_notify_status', 'creator_notify_sent_by'],
  ['relay_notify_status', 'relay_notify_sent_by'],
  ['release_assignee_notify_status', 'release_assignee_notify_sent_by'],
];

// 全表不变量扫描：sent|failed ⟹ sent_by 非空；not_sent ⟹ sent_by 空
async function assertInvariant(label) {
  for (const [st, sb] of MAIN_CHANNELS) {
    const bad1 = await all(`SELECT id, ${st} s, ${sb} b FROM sys_issues WHERE ${st} IN ('sent','failed') AND ${sb} IS NULL`);
    assert.strictEqual(bad1.length, 0, `${label}：${st} 为 sent/failed 却无 ${sb}（违约行 ${JSON.stringify(bad1)}）`);
    const bad2 = await all(`SELECT id, ${st} s, ${sb} b FROM sys_issues WHERE ${st}='not_sent' AND ${sb} IS NOT NULL`);
    assert.strictEqual(bad2.length, 0, `${label}：${st} 为 not_sent 却留着 ${sb}（违约行 ${JSON.stringify(bad2)}）`);
  }
  const badSub1 = await all(`SELECT id FROM sys_issue_dev_assignees WHERE notify_status IN ('sent','failed') AND notify_sent_by IS NULL`);
  assert.strictEqual(badSub1.length, 0, `${label}：子表 sent/failed 却无 notify_sent_by`);
  const badSub2 = await all(`SELECT id FROM sys_issue_dev_assignees WHERE notify_status='not_sent' AND notify_sent_by IS NOT NULL`);
  assert.strictEqual(badSub2.length, 0, `${label}：子表 not_sent 却留着 notify_sent_by`);
}

const createBug = (extra) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: CONTRACT_V, type: 'bug', title: 'C2b 测试单', system_name: 'BMS', source: '内部',
    description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13,
    requester_name: '业务小王', requester_phone: '13900000001', ...extra });

// 把单据推到指定状态（直改 DB —— 本脚本焦点是 sent_by 落库，不重复测状态机）
const setStatus = (id, status) => run(`UPDATE sys_issues SET status=? WHERE id=?`, [status, id]);

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone, dingtalk_user_id) VALUES
    (1,'admin','管理员','admin','13800000001','ding1'),(2,'admin2','第二管理员','admin','13800000002','ding2'),
    (5,'dev','开发王','user','13800000005','ding5'),(6,'dev6','开发李','user','13800000006','ding6'),
    (13,'wangtaotao','示例对接人','user','19900000024','ding13')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [S] schema ═══
  {
    const cols = (await all(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
    for (const [, sb] of MAIN_CHANNELS) assert.ok(cols.includes(sb), `sys_issues 缺列 ${sb}`);
    const subCols = (await all(`PRAGMA table_info(sys_issue_dev_assignees)`)).map(c => c.name);
    assert.ok(subCols.includes('notify_sent_by'), 'sys_issue_dev_assignees 缺列 notify_sent_by');
    // 子表是"结构全列在"readiness 模型 —— 新列必须同步入锚点，否则"表在但缺该列"会被判 ready，
    //   随后通知写入撞 no such column → 端点 500（这正是 C-1 顺序铁律要防的形态）。
    assert.ok(I.SYS_DEV_ASSIGNEES_KEY_COLS.includes('notify_sent_by'),
      'notify_sent_by 必须入 SYS_DEV_ASSIGNEES_KEY_COLS（子表用全列在模型）');
    // tech_lead 通道的既有 sent_by 仍在（本片是复刻它，不是替换它）
    assert.ok(cols.includes('tech_lead_notify_sent_by'), 'tech_lead_notify_sent_by 应仍在（C2b 的范式来源）');
    ok('[S] schema：主表 5 个 sent_by + 子表 1 个齐全 + 子表列入 KEY_COLS 锚点 + tech_lead 原范式列仍在');
  }

  // ═══ [G] ⭐ 契约守卫：非正整数必须抛，且抛了就不能写库 ═══
  {
    // 类型边界（codex C2b 审 MED 收口）：**`true` 必须被拒** —— 裸 Number(true)===1 会把审计归属
    //   错记到 user 1 头上，而"错记"比"没记"更糟（查审计的人会拿到一个看起来可信的错误答案）。
    //   带空白/前导零/正号的字符串同样拒：它们不是 users.id 的合法书写形式，放行等于默许上游传脏值。
    for (const bad of [undefined, null, 0, -1, '', 'abc', NaN, 1.5, {}, [], true, false,
      '1.5', ' 13 ', '013', '+13', '-1', Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => I.assertNotifySentBy('probe', bad), /sent_by 必须为正整数/,
        `sentBy=${JSON.stringify(bad) ?? String(bad)} 应抛契约错（写 NULL 或错值都会污染审计归属）`);
    }
    assert.strictEqual(I.assertNotifySentBy('probe', 7), 7, '正整数放行并归一为 number');
    assert.strictEqual(I.assertNotifySentBy('probe', '13'), 13, '十进制整数字符串放行并归一（req.user.id 可能是字符串）');

    // ⭐ 抛错时**不写库**：直调 record helper，断言异常抛出且该行通知列纹丝不动
    const r = await createBug({ title: 'G-守卫不写库' });
    const id = r.body.id;
    const before = await get(`SELECT creator_notify_status, creator_notify_sent_by, notify_status FROM sys_issues WHERE id=?`, [id]);
    await assert.rejects(() => I.recordSysCreatorNotify(id, true, 'k', null, null), /sent_by 必须为正整数/,
      'recordSysCreatorNotify 缺 sentBy → 抛');
    await assert.rejects(() => I.recordSysDevAssigneeNotify(id, 5, true, 'k', null, 0), /sent_by 必须为正整数/,
      'recordSysDevAssigneeNotify sentBy=0 → 抛');
    const after = await get(`SELECT creator_notify_status, creator_notify_sent_by, notify_status FROM sys_issues WHERE id=?`, [id]);
    assert.deepStrictEqual(after, before, '⭐ 契约错时通知列**一列未动**（守卫在 UPDATE 之前，不是写完再校验）');
    ok('[G] ⭐ 契约守卫：18 种非法入参全抛（含 **true**／小数串／带空白串／前导零／超安全整数）+ 十进制整数串归一 + **抛错时一列不写**');
  }

  // ═══ [N] 四通道手动端点：admin 与受理人分别触发，sent_by 各记各的 ═══
  {
    // ① creator 通道（self-guard：建单人是 admin(1)，故用 admin2 与受理人触发才会真发）
    const c1 = await createBug({ title: 'N-creator' });
    await setStatus(c1.body.id, '待验证');
    const rc1 = await call('POST', `/api/sys-issues/${c1.body.id}/notify-creator`, admin2Tok);
    assert.strictEqual(rc1.status, 200, `admin2 通知建单人 200（实际 ${rc1.status}：${JSON.stringify(rc1.body)}）`);
    assert.strictEqual(rc1.body.creator_notify_status, 'sent', 'creator 通道真发送（非 skipped）');
    let row = await get(`SELECT creator_notify_sent_by FROM sys_issues WHERE id=?`, [c1.body.id]);
    assert.strictEqual(row.creator_notify_sent_by, 2, '⭐ creator sent_by=2（admin2 触发）');

    const c2 = await createBug({ title: 'N-creator-2' });
    await setStatus(c2.body.id, '待验证');
    const rc2 = await call('POST', `/api/sys-issues/${c2.body.id}/notify-creator`, liaisonTok);
    assert.strictEqual(rc2.status, 200, '受理人通知建单人 200');
    row = await get(`SELECT creator_notify_sent_by FROM sys_issues WHERE id=?`, [c2.body.id]);
    assert.strictEqual(row.creator_notify_sent_by, 13,
      '⭐⭐ 同一动作换人触发 → sent_by=13 —— **归属真的分得开**，这正是本片存在的理由');

    // ② requester 通道（唯一对业务方发声的通道·167 号 HIGH-2 点名场景）
    const q = await createBug({ title: 'N-requester' });
    await setStatus(q.body.id, '待验证');
    const rq = await call('POST', `/api/sys-issues/${q.body.id}/notify-requester`, liaisonTok);
    assert.strictEqual(rq.status, 200, `通知业务方 200（实际 ${rq.status}：${JSON.stringify(rq.body)}）`);
    assert.strictEqual(rq.body.requester_notify_status, 'sent', 'requester 真发送');
    row = await get(`SELECT requester_notify_sent_by FROM sys_issues WHERE id=?`, [q.body.id]);
    assert.strictEqual(row.requester_notify_sent_by, 13, '⭐ 业务方那条钉钉查得到是谁发的（sent_by=13）');

    // ③ requester 通道 **failed 也必须记**（failed ⟹ sent_by 非空，与 sent 同等）
    const qf = await createBug({ title: 'N-requester-failed' });
    await setStatus(qf.body.id, '待验证');
    dingtalkFailNext = true;
    const rqf = await call('POST', `/api/sys-issues/${qf.body.id}/notify-requester`, adminTok);
    assert.strictEqual(rqf.status, 200, '发送失败仍返 200（best-effort 语义）');
    row = await get(`SELECT requester_notify_status, requester_notify_sent_by FROM sys_issues WHERE id=?`, [qf.body.id]);
    assert.strictEqual(row.requester_notify_status, 'failed', '本次确实落 failed（stub 造的失败真生效）');
    assert.strictEqual(row.requester_notify_sent_by, 1, '⭐ failed 同样记 sent_by=1（"谁尝试发的"与"谁发成了"同等重要）');

    // ④ dev 子表通道（逐 dev 手动通知）
    const d = await createBug({ title: 'N-dev' });
    const did = d.body.id;
    await call('POST', `/api/sys-issues/${did}/intake-accept`, liaisonTok, {});
    const asg = await call('POST', `/api/sys-issues/${did}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(asg.status, 200, `受理人指派 200（实际 ${asg.status}：${JSON.stringify(asg.body)}）`);
    const rd = await call('POST', `/api/sys-issues/${did}/notify-developer`, liaisonTok, { dev_user_id: 5 });
    assert.strictEqual(rd.status, 200, `通知开发 200（实际 ${rd.status}：${JSON.stringify(rd.body)}）`);
    const sub = await get(`SELECT notify_status, notify_sent_by FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [did]);
    assert.strictEqual(sub.notify_status, 'sent', '子表通知落 sent');
    assert.strictEqual(sub.notify_sent_by, 13, '⭐ 子表 notify_sent_by=13（受理人触发）');
    await assertInvariant('[N] 后');
    ok('[N] 四通道手动端点：creator（admin2=2 / 受理人=13 **两人分得开**）+ requester（sent 与 **failed 都记**）+ dev 子表，sent_by 逐格正确');
  }

  // ═══ [NB] ⭐ C10-fix2 LOW-1②：非绑定 eligible 在 notify-creator/requester 上被绑单精判拒（enforceBinding 负例）═══
  //   dev5（role=user·过 requireIntakeLiaison 粗筛·但非本单绑定对接人 13·非 admin）→ handler 内
  //   sysManualNotifyGuard({enforceBinding:true}) → isBoundLiaisonOrAdmin 拒 → 403 NOT_BOUND_LIAISON + 零副作用。
  //   （补 notify-developer[c10 套件已覆盖]/两 resend[intake-schedule-c5/tech-lead-comment 已覆盖] 之外的两通道空白）
  {
    const cc = await createBug({ title: 'NB-creator-非绑定' });
    await setStatus(cc.body.id, '待验证');
    const rc = await call('POST', `/api/sys-issues/${cc.body.id}/notify-creator`, dev5Tok);
    assert.strictEqual(rc.status, 403, `[NB①] 非绑定 eligible(dev5) 发 notify-creator 应 403, got ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.code, 'NOT_BOUND_LIAISON', `[NB①] 确切码 NOT_BOUND_LIAISON（enforceBinding 绑单精判·非该单对接人拒），实得 ${rc.body && rc.body.code}`);
    const ccRow = await get(`SELECT creator_notify_status FROM sys_issues WHERE id=?`, [cc.body.id]);
    assert.strictEqual(ccRow.creator_notify_status, 'not_sent', '[NB①] 零副作用：creator_notify_status 未变');

    const qq = await createBug({ title: 'NB-requester-非绑定' });
    await setStatus(qq.body.id, '待验证');
    const rq = await call('POST', `/api/sys-issues/${qq.body.id}/notify-requester`, dev5Tok);
    assert.strictEqual(rq.status, 403, `[NB②] 非绑定 eligible(dev5) 发 notify-requester 应 403, got ${rq.status} ${JSON.stringify(rq.body)}`);
    assert.strictEqual(rq.body.code, 'NOT_BOUND_LIAISON', `[NB②] 确切码 NOT_BOUND_LIAISON，实得 ${rq.body && rq.body.code}`);
    const qqRow = await get(`SELECT requester_notify_status FROM sys_issues WHERE id=?`, [qq.body.id]);
    assert.strictEqual(qqRow.requester_notify_status, 'not_sent', '[NB②] 零副作用：requester_notify_status 未变');
    ok('[NB] ⭐ C10-fix2 LOW-1②：非绑定 eligible(dev5·过粗筛) 在 notify-creator/requester 上被 enforceBinding 绑单精判拒 403 NOT_BOUND_LIAISON + 零副作用（补两通道非绑定负例空白）');
  }

  // ═══ [B]（已随旧上线编排家族封禁退场，2026-07-30）═══
  //   原用例经 notify-release-executor-batch（批量·自拼 UPDATE 不走 record helper，"第 6 个写点"）+
  //   notify-release-executor（单条）两个写点验证 sent_by 落库——两个端点现一律 409
  //   LEGACY_RELEASE_FLOW_DISABLED，业务逻辑不可达，两个写点均无法再产生任何 sent_by 落库，用例
  //   随之整体删除。release_executor 通道的封禁契约覆盖见 verify-sys-release-orchestration.js
  //   （不再验证"谁发的"，只验证"发不出去 + 零副作用"）。

  // ═══ [R] 重置点：not_sent ⟹ sent_by 空 ═══
  //   ⚠️ 2026-07-30：原①"换上线开发（reassign-release-dev）→ release_assignee 组归零"随旧上线
  //   编排家族封禁一并删除——该端点现一律 409，不再触发任何重置逻辑，用例已作废。本块现只剩两个
  //   重置点（原②③，序号顺移为①②）。
  {
    // ① 回受理门（resubmit-intake）→ relay 组归零。先人为造一条 relay 已发态（该通道写路径随 C0 关闭 path B 退场）
    const y = await createBug({ title: 'R-回受理门' });
    const yid = y.body.id;
    await run(`UPDATE sys_issues SET status='待修改', relay_notified_user_id=5, relay_notified_user_name='开发王',
               relay_notify_status='sent', relay_notified_at=datetime('now','localtime'),
               relay_notify_message_key='k', relay_notify_sent_by=2 WHERE id=?`, [yid]);
    const rsb = await call('POST', `/api/sys-issues/${yid}/resubmit-intake`, adminTok, {});
    assert.strictEqual(rsb.status, 200, `resubmit-intake 200（实际 ${rsb.status}：${JSON.stringify(rsb.body)}）`);
    const yr = await get(`SELECT status, relay_notify_status s, relay_notify_sent_by b, relay_notified_user_id u FROM sys_issues WHERE id=?`, [yid]);
    assert.strictEqual(yr.status, '待受理', '回到待受理');
    assert.strictEqual(yr.s, 'not_sent', 'relay 通知态归零');
    assert.strictEqual(yr.u, null, 'relay 收件人归零');
    assert.strictEqual(yr.b, null,
      '⭐ relay_notify_sent_by 一并清 —— 该列是加在 intake-gate-sql.js 的**单一真相源**清单里的，不是在调用方手写');
    // ② ⭐ 换代表（electRepresentative）→ 主表 dev 通道归零（codex C2b 复审 MED 补）。
    //   为什么单独测：这是 MED-3 复查点名的 4 个重置点里**唯一只有 grep 结论、没有断言看着**的一个。
    //   而它的写法特殊 —— 重置片段是拼进选举 UPDATE 的 SQL 字符串（`notifyResetSql`），不是独立语句，
    //   最容易在后续重构里被整段替换掉。
    //   主表 dev 通道当前无可达发送路径（自动派发总闸关闭），故用直改 DB 造出"已发过"的前置态，
    //   再走真实的成员变更端点触发代表变化 —— 造态是假的，**被测的重置逻辑是真的**。
    const e = await createBug({ title: 'R-换代表' });
    const eid = e.body.id;
    await call('POST', `/api/sys-issues/${eid}/intake-accept`, liaisonTok, {});
    const a1 = await call('POST', `/api/sys-issues/${eid}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(a1.status, 200, `前置指派 200（实际 ${a1.status}：${JSON.stringify(a1.body)}）`);
    await run(`UPDATE sys_issues SET notify_status='sent', notified_at=datetime('now','localtime'),
               notify_message_key='k-elect', notify_sent_by=2 WHERE id=?`, [eid]);
    let er = await get(`SELECT assigned_to, notify_status s, notify_sent_by b FROM sys_issues WHERE id=?`, [eid]);
    assert.strictEqual(er.s, 'sent', '前置：dev 主表通知态=sent（否则本组测的是空气）');
    assert.strictEqual(er.b, 2, '前置：notify_sent_by 已落 2');
    const prevRep = er.assigned_to;
    // 改派换人 → electRepresentative 选出新代表 → repChanged=true → 触发重置片段
    const rea = await call('POST', `/api/sys-issues/${eid}/reassign`, liaisonTok, { member_ids: [6], reason: '换代表测重置' });
    assert.strictEqual(rea.status, 200, `改派 200（实际 ${rea.status}：${JSON.stringify(rea.body)}）`);
    er = await get(`SELECT assigned_to, notify_status s, notify_sent_by b FROM sys_issues WHERE id=?`, [eid]);
    assert.notStrictEqual(er.assigned_to, prevRep, '代表确实换了（否则 repChanged=false，重置分支根本没进）');
    assert.strictEqual(er.s, 'not_sent', '换代表后 dev 主表通知态归零');
    assert.strictEqual(er.b, null,
      '⭐ notify_sent_by 一并清空 —— 新代表还没被通知过，却记着"上一任是谁通知的"就是违约行');

    await assertInvariant('[R] 后');
    ok('[R] **两个**重置点均清 sent_by：回受理门（relay 组·单一真相源清单）+ **换代表（dev 主表·拼进选举 UPDATE 的片段）**（原"换上线开发→release 组"重置点随旧上线编排家族封禁退场，2026-07-30）');
  }

  // ═══ [H] ⭐ 投递历史与投递状态分离（对抗审 F8 收口）═══
  //   F8 的一半被 GPT 核推翻了（"不变量 not_sent⟹sent_by 空 在为信息销毁背书"不成立 —— 轮次状态就该重置）；
  //   但另一半成立：**手动通知从不写 timeline**，于是重置一发生，"上一轮那条钉钉是谁发的"全库消失，
  //   C2b 的审计承诺只在当前轮次内有效。修法=状态列照旧重置，另补一条只增的 timeline。
  //   本组要证明的正是：**重置之后，历史投递的操作者仍然查得到**。
  {
    // [2026-07-30 家族封禁改造] 原场景经 notify-release-executor + reassign-release-dev（均已封 409）验证
    //   "重置后历史留痕仍在"——但该机制（recordSysNotifyTimeline）是跨通道通用的，主张不该随封禁丢覆盖，
    //   改用 dev 通道等价重写：通知开发（受理人触发）→ 换代表重置轮次状态（[R]② 已证真重置）→ 留痕仍可查。
    const h = await createBug({ title: 'H-历史留痕' });
    const hid = h.body.id;
    await call('POST', `/api/sys-issues/${hid}/intake-accept`, liaisonTok, {});
    await call('POST', `/api/sys-issues/${hid}/assign`, liaisonTok, { assigned_to: 5 });
    const rn = await call('POST', `/api/sys-issues/${hid}/notify-developer`, liaisonTok, { dev_user_id: 5 });
    assert.strictEqual(rn.status, 200, `通知开发 200（实际 ${rn.status}：${JSON.stringify(rn.body)}）`);
    let sub5 = await get(`SELECT notify_sent_by b FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [hid]);
    assert.strictEqual(sub5.b, 13, '前置：子表状态列记着 sent_by=13');

    // 触发重置：换代表 → dev5 活动行退场（这是**正确行为**，轮次状态就该被抹掉）
    const chg = await call('POST', `/api/sys-issues/${hid}/reassign`, liaisonTok, { member_ids: [6], reason: 'H-换代表触发重置' });
    assert.strictEqual(chg.status, 200, `换代表 200（实际 ${chg.status}：${JSON.stringify(chg.body)}）`);
    sub5 = await get(`SELECT notify_sent_by b FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [hid]);
    assert.strictEqual(sub5, undefined, 'dev5 活动行已随换代表退场（轮次状态确实被抹掉，不是在测空气）');

    // ⭐ 关键断言：历史投递记录仍在 timeline 里，且能查出「是谁发的」
    const logs = await all(
      `SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent' ORDER BY id`, [hid]);
    assert.strictEqual(logs.length, 1, `应有 1 条通知留痕（实际 ${logs.length}）`);
    assert.strictEqual(logs[0].operator_id, 13,
      '⭐⭐ **重置之后仍查得到「上一轮是受理人发的」** —— 状态列可以被轮次抹掉，历史不行');
    assert.ok(/开发/.test(logs[0].summary), '留痕含通道');
    assert.ok(/id5/.test(logs[0].summary), '留痕含**当时的**收件人（换人后仍能还原发给过谁）');
    assert.ok(/成功/.test(logs[0].summary), '留痕含投递结果');

    // 失败也要留痕（"谁尝试发过"与"谁发成了"同等重要）
    const h2 = await createBug({ title: 'H-失败留痕' });
    await setStatus(h2.body.id, '待验证');
    dingtalkFailNext = true;
    await call('POST', `/api/sys-issues/${h2.body.id}/notify-requester`, liaisonTok);
    const logs2 = await all(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='notify_sent'`, [h2.body.id]);
    assert.strictEqual(logs2.length, 1, '失败投递同样留痕');
    assert.strictEqual(logs2[0].operator_id, 13, '失败留痕记的是尝试者(13)');
    assert.ok(/失败/.test(logs2[0].summary), '留痕标明失败');
    assert.ok(!/13900000001/.test(logs2[0].summary), '⭐ 业务方手机号在留痕里**已脱敏**（maskPhone），审计不等于裸存个人信息');
    ok('[H] ⭐ 投递历史独立于状态列：换代表重置后仍可查「上一轮谁发给谁、成没成」· 失败同样留痕 · 手机号脱敏（原 release_executor 版场景随家族封禁改 dev 通道等价重写，2026-07-30）');
  }

  // ═══ [F] ⭐ 回写围栏（对抗审 F3/F4 收口）═══
  //   缺陷本质：回写按"业务身份"定位而非"这一次投递的那一行/那个收件人"，会把上一轮的结果记到
  //   下一轮头上 —— 审计里出现一个看起来可信的错误答案，比没有记录更糟。relay 通道当初（C0 审
  //   MED-1）修过一次；release_executor 与 dev 子表当时也各补了一个同款围栏用例。
  //   ⚠️ 2026-07-30：用户裁定旧上线编排家族 4 端点（含 notify-release-executor 单条/批量）全部
  //   封禁退场，其内部 helper recordSysReleaseExecutorNotify 已整体删除、export 已摘，原"①
  //   release_executor CAS 围栏"用例（直调该 helper）随之退场，见下方 tombstone；本块现只剩
  //   dev 子表一个用例。
  {
    // recordSysReleaseExecutorNotify 已随旧上线编排家族封禁（2026-07-30）整体删除，其 CAS 围栏用例一并退场

    // dev 子表：软删后重加同一开发 → 旧轮回写不得落到新行上
    const d = await createBug({ title: 'F-dev重加围栏' });
    const did = d.body.id;
    await call('POST', `/api/sys-issues/${did}/intake-accept`, liaisonTok, {});
    await call('POST', `/api/sys-issues/${did}/assign`, liaisonTok, { assigned_to: 5 });
    const oldRow = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [did]);
    //   软删旧行 + 重加同一人（新行 = 新一轮）
    await run(`UPDATE sys_issue_dev_assignees SET removed_at=datetime('now','localtime') WHERE id=?`, [oldRow.id]);
    const newRow = await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary) VALUES (?,?,?,0)`, [did, 5, '开发王']);
    //   旧轮的回写拿着**旧行 id** 落库 → 命中 0（旧行已软删），新行纹丝不动
    await I.recordSysDevAssigneeNotify(did, oldRow.id, true, 'k-old', null, 13);
    const nr = await get(`SELECT notify_status s, notify_sent_by b FROM sys_issue_dev_assignees WHERE id=?`, [newRow.lastID]);
    assert.strictEqual(nr.s, 'not_sent',
      '⭐ "移除→重加"后，上一轮的在途回写**不会落到新行上** —— 新一轮不会一出生就带着旧结果');
    assert.strictEqual(nr.b, null, '新行 sent_by 未被旧轮操作者污染');
    //   正例反证：拿新行 id 回写应命中
    await I.recordSysDevAssigneeNotify(did, newRow.lastID, true, 'k-new', null, 2);
    const nr2 = await get(`SELECT notify_status s, notify_sent_by b FROM sys_issue_dev_assignees WHERE id=?`, [newRow.lastID]);
    assert.strictEqual(nr2.s, 'sent', '新行 id 回写正常命中');
    assert.strictEqual(nr2.b, 2, '新行 sent_by=2 正确');
    await assertInvariant('[F] 后');
    ok('[F] ⭐ 回写围栏（dev 子表）："移除→重加"旧轮不污染新行（+当前行正常命中反证）；release_executor 半的 CAS 围栏用例已随旧上线编排家族封禁退场（2026-07-30）');
  }

  // ═══ [I] 全表不变量总扫 ═══
  {
    await assertInvariant('[I] 总扫');
    // 反向自证：故意造一条违约行，扫描必须抓到 —— 否则上面所有 assertInvariant 都可能是空跑
    const z = await createBug({ title: 'I-反向自证' });
    await run(`UPDATE sys_issues SET creator_notify_status='sent', creator_notify_sent_by=NULL WHERE id=?`, [z.body.id]);
    await assert.rejects(() => assertInvariant('反向'), /creator_notify_status 为 sent\/failed 却无/,
      '⭐ 不变量扫描**确实能抓到**违约行（否则前面几组的 assertInvariant 全是空跑）');
    await run(`UPDATE sys_issues SET creator_notify_status='not_sent' WHERE id=?`, [z.body.id]);   // 收拾干净
    await assertInvariant('[I] 复原后');
    ok('[I] 不变量全表扫描：六通道 sent|failed⟹sent_by 非空、not_sent⟹空；**含"扫描器自身有效"的反向自证**');
  }

  console.log(`\n✅ verify-sys-notify-sent-by 全部通过（${passed} 组·角色权限重构 C2b 通知操作者留痕）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } process.exit(1); });
