// 验证脚本：系统迭代 bug 流 Commit ① 旧库 ALTER 迁移端到端（bug流_方案_20260702_v1.2 §9 [审:M1]/[codex复审:M2]）
//   用法：node scripts/verify-sys-bug-migration.js
//
// 模拟生产旧库（v1.102.x 时代 DDL：sys 四表**不含** bug 流 10 列）+ 存量数据 → require 真实模块 initSchema →
//   CREATE TABLE IF NOT EXISTS 对已存在表 no-op → runSysMigration [1a] 幂等 ALTER 补列 + [1b] release_type 回填 →
//   断言：
//   1. readiness ready=true（C-1 顺序：ALTER 先于 KEY_COLS 复查，新锚点不熔断）
//   2. sys_issues 9 新列 + sys_releases.release_type 全部 ALTER 到位
//   3. 存量行零破坏（行数/status/字段原值不变；新列 NULL）
//   4. release_type 族别回填（D-A）：纯feature→change / feature+improvement→change / 含bug→bug / 空批次→NULL
//   5. 幂等：migration 二跑 ready 不变、无 duplicate column 错、回填值不变
//   6. 两路径已知偏差铁证：ALTER 路径无 CHECK（needs_release=2 可写入旧库）——由 ② 写入口枚举校验兜底（新库 CHECK 拒，verify-sys-schema [9c] 对照）
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// ── 旧库 DDL（v1.102.x 生产现态：C1 首版列集，无 bug 流 10 列）──────────
//   与 index.js 首版 CREATE TABLE 逐字对齐（含 CHECK/DEFAULT），模拟真实生产 sqlite_master。
async function createOldSchema() {
  await run(`CREATE TABLE sys_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_no TEXT NOT NULL UNIQUE,
    title TEXT,
    status TEXT NOT NULL DEFAULT '计划中' CHECK (status IN ('计划中','已发布')),
    is_hotfix INTEGER NOT NULL DEFAULT 0,
    release_note TEXT,
    version_tag TEXT,
    planned_date DATE,
    released_at DATETIME,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
    priority_reviewed_at DATETIME,
    title TEXT NOT NULL,
    description TEXT,
    system_name TEXT NOT NULL,
    module_name TEXT,
    source TEXT NOT NULL DEFAULT '内部' CHECK (source IN ('业务方','内部','生产故障')),
    requester_dept TEXT, requester_name TEXT, requester_phone TEXT,
    origin_issue_id INTEGER REFERENCES sys_issues(id),
    release_id INTEGER REFERENCES sys_releases(id),
    created_by INTEGER NOT NULL, created_by_name TEXT NOT NULL,
    assigned_to INTEGER, assigned_to_name TEXT,
    dev_estimated_at DATETIME, deadline DATE,
    assigned_at DATETIME, first_submitted_at DATETIME, accepted_at DATETIME,
    released_at DATETIME, effected_at DATETIME, closed_at DATETIME, reopened_at DATETIME,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    return_count INTEGER NOT NULL DEFAULT 0,
    scope_changed INTEGER NOT NULL DEFAULT 0,
    last_transition_reason TEXT,
    notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (notify_status IN ('not_sent','sent','failed')),
    notified_at DATETIME, notify_message_key TEXT, notify_error TEXT, read_at DATETIME,
    requester_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (requester_notify_status IN ('not_sent','sent','failed')),
    requester_notified_at DATETIME, requester_notify_message_key TEXT, requester_notify_error TEXT, requester_read_at DATETIME,
    creator_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (creator_notify_status IN ('not_sent','sent','failed')),
    creator_notified_at DATETIME, creator_notify_message_key TEXT, creator_notify_error TEXT, creator_read_at DATETIME,
    needs_feasibility INTEGER NOT NULL DEFAULT 0 CHECK (needs_feasibility IN (0,1)),
    feasibility_conclusion TEXT CHECK (feasibility_conclusion IS NULL OR feasibility_conclusion IN ('可行','有条件可行','不可行')),
    feasibility_requirement_confirm TEXT,
    feasibility_risk TEXT,
    blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
    blocked_reason TEXT, blocked_at DATETIME,
    record_source TEXT NOT NULL DEFAULT 'native' CHECK (record_source IN ('native','import')),
    import_batch_id TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime')),
    CHECK (type <> 'config' OR release_id IS NULL)
  )`);
  await run(`CREATE TABLE sys_issue_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'created','assign','reassign','estimate','status_change','scope_change',
      'submit','return','release','reopen','derive','note',
      'feasibility','blocked','unblock'
    )),
    from_status TEXT, to_status TEXT, summary TEXT, action_code TEXT, ref_id INTEGER, round_no INTEGER,
    operator_id INTEGER NOT NULL, operator_name TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE sys_issue_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    attachment_type TEXT NOT NULL DEFAULT 'delivery' CHECK (attachment_type IN ('delivery','screenshot','spec')),
    round_no INTEGER,
    file_name TEXT NOT NULL, original_name TEXT NOT NULL, file_size INTEGER, mime_type TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
    uploaded_by INTEGER NOT NULL, uploaded_by_name TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
  )`);
}

