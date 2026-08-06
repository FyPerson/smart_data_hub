// 验证脚本：系统迭代 上线体统一重构 C2a 核心场景（方案 v3.4 §6.4/§6.4a/§6.8/§6.10/§6.11/§6.13 + 编码前置调查 §7b）
//   用法：node scripts/verify-sys-release-batch.js
//
// 真实 HTTP 层验证（对齐 verify-sys-role-perm-c1.js / verify-sys-duty-roster.js 范式：真实 express app +
//   http.Server + JWT 多角色夹具）；issue 夹具走直连 SQL 种子（对齐 verify-sys-multidev-snapshots.js 范式，
//   快速构造「待上线」态，不为每条夹具跑完整建单→受理→指派→估时→提交→验收长链）。
//
// 覆盖组（C2a 六组 + C2b 五组补全 + C8 跨阶段冒烟 1 组，累计 13 组，方案附录 B「状态转移表八场景」等
//   claim 逐条落地于此——C2a 原始注释曾把②⑧⑨⑩⑪三类场景标"留 C2b TODO"，C2b 已在同一文件补全，此处
//   同步更新，防止 C9 审查只读本段头部就误判"并发/锁序/崩溃恢复未覆盖"）：
//   ① 状态转移表五态：not_sent 查排班锁人 / failed 保原人 / stale 保原人 / sent 幂等 200 / sending 409（含惰性 stale 转换）
//   ② 无排班 409 NO_PLANNED_DATE / 无 duty roster 409 NO_DUTY_ROSTER / 无资格 409 DUTY_USER_NOT_ELIGIBLE /
//      原执行人失效 409 RELEASE_ASSIGNEE_INVALID 指向撤销上线安排
//   ③ cancel-schedule：对接人 200 全套断言（通知列重置+执行人清+token 换+timeline 每成员一条含 reason）；
//      admin 403；reason 缺 400；前置态不符 409
//   ④ 原语差量：加单/移单/改期→通知重置断言逐列哨兵；同值改期→幂等全跳过（通知列不动+无 timeline）
//   ⑤ 快照 v2：execute 发布后 snapshot_json 解析=schema_version 2+四字段+commits 数组
//   ⑥ execute：本人+sent→200 翻牌；非本人 403；admin 403（即使被排班）；notify≠sent 409；资格实时（禁用后 403）
//   ⑦ 双写镜像断言：加单后新成员旧列=重置后状态；移单后旧列清；notify 成功后当前成员旧列镜像通知结果
//   ⑧ 并发抢占仅一方成功（Promise.all 两个 notify-executor → 恰 1 个 200 + 恰 1 个 409）
//   ⑨ 抢占 CAS token/assignee 比对等价断言 + ⑨-静态 生产 CAS 条件完整性源码断言
//   ⑩ 两种锁顺序的串行化不变量（禁用先提交→execute 403；execute 先提交→事后禁用不回滚）
//   ⑪ 崩溃恢复链：sending 悬挂超/未超 5 分钟阈值两分支（stale 惰性转换）
//   ⑫ cancel-schedule 插缝防护回归（codex 199 HIGH-1 直接验证）
//   ⑬ [C8 新增] 跨阶段冒烟：C0(真实排班表)→C2(真实 CAS notify-executor)→C4(snapshot 读源)→C6(归档重开)→
//      再走一遍真实 CAS→再 execute，验证①-⑫的深度 CAS 覆盖与 C6 归档重开覆盖组合在一起不出"单独测都过、
//      拼起来才炸"的缝；内嵌「⑬-C9锁定」子断言（[C9 任务A] codex 207 审 HIGH-2 轻量采纳）：已发布批次
//      成员 close→reopen 后加回**同一旧批次**须 409 RELEASE_NOT_PLANNING，批次状态/issue.release_id/快照
//      表行数三处不受污染——锁定 _publishReleaseCoreInTxn 头部注释声明的"同一 release_id 永不二次发布"不变量
//
// 断言纪律：全程精确状态码 + 精确 error code，不用 status>=400 弱判据；正例断言真实落库副作用，非仅状态码。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const SECRET = 'verify-sys-release-batch-secret';
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

// ── 多角色 JWT 夹具（对齐 verify-sys-duty-roster.js：测试 id 与生产 users.id 无对应关系）──────────
const adminTok    = jwt.sign({ id: 1,  username: 'admin',      display_name: '管理员',   role: 'admin' }, SECRET);
const liaisonTok  = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人',   role: 'user'  }, SECRET);   // 受理人白名单（对接人）
const dev5Tok     = jwt.sign({ id: 5,  username: 'dev5',       display_name: '开发甲',   role: 'user'  }, SECRET);   // 有资格
const dev6Tok     = jwt.sign({ id: 6,  username: 'dev6',       display_name: '开发乙',   role: 'user'  }, SECRET);   // 有资格
const dev9Tok     = jwt.sign({ id: 9,  username: 'dev9',       display_name: '开发丙',   role: 'user'  }, SECRET);   // 将被禁用，测试实时资格

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

