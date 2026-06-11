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

    // ===== v1.79.0 前导分号（;WITH/;SELECT 是 T-SQL 标准写法，放行单个前导分号）=====
    ['LS1 前导分号 + SELECT（放行）', '; SELECT 1', true],
    ['LS2 前导分号 + WITH CTE（放行，生产 #11 真实场景）', ';WITH cte AS (SELECT 1 AS a) SELECT * FROM cte', true],
    ['LS3 前导分号 + SELECT + 尾分号（放行）', '; SELECT 1;', true],
    ['LS4 前导分号无空格紧贴 SELECT（放行）', ';SELECT 1', true],
    // —— 攻击面：以下前导分号变体仍须拒绝 ——
    ['LS5 双前导分号（拒，剥一个后仍是 SEMICOLON）', ';; SELECT 1', false],
    ['LS6 前导分号 + DROP（拒，剥后非 SELECT/WITH）', '; DROP TABLE foo', false],
    ['LS7 前导分号 + SELECT + 中间分号注入（拒，中间分号触发多语句）', '; SELECT 1; DROP TABLE foo', false],
    ['LS8 仅一个分号（拒，无有效语句）', ';', false],
    ['LS9 前导分号 + INSERT（拒）', ';INSERT INTO t VALUES(1)', false],
    // —— codex 审 low-1：前导注释 + 前导空白种类一致性（layer0 去注释后第一个有效 token 是 SEMICOLON）——
    ['LS10 前导块注释 + ;WITH（放行）', '/* 取数说明 */ ;WITH c AS (SELECT 1 AS a) SELECT * FROM c', true],
    ['LS11 前导行注释 + ;SELECT（放行）', '-- 头注释\n;SELECT 1', true],
    ['LS12 前导 Tab/换行 + ;WITH（放行）', '\t\n ;WITH c AS (SELECT 1 AS a) SELECT * FROM c', true],
    ['LS13 前导注释 + 双分号（拒）', '/* x */ ;; SELECT 1', false],

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

// ===== v1.79.0 codex 复审 rec：位置法精确性断言 =====
//   leadingSemicolonStart 必须精确指向"前导分号"的字符位置（非注释内分号、非别的字符），
//   按位置删字符后注释内容完整保留——把 medium-1 的契约钉死，防 tokenizer 改动引入偏移。
const POS_CASES = [
    ['PL1 前导块注释 + ;WITH', '/* 取数说明 */ ;WITH c AS (SELECT 1 AS a) SELECT * FROM c'],
    ['PL2 前导行注释 + ;SELECT', '-- 头注释\n;SELECT 1'],
    ['PL3 无注释 ;WITH', ';WITH c AS (SELECT 1 AS a) SELECT * FROM c'],
    ['PL4 注释内含分号（应跳过注释内分号定位真前导分号）', '/* ; 注释里有分号 */ ;WITH c AS (SELECT 1 AS a) SELECT * FROM c'],
];
for (const [name, sql] of POS_CASES) {
    const r = layer0(sql, 'sqlserver');
    const pos = r.leadingSemicolonStart;
    const charOk = pos != null && sql[pos] === ';';
    const parseSql = pos != null ? sql.slice(0, pos) + sql.slice(pos + 1) : sql;
    const lenOk = pos != null && parseSql.length === sql.length - 1;
    // 注释内容保留（若有块注释）
    const commentMatch = sql.match(/\/\*[\s\S]*?\*\//);
    const commentOk = commentMatch ? parseSql.includes(commentMatch[0]) : true;
    const ok = charOk && lenOk && commentOk;
    if (ok) passed++;
    else { failed++; failures.push({ name, sql, expectOk: 'pos 精确', actual: { pos, char: pos != null ? sql[pos] : null, commentOk } }); }
}

console.log(`\n=== 层 0 词法状态机单测 ===`);
console.log(`总数: ${CASES.length + POS_CASES.length}（CASES ${CASES.length} + 位置法 ${POS_CASES.length}）, 通过: ${passed}, 失败: ${failed}`);
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
