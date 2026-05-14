/**
 * sql-validator.js 端到端安全用例矩阵（D3 模块 3 step-8）
 *
 * 用法：node scripts/test-sql-validator-e2e.js
 *
 * 覆盖维度：
 *   - 合法 SQL 形态（5 类，需通过到 layer 3 输出 smokeSql）
 *   - 字符串/注释/标识符误判（4 类）
 *   - 多语句拦截（3 类）
 *   - 危险关键字拦截（7 类）
 *   - xp_/sp_ 过程拦截（3 类）
 *   - 非 SELECT 首关键字拦截（5 类）
 *   - 未闭合 token 拦截（4 类）
 *   - AST 层语义危险拦截（4 类）
 *   - UNION 拒绝（codex C4）
 */

'use strict';

const { validateAndTransform } = require('../utils/sql-validator');

const CASES = [
    // ===== 合法 SQL 形态 =====
    ['G1 简单 SELECT', 'SELECT * FROM bms_xxx WHERE id=1', { ok: true, mustContain: 'TOP 100' }],
    ['G2 已有 TOP 5（不覆盖）', 'SELECT TOP 5 * FROM bms_xxx', { ok: true, mustContain: 'TOP 5' }],
    ['G3 ORDER BY', 'SELECT col1 FROM bms_xxx ORDER BY id DESC', { ok: true, mustContain: 'ORDER BY' }],
    ['G4 单 CTE', 'WITH cte AS (SELECT * FROM t1) SELECT * FROM cte JOIN t2 ON cte.id=t2.id', { ok: true, mustContain: 'TOP 100' }],
    ['G5 多 CTE', 'WITH a AS (SELECT * FROM t1), b AS (SELECT * FROM t2) SELECT * FROM a JOIN b ON a.id=b.id', { ok: true, mustContain: 'TOP 100' }],
    ['G6 business_db 三段名', 'SELECT * FROM business_db.dbo.demo_table', { ok: true, mustContain: 'TOP 100' }],
    ['G7 字符串含伪关键字', "SELECT '我们不用 xp_cmdshell' AS msg, 1 AS id", { ok: true, mustContain: 'TOP 100' }],
    ['G8 注释含伪关键字', 'SELECT 1 /* WAITFOR DELAY */ FROM t', { ok: true, mustContain: 'TOP 100' }],
    ['G9 尾分号', 'SELECT 1;', { ok: true, mustContain: 'TOP 100' }],
    ['G10 [xp_test] 合法列名', 'SELECT [xp_test] FROM bms_xxx', { ok: true, mustContain: 'TOP 100' }],
    ['G11 sp_help 非危险名单', 'SELECT sp_help FROM t', { ok: true }],

    // ===== 字符串/注释误判（应通过）=====
    ['S1 字符串单引号转义', "SELECT 'don''t' FROM t", { ok: true }],
    ['S2 N\'\' Unicode', "SELECT N'unicode文本' FROM t", { ok: true }],
    ['S3 单行注释', "SELECT 1 -- 注释里有 EXEC xp_cmdshell\nFROM t", { ok: true }],
    ['S4 字符串内 SELECT', "SELECT '我想 SELECT 数据' FROM t", { ok: true }],

    // ===== 层 0 拦截（多语句）=====
    ['M1 中间分号', 'SELECT 1; DROP TABLE foo;', { ok: false, layer: 0 }],
    ['M2 双分号', 'SELECT 1;;', { ok: false, layer: 0 }],
    ['M3 开头分号', '; SELECT 1', { ok: false, layer: 0 }],

    // ===== 层 0 拦截（危险关键字）=====
    ['K1 EXEC', "EXEC xp_dirtree 'C:\\'", { ok: false, layer: 0 }],
    ['K2 EXECUTE', "EXECUTE sp_executesql N'SELECT 1'", { ok: false, layer: 0 }],
    ['K3 WAITFOR', "WAITFOR DELAY '00:00:05'", { ok: false, layer: 0 }],
    ['K4 OPENROWSET', "SELECT * FROM OPENROWSET('p','q','r')", { ok: false, layer: 0 }],
    ['K5 OPENDATASOURCE', "SELECT * FROM OPENDATASOURCE('p','q').db.dbo.t", { ok: false, layer: 0 }],
    ['K6 OPENQUERY', "SELECT * FROM OPENQUERY(srv, 'SELECT 1')", { ok: false, layer: 0 }],
    ['K7 BULK', "SELECT * FROM OPENROWSET(BULK 'C:/x', SINGLE_CLOB) AS x", { ok: false, layer: 0 }],

    // ===== 层 0 拦截（xp_/sp_）=====
    ['P1 xp_cmdshell 引用', "SELECT * FROM master.dbo.xp_cmdshell", { ok: false, layer: 0 }],
    ['P2 sp_executesql', "SELECT * FROM sys.sp_executesql", { ok: false, layer: 0 }],
    ['P3 sp_oacreate', "SELECT sp_oacreate FROM t", { ok: false, layer: 0 }],

    // ===== 层 0 拦截（非 SELECT 首关键字）=====
    ['F1 INSERT', 'INSERT INTO t VALUES(1)', { ok: false, layer: 0 }],
    ['F2 UPDATE', 'UPDATE t SET x=1', { ok: false, layer: 0 }],
    ['F3 DELETE', 'DELETE FROM t WHERE id=1', { ok: false, layer: 0 }],
    ['F4 CREATE', 'CREATE TABLE t (id INT)', { ok: false, layer: 0 }],
    ['F5 DROP', 'DROP TABLE t', { ok: false, layer: 0 }],

    // ===== 层 0 拦截（未闭合）=====
    ['U1 未闭合字符串', "SELECT 'abc FROM t", { ok: false, layer: 0 }],
    ['U2 未闭合方括号', 'SELECT [col FROM t', { ok: false, layer: 0 }],
    ['U3 未闭合双引号', 'SELECT "col FROM t', { ok: false, layer: 0 }],
    ['U4 未闭合块注释', 'SELECT 1 /* abc FROM t', { ok: false, layer: 0 }],

    // ===== 层 1 拦截（parser 失败）=====
    ['L1-1 parser 失败的截断 SQL', 'SELECT * FROM t WHERE name = ', { ok: false, layer: 1 }],

    // ===== 层 2 拦截（AST 语义）=====
    ['A1 SELECT INTO', 'SELECT * INTO new_tbl FROM bms_xxx', { ok: false, layer: 2 }],
    ['A2 master 跨库', 'SELECT TOP 1 * FROM master.dbo.syslogins', { ok: false, layer: 2 }],
    ['A3 master.sys 跨库', 'SELECT name FROM master.sys.sql_logins', { ok: false, layer: 2 }],
    ['A4 CTE 内部 SELECT INTO', 'WITH cte AS (SELECT col1 FROM t1) SELECT * INTO new_tbl FROM cte', { ok: false, layer: 2 }],
    ['A5 子查询里跨库', 'SELECT * FROM (SELECT * FROM master.dbo.syslogins) AS x', { ok: false, layer: 2 }],

    // ===== 层 3 拦截（UNION 拒绝，codex C4 派生）=====
    ['T1 UNION 拒绝', 'SELECT col1 FROM t1 UNION SELECT col1 FROM t2', { ok: false, layer: 3 }],

    // ===== 2026-05-13 新增：两段名歧义拒绝（用户实测发现） =====
    ['B1 sys.tables 系统视图（合法但拒）', 'SELECT TOP 1 name FROM sys.tables', { ok: false, layer: 2 }],
    ['B2 dbo.crm_bid 显式 schema', 'SELECT * FROM dbo.crm_bid', { ok: false, layer: 2 }],
    ['B3 master.syslogins 两段名跨库', 'SELECT * FROM master.syslogins', { ok: false, layer: 2 }],
    ['B4 information_schema 两段名', 'SELECT * FROM information_schema.tables', { ok: false, layer: 2 }],
    ['B5 单段名 crm_bid 通过', 'SELECT TOP 1 * FROM crm_bid', { ok: true, mustContain: 'crm_bid' }],
    ['B6 完整三段名 business_db.dbo.bid_table 通过', 'SELECT TOP 1 * FROM business_db.dbo.bid_table', { ok: true, mustContain: 'business_db' }],
];

