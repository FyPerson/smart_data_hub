// 验证脚本：系统迭代·先行上线两步化 S1 — sys_fast_release_executors 数据层地基
//   方案 SSOT = docs/local/系统迭代/先行上线两步化_方案_20260813_v1.8.md §3（表结构）/ §4-10（统一谓词）
//   用法：node scripts/verify-sys-fastlane-two-phase.js
//
// 范围声明：本阶段（S1）是纯 schema commit——不接线端点/业务流转/通知，只落地表结构 + 索引 + 两处注册
//   （SYS_REQUIRED_TABLES 表在 / checks 列全）+ DELETE 级联一行 + 统一谓词常量（零消费点，S2 起消费）。
//   本文件只做 SQL 直调断言（RC-L2 范式：require 真实 routes/sys-iteration 工厂，测真实 initSchema() 建表，
//   非复刻一份 DDL），不含 HTTP 层用例——本表当前无任何 HTTP 端点，无 HTTP 覆盖面。
//   ⚠️ 已知坑（同 verify-sys-fastrelease-auth.js 头部注释）：routes/sys-iteration 工厂在同一进程内
//   二次实例化会 init 挂起（进程级单例状态·测试基建限制）。本文件全程只实例化一次，不触及该坑，
//   故不需要 _probe-fastlane-gate-disabled.js 那种子进程隔离手法。
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [1] schema 断言：表存在 / 12 列全（逐列名核对）/ 两索引存在且 partial UNIQUE 的 WHERE 谓词正确
//       （查 sqlite_master.sql 文本）/ SYS_REQUIRED_TABLES 含本表名 / checks 含本表键列（源码文本断言，
//       见 [1g] 注释——不走"另建残缺库跑真实 initSchema()"，避免同进程二次实例化坑）/ 统一谓词常量字面量正确
//   [2] CHECK①（软删三列成组）成对：合法整行 INSERT 成功；软删三列只填其一必拒
//   [3] CHECK②（执行态成组）成对：done+合法 executed_at 成功；done+NULL 必拒；pending+非空 executed_at 必拒；
//       done+非法格式时间（datetime() 解析失败）必拒
//   [4] CHECK③（双参 trim 非空）成对：正常名成功；user_name 纯空格必拒；user_name 纯 Tab/换行必拒
//       （专钉双参 trim）；added_by_name 同款抽一条
//   [5] partial UNIQUE 成对：同 (issue_id,user_id) 未软删重插必拒；软删旧行后同人重插成功（代次语义）
//   [6]（S1 收口批·Opus 预筛 L8 新增）issue_id CHECK (issue_id > 0) 成对：issue_id=0/负数均必拒
//       （与同表 user_id/added_by 对称加固；正例复用本文件其余全部用例，不单独再插）
//   [7]（codex 382-M2 新增）typeof 整数钳制成对：issue_id='abc'/user_id=1.5/added_by='0x1'/
//       removed_by='xyz' 均必拒（裸 > 0 判断被 TEXT/REAL 穿透的实测坑，见 2.13 段 DDL 该 CHECK 旁注）；
//       正例复用 [2]-[6] 全部已用正整数路径（均成功），不单独再插
//   [8]（codex 382-M3 新增）子进程活体探针：预建缺 exec_status 列的残缺表 → 走真实工厂 initSchema() →
//       断言 readiness=false 且 error 文本点名表名+缺列名。与 [1g] 源码正则断言两层互补（[1g] 钉"登记
//       写了没写"，本组钉"PRAGMA 复查这一步真的跑没跑"——[1g] 测不出 checks 循环体被 slice(0,-1) 砍掉
//       最后一项这种运行时盲区，本组能）
//   [9]（codex 382-M4 新增 + Opus S5 预筛 L2 扩形参·2026-08-14）谓词 alias helper 派生一致性：
//       sysFastReleaseExecActiveWhere('t') 应输出 't.issue_id = ? AND t.removed_at IS NULL'；无别名调用
//       应与 SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL 常量逐字节相等（单一来源派生，非两份手写字面量）；
//       [9-关联形态] 第二形参 correlateTo——sysFastReleaseExecActiveWhere('fe','sys_issues.id') 应输出
//       相关子查询形态（issue_id 分量走列等值关联，不产生新占位符）；不传 correlateTo 时既有零/单形参
//       调用输出逐字不变（向后兼容）
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
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

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 逐次唯一 issue_id（本表 issue_id 是逻辑外键、FK 恒 OFF，不需要 sys_issues 真有对应行；
//   用递增序号即可，避免不同用例组之间 (issue_id,user_id) 撞车污染 partial UNIQUE 断言）。
let issueSeq = 90000;
function nextIssueId() { return ++issueSeq; }

