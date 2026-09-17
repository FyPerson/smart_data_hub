// scripts/verify-sys-perdev-done.js — 「开发逐人完成」时间线真实行验收（长任务B·S3-B）
//   SSOT = docs/local/系统迭代/时间线逐人完成事件_方案_20260916_v1.1.md §3 D8/D9/D10、§4 A1/A5、C3 不变量表
//   用法：直接 `node scripts/verify-sys-perdev-done.js`
//
// in-process app + 内存库 + 自签 token，同 verify-sys-submit-withdraw.js 范式（同一夹具风格，故意不
// 抽公共模块——两文件各自独立可读、可单独跑，避免夹具耦合导致改一处波及另一处）。
'use strict';

process.env.SYS_TEST_HOOKS = '1';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-perdev-done-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// [B6a 故障注入] 同 verify-sys-submit-withdraw.js 既有范式（该文件 :27-58 一带）——临时替换 db.run，
// 让匹配的 SQL 第 N 次出现时在真正执行前失败，且不改动任何生产代码。返回 { result, injected }，
// injected 显式告知调用方注入是否真的命中过，防止匹配条件写错导致"根本没触发注入，端点因别的原因
// 失败"的假通过。finally 无条件复原 db.run，防某个用例异常时驱动层被永久污染。
async function withInjectedDbRunFailure(matcher, fn, occurrence = 1) {
  const test = typeof matcher === 'function' ? matcher : (sql) => typeof sql === 'string' && sql.includes(matcher);
  const originalRun = db.run.bind(db);
  let seen = 0;
  let injected = false;
  db.run = function (sql, params, cb) {
    if (!injected && test(sql, params)) {
      seen++;
      if (seen === occurrence) {
        injected = true;
        return cb(new Error('INJECTED_TEST_FAILURE: ' + (typeof matcher === 'string' ? matcher : `occurrence#${occurrence}`)));
      }
    }
    return originalRun(sql, params, cb);
  };
  let result;
  try {
    result = await fn();
  } finally {
    db.run = originalRun;
  }
  return { result, injected };
}

// [codex 589 MED-3 补充] CAS UPDATE 语句 this.changes 强制为 0（不真的执行 SQL），用于证明 409
// INVALID_STATUS 确实来自 §6.2 步骤3 那条"双条件 WHERE + changes 检查"CAS 语句本身，而不是别的
// 前置校验层——同 sqlite3 db.run 回调约定：`function (err) { ... this.lastID/this.changes ... }`，
// 拦截匹配语句时不调用真正的驱动，直接以 `this.changes=0` 形态回调，模拟"WHERE 条件命中 0 行"。
// matcher 必须同时限定表名+关键字段（非仅列序列），避免误命中同表其它 UPDATE 语句。
async function withInjectedDbRunZeroChanges(matcher, fn) {
  const test = typeof matcher === 'function' ? matcher : (sql) => typeof sql === 'string' && sql.includes(matcher);
  const originalRun = db.run.bind(db);
  let injected = false;
  db.run = function (sql, params, cb) {
    if (!injected && test(sql, params)) {
      injected = true;
      return cb.call({ changes: 0, lastID: undefined }, null);
    }
    return originalRun(sql, params, cb);
  };
  let result;
  try {
    result = await fn();
  } finally {
    db.run = originalRun;
  }
  return { result, injected };
}

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
const devTok = (id, name) => jwt.sign({ id, username: 'dev' + id, display_name: name || ('开发' + id), role: 'user' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'liaison13', display_name: '示例对接人', role: 'user' }, SECRET);

// [codex 589 MED-4] B6b 真实场景一次性开关——submit 端点 sysCommit() 之后唯一剩下的动作就是
// res.json(...)（index.js :11006-11013），本开关让**下一次**命中 POST .../submit 的请求在真正调用
// res.json 时抛一次错，模拟"数据已提交、响应组装阶段失败"这一真实故障面（不是伪造事务内失败）。
let sabotageNextSubmitResJson = false;
// [长任务B S4c3·codex 591-R M7] "COMMIT 早于 res.json 抛错"此前只靠"独立读能读到已提交数据"这一间接
// 推断——同连接/新查询能读到数据，只证明"写入发生在读取之前"，不直接证明"写入发生在 res.json 抛错
// 之前"（两者理论上都可能发生在 res.json 抛错之后，只是恰好先于我们后续的独立读）。改成一次性序号
// 计数器直接钉住两个事件各自的发生顺位：sysCommit() 真正执行的 COMMIT 语句成功回调时记一个顺位号，
// res.json 抛错前也记一个顺位号，事后比较顺位号大小，才是"顺序"本身的直接证据。
let __b6bOrderSeq = 0;
let __b6bResJsonThrowSeq = null;
// 临时包一层 db.run，只在传入的 fn() 执行期间生效（同 withInjectedDbRunFailure 范式），拦截字面量
// 'COMMIT' 语句——sysCommit() 内部固定调用 `dbRunAsync('COMMIT')`（routes/sys-iteration/index.js :3348），
// 无参数、无变体写法，字面量比对足够精确，不会误命中其它语句。只在回调 err 为空（真正提交成功）时
// 才记顺位，避免把"COMMIT 语句被发起但失败"误记成"已提交"。
async function withCommitOrderTracking(fn) {
  const originalRun = db.run.bind(db);
  let commitSeq = null;
  db.run = function (sql, params, cb) {
    if (sql === 'COMMIT') {
      return originalRun(sql, params, function (e) {
        if (!e) commitSeq = ++__b6bOrderSeq;
        return cb.apply(this, arguments);
      });
    }
    return originalRun(sql, params, cb);
  };
  let result;
  try {
    result = await fn();
  } finally {
    db.run = originalRun;
  }
  return { result, commitSeq: () => commitSeq };
}
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
const failDetails = [];
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function must(cond, msg) {
  if (cond) { ok(msg); } else { console.log('  ✗ ' + msg); failDetails.push(msg); }
  return cond;
}

