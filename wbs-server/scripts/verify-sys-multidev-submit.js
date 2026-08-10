// scripts/verify-sys-multidev-submit.js — C3 验收：W05 唯一 submit（多开发 commit 事件模型）
//   SSOT = 方案 v2.9 §6.1/§6.2 + 开发计划 v2.9 §2.2 W05/§2.5 + 联合 SSOT §13 验收表
//   用法：node scripts/verify-sys-multidev-submit.js
//
// 覆盖验收表 S2/S3/S4/S5/S6/S7/S8/S9（联合 SSOT §13）。in-process app + 内存库 + 自签 token，同
// verify-sys-multidev-members.js 范式。每个主要场景 mutate 后跑 runProbes 自证（复用 C0 探针，非新增探针）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');

const SECRET = 'verify-sys-multidev-submit-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// [codex 99 号 MED2② 补强] 故障注入——同 verify-sys-multidev-members.js H2 既有范式：平时 injectFailureOnSql=null，
//   dbRunAsync 行为与直接用 run 完全一致；仅测试内临时置位一次 SQL 片段，命中后自动复位并置
//   injectFailureFired=true（防片段写错导致故障从未注入、断言静默失去意义）。
let injectFailureOnSql = null;
let injectFailureFired = false;
const runFI = (sql, params = []) => {
  if (injectFailureOnSql && sql.includes(injectFailureOnSql)) {
    const marker = injectFailureOnSql;
    injectFailureOnSql = null;
    injectFailureFired = true;
    return Promise.reject(new Error(`[测试注入故障] 命中 SQL 片段「${marker}」`));
  }
  return run(sql, params);
};

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
  db, dbRunAsync: runFI, dbGetAsync: get, dbAllAsync: all,
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
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);

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
// codex 221a HIGH 收口（验证层残余日期字面量·全文扫描收尾）：dev_estimated_at 默认值原硬编码
// '2026-07-01 10:00:00'，本文件是直连 SQL 造数（不经 /estimate 端点闸门，当前潜伏未触发
// ESTIMATE_BEFORE_ASSIGN），但远期字面量迟早到期，同 P4/221a 范式统一改动态生成，不留隐患。
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function mkIssue(type, status, extra = {}) {
  // [codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED 恢复后，submit 前置要求 dev_estimated_at 非空——本文件
  //   测的是 submit S2-S9 系列（在册/dev_status/commit/事件模型），非 estimate 本身，默认种一个占位值避免
  //   每个用例都被新闸拦下；devEstimatedAt: null 显式传空可测 ESTIMATE_REQUIRED 本身（见 S1b）。
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || futureEst(30));
  // [C7 工时评估补全·方案 v1.7 §9.1] submit 硬闸的工期检查从「nf=1 ∧ feature」扩到「feature/improvement ×
  //   nf 两值」——本文件绝大多数夹具是 **nf=0 的 feature**（DDL 默认 needs_feasibility=0），C7 前它们从不
  //   经过工期闸，C7 后每一个都要过。同 dev_estimated_at 的既有处置（见上一段注释）：默认种一个合法占位值，
  //   让本文件继续测它真正要测的 S2-S9（在册/dev_status/commit/事件模型），不被新闸拦成一片红；
  //   effortDays: null 显式传空可单独测 EFFORT_REQUIRED 本身。bug/config 无工期维度，恒不种（种了反而制造
  //   一个"设计上不该存在"的脏值）。
  const effortApplicable = ['feature', 'improvement'].includes(type);
  const effort = !effortApplicable ? null : (extra.effortDays === null ? null : (extra.effortDays || 1));
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, estimated_effort_days)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est, effort]
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
  // P3 四态配对（同 verify-sys-multidev-members.js mkMember 范式）：code_submitted 要求 commit 行≥1——
  // 种子数据全库跑 selfCertifyProbes 自证，故凡 code_submitted 必须配一条 commit 行，否则污染同库后续场景。
  if (devStatus === 'code_submitted' && extra.skipCommit !== true) {
    await run(
      `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, ?, 'backend', ?, datetime('now'))`,
      [issueId, daId, userId, `fix/seed-${daId}`]
    );
  }
  return daId;
}
// [codex 270 号 L-2] PRAGMA ignore_check_constraints 封装——先读原状态、执行期间临时开启、finally 无条件
// 恢复到进入前的原状态（非硬编码恢复成 OFF：封装本身不应假设调用者的前置状态，虽然本文件目前恒为 OFF
// 进入）。同 verify-sys-multidev-members.js 的同名 helper，两文件各自独立定义（本项目 verify 脚本一贯
// 自包含风格，不跨文件共享 helper 模块）。
async function withIgnoredCheckConstraints(fn) {
  const before = await get('PRAGMA ignore_check_constraints');
  const beforeOn = !!(before && Number(before.ignore_check_constraints) === 1);
  await run('PRAGMA ignore_check_constraints = ON');
  try {
    return await fn();
  } finally {
    await run(`PRAGMA ignore_check_constraints = ${beforeOn ? 'ON' : 'OFF'}`);
  }
}
async function selfCertifyProbes(label) {
  const results = await runProbes(db);
  const failed = results.filter(r => !r.pass);
  assert.strictEqual(failed.length, 0, `${label}：应满足全部 P1-P15 恒真，实际失败：${JSON.stringify(failed)}`);
  return results;
}
async function devEventsOf(issueId, action) {
  return all(`SELECT id, dev_assignee_id, action, payload_json FROM sys_issue_dev_events WHERE issue_id = ? AND action = ? ORDER BY id`, [issueId, action]);
}
async function commitsOf(issueId) {
  return all(`SELECT id, dev_assignee_id, dev_user_id, component, commit_ref FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id`, [issueId]);
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(8,'dev8','开发戊','user')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务');

  // ══════════════════════════════════════════════════════════════════════
  // S1b：[codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED——dev_estimated_at 未填 → 400（真实路由反例）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中', { devEstimatedAt: null });
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '未填预计（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `S1b：dev_estimated_at 未填 submit 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', 'S1b：错误码 ESTIMATE_REQUIRED');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ?', [id]);
    assert.strictEqual(memberRow.dev_status, 'pending', 'S1b：拒绝先于 dev_status UPDATE，仍 pending（整事务回滚）');
    // bug 流同受此闸（旧 case 逐字核对：无 type 限定），补一条 bug 反例
    const idBug = await mkIssue('bug', '处理中', { devEstimatedAt: null });
    await mkMember(idBug, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${idBug}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '未填预计（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `S1b：bug 流同受 ESTIMATE_REQUIRED 约束, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', 'S1b：bug 流错误码同为 ESTIMATE_REQUIRED（无 type 限定，逐字核对旧代码）');
    ok('S1b：submit 缺 dev_estimated_at → 400 ESTIMATE_REQUIRED（feature/bug 均受理，旧单人 case 无 type 限定，e39e65b 版 index.js:1376 逐字复刻）');

    // S1b-effort（C7-fix LOW-4）：把 mkIssue 的 `effortDays: null` 逃生舱**真用一次**。
    //   C7 给 mkIssue 加这个开关时注释写着"可单独测 EFFORT_REQUIRED 本身"，但全文件从没有一处调用它——
    //   那就是一句没有实现背书的声称（[[feedback_comment_is_review_input]]：注释里写"支持 X"却零用例，
    //   等于把"这条路能走"记进了审查输入，实际上没人验过它走不走得通）。本组同时坐实两件事：
    //     ① 逃生舱真能造出"nf=0 且工期为空"的夹具（不会被默认值 1 悄悄兜住）；
    //     ② C7 新增的 nf=0 工期硬闸在本套件的直连 SQL 夹具路径下同样生效（不只在 verify-sys-effort-c7 的
    //        真实建单路径下生效）。
    const idNoEffort = await mkIssue('improvement', '开发中', { effortDays: null });
    assert.strictEqual((await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [idNoEffort])).estimated_effort_days, null,
      'S1b-effort 前置：effortDays:null 逃生舱应真造出空工期（若这里非 null，说明逃生舱被默认值覆盖，后面的红灯就测不到点子上）');
    await mkMember(idNoEffort, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${idNoEffort}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '工期未填（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `S1b-effort：nf=0 improvement 缺工期 submit 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'EFFORT_REQUIRED', `S1b-effort：确切码 EFFORT_REQUIRED，实得 ${r.body && r.body.code}`);
    assert.strictEqual(r.body.error, '请先在估时中填写工期（人日）', `S1b-effort：nf=0 文案指路「估时」，实得 ${JSON.stringify(r.body.error)}`);
    const noEffortMember = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ?', [idNoEffort]);
    assert.strictEqual(noEffortMember.dev_status, 'pending', 'S1b-effort：零副作用——拒绝先于 dev_status UPDATE，仍 pending（整事务回滚）');
    ok('S1b-effort（LOW-4）：mkIssue 的 effortDays:null 逃生舱真用一次——nf=0 improvement 缺工期 submit → 400 EFFORT_REQUIRED + 文案指路「估时」+ roster 零副作用（逃生舱不再是无用例背书的注释声称）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S1c：[codex 99 号 MED2③ 补强] 资格闸表驱动覆盖全部错误码 + 检查顺序断言
  //   逐条构造"仅违反单一条件"的行，确认各自独立触发对应错误码；再构造"同时违反多条件"的行，
  //   确认命中顺序与 e39e65b 版旧 case 'submit' 文本顺序一致：ESTIMATE_REQUIRED → ISSUE_BLOCKED →
  //   FEASIBILITY_REQUIRED(缺失/非法枚举) → FEASIBILITY_NOT_FEASIBLE → FEASIBILITY_INCOMPLETE →
  //   FEASIBILITY_RISK_REQUIRED。FEASIBILITY_* 系列的"仅违反单一条件"态需直接 SQL 造脏（正常 /feasibility
  //   端点自身已校验、无法经由它产出这类不一致行）——对应旧代码"闸门自校验完整性，不全信单入口"（codex 17b M-2）
  //   防脏数据场景，真实业务路径不可达但需要 fail-safe。
  // ══════════════════════════════════════════════════════════════════════
  {
    async function mkFeasIssue(overrides) {
      const id = await mkIssue('feature', '开发中');
      await mkMember(id, 5, '开发甲', 'pending');
      const fields = Object.assign({
        blocked: 0, needs_feasibility: 1,
        feasibility_conclusion: '可行', feasibility_requirement_confirm: '已确认', feasibility_risk: null,
      }, overrides);
      // 常规字段（blocked/needs_feasibility/conclusion/confirm/risk）走普通 UPDATE，全部是 DB CHECK
      // 覆盖不到或本就合法的取值——不需要 PRAGMA，保持"常规夹具路径全程不碰 CHECK 开关"（270 号 L-2）。
      // [codex 271 号 L] estimated_effort_days 显式写 NULL（NULL 合法不需要 PRAGMA）——不依赖 mkIssue/DDL
      // 默认值，未来默认值变更时"缺失工期"用例仍锚定 NULL；显式覆写场景由下方独立 UPDATE 随后覆盖。
      await run(
        `UPDATE sys_issues SET blocked=?, needs_feasibility=?, feasibility_conclusion=?, feasibility_requirement_confirm=?, feasibility_risk=?, estimated_effort_days=NULL WHERE id=?`,
        [fields.blocked, fields.needs_feasibility, fields.feasibility_conclusion, fields.feasibility_requirement_confirm, fields.feasibility_risk, id]
      );
      // [codex 269 号 M-1 引入·270 号 L-2 收窄] estimated_effort_days 单独一条 UPDATE，**只有调用方显式
      // 传了该覆写键**才执行（用 hasOwnProperty 判定，区别于"传了 undefined"与"根本没传"——后者不该
      // 触碰这一列，保持默认 NULL 且不经过 PRAGMA）。仅这一条 UPDATE 需要 withIgnoredCheckConstraints：
      // 本文件 sys_issues 走全新 CREATE TABLE 路径带 DDL CHECK，直接写非法值（如下方 S1c-工期脏值用的
      // 1.3）会被 SQLite 自身拒绝，测不出"脏值已落库、只能靠服务端 fail-safe 拦"这个只在 ALTER 旧库
      // 路径（无 CHECK，见 C1 既有降级拍板）才会真实出现的场景。写完立刻验证读回值确已生效落库。
      if (Object.prototype.hasOwnProperty.call(overrides || {}, 'estimated_effort_days')) {
        const effortVal = overrides.estimated_effort_days;
        await withIgnoredCheckConstraints(async () => {
          await run(`UPDATE sys_issues SET estimated_effort_days=? WHERE id=?`, [effortVal, id]);
        });
        const check = await get('SELECT estimated_effort_days FROM sys_issues WHERE id=?', [id]);
        assert.strictEqual(check.estimated_effort_days, effortVal, `mkFeasIssue：estimated_effort_days 覆写值应生效落库，期望=${effortVal}，实得=${check.estimated_effort_days}`);
      }
      return id;
    }
    async function assertGateCode(label, id, expectedCode) {
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: `${label}（占位理由）`, self_tested: true, test_env_deployed: true });
      assert.strictEqual(r.status, 400, `${label}：应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, expectedCode, `${label}：错误码应 ${expectedCode}，实际 ${r.body.code}`);
    }
    // 单一违反 → 各自独立错误码
    await assertGateCode('S1c-blocked', await mkFeasIssue({ blocked: 1 }), 'ISSUE_BLOCKED');
    await assertGateCode('S1c-feas缺失', await mkFeasIssue({ feasibility_conclusion: null }), 'FEASIBILITY_REQUIRED');
    // [codex 100 号 LOW] 非法枚举分支（!['可行','有条件可行','不可行'].includes）实证防线而非仅口头声明：
    //   sys_issues.feasibility_conclusion 列带 DB CHECK 约束（IS NULL OR IN (三值)），直接 SQL 造脏即被
    //   SQLITE_CONSTRAINT 拒绝——比应用层闸门更早一步兜底，双重防线下该分支在本测试环境内不可达。
    {
      const idIllegal = await mkFeasIssue({});
      await assert.rejects(
        run(`UPDATE sys_issues SET feasibility_conclusion = ? WHERE id = ?`, ['瞎写的结论', idIllegal]),
        (e) => /SQLITE_CONSTRAINT/.test(e && e.message || ''),
        'S1c-非法枚举防线实证：DB CHECK 约束拒绝非法 feasibility_conclusion 值（SQLITE_CONSTRAINT），证明该分支双重防线成立非空口白说'
      );
    }
    await assertGateCode('S1c-不可行', await mkFeasIssue({ feasibility_conclusion: '不可行' }), 'FEASIBILITY_NOT_FEASIBLE');
    await assertGateCode('S1c-需求理解未填', await mkFeasIssue({ feasibility_requirement_confirm: null }), 'FEASIBILITY_INCOMPLETE');
    await assertGateCode('S1c-需求理解空白', await mkFeasIssue({ feasibility_requirement_confirm: '   ' }), 'FEASIBILITY_INCOMPLETE');
    await assertGateCode('S1c-有条件可行缺风险', await mkFeasIssue({ feasibility_conclusion: '有条件可行', feasibility_risk: null }), 'FEASIBILITY_RISK_REQUIRED');
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] mkFeasIssue 默认不写 estimated_effort_days（列默认
    //   NULL）——一个"仅违反工期必填"的干净夹具天然可由默认参数构造，直接复用同一 assertGateCode 范式验证
    //   submit 端点自身的新增闸（同 S1c 系列其余单条件用例一致的测法，非另起炉灶）。
    await assertGateCode('S1c-工期缺失', await mkFeasIssue({}), 'EFFORT_REQUIRED');
    // [codex 269 号 M-1] 存储值复查——estimated_effort_days 非空但归一失败（脏值 1.3，非 0.5 整数倍）
    // 应报独立码 EFFORT_INVALID（"填了但是坏数据"），与"从没填过"的 EFFORT_REQUIRED 区分开，运维排查
    // 时能分清两类问题。
    await assertGateCode('S1c-工期脏值', await mkFeasIssue({ estimated_effort_days: 1.3 }), 'EFFORT_INVALID');
    // 检查顺序：同时违反多条件，命中最先登记的那一条（对齐旧代码文本顺序）
    {
      const idOrder1 = await mkIssue('feature', '开发中', { devEstimatedAt: null });   // 未估时 + 未来会受阻
      await mkMember(idOrder1, 5, '开发甲', 'pending');
      await run(`UPDATE sys_issues SET blocked=1, needs_feasibility=1, feasibility_conclusion=NULL WHERE id=?`, [idOrder1]);
      await assertGateCode('S1c-顺序①estimate先于blocked', idOrder1, 'ESTIMATE_REQUIRED');
    }
    {
      const idOrder2 = await mkFeasIssue({ blocked: 1, feasibility_conclusion: null });   // 受阻 + 评估缺失
      await assertGateCode('S1c-顺序②blocked先于feasibility', idOrder2, 'ISSUE_BLOCKED');
    }
    {
      const idOrder3 = await mkFeasIssue({ feasibility_conclusion: '不可行', feasibility_requirement_confirm: null });   // 不可行 + 需求理解未填
      await assertGateCode('S1c-顺序③不可行先于需求理解未填', idOrder3, 'FEASIBILITY_NOT_FEASIBLE');
    }
    ok('S1c：资格闸表驱动覆盖全部错误码（ISSUE_BLOCKED/FEASIBILITY_REQUIRED×2/FEASIBILITY_NOT_FEASIBLE/FEASIBILITY_INCOMPLETE×2/FEASIBILITY_RISK_REQUIRED）+ 3 组检查顺序断言，命中顺序与旧代码文本顺序一致');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S2：submit(commits) 正常流
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'frontend', commit_ref: 'feat/abc' }, { component: 'backend', commit_ref: 'r1234' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 200, `S2：submit 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.dev_status, 'code_submitted', 'S2：dev_status=code_submitted');
    const memberRow = await get('SELECT dev_status, resolved_at FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(memberRow.dev_status, 'code_submitted', 'S2：pending→code_submitted');
    assert.ok(memberRow.resolved_at, 'S2：resolved_at 写入');
    const commits = await commitsOf(id);
    assert.strictEqual(commits.length, 2, 'S2：2 条 commit 行落库');
    const events = await devEventsOf(id, 'submit');
    assert.strictEqual(events.length, 1, 'S2：恰 1 条 submit 事件');
    const payload = JSON.parse(events[0].payload_json);
    assert.strictEqual(payload.mode, 'commits', 'S2：事件 payload.mode=commits');
    assert.strictEqual(payload.commits.length, 2, 'S2：payload.commits 数组长度=本事务初始插入行数');
    assert.strictEqual(payload.dev_assignee_id, daId, 'S2：payload.dev_assignee_id 正确');
    assert.strictEqual(r.body.main_status, '待验证', 'S2：唯一在册开发完成 → W-GATE 同事务转待验证');
    await selfCertifyProbes('S2');
    ok('S2：submit(commits) 正常流——pending→code_submitted；2 条 commit 行落库；恰 1 条 submit 事件（payload 数组长度=初始插入行数）；resolved_at 写入；W-GATE 同事务转待验证');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S3：submit(no_code)
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, `S3：缺 no_code_reason 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'S3：错误码 VALIDATION');

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '本轮无需编码', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `S3：no_code 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.dev_status, 'no_code', 'S3：dev_status=no_code');
    const events = await devEventsOf(id, 'no_code');
    assert.strictEqual(events.length, 1, 'S3：恰 1 条 no_code 事件');
    const payload = JSON.parse(events[0].payload_json);
    assert.strictEqual(payload.mode, 'no_code', 'S3：payload.mode=no_code');
    assert.strictEqual(payload.no_code_reason, '本轮无需编码', 'S3：payload.no_code_reason 正确');
    await selfCertifyProbes('S3');
    ok('S3：submit(no_code)——reason 缺→400 VALIDATION；成功→no_code+事件（payload 结构正确）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S4：重复 submit（双击/重试）——单人 roster 变体：族门先拦，不到双条件 UPDATE（見下方 S4b 补真实竞态）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }], self_tested: true, test_env_deployed: true };
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), body);
    assert.strictEqual(r1.status, 200, `S4：首次 submit 应 200，实际 ${r1.status}`);
    const r2 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), body);
    assert.strictEqual(r2.status, 409, `S4：第二次 submit（双击/重试）应 409，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_STATUS', 'S4：错误码 INVALID_STATUS');
    assert.strictEqual(r2.body.error, `当前状态「待验证」不可提交`, 'S4：单人 roster 首次 submit 后 main_status 已转待验证，第二次实际命中 §6.2 步骤2 族门（非双条件 UPDATE），错误信息如实反映');
    const commits = await commitsOf(id);
    assert.strictEqual(commits.length, 1, 'S4：commit 行零重复（仅首次那 1 条）');
    const events = await devEventsOf(id, 'submit');
    assert.strictEqual(events.length, 1, 'S4：submit 事件零重复（仅首次那 1 条）');
    await selfCertifyProbes('S4');
    ok('S4：重复 submit（双击/重试，单人 roster）——第二请求 409 INVALID_STATUS，经由族门（status 已转待验证）；commits/events 零重复行');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S4b：[codex 99 号 MED2① 补强] 双条件 UPDATE 真实竞态——2 名成员，一人已提交一人 pending（main_status
  //   仍「开发中」，未触发家族门），前者重提才能真正命中 §6.2 步骤3 双条件 UPDATE WHERE dev_status='pending'
  //   （changes=0 分支），非 S4 那种"status 已转待验证被族门先拦"的假阳性覆盖
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    await mkMember(id, 6, '开发乙', 'pending');
    // [codex 101 号 MED 回填] updated_at 成功断言——种旧值，isolate submit 自身无条件刷新（本例 GATE 不触发，
    //   main_status 不变，排除 runWGate 自身刷新的干扰，纯验证 submit 端点自身那行 UPDATE）。
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }], self_tested: true, test_env_deployed: true };
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), body);
    assert.strictEqual(r1.status, 200, `S4b：dev5 首次 submit 应 200，实际 ${r1.status}`);
    assert.strictEqual(r1.body.main_status, '开发中', 'S4b：dev6 仍 pending，main_status 未推进（族门不会拦下第二次请求）');
    const afterFirst = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
    assert.notStrictEqual(afterFirst.updated_at, '2020-01-01 00:00:00', 'M2 回填：submit 成功（即便 GATE 未推进主状态）仍无条件刷新 sys_issues.updated_at');
    // 重提前再种一次旧值，验证拒绝路径（changes=0 竞态）整事务回滚不误刷
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    const r2 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r2-重提' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r2.status, 409, `S4b：dev5 重提应 409（真实竞态），实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_STATUS', 'S4b：错误码 INVALID_STATUS（真正命中双条件 UPDATE changes=0，非族门）');
    assert.strictEqual(r2.body.error, '已提交过或状态已变', 'S4b：错误信息对应 §6.2 步骤3 双条件 UPDATE 分支（非步骤2 族门文案）');
    const afterReject = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(afterReject.updated_at, '2020-01-01 00:00:00', 'M2 回填：重提被拒（changes=0）整事务回滚，updated_at 不被误刷');
    const commits = await commitsOf(id);
    assert.strictEqual(commits.length, 1, 'S4b：commit 行零重复（第二次 changes=0 未插入 r2-重提）');
    const events = await devEventsOf(id, 'submit');
    assert.strictEqual(events.filter(e => e.dev_assignee_id === commits[0].dev_assignee_id).length, 1, 'S4b：dev5 的 submit 事件零重复');
    ok('S4b：真实双条件 UPDATE 竞态——2 人 roster 一人已提交一人 pending（main_status 未转，族门不拦），已提交者重提 → 409 INVALID_STATUS 命中 changes=0 分支（非假阳性）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S4c：[codex 99 号 MED2② 补强] 故障注入——commit INSERT / 事件写入 / 后续推进（runWGate UPDATE）三处
  //   分别注入失败，断言整事务回滚：成员 dev_status 仍 pending + commits 零新增 + dev_events 零新增 +
  //   main sys_issues.status 未变（参考 verify-sys-multidev-members.js H2 既有 failure-injection 范式）
  // ══════════════════════════════════════════════════════════════════════
  {
    async function assertFullRollback(label, sqlFragment) {
      const id = await mkIssue('feature', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      injectFailureFired = false;
      injectFailureOnSql = sqlFragment;
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {
        mode: 'commits', commits: [{ component: 'backend', commit_ref: `fi-${label}` }], self_tested: true, test_env_deployed: true,
      });
      assert.strictEqual(r.status, 500, `${label}：故障注入应 500（未预期错误），实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(injectFailureFired, `${label}：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）`);
      injectFailureOnSql = null; injectFailureFired = false;   // 复位，防污染后续用例
      const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
      assert.strictEqual(memberRow.dev_status, 'pending', `${label}：成员 dev_status 回滚仍 pending（§6.2 步骤3 UPDATE 未提交）`);
      const commitRows = await commitsOf(id);
      assert.strictEqual(commitRows.length, 0, `${label}：commit 行零新增（整事务回滚）`);
      const eventRows = await devEventsOf(id, 'submit');
      assert.strictEqual(eventRows.length, 0, `${label}：submit 事件零新增（整事务回滚）`);
      const issueRow = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
      assert.strictEqual(issueRow.status, '开发中', `${label}：main_status 未变（仍开发中，W-GATE 未提交）`);
      ok(`${label}：整事务回滚——成员 dev_status/commits/events/main_status 全部未落库`);
    }
    await assertFullRollback('S4c-commit', 'INSERT INTO sys_issue_dev_commits');
    await assertFullRollback('S4c-event', 'INSERT INTO sys_issue_dev_events');
    // [codex 100 号 HIGH-1 衍生修正] runWGate 的状态 UPDATE 现按目标是否为 VERIFY 动态拼接
    //   `, gate_deferred_at = NULL` 子句（消费 deferred 标记），SQL 文本不再恒为原先的完整字面量——
    //   marker 收窄为前缀 `UPDATE sys_issues SET status = ?`，对两种变体（含/不含该子句）均稳定命中。
    await assertFullRollback('S4c-gate', 'UPDATE sys_issues SET status = ?');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S4e：[codex 102 号 MED 回填] updated_at 回滚断言补真——submit 在"独立 updated_at UPDATE 之后"（即
  //   §6.2 步骤5 之后新增的那条 `UPDATE sys_issues SET updated_at=...`，是本事务最后一条业务 SQL）注入
  //   失败：用 'COMMIT' 作 marker——该事务内其余 SQL 文本均不含此子串，命中的唯一可能是真实提交语句本身，
  //   等价于模拟"提交时失败"，验证连最后一步都会被完整回滚（"已写后回滚"，非 101 号三处用例的
  //   "前置拒绝未误刷"）。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    injectFailureFired = false;
    injectFailureOnSql = 'COMMIT';
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 500, `S4e：故障注入应 500, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(injectFailureFired, 'S4e：确认故障注入真实命中过（防 SQL 片段写错导致测试静默失效）');
    injectFailureOnSql = null; injectFailureFired = false;   // 复位
    const row = await get('SELECT status, updated_at FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(row.status, '开发中', 'S4e：⭐ status 回滚（单人 roster 本应 allComplete 触发 GATE 转待验证，连同回滚未落库）');
    assert.strictEqual(row.updated_at, '2020-01-01 00:00:00', 'S4e：⭐ updated_at 回滚到种子旧值（submit 自身独立 UPDATE + runWGate 的 UPDATE 均随事务回滚，非"从未写过"）');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(memberRow.dev_status, 'pending', 'S4e：成员 dev_status 回滚仍 pending（§6.2 步骤3 UPDATE 随事务回滚）');
    const events = await devEventsOf(id, 'no_code');
    assert.strictEqual(events.length, 0, 'S4e：no_code 事件零残留');
    ok('S4e：submit 独立 updated_at UPDATE 之后于真实 COMMIT 处注入失败 → 整事务回滚，status/updated_at/成员 dev_status/事件全部回到写入前状态（连最后一步提交失败都完整回滚）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S5：D_pre/待验证主状态 submit → 409 INVALID_STATUS（族门）
  // ══════════════════════════════════════════════════════════════════════
  {
    const idPre = await mkIssue('feature', '待指派');
    await mkMember(idPre, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${idPre}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 409, `S5：D_PRE 态 submit 应 409，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S5a：D_PRE 态错误码 INVALID_STATUS');

    const idVerify = await mkIssue('feature', '待验证');
    await mkMember(idVerify, 5, '开发甲', 'code_submitted');
    r = await call('POST', `/api/sys-issues/${idVerify}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 409, `S5：VERIFY 态 submit 应 409，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S5b：VERIFY 态错误码 INVALID_STATUS');
    ok('S5：D_PRE/待验证主状态 submit → 409 INVALID_STATUS（族门，仅 SYS_DEV 放行）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S6：非在册/removed 用户 submit → 403 NOT_ROSTERED
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(6), { mode: 'no_code', no_code_reason: 'x', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 403, `S6：非在册 submit 应 403，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'NOT_ROSTERED', 'S6a：错误码 NOT_ROSTERED（非在册）');

    // removed 用户（曾在册，已移除）
    const removedDaId = await mkMember(id, 8, '开发戊', 'pending', { removedAt: '2026-07-16 09:00:00' });
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(8), { mode: 'no_code', no_code_reason: 'x', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 403, `S6：removed 用户 submit 应 403，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'NOT_ROSTERED', 'S6b：错误码 NOT_ROSTERED（removed 用户）');
    const removedRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [removedDaId]);
    assert.strictEqual(removedRow.dev_status, 'pending', 'S6b：removed 行未被误改');
    ok('S6：非在册/removed 用户 submit → 403 NOT_ROSTERED（assertDevMember 在册判定）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S7：no_code 带非空 commits → 400，无状态变化
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {
      mode: 'no_code', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'r1' }], self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 400, `S7：no_code 带非空 commits 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'S7：错误码 VALIDATION');
    const row = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(row.dev_status, 'pending', 'S7：状态未变化');
    ok('S7：no_code 模式带非空 commits → 400 VALIDATION，无状态变化');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S8：submit 同 component 多条不同 ref → 200 全部落库（commit 记录改造 2026-07-19：删「同 component 至多 1 条」限制）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'backend', commit_ref: 'r1' }, { component: 'backend', commit_ref: 'r2' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 200, `S8：同 component 两条不同 ref 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const row = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(row.dev_status, 'code_submitted', 'S8：唯一在册完成 → dev_status 转 code_submitted');
    const commits = await commitsOf(id);
    const backendRefs = commits.filter(c => c.component === 'backend').map(c => c.commit_ref).sort();
    assert.deepStrictEqual(backendRefs, ['r1', 'r2'], 'S8：同 component 两条不同 ref 全部落库');
    ok('S8：submit 同 component 多条不同 ref → 200 全部落库（分组多行·去「至多 1 条」限制）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S8b：submit 同 component + 同 ref 完全重复行 → 400（自然键查重兜底，防完全重复行）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {
      mode: 'commits',
      commits: [{ component: 'backend', commit_ref: 'dup' }, { component: 'backend', commit_ref: 'dup' }],
      self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 400, `S8b：完全重复行应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'S8b：错误码 VALIDATION（自然键重复）');
    const row = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
    assert.strictEqual(row.dev_status, 'pending', 'S8b：状态未变化（事务整体回滚）');
    ok('S8b：submit 同 component + 同 ref 完全重复 → 400 自然键查重兜底（分组多行仍防完全重复）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S9：门禁——非最后一人完成主状态不动；最后一人完成同事务转待验证
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    await mkMember(id, 6, '开发乙', 'pending');
    // 5 先完成：非最后一人，主状态不动
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `S9a：submit 应 200，实际 ${r.status}`);
    assert.strictEqual(r.body.main_status, '开发中', 'S9a：非最后一人完成，主状态仍开发中');
    let issueRow = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(issueRow.status, '开发中', 'S9a：sys_issues.status 未变');

    // 6 后完成：最后一人，同事务转待验证
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `S9b：submit 应 200，实际 ${r.status}`);
    assert.strictEqual(r.body.main_status, '待验证', 'S9b：最后一人完成，同事务主状态转待验证');
    issueRow = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(issueRow.status, '待验证', 'S9b：sys_issues.status 已落库为待验证');
    await selfCertifyProbes('S9');
    ok('S9：门禁——非最后一人完成主状态不动 + 最后一人完成同事务→待验证（W-GATE）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 附加反例：bug 流 submit（族函数按 type 正确取值，非硬编码变更流状态字符串）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('bug', '处理中');
    await mkMember(id, 5, '开发甲', 'pending');
    // [B4b 全仓扫净] bug 单必填 bug_cause_note（C6 拍板生效后）——本组 mkIssue 默认种 dev_estimated_at，
    //   会真过 ESTIMATE_REQUIRED 闸走到 bug_cause_note 闸，不像 S1b 那条 devEstimatedAt:null 反例在更早
    //   的闸就被拦下（无需补值）。
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'bug 修复无需额外代码提交', self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（multidev-submit）' });
    assert.strictEqual(r.status, 200, `bug submit 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', 'bug 流唯一在册完成 → 待验证（SF.isInFamily 按 type 取值正确）');
    await selfCertifyProbes('bug-submit');
    ok('附加：bug 流 submit——族函数按 issue_type 正确取「处理中」（非硬编码变更流「开发中」字符串）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 附加反例：多余字段 / null 值 / commits 模式禁止携带 no_code_reason → 400 VALIDATION（写库前拒绝）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x', extra_field: 1 });
    assert.strictEqual(r.status, 400, '多余字段应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', '多余字段错误码 VALIDATION');

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: null, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'no_code_reason=null 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'null 值错误码 VALIDATION');

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'r1' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'commits 模式携带 no_code_reason 字段应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'commits 携带 no_code_reason 错误码 VALIDATION');
    ok('附加：多余字段 / null 值 / commits 模式禁止携带 no_code_reason → 均 400 VALIDATION（写库前拒绝，§6.1）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // P4（work_note 工作说明·2026-07-19）：白名单/类型/长度校验 + 落 submit 事件 payload_json + 多开发不覆盖
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① 非法类型：work_note 非 string（数字/对象）→ 400 VALIDATION（不静默吞·§4.3 H-MED）
    let id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: 123, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'P4-①：work_note 非 string(数字) 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'P4-①：错误码 VALIDATION');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: { a: 1 }, self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'P4-①：work_note 对象 应 400');

    // ② 超长：>1000 Unicode 码点 → 400
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '字'.repeat(1001), self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 400, 'P4-②：work_note 超 1000 字应 400');

    // ③ 合法 commits 模式 → 落 submit 事件 payload_json.work_note
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '  前端改了登录页  ', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, `P4-③：合法 commits+work_note 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    let ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id]);
    let pl = JSON.parse(ev.payload_json);
    assert.strictEqual(pl.work_note, '前端改了登录页', 'P4-③：work_note 落 payload_json 且 trim');

    // ④ no_code 模式也落（action='no_code'）
    let id2 = await mkIssue('feature', '开发中');
    await mkMember(id2, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id2}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '无需代码', work_note: '仅配置调整', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'P4-④：no_code+work_note 应 200');
    ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='no_code' ORDER BY id DESC LIMIT 1`, [id2]);
    pl = JSON.parse(ev.payload_json);
    assert.strictEqual(pl.work_note, '仅配置调整', 'P4-④：no_code 事件也落 work_note');

    // ⑤ 空白 work_note → 不落 work_note 键（payload 无该键·后端 undefined→不加）
    let id3 = await mkIssue('feature', '开发中');
    await mkMember(id3, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id3}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '   ', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'P4-⑤：空白 work_note 应 200');
    ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id3]);
    pl = JSON.parse(ev.payload_json);
    assert.ok(!('work_note' in pl), 'P4-⑤：空白 work_note 不落键（payload 无 work_note）');

    // ⑥ 多开发各自 work_note 不覆盖（两 dev 各提交带不同 work_note·各自事件独立）
    let id4 = await mkIssue('feature', '开发中');
    await mkMember(id4, 5, '开发甲', 'pending');
    await mkMember(id4, 6, '开发乙', 'pending');
    await call('POST', `/api/sys-issues/${id4}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'a' }], work_note: '甲的说明', self_tested: true, test_env_deployed: true });
    await call('POST', `/api/sys-issues/${id4}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b' }], work_note: '乙的说明', self_tested: true, test_env_deployed: true });
    const evs = await all(`SELECT e.payload_json, da.user_id FROM sys_issue_dev_events e JOIN sys_issue_dev_assignees da ON da.id=e.dev_assignee_id WHERE e.issue_id=? AND e.action='submit'`, [id4]);
    const wnByUser = {}; evs.forEach(e => { const p = JSON.parse(e.payload_json); wnByUser[e.user_id] = p.work_note; });
    assert.strictEqual(wnByUser[5], '甲的说明', 'P4-⑥：开发甲 work_note 独立');
    assert.strictEqual(wnByUser[6], '乙的说明', 'P4-⑥：开发乙 work_note 不覆盖甲');
    ok('P4：work_note 白名单/非法类型400/超长400/commits+no_code 落 payload_json/空白不落键/多开发各自不覆盖');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S-CHK-L1：[codex 272 号 L-1 锁定] mode-first 既有顺序——结构校验（mode 是否合法）先于字段校验
  //   （双勾是否勾选）。{} 空 body / 非法 mode 即便同时也缺失双勾字段，命中的应是 VALIDATION（mode
  //   校验），不是 SELF_TESTED_REQUIRED——本文件既有契约（validateSubmitBody 内 mode 校验一直排在
  //   双勾校验之前），非本次 C3 新引入，本例把顺序钉死，防未来重构时两段代码顺序被无意调换。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), {});
    assert.strictEqual(r.status, 400, 'S-CHK-L1：空 body 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'S-CHK-L1：空 body 命中 mode 校验 VALIDATION，非 SELF_TESTED_REQUIRED（mode-first 既有顺序）');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'bogus' });
    assert.strictEqual(r.status, 400, 'S-CHK-L1：非法 mode 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'S-CHK-L1：非法 mode 命中 mode 校验 VALIDATION，非 SELF_TESTED_REQUIRED');
    ok('S-CHK-L1：mode-first 既有顺序锁定——{}/非法 mode 命中 VALIDATION，非 SELF_TESTED_REQUIRED（结构校验先于字段校验，本文件既有契约）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S-CHK：[codex 272 号 M-2] 提交双勾表驱动输入矩阵——self_tested/test_env_deployed 各类畸形值精确
  //   分诊 REQUIRED vs INVALID + 拒绝零副作用（dev_events 无新行/dev_status 不变/主状态不变）+
  //   一条通过例验证 payload_json 落库两键=true + 详情端回显 true。矩阵对称性靠两个字段共用同一
  //   assertSubmitChecklistFlag 源码函数保证（源头单元已同构，不必把 8 值 × 2 字段全乘开验证——
  //   真实生产也不会两个字段同时畸形，笛卡尔积测的还是同一段代码路径，无增量信息）。
  //   REQUIRED/INVALID 各例分散在 no_code/commits 两 mode + feature/bug 两 type 上（而非同一组合
  //   反复用），一并覆盖"两 mode 各至少一例 + 两 type 各至少一例"的要求。
  //   [S12 双路审查 Opus-预筛/codex 287 号 C 项收口] 原注释曾写"improvement 与 feature 共享同一份
  //   CHANGE_FLOW_TRANSITIONS 数组（transitions.js 按引用共享）"——该数组 C4 起已拆分为
  //   FEATURE_FLOW_TRANSITIONS/IMPROVEMENT_FLOW_TRANSITIONS 两份独立数组，旧措辞失实，予以订正：
  //   本矩阵测的 assertSubmitChecklistFlag/validateSubmitBody（上方 index.js）是与 issue.type 完全
  //   无关的纯函数——不接 type 参数、不查 transitions 表，对 feature/improvement/bug 一视同仁地跑同
  //   一段判定代码，故 feature/bug 两例已足以证明该函数本身行为正确。但"函数逻辑与 type 无关"是源码
  //   层结论，光看 REQUIRED×3+INVALID×5 全落在 feature/bug 上仍留一条断言缺口（未曾对 improvement
  //   真正发过一次请求）——下方⑤补一条 improvement 定点抽查，把"结论成立"落到"断言也覆盖"。
  // ══════════════════════════════════════════════════════════════════════
  {
    // REQUIRED 分支：缺失/null/false 视为"未勾选"（同 EFFORT_REQUIRED 语义）
    const REQUIRED_CASES = [
      { label: '缺失', has: false, value: undefined },
      { label: 'null', has: true, value: null },
      { label: 'false', has: true, value: false },
    ];
    // INVALID 分支：非 undefined/null/false/true 的其余类型/值视为"畸形输入"（同 EFFORT_INVALID 语义）
    const INVALID_CASES = [
      { label: '数字0', value: 0 },
      { label: '数字1', value: 1 },
      { label: "字符串'true'", value: 'true' },
      { label: '空数组[]', value: [] },
      { label: "字符串'false'", value: 'false' },
    ];

    async function assertRejectedZeroSideEffect(label, issueId, daId, body, expectedCode, mainStatusBefore) {
      const beforeCount = (await devEventsOf(issueId, 'submit')).length + (await devEventsOf(issueId, 'no_code')).length;
      const beforeMember = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
      const r = await call('POST', `/api/sys-issues/${issueId}/submit`, devTok(5), body);
      assert.strictEqual(r.status, 400, `${label}：应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, expectedCode, `${label}：错误码应 ${expectedCode}，实际 ${r.body.code}`);
      const afterCount = (await devEventsOf(issueId, 'submit')).length + (await devEventsOf(issueId, 'no_code')).length;
      assert.strictEqual(afterCount, beforeCount, `${label}：dev_events 零新增`);
      const afterMember = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE id = ?', [daId]);
      assert.strictEqual(afterMember.dev_status, beforeMember.dev_status, `${label}：dev_status 未变（仍 ${beforeMember.dev_status}）`);
      const issueRow = await get('SELECT status FROM sys_issues WHERE id = ?', [issueId]);
      assert.strictEqual(issueRow.status, mainStatusBefore, `${label}：主状态未变（仍 ${mainStatusBefore}）`);
    }

    // ① self_tested REQUIRED 三例（feature + no_code 模式）
    for (const c of REQUIRED_CASES) {
      const id = await mkIssue('feature', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      const body = { mode: 'no_code', no_code_reason: 'x', test_env_deployed: true };
      if (c.has) body.self_tested = c.value;
      await assertRejectedZeroSideEffect(`S-CHK self_tested REQUIRED(${c.label})`, id, daId, body, 'SELF_TESTED_REQUIRED', '开发中');
    }

    // ② self_tested INVALID 五例（bug + commits 模式，与①刻意换 mode/type 组合，不重复同一路径）
    for (const c of INVALID_CASES) {
      const id = await mkIssue('bug', '处理中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: `chk-${c.label}` }], self_tested: c.value, test_env_deployed: true };
      await assertRejectedZeroSideEffect(`S-CHK self_tested INVALID(${c.label})`, id, daId, body, 'SELF_TESTED_INVALID', '处理中');
    }

    // ③ test_env_deployed 同款抽两例（REQUIRED 用缺失·feature/no_code；INVALID 用字符串'true'·bug/commits）——
    //   证明同一分诊逻辑在另一字段上同样成立，矩阵对称性靠 assertSubmitChecklistFlag 这同一函数保证。
    {
      const id = await mkIssue('feature', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      await assertRejectedZeroSideEffect('S-CHK test_env_deployed REQUIRED(缺失)', id, daId, { mode: 'no_code', no_code_reason: 'x', self_tested: true }, 'TEST_ENV_DEPLOYED_REQUIRED', '开发中');
    }
    {
      const id = await mkIssue('bug', '处理中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      await assertRejectedZeroSideEffect("S-CHK test_env_deployed INVALID(字符串'true')", id, daId, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'chk-tev' }], self_tested: true, test_env_deployed: 'true' }, 'TEST_ENV_DEPLOYED_INVALID', '处理中');
    }

    // ④ 一条通过例：双勾均合法 true → payload_json 两键=true + 详情端 dev_assignees[].self_tested/
    //   test_env_deployed 回显 true（写读同源闭环，非只验证事件表落库这一半）。
    {
      const id = await mkIssue('feature', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'S-CHK 通过例', self_tested: true, test_env_deployed: true });
      assert.strictEqual(r.status, 200, `S-CHK 通过例：应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='no_code' ORDER BY id DESC LIMIT 1`, [id]);
      const pl = JSON.parse(ev.payload_json);
      assert.strictEqual(pl.self_tested, true, 'S-CHK 通过例：payload_json.self_tested=true');
      assert.strictEqual(pl.test_env_deployed, true, 'S-CHK 通过例：payload_json.test_env_deployed=true');
      const detail = await call('GET', `/api/sys-issues/${id}`, devTok(5));
      const da = (detail.body.dev_assignees || []).find(d => d.id === daId);
      assert.strictEqual(da && da.self_tested, true, 'S-CHK 通过例：详情端 dev_assignees[].self_tested 回显 true');
      assert.strictEqual(da && da.test_env_deployed, true, 'S-CHK 通过例：详情端 dev_assignees[].test_env_deployed 回显 true');
    }

    // ⑤ [S12 双路审查 codex 287 号 C 项收口] improvement 定点抽查——补上①-④全落在 feature/bug 留下
    //   的断言缺口：证明 REQUIRED 分诊 + 拒绝零副作用 + 通过例写读同源在 improvement 类型上同样成立
    //   （而非仅凭"函数与 type 无关"的源码阅读结论推定）。REQUIRED 用①同款"缺失"值，通过例复用④
    //   同款双键 true 断言，一次覆盖拒绝路径+通过路径两端，不必把 REQUIRED×3/INVALID×5 全套在
    //   improvement 上重跑一遍（那是源码层已证的重复功——见上方注释）。
    {
      const id = await mkIssue('improvement', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      await assertRejectedZeroSideEffect('S-CHK improvement self_tested REQUIRED(缺失)', id, daId, { mode: 'no_code', no_code_reason: 'x', test_env_deployed: true }, 'SELF_TESTED_REQUIRED', '开发中');
    }
    {
      const id = await mkIssue('improvement', '开发中');
      const daId = await mkMember(id, 5, '开发甲', 'pending');
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'S-CHK improvement 通过例', self_tested: true, test_env_deployed: true });
      assert.strictEqual(r.status, 200, `S-CHK improvement 通过例：应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const detail = await call('GET', `/api/sys-issues/${id}`, devTok(5));
      const da = (detail.body.dev_assignees || []).find(d => d.id === daId);
      assert.strictEqual(da && da.self_tested, true, 'S-CHK improvement 通过例：详情端 dev_assignees[].self_tested 回显 true');
      assert.strictEqual(da && da.test_env_deployed, true, 'S-CHK improvement 通过例：详情端 dev_assignees[].test_env_deployed 回显 true');
    }

    ok('S-CHK：提交双勾表驱动输入矩阵——self_tested REQUIRED×3(缺失/null/false)+INVALID×5(0/1/字符串true/空数组/字符串false) + test_env_deployed 同款抽 2 例（REQUIRED+INVALID 各一）+ no_code/commits 两 mode 各覆盖 + feature/bug 两 type 各覆盖 + improvement 定点抽查（REQUIRED+通过例各一，S12 收口）+ 拒绝均零副作用（events/dev_status/主状态三者不变） + 通过例 payload_json 双键落库+详情回显 true（写读同源闭环）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S-CHK-M1：[codex 272 号 M-1 收口] 详情端读侧脏值防线——直接 SQL 造"畸形 payload_json"的 no_code 事件
  //   行（迁移遗留/手工改库等历史脏数据的等效捷径；真实业务路径写不出这类值，写侧 validateSubmitBody
  //   已把关，此处专测"如果历史上真的混进来一条，详情端会不会被 !! 化妆成已确认"）。断言详情端读作
  //   null 而非被 !! 强转误判成 true——M-1 修复前的旧实现（!!raw）在这里会假绿：字符串/数组在 JS 里
  //   都是 truthy。
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'pending');
    // 畸形 payload_json：self_tested 是字符串 'false'（非布尔）、test_env_deployed 是空数组（非布尔）——
    // 两者在 JS 里都是 truthy（!!'false'===true、!![]===true），是 !! 强转会被"化妆成已确认"的典型脏值。
    await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
       VALUES (?, ?, 'no_code', ?, ?, datetime('now'))`,
      [id, daId, 5, JSON.stringify({ mode: 'no_code', no_code_reason: 'M-1 脏值测试', self_tested: 'false', test_env_deployed: [] })]
    );
    const detail = await call('GET', `/api/sys-issues/${id}`, devTok(5));
    const da = (detail.body.dev_assignees || []).find(d => d.id === daId);
    assert.strictEqual(da && da.self_tested, null, `S-CHK-M1：脏值 self_tested='false'(字符串) 详情端应读作 null，非 true（!! 强转会误判 true），实得 ${JSON.stringify(da && da.self_tested)}`);
    assert.strictEqual(da && da.test_env_deployed, null, `S-CHK-M1：脏值 test_env_deployed=[](空数组) 详情端应读作 null，非 true，实得 ${JSON.stringify(da && da.test_env_deployed)}`);

    // 对照组：同一条 SQL 造正常 JSON 原生 true/false 值，确认严格映射没有连合法值也一起拒了——防止
    // "为了堵脏值把好值也堵了"这种矫枉过正的假绿（M-1 只该收紧非法输入，不该收紧合法输入）。
    const id2 = await mkIssue('feature', '开发中');
    const daId2 = await mkMember(id2, 5, '开发甲', 'pending');
    await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
       VALUES (?, ?, 'no_code', ?, ?, datetime('now'))`,
      [id2, daId2, 5, JSON.stringify({ mode: 'no_code', no_code_reason: 'M-1 对照组', self_tested: true, test_env_deployed: false })]
    );
    const detail2 = await call('GET', `/api/sys-issues/${id2}`, devTok(5));
    const da2 = (detail2.body.dev_assignees || []).find(d => d.id === daId2);
    assert.strictEqual(da2 && da2.self_tested, true, `S-CHK-M1 对照组：JSON 原生 true 应正确读作 true，实得 ${JSON.stringify(da2 && da2.self_tested)}`);
    assert.strictEqual(da2 && da2.test_env_deployed, false, `S-CHK-M1 对照组：JSON 原生 false 应正确读作 false（非 null），实得 ${JSON.stringify(da2 && da2.test_env_deployed)}`);

    ok('S-CHK-M1：详情端严格布尔映射——脏值(字符串/空数组)读作 null 非 true（堵审计假阳性）+ 对照组证明合法 true/false 仍正确读回（未矫枉过正）');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-submit 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-submit 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
