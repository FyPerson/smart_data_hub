// 验证脚本：系统迭代模块 sys 四表 schema（C1）
//   方案：docs/local/系统迭代/系统迭代_方案_20260624_v1.6.md §4.1-§4.4
//   实施：docs/local/系统迭代/系统迭代_编码实施方案_20260624_v1.3.md §3.5
//   用法：node scripts/verify-sys-schema.js
//
// RC-L2 根治：require routes/sys-iteration/index.js 真实 mod.initSchema()（db helper 注入本脚本 :memory: db），
//   测的是真实建表 DDL（与断言期望清单漂移即暴露），非复刻一份 DDL。
//
// C1 断言覆盖：4 表存在 + 关键列齐（含 effected_at，11-M1）+ 索引建上 + readiness 三态（干净库 ready / 缺列库 false）
//   + 建表顺序不报错 + 三侧通知 5 列全量（07-M3）+ 枚举 CHECK 生效（type/source/priority/event_type/attachment_type/
//   release status/三侧 notify_status）+ config release_id 永空 DB CHECK（12-H2）+ FK 定义正确性（测试期）+
//   默认值（priority/三侧通知/计数/record_source）+ _internals KEY_COLS 与真实表同源。
//   ⚠️ HTTP 503 等 C2 真端点（C1 空 router 无业务端点，07-L1）。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// 注入最小 deps（C1 档：logger/db/dbXxxAsync/authenticateToken/requireAdmin）+ require 真实 sys-iteration 模块
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
};
const mod = require('../routes/sys-iteration')(deps);
const I = mod._internals;
function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时未就绪')); }
    }, 10);
  });
}

