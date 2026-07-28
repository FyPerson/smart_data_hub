// scripts/verify-sys-multidev-read.js — C1 验收：读模型（多人 chip + commit 行展示，计划 §4 / 方案 §13 S1）
//   用法：node scripts/verify-sys-multidev-read.js
//
// C1 范围 = 纯读模型（不碰任何写入口）：
//   [1] 详情 GET dev_assignees 三新列（dev_status/resolved_at/no_code_reason）+ 值正确
//   [2] 详情 GET dev_commits 全量含 removed 实例的行 + 按 id 升序 + JOIN dev_user_name 正确
//   [3] 列表 GET dev_roster_names（json_group_array JSON 数组协议，按 user_id 升序，仅在册；89 号 LOW-1 后
//       弃 GROUP_CONCAT 逗号协议）正确 + 含英文逗号 user_name 不被拆分 + assigned_to_name 兼容保留
//   [4] 写读同源：3 个 mutation 响应生产者（path A 建单 / assign / reassign，89 号 MED 后参数化全覆盖）
//       各自与详情 GET 的 dev_assignees 列集（key 集合）一致（防 4 处同款全列 mirror 漂移，任一处漏改在此暴露）
//   种子数据全部满足四态配对不变量，seed 后跑 P1-P15 探针自证（89 号 LOW-2）
//
// in-process express app（挂真实 router）+ 内存库 + 自签 token，照 verify-sys-release.js 范式。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { runProbes } = require('./lib/sys-multidev-probes');   // LOW-2（89 号审）：种子自证——seed 后跑一遍探针，非新增探针

