'use strict';

/**
 * MySQL 源类型 → SQL Server 目标类型 映射（ODS 贴源接入，v1.0 2026-06-22）
 *
 * 背景：模型中心新增 HRD（MySQL）作为 ODS 源系统。数仓目标始终是 SQL Server，
 *       平台生成 ODS 建表 DDL（先建表 → FDL 再灌数，FDL 不二次转换、不兼容即报错）。
 *
 * 设计原则（已与业务方确认）：
 *   1. 贴源不优化：varchar 实为数字也照搬，不在 ODS 转类型（标识 vs 度量的判断留 DWD 层）。
 *   2. 文本统一 NVARCHAR：HRD 满库中文，VARCHAR(非 Unicode) 可能静默乱码，是唯一绕过"报错"
 *      保护网的失败模式，必须在基线堵死。
 *   3. 安全优先：宁可类型宽一档（SMALLINT/BIGINT），不可截断/溢出。
 *   4. 冷门类型给合理默认 + 兜底 NVARCHAR(MAX)，撞上再按实际调整（反应式迭代）。
 *
 * codex 首审（2026-06-22）采纳项：DECIMAL 精度 >38 clamp（H-2）、enum/set 按 COLUMN_TYPE 解析长度
 * 防截断（M-2）、char >4000 → NVARCHAR(MAX)（M-3）、bit(n>1) → VARBINARY（L-1）。
 *
 * 返回契约（对齐 Model_Center.html generateODSDDLWithColumns 的装配逻辑）：
 *   { data_type, max_length, precision, scale, _warn? }
 *   - data_type 为 'NVARCHAR' / 'NCHAR'   → 前端按 max_length 装配长度（-1 = MAX）
 *   - data_type 为 'DECIMAL'              → 前端按 precision/scale 装配
 *   - 其余                                 → data_type 即完整 SQL Server 类型串，前端原样透传
 *   - _warn（可选）                         → 需要人工留意的映射（兜底/clamp/失真），调用方记 warn
 *
 * @param {Object} col - MySQL INFORMATION_SCHEMA.COLUMNS 单行
 *   需含 DATA_TYPE / COLUMN_TYPE / CHARACTER_MAXIMUM_LENGTH / NUMERIC_PRECISION / NUMERIC_SCALE
 * @returns {{data_type:string, max_length:(number|null), precision:(number|null), scale:(number|null), _warn?:string}}
 */

const NVARCHAR_MAX = 4000;   // SQL Server NVARCHAR 非 MAX 上限（字符数）
const NCHAR_MAX = 4000;      // SQL Server NCHAR 上限
const SQLSERVER_DECIMAL_MAX_PRECISION = 38; // SQL Server DECIMAL 精度上限（MySQL 可达 65）

/** 从 COLUMN_TYPE 解析 enum/set 字面量，估算目标列所需最大字符长度
 *  注：应传原始 COLUMN_TYPE（不要 lowercase，保字面量大小写语义） */
function enumSetMaxLen(columnType, isSet) {
    // columnType 形如 enum('a','bb') / set('x','yy')
    const ct = String(columnType || '');
    // L-1′：含反斜杠转义的字面量正则解析不可靠 → 直接走 NVARCHAR(MAX) 保险
    if (ct.includes('\\')) return -1;
    const literals = [];
    const re = /'((?:[^']|'')*)'/g;
    let m;
    while ((m = re.exec(ct)) !== null) {
        literals.push(m[1].replace(/''/g, "'"));
    }
    if (literals.length === 0) return -1; // 解析不出 → 走 MAX
    if (isSet) {
        // set 可存任意成员组合：所有成员长度之和 + (n-1) 个逗号
        const total = literals.reduce((s, x) => s + x.length, 0) + Math.max(0, literals.length - 1);
        return total > NVARCHAR_MAX ? -1 : total;
    }
    // enum 存单个成员：取最长成员
    const maxLen = literals.reduce((s, x) => Math.max(s, x.length), 0);
    return maxLen > NVARCHAR_MAX ? -1 : maxLen;
}

/** 从 COLUMN_TYPE 解析 bit(n) 的位数 */
function bitLen(columnType) {
    const m = /bit\((\d+)\)/.exec(columnType);
    return m ? parseInt(m[1], 10) : 1;
}