const EXPECTED_INDEXES = [
  'idx_sys_releases_status',
  'idx_sys_issues_status', 'idx_sys_issues_type', 'idx_sys_issues_system',
  'idx_sys_issues_assigned', 'idx_sys_issues_release', 'idx_sys_issues_origin',
  'idx_sys_timeline_issue', 'idx_sys_attach_issue',
  'idx_sys_dev_assignees_issue', 'idx_sys_dev_assignee_active',   // 通知改造 C1a 新表（后者=部分唯一索引，G12）
  // ── 上线体统一重构 C0（方案 v3.4 §6.1/§6.2/§6.13，2026-07-28）新增 4 索引 ──────────
  'idx_sys_releases_assignee',       // sys_releases.release_assignee_id（旧库 ALTER 后建，见 [1a-10]）
  'idx_sys_duty_roster_active',      // 排班表：部分唯一索引（duty_date, WHERE removed_at IS NULL）
  'idx_sys_duty_roster_user',        // 排班表：(user_id, duty_date)
  'idx_sys_timeline_action_ref',     // sys_issue_timeline(ref_id, action_code)，配 §6.13 反查双条件
  // ── 上线执行人多选与多人双确认（方案 20260806 v1.7 §4.1，C0）新增 3 索引 ──────────
  'idx_sys_release_exec_active',     // sys_release_executors：部分唯一索引 (release_id,user_id) WHERE removed_at IS NULL（代次语义闸）
  'idx_sys_release_exec_release',    // sys_release_executors：(release_id, removed_at)
  'idx_sys_release_exec_user',       // sys_release_executors：(user_id, exec_status)
];

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
  // FK 强制（SQLite 默认 OFF）。⚠️ 边界：生产 server.js 未启用 FK（仅结构声明），本脚本启用仅为测 FK 定义拼对。
  await run('PRAGMA foreign_keys = ON');
  mod.initSchema();           // 真实建表（替代复刻 DDL）
  await waitReady();
  ok('四表 + 索引建立成功（真实 initSchema，FK 强制已开，仅测试期验 FK 定义正确性）+ readiness ready=true');

  // [0] _internals KEY_COLS 与本脚本期望同源（防真实建表与断言期望漂移）
  assert.ok(Array.isArray(I.SYS_ISSUES_KEY_COLS) && I.SYS_ISSUES_KEY_COLS.length > 0, '_internals 导出 SYS_ISSUES_KEY_COLS');
  ok(`_internals.SYS_ISSUES_KEY_COLS 就绪（${I.SYS_ISSUES_KEY_COLS.length} 列，readiness 校验锚点）`);

  // [1] 五表存在（通知改造 C1a 新增 sys_issue_dev_assignees）
  const tables = (await all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sys_releases','sys_issues','sys_issue_timeline','sys_issue_attachments','sys_issue_dev_assignees')"
  )).map(r => r.name);
  assert.strictEqual(tables.length, 5, `应有 5 表，实际 ${tables.length}: ${tables.join(',')}`);
  ok(`五表存在：${tables.sort().join(' / ')}`);

  // [1-C2a] 角色权限重构 C2a：物删审计表结构与约束（本文件是"约束漂移"的权威检查点——
  //   readiness 按既有分工只查表在/列在，CHECK/NOT NULL/UNIQUE 一律由本脚本守，见 index.js initSchema 头部注释）。
  //   ⚠️ 这条断言的真实用途是**防止 CHECK 被人从建表语句里删掉**：审计表的 reason 是"不可逆删除必须说明原因"
  //   这条契约的 DB 兜底，端点层校验只覆盖走端点的写入，运维直连 SQLite / 未来新端点会绕开它。
  //   ⚠️ 它**测不到**"生产库里已存在一张无 CHECK 的旧表"——`CREATE TABLE IF NOT EXISTS` 对已存在表 no-op，
  //   本脚本每次跑在全新库上。那个场景由**部署前提**兜：C2a 首次部署前须确认生产无 sys_issue_delete_audit
  //   （方案 v1.7 §14 部署清单）。codex C2a 复审 MED 记录在案。
  const auditSql = (await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issue_delete_audit'") || {}).sql || '';
  assert.ok(auditSql, 'sys_issue_delete_audit 表应存在（C2a 物删审计）');
  assert.ok(/CHECK\s*\(\s*length\s*\(\s*trim\s*\(\s*reason\s*\)\s*\)\s*BETWEEN\s*1\s*AND\s*200\s*\)/i.test(auditSql),
    `sys_issue_delete_audit.reason 必须带 DB 层 CHECK(trim 后 1..200)，实际建表语句：${auditSql}`);
  for (const c of ['issue_json', 'timeline_json', 'attachments_json', 'operator_id', 'operator_name', 'reason', 'deleted_at']) {
    assert.ok(new RegExp(`${c}[^,]*NOT NULL`, 'i').test(auditSql), `sys_issue_delete_audit.${c} 必须 NOT NULL（审计行不允许半空）`);
  }
  assert.strictEqual((await all("PRAGMA foreign_key_list(sys_issue_delete_audit)")).length, 0,
    '⭐ 审计表不得有外键——它必须在被审计的业务行消失之后继续存在');
  ok('⭐ C2a 物删审计表：reason DB 层 CHECK(trim 1..200) + 七列 NOT NULL + 零外键（约束漂移由本脚本守，非 readiness）');

  // [2] sys_issues 关键列齐全（含三侧通知锚点 + effected_at）
  const issueColRows = await all('PRAGMA table_info(sys_issues)');
  const issueCols = issueColRows.map(r => r.name);
  const missingKey = I.SYS_ISSUES_KEY_COLS.filter(c => !issueCols.includes(c));
  assert.strictEqual(missingKey.length, 0, `_internals KEY_COLS 在真实表缺失: ${missingKey.join(',')}`);
  ok(`sys_issues._internals KEY_COLS 全部存在于真实建表（readiness 校验与真实 schema 同源，含 effected_at/三侧锚点）`);

  // [2a1] codex 末次合并审 MED 收口：release_assignee_id/name 现为被消费热路径列（C3b execute-release 判执行权
  //   + C4 列表 SELECT/详情可见性读），必须入 readiness 锚点——否则 mid-migration 崩溃后 readiness 误报 ready → 列表 500。
  assert.ok(I.SYS_ISSUES_KEY_COLS.includes('release_assignee_id') && I.SYS_ISSUES_KEY_COLS.includes('release_assignee_name'),
    'release_assignee_id/name 必须在 SYS_ISSUES_KEY_COLS（被 C3b/C4 消费，readiness 须守）');
  ok('release_assignee_id/name 已入 readiness 锚点（末次合并审 MED：被消费列须守，防部分迁移误 ready→列表 500）');

  // [2a2] 通知改造 follow-up（2026-07-07）第 5 类「通知上线开发」：release_assignee_notify_* 5 列**整组**入 readiness 锚点
  //   （codex 43 HIGH 采纳·防御加固——本类采全列锚点范式，区别于 relay/creator 历史只锚 status）。
  for (const c of ['release_assignee_notify_status', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_read_at']) {
    assert.ok(I.SYS_ISSUES_KEY_COLS.includes(c), `${c} 必须在 SYS_ISSUES_KEY_COLS（第 5 类通知 5 列整组入锚点，codex 43 HIGH）`);
  }
  ok('release_assignee_notify_* 5 列整组已入 readiness 锚点（codex 43 HIGH 采纳·防御加固，本类全列锚点范式）');

  // [2b] 三侧通知 5 列全量校验（07-M3：readiness 抽样只查 status，verify 查全 5 列 ×3）
  for (const prefix of ['', 'requester_', 'creator_']) {
    const five = [`${prefix}notify_status`, `${prefix}notified_at`, `${prefix}notify_message_key`, `${prefix}notify_error`, `${prefix}read_at`];
    const miss = five.filter(c => !issueCols.includes(c));
    assert.strictEqual(miss.length, 0, `${prefix || 'dev'} 侧通知 5 列缺失: ${miss.join(',')}`);
  }
  ok('三侧通知各 5 列全量齐全（dev/requester/creator × status/notified_at/message_key/error/read_at，07-M3）');

  // [2c] 可行性评估 7 列全量存在（F1 §2.1；readiness 只抽 3 锚点，verify 验全 7 列）
  const FEASIBILITY_COLS = ['needs_feasibility', 'feasibility_conclusion', 'feasibility_requirement_confirm', 'feasibility_risk', 'blocked', 'blocked_reason', 'blocked_at'];
  const missFeas = FEASIBILITY_COLS.filter(c => !issueCols.includes(c));
  assert.strictEqual(missFeas.length, 0, `可行性评估列缺失: ${missFeas.join(',')}`);
  ok(`可行性评估 7 列齐全（needs_feasibility/feasibility_conclusion/requirement_confirm/risk/blocked/blocked_reason/blocked_at，F1 §2.1）`);

  // [3] sys_issues 核心 NOT NULL 列
  const ISSUE_NOTNULL = ['type', 'status', 'title', 'system_name', 'source', 'created_by', 'created_by_name', 'record_source', 'reopen_count', 'return_count', 'scope_changed', 'notify_status', 'requester_notify_status', 'creator_notify_status', 'needs_feasibility', 'blocked'];
  const nnBroken = ISSUE_NOTNULL.filter(c => { const d = issueColRows.find(x => x.name === c); return !d || d.notnull !== 1; });
  assert.strictEqual(nnBroken.length, 0, `sys_issues NOT NULL 约束缺失: ${nnBroken.join(',')}`);
  ok(`sys_issues 核心 NOT NULL 约束生效（${ISSUE_NOTNULL.length} 列：type/status/title/system_name/source/created_by(_name)/record_source/三计数/三通知/评估两闸门列 needs_feasibility·blocked，codex 18 M-1）`);

  // [4] 索引齐全（15 个，通知改造 C1a 新增 dev_assignees ×2 + 上线体统一重构 C0 新增 4）
  const idxRows = (await all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sys%'")).map(r => r.name);
  const missingIdx = EXPECTED_INDEXES.filter(i => !idxRows.includes(i));
  assert.strictEqual(missingIdx.length, 0, `索引缺失: ${missingIdx.join(',')}`);
  ok(`${EXPECTED_INDEXES.length} 索引齐全（releases ×1 + issues ×6 + timeline ×1 + attach ×1 + dev_assignees ×2[含部分唯一索引] + 上线体统一重构 C0 新增 4[releases_assignee/duty_roster×2/timeline_action_ref] + 上线执行人多选 C0 新增 3[release_exec_active(部分唯一)/release/user]）`);

  // ── 各表合法插入需要的最小列工具 ──
  const insIssue = (extra = '', cols = '', vals = []) =>
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name${cols ? ', ' + cols : ''}) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin'${cols ? ', ' + extra : ''})`, vals);

  // [5] type CHECK：4 类合法 + 非法拒
  for (const t of ['bug', 'feature', 'improvement', 'config']) {
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES (?, '待处理', 't', 'BMS', 1, 'admin')`, [t]);
  }
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('task', '待处理', 't', 'BMS', 1, 'admin')`), /CHECK|constraint/i, 'type=task 应被 CHECK 拒');
  ok('type CHECK：bug/feature/improvement/config 4 类可写，非法 type=task 被拒');

  // [6] source CHECK：三选一合法 + 非法拒 + 默认 '内部'
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, source) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', '业务方')`);
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, source) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', '第三方')`), /CHECK|constraint/i, 'source=第三方 应被 CHECK 拒');
  // 默认值用专门的标记单（title='DEFAULTS' 唯一定位，不被上面 source='业务方' 单干扰）
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待评估', 'DEFAULTS', 'BMS', 1, 'admin')`);
  const srcDefault = await get(`SELECT source, priority, record_source, reopen_count, return_count, scope_changed, notify_status, requester_notify_status, creator_notify_status FROM sys_issues WHERE title='DEFAULTS'`);
  assert.strictEqual(srcDefault.source, '内部', `source 默认应 内部，实际 ${srcDefault.source}`);
  assert.strictEqual(srcDefault.priority, 'P2', `priority 默认应 P2，实际 ${srcDefault.priority}`);
  assert.strictEqual(srcDefault.record_source, 'native', `record_source 默认应 native，实际 ${srcDefault.record_source}`);
  assert.strictEqual(srcDefault.reopen_count, 0, 'reopen_count 默认 0');
  assert.strictEqual(srcDefault.return_count, 0, 'return_count 默认 0');
  assert.strictEqual(srcDefault.scope_changed, 0, 'scope_changed 默认 0');
  assert.strictEqual(srcDefault.notify_status, 'not_sent', 'notify_status 默认 not_sent');
  assert.strictEqual(srcDefault.requester_notify_status, 'not_sent', 'requester_notify_status 默认 not_sent');
  assert.strictEqual(srcDefault.creator_notify_status, 'not_sent', 'creator_notify_status 默认 not_sent');
  ok('source CHECK（业务方/内部/生产故障）+ 默认值：source=内部/priority=P2/record_source=native/三计数=0/三通知=not_sent');

  // [7] priority CHECK：P0-P3 合法 + 非法拒
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, priority) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 'P0')`);
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, priority) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 'P5')`), /CHECK|constraint/i, 'priority=P5 应被 CHECK 拒');
  ok('priority CHECK：P0-P3 合法，P5 被拒');

  // [8] 三侧 notify_status CHECK
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, notify_status) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 'pending')`), /CHECK|constraint/i, 'notify_status=pending 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, requester_notify_status) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 'unknown')`), /CHECK|constraint/i, 'requester_notify_status=unknown 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, creator_notify_status) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 'x')`), /CHECK|constraint/i, 'creator_notify_status=x 应被 CHECK 拒');
  ok('三侧 notify_status CHECK：not_sent/sent/failed 之外的值（dev/requester/creator）全被拒');

  // [9] ⭐ config release_id 永空 DB CHECK（12-H2）：config 带 release_id 被拒，非 config 可带
  //   先建一个批次供 release_id 引用（FK 已开，需真实 release id）
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-20260625-1', 1, 'admin')`);
  const relId = (await get(`SELECT id FROM sys_releases WHERE release_no='R-20260625-1'`)).id;
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, release_id) VALUES ('config', '待处理', 't', 'OA', 1, 'admin', ?)`, [relId]),
    /CHECK|constraint/i, 'config 带 release_id 应被 DB CHECK 拒（12-H2）');
  // 非 config（feature）可带 release_id
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, release_id) VALUES ('feature', '待上线', 't', 'BMS', 1, 'admin', ?)`, [relId]);
  // config 不带 release_id 正常写入
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('config', '待处理', 't', 'OA', 1, 'admin')`);
  const configBad = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE type='config' AND release_id IS NOT NULL`);
  assert.strictEqual(configBad.c, 0, 'config 单不应存在带 release_id 的记录');
  ok('config release_id 永空 DB CHECK（12-H2）：config 带 release_id 被拒，feature 可带，不存在 config+release_id');

  // [9b] ⭐ 可行性评估 CHECK + 默认值（F1 §2.1）
  //   needs_feasibility/blocked 硬 CHECK(0,1)（codex 17 M-2：承担 submit 闸门逻辑，不照 scope_changed 无 CHECK 范式）
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_feasibility) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 1)`);
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_feasibility) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 2)`), /CHECK|constraint/i, 'needs_feasibility=2 应被 CHECK(0,1) 拒');
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, blocked) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', 1)`);
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, blocked) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', -1)`), /CHECK|constraint/i, 'blocked=-1 应被 CHECK(0,1) 拒');
  //   显式插 NULL 被 NOT NULL 拒（codex 18 M-1：运行语义覆盖，防未来误删 NOT NULL 后 DEFAULT 0 兜底使断言假绿）
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_feasibility) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', NULL)`), /NOT NULL|constraint/i, 'needs_feasibility=NULL 应被 NOT NULL 拒');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, blocked) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', NULL)`), /NOT NULL|constraint/i, 'blocked=NULL 应被 NOT NULL 拒');
  //   feasibility_conclusion 枚举 CHECK（三值合法 + NULL 合法 + 非法拒）
  for (const c of ['可行', '有条件可行', '不可行']) {
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, feasibility_conclusion) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', ?)`, [c]);
  }
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, feasibility_conclusion) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', '待定')`), /CHECK|constraint/i, 'feasibility_conclusion=待定 应被 CHECK 拒');
  //   显式边界（对抗审 verify-coverage low：直接覆盖 CHECK 的 IS NULL 分支 + IN(0,1) 下界 0，不只靠默认值间接覆盖）
  await assert.doesNotReject(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, feasibility_conclusion) VALUES ('feature', '开发中', 't', 'BMS', 1, 'admin', NULL)`), '显式 feasibility_conclusion=NULL 应合法（CHECK IS NULL 分支）');
  await assert.doesNotReject(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_feasibility, blocked) VALUES ('feature', '待评估', 't', 'BMS', 1, 'admin', 0, 0)`), '显式 needs_feasibility=0/blocked=0 应合法（CHECK IN(0,1) 下界）');
  //   默认值（专用 FEAS_DEFAULTS 标记单复查，不被上面带值单干扰）
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '待评估', 'FEAS_DEFAULTS', 'BMS', 1, 'admin')`);
  const feasDef = await get(`SELECT needs_feasibility, blocked, feasibility_conclusion FROM sys_issues WHERE title='FEAS_DEFAULTS'`);
  assert.strictEqual(feasDef.needs_feasibility, 0, 'needs_feasibility 默认 0');
  assert.strictEqual(feasDef.blocked, 0, 'blocked 默认 0');
  assert.strictEqual(feasDef.feasibility_conclusion, null, 'feasibility_conclusion 默认 NULL');
  ok('可行性评估 CHECK + NOT NULL + 默认 + 显式边界：needs_feasibility/blocked CHECK(0,1) 拒 2/-1 + 显式 NULL 被 NOT NULL 拒 + 显式 0 合法 + feasibility_conclusion 枚举拒非法 + 显式 NULL 合法 + 默认 needs_feasibility=0/blocked=0/conclusion=NULL');

  // [9c] ⭐ bug 流 Commit ① 新列（bug流_方案_20260702_v1.2 §9）——新库 CREATE 路径全量断言
  //   （readiness 只抽 4+1 锚点；此处验全 9+1 列 + needs_release CHECK + 默认 NULL；旧库 ALTER 路径见 verify-sys-bug-migration.js）
  const BUGFLOW_COLS = ['needs_release', 'related_correction_no', 'derive_reason', 'fix_gap_note',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'];
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    const missBug = BUGFLOW_COLS.filter(c => !nowCols.includes(c));
    assert.strictEqual(missBug.length, 0, `bug 流新列缺失: ${missBug.join(',')}`);
    const relCols2 = (await all('PRAGMA table_info(sys_releases)')).map(r => r.name);
    assert.ok(relCols2.includes('release_type'), 'sys_releases.release_type 缺失');
  }
  //   needs_release CHECK（新库路径）：NULL/0/1 合法，2 拒
  await assert.doesNotReject(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_release) VALUES ('bug', '待上线', 't', 'BMS', 1, 'admin', 1)`), 'needs_release=1 应合法');
  await assert.doesNotReject(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_release) VALUES ('bug', '待上线', 't', 'BMS', 1, 'admin', 0)`), 'needs_release=0 应合法');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_release) VALUES ('bug', '待上线', 't', 'BMS', 1, 'admin', 2)`), /CHECK|constraint/i, 'needs_release=2 应被 CHECK 拒（新库路径）');
  //   默认值：全 NULL（无 DEFAULT 回填面，BUGFLOW_DEFAULTS 标记单）
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('bug', '待处理', 'BUGFLOW_DEFAULTS', 'BMS', 1, 'admin')`);
  const bugDef = await get(`SELECT needs_release, related_correction_no, derive_reason, fix_gap_note, dingtalk_chat_id FROM sys_issues WHERE title='BUGFLOW_DEFAULTS'`);
  for (const [k, v] of Object.entries(bugDef)) assert.strictEqual(v, null, `${k} 默认应 NULL`);
  const relTypeDef = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-20260625-1'`);
  assert.strictEqual(relTypeDef.release_type, null, 'release_type 默认 NULL（值域非空由 ② 服务端守卫强制）');
  ok('⭐ bug 流 Commit ① 新列（新库路径）：9+1 列齐全 + needs_release CHECK（NULL/0/1 合法·2 拒）+ 默认全 NULL + release_type 默认 NULL');

  // [9d] ⭐ 通知改造 Commit C1a 新列（新库路径）——relay 7 + requester 快照 2 + release_assignee 2 = 11 列全量断言
  const NOTIFY_REWORK_COLS = ['relay_notified_user_id', 'relay_notified_at', 'relay_read_at', 'relay_notify_status',
    'relay_notify_message_key', 'relay_notify_error', 'relay_notified_user_name',
    'requester_notify_phone_snapshot', 'requester_notify_ding_uid',
    'release_assignee_id', 'release_assignee_name'];
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    const missNotify = NOTIFY_REWORK_COLS.filter(c => !nowCols.includes(c));
    assert.strictEqual(missNotify.length, 0, `通知改造新列缺失: ${missNotify.join(',')}`);
  }
  //   relay_notify_status CHECK（同三侧 notify_status 处理）+ 默认 not_sent
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, relay_notify_status) VALUES ('bug', '待处理', 't', 'BMS', 1, 'admin', 'pending')`), /CHECK|constraint/i, 'relay_notify_status=pending 应被 CHECK 拒');
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('bug', '待处理', 'NOTIFY_DEFAULTS', 'BMS', 1, 'admin')`);
  const notifyDef = await get(`SELECT relay_notify_status, relay_notified_user_id, relay_notified_user_name, requester_notify_phone_snapshot, requester_notify_ding_uid, release_assignee_id, release_assignee_name FROM sys_issues WHERE title='NOTIFY_DEFAULTS'`);
  assert.strictEqual(notifyDef.relay_notify_status, 'not_sent', 'relay_notify_status 默认应 not_sent');
  for (const k of ['relay_notified_user_id', 'relay_notified_user_name', 'requester_notify_phone_snapshot', 'requester_notify_ding_uid', 'release_assignee_id', 'release_assignee_name']) {
    assert.strictEqual(notifyDef[k], null, `${k} 默认应 NULL（C1a 纯建列，不接入守卫）`);
  }
  //   relay_notify_status 显式 NULL 应被 NOT NULL 拒（对齐三侧通知状态列惯例）
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, relay_notify_status) VALUES ('bug', '待处理', 't', 'BMS', 1, 'admin', NULL)`), /NOT NULL|constraint/i, 'relay_notify_status=NULL 应被 NOT NULL 拒');
  ok('⭐ 通知改造 C1a 新列（新库路径）：relay 7 + requester 快照 2 + release_assignee 2 = 11 列齐全 + relay_notify_status CHECK/NOT NULL/默认 not_sent + 其余列默认 NULL（release_assignee 等 C1a 纯建列不接入守卫）');

  // [9e] ⭐ 通知改造 follow-up（2026-07-07）第 5 类「通知上线开发」——release_assignee_notify_* 5 列全量断言
  //   （镜像 creator_notify_* 5 列：status CHECK/NOT NULL/默认 not_sent + notified_at/message_key/error/read_at 默认 NULL）。
  const REL_EXEC_NOTIFY_COLS = ['release_assignee_notify_status', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_read_at'];
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    const missRelExec = REL_EXEC_NOTIFY_COLS.filter(c => !nowCols.includes(c));
    assert.strictEqual(missRelExec.length, 0, `第 5 类通知列缺失: ${missRelExec.join(',')}`);
  }
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, release_assignee_notify_status) VALUES ('bug', '待处理', 't', 'BMS', 1, 'admin', 'pending')`), /CHECK|constraint/i, 'release_assignee_notify_status=pending 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, release_assignee_notify_status) VALUES ('bug', '待处理', 't', 'BMS', 1, 'admin', NULL)`), /NOT NULL|constraint/i, 'release_assignee_notify_status=NULL 应被 NOT NULL 拒');
  const relExecDef = await get(`SELECT release_assignee_notify_status, release_assignee_notified_at, release_assignee_notify_message_key, release_assignee_notify_error, release_assignee_read_at FROM sys_issues WHERE title='NOTIFY_DEFAULTS'`);
  assert.strictEqual(relExecDef.release_assignee_notify_status, 'not_sent', 'release_assignee_notify_status 默认应 not_sent');
  for (const k of ['release_assignee_notified_at', 'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_read_at']) {
    assert.strictEqual(relExecDef[k], null, `${k} 默认应 NULL`);
  }
  ok('⭐ 通知改造 follow-up 第 5 类通知列（新库路径）：release_assignee_notify_* 5 列齐全 + status CHECK/NOT NULL/默认 not_sent + 其余 4 列默认 NULL（镜像 creator 范式）');

  // [9f] ⭐ 上线体统一重构 C5：sys_issues 8 列只读残留断言（防未来误删）——syncReleaseLegacyMirror（C2a-C4
  //   过渡期双写镜像函数）已随 C5 整体删除，但这 8 列本身**保留在 schema 里不 DROP**（37 列表重建风险，
  //   项目"不再 drop 重建"铁律）。[2026-07-30 用户裁定补记] 曾长期活跃读写这 8 列的旧"上线编排"机制
  //   （assign-release-dev/reassign-release-dev/notify-release-executor(-batch) 4 端点）已全部封禁退场
  //   ——8 列自此全库零写路径、成为**纯只读残留**（历史展示/列表 SELECT 仍读，禁止 DROP 的结论不变）。
  //   本组是[9d]/[9e]两组既有列存在性断言之外**唯一覆盖全部 8 列（含此前从未被任何断言覆盖过的
  //   release_assignee_notify_sent_by）的清单式核对**，专门防止未来有人把这 8 列一并 DROP 掉。
  const RELEASE_ASSIGNEE_LEGACY_8_COLS = ['release_assignee_id', 'release_assignee_name',
    'release_assignee_notify_status', 'release_assignee_notified_at', 'release_assignee_notify_message_key',
    'release_assignee_notify_error', 'release_assignee_read_at', 'release_assignee_notify_sent_by'];
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    const missLegacy8 = RELEASE_ASSIGNEE_LEGACY_8_COLS.filter(c => !nowCols.includes(c));
    assert.strictEqual(missLegacy8.length, 0, `C5 只读残留 8 列缺失（被误删？）: ${missLegacy8.join(',')}——业务写路径已全封（旧上线编排家族 2026-07-30），历史展示/列表 SELECT/查已读固化仍读写 read_at，不得 DROP`);
  }
  ok(`⭐ 上线体统一重构 C5：sys_issues 8 列只读残留断言——${RELEASE_ASSIGNEE_LEGACY_8_COLS.join('/')} 全部仍在 schema 里（syncReleaseLegacyMirror 双写已删；旧上线编排家族 2026-07-30 全封后业务写路径为零，唯一残留写点=notify-read-status 已读固化 read_at，读路径仍在，禁止未来误删）`);

  // [9g] ⭐ 上线体统一重构 C6：sys_issues.needs_release 单列只读残留断言（防未来误删）——与上方 [9f] 8 列
  //   "双重身份"不同，needs_release **没有**第二套仍在活跃读写它的独立机制：唯一写点 set-release-flag 已
  //   随 C3 全类型退场为 410 Gone，add-issues 端点曾叠加的"bug 须 needs_release=1"闸门也已随本次双闸拆除
  //   （2026-07-29 主会话裁定选项 A，方案 v3.4 §5b #2「needs_release｜废弃」）一并删除——此后本列在全项目
  //   范围内没有任何写路径、也没有任何准入判断读它，是彻底死透的单一身份残留（仅供历史 timeline 标签/
  //   建单初值展示读出）。DROP COLUMN 仍被硬约束禁止（37 列表重建风险），保留列不删，本断言专防未来
  //   误删该列（若被删，PRAGMA table_info 里会缺失，下方 CHECK 断言 [9c] 也会连带报错，但本断言单独
  //   钉一个不依赖其他断言顺序的清单式核对）。
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    assert.ok(nowCols.includes('needs_release'), 'C6 只读残留列缺失（被误删？）: needs_release——此列虽已无任何写路径/准入判断消费，但仍供历史 timeline 标签展示，不得 DROP');
  }
  ok('⭐ 上线体统一重构 C6：sys_issues.needs_release 单列只读残留断言——列仍在 schema 里（唯一写点 set-release-flag 已 410 退场 + add-issues 的 needs_release=1 闸门已随双闸拆除删除，此后本列无任何写路径/读判断消费，纯供历史展示，禁止未来误删）');

  // [9h] ⭐ C1（工期对接测试与风险等级拆分 方案 v1.0 §4/§10）：sys_issues 新增 14 列（新库 CREATE 路径）
  //   全量存在性 + CHECK 值域探针。C1 是纯 schema commit（族常量+ALTER+CHECK 探针，不接线端点/GATE/
  //   guard），本组断言只测 DB 层约束是否如期生效，不涉及任何业务端点行为。
  const LIAISON_TEST_COLS_EXPECT = ['estimated_effort_days', 'risk_level', 'liaison_test_cycle_no',
    'liaison_test_recipient_id', 'liaison_test_recipient_name', 'liaison_test_notify_status',
    'liaison_test_notified_at', 'liaison_test_notify_message_key', 'liaison_test_notify_error',
    'liaison_test_read_at', 'liaison_test_notify_sent_by', 'liaison_test_notify_cycle_no',
    'liaison_test_attempt_token', 'liaison_test_attempt_started_at',
    'liaison_test_attachment_watermark'];   // ← [codex 291 号 H-1 收口] 附件周期水位列
  {
    const nowCols = (await all('PRAGMA table_info(sys_issues)')).map(r => r.name);
    const missLiaison = LIAISON_TEST_COLS_EXPECT.filter(c => !nowCols.includes(c));
    assert.strictEqual(missLiaison.length, 0, `C1 工期对接测试与风险等级拆分新列缺失: ${missLiaison.join(',')}`);
  }
  //   默认值：裸插入（不带这 14 列）→ 三个 NOT NULL DEFAULT 列各归位、其余 11 列 NULL。
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', 't-liaison-default', 'BMS', 1, 'admin')`);
  const liaisonDefault = await get(`SELECT estimated_effort_days, risk_level, liaison_test_cycle_no,
    liaison_test_recipient_id, liaison_test_recipient_name, liaison_test_notify_status, liaison_test_notified_at,
    liaison_test_notify_message_key, liaison_test_notify_error, liaison_test_read_at, liaison_test_notify_sent_by,
    liaison_test_notify_cycle_no, liaison_test_attempt_token, liaison_test_attempt_started_at,
    liaison_test_attachment_watermark
    FROM sys_issues WHERE title='t-liaison-default'`);
  assert.strictEqual(liaisonDefault.liaison_test_cycle_no, 0, 'liaison_test_cycle_no 默认应 0');
  assert.strictEqual(liaisonDefault.liaison_test_notify_status, 'not_sent', 'liaison_test_notify_status 默认应 not_sent');
  assert.strictEqual(liaisonDefault.liaison_test_notify_cycle_no, 0, 'liaison_test_notify_cycle_no 默认应 0');
  assert.strictEqual(liaisonDefault.liaison_test_attachment_watermark, 0, '[291 号 H-1] liaison_test_attachment_watermark 默认应 0');
  for (const k of ['estimated_effort_days', 'risk_level', 'liaison_test_recipient_id', 'liaison_test_recipient_name',
    'liaison_test_notified_at', 'liaison_test_notify_message_key', 'liaison_test_notify_error',
    'liaison_test_read_at', 'liaison_test_notify_sent_by', 'liaison_test_attempt_token', 'liaison_test_attempt_started_at']) {
    assert.strictEqual(liaisonDefault[k], null, `${k} 默认应 NULL`);
  }
  ok('⭐ C1 新增 14 列全量存在 + 默认值：三 NOT NULL DEFAULT 列（liaison_test_cycle_no/liaison_test_notify_cycle_no=0，liaison_test_notify_status=not_sent）归位，其余 11 列默认 NULL');

  // [9h-meta] ⭐ [codex 267 号 M-2] PRAGMA table_info 精确元数据钉死——三个 NOT NULL 列的 type/notnull=1/
  //   dflt_value 逐字断言（不满足于"能插入默认值对"这种间接验证，直接读 schema 元数据钉死声明本身，防未来
  //   有人手滑改错类型/漏加 DEFAULT/NOT NULL 被拿掉却没人发现——上面 [9h] 的默认值断言测的是"行为"，本组
  //   测的是"声明"，两者不能互相替代）；三列各配一条显式 INSERT NULL 拒绝用例（NOT NULL 约束最直接的反证
  //   ——区别于上面"不传列时走 DEFAULT"，这里是"显式传 NULL"的独立输入面，两者可能有不同的失守方式）。
  //   其余 11 列至少核对声明类型（type 字段）与可空性（notnull=0），防某列被误声明成非预期类型或误加 NOT NULL。
  const liaisonTestColInfoRows = await all('PRAGMA table_info(sys_issues)');
  const liaisonTestColInfoByName = new Map(liaisonTestColInfoRows.map(c => [c.name, c]));
  const LIAISON_NOT_NULL_DEFAULT_COLS_EXPECT = {
    liaison_test_cycle_no: { type: 'INTEGER', dflt_value: '0' },
    liaison_test_notify_cycle_no: { type: 'INTEGER', dflt_value: '0' },
    liaison_test_notify_status: { type: 'TEXT', dflt_value: "'not_sent'" },
    liaison_test_attachment_watermark: { type: 'INTEGER', dflt_value: '0' },   // ← [291 号 H-1]
  };
  for (const [col, expect] of Object.entries(LIAISON_NOT_NULL_DEFAULT_COLS_EXPECT)) {
    const info = liaisonTestColInfoByName.get(col);
    assert.ok(info, `PRAGMA table_info 应能读到列 ${col}`);
    assert.strictEqual(info.type, expect.type, `${col} 声明类型应为 ${expect.type}，实际 ${info.type}`);
    assert.strictEqual(info.notnull, 1, `${col} 应 notnull=1，实际 ${info.notnull}`);
    assert.strictEqual(info.dflt_value, expect.dflt_value, `${col} dflt_value 应为 ${expect.dflt_value}，实际 ${info.dflt_value}`);
  }
  ok(`⭐ [codex 267 号 M-2] PRAGMA table_info 精确钉死三个 NOT NULL DEFAULT 列元数据：liaison_test_cycle_no(INTEGER/notnull=1/dflt='0') / liaison_test_notify_cycle_no(INTEGER/notnull=1/dflt='0') / liaison_test_notify_status(TEXT/notnull=1/dflt="'not_sent'")`);

  //   三列显式 INSERT NULL 拒绝（NOT NULL 约束反证，独立于"不传列走 DEFAULT"这条输入面）
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_cycle_no) VALUES ('feature', '开发中', 't-ltcn-null', 'BMS', 1, 'admin', NULL)`),
    /NOT NULL|constraint/i, 'liaison_test_cycle_no 显式传 NULL 应被 NOT NULL 拒');
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_notify_cycle_no) VALUES ('feature', '开发中', 't-ltncn-null', 'BMS', 1, 'admin', NULL)`),
    /NOT NULL|constraint/i, 'liaison_test_notify_cycle_no 显式传 NULL 应被 NOT NULL 拒');
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_notify_status) VALUES ('feature', '开发中', 't-ltns-null', 'BMS', 1, 'admin', NULL)`),
    /NOT NULL|constraint/i, 'liaison_test_notify_status 显式传 NULL 应被 NOT NULL 拒');
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_attachment_watermark) VALUES ('feature', '开发中', 't-ltaw-null', 'BMS', 1, 'admin', NULL)`),
    /NOT NULL|constraint/i, '[291 号 H-1] liaison_test_attachment_watermark 显式传 NULL 应被 NOT NULL 拒');
  ok('⭐ [codex 267 号 M-2 + 291 号 H-1] 四个 NOT NULL 列显式 INSERT NULL 均被拒（liaison_test_cycle_no / liaison_test_notify_cycle_no / liaison_test_notify_status / liaison_test_attachment_watermark——区别于"不传列走 DEFAULT"，这是显式传 NULL 的独立输入面）');

  //   其余 11 列（可空列）——至少核对声明类型与可空性（notnull=0）
  const LIAISON_NULLABLE_COLS_TYPE_EXPECT = {
    estimated_effort_days: 'REAL',
    risk_level: 'TEXT',
    liaison_test_recipient_id: 'INTEGER',
    liaison_test_recipient_name: 'TEXT',
    liaison_test_notified_at: 'DATETIME',
    liaison_test_notify_message_key: 'TEXT',
    liaison_test_notify_error: 'TEXT',
    liaison_test_read_at: 'DATETIME',
    liaison_test_notify_sent_by: 'INTEGER',
    liaison_test_attempt_token: 'TEXT',
    liaison_test_attempt_started_at: 'DATETIME',
  };
  for (const [col, type] of Object.entries(LIAISON_NULLABLE_COLS_TYPE_EXPECT)) {
    const info = liaisonTestColInfoByName.get(col);
    assert.ok(info, `PRAGMA table_info 应能读到列 ${col}`);
    assert.strictEqual(info.type, type, `${col} 声明类型应为 ${type}，实际 ${info.type}`);
    assert.strictEqual(info.notnull, 0, `${col} 应可空（notnull=0），实际 ${info.notnull}`);
  }
  ok(`⭐ [codex 267 号 M-2] 其余 11 列声明类型 + 可空性核对：${Object.keys(LIAISON_NULLABLE_COLS_TYPE_EXPECT).join('/')} 均 notnull=0 且类型声明匹配（14 列元数据本组+上组合计全覆盖）`);

  //   estimated_effort_days CHECK（§3.2：有限数、0<v≤365、0.5 整数倍）：负例（0/负数/366/0.3 非半整数倍）+ 正例（0.5/1/364.5/365）+ NULL 合法
  const insEffort = (v) => run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, estimated_effort_days) VALUES ('feature', '开发中', ?, 'BMS', 1, 'admin', ?)`, [`t-effort-${v}`, v]);
  await assert.rejects(insEffort(0), /CHECK|constraint/i, 'estimated_effort_days=0 应被 CHECK(>0) 拒');
  await assert.rejects(insEffort(-1), /CHECK|constraint/i, 'estimated_effort_days=-1 应被 CHECK(>0) 拒');
  await assert.rejects(insEffort(366), /CHECK|constraint/i, 'estimated_effort_days=366 应被 CHECK(<=365) 拒');
  await assert.rejects(insEffort(1.3), /CHECK|constraint/i, 'estimated_effort_days=1.3（非 0.5 整数倍）应被 CHECK 拒');
  await assert.doesNotReject(insEffort(0.5), 'estimated_effort_days=0.5（下界半整数倍）应合法');
  await assert.doesNotReject(insEffort(1), 'estimated_effort_days=1（整数）应合法');
  await assert.doesNotReject(insEffort(364.5), 'estimated_effort_days=364.5 应合法');
  await assert.doesNotReject(insEffort(365), 'estimated_effort_days=365（上界）应合法');
  await assert.doesNotReject(insEffort(null), 'estimated_effort_days=NULL 应合法（评估前/improvement 选填未填）');
  ok('estimated_effort_days CHECK：0/负数/366/1.3 非半整数倍全被拒，0.5/1/364.5/365 全合法，NULL 合法（§3.2 契约）');

  //   risk_level CHECK（§3.4：一级/二级/三级/NULL——⭐ 用户拍板批1改造A值域改名，原「高/中/低」全仓
  //   改名，语义不变仅文案换）：负例（原值域"gao"拼音残留同样应仍非法/空串）+ 正例（三态 + NULL）
  const insRisk = (v) => run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, risk_level) VALUES ('feature', '待受理', ?, 'BMS', 1, 'admin', ?)`, [`t-risk-${v}`, v]);
  await assert.rejects(insRisk('gao'), /CHECK|constraint/i, "risk_level='gao' 应被 CHECK 拒");
  await assert.rejects(insRisk('高'), /CHECK|constraint/i, "risk_level='高'（旧值域残留）应被 CHECK 拒——值域已改名，旧值不再合法");
  await assert.rejects(insRisk(''), /CHECK|constraint/i, "risk_level='' 应被 CHECK 拒");
  for (const lvl of ['一级', '二级', '三级']) {
    await assert.doesNotReject(insRisk(lvl), `risk_level='${lvl}' 应合法`);
  }
  // ⭐ 用户拍板批1改造B：risk_level=NULL 合法态现仅覆盖"存量单/bug"（improvement 已改必填，不再恒空）。
  await assert.doesNotReject(insRisk(null), 'risk_level=NULL 应合法（存量单/bug 恒空的合法态）');
  ok('risk_level CHECK：非法值/空串/旧值域残留("高")全被拒，一级/二级/三级/NULL 全合法（§3.4 契约+改造A值域改名，NULL=有意义业务态不设占位）');

  // [9h-c9] ⭐ [C9-fix M2②] sys_issues.online_source（C9 无 commit 直翻·方案 v1.7 §10.1 字段契约）——
  //   新库 CREATE 路径的存在性 + 元数据 + "无 CHECK 是有意为之"的**双向**证明。
  //   ⚠️ 本组存在的理由：C9 建列时只有 verify-sys-c9-direct-online 从**业务行为**侧覆盖（accept 后列里
  //     有值），schema 侧一个字都没有——列被误删/误改类型/被人"顺手补个 CHECK"时，业务套件要么照绿
  //     （TEXT→其他类型对 SQLite 动态类型多半无感），要么在别处报一个看不出根因的错。schema 断言是
  //     独立于业务行为的第二层（同 [9h]/[9h-meta] 对 C1 十四列的分工）。
  {
    const c9ColInfo = (await all('PRAGMA table_info(sys_issues)')).find(c => c.name === 'online_source');
    assert.ok(c9ColInfo, 'C9 新列 online_source 应存在于新库 CREATE 路径（缺失=CREATE TABLE 定义被误删）');
    assert.strictEqual(c9ColInfo.type, 'TEXT', `online_source 声明类型应为 TEXT，实际 ${c9ColInfo.type}`);
    assert.strictEqual(c9ColInfo.notnull, 0, `online_source 应可空（NULL=批次发布路径/存量历史的合法态，是三分支派生的输入之一），实际 notnull=${c9ColInfo.notnull}`);
    assert.strictEqual(c9ColInfo.dflt_value, null, `online_source 不应有 DEFAULT（默认 NULL 即"未标记来源"），实际 dflt_value=${c9ColInfo.dflt_value}`);
    // 列序钉死：[C9-fix M2③·预筛 MED-6 恢复精度] online_source 之后的列**必须恰好**是 [组B·2026-08-12]
    //   新增的 fast_release_* 六列（按 alterAddMissingCols [1a-14] 声明顺序）+ [组B·SB2·2026-08-13]
    //   随后新增的 post_release_acceptance/post_accepted_at/post_derive_issue_id 三列（[1a-15]）+
    //   [组C·SC1·2026-08-13] 随后新增的 eta_overrun_reason_code/_note/dev_estimated_first_at/
    //   dev_estimated_at_on_release 四列（[1a-16]），不多不少不错序——用显式列表 deepStrictEqual 而非
    //   "只要排在它之前"这种宽松判断，保留原断言（"online_source 必须是表尾往下的固定序列起点"）的精确
    //   追责能力：若将来再有新列插进这十三列之间、或表尾又新增了别的列组，这里会先于下方
    //   [9h-fastrelease]/[9h-fastrelease-acceptance]/[9h-eta-overrun-snapshot] 三组报错，逼着显式更新
    //   这份列表（同时提醒同步该组的表尾断言）。
    const allColsForOrder = await all('PRAGMA table_info(sys_issues)');
    const colsAfterOnlineSource = allColsForOrder.slice(c9ColInfo.cid + 1).map(c => c.name);
    assert.deepStrictEqual(colsAfterOnlineSource,
      ['fast_release_auth_by', 'fast_release_auth_by_name', 'fast_release_auth_at', 'fast_release_auth_note',
        'fast_release_revoked_at', 'fast_release_consumed_at',
        'post_release_acceptance', 'post_accepted_at', 'post_derive_issue_id',
        'eta_overrun_reason_code', 'eta_overrun_reason_note', 'dev_estimated_first_at', 'dev_estimated_at_on_release'],
      `[M2③] online_source 之后应恰好是 fast_release_* 六列 + post_release_acceptance/post_accepted_at/post_derive_issue_id 三列 + eta_overrun_reason_code/_note/dev_estimated_first_at/dev_estimated_at_on_release 四列（顺序不漂移），实得 ${JSON.stringify(colsAfterOnlineSource)}`);
    // 默认值行为：裸插入 → NULL
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', 't-online-source-default', 'BMS', 1, 'admin')`);
    const osDefault = await get(`SELECT online_source FROM sys_issues WHERE title='t-online-source-default'`);
    assert.strictEqual(osDefault.online_source, null, 'online_source 默认应 NULL');
    // ⭐ **无 CHECK 的双向证明**（[[feedback_probe_test_bidirectional_proof]]）：正向=合法字面量能写；
    //   反向=任意字符串**也**能写。第二条不是"漏测"，恰恰是把"本列刻意不加 CHECK"这个设计决定钉成
    //   可执行断言——若将来有人给它补上 CHECK（哪怕出于好意），这一条会立刻红，逼迫重新走一次
    //   index.js 侧那段"不加 CHECK 三条理由"的决策，而不是静默改变列语义。
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, online_source) VALUES ('feature', '开发中', 't-os-legit', 'BMS', 1, 'admin', 'no_commit_acceptance')`),
      'online_source 写入唯一合法字面量 no_commit_acceptance 应成功');
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, online_source) VALUES ('feature', '开发中', 't-os-open', 'BMS', 1, 'admin', 'whatever_future_kind')`),
      '⭐ online_source 写入任意字符串**也应成功**——本列刻意无 CHECK（值域开放/只读不判/唯一写入点是源码常量，三条理由见 index.js C9_ONLINE_SOURCE_ISSUE_COLS 注释）。本条一旦红=有人给本列加了 CHECK，须回去重走那段决策');
  }
  ok('⭐ [C9-fix M2②] sys_issues.online_source 新库 CREATE 路径：列存在 + TEXT/可空/无 DEFAULT 元数据钉死 + 位于表尾（M2③ 列序惯例）+ 裸插入默认 NULL + 无 CHECK 双向证明（合法字面量与任意字符串都能写入=刻意开放值域，加 CHECK 会让本组红）');

  // [9h-fastrelease] ⭐ 组B（bug 先行上线授权·方案 v1.3 §3.1/§3.4）：sys_issues.fast_release_* 六列——
  //   存在性 + 元数据 + 表尾位置 + "无 CHECK 是有意为之"的**双向**证明。同 [9h-c9] 一带理由：本组新列
  //   只有 verify-sys-fastrelease-auth 从**业务行为**侧覆盖（授权/撤销端点调用后列里有值），schema 侧
  //   独立断言防"列被误删/误改类型/被人顺手补个 CHECK"这类业务套件测不出根因的漂移。
  {
    const frCols = await all('PRAGMA table_info(sys_issues)');
    const byInfo = frCols.find(c => c.name === 'fast_release_auth_by');
    const byNameInfo = frCols.find(c => c.name === 'fast_release_auth_by_name');
    const atInfo = frCols.find(c => c.name === 'fast_release_auth_at');
    const noteInfo = frCols.find(c => c.name === 'fast_release_auth_note');
    const revokedInfo = frCols.find(c => c.name === 'fast_release_revoked_at');
    const consumedInfo = frCols.find(c => c.name === 'fast_release_consumed_at');
    for (const [name, info] of [
      ['fast_release_auth_by', byInfo], ['fast_release_auth_by_name', byNameInfo], ['fast_release_auth_at', atInfo],
      ['fast_release_auth_note', noteInfo], ['fast_release_revoked_at', revokedInfo], ['fast_release_consumed_at', consumedInfo],
    ]) {
      assert.ok(info, `组B 新列 ${name} 应存在于新库 CREATE 路径（缺失=alterAddMissingCols [1a-14] 定义被误删）`);
      assert.strictEqual(info.notnull, 0, `${name} 应可空（六列均为"未发生"时的合法 NULL 态），实际 notnull=${info.notnull}`);
      assert.strictEqual(info.dflt_value, null, `${name} 不应有 DEFAULT，实际 dflt_value=${info.dflt_value}`);
    }
    assert.strictEqual(byInfo.type, 'INTEGER', `fast_release_auth_by 声明类型应为 INTEGER，实际 ${byInfo.type}`);
    assert.strictEqual(byNameInfo.type, 'TEXT', `fast_release_auth_by_name 声明类型应为 TEXT，实际 ${byNameInfo.type}`);
    assert.strictEqual(atInfo.type, 'DATETIME', `fast_release_auth_at 声明类型应为 DATETIME，实际 ${atInfo.type}`);
    assert.strictEqual(noteInfo.type, 'TEXT', `fast_release_auth_note 声明类型应为 TEXT，实际 ${noteInfo.type}`);
    assert.strictEqual(revokedInfo.type, 'DATETIME', `fast_release_revoked_at 声明类型应为 DATETIME，实际 ${revokedInfo.type}`);
    assert.strictEqual(consumedInfo.type, 'DATETIME', `fast_release_consumed_at 声明类型应为 DATETIME，实际 ${consumedInfo.type}`);
    // 列序：六列须按 alterAddMissingCols 内声明顺序连续排在表尾（by→by_name→at→note→revoked_at→consumed_at）。
    //   [组B·SB2] 表尾断言已随 [1a-15] 新增三列后移——不再是 consumed_at，改在下方
    //   [9h-fastrelease-acceptance] 组断言 post_derive_issue_id 才是当前真正表尾。
    assert.ok(byInfo.cid < byNameInfo.cid && byNameInfo.cid < atInfo.cid && atInfo.cid < noteInfo.cid
      && noteInfo.cid < revokedInfo.cid && revokedInfo.cid < consumedInfo.cid,
      `组B 六列 cid 应严格递增（声明顺序不漂移），实得 by=${byInfo.cid}/by_name=${byNameInfo.cid}/at=${atInfo.cid}/note=${noteInfo.cid}/revoked=${revokedInfo.cid}/consumed=${consumedInfo.cid}`);
    // 默认值行为：裸插入 → 六列全 NULL
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('bug', '待受理', 't-fastrelease-default', 'BMS', 1, 'admin')`);
    const frDefault = await get(`SELECT fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_auth_note, fast_release_revoked_at, fast_release_consumed_at FROM sys_issues WHERE title='t-fastrelease-default'`);
    for (const k of Object.keys(frDefault)) {
      assert.strictEqual(frDefault[k], null, `裸插入后 ${k} 默认应 NULL，实际 ${JSON.stringify(frDefault[k])}`);
    }
    // ⭐ 无 CHECK 的双向证明（同 online_source 组理由）：正向=正常值能写；反向=任意字符串（含超长）也能写——
    //   成组约束（三件套同空同非空等）刻意不靠 DB CHECK 承载，全部由服务层 assertFastReleaseGroupInvariant
    //   守卫（登记接受，见 index.js [1a-14] 注释）。若将来有人给这几列补上 CHECK，本条会立刻红。
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at) VALUES ('bug', '处理中', 't-fr-legit', 'BMS', 1, 'admin', 1, '管理员', '2026-08-12 10:00:00')`),
      'fast_release_* 三件套写入正常值应成功');
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, fast_release_auth_by, fast_release_auth_by_name, fast_release_auth_at, fast_release_revoked_at, fast_release_consumed_at) VALUES ('bug', '处理中', 't-fr-open', 'BMS', 1, 'admin', 1, '管理员', '2026-08-12 10:00:00', '2026-08-12 09:00:00', '2026-08-12 09:00:00')`),
      '⭐ fast_release_* 写入"破坏成组约束"的组合（revoked_at 早于 auth_at 且与 consumed_at 同时非空）DB 层也应成功——本组无 CHECK，成组约束是服务层职责，本条一旦红=有人给这几列加了 CHECK，须回去重走 index.js [1a-14] 那段"登记接受"决策');
  }
  ok('⭐ 组B（bug 先行上线授权·方案 v1.3）sys_issues.fast_release_* 六列：类型/可空/无 DEFAULT 元数据钉死 + 声明序连续 + 裸插入默认全 NULL + 无 CHECK 双向证明（成组约束交由服务层守卫，DB 层刻意开放）');

  // [9h-fastrelease-acceptance] ⭐ 组B（bug 先行上线直上·SB2·方案 v1.3 §3.2/§3.3）：
  //   sys_issues.post_release_acceptance/post_accepted_at/post_derive_issue_id 三列——存在性 + 元数据 +
  //   表尾位置 + "无 CHECK 是有意为之"的双向证明。同 [9h-c9]/[9h-fastrelease] 一带理由：本组新列只有
  //   verify-sys-fastlane-submit 从**业务行为**侧覆盖（submit direct_release=true 后列里有值），schema 侧
  //   独立断言防"列被误删/误改类型/被人顺手补个 CHECK"这类业务套件测不出根因的漂移。
  {
    const paCols = await all('PRAGMA table_info(sys_issues)');
    const acceptanceInfo = paCols.find(c => c.name === 'post_release_acceptance');
    const acceptedAtInfo = paCols.find(c => c.name === 'post_accepted_at');
    const deriveIdInfo = paCols.find(c => c.name === 'post_derive_issue_id');
    for (const [name, info] of [
      ['post_release_acceptance', acceptanceInfo], ['post_accepted_at', acceptedAtInfo], ['post_derive_issue_id', deriveIdInfo],
    ]) {
      assert.ok(info, `组B SB2 新列 ${name} 应存在于新库 CREATE 路径（缺失=alterAddMissingCols [1a-15] 定义被误删）`);
      assert.strictEqual(info.notnull, 0, `${name} 应可空（三列均为"补验收未发生"时的合法 NULL 态），实际 notnull=${info.notnull}`);
      assert.strictEqual(info.dflt_value, null, `${name} 不应有 DEFAULT，实际 dflt_value=${info.dflt_value}`);
    }
    assert.strictEqual(acceptanceInfo.type, 'TEXT', `post_release_acceptance 声明类型应为 TEXT，实际 ${acceptanceInfo.type}`);
    assert.strictEqual(acceptedAtInfo.type, 'DATETIME', `post_accepted_at 声明类型应为 DATETIME，实际 ${acceptedAtInfo.type}`);
    assert.strictEqual(deriveIdInfo.type, 'INTEGER', `post_derive_issue_id 声明类型应为 INTEGER，实际 ${deriveIdInfo.type}`);
    // 列序：三列须按 alterAddMissingCols [1a-15] 内声明顺序连续排在表尾。
    //   ⚠️ [组C·SC1] post_derive_issue_id **已不再是**当前表尾——[1a-16] 随后新增了 4 列，真正的表尾
    //   断言已下移到 [9h-eta-overrun-snapshot] 组（见该组"[表尾钉死]"标记），此处不再重复断言末列。
    assert.ok(acceptanceInfo.cid < acceptedAtInfo.cid && acceptedAtInfo.cid < deriveIdInfo.cid,
      `组B SB2 三列 cid 应严格递增（声明顺序不漂移），实得 acceptance=${acceptanceInfo.cid}/accepted_at=${acceptedAtInfo.cid}/derive_id=${deriveIdInfo.cid}`);
    // 默认值行为：裸插入 → 三列全 NULL
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('bug', '待受理', 't-fastrelease-acceptance-default', 'BMS', 1, 'admin')`);
    const paDefault = await get(`SELECT post_release_acceptance, post_accepted_at, post_derive_issue_id FROM sys_issues WHERE title='t-fastrelease-acceptance-default'`);
    for (const k of Object.keys(paDefault)) {
      assert.strictEqual(paDefault[k], null, `裸插入后 ${k} 默认应 NULL，实际 ${JSON.stringify(paDefault[k])}`);
    }
    // ⭐ 无 CHECK 的双向证明（同 fast_release_* 六列组理由）：正向='pending' 唯一当前合法写入值能写；
    //   反向=任意字符串（SB3 尚未落地的 passed/failed_derived 甚至垃圾值）也能写——值域校验交由服务层，
    //   DB 层刻意开放（同一登记接受口径）。若将来有人给本列补上 CHECK，本条会立刻红。
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, post_release_acceptance) VALUES ('bug', '已上线', 't-pra-legit', 'BMS', 1, 'admin', 'pending')`),
      "post_release_acceptance 写入唯一当前合法字面量 'pending' 应成功");
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, post_release_acceptance) VALUES ('bug', '已上线', 't-pra-open', 'BMS', 1, 'admin', 'whatever_future_kind')`),
      '⭐ post_release_acceptance 写入任意字符串**也应成功**——本列刻意无 CHECK（SB3 才会补 passed/failed_derived 分支，本轮只写 pending 字面量），本条一旦红=有人给本列加了 CHECK，须回去重走 index.js [1a-15] 那段"登记接受"决策');
  }
  ok('⭐ 组B（bug 先行上线直上·SB2·方案 v1.3）sys_issues.post_release_acceptance/post_accepted_at/post_derive_issue_id 三列：类型/可空/无 DEFAULT 元数据钉死 + 声明序连续 + 裸插入默认全 NULL + 无 CHECK 双向证明（值域校验交由服务层，DB 层刻意开放）');

  // [9h-eta-overrun-snapshot] ⭐ 组C（期望对表与准时统计·SC1·方案 v1.3 §3C.2/§3C.4/§3C.5/§3C.8）：
  //   sys_issues.eta_overrun_reason_code/_note/dev_estimated_first_at/dev_estimated_at_on_release 四列——
  //   存在性 + 元数据 + 表尾位置 + "无 CHECK 是有意为之"的双向证明。同 [9h-fastrelease-acceptance] 一带
  //   理由：本组新列只有 verify-sys-eta-overrun-snapshot 从**业务行为**侧覆盖，schema 侧独立断言防
  //   "列被误删/误改类型/被人顺手补个 CHECK"这类业务套件测不出根因的漂移。
  {
    const etaCols = await all('PRAGMA table_info(sys_issues)');
    const reasonCodeInfo = etaCols.find(c => c.name === 'eta_overrun_reason_code');
    const reasonNoteInfo = etaCols.find(c => c.name === 'eta_overrun_reason_note');
    const firstAtInfo = etaCols.find(c => c.name === 'dev_estimated_first_at');
    const onReleaseInfo = etaCols.find(c => c.name === 'dev_estimated_at_on_release');
    for (const [name, info] of [
      ['eta_overrun_reason_code', reasonCodeInfo], ['eta_overrun_reason_note', reasonNoteInfo],
      ['dev_estimated_first_at', firstAtInfo], ['dev_estimated_at_on_release', onReleaseInfo],
    ]) {
      assert.ok(info, `组C 新列 ${name} 应存在于新库 CREATE 路径（缺失=alterAddMissingCols [1a-16] 定义被误删）`);
      assert.strictEqual(info.notnull, 0, `${name} 应可空（四列均为"未发生/未适用"时的合法 NULL 态），实际 notnull=${info.notnull}`);
      assert.strictEqual(info.dflt_value, null, `${name} 不应有 DEFAULT，实际 dflt_value=${info.dflt_value}`);
    }
    assert.strictEqual(reasonCodeInfo.type, 'TEXT', `eta_overrun_reason_code 声明类型应为 TEXT，实际 ${reasonCodeInfo.type}`);
    assert.strictEqual(reasonNoteInfo.type, 'TEXT', `eta_overrun_reason_note 声明类型应为 TEXT，实际 ${reasonNoteInfo.type}`);
    assert.strictEqual(firstAtInfo.type, 'DATETIME', `dev_estimated_first_at 声明类型应为 DATETIME，实际 ${firstAtInfo.type}`);
    assert.strictEqual(onReleaseInfo.type, 'DATETIME', `dev_estimated_at_on_release 声明类型应为 DATETIME，实际 ${onReleaseInfo.type}`);
    // 列序：四列须按 alterAddMissingCols [1a-16] 内声明顺序连续排在表尾，且 dev_estimated_at_on_release
    //   就是当前真正的表尾（呼应上方 [M2③] 断言"改动后表尾在这里"）。
    assert.ok(reasonCodeInfo.cid < reasonNoteInfo.cid && reasonNoteInfo.cid < firstAtInfo.cid && firstAtInfo.cid < onReleaseInfo.cid,
      `组C 四列 cid 应严格递增（声明顺序不漂移），实得 code=${reasonCodeInfo.cid}/note=${reasonNoteInfo.cid}/first_at=${firstAtInfo.cid}/on_release=${onReleaseInfo.cid}`);
    const lastColEta = etaCols[etaCols.length - 1];
    assert.strictEqual(lastColEta.name, 'dev_estimated_at_on_release',
      `[表尾钉死] dev_estimated_at_on_release 应是 sys_issues 当前最后一列（新增列一律排表尾），实际末列=${lastColEta.name}——将来再加新列时本断言会红，提醒把这一行的期望更新为新的末列`);
    // 默认值行为：裸插入 → 四列全 NULL
    await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('improvement', '待受理', 't-eta-overrun-default', 'BMS', 1, 'admin')`);
    const etaDefault = await get(`SELECT eta_overrun_reason_code, eta_overrun_reason_note, dev_estimated_first_at, dev_estimated_at_on_release FROM sys_issues WHERE title='t-eta-overrun-default'`);
    for (const k of Object.keys(etaDefault)) {
      assert.strictEqual(etaDefault[k], null, `裸插入后 ${k} 默认应 NULL，实际 ${JSON.stringify(etaDefault[k])}`);
    }
    // ⭐ 无 CHECK 的双向证明（同 fast_release_*/post_release_acceptance 组理由）：正向=值域内正常值能写；
    //   反向=不在值域内的任意字符串也能写——值域校验（ETA_OVERRUN_REASON_CODES 五值枚举）交由服务层
    //   resolveEtaOverrunReasonForWrite，DB 层刻意开放（同一登记接受口径）。若将来有人给这四列补上
    //   CHECK，本条会立刻红，须回去重走 index.js [1a-16] 那段"登记接受"决策。
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, eta_overrun_reason_code, eta_overrun_reason_note) VALUES ('improvement', '开发中', 't-eta-legit', 'BMS', 1, 'admin', '需求变更', '正常理由')`),
      'eta_overrun_reason_code/_note 写入合法值域内的值应成功');
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, eta_overrun_reason_code) VALUES ('improvement', '开发中', 't-eta-open', 'BMS', 1, 'admin', 'whatever_not_in_domain')`),
      '⭐ eta_overrun_reason_code 写入值域外的任意字符串**也应成功**——本列刻意无 CHECK，值域校验是服务层职责');
  }
  ok('⭐ 组C（期望对表与准时统计·SC1·方案 v1.3）sys_issues.eta_overrun_reason_code/_note/dev_estimated_first_at/dev_estimated_at_on_release 四列：类型/可空/无 DEFAULT 元数据钉死 + 声明序连续 + dev_estimated_at_on_release 为当前表尾 + 裸插入默认全 NULL + 无 CHECK 双向证明（值域校验交由服务层，DB 层刻意开放）');

  //   liaison_test_cycle_no / liaison_test_notify_cycle_no CHECK（typeof=integer AND >=0，两列同款）：
  //   负例（负数整数 + 非整数小数——typeof 在此落 real）；正例（0/5）
  for (const col of ['liaison_test_cycle_no', 'liaison_test_notify_cycle_no']) {
    await assert.rejects(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, ${col}) VALUES ('feature', '开发中', ?, 'BMS', 1, 'admin', -1)`, [`t-${col}-neg`]),
      /CHECK|constraint/i, `${col}=-1 应被 CHECK(>=0) 拒`);
    await assert.rejects(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, ${col}) VALUES ('feature', '开发中', ?, 'BMS', 1, 'admin', 1.5)`, [`t-${col}-frac`]),
      /CHECK|constraint/i, `${col}=1.5（非整数，typeof=real）应被 CHECK(typeof='integer') 拒`);
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, ${col}) VALUES ('feature', '开发中', ?, 'BMS', 1, 'admin', 5)`, [`t-${col}-ok`]),
      `${col}=5 应合法`);
  }
  ok('liaison_test_cycle_no / liaison_test_notify_cycle_no CHECK：负数与非整数小数（typeof 落 real）均被拒，非负整数合法（只增不清的周期号契约，§4/§8）');

  //   liaison_test_notify_status CHECK（新通道四态 not_sent/sending/sent/failed，不含 release_assignee 那个 stale）：
  //   负例（三侧通知惯用探针值 pending + release_assignee 专属的 stale——本通道无该态）；正例四态全合法
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_notify_status) VALUES ('feature', '开发中', 't-lns-pending', 'BMS', 1, 'admin', 'pending')`),
    /CHECK|constraint/i, "liaison_test_notify_status='pending' 应被 CHECK 拒");
  await assert.rejects(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_notify_status) VALUES ('feature', '开发中', 't-lns-stale', 'BMS', 1, 'admin', 'stale')`),
    /CHECK|constraint/i, "liaison_test_notify_status='stale' 应被 CHECK 拒（本通道四态不含 release_assignee 专属的 stale）");
  for (const st of ['not_sent', 'sending', 'sent', 'failed']) {
    await assert.doesNotReject(
      run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, liaison_test_notify_status) VALUES ('feature', '开发中', ?, 'BMS', 1, 'admin', ?)`, [`t-lns-${st}`, st]),
      `liaison_test_notify_status='${st}' 应合法`);
  }
  ok("liaison_test_notify_status CHECK：'pending'/'stale' 均被拒，四态 not_sent/sending/sent/failed 全合法（§4/§6 新通道四态，比三侧通知经典三态多一个 sending 支撑预占协议）");

  // [10] sys_issues NOT NULL：缺 system_name / created_by / title 被拒
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, title, created_by, created_by_name) VALUES ('feature', '待评估', 't', 1, 'admin')`), /NOT NULL|constraint/i, 'system_name NOT NULL 未生效');
  await assert.rejects(run(`INSERT INTO sys_issues (type, status, system_name, created_by, created_by_name) VALUES ('feature', '待评估', 'BMS', 1, 'admin')`), /NOT NULL|constraint/i, 'title NOT NULL 未生效');
  ok('sys_issues NOT NULL：缺 system_name / title 被拒');

  // [11] sys_releases：release_no UNIQUE + status CHECK + NOT NULL
  await assert.rejects(run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-20260625-1', 1, 'admin')`), /UNIQUE|constraint/i, 'release_no UNIQUE 未生效');
  await assert.rejects(run(`INSERT INTO sys_releases (release_no, created_by, created_by_name, status) VALUES ('R-x', 1, 'admin', '草稿')`), /CHECK|constraint/i, 'release status=草稿 应被 CHECK 拒');
  const relDefault = await get(`SELECT status, is_hotfix FROM sys_releases WHERE release_no='R-20260625-1'`);
  assert.strictEqual(relDefault.status, '计划中', 'release status 默认 计划中');
  assert.strictEqual(relDefault.is_hotfix, 0, 'is_hotfix 默认 0');
  ok('sys_releases：release_no UNIQUE 防重 + status CHECK（计划中/已发布）+ 默认 计划中/is_hotfix=0');

  // [11a] ⭐ 上线体统一重构 C0（方案 v3.4 §6.1，2026-07-28）：sys_releases 新增 10 列全量断言（新库 CREATE 路径）
  const releaseCols = (await all('PRAGMA table_info(sys_releases)')).map(r => r.name);
  const RELEASE_DUTY_ASSIGNEE_COLS_EXPECT = ['release_assignee_id', 'release_assignee_name',
    'release_assignee_notify_status', 'release_assignee_notify_started_at', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_notify_token',
    'release_assignee_read_at', 'release_kind'];
  {
    const missRelDuty = RELEASE_DUTY_ASSIGNEE_COLS_EXPECT.filter(c => !releaseCols.includes(c));
    assert.strictEqual(missRelDuty.length, 0, `sys_releases 上线体统一重构 C0 新列缺失: ${missRelDuty.join(',')}`);
  }
  //   默认值：不带这两列插入 → release_assignee_notify_status='not_sent' / release_kind='normal'，其余 8 列 NULL
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-C0-DEFAULTS', 1, 'admin')`);
  const relC0Default = await get(`SELECT release_assignee_notify_status, release_kind, release_assignee_id, release_assignee_name,
    release_assignee_notify_started_at, release_assignee_notified_at, release_assignee_notify_message_key,
    release_assignee_notify_error, release_assignee_notify_token, release_assignee_read_at
    FROM sys_releases WHERE release_no='R-C0-DEFAULTS'`);
  assert.strictEqual(relC0Default.release_assignee_notify_status, 'not_sent', 'release_assignee_notify_status 默认应 not_sent');
  assert.strictEqual(relC0Default.release_kind, 'normal', 'release_kind 默认应 normal');
  for (const k of ['release_assignee_id', 'release_assignee_name', 'release_assignee_notify_started_at',
    'release_assignee_notified_at', 'release_assignee_notify_message_key', 'release_assignee_notify_error',
    'release_assignee_notify_token', 'release_assignee_read_at']) {
    assert.strictEqual(relC0Default[k], null, `${k} 默认应 NULL`);
  }
  //   CHECK 负例：release_assignee_notify_status='bogus' 拒；release_kind='urgent' 拒
  await assert.rejects(run(`INSERT INTO sys_releases (release_no, created_by, created_by_name, release_assignee_notify_status) VALUES ('R-C0-BOGUS', 1, 'admin', 'bogus')`),
    /CHECK|constraint/i, 'release_assignee_notify_status=bogus 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_releases (release_no, created_by, created_by_name, release_kind) VALUES ('R-C0-URGENT', 1, 'admin', 'urgent')`),
    /CHECK|constraint/i, 'release_kind=urgent 应被 CHECK 拒');
  //   CHECK 正例：notify_status 5 态全合法（not_sent/sending/sent/failed/stale）；release_kind 2 态全合法
  for (const st of ['not_sent', 'sending', 'sent', 'failed', 'stale']) {
    await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name, release_assignee_notify_status) VALUES (?, 1, 'admin', ?)`, [`R-C0-ST-${st}`, st]);
  }
  for (const k of ['normal', 'emergency']) {
    await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name, release_kind) VALUES (?, 1, 'admin', ?)`, [`R-C0-KIND-${k}`, k]);
  }
  ok('⭐ 上线体统一重构 C0 sys_releases 新列（新库路径）：10 列齐全 + release_assignee_notify_status 5 态合法/bogus 拒 + release_kind 2 态合法/urgent 拒 + 默认 not_sent/normal + 其余 8 列默认 NULL');

  // [11b] ⭐ 上线体统一重构 C0（方案 v3.4 §6.2）：排班表 sys_release_duty_roster 结构 + 索引存在
  const dutyCols = (await all('PRAGMA table_info(sys_release_duty_roster)')).map(r => r.name);
  const DUTY_ROSTER_COLS_EXPECT = ['id', 'duty_date', 'user_id', 'user_name', 'note', 'created_by',
    'created_by_name', 'created_at', 'removed_at', 'removed_by', 'removed_by_name'];
  {
    const missDuty = DUTY_ROSTER_COLS_EXPECT.filter(c => !dutyCols.includes(c));
    assert.strictEqual(missDuty.length, 0, `sys_release_duty_roster 列缺失: ${missDuty.join(',')}`);
  }
  const dutyIdx = (await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sys_release_duty_roster'")).map(r => r.name);
  assert.ok(dutyIdx.includes('idx_sys_duty_roster_active'), 'idx_sys_duty_roster_active 应存在');
  assert.ok(dutyIdx.includes('idx_sys_duty_roster_user'), 'idx_sys_duty_roster_user 应存在');
  ok('排班表 sys_release_duty_roster：11 列齐全 + 两索引（idx_sys_duty_roster_active 部分唯一 + idx_sys_duty_roster_user）存在');

  const insDuty = (dutyDate, userId, userName) =>
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, ?, ?, 1, 'admin')`,
      [dutyDate, userId, userName]);

  // [11c] ⭐ duty_date CHECK：负例（月 00/13、日 00/32、两位年份 GLOB 不匹配、月内溢出）+ 正例（含闰年 2/29）
  await assert.rejects(insDuty('2026-00-15', 5, '开发甲'), /CHECK|constraint/i, 'duty_date=2026-00-15（月00）应被 CHECK 拒');
  await assert.rejects(insDuty('2026-13-01', 5, '开发甲'), /CHECK|constraint/i, 'duty_date=2026-13-01（月13）应被 CHECK 拒');
  await assert.rejects(insDuty('2026-07-00', 5, '开发甲'), /CHECK|constraint/i, 'duty_date=2026-07-00（日00）应被 CHECK 拒');
  await assert.rejects(insDuty('2026-07-32', 5, '开发甲'), /CHECK|constraint/i, 'duty_date=2026-07-32（日32）应被 CHECK 拒');
  await assert.rejects(insDuty('26-7-8', 5, '开发甲'), /CHECK|constraint/i, 'duty_date=26-7-8（GLOB 不匹配 4-2-2 位格式）应被 CHECK 拒');
  await assert.doesNotReject(insDuty('2026-07-28', 5, '开发甲'), 'duty_date=2026-07-28 合法应可插入');
  // ⭐ 环境偏差修正专项：裸 date(x)（不带 modifier）对"月内溢出但数字仍在 GLOB 允许范围"的日期
  //   （02-30、非闰年 02-29、04-31 等）原样回显、不归一化，会让方案 v3.4 §6.2 这条防线对月内溢出日期
  //   实际不生效；DDL 已改为 date(x,'+0 days')（带 modifier 触发真正 Julian 回转归一化）。此偏差**先由
  //   主会话外部实测**（独立 probe 脚本直连 sqlite3，验证 date(x,'+0 days') 的归一化语义，9 组用例）
  //   发现并裁定修法；**本组断言是另一层**——走真实 initSchema() 建表 + 真实 CHECK 拒写的自动化回归
  //   覆盖清单（非临时 probe），验证修正后的真实行为：2026-02-30 → 归一化为 2026-03-02（≠原值→拒）；
  //   非闰年 2026-02-29 → 归一化为 2026-03-01（≠原值→拒）；闰年 2024-02-29 → 归一化后仍是 2024-02-29
  //   （=原值→放行）；2026-04-31（4 月仅 30 天，月内溢出第三形态）→ 归一化为 2026-05-01（≠原值→拒）。
  await assert.rejects(insDuty('2026-02-30', 5, '开发甲'), /CHECK|constraint/i,
    'duty_date=2026-02-30（date(x,\'+0 days\')归一化为2026-03-02≠原值）应被 CHECK 拒');
  await assert.rejects(insDuty('2026-02-29', 5, '开发甲'), /CHECK|constraint/i,
    'duty_date=2026-02-29（2026 非闰年，date(x,\'+0 days\')归一化为2026-03-01≠原值）应被 CHECK 拒');
  await assert.doesNotReject(insDuty('2024-02-29', 5, '开发甲'), 'duty_date=2024-02-29（闰年，date(x,\'+0 days\')归一化后仍等于原值）应可插入');
  await assert.rejects(insDuty('2026-04-31', 5, '开发甲'), /CHECK|constraint/i,
    'duty_date=2026-04-31（4 月仅 30 天，月内溢出第三形态，date(x,\'+0 days\')归一化为2026-05-01≠原值）应被 CHECK 拒');
  ok("排班表 duty_date CHECK：月 00/13、日 00/32、26-7-8（GLOB 不匹配）、2026-02-30/2026-02-29/2026-04-31（三种月内溢出形态，date(x,'+0 days')归一化后≠原值）全被拒；合法日期与闰年 2024-02-29（归一化后仍等于原值）可插（环境偏差修正专项：主会话外部 probe 实测裁定修法，本组是 verify 层自动化回归覆盖清单）");

  // [11d] ⭐ 软删成组 CHECK（v3.4 codex L-1 修正专项）：负例①仅 removed_at ②removed_at+removed_by 但 name NULL
  //   （正是 v3.3 会漏放的那条）③removed_by_name 空串/纯空格；正例：三者全 NULL（已隐含于上方插入）+ 三者全写。
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at)
         VALUES ('2026-08-01', 6, '开发乙', 1, 'admin', datetime('now'))`),
    /CHECK|constraint/i, '负例①：仅 removed_at 非空（removed_by/name 均 NULL）应被 CHECK 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by)
         VALUES ('2026-08-02', 6, '开发乙', 1, 'admin', datetime('now'), 1)`),
    /CHECK|constraint/i, '负例②（v3.4 codex L-1 专项）：removed_at+removed_by 非空但 removed_by_name 为 NULL 应被 CHECK 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-08-03', 6, '开发乙', 1, 'admin', datetime('now'), 1, '')`),
    /CHECK|constraint/i, '负例③a：removed_by_name 空串应被 CHECK 拒（length(trim())>0）');
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-08-04', 6, '开发乙', 1, 'admin', datetime('now'), 1, '   ')`),
    /CHECK|constraint/i, '负例③b：removed_by_name 纯空格应被 CHECK 拒（trim 后长度 0）');
  await assert.doesNotReject(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-08-05', 6, '开发乙', 1, 'admin', datetime('now'), 1, '对接人示例对接人')`),
    '正例：三字段全写合法值应可插入（合法软删行）');
  ok('排班表软删成组 CHECK：负例①仅 removed_at ②removed_at+removed_by 但 name NULL（v3.4 codex L-1 专项）③空串/纯空格 name 全被拒 + 三字段全 NULL/全写两态合法');

  // [11f] ⭐ codex C0 审收口加固（0 HIGH/1 MED/4 LOW，主会话裁定，2026-07-28）三处断言：
  //   a. removed_at 时间有效性：空串/垃圾串/纯空格均应被 datetime(removed_at) IS NOT NULL 拒
  //   b. user_id/created_by > 0：0 与负数均应被拒
  //   c. 加严后合法软删仍可插入（确认没误伤正常路径）
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-10-04', 6, '开发乙', 1, 'admin', '', 1, 'admin')`),
    /CHECK|constraint/i, "codex 加固 a1：removed_at='' 应被 datetime(removed_at) IS NOT NULL 拒（配 removed_by=1+合法 name，隔离变量只测 removed_at）");
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-10-05', 6, '开发乙', 1, 'admin', 'not-a-time', 1, 'admin')`),
    /CHECK|constraint/i, "codex 加固 a2：removed_at='not-a-time' 应被 datetime(removed_at) IS NOT NULL 拒");
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-10-06', 6, '开发乙', 1, 'admin', '   ', 1, 'admin')`),
    /CHECK|constraint/i, "codex 加固 a3：removed_at='   '（纯空格）应被 datetime(removed_at) IS NOT NULL 拒");
  ok('codex C0 审收口 a 组：removed_at 空串/垃圾串/纯空格三态均被 datetime(removed_at) IS NOT NULL 拒（配 removed_by=1+合法 name 隔离变量，只测 removed_at 本身）');

  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-10-01', 0, '开发甲', 1, 'admin')`),
    /CHECK|constraint/i, 'codex 加固 b1：user_id=0 应被 CHECK (user_id > 0) 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-10-02', -1, '开发甲', 1, 'admin')`),
    /CHECK|constraint/i, 'codex 加固 b2：user_id=-1 应被 CHECK (user_id > 0) 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-10-03', 5, '开发甲', 0, 'admin')`),
    /CHECK|constraint/i, 'codex 加固 b3：created_by=0 应被 CHECK (created_by > 0) 拒');
  ok('codex C0 审收口 b 组：user_id=0/-1、created_by=0 均被 CHECK (>0) 拒（防 0/负数非法 id 静默入库）');

  await assert.doesNotReject(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name, removed_at, removed_by, removed_by_name)
         VALUES ('2026-10-07', 8, '开发戊', 1, 'admin', datetime('now'), 1, '对接人示例对接人')`),
    'codex 加固 c 组回归：合法软删（datetime(\'now\') + removed_by=1(>0) + 非空 removed_by_name）在加严后仍可插入——确认三处加固未误伤正常路径');
  ok("codex C0 审收口 c 组回归：加严三条 CHECK（removed_at 时间有效性 + user_id>0 + created_by>0）后，合法软删行（datetime('now')/正数 removed_by/非空 name）仍可正常插入，未误伤");

  // [11e] ⭐ 唯一活跃索引 idx_sys_duty_roster_active：同 duty_date 两条 active 行冲突，软删第一条后可再插
  await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-09-01', 10, '开发丙', 1, 'admin')`);
  await assert.rejects(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-09-01', 11, '开发丁', 1, 'admin')`),
    /UNIQUE|constraint/i, '同 duty_date 第二条 active 行应被 idx_sys_duty_roster_active 部分唯一索引拒（即便 user_id 不同）');
  await run(`UPDATE sys_release_duty_roster SET removed_at = datetime('now'), removed_by = 1, removed_by_name = 'admin' WHERE duty_date = '2026-09-01' AND user_id = 10`);
  await assert.doesNotReject(
    run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES ('2026-09-01', 11, '开发丁', 1, 'admin')`),
    '软删第一条后，同 duty_date 再插 active 行应成功（部分索引只约束 removed_at IS NULL 的在册行）');
  ok('排班表唯一活跃索引：同 duty_date 两条 active 冲突被拒（跨 user_id 仍拒——约束落在 duty_date 不在 user_id）+ 软删旧行后同日可再插新值班人');

  // [11g] ⭐ 上线执行人多选与多人双确认（方案 20260806 v1.7 §4.1，C0）：sys_release_executors 结构 + 3 索引存在
  //   双向证明纪律（[[feedback_probe_test_bidirectional_proof]]）：本组既证"能检出"（负例全被拒）又证"终态零残留"
  //   （每类负例清理后回查库内 COUNT=0，非只信内存变量；本脚本连的是 :memory: 库，"库内"而非"磁盘"是准确措辞）。
  const relId1 = (await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-EXEC-SCHEMA-1', 1, 'admin')`)).lastID;

  const execCols = (await all('PRAGMA table_info(sys_release_executors)')).map(r => r.name);
  const RELEASE_EXEC_COLS_EXPECT = ['id', 'release_id', 'user_id', 'user_name',
    'notify_status', 'notify_started_at', 'notified_at', 'notify_message_key', 'notify_error', 'notify_token', 'read_at',
    'exec_status', 'executed_at',
    'added_by', 'added_by_name', 'created_at', 'removed_at', 'removed_by', 'removed_by_name'];
  {
    const missExec = RELEASE_EXEC_COLS_EXPECT.filter(c => !execCols.includes(c));
    assert.strictEqual(missExec.length, 0, `sys_release_executors 列缺失: ${missExec.join(',')}`);
    assert.strictEqual(execCols.length, RELEASE_EXEC_COLS_EXPECT.length, `sys_release_executors 列数应=${RELEASE_EXEC_COLS_EXPECT.length}，实际=${execCols.length}：${execCols.join(',')}`);
  }
  const execIdx = (await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sys_release_executors'")).map(r => r.name);
  assert.ok(execIdx.includes('idx_sys_release_exec_active'), 'idx_sys_release_exec_active 应存在');
  assert.ok(execIdx.includes('idx_sys_release_exec_release'), 'idx_sys_release_exec_release 应存在');
  assert.ok(execIdx.includes('idx_sys_release_exec_user'), 'idx_sys_release_exec_user 应存在');
  ok('sys_release_executors：19 列齐全 + 3 索引（idx_sys_release_exec_active 部分唯一 + release/user 两组合索引）存在');

  // [11h] 负例：逐条被 CHECK 拒（方案 §4.1 定稿的每一条 CHECK 分支，构造违例；Opus 预筛 MED-3 补强至
  //   与排班表 [11d]/[11f] 同等密度——覆盖 user_id/user_name/added_by/added_by_name/两枚举值域/通知态四
  //   分支各自的必填字段/执行态/软删组三字段/垃圾日期串，逐条独立隔离变量）
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 0, '张三', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'user_id=0 应被 CHECK (user_id > 0) 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, -1, '张三', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'user_id=-1 应被 CHECK (user_id > 0) 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 5, char(9)||char(9), 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'user_name 全 Tab 应被拒（双参 trim 命中，非单参 trim 缺口——[[sqlite_date_check_gotcha]] 第②条）');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 60, '', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'user_name 空串应被拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 61, '   ', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'user_name 纯空格应被拒（trim 后长度 0）');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 62, '负例甲', 0, 'admin')`, [relId1]),
    /CHECK|constraint/i, 'added_by=0 应被 CHECK (added_by > 0) 拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 63, '负例乙', 1, char(10)||char(13))`, [relId1]),
    /CHECK|constraint/i, 'added_by_name 仅 LF+CR（双参 trim 后长度 0）应被拒');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, added_by, added_by_name) VALUES (?, 64, '负例丙', 'bogus', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='bogus'（值域外）应被拒");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, added_by, added_by_name) VALUES (?, 65, '负例丁', 'bogus', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "exec_status='bogus'（值域外）应被拒");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notify_started_at, added_by, added_by_name) VALUES (?, 66, '负例戊', 'sending', datetime('now'), 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='sending' 缺 notify_token 应被拒（通知态成组 CHECK）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notify_token, added_by, added_by_name) VALUES (?, 67, '负例己', 'sending', 'tok-neg', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='sending' 缺 notify_started_at 应被拒（通知态成组 CHECK）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, added_by, added_by_name) VALUES (?, 68, '负例庚', 'done', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "exec_status='done' 无 executed_at 应被拒（执行态成组 CHECK）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, added_by, added_by_name) VALUES (?, 69, '负例辛', 'sent', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='sent' 无 notified_at 应被拒（通知态成组 CHECK）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name) VALUES (?, 70, '负例壬', 'sent', '2026-99-99', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='sent' 的 notified_at='2026-99-99'（非法日期串）应被拒");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name) VALUES (?, 71, '负例癸', 'not_sent', datetime('now'), 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='not_sent' 带 notified_at 应被拒（not_sent 分支要求 notified_at IS NULL）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notify_error, added_by, added_by_name) VALUES (?, 72, '负例子', 'not_sent', '误报错误', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='not_sent' 带 notify_error 应被拒（not_sent 分支要求 notify_error IS NULL）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, added_by, added_by_name) VALUES (?, 73, '负例丑', 'failed', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "notify_status='failed' 无 notify_error 应被拒（通知态成组 CHECK）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, removed_at, added_by, added_by_name) VALUES (?, 5, '张三', datetime('now'), 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, '半软删（仅 removed_at 非空，removed_by/removed_by_name 均 NULL）应被拒（软删成组 CHECK，同排班表 [11d] 教训）');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, removed_at, removed_by, removed_by_name, added_by, added_by_name) VALUES (?, 74, '负例寅', datetime('now'), 0, 'admin', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, '软删组 removed_by=0 应被拒（CHECK removed_by > 0）');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, removed_at, removed_by, removed_by_name, added_by, added_by_name) VALUES (?, 75, '负例卯', datetime('now'), 1, '   ', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, '软删组 removed_by_name 纯空格应被拒（trim 后长度 0）');
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, removed_at, removed_by, removed_by_name, added_by, added_by_name) VALUES (?, 76, '负例辰', 'garbage', 1, 'admin', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "软删组 removed_at='garbage'（垃圾串）应被拒（datetime(removed_at) IS NOT NULL）");
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name) VALUES (?, 5, '张三', 'done', '2026-99-99', 1, 'admin')`, [relId1]),
    /CHECK|constraint/i, "executed_at='2026-99-99'（非法日期串）应被 datetime(executed_at) IS NOT NULL 拒");
  ok('sys_release_executors 负例覆盖 22 项（逐条被 CHECK 拒，列举写实非"全覆盖"笼统措辞）：user_id≤0(×2)／user_name 全Tab／空串／纯空格／added_by=0／added_by_name 仅LF+CR／notify_status 值域外(bogus)／exec_status 值域外(bogus)／sending 缺 notify_token／sending 缺 notify_started_at／done 无 executed_at／sent 无 notified_at／sent 的 notified_at 非法日期串／not_sent 带 notified_at／not_sent 带 notify_error／failed 无 notify_error／半软删／removed_by=0／removed_by_name 纯空格／removed_at 垃圾串／executed_at 非法日期串');

  // 双向证明：负例清理后终态零残留（断言到库内查证，不只信内存；本脚本连的是 :memory: 库）——
  //   放在全部负例之后、任何正例之前，确保这里的 COUNT 真的只统计"应被拒绝却侥幸落库"的行。
  {
    const leftover = await get(`SELECT COUNT(*) AS c FROM sys_release_executors WHERE release_id = ?`, [relId1]);
    assert.strictEqual(leftover.c, 0, `负例应全部被 CHECK 拒绝、零落库，实际残留 ${leftover.c} 行`);
  }
  ok('sys_release_executors 负例终态复核：库内回查 release_id 下残留行数=0（负例确实全部被拒绝，非仅内存断言通过）');

  // [11i] 正例：能过（方案 §4.1 CHECK 允许的合法形态）+ 默认值断言（MED-3 补强）
  const execIns = (userId, userName, extraCols, extraVals) =>
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name${extraCols ? ', ' + extraCols : ''})
         VALUES (?, ?, ?, 1, 'admin'${extraVals ? ', ' + extraVals : ''})`, [relId1, userId, userName]);
  await assert.doesNotReject(execIns(30, '李四', null, null), 'not_sent 最小行应可插入');
  await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
             VALUES (?, 31, '王五', 'sent', datetime('now'), 1, 'admin')`, [relId1]);
  const rSending = await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notify_started_at, notify_token, added_by, added_by_name)
             VALUES (?, 32, '赵六', 'sending', datetime('now'), 'tok-verify-1', 1, 'admin')`, [relId1]);
  await run(`UPDATE sys_release_executors SET notify_status = 'stale' WHERE id = ?`, [rSending.lastID]);
  await assert.doesNotReject(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notify_error, added_by, added_by_name)
         VALUES (?, 33, '孙七', 'failed', '钉钉超时', 1, 'admin')`, [relId1]),
    'failed+notify_error 形态应可插入');
  ok('sys_release_executors 正例覆盖 5 种合法形态：not_sent 最小行 / sent+notified_at / sending+token+started_at / sending→stale 裸转换（UPDATE 只改 status）/ failed+notify_error —— 均成功');

  // 默认值断言：裸插最小行（只给必填 4 列）后回查三处默认值
  {
    const rDefault = await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 34, '默认值甲', 1, 'admin')`, [relId1]);
    const defRow = await get(`SELECT notify_status, exec_status, created_at, datetime(created_at) AS created_at_valid FROM sys_release_executors WHERE id = ?`, [rDefault.lastID]);
    assert.strictEqual(defRow.notify_status, 'not_sent', 'notify_status 默认应为 not_sent');
    assert.strictEqual(defRow.exec_status, 'pending', 'exec_status 默认应为 pending');
    assert.ok(defRow.created_at, 'created_at 应非空（DEFAULT datetime(\'now\',\'localtime\') 生效）');
    assert.ok(defRow.created_at_valid !== null, `created_at="${defRow.created_at}" 应是合法 datetime`);
  }
  ok('sys_release_executors 默认值：裸插最小行后回查 notify_status=not_sent / exec_status=pending / created_at 非空且合法 datetime');

  // [11j] 部分唯一索引：同 release+user 在册重复插被拒；软删旧行后同 user 再插新行必须成功（代次语义 §4.1a）
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 30, '李四', 1, 'admin')`, [relId1]),
    /UNIQUE|constraint/i, '同 release_id+user_id 在册重复插入应被 idx_sys_release_exec_active 部分唯一索引拒');
  const rowId30 = (await get(`SELECT id FROM sys_release_executors WHERE release_id = ? AND user_id = 30`, [relId1])).id;
  await run(`UPDATE sys_release_executors SET removed_at = datetime('now'), removed_by = 1, removed_by_name = 'admin' WHERE id = ?`, [rowId30]);
  await assert.doesNotReject(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, 30, '李四', 1, 'admin')`, [relId1]),
    '代次语义（§4.1a）：软删旧行（行 id 即代次）后，同 release_id+user_id 再插新行（新 id）必须成功——部分索引只约束 removed_at IS NULL 的在册行');
  ok('sys_release_executors 部分唯一索引：同 release+user 在册重复插被拒 + 软删旧行后同 user 再插新行成功（代次语义，行 id 即代次，§4.1a）');

  // [11k] FK 定义正确性（测试期 FK ON）：release_id 引用不存在的 release 被拒
  await assert.rejects(
    run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (999999, 5, '张三', 1, 'admin')`),
    /FOREIGN KEY|constraint/i, 'sys_release_executors FK 未拦截孤儿 release_id 引用');
  ok('sys_release_executors FK 定义正确（测试期）：release_id 引用不存在的 release 被拒（生产未启用 FK，仅结构声明）');

  // [12] sys_issue_timeline：event_type CHECK（含 reassign 独立枚举 05-H1）+ NOT NULL
  const issueId = (await get(`SELECT id FROM sys_issues WHERE type='feature' LIMIT 1`)).id;
  for (const ev of ['created', 'assign', 'reassign', 'estimate', 'status_change', 'scope_change', 'submit', 'return', 'release', 'reopen', 'derive', 'note', 'feasibility', 'blocked', 'unblock']) {
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, ?, 1, 'admin')`, [issueId, ev]);
  }
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, 'reject', 1, 'admin')`, [issueId]), /CHECK|constraint/i, "event_type=reject 应被 CHECK 拒（打回叫 return 非 reject，L-1）");
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_name) VALUES (?, 'note', 'admin')`, [issueId]), /NOT NULL|constraint/i, 'operator_id NOT NULL 未生效');
  ok('sys_issue_timeline：15 event_type（含 reassign 独立 05-H1 + feasibility/blocked/unblock 评估 F1 §2.2）合法，reject 被拒（L-1 打回叫 return），operator_id NOT NULL');

  // [12a] ⭐ [codex 291 号 H-2 收口·292 号 M-4 后注释修实（293-M2）] sys_issue_timeline.payload_json 列——
  //   TEXT + CHECK(json_valid)（292 号补约束后本注释原「纯 TEXT 无 CHECK」表述已过时），可空
  //   （目前仅 liaison_test_pass 写值，其余 9 种 event_type 恒 NULL，见该列 DDL 注释）；写读圆整验证
  //   （非仅列存在性）：写入一段结构化 JSON，读回精确等于原文，无编码/截断损耗。
  {
    const timelineCols = (await all('PRAGMA table_info(sys_issue_timeline)')).map(r => r.name);
    assert.ok(timelineCols.includes('payload_json'), 'sys_issue_timeline 应存在 payload_json 列');
    await assert.doesNotReject(
      run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name, payload_json) VALUES (?, 'status_change', 1, 'admin', NULL)`, [issueId]),
      'payload_json 可空（未写值的 9 种 event_type 恒 NULL，NULL 应合法插入）');
    const payloadSample = JSON.stringify({ evidence: 'both', cycle_no: 1, test_note: '含中文与"引号"的说明', attachment_ids: [10, 11] });
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name, payload_json) VALUES (?, 'status_change', 1, 'admin', ?)`, [issueId, payloadSample]);
    const readBack = await get(`SELECT payload_json FROM sys_issue_timeline WHERE issue_id = ? AND payload_json IS NOT NULL ORDER BY id DESC LIMIT 1`, [issueId]);
    assert.strictEqual(readBack.payload_json, payloadSample, 'payload_json 写读圆整：读回字符串与写入原文逐字相等（含中文/引号，无编码损耗）');
    assert.deepStrictEqual(JSON.parse(readBack.payload_json), JSON.parse(payloadSample), 'payload_json 读回可正确 JSON.parse 还原原对象');
    // [codex 293 号 M-2 收口] 非法 JSON 负例——json_valid CHECK（292 号 M-4）真的在拦（不只测合法侧）。
    await assert.rejects(
      run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name, payload_json) VALUES (?, 'status_change', 1, 'admin', ?)`, [issueId, '{broken json']),
      /CHECK/i,
      'payload_json 非法 JSON 应被 json_valid CHECK 拒绝（读侧 JSON.parse 不被脏值击穿的 DB 层保证·负例直证）');
    ok('⭐ [codex 291 号 H-2+292 号 M-4] sys_issue_timeline.payload_json 列存在 + 可空 + 写读圆整 + 非法 JSON 被 CHECK 拒绝（负例）');
  }

  // [12b] ⭐ 上线体统一重构 C0（方案 v3.4 §6.13，2026-07-28）：留痕反查基础设施
  //   action_code 是 sys_issue_timeline 首版原生列（非本 C0 新增），此处显式断言防未来被误删——
  //   idx_sys_timeline_action_ref 正是配它做 `event_type='scope_change' AND action_code IN (...) AND ref_id=?` 反查。
  const timelineCols = (await all('PRAGMA table_info(sys_issue_timeline)')).map(r => r.name);
  assert.ok(timelineCols.includes('action_code'), 'sys_issue_timeline 应含 action_code 列（首版原生列，非本 C0 新增）');
  const timelineIdx = (await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sys_issue_timeline'")).map(r => r.name);
  assert.ok(timelineIdx.includes('idx_sys_timeline_action_ref'), 'idx_sys_timeline_action_ref 应存在');
  const releaseIdxCheck = (await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sys_releases'")).map(r => r.name);
  assert.ok(releaseIdxCheck.includes('idx_sys_releases_assignee'), 'idx_sys_releases_assignee 应存在');
  ok('上线体统一重构 C0 §6.13 反查基础设施：sys_issue_timeline.action_code 列存在（首版原生列）+ idx_sys_timeline_action_ref/idx_sys_releases_assignee 两索引存在');

  // [13] sys_issue_attachments：attachment_type CHECK（含 spec）+ status CHECK + NOT NULL
  await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'spec', 'f.pdf', '需求.pdf', 1, 'admin')`, [issueId]);
  await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'delivery', 'd.zip', '交付.zip', 5, '开发')`, [issueId]);
  await assert.rejects(run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'other', 'x', 'x', 1, 'admin')`, [issueId]), /CHECK|constraint/i, 'attachment_type=other 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, status, uploaded_by, uploaded_by_name) VALUES (?, 'spec', 'x', 'x', 'pending', 1, 'admin')`, [issueId]), /CHECK|constraint/i, 'attachment status=pending 应被 CHECK 拒（无 pending 暂存态 09-M3）');
  await assert.rejects(run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'spec', 'x', 1, 'admin')`, [issueId]), /NOT NULL|constraint/i, 'file_name NOT NULL 未生效');
  const attDefault = await get(`SELECT attachment_type, status FROM sys_issue_attachments WHERE file_name='f.pdf'`);
  assert.strictEqual(attDefault.status, 'active', 'attachment status 默认 active');
  ok('sys_issue_attachments：attachment_type CHECK（delivery/screenshot/spec）+ status CHECK（active/superseded 无 pending）+ file_name NOT NULL + 默认 active');

  // [14] FK 定义正确性（测试期 FK ON）：timeline/attachments 引用不存在 issue 被拒
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (999999, 'note', 1, 'admin')`), /FOREIGN KEY|constraint/i, 'timeline FK 未拦截孤儿引用');
  await assert.rejects(run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (999999, 'spec', 'x', 'x', 1, 'admin')`), /FOREIGN KEY|constraint/i, 'attachments FK 未拦截孤儿引用');
  ok('FK 定义正确（测试期）：timeline/attachments 引用不存在 issue 被 FK 拒（生产未启用 FK，仅结构声明）');

  // [16] ⭐ 通知改造 C1a 新表 sys_issue_dev_assignees：CHECK + NOT NULL + 默认 + FK + 部分唯一索引（G12）
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary) VALUES (?, 5, '开发甲', 1)`, [issueId]);
  const devDefault = await get(`SELECT is_primary, notify_status FROM sys_issue_dev_assignees WHERE user_name='开发甲'`);
  assert.strictEqual(devDefault.is_primary, 1, '显式 is_primary=1 应生效');
  assert.strictEqual(devDefault.notify_status, 'not_sent', 'notify_status 默认应 not_sent');
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name) VALUES (?, 6, '开发乙')`, [issueId]);
  const devDefault2 = await get(`SELECT is_primary FROM sys_issue_dev_assignees WHERE user_name='开发乙'`);
  assert.strictEqual(devDefault2.is_primary, 0, 'is_primary 默认应 0');
  await assert.rejects(run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary) VALUES (?, 7, '开发丙', 2)`, [issueId]), /CHECK|constraint/i, 'is_primary=2 应被 CHECK(0,1) 拒');
  await assert.rejects(run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, notify_status) VALUES (?, 8, '开发丁', 'pending')`, [issueId]), /CHECK|constraint/i, 'notify_status=pending 应被 CHECK 拒');
  await assert.rejects(run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id) VALUES (?, 9)`, [issueId]), /NOT NULL|constraint/i, 'user_name NOT NULL 未生效');
  await assert.rejects(run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_name) VALUES (?, '缺user_id')`, [issueId]), /NOT NULL|constraint/i, 'user_id NOT NULL 未生效');
  await assert.rejects(run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name) VALUES (999999, 1, '孤儿引用')`), /FOREIGN KEY|constraint/i, 'sys_issue_dev_assignees FK 未拦截孤儿引用');
  ok('sys_issue_dev_assignees：is_primary/notify_status CHECK + 默认(0/not_sent) + user_id/user_name NOT NULL + FK 拦孤儿引用');

  // [16b] ⭐ G12 部分唯一索引：仅约束在册行（removed_at IS NULL），软删后同 (issue_id,user_id) 可再插、重复在册行应拒
  await assert.rejects(
    run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name) VALUES (?, 5, '开发甲-重复')`, [issueId]),
    /UNIQUE|constraint/i, '同 issue_id+user_id 重复在册行应被部分唯一索引拒（开发甲 user_id=5 已在册）');
  await run(`UPDATE sys_issue_dev_assignees SET removed_at = datetime('now') WHERE user_name = '开发甲'`);
  await assert.doesNotReject(
    run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name) VALUES (?, 5, '开发甲-复活')`, [issueId]),
    'G12：软删后同 (issue_id,user_id) 应可再插（部分唯一索引只约束 removed_at IS NULL 的在册行，兼容改派复活算法 §3.3）');
  const activeRows5 = await all(`SELECT user_name, removed_at FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = 5`, [issueId]);
  assert.strictEqual(activeRows5.filter(r => r.removed_at === null).length, 1, '同 (issue_id,user_id) 软删后再插，在册行应恰好 1 条');
  ok('⭐ G12 部分唯一索引验证：在册行重复拒（UNIQUE） + 软删后复活不拒（partial index 只约束 removed_at IS NULL）+ 在册行恰好 1 条');

  // [15] readiness 缺列库 → ready=false（独立 :memory: 库 + 残缺表，验 migration 探测能拦缺列）
  await verifyMissingColLib();
  // [15b] readiness：sys_issue_dev_assignees 表存在但缺自身关键列（is_primary/notify_status）→ ready=false
  await verifyMissingDevAssigneesColLib();
  // [15c] 集成审收口：readiness 全列锚点 + [1c] guard 同源——缺 removed_at（旧 2 锚点在）→ ready=false（堵坏表放行）；
  //   缺 issue_id + 有 legacy 行 → guard 跳过回填、[2] 给干净 issue_id 缺列诊断（非 [1c] SELECT 撞 da.issue_id 原始报错）
  await verifyDevAssigneesGuardAlignment();
  // [9i] ⭐ [codex 267 号 M-3] 旧库 ALTER 迁移回归：C1 之前 [9h]/[9h-meta] 只测过 CREATE 新库路径，从未测过
  //   "已上线旧表补列"这条生产真实会走的 ALTER 路径本身——本函数补齐这一半覆盖。
  await verifyLiaisonTestAlterMigration();

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 sys 七表 schema 验证通过【require 真实 initSchema，非复刻 DDL】`);
  console.log(`  覆盖：7 表（含通知改造 C1a 新表 sys_issue_dev_assignees + 上线体统一重构 C0 新表 sys_release_duty_roster + 上线执行人多选与多人双确认新表 sys_release_executors）+ 关键列（含 effected_at/三侧通知 5 列全量/可行性评估 7 列/通知改造 11 新列/上线体统一重构 C0 的 sys_releases 10 新列 + 排班表 11 列 + 执行人子表 19 列）+ 18 索引（含 G12 部分唯一索引 + C0 新增 4 索引 + 执行人多选 C0 新增 3 索引[含部分唯一索引/代次语义闸]）+ type/source/priority/三通知/relay_notify_status/event_type(15)/attachment/release status/release_assignee_notify_status(5态)/release_kind/feasibility_conclusion/needs_feasibility·blocked(0,1)/dev_assignees is_primary·notify_status/排班表 duty_date 与软删成组 CHECK/执行人子表通知态·执行态·软删三组 CHECK + config release_id 永空 DB CHECK（12-H2）+ NOT NULL + UNIQUE + 部分唯一索引(软删复活/唯一活跃值班/执行人代次) + FK 定义 + readiness 三态（含新表专项）`);
  db.close();
}

// ⭐ C2a 新增：给"残缺库"夹具补齐 SYS_REQUIRED_TABLES 里尚未建的表（最小桩：只需过 [1] 表存在性）。
//   动机：这三个夹具的焦点是**缺列**诊断，[1] 表存在性只是它们必须先跨过的门槛。此前每处都手写一份表清单，
//   于是每加一张新表（C2a 的 sys_issue_delete_audit）三处同时红灯，且报的是"表缺失"——把真正要测的
//   缺列断言整个遮住。改为从 mod._internals.SYS_REQUIRED_TABLES 派生后，加表不再需要回来改夹具。
//   ⚠️ 只补"还没建的"：焦点表由各夹具显式建成残缺形态，这里绝不覆盖（CREATE TABLE IF NOT EXISTS 保证）。
async function stubMissingRequiredTables(run, mod) {
  for (const t of mod._internals.SYS_REQUIRED_TABLES) {
    await run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY)`);
  }
}

