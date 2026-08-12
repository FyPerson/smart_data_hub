// scripts/verify-sys-liaison-test.js — C4 验收：待对接测试段（工期对接测试与风险等级拆分 方案 v1.1）
//   SSOT = 方案 v1.1 §3.0（决策树·D21 已删⑤）/§3.1（新状态+possibleTargets）/§3.1b（返工轮·D18）/
//          §3.5（矩阵）/§6（通知·D19/D20，本文件仅覆盖不涉及真实发送的部分）/§9（verify 计划）+
//          C0_矩阵验证清单 §A/§C/§D/§F
//   用法：node scripts/verify-sys-liaison-test.js
//
// 覆盖：
//   [1] 决策树 ⑦ 正例：全员完成+资格合格+对接人有效 → 进「待对接测试」+ 周期号自增 + 通知列组原子写入
//   [2] 决策树 ⑥ 正例：全员完成+资格合格+对接人失效 → 直落「待验证」，专用 actionCode 留痕，周期号不动
//   [3] 决策树 ②：花名册出现未知 dev_status → 阻断（保持不动，不推进任何方向）
//   [4] 决策树 ③：未全完成态 → 保持开发中 + S12 双路审查 Opus-1 HIGH 修复验证：全员 excused（无交付物）
//       不再进「待对接测试」死胡同，⑦ 准入前 deliverableCount===0 拦截分流到降级形态直落「待验证」
//       （action_code=liaison_test_skip_excused）+ last_completed_at 正确回填 + 反证全表扫描（零交付
//       单永不可达该态）
//   [5] 决策树 ④：全完成但资格不足（工期缺失）→ 落 gate_deferred_at，不进测试段也不降级
//   [6] liaison_test_pass：正例 + ①b 复查（roster 被绕过写坏 → 409·含 unknownCount 脏值反例）+ hasDeliverable 反例
//   [7] liaison_test_return：正例（原因必填+字段清理套餐-不计 return_count+花名册重置）+ D18 return_count 恒定断言
//   [8] 待对接测试态七写入口 409 矩阵（add/re-add/remove/self-remove/excuse/supersede-excuse/reassign）+ hold 400 锁死
//   [9] last_completed_at 白名单（C0 §F-8）：⑦ 正常/⑥ 降级/两轮完成取末次/resume 伪行排除
//   [10] meta[7] 严格相等回归（feature 含「待对接测试」·improvement 不含，双向精确差集）
//   [11] notify-liaison-test（D16/D19/D20）：授权矩阵+CAS生命周期+claim自愈+dry-run
//   [12] pass/return 授权负例矩阵（275-M6）：普通在册开发403/非池非本单403/对接人停用后403/admin 200
//   [13] codex 276-279 号审 H-1/M-1/L-1 收口：收件人竞态绑定(409+零外呼)/异常分类(结果未知 vs 确定失败)/
//        L-1 独立错误码(RESULT_UNKNOWN vs TIMEOUT)/stale_at 查询保护(M-1)/sent_externally=false 契约(H-1)/
//        NULL started_at 恢复/并发双发反证
//   [14] codex 277 号审 M-1：claim 自愈守卫加 sending 锁——sending 期间收件人不可被 claim 改动
//   [15] codex 277 号审 H-2：最终回写保护——单次异常重试成功仍 sent / 连续两次异常 200+writeback_failed 警示
//   [16] codex 277/278 号审 M-2/M-5：认证层同构替身测试——源码断言+最小可行复刻中间件（非真实服务入口
//        集成，见该段注释披露），停用账号 403+业务零执行
//
// in-process app + 内存库 + 自签 token，照 verify-sys-multidev-members.js 范式：issue/roster 直接 raw SQL
// 造数（本文件测的是 runWGate 决策树与两条新引擎边，非建单/受理/指派链路本身），真实 HTTP 调用触发被测端点。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const T = require('../routes/sys-iteration/transitions');
const SF = require('../routes/sys-iteration/status-families');

const SECRET = 'verify-sys-liaison-test-secret';
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

// C4b 新增：readSystemConfig/sendIssueDingtalkRaw 覆盖共享 stub（_sys-attach-test-deps.js 默认恒回
//   ''/{ok:true}，本文件需要可控开关（模拟 system_configs.sys_notify_dry_run）+ 调用计数（打桩断言
//   dry-run 时零真实发送）。放在 spread 之后覆盖同名键，其余脚本用的共享 stub 不受影响。
let dryRunConfigValue = null;   // null/'' = 关（默认，同现网缺失即关口径）；'on' = 开
let sendCallCount = 0;          // [11d] dry-run 打桩计数：断言开启时 sendIssueDingtalkRaw 调用次数=0
// [codex 276 号审 M-3 新增] 三个打桩开关，均为一次性/可复位，互不干扰其余用例（默认值=关闭态）：
//   sendShouldThrow：下次 sendIssueDingtalkRaw 调用直接 throw（模拟外呼异常，测 M-1 的异常收敛）；
//   sendDelayMs：下次调用前先 sleep 指定毫秒（模拟外呼耗时，测并发双发场景）；
//   recipientRaceInject：拦截 notify-liaison-test 端点读 issue 主行那次 dbGetAsync，一次性在返回前
//     注入 UPDATE 改写 liaison_test_recipient_id（模拟"预占前 recipient 被并发改动"的竞态窗口，H-1）。
let sendShouldThrow = null;
let sendDelayMs = 0;
let recipientRaceInject = null;   // { issueId, newRecipientId }
// ⭐ [C10-fix3 HIGH·codex 319-R 纵深] bindingRaceInject：同款一次性拦截——命中"notify-liaison-test 端点读
//   主行"那次 dbGetAsync（读出 boundId 快照）后，同步补一刀 UPDATE 改写 intake_liaison_id，模拟"读绑定→
//   取锁"之间对接人被并发改绑（防 L2 换对接人端点未来上线后的 TOCTOU；本模块当前**无该端点**，本注入是
//   构造未来场景以证明纵深闸门就位，非复现现网可触发 bug）。
let bindingRaceInject = null;   // { issueId, newLiaisonId }
// [codex 278 号审 H-1 新增] readSystemConfig 是 notify-liaison-test 端点"触达外呼之前"最先调用的一步——
// 用它模拟一次纯本地异常（无网络副作用），验证"确定失败"分支（区别于 sendShouldThrow 现在落在"结果
// 未知"分支，见下方 [13b] 改写）。
let readSystemConfigShouldThrow = null;
async function readSystemConfigStub(key) {
  if (readSystemConfigShouldThrow) {
    const err = readSystemConfigShouldThrow;
    readSystemConfigShouldThrow = null;   // 一次性
    throw (err instanceof Error ? err : new Error(String(err)));
  }
  if (key === 'sys_notify_dry_run') return dryRunConfigValue;
  return '';   // 其余 key 维持 _sys-attach-test-deps.js 原语义（非③脚本不触达）
}
// [codex 279 号审 H-1 打桩新增] sendShouldReturnFailure：一次性，让本函数**正常 resolve**为
// `{ok:false, reason}`（非 throw）——模拟 sendIssueDingtalkRaw 对"下游明确拒绝"场景的真实返回值协议
// （server.js:11937-11990，如 no_phone/token 失败等），验证 sendResult.ok===false 时 writeback 双败
// 分支的 sent_externally 正确落 false（与 sendShouldThrow 的"未分类裸抛→结果未知"是两条不同路径）。
let sendShouldReturnFailure = null;
async function sendIssueDingtalkRawCounting(_targetUser, _title, _md) {
  sendCallCount++;
  if (sendDelayMs) await new Promise(res => setTimeout(res, sendDelayMs));
  if (sendShouldThrow) {
    const err = sendShouldThrow;
    sendShouldThrow = null;   // 一次性
    throw (err instanceof Error ? err : new Error(String(err)));
  }
  if (sendShouldReturnFailure) {
    const reason = sendShouldReturnFailure;
    sendShouldReturnFailure = null;   // 一次性
    return { ok: false, reason };
  }
  return { ok: true, message_key: 'stub-liaison-test' };
}
// [H-1 竞态注入] 包一层 dbGetAsync——命中"notify-liaison-test 端点读主行"这条精确 SQL 文本 + 目标 issueId
// 时，先把要返回的行原样拿到，再同步补一刀 UPDATE 改写 recipient（一次性触发），模拟"这一行被读出快照
// 之后、CAS 预占之前，收件人已被并发改动"的窗口——不影响其余任何调用点（SQL 文本+issueId 双重精确匹配）。
// [codex 279 号审 M-1 打桩] staleAtQueryShouldThrow：一次性，命中 notify-liaison-test 端点"结果未知"
// 分支内计算 stale_at 那条精确 SQL 文本时抛异常——验证该辅助查询失败不连累核心响应语义（仍应 504 +
// LIAISON_TEST_NOTIFY_* 码，仅 stale_at 退化为 null）。
let staleAtQueryShouldThrow = null;
const STALE_AT_SQL_MARKER = 'SELECT liaison_test_attempt_started_at AS sat FROM sys_issues WHERE id = ?';
async function getWithRaceHook(sql, params) {
  if (staleAtQueryShouldThrow && sql === STALE_AT_SQL_MARKER) {
    const err = staleAtQueryShouldThrow;
    staleAtQueryShouldThrow = null;   // 一次性
    throw (err instanceof Error ? err : new Error(String(err)));
  }
  const row = await get(sql, params);
  if (recipientRaceInject && sql === 'SELECT * FROM sys_issues WHERE id = ?' && params && params[0] === recipientRaceInject.issueId) {
    const inject = recipientRaceInject;
    recipientRaceInject = null;   // 一次性
    await run(`UPDATE sys_issues SET liaison_test_recipient_id = ? WHERE id = ?`, [inject.newRecipientId, inject.issueId]);
  }
  // ⭐ [C10-fix3 HIGH·纵深] 改绑注入：读主行快照后改写 intake_liaison_id（一次性·SQL 文本+issueId 双精确匹配·
  //   与 recipientRaceInject 互不干扰，两个开关同时置空时本 hook 纯透传）。
  if (bindingRaceInject && sql === 'SELECT * FROM sys_issues WHERE id = ?' && params && params[0] === bindingRaceInject.issueId) {
    const inject = bindingRaceInject;
    bindingRaceInject = null;   // 一次性
    await run(`UPDATE sys_issues SET intake_liaison_id = ? WHERE id = ?`, [inject.newLiaisonId, inject.issueId]);
  }
  return row;
}
// [codex 277 号审 H-2 打桩] writebackThrowCount：剩余需要抛异常的次数（每命中一次递减）——命中条件用
//   writebackLiaisonTestNotify 那条 UPDATE 的**精确 WHERE 子句文本**（"WHERE id = ? AND
//   liaison_test_notify_status = 'sending' AND liaison_test_attempt_token = ?"，index.js:11164）匹配，
//   不会误伤 preemptLiaisonTestNotifySend 的 CAS SQL（那条虽也含 liaison_test_attempt_token 但是在 SET
//   子句里、且 WHERE 子句结构完全不同，不会命中这段精确文本）。
let writebackThrowCount = 0;
const WRITEBACK_SQL_MARKER = "WHERE id = ? AND liaison_test_notify_status = 'sending' AND liaison_test_attempt_token = ?";
async function runWithWritebackHook(sql, params) {
  if (writebackThrowCount > 0 && sql.includes(WRITEBACK_SQL_MARKER)) {
    writebackThrowCount--;
    throw new Error('模拟回写异常（DB busy/连接抖动等瞬时故障）');
  }
  return run(sql, params);
}
const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: runWithWritebackHook, dbGetAsync: getWithRaceHook, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  readSystemConfig: readSystemConfigStub,
  sendIssueDingtalkRaw: sendIssueDingtalkRawCounting,
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

// 用户种子：1=admin / 5,6=开发 / 13=对接人白名单（示例对接人，SYS_INTAKE_LIAISON_IDS 唯一成员）。
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
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 造数 helper（同 verify-sys-multidev-members.js 范式：raw SQL 直造 issue/roster，测的是 runWGate 决策树
//   与 liaison_test_pass/return 两条新引擎边本身，非建单/受理/指派链路）。──────────
//   intakeLiaisonId：默认=13（有效对接人，走 ⑦ 正常路径）；传 null 或不在池内的 id（如 999999）走 ⑥ 降级。
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const intakeLiaisonId = Object.prototype.hasOwnProperty.call(extra, 'intakeLiaisonId') ? extra.intakeLiaisonId : 13;
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, oa_number, intake_liaison_id, needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm, estimated_effort_days, return_count)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est, extra.oaNumber === null ? null : (extra.oaNumber || '20260728300'),
     intakeLiaisonId,
     extra.needsFeasibility || 0, extra.feasibilityConclusion || null, extra.feasibilityRequirementConfirm || null,
     // [C7 工时评估补全·方案 v1.7 §9.1] 工期资格从「nf=1 ∧ feature」扩到「feature/improvement × nf 两值」
     //   ——本文件夹具默认 needsFeasibility=0，C7 前从不过工期资格，C7 后 GATE 会因工期为空静默 defer，
     //   [1] 等"excuse 触发 W-GATE → 待对接测试"的断言会全线失守（失守形态是"状态没动"这种不报错的静默
     //   症状）。同 dev_estimated_at/oaNumber 既有处置：feature/improvement 默认种合法占位值；显式传
     //   null 可造"未填工期"态测该闸本身；bug/config 无工期维度恒不种。
     extra.estimatedEffortDays !== undefined ? extra.estimatedEffortDays
       : (['feature', 'improvement'].includes(type) ? 1 : null),
     extra.returnCount || 0]
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
async function memberRow(daId) { return get('SELECT * FROM sys_issue_dev_assignees WHERE id = ?', [daId]); }
async function latestTimeline(issueId) {
  return get(`SELECT * FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id DESC LIMIT 1`, [issueId]);
}
async function timelineRows(issueId) {
  return all(`SELECT * FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id ASC`, [issueId]);
}
// last_completed_at：与 index.js 两处子查询逐字同源（C0 §F-8），本文件直接复刻同一段 SQL 断言其真实取值
// （不信任端点响应，直查库——本文件专测这条 SQL 逻辑本身）。
async function lastCompletedAt(issueId) {
  const row = await get(
    `SELECT (SELECT MAX(created_at) FROM sys_issue_timeline
                WHERE issue_id = sys_issues.id AND event_type = 'status_change'
                  AND to_status = '待验证'
                  AND (action_code IS NULL OR action_code IN ('liaison_test_pass', 'liaison_test_skip_excused', 'liaison_test_skip_liaison'))
             ) AS last_completed_at
       FROM sys_issues WHERE id = ?`,
    [issueId]
  );
  return row ? row.last_completed_at : undefined;
}
// 触发 GATE 判定的最小手段：excuse 一名 pending 成员（同 verify-sys-multidev-members.js S10 系列范式）——
// 测的是 runWGate 本体反应，非 excuse 端点自身语义。
async function triggerGateViaExcuse(issueId, daId, reason = '触发 GATE 判定') {
  return call('POST', `/api/sys-issues/${issueId}/dev-assignees/${daId}/excuse`, adminTok, { reason });
}
// [11] notify-liaison-test 专用造数：造一个刚进入「待对接测试」、通知列组仍 not_sent 的新鲜单——
//   与 mkLiaisonTestIssue（[8] 段内联函数）同构，独立一份避免跨段耦合（[8] 段函数是段内闭包，
//   不对外暴露）。opts.intakeLiaisonId 默认 13（有效对接人，⑦ 正常进入）。
async function mkFreshLiaisonTestIssue(opts = {}) {
  const id = await mkIssue('feature', '开发中', { intakeLiaisonId: opts.intakeLiaisonId === undefined ? 13 : opts.intakeLiaisonId });
  await mkMember(id, opts.primaryDevId || 5, opts.primaryDevName || '开发甲', 'code_submitted');
  const daSecond = await mkMember(id, 6, '开发乙', 'pending');
  await triggerGateViaExcuse(id, daSecond, '进入测试段');
  assert.strictEqual(await statusOf(id), '待对接测试', 'mkFreshLiaisonTestIssue 前置：应已进入待对接测试');
  const row = await issueRow(id);
  return { id, cycle: row.liaison_test_cycle_no };
}

// [285 号合并轮 HIGH 收口] 通知跨列不变量全表扫描——封装成 helper，返回三类违例行数组（不在内部
//   断言，调用方按各自语境决定断言什么：[17] 断言"全为 0"，[17b] 先用它正面证明"能检出恰好 1 条"
//   再跑 409 断言、清理后再用它证明"清理后归零"，文件末尾再用它兜底扫一次——同一份探针在文件里
//   被调用 4 次，双向证明"探针真的有效"而非只会喊"没问题"。
//   SQL 用 `IS NOT` 而非 `!=`：liaison_test_notify_status 列 DDL 为
//   `TEXT NOT NULL DEFAULT 'not_sent'`（index.js :706），结构上恒非 NULL，`!=`与`IS NOT`在本列语义
//   等价；但显式用 `IS NOT` 是更稳的 SQL 惯用法——三值逻辑下 `IS NOT` 对 NULL 操作数天然给出正确
//   布尔结果，不依赖"这列碰巧不会是 NULL"这条外部约束假设逐字成立（278 号审同款先例）。前提写明：
//   这条约束是由 DDL 的 `NOT NULL DEFAULT 'not_sent'` 保证的，非本探针自行假设。
async function assertNotifyCrossColumnInvariant() {
  const illegalSending = await all(
    `SELECT id, liaison_test_notify_status AS ns, liaison_test_attempt_token AS tok, liaison_test_attempt_started_at AS sat
       FROM sys_issues
      WHERE liaison_test_notify_status = 'sending'
        AND (liaison_test_attempt_token IS NULL OR liaison_test_attempt_started_at IS NULL)`
  );
  const illegalNonSending = await all(
    `SELECT id, liaison_test_notify_status AS ns, liaison_test_attempt_token AS tok, liaison_test_attempt_started_at AS sat
       FROM sys_issues
      WHERE liaison_test_notify_status IS NOT 'sending'
        AND (liaison_test_attempt_token IS NOT NULL OR liaison_test_attempt_started_at IS NOT NULL)`
  );
  const illegalCycle = await all(
    `SELECT id, liaison_test_notify_cycle_no AS ncn, liaison_test_cycle_no AS mcn FROM sys_issues
      WHERE liaison_test_notify_cycle_no > liaison_test_cycle_no`
  );
  return { illegalSending, illegalNonSending, illegalCycle };
}

