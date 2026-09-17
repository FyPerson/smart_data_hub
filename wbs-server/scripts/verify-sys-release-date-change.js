// 验证脚本：上线逾期留痕 C4·B 块（方案 20260910 v1.2 §5.2）——改期端点基准留痕与逾期理由契约
//   用法：node scripts/verify-sys-release-date-change.js
//
// 背景：update-planned-date 端点新增「旧值合法性守卫 + 逾期后改期须理由」闸（changed===true 时才生效，
//   同值 no-op 不受影响，防「打开弹层→直接确认」这个无副作用操作被误拦——C0 核查报告 ③ 头号回归用例）；
//   applyReleaseChange 的 release_date_change 摘要补旧→新值/批次号/逾期天数/理由，payload_json 结构化。
//
// 覆盖组：
//   [1] 同值 no-op 不受理由闸影响（旧值已过期时也一样 200，无新 timeline，执行人子表不重置）
//   [2] 未传=清空路径（未逾期旧值 → 200 changed=true，摘要「→ 未设定」）
//   [3] 逾期后改期缺理由 400 + 响应体三字段（含 overdue_days 数值核）
//   [4] 逾期后清空也要理由 400
//   [5] 未逾期改期不问理由 200
//   [6] 非法脏旧值（SQL 植入）不触发理由闸，可正常改正，摘要「原值（异常）」，payload 无 overdue_days
//   [7] 摘要旧→新 + resetDiscardSuffix 保留 + payload 五字段
//   [8] 理由超长 400 TOO_LONG
//   [9] 非字符串理由 400 INVALID
//   [10] C1 硬拦仍先于理由闸（旧值过期 + 改成昨天 → PLANNED_DATE_BEFORE_TODAY，不是理由码）
//   [11] 零成员批次逾期后带理由改期 → 200（不拒绝）+ 零 timeline 行 + 理由无处落痕改走 warn 日志（M1）
//
// 断言纪律：精确状态码 + 精确 error code；正例断言真实落库副作用（timeline summary/payload_json 逐值核对，
//   执行人子表软删与否）；负例同样断言"零副作用"（planned_date 未变、无新 timeline 行）。
//
// 时钟纪律（照 verify-sys-release-overdue.js C2c·M2 范式）：overdue_days 精确值用 `pastDateStr(N)` 构造
//   旧值 + 断言时现查 `todayStr()` 现算期望差值，不写死天数；整个文件包一层跨零点检测 + 子进程重跑保护。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');

function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const RUN_START_DATE = ymd(new Date());

const SECRET = 'verify-sys-release-date-change-secret';
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