// [15] readiness 缺列库：在独立内存库手工建一个缺关键列的 sys_issues，调 runSysMigration 应判 ready=false
async function verifyMissingColLib() {
  const db2 = new sqlite3.Database(':memory:');
  const run2 = (sql) => new Promise((res, rej) => db2.run(sql, [], function (e) { e ? rej(e) : res(this); }));
  const get2 = (sql) => new Promise((res, rej) => db2.get(sql, [], (e, row) => e ? rej(e) : res(row)));
  const all2 = (sql) => new Promise((res, rej) => db2.all(sql, [], (e, rows) => e ? rej(e) : res(rows)));
  const mod2 = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db: db2, dbRunAsync: run2, dbGetAsync: get2, dbAllAsync: all2,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),   // C3b：附件 deps stub（过工厂期 REQUIRED_DEPS 校验）
  });
  // 手工建残缺库（sys_issues 故意缺 effected_at + creator_notify_status；F1 后该残缺表同时缺评估 3 锚点
  //   needs_feasibility/feasibility_conclusion/blocked + 4 辅助列，模拟旧库/半成品——下方对全部缺失锚点逐个断言）。
  //   sys_issue_dev_assignees（通知改造 C1a 新表）本场景**完整建全**——本测试焦点是 sys_issues 缺列，
  //   [2] 复查按 checks 数组顺序 sys_issues 排第一，会先于新表命中缺列并 return，新表分支恒不可达；
  //   新表自身缺列场景见下方 verifyMissingDevAssigneesColLib（独立函数，sys_issues 走完整列集）。
  await run2(`CREATE TABLE sys_releases (id INTEGER PRIMARY KEY, release_no TEXT, status TEXT, is_hotfix INTEGER, release_note TEXT, version_tag TEXT)`);
  await run2(`CREATE TABLE sys_issues (id INTEGER PRIMARY KEY, type TEXT, status TEXT, priority TEXT, system_name TEXT, source TEXT, record_source TEXT, import_batch_id TEXT, origin_issue_id INTEGER, release_id INTEGER, created_by INTEGER, assigned_to INTEGER, assigned_to_name TEXT, dev_estimated_at TEXT, deadline TEXT, assigned_at TEXT, first_submitted_at TEXT, accepted_at TEXT, released_at TEXT, closed_at TEXT, reopened_at TEXT, reopen_count INTEGER, return_count INTEGER, scope_changed INTEGER, notify_status TEXT, notified_at TEXT, notify_message_key TEXT, notify_error TEXT, read_at TEXT, requester_notify_status TEXT)`);
  await run2(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY, event_type TEXT, from_status TEXT, to_status TEXT, action_code TEXT, ref_id INTEGER, round_no INTEGER)`);
  await run2(`CREATE TABLE sys_issue_attachments (id INTEGER PRIMARY KEY, attachment_type TEXT, round_no INTEGER, status TEXT)`);
  await run2(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT, removed_at DATETIME, dev_status TEXT, resolved_at TEXT, no_code_reason TEXT, superseded_by INTEGER)`);   // [SD1 二轮预筛 LOW-6 收口·注释如实] 本桩表列清单**不是**全列建全——它固定停在 C0 收口时的列集（不含
  //   D 组件①（2026-08-12）新增的 round_no），且往后每次 SYS_DEV_ASSIGNEES_KEY_COLS 再扩列本处都不会
  //   同步更新（本测试焦点是 sys_issues 缺列先命中，见下方 [2] 复查顺序，dev_assignees 列全不全对本
  //   测试用例结果无影响，故不必手工同步）。真正让这张残缺桩表"结构补全"的是 runSysMigration 的
  //   alterAddMissingCols 幂等 ALTER（事后补列，非本处一次性建全）——round_no 缺失时同样会被它正常
  //   补上，不会导致本测试用例失败（75 件 verify-sys-*.js 含本文件已实测验证）。
  // C0（多开发协作与 commit 留痕重构 v2.9）3 新表：本测试焦点在 sys_issues 缺列（[2] 排第一命中即 return），
  //   3 新表只需满足 [1] 表存在性即可，故建最小桩表（仅 id 列）。
  await run2(`CREATE TABLE sys_issue_dev_commits (id INTEGER PRIMARY KEY)`);
  await run2(`CREATE TABLE sys_issue_dev_events (id INTEGER PRIMARY KEY)`);
  await run2(`CREATE TABLE sys_issue_release_commit_snapshots (id INTEGER PRIMARY KEY)`);
  await run2(`CREATE TABLE sys_schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);   // C1 迁移标记表（须存在满足 [1] 表存在性；本测试焦点是 sys_issues 缺列）
  // ⭐ C2a 起：SYS_REQUIRED_TABLES 中尚未显式建的表一律补最小桩（只需过 [1] 表存在性）。
  //   这样写是为了**下次再加表时不必回来改三处残缺库夹具**——本测试焦点是"缺列"，不是"表清单齐不齐"；
  //   C2a 新增 sys_issue_delete_audit 时三处夹具同时红灯，报的却是"表缺失"，把真正要测的缺列断言遮住了。
  await stubMissingRequiredTables(run2, mod2);
  await mod2._internals.runSysMigration(null);
  const st = mod2._internals.SYS_SCHEMA_STATE;
  assert.strictEqual(st.ready, false, '缺列库 readiness 应为 false');
  // 对抗审 readiness-anchor low：逐个断言每个期望缺失锚点都被 readiness 识别——
  //   防未来有人从 SYS_ISSUES_KEY_COLS 删评估锚点（锚点回退）却因 effected_at 仍缺失而假绿放行。
  for (const c of ['effected_at', 'creator_notify_status', 'needs_feasibility', 'feasibility_conclusion', 'blocked']) {
    assert.ok(new RegExp(c).test(st.error || ''), `缺列错误信息应含锚点 ${c}，实际：${st.error}`);
  }
  // bug 流 Commit ① + 通知改造 C1a：残缺表缺的列（均在 [1a]/[1a-2] ALTER 清单内）会被 migration 自动补上——
  //   缺列错误里**不应**出现 needs_release/relay_notify_status 等（它们已被 ALTER 修复，未修复的才是真锚点缺失）。
  assert.ok(!/needs_release|dingtalk_chat_id|release_type|relay_notify_status/.test(st.error || ''), `bug 流/通知改造列应已被 [1a]/[1a-2] 自动 ALTER，不应出现在缺列错误：${st.error}`);
  const issueCols2 = (await all2('PRAGMA table_info(sys_issues)')).map(r => r.name);
  assert.ok(issueCols2.includes('needs_release') && issueCols2.includes('dingtalk_chat_id'), '[1a] 应在残缺表上自动补 bug 流列');
  assert.ok(issueCols2.includes('relay_notify_status') && issueCols2.includes('release_assignee_id'), '[1a-2] 应在残缺表上自动补通知改造新列');
  for (const c of ['release_assignee_notify_status', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_read_at']) {
    assert.ok(issueCols2.includes(c), `[1a-3] 应在残缺表上自动补第 5 类「通知上线开发」列 ${c}（5 列整组入锚点，热迁移须整组补齐否则 readiness 误报缺锚点）`);
  }
  ok(`readiness 缺列库：sys_issues 缺 effected_at/creator_notify_status/评估3锚点 → ready=false（逐锚点校验）+ bug 流/通知改造列被 [1a]/[1a-2] 自动 ALTER 修复不误报（错误：${st.error}）`);
  db2.close();
}

// [15b] readiness：sys_issue_dev_assignees 表存在但缺自身关键列（is_primary/notify_status）→ ready=false
//   sys_issues/sys_releases/timeline/attachments 均建完整列集，让 [2] 复查顺序走到 checks 数组最后一项
//   （sys_issue_dev_assignees）才命中缺列——独立验证「新表自身锚点」真正接入 readiness（非仅表存在性）。
async function verifyMissingDevAssigneesColLib() {
  const db3 = new sqlite3.Database(':memory:');
  const run3 = (sql) => new Promise((res, rej) => db3.run(sql, [], function (e) { e ? rej(e) : res(this); }));
  const get3 = (sql) => new Promise((res, rej) => db3.get(sql, [], (e, row) => e ? rej(e) : res(row)));
  const all3 = (sql) => new Promise((res, rej) => db3.all(sql, [], (e, rows) => e ? rej(e) : res(rows)));
  const mod3 = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db: db3, dbRunAsync: run3, dbGetAsync: get3, dbAllAsync: all3,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  // 完整建 sys_issues（含全部 KEY_COLS，含通知改造 11 新列，避免在 sys_issues 分支提前 return）+ 完整 releases/timeline/attachments。
  await run3(`CREATE TABLE sys_releases (id INTEGER PRIMARY KEY, release_no TEXT, status TEXT, is_hotfix INTEGER, release_note TEXT, version_tag TEXT, release_type TEXT)`);
  await run3(`CREATE TABLE sys_issues (id INTEGER PRIMARY KEY, type TEXT, status TEXT, priority TEXT, system_name TEXT, source TEXT, record_source TEXT, import_batch_id TEXT, origin_issue_id INTEGER, release_id INTEGER, created_by INTEGER, assigned_to INTEGER, assigned_to_name TEXT, dev_estimated_at TEXT, deadline TEXT, assigned_at TEXT, first_submitted_at TEXT, accepted_at TEXT, released_at TEXT, effected_at TEXT, closed_at TEXT, reopened_at TEXT, reopen_count INTEGER, return_count INTEGER, scope_changed INTEGER, notify_status TEXT, notified_at TEXT, notify_message_key TEXT, notify_error TEXT, read_at TEXT, requester_notify_status TEXT, creator_notify_status TEXT, needs_feasibility INTEGER, feasibility_conclusion TEXT, blocked INTEGER, needs_release INTEGER, related_correction_no TEXT, fix_gap_note TEXT, dingtalk_chat_id TEXT, relay_notify_status TEXT)`);
  await run3(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY, event_type TEXT, from_status TEXT, to_status TEXT, action_code TEXT, ref_id INTEGER, round_no INTEGER)`);
  await run3(`CREATE TABLE sys_issue_attachments (id INTEGER PRIMARY KEY, attachment_type TEXT, round_no INTEGER, status TEXT)`);
  // 新表存在，但故意只建 id/issue_id/user_id/user_name/removed_at——缺 is_primary + notify_status（本场景焦点）。
  await run3(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, removed_at DATETIME)`);
  // C0 3 新表：本测试焦点在 dev_assignees 自身缺列（checks 数组第 5 项命中即 return，早于 3 新表），建最小桩表满足 [1] 表存在性。
  await run3(`CREATE TABLE sys_issue_dev_commits (id INTEGER PRIMARY KEY)`);
  await run3(`CREATE TABLE sys_issue_dev_events (id INTEGER PRIMARY KEY)`);
  await run3(`CREATE TABLE sys_issue_release_commit_snapshots (id INTEGER PRIMARY KEY)`);
  await run3(`CREATE TABLE sys_schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);   // C1 迁移标记表（满足 [1] 表存在性；本测试焦点是 dev_assignees 缺列）
  await stubMissingRequiredTables(run3, mod3);   // C2a 起：其余 REQUIRED_TABLES 自动补最小桩（说明见 verifyMissingColLib）
  await mod3._internals.runSysMigration(null);
  const st3 = mod3._internals.SYS_SCHEMA_STATE;
  assert.strictEqual(st3.ready, false, 'dev_assignees 缺列库 readiness 应为 false');
  assert.ok(/sys_issue_dev_assignees/.test(st3.error || ''), `缺列错误应指明表名 sys_issue_dev_assignees，实际：${st3.error}`);
  assert.ok(/is_primary/.test(st3.error || '') && /notify_status/.test(st3.error || ''), `缺列错误应含 is_primary + notify_status 两锚点，实际：${st3.error}`);
  ok(`⭐ readiness 新表专项：sys_issue_dev_assignees 存在但缺 is_primary/notify_status → ready=false 且错误信息指明表名+两锚点（错误：${st3.error}）`);
  db3.close();
}