async function assertCheckRejected(sql, params, tag) {
  await assert.rejects(run(sql, params), /CHECK constraint failed/i, `${tag}：应被 CHECK 约束拒绝`);
}

async function main() {
  mod.initSchema();
  await waitReady();
  ok('in-process 工厂启动 + readiness ready（仅一次实例化，全程零 HTTP，纯 SQL 直调）');

  // ══════════════════════════ [1] schema 断言 ══════════════════════════
  {
    // [1a] 表存在
    const tblRow = await get(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name='sys_fast_release_executors'`);
    assert.ok(tblRow, '[1a] sys_fast_release_executors 表应存在（initSchema DDL 未生效/建表失败则本条会红）');
    ok('[1a] sys_fast_release_executors 表存在');

    // [1b] 12 列全（id + 11 业务列，逐列名核对；漏列/多列/改名均会红）
    const cols = (await all(`PRAGMA table_info(sys_fast_release_executors)`)).map(c => c.name);
    const EXPECTED_ALL_COLS = ['id', 'issue_id', 'user_id', 'user_name', 'exec_status', 'executed_at',
      'added_by', 'added_by_name', 'created_at', 'removed_at', 'removed_by', 'removed_by_name'];
    assert.strictEqual(cols.length, 12, `[1b] 应恰 12 列，实得 ${cols.length}：${cols.join(',')}`);
    assert.deepStrictEqual([...cols].sort(), [...EXPECTED_ALL_COLS].sort(),
      `[1b] 列名集合应与期望清单完全一致，实得 ${cols.join(',')}`);
    ok('[1b] 12 列全（id + 11 业务列，逐列名核对一致，无漏列/多列/改名）');

    // [1c] _internals.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS 与真实表列同源（防断言期望与真实建表漂移，
    //   同 verify-sys-schema.js [0] 组"_internals KEY_COLS 与真实表同源"范式）——本常量 = 全部非 id 列。
    assert.ok(Array.isArray(I.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS) && I.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS.length === 11,
      `[1c] _internals 导出 SYS_FAST_RELEASE_EXECUTORS_KEY_COLS 应为 11 项数组，实得 ${JSON.stringify(I.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS)}`);
    const nonIdCols = cols.filter(c => c !== 'id');
    assert.deepStrictEqual([...I.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS].sort(), [...nonIdCols].sort(),
      '[1c] KEY_COLS 常量应与真实表非 id 列集合逐一同源（本表列少，采全列锚点口径）');
    ok('[1c] _internals.SYS_FAST_RELEASE_EXECUTORS_KEY_COLS（11 列）与真实表结构同源');

    // [1d] SYS_REQUIRED_TABLES 含本表名（readiness 表存在性判定的单一来源——漏注册则启动期
    //   [1] 步不会去查这张表，即便表结构本身没问题，也测不出"表被误删"这类回归）。
    assert.ok(Array.isArray(I.SYS_REQUIRED_TABLES) && I.SYS_REQUIRED_TABLES.includes('sys_fast_release_executors'),
      '[1d] SYS_REQUIRED_TABLES 应含 sys_fast_release_executors（漏注册会红）');
    ok('[1d] SYS_REQUIRED_TABLES 含 sys_fast_release_executors');

    // [1e] 两索引存在 + partial UNIQUE 的 WHERE 谓词正确（查 sqlite_master.sql 文本；若把 partial
    //   UNIQUE 误写成非 partial、或 WHERE 谓词写错列，本条会红）。
    const idxRows = await all(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='sys_fast_release_executors'`);
    const idxByName = Object.fromEntries(idxRows.map(r => [r.name, r.sql || '']));
    assert.ok(idxByName.idx_sys_fast_release_exec_active, '[1e] idx_sys_fast_release_exec_active 索引应存在');
    assert.ok(/UNIQUE/i.test(idxByName.idx_sys_fast_release_exec_active), '[1e] idx_sys_fast_release_exec_active 应是 UNIQUE 索引');
    assert.ok(/\(issue_id,\s*user_id\)/i.test(idxByName.idx_sys_fast_release_exec_active),
      `[1e] idx_sys_fast_release_exec_active 索引列应为 (issue_id, user_id)，实得 sql=${idxByName.idx_sys_fast_release_exec_active}`);
    assert.ok(/WHERE\s+removed_at\s+IS\s+NULL/i.test(idxByName.idx_sys_fast_release_exec_active),
      `[1e] idx_sys_fast_release_exec_active 应是 partial 索引（WHERE removed_at IS NULL），实得 sql=${idxByName.idx_sys_fast_release_exec_active}`);
    assert.ok(idxByName.idx_sys_fast_release_exec_issue, '[1e] idx_sys_fast_release_exec_issue 索引应存在');
    assert.ok(/\(issue_id,\s*removed_at\)/i.test(idxByName.idx_sys_fast_release_exec_issue),
      `[1e] idx_sys_fast_release_exec_issue 索引列应为 (issue_id, removed_at)，实得 sql=${idxByName.idx_sys_fast_release_exec_issue}`);
    ok('[1e] 两索引存在：idx_sys_fast_release_exec_active（partial UNIQUE，WHERE removed_at IS NULL）+ idx_sys_fast_release_exec_issue（issue_id, removed_at）');

    // [1g]（原 [1f]/[1g] 合并·S1 收口批 Opus 预筛 M4/M5）显式证明 checks 数组确有登记本表键列。
    //   ⚠️ 实现说明（M5 如实重写）：本条**不走**"另建残缺库跑真实 initSchema()"的运行时方案——那需要
    //   二次 `require('../routes/sys-iteration')`，正是本文件头部注释警告的"同进程二次实例化 init
    //   挂起"坑（工厂内部有进程级单例状态）。改走**源码文本断言**：直接读 index.js 源码，核对
    //   `const checks = [...]` 数组字面量里确实含本表条目——若"补 checks 登记"这一步被漏做（即只改了
    //   SYS_REQUIRED_TABLES 未改 checks，重蹈 sys_release_executors 既有缺口同款），字面量里就找不到
    //   这个条目，本条会红。这是运行时验证的替代做法，不是运行时验证本身——它测的是"源码里写了没写"，
    //   不是"跑起来对不对"（后者已由 [1a]-[1e] 全部通过 waitReady 这一事实间接验证：若 checks 数组
    //   真漏了本表，PRAGMA 复查环节根本不会碰它，但那证明不了"数组里到底有没有这一条"，故仍需本条
    //   源码断言作为直接证据，而非声称它本身就是"隐性证明"）。
    {
      const fs = require('fs');
      const path = require('path');
      const srcPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
      const src = fs.readFileSync(srcPath, 'utf8');
      const checksBlockMatch = src.match(/const checks = \[[\s\S]*?\n\s*\];/);
      assert.ok(checksBlockMatch, '[1g] 应能在 index.js 中定位 `const checks = [...]` 数组字面量');
      assert.ok(/\['sys_fast_release_executors',\s*SYS_FAST_RELEASE_EXECUTORS_KEY_COLS\]/.test(checksBlockMatch[0]),
        '[1g] checks 数组字面量应含 [\'sys_fast_release_executors\', SYS_FAST_RELEASE_EXECUTORS_KEY_COLS] 条目（漏进本数组=列级半成品态查不出，回归 sys_release_executors 既有缺口同款）');
    }
    ok('[1g] readiness [2] 步 checks 数组源码字面量确已登记 [\'sys_fast_release_executors\', SYS_FAST_RELEASE_EXECUTORS_KEY_COLS]（源码断言，避免二次实例化坑）');

    // [1h] 统一谓词常量字面量正确（方案 §4-10）
    assert.strictEqual(I.SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL, 'issue_id = ? AND removed_at IS NULL',
      `[1h] SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL 字面量应精确等于 'issue_id = ? AND removed_at IS NULL'，实得 ${JSON.stringify(I.SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL)}`);
    ok('[1h] SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL 统一谓词常量字面量正确（S2 起全部消费点应引用本常量，S1 零消费点属预期）');

    // [1i]（codex 383-H1 反质证配套）DDL 指纹：新表首建即终版含类型钳制——sqlite_master.sql 真实建表
    //   文本里 `typeof` 字面量应恰出现 4 次（issue_id/user_id/added_by/removed_by 各一，codex 382-M2
    //   加固）。若未来有人改动 DDL 意外删掉/多加某处 typeof 钳制，本条计数会先于其余逐列 CHECK 反例
    //   断言变化而红，是对"这段 DDL 文本本身没被悄悄改动"最直接的体检（tblRow 复用 [1a] 已查出的
    //   sqlite_master 行，同一次查询结果，不重复查库）。
    //   ⚠️ [codex 383-H1 反质证材料] 主会话已实测核查三个本地 SQLite 库文件（生产 task_pool.db 本体、
    //   scripts/ 目录下的调试副本、backup/ 归档备份）：均**不存在** sys_fast_release_executors 表——
    //   分支开发期间从未真正启动过 server.js（全部验证走本文件这类 :memory: 工厂直调，从不落地生产库
    //   文件），故"已存在旧版本表结构、需要迁移路径兼容"这一集合在当前分支期是**空集**，是实测结论
    //   非理论推断。这意味着：任何环境（本地/生产）本表的"首次真建"都会直接走本 commit 合并后的终版
    //   DDL（4 处 typeof 钳制齐全），不存在"先建了一版缺 typeof 的旧表，后续需要 ALTER 补钳制"这种
    //   迁移场景——2.13 段头部注释"CREATE TABLE IF NOT EXISTS 首版即终版"的前提在本表上确实成立，
    //   不是尚待验证的声称（384 轮反质证材料）。
    const typeofCount = (tblRow.sql.match(/typeof/gi) || []).length;
    assert.strictEqual(typeofCount, 4,
      `[1i] sys_fast_release_executors 建表 DDL 应恰含 4 处 typeof 钳制（issue_id/user_id/added_by/removed_by 各一），实得 ${typeofCount} 处`);
    ok('[1i] DDL 指纹（codex 383-H1）：新表首建即终版含 4 处 typeof 类型钳制（生产/任何环境首建都走合并后终版 DDL，不存在需迁移的既存旧库——384 反质证材料）');
  }

  // ══════════════════════════ [2] CHECK①（软删三列成组）成对 ══════════════════════════
  {
    // 正例：合法整行 INSERT 成功（软删三列全 NULL，第一分支命中）
    const iid1 = nextIssueId();
    const r1 = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 5, '开发甲', 1, '管理员')`,
      [iid1]);
    assert.ok(r1.lastID > 0, '[2-正例] 合法整行 INSERT 应成功');
    ok('[2-正例] 合法整行 INSERT 成功（软删三列全 NULL，第一分支命中）');

    // 正例②：完整软删三列同非空（第二分支命中）——同一条件的另一侧正例，防止只测"全空"这一侧。
    const iid2 = nextIssueId();
    const r2 = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name, removed_at, removed_by, removed_by_name)
       VALUES (?, 6, '开发乙', 1, '管理员', datetime('now','localtime'), 1, '管理员')`,
      [iid2]);
    assert.ok(r2.lastID > 0, '[2-正例②] 软删三列全非空的整行 INSERT 应成功');
    ok('[2-正例②] 软删三列全非空（removed_at/removed_by/removed_by_name 同填）INSERT 成功（第二分支命中）');

    // 反例：软删三列只填其一必拒——若第二分支没显式判空（如原样写 `length(trim(removed_by_name))>0`
    //   而不带 `removed_by_name IS NOT NULL`），半软删行会被判定为"求值 NULL 而非 FALSE"从而误放行，
    //   本组三条任一变绿都说明第二分支判空写丢了。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name, removed_at) VALUES (?, 7, '开发丙', 1, '管理员', datetime('now','localtime'))`,
      [nextIssueId()], '[2-反例a] 只填 removed_at');
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name, removed_by) VALUES (?, 8, '开发丁', 1, '管理员', 1)`,
      [nextIssueId()], '[2-反例b] 只填 removed_by');
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name, removed_by_name) VALUES (?, 9, '开发戊', 1, '管理员', '管理员')`,
      [nextIssueId()], '[2-反例c] 只填 removed_by_name');
    ok('[2-反例a/b/c] 软删三列只填其一（分别只填 removed_at/removed_by/removed_by_name）均被 CHECK 拒绝——若第二分支未显式判空，本组任一条会误绿');
  }

  // ══════════════════════════ [3] CHECK②（执行态成组）成对 ══════════════════════════
  {
    // 正例：done + 合法 executed_at 成功
    const iid1 = nextIssueId();
    const r1 = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name)
       VALUES (?, 10, '开发甲', 'done', datetime('now','localtime'), 1, '管理员')`, [iid1]);
    assert.ok(r1.lastID > 0, '[3-正例a] done + 合法 executed_at 应成功');
    // 对照正例：pending + executed_at NULL（默认值路径）
    const iid2 = nextIssueId();
    const r2 = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 11, '开发乙', 1, '管理员')`, [iid2]);
    const row2 = await get(`SELECT exec_status, executed_at FROM sys_fast_release_executors WHERE id = ?`, [r2.lastID]);
    assert.strictEqual(row2.exec_status, 'pending', '[3-正例b] 默认值 exec_status 应为 pending');
    assert.strictEqual(row2.executed_at, null, '[3-正例b] 默认 pending 态 executed_at 应为 NULL');
    ok('[3-正例a/b] done+合法 executed_at 成功；pending 默认态 executed_at=NULL 成功');

    // 反例：done + executed_at NULL 必拒——若实现漏了 "exec_status='done' AND executed_at IS NOT NULL"
    //   这半句，本条会误绿（"标记完成却不留时间戳"这一坏状态会被放行）。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, added_by, added_by_name) VALUES (?, 12, '开发丙', 'done', 1, '管理员')`,
      [nextIssueId()], '[3-反例a] done 但 executed_at 为 NULL');

    // 反例：pending + executed_at 非空必拒——若实现漏了 pending 分支的 "executed_at IS NULL" 这半句，
    //   本条会误绿（"未标记完成却带着完成时间戳"这一坏状态会被放行，前端徽章判据会读到自相矛盾的行）。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, executed_at, added_by, added_by_name) VALUES (?, 13, '开发丁', datetime('now','localtime'), 1, '管理员')`,
      [nextIssueId()], '[3-反例b] pending 但 executed_at 非空');

    // 反例：done + 非法格式 executed_at（datetime() 解析失败）必拒——若实现只判 "IS NOT NULL" 不判
    //   datetime() 合法性（例如漏写 datetime(executed_at) 这半句、只写 executed_at IS NOT NULL），
    //   一个月内溢出/非日期垃圾串会被放行入库，成为"完成时间"字段里的脏数据。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, exec_status, executed_at, added_by, added_by_name) VALUES (?, 14, '开发戊', 'done', '2026-99-99', 1, '管理员')`,
      [nextIssueId()], '[3-反例c] done 但 executed_at 为非法日期格式（2026-99-99）');
    ok('[3-反例a/b/c] done+NULL / pending+非空 / done+非法格式时间 均被 CHECK 拒绝');
  }

  // ══════════════════════════ [4] CHECK③（双参 trim 非空）成对 ══════════════════════════
  {
    // 正例：正常名成功
    const iid1 = nextIssueId();
    const r1 = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 15, '正常名甲', 1, '正常管理员')`, [iid1]);
    assert.ok(r1.lastID > 0, '[4-正例] 正常 user_name/added_by_name 应成功');
    ok('[4-正例] 正常名（user_name/added_by_name 均为普通中文姓名）INSERT 成功');

    // 反例：user_name 纯空格必拒
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 16, '   ', 1, '管理员')`,
      [nextIssueId()], '[4-反例a] user_name 纯空格');

    // 反例：user_name 纯 Tab（char(9)）必拒——**专钉双参 trim**：若实现误用单参 `trim(user_name)`
    //   （SQLite 单参 trim 只去空格字符 0x20，不认 Tab/换行），这条会被误判为"非空字符串"而放行入库，
    //   本条是本次改动最容易踩的坑，实现若退化为单参 trim，本条必红。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 17, char(9)||char(9), 1, '管理员')`,
      [nextIssueId()], '[4-反例b] user_name 纯 Tab（char(9)||char(9)，单参 trim 会漏放行的经典坑）');

    // 反例：user_name 纯换行（char(10)||char(13)）必拒——同上，双参字符集须覆盖 LF(10)/CR(13)。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 18, char(10)||char(13), 1, '管理员')`,
      [nextIssueId()], '[4-反例c] user_name 纯换行（char(10)||char(13)）');

    // added_by_name 同款抽一条（纯 Tab）——两列各自独立带 CHECK，任一列漏写双参 trim 均须能测出。
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 19, '开发己', 1, char(9)||char(9))`,
      [nextIssueId()], '[4-反例d] added_by_name 纯 Tab（同 user_name 一样须双参 trim）');
    ok('[4-反例a/b/c/d] user_name 纯空格/纯Tab/纯换行 + added_by_name 纯Tab 均被 CHECK 拒绝（双参 trim 字符集覆盖空格/Tab/LF/CR）');
  }

  // ══════════════════════════ [5] partial UNIQUE 成对 ══════════════════════════
  {
    const iid = nextIssueId();
    const first = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 20, '开发甲', 1, '管理员')`, [iid]);
    assert.ok(first.lastID > 0, '[5-前置] 首次插入应成功');

    // 反例：同 (issue_id,user_id) 未软删重插必拒（UNIQUE 报错）
    await assert.rejects(
      run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 20, '开发甲', 1, '管理员')`, [iid]),
      /UNIQUE constraint failed/i,
      '[5-反例] 同 (issue_id,user_id) 在册重复插入应被 partial UNIQUE 索引拒绝');
    ok('[5-反例] 同 (issue_id,user_id) 未软删重插被 UNIQUE 约束拒绝（idx_sys_fast_release_exec_active 生效）');

    // 正例：软删旧行后同人重插成功（代次语义——软删退出当前代，新行开新代）
    await run(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE id = ?`, [first.lastID]);
    const second = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 20, '开发甲', 1, '管理员')`, [iid]);
    assert.ok(second.lastID > 0, '[5-正例] 软删旧行后同 (issue_id,user_id) 重插应成功');
    assert.notStrictEqual(second.lastID, first.lastID, '[5-正例] 新行应是新的 id（代次由行 id 承载，非原地复用）');
    const activeCount = await get(`SELECT COUNT(*) AS c FROM sys_fast_release_executors WHERE issue_id = ? AND user_id = 20 AND removed_at IS NULL`, [iid]);
    assert.strictEqual(activeCount.c, 1, `[5-正例] 该 (issue_id,user_id) 在册行应恰 1 条，实得 ${activeCount.c}`);
    ok('[5-正例] 软删旧行后同人重插成功（新 id，代次语义），该 (issue_id,user_id) 在册行恰 1 条');
  }

  // ══════════════════════════ [6]（S1 收口批·Opus 预筛 L8）issue_id CHECK (issue_id > 0) 成对 ══════════════════════════
  //   与同表 user_id/added_by 对称加固——若这条 CHECK 被后续改动误删/写错，issue_id=0 这类非法值会
  //   静默入库（对应一个不存在的单据号），本条会红。正例沿用 [2]/[3]/[4]/[5] 全组已用过的正常插入路径
  //   （issue_id>0 恒成立），无需单独再插一次。
  {
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (0, 21, '开发庚', 1, '管理员')`,
      [], '[6-反例] issue_id = 0 必拒');
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (-1, 22, '开发辛', 1, '管理员')`,
      [], '[6-反例②] issue_id 负数必拒');
    ok('[6-反例a/b] issue_id=0 与负数均被 CHECK (issue_id > 0) 拒绝（正例见本文件全部其余用例——均用正整数 issue_id 且均成功，此处不重复插入）');
  }

  // ══════════════════ [7]（codex 382-M2）typeof 整数钳制成对 ══════════════════
  //   "实现坏成什么样这条会红"：若 2.13 段 DDL 的 typeof(col)='integer' 钳制被回退成裸 `col > 0`，
  //   下面四条反例会因 SQLite 的 TEXT/REAL affinity 转换规则被静默放行（已用 node 脚本实测验证：
  //   'abc'→typeof text、1.5→typeof real、'0x1'→typeof text、非数字字符串同款），本组任一条误绿
  //   即说明类型钳制被削弱或漏加。
  {
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES ('abc', 30, '开发甲', 1, '管理员')`,
      [], `[7-反例a] issue_id='abc'（TEXT，裸 > 0 会被穿透）必拒`);
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 1.5, '开发乙', 1, '管理员')`,
      [nextIssueId()], `[7-反例b] user_id=1.5（REAL，裸 > 0 会被穿透）必拒`);
    await assertCheckRejected(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 31, '开发丙', '0x1', '管理员')`,
      [nextIssueId()], `[7-反例c] added_by='0x1'（TEXT，非十进制数字串，affinity 不转换）必拒`);
    // 反例④：软删分支 removed_by 同款类型钳制（M2 四处改动的第 4 处，同批必须一起测出）
    const iid7d = nextIssueId();
    const preRow = await run(
      `INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name) VALUES (?, 32, '开发丁', 1, '管理员')`,
      [iid7d]);
    await assertCheckRejected(
      `UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 'xyz', removed_by_name = '管理员' WHERE id = ?`,
      [preRow.lastID], `[7-反例d] removed_by='xyz'（TEXT，软删分支同款 typeof 钳制）必拒`);
    ok(`[7-反例a/b/c/d] issue_id='abc' / user_id=1.5 / added_by='0x1' / removed_by='xyz' 均被 typeof 钳制拒绝（裸 > 0 会被这四类值穿透，已用独立脚本实测确认 SQLite affinity 转换行为）`);
    ok(`[7-正例] 正例复用 [2]-[6] 全部已用正整数 issue_id/user_id/added_by（均成功，未单独再插——typeof(col)='integer' 对合法正整数恒真，不引入新的假阴性）`);
  }

  // ══════════════════ [8]（codex 382-M3）子进程活体探针 ══════════════════
  //   与 [1g] 源码正则断言两层互补：[1g] 钉"checks 数组字面量里写没写这一条登记"（源码文本证据），
  //   本组钉"PRAGMA 复查这一步对本表真的执行了没有"（运行时证据）——若 checks 循环体被改坏成
  //   `checks.slice(0, -1)`（本表恰是数组最后一项，砍掉即漏检），[1g] 的源码文本断言仍会照绿（数组
  //   字面量本身没被删），但本组会红（残缺表会被放行为 ready=true，而非探针期望的 ready=false）。
  {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const probeOut = execFileSync(process.execPath, [path.join(__dirname, '_probe-fastlane-exec-missing-col.js')], { encoding: 'utf8' });
    const probe = JSON.parse(probeOut);
    assert.strictEqual(probe.ready, false,
      `[8] 缺 exec_status 列的残缺表应使 readiness 停在 false（若为 true，说明 checks 循环未真正执行到本表），实得 ready=${probe.ready}`);
    assert.ok(/sys_fast_release_executors/.test(probe.error || ''),
      `[8] error 文本应点名表名 sys_fast_release_executors，实得="${probe.error}"`);
    assert.ok(/exec_status/.test(probe.error || ''),
      `[8] error 文本应点名缺失列 exec_status，实得="${probe.error}"`);
    ok(`[8] 子进程活体探针：残缺表（缺 exec_status）→ readiness=false + error 文本="${probe.error}"（PRAGMA 复查真实执行，非源码文本层面的表面登记）`);
  }

  // ══════════════════ [9]（codex 382-M4）谓词 alias helper 派生一致性 ══════════════════
  //   "实现坏成什么样这条会红"：若 helper 与常量各自维护成两份手写字面量（未做单一来源派生），日后
  //   改一处忘改另一处会在这里被抓：常量应恒等于 helper() 无别名输出，helper('t') 应恒等于常量的
  //   "issue_id"/"removed_at" 两处列名前插入别名前缀、其余字符不变。
  {
    assert.strictEqual(typeof I.sysFastReleaseExecActiveWhere, 'function',
      '[9] _internals 应导出 sysFastReleaseExecActiveWhere 函数（codex 382-M4 新增 helper）');
    const noAlias = I.sysFastReleaseExecActiveWhere();
    assert.strictEqual(noAlias, I.SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL,
      `[9] helper 无别名调用应与 SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL 常量逐字节相等（单一来源派生），实得 helper()=${JSON.stringify(noAlias)} 常量=${JSON.stringify(I.SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL)}`);
    const withAlias = I.sysFastReleaseExecActiveWhere('t');
    assert.strictEqual(withAlias, 't.issue_id = ? AND t.removed_at IS NULL',
      `[9] helper('t') 应输出 't.issue_id = ? AND t.removed_at IS NULL'，实得 ${JSON.stringify(withAlias)}`);
    ok(`[9] sysFastReleaseExecActiveWhere 派生一致性：无别名=常量本体逐字节相等；helper('t')='${withAlias}'`);

    // [9-关联形态]（Opus S5 预筛 L2）第二形参 correlateTo——issue_id 分量改与外层查询某列等值关联（不产生
    //   新占位符，不消耗调用方参数数组），removed_at 分量与既有形态同一份字面量派生（不因新增形参分裂
    //   出第二份手写字符串）。真实消费点=撤销端点 fast-release-revoke 的 NOT EXISTS 相关子查询
    //   （sysFastReleaseExecActiveWhere('fe', 'sys_issues.id')）。
    const correlatedWithAlias = I.sysFastReleaseExecActiveWhere('fe', 'sys_issues.id');
    assert.strictEqual(correlatedWithAlias, 'fe.issue_id = sys_issues.id AND fe.removed_at IS NULL',
      `[9-关联形态] helper('fe','sys_issues.id') 应输出 'fe.issue_id = sys_issues.id AND fe.removed_at IS NULL'，实得 ${JSON.stringify(correlatedWithAlias)}`);
    const correlatedNoAlias = I.sysFastReleaseExecActiveWhere(undefined, 'sys_issues.id');
    assert.strictEqual(correlatedNoAlias, 'issue_id = sys_issues.id AND removed_at IS NULL',
      `[9-关联形态] helper(undefined,'sys_issues.id') 应输出 'issue_id = sys_issues.id AND removed_at IS NULL'，实得 ${JSON.stringify(correlatedNoAlias)}`);
    // 向后兼容再核一遍：不传 correlateTo 时逐字不变（不因新增形参悄悄改变既有零/单形参调用点的输出）。
    assert.strictEqual(I.sysFastReleaseExecActiveWhere(), noAlias, '[9-关联形态] 不传 correlateTo 时零形参调用输出应与之前逐字相同（向后兼容）');
    assert.strictEqual(I.sysFastReleaseExecActiveWhere('t'), withAlias, '[9-关联形态] 不传 correlateTo 时单形参（alias）调用输出应与之前逐字相同（向后兼容）');
    ok(`[9-关联形态] sysFastReleaseExecActiveWhere correlateTo 形参：helper('fe','sys_issues.id')='${correlatedWithAlias}'；helper(undefined,'sys_issues.id')='${correlatedNoAlias}'——issue_id 分量走列关联非占位符，removed_at 分量与既有形态同源；既有零/单形参调用输出逐字不变（向后兼容）`);
  }

  console.log(`\n✅ verify-sys-fastlane-two-phase 全部通过（${passed} 组·先行上线两步化 S1 数据层地基 + codex 382 修复批）`);
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); process.exit(1); });
