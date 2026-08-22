// 验证脚本：历史台账归档模块 三表 schema（A2 交付④）
//   方案：docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §3/§4/§6
//   编码范式备忘：docs/local/历史台账归档/A2-A4_编码范式备忘_20260820.md
//
// 用法：node scripts/verify-legacy-archive-schema.js
//   （PART 2 依赖 tmp/legacy-archive-manifest.json + tmp/legacy-archive-payload/ 已存在——
//    先跑 scripts/freeze-legacy-manifest.py 再跑 scripts/extract-legacy-payload.py 产出这两样，
//    本脚本不重新跑提取，只消费其默认输出路径。）
//
// RC-L2 根治：require routes/legacy-archive/index.js 真实 mod.initSchema()（db helper 注入本脚本
//   :memory: db），测的是真实建表 DDL，非复刻一份 DDL（对齐 scripts/verify-periodic-schema.js 先例）。
//
// PART 1（:memory: 库，结构断言）：EXPECTED_SCHEMA 独立字面化期望表核验（全列名集合双向相等 +
//   NOT NULL 位 + PK，不依赖 mod._internals.KEY_COLS）+ status CHECK 四值独立核验（sqlite_master.sql
//   文本解析）+ 三索引结构核验 + 唯一索引正反例（含 source_sha256/dataset_key 两个此前未测过的
//   NOT NULL 反例）+ PRAGMA foreign_keys 测试期验 FK 定义可解析。
// PART 1b（对抗场景 ×3，codex 04 号外部审 H2 演进）：三个索引各自的"同名不同定义静默 no-op"场景。
//   ⚠️ 断言方向已反转：Opus 预筛版本证明的是"readiness 对索引结构不可见（诚实判 true，记录盲区），
//   必须靠独立结构核验单独抓"；H2 把索引结构/CHECK/NOT NULL 核验并入了 runLegacyArchiveMigration
//   本体后，这个盲区已被闭合——readiness 现在能自己识别同名错误索引并直接判 ready=false（error 里
//   指名索引 + 给出人工处理提示）。此处三个场景改断言 ready=false，独立结构核验仍作为第二重交叉
//   验证保留。
// PART 1c（残缺表对照组）：ready=false 且 error 含列名（缺列触发路径在 H2 新增检查之前，不受影响）。
// PART 2（临时文件库 + 子进程）：initSchema → 子进程 import-legacy-archive.js → 断言 verified +
//   8733 行 + 抽样核对（含 M2/M3 展示契约与列可见性统计）→ 子进程 --activate → 断言 active →
//   第二次全量导入 + activate → 断言旧批 retired。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

// L2（A2 预筛 LOW 留存，A3 当场修）：末尾原打印 `${passed}/${passed}`——分子分母同一个运行期变量，
// 恒等，任何断言分支被静默跳过（如某个 for 循环提前 return、某个场景函数没被调用）都不会让这行
// 输出露出破绽，永远显示"N/N 全过"。改为与一个独立硬编码的期望值对拍：EXPECTED_ASSERTIONS 是本
// 文件全部 ok() 调用点的运行期触发总数——人工静态数过 32 个源码调用点，其中 3 个在循环体内需按
// 迭代次数展开（[2a]/[2b] 各循环 3 表、PART1b 的 verifyIndexNoOpTrap 被 3 个 behavior 函数各调 1
// 次），其余 29 个都是单次调用（含"抽 3 行核对"那条——它的 ok() 调用在 for 循环外，是循环结束后
// 的一次性汇总断言，不按样本数展开）→ 29×1 + 3×3 = 38，并已用真实全链跑通实测核对一致（首次核算
// 曾误将"抽 3 行核对"也按 3 次展开算成 40，被本次实跑的真实 passed=38 当场纠正）。这个数字随代码
// 演进（新增/删除 ok() 调用点、循环元素数变化）需要同步手工重算，若忘了同步，下方 main() 末尾的
// 对拍会直接判红报出实际值与本常量的差异，不会被"分子分母恒等"这种假象继续掩盖。
const EXPECTED_ASSERTIONS = 38;

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
// L4（Opus 预筛必修）：临时产物清理失败此前只 console.error 一行，不影响退出码——容易被终端刷走、
// 静默漏判。汇总进这个数组，main() 末尾统一打印醒目 WARN 块 + 用独立退出码 2 区分"断言全过但清理
// 有残留"（正确性没问题，但需要人工核实磁盘）与"断言失败"（退出码 1，正确性问题）。
const cleanupWarnings = [];

// ---------------------------------------------------------------------------
// DB helper 工厂（每个子场景独立 :memory: 库，互不干扰）
// ---------------------------------------------------------------------------
function makeMemDb() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  return { db, run, all, get };
}

function makeModule({ dbRunAsync, dbGetAsync, dbAllAsync }, uploadDir) {
  return require(path.join(ROOT, 'routes', 'legacy-archive'))({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    dbRunAsync, dbGetAsync, dbAllAsync,
    authenticateToken: mwPass, requireAdmin: mwPass,
    UPLOAD_DIR: uploadDir || path.join(os.tmpdir(), 'legacy-archive-verify-uploads'),
  });
}

function waitReady(I, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.LEGACY_ARCHIVE_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.LEGACY_ARCHIVE_SCHEMA_STATE.error) { clearInterval(t); rej(new Error('readiness error: ' + I.LEGACY_ARCHIVE_SCHEMA_STATE.error)); }
      else if (++n > timeoutMs / 10) { clearInterval(t); rej(new Error('readiness 超时未就绪')); }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// 索引结构核验 helper（对齐 scripts/backfill-sys-derive-root-seq.js 的 checkDeriveIndexState 范式）