let passed = 0, failed = 0;
const failures = [];

for (const [name, sql, expect] of CASES) {
    const r = validateAndTransform(sql);
    let ok = false;
    if (expect.ok) {
        ok = r.ok === true;
        if (ok && expect.mustContain) {
            ok = typeof r.smokeSql === 'string' && r.smokeSql.includes(expect.mustContain);
        }
    } else {
        ok = r.ok === false && r.layer === expect.layer;
    }

    if (ok) {
        passed++;
    } else {
        failed++;
        failures.push({ name, sql, expect, actual: r });
    }
}

console.log(`\n=== 端到端安全用例矩阵 (D3 模块 3 step-8) ===`);
console.log(`总数: ${CASES.length}, 通过: ${passed}, 失败: ${failed}`);

if (failures.length > 0) {
    console.log('\n❌ 失败用例:');
    for (const f of failures) {
        console.log(`\n[${f.name}]`);
        console.log(`   SQL: ${f.sql}`);
        console.log(`   期望: ${JSON.stringify(f.expect)}`);
        console.log(`   实际: ${JSON.stringify(f.actual).slice(0, 200)}`);
    }
    process.exit(1);
}
console.log('\n全部通过 ✅\n');

// 额外打印几条合法 SQL 的改写结果，肉眼复核
console.log('=== 改写示例（合法 SQL 跑通后 smokeSql 长啥样）===');
for (const [name, sql, expect] of CASES.filter(c => c[2].ok).slice(0, 6)) {
    const r = validateAndTransform(sql);
    console.log(`\n[${name}]`);
    console.log(`   IN:  ${sql}`);
    console.log(`   OUT: ${r.smokeSql}`);
}
