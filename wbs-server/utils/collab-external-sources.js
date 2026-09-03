'use strict';

/**
 * 数据协作接入外部源 —— 常量与判定模块（C1）
 *
 * 权威源：docs/local/数据协作模块/数据协作接入小程序_方案_20260902_v1.6.md §3.1（权威常量与
 * 枚举断言）。本批（C1）只建模块、不接线到 server.js / 连接管理端点——接线属 C2。
 */

// db_connections.type 里代表"外部登记源"的取值（与既有 sqlserver/mysql 并列）
const EXTERNAL_DB_CONNECTION_TYPE = 'external';

// C2b 待接线到 POST/PUT/test-new 等 db_connections 写入口的 type 白名单（方案 §3.1）。
//   〔R1 返工·2026-09-02 措辞更正〕现状写入口**没有**白名单：server.js 8384-8409
//   `POST /api/db-connections` 落库逻辑是 `type || 'sqlserver'` 直接写列（8407 行），任意字符串
//   都能落库成 type 值。仓内既有 4 处 `type IN ('sqlserver','mysql')`
//   （server.js:14339 /source、14362 /lookup、16150 /submit 阶段二、19431 admin-fix 连接查询）
//   **全部是读侧**过滤谓词，不构成"写侧已有白名单"——这句注释此前措辞含糊，容易被读成"写侧也已
//   有防护"，特此更正：本常量目前只是"待接线"的目标集合，本批（C1）尚未接到任何写入口。
//
//   〔R2 返工·2026-09-03 codex 04 审 H1 驳回其"external 应可写"结论〕D15 拍板：external 类型
//   **只能**由种子/初始化脚本直接写 db_connections（如 G2 种子夹具），生产 HTTP 写入口
//   （POST/PUT /api/db-connections）C2b 接线时**有意排除** external——不允许任意用户凭空登记
//   一个"免 smoke"外部源（那等于绕开业务侧对"哪些外部系统可信任其自报数据"的把关）。
//   本常量与下方 DB_CONNECTION_TYPES_RELATIONAL 当前取值恰好相同（都是 ['sqlserver','mysql']），
//   但两者语义/职责不同、并非同一个常量的两个名字：
//     - DB_CONNECTION_TYPES_WRITABLE  = 写入口白名单（"HTTP 建/改连接允许落库成什么 type"，C2b 待接线）
//     - DB_CONNECTION_TYPES_RELATIONAL = 关系型连接链集合（"能真连库跑 smoke test 的 type 值"，
//       供 externalSourceSqlFilter 生成 SQL 过滤片段的关系型半支）
//   未来任一方向独立演进（如新增关系型方言但暂不开放写入口、或写入口先开放但暂不支持真连库校验）
//   都不会牵动另一半——同值是当前巧合，不是可以合并的理由。
const DB_CONNECTION_TYPES_WRITABLE = Object.freeze(['sqlserver', 'mysql']);

// 关系型数据库类型集合——用于 externalSourceSqlFilter 生成"关系型 OR 已登记外部源"过滤条件的
// 关系型半支（能真连库解密密码、建连接池、跑 smoke test 的 type 值）。与上方
// DB_CONNECTION_TYPES_WRITABLE 职责不同，见其注释。
const DB_CONNECTION_TYPES_RELATIONAL = Object.freeze(['sqlserver', 'mysql']);

// 已登记的「免 smoke」外部源 source_system_code 白名单（本期仅小程序「智荟人力」一个）
const EXTERNAL_SKIP_SMOKE_SOURCE_CODES = Object.freeze(['MINIAPP_ZHHL']);

// source_system_code 格式约束——仅约束 POST 新建行（D22）：大写字母/数字/下划线，2-32 位
const SOURCE_SYSTEM_CODE_PATTERN = /^[A-Z0-9_]{2,32}$/;

/**
 * 判定一个 db_connections 行是否为"已登记的免 smoke 外部源"。
 * 精确相等比对（不 trim、不做大小写归一）——source_system_code 由建单方录入，
 * 归一化会让"看起来一样但实际有空白差异"的值被误判为已登记。
 *
 * @param {object} conn  db_connections 行（至少含 type / connection_type / source_system_code）
 * @returns {boolean}
 */
