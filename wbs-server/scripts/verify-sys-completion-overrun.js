// scripts/verify-sys-completion-overrun.js — 方案 §14（S11·先行上线两步化 v1.8）feature 超期完成理由闸
//   SSOT = docs/local/系统迭代/先行上线两步化_方案_20260813_v1.8.md §14（§14.1-F4 含
//   【2026-08-14 S11 预筛订正】闸边迁移原话）
//   用法：node scripts/verify-sys-completion-overrun.js
//
// 【2026-08-14 S11 预筛闸边迁移】全文重写要点：闸从 case 'liaison_test_pass'（对接测试通过·对接人
//   动作·「待对接测试→待验证」边）迁到「开发报完工」边——feature 的 submit（开发中→待对接测试，
//   ⑦ 正常路径）+ runWGate ⑤⑥ 直达边（开发中→待验证，降级路径）。liaison_test_pass 自此**不闸**。
//   本文件全部经由 liaison_test_pass 触发闸判定的用例改经 submit（⑦ 边），断言目标态从「待验证」
//   改为「待对接测试」；「打回重提」改用 liaison_test_return（对接测试打回，非 return，因第一轮
//   落点已不是待验证）。新增 [LP] 组正面证明 liaison_test_pass 撤闸（严重超期也不拦、不碰理由两列）。
//
// 覆盖：
//   [M] gap=3 触发 / gap=2 不触发（成对，via submit ⑦ 边，服务器时钟锚定夹具防跨零点假红 LOW-4）
//   [E] deadline 空不触发（清空两列）
//   [C] improvement/bug 对照组——同样构造"超期"场景，零受影响（§14 明确"仅 feature"）
//   [R] 缺 code / 缺 note / 超长 / 枚举外非法值 四类 400，且零残留（status/理由两列/timeline/
//       updated_at/liaison_test_* 列组·378-H5 单事务契约 + LOW-5 补齐）
//   [T] 打回重提二次触发（liaison_test_return，非 return）——第二次提交按 action_code 筛出两行独立留痕
//   [N] 不超期路径清空残留（deadline 在未来）
//   [F2] 期望已过期受理单完成必触发（受理迟不豁免完成侧判定）
//   [D] SYS_DEADLINE_MALFORMED 独立 409（deadline 非法非空值，事务零提交）
//   [G] 成组探针（completion_overrun_reason_code/note 同空同非空，含红灯反证）
//   [LP] liaison_test_pass 撤闸正面证明——严重超期 deadline 不拦截、不生成/不消费理由两列
//   [W5][W6] runWGate feature⑤⑥降级路径——直接从「开发中」跳「待验证」同样受闸（保留，未受迁移影响）
//   [S] 状态写入汇点审计（NEW-4·2026-08-14 重做：不数 runWGate 调用次数，改逐条核对 index.js 内
//       全部能写「待对接测试/待验证」的 UPDATE 语句块——精确等值 + 逐站点白名单 + 红灯自证）
// 2026-09-27 A1：绝对行号锚改为语法归属 + SQL 首段/WHERE 指纹；插入注释不应改变审计结果。
// 结构检查先于运行时用例，删除 gate 时首红明确落到对应写点；不可达元数据仍需人工核对。
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-completion-overrun-secret';
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

// 用户种子：1=admin / 5,6=开发 / 13=对接人白名单唯一成员。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

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

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ verify-sys-completion-overrun 失败: ' + msg); process.exit(1); }

