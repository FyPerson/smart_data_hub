// scripts/verify-sys-fastlane-auth-expiry.js — 系统迭代·先行上线授权超时收回（次日 8:00 硬闸）验收
//   SSOT = docs/local/系统迭代/先行上线授权超时收回_方案_20260816_v1.2.md（418-421 四轮 codex 收敛，
//   can-start: yes）。规则：消费窗口 = [fast_release_auth_at, 授权日次日 08:00:00)，右开区间；过期后
//   单据零状态变化转常规验收；超时事实独立 action_code='fast_release_auth_expired' 留痕。
//   用法：node scripts/verify-sys-fastlane-auth-expiry.js
//
// 覆盖（方案 §7 验证清单逐条，每组含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1a/1b] 挂牌闸（触碰点①）：过期→不挂牌+超时留痕+六列清 ／ 未过期→正常挂牌（回归）
//   [2a/2b] exec-confirm（触碰点②）：过期→409+终止已持久化（先 commit 后 return，回滚吞留痕反证）／
//           未过期→确认成功（回归）
//   [3a/3b] 过期+done 行 accept 全链（418 修订）：done 闸不触发→内核清含 done+超时留痕恰一条（既有
//           终结 action_code 不出现）→验收流转继续 ／ 未过期+done 行→409（既有回归）
//   [4a-4e] revoke 五格决策表（418-421 四轮）：格1 deny 回归／格2 撤销流回归（reason 必填 400 回归）／
//           格3 done 闸回归／格4=200+集合全清含done+expired+revoked_at 未写+缺 reason 亦成功／
//           格5 成对=缺 reason→400；有 reason→写 revoked_at+summary 含"跨轮失效残迹清理"+存在跨轮
//           done 行时合法 reason 撤销亦成功（既有 NOT EXISTS 堵死出口的反证用例，420 收口）
//   [5a/5b] 重授权（触碰点⑦）：过期残留→先超时留痕后新授权+旧集合清+新窗口 ／ 窗口内重授→既有流回归
//   [6a/6b] 加人/移人（触碰点③④）：过期→409+终结持久化 ／ 未过期→既有回归
//   [7a/7b] 五事件调用层分叉双向钉死（return/void）+ 批次发布双保险同款分叉
//   [8a/8b] 边界对：now==deadline 失效／now==deadline-1s 有效；凌晨授权 deadline 仍=次日 08:00
//   [9] JS/SQL 对拍：同种子行绑同一 nowStr，判定逐行一致
//   [10a/10b] 列表投影：过期行 active_auth=0（SQL/JS 两层同判）／my_pending 不掺闸回归
//   [11] 幂等限代次：同代次两触碰→超时留痕恰一条+第二次 no-op；重授开新代次后再过期→第二条留痕合法
//   [12a/12b] ⑫探针：过期全 done 不报违例／窗口内全 done 报违例
//   [14] 详情投影 deadline/expired 两态正确
//   （[13] 占位符守卫权威在 verify-sys-list-badge-fields.js，本文件不重复）
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-fastlane-auth-expiry-secret';
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dutyTok = jwt.sign({ id: 20, username: 'zhiban', display_name: '值班员甲', role: 'user' }, SECRET);
const adminActor = { id: 1, name: '管理员' };

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, headers: {
        'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ verify-sys-fastlane-auth-expiry 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `AUTHEXP-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-fastlane-auth-expiry 夹具', intake_liaison_id: 13,
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
async function bugAtDaichuli() {
  const id = await mkIssue('bug');
  const r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-待处理] intake-accept 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
async function bugAtChulizhong() {
  const id = await bugAtDaichuli();
  const r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-处理中] assign 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
function futureEtaStr() {
  const d = new Date(Date.now() + 30 * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function estimateFuture(id, tok = devTok) {
  const r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: futureEtaStr() });
  assert.strictEqual(r.status, 200, `[estimate] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
}
async function authorize(id, note, tok = adminTok) {
  const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, tok, note ? { note } : {});
  assert.strictEqual(r.status, 200, `[授权] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
function submitBody(extra = {}) {
  return {
    mode: 'commits', self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因',
    commits: [{ component: 'backend', commit_ref: `svn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }],
    ...extra,
  };
}
async function submitCommits(id, tok = devTok) {
  return call('POST', `/api/sys-issues/${id}/submit`, tok, submitBody());
}
// [S1-fix MED-4] no_code 模式（零 commit）——用于构造 C9「免上线直翻」条件（accept 时 zero-commit 判据
//   命中，落态直接到「已上线」而非「待上线」）。⚠️ 显式覆盖 commits 为空数组——submitBody() 默认体带
//   非空 commits，"no_code 模式不应携带非空 commits" 会被后端 400 拒绝，不能只覆盖 mode。
async function submitNoCode(id, tok = devTok) {
  return call('POST', `/api/sys-issues/${id}/submit`, tok, submitBody({ mode: 'no_code', no_code_reason: 'verify 夹具：无提交交付（C9 直翻场景）', commits: [] }));
}
async function setDutyToday(userId, userName) {
  await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name)
             VALUES (date('now','localtime'), ?, ?, 1, '管理员')`, [userId, userName]);
}
async function clearDutyToday() {
  await run(`UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员'
             WHERE duty_date = date('now','localtime') AND removed_at IS NULL`);
}

const fastReleaseRow = (id) => get(
  `SELECT fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note,
          fast_release_revoked_at, fast_release_consumed_at
     FROM sys_issues WHERE id=?`, [id]);
const issueRow = (id) => get(
  `SELECT id, status, type, released_at, online_source,
          fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note,
          fast_release_revoked_at, fast_release_consumed_at, reopened_at
     FROM sys_issues WHERE id=?`, [id]);
const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const timelineCount = async (id) => Number((await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id])).c);
const tlRowsByCode = (id, code) => all(
  `SELECT event_type, summary, action_code, operator_id, operator_name FROM sys_issue_timeline
    WHERE issue_id=? AND action_code=? ORDER BY id`, [id, code]);
const fastExecRows = (issueId) => all(
  `SELECT id, issue_id, user_id, user_name, exec_status, removed_at FROM sys_fast_release_executors WHERE issue_id=? ORDER BY id`, [issueId]);
function assertAllNull(row, tag) {
  for (const k of Object.keys(row)) {
    assert.strictEqual(row[k], null, `${tag}：${k} 应为 NULL，实得 ${JSON.stringify(row[k])}`);
  }
}
async function nowStr() { return (await get(`SELECT datetime('now','localtime') AS n`)).n; }
// 种子过期态——不 mock 时钟：把 auth_at 直接改写到 2 天前，使 deadline=(2天前+1天)08:00=昨日08:00，
// 恒早于任意时刻运行本脚本时的真实 now（同方案 §7 头部"种子用昨日 auth_at 构造过期态"纪律，用 2 天前
// 而非昨日，规避"测试恰好在当天 00:00-08:00 运行"这个边界窗口——见下方注释详述）。
function pastAuthAtStr(daysAgo = 2) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`;
}
async function expireAuth(id) {
  await run(`UPDATE sys_issues SET fast_release_auth_at = ? WHERE id = ?`, [pastAuthAtStr(2), id]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),
    (13,'wangtaotao','示例对接人','user'),(20,'zhiban','值班员甲','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5 / dev2#6 / 受理人13 / 值班20）');

  // ══════════════════════════ [1a/1b] 挂牌闸（触碰点①） ══════════════════════════
  {
    // [1a] 过期：授权（处理中态）→ 当日值班 → 六列已在窗口内，先直接 SQL 把 auth_at 推回 2 天前
    //   （挂牌闸门判定发生在 submit 事务内，事务开始时才读 nowStr，故只需在 submit 之前把 auth_at
    //   改脏即可，不需要真的等待两天）→ submit 应仍 200 进「待验证」（主体不受影响），但不应挂牌
    //   （0 行执行人）+ 六列应被同事务清空 + 恰 1 条 fast_release_auth_expired 留痕。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[1a] 挂牌闸过期');
    await setDutyToday(20, '值班员甲');
    await expireAuth(id);
    const beforeTl = await timelineCount(id);
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[1a-submit] 应 200，实得 ${subR.status} ${JSON.stringify(subR.body)}`);
    assert.strictEqual(subR.body.main_status, '待验证', `[1a] submit 主体不受影响，应落待验证，实得 ${subR.body.main_status}`);
    assert.strictEqual((await fastExecRows(id)).length, 0, '[1a] 过期不应挂牌，执行人集合应恰 0 行');
    assertAllNull(await fastReleaseRow(id), '[1a-挂牌后] 六列应被同事务清空');
    const expTl = await tlRowsByCode(id, 'fast_release_auth_expired');
    assert.strictEqual(expTl.length, 1, `[1a] 应恰新增 1 条超时留痕，实得 ${expTl.length}`);
    assert.strictEqual(expTl[0].summary, '先行上线授权超时未启用（次日 8:00 前未完成），已收回，转常规验收流程', `[1a] 超时留痕文案精确，实得="${expTl[0].summary}"`);
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_staged')).length, 0, '[1a] 不应产生 fast_release_staged 挂牌留痕');
    assert.ok((await timelineCount(id)) > beforeTl, '[1a] timeline 应有新增（submit 自身事件行 + 超时留痕行，精确的超时留痕计数已在上面单独核实为恰 1 条）');
    await clearDutyToday();
    ok('[1a] 挂牌闸（触碰点①）过期：submit 主体正常进「待验证」，但不挂牌+六列同事务清空+恰 1 条超时留痕');

    // [1b] 未过期（回归）：正常授权+当日值班+submit → 应正常挂牌（1 行 pending 执行人），六列仍活跃。
    const idb = await bugAtChulizhong();
    await estimateFuture(idb);
    await authorize(idb, '[1b] 挂牌闸未过期回归');
    await setDutyToday(20, '值班员甲');
    const subRb = await submitCommits(idb);
    assert.strictEqual(subRb.status, 200, `[1b-submit] 应 200，实得 ${subRb.status}`);
    const execRowsB = await fastExecRows(idb);
    assert.strictEqual(execRowsB.length, 1, `[1b] 未过期应正常挂牌恰 1 行，实得 ${execRowsB.length}`);
    assert.strictEqual(execRowsB[0].exec_status, 'pending', '[1b] 挂牌行初始态应为 pending');
    const rowB = await fastReleaseRow(idb);
    assert.ok(rowB.fast_release_auth_at, '[1b] 六列应仍活跃（未被误清）');
    assert.strictEqual((await tlRowsByCode(idb, 'fast_release_auth_expired')).length, 0, '[1b] 不应产生超时留痕');
    await clearDutyToday();
    ok('[1b]（回归）挂牌闸未过期：正常挂牌 1 行 pending 执行人，六列不受影响，零超时留痕');
  }

  // ══════════════════════════ [2a/2b] exec-confirm（触碰点②） ══════════════════════════
  {
    // [2a] 过期：先在窗口内正常挂牌（授权→值班→submit），随后 SQL 推回 auth_at 模拟"挂牌后授权过期
    //   仍未被收集"这一合法瞬时/持续态（惰性收集设计的直接体现）→ 值班人确认应 409
    //   FAST_RELEASE_AUTH_EXPIRED，且**既有"先 rollback 再 return"控制流对本路径不适用**——终结副作用
    //   必须已经落库（六列已清/集合已软删/留痕已持久化），不能被 409 的表象误导成"整个请求被回滚"。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[2a] exec-confirm 过期');
    await setDutyToday(20, '值班员甲');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[2a-submit] 应 200，实得 ${subR.status}`);
    assert.strictEqual((await fastExecRows(id)).length, 1, '[2a-前置] 应恰 1 行 pending 执行人');
    await expireAuth(id);
    const beforeTl = await timelineCount(id);
    const rc = await call('POST', `/api/sys-issues/${id}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(rc.status, 409, `[2a] 过期确认应 409，实得 ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.code, 'FAST_RELEASE_AUTH_EXPIRED', `[2a] 确切码，实得 ${rc.body.code}`);
    // ★回滚吞留痕反证：若实现错误地在 409 分支之前 rollback（而非终结后先 commit 再 return），下面
    //   三条断言（六列清空/集合软删/留痕存在）会全部落空——本组直接查库核实终结副作用真的已持久化。
    assertAllNull(await fastReleaseRow(id), '[2a-409 后] ⭐⭐ 六列应已同事务清空（terminate 内核先 commit，非随 409 一起回滚）');
    const execAfter = await fastExecRows(id);
    assert.strictEqual(execAfter.length, 1, '[2a] 执行人行仍应存在（软删非物理删除）');
    assert.ok(execAfter[0].removed_at, '[2a] 执行人行应已软删（removed_at 非空）');
    const expTl = await tlRowsByCode(id, 'fast_release_auth_expired');
    assert.strictEqual(expTl.length, 1, `[2a] 超时留痕应已持久化恰 1 条，实得 ${expTl.length}`);
    assert.ok((await timelineCount(id)) > beforeTl, '[2a] timeline 应有新增（终结副作用已提交，非全部随 409 回滚）');
    await clearDutyToday();
    ok('[2a] exec-confirm（触碰点②）过期：409 FAST_RELEASE_AUTH_EXPIRED，且终结副作用（六列清/集合软删/留痕）已持久化——回滚吞留痕反证通过');

    // [2b] 未过期（回归）：正常确认应 200，末位单人翻牌。
    const idb = await bugAtChulizhong();
    await estimateFuture(idb);
    await authorize(idb, '[2b] exec-confirm 未过期回归');
    await setDutyToday(20, '值班员甲');
    const subRb = await submitCommits(idb);
    assert.strictEqual(subRb.status, 200, `[2b-submit] 应 200，实得 ${subRb.status}`);
    const rcb = await call('POST', `/api/sys-issues/${idb}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(rcb.status, 200, `[2b] 未过期确认应 200，实得 ${rcb.status} ${JSON.stringify(rcb.body)}`);
    assert.strictEqual(rcb.body.flipped, true, '[2b] 单人集合确认后应末位翻牌');
    assert.strictEqual(await statusOf(idb), '已上线', '[2b] 翻牌后主状态应为已上线');
    await clearDutyToday();
    ok('[2b]（回归）exec-confirm 未过期：200 + 末位翻牌成功');
  }

  // ══════════════════════════ [3a/3b]（418 修订）过期+done 行 accept 全链 ══════════════════════════
  {
    // [3a] 过期：构造"残留授权 + 存在 done 行 + 仍在待验证"（非全 done，故未自动翻牌）——挂牌→admin
    //   补第二名执行人→值班人确认 done（此时 1 done+1 pending，未翻牌）→ SQL 推回 auth_at 过期 →
    //   admin accept：done 闸不应触发（过期分叉在 done 闸判断之前），应改走内核终结（清含 done 的
    //   集合+超时留痕恰一条，且**既有终结 action_code 不应出现**）→ 验收流转应正常继续（落"待上线"）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[3a] 过期+done 行 accept');
    await setDutyToday(20, '值班员甲');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[3a-submit] 应 200，实得 ${subR.status}`);
    const addR = await call('POST', `/api/sys-issues/${id}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addR.status, 200, `[3a-加人] 应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    const dutyDoneR = await call('POST', `/api/sys-issues/${id}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(dutyDoneR.status, 200, `[3a-值班确认] 应 200，实得 ${dutyDoneR.status}`);
    assert.strictEqual(dutyDoneR.body.flipped, false, '[3a-前置] 仍有 1 名未确认，不应翻牌');
    const execBefore = await fastExecRows(id);
    assert.strictEqual(execBefore.length, 2, '[3a-前置] 应恰 2 行执行人');
    assert.strictEqual(execBefore.filter(r => r.exec_status === 'done').length, 1, '[3a-前置] 应恰 1 行 done');
    await expireAuth(id);
    const beforeTl = await timelineCount(id);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[3a-accept] done 闸不应触发（已过期），应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '待上线', `[3a] 验收流转应正常继续，落待上线，实得 ${acceptR.body.status}`);
    assertAllNull(await fastReleaseRow(id), '[3a-accept 后] 六列应被内核清空');
    const execAfter = await fastExecRows(id);
    assert.ok(execAfter.every(r => r.removed_at), '[3a] 集合应含 done 一并清空（软删）——内核唯一所有权覆盖 done 行');
    const expTl = await tlRowsByCode(id, 'fast_release_auth_expired');
    assert.strictEqual(expTl.length, 1, `[3a] 超时留痕应恰 1 条，实得 ${expTl.length}`);
    const legacyTl = await tlRowsByCode(id, 'fast_release_auth_terminated');
    assert.strictEqual(legacyTl.length, 0, '[3a] ⭐⭐ 既有终结 action_code（fast_release_auth_terminated）不应出现——调用层分叉唯一所有权，非双写');
    await clearDutyToday();
    ok('[3a]（418 修订）过期+done 行 accept 全链：done 闸不触发→内核清含 done+超时留痕恰一条（既有终结码不出现）→验收流转正常继续（落待上线）');

    // [3b] 未过期（既有回归）：同样构造 1 done+1 pending，但不使其过期，accept 应仍被既有 done 闸拦下
    //   409 FASTLANE_DEPLOY_IN_PROGRESS（本条证明过期分叉没有误伤既有窗口内闸门）。
    const idb = await bugAtChulizhong();
    await estimateFuture(idb);
    await authorize(idb, '[3b] 未过期+done 行 accept 回归');
    await setDutyToday(20, '值班员甲');
    const subRb = await submitCommits(idb);
    assert.strictEqual(subRb.status, 200, `[3b-submit] 应 200，实得 ${subRb.status}`);
    const addRb = await call('POST', `/api/sys-issues/${idb}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addRb.status, 200, `[3b-加人] 应 200，实得 ${addRb.status}`);
    const dutyDoneRb = await call('POST', `/api/sys-issues/${idb}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(dutyDoneRb.status, 200, `[3b-值班确认] 应 200，实得 ${dutyDoneRb.status}`);
    const acceptRb = await call('POST', `/api/sys-issues/${idb}/accept`, adminTok, {});
    assert.strictEqual(acceptRb.status, 409, `[3b] 未过期+存在 done 行应仍 409（既有闸门回归），实得 ${acceptRb.status} ${JSON.stringify(acceptRb.body)}`);
    assert.strictEqual(acceptRb.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[3b] 确切码，实得 ${acceptRb.body.code}`);
    await clearDutyToday();
    ok('[3b]（既有回归）未过期+done 行：accept 仍被既有 done 闸拦下 409 FASTLANE_DEPLOY_IN_PROGRESS，过期分叉未误伤窗口内既有闸门');
  }

  // ══════════════════════════ [3c]（S1-fix BLOCK-1 回归）过期+C9直翻+集合含done全链 ══════════════════════════
  {
    // 构造：授权→duty→submit(no_code，零 commit，满足 C9 免上线直翻资格)→挂牌 1 pending 执行人→
    //   加第二执行人→值班人确认 done（1 done+1 pending，不触发自动翻牌，status 仍待验证）→ SQL 推回
    //   auth_at 过期 → admin accept：zero-commit 判据命中，C9 直翻已上线（非常规验收路径落"待上线"）。
    //   本组是 S1-fix BLOCK-1 的直接回归用例：BLOCK-1 首版把内核调用延后到 [7] 后处理点，而 C9 直翻
    //   分支会在 [6] 主 UPDATE 里把 released_at/online_source 写非空——延后调用时内核重新 SELECT 到的
    //   行快照 released_at/online_source 已非空，isActiveFastReleaseAuth 六列判据里这两列条件恒假，
    //   残留判据误判为"非残留"，内核静默 no-op（六列残留+集合不清+零留痕，问题不会在断言里报错，只是
    //   什么都没发生——最隐蔽的一类回归）。修复后内核调用挪到 case 'accept' 内、[6] 主 UPDATE 之前同步
    //   执行，此刻 released_at/online_source 仍是 NULL，残留判据未被污染，能正确命中。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[3c] 过期+C9直翻+集合含done');
    await setDutyToday(20, '值班员甲');
    const noCodeR = await submitNoCode(id);
    assert.strictEqual(noCodeR.status, 200, `[3c-submit] 应 200，实得 ${noCodeR.status} ${JSON.stringify(noCodeR.body)}`);
    const addR = await call('POST', `/api/sys-issues/${id}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addR.status, 200, `[3c-加人] 应 200，实得 ${addR.status} ${JSON.stringify(addR.body)}`);
    const dutyDoneR = await call('POST', `/api/sys-issues/${id}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(dutyDoneR.status, 200, `[3c-值班确认] 应 200，实得 ${dutyDoneR.status}`);
    assert.strictEqual(dutyDoneR.body.flipped, false, '[3c-前置] 1 done+1 pending 不应翻牌');
    const execBefore = await fastExecRows(id);
    assert.strictEqual(execBefore.filter(r => !r.removed_at).length, 2, '[3c-前置] 应恰 2 行在册执行人');
    assert.strictEqual(execBefore.filter(r => r.exec_status === 'done').length, 1, '[3c-前置] 应恰 1 行 done');
    assert.strictEqual(await statusOf(id), '待验证', '[3c-前置] 主状态仍应为待验证（未翻牌）');
    await expireAuth(id);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[3c-accept] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '已上线', `[3c] 零 commit 应 C9 直翻已上线，实得 ${acceptR.body.status}`);
    assertAllNull(await fastReleaseRow(id), '[3c-accept 后] ⭐⭐ BLOCK-1 回归：六列应被同事务清空（内核在 [6] 之前调用，未被 released_at/online_source 污染残留判据）');
    const execAfter = await fastExecRows(id);
    assert.ok(execAfter.every(r => r.removed_at), '[3c] 集合含 done 应全软删');
    const expTl = await tlRowsByCode(id, 'fast_release_auth_expired');
    assert.strictEqual(expTl.length, 1, `[3c] 应恰 1 条超时留痕，实得 ${expTl.length}`);
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_terminated')).length, 0, '[3c] 既有终结码不应出现');
    await clearDutyToday();
    ok('[3c]（S1-fix BLOCK-1 回归）过期+C9直翻+集合含done全链：内核在 [6] 主 UPDATE 之前同步调用，六列清空+集合含done全软删+恰1条超时留痕+既有终结码不出现+主状态=已上线');
  }

  // ══════════════════════════ [3d/3e]（S1-fix3 M1a）issue_reject 过期/窗口内成对 ══════════════════════════
  {
    // [3d] 过期：待处理态授权→推过期→issue-reject——断言六列清空+恰 1 条 fast_release_auth_expired+
    //   无既有终结码+主状态=已拒绝。issue_reject 结构上唯一能带活跃授权的类型窗口是「待处理」（授权窗口
    //   本身含此态），无需先 assign/submit。
    const id3d = await bugAtDaichuli();
    await authorize(id3d, '[3d] issue_reject 过期');
    await expireAuth(id3d);
    const rejectR3d = await call('POST', `/api/sys-issues/${id3d}/issue-reject`, adminTok, { reason: '[3d] 过期验收拒绝' });
    assert.strictEqual(rejectR3d.status, 200, `[3d-reject] 应 200，实得 ${rejectR3d.status} ${JSON.stringify(rejectR3d.body)}`);
    assert.strictEqual(rejectR3d.body.status, '已拒绝', `[3d] 应落已拒绝，实得 ${rejectR3d.body.status}`);
    assertAllNull(await fastReleaseRow(id3d), '[3d-reject 后] 六列应被同事务清空');
    assert.strictEqual((await tlRowsByCode(id3d, 'fast_release_auth_expired')).length, 1, '[3d] 应恰 1 条超时留痕');
    assert.strictEqual((await tlRowsByCode(id3d, 'fast_release_auth_terminated')).length, 0, '[3d] 既有终结码不应出现');
    ok('[3d] issue_reject 过期路径：六列清空+恰 1 条 fast_release_auth_expired+既有终结码不出现+主状态=已拒绝');

    // [3e]（既有回归）窗口内对照：授权未过期→issue-reject——既有终结码出现，超时码不出现。
    const id3e = await bugAtDaichuli();
    await authorize(id3e, '[3e] issue_reject 窗口内');
    const rejectR3e = await call('POST', `/api/sys-issues/${id3e}/issue-reject`, adminTok, { reason: '[3e] 窗口内验收拒绝' });
    assert.strictEqual(rejectR3e.status, 200, `[3e-reject] 应 200，实得 ${rejectR3e.status}`);
    assertAllNull(await fastReleaseRow(id3e), '[3e-reject 后] 六列应被同事务清空');
    assert.strictEqual((await tlRowsByCode(id3e, 'fast_release_auth_terminated')).length, 1, '[3e] 应恰 1 条既有终结留痕');
    assert.strictEqual((await tlRowsByCode(id3e, 'fast_release_auth_expired')).length, 0, '[3e] 超时留痕不应出现');
    ok('[3e]（既有回归）issue_reject 窗口内：既有终结码出现，超时码不出现——与 [3d] 成对双向钉死');
  }

  // ══════════════════════════ [3f/3g]（S1-fix3 M1b）void 过期/窗口内成对 ══════════════════════════
  {
    // [3f] 过期：任意态（from='*'）授权→推过期→void——断言六列清空+恰 1 条 fast_release_auth_expired+
    //   无既有终结码+主状态=已作废。
    const id3f = await bugAtChulizhong();
    await authorize(id3f, '[3f] void 过期');
    await expireAuth(id3f);
    const voidR3f = await call('POST', `/api/sys-issues/${id3f}/void`, adminTok, { reason: '[3f] 过期作废' });
    assert.strictEqual(voidR3f.status, 200, `[3f-void] 应 200，实得 ${voidR3f.status} ${JSON.stringify(voidR3f.body)}`);
    assert.strictEqual(voidR3f.body.status, '已作废', `[3f] 应落已作废，实得 ${voidR3f.body.status}`);
    assertAllNull(await fastReleaseRow(id3f), '[3f-void 后] 六列应被同事务清空');
    assert.strictEqual((await tlRowsByCode(id3f, 'fast_release_auth_expired')).length, 1, '[3f] 应恰 1 条超时留痕');
    assert.strictEqual((await tlRowsByCode(id3f, 'fast_release_auth_terminated')).length, 0, '[3f] 既有终结码不应出现');
    ok('[3f] void 过期路径：六列清空+恰 1 条 fast_release_auth_expired+既有终结码不出现+主状态=已作废');

    // [3g]（既有回归）窗口内对照：授权未过期→void——既有终结码出现，超时码不出现。
    const id3g = await bugAtChulizhong();
    await authorize(id3g, '[3g] void 窗口内');
    const voidR3g = await call('POST', `/api/sys-issues/${id3g}/void`, adminTok, { reason: '[3g] 窗口内作废' });
    assert.strictEqual(voidR3g.status, 200, `[3g-void] 应 200，实得 ${voidR3g.status}`);
    assertAllNull(await fastReleaseRow(id3g), '[3g-void 后] 六列应被同事务清空');
    assert.strictEqual((await tlRowsByCode(id3g, 'fast_release_auth_terminated')).length, 1, '[3g] 应恰 1 条既有终结留痕');
    assert.strictEqual((await tlRowsByCode(id3g, 'fast_release_auth_expired')).length, 0, '[3g] 超时留痕不应出现');
    ok('[3g]（既有回归）void 窗口内：既有终结码出现，超时码不出现——与 [3f] 成对双向钉死');
  }

  // ══════════════════════════ [4a-4e] revoke 五格决策表 ══════════════════════════
  {
    // [4a] 格 1：无可撤残迹（从未授权过）——即便不传 reason 也应 409 deny（非 400 REASON_REQUIRED，
    //   证明 reason 校验确已移到分流之后，格 1 不执行）。
    const id1 = await bugAtChulizhong();
    const r4a = await call('POST', `/api/sys-issues/${id1}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(r4a.status, 409, `[4a] 格1 无可撤残迹应 409（非 400），实得 ${r4a.status} ${JSON.stringify(r4a.body)}`);
    assert.strictEqual(r4a.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[4a] 确切码，实得 ${r4a.body.code}`);
    assert.strictEqual(r4a.body.error, '当前未先行上线授权，无法撤销', `[4a] 精确文案，实得="${r4a.body.error}"`);
    ok('[4a] 格1「无可撤残迹」：409 deny 回归，且不传 reason 也不报 400（reason 校验确已移到分流之后）');

    // [4b] 格 2：残留∧窗口内∧无 done——不传 reason 应 400 REASON_REQUIRED（既有回归）；传 reason 应
    //   200 成功撤销。
    const id2 = await bugAtChulizhong();
    await authorize(id2, '[4b] 格2 撤销流回归');
    const r4bNoReason = await call('POST', `/api/sys-issues/${id2}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(r4bNoReason.status, 400, `[4b] 格2 缺 reason 应 400（既有回归），实得 ${r4bNoReason.status} ${JSON.stringify(r4bNoReason.body)}`);
    assert.strictEqual(r4bNoReason.body.code, 'FAST_RELEASE_REVOKE_REASON_REQUIRED', `[4b] 确切码，实得 ${r4bNoReason.body.code}`);
    const r4b = await call('POST', `/api/sys-issues/${id2}/fast-release-revoke`, adminTok, { reason: '[4b] 格2 正常撤销' });
    assert.strictEqual(r4b.status, 200, `[4b] 格2 传 reason 应 200，实得 ${r4b.status} ${JSON.stringify(r4b.body)}`);
    assert.ok(r4b.body.fast_release_revoked_at, '[4b] revoked_at 应已写入');
    ok('[4b]（既有回归）格2「残留∧窗口内∧无 done」：缺 reason→400 必填回归；传 reason→200 撤销成功');

    // [4c] 格 3：残留∧窗口内∧有 done——既有 done 闸 409（既有回归，reason 不影响判定）。
    const id3 = await bugAtChulizhong();
    await estimateFuture(id3);
    await authorize(id3, '[4c] 格3 done 闸回归');
    await setDutyToday(20, '值班员甲');
    const subR3 = await submitCommits(id3);
    assert.strictEqual(subR3.status, 200, `[4c-submit] 应 200，实得 ${subR3.status}`);
    const addR3 = await call('POST', `/api/sys-issues/${id3}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addR3.status, 200, `[4c-加人] 应 200，实得 ${addR3.status}`);
    const confirmR3 = await call('POST', `/api/sys-issues/${id3}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(confirmR3.status, 200, `[4c-值班确认] 应 200，实得 ${confirmR3.status}`);
    assert.strictEqual(confirmR3.body.flipped, false, '[4c-前置] 1 done+1 pending 不应翻牌');
    const r4c = await call('POST', `/api/sys-issues/${id3}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(r4c.status, 409, `[4c] 格3 存在 done 行应 409（既有回归），实得 ${r4c.status} ${JSON.stringify(r4c.body)}`);
    assert.strictEqual(r4c.body.code, 'FASTLANE_DEPLOY_IN_PROGRESS', `[4c] 确切码，实得 ${r4c.body.code}`);
    await clearDutyToday();
    ok('[4c]（既有回归）格3「残留∧窗口内∧有 done」：既有 done 闸 409 FASTLANE_DEPLOY_IN_PROGRESS 回归');

    // [4d] 格 4：残留∧过期——调超时终结内核，不写 revoked_at、不走 done 闸，reason 若有则忽略不落痕，
    //   缺 reason 亦成功（本格豁免必填）。同批验证"集合全清含 done"——先构造 1 done+1 pending 再过期。
    const id4 = await bugAtChulizhong();
    await estimateFuture(id4);
    await authorize(id4, '[4d] 格4 过期撤销');
    await setDutyToday(20, '值班员甲');
    const subR4 = await submitCommits(id4);
    assert.strictEqual(subR4.status, 200, `[4d-submit] 应 200，实得 ${subR4.status}`);
    const addR4 = await call('POST', `/api/sys-issues/${id4}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addR4.status, 200, `[4d-加人] 应 200，实得 ${addR4.status}`);
    const confirmR4 = await call('POST', `/api/sys-issues/${id4}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(confirmR4.status, 200, `[4d-值班确认] 应 200，实得 ${confirmR4.status}`);
    await expireAuth(id4);
    // [4d-MED2] updated_at 哨兵——先置可辨识旧值，随后断言内核终结确实刷新了它（本路径内核是 sys_issues
    //   唯一写点，不刷则整次请求 updated_at 零变更、列表"最近更新"排序失真；哨兵值法防同秒假绿）。
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id4]);
    // 缺 reason（不传 body）——格 4 应豁免必填，仍 200。
    const r4d = await call('POST', `/api/sys-issues/${id4}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(r4d.status, 200, `[4d] 格4 过期即便缺 reason 也应 200，实得 ${r4d.status} ${JSON.stringify(r4d.body)}`);
    assert.strictEqual(r4d.body.expired, true, '[4d] 响应应标注 expired:true');
    assert.strictEqual(r4d.body.fast_release_revoked_at, null, '[4d] ⭐⭐ revoked_at 不应被写入（本格走终结内核，非撤销 UPDATE）');
    const row4d = await fastReleaseRow(id4);
    assertAllNull(row4d, '[4d] 六列应被内核清空（含 revoked_at 仍为 NULL，非"清空后又置非空"）');
    const exec4d = await fastExecRows(id4);
    assert.ok(exec4d.every(r => r.removed_at), '[4d] 集合应全清含 done（内核唯一实现覆盖 done 行）');
    const expTl4d = await tlRowsByCode(id4, 'fast_release_auth_expired');
    assert.strictEqual(expTl4d.length, 1, `[4d] 超时留痕应恰 1 条，实得 ${expTl4d.length}`);
    assert.strictEqual((await tlRowsByCode(id4, 'fast_release_revoke')).length, 0, '[4d] 不应产生撤销专属 action_code（本格非撤销语义）');
    const upd4d = await get(`SELECT updated_at FROM sys_issues WHERE id = ?`, [id4]);
    assert.notStrictEqual(upd4d.updated_at, '2020-01-01 00:00:00', '[4d-MED2] 内核终结应刷新 updated_at（哨兵值仍在=内核未刷）');
    await clearDutyToday();
    ok('[4d] 格4「残留∧过期」：200+集合全清含 done+expired 标注+revoked_at 未写+缺 reason 亦成功（豁免必填）');

    // [4e] 格 5：五列命中但非残留（auth_at < reopened_at，P7 跨轮旧授权残迹）——SQL 直接把 reopened_at
    //   推到 auth_at 之后，构造这个方案标注为"结构性可达但真实序列极罕见"的组合（418-H2'/419/420 专项
    //   收口对象）。成对：缺 reason→既有 400 必填；有 reason→写 revoked_at+summary 含
    //   "跨轮失效残迹清理"标识+**无** fast_release_auth_expired。
    const id5 = await bugAtChulizhong();
    await authorize(id5, '[4e] 格5 跨轮残迹');
    const authAt5 = (await fastReleaseRow(id5)).fast_release_auth_at;
    await run(`UPDATE sys_issues SET reopened_at = datetime(?, '+1 second') WHERE id = ?`, [authAt5, id5]);
    const row5Before = await issueRow(id5);
    assert.ok(row5Before.reopened_at > row5Before.fast_release_auth_at, '[4e-前置] reopened_at 应晚于 auth_at（构造格5：五列命中但非残留）');
    const r4eNoReason = await call('POST', `/api/sys-issues/${id5}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(r4eNoReason.status, 400, `[4e] 格5 缺 reason 应 400（既有必填契约延续），实得 ${r4eNoReason.status} ${JSON.stringify(r4eNoReason.body)}`);
    assert.strictEqual(r4eNoReason.body.code, 'FAST_RELEASE_REVOKE_REASON_REQUIRED', `[4e] 确切码，实得 ${r4eNoReason.body.code}`);
    const r4e = await call('POST', `/api/sys-issues/${id5}/fast-release-revoke`, adminTok, { reason: '[4e] 跨轮残迹清理' });
    assert.strictEqual(r4e.status, 200, `[4e] 格5 传 reason 应 200，实得 ${r4e.status} ${JSON.stringify(r4e.body)}`);
    assert.ok(r4e.body.fast_release_revoked_at, '[4e] revoked_at 应已写入（本格是普通撤销出口，非终结内核）');
    assert.strictEqual(r4e.body.expired, undefined, '[4e] 响应不应带 expired 标注（非格4路径）');
    assert.strictEqual((await tlRowsByCode(id5, 'fast_release_auth_expired')).length, 0, '[4e] ⭐⭐ 不应产生 fast_release_auth_expired 留痕（本格非超时终结）');
    const revokeTl5 = await tlRowsByCode(id5, 'fast_release_revoke');
    assert.strictEqual(revokeTl5.length, 1, `[4e] 应恰 1 条撤销留痕，实得 ${revokeTl5.length}`);
    assert.ok(revokeTl5[0].summary.includes('跨轮失效残迹清理'), `[4e] summary 应含可辨识前缀"跨轮失效残迹清理"，实得="${revokeTl5[0].summary}"`);
    ok('[4e-成对] 格5「五列命中但非残留」：缺 reason→400 必填；传 reason→200+revoked_at 写入+summary 含"跨轮失效残迹清理"标识+无 expired 留痕');

    // [4e-420 补] 存在跨轮残留 done 行时合法 reason 撤销亦成功——证明本格独立 UPDATE 条件不含
    //   NOT EXISTS done（禁复用格2那条 SQL，见方案 §5⑥ 420 收口）。构造：正常挂牌+值班确认 done（此时
    //   仍是窗口内正常态）→ SQL 把 reopened_at 推到 auth_at 之后（模拟"这一代的 done 行是上一轮遗留，
    //   本该被 reopen 清空却没清"这一 P7 已知留白场景）→ revoke 应仍 200 成功，集合清含 done。
    const id6 = await bugAtChulizhong();
    await estimateFuture(id6);
    await authorize(id6, '[4e-420] 跨轮残迹+done 行');
    await setDutyToday(20, '值班员甲');
    const subR6 = await submitCommits(id6);
    assert.strictEqual(subR6.status, 200, `[4e-420-submit] 应 200，实得 ${subR6.status}`);
    const addR6 = await call('POST', `/api/sys-issues/${id6}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addR6.status, 200, `[4e-420-加人] 应 200，实得 ${addR6.status}`);
    const confirmR6 = await call('POST', `/api/sys-issues/${id6}/fast-release-exec-confirm`, dutyTok, {});
    assert.strictEqual(confirmR6.status, 200, `[4e-420-值班确认] 应 200，实得 ${confirmR6.status}`);
    assert.strictEqual((await fastExecRows(id6)).filter(r => r.exec_status === 'done').length, 1, '[4e-420-前置] 应恰 1 行 done');
    const authAt6 = (await fastReleaseRow(id6)).fast_release_auth_at;
    await run(`UPDATE sys_issues SET reopened_at = datetime(?, '+1 second') WHERE id = ?`, [authAt6, id6]);
    const r4e420 = await call('POST', `/api/sys-issues/${id6}/fast-release-revoke`, adminTok, { reason: '[4e-420] 跨轮残迹+done 行清理' });
    assert.strictEqual(r4e420.status, 200, `[4e-420] ⭐⭐ 存在跨轮 done 行时合法 reason 撤销应仍 200（既有 NOT EXISTS 若被误复用会 409 堵死出口），实得 ${r4e420.status} ${JSON.stringify(r4e420.body)}`);
    const exec4e420 = await fastExecRows(id6);
    assert.ok(exec4e420.every(r => r.removed_at), '[4e-420] 集合应全清含 done（格5独立 UPDATE 条件不含 NOT EXISTS 限制）');
    await clearDutyToday();
    ok('[4e-420 补] 格5 存在跨轮残留 done 行时：合法 reason 撤销仍 200+集合清含 done——反证「若误复用格2 NOT EXISTS 会 409 堵死」不成立');
  }

  // ══════════════════════════ [5a/5b] 重授权（触碰点⑦） ══════════════════════════
  {
    // [5a] 过期残留重授：授权→过期（SQL 推回）→ 直接 SQL 造一份"理论上不该出现"的残留执行人行
    //   （方案 §5⑦ 矩阵已论证真实序列结构性不可达——授权窗口 status IN('待处理','处理中') 不含
    //   「待验证」，过期挂牌单不可能真的走到这里；本处同 termination 姊妹套件既有手法，SQL 造态验证
    //   这条纵深防御代码本身）→ 重授权应：先落超时留痕（旧代次），再覆写新授权（新代次，未过期），
    //   旧集合行应被清空（软删）。
    const id = await bugAtChulizhong();
    await authorize(id, '[5a] 过期残留重授-旧代次');
    await expireAuth(id);
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name)
               VALUES (?, 20, '值班员甲', 1, '管理员')`, [id]);
    const staleExecBefore = await fastExecRows(id);
    assert.strictEqual(staleExecBefore.filter(r => !r.removed_at).length, 1, '[5a-前置] SQL 造态：应有 1 行未软删残留执行人');
    const oldAuthAt = (await fastReleaseRow(id)).fast_release_auth_at;
    const reauthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '[5a] 新一代授权' });
    assert.strictEqual(reauthR.status, 200, `[5a-重授] 应 200，实得 ${reauthR.status} ${JSON.stringify(reauthR.body)}`);
    assert.strictEqual(reauthR.body.reauthorized, true, '[5a] 应标注 reauthorized:true');
    const newRow = await fastReleaseRow(id);
    assert.notStrictEqual(newRow.fast_release_auth_at, oldAuthAt, '[5a] 新 auth_at 应与旧代次不同');
    const nowStrNow = await nowStr();
    assert.ok(I.isConsumableFastReleaseAuth(await issueRow(id), nowStrNow), '[5a] 新代次授权应可消费（未过期）');
    const expTl5a = await tlRowsByCode(id, 'fast_release_auth_expired');
    assert.strictEqual(expTl5a.length, 1, `[5a] 应恰 1 条超时留痕（针对旧代次）实得 ${expTl5a.length}`);
    const execAfter5a = await fastExecRows(id);
    assert.ok(execAfter5a.every(r => r.removed_at), '[5a] 旧代次残留执行人行应被清空（软删）');
    ok('[5a] 重授权（触碰点⑦）过期残留：先落超时留痕（旧代次）再覆写新授权（新代次未过期）+旧集合清');

    // [5b] 窗口内重授（既有回归）：正常授权后立即重授——不应产生超时留痕，既有"重新先行上线授权"
    //   文案不变。
    const idb = await bugAtChulizhong();
    await authorize(idb, '[5b] 窗口内重授回归-初次');
    const reauthRb = await call('POST', `/api/sys-issues/${idb}/fast-release-authorize`, adminTok, { note: '[5b] 窗口内重授' });
    assert.strictEqual(reauthRb.status, 200, `[5b-重授] 应 200，实得 ${reauthRb.status}`);
    assert.strictEqual(reauthRb.body.reauthorized, true, '[5b] 应标注 reauthorized:true');
    assert.strictEqual((await tlRowsByCode(idb, 'fast_release_auth_expired')).length, 0, '[5b] 窗口内重授不应产生超时留痕');
    const authTl5b = await tlRowsByCode(idb, 'fast_release_authorize');
    assert.ok(authTl5b[authTl5b.length - 1].summary.includes('重新先行上线授权'), `[5b] 既有文案不变，实得="${authTl5b[authTl5b.length - 1].summary}"`);
    ok('[5b]（既有回归）窗口内重授：正常覆写，零超时留痕，既有"重新先行上线授权"文案不变');
  }

  // ══════════════════════════ [6a/6b] 加人/移人（触碰点③④） ══════════════════════════
  {
    // [6a] 过期：正常挂牌后过期，加人/移人均应 409 FAST_RELEASE_AUTH_EXPIRED，且终结副作用已持久化。
    const idAdd = await bugAtChulizhong();
    await estimateFuture(idAdd);
    await authorize(idAdd, '[6a] 加人过期');
    await setDutyToday(20, '值班员甲');
    const subRAdd = await submitCommits(idAdd);
    assert.strictEqual(subRAdd.status, 200, `[6a-加人-submit] 应 200，实得 ${subRAdd.status}`);
    await expireAuth(idAdd);
    const addExpR = await call('POST', `/api/sys-issues/${idAdd}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addExpR.status, 409, `[6a-加人] 过期应 409，实得 ${addExpR.status} ${JSON.stringify(addExpR.body)}`);
    assert.strictEqual(addExpR.body.code, 'FAST_RELEASE_AUTH_EXPIRED', `[6a-加人] 确切码，实得 ${addExpR.body.code}`);
    assertAllNull(await fastReleaseRow(idAdd), '[6a-加人 409 后] 六列应已同事务清空（终结已持久化，非随 409 回滚）');
    assert.strictEqual((await tlRowsByCode(idAdd, 'fast_release_auth_expired')).length, 1, '[6a-加人] 超时留痕应已持久化');
    await clearDutyToday();

    const idRm = await bugAtChulizhong();
    await estimateFuture(idRm);
    await authorize(idRm, '[6a] 移人过期');
    await setDutyToday(20, '值班员甲');
    const subRRm = await submitCommits(idRm);
    assert.strictEqual(subRRm.status, 200, `[6a-移人-submit] 应 200，实得 ${subRRm.status}`);
    await expireAuth(idRm);
    const rmExpR = await call('DELETE', `/api/sys-issues/${idRm}/fast-release-executors/20`, adminTok);
    assert.strictEqual(rmExpR.status, 409, `[6a-移人] 过期应 409，实得 ${rmExpR.status} ${JSON.stringify(rmExpR.body)}`);
    assert.strictEqual(rmExpR.body.code, 'FAST_RELEASE_AUTH_EXPIRED', `[6a-移人] 确切码，实得 ${rmExpR.body.code}`);
    assertAllNull(await fastReleaseRow(idRm), '[6a-移人 409 后] 六列应已同事务清空');
    assert.strictEqual((await tlRowsByCode(idRm, 'fast_release_auth_expired')).length, 1, '[6a-移人] 超时留痕应已持久化');
    await clearDutyToday();
    ok('[6a] 加人/移人（触碰点③④）过期：均 409 FAST_RELEASE_AUTH_EXPIRED，终结副作用（六列清/留痕）已持久化');

    // [6b] 未过期（既有回归）：加人/移人应正常成功。
    const idAddB = await bugAtChulizhong();
    await estimateFuture(idAddB);
    await authorize(idAddB, '[6b] 加人未过期回归');
    await setDutyToday(20, '值班员甲');
    const subRAddB = await submitCommits(idAddB);
    assert.strictEqual(subRAddB.status, 200, `[6b-加人-submit] 应 200，实得 ${subRAddB.status}`);
    const addOkR = await call('POST', `/api/sys-issues/${idAddB}/fast-release-executors`, adminTok, { user_id: 6 });
    assert.strictEqual(addOkR.status, 200, `[6b-加人] 未过期应 200，实得 ${addOkR.status} ${JSON.stringify(addOkR.body)}`);
    assert.strictEqual((await fastExecRows(idAddB)).filter(r => !r.removed_at).length, 2, '[6b-加人] 应恰 2 行在册执行人');
    const rmOkR = await call('DELETE', `/api/sys-issues/${idAddB}/fast-release-executors/6`, adminTok);
    assert.strictEqual(rmOkR.status, 200, `[6b-移人] 未过期应 200，实得 ${rmOkR.status} ${JSON.stringify(rmOkR.body)}`);
    await clearDutyToday();
    ok('[6b]（既有回归）加人/移人未过期：正常成功回归');
  }

  // ══════════════════════════ [7a/7b] 五事件调用层分叉双向钉死 + 批次发布双保险同款分叉 ══════════════════════════
  {
    // [7a] 过期 return：与 [3a] 同族但换 return 边（case 'return' 分支），双向钉死"仅 expired 出现、
    //   既有终结码不出现"这条不变量对多个 case 都成立，非只对 accept 生效。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[7a] 过期 return');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[7a-submit] 应 200，实得 ${subR.status}`);
    await expireAuth(id);
    const returnR = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '[7a] 过期打回' });
    assert.strictEqual(returnR.status, 200, `[7a-return] 应 200，实得 ${returnR.status} ${JSON.stringify(returnR.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[7a] 打回应落处理中（主状态流转不受过期分叉影响）');
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_expired')).length, 1, '[7a] 应恰 1 条超时留痕');
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_terminated')).length, 0, '[7a] ⭐ 既有终结码不应出现');
    ok('[7a] 五事件调用层分叉（return 边）：过期→仅 fast_release_auth_expired 一条，既有终结码不出现');

    // [7b] 窗口内 return（既有回归）：仅既有终结码出现，超时行不出现——双向钉死。
    const idb = await bugAtChulizhong();
    await estimateFuture(idb);
    const subRb = await submitCommits(idb);
    assert.strictEqual(subRb.status, 200, `[7b-submit] 应 200，实得 ${subRb.status}`);
    const primeReturnRb = await call('POST', `/api/sys-issues/${idb}/return`, adminTok, { reason: '[7b] 前置打回清场' });
    assert.strictEqual(primeReturnRb.status, 200, `[7b-前置打回] 应 200，实得 ${primeReturnRb.status}`);
    await estimateFuture(idb);
    await authorize(idb, '[7b] 窗口内 return');
    const subRb2 = await submitCommits(idb);
    assert.strictEqual(subRb2.status, 200, `[7b-再提交] 应 200，实得 ${subRb2.status}`);
    const returnRb = await call('POST', `/api/sys-issues/${idb}/return`, adminTok, { reason: '[7b] 窗口内打回' });
    assert.strictEqual(returnRb.status, 200, `[7b-return] 应 200，实得 ${returnRb.status}`);
    assert.strictEqual((await tlRowsByCode(idb, 'fast_release_auth_terminated')).length, 1, '[7b] 应恰 1 条既有终结留痕');
    assert.strictEqual((await tlRowsByCode(idb, 'fast_release_auth_expired')).length, 0, '[7b] ⭐ 超时留痕不应出现');
    ok('[7b]（既有回归）五事件调用层分叉（return 边）窗口内：仅既有终结码出现，超时行不出现——双向钉死不串味');

    // 批次发布双保险同款分叉（SQL 造态，同族先例见 verify-sys-fastrelease-termination.js [4] 组）：
    //   正常到达「待上线」后（六列本为 NULL），SQL 注入一份"理论不该出现"的**过期**活跃授权——发布应
    //   走终结内核（非既有双保险 inline 清空），产出 fast_release_auth_expired 而非 fast_release_auth_terminated。
    async function bugAtDaishangxian() {
      const bid = await bugAtChulizhong();
      await estimateFuture(bid);
      const sr = await submitCommits(bid);
      assert.strictEqual(sr.status, 200, `[夹具-待验证] submit 应 200，实得 ${sr.status}`);
      const ar = await call('POST', `/api/sys-issues/${bid}/accept`, adminTok, {});
      assert.strictEqual(ar.status, 200, `[夹具-待上线] accept 应 200，实得 ${ar.status} ${JSON.stringify(ar.body)}`);
      assert.strictEqual(ar.body.status, '待上线', `[夹具-待上线] 应落待上线，实得 ${ar.body.status}`);
      return bid;
    }
    const bpId = await bugAtDaishangxian();
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = ?, fast_release_auth_note = '[7-批次] SQL 造态注入过期授权'
               WHERE id = ?`, [pastAuthAtStr(2), bpId]);
    const relR = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relR.status, 201, `[7-批次-建批次] 应 201，实得 ${relR.status} ${JSON.stringify(relR.body)}`);
    const relId = relR.body.id;
    const addRelR = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [bpId] });
    assert.strictEqual(addRelR.status, 200, `[7-批次-加单] 应 200，实得 ${addRelR.status} ${JSON.stringify(addRelR.body)}`);
    await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
               VALUES (?, 5, '开发王', 'done', datetime('now','localtime'), 1, '管理员')`, [relId]);
    await run('BEGIN IMMEDIATE');
    let publishOut, publishErr = null;
    try {
      publishOut = await I._publishReleaseCoreInTxn(relId, { id: 5, name: '开发王' }, { release_note: '[7-批次] 过期分叉发布' }, 'publish', 'publish');
      await run('COMMIT');
    } catch (e) { publishErr = e; try { await run('ROLLBACK'); } catch (_) { /* ignore */ } }
    if (publishErr) throw publishErr;
    assert.strictEqual(publishOut.count, 1, `[7-批次] 发布应恰含 1 单，实得 ${publishOut.count}`);
    assert.strictEqual(await statusOf(bpId), '已上线', '[7-批次] 发布后应落已上线');
    assertAllNull(await fastReleaseRow(bpId), '[7-批次-发布后] 六列应被终结内核清空');
    assert.strictEqual((await tlRowsByCode(bpId, 'fast_release_auth_expired')).length, 1, '[7-批次] ⭐⭐ 应产出超时留痕（走内核，非既有双保险 inline）');
    assert.strictEqual((await tlRowsByCode(bpId, 'fast_release_auth_terminated')).length, 0, '[7-批次] ⭐ 既有双保险终结码不应出现（过期分叉唯一所有权覆盖批次发布路径）');
    ok('[7-批次] 批次发布双保险同款分叉（SQL 造态）：过期→内核终结（fast_release_auth_expired），既有双保险 inline 终结码不出现');

    // [7-批次-MED1] 报警闸对全体 membersWithActiveAuth 执行（不因过期收窄）：同样 SQL 造态注入**过期**
    //   活跃授权，另外再 SQL 造态在 sys_fast_release_executors（fastlane 执行人集合表，与上面
    //   sys_release_executors 批次执行人表是两张不同的表）注入一行未软删 done——发布应仍 500
    //   FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH（阻断优先于终结，报警面不因过期收窄），且整批
    //   零副作用（六列/集合行/timeline/主状态全部原值）——证明 MED-1 顺序修正真的生效：若报警闸仍在
    //   consumable/expired 分叉之后才对 membersConsumable 执行，这条过期成员会被静默送进终结内核清掉
    //   done 行，报警永远不会触发，断言会落空。
    const bpId2 = await bugAtDaishangxian();
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = ?, fast_release_auth_note = '[7-批次-MED1] SQL 造态注入过期授权+done行'
               WHERE id = ?`, [pastAuthAtStr(2), bpId2]);
    await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
               VALUES (?, 20, '值班员甲', 'done', datetime('now','localtime'), 1, '管理员')`, [bpId2]);
    const rowBefore2 = await fastReleaseRow(bpId2);
    const relR2 = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relR2.status, 201, `[7-批次-MED1-建批次] 应 201，实得 ${relR2.status} ${JSON.stringify(relR2.body)}`);
    const relId2 = relR2.body.id;
    const addRelR2 = await call('POST', `/api/sys-releases/${relId2}/add-issues`, adminTok, { issue_ids: [bpId2] });
    assert.strictEqual(addRelR2.status, 200, `[7-批次-MED1-加单] 应 200，实得 ${addRelR2.status} ${JSON.stringify(addRelR2.body)}`);
    await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
               VALUES (?, 5, '开发王', 'done', datetime('now','localtime'), 1, '管理员')`, [relId2]);
    await run('BEGIN IMMEDIATE');
    let publishOut2 = null, publishErr2 = null;
    try {
      publishOut2 = await I._publishReleaseCoreInTxn(relId2, { id: 5, name: '开发王' }, { release_note: '[7-批次-MED1] 过期+done行报警' }, 'publish', 'publish');
      await run('COMMIT');
    } catch (e) { publishErr2 = e; try { await run('ROLLBACK'); } catch (_) { /* ignore */ } }
    assert.ok(publishErr2, '[7-批次-MED1] ⭐⭐ 过期+done 行仍应抛错阻断（报警闸不因过期收窄），不应静默发布成功');
    assert.strictEqual(publishErr2.httpStatus, 500, `[7-批次-MED1] 应 500，实得 ${publishErr2.httpStatus}`);
    assert.strictEqual(publishErr2.code, 'FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH', `[7-批次-MED1] 确切码，实得 ${publishErr2.code}`);
    assert.strictEqual(await statusOf(bpId2), '待上线', '[7-批次-MED1] 阻断后主状态应原样保留（待上线，未被推进已上线）');
    assert.deepStrictEqual(await fastReleaseRow(bpId2), rowBefore2, '[7-批次-MED1] 阻断后六列应原样保留（零副作用）');
    const execAfter2 = await fastExecRows(bpId2);
    assert.strictEqual(execAfter2.length, 1, '[7-批次-MED1] fastlane 执行人集合行数不变');
    assert.strictEqual(execAfter2[0].removed_at, null, '[7-批次-MED1] 注入的 done 行应仍未软删（未被终结内核清空——报警先于终结生效）');
    ok('[7-批次-MED1] 批次发布报警闸对全体 membersWithActiveAuth 执行（不因过期收窄）：过期+done 行仍 500 FASTLANE_ROSTER_UNEXPECTED_DONE_ON_PUBLISH 阻断，整批零副作用');

    // [7-批次-M1c]（S1-fix3 M1c）批发混合成员夹具：一批内同时含过期授权成员与窗口内授权成员（都无
    //   done 行）——发布应成功，过期成员只产生 fast_release_auth_expired（内核路径），窗口内成员只产生
    //   既有终结码 fast_release_auth_terminated（既有双保险 inline 路径），两者六列均清空，批发主状态
    //   更新与 changes 校验正常（同一批次内两条支路互不串味，双向证明 membersExpired/membersConsumable
    //   过滤+分流正确）。
    const bpExpired = await bugAtDaishangxian();
    const bpWindowed = await bugAtDaishangxian();
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = ?, fast_release_auth_note = '[7-批次-M1c] 混合夹具-过期成员'
               WHERE id = ?`, [pastAuthAtStr(2), bpExpired]);
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1, fast_release_auth_by_name = '管理员',
                 fast_release_auth_at = datetime('now','localtime'), fast_release_auth_note = '[7-批次-M1c] 混合夹具-窗口内成员'
               WHERE id = ?`, [bpWindowed]);
    const relRMix = await call('POST', '/api/sys-releases', adminTok, {});
    assert.strictEqual(relRMix.status, 201, `[7-批次-M1c-建批次] 应 201，实得 ${relRMix.status} ${JSON.stringify(relRMix.body)}`);
    const relIdMix = relRMix.body.id;
    const addRelMix = await call('POST', `/api/sys-releases/${relIdMix}/add-issues`, adminTok, { issue_ids: [bpExpired, bpWindowed] });
    assert.strictEqual(addRelMix.status, 200, `[7-批次-M1c-加单] 应 200，实得 ${addRelMix.status} ${JSON.stringify(addRelMix.body)}`);
    await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
               VALUES (?, 5, '开发王', 'done', datetime('now','localtime'), 1, '管理员')`, [relIdMix]);
    await run('BEGIN IMMEDIATE');
    let publishOutMix, publishErrMix = null;
    try {
      publishOutMix = await I._publishReleaseCoreInTxn(relIdMix, { id: 5, name: '开发王' }, { release_note: '[7-批次-M1c] 混合分叉发布' }, 'publish', 'publish');
      await run('COMMIT');
    } catch (e) { publishErrMix = e; try { await run('ROLLBACK'); } catch (_) { /* ignore */ } }
    if (publishErrMix) throw publishErrMix;
    assert.strictEqual(publishOutMix.count, 2, `[7-批次-M1c] 发布应恰含 2 单，实得 ${publishOutMix.count}（changes 校验正常）`);
    assert.strictEqual(await statusOf(bpExpired), '已上线', '[7-批次-M1c] 过期成员发布后应落已上线');
    assert.strictEqual(await statusOf(bpWindowed), '已上线', '[7-批次-M1c] 窗口内成员发布后应落已上线');
    assertAllNull(await fastReleaseRow(bpExpired), '[7-批次-M1c] 过期成员六列应被内核清空');
    assertAllNull(await fastReleaseRow(bpWindowed), '[7-批次-M1c] 窗口内成员六列应被既有双保险清空');
    assert.strictEqual((await tlRowsByCode(bpExpired, 'fast_release_auth_expired')).length, 1, '[7-批次-M1c] 过期成员应恰 1 条超时留痕');
    assert.strictEqual((await tlRowsByCode(bpExpired, 'fast_release_auth_terminated')).length, 0, '[7-批次-M1c] 过期成员不应出现既有终结码（同批未串到窗口内支路）');
    assert.strictEqual((await tlRowsByCode(bpWindowed, 'fast_release_auth_terminated')).length, 1, '[7-批次-M1c] 窗口内成员应恰 1 条既有终结留痕');
    assert.strictEqual((await tlRowsByCode(bpWindowed, 'fast_release_auth_expired')).length, 0, '[7-批次-M1c] 窗口内成员不应出现超时码（同批未串到过期支路）');
    ok('[7-批次-M1c] 批发混合成员（过期+窗口内，均无 done）：发布成功+两条支路互不串味（过期仅 expired 码/窗口内仅既有终结码）+六列均清空+changes=2 校验正常');
  }

  // ══════════════════════════ [8a/8b] 边界对 + 凌晨授权 ══════════════════════════
  {
    const baseRow = {
      fast_release_auth_at: '2026-01-01 15:30:00', fast_release_revoked_at: null, fast_release_consumed_at: null,
      released_at: null, online_source: null, reopened_at: null,
    };
    const deadline = I.fastReleaseAuthConsumeDeadline(baseRow.fast_release_auth_at);
    assert.strictEqual(deadline, '2026-01-02 08:00:00', `[8a] deadline 计算精确，实得 ${deadline}`);
    // [8a] now==deadline 应判失效（右开区间，等于即过期）。
    assert.strictEqual(I.isConsumableFastReleaseAuth(baseRow, deadline), false, '[8a] now==deadline 应判不可消费（右开区间，等于归已过期）');
    // now==deadline-1s 应判有效。
    const oneSecBefore = '2026-01-02 07:59:59';
    assert.strictEqual(I.isConsumableFastReleaseAuth(baseRow, oneSecBefore), true, '[8a] now==deadline-1s 应判可消费');
    ok('[8a] 边界对：now==deadline 失效（右开区间）／now==deadline-1s 有效——纯单元级注入参考时刻验证');

    // [8b] 凌晨授权：deadline 仍应=授权日次日 08:00（不因授权时刻本身临近午夜/凌晨而漂移）。
    const midnightRow = { ...baseRow, fast_release_auth_at: '2026-03-15 00:00:01' };
    const deadlineMidnight = I.fastReleaseAuthConsumeDeadline(midnightRow.fast_release_auth_at);
    assert.strictEqual(deadlineMidnight, '2026-03-16 08:00:00', `[8b] 凌晨授权 deadline 精确，实得 ${deadlineMidnight}`);
    const lateNightRow = { ...baseRow, fast_release_auth_at: '2026-03-15 23:59:59' };
    const deadlineLateNight = I.fastReleaseAuthConsumeDeadline(lateNightRow.fast_release_auth_at);
    assert.strictEqual(deadlineLateNight, '2026-03-16 08:00:00', `[8b] 深夜授权 deadline 精确（同日不同时刻应算出同一 deadline），实得 ${deadlineLateNight}`);
    ok('[8b] 凌晨/深夜授权：deadline 恒=授权日次日 08:00（同一授权日内任意时刻算出同一 deadline，不因临近午夜漂移）');

    // [8c]（S1-fix3 L）非法日历日期——2026-02-30 格式合法但日期不存在，JS Date 会悄悄进位成 3 月 2 日；
    //   收紧后应响亮抛错而非静默算出一个基于被规范化日期的截止时刻。
    assert.throws(() => I.fastReleaseAuthConsumeDeadline('2026-02-30 08:00:00'),
      /FAST_RELEASE_PREDICATE_INPUT_INVARIANT|非法/, '[8c] 非法日历日期（2026-02-30）应抛错，不应静默算出 3 月 2 日');
    ok('[8c]（S1-fix3 L）非法日历日期 2026-02-30：抛 FAST_RELEASE_PREDICATE_INPUT_INVARIANT，不静默进位到 3 月 2 日');

    // [8d]（S1-fix3 M2a）SQL 侧边界对拍——同一构造行，nowStr 分别取 deadline 与 deadline-1s，直接绑
    //   生产 FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL 片段（原样拼入不复制逻辑）对一条真实 DB 行求值，
    //   断言与 [8a] JS 侧结论逐项一致。
    const id8d = await bugAtChulizhong();
    await authorize(id8d, '[8d] SQL 侧边界对拍');
    await run(`UPDATE sys_issues SET fast_release_auth_at = '2026-01-01 15:30:00' WHERE id = ?`, [id8d]);
    const sqlAtDeadline = await get(
      `SELECT (CASE WHEN ${I.FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL} THEN 1 ELSE 0 END) AS v FROM sys_issues WHERE id = ?`,
      ['2026-01-02 08:00:00', id8d]);
    assert.strictEqual(sqlAtDeadline.v, 0, `[8d] SQL 侧 now==deadline 应判 0（不可消费），实得 ${sqlAtDeadline.v}`);
    const sqlOneSecBefore = await get(
      `SELECT (CASE WHEN ${I.FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL} THEN 1 ELSE 0 END) AS v FROM sys_issues WHERE id = ?`,
      ['2026-01-02 07:59:59', id8d]);
    assert.strictEqual(sqlOneSecBefore.v, 1, `[8d] SQL 侧 now==deadline-1s 应判 1（可消费），实得 ${sqlOneSecBefore.v}`);
    // [S2·F4-②] 同一 DB 行上的 JS 侧对拍——读回同一行构造 row 对象，调 isConsumableFastReleaseAuth 与
    //   上面两次 SQL 结果逐项一致（非另造种子，是同一行、同一对 nowStr 边界值的双侧核对）。
    const row8d = await issueRow(id8d);
    assert.strictEqual(I.isConsumableFastReleaseAuth(row8d, '2026-01-02 08:00:00'), false, '[8d] JS 侧同一行 now==deadline 应判 false，应与上面 SQL 结果（0）一致');
    assert.strictEqual(I.isConsumableFastReleaseAuth(row8d, '2026-01-02 07:59:59'), true, '[8d] JS 侧同一行 now==deadline-1s 应判 true，应与上面 SQL 结果（1）一致');
    ok('[8d]（S1-fix3 M2a + S2 F4-②）边界对拍：SQL 侧绑生产 FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL 片段 + JS 侧同一行调 isConsumableFastReleaseAuth，now==deadline 判 0/false／now==deadline-1s 判 1/true，两侧与 [8a] 逐项一致');
  }

  // ══════════════════════════ [9] JS/SQL 对拍 ══════════════════════════
  {
    const seeds = [
      await bugAtChulizhong(),   // 将授权且未过期
      await bugAtChulizhong(),   // 将授权且过期
      await bugAtChulizhong(),   // 从未授权（auth_at 恒 NULL）
      await bugAtChulizhong(),   // 授权后已撤销
      await bugAtChulizhong(),   // [S1-fix3 M2b] 跨轮残迹：auth_at < reopened_at（五列命中但非残留，格5同源构造）
      await bugAtChulizhong(),   // [S1-fix3 M2b] reopened_at 显式 NULL（六列第六条件走 OR 短路一支，未过期）
      await bugAtChulizhong(),   // [S1-fix3 M2b] 已撤销 + 同时已过其（本会）截止时刻——revoked 应恒赢，不因时间而改判
    ];
    await authorize(seeds[0], '[9] 对拍-未过期');
    await authorize(seeds[1], '[9] 对拍-过期');
    await expireAuth(seeds[1]);
    // seeds[2] 保持未授权
    await authorize(seeds[3], '[9] 对拍-已撤销');
    const revokeR = await call('POST', `/api/sys-issues/${seeds[3]}/fast-release-revoke`, adminTok, { reason: '[9] 对拍-已撤销构造' });
    assert.strictEqual(revokeR.status, 200, `[9-前置] 撤销应 200，实得 ${revokeR.status}`);
    // seeds[4]：授权后 SQL 把 reopened_at 推到 auth_at 之后（P7 跨轮残迹，同 [4e] 格5 构造手法）。
    await authorize(seeds[4], '[9] 对拍-跨轮残迹');
    {
      const authAt4 = (await fastReleaseRow(seeds[4])).fast_release_auth_at;
      await run(`UPDATE sys_issues SET reopened_at = datetime(?, '+1 second') WHERE id = ?`, [authAt4, seeds[4]]);
    }
    // seeds[5]：正常授权、reopened_at 显式确认为 NULL（默认值，此处显式断言供 [9] 对拍点名覆盖，非隐式假设）。
    await authorize(seeds[5], '[9] 对拍-reopened_at显式NULL');
    assert.strictEqual((await issueRow(seeds[5])).reopened_at, null, '[9-前置] seeds[5] reopened_at 应确为 NULL');
    // seeds[6]：撤销 + 已过期——revoked_at 非空应使残留判据恒假，不因 auth_at 早已过期而"改判"（本就不消费）。
    await authorize(seeds[6], '[9] 对拍-已撤销且已过期');
    const revokeR6 = await call('POST', `/api/sys-issues/${seeds[6]}/fast-release-revoke`, adminTok, { reason: '[9] 对拍-已撤销且已过期构造' });
    assert.strictEqual(revokeR6.status, 200, `[9-前置] seeds[6] 撤销应 200，实得 ${revokeR6.status}`);
    await run(`UPDATE sys_issues SET fast_release_auth_at = ? WHERE id = ?`, [pastAuthAtStr(2), seeds[6]]);

    const sharedNowStr = await nowStr();
    for (const id of seeds) {
      const row = await issueRow(id);
      const jsResult = I.isConsumableFastReleaseAuth(row, sharedNowStr) ? 1 : 0;
      const sqlRow = await get(
        `SELECT (CASE WHEN ${I.FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL} THEN 1 ELSE 0 END) AS v FROM sys_issues WHERE id = ?`,
        [sharedNowStr, id]);
      assert.strictEqual(sqlRow.v, jsResult, `[9] issue ${id}：JS(${jsResult}) 与 SQL(${sqlRow.v}) 判定应一致（绑同一 nowStr=${sharedNowStr}）`);
    }
    ok(`[9] JS/SQL 对拍：${seeds.length} 个种子行（未过期/过期/从未授权/已撤销/跨轮残迹/reopened_at显式NULL/已撤销且已过期）绑同一 nowStr，判定逐行一致`);
  }

  // ══════════════════════════ [10a/10b] 列表投影：过期 active_auth=0 + my_pending 不掺闸回归 ══════════════════════════
  {
    // 挂牌→值班人 pending 未确认→过期（SQL 推回，不经过任何写侧触碰点，roster 行原样悬挂——惰性收集
    //   设计下的合法瞬时/持续态）→ 列表端点应显示 active_auth=0（SQL 与列表行 JS 无重算两处同判，本列
    //   为 SQL 直出），但 my_pending 应仍为 1（原始信号不掺闸，未受 active_auth 语义变化影响）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[10] 列表投影过期');
    await setDutyToday(20, '值班员甲');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[10-submit] 应 200，实得 ${subR.status}`);
    await expireAuth(id);
    const listR = await call('GET', '/api/sys-issues', dutyTok);
    assert.strictEqual(listR.status, 200, `[10] 列表应 200，实得 ${listR.status}`);
    const row10 = listR.body.items.find(r => r.id === id);
    assert.ok(row10, '[10] 列表应含该单（值班人在册可见，assigned_to 除外的可见性路径见列表端点注释）');
    assert.strictEqual(row10.fast_release_active_auth, 0, `[10a] 过期行 active_auth 应=0（SQL 投影已改判可消费），实得 ${row10.fast_release_active_auth}`);
    assert.strictEqual(row10.fast_release_my_pending, 1, `[10b] ⭐ my_pending 不掺闸——即便 active_auth=0，本人仍在集合中且未确认，应仍为 1，实得 ${row10.fast_release_my_pending}`);
    await clearDutyToday();
    ok('[10a/10b] 列表投影：过期行 active_auth=0（SQL 投影同判）；my_pending 不掺闸——原始信号不受 active_auth 过期影响（回归）');
  }

  // ══════════════════════════ [11] 幂等限代次 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    await authorize(id, '[11] 幂等限代次-第一代');
    await expireAuth(id);
    const ns1 = await nowStr();
    await run('BEGIN IMMEDIATE');
    const r1 = await I.terminateExpiredFastReleaseAuthInTxn(id, adminActor, 'submit_gate', ns1);
    await run('COMMIT');
    assert.strictEqual(r1, true, '[11] 第一次触碰：残留∧过期，应终结返回 true');
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_expired')).length, 1, '[11] 第一次触碰后应恰 1 条超时留痕');

    // 同代次第二次触碰——六列已清，残留判据已假，应 no-op 返回 false，留痕数不变。
    await run('BEGIN IMMEDIATE');
    const r2 = await I.terminateExpiredFastReleaseAuthInTxn(id, adminActor, 'exec_confirm', ns1);
    await run('COMMIT');
    assert.strictEqual(r2, false, '[11] 同代次第二次触碰应 no-op 返回 false');
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_expired')).length, 1, '[11] 同代次第二次触碰后留痕数不应增加（幂等）');

    // 重授开新代次，再自然过期——第三次触碰应视为新代次，允许产生第二条超时留痕。
    const reauthR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '[11] 幂等限代次-第二代' });
    assert.strictEqual(reauthR.status, 200, `[11-重授] 应 200，实得 ${reauthR.status}`);
    await expireAuth(id);
    const ns2 = await nowStr();
    await run('BEGIN IMMEDIATE');
    const r3 = await I.terminateExpiredFastReleaseAuthInTxn(id, adminActor, 'submit_gate', ns2);
    await run('COMMIT');
    assert.strictEqual(r3, true, '[11] ⭐⭐ 新代次自然过期后第三次触碰应终结返回 true（非"永久 no-op"）');
    assert.strictEqual((await tlRowsByCode(id, 'fast_release_auth_expired')).length, 2, '[11] 新代次产生第二条超时留痕（成对：同代次幂等 vs 新代次合法新增）');
    ok('[11] 幂等限代次：同代次两触碰→超时留痕恰 1 条+第二次 no-op；重授开新代次后再过期→第二条超时留痕合法产生（成对）');
  }

  // ══════════════════════════ [12a/12b] ⑫探针：过期全 done 不报违例／窗口内全 done 报违例 ══════════════════════════
  {
    const aggSql = `SELECT i.id, i.type, i.status,
                            i.fast_release_auth_at, i.fast_release_revoked_at, i.fast_release_consumed_at,
                            i.released_at, i.online_source, i.reopened_at,
                            COUNT(fe.id) AS active_count,
                            COALESCE(SUM(CASE WHEN fe.exec_status='done' THEN 1 ELSE 0 END), 0) AS done_count
                       FROM sys_issues i
                       LEFT JOIN sys_fast_release_executors fe ON fe.issue_id = i.id AND fe.removed_at IS NULL
                      WHERE i.id = ? GROUP BY i.id`;
    // [12a] 过期全 done：正常挂牌确认到全 done 后（自动翻牌）——不适用；需绕过翻牌内核直接 SQL 标全
    //   done，模拟"内核被绕过/漏接线"场景，同时使授权过期——探针不应报违例（新设计下这是"待某个写侧
    //   触碰点收集"的合法瞬时/持续态，非"应已同事务翻牌却未翻"）。
    const id = await bugAtChulizhong();
    await estimateFuture(id);
    await authorize(id, '[12a] 全 done 探针-过期');
    await setDutyToday(20, '值班员甲');
    const subR = await submitCommits(id);
    assert.strictEqual(subR.status, 200, `[12a-submit] 应 200，实得 ${subR.status}`);
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id=?`, [id]);
    await expireAuth(id);
    const ns12a = await nowStr();
    const rows12a = await all(aggSql, [id]);
    const violations12a = I.fastReleaseNonFlippedFullDoneViolations(rows12a, ns12a);
    assert.deepStrictEqual(violations12a, [], `[12a] 过期全 done 不应报违例（合法待收集态），实得 ${JSON.stringify(violations12a)}`);
    await clearDutyToday();
    ok('[12a] ⑫探针：过期+全 done+待验证——不报违例（新设计下合法待收集态，非"应翻未翻"）');

    // [12b] 窗口内全 done（既有回归）：同样绕过内核直接标全 done，但不过期——应仍报 1 条违例（探针
    //   语义未因引入"可消费"改判而在窗口内失效）。
    const idb = await bugAtChulizhong();
    await estimateFuture(idb);
    await authorize(idb, '[12b] 全 done 探针-未过期回归');
    await setDutyToday(20, '值班员甲');
    const subRb = await submitCommits(idb);
    assert.strictEqual(subRb.status, 200, `[12b-submit] 应 200，实得 ${subRb.status}`);
    await run(`UPDATE sys_fast_release_executors SET exec_status='done', executed_at=datetime('now','localtime') WHERE issue_id=?`, [idb]);
    const ns12b = await nowStr();
    const rows12b = await all(aggSql, [idb]);
    const violations12b = I.fastReleaseNonFlippedFullDoneViolations(rows12b, ns12b);
    assert.strictEqual(violations12b.length, 1, `[12b] 窗口内全 done 仍应报 1 条违例（既有回归），实得 ${JSON.stringify(violations12b)}`);
    await clearDutyToday();
    ok('[12b]（既有回归）⑫探针：窗口内+全 done+待验证——仍报 1 条违例，探针语义未被过期改判削弱');
  }

  // ══════════════════════════ [14] 详情投影 deadline/expired 两态正确 ══════════════════════════
  {
    // 未过期：deadline 非空且格式精确，expired=0，active_auth=1。
    const id = await bugAtChulizhong();
    const authResp = await authorize(id, '[14] 详情投影未过期');
    const detailR = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detailR.status, 200, `[14a-详情] 应 200，实得 ${detailR.status}`);
    const issue14a = detailR.body.issue;
    const expectedDeadline = I.fastReleaseAuthConsumeDeadline(authResp.fast_release_auth_at);
    assert.strictEqual(issue14a.fast_release_auth_deadline, expectedDeadline, `[14a] deadline 精确，实得 ${issue14a.fast_release_auth_deadline}`);
    assert.strictEqual(issue14a.fast_release_auth_expired, 0, `[14a] 未过期 expired 应=0，实得 ${issue14a.fast_release_auth_expired}`);
    assert.strictEqual(issue14a.fast_release_active_auth, 1, `[14a] 未过期 active_auth 应=1，实得 ${issue14a.fast_release_active_auth}`);
    ok('[14a] 详情投影未过期：deadline 精确 + expired=0 + active_auth=1');

    // 过期：deadline 仍非空（历史授权时刻仍可算出截止时刻，供前端展示"已超时"提示），expired=1，
    //   active_auth=0。
    await expireAuth(id);
    const authAtAfterExpire = (await fastReleaseRow(id)).fast_release_auth_at;
    const detailR2 = await call('GET', `/api/sys-issues/${id}`, adminTok);
    assert.strictEqual(detailR2.status, 200, `[14b-详情] 应 200，实得 ${detailR2.status}`);
    const issue14b = detailR2.body.issue;
    const expectedDeadline2 = I.fastReleaseAuthConsumeDeadline(authAtAfterExpire);
    assert.strictEqual(issue14b.fast_release_auth_deadline, expectedDeadline2, `[14b] deadline 精确（历史授权时刻仍可算），实得 ${issue14b.fast_release_auth_deadline}`);
    assert.strictEqual(issue14b.fast_release_auth_expired, 1, `[14b] 过期 expired 应=1，实得 ${issue14b.fast_release_auth_expired}`);
    assert.strictEqual(issue14b.fast_release_active_auth, 0, `[14b] 过期 active_auth 应=0，实得 ${issue14b.fast_release_active_auth}`);
    ok('[14b] 详情投影过期：deadline 仍精确（历史时刻可算）+ expired=1 + active_auth=0');
  }

  // ══════════════════════════ [15]（S1-fix MED-4）套件末尾全库两探针零违例扫描 ══════════════════════════
  //   照 verify-sys-fastlane-submit.js [50a] 范式——扫描本套件累积状态（前面 [1]-[14] 全部真实链路+SQL
  //   造态跑完后），两条既有不变量探针均应零违例：本批新增的过期分叉/内核终结/revoke 五格等改动不应
  //   在任何真实/造态路径上遗留"终态单残留活跃授权"或"授权非活跃却未软删集合行"。
  {
    const terminalScanSql = `SELECT id, status, fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at FROM sys_issues`;
    const terminalRows = await all(terminalScanSql);
    const terminalViolations = I.fastReleaseUnresolvedAtTerminalStateViolations(terminalRows);
    assert.deepStrictEqual(terminalViolations, [], `[15a] 不变量探针（终态单残留活跃授权）应零违例（候选 ${terminalRows.length} 行），实得 ${JSON.stringify(terminalViolations)}`);
    ok(`[15a] 套件末尾全库扫描：不变量探针 fastReleaseUnresolvedAtTerminalStateViolations 零违例（候选 ${terminalRows.length} 行）`);

    const rosterScanSql = `SELECT fe.id AS exec_id, fe.issue_id AS issue_id, fe.user_id AS user_id,
                                   i.fast_release_auth_at, i.fast_release_revoked_at, i.fast_release_consumed_at,
                                   i.released_at, i.online_source, i.reopened_at
                              FROM sys_fast_release_executors fe
                              JOIN sys_issues i ON i.id = fe.issue_id
                             WHERE fe.removed_at IS NULL`;
    const rosterRows = await all(rosterScanSql);
    const rosterViolations = I.fastReleaseRosterResidualAtInactiveAuthViolations(rosterRows);
    assert.deepStrictEqual(rosterViolations, [], `[15b] 不变量探针（授权非活跃却未软删集合行）应零违例（候选 ${rosterRows.length} 行），实得 ${JSON.stringify(rosterViolations)}`);
    ok(`[15b] 套件末尾全库扫描：不变量探针 fastReleaseRosterResidualAtInactiveAuthViolations 零违例（候选 ${rosterRows.length} 行）`);
  }

  console.log(`\n✅ verify-sys-fastlane-auth-expiry 全部通过（${passed} 项）`);
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); fail(e && e.stack || e); });
