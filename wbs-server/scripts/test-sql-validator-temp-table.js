/**
 * sql-validator.js 临时表静态拦截单测（v1.70.0 Step 2 方案 §1.4）
 *
 * 测试范围：
 *   - SQLSERVER_TEMP_TABLE_PATTERNS 4 个正则（INTO / FROM / JOIN / UPDATE + #/##）
 *   - MYSQL_TEMP_TABLE_PATTERN（TEMPORARY TABLE 关键字）
 *   - validateAndTransform layer 0.5 集成路径（确认 layer === 0 + code === 'TEMP_TABLE_NOT_ALLOWED'）
 *
 * 用法：node scripts/test-sql-validator-temp-table.js
 */

'use strict';

const { validateAndTransform, _internal } = require('../utils/sql-validator');
const { checkTempTable } = _internal;

// ============================================================================
// §1 直接调 checkTempTable helper（不走 validateAndTransform 路径）
// ============================================================================

// HELPER_CASES 说明：
//   - 直接调 checkTempTable() helper，不走 validateAndTransform 路径
//   - 因此能测到"集成路径不可达"的分支（如 UPDATE #tmp 在 validateAndTransform 里 layer 0
//     首 token 白名单已先拒；MySQL CREATE TEMPORARY TABLE 同理）
//   - 这些不可达用例保留作未来兜底：若未来放开 UPDATE/CREATE 白名单，临时表拦截仍能工作
//   - 标 [helper-only] 的用例 = 集成路径不可达，仅在 helper 层兜底
const HELPER_CASES = [
    // ===== SQL Server 应拒绝（4 模式 × #/## 共 8 条）=====
    ['S-INTO-1  SELECT ... INTO #tmp',                 'SELECT * INTO #tmp FROM bms_xxx',                'sqlserver', false],
    ['S-INTO-2  SELECT ... INTO ##tmp',                'SELECT * INTO ##global_tmp FROM bms_xxx',        'sqlserver', false],
    ['S-FROM-1  FROM #tmp',                            'SELECT * FROM #tmp',                             'sqlserver', false],
    ['S-FROM-2  FROM ##tmp',                           'SELECT * FROM ##global_tmp',                     'sqlserver', false],
    ['S-JOIN-1  JOIN #tmp',                            'SELECT * FROM t JOIN #tmp ON t.id = #tmp.id',    'sqlserver', false],
    ['S-JOIN-2  JOIN ##tmp',                           'SELECT * FROM t JOIN ##g ON t.id = ##g.id',      'sqlserver', false],
    ['S-UPD-1   UPDATE #tmp [helper-only]',            'UPDATE #tmp SET col=1',                          'sqlserver', false],
    ['S-UPD-2   UPDATE ##tmp [helper-only]',           'UPDATE ##g SET col=1',                           'sqlserver', false],

    // ===== SQL Server 方括号 quoted identifier（codex 25 审 #1 补）=====
    ['S-BRACKET-1 INTO [#tmp]',                        'SELECT * INTO [#tmp] FROM bms_xxx',              'sqlserver', false],
    ['S-BRACKET-2 FROM [##g]',                         'SELECT * FROM [##g]',                            'sqlserver', false],

    // ===== SQL Server 应通过（正常 SQL 不应误判）=====
    ['S-OK-1    普通 SELECT',                          'SELECT * FROM bms_xxx WHERE id = 1',             'sqlserver', true],
    ['S-OK-2    CTE 替代临时表',                        'WITH cte AS (SELECT * FROM t) SELECT * FROM cte', 'sqlserver', true],
    ['S-OK-3    子查询替代',                            'SELECT * FROM (SELECT id FROM t) sub',           'sqlserver', true],
    ['S-OK-4    列名含 # 字符（罕见但合法）',            'SELECT [col#1] FROM t',                          'sqlserver', true],
    ['S-OK-5    字符串内 #tmp 但无 FROM/INTO 前缀',     "SELECT 'use #tmp not allowed' AS msg FROM t",    'sqlserver', true],
    ['S-OK-6    三段名跨库引用',                        'SELECT * FROM business_db.dbo.t1',                      'sqlserver', true],

    // ===== MySQL 应拒绝（[helper-only] — 集成路径走 layer 0 首 token 白名单先拒）=====
    ['M-TEMP-1  TEMPORARY TABLE [helper-only]',        'CREATE TEMPORARY TABLE tmp AS SELECT 1',          'mysql',     false],
    ['M-TEMP-2  TEMPORARY  TABLE 多空格 [helper-only]', 'CREATE TEMPORARY  TABLE tmp AS SELECT 1',         'mysql',     false],

    // ===== MySQL 应通过 =====
    ['M-OK-1    普通 SELECT',                          'SELECT * FROM emp WHERE id = 1',                  'mysql',     true],
    ['M-OK-2    列名含 temporary 单词',                 'SELECT temporary_col FROM t',                     'mysql',     true],

    // ===== 跨方言：SQL Server 模式不应误伤 MySQL =====
    ['X-1       MySQL 含 # 字符（合法注释场景）',       'SELECT 1 # comment',                              'mysql',     true],

    // ===== 跨方言：MySQL TEMPORARY 不应误伤 SQL Server（SQL Server 没有 TEMPORARY 关键字）=====
    ['X-2       SQL Server 列名叫 TEMPORARY',          'SELECT TEMPORARY_col FROM t',                     'sqlserver', true],

    // ===== ⚠️ 已知误判用例（codex 25 审 #2，知情接受） =====
    //   helper 在原始 SQL 上跑正则，不跳字符串/注释；
    //   这 3 个用例显式证明当前行为是"误拒"（期望 expect=false，意为拒绝），
    //   用例命名前缀 NEG-* 表示"negative scenario where current impl rejects but
    //   semantically should accept"，未来若改用 tokenize 重建扫描串可逆转期望值
    ['NEG-1     字符串内含 "FROM #tmp" [已知误判]',    "SELECT 'FROM #tmp' AS msg FROM t",               'sqlserver', false],
    ['NEG-2     行注释含 "-- FROM #tmp" [已知误判]',   'SELECT 1 FROM t WHERE id=1 -- FROM #tmp',         'sqlserver', false],
    ['NEG-3     块注释含 "/* JOIN #tmp */" [已知误判]', 'SELECT 1 /* JOIN #tmp */ FROM t',                 'sqlserver', false],
];

