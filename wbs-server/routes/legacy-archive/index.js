// routes/legacy-archive/index.js — 历史台账归档模块（Phase A2：schema 三表 + readiness 闸门）
//   业务方案 SSOT = docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §3/§6/§7
//   编码范式备忘 = docs/local/历史台账归档/A2-A4_编码范式备忘_20260820.md
//
// ⚠️ A2 范围：只做 initSchema + LEGACY_ARCHIVE_SCHEMA_STATE + requireLegacyArchiveSchemaReady + 三表 DDL。
//   router 是空壳（不注册任何路径）——只读列表/详情/图片端点 + 权限矩阵（方案 §6）留给 A3。
//
// codex 04 号外部审 H2：readiness 从"表+列存在性"升级为最小 schema 合约——三索引结构核验（列组+
//   partial WHERE 标准形）+ batches.status CHECK 四值核验（建表 SQL 文本）+ rows 三列 NOT NULL 位
//   核验（PRAGMA table_info.notnull）。任一不符 → ready=false + error 带"同名错误索引需人工处理"
//   类可操作提示。这让 verify-legacy-archive-schema.js 此前 PART1b 那条"对抗场景下 readiness 仍
//   诚实为 true（记录盲区）"的用例反转为"对抗场景下 readiness 现在应判 false"——盲区已闭合，
//   verify.js 里的断言方向已同步改写（详见该文件注释里的"演进"说明）。
//
// 范式来源（对齐 routes/periodic-fetch/index.js，而非 routes/quick-log/index.js）：
//   - 本模块 schema 建表逻辑内嵌在本文件（不像 quick-log 把 DDL 建在 server.js），
//     导出 { initSchema, router, _internals }；server.js 只需注入 deps + 挂载 + 在 db 连接回调里
//     调一次 initSchema()（照 periodicFetchModule.initSchema() 先例）。
//   - 之所以选这个范式：verify-legacy-archive-schema.js（A2 交付④）需要 require 真实工厂、在
//     :memory: 库上直接调 initSchema()，不依赖 server.js 的 db.serialize() 时序——quick-log 那种
//     "schema 建在 server.js" 的范式做不到这一点（RC-L2 根治：测真实 DDL，不复刻）。
//
// DDL 关键决策（备忘§建表 + 方案 §3.1）：
//   - **不开 PRAGMA foreign_keys**（平台铁律，生产从未开——server.js:1418/:11711 等四处同款注释）：
//     REFERENCES 仅自文档，运行期不做级联/引用完整性校验；FK 定义是否"能被解析"只在
//     verify-legacy-archive-schema.js 测试期临时开 FK 验证（对齐 verify-periodic-schema.js:62 先例）。
//   - 部分唯一索引 `legacy_archive_batches(status) WHERE status='active'` 保证"同一时刻至多 1 个
//     active 批次"（方案 §3.1）——先例 server.js:2096 idx_collab_oa_no_unique。
//   - 索引全部排在三张表建表之后（备忘§建表明文要求），不与各自建表语句交错。
//   - 本模块注入的是 dbRunAsync/dbGetAsync/dbAllAsync（Promise 封装），没有裸 db 对象——因此
//     initSchema 用 async/await 顺序 await 每条 DDL（而非 periodic-fetch 那种 db.serialize()+
//     "最后一条 DDL 回调触发 migration"的回调链范式）。两者效果等价：await 链条本身就是严格串行，
//     且天然在最后一条语句完成后才继续往下走，不存在"PRAGMA 与队列中 CREATE 竞态"的风险
//     （备忘§建表提到的这条铁律，在纯 Promise 顺序 await 下没有对应的坑）。
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (deps) => {
  const REQUIRED_DEPS = [
    'logger', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken', 'requireAdmin', 'UPLOAD_DIR',
  ];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/legacy-archive 缺注入依赖: ' + __k);
  }
  const {
    logger, dbRunAsync, dbGetAsync, dbAllAsync,
    authenticateToken, requireAdmin, UPLOAD_DIR,
  } = deps;
  // A3：authenticateToken/requireAdmin/UPLOAD_DIR 在下方"三、只读端点"消费——中间件顺序统一
  //   authenticateToken → requireAdmin → requireLegacyArchiveSchemaReady（quick-log 先例，admin
  //   前置防 schema 状态泄露给非 admin，见 A2-A4 编码范式备忘§路由与权限）。UPLOAD_DIR 供图片端点
  //   拼 uploads/legacy-archive/<batch_id>/<file> 子树路径校验（照 quick-log 下载端点 D3 范式）。

  const router = express.Router();

  // ============================================================
  // 一、schema readiness state + 关键列锚点常量 + 守门中间件
  // ============================================================
  const LEGACY_ARCHIVE_SCHEMA_STATE = { ready: false, error: null };
  const LEGACY_ARCHIVE_REQUIRED_TABLES = [
    'legacy_archive_batches', 'legacy_archive_datasets', 'legacy_archive_rows',
  ];

  // readiness 是"启动期就绪抽样"（挑代表性关键列，非全字段全量校验——全量校验+CHECK/唯一索引
  //   正反例是 verify-legacy-archive-schema.js 职责，对齐 sys-iteration/periodic-fetch 既有分工）。
  const LEGACY_ARCHIVE_BATCHES_KEY_COLS = [
    'id', 'source_file', 'source_sha256', 'manifest', 'report', 'script_version', 'imported_at', 'status',
  ];
  const LEGACY_ARCHIVE_DATASETS_KEY_COLS = [
    'id', 'batch_id', 'dataset_key', 'display_name', 'columns', 'row_count',
  ];
  const LEGACY_ARCHIVE_ROWS_KEY_COLS = [
    'id', 'dataset_id', 'row_index', 'excel_row', 'data', 'images', 'search_text',
  ];

  // codex 04 号外部审 H2：readiness 从"表+列存在性"升级到最小 schema 合约——索引结构 + CHECK
  // 约束 + NOT NULL 位。三个索引的定义（与下方 initSchema 的 DDL 逐字同源，任一方改动都需同步
  // 改另一方，verify-legacy-archive-schema.js 的 EXPECTED_SCHEMA 常量也需三方同步——三处约定各自
  // 独立维护是有意为之：本文件是"生产实际建了什么"，verify 是"独立预期该是什么"，不让 verify 直接
  // 复用本文件的常量，否则本文件本身写错时 verify 也测不出来）。
  //
  // codex 05 号外部审 M（readiness 比对语义，只落此注释不改比对逻辑）：下方 checkIndexStructure /
  // checkBatchesStatusCheckConstraint 的比对标准是**标准形字面契约**——归一化只做"折叠连续空白 +
  // 首尾 trim + 大小写统一"，不做 SQL 语义等价判定。这意味着"语义等价但书写形式不同"的索引/CHECK
  // 也会被判定为不符（如 `WHERE status = 'active'` 写成 `WHERE 'active' = status`、或用
  // `NOT (status <> 'active')` 表达同一逻辑）——这是刻意的，不是判定过严的疏漏：这类差异只可能
  // 来自人工手改（CREATE UNIQUE INDEX IF NOT EXISTS/CREATE TABLE IF NOT EXISTS 对已存在的同名
  // 对象静默 no-op，正常运行路径不会产出"语义等价但字面不同"的定义），readiness 的职责是尽早
  // 暴露"这里被动过"的信号（判 NOT_READY，503，error 里给出人工核实提示），而不是替代人工去判断
  // "这个改动是否安全"。若未来确有需要识别语义等价写法，应作为独立的、显式声明的功能新增，而不是
  // 悄悄放宽本比对逻辑的判定标准。
  const LEGACY_ARCHIVE_INDEX_DEFS = {
    idx_legacy_archive_batches_active: {
      table: 'legacy_archive_batches', cols: ['status'], partial: true, whereClause: "status='active'",
    },
    idx_legacy_archive_datasets_batch_key: {
      table: 'legacy_archive_datasets', cols: ['batch_id', 'dataset_key'], partial: false,
    },
    idx_legacy_archive_rows_dataset_rowidx: {
      table: 'legacy_archive_rows', cols: ['dataset_id', 'row_index'], partial: false,
    },
  };
  const LEGACY_ARCHIVE_BATCHES_STATUS_VALUES = ['pending', 'verified', 'active', 'retired'];
  const LEGACY_ARCHIVE_ROWS_NOTNULL_COLS = ['dataset_id', 'row_index', 'data'];

  // 守门中间件：A3 全部 legacy-archive 只读端点挂在路由前（对齐 quick-log/periodic-fetch 双态 503 形状）。
  function requireLegacyArchiveSchemaReady(req, res, next) {
    if (LEGACY_ARCHIVE_SCHEMA_STATE.error) {
      return res.status(503).json({
        error: '历史台账归档模块暂不可用：schema 未就绪',
        detail: LEGACY_ARCHIVE_SCHEMA_STATE.error,
        code: 'LEGACY_ARCHIVE_SCHEMA_NOT_READY',
      });
    }
    if (!LEGACY_ARCHIVE_SCHEMA_STATE.ready) {
      return res.status(503).json({
        error: '历史台账归档模块正在初始化，请稍后重试',
        code: 'LEGACY_ARCHIVE_SCHEMA_INITIALIZING',
      });
    }
    next();
  }

  // ============================================================
  // 一.5、H2 结构核验 helper（索引定义串 + CHECK 约束 + NOT NULL 位）
  //   思路复用自 scripts/verify-legacy-archive-schema.js 的 checkIndexStructure（同名不同定义的
  //   `CREATE UNIQUE INDEX IF NOT EXISTS` 会静默 no-op，readiness 若只查列存在性看不见这类问题），
  //   但改造成本模块内可独立调用的函数（走 dbAllAsync/dbGetAsync，不依赖测试脚本的 all/get 签名）。
  // ============================================================
  function normalizeSqlFragment(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async function checkIndexStructure(indexName, expected) {
    const rows = await dbAllAsync(`PRAGMA index_list('${expected.table}')`);
    const row = (rows || []).find(r => r.name === indexName);
    if (!row) return { state: 'missing' };
    if (Number(row.unique) !== 1) return { state: 'non_unique' };

    const problems = [];
    const infoRows = await dbAllAsync(`PRAGMA index_info('${indexName}')`);
    const cols = (infoRows || []).slice().sort((a, b) => a.seqno - b.seqno).map(r => r.name);
    const colsMatch = cols.length === expected.cols.length && cols.every((c, i) => c === expected.cols[i]);
    if (!colsMatch) problems.push(`列组不符（期望 [${expected.cols.join(',')}]，实得 [${cols.join(',')}]）`);

    if (expected.partial) {
      if (Number(row.partial) !== 1) {
        problems.push('非部分索引（缺少 WHERE 限定条件）');
      } else {
        const sqlRow = await dbGetAsync(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
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

  async function checkBatchesStatusCheckConstraint() {
    const sqlRow = await dbGetAsync(`SELECT sql FROM sqlite_master WHERE type='table' AND name='legacy_archive_batches'`);
    const sqlText = (sqlRow && sqlRow.sql) || '';
    const m = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sqlText);
    if (!m) {
      return { ok: false, problem: '未找到 status 列的 CHECK(status IN (...)) 约束（建表 SQL 可能被手工改过）' };
    }
    const actualValues = m[1].split(',').map(s => s.trim().replace(/^'(.*)'$/, '$1'));
    const actualSet = new Set(actualValues);
    const expectedSet = new Set(LEGACY_ARCHIVE_BATCHES_STATUS_VALUES);
    const missing = LEGACY_ARCHIVE_BATCHES_STATUS_VALUES.filter(v => !actualSet.has(v));
    const extra = actualValues.filter(v => !expectedSet.has(v));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        problem: `CHECK 值集合不符（期望 [${LEGACY_ARCHIVE_BATCHES_STATUS_VALUES.join(',')}]，实得 [${actualValues.join(',')}]）`,
      };
    }
    // codex 05 号外部审 M（CHECK 计数）：missing/extra 两个集合差分都为空只证明"值集合覆盖一致"，
    // 防不住 IN 列表里有重复值这种形态（如 status IN ('pending','pending','verified','active',
    // 'retired')——4 个期望值都在，集合差分两边都是空，但原始列表 5 项，多出的重复值不会被
    // missing/extra 抓到）。补一条长度核验堵上这个形态。
    if (actualValues.length !== LEGACY_ARCHIVE_BATCHES_STATUS_VALUES.length) {
      return {
        ok: false,
        problem: `CHECK 值列表长度不符（期望 ${LEGACY_ARCHIVE_BATCHES_STATUS_VALUES.length} 项，实得 ${actualValues.length} 项：[${actualValues.join(',')}]，疑似含重复值）`,
      };
    }
    return { ok: true };
  }

  async function checkRowsNotNullColumns() {
    const cols = await dbAllAsync(`PRAGMA table_info(legacy_archive_rows)`);
    const problems = [];
    for (const colName of LEGACY_ARCHIVE_ROWS_NOTNULL_COLS) {
      const col = (cols || []).find(c => c.name === colName);
      if (!col) { problems.push(`${colName} 列不存在`); continue; }
      if (Number(col.notnull) !== 1) problems.push(`${colName} 未设 NOT NULL`);
    }
    return problems;
  }

  // ============================================================
  // 二、DDL（三表 + 索引，方案 §3.1）
  // ============================================================
  async function initSchema() {
    let ddlError = null;
    const runDdl = async (label, sql) => {
      try {
        await dbRunAsync(sql);
      } catch (err) {
        if (!ddlError) {
          ddlError = `${label}: ${err.message}`;
          logger.error(`[历史台账归档] DDL 失败 @${label}：${err.message}`);
        }
      }
    };

    // ── 2.1 三张表（先全部建表，索引统一放最后一段，备忘§建表明文要求）──────────
    await runDdl('CREATE legacy_archive_batches', `CREATE TABLE IF NOT EXISTS legacy_archive_batches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file     TEXT NOT NULL,
      source_sha256   TEXT NOT NULL,
      manifest        TEXT NOT NULL,
      report          TEXT,
      script_version  TEXT NOT NULL,
      imported_at     DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','active','retired'))
    )`);

    await runDdl('CREATE legacy_archive_datasets', `CREATE TABLE IF NOT EXISTS legacy_archive_datasets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id      INTEGER NOT NULL REFERENCES legacy_archive_batches(id),
      dataset_key   TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      columns       TEXT NOT NULL,
      row_count     INTEGER NOT NULL
    )`);

    // row_index/excel_row 均为数据区序号/原始 Excel 行号；excel_row 未列入方案 §3.1"非空"清单
    //   （该清单只明文 dataset_id/row_index/data），本表未对其加 NOT NULL——即便导入脚本实际上
    //   总会填值，schema 层按方案字面口径走，不做超出字面的额外约束（A2 交付报告已单独标注此点）。
    await runDdl('CREATE legacy_archive_rows', `CREATE TABLE IF NOT EXISTS legacy_archive_rows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id   INTEGER NOT NULL REFERENCES legacy_archive_datasets(id),
      row_index    INTEGER NOT NULL,
      excel_row    INTEGER,
      data         TEXT NOT NULL,
      images       TEXT,
      search_text  TEXT
    )`);

    // ── 2.2 索引（严格排在三张表建表之后）──────────
    //   ≤1 active 批次：部分唯一索引（先例 server.js:2096 idx_collab_oa_no_unique）。
    await runDdl(
      'CREATE idx_legacy_archive_batches_active',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_archive_batches_active
         ON legacy_archive_batches(status) WHERE status='active'`
    );
    await runDdl(
      'CREATE idx_legacy_archive_datasets_batch_key',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_archive_datasets_batch_key
         ON legacy_archive_datasets(batch_id, dataset_key)`
    );
    await runDdl(
      'CREATE idx_legacy_archive_rows_dataset_rowidx',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_archive_rows_dataset_rowidx
         ON legacy_archive_rows(dataset_id, row_index)`
    );

    await runLegacyArchiveMigration(ddlError);
  }

  // ── schema 就绪探测（全新模块，无 ALTER；对齐 periodic-fetch runPeriodicMigration）─────────────────
  async function runLegacyArchiveMigration(ddlError) {
    try {
      LEGACY_ARCHIVE_SCHEMA_STATE.ready = false;

      if (ddlError) {
        LEGACY_ARCHIVE_SCHEMA_STATE.error = `建表 DDL 失败：${ddlError}`;
        logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
        return;
      }

      // [1] 三表存在性
      const tables = (await dbAllAsync(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
        "('legacy_archive_batches','legacy_archive_datasets','legacy_archive_rows')"
      )).map(r => r.name);
      const missingTables = LEGACY_ARCHIVE_REQUIRED_TABLES.filter(t => !tables.includes(t));
      if (missingTables.length > 0) {
        LEGACY_ARCHIVE_SCHEMA_STATE.error = `历史台账归档表缺失：${missingTables.join(',')}`;
        logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
        return;
      }

      // [2] 三表关键列 PRAGMA 复查
      const checks = [
        ['legacy_archive_batches', LEGACY_ARCHIVE_BATCHES_KEY_COLS],
        ['legacy_archive_datasets', LEGACY_ARCHIVE_DATASETS_KEY_COLS],
        ['legacy_archive_rows', LEGACY_ARCHIVE_ROWS_KEY_COLS],
      ];
      for (const [tbl, keyCols] of checks) {
        const cols = await dbAllAsync(`PRAGMA table_info(${tbl})`);
        if (!cols || cols.length === 0) {
          LEGACY_ARCHIVE_SCHEMA_STATE.error = `无法读取 ${tbl} 表结构（PRAGMA 失败）`;
          logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error}`);
          return;
        }
        const colNames = cols.map(c => c.name);
        const missingCols = keyCols.filter(c => !colNames.includes(c));
        if (missingCols.length > 0) {
          LEGACY_ARCHIVE_SCHEMA_STATE.error = `${tbl} 关键列缺失：${missingCols.join(',')}`;
          logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
          return;
        }
      }

      // [3]（codex 04 号外部审 H2）三个索引结构核验——列组 + partial WHERE 标准形，归一化空白后
      //   比对。CREATE UNIQUE INDEX IF NOT EXISTS 对同名索引静默 no-op 是已知坑（备忘§建表），
      //   readiness 若只查列存在性对这类问题完全"视而不见"；这里补上独立结构核验层。
      for (const [indexName, expected] of Object.entries(LEGACY_ARCHIVE_INDEX_DEFS)) {
        const check = await checkIndexStructure(indexName, expected);
        if (check.state !== 'ok') {
          const detail = check.problems ? check.problems.join('；') : check.state;
          LEGACY_ARCHIVE_SCHEMA_STATE.error =
            `索引 ${indexName} 结构不符（${detail}）——同名错误索引需人工处理：` +
            `CREATE UNIQUE INDEX IF NOT EXISTS 对同名索引静默 no-op 不会自动纠正，` +
            `需人工核实后手动 DROP INDEX ${indexName} 再重启服务重建`;
          logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
          return;
        }
      }

      // [4] batches.status CHECK 约束四值核验（建表 SQL 文本核验——SQLite 无 PRAGMA 暴露 CHECK 内容）。
      const checkResult = await checkBatchesStatusCheckConstraint();
      if (!checkResult.ok) {
        LEGACY_ARCHIVE_SCHEMA_STATE.error =
          `legacy_archive_batches.status CHECK 约束不符（${checkResult.problem}）——需人工核实建表 SQL 是否被手工改动`;
        logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
        return;
      }

      // [5] rows 三列 NOT NULL 位核验（PRAGMA table_info.notnull）。
      const notNullProblems = await checkRowsNotNullColumns();
      if (notNullProblems.length > 0) {
        LEGACY_ARCHIVE_SCHEMA_STATE.error =
          `legacy_archive_rows NOT NULL 约束不符：${notNullProblems.join('；')}——需人工核实建表 SQL 是否被手工改动`;
        logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error} → legacy-archive 接口将返 503`);
        return;
      }

      // [6] 全部就位 → 置 ready
      LEGACY_ARCHIVE_SCHEMA_STATE.error = null;
      LEGACY_ARCHIVE_SCHEMA_STATE.ready = true;
      logger.info(
        `[历史台账归档] ✅ 三表就绪（${tables.length}/3 表 + 关键列锚点齐全 + 三索引结构核验通过 + ` +
        `status CHECK 四值齐全 + rows 三列 NOT NULL 到位），legacy-archive 接口放行。`
      );
    } catch (e) {
      LEGACY_ARCHIVE_SCHEMA_STATE.ready = false;
      LEGACY_ARCHIVE_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
      logger.error(`[历史台账归档] 🚫 ${LEGACY_ARCHIVE_SCHEMA_STATE.error}`);
    }
  }

  // ============================================================
  // 三、只读端点（A3·方案 §5/§6/§7）
  //   中间件顺序统一：authenticateToken → requireAdmin → requireLegacyArchiveSchemaReady
  //   （A2-A4 编码范式备忘§路由与权限：admin 前置防 schema 未就绪状态泄露给非 admin）。
  //   全部只读当前 active 批次（status='active'，部分唯一索引保证至多一条）。
  // ============================================================

  // 图片文件名白名单（方案 §6 权限矩阵·与 import-legacy-archive.js 的 IMAGE_FILENAME_PATTERN
  //   逐字同源——两处独立维护是有意为之：导入侧落盘前校验、本侧读取前再校验，任一方改错不会互相掩盖）。
  const IMAGE_FILENAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
  const LEGACY_ARCHIVE_IMAGES_BASE = path.join(UPLOAD_DIR, 'legacy-archive');
  // 源文件（原始 xlsx）存放目录：uploads/legacy-archive/source/——与 <batchId>（纯数字）图片目录
  // 同层不冲突；不进 git（uploads 运行时资产），部署时随源文件收口手动放置。
  const LEGACY_ARCHIVE_SOURCE_DIR = path.join(LEGACY_ARCHIVE_IMAGES_BASE, 'source');
  // L2（本轮当场修）：mime 二次白名单常量提到模块作用域（避免每次请求重建 Set），与图片端点内的
  // 使用处注释互相呼应——正常写入路径只产出这五种值（extract-legacy-payload.py sniff_ext_mime 的
  // 输出域），不在集合内一律回退 octet-stream。
  const IMAGE_MIME_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'application/octet-stream']);

  function isPositiveIntStr(v) {
    return typeof v === 'string' && /^[1-9]\d*$/.test(v);
  }

  // LIKE 关键词转义（对齐 routes/quick-log/index.js escapeLikeKeyword：% _ \ 三字符转义）。
  function escapeLikeKeyword(s) {
    return String(s || '').replace(/[\\%_]/g, m => '\\' + m);
  }

  function safeJsonParse(text, fallback) {
    if (text === null || text === undefined) return fallback;
    try { return JSON.parse(text); } catch (_) { return fallback; }
  }

  // ── ① 数据集清单：GET /legacy-archive/datasets ──────────────────────────────
  //   无 active 批次 → 200 {datasets:[], notice:'暂无活动归档批次'}（方案 §7 定义杂项）。
  router.get('/legacy-archive/datasets', authenticateToken, requireAdmin, requireLegacyArchiveSchemaReady, async (req, res) => {
    try {
      const batch = await dbGetAsync(`SELECT * FROM legacy_archive_batches WHERE status = 'active'`);
      if (!batch) {
        return res.json({ datasets: [], notice: '暂无活动归档批次' });
      }
      const dsRows = await dbAllAsync(
        `SELECT dataset_key, display_name, row_count FROM legacy_archive_datasets WHERE batch_id = ? ORDER BY id ASC`,
        [batch.id]
      );
      const manifestObj = safeJsonParse(batch.manifest, {});
      res.json({
        datasets: dsRows || [],
        batch: {
          id: batch.id,
          source_file: batch.source_file,
          // 前 8 位（方案 §5 页顶横幅要求），完整值不对外——已够核对，不需要暴露全长哈希。
          source_sha256_short: String(batch.source_sha256 || '').slice(0, 8),
          imported_at: batch.imported_at,
          script_version: batch.script_version,
          cutoff: manifestObj.cutoff || null,
        },
      });
    } catch (err) {
      // M2（外部 codex 07 审）：不回 err.message 给客户端——SQLite 原文/表名/SQL 片段只落日志，
      // 客户端只拿到通用错误壳（历史台账归档全模块 4 端点统一，防内部实现细节经报错信息外泄）。
      logger.error('[历史台账归档] 数据集清单查询失败:', err.message);
      res.status(500).json({ error: '查询失败', code: 'QUERY_FAILED' });
    }
  });

  // ── ② 行分页：GET /legacy-archive/datasets/:key/rows?page=&pageSize=&q=&sort=&dir= ──
  //   默认 row_index ASC（原表行序）；sort/dir 可选列排序（见下方排序段注释）；
  //   pageSize 默认50上限200（越界钳制）；q 服务端 search_text LIKE。
  //   未知 :key → 404；越界页 → 空 rows + 真实 total（方案 §7）。
  router.get('/legacy-archive/datasets/:key/rows', authenticateToken, requireAdmin, requireLegacyArchiveSchemaReady, async (req, res) => {
    try {
      const batch = await dbGetAsync(`SELECT id FROM legacy_archive_batches WHERE status = 'active'`);
      if (!batch) {
        return res.status(404).json({ error: '数据集不存在（当前无活动归档批次）', code: 'LEGACY_ARCHIVE_DATASET_NOT_FOUND' });
      }
      const dataset = await dbGetAsync(
        `SELECT id, columns FROM legacy_archive_datasets WHERE batch_id = ? AND dataset_key = ?`,
        [batch.id, req.params.key]
      );
      if (!dataset) {
        return res.status(404).json({ error: '数据集不存在', code: 'LEGACY_ARCHIVE_DATASET_NOT_FOUND' });
      }
      const columns = safeJsonParse(dataset.columns, []);
      const listColumns = columns
        .filter(c => c && c.visibility === 'list')
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

      let page = parseInt(req.query.page, 10);
      if (!Number.isInteger(page) || page < 1) page = 1;
      // L1（Opus 预筛留存，本轮当场修）：page 此前只钳下界不钳上界——parseInt 对超长数字串（如
      // "99999999999999999999"）会产出一个仍满足 Number.isInteger 的巨大有限浮点值（IEEE754 在这个
      // 量级已无法表示小数部分，恒被判定为"整数"），一路乘进 offset = (page-1)*pageSize 后可能突破
      // Number.MAX_SAFE_INTEGER 甚至 SQLite 64 位整数范围，把 sqlite3 驱动/SQLite 自身抛出的原始报错
      // 文本经 catch 块的 `err.message` 透传给客户端（内部实现细节泄露，且非预期 500）。加一道上界
      // 钳制——PAGE_MAX 远超本模块任何 dataset 的真实行数上限（最大 8232 行），钳完仍落在"越界页"
      // 语义内（空 rows + 真实 total，方案 §7 既定行为），不改变任何合法请求的观感。
      const PAGE_MAX = 1000000000; // 1e9：offset 上限 = (1e9-1)*200 ≈ 2e11，远低于 Number.MAX_SAFE_INTEGER(≈9e15)
      if (page > PAGE_MAX) page = PAGE_MAX;
      let pageSize = parseInt(req.query.pageSize, 10);
      if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 50;
      if (pageSize > 200) pageSize = 200;

      // ── 排序（2026-08-22 需求变更：全字段列排序；此前方案 §7 冻结"固定 row_index ASC"）──
      //   sort 合法值：'_row'（原表行号）/ '_images'（图片数）/ 本 dataset listColumns 中的 fNNN 键。
      //   dir：'asc' | 'desc'。两参数省略时保持原契约（row_index ASC 原表行序，零行为变化）。
      //   非法值走 400 显式拒绝（枚举参数拼错即前端 bug，静默回默认序会掩盖；同"未知 :key→404"
      //   的显式报错家族），不套 page/pageSize 的钳制语义——钳制是把合法类型的越界值拉回边界，
      //   排序键没有"最近的合法值"可钳。
      //   注入面：fNNN 先过 /^f\d{3}$/ 再过 listColumns 成员校验才进 SQL 拼接；dir 白名单枚举后
      //   映射为常量 'ASC'/'DESC'——ORDER BY 无用户原文拼接。
      //   fNNN 排序值取 json_extract（data 列 JSON 原生类型：数字列按数值序、文本列按 BINARY 序）。
      //   混合类型列按 SQLite 存储类型分组排序（NULL<数字<文本<BLOB，即数字整体先于文本）——这是
      //   本端点的显式排序契约（codex 17 MED-2 登记：不做 CAST 归一，文本 CAST 数字会产生更违直觉
      //   的 0 值聚堆；列元数据无类型标注，源表本就允许"序号列混入文本"形态）。
      //   空值恒沉底（IS NULL 前置键），并以 row_index ASC 作稳定二级序（同值行保持原表相对顺序）。
      //   json_valid 守卫（codex 17 MED-1 采纳）：data/images 由导入脚本 JSON.stringify 写入、
      //   理论上恒合法，但 json_extract/json_array_length 对损坏 JSON 会抛 SQLite 异常→整个排序
      //   请求 500；CASE 守卫让损坏行按 NULL/0 参与排序（功能降级不炸端点），纵深防御同 images
      //   端点 mime 二次白名单先例。
      const sortRaw = req.query.sort;
      const dirRaw = req.query.dir;
      let orderSql = 'ORDER BY row_index ASC';
      if (sortRaw !== undefined || dirRaw !== undefined) {
        if (dirRaw !== undefined && dirRaw !== 'asc' && dirRaw !== 'desc') {
          return res.status(400).json({ error: 'dir 仅支持 asc/desc', code: 'INVALID_SORT_DIR' });
        }
        const sqlDir = dirRaw === 'desc' ? 'DESC' : 'ASC';
        if (sortRaw === undefined || sortRaw === '_row') {
          orderSql = `ORDER BY row_index ${sqlDir}`;
        } else if (sortRaw === '_images') {
          orderSql = `ORDER BY (CASE WHEN images IS NOT NULL AND json_valid(images) THEN json_array_length(images) ELSE 0 END) ${sqlDir}, row_index ASC`;
        } else if (typeof sortRaw === 'string' && /^f\d{3}$/.test(sortRaw) && listColumns.some(c => c.field === sortRaw)) {
          const sortExpr = `(CASE WHEN json_valid(data) THEN json_extract(data, '$.${sortRaw}') END)`;
          orderSql = `ORDER BY (${sortExpr} IS NULL) ASC, ${sortExpr} ${sqlDir}, row_index ASC`;
        } else {
          return res.status(400).json({ error: 'sort 不是本数据集的合法排序键', code: 'INVALID_SORT' });
        }
      }

      const where = ['dataset_id = ?'];
      const params = [dataset.id];
      const qRaw = req.query.q;
      if (typeof qRaw === 'string' && qRaw.trim()) {
        where.push(`search_text LIKE ? ESCAPE '\\'`);
        params.push('%' + escapeLikeKeyword(qRaw.trim().toLowerCase()) + '%');
      }
      const whereSql = 'WHERE ' + where.join(' AND ');

      const totalRow = await dbGetAsync(`SELECT COUNT(*) AS c FROM legacy_archive_rows ${whereSql}`, params);
      const total = totalRow ? totalRow.c : 0;
      const offset = (page - 1) * pageSize;

      const rowsRaw = await dbAllAsync(
        `SELECT id, row_index, excel_row, data, images FROM legacy_archive_rows ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      const rows = (rowsRaw || []).map(r => {
        const parsedData = safeJsonParse(r.data, {});
        const projected = {};
        for (const c of listColumns) projected[c.field] = parsedData[c.field] !== undefined ? parsedData[c.field] : null;
        const images = safeJsonParse(r.images, []);
        return {
          id: r.id,
          row_index: r.row_index,
          excel_row: r.excel_row,
          data: projected,
          image_count: Array.isArray(images) ? images.length : 0,
          first_image: (Array.isArray(images) && images[0] && images[0].file) ? images[0].file : null,
        };
      });

      res.json({
        total,
        page,
        pageSize,
        columns: listColumns.map(c => ({ field: c.field, name: c.name, display_order: c.display_order })),
        rows,
      });
    } catch (err) {
      logger.error('[历史台账归档] 行分页查询失败:', err.message);
      res.status(500).json({ error: '查询失败', code: 'QUERY_FAILED' });
    }
  });

  // ── ③ 行详情：GET /legacy-archive/rows/:id ────────────────────────────────
  //   非纯数字 id → 400；不存在或不属 active 批次 → 404（方案 §7）。
  router.get('/legacy-archive/rows/:id', authenticateToken, requireAdmin, requireLegacyArchiveSchemaReady, async (req, res) => {
    if (!isPositiveIntStr(req.params.id)) {
      return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    try {
      const row = await dbGetAsync(
        `SELECT r.id, r.row_index, r.excel_row, r.data, r.images, d.dataset_key, d.columns
           FROM legacy_archive_rows r
           JOIN legacy_archive_datasets d ON r.dataset_id = d.id
           JOIN legacy_archive_batches b ON d.batch_id = b.id
          WHERE r.id = ? AND b.status = 'active'`,
        [req.params.id]
      );
      if (!row) {
        return res.status(404).json({ error: '记录不存在或不属于当前活动批次', code: 'LEGACY_ARCHIVE_ROW_NOT_FOUND' });
      }
      res.json({
        id: row.id,
        dataset_key: row.dataset_key,
        row_index: row.row_index,
        excel_row: row.excel_row,
        data: safeJsonParse(row.data, {}),
        columns: safeJsonParse(row.columns, []),
        images: safeJsonParse(row.images, []),
      });
    } catch (err) {
      logger.error('[历史台账归档] 行详情查询失败:', err.message);
      res.status(500).json({ error: '查询失败', code: 'QUERY_FAILED' });
    }
  });

  // ── ④ 图片（inline 展示，非下载）：GET /legacy-archive/images/:batchId/:file ──
  //   顺序（方案 §6）：batchId 纯数字 400 → 必须是 active 批次 404 → :file 白名单 400 →
  //   必须命中该批次某行 images 记录（防拼路径）404 → 子树路径校验 403 → 文件不存在 404 → 流式返回。
  router.get('/legacy-archive/images/:batchId/:file', authenticateToken, requireAdmin, requireLegacyArchiveSchemaReady, async (req, res) => {
    const { batchId, file } = req.params;
    if (!isPositiveIntStr(batchId)) {
      return res.status(400).json({ error: 'batchId 必须是正整数', code: 'INVALID_BATCH_ID' });
    }
    try {
      const batch = await dbGetAsync(`SELECT id FROM legacy_archive_batches WHERE id = ? AND status = 'active'`, [batchId]);
      if (!batch) {
        return res.status(404).json({ error: '批次不存在或不是当前活动批次', code: 'LEGACY_ARCHIVE_BATCH_NOT_FOUND' });
      }
      if (!IMAGE_FILENAME_PATTERN.test(file || '')) {
        return res.status(400).json({ error: '非法文件名', code: 'INVALID_FILE_NAME' });
      }

      // L3（本轮当场修·文档化留存）：命中校验用 images JSON 文本 LIKE 该文件名的 "file":"<file>"
      // 精确片段（比裸子串 LIKE 更精确——白名单已排除引号/反斜杠，不会被文件名本身破坏该片段结构）。
      // 这条 LIKE 依赖 images 列存的是**紧凑形 JSON**（键值间无多余空白，`JSON.stringify` 默认输出、
      // 与 import-legacy-archive.js 落库时的序列化方式一致）——若该列未来被改写为带空格的 pretty
      // JSON（如 `"file": "x.png"` 冒号后带空格），本 LIKE 片段会匹配不上，导致合法图片被误判 404。
      // 这是 fail-closed 方向（少判成"存在"不会漏判成"不存在"，不会引发安全问题，只是功能性误伤），
      // 可接受，不在本轮改动范围内——留痕供未来若真要改存储格式时的排查线索。
      const escFile = escapeLikeKeyword(file);
      const hitRow = await dbGetAsync(
        `SELECT r.images FROM legacy_archive_rows r
           JOIN legacy_archive_datasets d ON r.dataset_id = d.id
          WHERE d.batch_id = ? AND r.images LIKE ? ESCAPE '\\'
          LIMIT 1`,
        [batchId, '%"file":"' + escFile + '"%']
      );
      if (!hitRow) {
        return res.status(404).json({ error: '图片未被任何行引用', code: 'LEGACY_ARCHIVE_IMAGE_NOT_FOUND' });
      }

      // L2（本轮当场修）：mime 二次白名单——不再直接信任 db 里 images[].mime 字段的任意字符串值。
      // 正常写入路径只可能产出这五种值之一（extract-legacy-payload.py 的 sniff_ext_mime 按内容魔数
      // 判定，覆盖 png/jpeg/gif/bmp 四种已知格式 + 兜底 octet-stream），但 db 记录理论上可被绕过
      // 正常导入链路直接写入（如未来某处新增写路径疏漏了校验），届时若 mime 字段被写成非常规值
      // （如 `text/html`），直接透传给 Content-Type 有被浏览器当作可执行内容误解析的风险——收窄到
      // 白名单集合，不在集合内一律回退 octet-stream（比"任意字符串直传"更收紧的纵深防御）。
      let mime = 'application/octet-stream';
      const imgs = safeJsonParse(hitRow.images, []);
      const found = Array.isArray(imgs) ? imgs.find(im => im && im.file === file) : null;
      if (found && typeof found.mime === 'string' && IMAGE_MIME_ALLOWLIST.has(found.mime)) mime = found.mime;

      const base = path.resolve(path.join(LEGACY_ARCHIVE_IMAGES_BASE, String(batchId)));
      const absPath = path.resolve(base, file);
      const within = (absPath === base) || absPath.startsWith(base + path.sep);
      if (!within) {
        logger.warn(`[历史台账归档] 图片路径越界拦截: batchId=${batchId} file=${file}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: '图片文件不存在', code: 'FILE_NOT_FOUND' });
      }

      // H2（外部 codex 07 审·本轮当场修）：读取端防符号链接/junction 纵深防御——上面的"子树内"
      // 校验只是字符串前缀比较（path.resolve 不解引用链接），若 batchDir 内万一混入一个文件名匹配
      // 白名单、且已被 images 记录命中的符号链接/Windows 目录联接（junction），指向子树外的任意路径，
      // 前面两道检查（within 前缀 + existsSync）都会照常放行——existsSync 对链接会跟随解析，只要
      // 链接指向的目标存在就返回 true。这里额外用 lstatSync（不跟随链接，真实反映"这个路径节点本身
      // 是什么"）校验绝对路径必须是普通文件且非符号链接，命中即 403（复用 ILLEGAL_FILE_PATH 语义——
      // 都是"这个路径不该被当作合法图片文件处理"这一类判定）。正常路径下 batchDir 内不会出现链接
      // （import-legacy-archive.js 的 copyBatchImages 在源端已用 lstatSync 拒绝 symlink 源文件，见该
      // 函数注释），这里是读取端的第二重独立防线，不依赖写入端那道防线不失守。
      const absStat = fs.lstatSync(absPath);
      if (!absStat.isFile() || absStat.isSymbolicLink()) {
        logger.warn(`[历史台账归档] 图片读取端拦截非普通文件/符号链接: batchId=${batchId} file=${file}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }

      // L2：nosniff——即便 Content-Type 判定有误，也不让浏览器自作主张按内容嗅探成别的 MIME 类型
      // （防御同一漏洞类的"MIME 混淆触发脚本执行"变体，纵深防御，与上方 mime 白名单互补不重复）。
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'inline');
      const stream = fs.createReadStream(absPath);
      stream.on('error', (streamErr) => {
        logger.error(`[历史台账归档] 图片流式读取失败: ${streamErr.message}`);
        if (!res.headersSent) res.status(500).json({ error: '图片读取失败' });
      });
      stream.pipe(res);
    } catch (err) {
      logger.error('[历史台账归档] 图片端点失败:', err.message);
      if (!res.headersSent) res.status(500).json({ error: '查询失败', code: 'QUERY_FAILED' });
    }
  });

  // ── ⑤ 源文件下载：GET /legacy-archive/source-file（2026-08-22 增·随 D4 源文件收口）────
  //   语义：下载"当前 active 批次"的原始 xlsx（供与归档页数据比对核验）。文件名不硬编码——
  //   从 batches.source_file 取（未来重导新批次换源文件自动跟随），物理位置固定
  //   uploads/legacy-archive/source/<source_file>（/uploads 直连已被独立中间件 403，本端点是
  //   该文件唯一 HTTP 出口，authenticateToken+requireAdmin 与其余四端点同权限矩阵）。
  //   安全面（对齐图片端点纵深）：source_file 来自库内导入脚本写入（非用户输入），仍按不可信
  //   处理——basename 恒等校验拒路径成分 + NUL 拒绝 + resolve 子树前缀 + lstat 拒链接/非普通文件。
  router.get('/legacy-archive/source-file', authenticateToken, requireAdmin, requireLegacyArchiveSchemaReady, async (req, res) => {
    try {
      const batch = await dbGetAsync(`SELECT id, source_file, source_sha256 FROM legacy_archive_batches WHERE status = 'active'`);
      if (!batch) {
        return res.status(404).json({ error: '当前无活动归档批次', code: 'LEGACY_ARCHIVE_BATCH_NOT_FOUND' });
      }
      const name = batch.source_file;
      if (typeof name !== 'string' || !name.trim() || name.includes('\0')
        || path.basename(name) !== name || name === '.' || name === '..') {
        logger.warn(`[历史台账归档] 源文件名非法（库内值含路径成分/NUL）: ${JSON.stringify(name)}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      const base = path.resolve(LEGACY_ARCHIVE_SOURCE_DIR);
      const absPath = path.resolve(base, name);
      const within = absPath !== base && absPath.startsWith(base + path.sep);
      if (!within) {
        logger.warn(`[历史台账归档] 源文件路径越界拦截: ${name}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: '源文件不存在（未随部署放置到 uploads/legacy-archive/source/）', code: 'SOURCE_FILE_NOT_FOUND' });
      }
      const absStat = fs.lstatSync(absPath);
      if (!absStat.isFile() || absStat.isSymbolicLink()) {
        logger.warn(`[历史台账归档] 源文件读取端拦截非普通文件/符号链接: ${name}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Length', String(absStat.size));
      // RFC 5987 filename*：中文文件名跨浏览器兜底（filename= 用 ASCII 占位）。
      // codex 17 LOW 采纳：encodeURIComponent 不转 '()* 四字符，但 RFC 5987 attr-char 集合
      // 不含 ' 和 *（( ) 属 attr-char 但部分客户端解析器同样吃不消）——统一补percent 编码。
      const rfc5987Name = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      res.setHeader('Content-Disposition', `attachment; filename="legacy-archive-source.xlsx"; filename*=UTF-8''${rfc5987Name}`);
      if (batch.source_sha256) res.setHeader('X-Source-SHA256', String(batch.source_sha256));
      const stream = fs.createReadStream(absPath);
      stream.on('error', (streamErr) => {
        logger.error(`[历史台账归档] 源文件流式读取失败: ${streamErr.message}`);
        if (!res.headersSent) res.status(500).json({ error: '源文件读取失败' });
      });
      stream.pipe(res);
    } catch (err) {
      logger.error('[历史台账归档] 源文件端点失败:', err.message);
      if (!res.headersSent) res.status(500).json({ error: '查询失败', code: 'QUERY_FAILED' });
    }
  });

  const _internals = {
    LEGACY_ARCHIVE_SCHEMA_STATE,
    LEGACY_ARCHIVE_REQUIRED_TABLES,
    LEGACY_ARCHIVE_BATCHES_KEY_COLS,
    LEGACY_ARCHIVE_DATASETS_KEY_COLS,
    LEGACY_ARCHIVE_ROWS_KEY_COLS,
    LEGACY_ARCHIVE_INDEX_DEFS,
    LEGACY_ARCHIVE_BATCHES_STATUS_VALUES,
    LEGACY_ARCHIVE_ROWS_NOTNULL_COLS,
    runLegacyArchiveMigration,
    requireLegacyArchiveSchemaReady,
    checkIndexStructure,
    checkBatchesStatusCheckConstraint,
    checkRowsNotNullColumns,
    // A3：只读端点内部 helper，供 verify 脚本静态/单元核验（非必需但保留供未来复用）。
    IMAGE_FILENAME_PATTERN,
    isPositiveIntStr,
    escapeLikeKeyword,
  };

  return { initSchema, router, _internals };
};
