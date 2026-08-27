// 验证脚本：上线执行人多选与多人双确认（方案 20260806 v1.7）
//   用法：node scripts/verify-sys-release-executors.js
//
// 分组规划（本文件后续 C3 会继续扩组，不重开新文件）：
//   [1] GET /sys-releases/executor-candidates（候选清单 + 双来源默认值解析）
//   [2] PUT /sys-releases/:id/executors 四道闸（⓿批次态/①生命周期/②人数/③资格）各负例+正例
//   [3] 集合替换不复活（§4.1a 代次语义）
//   [4] user_ids 去重
//   [5] timeline 落行断言
//   [C1 组以上 1-5；C2 起追加：]
//   [6] POST /sys-releases/:id/executors/:userId/notify（行级通知：首发/重发/failed 重试/done 拒发/
//       在途拒发/非在册 404/批次态闸+成员非空闸(MED-1/MED-2)/五条件 CAS 负例(token/软删/id 三条真打)/
//       互不影响/行级 stale 惰性转换/并发双发/dry-run 开关(HIGH-1+MED-5)）
//   [7] GET /sys-releases/:id/executors/:userId/read-status（行级已读：cached 正例/no_message_key/
//       非在册 404/未固化 fail-safe/dry-run 演练行短路(HIGH-1 子项)）
//
// 断言纪律：精确状态码 + 精确 error code；正例断言真实落库副作用（子表行/timeline），非仅状态码；
//   负例同样断言"零副作用"（子表行数不变/字段不变），不止看状态码本身。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-executors-secret';
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

// readSystemConfig 可控 stub（覆盖 _sys-attach-test-deps 的恒空实现）：只对
// sys_release_default_executor_ids / sys_notify_dry_run 两键生效，供 [1c]/[1d]/[6m] 组按需切换配置
// 值，其余键沿用恒空语义。sys_notify_dry_run 默认（SYS_NOTIFY_DRY_RUN_CONFIG=null）返回 '' ⇒
// isDryRun=false ⇒ 走"真发"分支——但"真发"落在下方 SEND_IMPL 可控桩上（永不出网），[6a]-[6l] 组
// 正是要验证行级 CAS/写回逻辑本身，不是验证 dry-run 开关，所以默认不占用 dry-run 通道，让每个用例
// 走同一条主路径（对齐 D16 既有测试习惯：主路径测真实分支，dry-run 独立 [6m] 小组测，MED-5）。
let SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = null;
let SYS_NOTIFY_DRY_RUN_CONFIG = null;
async function readSystemConfig(key) {
  if (key === 'sys_release_default_executor_ids') return SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG;
  if (key === 'sys_notify_dry_run') return SYS_NOTIFY_DRY_RUN_CONFIG === null ? '' : SYS_NOTIFY_DRY_RUN_CONFIG;
  return '';
}

// [6m]-② 用：捕获 logger.warn 调用文本，供断言"笔误配置值触发告警"这条 fail-open 可观测路径
// （MED-5）。其余组不消费 warnLogs，累积不清空不影响它们，只在用到的地方按需 .length=0 复位。
const warnLogs = [];

// ── [6] 组可控发送桩：覆盖 _sys-attach-test-deps 的恒成功 sendIssueDingtalkRaw ──
//   同 readSystemConfig 的既有手法（可变闭包变量 + 覆盖展开）：默认成功（等价原 stub 行为，[1]-[5]
//   组不受影响）；[6] 组个别用例按 targetUser.id 或调用次数临时切换失败/写副作用，验证结束后复位。
//   sendCallCount 供 [6m] 组断言"演练不出网/真发确实调用桩一次"（MED-5）。
//   ⚠️ 绝不真发：SEND_IMPL 只操作本进程内存/本文件的 sqlite3(':memory:') db，零网络调用。
let SEND_IMPL = async (_targetUser, _title, _md) => ({ ok: true, message_key: 'stub-dev' });
let sendCallCount = 0;
async function sendIssueDingtalkRawTestable(targetUser, title, md) { sendCallCount++; return SEND_IMPL(targetUser, title, md); }

// [6o]（300-M1）用：dbAllAsync 可控故障注入——按 SQL 文本单发匹配拒绝一次，其余查询照常透传给真实
// `all`。单发（触发后自动清空）是为了不误伤同一次请求里后续可能出现的同文本查询，以及不误伤后续
// 用例；测试侧仍在 finally 里兜底复位一次，防止"本该触发但没触发"导致标志漏留、误伤后续组。
let DB_ALL_FAIL_ON = null;
async function allTestable(sql, params = []) {
  if (DB_ALL_FAIL_ON && sql.includes(DB_ALL_FAIL_ON)) {
    DB_ALL_FAIL_ON = null;
    throw new Error('[6o]注入故障：模拟 dbAllAsync 查询失败');
  }
  return all(sql, params);
}

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: (...args) => { warnLogs.push(args.join(' ')); }, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: allTestable,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  readSystemConfig,               // 覆盖 stub 的恒空实现，放在展开之后生效
  sendIssueDingtalkRaw: sendIssueDingtalkRawTestable,   // 同上：覆盖恒成功 stub，放展开之后生效
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

// ── 多角色 JWT 夹具（测试 id 与生产 users.id 无对应关系）──────────
const adminTok  = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const dev5Tok   = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);
const dev6Tok   = jwt.sign({ id: 6, username: 'dev6', display_name: '开发乙', role: 'user' }, SECRET);
const dev7Tok   = jwt.sign({ id: 7, username: 'dev7', display_name: '开发丙', role: 'user' }, SECRET);   // C3：[8] execute 组 3 人场景用
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 307 号 M3②：[6g-2-真实端点] 需要真调 cancel-schedule（requireLiaisonOnly 仅凭 JWT id 判定，无需 users 表有 13 号行——同 sysActor() 纯读 JWT claim 不查库）

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

