'use strict';

/**
 * verify-mysql-type-mapper.js
 * 验证 MySQL 源类型 → SQL Server 目标类型 映射（utils/mysql-type-mapper.js）。
 * 纯逻辑断言，不连库 —— 覆盖基线映射 + 已知坑 + codex 首审采纳的边界用例。
 *
 * 运行：node scripts/verify-mysql-type-mapper.js
 */

const assert = require('assert');
const { mapMysqlColumnToSqlServer } = require('../utils/mysql-type-mapper');

let pass = 0;
let fail = 0;

function check(name, col, exp) {
    try {
        const got = mapMysqlColumnToSqlServer(col);
        assert.strictEqual(got.data_type, exp.data_type, `${name}: data_type 期望 ${exp.data_type} 实得 ${got.data_type}`);
        if ('max_length' in exp) assert.strictEqual(got.max_length, exp.max_length, `${name}: max_length 期望 ${exp.max_length} 实得 ${got.max_length}`);
        if ('precision' in exp) assert.strictEqual(got.precision, exp.precision, `${name}: precision 期望 ${exp.precision} 实得 ${got.precision}`);
        if ('scale' in exp) assert.strictEqual(got.scale, exp.scale, `${name}: scale 期望 ${exp.scale} 实得 ${got.scale}`);
        if ('warn' in exp) {
            if (exp.warn === true) assert.ok(got._warn, `${name}: 期望有 _warn 标记，实得无`);
            else if (exp.warn === false) assert.ok(!got._warn, `${name}: 期望无 _warn，实得 ${got._warn}`);
            else assert.ok(got._warn && got._warn.includes(exp.warn), `${name}: _warn 期望含 "${exp.warn}" 实得 ${got._warn}`);
        }
        console.log(`  ✓ ${name} → ${describe(got)}${got._warn ? ` [warn:${got._warn}]` : ''}`);
        pass++;
    } catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        fail++;
    }
}

function describe(g) {
    if (g.data_type === 'NVARCHAR' || g.data_type === 'NCHAR') return `${g.data_type}(${g.max_length === -1 ? 'MAX' : g.max_length})`;
    if (g.data_type === 'DECIMAL') return `DECIMAL(${g.precision},${g.scale})`;
    return g.data_type;
}

function col(dataType, opts = {}) {
    return {
        DATA_TYPE: dataType,
        COLUMN_TYPE: opts.columnType || dataType,
        CHARACTER_MAXIMUM_LENGTH: 'charLen' in opts ? opts.charLen : null,
        NUMERIC_PRECISION: 'precision' in opts ? opts.precision : null,
        NUMERIC_SCALE: 'scale' in opts ? opts.scale : null
    };
}

console.log('=== MySQL → SQL Server 类型映射 verify ===\n');

console.log('[整数]');
check('tinyint → SMALLINT', col('tinyint', { columnType: 'tinyint(4)' }), { data_type: 'SMALLINT' });
check('tinyint(1) → SMALLINT(不假设布尔)', col('tinyint', { columnType: 'tinyint(1)' }), { data_type: 'SMALLINT' });
check('smallint → SMALLINT', col('smallint', { columnType: 'smallint(6)' }), { data_type: 'SMALLINT' });
check('smallint unsigned → INT', col('smallint', { columnType: 'smallint(5) unsigned' }), { data_type: 'INT' });
check('mediumint → INT', col('mediumint', { columnType: 'mediumint(9)' }), { data_type: 'INT' });
check('int → INT', col('int', { columnType: 'int(11)' }), { data_type: 'INT' });
check('int unsigned → BIGINT(防 42 亿溢出)', col('int', { columnType: 'int(10) unsigned' }), { data_type: 'BIGINT' });
check('bigint → BIGINT', col('bigint', { columnType: 'bigint(20)' }), { data_type: 'BIGINT' });
check('bigint unsigned → DECIMAL(20,0)', col('bigint', { columnType: 'bigint(20) unsigned' }), { data_type: 'DECIMAL', precision: 20, scale: 0 });

console.log('\n[小数/浮点]');
check('decimal(10,2) → DECIMAL(10,2)', col('decimal', { columnType: 'decimal(10,2)', precision: 10, scale: 2 }), { data_type: 'DECIMAL', precision: 10, scale: 2, warn: false });
check('decimal 无精度 → DECIMAL(18,0)', col('decimal', { columnType: 'decimal' }), { data_type: 'DECIMAL', precision: 18, scale: 0 });
check('float → REAL', col('float'), { data_type: 'REAL' });
check('double → FLOAT', col('double'), { data_type: 'FLOAT' });

