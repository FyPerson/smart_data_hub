// 验证脚本：上线逾期留痕 C2·A 块（方案 20260910 v1.2 §5.1/§6/§7）
//   用法：node scripts/verify-sys-release-overdue.js
//
// 背景：execute 端点 rGateSatisfied 分支（内核 _publishReleaseCoreInTxn 返回之后、sysCommit() 之前）
//   新增逾期判定——读回本事务刚写入的 released_at（唯一时间锚来源），与批次 planned_date 比较：
//   普通批次逾期须带理由（缺/非法理由整体回滚），应急批次（release_kind='emergency'）只留事实痕。
//
// 覆盖组：
//   [1] 四象限：未逾期 / 逾期普通缺理由 409 / 逾期普通带理由 200+留痕 / 逾期应急 200+留痕
//   [2] §5.1.3a 六情形错误码逐个断言 code+HTTP+四字段响应体
//   [3] 跨零点同源（released_at 读库值与留痕 payload 同源，非文案自洽）
//   [4] 发布时刻不变量三夹具（546-H1 fail-closed）：released_at NULL / 非法 / status 未翻转
//   [5] 非最后一人带理由不校验不落库；应急带理由不持久化
//   [6] 重复确认不多写 release_overdue_reason 行
//   [7] 层一探针双向（releaseOverdueGroupInvariantViolations）+ [7c] 真实本地库只读扫描（fail-safe）
//   [8] 静态断言：_publishReleaseCoreInTxn 函数体 sha256 与记录基线逐字相等（行数断言保留作副断言——
//       C2b·M1：单纯行数不变会漏放"等行数改写"，如把某行逻辑替换成另一段同样行数的代码）
//
// 断言纪律：精确状态码 + 精确 error code；正例断言真实落库副作用（两列/timeline 行/payload_json 逐值核对）；
//   负例同样断言"零副作用"（批次未落已发布/两列未写/无留痕行/executor 行未烧成 done）。
//
// [C2c·codex 556 号 MEDIUM M2 收口] 时钟依赖盘点（改完后逐条核实，非纸面声明）：
//   - 断言 overdue_days 精确数值 / "同日不算逾期" 的用例（[1a]/[1c]/[2]）：改为固定日历日字面量
//     （planned_date 固定 + AFTER UPDATE OF released_at 触发器把内核写入的 released_at 钉死到固定
//     日期时刻，同 [3] 已有做法）——彻底零真实时钟依赖，测试机是否跨零点都不影响结果。
//   - [1b]/[1d]/[4a-4c]/[5a]/[5b]/[6]：仍用 `pastDateStr(N)`（相对真实"今天"减 N 天）—— **必须**：
//     这些用例只断言"是否逾期"的布尔结果（409 缺理由 / 200 已发布 / 500 不变量），不断言 overdue_days
//     精确值；`pastDateStr(N)`（N≥1）无论真实"今天"在取值后是否跨零点前进，其结果相对"未来任意一个
//     更晚的今天"恒仍在过去——drift 只会让"逾期天数"变大，不会把"已逾期"逆转成"未逾期"，故对这批
//     用例的判定结果零风险；同时 planned_date 恒早于真实"今天"，也不会触发 F1 未来上线日期执行闸
//     （该闸判据是 `planned_date > 今天`，与本文件无关——F1 闸门本身的用例在
//     verify-sys-release-executors.js [8r/8s/8t] 组，不在本文件覆盖范围）。
//   - [7a]/[7b]/[7c]/[8]：纯函数直调/SQL 构造/源码静态分析，零时钟依赖。
//   - 本文件整体仍包一层跨零点检测 + 子进程重跑保护（env `RELEASE_OVERDUE_XMID_RETRY` 标记，照抄
//     verify-sys-date-not-before-today.js 的 C1_XMID_RETRY 范式）作纵深防御——覆盖正常收尾与异常
//     捕获两条退出路径，即便上面的清单有遗漏也有兜底，不代表上面的分析是唯一防线。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 跨零点检测锚点（同 C1 范式：JS 侧纯本地时钟算，不查 DB，模块加载时算死，与运行期间的真实推进对比）。
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const RUN_START_DATE = ymd(new Date());

const SECRET = 'verify-sys-release-overdue-secret';
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