// ── 直连 SQL 夹具（对齐 verify-sys-multidev-snapshots.js 范式）──────────
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员')`,
    [type, status, extra.title || `${type}-${status}-单`]
  );
  return r.lastID;
}
// RELEASE 中心守卫（assertMainStatusTransition）要求在册成员数≥1 且全员完成态（无 pending）才允许进「已上线」——
//   凡是本脚本会走到 execute/_publishReleaseCoreInTxn 的 issue 都必须先补一条完成态 dev_assignee 行。
async function mkCompleteRoster(issueId, userId = 5, userName = '开发甲') {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
    [issueId, userId, userName]
  );
}
// C3·D（notify-executor 补 RELEASE_EMPTY 校验后回归修复）：notify-executor 现在也要求成员非空（fail-closed，
//   同 execute 语义）——本文件里大多数 mkRelease 调用方紧接着自己 addIssuesTo（那些不受影响，member 天然
//   非空）；少数只测 notify-executor 抢占 CAS 本身、从不深入 execute 内核的用例（①②组）此前没有加单这一步，
//   传 extra.withMember=true 让 mkRelease 顺手挂一个简单「待上线」成员（不含 dev_assignee roster——这些用例
//   不会走到 execute，无需该行）。
async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, {
    title: extra.title || 'C2a批次', planned_date: extra.plannedDate || undefined,
  });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const relId = r.body.id;
  if (extra.withMember) {
    const iid = await mkIssue('feature', '待上线', { title: `${extra.title || 'C2a批次'}-占位成员` });
    await addIssuesTo(relId, [iid]);
  }
  return relId;
}
async function addIssuesTo(relId, issueIds) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: issueIds });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const relRow = (id) => get(
  `SELECT id, status, planned_date, release_assignee_id, release_assignee_name,
          release_assignee_notify_status AS ns, release_assignee_notify_started_at AS started,
          release_assignee_notified_at AS notified, release_assignee_notify_message_key AS mkey,
          release_assignee_notify_error AS err, release_assignee_notify_token AS tok, release_assignee_read_at AS readAt
     FROM sys_releases WHERE id=?`, [id]
);
const issueRow = (id) => get(
  `SELECT id, status, release_id, release_assignee_id, release_assignee_name,
          release_assignee_notify_status AS ns, release_assignee_notified_at AS notified,
          release_assignee_notify_message_key AS mkey, release_assignee_notify_error AS err,
          release_assignee_read_at AS readAt, release_assignee_notify_sent_by AS sentBy
     FROM sys_issues WHERE id=?`, [id]
);
async function seedRoster(dutyDate, userId, userName) {
  await run(
    `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, ?, ?, 1, '管理员')`,
    [dutyDate, userId, userName]
  );
}
let dutyDateSeq = 1;
function nextDutyDate() { return `2031-01-${String(dutyDateSeq++).padStart(2, '0')}`; }

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13800000001'),
    (13,'wangtaotao','示例对接人','user','active','13800000013'),
    (5,'dev5','开发甲','user','active','13800000005'),
    (6,'dev6','开发乙','user','active','13800000006'),
    (9,'dev9','开发丙','user','active','13800000009')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 示例对接人13 / dev5,6,9）');

  // ═══ ① 状态转移表五态 ═══
  {
    const d1 = nextDutyDate();
    await seedRoster(d1, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d1, withMember: true });

    // not_sent → 查排班锁人 → sent
    const r1 = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r1.status, 200, `①not_sent 期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.notify_status, 'sent', '①not_sent → sent');
    assert.strictEqual(r1.body.release_assignee_id, 5, '①按当日排班锁定 dev5');
    let rel = await relRow(relId);
    assert.strictEqual(rel.ns, 'sent', '①落库 notify_status=sent');
    assert.strictEqual(rel.release_assignee_id, 5, '①落库 release_assignee_id=5');
    assert.ok(rel.notified, '①notified_at 非空');

    // sent → 再次调用 → 幂等 200，不换人不重发
    const r2 = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r2.status, 200, `①sent 幂等期望 200, got ${r2.status}`);
    assert.strictEqual(r2.body.idempotent, true, '①sent 幂等标记');
    assert.strictEqual(r2.body.notify_status, 'sent', '①sent 幂等仍是 sent');

    // 人工回退到 failed（保留 release_assignee_id=5），改排班为 dev6——验证 failed 不重查排班，仍锁 dev5
    await run(`UPDATE sys_releases SET release_assignee_notify_status='failed', release_assignee_notify_error='模拟失败' WHERE id=?`, [relId]);
    await run(`UPDATE sys_release_duty_roster SET removed_at=datetime('now'), removed_by=1, removed_by_name='管理员' WHERE duty_date=?`, [d1]);
    await seedRoster(d1, 6, '开发乙');   // 改排班为 dev6
    const r3 = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r3.status, 200, `①failed 期望 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.release_assignee_id, 5, '①failed 保留原执行人 dev5（不因排班已改为 dev6 而换人）');
    assert.strictEqual(r3.body.notify_status, 'sent', '①failed 重发后转 sent');

    // 人工回退到 stale（保留 release_assignee_id=5）——同样应保原人
    await run(`UPDATE sys_releases SET release_assignee_notify_status='stale' WHERE id=?`, [relId]);
    const r4 = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r4.status, 200, `①stale 期望 200, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.release_assignee_id, 5, '①stale 保留原执行人 dev5');

    // 人工置 sending（未过 5 分钟）→ 409
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sending', release_assignee_notify_started_at=datetime('now','localtime') WHERE id=?`, [relId]);
    const r5 = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r5.status, 409, `①sending 期望 409, got ${r5.status}`);
    assert.strictEqual(r5.body.code, 'NOTIFY_SENDING_IN_PROGRESS', '①sending 确切码');

    ok('① 状态转移表五态：not_sent 查排班锁人→sent；sent 幂等 200；failed/stale 均保留原执行人（不因排班变化换人）；sending→409 NOTIFY_SENDING_IN_PROGRESS');
  }

  // ═══ ① stale 惰性转换（超 5 分钟的 sending → 请求前自动转 stale → 走 stale 分支保原人）═══
  {
    const d2 = nextDutyDate();
    await seedRoster(d2, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d2, withMember: true });
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=5
    // 人工构造"6 分钟前开始 sending"（超时未回写，模拟崩溃/网络卡死）
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sending', release_assignee_notify_started_at=datetime('now','localtime','-6 minutes') WHERE id=?`, [relId]);
    const r = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r.status, 200, `stale 惰性转换后期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.release_assignee_id, 5, 'stale 惰性转换后仍保原执行人');
    ok('① stale 惰性转换：超 5 分钟的 sending 在请求前被自动转 stale，随后按 stale 分支保原人重发成功');
  }

  // ═══ ② 无排班/无资格/原执行人失效 ═══
  {
    // 无 planned_date
    const relNoDate = await mkRelease({ withMember: true });
    const r1 = await call('POST', `/api/sys-releases/${relNoDate}/notify-executor`, adminTok, {});
    assert.strictEqual(r1.status, 409, `②无计划日期期望 409, got ${r1.status}`);
    assert.strictEqual(r1.body.code, 'NO_PLANNED_DATE', '②确切码 NO_PLANNED_DATE');

    // 有 planned_date 但无排班
    const d3 = nextDutyDate();
    const relNoRoster = await mkRelease({ plannedDate: d3, withMember: true });
    const r2 = await call('POST', `/api/sys-releases/${relNoRoster}/notify-executor`, adminTok, {});
    assert.strictEqual(r2.status, 409, `②无排班期望 409, got ${r2.status}`);
    assert.strictEqual(r2.body.code, 'NO_DUTY_ROSTER', '②确切码 NO_DUTY_ROSTER');

    // 排班人无资格（禁用）
    const d4 = nextDutyDate();
    await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (20,'disabled20','离职','user','disabled')`);
    await seedRoster(d4, 20, '离职');
    const relBadRoster = await mkRelease({ plannedDate: d4, withMember: true });
    const r3 = await call('POST', `/api/sys-releases/${relBadRoster}/notify-executor`, adminTok, {});
    assert.strictEqual(r3.status, 409, `②排班人无资格期望 409, got ${r3.status}`);
    assert.strictEqual(r3.body.code, 'DUTY_USER_NOT_ELIGIBLE', '②确切码 DUTY_USER_NOT_ELIGIBLE');

    // 原执行人失效（failed 态下，原执行人被禁用）
    const d5 = nextDutyDate();
    await seedRoster(d5, 6, '开发乙');
    const relInvalidAssignee = await mkRelease({ plannedDate: d5, withMember: true });
    await call('POST', `/api/sys-releases/${relInvalidAssignee}/notify-executor`, adminTok, {});   // sent, assignee=6
    await run(`UPDATE users SET status='disabled' WHERE id=6`);
    await run(`UPDATE sys_releases SET release_assignee_notify_status='failed' WHERE id=?`, [relInvalidAssignee]);
    const r4 = await call('POST', `/api/sys-releases/${relInvalidAssignee}/notify-executor`, adminTok, {});
    assert.strictEqual(r4.status, 409, `②原执行人失效期望 409, got ${r4.status}`);
    assert.strictEqual(r4.body.code, 'RELEASE_ASSIGNEE_INVALID', '②确切码 RELEASE_ASSIGNEE_INVALID（提示指向撤销上线安排）');
    await run(`UPDATE users SET status='active' WHERE id=6`);   // 复原，避免污染后续用例

    // codex 199 审 MED-2①：排班表被脏数据/历史遗留排入 admin（直接 INSERT 绕过 POST /sys-duty-roster
    //   的资格闸，模拟"曾经合法后来改权限"或直连 SQL 写入的脏数据场景）——notify-executor 的资格闸是
    //   独立的第二道防线，不能因为排班表本身"曾经放进去过"就免检。
    const d5b = nextDutyDate();
    await run(
      `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, 1, '管理员', 1, '管理员')`,
      [d5b]
    );
    const relAdminRoster = await mkRelease({ plannedDate: d5b, withMember: true });
    const r5 = await call('POST', `/api/sys-releases/${relAdminRoster}/notify-executor`, adminTok, {});
    assert.strictEqual(r5.status, 409, `②排班表脏数据排入 admin 期望 409, got ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.code, 'DUTY_USER_NOT_ELIGIBLE', '②排班表脏数据排入 admin 确切码 DUTY_USER_NOT_ELIGIBLE（资格闸独立于排班表本身是否"曾经合法"）');

    ok('② 无排班/无资格/原执行人失效：无计划日期→409 NO_PLANNED_DATE；无排班行→409 NO_DUTY_ROSTER；排班人无资格→409 DUTY_USER_NOT_ELIGIBLE；原执行人失效→409 RELEASE_ASSIGNEE_INVALID；排班表脏数据排入 admin（绕过 POST 资格闸直接 INSERT）→ 409 DUTY_USER_NOT_ELIGIBLE（notify-executor 资格闸独立生效）');
  }

  // ═══ ③ cancel-schedule ═══
  {
    const d6 = nextDutyDate();
    await seedRoster(d6, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d6 });
    const issueId = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=5

    // admin 403
    const rAdmin = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, adminTok, { reason: '测试' });
    assert.strictEqual(rAdmin.status, 403, `③admin 期望 403, got ${rAdmin.status}`);
    assert.strictEqual(rAdmin.body.code, 'INTAKE_LIAISON_ONLY', '③admin 确切码');

    // reason 缺 → 400
    const rNoReason = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, {});
    assert.strictEqual(rNoReason.status, 400, `③reason 缺期望 400, got ${rNoReason.status}`);
    assert.strictEqual(rNoReason.body.code, 'CANCEL_REASON_REQUIRED', '③reason 缺确切码');

    // 对接人 200，全套断言
    const before = await relRow(relId);
    assert.strictEqual(before.ns, 'sent', '③前置：撤销前 notify_status=sent');
    const rOk = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: '甲方临时调整计划' });
    assert.strictEqual(rOk.status, 200, `③对接人期望 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    assert.strictEqual(rOk.body.old_assignee_name, '开发甲', '③响应含旧执行人姓名');
    const after = await relRow(relId);
    assert.strictEqual(after.release_assignee_id, null, '③执行人已清空');
    assert.strictEqual(after.release_assignee_name, null, '③执行人姓名已清空');
    assert.strictEqual(after.ns, 'not_sent', '③通知状态回 not_sent');
    assert.strictEqual(after.started, null, '③started_at 已清');
    assert.strictEqual(after.notified, null, '③notified_at 已清');
    assert.strictEqual(after.mkey, null, '③message_key 已清');
    assert.strictEqual(after.err, null, '③error 已清');
    assert.strictEqual(after.readAt, null, '③read_at 已清');
    assert.notStrictEqual(after.tok, before.tok, '③token 已更换');
    const tl = await get(
      `SELECT summary, action_code FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' AND action_code='release_schedule_cancel' ORDER BY id DESC LIMIT 1`,
      [issueId]
    );
    assert.ok(tl, '③timeline 已写 release_schedule_cancel 行');
    assert.ok(tl.summary.includes('开发甲'), '③timeline summary 含旧执行人');
    assert.ok(tl.summary.includes('甲方临时调整计划'), '③timeline summary 含撤销原因');

    // 前置态不符（此刻 notify_status=not_sent）→ 409
    const rBadStatus = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: '再次撤销' });
    assert.strictEqual(rBadStatus.status, 409, `③前置态不符期望 409, got ${rBadStatus.status}`);
    assert.strictEqual(rBadStatus.body.code, 'CANCEL_SCHEDULE_STATUS_INVALID', '③前置态不符确切码');

    ok('③ cancel-schedule：对接人 200 全套断言（执行人清空+通知六列重置+token 换+timeline 含旧执行人与原因）；admin 403 INTAKE_LIAISON_ONLY；reason 缺 400；前置态不符 409');
  }

  // ═══ ④ 原语差量：加单/移单/改期通知重置 + 同值改期幂等全跳过 ═══
  {
    const d7 = nextDutyDate();
    await seedRoster(d7, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d7 });
    const issue1 = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issue1]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent

    // 加单 → 通知应重置为 not_sent，执行人清空，新成员写 timeline release_add
    const issue2 = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issue2]);
    let rel = await relRow(relId);
    assert.strictEqual(rel.ns, 'not_sent', '④加单后通知重置为 not_sent');
    assert.strictEqual(rel.release_assignee_id, null, '④加单后执行人已清');
    const tlAdd = await get(`SELECT action_code FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_add'`, [issue2]);
    assert.ok(tlAdd, '④新成员写 release_add timeline');

    // 重新走一遍 sent，再移单 → 通知重置
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue2] });
    assert.strictEqual(rRemove.status, 200, `④移单期望 200, got ${rRemove.status}`);
    rel = await relRow(relId);
    assert.strictEqual(rel.ns, 'not_sent', '④移单后通知重置为 not_sent');
    const tlRemove = await get(`SELECT action_code FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_remove'`, [issue2]);
    assert.ok(tlRemove, '④被移除成员写 release_remove timeline');
    const removedIssueRow = await issueRow(issue2);
    assert.strictEqual(removedIssueRow.release_assignee_id, null, '④被移除成员旧列 release_assignee_id 已清');
    assert.strictEqual(removedIssueRow.ns, 'not_sent', '④被移除成员旧列 notify_status 已清回 not_sent');

    // 改期（不同日期）→ 通知重置
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    const d7b = nextDutyDate();
    const rDate = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: d7b });
    assert.strictEqual(rDate.status, 200, `④改期期望 200, got ${rDate.status} ${JSON.stringify(rDate.body)}`);
    assert.strictEqual(rDate.body.changed, true, '④改期 changed=true');
    rel = await relRow(relId);
    assert.strictEqual(rel.ns, 'not_sent', '④改期后通知重置为 not_sent');
    const tlDateChange = await get(`SELECT action_code FROM sys_issue_timeline WHERE issue_id=? AND action_code='release_date_change' ORDER BY id DESC LIMIT 1`, [issue1]);
    assert.ok(tlDateChange, '④成员写 release_date_change timeline');

    // 同值改期（幂等，全跳过）
    const tlCountBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [issue1])).c;
    const rSameDate = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: d7b });
    assert.strictEqual(rSameDate.status, 200, `④同值改期期望 200, got ${rSameDate.status}`);
    assert.strictEqual(rSameDate.body.changed, false, '④同值改期 changed=false（幂等）');
    const tlCountAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [issue1])).c;
    assert.strictEqual(tlCountAfter, tlCountBefore, '④同值改期不新增 timeline 行（全跳过）');

    ok('④ 原语差量：加单/移单/改期均触发通知重置（六列回 not_sent+执行人清）+ 对应 timeline（release_add/release_remove/release_date_change）；同值改期 changed=false 且不写 timeline（幂等全跳过）');
  }

  // ═══ ⑤ 快照 v2（execute 发布后）═══
  let executeSnapIssueId = null, executeSnapRelId = null;
  {
    const d8 = nextDutyDate();
    await seedRoster(d8, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d8, title: 'execute快照批次' });
    const issueId = await mkIssue('feature', '待上线', { title: 'C2a-execute快照单' });
    await mkCompleteRoster(issueId);   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=5

    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: 'C2a execute 发布' });
    assert.strictEqual(rExec.status, 200, `⑤execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(rExec.body.status, '已上线', '⑤execute 后状态=已上线');

    const snap = await get('SELECT snapshot_json FROM sys_issue_release_commit_snapshots WHERE release_id=? AND issue_id=?', [relId, issueId]);
    assert.ok(snap, '⑤快照行已产生');
    const parsed = JSON.parse(snap.snapshot_json);
    assert.strictEqual(parsed.schema_version, 2, '⑤snapshot v2 schema_version=2');
    assert.strictEqual(parsed.type, 'feature', '⑤v2 type 正确');
    assert.strictEqual(parsed.title_snapshot, 'C2a-execute快照单', '⑤v2 title_snapshot=发布时标题');
    assert.strictEqual(parsed.status_at_publish, '已上线', '⑤v2 status_at_publish=已上线');
    assert.ok(Array.isArray(parsed.commits), '⑤v2 commits 为数组');

    const tlPublished = await get(
      `SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='scope_change' AND action_code='release_published'`,
      [issueId]
    );
    assert.ok(tlPublished, '⑤release_published timeline 行已写');
    const publishedPayload = JSON.parse(tlPublished.summary);
    assert.strictEqual(publishedPayload.schema_version, 2, '⑤release_published 载荷 schema_version=2');
    assert.strictEqual(publishedPayload.issue_id, issueId, '⑤release_published 载荷含 issue_id');

    executeSnapIssueId = issueId; executeSnapRelId = relId;
    ok('⑤ 快照 v2：execute 发布后 snapshot_json 解析出 schema_version=2 + type/title_snapshot/status_at_publish 四字段 + commits 数组；release_published timeline 载荷同构');
  }

  // ═══ ⑥ execute 权限矩阵 + 实时资格 ═══
  {
    const d9 = nextDutyDate();
    await seedRoster(d9, 6, '开发乙');
    const relId = await mkRelease({ plannedDate: d9 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 6, '开发乙');   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId, [issueId]);

    // notify != sent → 409
    const rNotSent = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'x' });
    assert.strictEqual(rNotSent.status, 409, `⑥notify≠sent 期望 409, got ${rNotSent.status}`);
    assert.strictEqual(rNotSent.body.code, 'NOTIFY_NOT_SENT', '⑥确切码 NOTIFY_NOT_SENT');

    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=6

    // 非本人 → 403
    const rOther = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: 'x' });
    assert.strictEqual(rOther.status, 403, `⑥非本人期望 403, got ${rOther.status}`);
    assert.strictEqual(rOther.body.code, 'EXECUTOR_GUARD_FAILED', '⑥非本人确切码');

    // admin（即使被排班——此处 admin 并未被排班，模拟"admin 尝试执行"场景，权限判定同样应先卡在"非本人"）
    const rAdmin = await call('POST', `/api/sys-releases/${relId}/execute`, adminTok, { release_note: 'x' });
    assert.strictEqual(rAdmin.status, 403, `⑥admin 期望 403, got ${rAdmin.status}`);

    // 本人+sent → 200
    const rOk = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'C2a execute 正常' });
    assert.strictEqual(rOk.status, 200, `⑥本人+sent 期望 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    const issueAfter = await issueRow(issueId);
    assert.strictEqual(issueAfter.status, '已上线', '⑥执行后主状态=已上线');

    // 实时资格：造禁用后 execute → 403（另建一单验证，禁用发生在 sent 之后、execute 之前）
    const d10 = nextDutyDate();
    await seedRoster(d10, 9, '开发丙');
    const relId2 = await mkRelease({ plannedDate: d10 });
    const issueId2 = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId2, 9, '开发丙');   // RELEASE 中心守卫要求在册成员≥1 且全完成态
    await addIssuesTo(relId2, [issueId2]);
    await call('POST', `/api/sys-releases/${relId2}/notify-executor`, adminTok, {});   // → sent, assignee=9
    await run(`UPDATE users SET status='disabled' WHERE id=9`);
    const rDisabled = await call('POST', `/api/sys-releases/${relId2}/execute`, dev9Tok, { release_note: 'x' });
    assert.strictEqual(rDisabled.status, 403, `⑥实时资格（禁用后）期望 403, got ${rDisabled.status}`);
    assert.strictEqual(rDisabled.body.code, 'EXECUTOR_NOT_ELIGIBLE', '⑥实时资格确切码 EXECUTOR_NOT_ELIGIBLE');
    await run(`UPDATE users SET status='active' WHERE id=9`);

    // codex 199 审 MED-2②：附录 A「/sys-releases/:id/execute | admin（即使被排入值班） → 403」的真覆盖——
    //   此前的 rAdmin 用例（上方 L425）admin 并未真正被排班，只测到了「非本人」这条路径
    //   （EXECUTOR_GUARD_FAILED）；本用例人工构造 release_assignee_id=admin(1) + notify_status='sent'，
    //   使 admin 恰好"是本人"，从而真正走到 hasReleaseEligibility 的 role∉('viewer','admin') 那一步，
    //   证明 admin 即使被排班/被通知也过不了资格闸（403 EXECUTOR_NOT_ELIGIBLE，非 EXECUTOR_GUARD_FAILED）。
    const d10b = nextDutyDate();
    const relAdminAssignee = await mkRelease({ plannedDate: d10b });
    const issueAdminAssignee = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueAdminAssignee, 5, '开发甲');
    await addIssuesTo(relAdminAssignee, [issueAdminAssignee]);
    await run(
      `UPDATE sys_releases SET release_assignee_id=1, release_assignee_name='管理员', release_assignee_notify_status='sent' WHERE id=?`,
      [relAdminAssignee]
    );
    const rAdminAsAssignee = await call('POST', `/api/sys-releases/${relAdminAssignee}/execute`, adminTok, { release_note: 'x' });
    assert.strictEqual(rAdminAsAssignee.status, 403, `⑥admin 被排班仍执行期望 403, got ${rAdminAsAssignee.status} ${JSON.stringify(rAdminAsAssignee.body)}`);
    assert.strictEqual(rAdminAsAssignee.body.code, 'EXECUTOR_NOT_ELIGIBLE', '⑥admin 即使被排班（本人+sent）仍被资格闸拒——确切码 EXECUTOR_NOT_ELIGIBLE（非 EXECUTOR_GUARD_FAILED，附录 A 真覆盖）');

    ok('⑥ execute 权限矩阵：notify≠sent→409 NOTIFY_NOT_SENT；非本人/admin(未排班)→403 EXECUTOR_GUARD_FAILED；本人+sent→200 真翻牌；账号被禁用（sent 之后现禁用）→403 EXECUTOR_NOT_ELIGIBLE；admin 即使被排班且是本人（人工构造 release_assignee_id=admin+sent）仍403 EXECUTOR_NOT_ELIGIBLE（附录A真覆盖，非仅本人判定）');
  }

  // ═══ ⑦ [C5 改造] 8 列只读残留验证——镜像双写已删除，sys_issues 旧列全程冻结在初始值 ═══
  //   本组原是"双写镜像断言"（验证镜像**发生**），C5 删除 syncReleaseLegacyMirror 后语义整体反转——
  //   现在验证的是镜像**不再发生**：走一遍真实链路（加单/notify/cancel-schedule/改期/移单/execute），
  //   全程断言 sys_issues 的 8 个旧列（release_assignee_id/name + notify_status/notified_at/
  //   message_key/error/read_at + notify_sent_by）巍然不动地停在 schema 默认初始值——同一事务里
  //   sys_releases 的权威列确实在变（复用①-⑥组已充分验证的部分，此处不重复），但镜像目标 sys_issues
  //   一列都不该被这条链路碰到。
  {
    function assertMirrorFrozenAtInitial(row, label) {
      assert.strictEqual(row.release_assignee_id, null, `${label} 镜像列 release_assignee_id 应仍为初始 NULL（未被写入）`);
      assert.strictEqual(row.release_assignee_name, null, `${label} 镜像列 release_assignee_name 应仍为初始 NULL`);
      assert.strictEqual(row.ns, 'not_sent', `${label} 镜像列 notify_status 应仍为 schema 默认初始值 'not_sent'（DEFAULT，非被写回）`);
      assert.strictEqual(row.notified, null, `${label} 镜像列 notified_at 应仍为初始 NULL`);
      assert.strictEqual(row.mkey, null, `${label} 镜像列 notify_message_key 应仍为初始 NULL`);
      assert.strictEqual(row.err, null, `${label} 镜像列 notify_error 应仍为初始 NULL`);
      assert.strictEqual(row.readAt, null, `${label} 镜像列 read_at 应仍为初始 NULL`);
      assert.strictEqual(row.sentBy, null, `${label} 镜像列 notify_sent_by 应仍为初始 NULL`);
    }

    const d11 = nextDutyDate();
    await seedRoster(d11, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d11 });
    const issue1 = await mkIssue('feature', '待上线');
    await addIssuesTo(relId, [issue1]);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦加单后 issue1');

    // notify-executor 成功（真实走通 CAS 抢占+外呼，权威列 sys_releases 真变 sent——复用①组已验证，此处只看镜像列）。
    const rNotify = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(rNotify.status, 200, `⑦notify 期望 200, got ${rNotify.status} ${JSON.stringify(rNotify.body)}`);
    const relAfterNotify = await relRow(relId);
    assert.strictEqual(relAfterNotify.ns, 'sent', '⑦notify 后 sys_releases 权威列真变 sent（镜像删除不影响权威写入路径本身）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦notify 成功后 issue1');

    // 加单第二个成员——批次级重置（旧口径会触发全体成员镜像清空+重发；C5 后应仍是"全体镜像列岿然不动"）。
    const issue2 = await mkIssue('feature', '待上线');
    const rAdd = await addIssuesTo(relId, [issue2]);
    assert.strictEqual(rAdd.status, 200, `⑦加单期望 200, got ${rAdd.status}`);
    const relAfterAdd = await relRow(relId);
    assert.strictEqual(relAfterAdd.ns, 'not_sent', '⑦加单后 sys_releases 权威列真重置为 not_sent（原语差量重置逻辑不受镜像删除影响）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦加单后 issue1（原成员）');
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦加单后 issue2（新成员）');

    // 撤销上线安排（cancel-schedule）：需先重新 notify 到 sent 才满足前置。
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    const rCancel = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: '⑦-C5 只读残留回归' });
    assert.strictEqual(rCancel.status, 200, `⑦cancel-schedule 期望 200, got ${rCancel.status} ${JSON.stringify(rCancel.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦cancel-schedule 后 issue1');
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦cancel-schedule 后 issue2');

    // 改计划上线日期（真改期，非同值）。
    const dNew = nextDutyDate();
    const rDate = await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: dNew });
    assert.strictEqual(rDate.status, 200, `⑦改期期望 200, got ${rDate.status} ${JSON.stringify(rDate.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦改期后 issue1');
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦改期后 issue2');

    // 移单——issue2 被移出批次，issue1 仍在册；两者镜像列均应岿然不动。
    const rRemove = await call('POST', `/api/sys-releases/${relId}/remove-issues`, adminTok, { issue_ids: [issue2] });
    assert.strictEqual(rRemove.status, 200, `⑦移单期望 200, got ${rRemove.status} ${JSON.stringify(rRemove.body)}`);
    assertMirrorFrozenAtInitial(await issueRow(issue2), '⑦移单后 issue2（被移除成员）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦移单后 issue1（仍在册成员）');

    // execute 真发布——需重新 seedRoster（改期后原排班日期已过期）+ notify 到 sent + 满足 roster 门。
    const dFinal = nextDutyDate();
    await seedRoster(dFinal, 5, '开发甲');
    await call('POST', `/api/sys-releases/${relId}/update-planned-date`, adminTok, { planned_date: dFinal });
    await mkCompleteRoster(issue1, 5, '开发甲');
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: '⑦-C5 只读残留回归·真发布' });
    assert.strictEqual(rExec.status, 200, `⑦execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    const issue1Row = await get('SELECT status FROM sys_issues WHERE id=?', [issue1]);
    assert.strictEqual(issue1Row.status, '已上线', '⑦execute 后 issue1 真实翻已上线（权威链路本身不受影响）');
    assertMirrorFrozenAtInitial(await issueRow(issue1), '⑦execute 真发布后 issue1（已上线态，镜像列仍应岿然不动）');

    ok('⑦ [C5 改造] 8 列只读残留验证：真实走完 加单→notify→加单(批次重置)→cancel-schedule→改期→移单→execute 全链路，sys_issues 的 8 个旧镜像列全程冻结在 schema 初始值（release_assignee_id/name=NULL，notify_status=\'not_sent\' DEFAULT，其余 5 列=NULL）；同期 sys_releases 权威列全部真实变化（notify→sent/加单→重置为not_sent/execute→已上线），证明"只删镜像写、权威源写入路径不受影响"');
  }

  // ═══ ⑧ C2b：并发抢占仅一方成功（§6.4a）══════════════════════════════════════════════
  //   ⚠️ 声称范围（gotchas：声称=实测范围）：本项目是**模块级 mutex 串行化**（sysBeginImmediate 内部
  //   通过 JS 异步锁排队，同一时刻只有一个请求能进入 BEGIN IMMEDIATE 临界区）——"并发"两个 HTTP 请求
  //   实际在服务端是**排队**而非真并行竞态。本组断言的是"排队后的正确拒绝"：先到者拿到 sending→sent，
  //   后到者进入临界区时读到的已经是 sending 态（或 CAS 比对不上），走 409 分支——不是断言"两个请求在
  //   同一微秒窗口内竞争同一行"（那需要多连接/无 mutex 架构才能复现，本项目架构下不存在该风险面）。
  {
    const d12 = nextDutyDate();
    await seedRoster(d12, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d12 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 5, '开发甲');
    await addIssuesTo(relId, [issueId]);

    const [r1, r2] = await Promise.all([
      call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {}),
      call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {}),
    ]);
    const successes = [r1, r2].filter(r => r.status === 200);
    const failures = [r1, r2].filter(r => r.status !== 200);
    assert.strictEqual(successes.length, 1, `⑧恰一个请求应 200，实际状态码 [${r1.status},${r2.status}]`);
    assert.strictEqual(failures.length, 1, `⑧恰一个请求应非 200，实际状态码 [${r1.status},${r2.status}]`);
    assert.strictEqual(failures[0].status, 409, `⑧失败请求应 409, got ${failures[0].status} ${JSON.stringify(failures[0].body)}`);
    assert.ok(['NOTIFY_SENDING_IN_PROGRESS', 'NOTIFY_CAS_CONFLICT'].includes(failures[0].body.code),
      `⑧失败请求确切码应为 NOTIFY_SENDING_IN_PROGRESS 或 NOTIFY_CAS_CONFLICT 之一，实际 ${failures[0].body.code}`);
    const rel = await relRow(relId);
    assert.strictEqual(rel.ns, 'sent', '⑧终态恰一次发送，notify_status=sent（非重复发送/非卡在 sending）');
    ok(`⑧ 并发抢占仅一方成功：Promise.all 两个 notify-executor → 恰 1 个 200 + 恰 1 个 409（${failures[0].body.code}）→ 终态恰一次 sent。声称范围＝模块级 mutex 排队后的正确拒绝，非无锁多连接真竞态（本架构不存在该风险面）`);
  }

  // ═══ ⑨ C2b：抢占 CAS 的 token/assignee 比对确实生效（§6.4a 边界防护，等价断言）══════════════════════
  //   ⚠️ 声称范围：真正的"事务外调班插缝"（查排班与 CAS 之间被另一事务抢先提交）在本架构下不可复现——
  //   sysBeginImmediate 持锁期间，其余请求的 sysBeginImmediate 会阻塞在锁获取上，不存在"中途插入"的
  //   时间窗口。本组改为等价的**回归锚点**：验证 CAS 的 WHERE 子句确实把 token/assignee 纳入比对
  //   （而非只比对 status/notify_status）——手段是"先让一次 notify-executor 正常拿到 sent 态的 token"，
  //   再直接用**那个已经作废的旧 token**去 UPDATE，证明它比对不上（changes=0）。这与"另一路径抢先"
  //   在 SQL 层面是同一件事：CAS 是否真的把 token 纳入了 WHERE，而不是仅仅看起来纳入了。
  {
    const d13 = nextDutyDate();
    await seedRoster(d13, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d13 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 5, '开发甲');
    await addIssuesTo(relId, [issueId]);

    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, token=T1
    const afterSend = await relRow(relId);
    const staleToken = afterSend.tok;
    assert.ok(staleToken, '⑨前置：发送成功后应有 token');

    // 模拟"另一路径已经把 token 往前推进了一步"（等价于抢先事务已提交）：直接换成新 token。
    await run(`UPDATE sys_releases SET release_assignee_notify_token='forged-newer-token' WHERE id=?`, [relId]);

    // 现在拿"旧 token"去尝试 CAS 更新（模拟迟到的一方仍持有作废凭证）——应 changes=0，不生效、不锁定旧值。
    const lateWrite = await run(
      `UPDATE sys_releases SET release_assignee_notify_status='sending' WHERE id=? AND release_assignee_notify_token=?`,
      [relId, staleToken]
    );
    assert.strictEqual(lateWrite.changes, 0, '⑨持旧 token 的迟到写入应 changes=0（CAS 的 token 比对确实生效，不会被作废凭证锁定）');
    const relAfter = await relRow(relId);
    assert.strictEqual(relAfter.ns, 'sent', '⑨状态未被迟到写入污染，仍是 sent');
    ok('⑨ 抢占 CAS 边界防护（等价断言）：CAS 的 WHERE 子句真把 token 纳入比对——持旧 token 的迟到写入 changes=0、不锁定/不污染当前态。真实"事务外插缝"时间窗口在本 mutex 串行架构下不可复现，此为等价回归锚点');

    // ⑨-静态 [对抗审"假绿猎手"视角裁定必修 C] 上面⑨用手写 SQL 证明的是"SQLite 语义"（CAS 这个技术套路
    //   本身管用），但**不能钉住生产路由 preemptReleaseNotifySend/sendReleaseNotifyAndWriteback 里真正
    //   跑的那条 UPDATE 的 WHERE 子句，是否真的同时比对了 release_assignee_notify_token 与
    //   release_assignee_id 这两列**——如果有人把生产代码里的某一列条件删掉，⑨的手写 SQL 用例仍然全绿
    //   （它压根没有读生产源码，测的是自己另起的一句 SQL），是典型的"看似覆盖、实则测了别的东西"。
    //   补静态源码断言（沿用 verify-sys-intake-schedule-c7.js「读 HTML 源码做静态断言」的先例，同一手法
    //   搬到读 index.js）：直接读生产源文件文本，断言两处 CAS UPDATE 语句原样含这两列的比对条件。
    {
      const srcPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
      const src = fs.readFileSync(srcPath, 'utf8');

      // 抢占 CAS（preemptReleaseNotifySend 的 casSql，两个三元分支写法不同但 WHERE 尾部同构，各查一次）：
      const preemptTokenClause = "COALESCE(release_assignee_notify_token,'')=COALESCE(?,'')";
      const preemptAssigneeClause = 'COALESCE(release_assignee_id,0)=COALESCE(?,0)';
      const preemptTokenHits = src.split(preemptTokenClause).length - 1;
      const preemptAssigneeHits = src.split(preemptAssigneeClause).length - 1;
      assert.ok(preemptTokenHits >= 2, `生产 CAS 条件被削弱：preemptReleaseNotifySend 的 casSql 应有 2 处（两个三元分支）WHERE 子句含 ${preemptTokenClause}，实际命中 ${preemptTokenHits} 处——若为 0/1，说明有人削弱或漏改了其中一支的抢占 CAS 比对条件`);
      assert.ok(preemptAssigneeHits >= 2, `生产 CAS 条件被削弱：preemptReleaseNotifySend 的 casSql 应有 2 处（两个三元分支）WHERE 子句含 ${preemptAssigneeClause}，实际命中 ${preemptAssigneeHits} 处——若为 0/1，说明有人削弱或漏改了其中一支的抢占 CAS 比对条件`);

      // 结果回写 CAS（sendReleaseNotifyAndWriteback 的 writeback UPDATE，单一写法，两列同一行）：
      const writebackFnStart = src.indexOf('async function sendReleaseNotifyAndWriteback(');
      assert.ok(writebackFnStart > 0, '生产源码应存在 sendReleaseNotifyAndWriteback 函数（若函数被改名/挪走，本静态断言的定位锚点已失效，需要人工核查而非静默跳过）');
      const writebackFnBody = src.slice(writebackFnStart, writebackFnStart + 2500);   // 函数体足够短，覆盖到 writeback UPDATE 语句
      assert.ok(
        /WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'计划中'\s+AND\s+release_assignee_notify_status\s*=\s*'sending'\s+AND\s+release_assignee_id\s*=\s*\?\s+AND\s+release_assignee_notify_token\s*=\s*\?/.test(writebackFnBody),
        '生产 CAS 条件被削弱：sendReleaseNotifyAndWriteback 的结果回写 UPDATE 语句 WHERE 子句应同时含 release_assignee_id=? 与 release_assignee_notify_token=? 两列比对——若断言失败，说明有人删掉了其中一列的回写 CAS 比对条件（HIGH-1 插缝防护失效）'
      );
      ok('⑨-静态 生产 CAS 条件完整性（静态源码断言）：抢占 CAS（casSql 两个三元分支）与结果回写 CAS（sendReleaseNotifyAndWriteback）的 WHERE 子句均原样确认同时比对 release_assignee_notify_token 与 release_assignee_id——钉住"真实路由到底比对了哪几列"，非手写 SQL 的等价替身能覆盖到的');
    }
  }

  // ═══ ⑩ C2b：两种锁顺序的串行化不变量（§6.3a v3.4 修正②）══════════════════════════════
  {
    // ①禁用先提交 → execute 必 403：已由组⑥「实时资格：造禁用后 execute → 403」用例覆盖
    //   （relId2/issueId2/dev9，禁用发生在 sent 之后、execute 调用之前，execute 读到的是禁用后的真实态）。
    ok('⑩-① 禁用先提交→execute 必 403：复用组⑥「实时资格」用例（relId2/dev9 禁用后 execute→403 EXECUTOR_NOT_ELIGIBLE），不重复造夹具');

    // ②execute 先完成（提交成功）→ 随后禁用 = 合法结果（不倒查回滚）。
    const d14 = nextDutyDate();
    await seedRoster(d14, 6, '开发乙');
    const relId = await mkRelease({ plannedDate: d14 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 6, '开发乙');
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=6
    const rExec = await call('POST', `/api/sys-releases/${relId}/execute`, dev6Tok, { release_note: 'C2b 锁序②' });
    assert.strictEqual(rExec.status, 200, `⑩-②execute 期望 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    // execute 提交成功之后才禁用——此时禁用不应、也不能倒查回滚已提交的发布。
    await run(`UPDATE users SET status='disabled' WHERE id=6`);
    const relRowAfter = await relRow(relId);
    const issueRowAfter = await issueRow(issueId);
    assert.strictEqual(relRowAfter.status, '已发布', '⑩-②execute 已提交，批次仍是「已发布」，不因事后禁用而回滚');
    assert.strictEqual(issueRowAfter.status, '已上线', '⑩-②execute 已提交，成员仍是「已上线」，不因事后禁用而回滚');
    await run(`UPDATE users SET status='active' WHERE id=6`);   // 复原防污染
    ok('⑩-② execute 先完成（200 提交成功）→ 随后禁用执行人 = 合法结果，批次/成员状态不回滚（证明"绝不允许：禁用已先提交但发布仍成功"的反面——"发布已先提交，之后才禁用"——是合法结果，二者不对称）');
  }

  // ═══ ⑪ C2b：崩溃恢复链——sending 悬挂→stale 的两分支（§6.4a③/§7b③）══════════════════════
  {
    const d15 = nextDutyDate();
    await seedRoster(d15, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d15 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 5, '开发甲');
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, assignee=5

    // 分支 A：sending 悬挂 6 分钟（模拟进程死亡未回写）→ 请求前惰性 stale 转换 → 走 stale 分支保原人重发 → 200
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sending', release_assignee_notify_started_at=datetime('now','localtime','-6 minutes') WHERE id=?`, [relId]);
    const rStale = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(rStale.status, 200, `⑪分支A(6分钟悬挂)期望 200, got ${rStale.status} ${JSON.stringify(rStale.body)}`);
    assert.strictEqual(rStale.body.release_assignee_id, 5, '⑪分支A：stale 惰性转换后走保原人重发路径，assignee 仍是 5');

    // 分支 B：sending 悬挂仅 2 分钟（未超 5 分钟阈值）→ 不转 stale → 409 NOTIFY_SENDING_IN_PROGRESS
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sending', release_assignee_notify_started_at=datetime('now','localtime','-2 minutes') WHERE id=?`, [relId]);
    const rNotYet = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(rNotYet.status, 409, `⑪分支B(2分钟未超时)期望 409, got ${rNotYet.status} ${JSON.stringify(rNotYet.body)}`);
    assert.strictEqual(rNotYet.body.code, 'NOTIFY_SENDING_IN_PROGRESS', '⑪分支B：未超 5 分钟阈值应仍判定"发送在途"，确切码 NOTIFY_SENDING_IN_PROGRESS');

    ok('⑪ 崩溃恢复链：sending 悬挂 6 分钟（超阈值）→ 请求前惰性 stale 转换 → 走保原人重发路径 200；悬挂仅 2 分钟（未超阈值）→ 仍判"发送在途"409 NOTIFY_SENDING_IN_PROGRESS（阈值边界两分支均验证，非仅测其一）');
  }

  // ═══ ⑫ C2b：cancel-schedule 插缝防护回归（codex 199 审 HIGH-1 的直接验证）══════════════════════
  //   ⚠️ 声称范围：真实"回写前状态被 cancel 改掉"的并发窗口在本 mutex 架构下不可复现（同⑨）。
  //   等价断言：cancel-schedule 成功后 token 已换——若有人拿着**撤销前的旧 token**去尝试写，应 changes=0
  //   （不生效），证明 HIGH-1 修复后的"回写与镜像同一事务"配合"token 换新"两道防线确实堵住了迟到写入。
  {
    const d16 = nextDutyDate();
    await seedRoster(d16, 5, '开发甲');
    const relId = await mkRelease({ plannedDate: d16 });
    const issueId = await mkIssue('feature', '待上线');
    await mkCompleteRoster(issueId, 5, '开发甲');
    await addIssuesTo(relId, [issueId]);
    await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});   // → sent, token=T_old

    const before = await relRow(relId);
    const oldToken = before.tok;
    const rCancel = await call('POST', `/api/sys-releases/${relId}/cancel-schedule`, liaisonTok, { reason: 'C2b 插缝防护回归' });
    assert.strictEqual(rCancel.status, 200, `⑫cancel-schedule 期望 200, got ${rCancel.status} ${JSON.stringify(rCancel.body)}`);
    const after = await relRow(relId);
    assert.notStrictEqual(after.tok, oldToken, '⑫cancel-schedule 后 token 已更换');
    assert.strictEqual(after.ns, 'not_sent', '⑫cancel-schedule 后 notify_status 已重置为 not_sent');

    // 模拟迟到的一方仍持有撤销前的旧 token，尝试写回"sent"（假装自己的发送成功了）——应 changes=0，不生效。
    const lateWrite = await run(
      `UPDATE sys_releases SET release_assignee_notify_status='sent' WHERE id=? AND release_assignee_notify_token=?`,
      [relId, oldToken]
    );
    assert.strictEqual(lateWrite.changes, 0, '⑫持撤销前旧 token 的迟到回写应 changes=0（token 已换新，迟到写入被挡）');
    const relFinal = await relRow(relId);
    assert.strictEqual(relFinal.ns, 'not_sent', '⑫迟到回写未生效，权威态仍是 cancel-schedule 重置后的 not_sent（未被污染成 sent）');
    ok('⑫ cancel-schedule 插缝防护回归（codex 199 HIGH-1 直接验证）：cancel-schedule 成功后 token 换新，持撤销前旧 token 的迟到写入 changes=0 且不污染权威态——HIGH-1"回写与镜像同一事务"+ token 换新两道防线在此得到规格层面的确认');
  }

  // ═══ ⑬ C8 跨阶段冒烟：C0 排班表 → C2 真实 CAS notify-executor → C4 读源 → C6 归档重开 → 再走一遍 C2 → C4 ═══
  //   动机（C8 任务 C）：本文件①-⑫组已把 duty roster + 两段 CAS 测得很深，但全部止步于"发布成功"；
  //   verify-sys-release.js 的 [C6回环] 与 verify-sys-bug-transitions.js 的 [C6] 均验证了归档重开+快照
  //   红线，但为了不在无关测试点上重复造 CAS 夹具，两处的执行人锁定都走「直接 SQL 钉 release_assignee_id+
  //   notify_status=sent」的既有捷径（非本文件①组那种真实 notify-executor CAS 查排班）——bug 侧唯一例外是
  //   verify-sys-bug-transitions.js 经 hotfix-publish 内部复用同一份 preemptReleaseNotifySend/
  //   sendReleaseNotifyAndWriteback 服务，但那是 hotfix-publish 这个入口，不是 notify-executor 路由本身。
  //   本组补上这条组合从未被走过的具体路径：change 流·真实 duty roster→真实 notify-executor CAS→execute→
  //   归档→重开→重新过一遍开发到待上线→加入新批次→再走一次真实 notify-executor CAS→再 execute——证明
  //   C0/C2/C4/C6 四阶段组合在一起不出"单独测都过、拼起来才炸"的缝。
  {
    const d13 = nextDutyDate();
    await seedRoster(d13, 5, '开发甲');
    const cycIssue = await mkIssue('feature', '待上线', { title: 'C8跨阶段冒烟-归档重开' });
    await mkCompleteRoster(cycIssue, 5, '开发甲');
    // close/reopen 走 ADMIN_TRANSITION/sysIssueTransition [4] RC-M5 不变量，检的是 legacy 单值列
    // sys_issues.assigned_to（非 sys_issue_dev_assignees 多开发表）——mkIssue/mkCompleteRoster 均不写它，
    // 首次实测在本文件也踩了一次同款坑（同 test-sys-release-c7-playwright.js 的既有踩坑记录）。
    await run(`UPDATE sys_issues SET assigned_to=?, assigned_to_name=?, assigned_at=datetime('now') WHERE id=?`, [5, '开发甲', cycIssue]);
    const cycRel1 = await mkRelease({ plannedDate: d13 });
    await addIssuesTo(cycRel1, [cycIssue]);

    // C0(排班表)→C2(真实 CAS)：notify-executor 真实查排班锁定 dev5（非直接 SQL 钉）。
    const rNotify1 = await call('POST', `/api/sys-releases/${cycRel1}/notify-executor`, adminTok, {});
    assert.strictEqual(rNotify1.status, 200, `⑬notify-executor 首次应 200, got ${rNotify1.status} ${JSON.stringify(rNotify1.body)}`);
    assert.strictEqual(rNotify1.body.release_assignee_id, 5, '⑬按当日排班锁定 dev5（真实 CAS，非 SQL 捷径）');
    assert.strictEqual(rNotify1.body.notify_status, 'sent', '⑬notify_status=sent');

    const rExec1 = await call('POST', `/api/sys-releases/${cycRel1}/execute`, dev5Tok, { release_note: 'C8跨阶段首发', version_tag: 'v-c8-1' });
    assert.strictEqual(rExec1.status, 200, `⑬execute 首次应 200, got ${rExec1.status} ${JSON.stringify(rExec1.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '已上线', '⑬execute 后单已翻已上线');

    // C4：getReleaseMembers 首发后基线为 snapshot。
    const gm1 = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    assert.strictEqual(gm1.source, 'snapshot', '⑬首发后 getReleaseMembers 走 snapshot 源（C4 读源）');

    // C6：归档 → 重开（真实 HTTP，非 sysIssueTransition 直调）。
    const rClose = await call('POST', `/api/sys-issues/${cycIssue}/close`, adminTok, {});
    assert.strictEqual(rClose.status, 200, `⑬close 应 200, got ${rClose.status} ${JSON.stringify(rClose.body)}`);
    const rReopen = await call('POST', `/api/sys-issues/${cycIssue}/reopen`, adminTok, { reason: 'C8跨阶段冒烟-验证归档重开与真实CAS组合' });
    assert.strictEqual(rReopen.status, 200, `⑬reopen 应 200, got ${rReopen.status} ${JSON.stringify(rReopen.body)}`);
    assert.strictEqual(rReopen.body.status, '开发中', '⑬reopen 目标态=开发中');
    const afterReopen = await issueRow(cycIssue);
    assert.strictEqual(afterReopen.release_id, null, '⑬reopen 清 release_id');

    // 红线：旧批次（真实 CAS 发布出来的）在归档重开后仍稳定 snapshot、release 本身未被拖回计划中。
    const rel1AfterReopen = await relRow(cycRel1);
    assert.strictEqual(rel1AfterReopen.status, '已发布', '⑬[红线] 归档重开后旧批次仍「已发布」（真实 CAS 发布路径同样不被拖回计划中）');
    const gm1AfterReopen = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    assert.strictEqual(gm1AfterReopen.source, 'snapshot', '⑬[红线] 归档重开后旧批次仍 snapshot 源（真实 CAS 发布路径的快照同样不受影响）');

    // [C9·codex 207 审 HIGH-2 轻量采纳] 不变量锁定：尝试把 reopen 释放出来的 issue 加回**同一个**
    //   （仍「已发布」）旧批次——必须被 add-issues 的 RELEASE_NOT_PLANNING 拦下，release 状态/issue.release_id/
    //   快照表行数三处均不受污染。与下方"加入新批次 cycRel2"分支是两个独立场景：那条验证"正常改道"，
    //   这条验证"回头路走不通"（_publishReleaseCoreInTxn 头部注释所声明不变量的具体验证载体）。
    const rAddBack = await call('POST', `/api/sys-releases/${cycRel1}/add-issues`, adminTok, { issue_ids: [cycIssue] });
    assert.strictEqual(rAddBack.status, 409, `⑬-C9锁定 加回旧批次应 409, got ${rAddBack.status} ${JSON.stringify(rAddBack.body)}`);
    assert.strictEqual(rAddBack.body.code, 'RELEASE_NOT_PLANNING', '⑬-C9锁定 code=RELEASE_NOT_PLANNING');
    const rel1AfterAddBack = await relRow(cycRel1);
    assert.strictEqual(rel1AfterAddBack.status, '已发布', '⑬-C9锁定 加回尝试后旧批次状态仍「已发布」（未被污染）');
    const issueAfterAddBack = await issueRow(cycIssue);
    assert.strictEqual(issueAfterAddBack.release_id, null, '⑬-C9锁定 加回被拒后 issue.release_id 仍为 null（未被误挂回旧批次）');
    const snapCountRow = await get(
      `SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id = ? AND issue_id = ?`,
      [cycRel1, cycIssue]
    );
    assert.strictEqual(snapCountRow.c, 1, '⑬-C9锁定 快照表 (release_id,issue_id) 仍恰 1 行（未产生重复/未被覆盖）');
    ok('⑬-C9锁定 已发布批次成员 close→reopen 后加回同一旧批次 → 409 RELEASE_NOT_PLANNING + 批次状态/issue.release_id/快照行数三处均未被污染（HIGH-2 轻量采纳）');

    // 重新开发到待上线（估时→提交→验收，dev_assignee 沿用首轮完成态实例，reopen 不清 dev_status——同
    // verify-sys-multidev-members.js S10g 既有结论，本组直接复用而非重复证明）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending' WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [cycIssue]);
    const rEst = await call('POST', `/api/sys-issues/${cycIssue}/estimate`, dev5Tok, { dev_estimated_at: '2031-02-01 10:00' });
    assert.strictEqual(rEst.status, 200, `⑬estimate 应 200, got ${rEst.status} ${JSON.stringify(rEst.body)}`);
    const rSubmit = await call('POST', `/api/sys-issues/${cycIssue}/submit`, dev5Tok, { mode: 'no_code', no_code_reason: '重开后修复（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(rSubmit.status, 200, `⑬submit 应 200, got ${rSubmit.status} ${JSON.stringify(rSubmit.body)}`);
    const rAccept = await call('POST', `/api/sys-issues/${cycIssue}/accept`, adminTok, {});
    assert.strictEqual(rAccept.status, 200, `⑬accept 应 200, got ${rAccept.status} ${JSON.stringify(rAccept.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '待上线', '⑬重新走完流程回到待上线');

    // 加入新批次 → 再走一遍真实 duty roster + CAS notify-executor + execute（同一天排班仍是 dev5，
    // 复用同一条 duty roster 行——不重复 INSERT，idx_sys_duty_roster_active 对同 duty_date 仅允许一条在册行）。
    const cycRel2 = await mkRelease({ plannedDate: d13 });
    await addIssuesTo(cycRel2, [cycIssue]);
    const rNotify2 = await call('POST', `/api/sys-releases/${cycRel2}/notify-executor`, adminTok, {});
    assert.strictEqual(rNotify2.status, 200, `⑬第二轮 notify-executor 应 200, got ${rNotify2.status} ${JSON.stringify(rNotify2.body)}`);
    assert.strictEqual(rNotify2.body.release_assignee_id, 5, '⑬第二轮真实 CAS 同样锁定 dev5');
    const rExec2 = await call('POST', `/api/sys-releases/${cycRel2}/execute`, dev5Tok, { release_note: 'C8跨阶段二发', version_tag: 'v-c8-2' });
    assert.strictEqual(rExec2.status, 200, `⑬第二轮 execute 应 200, got ${rExec2.status} ${JSON.stringify(rExec2.body)}`);
    assert.strictEqual((await issueRow(cycIssue)).status, '已上线', '⑬二次真实 CAS 发布后单再次翻已上线');
    assert.strictEqual((await issueRow(cycIssue)).release_id, cycRel2, '⑬release_id 指向新批次（非旧批次）');

    // 两轮真实 CAS 发布互不干扰：新旧批次各自快照独立存在。
    const gm1Final = await I.getReleaseMembers({ id: cycRel1, status: '已发布' });
    const gm2Final = await I.getReleaseMembers({ id: cycRel2, status: '已发布' });
    assert.strictEqual(gm1Final.source, 'snapshot', '⑬旧批次三次读取后仍 snapshot（第三次读取仍稳定）');
    assert.strictEqual(gm2Final.source, 'snapshot', '⑬新批次也是 snapshot 源');

    ok('⑬ C8 跨阶段冒烟：C0(真实排班表)→C2(真实 CAS notify-executor，非 SQL 捷径)→execute→C4(snapshot 读源)→C6(归档+重开)→重新开发→新批次→再走一遍真实 CAS→再 execute，全链路两轮均通过，红线（release 不回计划中/快照不因归档重开降级）在真实 CAS 发布路径下同样成立——此前①-⑫组的深度 CAS 覆盖与 C6 的归档重开覆盖首次在同一条链路里组合验证');
  }

  // ═══ ⑭ [2026-07-30 用户提出·通知三件套对齐] sent 态重发（resend:true）+ 批次执行人查已读端点 ═══
  //   重发＝preemptReleaseNotifySend 的准入放宽（sent 走"保留原执行人"分支，与 failed/stale 同一条 CAS 路径），
  //   非旁路；查已读镜像单据级 release_executor 通道（admin-only + 固化写回双围栏）。stub 环境 message_key
  //   恒 'stub-dev'，"换新"断言用 token（每次抢占 crypto 随机）承担。
  {
    const d14 = nextDutyDate();
    const relId = await mkRelease({ title: '⑭重发', plannedDate: d14 });
    await seedRoster(d14, 5, '开发甲');
    const iid = await mkIssue('feature', '待上线', { title: '⑭成员' });
    await addIssuesTo(relId, [iid]);
    let r = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r.status, 200, `⑭首发应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.notify_status, 'sent', '⑭首发 sent');
    const tok1 = (await relRow(relId)).tok;

    // (a) 不带 resend 的 sent 态重复调用仍幂等（既有语义零回归）
    r = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, {});
    assert.strictEqual(r.status, 200, '⑭(a) 无 resend 仍 200');
    assert.strictEqual(r.body.idempotent, true, '⑭(a) 无 resend 幂等语义不回归');

    // (b) resend:true → 保留原执行人重发。先软删当日排班再重发——若重发误走"重查排班"会 no_duty_roster 409，
    //     以此证明重发不重查（执行人已锁定，换人唯一路径仍是 cancel-schedule）。
    await run(`UPDATE sys_release_duty_roster SET removed_at=datetime('now'), removed_by=1, removed_by_name='管理员' WHERE duty_date=? AND removed_at IS NULL`, [d14]);
    await run(`UPDATE sys_releases SET release_assignee_read_at='2031-06-01 10:00' WHERE id=?`, [relId]);   // 造已读态，验证重发重置
    r = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, { resend: true });
    assert.strictEqual(r.status, 200, `⑭(b) resend 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.notify_status, 'sent', '⑭(b) 重发后 sent');
    assert.strictEqual(r.body.release_assignee_id, 5, '⑭(b) 保留原执行人（排班已软删仍成功 ⇒ 未重查排班）');
    const after = await relRow(relId);
    assert.notStrictEqual(after.tok, tok1, '⑭(b) token 换新（新一轮投递代际）');
    assert.strictEqual(after.readAt, null, '⑭(b) 已读状态随重发重置 NULL');
    assert.strictEqual(after.ns, 'sent', '⑭(b) 落库 sent');

    // (c) sending 在途 resend → 409 NOTIFY_SENDING_IN_PROGRESS（两段 CAS 并发防护对 resend 同样生效）
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sending', release_assignee_notify_started_at=datetime('now','localtime') WHERE id=?`, [relId]);
    r = await call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, { resend: true });
    assert.strictEqual(r.status, 409, `⑭(c) sending 态 resend 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_SENDING_IN_PROGRESS', '⑭(c) code=NOTIFY_SENDING_IN_PROGRESS');
    await run(`UPDATE sys_releases SET release_assignee_notify_status='sent', release_assignee_notify_started_at=NULL WHERE id=?`, [relId]);

    // (d) 查已读端点四分支：非 admin 403 / 未发送 400 / 已固化 cached / 未固化走配置检查（stub 空配置 → 500 fail-safe）
    r = await call('GET', `/api/sys-releases/${relId}/executor-read-status`, dev5Tok);
    assert.strictEqual(r.status, 403, `⑭(d) 非 admin 查已读应 403, got ${r.status}`);
    const relNo = await mkRelease({ title: '⑭未发送', withMember: true });
    r = await call('GET', `/api/sys-releases/${relNo}/executor-read-status`, adminTok);
    assert.strictEqual(r.status, 400, `⑭(d) 未发送批次应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_NOT_SENT', '⑭(d) code=NOTIFY_NOT_SENT');
    await run(`UPDATE sys_releases SET release_assignee_read_at='2031-06-02 09:00' WHERE id=?`, [relId]);
    r = await call('GET', `/api/sys-releases/${relId}/executor-read-status`, adminTok);
    assert.strictEqual(r.status, 200, `⑭(d) 已固化查已读应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.cached, true, '⑭(d) 已固化直接返 cached（不再外呼钉钉）');
    assert.strictEqual(r.body.read, true, '⑭(d) read=true');
    await run(`UPDATE sys_releases SET release_assignee_read_at=NULL WHERE id=?`, [relId]);
    r = await call('GET', `/api/sys-releases/${relId}/executor-read-status`, adminTok);
    assert.strictEqual(r.status, 500, `⑭(d) 未固化走活查分支——stub 空配置应 500 fail-safe, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NO_DINGTALK_CONFIG', '⑭(d) code=NO_DINGTALK_CONFIG（真实环境此分支继续外呼钉钉查回执）');

    // (e) [codex 211 审 LOW-3 采纳] 真实并发双 resend——sysBeginImmediate 全局互斥下两种合法结局：
    //     交错型=恰 1 个 200 + 1 个 409（并发族 code）；串行型=两次都 200（后者在前者回写完成后才抢占，
    //     两次都是合法重发）。**不合法**的形态=任何 5xx / 非 200·409 状态码 / 终态不回 sent——断言按
    //     不变量建模而非硬猜结局（防"断言永远成立"与"断言碰运气翻车"两个坑）。
    const [ra, rb] = await Promise.all([
      call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, { resend: true }),
      call('POST', `/api/sys-releases/${relId}/notify-executor`, adminTok, { resend: true }),
    ]);
    const oks14 = [ra, rb].filter(x => x.status === 200);
    const rejects14 = [ra, rb].filter(x => x.status === 409);
    assert.strictEqual(oks14.length + rejects14.length, 2, `⑭(e) 双 resend 全部落 200/409 无 5xx（实得 ${ra.status}/${rb.status}）`);
    assert.ok(oks14.length >= 1, `⑭(e) 至少一方成功（实得 ${ra.status}/${rb.status} ${JSON.stringify(ra.body)} ${JSON.stringify(rb.body)}）`);
    if (rejects14.length) {
      assert.ok(['NOTIFY_SENDING_IN_PROGRESS', 'NOTIFY_CAS_CONFLICT'].includes(rejects14[0].body.code),
        `⑭(e) 败方 409 须为并发族 code（实得 ${rejects14[0].body.code}）`);
    }
    assert.strictEqual((await relRow(relId)).ns, 'sent', '⑭(e) 终态回 sent（无论交错/串行，胜者回写完成）');

    // (f) [codex 211 审 MED-1 裁定锁定] 查已读=历史查询能力：已发布批次仍可查（cached）——发布不动通知列，
    //     "同一次投递的事实固化/回读"在发布后依然成立（刻意允许的边界，见端点注释）。
    await run(`UPDATE sys_releases SET status='已发布', release_assignee_read_at='2031-06-03 08:00' WHERE id=?`, [relId]);
    r = await call('GET', `/api/sys-releases/${relId}/executor-read-status`, adminTok);
    assert.strictEqual(r.status, 200, `⑭(f) 已发布批次查已读应 200（历史查询能力）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.read, true, '⑭(f) read=true');
    assert.strictEqual(r.body.cached, true, '⑭(f) cached（已固化直接返，不外呼）');

    ok('⑭ 通知三件套：sent 重发（保留原执行人[排班软删仍成功证不重查]+token 换新+已读重置+无 resend 幂等零回归+sending 在途 409+真实并发双 resend 不变量）+ 查已读端点（非 admin 403 / 未发送 400 / 已固化 cached / 未固化配置 fail-safe / 已发布批次历史查询）');
  }

  console.log(`\n✅ verify-sys-release-batch 全部通过（${passed} 组·上线体统一重构 C2a+C2b 核心场景+并发/锁序/崩溃恢复+C8 跨阶段冒烟+⑭通知三件套）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
