// 验证脚本：sys_issues 受控重建迁移脚本（S1b·config流激活_方案_20260907_v1.0 §5）
//   被测：scripts/migrate-sys-issues-drop-config-release-check.js（runMigration + __testHooks）
//   用法：node scripts/verify-sys-migrate-config-release-check.js
//
// 覆盖（S1b 派单 spec §1-4 + 补丁 Y·Opus 预筛 3H/5M/8L + 补丁 Z·codex 507 审 1C/1H/3M）：
//   [FORM]  三形态：首跑迁移（apply）／幂等再跑退出0（apply，已迁移分支）／dry-run 回滚后 CHECK 仍在
//   [BRANCH] （标记×结构）真值表另外两态：新库登记（无标记∧CHECK不存在）／矛盾阻断（有标记∧CHECK存在，exit 2）
//   [MUT1-6] 六变异钩子：保留CHECK／删错约束／漏建索引／漏建触发器／序列回退／复制中断
//   [MUT-1b/2b/7] 变异注入点前移（Y5）+ 探针不回滚（Y4）——判红责任落到后检独立断言，不依赖探针先手
//   [GUARD] 真实 dev 库文件名守卫：apply 于 basename=task_pool.db 须 --confirm-db+--stop-window-ack 双旗标
//   [Z5-GUARD] Windows 大小写别名（TASK_POOL.DB）同样命中守卫；--confirm-db 大小写不同但同路径视为一致
//   [Y6-UNIT] trailing-comma / no-comma 分支直接单测（表级 CHECK 语法上不可达，见函数头注实测证据）
//   [Y7-BLANK] blankOutComments 单引号/注释边界单测
//   [REPORT-GUARD] [Z1] --report 与 --db/伴生文件冲突校验 + 排他创建，打开库之前完成
//   [REPORT-FAIL-AFTER-COMMIT]/[COMMIT-FAIL] [Z2] 提交结果/报告结果/连接关闭三阶段分离
//   [Z3] 结构指纹：已迁移分支漂移检测（缺触发器/缺索引→exit2列差异）+ fresh 分支默认不登记 vs --register-fresh
//   [Z4-PIPELINE] 逗号与目标CHECK之间夹注释的完整迁移真正跑通（不再挪夹具绕开）+ 字符串含 )/CHECK( 字面量场景
//
// fixture 设计：临时 sqlite 文件（非 :memory:——runMigration 内部自己开专用连接，:memory: 跨连接不通），
//   最小代表性旧 DDL（含目标 CHECK + 一条列级 priority CHECK + 一条表级 decoy CHECK(id>=0，MUT-2b 靶子) +
//   索引 + 真实受理门两触发器——触发器 sql 直接 require intake-gate-sql.js 单一真相源，不手抄，防两处
//   漂移 + 两条真实形态注释（含字面量 CHECK(0,1) 与含单引号）），种 4 行 + 插入第5行后删除制造
//   AUTOINCREMENT 高水位(seq)大于 max(id) 的真实形态（同本批在真实 dev 库副本上观测到的
//   seq=14343>maxId=14333 一致）。[Z4-PIPELINE] 组另建两个专用 fixture（注释贴在目标 CHECK 前 / 含
//   特殊字符串内容的 decoy CHECK），不与主 fixture 混用，避免互相干扰既有断言。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
// [补丁 AG] 以下三个仅供 [MIGRATED-LIVE] 组用——本文件此前是纯 DDL/迁移脚本测试，无 HTTP 业务层依赖；
//   本组需要真实跑通 add-issues/execute 等业务端点，故引入最小 Express 直连口径（同
//   verify-sys-config-flow.js 既有范式）。
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
  runMigration, __testHooks, MIGRATION_KEY, DEV_DB_BASENAME, _internals,
} = require('./migrate-sys-issues-drop-config-release-check');
const { SYS_INTAKE_GATE_TRIGGERS_SQL } = require('../routes/sys-iteration/intake-gate-sql');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const TMP_DIR = 'E:/tmp';
let fixtureSeq = 0;
function freshDbPath(label) {
  fixtureSeq++;
  return path.join(TMP_DIR, `lt0907-s1b-verify-fixture-${label}-${Date.now()}-${fixtureSeq}.db`);
}

function promisifyDb(db) {
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  const close = () => new Promise((res) => db.close(() => res()));
  return { run, all, get, close };
}

const SYS_RELEASES_DDL = `CREATE TABLE sys_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_no TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '计划中'
  )`;

async function buildChildTablesAndMigrationsTable(run) {
  await run(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES sys_issues(id))`);
  await run(`CREATE TABLE sys_issue_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES sys_issues(id))`);
  await run(`CREATE TABLE sys_issue_dev_assignees (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES sys_issues(id))`);
  await run(`CREATE TABLE sys_issue_delete_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER)`);
  await run(`CREATE TABLE sys_schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
}

// 构造最小代表性 fixture。withCheck=false → 直接建「新 DDL」（无目标 CHECK，模拟已用新代码建的库）。
// 恒带一条表级 decoy CHECK (id>=0)（MUT-2b 靶子）+ 两行真实注释形态（字面量 CHECK(0,1) + 含单引号），
// 验证 blankOutComments/extractAllCheckClauses 在真实注释噪音下仍不产生幻影子句。
async function buildFixture(dbPath, { withCheck = true, preRegisterMark = false } = {}) {
  const db = new sqlite3.Database(dbPath);
  const { run, get, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  const decoyClause = `,\n    CHECK (id >= 0)`;
  const checkClause = withCheck ? `,\n    CHECK (type <> 'config' OR release_id IS NULL)` : '';
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    -- ⚠️ needs_feasibility/blocked 承担 submit 闸门逻辑，脏值 2/-1 语义不清 → 硬 CHECK(0,1)（不照 scope_changed 无 CHECK 范式，同真实 index.js 注释形态——本行字面量 "CHECK(0,1)" 不应被解析成真实子句）
    -- don't touch created_at's default expression below, it's load-bearing（本行含单引号）
    created_at DATETIME DEFAULT (datetime('now','localtime'))${decoyClause}${checkClause}
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  await run(`CREATE INDEX idx_sys_issues_release ON sys_issues(release_id)`);
  await run(`CREATE UNIQUE INDEX idx_sys_issues_probe_partial ON sys_issues(system_name) WHERE priority='P0'`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);

  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  const relId = (await get(`SELECT id FROM sys_releases WHERE release_no='R-FIX-1'`)).id;

  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required, release_id) VALUES ('feature','待上线','f1','SYS',1,'admin',1,?)`, [relId]);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('improvement','开发中','i1','SYS',1,'admin',1)`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required, priority) VALUES ('bug','待评估','p0','SYS',1,'admin',1,'P0')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','tmp5','SYS',1,'admin',1)`);
  await run(`DELETE FROM sys_issues WHERE title='tmp5'`);

  if (preRegisterMark) {
    await run(`INSERT INTO sys_schema_migrations (migration_key, applied_at) VALUES (?, datetime('now','localtime'))`, [MIGRATION_KEY]);
  }
  await close();
}

// [Z4-PIPELINE-a] 注释紧贴在逗号之后、目标 CHECK 之前——补丁 Y 曾因这个位置的注释导致 surgery 校验
//   失败而挪走夹具；补丁 Z 的词法扫描器必须让这个真实场景通过。独立 fixture（不与主 fixture 混用）。
async function buildFixtureCommentBeforeCheck(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, get, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    -- [Z4] 这行行注释故意紧贴在逗号之后、目标 CHECK 之前——真实历史场景（index.js 手写 DDL 里普遍
    -- 这样写），补丁 Y 版本的裸文本比对会把这行注释原文一并计入"移除内容"校验而失败
    CHECK (type <> 'config' OR release_id IS NULL)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z4-PIPELINE-b] 两条 decoy CHECK 的字符串内容分别含 ')' 与字面量 "CHECK("——验证词法扫描器不会
//   把字符串内的 ) 误计入括号平衡、不会把字符串内的 "CHECK(" 误识别成子句起点。
async function buildFixtureStringEdgeCases(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, get, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    CHECK (title <> ')'),
    CHECK (title <> 'CHECK(bogus)'),
    CHECK (type <> 'config' OR release_id IS NULL)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z4-PIPELINE-c][AA3/508-M2] 目标 CHECK 关键字全小写——旧版本 /CHECK\s*\(/（大小写敏感）会完全漏检，
//   既不识别成目标、也不计入"其余 CHECK 集合"对拍。
async function buildFixtureLowercaseCheck(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL check (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    check (type <> 'config' or release_id is null)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z4-PIPELINE-d][AA3/508-M2] 目标 CHECK 与其内部操作符混合大小写（Check/OR/oR 混写）。
async function buildFixtureMixedCaseCheck(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL Check (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    Check (type <> 'config' Or release_id Is Null)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z4-PIPELINE-e][AA3/508-M2] 目标子句内部夹注释（块注释在 <> 与 OR 之间）+ 子句外部（逗号与子句之间）
//   另有一行行注释——同一 fixture 覆盖"内部注释随子句一起删除"与"外部相邻注释手术后原样保留"两件事。
async function buildFixtureInternalCommentCheck(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    -- [AA3] 这行外部注释应在手术后原样保留（不是目标子句的一部分）
    CHECK (type <> 'config' /* 这段内部注释是目标子句的一部分，会随子句一起被删除 */ OR release_id IS NULL)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z4-PIPELINE-f][AA3/508-M2] 两条 decoy CHECK：字符串内含 "--"（不得被误判成行注释起点）+ 字符串内
//   含 ''（转义单引号，不得提前终止字符串状态导致后续文本被误判为代码）。
async function buildFixtureDashAndEscapedQuote(dbPath) {
  const db = new sqlite3.Database(dbPath);
  const { run, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    CHECK (title <> 'a--b'),
    CHECK (title <> 'it''s ok'),
    CHECK (type <> 'config' OR release_id IS NULL)
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [AB1/AB2 · 509-H/509-M1] 通用最小 fixture 构造器：只改表级约束尾部片段（紧跟在 created_at 列定义
//   之后），其余结构与既有 fixture 同款——避免为每个词法边界场景各写一遍完整 DDL 样板。tailClauseSql
//   须自带前导逗号（如 `,\n    CHECK (...)`）。
async function buildFixtureWithTailClause(dbPath, tailClauseSql) {
  const db = new sqlite3.Database(dbPath);
  const { run, close } = promisifyDb(db);
  await run(`PRAGMA foreign_keys=OFF`);
  await run(SYS_RELEASES_DDL);
  await run(`CREATE TABLE sys_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    system_name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_by_name TEXT NOT NULL,
    release_id INTEGER REFERENCES sys_releases(id),
    intake_required INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime'))${tailClauseSql}
  )`);
  await run(`CREATE INDEX idx_sys_issues_status ON sys_issues(status)`);
  for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) { await run(sql); }
  await buildChildTablesAndMigrationsTable(run);
  await run(`INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES ('R-FIX-1', 1, 'admin')`);
  await run(`INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required) VALUES ('bug','待评估','b1','SYS',1,'admin',1)`);
  await close();
}

// [Z6] 扩到：迁移标记行（含结构指纹存在性）、索引/触发器完整 sql、四张子表行数与哈希、双表 sqlite_sequence。
async function snapshotState(dbPath) {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const { all, get, close } = promisifyDb(db);
  const rowHash = await _internals.computeRowHash(all);
  const tableRow = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
  const hasCheck = _internals.locateTargetCheck(tableRow.sql).found;
  const objRows = await _internals.captureIndexTriggerRows(all);
  const objFullSql = objRows.map((r) => `${r.type}:${r.name}:${_internals.normWs(r.sql || '')}`).sort();
  const seqRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_issues'`);
  const releasesCountRow = await get(`SELECT COUNT(*) AS c FROM sys_releases`);
  const seqReleasesRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_releases'`);
  const childCounts = {};
  const childHashes = {}; // [AA5/508-M4] 行数只能证明「数量没少」，单元值被篡改而行数不变时需要内容哈希才能判红
  for (const t of ['sys_issue_timeline', 'sys_issue_attachments', 'sys_issue_dev_assignees', 'sys_issue_delete_audit']) {
    const r = await get(`SELECT COUNT(*) AS c FROM ${t}`);
    childCounts[t] = r ? r.c : null;
    const h = await _internals.computeRowHash(all, t);
    childHashes[t] = h.agg;
  }
  const migTableRow = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_schema_migrations'`);
  let markRow = null;
  if (migTableRow) {
    markRow = await get(`SELECT * FROM sys_schema_migrations WHERE migration_key=?`, [MIGRATION_KEY]);
  }
  await close();
  return {
    rowHash: rowHash.agg, rowCount: rowHash.rowCount, hasCheck, objCount: objRows.length, objFullSql,
    seq: seqRow ? seqRow.seq : null,
    releasesCount: releasesCountRow ? releasesCountRow.c : null,
    seqReleases: seqReleasesRow ? seqReleasesRow.seq : null,
    childCounts,
    childHashes,
    markRow,
    hasFingerprint: !!(markRow && markRow.structure_fingerprint),
  };
}

function rmSafe(p) { try { fs.unlinkSync(p); } catch (_e) { /* 可能不存在，忽略 */ } }
function rmDirSafe(p) { try { fs.rmdirSync(p); } catch (_e) { /* 可能非空或已不存在，忽略 */ } }

// [AB1/AB2] 读当前 sys_issues 表的活库 DDL 原文（独立只读连接，用完即关）。
async function getTableDdl(dbPath) {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const { get, close } = promisifyDb(db);
  const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
  await close();
  return row.sql;
}

// [AB4/509-M3] 读取**实际落盘**的报告 JSON（不是函数返回值）——补丁 AA 报告曾声称"报告 JSON exitCode
// 已被断言"，实际只断言了函数返回值 r.exitCode，落盘文件本身从未被读取核验，两者不是一回事。
function readReportJson(reportPath) {
  const raw = fs.readFileSync(reportPath, 'utf8');
  return JSON.parse(raw);
}

// [AB5/509-M4] 实测文件系统大小写敏感能力（不只信 process.platform——更准确、也更贴近"实际发生的行为"）：
// 建一个混大小写探针文件，用其大写变体 fs.existsSync 探测是否命中同一文件。
function detectCaseInsensitiveFs() {
  const probePath = path.join(TMP_DIR, `lt0907-s1b-fscase-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(probePath, 'x');
  const isCaseInsensitive = fs.existsSync(probePath.toUpperCase());
  rmSafe(probePath);
  return isCaseInsensitive;
}

// ════════════════════════════════════════════════════════════════════════════
// [补丁 AG] [MIGRATED-LIVE] 组专用 helper——在一个真实带旧 DDL 的库文件上跑通 sys-iteration 真实 HTTP
//   业务层。与既有 [FORM]/[BRANCH-*]/[MUT*] 组（只读 sqlite_master/直查库）不同源，独立成一段。
// ════════════════════════════════════════════════════════════════════════════
const AG_SECRET = 'verify-migrated-live-secret';
function agSignToken(id, name, role) {
  return jwt.sign({ id, username: 'ag-u' + id, display_name: name, role }, AG_SECRET, { expiresIn: '2h' });
}
const AG_AUTHENTICATE = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, AG_SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const AG_REQUIRE_ADMIN = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

function agPromisifyDb(db) {
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  return { run, all, get };
}

// 在 dbPath 上起一个独立的 sys-iteration 真实业务 app（fresh require 出的工厂函数实例，独立 db 连接 +
//   独立端口）。initSchema() 走真实幂等 ALTER/CREATE 路径——对已存在的旧 sys_issues 表只补缺列（S1a
//   的 exec_mode/vendor_name 等新列走的正是这条 alterAddMissingCols 路，与生产升级同一条腿），CHECK
//   约束的移除只有专用迁移脚本能做（ALTER TABLE 无法改 CHECK），故 initSchema 不会、也不能碰它——这正是
//   本组要验证的"迁移脚本存在的意义"。
async function agMakeApp(dbPath) {
  const db = new sqlite3.Database(dbPath);
  db.configure('busyTimeout', 5000);
  const { run, all, get } = agPromisifyDb(db);
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  const userRow = await get(`SELECT COUNT(*) c FROM users`);
  if (!userRow || userRow.c === 0) {
    await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
      (1,'admin','管理员','admin','13800000001'),
      (5,'dev','开发王','user','13800000005'),
      (13,'wangtaotao','示例对接人','user','19900000024')`);
  }
  // fresh require 工厂——同一 Node 进程内第二次调用同一个已缓存的工厂函数，各自闭包绑定各自的
  // db/run/get/all，无共享可变状态（transitions.js/status-families.js 等被依赖模块只导出常量表）。
  const mod = require('../routes/sys-iteration')({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: AG_AUTHENTICATE, requireAdmin: AG_REQUIRE_ADMIN,
    ...require('./_sys-attach-test-deps'),
  });
  mod.initSchema();
  const I = mod._internals;
  await new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('[MIGRATED-LIVE] readiness 超时')); }
    }, 10);
  });
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  function call(method, p, tok, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: '/api' + p, method, headers: {
        'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.slice(0, 300) }; } resolve({ status: r.statusCode, body: j }); }); });
      req.on('error', reject); if (data) req.write(data); req.end();
    });
  }
  async function close() {
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => db.close(() => resolve()));
  }
  return { call, close, run, get, all, port };
}