async function main() {
  mod.initSchema();
  await waitReady();
  // ⚠️ status 列必备：resolveActiveSysIntakeLiaisons()（hasValidLiaison 消费）查询
  // `WHERE id IN (...) AND status = 'active'`，缺列会在触发 GATE 判定时 500（本文件踩坑实测）。
  // [11] C4b 补：phone/dingtalk_user_id 两列——notify-liaison-test 端点会 SELECT 这两列构造钉钉发送对象
  //   （复刻 index.js notify-developer/notify-intake 等既有通道的 users 查询列集，同 verify-sys-bug-hold.js
  //   等既有 sys verify 脚本范式），此前 C4a 未覆盖通知端点，缺列未暴露。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13900000001'),(5,'dev5','开发甲','user','active','13900000005'),(6,'dev6','开发乙','user','active','13900000006'),
    (7,'dev7','开发丙','user','active','13900000007'),(8,'dev8','开发丁','user','active','13900000008'),(13,'wangtaotao','示例对接人','user','active','13900000013')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // [1] 决策树 ⑦ 正例：全员完成 + 资格合格 + 对接人有效 → 进「待对接测试」
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    const r = await triggerGateViaExcuse(id, daId2, '开发乙请假');
    assert.strictEqual(r.status, 200, `[1] excuse 触发 GATE 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待对接测试', '[1] ⭐ excuse 响应 main_status=待对接测试（⑦ 正常通过）');
    const row = await issueRow(id);
    assert.strictEqual(row.status, '待对接测试', '[1] 落库 status=待对接测试');
    assert.strictEqual(row.liaison_test_cycle_no, 1, '[1] ⭐ liaison_test_cycle_no 自增至 1（同一 CAS 内，不先读后写）');
    assert.strictEqual(row.liaison_test_notify_cycle_no, 1, '[1] liaison_test_notify_cycle_no 同得旧值+1');
    assert.strictEqual(row.liaison_test_recipient_id, 13, '[1] recipient_id=当前有效对接人');
    assert.strictEqual(row.liaison_test_recipient_name, '示例对接人', '[1] recipient_name 一并写入（免重复查 users 表）');
    assert.strictEqual(row.liaison_test_notify_status, 'not_sent', '[1] 通知列组原子重置为 not_sent（迎接本轮新周期）');
    assert.strictEqual(row.liaison_test_notified_at, null, '[1] notified_at 清空');
    assert.strictEqual(row.liaison_test_notify_message_key, null, '[1] message_key 清空');
    assert.strictEqual(row.liaison_test_attempt_token, null, '[1] attempt_token 清空');
    assert.strictEqual(row.liaison_test_attempt_started_at, null, '[1] attempt_started_at 清空');
    assert.strictEqual(row.gate_deferred_at, null, '[1] gate_deferred_at 清（进测试段=通过 GATE 的前向方向）');
    const tl = await latestTimeline(id);
    assert.strictEqual(tl.event_type, 'status_change', '[1] timeline mirror 行 event_type=status_change');
    assert.strictEqual(tl.from_status, '开发中', '[1] from=开发中');
    assert.strictEqual(tl.to_status, '待对接测试', '[1] to=待对接测试');
    assert.strictEqual(tl.action_code, null, '[1] ⭐ ⑦ 正常通过不写专用 actionCode（区别于 ⑥ 降级的 liaison_test_skip_liaison）');
    ok('[1] 决策树 ⑦ 正例：全员完成+资格合格+对接人有效 → 进「待对接测试」+ 周期号自增（不先读后写）+ 通知列组原子写入 + timeline mirror（无 actionCode）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [2] 决策树 ⑥ 正例：全员完成 + 资格合格 + 对接人失效 → 直落「待验证」（降级跳过测试段）
  // ══════════════════════════════════════════════════════════════════════
  {
    // intakeLiaisonId=999999：模拟"创建时刻恒有效、运行时因停用/移出白名单失效"（方案 §3.0-⑥ 前提修正，
    //   非"存量单从未有过对接人"这种已过时的旧表述）。
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 999999 });
    await mkMember(id, 5, '开发甲', 'no_code');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    const r = await triggerGateViaExcuse(id, daId2, '开发乙请假');
    assert.strictEqual(r.status, 200, `[2] excuse 触发 GATE 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[2] ⭐ excuse 响应 main_status=待验证（⑥ 降级跳过测试段）');
    const row = await issueRow(id);
    assert.strictEqual(row.status, '待验证', '[2] 落库 status=待验证（未经过待对接测试）');
    assert.strictEqual(row.liaison_test_cycle_no, 0, '[2] ⭐ liaison_test_cycle_no 不动（⑥ 降级不消费周期号，周期号只在 ⑦ 正常进入时自增）');
    assert.strictEqual(row.liaison_test_recipient_id, null, '[2] recipient_id 不写（未进测试段，无需通知对象）');
    assert.strictEqual(row.gate_deferred_at, null, '[2] gate_deferred_at 清（降级也是通过 GATE 的前向方向）');
    const tl = await latestTimeline(id);
    assert.strictEqual(tl.from_status, '开发中', '[2] from=开发中');
    assert.strictEqual(tl.to_status, '待验证', '[2] to=待验证（跳过待对接测试）');
    assert.strictEqual(tl.action_code, 'liaison_test_skip_liaison', '[2] ⭐ 专用 actionCode 留痕（探针防常态化用）');
    ok('[2] 决策树 ⑥ 正例：全员完成+资格合格+对接人失效（创建时刻有效·运行时停用/移出白名单） → 直落「待验证」，专用 actionCode=liaison_test_skip_liaison 留痕，周期号不动');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [3] 决策树 ②：花名册出现未知 dev_status → 阻断（保持不动，不推进任何方向）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    // dev_status 无 DDL CHECK 约束（新库/旧库均未加，核实过）——raw SQL 直插一个不在 4 态枚举内的脏值，
    // 模拟旧库 ALTER 路径/迁移遗留/手工改库产生的数据完整性缺口。
    await mkMember(id, 5, '开发甲', 'some_corrupted_value');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    const before = await issueRow(id);
    const r = await triggerGateViaExcuse(id, daId2, '触发②检查');
    assert.strictEqual(r.status, 200, `[3] excuse 端点自身应 200（②阻断的是 runWGate 后续推进，非 excuse 本身），实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '开发中', '[3] ⭐ ② 阻断：main_status 不推进（既不进测试段也不降级待验证）');
    const after = await issueRow(id);
    assert.strictEqual(after.status, '开发中', '[3] 落库 status 未变');
    assert.strictEqual(after.liaison_test_cycle_no, before.liaison_test_cycle_no, '[3] 周期号未变（阻断分支不触碰通知列组）');
    const tlCountAfter = (await timelineRows(id)).filter(t => t.event_type === 'status_change').length;
    assert.strictEqual(tlCountAfter, 0, '[3] 无 status_change timeline 行产生（阻断即刻返回，无 CAS 无 INSERT）');
    ok('[3] 决策树 ②：花名册出现未知 dev_status（DDL 无 CHECK 约束的防御性兜底）→ 阻断，主状态不推进任何方向，零副作用');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [4] 决策树 ③（未全完成态保持开发中）+ 全员 excused 死胡同修复验证（S12 双路审查 Opus-1 HIGH）
  // [S12 双路审查 Opus-1 HIGH 修复·行为变更] 下半段此前记录的是"全员 excused 通过 GATE 进 ⑦"（旧
  //   runWGate ⑦ 分支准入不查 deliverableCount 时的真实行为）——该行为本身是缺陷：单据进入待对接测试
  //   后，liaison_test_pass 会因 hasDeliverable=false 撞 409（LIAISON_TEST_PASS_INVARIANT），
  //   liaison_test_return 的花名册重置 UPDATE（WHERE dev_status IN ('code_submitted','no_code')）
  //   天然 0 行命中触发 500，待对接测试态花名册七写入口矩阵全 409，hold 同样被拒——单据落入仅剩
  //   void 能救的死胡同。本批在 runWGate ⑦ 分支准入前补 `deliverableCount === 0` 判定（见 index.js
  //   :2335 一带），零交付单被分流到与 ⑥ 同款的降级形态，直落「待验证」，专属 actionCode
  //   `liaison_test_skip_excused` 留痕。红→绿证据见交付报告（修复前本组断言应红：main_status 实得
  //   '待对接测试' 而非 '待验证'）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daId1 = await mkMember(id, 5, '开发甲', 'pending');
    await mkMember(id, 6, '开发乙', 'pending');
    const r = await triggerGateViaExcuse(id, daId1, '开发甲请假');
    assert.strictEqual(r.status, 200, `[4] excuse 应 200，实际 ${r.status}`);
    assert.strictEqual(r.body.main_status, '开发中', '[4] ③ 保持开发中（仍有 1 人 pending，activeCount>0 但 pendingCount>0）');
    ok('[4] 决策树 ③：activeCount>0 ∧ pendingCount>0 → 保持开发中（现状行为，未全完成不触发任何 GATE 分支）');

    const id2 = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const e1 = await mkMember(id2, 5, '开发甲', 'excused');
    const daId2b = await mkMember(id2, 6, '开发乙', 'pending');
    const r2 = await triggerGateViaExcuse(id2, daId2b, '开发乙也请假（全员 excused）');
    assert.strictEqual(r2.status, 200, `[4] 全员 excused 场景 excuse 应 200，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.main_status, '待验证', '[4] ⭐ S12-Opus-1 修复后：全员 excused（activeCount>0∧pendingCount=0∧deliverableCount=0）不再进「待对接测试」，⑦ 准入前被 deliverableCount 判定拦截分流，直落「待验证」（与 ⑥ 同款降级形态）');
    const roster2 = await all('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL', [id2]);
    assert.ok(roster2.every(x => x.dev_status === 'excused'), '[4] 全员在册行确实都是 excused（夹具构造有效，非假阳性）');
    const skipExcusedTl = await get(`SELECT action_code, created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='liaison_test_skip_excused'`, [id2]);
    assert.ok(skipExcusedTl, '[4] ⭐ timeline 落一条 action_code=liaison_test_skip_excused 的降级留痕行（区别于 ⑥ 的 liaison_test_skip_liaison，原因不同、落点相同）');
    assert.strictEqual(await lastCompletedAt(id2), skipExcusedTl.created_at, '[4] ⭐ last_completed_at 非 NULL，精确等于 skip_excused 事件时刻（该码在完成时刻白名单 :4662/:4734 早已在位，此前是死值，本次修复令其真正可达）');
    ok('[4] S12 双路审查 Opus-1 HIGH 修复验证：全员 excused（无交付物）不再卡死在待对接测试仅剩 void 能救——改走同款降级直落「待验证」+ action_code=liaison_test_skip_excused 留痕 + last_completed_at 正确回填');

    // 反证：零交付单永不可达「待对接测试」——全表扫描，覆盖本文件全部用例累积构造的 issue（含上方
    // id2 本身），确认没有任何一条"deliverableCount=0 但 status=待对接测试"的行存在。
    const zeroDeliverableInLiaisonTest = await all(
      `SELECT si.id FROM sys_issues si
        WHERE si.status = '待对接测试' AND si.type = 'feature'
          AND NOT EXISTS (
            SELECT 1 FROM sys_issue_dev_assignees da
             WHERE da.issue_id = si.id AND da.removed_at IS NULL
               AND da.dev_status IN ('code_submitted', 'no_code')
          )`
    );
    assert.strictEqual(zeroDeliverableInLiaisonTest.length, 0, `[4] ⭐ 反证：零交付单永不可达「待对接测试」——全表扫描应为 0 条，实际 ${zeroDeliverableInLiaisonTest.length}：${JSON.stringify(zeroDeliverableInLiaisonTest)}`);
    ok('[4] 反证：全表扫描确认「待对接测试」态的 feature 单必然带 ≥1 名 code_submitted/no_code 成员，零交付组合结构上不可达该态');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [5] 决策树 ④：全完成但资格不足（工期缺失）→ 落 gate_deferred_at，不进测试段也不降级
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中', {
      intakeLiaisonId: 13, needsFeasibility: 1, feasibilityConclusion: '可行', feasibilityRequirementConfirm: '已确认',
      estimatedEffortDays: null,   // 工期缺失 → isGateEligibleForVerify 判 false
    });
    await mkMember(id, 5, '开发甲', 'no_code');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    const r = await triggerGateViaExcuse(id, daId2, '开发乙请假');
    assert.strictEqual(r.status, 200, `[5] excuse 应 200，实际 ${r.status}`);
    assert.strictEqual(r.body.main_status, '开发中', '[5] ④ 资格不足：保持开发中（不进 ⑥ 也不进 ⑦，先落 deferred 等修复）');
    const row = await issueRow(id);
    assert.ok(row.gate_deferred_at, '[5] ⭐ gate_deferred_at 落位（等待工期补填端点消费重跑）');
    assert.strictEqual(row.liaison_test_cycle_no, 0, '[5] 周期号未动（未进入 ⑦）');
    assert.strictEqual(row.liaison_test_recipient_id, null, '[5] recipient 未写（未进入 ⑦）');
    ok('[5] 决策树 ④：全完成态但资格不足（工期缺失）→ 落 gate_deferred_at，既不降级也不进测试段（与 ⑥/⑦ 判定顺序上④在前）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [6] liaison_test_pass：正例 + ①b 复查（roster 被绕过写坏 → 409）+ hasDeliverable 反例
  // ══════════════════════════════════════════════════════════════════════
  {
    // [6a] 正例（⭐ D22-④ 批2改造：pass 现须凭证二选一，两个子例分别覆盖 test_note / 本轮附件两条路径；
    //   291 号 H-1/H-2 收口重写：附件"本轮"判定改 id 水位模型 + payload_json 结构化留痕断言）
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id, daId2, '进入测试段');
    assert.strictEqual(await statusOf(id), '待对接测试', '[6a] 前置：已进入待对接测试');
    const passR = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '手工验证通过，功能符合预期' });
    assert.strictEqual(passR.status, 200, `[6a] 对接人 pass（凭证=test_note）应 200，实际 ${passR.status} ${JSON.stringify(passR.body)}`);
    assert.strictEqual(passR.body.status, '待验证', '[6a] pass → 待验证');
    const tl = await latestTimeline(id);
    assert.strictEqual(tl.action_code, 'liaison_test_pass', '[6a] timeline action_code=liaison_test_pass');
    assert.strictEqual(tl.summary, '对接测试通过｜测试说明：手工验证通过，功能符合预期', '[6a] timeline summary 精确文案（80字展示摘要，完整凭证走 payload_json，291 号 H-2 收口后 summary 语义收窄）');
    const payload1a = JSON.parse(tl.payload_json);
    assert.deepStrictEqual(payload1a, { evidence: 'note', cycle_no: 1, test_note: '手工验证通过，功能符合预期' }, '[6a] ⭐ H-2 payload_json 精确形状：仅 evidence/cycle_no/test_note 三键（本轮无新附件，attachment_ids 不落键——仅有值时加键）');
    // admin 也应放行（roleGuard='intake_liaison' = 池∨admin）——本例改走"本轮已传附件"凭证路径（不传 test_note）
    const id1b = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    await mkMember(id1b, 5, '开发甲', 'code_submitted');
    const daId1b2 = await mkMember(id1b, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id1b, daId1b2, '进入测试段');
    // [codex 291 号 H-1 收口] 附件"本轮"判定改 id 水位模型（不再依赖 created_at 时间比较）：进入待对接
    //   测试的 CAS 已原子写入 liaison_test_attachment_watermark=进入那一刻的 MAX(附件id)（本例进入前
    //   本单无任何附件，水位=0）；随后插入的附件 id 天然 >0，落在"本轮"范围内，无需再手工构造任何
    //   created_at 时间偏移（旧模型靠 `datetime(?, '+1 second')` 规避同秒竞态假红，id 模型下
    //   AUTOINCREMENT id 严格递增、不依赖挂钟精度，同秒场景天然消解）。
    const insId1b = await run(
      `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
       VALUES (?, 'screenshot', 'x.png', '测试截图.png', 'active', 5, '开发甲')`,
      [id1b]
    );
    const passAdminR = await call('POST', `/api/sys-issues/${id1b}/liaison-test-pass`, adminTok, {});
    assert.strictEqual(passAdminR.status, 200, `[6a] admin pass（凭证=本轮附件，roleGuard=intake_liaison 含 admin）应 200，实际 ${passAdminR.status} ${JSON.stringify(passAdminR.body)}`);
    const tl1b = await latestTimeline(id1b);
    assert.strictEqual(tl1b.summary, '对接测试通过｜凭证：本轮测试附件', '[6a] ⭐ 仅附件路径 summary 精确文案（无 test_note 时的固定文案）');
    const payload1b = JSON.parse(tl1b.payload_json);
    assert.deepStrictEqual(payload1b, { evidence: 'attachment', cycle_no: 1, attachment_ids: [insId1b.lastID] }, '[6a] ⭐ H-2 payload_json 精确形状：仅 evidence/cycle_no/attachment_ids 三键（test_note 未传，不落键）');
    ok('[6a] liaison_test_pass 正例：对接人∨admin 均放行 200，落库待验证 + timeline action_code=liaison_test_pass + summary 精确文案 + payload_json 结构化留痕（test_note/本轮附件两条凭证路径各验一次）');

    // [6b] ①b 复查失败例①：roster 被绕过写坏（raw SQL 模拟七入口 409 被绕过的极端场景）——新增 pending 成员
    const id2 = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    await mkMember(id2, 5, '开发甲', 'no_code');
    const daId3 = await mkMember(id2, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id2, daId3, '进入测试段');
    assert.strictEqual(await statusOf(id2), '待对接测试', '[6b] 前置：已进入待对接测试');
    // ⚠️ 实测踩坑记录：本例原设计"raw SQL 插一个新 pending 成员模拟 roster 不完整"，但该场景在 [2b]
    //   generic assertMainStatusTransition 的③层门禁（"进入 SYS_VERIFY 要求在册≥1 且全完成态"）就已被
    //   拦下（400 GATE_INVARIANT，先于 switch case 内的①b 复查），①b 里的 passRosterComplete 子判定对
    //   这个具体场景是"结构性打不到"（不是没写，是更早一层防线已经先拦截）。①b 复查唯一能新增覆盖的
    //   缺口是 isGateEligibleForVerify——那是 generic 门禁完全不检查的维度（generic 只看 pending 计数，
    //   不看 blocked/feasibility/工期）。故本例改造为：roster 仍"完整"（无 pending，generic 门禁放行），
    //   但绕过写坏 blocked=1（模拟"进入测试段后 blocked 被脏写"的极端场景），验证①b 的资格复查确实
    //   起到 generic 门禁接不住的独立防线作用。
    await run(`UPDATE sys_issues SET blocked = 1, blocked_reason = '测试注入' WHERE id = ?`, [id2]);
    const passBadR = await call('POST', `/api/sys-issues/${id2}/liaison-test-pass`, liaisonTok, {});
    assert.strictEqual(passBadR.status, 409, `[6b] ①b 复查应拦资格不合格（blocked=1），实际 ${passBadR.status} ${JSON.stringify(passBadR.body)}`);
    assert.strictEqual(passBadR.body.code, 'LIAISON_TEST_PASS_INVARIANT', '[6b] 错误码 LIAISON_TEST_PASS_INVARIANT');
    assert.strictEqual(await statusOf(id2), '待对接测试', '[6b] 拒绝后状态不变（整事务回滚，未落库）');
    ok('[6b] liaison_test_pass ①b 复查：roster 无 pending（generic 门禁放行）但 isGateEligibleForVerify 不合格（blocked=1 脏写）→ 409 LIAISON_TEST_PASS_INVARIANT，证①b 复查覆盖 generic 门禁接不住的资格维度');

    // [6c] ①b 复查失败例②：hasDeliverable=false（全员被改为 excused，无 code_submitted/no_code 交付记录）
    const id3 = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daId4 = await mkMember(id3, 5, '开发甲', 'no_code');
    const daId5 = await mkMember(id3, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id3, daId5, '进入测试段');
    assert.strictEqual(await statusOf(id3), '待对接测试', '[6c] 前置：已进入待对接测试');
    // raw SQL 把唯一的 no_code 成员直接改成 excused——模拟"进入测试段后交付记录被抹除"的数据完整性极端场景
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='excused' WHERE id=?`, [daId4]);
    const passNoDeliverableR = await call('POST', `/api/sys-issues/${id3}/liaison-test-pass`, liaisonTok, {});
    assert.strictEqual(passNoDeliverableR.status, 409, `[6c] hasDeliverable=false 应 409，实际 ${passNoDeliverableR.status} ${JSON.stringify(passNoDeliverableR.body)}`);
    assert.strictEqual(passNoDeliverableR.body.code, 'LIAISON_TEST_PASS_INVARIANT', '[6c] 同一错误码（①b 复查是组合判定，不需要为 hasDeliverable 单独开码）');
    ok('[6c] liaison_test_pass ①b 复查：全员 excused（hasDeliverable=false，无 code_submitted/no_code）→ 409 LIAISON_TEST_PASS_INVARIANT');

    // [6d] ①b 复查失败例③（C4 合并修复批 275-M1 新增）：unknownCount>0 脏值反例——花名册同时存在合法
    //   交付行(code_submitted)与未知 dev_status 脏值行（非 pending）。**修复前的真实绕过面**：旧写法只数
    //   passPendingCount，脏值行不算 pending，会被误判"全完成"（passRosterComplete=true）+ hasDeliverable
    //   由那条合法交付行满足 → 会放行 pass（本应 409 却 200）。修复后 analyzeRosterForGate 显式给出
    //   unknownCount，①b 复查先检查它 > 0 直接拒绝。
    const id4x = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daId6 = await mkMember(id4x, 5, '开发甲', 'code_submitted');
    const daId7 = await mkMember(id4x, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id4x, daId7, '进入测试段');
    assert.strictEqual(await statusOf(id4x), '待对接测试', '[6d] 前置：已进入待对接测试');
    // raw SQL 把刚 excused 的成员改写成脏值（dev_status 列无 DDL CHECK，模拟迁移遗留/手工改库场景）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='some_corrupted_value' WHERE id=?`, [daId7]);
    const passUnknownR = await call('POST', `/api/sys-issues/${id4x}/liaison-test-pass`, liaisonTok, {});
    assert.strictEqual(passUnknownR.status, 409, `[6d] unknownCount>0 应 409，实际 ${passUnknownR.status} ${JSON.stringify(passUnknownR.body)}`);
    assert.strictEqual(passUnknownR.body.code, 'LIAISON_TEST_PASS_INVARIANT', '[6d] 错误码 LIAISON_TEST_PASS_INVARIANT');
    assert.strictEqual(await statusOf(id4x), '待对接测试', '[6d] 拒绝后状态不变（整事务回滚）');
    ok('[6d] ⭐ 275-M1 反例：花名册同时存在合法交付行(code_submitted)+未知 dev_status 脏值行(非pending) → 409（收敛前旧写法只数 pendingCount 会误判"全完成"放行，是 analyzeRosterForGate 收敛前的真实绕过面）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [6e-6i] ⭐ 方案 D22-④·批2（2026-08-06）新增，291 号 H-1/H-2/M-1/M-3 收口重写（2026-08-06）：pass
  //   凭证二选一闸门（"本轮附件"或"pass 当场填写的测试说明"，至少其一）。全部前置均已过①b 复查
  //   （roster 完整+资格合格+hasDeliverable），只测本组新增的凭证闸门本身。"本轮"边界批2原为
  //   created_at 时间比较（同一事务/同一秒插多行时精度不足），291 号 H-1 改为 id 水位模型——runWGate
  //   ⑦ 同一 CAS 原子写入 liaison_test_attachment_watermark=进入那一刻的 MAX(附件id)，凭证判定改
  //   "附件.id > watermark"，本组全部夹具随之从"手工构造 created_at 时间偏移"简化为"插入顺序天然
  //   保证 id 递增"，不再需要任何 `+1 second`/`-10 second` 技巧。[6g2] 为 M-1 新增（note+attachment
  //   同时存在→'both' 真三态）。红→绿证据见交付报告。
  // ══════════════════════════════════════════════════════════════════════
  {
    // [6e] 无凭证：既无 test_note 也无本轮附件 → 400 LIAISON_TEST_PASS_EVIDENCE_REQUIRED，零副作用
    //   （红→绿基准用例：D22-④ 生效前本请求应 200，是本批唯一"新增闸门直接挡住此前必过路径"的用例）。
    {
      const { id } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(r.status, 400, `[6e] 无凭证应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_PASS_EVIDENCE_REQUIRED', '[6e] 错误码 LIAISON_TEST_PASS_EVIDENCE_REQUIRED');
      assert.strictEqual(r.body.error, '请上传测试截图或填写测试说明', '[6e] 文案精确匹配（前端 toast 透传此文案）');
      assert.strictEqual(await statusOf(id), '待对接测试', '[6e] 拒绝后状态不变（零副作用，整事务回滚）');
      ok('[6e] ⭐ D22-④ 红→绿基准：无凭证（既无 test_note 也无本轮附件）→ 400 LIAISON_TEST_PASS_EVIDENCE_REQUIRED，零副作用（本批新增闸门前本请求应 200）');
    }

    // [6f] test_note 凭证：summary=80 字展示摘要（完整凭证在 payload_json——291 号 H-2 加列后本注释
    //   随 292 号收口修实，原「无 payload_json 列落 summary」表述已过时）+ 长文本截断 + 过长 400。
    {
      const { id } = await mkFreshLiaisonTestIssue();
      const longNote = '很长的测试说明。'.repeat(20);   // 8 字 * 20 = 160 字，超 80 字预览阈值，未超 500 字合法上限
      const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: longNote });
      assert.strictEqual(r.status, 200, `[6f] test_note 凭证应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestTimeline(id);
      const expectedPreview = longNote.slice(0, 80) + '…';
      assert.strictEqual(tl.summary, `对接测试通过｜测试说明：${expectedPreview}`, '[6f] ⭐ 留痕键名契约：summary 精确等于「对接测试通过｜测试说明：」+ 前80字+省略号（超80字截断，未超500字合法上限本身原样存入截断前逻辑，只预览层截断）');
      assert.ok(tl.payload_json, '[6f] payload_json 非空（完整凭证结构化留痕）');
      assert.strictEqual(JSON.parse(tl.payload_json).test_note, longNote, '[6f] ⭐ payload_json.test_note 保存截断前全文（summary 只是预览）');

      // [codex 292 号 L 收口·293 号 M-3 声称收窄] 注入面保真断言：**只证数据层**——恶意样式 test_note
      //   写入 200、payload_json 经 JSON.parse 读回逐字全等（参数绑定+JSON.stringify 无转义损伤）。
      //   渲染层防护是独立命题，由下方源码断言锁定 timeline 消费点走 esc()（非本用例的端到端证明——
      //   完整 XSS 端到端回归挂账，不在数据层用例声称范围内）。
      const { id: idInj } = await mkFreshLiaisonTestIssue();
      const evilNote = `<script>alert('x')</script>**md**"quo'te\\ 行内\`code\``;
      const rInj = await call('POST', `/api/sys-issues/${idInj}/liaison-test-pass`, liaisonTok, { test_note: evilNote });
      assert.strictEqual(rInj.status, 200, `[292-L] 恶意样式 test_note 应正常 200（数据层不做内容过滤），实际 ${rInj.status}`);
      const tlInj = await latestTimeline(idInj);
      assert.strictEqual(JSON.parse(tlInj.payload_json).test_note, evilNote, '[292-L] ⭐ payload_json 恶意串逐字保真（无二次转义/截断/吞字符）');

      // [293 号 M-3·294 号声称再收窄] 渲染点源码断言（**提醒性锁定，非 XSS 安全证明**——只证文件里
      //   存在该字面量，不证渲染路径必经；完整 XSS 端到端回归已登记挂账 sys_iteration_backlog）。
      const feHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
      assert.ok(feHtml.includes('e.summary ? esc(e.summary)'), '[293-M3] 提醒性源码锁定：esc(e.summary) 字面量在位（改写时本断言先红提醒重审·非安全证明）');

      // [294 号 M-2 收口·295 号强度写实] 附件表写点唯一性——把「无恢复路径」从注释声称升级为断言触发
      //   （未来在**本文件**加同款字面量的恢复端点时断言先红·codex「由测试而非注释触发重审」落地形态）。
      //   ⚠️ 提醒性非穷尽：固定字面量匹配，换行/大小写/动态 SQL/他模块写入可绕过（295-M1）——与 [293-M3]
      //   同为提醒层锁定，不是穷尽性保证。
      const beSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
      const attUpdates = beSrc.match(/UPDATE sys_issue_attachments SET/g) || [];
      assert.strictEqual(attUpdates.length, 1, `[294-M2] ⭐ sys_issue_attachments 全文件 UPDATE 写点应恰 1 处（置 superseded 单向软删）——出现第 2 处（如恢复端点）须重审水位模型语义，实际 ${attUpdates.length} 处`);
      assert.ok(beSrc.includes(`UPDATE sys_issue_attachments SET status = 'superseded'`), '[294-M2] 唯一写点方向=置 superseded（单向·恢复为 active 的写路径不存在）');

      // [293 号 L] trim 契约锁定：payload_json 保存的是 **trim 后全文**（首尾空白丢弃=有意契约，非「逐字
      //   原样」——292 直改批注释曾用「全文」措辞被 293 号抓语义过宽，此处以断言钉死真实契约）。
      const { id: idTrim } = await mkFreshLiaisonTestIssue();
      const padded = '  首尾带空白的说明\t ';
      const rTrim = await call('POST', `/api/sys-issues/${idTrim}/liaison-test-pass`, liaisonTok, { test_note: padded });
      assert.strictEqual(rTrim.status, 200, `[293-L] 首尾空白 test_note 应 200，实际 ${rTrim.status}`);
      assert.strictEqual(JSON.parse((await latestTimeline(idTrim)).payload_json).test_note, padded.trim(), '[293-L] ⭐ payload_json.test_note === trim 后文本（首尾空白丢弃=锁定契约）');

      const { id: id2 } = await mkFreshLiaisonTestIssue();
      const tooLongNote = 'x'.repeat(501);
      const r2 = await call('POST', `/api/sys-issues/${id2}/liaison-test-pass`, liaisonTok, { test_note: tooLongNote });
      assert.strictEqual(r2.status, 400, `[6f] test_note 超 500 字应 400，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.code, 'LIAISON_TEST_NOTE_TOO_LONG', '[6f] 错误码 LIAISON_TEST_NOTE_TOO_LONG');
      assert.strictEqual(await statusOf(id2), '待对接测试', '[6f] 超长拒绝后状态不变');
      ok('[6f] test_note 凭证路径：200+summary 精确留痕（超80字预览截断）+ 超500字 400 LIAISON_TEST_NOTE_TOO_LONG');
    }

    // [6g] 本周期新传附件免 test_note：delivery 类型（与 [6a] 的 screenshot 互补，两种合法类型各验一次）。
    //   291 号 H-1 收口：附件插入不再依赖 created_at 时间偏移，天然靠插入顺序 id 递增落在本轮水位之后。
    {
      const { id } = await mkFreshLiaisonTestIssue();
      const insDelivery = await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
         VALUES (?, 'delivery', 'd.zip', '交付物.zip', 'active', 5, '开发甲')`,
        [id]
      );
      const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(r.status, 200, `[6g] 本周期 delivery 附件免 test_note 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestTimeline(id);
      assert.strictEqual(tl.summary, '对接测试通过｜凭证：本轮测试附件', '[6g] summary 精确文案（delivery 类型同样计入，非仅 screenshot）');
      const payload = JSON.parse(tl.payload_json);
      assert.deepStrictEqual(payload, { evidence: 'attachment', cycle_no: 1, attachment_ids: [insDelivery.lastID] }, '[6g] ⭐ H-2 payload_json 精确形状：evidence=attachment，attachment_ids 恰含这一条 delivery 附件 id');
      ok('[6g] 本周期新传 delivery 附件（非 screenshot）同样满足凭证要求，免 test_note 也 200（两种合法附件类型各验一次）+ payload_json 精确留痕');
    }

    // [6g2] ⭐ 三态复活（codex 291 号 M-1 收口）：test_note 与本轮新附件同时存在 → evidence='both'
    //   （批2曾因附件查询在 !hasNote 时才执行，短路成两态；291 号裁定=改，附件查询无条件执行，
    //   hasNote×hasAttachment 真三态——[6a]/[6f] 已分别覆盖 note-only，[6g]/[6i] 覆盖 attachment-only/
    //   不计类型，本例补最后一格"两者同时存在"）。
    {
      const { id } = await mkFreshLiaisonTestIssue();
      const insBoth = await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
         VALUES (?, 'delivery', 'both.zip', '两者皆有.zip', 'active', 5, '开发甲')`,
        [id]
      );
      const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '说明与附件同时提供' });
      assert.strictEqual(r.status, 200, `[6g2] 说明+附件同时存在应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestTimeline(id);
      const payload = JSON.parse(tl.payload_json);
      assert.deepStrictEqual(payload, { evidence: 'both', cycle_no: 1, test_note: '说明与附件同时提供', attachment_ids: [insBoth.lastID] }, "[6g2] ⭐ payload_json 真三态：evidence='both' 且 test_note/attachment_ids 两键同时出现（[6a]/[6g] 分别只出现其中一键，本例证两键可共存）");
      assert.strictEqual(tl.summary, '对接测试通过｜测试说明：说明与附件同时提供（另有本轮测试附件）', '[6g2] ⭐ summary 文案含"（另有本轮测试附件）"后缀（hasNote && hasAttachment 分支专属拼接）');
      ok("[6g2] ⭐ 291 号 M-1 三态复活：test_note + 本轮新附件同时存在 → evidence='both'，payload_json 两键共存，summary 带「另有本轮测试附件」后缀（附件查询已无条件执行，不再因 hasNote 短路成两态）");
    }

    // [6h] ⭐ 跨周期反证（codex 291 号 M-3 收口重写）：第一轮进入之后新传的附件在本轮 pass 有效（正面）
    //   → 业务验收打回（return：待验证→开发中，非 liaison_test_return——本单已离开「待对接测试」进
    //   「待验证」，只有业务打回适用；⚠️ 2026-08-12 起 return **会自动 remove+re-add**，primary 的完成态
    //   实例被软删归档、另开新 pending 实例，故下方前置须让他重新提交，详见该处夹具注释）→ 补填
    //   预计完成 + 新增一名待处理成员触发 GATE 重新进入第二轮 → 第二轮新水位=当前 max 附件 id（已把
    //   第一轮那个"旧"附件圈进水位内）→ 该旧附件 id ≤ 新水位，不再计入第二轮凭证，无新凭证 pass 仍
    //   400（真正证明"跨轮不可复用"，而非停留在"打回前"这种较弱证明力）。⭐ 同秒场景在 id 水位模型下
    //   天然消解：AUTOINCREMENT id 严格递增，不依赖挂钟精度，无需再像旧 created_at 模型那样手工构造
    //   `+1 second`/`-10 second` 时间偏移规避同秒竞态假红（旧模型的根本弱点正是 291 号 H-1 的诊断起点）。
    {
      const { id } = await mkFreshLiaisonTestIssue({ primaryDevId: 5, primaryDevName: '开发甲' });
      const row1 = await issueRow(id);
      assert.strictEqual(row1.liaison_test_cycle_no, 1, '[6h] 前置：首次进入 liaison_test_cycle_no=1');
      assert.strictEqual(row1.liaison_test_attachment_watermark, 0, '[6h] 前置：第一轮水位=0（本单此前无任何附件）');
      // 第一轮进入之后新插入一个附件（id 必然 > 第一轮水位 0）。
      const ins1 = await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
         VALUES (?, 'screenshot', 'r1.png', '第一轮截图.png', 'active', 5, '开发甲')`,
        [id]
      );
      assert.ok(ins1.lastID > row1.liaison_test_attachment_watermark, '[6h] 前置：新附件 id 确实 > 第一轮水位（正面凭证的构造前提）');
      // 正面：该附件本轮 pass 有效（不传 test_note，纯附件凭证）。
      const passPositive = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(passPositive.status, 200, `[6h] 第一轮凭证 pass 应 200，实际 ${passPositive.status} ${JSON.stringify(passPositive.body)}`);
      assert.strictEqual(await statusOf(id), '待验证', '[6h] 第一轮 pass 后进入待验证');
      // 业务验收打回（return：待验证→开发中；不是 liaison_test_return——本单已经离开「待对接测试」）。
      const rReturn = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '[6h] 验收打回，走第二轮对接测试' });
      assert.strictEqual(rReturn.status, 200, `[6h] 前置：业务 return 应 200，实际 ${rReturn.status} ${JSON.stringify(rReturn.body)}`);
      assert.strictEqual(await statusOf(id), '开发中', '[6h] 前置：打回后回开发中');
      // [C7] return 的换轮清字段套餐把 dev_estimated_at **与 estimated_effort_days** 一起清了（见 [7] 组断言），
      //   C7 起 GATE 对 feature/improvement 两 nf 值都查工期 → 只补预计完成、不补工期，第二轮仍会卡在
      //   gate_deferred_at 走不到 ⑦。两个字段必须一起补，才是返工后重填资格的完整模拟。
      await run(`UPDATE sys_issues SET dev_estimated_at=?, estimated_effort_days=1 WHERE id=?`, [futureEst(30), id]);
      // ⚠️ 不复用 user_id=6（历史在册且为 excused=removed_at IS NULL，partial unique index
      //   `(issue_id,user_id) WHERE removed_at IS NULL` 仍占位，不放行重插）——新一轮新增成员须用一个
      //   尚未在本单出现过的 user_id（同批2既有范式）。
      const daSecond2 = await mkMember(id, 8, '开发丁', 'pending');
      // [2026-08-12 打回自动重开一轮·夹具适配] 上方注释原写「该 case 不重置花名册③层，primary 仍是
      //   code_submitted」——那是 return 自动 remove+re-add 上线**前**的行为（注释同批订正见该处）。
      //   现在 return 会把开发甲的完成态实例软删归档、另开一个新 pending 实例，故必须让他**重新提交**
      //   才能重新凑齐全完成态，否则 excuse 开发丁后 roster 仍有一名 pending，GATE 不进 ⑦。
      //   ⚠️ **三步顺序不可调换**：必须「先加开发丁 pending → 再让开发甲提交 → 最后 excuse 开发丁」。
      //   若先让开发甲提交（此刻他是单人 roster），会立即凑齐全完成态触发一次 GATE 进入待对接测试，
      //   cycle_no 先 +1；随后加人弹回、excuse 再进又 +1 ⇒ 终值 3，下方 `cycle_no=2` 断言假红。
      //   本顺序下每一步都不满足全完成态，GATE 只在最后 excuse 那一下触发一次。
      const resubmit6h = await call('POST', `/api/sys-issues/${id}/submit`,
        jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET),
        { mode: 'no_code', no_code_reason: '[6h] 打回后重新提交（占位理由）', self_tested: true, test_env_deployed: true });
      assert.strictEqual(resubmit6h.status, 200, `[6h] 前置：打回重开一轮后开发甲重新提交应 200，实际 ${resubmit6h.status} ${JSON.stringify(resubmit6h.body)}`);
      await triggerGateViaExcuse(id, daSecond2, '[6h] 第二轮进入测试段');
      assert.strictEqual(await statusOf(id), '待对接测试', '[6h] 前置：第二轮再次进入待对接测试');
      const row2 = await issueRow(id);
      assert.strictEqual(row2.liaison_test_cycle_no, 2, '[6h] 前置：liaison_test_cycle_no=2（只增不清）');
      assert.strictEqual(row2.liaison_test_attachment_watermark, ins1.lastID, '[6h] ⭐ 第二轮新水位=当前 max 附件 id，精确等于第一轮那个附件的 id（把它圈进"旧"范围）');
      // 负面：不带新凭证 pass 应 400——第一轮那个附件 id ≤ 第二轮水位，不再计入。
      const rPassNeg = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(rPassNeg.status, 400, `[6h] ⭐ 第二轮不带新凭证（仅第一轮旧附件）应 400，实际 ${rPassNeg.status} ${JSON.stringify(rPassNeg.body)}`);
      assert.strictEqual(rPassNeg.body.code, 'LIAISON_TEST_PASS_EVIDENCE_REQUIRED', '[6h] ⭐ 错误码仍 LIAISON_TEST_PASS_EVIDENCE_REQUIRED（旧附件 id ≤ 新水位，不构成本轮凭证）');
      assert.strictEqual(await statusOf(id), '待对接测试', '[6h] 拒绝后状态不变（零副作用）');
      // 反证收尾：本轮补一个新附件（id > 第二轮水位）后应能正常通过，证闸门本身没坏，只精确卡在"水位"这一条件上。
      const ins2 = await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
         VALUES (?, 'screenshot', 'r2.png', '第二轮截图.png', 'active', 5, '开发甲')`,
        [id]
      );
      assert.ok(ins2.lastID > row2.liaison_test_attachment_watermark, '[6h] 前置：第二轮新附件 id 确实 > 第二轮水位');
      const rPass2 = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(rPass2.status, 200, `[6h] 补第二轮新附件后应 200，实际 ${rPass2.status} ${JSON.stringify(rPass2.body)}`);
      const tl2 = await latestTimeline(id);
      const payload2 = JSON.parse(tl2.payload_json);
      assert.deepStrictEqual(payload2, { evidence: 'attachment', cycle_no: 2, attachment_ids: [ins2.lastID] }, '[6h] ⭐ 第二轮 payload_json 精确只含第二轮新附件 id（第一轮旧附件 id 不出现在 attachment_ids 里，双重确认口径）');
      ok('[6h] ⭐ 跨周期反证（291 号 M-3）：第一轮附件本轮 pass 有效（正） → 业务打回+重新提交进第二轮，水位=第一轮附件 id → 该旧附件不再计入第二轮凭证，无新证据 pass 仍 400（真正证明跨轮不可复用） → 补第二轮新附件后 200 且 payload_json.attachment_ids 精确只含新附件 id（旧附件不出现）——闸门精确卡在"水位"而非"issue 是否曾有附件"');
    }

    // [6i] spec 类型附件不算数：仅 delivery/screenshot 两种类型计入凭证（对齐口径原文"附件"特指交付/
    //   截图类，spec 是建单需求材料，语义上与"测试凭证"无关，即便 id 落在本轮水位之后也不该被误算）。
    {
      const { id } = await mkFreshLiaisonTestIssue();
      await run(
        `INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name)
         VALUES (?, 'spec', 's.pdf', '需求材料.pdf', 'active', 5, '开发甲')`,
        [id]
      );
      const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, {});
      assert.strictEqual(r.status, 400, `[6i] spec 类型附件不应计入凭证，应仍 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_PASS_EVIDENCE_REQUIRED', '[6i] 错误码仍 LIAISON_TEST_PASS_EVIDENCE_REQUIRED（spec 不计入）');
      ok('[6i] spec 类型附件（建单需求材料，非交付/截图）即便 id 落在本轮水位之后也不计入凭证，仍 400（只认 delivery/screenshot 两种类型，口径精确不放宽）');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [7] liaison_test_return：正例（字段清理套餐 + 花名册重置 + D18 return_count 恒定）+ 缺 reason 反例
  // ══════════════════════════════════════════════════════════════════════
  {
    // 种子先带 return_count=1（业务验收打回过一次）+ 完整评估/工期字段，验证 liaison_test_return **不清零
    // 已有 return_count、也不再递增**（D18：语义分离，非"从不清零"，是"这条边完全不碰这个字段"）。
    const id = await mkIssue('feature', '开发中', {
      intakeLiaisonId: 13, returnCount: 1, needsFeasibility: 1,
      feasibilityConclusion: '可行', feasibilityRequirementConfirm: '已确认', estimatedEffortDays: 3,
    });
    const daId1 = await mkMember(id, 5, '开发甲', 'code_submitted');
    const daId2 = await mkMember(id, 6, '开发乙', 'no_code');
    const daId3 = await mkMember(id, 7, '开发丙', 'excused');
    // 直接落态到待对接测试（本组只测 return 边本身，不经 excuse 触发 GATE）——须一并补 assigned_to：
    // 本文件其余小节都经真实 excuse 端点触发 GATE（electRepresentative 前置选举会自动写 assigned_to），
    // 本组绕开该路径直接 raw SQL 落态，若不手动补 assigned_to，会在 [4] REQUIRES_ASSIGNEE_STATUSES 校验
    // （'开发中'/'待对接测试' 均在其目标态全集内）撞 409 NO_ASSIGNEE_FOR_DEV_STATE（本文件踩坑实测）。
    await run(`UPDATE sys_issues SET status='待对接测试', liaison_test_cycle_no=1, assigned_to=5, assigned_to_name='开发甲' WHERE id=?`, [id]);

    // 缺 reason 反例（先测，避免正例改动状态后无法复现）
    const missingReasonR = await call('POST', `/api/sys-issues/${id}/liaison-test-return`, liaisonTok, {});
    assert.strictEqual(missingReasonR.status, 400, `[7] 缺 reason 应 400，实际 ${missingReasonR.status}`);
    assert.strictEqual(missingReasonR.body.code, 'LIAISON_TEST_RETURN_REASON_REQUIRED', '[7] 错误码 LIAISON_TEST_RETURN_REASON_REQUIRED');
    assert.strictEqual(await statusOf(id), '待对接测试', '[7] 缺 reason 拒绝后状态不变');

    // 正例
    const returnR = await call('POST', `/api/sys-issues/${id}/liaison-test-return`, liaisonTok, { reason: '测试发现三处问题，需返工' });
    assert.strictEqual(returnR.status, 200, `[7] return 应 200，实际 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    assert.strictEqual(returnR.body.status, '开发中', '[7] return → 开发中');
    const row = await issueRow(id);
    assert.strictEqual(row.return_count, 1, '[7] ⭐ D18：return_count 恒为种子原值 1（liaison_test_return 完全不碰这个字段，非清零非递增）');
    assert.strictEqual(row.dev_estimated_at, null, '[7] dev_estimated_at 清空（复用 return 字段清理套餐）');
    assert.strictEqual(row.estimated_effort_days, null, '[7] estimated_effort_days 清空（SYS_CLEAR_FEASIBILITY_FIELDS_SQL）');
    assert.strictEqual(row.feasibility_conclusion, null, '[7] feasibility_conclusion 清空');
    assert.strictEqual(row.feasibility_requirement_confirm, null, '[7] feasibility_requirement_confirm 清空');
    assert.strictEqual(row.gate_deferred_at, null, '[7] gate_deferred_at 清空');
    assert.strictEqual(row.liaison_test_cycle_no, 1, '[7] ⭐ liaison_test_cycle_no 不动（return 边不递增周期号，周期号只在下次 ⑦ 重新进入时才 +1）');
    const m1 = await memberRow(daId1); assert.strictEqual(m1.dev_status, 'pending', '[7] ⭐ code_submitted → pending'); assert.strictEqual(m1.resolved_at, null, '[7] code_submitted 成员 resolved_at 清空');
    const m2 = await memberRow(daId2); assert.strictEqual(m2.dev_status, 'pending', '[7] ⭐ no_code → pending'); assert.strictEqual(m2.no_code_reason, null, '[7] no_code 成员 no_code_reason 清空');
    const m3 = await memberRow(daId3); assert.strictEqual(m3.dev_status, 'excused', '[7] ⭐ excused 保留不动（§3.1b 逐状态映射：excused 不重置）');
    const tl = await latestTimeline(id);
    assert.strictEqual(tl.action_code, 'liaison_test_return', '[7] timeline action_code=liaison_test_return');
    assert.strictEqual(tl.summary, '测试发现三处问题，需返工', '[7] timeline summary=reason 原文');
    ok('[7] liaison_test_return 正例：原因必填(400 反例) + 花名册重置(code_submitted/no_code→pending·excused 不动) + 字段清理套餐(dev_estimated_at/工期/评估/gate_deferred_at) + ⭐ D18 return_count 恒定不变(既不清零也不递增) + 周期号不动');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [7b] ⭐ 验收打回(return)/重开(reopen) 自动重开一轮——2026-08-12 用户拍板
  //   与 [7] 并列放置是有意的：两条打回边解决**同一个问题**（让开发能重新提交）却走**不同机制**——
  //   liaison_test_return 原地重置 dev_status，return/reopen 走 remove + re-add。差异不是随意的：
  //   §1 不变量1「完成态不回 pending」(B4b) 是 index.js:5849 那套分轮留痕的前提（bug_cause_records /
  //   noCodeRecords / workNoteRows 均按 MAX(id) per dev_assignee_id 取"该实例最近一次提交事件"，
  //   其无损性依赖"同一实例至多一条 submit 事件"）。原地重置=放开「同实例重复提交」⇒ 第一轮的 bug
  //   产生原因被静默丢弃（:5851 已预告该后果）。故本边改走系统自己认定的"标准重置路径"(:5837)：
  //   旧实例连同 dev_status 与全部留痕封存，新实例开新一轮。
  //   ⚠️ 修复前的真实症状（生产 #23·bug·验收打回 1 次）：打回清空 dev_estimated_at（期待重走一轮），
  //   却把完成态实例留在册 ⇒ 前端 canSubmit（本人 dev_status==='pending'）恒 false ⇒「标记完成」按钮
  //   消失；而 estimate 属 W06 动作不分 dev_status ⇒ 开发**能填预计完成时间却不能提交**，界面无提示。
  //   补救路径 remove+re-add 当时只能由 admin 手工执行，且无任何入口引导。
  // ══════════════════════════════════════════════════════════════════════
  {
    const devTok5 = jwt.sign({ id: 5, username: 'dev5', display_name: '开发甲', role: 'user' }, SECRET);

    // ── [7b-1] bug 验收打回：旧实例封存 + 新实例 pending + 端到端"打回→回填→提交"（复现生产 #23 全链路）──
    const id = await mkIssue('bug', '待验证', { intakeLiaisonId: 13 });
    const b1 = await mkMember(id, 5, '开发甲', 'code_submitted');
    const b2 = await mkMember(id, 6, '开发乙', 'no_code');
    const b3 = await mkMember(id, 7, '开发丙', 'excused');
    // assigned_at 必须种：本组端到端要真调 /estimate，该端点有「预计完成不得早于指派时刻」闸门，
    //   缺值直接 409 ASSIGNED_AT_MISSING（[7] 组不调 estimate 故无此需求，勿照抄它的夹具）。
    await run(`UPDATE sys_issues SET assigned_to=5, assigned_to_name='开发甲', assigned_at='2026-07-16 10:00:00' WHERE id=?`, [id]);

    const retR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '验收发现导出仍未按筛选条件过滤' });
    assert.strictEqual(retR.status, 200, `[7b-1] return 应 200，实际 ${retR.status} ${JSON.stringify(retR.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[7b-1] bug return → 处理中');
    assert.strictEqual((await issueRow(id)).return_count, 1, '[7b-1] return_count++（与 [7] 的 D18 恒定形成对照）');

    // ⭐ B4b：旧实例软删归档，dev_status **原样保持**——这是分轮留痕的载体，绝不能被改回 pending
    const oldB1 = await memberRow(b1);
    assert.ok(oldB1.removed_at, '[7b-1] ⭐ 旧完成态实例被软删归档（remove 半步）');
    assert.strictEqual(oldB1.dev_status, 'code_submitted', '[7b-1] ⭐⭐ B4b：旧实例 dev_status 原样保持 code_submitted（未原地回退 ⇒ 首轮 bug_cause_note/no_code_reason 的 MAX(id) 载体不被覆盖）');
    const oldB2 = await memberRow(b2);
    assert.ok(oldB2.removed_at, '[7b-1] no_code 实例同样软删归档');
    assert.strictEqual(oldB2.dev_status, 'no_code', '[7b-1] ⭐ no_code 旧实例 dev_status 亦原样保持');
    assert.strictEqual(oldB2.no_code_reason, '占位原因，测试用', '[7b-1] ⭐ no_code_reason 原样保留（原地重置方案会把它清空 ⇒ 无代码交付的唯一凭证消失）');
    // excused 不动（豁免语义不因打回被拉回队列，与 [7] 逐字同源）
    assert.strictEqual((await memberRow(b3)).dev_status, 'excused', '[7b-1] ⭐ excused 不动');
    assert.strictEqual((await memberRow(b3)).removed_at, null, '[7b-1] excused 成员不被软删（不参与重开一轮）');

    // ⭐ re-add 半步：同一 user 各开出一个新 pending 在册实例，且 id 严格大于旧实例
    const newRows = await all(
      `SELECT id, user_id, dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND removed_at IS NULL ORDER BY user_id`, [id]);
    const newB1 = newRows.find(r => Number(r.user_id) === 5);
    const newB2 = newRows.find(r => Number(r.user_id) === 6);
    assert.ok(newB1 && newB1.dev_status === 'pending', '[7b-1] ⭐ 开发甲获得全新 pending 在册实例');
    assert.ok(newB2 && newB2.dev_status === 'pending', '[7b-1] ⭐ 开发乙获得全新 pending 在册实例');
    assert.ok(newB1.id > b1 && newB2.id > b2, '[7b-1] 新实例 id 严格大于旧实例（事件 id 序=轮次序的前提）');
    // re-add 事件写入，且 related 必须为空——P10 是双向恒真约束（related 仅限 supersede-excuse）
    const readdEvents = await all(
      `SELECT dev_assignee_id, action, related_dev_assignee_id, payload_json FROM sys_issue_dev_events
        WHERE issue_id=? AND action='re-add' ORDER BY id`, [id]);
    assert.strictEqual(readdEvents.length, 2, '[7b-1] 两名完成态成员各写一条 re-add 事件');
    assert.ok(readdEvents.every(e => e.related_dev_assignee_id === null), '[7b-1] ⭐ re-add 事件 related_dev_assignee_id 必为空（P10 双向恒真：related 是 supersede-excuse 专属槽，旧实例 id 走 payload）');
    assert.strictEqual(JSON.parse(readdEvents[0].payload_json).superseded_dev_assignee_id, b1, '[7b-1] payload 记录承接自哪个旧实例（可追轮次血缘）');
    assert.strictEqual(JSON.parse(readdEvents[0].payload_json).trigger, 'return', '[7b-1] payload 记录触发边');

    // ⭐ 端到端闭环：打回后开发**自助**走完"回填预计完成 → 标记完成"，无需 admin 介入。
    //   修复前此处必 409（canSubmit 后端真闸要求本人 dev_status='pending'），即生产 #23 的死锁。
    const estR = await call('POST', `/api/sys-issues/${id}/estimate`, devTok5, { dev_estimated_at: futureEst(20) });
    assert.strictEqual(estR.status, 200, `[7b-1] 打回后开发回填预计完成时间应 200，实际 ${estR.status} ${JSON.stringify(estR.body)}`);
    const subR = await call('POST', `/api/sys-issues/${id}/submit`, devTok5,
      { mode: 'no_code', no_code_reason: '已修复并重新提交（占位理由）', bug_cause_note: '导出未继承筛选条件（占位原因）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(subR.status, 200, `[7b-1] ⭐⭐ 打回后开发重新提交应 200（修复前恒 409=流程死锁），实际 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual((await memberRow(newB1.id)).dev_status, 'no_code', '[7b-1] 二轮提交落在**新实例**上（旧实例不受影响）');
    assert.strictEqual((await memberRow(b1)).dev_status, 'code_submitted', '[7b-1] ⭐ 二轮提交后旧实例仍是 code_submitted（两轮各自独立，留痕不互相覆盖）');
    // ⭐ [codex 343 MED-2 收口] 跨表回归：remove+re-add 是否让旧一轮的留痕/通知状态出问题。
    //   三张关联表各查一次——只断言字段值不够，必须走**详情端点**看聚合后的真实呈现。
    const detail7b = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detail7b.status, 200, '[7b-1] 详情读取应 200');
    // ① commit 留痕：旧实例的 commit 行不因软删而消失（详情端 devCommits 刻意不限 removed_at）
    const commitsOfOld = (detail7b.body.dev_commits || []).filter(c => c.dev_assignee_id === b1);
    assert.strictEqual(commitsOfOld.length, 1, `[7b-1] ⭐ 旧实例的 commit 留痕仍可见（软删不撤回历史 commit），实得 ${JSON.stringify(detail7b.body.dev_commits)}`);
    assert.strictEqual(commitsOfOld[0].dev_user_name, '开发甲', '[7b-1] 旧 commit 行仍能取到开发姓名（JOIN 历史行而非在册集合）');
    // ② 无代码交付凭证：旧实例的 no_code_reason 在详情聚合里仍在（原地重置方案会把它清空）
    // 注：no_code_records 的实例主键字段名是 `id`（不是 dev_assignee_id——那是 bug_cause_records 的形状），
    //   两个聚合的字段命名不同源，按各自实际形状取值。
    const ncOld = (detail7b.body.no_code_records || []).find(r => r.id === b2);
    assert.ok(ncOld && ncOld.no_code_reason === '占位原因，测试用', `[7b-1] ⭐ 旧实例 no_code_reason 在详情里仍可追溯，实得 ${JSON.stringify(detail7b.body.no_code_records)}`);
    // ③ 通知列：新实例是全新未通知态，不继承旧实例的已发送状态（否则"打回后重新指派"会被误判为已通知过）
    const newB1Row = await memberRow(newB1.id);
    assert.strictEqual(newB1Row.notify_status, 'not_sent', '[7b-1] ⭐ 新实例通知态=not_sent（新一轮需重新通知，不继承上一轮"已发送"）');
    assert.strictEqual(newB1Row.notified_at, null, '[7b-1] 新实例 notified_at 为空');
    assert.strictEqual(newB1Row.read_at, null, '[7b-1] 新实例 read_at 为空（不继承上一轮已读）');
    ok('[7b-1] ⭐ bug 验收打回自动重开一轮：旧实例软删归档且 dev_status/no_code_reason 原样封存(B4b) + 同人新开 pending 实例 + excused 不动 + re-add 事件(related 空·P10 合规·payload 记血缘) + **端到端闭环「打回→回填→重新提交」全 200** + **跨表回归**(旧 commit 留痕可见/旧 no_code 凭证可追溯/新实例通知态归零不继承)（复现并锁死生产 #23 的流程死锁）');

    // ── [7b-2] feature 重开(reopen)：另一 type + 另一 to（已关闭→开发中），同一套机制 ──
    const id2 = await mkIssue('feature', '已关闭', { intakeLiaisonId: 13, needsFeasibility: 0, estimatedEffortDays: 2 });
    const f1 = await mkMember(id2, 5, '开发甲', 'code_submitted');
    const f2 = await mkMember(id2, 7, '开发丙', 'excused');
    await run(`UPDATE sys_issues SET assigned_to=5, assigned_to_name='开发甲' WHERE id=?`, [id2]);
    const reopenR = await call('POST', `/api/sys-issues/${id2}/reopen`, adminTok, { reason: '上线后发现同一问题复现' });
    assert.strictEqual(reopenR.status, 200, `[7b-2] reopen 应 200，实际 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);
    assert.strictEqual(await statusOf(id2), '开发中', '[7b-2] feature reopen → 开发中');
    assert.ok((await memberRow(f1)).removed_at, '[7b-2] ⭐ reopen 同样走 remove+re-add（同族第二条边，不留"修了 return 漏了 reopen"的缺口）');
    assert.strictEqual((await memberRow(f1)).dev_status, 'code_submitted', '[7b-2] reopen 旧实例 dev_status 亦原样封存');
    const newF1 = await get(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [id2]);
    assert.strictEqual(newF1.dev_status, 'pending', '[7b-2] reopen 后同人新 pending 实例');
    assert.strictEqual((await memberRow(f2)).dev_status, 'excused', '[7b-2] reopen 同样保留 excused');
    ok('[7b-2] feature 重开(reopen)：跨 type、跨目标态(已关闭→开发中) 复用同一套 remove+re-add——同族两条边一并收口');

    // ── [7b-3] ⭐ 零可重置成员边界：全 excused 单打回必须放行（不得因"没有可重开的成员"而报错）──
    //   全 excused 单走 index.js:2755 降级路径（liaison_test_skip_excused）同样能进「待验证」，
    //   此时被打回，finishedRows 为空 ⇒ 整段 for 循环零次、electRepresentative 也不调用。
    //   若实现里写死"必须重开≥1 名"（照搬 [7] 的 ≥1 硬断言），这条**合法链路会被打成 500**。
    const id3 = await mkIssue('bug', '待验证', { intakeLiaisonId: 13 });
    const e1 = await mkMember(id3, 6, '开发乙', 'excused');
    await run(`UPDATE sys_issues SET assigned_to=6, assigned_to_name='开发乙' WHERE id=?`, [id3]);
    const retR3 = await call('POST', `/api/sys-issues/${id3}/return`, adminTok, { reason: '全豁免单打回（边界用例）' });
    assert.strictEqual(retR3.status, 200, `[7b-3] ⭐ 全 excused 单打回应 200（若照抄 [7] 的 ≥1 断言会在此判死），实际 ${retR3.status} ${JSON.stringify(retR3.body)}`);
    assert.strictEqual(await statusOf(id3), '处理中', '[7b-3] 全 excused 单打回后状态正常流转');
    assert.strictEqual((await memberRow(e1)).dev_status, 'excused', '[7b-3] excused 原样不动');
    assert.strictEqual((await memberRow(e1)).removed_at, null, '[7b-3] excused 不被软删');
    const noReadd = await all(`SELECT id FROM sys_issue_dev_events WHERE issue_id=? AND action='re-add'`, [id3]);
    assert.strictEqual(noReadd.length, 0, '[7b-3] 零可重开成员 ⇒ 不写任何 re-add 事件（不为凑数造空事件）');
    ok('[7b-3] ⭐ 零可重开成员边界：全 excused 单打回放行不报错、不写空事件（与 [7] 的 ≥1 硬断言口径分岔点——那边有 GATE 保证交付数≥1，本边没有）');

    // ── [7b-4] ⭐ 账号资格闸（codex 343 HIGH-1）：停用/降 viewer/已删除账号**不得**被 re-add ──
    //   无条件 re-add 会给不可参与的账号造出一个**不可行动的 pending 成员**——他在前端看不到提交按钮、
    //   后端也不放行，死锁只是从「无 pending」换形态成「有 pending 但没人能动」，且更难诊断。
    //   正确行为=跳过该成员（数据一行不动，保持完成态在册），打回本身照常成功——账号事后被停用/降权
    //   是人事侧的正常变动，不该反过来让 admin 打不回单子；此时应由 admin 改派给在岗成员。
    await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
      (91,'dev91','离职开发','user','inactive','13900000091'),(92,'dev92','降权开发','viewer','active','13900000092')`);
    const id4 = await mkIssue('bug', '待验证', { intakeLiaisonId: 13 });
    const q1 = await mkMember(id4, 91, '离职开发', 'code_submitted');   // 账号已停用
    const q2 = await mkMember(id4, 92, '降权开发', 'no_code');          // 已降为 viewer
    const q3 = await mkMember(id4, 5, '开发甲', 'code_submitted');      // 正常账号（对照组）
    await run(`UPDATE sys_issues SET assigned_to=5, assigned_to_name='开发甲' WHERE id=?`, [id4]);
    const retR4 = await call('POST', `/api/sys-issues/${id4}/return`, adminTok, { reason: '混合账号状态打回' });
    assert.strictEqual(retR4.status, 200, `[7b-4] ⭐ 含不可参与账号时打回仍应 200（不因人事变动阻断流转），实际 ${retR4.status} ${JSON.stringify(retR4.body)}`);
    // 停用账号：一行不动
    assert.strictEqual((await memberRow(q1)).removed_at, null, '[7b-4] ⭐ 停用账号成员**不被软删**（跳过=数据一行不动，非"软删了却不新建"导致成员消失）');
    assert.strictEqual((await memberRow(q1)).dev_status, 'code_submitted', '[7b-4] 停用账号成员 dev_status 不变');
    const noNewQ1 = await all(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=91 AND removed_at IS NULL`, [id4]);
    assert.strictEqual(noNewQ1.length, 1, '[7b-4] ⭐ 停用账号**不获得**新 pending 实例（否则=不可行动的 pending，死锁换形态）');
    assert.strictEqual(noNewQ1[0].id, q1, '[7b-4] 在册的仍是原实例本身');
    // viewer：同样一行不动
    assert.strictEqual((await memberRow(q2)).removed_at, null, '[7b-4] ⭐ viewer 成员不被软删');
    assert.strictEqual((await memberRow(q2)).dev_status, 'no_code', '[7b-4] viewer 成员 dev_status 不变');
    // 对照组：同一单里的正常账号照常重开一轮（证明闸门是**逐成员**判定，不是"一票否决整单"）
    assert.ok((await memberRow(q3)).removed_at, '[7b-4] ⭐ 对照组：同单内正常账号照常软删归档（逐成员判定，非整单跳过）');
    const newQ3 = await get(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [id4]);
    assert.strictEqual(newQ3.dev_status, 'pending', '[7b-4] 对照组：正常账号获得新 pending 实例');
    const readd4 = await all(`SELECT dev_assignee_id FROM sys_issue_dev_events WHERE issue_id=? AND action='re-add'`, [id4]);
    assert.strictEqual(readd4.length, 1, '[7b-4] 仅为正常账号写 1 条 re-add 事件（跳过者不写）');
    ok('[7b-4] ⭐ 账号资格闸：停用/viewer 账号跳过不动（不造"不可行动的 pending"）+ 打回本身不被阻断 + **逐成员判定**（同单正常账号照常重开一轮）——判据与引擎 :5168 既有范式同源');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [8] 待对接测试态七写入口 409 矩阵（花名册族矩阵不含 LIAISON_TEST，天然 fail-closed）
  // ══════════════════════════════════════════════════════════════════════
  {
    async function mkLiaisonTestIssue() {
      const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
      await mkMember(id, 5, '开发甲', 'code_submitted');
      const daId = await mkMember(id, 6, '开发乙', 'pending');
      await triggerGateViaExcuse(id, daId, '进入测试段');
      assert.strictEqual(await statusOf(id), '待对接测试', 'mkLiaisonTestIssue 前置：应已进入待对接测试');
      return { id, daId1: (await get('SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5', [id])).id, daId2: daId };
    }

    let ctx = await mkLiaisonTestIssue();
    let r = await call('POST', `/api/sys-issues/${ctx.id}/dev-assignees`, adminTok, { user_ids: [7] });
    assert.strictEqual(r.status, 409, `[8] add 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-add] 待对接测试态 add → 409（族矩阵不含 LIAISON_TEST）');

    ctx = await mkLiaisonTestIssue();
    r = await call('DELETE', `/api/sys-issues/${ctx.id}/dev-assignees/${ctx.daId1}`, adminTok, { reason: '尝试移除' });
    assert.strictEqual(r.status, 409, `[8] remove 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-remove] 待对接测试态 remove → 409（族矩阵不含 LIAISON_TEST）');

    ctx = await mkLiaisonTestIssue();
    r = await call('DELETE', `/api/sys-issues/${ctx.id}/dev-assignees/${ctx.daId1}`, devTok(5), { reason: '自己移除自己' });
    assert.strictEqual(r.status, 409, `[8] self-remove 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-self-remove] 待对接测试态 self-remove → 409（族矩阵不含 LIAISON_TEST，本人也不能）');

    ctx = await mkLiaisonTestIssue();
    r = await call('POST', `/api/sys-issues/${ctx.id}/dev-assignees/${ctx.daId1}/excuse`, adminTok, { reason: '尝试豁免' });
    assert.strictEqual(r.status, 409, `[8] excuse 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-excuse] 待对接测试态 excuse → 409（族矩阵不含 LIAISON_TEST）');

    ctx = await mkLiaisonTestIssue();
    r = await call('POST', `/api/sys-issues/${ctx.id}/dev-assignees/${ctx.daId1}/supersede-excuse`, adminTok, { reason: '尝试恢复' });
    assert.strictEqual(r.status, 409, `[8] supersede-excuse 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-supersede-excuse] 待对接测试态 supersede-excuse → 409（族矩阵不含 LIAISON_TEST）');

    ctx = await mkLiaisonTestIssue();
    r = await call('POST', `/api/sys-issues/${ctx.id}/reassign`, adminTok, { member_ids: [5, 7], reason: '尝试改派' });
    assert.strictEqual(r.status, 409, `[8] reassign 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-reassign] 待对接测试态 reassign → 409（族矩阵不含 LIAISON_TEST）');

    // re-add：先造一个"曾在册后被移除"的历史行（在开发中态移除，再进测试段），验证 re-add 同样被拒
    const id7 = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daA = await mkMember(id7, 5, '开发甲', 'code_submitted');
    await mkMember(id7, 8, '开发丁', 'no_code', { removedAt: '2026-07-01 00:00:00' });   // 历史已移除行
    const daB = await mkMember(id7, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id7, daB, '进入测试段');
    assert.strictEqual(await statusOf(id7), '待对接测试', '[8-re-add] 前置：应已进入待对接测试');
    r = await call('POST', `/api/sys-issues/${id7}/dev-assignees`, adminTok, { user_ids: [8] });
    assert.strictEqual(r.status, 409, `[8] re-add 应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[8-re-add] 待对接测试态 re-add（历史已移除成员）→ 409（同 add 端点同一族矩阵判定，无特殊豁免）');

    // [C4 合并修复批 275-H1] hold 禁止锁死断言——C0 矩阵验证清单 §C（§3.5 全动作档位矩阵）拍板格值＝
    //   待对接测试态 hold 禁止（非遗漏，见 transitions.js feature hold 条目注释）。本断言防未来有人把
    //   「待对接测试」顺手加进 hold 的 from 数组——findTransition 对该 from 恒不命中 → 400 INVALID_TRANSITION
    //   （非 409，hold 走 sysIssueTransition 通用 [1] 层，from 不匹配是"动作在当前态不存在"语义）。
    ctx = await mkLiaisonTestIssue();
    r = await call('POST', `/api/sys-issues/${ctx.id}/hold`, adminTok, { reason: '尝试暂缓' });
    assert.strictEqual(r.status, 400, `[8-hold] 待对接测试态 hold 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '[8-hold] 错误码 INVALID_TRANSITION');
    assert.strictEqual(await statusOf(ctx.id), '待对接测试', '[8-hold] 拒绝后状态不变');
    ok('[8-hold] ⭐ 待对接测试态 hold → 400 INVALID_TRANSITION（C0 §C 拍板格值＝禁，锁死防未来误加边）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [9] last_completed_at 白名单（C0 §F-8）：⑦ 正常/⑥ 降级/两轮完成取末次 pass/resume 伪行排除
  // ══════════════════════════════════════════════════════════════════════
  {
    // [9a] ⑦ 正常路径：进测试段时 last_completed_at 应仍为 null，pass 后才回填为 pass 的 created_at
    const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const daId2 = await mkMember(id, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id, daId2, '进入测试段');
    assert.strictEqual(await lastCompletedAt(id), null, '[9a] 待对接测试期间 last_completed_at 仍 null（未完成，只是"到了验收前一站"）');
    await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '第一轮测试通过' });
    const passTl = await get(`SELECT created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='liaison_test_pass'`, [id]);
    assert.strictEqual(await lastCompletedAt(id), passTl.created_at, '[9a] ⭐ pass 后 last_completed_at = liaison_test_pass 该条 timeline 的 created_at（精确取值，非仅非空）');
    ok('[9a] last_completed_at 白名单·⑦ 正常路径：待对接测试期间为 null，pass 后精确等于 liaison_test_pass 事件时刻');

    // [284 号 B1] 真端点断言（282-R9 采纳方向）：上方 lastCompletedAt() 是与 index.js 逐字复刻的 SQL
    // 查询，只证明"这条 SQL 语句本身正确"，证不了"调用方（列表页/详情页）真的读到了这个值"——同一份
    // SQL 复制粘贴两遍，字段名写错/位置放错两处都不会红。这里改走两个真实 HTTP 端点各查一次：列表
    // GET /sys-issues 响应 {items:[...]}、详情 GET /sys-issues/:id 响应 {issue:{...}}（均见 index.js
    // 对应 res.json 调用），断言其中 last_completed_at 字段与 timeline 事件时刻精确一致。
    // [285 号合并轮 L-1] 列表查询前提核实：先读了 index.js 列表端点源码（:4574-4581 addEq 段）——
    // 支持 type/status/system/priority/release/assigned 精确过滤（req.query.status 直接拼 WHERE
    // status = ?，:4577），且该端点**无 LIMIT/pageSize**（:4688-4689 只有 ORDER BY id DESC，无分页，
    // 返回全表匹配结果——故即便不加过滤参数也不存在"翻页漏检"风险）。既然 status 过滤确实支持，
    // 显式传参把结果集收窄到目标状态（pass 后必为「待验证」），比"信任无分页"更强的加固：一是让
    // 夹具必然落在结果集里的理由不再依赖"无分页"这条对端点实现细节的假设，二是顺带验证 status
    // 过滤器本身真的生效（若未来该过滤被改坏，这里先红），断言见下方 every(...) 那行。
    const listAfterPass = await call('GET', `/api/sys-issues?status=${encodeURIComponent('待验证')}`, adminTok);
    assert.strictEqual(listAfterPass.status, 200, `[9a-HTTP] 列表端点应 200，实际 ${listAfterPass.status}`);
    assert.ok((listAfterPass.body && listAfterPass.body.items || []).every(x => x.status === '待验证'), '[9a-HTTP] ⭐ status 过滤器确实生效：结果集内每一项 status 均为「待验证」（非过滤参数被忽略、误返回全表）');
    const listItemAfterPass = (listAfterPass.body && listAfterPass.body.items || []).find(x => x.id === id);
    assert.ok(listItemAfterPass, `[9a-HTTP] status=待验证 过滤后的列表响应应含本单 #${id}`);
    assert.strictEqual(listItemAfterPass.last_completed_at, passTl.created_at, '[9a-HTTP] ⭐ 列表端点真实响应 last_completed_at = pass 事件时刻（非 SQL 复制查询，真调用方读到的值）');
    const detailAfterPass = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detailAfterPass.status, 200, `[9a-HTTP] 详情端点应 200，实际 ${detailAfterPass.status}`);
    assert.strictEqual(detailAfterPass.body.issue.last_completed_at, passTl.created_at, '[9a-HTTP] ⭐ 详情端点真实响应 last_completed_at = pass 事件时刻');
    ok('[9a-HTTP] 284 号 B1：真实列表/详情两个 HTTP 端点响应均含非 NULL last_completed_at，精确等于 liaison_test_pass 事件时刻（非复制 SQL 查库）');

    // [9b] ⑥ 降级路径：last_completed_at 直接等于 skip 事件时刻
    const id2 = await mkIssue('feature', '开发中', { intakeLiaisonId: 999999 });
    await mkMember(id2, 5, '开发甲', 'no_code');
    const daId2b = await mkMember(id2, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id2, daId2b, '降级跳过测试段');
    const skipTl = await get(`SELECT created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='liaison_test_skip_liaison'`, [id2]);
    assert.strictEqual(await lastCompletedAt(id2), skipTl.created_at, '[9b] ⭐ ⑥ 降级：last_completed_at 精确等于 liaison_test_skip_liaison 事件时刻（GATE 一步到位，无中间 pending 期）');
    ok('[9b] last_completed_at 白名单·⑥ 降级路径：跳过测试段直落待验证，last_completed_at 精确等于 skip 事件时刻');

    // [284 号 B1] 同 [9a-HTTP]，⑥ 降级路径也走真实端点核实（同一套证据标准两条路径都要覆盖，不能
    // 只信一条）。[285 号合并轮 L-1] 同上方 [9a-HTTP]：status 过滤前提已核实（支持+无分页），显式
    // 传参收窄结果集并验证过滤器生效。
    const listAfterSkip = await call('GET', `/api/sys-issues?status=${encodeURIComponent('待验证')}`, adminTok);
    assert.strictEqual(listAfterSkip.status, 200, `[9b-HTTP] 列表端点应 200，实际 ${listAfterSkip.status}`);
    assert.ok((listAfterSkip.body && listAfterSkip.body.items || []).every(x => x.status === '待验证'), '[9b-HTTP] ⭐ status 过滤器确实生效：结果集内每一项 status 均为「待验证」');
    const listItemAfterSkip = (listAfterSkip.body && listAfterSkip.body.items || []).find(x => x.id === id2);
    assert.ok(listItemAfterSkip, `[9b-HTTP] status=待验证 过滤后的列表响应应含本单 #${id2}`);
    assert.strictEqual(listItemAfterSkip.last_completed_at, skipTl.created_at, '[9b-HTTP] ⭐ 列表端点真实响应 last_completed_at = skip 事件时刻');
    const detailAfterSkip = await call('GET', `/api/sys-issues/${id2}`, adminTok);
    assert.strictEqual(detailAfterSkip.status, 200, `[9b-HTTP] 详情端点应 200，实际 ${detailAfterSkip.status}`);
    assert.strictEqual(detailAfterSkip.body.issue.last_completed_at, skipTl.created_at, '[9b-HTTP] ⭐ 详情端点真实响应 last_completed_at = skip 事件时刻');
    ok('[9b-HTTP] 284 号 B1：真实列表/详情两个 HTTP 端点响应均含非 NULL last_completed_at，精确等于 liaison_test_skip_liaison 事件时刻（非复制 SQL 查库）');

    // [9c] 两轮完成取末次：第一轮 pass 后 return 打回重开，第二轮再次 pass——last_completed_at 应取第二次（末次）
    const id3 = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daId3a = await mkMember(id3, 5, '开发甲', 'code_submitted');
    const daId3b = await mkMember(id3, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id3, daId3b, '第一轮进入测试段');
    const firstPassR = await call('POST', `/api/sys-issues/${id3}/liaison-test-pass`, liaisonTok, { test_note: '第一轮测试通过' });
    assert.strictEqual(firstPassR.status, 200, `[9c] 前置：第一次 pass 应 200，实际 ${firstPassR.status} ${JSON.stringify(firstPassR.body)}`);
    // [C4 合并修复批 275-L1] 补 id 列——下方 [9c] 恒真断言修复需要 firstPassTl.id 参与真实数值比较
    // （此前只选 created_at，firstPassTl.id 恒 undefined）。
    const firstPassTl = await get(`SELECT id, created_at FROM sys_issue_timeline WHERE issue_id=? AND action_code='liaison_test_pass' ORDER BY id DESC LIMIT 1`, [id3]);
    assert.strictEqual(await lastCompletedAt(id3), firstPassTl.created_at, '[9c] 前置：第一轮 pass 后 last_completed_at=第一次 pass 时刻');
    // 打回（模拟验收发现问题，走 return 走回开发中——用业务验收 return 而非 liaison_test_return，均属"回开发中"）
    await call('POST', `/api/sys-issues/${id3}/return`, adminTok, { reason: '验收不通过，需返工' });
    assert.strictEqual(await statusOf(id3), '开发中', '[9c] 前置：return 后回开发中');
    // 重新提交交付（直接改 dev_status 模拟"重新提交"，不走完整 submit 流程——非本组测试重点）。
    // ⚠️ [2026-08-12 打回自动重开一轮] 原写法是 `WHERE id = daId3a`，依赖"return 不重置 roster、旧实例
    //   仍在册"。现在 return 会把 daId3a 软删归档并另开新 pending 实例，改旧实例已影响不到在册视图
    //   （GATE 只看 removed_at IS NULL 的行），故改为**按 user_id 定位当前在册实例**。
    // ⚠️ return 的 setFrags 会清空 dev_estimated_at（§3.1b"打回=新一轮，须重填资格"），而
    // isGateEligibleForVerify 无条件要求它非空——不重新填写会在 ④ 落 gate_deferred_at 卡住，
    // 走不到 ⑦（本文件踩坑实测）。补一次 estimate 模拟"返工后重新回填预计完成"这一真实必经步骤。
    const da3aUser = (await get(`SELECT user_id FROM sys_issue_dev_assignees WHERE id=?`, [daId3a])).user_id;
    const upd9c = await run(
      `UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime')
        WHERE issue_id=? AND user_id=? AND removed_at IS NULL`, [id3, da3aUser]);
    assert.strictEqual(upd9c.changes, 1, '[9c] 前置：应恰好命中 1 行在册实例（打回后由 return 自动开出的新 pending 行）');
    // [C7] return 的换轮清字段套餐把 dev_estimated_at **与 estimated_effort_days** 一起清了（见 [7] 组断言），
    //   C7 起 GATE 对 feature/improvement 两 nf 值都查工期 → 只补预计完成、不补工期，第二轮仍会卡在
    //   gate_deferred_at 走不到 ⑦。两个字段必须一起补，才是返工后重填资格的完整模拟。
    await run(`UPDATE sys_issues SET dev_estimated_at=?, estimated_effort_days=1 WHERE id=?`, [futureEst(30), id3]);
    const daId3c = await mkMember(id3, 7, '开发丙', 'pending');
    // 轮询数据库时钟直到严格跨过第一次 pass 的 created_at，避免同秒精度下 MAX 无法区分两轮先后
    // （SQLite created_at 为秒级精度，同 codex 260 号 M-A 范式）。
    const waitStart = Date.now();
    let dbNow = null;
    while (Date.now() - waitStart < 3000) {
      dbNow = (await get(`SELECT datetime('now','localtime') AS now`)).now;
      if (dbNow && dbNow > firstPassTl.created_at) break;
      await new Promise(res => setTimeout(res, 50));
    }
    assert.ok(dbNow && dbNow > firstPassTl.created_at, '[9c] 前置：轮询等待数据库时钟严格跨过第一次 pass 时刻（3s 超时上限，超时说明系统时钟异常需人工排查）');
    await triggerGateViaExcuse(id3, daId3c, '第二轮进入测试段');
    assert.strictEqual(await statusOf(id3), '待对接测试', '[9c] 前置：第二轮重新进入待对接测试（cycle_no 应为 2）');
    assert.strictEqual((await issueRow(id3)).liaison_test_cycle_no, 2, '[9c] 前置：liaison_test_cycle_no 第二次进入应=2（只增不清）');
    const secondPassR = await call('POST', `/api/sys-issues/${id3}/liaison-test-pass`, liaisonTok, { test_note: '第二轮测试通过' });
    // [C4 合并修复批 275-L1] 补第二次 pass 的 HTTP 200 直断言（此前只隐式假设成功，未显式断言状态码）。
    assert.strictEqual(secondPassR.status, 200, `[9c] 前置：第二次 pass 应 200，实际 ${secondPassR.status} ${JSON.stringify(secondPassR.body)}`);
    const secondPassTl = await get(`SELECT created_at, id FROM sys_issue_timeline WHERE issue_id=? AND action_code='liaison_test_pass' ORDER BY id DESC LIMIT 1`, [id3]);
    // [C4 合并修复批 275-L1] 修复恒真断言：原写法 `secondPassTl.id > firstPassTl.id !== undefined` 运算
    // 优先级陷阱——`>` 先算出 boolean，再与 undefined 比较 `!==` 恒为 true（与两个 id 的真实大小关系无关，
    // 且 firstPassTl.id 此前压根没被 SELECT 出来，恒 undefined）。改为直接对两个真实 id 做数值比较。
    assert.ok(secondPassTl.id > firstPassTl.id, `[9c] 前置：第二次 pass 产生了全新一条 timeline 行（id 严格递增），firstId=${firstPassTl.id} secondId=${secondPassTl.id}`);
    assert.strictEqual(await lastCompletedAt(id3), secondPassTl.created_at, '[9c] ⭐ 两轮完成取末次：last_completed_at = 第二次（末次）pass 时刻，非第一次');
    assert.notStrictEqual(secondPassTl.created_at, firstPassTl.created_at, '[9c] 两次 pass 时刻确实不同（轮询保证严格先后，非巧合同秒）');
    ok('[9c] last_completed_at 白名单·两轮完成取末次：pass→return→重新提交→再次 pass，last_completed_at 精确取第二次（末次）pass 时刻，非第一次');

    // [9d] resume 伪行排除：hold 一个已在「待验证」的单再 resume 回「待验证」，产生的 resume 类型 timeline 行
    //   不应被误判为新的完成时刻（H1 技术根源本源：resume 行 event_type 同为 status_change/to_status 同为
    //   待验证，唯一区分靠 action_code≠白名单内任何值）。
    const id4 = await mkIssue('feature', '开发中', { intakeLiaisonId: 999999 });   // ⑥ 降级直落待验证，简化前置
    await mkMember(id4, 5, '开发甲', 'no_code');
    const daId4b = await mkMember(id4, 6, '开发乙', 'pending');
    await triggerGateViaExcuse(id4, daId4b, '⑥ 降级到待验证');
    assert.strictEqual(await statusOf(id4), '待验证', '[9d] 前置：⑥ 降级已直落待验证');
    const originalCompletedAt = await lastCompletedAt(id4);
    assert.ok(originalCompletedAt, '[9d] 前置：last_completed_at 已有真实完成时刻（来自 ⑥ 降级）');
    await call('POST', `/api/sys-issues/${id4}/hold`, adminTok, { reason: '临时暂缓验收排期' });
    assert.strictEqual(await statusOf(id4), '已暂缓', '[9d] 前置：hold 成功（hold.from 含待验证）');
    await call('POST', `/api/sys-issues/${id4}/resume`, adminTok, { reason: '排期恢复，继续验收' });
    assert.strictEqual(await statusOf(id4), '待验证', '[9d] 前置：resume 回到暂缓前活跃态（待验证）');
    const resumeTl = await get(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='resume' ORDER BY id DESC LIMIT 1`, [id4]);
    assert.ok(resumeTl && resumeTl.to_status === '待验证', '[9d] 前置：resume 确实产生一条 to_status=待验证 的 timeline 行（H1 场景真实复现，非臆造）');
    assert.strictEqual(await lastCompletedAt(id4), originalCompletedAt, '[9d] ⭐ resume 伪行被正确排除：last_completed_at 仍是原 ⑥ 降级完成时刻，未被 resume 这条「恢复时刻」冒充「完成时刻」（H1 根源场景验证）');
    ok('[9d] last_completed_at 白名单·resume 伪行排除：hold→resume 产生的 action_code=resume 的 status_change 行不进白名单，last_completed_at 保持原完成时刻不被顶替（H1 技术根源场景直接复现）');
  }

  {
    // [9e] 284 号 B3-⑤：主周期 SQL 断言——liaison_test_cycle_no 与 liaison_test_notify_cycle_no 两列
    //   必须全程同步递进（同一条 CAS 内自增写入，见 runWGate index.js :2347-2348 `liaison_test_cycle_no
    //   = liaison_test_cycle_no + 1, liaison_test_notify_cycle_no = liaison_test_cycle_no + 1`，SQL
    //   内自增引用旧值、不先读后写，两列同一语句写入）。此前 [9c] 只验过第二次进入后 liaison_test_
    //   cycle_no=2 这一个终值，从未验过 liaison_test_notify_cycle_no、也从未验过"首次进入=1"这一步——
    //   本组逐次核验 0（从未进入，列默认值）→ 首次进入两列均=1 → 二次进入两列均=2，不只验其中一列
    //   或只验最终值。
    const idCyc = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
    const daCycA = await mkMember(idCyc, 5, '开发甲', 'code_submitted');
    const daCycB = await mkMember(idCyc, 6, '开发乙', 'pending');
    const rowBefore = await issueRow(idCyc);
    assert.strictEqual(rowBefore.liaison_test_cycle_no, 0, '[9e] 前置：从未进入测试段，liaison_test_cycle_no=0（列默认值）');
    assert.strictEqual(rowBefore.liaison_test_notify_cycle_no, 0, '[9e] 前置：liaison_test_notify_cycle_no=0（列默认值，与主周期同步）');

    await triggerGateViaExcuse(idCyc, daCycB, '[9e] 第一轮进入测试段');
    assert.strictEqual(await statusOf(idCyc), '待对接测试', '[9e] 第一轮：进入待对接测试');
    const rowFirst = await issueRow(idCyc);
    assert.strictEqual(rowFirst.liaison_test_cycle_no, 1, '[9e] ⭐ 第一轮：liaison_test_cycle_no=1');
    assert.strictEqual(rowFirst.liaison_test_notify_cycle_no, 1, '[9e] ⭐ 第一轮：liaison_test_notify_cycle_no=1（与主周期同步，同一 CAS 内自增写入，非分两步）');

    // 打回重开，走第二轮（liaison-test-return：D18 钉死不计 return_count，仅走本条测试段专属打回）
    const rReturnCyc = await call('POST', `/api/sys-issues/${idCyc}/liaison-test-return`, liaisonTok, { reason: '[9e] 打回重开走第二轮' });
    assert.strictEqual(rReturnCyc.status, 200, `[9e] 前置：liaison-test-return 应 200，实际 ${rReturnCyc.status} ${JSON.stringify(rReturnCyc.body)}`);
    assert.strictEqual(await statusOf(idCyc), '开发中', '[9e] 前置：打回后回开发中');
    // §3.1b 打回=新一轮，清评估三字段+工期+受阻——重新回填工期才能再次通过 GATE 资格判定（同 [9c] 范式）。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted' WHERE id=?`, [daCycA]);
    // [C7] return 的换轮清字段套餐把 dev_estimated_at **与 estimated_effort_days** 一起清了（见 [7] 组断言），
    //   C7 起 GATE 对 feature/improvement 两 nf 值都查工期 → 只补预计完成、不补工期，第二轮仍会卡在
    //   gate_deferred_at 走不到 ⑦。两个字段必须一起补，才是返工后重填资格的完整模拟。
    await run(`UPDATE sys_issues SET dev_estimated_at=?, estimated_effort_days=1 WHERE id=?`, [futureEst(30), idCyc]);
    const daCycC = await mkMember(idCyc, 7, '开发丙', 'pending');
    await triggerGateViaExcuse(idCyc, daCycC, '[9e] 第二轮进入测试段');
    assert.strictEqual(await statusOf(idCyc), '待对接测试', '[9e] 第二轮：再次进入待对接测试');
    const rowSecond = await issueRow(idCyc);
    assert.strictEqual(rowSecond.liaison_test_cycle_no, 2, '[9e] ⭐ 第二轮：liaison_test_cycle_no=2（只增不清）');
    assert.strictEqual(rowSecond.liaison_test_notify_cycle_no, 2, '[9e] ⭐ 第二轮：liaison_test_notify_cycle_no=2（与主周期同步，两列全程同步递进，非仅验最终值）');
    ok('[9e] 284 号 B3-⑤：主周期 SQL 断言——liaison_test_cycle_no 与 liaison_test_notify_cycle_no 两列 0（从未进入）→ 首次均=1 → 二次均=2，逐次核验同步递进（同一 CAS 自增写入，此前只验过其中一列的终值）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [10] meta[7] 严格相等回归：feature 含「待对接测试」·improvement 不含·双向精确差集
  // ══════════════════════════════════════════════════════════════════════
  {
    const meta = T.buildMeta();
    const featureSet = meta.statusLabels.feature.slice().sort();
    const improvementSet = meta.statusLabels.improvement.slice().sort();
    const featureMinusLiaisonTest = featureSet.filter(s => s !== '待对接测试').sort();
    assert.deepStrictEqual(featureMinusLiaisonTest, improvementSet, '[10] feature 状态集去掉「待对接测试」后应与 improvement 严格相等（拆分后唯一合法差异）');
    assert.ok(featureSet.includes('待对接测试'), '[10] feature 状态集含「待对接测试」');
    assert.ok(!improvementSet.includes('待对接测试'), '[10] improvement 状态集不含「待对接测试」');
    // 双向：基础族并集与 ALLOWED_STATUSES 精确相等（本文件独立复核一遍 verify-sys-meta.js [7] 的核心断言，
    // 防止那边的严格断言未来被弱化时本文件毫无察觉——两处各自独立锁定同一不变量）。
    for (const type of ['feature', 'improvement']) {
      const unionSet = new Set();
      for (const fam of SF.BASE_FAMILY_NAMES) {
        for (const st of SF.getFamilyStatuses(type, fam)) unionSet.add(st);
      }
      const unionSorted = [...unionSet].sort();
      const allowedSorted = (T.ALLOWED_STATUSES[type] || []).slice().sort();
      assert.deepStrictEqual(unionSorted, allowedSorted, `[10] ${type} 基础族并集应与 ALLOWED_STATUSES 严格相等（无豁免，双向）`);
    }
    assert.strictEqual(SF.familyOfStatus('feature', '待对接测试'), 'LIAISON_TEST', '[10] feature「待对接测试」精确归属 LIAISON_TEST 族');
    assert.deepStrictEqual(SF.getFamilyStatuses('improvement', 'LIAISON_TEST'), [], '[10] improvement 的 LIAISON_TEST 族状态数组为空');
    ok('[10] meta[7] 严格相等回归：feature=improvement+{待对接测试}（双向精确差集，无豁免）+ 基础族并集与 ALLOWED_STATUSES 双向严格相等（本文件独立复核，不依赖 verify-sys-meta.js 断言强度）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [11] notify-liaison-test（C4b·方案 v1.1 §6·D16/D19/D20）：预占协议+触发者授权+recipient 自愈+dry-run
  // ══════════════════════════════════════════════════════════════════════
  {
    // ── [11a] D19 授权矩阵 ──────────────────────────────────────────────
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, devTok(999), { expected_cycle: cycle });
      assert.strictEqual(r.status, 403, `[11a-1] 非在册非admin 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_NOTIFY', '[11a-1] 错误码 NOT_AUTHORIZED_FOR_NOTIFY');
      ok('[11a-1] D19：非在册开发∧非 admin（devTok(999) 与本单毫无关联）→ 403 NOT_AUTHORIZED_FOR_NOTIFY');
    }
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, devTok(5), { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11a-2] 在册开发应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[11a-2] 在册开发触发成功 → sent');
      ok('[11a-2] D19：本单在册开发（user5=code_submitted 主开发）→ 200 放行，成功发送');
    }
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11a-3] admin 应 200，实际 ${r.status}`);
      ok('[11a-3] D19：admin → 200 放行（兜底）');
    }
    {
      // 自指：13 既是唯一受理人（收件人），也把 13 加入本单在册开发——用 13 的 token 调用 → 403 SELF_NOTIFY_FORBIDDEN。
      const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
      await mkMember(id, 13, '示例对接人', 'code_submitted');
      const daSecond = await mkMember(id, 6, '开发乙', 'pending');
      await triggerGateViaExcuse(id, daSecond, '进入测试段（13 自指场景）');
      assert.strictEqual(await statusOf(id), '待对接测试', '[11a-4] 前置：已进入待对接测试');
      const row = await issueRow(id);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, liaisonTok, { expected_cycle: row.liaison_test_cycle_no });
      assert.strictEqual(r.status, 403, `[11a-4] 自指应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SELF_NOTIFY_FORBIDDEN', '[11a-4] 错误码 SELF_NOTIFY_FORBIDDEN');
      ok('[11a-4] D19 自指硬守卫：收件人=操作者本人（13 身兼受理人+本单在册开发）→ 403 SELF_NOTIFY_FORBIDDEN（在册身份不豁免自指）');
    }
    {
      const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
      await mkMember(id, 5, '开发甲', 'pending');
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: 1 });
      assert.strictEqual(r.status, 409, `[11a-5] 非待对接测试态应 409，实际 ${r.status}`);
      assert.strictEqual(r.body.code, 'STATUS_NOT_NOTIFIABLE', '[11a-5] 错误码 STATUS_NOT_NOTIFIABLE');
      ok('[11a-5] 状态门：单据仍在「开发中」（未进测试段）→ 409 STATUS_NOT_NOTIFIABLE');
    }
    {
      const { id } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, {});
      assert.strictEqual(r.status, 400, `[11a-6] 缺 expected_cycle 应 400，实际 ${r.status}`);
      assert.strictEqual(r.body.code, 'EXPECTED_CYCLE_REQUIRED', '[11a-6] 错误码 EXPECTED_CYCLE_REQUIRED');
      ok('[11a-6] 请求体校验：缺 expected_cycle → 400 EXPECTED_CYCLE_REQUIRED');
    }

    // ── [11b] CAS 生命周期（预占+回写两段事务） ──────────────────────────
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11b-1] 正常预占应 200，实际 ${r.status}`);
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'sent', '[11b-1] 落库 sent');
      assert.strictEqual(row.liaison_test_notify_message_key, 'stub-liaison-test', '[11b-1] message_key 落库（打桩返回值）');
      assert.ok(row.liaison_test_notified_at, '[11b-1] notified_at 非空');
      assert.strictEqual(row.liaison_test_attempt_token, null, '[11b-1] ⭐ attempt_token 回写时清空（sending 中间态不留痕迹）');
      assert.strictEqual(row.liaison_test_attempt_started_at, null, '[11b-1] ⭐ attempt_started_at 回写时清空');
      assert.strictEqual(row.liaison_test_notify_sent_by, 1, '[11b-1] sent_by=admin(uid1)');
      assert.strictEqual(row.liaison_test_read_at, null, '[11b-1] read_at 清空（新一轮投递起点）');
      ok('[11b-1] CAS 正常生命周期：not_sent → sending →（事务外调用）→ sent，token/started_at 清空，sent_by/message_key/notified_at 正确落库');
    }
    {
      // 并发抢占失败：手动把状态钉在 sending（模拟另一请求正持有预占权，未超窗）→ 409 SENDING_IN_PROGRESS
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='other-token', liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 409, `[11b-2] 并发占用应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS', '[11b-2] 错误码 SENDING_IN_PROGRESS');
      ok('[11b-2] CAS 并发抢占失败：sending 未超窗（模拟另一请求在途）→ 409 LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS');
    }
    {
      // stale 覆盖：sending 超过 10 分钟恢复窗口 → 允许新 attempt 覆盖并成功（方案 §6 逐字冻结的恢复窗口）
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='stale-token', liaison_test_attempt_started_at=datetime('now','localtime','-11 minutes') WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11b-3] stale 覆盖应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[11b-3] stale 覆盖后成功发送');
      ok('[11b-3] CAS stale 覆盖：sending 超 10 分钟恢复窗口（崩溃/超时场景）→ 新 attempt 允许覆盖并成功');
    }
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_notify_status='failed', liaison_test_notify_error='mock-failure' WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11b-4] failed 重试应 200，实际 ${r.status}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[11b-4] failed 重试成功后 sent');
      ok('[11b-4] CAS failed 重试：failed 态 → 重新预占并成功发送');
    }
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const first = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(first.status, 200, `[11b-5] 前置首发应 200，实际 ${first.status}`);
      const second = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(second.status, 409, `[11b-5] sent 后再点应 409，实际 ${second.status} ${JSON.stringify(second.body)}`);
      assert.strictEqual(second.body.code, 'LIAISON_TEST_NOTIFY_ALREADY_SENT', '[11b-5] 错误码 ALREADY_SENT');
      ok('[11b-5] CAS 同周期 sent 后再点 → 409 LIAISON_TEST_NOTIFY_ALREADY_SENT');
    }
    {
      // 周期号不匹配（reopen-ABA 反证）：expected_cycle 传旧值（+1，模拟前端页面停留在上一轮未刷新）
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle + 1 });
      assert.strictEqual(r.status, 409, `[11b-6] 周期不匹配应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_CYCLE_MISMATCH', '[11b-6] 错误码 CYCLE_MISMATCH');
      ok('[11b-6] CAS 周期号不匹配（reopen-ABA 反证）：expected_cycle≠当前 liaison_test_cycle_no/notify_cycle_no → 409 LIAISON_TEST_CYCLE_MISMATCH');
    }

    // ── [11c] D20 claim 自愈 ────────────────────────────────────────────
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=999999, liaison_test_recipient_name='已失效旧对接人' WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11c-1] recipient 失效应自愈成功 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_recipient_id, 13, '[11c-1] ⭐ claim 自愈：recipient 回收敛到该单绑定对接人(intake_liaison_id=13·C10)');
      ok('[11c-1] D20 claim 自愈：recipient 失效（不在当前 active 池，模拟对接人停用/移出白名单后）→ 自动 claim 到该单绑定对接人(13)成功后继续预占发送');
    }
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=NULL, liaison_test_recipient_name=NULL WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11c-2] recipient NULL 应自愈成功 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_recipient_id, 13, '[11c-2] recipient NULL（存量/异常）→ claim 自愈到该单绑定对接人(13)');
      ok('[11c-2] D20 claim 自愈：recipient NULL → 自动 claim 到该单绑定对接人(13)成功');
    }
    {
      // ⭐ [C10] 该单绑定对接人(intake_liaison_id=13)被停用 → 绑定对接人不在 active 候选池 → 409 UNBOUND；
      //   finally 恢复 active，防污染其余依赖 13 的用例。
      //   （C10 self-heal 目标=该单 intake_liaison_id，非"候选池唯一成员"；13 停用后 boundLiaison 解析为空
      //    → LIAISON_TEST_RECIPIENT_UNBOUND，取代旧「候选池 0 人 → CONFIG_ERROR」判据。此时池内其余 user
      //    5/6/7/8 仍 active，但本单绑的是 13、不回退候选池，故仍 UNBOUND。）
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=999999 WHERE id=?`, [id]);
      await run(`UPDATE users SET status='inactive' WHERE id=13`);
      try {
        const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
        assert.strictEqual(r.status, 409, `[11c-3] 绑定对接人失效应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'LIAISON_TEST_RECIPIENT_UNBOUND', '[11c-3] 错误码 UNBOUND（C10：绑定对接人 13 停用·不在 active 池·不回退候选池）');
      } finally {
        await run(`UPDATE users SET status='active' WHERE id=13`);
      }
      ok('[11c-3] ⭐ C10 D20 claim：该单绑定对接人(13)被停用 → 409 LIAISON_TEST_RECIPIENT_UNBOUND（self-heal 目标=本单 intake_liaison_id·不回退候选池·测后已恢复 13=active，不留污染）');
    }

    // ── [11d] dry-run（D16）：完整走 CAS+留痕，唯独不调真实发送函数 ──────────
    {
      dryRunConfigValue = 'on';
      sendCallCount = 0;
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      dryRunConfigValue = null;   // 立即复位（断言前），防后续用例被本节开关污染
      assert.strictEqual(r.status, 200, `[11d] dry-run 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[11d] dry-run 仍落 sent（完整走 CAS+留痕）');
      const row = await issueRow(id);
      assert.ok(row.liaison_test_notify_message_key && row.liaison_test_notify_message_key.startsWith('dryrun-'),
        `[11d] ⭐ message_key 须带 dryrun- 前缀标记，实际=${row.liaison_test_notify_message_key}`);
      assert.ok(row.liaison_test_notified_at, '[11d] notified_at 仍照写（留痕完整，非"假装没发生"）');
      assert.strictEqual(row.liaison_test_attempt_token, null, '[11d] attempt_token 回写清空（CAS 全走完整流程）');
      assert.strictEqual(sendCallCount, 0, '[11d] ⭐⭐ dry-run 开启时 sendIssueDingtalkRaw 调用次数=0（打桩计数断言，D16 核心承诺）');
      // [281 号对抗审 N1/A1/A3 采纳] 成功响应须带 dry_run:true——前端据此区分"演练已记录"与"钉钉已发送"
      // 文案（Sys_Iteration.html siNotifyLiaisonTestClick）；同批既有字段（收件人/状态）不因新增字段回归。
      assert.strictEqual(r.body.dry_run, true, '[11d] ⭐ 成功响应须含 dry_run:true');
      assert.strictEqual(r.body.liaison_test_recipient_id, 13, '[11d] 既有字段不回归：liaison_test_recipient_id 仍正确返回');
      assert.ok(r.body.liaison_test_recipient_name, '[11d] 既有字段不回归：liaison_test_recipient_name 仍返回');
      assert.strictEqual(r.body.liaison_test_notify_error, null, '[11d] 既有字段不回归：liaison_test_notify_error 仍返回（成功场景为 null）');
      // [282 号复审 HIGH·N1 收口] timeline 审计层演练限定——channel 按 dry_run 分叉为「对接测试演练」，
      // summary 因此含"演练"二字，防止审计读者把 dry-run 场景的"成功"误读成真实外呼成功。
      const tl = await latestTimeline(id);
      assert.ok(tl, '[11d] 前置：dry-run 成功后应有 timeline 行');
      assert.strictEqual(tl.action_code, 'notify_sent', '[11d] timeline action_code 仍为 notify_sent（未新增枚举值）');
      assert.ok(tl.summary && tl.summary.includes('演练'), `[11d] ⭐ 282 号复审收口：dry-run 场景 timeline summary 须含"演练"二字，实际="${tl.summary}"`);
      assert.ok(tl.summary && tl.summary.includes('dryrun-'), `[11d] timeline summary 仍含 message_key（dryrun-前缀），实际="${tl.summary}"`);
      ok('[11d] D16 dry-run：system_configs.sys_notify_dry_run=\'on\' 时完整走 CAS+留痕（message_key=dryrun-前缀+notified_at 照写+attempt 列正常清空），且真实发送函数 sendIssueDingtalkRaw 调用次数=0（打桩计数验证）+ 成功响应带 dry_run:true 且既有字段不回归 + timeline summary 含"演练"限定语（282 号复审收口）');
    }

    // ── [11g] 282 号复审 MED 补净：源码断言——writeback 连续失败/concurrent_changed 两个 200 响应分支
    //   的 dry_run 契约（不可达分支：需 writebackLiaisonTestNotify 连续两次异常，或预占后回写被并发
    //   CAS 抢走，均不具备在本文件用打桩手段稳定复现的条件——沿用 [16 前置] 同款"源码断言=弱证据"
    //   范式：只证明"index.js 与这几条正则描述的结构一致"，不是运行时直接验证，若结构改写本断言先变
    //   红提醒同步。 ────────────────────────────────────────────────
    {
      const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
      assert.ok(routeSrc.includes('sent_externally: !!sendResult.ok && !sendResult.dry_run'),
        '[11g] 源码断言：writeback 连续失败分支 sent_externally 契约式仍为 "!!sendResult.ok && !sendResult.dry_run"（dry-run 下恒 false）');
      assert.ok(/error:\s*sendResult\.dry_run\s*\n\s*\?\s*'演练回写失败/.test(routeSrc),
        '[11g] 源码断言：writeback 连续失败分支 error 文案仍按 dry_run 分叉（演练 vs 真发两套措辞）');
      assert.ok(/return res\.json\(\{ id, concurrent_changed: true, liaison_test_notify_status: fresh \? fresh\.ns : null, dry_run: !!sendResult\.dry_run \}\);/.test(routeSrc),
        '[11g] 源码断言：concurrent_changed 响应体仍含 dry_run 字段');
      ok('[11g] 282 号复审 MED 补净·源码断言（弱证据，运行时不可达）：writeback 连续两次异常分支 sent_externally 契约式 + error 文案 dry_run 分叉，concurrent_changed 响应体含 dry_run 字段，均与当前 index.js 源码结构一致');
    }

    // ── [11e] ⭐ C10：候选池 ≥2 也不再 AMBIGUOUS——self-heal 恒 claim 到该单绑定对接人(intake_liaison_id) ──
    //   原 D20「候选不唯一 → AMBIGUOUS」是 SYS_INTAKE_LIAISON_IDS 单例池时代的产物；C10 裁定1/决策1 废白名单、
    //   self-heal 目标改为**该单 intake_liaison_id**（本单绑定对接人），与候选池大小无关、无歧义可言，
    //   AMBIGUOUS 分支整体删除。本文件 users 表本就有 5 个 active user（5/6/7/8/13）→ 候选池天然 ≥2，
    //   无需再借 SYS_INTAKE_LIAISON_IDS push 构造；直接验「≥2 候选下仍精确 claim 到绑定的 13」。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();   // 绑定 intake_liaison_id=13
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=999999 WHERE id=?`, [id]);   // 失效旧值，逼进 claim 分支
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11e] 候选≥2 仍 self-heal 到绑定对接人，应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_recipient_id, 13, '[11e] ⭐ C10：候选池 ≥2（种子 5 人 user）时 self-heal 恒指向该单绑定对接人(intake_liaison_id=13)，非歧义拒绝');
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_recipient_id, 13, '[11e] claim 落库 recipient=13（绑定对接人）');
      assert.strictEqual(row.liaison_test_notify_status, 'sent', '[11e] 发送成功落 sent（stub·非歧义拒绝）');
      ok('[11e] ⭐ C10 self-heal 无歧义：active 候选池 ≥2（种子本就 5 人 user）时，claim 自愈仍精确指向该单 intake_liaison_id=13，AMBIGUOUS 分支已随白名单废止删除');
    }

    // ── [11f] 281 号对抗审 C3 采纳：自指守卫 ID 类型归一化——:11242 `Number(targetRecipientId) ===
    //   Number(actor.id)` 双侧显式归一化 ──────────────────────────────────
    //   ⚠️ 自决偏离披露：sysActor()（index.js :1729）在请求入口即把 actor.id 转成 Number，
    //   liaison_test_recipient_id 又是 INTEGER 列（SQLite 类型亲和性下即便手写字符串写入也会被存储层
    //   转成整数），故在当前代码路径下两侧到达 :11242 时实际恒为 number——本用例无法构造出"移除该
    //   Number() 包裹会导致断言变红"的严格 red→green 证据，是一条**回归防线测试**（防未来有人在别处
    //   新增不经 sysActor 的 actor 构造方式，或误传非数字 JWT payload），非当前活跃 bug 的复现。
    //   为如实覆盖"数字/字符串 id 归一化比较"这一意图，构造 JWT payload.id 为字符串 '13'（历史 token/
    //   客户端拼装差异的合理输入面）复刻 [11a-4] 自指场景，验证端到端自指判定不受影响。
    {
      const strLiaisonTok = jwt.sign({ id: '13', username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
      const id = await mkIssue('feature', '开发中', { intakeLiaisonId: 13 });
      await mkMember(id, 13, '示例对接人', 'code_submitted');
      const daSecond = await mkMember(id, 6, '开发乙', 'pending');
      await triggerGateViaExcuse(id, daSecond, '进入测试段（字符串 id 自指场景）');
      assert.strictEqual(await statusOf(id), '待对接测试', '[11f] 前置：已进入待对接测试');
      const row = await issueRow(id);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, strLiaisonTok, { expected_cycle: row.liaison_test_cycle_no });
      assert.strictEqual(r.status, 403, `[11f] 字符串 id 自指应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SELF_NOTIFY_FORBIDDEN', '[11f] 错误码 SELF_NOTIFY_FORBIDDEN');
      ok('[11f] D19 自指守卫 ID 类型归一化（回归防线，非当前活跃 bug 复现——见上方自决偏离披露）：JWT actor.id 为字符串 \'13\'（示例对接人既是唯一受理人也在册）→ 端到端仍正确判定自指 → 403 SELF_NOTIFY_FORBIDDEN');
    }

    // ── [11h] ⭐⭐⭐ C10-fix2 HIGH-1：收件人可用判据加"等于当前绑定人"——改绑后不发旧对接人（越权知悉修复）──
    //   触发路径：单原绑对接人并把 liaison_test_recipient_id 写成 u5（仍 active eligible），随后改绑
    //   intake_liaison_id → u6（u5/u6 均 active）。修复前 targetIsUsable 只看"u5 仍在 active 候选池"→ true →
    //   跳过自愈 → 继续发 u5 = 通知发给已失去该单对接资格的旧对接人（越权知悉）。修复后判据加
    //   `recipient===当前 intake_liaison_id` → u5≠u6 → 进自愈 CAS 把收件人改为 u6。
    {
      // [11h-1] not_sent 态：改绑后自愈到当前绑定人 u6（非旧对接人 u5）
      const { id, cycle } = await mkFreshLiaisonTestIssue();   // 绑定 intake_liaison_id=13·进入时 recipient=13
      // 构造"收件人=旧对接人 u5(仍 active) + 已改绑到 u6"：直连 SQL 写 recipient=5，intake_liaison_id 改 6
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=5, liaison_test_recipient_name='开发甲', intake_liaison_id=6 WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[11h-1] 改绑后 notify 应自愈到新对接人并发送 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_recipient_id, 6, '[11h-1] ⭐⭐⭐ 收件人自愈到当前绑定人 u6（非旧对接人 u5）——越权知悉修复');
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_recipient_id, 6, '[11h-1] claim 落库 recipient=6（当前 intake_liaison_id）');
      assert.notStrictEqual(row.liaison_test_recipient_id, 5, '[11h-1] 旧对接人 u5 未被沿用');
      ok('[11h-1] ⭐⭐⭐ C10-fix2 HIGH-1：recipient=u5(旧对接人·仍 active) + intake_liaison_id 改绑 u6 → notify 自愈把收件人改为 u6（当前绑定人），不再发给失去该单权限的 u5（越权知悉修复·收件人可用判据加"等于当前绑定人"）');
    }
    {
      // [11h-2] sending 态：改绑后 CAS 因 sending 锁 no-op → 重读采信收窄（claimed≠当前绑定人）→ 409 CHANGED
      //   （不把 stale 旧收件人 u5 重新采信发送——re-read 采信从"在 active 池即采信"收窄为"等于当前绑定人"）
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_recipient_id=5, liaison_test_recipient_name='开发甲', intake_liaison_id=6,
        liaison_test_notify_status='sending', liaison_test_attempt_token='concurrent-tok-11h', liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 409, `[11h-2] sending 期间改绑 → 应 409 CHANGED，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_RECIPIENT_CHANGED', '[11h-2] 错误码 LIAISON_TEST_RECIPIENT_CHANGED（re-read 采信收窄：stale u5≠当前绑定人 u6·fail-closed 不沿用旧收件人）');
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_recipient_id, 5, '[11h-2] sending 锁生效：收件人未被改动（CAS no-op），但也未被采信发送（409）');
      ok('[11h-2] ⭐ C10-fix2 HIGH-1（re-read 收窄）：sending 期间 recipient=u5(stale)+改绑 u6 → CAS 因 sending 锁 no-op → 重读采信判 u5≠当前绑定人 u6 → 409 CHANGED（不把 stale 旧收件人重新采信·不越权发 u5）');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [12] pass/return 新端点授权负例（C4 合并修复批 275-M6·⭐ C10 更新）——两端点挂 requireIntakeLiaison
  //   中间件（C10 后=admin ∨ role∈候选 allowlist·粗筛）+ 引擎 roleGuard='intake_liaison' 绑单精判（handler 层）。
  //   授权判定与 roster 成员身份**完全正交**（不查 sys_issue_dev_assignees）——下面两组反例刻意验证
  //   "在本单在册"这个身份不构成任何后门。⚠️ C10 后普通开发(user)**过粗筛**，真正拦截来自引擎绑单精判
  //   （单绑 13·非该单对接人）→ 拒绝码由中间件 NOT_ADMIN_OR_INTAKE_LIAISON 变为引擎 NOT_BOUND_LIAISON。
  // ══════════════════════════════════════════════════════════════════════
  {
    for (const action of ['liaison-test-pass', 'liaison-test-return']) {
      // ⭐ D22-④ 批2：pass 分支带 test_note 凭证（403 两组不受影响——角色守卫在评估凭证之前就先拦下；
      //   200 admin 组若不带凭证会撞新码 LIAISON_TEST_PASS_EVIDENCE_REQUIRED，非本组要测的授权维度）。
      const body = action === 'liaison-test-return' ? { reason: '275-M6 授权负例测试' } : { test_note: '275-M6 授权负例测试' };

      // 普通在册开发（本单在册·非池·非admin）→ 403：证"在册"不是后门。
      {
        const { id } = await mkFreshLiaisonTestIssue();   // user5=主开发在册、user6=已 excuse 在册
        const r = await call('POST', `/api/sys-issues/${id}/${action}`, devTok(5), body);
        assert.strictEqual(r.status, 403, `[12-${action}-roster] 普通在册开发应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'NOT_BOUND_LIAISON', `[12-${action}-roster] 错误码 NOT_BOUND_LIAISON（C10：user 过粗筛·引擎绑单精判拒·单绑 13 非 dev5）`);
        assert.strictEqual(await statusOf(id), '待对接测试', `[12-${action}-roster] 拒绝后状态不变`);
        ok(`[12-${action}-roster] 普通在册开发（本单在册·非池·非admin）→ 403 NOT_BOUND_LIAISON（在册身份不构成后门·C10 引擎绑单精判）`);
      }

      // 非池非本单用户（与本单毫无关联）→ 403：证与"是否在本单出现过"无关，纯白名单判定。
      {
        const { id } = await mkFreshLiaisonTestIssue();
        const r = await call('POST', `/api/sys-issues/${id}/${action}`, devTok(9999), body);
        assert.strictEqual(r.status, 403, `[12-${action}-stranger] 非池非本单用户应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'NOT_BOUND_LIAISON', `[12-${action}-stranger] 错误码 NOT_BOUND_LIAISON（C10：user 过粗筛·引擎绑单精判拒·非该单对接人）`);
        ok(`[12-${action}-stranger] 非池非本单用户（与本单毫无关联）→ 403 NOT_BOUND_LIAISON（C10 引擎绑单精判）`);
      }

      // admin → 200：兜底放行（roleGuard='intake_liaison' 语义=池∨admin）。
      {
        const { id } = await mkFreshLiaisonTestIssue();
        const r = await call('POST', `/api/sys-issues/${id}/${action}`, adminTok, body);
        assert.strictEqual(r.status, 200, `[12-${action}-admin] admin 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
        ok(`[12-${action}-admin] admin → 200（roleGuard=intake_liaison 含 admin 兜底）`);
      }
    }

    // [codex 276 号审 H-2 收口] 275-M6 第 4 项"对接人停用后 403"——**证据闭合，非本模块口径出入**：
    //   requireIntakeLiaison（index.js:384-388）/isSysIntakeLiaison（:352-354）/sysIssueTransition
    //   roleGuard='intake_liaison' 分支（:2705）确实都是纯白名单 id 判定、不查 users.status（本模块层面
    //   如实）。但**生产认证层全局拦停用**——server.js:4035-4058 `authenticateToken` 中间件在校验 JWT
    //   签名之后，会 `SELECT status FROM users WHERE id=?` 实时查库（:4048），非 active 直接 403「账号已
    //   被禁用」，请求根本进不到 requireIntakeLiaison 这一层。即"操作权=白名单成员恒有权"与"通知收件人=
    //   白名单∩active"的双轨设计（本模块层面成立）之外，还有认证层这道全局闸门兜底停用场景——两层合起来
    //   才是完整答案，非本模块存在权限口径缺口。
    //   ⚠️ 本测试栈的 authenticateToken 是**本文件顶部自建的 stub**（:41-45，仅 `jwt.verify` 验签，
    //   不接 db 查 status），与生产中间件不同源。
    //   ⭐⭐⭐ [C10-fix5 HIGH·断言翻转·codex 322 末次审] 语义已变更：liaison-test-pass 走 makeTransitionEndpoint
    //     → 引擎 roleGuard='intake_liaison' 分支（transitions.js:606），该分支的 isBoundLiaison 精判**已叠加实时
    //     `isIntakeLiaisonEligible`（active ∧ role∈候选 allowlist）**——即"撤销候选资格同步撤销存量绑单操作权"（与
    //     直连 handler / 通知端 resolveValidBoundLiaisonForNotify 同口径·fail-closed）。故本模块层**自身**现在就会
    //     实时查库拒停用/移出候选的绑定人，**不再单独依赖生产认证层兜底**（防御纵深）：id=13 是本单绑定对接人，
    //     status='inactive' ⇒ isIntakeLiaisonEligible=false ⇒ isBoundLiaison=false ⇒ 引擎 403 NOT_BOUND_LIAISON。
    //     此前（C10-fix5 前）本处 assert 200 记录的"模块纯白名单判定、不叠加 status 检查"契约**已被本批有意推翻**
    //     （原契约的 fail-open 残留正是 322 HIGH 要闭合的对象）。**注意**：这同时覆盖 role→viewer（仍 active·移出
    //     候选）与 status→inactive 两种撤销资格路径——isIntakeLiaisonEligible 对两者皆 false。
    //     ⚠️ 生产认证层那道 SELECT status 全局闸门（server.js:4035-4058）依然在、仍会更早 403 停用账号——两道闸
    //     互为纵深，本模块闸的价值在 role→viewer（认证层放行·仍 active）这条认证层拦不住的路径上。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE users SET status='inactive' WHERE id=13`);
      try {
        const r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '停用账号测试前置' });
        assert.strictEqual(r.status, 403, `[12-pass-deactivated] ⭐ C10-fix5 HIGH：停用（撤销资格）的绑定对接人 liaison-test-pass 应被引擎绑单精判 403（模块层自查 eligibility·fail-closed·不再仅靠认证层兜底），实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body && r.body.code, 'NOT_BOUND_LIAISON', `[12-pass-deactivated] 确切码 NOT_BOUND_LIAISON，实得 ${r.body && r.body.code}`);
        assert.strictEqual(await statusOf(id), '待对接测试', '[12-pass-deactivated] 零副作用：403 后主状态仍「待对接测试」（未推进待验证）');
      } finally {
        await run(`UPDATE users SET status='active' WHERE id=13`);
      }
      ok('[12-pass-deactivated] ⭐ C10-fix5 HIGH 断言翻转：liaison-test-pass 经引擎 roleGuard=intake_liaison 绑单精判现叠加实时 isIntakeLiaisonEligible——停用/移出候选的绑定对接人 403 NOT_BOUND_LIAISON（模块层自查资格·防御纵深·零副作用），此前"模块纯白名单不叠 status 检查"的 fail-open 契约已由本批有意闭合；测后已恢复 13=active');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [13] codex 276 号审 H-1/M-1 收口验证——收件人竞态绑定 + 异常收敛 + NULL started_at 恢复 + 并发双发
  // ══════════════════════════════════════════════════════════════════════
  {
    // [13a] H-1 收件人竞态：预占前（读主行快照之后、CAS 之前）recipient 被并发改动 → 409
    //   LIAISON_TEST_RECIPIENT_CHANGED，且零外呼（打桩计数）——证 CAS 真的绑定了收件人快照，不是
    //   读到旧快照就无条件发给旧收件人。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendCallCount = 0;
      recipientRaceInject = { issueId: id, newRecipientId: 555555 };
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(recipientRaceInject, null, '[13a] 前置：竞态注入已按一次性消费（否则说明本次请求根本没读到那一行，用例夹具有问题）');
      assert.strictEqual(r.status, 409, `[13a] 收件人竞态应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_RECIPIENT_CHANGED', '[13a] 错误码 LIAISON_TEST_RECIPIENT_CHANGED');
      assert.strictEqual(sendCallCount, 0, '[13a] ⭐⭐ 零外呼：CAS 在预占层就已挡下，从未走到发送步骤（打桩计数验证，H-1 核心承诺——不会把消息发给快照里的旧收件人）');
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'not_sent', '[13a] 通知列组未被污染（CAS 失败=no-op，仍是 ⑦ 进入时的初始态）');
      ok('[13a] ⭐ H-1 收件人竞态绑定：预占前 recipient 被并发改动 → CAS 因 liaison_test_recipient_id 不匹配而拒绝，409 LIAISON_TEST_RECIPIENT_CHANGED + 零外呼（非"读到旧快照就发给旧收件人"）');
    }

    // ══════════════════════════════════════════════════════════════════
    // [13-binding] ⭐ HIGH（codex 319-R·纵深防御）：预占前（读主行快照后、CAS 之前）intake_liaison_id 被
    //   并发改绑 → 预占 CAS 因新增 `AND intake_liaison_id = ?` 落空（changes=0）→ 409
    //   LIAISON_TEST_RECIPIENT_CHANGED + 零外呼。⚠️ 纵深性质如实标注：本模块当前**无 u5→u6 换对接人端点**
    //   （L2 缺口），此 TOCTOU 现网触发路径为空——保留本闸 + 本测是**防将来 L2 上线**（见 index.js
    //   preemptLiaisonTestNotifySend 注释）。双向证明：负例改绑→CAS 落空零外呼；正例不改→约束不误伤照常 200 sent。
    // ══════════════════════════════════════════════════════════════════
    {
      // 负例：读主行后改绑 → CAS 必落空、零外呼、通知列组不污染
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      assert.strictEqual(Number((await issueRow(id)).intake_liaison_id), 13, '[13-binding前置] 新鲜单 intake_liaison_id=13（绑定人=收件人=13）');
      sendCallCount = 0;
      bindingRaceInject = { issueId: id, newLiaisonId: 999999 };   // 读主行后把绑定改到别人（模拟未来 L2 换对接人）
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(bindingRaceInject, null, '[13-binding] 前置：改绑注入已按一次性消费（否则请求根本没读到那一行，夹具有问题）');
      assert.strictEqual(r.status, 409, `[13-binding] 改绑后应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_RECIPIENT_CHANGED', '[13-binding] 错误码 LIAISON_TEST_RECIPIENT_CHANGED（binding_changed 归入既有 CHANGED 分支）');
      assert.strictEqual(sendCallCount, 0, '[13-binding] ⭐⭐ 零外呼：预占 CAS 的 intake_liaison_id 约束在发送前挡下，绝不把消息发给改绑前的旧对接人');
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'not_sent', '[13-binding] 通知列组未污染（CAS no-op=仍是 ⑦ 进入时初始态）');
      assert.strictEqual(Number(row.intake_liaison_id), 999999, '[13-binding] 前置确认：注入确已改绑（现值=注入值），证明 TOCTOU 窗口真实存在而 CAS 恰因此落空');
      ok('[13-binding] ⭐ HIGH 纵深：读主行后 intake_liaison_id 被并发改绑 → 预占 CAS 因 AND intake_liaison_id=? 落空 → 409 CHANGED + 零外呼（防 L2 换对接人端点上线后把消息错发给改绑前旧对接人·越权知悉）');
    }
    {
      // 正例对照（绿）：无并发改绑 → 新增约束不误伤 happy path，正常 200 sent + 恰 1 次外呼
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendCallCount = 0;
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[13-binding-ctrl] 无改绑应正常 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[13-binding-ctrl] 正常发送 sent');
      assert.strictEqual(sendCallCount, 1, '[13-binding-ctrl] 恰 1 次外呼（约束匹配当前绑定=13·happy path 不回归）');
      ok('[13-binding-ctrl] ⭐ 双向证明对照组：binding 未变时预占 CAS 的 intake_liaison_id 约束正常放行 → 200 sent + 恰 1 次外呼（新增约束只挡真改绑·不误伤 happy path）');
    }

    // [13b] codex 278 号审 H-1 改写 + codex 279 号审 L-1 改码：sendIssueDingtalkRaw 本身对全部"下游明确
    //   拒绝"场景统统走返回值协议 {ok:false}（server.js:11937-11990 已复核，从不因这些确定性失败
    //   throw）——会真正让本函数抛出的只有"结果未知"这一类（超时 或 该函数唯一未包 try/catch 的裸抛），
    //   故 sendShouldThrow 模拟的"外呼这一步本身抛异常"归入结果未知：504 + 不回写 + 保持 sending +
    //   立即重试应撞 sending_in_progress（未超窗，无法绕过）。⭐ L-1：非 NotifyTimeoutError 的这类
    //   异常改用独立错误码 LIAISON_TEST_NOTIFY_RESULT_UNKNOWN（同 504、同重试策略，仅 code 不同，
    //   区别于 [13b''] 真实超时命中的 LIAISON_TEST_NOTIFY_TIMEOUT）。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendShouldThrow = new Error('模拟外呼抛异常（sendIssueDingtalkRaw 内部裸抛，无法判定是否已送达）');
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(sendShouldThrow, null, '[13b] 前置：打桩已按一次性消费（否则说明请求根本没走到外呼这步）');
      assert.strictEqual(r.status, 504, `[13b] ⭐ 外呼抛异常应归结果未知 → 504，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_NOTIFY_RESULT_UNKNOWN', '[13b] ⭐ L-1 独立错误码 LIAISON_TEST_NOTIFY_RESULT_UNKNOWN（非超时来源，区别于 [13b\'\'] 的 TIMEOUT）');
      assert.ok(r.body.stale_at, `[13b] 响应带 stale_at 提示，实际=${r.body.stale_at}`);
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'sending', '[13b] ⭐ 不回写 failed，保持 sending（H-1 分类：无法证明消息未送达）');
      assert.ok(row.liaison_test_attempt_token, '[13b] attempt_token 未被清空（悬挂态，非正常回写路径）');
      // 立即重试——未超窗，应撞 409 sending_in_progress（无法绕过，只有 stale 窗口/结构性极限才能恢复）。
      const r2 = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r2.status, 409, `[13b] 立即重试应撞 sending_in_progress，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.code, 'LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS', '[13b] 错误码 SENDING_IN_PROGRESS（立即重试被正确拦下，不能绕过"结果未知"这道闸）');
      ok('[13b] ⭐ H-1 分类+L-1 改码：外呼函数本身抛异常（无从区分是否已送达）→ 504 LIAISON_TEST_NOTIFY_RESULT_UNKNOWN + 不回写保持 sending + stale_at 提示，立即重试被 409 拦下（唯一合法重试路径是 10 分钟 stale 窗口）');
    }

    // [13b-stale-err] codex 279 号审 M-1：stale_at 辅助查询本身抛异常——不得连累核心响应语义
    // （仍应 504 + 结果未知码），仅 stale_at 退化为 null。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendShouldThrow = new Error('模拟外呼裸抛');
      staleAtQueryShouldThrow = new Error('模拟 stale_at 查询异常（DB busy/连接抖动等）');
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(staleAtQueryShouldThrow, null, '[13b-stale-err] 前置：stale_at 查询打桩已消费（确认真的走到这一步）');
      assert.strictEqual(r.status, 504, `[13b-stale-err] ⭐ stale_at 查询失败不改变核心响应状态码，仍应 504，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(r.body.code === 'LIAISON_TEST_NOTIFY_RESULT_UNKNOWN' || r.body.code === 'LIAISON_TEST_NOTIFY_TIMEOUT', `[13b-stale-err] ⭐ 仍应带 LIAISON_TEST_NOTIFY_* 码，实际=${r.body.code}`);
      assert.strictEqual(r.body.stale_at, null, `[13b-stale-err] ⭐ stale_at 因查询失败退化为 null（辅助信息降级不阻塞主响应），实际=${r.body.stale_at}`);
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'sending', '[13b-stale-err] 主状态仍正确保持 sending（未被 stale_at 查询异常干扰）');
      ok('[13b-stale-err] ⭐ M-1：stale_at 辅助查询抛异常不连累核心响应——仍 504 + LIAISON_TEST_NOTIFY_* 码，仅 stale_at 降级为 null');
    }

    // [13b-sent-externally-false] codex 279 号审 H-1：writeback 双败场景下 sendResult.ok=false（确定
    // 未送达，非抛异常）路径的 sent_externally 契约——须为 false（区别于 [15b] 覆盖的 ok=true 路径）。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendShouldReturnFailure = 'no_phone';
      writebackThrowCount = 2;
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(writebackThrowCount, 0, '[13b-sent-externally-false] 前置：两次回写打桩均已消费');
      assert.strictEqual(sendShouldReturnFailure, null, '[13b-sent-externally-false] 前置：send 失败打桩已消费（确认走的是正常 resolve 非 throw 路径）');
      assert.strictEqual(r.status, 200, `[13b-sent-externally-false] 实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.writeback_failed, true, '[13b-sent-externally-false] writeback_failed:true');
      assert.strictEqual(r.body.sent_externally, false, '[13b-sent-externally-false] ⭐ H-1 契约：send 确定失败（ok=false，非抛异常）时 sent_externally=false（区别于 [15b] 的 true 路径）');
      ok('[13b-sent-externally-false] ⭐ H-1 双分支契约：send 正常 resolve 为 ok=false（确定未送达）+ 回写连续两次异常 → 响应 200 + writeback_failed:true + sent_externally:false');
    }

    // [13b'] H-1 分类·确定失败对照组：异常发生在"触达外呼之前"（本地操作，无网络副作用）——用
    //   readSystemConfig 抛异常模拟，验证这类异常仍走"确定失败"分支：回写 failed + 500 + 可立即重试成功。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      readSystemConfigShouldThrow = new Error('模拟本地异常（dry-run 判断阶段，未触达外呼）');
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(readSystemConfigShouldThrow, null, "[13b'] 前置：打桩已消费");
      assert.strictEqual(r.status, 500, `[13b'] 本地异常（未触达外呼）应转 500，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const row = await issueRow(id);
      assert.strictEqual(row.liaison_test_notify_status, 'failed', "[13b'] ⭐ 确定失败：立即回写 failed（非悬挂 sending，因为压根没发过消息）");
      assert.ok(row.liaison_test_notify_error && row.liaison_test_notify_error.includes('模拟本地异常'), `[13b'] error 列记异常消息，实际="${row.liaison_test_notify_error}"`);
      assert.strictEqual(row.liaison_test_attempt_token, null, "[13b'] attempt_token 已清空（正常回写路径）");
      const r2 = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r2.status, 200, `[13b'] 立即重试应成功，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
      assert.strictEqual(r2.body.liaison_test_notify_status, 'sent', "[13b'] 重试后 sent");
      ok("[13b'] H-1 分类·确定失败对照：触达外呼之前的本地异常（无网络副作用）→ 500 + 立即回写 failed + 无需等 stale 窗口即可立即重试成功（与 [13b] 的结果未知分支行为对照）");
    }

    // [13b''] codex 278 号审 M-4：超时时长可注入化——用 _internals.setNotifyLiaisonTestTimeoutMsForTest
    //   把超时收到 50ms，外呼打桩延迟 200ms（真实触发 withTimeout 自身的 NotifyTimeoutError，非
    //   sendShouldThrow 那种"函数本身裸抛"），断言：专用类型命中 + 不回写 failed + DB 保持 sending +
    //   504 LIAISON_TEST_NOTIFY_TIMEOUT——高风险修复补齐自动化覆盖（此前只能靠人工审读代码确认这条
    //   分支存在）。finally 复位回生产默认 8 分钟，防污染后续用例（尤其 [13d] 的 300ms 外呼延迟测试）。
    {
      I.setNotifyLiaisonTestTimeoutMsForTest(50);
      try {
        const { id, cycle } = await mkFreshLiaisonTestIssue();
        sendDelayMs = 200;   // > 50ms 超时阈值，确保真正触发 withTimeout 本身的竞速超时
        const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
        sendDelayMs = 0;
        assert.strictEqual(r.status, 504, `[13b''] 真实超时命中应 504，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'LIAISON_TEST_NOTIFY_TIMEOUT', "[13b''] 错误码 LIAISON_TEST_NOTIFY_TIMEOUT");
        assert.ok(r.body.stale_at, `[13b''] 响应带 stale_at，实际=${r.body.stale_at}`);
        const row = await issueRow(id);
        assert.strictEqual(row.liaison_test_notify_status, 'sending', "[13b''] ⭐ 不回写 failed，DB 保持 sending（真实超时分支，非模拟裸抛）");
        assert.ok(row.liaison_test_attempt_token, "[13b''] attempt_token 未清空（悬挂态）");
        ok("[13b''] ⭐ M-4 超时可注入化：50ms 超时阈值+200ms 外呼延迟真实触发 withTimeout 自身的 NotifyTimeoutError → 504 LIAISON_TEST_NOTIFY_TIMEOUT + 不回写 failed + DB 保持 sending（高风险分支补齐自动化断言，不再仅靠人工审读代码）");
      } finally {
        I.setNotifyLiaisonTestTimeoutMsForTest(8 * 60 * 1000);   // 复位生产默认，防污染后续用例
        sendDelayMs = 0;
      }
    }

    // [13c] M-1 NULL started_at 异常数据恢复：sending 但 attempt_started_at 为 NULL（迁移遗留/手工改库/
    //   历史脏数据）→ 新请求应可正常预占成功（不因 NULL 比较恒假而永久卡死）。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='ghost-token', liaison_test_attempt_started_at=NULL WHERE id=?`, [id]);
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 200, `[13c] NULL started_at 应可被新请求正常抢占，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[13c] 抢占后正常发送成功');
      ok('[13c] M-1 NULL started_at 异常数据恢复分支：sending 态 attempt_started_at=NULL（脏数据/迁移遗留）→ 新请求正常预占成功，不永久卡死');
    }

    // [13d] 并发双发反证（外呼耗时窗口内二次点击）：制造外呼延迟，在第一次外呼尚未完成时发起第二次
    //   请求——第二次应被 CAS 挡在预占层（409 sending_in_progress），全程只有 1 次真实外呼被调用
    //   （非"等外呼都完成才互斥"，互斥点在预占 CAS，与外呼耗时无关）。
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      sendDelayMs = 300;
      sendCallCount = 0;
      const [r1, r2] = await Promise.all([
        call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle }),
        (async () => { await new Promise(res => setTimeout(res, 50)); return call('POST', `/api/sys-issues/${id}/notify-liaison-test`, devTok(5), { expected_cycle: cycle }); })(),
      ]);
      sendDelayMs = 0;
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepStrictEqual(statuses, [200, 409], `[13d] 一发一 409，实际 ${JSON.stringify([r1.status, r2.status])} ${JSON.stringify([r1.body, r2.body])}`);
      const loser = r1.status === 409 ? r1 : r2;
      assert.strictEqual(loser.body.code, 'LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS', '[13d] 落败请求错误码 SENDING_IN_PROGRESS');
      assert.strictEqual(sendCallCount, 1, '[13d] ⭐⭐ 外呼耗时窗口内并发第二次不触发第二次真实外呼（互斥点在预占 CAS，非等外呼完成才挡，打桩计数验证）');
      ok('[13d] 并发双发反证：外呼耗时 300ms 窗口内 50ms 后发起第二次请求 → 一发（200）一 409（sending_in_progress），全程仅 1 次真实外呼调用');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [14] codex 277 号审 M-1：claim 自愈守卫加 sending 锁——sending 期间收件人不可被 claim 改动
  // ══════════════════════════════════════════════════════════════════════
  {
    const { id, cycle } = await mkFreshLiaisonTestIssue();
    // 模拟：另一并发请求已持有预占权（sending，未超窗），同时把收件人改成失效值（999999，不在 active
    // 池内），制造"本请求走到 claim 自愈分支"的前提。
    await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token='concurrent-token', liaison_test_attempt_started_at=datetime('now','localtime'), liaison_test_recipient_id=999999 WHERE id=?`, [id]);
    const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
    const row = await get('SELECT liaison_test_recipient_id, liaison_test_notify_status, liaison_test_attempt_token FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.liaison_test_recipient_id, 999999, '[14] ⭐ sending 期间收件人锁定：claim 自愈的守卫式 UPDATE 未生效（changes=0），收件人仍是 sending 前的旧值，未被改判为新候选(13)');
    assert.strictEqual(row.liaison_test_notify_status, 'sending', '[14] 通知状态仍是并发请求持有的 sending（本请求未触碰）');
    assert.strictEqual(row.liaison_test_attempt_token, 'concurrent-token', '[14] attempt_token 仍是并发请求的旧值（未被覆盖）');
    // claim 未成功 + 现值 999999 不在 active 池 → 走既有"claim 失败重读判定"分支 → 409 RECIPIENT_CHANGED
    assert.strictEqual(r.status, 409, `[14] 实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LIAISON_TEST_RECIPIENT_CHANGED', '[14] 错误码 LIAISON_TEST_RECIPIENT_CHANGED（claim 失败后重读仍判定收件人不可用）');
    ok('[14] ⭐ M-1 sending 锁收件人：预占进行中（sending 未超窗）时另一请求触发 claim 自愈 → 守卫式 UPDATE 因 liaison_test_notify_status=\'sending\' 被拒（changes=0），收件人/通知态/token 三列全部原样未变，证并发期间收件人确实锁定');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [15] codex 277 号审 H-2：最终回写保护——单次异常重试成功 / 连续两次异常降级 200+警示
  // ══════════════════════════════════════════════════════════════════════
  {
    // [15a] 首次回写打桩抛异常，重试成功 → 最终应为 sent（用户视角与"一次成功"无区别）
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      writebackThrowCount = 1;
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(writebackThrowCount, 0, '[15a] 前置：打桩已被消费（确认真的走到回写这步且抛了一次）');
      assert.strictEqual(r.status, 200, `[15a] 重试成功后应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.liaison_test_notify_status, 'sent', '[15a] ⭐ 首次回写异常+重试成功 → 最终 sent（对用户透明，未暴露中间的一次失败）');
      assert.ok(!r.body.writeback_failed, '[15a] 无 writeback_failed 标记（重试已成功，不属于降级场景）');
      const row = await get('SELECT liaison_test_notify_status FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(row.liaison_test_notify_status, 'sent', '[15a] 落库确实是 sent');
      ok('[15a] H-2 单次异常重试：首次回写抛异常 → 立即重试一次成功 → 响应 200 + 落库 sent（用户视角与"一次成功"无区别）');
    }
    // [15b] 连续两次回写打桩抛异常 → 降级为 200 + writeback_failed:true 警示（绝不能诱导重发）
    {
      const { id, cycle } = await mkFreshLiaisonTestIssue();
      writebackThrowCount = 2;
      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(writebackThrowCount, 0, '[15b] 前置：打桩两次均被消费（确认确实重试了一次而非只试了一次就放弃）');
      assert.strictEqual(r.status, 200, `[15b] ⭐ 连续两次回写异常仍应 200（绝不能让用户看到失败态引导重发），实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.writeback_failed, true, '[15b] ⭐ writeback_failed:true 警示字段');
      assert.strictEqual(r.body.sent_externally, true, '[15b] sent_externally:true（外部发送这一步已成功，只是回写失败）');
      const row = await get('SELECT liaison_test_notify_status FROM sys_issues WHERE id=?', [id]);
      assert.strictEqual(row.liaison_test_notify_status, 'sending', '[15b] ⭐ 库内该行残留 sending（两次回写均失败无法落地最终状态——结构性限制，index.js 注释已披露，需 stale 窗口或人工恢复）');
      ok('[15b] H-2 连续两次回写异常降级：响应 200 + writeback_failed:true + sent_externally:true（绝不诱导重发），库内行残留 sending 待 stale 窗口/人工恢复（结构性限制已披露）');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [16] codex 277/278 号审 M-2/M-5：认证层同构替身测试
  // ══════════════════════════════════════════════════════════════════════
  // ⚠️ 措辞说明（codex 278 号审 M-5 收口）：本节测的是一个**替身/双胞胎**（本文件内本地手写的
  //   authenticateTokenReal，结构上照抄 server.js authenticateToken），不是"真实认证层"本身——
  //   与真实中间件的"同构"程度完全依赖下方三条源码正则断言的匹配精度，属于**弱证据**：正则可能在
  //   server.js 逻辑结构不变但措辞变化时假红（过度敏感），也可能在逻辑结构真的变了但换了种写法时
  //   假绿（不够敏感）。本节结论边界=**"如果 server.js 与这三条正则描述的结构一致，那么一个逻辑同构
  //   的中间件会挡住停用账号"**，不能读成"已验证生产环境真的会挡住停用账号"。
  //   ⭐ 挂账：真正的**真实服务入口集成**（直接对 server.js 实际监听的 HTTP 端口发起请求，覆盖真实
  //   `authenticateToken`+真实 db 连接+真实全部中间件链）本节完全没有覆盖，仍是待办——受限于 server.js
  //   顶层大量启动副作用（真实数据库连接/真实端口监听/其余全部路由注册等），需要专门的集成测试环境
  //   （如临时端口+隔离 db 文件+专门的 server.js 可测试化改造）才能安全做到，本轮不做，留给后续。
  {
    // 源码断言：确认 server.js 的 authenticateToken 仍是"验签后实时查库 status，非 active 一律 403
    // 账号已被禁用"这个结构——若未来该逻辑被改写，这条断言先变红，提醒同步更新下面的复刻中间件，
    // 防止两者悄悄失焦（这是本节"替身"方案精度上限内，能做到的最好的一层保护）。
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/SELECT\s+status\s+FROM\s+users\s+WHERE\s+id\s*=\s*\?/i.test(serverSrc),
      '[16 前置·源码断言] server.js authenticateToken 仍含实时查库 SELECT status（若被改写需同步更新本文件复刻中间件）');
    assert.ok(/status\s*!==\s*'active'/.test(serverSrc), "[16 前置·源码断言] server.js authenticateToken 仍判 status !== 'active'");
    assert.ok(serverSrc.includes('账号已被禁用'), '[16 前置·源码断言] server.js authenticateToken 仍返回「账号已被禁用」文案');
    ok('[16 前置] 源码断言：server.js authenticateToken 结构未变（验签+实时查库 status+非 active 403「账号已被禁用」）——下方替身中间件与其"同构"的前提成立（同构程度受限于正则匹配精度，见上方措辞说明）');

    // 最小可行复刻（替身）：本文件内存库/JWT_SECRET 版的同构中间件——不 require 整个 server.js（它会
    // 连带执行真实数据库连接/端口监听/一整套模块顶层副作用，风险远大于收益，故按 codex 277 号审 M-2
    // 的兜底条款走"复刻查库逻辑 + 源码断言同构"路线，而非直接引入；真实服务入口集成见上方挂账）。
    function authenticateTokenReal(req, res, next) {
      const h = req.headers.authorization || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!tok) return res.status(401).json({ error: '未登录' });
      let user;
      try { user = jwt.verify(tok, SECRET); } catch (e) { return res.status(403).json({ error: 'token 无效' }); }
      db.get('SELECT status FROM users WHERE id = ?', [user.id], (dbErr, row) => {
        if (dbErr) return res.status(500).json({ error: dbErr.message });
        if (!row) return res.status(403).json({ error: '账号不存在' });
        if (row.status !== 'active') return res.status(403).json({ error: '账号已被禁用' });
        req.user = user;
        next();
      });
    }
    const realAuthApp = express();
    realAuthApp.use(express.json());
    realAuthApp.use('/api', authenticateTokenReal, mod.router);
    let realAuthServer, realAuthPort;
    await new Promise((resolve) => { realAuthServer = realAuthApp.listen(0, () => { realAuthPort = realAuthServer.address().port; resolve(); }); });
    function callReal(method, p, tok, body) {
      return new Promise((resolve, reject) => {
        const data = body !== undefined ? JSON.stringify(body) : null;
        const req2 = http.request({ host: '127.0.0.1', port: realAuthPort, path: p, method, headers: {
          'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
        req2.on('error', reject); if (data) req2.write(data); req2.end();
      });
    }

    try {
      const { id: id1, cycle: cycle1 } = await mkFreshLiaisonTestIssue();
      const r1 = await callReal('POST', `/api/sys-issues/${id1}/notify-liaison-test`, adminTok, { expected_cycle: cycle1 });
      assert.strictEqual(r1.status, 200, `[16a] active 账号走认证层替身应 200，实际 ${r1.status} ${JSON.stringify(r1.body)}`);
      ok('[16a] 认证层同构替身：active 账号正常放行 200（替身中间件对合法请求零干扰）');

      const { id: id2, cycle: cycle2 } = await mkFreshLiaisonTestIssue();
      await run(`UPDATE users SET status='inactive' WHERE id=1`);
      try {
        const tlBefore = (await all('SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?', [id2]))[0].c;
        const sendCountBefore = sendCallCount;
        const r2 = await callReal('POST', `/api/sys-issues/${id2}/notify-liaison-test`, adminTok, { expected_cycle: cycle2 });
        assert.strictEqual(r2.status, 403, `[16b] 停用账号应 403，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
        assert.strictEqual(r2.body.error, '账号已被禁用', '[16b] 错误文案「账号已被禁用」');
        const tlAfter = (await all('SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?', [id2]))[0].c;
        assert.strictEqual(tlAfter, tlBefore, '[16b] ⭐ 业务零执行：无新增 timeline 行（认证层已拦，未进入业务逻辑）');
        const row2 = await get('SELECT liaison_test_notify_status FROM sys_issues WHERE id=?', [id2]);
        assert.strictEqual(row2.liaison_test_notify_status, 'not_sent', '[16b] 业务零执行：通知列组未被改动（仍是 ⑦ 进入时的初始态）');
        assert.strictEqual(sendCallCount, sendCountBefore, '[16b] 业务零执行：未触发任何外呼（打桩计数未增加）');
      } finally {
        await run(`UPDATE users SET status='active' WHERE id=1`);
      }
      ok('[16b] ⭐ 认证层同构替身：停用账号（users.status=inactive）→ 403「账号已被禁用」，业务零执行（无新 timeline 行/通知列组未动/零外呼）——证的是"一个与 server.js 结构同构的替身中间件会这样表现"，生产 authenticateToken 是否逐字如此靠上方源码正则断言担保（弱证据，非运行时直接验证，见本节头部措辞说明）；测后已恢复 1=active');
    } finally {
      realAuthServer.close();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // [E-race] [S12 双路审查 codex 287 号 M-1 收口] 契约测试——sending 中途 pass/return 不被阻塞 +
  //   晚到的 writeback 仍精确落回（登记的既有语义，见 index.js writebackLiaisonTestNotify 下方
  //   注释与两处 case 头部指针）。不经真实 sendIssueDingtalkRaw（网络/钉钉不可控），预占态与回写态
  //   均用与生产逐字同构的 UPDATE 文本直接 SQL 模拟——测的是 pass/return 的 case 分支与
  //   writebackLiaisonTestNotify 的 CAS WHERE 是否真的"各管各的、互不依赖对方状态"，非测发送链路本身
  //   （发送链路已有 [11][13][14][15] 覆盖）。
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① pass 分支：sending 中途通过 + 晚到的成功回写仍落地
    const { id: idA } = await mkFreshLiaisonTestIssue({ primaryDevId: 5, primaryDevName: '开发甲' });
    const tokenA = 'e-race-token-A';
    await run(
      `UPDATE sys_issues SET liaison_test_notify_status = 'sending',
              liaison_test_attempt_token = ?, liaison_test_attempt_started_at = datetime('now','localtime')
        WHERE id = ?`,
      [tokenA, idA]
    );
    {
      const inv = await assertNotifyCrossColumnInvariant();
      assert.strictEqual(inv.illegalSending.length + inv.illegalNonSending.length + inv.illegalCycle.length, 0,
        '[E-race] 前置：手工构造的 sending 态本身合法（token∧started_at 均非空），不应命中任何一类违例');
    }
    const passR = await call('POST', `/api/sys-issues/${idA}/liaison-test-pass`, liaisonTok, { test_note: 'E-race 竞态测试' });
    assert.strictEqual(passR.status, 200, `[E-race] ① sending 中途 pass 应 200（不因通知在飞被阻塞），实际 ${passR.status} ${JSON.stringify(passR.body)}`);
    assert.strictEqual(passR.body.status, '待验证', '[E-race] ① pass 正常推进到待验证，未被 sending 挡住（makeTransitionEndpoint 响应体字段名=status，非 main_status）');
    const afterPassRow = await get('SELECT status, liaison_test_notify_status AS ns, liaison_test_attempt_token AS tok FROM sys_issues WHERE id=?', [idA]);
    assert.strictEqual(afterPassRow.status, '待验证', '[E-race] ① 落库主状态=待验证');
    assert.strictEqual(afterPassRow.ns, 'sending', '[E-race] ① ⭐ pass 未触碰通知列——sending 态原样保留（liaison_test_pass case 从不读/写 liaison_test_notify_status，主状态与通知态各走各的）');
    assert.strictEqual(afterPassRow.tok, tokenA, '[E-race] ① attempt_token 保持不变（未被 pass 清空或覆盖）');
    // 晚到的成功回写——与 writebackLiaisonTestNotify 逐字同构的 UPDATE（index.js :11256-11262），
    // CAS WHERE 只认 sending+token，不查 status，此时主状态早已是「待验证」。
    const wbOk = await run(
      `UPDATE sys_issues SET liaison_test_notify_status = 'sent', liaison_test_attempt_token = NULL, liaison_test_attempt_started_at = NULL,
              liaison_test_notified_at = datetime('now','localtime'), liaison_test_notify_message_key = ?, liaison_test_notify_error = NULL,
              liaison_test_read_at = NULL, liaison_test_notify_sent_by = ?
        WHERE id = ? AND liaison_test_notify_status = 'sending' AND liaison_test_attempt_token = ?`,
      ['e-race-msgkey', 13, idA, tokenA]
    );
    assert.strictEqual(wbOk.changes, 1, '[E-race] ① ⭐ 晚到的成功回写仍精确落地（changes=1）——token 是唯一凭证，主状态已推进不影响 CAS 命中');
    const afterWbRow = await get('SELECT status, liaison_test_notify_status AS ns, liaison_test_attempt_token AS tok, liaison_test_notified_at AS nat FROM sys_issues WHERE id=?', [idA]);
    assert.strictEqual(afterWbRow.status, '待验证', '[E-race] ① ⭐ 回写后主状态仍是待验证（回写不触碰主状态列，dormant sent 数据与 advanced 主状态共存不冲突）');
    assert.strictEqual(afterWbRow.ns, 'sent', '[E-race] ① 回写后通知态=sent（终态正确落地）');
    assert.ok(afterWbRow.nat, '[E-race] ① notified_at 已回填');
    assert.strictEqual(afterWbRow.tok, null, '[E-race] ① attempt_token 已清空（回到合法非-sending 组合）');

    // ② return 分支：sending 中途打回 + 晚到的失败回写仍落地（覆盖 writebackLiaisonTestNotify 的 ok=false 分支）
    const { id: idB } = await mkFreshLiaisonTestIssue({ primaryDevId: 7, primaryDevName: '开发丙' });
    const tokenB = 'e-race-token-B';
    await run(
      `UPDATE sys_issues SET liaison_test_notify_status = 'sending',
              liaison_test_attempt_token = ?, liaison_test_attempt_started_at = datetime('now','localtime')
        WHERE id = ?`,
      [tokenB, idB]
    );
    const returnR = await call('POST', `/api/sys-issues/${idB}/liaison-test-return`, liaisonTok, { reason: '[E-race] sending 中途打回' });
    assert.strictEqual(returnR.status, 200, `[E-race] ② sending 中途 return 应 200（不因通知在飞被阻塞），实际 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    assert.strictEqual(returnR.body.status, '开发中', '[E-race] ② return 正常打回开发中，未被 sending 挡住（响应体字段名=status）');
    const afterReturnRow = await get('SELECT status, liaison_test_notify_status AS ns, liaison_test_attempt_token AS tok FROM sys_issues WHERE id=?', [idB]);
    assert.strictEqual(afterReturnRow.status, '开发中', '[E-race] ② 落库主状态=开发中');
    assert.strictEqual(afterReturnRow.ns, 'sending', '[E-race] ② ⭐ return 同样未触碰通知列——sending 态原样保留（liaison_test_return case 从不读/写该列）');
    // 晚到的失败回写（ok=false 分支：notified_at 不回填、error 非空）
    const wbFail = await run(
      `UPDATE sys_issues SET liaison_test_notify_status = 'failed', liaison_test_attempt_token = NULL, liaison_test_attempt_started_at = NULL,
              liaison_test_notified_at = NULL, liaison_test_notify_message_key = NULL, liaison_test_notify_error = ?,
              liaison_test_read_at = NULL, liaison_test_notify_sent_by = ?
        WHERE id = ? AND liaison_test_notify_status = 'sending' AND liaison_test_attempt_token = ?`,
      ['other', 13, idB, tokenB]
    );
    assert.strictEqual(wbFail.changes, 1, '[E-race] ② ⭐ 晚到的失败回写同样精确落地（changes=1）——ok=false 分支同款 token-only CAS，与主状态无关');
    const afterWbFailRow = await get('SELECT status, liaison_test_notify_status AS ns, liaison_test_notify_error AS err FROM sys_issues WHERE id=?', [idB]);
    assert.strictEqual(afterWbFailRow.status, '开发中', '[E-race] ② ⭐ 回写后主状态仍是开发中（回写不触碰主状态列）');
    assert.strictEqual(afterWbFailRow.ns, 'failed', '[E-race] ② 回写后通知态=failed（终态正确落地，非卡死在 sending）');
    assert.strictEqual(afterWbFailRow.err, 'other', '[E-race] ② notify_error 已回填');

    {
      const inv = await assertNotifyCrossColumnInvariant();
      assert.strictEqual(inv.illegalSending.length + inv.illegalNonSending.length + inv.illegalCycle.length, 0,
        '[E-race] 收尾：两条用例均已落回合法终态（sent/failed 且 token/started_at 皆清空），不遗留非法组合给 [17] 全表扫描');
    }
    ok('[E-race] [S12 双路审查 codex 287 号 M-1 收口] 已接受的 sending 竞态契约测试——① pass 分支：sending 中途 pass 200 不阻塞 + 主状态与通知态互不触碰 + 晚到成功回写仍精确落地（dormant sent 数据与 advanced 待验证共存）；② return 分支：sending 中途 return 200 不阻塞 + 晚到失败回写（ok=false 分支）同样精确落地（dormant failed 数据与 advanced 开发中共存）——两条用例收尾均落回合法终态，不给后续全表扫描留脏数据');
  }

  // ══════════════════════════════════════════════════════════════════════
  // [17] 284 号 B3-②：通知跨列不变量——全表扫描（部署硬闸门范式，同 verify-sys-intake-liaison.js
  //   收尾"全表扫描四项"）+ 发送端遇非法组合的真实反应如实刻画
  // ══════════════════════════════════════════════════════════════════════
  {
    // 不变量（方案 v1.1 §4，255-G 七审 M-4）：sending ⇔ attempt_token 非空 ∧ attempt_started_at 非空；
    // notify_cycle_no ≤ liaison_test_cycle_no。跑在 [17b] 之前的全部用例之后——各用例内部构造的
    // "脏组合"均是瞬时中间态，触发被测端点后要么被覆写为合法 sending（新 token+started_at 同一条
    // UPDATE 写入）要么落为终态 sent/failed（token/started_at 一并清空），不应有任何一条遗留到此处
    // 仍是非法组合。⚠️ [285 号合并轮 HIGH 收口] 这不是"全文件最终收尾态"——下方 [17b] 会故意构造一条
    // 新的非法组合用于探针有效性正面证明，验证完会显式清理；真正的"全文件跑完后的终态"扫描挪到文件
    // 最末（server.close() 之前），避免 [17b] 自己的构造+未清理动作污染这里的"应为 0"断言（旧版
    // 已踩：[17b] 排在 [17] 之后却制造出一条从未清理的非法行，套件绿色退出但库被留在非法状态）。
    const before = await assertNotifyCrossColumnInvariant();
    assert.strictEqual(before.illegalSending.length, 0, `[17] 全表扫描：sending 但 token/started_at 有一列为空的行应为 0，实际 ${before.illegalSending.length}：${JSON.stringify(before.illegalSending)}`);
    assert.strictEqual(before.illegalNonSending.length, 0, `[17] 全表扫描：非 sending 但 token/started_at 有一列非空的行应为 0，实际 ${before.illegalNonSending.length}：${JSON.stringify(before.illegalNonSending)}`);
    assert.strictEqual(before.illegalCycle.length, 0, `[17] 全表扫描：notify_cycle_no > 主周期 cycle_no 的行应为 0，实际 ${before.illegalCycle.length}：${JSON.stringify(before.illegalCycle)}`);
    ok('[17] 284 号 B3-②：通知跨列不变量全表扫描（部署硬闸门范式）——sending⇔token∧started_at 双向零违例 + notify_cycle_no≤主周期零违例（[17b] 之前的收尾态；[17b] 自身构造的非法组合另在文件最末终态扫描覆盖，见该处）');
  }
  {
    // [17b] 284 号 B3-② 如实刻画：token 缺失但 started_at 存在的非法组合——CAS WHERE（:11132 一带）
    // 只显式判断 `liaison_test_attempt_started_at IS NULL` 这一种异常（并把它当"立即可抢占"处理，
    // 见 [13c]），未覆盖"token 单独缺失、started_at 仍非空且未超窗"这一种。如实记录当前真实反应，
    // 不代入未经验证的期望值：这种组合与"合法未超窗 sending"在 CAS WHERE 层面完全同构（WHERE 只看
    // started_at 是否为空/超窗，不看 token 本身），命中的是与合法在途请求相同的 409
    // SENDING_IN_PROGRESS，响应体没有任何字段能区分"正常排队"与"数据异常"——255-G 七审"发送端遇
    // 非法组合显式报错、不静默 409"这条诉求，NULL started_at 那一种已被 [13c] 妥善处理为可恢复，
    // 但 token-only 缺失这一种目前未被识别为独立分支，仍是静默 409。本条按 284 号裁定"如实标记
    // 已知缺口，不虚报已闭合"处理，不在本批修复实现（详见交付报告 B3 核销表）。
    // [285 号合并轮 HIGH 收口] 四步修复：① 构造前用 helper 证明当前干净 ② 构造非法组合后用 helper
    // 正面证明"探针真的能检出"（不只是"没抓到问题"就当探针没问题——恰好检出这一条才是有效性证据）
    // ③ 跑 409 断言（不变） ④ 断言完显式把该行三列恢复回合法终态（not_sent+token/started_at 皆
    // NULL，与 mkFreshLiaisonTestIssue 造出时的原始 not_sent 起点一致），不把非法组合遗留给后续代码
    // 或文件收尾扫描。
    const { id, cycle } = await mkFreshLiaisonTestIssue();
    // [286 号 2L-1] 前后置断言覆盖 helper 全部三类（不只 sending 类）——让四步证据链与 helper 的完整
    // 语义一致，「构造前全干净/清理后全干净」名副其实。
    const beforeDirty = await assertNotifyCrossColumnInvariant();
    for (const k of ['illegalSending', 'illegalNonSending', 'illegalCycle']) {
      assert.strictEqual(beforeDirty[k].length, 0, `[17b] 前置：构造非法组合之前，全表 ${k} 应为 0，实际 ${beforeDirty[k].length}：${JSON.stringify(beforeDirty[k])}`);
    }
    // [286 号 2L-2] 构造→检出证明→409 断言整段包 try/finally——中间任一断言/HTTP 调用失败时，finally
    // 仍把本用例构造的非法组合恢复为合法终态，不把脏行遗留给同库后续重跑/诊断（失败路径卫生）。
    try {
      await run(`UPDATE sys_issues SET liaison_test_notify_status='sending', liaison_test_attempt_token=NULL, liaison_test_attempt_started_at=datetime('now','localtime') WHERE id=?`, [id]);
      const afterDirty = await assertNotifyCrossColumnInvariant();
      assert.strictEqual(afterDirty.illegalSending.length, 1, `[17b] ⭐ 探针有效性正面证明：构造 token 缺失的非法组合后，helper 应恰好检出 1 条，实际 ${afterDirty.illegalSending.length}：${JSON.stringify(afterDirty.illegalSending)}`);
      assert.strictEqual(afterDirty.illegalSending[0].id, id, `[17b] 探针检出的行应正是本用例构造的那一条（#${id}），实际 #${afterDirty.illegalSending[0] && afterDirty.illegalSending[0].id}`);

      const r = await call('POST', `/api/sys-issues/${id}/notify-liaison-test`, adminTok, { expected_cycle: cycle });
      assert.strictEqual(r.status, 409, `[17b] token 缺失+started_at 未超窗 → 与合法在途 sending 同构，命中 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS', '[17b] ⚠️ 已知缺口：与合法在途请求撞同一错误码，响应无法区分"正常排队"与"数据异常"');
    } finally {
      // 显式恢复：成功/失败路径都把非法组合清回合法终态，不留残局给后续代码/文件收尾扫描。
      await run(`UPDATE sys_issues SET liaison_test_notify_status='not_sent', liaison_test_attempt_token=NULL, liaison_test_attempt_started_at=NULL WHERE id=?`, [id]);
    }
    const afterCleanup = await assertNotifyCrossColumnInvariant();
    for (const k of ['illegalSending', 'illegalNonSending', 'illegalCycle']) {
      assert.strictEqual(afterCleanup[k].length, 0, `[17b] 清理后：全表 ${k} 应重新为 0，实际 ${afterCleanup[k].length}：${JSON.stringify(afterCleanup[k])}`);
    }
    ok('[17b] 284 号 B3-②如实记录（已知缺口·未修）+ 285 号合并轮收口：token 缺失但 started_at 存在这一种非法组合，当前与合法未超窗 sending 撞同一 409 码，非独立可观测信号（本批只诚实刻画现状，不虚报已闭合）——探针检出有效性正面证明（构造前 0 条→构造后恰 1 条命中本行）+ 断言完显式清理归零，不遗留给后续/收尾扫描');
  }

  // [285 号合并轮 HIGH 收口] 文件真正的最终收尾态扫描——覆盖含 [17b] 在内的**全部**用例（[17] 只
  //   覆盖到它自己所在位置之前；[17b] 自己构造+清理了一条，此处是"[17b] 的清理是否真的生效"的
  //   独立复核，不能只信 [17b] 内部那次 afterCleanup 断言）。放在 server.close() 之前，是全文件
  //   跑完后能拿到的最后一次真相。
  {
    const final = await assertNotifyCrossColumnInvariant();
    assert.strictEqual(final.illegalSending.length, 0, `[终态] 全文件跑完后：sending 但 token/started_at 有一列为空的行应为 0，实际 ${final.illegalSending.length}：${JSON.stringify(final.illegalSending)}`);
    assert.strictEqual(final.illegalNonSending.length, 0, `[终态] 全文件跑完后：非 sending 但 token/started_at 有一列非空的行应为 0，实际 ${final.illegalNonSending.length}：${JSON.stringify(final.illegalNonSending)}`);
    assert.strictEqual(final.illegalCycle.length, 0, `[终态] 全文件跑完后：notify_cycle_no > 主周期 cycle_no 的行应为 0，实际 ${final.illegalCycle.length}：${JSON.stringify(final.illegalCycle)}`);
    ok('[终态] 285 号合并轮收口：文件末尾（含 [17b] 在内全部用例跑完后）通知跨列不变量全表扫描零违例——[17b] 的显式清理经独立复核确认生效，套件绿色退出时库真实处于合法终态，非仅"内部断言说清理了"');
  }

  server.close();
  console.log(`\n✅ verify-sys-liaison-test 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-liaison-test 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