console.log('\n[日期时间]');
check('date → DATE', col('date'), { data_type: 'DATE' });
check('datetime → DATETIME2', col('datetime'), { data_type: 'DATETIME2' });
check('timestamp → DATETIME2(不能变 rowversion)', col('timestamp'), { data_type: 'DATETIME2' });
check('time → TIME', col('time'), { data_type: 'TIME' });
check('year → SMALLINT', col('year'), { data_type: 'SMALLINT' });

console.log('\n[字符/文本：统一 NVARCHAR 防中文乱码]');
check('char(2) → NCHAR(2)', col('char', { charLen: 2 }), { data_type: 'NCHAR', max_length: 2 });
check('varchar(50) → NVARCHAR(50)', col('varchar', { charLen: 50 }), { data_type: 'NVARCHAR', max_length: 50 });
check('varchar(255) → NVARCHAR(255)', col('varchar', { charLen: 255 }), { data_type: 'NVARCHAR', max_length: 255 });
check('text → NVARCHAR(MAX)', col('text'), { data_type: 'NVARCHAR', max_length: -1 });
check('longtext → NVARCHAR(MAX)', col('longtext'), { data_type: 'NVARCHAR', max_length: -1 });

console.log('\n[二进制]');
check('varbinary(16) → VARBINARY(16)', col('varbinary', { charLen: 16 }), { data_type: 'VARBINARY(16)' });
check('blob → VARBINARY(MAX)', col('blob'), { data_type: 'VARBINARY(MAX)' });

console.log('\n[codex 首审采纳的边界用例]');
// H-2 / M-2′：DECIMAL 精度 >38 → NVARCHAR(MAX) 保值（clamp 会丢整数位致溢出）
check('decimal(65,30) → NVARCHAR(MAX)+warn(M-2′ 保值不溢出)', col('decimal', { columnType: 'decimal(65,30)', precision: 65, scale: 30 }), { data_type: 'NVARCHAR', max_length: -1, warn: 'gt38' });
check('decimal(38,2) 边界内 → DECIMAL(38,2)', col('decimal', { columnType: 'decimal(38,2)', precision: 38, scale: 2 }), { data_type: 'DECIMAL', precision: 38, scale: 2, warn: false });
// M-3：char/varchar >4000 → NVARCHAR(MAX)
check('varchar(5000) → NVARCHAR(MAX)(M-3)', col('varchar', { charLen: 5000 }), { data_type: 'NVARCHAR', max_length: -1 });
check('char(5000) → NVARCHAR(MAX)(M-3，不静默缩 NCHAR(4000))', col('char', { charLen: 5000 }), { data_type: 'NVARCHAR', max_length: -1 });
// M-2：enum/set 按 COLUMN_TYPE 解析长度，防固定截断
check('enum 解析最长成员(M-2)', col('enum', { columnType: "enum('草稿','已提交','已完成')" }), { data_type: 'NVARCHAR', max_length: 3 });
check('set 解析成员组合上限(M-2)', col('set', { columnType: "set('a','bb','ccc')" }), { data_type: 'NVARCHAR', max_length: 8 });
check('enum 超长成员 → NVARCHAR(MAX)', col('enum', { columnType: "enum('" + 'x'.repeat(5000) + "')" }), { data_type: 'NVARCHAR', max_length: -1 });
// L-1：bit(1) → BIT；bit(n>1) → VARBINARY + warn
check('bit(1) → BIT', col('bit', { columnType: 'bit(1)' }), { data_type: 'BIT' });
check('bit(8) → VARBINARY(1)+warn(L-1)', col('bit', { columnType: 'bit(8)' }), { data_type: 'VARBINARY(1)', warn: 'bit' });
check('bit(16) → VARBINARY(2)+warn(L-1)', col('bit', { columnType: 'bit(16)' }), { data_type: 'VARBINARY(2)', warn: 'bit' });
check('varbinary(9000) → VARBINARY(MAX)', col('varbinary', { charLen: 9000 }), { data_type: 'VARBINARY(MAX)' });
check('json → NVARCHAR(MAX)', col('json'), { data_type: 'NVARCHAR', max_length: -1 });

console.log('\n[兜底]');
check('未知类型 geometry → NVARCHAR(MAX)+warn', col('geometry'), { data_type: 'NVARCHAR', max_length: -1, warn: 'unmapped_type_geometry' });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
