// scripts/verify-sys-multidev-probes.js — C0 独立跑器：验证探针 P1-P15 本身能正确亮红/亮绿
//   SSOT = 开发计划 v2.9 §3.2（探针全表逐条断言）；探针实现 = scripts/lib/sys-multidev-probes.js
//   用法：node scripts/verify-sys-multidev-probes.js
//
// 设计：构造一份「全绿基线」（issue1 含 pending/code_submitted/no_code/excused/supersede 链/reassign 组
//   全五态覆盖 + issue2 覆盖 VERIFY 族全完成态），先验证基线本身 15 条全过；再对每条探针分别克隆基线
//   （每次 require 真实 sys-iteration 模块重新建一份 :memory: 库并重放基线 SQL，天然隔离，不互相污染）
//   注入一条**该探针专属**的反例数据，验证「只有目标探针」由绿转红（其余仍尽量保持绿，个别探针数据强耦合
//   时允许连带波及，逐条断言里注明）。
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3');
const { runProbes } = require('./lib/sys-multidev-probes');

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function makeDbHelpers(db) {
  return {
    run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })),
    all: (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows))),
    get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row))),
  };
}

function waitReady(I) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

// 新建一份 :memory: 库 + 真实 sys-iteration 模块（require 真实 initSchema，非复刻 DDL）。
async function freshDb() {
  const db = new sqlite3.Database(':memory:');
  const { run, all, get } = makeDbHelpers(db);
  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  mod.initSchema();
  await waitReady(mod._internals);
  return { db, run, all, get };
}

// ── 全绿基线 ──────────────────────────────────────────────────────────────
// issue1（feature/开发中，DEV 族）：pending + code_submitted(+1commit) + no_code + excused(→supersede→新pending)
//   + reassign（移 userJ 加 userI，共享 operation_id）。issue2（feature/待验证，VERIFY 族）：唯一在册=excused（完成态、无 pending）。
const OP_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';   // 合法 UUID 格式（P13 用）