function isRegisteredExternalSource(conn) {
    return !!(
        conn
        && conn.type === EXTERNAL_DB_CONNECTION_TYPE
        && conn.connection_type === 'source'
        && typeof conn.source_system_code === 'string'
        && EXTERNAL_SKIP_SMOKE_SOURCE_CODES.includes(conn.source_system_code)
    );
}

/**
 * 写入口白名单判定；undefined/null/'' 视为未提供由调用方缺省。
 *
 * 供 POST/PUT/test-new /api/db-connections 等写入口统一调用，把"type 未提供 → 放行给调用方
 * 缺省成 sqlserver"与"type 提供了但不在白名单 → 拒绝"这两条判断收进同一个函数，避免三处调用点
 * 各写一遍完整条件表达式（`type !== undefined && type !== null && type !== '' &&
 * !DB_CONNECTION_TYPES_WRITABLE.includes(type)`）导致后续白名单集合变化时要改三处。
 *
 * @param {*} t  请求体里的 type 字段原始值（未做任何归一化）
 * @returns {boolean} true = 允许（含"未提供"这个特例）；false = 显式提供了越界值，调用方应 400
 */
function isWritableDbType(t) {
    if (t === undefined || t === null || t === '') {
        return true;
    }
    return DB_CONNECTION_TYPES_WRITABLE.includes(t);
}

/**
 * 生成 SQL 过滤片段：关系型（sqlserver/mysql）∪ 已登记外部源。
 *
 * 〔R1 返工·2026-09-02 口径更正〕**片段只含 type 维度，不含 connection_type 判断**——调用方
 * 必须自行在 WHERE 里 AND 上 `connection_type = 'source'`。仓内四处既有谓词都是
 * `connection_type = 'source' AND type IN (...)` 的形态（server.js:14339 /source、14362
 * /lookup、16150 /submit 阶段二、19431 admin-fix 连接查询），本片段只替换其中 `type IN (...)`
 * 那一半——`connection_type = 'source'` 仍由调用方自己拼在旁边，不要被本函数名或旧版 JSDoc
 * （曾写"可作为数据协作目标库的过滤片段"，容易读成"整条 WHERE 都齐了"）误导成"直接替换整个
 * WHERE"。
 *
 * 关系型部分直接拼字面量（来自受控常量 DB_CONNECTION_TYPES_RELATIONAL，非外部输入，无注入面）；
 * 外部源部分用占位符参数化（source_system_code 走白名单值，仍走参数化）。
 *
 * @returns {{sql: string, params: string[]}}
 *   sql:    "(type IN ('sqlserver','mysql') OR (type = 'external' AND source_system_code IN (?)))"
 *   params: 占位符个数 = EXTERNAL_SKIP_SMOKE_SOURCE_CODES 的登记码个数，顺序与 IN (...) 一致
 * @throws {Error} EXTERNAL_SKIP_SMOKE_SOURCE_CODES 为空时抛错——防止生成 `IN ()`：SQLite 对
 *   空 IN 列表恒判不匹配，会让 OR 的外部源半支静默失效且调用方毫无察觉（不抛错、不报错，
 *   只是查询结果里外部源永远查不到），比在源头抛错更难定位。
 */
function externalSourceSqlFilter() {
    if (EXTERNAL_SKIP_SMOKE_SOURCE_CODES.length === 0) {
        const err = new Error('externalSourceSqlFilter: EXTERNAL_SKIP_SMOKE_SOURCE_CODES 为空，拒绝生成 IN () 这类恒假片段');
        err.code = 'EMPTY_EXTERNAL_SOURCE_CODES';
        throw err;
    }
    const relTypesSql = DB_CONNECTION_TYPES_RELATIONAL.map((t) => `'${t}'`).join(',');
    const codes = EXTERNAL_SKIP_SMOKE_SOURCE_CODES;
    const codePlaceholders = codes.map(() => '?').join(',');
    return {
        sql: `(type IN (${relTypesSql}) OR (type = '${EXTERNAL_DB_CONNECTION_TYPE}' AND source_system_code IN (${codePlaceholders})))`,
        params: [...codes],
    };
}

module.exports = {
    EXTERNAL_DB_CONNECTION_TYPE,
    DB_CONNECTION_TYPES_WRITABLE,
    DB_CONNECTION_TYPES_RELATIONAL,
    EXTERNAL_SKIP_SMOKE_SOURCE_CODES,
    SOURCE_SYSTEM_CODE_PATTERN,
    isRegisteredExternalSource,
    isWritableDbType,
    externalSourceSqlFilter,
};
