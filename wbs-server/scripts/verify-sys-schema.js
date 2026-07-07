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

  // [4] 索引齐全（11 个，通知改造 C1a 新增 dev_assignees ×2）
  const idxRows = (await all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sys%'")).map(r => r.name);
  const missingIdx = EXPECTED_INDEXES.filter(i => !idxRows.includes(i));
  assert.strictEqual(missingIdx.length, 0, `索引缺失: ${missingIdx.join(',')}`);
  ok(`${EXPECTED_INDEXES.length} 索引齐全（releases ×1 + issues ×6 + timeline ×1 + attach ×1 + dev_assignees ×2[含部分唯一索引]）`);

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

  // [12] sys_issue_timeline：event_type CHECK（含 reassign 独立枚举 05-H1）+ NOT NULL
  const issueId = (await get(`SELECT id FROM sys_issues WHERE type='feature' LIMIT 1`)).id;
  for (const ev of ['created', 'assign', 'reassign', 'estimate', 'status_change', 'scope_change', 'submit', 'return', 'release', 'reopen', 'derive', 'note', 'feasibility', 'blocked', 'unblock']) {
    await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, ?, 1, 'admin')`, [issueId, ev]);
  }
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_id, operator_name) VALUES (?, 'reject', 1, 'admin')`, [issueId]), /CHECK|constraint/i, "event_type=reject 应被 CHECK 拒（打回叫 return 非 reject，L-1）");
  await assert.rejects(run(`INSERT INTO sys_issue_timeline (issue_id, event_type, operator_name) VALUES (?, 'note', 'admin')`, [issueId]), /NOT NULL|constraint/i, 'operator_id NOT NULL 未生效');
  ok('sys_issue_timeline：15 event_type（含 reassign 独立 05-H1 + feasibility/blocked/unblock 评估 F1 §2.2）合法，reject 被拒（L-1 打回叫 return），operator_id NOT NULL');

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

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 sys 五表 schema 验证通过【require 真实 initSchema，非复刻 DDL】`);
  console.log(`  覆盖：5 表（含通知改造 C1a 新表 sys_issue_dev_assignees）+ 关键列（含 effected_at/三侧通知 5 列全量/可行性评估 7 列/通知改造 11 新列）+ 11 索引（含 G12 部分唯一索引）+ type/source/priority/三通知/relay_notify_status/event_type(15)/attachment/release status/feasibility_conclusion/needs_feasibility·blocked(0,1)/dev_assignees is_primary·notify_status CHECK + config release_id 永空 DB CHECK（12-H2）+ NOT NULL + UNIQUE + 部分唯一索引(软删复活) + FK 定义 + readiness 三态（含新表专项）`);
  db.close();
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
  await run2(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY, issue_id INTEGER, user_id INTEGER, user_name TEXT, is_primary INTEGER, notify_status TEXT, notified_at DATETIME, read_at DATETIME, notify_message_key TEXT, notify_error TEXT, removed_at DATETIME)`);   // 全列建全（对齐扩全列后的 SYS_DEV_ASSIGNEES_KEY_COLS，本测试焦点是 sys_issues 缺列先命中）
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
