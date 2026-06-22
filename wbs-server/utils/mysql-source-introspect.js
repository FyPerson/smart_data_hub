'use strict';

/**
 * MySQL 源系统内省 SQL 构造（ODS 验收·源表数据量对比 / 无主键反查源主键，v1.0 2026-06-22）
 *
 * 背景：模型中心 v1.88.0 接入 HRD（MySQL）作为 ODS 源。ODS 验收里有两段需要回连"源系统"：
 *       ① 源表数据量对比（源行数 vs ODS 行数）② ODS 表无主键时反查源表主键。
 *       原实现写死 SQL Server 语法（sys.indexes / mssql .request().query()），对 MySQL 源跑不通。
 *       本模块只封装 MySQL 侧的 SQL 构造——SQL Server 分支在调用方原样保留（零回归）。
 *
 * 设计要点：
 *   1. 调用方按 dialect 分流，本模块只产出 MySQL 的 { sql, params }，由调用方用 mysql2
 *      的 `await pool.query(sql, params)` 执行（返回 [rows]，与 mssql 的 recordset 不同）。
 *   2. 列别名对齐 SQL Server 分支：行数用 `cnt`、主键用 `pk_column`，调用方取值统一。
 *   3. 表名（COUNT 的 FROM 子句）不能参数化 → 用反引号包裹 + 转义防注入/防特殊字符；
 *      information_schema 查询的 schema/table 走 ? 参数化。
 *   4. MySQL 无 dbo schema 层：schema = database。source_table 可为 `table` 或 `db.table`。
 *
 * @module utils/mysql-source-introspect
 */

/**
 * MySQL 标识符反引号转义：`a`b` → `a``b`（内部反引号双写），整体用反引号包裹。
 * @param {string} name
 * @returns {string} 形如 `name`
 */
function quoteMysqlIdent(name) {
    return '`' + String(name).replace(/`/g, '``') + '`';
}

/**
 * 解析源表名为 { db, table }。
 * - `db.table` → 取前段为 db、后段为 table（前段优先于 defaultDb）
 * - `table`    → db = defaultDb
 * 仅按第一个 '.' 切分（MySQL 库名/表名本身不含 '.'）。
 * @param {string} sourceTable 源表名（可能含库名前缀）
 * @param {string} defaultDb   缺省库名（源连接的 database）
 * @returns {{db:string, table:string}}
 */
function splitMysqlTable(sourceTable, defaultDb) {
    const raw = String(sourceTable || '').trim();
    const idx = raw.indexOf('.');
    if (idx > 0 && idx < raw.length - 1) {
        return { db: raw.slice(0, idx).trim(), table: raw.slice(idx + 1).trim() };
    }
    return { db: String(defaultDb || '').trim(), table: raw };
}

/**
 * 校验解析出的库名/表名非空。为空抛带上下文的错误（调用方在 try 内捕获 → 验收详情可诊断，
 * 不改变降级链）。现实中 source_table 是建模必填、database 是连接必填，此校验为 fail-fast 防御。
 * @param {string} db
 * @param {string} table
 */
function assertNonEmptyDbTable(db, table) {
    if (!db || !table) {
        throw new Error(`MySQL 源库名/表名为空（db="${db}", table="${table}"）：请检查源连接 database 与模型 source_table 配置`);
    }
}

/**
 * 构造 MySQL 源表行数查询。
 * @param {string} sourceTable
 * @param {string} defaultDb
 * @returns {{sql:string, params:Array}} 结果集列别名 cnt
 */
function buildMysqlSourceCount(sourceTable, defaultDb) {
    const { db, table } = splitMysqlTable(sourceTable, defaultDb);
    assertNonEmptyDbTable(db, table);
    const fq = `${quoteMysqlIdent(db)}.${quoteMysqlIdent(table)}`;
    return { sql: `SELECT COUNT(*) AS cnt FROM ${fq}`, params: [] };
}

/**
 * 构造 MySQL 源表主键查询（information_schema.STATISTICS，主键索引名恒为 PRIMARY）。
 * @param {string} sourceTable
 * @param {string} defaultDb
 * @returns {{sql:string, params:Array}} 结果集列别名 pk_column，按主键列顺序
 */
function buildMysqlSourcePk(sourceTable, defaultDb) {
    const { db, table } = splitMysqlTable(sourceTable, defaultDb);
    assertNonEmptyDbTable(db, table);
    const sql = `SELECT COLUMN_NAME AS pk_column
                 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
                 ORDER BY SEQ_IN_INDEX`;
    return { sql, params: [db, table] };
}

module.exports = {
    quoteMysqlIdent,
    splitMysqlTable,
    buildMysqlSourceCount,
    buildMysqlSourcePk,
};