// ============================================================================
// §2 走 validateAndTransform 集成路径
// ============================================================================

const INTEGRATION_CASES = [
    {
        name: 'I-1 SQL Server #tmp 走全链路 → layer 0 + TEMP_TABLE_NOT_ALLOWED',
        sql: 'SELECT * INTO #tmp FROM bms_xxx',
        opts: { dialect: 'sqlserver', allowedDb: 'business_db' },
        expect: r => r.ok === false && r.layer === 0 && r.code === 'TEMP_TABLE_NOT_ALLOWED',
    },
    {
        name: 'I-2 SQL Server FROM ##g 走全链路 → layer 0',
        sql: 'SELECT * FROM ##g',
        opts: { dialect: 'sqlserver', allowedDb: 'business_db' },
        expect: r => r.ok === false && r.layer === 0 && r.code === 'TEMP_TABLE_NOT_ALLOWED',
    },
    {
        name: 'I-3 MySQL CREATE TEMPORARY TABLE → layer 0 拦（首 token 白名单先拒，不到 0.5）',
        sql: 'CREATE TEMPORARY TABLE x AS SELECT 1',
        opts: { dialect: 'mysql', allowedDb: 'newhrd' },
        // 注：分层防御先拒 layer 0 首 token CREATE，不会走到 0.5 临时表拦截；
        // checkTempTable 在 MySQL 上的实际兜底场景是未来若放开 CREATE/INSERT 白名单时仍能拦
        expect: r => r.ok === false && r.layer === 0 && /首关键字必须是 SELECT 或 WITH/.test(r.reason || ''),
    },
    {
        name: 'I-4 健康 SQL Server SQL 通过全链路 → ok=true 含 smokeSql',
        sql: 'SELECT id, name FROM bms_xxx WHERE id = 1',
        opts: { dialect: 'sqlserver', allowedDb: 'business_db' },
        expect: r => r.ok === true && typeof r.smokeSql === 'string',
    },
    {
        name: 'I-5 健康 MySQL SQL 通过全链路 → ok=true 含 smokeSql',
        sql: 'SELECT id, name FROM emp WHERE id = 1',
        opts: { dialect: 'mysql', allowedDb: 'newhrd' },
        expect: r => r.ok === true && typeof r.smokeSql === 'string',
    },
];

// ============================================================================
// §3 跑测
// ============================================================================

let passed = 0, failed = 0;
const failures = [];

console.log('\n=== §1 checkTempTable helper 直接测试 ===');
for (const [name, sql, dialect, expectOk] of HELPER_CASES) {
    const r = checkTempTable(sql, dialect);
    const ok = r.ok === expectOk;
    if (ok) {
        passed++;
        console.log(`✅ ${name}`);
    } else {
        failed++;
        failures.push({ name, sql, dialect, expectOk, actual: r });
        console.log(`❌ ${name}`);
    }
}

console.log('\n=== §2 validateAndTransform 集成测试 ===');
for (const { name, sql, opts, expect } of INTEGRATION_CASES) {
    const r = validateAndTransform(sql, opts);
    const ok = expect(r);
    if (ok) {
        passed++;
        console.log(`✅ ${name}`);
    } else {
        failed++;
        failures.push({ name, sql, opts, actual: r });
        console.log(`❌ ${name}`);
    }
}

const total = HELPER_CASES.length + INTEGRATION_CASES.length;
console.log(`\n=== 临时表静态拦截单测 ===`);
console.log(`总数: ${total}, 通过: ${passed}, 失败: ${failed}`);
if (failures.length > 0) {
    console.log('\n失败详情:');
    for (const f of failures) {
        console.log(`\n❌ [${f.name}]`);
        console.log(`   SQL: ${f.sql}`);
        if (f.expectOk !== undefined) console.log(`   期望: ${f.expectOk ? '通过' : '拒绝'}`);
        console.log(`   实际: ${JSON.stringify(f.actual)}`);
    }
    process.exit(1);
}
console.log('\n全部通过 ✅');
