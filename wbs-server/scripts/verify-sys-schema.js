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
  ok(`${EXPECTED_INDEXES.length} 索引齐全（releases ×1 + issues ×6 + timeline ×1 + attach ×1 + dev_assignees ×2[含部分唯一索引] + 上线体统一重构 C0 新增 4[releases_assignee/duty_roster×2/timeline_action_ref]）`);

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

  // [12] sys_issue_timeline：event_type CHECK（含 reassign 独立枚举 05-H1）+ NOT NULL
  const issueId = (await get(`SELECT id FROM sys_issues WHERE type='feature' LIMIT 1`)).id;
  for (const ev of ['created', 'assign', 'reassign', 'estimate', 'status_change', 'scope_change', 'submit', 'return', 'release', 'reopen', 'derive', 'note', 'feasibility', 'blocked', 'unblock']) {
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, ?, 1, 'admin')`, [issueId, ev]);
  }
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, 'reject', 1, 'admin')`, [issueId]), /CHECK|constraint/i, "event_type=reject 应被 CHECK 拒（打回叫 return 非 reject，L-1）");
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_name) VALUES (?, 'note', 'admin')`, [issueId]), /NOT NULL|constraint/i, 'operator_id NOT NULL 未生效');
  ok('sys_issue_timeline：15 event_type（含 reassign 独立 05-H1 + feasibility/blocked/unblock 评估 F1 §2.2）合法，reject 被拒（L-1 打回叫 return），operator_id NOT NULL');

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

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 sys 六表 schema 验证通过【require 真实 initSchema，非复刻 DDL】`);
  console.log(`  覆盖：6 表（含通知改造 C1a 新表 sys_issue_dev_assignees + 上线体统一重构 C0 新表 sys_release_duty_roster）+ 关键列（含 effected_at/三侧通知 5 列全量/可行性评估 7 列/通知改造 11 新列/上线体统一重构 C0 的 sys_releases 10 新列 + 排班表 11 列）+ 15 索引（含 G12 部分唯一索引 + C0 新增 4 索引）+ type/source/priority/三通知/relay_notify_status/event_type(15)/attachment/release status/release_assignee_notify_status(5态)/release_kind/feasibility_conclusion/needs_feasibility·blocked(0,1)/dev_assignees is_primary·notify_status/排班表 duty_date 与软删成组 CHECK + config release_id 永空 DB CHECK（12-H2）+ NOT NULL + UNIQUE + 部分唯一索引(软删复活/唯一活跃值班) + FK 定义 + readiness 三态（含新表专项）`);
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
  await run2(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT, removed_at DATETIME, dev_status TEXT, resolved_at TEXT, no_code_reason TEXT, superseded_by INTEGER)`);   // 全列建全（对齐扩全列后的 SYS_DEV_ASSIGNEES_KEY_COLS，含 C0 4 列；本测试焦点是 sys_issues 缺列先命中）
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

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