// [15c] 通知改造批1 集成审收口（codex MEDIUM 两条坏路径 + ultracode 五视角 #5/#6）：验证扩全列后的
//   SYS_DEV_ASSIGNEES_KEY_COLS 锚点 + [1c] guard 引用同一常量所堵住的两条不一致——
//   Case A：dev_assignees 缺 removed_at 但 is_primary/notify_status 两旧锚点在 → 旧 2 列锚点会误判 ready=true
//           「放行坏表」，扩全列后应 ready=false（堵 codex bad-path-2）。
//   Case B：dev_assignees 缺 issue_id + 有 legacy 待迁移行 → guard 现引用含 issue_id 的全列锚点应跳过回填，
//           [2] 给干净「issue_id 缺列」诊断，而非 [1c] 的 `NOT EXISTS(... da.issue_id ...)` 撞缺列抛原始
//           SQLITE no-such-column 熔断（堵 codex bad-path-1）。
async function verifyDevAssigneesGuardAlignment() {
  const mkComplete = async (run) => {
    await run(`CREATE TABLE sys_releases (id INTEGER PRIMARY KEY, release_no TEXT, status TEXT, is_hotfix INTEGER, release_note TEXT, version_tag TEXT, release_type TEXT)`);
    await run(`CREATE TABLE sys_issues (id INTEGER PRIMARY KEY, type TEXT, status TEXT, priority TEXT, system_name TEXT, source TEXT, record_source TEXT, import_batch_id TEXT, origin_issue_id INTEGER, release_id INTEGER, created_by INTEGER, assigned_to INTEGER, assigned_to_name TEXT, dev_estimated_at TEXT, deadline TEXT, assigned_at TEXT, first_submitted_at TEXT, accepted_at TEXT, released_at TEXT, effected_at TEXT, closed_at TEXT, reopened_at TEXT, reopen_count INTEGER, return_count INTEGER, scope_changed INTEGER, notify_status TEXT, notified_at TEXT, notify_message_key TEXT, notify_error TEXT, read_at TEXT, requester_notify_status TEXT, creator_notify_status TEXT, needs_feasibility INTEGER, feasibility_conclusion TEXT, blocked INTEGER, needs_release INTEGER, related_correction_no TEXT, fix_gap_note TEXT, dingtalk_chat_id TEXT, relay_notify_status TEXT)`);
    await run(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY, event_type TEXT, from_status TEXT, to_status TEXT, action_code TEXT, ref_id INTEGER, round_no INTEGER)`);
    await run(`CREATE TABLE sys_issue_attachments (id INTEGER PRIMARY KEY, attachment_type TEXT, round_no INTEGER, status TEXT)`);
    // C0（多开发协作与 commit 留痕重构 v2.9）3 新表：Case A/B 焦点均在 dev_assignees 自身缺列（checks 数组
    //   第 5 项命中即 return，早于 3 新表），建最小桩表满足 [1] 表存在性。
    await run(`CREATE TABLE sys_issue_dev_commits (id INTEGER PRIMARY KEY)`);
    await run(`CREATE TABLE sys_issue_dev_events (id INTEGER PRIMARY KEY)`);
    await run(`CREATE TABLE sys_issue_release_commit_snapshots (id INTEGER PRIMARY KEY)`);
    await run(`CREATE TABLE sys_schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);   // C1 迁移标记表（满足 [1] 表存在性；Case A/B 焦点均在 dev_assignees 缺列）
  };
  const bootMod = (db, run, get, all) => require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });

  // ── Case A：缺 removed_at，两旧锚点在 → ready=false（旧 2 列锚点会假绿放行坏表）──
  {
    const dbA = new sqlite3.Database(':memory:');
    const runA = (sql, p = []) => new Promise((res, rej) => dbA.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    const getA = (sql) => new Promise((res, rej) => dbA.get(sql, [], (e, r) => e ? rej(e) : res(r)));
    const allA = (sql) => new Promise((res, rej) => dbA.all(sql, [], (e, r) => e ? rej(e) : res(r)));
    const modA = bootMod(dbA, runA, getA, allA);
    await mkComplete(runA);
    await runA(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT)`);  // 缺 removed_at
    await stubMissingRequiredTables(runA, modA);   // C2a 起：其余 REQUIRED_TABLES 自动补最小桩
    await modA._internals.runSysMigration(null);
    const stA = modA._internals.SYS_SCHEMA_STATE;
    assert.strictEqual(stA.ready, false, 'Case A：缺 removed_at（旧 2 锚点在）应 ready=false');
    assert.ok(/removed_at/.test(stA.error || ''), `Case A：缺列错误应含 removed_at，实际：${stA.error}`);
    ok(`⭐ 集成审收口 A：dev_assignees 缺 removed_at 但 is_primary/notify_status 在 → ready=false（全列锚点堵 codex bad-path-2「坏表放行」，旧 2 列锚点会假绿）`);
    dbA.close();
  }

  // ── Case B：缺 issue_id + 有 legacy 待迁移行 → guard 跳过、[2] 干净诊断（非原始 no-such-column）──
  {
    const dbB = new sqlite3.Database(':memory:');
    const runB = (sql, p = []) => new Promise((res, rej) => dbB.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    const getB = (sql) => new Promise((res, rej) => dbB.get(sql, [], (e, r) => e ? rej(e) : res(r)));
    const allB = (sql) => new Promise((res, rej) => dbB.all(sql, [], (e, r) => e ? rej(e) : res(r)));
    const modB = bootMod(dbB, runB, getB, allB);
    await mkComplete(runB);
    await runB(`INSERT INTO sys_issues (id, type, status, assigned_to, assigned_to_name) VALUES (1, 'bug', '处理中', 5, '开发5')`);  // legacy 待迁移行
    await runB(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT, removed_at DATETIME)`);  // 缺 issue_id
    await stubMissingRequiredTables(runB, modB);   // C2a 起：其余 REQUIRED_TABLES 自动补最小桩
    await modB._internals.runSysMigration(null);
    const stB = modB._internals.SYS_SCHEMA_STATE;
    assert.strictEqual(stB.ready, false, 'Case B：缺 issue_id 应 ready=false');
    assert.ok(/issue_id/.test(stB.error || ''), `Case B：缺列错误应含 issue_id，实际：${stB.error}`);
    assert.ok(!/no such column/i.test(stB.error || ''), `Case B：应是干净缺列诊断、非 [1c] SELECT 撞 da.issue_id 的原始 no-such-column 熔断，实际：${stB.error}`);
    ok(`⭐ 集成审收口 B：dev_assignees 缺 issue_id + 有 legacy 待迁移行 → guard 引用全列锚点跳过回填、[2] 给干净 issue_id 缺列诊断（非原始 SQLITE no-such-column·堵 codex bad-path-1）`);
    dbB.close();
  }
}