async function main() {
  // ── [0] 旧库 + 存量数据（在 initSchema 之前落好，模拟生产热迁移）──────────
  await createOldSchema();
  // 四个批次（D-A 族别回填）：A=纯 feature / B=空 / C=feature+improvement（历史合法混批）/ D=含 bug
  await run(`INSERT INTO sys_releases (release_no, status, created_by, created_by_name) VALUES ('R-A', '已发布', 1, 'admin')`);
  await run(`INSERT INTO sys_releases (release_no, status, created_by, created_by_name) VALUES ('R-B', '计划中', 1, 'admin')`);
  await run(`INSERT INTO sys_releases (release_no, status, created_by, created_by_name) VALUES ('R-C', '已发布', 1, 'admin')`);
  await run(`INSERT INTO sys_releases (release_no, status, created_by, created_by_name) VALUES ('R-D', '已发布', 1, 'admin')`);
  const relA = (await get(`SELECT id FROM sys_releases WHERE release_no='R-A'`)).id;
  const relC = (await get(`SELECT id FROM sys_releases WHERE release_no='R-C'`)).id;
  const relD = (await get(`SELECT id FROM sys_releases WHERE release_no='R-D'`)).id;
  const seedIssue = (type, status, relId) => run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, release_id)
     VALUES (?, ?, '存量单', 'BMS', '内部', 1, 'admin', ?)`, [type, status, relId]);
  await seedIssue('feature', '已上线', relA);
  await seedIssue('feature', '已上线', relA);
  await seedIssue('feature', '已上线', relC);
  await seedIssue('improvement', '已上线', relC);
  await seedIssue('bug', '已上线', relD);           // 含 bug 成员 → 族别回填应=bug
  await seedIssue('feature', '开发中', null);   // 独立存量单（零破坏对照）
  const beforeCount = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
  ok(`旧库就绪（v1.102.x DDL 无 bug 流列）+ 存量 ${beforeCount} 单 + 批次 A(纯feature)/B(空)/C(feature+improvement)/D(含bug)`);

  // ── [1] require 真实模块 → initSchema（IF NOT EXISTS no-op）→ migration ALTER + 回填 ──────────
  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });
  const I = mod._internals;
  mod.initSchema();
  await new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
  ok('⭐ 旧库热迁移后 readiness ready=true（[1a] ALTER 先于 [2] KEY_COLS 复查，C-1 顺序正确，新锚点不熔断）');

  // ── [2] 10 新列全部到位 ──────────
  const issueCols = (await all('PRAGMA table_info(sys_issues)')).map(c => c.name);
  const NEW_ISSUE_COLS = ['needs_release', 'related_correction_no', 'derive_reason', 'fix_gap_note',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'];
  const missing = NEW_ISSUE_COLS.filter(c => !issueCols.includes(c));
  assert.strictEqual(missing.length, 0, `sys_issues 新列缺失: ${missing.join(',')}`);
  const relCols = (await all('PRAGMA table_info(sys_releases)')).map(c => c.name);
  assert.ok(relCols.includes('release_type'), 'sys_releases.release_type 应 ALTER 到位');
  ok('ALTER 到位：sys_issues 9 新列（needs_release/related_correction_no/双描述/5 群字段）+ sys_releases.release_type');

  // ── [3] 存量行零破坏 ──────────
  const afterCount = (await get('SELECT COUNT(*) c FROM sys_issues')).c;
  assert.strictEqual(afterCount, beforeCount, '存量行数不变');
  const legacy = await get(`SELECT * FROM sys_issues WHERE status='开发中'`);
  assert.strictEqual(legacy.type, 'feature', '存量单 type 原值');
  assert.strictEqual(legacy.needs_release, null, '存量行 needs_release=NULL');
  assert.strictEqual(legacy.related_correction_no, null, '存量行 related_correction_no=NULL');
  assert.strictEqual(legacy.derive_reason, null, '存量行 derive_reason=NULL');
  assert.strictEqual(legacy.fix_gap_note, null, '存量行 fix_gap_note=NULL');
  assert.strictEqual(legacy.dingtalk_chat_id, null, '存量行 dingtalk_chat_id=NULL');
  ok(`存量零破坏：${afterCount} 行原值保留 + 新列全 NULL（无 DEFAULT 回填面）`);

  // ── [4] release_type 族别回填四场景（D-A，用户 2026-07-03 拍板）──────────
  const a = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-A'`);
  assert.strictEqual(a.release_type, 'change', '纯 feature 批次 A 回填族别 change');
  const b = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-B'`);
  assert.strictEqual(b.release_type, null, '空批次 B 留 NULL（② 建批次/加单时写值）');
  const c = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-C'`);
  assert.strictEqual(c.release_type, 'change', '⭐ feature+improvement 批次 C 回填族别 change（不再留 NULL 哑弹——D-A 消解 codex H-2）');
  const d = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-D'`);
  assert.strictEqual(d.release_type, 'bug', '含 bug 成员批次 D 回填族别 bug');
  assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '含各族别历史批次时 readiness 仍 ready');
  ok('⭐ release_type 族别回填：纯feature→change / feature+improvement→change / 含bug→bug / 空→NULL（D-A：无 NULL-mixed 哑弹）');

  // ── [5] 幂等二跑 ──────────
  await I.runSysMigration(null);
  assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '二跑 ready 不变');
  assert.strictEqual(I.SYS_SCHEMA_STATE.error, null, '二跑无 duplicate column 等错误');
  const a2 = await get(`SELECT release_type FROM sys_releases WHERE release_no='R-A'`);
  assert.strictEqual(a2.release_type, 'change', '二跑回填值不变（WHERE release_type IS NULL 幂等）');
  ok('幂等：migration 二跑 ready=true / 无错 / 回填值稳定');

  // ── [6] 两路径已知偏差铁证（ALTER 无 CHECK）──────────
  //   旧库 ALTER 的 needs_release 无 CHECK → 2 可写入（有意偏差：SQLite ALTER 补约束受限，corrections [2a-x3] 同源）；
  //   新库 CREATE 路径 CHECK 拒 2（verify-sys-schema [9c] 对照断言）。运行时防线 = Commit ② 写入口枚举校验（唯一写点）。
  await assert.doesNotReject(
    run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, needs_release)
         VALUES ('bug', '待处理', '偏差铁证', 'BMS', 1, 'admin', 2)`),
    'ALTER 路径 needs_release=2 应可写入（无 CHECK，已知偏差）');
  await run(`DELETE FROM sys_issues WHERE title='偏差铁证'`);
  ok('两路径偏差铁证：旧库 ALTER 路径 needs_release 无 CHECK（=2 可写）——防线在 ② 写入口枚举校验 + 新库 CHECK（schema [9c] 对照）');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ bug 流 Commit ① 旧库 ALTER 迁移端到端验证通过`);
  console.log('  覆盖：热迁移 readiness / 10 新列 ALTER / 存量零破坏 / release_type 族别回填四场景（D-A）/ 幂等二跑 / 两路径 CHECK 偏差');
  db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