async function mkRelease(extra = {}) {
  const r = await call('POST', '/api/sys-releases', adminTok, { title: extra.title || '执行人多选测试批次' });
  assert.strictEqual(r.status, 201, `建批次 201, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function mkIssue(extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('feature', '待上线', ?, 'BMS', '内部', 1, '管理员')`,
    [extra.title || '执行人多选测试成员单']
  );
  return r.lastID;
}
async function addIssueTo(relId, issueId) {
  const r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [issueId] });
  assert.strictEqual(r.status, 200, `加单 200, got ${r.status} ${JSON.stringify(r.body)}`);
}
async function activeExecRows(relId) {
  return all(`SELECT id, user_id, user_name, notify_status, exec_status, removed_at FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`, [relId]);
}
async function allExecRows(relId) {
  return all(`SELECT id, user_id, user_name, notify_status, exec_status, removed_at, removed_by FROM sys_release_executors WHERE release_id = ? ORDER BY id`, [relId]);
}
async function timelineRows(relId) {
  return all(`SELECT issue_id, summary, action_code, ref_id, operator_id, operator_name FROM sys_issue_timeline WHERE ref_id = ? AND action_code = 'release_executors_set' ORDER BY id`, [relId]);
}
// [6]/[7] 组专用：单行按 (release_id,user_id) 定位（默认只看在册行；activeOnly=false 时不加
// removed_at 过滤，供软删旧行断言用）。
async function execRow(relId, userId, activeOnly = true) {
  const sql = `SELECT * FROM sys_release_executors WHERE release_id = ? AND user_id = ?` +
    (activeOnly ? ` AND removed_at IS NULL` : ``) + ` ORDER BY id DESC LIMIT 1`;
  return get(sql, [relId, userId]);
}
async function notifyTimelineRows(relId) {
  return all(`SELECT issue_id, summary, action_code, ref_id, operator_id, operator_name FROM sys_issue_timeline WHERE ref_id = ? AND action_code = 'release_executor_notify' ORDER BY id`, [relId]);
}
// [8] 组专用：泛化版——按任意 action_code 查询（execute 组用 'release_executor_done'）。
async function notifyTimelineRowsByCode(relId, actionCode) {
  return all(`SELECT issue_id, summary, action_code, ref_id, operator_id, operator_name FROM sys_issue_timeline WHERE ref_id = ? AND action_code = ? ORDER BY id`, [relId, actionCode]);
}
// [8] 组专用：RELEASE 中心守卫（_publishReleaseCoreInTxn 内 assertMainStatusTransition）要求批次内每个
// 成员 issue 自己的开发在册 roster 非空且全完成态——凡是会真正走到发布（R-GATE 满足）的 [8] 用例都需要
// 先给成员 issue 补一条完成态 dev_assignee 行（同 verify-sys-release-batch.js 既有 mkCompleteRoster）。
async function mkCompleteRoster(issueId, userId = 5, userName = '开发甲') {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
     VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
    [issueId, userId, userName]
  );
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),
    (5,'dev5','开发甲','user','active'),
    (6,'dev6','开发乙','user','active'),
    (7,'dev7','开发丙','user','active'),
    (8,'dev8','开发丁','user','active'),
    (9,'viewer9','查看者玖','viewer','active'),
    (10,'dev10','停用者拾','user','inactive')`);
  await new Promise(res => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / dev5,6,7,8 / viewer9 / 停用 dev10）');

  // ═══ [1] GET /sys-releases/executor-candidates ═══
  {
    // [1a] 非 admin 403
    const rForbid = await call('GET', '/api/sys-releases/executor-candidates', dev5Tok);
    assert.strictEqual(rForbid.status, 403, `[1a]非 admin 期望 403, got ${rForbid.status}`);
    ok('[1a] 非 admin 调 candidates 端点 → 403');

    // [1b] 全部 active 用户返回，含无资格 admin/viewer 置灰原因；停用用户不出现
    const r = await call('GET', '/api/sys-releases/executor-candidates', adminTok);
    assert.strictEqual(r.status, 200, `[1b]admin 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const items = r.body.items;
    assert.strictEqual(items.length, 6, `[1b]应返回 6 个 active 用户（1/5/6/7/8/9，不含停用的 10），实际 ${items.length}`);
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    assert.strictEqual(byId[1].eligible, false, '[1b]admin(id=1) 应不合格');
    assert.strictEqual(byId[1].disabled_reason, '管理员角色无上线执行资格', '[1b]admin 置灰原因文案');
    assert.strictEqual(byId[9].eligible, false, '[1b]viewer(id=9) 应不合格');
    assert.strictEqual(byId[9].disabled_reason, '查看者角色无上线执行资格', '[1b]viewer 置灰原因文案');
    assert.strictEqual(byId[5].eligible, true, '[1b]dev5 应合格');
    assert.strictEqual(byId[5].disabled_reason, null, '[1b]合格用户 disabled_reason=null');
    assert.strictEqual(items.some(i => i.id === 10), false, '[1b]停用用户(id=10)不应出现在候选列表');
    ok('[1b] candidates 返回全部 6 个 active 用户，无资格 admin/viewer 置灰原因正确，停用用户不出现');

    // ── C1-fix-1：duty_date 口径从"调用当天"订正为"批次上线日（planned_date）"，release_id 缺省/无
    //   planned_date 时回退今天。以下 [1c]* 系列覆盖新语义。──
    // ⭐ L6（Opus 预筛）容忍口径：todayStr/dayAfterTomorrow/threeDaysOut 在本组测试起始时算一次、后续
    // 全程复用（不逐次重新查 date('now')），与被测端点内部各自独立算的 date('now','localtime') 存在
    // 跨零点不一致的理论窗口——若整组测试恰好跨过自然日边界会误报。本文件从简不做查询驱动的自愈处理
    // （行数换极小概率的时序脆弱性不值），显式记录这条已知限制：本组全程在毫秒级完成，跨零点概率可忽略，
    // 与项目里其它基于 date('now') 的测试（如 verify-sys-duty-roster）共享同一类已知限制，非本文件独有。
    const todayStr = (await get(`SELECT date('now','localtime') AS d`)).d;
    const dayAfterTomorrow = (await get(`SELECT date('now','localtime','+2 days') AS d`)).d;
    const threeDaysOut = (await get(`SELECT date('now','localtime','+3 days') AS d`)).d;
    // 今天=dev8(B) 值班；后天=dev7(A) 值班——两天分属不同人，"用了哪天"从选中谁就能反证出来。
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, 8, '开发丁', 1, 'admin')`, [todayStr]);
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, 7, '开发丙', 1, 'admin')`, [dayAfterTomorrow]);
    SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = '6,9'; // 6=dev6 合格；9=viewer 不合格（与 duty 的 7/8 不重叠，避免混淆判据）

    // [1c] 带 release_id（planned_date=后天）→ duty 应查"后天"，选中 A(7) 不选中 B(8)
    const relPlanned = await mkRelease({ title: 'C1-fix-1 候选批次·后天上线' });
    await run(`UPDATE sys_releases SET planned_date = ? WHERE id = ?`, [dayAfterTomorrow, relPlanned]);
    const r1c = await call('GET', `/api/sys-releases/executor-candidates?release_id=${relPlanned}`, adminTok);
    assert.strictEqual(r1c.status, 200, `[1c]期望 200, got ${r1c.status} ${JSON.stringify(r1c.body)}`);
    assert.strictEqual(r1c.body.duty_date_used, dayAfterTomorrow, `[1c]duty_date_used 应为批次 planned_date=${dayAfterTomorrow}，实际 ${r1c.body.duty_date_used}`);
    const sel1c = r1c.body.selected_by_default.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(sel1c, [6, 7], `[1c]selected_by_default 应为 [6,7]（duty=后天值班人7 + config 合格的6），实际 ${JSON.stringify(sel1c)}`);
    assert.deepStrictEqual(r1c.body.default_source.duty, [7], '[1c]default_source.duty=[7]（后天值班人 A，非今天值班人 B）');
    assert.strictEqual(sel1c.includes(8), false, '[1c]不应选中 8（今天值班人 B）——证明查的是 planned_date 不是调用当天');
    const skip9c = r1c.body.skipped_defaults.find(s => s.source === 'config' && s.user_id === 9);
    assert.ok(skip9c && /查看者/.test(skip9c.reason), '[1c]config 里的 9(viewer) 仍被正确跳过');
    ok('[1c] release_id 指向 planned_date=后天的批次 → duty 查后天排班，选中 A(7) 不选 B(8)，duty_date_used=后天，证明口径已从"调用当天"订正为"上线日"');

    // [1c-2] release_id 存在但 planned_date 为空 → 回退今天，duty 应选中 B(8)
    const relNoPlan = await mkRelease({ title: 'C1-fix-1 候选批次·未定计划日' });
    const r1c2 = await call('GET', `/api/sys-releases/executor-candidates?release_id=${relNoPlan}`, adminTok);
    assert.strictEqual(r1c2.status, 200, `[1c-2]期望 200, got ${r1c2.status}`);
    assert.strictEqual(r1c2.body.duty_date_used, todayStr, `[1c-2]planned_date 为空应回退今天=${todayStr}，实际 ${r1c2.body.duty_date_used}`);
    assert.ok(r1c2.body.default_source.duty.includes(8), '[1c-2]回退今天后应选中今天值班人 B(8)');
    ok('[1c-2] release_id 存在但 planned_date 为空 → 回退今天，duty_date_used=今天，选中 B(8)');

    // [1c-3] 不带 release_id → 直接用今天（hotfix-publish 弹选人框场景，批次尚未建立）
    const r1c3 = await call('GET', '/api/sys-releases/executor-candidates', adminTok);
    assert.strictEqual(r1c3.status, 200, `[1c-3]期望 200, got ${r1c3.status}`);
    assert.strictEqual(r1c3.body.duty_date_used, todayStr, '[1c-3]不带 release_id 应直接用今天');
    assert.ok(r1c3.body.default_source.duty.includes(8), '[1c-3]不带 release_id 时应选中今天值班人 B(8)');
    ok('[1c-3] 不带 release_id → duty_date_used=今天（hotfix-publish 批次未建立场景），选中 B(8)');

    // [1c-4] release_id 指向不存在的批次 → 404 RELEASE_NOT_FOUND
    const r1c4 = await call('GET', '/api/sys-releases/executor-candidates?release_id=999999', adminTok);
    assert.strictEqual(r1c4.status, 404, `[1c-4]期望 404, got ${r1c4.status}`);
    assert.strictEqual(r1c4.body.code, 'RELEASE_NOT_FOUND', `[1c-4]code 应为 RELEASE_NOT_FOUND，实际 ${r1c4.body.code}`);
    ok('[1c-4] release_id 指向不存在的批次 → 404 RELEASE_NOT_FOUND');

    // [1c-5] release_id 非法（非正整数）→ 400 INVALID_RELEASE_ID
    const r1c5 = await call('GET', '/api/sys-releases/executor-candidates?release_id=abc', adminTok);
    assert.strictEqual(r1c5.status, 400, `[1c-5]期望 400, got ${r1c5.status}`);
    assert.strictEqual(r1c5.body.code, 'INVALID_RELEASE_ID', `[1c-5]code 应为 INVALID_RELEASE_ID，实际 ${r1c5.body.code}`);
    ok('[1c-5] release_id 非法（非正整数）→ 400 INVALID_RELEASE_ID');

    // [1c-6] 文案写实：release_id 指向的 planned_date 当天没排班 → 提示"上线日（YYYY-MM-DD）无排班安排"
    //   （区别于 [1d] 的"今日无排班安排"回退措辞）
    const relEmptyDuty = await mkRelease({ title: 'C1-fix-1 候选批次·上线日无排班' });
    await run(`UPDATE sys_releases SET planned_date = ? WHERE id = ?`, [threeDaysOut, relEmptyDuty]);
    const r1c6 = await call('GET', `/api/sys-releases/executor-candidates?release_id=${relEmptyDuty}`, adminTok);
    assert.strictEqual(r1c6.status, 200, `[1c-6]期望 200, got ${r1c6.status}`);
    const skipDuty6 = r1c6.body.skipped_defaults.find(s => s.source === 'duty');
    assert.strictEqual(skipDuty6.reason, `上线日（${threeDaysOut}）无排班安排`, `[1c-6]文案应写实上线日日期，实际 ${skipDuty6.reason}`);
    ok('[1c-6] release_id 指向的上线日当天无排班 → skipped_defaults 文案"上线日（YYYY-MM-DD）无排班安排"，与今日回退措辞区分开');

    // [1d] 两来源均失效（清空排班表 + config 未配置），不带 release_id → 回退今天 + 双双跳过
    await run(`DELETE FROM sys_release_duty_roster`);
    SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = null;
    const r1d = await call('GET', '/api/sys-releases/executor-candidates', adminTok);
    assert.strictEqual(r1d.status, 200, `[1d]期望 200, got ${r1d.status}`);
    assert.deepStrictEqual(r1d.body.selected_by_default, [], '[1d]两来源均失效时 selected_by_default 应为空数组');
    const skipDuty = r1d.body.skipped_defaults.find(s => s.source === 'duty');
    const skipCfg = r1d.body.skipped_defaults.find(s => s.source === 'config');
    assert.strictEqual(skipDuty.reason, '今日无排班安排', '[1d]duty 跳过原因（不带 release_id 走今日口径）');
    assert.ok(/未配置/.test(skipCfg.reason), `[1d]config 跳过原因应含"未配置"，实际 ${skipCfg.reason}`);
    ok('[1d] 两来源均失效（今日无排班+config 未配置）：selected_by_default=[]，skipped_defaults 两条原因均正确，不阻塞候选清单返回');

    // ── 299-M1/299-L1：config token 级可观测 + 去重 ──
    // [1e] config='6,abc,0,7'（6/7 是测试库真实合法用户）→ 两合法 id 均被默认选中，'abc'/'0' 各自单独一条 skipped
    await run(`DELETE FROM sys_release_duty_roster`); // 排除 duty 来源干扰，只看 config 行为
    SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = '6,abc,0,7';
    const r1e = await call('GET', '/api/sys-releases/executor-candidates', adminTok);
    assert.strictEqual(r1e.status, 200, `[1e]期望 200, got ${r1e.status} ${JSON.stringify(r1e.body)}`);
    const cfgSel1e = r1e.body.default_source.config.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(cfgSel1e, [6, 7], `[1e]default_source.config 应为 [6,7]（两个合法 id），实际 ${JSON.stringify(cfgSel1e)}`);
    const skipAbc = r1e.body.skipped_defaults.filter(s => s.source === 'config' && s.reason === '配置项非法：abc');
    const skipZero = r1e.body.skipped_defaults.filter(s => s.source === 'config' && s.reason === '配置项非法：0');
    assert.strictEqual(skipAbc.length, 1, `[1e]'abc' 应恰好一条 skipped，实际 ${skipAbc.length} 条`);
    assert.strictEqual(skipZero.length, 1, `[1e]'0' 应恰好一条 skipped，实际 ${skipZero.length} 条`);
    assert.strictEqual(skipAbc[0].user_id, null, `[1e]非法 token 的 skipped 条目 user_id 应为 null，实际 ${skipAbc[0].user_id}`);
    ok("[1e] config='6,abc,0,7' → 合法 id(6,7) 均入选，非法 token('abc'/'0') 各自逐项追加 skipped_defaults（token 级可观测，299-M1）");

    // [1f] config='6,6,7' → default_source.config 无重复（去重生效，299-L1）
    SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = '6,6,7';
    const r1f = await call('GET', '/api/sys-releases/executor-candidates', adminTok);
    assert.strictEqual(r1f.status, 200, `[1f]期望 200, got ${r1f.status} ${JSON.stringify(r1f.body)}`);
    const cfgSel1f = r1f.body.default_source.config.slice().sort((a, b) => a - b);
    assert.deepStrictEqual(cfgSel1f, [6, 7], `[1f]default_source.config 应为去重后的 [6,7]，实际 ${JSON.stringify(cfgSel1f)}`);
    assert.strictEqual(r1f.body.default_source.config.length, 2, `[1f]default_source.config 长度应为 2（无重复），实际 ${r1f.body.default_source.config.length}`);
    ok("[1f] config='6,6,7'（重复 token）→ default_source.config=[6,7]，长度 2，无重复（299-L1 去重）");

    SYS_RELEASE_DEFAULT_EXECUTOR_IDS_CONFIG = null; // 复位，避免影响后续分组（[2] 起不再依赖候选端点默认值）
  }

  // ═══ [2] PUT executors 四道闸 ═══
  {
    // [2-⓿负] 批次非「计划中」→ 409 RELEASE_NOT_PLANNING
    const relPublished = await mkRelease({ title: 'G0负-已发布批次' });
    await run(`UPDATE sys_releases SET status = '已发布', released_at = datetime('now','localtime') WHERE id = ?`, [relPublished]);
    const r0neg = await call('PUT', `/api/sys-releases/${relPublished}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r0neg.status, 409, `[2-⓿负]期望 409, got ${r0neg.status} ${JSON.stringify(r0neg.body)}`);
    assert.strictEqual(r0neg.body.code, 'RELEASE_NOT_PLANNING', `[2-⓿负]code 应为 RELEASE_NOT_PLANNING，实际 ${r0neg.body.code}`);
    assert.strictEqual((await allExecRows(relPublished)).length, 0, '[2-⓿负]零副作用：子表无新行');
    ok('[2-⓿负] 批次非「计划中」PUT executors → 409 RELEASE_NOT_PLANNING，零落库');

    // [2-⓿正] 批次「计划中」→ 闸⓿通过（与下方 [2-①正]/[2-②正]/[2-③正] 共用同一次成功调用做正例）
    const relOk = await mkRelease({ title: 'G0正-计划中批次' });
    const issueOk = await mkIssue({ title: 'G0正-成员单' });
    await addIssueTo(relOk, issueOk);
    const r0pos = await call('PUT', `/api/sys-releases/${relOk}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r0pos.status, 200, `[2-⓿①②③正]期望 200, got ${r0pos.status} ${JSON.stringify(r0pos.body)}`);
    const activeOk = await activeExecRows(relOk);
    assert.strictEqual(activeOk.length, 2, '[2-⓿①②③正]子表应新增 2 行');
    assert.ok(activeOk.every(r => r.notify_status === 'not_sent' && r.exec_status === 'pending'), '[2-⓿①②③正]新行均 not_sent/pending（DDL 默认值）');
    ok('[2-⓿正/①正/②正/③正] 计划中批次 + 2 名合格执行人 → 200，子表新增 2 行均 not_sent/pending');

    // [2-①负] 生命周期闸：其中一行进入 sent 态后再次 PUT → 409 EXECUTORS_LOCKED，零副作用
    const lockedRowId = activeOk[0].id;
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id=?`, [lockedRowId]);
    const beforeLockRows = await allExecRows(relOk);
    const r1neg = await call('PUT', `/api/sys-releases/${relOk}/executors`, adminTok, { user_ids: [5, 6, 7] });
    assert.strictEqual(r1neg.status, 409, `[2-①负]期望 409, got ${r1neg.status} ${JSON.stringify(r1neg.body)}`);
    assert.strictEqual(r1neg.body.code, 'EXECUTORS_LOCKED', `[2-①负]code 应为 EXECUTORS_LOCKED，实际 ${r1neg.body.code}`);
    assert.deepStrictEqual(await allExecRows(relOk), beforeLockRows, '[2-①负]零副作用：子表行原样未变');
    ok('[2-①负] 在册行已进入 sent 态后再次 PUT → 409 EXECUTORS_LOCKED，子表零副作用');
    // ⭐ L5（Opus 预筛）：relOk 到此结束使命，不复用做后续正例——后续分组各自新建 release（原注释首句
    // "复原：撤销刚才的 sent 标记"与代码不符，代码从未做过撤销动作，已删，防误导未来读者以为这里真有
    // 一步"复原"）。

    // [2-②负]（用户拍板决策 7 第三次修正·方案 v1.7 二订，反转）：下限 2→1 后，"去重后仅 1 人"不再是
    // 负例（见下方 [2-②正] 单人成功用例）——人数闸真正的负例收窄到空集合。红灯诊断：这不是实现错，是
    // 断言本身已过时（决策变了，旧断言仍钉着旧决策），按 [[feedback_test_assertion_self_error]] 处置：
    // 反转断言方向而非改实现去迁就旧断言。
    const relEmpty = await mkRelease({ title: 'G2负-空集合' });
    const rEmpty = await call('PUT', `/api/sys-releases/${relEmpty}/executors`, adminTok, { user_ids: [] });
    assert.strictEqual(rEmpty.status, 400, `[2-②负]期望 400, got ${rEmpty.status} ${JSON.stringify(rEmpty.body)}`);
    assert.strictEqual(rEmpty.body.code, 'EXECUTORS_TOO_FEW', `[2-②负]code 应为 EXECUTORS_TOO_FEW，实际 ${rEmpty.body.code}`);
    assert.strictEqual((await allExecRows(relEmpty)).length, 0, '[2-②负]零落库');
    ok('[2-②负]（反转：原"单人→400"已过时，人数闸负例收窄到空集合）空 user_ids 数组 → 400 EXECUTORS_TOO_FEW，零落库');

    // [2-②正]（新增，决策 7 三修）：去重后仅 1 人 → 200 成功，子表新增 1 行 not_sent/pending。
    const relSingle = await mkRelease({ title: 'G2正-单人成功' });
    const rSingle = await call('PUT', `/api/sys-releases/${relSingle}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(rSingle.status, 200, `[2-②正]期望 200, got ${rSingle.status} ${JSON.stringify(rSingle.body)}`);
    const activeSingle = await activeExecRows(relSingle);
    assert.strictEqual(activeSingle.length, 1, '[2-②正]子表应新增 1 行（单人批次）');
    assert.strictEqual(activeSingle[0].user_id, 5, '[2-②正]新行 user_id=5（确为提交的那个人，非泛泛的"有一行"）');
    assert.strictEqual(activeSingle[0].notify_status, 'not_sent', '[2-②正]新行 notify_status=not_sent（DDL 默认值）');
    assert.strictEqual(activeSingle[0].exec_status, 'pending', '[2-②正]新行 exec_status=pending（DDL 默认值）');
    ok('[2-②正]（新增·决策 7 三修）去重后仅 1 名合格执行人 → 200，子表新增 1 行 not_sent/pending（单人批次本身合法）');

    // [2-③负] 资格闸：其中一个 user_id 是 viewer → 400 EXECUTOR_NOT_ELIGIBLE，零落库（整体不落，不是部分落）
    const relIneligible = await mkRelease({ title: 'G3负-资格不符' });
    const rIneligible = await call('PUT', `/api/sys-releases/${relIneligible}/executors`, adminTok, { user_ids: [5, 9] });
    assert.strictEqual(rIneligible.status, 400, `[2-③负]期望 400, got ${rIneligible.status} ${JSON.stringify(rIneligible.body)}`);
    assert.strictEqual(rIneligible.body.code, 'EXECUTOR_NOT_ELIGIBLE', `[2-③负]code 应为 EXECUTOR_NOT_ELIGIBLE，实际 ${rIneligible.body.code}`);
    assert.strictEqual((await allExecRows(relIneligible)).length, 0, '[2-③负]零落库（含合格的 dev5 也不应单独落库——整体拒绝）');
    ok('[2-③负] user_ids 含 viewer → 400 EXECUTOR_NOT_ELIGIBLE，整体零落库（不因部分合格而部分写入）');
  }

  // ═══ [2-input] PUT executors 输入面校验（Opus 预筛 MED-4）═══
  {
    // [2-i1] user_ids 非数组 → 400 INVALID_USER_IDS
    const relI1 = await mkRelease({ title: 'MED4-输入面-非数组' });
    const rI1 = await call('PUT', `/api/sys-releases/${relI1}/executors`, adminTok, { user_ids: 'not-an-array' });
    assert.strictEqual(rI1.status, 400, `[2-i1]期望 400, got ${rI1.status} ${JSON.stringify(rI1.body)}`);
    assert.strictEqual(rI1.body.code, 'INVALID_USER_IDS', `[2-i1]code 应为 INVALID_USER_IDS，实际 ${rI1.body.code}`);
    assert.strictEqual((await allExecRows(relI1)).length, 0, '[2-i1]零落库');
    ok('[2-i1] user_ids 非数组（字符串） → 400 INVALID_USER_IDS，零落库');

    // [2-i2] user_ids 含非正整数/奇形值 → 400 INVALID_USER_IDS（L7：0/负数/浮点/布尔/嵌套数组/带符号或
    //   非纯数字字符串，均须被拒——不能靠裸 Number() 隐式转换悄悄放行）
    const relI2 = await mkRelease({ title: 'MED4-输入面-奇形值' });
    const malformedCases = [
      [5, 0], [5, -1], [5, 1.5], [5, true], [5, [6]], [5, '6.0'], [5, ' 6'], [5, '0x10'], [5, null],
    ];
    for (const bad of malformedCases) {
      const r = await call('PUT', `/api/sys-releases/${relI2}/executors`, adminTok, { user_ids: bad });
      assert.strictEqual(r.status, 400, `[2-i2]user_ids=${JSON.stringify(bad)} 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'INVALID_USER_IDS', `[2-i2]user_ids=${JSON.stringify(bad)} code 应为 INVALID_USER_IDS，实际 ${r.body.code}`);
    }
    // 合法形态对照组：number 与纯数字字符串两种写法均应放行（不落库断言在别组已覆盖，这里只证形态本身不拒）
    const rI2ok = await call('PUT', `/api/sys-releases/${relI2}/executors`, adminTok, { user_ids: [5, '6'] });
    assert.strictEqual(rI2ok.status, 200, `[2-i2]对照组 user_ids=[5,'6']（number+纯数字字符串混合）期望 200, got ${rI2ok.status} ${JSON.stringify(rI2ok.body)}`);
    assert.strictEqual((await allExecRows(relI2)).length, 2, '[2-i2]对照组应成功落库 2 行');
    ok('[2-i2] user_ids 含 0/负数/浮点/布尔/嵌套数组/畸形字符串 → 均 400 INVALID_USER_IDS；number 与纯数字字符串混合的合法形态对照组 → 200 正常落库');

    // [2-i3] PUT :id 非法 → 400 INVALID_RELEASE_ID
    const rI3 = await call('PUT', `/api/sys-releases/abc/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rI3.status, 400, `[2-i3]期望 400, got ${rI3.status} ${JSON.stringify(rI3.body)}`);
    assert.strictEqual(rI3.body.code, 'INVALID_RELEASE_ID', `[2-i3]code 应为 INVALID_RELEASE_ID，实际 ${rI3.body.code}`);
    ok('[2-i3] PUT :id 非法（非正整数） → 400 INVALID_RELEASE_ID');

    // [2-i4] PUT 不存在的批次 → 404 RELEASE_NOT_FOUND（走闸⓿内的存在性分支）
    const rI4 = await call('PUT', `/api/sys-releases/999999/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rI4.status, 404, `[2-i4]期望 404, got ${rI4.status} ${JSON.stringify(rI4.body)}`);
    assert.strictEqual(rI4.body.code, 'RELEASE_NOT_FOUND', `[2-i4]code 应为 RELEASE_NOT_FOUND，实际 ${rI4.body.code}`);
    ok('[2-i4] PUT 不存在的批次 → 404 RELEASE_NOT_FOUND（闸⓿存在性分支）');

    // [2-i5] 重复同集合 PUT → 200 changed:false ∧ 子表行 id 全不变 ∧ timeline 计数不增（MED-1 空差量 no-op 回归证明）
    const relI5 = await mkRelease({ title: 'MED4-重复同集合-MED1回归' });
    const issueI5 = await mkIssue({ title: 'MED4-重复同集合-成员单' });
    await addIssueTo(relI5, issueI5);
    const rI5first = await call('PUT', `/api/sys-releases/${relI5}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rI5first.status, 200, `[2-i5]首次 PUT 期望 200, got ${rI5first.status} ${JSON.stringify(rI5first.body)}`);
    assert.strictEqual(rI5first.body.changed, true, '[2-i5]首次 PUT（真有变更）changed 应为 true');
    const rowsBefore = await activeExecRows(relI5);
    const tlCountBefore = (await timelineRows(relI5)).length;
    assert.strictEqual(tlCountBefore, 1, '[2-i5]首次 PUT 后 timeline 应有 1 条');

    const rI5second = await call('PUT', `/api/sys-releases/${relI5}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(rI5second.status, 200, `[2-i5]重复 PUT 期望 200, got ${rI5second.status} ${JSON.stringify(rI5second.body)}`);
    assert.strictEqual(rI5second.body.changed, false, '[2-i5]重复同集合 PUT（空差量）changed 应为 false');
    const rowsAfter = await activeExecRows(relI5);
    assert.deepStrictEqual(rowsAfter.map(r => r.id).sort((a, b) => a - b), rowsBefore.map(r => r.id).sort((a, b) => a - b), '[2-i5]重复 PUT 后子表行 id 全不变（未软删重插）');
    const tlCountAfter = (await timelineRows(relI5)).length;
    assert.strictEqual(tlCountAfter, tlCountBefore, `[2-i5]重复 PUT 后 timeline 计数不应增加，期望仍为 ${tlCountBefore}，实际 ${tlCountAfter}`);
    ok('[2-i5] 重复同集合 PUT → 200 changed:false，子表行 id 全不变，timeline 计数不增（MED-1 空差量 no-op 回归证明）');
  }

  // ═══ [非 admin 403·PUT] ═══
  {
    const rel = await mkRelease({ title: '非 admin 调 PUT' });
    const r = await call('PUT', `/api/sys-releases/${rel}/executors`, dev5Tok, { user_ids: [5, 6] });
    assert.strictEqual(r.status, 403, `期望 403, got ${r.status}`);
    assert.strictEqual((await allExecRows(rel)).length, 0, '非 admin 调用零落库');
    ok('非 admin 调 PUT executors → 403，零落库');
  }

  // ═══ [2w] 301-M2：执行人姓名兜底解析加固——display_name 全角+半角混合空格 ═══
  //   构造一个"合法通过既有 DB CHECK 却存进人眼看不出内容"的姓名（半角空格会被 sys_release_executors.user_name
  //   的 CHECK 拒当场 500；全角+半角混合反而"合法通过" CHECK——这正是 301-M2 要修的两种隐蔽坑之一）。
  //   验证目标：resolveExecutorDisplayName 用 JS .trim()（覆盖 U+3000）判定 display_name 无效内容后，
  //   落到中间一级 username 兜底（本用例 username 是正常非空字符串，验证"补齐中间一级"这条 fix），
  //   落库 user_name 非空格串、不 500。
  {
    await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (11, 'wsuser', '　 ', 'user', 'active')`);
    const rel = await mkRelease({ title: 'C2-M2姓名兜底' });
    const r = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 11] });
    assert.strictEqual(r.status, 200, `[2w]期望 200(不应因 CHECK 撞出 500), got ${r.status} ${JSON.stringify(r.body)}`);
    const row11 = (await activeExecRows(rel)).find(x => x.user_id === 11);
    assert.ok(row11, '[2w]用户 11 的行已落库');
    assert.strictEqual(row11.user_name, 'wsuser', '[2w]display_name 全角+半角空格判定为无效内容，落到中间一级 username 兜底="wsuser"（非空格串，非 user#11 兜底到底）');
    assert.notStrictEqual(row11.user_name.trim().length, 0, '[2w]落库 user_name trim 后非空（不是一个人眼看不出内容的空白串）');
    ok('[2w] 301-M2：display_name="　 "（全角+半角混合空格，绕过既有 JS 真假值判断且"合法通过"DB CHECK 的隐蔽坑）→ PUT executors 200 不 500，落库 user_name 兜底到中间一级 username="wsuser"');
  }

  // ═══ [3] 集合替换不复活（§4.1a 代次语义）═══
  {
    const rel = await mkRelease({ title: '代次语义测试批次' });
    // 第一步：A(5)+B(6)
    const r1 = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r1.status, 200, `[3-1]期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    const step1 = await activeExecRows(rel);
    const aRow1 = step1.find(r => r.user_id === 5);
    const bRow1 = step1.find(r => r.user_id === 6);
    assert.ok(aRow1 && bRow1, '[3-1]A(5)/B(6) 均在册');

    // 第二步：改为 A(5)+C(7) —— B 应被软删（原 id 不变），C 应新插入（新 id）
    const r2 = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 7] });
    assert.strictEqual(r2.status, 200, `[3-2]期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const allAfter2 = await allExecRows(rel);
    const aRow2 = allAfter2.find(r => r.user_id === 5 && r.removed_at === null);
    const bRow2 = allAfter2.find(r => r.user_id === 6);
    const cRow2 = allAfter2.find(r => r.user_id === 7 && r.removed_at === null);
    assert.strictEqual(aRow2.id, aRow1.id, '[3-2]A(5) 行 id 未变（仍在新集合中，原样不动，不软删不重插）');
    assert.strictEqual(bRow2.id, bRow1.id, '[3-2]B(6) 软删的是原 id（不是新插一行再软删）');
    assert.ok(bRow2.removed_at, '[3-2]B(6) 已被软删（removed_at 非空）');
    assert.ok(cRow2, '[3-2]C(7) 已插入且在册');
    assert.notStrictEqual(cRow2.id, bRow1.id, '[3-2]C(7) 是全新的行 id，不是复活 B 的旧行');

    // 第三步：改回 A(5)+B(6) —— B 应出现"新行"（新 id，不同于第一步的 B 行），旧 B 行仍软删；C 应被软删
    const r3 = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r3.status, 200, `[3-3]期望 200, got ${r3.status} ${JSON.stringify(r3.body)}`);
    const allAfter3 = await allExecRows(rel);
    const aRow3 = allAfter3.find(r => r.user_id === 5 && r.removed_at === null);
    const bRowsAfter3 = allAfter3.filter(r => r.user_id === 6);
    const cRow3 = allAfter3.find(r => r.user_id === 7 && r.removed_at === null);
    assert.strictEqual(aRow3.id, aRow1.id, '[3-3]A(5) 行 id 全程未变（三轮 PUT 从未被触碰）');
    assert.strictEqual(bRowsAfter3.length, 2, '[3-3]B(6) 应有两条历史行：第一步的旧行(软删) + 本步的新行(在册)');
    const bOldRow = bRowsAfter3.find(r => r.id === bRow1.id);
    const bNewRow = bRowsAfter3.find(r => r.id !== bRow1.id);
    assert.ok(bOldRow && bOldRow.removed_at, '[3-3]B(6) 第一步的旧行仍是软删态（未被复活）');
    assert.ok(bNewRow && bNewRow.removed_at === null, '[3-3]B(6) 出现的是一行全新在册记录（新 id）');
    assert.notStrictEqual(bNewRow.id, bOldRow.id, '[3-3]新行 id 与旧行 id 不同（代次语义：行 id 即代次）');
    const cRowsAfter3 = allAfter3.filter(r => r.user_id === 7);
    assert.strictEqual(cRowsAfter3.length, 1, '[3-3]C(7) 仅有一条行（第二步插入的那条）');
    assert.ok(cRowsAfter3[0].removed_at, '[3-3]C(7) 已被软删（不在第三步的新集合中）');
    ok('[3] 集合替换不复活：A 全程原行不动／B 两轮更迭产生"旧行软删+新行新 id"两条独立记录／C 插入后又被软删——均符合 §4.1a 代次语义（行 id 即代次，绝不复活旧行）');
  }

  // ═══ [4] user_ids 去重 ═══
  {
    const rel = await mkRelease({ title: '去重测试批次' });
    const r = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 5, 6, 6, 6] });
    assert.strictEqual(r.status, 200, `[4]期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const active = await activeExecRows(rel);
    assert.strictEqual(active.length, 2, `[4]user_ids 含重复应按去重后的 2 人处理，实际落库 ${active.length} 行`);
    // ⭐ L6（Opus 预筛）：数值数组用默认 .sort() 是字典序（对多位数会错，如 [10,9] 不会排成 [9,10]）——
    // 这里两个值恰好都是个位数才侥幸不报错，改显式数值比较器，不留侥幸。
    assert.deepStrictEqual(active.map(r => r.user_id).sort((a, b) => a - b), [5, 6], '[4]去重后仍是 5/6 两人');
    ok('[4] user_ids=[5,5,6,6,6]（含重复）→ 去重后按 2 人处理，子表仅 2 行');
  }

  // ═══ [5] timeline 落行断言 ═══
  {
    const rel = await mkRelease({ title: 'timeline 断言批次' });
    const issue1 = await mkIssue({ title: 'timeline 成员单1' });
    const issue2 = await mkIssue({ title: 'timeline 成员单2' });
    await addIssueTo(rel, issue1);
    await addIssueTo(rel, issue2);
    const r = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(r.status, 200, `[5]期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const tl = await timelineRows(rel);
    assert.strictEqual(tl.length, 2, `[5]批次含 2 个成员单，应各写一条 timeline，实际 ${tl.length} 条`);
    assert.ok(tl.every(t => t.ref_id === rel), '[5]全部 timeline 行 ref_id=releaseId');
    assert.ok(tl.every(t => t.action_code === 'release_executors_set'), '[5]action_code=release_executors_set');
    assert.ok(tl.every(t => /设置上线执行人：/.test(t.summary) && /开发甲/.test(t.summary) && /开发乙/.test(t.summary)), '[5]summary 含"设置上线执行人：开发甲、开发乙"');
    assert.ok(tl.every(t => t.operator_id === 1 && t.operator_name === '管理员'), '[5]operator 为发起的 admin');
    // 同 L6：issue1/issue2 是自增 id，跑到 [5] 组时前面已建过大量夹具，大概率是多位数——同样需要数值比较器。
    const numSort = (a, b) => a - b;
    const issueIds = tl.map(t => t.issue_id).sort(numSort);
    assert.deepStrictEqual(issueIds, [issue1, issue2].sort(numSort), '[5]timeline 覆盖批次内全部成员单');
    ok('[5] PUT executors 成功后按批次成员单各写一条 timeline（action_code=release_executors_set，ref_id=releaseId，summary 含姓名）');
  }

  // ═══ [6] POST /sys-releases/:id/executors/:userId/notify（行级通知，C2，方案 §4.4 端点 3） ═══
  {
    // [6a][6b][6c] 主链路：同一批次同一批人，首发 → 重发 → failed 重试，全程共用一个 release 观察状态转移。
    const rel6 = await mkRelease({ title: 'C2-行级通知-主链路' });
    const issue6 = await mkIssue({ title: 'C2-行级通知-成员单' });
    await addIssueTo(rel6, issue6);
    const put6 = await call('PUT', `/api/sys-releases/${rel6}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put6.status, 200, `[6-fixture]PUT executors 期望 200, got ${put6.status} ${JSON.stringify(put6.body)}`);

    // [6a] 首发：not_sent → sending（内部）→ sent
    const r6a = await call('POST', `/api/sys-releases/${rel6}/executors/5/notify`, adminTok);
    assert.strictEqual(r6a.status, 200, `[6a]期望 200, got ${r6a.status} ${JSON.stringify(r6a.body)}`);
    assert.strictEqual(r6a.body.notify_status, 'sent', '[6a]响应 notify_status=sent');
    assert.strictEqual(r6a.body.notify_error, null, '[6a]响应无错误');
    const row5a = await execRow(rel6, 5);
    assert.strictEqual(row5a.notify_status, 'sent', '[6a]落库 notify_status=sent');
    assert.ok(row5a.notified_at, '[6a]notified_at 已写');
    assert.strictEqual(row5a.notify_message_key, 'stub-dev', '[6a]message_key=桩返回值');
    assert.strictEqual(row5a.notify_error, null, '[6a]notify_error 为空');
    assert.strictEqual(row5a.notify_started_at, null, '[6a]写回后 notify_started_at 清空（不留 in-flight 痕迹）');
    const token1 = row5a.notify_token;
    assert.ok(token1, '[6a]notify_token 已写');
    const row6a_other = await execRow(rel6, 6);
    assert.strictEqual(row6a_other.notify_status, 'not_sent', '[6a]同批次另一执行人(6)未受影响');
    const tl6a = await notifyTimelineRows(rel6);
    assert.strictEqual(tl6a.length, 1, '[6a]timeline 新增 1 条');
    assert.ok(/通知执行人：开发甲（首发）/.test(tl6a[0].summary), `[6a]timeline 文案含"通知执行人：开发甲（首发）"，实际 ${tl6a[0].summary}`);
    assert.strictEqual(tl6a[0].issue_id, issue6, '[6a]timeline issue_id 对应批次成员单');
    ok('[6a] 首发链 not_sent→sending→sent：响应+落库+message_key+token+started_at 清空+同批另一人不受影响+timeline"首发"文案');

    // [6b] 重发（sent 分支）：token 换新 + read_at 被预占阶段清空（证明走了完整预占，非幂等空转）
    await run(`UPDATE sys_release_executors SET read_at = '2026-02-01 00:00:00' WHERE id = ?`, [row5a.id]);
    const r6b = await call('POST', `/api/sys-releases/${rel6}/executors/5/notify`, adminTok);
    assert.strictEqual(r6b.status, 200, `[6b]期望 200, got ${r6b.status} ${JSON.stringify(r6b.body)}`);
    assert.strictEqual(r6b.body.notify_status, 'sent', '[6b]重发后仍 sent');
    const row5b = await execRow(rel6, 5);
    assert.notStrictEqual(row5b.notify_token, token1, '[6b]重发生成新 token（新一轮投递代际）');
    assert.strictEqual(row5b.read_at, null, '[6b]重发后 read_at 被重置（预占阶段清空）');
    const tl6b = await notifyTimelineRows(rel6);
    assert.strictEqual(tl6b.length, 2, '[6b]timeline 追加第 2 条');
    assert.ok(/通知执行人：开发甲（重发）/.test(tl6b[1].summary), `[6b]第二条应为"重发"文案，实际 ${tl6b[1].summary}`);
    ok('[6b] 重发 sent 分支：token 换新+read_at 重置+timeline"重发"文案追加（非幂等空转）');

    // [6c] failed 重试：注入一次失败 → 落 failed，允许再次发送（非拒绝）→ 转 sent
    SEND_IMPL = async (targetUser) => (targetUser && targetUser.id === 6) ? { ok: false, reason: '模拟失败' } : { ok: true, message_key: 'stub-dev' };
    const r6c1 = await call('POST', `/api/sys-releases/${rel6}/executors/6/notify`, adminTok);
    assert.strictEqual(r6c1.status, 200, `[6c-1]失败发送仍应 200(写回本身成功，只是业务态=failed), got ${r6c1.status} ${JSON.stringify(r6c1.body)}`);
    assert.strictEqual(r6c1.body.notify_status, 'failed', '[6c-1]响应 notify_status=failed');
    assert.strictEqual(r6c1.body.notify_error, '模拟失败', '[6c-1]响应带错误原因');
    const row6c1 = await execRow(rel6, 6);
    assert.strictEqual(row6c1.notify_status, 'failed', '[6c-1]落库 failed');
    assert.strictEqual(row6c1.notify_error, '模拟失败', '[6c-1]落库错误原因');
    assert.strictEqual(row6c1.notified_at, null, '[6c-1]失败不写 notified_at');
    assert.strictEqual(row6c1.notify_message_key, null, '[6c-1]失败不写 message_key');

    SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });   // 复位为默认成功
    const r6c2 = await call('POST', `/api/sys-releases/${rel6}/executors/6/notify`, adminTok);
    assert.strictEqual(r6c2.status, 200, `[6c-2]failed 态重试期望 200(允许再发，非拒绝), got ${r6c2.status} ${JSON.stringify(r6c2.body)}`);
    assert.strictEqual(r6c2.body.notify_status, 'sent', '[6c-2]重试后转 sent');
    const row6c2 = await execRow(rel6, 6);
    assert.strictEqual(row6c2.notify_status, 'sent', '[6c-2]落库 sent');
    assert.strictEqual(row6c2.notify_error, null, '[6c-2]notify_error 清空');
    const tl6c = await notifyTimelineRows(rel6);
    assert.strictEqual(tl6c.length, 4, '[6c]timeline 累计 4 条（[6a]1+[6b]1+[6c]2）');
    assert.ok(/通知执行人：开发乙（首发，失败：模拟失败）/.test(tl6c[2].summary), `[6c]第 3 条应为"首发失败"文案，实际 ${tl6c[2].summary}`);
    assert.ok(/通知执行人：开发乙（重发）/.test(tl6c[3].summary), `[6c]第 4 条应为"重发"文案（重试按非首次算），实际 ${tl6c[3].summary}`);
    ok('[6c] failed 重试：注入失败→落 failed+错误原因+不写 notified_at/message_key；复位后重试→允许发送(非拒绝)并转 sent；timeline 首发失败/重发两条文案分明');
  }

  // [6d] done 拒发 409
  {
    const rel = await mkRelease({ title: 'C2-done拒发' });
    const issue = await mkIssue({ title: 'C2-done拒发-成员单' });
    await addIssueTo(rel, issue);   // MED-2 闸要求批次非空，否则会先命中 empty 而非本组要测的 done 分支
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6d-fixture]期望 200, got ${put.status}`);
    const row0 = await execRow(rel, 5);
    await run(`UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE id=?`, [row0.id]);
    const before = await execRow(rel, 5);
    const r = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r.status, 409, `[6d]期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EXECUTOR_ALREADY_DONE', `[6d]code 应为 EXECUTOR_ALREADY_DONE，实际 ${r.body.code}`);
    const after = await execRow(rel, 5);
    assert.deepStrictEqual(after, before, '[6d]零副作用：行原样未变');
    ok('[6d] exec_status=done 的执行人再通知 → 409 EXECUTOR_ALREADY_DONE，零副作用');
  }

  // [6e] sending 在途（未超窗）拒 409
  {
    const rel = await mkRelease({ title: 'C2-在途拒发' });
    const issue = await mkIssue({ title: 'C2-在途拒发-成员单' });
    await addIssueTo(rel, issue);   // MED-2 闸要求批次非空
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6e-fixture]期望 200, got ${put.status}`);
    const row0 = await execRow(rel, 5);
    await run(`UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime'), notify_token='inflight-tok' WHERE id=?`, [row0.id]);
    const before = await execRow(rel, 5);
    const r = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r.status, 409, `[6e]期望 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOTIFY_IN_FLIGHT', `[6e]code 应为 NOTIFY_IN_FLIGHT，实际 ${r.body.code}`);
    const after = await execRow(rel, 5);
    assert.deepStrictEqual(after, before, '[6e]零副作用：未超窗的在途行原样未变（stale 惰性转换未触发）');
    ok('[6e] notify_status=sending 且未超窗（在途）再通知 → 409 NOTIFY_IN_FLIGHT，零副作用（证明不误伤真实在途请求）');
  }

  // [6f] 非在册 404（未加入 / 已被软删移除 两种）
  {
    const rel = await mkRelease({ title: 'C2-非在册404' });
    const r1 = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r1.status, 404, `[6f-1]期望 404, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'EXECUTOR_NOT_ACTIVE', `[6f-1]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r1.body.code}`);
    ok('[6f-1] 用户从未加入本批次执行人 → 404 EXECUTOR_NOT_ACTIVE');

    const put1 = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put1.status, 200, `[6f-2-fixture1]期望 200, got ${put1.status}`);
    const put2 = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [6, 7] }); // 移除 5
    assert.strictEqual(put2.status, 200, `[6f-2-fixture2]期望 200, got ${put2.status}`);
    const removedRow = await execRow(rel, 5, false);
    assert.ok(removedRow && removedRow.removed_at, '[6f-2-fixture]确认 5 已被软删');
    const r2 = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r2.status, 404, `[6f-2]期望 404, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'EXECUTOR_NOT_ACTIVE', `[6f-2]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r2.body.code}`);
    ok('[6f-2] 用户曾加入后被软删移除 → 404 EXECUTOR_NOT_ACTIVE（软删行不算在册）');
  }

  // [6g] 五条件 CAS 负例（§4.1a 定稿）× 3——⭐ L5（Opus 预筛）组名/注释写实：本组真实打到的是
  //   token / removed_at / id 三个条件（各自独立构造真实并发窗口，见各子项）；release_id/user_id
  //   两条件结构性不可构造——它们直接来自路由 path 参数，"并发方改写另一 release_id/user_id"根本不是
  //   同一个请求在竞争，而是发往别的 URL 的另一个请求，不存在"同一次写回撞见不同 release_id/user_id"
  //   这种场景，故不强行造一个假测试凑数。
  {
    // [6g-1] token 不匹配写回拒：外呼期间"另一进程"改写了该行 token（用 SEND_IMPL 副作用模拟并发写）
    const rel1 = await mkRelease({ title: 'C2-CAS负例-token不匹配' });
    const issue1 = await mkIssue({ title: 'C2-CAS负例-token-成员单' });
    await addIssueTo(rel1, issue1);   // MED-2 闸要求批次非空（本组三个子项均需走通完整发送流程）
    const put1 = await call('PUT', `/api/sys-releases/${rel1}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put1.status, 200, `[6g-1-fixture]期望 200, got ${put1.status}`);
    SEND_IMPL = async (targetUser) => {
      if (targetUser && targetUser.id === 5) {
        await run(`UPDATE sys_release_executors SET notify_token = 'race-injected-token' WHERE release_id = ? AND user_id = 5 AND removed_at IS NULL`, [rel1]);
      }
      return { ok: true, message_key: 'stub-dev' };
    };
    const r1 = await call('POST', `/api/sys-releases/${rel1}/executors/5/notify`, adminTok);
    SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });
    assert.strictEqual(r1.status, 200, `[6g-1]写回阶段并发变更沿用既有 200+concurrent_changed 标志范式（非 409）, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.concurrent_changed, true, '[6g-1]响应标记 concurrent_changed:true');
    assert.strictEqual(r1.body.dry_run, false, '[6g-1]L2：concurrent_changed 响应也带 dry_run 字段（本组未开演练，应为 false）');
    const rowAfter1 = await execRow(rel1, 5);
    assert.strictEqual(rowAfter1.notify_token, 'race-injected-token', '[6g-1]写回被 CAS 拒绝：token 保持"race"注入值，未被写回覆盖');
    assert.strictEqual(rowAfter1.notify_status, 'sending', '[6g-1]写回被拒后行仍停在 sending（未被误标 sent，也未发生降级写入）');
    assert.strictEqual(rowAfter1.notified_at, null, '[6g-1]notified_at 未被写入（证明确实没有发生部分字段降级写入）');
    // MED-4（Opus 预筛）：写回被拒不等于什么都没留痕——独立小事务应补一条"通知已发出但结果未入账"记录。
    const tl1 = await notifyTimelineRows(rel1);
    assert.strictEqual(tl1.length, 1, `[6g-1]MED-4：写回被拒仍应补 1 条 timeline，实际 ${tl1.length} 条`);
    assert.ok(/通知已发出但结果未入账，并发变更/.test(tl1[0].summary), `[6g-1]MED-4 timeline 文案写实"通知已发出但结果未入账，并发变更"，实际 ${tl1[0].summary}`);
    ok('[6g-1] 五条件 CAS 负例·token 不匹配：外呼期间行 token 被并发改写 → 写回 CAS 拒绝(200+concurrent_changed:true+dry_run:false)，行保持并发方写的值不降级写入，且 MED-4 补 1 条"未入账"timeline');

    // [6g-2] 软删行拒写：外呼期间该行被并发软删移除
    const rel2 = await mkRelease({ title: 'C2-CAS负例-软删行' });
    const issue2 = await mkIssue({ title: 'C2-CAS负例-软删-成员单' });
    await addIssueTo(rel2, issue2);
    const put2 = await call('PUT', `/api/sys-releases/${rel2}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put2.status, 200, `[6g-2-fixture]期望 200, got ${put2.status}`);
    SEND_IMPL = async (targetUser) => {
      if (targetUser && targetUser.id === 5) {
        await run(`UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE release_id = ? AND user_id = 5 AND removed_at IS NULL`, [rel2]);
      }
      return { ok: true, message_key: 'stub-dev' };
    };
    const r2 = await call('POST', `/api/sys-releases/${rel2}/executors/5/notify`, adminTok);
    SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });
    assert.strictEqual(r2.status, 200, `[6g-2]期望 200(既有 200+concurrent_changed 范式), got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.concurrent_changed, true, '[6g-2]响应标记 concurrent_changed:true');
    const rowAfter2 = await execRow(rel2, 5, false);   // activeOnly=false：此时已软删，在册查询会是空
    assert.ok(rowAfter2.removed_at, '[6g-2]行保持软删态（并发方写的 removed_at 未被写回覆盖清空）');
    assert.strictEqual(rowAfter2.notify_status, 'sending', '[6g-2]写回被拒：notify_status 仍停在 sending（未被误标 sent）');
    ok('[6g-2] 五条件 CAS 负例·软删行：外呼期间行被并发软删移除 → 写回 CAS 因 removed_at IS NULL 条件失配而拒绝(200+concurrent_changed:true)，软删态不被覆盖');

    // [6g-3] 代次隔离·id 条件真打（MED-6 重构，Opus 预筛）：原版本三次 PUT 串行构造"旧行软删+新行"，
    //   全程只存在一个真正 active 的行，从未出现"两行并存、写回可能撞见新行"的真实窗口，无法证伪
    //   `id=?` 条件是否 load-bearing（去掉它换成只靠 user_id+removed_at IS NULL 定位，旧版本测试也
    //   会全绿）。重构改用 SEND_IMPL 副作用，在预占（锁定旧行 id）之后、写回之前，真实造出"旧行被软删
    //   +同 user_id 插入全新 not_sent 行"并存的窗口——写回若不靠 id 精确锁定，理论上可能被"user_id 匹配
    //   +removed_at IS NULL"这组更宽的条件误中全新行。断言写回后新行 notify_status 仍 not_sent、
    //   notify_token 仍 NULL，坐实 id 条件确实在挡这条风险路径（不是摆设）。
    const rel3 = await mkRelease({ title: 'C2-代次隔离-id条件真打' });
    const issue3 = await mkIssue({ title: 'C2-代次隔离-成员单' });
    await addIssueTo(rel3, issue3);
    const put3 = await call('PUT', `/api/sys-releases/${rel3}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put3.status, 200, `[6g-3-fixture]期望 200, got ${put3.status}`);
    const oldRow3 = await execRow(rel3, 5);   // 预占将锁定这一行的 id
    SEND_IMPL = async (targetUser) => {
      if (targetUser && targetUser.id === 5) {
        // 外呼期间"另一进程"：软删预占中的旧行 + 为同一 user_id 插入一行全新 not_sent 行（模拟
        //   "移除后重新加入"的真实并发窗口，制造"两行并存"这个原版本从未出现过的状态）。
        await run(`UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE id = ?`, [oldRow3.id]);
        await run(
          `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name)
           VALUES (?, 5, '开发甲', 1, '管理员')`,
          [rel3]
        );
      }
      return { ok: true, message_key: 'stub-dev' };
    };
    const r3 = await call('POST', `/api/sys-releases/${rel3}/executors/5/notify`, adminTok);
    SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });
    assert.strictEqual(r3.status, 200, `[6g-3]期望 200(既有 200+concurrent_changed 范式), got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.concurrent_changed, true, '[6g-3]响应标记 concurrent_changed:true（旧行已被移除，五条件 CAS 因 removed_at 条件失配而拒绝）');
    const oldRow3After = await get(`SELECT * FROM sys_release_executors WHERE id = ?`, [oldRow3.id]);
    assert.ok(oldRow3After.removed_at, '[6g-3]旧行(预占目标)保持软删态');
    assert.strictEqual(oldRow3After.notify_status, 'sending', '[6g-3]旧行 notify_status 仍停在 sending（未被误标 sent）——写回被 CAS 拒绝');
    const newRow3 = await execRow(rel3, 5);   // 当前在册的全新行
    assert.notStrictEqual(newRow3.id, oldRow3.id, '[6g-3-fixture]确认新行是全新 id（非同一行）');
    assert.strictEqual(newRow3.notify_status, 'not_sent', '[6g-3] ⭐ 新行 notify_status 仍是 not_sent——证明写回 CAS 的 id=? 条件挡住了"仅靠 user_id+removed_at IS NULL 定位会误中新行"这条风险路径（id 条件真打到，非摆设）');
    assert.strictEqual(newRow3.notify_token, null, '[6g-3] ⭐ 新行 notify_token 仍是 NULL（从未被本次发送触碰）');
    ok('[6g-3] 代次隔离·id 条件真打：外呼期间旧行(预占目标)被并发软删 + 同 user 全新行插入并存 → 写回 CAS 因 id 锁定精确拒绝，全新行 not_sent/token=NULL 分毫未动（MED-6：真实构造"两行并存"窗口，坐实 id 条件 load-bearing）');

    // [6g-2-真实端点]（307 号 M3②·codex 对抗审）：[6g-2] 用 SEND_IMPL 副作用直接 SQL 软删该行，验证的是
    // "行被软删后写回 CAS 会拒"这条不变量本身，但夹具手法是模拟出来的等价软删，不是真走 cancel-schedule
    // 端点——不能排除"真实端点内部还有别的连带副作用（比如同批次其他行、timeline、批次状态）在这个窗口
    // 下会不会跟这条 CAS 冲突或产生本组没覆盖到的异常"。本条改为外呼期间真实调用 POST cancel-schedule
    // （对接人身份），验证：① 真实端点本身在这个窗口内完整跑通（200+批次真实撤销，非只模拟软删这一列）；
    // ② 写回 CAS 依然因 removed_at IS NULL 条件失配而拒绝，行为与 [6g-2] 一致；③ 真实端点自己的 timeline
    // 留痕也确实发生了（真端点调用不只改一列，是完整一次业务操作）。
    {
      const relReal = await mkRelease({ title: 'C2-CAS负例-真实cancel端点' });
      const issueReal = await mkIssue({ title: 'C2-CAS负例-真实cancel-成员单' });
      await addIssueTo(relReal, issueReal);
      const putReal = await call('PUT', `/api/sys-releases/${relReal}/executors`, adminTok, { user_ids: [5, 6] });
      assert.strictEqual(putReal.status, 200, `[6g-2-真实端点-fixture]期望 200, got ${putReal.status}`);
      const tlBefore = await notifyTimelineRowsByCode(relReal, 'release_schedule_cancel');
      assert.strictEqual(tlBefore.length, 0, '[6g-2-真实端点-前置] 撤销尚未发生，release_schedule_cancel timeline 应为 0 条');

      let cancelCallResult = null;
      SEND_IMPL = async (targetUser) => {
        if (targetUser && targetUser.id === 5) {
          // 外呼期间"另一进程"：真实调用 POST cancel-schedule（对接人身份，非 admin），而不是直接 SQL 软删
          // 那一列——这一步本身就要走完批次态闸/子表软删/timeline 全套真实逻辑。
          cancelCallResult = await call('POST', `/api/sys-releases/${relReal}/cancel-schedule`, liaisonTok, { reason: '外呼窗口内真实撤销（307-M3②）' });
        }
        return { ok: true, message_key: 'stub-dev' };
      };
      const rReal = await call('POST', `/api/sys-releases/${relReal}/executors/5/notify`, adminTok);
      SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });

      assert.ok(cancelCallResult, '[6g-2-真实端点] SEND_IMPL 内的真实 cancel-schedule 调用应确实执行过（防夹具没触发就通过）');
      assert.strictEqual(cancelCallResult.status, 200, `[6g-2-真实端点] 外呼窗口内的真实 cancel-schedule 调用本身应 200 成功, got ${cancelCallResult.status} ${JSON.stringify(cancelCallResult.body)}`);
      assert.strictEqual(cancelCallResult.body.cancelled, true, '[6g-2-真实端点] 真实 cancel-schedule 响应 cancelled:true');

      assert.strictEqual(rReal.status, 200, `[6g-2-真实端点]期望 200(既有 200+concurrent_changed 范式), got ${rReal.status} ${JSON.stringify(rReal.body)}`);
      assert.strictEqual(rReal.body.concurrent_changed, true, '[6g-2-真实端点] 写回响应标记 concurrent_changed:true——与 [6g-2] 模拟软删同一结论，但这次是真实端点产生的软删');

      const rowRealAfter = await execRow(relReal, 5, false);   // activeOnly=false：此时已被真实端点软删，在册查询会是空
      assert.ok(rowRealAfter.removed_at, '[6g-2-真实端点] 行保持软删态（真实 cancel-schedule 产生的 removed_at 未被写回 CAS 覆盖清空）');
      assert.strictEqual(rowRealAfter.notify_status, 'sending', '[6g-2-真实端点] notify_status 仍停在 sending（写回被拒，未被误标 sent）');

      const tlAfter = await notifyTimelineRowsByCode(relReal, 'release_schedule_cancel');
      assert.strictEqual(tlAfter.length, 1, `[6g-2-真实端点] 真实端点自己的 release_schedule_cancel timeline 应真实新增 1 条（证明走的是完整业务操作，不是单纯改一列），实际 ${tlAfter.length}`);
      assert.ok(/外呼窗口内真实撤销/.test(tlAfter[0].summary), `[6g-2-真实端点] timeline 内容含真实撤销原因文本，实际 ${tlAfter[0].summary}`);
      ok('[6g-2-真实端点]（307 号 M3②）五条件 CAS 负例·真实 cancel-schedule 端点版：外呼窗口内并发方走的是真实 POST cancel-schedule（非 SQL 直接软删模拟）——端点自身 200 完整撤销+timeline 真实落地，写回 CAS 依然因 removed_at IS NULL 条件失配而拒绝(concurrent_changed:true)，结论与 [6g-2] 模拟版一致，本条补的是"真实端点全链路"这层证据');
    }
  }

  // [6h] A 失败 B 成功互不影响（行级独立，无批次级回滚）
  {
    const rel = await mkRelease({ title: 'C2-互不影响' });
    const issue = await mkIssue({ title: 'C2-互不影响-成员单' });
    await addIssueTo(rel, issue);   // MED-2 闸要求批次非空
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6h-fixture]期望 200, got ${put.status}`);
    SEND_IMPL = async (targetUser) => (targetUser && targetUser.id === 5) ? { ok: false, reason: 'A用户模拟失败' } : { ok: true, message_key: 'stub-dev' };
    const rA = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    const rB = await call('POST', `/api/sys-releases/${rel}/executors/6/notify`, adminTok);
    SEND_IMPL = async () => ({ ok: true, message_key: 'stub-dev' });
    assert.strictEqual(rA.status, 200, `[6h]A(5)期望 200(写回成功,业务态failed), got ${rA.status}`);
    assert.strictEqual(rA.body.notify_status, 'failed', '[6h]A(5)业务态 failed');
    assert.strictEqual(rB.status, 200, `[6h]B(6)期望 200, got ${rB.status}`);
    assert.strictEqual(rB.body.notify_status, 'sent', '[6h]B(6)业务态 sent（不受 A 失败牵连）');
    const rowA = await execRow(rel, 5);
    const rowB = await execRow(rel, 6);
    assert.strictEqual(rowA.notify_status, 'failed', '[6h]A(5)落库 failed');
    assert.strictEqual(rowB.notify_status, 'sent', '[6h]B(6)落库 sent（行级独立，无批次级回滚牵连）');
    ok('[6h] A 失败 B 成功互不影响：两次独立行级通知，A(5)落 failed 不阻塞/不牵连 B(6)落 sent（行级 CAS 天然无批次级回滚）');
  }

  // [6i] 行级 stale 惰性转换（Opus 预筛 L8）：直调单元断言 + 端到端佐证 + 批量版覆盖
  {
    const rel = await mkRelease({ title: 'C2-stale惰性转换' });
    const issue = await mkIssue({ title: 'C2-stale惰性转换-成员单' });
    await addIssueTo(rel, issue);   // MED-2 闸要求批次非空
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6i-fixture]期望 200, got ${put.status}`);
    const row5 = await execRow(rel, 5);
    // 构造超窗 sending：started_at=-10 分钟（窗口阈值 -5 分钟，10 分钟必超）
    await run(`UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime','-10 minutes'), notify_token='stale-tok' WHERE id=?`, [row5.id]);

    // [6i-1] 直调单元断言：staleTransitionForExecutorRow 后该行应转 stale（其余列不动，佐证"只改一列"）
    await I.staleTransitionForExecutorRow(rel, 5);
    const rowStale = await execRow(rel, 5);
    assert.strictEqual(rowStale.notify_status, 'stale', '[6i-1]超窗 sending 行经 staleTransitionForExecutorRow 后转 stale');
    assert.strictEqual(rowStale.notify_token, 'stale-tok', '[6i-1]stale 转换只改 notify_status，token 原样不动');
    ok('[6i-1] 行级 stale 惰性转换直调单元断言：超窗 sending → stale（仅改 1 列，token/其余列不受影响）');

    // [6i-2] 端到端佐证：stale 态执行人再通知 → 允许发送并转 sent（对照 [6e] 未超窗 409，反证明惰性转换确实生效）
    const r6i = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r6i.status, 200, `[6i-2]stale 态应允许发送, got ${r6i.status} ${JSON.stringify(r6i.body)}`);
    assert.strictEqual(r6i.body.notify_status, 'sent', '[6i-2]stale 态发送后转 sent');
    const rowSent = await execRow(rel, 5);
    assert.notStrictEqual(rowSent.notify_token, 'stale-tok', '[6i-2]新一轮预占生成新 token（非沿用旧 sending 的 stale-tok）');
    ok('[6i-2] 端到端佐证：超窗 stale 行调用通知端点 → 入口先做惰性转换再判定 → 允许发送并转 sent（对照 [6e] 未超窗 409 在途拒绝，反证明窗口口径生效）');

    // [6i-3] 批量版 staleTransitionForExecutorRelease：C3/C4 复用点单元覆盖
    const row6 = await execRow(rel, 6);
    await run(`UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime','-10 minutes'), notify_token='stale-tok-6' WHERE id=?`, [row6.id]);
    await I.staleTransitionForExecutorRelease(rel);
    const row6After = await execRow(rel, 6);
    assert.strictEqual(row6After.notify_status, 'stale', '[6i-3]staleTransitionForExecutorRelease 批量转换同批次内超窗 sending 行');
    ok('[6i-3] 批量版 staleTransitionForExecutorRelease 单元断言：批次内超窗 sending 行统一转 stale（供 C3/C4 复用点）');
  }

  // [6j] 非 admin 403（零副作用）
  {
    const rel = await mkRelease({ title: 'C2-非admin调用notify' });
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6j-fixture]期望 200, got ${put.status}`);
    const r = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, dev5Tok);
    assert.strictEqual(r.status, 403, `[6j]期望 403, got ${r.status}`);
    const row = await execRow(rel, 5);
    assert.strictEqual(row.notify_status, 'not_sent', '[6j]零副作用：非 admin 调用未触发任何状态变更');
    ok('[6j] 非 admin 调 POST notify → 403，零副作用');
  }

  // [6k] :id / :userId 非法 → 400
  {
    const rInvalidRel = await call('POST', `/api/sys-releases/abc/executors/5/notify`, adminTok);
    assert.strictEqual(rInvalidRel.status, 400, `[6k-1]期望 400, got ${rInvalidRel.status}`);
    assert.strictEqual(rInvalidRel.body.code, 'INVALID_RELEASE_ID', `[6k-1]code 应为 INVALID_RELEASE_ID，实际 ${rInvalidRel.body.code}`);
    const rInvalidUser = await call('POST', `/api/sys-releases/1/executors/abc/notify`, adminTok);
    assert.strictEqual(rInvalidUser.status, 400, `[6k-2]期望 400, got ${rInvalidUser.status}`);
    assert.strictEqual(rInvalidUser.body.code, 'INVALID_USER_ID', `[6k-2]code 应为 INVALID_USER_ID，实际 ${rInvalidUser.body.code}`);
    ok('[6k] 非法 :id / :userId → 400 INVALID_RELEASE_ID / INVALID_USER_ID');
  }

  // [6l]（额外补强，非协调方点名，L1 订正：手法比照的原批次级 ⑭(e)〔通知三件套并发用例〕已随 C4b 收编分诊
  //   删除，此处是历史设计记录——本组当时借鉴该手法独立成立，与它后来是否还在无关）：真实并发双发同一行，
  //   证明抢占阶段 CAS 也并发安全
  {
    const rel = await mkRelease({ title: 'C2-并发双发' });
    const issue = await mkIssue({ title: 'C2-并发双发-成员单' });
    await addIssueTo(rel, issue);   // MED-2 闸要求批次非空
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6l-fixture]期望 200, got ${put.status}`);
    const [ra, rb] = await Promise.all([
      call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok),
      call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok),
    ]);
    const oks = [ra, rb].filter(r => r.status === 200);
    const rejects = [ra, rb].filter(r => r.status !== 200);
    assert.strictEqual(oks.length + rejects.length, 2, `[6l]两次调用应全部有响应, 实际 ${ra.status}/${rb.status}`);
    assert.ok(oks.length >= 1, `[6l]至少一方应成功, 实际 ${ra.status}/${rb.status} ${JSON.stringify(ra.body)} ${JSON.stringify(rb.body)}`);
    assert.ok(rejects.every(r => r.status === 409), `[6l]败方必须是 409（并发族），不能是 5xx，实际 ${JSON.stringify(rejects.map(r => r.status))}`);
    assert.ok(rejects.every(r => ['NOTIFY_CONCURRENT_CHANGED', 'NOTIFY_IN_FLIGHT'].includes(r.body.code)), `[6l]败方 code 须为并发族, 实际 ${JSON.stringify(rejects.map(r => r.body.code))}`);
    const rowFinal = await execRow(rel, 5);
    assert.ok(['sent', 'failed'].includes(rowFinal.notify_status), `[6l]终态应落在 sent/failed 二选一（胜者跑完整流程），不应停在 sending/not_sent, 实际 ${rowFinal.notify_status}`);
    ok('[6l] 真实并发双发同一行：赢家走通(200)，败方 409(并发族 code)，无 5xx，终态干净落在 sent/failed 二选一（额外补强，手法比照的原批次级⑭(e) 已随 C4b 收编删除，本组是独立成立的行级用例）');
  }

  // [6m] dry-run 开关（HIGH-1 主线 + MED-5，Opus 预筛）：① 'on' 全链路演练 ② 笔误值 fail-open 但可观测
  {
    const rel = await mkRelease({ title: 'C2-dryrun开关' });
    const issue = await mkIssue({ title: 'C2-dryrun-成员单' });
    await addIssueTo(rel, issue);
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6m-fixture]期望 200, got ${put.status}`);

    // [6m-1] sys_notify_dry_run='on' → 全链路演练：SEND_IMPL 零调用 + message_key 前缀 dryrun- +
    //   落库 sent + timeline 含"演练"标记（HIGH-1 主线）。
    SYS_NOTIFY_DRY_RUN_CONFIG = 'on';
    const before1 = sendCallCount;
    const r1 = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    assert.strictEqual(r1.status, 200, `[6m-1]期望 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.dry_run, true, '[6m-1]响应 dry_run=true');
    assert.strictEqual(sendCallCount, before1, '[6m-1]SEND_IMPL 零调用（演练不出网，MED-5 子项①）');
    const row1 = await execRow(rel, 5);
    assert.strictEqual(row1.notify_status, 'sent', '[6m-1]落库 sent');
    assert.ok(row1.notify_message_key && row1.notify_message_key.startsWith('dryrun-'), `[6m-1]message_key 前缀 dryrun-，实际 ${row1.notify_message_key}`);
    const tl1 = await notifyTimelineRows(rel);
    assert.ok(/演练/.test(tl1[tl1.length - 1].summary), `[6m-1]HIGH-1：timeline 含"演练"标记，实际 ${tl1[tl1.length - 1].summary}`);
    assert.ok(!/失败/.test(tl1[tl1.length - 1].summary), '[6m-1]演练成功不应带"失败"字样');
    ok('[6m-1] sys_notify_dry_run=on → 全链路演练：dry_run=true+SEND_IMPL零调用+message_key前缀dryrun-+落库sent+timeline含"演练"标记（HIGH-1 主线）');

    // [6m-2] sys_notify_dry_run='ONN'（笔误）→ 仍按真发处理（fail-open）+ 告警日志命中（MED-5 子项②）
    SYS_NOTIFY_DRY_RUN_CONFIG = 'ONN';
    warnLogs.length = 0;
    const before2 = sendCallCount;
    const r2 = await call('POST', `/api/sys-releases/${rel}/executors/6/notify`, adminTok);
    assert.strictEqual(r2.status, 200, `[6m-2]期望 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.dry_run, false, '[6m-2]笔误值不算 on → dry_run=false（按真发处理）');
    assert.strictEqual(sendCallCount, before2 + 1, '[6m-2]SEND_IMPL 被调用一次（真发路径，桩内不出网，仅证明确实走了真发分支）');
    assert.ok(warnLogs.some(w => /sys_notify_dry_run/.test(w)), `[6m-2]笔误值应触发告警日志，实际 warnLogs=${JSON.stringify(warnLogs)}`);
    const row2 = await execRow(rel, 6);
    assert.strictEqual(row2.notify_status, 'sent', '[6m-2]笔误值按真发处理，仍正常落库 sent');
    ok('[6m-2] sys_notify_dry_run="ONN"（笔误）→ 仍走真发（SEND_IMPL 被调一次）且触发告警日志（fail-open 但可观测，非静默）');

    SYS_NOTIFY_DRY_RUN_CONFIG = null;   // 复位，避免影响后续分组
  }

  // [6n] MED-1/MED-2（Opus 预筛）正例覆盖：批次态闸 + 成员非空闸——此前只有 PUT executors/批次级
  //   notify-executor（L1 订正：后者已随 C4b H1 退场整体删除，这里是历史设计记录——彼时的漏网之鱼诊断
  //   与该端点后来是否还存在无关）有这两道闸，行级通知端点是漏网之鱼，本组直接证明新增的闸确实拦得住。
  {
    // [6n-1] 批次非「计划中」→ 409 RELEASE_NOT_PLANNING（与 PUT executors 闸⓿同码）
    const rel1 = await mkRelease({ title: 'C2-批次态闸' });
    const issue1 = await mkIssue({ title: 'C2-批次态闸-成员单' });
    await addIssueTo(rel1, issue1);
    const put1 = await call('PUT', `/api/sys-releases/${rel1}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put1.status, 200, `[6n-1-fixture]期望 200, got ${put1.status}`);
    await run(`UPDATE sys_releases SET status = '已发布', released_at = datetime('now','localtime') WHERE id = ?`, [rel1]);
    const before1 = await execRow(rel1, 5);
    const r1 = await call('POST', `/api/sys-releases/${rel1}/executors/5/notify`, adminTok);
    assert.strictEqual(r1.status, 409, `[6n-1]期望 409, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'RELEASE_NOT_PLANNING', `[6n-1]code 应为 RELEASE_NOT_PLANNING，实际 ${r1.body.code}`);
    const after1 = await execRow(rel1, 5);
    assert.deepStrictEqual(after1, before1, '[6n-1]零副作用：行原样未变');
    ok('[6n-1] MED-1：批次非「计划中」→ 409 RELEASE_NOT_PLANNING，零副作用（与 PUT executors 闸⓿同码，此前行级通知端点漏了这道闸）');

    // [6n-2] 批次内无待上线单（零成员）→ 409 RELEASE_EMPTY（与批次级 preemptReleaseNotifySend 的 D 检查
    //   历史同码——该函数已随 C4b H1 退场整体删除，等价不变量现由行级 preemptReleaseExecutorNotifySend
    //   自己的成员非空检查独立承担，见 index.js 该函数内 MED-2 注释）
    const rel2 = await mkRelease({ title: 'C2-成员非空闸' });
    // 刻意不 addIssueTo：保持零成员——PUT executors 本身不检查成员数，能正常建执行人行，正好构造出
    //   "有执行人但批次是空的"这个 fail-closed 要防的异常态。
    const put2 = await call('PUT', `/api/sys-releases/${rel2}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put2.status, 200, `[6n-2-fixture]期望 200, got ${put2.status}`);
    const before2 = await execRow(rel2, 5);
    const r2 = await call('POST', `/api/sys-releases/${rel2}/executors/5/notify`, adminTok);
    assert.strictEqual(r2.status, 409, `[6n-2]期望 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'RELEASE_EMPTY', `[6n-2]code 应为 RELEASE_EMPTY，实际 ${r2.body.code}`);
    const after2 = await execRow(rel2, 5);
    assert.deepStrictEqual(after2, before2, '[6n-2]零副作用：行原样未变');
    ok('[6n-2] MED-2：批次内无待上线单（零成员）→ 409 RELEASE_EMPTY，零副作用（fail-closed，正常流程不可达，防的是异常态）');
  }

  // [6o] 300-M1（codex）失败注入：writeExecutorNotifyTimelineSafe 内部 members 查询本身失败 → 只
  //   log+return false，不上抛——写回 CAS 已经提交的发送结果不该因为紧随其后的 timeline 读失败而
  //   变成 500 / 丢失。用 dbAllAsync 精确按 SQL 文本单发注入，不影响其它查询。
  {
    const rel = await mkRelease({ title: 'C2-M1失败注入' });
    const issue = await mkIssue({ title: 'C2-M1失败注入-成员单' });
    await addIssueTo(rel, issue);
    const put = await call('PUT', `/api/sys-releases/${rel}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put.status, 200, `[6o-fixture]期望 200, got ${put.status}`);
    DB_ALL_FAIL_ON = 'SELECT id FROM sys_issues WHERE release_id';
    let r;
    try {
      r = await call('POST', `/api/sys-releases/${rel}/executors/5/notify`, adminTok);
    } finally {
      DB_ALL_FAIL_ON = null;   // 兜底复位：防止万一没触发而误伤后续用例（allTestable 本身也是单发自清）
    }
    assert.strictEqual(r.status, 200, `[6o]members 查询失败不应让整个请求变 500（300-M1 修复目的）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.notify_status, 'sent', '[6o]写回 CAS 已提交的发送结果不受 timeline 查询失败牵连，仍是 sent');
    assert.strictEqual(r.body.timeline_failed, true, '[6o]响应带 timeline_failed:true（timeline 确实没写成）');
    const row = await execRow(rel, 5);
    assert.strictEqual(row.notify_status, 'sent', '[6o]落库 notify_status=sent（CAS 事实不受影响，写回事务与 timeline 事务已彻底分离）');
    const tl = await notifyTimelineRows(rel);
    assert.strictEqual(tl.length, 0, '[6o]timeline 零行落库（members 查询在真正 INSERT 之前就失败了，不存在半条记录）');
    ok('[6o] 300-M1：writeExecutorNotifyTimelineSafe 内部 members 查询失败 → 只 log+return false 不上抛，发送结果仍 200/sent 不受牵连，响应带 timeline_failed:true，timeline 零行落库');
  }

  // ═══ [7] GET /sys-releases/:id/executors/:userId/read-status（行级已读，改造 #9） ═══
  {
    // [7a] cached 正例：message_key + read_at 均已固化 → 直接返回缓存，不外呼
    //   ⭐ L6（Opus 预筛）：fixture 的 read_at 预置值改用 SQL-side datetime('now','localtime') 同款
    //   格式（'YYYY-MM-DD HH:MM:SS'，非 toLocaleString 的 '2026/2/1 10:00:00' 斜杠格式）——对齐生产
    //   代码写入路径改用 SQL 侧计算后，真实落库值就长这个样子，fixture 断言真实写入格式而非旧格式。
    const rel7a = await mkRelease({ title: 'C2-已读-cached正例' });
    const put7a = await call('PUT', `/api/sys-releases/${rel7a}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put7a.status, 200, `[7a-fixture]期望 200, got ${put7a.status}`);
    const row7a = await execRow(rel7a, 5);
    await run(`UPDATE sys_release_executors SET notify_message_key='mk-cached', read_at='2026-02-01 10:00:00' WHERE id=?`, [row7a.id]);
    const r7a = await call('GET', `/api/sys-releases/${rel7a}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7a.status, 200, `[7a]期望 200, got ${r7a.status} ${JSON.stringify(r7a.body)}`);
    assert.strictEqual(r7a.body.read, true, '[7a]read=true');
    assert.strictEqual(r7a.body.cached, true, '[7a]cached=true（不外呼钉钉）');
    assert.strictEqual(r7a.body.read_at, '2026-02-01 10:00:00', '[7a]read_at 原样返回');
    assert.strictEqual(r7a.body.read_status, 'read', '[7a]300-L2：cached 分支同样带稳定枚举 read_status=read');
    ok('[7a] message_key+read_at 均已固化 → cached 快路径直接返回，不外呼钉钉，read_status=read（300-L2 枚举统一）');

    // [7b] no_message_key：从未通知过（message_key 为空）→ 明确不可查语义，非报错
    const rel7b = await mkRelease({ title: 'C2-已读-no_message_key' });
    const put7b = await call('PUT', `/api/sys-releases/${rel7b}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put7b.status, 200, `[7b-fixture]期望 200, got ${put7b.status}`);
    const r7b = await call('GET', `/api/sys-releases/${rel7b}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7b.status, 200, `[7b]期望 200(非报错), got ${r7b.status} ${JSON.stringify(r7b.body)}`);
    assert.strictEqual(r7b.body.read, false, '[7b]read=false');
    assert.strictEqual(r7b.body.read_status, 'no_message_key', '[7b]read_status=no_message_key（明确不可查，非报错）');
    ok('[7b] 从未通知（message_key 为空）→ 200 read_status=no_message_key，明确不可查语义而非报错');

    // [7c] 非在册 404（未加入 / 已软删移除 两种，同 [6f] 手法）
    const rel7c = await mkRelease({ title: 'C2-已读-非在册404' });
    const r7c1 = await call('GET', `/api/sys-releases/${rel7c}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7c1.status, 404, `[7c-1]期望 404, got ${r7c1.status}`);
    assert.strictEqual(r7c1.body.code, 'EXECUTOR_NOT_ACTIVE', `[7c-1]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r7c1.body.code}`);
    const put7c1 = await call('PUT', `/api/sys-releases/${rel7c}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put7c1.status, 200, `[7c-2-fixture1]期望 200, got ${put7c1.status}`);
    const put7c2 = await call('PUT', `/api/sys-releases/${rel7c}/executors`, adminTok, { user_ids: [6, 7] });   // 移除 5
    assert.strictEqual(put7c2.status, 200, `[7c-2-fixture2]期望 200, got ${put7c2.status}`);
    const r7c2 = await call('GET', `/api/sys-releases/${rel7c}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7c2.status, 404, `[7c-2]期望 404, got ${r7c2.status}`);
    assert.strictEqual(r7c2.body.code, 'EXECUTOR_NOT_ACTIVE', `[7c-2]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r7c2.body.code}`);
    ok('[7c] 非在册（未加入/已软删移除）→ 404 EXECUTOR_NOT_ACTIVE');

    // [7d] 未固化（有 message_key 但无 read_at）+ 本地空钉钉配置 → 500 NO_DINGTALK_CONFIG fail-safe
    //   （历史上与批次级 executor-read-status 既有 ⭐(d) 覆盖上限一致：本地无凭证，深查分支到此为止——见本
    //   文件 [问题/待裁定] 段说明，非本次引入的缺口。L1 订正：该批次级路由已随 C4b H1 退场整体删除，本
    //   覆盖上限现已是行级端点独立的性质，不再有可比对的批次级对照组）
    const rel7d = await mkRelease({ title: 'C2-已读-未固化fail-safe' });
    const issue7d = await mkIssue({ title: 'C2-已读-成员单' });
    await addIssueTo(rel7d, issue7d);
    const put7d = await call('PUT', `/api/sys-releases/${rel7d}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put7d.status, 200, `[7d-fixture]期望 200, got ${put7d.status}`);
    const r7dNotify = await call('POST', `/api/sys-releases/${rel7d}/executors/5/notify`, adminTok);
    assert.strictEqual(r7dNotify.status, 200, `[7d-fixture]通知期望 200, got ${r7dNotify.status}`);
    const r7d = await call('GET', `/api/sys-releases/${rel7d}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7d.status, 500, `[7d]期望 500(fail-safe), got ${r7d.status} ${JSON.stringify(r7d.body)}`);
    assert.strictEqual(r7d.body.code, 'NO_DINGTALK_CONFIG', `[7d]code 应为 NO_DINGTALK_CONFIG，实际 ${r7d.body.code}`);
    ok('[7d] message_key 已有但未固化(read_at 为空) + 本地空钉钉配置 → 500 NO_DINGTALK_CONFIG fail-safe（历史上与批次级 executor-read-status 既有覆盖上限一致，该批次级路由已随 C4b 删除，现为行级独立性质）');

    // [7e] 非 admin 403
    const r7e = await call('GET', `/api/sys-releases/${rel7a}/executors/5/read-status`, dev5Tok);
    assert.strictEqual(r7e.status, 403, `[7e]期望 403, got ${r7e.status}`);
    ok('[7e] 非 admin 调 GET read-status → 403');

    // [7f] HIGH-1 子项（Opus 预筛）：message_key 前缀 dryrun-（演练发送产生的伪造 key）→ 200
    //   read_status=dry_run，短路必须发生在钉钉配置检查之前——本用例的钉钉配置留空（同本文件其余组），
    //   若短路缺失或位置放错（放到配置检查之后），本行会像 [7d] 一样落 500 NO_DINGTALK_CONFIG；落
    //   200+dry_run 才能证明短路确实在配置检查之前拦下了，不依赖"本地凭证恰好没配"这个偶然条件
    //   （L1 订正：本地实测三项凭证俱全，配置检查本身挡不住这条路径，必须靠 dry-run 前缀主动短路）。
    const rel7f = await mkRelease({ title: 'C2-已读-dryrun演练' });
    const put7f = await call('PUT', `/api/sys-releases/${rel7f}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put7f.status, 200, `[7f-fixture]期望 200, got ${put7f.status}`);
    const row7f = await execRow(rel7f, 5);
    await run(`UPDATE sys_release_executors SET notify_message_key='dryrun-1234567890' WHERE id=?`, [row7f.id]);
    const r7f = await call('GET', `/api/sys-releases/${rel7f}/executors/5/read-status`, adminTok);
    assert.strictEqual(r7f.status, 200, `[7f]期望 200(非 500 NO_DINGTALK_CONFIG——证明短路发生在配置检查之前), got ${r7f.status} ${JSON.stringify(r7f.body)}`);
    assert.strictEqual(r7f.body.read_status, 'dry_run', `[7f]read_status 应为 dry_run，实际 ${JSON.stringify(r7f.body)}`);
    assert.strictEqual(r7f.body.read, false, '[7f]read=false（演练行无法判断真实已读状态）');
    ok('[7f] message_key 前缀 dryrun-（演练行）→ 200 read_status=dry_run，短路发生在钉钉配置检查之前，不外呼钉钉（HIGH-1 子项）');
  }

  // ═══ [8] POST /sys-releases/:id/execute（C3：确认我这一份 + R-GATE，方案 §4.3 全文）═══
  //   行级 CAS + 幂等三分诊（判序：done 优先于通知态）+ R-GATE（在册≥1∧无pending，决策 7 三修下限 2→1）
  //   + 发布失败整体回滚 + 中心守卫（actor 在册∧人数≥1∧全员 done，绝不加"全员 sent"检查）。
  {
    // [8a] 幂等三分诊①：行不存在/已软删/id 不匹配 → 403 EXECUTOR_NOT_ACTIVE（两个子场景：从未存在的
    //   row_id；曾存在但已被 PUT executors 换人软删的旧 row_id）。
    const rel8a = await mkRelease({ title: 'C3-execute-行不存在' });
    const issue8a = await mkIssue({ title: 'C3-execute-8a-成员单' });
    await addIssueTo(rel8a, issue8a);
    const put8a = await call('PUT', `/api/sys-releases/${rel8a}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put8a.status, 200, `[8a-fixture]期望 200, got ${put8a.status}`);
    const r8a1 = await call('POST', `/api/sys-releases/${rel8a}/execute`, dev5Tok, { release_note: 'x', executor_row_id: 999999 });
    assert.strictEqual(r8a1.status, 403, `[8a-1]期望 403, got ${r8a1.status} ${JSON.stringify(r8a1.body)}`);
    assert.strictEqual(r8a1.body.code, 'EXECUTOR_NOT_ACTIVE', `[8a-1]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r8a1.body.code}`);
    const row5_8a = await execRow(rel8a, 5);
    const put8a2 = await call('PUT', `/api/sys-releases/${rel8a}/executors`, adminTok, { user_ids: [6, 7] });   // 移除 5（软删旧行）
    assert.strictEqual(put8a2.status, 200, `[8a-fixture2]期望 200, got ${put8a2.status}`);
    const r8a2 = await call('POST', `/api/sys-releases/${rel8a}/execute`, dev5Tok, { release_note: 'x', executor_row_id: row5_8a.id });
    assert.strictEqual(r8a2.status, 403, `[8a-2]期望 403, got ${r8a2.status} ${JSON.stringify(r8a2.body)}`);
    assert.strictEqual(r8a2.body.code, 'EXECUTOR_NOT_ACTIVE', `[8a-2]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r8a2.body.code}`);
    ok('[8a] 幂等三分诊①：executor_row_id 从未存在 / 曾存在但已被换人软删 → 均 403 EXECUTOR_NOT_ACTIVE');

    // [8b] 缺 executor_row_id → 400 EXECUTOR_ROW_ID_REQUIRED（纯输入面校验，早于任何 DB 访问）。
    const rel8b = await mkRelease({ title: 'C3-execute-缺rowid' });
    const r8b = await call('POST', `/api/sys-releases/${rel8b}/execute`, dev5Tok, { release_note: 'x' });
    assert.strictEqual(r8b.status, 400, `[8b]期望 400, got ${r8b.status} ${JSON.stringify(r8b.body)}`);
    assert.strictEqual(r8b.body.code, 'EXECUTOR_ROW_ID_REQUIRED', `[8b]code 应为 EXECUTOR_ROW_ID_REQUIRED，实际 ${r8b.body.code}`);
    ok('[8b] 缺 executor_row_id → 400 EXECUTOR_ROW_ID_REQUIRED（不做"服务端自己查一行"的兜底，§4.3 定稿明文）');

    // [8c] 非本人行（冒用他人 row_id）→ 403 EXECUTOR_NOT_ACTIVE，零副作用。
    const rel8c = await mkRelease({ title: 'C3-execute-非本人' });
    const issue8c = await mkIssue({ title: 'C3-execute-8c-成员单' });
    await addIssueTo(rel8c, issue8c);
    const put8c = await call('PUT', `/api/sys-releases/${rel8c}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put8c.status, 200, `[8c-fixture]期望 200, got ${put8c.status}`);
    const row6_8c = await execRow(rel8c, 6);
    const r8c = await call('POST', `/api/sys-releases/${rel8c}/execute`, dev5Tok, { release_note: 'x', executor_row_id: row6_8c.id });
    assert.strictEqual(r8c.status, 403, `[8c]期望 403, got ${r8c.status} ${JSON.stringify(r8c.body)}`);
    assert.strictEqual(r8c.body.code, 'EXECUTOR_NOT_ACTIVE', `[8c]code 应为 EXECUTOR_NOT_ACTIVE（CAS 的 user_id=actor.id 条件天然把"这行不是你的"排除在查询之外），实际 ${r8c.body.code}`);
    const row6After8c = await execRow(rel8c, 6);
    assert.strictEqual(row6After8c.exec_status, 'pending', '[8c]零副作用：6 的行未被冒用者动过');
    ok('[8c] 非本人行（dev5 冒用 dev6 的 row_id）→ 403 EXECUTOR_NOT_ACTIVE，零副作用');

    // [8d] notify_status !== 'sent' → 409 NOTIFY_NOT_SENT（幂等三分诊③）。
    const rel8d = await mkRelease({ title: 'C3-execute-未通知' });
    const issue8d = await mkIssue({ title: 'C3-execute-8d-成员单' });
    await addIssueTo(rel8d, issue8d);
    const put8d = await call('PUT', `/api/sys-releases/${rel8d}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put8d.status, 200, `[8d-fixture]期望 200, got ${put8d.status}`);
    const row5_8d = await execRow(rel8d, 5);
    const r8d = await call('POST', `/api/sys-releases/${rel8d}/execute`, dev5Tok, { release_note: 'x', executor_row_id: row5_8d.id });
    assert.strictEqual(r8d.status, 409, `[8d]期望 409, got ${r8d.status} ${JSON.stringify(r8d.body)}`);
    assert.strictEqual(r8d.body.code, 'NOTIFY_NOT_SENT', `[8d]code 应为 NOTIFY_NOT_SENT，实际 ${r8d.body.code}`);
    ok('[8d] notify_status≠sent（仍 not_sent）→ 409 NOTIFY_NOT_SENT（幂等三分诊③）');

    // [8r] 未来上线日期执行闸（2026-08-27 用户拍板）：planned_date 在未来 → 409 RELEASE_DATE_NOT_REACHED
    //   且行保持 pending 零副作用；逾期/当日均放行（`>` 严格比较）；NULL 不拦——由本组其余全部用例
    //   隐式覆盖（夹具默认不设 planned_date 而 execute 正常走到各自分诊，即"空日期不拦"的既有证明）。
    const rel8r = await mkRelease({ title: 'C3-execute-8r-未来日期闸' });
    const issue8r = await mkIssue({ title: 'C3-execute-8r-成员单' });
    await addIssueTo(rel8r, issue8r);
    await mkCompleteRoster(issue8r);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`,
      [rel8r]
    );
    const row5_8r = await execRow(rel8r, 5);
    await run(`UPDATE sys_releases SET planned_date=date('now','localtime','+2 day') WHERE id=?`, [rel8r]);
    const r8r1 = await call('POST', `/api/sys-releases/${rel8r}/execute`, dev5Tok, { release_note: 'x', executor_row_id: row5_8r.id });
    assert.strictEqual(r8r1.status, 409, `[8r-1]期望 409, got ${r8r1.status} ${JSON.stringify(r8r1.body)}`);
    assert.strictEqual(r8r1.body.code, 'RELEASE_DATE_NOT_REACHED', `[8r-1]code 应为 RELEASE_DATE_NOT_REACHED，实际 ${r8r1.body.code}`);
    const row5_8rMid = await get(`SELECT exec_status FROM sys_release_executors WHERE id=?`, [row5_8r.id]);
    assert.strictEqual(row5_8rMid.exec_status, 'pending', '[8r-1]零副作用：被日期闸拦下后行仍 pending，未被烧成 done');
    // 逾期（计划日在过去）不拦：闸只拦"未到"，逾期恰恰该放行去执行
    await run(`UPDATE sys_releases SET planned_date=date('now','localtime','-2 day') WHERE id=?`, [rel8r]);
    const r8r2 = await call('POST', `/api/sys-releases/${rel8r}/execute`, dev5Tok, { release_note: '逾期补执行', executor_row_id: row5_8r.id });
    assert.strictEqual(r8r2.status, 200, `[8r-2]期望 200（逾期不拦）, got ${r8r2.status} ${JSON.stringify(r8r2.body)}`);
    assert.strictEqual(r8r2.body.released, true, '[8r-2]逾期批次执行成功并真实触发发布');
    // 当日可执行（`>` 严格比较，同日不算"未到"）——另建同构单人批次设 planned_date=今天 → 200
    const rel8s = await mkRelease({ title: 'C3-execute-8s-当日可执行' });
    const issue8s = await mkIssue({ title: 'C3-execute-8s-成员单' });
    await addIssueTo(rel8s, issue8s);
    await mkCompleteRoster(issue8s);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`,
      [rel8s]
    );
    const row5_8s = await execRow(rel8s, 5);
    await run(`UPDATE sys_releases SET planned_date=date('now','localtime') WHERE id=?`, [rel8s]);
    const r8s = await call('POST', `/api/sys-releases/${rel8s}/execute`, dev5Tok, { release_note: '当日执行', executor_row_id: row5_8s.id });
    assert.strictEqual(r8s.status, 200, `[8s]期望 200（当日可执行）, got ${r8s.status} ${JSON.stringify(r8s.body)}`);
    assert.strictEqual(r8s.body.released, true, '[8s]当日批次执行成功并真实触发发布');
    // [8t] 脏值 fail-open（codex 484 HIGH-1）：形似 YYYY-MM-DD 但非真实日历日（2099-13-99 通过正则、
    //   字符串比较大于今天）——闸必须经 round-trip 校验放行，否则脏数据把批次永久锁死。
    const rel8t = await mkRelease({ title: 'C3-execute-8t-脏日期failopen' });
    const issue8t = await mkIssue({ title: 'C3-execute-8t-成员单' });
    await addIssueTo(rel8t, issue8t);
    await mkCompleteRoster(issue8t);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`,
      [rel8t]
    );
    const row5_8t = await execRow(rel8t, 5);
    await run(`UPDATE sys_releases SET planned_date='2099-13-99' WHERE id=?`, [rel8t]);
    const r8t = await call('POST', `/api/sys-releases/${rel8t}/execute`, dev5Tok, { release_note: '脏日期放行', executor_row_id: row5_8t.id });
    assert.strictEqual(r8t.status, 200, `[8t]期望 200（形似未来的非法日历日 fail-open 放行）, got ${r8t.status} ${JSON.stringify(r8t.body)}`);
    assert.strictEqual(r8t.body.released, true, '[8t]脏日期批次执行成功——闸未被正则外形骗住（round-trip 校验生效）');
    ok('[8r/8s/8t] 未来日期闸：未来 409 RELEASE_DATE_NOT_REACHED 零副作用 / 逾期放行 / 当日放行 / 形似脏值 fail-open 放行（空日期由其余用例隐式覆盖）');

    // [8i]（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订）：MED-1/302-M1 那道"CAS 之前的在册人数闸"
    //   已随下限 2→1 整体删除（见 execute 路由头部注释）——本组原断言"单人在册批次 execute → 409
    //   EXECUTORS_TOO_FEW"钉的正是那道已删除的闸，红灯诊断=断言过时非实现错（[[feedback_test_assertion_
    //   self_error]]），反转为单人全链正例：单人 sent+pending execute（带 release_note，本人即"最后一人"）
    //   → 200 + released:true，真正走完发布。夹具补 mkCompleteRoster——真实触发 _publishReleaseCoreInTxn
    //   需要过 RELEASE 中心守卫的开发名单在册完成态门。
    const rel8i = await mkRelease({ title: 'C3-execute-8i-单人全链正例' });
    const issue8i = await mkIssue({ title: 'C3-execute-8i-成员单' });
    await addIssueTo(rel8i, issue8i);
    await mkCompleteRoster(issue8i);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 'pending', 1, '管理员')`,
      [rel8i]
    );
    const row5_8i = await execRow(rel8i, 5);
    const r8i = await call('POST', `/api/sys-releases/${rel8i}/execute`, dev5Tok, { release_note: '单人全链验收', executor_row_id: row5_8i.id });
    assert.strictEqual(r8i.status, 200, `[8i]期望 200, got ${r8i.status} ${JSON.stringify(r8i.body)}`);
    assert.strictEqual(r8i.body.released, true, '[8i]released=true（单人批次·唯一执行人确认即满足 R-GATE ≥1∧无pending，真正触发发布）');
    assert.ok(Array.isArray(r8i.body.released_issue_ids) && r8i.body.released_issue_ids.includes(issue8i), '[8i]released_issue_ids 含本批次成员单');
    const row5_8iAfter = await get(`SELECT exec_status FROM sys_release_executors WHERE id=?`, [row5_8i.id]);
    assert.strictEqual(row5_8iAfter.exec_status, 'done', '[8i]行真实落库为 done');
    const rel8iAfter = await get(`SELECT status, release_note FROM sys_releases WHERE id=?`, [rel8i]);
    assert.strictEqual(rel8iAfter.status, '已发布', '[8i]批次真实落库为「已发布」');
    assert.strictEqual(rel8iAfter.release_note, '单人全链验收', '[8i]release_note 正确写入');
    ok('[8i]（反转·决策 7 三修）单人在册批次 sent+pending，带 release_note execute → 200 + released:true，真正发布（原"409 人数闸拦截"断言已随人数闸删除过时）');

    // [8m]（复核语义不变，注释随决策 7 三修更正引用）：已发布批次+单条 done 存量行重复 execute →
    //   200 already:true+released:true——这条断言值本身与人数闸存废无关（该断言测的是"done 幂等分诊②
    //   优先于任何后续判定"这条独立不变量，不依赖人数闸是否存在）。⚠️ 夹具背景已更正：原注释"正常业务
    //   流程走不到，PUT executors 闸②不允许新建单人批次"已随决策 7 三修（下限 2→1）过时——单人批次现在
    //   是 PUT executors 闸②直接放行的正常形态（见 [2-②正]），不再是"只能纯 SQL 直造"的历史孤例；
    //   本组仍保留纯 SQL 直造已发布态，是为了精确锁定"已发布+done"这一具体夹具组合，非必须绕开某道闸。
    const rel8m = await mkRelease({ title: 'C3-execute-8m-迁移单人done存量' });
    const issue8m = await mkIssue({ title: 'C3-execute-8m-成员单' });
    await addIssueTo(rel8m, issue8m);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, exec_status, executed_at, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'sent', datetime('now','localtime'), 'done', datetime('now','localtime'), 1, '管理员')`,
      [rel8m]
    );
    await run(`UPDATE sys_releases SET status='已发布' WHERE id=?`, [rel8m]);
    const row5_8m = await execRow(rel8m, 5);
    const r8m = await call('POST', `/api/sys-releases/${rel8m}/execute`, dev5Tok, { executor_row_id: row5_8m.id });
    assert.strictEqual(r8m.status, 200, `[8m]期望 200, got ${r8m.status} ${JSON.stringify(r8m.body)}`);
    assert.strictEqual(r8m.body.my_status, 'done', '[8m]my_status=done');
    assert.strictEqual(r8m.body.already, true, '[8m]already=true（幂等分诊②，不被人数闸误伤）');
    assert.strictEqual(r8m.body.released, true, '[8m]released=true（302-L1 当场重算，批次确实已发布）');
    assert.strictEqual(r8m.body.pending_count, 0, '[8m]pending_count=0（在册仅此一行，且已 done）');
    ok('[8m]（复核语义不变）已发布批次+单条 done 存量行重复 execute → 200 already:true+released:true（done 幂等分诊②独立成立，不依赖人数闸存废）');

    // [8o]（反转·决策 7 三修）：原断言"计划中单人 pending 且从未通知 execute → 409 EXECUTORS_TOO_FEW
    //   （人数闸优先于 NOTIFY_NOT_SENT）"钉的正是已删除的人数闸判序，随之过时。人数闸删除后，这一行
    //   会直接落到 CAS 自身的五条件判定（`notify_status='sent'` 不满足）→ 幂等三分诊③ NOTIFY_NOT_SENT——
    //   反转为验证这一点：单人批次不会因为"人数够不够"被拦，但仍会正确因为"还没收到通知"被拦（两类
    //   拦截原因不同，不能因为人数闸删了就连带把通知态校验也弄没了）。
    const rel8o = await mkRelease({ title: 'C3-execute-8o-单人pending未通知' });
    const issue8o = await mkIssue({ title: 'C3-execute-8o-成员单' });
    await addIssueTo(rel8o, issue8o);
    await run(
      `INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, exec_status, added_by, added_by_name)
       VALUES (?, 5, '开发甲', 'not_sent', 'pending', 1, '管理员')`,
      [rel8o]
    );
    const row5_8o = await execRow(rel8o, 5);
    const r8o = await call('POST', `/api/sys-releases/${rel8o}/execute`, dev5Tok, { executor_row_id: row5_8o.id });
    assert.strictEqual(r8o.status, 409, `[8o]期望 409, got ${r8o.status} ${JSON.stringify(r8o.body)}`);
    assert.strictEqual(r8o.body.code, 'NOTIFY_NOT_SENT', `[8o]code 应为 NOTIFY_NOT_SENT（人数闸已删除，落到 CAS 自身通知态条件），实际 ${r8o.body.code}`);
    const row5_8oAfter = await execRow(rel8o, 5);
    assert.strictEqual(row5_8oAfter.exec_status, 'pending', '[8o]行未被烧成 done');
    assert.strictEqual(row5_8oAfter.notify_status, 'not_sent', '[8o]notify_status 未受影响（仍 not_sent，未被顺带改动）');
    ok('[8o]（反转·决策 7 三修）计划中单人 pending 且从未通知（not_sent）execute → 409 NOTIFY_NOT_SENT（原"人数闸优先"判序已随该闸删除过时，现落 CAS 自身通知态条件）');

    // [8e]-[8g] 链路：3 人批次——R-GATE 未满足 pending_count 语义 → 幂等再确认 → 最后一人+release_note 翻已发布。
    const rel8efg = await mkRelease({ title: 'C3-execute-8efg链路' });
    const issue8efg = await mkIssue({ title: 'C3-execute-8efg-成员单' });
    await mkCompleteRoster(issue8efg);   // RELEASE 中心守卫要求成员 issue 自己的开发 roster 非空且全完成态
    await addIssueTo(rel8efg, issue8efg);
    const put8efg = await call('PUT', `/api/sys-releases/${rel8efg}/executors`, adminTok, { user_ids: [5, 6, 7] });
    assert.strictEqual(put8efg.status, 200, `[8efg-fixture]期望 200, got ${put8efg.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8efg]);
    const row5_8efg = await execRow(rel8efg, 5);
    const row6_8efg = await execRow(rel8efg, 6);
    const row7_8efg = await execRow(rel8efg, 7);

    // [8e] R-GATE 未满足：5 确认后还差 6,7 两人。M4 断言缺口（Opus 预筛）：body 里顺带塞一个 release_note——
    //   非最后一人时这两参数即使传了也不使用（不校验也不落库），本行同时验证"塞了不该生效的说明不会误
    //   触发发布也不会被静默落库"这条设计承诺的另一半（只测过不传的路径，没测过"传了但应被忽略"）。
    const r8e = await call('POST', `/api/sys-releases/${rel8efg}/execute`, dev5Tok, { executor_row_id: row5_8efg.id, release_note: '非最后一人不该生效的说明' });
    assert.strictEqual(r8e.status, 200, `[8e]期望 200, got ${r8e.status} ${JSON.stringify(r8e.body)}`);
    assert.strictEqual(r8e.body.my_status, 'done', '[8e]my_status=done');
    assert.strictEqual(r8e.body.pending_count, 2, `[8e]pending_count 应为 2（6,7 未确认），实际 ${r8e.body.pending_count}`);
    assert.strictEqual(r8e.body.released, false, '[8e]released=false（R-GATE 未满足，批次仍计划中）');
    const tl8e = await notifyTimelineRowsByCode(rel8efg, 'release_executor_done');
    assert.strictEqual(tl8e.length, 1, '[8e]"确认完成"timeline 已写 1 条');
    assert.ok(/开发甲.*确认完成.*还差2人/.test(tl8e[0].summary), `[8e]timeline 文案含"确认完成"+"还差2人"，实际 ${tl8e[0].summary}`);
    const relNoteAfter8e = await get(`SELECT release_note FROM sys_releases WHERE id=?`, [rel8efg]);
    assert.strictEqual(relNoteAfter8e.release_note, null, '[8e] M4：非最后一人即便传了 release_note 也不落库（R-GATE 未满足，_publishReleaseCoreInTxn 未被调用，参数被静默忽略非误用）');
    ok('[8e] R-GATE 未满足：5 确认后 pending_count=2/released=false，timeline 写"确认完成（还差 N 人）"，顺带传的 release_note 未落库（M4）');

    // [8f] 幂等三分诊②：5 再次用同一 row_id 确认 → 200 幂等成功，不重复写 timeline。
    const r8f = await call('POST', `/api/sys-releases/${rel8efg}/execute`, dev5Tok, { executor_row_id: row5_8efg.id });
    assert.strictEqual(r8f.status, 200, `[8f]期望 200, got ${r8f.status} ${JSON.stringify(r8f.body)}`);
    assert.strictEqual(r8f.body.my_status, 'done', '[8f]my_status=done');
    assert.strictEqual(r8f.body.already, true, '[8f]already=true（幂等，非新确认）');
    assert.strictEqual(r8f.body.pending_count, 2, '[8f]pending_count 仍为 2（未变）');
    assert.strictEqual(r8f.body.released, false, '[8f]released=false（批次仍未发布）');
    const tl8f = await notifyTimelineRowsByCode(rel8efg, 'release_executor_done');
    assert.strictEqual(tl8f.length, 1, '[8f]幂等确认零副作用：timeline 计数不增（纯读回滚分支，不写入）');
    ok('[8f] 幂等三分诊②：exec_status=done 时再次确认 → 200 幂等成功（already=true），timeline 不重复写');

    // [8g] 最后一人（7）+ release_note → 真正触发发布。
    // 303-M2（Opus 对抗审）：中间预确认调用不许静默吞——断言 6 号真成功且未提前触发发布（released=false，
    //   还差 7 未确认），失败时带上下文抛错方便定位。
    const r8gPre6 = await call('POST', `/api/sys-releases/${rel8efg}/execute`, dev6Tok, { executor_row_id: row6_8efg.id });   // 6 确认，还差 7
    if (r8gPre6.status !== 200 || r8gPre6.body.released !== false) {
      throw new Error(`[8g-pre] 6号预确认异常：status=${r8gPre6.status} body=${JSON.stringify(r8gPre6.body)}`);
    }
    const r8g = await call('POST', `/api/sys-releases/${rel8efg}/execute`, dev7Tok, { release_note: '8efg链路真发布', executor_row_id: row7_8efg.id });
    assert.strictEqual(r8g.status, 200, `[8g]期望 200, got ${r8g.status} ${JSON.stringify(r8g.body)}`);
    assert.strictEqual(r8g.body.released, true, '[8g]released=true（最后一人触发真正发布）');
    assert.strictEqual(r8g.body.status, '已上线', '[8g]status=已上线');
    assert.strictEqual(r8g.body.pending_count, 0, '[8g]pending_count=0');
    assert.deepStrictEqual(r8g.body.released_issue_ids, [issue8efg], '[8g]released_issue_ids 恰为本批次成员');
    const relRow8g = await get(`SELECT status, release_note FROM sys_releases WHERE id=?`, [rel8efg]);
    assert.strictEqual(relRow8g.status, '已发布', '[8g]批次真实转已发布');
    assert.strictEqual(relRow8g.release_note, '8efg链路真发布', '[8g]release_note 落库');
    ok('[8g] 最后一人（7）+ release_note → 真正触发发布：released=true/status=已上线/released_issue_ids 正确/批次转已发布');

    // [8h] RELEASE_NOTE_REQUIRED 补填重试链 + 发布失败回滚 done（本人行仍 pending，未留半截态）。
    const rel8h = await mkRelease({ title: 'C3-execute-8h补填重试' });
    const issue8h = await mkIssue({ title: 'C3-execute-8h-成员单' });
    await mkCompleteRoster(issue8h);
    await addIssueTo(rel8h, issue8h);
    const put8h = await call('PUT', `/api/sys-releases/${rel8h}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put8h.status, 200, `[8h-fixture]期望 200, got ${put8h.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8h]);
    const row5_8h = await execRow(rel8h, 5);
    const row6_8h = await execRow(rel8h, 6);
    // 303-M2：中间预确认不许静默吞——断言 6 号真成功且未提前触发发布。
    const r8hPre6 = await call('POST', `/api/sys-releases/${rel8h}/execute`, dev6Tok, { executor_row_id: row6_8h.id });   // 6 先确认，还差 5
    if (r8hPre6.status !== 200 || r8hPre6.body.released !== false) {
      throw new Error(`[8h-pre] 6号预确认异常：status=${r8hPre6.status} body=${JSON.stringify(r8hPre6.body)}`);
    }
    // 5 最后确认但不带 release_note → R-GATE 满足触发 _publishReleaseCoreInTxn，内部闸门③校验非空失败 → 整体回滚。
    const r8h1 = await call('POST', `/api/sys-releases/${rel8h}/execute`, dev5Tok, { executor_row_id: row5_8h.id });
    assert.strictEqual(r8h1.status, 400, `[8h-1]期望 400, got ${r8h1.status} ${JSON.stringify(r8h1.body)}`);
    assert.strictEqual(r8h1.body.code, 'RELEASE_NOTE_REQUIRED', `[8h-1]code 应为 RELEASE_NOTE_REQUIRED，实际 ${r8h1.body.code}`);
    const row5After8h1 = await execRow(rel8h, 5);
    assert.strictEqual(row5After8h1.exec_status, 'pending', '[8h-1]发布失败整体回滚：本人 done 一并撤销，行仍 pending（不允许"我确认了、批次没发布、我却是 done"的半截态）');
    const relAfter8h1 = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel8h]);
    assert.strictEqual(relAfter8h1.status, '计划中', '[8h-1]批次仍计划中（未被误翻发布）');
    // 补填重试：同一 row_id 再次请求，带上合法 release_note → 200 真发布（证明 400 后不是死路，是一次补填）。
    const r8h2 = await call('POST', `/api/sys-releases/${rel8h}/execute`, dev5Tok, { release_note: '补填后的上线说明', executor_row_id: row5_8h.id });
    assert.strictEqual(r8h2.status, 200, `[8h-2]期望 200, got ${r8h2.status} ${JSON.stringify(r8h2.body)}`);
    assert.strictEqual(r8h2.body.released, true, '[8h-2]补填重试后真正发布');
    ok('[8h] RELEASE_NOTE_REQUIRED 补填重试链：最后一人漏填说明 → 400 + 发布失败整体回滚（本人行仍 pending，不留半截态）→ 同 row_id 补填重试 → 200 真发布（400 非死路）');

    // [8j] M-b 反例：某人 done 后其行被误重发失败（done+failed 组合）→ 最后一人仍能发布（中心守卫只看
    //   exec_status=done，绝不加"全员 sent"检查，v1.3·M-b 死锁教训的正面验证）。
    const rel8j = await mkRelease({ title: 'C3-execute-8j-Mb反例' });
    const issue8j = await mkIssue({ title: 'C3-execute-8j-成员单' });
    await mkCompleteRoster(issue8j);
    await addIssueTo(rel8j, issue8j);
    const put8j = await call('PUT', `/api/sys-releases/${rel8j}/executors`, adminTok, { user_ids: [5, 6, 7] });
    assert.strictEqual(put8j.status, 200, `[8j-fixture]期望 200, got ${put8j.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8j]);
    const row5_8j = await execRow(rel8j, 5);
    const row6_8j = await execRow(rel8j, 6);
    const row7_8j = await execRow(rel8j, 7);
    // 303-M2：中间预确认（5、6 两位非最后一人）不许静默吞——各自断言真成功且未提前触发发布。
    const r8jPre5 = await call('POST', `/api/sys-releases/${rel8j}/execute`, dev5Tok, { executor_row_id: row5_8j.id });
    if (r8jPre5.status !== 200 || r8jPre5.body.released !== false) {
      throw new Error(`[8j-pre] 5号预确认异常：status=${r8jPre5.status} body=${JSON.stringify(r8jPre5.body)}`);
    }
    const r8jPre6 = await call('POST', `/api/sys-releases/${rel8j}/execute`, dev6Tok, { executor_row_id: row6_8j.id });
    if (r8jPre6.status !== 200 || r8jPre6.body.released !== false) {
      throw new Error(`[8j-pre] 6号预确认异常：status=${r8jPre6.status} body=${JSON.stringify(r8jPre6.body)}`);
    }
    // 模拟"6 done 之后被 admin 误点重新通知且失败"：exec_status 不变（仍 done），notify_status 单独变 failed。
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='模拟误重发失败' WHERE id=?`, [row6_8j.id]);
    const row6After8jPre = await execRow(rel8j, 6);
    assert.strictEqual(row6After8jPre.exec_status, 'done', '[8j-fixture]6 号行确认构造成 done+failed 组合（exec_status 未受影响）');
    // MED-4（Opus 预筛）：done+failed 组合的另一半前提也上锁——不只断言 exec_status 未受影响，同时锁定
    //   notify_status 确实已被构造成 failed（不然"done+failed 组合"这个夹具意图本身没有被断言证实过）。
    assert.strictEqual(row6After8jPre.notify_status, 'failed', '[8j-fixture]notify_status 确实已被构造成 failed');
    const r8j = await call('POST', `/api/sys-releases/${rel8j}/execute`, dev7Tok, { release_note: 'M-b反例验证', executor_row_id: row7_8j.id });
    assert.strictEqual(r8j.status, 200, `[8j]期望 200(全员 done 即可，不看 notify_status), got ${r8j.status} ${JSON.stringify(r8j.body)}`);
    assert.strictEqual(r8j.body.released, true, '[8j]即便 6 号行是 done+failed 组合，7 确认后仍成功发布');
    ok('[8j] M-b 反例：done 后被误重发失败（done+failed 组合）不阻塞最后一人发布——中心守卫只看 exec_status=done，绝不加"全员 sent"检查（v1.3·M-b 死锁教训的正面验证）');

    // [8p] 303-L2（Opus 对抗审）：[8j] 的负例镜像——M-b 只豁免"已 done 者"事后被误重发失败这种脏组合，
    //   绝不豁免"最后一人自己当下就是 failed"这种情形：3 人批次 5、6 已 done，7（最后一人）自己的
    //   notify_status 被 SQL 直造成 failed（模拟通知发送失败还未重试成功，仍是 pending）→ execute →
    //   409 NOTIFY_NOT_SENT，批次不发布（锁死"done 优先于通知态"判序的精确适用范围——只对"已完成的人"
    //   生效，不能被误读成"谁的通知态都不用管了"，最后一人自身必须真是 sent）。
    const rel8p = await mkRelease({ title: 'C3-execute-8p-最后一人自身failed' });
    const issue8p = await mkIssue({ title: 'C3-execute-8p-成员单' });
    await mkCompleteRoster(issue8p);
    await addIssueTo(rel8p, issue8p);
    const put8p = await call('PUT', `/api/sys-releases/${rel8p}/executors`, adminTok, { user_ids: [5, 6, 7] });
    assert.strictEqual(put8p.status, 200, `[8p-fixture]期望 200, got ${put8p.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8p]);
    const row5_8p = await execRow(rel8p, 5);
    const row6_8p = await execRow(rel8p, 6);
    const row7_8p = await execRow(rel8p, 7);
    const r8pPre5 = await call('POST', `/api/sys-releases/${rel8p}/execute`, dev5Tok, { executor_row_id: row5_8p.id });
    assert.strictEqual(r8pPre5.status, 200, `[8p-pre]5号预确认期望 200, got ${r8pPre5.status} ${JSON.stringify(r8pPre5.body)}`);
    assert.strictEqual(r8pPre5.body.released, false, '[8p-pre]5号预确认不该提前触发发布');
    const r8pPre6 = await call('POST', `/api/sys-releases/${rel8p}/execute`, dev6Tok, { executor_row_id: row6_8p.id });
    assert.strictEqual(r8pPre6.status, 200, `[8p-pre]6号预确认期望 200, got ${r8pPre6.status} ${JSON.stringify(r8pPre6.body)}`);
    assert.strictEqual(r8pPre6.body.released, false, '[8p-pre]6号预确认不该提前触发发布');
    // 7 号（最后一人）自己的行被 SQL 直造成 failed——模拟通知发送失败还未重试成功，仍是 pending。
    await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='模拟发送失败未重试' WHERE id=?`, [row7_8p.id]);
    const row7_8pPre = await execRow(rel8p, 7);
    assert.strictEqual(row7_8pPre.exec_status, 'pending', '[8p-fixture]7 号行仍 pending（未被误动）');
    assert.strictEqual(row7_8pPre.notify_status, 'failed', '[8p-fixture]7 号行 notify_status 确实已被构造成 failed');
    const r8p = await call('POST', `/api/sys-releases/${rel8p}/execute`, dev7Tok, { release_note: '8p不该成功', executor_row_id: row7_8p.id });
    assert.strictEqual(r8p.status, 409, `[8p]期望 409, got ${r8p.status} ${JSON.stringify(r8p.body)}`);
    assert.strictEqual(r8p.body.code, 'NOTIFY_NOT_SENT', `[8p]code 应为 NOTIFY_NOT_SENT（最后一人自己必须真是 sent，不因"其他人是 M-b 脏组合也能发布"就被误读成"通知态全不重要"），实际 ${r8p.body.code}`);
    const relAfter8p = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel8p]);
    assert.strictEqual(relAfter8p.status, '计划中', '[8p]批次未被误翻发布');
    const row7After8p = await execRow(rel8p, 7);
    assert.strictEqual(row7After8p.exec_status, 'pending', '[8p]7 号行未被烧成 done（CAS 五条件里 notify_status=sent 不满足，行原样不动）');
    ok('[8p] 303-L2：M-b 只豁免"已 done 者"事后被误重发失败的脏组合，绝不豁免"最后一人自身当下就是 failed"——3 人批次 5/6 已 done，7 自己 notify_status=failed → execute → 409 NOTIFY_NOT_SENT，批次不发布（锁死判序的精确适用范围）');

    // [8k] 中心守卫负例（直调 publishReleaseTransition，内部调用绕过 HTTP 也会被拦，方案 §4.4 改造 4）。
    {
      // (a) actor 不在册。
      const rel8ka = await mkRelease({ title: 'C3-8ka-中心守卫-不在册' });
      const issue8ka = await mkIssue({ title: 'C3-8ka-成员单' });
      await addIssueTo(rel8ka, issue8ka);
      await call('PUT', `/api/sys-releases/${rel8ka}/executors`, adminTok, { user_ids: [5, 6] });
      let err8ka = null;
      try { await I.publishReleaseTransition(rel8ka, { id: 999, name: '不在册的人' }, { release_note: 'x' }); }
      catch (e) { err8ka = e; }
      assert.ok(err8ka, '[8ka]应抛错（actor 不在册）');
      assert.strictEqual(err8ka.httpStatus, 403, `[8ka]httpStatus 应为 403，实际 ${err8ka.httpStatus}`);
      assert.strictEqual(err8ka.code, 'EXECUTOR_GUARD_FAILED', `[8ka]code 应为 EXECUTOR_GUARD_FAILED，实际 ${err8ka.code}`);
      const relAfter8ka = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel8ka]);
      assert.strictEqual(relAfter8ka.status, '计划中', '[8ka]批次未被误翻发布');
      ok('[8ka] 中心守卫负例·actor 不在册：直调 publishReleaseTransition → 403 EXECUTOR_GUARD_FAILED，批次未被误翻发布（内部调用绕过 HTTP 也会被拦）');

      // (b)（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订）：原夹具"在册人数仅 1（存量单人批次）"
      //   已随下限 2→1 变成合法可发布态（单人 done + actor=该人 → allDone=true∧execRows.length=1≥1，
      //   守卫会直接放行，不再是负例），断言过时（[[feedback_test_assertion_self_error]]），需要换真正
      //   还立得住的负例。
      //   ⭐ 真实发现（非本次改造引入的新 bug，是"< 1"这个阈值下的结构性推论，写实记录）：把中心守卫
      //   `execRows.length < 1` 这条判据单独摘出来看，它现在**永远不可能为真而被触发**——判据在它之前
      //   还有一道 `actorInRoster = execRows.some(r => r.user_id === actor.id)`，只要 actorInRoster 为
      //   true，就已经证明 execRows 里至少有一行（那一行就是 actor 自己），即 `execRows.length >= 1`；
      //   若 actorInRoster 为 false，函数在到达 `execRows.length < 1` 这行之前就已经以 403
      //   EXECUTOR_GUARD_FAILED 提前返回了。也就是说"执行人在册但在册总数为 0"这个组合逻辑上不可能
      //   同时成立——`< 1` 这条 409 分支在当前判序下是死代码，永远走不到。这与"守非空不变量"的设计
      //   意图并不矛盾（零在册批次确实会被拒绝，只是拒绝的错误码/路径变成了 403 而非 409），只是
      //   `EXECUTORS_TOO_FEW` 这个具体错误码在中心守卫这一处已经打不出来了（PUT executors/hotfix-publish
      //   两处的同名闸门仍然可达，见 [2-②负]/hotfix 对应用例）——保留该分支是防御性代码（未来若判序被
      //   挪动，这行代码仍是最后一道防线），不属于本次任务范围内需要处理的问题，如实记录供后续参考。
      //   反转后的 [8kb] 改测"在册总数为 0"这一真实可达的边界态本身：零在册批次，任意 actor 直调
      //   publishReleaseTransition → 403 EXECUTOR_GUARD_FAILED（而非 409），批次不被误翻发布。
      const rel8kb = await mkRelease({ title: 'C3-8kb-中心守卫-零在册' });
      const issue8kb = await mkIssue({ title: 'C3-8kb-成员单' });
      await addIssueTo(rel8kb, issue8kb);
      // 不插入任何 sys_release_executors 行——真实可达的"零在册"边界态（PUT executors 闸②允许 0 人
      // 落库吗？不允许，闸②仍拒空集合，见 [2-②负]；这里是纯 SQL 直造的边界态，覆盖"万一子表因为某种
      // 未来路径变成空集合"这类防御性场景，同旧版夹具"纯 SQL 直造边界态"的一贯范式）。
      let err8kb = null;
      try { await I.publishReleaseTransition(rel8kb, { id: 5, name: '开发甲' }, { release_note: 'x' }); }
      catch (e) { err8kb = e; }
      assert.ok(err8kb, '[8kb]应抛错（零在册）');
      assert.strictEqual(err8kb.httpStatus, 403, `[8kb]httpStatus 应为 403（零在册时 actorInRoster 恒 false，早于 execRows.length<1 判据先行拦截，见上方"死代码"发现），实际 ${err8kb.httpStatus}`);
      assert.strictEqual(err8kb.code, 'EXECUTOR_GUARD_FAILED', `[8kb]code 应为 EXECUTOR_GUARD_FAILED，实际 ${err8kb.code}`);
      const relAfter8kb = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel8kb]);
      assert.strictEqual(relAfter8kb.status, '计划中', '[8kb]批次未被误翻发布（零在册批次无法自行发布）');
      ok('[8kb]（反转·决策 7 三修）中心守卫负例·零在册：直调 publishReleaseTransition → 403 EXECUTOR_GUARD_FAILED（非 409，见死代码发现），批次未被误翻发布');

      // (c) 在册有 pending（未全员 done）。
      const rel8kc = await mkRelease({ title: 'C3-8kc-中心守卫-有pending' });
      const issue8kc = await mkIssue({ title: 'C3-8kc-成员单' });
      await addIssueTo(rel8kc, issue8kc);
      await call('PUT', `/api/sys-releases/${rel8kc}/executors`, adminTok, { user_ids: [5, 6] });
      await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime'), exec_status='done', executed_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [rel8kc]);
      // 6 号行留 pending（未确认）。
      let err8kc = null;
      try { await I.publishReleaseTransition(rel8kc, { id: 5, name: '开发甲' }, { release_note: 'x' }); }
      catch (e) { err8kc = e; }
      assert.ok(err8kc, '[8kc]应抛错（有 pending）');
      assert.strictEqual(err8kc.httpStatus, 409, `[8kc]httpStatus 应为 409，实际 ${err8kc.httpStatus}`);
      assert.strictEqual(err8kc.code, 'EXECUTORS_NOT_ALL_DONE', `[8kc]code 应为 EXECUTORS_NOT_ALL_DONE，实际 ${err8kc.code}`);
      const relAfter8kc = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel8kc]);
      assert.strictEqual(relAfter8kc.status, '计划中', '[8kc]批次未被误翻发布');
      ok('[8kc] 中心守卫负例·有 pending（未全员 done）：直调 publishReleaseTransition → 409 EXECUTORS_NOT_ALL_DONE，批次未被误翻发布');

      // (d) MED-2（Opus 预筛）：已发布批次直调 publishReleaseTransition → 409 RELEASE_NOT_PLANNING（「同一
      //   release_id 永不二次发布」不变量的测试看守恢复——C9·codex 207 审 HIGH-2 三层纵深防御最外层的
      //   函数体自身 `rel.status !== '计划中'` 前置早退）+ 批次/成员/快照三者均零变化（早退发生在任何写
      //   之前）。复用 [8g] 已真正发布的批次 rel8efg；actor 故意传一个不在册的虚构人，用来同时证明这道
      //   早退确实排在 actor 在册性检查之前（若顺序反了，会先落 403 EXECUTOR_GUARD_FAILED 而非 409）。
      const relRow8kd_before = await get(`SELECT status, release_note, version_tag FROM sys_releases WHERE id=?`, [rel8efg]);
      assert.strictEqual(relRow8kd_before.status, '已发布', '[8kd-fixture]复用 [8g] 已真正发布的批次');
      const issueRow8kd_before = await get(`SELECT status, release_id, released_at FROM sys_issues WHERE id=?`, [issue8efg]);
      const snapCount8kd_before = await get(`SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [rel8efg]);
      let err8kd = null;
      try { await I.publishReleaseTransition(rel8efg, { id: 999, name: '不在册的虚构人' }, { release_note: '试图二次发布' }); }
      catch (e) { err8kd = e; }
      assert.ok(err8kd, '[8kd]应抛错（已发布批次不能再发布）');
      assert.strictEqual(err8kd.httpStatus, 409, `[8kd]httpStatus 应为 409，实际 ${err8kd.httpStatus}`);
      assert.strictEqual(err8kd.code, 'RELEASE_NOT_PLANNING', `[8kd]code 应为 RELEASE_NOT_PLANNING（早退排在 actor 在册性检查之前，不在册的虚构人也命中同一早退），实际 ${err8kd.code}`);
      const relRow8kd_after = await get(`SELECT status, release_note, version_tag FROM sys_releases WHERE id=?`, [rel8efg]);
      assert.deepStrictEqual(relRow8kd_after, relRow8kd_before, '[8kd]批次三列（status/release_note/version_tag）零变化');
      const issueRow8kd_after = await get(`SELECT status, release_id, released_at FROM sys_issues WHERE id=?`, [issue8efg]);
      assert.deepStrictEqual(issueRow8kd_after, issueRow8kd_before, '[8kd]成员单三列零变化');
      const snapCount8kd_after = await get(`SELECT COUNT(*) AS c FROM sys_issue_release_commit_snapshots WHERE release_id=?`, [rel8efg]);
      assert.strictEqual(snapCount8kd_after.c, snapCount8kd_before.c, '[8kd]快照行数零变化（未产生第二条快照）');
      ok('[8kd] MED-2：已发布批次直调 publishReleaseTransition → 409 RELEASE_NOT_PLANNING，批次/成员/快照三者均零变化（「同一 release_id 永不二次发布」不变量的测试看守恢复）');
    }

    // [8l] 旧代次确认打不到新代次：软删旧行 + 新行并存后，用旧 row_id 请求确认 → 403 EXECUTOR_NOT_ACTIVE，
    //   旧行不受影响（§4.1a 代次语义在 execute() 端点同样生效，行 id 即代次）。
    const rel8l = await mkRelease({ title: 'C3-8l-旧代次' });
    const issue8l = await mkIssue({ title: 'C3-8l-成员单' });
    await addIssueTo(rel8l, issue8l);
    await call('PUT', `/api/sys-releases/${rel8l}/executors`, adminTok, { user_ids: [5, 6] });
    const row5_8l_old = await execRow(rel8l, 5);
    await call('PUT', `/api/sys-releases/${rel8l}/executors`, adminTok, { user_ids: [6, 7] });   // 移除 5（软删旧行）
    await call('PUT', `/api/sys-releases/${rel8l}/executors`, adminTok, { user_ids: [5, 6] });   // 重新加入 5（全新行，新代次）
    const row5_8l_new = await execRow(rel8l, 5);
    assert.notStrictEqual(row5_8l_new.id, row5_8l_old.id, '[8l-fixture]重新加入产生的是全新行 id（非复活旧行，§4.1a）');
    const r8l = await call('POST', `/api/sys-releases/${rel8l}/execute`, dev5Tok, { release_note: 'x', executor_row_id: row5_8l_old.id });
    assert.strictEqual(r8l.status, 403, `[8l]期望 403, got ${r8l.status} ${JSON.stringify(r8l.body)}`);
    assert.strictEqual(r8l.body.code, 'EXECUTOR_NOT_ACTIVE', `[8l]code 应为 EXECUTOR_NOT_ACTIVE，实际 ${r8l.body.code}`);
    const row5_8l_oldAfter = await get(`SELECT exec_status FROM sys_release_executors WHERE id=?`, [row5_8l_old.id]);
    assert.strictEqual(row5_8l_oldAfter.exec_status, 'pending', '[8l]旧行未被误改（软删行 exec_status 原样不动，未被旧代次请求污染）');
    ok('[8l] 旧代次确认打不到新代次：软删旧行 + 新行并存后，用旧 row_id 请求确认 → 403 EXECUTOR_NOT_ACTIVE，旧行不受影响（§4.1a 代次语义，行 id 即代次）');

    // [8n] MED-3（Opus 预筛）：真实并发——3 人批次，两位不同执行人真正同时确认（均非最后一人，第三人
    //   留 pending）→ 两次均 200，两行均 done，release_executor_done timeline 恰 2 条，零 5xx（恢复
    //   "两个并发多步写事务"这一风险面——本文件此前所有 execute 用例都是串行 await，从未真正并发打过
    //   两条请求；sysTxnMutex 序列化写事务本应让两条并发请求各自的读-判-写序列互不踩踏，此用例给这条
    //   隐含保证补一条正面验证）。
    const rel8n = await mkRelease({ title: 'C3-execute-8n-并发双确认' });
    const issue8n = await mkIssue({ title: 'C3-execute-8n-成员单' });
    await mkCompleteRoster(issue8n);
    await addIssueTo(rel8n, issue8n);
    const put8n = await call('PUT', `/api/sys-releases/${rel8n}/executors`, adminTok, { user_ids: [5, 6, 7] });
    assert.strictEqual(put8n.status, 200, `[8n-fixture]期望 200, got ${put8n.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8n]);
    const row5_8n = await execRow(rel8n, 5);
    const row6_8n = await execRow(rel8n, 6);
    const [r8n5, r8n6] = await Promise.all([
      call('POST', `/api/sys-releases/${rel8n}/execute`, dev5Tok, { executor_row_id: row5_8n.id }),
      call('POST', `/api/sys-releases/${rel8n}/execute`, dev6Tok, { executor_row_id: row6_8n.id }),
    ]);
    assert.strictEqual(r8n5.status, 200, `[8n]5号并发确认期望 200, got ${r8n5.status} ${JSON.stringify(r8n5.body)}`);
    assert.strictEqual(r8n6.status, 200, `[8n]6号并发确认期望 200, got ${r8n6.status} ${JSON.stringify(r8n6.body)}`);
    assert.strictEqual(r8n5.body.my_status, 'done', '[8n]5号 my_status=done');
    assert.strictEqual(r8n6.body.my_status, 'done', '[8n]6号 my_status=done');
    assert.strictEqual(r8n5.body.released, false, '[8n]5号响应 released=false（7 号仍 pending，R-GATE 未满足）');
    assert.strictEqual(r8n6.body.released, false, '[8n]6号响应 released=false（同上）');
    const row5_8nAfter = await execRow(rel8n, 5);
    const row6_8nAfter = await execRow(rel8n, 6);
    assert.strictEqual(row5_8nAfter.exec_status, 'done', '[8n]5号行真实落库 done');
    assert.strictEqual(row6_8nAfter.exec_status, 'done', '[8n]6号行真实落库 done');
    const tl8n = await notifyTimelineRowsByCode(rel8n, 'release_executor_done');
    assert.strictEqual(tl8n.length, 2, `[8n]release_executor_done timeline 恰 2 条（每位确认者各写 1 条），实际 ${tl8n.length}`);
    ok('[8n] MED-3 真实并发：3 人批次两位不同执行人并发确认（均非最后一人）→ 两次均 200，两行均 done，timeline 恰 2 条，零 5xx（恢复"两个并发多步写事务"风险面）');

    // [8q] 303-M1（Opus 对抗审）：done 之后过资格闸的负例镜像——done 是既成事实，其幂等回显不该被"此刻
    //   资格状态"否决。2 人批次全部 done（真正发布）后，5 号账号被 SQL 直接禁用，5 号本人重复确认 →
    //   仍 200 already:true（preRow-done 分支现已排在资格闸之前，压根不会跑到 hasReleaseEligibility）。
    const rel8q = await mkRelease({ title: 'C3-execute-8q-done后禁用账号' });
    const issue8q = await mkIssue({ title: 'C3-execute-8q-成员单' });
    await mkCompleteRoster(issue8q);
    await addIssueTo(rel8q, issue8q);
    const put8q = await call('PUT', `/api/sys-releases/${rel8q}/executors`, adminTok, { user_ids: [5, 6] });
    assert.strictEqual(put8q.status, 200, `[8q-fixture]期望 200, got ${put8q.status}`);
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [rel8q]);
    const row5_8q = await execRow(rel8q, 5);
    const row6_8q = await execRow(rel8q, 6);
    const r8qPre6 = await call('POST', `/api/sys-releases/${rel8q}/execute`, dev6Tok, { executor_row_id: row6_8q.id });
    assert.strictEqual(r8qPre6.status, 200, `[8q-pre]6号预确认期望 200, got ${r8qPre6.status} ${JSON.stringify(r8qPre6.body)}`);
    assert.strictEqual(r8qPre6.body.released, false, '[8q-pre]6号预确认不该提前触发发布');
    const r8q1 = await call('POST', `/api/sys-releases/${rel8q}/execute`, dev5Tok, { release_note: '8q首次真发布', executor_row_id: row5_8q.id });
    assert.strictEqual(r8q1.status, 200, `[8q-1]期望 200, got ${r8q1.status} ${JSON.stringify(r8q1.body)}`);
    assert.strictEqual(r8q1.body.released, true, '[8q-1]最后一人确认触发真正发布');
    // 5 号本人 done 之后，账号被禁用（模拟"上线完成后被停用"）。
    await run(`UPDATE users SET status='disabled' WHERE id=5`);
    try {
      const r8q2 = await call('POST', `/api/sys-releases/${rel8q}/execute`, dev5Tok, { executor_row_id: row5_8q.id });
      assert.strictEqual(r8q2.status, 200, `[8q-2]期望 200(done 优先于资格闸，不受禁用影响), got ${r8q2.status} ${JSON.stringify(r8q2.body)}`);
      assert.strictEqual(r8q2.body.my_status, 'done', '[8q-2]my_status=done');
      assert.strictEqual(r8q2.body.already, true, '[8q-2]already=true（幂等分诊②，不因账号已禁用而改判）');
      assert.strictEqual(r8q2.body.released, true, '[8q-2]released=true（批次确实已发布，302-L1 当场重算）');
    } finally {
      await run(`UPDATE users SET status='active' WHERE id=5`);   // 复原，避免污染后续用例（同文件既有惯例）
    }
    ok('[8q] 303-M1：done 之后本人账号被禁用，重复确认仍 200 already:true——preRow-done 分支排在资格闸之前，已完成的幂等回显不受"此刻资格状态"否决');
  }

  // ═══ [10]（C6 收口·方案 §4.7 点名的验收项）非首位执行人深链端到端全链——"示例开发L打得开吗"的可执行答案 ═══
  //   真实用户走得到的全链，不是分段单点测：admin 建批次挂单 → PUT executors 选两人 → 行级 notify 两人各
  //   一次 → **非首位**（PUT 调用时排在数组第二位的那个人，7 号）用自己的 token 依次走：①mine 列表能看到
  //   该批次 ②详情端点（?release= 深链的后端目标）能打开且 executors 数组含本人那一行 ③execute 带本人
  //   行 id 确认成功 ④首位（6 号）再确认，带 release_note（最后一人）触发真正发布——全程零 403/404。
  {
    const rel10 = await mkRelease({ title: 'C6-10-非首位执行人深链全链' });
    const issue10 = await mkIssue({ title: 'C6-10-成员单' });
    await mkCompleteRoster(issue10);   // RELEASE 中心守卫要求成员单在册开发全完成态，最后一步真发布要用到
    await addIssueTo(rel10, issue10);

    // 首位=6 号（甲），非首位=7 号（乙）——user_ids 数组第二位。
    const put10 = await call('PUT', `/api/sys-releases/${rel10}/executors`, adminTok, { user_ids: [6, 7] });
    assert.strictEqual(put10.status, 200, `[10-fixture] PUT executors 期望 200, got ${put10.status} ${JSON.stringify(put10.body)}`);
    const row10_6 = put10.body.executors.find(r => r.user_id === 6);
    const row10_7 = put10.body.executors.find(r => r.user_id === 7);
    assert.ok(row10_6 && row10_7, '[10-fixture] PUT executors 响应含两人的行（6 号=甲/7 号=乙=非首位）');

    // 行级 notify 甲乙各一次（SEND_IMPL 默认桩恒成功，同文件既有 [6] 组范式，零真实外呼）。
    const notify10_6 = await call('POST', `/api/sys-releases/${rel10}/executors/6/notify`, adminTok);
    assert.strictEqual(notify10_6.status, 200, `[10-①] 通知甲(6号)期望 200, got ${notify10_6.status} ${JSON.stringify(notify10_6.body)}`);
    assert.strictEqual(notify10_6.body.notify_status, 'sent', '[10-①] 甲(6号)通知态=sent');
    const notify10_7 = await call('POST', `/api/sys-releases/${rel10}/executors/7/notify`, adminTok);
    assert.strictEqual(notify10_7.status, 200, `[10-①] 通知乙(7号·非首位)期望 200, got ${notify10_7.status} ${JSON.stringify(notify10_7.body)}`);
    assert.strictEqual(notify10_7.body.notify_status, 'sent', '[10-①] 乙(7号)通知态=sent');
    ok('[10-①] admin 建批次挂单 + PUT executors 选甲乙两人（甲=首位 6 号/乙=非首位 7 号）+ 行级通知两人各一次，均 200 sent');

    // ② 乙（非首位·7 号）用自己的 token 查 mine 列表——能看到该批次（子表 EXISTS 判据，方案 §4.4 #8）。
    const list10_7 = await call('GET', '/api/sys-releases', dev7Tok);
    assert.strictEqual(list10_7.status, 200, `[10-②a] 乙查 mine 列表期望 200, got ${list10_7.status}`);
    assert.strictEqual(list10_7.body.scope, 'mine', '[10-②a] 非 admin/对接人身份应落 mine 视角');
    const found10_7 = (list10_7.body.items || []).find(x => x.id === rel10);
    assert.ok(found10_7, '[10-②a] mine 列表应含本批次——非首位执行人同样能在自己的列表里看到（"示例开发L打得开吗"第一问：列表看得见吗）');

    // ② 乙（非首位·7 号）用自己的 token 打详情端点（?release= 深链最终打到的后端目标）——200，且
    //   executors 数组含本人那一行（详情页多人执行人区块的数据源头）。
    const detail10_7 = await call('GET', `/api/sys-releases/${rel10}`, dev7Tok);
    assert.strictEqual(detail10_7.status, 200, `[10-②b] 乙查详情期望 200（非 403，这正是方案 §4.4 改造 5b 收口的"示例开发L打不开详情"缺口）, got ${detail10_7.status} ${JSON.stringify(detail10_7.body)}`);
    const detailRow10_7 = (detail10_7.body.executors || []).find(e => e.user_id === 7);
    assert.ok(detailRow10_7, '[10-②b] 详情响应 executors 数组应含本人（7 号）那一行');
    assert.strictEqual(detailRow10_7.notify_status, 'sent', '[10-②b] 详情里看到的本人通知态与刚才发送结果一致（写读同源）');
    ok('[10-②] 乙（非首位）用自己的 token：mine 列表能看到 + 详情端点 200 且 executors 含本人行——"示例开发L打得开吗"的可执行答案是"打得开"');

    // ③ 乙带自己那一行的 executor_row_id 确认——200，my_status=done，released=false（甲还没确认，R-GATE 未满足）。
    const exec10_7 = await call('POST', `/api/sys-releases/${rel10}/execute`, dev7Tok, { executor_row_id: detailRow10_7.id });
    assert.strictEqual(exec10_7.status, 200, `[10-③] 乙确认期望 200, got ${exec10_7.status} ${JSON.stringify(exec10_7.body)}`);
    assert.strictEqual(exec10_7.body.my_status, 'done', '[10-③] 乙 my_status=done');
    assert.strictEqual(exec10_7.body.released, false, '[10-③] 乙确认后 released=false（甲仍 pending，R-GATE 未满足，批次仍「计划中」）');
    ok('[10-③] 乙（非首位）带本人 executor_row_id 确认成功：200 + my_status=done + released=false（R-GATE 差甲一人）');

    // ④ 甲（首位·6 号）用自己的 token 最后确认，带 release_note——R-GATE 满足（在册 2 人∧无 pending），
    //   触发真正发布。
    const exec10_6 = await call('POST', `/api/sys-releases/${rel10}/execute`, dev6Tok, { release_note: 'C6-10 全链验收', executor_row_id: row10_6.id });
    assert.strictEqual(exec10_6.status, 200, `[10-④] 甲最后确认期望 200, got ${exec10_6.status} ${JSON.stringify(exec10_6.body)}`);
    assert.strictEqual(exec10_6.body.released, true, '[10-④] 甲是最后一人，released=true（真正触发发布）');
    assert.ok(Array.isArray(exec10_6.body.released_issue_ids) && exec10_6.body.released_issue_ids.includes(issue10), '[10-④] released_issue_ids 含本批次成员单');
    const relRow10After = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel10]);
    assert.strictEqual(relRow10After.status, '已发布', '[10-④] 批次真实落库为「已发布」');
    ok('[10-④] 甲（首位）最后确认（带 release_note）：200 + released=true + released_issue_ids 含成员单 + 批次落库「已发布」——全链真正跑到发布');

    // [10-⑤]（原「全程零 403/404 汇总复核」小节）已删除——LOW-1（C6 预筛回卷）：那条 assert.ok(...every(
    // s=>s===200)) 断言的六个状态码，每一个在 [10-①]～[10-④] 里都已单独 assert.strictEqual(status,200)
    // 断言过；控制流能走到这里，就已经证明它们全部是 200（任一不是 200，前面对应的 assert.strictEqual
    // 早就抛出并终止脚本，根本到不了这一行）——这是"运行时恒真"的死断言（同 [[feedback_test_assertion_
    // self_error]] 断言自身问题的一种形态：不是检验了什么，只是把已经证明过的事实又抄了一遍）。删除
    // 比换个"看起来独立"的判据更诚实：换个判据也治标不治本，因为构成 allStatuses10 的六个值本身就
    // 全部来自"已经断言过 200"的响应对象，找不到一个真正独立、此刻仍可能为假的新命题可断言。
  }

  // ═══ [11]（用户拍板决策 7 第三次修正·方案 v1.7 二订·新增端到端）单人批次全链正例——真实 API 端到端
  //   （PUT [甲] 1 人 → notify → confirm 带说明 → released:true）。与 [8i] 互补：[8i] 是纯 SQL 直造
  //   sent 态的最小单元测试（专注验证 CAS/R-GATE 判据本身），本组走 PUT executors + 行级 notify +
  //   execute 三个真实端点的完整链路，验证"单人批次"这条决策 7 三修新放行的路径端到端真的可用——不是
  //   "理论上闸门算式对了但没人真走过一遍"。
  {
    const rel11 = await mkRelease({ title: 'C6-11-单人批次全链正例' });
    const issue11 = await mkIssue({ title: 'C6-11-成员单' });
    await mkCompleteRoster(issue11);
    await addIssueTo(rel11, issue11);

    // ① PUT executors 只选甲一人——决策 7 三修后应 200（不同于 [2-②负] 的空集合才会被拒）。
    const put11 = await call('PUT', `/api/sys-releases/${rel11}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(put11.status, 200, `[11-①] PUT executors 单人期望 200, got ${put11.status} ${JSON.stringify(put11.body)}`);
    assert.strictEqual(put11.body.executors.length, 1, '[11-①] 响应 executors 数组恰 1 个元素（单人批次，非泛泛的"数组非空"）');
    const row11 = put11.body.executors.find(r => r.user_id === 5);
    assert.ok(row11, '[11-①] 响应含甲(5号)的行');
    ok('[11-①] PUT executors 仅选甲一人 → 200，子表新增 1 行（决策 7 三修真实放行单人批次，非纯 SQL 构造）');

    // ② 行级通知甲——真实端点（SEND_IMPL 默认桩恒成功，零真实外呼，同既有 [6]/[10] 组范式）。
    const notify11 = await call('POST', `/api/sys-releases/${rel11}/executors/5/notify`, adminTok);
    assert.strictEqual(notify11.status, 200, `[11-②] 通知甲期望 200, got ${notify11.status} ${JSON.stringify(notify11.body)}`);
    assert.strictEqual(notify11.body.notify_status, 'sent', '[11-②] 甲通知态=sent');
    ok('[11-②] 行级通知甲（真实端点）→ 200 sent');

    // ③ 甲确认（带 release_note，本人即唯一执行人=天然的"最后一人"）→ 200 + released:true，真正发布。
    const exec11 = await call('POST', `/api/sys-releases/${rel11}/execute`, dev5Tok, { release_note: 'C6-11 单人全链验收', executor_row_id: row11.id });
    assert.strictEqual(exec11.status, 200, `[11-③] 甲确认期望 200, got ${exec11.status} ${JSON.stringify(exec11.body)}`);
    assert.strictEqual(exec11.body.released, true, '[11-③] released=true（单人批次·唯一执行人确认即满足 R-GATE ≥1∧无pending，真正触发发布）');
    assert.ok(Array.isArray(exec11.body.released_issue_ids) && exec11.body.released_issue_ids.includes(issue11), '[11-③] released_issue_ids 含本批次成员单');
    const rel11After = await get(`SELECT status, release_note FROM sys_releases WHERE id=?`, [rel11]);
    assert.strictEqual(rel11After.status, '已发布', '[11-③] 批次真实落库为「已发布」');
    assert.strictEqual(rel11After.release_note, 'C6-11 单人全链验收', '[11-③] release_note 正确写入');
    ok('[11-③] 甲（唯一执行人）确认（带 release_note）→ 200 + released:true + released_issue_ids 含成员单 + 批次落库「已发布」——单人批次全链真正跑到发布（PUT→notify→confirm 三端点全真实调用，非拼凑响应对象）');

    // ④（312-L1·codex 合并前建议）单人链路负例——另建一批（上面 rel11 已发布，不能复用）：唯一执行人
    //   sent+pending，但确认时**不带 release_note** → 400 RELEASE_NOTE_REQUIRED。本人虽是"天然的最后
    //   一人"（1 人批次，CAS 成功后 execRows.length=1∧pending=0，R-GATE 立即满足），但 R-GATE 满足只是
    //   触发去调 _publishReleaseCoreInTxn，闸门③（release_note 非空）在那之后才校验——校验失败整体回滚，
    //   刚 CAS 成功的 done 也一并撤销，不留半截态（M4 定稿逐字，多人版同一不变量见 [8h]；本条覆盖的是
    //   "单人=天然最后一人"这条路径专属分支，此前只在多人场景验证过，单人场景是真空）。
    const rel11n = await mkRelease({ title: 'C6-11负-单人漏填说明' });
    const issue11n = await mkIssue({ title: 'C6-11负-成员单' });
    await mkCompleteRoster(issue11n);
    await addIssueTo(rel11n, issue11n);
    const put11n = await call('PUT', `/api/sys-releases/${rel11n}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(put11n.status, 200, `[11-④-fixture] PUT executors 期望 200, got ${put11n.status} ${JSON.stringify(put11n.body)}`);
    const row11n = put11n.body.executors.find(r => r.user_id === 5);
    assert.ok(row11n, '[11-④-fixture] 响应含甲(5号)的行');
    const notify11n = await call('POST', `/api/sys-releases/${rel11n}/executors/5/notify`, adminTok);
    assert.strictEqual(notify11n.status, 200, `[11-④-fixture] 通知期望 200, got ${notify11n.status} ${JSON.stringify(notify11n.body)}`);
    assert.strictEqual(notify11n.body.notify_status, 'sent', '[11-④-fixture] 通知态=sent');

    const exec11n = await call('POST', `/api/sys-releases/${rel11n}/execute`, dev5Tok, { executor_row_id: row11n.id });
    assert.strictEqual(exec11n.status, 400, `[11-④] 期望 400, got ${exec11n.status} ${JSON.stringify(exec11n.body)}`);
    assert.strictEqual(exec11n.body.code, 'RELEASE_NOTE_REQUIRED', `[11-④] code 应为 RELEASE_NOTE_REQUIRED，实际 ${exec11n.body.code}`);
    // 回滚三断言：①执行人行仍 pending（CAS 已随事务撤销，未被烧成 done）
    const row11nAfter = await get(`SELECT exec_status FROM sys_release_executors WHERE id=?`, [row11n.id]);
    assert.strictEqual(row11nAfter.exec_status, 'pending', '[11-④] 执行人行仍 pending（CAS 已随事务整体回滚，不留半截态）');
    // ②批次仍「计划中」（未被误翻发布）
    const rel11nAfter = await get(`SELECT status FROM sys_releases WHERE id=?`, [rel11n]);
    assert.strictEqual(rel11nAfter.status, '计划中', '[11-④] 批次仍「计划中」（未被误翻发布）');
    ok('[11-④]（312-L1）单人链路负例：唯一执行人 sent+pending 但不带 release_note execute → 400 RELEASE_NOTE_REQUIRED，回滚三断言（响应码精确/执行人行仍 pending/批次仍「计划中」）全部成立——M4 回滚不变量在"单人=天然最后一人"这条路径下同样成立，此前仅多人场景（[8h]）验证过，单人场景补齐');
  }

  console.log(`\n✅ verify-sys-release-executors 全部通过（${passed} 组·C2 起追加行级通知/行级已读端点·C3 起追加 execute 组·C6 收口追加非首位深链全链组·决策 7 三修追加单人批次全链端到端组）`);
  server.close(); db.close();
}

main().catch((e) => { console.error('\n❌ 失败：', e.message, e.stack); if (server) server.close(); process.exit(1); });
