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

async function mkIssue(type, status, extra = {}) {
  // [codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED 恢复后，submit 前置要求 dev_estimated_at 非空——本文件
  //   测的是 submit S2-S9 系列（在册/dev_status/commit/事件模型），非 estimate 本身，默认种一个占位值避免
  //   每个用例都被新闸拦下；devEstimatedAt: null 显式传空可测 ESTIMATE_REQUIRED 本身（见 S1b）。
  const est = extra.devEstimatedAt === null ? null : (extra.devEstimatedAt || '2026-07-01 10:00:00');
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?)`,
    [type, status, extra.title || `${type}-${status}-单`, est]
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
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '未填预计（占位理由）' });
    assert.strictEqual(r.status, 400, `S1b：dev_estimated_at 未填 submit 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', 'S1b：错误码 ESTIMATE_REQUIRED');
    const memberRow = await get('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ?', [id]);
    assert.strictEqual(memberRow.dev_status, 'pending', 'S1b：拒绝先于 dev_status UPDATE，仍 pending（整事务回滚）');
    // bug 流同受此闸（旧 case 逐字核对：无 type 限定），补一条 bug 反例
    const idBug = await mkIssue('bug', '处理中', { devEstimatedAt: null });
    await mkMember(idBug, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${idBug}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '未填预计（占位理由）' });
    assert.strictEqual(r.status, 400, `S1b：bug 流同受 ESTIMATE_REQUIRED 约束, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ESTIMATE_REQUIRED', 'S1b：bug 流错误码同为 ESTIMATE_REQUIRED（无 type 限定，逐字核对旧代码）');
    ok('S1b：submit 缺 dev_estimated_at → 400 ESTIMATE_REQUIRED（feature/bug 均受理，旧单人 case 无 type 限定，e39e65b 版 index.js:1376 逐字复刻）');
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
      await run(
        `UPDATE sys_issues SET blocked=?, needs_feasibility=?, feasibility_conclusion=?, feasibility_requirement_confirm=?, feasibility_risk=? WHERE id=?`,
        [fields.blocked, fields.needs_feasibility, fields.feasibility_conclusion, fields.feasibility_requirement_confirm, fields.feasibility_risk, id]
      );
      return id;
    }
    async function assertGateCode(label, id, expectedCode) {
      const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: `${label}（占位理由）` });
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
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code' });
    assert.strictEqual(r.status, 400, `S3：缺 no_code_reason 应 400，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'VALIDATION', 'S3：错误码 VALIDATION');

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '本轮无需编码' });
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
    const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }] };
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
    const body = { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r1' }] };
    const r1 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), body);
    assert.strictEqual(r1.status, 200, `S4b：dev5 首次 submit 应 200，实际 ${r1.status}`);
    assert.strictEqual(r1.body.main_status, '开发中', 'S4b：dev6 仍 pending，main_status 未推进（族门不会拦下第二次请求）');
    const afterFirst = await get('SELECT updated_at FROM sys_issues WHERE id=?', [id]);
    assert.notStrictEqual(afterFirst.updated_at, '2020-01-01 00:00:00', 'M2 回填：submit 成功（即便 GATE 未推进主状态）仍无条件刷新 sys_issues.updated_at');
    // 重提前再种一次旧值，验证拒绝路径（changes=0 竞态）整事务回滚不误刷
    await run(`UPDATE sys_issues SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`, [id]);
    const r2 = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'r2-重提' }] });
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
        mode: 'commits', commits: [{ component: 'backend', commit_ref: `fi-${label}` }],
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
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '完成（占位理由）' });
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
    const idPre = await mkIssue('feature', '待评估');
    await mkMember(idPre, 5, '开发甲', 'pending');
    let r = await call('POST', `/api/sys-issues/${idPre}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x' });
    assert.strictEqual(r.status, 409, `S5：D_PRE 态 submit 应 409，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'INVALID_STATUS', 'S5a：D_PRE 态错误码 INVALID_STATUS');

    const idVerify = await mkIssue('feature', '待验证');
    await mkMember(idVerify, 5, '开发甲', 'code_submitted');
    r = await call('POST', `/api/sys-issues/${idVerify}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x' });
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
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(6), { mode: 'no_code', no_code_reason: 'x' });
    assert.strictEqual(r.status, 403, `S6：非在册 submit 应 403，实际 ${r.status}`);
    assert.strictEqual(r.body.code, 'NOT_ROSTERED', 'S6a：错误码 NOT_ROSTERED（非在册）');

    // removed 用户（曾在册，已移除）
    const removedDaId = await mkMember(id, 8, '开发戊', 'pending', { removedAt: '2026-07-16 09:00:00' });
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(8), { mode: 'no_code', no_code_reason: 'x' });
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
      mode: 'no_code', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'r1' }],
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
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'x' });
    assert.strictEqual(r.status, 200, `S9a：submit 应 200，实际 ${r.status}`);
    assert.strictEqual(r.body.main_status, '开发中', 'S9a：非最后一人完成，主状态仍开发中');
    let issueRow = await get('SELECT status FROM sys_issues WHERE id = ?', [id]);
    assert.strictEqual(issueRow.status, '开发中', 'S9a：sys_issues.status 未变');

    // 6 后完成：最后一人，同事务转待验证
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }] });
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
    const r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: 'bug 修复无需额外代码提交' });
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

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'no_code', no_code_reason: null });
    assert.strictEqual(r.status, 400, 'no_code_reason=null 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'null 值错误码 VALIDATION');

    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', no_code_reason: 'x', commits: [{ component: 'backend', commit_ref: 'r1' }] });
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
    let r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: 123 });
    assert.strictEqual(r.status, 400, 'P4-①：work_note 非 string(数字) 应 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'P4-①：错误码 VALIDATION');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: { a: 1 } });
    assert.strictEqual(r.status, 400, 'P4-①：work_note 对象 应 400');

    // ② 超长：>1000 Unicode 码点 → 400
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '字'.repeat(1001) });
    assert.strictEqual(r.status, 400, 'P4-②：work_note 超 1000 字应 400');

    // ③ 合法 commits 模式 → 落 submit 事件 payload_json.work_note
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '  前端改了登录页  ' });
    assert.strictEqual(r.status, 200, `P4-③：合法 commits+work_note 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    let ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id]);
    let pl = JSON.parse(ev.payload_json);
    assert.strictEqual(pl.work_note, '前端改了登录页', 'P4-③：work_note 落 payload_json 且 trim');

    // ④ no_code 模式也落（action='no_code'）
    let id2 = await mkIssue('feature', '开发中');
    await mkMember(id2, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id2}/submit`, devTok(5), { mode: 'no_code', no_code_reason: '无需代码', work_note: '仅配置调整' });
    assert.strictEqual(r.status, 200, 'P4-④：no_code+work_note 应 200');
    ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='no_code' ORDER BY id DESC LIMIT 1`, [id2]);
    pl = JSON.parse(ev.payload_json);
    assert.strictEqual(pl.work_note, '仅配置调整', 'P4-④：no_code 事件也落 work_note');

    // ⑤ 空白 work_note → 不落 work_note 键（payload 无该键·后端 undefined→不加）
    let id3 = await mkIssue('feature', '开发中');
    await mkMember(id3, 5, '开发甲', 'pending');
    r = await call('POST', `/api/sys-issues/${id3}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'fe1' }], work_note: '   ' });
    assert.strictEqual(r.status, 200, 'P4-⑤：空白 work_note 应 200');
    ev = await get(`SELECT payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='submit' ORDER BY id DESC LIMIT 1`, [id3]);
    pl = JSON.parse(ev.payload_json);
    assert.ok(!('work_note' in pl), 'P4-⑤：空白 work_note 不落键（payload 无 work_note）');

    // ⑥ 多开发各自 work_note 不覆盖（两 dev 各提交带不同 work_note·各自事件独立）
    let id4 = await mkIssue('feature', '开发中');
    await mkMember(id4, 5, '开发甲', 'pending');
    await mkMember(id4, 6, '开发乙', 'pending');
    await call('POST', `/api/sys-issues/${id4}/submit`, devTok(5), { mode: 'commits', commits: [{ component: 'frontend', commit_ref: 'a' }], work_note: '甲的说明' });
    await call('POST', `/api/sys-issues/${id4}/submit`, devTok(6), { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'b' }], work_note: '乙的说明' });
    const evs = await all(`SELECT e.payload_json, da.user_id FROM sys_issue_dev_events e JOIN sys_issue_dev_assignees da ON da.id=e.dev_assignee_id WHERE e.issue_id=? AND e.action='submit'`, [id4]);
    const wnByUser = {}; evs.forEach(e => { const p = JSON.parse(e.payload_json); wnByUser[e.user_id] = p.work_note; });
    assert.strictEqual(wnByUser[5], '甲的说明', 'P4-⑥：开发甲 work_note 独立');
    assert.strictEqual(wnByUser[6], '乙的说明', 'P4-⑥：开发乙 work_note 不覆盖甲');
    ok('P4：work_note 白名单/非法类型400/超长400/commits+no_code 落 payload_json/空白不落键/多开发各自不覆盖');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-submit 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-submit 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