// ---------------------------------------------------------------------------
function normalizeSqlFragment(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function checkIndexStructure(all, get, indexName, expected) {
  // expected: { cols: [...], partial: bool, whereClause?: string }
  const rows = await all(`PRAGMA index_list('${expected.table}')`);
  const row = (rows || []).find(r => r.name === indexName);
  if (!row) return { state: 'missing' };
  if (Number(row.unique) !== 1) return { state: 'non_unique' };

  const problems = [];
  const infoRows = await all(`PRAGMA index_info('${indexName}')`);
  const cols = (infoRows || []).slice().sort((a, b) => a.seqno - b.seqno).map(r => r.name);
  const colsMatch = cols.length === expected.cols.length && cols.every((c, i) => c === expected.cols[i]);
  if (!colsMatch) problems.push(`列组不符（期望 [${expected.cols.join(',')}]，实得 [${cols.join(',')}]）`);

  if (expected.partial) {
    if (Number(row.partial) !== 1) {
      problems.push('非部分索引（缺少 WHERE 限定条件）');
    } else {
      const sqlRow = await get(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
      const sqlText = (sqlRow && sqlRow.sql) || '';
      const whereMatch = /\bWHERE\b([\s\S]*)$/i.exec(sqlText);
      const actualWhere = whereMatch ? whereMatch[1] : '';
      if (normalizeSqlFragment(actualWhere) !== normalizeSqlFragment(expected.whereClause)) {
        problems.push(`WHERE 非标准形（期望「${expected.whereClause}」，实际「${actualWhere.trim()}」）`);
      }
    }
  } else if (Number(row.partial) === 1) {
    problems.push('期望非部分索引，实得部分索引（多出 WHERE）');
  }

  return problems.length > 0 ? { state: 'mismatched', problems } : { state: 'ok' };
}

const IDX_BATCHES_ACTIVE = {
  table: 'legacy_archive_batches', cols: ['status'], partial: true, whereClause: "status='active'",
};
const IDX_DATASETS_BATCH_KEY = {
  table: 'legacy_archive_datasets', cols: ['batch_id', 'dataset_key'], partial: false,
};
const IDX_ROWS_DATASET_ROWIDX = {
  table: 'legacy_archive_rows', cols: ['dataset_id', 'row_index'], partial: false,
};

// ---------------------------------------------------------------------------
// codex 04 号外部审 M3：独立字面化期望表——不依赖 mod._internals.KEY_COLS 做结构断言（KEY_COLS
// 只是"生产代码自己声称的关键列子集"，若该常量本身写漏了，用它对拍等于自己证明自己；下方全部
// 结构断言改走 PRAGMA table_info/index_list/index_info + sqlite_master.sql，与
// routes/legacy-archive/index.js 里的同类实现各自独立编码——两处刻意不共享一份代码/常量，
// 这样任一处写错都能被另一处测出来，而不是"改错一起改错"）。
// ---------------------------------------------------------------------------
const EXPECTED_SCHEMA = {
  legacy_archive_batches: {
    columns: ['id', 'source_file', 'source_sha256', 'manifest', 'report', 'script_version', 'imported_at', 'status'],
    // report 允许 NULL（批次未完成校验前 report 为空）；其余方案 §3.1 字面清单外的常识性必填列。
    notNull: ['source_file', 'source_sha256', 'manifest', 'script_version', 'imported_at', 'status'],
    pk: 'id',
    statusCheckValues: ['pending', 'verified', 'active', 'retired'],
  },
  legacy_archive_datasets: {
    columns: ['id', 'batch_id', 'dataset_key', 'display_name', 'columns', 'row_count'],
    notNull: ['batch_id', 'dataset_key', 'display_name', 'columns', 'row_count'],
    pk: 'id',
  },
  legacy_archive_rows: {
    columns: ['id', 'dataset_id', 'row_index', 'excel_row', 'data', 'images', 'search_text'],
    // 方案 §3.1 字面"非空"清单只明文 dataset_id/row_index/data；excel_row/images/search_text
    // 允许 NULL（A2 交付报告已单独标注这点是刻意按字面口径，非遗漏）。
    notNull: ['dataset_id', 'row_index', 'data'],
    pk: 'id',
  },
};

async function checkTableStructure(all, table, spec) {
  const cols = await all(`PRAGMA table_info(${table})`);
  const actualColNames = cols.map(c => c.name);
  const expectedSet = new Set(spec.columns);
  const actualSet = new Set(actualColNames);
  const missingCols = spec.columns.filter(c => !actualSet.has(c));
  const extraCols = actualColNames.filter(c => !expectedSet.has(c));
  const notNullProblems = [];
  for (const colName of spec.notNull) {
    const col = cols.find(c => c.name === colName);
    if (!col) { notNullProblems.push(`${colName} 列不存在`); continue; }
    if (Number(col.notnull) !== 1) notNullProblems.push(`${colName} 未设 NOT NULL（实得 notnull=${col.notnull}）`);
  }
  const pkCols = cols.filter(c => Number(c.pk) === 1);
  const pkMatch = pkCols.length === 1 && pkCols[0].name === spec.pk;
  return { missingCols, extraCols, notNullProblems, pkMatch, actualPk: pkCols.map(c => c.name) };
}

async function checkStatusCheckConstraintIndependent(get) {
  const sqlRow = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_archive_batches'`);
  const sqlText = (sqlRow && sqlRow.sql) || '';
  const m = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sqlText);
  if (!m) return { ok: false, problem: '未找到 status 列的 CHECK(status IN (...)) 约束' };
  const actualValues = m[1].split(',').map(s => s.trim().replace(/^'(.*)'$/, '$1'));
  const actualSet = new Set(actualValues);
  const expected = EXPECTED_SCHEMA.legacy_archive_batches.statusCheckValues;
  const expectedSet = new Set(expected);
  const missing = expected.filter(v => !actualSet.has(v));
  const extra = actualValues.filter(v => !expectedSet.has(v));
  // codex 05 号外部审 M（CHECK 计数）：missing/extra 集合差分为空只证明"值集合覆盖一致"，防不住
  // IN 列表含重复值（如 5 项里 'pending' 出现两次，4 个期望值仍全部覆盖，集合差分测不出多余项）。
  const lengthMatch = actualValues.length === expected.length;
  return { ok: missing.length === 0 && extra.length === 0 && lengthMatch, actualValues, missing, extra, lengthMatch };
}

// ---------------------------------------------------------------------------
// PART 1 · 主场景：三表 + 索引 + CHECK + 唯一约束 + readiness
// ---------------------------------------------------------------------------
async function verifyMainSchema() {
  const { run, all, get } = makeMemDb();
  await run('PRAGMA foreign_keys = ON');   // 测试期开启，验 FK 定义拼对（生产未启用，仅结构声明）
  const mod = makeModule({ dbRunAsync: run, dbGetAsync: get, dbAllAsync: all });
  const I = mod._internals;

  await mod.initSchema();
  await waitReady(I);
  ok('三表 + 索引建立成功（真实 initSchema，非复刻 DDL）+ readiness ready=true');

  // [1] 三表存在
  const tables = (await all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('legacy_archive_batches','legacy_archive_datasets','legacy_archive_rows')"
  )).map(r => r.name);
  assert.strictEqual(tables.length, 3, `应有 3 表，实际 ${tables.length}: ${tables.join(',')}`);
  ok(`三表存在：${tables.sort().join(' / ')}`);

  // [2a] 关键列齐全（与 _internals KEY_COLS 同源——注意：这只是"生产代码自己声称的关键列子集"，
  //   不算独立结构覆盖，保留是为了在 KEY_COLS 常量本身漂移时也能有一层信号，见下方 [2b] 才是
  //   M3 要求的真正独立覆盖）。
  for (const [tbl, keyColsName] of [
    ['legacy_archive_batches', 'LEGACY_ARCHIVE_BATCHES_KEY_COLS'],
    ['legacy_archive_datasets', 'LEGACY_ARCHIVE_DATASETS_KEY_COLS'],
    ['legacy_archive_rows', 'LEGACY_ARCHIVE_ROWS_KEY_COLS'],
  ]) {
    const colRows = await all(`PRAGMA table_info(${tbl})`);
    const cols = colRows.map(r => r.name);
    const missing = I[keyColsName].filter(c => !cols.includes(c));
    assert.strictEqual(missing.length, 0, `${tbl} 缺列: ${missing.join(',')}`);
    ok(`${tbl}._internals.${keyColsName} 全部存在于真实建表（${I[keyColsName].length} 列，非独立结构覆盖，仅辅助信号）`);
  }

  // [2b]（codex 04 号外部审 M3）独立字面化期望表核验——不经 _internals，直接用 EXPECTED_SCHEMA
  //   常量（本文件自己编码，不引用生产模块任何常量）逐表核对：全列名集合双向相等 + NOT NULL 位 + PK。
  for (const [tbl, spec] of Object.entries(EXPECTED_SCHEMA)) {
    const structCheck = await checkTableStructure(all, tbl, spec);
    assert.strictEqual(structCheck.missingCols.length, 0, `${tbl} 缺列（EXPECTED_SCHEMA 独立核验）: ${structCheck.missingCols.join(',')}`);
    assert.strictEqual(structCheck.extraCols.length, 0, `${tbl} 多出未预期列（EXPECTED_SCHEMA 独立核验）: ${structCheck.extraCols.join(',')}`);
    assert.strictEqual(structCheck.notNullProblems.length, 0, `${tbl} NOT NULL 位不符: ${structCheck.notNullProblems.join('；')}`);
    assert.ok(structCheck.pkMatch, `${tbl} PK 应为 ${spec.pk}，实得 [${structCheck.actualPk.join(',')}]`);
    ok(`${tbl} EXPECTED_SCHEMA 独立结构核验：全 ${spec.columns.length} 列双向相等 + ${spec.notNull.length} 列 NOT NULL 位正确 + PK=${spec.pk}`);
  }

  // [2c] status CHECK 四值——独立实现（不调用 routes/legacy-archive 导出的 checkBatchesStatusCheckConstraint）。
  const statusCheckIndependent = await checkStatusCheckConstraintIndependent(get);
  assert.ok(statusCheckIndependent.ok, `status CHECK 独立核验不符：${JSON.stringify(statusCheckIndependent)}`);
  ok(`legacy_archive_batches.status CHECK 独立核验（sqlite_master.sql 文本解析）：四值 [${statusCheckIndependent.actualValues.join(',')}] 与期望一致`);

  // [3] status CHECK：4 个合法值各插一行（同一时刻只留一条 active，避免撞部分唯一索引）+ 非法值拒
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','pending')`);
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','verified')`);
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','active')`);
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','retired')`);
  await assert.rejects(
    run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','bogus')`),
    /CHECK|constraint/i, 'status=bogus 应被 CHECK 拒'
  );
  ok('legacy_archive_batches.status CHECK：pending/verified/active/retired 合法插入通过，bogus 被拒');

  // [3b]（codex 04 号外部审 M3）source_sha256 NOT NULL 反例（此前只测过 rows 三列，batches/datasets
  //   的 NOT NULL 列从未有过负例插入）。
  await assert.rejects(
    run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('c.xlsx', NULL, '{}', '1.0', 'retired')`),
    /NOT NULL|constraint/i, 'source_sha256 为空应被拒'
  );
  ok('legacy_archive_batches.source_sha256 NOT NULL 生效（反例插入拒绝）');

  // [4] ≤1 active 部分唯一索引：第二条 active 必须被拒
  await assert.rejects(
    run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('b.xlsx','sha2','{}','1.0','active')`),
    /UNIQUE|constraint/i, '第二条 active 批次应被部分唯一索引拒绝'
  );
  ok('idx_legacy_archive_batches_active 生效：同一时刻第二条 active 被拒（正反例）');

  // [5] 索引结构核验（健康态应为 'ok'，非部分/非结构错误——RC-L2 用真实 DDL，理论上必然 ok，
  //   这一步同时也是下面对抗场景[verifyIndexNoOpTrap]的"健康态对照组"）
  const idx1 = await checkIndexStructure(all, get, 'idx_legacy_archive_batches_active', IDX_BATCHES_ACTIVE);
  assert.strictEqual(idx1.state, 'ok', `idx_legacy_archive_batches_active 结构核验应为 ok，实得 ${idx1.state}: ${JSON.stringify(idx1.problems)}`);
  const idx2 = await checkIndexStructure(all, get, 'idx_legacy_archive_datasets_batch_key', IDX_DATASETS_BATCH_KEY);
  assert.strictEqual(idx2.state, 'ok', `idx_legacy_archive_datasets_batch_key 结构核验应为 ok，实得 ${idx2.state}: ${JSON.stringify(idx2.problems)}`);
  const idx3 = await checkIndexStructure(all, get, 'idx_legacy_archive_rows_dataset_rowidx', IDX_ROWS_DATASET_ROWIDX);
  assert.strictEqual(idx3.state, 'ok', `idx_legacy_archive_rows_dataset_rowidx 结构核验应为 ok，实得 ${idx3.state}: ${JSON.stringify(idx3.problems)}`);
  ok('三个索引 sqlite_master 结构核验（列组 + partial/WHERE 标准形）全部 ok（健康态基线，供下方对抗场景对拍）');

  // [6] (batch_id, dataset_key) 唯一：正反例
  const pendingBatch = await get(`SELECT id FROM legacy_archive_batches WHERE status='pending'`);
  await run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bug_list', 'bug及小优化', '[]', 0)`, [pendingBatch.id]);
  await run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bms_maint', 'BMS维护单', '[]', 0)`, [pendingBatch.id]);
  await assert.rejects(
    run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bug_list', '重名', '[]', 0)`, [pendingBatch.id]),
    /UNIQUE|constraint/i, '同 batch_id 下重复 dataset_key 应被拒'
  );
  ok('idx_legacy_archive_datasets_batch_key 生效：同批次不同 dataset_key 通过，重复 dataset_key 被拒（正反例）');

  // [6b]（codex 04 号外部审 M3）dataset_key NOT NULL 反例。
  await assert.rejects(
    run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, NULL, 'x', '[]', 0)`, [pendingBatch.id]),
    /NOT NULL|constraint/i, 'dataset_key 为空应被拒'
  );
  ok('legacy_archive_datasets.dataset_key NOT NULL 生效（反例插入拒绝）');

  // [7] (dataset_id, row_index) 唯一：正反例
  const bugDs = await get(`SELECT id FROM legacy_archive_datasets WHERE dataset_key='bug_list' AND batch_id=?`, [pendingBatch.id]);
  await run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 1, 2, '{}')`, [bugDs.id]);
  await run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 2, 3, '{}')`, [bugDs.id]);
  await assert.rejects(
    run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 1, 999, '{}')`, [bugDs.id]),
    /UNIQUE|constraint/i, '同 dataset_id 下重复 row_index 应被拒'
  );
  ok('idx_legacy_archive_rows_dataset_rowidx 生效：同数据集不同 row_index 通过，重复 row_index 被拒（正反例）');

  // [8] dataset_id/row_index/data 非空（方案 §3.1 字面清单）
  await assert.rejects(
    run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (NULL, 3, 4, '{}')`),
    /NOT NULL|constraint/i, 'dataset_id 为空应被拒'
  );
  await assert.rejects(
    run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, NULL, 4, '{}')`, [bugDs.id]),
    /NOT NULL|constraint/i, 'row_index 为空应被拒'
  );
  await assert.rejects(
    run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 3, 4, NULL)`, [bugDs.id]),
    /NOT NULL|constraint/i, 'data 为空应被拒'
  );
  ok('legacy_archive_rows：dataset_id/row_index/data 三列 NOT NULL 生效（方案 §3.1 字面"非空"清单）');

  // [9] FK 定义正确性（测试期 FK ON）：孤儿引用被拒
  await assert.rejects(
    run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (999999, 'x', 'x', '[]', 0)`),
    /FOREIGN KEY|constraint/i, 'legacy_archive_datasets FK 未拦截孤儿引用'
  );
  await assert.rejects(
    run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (999999, 1, 1, '{}')`),
    /FOREIGN KEY|constraint/i, 'legacy_archive_rows FK 未拦截孤儿引用'
  );
  ok('FK 定义正确（测试期 PRAGMA foreign_keys=ON）：datasets/rows 引用不存在的父行被拒（生产未启用 FK，仅结构声明）');

  return { db: null };
}

// ---------------------------------------------------------------------------
// PART 1b · 对抗场景：同名不同定义的索引 → CREATE UNIQUE INDEX IF NOT EXISTS 静默 no-op
//
// codex 04 号外部审 H2 演进说明：本场景最初（Opus 预筛版本）断言的是"readiness 仍诚实判 true，
// 记录这是一个盲区，靠独立结构核验单独抓"——那是因为当时 readiness 只做列存在性 PRAGMA 复查，
// 对索引结构无感。H2 把三个索引的结构核验、CHECK 约束、rows NOT NULL 位都并入了
// runLegacyArchiveMigration 本体（routes/legacy-archive/index.js），readiness 现在能自己识别
// 这类"同名错误索引"并直接判 ready=false（error 里指名索引 + 给出人工处理提示）——此前记录的
// 盲区已被 H2 闭合。故这里的断言方向整体反转：健康态判 ok（三索引都对）/对抗态判 ready=false
// （任一索引结构不符）——这是新的双向证明。独立结构核验（checkIndexStructure）依然保留作为
// 第二重交叉验证，证明 readiness 的结论与独立核验的结论一致，不是巧合。
// ---------------------------------------------------------------------------
const LEGACY_ARCHIVE_TABLE_DDL_FOR_ADVERSARIAL_TESTS = [
  `CREATE TABLE legacy_archive_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    manifest TEXT NOT NULL, report TEXT, script_version TEXT NOT NULL,
    imported_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','active','retired'))
  )`,
  `CREATE TABLE legacy_archive_datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES legacy_archive_batches(id),
    dataset_key TEXT NOT NULL, display_name TEXT NOT NULL, columns TEXT NOT NULL, row_count INTEGER NOT NULL
  )`,
  `CREATE TABLE legacy_archive_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id INTEGER NOT NULL REFERENCES legacy_archive_datasets(id),
    row_index INTEGER NOT NULL, excel_row INTEGER, data TEXT NOT NULL, images TEXT, search_text TEXT
  )`,
];

async function verifyIndexNoOpTrap(scenarioLabel, badIndexName, badIndexSql, expectedDef) {
  const { run, all, get } = makeMemDb();
  for (const sql of LEGACY_ARCHIVE_TABLE_DDL_FOR_ADVERSARIAL_TESTS) await run(sql);
  // 错误定义：同名，但列组/partial 都不对（建在 id 列上的全表唯一索引），模拟"曾经手改过又没跟着
  // 方案同步"的历史场景。
  await run(badIndexSql);

  const mod = makeModule({ dbRunAsync: run, dbGetAsync: get, dbAllAsync: all });
  const I = mod._internals;

  await mod.initSchema();
  await new Promise((resolve) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.LEGACY_ARCHIVE_SCHEMA_STATE.ready || I.LEGACY_ARCHIVE_SCHEMA_STATE.error) { clearInterval(t); resolve(); }
      else if (++n > 500) { clearInterval(t); resolve(); }
    }, 10);
  });

  // H2 之后：readiness 现在应该判 false（反转自此前"诚实判 true 记录盲区"的断言方向，见上方演进说明）。
  assert.strictEqual(
    I.LEGACY_ARCHIVE_SCHEMA_STATE.ready, false,
    `${scenarioLabel}: H2 升级后 readiness 应判 false，实得 ready=true（说明 H2 的索引结构核验未生效）`
  );
  assert.ok(
    I.LEGACY_ARCHIVE_SCHEMA_STATE.error && I.LEGACY_ARCHIVE_SCHEMA_STATE.error.includes(badIndexName),
    `${scenarioLabel}: error 应指名坏索引 ${badIndexName}，实得：${I.LEGACY_ARCHIVE_SCHEMA_STATE.error}`
  );
  assert.ok(
    /人工处理|人工核实/.test(I.LEGACY_ARCHIVE_SCHEMA_STATE.error),
    `${scenarioLabel}: error 应含可操作提示（人工处理/人工核实字样），实得：${I.LEGACY_ARCHIVE_SCHEMA_STATE.error}`
  );

  const idxCheck = await checkIndexStructure(all, get, badIndexName, expectedDef);
  assert.notStrictEqual(idxCheck.state, 'ok', `${scenarioLabel}: 独立结构核验也应判非 ok（与 readiness 结论一致，交叉验证）`);

  ok(
    `${scenarioLabel}：H2 升级后 readiness 正确检出坏索引 ${badIndexName} → ready=false + error 指名 + ` +
    `可操作提示（独立结构核验同判非 ok=${idxCheck.state}，双重确认）`
  );

  return { run, all };
}

// 行为级交叉验证：坏索引下约束确实没生效（能插入本该被拒的重复值），与结构判定/readiness 结论一致。
async function verifyIndexNoOpTrapBehavior_BatchesActive() {
  const { run, all } = await verifyIndexNoOpTrap(
    'PART1b-1 batches_active',
    'idx_legacy_archive_batches_active',
    `CREATE UNIQUE INDEX idx_legacy_archive_batches_active ON legacy_archive_batches(id)`,
    IDX_BATCHES_ACTIVE
  );
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','active')`);
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('b.xlsx','sha2','{}','1.0','active')`);
  const activeCount = (await all(`SELECT id FROM legacy_archive_batches WHERE status='active'`)).length;
  assert.strictEqual(activeCount, 2, `坏索引下应能插入 2 条 active（部分唯一约束未真正生效），实得 ${activeCount}`);
  ok('PART1b-1 行为级交叉验证：坏索引下 2 条 active 均插入成功（约束确实没生效，与结构核验/readiness 判定一致）');
}

async function verifyIndexNoOpTrapBehavior_DatasetsBatchKey() {
  const { run, all } = await verifyIndexNoOpTrap(
    'PART1b-2 datasets_batch_key',
    'idx_legacy_archive_datasets_batch_key',
    `CREATE UNIQUE INDEX idx_legacy_archive_datasets_batch_key ON legacy_archive_datasets(id)`,
    IDX_DATASETS_BATCH_KEY
  );
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','pending')`);
  const b = await all(`SELECT id FROM legacy_archive_batches`);
  const batchId = b[0].id;
  await run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bug_list', 'x', '[]', 0)`, [batchId]);
  await run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bug_list', 'y', '[]', 0)`, [batchId]);
  const dupCount = (await all(`SELECT id FROM legacy_archive_datasets WHERE batch_id = ? AND dataset_key = 'bug_list'`, [batchId])).length;
  assert.strictEqual(dupCount, 2, `坏索引下应能插入 2 条重复 (batch_id,dataset_key)（唯一约束未真正生效），实得 ${dupCount}`);
  ok('PART1b-2 行为级交叉验证：坏索引下 2 条重复 (batch_id,dataset_key) 均插入成功（约束确实没生效，与结构核验/readiness 判定一致）');
}