// [9i] ⭐ [codex 267 号 M-3] 旧库 ALTER 迁移回归 fixture：构造一个"缺 C1 新增 14 列"的旧版 sys_issues
//   （其余列**从当前已完整 initSchema 的真实 sys_issues PRAGMA 反查派生，非手写清单**——同本文件
//   stubMissingRequiredTables 的单一来源派生哲学，防止未来 sys_issues 再演进新列时本 fixture 与真实 schema
//   静默漂移），验证 runSysMigration 的 alterAddMissingCols 幂等 ALTER 真能把这 14 列原地补齐到一张"已上线
//   旧表"上——这正是生产库升级时真实会走的路径；C1 之前 [9h]/[9h-meta] 只测过全新 CREATE TABLE 路径
//   （表压根不存在、一次建全带 CHECK），从未测过"表已存在、ALTER ADD COLUMN 补列"这条路径本身是否真的
//   执行成功、元数据是否与 CREATE 路径一致。独立 :memory: 库，同本文件其余全部子测试一致的隔离手法，不
//   触碰 task_pool.db；db.close() 后 :memory: 库随连接关闭即整体销毁，无需额外文件删除步骤。
async function verifyLiaisonTestAlterMigration() {
  const LIAISON_TEST_COLS_EXPECT_LOCAL = ['estimated_effort_days', 'risk_level', 'liaison_test_cycle_no',
    'liaison_test_recipient_id', 'liaison_test_recipient_name', 'liaison_test_notify_status',
    'liaison_test_notified_at', 'liaison_test_notify_message_key', 'liaison_test_notify_error',
    'liaison_test_read_at', 'liaison_test_notify_sent_by', 'liaison_test_notify_cycle_no',
    'liaison_test_attempt_token', 'liaison_test_attempt_started_at'];
  // ⭐ [C9-fix M2②] C9 组独立列出（不并进上面的 LIAISON_TEST_* 名字，与 index.js 侧
  //   `C9_ONLINE_SOURCE_ISSUE_COLS` 独立成组同一意图：迁移归属别混）。加入下方"旧表排除名单"后，
  //   本 fixture 建出的旧表就**真的缺这一列**，runSysMigration 的 ALTER 分支才会**真跑**到它——
  //   否则旧表从真实 schema 派生时会把 online_source 一起复制进去，ALTER 判定"列已存在"直接跳过，
  //   本 fixture 对这根列的覆盖率是 0（而我们要测的恰恰是"生产旧库升级时这条 ALTER 走不走得通"）。
  const C9_COLS_EXPECT_LOCAL = ['online_source'];
  const OLD_TABLE_EXCLUDE_COLS = [...LIAISON_TEST_COLS_EXPECT_LOCAL, ...C9_COLS_EXPECT_LOCAL];
  const NOT_NULL_DEFAULT_COLS_EXPECT_LOCAL = {
    liaison_test_cycle_no: { dflt_value: '0' },
    liaison_test_notify_cycle_no: { dflt_value: '0' },
    liaison_test_notify_status: { dflt_value: "'not_sent'" },
  };

  const dbOld = new sqlite3.Database(':memory:');
  const runOld = (sql, p = []) => new Promise((res, rej) => dbOld.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const getOld = (sql, p = []) => new Promise((res, rej) => dbOld.get(sql, p, (e, r) => e ? rej(e) : res(r)));
  const allOld = (sql, p = []) => new Promise((res, rej) => dbOld.all(sql, p, (e, r) => e ? rej(e) : res(r)));
  const modOld = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db: dbOld, dbRunAsync: runOld, dbGetAsync: getOld, dbAllAsync: allOld,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });

  // 派生"旧表"列定义：从本文件顶层已完整 initSchema 的真实 sys_issues（模块级 `db`/`all`）反查 PRAGMA，
  //   剔除 C1 新增 14 列。只保留 name+type（不复刻 NOT NULL/DEFAULT/CHECK——本测试焦点是"ALTER 能否补齐
  //   新列"，不是"旧列约束保不保真"；但 NOT NULL/DEFAULT 仍照抄真实值——大量既有列是 NOT NULL DEFAULT x
  //   （如 intake_required NOT NULL DEFAULT 1，且有触发器焓死"必须为 1"），若丢掉 DEFAULT 会让下方"旧式
  //   INSERT 不带新列"这一步在触碰新列之前就先撞别的 NOT NULL/触发器错误，反而测不到本测试真正要测的东西。
  //   唯独不复刻 CHECK——PRAGMA table_info 本就不暴露逐列 CHECK 表达式，天然只剩 NOT NULL/DEFAULT 两项，
  //   这恰好是"旧列约束保真度"里对本测试而言唯一相关的两项，其余（CHECK 逐条正确性）已由 [1]-[9h] 覆盖。
  const realCols = await all('PRAGMA table_info(sys_issues)');
  const oldColDefs = realCols
    .filter(c => c.name !== 'id' && !OLD_TABLE_EXCLUDE_COLS.includes(c.name))
    .map(c => {
      let def = `${c.name} ${c.type || 'TEXT'}`;
      if (c.notnull) def += ' NOT NULL';
      // dflt_value 统一包一层括号——PRAGMA table_info 对函数式默认值（如 created_at 的
      // datetime('now','localtime')）回报时会**丢掉原 DDL 里的外层括号**，直接拼回 CREATE TABLE
      // 对函数调用类默认值是语法错误（"DEFAULT expr" 里非字面量表达式必须加括号）；对普通字面量
      // （'0'/"'not_sent'"）额外包一层括号 SQLite 同样接受，故统一处理不用分情况判断是否为函数调用。
      if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT (${c.dflt_value})`;
      return def;
    });
  await runOld(`CREATE TABLE sys_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, ${oldColDefs.join(', ')})`);

  // 其余表：手写"完整列集"建表（同本文件 verifyDevAssigneesGuardAlignment 的 mkComplete 一贯写法），配合
  //   stubMissingRequiredTables 补全 SYS_REQUIRED_TABLES 里剩余的表（只需过 [1] 表存在性，本测试焦点在
  //   sys_issues 的 ALTER 行为，不在其余表）。
  await runOld(`CREATE TABLE sys_releases (id INTEGER PRIMARY KEY, release_no TEXT, status TEXT, is_hotfix INTEGER, release_note TEXT, version_tag TEXT, release_type TEXT)`);
  await runOld(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY, event_type TEXT, from_status TEXT, to_status TEXT, action_code TEXT, ref_id INTEGER, round_no INTEGER)`);
  await runOld(`CREATE TABLE sys_issue_attachments (id INTEGER PRIMARY KEY, attachment_type TEXT, round_no INTEGER, status TEXT)`);
  await runOld(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT, removed_at DATETIME, notify_sent_by INTEGER, dev_status TEXT, resolved_at TEXT, no_code_reason TEXT, superseded_by INTEGER)`);
  // sys_schema_migrations 须带真实结构（migration_key PRIMARY KEY）——[1a-6] C1 受理与排期改造迁移段会
  //   SELECT migration_key 判幂等，通用 stubMissingRequiredTables 的最小桩 (id INTEGER PRIMARY KEY) 没有
  //   这一列，会在迁移中途撞 no such column（同其余 fixture 的 sys_schema_migrations 显式建表先例）。
  await runOld(`CREATE TABLE sys_schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  // ⚠️ 其余 C0/C2a 表（dev_commits/dev_events/release_commit_snapshots/delete_audit/duty_roster）仍走
  //   stubMissingRequiredTables 的最小桩（仅 id 列）——本 fixture 焦点是 sys_issues 的 ALTER 行为，不是
  //   让全库整体 ready=true（那需要手写另外 5 张表的完整列集，纯属无关本测试目的的额外表面，同本文件
  //   verifyMissingColLib/verifyDevAssigneesGuardAlignment 一贯"只完整化焦点表、其余最小桩"的做法）。
  await stubMissingRequiredTables(runOld, modOld);

  await modOld._internals.runSysMigration(null);
  const stOld = modOld._internals.SYS_SCHEMA_STATE;
  // 不要求整体 ready=true（上面已注明其余表故意留最小桩，必然会在最终 [2] 复查报缺列）；改为更精确的
  // 断言：若 ready=false，错误信息**不应**指向 sys_issues 或本次新增的任一 liaison_test/estimated_effort_days/
  // risk_level 列——这样才能确认"我们的 ALTER 没有失败"，而非放过一个被其他表错误掩盖的真回归。
  if (!stOld.ready) {
    // [C9-fix M2②] 关键词加 online_source——本列已随本次改动进入 SYS_ISSUES_KEY_COLS（readiness 锚点），
    //   若 ALTER 没补上它，[2] 复查会明确报「sys_issues 关键列缺失: online_source」，本断言须能识别。
    assert.ok(!/sys_issues 关键列缺失|liaison_test_|estimated_effort_days|risk_level|online_source/.test(stOld.error || ''),
      `旧库整体 ready=false 是预期的（其余表故意最小桩），但错误信息不应指向 sys_issues 或本次新增列，实际 error=${stOld.error}`);
  }

  // PRAGMA 校验 14 列全到位 + 三 NOT NULL DEFAULT 列元数据（同 [9h-meta] 口径，验证 ALTER 路径元数据与
  //   CREATE 路径一致——notnull/dflt_value 两条路径必须相同，唯独 CHECK 不同，见下方反向探针）。
  const afterCols = await allOld('PRAGMA table_info(sys_issues)');
  const afterColsByName = new Map(afterCols.map(c => [c.name, c]));
  const missAfterAlter = OLD_TABLE_EXCLUDE_COLS.filter(c => !afterColsByName.has(c));
  assert.strictEqual(missAfterAlter.length, 0, `旧库 ALTER 后仍缺列: ${missAfterAlter.join(',')}`);
  // ⭐ [C9-fix M2②] online_source 的 ALTER 路径元数据——与新库 CREATE 路径逐项一致（TEXT/可空/无 DEFAULT）。
  //   本列是 C9 迁移面里唯一一根，单独钉：ALTER 定义写错类型/误加 NOT NULL 时，业务套件不会红（列在、能写），
  //   只有 schema 元数据比对能抓到。
  {
    const osInfo = afterColsByName.get('online_source');
    assert.ok(osInfo, '[C9-fix M2②] ALTER 路径应把 online_source 补进旧表（本 fixture 的旧表刻意不含该列，这一条红=C9 迁移分组没跑）');
    assert.strictEqual(osInfo.type, 'TEXT', `ALTER 路径 online_source 类型应为 TEXT，实际 ${osInfo.type}`);
    assert.strictEqual(osInfo.notnull, 0, `ALTER 路径 online_source 应可空，实际 notnull=${osInfo.notnull}`);
    assert.strictEqual(osInfo.dflt_value, null, `ALTER 路径 online_source 不应有 DEFAULT，实际 ${osInfo.dflt_value}`);
  }
  for (const [col, expect] of Object.entries(NOT_NULL_DEFAULT_COLS_EXPECT_LOCAL)) {
    const info = afterColsByName.get(col);
    assert.strictEqual(info.notnull, 1, `ALTER 路径 ${col} 应 notnull=1，实际 ${info.notnull}`);
    assert.strictEqual(info.dflt_value, expect.dflt_value, `ALTER 路径 ${col} dflt_value 应为 ${expect.dflt_value}，实际 ${info.dflt_value}`);
  }

  // 一次不带新列的旧式 INSERT 成功且默认值归位（证明 ALTER 补的 NOT NULL DEFAULT 列对"旧式写入口"透明生效，
  //   旧代码不用改一行就能继续插入）。
  await runOld(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name) VALUES ('feature', '开发中', 't-old-style', 'BMS', 1, 'admin')`);
  const oldStyleRow = await getOld(`SELECT liaison_test_cycle_no, liaison_test_notify_cycle_no, liaison_test_notify_status, estimated_effort_days, risk_level, online_source FROM sys_issues WHERE title='t-old-style'`);
  assert.strictEqual(oldStyleRow.liaison_test_cycle_no, 0, '旧式 INSERT（不带新列）liaison_test_cycle_no 应走 ALTER DEFAULT 归位为 0');
  assert.strictEqual(oldStyleRow.liaison_test_notify_cycle_no, 0, '旧式 INSERT liaison_test_notify_cycle_no 应走 ALTER DEFAULT 归位为 0');
  assert.strictEqual(oldStyleRow.liaison_test_notify_status, 'not_sent', '旧式 INSERT liaison_test_notify_status 应走 ALTER DEFAULT 归位为 not_sent');
  assert.strictEqual(oldStyleRow.estimated_effort_days, null, '旧式 INSERT estimated_effort_days 应为 NULL（无 DEFAULT）');
  assert.strictEqual(oldStyleRow.risk_level, null, '旧式 INSERT risk_level 应为 NULL（无 DEFAULT）');
  assert.strictEqual(oldStyleRow.online_source, null, '[C9-fix M2②] 旧式 INSERT online_source 应为 NULL（无 DEFAULT）——存量行天然 NULL，正是 DTO 三分支里 unknown_legacy 的来源');

  // ⚠️ 显式反向探针（**2026-08-06 部署 dry-run 后语义反转**）：原断言=「ALTER 路径无 CHECK 是已知预期
  //   差异，脏值应插入成功」——c58af0c 给 risk_level ALTER 定义补上与 CREATE 同款 CHECK 后（生产真实
  //   样本 dry-run 抓获的「两套语义」第三实例），该差异已消除，本探针随之反转：ALTER 路径与 CREATE
  //   路径**同样拒绝**非法值（两条建列路径约束语义一致=292-M1/dry-run 修复链的最终目标态）。
  await assert.rejects(
    runOld(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, risk_level) VALUES ('feature', '待受理', 't-old-style-no-check', 'BMS', 1, 'admin', 'gao')`),
    /CHECK/i,
    '旧库 ALTER 路径插入 risk_level=非法值"gao"应被 CHECK 拒绝（c58af0c 补齐后两路径约束语义一致）');

  // [C9-fix M2②] online_source 的两路径一致性同样要证——但它的"一致"是**两边都不设 CHECK**（刻意开放
  //   值域，三条理由见 index.js C9_ONLINE_SOURCE_ISSUE_COLS 注释），故这里是 doesNotReject 而非 rejects。
  //   与上面 risk_level 的 rejects 并排放，正是为了让读者一眼看出两根列的处置**不同且都是有意的**——
  //   不是"C9 忘了加 CHECK"。
  await assert.doesNotReject(
    runOld(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, online_source) VALUES ('feature', '待受理', 't-old-style-os-open', 'BMS', 1, 'admin', 'whatever_future_kind')`),
    '[C9-fix M2②] 旧库 ALTER 路径的 online_source 同样无 CHECK（与 CREATE 路径一致=两路径语义相同）——本条一旦红=有人只给其中一条路径加了 CHECK，那才是真正的"两套语义"缺口');

  ok('⭐ [codex 267 号 M-3+c58af0c 反转+C9-fix M2②] 旧库 ALTER 迁移回归：构造"缺 C1 14 新列 + C9 online_source"的旧版 sys_issues（其余列从真实 schema PRAGMA 派生，防手写清单漂移）→ runSysMigration 幂等 ALTER 后 15 列全到位 + 三 NOT NULL DEFAULT 列元数据与 CREATE 路径一致 + online_source 元数据（TEXT/可空/无 DEFAULT）两路径一致 → 旧式 INSERT 默认值正确归位（含 online_source=NULL） → 反向探针证实 ALTER 与 CREATE 两路径对 risk_level **同样拒绝**非法值、对 online_source **同样放行**任意值（各自有意为之，非漏配）');
  dbOld.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
