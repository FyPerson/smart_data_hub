// scripts/verify-sys-fastrelease-auth.js — 系统迭代·组 B「bug 先行上线授权」阶段一（授权面）验收
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §1(B1/B2/B2b) + §3.1
//   用法：node scripts/verify-sys-fastrelease-auth.js
//
// 范围声明：本阶段只做 §3.1 授权面（POST fast-release-authorize/fast-release-revoke 两端点 + schema
//   六列 + 成组约束）。§3.2 开发直上（submit 勾选直翻）与 §3.3 补验收闭环是后续阶段，未实现，本文件
//   不覆盖那两段（不构造 fast_release_consumed_at 之外的"真实消费"场景——消费态本阶段一律 SQL 造态）。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1] 授权正例（bug·待处理/处理中两态）→ 六列落库 + timeline 一条 + 详情端点投影（SELECT * 天然带出）
//   [2] 窗口负例（bug·待受理/待修改/已拒绝/已暂缓四态 + 已上线态）→ 409 FAST_RELEASE_AUTH_STATUS_NOT_ALLOWED
//       + 零副作用（已上线态含真实 accept 直翻 E2E 负例 + SQL 造态 released_at 纵深防御负例，[预筛 MED-1]）
//   [3] 非 bug 类型 → 409 FAST_RELEASE_TYPE_NOT_ALLOWED（type 前置判定，不看 status）
//   [4] 权限负例（非 admin 角色）→ 403（授权/撤销两端点各一次）
//   [5] 重新授权（B2b）：现值已 consumed（SQL 造态）→ 再授权覆盖三件套 + consumed_at 置空 + timeline 两条历史
//   [6] 撤销正例 + 撤销后再授权（revoked_at 置空）
//   [7] 撤销负例：未授权 / 已消费（SQL 造态）→ 409 FAST_RELEASE_REVOKE_NOT_ALLOWED + 零副作用 + 精确原因文案
//       （[预筛 MED-3] 四因逐条断言：未授权/已撤销幂等提示/已消费不可撤/已上线不可撤，错误码单码不变）
//   [8] 成组约束探针（[Y5] 范式，[预筛 MED-2] 判据只此一份）：JS 纯函数用例表（4 正例+4 反例+空串反例）+
//       候选行 SQL 粗筛→I.fastReleaseGroupInvariantViolations 逐行精判（内存库注入对照①②③各一条 + 空串
//       专项，均含"注入判红→清理恢复0"闭环）+ 真实本地库（task_pool.db）同一判据违例计数=0
//   [9]（组 B·B1·授权终结事件制·2026-08-13 用户 P7 终裁后改写）accept 直翻已上线终结活跃授权——真实链路
//       （创建→受理→指派→授权→estimate→submit(no_code)→accept 直翻已上线→close→reopen）：accept 命中
//       事件①「上线翻牌」，六列清空+1条 fast_release_auth_terminated 留痕；close/reopen 均不复活六列。
//       B1 终结事件制的完整覆盖（三事件成对用例+不变量探针）见姊妹文件
//       scripts/verify-sys-fastrelease-termination.js，本组只覆盖 accept 这一条边作为回归锚点。
//   [10] note 边界：trim 空白视同未填 / 恰 200 字放行 / 201 字 400 / 非字符串 400
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-fastrelease-auth-secret';
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
function fail(msg) { console.error('\n❌ verify-sys-fastrelease-auth 失败: ' + msg); process.exit(1); }

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const isChangeType = type === 'feature' || type === 'improvement';
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `FR-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-fastrelease-auth 夹具', intake_liaison_id: 13,
    ...(isChangeType ? { needs_feasibility: 0 } : {}),
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// bug 六态夹具——均从真实端点链路驱动，不直接 UPDATE status（避免绕过引擎不变量污染断言前提）。
async function bugAtDaishouli() { return mkIssue('bug'); }                                 // 待受理（创建即得）
async function bugAtDaixiugai() {
  const id = await mkIssue('bug');
  const r = await call('POST', `/api/sys-issues/${id}/intake-return`, adminTok, { reason: '需求描述不清，请补充' });
  assert.strictEqual(r.status, 200, `[夹具-待修改] intake-return 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
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
async function bugAtYijujue() {
  const id = await mkIssue('bug');
  const r = await call('POST', `/api/sys-issues/${id}/issue-reject`, adminTok, { reason: '不予受理' });
  assert.strictEqual(r.status, 200, `[夹具-已拒绝] issue-reject 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
async function bugAtYizhanhuan() {
  const id = await bugAtChulizhong();
  const r = await call('POST', `/api/sys-issues/${id}/hold`, adminTok, { reason: '等待第三方接口就绪' });
  assert.strictEqual(r.status, 200, `[夹具-已暂缓] hold 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
// [预筛 MED-1] 从「处理中」态经真实 estimate→submit(no_code)→accept 零 commit 直翻「已上线」——
//   同 verify-sys-c9-direct-online 既有 seedToVerify 手法：对接人失效走§3.0-⑥ 降级，submit 直落待验证。
//   供 bugAtYishangxian（未授权夹具）复用，避免复制粘贴这段 estimate/submit/accept 链路。
//   ⚠️ [组 B·B1 落地后订正] [7d] 曾是本函数第二个调用方（"先授权再驶向已上线"构造悬垂授权夹具）——
//   B1 后 accept 的 C9 直翻分支会同事务终结掉未消费的活跃授权，[7d] 那个场景经真实链路已结构性
//   不可达，已改为 SQL 造态直接构造，不再调用本函数（见 [7d] 定义处注释）。本函数目前仅 bugAtYishangxian
//   一处调用方，保留独立抽取（非内联）是为了未来若有第三个"未授权驶向已上线"场景可直接复用。
async function driveChulizhongToOnline(id, tag) {
  const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
  const estR = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst });
  assert.strictEqual(estR.status, 200, `[${tag}] estimate 应 200，实得 ${estR.status} ${JSON.stringify(estR.body)}`);
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  const submitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
    mode: 'no_code', no_code_reason: `verify 夹具：无提交交付（${tag}）`, self_tested: true, test_env_deployed: true,
    bug_cause_note: `verify 夹具：bug 产生原因（${tag}）`,
  });
  assert.strictEqual(submitR.status, 200, `[${tag}] submit 应 200，实得 ${submitR.status} ${JSON.stringify(submitR.body)}`);
  const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(acceptR.status, 200, `[${tag}] accept 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
  assert.strictEqual(acceptR.body.status, '已上线', `[${tag}] 零 commit 应直翻已上线，实得 ${acceptR.body.status}`);
}
// 已上线态夹具——不预先授权。供 [2] 窗口负例组用：证明「已上线」态不可授权——status 检查本身已能拦下
//   （窗口只认待处理/处理中），本夹具是这条既有防线的真实端到端验证，非测试 [预筛 MED-1] 新叠的 WHERE
//   列本身（那条见 [2] 的 SQL 造态负例，[2-已上线-纵深] 组）。
async function bugAtYishangxian() {
  const id = await bugAtChulizhong();
  await driveChulizhongToOnline(id, '夹具-已上线');
  assert.ok(await get('SELECT released_at, online_source FROM sys_issues WHERE id=?', [id]).then(r2 => r2.released_at && r2.online_source),
    '[夹具-已上线] 前置：released_at/online_source 均应已落库（供 [2-已上线-纵深] 造态测试对照真实值）');
  return id;
}

const fastReleaseRow = (id) => get(
  `SELECT fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note,
          fast_release_revoked_at, fast_release_consumed_at
     FROM sys_issues WHERE id=?`, [id]);
const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const timelineCount = async (id) => Number((await get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id])).c);
const fastReleaseTlRows = (id, actionCode) => all(
  `SELECT summary, event_type, action_code, operator_id, operator_name FROM sys_issue_timeline
    WHERE issue_id=? AND action_code=? ORDER BY id`, [id, actionCode]);
function assertAllNull(row, tag) {
  for (const k of Object.keys(row)) {
    assert.strictEqual(row[k], null, `${tag}：${k} 应为 NULL，实得 ${JSON.stringify(row[k])}`);
  }
}

// [codex 360 L2] 六列全集合权威列表——[0] 前置自检与 [8c] 真实库列存在检查共用同一份，不各写一份字面量
// （对齐 index.js SYS_ISSUES_KEY_COLS「整组入锚」意图：六列是同一次 alterAddMissingCols [1a-14] 调用
// 一并补齐的原子单元，检查侧同样应按整组核对，不能只抽查一列当"迁移是否已跑"的代表）。
const FAST_RELEASE_SIX_COLS = ['fast_release_auth_by', 'fast_release_auth_by_name', 'fast_release_auth_at',
  'fast_release_auth_note', 'fast_release_revoked_at', 'fast_release_consumed_at'];

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / dev5 / 受理人13）');

  // ══════════════════════════ [0] schema 六列已就绪（前置自检） ══════════════════════════
  {
    const cols = (await all(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
    for (const c of FAST_RELEASE_SIX_COLS) {
      assert.ok(cols.includes(c), `[0] sys_issues 应含列 ${c}（alterAddMissingCols [1a-14] 未生效？）`);
    }
    ok('[0] sys_issues 六列（fast_release_auth_by/_by_name/_at/_note/_revoked_at/_consumed_at）均已就绪');
  }

  // ══════════════════════════ [1] 授权正例（待处理 / 处理中 两态）══════════════════════════
  {
    for (const [label, mkFixture] of [['待处理', bugAtDaichuli], ['处理中', bugAtChulizhong]]) {
      const id = await mkFixture();
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: `${label}态授权备注` });
      assert.strictEqual(r.status, 200, `[1-${label}] 授权应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.reauthorized, false, `[1-${label}] 首次授权 reauthorized 应为 false`);
      const row = await fastReleaseRow(id);
      assert.strictEqual(row.fast_release_auth_by, 1, `[1-${label}] fast_release_auth_by 落库=操作者 id`);
      assert.strictEqual(row.fast_release_auth_by_name, '管理员', `[1-${label}] fast_release_auth_by_name 落库=操作者名`);
      assert.ok(row.fast_release_auth_at, `[1-${label}] fast_release_auth_at 已落库`);
      assert.strictEqual(row.fast_release_auth_note, `${label}态授权备注`, `[1-${label}] fast_release_auth_note 落库=提交值`);
      assert.strictEqual(row.fast_release_revoked_at, null, `[1-${label}] fast_release_revoked_at 仍为 NULL`);
      assert.strictEqual(row.fast_release_consumed_at, null, `[1-${label}] fast_release_consumed_at 仍为 NULL`);
      assert.strictEqual(await timelineCount(id), beforeTl + 1, `[1-${label}] timeline 恰新增 1 条`);
      const tl = await fastReleaseTlRows(id, 'fast_release_authorize');
      assert.strictEqual(tl.length, 1, `[1-${label}] action_code=fast_release_authorize 的 timeline 行恰 1 条`);
      assert.strictEqual(tl[0].event_type, 'note', `[1-${label}] timeline event_type=note`);
      assert.ok(tl[0].summary.includes('先行上线授权'), `[1-${label}] timeline summary 含"先行上线授权"，实得 ${tl[0].summary}`);
      // 详情端点投影（GET /sys-issues/:id 用 SELECT sys_issues.* 天然带出新列，未显式改动该端点）
      const detail = await call('GET', `/api/sys-issues/${id}`, adminTok);
      assert.strictEqual(detail.status, 200, `[1-${label}-详情] 应 200，实得 ${detail.status}`);
      assert.strictEqual(detail.body.issue.fast_release_auth_by, 1, `[1-${label}-详情] issue.fast_release_auth_by 投影正确`);
      assert.strictEqual(detail.body.issue.fast_release_auth_at, row.fast_release_auth_at, `[1-${label}-详情] issue.fast_release_auth_at 与库内值一致`);
      assert.strictEqual(detail.body.issue.fast_release_auth_note, `${label}态授权备注`, `[1-${label}-详情] issue.fast_release_auth_note 投影正确`);
    }
    ok('[1] bug·待处理/处理中两态授权正例：六列落库 + timeline 一条 + 详情端点自然投影（SELECT * 无需改动）');
  }

  // ══════════════════════════ [2] 窗口负例（待受理/待修改/已拒绝/已暂缓 四态）══════════════════════════
  {
    for (const [label, mkFixture] of [
      ['待受理', bugAtDaishouli], ['待修改', bugAtDaixiugai], ['已拒绝', bugAtYijujue], ['已暂缓', bugAtYizhanhuan],
      ['已上线', bugAtYishangxian],   // [预筛 MED-1] 真实链路（accept 零 commit 直翻）到达的已上线态——
      //   status 检查本身已能拦（窗口只认待处理/处理中），本条验证的是这条既有防线，非新叠的 WHERE 列。
    ]) {
      const id = await mkFixture();
      const st = await statusOf(id);
      assert.strictEqual(st, label, `[2-${label}-前置] 夹具应停在「${label}」，实得「${st}」`);
      const before = await fastReleaseRow(id);
      assertAllNull(before, `[2-${label}-前置]`);
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
      assert.strictEqual(r.status, 409, `[2-${label}] 期望 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_AUTH_STATUS_NOT_ALLOWED', `[2-${label}] 确切码，实得 ${r.body.code}`);
      const after = await fastReleaseRow(id);
      assertAllNull(after, `[2-${label}-零副作用]`);
      assert.strictEqual(await timelineCount(id), beforeTl, `[2-${label}] 零副作用：timeline 无新增`);
    }
    ok('[2] bug·待受理/待修改/已拒绝/已暂缓/已上线 五态：授权窗口负例 409 FAST_RELEASE_AUTH_STATUS_NOT_ALLOWED + 零副作用');

    // [2-已上线-纵深]（预筛 MED-1）SQL 造态：处理中态（在授权窗口内）但人为置入 released_at——测的是
    //   MED-1 新叠的 `AND released_at IS NULL AND online_source IS NULL` 这条纵深防御本身，与上面
    //   "已上线"态负例（被 status 检查拦下）是两条不同的防线：真实业务流程里 status='处理中' 时
    //   released_at 恒为 NULL（不可能同时成立），此处用 SQL 强行构造这个理论组合，验证即便 status
    //   检查侥幸放行，released_at 非空这一条也能独立拦下——不依赖 reopen 那句自称"纯纵深防御"的清空
    //   语句是否还在。
    {
      const id = await bugAtChulizhong();
      await run(`UPDATE sys_issues SET released_at = datetime('now','localtime') WHERE id = ?`, [id]);
      const st = await statusOf(id);
      assert.strictEqual(st, '处理中', '[2-已上线-纵深-前置] 造态后 status 仍在授权窗口内（处理中）');
      const beforeTl = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
      assert.strictEqual(r.status, 409, `[2-已上线-纵深] status 在窗口内但 released_at 非空，期望仍 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_AUTH_STATUS_NOT_ALLOWED', `[2-已上线-纵深] 确切码，实得 ${r.body.code}`);
      // [codex 360 M1] 窗口相符但已有上线标记——文案须区分于"窗口本身不符"那句，不能混着用同一句话。
      assert.strictEqual(r.body.error, '该单已有上线标记（released_at/online_source），不能先行上线授权',
        `[2-已上线-纵深] 精确原因文案（区分于窗口不符的既有文案），实得="${r.body.error}"`);
      const after = await fastReleaseRow(id);
      assertAllNull(after, '[2-已上线-纵深-零副作用]');
      assert.strictEqual(await timelineCount(id), beforeTl, '[2-已上线-纵深] 零副作用：timeline 无新增');
      ok('[2-已上线-纵深] SQL 造态（处理中态但 released_at 非空）：MED-1 新叠的 WHERE 条件独立拦下 409 + 精确原因文案，不依赖 status 检查');
    }
  }

  // ══════════════════════════ [3] 非 bug 类型 → 409（type 前置，不看 status）══════════════════════════
  {
    for (const type of ['feature', 'improvement']) {
      const id = await mkIssue(type);
      const r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
      assert.strictEqual(r.status, 409, `[3-${type}] 期望 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'FAST_RELEASE_TYPE_NOT_ALLOWED', `[3-${type}] 确切码，实得 ${r.body.code}`);
      const row = await fastReleaseRow(id);
      assertAllNull(row, `[3-${type}-零副作用]`);
    }
    ok('[3] feature/improvement 类型：409 FAST_RELEASE_TYPE_NOT_ALLOWED（type 前置判定，未受理待受理态也同样拒绝）');
  }

  // ══════════════════════════ [4] 权限负例（非 admin）→ 403 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    const rAuth = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, devTok, {});
    assert.strictEqual(rAuth.status, 403, `[4-授权] 非 admin 应 403，实得 ${rAuth.status} ${JSON.stringify(rAuth.body)}`);
    const rowAfterAuth = await fastReleaseRow(id);
    assertAllNull(rowAfterAuth, '[4-授权-零副作用]');

    // 撤销负例也用非 admin：先用 admin 正常授权，再用 devTok 尝试撤销，期望 403 且授权状态原样保留
    const authR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR.status, 200, `[4-撤销-前置授权] 应 200，实得 ${authR.status}`);
    const beforeRevoke = await fastReleaseRow(id);
    const rRevoke = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, devTok, {});
    assert.strictEqual(rRevoke.status, 403, `[4-撤销] 非 admin 应 403，实得 ${rRevoke.status} ${JSON.stringify(rRevoke.body)}`);
    const afterRevoke = await fastReleaseRow(id);
    assert.deepStrictEqual(afterRevoke, beforeRevoke, '[4-撤销-零副作用] 403 被中间件拦下，六列应与授权后原样一致');
    ok('[4] 非 admin 角色：授权/撤销两端点均 403（与 /accept 同一 requireAdmin 中间件），零副作用');
  }

  // ══════════════════════════ [5] 重新授权（B2b）：已消费 → 再授权覆盖三件套 + consumed_at 置空 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    const r1 = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '首次授权' });
    assert.strictEqual(r1.status, 200, `[5-首授] 应 200，实得 ${r1.status}`);
    const row1 = await fastReleaseRow(id);
    assert.ok(row1.fast_release_auth_at, '[5-首授] auth_at 已落库');

    // SQL 造态：模拟"已被消费"（本阶段尚无真实 §3.2 直上端点，方案明文本阶段用 SQL 造态验证生命周期）
    await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime') WHERE id=?`, [id]);
    const consumedRow = await fastReleaseRow(id);
    assert.ok(consumedRow.fast_release_consumed_at, '[5-造态] consumed_at 已 SQL 置入');

    // 重新授权：换一个不同的操作者名义（此环境只有一个 admin 用户，改用同一 admin 但断言覆盖行为本身）
    const r2 = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '重新授权' });
    assert.strictEqual(r2.status, 200, `[5-重授] 应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.reauthorized, true, '[5-重授] reauthorized 应为 true（现值 auth_at 非空）');
    const row2 = await fastReleaseRow(id);
    // [注] 不比较 auth_at 前后是否变化——写点用 datetime('now','localtime') 只到秒精度，两次调用落在
    //   同一秒时字符串会恰好相等，那不代表"跳过未写"（同 C9_UPDATED_AT_SENTINEL 一带教训：同秒空转写
    //   假绿风险的反面——这里若误用 notStrictEqual 反而会在真实执行正确时偶发假红）。改用 auth_note 是
    //   否被覆盖为最新提交值来证明"确实执行了覆盖写"，比对时间戳更可靠。
    assert.strictEqual(row2.fast_release_auth_note, '重新授权', '[5-重授] auth_note 已覆盖为最新提交值（证明三件套确实被重写，非误判跳过）');
    assert.strictEqual(row2.fast_release_consumed_at, null, '[5-重授] ⭐ consumed_at 已被重新授权置空（B2b：重新授权=覆盖三件套+置空 revoked/consumed）');
    assert.strictEqual(row2.fast_release_revoked_at, null, '[5-重授] revoked_at 仍为 NULL');
    const tl = await fastReleaseTlRows(id, 'fast_release_authorize');
    assert.strictEqual(tl.length, 2, `[5-重授] timeline 两条历史（首授+重授各一条，不覆盖旧行），实得 ${tl.length}`);
    assert.ok(tl[0].summary.includes('先行上线授权') && !tl[0].summary.includes('重新'), `[5-重授] 第一条应是首次授权文案，实得 ${tl[0].summary}`);
    assert.ok(tl[1].summary.includes('重新先行上线授权'), `[5-重授] 第二条应含"重新先行上线授权"，实得 ${tl[1].summary}`);
    ok('[5] 重新授权（现值已 consumed，SQL 造态模拟）：三件套覆盖 + consumed_at 置空 + timeline 两条历史（首授/重授均保留，不覆盖）');
  }

  // ══════════════════════════ [6] 撤销正例 + 撤销后再授权 ══════════════════════════
  {
    const id = await bugAtChulizhong();
    const r1 = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(r1.status, 200, `[6-授权] 应 200，实得 ${r1.status}`);
    const row1 = await fastReleaseRow(id);

    const rRevoke = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '验收前主动撤销' });
    assert.strictEqual(rRevoke.status, 200, `[6-撤销] 应 200，实得 ${rRevoke.status} ${JSON.stringify(rRevoke.body)}`);
    const row2 = await fastReleaseRow(id);
    assert.ok(row2.fast_release_revoked_at, '[6-撤销] revoked_at 已落库');
    assert.strictEqual(row2.fast_release_auth_by, row1.fast_release_auth_by, '[6-撤销] 授权三件套原样保留（撤销不清授权痕迹，仅打撤销戳）');
    assert.strictEqual(row2.fast_release_auth_at, row1.fast_release_auth_at, '[6-撤销] auth_at 未变');
    assert.ok(String(row2.fast_release_revoked_at) >= String(row2.fast_release_auth_at), '[6-撤销] revoked_at >= auth_at（成组约束②）');
    const tlRevoke = await fastReleaseTlRows(id, 'fast_release_revoke');
    assert.strictEqual(tlRevoke.length, 1, '[6-撤销] timeline 恰新增 1 条 fast_release_revoke');
    assert.ok(tlRevoke[0].summary.includes('撤销先行上线授权'), `[6-撤销] summary 含"撤销先行上线授权"，实得 ${tlRevoke[0].summary}`);
    // [组 B·SB3·LOW-3] 撤销原因（本阶段新增必填）应写入 timeline summary——与 fast_release_authorize
    //   的 note 括注范式（`${actor.name}（${note}）`）对齐。
    assert.ok(tlRevoke[0].summary.includes('验收前主动撤销'), `[6-撤销] summary 含撤销原因，实得 ${tlRevoke[0].summary}`);
    assert.strictEqual(rRevoke.body.reason, '验收前主动撤销', '[6-撤销] 响应体应回显 reason');

    // 撤销后再授权：应能成功，覆盖三件套 + revoked_at 置空
    const r3 = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: '撤销后重新授权' });
    assert.strictEqual(r3.status, 200, `[6-再授] 应 200，实得 ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.reauthorized, true, '[6-再授] reauthorized=true');
    const row3 = await fastReleaseRow(id);
    assert.strictEqual(row3.fast_release_revoked_at, null, '[6-再授] ⭐ revoked_at 已被重新授权置空');
    assert.strictEqual(row3.fast_release_consumed_at, null, '[6-再授] consumed_at 仍为 NULL');
    assert.strictEqual(row3.fast_release_auth_note, '撤销后重新授权', '[6-再授] auth_note 已覆盖');
    ok('[6] 撤销正例（revoked_at 落库+auth 三件套原样保留+timeline 一条含撤销原因+响应体回显 reason）+ 撤销后再授权成功（revoked_at 置空）');
  }

  // ══════════════════════════ [6b]（组 B·SB3·LOW-3·codex 360 遗留拍板·主会话终裁本阶段补）撤销原因必填 ══════════════════════════
  //   与 return/reopen 等 admin 逆向动作一致：撤销原因缺失/空白/超长均 400 拒绝，不静默放行成"匿名撤销"。
  {
    const id = await bugAtChulizhong();
    const authR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR.status, 200, `[6b-前置授权] 应 200，实得 ${authR.status}`);
    const before = await fastReleaseRow(id);

    // 缺失 reason 键
    const rMissing = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, {});
    assert.strictEqual(rMissing.status, 400, `[6b-缺失] 应 400，实得 ${rMissing.status} ${JSON.stringify(rMissing.body)}`);
    assert.strictEqual(rMissing.body.code, 'FAST_RELEASE_REVOKE_REASON_REQUIRED', `[6b-缺失] 确切码，实得 ${rMissing.body.code}`);
    assert.deepStrictEqual(await fastReleaseRow(id), before, '[6b-缺失] 零副作用');

    // 纯空白 reason（trim 后空）
    const rBlank = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: '   ' });
    assert.strictEqual(rBlank.status, 400, `[6b-空白] 应 400，实得 ${rBlank.status}`);
    assert.strictEqual(rBlank.body.code, 'FAST_RELEASE_REVOKE_REASON_REQUIRED', `[6b-空白] 确切码，实得 ${rBlank.body.code}`);
    assert.deepStrictEqual(await fastReleaseRow(id), before, '[6b-空白] 零副作用');

    // 非字符串类型
    const rBadType = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: 12345 });
    assert.strictEqual(rBadType.status, 400, `[6b-非字符串] 应 400，实得 ${rBadType.status}`);
    assert.strictEqual(rBadType.body.code, 'FAST_RELEASE_REVOKE_REASON_REQUIRED', `[6b-非字符串] 确切码，实得 ${rBadType.body.code}`);

    // 超长（>200 字）
    const rLong = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: 'x'.repeat(201) });
    assert.strictEqual(rLong.status, 400, `[6b-超长] 应 400，实得 ${rLong.status}`);
    assert.strictEqual(rLong.body.code, 'FAST_RELEASE_REVOKE_REASON_TOO_LONG', `[6b-超长] 确切码，实得 ${rLong.body.code}`);
    assert.deepStrictEqual(await fastReleaseRow(id), before, '[6b-超长] 零副作用');

    // 对照组：200 字恰好合法（边界不误伤）
    const rBoundary = await call('POST', `/api/sys-issues/${id}/fast-release-revoke`, adminTok, { reason: 'y'.repeat(200) });
    assert.strictEqual(rBoundary.status, 200, `[6b-边界] 200 字恰好应放行，实得 ${rBoundary.status} ${JSON.stringify(rBoundary.body)}`);
    ok('[6b] 撤销原因必填（LOW-3）：缺失/纯空白/非字符串/超 200 字均 400 FAST_RELEASE_REVOKE_REASON_REQUIRED（超长单独码 _TOO_LONG）+ 零副作用；200 字边界正确放行（对照组）');
  }

  // ══════════════════════════ [7]（预筛 MED-3 扩）撤销负例：未授权/已撤销/已消费/已上线 四因 ══════════════════════════
  //   四组共用错误码 FAST_RELEASE_REVOKE_NOT_ALLOWED（不拆分），但 error 文案须按事务内前置 SELECT 快照
  //   精判出**唯一**对应原因（deriveFastReleaseRevokeDenyReason 优先级：未授权→已撤销→已消费→已上线→兜底）。
  {
    // [7a] 未授权
    const idNoAuth = await bugAtChulizhong();
    const beforeTl = await timelineCount(idNoAuth);
    const r1 = await call('POST', `/api/sys-issues/${idNoAuth}/fast-release-revoke`, adminTok, { reason: '撤销负例-未授权' });
    assert.strictEqual(r1.status, 409, `[7a] 未授权撤销应 409，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[7a] 确切码，实得 ${r1.body.code}`);
    assert.strictEqual(r1.body.error, '当前未先行上线授权，无法撤销', `[7a] 精确原因文案，实得="${r1.body.error}"`);
    const rowNoAuth = await fastReleaseRow(idNoAuth);
    assertAllNull(rowNoAuth, '[7a-零副作用]');
    assert.strictEqual(await timelineCount(idNoAuth), beforeTl, '[7a] timeline 无新增');
    ok('[7a] 撤销负例·未授权：409 FAST_RELEASE_REVOKE_NOT_ALLOWED + 精确原因文案「当前未先行上线授权，无法撤销」+ 零副作用');

    // [7b] 已消费（SQL 造态——本阶段无真实直上端点）
    const idConsumed = await bugAtChulizhong();
    const authR = await call('POST', `/api/sys-issues/${idConsumed}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR.status, 200, `[7b-前置授权] 应 200，实得 ${authR.status}`);
    await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime') WHERE id=?`, [idConsumed]);
    const beforeTl2 = await timelineCount(idConsumed);
    const beforeRow2 = await fastReleaseRow(idConsumed);
    const r2 = await call('POST', `/api/sys-issues/${idConsumed}/fast-release-revoke`, adminTok, { reason: '撤销负例-已消费' });
    assert.strictEqual(r2.status, 409, `[7b] 已消费撤销应 409，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[7b] 确切码，实得 ${r2.body.code}`);
    assert.strictEqual(r2.body.error, '先行上线授权已被消费（已随修复直接上线），不可撤销', `[7b] 精确原因文案，实得="${r2.body.error}"`);
    const afterRow2 = await fastReleaseRow(idConsumed);
    assert.deepStrictEqual(afterRow2, beforeRow2, '[7b] 零副作用：六列未变（尤其 revoked_at 仍为 NULL，未被误打撤销戳）');
    assert.strictEqual(await timelineCount(idConsumed), beforeTl2, '[7b] timeline 无新增');
    ok('[7b] 撤销负例·已消费（SQL 造态）：409 FAST_RELEASE_REVOKE_NOT_ALLOWED + 精确原因文案「已被消费……不可撤销」+ 零副作用');

    // [7c] 已撤销（幂等提示）——真实链路：授权→撤销一次成功→再撤销一次应 409（非二次覆盖 revoked_at）
    const idRevoked = await bugAtChulizhong();
    const authR3 = await call('POST', `/api/sys-issues/${idRevoked}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR3.status, 200, `[7c-前置授权] 应 200，实得 ${authR3.status}`);
    const revokeR3 = await call('POST', `/api/sys-issues/${idRevoked}/fast-release-revoke`, adminTok, { reason: '首次撤销' });
    assert.strictEqual(revokeR3.status, 200, `[7c-前置撤销] 应 200，实得 ${revokeR3.status}`);
    const rowAfterFirstRevoke = await fastReleaseRow(idRevoked);
    const beforeTl3 = await timelineCount(idRevoked);
    const r3 = await call('POST', `/api/sys-issues/${idRevoked}/fast-release-revoke`, adminTok, { reason: '重复撤销尝试' });
    assert.strictEqual(r3.status, 409, `[7c] 重复撤销应 409，实得 ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[7c] 确切码，实得 ${r3.body.code}`);
    assert.strictEqual(r3.body.error, '先行上线授权此前已撤销（重复操作，无需再次撤销）', `[7c] 精确原因文案（幂等提示），实得="${r3.body.error}"`);
    const rowAfterSecondRevoke = await fastReleaseRow(idRevoked);
    assert.deepStrictEqual(rowAfterSecondRevoke, rowAfterFirstRevoke, '[7c] 零副作用：六列未变（尤其 revoked_at 未被第二次撤销悄悄推后）');
    assert.strictEqual(await timelineCount(idRevoked), beforeTl3, '[7c] timeline 无新增');
    ok('[7c] 撤销负例·已撤销（重复撤销）：409 FAST_RELEASE_REVOKE_NOT_ALLOWED + 精确原因文案（幂等提示）+ revoked_at 不被二次覆盖');

    // [7d]（组 B·B1 落地后改 SQL 造态）已上线不可撤——⚠️ 背景推翻：本组原用**真实链路**（处理中态先
    //   授权→estimate→submit→accept 零 commit 直翻已上线，released_at/online_source 落库但授权六列
    //   "悬垂保留"）构造"已上线但仍挂着授权"这个组合。B1 落地后，accept 的 C9 直翻分支会同事务终结
    //   掉这份从未消费的活跃授权（六列清空，见 verify-sys-fastrelease-auth.js [9]/verify-sys-fastlane-
    //   submit.js [11a] 同款推翻）——"已上线 ∧ 授权六列仍非空且未终结"这个组合，经真实状态机路径已
    //   **结构性不可达**。本组改用 SQL 造态直接构造这个（理论上）异常组合，专测撤销端点自身窗口谓词
    //   第四条（released_at/online_source 非空）在这个组合下仍正确拦下——与 B1 是否生效正交，测的是
    //   撤销端点这条既有防线本身。
    const idOnlineAuthed = await bugAtChulizhong();
    const authR4 = await call('POST', `/api/sys-issues/${idOnlineAuthed}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR4.status, 200, `[7d-前置授权] 应 200，实得 ${authR4.status}`);
    // SQL 造态：直接置入 released_at（online_source 留空亦可命中同一条 WHERE 否定条件，这里显式两列
    //   都写，贴近"已上线单"更完整的现实形态，同 verify-sys-fastrelease-auth.js [2-已上线-纵深] 范式）。
    await run(`UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), online_source = 'no_commit_acceptance' WHERE id = ?`, [idOnlineAuthed]);
    const rowAfterAuth4 = await fastReleaseRow(idOnlineAuthed);
    assert.ok(rowAfterAuth4.fast_release_auth_at, '[7d-造态] 前置：授权六列（造态前）确已落库，供下方零副作用快照比对');
    assert.strictEqual(await statusOf(idOnlineAuthed), '已上线', '[7d-造态] 应已到达已上线态');
    const beforeTl4 = await timelineCount(idOnlineAuthed);
    const r4 = await call('POST', `/api/sys-issues/${idOnlineAuthed}/fast-release-revoke`, adminTok, { reason: '撤销负例-已上线' });
    assert.strictEqual(r4.status, 409, `[7d] 已上线单撤销应 409，实得 ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[7d] 确切码，实得 ${r4.body.code}`);
    assert.strictEqual(r4.body.error, '该单已上线，先行上线授权不可撤销', `[7d] 精确原因文案，实得="${r4.body.error}"`);
    const rowAfterFail4 = await fastReleaseRow(idOnlineAuthed);
    assert.deepStrictEqual(rowAfterFail4, rowAfterAuth4, '[7d] 零副作用：六列仍与造态注入后一致（撤销失败不动这些列）');
    assert.strictEqual(await timelineCount(idOnlineAuthed), beforeTl4, '[7d] timeline 无新增（本次撤销请求本身）');
    ok('[7d] 撤销负例·已上线（真实链路悬垂授权）：409 FAST_RELEASE_REVOKE_NOT_ALLOWED + 精确原因文案「该单已上线……不可撤销」+ 零副作用');

    // [7e]（codex 360 L1）混合异常态：consumed_at 与 released_at/online_source 同时非空——§3.2 直上消费
    //   的正常结果本就是"消费的同时该单随之上线"，两个标记大概率并存。SQL 造态（§3.2 尚未实现，无法
    //   走真实链路构造这个组合，只能直连 SQL 复刻它未来的落库形态：online_source='authorized_fastlane'
    //   同方案 §3.2 字面量）。断言文案按业务优先级取"已消费"（更贴近根因），不是"已上线"。
    const idMixed = await bugAtChulizhong();
    const authR5 = await call('POST', `/api/sys-issues/${idMixed}/fast-release-authorize`, adminTok, {});
    assert.strictEqual(authR5.status, 200, `[7e-前置授权] 应 200，实得 ${authR5.status}`);
    await run(`UPDATE sys_issues SET fast_release_consumed_at = datetime('now','localtime'),
      released_at = datetime('now','localtime'), online_source = 'authorized_fastlane' WHERE id = ?`, [idMixed]);
    const beforeTl5 = await timelineCount(idMixed);
    const beforeRow5 = await fastReleaseRow(idMixed);
    const r5 = await call('POST', `/api/sys-issues/${idMixed}/fast-release-revoke`, adminTok, { reason: '撤销负例-混合异常态' });
    assert.strictEqual(r5.status, 409, `[7e] 混合异常态撤销应 409，实得 ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.code, 'FAST_RELEASE_REVOKE_NOT_ALLOWED', `[7e] 确切码，实得 ${r5.body.code}`);
    assert.strictEqual(r5.body.error, '先行上线授权已被消费（已随修复直接上线），不可撤销',
      `[7e] 混合异常态（consumed+released 同时非空）应取"已消费"文案而非"已上线"文案，实得="${r5.body.error}"`);
    const afterRow5 = await fastReleaseRow(idMixed);
    assert.deepStrictEqual(afterRow5, beforeRow5, '[7e] 零副作用：六列未变（未被误打撤销戳）');
    assert.strictEqual(await timelineCount(idMixed), beforeTl5, '[7e] timeline 无新增');
    ok('[7e] 撤销负例·混合异常态（consumed_at 与 released_at/online_source 同时非空，SQL 造态）：文案按业务优先级固定取"已消费"，不取"已上线"');

    ok('[7] 撤销负例四因+一条混合异常态（未授权/已撤销/已消费/已上线/consumed与released并存）均 409 FAST_RELEASE_REVOKE_NOT_ALLOWED，错误码单码不变，error 文案按优先级精确到唯一原因');
  }

  // ══════════════════════════ [8]（[Y5] 范式）成组约束探针 ══════════════════════════
  {
    assert.strictEqual(typeof I.fastReleaseGroupInvariantViolations, 'function', '[8-前置] fastReleaseGroupInvariantViolations 应已导出');

    // [8a] JS 纯函数单元用例表——正例（合法组合）与反例（三类违例）逐条断言
    const VALID_EMPTY = { fast_release_auth_by: null, fast_release_auth_by_name: null, fast_release_auth_at: null, fast_release_revoked_at: null, fast_release_consumed_at: null };
    const VALID_AUTHED = { fast_release_auth_by: 1, fast_release_auth_by_name: '管理员', fast_release_auth_at: '2026-08-12 10:00:00', fast_release_revoked_at: null, fast_release_consumed_at: null };
    const VALID_REVOKED = { ...VALID_AUTHED, fast_release_revoked_at: '2026-08-12 11:00:00' };
    const VALID_CONSUMED = { ...VALID_AUTHED, fast_release_consumed_at: '2026-08-12 11:00:00' };
    for (const [tag, row] of [['全空', VALID_EMPTY], ['已授权', VALID_AUTHED], ['已撤销', VALID_REVOKED], ['已消费', VALID_CONSUMED]]) {
      assert.deepStrictEqual(I.fastReleaseGroupInvariantViolations(row), [], `[8a-正例-${tag}] 应无违例，实得 ${JSON.stringify(I.fastReleaseGroupInvariantViolations(row))}`);
    }
    const PARTIAL_TRIO = { fast_release_auth_by: 1, fast_release_auth_by_name: null, fast_release_auth_at: null, fast_release_revoked_at: null, fast_release_consumed_at: null };
    assert.ok(I.fastReleaseGroupInvariantViolations(PARTIAL_TRIO).length > 0, '[8a-反例-三件套半空] 应判红');
    const REVOKE_WITHOUT_AUTH = { fast_release_auth_by: null, fast_release_auth_by_name: null, fast_release_auth_at: null, fast_release_revoked_at: '2026-08-12 11:00:00', fast_release_consumed_at: null };
    assert.ok(I.fastReleaseGroupInvariantViolations(REVOKE_WITHOUT_AUTH).length > 0, '[8a-反例-无授权却有撤销戳] 应判红');
    const REVOKE_BEFORE_AUTH = { ...VALID_AUTHED, fast_release_revoked_at: '2026-08-12 09:00:00' };   // 早于 auth_at
    assert.ok(I.fastReleaseGroupInvariantViolations(REVOKE_BEFORE_AUTH).length > 0, '[8a-反例-revoked_at<auth_at] 应判红');
    const CONSUMED_AND_REVOKED = { ...VALID_AUTHED, fast_release_revoked_at: '2026-08-12 11:00:00', fast_release_consumed_at: '2026-08-12 12:00:00' };
    assert.ok(I.fastReleaseGroupInvariantViolations(CONSUMED_AND_REVOKED).length > 0, '[8a-反例-消费且撤销同时非空] 应判红');
    ok('[8a] fastReleaseGroupInvariantViolations 纯函数用例表：4 正例全放行 + 4 反例（三件套半空/无授权有撤销戳/撤销早于授权/消费撤销并存）全判红');

    // [8b]（预筛 MED-2 重做）判据只此一份——不再手写第二份 SQL 布尔算术判据。此前 [8b]/[8c] 各自维护一份
    //   用 SQL 镜像 index.js 判据的写法，语义上"看起来一致"但实测已分歧：SQL 用 `IS NOT NULL` 判"是否
    //   存在"，JS 用三条件排空串（`!== null && !== undefined && !== ''`）——`fast_release_auth_by_name=''`
    //   这种空字符串在 JS 判据里算"缺席"（三件套只剩两件真非空 → 判违例），旧 SQL 判据对空串 `IS NOT NULL`
    //   恒真，会把它算成"三件套全在"从而漏判。这不是假设的风险，是已实证的分歧（见下方 [8b-空串] 用例）。
    //   改法：SQL 只做"候选行"粗筛（五列任一非空即入选，成本远低于全表扫描，且候选集合是判据本身
    //   `fastReleaseGroupInvariantViolations` 逻辑上能判红的行的**超集**——全空行必然判据返回空数组，
    //   排除它们不会漏检），真正的判断全部转交给 `I.fastReleaseGroupInvariantViolations`——真实库/内存
    //   库两处调用同一份实现，导出注释里"判据只此一份"的声称才真正成立。
    const FR_CANDIDATE_SQL = `SELECT id, fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at,
              fast_release_revoked_at, fast_release_consumed_at
         FROM sys_issues
        WHERE fast_release_auth_by IS NOT NULL OR fast_release_auth_by_name IS NOT NULL OR fast_release_auth_at IS NOT NULL
           OR fast_release_revoked_at IS NOT NULL OR fast_release_consumed_at IS NOT NULL`;
    const fastReleaseViolationCount = async (allFn) => {
      const rows = await allFn(FR_CANDIDATE_SQL);
      let total = 0;
      for (const row of rows) total += I.fastReleaseGroupInvariantViolations(row).length;
      return total;
    };

    // 对照组①：三件套半空（仅 fast_release_auth_by 非空）
    const inject1 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET fast_release_auth_by = 1 WHERE id = ?`, [inject1]);
    let cnt = await fastReleaseViolationCount(all);
    assert.ok(cnt > 0, `[8b-①] ★对照组：三件套半空（仅 by 非空）应判红（计数>0），实得 ${cnt}——若这条断言本身失败，说明判据链路有问题，下面对真实库的"计数=0"断言不可信`);
    ok(`[8b-①] ★对照组：三件套半空注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET fast_release_auth_by = NULL WHERE id = ?`, [inject1]);
    assert.strictEqual(await fastReleaseViolationCount(all), 0, '[8b-①] 清理注入行后应恢复 0（清理本身失败会污染后续断言）');

    // 对照组②：撤销早于授权（auth 三件套齐全，revoked_at 却早于 auth_at）——补齐此前只有①有对照的缺口
    const inject2 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET fast_release_auth_by=1, fast_release_auth_by_name='测试', fast_release_auth_at='2026-08-12 10:00:00', fast_release_revoked_at='2026-08-12 09:00:00' WHERE id = ?`, [inject2]);
    cnt = await fastReleaseViolationCount(all);
    assert.ok(cnt > 0, `[8b-②] ★对照组：revoked_at 早于 auth_at 应判红（计数>0），实得 ${cnt}`);
    ok(`[8b-②] ★对照组：撤销早于授权注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET fast_release_auth_by=NULL, fast_release_auth_by_name=NULL, fast_release_auth_at=NULL, fast_release_revoked_at=NULL WHERE id = ?`, [inject2]);
    assert.strictEqual(await fastReleaseViolationCount(all), 0, '[8b-②] 清理注入行后应恢复 0');

    // 对照组③：消费且撤销并存（auth 三件套齐全，revoked_at 与 consumed_at 同时非空）
    const inject3 = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET fast_release_auth_by=1, fast_release_auth_by_name='测试', fast_release_auth_at='2026-08-12 10:00:00', fast_release_revoked_at='2026-08-12 11:00:00', fast_release_consumed_at='2026-08-12 12:00:00' WHERE id = ?`, [inject3]);
    cnt = await fastReleaseViolationCount(all);
    assert.ok(cnt > 0, `[8b-③] ★对照组：消费且撤销并存应判红（计数>0），实得 ${cnt}`);
    ok(`[8b-③] ★对照组：消费撤销并存注入后判据正确判红（计数=${cnt}）`);
    await run(`UPDATE sys_issues SET fast_release_auth_by=NULL, fast_release_auth_by_name=NULL, fast_release_auth_at=NULL, fast_release_revoked_at=NULL, fast_release_consumed_at=NULL WHERE id = ?`, [inject3]);
    assert.strictEqual(await fastReleaseViolationCount(all), 0, '[8b-③] 清理注入行后应恢复 0');

    // [8b-空串] 已实证的空串分歧专项：by_name='' 时三件套其余两件（by/auth_at）非空——JS 判据应判红
    //   （旧 SQL-only 判据会因 `IS NOT NULL` 对空串恒真而漏检，这条正是 MED-2 修复要消灭的那个分歧）。
    const injectEmpty = await mkIssue('bug', {});
    await run(`UPDATE sys_issues SET fast_release_auth_by=1, fast_release_auth_by_name='', fast_release_auth_at='2026-08-12 10:00:00' WHERE id = ?`, [injectEmpty]);
    cnt = await fastReleaseViolationCount(all);
    assert.ok(cnt > 0, `[8b-空串] ★对照组：fast_release_auth_by_name='' 应判红（三件套里空串算缺席），实得 ${cnt}——若为 0 说明判据又退化回"IS NOT NULL"式漏检`);
    ok(`[8b-空串] ★对照组：by_name 空串注入后判据正确判红（计数=${cnt}），证明"JS判红/SQL漏检"分歧已消失（判据只此一份，天然继承 JS 排空串语义）`);
    await run(`UPDATE sys_issues SET fast_release_auth_by=NULL, fast_release_auth_by_name=NULL, fast_release_auth_at=NULL WHERE id = ?`, [injectEmpty]);
    assert.strictEqual(await fastReleaseViolationCount(all), 0, '[8b-空串] 清理注入行后应恢复 0');

    // [8c] 真实本地库（task_pool.db）——独立只读连接，用完即关；同一套候选行 SQL 粗筛 + I.fastReleaseGroupInvariantViolations 精判
    let y8EnvSkipped = false;
    const realDbPath = path.join(__dirname, '..', 'task_pool.db');
    if (fs.existsSync(realDbPath)) {
      const realDb = new sqlite3.Database(realDbPath, sqlite3.OPEN_READONLY);
      const realAll = (sql) => new Promise((resolve, reject) => realDb.all(sql, (e, r) => e ? reject(e) : resolve(r)));
      // [codex 360 L2] 列存在检查改六列全集合——原实现只抽查 fast_release_auth_by 一列当"迁移是否已跑"
      //   的代表，若某次生产迁移意外中断在六列 ALTER 序列中途（KEY_COLS「整组入锚」正是为了防这种半成品
      //   态），旧检查会误把"部分迁移"当成"迁移已完成"直接放行真实断言，撞 no such column 崩溃报错，
      //   而不是给出"到底缺哪几列"的干净诊断。改为三态判断：
      //   ① 六列全在 → 正常走真实探针断言；
      //   ② 六列全不在 → 环境相关的正常跳过（服务从未启动过完成本次 ALTER，同旧行为）；
      //   ③ 部分在部分不在 → 硬 fail 并列出缺失列——这不是"尚未迁移"，是迁移中途中断的异常态，
      //   不该被静默当成环境跳过放过去，需要人工核查该库的迁移历史。
      const realCols = (await realAll(`PRAGMA table_info(sys_issues)`)).map(c => c.name);
      const presentCols = FAST_RELEASE_SIX_COLS.filter(c => realCols.includes(c));
      const missingCols = FAST_RELEASE_SIX_COLS.filter(c => !realCols.includes(c));
      if (missingCols.length === 0) {
        const realCandidates = await realAll(FR_CANDIDATE_SQL);
        const realViolations = realCandidates.reduce((sum, row) => sum + I.fastReleaseGroupInvariantViolations(row).length, 0);
        assert.strictEqual(realViolations, 0,
          `[8c] ⭐⭐ 真实本地库 sys_issues 先行上线授权字段组违例计数应为 0（候选行 ${realCandidates.length} 条，逐行喂 fastReleaseGroupInvariantViolations），实得 ${realViolations}`);
        ok(`[8c] ⭐⭐ 真实本地库（task_pool.db）先行上线授权字段组探针：六列全在 + 候选行 ${realCandidates.length} 条，违例计数=0（判据=I.fastReleaseGroupInvariantViolations，与写点同一份实现）`);
      } else if (presentCols.length === 0) {
        y8EnvSkipped = true;
        console.log('  ⚠️ [8c]（跳过真实库断言：fast_release_* 六列均不存在，服务从未启动过完成本次 ALTER）');
      } else {
        fail(`[8c] 真实本地库 sys_issues 处于 fast_release_* 部分迁移态——${presentCols.length}/6 列存在（${JSON.stringify(presentCols)}），缺失 ${JSON.stringify(missingCols)}。KEY_COLS 整组入锚意图下不应出现半成品态，须人工核查该库的迁移历史（是否有进程在 alterAddMissingCols [1a-14] 六条 ALTER 执行到一半时被中断）。`);
      }
      await new Promise((resolve) => realDb.close(resolve));
    } else {
      y8EnvSkipped = true;
      console.log('  ⚠️ [8c]（跳过真实库断言：本地未找到 task_pool.db）');
    }
    if (y8EnvSkipped) global.__Y8_ENV_SKIPPED__ = true;
  }

  // ══════════════════════════ [9]（组 B·B1·授权终结事件制·2026-08-13 用户 P7 终裁改写）accept 直翻已上线
  //   终结活跃授权 + reopen 不复活 ══════════════════════════════════════════════════════════════
  //   ⚠️ 本组断言在 B1 之前钉的是"reopen 不动授权字段"（那时六列会一路带着活跃标记漂过 accept/close/
  //   reopen 全程）——B1 落地后这条前提已被推翻：accept 的 C9 直翻分支（本单零 commit）会命中事件①
  //   「上线翻牌」，同事务终结掉这份从未被消费的活跃授权。真实链路（授权→estimate→submit→accept 直翻
  //   已上线→close→reopen）现在验证的是新行为：accept 后六列清空 + 一条终结留痕；close/reopen 不会
  //   让六列"复活"（reopen 自身的清空清单从未包含 fast_release_*，见既有注释，此处验证的是"reopen
  //   不会意外把已清空的六列写回任何非空值"，这条断言仍有意义，非退化为纯粹的重复 NULL 比对）。
  {
    const id = await bugAtChulizhong();
    const authR = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: 'B1 终结断言夹具' });
    assert.strictEqual(authR.status, 200, `[9-授权] 应 200，实得 ${authR.status}`);
    const rowAfterAuth = await fastReleaseRow(id);
    assert.ok(rowAfterAuth.fast_release_auth_at, '[9-授权] auth_at 已落库');

    // estimate（assignee=dev5 本人；GATE 降级同 verify-sys-c9-direct-online 既有手法：对接人失效走§3.0-⑥ 降级，submit 直落待验证）
    const futureEst = (() => { const d = new Date(Date.now() + 30 * 86400000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })();
    const estR = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst });
    assert.strictEqual(estR.status, 200, `[9-estimate] 应 200，实得 ${estR.status} ${JSON.stringify(estR.body)}`);
    await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);

    const submitR = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
      mode: 'no_code', no_code_reason: 'verify 夹具：无提交交付（B1 终结断言用）', self_tested: true, test_env_deployed: true,
      bug_cause_note: 'verify 夹具：bug 产生原因（B1 终结断言用）',
    });
    assert.strictEqual(submitR.status, 200, `[9-submit] 应 200，实得 ${submitR.status} ${JSON.stringify(submitR.body)}`);
    assert.strictEqual(submitR.body.main_status, '待验证', `[9-submit] 应落待验证，实得 ${submitR.body.main_status}`);

    // [修正] beforeAcceptTl 须紧邻 accept 调用之前取快照——estimate 自身写 1 条 'estimate' timeline 行，
    //   no_code submit 触发 runWGate 全完成态推进另写 1 条 W-GATE 镜像行（处理中→待验证），若在这两步
    //   之前取快照会把它们也算进"accept 产生的增量"，误判 timeline 计数（本条系 verify 自身踩坑修正，
    //   非实现问题——首跑曾错误期望 beforeAcceptTl+2，实得 beforeAcceptTl+4，因快照点过早）。
    const beforeAcceptTl = await timelineCount(id);
    const acceptR = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(acceptR.status, 200, `[9-accept] 应 200，实得 ${acceptR.status} ${JSON.stringify(acceptR.body)}`);
    assert.strictEqual(acceptR.body.status, '已上线', `[9-accept] 零 commit 应直翻已上线，实得 ${acceptR.body.status}`);
    assert.strictEqual(await statusOf(id), '已上线', '[9-accept] 落库 status=已上线');

    // [B1 新行为] accept 的 C9 直翻分支命中事件①「上线翻牌」——本单授权此前活跃且从未消费（没走
    //   direct_release=true 的 SB2 消费路径），同事务终结：六列清空 + 一条 fast_release_auth_terminated
    //   timeline 留痕行。
    const rowAfterAccept = await fastReleaseRow(id);
    assertAllNull(rowAfterAccept, '[9-accept 后] ⭐⭐ B1 事件①命中：六列应被同事务清空（此前 B1 之前的旧断言曾钉"六列在 accept 后仍与授权时一致"，现推翻）');
    const terminatedTl = await fastReleaseTlRows(id, 'fast_release_auth_terminated');
    assert.strictEqual(terminatedTl.length, 1, `[9-accept 后] 应恰新增 1 条 action_code=fast_release_auth_terminated 的 timeline 行，实得 ${terminatedTl.length}`);
    assert.strictEqual(terminatedTl[0].event_type, 'note', '[9-accept 后] 终结行 event_type=note');
    assert.strictEqual(terminatedTl[0].summary, '直上授权已失效（上线翻牌）', `[9-accept 后] 终结行 summary 精确文案，实得="${terminatedTl[0].summary}"`);
    assert.strictEqual(await timelineCount(id), beforeAcceptTl + 2, '[9-accept 后] timeline 恰新增 2 条（accept 主流转行 + 终结留痕行）');

    const closeR = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(closeR.status, 200, `[9-close] 应 200，实得 ${closeR.status} ${JSON.stringify(closeR.body)}`);
    assert.strictEqual(await statusOf(id), '已关闭', '[9-close] 落库 status=已关闭');

    const beforeReopen = await fastReleaseRow(id);
    assertAllNull(beforeReopen, '[9-reopen 前置] 走完 close，六列仍保持 accept 终结后的清空态（close 未意外写回任何值）');

    const reopenR = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '验收后发现遗漏场景，需重开' });
    assert.strictEqual(reopenR.status, 200, `[9-reopen] 应 200，实得 ${reopenR.status} ${JSON.stringify(reopenR.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '[9-reopen] 落库 status=处理中（bug reopen 落态）');

    const afterReopen = await fastReleaseRow(id);
    assertAllNull(afterReopen, '[9-reopen] ⭐⭐ reopen 不复活已终结的授权：六列仍全 NULL（reopen 的清空清单从未包含 fast_release_*，本条验证的是"reopen 不会意外写回任何非空值"，非退化的重复空值比对）');
    ok('[9] B1 事件①（上线翻牌）覆盖真实链路：授权→estimate→submit→accept 直翻已上线，accept 同事务终结活跃授权（六列清空+1条留痕行）；close/reopen 均不复活六列');
  }

  // ══════════════════════════ [10] note 边界：trim / 200 上限 / 超长 / 非字符串 ══════════════════════════
  {
    // 空白视同未填
    const idBlank = await bugAtChulizhong();
    const rBlank = await call('POST', `/api/sys-issues/${idBlank}/fast-release-authorize`, adminTok, { note: '   ' });
    assert.strictEqual(rBlank.status, 200, `[10-空白] 应 200，实得 ${rBlank.status}`);
    const rowBlank = await fastReleaseRow(idBlank);
    assert.strictEqual(rowBlank.fast_release_auth_note, null, '[10-空白] note 为纯空白 → 落库 NULL（trim 后判空，非原样存空白）');

    // 恰 200 字放行
    const idExact = await bugAtChulizhong();
    const note200 = '备'.repeat(200);
    const rExact = await call('POST', `/api/sys-issues/${idExact}/fast-release-authorize`, adminTok, { note: note200 });
    assert.strictEqual(rExact.status, 200, `[10-200字] 应 200，实得 ${rExact.status} ${JSON.stringify(rExact.body)}`);
    const rowExact = await fastReleaseRow(idExact);
    assert.strictEqual(rowExact.fast_release_auth_note, note200, '[10-200字] 恰 200 字原样落库');

    // 201 字拒绝，零副作用
    const idOver = await bugAtChulizhong();
    const note201 = '备'.repeat(201);
    const rOver = await call('POST', `/api/sys-issues/${idOver}/fast-release-authorize`, adminTok, { note: note201 });
    assert.strictEqual(rOver.status, 400, `[10-201字] 应 400，实得 ${rOver.status} ${JSON.stringify(rOver.body)}`);
    assert.strictEqual(rOver.body.code, 'FAST_RELEASE_NOTE_TOO_LONG', `[10-201字] 确切码，实得 ${rOver.body.code}`);
    const rowOver = await fastReleaseRow(idOver);
    assertAllNull(rowOver, '[10-201字-零副作用]');

    // 非字符串拒绝
    const idBad = await bugAtChulizhong();
    const rBad = await call('POST', `/api/sys-issues/${idBad}/fast-release-authorize`, adminTok, { note: 123 });
    assert.strictEqual(rBad.status, 400, `[10-非字符串] 应 400，实得 ${rBad.status} ${JSON.stringify(rBad.body)}`);
    assert.strictEqual(rBad.body.code, 'FAST_RELEASE_NOTE_INVALID', `[10-非字符串] 确切码，实得 ${rBad.body.code}`);
    const rowBad = await fastReleaseRow(idBad);
    assertAllNull(rowBad, '[10-非字符串-零副作用]');

    ok('[10] note 边界：纯空白落 NULL / 恰 200 字放行原样落库 / 201 字 400 零副作用 / 非字符串 400 零副作用');
  }

  // ══════════════════ [11] 部署闸成对用例（fastlaneAuthorizeEnabled 注入开关·2026-08-13 部署闸）══════════════════
  //   本套件全程未传该 deps 字段=缺省启用（上方 [1]-[10] 全部 200/业务码即是"启用方向"的活体证明）；
  //   此处补"禁用方向"：显式注入 false 的第二个模块实例（共享同一内存库，schema init 幂等），授权应
  //   403 FAST_RELEASE_FEATURE_DISABLED 且零副作用——生产不设 SYS_FASTLANE_ENABLE 时用户看到的正是这条。
  //   撤销端点不受闸（fail-open 于清理面，见 index.js 端点注释）也一并钉住。
  {
    // 禁用实例走**子进程探针**（scripts/_probe-fastlane-gate-disabled.js）：工厂在同一进程内二次实例化
    //   会 init 挂起（进程级单例状态·测试基建限制，同库/换库均复现，非产品缺陷）；干净进程单实例=与
    //   全部 verify 套件同构的已证可行路径。探针只采集事实回传 JSON，断言留在本套件。
    //   闸门在 id 校验之前生效 ⇒ 空库不存在的 id 也应 403 FEATURE_DISABLED（顺带钉住闸门次序）。
    const { execFileSync } = require('child_process');
    const probeOut = execFileSync(process.execPath, [path.join(__dirname, '_probe-fastlane-gate-disabled.js')], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    });
    const probe = JSON.parse(probeOut);
    assert.strictEqual(probe.authorize.status, 403, `[11] 禁用实例授权应 403（且优先于 id 校验的 400），实得 ${probe.authorize.status} ${JSON.stringify(probe.authorize.body)}`);
    assert.strictEqual(probe.authorize.body.code, 'FAST_RELEASE_FEATURE_DISABLED', `[11] 确切码，实得 ${probe.authorize.body.code}`);
    assert.ok(/暂未启用/.test(probe.authorize.body.error || ''), `[11] 文案应含"暂未启用"，实得="${probe.authorize.body.error}"`);
    // 对照组：同一禁用实例上，撤销端点不受闸——同一个不存在 id 应走常规业务校验（≠403 功能禁用码），
    //   证明闸只锁增量面（授权），清理面（撤销）fail-open。
    //   [S1·先行上线授权超时收回] 期望码由 400 REASON_REQUIRED 改为 404 SYS_ISSUE_NOT_FOUND——419/420
    //   收口把 reason 三段校验从端点头部移到事务内五格分流之后（仅格 2/格 5 执行），分流本身需要先
    //   SELECT 到行才能判格，故不存在的 id 现在会先撞 404（比旧版"先查 reason 缺失"更准确地反映"这个
    //   id 压根不存在"这一事实，非本次改动引入的缺陷；本条只关心"不是 403 功能禁用码"这一真实测试意图）。
    assert.strictEqual(probe.revoke.status, 404, `[11-撤销不受闸] 应 404 常规 id 存在性校验（不存在的 id 先于 reason 校验被发现），实得 ${probe.revoke.status} ${JSON.stringify(probe.revoke.body)}`);
    assert.strictEqual(probe.revoke.body.code, 'SYS_ISSUE_NOT_FOUND', `[11-撤销不受闸] 确切码，实得 ${probe.revoke.body.code}`);
    assert.notStrictEqual(probe.revoke.body.code, 'FAST_RELEASE_FEATURE_DISABLED', '[11-撤销不受闸] 不得返回功能禁用码（清理面 fail-open）');
    ok('[11] 部署闸成对用例（子进程探针）：注入 false→授权 403 FAST_RELEASE_FEATURE_DISABLED（优先于 id 校验）+文案；缺省(未注入)=启用由 [1]-[10] 全程活体证明；撤销端点同 id 走常规 404 证明清理面 fail-open');
  }

  server.close();
  console.log(`\n✅ verify-sys-fastrelease-auth 全绿：${passed} 组断言通过`);
  console.log('  覆盖：schema 六列就绪 + 授权正例(待处理/处理中)+详情投影 + 窗口负例五态(含已上线E2E+SQL造态纵深) + 非bug类型409 + 权限负例403 + ' +
    '重新授权(consumed置空+timeline两条历史) + 撤销正例+撤销后再授权 + 撤销负例四因(未授权/已撤销幂等/已消费/已上线，精确原因文案+单码) + ' +
    '成组约束探针([Y5]范式·判据只此一份：纯函数用例表含空串反例+候选行SQL粗筛→JS判据精判 内存注入对照①②③+空串专项+真实库) + reopen不动授权字段(真实链路) + note边界四态');
  if (global.__Y8_ENV_SKIPPED__) {
    console.log('  ⚠️ 注意：[8c] 真实本地库（task_pool.db）先行上线授权字段组探针本次未执行（环境相关——本地无 task_pool.db 或列尚未就绪），以上"全部通过"不含这半条覆盖，请勿据此断言真实库已验收。');
  }
}

main().catch(e => { console.error('❌ verify-sys-fastrelease-auth 失败:', e && e.stack || e); process.exit(1); });
