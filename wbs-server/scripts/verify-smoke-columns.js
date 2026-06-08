// 验证脚本：取数交付质量记录 v3.0 Commit C1 — runRealSmokeTest 加列名返回
// 用法：node scripts/verify-smoke-columns.js
// 覆盖：extractResultColumns 两方言列名提取 + 边界（零行/聚合/列顺序/防御性）+ 向后兼容
//   codex 70 H-1：整数样式列名按 meta.index 排序（非 Object.keys 乱序）
//   codex 70 H-2/M-2：mssql 对象 key 不支持重复列名（实证丢失）；列对齐用 Set 去重不受影响
//
// 说明：extractResultColumns 是纯函数，用 mock 的 mssql/mysql2 返回结构测。
//   mssql recordset.columns 形态：{ 列名: { index, name, ... } }（来自 COLMETADATA 元数据）
//   mysql2 fields 形态：[ { name, type, table, ... } ]
const assert = require('assert');
const { extractResultColumns } = require('../utils/collab-submit-helpers');
const { compareColumns } = require('../utils/column-alignment-checker');

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// ---- 构造 mock：mssql recordset.columns（对象形态）----
function mssqlResult(colNames, rowCount = 0) {
    const columns = {};
    colNames.forEach((name, i) => { columns[name] = { index: i, name }; });
    const recordset = [];
    recordset.length = rowCount;        // 模拟行数（columns 不依赖行数）
    recordset.columns = columns;
    return { recordset };
}
// ---- 构造 mock：mysql2 fields（数组形态）----
function mysqlFields(colNames) {
    return colNames.map(name => ({ name, type: 253, table: 't' }));
}