// [C4b·M1] 捕获 warn 日志——供「零成员批次带理由」用例断言日志真实出现（不能静默吞）。
const warnLogs = [];
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: (...args) => { warnLogs.push(args.join(' ')); }, error: noop, debug: noop },
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

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, { title: extra.title || 'C4 改期测试批次' });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  if (extra.plannedDate !== undefined) await run(`UPDATE sys_releases SET planned_date = ? WHERE id = ?`, [extra.plannedDate, id]);
  return id;
}
async function mkIssue(extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('feature', '待上线', ?, 'BMS', '内部', 1, '管理员')`,
    [extra.title || 'C4 改期测试成员单']
  );
  return r.lastID;
}
async function addIssueTo(relId, issueId) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [issueId] });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
}
async function addExecutor(relId, userId, userName, execStatus) {
  await run(
    `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, executed_at, added_by, added_by_name)
     VALUES (?, ?, ?, 'sent', datetime('now','localtime'), ?, ${execStatus === 'done' ? "datetime('now','localtime')" : 'NULL'}, 1, '管理员')`,
    [relId, userId, userName, execStatus || 'pending']
  );
}
async function activeExecCount(relId) {
  const rows = await all(`SELECT id FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL`, [relId]);
  return rows.length;
}
async function timelineByCode(relId, actionCode) {
  return all(`SELECT summary, payload_json FROM sys_issue_timeline WHERE ref_id = ? AND action_code = ? ORDER BY id`, [relId, actionCode]);
}
async function releaseNoOf(relId) {
  return (await get(`SELECT release_no FROM sys_releases WHERE id = ?`, [relId])).release_no;
}
async function plannedDateOf(relId) {
  return (await get(`SELECT planned_date FROM sys_releases WHERE id = ?`, [relId])).planned_date;
}
async function todayStr() { return (await get(`SELECT date('now','localtime') AS d`)).d; }
async function pastDateStr(daysAgo) { return (await get(`SELECT date('now','localtime', ?) AS d`, [`-${daysAgo} day`])).d; }
async function futureDateStr(daysAhead) { return (await get(`SELECT date('now','localtime', ?) AS d`, [`+${daysAhead} day`])).d; }

// [C4·M2 同款范式] 跨零点检测收尾。
function finishWithCrossMidnightGuard(exitCode) {
  try { db.close(); } catch (_) { /* :memory: 无文件句柄 */ }
  try { server && server.close(); } catch (_) { /* 进程即将退出 */ }
  const endDateStr = ymd(new Date());
  if (endDateStr === RUN_START_DATE) {
    process.exit(exitCode);
  }
  if (process.env.RELEASE_DATE_CHANGE_XMID_RETRY === '1') {
    console.log(`\n⛔ ABORT: 连续跨零点（开工日=${RUN_START_DATE}，收尾日=${endDateStr}），重跑一次仍跨零点，放弃`);
    process.exit(2);
  }
  console.log(`\n⏭️  跨零点（开工日=${RUN_START_DATE}，收尾日=${endDateStr}），结果不可信，自动重跑一次子进程…`);
  const child = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, RELEASE_DATE_CHANGE_XMID_RETRY: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (1,'admin','管理员','admin','active')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1）');

  // ═══ [1] 同值 no-op 不受理由闸影响（旧值已过期时也一样，头号回归用例）═══
  {
    const oldDate = await pastDateStr(5);
    const rel1 = await mkRelease({ title: '[1]同值no-op', plannedDate: oldDate });
    const issue1 = await mkIssue();
    await addIssueTo(rel1, issue1);
    await addExecutor(rel1, 5, '开发甲', 'pending');
    const execBefore = await activeExecCount(rel1);
    assert.strictEqual(execBefore, 1, '[1-前置] 执行人子表在册 1 行');
    const tlBefore = (await timelineByCode(rel1, 'release_date_change')).length;
    const r1 = await call('POST', `/api/sys-releases/${rel1}/update-planned-date`, adminTok, { planned_date: oldDate });
    assert.strictEqual(r1.status, 200, `[1] 同值提交期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.changed, false, '[1] changed=false');
    const tlAfter = (await timelineByCode(rel1, 'release_date_change')).length;
    assert.strictEqual(tlAfter, tlBefore, '[1] 无新 timeline 行');
    const execAfter = await activeExecCount(rel1);
    assert.strictEqual(execAfter, 1, '[1] 执行人子表未被重置（仍 1 行在册）');
    ok('[1] 旧值已过期 + 同值提交：200 changed=false，无新 timeline，执行人子表不重置（理由闸不受影响）');
  }

  // ═══ [2] 未传=清空路径（未逾期旧值）═══
  {
    // [C4b·L8] body 传 {}（真正走 planned_date undefined 分支——normalizeDeadline(undefined) → 清空），
    //   与「显式传 planned_date:''」是两条不同输入但同一清空语义，下方另补一条覆盖后者，不用一条
    //   用例冒充验了两条路径。
    const oldDate = await futureDateStr(10);
    const rel2 = await mkRelease({ title: '[2]清空未逾期', plannedDate: oldDate });
    const r2 = await call('POST', `/api/sys-releases/${rel2}/update-planned-date`, adminTok, {});
    assert.strictEqual(r2.status, 200, `[2] 期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.changed, true, '[2] changed=true');
    assert.strictEqual(await plannedDateOf(rel2), null, '[2] planned_date 已清空');
    ok('[2] 未逾期旧值清空（未传 planned_date）：200 changed=true（未传字段=清空，既有契约不变）');

    const rel2b = await mkRelease({ title: '[2b]清空未逾期-空串', plannedDate: oldDate });
    const r2b = await call('POST', `/api/sys-releases/${rel2b}/update-planned-date`, adminTok, { planned_date: '' });
    assert.strictEqual(r2b.status, 200, `[2b] 期望 200, got ${r2b.status} ${JSON.stringify(r2b.body)}`);
    assert.strictEqual(r2b.body.changed, true, '[2b] changed=true');
    assert.strictEqual(await plannedDateOf(rel2b), null, '[2b] planned_date 已清空');
    ok('[2b] 未逾期旧值清空（显式传 planned_date:""）：200 changed=true（与 [2] 互补覆盖两条不同输入路径）');
  }

  // ═══ [2c] [#67 C9·578-M4] 单成员批次清空日期 → timeline 的 changes 必须**照样写**，new 严格为 null ═══
  {
    // ⚠️ 为什么另起一组而不复用 [2]/[2b]：那两组用的是**零成员批次**（`mkRelease` 不加成员），
    //   零成员 ⇒ applyReleaseChange 一条 timeline 都不写（见其内 M1 注释）⇒ 根本没有载荷可断。
    // ⚠️ 本组要防的退化（codex 578-M4）：若写点改成「只在新值非空时才写 changes」，
    //   [7] 那组（非空→非空）照样全绿、变异也抓不住 ⇒ 清空这条路径必须有自己的载荷断言。
    //   业务上清空是**合法操作**（normalizeDeadline 明确「留空可清除」），展开区应显「旧值 →（空）」，
    //   不是「修改明细不可用」。
    const oldDate2c = await futureDateStr(9);
    const rel2c = await mkRelease({ title: '[2c]单成员清空', plannedDate: oldDate2c });
    const issue2c = await mkIssue();
    await addIssueTo(rel2c, issue2c);
    const r2c = await call('POST', `/api/sys-releases/${rel2c}/update-planned-date`, adminTok, { planned_date: '' });
    assert.strictEqual(r2c.status, 200, `[2c] 期望 200, got ${r2c.status} ${JSON.stringify(r2c.body)}`);
    assert.strictEqual(r2c.body.changed, true, '[2c] changed=true');
    assert.strictEqual(await plannedDateOf(rel2c), null, '[2c] planned_date 已清空');
    const tl2c = await timelineByCode(rel2c, 'release_date_change');
    assert.strictEqual(tl2c.length, 1, `[2c] timeline 恰 1 条（单成员），实得 ${tl2c.length}`);
    assert.ok(tl2c[0].summary.includes('→ 未设定'), `[2c] 摘要应含「→ 未设定」，实得 ${tl2c[0].summary}`);
    const p2c = JSON.parse(tl2c[0].payload_json);
    assert.strictEqual(p2c.planned_date_new, null, '[2c] payload.planned_date_new=null（清空）');
    assert.ok(Array.isArray(p2c.changes) && p2c.changes.length === 1, `[2c] **清空同样要写 changes**（恰一项），实得 ${JSON.stringify(p2c.changes)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(p2c.changes[0], 'new'), `[2c] changes[0] 的 new 键必须存在（值为 null ≠ 缺键），实得 ${JSON.stringify(p2c.changes[0])}`);
    assert.strictEqual(p2c.changes[0].new, null, `[2c] changes[0].new 严格为 null（清空是合法状态，前端渲染成「（空）」），实得 ${JSON.stringify(p2c.changes[0].new)}`);
    assert.strictEqual(p2c.changes[0].old, p2c.planned_date_old, '[2c] changes[0].old 与同 payload 的 planned_date_old 逐值相等');
    assert.strictEqual(p2c.changes[0].old, oldDate2c, `[2c] changes[0].old 应是清空前的日期 ${oldDate2c}，实得 ${p2c.changes[0].old}`);
    // [578-R M-new2] 清空路径也必须断 field —— 否则「只在清空时漏写/写错 field」这种条件退化，
    //   上面几条全过但**前端认不出是哪个字段**（拿不到「计划上线日期」中文名）。
    //   与非空用例 [7] 保持**同一份对象结构契约**。
    assert.deepStrictEqual(Object.keys(p2c.changes[0]).sort(), ['field', 'new', 'old'].sort(), `[2c] changes[0] 恰 {field,old,new} 三键（与 [7] 同契约），实得 ${JSON.stringify(p2c.changes[0])}`);
    assert.strictEqual(p2c.changes[0].field, 'planned_date', `[2c] changes[0].field=planned_date（前端按此键取中文名「计划上线日期」），实得 ${JSON.stringify(p2c.changes[0].field)}`);
    ok('[2c] 单成员批次清空日期：200 + 摘要「→ 未设定」+ payload.changes **照样写**且 new 严格为 null（防"只在新值非空时写 changes"的退化）');
  }

  // ═══ [3] 逾期后改期缺理由 400 + 三字段 ═══
  {
    const oldDate = await pastDateStr(4);
    const rel3 = await mkRelease({ title: '[3]逾期缺理由', plannedDate: oldDate });
    const newDate = await futureDateStr(3);
    const r3 = await call('POST', `/api/sys-releases/${rel3}/update-planned-date`, adminTok, { planned_date: newDate });
    const todayAtAssert = await todayStr();
    const expectDays = I.releaseOverdueCalendarDayDiff(todayAtAssert, oldDate);
    assert.strictEqual(r3.status, 400, `[3] 期望 400, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'RELEASE_DATE_CHANGE_REASON_REQUIRED', `[3] 确切码，实际 ${r3.body.code}`);
    assert.strictEqual(r3.body.date_change_reason_required, true, '[3] date_change_reason_required=true');
    assert.strictEqual(r3.body.planned_date_old, oldDate, '[3] planned_date_old 回带旧值');
    assert.strictEqual(r3.body.overdue_days, expectDays, `[3] overdue_days 精确值，期望 ${expectDays} 实际 ${r3.body.overdue_days}`);
    assert.strictEqual(await plannedDateOf(rel3), oldDate, '[3] 零副作用：planned_date 未变');
    assert.strictEqual((await timelineByCode(rel3, 'release_date_change')).length, 0, '[3] 零副作用：无新 timeline');
    ok(`[3] 逾期后改期缺理由：400 RELEASE_DATE_CHANGE_REASON_REQUIRED + 三字段（planned_date_old=${oldDate}, overdue_days=${expectDays}），零副作用`);
  }

  // ═══ [4] 逾期后清空也要理由 400 ═══
  {
    const oldDate = await pastDateStr(2);
    const rel4 = await mkRelease({ title: '[4]逾期清空缺理由', plannedDate: oldDate });
    const r4 = await call('POST', `/api/sys-releases/${rel4}/update-planned-date`, adminTok, { planned_date: '' });
    assert.strictEqual(r4.status, 400, `[4] 期望 400, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.code, 'RELEASE_DATE_CHANGE_REASON_REQUIRED', `[4] 确切码，实际 ${r4.body.code}`);
    assert.strictEqual(await plannedDateOf(rel4), oldDate, '[4] 零副作用：planned_date 未变（清空也算变更，同样被理由闸拦下）');
    ok('[4] 逾期后清空日期同样须理由：400 RELEASE_DATE_CHANGE_REASON_REQUIRED，零副作用');
  }

  // ═══ [5] 未逾期改期不问理由 200 ═══
  {
    const oldDate = await futureDateStr(5);
    const rel5 = await mkRelease({ title: '[5]未逾期不问理由', plannedDate: oldDate });
    const newDate = await futureDateStr(8);
    const r5 = await call('POST', `/api/sys-releases/${rel5}/update-planned-date`, adminTok, { planned_date: newDate });
    assert.strictEqual(r5.status, 200, `[5] 期望 200, got ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.changed, true, '[5] changed=true');
    assert.strictEqual(await plannedDateOf(rel5), newDate, '[5] planned_date 已更新');
    ok('[5] 未逾期改期：200，不问理由');
  }

  // ═══ [6] 非法脏旧值不触发理由闸，可正常改正 ═══
  {
    const rel6 = await mkRelease({ title: '[6]脏旧值' });
    const issue6 = await mkIssue();
    await addIssueTo(rel6, issue6);
    await run(`UPDATE sys_releases SET planned_date = '2026-13-99' WHERE id = ?`, [rel6]);
    assert.strictEqual(await plannedDateOf(rel6), '2026-13-99', '[6-前置] 脏值已植入');
    const newDate = await futureDateStr(1);
    const r6 = await call('POST', `/api/sys-releases/${rel6}/update-planned-date`, adminTok, { planned_date: newDate });
    assert.strictEqual(r6.status, 200, `[6] 脏旧值不触发理由闸，期望 200, got ${r6.status} ${JSON.stringify(r6.body)}`);
    assert.strictEqual(r6.body.changed, true, '[6] changed=true');
    assert.strictEqual(await plannedDateOf(rel6), newDate, '[6] 改正成功');
    const tl6 = await timelineByCode(rel6, 'release_date_change');
    assert.strictEqual(tl6.length, 1, '[6] timeline 恰 1 条');
    assert.ok(tl6[0].summary.includes('2026-13-99（异常）'), `[6] 摘要如实显示原值+异常标注，实际 ${tl6[0].summary}`);
    const payload6 = JSON.parse(tl6[0].payload_json);
    assert.strictEqual(payload6.overdue_days, null, '[6] payload overdue_days=null（脏值不生成迟到天数）');
    assert.strictEqual(payload6.planned_date_old, '2026-13-99', '[6] payload planned_date_old 原样落库（不是清洗后的值）');
    assert.strictEqual(payload6.reason, null, '[6] payload reason=null（未触发理由闸）');
    ok('[6] 非法脏旧值（round-trip 不过）：不触发理由闸、可正常改正为合法日期，摘要含"2026-13-99（异常）"，payload.overdue_days=null');
  }

  // ═══ [7] 摘要旧→新 + resetDiscardSuffix 保留 + payload 五字段 ═══
  {
    const oldDate = await pastDateStr(3);
    const rel7 = await mkRelease({ title: '[7]摘要与丢弃后缀', plannedDate: oldDate });
    const issue7 = await mkIssue();
    await addIssueTo(rel7, issue7);
    await addExecutor(rel7, 5, '开发甲', 'done');
    const newDate = await futureDateStr(2);
    const r7 = await call('POST', `/api/sys-releases/${rel7}/update-planned-date`, adminTok, { planned_date: newDate, reason: '业务方要求延后上线窗口' });
    assert.strictEqual(r7.status, 200, `[7] 期望 200, got ${r7.status} ${JSON.stringify(r7.body)}`);
    // [561-M2] 本组是全文件唯一「逾期+带理由+有成员+重置执行人」的成功用例——此前只断言了摘要/payload/
    // 执行人子表，从未断言过响应体 changed/planned_date 与库落值本身，补齐这一半（同 [3]/[6] 等其余用例
    // 早已有的 changed/planned_date 断言范式，本组此前是唯一的遗漏）。
    assert.strictEqual(r7.body.changed, true, '[7] 响应 changed=true（真实发生了改期）');
    assert.strictEqual(r7.body.planned_date, newDate, `[7] 响应 planned_date=新值，实际 ${r7.body.planned_date}`);
    const relRowAfter7 = await get('SELECT planned_date FROM sys_releases WHERE id=?', [rel7]);
    assert.strictEqual(relRowAfter7.planned_date, newDate, `[7] 独立 SELECT 落库 planned_date=新值，实际 ${relRowAfter7.planned_date}`);
    const relNo7 = await releaseNoOf(rel7);
    const tl7 = await timelineByCode(rel7, 'release_date_change');
    assert.strictEqual(tl7.length, 1, '[7] timeline 恰 1 条（批次仅 1 个成员单）');
    const summary7 = tl7[0].summary;
    assert.ok(summary7.includes(`${oldDate} → ${newDate}`), `[7] 摘要含旧→新，实际 ${summary7}`);
    assert.ok(summary7.includes(`批次 ${relNo7}`), `[7] 摘要含批次号，实际 ${summary7}`);
    assert.ok(summary7.includes('原因：业务方要求延后上线窗口'), `[7] 摘要含理由，实际 ${summary7}`);
    assert.ok(/已丢弃 1 条完成确认：开发甲/.test(summary7), `[7] resetDiscardSuffix 保留（已丢弃完成确认），实际 ${summary7}`);
    const payload7 = JSON.parse(tl7[0].payload_json);
    // [#67 C9·2026-09-16] 键集合由**五字段改六字段**——B1 追加 `changes` 是**有意的契约演进**，
    //   不是绕过本断言（方案 §B1 明列本处为唯一「严格键集合消费者」）。其余四条逐字段断言原样保留。
    assert.deepStrictEqual(Object.keys(payload7).sort(), ['changes', 'overdue_days', 'planned_date_new', 'planned_date_old', 'reason', 'release_no'].sort(), '[7] payload 恰六字段（#67 B1 起追加 changes）');
    assert.strictEqual(payload7.planned_date_old, oldDate, '[7] payload.planned_date_old');
    assert.strictEqual(payload7.planned_date_new, newDate, '[7] payload.planned_date_new');
    assert.strictEqual(payload7.reason, '业务方要求延后上线窗口', '[7] payload.reason');
    assert.strictEqual(payload7.release_no, relNo7, '[7] payload.release_no');
    // [#67 C9·2026-09-16] 锁 `changes` 的结构**并与同 payload 的两键逐值比对**——防止写端出现
    //   「changes 自己去 delta 重取一遍」这种取值来源分叉（feedback_write_read_same_semantic）。
    //   ⚠️ 断的是**与同一 payload 内的值相等**，不是与 oldDate/newDate 相等：后者只能证明这一组夹具
    //   对得上，前者才锁住"两处永远同源"这个不变量（换任何夹具都成立）。
    assert.ok(Array.isArray(payload7.changes), `[7] payload.changes 应是数组，实得 ${JSON.stringify(payload7.changes)}`);
    assert.strictEqual(payload7.changes.length, 1, `[7] payload.changes 恰一个元素（改期只改一个字段），实得 ${payload7.changes.length}`);
    assert.deepStrictEqual(Object.keys(payload7.changes[0]).sort(), ['field', 'new', 'old'].sort(), `[7] changes[0] 恰 {field,old,new} 三键，实得 ${JSON.stringify(payload7.changes[0])}`);
    assert.strictEqual(payload7.changes[0].field, 'planned_date', '[7] changes[0].field=planned_date（前端 SI_TL_CHANGE_FIELD_LABEL 按此键取中文名「计划上线日期」）');
    assert.strictEqual(payload7.changes[0].old, payload7.planned_date_old, '[7] changes[0].old 与同 payload 的 planned_date_old **逐值相等**（两处取值不得分叉）');
    assert.strictEqual(payload7.changes[0].new, payload7.planned_date_new, '[7] changes[0].new 与同 payload 的 planned_date_new **逐值相等**（两处取值不得分叉）');
    // [C4b·L6] 精确数值核对（同 [3] 范式：断言时现查 todayStr() 现算期望差值，不满足于"是个数字"）。
    const expectDays7 = I.releaseOverdueCalendarDayDiff(await todayStr(), oldDate);
    assert.strictEqual(payload7.overdue_days, expectDays7, `[7] payload.overdue_days 精确值，期望 ${expectDays7} 实际 ${payload7.overdue_days}`);
    const execAfter7 = await activeExecCount(rel7);
    assert.strictEqual(execAfter7, 0, '[7] 执行人子表已重置（全体软删）');
    ok('[7] 逾期后带理由改期：摘要旧→新+批次号+逾期天数+原因+resetDiscardSuffix 全部齐全，payload_json 恰六字段（含 #67 changes 且与两键逐值同源），执行人子表如常重置');
  }

  // ═══ [8] 理由超长 400 TOO_LONG ═══
  {
    const oldDate = await pastDateStr(1);
    const rel8 = await mkRelease({ title: '[8]理由超长', plannedDate: oldDate });
    const longReason = '超'.repeat(I.RELEASE_DATE_CHANGE_REASON_MAX + 1);
    const r8 = await call('POST', `/api/sys-releases/${rel8}/update-planned-date`, adminTok, { planned_date: await futureDateStr(1), reason: longReason });
    assert.strictEqual(r8.status, 400, `[8] 期望 400, got ${r8.status} ${JSON.stringify(r8.body)}`);
    assert.strictEqual(r8.body.code, 'RELEASE_DATE_CHANGE_REASON_TOO_LONG', `[8] 确切码，实际 ${r8.body.code}`);
    assert.strictEqual(await plannedDateOf(rel8), oldDate, '[8] 零副作用');
    ok(`[8] 改期理由超长（${I.RELEASE_DATE_CHANGE_REASON_MAX + 1} 字）：400 RELEASE_DATE_CHANGE_REASON_TOO_LONG`);
  }

  // ═══ [9] 非字符串理由 400 INVALID ═══
  {
    const oldDate = await pastDateStr(1);
    const rel9 = await mkRelease({ title: '[9]理由非字符串', plannedDate: oldDate });
    const r9 = await call('POST', `/api/sys-releases/${rel9}/update-planned-date`, adminTok, { planned_date: await futureDateStr(1), reason: 12345 });
    assert.strictEqual(r9.status, 400, `[9] 期望 400, got ${r9.status} ${JSON.stringify(r9.body)}`);
    assert.strictEqual(r9.body.code, 'RELEASE_DATE_CHANGE_REASON_INVALID', `[9] 确切码，实际 ${r9.body.code}`);
    ok('[9] 改期理由非字符串（数字）：400 RELEASE_DATE_CHANGE_REASON_INVALID');
  }

  // ═══ [10] C1 硬拦仍先于理由闸 ═══
  {
    const oldDate = await pastDateStr(2);
    const rel10 = await mkRelease({ title: '[10]C1先于理由闸', plannedDate: oldDate });
    const yesterday = await pastDateStr(1);
    const r10 = await call('POST', `/api/sys-releases/${rel10}/update-planned-date`, adminTok, { planned_date: yesterday });   // 不带 reason
    assert.strictEqual(r10.status, 400, `[10] 期望 400, got ${r10.status} ${JSON.stringify(r10.body)}`);
    assert.strictEqual(r10.body.code, 'PLANNED_DATE_BEFORE_TODAY', `[10] 应命中 C1 硬拦而非理由闸，实际 ${r10.body.code}`);
    assert.strictEqual(r10.body.date_change_reason_required, undefined, '[10] 不应带理由闸的响应字段');
    ok('[10] 旧值已过期 + 新值早于今天（且未带 reason）：命中 C1 硬拦 PLANNED_DATE_BEFORE_TODAY，而非理由闸（校验顺序 C1 在理由闸之前）');
  }

  // ═══ [11]（C4b·Opus 预筛 M1 收口）零成员批次·逾期后带理由改期 → 200 + 无处落痕改走 warn 日志 ═══
  {
    const oldDate = await pastDateStr(2);
    const rel11 = await mkRelease({ title: '[11]零成员逾期带理由', plannedDate: oldDate });   // 未 addIssueTo，零成员
    assert.strictEqual(await activeExecCount(rel11), 0, '[11-前置] 零执行人（零成员批次天然零执行人）');
    const newDate = await futureDateStr(1);
    const warnCountBefore = warnLogs.length;
    const r11 = await call('POST', `/api/sys-releases/${rel11}/update-planned-date`, adminTok, { planned_date: newDate, reason: 'RELDC 零成员夹具·理由无处落痕' });
    assert.strictEqual(r11.status, 200, `[11] 期望 200（改期本身应成功，不因理由无处落痕而拒绝）, got ${r11.status} ${JSON.stringify(r11.body)}`);
    assert.strictEqual(r11.body.changed, true, '[11] changed=true');
    assert.strictEqual(await plannedDateOf(rel11), newDate, '[11] planned_date 已更新');
    const tl11 = await timelineByCode(rel11, 'release_date_change');
    assert.strictEqual(tl11.length, 0, '[11] 零成员=零 timeline 行（release_date_change 走"每受影响成员各写一条"，无成员即无行）');
    const newWarns = warnLogs.slice(warnCountBefore);
    assert.strictEqual(newWarns.length, 1, `[11] 应恰产生 1 条 warn 日志，实得 ${newWarns.length}：${JSON.stringify(newWarns)}`);
    assert.ok(newWarns[0].includes(`releaseId=${rel11}`) && newWarns[0].includes('RELDC 零成员夹具·理由无处落痕'), `[11] warn 日志应含 releaseId 与理由原文，实际 ${newWarns[0]}`);
    ok('[11] 零成员批次逾期后带理由改期：200 成功（不因理由无处落痕而拒绝已完成的操作）+ 零 timeline 行 + 恰 1 条 warn 日志含 releaseId 与理由原文（登记接受：本端点不写 sys_release_audit，零成员是纯理论边界，见 applyReleaseChange 内 M1 注释）');
  }

  console.log(`\n✅ 全部 ${passed} 项通过\n`);
  finishWithCrossMidnightGuard(0);
}

main().catch(err => {
  console.error('❌ 失败：', err);
  finishWithCrossMidnightGuard(1);
});
