/**
 * sql-validator.js 层 0 词法状态机单测
 *
 * 用法：node scripts/test-sql-validator-layer0.js
 * 输出：每条用例 → 期望/实际 → ✅/❌
 */

'use strict';

const { _internal } = require('../utils/sql-validator');
const layer0 = _internal.layer0_lexerScan;

const CASES = [
    // ===== 合法（应通过）=====
    ['L1 简单 SELECT', 'SELECT * FROM bms_xxx WHERE id=1', true],
    ['L2 WITH CTE', 'WITH cte AS (SELECT * FROM t1) SELECT * FROM cte', true],
    ['L3 尾分号 OK', 'SELECT 1;', true],
    ['L4 字符串含伪关键字', "SELECT '请勿用 xp_cmdshell' AS msg", true],
    ['L5 多行注释中含关键字', 'SELECT 1 /* EXEC xp_cmdshell */ FROM t', true],
    ['L6 单行注释中含关键字', 'SELECT 1 -- WAITFOR DELAY \'00:00:05\'\nFROM t', true],
    ['L7 方括号标识符 [xp_test] 合法', 'SELECT [xp_test] FROM bms_xxx', true],
    ['L8 双引号标识符', 'SELECT "id" FROM "t1"', true],
    ['L9 字符串内 SELECT 关键字', "SELECT '我要 SELECT 数据' FROM t", true],
    ['L10 字符串单引号转义', "SELECT 'don''t' FROM t", true],
    ['L11 N\'\' Unicode 字符串', "SELECT N'unicode' FROM t", true],
    ['L12 三段名 business_db.dbo.t', 'SELECT * FROM business_db.dbo.demo_table', true],
    ['L13 中文标识符（如有）', 'SELECT id FROM 客户表', true],

    // ===== 危险关键字（应拒绝）=====
    ['D1 EXEC 调用', "EXEC xp_dirtree 'C:\\'", false],
    ['D2 EXECUTE 调用', "EXECUTE sp_executesql N'SELECT 1'", false],
    ['D3 WAITFOR DELAY', "WAITFOR DELAY '00:00:05'", false],
    ['D4 OPENROWSET', "SELECT * FROM OPENROWSET('SQLNCLI', '', 'SELECT 1')", false],
    ['D5 OPENDATASOURCE', "SELECT * FROM OPENDATASOURCE('SQLNCLI', '').db.dbo.t", false],
    ['D6 OPENQUERY', "SELECT * FROM OPENQUERY(srv, 'SELECT 1')", false],
    ['D7 BULK 操作', "SELECT * FROM OPENROWSET(BULK 'C:/x', SINGLE_CLOB) AS x", false],

    // ===== xp_/sp_ 过程名（应拒绝）=====
    ['X1 xp_cmdshell 引用', "SELECT * FROM master.dbo.xp_cmdshell", false], // xp_ token 会被识别
    ['X2 sp_executesql', "SELECT * FROM sys.sp_executesql", false], // 拒
    ['X3 sp_oacreate', "SELECT sp_oacreate FROM t", false], // 拒（哪怕作为列名引用也拒，这是有意的过度防御）
    ['X4 sp_help 业务过程不在名单', "SELECT sp_help FROM t", true], // sp_help 不在 DANGEROUS_SP_PROCS

    // ===== 多语句（应拒绝）=====
    ['M1 中间分号', 'SELECT 1; DROP TABLE foo;', false],
    ['M2 双分号', 'SELECT 1;;', false],
    ['M3 开头分号', '; SELECT 1', false],

    // ===== 非 SELECT/WITH 首关键字（应拒绝）=====
    ['F1 INSERT', 'INSERT INTO t VALUES(1)', false],
    ['F2 UPDATE', 'UPDATE t SET x=1', false],
    ['F3 DELETE', 'DELETE FROM t WHERE id=1', false],
    ['F4 CREATE', 'CREATE TABLE t (id INT)', false],
    ['F5 DROP', 'DROP TABLE t', false],

    // ===== 未闭合（应拒绝）=====
    ['U1 未闭合字符串', "SELECT 'abc FROM t", false],
    ['U2 未闭合方括号', 'SELECT [col FROM t', false],
    ['U3 未闭合双引号', 'SELECT "col FROM t', false],
    ['U4 未闭合块注释', 'SELECT 1 /* abc FROM t', false],

    // ===== 空输入 =====
    ['E1 仅空白', '   ', false],
    ['E2 仅注释', '-- abc', false],
];

let passed = 0, failed = 0;
const failures = [];

for (const [name, sql, expectOk] of CASES) {
    const r = layer0(sql);
    const ok = r.ok === expectOk;
    if (ok) {
        passed++;
        // console.log(`✅ ${name}`);
    } else {
        failed++;
        failures.push({ name, sql, expectOk, actual: r });
    }
}

console.log(`\n=== 层 0 词法状态机单测 ===`);
console.log(`总数: ${CASES.length}, 通过: ${passed}, 失败: ${failed}`);
if (failures.length > 0) {
    console.log('\n失败用例:');
    for (const f of failures) {
        console.log(`\n❌ [${f.name}]`);
        console.log(`   SQL: ${f.sql}`);
        console.log(`   期望: ${f.expectOk ? '通过' : '拒绝'}`);
        console.log(`   实际: ${JSON.stringify(f.actual)}`);
    }
    process.exit(1);
}
console.log('\n全部通过 ✅');
