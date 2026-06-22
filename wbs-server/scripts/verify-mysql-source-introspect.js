'use strict';

/**
 * verify-mysql-source-introspect.js
 * 验证 ODS 验收·MySQL 源内省 SQL 构造（utils/mysql-source-introspect.js）。
 * 纯逻辑断言，不连库 —— 覆盖标识符转义 / 表名解析 / 行数 & 主键 SQL 构造 + 注入边界。
 *
 * 运行：node scripts/verify-mysql-source-introspect.js
 */

const assert = require('assert');
const {
    quoteMysqlIdent,
    splitMysqlTable,
    buildMysqlSourceCount,
    buildMysqlSourcePk,
} = require('../utils/mysql-source-introspect');

let pass = 0;
let fail = 0;

function check(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        pass++;
    } catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        fail++;
    }
}

console.log('=== MySQL 源内省 SQL 构造 verify ===\n');

console.log('[标识符转义 quoteMysqlIdent]');
check('普通名加反引号包裹', () => {
    assert.strictEqual(quoteMysqlIdent('b_sys_user'), '`b_sys_user`');
});
check('内部反引号双写转义（防注入）', () => {
    assert.strictEqual(quoteMysqlIdent('a`b'), '`a``b`');
});
check('反引号闭合注入尝试被中和', () => {
    // 试图用 ` 提前闭合再注入 → 双写后整体仍是单一标识符
    assert.strictEqual(quoteMysqlIdent('t`; DROP TABLE x; --'), '`t``; DROP TABLE x; --`');
});

console.log('\n[表名解析 splitMysqlTable]');
check('裸表名用缺省库', () => {
    assert.deepStrictEqual(splitMysqlTable('b_sys_user', 'newhrd'), { db: 'newhrd', table: 'b_sys_user' });
});
check('db.table 前段库名优先于缺省库', () => {
    assert.deepStrictEqual(splitMysqlTable('otherdb.t_emp', 'newhrd'), { db: 'otherdb', table: 't_emp' });
});
check('两侧空白被 trim', () => {
    assert.deepStrictEqual(splitMysqlTable('  newhrd . b_sys_user ', 'fallback'), { db: 'newhrd', table: 'b_sys_user' });
});
check('结尾点不当作分隔（落回缺省库）', () => {
    assert.deepStrictEqual(splitMysqlTable('weird.', 'newhrd'), { db: 'newhrd', table: 'weird.' });
});

console.log('\n[行数 SQL buildMysqlSourceCount]');
check('裸表名 → 反引号库.表 + 别名 cnt', () => {
    const { sql, params } = buildMysqlSourceCount('b_sys_user', 'newhrd');
    assert.strictEqual(sql, 'SELECT COUNT(*) AS cnt FROM `newhrd`.`b_sys_user`');
    assert.deepStrictEqual(params, []);
});
check('db.table 覆盖缺省库', () => {
    const { sql } = buildMysqlSourceCount('otherdb.t_emp', 'newhrd');
    assert.strictEqual(sql, 'SELECT COUNT(*) AS cnt FROM `otherdb`.`t_emp`');
});
check('恶意表名被反引号转义包裹（无裸注入）', () => {
    const { sql } = buildMysqlSourceCount('x`; DROP TABLE y; --', 'newhrd');
    assert.ok(sql.includes('`x``; DROP TABLE y; --`'), `实得 ${sql}`);
    assert.ok(!/DROP TABLE y; --$/.test(sql.replace(/`[^`]*`/g, '')), '反引号外不应残留裸 SQL');
});

console.log('\n[主键 SQL buildMysqlSourcePk]');
check('information_schema.STATISTICS + PRIMARY + 参数化', () => {
    const { sql, params } = buildMysqlSourcePk('b_sys_user', 'newhrd');
    assert.ok(/information_schema\.STATISTICS/i.test(sql), 'should query STATISTICS');
    assert.ok(/INDEX_NAME\s*=\s*'PRIMARY'/i.test(sql), "should filter INDEX_NAME='PRIMARY'");
    assert.ok(/ORDER BY SEQ_IN_INDEX/i.test(sql), 'should order by SEQ_IN_INDEX');
    assert.ok(/COLUMN_NAME AS pk_column/i.test(sql), 'alias should be pk_column');
    assert.deepStrictEqual(params, ['newhrd', 'b_sys_user']);
});
check('db.table 主键查询用前段库作参数', () => {
    const { params } = buildMysqlSourcePk('otherdb.t_emp', 'newhrd');
    assert.deepStrictEqual(params, ['otherdb', 't_emp']);
});
check('主键 SQL 不含裸表名拼接（schema/table 走参数）', () => {
    const { sql } = buildMysqlSourcePk('b_sys_user', 'newhrd');
    assert.ok(!sql.includes('b_sys_user'), '表名不应出现在 SQL 文本（应在 params）');
});

console.log('\n[非空校验 assertNonEmptyDbTable（L-1）]');
check('行数构造：空库名抛带上下文错误', () => {
    assert.throws(() => buildMysqlSourceCount('b_sys_user', ''), /库名\/表名为空/);
});
check('行数构造：空表名抛带上下文错误', () => {
    assert.throws(() => buildMysqlSourceCount('', 'newhrd'), /库名\/表名为空/);
});
check('主键构造：空库名抛带上下文错误', () => {
    assert.throws(() => buildMysqlSourcePk('b_sys_user', ''), /库名\/表名为空/);
});
check('正常输入不抛错（回归）', () => {
    assert.doesNotThrow(() => buildMysqlSourceCount('b_sys_user', 'newhrd'));
    assert.doesNotThrow(() => buildMysqlSourcePk('otherdb.t_emp', 'newhrd'));
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