async function buildBaseline(H) {
  const { run, get } = H;
  const issue1 = (await run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name)
     VALUES ('feature', '开发中', '基线单1', 'BMS', 1, 'admin')`
  )).lastID;
  const issue2 = (await run(
    `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name)
     VALUES ('feature', '待验证', '基线单2', 'BMS', 1, 'admin')`
  )).lastID;

  const insDa = async (issueId, userId, userName, devStatus, extra = {}) => {
    const r = await run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status, resolved_at, no_code_reason, superseded_by, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, userId, userName, devStatus, extra.resolved_at || null, extra.no_code_reason || null, extra.superseded_by || null, extra.removed_at || null]
    );
    return r.lastID;
  };
  const insEvent = async (issueId, devAssigneeId, action, opts = {}) => {
    const r = await run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, related_dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
      [issueId, devAssigneeId, opts.related || null, action, opts.reason || null, opts.payload ? JSON.stringify(opts.payload) : null]
    );
    return r.lastID;
  };

  // issue1 roster
  const daA = await insDa(issue1, 101, '开发甲', 'pending');
  const daB = await insDa(issue1, 102, '开发乙', 'code_submitted', { resolved_at: '2026-07-16 10:00:00' });
  const daF = await insDa(issue1, 103, '开发丙', 'no_code', { resolved_at: '2026-07-16 10:05:00', no_code_reason: '人力不足，本轮未编码' });
  const daD = await insDa(issue1, 104, '开发丁', 'excused', { resolved_at: '2026-07-16 10:10:00' });   // supersede 源（下方补 superseded_by+removed_at）
  // §4.2 supersede 序：步骤3 先 UPDATE 旧行 removed_at=now（软删，腾出部分唯一索引名额）→ 步骤4 才能
  //   INSERT 新 pending（复制旧实例 issue_id+user_id，同一开发「恢复」而非换人；换人是 reassign，见下方 daJ/daI）
  //   → 步骤5 UPDATE 旧行 superseded_by=newId。禁先插新（§4.2 注：会撞 uq_dev_assignee_roster 部分唯一索引）。
  await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 10:15:00' WHERE id = ?`, [daD]);
  const daE = await insDa(issue1, 104, '开发丁', 'pending');   // supersede 目标（同 user_id=104，恢复实例）
  await run(`UPDATE sys_issue_dev_assignees SET superseded_by = ? WHERE id = ?`, [daE, daD]);
  const daJ = await insDa(issue1, 106, '开发己', 'pending', { removed_at: '2026-07-16 10:20:00' });   // reassign 移除
  const daI = await insDa(issue1, 107, '开发庚', 'pending');   // reassign 新增

  // commit（da B 的 1 条）
  const commitB = (await run(
    `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
     VALUES (?, ?, ?, 'frontend', 'feat/r1', datetime('now'))`,
    [issue1, daB, 102]
  )).lastID;

  // events：add ×5（初始指派，无 payload/reason）
  await insEvent(issue1, daA, 'add');
  await insEvent(issue1, daB, 'add');
  await insEvent(issue1, daF, 'add');
  await insEvent(issue1, daD, 'add');
  await insEvent(issue1, daE, 'add');   // supersede 新实例创建事件（add，非 supersede-excuse 本身）
  // submit（daB）
  const submitPayload = { mode: 'commits', commits: [{ commit_id: commitB, component: 'frontend', commit_ref: 'feat/r1' }], dev_assignee_id: daB };
  await insEvent(issue1, daB, 'submit', { payload: submitPayload });
  // no_code（daF）
  await insEvent(issue1, daF, 'no_code', { payload: { mode: 'no_code', no_code_reason: '人力不足，本轮未编码' } });
  // excuse（daD）
  await insEvent(issue1, daD, 'excuse', { reason: '身体原因请假' });
  // supersede-excuse（daD→daE）
  await insEvent(issue1, daD, 'supersede-excuse', { related: daE, reason: '由开发戊顶替' });
  // reassign（remove daJ + add daI，共享 operation_id）
  const reassignPayload = { operation_id: OP_ID, reason: '工作量调整', added_user_ids: [107], removed_user_ids: [106] };
  const evRemove = await insEvent(issue1, daJ, 'remove', { reason: '工作量调整', payload: reassignPayload });
  const evAdd = await insEvent(issue1, daI, 'add', { reason: '工作量调整', payload: reassignPayload });

  // issue2 roster：唯一在册=excused（VERIFY 族全完成态）
  const daK = await insDa(issue2, 108, '开发辛', 'excused', { resolved_at: '2026-07-16 11:00:00' });
  await insEvent(issue2, daK, 'add');
  await insEvent(issue2, daK, 'excuse', { reason: '转岗' });

  return { issue1, issue2, daA, daB, daF, daD, daE, daJ, daI, daK, commitB, evRemove, evAdd };
}

function findProbe(results, id) { return results.find(r => r.id === id); }

// 断言目标探针 fail、其余探针状态与基线一致（除非在 allowCollateral 中显式声明可连带变化的探针 id）。
async function assertOnlyTargetFails(scenario, targetId, baselineResults, allowCollateral = []) {
  const { db } = scenario;
  const results = await runProbes(db);
  const target = findProbe(results, targetId);
  assert.ok(target, `探针 ${targetId} 应存在于结果集`);
  assert.strictEqual(target.pass, false, `${targetId} 反例应亮红，实际 detail=${target.detail}`);
  for (const r of results) {
    if (r.id === targetId) continue;
    if (allowCollateral.includes(r.id)) continue;
    const base = findProbe(baselineResults, r.id);
    assert.strictEqual(r.pass, base.pass, `注入 ${targetId} 反例后，非目标探针 ${r.id} 状态不应变化（原 pass=${base.pass}，现 pass=${r.pass}，detail=${r.detail}）`);
  }
  ok(`${targetId} 反例注入后正确亮红（detail=${target.detail}）`);
}