function mapMysqlColumnToSqlServer(col) {
    const dataType = String(col.DATA_TYPE || '').toLowerCase();
    const columnType = String(col.COLUMN_TYPE || '').toLowerCase();
    const isUnsigned = columnType.includes('unsigned');
    const charLen = col.CHARACTER_MAXIMUM_LENGTH;
    const numPrec = col.NUMERIC_PRECISION;
    const numScale = col.NUMERIC_SCALE;

    // 完整类型串直通（前端原样透传）
    const whole = (t, warn) => ({ data_type: t, max_length: null, precision: null, scale: null, ...(warn ? { _warn: warn } : {}) });
    // NVARCHAR/NCHAR：前端按 max_length 装配（-1 = MAX）
    const nchar = (base, len) => ({ data_type: base, max_length: len, precision: null, scale: null });

    switch (dataType) {
        // ===== 整数 =====
        case 'tinyint':
            // MySQL tinyint 有符号 -128~127；SQL Server TINYINT 仅 0~255 装不下负数 → SMALLINT 保险
            return whole('SMALLINT');
        case 'smallint':
            return whole(isUnsigned ? 'INT' : 'SMALLINT'); // smallint unsigned 0~65535 超 SMALLINT
        case 'mediumint':
            return whole('INT');
        case 'int':
        case 'integer':
            return whole(isUnsigned ? 'BIGINT' : 'INT'); // int unsigned 42 亿 > INT 上限 → BIGINT
        case 'bigint':
            return isUnsigned
                ? { data_type: 'DECIMAL', max_length: null, precision: 20, scale: 0 }
                : whole('BIGINT');

        // ===== 小数 / 浮点 =====
        case 'decimal':
        case 'numeric': {
            const p = numPrec || 18;
            const s = numScale || 0;
            // H-2 / M-2′：SQL Server DECIMAL 精度上限 38，MySQL 可达 65。
            // clamp 成 DECIMAL(38,s) 会丢整数位 → FDL 灌数仍可能溢出；故 >38 改 NVARCHAR(MAX) 保值
            // （贴源不溢出，下游 DWD 再 TRY_CONVERT）。HRD 实测无 >38。
            if (p > SQLSERVER_DECIMAL_MAX_PRECISION) {
                return { data_type: 'NVARCHAR', max_length: -1, precision: null, scale: null, _warn: `decimal_precision_${numPrec}_gt38_as_nvarchar` };
            }
            return { data_type: 'DECIMAL', max_length: null, precision: p, scale: s };
        }
        case 'float':
            return whole('REAL');
        case 'double':
        case 'double precision':
        case 'real':
            return whole('FLOAT'); // SQL Server 无 DOUBLE

        // ===== 日期时间 =====
        case 'date':
            return whole('DATE');
        case 'datetime':
            return whole('DATETIME2');
        case 'timestamp':
            return whole('DATETIME2'); // ⚠️ 绝不能映射 SQL Server TIMESTAMP（rowversion）
        case 'time':
            return whole('TIME');
        case 'year':
            return whole('SMALLINT');

        // ===== 字符 / 文本（统一 NVARCHAR 防中文乱码）=====
        case 'char':
            // M-3：char 超 NCHAR 上限不静默缩短，改 NVARCHAR(MAX)（标准 MySQL char ≤255 一般不触发）
            return (charLen && charLen > NCHAR_MAX)
                ? nchar('NVARCHAR', -1)
                : nchar('NCHAR', (charLen && charLen > 0) ? charLen : 1);
        case 'varchar':
            return nchar('NVARCHAR', (charLen && charLen > NVARCHAR_MAX) ? -1 : (charLen || 255));
        case 'tinytext':
        case 'text':
        case 'mediumtext':
        case 'longtext':
            return nchar('NVARCHAR', -1);

        // ===== 二进制（少见，返回完整串）=====
        case 'binary':
            return whole(`BINARY(${(charLen && charLen > 0) ? Math.min(charLen, 8000) : 1})`);
        case 'varbinary':
            return whole((charLen && charLen > 8000) ? 'VARBINARY(MAX)' : `VARBINARY(${(charLen && charLen > 0) ? charLen : 1})`);
        case 'tinyblob':
        case 'blob':
        case 'mediumblob':
        case 'longblob':
            return whole('VARBINARY(MAX)');

        // ===== MySQL 特有 =====
        case 'enum': {
            // M-2：按原始 COLUMN_TYPE 解析最长成员，防固定长度截断（L-1′：传原始大小写）
            const len = enumSetMaxLen(col.COLUMN_TYPE, false);
            return nchar('NVARCHAR', len === -1 ? -1 : Math.max(len, 1));
        }
        case 'set': {
            const len = enumSetMaxLen(col.COLUMN_TYPE, true);
            return nchar('NVARCHAR', len === -1 ? -1 : Math.max(len, 1));
        }
        case 'json':
            return nchar('NVARCHAR', -1);
        case 'bit': {
            // L-1：bit(1) → BIT；bit(n>1) 是位串 → VARBINARY(⌈n/8⌉) + warn
            const n = bitLen(columnType);
            return n > 1
                ? whole(`VARBINARY(${Math.ceil(n / 8)})`, `bit(${n})_as_varbinary`)
                : whole('BIT');
        }

        // ===== 兜底：未知类型 → NVARCHAR(MAX) 贴源存原值，不让 DDL 直接崩 =====
        default:
            return { data_type: 'NVARCHAR', max_length: -1, precision: null, scale: null, _warn: `unmapped_type_${dataType}` };
    }
}

module.exports = { mapMysqlColumnToSqlServer };