function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 夹具（同 verify-sys-submit-withdraw.js 范式）──────────────────────────────────────
async function mkIssue(type, status, extra = {}) {
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, estimated_effort_days, intake_liaison_id)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?, 13)`,
    [type, status, extra.title || `${type}-${status}-perdev`, est, effort]
  );
  return r.lastID;
}
async function mkPending(issueId, userId, userName) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
    [issueId, userId, userName]
  );
  return r.lastID;
}
async function memberRowOf(daId) {
  return get(`SELECT * FROM sys_issue_dev_assignees WHERE id=?`, [daId]);
}
// [codex 589 MED-3] issue 级 status 只读——四组注入用例各自断言事务失败/CAS 拒绝后主状态未被牵动。
async function issueStatusOf(issueId) {
  return (await get(`SELECT status FROM sys_issues WHERE id=?`, [issueId])).status;
}
async function perDevRowsOf(issueId) {
  return all(`SELECT id, event_type, action_code, ref_id, round_no, operator_id, operator_name, payload_json FROM sys_issue_timeline WHERE issue_id=? AND action_code IN ('dev_submit_done','dev_no_code') ORDER BY id`, [issueId]);
}
async function timelineAllRows(issueId) {
  return all(`SELECT id, event_type, action_code FROM sys_issue_timeline WHERE issue_id=? ORDER BY id`, [issueId]);
}
// bug 单必填「产生原因」（B4/C6 既有不变量，非本次范围但夹具须过闸）——issueType 由调用方传入，
// 仅 'bug' 类型自动补 bug_cause_note，其余类型不携带（同 submit 端点既有校验，携带即 400）。
async function submitCommits(issueId, tok, extra = {}) {
  const body = { mode: 'commits', commits: extra.commits || [{ component: 'backend', commit_ref: extra.ref || `svn-${issueId}-x` }], self_tested: true, test_env_deployed: true };
  if (extra.issueType === 'bug') body.bug_cause_note = extra.bugCauseNote || 'verify 夹具：bug 产生原因';
  return call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
}
async function submitNoCode(issueId, tok, reason, extra = {}) {
  const body = { mode: 'no_code', no_code_reason: reason || 'verify 夹具：无代码交付说明', self_tested: true, test_env_deployed: true };
  if (extra.issueType === 'bug') body.bug_cause_note = extra.bugCauseNote || 'verify 夹具：bug 产生原因';
  return call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev5','开发甲','user','13800000005'),
    (6,'dev6','开发乙','user','13800000006'),(13,'liaison13','示例对接人','user','19900000024')`);
  await new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    // [codex 589 MED-4] 一次性 res.json 故障注入中间件——先于 mod.router 挂载，命中开关时把 res.json
    // 换成"第一次调用即抛错、随即自我复原为原生 res.json"的形态，供 sendSysTransitionError 兜底分支
    // 真实调用一次原生 res.json 完成 500 响应（不会无限递归抛错）。
    app.use((req, res, next) => {
      if (sabotageNextSubmitResJson && req.method === 'POST' && /\/sys-issues\/\d+\/submit$/.test(req.path)) {
        sabotageNextSubmitResJson = false;
        const origJson = res.json.bind(res);
        let calls = 0;
        res.json = function (body) {
          calls++;
          if (calls === 1) {
            res.json = origJson;
            // [S4c3·M7] 抛错前记顺位——与 withCommitOrderTracking 记的 COMMIT 顺位比较大小，直接证明
            // 顺序（而非事后靠独立读能读到数据去推断顺序）。
            __b6bResJsonThrowSeq = ++__b6bOrderSeq;
            throw new Error('INJECTED_RES_JSON_FAILURE (post-commit, MED-4 B6b)');
          }
          return origJson(body);
        };
      }
      next();
    });
    app.use('/api', mod.router);
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // [C1] 成功提交恰一条逐人行；payload 六键（no_code）/五键（code_submitted）逐字等于期望；mode 与
  //   action_code 配对；ref_id=成员 id
  // ══════════════════════════════════════════════════════════════════════
  {
    // 单人 bug：commits 提交
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const r = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c1-1', issueType: 'bug' });
    must(r.status === 200, `[C1·单人 bug] 提交应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await perDevRowsOf(issueId);
    must(rows.length === 1, `[C1·单人 bug] 逐人行恰 1 条，实得 ${rows.length}`);
    const row = rows[0];
    must(row.event_type === 'note' && row.action_code === 'dev_submit_done', `[C1·单人 bug] event_type/action_code 配对正确，实得 ${row.event_type}/${row.action_code}`);
    must(row.ref_id === daId, `[C1·单人 bug] ref_id=成员 id(${daId})，实得 ${row.ref_id}`);
    // [MED-5] 契约列补齐：operator_id/operator_name（提交者本人，非 admin 代提）+ round_no（成员行
    // 建单时未写该列，默认 NULL，逐人行须透传同值）
    must(row.operator_id === 5 && row.operator_name === '开发甲', `[C1·单人 bug] operator_id/operator_name=提交者本人(5/开发甲)，实得 ${row.operator_id}/${row.operator_name}`);
    must(row.round_no === null, `[C1·单人 bug] 成员行 round_no 为 NULL 时逐人行 round_no 应透传为 NULL，实得 ${row.round_no}`);
    const payload = JSON.parse(row.payload_json);
    must(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['dev_assignee_id', 'dev_user_id', 'dev_user_name', 'mode', 'submitted_at']),
      `[C1·单人 bug] payload 恰五键（code_submitted 不含 no_code_reason），实得 ${JSON.stringify(Object.keys(payload).sort())}`);
    must(payload.mode === 'code_submitted', `[C1·单人 bug] payload.mode=code_submitted，实得 ${payload.mode}`);
    must(payload.dev_user_id === 5 && payload.dev_user_name === '开发甲' && payload.dev_assignee_id === daId, `[C1·单人 bug] payload 三键值核对`);
  }
  {
    // [MED-5] round_no 透传——非 NULL 场景：直接 UPDATE 成员行 round_no 后提交，逐人行须同值。
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    await run(`UPDATE sys_issue_dev_assignees SET round_no=? WHERE id=?`, [3, daId]);
    const r = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c1-round-no', issueType: 'bug' });
    must(r.status === 200, `[C1·round_no 透传] 提交应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await perDevRowsOf(issueId);
    must(rows.length === 1 && rows[0].round_no === 3, `[C1·round_no 透传] 成员行 round_no=3 时逐人行应透传为 3，实得 ${rows[0] && rows[0].round_no}`);
  }
  {
    // 多人 feature：A commits + B no_code（最后一人）
    const issueId = await mkIssue('feature', '开发中', { effortDays: 2 });
    const daA = await mkPending(issueId, 5, '开发甲');
    const daB = await mkPending(issueId, 6, '开发乙');
    const rA = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c1-2a' });
    must(rA.status === 200, `[C1·多人 feature] A 提交应 200，实得 ${rA.status} ${JSON.stringify(rA.body)}`);
    // [LOW-8/C9 收紧] 记录 B 提交前的 timeline MAX(id)，供下方 C9 按"提交前基线之后新增了哪些行"
    // 精确圈定，而非只断言"之后至少还有 1 条"（那种写法连"新增了 10 条杂项行"都能判绿）。
    const maxIdBeforeB = (await get(`SELECT COALESCE(MAX(id), 0) AS m FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).m;
    const rB = await submitNoCode(issueId, devTok(6, '开发乙'), 'C1 夹具：B 无代码交付');
    must(rB.status === 200, `[C1·多人 feature] B（最后一人）提交应 200，实得 ${rB.status} ${JSON.stringify(rB.body)}`);
    const rows = await perDevRowsOf(issueId);
    must(rows.length === 2, `[C1·多人 feature] 两人各一条逐人行，实得 ${rows.length}`);
    const rowB = rows.find(x => x.ref_id === daB);
    must(rowB.action_code === 'dev_no_code', `[C1·多人 feature] B action_code=dev_no_code，实得 ${rowB.action_code}`);
    const payloadB = JSON.parse(rowB.payload_json);
    must(JSON.stringify(Object.keys(payloadB).sort()) === JSON.stringify(['dev_assignee_id', 'dev_user_id', 'dev_user_name', 'mode', 'no_code_reason', 'submitted_at']),
      `[C1·多人 feature] B payload 恰六键（no_code 含 no_code_reason），实得 ${JSON.stringify(Object.keys(payloadB).sort())}`);
    must(payloadB.mode === 'no_code' && payloadB.no_code_reason === 'C1 夹具：B 无代码交付', `[C1·多人 feature] B payload.mode/no_code_reason 核对`);
    const rowA = rows.find(x => x.ref_id === daA);
    must(rowA.action_code === 'dev_submit_done', `[C1·多人 feature] A action_code=dev_submit_done，实得 ${rowA.action_code}`);

    // ══════════════════════════════════════════════════════════════════
    // [C2] submitted_at 与成员行 resolved_at 逐值相等
    // ══════════════════════════════════════════════════════════════════
    const memberA = await memberRowOf(daA);
    const memberB = await memberRowOf(daB);
    must(JSON.parse(rowA.payload_json).submitted_at === memberA.resolved_at, `[C2] A submitted_at 与成员 resolved_at 相等，payload=${JSON.parse(rowA.payload_json).submitted_at} member=${memberA.resolved_at}`);
    must(payloadB.submitted_at === memberB.resolved_at, `[C2] B submitted_at 与成员 resolved_at 相等，payload=${payloadB.submitted_at} member=${memberB.resolved_at}`);

    // ══════════════════════════════════════════════════════════════════
    // [C9·收紧] 按提交前 MAX(id) 基线圈定 B 本次提交新增的行：逐人行恰 1、event_type='status_change'
    // 流转行恰 1、且前者 id < 后者（同 verify-sys-fast-release.js [5] 已升级范式：数总数而非只断言
    // "存在至少 1 条"，避免"多写了别的行"这类回归被"至少 1 条"式断言放过）。
    // ══════════════════════════════════════════════════════════════════
    const newRowsAfterB = (await all(`SELECT id, event_type, action_code FROM sys_issue_timeline WHERE issue_id=? AND id > ? ORDER BY id`, [issueId, maxIdBeforeB]));
    const newPerDevRows = newRowsAfterB.filter(x => x.action_code === 'dev_no_code' || x.action_code === 'dev_submit_done');
    const newStatusChangeRows = newRowsAfterB.filter(x => x.event_type === 'status_change');
    must(newPerDevRows.length === 1, `[C9] B 本次提交新增的逐人行恰 1 条，实得 ${newPerDevRows.length}（新增行全集=${JSON.stringify(newRowsAfterB)}）`);
    must(newStatusChangeRows.length === 1, `[C9] B（最后一人）本次提交新增的整单流转行（event_type='status_change'）恰 1 条，实得 ${newStatusChangeRows.length}`);
    must(newPerDevRows.length === 1 && newStatusChangeRows.length === 1 && newPerDevRows[0].id < newStatusChangeRows[0].id,
      `[C9] 逐人行 id(${newPerDevRows[0] && newPerDevRows[0].id}) 应小于整单流转行 id(${newStatusChangeRows[0] && newStatusChangeRows[0].id})`);
    // [codex 589 LOW-1] 收紧到"总数恰 2 条、逐行精确断言"——原判据只分别数了两个子集的条数，未排除
    // "新增了第三条杂项行、两个子集各自仍恰 1 条"这类漏检（子集过滤不覆盖全集时天然看不见多余行）。
    must(newRowsAfterB.length === 2, `[C9·LOW-1] B 本次提交新增的 timeline 行总数应恰 2 条（逐人行 1 + 整单流转行 1，不多不少），实得 ${newRowsAfterB.length}（全集=${JSON.stringify(newRowsAfterB)}）`);
    must(newRowsAfterB.length === 2 && newRowsAfterB[0].event_type === 'note' && newRowsAfterB[0].action_code === 'dev_no_code',
      `[codex 589 LOW-1] 新增第 1 行应精确为 event_type='note' ∧ action_code='dev_no_code'（B 本次是 no_code 提交，非任一逐人码的泛化判据），实得 ${JSON.stringify(newRowsAfterB[0])}`);
    must(newRowsAfterB.length === 2 && newRowsAfterB[1].event_type === 'status_change' && newRowsAfterB[1].action_code === null,
      `[codex 589 LOW-1] 新增第 2 行应精确为 event_type='status_change' ∧ action_code=null，实得 ${JSON.stringify(newRowsAfterB[1])}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C3] B6a：事务提交前失败 → 零新增（逐人行 INSERT 自身失败 / CAS 失败）
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const before = await memberRowOf(daId);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const beforeCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    const { result: r1, injected: injected1 } = await withInjectedDbRunFailure("'dev_submit_done'", () => submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-1', issueType: 'bug' }));
    must(injected1, `[C3·注入] 应确实命中目标注入点（'dev_submit_done' 那条 timeline INSERT），否则下方断言可能是别的异常造成的假通过`);
    must(r1.status >= 500, `[C3·注入] 逐人行 INSERT 失败后端点应 5xx，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === undefined, `[C3·注入][LOW-13] 未被 SysTransitionError 包装的内部异常，响应体不应带 code 字段，实得 ${JSON.stringify(r1.body)}`);
    const afterMember = await memberRowOf(daId);
    must(afterMember.dev_status === 'pending', `[C3·注入] 成员 dev_status 应整体回滚仍为 pending，实得 ${afterMember.dev_status}`);
    // [codex 589 MED-3] sys_issues.status 前后相等 + 成员 resolved_at 回滚为 NULL——证明"整体回滚"不
    // 只体现在 dev_status 一列，issue 级主状态与成员的完成时间戳同样须整体撤销。
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·注入][MED-3] sys_issues.status 应回滚为提交前的值(${beforeStatus})，实得 ${await issueStatusOf(issueId)}`);
    must(afterMember.resolved_at === before.resolved_at, `[C3·注入][MED-3] 成员 resolved_at 应回滚为提交前的值(${before.resolved_at})，实得 ${afterMember.resolved_at}`);
    const afterCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    must(afterCommits === beforeCommits, `[C3·注入] commits 行应整体回滚，前=${beforeCommits}，后=${afterCommits}`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·注入] timeline 行应整体回滚（零新增），前=${beforeTl}，后=${afterTl}`);
    // 注入点复原后同一请求重试应成功，证明回滚干净、连接未被污染。
    const retry = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-1', issueType: 'bug' });
    must(retry.status === 200, `[C3·注入] 注入点复原后重试应 200（证明回滚干净），实得 ${retry.status} ${JSON.stringify(retry.body)}`);
  }
  {
    // no_code 分支注入
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const beforeMember = await memberRowOf(daId);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const { result: r1, injected: injected1 } = await withInjectedDbRunFailure("'dev_no_code'", () => submitNoCode(issueId, devTok(5, '开发甲'), 'C3 夹具：无代码', { issueType: 'bug' }));
    must(injected1, `[C3·no_code 注入] 应确实命中目标注入点（'dev_no_code' 那条 timeline INSERT）`);
    must(r1.status >= 500, `[C3·no_code 注入] 逐人行 INSERT 失败后端点应 5xx，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === undefined, `[C3·no_code 注入][LOW-13] 未被 SysTransitionError 包装的内部异常，响应体不应带 code 字段，实得 ${JSON.stringify(r1.body)}`);
    const afterMember = await memberRowOf(daId);
    must(afterMember.dev_status === 'pending', `[C3·no_code 注入] 成员 dev_status 应回滚仍为 pending，实得 ${afterMember.dev_status}`);
    // [codex 589 MED-3] no_code 组额外断言：sys_issues.status 前后相等 + resolved_at 回滚 NULL +
    // no_code_reason 回滚 NULL（no_code 分支特有列，commits 分支不写该列不需要断言）。
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·no_code 注入][MED-3] sys_issues.status 应回滚为提交前的值(${beforeStatus})，实得 ${await issueStatusOf(issueId)}`);
    must(afterMember.resolved_at === beforeMember.resolved_at, `[C3·no_code 注入][MED-3] 成员 resolved_at 应回滚为提交前的值(${beforeMember.resolved_at})，实得 ${afterMember.resolved_at}`);
    must(afterMember.no_code_reason === null, `[C3·no_code 注入][MED-3] 成员 no_code_reason 应回滚为 NULL，实得 ${afterMember.no_code_reason}`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·no_code 注入] timeline 行应零新增，前=${beforeTl}，后=${afterTl}`);
  }
  {
    // [codex 589 采纳·更名] 原「CAS 失败」更名为「前置状态拒绝」——核实结论：submit 端点在 §6.2 步骤3
    //   之前**没有**独立的 dev_status 前置校验分支（index.js :10537-10741 全文 grep 核对，CAS UPDATE
    //   之前无 `memberRow.dev_status !== 'pending'` 这类判断）；此处 409 INVALID_STATUS 恰是那条
    //   "双条件 WHERE + changes 检查"CAS 语句本身（:10745-10753）——WHERE dev_status='pending' 命中 0
    //   行导致 upd.changes !== 1。本用例先用真实并发场景（预先把成员置为 code_submitted）触发一次，
    //   再用注入让 CAS 语句本身 changes=0（不改变真实 dev_status）复现同一 409，两条路径殊途同归，
    //   证明"前置状态拒绝"这个判定点就是 CAS 语句，不是独立的另一层校验。
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='code_submitted', resolved_at=datetime('now','localtime') WHERE id=?`, [daId]);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const r = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-cas', issueType: 'bug' });
    must(r.status === 409, `[C3·前置状态拒绝] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
    must(r.body && r.body.code === 'INVALID_STATUS', `[C3·前置状态拒绝][LOW-13] body.code 应为 INVALID_STATUS，实得 ${r.body && r.body.code}`);
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·前置状态拒绝][MED-3] sys_issues.status 应前后相等(${beforeStatus})`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·前置状态拒绝] timeline 应零新增，前=${beforeTl}，后=${afterTl}`);
  }
  {
    // [codex 589 MED-3 补充] 拦截 CAS UPDATE 语句本身（匹配表名 sys_issue_dev_assignees + SET
    //   dev_status = ?, resolved_at = datetime 片段，非只靠列序列）让其 this.changes=0——不真的改变
    //   真实 dev_status（成员此刻仍是 pending，非并发场景），单纯证明"该语句一旦 changes!==1 就走
    //   409 INVALID_STATUS 且零写入"，与上一组"真实并发导致 changes=0"互为印证。
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const beforeMember = await memberRowOf(daId);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const { result: r1, injected: injected1 } = await withInjectedDbRunZeroChanges(
      (sql) => typeof sql === 'string' && sql.includes('UPDATE sys_issue_dev_assignees SET dev_status = ?, resolved_at = datetime'),
      () => submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-cas-zero', issueType: 'bug' })
    );
    must(injected1, `[C3·CAS changes=0 注入] 应确实命中目标注入点（CAS UPDATE 语句本身）`);
    must(r1.status === 409, `[C3·CAS changes=0 注入] 应 409，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === 'INVALID_STATUS', `[C3·CAS changes=0 注入][LOW-13] body.code 应为 INVALID_STATUS，实得 ${r1.body && r1.body.code}`);
    const afterMember = await memberRowOf(daId);
    must(afterMember.dev_status === 'pending' && afterMember.resolved_at === beforeMember.resolved_at, `[C3·CAS changes=0 注入] 成员应零写入，实得 ${JSON.stringify(afterMember)}`);
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·CAS changes=0 注入][MED-3] sys_issues.status 应前后相等(${beforeStatus})`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·CAS changes=0 注入] timeline 应零新增，前=${beforeTl}，后=${afterTl}`);
  }
  {
    // [MED-1 注入点后移①] commits INSERT 失败——发生在 CAS UPDATE 与逐人行 INSERT 均已先行落库
    // 之后（§6.2 步骤4，晚于步骤3 的逐人行写点），须证明"后段失败仍整体回滚前段已落的写入"，不是
    // 只测"最早一条 INSERT 失败"这种最容易命中回滚的位置。
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const beforeMember = await memberRowOf(daId);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const beforeCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    const { result: r1, injected: injected1 } = await withInjectedDbRunFailure(
      'INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)',
      () => submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-commits', issueType: 'bug' })
    );
    must(injected1, `[C3·commits 注入] 应确实命中目标注入点（sys_issue_dev_commits INSERT，晚于逐人行 INSERT 落点），否则下方断言可能是别的异常造成的假通过`);
    must(r1.status >= 500, `[C3·commits 注入] commits INSERT 失败后端点应 5xx，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === undefined, `[C3·commits 注入][LOW-13] 未被 SysTransitionError 包装的内部异常，响应体不应带 code 字段，实得 ${JSON.stringify(r1.body)}`);
    const afterMember = await memberRowOf(daId);
    must(afterMember.dev_status === 'pending', `[C3·commits 注入] 成员 dev_status 应整体回滚仍为 pending（含此前已落的 CAS UPDATE），实得 ${afterMember.dev_status}`);
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·commits 注入][MED-3] sys_issues.status 应回滚为提交前的值(${beforeStatus})，实得 ${await issueStatusOf(issueId)}`);
    must(afterMember.resolved_at === beforeMember.resolved_at, `[C3·commits 注入][MED-3] 成员 resolved_at 应回滚为提交前的值(${beforeMember.resolved_at})，实得 ${afterMember.resolved_at}`);
    const afterRows = await perDevRowsOf(issueId);
    must(afterRows.length === 0, `[C3·commits 注入] 逐人行应整体回滚为 0 条（此前已落的 dev_submit_done 须随事务撤销），实得 ${afterRows.length}`);
    const afterCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    must(afterCommits === beforeCommits, `[C3·commits 注入] commits 行应整体回滚，前=${beforeCommits}，后=${afterCommits}`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·commits 注入] timeline 行应整体回滚（零新增），前=${beforeTl}，后=${afterTl}`);
    const retry = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-commits', issueType: 'bug' });
    must(retry.status === 200, `[C3·commits 注入] 注入点复原后重试应 200（证明回滚干净），实得 ${retry.status} ${JSON.stringify(retry.body)}`);
  }
  {
    // [MED-1 注入点后移②] runWGate 内 status_change 镜像行 INSERT 失败——发生在 CAS/逐人行/commits/
    // dev_events/electRepresentative 全部先行落库之后（本 issue 唯一开发，全完成会推进主状态），须
    // 证明"最后一段失败"时前面全部写入都能整体回滚为零，是本用例组判别力最强的一个注入点。
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const beforeMember = await memberRowOf(daId);
    const beforeStatus = await issueStatusOf(issueId);
    const beforeTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    const beforeCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    const { result: r1, injected: injected1 } = await withInjectedDbRunFailure(
      'event_type, from_status, to_status, summary, operator_id, operator_name, action_code',
      () => submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-wgate', issueType: 'bug' })
    );
    must(injected1, `[C3·runWGate 注入] 应确实命中目标注入点（runWGate 内 status_change 镜像行 INSERT），否则下方断言可能是别的异常造成的假通过`);
    must(r1.status >= 500, `[C3·runWGate 注入] status_change INSERT 失败后端点应 5xx，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === undefined, `[C3·runWGate 注入][LOW-13] 未被 SysTransitionError 包装的内部异常，响应体不应带 code 字段，实得 ${JSON.stringify(r1.body)}`);
    const afterMember = await memberRowOf(daId);
    must(afterMember.dev_status === 'pending', `[C3·runWGate 注入] 成员 dev_status 应整体回滚仍为 pending，实得 ${afterMember.dev_status}`);
    must((await issueStatusOf(issueId)) === beforeStatus, `[C3·runWGate 注入][MED-3] sys_issues.status 应整体回滚为提交前的值(${beforeStatus})——本注入点晚于全部前段写入，最应证明"主状态也一并回滚"，实得 ${await issueStatusOf(issueId)}`);
    must(afterMember.resolved_at === beforeMember.resolved_at, `[C3·runWGate 注入][MED-3] 成员 resolved_at 应回滚为提交前的值(${beforeMember.resolved_at})，实得 ${afterMember.resolved_at}`);
    const afterRows = await perDevRowsOf(issueId);
    must(afterRows.length === 0, `[C3·runWGate 注入] 逐人行应整体回滚为 0 条，实得 ${afterRows.length}`);
    const afterCommits = (await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId])).length;
    must(afterCommits === beforeCommits, `[C3·runWGate 注入] commits 行应整体回滚，前=${beforeCommits}，后=${afterCommits}`);
    const afterTl = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=?`, [issueId])).length;
    must(afterTl === beforeTl, `[C3·runWGate 注入] timeline 行应整体回滚（零新增，含 dev_submit_done 与 status_change 均撤销），前=${beforeTl}，后=${afterTl}`);
    const retry = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-c3-wgate', issueType: 'bug' });
    must(retry.status === 200, `[C3·runWGate 注入] 注入点复原后重试应 200（证明回滚干净），实得 ${retry.status} ${JSON.stringify(retry.body)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C4] B6b：提交成功后再次同请求 → 409 且逐人行不重复
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中');
    await mkPending(issueId, 5, '开发甲');
    const tok = devTok(5, '开发甲');
    const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'svn-c4-1' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'C4 夹具：bug 产生原因' };
    const r1 = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
    must(r1.status === 200, `[C4] 首次提交应 200，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    const rowsAfterFirst = await perDevRowsOf(issueId);
    must(rowsAfterFirst.length === 1, `[C4] 首次提交后逐人行恰 1 条，实得 ${rowsAfterFirst.length}`);
    const r2 = await call('POST', `/api/sys-issues/${issueId}/submit`, tok, body);
    must(r2.status === 409, `[C4] 重复同请求应 409，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    must(r2.body && r2.body.code === 'INVALID_STATUS', `[C4][LOW-13] body.code 应为 INVALID_STATUS，实得 ${r2.body && r2.body.code}`);
    const rowsAfterSecond = await perDevRowsOf(issueId);
    must(rowsAfterSecond.length === 1, `[C4] 重复请求后逐人行仍恰 1 条（不重复），实得 ${rowsAfterSecond.length}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [codex 589 MED-4] B6b 真实场景：sysCommit() 已提交后，res.json(...) 本身抛错——submit 端点在
  //   commit 之后只剩这一步（index.js :11006-11013），本组证明"响应组装阶段失败"不影响已落库的数据
  //   （无法回滚，也不该回滚），独立 GET/查询能读到成员已 code_submitted、commits 与逐人行均在；
  //   客户端因未收到 200 会自然重试同一请求，此时应 409（CAS 不再匹配 pending）且逐人行不重复。
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    sabotageNextSubmitResJson = true;
    __b6bResJsonThrowSeq = null;
    const { result: r1, commitSeq } = await withCommitOrderTracking(
      () => submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-med4-b6b', issueType: 'bug' })
    );
    must(r1.status === 500, `[MED-4·B6b] res.json 抛错后端点应 500，实得 ${r1.status} ${JSON.stringify(r1.body)}`);
    must(r1.body && r1.body.code === undefined, `[MED-4·B6b][LOW-13] 未被 SysTransitionError 包装的内部异常，响应体不应带 code 字段，实得 ${JSON.stringify(r1.body)}`);
    must(sabotageNextSubmitResJson === false, `[MED-4·B6b] 一次性开关应已被消费（证明注入真的命中过，非误配导致的假通过）`);
    // [S4c3·M7] 直接证据：COMMIT 语句成功执行的顺位号应早于 res.json 抛错的顺位号——不再只靠"独立读
    // 能读到已提交数据"这种间接推断（那只能证明写入早于读取，不能证明写入早于 res.json 抛错本身）。
    const commitSeqVal = commitSeq();
    must(commitSeqVal !== null, `[MED-4·B6b][S4c3·M7] COMMIT 语句应确实成功执行过一次（顺位号非 null），实得 ${commitSeqVal}`);
    must(__b6bResJsonThrowSeq !== null, `[MED-4·B6b][S4c3·M7] res.json 抛错点应确实被命中并记录顺位号，实得 ${__b6bResJsonThrowSeq}`);
    must(commitSeqVal !== null && __b6bResJsonThrowSeq !== null && commitSeqVal < __b6bResJsonThrowSeq,
      `[MED-4·B6b][S4c3·M7] COMMIT 顺位号(${commitSeqVal}) 应早于 res.json 抛错顺位号(${__b6bResJsonThrowSeq})——直接证据而非仅凭独立读推断`);
    // 独立读（新查询，非同一请求上下文）：数据确已落库，与上面的顺位证据互相印证（不是唯一证据）。
    const memberAfter = await memberRowOf(daId);
    must(memberAfter.dev_status === 'code_submitted', `[MED-4·B6b] 独立读：成员 dev_status 应已是 code_submitted（commit 早于 res.json），实得 ${memberAfter.dev_status}`);
    const commitsAfter = await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId]);
    must(commitsAfter.length === 1, `[MED-4·B6b] 独立读：commits 行应已落库恰 1 条，实得 ${commitsAfter.length}`);
    const perDevRowsAfterCommit = await perDevRowsOf(issueId);
    must(perDevRowsAfterCommit.length === 1, `[MED-4·B6b] 独立读：逐人行应已落库恰 1 条，实得 ${perDevRowsAfterCommit.length}`);
    const issueStatusBeforeRetry = await issueStatusOf(issueId);
    // [S4c3·M7] 重试改用**完全相同请求体**（同 ref='svn-med4-b6b'）——模拟客户端未收到 200、原样重放
    // 同一次请求（此前用不同 ref 'svn-med4-b6b-retry'，并不是真正的"同一请求重试"）。应 409（数据
    // 已提交，CAS 不再匹配 pending），且 commits 行数、逐人行数、整单状态三者均不应因重试而改变。
    const retry = await submitCommits(issueId, devTok(5, '开发甲'), { ref: 'svn-med4-b6b', issueType: 'bug' });
    must(retry.status === 409, `[MED-4·B6b] 重试同请求应 409（数据已提交，非事务失败），实得 ${retry.status} ${JSON.stringify(retry.body)}`);
    must(retry.body && retry.body.code === 'INVALID_STATUS', `[MED-4·B6b] 重试 body.code 应为 INVALID_STATUS，实得 ${retry.body && retry.body.code}`);
    const perDevRowsAfterRetry = await perDevRowsOf(issueId);
    must(perDevRowsAfterRetry.length === 1, `[MED-4·B6b] 重试后逐人行仍恰 1 条（不重复），实得 ${perDevRowsAfterRetry.length}`);
    const commitsAfterRetry = await all(`SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id=?`, [daId]);
    must(commitsAfterRetry.length === 1, `[MED-4·B6b][S4c3·M7] 重试后 commits 行数仍恰 1 条（不重复），实得 ${commitsAfterRetry.length}`);
    must((await issueStatusOf(issueId)) === issueStatusBeforeRetry, `[MED-4·B6b][S4c3·M7] 重试后整单状态未变，前=${issueStatusBeforeRetry}，后=${await issueStatusOf(issueId)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C5] 撤回/打回/重开后原行仍在；重提出现第二条同 dev_assignee_id 逐人行
  // ══════════════════════════════════════════════════════════════════════
  {
    // 撤回重提
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const tok = devTok(5, '开发甲');
    const r1 = await submitCommits(issueId, tok, { ref: 'svn-c5-withdraw-1', issueType: 'bug' });
    must(r1.status === 200, `[C5·撤回] 提交应 200，实得 ${r1.status}`);
    const rowsFirst = await perDevRowsOf(issueId);
    const evtRow = await get(`SELECT id FROM sys_issue_dev_events WHERE dev_assignee_id=? AND action IN ('submit','no_code') ORDER BY id DESC LIMIT 1`, [daId]);
    const wr = await call('POST', `/api/sys-issues/${issueId}/submit/withdraw`, tok, { reason: 'C5 夹具：撤回重提', expected_submit_event_id: evtRow.id });
    must(wr.status === 200, `[C5·撤回] 撤回应 200，实得 ${wr.status} ${JSON.stringify(wr.body)}`);
    const rowsAfterWithdraw = await perDevRowsOf(issueId);
    must(rowsAfterWithdraw.length === 1 && rowsAfterWithdraw[0].id === rowsFirst[0].id, `[C5·撤回] 撤回后原逐人行仍在（未被删除/新增），前 id=${rowsFirst[0].id}，后=${JSON.stringify(rowsAfterWithdraw.map(r => r.id))}`);
    const r2 = await submitCommits(issueId, tok, { ref: 'svn-c5-withdraw-2', issueType: 'bug' });
    must(r2.status === 200, `[C5·撤回] 撤回后重提应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    const rowsAfterResubmit = await perDevRowsOf(issueId);
    must(rowsAfterResubmit.length === 2, `[C5·撤回] 撤回后重提出现第二条逐人行，实得 ${rowsAfterResubmit.length}`);
    must(rowsAfterResubmit.every(r => r.ref_id === daId), `[C5·撤回] 两条逐人行 ref_id 均为同一 dev_assignee_id(${daId})（撤回不产生新实例）`);
    must(rowsAfterResubmit[1].id > rowsAfterResubmit[0].id, `[C5·撤回] 第二条逐人行 id 更大`);
  }
  {
    // 对接测试打回重提（feature 单人团队走到「待对接测试」）
    const issueId = await mkIssue('feature', '开发中', { effortDays: 1 });
    const daId = await mkPending(issueId, 5, '开发甲');
    const tok = devTok(5, '开发甲');
    const r1 = await submitCommits(issueId, tok, { ref: 'svn-c5-lt-1' });
    must(r1.status === 200 && r1.body.main_status === '待对接测试', `[C5·对接测试打回] 提交后应到「待对接测试」，实得 ${r1.status} ${r1.body && r1.body.main_status}`);
    const rowsFirst = await perDevRowsOf(issueId);
    const ltr = await call('POST', `/api/sys-issues/${issueId}/liaison-test-return`, liaisonTok, { reason: 'C5 夹具：对接测试打回' });
    must(ltr.status === 200, `[C5·对接测试打回] liaison-test-return 应 200，实得 ${ltr.status} ${JSON.stringify(ltr.body)}`);
    const rowsAfterLtr = await perDevRowsOf(issueId);
    must(rowsAfterLtr.length === 1 && rowsAfterLtr[0].id === rowsFirst[0].id, `[C5·对接测试打回] 打回后原逐人行仍在`);
    // liaison_test_return 同事务清空 dev_estimated_at（:6561 一带 setFrags），重提前须补填，同真实前端
    // 打回后引导用户回填预计完成时间的流程一致，非本次范围的额外行为。
    // feature 类型 /estimate 每次调用须显式带 estimated_effort_days（该字段按"本次调用体是否提供"判定，
    // 非按库里存量值兜底），即便存量值未被 liaison_test_return 清空也须重传。
    const estR1 = await call('POST', `/api/sys-issues/${issueId}/estimate`, tok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
    must(estR1.status === 200, `[C5·对接测试打回] 打回后补填预计完成时间应 200，实得 ${estR1.status} ${JSON.stringify(estR1.body)}`);
    const r2 = await submitCommits(issueId, tok, { ref: 'svn-c5-lt-2' });
    must(r2.status === 200, `[C5·对接测试打回] 打回后重提应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    const rowsAfterResubmit = await perDevRowsOf(issueId);
    must(rowsAfterResubmit.length === 2 && rowsAfterResubmit.every(r => r.ref_id === daId), `[C5·对接测试打回] 重提出现第二条同 dev_assignee_id 逐人行，实得 ${rowsAfterResubmit.length} 条`);
  }
  {
    // 真正 return（验收打回：待验证 → 处理中，软删旧实例 + 新建一轮）
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const tok = devTok(5, '开发甲');
    const r1 = await submitCommits(issueId, tok, { ref: 'svn-c5-return-1', issueType: 'bug' });
    must(r1.status === 200 && r1.body.main_status === '待验证', `[C5·真正return] bug 单人提交后应到「待验证」，实得 ${r1.status} ${r1.body && r1.body.main_status}`);
    const rowsFirst = await perDevRowsOf(issueId);
    const rt = await call('POST', `/api/sys-issues/${issueId}/return`, adminTok, { reason: 'C5 夹具：验收打回' });
    must(rt.status === 200, `[C5·真正return] return 应 200，实得 ${rt.status} ${JSON.stringify(rt.body)}`);
    const rowsAfterReturn = await perDevRowsOf(issueId);
    must(rowsAfterReturn.length === 1 && rowsAfterReturn[0].id === rowsFirst[0].id, `[C5·真正return] 打回后原逐人行仍在（旧实例被软删但其时间线行不受影响）`);
    // return 侧效应：完成态成员 remove+re-add，同一 user_id 会拿到**新的** dev_assignee_id 实例
    const newMember = await get(`SELECT id FROM sys_issue_dev_assignees WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [issueId]);
    must(!!newMember && newMember.id !== daId, `[C5·真正return] 验收打回后应产生新的在册实例（remove+re-add），旧 id=${daId}，新 id=${newMember && newMember.id}`);
    // case 'return' 同事务清空 dev_estimated_at（:6503 一带 setFrags），重提前须补填。
    const estR2 = await call('POST', `/api/sys-issues/${issueId}/estimate`, tok, { dev_estimated_at: futureEst(30) });
    must(estR2.status === 200, `[C5·真正return] 打回后补填预计完成时间应 200，实得 ${estR2.status} ${JSON.stringify(estR2.body)}`);
    const r2 = await submitCommits(issueId, tok, { ref: 'svn-c5-return-2', issueType: 'bug' });
    must(r2.status === 200, `[C5·真正return] 新一轮重提应 200，实得 ${r2.status} ${JSON.stringify(r2.body)}`);
    const rowsAfterResubmit = await perDevRowsOf(issueId);
    must(rowsAfterResubmit.length === 2, `[C5·真正return] 新一轮重提后逐人行共 2 条（新旧实例各一条），实得 ${rowsAfterResubmit.length}`);
    must(rowsAfterResubmit[1].ref_id === newMember.id, `[C5·真正return] 第二条逐人行 ref_id 应为新实例 id(${newMember.id})，实得 ${rowsAfterResubmit[1].ref_id}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C6] amend 零新增、原行 payload_json 逐字不变；amend 切换 code_submitted↔no_code 后原行 mode 不变
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中');
    await mkPending(issueId, 5, '开发甲');
    const tok = devTok(5, '开发甲');
    const r1 = await submitCommits(issueId, tok, { ref: 'svn-c6-1', issueType: 'bug' });
    must(r1.status === 200, `[C6] 提交应 200，实得 ${r1.status}`);
    const rowsBefore = await perDevRowsOf(issueId);
    // amend：commits → no_code（切模式）
    const amendR = await call('POST', `/api/sys-issues/${issueId}/submit/amend`, tok, { mode: 'no_code', no_code_reason: 'C6 夹具：amend 切到无代码交付' });
    must(amendR.status === 200, `[C6] amend 切模式应 200，实得 ${amendR.status} ${JSON.stringify(amendR.body)}`);
    const rowsAfter = await perDevRowsOf(issueId);
    must(rowsAfter.length === 1, `[C6] amend 后逐人行仍恰 1 条（零新增），实得 ${rowsAfter.length}`);
    must(JSON.stringify(rowsAfter[0]) === JSON.stringify(rowsBefore[0]), `[C6] amend 后原行逐字不变（含 payload_json）`);
    const payloadAfterAmend = JSON.parse(rowsAfter[0].payload_json);
    must(payloadAfterAmend.mode === 'code_submitted' && rowsAfter[0].action_code === 'dev_submit_done', `[C6] amend 切模式后逐人行仍是提交当时的 code_submitted 快照（不随 amend 改写），实得 mode=${payloadAfterAmend.mode} action_code=${rowsAfter[0].action_code}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C7] 快照隔离：提交后改成员表 user_name/no_code_reason → 原行 payload 不变
  //   （方案 §4 C3 批注②：以此替代"admin 代提"用例——本端点 actor 恒为完成者本人）
  // ══════════════════════════════════════════════════════════════════════
  {
    const issueId = await mkIssue('bug', '处理中');
    const daId = await mkPending(issueId, 5, '开发甲');
    const r1 = await submitNoCode(issueId, devTok(5, '开发甲'), 'C7 夹具：原始原因', { issueType: 'bug' });
    must(r1.status === 200, `[C7] 提交应 200，实得 ${r1.status}`);
    const rowsBefore = await perDevRowsOf(issueId);
    const payloadBefore = JSON.parse(rowsBefore[0].payload_json);
    // 直接改成员表（模拟"事后回填污染"，同 D9 既有降噪范式的反向验证）
    await run(`UPDATE sys_issue_dev_assignees SET user_name='改名后的开发甲', no_code_reason='被事后改写的原因' WHERE id=?`, [daId]);
    const rowsAfter = await perDevRowsOf(issueId);
    const payloadAfter = JSON.parse(rowsAfter[0].payload_json);
    must(payloadAfter.dev_user_name === payloadBefore.dev_user_name, `[C7] 成员表改名后，逐人行 payload.dev_user_name 不受影响，仍为「${payloadAfter.dev_user_name}」`);
    must(payloadAfter.no_code_reason === payloadBefore.no_code_reason, `[C7] 成员表改原因后，逐人行 payload.no_code_reason 不受影响，仍为「${payloadAfter.no_code_reason}」`);
    // [MED-6 换读端] 裸 SELECT 只证明"落库的字节没变"，换成真实消费端点 GET /api/sys-issues/:id
    // （§5.3 演进时间线的权威读源）再核一遍，证明前端实际会读到的 DTO 里也是旧快照，不是"裸 SELECT
    // 侥幸绕开了某个读侧投影/JOIN 才看起来没变"。
    const detail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    must(detail.status === 200, `[C7·GET 读端] GET 详情应 200，实得 ${detail.status}`);
    const tlRowViaApi = detail.body && Array.isArray(detail.body.timeline) && detail.body.timeline.find(t => t.action_code === 'dev_no_code' && t.ref_id === daId);
    must(!!tlRowViaApi, `[C7·GET 读端] 详情 timeline 中应能定位到该逐人行（action_code=dev_no_code, ref_id=${daId}），实得 timeline=${JSON.stringify(detail.body && detail.body.timeline)}`);
    const payloadViaApi = tlRowViaApi && JSON.parse(tlRowViaApi.payload_json);
    must(!!payloadViaApi && payloadViaApi.dev_user_name === payloadBefore.dev_user_name, `[C7·GET 读端] 详情端点 payload.dev_user_name 仍为旧名「${payloadBefore.dev_user_name}」，实得 ${payloadViaApi && payloadViaApi.dev_user_name}`);
    must(!!payloadViaApi && payloadViaApi.no_code_reason === payloadBefore.no_code_reason, `[C7·GET 读端] 详情端点 payload.no_code_reason 仍为原文「${payloadBefore.no_code_reason}」，实得 ${payloadViaApi && payloadViaApi.no_code_reason}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // [C8] buildPerDevDonePayload 直调——不一致组合应被拒 + 必填键缺失应被拒 + D9 边界（原因片段级）
  // ══════════════════════════════════════════════════════════════════════
  {
    const base = { devUserId: 5, devUserName: '开发甲', devAssigneeId: 1, submittedAt: '2026-01-01 00:00:00' };
    // mode/actionCode 不一致
    try {
      I.buildPerDevDonePayload({ mode: 'code_submitted', actionCode: 'dev_no_code', ...base });
      must(false, '[C8] mode/actionCode 不一致应 throw，但未 throw');
    } catch (e) { must(e.code === 'PERDEV_DONE_ACTION_CODE_MISMATCH', `[C8] mode/actionCode 不一致正确 throw PERDEV_DONE_ACTION_CODE_MISMATCH，实得 ${e.code}`); }
    // no_code 缺 reason
    try {
      I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, ...base });
      must(false, '[C8] no_code 缺 reason 应 throw，但未 throw');
    } catch (e) { must(e.code === 'PERDEV_DONE_NO_CODE_REASON_MISSING', `[C8] no_code 缺 reason 正确 throw，实得 ${e.code}`); }
    // 必填键缺失各一组：devUserId / devUserName / devAssigneeId / submittedAt
    const requiredKeyCases = [
      { name: 'devUserId', override: { devUserId: undefined } },
      { name: 'devUserName', override: { devUserName: '' } },
      { name: 'devAssigneeId', override: { devAssigneeId: null } },
      { name: 'submittedAt', override: { submittedAt: '' } },
    ];
    for (const c of requiredKeyCases) {
      try {
        I.buildPerDevDonePayload({ mode: 'code_submitted', actionCode: I.PERDEV_DONE_ACTION_CODE.code_submitted, ...base, ...c.override });
        must(false, `[C8] 缺 ${c.name} 应 throw，但未 throw`);
      } catch (e) { must(e.code === 'PERDEV_DONE_REQUIRED_KEY_MISSING', `[C8] 缺 ${c.name} 正确 throw PERDEV_DONE_REQUIRED_KEY_MISSING，实得 ${e.code}`); }
    }
    // [codex 588 M1] D9 80 码点计数对象是「no_code 原因片段」，不是整条 summary——分开断言。
    const exact80 = '甲'.repeat(80);
    const r80 = I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, ...base, noCodeReason: exact80 });
    must(r80.summary === `开发完成：开发甲 无代码交付：${exact80}`, `[C8·D9] 恰 80 码点原因不截断、summary 含全文无省略号，实得「${r80.summary}」`);
    const over81 = '乙'.repeat(81);
    const r81 = I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, ...base, noCodeReason: over81 });
    const expectedChunk81 = Array.from(over81).slice(0, 80).join('') + '…';
    must(r81.summary === `开发完成：开发甲 无代码交付：${expectedChunk81}`, `[C8·D9] 81 码点原因截断为 80+省略号，实得「${r81.summary}」`);
    must(r81.payload.no_code_reason === over81, `[C8·D9] payload.no_code_reason 保留原文全文（81 码点），不因摘要截断而丢失`);
    // 整条 summary 可因姓名很长而超过 80 字符，不被二次截断——证明「80」只管原因片段，不管整条 summary 长度。
    // [codex 589 采纳] 姓名长度从 50 加长到 90（码点数 >80，即超过原因片段的截断上限本身），才是真正
    // 有判别力的对照——50 码点时"整条 summary 超 80"本就必然成立（哪怕截断逻辑误把姓名也纳入计数，
    // 50<80 也不会触发截断，无法证伪"只截断原因片段"这条结论），90>80 才排除了这种巧合。
    const longName = '张'.repeat(90);
    const shortReason = '短原因';
    const rLongName = I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, devUserId: 5, devUserName: longName, devAssigneeId: 1, submittedAt: '2026-01-01 00:00:00', noCodeReason: shortReason });
    must(rLongName.summary === `开发完成：${longName} 无代码交付：${shortReason}`, `[C8·D9] 长姓名(90码点，>80)+短原因(3) 时整条 summary 不被截断（截断只作用于原因片段），实得「${rLongName.summary}」`);
    must(Array.from(rLongName.summary).length > 80, `[C8·D9] 长姓名场景整条 summary 码点数应 >80（真正验证"80 上限只管原因片段"），实得 ${Array.from(rLongName.summary).length}`);
    // [codex 589 采纳·D9 补充] 非 BMP 字符（emoji，UTF-16 代理对/单个码点由 2 个 UTF-16 code unit 组成）
    // 80/81 码点边界——buildPerDevDonePayload 内部按 Array.from 码点截断（同 Sys_Iteration.html 前端
    // D9 纪律一致，非 .length 这种会把代理对错数成 2 的写法），用非 BMP emoji 反证：若实现误用
    // String.prototype.length，80 个 😀（每个 2 code units，.length=160）会被误判为"超过 80 上限"而在
    // 第 40 个字符处截断——本组断言恰好能揪出这类回归。
    const exact80Emoji = '😀'.repeat(80);
    const r80Emoji = I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, ...base, noCodeReason: exact80Emoji });
    must(r80Emoji.summary === `开发完成：开发甲 无代码交付：${exact80Emoji}`, `[C8·D9·emoji] 恰 80 码点（非 BMP emoji）原因不截断、summary 含全文无省略号，实得码点数=${Array.from(r80Emoji.summary).length}`);
    const over81Emoji = '😀'.repeat(81);
    const r81Emoji = I.buildPerDevDonePayload({ mode: 'no_code', actionCode: I.PERDEV_DONE_ACTION_CODE.no_code, ...base, noCodeReason: over81Emoji });
    const expectedChunk81Emoji = Array.from(over81Emoji).slice(0, 80).join('') + '…';
    must(r81Emoji.summary === `开发完成：开发甲 无代码交付：${expectedChunk81Emoji}`, `[C8·D9·emoji] 81 码点（非 BMP emoji）原因截断为 80+省略号（按码点非 UTF-16 code unit），实得「${r81Emoji.summary}」`);
    must(r81Emoji.payload.no_code_reason === over81Emoji, `[C8·D9·emoji] payload.no_code_reason 保留原文全文（81 码点 emoji），不因摘要截断而丢失`);
  }

  console.log(`\n${failDetails.length === 0 ? '=== PASS' : '=== FAIL'}：${passed} 项通过 / ${failDetails.length} 项失败 ===`);
  if (failDetails.length > 0) { failDetails.forEach(m => console.log('  ✗ ' + m)); process.exit(1); }
  process.exit(0);
}

main().catch(e => { console.error('verify-sys-perdev-done 异常:', e); process.exit(1); });
