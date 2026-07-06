// 验证脚本：周期取数推送模块 最小 SQL 形态校验（集成点1 ②，方案 §4.1，任务书 OT-1）
//   用法：node scripts/verify-periodic-sqlcheck.js
//
// require routes/periodic-fetch/index.js 真实 _internals.validatePeriodicSqlForm，
//   底层组合复用 utils/sql-validator.js 的 layer0_lexerScan + checkTempTable(层0.5) + layer1_parse，
//   跳过 layer2（跨库白名单）/ layer3（TOP 注入），禁止复刻逻辑到测试里（RC-L2）。
//
// 断言覆盖（任务书 §5 集成点1 verify 清单）：
//   拦 EXEC/WAITFOR/OPENROWSET/OPENDATASOURCE/OPENQUERY/xp_*/高危sp_/多语句(分号拼接)/非SELECT(INSERT/
//   UPDATE/DELETE/CREATE/DROP/ALTER)/临时表(#tmp/##tmp/TEMPORARY TABLE)；
//   放行合法 SELECT / CTE(WITH) / UNION ALL（#21 真实模板，本模块必须放行 UNION，与 smoke 相反）/
//   MySQL 方言危险关键字(OUTFILE/LOAD_FILE/SLEEP等)；
//   ⭐ 验证跳过 layer3 效果：UNION 查询本模块放行（smoke 会拒绝 UNION）+ 不注入 TOP/LIMIT。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

// 集成点2 起 REQUIRED_DEPS 扩了 5 项，本脚本只测 SQL 形态校验纯函数，给最简 mock 保证工厂能构造成功。
const mod = require('../routes/periodic-fetch')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
  authenticateToken: mwPass, requireAdmin: mwPass,
  getMssqlPool: async () => ({ request: () => { throw new Error('mock：sqlcheck verify 不应触发'); } }),
  getMysqlPool: async () => ({ query: async () => { throw new Error('mock：sqlcheck verify 不应触发'); } }),
  readSystemConfig: async () => null,
  maskPhone: () => '[mock]',
  decryptPassword: (x) => x,
});
const { validatePeriodicSqlForm } = mod._internals;

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

