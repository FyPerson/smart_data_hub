'use strict';

/**
 * 数据协作 sql_validation_status —— 唯一枚举源（C1·G1）
 *
 * 背景：sql_validation_status 当前无 DB CHECK 约束（v1.70.4 codex 30 审 #1 已声明），应用层
 * 此前也无白名单——server.js 十余处写入点各自写字面量，靠人读一致。本模块是"合法取值集合"
 * 的唯一真相源：
 *   - 前端 public/Data_Collab.html 的 SQL_VALIDATION_LABELS / renderValidationSection /
 *     collabExportValidationStatus 三处枚举分支
 *   - 后端全部写入点（经 assertSqlValidationStatus 过一遍）
 *   - 静态覆盖守卫 scripts/verify-collab-validation-status-coverage.js（G1）
 * 三者都以本文件为准，改枚举先改这里。
 *
 * 新增值 external_skipped（数据协作接入外部源 v1.6 方案 §3.1 D1）：
 *   外部系统登记为数据源（db_connections.type='external'）时，平台无法连接对方库跑 smoke
 *   test，交付以开发/系统自行提供的结果文件为准——不复用 bypassed。两者成因不同：bypassed
 *   是"admin 人工背书豁免一次失败的校验"，external_skipped 是"结构性无法校验"，语义不能合并。
 */

// 全量合法取值（顺序：正常生命周期 queued→running→{passed|failed}，
//   再是三条行政/旁路终态 admin_closed / bypassed / external_skipped）
const SQL_VALIDATION_STATUSES = Object.freeze([
    'queued', 'running', 'failed', 'passed', 'admin_closed', 'bypassed', 'external_skipped',
]);

// 校验模式（方案 §3.1）：smoke = 正常连库跑 smoke test；external_skip = 登记外部源，跳过 smoke
const VALIDATION_MODES = Object.freeze({
    smoke: 'smoke',
    external_skip: 'external_skip',
});

/**
 * 校验 sql_validation_status 取值合法性。
 *
 * @param {*} value                    待校验值
 * @param {{allowNull?: boolean}} [opts]  allowNull=true 时 null/undefined 视为合法（清空路径）
 * @returns {string|null} 合法字面量原样返回；allowNull 放行时返回 null
 * @throws {Error} 值不在枚举内（且未被 allowNull 放行）时抛错，err.code='INVALID_SQL_VALIDATION_STATUS'
 */
function assertSqlValidationStatus(value, opts) {
    const allowNull = !!(opts && opts.allowNull);
    if (value === null || value === undefined) {
        if (allowNull) return null;
        const err = new Error(
            `sql_validation_status 不允许为 ${value === null ? 'null' : 'undefined'}（未显式传 allowNull:true）`
        );
        err.code = 'INVALID_SQL_VALIDATION_STATUS';
        throw err;
    }
    if (!SQL_VALIDATION_STATUSES.includes(value)) {
        const err = new Error(
            `非法 sql_validation_status 取值: ${JSON.stringify(value)}（允许值：${SQL_VALIDATION_STATUSES.join(', ')}）`
        );
        err.code = 'INVALID_SQL_VALIDATION_STATUS';
        throw err;
    }
    return value;
}

module.exports = { SQL_VALIDATION_STATUSES, VALIDATION_MODES, assertSqlValidationStatus };