const SECRET = 'verify-sys-multidev-read-secret';
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

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'), (5,'devwang','开发王','user'), (6,'devli','开发李','user')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });

  // ── 种子1：raw SQL 直插（C2-C7 写入口未接线，只能绕过写路径造数据）──────────
  //   issue1（feature/开发中）：da1(pending,在册) / da2(code_submitted,在册,primary) / da3(code_submitted,已软删,挂commit)
  //   / da4(no_code,在册，合法配对)。
  //   ⚠️ LOW-2（89 号审）：原种子让软删实例 da3 走 no_code 但仍挂 commit 行——违反 P4「no_code ⇒ commit=0」
  //   四态配对不变量（种子数据本身不应违反探针，探针要测的是"探针能拦截违规"而非"日常读模型种子先天带病"）。
  //   改：挂 commit 的软删实例改 code_submitted（P3「code_submitted ⇒ resolved_at 非空∧commit≥1」，与已挂
  //   commit 天然吻合，且 P3 不看 removed_at，软删实例同样受检）；no_code 场景改用**新增的在册** da4（resolved_at+
  //   no_code_reason 齐全+0 commit，满足 P4），验证详情 GET 正确回显 no_code_reason。
  const issue1 = (await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, assigned_to, assigned_to_name)
     VALUES ('feature', '开发中', 'C1读模型验证单', 'BMS', '内部', 1, '管理员', 5, '开发王')`
  )).lastID;
  const da1 = (await run(   // user_id=6，pending，在册
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, 6, '开发李', 0, 'pending')`,
    [issue1]
  )).lastID;
  const da2 = (await run(   // user_id=5，code_submitted，在册，代表（is_primary 仅供参考展示，前端不得展示"主开发"字样）
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at) VALUES (?, 5, '开发王', 1, 'code_submitted', '2026-07-20 10:00:00')`,
    [issue1]
  )).lastID;
  const da3 = (await run(   // user_id=9，code_submitted（LOW-2 改），已软删（不应出现在 dev_assignees，但其 commit 行应仍出现在 dev_commits）
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, removed_at)
     VALUES (?, 9, '开发孙(已移除)', 0, 'code_submitted', '2026-07-19 08:30:00', '2026-07-19 09:00:00')`,
    [issue1]
  )).lastID;
  const da4 = (await run(   // user_id=10，no_code，在册（LOW-2 新增，合法配对：resolved_at+no_code_reason 齐全+0 commit）
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason)
     VALUES (?, 10, '开发赵', 0, 'no_code', '2026-07-20 09:00:00', '临时抽调支援其他项目，本轮未编码')`,
    [issue1]
  )).lastID;
  const c1 = (await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 5, 'backend', 'bk/r2', datetime('now'))`,
    [issue1, da2]
  )).lastID;
  const c2 = (await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 5, 'frontend', 'fe/r1', datetime('now'))`,
    [issue1, da2]
  )).lastID;
  const c3 = (await run(   // 挂在已软删实例 da3 上
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at) VALUES (?, ?, 9, 'frontend', 'fe/removed-inst', datetime('now'))`,
    [issue1, da3]
  )).lastID;
  // P4（work_note 读回·codex 审 LOW-2）：给 da2(在册·code_submitted) 插 submit 事件带 work_note、给 da4(在册·no_code)
  //   插 no_code 事件**无** work_note 键——验证详情端补查：有值正确回填 + 空白场景 work_note/submitted_at 成对 null。
  //   再给 da2 插一条更早的 submit 事件（旧 work_note）验证 MAX(id) 取最新（打回重提交语义）。
  //   payload 结构须满足 P11 探针（submit：mode=commits+commits≥1+commit_id 正整数唯一+component 枚举+commit_ref 合法
  //   +dev_assignee_id 严格等于事件行；no_code：no_code_reason 非空）——补齐结构后额外挂 work_note 键。
  await run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
             VALUES (?, ?, 'submit', 5, '{"mode":"commits","commits":[{"commit_id":${c1},"component":"backend","commit_ref":"bk/r2"}],"dev_assignee_id":${da2},"work_note":"旧版说明(应被覆盖)"}', '2026-07-20 09:00:00')`, [issue1, da2]);
  await run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
             VALUES (?, ?, 'submit', 5, '{"mode":"commits","commits":[{"commit_id":${c2},"component":"frontend","commit_ref":"fe/r1"}],"dev_assignee_id":${da2},"work_note":"开发王的最新工作说明"}', '2026-07-20 10:00:00')`, [issue1, da2]);
  await run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
             VALUES (?, ?, 'no_code', 10, '{"mode":"no_code","no_code_reason":"临时抽调支援其他项目，本轮未编码"}', '2026-07-20 09:00:00')`, [issue1, da4]);
  ok('种子1：issue1（4 名 dev_assignees：pending/code_submitted/已软删code_submitted/no_code，四态配对全合法）+ 3 条 commit（含 1 条挂软删实例）+ P4 work_note 事件（da2 两条 submit 取最新/da4 no_code 无 work_note）造数完成');

  // LOW-2（89 号审）自证：种子必须全部满足 P1-P15 恒真——直接跑一遍既有探针（非新增探针，复用 C0 交付物）。
  const seedProbeResults = await runProbes(db);
  const seedProbeFailed = seedProbeResults.filter(p => !p.pass);
  assert.strictEqual(seedProbeFailed.length, 0, `种子数据应满足全部 P1-P15 恒真，实际失败：${JSON.stringify(seedProbeFailed)}`);
  ok('LOW-2 自证：种子数据跑 runProbes 全绿（P1-P15 全过，四态配对/commit 归属等恒真不变量均满足）');

  // ── [1]+[2] 详情 GET ──────────
  let r = await call('GET', `/api/sys-issues/${issue1}`, adminTok);
  assert.strictEqual(r.status, 200, `详情 GET 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
  // [codex 101 号 LOW 回填] gate_deferred_at 是内部实现标记，不应随 SELECT * 泄露给前端读模型。
  assert.ok(!('gate_deferred_at' in r.body.issue), 'LOW 回填：详情 GET 响应体 issue 对象不应含 gate_deferred_at 字段（内部 GATE 标记不进读模型）');
  const devAssignees = r.body.dev_assignees;
  assert.ok(Array.isArray(devAssignees), 'dev_assignees 应为数组');
  assert.strictEqual(devAssignees.length, 3, `dev_assignees 应仅含 3 条在册行（da1/da2/da4，da3 已软删应被 removed_at IS NULL 过滤），实际 ${devAssignees.length}`);
  const byId = new Map(devAssignees.map(d => [d.id, d]));
  assert.ok(byId.has(da1) && byId.has(da2) && byId.has(da4), 'dev_assignees 应含 da1(pending)/da2(code_submitted)/da4(no_code)');
  assert.ok(!byId.has(da3), 'dev_assignees 不应含已软删的 da3');
  assert.strictEqual(byId.get(da1).dev_status, 'pending', 'da1.dev_status 应为 pending');
  assert.strictEqual(byId.get(da1).resolved_at, null, 'da1.resolved_at 应为 NULL（pending 未解决）');
  assert.strictEqual(byId.get(da1).no_code_reason, null, 'da1.no_code_reason 应为 NULL');
  assert.strictEqual(byId.get(da2).dev_status, 'code_submitted', 'da2.dev_status 应为 code_submitted');
  assert.strictEqual(byId.get(da2).resolved_at, '2026-07-20 10:00:00', 'da2.resolved_at 应回显种子值');
  assert.strictEqual(byId.get(da4).dev_status, 'no_code', 'da4.dev_status 应为 no_code');
  assert.ok(byId.get(da4).no_code_reason && byId.get(da4).no_code_reason.length > 0, `da4（合法在册 no_code 成员）详情 GET 应回显非空 no_code_reason，实际：${byId.get(da4).no_code_reason}`);
  ok('[1] 详情 GET dev_assignees 三新列（dev_status/resolved_at/no_code_reason）值正确 + 仅在册 3 条（软删 da3 排除）+ 合法 no_code 成员 no_code_reason 非空回显');

  // ── [1b] P4 work_note 读回（codex 审 LOW-2）：详情端补查 json_extract + MAX(id) 取最新 + 空白成对 null ──────────
  assert.strictEqual(byId.get(da2).work_note, '开发王的最新工作说明', 'P4：da2 详情 work_note 应取最新 submit 事件（MAX(id)·打回重提交语义·非旧版）');
  assert.strictEqual(byId.get(da2).work_note_submitted_at, '2026-07-20 10:00:00', 'P4：da2 work_note_submitted_at 应为最新事件时刻');
  assert.strictEqual(byId.get(da4).work_note, null, 'P4：da4（no_code 事件无 work_note 键）work_note 应为 null');
  assert.strictEqual(byId.get(da4).work_note_submitted_at, null, 'P4·LOW-1：da4 无 work_note 时 submitted_at 也成对为 null（不返回"有时刻无内容"脏字段）');
  assert.strictEqual(byId.get(da1).work_note, null, 'P4：da1（pending·无 submit 事件）work_note 应为 null');
  assert.strictEqual(byId.get(da1).work_note_submitted_at, null, 'P4：da1 无事件 submitted_at 应为 null');
  ok('[1b] P4 work_note 读回：da2 取最新 submit work_note+时刻 / da4 无 work_note 键→成对 null / da1 无事件→null（LOW-1 成对语义 + LOW-2 详情读回全覆盖）');

  const devCommits = r.body.dev_commits;
  assert.ok(Array.isArray(devCommits), 'dev_commits 应为数组');
  assert.strictEqual(devCommits.length, 3, `dev_commits 应含全部 3 条（含挂软删实例的 c3），实际 ${devCommits.length}`);
  assert.deepStrictEqual(devCommits.map(c => c.id), [c1, c2, c3], 'dev_commits 应按 id 升序');
  assert.strictEqual(devCommits.find(c => c.id === c3).dev_user_name, '开发孙(已移除)', 'c3（挂软删实例）JOIN dev_user_name 应仍正确解析（JOIN 不受 removed_at 影响）');
  assert.strictEqual(devCommits.find(c => c.id === c1).dev_user_name, '开发王', 'c1 dev_user_name 应正确 JOIN');
  ok('[2] 详情 GET dev_commits 全量含 removed 实例行（c3）+ 按 id 升序 + JOIN dev_user_name 正确');

  // ── [3] 列表 GET ──────────
  r = await call('GET', '/api/sys-issues', adminTok);
  assert.strictEqual(r.status, 200, `列表 GET 应 200，实际 ${r.status}`);
  const listRow = r.body.items.find(it => it.id === issue1);
  assert.ok(listRow, '列表应含 issue1');
  // LOW-1（89 号审）：dev_roster_names 协议改 JSON 数组字符串（非逗号拼接明文），前端 JSON.parse 消费。
  const rosterNames1 = JSON.parse(listRow.dev_roster_names);
  assert.deepStrictEqual(rosterNames1, ['开发王', '开发李', '开发赵'], `dev_roster_names 应按 user_id 升序（5=开发王/6=开发李/10=开发赵）且排除软删 da3，实际：${listRow.dev_roster_names}`);
  assert.strictEqual(listRow.assigned_to_name, '开发王', 'assigned_to_name 字段应兼容保留不动');
  ok(`[3] 列表 GET dev_roster_names 正确（JSON 数组 ${listRow.dev_roster_names}，按 user_id 升序+仅在册）+ assigned_to_name 兼容保留`);

  // ── [3b] LOW-1 反例：user_name 含英文逗号不应被错误拆分（JSON 数组协议天然免疫，逗号拼接明文才会拆错）──────────
  const issue3 = (await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name)
     VALUES ('feature', '开发中', 'C1逗号防拆分验证单', 'BMS', '内部', 1, '管理员')`
  )).lastID;
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 11, '开发,备份账号', 'pending')`,
    [issue3]
  );
  r = await call('GET', '/api/sys-issues', adminTok);
  const listRow3 = r.body.items.find(it => it.id === issue3);
  assert.ok(listRow3, '列表应含 issue3');
  const rosterNames3 = JSON.parse(listRow3.dev_roster_names);
  assert.deepStrictEqual(rosterNames3, ['开发,备份账号'], `含英文逗号的 user_name 应保持单个完整元素不被拆分，实际：${JSON.stringify(rosterNames3)}`);
  ok(`[3b] LOW-1：user_name 含英文逗号（"开发,备份账号"）JSON 数组协议下未被错误拆分（仍是单个数组元素）`);

  // ── [4] 写读同源：mutation 响应与详情 GET 的 dev_assignees 列集一致（防镜像漂移）──────────
  //   MED（89 号审）：原来只测了 /assign 一处，其余 3 处同款全列镜像（path A 建单 / reassign / 详情 GET 自身）
  //   未被验证覆盖——参数化跑全部 3 个 mutation 响应生产者（path A / assign / reassign），各自与详情 GET 比较。
  async function assertMirrorKeys(label, mutationRow, issueId) {
    assert.ok(mutationRow, `${label}：mutation 响应应含至少 1 条 dev_assignees`);
    const mutationKeys = Object.keys(mutationRow).sort();
    const rDetail = await call('GET', `/api/sys-issues/${issueId}`, adminTok);
    assert.strictEqual(rDetail.status, 200, `${label}：详情 GET 应 200`);
    assert.ok(Array.isArray(rDetail.body.dev_assignees) && rDetail.body.dev_assignees.length >= 1, `${label}：详情 dev_assignees 应至少 1 条`);
    // P4：详情端在 fetchActiveDevAssignees 基础列集之上**合并**详情专属增强列（work_note/work_note_submitted_at，
    //   由详情端单独补查 dev_events payload_json·mutation 响应无此需求不带）。故断言从「完全相等」放宽为
    //   「detail = mutation ∪ 已知详情专属列」——基础列集仍防漂移（mutation⊆detail 且差集只能是白名单增强列）。
    const DETAIL_ONLY_KEYS = ['work_note', 'work_note_submitted_at'];   // P4 详情端专属增强（唯一允许的差集）
    const detailKeys = Object.keys(rDetail.body.dev_assignees[0]).sort();
    const detailBaseKeys = detailKeys.filter(k => !DETAIL_ONLY_KEYS.includes(k));
    assert.deepStrictEqual(mutationKeys, detailBaseKeys, `${label}：mutation 响应与详情 GET 的 dev_assignees **基础列集**应完全一致（防镜像漂移·排除 P4 详情专属列 ${DETAIL_ONLY_KEYS.join('/')}），mutation=${JSON.stringify(mutationKeys)} detailBase=${JSON.stringify(detailBaseKeys)}`);
    // 详情端应恰好含 P4 两增强列（防补查逻辑漏挂/字段名漂移）
    assert.ok(DETAIL_ONLY_KEYS.every(k => detailKeys.includes(k)), `${label}：详情 GET 的 dev_assignees 应含 P4 增强列 ${DETAIL_ONLY_KEYS.join('/')}`);
    assert.ok(mutationKeys.includes('dev_status') && mutationKeys.includes('resolved_at') && mutationKeys.includes('no_code_reason'),
      `${label}：mutation 响应列集应含 C1 新增三列（否则前端拿 mutation 响应刷详情会丢新字段）`);
    ok(`[4] 写读同源（${label}）：mutation 基础列集与详情一致（${mutationKeys.join(',')}）+ 详情专属增强 ${DETAIL_ONLY_KEYS.join('/')}`);
  }

  // [4a] ⭐ 角色权限重构 C0：path A（建单同时指派）**结构性关闭**——受理门恒开 ⟹ 400 INTAKE_WITH_ASSIGN_CONFLICT。
  //   原断言"path A 建单响应的 dev_assignees[0] 含全部镜像列"随之作废；**镜像列覆盖未丢失**——
  //   建单已不可能带 dev_assignees，该镜像契约的唯一入口是 assign 端点，由紧邻的 [4b] 完整覆盖。
  r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'C1镜像-pathA', system_name: 'BMS', source: '内部', assign_mode: 'A', assigned_to: 5 });
  assert.strictEqual(r.status, 400, `C0：path A 建单应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'INTAKE_WITH_ASSIGN_CONFLICT', 'C0：path A code=INTAKE_WITH_ASSIGN_CONFLICT');

  // [4b] assign（既有覆盖，保留）
  r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'C1镜像-assign', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, `建单应 201，实际 ${r.status} ${JSON.stringify(r.body)}`);
  const issue2 = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段，直接受理。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${issue2}/intake-accept`, adminTok, {});
  await call('POST', `/api/sys-issues/${issue2}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${issue2}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, `补 OA 号应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${issue2}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `assign 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
  await assertMirrorKeys('assign', (r.body.dev_assignees || [])[0], issue2);

  // [4c] reassign（C2 破坏性变更：改声明式最终 roster member_ids+reason，见方案 §3；本文件既有测试变更清单——
  //   原用 newAssignedTo/oldAssignedTo 换主语义）：先建单→排期→指派 5 号推进到「开发中」，再改派到仅 [6]
  //   （移除 5、新增 6）触发一次差量。
  r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'C1镜像-reassign', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, `建单应 201，实际 ${r.status} ${JSON.stringify(r.body)}`);
  const issue4 = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段，直接受理。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${issue4}/intake-accept`, adminTok, {});
  await call('POST', `/api/sys-issues/${issue4}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  const oa4 = await call('POST', `/api/sys-issues/${issue4}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(oa4.status, 200, `补 OA 号应 200，实际 ${oa4.status} ${JSON.stringify(oa4.body)}`);
  await call('POST', `/api/sys-issues/${issue4}/assign`, adminTok, { assigned_to: 5 });
  r = await call('POST', `/api/sys-issues/${issue4}/reassign`, adminTok, { member_ids: [6], reason: '测试改派以验证镜像一致性' });
  assert.strictEqual(r.status, 200, `reassign 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
  await assertMirrorKeys('reassign', (r.body.dev_assignees || [])[0], issue4);

  // ── [codex C3 对抗审 HIGH-B 回填] 在册成员读可见性 ──────────
  //   SSOT 依据（方案 v2.9 line 33）："开发=在册∧pending；历史参与=子表曾有行且当前不在册——只读整单+可下
  //   附件，无任何写权"；line 88："`assigned_to` 禁作授权源"。issue1 的 roster 恰好覆盖三类用户（种子1）：
  //   user6=da1(pending,在册,非代表)；user9=da3(已软删,历史参与)；user5=da2(在册,代表,assigned_to=5)。
  //   补一个真正的"非成员"（user 20，从未在 issue1 的 dev_assignees 出现过）作对照组。
  {
    const dev6Tok = jwt.sign({ id: 6, username: 'devli', display_name: '开发李', role: 'user' }, SECRET);
    const dev9Tok = jwt.sign({ id: 9, username: 'devsun', display_name: '开发孙', role: 'user' }, SECRET);
    const nonMemberTok = jwt.sign({ id: 20, username: 'outsider', display_name: '路人', role: 'user' }, SECRET);

    // 非代表在册成员（user6，pending，非 assigned_to）：列表可见 + 详情 200 + dev_assignees 数据完整可读
    let r = await call('GET', '/api/sys-issues', dev6Tok);
    assert.strictEqual(r.status, 200, `HIGH-B：非代表在册成员(user6)列表查询应 200, got ${r.status}`);
    assert.ok(r.body.items.some(x => x.id === issue1), 'HIGH-B：⭐ 非代表在册成员(user6，pending，非 assigned_to)列表应可见 issue1（此前只认 assigned_to 会看不到）');
    r = await call('GET', `/api/sys-issues/${issue1}`, dev6Tok);
    assert.strictEqual(r.status, 200, `HIGH-B：⭐ 非代表在册成员(user6)详情应 200（此前会 403）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.dev_assignees) && r.body.dev_assignees.length === 3, 'HIGH-B：非代表在册成员详情响应 dev_assignees 数据完整（3 条在册行，与 admin 视角一致，非降级/裁剪响应）');

    // 历史参与（user9，已软删/removed_at 非空）：按 SSOT 字面定义"只读整单"——列表可见 + 详情 200
    r = await call('GET', '/api/sys-issues', dev9Tok);
    assert.strictEqual(r.status, 200, `HIGH-B：历史参与(user9)列表查询应 200, got ${r.status}`);
    assert.ok(r.body.items.some(x => x.id === issue1), 'HIGH-B：⭐ 历史参与(user9，removed_at 非空)列表应可见 issue1（SSOT line 33"只读整单"字面定义）');
    r = await call('GET', `/api/sys-issues/${issue1}`, dev9Tok);
    assert.strictEqual(r.status, 200, `HIGH-B：⭐ 历史参与(user9)详情应 200（SSOT"只读整单"，非仅"可下附件"）, got ${r.status} ${JSON.stringify(r.body)}`);

    // 非成员（user20，从未在 issue1 的 dev_assignees 出现过）：列表不可见 + 详情 403（既有行为不变）
    r = await call('GET', '/api/sys-issues', nonMemberTok);
    assert.strictEqual(r.status, 200, `HIGH-B：非成员列表查询应 200（返回空集非拒绝）, got ${r.status}`);
    assert.ok(!r.body.items.some(x => x.id === issue1), 'HIGH-B：⭐ 非成员(user20)列表不应看到 issue1（既有行为不变，未被本次改动误放宽）');
    r = await call('GET', `/api/sys-issues/${issue1}`, nonMemberTok);
    assert.strictEqual(r.status, 403, `HIGH-B：⭐ 非成员(user20)详情应仍 403, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_TO_VIEW', 'HIGH-B：非成员详情错误码 NOT_AUTHORIZED_TO_VIEW（既有行为不变）');

    ok('HIGH-B：⭐ 在册成员读可见性——非代表在册成员(pending)+历史参与(已移除)列表/详情均可见（SSOT line 33/88 依据），非成员仍 403（既有行为零回归）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ C1 读模型验证通过（详情 dev_assignees 三新列 + dev_commits 含软删实例升序 + 列表 dev_roster_names(JSON 数组协议) + 写读同源列集一致[path A/assign/reassign 三处] + 在册/历史参与读可见性）`);
  server.close();
  db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
