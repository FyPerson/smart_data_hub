/**
 * AST shape 探针脚本（D3 模块 3 编码前用）
 *
 * 目的：跑 10 条典型 T-SQL，输出 node-sql-parser v5.4.0 实际 AST shape。
 * 用途：为 sql-validator.js 实现层 2 AST walker 和层 3 TOP 注入提供"真相源"，
 *      避免凭文档/直觉写 AST 字段访问代码。
 *
 * 用法：node scripts/ast-snapshot-probe.js
 * 输出：每条 SQL → 状态（成功/失败）+ AST 顶层 type + 关键字段路径
 *
 * 关联：docs/local/codex审查记录/数据协作模块/09-D3-模块3-4层防御-取舍审-20260513.md（M1）
 */

'use strict';

const { Parser } = require('node-sql-parser');
const parser = new Parser();

const CASES = [
    // ===== 合法 SELECT（应通过）=====
    ['1-simple', 'SELECT * FROM bms_xxx WHERE id = 1'],
    ['2-top-existing', 'SELECT TOP 5 col1, col2 FROM bms_xxx ORDER BY id DESC'],
    ['3-order-by', 'SELECT col1 FROM bms_xxx ORDER BY id ASC'],
    ['4-cte-single', 'WITH cte AS (SELECT * FROM t1) SELECT * FROM cte JOIN t2 ON cte.id = t2.id'],
    ['5-cte-multi', 'WITH a AS (SELECT * FROM t1), b AS (SELECT * FROM t2) SELECT * FROM a JOIN b ON a.id = b.id'],
    ['6-union', 'SELECT col1 FROM t1 UNION SELECT col1 FROM t2'],
    ['7-three-part-bms', 'SELECT * FROM business_db.dbo.demo_table'],

    // ===== 危险但 parser 解析成功（应被层 2 拦）=====
    ['8-select-into', 'SELECT * INTO new_tbl FROM bms_xxx'],
    ['9-three-part-master', 'SELECT TOP 1 * FROM master.dbo.syslogins'],
    ['10-three-part-master-sql_logins', 'SELECT name FROM master.sys.sql_logins'],

    // ===== 多语句（应在层 0/层 1 拦）=====
    ['11-multi-statement', 'SELECT 1; DROP TABLE foo;'],
    ['12-trailing-semicolon', 'SELECT 1;'],
    ['13-double-semicolon', 'SELECT 1;;'],

    // ===== 危险且 parser 解析失败（应在层 0 拦）=====
    ['14-openrowset-bulk', "SELECT * FROM OPENROWSET(BULK 'C:/x', SINGLE_CLOB) AS x"],
    ['15-exec-xp', "EXEC xp_dirtree 'C:\\\\'"],
    ['16-waitfor', "WAITFOR DELAY '00:00:05'"],

    // ===== 字符串字面量含伪关键字（应通过，不能误判）=====
    ['17-string-with-keyword', "SELECT '请勿使用 xp_cmdshell 等' AS warning_msg, 1 AS id"],
    ['18-quoted-identifier', 'SELECT [xp_test] FROM bms_xxx'],
    ['19-bracket-identifier-content', 'SELECT id FROM [t1] WHERE [name] = \'a\''],

    // ===== INTO 在 CTE 内部（边界 case）=====
    ['20-into-in-cte', 'WITH cte AS (SELECT col1 FROM t1) SELECT * INTO new_tbl FROM cte'],
];

function summarize(value, depth = 0) {
    if (value === null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.length}]`;
    }
    return `{${Object.keys(value).join(',')}}`;
}

function describeTopLevel(ast) {
    if (Array.isArray(ast)) {
        return `ARRAY(len=${ast.length}, types=[${ast.map(x => x?.type).join(',')}])`;
    }
    if (!ast || typeof ast !== 'object') return String(ast);
    const lines = [`type=${ast.type}`];
    for (const key of ['with', 'top', 'into', 'orderby', 'from', '_next', 'union', 'columns', 'where']) {
        if (key in ast && ast[key] !== null) {
            lines.push(`  ${key} = ${summarize(ast[key])}`);
        }
    }
    return lines.join('\n');
}

function probeTableRefs(ast) {
    // 找所有 from 节点里的 table 引用，看 multipart name 的字段是什么（db / schema / table）
    const tables = [];
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        // from 数组里每个元素是 {db, schema, table, as, ...}
        if (node.from && Array.isArray(node.from)) {
            for (const t of node.from) {
                if (t.table || t.db || t.schema) {
                    tables.push({
                        db: t.db ?? null,
                        schema: t.schema ?? null,
                        table: t.table ?? null,
                        as: t.as ?? null
                    });
                }
            }
        }
        Object.values(node).forEach(walk);
    }
    walk(ast);
    return tables;
}

function probeIntoField(ast) {
    const intoNodes = [];
    function walk(node, path = 'root') {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
        if (node.into) {
            intoNodes.push({ path, into: summarize(node.into) });
        }
        for (const [k, v] of Object.entries(node)) {
            if (k === 'into') continue; // 已处理
            walk(v, `${path}.${k}`);
        }
    }
    walk(ast);
    return intoNodes;
}

console.log('='.repeat(72));
console.log('AST Shape Probe — node-sql-parser v5.4.0 transactsql');
console.log('='.repeat(72));

for (const [tag, sql] of CASES) {
    console.log(`\n[${tag}] ${sql}`);
    try {
        const ast = parser.astify(sql, { database: 'transactsql' });
        console.log('  ' + describeTopLevel(ast).split('\n').join('\n  '));

        // 表引用 probe
        const refs = probeTableRefs(Array.isArray(ast) ? ast[0] : ast);
        if (refs.length > 0) {
            console.log('  table refs:');
            refs.forEach(r => console.log(`    - db=${r.db ?? 'null'} schema=${r.schema ?? 'null'} table=${r.table ?? 'null'} as=${r.as ?? 'null'}`));
        }

        // INTO probe
        const intos = probeIntoField(Array.isArray(ast) ? ast[0] : ast);
        if (intos.length > 0) {
            console.log('  INTO fields:');
            intos.forEach(i => console.log(`    - ${i.path}: ${i.into}`));
        }
    } catch (e) {
        console.log(`  ❌ PARSE ERROR: ${e.message.split('\n')[0]}`);
    }
}

console.log('\n' + '='.repeat(72));
console.log('完成。请把上面输出贴回 D3 编码会话，作为 walker / 注入逻辑的事实依据。');
console.log('='.repeat(72));