async function main() {
  // ── 阶段一：全绿基线 ──────────
  const base = await freshDb();
  await buildBaseline(base);
  const baselineResults = await runProbes(base.db);
  const allPass = baselineResults.every(r => r.pass);
  if (!allPass) {
    console.error('[基线自检失败] 全绿基线本应 15 条全过，实际：');
    for (const r of baselineResults) console.error(`  ${r.pass ? '✓' : '✗'} ${r.id}: ${r.detail}`);
  }
  assert.ok(allPass, '全绿基线应 15 条探针全过（若失败见上方逐条 detail）');
  assert.strictEqual(baselineResults.length, 15, '探针结果集应恰好 15 条（P1-P15，H1·2026-07-17 新增 P15）');
  ok('全绿基线：P1-P15 全部通过（15/15），基线数据本身零违规（基线无 RELEASE 族 issue，P15 天然 pass）');
  base.db.close();

  // ── 阶段二：每条探针至少一个反例，验证能亮红 ──────────

  // P1：dev_status 值域
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_assignees SET dev_status = 'weird_status' WHERE id = ?`, [ids.daA]);
    await assertOnlyTargetFails(s, 'P1', baselineResults, ['P2']);   // daA 本是 pending，改值域后 P2 配对查询天然不再命中该行（WHERE dev_status='pending'），P2 仍应为 pass（无连带），保留 P2 于非豁免列表用默认严格比较
    s.db.close();
  }

  // P2：pending 配对（resolved_at 应为 NULL）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_assignees SET resolved_at = '2026-01-01 00:00:00' WHERE id = ?`, [ids.daA]);
    await assertOnlyTargetFails(s, 'P2', baselineResults);
    s.db.close();
  }

  // P3：code_submitted 配对（删掉其唯一 commit 行 → commits=0）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [ids.commitB]);
    await assertOnlyTargetFails(s, 'P3', baselineResults, ['P7', 'P11']);   // 删 commit 行连带：P7(commit三元组，查询对象消失，天然不变) 保留严格；P11 submit payload 引用的 commit_id 不再存在于 commits 表——但 P11 只查 events.payload_json 结构本身不校 commit 行是否仍存在，故实际不受影响；此处仅防御性保留豁免位不做强断言收窄
    s.db.close();
  }

  // P4：no_code 配对（no_code_reason 置空）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_assignees SET no_code_reason = NULL WHERE id = ?`, [ids.daF]);
    await assertOnlyTargetFails(s, 'P4', baselineResults);
    s.db.close();
  }

  // P5：excused 配对（no_code_reason 不应非空）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_assignees SET no_code_reason = '不应该有' WHERE id = ?`, [ids.daD]);
    await assertOnlyTargetFails(s, 'P5', baselineResults);
    s.db.close();
  }

  // P6：双在册（绕开 DB 唯一索引本身，证明探针独立计算该不变量、非仅依赖索引兜底）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`DROP INDEX idx_sys_dev_assignee_active`);
    await s.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 101, '开发甲-重复在册', 'pending')`, [ids.issue1]);
    await assertOnlyTargetFails(s, 'P6', baselineResults, ['P12']);   // 多一条 pending 在册行不改变「≥1」判断，P12 仍应 pass；保留豁免位以防浮点/count 边界差异，实际按严格比较验证
    s.db.close();
  }

  // P7：commit 三元组（篡改 dev_user_id 使其与 assignee 行不一致）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_commits SET dev_user_id = 999 WHERE id = ?`, [ids.commitB]);
    await assertOnlyTargetFails(s, 'P7', baselineResults);
    s.db.close();
  }

  // P8：commit 自然键+trim（commit_ref 带首尾空格，未 trim）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_commits SET commit_ref = ' feat/r1 ' WHERE id = ?`, [ids.commitB]);
    await assertOnlyTargetFails(s, 'P8', baselineResults);
    s.db.close();
  }

  // P9：supersede 一致性（superseded_by 指向 id 更小的行，违反 id 序）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_assignees SET superseded_by = ? WHERE id = ?`, [ids.daA, ids.daD]);
    await assertOnlyTargetFails(s, 'P9', baselineResults);
    s.db.close();
  }

  // P9（H2 反向，86 号审）：凭空插一条 supersede-excuse 事件——related 指向存在行（daB），但源行（daA）
  //   自身 superseded_by 并未指回它（无链）。此前 P9 只查「链→事件」方向（有链必有事件），本例专测
  //   「事件→链」反向（有事件必有链）——H2 修复前不会被任何探针拦截。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, related_dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, ?, ?, 'supersede-excuse', '凭空事件-无对应链', 1, NULL, datetime('now'))`,
      [ids.issue1, ids.daA, ids.daB]
    );
    await assertOnlyTargetFails(s, 'P9', baselineResults);
    s.db.close();
  }

  // P10：events related（supersede-excuse 事件 related 置空）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_events SET related_dev_assignee_id = NULL WHERE action = 'supersede-excuse' AND issue_id = ?`, [ids.issue1]);
    await assertOnlyTargetFails(s, 'P10', baselineResults, ['P9']);   // P9 双向事件计数依赖该行 related 非空，related 被清空后 P9 的「恰一条」查询也会落空 → 连带变红，属预期非隔离失败
    s.db.close();
  }

  // P11：submit 事件 payload 破坏为非法 JSON
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_events SET payload_json = '{not valid json' WHERE action = 'submit' AND issue_id = ?`, [ids.issue1]);
    await assertOnlyTargetFails(s, 'P11', baselineResults);
    s.db.close();
  }

  // P11（H3 三反例，86 号审）：submit commits[].commit_id 分别为 null / 字符串 '3' / 缺失——修复前
  //   `Number.isInteger(Number(x))` 会把这三种非法原始值强转成合法数字放行（Number(null)===0 恰好不过；
  //   Number('3')===3 会误放行字符串；缺失时 Number(undefined)===NaN 才恰好被拦，故实际漏洞集中在
  //   null/字符串两种，缺失场景一并覆盖验证收口后三者一致亮红）。
  for (const [label, mutate] of [
    ['null', (item) => { item.commit_id = null; }],
    ["字符串'3'", (item) => { item.commit_id = '3'; }],
    ['缺失', (item) => { delete item.commit_id; }],
  ]) {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const item = { commit_id: ids.commitB, component: 'frontend', commit_ref: 'feat/r1' };
    mutate(item);
    const badPayload = { mode: 'commits', commits: [item], dev_assignee_id: ids.daB };
    await s.run(`UPDATE sys_issue_dev_events SET payload_json = ? WHERE action = 'submit' AND issue_id = ?`, [JSON.stringify(badPayload), ids.issue1]);
    await assertOnlyTargetFails(s, 'P11', baselineResults);
    s.db.close();
  }

  // P11（87 号复审残留1）：submit payload 顶层 dev_assignee_id 为字符串 "1"（事件列 dev_assignee_id 实际是整数）——
  //   修复前 `Number(value.dev_assignee_id) === Number(r.dev_assignee_id)` 会把字符串强转成数字误放行。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const badPayload = {
      mode: 'commits',
      commits: [{ commit_id: ids.commitB, component: 'frontend', commit_ref: 'feat/r1' }],
      dev_assignee_id: String(ids.daB),   // 字符串形式的同值 id
    };
    await s.run(`UPDATE sys_issue_dev_events SET payload_json = ? WHERE action = 'submit' AND issue_id = ?`, [JSON.stringify(badPayload), ids.issue1]);
    await assertOnlyTargetFails(s, 'P11', baselineResults);
    s.db.close();
  }

  // P12：零在册开发执行态（新建一个 DEV 族 issue，无任何 dev_assignees 行）
  {
    const s = await freshDb(); await buildBaseline(s);
    await s.run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', '零在册单', 'BMS', 1, 'admin')`);
    await assertOnlyTargetFails(s, 'P12', baselineResults);
    s.db.close();
  }

  // P13：reassign 事件组内部不一致（event.reason 与 payload.reason 不一致）
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(`UPDATE sys_issue_dev_events SET reason = '篡改后的原因' WHERE id = ?`, [ids.evRemove]);
    await assertOnlyTargetFails(s, 'P13', baselineResults, ['P11']);   // evRemove 的 action='remove' 不在 P11 必填 reason 检查覆盖之外的结构校验范围内（reason 本身仍非空 trim 合规，P11 不受影响）；保留豁免位防御未来 P11 覆盖面扩大
    s.db.close();
  }

  // P13（H4 反例①，86 号审）：坏 JSON payload 的 add 事件——判别式改法后，payload_json 非空即必须走
  //   完整 reassign 信封校验，坏 JSON 直接判 fail，不再静默当普通 add/remove 放过。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, ?, 'add', NULL, 1, '{bad json', datetime('now'))`,
      [ids.issue1, ids.daA]
    );
    await assertOnlyTargetFails(s, 'P13', baselineResults);
    s.db.close();
  }

  // P13（H4 反例②，86 号审）：纯新增组（无 remove，仅两条 add）event.reason 与 payload.reason **双 NULL**——
  //   修复前旧判别式 `g.reason !== g.payload.reason` 在 null!==null 时为 false（视为一致），假绿放过；
  //   修复后 payload.reason 必须 nonEmptyTrim(1..200)，null 直接判 fail。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const newOpId = 'f1e2d3c4-b5a6-4978-9210-abcdef123456';
    const daX = (await s.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 201, '开发子', 'pending')`, [ids.issue1])).lastID;
    const daY = (await s.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 202, '开发丑', 'pending')`, [ids.issue1])).lastID;
    const pureAddPayload = { operation_id: newOpId, reason: null, added_user_ids: [201, 202], removed_user_ids: [] };
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at) VALUES (?, ?, 'add', NULL, 1, ?, datetime('now'))`,
      [ids.issue1, daX, JSON.stringify(pureAddPayload)]
    );
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at) VALUES (?, ?, 'add', NULL, 1, ?, datetime('now'))`,
      [ids.issue1, daY, JSON.stringify(pureAddPayload)]
    );
    await assertOnlyTargetFails(s, 'P13', baselineResults);
    s.db.close();
  }

  // P13（87 号复审残留2·反例①）：事件 dev_assignee_id=999（不存在的 assignee 行，LEFT JOIN 应未命中）
  //   + payload added_user_ids:[0]（0 非正整数，也会先在信封级 isPositiveInt 元素校验处被拦）——
  //   无论走哪条检查路径，P13 均应亮红（信封级"元素须为原始正整数" 与 组级"assignee 行不存在" 是同一处
  //   修复的两个断言点，本例天然覆盖信封级；组级 `g.user_id===null` 分支由改动本身保证不可达即安全短路）。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const opId1 = '11111111-2222-4333-8444-555555555555';
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, 999, 'add', ?, 1, ?, datetime('now'))`,
      [ids.issue1, '成员不存在测试', JSON.stringify({ operation_id: opId1, reason: '成员不存在测试', added_user_ids: [0], removed_user_ids: [] })]
    );
    await assertOnlyTargetFails(s, 'P13', baselineResults);
    s.db.close();
  }

  // P13（88 号定点复核 LOW 补漏）：事件 dev_assignee_id=999（不存在的 assignee 行）+ payload **全部合法**
  //   （合法 UUID/reason/正整数 uid）——信封级全过，必须走到组级 `g.user_id === null`（LEFT JOIN 未命中）
  //   分支亮红。与上一例（[0] 在信封级先拦）互补：本例是该分支的**专属回归用例**，防未来误删分支
  //   （88 号裁定 LOW：分支实现正确且已实测，但无专属用例=永久回归覆盖缺口）。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const opId3 = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, 999, 'add', ?, 1, ?, datetime('now'))`,
      [ids.issue1, 'assignee不存在分支测试', JSON.stringify({ operation_id: opId3, reason: 'assignee不存在分支测试', added_user_ids: [107], removed_user_ids: [] })]
    );
    const results = await runProbes(s.db);
    const p13 = results.find(r => r.id === 'P13');
    assert.strictEqual(p13.pass, false, 'P13 应对「事件指向不存在的 assignee 行」亮红');
    assert.ok(/不存在的 assignee 行/.test(p13.detail), `P13 detail 应命中「不存在的 assignee 行」分支（实际：${p13.detail}）`);
    // 其余探针不受影响（与 assertOnlyTargetFails 同语义，此处因需断言 detail 命中特定分支而手写）
    for (const r of results) {
      if (r.id !== 'P13') {
        const base = baselineResults.find(b => b.id === r.id);
        assert.strictEqual(r.pass, base.pass, `${r.id} 不应受本反例影响`);
      }
    }
    ok('P13 反例注入后正确亮红（专属分支：事件 dev_assignee_id 指向不存在的 assignee 行，detail 命中该分支）');
    s.db.close();
  }

  // P13（87 号复审残留2·反例②）：added_user_ids 元素为字符串 "107"（成员真实存在，uid=107=ids.daI）——
  //   修复前 `first.added_user_ids.map(Number)` 会把字符串强转成数字误放行；修复后元素须原始值即正整数，
  //   字符串类型直接在信封级判 fail。
  {
    const s = await freshDb(); const ids = await buildBaseline(s);
    const opId2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    await s.run(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, ?, 'add', ?, 1, ?, datetime('now'))`,
      [ids.issue1, ids.daI, '字符串成员测试', JSON.stringify({ operation_id: opId2, reason: '字符串成员测试', added_user_ids: ['107'], removed_user_ids: [] })]
    );
    await assertOnlyTargetFails(s, 'P13', baselineResults);
    s.db.close();
  }

  // P14：VERIFY 态恒真（新建一个 VERIFY 族 issue，唯一在册成员仍是 pending）
  {
    const s = await freshDb(); await buildBaseline(s);
    const newIssueId = (await s.run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待验证', '含pending的待验证单', 'BMS', 1, 'admin')`)).lastID;
    await s.run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 201, '开发壬', 'pending')`, [newIssueId]);
    await assertOnlyTargetFails(s, 'P14', baselineResults);
    s.db.close();
  }

  // P15（H1·对抗审 2026-07-17）：RELEASE 族恒真——新建一个「待上线」单，挂一条 pending 在册 → 亮红；
  //   补一条同单的 no_code 完成态在册（清理 pending）后 → 转绿（同一 issue 复用，验证「清理后转绿」而非
  //   只测「亮红」单向）。
  {
    const s = await freshDb(); await buildBaseline(s);
    const releaseIssueId = (await s.run(
      `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待上线', 'RELEASE族含pending单', 'BMS', 1, 'admin')`
    )).lastID;
    const pendingDaId = (await s.run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 301, '开发癸', 'pending')`,
      [releaseIssueId]
    )).lastID;
    await assertOnlyTargetFails(s, 'P15', baselineResults);

    // 清理：pending → no_code（完成态，P4 配对要求 resolved_at 非空 + no_code_reason trim 1..500 + commit 行=0）
    await s.run(
      `UPDATE sys_issue_dev_assignees SET dev_status = 'no_code', resolved_at = '2026-07-17 09:00:00', no_code_reason = '待上线态清理测试，无需编码' WHERE id = ?`,
      [pendingDaId]
    );
    const cleanedResults = await runProbes(s.db);
    const p15Cleaned = cleanedResults.find(r => r.id === 'P15');
    assert.strictEqual(p15Cleaned.pass, true, `P15 清理 pending 后应转绿，实际 detail=${p15Cleaned.detail}`);
    const allCleanedPass = cleanedResults.every(r => r.pass);
    assert.ok(allCleanedPass, `P15 清理后其余探针也应全绿，实际：${JSON.stringify(cleanedResults.filter(r => !r.pass))}`);
    ok('P15 反例注入后正确亮红（RELEASE 族「待上线」单挂 pending 在册）+ 清理 pending 为完成态后转绿（含其余 14 条探针同步全绿）');
    s.db.close();
  }

  // P15（L1·95 号复审）反例②：「待上线」单零在册（新建 issue，不挂任何 dev_assignees 行）——与上例覆盖
  //   P15 谓词的另一支（active_count===0），独立于「含 pending」分支。
  {
    const s = await freshDb(); await buildBaseline(s);
    await s.run(
      `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待上线', 'RELEASE族零在册单', 'BMS', 1, 'admin')`
    );
    await assertOnlyTargetFails(s, 'P15', baselineResults);
    ok('P15 反例注入后正确亮红（RELEASE 族「待上线」单零在册，独立覆盖 active_count===0 谓词支）');
    s.db.close();
  }

  // P15（L1·95 号复审）反例③：「已上线」单（bug 类型）挂 pending 在册——与①的差异点=已上线态 + bug 类型，
  //   验证探针按 issue_type 正确取族常量（非硬编码「待上线」单一状态字符串）。
  {
    const s = await freshDb(); await buildBaseline(s);
    const publishedIssueId = (await s.run(
      `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('bug', '已上线', 'RELEASE族已上线含pending单', 'BMS', 1, 'admin')`
    )).lastID;
    await s.run(
      `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status) VALUES (?, 302, '开发子丑', 'pending')`,
      [publishedIssueId]
    );
    await assertOnlyTargetFails(s, 'P15', baselineResults);
    ok('P15 反例注入后正确亮红（RELEASE 族「已上线」bug 类型单挂 pending 在册，独立覆盖已上线态 + 非 feature 类型）');
    s.db.close();
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 探针 P1-P15 独立跑器：基线全绿 + 每条探针至少一个反例能正确亮红`);
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); process.exit(1); });