function main() {
    console.log('[SQL Server 列名提取]');

    // [基础] 正常多列
    assert.deepStrictEqual(
        extractResultColumns('sqlserver', mssqlResult(['结算ID', '金额', '部门'], 5)),
        ['结算ID', '金额', '部门'], 'mssql 基础列名提取失败');
    ok('SQL Server：基础多列名提取');

    // [零行命根子] 零行也能拿列名（recordset.columns 来自元数据非数据行）
    assert.deepStrictEqual(
        extractResultColumns('sqlserver', mssqlResult(['col_a', 'col_b'], 0)),
        ['col_a', 'col_b'], 'mssql 零行列名提取失败');
    ok('SQL Server：⭐ 零行查询也能拿列名（元数据非首行，M-3 命根子）');

    // [聚合/别名列] 聚合表达式列名按驱动原样返回
    assert.deepStrictEqual(
        extractResultColumns('sqlserver', mssqlResult(['总金额', 'cnt'], 1)),
        ['总金额', 'cnt'], 'mssql 聚合列名提取失败');
    ok('SQL Server：聚合/别名列按原样返回');

    // [col.name 优先于 key] 当 meta.name 存在用它
    const r1 = { recordset: Object.assign([], { columns: { 'KEY1': { index: 0, name: 'RealName1' } } }) };
    assert.deepStrictEqual(extractResultColumns('sqlserver', r1), ['RealName1'], 'meta.name 优先未生效');
    ok('SQL Server：meta.name 优先于对象 key');

    // [H-1 列顺序] ⭐ 整数样式列名：SELECT 'a' AS [2],'b' AS [0],'c' AS [1] → 应按 index 还原 2,0,1
    //   不能用 Object.keys（JS 对整数 key 强制升序排成 0,1,2，丢失 SELECT 顺序）。真实业务库已实证。
    const rIntCols = { recordset: Object.assign([], { columns: {
        '0': { index: 1, name: '0' },   // SELECT 第 2 列别名 [0]
        '1': { index: 2, name: '1' },   // SELECT 第 3 列别名 [1]
        '2': { index: 0, name: '2' },   // SELECT 第 1 列别名 [2]
    } }) };
    assert.deepStrictEqual(
        extractResultColumns('sqlserver', rIntCols),
        ['2', '0', '1'], 'H-1：整数样式列名应按 meta.index 还原 SELECT 顺序，非 Object.keys 升序');
    ok('SQL Server：⭐ H-1 整数样式列名按 meta.index 排序（2,0,1 非 0,1,2）');

    // [H-1 全缺 index] 全缺 index 时按原始枚举序（不崩）
    const rNoIndex = { recordset: Object.assign([], { columns: {
        'col_a': { name: 'col_a' }, 'col_b': { name: 'col_b' },
    } }) };
    assert.deepStrictEqual(extractResultColumns('sqlserver', rNoIndex), ['col_a', 'col_b'], 'H-1 全缺 index 失败');
    ok('SQL Server：H-1 全缺 index 按原始枚举序（不崩）');

    // [H-1 稳定降级] ⭐ 部分缺 index（codex 71 M-1）：有 index 的按 index 排，缺的用原始位置兜底，
    //   不整体回退 Object.keys（避免整数样式列名重新乱序）。这里 'b' 缺 index 应排到末尾。
    const rPartialIndex = { recordset: Object.assign([], { columns: {
        '2': { index: 1, name: '2' },        // 整数样式列名，有 index
        'b': { name: 'b' },                  // 缺 index → MAX_SAFE_INTEGER 排末尾
        '0': { index: 0, name: '0' },        // 整数样式列名，有 index
    } }) };
    assert.deepStrictEqual(
        extractResultColumns('sqlserver', rPartialIndex),
        ['0', '2', 'b'], 'H-1 部分缺 index 稳定降级失败');
    ok('SQL Server：⭐ H-1 部分缺 index 稳定降级（有 index 按 index 排 0,2，缺的 b 兜底末尾，不整体回退乱序）');

    // [H-1 非法 index] 负数/NaN 等非法 index 视为缺失，用原始位置兜底（codex 71 L-1 收紧 index 有效性）
    const rBadIndex = { recordset: Object.assign([], { columns: {
        'x': { index: -1, name: 'x' }, 'y': { index: 0, name: 'y' },
    } }) };
    assert.deepStrictEqual(extractResultColumns('sqlserver', rBadIndex), ['y', 'x'], 'H-1 非法 index 处理失败');
    ok('SQL Server：H-1 非法 index（负数）视为缺失兜底末尾');

    // [H-2 重复列名] 注意：本用例验证的是**下游 compareColumns 的 Set 语义**，不是 extractResultColumns
    //   提取重复列的能力（JS 对象字面量无法表达重复 key，mssql columns 对象天然丢重复列，已真实库实证）。
    //   契约（codex 71 M-2）：columns 仅用于列名集合完整性校验（T⊆S），不表达重复度/位置语义。
    const sqlColsWithDup = ['金额', '金额', '部门'];   // 模拟下游拿到含重复列的列名数组
    const cmpDup = compareColumns(['金额', '部门'], sqlColsWithDup);
    assert.strictEqual(cmpDup.complete, true, 'H-2：含重复列时列对齐仍正确（Set 去重）');
    ok('SQL Server：H-2 重复列对列对齐无害（compareColumns Set 去重，验下游 Set 语义非提取能力）');

    console.log('[MySQL 列名提取]');

    // [基础]
    assert.deepStrictEqual(
        extractResultColumns('mysql', null, mysqlFields(['结算ID', '金额'])),
        ['结算ID', '金额'], 'mysql 基础列名提取失败');
    ok('MySQL：基础列名提取（fields[].name）');

    // [零行] mysql fields 零行也有
    assert.deepStrictEqual(
        extractResultColumns('mysql', null, mysqlFields(['a', 'b', 'c'])),
        ['a', 'b', 'c'], 'mysql 零行列名提取失败');
    ok('MySQL：零行也能拿列名（fields 来自元数据）');

    console.log('[防御性边界]');

    // [防御] recordset 缺失 → []
    assert.deepStrictEqual(extractResultColumns('sqlserver', {}), [], 'mssql recordset 缺失应 []');
    assert.deepStrictEqual(extractResultColumns('sqlserver', null), [], 'mssql null 应 []');
    ok('防御：mssql recordset/result 缺失 → [] （不影响 smoke 成功）');

    // [防御] mysql fields 非数组 → []
    assert.deepStrictEqual(extractResultColumns('mysql', null, null), [], 'mysql fields null 应 []');
    assert.deepStrictEqual(extractResultColumns('mysql', null, undefined), [], 'mysql fields undefined 应 []');
    ok('防御：mysql fields 缺失 → []');

    // [防御] 未知方言 → []
    assert.deepStrictEqual(extractResultColumns('oracle', {}, []), [], '未知方言应 []');
    ok('防御：未知方言 → []');

    // [防御] mysql fields 含异常元素（无 name）→ 过滤掉
    assert.deepStrictEqual(
        extractResultColumns('mysql', null, [{ name: 'ok' }, { type: 1 }, null]),
        ['ok'], 'mysql 异常 field 应过滤');
    ok('防御：mysql fields 含无 name 元素 → 过滤');

    // [向后兼容] 现有 ok/rowCount/error 字段语义不变 —— extractResultColumns 只产出 columns，
    //   不碰 runRealSmokeTest 其他返回字段（此处仅断言函数职责单一：输入结果只输出列名数组）
    const cols = extractResultColumns('sqlserver', mssqlResult(['x'], 3));
    assert.ok(Array.isArray(cols), 'columns 应为数组');
    ok('向后兼容：extractResultColumns 只产出 columns 数组，不碰其他字段');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit C1 列名提取验证通过`);
}

try {
    main();
} catch (e) {
    console.error('\n[失败]', e.message, '\n', e.stack);
    process.exit(1);
}