const pad2 = (n) => String(n).padStart(2, '0');
function dateOnly(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function daysAgo(n) { return dateOnly(new Date(Date.now() - n * 86400000)); }
function daysAhead(n) { return dateOnly(new Date(Date.now() + n * 86400000)); }
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
// [LOW-4·跨零点假红修] 服务端时钟锚定夹具——[M] 组 gap=2/gap=3 是"达到即触发"阈值的**精确边界**测试，
//   若用 JS 侧 `daysAgo(n)`（基于测试进程本地 Date.now()）构造 deadline，而实际判定发生在**服务端**
//   `datetime('now','localtime')`——两次取时钟之间若恰好跨过本地零点，"今天"在两侧会相差一天，
//   静默把 gap=2 算成 gap=1 或 gap=3，测试假红/假绿且与代码正确性无关（纯环境噪音）。改为：先向服务端
//   查一次真实"今天"（与 evaluateCompletionOverrun 同一个时钟源），再用字符串/分量算术偏移 N 天构造
//   deadline——两侧共享同一次时钟读数的"今天"值，只要后续 submit 调用与本次查询之间不跨零点（毫秒级
//   间隔，概率≈0）即消除该假红面。
async function serverTodayAnchored(deltaDays) {
  const row = await get(`SELECT date('now','localtime') AS d`);
  const [y, m, d] = row.d.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateOnly(dt);
}

// ── 造数 helper（同 verify-sys-liaison-test.js 范式：raw SQL 直造 issue/roster，测的是 runWGate 决策树
//   本身，非建单/受理/指派链路）。deadlineRaw 传 undefined=不设该列。──
let seq = 0;
async function mkIssue(type, status, deadlineRaw, extra = {}) {
  seq++;
  const intakeLiaisonId = Object.prototype.hasOwnProperty.call(extra, 'intakeLiaisonId') ? extra.intakeLiaisonId : 13;
  // dev_estimated_at 默认给一个未来值（isGateEligibleForVerify 硬性要求非空才可能推进出 DEV 族，
  // 见该函数 :3397 一带）——本文件测的是完成超期理由闸，不是 ETA 生成本身，不需要真实受理链路产出，
  // 直接种一个占位未来值即可满足前置资格。
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, intake_liaison_id, deadline, needs_feasibility, estimated_effort_days)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, ?, ?, ?)`,
    [type, status, `${type}-${status}-单-${seq}`, extra.devEstimatedAt || futureEst(30), intakeLiaisonId,
     deadlineRaw === undefined ? null : deadlineRaw,
     extra.needsFeasibility || 0,
     extra.estimatedEffortDays !== undefined ? extra.estimatedEffortDays : (['feature', 'improvement'].includes(type) ? 1 : null)]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [issueId, userId, userName, devStatus, extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  const daId = r.lastID;
  if (devStatus === 'code_submitted' && extra.skipCommit !== true) {
    await run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, ?, 'backend', ?, datetime('now'))`,
      [issueId, daId, userId, `fix/seed-${daId}`]
    );
  }
  return daId;
}
async function issueRow(issueId) { return get('SELECT * FROM sys_issues WHERE id = ?', [issueId]); }
async function statusOf(issueId) { return (await issueRow(issueId)).status; }
async function timelineRows(issueId) { return all(`SELECT * FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id ASC`, [issueId]); }
async function timelineCount(issueId) { return (await timelineRows(issueId)).length; }
async function timelineByActionCode(issueId, actionCode) {
  return all(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code=? ORDER BY id`, [issueId, actionCode]);
}
async function triggerGateViaExcuse(issueId, daId, reason = '触发 GATE 判定') {
  return call('POST', `/api/sys-issues/${issueId}/dev-assignees/${daId}/excuse`, adminTok, { reason });
}
// 【2026-08-14 S11 预筛闸边迁移】造一单 pending 待完成的 feature——供调用方走 submit（⑦ 正常路径，
//   "开发报完工"边，本闸的新落点）触发全完成态判定。deadlineRaw 直接决定 gap（判定用服务端 nowStr，
//   与「今天」的日期分量差）。
async function mkPendingFeature(deadlineRaw, extra = {}) {
  const id = await mkIssue('feature', '开发中', deadlineRaw, extra);
  await mkMember(id, 5, '开发甲', 'pending');
  return id;
}
let commitSeq = 0;
// submit（⑦ 边触发方）——唯一转发 payload 给 runWGate 的调用点，completion_overrun_reason_code/note
// 经 extraBody 透传。
async function submitDev(issueId, userId, extraBody = {}) {
  commitSeq++;
  return call('POST', `/api/sys-issues/${issueId}/submit`, devTok(userId), {
    mode: 'commits', self_tested: true, test_env_deployed: true,
    commits: [{ component: 'backend', commit_ref: `co-seq-${commitSeq}` }],
    ...extraBody,
  });
}
async function liaisonTestPass(id, extraBody = {}) {
  return call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '完成超期理由闸探针：对接测试通过', ...extraBody });
}
async function liaisonTestReturn(id, reason = '[T] 对接测试打回重提探针') {
  return call('POST', `/api/sys-issues/${id}/liaison-test-return`, liaisonTok, { reason });
}

async function main() {
  // [S] Structural anchors: syntax owner + normalized SQL, never source line numbers.
  {
    const T14 = require('../routes/sys-iteration/transitions');
    const featureTransitionsForAudit = T14.TRANSITIONS.feature;
    const staticForwardEdges = featureTransitionsForAudit.filter(t => t.to === '待验证' || t.to === '待对接测试');
    const dynamicWGateEdges = featureTransitionsForAudit.filter(t => t.dynamicTarget === 'w_gate'
      && Array.isArray(t.possibleTargets)
      && (t.possibleTargets.includes('待验证') || t.possibleTargets.includes('待对接测试')));
    assert.strictEqual(staticForwardEdges.length, 1, `[S①] feature 流里 to∈{待对接测试,待验证} 的静态边应恰 1 条，实得 ${staticForwardEdges.length}`);
    assert.strictEqual(staticForwardEdges[0].action, 'liaison_test_pass', `[S①] 唯一静态前进边应是 liaison_test_pass，实得「${staticForwardEdges[0] && staticForwardEdges[0].action}」`);
    assert.strictEqual(dynamicWGateEdges.length, 1, `[S①] dynamicTarget='w_gate' 且候选含待对接测试/待验证的边应恰 1 条，实得 ${dynamicWGateEdges.length}`);
    assert.strictEqual(dynamicWGateEdges[0].action, 'submit', `[S①] 唯一动态 GATE 前进边应是 submit，实得「${dynamicWGateEdges[0] && dynamicWGateEdges[0].action}」`);
    ok('[S①] transitions.js feature 流前进边枚举：静态边=liaison_test_pass(to=待验证) 恰 1 条 / 动态 w_gate 边=submit（possibleTargets 含待对接测试+待验证）恰 1 条，二者合计穷尽全部能落到目标两态的前进边');


    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const comments = [];
    require('acorn').parse(indexSrc, { ecmaVersion: 'latest', onComment: (_block, _text, start, end) => comments.push({start,end}) });
    const cleanParts = []; let cleanOffset = 0;
    for (const comment of comments) {
      cleanParts.push(indexSrc.slice(cleanOffset, comment.start), indexSrc.slice(comment.start, comment.end).replace(/[^\r\n]/g, ' '));
      cleanOffset = comment.end;
    }
    const indexCleanForWriteAudit = cleanParts.join('') + indexSrc.slice(cleanOffset);
    const { extractStatusWriteSites, extractDynamicSetSites, countStatusWritesByText } = require('./_sys-status-write-sites');
    const writeSites = extractStatusWriteSites(indexSrc);
    assert.strictEqual(writeSites.length, 8, '[S②] status UPDATE 写点总数必须恰为 8');
    assert.strictEqual(countStatusWritesByText(indexSrc), writeSites.length, '[S②b] 文本计数必须与语法计数全等');
    // [S②c] SET 子句为空或含变量拼接的写点，写什么列由运行时决定，静态扫描无法判断是否写 status：
    //   逐条登记「归属 :: SET 子句」，新增或改动任何一处都必须来这里人工核对后登记（硬门，无放行分支）。
    //   登记时已核：下列片段来源（EDIT_TIER_*_FIELDS / SYS_CLEAR_*_SQL / notifyResetSql / effortSetFrag /
    //   read_at 列名常量）均不含 status；${setClause} 是通用状态引擎，已计入上方八处。
    const DYNAMIC_SET_REGISTRY = [
      "electRepresentative :: assigned_to = ?, assigned_to_name = ?, assigned_at = datetime('now','localtime')${notifyResetSql}",
      'electRepresentative :: assigned_to = ?, assigned_to_name = ?${notifyResetSql}',
      'electRepresentative :: assigned_to = NULL, assigned_to_name = NULL, assigned_at = NULL${notifyResetSql}',
      "terminateExpiredFastReleaseAuthInTxn :: ${SYS_CLEAR_FAST_RELEASE_AUTH_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime')",
      'sysIssueTransition :: ${setClause}',
      "clearPendingConsultOnLeave :: ${SYS_CLEAR_TECH_LEAD_FIELDS_SQL.join(', ')}, updated_at=datetime('now','localtime')",
      "router.post /sys-issues/:id/submit/withdraw :: ${SYS_CLEAR_FAST_RELEASE_AUTH_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime')",
      "router.post /sys-issues/:id/edit-in-revision :: ${setFrags.join(', ')}, updated_at = datetime('now','localtime')",
      "router.post /sys-issues/:id/cancel-consult :: ${SYS_CLEAR_TECH_LEAD_FIELDS_SQL.join(', ')}, updated_at=datetime('now','localtime')",
      "router.post /sys-issues/:id/estimate :: dev_estimated_at = ?, ${effortSetFrag} eta_overrun_reason_code = ?, eta_overrun_reason_note = ?, updated_at = datetime('now','localtime')",
      "router.post /sys-issues/:id/unblock :: ${SYS_CLEAR_BLOCKED_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime')",
      "router.post /sys-issues/:id/scope-change :: ${setFrags.join(', ')}, updated_at = datetime('now','localtime')",
      "_publishReleaseCoreInTxn :: ${SYS_CLEAR_FAST_RELEASE_AUTH_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime')",
      'router.get /sys-issues/:id/notify-read-status :: ${col} = ?',
    ];
    const dynamicKeys = src => extractDynamicSetSites(src).map(s => s.owner + ' :: ' + s.setBody).sort();
    assert.deepStrictEqual(dynamicKeys(indexSrc), DYNAMIC_SET_REGISTRY.slice().sort(), '[S②c] 动态 SET 写点必须与登记表逐条全等');
    // [S②d] 登记表只绑名字不绑内容：逐个核登记片段的来源定义（每个名字恰好一处声明），其中任何字符串
    //   都不得含 status 赋值、也不得是字段名 status——有人往清空常量 / 可编辑字段表里加 status 时在这里红。
    const { declaredStrings } = require('./_sys-status-write-sites');
    const intakeGateSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'intake-gate-sql.js'), 'utf8');
    const FRAGMENT_SOURCES = [
      [indexSrc, 'SYS_CLEAR_BLOCKED_FIELDS_SQL'], [indexSrc, 'SYS_CLEAR_FAST_RELEASE_AUTH_FIELDS_SQL'],
      [indexSrc, 'EDIT_TIER_A_FIELDS'], [indexSrc, 'notifyResetSql'], [indexSrc, 'effortSetFrag'],
      [intakeGateSrc, 'SYS_CLEAR_TECH_LEAD_FIELDS_SQL'],
    ];
    for (const [src, name] of FRAGMENT_SOURCES) {
      const strings = declaredStrings(src, name);
      assert.ok(Array.isArray(strings) && strings.length > 0, '[S②d] ' + name + ' 必须恰好一处声明且含字符串');
      assert.deepStrictEqual(strings.filter(s => /\bstatus\s*=/i.test(s) || /^\s*status\s*$/i.test(s)), [], '[S②d] ' + name + ' 不得含 status');
    }
    ok('[S②] status UPDATE 写点精确八处（折叠拼接的语法扫描与去注释文本扫描两套计数全等）+ 十四处动态 SET 写点逐条登记 + 六个片段来源不含 status（常规写法回归防护，非完整性证明，见 _sys-status-write-sites.js 头注）');
    const EXPECTED_STATUS_WRITE_SITES = [
      { owner: 'runSysMigration', prefix: "UPDATE sys_issues SET status = '待指派'", where: "WHERE type IN ('feature','improvement') AND status IN ('待评估','已排期')", reachable: false },
      { owner: 'runSysMigration', prefix: "UPDATE sys_issues SET status = '待受理'", where: "WHERE status = '待商议'", reachable: false },
      { owner: 'runWGate', prefix: "UPDATE sys_issues SET status = ?, updated_at = datetime('now','localtime')", where: 'WHERE id = ? AND status = ?', reachable: true, gateKind: 'runWGate' },
      { owner: 'attemptFastReleaseFlipInTxn', prefix: "UPDATE sys_issues SET status = '已上线',", where: "WHERE id = ? AND type = 'bug' AND status = '待验证' AND ${FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL}", reachable: false },
      { owner: 'sysIssueTransition', prefix: 'UPDATE sys_issues SET ${setClause}', where: 'WHERE id = ? AND status = ?${whereExtra}', reachable: true, gateKind: 'exempt' },
      { owner: 'router.post /sys-issues', prefix: 'UPDATE sys_issues SET status = ?', where: 'WHERE id = ? AND status = ?', reachable: false },
      { owner: 'router.post /sys-issues/:id/assign', prefix: "UPDATE sys_issues SET status = ?, updated_at = datetime('now','localtime'), gate_deferred_at = NULL", where: 'WHERE id = ? AND status = ?', reachable: false },
      { owner: '_publishReleaseCoreInTxn', prefix: "UPDATE sys_issues SET status = '已上线', released_at =", where: "WHERE release_id = ? AND status = '待上线'", reachable: false },
    ];
    assert.strictEqual(EXPECTED_STATUS_WRITE_SITES.length, writeSites.length, '[S③前置] 期望表与写点数全等');
    const matches = EXPECTED_STATUS_WRITE_SITES.map((expected, i) => {
      const hits = writeSites.filter(site => site.owner === expected.owner
        && site.sql.startsWith(expected.prefix)
        && site.sql.slice(site.sql.indexOf('WHERE ')) === expected.where);
      assert.strictEqual(hits.length, 1, '[S③] 写点 #' + i + ' 结构锚必须恰好命中一处：' + expected.owner);
      return hits[0];
    });
    assert.deepStrictEqual(matches.map(site => site.start), writeSites.map(site => site.start), '[S③] 八条结构锚的相对顺序必须全等');
    // Gate metadata below retains its original assertions. This extra syntax check binds the real
    // completion gate call to the owning function body (nested functions excluded) and to source
    // order before its status UPDATE. Execution order is proven by the runtime cases further down
    // ([M-gap3] etc.), not by this check.
    const gatedSite = matches[2];
    const calls = [];
    function collectGateCalls(node) {
      if (!node || typeof node.type !== 'string') return;
      if (node !== gatedSite.scope && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) return;
      if (node.type === 'CallExpression' && node.callee.name === 'resolveCompletionOverrunReasonForWrite'
          && node.start < gatedSite.start) calls.push(node);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(collectGateCalls);
        else if (value && typeof value.type === 'string') collectGateCalls(value);
      }
    }
    collectGateCalls(gatedSite.scope);
    assert.strictEqual(calls.length, 1, '[S③] 写点 #2 runWGate：同一函数体（不含嵌套函数）内、源码顺序在 UPDATE 之前恰有一个完成理由 gate 调用');
    const reachableSites = EXPECTED_STATUS_WRITE_SITES.filter(s => s.reachable);
    assert.strictEqual(reachableSites.length, 2, `[S③] 可达「待对接测试/待验证」的写点应恰 2 处，实得 ${reachableSites.length}`);
    assert.ok(reachableSites.some(s => s.gateKind === 'runWGate'), '[S③] 可达写点须含 runWGate（§14 闸门覆盖）');
    assert.ok(reachableSites.some(s => s.gateKind === 'exempt'), '[S③] 可达写点须含通用引擎（liaison_test_pass 显式豁免）');
    // 豁免子断言——正面证明 case 'liaison_test_pass' 代码块内不含理由闸函数引用（结构性撤闸证据，
    //   非仅凭①②数量对拍就断言"豁免"，同旧版 [S④] 精神保留）。
    const ltPassStart = indexCleanForWriteAudit.indexOf(`case 'liaison_test_pass': {`);
    const ltPassEnd = indexCleanForWriteAudit.indexOf(`case 'return': {`, ltPassStart);
    assert.ok(ltPassStart > 0 && ltPassEnd > ltPassStart, '[S③豁免子断言前置] 应能定位 case \'liaison_test_pass\' 代码块边界');
    const ltPassBlock = indexCleanForWriteAudit.slice(ltPassStart, ltPassEnd);
    assert.ok(!ltPassBlock.includes('resolveCompletionOverrunReasonForWrite'), '[S③豁免子断言] ⭐ case \'liaison_test_pass\' 代码块不应引用 resolveCompletionOverrunReasonForWrite（撤闸未彻底则本断言会红）');

    ok('[S③] 八条写点：语法归属、SQL 指纹唯一命中、相对顺序、原 reachable/gateKind 与豁免块断言、真实 gate 调用检查');
    const brokenSites = extractStatusWriteSites(indexSrc + '\nvoid "UPDATE sys_issues SET status = ? WHERE id = ?";');
    assert.notStrictEqual(brokenSites.length, 8, '[S④] 新增旁路写点必须打破八处计数');
    assert.strictEqual(brokenSites.length, 9, '[S④] 新增一处 status UPDATE 后总数必须恰为九');
    ok('[S④] 源码副本追加第九写点，计数断言红灯自证');
    // Retain both original S④b controls: status need not be the first SET field,
    // while notify_status and other suffix columns must not count as main status.
    const secondField = extractStatusWriteSites(indexSrc + '\nvoid "UPDATE sys_issues SET foo = ?, status = ? WHERE id = ?";');
    assert.strictEqual(secondField.length, 9, '[S④b] status 作为 SET 子句第二项追加后总数恰为 9');
    const suffixOnly = extractStatusWriteSites(indexSrc + '\nvoid "UPDATE sys_issues SET notify_status = ? WHERE id = ?";');
    assert.strictEqual(suffixOnly.length, 8, '[S④b-反向] 仅写 notify_status 时总数仍为 8');
    ok('[S④b] 非首项 status 正向计数 + notify_status 后缀反向排除，原有双向反证保留');
    // [S④c] 旁路写法自证：每种变体都必须打破 [S②]–[S②c] 组合门（语法计数 8、文本计数 8、动态登记全等），
    //   并钉住三项各自的取值（期望手写，不由被测函数生成）。
    const bypassVariants = [
      ['单引号拼接', "\nvoid ('UPDATE sys_issues SET ' + 'status = ? WHERE id = ?');", 9, 9, false],
      ['双引号拼接', '\nvoid dbRunAsync("UPDATE sys_issues SET " + "status = ? WHERE id = ?", []);', 9, 8, false],
      ['模板串拼接', '\nvoid (`UPDATE sys_issues SET ` + `status = ? WHERE id = ?`);', 9, 8, false],
      ['拆开关键字', '\nvoid ("UPDATE " + "sys_issues SET status = ? WHERE id = ?");', 9, 8, false],
      ['字面量前带 SQL 注释', '\nvoid `-- bump\n UPDATE sys_issues SET status = ? WHERE id = ?`;', 9, 9, false],
      ['单串多语句', "\nvoid 'BEGIN; UPDATE sys_issues SET status = ? WHERE id = ?';", 9, 9, false],
      ['小写关键字', "\nvoid 'update sys_issues set status = ? where id = ?';", 9, 9, false],
      ['变量代入列名', "\nconst __col = 'status'; void `UPDATE sys_issues SET ${__col} = ? WHERE id = ?`;", 8, 8, true],
      ['+= 追加 SET 子句', "\nlet __q = 'UPDATE sys_issues SET '; __q += 'status = ? WHERE id = ?';", 8, 9, true],
    ];
    const registrySorted = DYNAMIC_SET_REGISTRY.slice().sort();
    for (const [label, tail, expectedAst, expectedText, expectedDynamicChanged] of bypassVariants) {
      const astCount = extractStatusWriteSites(indexSrc + tail).length;
      const textCount = countStatusWritesByText(indexSrc + tail);
      const dynamicChanged = JSON.stringify(dynamicKeys(indexSrc + tail)) !== JSON.stringify(registrySorted);
      assert.deepStrictEqual([astCount, textCount, dynamicChanged], [expectedAst, expectedText, expectedDynamicChanged], '[S④c] ' + label + ' 三项取值');
      assert.ok(!(astCount === 8 && textCount === 8 && !dynamicChanged), '[S④c] ' + label + ' 必须打破组合门');
    }
    ok('[S④c] 九种旁路写法（三种引号拼接/拆关键字/前置注释/多语句/小写/变量列名/+= 追加）均被组合门判红');


  }
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await listenOnSafePort(server);
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5,6 / 对接人13）');

  // ══════════════════════════ [M] gap=3 触发 / gap=2 不触发（成对，经 submit ⑦ 边） ══════════════════════════
  {
    // gap=3：deadline=3 天前（服务端时钟锚定夹具，LOW-4）→ 完成当日(今天) - deadline = 3 天 ≥ 3，应触发必填。
    const dl3 = await serverTodayAnchored(-3);
    const id3 = await mkPendingFeature(dl3);
    const rNoReason = await submitDev(id3, 5);
    assert.strictEqual(rNoReason.status, 400, `[M-gap3] 不带理由应 400，实得 ${rNoReason.status} ${JSON.stringify(rNoReason.body)}`);
    assert.strictEqual(rNoReason.body.code, 'COMPLETION_OVERRUN_REASON_CODE_REQUIRED', `[M-gap3] code 应为 COMPLETION_OVERRUN_REASON_CODE_REQUIRED，实得 ${rNoReason.body.code}`);
    assert.strictEqual(await statusOf(id3), '开发中', '[M-gap3] ⭐ 400 后零残留：status 仍开发中（submit 未成功，未进入待对接测试）');
    const rOk = await submitDev(id3, 5, { completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: 'gap=3 触发探针' });
    assert.strictEqual(rOk.status, 200, `[M-gap3] 带理由应 200，实得 ${rOk.status} ${JSON.stringify(rOk.body)}`);
    // 【2026-08-14 闸边迁移】⭐ 正常 ⑦ 路径目标态是「待对接测试」，非旧版的「待验证」——feature 正常
    //   完成流是「开发中→待对接测试→（对接人验收）待验证」，本闸挂在第一条边，判定当下尚未到「待验证」。
    assert.strictEqual(await statusOf(id3), '待对接测试', '[M-gap3] ⭐ 应已进入待对接测试（⑦ 正常路径，非旧版误认为的待验证）');
    const row3 = await issueRow(id3);
    assert.strictEqual(row3.completion_overrun_reason_code, '需求变更', '[M-gap3] 库内理由码已落');
    assert.strictEqual(row3.completion_overrun_reason_note, 'gap=3 触发探针', '[M-gap3] 库内理由文本已落');
    const marker3 = await timelineByActionCode(id3, 'completion_overrun_reason');
    assert.strictEqual(marker3.length, 1, `[M-gap3] 应恰产出 1 条 completion_overrun_reason 留痕行，实得 ${marker3.length}`);
    assert.ok(marker3[0].summary.includes('超出期望完成 3 天'), `[M-gap3] 留痕文案应含"超出期望完成 3 天"，实得 "${marker3[0].summary}"`);
    // MED-1：200 成功响应体应携带 need_reason/gap_days 判定信息。
    assert.ok(rOk.body.completion_overrun, `[M-gap3] ⭐【MED-1】200 响应体应携带 completion_overrun 判定信息，实得 ${JSON.stringify(rOk.body)}`);
    assert.strictEqual(rOk.body.completion_overrun.need_reason, true, '[M-gap3] completion_overrun.need_reason 应为 true');
    assert.strictEqual(rOk.body.completion_overrun.gap_days, 3, '[M-gap3] completion_overrun.gap_days 应为 3');
    // MED-1：400 响应体应携带 need_reason:true + gap_days。
    assert.strictEqual(rNoReason.body.need_reason, true, '[M-gap3] ⭐【MED-1】400 响应体应携带 need_reason:true');
    assert.strictEqual(rNoReason.body.gap_days, 3, '[M-gap3] 400 响应体 gap_days 应为 3');
    ok('[M-gap3] gap=3（达到阈值）→ 缺理由 400（need_reason/gap_days 齐备）；带理由 200（进待对接测试，库内两列落值+独立留痕行+响应体判定信息齐备）');

    // gap=2：deadline=2 天前 → gap=2 < 3，不应触发，即使带了理由也不必填（不校验，静默清空/忽略）。
    const dl2 = await serverTodayAnchored(-2);
    const id2 = await mkPendingFeature(dl2);
    const r2 = await submitDev(id2, 5);
    assert.strictEqual(r2.status, 200, `[M-gap2] 不带理由应 200（gap=2 未达阈值），实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(await statusOf(id2), '待对接测试', '[M-gap2] 应已进入待对接测试');
    const row2 = await issueRow(id2);
    assert.strictEqual(row2.completion_overrun_reason_code, null, '[M-gap2] gap=2 未达阈值，理由码列应为 NULL');
    assert.strictEqual(row2.completion_overrun_reason_note, null, '[M-gap2] gap=2 未达阈值，理由文本列应为 NULL');
    const marker2 = await timelineByActionCode(id2, 'completion_overrun_reason');
    assert.strictEqual(marker2.length, 0, `[M-gap2] 不应产出 completion_overrun_reason 留痕行，实得 ${marker2.length}`);
    assert.ok(r2.body.completion_overrun, '[M-gap2] ⭐【MED-1】200 响应体应携带 completion_overrun 判定信息');
    assert.strictEqual(r2.body.completion_overrun.need_reason, false, '[M-gap2] completion_overrun.need_reason 应为 false');
    assert.strictEqual(r2.body.completion_overrun.gap_days, 2, '[M-gap2] completion_overrun.gap_days 应为 2（未达阈值但仍如实返回真实差值，非 null）');
    ok('[M-gap2] gap=2（未达阈值）→ 不必填，200，理由两列 NULL，零留痕行，响应体 need_reason:false/gap_days:2——与 [M-gap3] 成对钉住"达到 3 即触发"边界（非严格大于），服务端时钟锚定夹具防跨零点假红（LOW-4）');
  }

  // ══════════════════════════ [E] deadline 空不触发 ══════════════════════════
  {
    const id = await mkPendingFeature(undefined);   // deadline 未设
    const r = await submitDev(id, 5);
    assert.strictEqual(r.status, 200, `[E] deadline 空应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[E] deadline 空，理由码列 NULL');
    assert.strictEqual(row.completion_overrun_reason_note, null, '[E] deadline 空，理由文本列 NULL');
    ok('[E] deadline 为空 → 不适用，200，理由两列 NULL');
  }

  // ══════════════════════════ [C] improvement/bug 对照组——同样构造"超期"，零受影响 ══════════════════════════
  //   （无 LIAISON_TEST 族，不受本次闸边迁移影响，用例结构原样保留）
  {
    // improvement：无 LIAISON_TEST 族，全完成直接走 runWGate allComplete 分支进「待验证」（经 excuse 触发）。
    const idImp = await mkIssue('improvement', '开发中', daysAgo(10));
    const daImp = await mkMember(idImp, 5, '开发甲', 'pending');
    const rImp = await triggerGateViaExcuse(idImp, daImp, '[C] improvement 对照组');
    assert.strictEqual(rImp.status, 200, `[C-improvement] excuse 应 200，实得 ${rImp.status} ${JSON.stringify(rImp.body)}`);
    assert.strictEqual(await statusOf(idImp), '待验证', '[C-improvement] 应已进入待验证（无需理由，improvement 不受本闸约束）');
    const rowImp = await issueRow(idImp);
    assert.strictEqual(rowImp.completion_overrun_reason_code, null, '[C-improvement] ⭐ improvement 即便严重超期（gap=10），理由列仍 NULL——§14 明确排除的类型零受影响');
    const markerImp = await timelineByActionCode(idImp, 'completion_overrun_reason');
    assert.strictEqual(markerImp.length, 0, '[C-improvement] 不应产出 completion_overrun_reason 留痕行');

    // bug：同样无 LIAISON_TEST 族，处理中 → 待验证经 submit 端点（bug 流唯一 submit 路径，非 runWGate 决策树）。
    const idBug = await mkIssue('bug', '处理中', daysAgo(10));
    await mkMember(idBug, 5, '开发甲', 'pending');
    const rBugSubmit = await submitDev(idBug, 5, { bug_cause_note: '[C] bug 对照组' });
    assert.strictEqual(rBugSubmit.status, 200, `[C-bug] submit 应 200，实得 ${rBugSubmit.status} ${JSON.stringify(rBugSubmit.body)}`);
    assert.strictEqual(await statusOf(idBug), '待验证', '[C-bug] 应已进入待验证（无需理由，bug 不受本闸约束）');
    const rowBug = await issueRow(idBug);
    assert.strictEqual(rowBug.completion_overrun_reason_code, null, '[C-bug] ⭐ bug 即便严重超期（gap=10），理由列仍 NULL——§14 明确排除的类型零受影响');
    assert.strictEqual(rBugSubmit.body.completion_overrun, undefined, '[C-bug] ⭐【MED-1】非 feature 类型响应体不应携带 completion_overrun 键（本闸判定压根未触及，非"触及但恒空"）');
    ok('[C] improvement/bug 对照组：同样构造 gap=10 严重超期场景，两类型均 200 直接完成，理由两列恒 NULL，零 completion_overrun_reason 留痕行（§14「仅 feature」双重验证）');
  }

  // ══════════════════════════ [R] 缺 code/缺 note/超长/枚举外非法值 四类 400，且零残留 ══════════════════════════
  {
    const id = await mkPendingFeature(daysAgo(5));
    const baseTl = await timelineCount(id);
    const baseStatus = await statusOf(id);
    const baseRow = await issueRow(id);
    // 缺 code（未传）
    const r1 = await submitDev(id, 5, { completion_overrun_reason_note: '有说明没选码' });
    assert.strictEqual(r1.status, 400, `[R-缺code] 应 400，实得 ${r1.status}`);
    assert.strictEqual(r1.body.code, 'COMPLETION_OVERRUN_REASON_CODE_REQUIRED', '[R-缺code] 确切码');
    assert.strictEqual(await statusOf(id), baseStatus, '[R-缺code] 零残留：status 未变');
    assert.strictEqual(await timelineCount(id), baseTl, '[R-缺code] 零残留：timeline 未新增任何行（含主 submit 行与理由行）');
    let row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[R-缺code] 零残留：理由码列未写入');
    assert.strictEqual(row.updated_at, baseRow.updated_at, '[R-缺code] ⭐【LOW-5】零残留：updated_at 未刷新（submit 事务整体回滚，未到达"成功后无条件刷新"那一行）');
    assert.strictEqual(row.liaison_test_cycle_no, baseRow.liaison_test_cycle_no, '[R-缺code] ⭐【LOW-5】零残留：liaison_test_cycle_no 未自增（runWGate 的进 LIAISON_TEST CAS 未提交）');
    assert.strictEqual(row.liaison_test_recipient_id, baseRow.liaison_test_recipient_id, '[R-缺code] ⭐【LOW-5】零残留：liaison_test_recipient_id 未写入');
    // 枚举外非法值（不在 ETA_OVERRUN_REASON_CODES 五码之内的字符串）——同"缺 code"分支同码，因校验器
    // 逐字判据是 `ETA_OVERRUN_REASON_CODES.includes(code)`，枚举外值与未传值走同一 if 分支。
    const r1b = await submitDev(id, 5, { completion_overrun_reason_code: '这不是一个合法枚举值', completion_overrun_reason_note: '枚举外非法值探针' });
    assert.strictEqual(r1b.status, 400, `[R-枚举外] ⭐【LOW-5】应 400，实得 ${r1b.status} ${JSON.stringify(r1b.body)}`);
    assert.strictEqual(r1b.body.code, 'COMPLETION_OVERRUN_REASON_CODE_REQUIRED', '[R-枚举外] 确切码（枚举外值与未传值同归此码，非静默放行）');
    assert.strictEqual(await statusOf(id), baseStatus, '[R-枚举外] 零残留：status 未变');
    row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[R-枚举外] 零残留：理由码列未写入（枚举外值未被当合法值落库）');
    // 缺 note（未传）
    const r2 = await submitDev(id, 5, { completion_overrun_reason_code: '需求变更' });
    assert.strictEqual(r2.status, 400, `[R-缺note] 应 400，实得 ${r2.status}`);
    assert.strictEqual(r2.body.code, 'COMPLETION_OVERRUN_REASON_NOTE_REQUIRED', '[R-缺note] 确切码');
    assert.strictEqual(await statusOf(id), baseStatus, '[R-缺note] 零残留：status 未变');
    assert.strictEqual(await timelineCount(id), baseTl, '[R-缺note] 零残留：timeline 未新增任何行');
    row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_note, null, '[R-缺note] 零残留：理由文本列未写入');
    // 超长 note
    const r3 = await submitDev(id, 5, { completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: 'x'.repeat(301) });
    assert.strictEqual(r3.status, 400, `[R-超长note] 应 400，实得 ${r3.status}`);
    assert.strictEqual(r3.body.code, 'COMPLETION_OVERRUN_REASON_NOTE_TOO_LONG', '[R-超长note] 确切码（编码期按既有同族先例补的第三码）');
    assert.strictEqual(await statusOf(id), baseStatus, '[R-超长note] 零残留：status 未变');
    row = await issueRow(id);
    assert.strictEqual(row.updated_at, baseRow.updated_at, '[R-超长note] ⭐【LOW-5】零残留：updated_at 全程未被任一次失败尝试刷新');
    ok('[R] 缺 code 400 / 枚举外非法值 400（同归 CODE_REQUIRED）/ 缺 note 400 / 超长 400——四类均事务零提交，status/理由两列/timeline/updated_at/liaison_test_* 列组五处零残留（378-H5 单事务契约 + LOW-5 补齐）');
  }

  // ══════════════════════════ [T] 打回重提二次触发（liaison_test_return，非 return） ══════════════════════════
  //   【2026-08-14 闸边迁移】第一轮落点已是「待对接测试」而非「待验证」，"打回"对应动作相应从 return
  //   换成 liaison_test_return（对接测试打回）——该 case 同点同清理由两列，且花名册重置是"原地
  //   dev_status='pending'"（非 return/reopen 的软删+插新实例），比旧版更简单，无需 SQL 补写。
  {
    const id = await mkPendingFeature(daysAgo(4));
    const r1 = await submitDev(id, 5, { completion_overrun_reason_code: '技术难度超预期', completion_overrun_reason_note: '第一轮超期理由' });
    assert.strictEqual(r1.status, 200, `[T] 第一轮 submit 应 200，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(await statusOf(id), '待对接测试', '[T] 第一轮：应进入待对接测试');
    // 打回 → liaison_test_return，理由两列应被清空（同 return/reopen 同点同清）。
    const rReturn = await liaisonTestReturn(id);
    assert.strictEqual(rReturn.status, 200, `[T] 对接测试打回应 200，实得 ${rReturn.status} ${JSON.stringify(rReturn.body)}`);
    let row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[T] 打回后理由码列应被清空（同 eta_overrun_reason_* 同点同清）');
    assert.strictEqual(row.completion_overrun_reason_note, null, '[T] 打回后理由文本列应被清空');
    assert.strictEqual(row.status, '开发中', '[T] 打回后应回到开发中');
    const member5 = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5', [id]);
    assert.strictEqual(member5.dev_status, 'pending', '[T] ⭐ liaison_test_return 原地重置花名册（非 return 的软删+插新实例）——同一行 dev_status 直接回 pending');
    // liaison_test_return 同 return/reopen 一样清 dev_estimated_at/estimated_effort_days（isGateEligibleForVerify
    // 前提，SYS_CLEAR_FEASIBILITY_FIELDS_SQL）——真实链路会重新走 /estimate，本文件直接种回占位值。
    await run(`UPDATE sys_issues SET dev_estimated_at = ?, estimated_effort_days = 1 WHERE id = ?`, [futureEst(30), id]);
    const r2 = await submitDev(id, 5, { completion_overrun_reason_code: '资源冲突', completion_overrun_reason_note: '第二轮超期理由' });
    assert.strictEqual(r2.status, 200, `[T] 第二轮 submit 应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(await statusOf(id), '待对接测试', '[T] 第二轮：应重新进入待对接测试');
    row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, '资源冲突', '[T] 第二轮理由已落库（最新值覆盖）');
    // 按 action_code 筛出两行独立留痕——两轮各一条，历史不因列被清空而消失。
    const markers = await timelineByActionCode(id, 'completion_overrun_reason');
    assert.strictEqual(markers.length, 2, `[T] ⭐ 按 action_code 筛应恰得 2 行（两轮各一条历史留痕），实得 ${markers.length}`);
    assert.ok(markers[0].summary.includes('第一轮超期理由'), `[T] 第 1 行应含第一轮理由文本，实得 "${markers[0].summary}"`);
    assert.ok(markers[1].summary.includes('第二轮超期理由'), `[T] 第 2 行应含第二轮理由文本，实得 "${markers[1].summary}"`);
    ok('[T] 打回重提二次触发（liaison_test_return，闸边迁移后第一轮落点非待验证故改此动作）：打回同点同清理由两列 + 花名册原地重置为 pending + 重提再次超期 → 按 action_code=completion_overrun_reason 筛出恰 2 行独立留痕（历史不因列清空而丢失，write-only 教训同款验证）');
  }

  // ══════════════════════════ [N] 不超期路径清空残留 ══════════════════════════
  {
    const id = await mkPendingFeature(daysAhead(10));   // deadline 在未来，不可能超期
    const r = await submitDev(id, 5);
    assert.strictEqual(r.status, 200, `[N] deadline 未来应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[N] deadline 在未来，理由码列 NULL');
    const marker = await timelineByActionCode(id, 'completion_overrun_reason');
    assert.strictEqual(marker.length, 0, '[N] 不应产出留痕行');
    ok('[N] deadline 在未来（gap 为负）→ 不适用，理由两列 NULL，零留痕行——与 [E]/[M-gap2] 共同覆盖"不满足条件"的三种成因（空/未达阈值/未来）');
  }

  // ══════════════════════════ [F2] 期望已过期受理单完成必触发（F2 副作用钉死） ══════════════════════════
  {
    const id = await mkPendingFeature(daysAgo(15));   // 严重过期（受理阶段早就已过期）
    const r = await submitDev(id, 5);
    assert.strictEqual(r.status, 400, `[F2] 应 400（必填未提供），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'COMPLETION_OVERRUN_REASON_CODE_REQUIRED', '[F2] 确切码');
    const rOk = await submitDev(id, 5, { completion_overrun_reason_code: '其他', completion_overrun_reason_note: 'F2 副作用钉死探针' });
    assert.strictEqual(rOk.status, 200, `[F2] 带理由应 200，实得 ${rOk.status} ${JSON.stringify(rOk.body)}`);
    ok('[F2] ⭐ 期望已过期（gap=15，受理阶段早已过期）受理单完成时仍必触发理由闸——F2 副作用钉死（受理迟不豁免完成侧判定）');
  }

  // ══════════════════════════ [D] SYS_DEADLINE_MALFORMED 独立 409 ══════════════════════════
  {
    const id = await mkPendingFeature(undefined);
    // 建单/编辑归一校验既有，正常链路不可能产出畸形非空值——这里用直接 DB UPDATE 模拟脏数据/迁移未生效场景。
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, ['2026-13-45', id]);   // 格式对但月日非法
    const baseTl = await timelineCount(id);
    const r = await submitDev(id, 5, { completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: '不应生效' });
    assert.strictEqual(r.status, 409, `[D] 畸形 deadline 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'SYS_DEADLINE_MALFORMED', '[D] 确切码 SYS_DEADLINE_MALFORMED');
    assert.strictEqual(await statusOf(id), '开发中', '[D] 零残留：status 未变（事务未提交，未进入待对接测试）');
    assert.strictEqual(await timelineCount(id), baseTl, '[D] 零残留：timeline 未新增任何行');
    const row = await issueRow(id);
    assert.strictEqual(row.completion_overrun_reason_code, null, '[D] 零残留：理由码列未写入（未进理由分支）');
    ok('[D] deadline 非法非空值（格式对但月日不存在）→ 独立 409 SYS_DEADLINE_MALFORMED，事务零提交，不进理由分支（379-M2\' 改判）');

    // 另造一单验证"纯格式非法"（正则都不匹配）同样归 409，非静默放行。
    const id2 = await mkPendingFeature(undefined);
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, ['not-a-date-at-all', id2]);
    const r2 = await submitDev(id2, 5);
    assert.strictEqual(r2.status, 409, `[D-纯格式非法] 应 409，实得 ${r2.status}`);
    assert.strictEqual(r2.body.code, 'SYS_DEADLINE_MALFORMED', '[D-纯格式非法] 确切码');
    ok('[D-纯格式非法] 完全非日期格式的 deadline 同样归 409 SYS_DEADLINE_MALFORMED，不静默放行');
  }

  // ══════════════════════════ [G] 成组探针（completion_overrun_reason_code/note 同空同非空） ══════════════════════════
  {
    assert.strictEqual(typeof I.completionOverrunGroupInvariantViolations, 'function', '[G前置] completionOverrunGroupInvariantViolations 应已导出');
    assert.deepStrictEqual(I.completionOverrunGroupInvariantViolations({ completion_overrun_reason_code: null, completion_overrun_reason_note: null }), [], '[G] 双空=合法');
    assert.deepStrictEqual(I.completionOverrunGroupInvariantViolations({ completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: '说明' }), [], '[G] 双非空=合法');
    // 红灯：半成品态应被判违例（双向证明，非空转绿灯）。
    const half1 = I.completionOverrunGroupInvariantViolations({ completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: null });
    assert.strictEqual(half1.length, 1, '[G红灯] 有码无文字应判 1 条违例');
    const half2 = I.completionOverrunGroupInvariantViolations({ completion_overrun_reason_code: null, completion_overrun_reason_note: '说明' });
    assert.strictEqual(half2.length, 1, '[G红灯] 有文字无码应判 1 条违例');
    ok('[G] 成组约束（同空同非空）双向验证：真实合法组合判 0 违例 + 人为构造半成品态判 1 违例（非空转绿灯）');

    // 全库扫描——本文件测试全程产出的所有行都应满足成组约束（真实写点自身结构性不会产出半成品，
    // resolveCompletionOverrunReasonForWrite 唯一出口恒同时写/同时清两列）。
    const allRows = await all('SELECT id, completion_overrun_reason_code, completion_overrun_reason_note FROM sys_issues');
    const violations = allRows.flatMap(r => I.completionOverrunGroupInvariantViolations(r).map(v => `#${r.id}: ${v}`));
    assert.deepStrictEqual(violations, [], `[G-全库] 本文件产出的全部 issue 行应零违例，实得 ${JSON.stringify(violations)}`);
    ok(`[G-全库] 全库扫描（${allRows.length} 行）零违例——真实写点结构性不产出半成品态`);
  }

  // ══════════════════════════ [LP] liaison_test_pass 撤闸正面证明 ══════════════════════════
  //   【2026-08-14 闸边迁移】正面证明：即便 deadline 严重超期，liaison_test_pass 也不拦截、不要求理由、
  //   不触碰理由两列——与迁移前"该动作是闸的唯一落点"形成对照，结构性证明"撤闸"是真实生效的行为，
  //   非仅注释声明（同 [[feedback_comment_is_review_input]] 纪律：注释说撤了，必须有行为断言撑住）。
  {
    // ① 造一单以短 gap（<3）经 submit 干净进入待对接测试（理由两列 NULL，无残留判定负担）。
    const id = await mkPendingFeature(daysAgo(1));
    const rSubmit = await submitDev(id, 5);
    assert.strictEqual(rSubmit.status, 200, `[LP前置] submit 应 200，实得 ${rSubmit.status} ${JSON.stringify(rSubmit.body)}`);
    assert.strictEqual(await statusOf(id), '待对接测试', '[LP前置] 应已进入待对接测试');
    const rowBefore = await issueRow(id);
    assert.strictEqual(rowBefore.completion_overrun_reason_code, null, '[LP前置] 理由两列应为 NULL（gap=1 未达阈值）');
    // ② 进入待对接测试后，把 deadline 改到严重过去（模拟"判定之后又过了很久才对接测试通过"这类真实
    //    业务时序——判定时刻早已固化在 submit 那一刻，deadline 后续再怎么变都不该影响已完成的判定）。
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, [daysAgo(100), id]);
    // ③ 不带任何 completion_overrun_reason_* 字段调用 liaison_test_pass——若闸仍挂在这里，严重超期
    //    （gap=100）必然 400 要求理由；若已撤闸，应正常 200 通过，且理由两列原样保持 NULL（未被
    //    liaison_test_pass 写入/覆盖）。
    const rPass = await liaisonTestPass(id);
    assert.strictEqual(rPass.status, 200, `[LP] ⭐ liaison_test_pass 面对 deadline 严重超期（gap=100）不应拦截（撤闸），实得 ${rPass.status} ${JSON.stringify(rPass.body)}`);
    assert.strictEqual(await statusOf(id), '待验证', '[LP] 对接测试通过后应进入待验证');
    const rowAfter = await issueRow(id);
    assert.strictEqual(rowAfter.completion_overrun_reason_code, null, '[LP] ⭐ liaison_test_pass 不应写入/生成理由列（撤闸后本函数对这两列零消费零生产）');
    assert.strictEqual(rowAfter.completion_overrun_reason_note, null, '[LP] 理由文本列同样保持 NULL');
    const markerAfterPass = await timelineByActionCode(id, 'completion_overrun_reason');
    assert.strictEqual(markerAfterPass.length, 0, '[LP] ⭐ 不应产出任何 completion_overrun_reason 留痕行（liaison_test_pass 结构上不再触碰该 action_code）');
    // ④ 即便 liaison_test_pass 请求体里显式带上理由字段（模拟前端残留旧代码误传），同样应被结构性
    //    忽略（该 case 从不读取 payload 的这两个键）——双向证明"不消费"而非"消费了但恰好没触发"。
    const id2 = await mkPendingFeature(daysAgo(1));
    await submitDev(id2, 5);
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, [daysAgo(50), id2]);
    const rPass2 = await liaisonTestPass(id2, { completion_overrun_reason_code: '其他', completion_overrun_reason_note: '即便传了也不该被消费' });
    assert.strictEqual(rPass2.status, 200, `[LP-④] 显式传理由字段仍应 200 通过（不校验/不消费），实得 ${rPass2.status}`);
    const row2After = await issueRow(id2);
    assert.strictEqual(row2After.completion_overrun_reason_code, null, '[LP-④] ⭐ 显式传入的理由字段应被结构性忽略——理由列仍 NULL，非被误写入');
    ok('[LP] liaison_test_pass 撤闸正面证明：严重超期（gap=100）不拦截+不写理由列+零留痕行；显式传理由字段同样被结构性忽略（双向证明"不消费"而非侥幸未触发）');
  }

  // ══════════════════════════ [W5/W6] runWGate feature⑤⑥降级路径——跳过对接测试段同样受闸（未受迁移影响） ══════════════════════════
  {
    // ⑤ deliverableCount===0：全员 excused（无人真正交付），直接从「开发中」跳「待验证」。触发动作结构上
    //   只能是 excuse（submit 恒把成员转成 code_submitted，一个"有交付物"的状态，永远不会产出
    //   deliverableCount=0 的完成态）——excuse 是 runWGate 的调用点之一，未传 payload（见该函数签名
    //   注释"已知窄边界"），故 completion_overrun_reason_code/note 结构性无法通过 excuse 端点带入。
    //   本组先验证"不超期"基线正常工作，再验证"超期"时的真实行为——excuse 本身会 400（响亮失败，非静默
    //   放行/非静默丢弃理由要求），且整体回滚零残留，符合 fail-closed 设计；不假装它能 200。
    const id5a = await mkIssue('feature', '开发中', daysAhead(10));   // deadline 未来，不超期基线
    const da5a = await mkMember(id5a, 5, '开发甲', 'pending');
    const r5a = await triggerGateViaExcuse(id5a, da5a, '[W5-基线] 全员 excused 降级探针（不超期）');
    assert.strictEqual(r5a.status, 200, `[W5-基线] 不超期应 200，实得 ${r5a.status} ${JSON.stringify(r5a.body)}`);
    assert.strictEqual(await statusOf(id5a), '待验证', '[W5-基线] ⭐ 应直接从开发中跳到待验证（跳过对接测试段，deliverableCount=0 降级路径）');
    assert.strictEqual((await issueRow(id5a)).completion_overrun_reason_code, null, '[W5-基线] 不超期，理由列 NULL');
    ok('[W5-基线] runWGate ⑤ 降级路径（全员 excused，deliverableCount=0）不超期时正常跳过对接测试段直接完成，理由两列 NULL');

    // 【2026-08-14 codex 395 预筛 NEW-1·defer 方案】行为变更：excuse（非 submit 触发）超期无理由此前是
    //   400（W5 旧断言），现改为不 400、不放行——置 gate_deferred_at + defer note，excuse 操作本身正常
    //   200 成功（花名册开脱这个动作确实发生了，只是"进待验证"这一步被结构性拦停，等开发本人 submit
    //   携理由才真正放行）。完整覆盖面见 [NEW-1] 组（本处保留一条最小烟雾，证明 W5 场景本身仍受本闸
    //   约束，只是响应形态变了）。
    const id5b = await mkIssue('feature', '开发中', daysAgo(6));   // deadline 已过，gap=6≥3
    const da5b = await mkMember(id5b, 5, '开发甲', 'pending');
    const r5b = await call('POST', `/api/sys-issues/${id5b}/dev-assignees/${da5b}/excuse`, adminTok, {
      reason: '[W5-已知边界] 全员 excused 降级探针（超期）',
      completion_overrun_reason_code: '依赖阻塞', completion_overrun_reason_note: '即便传了，excuse 端点当前也不转发',
    });
    assert.strictEqual(r5b.status, 200, `[W5-已知边界] ⭐【NEW-1 行为变更】excuse 端点未转发 payload 给 runWGate，超期时不再 400——改为 200 成功 + defer 挂起，实得 ${r5b.status} ${JSON.stringify(r5b.body)}`);
    assert.strictEqual(await statusOf(id5b), '开发中', '[W5-已知边界] 转移未发生：status 仍开发中（挂起，非放行）');
    const row5b = await issueRow(id5b);
    assert.ok(row5b.gate_deferred_at, '[W5-已知边界] gate_deferred_at 应已置位');
    const marker5b = await timelineByActionCode(id5b, 'completion_overrun_reason');
    assert.ok(marker5b.some(m => m.summary.includes('待开发报完工补原因')), `[W5-已知边界] 应产出 defer note，实得=${JSON.stringify(marker5b)}`);
    ok('[W5-已知边界] ⭐ runWGate ⑤ 降级路径超期时，excuse 端点当前不转发 completion_overrun_reason_* payload——NEW-1 defer 方案下 excuse 操作本身 200 成功 + 转移挂起（gate_deferred_at + defer note），不再是此前的 400（详见 [NEW-1] 组完整覆盖）');

    // ⑥ 对接人失效（intake_liaison_id=null）：有交付物但无有效对接人，同样降级跳过测试段。触发动作用
    //   submit（唯一转发 payload 的调用方）——需要"最后完成的那个人"是通过 submit 而非 excuse 达成全
    //   完成态，才能让 completion_overrun_reason_* payload 真正流过 runWGate。
    const id6 = await mkIssue('feature', '开发中', daysAgo(7), { intakeLiaisonId: null });
    await mkMember(id6, 5, '开发甲', 'code_submitted');   // 已有 1 份交付物（deliverableCount>0 前提）
    await mkMember(id6, 6, '开发乙', 'pending');           // 待这个人 submit 触发全完成态判定
    const r6NoReason = await submitDev(id6, 6);
    assert.strictEqual(r6NoReason.status, 400, `[W6] 缺理由应 400，实得 ${r6NoReason.status} ${JSON.stringify(r6NoReason.body)}`);
    assert.strictEqual(r6NoReason.body.code, 'COMPLETION_OVERRUN_REASON_CODE_REQUIRED', '[W6] 确切码');
    assert.strictEqual(await statusOf(id6), '开发中', '[W6] 零残留：400 后 status 未变（submit 事务整体回滚）');
    const memberRow6 = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=6', [id6]);
    assert.strictEqual(memberRow6.dev_status, 'pending', '[W6] 零残留：400 后花名册未变（dev_status 仍是 pending，非半成品态）');
    const r6Ok = await submitDev(id6, 6, { completion_overrun_reason_code: '其他', completion_overrun_reason_note: 'W6 降级路径探针（经 submit 转发）' });
    assert.strictEqual(r6Ok.status, 200, `[W6] 带理由应 200，实得 ${r6Ok.status} ${JSON.stringify(r6Ok.body)}`);
    assert.strictEqual(await statusOf(id6), '待验证', '[W6] ⭐ 应直接从开发中跳到待验证（对接人失效降级路径，跳过对接测试段）');
    const row6 = await issueRow(id6);
    assert.strictEqual(row6.completion_overrun_reason_code, '其他', '[W6] 库内理由码已落（经 submit 端点转发 payload 给 runWGate 成功）');
    const marker6 = await timelineByActionCode(id6, 'completion_overrun_reason');
    assert.strictEqual(marker6.length, 1, `[W6] 应恰产出 1 条 completion_overrun_reason 留痕行，实得 ${marker6.length}`);
    ok('[W6] runWGate ⑥ 降级路径（对接人失效，intake_liaison_id=null 但有交付物）——经 submit 端点（唯一转发 payload 的调用方）触发：缺理由 400 + 花名册/status 零残留，带理由 200 + 独立留痕行齐备');
  }

  // ══════════════════════════ [NEW-1] runWGate §14 三分支 defer 方案（codex 395 预筛 HIGH） ══════════════════════════
  //   ①payload 携有效理由→现行放行（已被 [M-gap3]/[T]/[W6] 等既有组覆盖）；②submit 触发但理由缺→现行
  //   400（[R]/[F2]/[W6-缺理由] 已覆盖）；③非 submit 触发且无理由载体→不 400 不放行，复用 gate_deferred_at
  //   挂起 + 专属 defer note，操作本身仍 200。本组补齐③的六个非 submit 端点集成用例 + 挂起后 submit 完成
  //   转移正例 + 恢复路断言。
  {
    const DEFER_TEXT_RE = /超期完成待开发报完工补原因（超出期望 (\d+) 天）/;
    async function assertDeferred(id, label) {
      const row = await issueRow(id);
      assert.strictEqual(row.status, '开发中', `[${label}] ⭐ 应仍留在开发中（转移未发生，非 400 非放行）`);
      assert.ok(row.gate_deferred_at, `[${label}] gate_deferred_at 应已置位`);
      const markers = await timelineByActionCode(id, 'completion_overrun_reason');
      const deferRow = markers.find(m => DEFER_TEXT_RE.test(m.summary));
      assert.ok(deferRow, `[${label}] ⭐ 应产出"超期完成待开发报完工补原因"defer note，实得=${JSON.stringify(markers)}`);
      return deferRow;
    }

    // ① reassign（非 submit 触发，纯移除差量达成全完成态）
    {
      const id = await mkIssue('feature', '开发中', daysAgo(5));
      await mkMember(id, 5, '开发甲', 'code_submitted');
      await mkMember(id, 6, '开发乙', 'pending');
      const r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { reason: '[NEW-1-reassign]', member_ids: [5] });
      assert.strictEqual(r.status, 200, `[NEW-1-reassign] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      const deferRow = await assertDeferred(id, 'NEW-1-reassign');
      assert.ok(deferRow.summary.includes('超出期望 5 天'), `[NEW-1-reassign] gapDays 应为 5，实得="${deferRow.summary}"`);
      ok('[NEW-1-reassign] 非 submit 触发（reassign 纯移除达成全完成态）+ 超期无理由 → 操作 200 成功 + 转移未发生 + gate_deferred_at 置位 + defer note 齐备');
    }

    // ② dev-assignees DELETE（移除末一名 pending）
    {
      const id = await mkIssue('feature', '开发中', daysAgo(5));
      await mkMember(id, 5, '开发甲', 'code_submitted');
      const daB = await mkMember(id, 6, '开发乙', 'pending');
      const r = await call('DELETE', `/api/sys-issues/${id}/dev-assignees/${daB}`, adminTok, { reason: '[NEW-1-delete]' });
      assert.strictEqual(r.status, 200, `[NEW-1-delete] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-delete');
      ok('[NEW-1-delete] 非 submit 触发（移除末一名 pending 达成全完成态）+ 超期无理由 → 操作 200 + defer 齐备');
    }

    // ③ excuse（⑤ 降级路径，deliverableCount=0）——同 [W5-已知边界] 场景，行为由 400 改为 200+defer。
    {
      const id = await mkIssue('feature', '开发中', daysAgo(6));
      const daA = await mkMember(id, 5, '开发甲', 'pending');
      const r = await triggerGateViaExcuse(id, daA, '[NEW-1-excuse]');
      assert.strictEqual(r.status, 200, `[NEW-1-excuse] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-excuse');
      ok('[NEW-1-excuse] 非 submit 触发（⑤ 降级路径 excuse）+ 超期无理由 → 操作 200 + defer 齐备（此前是 400，本批 defer 方案的直接行为变更）');
    }

    // ③b【2026-08-14 codex 396 NEW-1 补证】重复触发去重——同一挂起态被多次非 submit 触发命中，只应
    //   留痕 1 条 defer note（此前每次命中都无条件 INSERT，是纯审计噪声）。直调 I.runWGate（同签名，
    //   同 §14 判据源）模拟"另一个非 submit 触发点"再次命中同一挂起态，而非再经一次 HTTP 端点——多数
    //   端点自身有"已处理过就不能再调一次"的业务前置门（如 unblock 的 NOT_BLOCKED 409），不适合用来
    //   模拟"多个不同触发点命中同一挂起态"这个场景；runWGate 本身才是所有触发点共用的唯一收敛点。
    {
      const id = await mkIssue('feature', '开发中', daysAgo(6));
      const daA = await mkMember(id, 5, '开发甲', 'pending');
      const r = await triggerGateViaExcuse(id, daA, '[NEW-1-重复挂起去重]');
      assert.strictEqual(r.status, 200, `[NEW-1-重复挂起去重] 首次触发应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-重复挂起去重-首次');
      const marksAfterFirst = await timelineByActionCode(id, 'completion_overrun_reason');
      assert.strictEqual(marksAfterFirst.length, 1, `[NEW-1-重复挂起去重] 首次触发后应恰 1 条 defer note，实得 ${marksAfterFirst.length}`);
      // 直调 runWGate 模拟第二、第三个非 submit 触发点在同一挂起态下再次命中——roster/deadline 均未变，
      // 理应再次落入分支③，但因去重判据（gate_deferred_at 已非空 + 已有未消费注记）应跳过 INSERT。
      const dupActor = { id: 1, name: '管理员' };
      await I.runWGate(id, 'feature', '开发中', dupActor);
      await I.runWGate(id, 'feature', '开发中', dupActor);
      const marksAfterRepeat = await timelineByActionCode(id, 'completion_overrun_reason');
      assert.strictEqual(marksAfterRepeat.length, 1, `[NEW-1-重复挂起去重] ⭐ 同一挂起态被再触发 2 次后，defer note 总数应仍恰 1 条（去重生效，非每次都新增），实得 ${marksAfterRepeat.length}：${JSON.stringify(marksAfterRepeat.map(m => m.summary))}`);
      const rowAfterRepeat = await issueRow(id);
      assert.ok(rowAfterRepeat.gate_deferred_at, '[NEW-1-重复挂起去重] gate_deferred_at 应仍保持置位（重复触发不清）');
      ok('[NEW-1-重复挂起去重] 同一挂起态被 3 次非 submit 触发命中（1 次 HTTP excuse + 2 次直调 runWGate 模拟其它触发点）→ defer note 恰 1 条（首次留痕，后续去重跳过），非每次都新增审计噪声');
    }

    // ④⑤⑥ estimate/feasibility/unblock（gate_deferred_at 消费分支）——SQL 预置一个"较早"defer 时刻，
    //   验证 COALESCE 不覆盖（"再次落③=保持挂起"的 no-op 语义）。
    const SEED_DEFER_AT = '2020-01-01 00:00:00';
    {
      const id = await mkIssue('feature', '开发中', daysAgo(7));
      await mkMember(id, 5, '开发甲', 'code_submitted');
      await run(`UPDATE sys_issues SET dev_estimated_at = NULL, gate_deferred_at = ?, assigned_at = datetime('now','-1 day') WHERE id = ?`, [SEED_DEFER_AT, id]);
      const r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok(5), {
        dev_estimated_at: futureEst(30), estimated_effort_days: 3,
        eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: '[NEW-1-estimate] 组C容差理由（与本闸测的完成超期闸是两件事，仅为通过前置校验）',
      });
      assert.strictEqual(r.status, 200, `[NEW-1-estimate] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-estimate');
      const rowAfter = await issueRow(id);
      assert.strictEqual(rowAfter.gate_deferred_at, SEED_DEFER_AT, '[NEW-1-estimate] ⭐ gate_deferred_at 应保持原 defer 时刻不变（COALESCE 不覆盖，no-op 语义）');
      ok('[NEW-1-estimate] gate_deferred_at 消费分支（estimate 补齐 ETA 这一资格维度）理由仍缺 → 再次落分支③保持挂起，COALESCE 不覆盖原 defer 时刻');
    }
    {
      const id = await mkIssue('feature', '开发中', daysAgo(7), { needsFeasibility: 1 });
      await mkMember(id, 5, '开发甲', 'code_submitted');
      await run(`UPDATE sys_issues SET gate_deferred_at = ?, assigned_at = datetime('now','-1 day') WHERE id = ?`, [SEED_DEFER_AT, id]);
      const r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok(5), {
        conclusion: '可行', requirement_confirm: '[NEW-1-feasibility] 需求理解确认', dev_estimated_at: futureEst(30), estimated_effort_days: 3,
        eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: '[NEW-1-feasibility] 组C容差理由（与本闸测的完成超期闸是两件事，仅为通过前置校验）',
      });
      assert.strictEqual(r.status, 200, `[NEW-1-feasibility] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-feasibility');
      const rowAfter = await issueRow(id);
      assert.strictEqual(rowAfter.gate_deferred_at, SEED_DEFER_AT, '[NEW-1-feasibility] ⭐ gate_deferred_at 应保持原 defer 时刻不变（COALESCE 不覆盖）');
      ok('[NEW-1-feasibility] gate_deferred_at 消费分支（feasibility 补齐评估这一资格维度）理由仍缺 → 再次落分支③保持挂起');
    }
    {
      const id = await mkIssue('feature', '开发中', daysAgo(7));   // 不带 needsFeasibility——本组直接 SQL 造 blocked=1，不经 /blocked 端点，无需满足其入口条件
      await mkMember(id, 5, '开发甲', 'code_submitted');
      await run(`UPDATE sys_issues SET blocked = 1, blocked_reason = '[NEW-1-unblock] 前置构造', blocked_at = datetime('now','localtime'), gate_deferred_at = ? WHERE id = ?`, [SEED_DEFER_AT, id]);
      const r = await call('POST', `/api/sys-issues/${id}/unblock`, adminTok, { reason: '[NEW-1-unblock] 解除受阻' });
      assert.strictEqual(r.status, 200, `[NEW-1-unblock] 操作本身应 200 成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
      await assertDeferred(id, 'NEW-1-unblock');
      const rowAfter = await issueRow(id);
      assert.strictEqual(rowAfter.gate_deferred_at, SEED_DEFER_AT, '[NEW-1-unblock] ⭐ gate_deferred_at 应保持原 defer 时刻不变（COALESCE 不覆盖）');
      ok('[NEW-1-unblock] gate_deferred_at 消费分支（unblock 补齐 blocked 这一资格维度）理由仍缺 → 再次落分支③保持挂起');
    }

    // ⑦ 挂起后 submit 携理由完成转移正例——同一单，先由 excuse 触发挂起（deliverableCount=0 分支，见
    //   上方③已证），再由 admin 补一名新开发成员、新成员 submit 携理由，验证真正放行转移。
    {
      const id = await mkIssue('feature', '开发中', daysAgo(6));
      const daA = await mkMember(id, 5, '开发甲', 'pending');
      const rExcuse = await triggerGateViaExcuse(id, daA, '[NEW-1-submit恢复-excuse]');
      assert.strictEqual(rExcuse.status, 200, `[NEW-1-submit恢复] excuse 应 200，实得 ${rExcuse.status} ${JSON.stringify(rExcuse.body)}`);
      const deferRow1 = await assertDeferred(id, 'NEW-1-submit恢复-挂起态');
      // 恢复路①：admin 补一名新开发成员，由新成员 submit 携理由完成转移（方案"补充开发成员后由成员报
      // 完工时填写原因"指路文案对应的真实路径）。
      const rAdd = await call('POST', `/api/sys-issues/${id}/dev-assignees`, adminTok, { user_ids: [6] });
      assert.strictEqual(rAdd.status, 200, `[NEW-1-submit恢复] 加人应 200，实得 ${rAdd.status} ${JSON.stringify(rAdd.body)}`);
      const rSubmit = await submitDev(id, 6, { completion_overrun_reason_code: '需求变更', completion_overrun_reason_note: 'NEW-1 挂起恢复：新成员报完工补理由' });
      assert.strictEqual(rSubmit.status, 200, `[NEW-1-submit恢复] submit 携理由应 200，实得 ${rSubmit.status} ${JSON.stringify(rSubmit.body)}`);
      assert.strictEqual(await statusOf(id), '待对接测试', '[NEW-1-submit恢复] ⭐ 携理由 submit 后应真正放行转移（进待对接测试，非继续挂起）');
      const rowAfter = await issueRow(id);
      assert.strictEqual(rowAfter.completion_overrun_reason_code, '需求变更', '[NEW-1-submit恢复] 理由已落库');
      assert.strictEqual(rowAfter.gate_deferred_at, null, '[NEW-1-submit恢复] ⭐ 转移放行时 gate_deferred_at 应随 enteringForward 清 deferred 既有逻辑一并清空');
      const markersAfter = await timelineByActionCode(id, 'completion_overrun_reason');
      assert.ok(markersAfter.length >= 2, `[NEW-1-submit恢复] ⭐ 应至少 2 条 completion_overrun_reason 行（挂起 defer note + 放行后真实理由 note），实得 ${markersAfter.length}`);
      assert.ok(markersAfter.some(m => DEFER_TEXT_RE.test(m.summary)), '[NEW-1-submit恢复] 历史应保留挂起阶段的 defer note（不因后续放行而消失）');
      assert.ok(markersAfter.some(m => m.summary.includes('需求变更：NEW-1 挂起恢复：新成员报完工补理由')), '[NEW-1-submit恢复] 应新增一条放行阶段的真实理由 note');
      // 【2026-08-14 codex 396 NEW-3 补充】此前 [NEW-3-后端] 只对"随便查到的最新一行"断言三键存在，未
      //   区分"携理由放行"与"无理由 defer"两条不同分支产出的行各自应有的**值**（存在 ≠ 值对）。本组
      //   两条 note 恰好同一 issue 都有、语义明确，就地各断一次三键的具体取值（非仅键名存在）。
      const deferNoteAfter = markersAfter.find(m => DEFER_TEXT_RE.test(m.summary));
      const releaseNoteAfter = markersAfter.find(m => m.summary.includes('需求变更：NEW-1 挂起恢复：新成员报完工补理由'));
      assert.ok(deferNoteAfter && deferNoteAfter.payload_json, '[NEW-1-submit恢复][NEW-3补充] defer note 应有非空 payload_json');
      const deferPayload = JSON.parse(deferNoteAfter.payload_json);
      assert.strictEqual(deferPayload.gap_days, 6, `[NEW-1-submit恢复][NEW-3补充] defer 分支 payload_json.gap_days 应=6（daysAgo(6) 构造），实得=${deferPayload.gap_days}`);
      assert.strictEqual(deferPayload.reason_code, null, `[NEW-1-submit恢复][NEW-3补充] defer 分支 payload_json.reason_code 应恒为 null（尚未补理由），实得=${JSON.stringify(deferPayload.reason_code)}`);
      assert.strictEqual(deferPayload.reason_note, null, `[NEW-1-submit恢复][NEW-3补充] defer 分支 payload_json.reason_note 应恒为 null，实得=${JSON.stringify(deferPayload.reason_note)}`);
      assert.ok(releaseNoteAfter && releaseNoteAfter.payload_json, '[NEW-1-submit恢复][NEW-3补充] 放行 note 应有非空 payload_json');
      const releasePayload = JSON.parse(releaseNoteAfter.payload_json);
      assert.strictEqual(releasePayload.gap_days, 6, `[NEW-1-submit恢复][NEW-3补充] 放行分支 payload_json.gap_days 应=6，实得=${releasePayload.gap_days}`);
      assert.strictEqual(releasePayload.reason_code, '需求变更', `[NEW-1-submit恢复][NEW-3补充] 放行分支 payload_json.reason_code 应=提交时传入的「需求变更」，实得=${JSON.stringify(releasePayload.reason_code)}`);
      assert.strictEqual(releasePayload.reason_note, 'NEW-1 挂起恢复：新成员报完工补理由', `[NEW-1-submit恢复][NEW-3补充] 放行分支 payload_json.reason_note 应=提交时传入原文，实得=${JSON.stringify(releasePayload.reason_note)}`);
      ok('[NEW-1-submit恢复][NEW-3补充] 同一单两条 completion_overrun_reason note 的 payload_json 三键值分别核对：defer 分支={gap_days:6,reason_code:null,reason_note:null}；放行分支={gap_days:6,reason_code:"需求变更",reason_note:提交原文}（非仅存在性断言，逐值核对）');
      ok(`[NEW-1-submit恢复] 挂起态（defer note 已产出，gapDays=${deferRow1 && deferRow1.summary.match(/\d+/)[0]}）后 admin 加新成员 → 新成员 submit 携理由 → 真正放行转移（进待对接测试）+ gate_deferred_at 清空 + defer note 历史保留 + 新增真实理由 note`);
    }
  }

  // ══════════════════════════ [NEW-3] payload_json 结构化 + 新旧两形态渲染 ══════════════════════════
  //   后端：completion_overrun_reason 两处 INSERT（分支①放行 / 分支③挂起）均已补 payload_json 列，
  //   结构化存 {gap_days, reason_code, reason_note}——已由 [NEW-1] 组各用例间接验证过写入成功（本组
  //   不重复起夹具，只额外断言 payload_json 列非空且可解析，见下）。前端：siCompletionOverrunGapFromTimeline
  //   新旧两形态渲染各一条（同 R6 范式：提取函数文本 new Function 编译执行，siCurTimeline 作为参数
  //   注入而非读全局，隔离测试）。
  {
    // 后端结构化写入抽查——直接查一条 [NEW-1-submit恢复] 组已产出的真实理由行，确认 payload_json 非空
    // 且可解析出预期三键（不重跑一次夹具，复用已有产物，省时间）。
    const anyReasonRow = await get(
      `SELECT payload_json FROM sys_issue_timeline WHERE action_code='completion_overrun_reason' AND payload_json IS NOT NULL ORDER BY id DESC LIMIT 1`
    );
    assert.ok(anyReasonRow && anyReasonRow.payload_json, '[NEW-3-后端] ⭐ 应能查到至少一条 completion_overrun_reason 行的 payload_json 非空（本文件前面各组已产出真实数据）');
    const parsedPayload = JSON.parse(anyReasonRow.payload_json);
    assert.ok('gap_days' in parsedPayload && 'reason_code' in parsedPayload && 'reason_note' in parsedPayload, `[NEW-3-后端] payload_json 应含 gap_days/reason_code/reason_note 三键，实得=${JSON.stringify(parsedPayload)}`);
    ok('[NEW-3-后端] completion_overrun_reason timeline 行 payload_json 结构化存 {gap_days,reason_code,reason_note}，真实产出数据可正确解析');

    // 前端渲染——提取 siCompletionOverrunGapFromTimeline 函数文本，new Function 编译执行（siCurTimeline
    // 作为参数注入，不依赖 HTML 里的全局变量声明）。
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
    const fnStart = htmlSrc.indexOf('function siCompletionOverrunGapFromTimeline() {');
    assert.ok(fnStart > 0, '[NEW-3-前端前置] 应能定位 siCompletionOverrunGapFromTimeline 函数起点');
    const fnEnd = htmlSrc.indexOf('\n    }', fnStart) + '\n    }'.length;
    const fnText = htmlSrc.slice(fnStart, fnEnd);
    assert.ok(fnText.includes('payload_json'), '[NEW-3-前端前置] 提取的函数文本应含 payload_json 分支，提取边界可能不对');
    // eslint-disable-next-line no-new-func
    const feFn = new Function('siCurTimeline', `${fnText}\nreturn siCompletionOverrunGapFromTimeline();`);

    // 新形态：payload_json 携 gap_days=3（结构化字段优先，不解析 summary）。
    const newFormatRows = [{
      action_code: 'completion_overrun_reason',
      summary: `完成超期（超出期望完成 999 天）——需求变更：故意与 payload_json 不一致，证明真的优先读结构化字段`,
      payload_json: JSON.stringify({ gap_days: 3, reason_code: '需求变更', reason_note: '说明' }),
    }];
    assert.strictEqual(feFn(newFormatRows), 3, '[NEW-3-前端-新形态] ⭐ payload_json 非空时应优先读其 gap_days（=3），忽略 summary 里刻意写错的 999');
    ok('[NEW-3-前端-新形态] siCompletionOverrunGapFromTimeline 对含 payload_json 的行优先读结构化 gap_days，不解析 summary 文本');

    // 旧形态：无 payload_json（历史行，本批之前产出），兜底走 summary 正则解析。
    const oldFormatRows = [{
      action_code: 'completion_overrun_reason',
      summary: `完成超期（超出期望完成 5 天）——需求变更：旧数据无 payload_json`,
      payload_json: null,
    }];
    assert.strictEqual(feFn(oldFormatRows), 5, '[NEW-3-前端-旧形态] ⭐ payload_json 为空的历史行应兜底走 summary 正则解析出 gap_days=5，不因升级导致存量行 kv 回显退化成空');
    ok('[NEW-3-前端-旧形态] siCompletionOverrunGapFromTimeline 对无 payload_json 的历史行兜底走 summary 正则解析，向后兼容');
  }



  server.close();
  console.log(`\n✅ verify-sys-completion-overrun 全绿：${passed} 组断言通过`);
  console.log('  覆盖：gap=2/3 成对边界（服务端时钟锚定夹具防跨零点假红）+ deadline 空/未来/畸形三态 + improvement/bug 对照组 + 缺code/枚举外非法值/缺note/超长四类400零残留(含updated_at/liaison_test_*列组) + 打回重提二次触发双留痕(liaison_test_return) + 期望已过期完成必触发(F2) + SYS_DEADLINE_MALFORMED独立409 + 成组探针(含红灯) + liaison_test_pass撤闸正面证明 + runWGate⑤⑥降级路径 + 状态写入汇点审计(NEW-4：transitions.js前进边枚举+index.js语法写点精确等值+结构锚唯一命中与顺序+gate调用+红灯自证)');
}

main().catch(e => { fail(e && e.stack || e); process.exit(1); });