async function main() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (_e) { /* 已存在 */ }

  // ═══ [FORM] 三形态：首跑迁移 / 幂等再跑退出0 / dry-run 回滚后 CHECK 仍在 ═══
  {
    const dbPath = freshDbPath('form');
    await buildFixture(dbPath, { withCheck: true });
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[FORM] fixture 初始含目标 CHECK');
    assert.strictEqual(before.rowCount, 4, '[FORM] fixture 初始 4 行（tmp5 已删）');

    const r1 = await runMigration({ dbPath, apply: false, reportPath: freshDbPath('form-dryrun-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r1.ok, true, `[FORM-1] dry-run 应 ok=true, got ${JSON.stringify(r1)}`);
    assert.strictEqual(r1.mode, 'executed', '[FORM-1] dry-run 走「执行迁移」路径（无标记∧CHECK存在）');
    assert.strictEqual(r1.committed, false, '[FORM-1] dry-run 不提交（committed=false）');
    const afterDryRun = await snapshotState(dbPath);
    assert.strictEqual(afterDryRun.hasCheck, true, '[FORM-1] dry-run 后目标 CHECK 仍在（ROLLBACK 未提交）');
    assert.strictEqual(afterDryRun.rowHash, before.rowHash, '[FORM-1] dry-run 后逐行哈希不变');
    assert.strictEqual(afterDryRun.seq, before.seq, '[FORM-1] dry-run 后 sqlite_sequence.seq 不变（5，未提交）');
    assert.strictEqual(afterDryRun.releasesCount, before.releasesCount, '[FORM-1] dry-run 后 sys_releases 行数不变（探针夹具批次已随 ROLLBACK 撤销）');
    assert.deepStrictEqual(afterDryRun.childCounts, before.childCounts, '[FORM-1] dry-run 后四张子表行数不变');
    assert.deepStrictEqual(afterDryRun.childHashes, before.childHashes, '[AA5][FORM-1] dry-run 后四张子表内容哈希不变');
    ok('[FORM-1] dry-run：六步执行 + 末尾 ROLLBACK，CHECK 仍在 + 行哈希/序列(双表)/sys_releases 行数/四子表行数与内容哈希不变 + committed=false（未提交任何改动）');

    const form2ReportPath = freshDbPath('form-apply-report').replace(/\.db$/, '.json');
    const r2 = await runMigration({ dbPath, apply: true, reportPath: form2ReportPath });
    assert.strictEqual(r2.ok, true, `[FORM-2] apply 首跑应 ok=true, got ${JSON.stringify(r2)}`);
    assert.strictEqual(r2.mode, 'executed', '[FORM-2] apply 首跑走「执行迁移」路径');
    assert.strictEqual(r2.committed, true, '[FORM-2] apply 首跑 committed=true');
    // [AB4/509-M3] 读取**实际落盘**的报告 JSON，断顶层 exitCode 与 result.exitCode 与返回值三者一致
    // （不再只断言函数返回值——补丁 AA 报告曾误称"报告 JSON exitCode 已被断言"，实为只测了返回值）。
    const form2Report = readReportJson(form2ReportPath);
    assert.strictEqual(form2Report.exitCode, 0, `[AB4][FORM-2] 落盘报告顶层 exitCode 应为 0, got ${form2Report.exitCode}`);
    assert.strictEqual(form2Report.result.exitCode, 0, `[AB4][FORM-2] 落盘报告 result.exitCode 应为 0, got ${form2Report.result.exitCode}`);
    assert.strictEqual(form2Report.exitCode, r2.exitCode, '[AB4][FORM-2] 落盘报告顶层 exitCode 与函数返回值 exitCode 一致');
    assert.strictEqual(form2Report.committed, true, '[AB4][FORM-2] 落盘报告 committed 字段为 true');
    const afterApply = await snapshotState(dbPath);
    assert.strictEqual(afterApply.hasCheck, false, '[FORM-2] apply 后目标 CHECK 已消失');
    assert.strictEqual(afterApply.rowHash, before.rowHash, '[FORM-2] apply 后逐行哈希与迁移前一致（数据未变，仅表结构变）');
    assert.strictEqual(afterApply.seq, 5, '[FORM-2] apply 后 sqlite_sequence.seq 恢复到 max(原seq5,maxId4)=5（高水位守恒，非重建后自然值4）');
    assert.strictEqual(afterApply.objCount, before.objCount, '[FORM-2] apply 后索引/触发器数量与迁移前一致');
    assert.strictEqual(afterApply.releasesCount, before.releasesCount, '[FORM-2] apply 后 sys_releases 行数不变');
    assert.ok(afterApply.markRow, '[FORM-2] 迁移标记已登记');
    assert.ok(afterApply.markRow.structure_fingerprint, '[Z3][FORM-2] 结构指纹已持久化落库');
    assert.deepStrictEqual(afterApply.childHashes, before.childHashes, '[AA5][FORM-2] apply 后四张子表内容哈希不变（迁移六步只重建 sys_issues，从不写子表）');
    ok('[FORM-2] apply 首跑：真提交（committed=true），CHECK 消失 + 行哈希不变 + 自增高水位恢复 + 索引触发器数量不变 + 结构指纹已落库（Z3）+ 四子表内容哈希不变');

    const r3 = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('form-idempotent-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r3.ok, true, `[FORM-3] 幂等再跑应 ok=true, got ${JSON.stringify(r3)}`);
    assert.strictEqual(r3.mode, 'already-migrated', '[FORM-3] 幂等再跑走「已迁移」分支（有标记∧CHECK不存在）');
    const afterIdempotent = await snapshotState(dbPath);
    assert.strictEqual(afterIdempotent.rowHash, before.rowHash, '[FORM-3] 幂等再跑后行哈希仍不变（探针已回滚，无残留）');
    assert.strictEqual(afterIdempotent.seq, 5, '[FORM-3] 幂等再跑后 seq 仍 5（探针插入已 ROLLBACK TO probe 撤销）');
    assert.strictEqual(afterIdempotent.releasesCount, before.releasesCount, '[FORM-3] 幂等再跑后 sys_releases 行数不变');
    ok('[FORM-3] apply 再跑一次：幂等退出0（已迁移分支，探针验证通过 + Z3 结构指纹比对一致，无重复标记冲突，无残留数据）');

    rmSafe(dbPath);
  }

  // ═══ [BRANCH-FRESH] 新库分支：无标记∧CHECK不存在 + --register-fresh → 结构验证一致后登记标记退出0 ═══
  {
    const dbPath = freshDbPath('branch-fresh');
    await buildFixture(dbPath, { withCheck: false, preRegisterMark: false });
    const r = await runMigration({ dbPath, apply: true, registerFresh: true, reportPath: freshDbPath('branch-fresh-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[BRANCH-FRESH] 应 ok=true, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'fresh-db-register', '[BRANCH-FRESH] 走「新库登记」分支（--register-fresh 已带）');
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { get, close } = promisifyDb(db);
    const markRow = await get(`SELECT migration_key, structure_fingerprint FROM sys_schema_migrations WHERE migration_key=?`, [MIGRATION_KEY]);
    await close();
    assert.ok(markRow, '[BRANCH-FRESH] 迁移标记已登记');
    assert.ok(markRow.structure_fingerprint, '[BRANCH-FRESH][Z3] 结构指纹已落库');
    ok('[BRANCH-FRESH] 新库（无标记∧CHECK不存在）+ --register-fresh：结构验证一致后登记标记 + 结构指纹基线，退出0');
    rmSafe(dbPath);
  }

  // ═══ [BRANCH-CONTRADICTION] 矛盾分支：有标记∧CHECK存在 → 阻断 exit 2，不作任何改动 ═══
  {
    const dbPath = freshDbPath('branch-contradiction');
    await buildFixture(dbPath, { withCheck: true, preRegisterMark: true });
    const before = await snapshotState(dbPath);
    const contradictionReportPath = freshDbPath('branch-contradiction-report').replace(/\.db$/, '.json');
    const r = await runMigration({ dbPath, apply: true, reportPath: contradictionReportPath });
    assert.strictEqual(r.ok, false, `[BRANCH-CONTRADICTION] 应 ok=false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'contradiction', '[BRANCH-CONTRADICTION] 走「矛盾阻断」分支');
    assert.strictEqual(r.exitCode, 2, '[BRANCH-CONTRADICTION] exitCode=2（标记与结构矛盾，非通用错误 1）');
    // [AB4/509-M3] 读取实际落盘报告，核验 exitCode（结构矛盾路径，此前从未读过落盘文件）。
    const contradictionReport = readReportJson(contradictionReportPath);
    assert.strictEqual(contradictionReport.exitCode, 2, `[AB4][BRANCH-CONTRADICTION] 落盘报告顶层 exitCode 应为 2, got ${contradictionReport.exitCode}`);
    assert.strictEqual(contradictionReport.result.exitCode, 2, `[AB4][BRANCH-CONTRADICTION] 落盘报告 result.exitCode 应为 2, got ${contradictionReport.result.exitCode}`);
    assert.strictEqual(contradictionReport.exitCode, r.exitCode, '[AB4][BRANCH-CONTRADICTION] 落盘报告 exitCode 与返回值一致');
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, true, '[BRANCH-CONTRADICTION] 阻断后 CHECK 仍在（未作任何改动）');
    assert.strictEqual(after.rowHash, before.rowHash, '[BRANCH-CONTRADICTION] 阻断后行哈希不变');
    ok('[BRANCH-CONTRADICTION] 有标记∧CHECK存在：阻断 exitCode=2，不作任何改动（CHECK仍在+行哈希不变）');
    rmSafe(dbPath);
  }

  // ═══ [MUT] 变异钩子：各自导致 exit≠0 且库回到迁移前哈希（ROLLBACK 整体撤销）═══
  async function runMutation(label, hooks, expectMessageSubstr) {
    const dbPath = freshDbPath(`mut-${label}`);
    await buildFixture(dbPath, { withCheck: true });
    const before = await snapshotState(dbPath);
    const r = await runMigration({ dbPath, apply: true, hooks, reportPath: freshDbPath(`mut-${label}-report`).replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, false, `[MUT-${label}] 应 ok=false（结构断言应判红）, got ${JSON.stringify(r)}`);
    if (expectMessageSubstr) {
      assert.ok(r.message && r.message.includes(expectMessageSubstr),
        `[MUT-${label}] 失败原因应含「${expectMessageSubstr}」, 实际 ${r.message}`);
    }
    assert.strictEqual(r.committed, false, `[MUT-${label}] committed=false（变异触发的失败不得误标已提交）`);
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, before.hasCheck, `[MUT-${label}] 库回到迁移前状态：CHECK 存在性不变`);
    assert.strictEqual(after.rowHash, before.rowHash, `[MUT-${label}] 库回到迁移前哈希：逐行哈希不变`);
    assert.strictEqual(after.seq, before.seq, `[MUT-${label}] 库回到迁移前状态：sqlite_sequence.seq 不变`);
    assert.strictEqual(after.objCount, before.objCount, `[MUT-${label}] 库回到迁移前状态：索引/触发器数量不变`);
    assert.strictEqual(after.releasesCount, before.releasesCount, `[MUT-${label}] 库回到迁移前状态：sys_releases 行数不变`);
    assert.deepStrictEqual(after.childHashes, before.childHashes, `[AA5][MUT-${label}] 库回到迁移前状态：四子表内容哈希不变`);
    rmSafe(dbPath);
    return r;
  }

  await runMutation('1-keep-check', {
    chooseNewTableDdl: (ctx) => _internals.renameCreateTableHeader(ctx.originalDdl, 'sys_issues__new'),
  }, 'CHECK constraint failed');
  ok('[MUT-1] 保留CHECK：新表 DDL 不做手术（CHECK 仍在）→ 探针插入 config+release_id 当场撞 SQLITE_CONSTRAINT（比后检更早、更直接地判红）');

  await runMutation('1b-keep-check-skip-probe', {
    chooseNewTableDdl: (ctx) => _internals.renameCreateTableHeader(ctx.originalDdl, 'sys_issues__new'),
    shouldRunProbe: () => false,
  }, '目标 CHECK 仍存在于重建后');
  ok('[MUT-1b] 保留CHECK+跳过探针（shouldRunProbe=false）→ 探针无法拦截，后检「目标CHECK仍存在于重建后sys_issues DDL中」独立判红');

  await runMutation('2-wrong-constraint', {
    chooseNewTableDdl: (ctx) => {
      const blanked = _internals.blankOutComments(ctx.originalDdl);
      const clauses = _internals.extractAllCheckClauses(blanked, ctx.originalDdl);
      const priorityClause = clauses.find((c) => /priority/.test(c.text) && !/type/.test(c.text));
      assert.ok(priorityClause, '[MUT-2] fixture 前置：应能定位到 priority 的 CHECK 子句');
      const surgery = _internals.surgeryRemoveClause(ctx.originalDdl, priorityClause, blanked);
      return _internals.renameCreateTableHeader(surgery.surgeried, 'sys_issues__new');
    },
  }, 'SQLITE_ERROR');
  ok('[MUT-2] 删错约束：手术错删列级 priority CHECK（误吞列分隔逗号，产出非法 CREATE TABLE 文本）→ db.run 当场 SQLITE_ERROR 语法错误判红');

  await runMutation('2b-remove-target-and-decoy', {
    chooseNewTableDdl: (ctx) => {
      const blanked = _internals.blankOutComments(ctx.originalDdl);
      const clauses = _internals.extractAllCheckClauses(blanked, ctx.originalDdl);
      const targetNorm = _internals.normWs(ctx.targetClauseText);
      const decoyClause = clauses.find((c) => /id\s*>=\s*0/.test(c.text));
      const targetClause = clauses.find((c) => _internals.normWs(c.text) === targetNorm);
      assert.ok(decoyClause, '[MUT-2b] fixture 前置：应能定位到 decoy 表级 CHECK (id >= 0)');
      assert.ok(targetClause, '[MUT-2b] fixture 前置：应能定位到目标 CHECK');
      const ordered = [decoyClause, targetClause].sort((a, b) => b.start - a.start);
      let ddl = ctx.originalDdl;
      for (const clause of ordered) {
        const curBlanked = _internals.blankOutComments(ddl);
        const surgery = _internals.surgeryRemoveClause(ddl, clause, curBlanked);
        ddl = surgery.surgeried;
      }
      return _internals.renameCreateTableHeader(ddl, 'sys_issues__new');
    },
  }, 'CHECK 子句数量差异不为 1');
  ok('[MUT-2b] 误删另一条表级CHECK（连同目标一并删除）→ 后检 assertOtherChecksUnchanged 用真实DDL文本二次核对判红「CHECK 子句数量差异不为 1」');

  await runMutation('3-missing-index', {
    chooseRebuildStatements: (ctx) => ctx.statements.filter((s) => s.name !== 'idx_sys_issues_status'),
  }, '索引/触发器集合与预检不一致');
  ok('[MUT-3] 漏建索引：跳过 idx_sys_issues_status 的重建 → 后检「索引/触发器集合与预检不一致」精确判红');

  await runMutation('4-missing-trigger', {
    chooseRebuildStatements: (ctx) => ctx.statements.filter((s) => s.type !== 'trigger' || !/_ins$/.test(s.name)),
  }, '索引/触发器集合与预检不一致');
  ok('[MUT-4] 漏建触发器：跳过 trg_..._intake_gate_ins 的重建 → 后检「索引/触发器集合与预检不一致」精确判红');

  await runMutation('5-seq-regress', {
    chooseSeqRestoreValue: (ctx) => ctx.maxId,
  }, 'sqlite_sequence.seq(sys_issues)=');
  ok('[MUT-5] 序列回退：恢复步骤只用 max(id) 不与原 seq 取 max（4≠期望5）→ 后检 seq 精确判红');

  await runMutation('6-copy-interrupted', {
    chooseCopyStatement: () => `INSERT INTO sys_issues__new SELECT * FROM sys_issues WHERE id NOT IN (SELECT MAX(id) FROM sys_issues) ORDER BY id`,
  }, '行数不一致');
  ok('[MUT-6] 复制中断：拷贝语句故意漏掉 1 行（模拟中途中断）→ 后检「表 sys_issues 行数不一致」精确判红');

  {
    const dbPath = freshDbPath('mut-7-probe-no-rollback');
    await buildFixture(dbPath, { withCheck: true });
    const firstRun = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('mut-7-firstrun-report').replace(/\.db$/, '.json') });
    assert.strictEqual(firstRun.ok, true, '[MUT-7] 夹具前置：首次迁移应成功进入已迁移状态');
    const before = await snapshotState(dbPath);
    const r = await runMigration({
      dbPath, apply: true,
      hooks: { shouldRollbackProbe: () => false },
      reportPath: freshDbPath('mut-7-report').replace(/\.db$/, '.json'),
    });
    assert.strictEqual(r.ok, false, `[MUT-7] 探针不回滚应被拦下, got ${JSON.stringify(r)}`);
    assert.ok(r.message && r.message.includes('探针前后快照不一致'), `[MUT-7] 失败原因应含「探针前后快照不一致」, 实际 ${r.message}`);
    assert.strictEqual(r.committed, false, '[MUT-7] committed=false');
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.rowHash, before.rowHash, '[MUT-7] 整体回滚：库回到探针尝试前的行哈希');
    assert.strictEqual(after.releasesCount, before.releasesCount, '[MUT-7] 整体回滚：sys_releases 行数不变');
    rmSafe(dbPath);
    ok('[MUT-7] 探针不回滚（shouldRollbackProbe=false）→ 已迁移分支新增的探针前后快照对拍独立判红，事务整体回滚零残留');
  }

  // ═══ [MUT-8-CHILD-TAMPER][AA5/508-M4·AB6/509 备注订正] 子表单元值被篡改但行数不变 → 必须由内容哈希判红 ═══
  //   [AB6] 补丁 AA 版本用 `issue_id + 1000` 篡改，指向的 id 在 sys_issues 里并不存在——虽然本项目
  //   FK 全程 foreign_keys=OFF（不影响写入），但 5-后检里 fkNewViolationsMultiset 仍会用
  //   PRAGMA foreign_key_check 静态查出这条新增的悬空外键违规，"到底是子表哈希判的红还是 FK 检查判的
  //   红"这条因果链不够干净（哪怕子表哈希检查确实排在 FK 检查之前先行抛错，仍是混淆变量）。改为把
  //   issue_id 指向 buildFixture 已真实存在的另一行（1→2，均为合法 issue id），彻底消除 FK 违规这个
  //   混淆因子，篡改就只剩"内容变了、行数没变"这一个变量。
  {
    const dbPath = freshDbPath('mut-8-child-tamper');
    await buildFixture(dbPath, { withCheck: true });
    // 子表默认全空，先播一行，让「行数不变」与「内容不变」两个维度能分开验证（否则空表篡改无从谈起）。
    const dbSeed = new sqlite3.Database(dbPath);
    const { run: runSeed, close: closeSeed } = promisifyDb(dbSeed);
    await runSeed(`INSERT INTO sys_issue_timeline (issue_id) VALUES (1)`); // 1 = buildFixture 的 b1，真实存在
    await closeSeed();
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.childCounts.sys_issue_timeline, 1, '[MUT-8] fixture 前置：子表已有 1 行');

    let hookCountBefore = null;
    let hookCountAfter = null;
    const r = await runMigration({
      dbPath, apply: true,
      hooks: {
        mutateChildTableAfterRebuild: async ({ run, get }) => {
          hookCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline`)).c; // [AB6] 钩子内记录行数
          // 2 = buildFixture 的 f1，同样真实存在——只改内容（指向另一条已存在父行），不产生 FK 违规。
          await run(`UPDATE sys_issue_timeline SET issue_id = 2 WHERE id = (SELECT MIN(id) FROM sys_issue_timeline)`);
          hookCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline`)).c;
        },
      },
      reportPath: freshDbPath('mut-8-report').replace(/\.db$/, '.json'),
    });
    assert.strictEqual(hookCountBefore, 1, '[AB6][MUT-8] 钩子内记录：篡改前行数=1');
    assert.strictEqual(hookCountAfter, 1, '[AB6][MUT-8] 钩子内记录：篡改后行数=1（UPDATE 不改变行数，只改内容）');
    assert.strictEqual(r.ok, false, `[MUT-8] 子表单元值被篡改（行数不变，且不违反 FK）应被后检内容哈希判红, got ${JSON.stringify(r)}`);
    assert.ok(r.message && r.message.includes('子表') && r.message.includes('内容哈希不一致'),
      `[MUT-8] 失败原因应指出子表内容哈希不一致, 实际 ${r.message}`);
    assert.ok(!/foreign_key_check|外键|FK/i.test(r.message || ''),
      `[AB6][MUT-8] 失败原因不应提及外键/FK（本次篡改指向已存在父行，不产生 FK 违规，判红原因必须单纯是内容哈希）, 实际 ${r.message}`);
    assert.strictEqual(r.committed, false, '[MUT-8] committed=false（后检判红走 ROLLBACK，不得误标已提交）');
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.childCounts.sys_issue_timeline, before.childCounts.sys_issue_timeline,
      '[MUT-8] 行数确实未变（证明单靠行数断言无法判红——必须靠内容哈希）');
    assert.deepStrictEqual(after.childHashes, before.childHashes,
      '[MUT-8] 整体回滚后子表内容哈希也恢复原值（篡改发生在同一事务内，判红触发的 ROLLBACK 一并撤销了篡改本身，库零残留）');
    rmSafe(dbPath);
    ok('[MUT-8-CHILD-TAMPER] 子表单元值被篡改但行数不变且不违反 FK（AB6 订正：改指向已存在父行，消除外键违规这一混淆因子）→ 后检子表内容哈希精确判红「子表 sys_issue_timeline 内容哈希不一致」（失败原因确认不含 FK/外键字样）；钩子内记录行数前后均为 1；事务整体回滚后篡改本身也被撤销');
  }
  // 「实现坏成什么样这条会红」——真实变异实验（非纸面推理，见交付报告"变异小结"）：复制迁移脚本删掉
  // 5-后检里的子表内容哈希比对分支，对上面这套（改指向已存在父行、无 FK 违规）场景重跑一次同款迁移，
  // 实测 ok===true（篡改未被任何其余断言拦下，因为行数/FK/CHECK集合/序列/完整性均不受影响）——证明
  // 上面 [MUT-8-CHILD-TAMPER] 的注释「删除哈希检查后本变异 ok=true」与实际一致，不是断言式空话。

  // ═══ [GUARD] 真实 dev 库文件名守卫：apply 于 basename=task_pool.db 须双旗标 ═══
  {
    const guardDir = path.join(TMP_DIR, `lt0907-s1b-guard-${Date.now()}`);
    fs.mkdirSync(guardDir, { recursive: true });
    const guardDbPath = path.join(guardDir, DEV_DB_BASENAME);
    await buildFixture(guardDbPath, { withCheck: true });
    const beforeGuard = await snapshotState(guardDbPath);

    await assert.rejects(
      runMigration({ dbPath: guardDbPath, apply: true, reportPath: path.join(guardDir, 'r1.json') }),
      /apply 需要双旗标确认，缺：.*--confirm-db.*--stop-window-ack/,
      '[GUARD-1] apply 无旗标 → 抛错并列出缺 --confirm-db 与 --stop-window-ack'
    );
    const afterReject1 = await snapshotState(guardDbPath);
    assert.strictEqual(afterReject1.hasCheck, beforeGuard.hasCheck, '[GUARD-1] 拒绝后库结构不变（CHECK 仍在）');
    assert.strictEqual(afterReject1.rowHash, beforeGuard.rowHash, '[GUARD-1] 拒绝后行哈希不变');

    await assert.rejects(
      runMigration({
        dbPath: guardDbPath, apply: true, stopWindowAck: true,
        confirmDb: path.join(guardDir, 'wrong-name.db'),
        reportPath: path.join(guardDir, 'r2.json'),
      }),
      /--confirm-db 与 --db 解析后的绝对路径不一致/,
      '[GUARD-2] --confirm-db 路径与 --db 解析后的绝对路径不一致 → 抛错'
    );
    const afterReject2 = await snapshotState(guardDbPath);
    assert.strictEqual(afterReject2.hasCheck, beforeGuard.hasCheck, '[GUARD-2] 拒绝后库结构仍不变');

    const r3 = await runMigration({
      dbPath: guardDbPath, apply: true, stopWindowAck: true,
      confirmDb: path.resolve(guardDbPath),
      reportPath: path.join(guardDir, 'r3.json'),
    });
    assert.strictEqual(r3.ok, true, `[GUARD-3] 双旗标齐全 apply 应成功, got ${JSON.stringify(r3)}`);
    const afterGuardApply = await snapshotState(guardDbPath);
    assert.strictEqual(afterGuardApply.hasCheck, false, '[GUARD-3] apply 成功后 CHECK 已移除');

    const guardDir2 = path.join(TMP_DIR, `lt0907-s1b-guard2-${Date.now()}`);
    fs.mkdirSync(guardDir2, { recursive: true });
    const guardDbPath2 = path.join(guardDir2, DEV_DB_BASENAME);
    await buildFixture(guardDbPath2, { withCheck: true });
    const r4 = await runMigration({ dbPath: guardDbPath2, apply: false, reportPath: path.join(guardDir2, 'r4.json') });
    assert.strictEqual(r4.ok, true, `[GUARD-4] dry-run 无旗标应成功, got ${JSON.stringify(r4)}`);
    const afterGuardDryRun = await snapshotState(guardDbPath2);
    assert.strictEqual(afterGuardDryRun.hasCheck, true, '[GUARD-4] dry-run 后 CHECK 仍在（已回滚，未提交，dry-run 免确认）');

    ok('[GUARD] basename=task_pool.db 守卫：apply 无旗标抛错列缺项+库不变／--confirm-db 路径不等抛错+库不变／双旗标齐全 apply 成功／dry-run 免确认且回滚');

    rmSafe(guardDbPath);
    rmSafe(guardDbPath2);
    rmDirSafe(guardDir);
    rmDirSafe(guardDir2);
  }

  // ═══ [Z5-GUARD][AA4/508-M3] Windows 大小写别名绕过双旗标——大小写敏感文件系统上语义不同，显式按平台分支 ═══
  if (process.platform !== 'win32') {
    console.log(`  ⏭ [Z5-GUARD] 跳过：当前平台非 win32（${process.platform}），basename 大小写别名守卫在大小写敏感文件系统上语义不同（TASK_POOL.DB 与 task_pool.db 是两个不同文件，双旗标不会因 basename 相同而触发）——不得伪通过，改用下方 [AA4-UNIT] 平台无关单测覆盖 lowerIfWin32/normalizeForCompare 归一化逻辑本身`);
  } else {
    const guardDir3 = path.join(TMP_DIR, `lt0907-s1b-guard3-${Date.now()}`);
    fs.mkdirSync(guardDir3, { recursive: true });
    const upperDbPath = path.join(guardDir3, 'TASK_POOL.DB');
    await buildFixture(upperDbPath, { withCheck: true });
    await assert.rejects(
      runMigration({ dbPath: upperDbPath, apply: true, reportPath: path.join(guardDir3, 'r1.json') }),
      /apply 需要双旗标确认/,
      '[Z5-GUARD-1] --db 用大写别名 TASK_POOL.DB → apply 无旗标同样被拒'
    );
    const confirmDbDifferentCase = path.join(guardDir3, 'task_pool.db'); // 小写形式，Windows 下指向同一物理文件
    const r = await runMigration({
      dbPath: upperDbPath, apply: true, stopWindowAck: true,
      confirmDb: confirmDbDifferentCase,
      reportPath: path.join(guardDir3, 'r2.json'),
    });
    assert.strictEqual(r.ok, true, `[Z5-GUARD-2] --confirm-db 大小写不同但同路径应视为一致→成功, got ${JSON.stringify(r)}`);
    rmSafe(upperDbPath);
    rmDirSafe(guardDir3);
    ok('[Z5-GUARD] Windows 大小写别名：--db=TASK_POOL.DB 无旗标同样被拒；--confirm-db 用不同大小写写同一路径归一后视为一致→成功（平台=win32，实测运行，非跳过）');
  }

  // ═══ [AA4-UNIT][508-M3] 平台无关单测：显式传入 'win32'/'linux' 两值，不依赖当前 process.platform 实际值 ═══
  {
    const upper = 'C:\\Some\\TASK_POOL.DB';
    assert.strictEqual(_internals.lowerIfWin32(upper, 'win32'), upper.toLowerCase(), '[AA4-UNIT-a] platform="win32" 归一化为小写');
    assert.strictEqual(_internals.lowerIfWin32(upper, 'linux'), upper, '[AA4-UNIT-a] platform="linux" 原样保留（大小写敏感）');
    ok('[AA4-UNIT-a] lowerIfWin32 纯函数：显式传入 win32/linux 两值分别验证大小写归一/保留（不依赖当前 process.platform 实际值）');

    const mixedPath = path.join(TMP_DIR, 'lt0907-s1b-AA4-UNIT-MixedCase.txt');
    fs.writeFileSync(mixedPath, 'x');
    const nWin = _internals.normalizeForCompare(mixedPath, 'win32');
    const nLinux = _internals.normalizeForCompare(mixedPath, 'linux');
    assert.strictEqual(nWin, nLinux.toLowerCase(),
      `[AA4-UNIT-b] normalizeForCompare(path,"win32") 应等于 normalizeForCompare(path,"linux") 的小写形式（同一真实路径，仅平台归一策略不同）, win=${nWin} linux=${nLinux}`);
    assert.ok(nLinux.includes('MixedCase'),
      `[AA4-UNIT-b] platform="linux" 时应保留原始大小写（"MixedCase" 不被抹去）——「实现坏成什么样这条会红」：若 lowerIfWin32 忽略 platform 参数恒小写，本行会红, got ${nLinux}`);
    rmSafe(mixedPath);
    ok('[AA4-UNIT-b] normalizeForCompare 纯函数：同一真实路径分别传 win32/linux，win32 结果等于 linux 结果的小写形式，linux 结果保留原始大小写');
  }

  // ═══ [AB5-REALPATH][509-M4] realpathOrResolve 独立用例三条：已存在路径／链接／真实父目录+不存在叶子 ═══
  // 备注：AA4 未给 realpathOrResolve 本身加 platform 参数——该函数只做符号链接解析与路径归一，不含大小写
  // 逻辑（大小写归一是 lowerIfWin32/normalizeForCompare 的职责，已被 AA4-UNIT-a/b 覆盖）；核实后确认
  // 没有"AA4 给它加了无实际作用的 platform 参数"这回事，无需删除。
  {
    const dir5 = path.join(TMP_DIR, `lt0907-s1b-AB5-realpath-${Date.now()}`);
    fs.mkdirSync(dir5, { recursive: true });

    // ① 已存在路径：应解析为其自身的真实绝对路径（realpathSync.native 的结果）。
    const existingPath = path.join(dir5, 'existing.txt');
    fs.writeFileSync(existingPath, 'x');
    const resolvedExisting = _internals.realpathOrResolve(existingPath);
    const nativeExisting = fs.realpathSync.native(path.resolve(existingPath));
    assert.strictEqual(resolvedExisting, nativeExisting,
      `[AB5-REALPATH-①] 已存在路径应等于 fs.realpathSync.native 的结果, got ${resolvedExisting} expect ${nativeExisting}`);
    ok('[AB5-REALPATH-①] realpathOrResolve 对已存在路径：与 fs.realpathSync.native 结果一致');

    // ② 链接：优先尝试文件符号链接（Windows 无权限时常见 EPERM）；失败则退化为**目录 junction**——
    //    junction 同为 NTFS 重解析点、被 fs.realpathSync.native 解析追踪（这是本用例要验证的核心语义：
    //    "链接会被解析到目标"），且创建 junction 在 Windows 上不需要管理员权限/开发者模式，与硬链接不同
    //    （硬链接只是同一文件的另一个目录项，没有"目标"可言，realpath 不会把它解析成另一条路径，
    //    因此硬链接不能替代本用例要验证的语义，两者都不可用才真正跳过）。
    const linkTargetFile = path.join(dir5, 'link-target.txt');
    fs.writeFileSync(linkTargetFile, 'y');
    const linkFilePath = path.join(dir5, 'link-to-target.txt');
    let linkKind = null;
    let resolvedLink = null;
    let resolvedTarget = null;
    try {
      fs.symlinkSync(linkTargetFile, linkFilePath, 'file');
      linkKind = 'symlink';
      resolvedLink = _internals.realpathOrResolve(linkFilePath);
      resolvedTarget = _internals.realpathOrResolve(linkTargetFile);
    } catch (_eSym) {
      const junctionTargetDir = path.join(dir5, 'junction-target-dir');
      const junctionLinkDir = path.join(dir5, 'junction-link-dir');
      fs.mkdirSync(junctionTargetDir, { recursive: true });
      try {
        fs.symlinkSync(junctionTargetDir, junctionLinkDir, 'junction');
        linkKind = 'junction';
        resolvedLink = _internals.realpathOrResolve(junctionLinkDir);
        resolvedTarget = _internals.realpathOrResolve(junctionTargetDir);
        rmDirSafe(junctionLinkDir);
      } catch (_eJunction) {
        linkKind = null;
      }
      rmDirSafe(junctionTargetDir);
    }
    if (linkKind) {
      assert.strictEqual(resolvedLink, resolvedTarget,
        `[AB5-REALPATH-②] ${linkKind} 应与其目标解析到同一真实路径, link=${resolvedLink} target=${resolvedTarget}`);
      if (linkKind === 'symlink') rmSafe(linkFilePath);
      ok(`[AB5-REALPATH-②] realpathOrResolve 对${linkKind === 'symlink' ? '文件符号链接' : '目录 junction'}：与目标解析到同一真实路径（本环境 symlink ${linkKind === 'symlink' ? '可用' : '不可用/无权限，已退化为 junction 验证同一"链接被解析追踪"语义'}）`);
    } else {
      console.log('  ⏭ [AB5-REALPATH-②] 跳过：本环境既无法创建文件符号链接也无法创建目录 junction（大概率权限受限），无可用链接机制验证该分支——不静默假通过');
    }
    rmSafe(linkTargetFile);

    // ③ 真实父目录 + 不存在的叶子：应退化为"父目录 realpath + 字面 basename"。
    const missingLeafPath = path.join(dir5, 'does-not-exist-leaf.txt');
    const resolvedMissing = _internals.realpathOrResolve(missingLeafPath);
    const expectedMissing = path.join(fs.realpathSync.native(dir5), 'does-not-exist-leaf.txt');
    assert.strictEqual(resolvedMissing, expectedMissing,
      `[AB5-REALPATH-③] 真实父目录+不存在叶子应退化为「父目录 realpath + 字面 basename」, got ${resolvedMissing} expect ${expectedMissing}`);
    ok('[AB5-REALPATH-③] realpathOrResolve 对真实父目录+不存在叶子：正确退化为「父目录 realpath + 字面 basename」');

    rmSafe(existingPath);
    rmDirSafe(dir5);
  }

  // ═══ [REPORT-GUARD][Z1] --report 与 --db/伴生文件冲突校验 + 排他创建，打开库之前完成 ═══
  {
    const dbPath = freshDbPath('report-guard');
    await buildFixture(dbPath, { withCheck: true });
    const beforeBytes = fs.readFileSync(dbPath);

    await assert.rejects(
      runMigration({ dbPath, apply: false, reportPath: dbPath }),
      /--report 路径与 --db 或其伴生文件.*指向同一文件/,
      '[REPORT-GUARD-1] --report=--db 同路径 → 抛错'
    );
    assert.ok(beforeBytes.equals(fs.readFileSync(dbPath)), '[REPORT-GUARD-1] 库字节内容完全不变（未被截断成 JSON，「实现坏成什么样这条会红」：删掉冲突校验会让本行从"字节不变"变成"库被写成 JSON"）');

    // [AB5/509-M4] 按实测文件系统能力分支，不再无条件假设大小写不敏感——在大小写敏感文件系统上，
    //   dbPath.toUpperCase() 是另一条真实存在（或不存在）的路径，硬套同一断言会因错误类型不同而失败。
    if (detectCaseInsensitiveFs()) {
      const dbPathUpper = dbPath.toUpperCase(); // 本文件系统大小写不敏感（已实测），指向同一物理文件
      await assert.rejects(
        runMigration({ dbPath, apply: false, reportPath: dbPathUpper }),
        /--report 路径与 --db 或其伴生文件.*指向同一文件/,
        '[REPORT-GUARD-2] --report 用大小写别名指向同一库 → 同拒'
      );
      assert.ok(beforeBytes.equals(fs.readFileSync(dbPath)), '[REPORT-GUARD-2] 库字节内容完全不变');
    } else {
      console.log('  ⏭ [REPORT-GUARD-2] 跳过：实测当前文件系统大小写敏感（探针大写变体未命中），大小写别名不指向同一物理文件，本断言在此环境语义不成立——不得伪通过');
    }

    const existingReportPath = freshDbPath('report-guard-existing').replace(/\.db$/, '.json');
    fs.writeFileSync(existingReportPath, '{"pre-existing":true}');
    await assert.rejects(
      runMigration({ dbPath, apply: false, reportPath: existingReportPath }),
      /报告文件排他创建失败/,
      '[REPORT-GUARD-3] --report 指向已存在文件 → 拒绝覆盖'
    );
    assert.strictEqual(fs.readFileSync(existingReportPath, 'utf8'), '{"pre-existing":true}', '[REPORT-GUARD-3] 已存在文件内容未被覆盖');
    rmSafe(existingReportPath);

    await assert.rejects(
      runMigration({ dbPath, apply: false, reportPath: dbPath }),
      /--report 路径与 --db 或其伴生文件.*指向同一文件/,
      '[REPORT-GUARD-4] dry-run 下 --report=--db 同样拒绝（绕不过双重校验）'
    );

    rmSafe(dbPath);
    ok('[REPORT-GUARD] --report 冲突校验：①同路径拒绝+库字节不变 ②大小写别名同拒 ③已存在文件拒绝覆盖+内容不变 ④dry-run 同样拦');
  }

  // ═══ [DB-PATH-GUARD][AA1/508-H] --db 预检：不存在/目录/非普通文件 → 明确错误，不建任何文件 ═══
  {
    const guardDir4 = path.join(TMP_DIR, `lt0907-s1b-aa1-guard-${Date.now()}`);
    fs.mkdirSync(guardDir4, { recursive: true });

    // ① --db 指向不存在路径：预检先于报告排他创建/数据库打开发生 → 二者均不落地。
    const missingDbPath = path.join(guardDir4, 'does-not-exist.db');
    const reportPath1 = path.join(guardDir4, 'r1.json');
    await assert.rejects(
      runMigration({ dbPath: missingDbPath, apply: false, reportPath: reportPath1 }),
      /目标库不存在或非普通文件/,
      '[DB-PATH-GUARD-1] --db 指向不存在路径 → 抛错'
    );
    assert.strictEqual(fs.existsSync(missingDbPath), false,
      '[DB-PATH-GUARD-1] 该路径不存在新文件（「实现坏成什么样这条会红」：若连接改回默认 OPEN_CREATE 且去掉预检，sqlite3 会在此静默建出一个 0 字节空库文件，本行会红）');
    assert.strictEqual(fs.existsSync(reportPath1), false, '[DB-PATH-GUARD-1] 报告路径无占位文件（预检早于 wx 排他创建发生）');

    // ② --db 指向目录：同一条错误文案，同样不落地任何文件。
    const dirAsDb = path.join(guardDir4, 'a-directory');
    fs.mkdirSync(dirAsDb, { recursive: true });
    const reportPath2 = path.join(guardDir4, 'r2.json');
    await assert.rejects(
      runMigration({ dbPath: dirAsDb, apply: false, reportPath: reportPath2 }),
      /目标库不存在或非普通文件/,
      '[DB-PATH-GUARD-2] --db 指向目录 → 同拒'
    );
    assert.strictEqual(fs.existsSync(reportPath2), false, '[DB-PATH-GUARD-2] 报告路径无占位文件');

    // ③ --db 指向普通文件但非 sqlite（写几个字节文本）：precheck 的 isFile() 通过，失败发生在
    //   BEGIN IMMEDIATE 读文件头时（"file is not a database"），此时报告已占位并如实记录失败原因——
    //   这条不走 throw（不同于①②的早期同步阻断），而是像其他连接期失败一样返回 {ok:false,...}。
    const fakeDbPath = path.join(guardDir4, 'fake.db');
    fs.writeFileSync(fakeDbPath, 'not a real sqlite database, just a few bytes of text');
    const fakeBytesBefore = fs.readFileSync(fakeDbPath);
    const reportPath3 = path.join(guardDir4, 'r3.json');
    const r3 = await runMigration({ dbPath: fakeDbPath, apply: false, reportPath: reportPath3 });
    assert.strictEqual(r3.ok, false, `[DB-PATH-GUARD-3] --db 指向非 sqlite 的普通文件应明确失败, got ${JSON.stringify(r3)}`);
    // [主会话 AA-③ 演练订正] 错误须按根因分类：SQLITE_NOTADB 不得套「疑似另一连接持有写锁」的误导前缀。
    //   「实现坏成什么样这条会红」：BEGIN 包装退回统一前缀 → message 不含「不是 SQLite 数据库」。
    assert.ok(/不是 SQLite 数据库/.test(String(r3.message || '')),
      `[DB-PATH-GUARD-3] 错误信息应明确「目标文件不是 SQLite 数据库」而非写锁误导前缀, got ${r3.message}`);
    const fakeBytesAfter = fs.readFileSync(fakeDbPath);
    assert.ok(fakeBytesBefore.equals(fakeBytesAfter),
      '[DB-PATH-GUARD-3] 目标文件字节完全不变（OPEN_READWRITE 不带 CREATE；sqlite3 在识别出「不是数据库」时即失败，从未对该文件发起过写入）');

    rmDirSafe(dirAsDb);
    rmSafe(fakeDbPath);
    rmSafe(reportPath1); rmSafe(reportPath2); rmSafe(reportPath3);
    rmDirSafe(guardDir4);
    ok('[DB-PATH-GUARD] --db 预检：①不存在路径→抛错+不建库文件+报告不占位 ②目录→同拒+报告不占位 ③普通文件但非sqlite→明确失败+目标文件字节不变（双保险：预检 isFile() + 连接改 OPEN_READWRITE 不带 CREATE）');
  }

  // ═══ [AB3][509-M2] 异步打开失败收口：Promise 化打开回调 + error 监听 + 可注入连接工厂 ═══
  async function withUnhandledEventMonitor(fn) {
    let unhandledCount = 0;
    const events = [];
    const onRejection = (reason) => { unhandledCount++; events.push(String((reason && reason.message) || reason)); };
    const onException = (err) => { unhandledCount++; events.push(String((err && err.message) || err)); };
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onException);
    try {
      const result = await fn();
      // 给任何延迟触发的未处理事件一个机会冒出来（微任务/宏任务队列都可能有）。
      await new Promise((res) => setTimeout(res, 80));
      return { result, unhandledCount, events };
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      process.removeListener('uncaughtException', onException);
    }
  }
  {
    // [AB3-OPEN-FAIL-HOOK] 可注入连接工厂模拟"预检通过但打开失败"——不易用真实文件系统复现（真实
    //   竞态删除/权限中途变化），改用 __testHooks.openDatabase 整体替换。
    const dbPath = freshDbPath('ab3-open-fail-hook');
    await buildFixture(dbPath, { withCheck: true });
    const beforeBytes = fs.readFileSync(dbPath);
    const reportPath = freshDbPath('ab3-open-fail-hook-report').replace(/\.db$/, '.json');

    const { result: r, unhandledCount, events } = await withUnhandledEventMonitor(() => runMigration({
      dbPath, apply: false, reportPath,
      hooks: { openDatabase: () => Promise.reject(new Error('模拟连接打开失败（AB3 测试注入，非真实文件问题）')) },
    }));
    assert.strictEqual(r.ok, false, `[AB3-OPEN-FAIL-HOOK] 打开失败应返回 ok=false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.exitCode, 1, `[AB3-OPEN-FAIL-HOOK] exitCode 应为 1, got ${r.exitCode}`);
    assert.strictEqual(unhandledCount, 0,
      `[AB3-OPEN-FAIL-HOOK] 不得出现未处理的 unhandledRejection/uncaughtException（计数应为 0）——「实现坏成什么样这条会红」：撤掉 Promise 包装、改回无回调的 new sqlite3.Database(...) 会让打开失败失去等待者, 实际=${unhandledCount} events=${JSON.stringify(events)}`);
    assert.ok(beforeBytes.equals(fs.readFileSync(dbPath)), '[AB3-OPEN-FAIL-HOOK] 目标文件字节完全不变（注入的工厂从未真正接触过文件）');
    // 报告文件：BEGIN 之前那次 claimReportFd 调用点从未到达（openDatabase 在那之前就已 reject），
    // 但"报告写入"阶段的兜底占位仍会创建它并写入失败内容——存在但非空，如实记录失败原因，不是
    // "占位但长期为空"的孤儿文件（AA1 既定设计的自然延伸）。
    assert.ok(fs.existsSync(reportPath), '[AB3-OPEN-FAIL-HOOK] 报告文件由兜底占位创建（非早期 claimReportFd 调用点）');
    const reportContent = readReportJson(reportPath);
    assert.ok(reportContent.result && reportContent.result.message && reportContent.result.message.includes('模拟连接打开失败'),
      `[AB3-OPEN-FAIL-HOOK] 报告文件内容应如实记录失败原因（非空孤儿占位）, 实际 ${JSON.stringify(reportContent.result)}`);
    rmSafe(dbPath);
    rmSafe(reportPath);
    ok('[AB3-OPEN-FAIL-HOOK] 可注入连接工厂（__testHooks.openDatabase）模拟打开回调返回错误：退出码 1、ok=false、无未处理 error 事件（unhandledRejection/uncaughtException 计数 0）、目标文件字节不变；报告文件由兜底占位创建且如实记录失败原因（非空孤儿占位）');
  }
  {
    // [AB3-OPEN-FAIL-REAL] 直接对 openDatabaseDefault（默认实现本身，非注入 hook）发起真实 sqlite3
    //   打开失败——绕开 runMigration 的预检，验证 Promise 包装 + error 监听在真实 SQLITE_CANTOPEN
    //   场景下确实干净地走 reject，不产生未处理事件（这是 hook 注入测试无法覆盖到的：hook 测试证明
    //   runMigration 正确处理"工厂拒绝"，本测试证明工厂默认实现本身面对真实 sqlite3 异步失败时也正确）。
    const missingPath = path.join(TMP_DIR, `lt0907-s1b-ab3-real-missing-${Date.now()}.db`);
    const { result, unhandledCount, events } = await withUnhandledEventMonitor(async () => {
      try {
        await _internals.openDatabaseDefault(missingPath, sqlite3.OPEN_READWRITE);
        return { rejected: false };
      } catch (e) {
        return { rejected: true, message: e.message };
      }
    });
    assert.strictEqual(result.rejected, true, '[AB3-OPEN-FAIL-REAL] 真实 sqlite3 对不存在路径 + OPEN_READWRITE（无 CREATE）应异步打开失败并被 Promise 正确 reject（未抛成未处理异常）');
    assert.strictEqual(unhandledCount, 0,
      `[AB3-OPEN-FAIL-REAL] 不得出现未处理的 unhandledRejection/uncaughtException, 实际=${unhandledCount} events=${JSON.stringify(events)}`);
    assert.strictEqual(fs.existsSync(missingPath), false, '[AB3-OPEN-FAIL-REAL] 目标路径未被静默建出文件（OPEN_READWRITE 无 CREATE，双保险生效）');
    ok(`[AB3-OPEN-FAIL-REAL] 直接对 openDatabaseDefault（默认实现，非注入 hook）发起真实 sqlite3 打开失败（路径不存在 + OPEN_READWRITE 无 CREATE）：Promise 正确 reject（消息：${result.message}），无未处理事件，未建出文件`);
  }

  // ═══ [HELP-EXITCODES][AA2/508-M1] --help 输出含四个退出码与「已提交但报告写入失败」字样 ═══
  {
    const { HELP_TEXT: helpText } = require('./migrate-sys-issues-drop-config-release-check');
    for (const code of [0, 1, 2, 3]) {
      const lineRe = new RegExp(`(^|\\n)\\s*${code}\\s+\\S`);
      assert.ok(lineRe.test(helpText), `[HELP-EXITCODES] --help 文案应有一行以退出码 ${code} 开头, 文案=${helpText}`);
    }
    assert.ok(helpText.includes('已提交但报告写入失败'), '[HELP-EXITCODES] --help 文案应含「已提交但报告写入失败」字样（exitCode=3 语义）');
    assert.ok(helpText.includes('exitCode'), '[HELP-EXITCODES] --help 文案应说明报告 JSON exitCode 字段与本表一致');
    ok('[HELP-EXITCODES] --help 输出含四个退出码（0/1/2/3）与「已提交但报告写入失败」字样，且说明与报告 JSON exitCode 字段一致');
  }
  // [AB4/509-M3 订正] 补丁 AA 报告曾称"既有 [REPORT-FAIL-AFTER-COMMIT] 用例已断言报告 JSON exitCode===3"——
  // 实际只断言了函数**返回值** r.exitCode===3，从未读取落盘文件；exitCode=3 场景本身（模拟写入失败）
  // 落盘文件必然为空（见下方用例），"文件里的 exitCode===3" 这件事根本不成立，不应要求。真正落了实际
  // 内容的三条路径（成功/事务失败/结构矛盾）已在各自用例里补上"读落盘 JSON 断 exitCode"（[AB4] 标记）。

  // ═══ [REPORT-FAIL-AFTER-COMMIT][Z2] 报告写入在 COMMIT 后失败 ═══
  {
    const dbPath = freshDbPath('report-fail-after-commit');
    await buildFixture(dbPath, { withCheck: true });
    const reportPath = freshDbPath('report-fail-after-commit-report').replace(/\.db$/, '.json');
    const origConsoleError = console.error;
    let stderrCaptured = '';
    console.error = (...args) => { stderrCaptured += args.join(' ') + '\n'; };
    let r;
    try {
      r = await runMigration({
        dbPath, apply: true, reportPath,
        hooks: { simulateReportWriteFailure: () => true },
      });
    } finally {
      console.error = origConsoleError;
    }
    assert.strictEqual(r.exitCode, 3, `[REPORT-FAIL-AFTER-COMMIT] exitCode 应为 3, got ${r.exitCode}`);
    assert.strictEqual(r.committed, true, '[REPORT-FAIL-AFTER-COMMIT] committed=true（迁移已提交，不因报告写入失败被误判）');
    assert.ok(r.reportWriteFailed, '[REPORT-FAIL-AFTER-COMMIT] reportWriteFailed=true');
    assert.ok(/已提交/.test(stderrCaptured), `[REPORT-FAIL-AFTER-COMMIT] stderr 应含"已提交"字样, 实际「${stderrCaptured}」`);
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, false, '[REPORT-FAIL-AFTER-COMMIT] 库已真实迁移：CHECK 已消失（未因报告失败被回滚）');
    assert.ok(after.markRow, '[REPORT-FAIL-AFTER-COMMIT] 标记已登记（未因报告失败被回滚，「实现坏成什么样这条会红」：若把提交后异常重新走 ROLLBACK 分支，本行会红）');
    // [AB4/509-M3] exitCode=3 语义是"迁移已提交，报告保存失败"——判定依据是**返回值** exitCode===3 +
    // committed===true（上面已断言），不要求、也不可能要求落盘文件内容含 3：这条路径下 claimReportFd
    // 仍会占位（wx 排他创建），但 simulateReportWriteFailure 短路跳过了 fs.writeSync，文件必然是**空**的
    // （0 字节）。显式断言其为空并原样保留（不清理），如实反映"报告可能不存在或不完整"这一真实语义，
    // 而不是假装它含有意义的内容。
    assert.ok(fs.existsSync(reportPath), '[AB4][REPORT-FAIL-AFTER-COMMIT] 报告文件确实被占位创建（wx 排他创建早于模拟失败发生）');
    assert.strictEqual(fs.statSync(reportPath).size, 0,
      '[AB4][REPORT-FAIL-AFTER-COMMIT] 报告文件为空（0 字节）——退出码 3 的可靠依据是返回值而非文件内容，此处如实断言"文件存在但不完整"，不虚构文件内容');
    rmSafe(dbPath);
    rmSafe(reportPath);
    ok('[REPORT-FAIL-AFTER-COMMIT] 报告写入在 COMMIT 后失败（钩子模拟）→ 库已真实迁移+标记已登记（不回滚）+ exitCode=3 + committed=true + stderr 含"已提交"字样；落盘报告文件存在但为空（0 字节，如实反映"报告可能不存在或不完整"，已清理）');
  }

  // ═══ [COMMIT-FAIL][Z2] COMMIT 本身失败 → 回滚 + 报告非 committed + 退出码≠0 ═══
  {
    const dbPath = freshDbPath('commit-fail');
    await buildFixture(dbPath, { withCheck: true });
    const before = await snapshotState(dbPath);
    const commitFailReportPath = freshDbPath('commit-fail-report').replace(/\.db$/, '.json');
    const r = await runMigration({
      dbPath, apply: true,
      reportPath: commitFailReportPath,
      hooks: { simulateCommitFailure: () => true },
    });
    assert.strictEqual(r.ok, false, `[COMMIT-FAIL] 应 ok=false, got ${JSON.stringify(r)}`);
    assert.notStrictEqual(r.exitCode, 0, '[COMMIT-FAIL] 退出码≠0');
    assert.strictEqual(r.committed, false, '[COMMIT-FAIL] committed=false（COMMIT 本身失败，不得误标已提交）');
    // [AB4/509-M3] 事务失败路径：读实际落盘报告，断 exitCode 一致（此路径 committed=false，报告能正常写出）。
    const commitFailReport = readReportJson(commitFailReportPath);
    assert.strictEqual(commitFailReport.exitCode, r.exitCode, `[AB4][COMMIT-FAIL] 落盘报告顶层 exitCode 与返回值一致, 落盘=${commitFailReport.exitCode} 返回=${r.exitCode}`);
    assert.strictEqual(commitFailReport.result.exitCode, r.exitCode, '[AB4][COMMIT-FAIL] 落盘报告 result.exitCode 与返回值一致');
    assert.strictEqual(commitFailReport.committed, false, '[AB4][COMMIT-FAIL] 落盘报告 committed 字段为 false');
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, true, '[COMMIT-FAIL] 库回到迁移前状态：CHECK 仍在（已回滚）');
    assert.strictEqual(after.rowHash, before.rowHash, '[COMMIT-FAIL] 行哈希不变');
    rmSafe(dbPath);
    ok('[COMMIT-FAIL] COMMIT 本身失败（钩子模拟）→ 走 ROLLBACK 分支，committed=false，库回到迁移前状态，退出码≠0');
  }

  // ═══ [AA6][508 备注·AB6/509 备注订正] 结构指纹排序改码点序：新算法自洽，sha256 重算不漂移 ═══
  //   [AB6] 措辞订正：本组只证明"新算法（码点序）自身确定性、多次重算结果一致"，不声称与旧 localeCompare
  //   算法产出一致——structure_fingerprint 列随本批（S1b）首次引入，生产库尚未跑过任何一次迁移，不存在
  //   "需要兼容的旧指纹"这回事，因此无需、也无法拿旧算法固定样本做对拍（若日后确有旧指纹兼容需求，
  //   应另补"旧算法固定样本 vs 新算法"的对拍用例，而不是从本组"自洽性"结果反推兼容性）。
  {
    const dbPath = freshDbPath('aa6-fingerprint-stable');
    await buildFixture(dbPath, { withCheck: true });
    const r1 = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('aa6-fp-1').replace(/\.db$/, '.json') });
    assert.strictEqual(r1.ok, true, '[AA6] 夹具前置：首次迁移应成功');

    const db1 = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { all: all1, get: get1, close: close1 } = promisifyDb(db1);
    const fp1 = await _internals.computeStructureFingerprint(all1);
    const markRow1 = await get1(`SELECT structure_fingerprint FROM sys_schema_migrations WHERE migration_key=?`, [MIGRATION_KEY]);
    await close1();
    const persisted1 = JSON.parse(markRow1.structure_fingerprint);
    assert.strictEqual(fp1.sha256, persisted1.sha256, '[AA6] 独立重算的结构指纹 sha256 与登记时持久化的一致');

    const db2 = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { all: all2, close: close2 } = promisifyDb(db2);
    const fp2 = await _internals.computeStructureFingerprint(all2);
    await close2();
    assert.strictEqual(fp2.sha256, fp1.sha256, '[AA6] 同一结构连续两次重算 sha256 完全一致（码点序排序确定性，无跨调用漂移）');
    rmSafe(dbPath);
    ok(`[AA6] 结构指纹排序改码点序（localeCompare→码点<比较）后 sha256 三方一致：登记值=${persisted1.sha256.slice(0, 12)}… 独立重算值=${fp1.sha256.slice(0, 12)}… 二次重算值=${fp2.sha256.slice(0, 12)}…`);
  }
  {
    // [AA6-STATIC] 静态复核：源码中已无 localeCompare（改用码点序，避免跨运行时/locale 排序漂移）。
    const srcPath = require.resolve('./migrate-sys-issues-drop-config-release-check');
    const src = fs.readFileSync(srcPath, 'utf8');
    // 按真实方法调用形态 `.localeCompare(` 匹配，不匹配注释里提及这个方法名的说明文字。
    assert.ok(!/\.localeCompare\(/.test(src),
      '[AA6-STATIC] 迁移脚本源码不应再出现 .localeCompare( 调用——「实现坏成什么样这条会红」：若有人把排序改回 .sort((a,b)=>a.localeCompare(b))，本行立即判红');
    ok('[AA6-STATIC] 静态守卫：源码中已无 localeCompare（AA6 改码点序完成，防止未来复发）');
  }

  // ═══ [Z3] 结构指纹：已迁移分支漂移检测 + fresh 分支默认不登记 vs --register-fresh ═══
  {
    const dbPath = freshDbPath('z3-drift-trigger');
    await buildFixture(dbPath, { withCheck: true });
    const firstRun = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z3-drift-trigger-first').replace(/\.db$/, '.json') });
    assert.strictEqual(firstRun.ok, true, '[Z3-a] 夹具前置：首次迁移应成功');
    const dbDirect = new sqlite3.Database(dbPath);
    const { run: runDirect, close: closeDirect } = promisifyDb(dbDirect);
    await runDirect(`DROP TRIGGER trg_sys_issues_intake_gate_ins`);
    await closeDirect();
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z3-drift-trigger-second').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, false, `[Z3-a] 漂移后重跑应 ok=false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.exitCode, 2, '[Z3-a] exitCode=2');
    assert.ok(/trg_sys_issues_intake_gate_ins/.test(r.message), `[Z3-a] 差异消息应指出缺哪个对象, 实际 ${r.message}`);
    rmSafe(dbPath);
    ok('[Z3-a] 已迁移分支结构指纹比对：手动删一个触发器后重跑 → exit 2 且消息指出缺 trg_sys_issues_intake_gate_ins（不再只凭对象名集合宣布"结构一致"）');
  }
  {
    const dbPath = freshDbPath('z3-drift-index');
    await buildFixture(dbPath, { withCheck: true });
    await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z3-drift-index-first').replace(/\.db$/, '.json') });
    const dbDirect = new sqlite3.Database(dbPath);
    const { run: runDirect, close: closeDirect } = promisifyDb(dbDirect);
    await runDirect(`DROP INDEX idx_sys_issues_status`);
    await closeDirect();
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z3-drift-index-second').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, false, `[Z3-b] 漂移后重跑应 ok=false, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.exitCode, 2, '[Z3-b] exitCode=2');
    assert.ok(/idx_sys_issues_status/.test(r.message), `[Z3-b] 差异消息应指出缺哪个对象, 实际 ${r.message}`);
    rmSafe(dbPath);
    ok('[Z3-b] 已迁移分支结构指纹比对：手动删一个普通索引后重跑 → exit 2 且消息指出缺 idx_sys_issues_status');
  }
  {
    const dbPath = freshDbPath('z3-fresh-noflag');
    await buildFixture(dbPath, { withCheck: false, preRegisterMark: false });
    const before = await snapshotState(dbPath);
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z3-fresh-noflag-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z3-c] fresh 无旗标应 ok=true(结构验证通过但不登记), got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'fresh-db-unregistered', '[Z3-c] mode=fresh-db-unregistered');
    assert.strictEqual(r.committed, false, '[Z3-c] committed=false（无 --register-fresh 时即便 apply 也不写库）');
    const after = await snapshotState(dbPath);
    assert.ok(!after.markRow, '[Z3-c] 未登记标记（无 --register-fresh）');
    assert.strictEqual(after.rowHash, before.rowHash, '[Z3-c] 不写库：行哈希不变');
    rmSafe(dbPath);
    ok('[Z3-c] 新库分支（无标记∧CHECK不存在）无 --register-fresh → 不登记、不写库、退出0（mode=fresh-db-unregistered）');
  }
  {
    const dbPath = freshDbPath('z3-fresh-registered');
    await buildFixture(dbPath, { withCheck: false, preRegisterMark: false });
    const r = await runMigration({ dbPath, apply: true, registerFresh: true, reportPath: freshDbPath('z3-fresh-registered-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z3-d] fresh + --register-fresh 应 ok=true, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'fresh-db-register', '[Z3-d] mode=fresh-db-register');
    const after = await snapshotState(dbPath);
    assert.ok(after.markRow, '[Z3-d] 已登记标记');
    assert.ok(after.markRow.structure_fingerprint, '[Z3-d] 结构指纹已落库');
    rmSafe(dbPath);
    ok('[Z3-d] 新库分支 + --register-fresh → 登记标记 + 结构指纹基线落库');
  }

  // ═══ [Z4-PIPELINE] 完整迁移流水线级别的词法扫描器验证（不再挪夹具绕开）═══
  {
    const dbPath = freshDbPath('z4-comment-before-check');
    await buildFixtureCommentBeforeCheck(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[Z4-PIPELINE-a] fixture 前置：含目标 CHECK（行注释紧贴在逗号之后、CHECK 之前）');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-comment-before-check-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-a] 逗号与目标CHECK之间夹注释的完整迁移应成功, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'executed', '[Z4-PIPELINE-a] 走执行迁移路径');
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, false, '[Z4-PIPELINE-a] CHECK 已移除');
    rmSafe(dbPath);
    ok('[Z4-PIPELINE-a] 逗号与目标 CHECK 之间有行注释的完整迁移用例真正通过（补丁Z·Z4：不再挪夹具绕开，统一词法扫描器正确处理，去注释后等效文本比对生效）');
  }
  {
    const dbPath = freshDbPath('z4-string-edge');
    await buildFixtureStringEdgeCases(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, "[Z4-PIPELINE-b] fixture 前置：含目标 CHECK + 两条含特殊字符串内容（')' 与字面量 CHECK(）的 decoy CHECK");
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-string-edge-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-b] 字符串含 )/CHECK( 字面量场景的完整迁移应成功, got ${JSON.stringify(r)}`);
    const dbCheck = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { get: getCheck, close: closeCheck } = promisifyDb(dbCheck);
    const tableRow = await getCheck(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
    await closeCheck();
    const remainingClauses = _internals.extractAllCheckClauses(_internals.blankOutComments(tableRow.sql), tableRow.sql).map((c) => _internals.normWs(c.text));
    assert.strictEqual(remainingClauses.length, 3, `[Z4-PIPELINE-b] 迁移后应恰剩 3 条 CHECK（type 列枚举 + 两条 decoy，目标已移除）, 实际 ${remainingClauses.length}: ${JSON.stringify(remainingClauses)}`);
    assert.ok(remainingClauses.some((c) => c.includes("title <> ')'")), "[Z4-PIPELINE-b] decoy CHECK (title <> ')') 原样保留（字符串内的 ) 未污染括号平衡，未被误切）");
    assert.ok(remainingClauses.some((c) => c.includes('CHECK(bogus)')), '[Z4-PIPELINE-b] decoy CHECK 内字面量 "CHECK(bogus)" 原样保留（未被误识别成真实子句起点，未被误删/误算进数量对拍）');
    rmSafe(dbPath);
    ok("[Z4-PIPELINE-b] 字符串字面量含 ')' 与含 \"CHECK(\" 文本的两条 decoy CHECK 场景，完整迁移不误切/不误识（只精确移除目标 CHECK，两条 decoy 原样保留）");
  }
  {
    // [Z4-PIPELINE-c][AA3/508-M2] 目标 CHECK 关键字全小写。
    const dbPath = freshDbPath('z4-lowercase-check');
    await buildFixtureLowercaseCheck(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[Z4-PIPELINE-c] fixture 前置：目标 CHECK 关键字全小写（check）');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-lowercase-check-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-c] 全小写 check(...) 的完整迁移应成功, got ${JSON.stringify(r)}`);
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, false, '[Z4-PIPELINE-c] CHECK 已移除');
    const dbC = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { get: getC, close: closeC } = promisifyDb(dbC);
    const rowC = await getC(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
    await closeC();
    const remainingC = _internals.extractAllCheckClauses(_internals.blankOutComments(rowC.sql), rowC.sql);
    assert.strictEqual(remainingC.length, 1, `[Z4-PIPELINE-c] 迁移后应恰剩 1 条 CHECK（列级 type 枚举，也是小写 check 写法，应仍被正确识别且未被误删）, 实际 ${remainingC.length}`);
    rmSafe(dbPath);
    ok('[Z4-PIPELINE-c] 目标 CHECK 关键字全小写（check）：大小写不敏感识别命中目标并正确移除，另一条同样小写的列级 check 未被误删（正确区分目标与非目标，而非"见到 check 就删"）');
  }
  {
    // [Z4-PIPELINE-d][AA3/508-M2] 目标 CHECK 与内部操作符混合大小写（Check/Or/Is Null）。
    const dbPath = freshDbPath('z4-mixedcase-check');
    await buildFixtureMixedCaseCheck(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[Z4-PIPELINE-d] fixture 前置：目标 CHECK 混合大小写（Check...Or...Is Null）');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-mixedcase-check-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-d] 混合大小写的完整迁移应成功, got ${JSON.stringify(r)}`);
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, false, '[Z4-PIPELINE-d] CHECK 已移除');
    rmSafe(dbPath);
    ok('[Z4-PIPELINE-d] 目标 CHECK 与内部操作符混合大小写（Check (type <> \'config\' Or release_id Is Null)）：大小写不敏感 + 规范化比较命中目标并正确移除');
  }
  {
    // [Z4-PIPELINE-e][AA3/508-M2] 目标子句内部夹块注释 + 子句外部（逗号后、子句前）另有一行注释——
    //   验证"内部注释随子句删除"与"外部相邻注释手术后原样保留"两件事同时成立。
    const dbPath = freshDbPath('z4-internal-comment');
    await buildFixtureInternalCommentCheck(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[Z4-PIPELINE-e] fixture 前置：目标 CHECK 内部夹块注释，外部另有一行相邻行注释');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-internal-comment-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-e] 目标子句内部夹注释的完整迁移应成功, got ${JSON.stringify(r)}`);
    const after = await snapshotState(dbPath);
    assert.strictEqual(after.hasCheck, false, '[Z4-PIPELINE-e] CHECK 已移除（连同其内部注释一并移除，内部注释属于被删子句本身）');
    const dbE = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { get: getE, close: closeE } = promisifyDb(dbE);
    const rowE = await getE(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
    await closeE();
    assert.ok(rowE.sql.includes('这行外部注释应在手术后原样保留'),
      `[508-M2「相邻注释保留」][Z4-PIPELINE-e] 手术后 DDL 中外部相邻行注释应原样保留（不是目标子句的一部分，不得随逗号一起被物理删除）——「实现坏成什么样这条会红」：若沿用旧算法把逗号到子句之间整段一并删除，本行会红。手术后 DDL 片段：${rowE.sql}`);
    assert.ok(!rowE.sql.includes('这段内部注释是目标子句的一部分'),
      '[Z4-PIPELINE-e] 目标子句内部的注释应随子句一起被移除（它是被删内容的一部分，不是"相邻"注释）');
    rmSafe(dbPath);
    ok('[Z4-PIPELINE-e] 目标子句内部夹块注释的完整迁移正确移除（内部注释随子句一起删除）；子句外部相邻的行注释在手术后原样保留在 DDL 里（508-M2「相邻注释保留」实证，非仅口头声称）');
  }
  {
    // [Z4-PIPELINE-f][AA3/508-M2] decoy CHECK 字符串内含 "--" 与 ''（转义单引号）。
    const dbPath = freshDbPath('z4-dash-escaped-quote');
    await buildFixtureDashAndEscapedQuote(dbPath);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, "[Z4-PIPELINE-f] fixture 前置：含目标 CHECK + 两条 decoy（字符串含 '--' 与 '' 转义引号）");
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('z4-dash-escaped-quote-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[Z4-PIPELINE-f] 字符串含 --/'' 转义引号场景的完整迁移应成功, got ${JSON.stringify(r)}`);
    const dbF = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const { get: getF, close: closeF } = promisifyDb(dbF);
    const rowF = await getF(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
    await closeF();
    const remainingF = _internals.extractAllCheckClauses(_internals.blankOutComments(rowF.sql), rowF.sql).map((c) => _internals.normWs(c.text));
    assert.strictEqual(remainingF.length, 3, `[Z4-PIPELINE-f] 迁移后应恰剩 3 条 CHECK（type 列枚举 + 两条 decoy，目标已移除）, 实际 ${remainingF.length}: ${JSON.stringify(remainingF)}`);
    assert.ok(remainingF.some((c) => c.includes("a--b")), '[Z4-PIPELINE-f] decoy CHECK (title <> \'a--b\') 原样保留（字符串内的 -- 未被误判为行注释起点导致后续文本被吞）');
    assert.ok(remainingF.some((c) => c.includes("it''s ok")), "[Z4-PIPELINE-f] decoy CHECK (title <> 'it''s ok') 原样保留（'' 转义引号未提前终止字符串状态）");
    rmSafe(dbPath);
    ok("[Z4-PIPELINE-f] 字符串字面量含 '--' 与 '' 转义单引号的两条 decoy CHECK 场景，完整迁移不误切/不误识（只精确移除目标 CHECK，两条 decoy 原样保留）");
  }

  // ═══ [AB1][509-H] 目标 CHECK 匹配不得折叠字符串字面量：大写字面量约束必须保留，不得误删 ═══
  {
    // ① fixture 只有大写字面量版 CHECK (type <> 'CONFIG' OR release_id IS NULL)，无小写目标版——
    //   locateTargetCheck 必须判定"未找到目标"，不得进入 executed（旧版本整句 toLowerCase 会把
    //   'CONFIG' 折成 'config'，误判为目标而删除，见下方变异实验）。
    const dbPath = freshDbPath('ab1-uppercase-literal-only');
    await buildFixtureWithTailClause(dbPath, `,\n    CHECK (type <> 'CONFIG' OR release_id IS NULL)`);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, false, "[AB1-①] fixture 前置：locateTargetCheck 应判定「未找到」（只有大写字面量版，非小写目标）");
    const ddlBefore = await getTableDdl(dbPath);
    assert.ok(/CHECK\s*\(\s*type\s*<>\s*'CONFIG'/.test(ddlBefore), '[AB1-①] fixture 前置：大写字面量约束确实存在于 DDL 中');

    const r1 = await runMigration({ dbPath, apply: true, registerFresh: false, reportPath: freshDbPath('ab1-uppercase-only-report').replace(/\.db$/, '.json') });
    assert.notStrictEqual(r1.mode, 'executed', `[AB1-①] 不得进入 executed 分支（大写字面量约束不是目标）, got mode=${r1.mode}`);
    assert.strictEqual(r1.mode, 'fresh-db-unregistered', `[AB1-①] 按（标记×结构）四格真值表应走「无标记∧不存在」分支（未带 --register-fresh 故不登记）, 实际 mode=${r1.mode}（报告写明实际分支）`);
    assert.strictEqual(r1.committed, false, '[AB1-①] committed=false（未带 --register-fresh，四格真值表新库分支不写库）');
    const ddlAfter = await getTableDdl(dbPath);
    assert.strictEqual(ddlAfter, ddlBefore, '[AB1-①] 大写字面量约束保留：DDL 未发生任何改动（该约束整条保留，未被当作目标误删）');
    rmSafe(dbPath);
    ok(`[AB1-①] 只有大写字面量版 CHECK (type <> 'CONFIG' OR release_id IS NULL) 的 fixture：locateTargetCheck 判定「未找到」，不进入 executed（实际走 mode=${r1.mode}），该约束原样保留在 DDL 中，DDL 逐字节不变`);

    // ② 两条约束同时存在（大写字面量版 decoy + 小写目标版）→ 只删小写目标，大写版保留，CHECK( 计数 −1。
    const dbPath2 = freshDbPath('ab1-both-cases');
    await buildFixtureWithTailClause(dbPath2, `,\n    CHECK (type <> 'CONFIG' OR release_id IS NULL),\n    CHECK (type <> 'config' OR release_id IS NULL)`);
    const before2 = await snapshotState(dbPath2);
    assert.strictEqual(before2.hasCheck, true, '[AB1-②] fixture 前置：locateTargetCheck 应命中小写目标版（大写 decoy 与之并存）');
    const ddlBefore2 = await getTableDdl(dbPath2);
    const checksBefore2 = _internals.extractAllCheckClauses(_internals.blankOutComments(ddlBefore2), ddlBefore2);

    const r2 = await runMigration({ dbPath: dbPath2, apply: true, reportPath: freshDbPath('ab1-both-cases-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r2.ok, true, `[AB1-②] 完整迁移应成功（只删小写目标）, got ${JSON.stringify(r2)}`);
    assert.strictEqual(r2.mode, 'executed', '[AB1-②] 走「执行迁移」路径');
    const ddlAfter2 = await getTableDdl(dbPath2);
    const checksAfter2 = _internals.extractAllCheckClauses(_internals.blankOutComments(ddlAfter2), ddlAfter2);
    assert.strictEqual(checksBefore2.length - checksAfter2.length, 1, `[AB1-②] CHECK( 数量应恰好 −1（只删目标一条）, 前=${checksBefore2.length} 后=${checksAfter2.length}`);
    assert.ok(/CHECK\s*\(\s*type\s*<>\s*'CONFIG'/.test(ddlAfter2), '[AB1-②] 大写字面量版约束在迁移后原样保留（未被误删）');
    const postLocate2 = _internals.locateTargetCheck(ddlAfter2);
    assert.strictEqual(postLocate2.found, false, '[AB1-②] 迁移后用 locateTargetCheck 复核：小写目标已不存在');
    rmSafe(dbPath2);
    ok("[AB1-②] 大写字面量版 + 小写目标版两条约束并存：完整迁移只删小写目标（mode=executed），大写字面量版原样保留，CHECK( 数量精确 −1");
  }
  // 「实现坏成什么样这条会红」——真实变异实验（非纸面推理，见交付报告"变异小结"）：复制迁移脚本，把
  // locateTargetCheck 的 token 序列比较改回"整句 normWs(...).toLowerCase() 字符串比较"（补丁 AA 版本
  // 的实现），对上面 [AB1-①] 的 fixture（只有大写字面量约束）重跑：locateTargetCheck 会误判 found=true，
  // 迁移真的把这条大写字面量约束当成目标删掉、mode 变成 executed——证实这条 509-H 是会导致真实误删的
  // 高危缺陷，不是假设性风险。

  // ═══ [AB2][509-M1] token 序列比较：无空格/多空格/注释紧邻操作符/块注释含引号与 */ 字面 均须命中 ═══
  {
    // 无空格：CHECK(type<>'config' OR release_id IS NULL)
    const dbPath = freshDbPath('ab2-no-space');
    await buildFixtureWithTailClause(dbPath, `,\n    CHECK(type<>'config' OR release_id IS NULL)`);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[AB2-无空格] fixture 前置：无空格写法应被 locateTargetCheck 命中');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('ab2-no-space-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[AB2-无空格] 完整迁移应成功, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'executed', '[AB2-无空格] mode 应为 executed');
    rmSafe(dbPath);
    ok('[AB2-无空格] CHECK(type<>\'config\' OR release_id IS NULL)（关键字与操作符之间无任何空白）：完整迁移 mode=executed 成功命中并移除');
  }
  {
    // 多空格：CHECK  (  type  <>  'config'  OR  release_id  IS  NULL  )
    const dbPath = freshDbPath('ab2-multi-space');
    await buildFixtureWithTailClause(dbPath, `,\n    CHECK  (  type  <>  'config'  OR  release_id  IS  NULL  )`);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[AB2-多空格] fixture 前置：多空格写法应被 locateTargetCheck 命中');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('ab2-multi-space-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[AB2-多空格] 完整迁移应成功, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'executed', '[AB2-多空格] mode 应为 executed');
    rmSafe(dbPath);
    ok('[AB2-多空格] CHECK  (  type  <>  ...  )（关键字/操作符间多余空白）：完整迁移 mode=executed 成功命中并移除');
  }
  {
    // 注释紧邻操作符：type <>/*c*/'config'
    const dbPath = freshDbPath('ab2-comment-adjacent-operator');
    await buildFixtureWithTailClause(dbPath, `,\n    CHECK (type <>/*c*/'config' OR release_id IS NULL)`);
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[AB2-注释紧邻操作符] fixture 前置：注释紧贴在 <> 与字符串之间应仍被命中');
    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('ab2-comment-adjacent-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[AB2-注释紧邻操作符] 完整迁移应成功, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'executed', '[AB2-注释紧邻操作符] mode 应为 executed');
    rmSafe(dbPath);
    ok("[AB2-注释紧邻操作符] CHECK (type <>/*c*/'config' OR release_id IS NULL)（块注释紧贴在操作符与字符串字面量之间、零空白）：完整迁移 mode=executed 成功命中并移除");
  }
  {
    // 块注释内含引号 + 字符串内含字面量 */：验证块注释仍以首个 */ 结束（引号不赋转义语义），
    // 且字符串状态下的 */ 不被误判为注释结束标记。
    const dbPath = freshDbPath('ab2-blockcomment-quote-and-close');
    await buildFixtureWithTailClause(
      dbPath,
      `,\n    /* it's a note inside a block comment */\n    CHECK (type <> 'config' OR release_id IS NULL),\n    CHECK (title <> 'weird */ literal inside a string')`
    );
    const before = await snapshotState(dbPath);
    assert.strictEqual(before.hasCheck, true, '[AB2-块注释] fixture 前置：块注释（含引号）紧邻目标 CHECK 前，另有 decoy 字符串含字面量 */');
    const ddlBefore = await getTableDdl(dbPath);
    const checksBefore = _internals.extractAllCheckClauses(_internals.blankOutComments(ddlBefore), ddlBefore);
    assert.strictEqual(checksBefore.length, 3, `[AB2-块注释] fixture 前置：应有 3 条 CHECK（type 枚举 + 目标 + decoy）, 实际 ${checksBefore.length}`);

    const r = await runMigration({ dbPath, apply: true, reportPath: freshDbPath('ab2-blockcomment-report').replace(/\.db$/, '.json') });
    assert.strictEqual(r.ok, true, `[AB2-块注释] 完整迁移应成功, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.mode, 'executed', '[AB2-块注释] mode 应为 executed');
    const ddlAfter = await getTableDdl(dbPath);
    assert.ok(ddlAfter.includes("it's a note inside a block comment"),
      `[AB2-块注释] 块注释（外部相邻，含引号）手术后原样保留在 DDL 中, 手术后 DDL：${ddlAfter}`);
    const checksAfter = _internals.extractAllCheckClauses(_internals.blankOutComments(ddlAfter), ddlAfter).map((c) => _internals.normWs(c.text));
    assert.strictEqual(checksAfter.length, 2, `[AB2-块注释] 迁移后应恰剩 2 条 CHECK（type 枚举 + decoy，目标已移除）, 实际 ${checksAfter.length}: ${JSON.stringify(checksAfter)}`);
    assert.ok(checksAfter.some((c) => c.includes('weird */ literal inside a string')),
      '[AB2-块注释] decoy CHECK (title <> \'weird */ literal inside a string\') 原样保留（字符串状态下的 */ 未被误判为块注释结束标记，未污染括号/子句边界）');
    rmSafe(dbPath);
    ok("[AB2-块注释] 块注释含引号（紧邻目标 CHECK 之前）+ 字符串含字面量 */（decoy）：块注释仍以首个 */ 正确结束（引号不赋转义语义），字符串内的 */ 不被误判为注释结束——完整迁移正确命中目标、外部注释原样保留、decoy 原样保留");
  }

  // ═══ [Y6-UNIT] trailing-comma / no-comma 分支直接单测（不经 db.run 执行）═══
  //   表级 CHECK 在合法 SQLite 语法下必须跟在 ≥1 个列定义之后（实测：`CREATE TABLE t (CHECK(...), a TEXT)`
  //   直接 SQLITE_ERROR: near "CHECK"），故通过完整六步管道构造这两分支在语法上不可达——改为直接单测
  //   字符串手术算法本身（防御性代码，不映射当前真实 DDL 形态，但工具函数仍需验证正确）。
  {
    const fragTrailing = "CHECK (x > 0), y TEXT, z TEXT)";
    const blankedT = _internals.blankOutComments(fragTrailing);
    const clausesT = _internals.extractAllCheckClauses(blankedT, fragTrailing);
    assert.strictEqual(clausesT.length, 1, '[Y6-UNIT-a] fixture 前置：应恰好定位到 1 条 CHECK 子句');
    const surgeryT = _internals.surgeryRemoveClause(fragTrailing, clausesT[0], blankedT);
    assert.strictEqual(surgeryT.mode, 'trailing-comma', '[Y6-UNIT-a] 无前导逗号（CHECK 是片段首个 token）+ 有后随逗号 → trailing-comma 分支');
    assert.strictEqual(surgeryT.surgeried, ' y TEXT, z TEXT)', `[Y6-UNIT-a] 手术后剩余文本应为「 y TEXT, z TEXT)」，实际「${surgeryT.surgeried}」`);
    ok('[Y6-UNIT-a] trailing-comma 分支直接单测：CHECK 子句无前导逗号+有后随逗号 → 正确识别 trailing-comma 并连带移除后随逗号（不误伤后续内容）');

    const fragNoComma = "CHECK (x > 0)";
    const blankedN = _internals.blankOutComments(fragNoComma);
    const clausesN = _internals.extractAllCheckClauses(blankedN, fragNoComma);
    assert.strictEqual(clausesN.length, 1, '[Y6-UNIT-b] fixture 前置：应恰好定位到 1 条 CHECK 子句');
    const surgeryN = _internals.surgeryRemoveClause(fragNoComma, clausesN[0], blankedN);
    assert.strictEqual(surgeryN.mode, 'no-comma', '[Y6-UNIT-b] 既无前导也无后随逗号（唯一片段内容）→ no-comma 分支');
    assert.strictEqual(surgeryN.surgeried, '', `[Y6-UNIT-b] 手术后应剩空字符串，实际「${surgeryN.surgeried}」`);
    ok('[Y6-UNIT-b] no-comma 分支直接单测：CHECK 子句既无前导也无后随逗号 → 正确识别 no-comma，仅移除子句本身');
  }

  // ═══ [Y7-BLANK] blankOutComments 单引号/注释边界单测 ═══
  {
    const s1 = "col1 TEXT, -- don't delete this column\n  CHECK (col1 > 0),\n  col2 TEXT\n)";
    const blanked1 = _internals.blankOutComments(s1);
    assert.ok(!/don't/.test(blanked1), "[Y7-BLANK-1] 含单引号的行注释应被完整 blank（'don't' 不残留）");
    assert.ok(/CHECK \(col1 > 0\)/.test(blanked1), '[Y7-BLANK-1] 注释后的真实 CHECK 子句应原样保留（未被误吞）');
    const clauses1 = _internals.extractAllCheckClauses(blanked1, s1);
    assert.strictEqual(clauses1.length, 1, '[Y7-BLANK-1] 应恰好识别出 1 条真实 CHECK 子句（注释内文本不产生幻影子句）');

    const s2 = "col1 TEXT, /* don't delete this */\n  CHECK (col1 > 0),\n  col2 TEXT\n)";
    const blanked2 = _internals.blankOutComments(s2);
    assert.ok(!/don't/.test(blanked2), '[Y7-BLANK-2] 含单引号的块注释应被完整 blank');
    const clauses2 = _internals.extractAllCheckClauses(blanked2, s2);
    assert.strictEqual(clauses2.length, 1, '[Y7-BLANK-2] 块注释场景同样恰好识别 1 条真实 CHECK 子句');

    const s3 = "status TEXT DEFAULT '内部', -- it's fine, don't worry, 硬 CHECK(0,1) 这种写法\n  CHECK (status IN ('a','b')),\n  extra TEXT\n)";
    const blanked3 = _internals.blankOutComments(s3);
    const clauses3 = _internals.extractAllCheckClauses(blanked3, s3);
    assert.strictEqual(clauses3.length, 1, '[Y7-BLANK-3] 注释内出现字面量 "CHECK(0,1)"（连同单引号与逗号）不应被误判为真实子句，字符串字面量 \'内部\' 也不被注释逻辑吞掉');
    assert.strictEqual(_internals.normWs(clauses3[0].text), _internals.normWs("CHECK (status IN ('a','b'))"), '[Y7-BLANK-3] 唯一识别出的真实子句内容应精确等于 status 枚举 CHECK（非注释里的幻影文本）');

    ok('[Y7-BLANK] blankOutComments 单引号/注释边界：三组含单引号的行注释/块注释/字符串+注释+幻影CHECK(0,1)文本 场景均正确处理');
  }

  // ═══ [MIGRATED-LIVE] 迁移已应用到既有库后，config 上线单流转真实端到端可用（补丁 AG） ═══
  //   与既有 [U1]-[U8]（verify-sys-config-flow.js，全新内存库，新表从建表起就没有目标 CHECK）互补——
  //   [U1]-[U8] 从未验证过「一个真实带旧 DDL、已有历史数据的库，跑完本迁移脚本之后」这条路径；
  //   真实 dev 库（有旧 DDL、未迁移）上 config 单确实挂不上批次，说明这条路径此前无人守。
  //   全程走真实 HTTP 业务层（add-issues/execute），不直接判 DDL 字符串——DDL 层面的正确性已由
  //   [FORM]/[AB1]/[AB2] 等既有组充分覆盖，本组只补"迁移完成后业务层真的能用"这一层。
  //
  //   fixture 构造思路（不复用 buildFixture——那是为纯 DDL 手术测试设计的**最小**代表性 DDL，缺
  //   assigned_to 等大量业务列，initSchema() 的 alterAddMissingCols 只补"S1a 之后新增"的列，不负责
  //   补一整套历史列，直接拿它跑真实业务端点会在建索引阶段就 500）：先用一个全新空库跑一遍真实
  //   initSchema()，拿到**当前**（S1b 已生效、无目标 CHECK）的完整真实 sys_issues DDL 原文，再对这段
  //   真实 DDL 做一次逆向注入——补回目标 CHECK 子句——精确还原"S1a 已上线、S1b 还没跑"这个历史断面
  //   （S1a 早于 S1b 半天上线，exec_mode/vendor_name 等列历史上确实已经存在，唯独 CHECK 还没删，这正是
  //   当前真实 dev 库的写照）。零手工 DDL 复刻，无漂移风险。
  {
    const dbPath = freshDbPath('migrated-live');

    // 步骤 0：全新空库走一遍真实 initSchema()，拿到当前完整 DDL + 顺手种 3 张历史单（bug/feature/
    //   improvement 各一，仅需存在，无需推进状态）+ 1 张 config 历史单（真实业务流程推进到「待上线」，
    //   此刻 release_id 天然为 NULL——因为 add-issues 这一步还没人跑过，不是靠 CHECK 拦住的）。
    const app0 = await agMakeApp(dbPath);
    const ADMIN0 = agSignToken(1, '管理员', 'admin');
    const DEV0 = agSignToken(5, '开发王', 'user');
    const bugSeed = await app0.call('POST', '/sys-issues', ADMIN0, {
      intake_contract_version: 2, type: 'bug', title: 'ag-hist-bug', system_name: 'BMS', source: '内部',
      description: 'AG 历史夹具：bug', intake_liaison_id: 13,
    });
    assert.strictEqual(bugSeed.status, 201, `[MIGRATED-LIVE] 历史夹具：bug 建单应 201, got ${bugSeed.status} ${JSON.stringify(bugSeed.body)}`);
    const featureSeed = await app0.call('POST', '/sys-issues', ADMIN0, {
      intake_contract_version: 2, type: 'feature', title: 'ag-hist-feature', system_name: 'BMS', source: '内部',
      description: 'AG 历史夹具：feature', intake_liaison_id: 13,
    });
    assert.strictEqual(featureSeed.status, 201, `[MIGRATED-LIVE] 历史夹具：feature 建单应 201, got ${featureSeed.status} ${JSON.stringify(featureSeed.body)}`);
    const impSeed = await app0.call('POST', '/sys-issues', ADMIN0, {
      intake_contract_version: 2, type: 'improvement', title: 'ag-hist-improvement', system_name: 'BMS', source: '内部',
      description: 'AG 历史夹具：improvement', intake_liaison_id: 13,
    });
    assert.strictEqual(impSeed.status, 201, `[MIGRATED-LIVE] 历史夹具：improvement 建单应 201, got ${impSeed.status} ${JSON.stringify(impSeed.body)}`);
    const cfgSeed = await app0.call('POST', '/sys-issues', ADMIN0, {
      intake_contract_version: 2, type: 'config', title: 'ag-hist-config', system_name: 'BMS', source: '内部',
      description: 'AG 历史夹具：config（S1a 已上线、S1b 还没跑时代的真实产物）', intake_liaison_id: 13,
    });
    assert.strictEqual(cfgSeed.status, 201, `[MIGRATED-LIVE] 历史夹具：config 建单应 201, got ${cfgSeed.status} ${JSON.stringify(cfgSeed.body)}`);
    const cfgId = cfgSeed.body.id;
    await app0.call('POST', `/sys-issues/${cfgId}/intake-accept`, ADMIN0, { risk_level: '二级' });
    await app0.call('POST', `/sys-issues/${cfgId}/assign`, ADMIN0, { assigned_to: 5, exec_mode: 'self' });
    await app0.call('POST', `/sys-issues/${cfgId}/estimate`, DEV0, { dev_estimated_at: (() => { const d = new Date(Date.now() + 20 * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })() });
    const cfgSubmit = await app0.call('POST', `/sys-issues/${cfgId}/submit`, DEV0, { mode: 'no_code', no_code_reason: 'AG 历史夹具：配置已在测试环境验证完成', self_tested: true, test_env_deployed: true });
    assert.strictEqual(cfgSubmit.status, 200, `[MIGRATED-LIVE] 历史夹具：config no_code 提交应 200, got ${cfgSubmit.status} ${JSON.stringify(cfgSubmit.body)}`);
    const cfgAcceptSeed = await app0.call('POST', `/sys-issues/${cfgId}/accept`, ADMIN0, { online_mode: 'release' });
    assert.strictEqual(cfgAcceptSeed.status, 200, `[MIGRATED-LIVE] 历史夹具：config 验收应 200, got ${cfgAcceptSeed.status} ${JSON.stringify(cfgAcceptSeed.body)}`);
    assert.strictEqual(cfgAcceptSeed.body.status, '待上线', '[MIGRATED-LIVE] 历史夹具：config 验收后落待上线（release_id 此刻天然 NULL，尚未跑 add-issues）');

    const ddlRow0 = await app0.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
    const objRows0 = await app0.all(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name='sys_issues' AND type IN ('index','trigger')`);
    assert.ok(ddlRow0 && ddlRow0.sql, '[MIGRATED-LIVE] 步骤0：拿到当前真实 sys_issues DDL 原文（initSchema 真实产物，非手工复刻）');
    assert.ok(!_internals.locateTargetCheck(ddlRow0.sql).found, '[MIGRATED-LIVE] 步骤0：当前真实 DDL 本就不含目标 CHECK（S1b 已从源码里删掉，符合预期，验证下面注入的是「补回去」而非巧合已存在）');
    await app0.close();

    // 步骤 0b：逆向注入——把目标 CHECK 补回到刚拿到的真实 DDL 末尾，重建表（此刻表内已有 4 行历史
    //   数据，INSERT ... SELECT * 原样搬运，验证"表重建对已有数据无损"这条既有 [FORM] 组同款不变量
    //   在真实业务数据形状上同样成立）。
    //   [实测踩坑修复] 首版用 `CREATE sys_issues__preS1b → RENAME TO sys_issues` 的两步式重建——
    //   SQLite 的 ALTER TABLE RENAME 会把结果 DDL 重写成带双引号的 `CREATE TABLE "sys_issues" (`，
    //   导致下方 runMigration 内部 `renameCreateTableHeader` 的正则 `^CREATE TABLE(?:\s+IF NOT
    //   EXISTS)?\s+sys_issues\s*\(`（无引号处理）匹配失败，阻断退出。这纯粹是本组夹具构造手法的
    //   副作用——真实生产表从创建起就叫 sys_issues、从未被 rename 过，DDL 原文本就不带引号；改为
    //   "先把旧表挪开名字→用目标名字 sys_issues 直接 CREATE 新表"，新表的 DDL 由我们自己的字面量
    //   决定（SQLite 原样存储 CREATE 语句文本，不重写），天然不带引号，与真实生产表同构。
    {
      const rawDb = new sqlite3.Database(dbPath);
      const { run: rawRun } = agPromisifyDb(rawDb);
      await rawRun(`PRAGMA foreign_keys=OFF`);
      const trimmed = ddlRow0.sql.replace(/\s+$/, '');
      assert.ok(trimmed.endsWith(')'), `[MIGRATED-LIVE] 步骤0b：真实 DDL 应以 ) 收尾才能安全注入，实得末尾="${trimmed.slice(-30)}"`);
      const injectedDdl = trimmed.slice(0, -1) + `,\n  CHECK (type <> 'config' OR release_id IS NULL)\n)`;
      assert.ok(/^CREATE TABLE\s+sys_issues\s*\(/.test(injectedDdl), '[MIGRATED-LIVE] 步骤0b：注入后 DDL 仍以未加引号的 "CREATE TABLE sys_issues (" 开头（真实 DDL 原文本无引号，直接沿用）');
      await rawRun(`ALTER TABLE sys_issues RENAME TO sys_issues__old`);   // 旧表挪开名字（其 DDL 是否带引号无所谓，即将被丢弃）
      await rawRun(injectedDdl);                                          // 新表直接以目标名 sys_issues 创建，DDL 原样落盘不被重写
      await rawRun(`INSERT INTO sys_issues SELECT * FROM sys_issues__old`);
      await rawRun(`DROP TABLE sys_issues__old`);
      for (const obj of objRows0) { if (obj.sql) await rawRun(obj.sql); }
      await new Promise((r) => rawDb.close(r));
    }
    const preS1bDdlRow = await (async () => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      const { get, close } = promisifyDb(db);
      const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
      await close();
      return row;
    })();
    assert.ok(_internals.locateTargetCheck(preS1bDdlRow.sql).found, '[MIGRATED-LIVE] 步骤0b：注入后目标 CHECK 确实已补回真实 DDL（证明这是「未迁移的旧库」快照，非假绿）');

    // ── 步骤0c（补丁AI·AI8 根治·codex 514-M8）：手工注入 AUTOINCREMENT 高水位 ──
    //   步骤0b 的表重建（RENAME→CREATE→INSERT SELECT）天然让 sqlite_sequence.seq 归于 max(id)
    //   （AUTOINCREMENT 记录的是"迄今插入过的最大 rowid"，INSERT SELECT 带显式 id 同样会把 seq 追到
    //   该值），复现不出真实历史断面——主会话已只读实测真实 dev 库：
    //   sqlite_sequence(sys_issues).seq=15132 > max(id)=15064（高水位比 max(id) 高 68，即历史上曾有
    //   更大 id 的行后来被删除，AUTOINCREMENT 不回退）。手工把 seq 抬到 max(id)+100 来复现这条真实
    //   形态，供下方步骤4断言"迁移后序列守恒"（不会被表重建悄悄回退到 max(id)）、步骤5断言"迁移后
    //   新建单 id 超过这个高水位"（AUTOINCREMENT 语义本身要求新 id 单调递增，回退=严重回归，会造成
    //   id 复用）。
    const preInjectSeq = await new Promise((resolve, reject) => {
      const injDb = new sqlite3.Database(dbPath);
      injDb.get(`SELECT MAX(id) AS maxId FROM sys_issues`, (e, row) => {
        if (e) { injDb.close(); return reject(e); }
        const target = (row.maxId || 0) + 100;
        injDb.run(`UPDATE sqlite_sequence SET seq=? WHERE name='sys_issues'`, [target], function (e2) {
          injDb.close();
          if (e2) return reject(e2);
          if (this.changes !== 1) return reject(new Error(`[MIGRATED-LIVE] 步骤0c：sqlite_sequence 未命中 sys_issues 行（changes=${this.changes}），高水位注入失败`));
          resolve(target);
        });
      });
    });
    const preInjectSnap = await snapshotState(dbPath);
    assert.strictEqual(preInjectSnap.seq, preInjectSeq, `[MIGRATED-LIVE] 步骤0c：高水位注入生效（目标 seq=${preInjectSeq}），实得=${preInjectSnap.seq}`);
    ok(`[MIGRATED-LIVE] 步骤0c：手工注入 AUTOINCREMENT 高水位 seq=${preInjectSeq}（=max(id)+100，复现真实 dev 库"曾有更大 id 行后被删"的历史断面，非表重建天然产出的 seq==max(id)）`);

    // ── 步骤 3：迁移前，真实 add-issues 端点必须撞 CHECK（证明夹具确是旧库，非本组新机制的自证）──
    const app1 = await agMakeApp(dbPath);
    const ADMIN1 = agSignToken(1, '管理员', 'admin');
    const relPre = await app1.call('POST', '/sys-releases', ADMIN1, {});
    assert.strictEqual(relPre.status, 201, `[MIGRATED-LIVE] 迁移前夹具：建批次应 201, got ${relPre.status} ${JSON.stringify(relPre.body)}`);
    // [S1e·补丁 AM·codex 520-L1 根治] 原先只断了 sys_issues 的 release_id/status 两个字段没变，
    //   codex 519 曾要求「断言失败请求后批次关联、执行人及时间线均无部分写入」，主会话上一轮以
    //   「要另搭夹具」为由转了 backlog——**该理由经亲核不成立**：本组 MIGRATED-LIVE 夹具（新代码 +
    //   未迁移旧库 + 真实 add-issues 端点）正是所需组合，就在此处，无需新搭。且它要的是**请求级
    //   事务边界**（执行人行 / 时间线行有没有部分写入），不是单条 UPDATE 的原子性。故在此就地补齐：
    //   调用前后各取一次快照逐项对比，把「零副作用」从两个字段扩到批次关联 + 执行人 + 时间线三面。
    const preSnap = {
      execRows: (await app1.get('SELECT COUNT(*) c FROM sys_release_executors WHERE release_id=?', [relPre.body.id])).c,
      tlRows: (await app1.get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [cfgId])).c,
      memberRows: (await app1.get('SELECT COUNT(*) c FROM sys_issues WHERE release_id=?', [relPre.body.id])).c,
    };
    const addPre = await app1.call('POST', `/sys-releases/${relPre.body.id}/add-issues`, ADMIN1, { issue_ids: [cfgId] });
    assert.strictEqual(addPre.status, 500, `[MIGRATED-LIVE] 迁移前：真实 add-issues 端点应因表级 CHECK 撞 500（未迁移旧库结构性拦截）, got ${addPre.status} ${JSON.stringify(addPre.body)}`);
    assert.ok(/CHECK constraint failed/.test((addPre.body && addPre.body.error) || ''), `[MIGRATED-LIVE] 迁移前 500 错误文本应含 "CHECK constraint failed"（实得="${addPre.body && addPre.body.error}"）——证明这条路径确实撞的是目标 CHECK，非其它无关 500`);
    const cfgRowAfterFail = await app1.get(`SELECT release_id, status FROM sys_issues WHERE id=?`, [cfgId]);
    assert.strictEqual(cfgRowAfterFail.release_id, null, '[MIGRATED-LIVE] 迁移前撞约束后 release_id 仍 NULL（事务回滚，零副作用）');
    assert.strictEqual(cfgRowAfterFail.status, '待上线', '[MIGRATED-LIVE] 迁移前撞约束后 status 仍待上线（未被误改）');
    // [S1e·补丁 AM·codex 520-L1] 请求级事务边界：失败请求不得在任何关联表留下部分写入。
    const postSnap = {
      execRows: (await app1.get('SELECT COUNT(*) c FROM sys_release_executors WHERE release_id=?', [relPre.body.id])).c,
      tlRows: (await app1.get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [cfgId])).c,
      memberRows: (await app1.get('SELECT COUNT(*) c FROM sys_issues WHERE release_id=?', [relPre.body.id])).c,
    };
    // [补丁 AO·codex 521 问项3 订正] 原措辞写「请求级零副作用」**过强**：计数相等只能发现**净增减**，
    //   发现不了「行内容被原地更新」或「等量替换（删一行加一行）」。按实作收窄为可断言的那句。
    assert.deepStrictEqual(postSnap, preSnap,
      `[MIGRATED-LIVE] 迁移前撞约束后：批次成员数 / 在册执行人行数 / 该单时间线行数**三个计数**均与调用前逐项相同（前=${JSON.stringify(preSnap)} 后=${JSON.stringify(postSnap)}）。⚠️ 断言对象＝三张表的**行数**，与上方 release_id/status 两个主表字段合起来，证到的是「两主表字段不变 ∧ 三个计数不变」——**不等于无范围限定的「请求级零副作用」**：行内容原地更新、等量替换（删一行加一行）这两类本条发现不了`);
    await app1.close();
    // [补丁 AP·codex 522] 本行原写「三面请求级零副作用」——与上方已收窄的断言消息直接矛盾（同一处
    //   留了新旧两个契约）。按实际证到的东西写：两个主表字段 + 三个计数。
    ok('[MIGRATED-LIVE] 步骤3：迁移前真实 add-issues 端点撞表级 CHECK → 500 + 错误文本含 "CHECK constraint failed" + release_id/status 两字段不变 + **批次成员、执行人、时间线三个计数不变**（证明夹具确是「未迁移的旧库」，非本组自证假绿）');

    // ── 「坏法」验证（补丁 AG 追加）：证明 runMigration 自身安全网在**本组「真实历史数据 + 完整
    //   现代 DDL」**这个更贴近真实场景的夹具上同样成立——不只是套用既有 [MUT-1]/[MUT-4] 组在
    //   *最小* buildFixture 上的结论，而是在这个 dbPath 的一份副本上直接用 __testHooks 复现同款变异。
    //   两条副本均取自"步骤3之后、步骤4真正迁移之前"这个时点（数据仍是纯 pre-S1b 快照，未被真实
    //   迁移动过）。
    const mutDbPath1 = freshDbPath('migrated-live-mut1');
    fs.copyFileSync(dbPath, mutDbPath1);
    const mut1Report = freshDbPath('migrated-live-mut1-report').replace(/\.db$/, '.json');
    const mut1Result = await runMigration({
      dbPath: mutDbPath1, apply: true, reportPath: mut1Report,
      hooks: { chooseNewTableDdl: (ctx) => _internals.renameCreateTableHeader(ctx.originalDdl, 'sys_issues__new') },
    });
    assert.strictEqual(mut1Result.ok, false, `[MIGRATED-LIVE-坏法①] 「漏删 CHECK」变异（__testHooks.chooseNewTableDdl 保留原 DDL 不做手术）应 ok=false, got ${JSON.stringify(mut1Result)}`);
    assert.strictEqual(mut1Result.committed, false, '[MIGRATED-LIVE-坏法①] 「漏删 CHECK」变异不得提交（committed=false）');
    rmSafe(mutDbPath1); rmSafe(mut1Report);
    ok('[MIGRATED-LIVE-坏法①] 用 __testHooks.chooseNewTableDdl 在本组真实历史数据+完整现代 DDL 夹具的副本上注入「漏删 CHECK」变异——runMigration 自身安全网判红（ok=false/committed=false，非仅套用既有 [MUT-1] 最小 fixture 的结论）；这层安全网若被绕开导致误提交，步骤5的 add-issues 会撞与步骤3完全相同的 500 CHECK constraint failed（同一代码路径、同一异常来源，业务层判红证据即步骤3本身，非本组另需新增判据）');

    const mutDbPath2 = freshDbPath('migrated-live-mut2');
    fs.copyFileSync(dbPath, mutDbPath2);
    const mut2Report = freshDbPath('migrated-live-mut2-report').replace(/\.db$/, '.json');
    const mut2Result = await runMigration({
      dbPath: mutDbPath2, apply: true, reportPath: mut2Report,
      hooks: { chooseRebuildStatements: (ctx) => ctx.statements.filter((s) => s.type !== 'trigger' || !/_ins$/.test(s.name)) },
    });
    assert.strictEqual(mut2Result.ok, false, `[MIGRATED-LIVE-坏法②] 「漏建受理门触发器」变异应 ok=false, got ${JSON.stringify(mut2Result)}`);
    assert.strictEqual(mut2Result.committed, false, '[MIGRATED-LIVE-坏法②] 「漏建触发器」变异不得提交（committed=false）');
    rmSafe(mutDbPath2); rmSafe(mut2Report);
    ok('[MIGRATED-LIVE-坏法②] 用 __testHooks.chooseRebuildStatements 在本组同款夹具副本上注入「漏建受理门触发器」变异——runMigration 自身安全网同样判红（不因夹具从"最小 DDL"换成"真实完整 DDL+历史数据"而失效）。诚实说明（如实报告，非回避）：与坏法①不同，add-issues/execute 两个端点**不依赖**索引（只影响性能非正确性）、也**从不主动**写 intake_required=0（不会触发这条触发器），故索引/触发器缺失若真的溜过 runMigration 自身安全网被提交，其后果在业务层不会体现为"某个端点报错"，而是"受理门这道不变量少了一层纵深防线，要等到有人真的从别处写入 intake_required=0 时才会暴露"——这正是为什么本项目把这条判据钉在 runMigration 自身的结构指纹比对里、不依赖业务端点偶然踩中的道理，也是本组没有像坏法①那样能指向"步骤5会红"的原因（如实报告，未强行编造一个不成立的业务层红判据）');

    // ── 步骤 4：对该沙箱库跑迁移（apply=true，非 task_pool.db，不触发 DEV_DB_BASENAME 双旗标闸）──
    const migReportPath = freshDbPath('migrated-live-report').replace(/\.db$/, '.json');
    const migResult = await runMigration({ dbPath, apply: true, reportPath: migReportPath });
    assert.strictEqual(migResult.ok, true, `[MIGRATED-LIVE] 迁移 apply 应 ok=true, got ${JSON.stringify(migResult)}`);
    assert.strictEqual(migResult.committed, true, '[MIGRATED-LIVE] 迁移 apply 应 committed=true');
    const afterMigSnap = await snapshotState(dbPath);
    assert.strictEqual(afterMigSnap.hasCheck, false, '[MIGRATED-LIVE] 迁移后目标 CHECK 已消失');
    assert.ok(afterMigSnap.markRow, '[MIGRATED-LIVE] 迁移后标记已登记');
    assert.strictEqual(afterMigSnap.rowCount, 4, '[MIGRATED-LIVE] 迁移后行数仍为 4（bug/feature/improvement/config 四张历史单，表重建对真实业务数据同样无损）');
    // [S1d·补丁AI·AI8 根治·codex 514-M8] 断序列守恒——迁移前步骤0c 已手工注入高水位 seq=preInjectSeq
    // （> max(id)），若迁移内部的表重建把 seq 回退到 max(id)，会造成"回退后新建单沿用了历史上已经
    // 存在过、后来被删的 id"这一严重回归（AUTOINCREMENT 语义本身要求单调递增）。
    assert.strictEqual(afterMigSnap.seq, preInjectSeq, `[MIGRATED-LIVE] 步骤4：迁移后 AUTOINCREMENT 高水位守恒（未被表重建回退到 max(id)），实得 seq=${afterMigSnap.seq}，注入值=${preInjectSeq}`);
    ok(`[MIGRATED-LIVE] 步骤4：runMigration({apply:true}) 对沙箱库执行成功，CHECK 消失 + 迁移标记已登记 + 4 张历史单行数不变（结构指纹见既有 [FORM]/[Z3] 组，此处不重复断言）+ AUTOINCREMENT 高水位守恒（seq=${afterMigSnap.seq} 未被回退到 max(id)）`);

    // ── 步骤 5：迁移后，同一个库上真实端到端流转——config 单加入批次 → execute → 落已上线 ──
    //   起第二个 app 实例（独立 db 连接，模拟"停服迁移→重启服务"这一真实生产流程的两端）。
    const app2 = await agMakeApp(dbPath);
    const ADMIN2 = agSignToken(1, '管理员', 'admin');
    const DEV2 = agSignToken(5, '开发王', 'user');
    const relPost = await app2.call('POST', '/sys-releases', ADMIN2, { release_note: '[MIGRATED-LIVE] 迁移后 config 批次', version_tag: 'ag-migrated-live' });
    assert.strictEqual(relPost.status, 201, `[MIGRATED-LIVE] 迁移后：建批次应 201, got ${relPost.status} ${JSON.stringify(relPost.body)}`);
    const addPost = await app2.call('POST', `/sys-releases/${relPost.body.id}/add-issues`, ADMIN2, { issue_ids: [cfgId] });
    assert.strictEqual(addPost.status, 200, `[MIGRATED-LIVE] 迁移后：真实 add-issues 端点应 200（CHECK 已移除）, got ${addPost.status} ${JSON.stringify(addPost.body)}`);
    const cfgRowAfterAdd = await app2.get(`SELECT release_id FROM sys_issues WHERE id=?`, [cfgId]);
    assert.strictEqual(cfgRowAfterAdd.release_id, relPost.body.id, '[MIGRATED-LIVE] 迁移后 config 单 release_id = 目标批次 id');
    const relDetailPost = await app2.call('GET', `/sys-releases/${relPost.body.id}`, ADMIN2);
    assert.strictEqual(relDetailPost.status, 200, '[MIGRATED-LIVE] 批次详情端点 200');
    assert.ok(Array.isArray(relDetailPost.body.issues) && relDetailPost.body.issues.some((it) => it.id === cfgId), `[MIGRATED-LIVE] 批次详情返回的成员含该 config 单, got ${JSON.stringify(relDetailPost.body.issues && relDetailPost.body.issues.map((it) => it.id))}`);
    // execute：单执行人（DEV_ID=5）确认即触发发布（同 verify-sys-config-flow.js [U1] 单执行人范式）。
    await app2.call('PUT', `/sys-releases/${relPost.body.id}/executors`, ADMIN2, { user_ids: [5] });
    await app2.run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [relPost.body.id]);
    const execRow = await app2.get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`, [relPost.body.id]);
    assert.ok(execRow, '[MIGRATED-LIVE] 执行人子表行已就绪');
    const execResp = await app2.call('POST', `/sys-releases/${relPost.body.id}/execute`, DEV2, { executor_row_id: execRow.id, release_note: '[MIGRATED-LIVE]', version_tag: 'ag-migrated-live' });
    assert.strictEqual(execResp.status, 200, `[MIGRATED-LIVE] execute 应 200, got ${execResp.status} ${JSON.stringify(execResp.body)}`);
    assert.strictEqual(execResp.body.released, true, '[MIGRATED-LIVE] execute released=true（单执行人批次全 done）');
    // [S1d·补丁AI·AI8 根治] online_source 一并读出——config 经批次发布上线（非 direct/no_commit 路径），
    // 该列不应被写入，供下方步骤6与 improvement 对照单同源比较（"读取实际 online_source 与同库
    // improvement 对照比较"，不是凭代码推导"应该是 NULL"）。
    const cfgRowFinal = await app2.get(`SELECT status, released_at, online_source FROM sys_issues WHERE id=?`, [cfgId]);
    assert.strictEqual(cfgRowFinal.status, '已上线', `[MIGRATED-LIVE] config 单最终落「已上线」, got ${JSON.stringify(cfgRowFinal)}`);
    assert.ok(cfgRowFinal.released_at, '[MIGRATED-LIVE] released_at 非空');
    ok(`[MIGRATED-LIVE] 步骤5：迁移后同一库上真实 add-issues 200 + release_id=批次 id + 批次详情含该单 + execute 200/released=true + config 单最终落已上线（released_at 非空，online_source=${JSON.stringify(cfgRowFinal.online_source)}）——「既有库经迁移」路径与 [U1]-[U8]「新建库」路径互补，均已覆盖`);

    // ── 步骤 6：回归对照——improvement 全新走同一路径正常；bug/feature/improvement 三张历史行未受影响 ──
    const impCreate = await app2.call('POST', '/sys-issues', ADMIN2, {
      intake_contract_version: 2, type: 'improvement', title: 'ag-migrated-live-improvement对照', system_name: 'BMS', source: '内部',
      description: 'AG 回归对照：迁移后 improvement 全新流转', intake_liaison_id: 13,
    });
    assert.strictEqual(impCreate.status, 201, `[MIGRATED-LIVE] improvement 对照建单应 201, got ${impCreate.status} ${JSON.stringify(impCreate.body)}`);
    const impId = impCreate.body.id;
    // [S1d·补丁AI·AI8 根治·codex 514-M8] 断新建单 id 超过步骤0c 注入的高水位（AUTOINCREMENT 语义
    // 要求单调递增；若迁移把序列回退到 max(id)，这张全新单的 id 会落在"历史上已经存在过、后来被删"
    // 的 id 区间内，造成 id 复用这一严重回归）。
    assert.ok(impId > preInjectSeq, `[MIGRATED-LIVE] 步骤5后新建单 id 示例开发N过步骤0c 注入的高水位（实得 impId=${impId}，高水位=${preInjectSeq}）——证明迁移未回退 AUTOINCREMENT 序列`);
    await app2.call('POST', `/sys-issues/${impId}/intake-accept`, ADMIN2, { risk_level: '二级' });
    await app2.call('POST', `/sys-issues/${impId}/set-oa-number`, ADMIN2, { oa_number: '20260908901' });
    await app2.call('POST', `/sys-issues/${impId}/assign`, ADMIN2, { assigned_to: 5 });
    await app2.call('POST', `/sys-issues/${impId}/estimate`, DEV2, { dev_estimated_at: (() => { const d = new Date(Date.now() + 20 * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; })(), estimated_effort_days: 1 });
    const impSubmit = await app2.call('POST', `/sys-issues/${impId}/submit`, DEV2, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'ag-migrated-live-imp' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(impSubmit.status, 200, `[MIGRATED-LIVE] improvement 对照提交应 200, got ${impSubmit.status} ${JSON.stringify(impSubmit.body)}`);
    assert.strictEqual(impSubmit.body.main_status, '待验证', '[MIGRATED-LIVE] improvement 对照提交后落待验证');
    const impAccept = await app2.call('POST', `/sys-issues/${impId}/accept`, ADMIN2, {});
    assert.strictEqual(impAccept.status, 200, `[MIGRATED-LIVE] improvement 对照验收应 200, got ${impAccept.status} ${JSON.stringify(impAccept.body)}`);
    assert.strictEqual(impAccept.body.status, '待上线', '[MIGRATED-LIVE] improvement 对照验收后落待上线');
    const relImp = await app2.call('POST', '/sys-releases', ADMIN2, { release_note: '[MIGRATED-LIVE] improvement 对照批次', version_tag: 'ag-migrated-live-imp' });
    await app2.call('POST', `/sys-releases/${relImp.body.id}/add-issues`, ADMIN2, { issue_ids: [impId] });
    await app2.call('PUT', `/sys-releases/${relImp.body.id}/executors`, ADMIN2, { user_ids: [5] });
    await app2.run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND user_id=5`, [relImp.body.id]);
    const execRowImp = await app2.get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`, [relImp.body.id]);
    const execImp = await app2.call('POST', `/sys-releases/${relImp.body.id}/execute`, DEV2, { executor_row_id: execRowImp.id });
    assert.strictEqual(execImp.status, 200, `[MIGRATED-LIVE] improvement 对照 execute 应 200, got ${execImp.status} ${JSON.stringify(execImp.body)}`);
    const impRowFinal = await app2.get(`SELECT status, online_source FROM sys_issues WHERE id=?`, [impId]);
    assert.strictEqual(impRowFinal.status, '已上线', '[MIGRATED-LIVE] improvement 对照单最终落已上线（迁移后 improvement 流转不受影响）');
    // [S1d·补丁AI·AI8 根治·codex 514-M8，补丁AJ·AJ7 收紧·codex 515 recommendations] online_source
    // 同库对照——config 与 improvement 均经同一条批次发布路径上线，实际读出的 online_source 应逐字
    // 相同（同为 NULL：该路径不写入该列）。⚠️ 两者用的是 relPost 与 relImp **两个不同批次**（满足
    // "同库对照"但非"同批次对照"）——仅断"两者相等"不足以排除"两者同时错成同一个非预期值也会绿"
    // 这一漏洞，改为**分别显式断言两者都等于预期值 NULL**，再断二者相等（三条断言合取，而非只有
    // 最后一条）。
    assert.strictEqual(cfgRowFinal.online_source, null, `[MIGRATED-LIVE] config 单 online_source 应为 NULL（批次发布路径不写入该列），实得=${JSON.stringify(cfgRowFinal.online_source)}`);
    assert.strictEqual(impRowFinal.online_source, null, `[MIGRATED-LIVE] improvement 对照单 online_source 应为 NULL（批次发布路径不写入该列），实得=${JSON.stringify(impRowFinal.online_source)}`);
    assert.strictEqual(impRowFinal.online_source, cfgRowFinal.online_source, `[MIGRATED-LIVE] config 单 online_source（${JSON.stringify(cfgRowFinal.online_source)}）与同库 improvement 对照单 online_source（${JSON.stringify(impRowFinal.online_source)}）应逐字相同（均经批次发布路径上线，同源比较非代码推导；上两条已各自钉住预期值 NULL，本条不是唯一判据）`);

    // bug/feature/improvement 三张历史行（步骤0种的 ag-hist-*）未受影响——真实详情端点仍可正确读回。
    for (const [histTitle, histType] of [['ag-hist-bug', 'bug'], ['ag-hist-feature', 'feature'], ['ag-hist-improvement', 'improvement']]) {
      const histRow = await app2.get(`SELECT id FROM sys_issues WHERE title=?`, [histTitle]);
      assert.ok(histRow, `[MIGRATED-LIVE] 历史行 ${histTitle} 迁移后仍可查得（表重建未丢数据）`);
      const histDetail = await app2.call('GET', `/sys-issues/${histRow.id}`, ADMIN2);
      assert.strictEqual(histDetail.status, 200, `[MIGRATED-LIVE] 历史行 ${histTitle} 详情端点应 200, got ${histDetail.status} ${JSON.stringify(histDetail.body)}`);
      assert.strictEqual(histDetail.body.issue.type, histType, `[MIGRATED-LIVE] 历史行 ${histTitle} 详情 type 字段仍为 ${histType}（真实读路径验证表重建未污染既有行）`);
      assert.strictEqual(histDetail.body.issue.title, histTitle, `[MIGRATED-LIVE] 历史行 ${histTitle} 详情 title 字段一致`);
    }

    await app2.close();
    ok(`[MIGRATED-LIVE] 步骤6：回归对照——迁移后全新 improvement 单走「建单→受理→OA→指派→估时→提交→验收→挂批次→execute」完整路径落已上线（不受本次迁移影响，新建单 id=${impId} 超过步骤0c 注入的高水位=${preInjectSeq}）+ online_source：config 单与 improvement 对照单（不同批次，同库）各自独立断言等于预期值 NULL，再断二者相同（三条断言合取，补丁AJ·AJ7 收紧——不再只断"两者相等"这一条，堵住"两者同时错成同一非预期值"的漏洞）；bug/feature/improvement 三张历史行经真实详情端点读回 type/title 逐字段一致（表重建未污染既有数据）`);

    rmSafe(dbPath);
    rmSafe(migReportPath);
  }

  console.log(`\n✅ verify-sys-migrate-config-release-check 全部通过（${passed} 组·S1b sys_issues 受控重建迁移脚本·补丁Y/Z已并入·补丁AG新增[MIGRATED-LIVE]）`);
}

main().catch((e) => { console.error('❌ 验证失败:', (e && e.stack) || e); process.exit(1); });