const errorLogs = [];
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: (...args) => { errorLogs.push(args.join(' ')); }, debug: noop },
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
const dev5Tok = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);
const dev6Tok = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);

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
  const r = await call('POST', '/api/sys-releases', adminTok, { title: extra.title || 'A 块逾期测试批次' });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  if (extra.plannedDate !== undefined) await run(`UPDATE sys_releases SET planned_date = ? WHERE id = ?`, [extra.plannedDate, id]);
  if (extra.releaseKind) await run(`UPDATE sys_releases SET release_kind = ? WHERE id = ?`, [extra.releaseKind, id]);
  return id;
}
async function mkIssue(extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('feature', '待上线', ?, 'BMS', '内部', 1, '管理员')`,
    [extra.title || 'A 块逾期测试成员单']
  );
  return r.lastID;
}
async function addIssueTo(relId, issueId) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [issueId] });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
}
async function mkCompleteRoster(issueId, userId = 5, userName = '开发甲') {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
    [issueId, userId, userName]
  );
}
async function addExecutor(relId, userId = 5, userName = '开发甲') {
  await run(
    `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
     VALUES (?, ?, ?, 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`,
    [relId, userId, userName]
  );
}
async function execRow(relId, userId) {
  return get(`SELECT * FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL`, [relId, userId]);
}
async function overdueTimeline(relId) {
  return all(`SELECT issue_id, summary, event_type, action_code, ref_id, operator_id, operator_name, payload_json FROM sys_issue_timeline WHERE ref_id = ? AND action_code = 'release_overdue_reason' ORDER BY id`, [relId]);
}
// [561-M3] 整体回滚场景的零副作用快照——供"请求前后逐项 deepStrictEqual"复用：[1b]/[2] 六次失败尝试/
//   [4a-c] 三夹具共用同一份判据，防止各处各写一份、漏项风险各不相同（同族先例"清集合逻辑全仓唯一实现"
//   同一纪律）。issueIds 传该批次全部成员单 id 数组。
async function snapshotReleaseSideEffects(relId, issueIds) {
  const rel = await get(
    `SELECT status, released_at, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?`, [relId]);
  const issues = [];
  for (const iid of issueIds) {
    issues.push(await get(`SELECT id, status, released_at, online_source FROM sys_issues WHERE id=?`, [iid]));
  }
  const tlReleaseCount = (await get(
    `SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE ref_id=? AND event_type='release'`, [relId])).c;
  const tlPublishedCount = (await get(
    `SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_published'`, [relId])).c;
  const tlOverdueCount = (await get(
    `SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_overdue_reason'`, [relId])).c;
  const execStatuses = await all(
    `SELECT user_id, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [relId]);
  return {
    release: rel,
    issues,
    timeline: { release: tlReleaseCount, release_published: tlPublishedCount, release_overdue_reason: tlOverdueCount },
    execStatuses,
  };
}
// 单人单成员批次的一站式搭建：建批次(+plannedDate/releaseKind) + 建单 + 加单 + 补全开发花名册 + 建执行人行。
async function mkOneMemberReadyRelease(extra = {}) {
  const relId = await mkRelease(extra);
  const issueId = await mkIssue({ title: extra.issueTitle });
  await addIssueTo(relId, issueId);
  await mkCompleteRoster(issueId, extra.userId || 5, extra.userName || '开发甲');
  await addExecutor(relId, extra.userId || 5, extra.userName || '开发甲');
  const row = await execRow(relId, extra.userId || 5);
  return { relId, issueId, execRowId: row.id };
}
async function todayStr() { return (await get(`SELECT date('now','localtime') AS d`)).d; }
async function pastDateStr(daysAgo) { return (await get(`SELECT date('now','localtime', ?) AS d`, [`-${daysAgo} day`])).d; }
// [C2c·M2] 固定日历日时钟隔离：用 AFTER UPDATE OF released_at 触发器把内核在事务内真实写入的
//   released_at 钉死到调用方指定的固定值（同 [3] 已验证的做法），期间 fn() 里的 HTTP 调用产生的
//   released_at 无论真实系统时钟落在哪一刻，最终落库值恒为 fixedDatetime——断言 overdue_days 等精确
//   数值的用例据此彻底摆脱真实时钟依赖。trigger 名以 relId 为后缀天然去重，用完必删（finally 兜底）。
async function withFixedReleasedAt(relId, fixedDatetime, fn) {
  const trgName = `trg_fix_released_at_${relId}`;
  await run(`CREATE TRIGGER ${trgName} AFTER UPDATE OF released_at ON sys_releases
    WHEN NEW.id = ${relId} AND NEW.status = '已发布' AND NEW.released_at IS NOT NULL AND NEW.released_at != '${fixedDatetime}'
    BEGIN UPDATE sys_releases SET released_at = '${fixedDatetime}' WHERE id = ${relId}; END`);
  try {
    return await fn();
  } finally {
    await run(`DROP TRIGGER ${trgName}`);
  }
}
// [C2c·M2] 跨零点检测收尾（覆盖正常结束 exitCode=0 与异常捕获 exitCode=1 两条路径，同 C1 范式）：
//   关连接/关服务 → 若开工日与此刻日历日一致，直接按给定 exitCode 退出；不一致则视为跨零点，结果
//   不可信——若已是重跑子进程（RELEASE_OVERDUE_XMID_RETRY=1）则 ABORT(2)，否则起一个全新子进程重
//   跑本文件一次（新进程才会重新走 RUN_START_DATE 的计算），以子进程退出码为准。
function finishWithCrossMidnightGuard(exitCode) {
  try { db.close(); } catch (_) { /* :memory: 无文件句柄，尽力关闭 */ }
  try { server && server.close(); } catch (_) { /* 进程即将退出 */ }
  const endDateStr = ymd(new Date());
  if (endDateStr === RUN_START_DATE) {
    process.exit(exitCode);
  }
  if (process.env.RELEASE_OVERDUE_XMID_RETRY === '1') {
    console.log(`\n⛔ ABORT: 连续跨零点（开工日=${RUN_START_DATE}，收尾日=${endDateStr}），重跑一次仍跨零点，放弃`);
    process.exit(2);
  }
  console.log(`\n⏭️  跨零点（开工日=${RUN_START_DATE}，收尾日=${endDateStr}），结果不可信，自动重跑一次子进程…`);
  const child = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, RELEASE_OVERDUE_XMID_RETRY: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (5,'dev5','开发甲','user','active'),
    (6,'dev6','开发乙','user','active')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / dev5,6）');

  // ═══ [1] 四象限 ═══
  {
    // [1a] 未逾期：固定日历日（同 planned_date 与钉死的 released_at 落同一天）→ 200，两列 NULL，
    //   无留痕行。（C2c·M2：不取真实"今天"——取今天后再搭夹具跑请求，期间若跨零点会让 planned_date
    //   与实际 released_at 落到不同日历日，误触发 409；改用固定字面量 + 触发器钉死 released_at，
    //   零真实时钟依赖）
    const FIX_1A_DAY = '2026-01-15';
    const f1a = await mkOneMemberReadyRelease({ title: '[1a]未逾期', plannedDate: FIX_1A_DAY });
    const r1a = await withFixedReleasedAt(f1a.relId, `${FIX_1A_DAY} 09:00:00`, () =>
      call('POST', `/api/sys-releases/${f1a.relId}/execute`, dev5Tok, { release_note: '未逾期', executor_row_id: f1a.execRowId })
    );
    assert.strictEqual(r1a.status, 200, `[1a]期望 200, got ${r1a.status} ${JSON.stringify(r1a.body)}`);
    const rel1a = await get(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?`, [f1a.relId]);
    assert.strictEqual(rel1a.overdue_reason_code, null, '[1a]未逾期 overdue_reason_code 应为 NULL');
    assert.strictEqual(rel1a.overdue_reason_note, null, '[1a]未逾期 overdue_reason_note 应为 NULL');
    const tl1a = await overdueTimeline(f1a.relId);
    assert.strictEqual(tl1a.length, 0, '[1a]未逾期不应产生 release_overdue_reason 留痕行');
    ok('[1a] 未逾期（当日执行）：200 + 两列 NULL + 零留痕行');

    // [1b] 逾期普通缺理由：planned_date=前天，不带理由 → 409，批次仍「计划中」，released_at 仍 NULL，
    //   executor 行回滚至 pending（整体回滚含本人 CAS）
    const past2 = await pastDateStr(2);
    const f1b = await mkOneMemberReadyRelease({ title: '[1b]逾期缺理由', plannedDate: past2 });
    const snap1bBefore = await snapshotReleaseSideEffects(f1b.relId, [f1b.issueId]);
    const r1b = await call('POST', `/api/sys-releases/${f1b.relId}/execute`, dev5Tok, { release_note: '逾期缺理由', executor_row_id: f1b.execRowId });
    assert.strictEqual(r1b.status, 409, `[1b]期望 409, got ${r1b.status} ${JSON.stringify(r1b.body)}`);
    assert.strictEqual(r1b.body.code, 'RELEASE_OVERDUE_REASON_REQUIRED', `[1b]code 应为 RELEASE_OVERDUE_REASON_REQUIRED，实际 ${r1b.body.code}`);
    const rel1b = await get(`SELECT status, released_at FROM sys_releases WHERE id=?`, [f1b.relId]);
    assert.strictEqual(rel1b.status, '计划中', '[1b]批次应仍「计划中」（整体回滚）');
    assert.strictEqual(rel1b.released_at, null, '[1b]released_at 应仍 NULL（整体回滚）');
    const execAfter1b = await execRow(f1b.relId, 5);
    assert.strictEqual(execAfter1b.exec_status, 'pending', '[1b]executor 行应回滚至 pending（本人 CAS 一并撤销）');
    const tl1b = await overdueTimeline(f1b.relId);
    assert.strictEqual(tl1b.length, 0, '[1b]409 后零留痕行');
    // [561-M3] 整体回滚零副作用快照比对——比单纯挑几列断言更强：任何一列/任何一处 timeline 计数/任何
    // 一行 exec_status 被静默改动都会被本对比抓住，不依赖逐项枚举漏项。
    const snap1bAfter = await snapshotReleaseSideEffects(f1b.relId, [f1b.issueId]);
    assert.deepStrictEqual(snap1bAfter, snap1bBefore, '[1b]整体回滚零副作用快照比对（成员单/批次两列/三类 timeline 计数/执行人 exec_status 全部逐项相等）');
    ok('[1b] 逾期·普通·缺理由：409 RELEASE_OVERDUE_REASON_REQUIRED + 批次未发布 + CAS 回滚 + 零留痕行 + 全量快照零副作用');

    // [1c] 逾期普通带理由：2 名成员批次，理由合法 → 200，两列落 trim 后值，冻结成员每张一条留痕，
    //   event_type='note'，payload 七字段齐全，overdue_days 数值等于夹具设定。（C2c·M2：overdue_days
    //   固定断言为 3 依赖真实时钟——改用固定 planned_date + 触发器钉死 released_at，两者相差恰 3 天，
    //   零真实时钟依赖）
    const FIX_1C_PLANNED = '2026-01-10';
    const FIX_1C_RELEASED = '2026-01-13 09:00:00';   // 与 FIX_1C_PLANNED 恰跨 3 个日历日
    const relC = await mkRelease({ title: '[1c]逾期带理由·双成员', plannedDate: FIX_1C_PLANNED });
    const issueC1 = await mkIssue({ title: '[1c]成员①' });
    const issueC2 = await mkIssue({ title: '[1c]成员②' });
    await addIssueTo(relC, issueC1);
    await addIssueTo(relC, issueC2);
    await mkCompleteRoster(issueC1, 5, '开发甲');
    await mkCompleteRoster(issueC2, 5, '开发甲');
    await addExecutor(relC, 5, '开发甲');
    const rowC = await execRow(relC, 5);
    const r1c = await withFixedReleasedAt(relC, FIX_1C_RELEASED, () =>
      call('POST', `/api/sys-releases/${relC}/execute`, dev5Tok, {
        release_note: '逾期带理由', executor_row_id: rowC.id,
        overdue_reason_code: '环境或依赖未就绪', overdue_reason_note: '  等甲方开通防火墙策略  ',
      })
    );
    assert.strictEqual(r1c.status, 200, `[1c]期望 200, got ${r1c.status} ${JSON.stringify(r1c.body)}`);
    const rel1c = await get(`SELECT overdue_reason_code, overdue_reason_note, release_no FROM sys_releases WHERE id=?`, [relC]);
    assert.strictEqual(rel1c.overdue_reason_code, '环境或依赖未就绪', '[1c]overdue_reason_code 应落库');
    assert.strictEqual(rel1c.overdue_reason_note, '等甲方开通防火墙策略', '[1c]overdue_reason_note 应落 trim 后值');
    const tl1c = await overdueTimeline(relC);
    assert.strictEqual(tl1c.length, 2, `[1c]冻结成员集每张一条留痕，期望 2 条，实际 ${tl1c.length}`);
    const issueIdsInTl = tl1c.map(r => r.issue_id).sort();
    assert.deepStrictEqual(issueIdsInTl, [issueC1, issueC2].sort(), '[1c]留痕行覆盖全部冻结成员');
    for (const row of tl1c) {
      assert.strictEqual(row.event_type, 'note', '[1c]event_type 应为 note');
      const p = JSON.parse(row.payload_json);
      assert.strictEqual(p.planned_date, FIX_1C_PLANNED, '[1c]payload.planned_date');
      assert.strictEqual(p.released_date, FIX_1C_RELEASED.slice(0, 10), '[1c]payload.released_date 应等于钉死值前 10 位');
      assert.strictEqual(p.overdue_days, 3, '[1c]payload.overdue_days 应等于夹具设定 3');
      assert.strictEqual(p.reason_code, '环境或依赖未就绪', '[1c]payload.reason_code');
      assert.strictEqual(p.reason_note, '等甲方开通防火墙策略', '[1c]payload.reason_note');
      assert.strictEqual(p.release_no, rel1c.release_no, '[1c]payload.release_no');
      assert.strictEqual(p.release_kind, 'normal', '[1c]payload.release_kind');
      assert.ok(typeof p.released_date === 'string' && p.released_date.length === 10, '[1c]payload.released_date 应为 YYYY-MM-DD');
      assert.ok(row.summary.includes('较计划上线日') && row.summary.includes('迟 3 天') && row.summary.includes('环境或依赖未就绪：等甲方开通防火墙策略'), `[1c]summary 文案不符：${row.summary}`);
    }
    ok('[1c] 逾期·普通·带理由（双成员）：200 + 两列落 trim 值 + 冻结成员每张一条留痕（event_type=note）+ payload 七字段齐全');

    // [1d] 逾期应急：release_kind='emergency' → 200，两列 NULL，留痕行事实形态 summary 含「应急上线跨日完成」
    const past1 = await pastDateStr(1);
    const f1d = await mkOneMemberReadyRelease({ title: '[1d]逾期应急', plannedDate: past1, releaseKind: 'emergency' });
    const r1d = await call('POST', `/api/sys-releases/${f1d.relId}/execute`, dev5Tok, { release_note: '应急逾期', executor_row_id: f1d.execRowId });
    assert.strictEqual(r1d.status, 200, `[1d]期望 200, got ${r1d.status} ${JSON.stringify(r1d.body)}`);
    const rel1d = await get(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?`, [f1d.relId]);
    assert.strictEqual(rel1d.overdue_reason_code, null, '[1d]应急批次 overdue_reason_code 应仍 NULL');
    assert.strictEqual(rel1d.overdue_reason_note, null, '[1d]应急批次 overdue_reason_note 应仍 NULL');
    const tl1d = await overdueTimeline(f1d.relId);
    assert.strictEqual(tl1d.length, 1, '[1d]应急单单成员应恰 1 条留痕');
    assert.ok(tl1d[0].summary.includes('应急上线跨日完成'), `[1d]summary 应含「应急上线跨日完成」：${tl1d[0].summary}`);
    const p1d = JSON.parse(tl1d[0].payload_json);
    assert.strictEqual(p1d.reason_code, null, '[1d]应急 payload.reason_code 应为 null');
    assert.strictEqual(p1d.reason_note, null, '[1d]应急 payload.reason_note 应为 null');
    assert.strictEqual(p1d.release_kind, 'emergency', '[1d]payload.release_kind 应为 emergency');
    ok('[1d] 逾期·应急：200 + 两列 NULL + 事实留痕行（summary 含「应急上线跨日完成」）+ payload reason 为 null');
  }

  // ═══ [2] §5.1.3a 六情形错误码（同一逾期批次内逐个提交，事务回滚可重试） ═══
  {
    // C2c·M2：overdue_days 固定断言为 2 依赖真实时钟——改用固定 planned_date + 触发器钉死每次尝试
    //   （含最终成功那次）内核写入的 released_at，全程零真实时钟依赖。触发器覆盖整组 7 次调用（6 次
    //   失败尝试 + 1 次成功），每次都在同一 WHEN 条件下把 released_at 强制改写为同一固定值。
    const FIX_2_PLANNED = '2026-02-05';
    const FIX_2_RELEASED = '2026-02-07 09:00:00';   // 与 FIX_2_PLANNED 恰跨 2 个日历日
    const f2 = await mkOneMemberReadyRelease({ title: '[2]六情形', plannedDate: FIX_2_PLANNED });
    const snap2Base = await snapshotReleaseSideEffects(f2.relId, [f2.issueId]);
    async function tryReason(extra, expect) {
      const r = await withFixedReleasedAt(f2.relId, FIX_2_RELEASED, () =>
        call('POST', `/api/sys-releases/${f2.relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: f2.execRowId, ...extra })
      );
      assert.strictEqual(r.status, expect.status, `[2/${expect.label}]期望 ${expect.status}, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, expect.code, `[2/${expect.label}]code 应为 ${expect.code}，实际 ${r.body.code}`);
      assert.strictEqual(r.body.overdue_reason_required, true, `[2/${expect.label}]overdue_reason_required 应为 true`);
      assert.strictEqual(r.body.planned_date, FIX_2_PLANNED, `[2/${expect.label}]planned_date 应回带`);
      assert.strictEqual(r.body.released_date, FIX_2_RELEASED.slice(0, 10), `[2/${expect.label}]released_date 应回带钉死值前 10 位`);
      assert.strictEqual(typeof r.body.overdue_days, 'number', `[2/${expect.label}]overdue_days 应为数值`);
      assert.strictEqual(r.body.overdue_days, 2, `[2/${expect.label}]overdue_days 应等于夹具设定 2`);
      // [561-M3] 六次失败尝试逐次快照比对——每次 409/400 都应是事务整体回滚，与最初（尚未发起任何
      // 请求时）的快照逐项相等，不允许任何一次尝试留下哪怕一点残迹。
      const snap2After = await snapshotReleaseSideEffects(f2.relId, [f2.issueId]);
      assert.deepStrictEqual(snap2After, snap2Base, `[2/${expect.label}]整体回滚零副作用快照比对`);
    }
    await tryReason({}, { label: '都缺', status: 409, code: 'RELEASE_OVERDUE_REASON_REQUIRED' });
    await tryReason({ overdue_reason_code: '通知到达晚' }, { label: '只码', status: 409, code: 'RELEASE_OVERDUE_REASON_REQUIRED' });
    await tryReason({ overdue_reason_note: '只有说明' }, { label: '只说明', status: 409, code: 'RELEASE_OVERDUE_REASON_REQUIRED' });
    await tryReason({ overdue_reason_code: '不存在的码', overdue_reason_note: '说明' }, { label: '码不在白名单', status: 400, code: 'RELEASE_OVERDUE_REASON_CODE_INVALID' });
    await tryReason({ overdue_reason_code: '其他', overdue_reason_note: '说'.repeat(301) }, { label: '说明超长', status: 400, code: 'RELEASE_OVERDUE_REASON_NOTE_TOO_LONG' });
    await tryReason({ overdue_reason_code: ['数组非法'], overdue_reason_note: '说明' }, { label: '非字符串', status: 400, code: 'RELEASE_OVERDUE_REASON_INVALID' });
    ok('[2] §5.1.3a 六情形：状态码/code/overdue_reason_required/planned_date/released_date/overdue_days 全部核对（每次 409/400 事务整体回滚，可连续重试同一批次；released_at 全程被触发器钉死，零真实时钟依赖）');
    // 六次失败尝试后批次仍应可用合法理由正常发布（证明连续 409/400 不留半截态）
    const rFinal = await withFixedReleasedAt(f2.relId, FIX_2_RELEASED, () =>
      call('POST', `/api/sys-releases/${f2.relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: f2.execRowId, overdue_reason_code: '其他', overdue_reason_note: '六次失败后收口' })
    );
    assert.strictEqual(rFinal.status, 200, `[2]六次失败后合法理由应 200, got ${rFinal.status} ${JSON.stringify(rFinal.body)}`);
    ok('[2] 六次失败尝试不留半截态：合法理由最终 200 正常发布');
  }

  // ═══ [3] 跨零点同源（读库值与留痕 payload 同源，非文案自洽） ═══
  {
    const relId = await mkRelease({ title: '[3]跨零点', plannedDate: '2026-09-08' });
    const issueId = await mkIssue({ title: '[3]成员单' });
    await addIssueTo(relId, issueId);
    await mkCompleteRoster(issueId, 5, '开发甲');
    await addExecutor(relId, 5, '开发甲');
    const row = await execRow(relId, 5);
    // 用 AFTER UPDATE 触发器把内核写入的 released_at 强制改成跨零点后的真实值（'2026-09-09 00:00:05'，
    //   相对 planned_date='2026-09-08' 恰跨 1 天零几秒）——同一事务内触发器写入，验证不依赖服务器真实时钟。
    await run(`CREATE TRIGGER trg_v3_cross_midnight AFTER UPDATE OF released_at ON sys_releases
      WHEN NEW.id = ${relId} AND NEW.status = '已发布' AND NEW.released_at IS NOT NULL AND NEW.released_at != '2026-09-09 00:00:05'
      BEGIN UPDATE sys_releases SET released_at = '2026-09-09 00:00:05' WHERE id = ${relId}; END`);
    const r3 = await call('POST', `/api/sys-releases/${relId}/execute`, dev5Tok, { release_note: '跨零点', executor_row_id: row.id, overdue_reason_code: '其他', overdue_reason_note: '跨零点用例' });
    await run(`DROP TRIGGER trg_v3_cross_midnight`);
    assert.strictEqual(r3.status, 200, `[3]期望 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
    const relAfter3 = await get(`SELECT released_at FROM sys_releases WHERE id=?`, [relId]);
    assert.strictEqual(relAfter3.released_at, '2026-09-09 00:00:05', '[3]released_at 应真实落库为触发器强制值（证明判定基准=读回值，非请求发起时刻）');
    const tl3 = await overdueTimeline(relId);
    assert.strictEqual(tl3.length, 1, '[3]应恰 1 条留痕');
    const p3 = JSON.parse(tl3[0].payload_json);
    assert.strictEqual(p3.released_date, '2026-09-09', '[3]payload.released_date 应取自真实落库 released_at 前 10 位');
    assert.strictEqual(p3.overdue_days, 1, '[3]payload.overdue_days 应为 1（09-08→09-09 跨 1 个日历日）');
    ok('[3] 跨零点同源：判定基准=同事务读回的真实 released_at（触发器强制值），非文案自洽 —— overdue_days/released_date 与库内真值一致');
  }

  // ═══ [4] 发布时刻不变量三夹具（546-H1 fail-closed） ═══
  {
    // [4a] released_at 被强制置 NULL
    {
      const f = await mkOneMemberReadyRelease({ title: '[4a]released_at空', plannedDate: await pastDateStr(1) });
      const snap4aBefore = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      await run(`CREATE TRIGGER trg_v4a_null_released_at AFTER UPDATE OF released_at ON sys_releases
        WHEN NEW.id = ${f.relId} AND NEW.status = '已发布' AND NEW.released_at IS NOT NULL
        BEGIN UPDATE sys_releases SET released_at = NULL WHERE id = ${f.relId}; END`);
      const r = await call('POST', `/api/sys-releases/${f.relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: f.execRowId });
      await run(`DROP TRIGGER trg_v4a_null_released_at`);
      assert.strictEqual(r.status, 500, `[4a]期望 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'RELEASE_PUBLISH_TIME_INVARIANT', `[4a]code 应为 RELEASE_PUBLISH_TIME_INVARIANT，实际 ${r.body.code}`);
      const rel = await get(`SELECT status FROM sys_releases WHERE id=?`, [f.relId]);
      assert.strictEqual(rel.status, '计划中', '[4a]批次不应落「已发布」（整体回滚）');
      const ex = await execRow(f.relId, 5);
      assert.strictEqual(ex.exec_status, 'pending', '[4a]executor 行应回滚');
      assert.strictEqual((await overdueTimeline(f.relId)).length, 0, '[4a]零留痕行');
      const snap4aAfter = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      assert.deepStrictEqual(snap4aAfter, snap4aBefore, '[4a]整体回滚零副作用快照比对');
    }
    // [4b] released_at 被强制置非法值
    {
      const f = await mkOneMemberReadyRelease({ title: '[4b]released_at非法', plannedDate: await pastDateStr(1) });
      const snap4bBefore = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      await run(`CREATE TRIGGER trg_v4b_bad_released_at AFTER UPDATE OF released_at ON sys_releases
        WHEN NEW.id = ${f.relId} AND NEW.status = '已发布' AND NEW.released_at IS NOT NULL AND NEW.released_at != 'bad-date-value'
        BEGIN UPDATE sys_releases SET released_at = 'bad-date-value' WHERE id = ${f.relId}; END`);
      const r = await call('POST', `/api/sys-releases/${f.relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: f.execRowId });
      await run(`DROP TRIGGER trg_v4b_bad_released_at`);
      assert.strictEqual(r.status, 500, `[4b]期望 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'RELEASE_PUBLISH_TIME_INVARIANT', `[4b]code 应为 RELEASE_PUBLISH_TIME_INVARIANT，实际 ${r.body.code}`);
      const rel = await get(`SELECT status FROM sys_releases WHERE id=?`, [f.relId]);
      assert.strictEqual(rel.status, '计划中', '[4b]批次不应落「已发布」（整体回滚）');
      const ex = await execRow(f.relId, 5);
      assert.strictEqual(ex.exec_status, 'pending', '[4b]executor 行应回滚');
      assert.strictEqual((await overdueTimeline(f.relId)).length, 0, '[4b]零留痕行');
      const snap4bAfter = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      assert.deepStrictEqual(snap4bAfter, snap4bBefore, '[4b]整体回滚零副作用快照比对');
    }
    // [4c] status 被强制打回「计划中」（released_at 本身合法，但主状态未真正翻转）
    {
      const f = await mkOneMemberReadyRelease({ title: '[4c]status未翻转', plannedDate: await pastDateStr(1) });
      const snap4cBefore = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      await run(`CREATE TRIGGER trg_v4c_revert_status AFTER UPDATE OF released_at ON sys_releases
        WHEN NEW.id = ${f.relId} AND NEW.status = '已发布'
        BEGIN UPDATE sys_releases SET status = '计划中' WHERE id = ${f.relId}; END`);
      const r = await call('POST', `/api/sys-releases/${f.relId}/execute`, dev5Tok, { release_note: 'x', executor_row_id: f.execRowId });
      await run(`DROP TRIGGER trg_v4c_revert_status`);
      assert.strictEqual(r.status, 500, `[4c]期望 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'RELEASE_PUBLISH_TIME_INVARIANT', `[4c]code 应为 RELEASE_PUBLISH_TIME_INVARIANT，实际 ${r.body.code}`);
      const rel = await get(`SELECT status FROM sys_releases WHERE id=?`, [f.relId]);
      assert.strictEqual(rel.status, '计划中', '[4c]批次不应落「已发布」（整体回滚——触发器写入的中间态也随事务一并回滚）');
      const ex = await execRow(f.relId, 5);
      assert.strictEqual(ex.exec_status, 'pending', '[4c]executor 行应回滚');
      assert.strictEqual((await overdueTimeline(f.relId)).length, 0, '[4c]零留痕行');
      const snap4cAfter = await snapshotReleaseSideEffects(f.relId, [f.issueId]);
      assert.deepStrictEqual(snap4cAfter, snap4cBefore, '[4c]整体回滚零副作用快照比对');
    }
    ok('[4] 发布时刻不变量三夹具（released_at NULL / 非法 / status 未翻转）：均 500 RELEASE_PUBLISH_TIME_INVARIANT + 整体回滚（批次不落已发布/executor 未烧成 done/零留痕行）');
  }

  // ═══ [5] 非最后一人带理由不校验不落库；应急带理由不持久化 ═══
  {
    // [5a] 双执行人，一人先确认（非最后一人）——[561-M4] 改用「校验器本该拒绝」的两类理由参数（非法
    //   类型=数组 / 超长说明），比此前"合法值但非最后一人不生效"这条覆盖更强：证明的不只是"理由参数
    //   被忽略"，而是 rGate 未满足分支**压根不跑校验函数**（若真跑了，这两类参数在别的入口都会撞
    //   400），仍应 200 pending + 两列 NULL + 无 release_overdue_reason 事实留痕行。
    async function mk5aFixture(title) {
      const relId = await mkRelease({ title, plannedDate: await pastDateStr(2) });
      const issueId = await mkIssue({ title: `${title}-成员单` });
      await addIssueTo(relId, issueId);
      await mkCompleteRoster(issueId, 5, '开发甲');
      await addExecutor(relId, 5, '开发甲');
      await addExecutor(relId, 6, '开发乙');
      const row5 = await execRow(relId, 5);
      return { relId, row5 };
    }
    async function assert5a(label, extra) {
      const f = await mk5aFixture(`[5a-${label}]非最后一人`);
      const r = await call('POST', `/api/sys-releases/${f.relId}/execute`, dev5Tok, {
        release_note: `非最后一人-${label}`, executor_row_id: f.row5.id, ...extra,
      });
      assert.strictEqual(r.status, 200, `[5a-${label}]期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.released, false, `[5a-${label}]非最后一人不应触发发布`);
      const rel = await get(`SELECT status, overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?`, [f.relId]);
      assert.strictEqual(rel.status, '计划中', `[5a-${label}]批次仍「计划中」`);
      assert.strictEqual(rel.overdue_reason_code, null, `[5a-${label}]两列应仍 NULL（未进入 rGateSatisfied 分支，理由参数被忽略）`);
      assert.strictEqual(rel.overdue_reason_note, null, `[5a-${label}]两列应仍 NULL`);
      const tl = await overdueTimeline(f.relId);
      assert.strictEqual(tl.length, 0, `[5a-${label}]不应产生 release_overdue_reason 留痕行`);
      ok(`[5a-${label}] 非最后一人携带「校验器本该拒绝」的理由参数：200 pending + 两列 NULL + 无 release_overdue_reason 留痕行（rGate 未满足分支不校验也不消费）`);
    }
    await assert5a('非法类型', { overdue_reason_code: ['数组非法'], overdue_reason_note: '说明' });
    await assert5a('超长说明', { overdue_reason_code: '其他', overdue_reason_note: '说'.repeat(301) });

    // [5b] 应急批次显式携带合法理由 → 事实留痕行仍照常产生（同 [1d]），但 payload.reason_code/
    //   reason_note 恒 null、summary 不含提交的理由原文——应急分支的"事实留痕"只陈述"跨日完成"这件
    //   客观事实，不采纳/不回显调用方传入的理由（同 [1d] 的 release_kind='emergency' 分支语义，[561-M4]
    //   把"两列不持久化"这条断言扩展到覆盖事实行本身不沾染提交理由的完整证据链）。
    const f5b = await mkOneMemberReadyRelease({ title: '[5b]应急携带理由', plannedDate: await pastDateStr(1), releaseKind: 'emergency' });
    const submittedNote = '应急批次携带理由不应持久化';
    const r5b = await call('POST', `/api/sys-releases/${f5b.relId}/execute`, dev5Tok, {
      release_note: '应急携带理由', executor_row_id: f5b.execRowId,
      overdue_reason_code: '值班人员变更', overdue_reason_note: submittedNote,
    });
    assert.strictEqual(r5b.status, 200, `[5b]期望 200, got ${r5b.status} ${JSON.stringify(r5b.body)}`);
    const rel5b = await get(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases WHERE id=?`, [f5b.relId]);
    assert.strictEqual(rel5b.overdue_reason_code, null, '[5b]应急批次两列应仍 NULL（携带的理由参数不持久化）');
    assert.strictEqual(rel5b.overdue_reason_note, null, '[5b]应急批次两列应仍 NULL');
    const tl5b = await overdueTimeline(f5b.relId);
    assert.strictEqual(tl5b.length, 1, '[5b]事实留痕行应恰 1 条（应急分支照常产生，同 [1d]）');
    const p5b = JSON.parse(tl5b[0].payload_json);
    assert.strictEqual(p5b.reason_code, null, '[5b]payload.reason_code 恒 null（应急分支不采纳提交的理由码）');
    assert.strictEqual(p5b.reason_note, null, '[5b]payload.reason_note 恒 null（应急分支不采纳提交的理由说明）');
    assert.ok(!tl5b[0].summary.includes(submittedNote), `[5b]summary 不应含提交的理由原文「${submittedNote}」，实际 ${tl5b[0].summary}`);
    assert.ok(!tl5b[0].summary.includes('值班人员变更'), `[5b]summary 不应含提交的理由码「值班人员变更」，实际 ${tl5b[0].summary}`);
    ok('[5b] 应急批次显式携带合法理由：200 + 两列不持久化 + 事实留痕行仍在（1 条）+ payload.reason_code/reason_note 恒 null + summary 不含提交的理由文本');
  }

  // ═══ [6] 重复确认不多写 ═══
  {
    const f6 = await mkOneMemberReadyRelease({ title: '[6]重复确认', plannedDate: await pastDateStr(2) });
    const r6a = await call('POST', `/api/sys-releases/${f6.relId}/execute`, dev5Tok, { release_note: '首次发布', executor_row_id: f6.execRowId, overdue_reason_code: '其他', overdue_reason_note: '首次' });
    assert.strictEqual(r6a.status, 200, `[6]首次期望 200, got ${r6a.status} ${JSON.stringify(r6a.body)}`);
    const countAfterFirst = (await overdueTimeline(f6.relId)).length;
    assert.strictEqual(countAfterFirst, 1, '[6]首次发布应恰 1 条留痕');
    // 同一 executor_row_id 重复确认（幂等分诊②：exec_status 已 done）
    const r6b = await call('POST', `/api/sys-releases/${f6.relId}/execute`, dev5Tok, { release_note: '重复确认', executor_row_id: f6.execRowId, overdue_reason_code: '其他', overdue_reason_note: '重复' });
    assert.strictEqual(r6b.status, 200, `[6]重复确认期望 200（幂等）, got ${r6b.status} ${JSON.stringify(r6b.body)}`);
    assert.strictEqual(r6b.body.already, true, '[6]重复确认应命中幂等分诊②（already:true）');
    const countAfterSecond = (await overdueTimeline(f6.relId)).length;
    assert.strictEqual(countAfterSecond, 1, `[6]重复确认不应新增留痕行，期望仍 1 条，实际 ${countAfterSecond}`);
    ok('[6] 重复确认（幂等分诊② already:true）不多写 release_overdue_reason 行');
  }

  // ═══ [7] 层一探针双向 ═══
  {
    // 正例：合法组合 0 违例
    assert.deepStrictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: null, overdue_reason_note: null }), [], '[7]两列都空应 0 违例（应急/历史合法形态）');
    assert.deepStrictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: '其他', overdue_reason_note: '合法说明' }), [], '[7]两列都非空且合法应 0 违例');
    // 反例：只码无说明 / 只说明无码 / 码不在白名单 / 说明超长
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: '其他', overdue_reason_note: null }).length, 1, '[7]只码无说明应 1 违例');
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: null, overdue_reason_note: '只说明' }).length, 1, '[7]只说明无码应 1 违例');
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: '不在白名单', overdue_reason_note: '说明' }).length, 1, '[7]码不在白名单应 1 违例');
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: '其他', overdue_reason_note: '说'.repeat(301) }).length, 1, '[7]说明超长应 1 违例');
    // [C2c·codex 556 号 MEDIUM M1] 纯空白说明（trim 后空）不能被判"已填"——探针口径须与写点
    //   resolveReleaseOverdueReasonInput 同源（trim 后空视为未填），否则"只码+空白说明"这类绕过服务层
    //   写入的半成品脏数据会在无 DDL CHECK 兜底下从探针眼皮底下溜过（0 违例的假阴性）。
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: '其他', overdue_reason_note: '   ' }).length, 1, '[7]码合法+说明纯空白（三个空格）应判 1 违例（trim 后空视为未填，同空同非空被打破）');
    // 非字符串类型本身就是异常（绕过服务层的脏写入才可能产生）：单独报违例。
    assert.strictEqual(I.releaseOverdueGroupInvariantViolations({ overdue_reason_code: 5, overdue_reason_note: '合法说明' }).length >= 1, true, '[7]overdue_reason_code 非字符串类型应判违例');
    ok('[7a] 纯函数直调：合法组合 0 违例（含"两列都空"允许态）+ 五类反例各 ≥1 违例（含纯空白说明/非字符串类型两条 C2c 新增）');

    // 全库扫描：直接 SQL 造违例行，探针必须报违例；清理后零违例
    const relV = await mkRelease({ title: '[7b]全库探针违例夹具' });
    await run(`UPDATE sys_releases SET overdue_reason_code = '其他' WHERE id = ?`, [relV]);   // 只码无说明
    const rowsAll = await all(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases`);
    const violations = rowsAll.flatMap(r => I.releaseOverdueGroupInvariantViolations(r));
    assert.ok(violations.length >= 1, '[7b]全库扫描应捕获人为构造的违例行');
    await run(`UPDATE sys_releases SET overdue_reason_code = NULL WHERE id = ?`, [relV]);
    const rowsClean = await all(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases`);
    const violationsClean = rowsClean.flatMap(r => I.releaseOverdueGroupInvariantViolations(r));
    assert.strictEqual(violationsClean.length, 0, `[7b]清理后应零违例，实际 ${violationsClean.length}`);
    ok('[7b] 全库探针双向：人为构造违例行→报违例；清理后→零违例');

    // [C2c·codex 556 号 MEDIUM M1] 全库扫描·纯空白说明反例——SQL 直接植入 ('其他', '   ')（服务层
    //   trim 后本会拒绝，此处模拟绕过服务层的脏写入），探针必须报违例；清理为 (null, null) 后零违例。
    const relW = await mkRelease({ title: '[7b-M1]全库探针·纯空白说明夹具' });
    await run(`UPDATE sys_releases SET overdue_reason_code = '其他', overdue_reason_note = '   ' WHERE id = ?`, [relW]);
    const rowsWhitespace = await all(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases`);
    const violationsWhitespace = rowsWhitespace.flatMap(r => I.releaseOverdueGroupInvariantViolations(r));
    assert.ok(violationsWhitespace.length >= 1, '[7b-M1]码合法+说明纯空白的植入行应被全库扫描捕获为违例');
    await run(`UPDATE sys_releases SET overdue_reason_code = NULL, overdue_reason_note = NULL WHERE id = ?`, [relW]);
    const rowsWhitespaceClean = await all(`SELECT overdue_reason_code, overdue_reason_note FROM sys_releases`);
    const violationsWhitespaceClean = rowsWhitespaceClean.flatMap(r => I.releaseOverdueGroupInvariantViolations(r));
    assert.strictEqual(violationsWhitespaceClean.length, 0, `[7b-M1]清理为 (null,null) 后应零违例，实际 ${violationsWhitespaceClean.length}`);
    ok('[7b-M1] 全库探针·纯空白说明反例：植入 (\'其他\',\'   \')→报违例；清理为 (null,null)→零违例');

    // [7c]（C2b·M2）真实本地库（task_pool.db）只读扫描——照 verify-sys-fastrelease-auth.js:609-630
    //   范式：独立只读连接、用完即关、零写。⚠️ 必须 fail-safe：真实库不存在 / 两列尚不存在（本机
    //   service 尚未用 C2 新代码重启过一次，ALTER 未跑）→ SKIP，不算 FAIL（服务重启后 ALTER 自动补齐，
    //   非本脚本职责）。
    {
      const realDbPath = path.join(__dirname, '..', 'task_pool.db');
      if (!fs.existsSync(realDbPath)) {
        console.log('  ⚠️ SKIP: 真实库不存在（task_pool.db 未找到）');
      } else {
        const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
        const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
        try {
          const realRows = await realAll(`SELECT id, overdue_reason_code, overdue_reason_note FROM sys_releases`);
          const realViolations = realRows.flatMap(r => I.releaseOverdueGroupInvariantViolations(r));
          assert.strictEqual(realViolations.length, 0, `[7c]真实本地库 sys_releases 逾期理由字段组违例计数应为 0（扫描 ${realRows.length} 行），实得 ${realViolations.length}：${JSON.stringify(realViolations)}`);
          ok(`[7c] 真实本地库（task_pool.db）只读扫描：${realRows.length} 行，违例计数=0（判据=I.releaseOverdueGroupInvariantViolations，与写点同一份实现）`);
        } catch (e) {
          if (e && /no such column/i.test(e.message)) {
            console.log('  ⚠️ SKIP: 真实库无两列（服务启动 ALTER 后才有）');
          } else {
            throw e;
          }
        } finally {
          realDb.close();
        }
      }
    }
  }

  // ═══ [8] 静态断言：_publishReleaseCoreInTxn 函数体不变 ═══
  {
    // [561-M1] 归一换行再切分——Windows checkout（core.autocrlf）下 index.js 可能含 \r\n，若不归一，
    //   同一份逐字内容在不同签出环境下会算出不同的 sha256（换行符本身进了哈希输入），让"内核零改动"
    //   这条红线在跨平台/跨 checkout 配置间变得不可复现。行数副断言同样按归一后的行数组切分，与主断言
    //   （sha256）共用同一份归一化文本，不允许两处各自处理换行。
    const srcRaw = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const src = srcRaw.replace(/\r\n/g, '\n');
    const lines = src.split('\n');
    const startIdx = lines.findIndex(l => /async function _publishReleaseCoreInTxn\(/.test(l));
    assert.ok(startIdx >= 0, '[8]应能定位到 _publishReleaseCoreInTxn 定义行');
    // 定位函数体结束：函数体内字符串/模板串含裸花括号（如 payload_json 对象字面量、SQL 片段），朴素
    //   括号计数会误判——改用唯一锚点字符串（该函数唯一 return 语句原文）+ 其后第一处顶格缩进（2 空格）
    //   `}` 单独一行，同目录其它静态守卫脚本对"找不到简单可靠边界"的场景同款处置（锚点字符串而非括号
    //   计数）。
    const returnIdx = lines.findIndex((l, i) => i > startIdx && l.includes('return { releaseId, releasedIssueIds: members.map(m => m.id), count: expected };'));
    assert.ok(returnIdx > startIdx, '[8]应能定位到函数唯一 return 语句（锚点字符串）');
    let endIdx = -1;
    for (let i = returnIdx; i < lines.length; i++) {
      if (/^  \}\s*$/.test(lines[i])) { endIdx = i; break; }
    }
    assert.ok(endIdx > returnIdx, '[8]应能定位到函数体结束行（return 之后第一处顶格 `}`）');
    const bodyLineCount = endIdx - startIdx + 1;
    const bodyText = lines.slice(startIdx, endIdx + 1).join('\n');
    const bodyHash = crypto.createHash('sha256').update(bodyText).digest('hex');
    // 2026-09-10 C2 记录·内核任何改动须同步更新并在 commit message 说明——单纯行数不变会对"等行数
    //   改写"（如把某行判据换成另一行字符数不同但行数照旧的逻辑）静默放行（C2b·M1 收口）；行数断言
    //   保留作副断言（先看行数再看内容哈希，红灯时定位更快），主断言=逐字内容 sha256。
    const EXPECTED_BODY_LINE_COUNT = 318;
    // [561-M1] 基线按归一换行（\r\n→\n）后重算——旧基线 '6ffb4d1a…' 是在未归一时代算的，本仓当前
    //   checkout 下换行符实测已是 \n（归一化前后哈希不同只因旧基线本身混入了别的签出环境算出的 \r\n
    //   哈希），归一逻辑落地后统一改按归一文本为准，避免未来签出环境切换（core.autocrlf 配置变化）时
    //   本断言假红。
    const EXPECTED_BODY_SHA256 = '5e2ad40b6cee243cd8f1f01cee0eb7798f952814e4a6eadde54a343108061510';
    assert.strictEqual(bodyLineCount, EXPECTED_BODY_LINE_COUNT, `[8]_publishReleaseCoreInTxn 函数体行数应仍为 ${EXPECTED_BODY_LINE_COUNT}（C0 基线），实际 ${bodyLineCount}（起止行 ${startIdx + 1}-${endIdx + 1}）——C2 不应改动内核函数体，红灯提示内核被意外触碰`);
    assert.strictEqual(bodyHash, EXPECTED_BODY_SHA256, `[8]_publishReleaseCoreInTxn 函数体 sha256 与记录基线不符（起止行 ${startIdx + 1}-${endIdx + 1}）——内核任何逐字改动（含等行数改写）都会被本断言抓住，实际 ${bodyHash}`);
    assert.ok(!/overdue/i.test(bodyText), '[8]_publishReleaseCoreInTxn 函数体不应含 "overdue" 字样（判定逻辑必须在内核之外）');
    ok(`[8] 静态断言：_publishReleaseCoreInTxn 函数体行数不变（${EXPECTED_BODY_LINE_COUNT} 行，${startIdx + 1}-${endIdx + 1}）+ sha256 与基线逐字相等 + 不含 'overdue' 字样——内核零改动红线未被破坏`);
  }

  console.log(`\nPASS ${passed} / FAIL 0`);
  finishWithCrossMidnightGuard(0);
}

main().catch((e) => {
  console.error('❌ verify-sys-release-overdue 失败:', e);
  finishWithCrossMidnightGuard(1);
});