async function verifyIndexNoOpTrapBehavior_RowsDatasetRowidx() {
  const { run, all } = await verifyIndexNoOpTrap(
    'PART1b-3 rows_dataset_rowidx',
    'idx_legacy_archive_rows_dataset_rowidx',
    `CREATE UNIQUE INDEX idx_legacy_archive_rows_dataset_rowidx ON legacy_archive_rows(id)`,
    IDX_ROWS_DATASET_ROWIDX
  );
  await run(`INSERT INTO legacy_archive_batches (source_file, source_sha256, manifest, script_version, status) VALUES ('a.xlsx','sha1','{}','1.0','pending')`);
  const b = await all(`SELECT id FROM legacy_archive_batches`);
  const batchId = b[0].id;
  await run(`INSERT INTO legacy_archive_datasets (batch_id, dataset_key, display_name, columns, row_count) VALUES (?, 'bug_list', 'x', '[]', 0)`, [batchId]);
  const d = await all(`SELECT id FROM legacy_archive_datasets`);
  const datasetId = d[0].id;
  await run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 1, 2, '{}')`, [datasetId]);
  await run(`INSERT INTO legacy_archive_rows (dataset_id, row_index, excel_row, data) VALUES (?, 1, 3, '{}')`, [datasetId]);
  const dupCount = (await all(`SELECT id FROM legacy_archive_rows WHERE dataset_id = ? AND row_index = 1`, [datasetId])).length;
  assert.strictEqual(dupCount, 2, `坏索引下应能插入 2 条重复 (dataset_id,row_index)（唯一约束未真正生效），实得 ${dupCount}`);
  ok('PART1b-3 行为级交叉验证：坏索引下 2 条重复 (dataset_id,row_index) 均插入成功（约束确实没生效，与结构核验/readiness 判定一致）');
}

// ---------------------------------------------------------------------------
// PART 1c · 残缺表对照组：缺列库 → ready=false 且 error 含列名
// ---------------------------------------------------------------------------
async function verifyMissingColLib() {
  const { run, all, get } = makeMemDb();
  const mod = makeModule({ dbRunAsync: run, dbGetAsync: get, dbAllAsync: all });
  const I = mod._internals;

  // 手工建残缺表（legacy_archive_rows 故意缺 data + excel_row）
  await run(`CREATE TABLE legacy_archive_batches (id INTEGER PRIMARY KEY, source_file TEXT, source_sha256 TEXT, manifest TEXT, report TEXT, script_version TEXT, imported_at TEXT, status TEXT)`);
  await run(`CREATE TABLE legacy_archive_datasets (id INTEGER PRIMARY KEY, batch_id INTEGER, dataset_key TEXT, display_name TEXT, columns TEXT, row_count INTEGER)`);
  await run(`CREATE TABLE legacy_archive_rows (id INTEGER PRIMARY KEY, dataset_id INTEGER, row_index INTEGER, images TEXT, search_text TEXT)`);

  await I.runLegacyArchiveMigration(null);
  const st = I.LEGACY_ARCHIVE_SCHEMA_STATE;
  assert.strictEqual(st.ready, false, '缺列库 readiness 应为 false');
  // L3（A2 预筛 LOW 留存，A3 当场修）：原正则 /data|excel_row/ 太弱——"datasets" 表名本身含 "data"
  // 子串，若未来错误信息误报到别的表（如写成"legacy_archive_datasets 关键列缺失：xxx"），这条正则
  // 仍会误判通过。改为三条独立断言：错误信息须同时含真实表名 legacy_archive_rows + 两个真实缺失列名
  // （用 \b 词边界，防止 "data" 被 "database" 一类子串误命中——尽管当前实际文案不会出现这类词，但
  // 断言本身应该独立可靠，不依赖"当前文案恰好没有这类词"这个偶然事实）。
  assert.ok(/legacy_archive_rows/.test(st.error || ''), `缺列错误信息应含表名 legacy_archive_rows，实际：${st.error}`);
  assert.ok(/\bdata\b/.test(st.error || ''), `缺列错误信息应含真实缺失列名 data，实际：${st.error}`);
  assert.ok(/\bexcel_row\b/.test(st.error || ''), `缺列错误信息应含真实缺失列名 excel_row，实际：${st.error}`);
  ok(`残缺表对照组：legacy_archive_rows 缺 data/excel_row → ready=false（错误含表名+两真列名：${st.error}）`);

  // 503 中间件双态验证（error 存在时优先报 NOT_READY，不报 INITIALIZING）
  let capturedStatus = null, capturedBody = null;
  const fakeRes = { status(s) { capturedStatus = s; return this; }, json(b) { capturedBody = b; return this; } };
  I.requireLegacyArchiveSchemaReady({}, fakeRes, () => { throw new Error('不应放行'); });
  assert.strictEqual(capturedStatus, 503, '缺列态应返 503');
  assert.strictEqual(capturedBody.code, 'LEGACY_ARCHIVE_SCHEMA_NOT_READY', '缺列态 code 应为 LEGACY_ARCHIVE_SCHEMA_NOT_READY');
  ok(`requireLegacyArchiveSchemaReady 中间件：缺列态返 503 + code=LEGACY_ARCHIVE_SCHEMA_NOT_READY + detail="${capturedBody.detail}"`);
}

// 环境缺陷回填（A3 交付报告实测记录，2026-08-20，取代下方旧版"不做 existsSync 复核"的处置）：
// 原注释认定"rmSync 未抛异常后同进程 existsSync 复核偶发假阳性是 stat 可见性滞后，不是删除本身
// 失败"——A3 交付时用最小复现脚本证伪了这个假设：本机（Windows + Node v24.11.1）对含 467 个文件
// 的目录反复调用 `fs.rmSync(dir,{recursive:true,force:true})` 8 次 + 每次间隔 500ms，目录与全部
// 文件原样保留、从不抛异常——这是删除本身真的没发生，不是可见性滞后，旧版"信 rmSync 不抛异常就
// return"的判定因此存在盲区（cleanupWarnings 机制天然测不到）。改两处：①删除原语从 fs.rmSync 换成
// 手写递归（逐文件 fs.unlinkSync + 目录清空后 fs.rmdirSync，同一批文件用这条路径删除稳定生效，
// 已在 scripts/verify-legacy-archive-api.js 的同款场景验证过）；②不再只信"删除调用没抛异常"，
// 每次尝试后都做 existsSync 复核，复核过了才真正 return，复核不过继续进入下一轮重试——这才是
// cleanupWarnings 盲区的根治，而非只换个更可靠的删除原语但继续裸信"没抛异常=成功"。
// M5（外部 codex 07 审·本轮当场修，三处同步之一，另两处 import-legacy-archive.js
// removeDirManualSync / verify-legacy-archive-api.js removeDirManual）：lstatSync 判定类型——命中
// 符号链接/Windows 目录联接（junction，Node 的 lstat 对两者统一走 isSymbolicLink() 分支）时只删链接
// 节点本身，不递归进目标（防被链接指向的路径拖进来误删）；先 unlinkSync，遇 EPERM/EISDIR（目录型
// 链接部分场景）退到 rmdirSync。普通文件遇 EPERM（Windows 只读属性）先 chmodSync 0o666 去只读位
// 再重删一次。目录深度说明：本函数处理的目标是 tmp/legacy-archive-verify-uploads-<stamp>/
// legacy-archive/<batch_id>/<图片文件>（PART 2 临时上传根），实际层级固定 3 层（stamp 目录→
// legacy-archive→batch_id→扁平图片文件，图片这一层不再有子目录），递归深度恒定，无深递归栈风险，
// 写成通用递归只是防御性代码风格。
function removeManualSync(targetPath, recursive) {
  const st = fs.lstatSync(targetPath);
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(targetPath);
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(targetPath);
      else throw e;
    }
    return;
  }
  if (st.isDirectory()) {
    if (recursive) {
      for (const name of fs.readdirSync(targetPath)) {
        removeManualSync(path.join(targetPath, name), true);
      }
    }
    fs.rmdirSync(targetPath); // 非 recursive 场景对非空目录会抛 ENOTEMPTY，语义对齐旧版 rmSync 的非递归形态
    return;
  }
  try {
    fs.unlinkSync(targetPath);
  } catch (e) {
    if (e && e.code === 'EPERM') {
      fs.chmodSync(targetPath, 0o666);
      fs.unlinkSync(targetPath);
    } else {
      throw e;
    }
  }
}

async function removeWithRetry(targetPath, { recursive = false, maxRetries = 5 } = {}) {
  if (!fs.existsSync(targetPath)) return;
  const delays = [50, 100, 200, 200, 200];
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      removeManualSync(targetPath, recursive);
    } catch (e) {
      lastError = e; // 记录但不在此处立即判定失败——存在性复核才是权威信号，见下方
    }
    if (!fs.existsSync(targetPath)) return; // 复核通过：manual 删除这一轮确实生效，成功返回
    if (attempt < maxRetries) {
      await new Promise((res) => setTimeout(res, delays[attempt] || 200));
    }
  }
  const msg = `${targetPath}（${lastError ? lastError.message : '多次重试后 existsSync 复核仍为 true（manual 删除未真正生效）'}）`;
  console.error(`⚠️ 清理临时产物失败（需人工核实）：${msg}`);
  cleanupWarnings.push(msg); // L4：汇总进 main() 末尾醒目 WARN 块 + 独立退出码，不再只刷一行 console.error
  // 断言正确性与清理失败解耦——此处不 throw，但整体脚本会用非 0 退出码反映"需要人工核实"
}

// ---------------------------------------------------------------------------
// PART 2 · 临时文件库 + 子进程全链：initSchema → import → 断言 → activate → 断言 → 二次导入 → 断言旧批 retired
// ---------------------------------------------------------------------------
async function verifyFullImportChain() {
  const manifestPath = path.join(ROOT, '..', 'tmp', 'legacy-archive-manifest.json');
  const payloadDir = path.join(ROOT, '..', 'tmp', 'legacy-archive-payload');
  const summaryPath = path.join(payloadDir, 'payload-summary.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(summaryPath)) {
    throw new Error(
      `PART 2 依赖前置产物缺失：\n  manifest=${manifestPath}（存在=${fs.existsSync(manifestPath)}）\n  ` +
      `payload-summary=${summaryPath}（存在=${fs.existsSync(summaryPath)}）\n` +
      `请先跑 scripts/freeze-legacy-manifest.py 与 scripts/extract-legacy-payload.py`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const stamp = Date.now();
  const tmpDbPath = path.join(ROOT, '..', 'tmp', `legacy-archive-verify-${stamp}.db`);
  const tmpUploadsRoot = path.join(ROOT, '..', 'tmp', `legacy-archive-verify-uploads-${stamp}`);
  const importScript = path.join(ROOT, 'scripts', 'import-legacy-archive.js');

  try {
    // ── 建临时文件库 + initSchema ──────────────────────────────
    const db = new sqlite3.Database(tmpDbPath);
    const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    const mod = makeModule({ dbRunAsync: run, dbGetAsync: get, dbAllAsync: all }, tmpUploadsRoot);
    await mod.initSchema();
    await waitReady(mod._internals);
    await new Promise((res, rej) => db.close(e => e ? rej(e) : res()));
    ok(`临时文件库 schema 就绪：${tmpDbPath}`);

    // ── 子进程跑 import-legacy-archive.js（--db 指临时库） ──────────────────────
    execFileSync('node', [importScript, '--db', tmpDbPath, '--uploads-root', tmpUploadsRoot], { encoding: 'utf8', cwd: ROOT });
    ok('子进程 import-legacy-archive.js 执行成功（--db 指临时库，manifest/payload 用默认路径）');

    const db2 = new sqlite3.Database(tmpDbPath);
    const all2 = (sql, params = []) => new Promise((res, rej) => db2.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const get2 = (sql, params = []) => new Promise((res, rej) => db2.get(sql, params, (e, row) => e ? rej(e) : res(row)));

    const batch1 = await get2(`SELECT * FROM legacy_archive_batches ORDER BY id ASC LIMIT 1`);
    assert.strictEqual(batch1.status, 'verified', `导入后 batch #1 状态应为 verified，实得 ${batch1.status}`);
    const report1 = JSON.parse(batch1.report);
    assert.strictEqual(report1.passed, true, 'import 导入报告 passed 应为 true');
    ok(`batch #1 status=verified，导入报告 passed=true（total_rows_written=${report1.total_rows_written}）`);

    const rowCount = await get2(`SELECT COUNT(*) c FROM legacy_archive_rows`);
    assert.strictEqual(rowCount.c, 8733, `legacy_archive_rows 总行数应为 8733，实得 ${rowCount.c}`);
    ok('legacy_archive_rows 总行数 = 8733（与方案 §2 合计一致）');

    // M2① — bug_list 库内 columns JSON 统计：list=18/detail=2/none=31，detail 的 original_index
    // 集合恰为 {19,51}（方案 §3.2 冻结口径：18 具名业务列 list + 位置 18/50[0-based]=original_index
    // 19/51 两个"有文字的无名旁注列" detail + 其余 31 个 WPS 图片外溢列 none）。
    const datasetRows = await all2(
      `SELECT dataset_key, columns FROM legacy_archive_datasets WHERE batch_id = ?`,
      [batch1.id]
    );
    const datasetColumnsByKey = {};
    for (const dr of datasetRows) datasetColumnsByKey[dr.dataset_key] = JSON.parse(dr.columns);

    const bugCols = datasetColumnsByKey['bug_list'];
    const visCounts = { list: 0, detail: 0, none: 0 };
    const detailOriginalIndexes = [];
    for (const c of bugCols) {
      visCounts[c.visibility] = (visCounts[c.visibility] || 0) + 1;
      if (c.visibility === 'detail') detailOriginalIndexes.push(c.original_index);
    }
    assert.deepStrictEqual(visCounts, { list: 18, detail: 2, none: 31 }, `bug_list columns visibility 统计应为 list:18/detail:2/none:31，实得 ${JSON.stringify(visCounts)}`);
    assert.deepStrictEqual(detailOriginalIndexes.slice().sort((a, b) => a - b), [19, 51], `bug_list detail 列 original_index 集合应为 {19,51}，实得 ${JSON.stringify(detailOriginalIndexes)}`);
    ok(`M2① bug_list columns 库内统计：list=18/detail=2/none=31，detail original_index={19,51}`);

    // M2② — 其余 7 个 dataset 全部 list（方案 §3.2："其余 7 个 dataset 全列 = list"）。
    const otherDatasetKeys = Object.keys(datasetColumnsByKey).filter(k => k !== 'bug_list');
    assert.strictEqual(otherDatasetKeys.length, 7, `除 bug_list 外应有 7 个 dataset，实得 ${otherDatasetKeys.length}`);
    for (const key of otherDatasetKeys) {
      const cols = datasetColumnsByKey[key];
      const nonList = cols.filter(c => c.visibility !== 'list');
      assert.strictEqual(nonList.length, 0, `${key} 应全部 list，实得非 list 列：${JSON.stringify(nonList)}`);
    }
    ok(`M2② 其余 7 个 dataset（${otherDatasetKeys.join('/')}）columns 全部 visibility=list`);

    // 抽 3 行核对：data JSON 可解析 + excel_row 与 manifest 一致 + M2③ 字段键覆盖 + search_text 承重
    const bugManifest = manifest.datasets.find(d => d.dataset_key === 'bug_list');
    const ocrManifest = manifest.datasets.find(d => d.dataset_key === 'ocr_dispatch_log');
    const samples = [
      { datasetKey: 'bug_list', rowIndex: 1, expectedExcelRow: bugManifest.keep_excel_rows[0] },
      { datasetKey: 'bug_list', rowIndex: 474, expectedExcelRow: bugManifest.keep_excel_rows[473], expectImage: true },
      { datasetKey: 'ocr_dispatch_log', rowIndex: ocrManifest.keep_excel_rows.length, expectedExcelRow: ocrManifest.keep_excel_rows[ocrManifest.keep_excel_rows.length - 1] },
    ];
    for (const s of samples) {
      const row = await get2(
        `SELECT r.* FROM legacy_archive_rows r JOIN legacy_archive_datasets d ON r.dataset_id = d.id
         WHERE d.dataset_key = ? AND r.row_index = ? AND d.batch_id = ?`,
        [s.datasetKey, s.rowIndex, batch1.id]
      );
      assert.ok(row, `抽样行未找到：${s.datasetKey} row_index=${s.rowIndex}`);
      assert.strictEqual(row.excel_row, s.expectedExcelRow, `${s.datasetKey} row_index=${s.rowIndex} excel_row 应为 ${s.expectedExcelRow}，实得 ${row.excel_row}`);
      let parsedData;
      assert.doesNotThrow(() => { parsedData = JSON.parse(row.data); }, `${s.datasetKey} row_index=${s.rowIndex} data 应可解析 JSON`);
      assert.ok(parsedData && typeof parsedData === 'object', 'data 应解析为对象');
      if (s.expectImage) {
        const images = JSON.parse(row.images || '[]');
        assert.ok(images.length > 0, `${s.datasetKey} row_index=${s.rowIndex} 期望携带图片，实得 images=${row.images}`);
      }

      // M2③ — 字段键数与列数对齐（呼应 import.js M5 守卫，这里是从库内数据独立复核，不是信任
      // 导入脚本自己的报告）+ search_text 非空且含该行任一 list 字段值的小写形（不是空字符串
      // 占位，真承重可搜索）。
      const sampleCols = datasetColumnsByKey[s.datasetKey];
      assert.strictEqual(
        Object.keys(parsedData).length, sampleCols.length,
        `${s.datasetKey} row_index=${s.rowIndex}: data 字段键数(${Object.keys(parsedData).length}) 应等于列数(${sampleCols.length})`
      );
      const listFieldsForSample = sampleCols.filter(c => c.visibility === 'list').map(c => c.field);
      const listValuesLower = listFieldsForSample
        .map(f => parsedData[f])
        .filter(v => v !== null && v !== undefined)
        .map(v => String(v).toLowerCase());
      assert.ok(row.search_text && row.search_text.length > 0, `${s.datasetKey} row_index=${s.rowIndex}: search_text 不应为空`);
      const containsAnyListValue = listValuesLower.some(v => v.length > 0 && row.search_text.includes(v));
      assert.ok(containsAnyListValue, `${s.datasetKey} row_index=${s.rowIndex}: search_text="${row.search_text}" 应含某个 list 字段值的小写形（候选：${JSON.stringify(listValuesLower)}）`);
    }
    ok(`抽 3 行核对：data JSON 可解析 + excel_row 一致 + 字段键数=列数 + search_text 非空且含 list 字段值小写形（含 1 条图片行）`);

    // M3 — 展示契约（方案 §3.4）四类固定样例。"数字文本""空日期(null)"两类从真实 payload 挑固定
    // (dataset,row_index,field) 三元组，直接查库把期望字符串写死断言（不是信任 import 报告，是
    // 从库里独立复核）。"带时间日期""脏日期 1970-01-01"两类真实数据零命中（后者已用两条独立路径
    // 核实：逐 8 表扫全部 jsonl + 对源 xlsx datetime64 列精确匹配，均确认不存在——Opus 预筛"BMS维护
    // 单里有 1970-01-01"的说法未能复现，判断为误判），改走 extract-legacy-payload.py 的
    // --self-test-format 子进程模式做合成用例单元测试（选择理由：复用已实现的自测入口，比在
    // verify.js 里内联 `python -c` 拼字符串更不易踩 Windows 命令行转义/编码坑，也让该单元测试
    // 常驻在被测函数所在文件里，供其他调用方复用）。
    const numericTextRow = await get2(
      `SELECT r.data FROM legacy_archive_rows r JOIN legacy_archive_datasets d ON r.dataset_id = d.id
       WHERE d.dataset_key = 'bug_list' AND r.row_index = 1 AND d.batch_id = ?`,
      [batch1.id]
    );
    const numericTextData = JSON.parse(numericTextRow.data);
    assert.strictEqual(numericTextData.f001, '1', `M3 数字文本样例 bug_list row_index=1 f001 应为 "1"，实得 ${JSON.stringify(numericTextData.f001)}`);

    const nullDateRow = await get2(
      `SELECT r.data FROM legacy_archive_rows r JOIN legacy_archive_datasets d ON r.dataset_id = d.id
       WHERE d.dataset_key = 'bug_list' AND r.row_index = 173 AND d.batch_id = ?`,
      [batch1.id]
    );
    const nullDateData = JSON.parse(nullDateRow.data);
    assert.strictEqual(nullDateData.f009, null, `M3 空日期样例 bug_list row_index=173 f009 应为 null，实得 ${JSON.stringify(nullDateData.f009)}`);
    ok(`M3 展示契约·真实样例：数字文本 bug_list#1.f001="1"，空日期 bug_list#173.f009=null（均库内直查，非信任报告）`);

    const extractScript = path.join(ROOT, 'scripts', 'extract-legacy-payload.py');
    let selfTestOutput = '';
    let selfTestFailed = false;
    try {
      selfTestOutput = execFileSync('python', [extractScript, '--self-test-format'], { encoding: 'utf8', cwd: ROOT });
    } catch (e) {
      selfTestFailed = true;
      selfTestOutput = (e.stdout || '') + (e.stderr || '');
    }
    assert.ok(!selfTestFailed, `M3 展示契约·合成样例：extract-legacy-payload.py --self-test-format 应退出码 0，实际失败，输出：\n${selfTestOutput}`);
    assert.ok(!/\[FAIL\]/.test(selfTestOutput), `M3 展示契约·合成样例：输出不应含 [FAIL]，实际：\n${selfTestOutput}`);
    const passCount = (selfTestOutput.match(/\[PASS\]/g) || []).length;
    assert.strictEqual(passCount, 4, `M3 展示契约·合成样例：应有 4 条 [PASS]（带时间日期/脏日期1970-01-01/空日期null/数字文本整数），实得 ${passCount}`);
    ok(`M3 展示契约·合成样例：extract-legacy-payload.py --self-test-format 子进程 4/4 PASS（带时间日期 + 脏日期1970-01-01 两类真实数据零命中分支，已用合成 pd.Timestamp 单元测试覆盖）`);

    await new Promise((res, rej) => db2.close(e => e ? rej(e) : res()));

    // ── --activate batch #1 ──────────────────────────────
    execFileSync('node', [importScript, '--activate', String(batch1.id), '--db', tmpDbPath], { encoding: 'utf8', cwd: ROOT });
    const db3 = new sqlite3.Database(tmpDbPath);
    const get3 = (sql, params = []) => new Promise((res, rej) => db3.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    const batch1After = await get3(`SELECT status FROM legacy_archive_batches WHERE id = ?`, [batch1.id]);
    assert.strictEqual(batch1After.status, 'active', `--activate 后 batch #1 应为 active，实得 ${batch1After.status}`);
    await new Promise((res, rej) => db3.close(e => e ? rej(e) : res()));
    ok(`--activate batch #${batch1.id} 成功：status=active`);

    // ── 第二次全量导入 + activate → 旧批 retired ──────────────────────────────
    execFileSync('node', [importScript, '--db', tmpDbPath, '--uploads-root', tmpUploadsRoot], { encoding: 'utf8', cwd: ROOT });
    const db4 = new sqlite3.Database(tmpDbPath);
    const all4 = (sql, params = []) => new Promise((res, rej) => db4.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const batchesBeforeActivate2 = await all4(`SELECT id, status FROM legacy_archive_batches ORDER BY id`);
    const batch2 = batchesBeforeActivate2.find(b => b.status === 'verified');
    assert.ok(batch2, `第二次导入应产出一条新的 verified 批次，实得批次列表：${JSON.stringify(batchesBeforeActivate2)}`);
    await new Promise((res, rej) => db4.close(e => e ? rej(e) : res()));

    execFileSync('node', [importScript, '--activate', String(batch2.id), '--db', tmpDbPath], { encoding: 'utf8', cwd: ROOT });
    const db5 = new sqlite3.Database(tmpDbPath);
    const all5 = (sql, params = []) => new Promise((res, rej) => db5.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    const finalBatches = await all5(`SELECT id, status FROM legacy_archive_batches ORDER BY id`);
    await new Promise((res, rej) => db5.close(e => e ? rej(e) : res()));

    const activeOnes = finalBatches.filter(b => b.status === 'active');
    assert.strictEqual(activeOnes.length, 1, `二次 activate 后应恰好 1 条 active，实得 ${activeOnes.length}：${JSON.stringify(finalBatches)}`);
    assert.strictEqual(activeOnes[0].id, batch2.id, `active 批次应为新批次 #${batch2.id}，实得 #${activeOnes[0].id}`);
    const oldBatch = finalBatches.find(b => b.id === batch1.id);
    assert.strictEqual(oldBatch.status, 'retired', `旧批次 #${batch1.id} 应被 retired，实得 ${oldBatch.status}`);
    ok(`第二次全量导入 + activate batch #${batch2.id}：旧批次 #${batch1.id} 自动 retired，恰好 1 条 active（批次隔离场景验证通过）`);

    // 批次隔离佐证：两个批次的图片目录应各自独立存在，互不触碰
    const dir1 = path.join(tmpUploadsRoot, 'legacy-archive', String(batch1.id));
    const dir2 = path.join(tmpUploadsRoot, 'legacy-archive', String(batch2.id));
    assert.ok(fs.existsSync(dir1) && fs.readdirSync(dir1).length > 0, `batch #${batch1.id} 图片目录应仍完整存在`);
    assert.ok(fs.existsSync(dir2) && fs.readdirSync(dir2).length > 0, `batch #${batch2.id} 图片目录应完整存在`);
    ok(`批次图片目录隔离验证：#${batch1.id}（${fs.readdirSync(dir1).length} 文件）与 #${batch2.id}（${fs.readdirSync(dir2).length} 文件）均独立完整，互不触碰`);
  } finally {
    // 临时库产物用后删（纪律：临时库产物放 tmp/ 下用后删）。子进程刚关闭 db 连接后，Windows 上
    // 文件句柄可能有短暂滞留占用（EBUSY/EPERM，对齐 scripts/verify-sys-derive-numbering.js
    // removeWithRetry 既有踩坑范式），带短退避重试而非一击即弃。
    await removeWithRetry(tmpDbPath, { recursive: false });
    await removeWithRetry(tmpUploadsRoot, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== PART 1 · 主场景（:memory: 库，结构断言）===');
  await verifyMainSchema();

  console.log('\n=== PART 1b · 对抗场景（同名不同定义索引 ×3，H2 后 readiness 应判 false，双向证明）===');
  await verifyIndexNoOpTrapBehavior_BatchesActive();
  await verifyIndexNoOpTrapBehavior_DatasetsBatchKey();
  await verifyIndexNoOpTrapBehavior_RowsDatasetRowidx();

  console.log('\n=== PART 1c · 残缺表对照组 ===');
  await verifyMissingColLib();

  console.log('\n=== PART 2 · 临时文件库 + 子进程全链（import + activate + 二次导入）===');
  await verifyFullImportChain();

  // L2：与硬编码的独立期望值对拍，取代此前"分子分母同一变量恒等"的假 N/N。
  let assertionCountOk = true;
  if (passed !== EXPECTED_ASSERTIONS) {
    assertionCountOk = false;
    console.log(
      `\n❌ 断言计数不符：实际执行 ${passed} 条 ok()，期望 ${EXPECTED_ASSERTIONS} 条` +
      '（可能有断言分支被静默跳过，或本文件新增/删除了 ok() 调用点却未同步更新 EXPECTED_ASSERTIONS 常量）'
    );
    process.exitCode = 1;
  } else {
    console.log(`\n[全部通过] ${passed}/${EXPECTED_ASSERTIONS} ✓ 历史台账归档三表 schema 验证通过（真实 initSchema + 真实 import 全链）`);
  }

  // L4：断言全过与"临时产物是否清理干净"解耦判定——前者是正确性，后者是磁盘卫生。断言全过但
  // 清理有残留时，用独立退出码 2（非 0，CI 意义上仍算"红"，但与断言失败的退出码 1 可区分）+
  // 末尾醒目 WARN 块汇总，不再只靠中途一行 console.error（容易被后续输出刷走漏判）。
  if (cleanupWarnings.length > 0) {
    console.log('\n⚠️⚠️⚠️ 临时产物清理未完全生效（需人工核实，断言正确性不受影响）⚠️⚠️⚠️');
    for (const w of cleanupWarnings) console.log(`  - ${w}`);
    console.log(`共 ${cleanupWarnings.length} 项清理失败——请手工确认上述路径已删除（Windows 上偶发同进程句柄滞留，参见 removeWithRetry 注释）。`);
    // 断言计数不符（exitCode=1，正确性问题）优先级高于清理残留（exitCode=2，磁盘卫生问题）——
    // 只在断言计数本身没问题时才用 2，避免真正的正确性问题被磁盘卫生的退出码悄悄盖过去。
    if (assertionCountOk) process.exitCode = 2;
  }
}

// L5（A2 预筛 LOW 留存，A3 当场修）：此前失败时只打 e.message + e.stack——本文件多处
// execFileSync（子进程跑 import-legacy-archive.js / --activate / extract 的 --self-test-format）
// 失败时，Node 会把子进程的 stdout/stderr 挂在错误对象的 .stdout/.stderr 上（execFileSync 用
// {encoding:'utf8'} 调用时两者都是字符串），这是诊断子进程为什么失败最关键的信息——之前完全没打
// 出来，只能看到 Node 侧笼统的"Command failed"，看不到子进程自己打印的失败原因。
main().catch(e => {
  console.error('\n[失败]', e.message);
  if (e && e.stdout) console.error('--- 子进程 stdout ---\n' + e.stdout);
  if (e && e.stderr) console.error('--- 子进程 stderr ---\n' + e.stderr);
  console.error(e.stack);
  process.exit(1);
});