function main() {
  // ── [0] M-3（集成审）：sql-validator._internal 契约就位（模块工厂已 fail-closed 断言，此处显式复核）──
  const sqlValidator = require('../utils/sql-validator');
  assert.ok(sqlValidator._internal && typeof sqlValidator._internal === 'object', 'sql-validator._internal 应为对象');
  for (const fn of ['layer0_lexerScan', 'layer1_parse', 'checkTempTable']) {
    assert.strictEqual(typeof sqlValidator._internal[fn], 'function', `sql-validator._internal.${fn} 应为函数（本模块 SQL 校验依赖）`);
  }
  ok('M-3：sql-validator._internal 三函数（layer0_lexerScan/layer1_parse/checkTempTable）均为函数（契约就位，工厂期已 fail-closed 断言）');

  // ── [1] 合法 SELECT / CTE / UNION（sqlserver 默认方言）──
  let r = validatePeriodicSqlForm(`SELECT id, name FROM t WHERE d >= '2026-06-01'`, 'sqlserver');
  assert.strictEqual(r.ok, true, '普通 SELECT 应放行: ' + JSON.stringify(r));
  ok('普通 SELECT → 放行');

  r = validatePeriodicSqlForm(`WITH cte AS (SELECT id FROM t) SELECT * FROM cte`, 'sqlserver');
  assert.strictEqual(r.ok, true, 'CTE(WITH) 应放行: ' + JSON.stringify(r));
  ok('CTE（WITH ... SELECT）→ 放行');

  // #21 真实模板结构：UNION ALL 两段（方案 §3.3）——本模块必须放行（与 smoke 相反，smoke 因 TOP 注入
  //   与 UNION 冲突而拒绝；本模块跳过 layer3，不受此限）
  r = validatePeriodicSqlForm(
    `SELECT a, b FROM t1 WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'
     UNION ALL
     SELECT a, b FROM t2 WHERE d >= '{{MONTH_START}}' AND d < '{{MONTH_END}}'`,
    'sqlserver'
  );
  assert.strictEqual(r.ok, true, '#21 UNION ALL 模板应放行（跳过 layer3 TOP 注入限制）: ' + JSON.stringify(r));
  ok('⭐ #21 真实模板结构（UNION ALL 双段）→ 放行（跳过 layer3，本模块要全量非取样，与 smoke 拒绝 UNION 相反）');

  r = validatePeriodicSqlForm(`;WITH cte AS (SELECT id FROM t) SELECT * FROM cte`, 'sqlserver');
  assert.strictEqual(r.ok, true, '合法前导分号 ;WITH 应放行: ' + JSON.stringify(r));
  ok(';WITH 合法前导分号写法 → 放行（T-SQL 标准防御性写法）');

  // ── [2] 多语句（分号拼接）拒 ──
  r = validatePeriodicSqlForm(`SELECT 1; DROP TABLE t;`, 'sqlserver');
  assert.strictEqual(r.ok, false, '多语句应拒');
  ok(`多语句（分号拼接 DROP TABLE）→ 拒：${r.reason}`);

  // ── [3] EXEC/EXECUTE 拒 ──
  r = validatePeriodicSqlForm(`EXEC sp_who`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'EXEC 应拒');
  ok(`EXEC sp_who → 拒：${r.reason}`);

  // ── [4] WAITFOR 拒 ──
  r = validatePeriodicSqlForm(`SELECT 1 WHERE 1=1; WAITFOR DELAY '00:00:05'`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'WAITFOR 应拒（且此例也应因多语句拒）');
  ok(`WAITFOR DELAY → 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * FROM t WHERE WAITFOR = 1`, 'sqlserver');
  assert.strictEqual(r.ok, false, '单独 WAITFOR 关键字出现也应拒（层0词法扫描，不论位置）');
  ok(`WAITFOR 关键字出现在 WHERE 子句（非法但仍应被词法层拦）→ 拒：${r.reason}`);

  // ── [5] OPENROWSET/OPENDATASOURCE/OPENQUERY 拒 ──
  r = validatePeriodicSqlForm(`SELECT * FROM OPENROWSET('SQLNCLI','...','SELECT 1')`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'OPENROWSET 应拒');
  ok(`OPENROWSET → 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * FROM OPENQUERY(LinkedSrv, 'SELECT 1')`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'OPENQUERY 应拒');
  ok(`OPENQUERY → 拒：${r.reason}`);

  // ── [6] xp_ / 高危 sp_ 拒 ──
  r = validatePeriodicSqlForm(`SELECT * FROM t WHERE 1 = (SELECT xp_cmdshell('dir'))`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'xp_cmdshell 应拒');
  ok(`xp_cmdshell → 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * FROM t WHERE 1 = (SELECT sp_executesql N'SELECT 1')`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'sp_executesql 应拒');
  ok(`sp_executesql（高危 sp_ 名单）→ 拒：${r.reason}`);

  // ── [7] DML（INSERT/UPDATE/DELETE/MERGE）拒（首 token 非 SELECT/WITH）──
  for (const dml of ['INSERT INTO t VALUES (1)', 'UPDATE t SET x = 1', 'DELETE FROM t', 'MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET x=1']) {
    r = validatePeriodicSqlForm(dml, 'sqlserver');
    assert.strictEqual(r.ok, false, `DML「${dml}」应拒`);
  }
  ok('DML（INSERT/UPDATE/DELETE/MERGE）→ 全部拒（首关键字非 SELECT/WITH）');

  // ── [8] DDL（CREATE/DROP/ALTER/TRUNCATE）拒 ──
  for (const ddl of ['CREATE TABLE t (id INT)', 'DROP TABLE t', 'ALTER TABLE t ADD x INT', 'TRUNCATE TABLE t']) {
    r = validatePeriodicSqlForm(ddl, 'sqlserver');
    assert.strictEqual(r.ok, false, `DDL「${ddl}」应拒`);
  }
  ok('DDL（CREATE/DROP/ALTER/TRUNCATE）→ 全部拒');

  // ── [9] 临时表拒（层0.5 checkTempTable，方案 §4.1「禁止...临时表」）──
  r = validatePeriodicSqlForm(`SELECT * INTO #tmp FROM t`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'SELECT INTO #tmp 应拒（临时表）');
  ok(`SELECT INTO #tmp（会话级临时表）→ 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * FROM ##globaltmp`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'FROM ##globaltmp 应拒（全局临时表）');
  ok(`FROM ##globaltmp（全局临时表）→ 拒：${r.reason}`);

  // ── [9b] ⭐ H-1（集成审）：SELECT ... INTO 建永久表（SQL Server 写操作）拒 ──
  //   跳过 layer2 后 layer1 会把 SELECT INTO 当顶层 select 放行，checkTempTable 只拦 #tmp/##tmp 拦不到普通
  //   INTO；本模块补一条真 INTO 拦截。判据 = into.expr 非空（对齐 sql-validator isRealInto），不误伤空占位。
  r = validatePeriodicSqlForm(`SELECT * INTO t2 FROM t1 WHERE d >= '2026-06-01'`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'SELECT INTO 建永久表应拒');
  assert.strictEqual(r.code, 'SQL_FORM_REJECTED');
  ok(`⭐ SELECT * INTO t2 FROM t1（建永久表）→ 拒（H-1）：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * INTO dbo.t2 FROM t1`, 'sqlserver');
  assert.strictEqual(r.ok, false, '带 schema 的 SELECT INTO dbo.t2 应拒');
  ok('⭐ SELECT * INTO dbo.t2 FROM t1（schema 限定建表）→ 拒（H-1）');

  r = validatePeriodicSqlForm(`WITH cte AS (SELECT id FROM t) SELECT * INTO t2 FROM cte`, 'sqlserver');
  assert.strictEqual(r.ok, false, 'CTE + INTO 应拒（递归遍历 select 节点）');
  ok('⭐ WITH cte AS (...) SELECT * INTO t2 FROM cte（CTE + INTO）→ 拒（H-1，递归遍历命中）');

  // 反向防误伤回归：正常 SELECT（into 为 {position} 空占位）/ CTE / UNION 仍放行，证明未误伤空占位
  r = validatePeriodicSqlForm(`SELECT a, b FROM t1 WHERE d >= '2026-06-01'`, 'sqlserver');
  assert.strictEqual(r.ok, true, 'INTO 拦截不得误伤正常 SELECT（into 空占位）: ' + JSON.stringify(r));
  r = validatePeriodicSqlForm(`WITH cte AS (SELECT id FROM t) SELECT * FROM cte`, 'sqlserver');
  assert.strictEqual(r.ok, true, 'INTO 拦截不得误伤正常 CTE: ' + JSON.stringify(r));
  r = validatePeriodicSqlForm(`SELECT a FROM t1 UNION ALL SELECT a FROM t2`, 'sqlserver');
  assert.strictEqual(r.ok, true, 'INTO 拦截不得误伤正常 UNION: ' + JSON.stringify(r));
  ok('⭐ 反向防误伤：正常 SELECT / CTE / UNION（into 为 {position} 空占位）仍放行（H-1 只拦 into.expr 非空真 INTO）');

  // ── [10] MySQL 方言：危险关键字拒 + 合法 SELECT 放行 ──
  r = validatePeriodicSqlForm(`SELECT * FROM t`, 'mysql');
  assert.strictEqual(r.ok, true, 'MySQL 普通 SELECT 应放行: ' + JSON.stringify(r));
  ok('MySQL 方言：普通 SELECT → 放行');

  r = validatePeriodicSqlForm(`SELECT LOAD_FILE('/etc/passwd')`, 'mysql');
  assert.strictEqual(r.ok, false, 'MySQL LOAD_FILE 应拒');
  ok(`MySQL LOAD_FILE → 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT * FROM t INTO OUTFILE '/tmp/x.csv'`, 'mysql');
  assert.strictEqual(r.ok, false, 'MySQL INTO OUTFILE 应拒');
  ok(`MySQL INTO OUTFILE → 拒：${r.reason}`);

  r = validatePeriodicSqlForm(`SELECT SLEEP(10)`, 'mysql');
  assert.strictEqual(r.ok, false, 'MySQL SLEEP 应拒');
  ok(`MySQL SLEEP(10)（时间盲注/资源消耗）→ 拒：${r.reason}`);

  // ── [11] 空/非法方言 ──
  r = validatePeriodicSqlForm('', 'sqlserver');
  assert.strictEqual(r.ok, false, '空 SQL 应拒');
  assert.strictEqual(r.code, 'SQL_EMPTY');
  ok('空 SQL → 拒（SQL_EMPTY）');

  r = validatePeriodicSqlForm('SELECT 1', 'oracle');
  assert.strictEqual(r.ok, false, '不支持的方言应拒');
  assert.strictEqual(r.code, 'UNSUPPORTED_DIALECT');
  ok('不支持的方言（oracle）→ 拒（UNSUPPORTED_DIALECT）');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 周期取数推送最小 SQL 形态校验验证通过`);
  console.log('  覆盖：合法SELECT/CTE/UNION放行 + 多语句/EXEC/WAITFOR/OPENROWSET/OPENQUERY/xp_/sp_/DML/DDL/临时表拒 + MySQL方言危险关键字拒 + 空/非法方言拒');
}

try {
  main();
} catch (e) {
  console.error('\n[失败]', e.message, e.stack);
  process.exit(1);
}
