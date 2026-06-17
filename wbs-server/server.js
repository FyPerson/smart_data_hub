const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const crypto = require('crypto');
const sql = require('mssql');
const compression = require('compression');
const packageJson = require('./package.json');
const dingtalkNotify = require('./utils/dingtalk-notify');
const issueNotify = require('./utils/issue-notify');  // v1.74.0 C2：需求跟踪钉钉通知 helper（纯封装）
const collabVersioning = require('./utils/collab-attachment-versioning');
const collabSubmitHelpers = require('./utils/collab-submit-helpers');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const DB_FILE = path.join(__dirname, 'task_pool.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ARCHIVE_DIR = path.join(__dirname, 'archive');

// 环境配置
require('dotenv').config();

// ==================== 日志级别控制 ====================
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;

const logger = {
    error: (...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR && console.error('[ERROR]', new Date().toISOString(), ...args),
    warn: (...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN && console.warn('[WARN]', new Date().toISOString(), ...args),
    info: (...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO && console.log('[INFO]', new Date().toISOString(), ...args),
    debug: (...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG && console.log('[DEBUG]', new Date().toISOString(), ...args)
};

// JWT配置
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const JWT_EXPIRES_IN = '8h';  // 登录有效期8小时

// ==================== 业务常量定义 ====================
// 任务类型（与前端保持一致）
const VALID_CATEGORIES = ['ODS_SYNC', 'DIM_DEV', 'DWD_DEV', 'ADS_RPT', 'DATA_FIX'];

// 任务状态
const TASK_STATUS = {
    OPEN: 'OPEN',           // 待认领
    CLAIMED: 'CLAIMED',     // 进行中
    TRANSFERRING: 'TRANSFERRING', // 转发中
    ON_HOLD: 'ON_HOLD',     // 存疑/挂起
    DONE: 'DONE',           // 待确认
    ARCHIVED: 'ARCHIVED'    // 已归档
};

// 模型状态
const MODEL_STATUS = {
    CREATED: 'CREATED',         // 待开发
    DEVELOPING: 'DEVELOPING',   // 开发中
    REVIEWING: 'REVIEWING',     // 待验收
    ONLINE: 'ONLINE',           // 已上线
    OFFLINE: 'OFFLINE'          // 已下线
};

// 用户角色
const USER_ROLES = ['admin', 'publisher', 'user', 'viewer'];

// v1.74.3 纯只读领导账号名单（不参与偏技术类实际工作，纯查看）
//   背景：viewer 角色分两类——① 客服性质运营（示例客服A/示例客服B/示例客服C）会日常导数据，需保留在 admin 直派下拉里；
//        ② 领导账号（示例只读领导A id=11 / 示例只读领导B id=6）纯只读，不应被指派为任何协作单的数据导出人(exporter)。
//   v1.72.5 的 requireExporterOrNonViewer 是「动态按是否本单 exporter」放权，没有用户级黑名单——
//        只要 admin 在直派/转发下拉里手滑选中领导账号，它就会成为该单 exporter 从而获得操作权（误操作缺口）。
//   本常量给 admin-direct-create / forward-to-exporter / admin-direct-reassign 三个写入口 + 前端两个下拉
//        加一道「领导账号不可被设为 exporter」的硬约束（沿用 COLLAB_CHAT_ADMIN_ID 写死 id 的范式）。
//   维护：将来新增/移除纯只读领导，改这一处 + 前端 READONLY_LEADER_IDS 同步（见 Data_Collab.html）。
const READONLY_LEADER_IDS = [6, 11];
// 判定某 user id 是否为纯只读领导（codex 60·v1743 L-1：三个写入口共用，单一真相点）
function isReadonlyLeaderId(id) {
    return READONLY_LEADER_IDS.includes(Number(id));
}

// 需求跟踪常量（v1.74.0 升级：问题跟踪 → 需求跟踪，方案见 docs/local/需求跟踪升级_方案_20260531_v1.1.md §1.4-§1.8）
// 类型 7 类（§1.4）：原"需求"过笼统被新 3 类覆盖、"变更请求"并入"数据治理需求"已砍
const ISSUE_TYPES = [
    '看板/报表需求',    // 业务方要"一个能持续看的东西"（PBI/帆软）；v1.1 唯一受模型硬闸门约束的类型
    '数据治理需求',     // 标准化、清洗、口径统一、字段对齐
    '数据应用需求',     // 专题分析、数据服务、模型支持
    '平台 bug',         // 原"缺陷"改名
    '数据质量',         // 数仓/源系统数据问题
    '源系统变更',       // BMS/HRD/CRM 上游变更通知
    '调度异常'          // FDL Webhook 自动入表
];
const ISSUE_SOURCES = ['业务方', '内部发现', '外包反馈', 'FDL自动'];
const ISSUE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
// 状态机 6 态（§1.5）：加"已暂缓"（可激活）、"已拒绝"（终态不可激活）
const ISSUE_STATUSES = ['待处理', '处理中', '待验证', '已关闭', '已暂缓', '已拒绝'];
const ISSUE_STATUS_TRANSITIONS = {
    '待处理': ['处理中', '已暂缓', '已拒绝'],
    '处理中': ['待验证', '已暂缓'],
    '待验证': ['已关闭', '处理中'],         // 验证不通过回退处理中
    '已关闭': ['处理中'],                    // 已关闭可重开（如发现遗漏）
    '已暂缓': ['待处理'],                    // 激活回到待处理
    '已拒绝': []                              // 终态，不可激活
};
// 需求跟踪 schema 就绪标记（v1.74.0 C1 codex 06 H-2 + 07 复审 M-1：扩 ready/error 双态）：
//   - 初始 ready=false（schema 重建是 async，启动到重建完成有时间窗，期间须拦截避免打到未建完的表）
//   - 重建成功回调 → ready=true；硬门槛命中（有数据/计数未知错误）/ DDL 失败 → error=字符串 + ready 保持 false
//   需求跟踪写 endpoint 入口挂 requireIssueSchemaReady：error → 503 NOT_READY；!ready → 503 INITIALIZING。
//   "模块级降级"——只让需求跟踪接口不可用，collab/指标/数仓等其他模块照常服务。
const ISSUE_SCHEMA_STATE = { ready: false, error: null };
function requireIssueSchemaReady(req, res, next) {
    if (ISSUE_SCHEMA_STATE.error) {
        return res.status(503).json({
            error: '需求跟踪模块暂不可用：schema 未就绪',
            detail: ISSUE_SCHEMA_STATE.error,
            code: 'ISSUE_SCHEMA_NOT_READY'
        });
    }
    if (!ISSUE_SCHEMA_STATE.ready) {
        return res.status(503).json({
            error: '需求跟踪模块正在初始化，请稍后重试',
            code: 'ISSUE_SCHEMA_INITIALIZING'
        });
    }
    next();
}

// ── v1.75.0 优化 schema readiness（方案 §3.0）─────────────────────────────────
//   v1.75.0 给 issues 加 5 列（C4 拉群：dingtalk_chat_*）+ issue_comments 加 is_system（C2 系统评论）。
//   与 v1.74.5 ISSUE_REQUIRED_COLS（C1 必填列，缺失→全模块 503）**分层**：v1.75.0 新列缺失只走
//   本软降级标志，仅挡 C2 改人守卫 / C4 拉群两个**新**入口（返 503），不连累 C1-C5 已上线功能。
//   设计哲学与 v1.74.5 一致：模块级/入口级降级，不 process.exit（同进程 collab/指标/数仓不受牵连）。
const ISSUE_V1750_SCHEMA_STATE = { ready: false, error: null };
// v1.75.0 新列清单（migration 后 PRAGMA 复查这些列全部到位才置 ready）
const ISSUE_V1750_ISSUES_COLS = ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'];
const ISSUE_V1750_COMMENTS_COLS = ['is_system'];
// 守门中间件：挂在依赖 v1.75.0 新列**写**路径的入口（C2 assign 守卫 / C4 create-chat）。
//   readiness=false → 503，避免 ALTER 失败被吞后入口运行期 SQL 崩（方案 §3.0 codex 30#1）。
function requireIssueV1750SchemaReady(req, res, next) {
    if (ISSUE_V1750_SCHEMA_STATE.error) {
        return res.status(503).json({
            error: '需求跟踪 v1.75.0 优化功能暂不可用：新增字段未就绪',
            detail: ISSUE_V1750_SCHEMA_STATE.error,
            code: 'ISSUE_V1750_SCHEMA_NOT_READY'
        });
    }
    if (!ISSUE_V1750_SCHEMA_STATE.ready) {
        return res.status(503).json({
            error: '需求跟踪 v1.75.0 优化功能正在初始化，请稍后重试',
            code: 'ISSUE_V1750_SCHEMA_INITIALIZING'
        });
    }
    next();
}

// ── 取数质量双校验增强 schema readiness（方案 §3-§4.4 / §8b.2）────────────
//   v2 给 collab_quality_record 加 7 列（excel 5 + sql_unchecked_reason + record_kind）+ 唯一索引收窄
//   到 record_kind='passed'（让 failed 行纯 append 不进唯一索引，方案 §4.4 第十人视角简化）。
//   与 v3.0 Commit A 的 collab_quality_record 建表分层：v3.0 已上线两表存在性兜底；本 v2 仅约束新增
//   字段+新索引就绪，未就绪只挡"开发提交 /submit 写质量记录"主入口（503），其他模块正常。
//   迁移失败的运行期保护：H-2 自包 try/catch 已让质量记录写失败不阻断主提交（业务防线），
//   readiness 闸门是冗余防线 + 启动期快速发现（运维可见）。
const COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE = { ready: false, error: null };
// v2 新列清单（migration 后 PRAGMA 复查这些列全部到位才置 ready）
const COLLAB_QUALITY_DUALCHECK_COLS = [
    'excel_actual_columns_snapshot', 'excel_missing_columns', 'excel_is_columns_complete',
    'excel_unchecked_reason', 'result_attachment_id', 'sql_unchecked_reason', 'record_kind'
];
// 守门中间件：Commit C 接入 submit 双路径时挂在写质量记录前。
//   readiness=false → 503，避免 ALTER/索引迁移失败被吞后入口运行期 SQL 崩。
function requireCollabQualityDualCheckSchemaReady(req, res, next) {
    if (COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error) {
        return res.status(503).json({
            error: '取数质量双校验功能暂不可用：新增字段或索引未就绪',
            detail: COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error,
            code: 'COLLAB_QUALITY_DUALCHECK_SCHEMA_NOT_READY'
        });
    }
    if (!COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.ready) {
        return res.status(503).json({
            error: '取数质量双校验功能正在初始化，请稍后重试',
            code: 'COLLAB_QUALITY_DUALCHECK_SCHEMA_INITIALIZING'
        });
    }
    next();
}


const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'issue_tracker_webhook_key';

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

// ==================== 数据库辅助函数 ====================
// Promise化的数据库操作，用于 async/await
const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});

const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

/**
 * 解析 SQLite 的本地时间字符串为 Date 对象
 * SQLite 的 datetime('now', 'localtime') 返回格式为 "YYYY-MM-DD HH:MM:SS" (本地时间)
 * @param {string} dateStr - SQLite 日期时间字符串
 * @returns {Date} JavaScript Date 对象
 */
function parseLocalDateTime(dateStr) {
    if (!dateStr) return null;
    // 明确指定北京时间（UTC+8），避免服务器时区变化导致偏移
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
        return new Date(dateStr.replace(' ', 'T') + '+08:00');
    }
    return new Date(dateStr);
}


// ==================== 操作日志辅助函数 ====================
/**
 * 插入任务操作日志
 * @param {number} taskId - 任务ID
 * @param {string} operationType - 操作类型
 * @param {string} operator - 操作人
 * @param {string} reason - 操作原因/备注（可选）
 */
function insertOperationLog(taskId, operationType, operator, reason = null) {
    // 显式生成北京时间，不依赖系统时区
    const now = new Date();
    const beijingTime = now.toLocaleString('sv-SE', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    }).replace('T', ' ');

    db.run(
        "INSERT INTO task_operation_logs (task_id, operation_type, reason, operator, created_at) VALUES (?, ?, ?, ?, ?)",
        [taskId, operationType, reason, operator, beijingTime],
        (err) => {
            if (err) logger.error("Failed to insert operation log:", err);
        }
    );
}

/**
 * 计算任务的开发工时（只计算"进行中"状态的累计时长）
 * @param {number} taskId - 任务ID
 * @returns {Promise<number>} - 开发工时（秒）
 *
 * 计算逻辑：
 * - CLAIM/ASSIGN → SUBMIT: 计入（首次开发）
 * - REOPEN → SUBMIT: 计入（返工）
 * - RESOLVE → SUBMIT/HOLD: 计入（挂起恢复后的工作时间）
 * - 如果任务当前是 CLAIMED 状态，还需加上从最后一次 CLAIM/REOPEN/RESOLVE 到现在的时间
 */
function calculateDevHours(taskId) {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT operation_type, created_at FROM task_operation_logs WHERE task_id = ? ORDER BY created_at ASC",
            [taskId],
            (err, logs) => {
                if (err) {
                    logger.error("计算开发工时失败:", err);
                    return resolve(0);
                }

                if (!logs || logs.length === 0) {
                    return resolve(0);
                }

                let totalDevSeconds = 0;
                let workStartTime = null; // 当前工作区间的开始时间

                // 开始计时的操作类型
                const startOps = ['CLAIM', 'ASSIGN', 'REOPEN', 'RESOLVE', 'WITHDRAW'];
                // 结束计时的操作类型
                const endOps = ['SUBMIT', 'HOLD', 'UNCLAIM', 'TRANSFER'];

                for (const log of logs) {
                    const logTime = parseLocalDateTime(log.created_at);

                    if (startOps.includes(log.operation_type)) {
                        // 开始新的工作区间
                        workStartTime = logTime;
                    } else if (endOps.includes(log.operation_type) && workStartTime) {
                        // 结束当前工作区间，累加时间
                        const seconds = (logTime - workStartTime) / 1000;
                        if (seconds > 0) {
                            totalDevSeconds += seconds;
                        }
                        workStartTime = null;
                    }
                }

                // 如果当前仍有未结束的工作区间（任务还在进行中），加上到现在的时间
                if (workStartTime) {
                    const now = new Date();
                    const seconds = (now - workStartTime) / 1000;
                    if (seconds > 0) {
                        totalDevSeconds += seconds;
                    }
                }

                resolve(Math.round(totalDevSeconds));
            }
        );
    });
}

// ==================== 模型变更日志辅助函数 ====================
/**
 * 插入模型变更日志
 * @param {object} params - 日志参数
 * @param {number} params.modelId - 模型ID
 * @param {string} params.modelName - 模型表名
 * @param {string} params.action - 操作类型: CREATE / UPDATE / DELETE
 * @param {string} params.changeType - 变更类型: basic_info / dim_config / full_delete
 * @param {object} params.beforeValue - 变更前值
 * @param {object} params.afterValue - 变更后值
 * @param {string} params.changeSummary - 变更摘要
 * @param {number} params.operatorId - 操作人ID
 * @param {string} params.operatorName - 操作人姓名
 */
function insertModelChangeLog(params) {
    const { modelId, modelName, action, changeType, beforeValue, afterValue, changeSummary, operatorId, operatorName } = params;

    db.run(
        `INSERT INTO model_change_logs
         (model_id, model_name, action, change_type, before_value, after_value, change_summary, operator_id, operator_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            modelId,
            modelName,
            action,
            changeType,
            beforeValue ? JSON.stringify(beforeValue) : null,
            afterValue ? JSON.stringify(afterValue) : null,
            changeSummary,
            operatorId,
            operatorName
        ],
        (err) => {
            if (err) logger.error("Failed to insert model change log:", err);
            else logger.info(`Model change log: ${action} - ${modelName} by ${operatorName}`);
        }
    );
}

/**
 * 生成变更摘要
 * @param {string} action - 操作类型
 * @param {object} beforeValue - 变更前值
 * @param {object} afterValue - 变更后值
 * @param {string} changeType - 变更类型
 * @returns {string} 变更摘要
 */
function generateChangeSummary(action, beforeValue, afterValue, changeType, extraInfo) {
    if (action === 'CREATE') {
        return '创建模型';
    }

    if (action === 'DELETE') {
        return '删除模型';
    }

    if (action === 'UPDATE') {
        const changes = [];

        if (changeType === 'basic_info') {
            // 比较基本信息字段
            const fields = {
                table_comment: '表注释',
                tech_owner: '技术负责人',
                biz_owner: '业务负责人',
                status: '状态',
                source_system: '源系统',
                source_table: '源表',
                model_type: '模型类型',
                category: '分类'
            };

            for (const [key, label] of Object.entries(fields)) {
                if (beforeValue && afterValue && beforeValue[key] !== afterValue[key]) {
                    changes.push(label);
                }
            }
        }

        if (changeType === 'dim_config') {
            // 比较 DIM 配置
            const before = beforeValue?.dim_config || {};
            const after = afterValue?.dim_config || {};

            // 比较源表
            const beforeTables = (before.sourceTables || []).map(t => t.tableName).sort().join(',');
            const afterTables = (after.sourceTables || []).map(t => t.tableName).sort().join(',');
            if (beforeTables !== afterTables) {
                changes.push('源表配置');
            }

            // 比较字段
            const beforeFields = (before.selectedFields || []).map(f => f.sourceField).sort().join(',');
            const afterFields = (after.selectedFields || []).map(f => f.sourceField).sort().join(',');
            if (beforeFields !== afterFields) {
                changes.push('字段配置');
            }

            // 比较 SCD 类型
            if (before.scdType !== after.scdType) {
                changes.push('SCD类型');
            }

            // 比较派生字段
            const beforeDerived = (before.derivedFields || []).map(f => f.name).sort().join(',');
            const afterDerived = (after.derivedFields || []).map(f => f.name).sort().join(',');
            if (beforeDerived !== afterDerived) {
                changes.push('派生字段');
            }

            // 比较业务主键
            const beforeKeys = (before.businessKeys || []).sort().join(',');
            const afterKeys = (after.businessKeys || []).sort().join(',');
            if (beforeKeys !== afterKeys) {
                changes.push('业务主键');
            }
        }

        return changes.length > 0 ? `修改: ${changes.join(', ')}` : '更新模型';
    }

    if (changeType === 'script_edit') {
        return `编辑脚本: ${extraInfo || '未知文件'}`;
    }

    return action;
}

/**
 * 深度比较两个对象是否相等（用于判断 dim_config 是否真的发生变化）
 * @param {any} obj1 - 对象1
 * @param {any} obj2 - 对象2
 * @returns {boolean} 是否相等
 */
function deepEqual(obj1, obj2) {
    // 基本类型比较
    if (obj1 === obj2) return true;
    if (obj1 === null || obj2 === null) return obj1 === obj2;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

    // 数组比较
    if (Array.isArray(obj1) !== Array.isArray(obj2)) return false;
    if (Array.isArray(obj1)) {
        if (obj1.length !== obj2.length) return false;
        return obj1.every((item, index) => deepEqual(item, obj2[index]));
    }

    // 对象比较
    const keys1 = Object.keys(obj1).filter(k => obj1[k] !== undefined && obj1[k] !== '');
    const keys2 = Object.keys(obj2).filter(k => obj2[k] !== undefined && obj2[k] !== '');

    if (keys1.length !== keys2.length) return false;

    return keys1.every(key => keys2.includes(key) && deepEqual(obj1[key], obj2[key]));
}

/**
 * 检查 dim_config 是否有实际变化
 * @param {object} oldConfig - 旧配置
 * @param {object} newConfig - 新配置
 * @returns {boolean} 是否有变化
 */
function hasDimConfigActualChange(oldConfig, newConfig) {
    // 两者都为空，无变化
    if (!oldConfig && !newConfig) return false;
    // 一个为空一个不为空，有变化
    if (!oldConfig || !newConfig) return true;

    return !deepEqual(oldConfig, newConfig);
}

// ==================== 安全文件操作辅助函数 ====================
// 允许的文件操作目录白名单
const ALLOWED_FILE_DIRS = [UPLOAD_DIR, ARCHIVE_DIR];

/**
 * 验证路径是否在允许的目录范围内
 * @param {string} targetPath - 要验证的路径
 * @param {string} baseDir - 基础目录
 * @returns {boolean}
 */
function isPathSafe(targetPath, baseDir) {
    if (!targetPath || !baseDir) return false;

    const resolvedPath = path.resolve(targetPath);
    const resolvedBase = path.resolve(baseDir);

    // 确保路径在基础目录内且不是基础目录本身
    return resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase;
}

/**
 * 安全删除文件（同步版本）
 * @param {string} filePath - 相对文件路径
 * @param {string} baseDir - 基础目录（UPLOAD_DIR 或 ARCHIVE_DIR）
 * @returns {boolean} - 是否删除成功
 */
function safeDeleteFileSync(filePath, baseDir) {
    if (!filePath || !baseDir) return false;
    if (!ALLOWED_FILE_DIRS.includes(baseDir)) {
        logger.error(`Security warning: Invalid base directory: ${baseDir}`);
        return false;
    }

    const fullPath = path.join(baseDir, filePath);

    if (!isPathSafe(fullPath, baseDir)) {
        logger.error(`Security warning: Attempted to delete file outside allowed directory: ${fullPath}`);
        return false;
    }

    const resolvedPath = path.resolve(fullPath);

    if (!fs.existsSync(resolvedPath)) {
        return false;
    }

    try {
        fs.unlinkSync(resolvedPath);
        logger.debug(`File deleted: ${resolvedPath}`);
        return true;
    } catch (err) {
        logger.error(`Failed to delete file ${resolvedPath}:`, err.message);
        return false;
    }
}

/**
 * 安全删除文件（异步版本）
 * @param {string} filePath - 相对文件路径
 * @param {string} baseDir - 基础目录
 * @returns {Promise<boolean>}
 */
function safeDeleteFile(filePath, baseDir) {
    return new Promise((resolve) => {
        if (!filePath || !baseDir) return resolve(false);
        if (!ALLOWED_FILE_DIRS.includes(baseDir)) {
            logger.error(`Security warning: Invalid base directory: ${baseDir}`);
            return resolve(false);
        }

        const fullPath = path.join(baseDir, filePath);

        if (!isPathSafe(fullPath, baseDir)) {
            logger.error(`Security warning: Attempted to delete file outside allowed directory: ${fullPath}`);
            return resolve(false);
        }

        const resolvedPath = path.resolve(fullPath);

        if (!fs.existsSync(resolvedPath)) {
            return resolve(false);
        }

        fs.unlink(resolvedPath, (err) => {
            if (err) {
                logger.error(`Failed to delete file ${resolvedPath}:`, err.message);
                resolve(false);
            } else {
                logger.debug(`File deleted: ${resolvedPath}`);
                resolve(true);
            }
        });
    });
}

/**
 * 安全删除目录（递归删除，异步版本）
 * @param {string} dirPath - 完整目录路径
 * @param {string} baseDir - 基础目录
 * @returns {Promise<boolean>}
 */
function safeDeleteDir(dirPath, baseDir) {
    return new Promise((resolve) => {
        if (!dirPath || !baseDir) return resolve(false);
        if (!ALLOWED_FILE_DIRS.includes(baseDir)) {
            logger.error(`Security warning: Invalid base directory: ${baseDir}`);
            return resolve(false);
        }

        if (!isPathSafe(dirPath, baseDir)) {
            logger.error(`Security warning: Attempted to delete directory outside allowed area: ${dirPath}`);
            return resolve(false);
        }

        const resolvedPath = path.resolve(dirPath);

        if (!fs.existsSync(resolvedPath)) {
            return resolve(false);
        }

        // 使用延迟确保文件句柄被释放
        setTimeout(() => {
            fs.rm(resolvedPath, { recursive: true, force: true }, (err) => {
                if (err) {
                    logger.error(`Failed to delete directory ${resolvedPath}:`, err.message);
                    resolve(false);
                } else {
                    logger.debug(`Directory deleted: ${resolvedPath}`);
                    resolve(true);
                }
            });
        }, 300);
    });
}

// Configure Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
        // Fix for Chinese characters showing as garbled text (Latin1 -> UTF8)
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

        // Filename format: taskId_timestamp_originalName
        const taskId = req.body.id || 'unknown';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${taskId}_${uniqueSuffix}_${file.originalname}`)
    }
});
const upload = multer({ storage: storage });

app.use(compression());
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d', // 静态资源默认缓存7天（JS/CSS/图片等）
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // HTML 文件用协商缓存（ETag），而非完全禁止缓存
            res.setHeader('Cache-Control', 'no-cache'); // 每次验证ETag，命中则304
            res.removeHeader('Pragma');
        }
    }
}));
// Serve uploaded and archived files
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/archive', express.static(ARCHIVE_DIR));

// ... Database init code remains same ...
// Initialize Database
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logger.error('Error opening database', err.message);
    } else {
        logger.info('Connected to Task Pool database.');
        // v1.70.0 codex 24 审 #4：BEGIN IMMEDIATE 遇 SQLITE_BUSY 等待 5s 再放弃
        // 防 v1.70.0 insertFailedAttachments 在少量并发写入时把业务失败误升级为 500 持久化异常
        db.run('PRAGMA busy_timeout = 5000', (e) => {
            if (e) logger.warn(`PRAGMA busy_timeout 设置失败: ${e.message}`);
            else logger.info('PRAGMA busy_timeout = 5000ms 已设置');
        });
        initTable();
        // M-1（codex 末次审）：correction schema 初始化挪到此处（busy_timeout + initTable 之后），
        //   保持原 correction 建表时序零变更。correctionModule 在文件后部实例化（deps 齐），
        //   本 db 回调异步晚于顶层执行、此时已就绪。
        correctionModule.initSchema();
    }
});

function initTable() {
    // 创建任务表
    db.run(`CREATE TABLE IF NOT EXISTS task_pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        desc TEXT,
        status TEXT DEFAULT 'OPEN',
        category TEXT DEFAULT 'DWD_DEV',
        owner TEXT,
        owner_id INTEGER,
        submission TEXT,
        file_path TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        created_by INTEGER,
        claimed_at DATETIME,
        done_at DATETIME
    )`, (err) => {
        if (!err) {
            // 迁移:添加新字段(如果不存在)
            db.run("ALTER TABLE task_pool ADD COLUMN owner_id INTEGER", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN created_by INTEGER", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN category TEXT DEFAULT 'DWD_DEV'", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN hold_reason TEXT", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN hold_by TEXT", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN priority TEXT DEFAULT 'P2'", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN linked_model_id INTEGER", () => { });
            db.run("ALTER TABLE task_pool ADD COLUMN linked_model_name TEXT", () => { });
            // ========== 新增字段: 工时管理 ==========
            db.run("ALTER TABLE task_pool ADD COLUMN estimated_hours REAL DEFAULT 0", () => { });  // 预估工时(发布者填写)
            db.run("ALTER TABLE task_pool ADD COLUMN deadline DATETIME", () => { });               // 截止时间(可选)
            db.run("ALTER TABLE task_pool ADD COLUMN actual_hours REAL DEFAULT 0", () => { });     // 实际工时(系统自动计算)
            db.run("ALTER TABLE task_pool ADD COLUMN dev_notes TEXT DEFAULT ''", () => { });       // 开发笔记(可选功能)
            // ========== 新增字段: 操作备注 ==========
            db.run("ALTER TABLE task_pool ADD COLUMN unclaim_reason TEXT", () => { });            // 放弃领取原因
            db.run("ALTER TABLE task_pool ADD COLUMN unclaim_at DATETIME", () => { });            // 放弃时间
            db.run("ALTER TABLE task_pool ADD COLUMN unclaim_by TEXT", () => { });                // 放弃操作人
            db.run("ALTER TABLE task_pool ADD COLUMN reopen_reason TEXT", () => { });             // 退回原因
            db.run("ALTER TABLE task_pool ADD COLUMN reopen_reason_type TEXT", () => { });       // 退回原因类型
            db.run("ALTER TABLE task_pool ADD COLUMN reopen_at DATETIME", () => { });             // 退回时间
            db.run("ALTER TABLE task_pool ADD COLUMN reopen_by TEXT", () => { });                 // 退回操作人

            // ========== 新增字段: 验收流程改造 ==========
            db.run("ALTER TABLE task_pool ADD COLUMN script_source TEXT", () => { });            // 'auto' | 'manual' 脚本来源
            db.run("ALTER TABLE task_pool ADD COLUMN reviewer_id INTEGER", () => { });           // 验收人ID
            db.run("ALTER TABLE task_pool ADD COLUMN reviewer_name TEXT", () => { });            // 验收人姓名
            db.run("ALTER TABLE task_pool ADD COLUMN review_time DATETIME", () => { });          // 验收时间
            db.run("ALTER TABLE task_pool ADD COLUMN review_note TEXT", () => { });              // 验收备注
            db.run("ALTER TABLE task_pool ADD COLUMN review_checklist TEXT", () => { });         // 验收勾选项 JSON
            db.run("ALTER TABLE task_pool ADD COLUMN script_snapshot TEXT", () => { });          // 归档时脚本快照 JSON

            // ========== 性能优化：添加索引 ==========
            db.run("CREATE INDEX IF NOT EXISTS idx_task_linked_model_status ON task_pool(linked_model_id, status)", () => { });
            db.run("CREATE INDEX IF NOT EXISTS idx_task_status ON task_pool(status)", () => { });

            // ========== 数据完整性：同模型只能有一个未归档任务 ==========
            // 应用层 assertNoActiveTaskForModel 做友好提示，数据库层 partial unique index 兜底防并发
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_pool_one_active_per_model
                    ON task_pool(linked_model_id)
                    WHERE linked_model_id IS NOT NULL AND status != 'ARCHIVED'`, (err) => {
                if (err) logger.error('Failed to create partial unique index idx_task_pool_one_active_per_model:', err.message);
            });
        }
    });

    // 创建用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 检查是否存在管理员账户,不存在则创建默认管理员
            db.get("SELECT id FROM users WHERE username = 'admin'", [], async (err, row) => {
                if (!row) {
                    try {
                        const hashedPassword = await bcrypt.hash('change_me_on_first_login', 10);
                        db.run(
                            "INSERT INTO users (username, password, display_name, role, created_at) VALUES (?, ?, ?, ?, datetime('now', 'localtime'))",
                            ['admin', hashedPassword, '管理员', 'admin'],
                            (err) => {
                                if (!err) logger.info('默认管理员账户已创建: admin/change_me_on_first_login');
                            }
                        );
                    } catch (e) {
                        console.error('创建默认管理员失败:', e);
                    }
                }
            });
        }
    });

    // 创建任务转发表
    db.run(`CREATE TABLE IF NOT EXISTS task_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        from_user_id INTEGER NOT NULL,
        to_user_id INTEGER NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        resolved_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES task_pool(id),
        FOREIGN KEY (from_user_id) REFERENCES users(id),
        FOREIGN KEY (to_user_id) REFERENCES users(id)
    )`);

    // 为 task_transfers 表添加 reason 字段（如果不存在）
    db.run(`ALTER TABLE task_transfers ADD COLUMN reason TEXT`, (err) => {
        // 忽略列已存在的错误
    });

    // 创建任务操作日志表（记录放弃、退回等操作历史）
    db.run(`CREATE TABLE IF NOT EXISTS task_operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        reason TEXT,
        operator TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (task_id) REFERENCES task_pool(id)
    )`);

    // 创建任务附件表(支持多附件)
    db.run(`CREATE TABLE IF NOT EXISTS task_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        attachment_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (task_id) REFERENCES task_pool(id)
    )`, (err) => {
        if (!err) {
            // ==================== 数据迁移: 旧版单文件 -> 新版多附件 ====================
            db.all("SELECT id, file_path FROM task_pool WHERE file_path IS NOT NULL AND file_path != ''", (err, rows) => {
                if (err) return console.error("[Migration] Error checking legacy files:", err);

                if (rows.length > 0) {
                    logger.info(`[Migration] Found ${rows.length} legacy attachments. Migrating...`);

                    db.serialize(() => {
                        const stmt = db.prepare("INSERT INTO task_attachments (task_id, attachment_type, file_name, original_name) VALUES (?, ?, ?, ?)");
                        const clearStmt = db.prepare("UPDATE task_pool SET file_path = NULL WHERE id = ?");

                        rows.forEach(row => {
                            const fileName = row.file_path;
                            // Extract original name (format: id_timestamp_originalName)
                            const parts = fileName.split('_');
                            const originalName = parts.length >= 3 ? parts.slice(2).join('_') : fileName;

                            // Guess type based on extension
                            const ext = path.extname(fileName).toLowerCase();
                            let type = 'sql_script'; // default
                            if (ext === '.xlsx' || ext === '.xls') type = 'field_mapping';
                            else if (['.png', '.jpg', '.jpeg'].includes(ext)) type = 'validation_screenshot';
                            else if (['.doc', '.docx'].includes(ext)) type = 'test_report';

                            stmt.run(row.id, type, fileName, originalName);
                            clearStmt.run(row.id);
                        });

                        stmt.finalize();
                        clearStmt.finalize();
                        logger.info("[Migration] Successfully migrated legacy attachments and cleared old fields.");
                    });
                }
            });
        }
    });

    // 创建模型总表 (Model Registry)
    db.run(`CREATE TABLE IF NOT EXISTS data_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        layer TEXT NOT NULL,          -- 数仓分层: ODS, DWD, ADS, DIM
        domain TEXT,                  -- 业务域: TRADE, USER, etc.
        table_name TEXT UNIQUE NOT NULL, -- 英文表名
        table_comment TEXT,           -- 中文描述
        tech_owner TEXT,             -- 技术负责人
        biz_owner TEXT,              -- 业务负责人
        update_cycle TEXT,            -- 更新周期: di, df, da
        status TEXT DEFAULT 'ONLINE', -- 状态: CREATED, DEVELOPING, REVIEWING, ONLINE, OFFLINE
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 迁移: 添加源系统相关字段(如果不存在)
            db.run("ALTER TABLE data_models ADD COLUMN source_system TEXT", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN source_table TEXT", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN model_type TEXT DEFAULT 'TABLE'", () => { });
            // 迁移: 添加创建者ID字段(用于权限控制)
            db.run("ALTER TABLE data_models ADD COLUMN created_by_id INTEGER", () => { });
            // 迁移: 添加资产分类字段 (core: 核心资产, general: 一般资产)
            db.run("ALTER TABLE data_models ADD COLUMN category TEXT DEFAULT 'general'", () => { });
            // 迁移: 添加DIM层配置字段 (JSON格式，存储SCD配置、源表、字段等)
            db.run("ALTER TABLE data_models ADD COLUMN dim_config TEXT", () => { });
            // 迁移: 添加软删除字段
            db.run("ALTER TABLE data_models ADD COLUMN is_deleted INTEGER DEFAULT 0", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN deleted_at DATETIME", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN deleted_by INTEGER", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN delete_reason TEXT", () => { });
            // 迁移: 添加脚本保存相关字段
            db.run("ALTER TABLE data_models ADD COLUMN script_path TEXT", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN script_saved_at DATETIME", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN script_saved_by TEXT", () => { });
            // 迁移: 添加脚本人工编辑标记字段
            db.run("ALTER TABLE data_models ADD COLUMN script_modified INTEGER DEFAULT 0", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN script_modified_by TEXT", () => { });
            db.run("ALTER TABLE data_models ADD COLUMN script_modified_at DATETIME", () => { });
            // 迁移: 添加配置模式字段（standard=标准配置, custom=自定义脚本）
            db.run("ALTER TABLE data_models ADD COLUMN config_mode TEXT DEFAULT 'standard'", () => { });
            // 迁移: 添加设计备注字段（记录模型设计决策的原因）
            db.run("ALTER TABLE data_models ADD COLUMN design_notes TEXT", () => { });
            // 迁移: 添加伴生表从属字段（指向主表 model id，NULL 表示非伴生表）
            db.run("ALTER TABLE data_models ADD COLUMN companion_of INTEGER", () => { });
        }
    });

    // 创建模型变更日志表
    db.run(`CREATE TABLE IF NOT EXISTS model_change_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER,                    -- 关联模型ID
        model_name TEXT,                     -- 冗余存储表名（防删除后无法查询）
        action TEXT NOT NULL,                -- 操作类型: CREATE / UPDATE / DELETE
        change_type TEXT,                    -- 变更类型: basic_info / dim_config / full_delete
        before_value TEXT,                   -- 变更前JSON
        after_value TEXT,                    -- 变更后JSON
        change_summary TEXT,                 -- 变更摘要（人可读）
        operator_id INTEGER,                 -- 操作人ID
        operator_name TEXT,                  -- 操作人姓名
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`);

    // 创建源系统字典表
    db.run(`CREATE TABLE IF NOT EXISTS sys_source_systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,    -- 系统代码: BMS, CRM, ERP
        name TEXT NOT NULL,           -- 系统名称: 业务管理系统
        description TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 初始化默认源系统
            db.get("SELECT count(*) as count FROM sys_source_systems", [], (err, row) => {
                if (!err && row.count === 0) {
                    const stmt = db.prepare("INSERT INTO sys_source_systems (code, name, description) VALUES (?, ?, ?)");
                    stmt.run("BMS", "业务管理系统", "Business Management System - 业务管理核心系统");
                    stmt.finalize();
                    logger.info("Initialized default source system: BMS");
                }
            });
            // 更新已有的BMS记录名称
            db.run("UPDATE sys_source_systems SET name = '业务管理系统', description = 'Business Management System - 业务管理核心系统' WHERE code = 'BMS'");
        }
    });

    // 创建业务域字典表
    db.run(`CREATE TABLE IF NOT EXISTS sys_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,    -- 域代码: trade, user
        name TEXT NOT NULL,           -- 域名称: 交易域, 用户域
        description TEXT,
        status TEXT DEFAULT 'active', -- 状态: active/deprecated
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 添加 status 字段 (兼容旧表)
            db.run("ALTER TABLE sys_domains ADD COLUMN status TEXT DEFAULT 'active'", () => { });
            // 初始化默认域
            db.get("SELECT count(*) as count FROM sys_domains", [], (err, row) => {
                if (!err && row.count === 0) {
                    const stmt = db.prepare("INSERT INTO sys_domains (code, name, description, status) VALUES (?, ?, ?, 'active')");
                    stmt.run("contract", "合同域", "合同管理相关业务");
                    stmt.run("bidding", "招投标域", "招投标相关业务");
                    stmt.finalize();
                    logger.info("Initialized default domains: contract, bidding");
                }
            });
        }
    });

    // 创建任务类型提示配置表
    db.run(`CREATE TABLE IF NOT EXISTS task_tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT UNIQUE NOT NULL,    -- 任务类型: ODS_SYNC, DIM_DEV, DWD_DEV, ADS_RPT, DATA_FIX
        icon TEXT DEFAULT 'lightbulb',    -- 图标标识符
        title TEXT NOT NULL,              -- 标题
        tips TEXT NOT NULL,               -- 提示内容(JSON数组格式)
        enabled INTEGER DEFAULT 1,        -- 是否启用: 1启用, 0禁用
        sort_order INTEGER DEFAULT 0,     -- 排序
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 初始化默认提示配置
            db.get("SELECT count(*) as count FROM task_tips", [], (err, row) => {
                if (!err && row.count === 0) {
                    const defaultTips = [
                        {
                            category: 'ODS_SYNC',
                            icon: 'lightbulb',
                            title: 'ODS同步常见坑点',
                            tips: JSON.stringify([
                                '检查源表是否有增量字段（update_time/create_time）',
                                '确认字段类型映射，特别是日期和数值类型',
                                '注意NULL值处理策略',
                                '大表考虑分区策略'
                            ]),
                            sort_order: 1
                        },
                        {
                            category: 'DIM_DEV',
                            icon: 'lightbulb',
                            title: 'DIM开发常见坑点',
                            tips: JSON.stringify([
                                '确定SCD类型（SCD1覆盖/SCD2历史追踪）',
                                '设计代理键和业务键',
                                '版本链完整性：dw_eff_dt/dw_exp_dt/dw_is_current_flg',
                                '提交4类脚本：DDL、初始化、增量ETL、审计规则'
                            ]),
                            sort_order: 2
                        },
                        {
                            category: 'DWD_DEV',
                            icon: 'lightbulb',
                            title: 'DWD开发常见坑点',
                            tips: JSON.stringify([
                                '明确主键和唯一性约束',
                                '处理脏数据和异常值',
                                '关联查询注意数据倾斜',
                                '时间字段统一转换为标准格式'
                            ]),
                            sort_order: 3
                        },
                        {
                            category: 'ADS_RPT',
                            icon: 'lightbulb',
                            title: 'ADS报表常见坑点',
                            tips: JSON.stringify([
                                '确认指标口径与业务一致',
                                '注意时间范围边界条件',
                                '大数据量考虑预聚合',
                                '验证汇总数据与明细一致性'
                            ]),
                            sort_order: 4
                        },
                        {
                            category: 'DATA_FIX',
                            icon: 'lightbulb',
                            title: '数据修复常见坑点',
                            tips: JSON.stringify([
                                '修复前务必备份原始数据',
                                '确认影响范围和行数',
                                '分批执行避免锁表',
                                '修复后验证数据完整性'
                            ]),
                            sort_order: 5
                        }
                    ];

                    const stmt = db.prepare("INSERT INTO task_tips (category, icon, title, tips, sort_order) VALUES (?, ?, ?, ?, ?)");
                    defaultTips.forEach(t => {
                        stmt.run(t.category, t.icon, t.title, t.tips, t.sort_order);
                    });
                    stmt.finalize();
                    logger.info("Initialized default task tips configuration");
                }
            });
        }
    });

    // ==================== ODS 自动验收相关表 ====================

    // 创建数据库连接配置表
    db.run(`CREATE TABLE IF NOT EXISTS db_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,               -- 连接名称
        type TEXT DEFAULT 'sqlserver',    -- 数据库类型
        host TEXT NOT NULL,               -- 服务器地址
        port INTEGER DEFAULT 1433,        -- 端口
        database TEXT NOT NULL,           -- 数据库名
        default_schema TEXT DEFAULT 'dbo', -- 默认 Schema
        username TEXT NOT NULL,           -- 用户名
        password TEXT NOT NULL,           -- 密码（加密存储）
        is_default INTEGER DEFAULT 0,     -- 是否默认连接
        connection_type TEXT DEFAULT 'warehouse', -- 连接类型: warehouse(数仓) / source(源系统)
        source_system_code TEXT,          -- 源系统代码（如 BMS），用于关联模型的 source_system 字段
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            logger.info("Table db_connections created or already exists");
            // 迁移：添加新字段
            db.run("ALTER TABLE db_connections ADD COLUMN connection_type TEXT DEFAULT 'warehouse'", () => { });
            db.run("ALTER TABLE db_connections ADD COLUMN source_system_code TEXT", () => { });
        }
    });

    // 创建全局验收配置表
    db.run(`CREATE TABLE IF NOT EXISTS validation_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,  -- 配置项
        config_value TEXT NOT NULL,       -- 配置值
        description TEXT,                 -- 说明
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 初始化默认验收配置
            db.get("SELECT count(*) as count FROM validation_config", [], (err, row) => {
                if (!err && row.count === 0) {
                    const defaultConfigs = [
                        { key: 'null_rate_threshold', value: '5', desc: '空值率阈值（百分比）' },
                        { key: 'min_row_count', value: '0', desc: '最小数据量阈值' },
                        { key: 'audit_fields', value: 'dw_load_ts,dw_src_sys,dw_batch_id', desc: '审计字段（逗号分隔）' }
                    ];
                    const stmt = db.prepare("INSERT INTO validation_config (config_key, config_value, description) VALUES (?, ?, ?)");
                    defaultConfigs.forEach(c => stmt.run(c.key, c.value, c.desc));
                    stmt.finalize();
                    logger.info("Initialized default validation config");
                }
            });
        }
    });

    // 创建验收记录表
    db.run(`CREATE TABLE IF NOT EXISTS model_test_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,        -- 关联模型 ID
        table_name TEXT NOT NULL,         -- 表名（冗余存储）
        test_time DATETIME DEFAULT (datetime('now', 'localtime')),
        test_user TEXT,                   -- 执行人
        test_user_id INTEGER,             -- 执行人 ID
        overall_result TEXT DEFAULT 'pending', -- 总体结果: pass/fail/pending
        total_rows INTEGER DEFAULT 0,     -- 数据总量
        detail_json TEXT,                 -- 详细检查结果（JSON）
        db_connection_id INTEGER,         -- 使用的数据库连接
        execution_time_ms INTEGER,        -- 执行耗时（毫秒）
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (model_id) REFERENCES data_models(id),
        FOREIGN KEY (db_connection_id) REFERENCES db_connections(id)
    )`, (err) => {
        if (!err) {
            logger.info("Table model_test_records created or already exists");
            // 迁移: 添加 invalidated 字段（withdraw 时标记旧验收记录失效）
            db.run("ALTER TABLE model_test_records ADD COLUMN invalidated INTEGER DEFAULT 0", () => { });
        }
    });

    // ==================== 指标管理表 ====================
    // 指标定义主表
    db.run(`CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_code TEXT UNIQUE NOT NULL,     -- 唯一标识 (英文)，如 GMV_MONTH
        metric_name TEXT NOT NULL,            -- 指标中文名
        biz_def TEXT,                         -- 业务定义
        tech_def TEXT,                        -- 技术口径 (SQL)
        domain_id INTEGER,                    -- 关联 sys_domains.id
        metric_type TEXT DEFAULT 'atomic',    -- atomic(原子) / derived(派生) / composite(复合)
        formula TEXT,                         -- 计算公式（复合指标），如 FIN_001 / FIN_004 * 100
        parent_metric_id INTEGER,             -- 派生指标的父指标 ID（原子指标）
        data_type TEXT,                       -- DECIMAL / INTEGER / PERCENT
        unit TEXT,                            -- 元 / 人 / 次 / %
        owner_id INTEGER,                     -- 关联 users.id
        status TEXT DEFAULT 'active',         -- active / deprecated
        version INTEGER DEFAULT 1,            -- 当前版本号
        linked_model_id INTEGER,              -- 关联 data_models.id (可选)
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (domain_id) REFERENCES sys_domains(id),
        FOREIGN KEY (owner_id) REFERENCES users(id),
        FOREIGN KEY (parent_metric_id) REFERENCES metrics(id),
        FOREIGN KEY (linked_model_id) REFERENCES data_models(id)
    )`, (err) => {
        if (!err) {
            logger.info("Table metrics created or already exists");
            // 迁移：为已有数据库补充新字段
            db.run(`ALTER TABLE metrics ADD COLUMN formula TEXT`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN parent_metric_id INTEGER REFERENCES metrics(id)`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN sort_order INTEGER DEFAULT 0`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN dax_def TEXT`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN source_table TEXT`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN metric_category TEXT DEFAULT 'basic'`, () => {
                // 将 assess_ 前缀的指标标记为 assessment
                db.run(`UPDATE metrics SET metric_category = 'assessment' WHERE metric_code LIKE 'assess_%' AND (metric_category IS NULL OR metric_category = 'basic')`, () => {});
            });
            db.run(`ALTER TABLE metrics ADD COLUMN assess_dept TEXT`, () => {});
            db.run(`ALTER TABLE metrics ADD COLUMN assess_note TEXT`, () => {});
        }
    });

    // 指标历史版本表
    db.run(`CREATE TABLE IF NOT EXISTS metrics_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_id INTEGER NOT NULL,           -- 关联 metrics.id
        version INTEGER NOT NULL,             -- 版本号
        metric_code TEXT,                     -- 快照
        metric_name TEXT,
        biz_def TEXT,
        tech_def TEXT,
        change_reason TEXT,                   -- 变更原因
        updated_by INTEGER,                   -- 关联 users.id
        updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (metric_id) REFERENCES metrics(id),
        FOREIGN KEY (updated_by) REFERENCES users(id)
    )`, (err) => {
        if (!err) {
            logger.info("Table metrics_history created or already exists");
        }
    });

    // 指标标签定义表
    db.run(`CREATE TABLE IF NOT EXISTS metrics_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_name TEXT UNIQUE NOT NULL,        -- 标签名，如"核心指标"
        color TEXT DEFAULT '#d97706',         -- 标签颜色
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            logger.info("Table metrics_tags created or already exists");
            // 插入默认标签
            const defaultTags = [
                { tag_name: '核心指标', color: '#e53e3e' },
                { tag_name: '财务指标', color: '#38a169' },
                { tag_name: '运营指标', color: '#3182ce' },
                { tag_name: '质量指标', color: '#805ad5' }
            ];
            defaultTags.forEach(tag => {
                db.run(`INSERT OR IGNORE INTO metrics_tags (tag_name, color) VALUES (?, ?)`,
                    [tag.tag_name, tag.color]);
            });
        }
    });

    // 指标-标签关联表
    db.run(`CREATE TABLE IF NOT EXISTS metrics_tag_rel (
        metric_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (metric_id, tag_id),
        FOREIGN KEY (metric_id) REFERENCES metrics(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES metrics_tags(id) ON DELETE CASCADE
    )`, (err) => {
        if (!err) {
            logger.info("Table metrics_tag_rel created or already exists");
        }
    });

    // 指标依赖关系表（指标血缘）
    db.run(`CREATE TABLE IF NOT EXISTS metrics_dependencies (
        metric_id INTEGER NOT NULL,              -- 当前指标
        depends_on_metric_id INTEGER NOT NULL,   -- 依赖的指标
        dependency_type TEXT DEFAULT 'formula',  -- formula(公式依赖) / derive(派生来源)
        PRIMARY KEY (metric_id, depends_on_metric_id),
        FOREIGN KEY (metric_id) REFERENCES metrics(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_metric_id) REFERENCES metrics(id) ON DELETE CASCADE
    )`, (err) => {
        if (!err) {
            logger.info("Table metrics_dependencies created or already exists");
        }
    });

    // 文档评论表
    db.run(`CREATE TABLE IF NOT EXISTS doc_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_filename TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        status TEXT DEFAULT 'pending',
        admin_reply TEXT,
        admin_reply_by TEXT,
        admin_reply_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`, (err) => {
        if (!err) {
            logger.info("Table doc_comments created or already exists");
        }
    });

    // 管理员待办表
    db.run(`CREATE TABLE IF NOT EXISTS admin_todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        priority TEXT DEFAULT 'P1',
        category TEXT DEFAULT '其他',
        status TEXT DEFAULT 'pending',
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);

    // ==================== 需求跟踪模块（v1.74.0 升级：问题跟踪 → 需求跟踪）====================
    // 方案见 docs/local/需求跟踪升级_方案_20260531_v1.1.md
    // C1 schema 重建（决策 9：DROP + CREATE 重建，决策 10：生产 0 行无迁移）
    // ⚠️ 硬门槛防护（方案 §8.1 M-4 + codex 06 审 H-1/H-2/M-4）：DROP 前逐表 COUNT，任一目标表有数据立即中止重建，
    //    并设 ISSUE_SCHEMA_STATE.error 标记 → 需求跟踪 endpoint 入口（C3 重写时挂 requireIssueSchemaReady 中间件）返 503，
    //    不依赖人工记忆，也不为单模块 schema 异常把整个平台 process.exit（collab/指标/数仓共用本进程）。
    //    codex 06 H-1：逐表 sqlite_master 判断存在性 + 分表 COUNT，只对"表不存在"按 0 处理，其他错误（锁/损坏/权限）一律中止。
    // ⚠️ FK CASCADE 说明（M-9 偏离，codex 06 M-3 确认合理）：本项目从未开 PRAGMA foreign_keys=ON（仅 busy_timeout），
    //    collab 模块靠 DELETE endpoint 显式删子表兜底（见 server.js DELETE /api/collab/requests/:id）。
    //    需求跟踪对齐此既有范式——子表保留 ON DELETE CASCADE 子句（无害 + 自文档 + 未来全局开 PRAGMA 即生效），
    //    实际级联由 DELETE /api/issues/:id 显式删子表实现（C3/C4a 硬验收项），不为本模块单独翻转全局 FK 行为。
    // 目标表清单（codex 06 H-1：硬门槛须覆盖全部子表，不只 issues/issue_comments；issue_models 属第二段 C9 不在此）
    const ISSUE_TABLES = ['issues', 'issue_comments', 'issue_attachments', 'issue_status_history'];
    // 逐表安全计数：表不存在→0；查询出错（非"表不存在"）→ 返回 -1 表示"未知错误，不可放行"
    const countIssueTable = (table) => new Promise((resolve) => {
        db.get(`SELECT COUNT(*) AS c FROM "${table}"`, (err, row) => {
            if (err) {
                if (/no such table/i.test(err.message)) return resolve(0); // 表不存在=0 行，安全
                logger.error(`[需求跟踪 C1] 表 ${table} 计数失败（非"表不存在"错误，按未知风险处理）：${err.message}`);
                return resolve(-1); // 锁/损坏/权限等未知错误 → 不可误判为安全
            }
            resolve(row ? row.c : 0);
        });
    });
    // ⚠️ 时序关键（MEMORY feedback：sqlite3 parallel mode 乱序坑）：计数用 await 在 serialize **外**做完，
    //    拿到结论后再开独立 db.serialize 同步发 DROP+CREATE——await 会打破 serialize 串行窗口，
    //    绝不能把 await 横在 DROP/CREATE 之间，否则 CREATE 可能先于 DROP 执行（"table already exists"）。
    // v1.74.5 修复：issues 主表关键列白名单——"表已建好且有数据"时校验主表结构完整性，齐则放行（不重建），
    //   缺则视为旧 schema 拒放行。选 v1.74.x 各阶段标志性列：raw_requirement/data_domain（v1.0.5/v1.1）、
    //   priority_reviewed_at（v1.1 codex 05 M-4）、acceptance_url（C1 fix 改名）、notify_status（C2 通知态）。
    //   ⚠️ 范围说明（codex 审 #1）：仅校验 issues 主表，不校验 3 个子表——4 表是同一次 C1 serialize 块一起
    //   DROP+CREATE 的（要么全新要么全旧，不存在"主表新子表旧"），故主表结构正确即代表本次建表整体到位；
    //   子表字段兼容性由 C3/C4/C4a 接口的 e2e + verify 脚本覆盖，不在启动闸门重复校验。
    const ISSUE_REQUIRED_COLS = ['raw_requirement', 'data_domain', 'priority_reviewed_at', 'acceptance_url', 'notify_status'];
    const getIssueColumns = () => new Promise((resolve) => {
        db.all(`PRAGMA table_info("issues")`, (err, rows) => {
            if (err) return resolve(null);               // 读列出错 → null（按"无法确认结构"处理）
            resolve(rows ? rows.map(r => r.name) : []);
        });
    });

    // ── v1.75.0 优化 migration 段（方案 §3.0）──────────────────────────────────
    //   仅在 C1 守门"放行/重建成功"后调用（保证 issues / issue_comments 表确定存在才 ALTER）。
    //   两表各加新列 → ALTER 后 PRAGMA 复查全部到位才置 ISSUE_V1750_SCHEMA_STATE.ready=true。
    //   幂等：列已存在（duplicate column name）忽略；任何 ALTER/复查异常 → error + ready 保持 false（入口软降级 503）。
    const getTableColumns = (table) => new Promise((resolve) => {
        db.all(`PRAGMA table_info("${table}")`, (err, rows) => {
            if (err) return resolve(null);
            resolve(rows ? rows.map(r => r.name) : []);
        });
    });
    const alterAddColumnAsync = (table, column, type) => new Promise((resolve) => {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
            if (!err) { logger.info(`[需求跟踪 v1.75.0] ALTER ${table}: 列 ${column} 已添加`); return resolve(true); }
            if (err.message && err.message.includes('duplicate column name')) return resolve(true); // 幂等：列已存在
            logger.error(`[需求跟踪 v1.75.0] ALTER ${table} ADD COLUMN ${column} 失败：${err.message}`);
            resolve(false);
        });
    });
    const runIssueV1750Migration = async () => {
        try {
            // issues：5 列（C4 拉群）；issue_comments：is_system（C2 系统评论）
            const okIssues = await Promise.all([
                alterAddColumnAsync('issues', 'dingtalk_chat_id', 'TEXT'),
                alterAddColumnAsync('issues', 'dingtalk_open_conversation_id', 'TEXT'),
                alterAddColumnAsync('issues', 'dingtalk_chat_created_at', 'DATETIME'),
                alterAddColumnAsync('issues', 'dingtalk_chat_created_by', 'INTEGER'),
                alterAddColumnAsync('issues', 'dingtalk_chat_name', 'TEXT'),
            ]);
            const okComments = await alterAddColumnAsync('issue_comments', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
            // ALTER 后 PRAGMA 复查（不信 ALTER 返回值，以实际列为准——防 ALTER 静默失败 / 并发）
            const issuesCols = await getTableColumns('issues');
            const commentsCols = await getTableColumns('issue_comments');
            const missIssues = issuesCols === null ? ['<读列失败>'] : ISSUE_V1750_ISSUES_COLS.filter(c => !issuesCols.includes(c));
            const missComments = commentsCols === null ? ['<读列失败>'] : ISSUE_V1750_COMMENTS_COLS.filter(c => !commentsCols.includes(c));
            if (!okIssues.every(Boolean) || !okComments || missIssues.length || missComments.length) {
                ISSUE_V1750_SCHEMA_STATE.error = `v1.75.0 字段迁移未完成（issues 缺：${missIssues.join(',') || '无'}；issue_comments 缺：${missComments.join(',') || '无'}）`;
                ISSUE_V1750_SCHEMA_STATE.ready = false;
                logger.error(`[需求跟踪 v1.75.0] 🚫 ${ISSUE_V1750_SCHEMA_STATE.error} → C2 改人守卫 / C4 拉群入口将返 503，其余功能不受影响`);
                return;
            }
            ISSUE_V1750_SCHEMA_STATE.error = null;
            ISSUE_V1750_SCHEMA_STATE.ready = true;
            logger.info('[需求跟踪 v1.75.0] ✅ issues +5 列 / issue_comments +is_system 迁移到位，C2/C4 入口放行');
        } catch (e) {
            ISSUE_V1750_SCHEMA_STATE.error = `v1.75.0 字段迁移异常：${e.message}`;
            ISSUE_V1750_SCHEMA_STATE.ready = false;
            logger.error(`[需求跟踪 v1.75.0] 🚫 迁移异常：${e.message}`);
        }
    };

    (async () => {
        const counts = await Promise.all(ISSUE_TABLES.map(countIssueTable));
        const unknownErr = counts.some(c => c < 0);
        const hasData = counts.some(c => c > 0);
        const detail = ISSUE_TABLES.map((t, i) => `${t}=${counts[i] < 0 ? 'ERR' : counts[i]}`).join(' / ');

        if (unknownErr) {
            // 计数遇未知错误（锁/损坏/权限）→ 不重建 + 503（真异常，绝不放行也绝不 DROP）
            ISSUE_SCHEMA_STATE.error = `需求跟踪 schema 计数遇未知错误，拒绝重建（${detail}）`;
            logger.error(`[需求跟踪 C1] 🚫 schema 计数遇未知错误（锁/损坏/权限）：${detail} → 旧表保留，需求跟踪接口将返 503。其他模块不受影响。`);
            return;
        }

        if (hasData) {
            // v1.74.5 核心修复：表已建好且有数据 → 校验关键列齐全后【放行】（绝不 DROP，数据照常用）。
            //   这是原逻辑缺失的正常路径——模块正常使用后首次重启不应再触发"有数据→503"。
            const cols = await getIssueColumns();
            const missing = cols === null ? ['<读列失败>'] : ISSUE_REQUIRED_COLS.filter(c => !cols.includes(c));
            if (missing.length) {
                // 有数据但 issues 主表是旧 schema（或读列失败）→ 拒放行 + 503，提示需迁移（防缺列接口运行期报错）。
                //   codex 审 #2：文案措辞为"issues 结构不可确认/不完整"——hasData 是四表任一非空，
                //   不暗示一定是 issues 主表有数据（可能 issues 空但子表残留），附 detail 各表计数供排障。
                ISSUE_SCHEMA_STATE.error = `需求跟踪表已有数据但 issues 主表结构不完整/不可确认（缺列：${missing.join(',')}；各表计数：${detail}），需人工迁移后放行`;
                ISSUE_SCHEMA_STATE.ready = false;
                logger.error(`[需求跟踪 C1] 🚫 需求跟踪表有数据但 issues 主表缺关键列 [${missing.join(',')}]（各表计数：${detail}）→ 疑似旧 schema，拒绝放行，需求跟踪接口将返 503。请人工迁移补列后重启。其他模块不受影响。`);
                return;
            }
            // 结构完整 → 正常放行，不重建
            ISSUE_SCHEMA_STATE.error = null;
            ISSUE_SCHEMA_STATE.ready = true;
            logger.info(`[需求跟踪 C1] ✅ issues 表已存在且结构完整（${detail}），跳过重建直接放行。`);
            // v1.75.0：表已存在放行后跑 migration（补 5 列 + is_system；幂等，已有列忽略）
            await runIssueV1750Migration();
            return;
        }

        // 全部 0 行（或表不存在）→ 安全重建。独立 serialize 保证 DROP→CREATE→INDEX 严格串行
        db.serialize(() => {
            // codex 07 复审 M-2：收集首个 DDL 错误。db.run 不传 callback 时前序失败不中止队列，
            //   "末条成功 ≠ 前面没失败"——故给每个 CREATE TABLE 挂 recordDdlError，末条回调据 firstDdlError 判定。
            let firstDdlError = null;
            const recordDdlError = (label) => (err) => {
                if (err && !firstDdlError) {
                    firstDdlError = `${label}: ${err.message}`;
                    logger.error(`[需求跟踪 C1] DDL 失败 @${label}：${err.message}`);
                }
            };

            db.run(`DROP TABLE IF EXISTS issue_status_history`);
            db.run(`DROP TABLE IF EXISTS issue_attachments`);
            db.run(`DROP TABLE IF EXISTS issue_comments`);
            db.run(`DROP TABLE IF EXISTS issues`);

            // issues 主表（§1.2）
            db.run(`CREATE TABLE issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,

                -- 核心业务字段
                title TEXT NOT NULL,
                raw_requirement TEXT DEFAULT '',              -- 原始诉求（业务方原话，选填；v1.0.5，与梳理后 description 分开记）
                description TEXT DEFAULT '',                  -- 详细描述（梳理后的需求定义）
                type TEXT NOT NULL,                           -- 类型（7 类，应用层校验 ISSUE_TYPES）
                source TEXT NOT NULL DEFAULT '业务方',         -- 来源（4 类，应用层校验）
                data_domain TEXT,                             -- 数据域（v1.1·选填：对齐 data_models.domain；空值落 NULL，展示 COALESCE 归"未分类"）
                priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
                priority_reviewed_at DATETIME,                -- admin 首次调整优先级时间（v1.1 codex 05 M-4：区分未调度·默认P2 vs 已调度）
                status TEXT NOT NULL DEFAULT '待处理'
                    CHECK (status IN ('待处理','处理中','待验证','已关闭','已暂缓','已拒绝')),

                -- 业务方信息
                requester_dept TEXT NOT NULL,                 -- 业务方部门（复用 COLLAB_REQUESTER_DEPTS + "系统自动"）
                requester_name TEXT NOT NULL,                 -- 业务方姓名（纯文本，不挂 user_id）
                requester_phone TEXT,                         -- 业务方手机号（不做格式校验，人工录入）

                -- OA 关联（v1.0.5）
                oa_number TEXT,                               -- OA 单号（选填；仅复用业务概念，不复用 collab 必填/唯一校验，不参与跨模块主键）

                -- 时间承诺
                deadline DATE,                                -- 期望完成日期（业务承诺）

                -- 交付成果地址（v1.74.0 C1 fix：方案 §0.5.5 保留"预览/验收地址"；旧表 preview_url 重命名为更准确的 acceptance_url）
                -- 看板/报表类需求做完留 PBI/帆软预览或验收链接，是"过程管理·验收"载体（业务方完成通知 #3 复用此字段发链接）
                acceptance_url TEXT,                          -- 预览/验收地址（选填，看板/报表类做完填）

                -- 指派信息
                assigned_to INTEGER,                          -- 被指派人 user_id（H-1：可空，viewer 自录不指派）
                assigned_to_name TEXT,                        -- 冗余姓名（防 users 表变更）

                -- 录入信息
                created_by INTEGER NOT NULL,                  -- 录入人 user_id
                created_by_name TEXT NOT NULL,

                -- 关闭信息
                closed_at DATETIME,                           -- 关闭时间（仅 已关闭/已拒绝 触发；激活/重开时清空）
                last_transition_reason TEXT,                  -- 最近一次状态变更原因（覆盖暂缓/拒绝/关闭/退回/激活）

                -- 钉钉通知字段·开发侧（codex 06 M-2：加 NOT NULL 堵 SQLite CHECK 对 NULL 不失败的枚举空洞）
                notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (notify_status IN ('not_sent','sent','failed')),
                notified_at DATETIME,                         -- 最近一次推送尝试时间（成功失败都写）
                notify_message_key TEXT,                      -- 钉钉 message_key（仅 sent 时非空）
                notify_error TEXT,                            -- 失败时记 classifyError 分类
                read_at DATETIME,                             -- 被指派开发已读时间

                -- 钉钉通知字段·业务方侧（与开发侧物理隔离，避免互相覆盖；codex 06 M-2：加 NOT NULL）
                requester_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (requester_notify_status IN ('not_sent','sent','failed')),
                requester_notified_at DATETIME,
                requester_notify_message_key TEXT,
                requester_notify_error TEXT,
                requester_read_at DATETIME,

                -- 改派通知数据来源（v1.0.4 H-3：改派改手动后，原负责人跨请求需持久化）
                pending_reassign_from_id INTEGER,
                pending_reassign_from_name TEXT,
                pending_reassign_to_id INTEGER,
                pending_reassign_to_name TEXT,
                reassigned_at DATETIME,

                -- FDL Webhook 兼容字段（保留）
                related_table TEXT,                           -- 关联数仓表名（调度异常用）
                error_time DATETIME,                          -- 错误发生时间（调度异常用）

                -- 时间戳
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                updated_at DATETIME DEFAULT (datetime('now','localtime'))
            )`, recordDdlError('CREATE issues'));
            db.run(`CREATE INDEX idx_issues_status ON issues(status)`, recordDdlError('IDX issues_status'));
            db.run(`CREATE INDEX idx_issues_assigned ON issues(assigned_to)`, recordDdlError('IDX issues_assigned'));
            db.run(`CREATE INDEX idx_issues_type ON issues(type)`, recordDdlError('IDX issues_type'));
            db.run(`CREATE INDEX idx_issues_deadline ON issues(deadline)`, recordDdlError('IDX issues_deadline'));

            // issue_comments（保留，schema 不变；决策 8：前端不主推）
            db.run(`CREATE TABLE issue_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                issue_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
            )`, recordDdlError('CREATE issue_comments'));
            db.run(`CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id)`, recordDdlError('IDX issue_comments'));

            // issue_attachments（v1.0.5：录入附件，复用 collab multer/UPLOAD_DIR/ALLOWED_FILE_DIRS；各建表不共表）
            db.run(`CREATE TABLE issue_attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                issue_id INTEGER NOT NULL,
                file_name TEXT NOT NULL,                      -- 落盘文件名（multer 生成，防重名）
                original_name TEXT NOT NULL,                  -- 上传时原始文件名（展示用）
                file_size INTEGER,                            -- 文件字节数（M-1：multer file.size 当场即有）
                mime_type TEXT,                               -- MIME 类型（M-1：multer file.mimetype 当场即有）
                uploaded_by INTEGER NOT NULL,
                uploaded_by_name TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
            )`, recordDdlError('CREATE issue_attachments'));
            db.run(`CREATE INDEX idx_issue_attachments_issue ON issue_attachments(issue_id)`, recordDdlError('IDX issue_attachments'));

            // issue_status_history（v1.0.5：状态变更历史 append-only，零手填，未来质量/效率评价数据底座）
            db.run(`CREATE TABLE issue_status_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                issue_id INTEGER NOT NULL,
                from_status TEXT,                             -- 变更前状态（首次创建为 NULL）
                to_status TEXT NOT NULL,                      -- 变更后状态
                reason TEXT,                                  -- 本次变更原因/说明（同步自 last_transition_reason，可空）
                operator_id INTEGER NOT NULL,
                operator_name TEXT NOT NULL,
                created_at DATETIME DEFAULT (datetime('now','localtime')),
                FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
            )`, recordDdlError('CREATE issue_status_history'));
            // 末条 DDL 回调确认重建结果（codex 06 M-4 + 07 复审 M-2：综合 firstDdlError（前序 CREATE TABLE 失败）
            //   + 本条 ddlErr（末条 index 失败）判定——任一失败都不置 ready，endpoint 返 503）
            db.run(`CREATE INDEX idx_issue_status_history_issue ON issue_status_history(issue_id, created_at)`, (ddlErr) => {
                const failMsg = firstDdlError || (ddlErr ? `CREATE INDEX status_history: ${ddlErr.message}` : null);
                if (failMsg) {
                    ISSUE_SCHEMA_STATE.error = `需求跟踪 schema 重建失败：${failMsg}`;
                    ISSUE_SCHEMA_STATE.ready = false;
                    logger.error(`[需求跟踪 C1] 🚫 schema 重建失败（可能半重建）：${failMsg} → 需求跟踪接口将返 503`);
                } else {
                    ISSUE_SCHEMA_STATE.error = null;
                    ISSUE_SCHEMA_STATE.ready = true;
                    logger.info('[需求跟踪 C1] issues / issue_comments / issue_attachments / issue_status_history 表重建完成');
                    // v1.75.0：重建出的是全新空表（CREATE 语句不含 v1.75.0 列——新旧表统一走 migration ALTER，
                    //   避免"新表有列旧表没列"两套真相）；重建成功后跑 migration 补 5 列 + is_system。
                    runIssueV1750Migration().catch((e) => logger.error(`[需求跟踪 v1.75.0] migration 调用异常：${e.message}`));
                }
            });
        }); // 闭合重建 db.serialize
    })(); // 闭合计数 async IIFE

    // ==================== 数据协作模块（v1.0.1 一阶段）====================
    // 详细方案见 docs/local/数据协作模块_一阶段方案.md

    // 协作单主表
    db.run(`CREATE TABLE IF NOT EXISTS collab_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_request_id TEXT,
        requester_dept TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        request_type TEXT NOT NULL,
        description TEXT NOT NULL,
        deadline DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        developer_id INTEGER NOT NULL,
        developer_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        confirmed_at DATETIME DEFAULT (datetime('now','localtime')),
        claimed_at DATETIME,
        done_at DATETIME,
        archived_at DATETIME,
        accept_remark TEXT,
        reject_count INTEGER DEFAULT 0
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_status ON collab_requests(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_developer ON collab_requests(developer_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_dept ON collab_requests(requester_dept)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_external ON collab_requests(external_request_id)`);

    // 开发计划工作项
    db.run(`CREATE TABLE IF NOT EXISTS collab_dev_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collab_request_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        estimated_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        actual_completed_at DATETIME,
        completed_by INTEGER,
        completed_by_name TEXT,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (collab_request_id) REFERENCES collab_requests(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_items_req ON collab_dev_plan_items(collab_request_id)`);

    // 附件
    db.run(`CREATE TABLE IF NOT EXISTS collab_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collab_request_id INTEGER NOT NULL,
        attachment_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        uploaded_by INTEGER NOT NULL,
        uploaded_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (collab_request_id) REFERENCES collab_requests(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_att_req ON collab_attachments(collab_request_id)`);

    // 操作日志
    db.run(`CREATE TABLE IF NOT EXISTS collab_operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collab_request_id INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        operator_id INTEGER NOT NULL,
        operator TEXT NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (collab_request_id) REFERENCES collab_requests(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collab_logs_req ON collab_operation_logs(collab_request_id)`);

    // ==================== 数据协作模块 v2.0 改造（Deploy 2）====================
    // 方案见 docs/local/数据协作模块_方案_v2.0.md §5.2
    // 19 个物理列 + collab_attachments 2 列 + users 2 列 + system_configs 表 + 索引 + 健康检查
    // ⚠️ ALTER + CREATE INDEX 用 db.serialize 强制串行：CREATE INDEX 在编译期校验列名，
    //    若与 ALTER 并发会触发 "no such column" 竞态（已踩坑：首次启动 ALTER 尚未完成 INDEX 已经编译）

    db.serialize(() => {
        const v2CollabRequestColumns = [
            ['oa_request_no', 'TEXT'],
            ['notified_at', 'DATETIME'],
            ['submitted_at', 'DATETIME'],
            ['last_submitted_at', 'DATETIME'],
            ['sql_validation_status', 'TEXT'],
            ['sql_validation_error', 'TEXT'],
            ['sql_validated_at', 'DATETIME'],
            ['target_db_connection_id', 'INTEGER'],
            ['submission_note', 'TEXT'],
            ['bypass_validation', 'INTEGER DEFAULT 0'],
            ['bypass_reason', 'TEXT'],
            ['bypass_by', 'INTEGER'],
            ['bypass_by_name', 'TEXT'],
            ['friction_occurred', 'INTEGER DEFAULT 0'],
            ['friction_recorded_at', 'DATETIME'],
            ['friction_cause_category', 'TEXT'],
            ['friction_note', 'TEXT'],
            ['submission_version', 'INTEGER DEFAULT 0'],
            ['validation_started_at', 'DATETIME'],
            // Day 3 增补:钉钉已读回执用,存 batchSend 返回的 processQueryKey
            // 后续调 readStatus API 用这个 key 查"谁已读 / 何时读的"
            ['notify_message_key', 'TEXT'],
            // Day 3 优化:首次查到 READ 时持久化"开发已读时间"(本地时间 YYYY-MM-DD HH:mm:ss)
            // 钉钉不存在"取消已读"语义,所以一旦写入永不刷新;详情页直接读 DB 不再调 API
            ['read_at', 'TEXT']
        ];
        for (const [col, type] of v2CollabRequestColumns) {
            safeAlterAddColumn('collab_requests', col, type);
        }
        safeAlterAddColumn('collab_attachments', 'submission_version', 'INTEGER DEFAULT 0');
        safeAlterAddColumn('collab_attachments', 'status', "TEXT DEFAULT 'active'");
        safeAlterAddColumn('users', 'phone', 'TEXT');
        safeAlterAddColumn('users', 'dingtalk_user_id', 'TEXT');
        // v3 二级转派（2026-05-18）：备注用于 admin 在用户管理页给"恒生科技负责人 / 中通文博开发"等自由文本标签
        // 在协作单创建/指派下拉里展示，凭眼睛辨识
        safeAlterAddColumn('users', 'remark', "TEXT NOT NULL DEFAULT ''");

        // ===== Deploy 3 追加（codex 七审 C3 + M1）=====
        // 方案 §5.4 + codex 七审拍板（详见 docs/local/codex审查记录/数据协作模块/08-D3-附件版本化取舍审-20260513.md）
        //
        // C3 不变量：active 行 superseded_at IS NULL；superseded 行 superseded_at IS NOT NULL
        //   - 激活事务中 UPDATE 旧 active → status='superseded' 时同步写 superseded_at=CURRENT_TIMESTAMP
        //   - 之后做物理清理时按 superseded_at < NOW - N天 判断
        //
        // M1 attachment_dir：首次落盘后固定，避免 description 改名导致目录失配（D1 既有问题顺手修）
        //   - activateNewVersion 首次激活时写入；后续版本激活复用此字段；
        //   - D1 历史单据（collab_requests.id ∈ {3..9}）此字段为 NULL，巡检兼容回退到 getCollabAttachmentDir(id, description) 老路径
        safeAlterAddColumn('collab_attachments', 'superseded_at', 'DATETIME');
        safeAlterAddColumn('collab_requests', 'attachment_dir', 'TEXT');

        db.run(`CREATE TABLE IF NOT EXISTS system_configs (
            config_key TEXT PRIMARY KEY,
            config_value_encrypted TEXT,
            updated_by INTEGER,
            updated_by_name TEXT,
            updated_at DATETIME DEFAULT (datetime('now','localtime'))
        )`);

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_oa_no_unique ON collab_requests(oa_request_no) WHERE oa_request_no IS NOT NULL`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_target_db ON collab_requests(target_db_connection_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_friction ON collab_requests(friction_occurred, friction_cause_category)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_att_version ON collab_attachments(collab_request_id, submission_version, status)`);

        // ===== v3 二级转派改造（2026-05-18 起，预期版本 v1.66.0）=====
        // 方案 §3.1：B1 占位值方案
        //   - 不动 developer_id NOT NULL 约束（避免 DROP+CREATE 主表的侵入性改动）
        //   - 约定 developer_id=0、developer_name='(待指派)' 为未指派占位
        //   - 以 status='PENDING_ASSIGN' 为权威判断"未指派"
        const v3CollabRequestColumns = [
            ['contact_person_id', 'INTEGER NOT NULL DEFAULT 0'],
            ['contact_person_name', "TEXT NOT NULL DEFAULT ''"],
            ['assigned_at', 'DATETIME'],
            ['assigned_by', 'INTEGER'],
            ['previous_developer_id', 'INTEGER'],
            // v1.66.1 对接人钉钉已读跟踪（PENDING_ASSIGN 路径发对接人时落）
            // 与现有 notified_at/notify_message_key/read_at（发开发用）独立，避免心智模型混淆
            ['contact_notified_at', 'DATETIME'],
            ['contact_notify_message_key', 'TEXT'],
            ['contact_read_at', 'TEXT'],
            // v1.66.2 软删除（未提交脚本前 admin 可作废协作单）
            // archived_at NOT NULL 视为已作废，列表默认过滤；不动 status 字段避免与 ARCHIVED 终态混淆
            ['archived_at', 'DATETIME'],
            ['archived_reason', 'TEXT'],
            ['archived_by', 'INTEGER'],
            // v1.67.1 归档锁定（DONE 后 admin 推到 ARCHIVED 终态，所有人只读除 admin 外）
            // 与 v1.66.2 archived_at 软删除完全独立 —— 软删除是"撤销/作废"，归档是"完成归档"
            // archived_at = 撤销前路径；status='ARCHIVED' = 完成后历史归档
            ['archived_final_at', 'DATETIME'],
            ['archived_final_reason', 'TEXT'],
            ['archived_final_by', 'INTEGER'],
            // v1.69.0 拉起钉钉沟通群（三方任一在未归档时触发，建群后无解散 API）
            // 群主 = 触发人；群成员固定含示例用户A(admin) + 对接人 + 当前 developer
            // 钉钉无 disband 服务端 API，群留作历史沟通记录，归档时按钮即不再展示
            ['dingtalk_chat_id', 'TEXT'],
            ['dingtalk_open_conversation_id', 'TEXT'],
            ['dingtalk_chat_created_at', 'DATETIME'],
            ['dingtalk_chat_created_by', 'INTEGER'],
            ['dingtalk_chat_name', 'TEXT']
        ];
        for (const [col, type] of v3CollabRequestColumns) {
            safeAlterAddColumn('collab_requests', col, type);
        }
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_contact_person ON collab_requests(contact_person_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_contact_status ON collab_requests(contact_person_id, status)`);

        // ===== v1.70.0 容错闭环改造（2026-05-23）=====
        // 方案 §1.2 撞墙附件永久保留（方案 2'）
        //   - SMOKE_TEST_FAILED 时附件留在正式目录 collab/{rid}_xxx/，status='failed'
        //   - failed_attempt_seq 同 (rid, attachment_type) 内递增（result_data / result_script 各自独立计数）
        //   - status='active' / 'superseded' / 'failed' 三态并存；详情页失败提交历史区块从 status='failed' 拉
        safeAlterAddColumn('collab_attachments', 'failed_at', 'DATETIME');
        safeAlterAddColumn('collab_attachments', 'failed_reason', 'TEXT');
        safeAlterAddColumn('collab_attachments', 'failed_attempt_seq', 'INTEGER');
        // UNIQUE 部分索引（codex 三审 critical 1 修订）：
        //   - 列含 attachment_type：两附件（result_data + result_script）同次提交 attempt_seq=N 不冲突
        //   - WHERE status='failed'：不影响 active/superseded 行
        //   - 双重防御：BEGIN IMMEDIATE 事务串行化是主防线，UNIQUE 索引是事务失效兜底
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_att_failed_seq_unique
                  ON collab_attachments(collab_request_id, failed_attempt_seq, attachment_type)
                  WHERE status='failed'`);

        // ===== v1.70.4 ④ 业务方负责人手机号（2026-05-23）=====
        //   create-chat 拉群时若 requester_phone 非空 → getUserIdByMobile 反查 → 命中则把业务方真人加入群
        //   未命中（钉钉返 60121 等）→ 静默降级走现有 4 人组逻辑
        //   选填字段：业务方可能不在钉钉企业内（外协），强制必填会阻塞协作单创建
        safeAlterAddColumn('collab_requests', 'requester_phone', 'TEXT');

        // ===== v1.71.0 三级转发数据导出人（2026-05-24）=====
        //   方案 §6.1：collab_requests 增 5 列承载"开发 → 数据导出人"的三级转发链路
        //   - exporter_user_id / exporter_name：当前数据导出人（PENDING 回流后字段保留作历史展示）
        //   - exporter_assigned_at：首次指派时间戳
        //   - forwarded_to_exporter_at：每次 forward 动作时间戳（含二次转发；与 assigned_at 区分用于回流场景）
        //   - export_summary：导出人提交时的"操作概要"≤500 字（v0.1 补 2 操作概要落地，钉钉模板取前 80 字）
        //   codex 31 审 #1 critical 验证：grep 全 wbs-server 5 列均不存在，方案 §6.1 准确
        safeAlterAddColumn('collab_requests', 'exporter_user_id', 'INTEGER');
        safeAlterAddColumn('collab_requests', 'exporter_name', 'TEXT');
        safeAlterAddColumn('collab_requests', 'exporter_assigned_at', 'DATETIME');
        safeAlterAddColumn('collab_requests', 'forwarded_to_exporter_at', 'DATETIME');
        safeAlterAddColumn('collab_requests', 'export_summary', 'TEXT');

        // ===== v1.72.0 落盘文件名统一 OA 格式（2026-05-25）=====
        //   方案：OA-{oa}_{YYYYMMDD}_{nnn}_{rd|rs|sc|ex}[_failed]_{姓名}.{ext}
        //   双轨制 seq（codex 31 spec-critique H-1 修订）：
        //     - rd/rs：复用 submission_version 不需此列
        //     - sc/ex：用 attachment_seq 列，BEGIN IMMEDIATE 短事务 MAX+1 预分配
        //   历史行 attachment_seq=NULL，COALESCE(NULL,0)+1=1 兼容
        //   不加 UNIQUE 索引（避免 failed/superseded 同 seq 兼容性冲突，靠应用层 + verify 兜底）
        safeAlterAddColumn('collab_attachments', 'attachment_seq', 'INTEGER');

        // ===== v1.72.3 admin 直派模式（2026-05-28）=====
        //   方案 §3：仅 1 个 assign_mode 字段，枚举值 ['normal', 'admin_direct']
        //   - 历史行（v1.72.2 前）自动填默认值 'normal' 兼容
        //   - 应用层守卫枚举值（SQLite ALTER 不支持 CHECK 约束）
        //   - verify-assign-mode-history.js 巡检：SELECT COUNT(*) FROM collab_requests WHERE assign_mode IS NULL = 0
        //
        //   ⚠️ 重要语义（codex 32 审 M-2 采纳）：
        //   assign_mode 是「来源/历史标识」而非「当前流程模式」。一旦创建为 admin_direct，
        //   永远是 admin_direct（即使 admin-direct-fallback 切回流转后状态变 PENDING_ASSIGN，
        //   assign_mode 仍保留 admin_direct）。
        //
        //   后续维护者注意：
        //   - 判断"当前是否处于 admin 直派 EXPORTING"必须联合 status + exporter_user_id：
        //     assign_mode='admin_direct' && status='EXPORTING' && exporter_user_id != null
        //   - PENDING_ASSIGN/PENDING 状态下 assign_mode='admin_direct' 仅代表「这单曾走过直派路径」，
        //     不要在这些状态对 admin_direct 应用直派专属规则（如 admin-direct-reassign/fallback）
        safeAlterAddColumn('collab_requests', 'assign_mode', "TEXT NOT NULL DEFAULT 'normal'");
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_assign_mode ON collab_requests(assign_mode)`);

        // 导出人通知业务方·发数据（2026-05-29）：完成通知 + 业务方已读跟踪 3 字段
        //   同构 contact_*（发对接人）/ notify_*（发开发）的钉钉已读跟踪模式
        //   done_read_at 语义 = 业务方已读"完成通知"，不代表下载/打开 xlsx（v1.1 §4 / codex 53 M-1）
        safeAlterAddColumn('collab_requests', 'done_notified_at', 'TEXT');          // 完成通知发送时间（三步全成才落）
        safeAlterAddColumn('collab_requests', 'done_notify_message_key', 'TEXT');   // markdown 通知的 processQueryKey
        safeAlterAddColumn('collab_requests', 'done_read_at', 'TEXT');              // 业务方已读完成通知时间

        // ===== 取数交付质量记录 v3.0（2026-06-05，Commit A）=====
        //   方案 docs/local/数据协作模块_v3.0/取数交付质量记录_方案_20260605_v3.0.md §3
        //   定位：取数交付质量记录仪（"管事不管人"）。产出级记录 + 兼容多产出（collab_sub_item_id 预留可空）。
        //   旁路设计：写失败仅 warn 不阻断 submit-export 主流程；时间/状态复用现有字段不双真相源。
        //
        //   质量记录表（产出级，append-only）：每次开发提交追加一行，不 UPDATE 不删。
        //   - collab_sub_item_id 可空：单产出 NULL（隐含产出），多产出上线填子项 id → 零返工。
        //   - submission_seq：开发第几次主动提交（复用 submission_version 语义，每次提交 +1，不覆盖）。
        //   - 列对齐结果（新信号）：missing_columns + is_columns_complete + 模板/结果列快照（L-3/L-4 可复现）。
        db.run(`CREATE TABLE IF NOT EXISTS collab_quality_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collab_request_id INTEGER NOT NULL,
            collab_sub_item_id INTEGER,
            submitter_id INTEGER NOT NULL,
            submitter_name TEXT NOT NULL,
            submission_seq INTEGER NOT NULL DEFAULT 1 CHECK (submission_seq >= 1),
            submitted_at TEXT NOT NULL,
            missing_columns TEXT,
            -- is_columns_complete 三态（codex 69 M-4）：1=列齐全 / 0=缺列 / NULL=未比对
            --   NULL 是异常兜底态：模板该有却读取/解析失败时写 NULL（业务保证模板必有表头，故 NULL 罕见）。
            --   不伪装成"齐全"——真出读取异常如实留痕"没法比对"，避免污染"列齐全率"统计口径。
            is_columns_complete INTEGER DEFAULT 1 CHECK (is_columns_complete IS NULL OR is_columns_complete IN (0, 1)),
            expected_columns_snapshot TEXT,
            actual_columns_snapshot TEXT,
            sql_attachment_id INTEGER,
            -- ↓↓↓ 双校验增强（取数质量双校验增强_方案_v1.2）：excel 侧 5 列 + sql_unchecked_reason + record_kind ↓↓↓
            -- 上方 is_columns_complete / missing_columns / *_snapshot / sql_attachment_id 保持「SQL smoke 列校验」语义不变。
            -- excel 侧：result_data 表头 vs 模板，独立于 SQL 成败都跑（SQL failed 时也校验 excel，#11 核心）。
            excel_actual_columns_snapshot TEXT,
            excel_missing_columns TEXT,
            -- excel 侧三态（同 is_columns_complete 语义）：1=齐全 / 0=缺列 / NULL=未比对（模板/result_data 读失败兜底）
            excel_is_columns_complete INTEGER DEFAULT NULL CHECK (excel_is_columns_complete IS NULL OR excel_is_columns_complete IN (0, 1)),
            -- 两侧"未比对原因"枚举（仅对应 is_complete=NULL 时有值；模板侧 reason 两侧写同值）：
            --   模板侧（共用）NO_TEMPLATE / NON_XLSX_TEMPLATE / TEMPLATE_READ_FAILED
            --   sql 侧 SMOKE_FAILED；excel 侧 NO_RESULT_DATA / NON_EXCEL_RESULT / RESULT_READ_FAILED；builder 异常 QUALITY_CHECK_FAILED
            excel_unchecked_reason TEXT,
            sql_unchecked_reason TEXT,
            result_attachment_id INTEGER,
            -- record_kind（第十人视角简化，方案 §4.4）：质量记录是 append-only 过程留痕（非终态）。
            --   passed=正式交付（smoke 通过 DONE，走唯一索引幂等）；failed=过程留痕（smoke 失败 SUBMITTED，纯 append 多次留痕）。
            --   历史 v3.0 行都是 DONE 后写的 → DEFAULT 'passed' 自动兼容，无需数据迁移。
            record_kind TEXT NOT NULL DEFAULT 'passed' CHECK (record_kind IN ('passed', 'failed')),
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (collab_request_id) REFERENCES collab_requests(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_qr_request ON collab_quality_record(collab_request_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_qr_subitem ON collab_quality_record(collab_sub_item_id)`);
        // 唯一约束（M-1）：同一产出同次提交不重复记录。
        //   - 拆两个部分索引处理 sub_item NULL：SQLite 唯一索引把多个 NULL 视为互异（不冲突），
        //     单产出（sub_item IS NULL）若只建一个含 sub_item 的联合唯一索引会失效 → 单产出永远不去重。
        //   - 故：sub_item IS NULL 走 (request_id, submission_seq) 唯一；sub_item NOT NULL 走三列联合唯一。
        //   - 双重防御：应用层幂等（C2 写前查重）是主防线，唯一索引是兜底。
        // 双校验 v2（方案 §4.4）：唯一索引仅约束 record_kind='passed'（正式交付幂等）；
        //   failed 行 record_kind='failed' 不进唯一索引 → 纯 append 多次留痕，看得出重试几次。
        //   注：CREATE...IF NOT EXISTS 对已有库的旧索引（无 record_kind 条件）不会改写，旧库的索引收窄由
        //   runCollabQualityDualCheckMigration 走 DROP+重建完成；这里只让新库一次到位。
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_unique_single
                  ON collab_quality_record(collab_request_id, submission_seq)
                  WHERE collab_sub_item_id IS NULL AND record_kind = 'passed'`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_unique_multi
                  ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
                  WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed'`);

        // ===== 取数质量双校验增强（2026-06-12，方案 §3-§4.4 / §8b）=====
        //   旧库（v3.0 collab_quality_record 已存在）走 ALTER 补 7 列：excel 5 + sql_unchecked_reason + record_kind。
        //   新库 CREATE TABLE 已含 7 列（上方），ALTER 幂等失败回 duplicate column 被 safeAlterAddColumn 吞掉。
        //   ⚠️ 索引收窄到 record_kind='passed' 不能靠 CREATE...IF NOT EXISTS——旧库的旧索引已存在且无 record_kind 条件，
        //     IF NOT EXISTS 会跳过；旧索引的 DROP+重建走 serialize 块**外**的 runCollabQualityDualCheckMigration（异步段，
        //     需先 await 探测 passed 行 (request_id, submission_seq) 无重复，与 1268-1270 范式同源——await 不能横在
        //     serialize 串行窗口内，否则 CREATE 可能先于 DROP 执行）。
        //   excel 侧列：result_data 表头 vs 模板，独立于 SQL 成败都跑（SQL failed 时也校验，#11 核心）。
        safeAlterAddColumn('collab_quality_record', 'excel_actual_columns_snapshot', 'TEXT');
        safeAlterAddColumn('collab_quality_record', 'excel_missing_columns', 'TEXT');
        safeAlterAddColumn('collab_quality_record', 'excel_is_columns_complete', 'INTEGER DEFAULT NULL');
        safeAlterAddColumn('collab_quality_record', 'excel_unchecked_reason', 'TEXT');
        safeAlterAddColumn('collab_quality_record', 'result_attachment_id', 'INTEGER');
        safeAlterAddColumn('collab_quality_record', 'sql_unchecked_reason', 'TEXT');
        // record_kind 默认 'passed' 自动兼容历史行（v3.0 行都是 DONE 后写的 = passed 语义）
        safeAlterAddColumn('collab_quality_record', 'record_kind', "TEXT NOT NULL DEFAULT 'passed'");
        // 注：CHECK 约束（excel_is_columns_complete IN(0,1)/record_kind IN('passed','failed'））仅新库 CREATE TABLE 带，
        //   旧库 ALTER ADD COLUMN 不能加 CHECK——业务层 recordQualityForDeveloperSubmit 集中归一化兜底（方案 §3.2）。

        //   打回记录表：甲方/对接人主动打回，带原因分类。
        //   - reason_type CHECK 枚举：仅 DEV_QUALITY 计入"开发质量返工"，其余记录但不计质量（M-5）。
        //   - 关联被打回的提交版本（submission_seq）+ 打回前后状态快照（status_before/after，M-4）。
        //   - 不强依赖 quality_record_id：无质量记录时也允许打回（L-1），靠 request+seq 关联。
        db.run(`CREATE TABLE IF NOT EXISTS collab_return_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collab_request_id INTEGER NOT NULL,
            collab_sub_item_id INTEGER,
            submission_seq INTEGER,
            returned_by INTEGER NOT NULL,
            returned_by_name TEXT NOT NULL,
            reason_type TEXT NOT NULL
                CHECK (reason_type IN ('DEV_QUALITY','REQ_CHANGE','ENV_ISSUE','BIZ_ADJUST')),
            reason_note TEXT,
            status_before TEXT,
            status_after TEXT,
            returned_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (collab_request_id) REFERENCES collab_requests(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_rr_request ON collab_return_record(collab_request_id)`);

        // 健康检查放在 serialize 末尾，确保所有 ALTER/INDEX 都已串行执行完
        verifyV2CollabSchema();
        // ⭐ v1.80.1 hotfix：取数质量双校验迁移必须在 serialize 队列消耗完之后触发，
        //   否则 runCollabQualityDualCheckMigration 的第一步 PRAGMA 会与队列里的 ALTER 竞态
        //   （PRAGMA 立即返回老 schema → 7 列缺失 → readiness=false → submit endpoint 永久 503）。
        //   把触发放进 serialize 块内最后一个 db.run 的 callback——保证它一定在 7 个 ALTER 排队消耗完之后执行。
        //   v1.75.0 runIssueV1750Migration 是同步 await 在 IIFE 内调，本范式是 serialize 队列内 callback 触发，
        //   两套范式都解时序竞态，但路径不同：v1.75.0 因为 PRAGMA 检查表存在性后才跑 migration（不与 serialize 并发）。
        db.run('SELECT 1', () => {
            runCollabQualityDualCheckMigration().catch((e) => {
                COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.ready = false;
                COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `取数质量双校验迁移异常：${e && e.message}`;
                logger.error(`[取数质量双校验] 🚫 迁移异常：${e && e.message}`);
            });
        });
    });

}


// ── 取数质量双校验抽样验证非法值（codex Commit A 审 medium-2 兜底）─────────
//   旧库 ALTER ADD COLUMN 不能补 CHECK 约束，CHECK 仅新库 CREATE TABLE 走到位（"新库强约束、旧库弱约束"分层）。
//   未来若有手写 SQL/旧代码误写非法值（如 record_kind='passed_v2' 笔误 / excel_is_columns_complete=2），
//   旧库不会拒绝。本抽样在启动迁移末尾跑：发现非法值即 ready=false + 503 + 运维告警。
//   返回 null = 抽样通过；返回字符串 = 错误信息（直接进 COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error）。
async function detectIllegalDualCheckValues() {
    try {
        // [1] record_kind 非法（非 'passed'/'failed'）—— 包括 NULL，因为 NOT NULL 仅新库 CREATE TABLE 生效
        const illegalKind = await new Promise((resolve) => {
            db.all(
                "SELECT id, record_kind FROM collab_quality_record WHERE record_kind IS NULL OR record_kind NOT IN ('passed','failed') LIMIT 5",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        if (illegalKind === null) {
            return '抽样查询 record_kind 非法值失败（DB 错误）';
        }
        if (illegalKind.length > 0) {
            const sample = illegalKind.map(r => `id=${r.id}/kind=${r.record_kind === null ? 'NULL' : `'${r.record_kind}'`}`).join(', ');
            return `抽样发现 record_kind 非法值（${illegalKind.length}+ 行）：${sample}，需人工修复为 'passed'/'failed'`;
        }
        // [2] excel_is_columns_complete 非法（非 NULL/0/1）
        const illegalExcel = await new Promise((resolve) => {
            db.all(
                "SELECT id, excel_is_columns_complete FROM collab_quality_record WHERE excel_is_columns_complete IS NOT NULL AND excel_is_columns_complete NOT IN (0, 1) LIMIT 5",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        if (illegalExcel === null) {
            return '抽样查询 excel_is_columns_complete 非法值失败（DB 错误）';
        }
        if (illegalExcel.length > 0) {
            const sample = illegalExcel.map(r => `id=${r.id}/val=${r.excel_is_columns_complete}`).join(', ');
            return `抽样发现 excel_is_columns_complete 非法值（${illegalExcel.length}+ 行）：${sample}，需人工修复为 NULL/0/1`;
        }
        return null;
    } catch (e) {
        return `抽样验证异常：${e && e.message}`;
    }
}

// ── 取数质量双校验增强 迁移（方案 §8b.2）─────────────────────────────────
//   两件事必须满足才置 ready=true：
//     ① collab_quality_record 含全部 7 列（ALTER 已在 initTable serialize 里发，本函数只 PRAGMA 复查）
//     ② 唯一索引收窄到 record_kind='passed'：旧索引若无此条件需 DROP + CREATE 新索引
//     ③ （codex 审 medium-2 兜底）抽样验证 record_kind / excel_is_columns_complete 无非法值
//        —— 旧库 ALTER ADD COLUMN 不能加 CHECK，靠业务层（Commit B builder）归一化兜底 + 启动期抽样防误写脏数据。
//   ⚠️ 时序铁律（与 v1.74.5 1601-1603 范式同源）：
//     - 探测重复（passed 行 (collab_request_id, submission_seq) 无重复）必须 await，先于任何动作
//     - DROP+CREATE 必须在独立 db.serialize 同步发，await 绝不能横在中间（serialize 串行窗口会被破坏）
async function runCollabQualityDualCheckMigration() {
    try {
        // ① PRAGMA 复查 7 列到位
        const cols = await new Promise((resolve) => {
            db.all('PRAGMA table_info(collab_quality_record)', (err, rows) => {
                if (err) return resolve(null);
                resolve(rows ? rows.map(r => r.name) : []);
            });
        });
        if (cols === null) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = '无法读取 collab_quality_record 表结构（PRAGMA 失败）';
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
            return;
        }
        const missingCols = COLLAB_QUALITY_DUALCHECK_COLS.filter(c => !cols.includes(c));
        if (missingCols.length) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `字段迁移未完成，缺：${missingCols.join(',')}`;
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error} → /submit 写质量记录入口将返 503`);
            return;
        }

        // ② 检查现有唯一索引的 WHERE 条件是否含 record_kind='passed'
        //    sqlite_master 的 sql 列存原始 DDL 文本，新建索引含 record_kind 字串、旧索引没有
        const idxRows = await new Promise((resolve) => {
            db.all(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        if (idxRows === null) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = '无法读取 collab_quality_record 索引定义（sqlite_master 失败）';
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
            return;
        }
        const allHaveRecordKind = idxRows.length === 2 && idxRows.every(r => r.sql && /record_kind\s*=\s*'passed'/i.test(r.sql));
        if (allHaveRecordKind) {
            // 新库 CREATE 一次到位 或 旧库已经迁移过 → 跑抽样验证再 ready
            //   旧库 ALTER ADD COLUMN 不能补 CHECK，CHECK 仅新库生效（分层兼容）；
            //   抽样验证兜底未来手写 SQL/旧代码误写非法值（codex Commit A 审 medium-2）。
            const illegal = await detectIllegalDualCheckValues();
            if (illegal) {
                COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = illegal;
                logger.error(`[取数质量双校验] 🚫 ${illegal} → /submit 写质量记录入口将返 503`);
                return;
            }
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = null;
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.ready = true;
            logger.info(`[取数质量双校验] ✅ 7 列 + 两个唯一索引已含 record_kind='passed' 条件 + 抽样无非法值，schema 就绪`);
            return;
        }

        // 旧索引存在且无 record_kind 条件 → 走 DROP+CREATE
        // 探测：passed 行（含历史隐含 passed=DEFAULT、本次新加 record_kind 默认 'passed'）在 (request_id, submission_seq) 下无重复
        const dupSingle = await new Promise((resolve) => {
            db.all(
                "SELECT collab_request_id, submission_seq, COUNT(*) AS c FROM collab_quality_record " +
                "WHERE collab_sub_item_id IS NULL AND record_kind = 'passed' " +
                "GROUP BY collab_request_id, submission_seq HAVING c > 1",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        const dupMulti = await new Promise((resolve) => {
            db.all(
                "SELECT collab_request_id, collab_sub_item_id, submission_seq, COUNT(*) AS c FROM collab_quality_record " +
                "WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed' " +
                "GROUP BY collab_request_id, collab_sub_item_id, submission_seq HAVING c > 1",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        if (dupSingle === null || dupMulti === null) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = '迁移前重复探测查询失败';
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
            return;
        }
        if (dupSingle.length || dupMulti.length) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `迁移前重复探测发现 passed 行重复（单产出 ${dupSingle.length} 组 / 多产出 ${dupMulti.length} 组），需人工处理后再启动`;
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
            return;
        }

        // 探测通过 → 独立 serialize 同步发 DROP+CREATE（绝不在中间夹 await）
        await new Promise((resolve) => {
            db.serialize(() => {
                let firstErr = null;
                const handle = (label) => (err) => { if (err && !firstErr) firstErr = `${label}: ${err.message}`; };
                db.run('DROP INDEX IF EXISTS idx_qr_unique_single', handle('DROP single'));
                db.run('DROP INDEX IF EXISTS idx_qr_unique_multi', handle('DROP multi'));
                db.run(
                    `CREATE UNIQUE INDEX idx_qr_unique_single
                       ON collab_quality_record(collab_request_id, submission_seq)
                       WHERE collab_sub_item_id IS NULL AND record_kind = 'passed'`,
                    handle('CREATE single')
                );
                db.run(
                    `CREATE UNIQUE INDEX idx_qr_unique_multi
                       ON collab_quality_record(collab_request_id, collab_sub_item_id, submission_seq)
                       WHERE collab_sub_item_id IS NOT NULL AND record_kind = 'passed'`,
                    (err) => {
                        handle('CREATE multi')(err);
                        if (firstErr) {
                            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `索引重建失败：${firstErr}`;
                            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
                        }
                        resolve();
                    }
                );
            });
        });
        if (COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error) return;

        // 重建后再次 PRAGMA 复查 sqlite_master 确认两个新索引都含 record_kind 条件
        const idxRowsAfter = await new Promise((resolve) => {
            db.all(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='collab_quality_record' AND name IN ('idx_qr_unique_single','idx_qr_unique_multi')",
                (err, rows) => resolve(err ? null : (rows || []))
            );
        });
        const afterOk = idxRowsAfter && idxRowsAfter.length === 2 && idxRowsAfter.every(r => r.sql && /record_kind\s*=\s*'passed'/i.test(r.sql));
        if (!afterOk) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `重建后索引复查未通过（WHERE 条件未含 record_kind='passed'）`;
            logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
            return;
        }
        // 旧库迁移后抽样验证（codex Commit A 审 medium-2 分层兼容兜底）
        const illegal = await detectIllegalDualCheckValues();
        if (illegal) {
            COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = illegal;
            logger.error(`[取数质量双校验] 🚫 ${illegal} → /submit 写质量记录入口将返 503`);
            return;
        }

        COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = null;
        COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.ready = true;
        logger.info(`[取数质量双校验] ✅ 旧索引已 DROP+重建带 record_kind='passed' 条件，7 列就绪 + 抽样无非法值，schema 迁移完成`);
    } catch (e) {
        COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
        logger.error(`[取数质量双校验] 🚫 ${COLLAB_QUALITY_DUALCHECK_SCHEMA_STATE.error}`);
    }
}

// v2.0 schema 启动后健康检查（codex 六审 M-6 配套）
function verifyV2CollabSchema() {
    const expectedCollabRequest = [
        'oa_request_no', 'notified_at', 'submitted_at', 'last_submitted_at',
        'sql_validation_status', 'sql_validation_error', 'sql_validated_at',
        'target_db_connection_id', 'submission_note',
        'bypass_validation', 'bypass_reason', 'bypass_by', 'bypass_by_name',
        'friction_occurred', 'friction_recorded_at', 'friction_cause_category', 'friction_note',
        'submission_version', 'validation_started_at',
        // Deploy 3 追加（codex 七审 M1）
        'attachment_dir',
        // v3 二级转派改造（2026-05-18）
        'contact_person_id', 'contact_person_name',
        'assigned_at', 'assigned_by', 'previous_developer_id',
        // v1.66.1 对接人钉钉已读跟踪（2026-05-19）
        'contact_notified_at', 'contact_notify_message_key', 'contact_read_at',
        // v1.66.2 软删除（2026-05-19）
        'archived_at', 'archived_reason', 'archived_by',
        // v1.67.1 归档锁定（2026-05-20）
        'archived_final_at', 'archived_final_reason', 'archived_final_by',
        // v1.69.0 钉钉沟通群（2026-05-20）
        'dingtalk_chat_id', 'dingtalk_open_conversation_id',
        'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name',
        // v1.70.4 ④ 业务方负责人手机号（2026-05-23）
        'requester_phone',
        // v1.71.0 三级转发数据导出人（2026-05-24）
        'exporter_user_id', 'exporter_name',
        'exporter_assigned_at', 'forwarded_to_exporter_at',
        'export_summary',
        // v1.72.3 admin 直派模式（2026-05-28）
        'assign_mode',
        // 导出人通知业务方·发数据（2026-05-29）
        'done_notified_at', 'done_notify_message_key', 'done_read_at'
    ];
    db.all("PRAGMA table_info(collab_requests)", [], (err, rows) => {
        if (err) {
            logger.error('v2.0 schema 健康检查失败（无法读取 collab_requests 表结构）:', err.message);
            return;
        }
        const actualCols = rows.map(r => r.name);
        const missing = expectedCollabRequest.filter(c => !actualCols.includes(c));
        if (missing.length > 0) {
            logger.error(`v2.0 schema 迁移不完整，collab_requests 缺失字段: ${missing.join(', ')}`);
        } else {
            logger.info(`v2.0 schema 健康检查通过：collab_requests ${expectedCollabRequest.length} 个新增字段齐全（含 D3 attachment_dir + v3 二级转派 5 字段 + v1.66.1 对接人钉钉已读跟踪 3 字段 + v1.66.2 软删除 3 字段 + v1.67.1 归档锁定 3 字段 + v1.69.0 钉钉沟通群 5 字段 + v1.70.4 requester_phone + v1.71.0 三级转发 5 字段 + v1.72.3 assign_mode + 导出通知业务方 done_* 3 字段）`);
        }
    });

    // v1.72.3 codex 32 审 M-3 采纳：assign_mode 枚举值启动期巡检
    //   SQLite ALTER 不支持 CHECK 约束，靠应用层守卫枚举值
    //   启动期巡检发现异常值（数据库被人工 SQL 改坏 / 老 schema 残留）即告警
    db.all(
        "SELECT id, oa_request_no, assign_mode FROM collab_requests WHERE assign_mode NOT IN ('normal', 'admin_direct') OR assign_mode IS NULL LIMIT 5",
        [],
        (err, rows) => {
            if (err) {
                logger.warn(`v1.72.3 assign_mode 巡检查询失败: ${err.message}`);
                return;
            }
            if (rows && rows.length > 0) {
                logger.error(`v1.72.3 assign_mode 异常巡检：发现 ${rows.length}+ 行非法 assign_mode（前 5 个 id=${rows.map(r => r.id).join(',')}）。需要人工修复为 normal 或 admin_direct。`);
            } else {
                logger.info('v1.72.3 assign_mode 巡检通过：所有协作单 assign_mode 合法（normal / admin_direct）');
            }
        }
    );
    db.all("PRAGMA table_info(collab_attachments)", [], (err, rows) => {
        if (err) return;
        const actualCols = rows.map(r => r.name);
        // v1.70.0 加 3 字段：failed_at / failed_reason / failed_attempt_seq（方案 §1.2 撞墙附件保留）
        const missing = ['submission_version', 'status', 'superseded_at',
                         'failed_at', 'failed_reason', 'failed_attempt_seq'].filter(c => !actualCols.includes(c));
        if (missing.length > 0) {
            logger.error(`v2.0 schema 迁移不完整，collab_attachments 缺失字段: ${missing.join(', ')}`);
        }
    });
    db.all("PRAGMA table_info(users)", [], (err, rows) => {
        if (err) return;
        const actualCols = rows.map(r => r.name);
        const missing = ['phone', 'dingtalk_user_id', 'remark'].filter(c => !actualCols.includes(c));
        if (missing.length > 0) {
            logger.error(`v2.0 schema 迁移不完整，users 缺失字段: ${missing.join(', ')}`);
        }
    });
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'", [], (err, row) => {
        if (err) return;
        if (!row) {
            logger.error('v2.0 schema 迁移不完整，system_configs 表未创建');
        }
    });

    // ===== 取数交付质量记录 v3.0 健康检查（2026-06-05，Commit A）=====
    //   两张新表存在性校验（沿用 system_configs 的 sqlite_master 范式）
    // codex 76 L-1：两表存在性合并一次检查——都存在才输出"就绪"，避免第一张表查到就喊就绪、
    //   第二张表缺失时日志同时出现"就绪"和错误的误导。
    db.get(
        "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='collab_quality_record') AS q, " +
        "(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='collab_return_record') AS r",
        [],
        (err, row) => {
            if (err) return;
            const missing = [];
            if (!row || !row.q) missing.push('collab_quality_record');
            if (!row || !row.r) missing.push('collab_return_record');
            if (missing.length > 0) {
                logger.error(`取数质量 v3.0 schema 迁移不完整，未创建：${missing.join(' + ')}`);
            } else {
                logger.info('取数质量 v3.0 schema 健康检查通过：collab_quality_record + collab_return_record 就绪');
            }
        }
    );
    // ===== 取数质量双校验增强 列清单巡检（2026-06-12，方案 §8b.2 / codex 审 medium-2）=====
    //   存在性已被 v3.0 段覆盖；这里补列清单 PRAGMA + 分层兼容提示——
    //     新 7 列必须全到位（与 runCollabQualityDualCheckMigration 的 readiness 校验互为冗余）；
    //   ⚠️ 分层兼容警告（codex Commit A 审 medium-2）：旧库 ALTER ADD COLUMN 不能加 CHECK 约束 →
    //     excel_is_columns_complete IN(0,1) / record_kind IN('passed','failed') CHECK 仅在新库 CREATE TABLE 生效。
    //     旧库依赖业务层 Commit B builder（recordQualityForDeveloperSubmit）归一化兜底 + 迁移函数抽样验证 detectIllegalDualCheckValues 防误写脏数据。
    db.all('PRAGMA table_info(collab_quality_record)', [], (err, rows) => {
        if (err) return;
        const actualCols = rows.map(r => r.name);
        const missing = COLLAB_QUALITY_DUALCHECK_COLS.filter(c => !actualCols.includes(c));
        if (missing.length > 0) {
            logger.error(`取数质量双校验 schema 迁移不完整，collab_quality_record 缺 7 列中的：${missing.join(', ')}`);
        } else {
            logger.info(`取数质量双校验 schema 列巡检通过：collab_quality_record 新增 ${COLLAB_QUALITY_DUALCHECK_COLS.length} 列齐全（excel 5 + sql_unchecked_reason + record_kind）；⚠️ 分层兼容：旧库 ALTER 不补 CHECK，靠 builder 归一化 + 迁移期抽样兜底（详见 detectIllegalDualCheckValues）`);
        }
    });
    // reason_type 异常巡检（CHECK 约束已挡新写入，巡检防老数据/人工 SQL 改坏；沿用 assign_mode 巡检范式）
    db.all(
        "SELECT id, collab_request_id, reason_type FROM collab_return_record WHERE reason_type NOT IN ('DEV_QUALITY','REQ_CHANGE','ENV_ISSUE','BIZ_ADJUST') LIMIT 5",
        [],
        (err, rows) => {
            if (err) return;  // 表尚未建好时静默（建表 db.run 在同 serialize 块更早执行，正常不会触发）
            if (rows && rows.length > 0) {
                logger.error(`取数质量 v3.0 reason_type 异常巡检：发现 ${rows.length}+ 行非法 reason_type（前 5 个 id=${rows.map(r => r.id).join(',')}）`);
            }
        }
    );
}

// v2.0 ALTER TABLE 辅助函数（codex 六审 M-6：D1 的 () => {} 空回调会吞错）
function safeAlterAddColumn(table, column, type) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (err) => {
        if (!err) {
            logger.info(`ALTER TABLE ${table}: column ${column} added`);
            return;
        }
        if (err.message && err.message.includes('duplicate column name')) {
            return; // 幂等：列已存在
        }
        logger.error(`ALTER TABLE ${table} ADD COLUMN ${column} 失败:`, err.message);
    });
}

// ==================== 密码加密辅助函数 ====================
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!'; // 32 bytes
const IV_LENGTH = 16;

function encryptPassword(password) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptPassword(encryptedPassword) {
    const parts = encryptedPassword.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ==================== SQL Server 连接管理 ====================
// 连接池缓存
const mssqlPools = new Map();

/**
 * 获取 SQL Server 连接池
 * @param {Object} connConfig - 连接配置
 * @returns {Promise<sql.ConnectionPool>}
 */
async function getMssqlPool(connConfig) {
    const poolKey = `${connConfig.host}:${connConfig.port}:${connConfig.database}`;

    if (mssqlPools.has(poolKey)) {
        const pool = mssqlPools.get(poolKey);
        if (pool.connected) {
            return pool;
        }
        // 连接已断开，移除旧池
        mssqlPools.delete(poolKey);
    }

    const config = {
        user: connConfig.username,
        password: connConfig.password,
        server: connConfig.host,
        port: connConfig.port,
        database: connConfig.database,
        options: {
            encrypt: false,
            trustServerCertificate: true,
            enableArithAbort: true,
            requestTimeout: 60000
        },
        pool: {
            max: 10,
            min: 2,
            idleTimeoutMillis: 60000
        }
    };

    const pool = new sql.ConnectionPool(config);
    await pool.connect();
    mssqlPools.set(poolKey, pool);
    logger.info(`SQL Server connection pool created for ${poolKey}`);
    return pool;
}

/**
 * 关闭所有 SQL Server 连接池
 */
async function closeMssqlPools() {
    for (const [key, pool] of mssqlPools) {
        try {
            await pool.close();
            logger.info(`SQL Server connection pool closed for ${key}`);
        } catch (err) {
            logger.error(`Error closing pool ${key}:`, err.message);
        }
    }
    mssqlPools.clear();
}

// ============================================================================
// MySQL 连接池（v1.68.0 路由式多方言）
// ============================================================================

const mysql = require('mysql2/promise');
const mysqlPools = new Map();

/**
 * 获取 MySQL 连接池（mysql2/promise）
 * @param {Object} connConfig - 连接配置 { host, port, database, username, password }
 * @returns {Promise<mysql.Pool>}
 */
async function getMysqlPool(connConfig) {
    const poolKey = `${connConfig.host}:${connConfig.port}:${connConfig.database}`;
    if (mysqlPools.has(poolKey)) {
        return mysqlPools.get(poolKey);
    }
    const pool = mysql.createPool({
        host: connConfig.host,
        port: connConfig.port,
        database: connConfig.database,
        user: connConfig.username,
        password: connConfig.password,
        connectionLimit: 10,
        connectTimeout: 10000,
        // smoke test 单查询不依赖事务，但保持 utf8mb4 避免中文乱码
        charset: 'utf8mb4',
    });
    // 探活一次确保配置正确
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    mysqlPools.set(poolKey, pool);
    logger.info(`MySQL connection pool created for ${poolKey}`);
    return pool;
}

async function closeMysqlPools() {
    for (const [key, pool] of mysqlPools) {
        try {
            await pool.end();
            logger.info(`MySQL connection pool closed for ${key}`);
        } catch (err) {
            logger.error(`Error closing MySQL pool ${key}:`, err.message);
        }
    }
    mysqlPools.clear();
}

// 进程退出时关闭连接池
process.on('SIGINT', async () => {
    await closeMssqlPools();
    await closeMysqlPools();
    process.exit(0);
});

// ==================== ODS 验收引擎 ====================

/**
 * 获取表的元数据（列信息、主键）
 * @param {sql.ConnectionPool} pool - 数据库连接池
 * @param {string} schema - Schema 名称
 * @param {string} tableName - 表名
 * @returns {Promise<{columns: Array, primaryKeys: Array}>}
 */
async function getTableMetadata(pool, schema, tableName) {
    const fullTableName = `${schema}.${tableName}`;

    // 获取列信息
    const columnsResult = await pool.request().query(`
        SELECT
            c.name AS column_name,
            t.name AS data_type,
            c.is_nullable,
            c.max_length,
            c.precision,
            c.scale
        FROM sys.columns c
        JOIN sys.types t ON c.user_type_id = t.user_type_id
        WHERE c.object_id = OBJECT_ID('${fullTableName}')
        ORDER BY c.column_id
    `);

    // 获取主键
    const pkResult = await pool.request().query(`
        SELECT col.name AS pk_column
        FROM sys.indexes idx
        JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
        JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
        WHERE idx.is_primary_key = 1
          AND idx.object_id = OBJECT_ID('${fullTableName}')
        ORDER BY ic.key_ordinal
    `);

    return {
        columns: columnsResult.recordset,
        primaryKeys: pkResult.recordset.map(r => r.pk_column)
    };
}

/**
 * 执行 ODS 验收检查
 * @param {Object} params - 验收参数
 * @returns {Promise<Object>} - 验收结果
 */
async function executeOdsValidation(params) {
    const { pool, schema, tableName, validationConfig } = params;
    const fullTableName = `${schema}.${tableName}`;
    const startTime = Date.now();
    const result = {
        overall_result: 'pass',
        total_rows: 0,
        details: {}
    };

    try {
        // 1. 获取表元数据
        const metadata = await getTableMetadata(pool, schema, tableName);
        if (metadata.columns.length === 0) {
            return {
                overall_result: 'fail',
                total_rows: 0,
                details: {
                    error: { status: 'fail', message: `表 ${fullTableName} 不存在或无法访问` }
                },
                execution_time_ms: Date.now() - startTime
            };
        }

        // 2. 数据量检查
        const countResult = await pool.request().query(`SELECT COUNT(*) as cnt FROM ${fullTableName}`);
        const rowCount = countResult.recordset[0].cnt;
        result.total_rows = rowCount;

        const minRowCount = parseInt(validationConfig.min_row_count || '0');
        result.details.row_count = {
            name: '数据量检查',
            status: rowCount >= minRowCount ? 'pass' : 'fail',
            value: rowCount,
            threshold: minRowCount
        };
        if (result.details.row_count.status === 'fail') result.overall_result = 'fail';

        // 如果表为空，跳过其他检查
        if (rowCount === 0) {
            result.details.pk_check = { name: '主键唯一性', status: 'skip', message: '表为空，跳过检查' };
            result.details.null_check = [];
            result.details.audit_fields = {};
            result.details.time_range = { status: 'skip', message: '表为空，跳过检查' };
            result.execution_time_ms = Date.now() - startTime;
            return result;
        }

        // 3. 主键唯一性检查
        if (metadata.primaryKeys.length > 0) {
            const pkColumns = metadata.primaryKeys.join(', ');
            // 单主键时直接用字段，多主键时用CONCAT拼接（CONCAT至少需要2个参数）
            const pkDistinctExpr = metadata.primaryKeys.length === 1
                ? `CAST(${metadata.primaryKeys[0]} AS NVARCHAR(MAX))`
                : `CONCAT(${metadata.primaryKeys.map(pk => `CAST(${pk} AS NVARCHAR(MAX))`).join(", '-', ")})`;
            const pkCheckResult = await pool.request().query(`
                SELECT COUNT(*) as total, COUNT(DISTINCT ${pkDistinctExpr}) as distinct_count
                FROM ${fullTableName}
            `);
            const total = pkCheckResult.recordset[0].total;
            const distinctCount = pkCheckResult.recordset[0].distinct_count;
            const duplicateRate = total > 0 ? ((total - distinctCount) / total * 100).toFixed(2) : 0;
            const isPkPass = total === distinctCount;

            result.details.pk_check = {
                name: '主键唯一性',
                status: isPkPass ? 'pass' : 'fail',
                pk_columns: metadata.primaryKeys,
                total: total,
                distinct: distinctCount,
                duplicate_rate: parseFloat(duplicateRate)
            };
            if (!isPkPass) {
                result.overall_result = 'fail';
                result.details.pk_check.suggestion = `存在 ${total - distinctCount} 条重复记录。请检查：1) 源数据是否本身存在重复；2) ETL任务是否重复执行导致数据重复写入；3) 增量同步时是否未正确处理更新逻辑`;
            }
        } else {
            // ODS 表未定义主键，检查源表是否有主键
            let sourcePrimaryKeys = [];
            if (params.sourcePool && params.sourceSchema && params.sourceTable) {
                try {
                    // 解析源表名（可能包含 schema）
                    let sourceSchema = params.sourceSchema;
                    let sourceTableName = params.sourceTable;
                    if (params.sourceTable.includes('.')) {
                        const parts = params.sourceTable.split('.');
                        sourceSchema = parts[0];
                        sourceTableName = parts[1];
                    }
                    const sourceFullTableName = `${sourceSchema}.${sourceTableName}`;

                    // 查询源表主键
                    const sourcePkResult = await params.sourcePool.request().query(`
                        SELECT col.name AS pk_column
                        FROM sys.indexes idx
                        JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
                        JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
                        WHERE idx.is_primary_key = 1
                          AND idx.object_id = OBJECT_ID('${sourceFullTableName}')
                        ORDER BY ic.key_ordinal
                    `);
                    sourcePrimaryKeys = sourcePkResult.recordset.map(r => r.pk_column);
                } catch (sourceErr) {
                    logger.warn('获取源表主键失败:', sourceErr.message);
                }
            }

            if (sourcePrimaryKeys.length > 0) {
                // 源表有主键但 ODS 表没有，标记为 fail
                result.details.pk_check = {
                    name: '主键唯一性',
                    status: 'fail',
                    message: `ODS 表未定义主键，但源表定义了主键 [${sourcePrimaryKeys.join(', ')}]`,
                    source_pk_columns: sourcePrimaryKeys,
                    suggestion: '请为 ODS 表添加主键约束以保证数据唯一性，ODS 层应保持与源表一致的主键定义'
                };
                result.overall_result = 'fail';
            } else {
                // 源表也没有主键，跳过检查
                result.details.pk_check = {
                    name: '主键唯一性',
                    status: 'skip',
                    message: '未定义主键'
                };
            }
        }

        // 4. NOT NULL 字段空值率检查
        const nullRateThreshold = parseFloat(validationConfig.null_rate_threshold || '5');
        const auditFields = (validationConfig.audit_fields || 'dw_load_ts,dw_src_sys,dw_batch_id').split(',').map(f => f.trim().toLowerCase());

        // 筛选需要检查的字段：NOT NULL 约束且非审计字段
        const notNullColumns = metadata.columns.filter(c =>
            c.is_nullable === false &&
            !auditFields.includes(c.column_name.toLowerCase())
        );

        result.details.null_check = [];
        if (notNullColumns.length > 0) {
            // 合并为单条 SQL，一次全表扫描检查所有 NOT NULL 字段的空值率
            const nullCaseExprs = notNullColumns.map(col =>
                `SUM(CASE WHEN [${col.column_name}] IS NULL THEN 1 ELSE 0 END) as [null_${col.column_name}]`
            ).join(',\n                    ');
            const nullCheckResult = await pool.request().query(`
                SELECT COUNT(*) as total,
                    ${nullCaseExprs}
                FROM ${fullTableName}
            `);
            const row = nullCheckResult.recordset[0];
            const total = row.total;

            for (const col of notNullColumns) {
                const nullCount = row[`null_${col.column_name}`] || 0;
                const nullRate = total > 0 ? (nullCount / total * 100) : 0;

                const isNullPass = nullRate <= nullRateThreshold;
                const checkResult = {
                    column: col.column_name,
                    null_count: nullCount,
                    null_rate: parseFloat(nullRate.toFixed(2)),
                    threshold: nullRateThreshold,
                    status: isNullPass ? 'pass' : 'fail'
                };
                if (!isNullPass) {
                    checkResult.suggestion = `字段 ${col.column_name} 空值率 ${nullRate.toFixed(2)}% 超过阈值 ${nullRateThreshold}%。请检查：1) 源系统该字段是否允许为空；2) ETL映射时是否需要添加 ISNULL/COALESCE 处理；3) 字段映射是否正确`;
                }
                result.details.null_check.push(checkResult);
                if (!isNullPass) result.overall_result = 'fail';
            }
        }

        // 5. 审计字段完整性检查
        result.details.audit_fields = {};
        const auditFieldSuggestions = {
            'dw_load_ts': '请在ETL任务中添加 GETDATE() 或 CURRENT_TIMESTAMP 作为数据加载时间',
            'dw_src_sys': '请在ETL任务中添加固定值标识源系统（如 \'CRM\', \'ERP\'）',
            'dw_batch_id': '请在ETL任务中使用 FDL 系统参数 ${bdp.system.cyctime} 或任务启动时间作为批次号'
        };
        for (const auditField of auditFields) {
            const colExists = metadata.columns.find(c => c.column_name.toLowerCase() === auditField);
            if (colExists) {
                const auditCheckResult = await pool.request().query(`
                    SELECT SUM(CASE WHEN [${colExists.column_name}] IS NULL THEN 1 ELSE 0 END) as null_count
                    FROM ${fullTableName}
                `);
                const nullCount = auditCheckResult.recordset[0].null_count;
                const isAuditPass = nullCount === 0;
                result.details.audit_fields[auditField] = {
                    null_count: nullCount,
                    status: isAuditPass ? 'pass' : 'fail'
                };
                if (!isAuditPass) {
                    result.overall_result = 'fail';
                    result.details.audit_fields[auditField].suggestion = `审计字段 ${auditField} 存在 ${nullCount} 个空值。${auditFieldSuggestions[auditField] || '请检查ETL任务中该字段的赋值逻辑'}`;
                }
            } else {
                result.details.audit_fields[auditField] = {
                    status: 'missing',
                    message: '字段不存在'
                };
                // 审计字段缺失不算验收失败，仅作为信息
            }
        }

        // 5.1 dw_batch_id 一致性检查（多批次仅作为警告，兼容增量同步场景）
        const batchIdCol = metadata.columns.find(c => c.column_name.toLowerCase() === 'dw_batch_id');
        if (batchIdCol) {
            const batchIdCheckResult = await pool.request().query(`
                SELECT COUNT(DISTINCT [${batchIdCol.column_name}]) as distinct_count,
                       MIN([${batchIdCol.column_name}]) as sample_value
                FROM ${fullTableName}
                WHERE [${batchIdCol.column_name}] IS NOT NULL
            `);
            const distinctCount = batchIdCheckResult.recordset[0].distinct_count;
            const sampleValue = batchIdCheckResult.recordset[0].sample_value;

            const isBatchIdPass = distinctCount <= 1;
            result.details.batch_id_consistency = {
                distinct_count: distinctCount,
                sample_value: sampleValue,
                status: isBatchIdPass ? 'pass' : 'warn',
                message: isBatchIdPass
                    ? (distinctCount === 1 ? `批次号一致: ${sampleValue}` : '表中无数据')
                    : `发现 ${distinctCount} 个不同的批次号（增量同步属正常现象，全量同步请检查）`
            };
            if (!isBatchIdPass) {
                result.details.batch_id_consistency.suggestion = '如为全量同步表，批次号不一致通常是因为使用了 GETDATE() 作为批次号。请改用 FDL 系统参数 ${bdp.system.cyctime}（任务调度时间）。如为增量同步表，多个批次号属正常现象，可忽略此警告';
            }
        } else {
            result.details.batch_id_consistency = {
                status: 'skip',
                message: 'dw_batch_id 字段不存在，跳过一致性检查'
            };
        }

        // 6. 时间范围检查（仅展示信息）
        // 查找可能的时间字段
        const timeColumns = metadata.columns.filter(c =>
            ['datetime', 'datetime2', 'date', 'smalldatetime'].includes(c.data_type.toLowerCase()) &&
            !auditFields.includes(c.column_name.toLowerCase())
        );

        if (timeColumns.length > 0) {
            const timeCol = timeColumns[0]; // 取第一个时间字段
            const timeRangeResult = await pool.request().query(`
                SELECT MIN([${timeCol.column_name}]) as min_time, MAX([${timeCol.column_name}]) as max_time
                FROM ${fullTableName}
            `);
            result.details.time_range = {
                column: timeCol.column_name,
                min: timeRangeResult.recordset[0].min_time,
                max: timeRangeResult.recordset[0].max_time,
                status: 'info'
            };
        } else {
            result.details.time_range = {
                status: 'skip',
                message: '未找到时间类型字段'
            };
        }

        // 7. 源表数据量对比（如果提供了源系统连接信息）
        if (params.sourcePool && params.sourceTable) {
            try {
                const sourceSchema = params.sourceSchema || 'dbo';
                const sourceFullTable = `${sourceSchema}.${params.sourceTable}`;
                const sourceCountResult = await params.sourcePool.request().query(`SELECT COUNT(*) as cnt FROM ${sourceFullTable}`);
                const sourceRowCount = sourceCountResult.recordset[0].cnt;

                const diff = rowCount - sourceRowCount;
                const diffRate = sourceRowCount > 0 ? ((diff / sourceRowCount) * 100).toFixed(2) : (rowCount > 0 ? 100 : 0);

                const isSourcePass = diff === 0;
                result.details.source_compare = {
                    name: '源表数据量对比',
                    source_table: sourceFullTable,
                    source_database: params.sourceDatabase || '',
                    source_rows: sourceRowCount,
                    ods_rows: rowCount,
                    diff: diff,
                    diff_rate: parseFloat(diffRate),
                    status: isSourcePass ? 'pass' : 'warn' // 差异仅作为警告，不影响整体结果
                };
                if (!isSourcePass) {
                    const diffDirection = diff > 0 ? 'ODS 数据多于源表' : 'ODS 数据少于源表';
                    result.details.source_compare.suggestion = `${diffDirection}，差异 ${Math.abs(diff)} 行 (${Math.abs(parseFloat(diffRate))}%)。请检查：1) ETL任务的 WHERE 条件是否正确；2) 是否存在数据过滤逻辑；3) 增量同步时高水位线设置是否正确；4) 源表是否有实时写入导致数据差异`;
                }
            } catch (sourceErr) {
                logger.warn('Source table count error:', sourceErr.message);
                result.details.source_compare = {
                    name: '源表数据量对比',
                    source_table: `${params.sourceSchema || 'dbo'}.${params.sourceTable}`,
                    status: 'error',
                    message: '无法查询源表: ' + sourceErr.message
                };
            }
        }

    } catch (err) {
        logger.error('Validation error:', err.message);
        result.overall_result = 'fail';
        result.details.error = {
            status: 'fail',
            message: err.message
        };
    }

    result.execution_time_ms = Date.now() - startTime;
    return result;
}


// ==================== DIM 层验收引擎 ====================

/**
 * 执行 DIM 层验收检查（结构 + 数据 + 业务语义）
 * @param {Object} params - { pool, schema, tableName, businessKey, dimConfig }
 * @returns {Promise<Object>} - { overall_result, summary, structure, data, semantic }
 */
async function executeDimValidation(params) {
    const { pool, schema, tableName, businessKey, dimConfig, phase } = params;
    const VALID_PHASES = ['all', 'structure', 'data', 'semantic'];
    const runPhase = phase || 'all';
    if (!VALID_PHASES.includes(runPhase)) {
        return {
            overall_result: 'fail',
            summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
            structure: [], data: [], semantic: {}, total_rows: 0,
            error: `无效的验收阶段: ${runPhase}，允许值: ${VALID_PHASES.join(', ')}`
        };
    }
    const fullTableName = `[${schema}].[${tableName}]`;
    const startTime = Date.now();

    const result = {
        overall_result: 'pass',
        summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
        structure: [],
        data: [],
        semantic: {},
        total_rows: 0
    };

    // 辅助函数：添加检查结果
    function addCheck(phase, id, name, status, detail) {
        const item = { id, name, status, detail: detail || '' };
        phase.push(item);
        if (status === 'fail') result.summary.fail++;
        else if (status === 'warn') result.summary.warn++;
        else if (status === 'pass') result.summary.pass++;
        else if (status === 'skip') result.summary.skip++;
    }

    try {
        // ===== 一次性获取表元数据 =====
        // 1) 字段信息（含注释、IDENTITY）
        const colResult = await pool.request().query(`
            SELECT
                c.name            AS column_name,
                tp.name           AS data_type,
                c.is_nullable,
                c.is_identity,
                c.max_length,
                c.column_id,
                ep.value          AS description
            FROM sys.columns c
            JOIN sys.types tp ON c.user_type_id = tp.user_type_id
            LEFT JOIN sys.extended_properties ep
                ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
            WHERE c.object_id = OBJECT_ID('${fullTableName}')
            ORDER BY c.column_id
        `);
        const columns = colResult.recordset;

        if (columns.length === 0) {
            addCheck(result.structure, '1.1', '表存在性', 'fail', `表 ${tableName} 不存在或无字段`);
            result.overall_result = 'fail';
            result.execution_time_ms = Date.now() - startTime;
            return result;
        }

        // 2) 主键字段
        const pkResult = await pool.request().query(`
            SELECT col.name AS pk_column
            FROM sys.indexes idx
            JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
            JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
            WHERE idx.is_primary_key = 1
              AND idx.object_id = OBJECT_ID('${fullTableName}')
            ORDER BY ic.key_ordinal
        `);
        const pkColumns = pkResult.recordset.map(r => r.pk_column);

        // 3) 索引信息（兼容 SQL Server 2016 以下，不用 STRING_AGG）
        const idxResult = await pool.request().query(`
            SELECT
                idx.name AS index_name,
                STUFF((
                    SELECT ',' + col2.name
                    FROM sys.index_columns ic2
                    JOIN sys.columns col2 ON ic2.object_id = col2.object_id AND ic2.column_id = col2.column_id
                    WHERE ic2.object_id = idx.object_id AND ic2.index_id = idx.index_id
                    ORDER BY ic2.key_ordinal
                    FOR XML PATH('')
                ), 1, 1, '') AS columns
            FROM sys.indexes idx
            WHERE idx.object_id = OBJECT_ID('${fullTableName}')
              AND idx.type > 0
            GROUP BY idx.name, idx.index_id, idx.object_id
        `);
        const indexes = idxResult.recordset;

        // 辅助：查找字段
        const colMap = {};
        columns.forEach(c => { colMap[c.column_name.toLowerCase()] = c; });
        const findCol = (name) => colMap[name.toLowerCase()];

        // ===== 判断 SCD 类型 =====
        const hasEffDt = !!findCol('dw_eff_dt');
        const isScd2 = hasEffDt;

        // ===== 推断业务键 =====
        let bizKeyColumns = [];
        if (businessKey) {
            bizKeyColumns = businessKey.split(',').map(k => k.trim());
        } else if (dimConfig && dimConfig.primary_key) {
            bizKeyColumns = dimConfig.primary_key.split(',').map(k => k.trim());
        } else {
            // 自动推断：排除 sk_、dw_ 开头和 IDENTITY 字段后，取第一个字段
            const candidates = columns.filter(c =>
                !c.column_name.toLowerCase().startsWith('sk_') &&
                !c.column_name.toLowerCase().startsWith('dw_') &&
                !c.is_identity
            );
            if (candidates.length > 0) {
                bizKeyColumns = [candidates[0].column_name];
            }
        }

        // ===== 阶段 1：结构验收（10 项） =====
        if (runPhase === 'all' || runPhase === 'structure') {

        // 1.1 代理键存在（SCD1 不要求代理键，SCD2/HYBRID 必须）
        const rawScdType = dimConfig?.scdConfig?.scdType || (isScd2 ? 'SCD2' : 'SCD1');
        const scdType = rawScdType === 'HYBRID' ? 'SCD2' : rawScdType;  // HYBRID 走 SCD2 验收路径
        const skCol = columns.find(c => c.column_name.toLowerCase().startsWith('sk_') && c.is_identity);
        if (skCol && pkColumns.includes(skCol.column_name)) {
            addCheck(result.structure, '1.1', '代理键存在', 'pass', `${skCol.column_name} (IDENTITY, PRIMARY KEY)`);
        } else if (skCol) {
            addCheck(result.structure, '1.1', '代理键存在', 'warn', `${skCol.column_name} (IDENTITY，但非 PRIMARY KEY)`);
        } else if (scdType === 'SCD1') {
            addCheck(result.structure, '1.1', '代理键存在', 'skip', 'SCD1 模式使用业务键，无需代理键');
        } else {
            addCheck(result.structure, '1.1', '代理键存在', 'fail', '未找到 sk_ 前缀的 IDENTITY 字段');
        }

        // 1.2 业务键存在
        if (bizKeyColumns.length > 0) {
            const allExist = bizKeyColumns.every(k => findCol(k));
            if (allExist) {
                const types = bizKeyColumns.map(k => `${k}(${findCol(k).data_type})`).join(', ');
                addCheck(result.structure, '1.2', '业务键存在', 'pass', types);
            } else {
                const missing = bizKeyColumns.filter(k => !findCol(k));
                addCheck(result.structure, '1.2', '业务键存在', 'fail', `字段不存在: ${missing.join(', ')}`);
            }
        } else {
            addCheck(result.structure, '1.2', '业务键存在', 'fail', '无法识别业务键');
        }

        // 1.3 - 1.5 SCD 控制字段
        const scdChecks = [
            { id: '1.3', field: 'dw_eff_dt', name: 'dw_eff_dt 字段', expectType: 'date' },
            { id: '1.4', field: 'dw_exp_dt', name: 'dw_exp_dt 字段', expectType: 'date' },
            { id: '1.5', field: 'dw_is_current_flg', name: 'dw_is_current_flg 字段', expectType: null }
        ];
        for (const chk of scdChecks) {
            if (!isScd2) {
                addCheck(result.structure, chk.id, chk.name, 'skip', 'SCD1 表无版本控制字段');
                continue;
            }
            const col = findCol(chk.field);
            if (!col) {
                addCheck(result.structure, chk.id, chk.name, 'fail', `字段不存在`);
            } else if (chk.expectType && col.data_type.toLowerCase() !== chk.expectType) {
                addCheck(result.structure, chk.id, chk.name, 'warn', `类型为 ${col.data_type}，期望 ${chk.expectType}`);
            } else {
                addCheck(result.structure, chk.id, chk.name, 'pass', `${col.data_type.toUpperCase()}`);
            }
        }

        // 1.6 - 1.8 审计字段
        const auditChecks = [
            { id: '1.6', field: 'dw_load_ts', name: 'dw_load_ts 字段' },
            { id: '1.7', field: 'dw_src_sys', name: 'dw_src_sys 字段' },
            { id: '1.8', field: 'dw_batch_id', name: 'dw_batch_id 字段' }
        ];
        for (const chk of auditChecks) {
            const col = findCol(chk.field);
            if (col) {
                addCheck(result.structure, chk.id, chk.name, 'pass', col.data_type.toUpperCase());
            } else {
                addCheck(result.structure, chk.id, chk.name, 'fail', '字段不存在');
            }
        }

        // 1.9 业务键有索引
        if (bizKeyColumns.length > 0 && bizKeyColumns.every(k => findCol(k))) {
            const bizKeySet = new Set(bizKeyColumns.map(k => k.toLowerCase()));
            const hasIndex = indexes.some(idx => {
                const idxCols = idx.columns.split(',').map(c => c.trim().toLowerCase());
                return [...bizKeySet].every(bk => idxCols.includes(bk));
            });
            if (hasIndex) {
                addCheck(result.structure, '1.9', '业务键索引', 'pass', `索引覆盖 ${bizKeyColumns.join(', ')}`);
            } else {
                addCheck(result.structure, '1.9', '业务键索引', 'fail', `${bizKeyColumns.join(', ')} 无索引覆盖`);
            }
        } else {
            addCheck(result.structure, '1.9', '业务键索引', 'skip', '业务键未确定');
        }

        // 1.10 字段注释覆盖率（DIM 层要求 100%）
        const totalCols = columns.length;
        const commentedCols = columns.filter(c => c.description && c.description.toString().trim() !== '').length;
        const coverageRate = totalCols > 0 ? (commentedCols / totalCols * 100).toFixed(1) : 0;
        if (commentedCols === totalCols) {
            addCheck(result.structure, '1.10', '字段注释覆盖率', 'pass', `${commentedCols}/${totalCols} (100%)`);
        } else {
            const missing = columns.filter(c => !c.description || c.description.toString().trim() === '').map(c => c.column_name);
            addCheck(result.structure, '1.10', '字段注释覆盖率', 'fail', `${commentedCols}/${totalCols} (${coverageRate}%)，缺失: ${missing.join(', ')}`);
        }
        } // end phase: structure

        // ===== 阶段 2：数据验收（5 项） =====
        if (runPhase === 'all' || runPhase === 'data') {
        // 先检查表中是否有数据
        const countResult = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${fullTableName}`);
        result.total_rows = countResult.recordset[0].cnt;

        if (result.total_rows === 0) {
            addCheck(result.data, '2.1', '当前版本数 = 业务键去重数', 'skip', '表中无数据');
            addCheck(result.data, '2.2', '当前版本 dw_exp_dt 一致', 'skip', '表中无数据');
            addCheck(result.data, '2.3', '无重复当前版本', 'skip', '表中无数据');
            addCheck(result.data, '2.4', '版本链连续', 'skip', '表中无数据');
            addCheck(result.data, '2.5', '审计日志存在', 'skip', '表中无数据');
        } else if (!isScd2) {
            // SCD1 表跳过版本相关检查
            addCheck(result.data, '2.1', '当前版本数 = 业务键去重数', 'skip', 'SCD1 表无版本控制');
            addCheck(result.data, '2.2', '当前版本 dw_exp_dt 一致', 'skip', 'SCD1 表无版本控制');
            addCheck(result.data, '2.3', '无重复当前版本', 'skip', 'SCD1 表无版本控制');
            addCheck(result.data, '2.4', '版本链连续', 'skip', 'SCD1 表无版本控制');
            // 审计日志仍然检查
            try {
                const auditResult = await pool.request().query(`
                    SELECT TOP 1 created_at FROM ${schema}.dw_audit_log
                    WHERE table_name = '${tableName}' ORDER BY created_at DESC
                `);
                if (auditResult.recordset.length > 0) {
                    const lastDate = auditResult.recordset[0].created_at;
                    addCheck(result.data, '2.5', '审计日志存在', 'pass', `最近: ${new Date(lastDate).toLocaleDateString()}`);
                } else {
                    addCheck(result.data, '2.5', '审计日志存在', 'warn', '无审计日志记录');
                }
            } catch (e) {
                addCheck(result.data, '2.5', '审计日志存在', 'warn', `审计表查询失败: ${e.message}`);
            }
        } else {
            // SCD2 表：并行执行 5 项数据验收
            const bizKeyExpr = bizKeyColumns.length === 1
                ? `[${bizKeyColumns[0]}]`
                : `CONCAT(${bizKeyColumns.map(k => `CAST([${k}] AS NVARCHAR(MAX))`).join(", '-', ")})`;

            // 版本链排序：优先用 change_id（业务顺序），否则回退到 dw_load_ts
            const hasChangeId = !!findCol('change_id');
            const versionOrderBy = hasChangeId
                ? '[change_id], [dw_eff_dt], [dw_load_ts]'
                : '[dw_eff_dt], [dw_load_ts]';

            const dataChecks = await Promise.all([
                // 2.1 当前版本数 = 业务键去重数
                pool.request().query(`
                    SELECT COUNT(*) AS total, COUNT(DISTINCT ${bizKeyExpr}) AS distinct_bk
                    FROM ${fullTableName} WHERE [dw_is_current_flg] = 1
                `).catch(e => ({ error: e.message })),

                // 2.2 当前版本 dw_exp_dt = 9999-12-31
                pool.request().query(`
                    SELECT COUNT(*) AS bad_count
                    FROM ${fullTableName}
                    WHERE [dw_is_current_flg] = 1 AND [dw_exp_dt] <> '9999-12-31'
                `).catch(e => ({ error: e.message })),

                // 2.3 无重复当前版本
                pool.request().query(`
                    SELECT COUNT(*) AS dup_groups FROM (
                        SELECT ${bizKeyExpr} AS bk
                        FROM ${fullTableName}
                        WHERE [dw_is_current_flg] = 1
                        GROUP BY ${bizKeyExpr}
                        HAVING COUNT(*) > 1
                    ) t
                `).catch(e => ({ error: e.message })),

                // 2.4 版本链连续（抽样 100 个多版本业务键）
                pool.request().query(`
                    WITH multi_ver AS (
                        SELECT ${bizKeyExpr} AS bk
                        FROM ${fullTableName}
                        GROUP BY ${bizKeyExpr}
                        HAVING COUNT(*) > 1
                    ),
                    sampled AS (
                        SELECT TOP 100 bk FROM multi_ver ORDER BY bk
                    ),
                    chained AS (
                        SELECT
                            ${bizKeyExpr} AS bk,
                            [dw_exp_dt],
                            LEAD([dw_eff_dt]) OVER (PARTITION BY ${bizKeyExpr} ORDER BY ${versionOrderBy}) AS next_eff_dt
                        FROM ${fullTableName}
                        WHERE ${bizKeyExpr} IN (SELECT bk FROM sampled)
                    )
                    SELECT COUNT(*) AS gap_count
                    FROM chained
                    WHERE next_eff_dt IS NOT NULL AND [dw_exp_dt] <> next_eff_dt
                `).catch(e => ({ error: e.message })),

                // 2.5 审计日志存在
                pool.request().query(`
                    SELECT TOP 1 created_at FROM ${schema}.dw_audit_log
                    WHERE table_name = '${tableName}' ORDER BY created_at DESC
                `).catch(e => ({ error: e.message }))
            ]);

            // 处理 2.1
            const check21 = dataChecks[0];
            if (check21.error) {
                addCheck(result.data, '2.1', '当前版本数 = 业务键去重数', 'fail', `查询失败: ${check21.error}`);
            } else {
                const { total, distinct_bk } = check21.recordset[0];
                if (total === distinct_bk) {
                    addCheck(result.data, '2.1', '当前版本数 = 业务键去重数', 'pass', `${total.toLocaleString()} = ${distinct_bk.toLocaleString()}`);
                } else {
                    addCheck(result.data, '2.1', '当前版本数 = 业务键去重数', 'fail', `${total.toLocaleString()} ≠ ${distinct_bk.toLocaleString()}`);
                }
            }

            // 处理 2.2
            const check22 = dataChecks[1];
            if (check22.error) {
                addCheck(result.data, '2.2', '当前版本 dw_exp_dt 一致', 'fail', `查询失败: ${check22.error}`);
            } else {
                const badCount = check22.recordset[0].bad_count;
                if (badCount === 0) {
                    addCheck(result.data, '2.2', '当前版本 dw_exp_dt 一致', 'pass', `异常: 0 条`);
                } else {
                    addCheck(result.data, '2.2', '当前版本 dw_exp_dt 一致', 'fail', `异常: ${badCount} 条 dw_exp_dt ≠ 9999-12-31`);
                }
            }

            // 处理 2.3
            const check23 = dataChecks[2];
            if (check23.error) {
                addCheck(result.data, '2.3', '无重复当前版本', 'fail', `查询失败: ${check23.error}`);
            } else {
                const dupGroups = check23.recordset[0].dup_groups;
                if (dupGroups === 0) {
                    addCheck(result.data, '2.3', '无重复当前版本', 'pass', `重复: 0 组`);
                } else {
                    addCheck(result.data, '2.3', '无重复当前版本', 'fail', `重复: ${dupGroups} 组`);
                }
            }

            // 处理 2.4
            const check24 = dataChecks[3];
            if (check24.error) {
                addCheck(result.data, '2.4', '版本链连续', 'warn', `查询失败: ${check24.error}`);
            } else {
                const gapCount = check24.recordset[0].gap_count;
                if (gapCount === 0) {
                    addCheck(result.data, '2.4', '版本链连续', 'pass', `断裂: 0 处 (抽样 100 个多版本业务键)`);
                } else {
                    addCheck(result.data, '2.4', '版本链连续', 'fail', `断裂: ${gapCount} 处`);
                }
            }

            // 处理 2.5
            const check25 = dataChecks[4];
            if (check25.error) {
                addCheck(result.data, '2.5', '审计日志存在', 'warn', `审计表查询失败: ${check25.error}`);
            } else if (check25.recordset.length > 0) {
                const lastDate = check25.recordset[0].created_at;
                addCheck(result.data, '2.5', '审计日志存在', 'pass', `最近: ${new Date(lastDate).toLocaleDateString()}`);
            } else {
                addCheck(result.data, '2.5', '审计日志存在', 'warn', '无审计日志记录');
            }
        }
        } // end phase: data

        // ===== 阶段 3：业务语义 =====
        if (runPhase === 'all' || runPhase === 'semantic') {
        // 字段分类
        const skFields = columns.filter(c => c.column_name.toLowerCase().startsWith('sk_'));
        const scdFields = columns.filter(c => ['dw_eff_dt', 'dw_exp_dt', 'dw_is_current_flg', 'dw_is_initial_flg'].includes(c.column_name.toLowerCase()));
        const auditFields = columns.filter(c => ['dw_load_ts', 'dw_src_sys', 'dw_batch_id'].includes(c.column_name.toLowerCase()));
        const bizKeySet = new Set(bizKeyColumns.map(k => k.toLowerCase()));
        const systemColNames = new Set([
            ...skFields.map(c => c.column_name.toLowerCase()),
            ...scdFields.map(c => c.column_name.toLowerCase()),
            ...auditFields.map(c => c.column_name.toLowerCase()),
            ...bizKeyColumns.map(k => k.toLowerCase())
        ]);
        const bizFields = columns.filter(c => !systemColNames.has(c.column_name.toLowerCase()));

        result.semantic = {
            scd_type: isScd2 ? 'SCD2' : 'SCD1',
            business_key: bizKeyColumns.map(k => {
                const col = findCol(k);
                return { name: k, type: col ? col.data_type : 'unknown' };
            }),
            field_groups: {
                surrogate_key: skFields.map(c => ({ name: c.column_name, type: c.data_type, description: c.description || '' })),
                business_key: bizKeyColumns.map(k => { const c = findCol(k); return c ? { name: c.column_name, type: c.data_type, description: c.description || '' } : { name: k, type: 'unknown', description: '' }; }),
                scd_control: scdFields.map(c => ({ name: c.column_name, type: c.data_type, description: c.description || '' })),
                audit: auditFields.map(c => ({ name: c.column_name, type: c.data_type, description: c.description || '' })),
                business: bizFields.map(c => ({ name: c.column_name, type: c.data_type, description: c.description || '' }))
            },
            total_columns: columns.length
        };
        } // end phase: semantic

        // ===== 计算 overall_result =====
        result.phase = runPhase;
        if (runPhase === 'semantic') {
            // 语义验收无自动判定，返回 pending 等待人工确认
            result.overall_result = 'pending';
        } else if (result.summary.fail > 0) {
            result.overall_result = 'fail';
        } else if (result.summary.warn > 0) {
            result.overall_result = 'warn';
        } else {
            result.overall_result = 'pass';
        }

    } catch (err) {
        logger.error('DIM validation error:', err.message);
        result.overall_result = 'fail';
        result.summary.fail++;
        result.structure.push({ id: 'ERR', name: '执行异常', status: 'fail', detail: err.message });
    }

    result.execution_time_ms = Date.now() - startTime;
    return result;
}


// ==================== DWD 验收引擎 ====================
async function executeDwdValidation(params) {
    const { pool, schema, tableName, dwdConfig, phase } = params;
    const VALID_PHASES = ['all', 'structure', 'data'];
    const runPhase = phase || 'all';
    if (!VALID_PHASES.includes(runPhase)) {
        return {
            overall_result: 'fail',
            summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
            structure: [], data: [], total_rows: 0,
            error: `无效的验收阶段: ${runPhase}，允许值: ${VALID_PHASES.join(', ')}`
        };
    }
    const fullTableName = `[${schema}].[${tableName}]`;
    const startTime = Date.now();

    const result = {
        overall_result: 'pass',
        summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
        structure: [],
        data: [],
        total_rows: 0
    };

    function addCheck(phaseArr, id, name, status, detail) {
        const item = { id, name, status, detail: detail || '' };
        phaseArr.push(item);
        if (status === 'fail') result.summary.fail++;
        else if (status === 'warn') result.summary.warn++;
        else if (status === 'pass') result.summary.pass++;
        else if (status === 'skip') result.summary.skip++;
    }

    try {
        // ===== 一次性获取表元数据 =====
        const colResult = await pool.request().query(`
            SELECT
                c.name            AS column_name,
                tp.name           AS data_type,
                c.is_nullable,
                c.is_identity,
                c.max_length,
                c.column_id,
                ep.value          AS description
            FROM sys.columns c
            JOIN sys.types tp ON c.user_type_id = tp.user_type_id
            LEFT JOIN sys.extended_properties ep
                ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
            WHERE c.object_id = OBJECT_ID('${fullTableName}')
            ORDER BY c.column_id
        `);
        const columns = colResult.recordset;

        if (columns.length === 0) {
            addCheck(result.structure, '1.1', '表存在性', 'fail', `表 ${tableName} 不存在或无字段`);
            result.overall_result = 'fail';
            result.execution_time_ms = Date.now() - startTime;
            return result;
        }

        // 主键字段
        const pkResult = await pool.request().query(`
            SELECT col.name AS pk_column
            FROM sys.indexes idx
            JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
            JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
            WHERE idx.is_primary_key = 1
              AND idx.object_id = OBJECT_ID('${fullTableName}')
            ORDER BY ic.key_ordinal
        `);
        const pkColumns = pkResult.recordset.map(r => r.pk_column);

        // 辅助：查找字段
        const colMap = {};
        columns.forEach(c => { colMap[c.column_name.toLowerCase()] = c; });
        const findCol = (name) => colMap[name.toLowerCase()];

        // ===== 阶段 1：结构验收（7~8 项） =====
        if (runPhase === 'all' || runPhase === 'structure') {

        // 1.1 表存在性
        addCheck(result.structure, '1.1', '表存在性', 'pass', `${columns.length} 个字段`);

        // 1.2 主键存在
        if (pkColumns.length > 0) {
            addCheck(result.structure, '1.2', '主键存在', 'pass', `PK: ${pkColumns.join(', ')}`);
        } else {
            addCheck(result.structure, '1.2', '主键存在', 'fail', '无主键');
        }

        // 1.3 主键唯一性约束（PRIMARY KEY 天然唯一）
        if (pkColumns.length > 0) {
            addCheck(result.structure, '1.3', '主键唯一性约束', 'pass', 'PRIMARY KEY 天然唯一');
        } else {
            addCheck(result.structure, '1.3', '主键唯一性约束', 'skip', '无主键');
        }

        // 1.4 - 1.6 审计字段
        const auditChecks = [
            { id: '1.4', field: 'dw_load_ts', name: '审计字段 dw_load_ts' },
            { id: '1.5', field: 'dw_src_sys', name: '审计字段 dw_src_sys' },
            { id: '1.6', field: 'dw_batch_id', name: '审计字段 dw_batch_id' }
        ];
        for (const chk of auditChecks) {
            const col = findCol(chk.field);
            if (col) {
                addCheck(result.structure, chk.id, chk.name, 'pass', col.data_type.toUpperCase());
            } else {
                addCheck(result.structure, chk.id, chk.name, 'fail', '字段不存在');
            }
        }

        // 1.7 字段注释覆盖率（DWD 层要求 100%）
        const totalCols = columns.length;
        const commentedCols = columns.filter(c => c.description && c.description.toString().trim() !== '').length;
        const coverageRate = totalCols > 0 ? (commentedCols / totalCols * 100).toFixed(1) : 0;
        if (commentedCols === totalCols) {
            addCheck(result.structure, '1.7', '字段注释覆盖率', 'pass', `${commentedCols}/${totalCols} (100%)`);
        } else {
            const missing = columns.filter(c => !c.description || c.description.toString().trim() === '').map(c => c.column_name);
            addCheck(result.structure, '1.7', '字段注释覆盖率', 'fail', `${commentedCols}/${totalCols} (${coverageRate}%)，缺失: ${missing.join(', ')}`);
        }

        // 1.8 dw_hash_val 字段（可选，hashEnabled 时检查）
        const hashEnabled = dwdConfig && dwdConfig.hashEnabled;
        if (hashEnabled) {
            const hashCol = findCol('dw_hash_val');
            if (hashCol) {
                addCheck(result.structure, '1.8', 'dw_hash_val 字段', 'pass', hashCol.data_type.toUpperCase());
            } else {
                addCheck(result.structure, '1.8', 'dw_hash_val 字段', 'fail', '配置启用了 hash 但字段不存在');
            }
        } else {
            const hashCol = findCol('dw_hash_val');
            if (hashCol) {
                addCheck(result.structure, '1.8', 'dw_hash_val 字段', 'pass', `${hashCol.data_type.toUpperCase()}（存在，配置未显式启用）`);
            } else {
                addCheck(result.structure, '1.8', 'dw_hash_val 字段', 'skip', '未启用 hash 变更检测');
            }
        }
        } // end phase: structure

        // ===== 阶段 2：数据验收（6 项） =====
        if (runPhase === 'all' || runPhase === 'data') {

        // 2.1 数据量
        const countResult = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${fullTableName}`);
        result.total_rows = countResult.recordset[0].cnt;

        if (result.total_rows === 0) {
            addCheck(result.data, '2.1', '数据量', 'fail', '表中无数据');
            addCheck(result.data, '2.2', '主键唯一性', 'skip', '表中无数据');
            addCheck(result.data, '2.3', '审计字段空值', 'skip', '表中无数据');
            addCheck(result.data, '2.4', '批次号一致性', 'skip', '表中无数据');
            addCheck(result.data, '2.5', 'dw_hash_val 填充率', 'skip', '表中无数据');
            addCheck(result.data, '2.6', 'ODS 源表行数对比', 'skip', '表中无数据');
        } else {
            addCheck(result.data, '2.1', '数据量', 'pass', `${result.total_rows.toLocaleString()} 行`);

            // 并行执行 2.2 - 2.6
            const pkExpr = pkColumns.length === 1
                ? `[${pkColumns[0]}]`
                : `CONCAT(${pkColumns.map(k => `CAST([${k}] AS NVARCHAR(MAX))`).join(", '-', ")})`;

            // 确定 ODS 主表名
            let odsMainTable = null;
            if (dwdConfig && dwdConfig.sourceTables && dwdConfig.sourceTables.length > 0) {
                odsMainTable = dwdConfig.sourceTables[0].tableName || dwdConfig.sourceTables[0].name;
            }

            const hasHashCol = !!findCol('dw_hash_val');

            const dataChecks = await Promise.all([
                // 2.2 主键唯一性
                pkColumns.length > 0
                    ? pool.request().query(`
                        SELECT COUNT(*) AS total, COUNT(DISTINCT ${pkExpr}) AS distinct_pk
                        FROM ${fullTableName}
                      `).catch(e => ({ error: e.message }))
                    : Promise.resolve({ skip: '无主键' }),

                // 2.3 审计字段空值
                pool.request().query(`
                    SELECT
                        SUM(CASE WHEN [dw_load_ts] IS NULL THEN 1 ELSE 0 END) AS null_load_ts,
                        SUM(CASE WHEN [dw_src_sys] IS NULL THEN 1 ELSE 0 END) AS null_src_sys,
                        SUM(CASE WHEN [dw_batch_id] IS NULL THEN 1 ELSE 0 END) AS null_batch_id
                    FROM ${fullTableName}
                `).catch(e => ({ error: e.message })),

                // 2.4 批次号一致性
                pool.request().query(`
                    SELECT COUNT(DISTINCT [dw_batch_id]) AS batch_count,
                           MIN([dw_batch_id]) AS min_batch,
                           MAX([dw_batch_id]) AS max_batch
                    FROM ${fullTableName}
                `).catch(e => ({ error: e.message })),

                // 2.5 dw_hash_val 填充率
                hasHashCol
                    ? pool.request().query(`
                        SELECT
                            COUNT(*) AS total,
                            SUM(CASE WHEN [dw_hash_val] IS NULL OR [dw_hash_val] = '' THEN 1 ELSE 0 END) AS null_count
                        FROM ${fullTableName}
                      `).catch(e => ({ error: e.message }))
                    : Promise.resolve({ skip: '无 dw_hash_val 字段' }),

                // 2.6 ODS 源表行数对比
                odsMainTable
                    ? pool.request().query(`
                        SELECT COUNT(*) AS ods_count FROM [${schema}].[${odsMainTable}]
                      `).catch(e => ({ error: e.message }))
                    : Promise.resolve({ skip: '无法确定 ODS 主表' })
            ]);

            // 处理 2.2
            const check22 = dataChecks[0];
            if (check22.skip) {
                addCheck(result.data, '2.2', '主键唯一性', 'skip', check22.skip);
            } else if (check22.error) {
                addCheck(result.data, '2.2', '主键唯一性', 'fail', `查询失败: ${check22.error}`);
            } else {
                const { total, distinct_pk } = check22.recordset[0];
                if (total === distinct_pk) {
                    addCheck(result.data, '2.2', '主键唯一性', 'pass', `${total.toLocaleString()} 行，主键全部唯一`);
                } else {
                    addCheck(result.data, '2.2', '主键唯一性', 'fail', `总行数 ${total.toLocaleString()}，去重 ${distinct_pk.toLocaleString()}，重复 ${(total - distinct_pk).toLocaleString()} 行`);
                }
            }

            // 处理 2.3
            const check23 = dataChecks[1];
            if (check23.error) {
                addCheck(result.data, '2.3', '审计字段空值', 'fail', `查询失败: ${check23.error}`);
            } else {
                const { null_load_ts, null_src_sys, null_batch_id } = check23.recordset[0];
                const nullFields = [];
                if (null_load_ts > 0) nullFields.push(`dw_load_ts: ${null_load_ts}`);
                if (null_src_sys > 0) nullFields.push(`dw_src_sys: ${null_src_sys}`);
                if (null_batch_id > 0) nullFields.push(`dw_batch_id: ${null_batch_id}`);
                if (nullFields.length === 0) {
                    addCheck(result.data, '2.3', '审计字段空值', 'pass', '3 个审计字段无空值');
                } else {
                    addCheck(result.data, '2.3', '审计字段空值', 'fail', `空值: ${nullFields.join(', ')}`);
                }
            }

            // 处理 2.4
            const check24 = dataChecks[2];
            if (check24.error) {
                addCheck(result.data, '2.4', '批次号一致性', 'fail', `查询失败: ${check24.error}`);
            } else {
                const { batch_count, min_batch, max_batch } = check24.recordset[0];
                if (batch_count === 1) {
                    addCheck(result.data, '2.4', '批次号一致性', 'pass', `1 个批次: ${min_batch}`);
                } else {
                    addCheck(result.data, '2.4', '批次号一致性', 'warn', `${batch_count} 个批次 (${min_batch} ~ ${max_batch})，增量模式正常`);
                }
            }

            // 处理 2.5
            const check25 = dataChecks[3];
            if (check25.skip) {
                addCheck(result.data, '2.5', 'dw_hash_val 填充率', 'skip', check25.skip);
            } else if (check25.error) {
                addCheck(result.data, '2.5', 'dw_hash_val 填充率', 'fail', `查询失败: ${check25.error}`);
            } else {
                const { total, null_count } = check25.recordset[0];
                const fillRate = ((total - null_count) / total * 100).toFixed(1);
                if (null_count === 0) {
                    addCheck(result.data, '2.5', 'dw_hash_val 填充率', 'pass', `${total.toLocaleString()} 行，100% 填充`);
                } else {
                    addCheck(result.data, '2.5', 'dw_hash_val 填充率', 'warn', `填充率 ${fillRate}%，${null_count.toLocaleString()} 行为空`);
                }
            }

            // 处理 2.6
            const check26 = dataChecks[4];
            if (check26.skip) {
                addCheck(result.data, '2.6', 'ODS 源表行数对比', 'skip', check26.skip);
            } else if (check26.error) {
                addCheck(result.data, '2.6', 'ODS 源表行数对比', 'warn', `ODS 表查询失败: ${check26.error}`);
            } else {
                const odsCount = check26.recordset[0].ods_count;
                const diff = Math.abs(result.total_rows - odsCount);
                const diffRate = odsCount > 0 ? (diff / odsCount * 100).toFixed(2) : 0;
                if (diff === 0) {
                    addCheck(result.data, '2.6', 'ODS 源表行数对比', 'pass', `DWD ${result.total_rows.toLocaleString()} = ODS ${odsCount.toLocaleString()}`);
                } else if (parseFloat(diffRate) <= 5) {
                    addCheck(result.data, '2.6', 'ODS 源表行数对比', 'pass', `DWD ${result.total_rows.toLocaleString()} vs ODS ${odsCount.toLocaleString()}，差异 ${diff} 行 (${diffRate}%)`);
                } else {
                    addCheck(result.data, '2.6', 'ODS 源表行数对比', 'warn', `DWD ${result.total_rows.toLocaleString()} vs ODS ${odsCount.toLocaleString()}，差异 ${diff} 行 (${diffRate}%)，超过 5% 阈值`);
                }
            }
        }
        } // end phase: data

        // ===== 计算 overall_result =====
        result.phase = runPhase;
        if (result.summary.fail > 0) {
            result.overall_result = 'fail';
        } else if (result.summary.warn > 0) {
            result.overall_result = 'warn';
        } else {
            result.overall_result = 'pass';
        }

    } catch (err) {
        logger.error('DWD validation error:', err.message);
        result.overall_result = 'fail';
        result.summary.fail++;
        result.structure.push({ id: 'ERR', name: '执行异常', status: 'fail', detail: err.message });
    }

    result.execution_time_ms = Date.now() - startTime;
    return result;
}


// ==================== 认证中间件 ====================

// JWT验证中间件
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];  // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: '未登录,请先登录' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: '登录已过期,请重新登录' });
        }
        // 实时校验用户状态，禁用用户立即失效
        db.get("SELECT status FROM users WHERE id = ?", [user.id], (dbErr, row) => {
            if (dbErr) return res.status(500).json({ error: dbErr.message });
            if (!row) return res.status(403).json({ error: '账号不存在' });
            if (row.status !== 'active') {
                return res.status(403).json({ error: '账号已被禁用' });
            }
            req.user = user;
            next();
        });
    });
}

// 管理员权限验证中间件
function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足,需要管理员权限' });
    }
    next();
}

// 发布者或管理员权限验证中间件
function requirePublisherOrAdmin(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'publisher') {
        return res.status(403).json({ error: '权限不足,需要发布者或管理员权限' });
    }
    next();
}

// 写权限白名单中间件：仅 admin / publisher / user 三种角色可调用写接口
// 改为白名单是为了防御未来新增角色或拼写异常时的意外放行（viewer 之外的未知角色一律拒）
const WRITE_ALLOWED_ROLES = ['admin', 'publisher', 'user'];
function requireNonViewer(req, res, next) {
    if (!req.user || !WRITE_ALLOWED_ROLES.includes(req.user.role)) {
        return res.status(403).json({ error: '查看者或未知角色无权执行此操作' });
    }
    next();
}

// v1.72.5 协作单 exporter-or-非viewer 中间件：在 requireNonViewer 基础上为 viewer 角色开一道窗
// 仅用于 admin 直派场景下 viewer 收单后能完成 submit-export / return-to-dev
// 规则：
//   - admin / publisher / user → 直接放行（同 requireNonViewer）
//   - viewer → 查 collab_requests.exporter_user_id，若 === userId 则放行（业务层 endpoint 内部还有一次判断，双重保险）
//   - 其他未知角色 → 拒
// 注意：仅放开"提交导出结果（submit-export）"+"回退到开发（return-to-dev）"两个动作；
//       通用附件上传 / notify / 转派等其他写接口仍走 requireNonViewer，viewer 一律拒
async function requireExporterOrNonViewer(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: '未登录' });
    }
    if (WRITE_ALLOWED_ROLES.includes(req.user.role)) {
        return next();
    }
    if (req.user.role !== 'viewer') {
        return res.status(403).json({ error: '未知角色无权执行此操作' });
    }
    // viewer 分支：查协作单看是否本单 exporter
    const idStr = req.params && req.params.id;
    if (!idStr || !/^[1-9]\d*$/.test(String(idStr))) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = Number(idStr);
    // codex 49 M-1：与 endpoint 内层保持防御对称
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    try {
        const collab = await dbGetAsync(
            'SELECT exporter_user_id FROM collab_requests WHERE id = ?',
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }
        if (collab.exporter_user_id == null || Number(collab.exporter_user_id) !== Number(req.user.id)) {
            return res.status(403).json({
                error: '查看者仅可操作本人被指派的协作单',
                code: 'VIEWER_NOT_EXPORTER'
            });
        }
        return next();
    } catch (e) {
        // codex 49 L-1：结构化错误码与项目约定对齐
        logger.error(`[requireExporterOrNonViewer] DB 查询失败 id=${idStr}: ${e.message}`);
        return res.status(500).json({ error: '权限校验失败', code: 'EXPORTER_PERMISSION_CHECK_FAILED' });
    }
}

// 模型业务权限：可编辑该模型（与前端 canEditThisModel 对齐）
// 规则：admin OR 该模型的 tech_owner OR 该模型的创建者
function canEditModel(user, model) {
    if (!user || !model) return false;
    if (user.role === 'admin') return true;
    const userName = (user.display_name || user.username || '').trim();
    const techOwner = (model.tech_owner || '').trim();
    if (userName && techOwner && userName === techOwner) return true;
    if (model.created_by_id && user.id && model.created_by_id === user.id) return true;
    return false;
}

// 模型业务权限：可对该模型执行验收/脚本保存等开发动作（与前端 canValidateThisModel 对齐）
// 规则：admin/publisher OR 该模型的 tech_owner OR 当前活跃任务的 owner
function canOperateModel(user, model, latestActiveTaskOwnerId) {
    if (!user || !model) return false;
    if (user.role === 'admin' || user.role === 'publisher') return true;
    const userName = (user.display_name || user.username || '').trim();
    const techOwner = (model.tech_owner || '').trim();
    if (userName && techOwner && userName === techOwner) return true;
    if (latestActiveTaskOwnerId && user.id && latestActiveTaskOwnerId === user.id) return true;
    return false;
}

// 校验模型是否已被其他活跃（未归档）任务关联
// 返回 null 表示可用；返回任务对象表示已被占用
// excludeTaskId 用于"任务编辑"场景，排除自身
function assertNoActiveTaskForModel(modelId, excludeTaskId = null) {
    return new Promise((resolve, reject) => {
        if (!modelId) return resolve(null);
        const params = [modelId];
        let sql = "SELECT id, title, status, owner FROM task_pool WHERE linked_model_id = ? AND status != 'ARCHIVED'";
        if (excludeTaskId) {
            sql += " AND id != ?";
            params.push(excludeTaskId);
        }
        sql += " LIMIT 1";
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

// 查询某模型的最新活跃任务 owner_id（用于 canOperateModel）
function getLatestActiveTaskOwnerId(modelId) {
    return new Promise((resolve) => {
        db.get(
            `SELECT owner_id FROM task_pool
             WHERE linked_model_id = ?
               AND status NOT IN ('ARCHIVED')
             ORDER BY claimed_at DESC, id DESC LIMIT 1`,
            [modelId],
            (err, row) => {
                if (err || !row) return resolve(null);
                resolve(row.owner_id || null);
            }
        );
    });
}

// 可选认证中间件(不强制登录,但如果有token会解析)
function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (!err) req.user = user;
            next();
        });
    } else {
        next();
    }
}

// ==================== 用户认证 API ====================

// 修改密码
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: '旧密码和新密码不能为空' });
    }

    try {
        // 获取当前用户密码hash
        db.get("SELECT password FROM users WHERE id = ?", [userId], async (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: '用户不存在' });

            // 验证旧密码
            const valid = await bcrypt.compare(oldPassword, row.password);
            if (!valid) {
                return res.status(401).json({ error: '旧密码错误' });
            }

            // 更新新密码
            const hashedNewPassword = await bcrypt.hash(newPassword, 10);
            db.run("UPDATE users SET password = ? WHERE id = ?", [hashedNewPassword, userId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: '密码修改成功' });
            });
        });
    } catch (e) {
        res.status(500).json({ error: '服务器错误' });
    }
});

// 用户登录
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    db.get("SELECT * FROM users WHERE username = ? AND status = 'active'", [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: '用户名或密码错误' });

        try {
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: '用户名或密码错误' });
            }

            // 生成JWT Token
            const token = jwt.sign(
                {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    role: user.role
                },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES_IN }
            );

            res.json({
                message: '登录成功',
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    role: user.role
                }
            });
        } catch (e) {
            res.status(500).json({ error: '登录验证失败' });
        }
    });
});

// 获取系统版本号（无需认证）
app.get('/api/version', (req, res) => {
    res.json({
        version: packageJson.version,
        name: '智数协同平台',
        nameEn: 'Smart Data Hub'
    });
});

// 获取当前用户信息
app.get('/api/auth/me', authenticateToken, (req, res) => {
    db.get("SELECT id, username, display_name, role, status FROM users WHERE id = ?", [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: '用户不存在' });
        res.json(user);
    });
});

// ==================== 用户管理 API (管理员) ====================

// 获取所有用户列表
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    db.all("SELECT id, username, display_name, role, status, phone, dingtalk_user_id, remark, created_at FROM users ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// phone 格式校验:11 位纯数字(国内手机号);允许空串/null 表示清空
function validatePhone(phone) {
    if (phone === undefined || phone === null || phone === '') return { ok: true, value: null };
    if (typeof phone !== 'string') return { ok: false, error: 'phone 必须是字符串' };
    const trimmed = phone.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (!/^\d{11}$/.test(trimmed)) return { ok: false, error: '手机号格式不正确(需 11 位纯数字)' };
    return { ok: true, value: trimmed };
}

// 获取所有活跃用户(用于转发选择 / v3 二级转派对接人&开发下拉)
app.get('/api/users/active', authenticateToken, (req, res) => {
    db.all("SELECT id, username, display_name, role, remark FROM users WHERE status = 'active' ORDER BY display_name", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 创建用户
app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    const { username, password, display_name, role, phone, remark } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const phoneCheck = validatePhone(phone);
    if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });

    // remark 校验：可选，最长 100 字，trim
    let remarkValue = '';
    if (remark !== undefined && remark !== null) {
        if (typeof remark !== 'string') return res.status(400).json({ error: 'remark 必须是字符串' });
        remarkValue = remark.trim().substring(0, 100);
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const stmt = db.prepare("INSERT INTO users (username, password, display_name, role, phone, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))");
        stmt.run(username, hashedPassword, display_name || username, role || 'user', phoneCheck.value, remarkValue, function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: '用户名已存在' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, message: '用户创建成功' });
        });
        stmt.finalize();
    } catch (e) {
        res.status(500).json({ error: '密码加密失败' });
    }
});

// 更新用户
app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { display_name, role, status, password, phone, remark } = req.body;

    // 防止禁用自己
    if (req.user.id == id && status === 'disabled') {
        return res.status(400).json({ error: '不能禁用自己的账户' });
    }

    // phone 校验:仅当请求体含 phone 字段时才处理(undefined 表示不动)
    let phoneValue;
    let phoneTouched = false;
    if (phone !== undefined) {
        const phoneCheck = validatePhone(phone);
        if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
        phoneValue = phoneCheck.value;
        phoneTouched = true;
    }

    // remark 校验：可选；undefined 表示不动；空串表示清空
    let remarkValue;
    let remarkTouched = false;
    if (remark !== undefined) {
        if (remark === null) {
            remarkValue = '';
        } else if (typeof remark !== 'string') {
            return res.status(400).json({ error: 'remark 必须是字符串' });
        } else {
            remarkValue = remark.trim().substring(0, 100);
        }
        remarkTouched = true;
    }

    // 动态构造 SQL,避免给老调用方加未传字段:phone 改了 → 同时清掉旧的 dingtalk_user_id 缓存
    const fields = ['display_name = ?', 'role = ?', 'status = ?'];
    const params = [display_name, role, status];
    if (phoneTouched) {
        fields.push('phone = ?', 'dingtalk_user_id = NULL');
        params.push(phoneValue);
    }
    if (remarkTouched) {
        fields.push('remark = ?');
        params.push(remarkValue);
    }
    if (password) {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            fields.push('password = ?');
            params.push(hashedPassword);
        } catch (e) {
            return res.status(500).json({ error: '密码加密失败' });
        }
    }
    params.push(id);
    const sql = `UPDATE users SET ${fields.join(', ')} WHERE id = ?`;

    db.run(sql, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '用户不存在' });
        res.json({ message: '用户更新成功' });
    });
});

// 删除用户(实际是禁用)
app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    // 防止删除自己
    if (req.user.id == id) {
        return res.status(400).json({ error: '不能删除自己的账户' });
    }

    db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '用户不存在' });
        res.json({ message: '用户已禁用' });
    });
});

// ==================== 任务 API ====================

// 1. Get All Tasks (包含转发接收人信息)
app.get('/api/pool', authenticateToken, (req, res) => {
    // 使用LEFT JOIN获取转发中任务的接收人信息, 并聚合多附件信息
    const sql = `
        SELECT t.*,
               CASE WHEN t.status = 'TRANSFERRING' THEN u.display_name ELSE NULL END as transfer_to_name,
               dm.status as linked_model_status,
               dm.table_name as linked_model_name,
               dm.table_comment as linked_model_comment,
               dm.source_system as linked_model_source_system,
               dm.source_table as linked_model_source_table,
               dm.update_cycle as linked_model_update_cycle,
               dm.is_deleted as linked_model_is_deleted,
               (
                   SELECT json_group_array(json_object(
                       'file_name', a.file_name,
                       'original_name', a.original_name,
                       'attachment_type', a.attachment_type
                   ))
                   FROM task_attachments a
                   WHERE a.task_id = t.id
               ) as attachments_json
        FROM task_pool t
        LEFT JOIN task_transfers tt ON t.id = tt.task_id AND tt.status = 'pending'
        LEFT JOIN users u ON tt.to_user_id = u.id
        LEFT JOIN data_models dm ON t.linked_model_id = dm.id
        ORDER BY 
            CASE WHEN t.priority = 'P0' THEN 0 
                 WHEN t.priority = 'P1' THEN 1 
                 ELSE 2 END,
            t.created_at DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // 收集需要计算工时的任务ID
        const taskIdsNeedDevHours = rows
            .filter(t => t.claimed_at || ['DONE', 'ARCHIVED'].includes(t.status))
            .map(t => t.id);

        // 批量查询所有相关任务的操作日志（1次查询代替N次）
        const logSql = taskIdsNeedDevHours.length > 0
            ? `SELECT task_id, operation_type, created_at FROM task_operation_logs
               WHERE task_id IN (${taskIdsNeedDevHours.map(() => '?').join(',')})
               ORDER BY task_id, created_at ASC`
            : null;

        const processResults = (allLogs) => {
            // 按 task_id 分组日志
            const logsByTask = {};
            if (allLogs) {
                for (const log of allLogs) {
                    if (!logsByTask[log.task_id]) logsByTask[log.task_id] = [];
                    logsByTask[log.task_id].push(log);
                }
            }

            const now = new Date();
            const startOps = ['CLAIM', 'ASSIGN', 'REOPEN', 'RESOLVE', 'WITHDRAW'];
            const endOps = ['SUBMIT', 'HOLD', 'UNCLAIM', 'TRANSFER'];

            const results = rows.map(task => {
                let attachments = [];
                try {
                    if (task.attachments_json) attachments = JSON.parse(task.attachments_json);
                } catch (e) { /* ignore */ }

                // ========== 任务周期计算 ==========
                let elapsed_hours = 0;
                let is_overdue = false;
                let overdue_hours = 0;

                if (['CLAIMED', 'ON_HOLD', 'TRANSFERRING'].includes(task.status) && task.claimed_at) {
                    const claimedAt = parseLocalDateTime(task.claimed_at);
                    elapsed_hours = (now - claimedAt) / (1000 * 60 * 60);
                    elapsed_hours = Math.round(elapsed_hours * 10) / 10;
                    if (task.estimated_hours > 0 && elapsed_hours > task.estimated_hours) {
                        is_overdue = true;
                        overdue_hours = Math.round((elapsed_hours - task.estimated_hours) * 10) / 10;
                    }
                }
                if (task.deadline && !['DONE', 'ARCHIVED'].includes(task.status)) {
                    if (now > parseLocalDateTime(task.deadline)) is_overdue = true;
                }

                // ========== 批量工时计算（内存中完成，无DB往返） ==========
                let dev_hours = 0;
                const logs = logsByTask[task.id];
                if (logs && logs.length > 0) {
                    let totalDevSeconds = 0;
                    let workStartTime = null;
                    for (const log of logs) {
                        const logTime = parseLocalDateTime(log.created_at);
                        if (startOps.includes(log.operation_type)) {
                            workStartTime = logTime;
                        } else if (endOps.includes(log.operation_type) && workStartTime) {
                            const seconds = (logTime - workStartTime) / 1000;
                            if (seconds > 0) totalDevSeconds += seconds;
                            workStartTime = null;
                        }
                    }
                    if (workStartTime) {
                        const seconds = (now - workStartTime) / 1000;
                        if (seconds > 0) totalDevSeconds += seconds;
                    }
                    dev_hours = Math.round(totalDevSeconds);
                }

                return { ...task, attachments, elapsed_hours, is_overdue, overdue_hours, dev_hours };
            });

            res.json(results);
        };

        if (logSql) {
            db.all(logSql, taskIdsNeedDevHours, (err2, allLogs) => {
                if (err2) {
                    logger.error('批量查询操作日志失败:', err2);
                    processResults([]); // 降级：不计算工时但不阻塞响应
                } else {
                    processResults(allLogs);
                }
            });
        } else {
            processResults([]);
        }
    });
});

// 2. Create Task (Publish) - 管理员或发布者
app.post('/api/create', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { title, desc, category, priority, linked_model_id, estimated_hours, deadline } = req.body;

    // 字段验证
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: "任务标题不能为空" });
    }
    if (title.length > 200) {
        return res.status(400).json({ error: "任务标题不能超过200个字符" });
    }

    // 验证任务类型
    const validCategory = category || 'DWD_DEV';
    if (!VALID_CATEGORIES.includes(validCategory)) {
        return res.status(400).json({ error: `无效的任务类型，有效值: ${VALID_CATEGORIES.join(', ')}` });
    }

    // 验证优先级
    const validPriorities = ['P0', 'P1', 'P2', 'P3'];
    const validPriority = priority || 'P2';
    if (!validPriorities.includes(validPriority)) {
        return res.status(400).json({ error: "无效的优先级，有效值: P0, P1, P2, P3" });
    }

    // 验证预估工时 (发布者填写，可选)
    const validEstHours = parseFloat(estimated_hours) || 0;
    if (validEstHours < 0 || validEstHours > 999) {
        return res.status(400).json({ error: "预估工时必须在0-999之间" });
    }

    // 验证截止时间 (可选)
    const validDeadline = deadline || null;

    // 校验模型是否被占用
    if (linked_model_id) {
        try {
            const existingTask = await assertNoActiveTaskForModel(linked_model_id);
            if (existingTask) {
                const ownerText = existingTask.owner ? ` (负责人: ${existingTask.owner})` : '';
                return res.status(400).json({
                    error: `该模型已关联其他进行中的任务：[${existingTask.status}] ${existingTask.title}${ownerText} (ID: ${existingTask.id})`
                });
            }
        } catch (e) {
            return res.status(500).json({ error: "模型状态检查失败: " + e.message });
        }
    }

    // 显式生成北京时间
    const now = new Date();
    const beijingTime = now.toLocaleString('sv-SE', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    }).replace('T', ' ');

    const operator = req.user.display_name || req.user.username;
    const stmt = db.prepare("INSERT INTO task_pool (title, desc, status, created_by, category, priority, linked_model_id, estimated_hours, deadline, created_at) VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)");
    stmt.run(title.trim(), desc || '', req.user.id, validCategory, validPriority, linked_model_id, validEstHours, validDeadline, beijingTime, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        // 记录发布日志
        insertOperationLog(this.lastID, 'PUBLISH', operator, `发布任务: ${title.trim()}`);
        res.json({ id: this.lastID, message: "Task published" });
    });
    stmt.finalize();
});

// 2.2 Batch Create Tasks (Import) - 管理员或发布者
app.post('/api/create/batch', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const tasks = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return res.status(400).json({ error: "Invalid task list" });
    }

    const userId = req.user.id;
    let successCount = 0;
    let failCount = 0;

    try {
        await dbRunAsync("BEGIN TRANSACTION");

        for (const task of tasks) {
            if (!task.title || !task.category || !task.desc) {
                failCount++;
                continue;
            }
            // 校验任务类型合法性
            if (!VALID_CATEGORIES.includes(task.category)) {
                failCount++;
                continue;
            }
            try {
                let linked_model_id = null;
                let linked_model_name = null;

                // 如果提供了模型关联信息（支持 ID 或表名）
                if (task.linked_model_id) {
                    const model = await dbGetAsync("SELECT id, table_name FROM data_models WHERE id = ?", [task.linked_model_id]);
                    if (model) {
                        linked_model_id = model.id;
                        linked_model_name = model.table_name;
                    }
                } else if (task.linked_model_name) {
                    const model = await dbGetAsync("SELECT id, table_name FROM data_models WHERE table_name = ?", [task.linked_model_name]);
                    if (model) {
                        linked_model_id = model.id;
                        linked_model_name = model.table_name;
                    }
                }

                // 校验模型活跃任务唯一性：同模型不能有多个未归档任务
                if (linked_model_id) {
                    const existingTask = await assertNoActiveTaskForModel(linked_model_id);
                    if (existingTask) {
                        failCount++;
                        continue;
                    }
                }

                await dbRunAsync(
                    "INSERT INTO task_pool (title, desc, status, created_by, category, linked_model_id, linked_model_name, created_at) VALUES (?, ?, 'OPEN', ?, ?, ?, ?, datetime('now', 'localtime'))",
                    [task.title, task.desc, userId, task.category, linked_model_id, linked_model_name]
                );
                successCount++;
            } catch (err) {
                console.error("Task insert error:", err.message);
                failCount++;
            }
        }

        await dbRunAsync("COMMIT");
        res.json({ success: successCount, failed: failCount, message: `成功导入 ${successCount} 条任务` });
    } catch (e) {
        console.error("Batch import transaction error:", e.message);
        try { await dbRunAsync("ROLLBACK"); } catch (rollbackErr) { /* ignore */ }
        res.status(500).json({ error: "Server Transaction Error" });
    }
});

// 2.1 Update Task Category - 管理员或发布者可修改任务类型
app.put('/api/tasks/:id/category', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { id } = req.params;
    const { category } = req.body;

    if (!category) {
        return res.status(400).json({ error: "Category is required" });
    }

    // 验证category值
    if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Invalid category value. Valid values: ${VALID_CATEGORIES.join(', ')}` });
    }

    const stmt = db.prepare("UPDATE task_pool SET category = ? WHERE id = ?");
    stmt.run(category, id, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Task not found" });
        res.json({ message: "Task category updated successfully", category });
    });
    stmt.finalize();
});

// 更新任务备注 - 发布者/管理员可编辑
app.put('/api/tasks/:id/remark', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { id } = req.params;
    const { desc } = req.body;

    const stmt = db.prepare("UPDATE task_pool SET desc = ? WHERE id = ?");
    stmt.run(desc || '', id, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: "Task not found" });
        res.json({ message: "Remark updated successfully" });
    });
    stmt.finalize();
});

// 2.1 获取单个任务详情 - 用于工作台抽屉缓存未命中场景
app.get('/api/tasks/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const sql = `
        SELECT t.*,
               dm.status as linked_model_status,
               dm.table_name as linked_model_name,
               dm.table_comment as linked_model_comment,
               dm.source_system as linked_model_source_system,
               dm.source_table as linked_model_source_table,
               dm.update_cycle as linked_model_update_cycle,
               dm.is_deleted as linked_model_is_deleted,
               (
                   SELECT json_group_array(json_object(
                       'file_name', a.file_name,
                       'original_name', a.original_name,
                       'attachment_type', a.attachment_type
                   ))
                   FROM task_attachments a
                   WHERE a.task_id = t.id
               ) as attachments_json
        FROM task_pool t
        LEFT JOIN data_models dm ON t.linked_model_id = dm.id
        WHERE t.id = ?
    `;
    db.get(sql, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "任务不存在" });
        let attachments = [];
        try {
            if (row.attachments_json) attachments = JSON.parse(row.attachments_json);
        } catch (e) { /* ignore */ }
        delete row.attachments_json;
        row.attachments = attachments;
        res.json(row);
    });
});

// 3. Claim Task - 需要登录
app.post('/api/claim', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    const owner = req.user.display_name || req.user.username;
    const ownerId = req.user.id;

    // 先查询任务获取关联的模型ID、预估工时和截止时间
    db.get("SELECT linked_model_id, estimated_hours, deadline FROM task_pool WHERE id = ? AND status = 'OPEN'", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(400).json({ error: "Task not found or already claimed" });

        // 计算截止时间：如果发布时未设置deadline，且有预估工时，则自动计算
        let deadlineClause = '';
        if (!task.deadline && task.estimated_hours > 0) {
            // deadline = 认领时间 + 预估工时（小时）
            deadlineClause = `, deadline = datetime('now', 'localtime', '+${Math.ceil(task.estimated_hours)} hours')`;
        }

        db.serialize(() => {
            // 更新任务状态，同时清空交付物相关字段（以防有残留数据）
            const stmt = db.prepare(`UPDATE task_pool SET status = 'CLAIMED', owner = ?, owner_id = ?, claimed_at = datetime('now', 'localtime'), submission = NULL, done_at = NULL, file_path = NULL${deadlineClause} WHERE id = ? AND status = 'OPEN'`);
            stmt.run(owner, ownerId, id, function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(400).json({ error: "Task not found or already claimed" });

                // 联动模型状态：CREATED -> DEVELOPING
                if (task.linked_model_id) {
                    db.run("UPDATE data_models SET status = 'DEVELOPING', updated_at = datetime('now', 'localtime') WHERE id = ?",
                        [task.linked_model_id],
                        (err) => {
                            if (err) logger.error("Failed to update model status to DEVELOPING:", err);
                            else logger.info(`Model ${task.linked_model_id} status updated to DEVELOPING after task ${id} claimed`);
                        }
                    );
                }

                // 删除附件记录（清除所有交付物信息，以防有残留）- 必须等待完成
                db.run("DELETE FROM task_attachments WHERE task_id = ?", [id], (deleteErr) => {
                    if (deleteErr) {
                        logger.error("Failed to clear attachment records:", deleteErr);
                        return res.status(500).json({ error: "Failed to clear attachment records" });
                    }
                    logger.info(`Attachment records cleared for task ${id} on claim`);
                    // 记录领取日志
                    insertOperationLog(id, 'CLAIM', owner);
                    res.json({ message: "Task claimed successfully and delivery artifacts cleared" });
                });
            });
            stmt.finalize();
        });
    });
});

// 4. Submit Task (Done) -- 已废弃，请使用 /api/submit2
app.post('/api/submit', authenticateToken, (req, res) => {
    res.status(410).json({ error: '此接口已废弃，请使用 /api/submit2' });
});

// 附件类型配置(严格限制文件格式)
// ODS: SQL脚本系统生成，只需数据量对比截图
// DIM: 字段映射可由系统自动生成，改为可选
const ATTACHMENT_TYPES = {
    'data_compare': { name: '数据量对比截图', extensions: ['.png', '.jpg', '.jpeg'], required: true, hint: '源表与目标表数据量对比' },
    'field_mapping': { name: '字段映射文档', extensions: ['.xlsx', '.xls'], required: false, hint: '可选，系统可自动生成' },
    'sql_script': { name: 'SQL加工脚本', extensions: ['.sql', '.txt'], required: false, hint: 'ODS/DIM可由系统生成' },
    'validation_report': { name: '数据验证报告', extensions: ['.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.docx', '.doc'], required: false, hint: '验收通过后可省略' },
    'scd_config': { name: 'SCD配置说明', extensions: ['.docx', '.doc', '.txt', '.md'], required: false, hint: 'SCD2维度表需提供' },
    'dim_relation': { name: '维度关联说明', extensions: ['.docx', '.doc', '.xlsx', '.xls', '.txt'], required: false, hint: '有层级关系时提供' },
    'sample_data': { name: '示例数据', extensions: ['.xlsx', '.xls'], required: false },
    'test_report': { name: '测试报告', extensions: ['.docx', '.doc'], required: false }
};

// 验证文件扩展名
function validateFileExtension(filename, allowedExtensions) {
    const ext = path.extname(filename).toLowerCase();
    return allowedExtensions.includes(ext);
}

// 4.1 多附件提交API (新版)
// 4.1 多附件提交API (新版)
// 增加 authenticateToken 以获取用户信息用于归档
app.post('/api/submit2', authenticateToken, requireNonViewer, upload.array('files', 10), (req, res) => {
    const { id, submission, attachmentTypes, scriptSource } = req.body;
    const files = req.files || [];
    const user = req.user; // 获取当前登录用户

    if (!id) return res.status(400).json({ error: "任务ID必填" });

    // 解析附件类型数组
    let typeArray = [];
    try {
        typeArray = typeof attachmentTypes === 'string' ? JSON.parse(attachmentTypes) : attachmentTypes || [];
    } catch (e) {
        return res.status(400).json({ error: "附件类型格式错误" });
    }

    // 1. 验证文件类型
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const attachType = typeArray[i];

        if (!attachType || !ATTACHMENT_TYPES[attachType]) {
            return res.status(400).json({ error: `附件${i + 1}的类型无效` });
        }

        const config = ATTACHMENT_TYPES[attachType];
        if (!validateFileExtension(file.originalname, config.extensions)) {
            // 删除已上传的文件（使用安全删除）
            files.forEach(f => {
                safeDeleteFileSync(f.filename, UPLOAD_DIR);
            });
            return res.status(400).json({
                error: `${config.name}只允许上传 ${config.extensions.join(', ')} 格式的文件`
            });
        }
    }

    // 2. 获取任务信息以构建目录 (包含claimed_at用于计算实际工时)
    db.get("SELECT title, linked_model_id, claimed_at, status, owner_id, owner FROM task_pool WHERE id = ?", [id], (err, taskRow) => {
        if (err || !taskRow) {
            return res.status(404).json({ error: "任务不存在" });
        }

        // 状态与权限校验：必须处于 CLAIMED，且操作人是 owner 或 admin/publisher
        if (taskRow.status !== 'CLAIMED') {
            // 已上传的临时文件清理
            files.forEach(f => safeDeleteFileSync(f.filename, UPLOAD_DIR));
            return res.status(400).json({ error: "仅进行中的任务可提交" });
        }
        const isOwner = (taskRow.owner_id && taskRow.owner_id === user.id) ||
            (taskRow.owner === user.display_name) ||
            (taskRow.owner === user.username);
        const isPrivileged = user.role === 'admin' || user.role === 'publisher';
        if (!isOwner && !isPrivileged) {
            files.forEach(f => safeDeleteFileSync(f.filename, UPLOAD_DIR));
            return res.status(403).json({ error: "无权提交此任务" });
        }

        // 自动判断 script_source：基于关联模型的 config_mode + script_modified
        const determineScriptSource = (callback) => {
            if (!taskRow.linked_model_id) return callback(null);
            db.get("SELECT config_mode, script_modified FROM data_models WHERE id = ?", [taskRow.linked_model_id], (err, model) => {
                if (err || !model) return callback(null);
                if (model.config_mode === 'custom') return callback('manual');
                // standard 模式：根据是否手动修改过判断
                return callback(model.script_modified === 1 ? 'modified' : 'auto');
            });
        };

        // 构建目标目录: uploads/[User]/[ID]_[Title]/
        // 替换非法文件名字符
        const safeTitle = taskRow.title.replace(/[\\/:*?"<>|]/g, '_');
        const userName = user ? (user.display_name || user.username) : 'Anonymous';
        const relativeTaskDir = path.join(userName, `${id}_${safeTitle}`);
        const absoluteTaskDir = path.join(UPLOAD_DIR, relativeTaskDir);

        if (!fs.existsSync(absoluteTaskDir)) {
            fs.mkdirSync(absoluteTaskDir, { recursive: true });
        }

        // 3. 移动文件并准备数据库记录
        const dbFiles = [];
        try {
            files.forEach((file, i) => {
                const oldPath = path.join(UPLOAD_DIR, file.filename); // Multer保存的临时名

                // ==================== 强制重命名 ====================
                // 使用本地时间生成日期字符串（服务器已部署在北京时区）
                const now = new Date();
                const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
                const attachType = typeArray[i] || 'other';
                const ext = path.extname(file.originalname).toLowerCase();
                // 格式: 1001_mapping_20241226.xlsx
                const targetName = `${id}_${attachType}_${dateStr}${ext}`;
                const targetPath = path.join(absoluteTaskDir, targetName);

                // 移动文件
                fs.renameSync(oldPath, targetPath);

                // 生成数据库存储的相对路径 (统一使用 / 作为分隔符供Web访问)
                // Windows上的 path.join 会用 \, 需要转换
                const dbPath = relativeTaskDir.split(path.sep).join('/') + '/' + targetName;

                dbFiles.push({
                    originalName: file.originalname,
                    fileName: dbPath
                });
            });
        } catch (moveErr) {
            console.error("File move error:", moveErr);
            return res.status(500).json({ error: "文件归档失败" });
        }

        // 4. 计算实际工时 (系统自动计算，存储秒数以保留精度)
        let actualSeconds = 0;
        if (taskRow.claimed_at) {
            const claimedAt = parseLocalDateTime(taskRow.claimed_at);
            const now = new Date();
            actualSeconds = Math.round((now - claimedAt) / 1000); // 存储秒数
        }

        // 5. 自动判断脚本来源后更新数据库
        determineScriptSource((autoScriptSource) => {
            db.serialize(() => {
                // 删除旧附件记录
                db.run("DELETE FROM task_attachments WHERE task_id = ?", [id], (err) => {
                    if (err) console.error("Error clearing old attachments:", err);
                });

                // 显式生成北京时间
                const now = new Date();
                const beijingTime = now.toLocaleString('sv-SE', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false
                }).replace('T', ' ');

                // 更新任务状态 + 实际工时（秒）+ 脚本来源（后端自动判断）
                db.run(
                    "UPDATE task_pool SET status = 'DONE', submission = ?, done_at = ?, actual_hours = ?, script_source = COALESCE(?, script_source) WHERE id = ?",
                    [submission || '', beijingTime, actualSeconds, autoScriptSource, id],
                    function (err) {
                        if (err) return res.status(500).json({ error: err.message });

                        // ==================== 联动逻辑: 模型状态 -> REVIEWING ====================
                        if (taskRow.linked_model_id) {
                            db.run("UPDATE data_models SET status = 'REVIEWING', updated_at = datetime('now', 'localtime') WHERE id = ?", [taskRow.linked_model_id], (err) => {
                                if (err) console.error("Failed to update model status to REVIEWING:", err);
                            });
                        }

                        // 保存附件记录
                        const insertStmt = db.prepare(
                            "INSERT INTO task_attachments (task_id, attachment_type, file_name, original_name) VALUES (?, ?, ?, ?)"
                        );

                        dbFiles.forEach((file, i) => {
                            insertStmt.run([id, typeArray[i], file.fileName, file.originalName]);
                        });

                        insertStmt.finalize(() => {
                            // 记录提交日志
                            insertOperationLog(id, 'SUBMIT', userName, submission || null);
                            res.json({
                                message: "任务提交成功",
                                scriptSource: autoScriptSource,
                                attachmentCount: dbFiles.length,
                                actual_hours: actualSeconds  // 返回实际工时（秒）
                            });
                        });
                    }
                );
            });
        });
    });
});

// 4.2 获取任务附件列表 (需要登录)
function taskAttachmentsHandler(req, res) {
    const taskId = req.params.taskId || req.params.id;

    db.all(
        "SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at",
        [taskId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            // 添加附件类型名称
            const attachments = rows.map(row => ({
                ...row,
                type_name: ATTACHMENT_TYPES[row.attachment_type]?.name || row.attachment_type
            }));

            res.json(attachments);
        }
    );
}
app.get('/api/attachments/:taskId', authenticateToken, taskAttachmentsHandler);
app.get('/api/tasks/:id/attachments', authenticateToken, taskAttachmentsHandler);

// 4.3 获取附件类型配置
app.get('/api/attachment-types', (req, res) => {
    const types = Object.entries(ATTACHMENT_TYPES).map(([key, value]) => ({
        key,
        name: value.name,
        extensions: value.extensions,
        required: value.required
    }));
    res.json(types);
});


// 5. Unclaim Task (CLAIMED -> OPEN) - 放弃领取
app.post('/api/unclaim', authenticateToken, requireNonViewer, (req, res) => {
    const { id, reason } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    // 放弃领取需要填写原因和操作人
    const unclaim_reason = reason ? reason.trim() : '';
    const unclaim_by = req.user.display_name || req.user.username;

    // 先查任务获取关联模型信息 + owner（用于权限校验）
    db.get("SELECT linked_model_id, owner_id, owner FROM task_pool WHERE id = ? AND status = 'CLAIMED'", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(400).json({ error: "Task cannot be unclaimed (must be CLAIMED state)" });

        // 权限校验：必须是 owner 本人，或 admin/publisher 代操作
        const isOwner = (task.owner_id && task.owner_id === req.user.id) ||
            (task.owner === req.user.display_name) ||
            (task.owner === req.user.username);
        const isPrivileged = req.user.role === 'admin' || req.user.role === 'publisher';
        if (!isOwner && !isPrivileged) {
            return res.status(403).json({ error: "无权放弃此任务" });
        }

        // 显式生成北京时间
        const now = new Date();
        const beijingTime = now.toLocaleString('sv-SE', {
            timeZone: 'Asia/Shanghai',
            hour12: false
        }).replace('T', ' ');

        db.serialize(() => {
            const stmt = db.prepare(`
                UPDATE task_pool
                SET status = 'OPEN',
                    owner = NULL,
                    owner_id = NULL,
                    claimed_at = NULL,
                    submission = NULL,
                    unclaim_reason = ?,
                    unclaim_at = ?,
                    unclaim_by = ?
                WHERE id = ? AND status = 'CLAIMED'
            `);
            stmt.run(unclaim_reason, beijingTime, unclaim_by, id, function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(400).json({ error: "Task cannot be unclaimed (must be CLAIMED state)" });

                // 联动模型状态：DEVELOPING -> CREATED
                if (task.linked_model_id) {
                    db.run("UPDATE data_models SET status = 'CREATED', updated_at = datetime('now', 'localtime') WHERE id = ? AND status = 'DEVELOPING'",
                        [task.linked_model_id],
                        (err) => {
                            if (err) logger.error("Failed to revert model status to CREATED:", err);
                            else logger.info(`Model ${task.linked_model_id} status reverted to CREATED after task ${id} unclaimed`);
                        }
                    );
                }

                // 记录操作日志
                insertOperationLog(id, 'UNCLAIM', unclaim_by, unclaim_reason);

                res.json({ message: "Task unclaimed successfully" });
            });
            stmt.finalize();
        });
    });
});


// 6. Withdraw Task (Revert DONE to CLAIMED) + DELETE FILE
app.post('/api/withdraw', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    // 权限校验：必须是任务 owner，或 admin/publisher 代操作；且必须是 DONE 状态
    db.get("SELECT status, owner_id, owner FROM task_pool WHERE id = ?", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(404).json({ error: "任务不存在" });
        if (task.status !== 'DONE') {
            return res.status(400).json({ error: "仅 DONE 状态的任务可撤回" });
        }

        const isOwner = (task.owner_id && task.owner_id === req.user.id) ||
            (task.owner === req.user.display_name) ||
            (task.owner === req.user.username);
        const isPrivileged = req.user.role === 'admin' || req.user.role === 'publisher';
        if (!isOwner && !isPrivileged) {
            return res.status(403).json({ error: "无权撤回此任务" });
        }

    // 1. 获取旧版单文件和新版多附件的文件信息
    const sql = `
        SELECT file_path FROM task_pool WHERE id = ?
        UNION
        SELECT file_name as file_path FROM task_attachments WHERE task_id = ?
    `;

    db.all(sql, [id, id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // 2. 更新任务状态 (原子操作，仅允许从 DONE 回到 CLAIMED)
        db.run(
            "UPDATE task_pool SET status = 'CLAIMED', done_at = NULL, file_path = NULL, submission = NULL WHERE id = ? AND status = 'DONE'",
            [id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) {
                    return res.status(409).json({ error: "任务状态已变更，无法撤回" });
                }

                // 3. 删除附件记录
                db.run("DELETE FROM task_attachments WHERE task_id = ?", [id], (err) => {
                    if (err) console.error("Failed to clear attachment records:", err);
                });

                // 4. 删除物理文件及目录（使用安全删除函数）
                const directoriesCleanup = new Set();
                rows.forEach(row => {
                    if (row.file_path) {
                        const fullPath = path.join(UPLOAD_DIR, row.file_path);
                        directoriesCleanup.add(path.dirname(fullPath));
                        safeDeleteFile(row.file_path, UPLOAD_DIR);
                    }
                });
                directoriesCleanup.forEach(dir => {
                    safeDeleteDir(dir, UPLOAD_DIR);
                });

                // 5. 同步模型状态回 DEVELOPING + 使旧验收记录失效
                db.get("SELECT linked_model_id FROM task_pool WHERE id = ?", [id], (err, taskRow) => {
                    if (!err && taskRow && taskRow.linked_model_id) {
                        db.run("UPDATE data_models SET status = 'DEVELOPING', updated_at = datetime('now', 'localtime') WHERE id = ? AND status = 'REVIEWING'",
                            [taskRow.linked_model_id], (err) => {
                                if (!err) logger.info(`Model ${taskRow.linked_model_id} status reverted to DEVELOPING after withdraw`);
                            });
                        db.run("UPDATE model_test_records SET invalidated = 1 WHERE model_id = ? AND invalidated = 0",
                            [taskRow.linked_model_id], (err) => {
                                if (!err) logger.info(`Invalidated test records for model ${taskRow.linked_model_id} after withdraw`);
                            });
                    }
                });

                // 记录操作日志
                const operator = req.user.display_name || req.user.username;
                insertOperationLog(id, 'WITHDRAW', operator, '取回任务继续开发');

                res.json({ message: "Task withdrawn and files deleted" });
            }
        );
    });
    });
});

// 检查模型的结构验收+数据验收是否都通过（支持 phase=all 的全量验收记录）
// 返回: { passed: boolean, structurePass: boolean, dataPass: boolean, allPass: boolean }
async function checkAllValidationsPassed(modelId) {
    const structureTest = await dbGetAsync(
        "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) AND detail_json LIKE '%\"phase\":\"structure\"%' ORDER BY test_time DESC LIMIT 1",
        [modelId]
    );
    const dataTest = await dbGetAsync(
        "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) AND detail_json LIKE '%\"phase\":\"data\"%' ORDER BY test_time DESC LIMIT 1",
        [modelId]
    );
    const allTest = await dbGetAsync(
        "SELECT overall_result FROM model_test_records WHERE model_id = ? AND detail_json LIKE '%\"phase\":\"all\"%' AND overall_result IN ('pass', 'warn') AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1",
        [modelId]
    );

    const structurePass = (structureTest && ['pass', 'warn'].includes(structureTest.overall_result));
    const dataPass = (dataTest && ['pass', 'warn'].includes(dataTest.overall_result));
    const allPass = !!allTest;

    return { passed: (allPass || structurePass) && (allPass || dataPass), structurePass, dataPass, allPass };
}

// 检查任务是否可以由owner自行归档
// 返回: { canSelfArchive: boolean, reason?: string }
app.get('/api/tasks/:id/can-self-archive', authenticateToken, async (req, res) => {
    const taskId = req.params.id;
    const userId = req.user.id;
    const userRole = req.user.role;

    try {
        const task = await dbGetAsync(
            "SELECT id, category, owner_id, linked_model_id, status FROM task_pool WHERE id = ?",
            [taskId]
        );

        if (!task) {
            return res.json({ canSelfArchive: false, reason: '任务不存在' });
        }

        if (task.status !== 'DONE') {
            return res.json({ canSelfArchive: false, reason: '任务不在DONE状态' });
        }

        // 必须关联模型
        if (!task.linked_model_id) {
            return res.json({ canSelfArchive: false, reason: '任务未关联模型' });
        }

        // admin/publisher 也需要验收通过才能归档，但跳过 owner 检查
        const isAdmin = (userRole === 'admin' || userRole === 'publisher');

        // 检查是否为owner（非管理员必须是 owner）
        if (!isAdmin && task.owner_id !== userId) {
            return res.json({ canSelfArchive: false, reason: '您不是该任务的持有者' });
        }

        // 仅 ODS_SYNC 任务允许 owner 自行归档；DIM/DWD 需管理员或发布者
        if (!isAdmin && task.category !== 'ODS_SYNC') {
            return res.json({ canSelfArchive: false, reason: 'DIM/DWD 任务需管理员或发布者确认归档' });
        }

        // admin/publisher 归档 DIM/DWD 时也需检查验收
        if (['DIM_DEV', 'DWD_DEV'].includes(task.category)) {
            const { structurePass, dataPass, allPass } = await checkAllValidationsPassed(task.linked_model_id);
            const layerName = task.category === 'DIM_DEV' ? 'DIM' : 'DWD';
            if (!allPass && !structurePass) {
                return res.json({ canSelfArchive: false, reason: `${layerName} 结构验收尚未通过` });
            }
            if (!allPass && !dataPass) {
                return res.json({ canSelfArchive: false, reason: `${layerName} 数据验收尚未通过` });
            }
        } else if (task.category === 'ODS_SYNC') {
            // ODS：检查最近一次自测是否通过
            const latestTest = await dbGetAsync(
                "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1",
                [task.linked_model_id]
            );

            if (!latestTest) {
                return res.json({ canSelfArchive: false, reason: '关联模型尚未进行自测' });
            }

            if (!['pass', 'warn'].includes(latestTest.overall_result)) {
                return res.json({ canSelfArchive: false, reason: '关联模型最近一次自测未通过' });
            }
        }

        // 所有条件都满足
        return res.json({ canSelfArchive: true, isAdmin, isOwner: task.owner_id === userId, testPassed: true });

    } catch (err) {
        logger.error('Error checking self-archive permission:', err);
        return res.status(500).json({ error: err.message });
    }
});

// 5.2 查询模型关联的可归档任务（轻量级，替代前端全量拉取任务列表）
app.get('/api/models/:id/archivable-task', authenticateToken, async (req, res) => {
    const modelId = parseInt(req.params.id);
    const userId = req.user.id;
    const isAdminOrPublisher = ['admin', 'publisher'].includes(req.user.role);

    try {
        // 查找关联该模型的 DONE 状态任务
        const task = await dbGetAsync(
            "SELECT id, title, owner_id, category, linked_model_id FROM task_pool WHERE linked_model_id = ? AND status = 'DONE' ORDER BY done_at DESC LIMIT 1",
            [modelId]
        );
        if (!task) {
            return res.json({ found: false });
        }

        // 权限检查：admin/publisher 或 owner
        const isOwner = task.owner_id === userId;
        if (!isAdminOrPublisher && !isOwner) {
            return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: '权限不足' });
        }

        // DIM/DWD 归档仅限 admin/publisher（owner 不能自行归档）
        if (!isAdminOrPublisher && ['DIM_DEV', 'DWD_DEV'].includes(task.category)) {
            return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: 'DIM/DWD 任务需管理员或发布者确认归档' });
        }

        // 任务类型检查
        if (!['ODS_SYNC', 'DIM_DEV', 'DWD_DEV'].includes(task.category)) {
            return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: '仅 ODS/DIM/DWD 任务支持归档' });
        }

        // 验收结果检查
        if (['DIM_DEV', 'DWD_DEV'].includes(task.category)) {
            const { structurePass, dataPass, allPass } = await checkAllValidationsPassed(modelId);
            const layerName = task.category === 'DIM_DEV' ? 'DIM' : 'DWD';

            if (!allPass && !structurePass) {
                return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: `${layerName} 结构验收尚未通过` });
            }
            if (!allPass && !dataPass) {
                return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: `${layerName} 数据验收尚未通过` });
            }
        } else {
            // ODS：查最新一条验收记录
            const latestTest = await dbGetAsync(
                "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1",
                [modelId]
            );
            if (!latestTest) {
                return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: '尚未进行自测' });
            }
            if (!['pass', 'warn'].includes(latestTest.overall_result)) {
                return res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: false, reason: '最近一次自测未通过' });
            }
        }

        res.json({ found: true, taskId: task.id, taskTitle: task.title, canSelfArchive: true });
    } catch (err) {
        logger.error('Error checking archivable task:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. Confirm/Archive Task (DONE -> ARCHIVED) + MOVE FILE + SYNC MODEL
// 权限说明：
// - admin/publisher: 可归档 DONE 状态的任务，但仍需验收通过
// - owner: ODS 任务需最近一次自测通过；DIM 任务需结构+数据验收都通过
app.post('/api/confirm', authenticateToken, requireNonViewer, async (req, res) => {
    const { id, review_note, review_checklist } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    const userId = req.user.id;
    const userRole = req.user.role;
    const isAdminOrPublisher = userRole === 'admin' || userRole === 'publisher';

    // 获取任务信息
    db.get("SELECT file_path, linked_model_id, category, owner_id FROM task_pool WHERE id = ? AND status = 'DONE'", [id], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "Task not found or not in DONE state" });

        const filePath = row.file_path;
        const isOwner = row.owner_id === userId;

        // 权限检查
        if (!isAdminOrPublisher) {
            // 非管理员/发布者，需要检查是否为owner且满足自行归档条件
            if (!isOwner) {
                return res.status(403).json({ error: '权限不足，您不是该任务的持有者' });
            }

            // 仅 ODS 任务允许 owner 自行归档；DIM/DWD 需管理员或发布者归档
            if (row.category !== 'ODS_SYNC') {
                return res.status(403).json({ error: '仅 ODS 开发任务支持开发者自行归档，DIM/DWD 任务需管理员或发布者确认归档' });
            }

            // 必须关联模型
            if (!row.linked_model_id) {
                return res.status(403).json({ error: '任务未关联模型，无法自行归档' });
            }

            if (row.category === 'ODS_SYNC') {
                // ODS：检查最近一次自测通过
                try {
                    const latestTest = await dbGetAsync(
                        "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1",
                        [row.linked_model_id]
                    );
                    if (!latestTest) {
                        return res.status(403).json({ error: '关联模型尚未进行自测，请先完成ODS自动验收' });
                    }
                    if (!['pass', 'warn'].includes(latestTest.overall_result)) {
                        return res.status(403).json({ error: '关联模型最近一次自测未通过，请修复问题后重新自测' });
                    }
                    logger.info(`ODS task ${id} self-archived by owner (user_id: ${userId}), model test passed`);
                } catch (dbErr) {
                    return res.status(500).json({ error: '检查自测结果失败: ' + dbErr.message });
                }
            } else if (row.category === 'DIM_DEV' || row.category === 'DWD_DEV') {
                // DIM/DWD：检查结构验收和数据验收都通过
                try {
                    const { structurePass, dataPass, allPass } = await checkAllValidationsPassed(row.linked_model_id);
                    const layerName = row.category === 'DIM_DEV' ? 'DIM' : 'DWD';

                    if (!allPass && !structurePass) {
                        return res.status(403).json({ error: `${layerName} 结构验收尚未通过，请先执行结构验收` });
                    }
                    if (!allPass && !dataPass) {
                        return res.status(403).json({ error: `${layerName} 数据验收尚未通过，请先执行数据验收` });
                    }

                    // 检查语义验收状态（可选，仅标记）
                    if (row.category === 'DIM_DEV') {
                        const semanticTest = await dbGetAsync(
                            "SELECT overall_result FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) AND detail_json LIKE '%\"phase\":\"semantic\"%' ORDER BY test_time DESC LIMIT 1",
                            [row.linked_model_id]
                        );
                        if (!semanticTest) {
                            logger.info(`DIM task ${id} archived without semantic review (allowed)`);
                        }
                    }

                    logger.info(`${layerName} task ${id} self-archived by owner (user_id: ${userId}), structure+data passed`);
                } catch (dbErr) {
                    return res.status(500).json({ error: '检查验收结果失败: ' + dbErr.message });
                }
            }
        } else {
            // admin/publisher 归档 DIM/DWD 任务时，也需检查验收是否通过
            if (['DIM_DEV', 'DWD_DEV'].includes(row.category) && row.linked_model_id) {
                try {
                    const { structurePass, dataPass, allPass } = await checkAllValidationsPassed(row.linked_model_id);
                    const layerName = row.category === 'DIM_DEV' ? 'DIM' : 'DWD';

                    if (!allPass && !structurePass) {
                        return res.status(403).json({ error: `${layerName} 结构验收尚未通过，请先执行结构验收` });
                    }
                    if (!allPass && !dataPass) {
                        return res.status(403).json({ error: `${layerName} 数据验收尚未通过，请先执行数据验收` });
                    }
                    logger.info(`${layerName} task ${id} archived by admin/publisher (user_id: ${userId}), structure+data passed`);
                } catch (dbErr) {
                    return res.status(500).json({ error: '检查验收结果失败: ' + dbErr.message });
                }
            }
        }

        try {
            // 1. 收集脚本快照（归档时保存当前脚本内容，便于追溯）
            let scriptSnapshot = null;
            if (row.linked_model_id) {
                try {
                    const model = await dbGetAsync(
                        'SELECT table_name, script_path, dim_config, config_mode FROM data_models WHERE id = ?',
                        [row.linked_model_id]
                    );
                    if (model && model.script_path) {
                        const safeTableName = model.table_name.replace(/[\\/:*?"<>|]/g, '_');
                        const scriptDir = path.join(UPLOAD_DIR, model.script_path);
                        const snapshot = { collected_at: new Date().toISOString(), scripts: {} };

                        // 读取 DDL 脚本
                        const ddlPath = path.join(scriptDir, `${safeTableName}_DDL.sql`);
                        if (fs.existsSync(ddlPath)) {
                            snapshot.scripts.ddl = fs.readFileSync(ddlPath, 'utf-8');
                        }

                        // 读取所有 ETL 脚本
                        if (fs.existsSync(scriptDir)) {
                            const etlFiles = fs.readdirSync(scriptDir).filter(f =>
                                f.endsWith('.sql') && !f.includes('_DDL') && !f.includes('_tabs_manifest')
                            );
                            for (const etlFile of etlFiles) {
                                const content = fs.readFileSync(path.join(scriptDir, etlFile), 'utf-8');
                                snapshot.scripts[etlFile] = content;
                            }
                        }

                        // 保存模型配置快照
                        if (model.dim_config) {
                            snapshot.model_config = typeof model.dim_config === 'string'
                                ? JSON.parse(model.dim_config) : model.dim_config;
                        }
                        snapshot.config_mode = model.config_mode;

                        scriptSnapshot = JSON.stringify(snapshot);
                    }
                } catch (snapshotErr) {
                    logger.warn(`Script snapshot collection failed for task ${id}:`, snapshotErr.message);
                    // 快照收集失败不阻塞归档
                }
            }

            // 2. 归档任务（记录验收信息 + 脚本快照）
            const now = new Date();
            const reviewTime = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ');
            const reviewerName = req.user.display_name || req.user.username;

            await dbRunAsync(
                `UPDATE task_pool SET
                    status = 'ARCHIVED',
                    reviewer_id = ?,
                    reviewer_name = ?,
                    review_time = ?,
                    review_note = ?,
                    review_checklist = ?,
                    script_snapshot = ?
                WHERE id = ?`,
                [userId, reviewerName, reviewTime, review_note || null, review_checklist || null, scriptSnapshot, id]
            );

            // 3. 联动模型状态（等待完成）
            if (row.linked_model_id) {
                let modelStatus = 'ONLINE';
                const category = row.category || 'DWD_DEV';
                if (['ODS_SYNC', 'DIM_DEV', 'DWD_DEV', 'ADS_RPT', 'DATA_FIX'].includes(category)) {
                    modelStatus = 'ONLINE';
                }

                const now = new Date();
                const beijingTime = now.toLocaleString('sv-SE', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false
                }).replace('T', ' ');

                await dbRunAsync("UPDATE data_models SET status = ?, updated_at = ? WHERE id = ?",
                    [modelStatus, beijingTime, row.linked_model_id]);
                logger.info(`Model ${row.linked_model_id} status updated to ${modelStatus} after task ${id} archived`);

                // 伴生表跟随主表状态流转
                await dbRunAsync(
                    "UPDATE data_models SET status = ?, updated_at = ? WHERE companion_of = ? AND (is_deleted = 0 OR is_deleted IS NULL)",
                    [modelStatus, beijingTime, row.linked_model_id]
                );
                logger.info(`Companion models of ${row.linked_model_id} also updated to ${modelStatus}`);
            }

            // 4. 移动文件（尽力而为，不阻塞响应）
            if (filePath) {
                const srcPath = path.join(UPLOAD_DIR, filePath);
                const destPath = path.join(ARCHIVE_DIR, filePath);
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }
                if (fs.existsSync(srcPath)) {
                    try {
                        fs.renameSync(srcPath, destPath);
                        logger.info("File archived:", filePath);
                    } catch (moveErr) {
                        logger.error("Failed to move file to archive:", moveErr);
                    }
                }
            }

            // 5. 记录操作日志并返回
            const operator = req.user.display_name || req.user.username;
            insertOperationLog(id, 'ARCHIVE', operator);
            res.json({ message: "Task archived and model status updated" });
        } catch (archiveErr) {
            logger.error("Archive operation failed:", archiveErr);
            res.status(500).json({ error: archiveErr.message });
        }
    });
});


// 6.5 获取任务验收记录（归档后可查看验收信息和脚本快照）
app.get('/api/tasks/:id/review-info', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const task = await dbGetAsync(
            `SELECT id, title, status, category, script_source, reviewer_id, reviewer_name,
                    review_time, review_note, review_checklist, script_snapshot
             FROM task_pool WHERE id = ?`,
            [id]
        );
        if (!task) {
            return res.status(404).json({ error: '任务不存在' });
        }
        if (task.status !== 'ARCHIVED') {
            return res.json({ hasReview: false, message: '任务尚未归档' });
        }

        // 解析 JSON 字段
        let checklist = null;
        if (task.review_checklist) {
            try { checklist = JSON.parse(task.review_checklist); } catch (e) { checklist = task.review_checklist; }
        }

        let snapshot = null;
        if (task.script_snapshot) {
            try { snapshot = JSON.parse(task.script_snapshot); } catch (e) { snapshot = null; }
        }

        res.json({
            hasReview: !!(task.reviewer_id || task.review_time),
            review: {
                reviewer_id: task.reviewer_id,
                reviewer_name: task.reviewer_name,
                review_time: task.review_time,
                review_note: task.review_note,
                review_checklist: checklist,
                script_source: task.script_source
            },
            script_snapshot: snapshot
        });
    } catch (err) {
        logger.error('Error fetching review info:', err);
        res.status(500).json({ error: err.message });
    }
});

// 7. Delete Task (Any Status) + DELETE FILE + 联动修正模型状态
app.post('/api/delete', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    try {
        const row = await dbGetAsync(
            "SELECT file_path, status, linked_model_id FROM task_pool WHERE id = ?",
            [id]
        );
        if (!row) return res.status(400).json({ error: "Task not found" });

        const { file_path: filePath, status, linked_model_id: linkedModelId } = row;

        // 1. 删除任务记录
        await dbRunAsync("DELETE FROM task_pool WHERE id = ?", [id]);

        // 2. 删除附件文件
        if (filePath) {
            const dir = status === 'ARCHIVED' ? ARCHIVE_DIR : UPLOAD_DIR;
            safeDeleteFile(filePath, dir);
        }

        // 3. 联动修正模型状态：仅当被删任务关联了模型、且模型不再有活跃任务时
        if (linkedModelId && status !== 'ARCHIVED') {
            const otherActive = await assertNoActiveTaskForModel(linkedModelId);
            if (!otherActive) {
                // 没有其他活跃任务 → 把模型回退到 CREATED（让流程重新走一遍）
                await dbRunAsync(
                    "UPDATE data_models SET status = 'CREATED', updated_at = datetime('now', 'localtime') WHERE id = ? AND status NOT IN ('ONLINE', 'OFFLINE')",
                    [linkedModelId]
                );
                logger.info(`Task ${id} deleted (was ${status}); model ${linkedModelId} reverted to CREATED (no remaining active tasks)`);
            } else {
                logger.info(`Task ${id} deleted (was ${status}); model ${linkedModelId} status preserved (other active task exists: #${otherActive.id})`);
            }
        }

        res.json({ message: "Task deleted successfully" });
    } catch (err) {
        logger.error('Delete task error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// 8. Reopen/Revert Task (ARCHIVED/DONE -> OPEN/CLAIMED) + DELETE ARCHIVED FILE + SYNC MODEL
// 支持退回备注功能
// DONE -> CLAIMED: 打回给开发人员修改（不删除文件）
// ARCHIVED -> OPEN/CLAIMED: 重新开放任务（删除归档文件）
app.post('/api/reopen', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { id, targetStatus, reason, reasonType } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });

    // 退回原因类型和影响级别映射
    const IMPACT_LEVELS = {
        'data_quality': { level: 'medium', label: '数据质量问题' },
        'schema_change': { level: 'high', label: '字段结构调整' },
        'logic_fix': { level: 'medium', label: '业务逻辑修正' },
        'performance': { level: 'low', label: '性能优化' },
        'upstream_change': { level: 'medium', label: '上游表变更' },
        'rollback': { level: 'high', label: '误操作回退' },
        'other': { level: 'medium', label: '其他' }
    };

    // 退回原因和操作人
    const reopen_reason = reason ? reason.trim() : '';
    const reopen_reason_type = reasonType || 'other';
    const impact_level = IMPACT_LEVELS[reopen_reason_type]?.level || 'medium';
    const reopen_by = req.user.display_name || req.user.username;

    // 2. 获取任务基本信息（支持 DONE 和 ARCHIVED 两种状态）
    db.get("SELECT status, file_path, linked_model_id, owner, owner_id FROM task_pool WHERE id = ? AND status IN ('DONE', 'ARCHIVED')", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "任务不存在或状态不正确（仅支持已完成/已归档状态）" });

        const currentStatus = row.status;

        // DONE 状态只能退回到 CLAIMED（让开发继续修改）
        // ARCHIVED 状态可以退回到 OPEN 或 CLAIMED
        let newStatus;
        if (currentStatus === 'DONE') {
            newStatus = 'CLAIMED';  // DONE 只能退回给开发人员
        } else {
            newStatus = targetStatus === 'CLAIMED' ? 'CLAIMED' : 'OPEN';
        }

        // DONE 状态退回：简单更新状态，保留文件
        if (currentStatus === 'DONE') {
            db.run(`
                UPDATE task_pool
                SET status = 'CLAIMED',
                    done_at = NULL,
                    reopen_reason = ?,
                    reopen_reason_type = ?,
                    reopen_at = datetime('now', 'localtime'),
                    reopen_by = ?
                WHERE id = ?
            `, [reopen_reason, reopen_reason_type, reopen_by, id], function (err) {
                if (err) return res.status(500).json({ error: err.message });

                // 同步模型状态回 DEVELOPING + 使旧验收记录失效
                if (row.linked_model_id) {
                    db.run("UPDATE data_models SET status = 'DEVELOPING', updated_at = datetime('now', 'localtime') WHERE id = ?",
                        [row.linked_model_id]);
                    db.run("UPDATE model_test_records SET invalidated = 1 WHERE model_id = ? AND invalidated = 0",
                        [row.linked_model_id]);
                }

                // 记录操作日志（包含影响级别）
                const logDetail = `${reopen_reason || '打回修改'} [影响级别: ${impact_level}]`;
                insertOperationLog(id, 'REOPEN', reopen_by, logDetail);
                res.json({ message: "任务已打回给开发人员修改", impactLevel: impact_level });
            });
            return;
        }

        // ARCHIVED 状态退回：需要清理文件
        // 1. 获取所有附件文件信息（包括旧版单文件和新版多附件）
        const sql = `
            SELECT file_path FROM task_pool WHERE id = ?
            UNION
            SELECT file_name as file_path FROM task_attachments WHERE task_id = ?
        `;

        db.all(sql, [id, id], (err, fileRows) => {
            if (err) return res.status(500).json({ error: err.message });

            db.serialize(() => {
                let stmt;
                let params;
                if (newStatus === 'CLAIMED') {
                    // 转回进行中：保留 owner 信息，清除提交相关字段
                    if (!row.owner) {
                        return res.status(400).json({ error: "Cannot revert to CLAIMED: task has no owner" });
                    }
                    stmt = db.prepare(`
                        UPDATE task_pool
                        SET status = 'CLAIMED',
                            submission = NULL,
                            done_at = NULL,
                            file_path = NULL,
                            reopen_reason = ?,
                            reopen_reason_type = ?,
                            reopen_at = datetime('now', 'localtime'),
                            reopen_by = ?
                        WHERE id = ?
                    `);
                    params = [reopen_reason, reopen_reason_type, reopen_by, id];
                } else {
                    // 转回任务池：清除所有信息
                    stmt = db.prepare(`
                        UPDATE task_pool
                        SET status = 'OPEN',
                            owner = NULL,
                            owner_id = NULL,
                            claimed_at = NULL,
                            submission = NULL,
                            done_at = NULL,
                            file_path = NULL,
                            reopen_reason = ?,
                            reopen_reason_type = ?,
                            reopen_at = datetime('now', 'localtime'),
                            reopen_by = ?
                        WHERE id = ?
                    `);
                    params = [reopen_reason, reopen_reason_type, reopen_by, id];
                }

                stmt.run(...params, function (err) {
                    if (err) return res.status(500).json({ error: err.message });

                    // 3. 删除附件记录（清除所有交付物信息）- 必须等待完成
                    db.run("DELETE FROM task_attachments WHERE task_id = ?", [id], (deleteErr) => {
                        if (deleteErr) {
                            logger.error("Failed to clear attachment records:", deleteErr);
                            return res.status(500).json({ error: "Failed to clear attachment records" });
                        }
                        logger.info(`Attachment records cleared for task ${id}`);

                        // 4. 删除所有物理文件（使用安全删除函数）
                        const directoriesCleanup = new Set();
                        fileRows.forEach(fileRow => {
                            if (fileRow.file_path) {
                                // 尝试从归档目录删除
                                const archivePath = path.join(ARCHIVE_DIR, fileRow.file_path);
                                if (fs.existsSync(archivePath)) {
                                    directoriesCleanup.add({ dir: path.dirname(archivePath), base: ARCHIVE_DIR });
                                    safeDeleteFile(fileRow.file_path, ARCHIVE_DIR);
                                } else {
                                    // 尝试从上传目录删除（以防有残留）
                                    const uploadPath = path.join(UPLOAD_DIR, fileRow.file_path);
                                    if (fs.existsSync(uploadPath)) {
                                        directoriesCleanup.add({ dir: path.dirname(uploadPath), base: UPLOAD_DIR });
                                        safeDeleteFile(fileRow.file_path, UPLOAD_DIR);
                                    }
                                }
                            }
                        });

                        // 5. 清理空目录（使用安全删除函数）
                        directoriesCleanup.forEach(item => {
                            safeDeleteDir(item.dir, item.base);
                        });

                        // 6. 同步模型状态：根据目标状态决定模型状态
                        // ARCHIVED → OPEN: 模型变为 CREATED（待开发）
                        // ARCHIVED → CLAIMED: 模型变为 DEVELOPING（开发中）
                        if (row.linked_model_id) {
                            const modelStatus = newStatus === 'CLAIMED' ? 'DEVELOPING' : 'CREATED';
                            db.run("UPDATE data_models SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
                                [modelStatus, row.linked_model_id],
                                (err) => {
                                    if (err) logger.error("Failed to update model status:", err);
                                    else logger.info(`Model ${row.linked_model_id} status updated to ${modelStatus} after task ${id} reverted to ${newStatus}`);
                                }
                            );
                        }

                        // 7. 记录操作日志（包含影响级别）
                        const statusText = newStatus === 'CLAIMED' ? '进行中' : '任务池';
                        const logDetail = `${reopen_reason || `退回到${statusText}`} [影响级别: ${impact_level}]`;
                        insertOperationLog(id, 'REOPEN', reopen_by, logDetail);
                        res.json({ message: `Task reverted to ${statusText} and all delivery artifacts cleared`, impactLevel: impact_level });
                    });
                });
                stmt.finalize();
            });
        });
    });
});

// 9. Update Task (Edit title, description, category, and linked_model_id)
app.post('/api/update', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { id, title, desc, category, linked_model_id } = req.body;
    if (!id) return res.status(400).json({ error: "ID is required" });
    if (!title) return res.status(400).json({ error: "Title is required" });

    // 校验任务类型合法性
    const validCategory = category || 'DWD_DEV';
    if (!VALID_CATEGORIES.includes(validCategory)) {
        return res.status(400).json({ error: `无效的任务类型，有效值: ${VALID_CATEGORIES.join(', ')}` });
    }

    try {
        if (linked_model_id) {
            // 校验模型存在
            const model = await dbGetAsync("SELECT table_name FROM data_models WHERE id = ?", [linked_model_id]);
            if (!model) {
                return res.status(400).json({ error: "Model not found" });
            }

            // 校验模型活跃任务唯一性：排除自身
            const existingTask = await assertNoActiveTaskForModel(linked_model_id, id);
            if (existingTask) {
                const ownerText = existingTask.owner ? ` (负责人: ${existingTask.owner})` : '';
                return res.status(400).json({
                    error: `该模型已关联其他进行中的任务：[${existingTask.status}] ${existingTask.title}${ownerText} (ID: ${existingTask.id})`
                });
            }

            // 更新任务，包括模型关联
            const result = await dbRunAsync(
                "UPDATE task_pool SET title = ?, desc = ?, category = ?, linked_model_id = ?, linked_model_name = ? WHERE id = ?",
                [title, desc || '', validCategory, linked_model_id, model.table_name, id]
            );
            if (result.changes === 0) return res.status(404).json({ error: "Task not found" });
            res.json({ message: "Task updated successfully" });
        } else {
            // 如果没有提供linked_model_id，清空模型关联
            const result = await dbRunAsync(
                "UPDATE task_pool SET title = ?, desc = ?, category = ?, linked_model_id = NULL, linked_model_name = NULL WHERE id = ?",
                [title, desc || '', validCategory, id]
            );
            if (result.changes === 0) return res.status(404).json({ error: "Task not found" });
            res.json({ message: "Task updated successfully" });
        }
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 更新任务开发笔记 (仅任务负责人可用)
app.put('/api/tasks/:id/notes', authenticateToken, requireNonViewer, (req, res) => {
    const taskId = req.params.id;
    const { dev_notes } = req.body;
    const username = req.user.username;

    // 验证用户是任务负责人
    db.get("SELECT owner, owner_id FROM task_pool WHERE id = ?", [taskId], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(404).json({ error: "任务不存在" });

        // 宽松验证: 优先匹配ID, 其次匹配显示名或用户名
        const isOwner = (task.owner_id && task.owner_id === req.user.id) ||
            (task.owner === req.user.display_name) ||
            (task.owner === username);

        if (!isOwner) {
            return res.status(403).json({ error: "只有任务负责人可以更新笔记" });
        }

        db.run("UPDATE task_pool SET dev_notes = ? WHERE id = ?", [dev_notes || '', taskId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "笔记更新成功" });
        });
    });
});

// 10. Reset Task (Admin Force Reset - Deprecated by Reopen but kept for safety)
app.post('/api/reset', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.body;
    db.run("UPDATE task_pool SET status = 'OPEN', owner = NULL, claimed_at = NULL, submission = NULL, file_path = NULL, done_at = NULL WHERE id = ?", [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Task reset" });
    });

});


// ==================== 任务操作日志 API ====================

// 获取任务的操作日志
app.get('/api/tasks/:id/operation-logs', authenticateToken, (req, res) => {
    const { id } = req.params;

    db.all(
        "SELECT * FROM task_operation_logs WHERE task_id = ? ORDER BY created_at DESC",
        [id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});


// ==================== 任务转发 API ====================

// 获取当前用户待处理的转发请求
app.get('/api/transfers/pending', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.all(`
        SELECT t.*, 
               tp.title as task_title,
               tp.desc as task_desc,
               u.display_name as from_user_name
        FROM task_transfers t
        JOIN task_pool tp ON t.task_id = tp.id
        JOIN users u ON t.from_user_id = u.id
        WHERE t.to_user_id = ? AND t.status = 'pending'
        ORDER BY t.created_at DESC
    `, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 获取当前用户发起的转发请求
app.get('/api/transfers/sent', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.all(`
        SELECT t.*, 
               tp.title as task_title,
               u.display_name as to_user_name
        FROM task_transfers t
        JOIN task_pool tp ON t.task_id = tp.id
        JOIN users u ON t.to_user_id = u.id
        WHERE t.from_user_id = ? AND t.status = 'pending'
        ORDER BY t.created_at DESC
    `, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 发起任务转发
app.post('/api/transfers', authenticateToken, requireNonViewer, (req, res) => {
    const { task_id, to_user_id, reason } = req.body;
    const fromUserId = req.user.id;
    const operator = req.user.display_name || req.user.username;

    if (!task_id || !to_user_id) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: '请填写转发原因' });
    }

    if (fromUserId == to_user_id) {
        return res.status(400).json({ error: '不能转发给自己' });
    }

    // 验证任务是否属于当前用户且状态为CLAIMED
    db.get("SELECT * FROM task_pool WHERE id = ? AND owner_id = ? AND status = 'CLAIMED'", [task_id, fromUserId], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(400).json({ error: '任务不存在或无权转发(只能转发自己进行中的任务)' });

        // 检查是否已有待处理的转发
        db.get("SELECT id FROM task_transfers WHERE task_id = ? AND status = 'pending'", [task_id], (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });
            if (existing) return res.status(400).json({ error: '该任务已有待处理的转发请求' });

            // 获取目标用户名
            db.get("SELECT display_name, username FROM users WHERE id = ?", [to_user_id], (err, toUser) => {
                if (err) return res.status(500).json({ error: err.message });
                const toUserName = toUser ? (toUser.display_name || toUser.username) : '未知用户';

                // 创建转发请求,同时更新任务状态为TRANSFERRING
                db.serialize(() => {
                    db.run("UPDATE task_pool SET status = 'TRANSFERRING' WHERE id = ?", [task_id]);
                    db.run(
                        "INSERT INTO task_transfers (task_id, from_user_id, to_user_id, reason) VALUES (?, ?, ?, ?)",
                        [task_id, fromUserId, to_user_id, reason.trim()],
                        function (err) {
                            if (err) return res.status(500).json({ error: err.message });
                            // 记录操作日志
                            insertOperationLog(task_id, 'TRANSFER', operator, `转发给 ${toUserName}：${reason.trim()}`);
                            res.json({ id: this.lastID, message: '转发请求已发送' });
                        }
                    );
                });
            });
        });
    });
});

// 接受转发
app.post('/api/transfers/:id/accept', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const operator = req.user.display_name || req.user.username;

    db.get("SELECT * FROM task_transfers WHERE id = ? AND to_user_id = ? AND status = 'pending'", [id, userId], (err, transfer) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!transfer) return res.status(404).json({ error: '转发请求不存在或无权操作' });

        db.serialize(() => {
            // 更新转发状态
            db.run("UPDATE task_transfers SET status = 'accepted', resolved_at = datetime('now', 'localtime') WHERE id = ?", [id]);

            // 更新任务归属
            db.get("SELECT display_name FROM users WHERE id = ?", [userId], (err, user) => {
                db.run(
                    "UPDATE task_pool SET owner_id = ?, owner = ?, status = 'CLAIMED' WHERE id = ?",
                    [userId, user ? user.display_name : req.user.username, transfer.task_id],
                    function (err) {
                        if (err) return res.status(500).json({ error: err.message });
                        // 记录操作日志
                        insertOperationLog(transfer.task_id, 'TRANSFER_ACCEPT', operator, '接受了转发请求');
                        res.json({ message: '已接受转发,任务已转移到您的名下' });
                    }
                );
            });
        });
    });
});

// 拒绝转发
app.post('/api/transfers/:id/reject', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    const operator = req.user.display_name || req.user.username;

    db.get("SELECT * FROM task_transfers WHERE id = ? AND to_user_id = ? AND status = 'pending'", [id, userId], (err, transfer) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!transfer) return res.status(404).json({ error: '转发请求不存在或无权操作' });

        db.serialize(() => {
            // 更新转发状态
            db.run("UPDATE task_transfers SET status = 'rejected', resolved_at = datetime('now', 'localtime') WHERE id = ?", [id]);

            // 恢复任务状态
            db.run("UPDATE task_pool SET status = 'CLAIMED' WHERE id = ?", [transfer.task_id], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                // 记录操作日志
                const logReason = reason ? `拒绝了转发请求：${reason.trim()}` : '拒绝了转发请求';
                insertOperationLog(transfer.task_id, 'TRANSFER_REJECT', operator, logReason);
                res.json({ message: '已拒绝转发' });
            });
        });
    });
});

// 取消转发(发起者)
app.post('/api/transfers/:id/cancel', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const operator = req.user.display_name || req.user.username;

    db.get("SELECT * FROM task_transfers WHERE id = ? AND from_user_id = ? AND status = 'pending'", [id, userId], (err, transfer) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!transfer) return res.status(404).json({ error: '转发请求不存在或无权操作' });

        db.serialize(() => {
            // 更新转发状态
            db.run("UPDATE task_transfers SET status = 'cancelled', resolved_at = datetime('now', 'localtime') WHERE id = ?", [id]);

            // 恢复任务状态
            db.run("UPDATE task_pool SET status = 'CLAIMED' WHERE id = ?", [transfer.task_id], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                // 记录操作日志
                insertOperationLog(transfer.task_id, 'TRANSFER_CANCEL', operator, '取消了转发请求');
                res.json({ message: '已取消转发' });
            });
        });
    });
});

// 管理员或发布者强制分配任务(无需确认)
app.post('/api/tasks/:id/assign', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { id } = req.params;
    const { to_user_id } = req.body;

    if (!to_user_id) {
        return res.status(400).json({ error: '请选择要分配给的用户' });
    }

    // 检查任务是否存在且状态为OPEN或CLAIMED（支持待认领和进行中状态的分配）
    db.get("SELECT * FROM task_pool WHERE id = ? AND status IN ('OPEN', 'CLAIMED')", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(400).json({ error: '任务不存在或状态不允许分配（仅支持待认领和进行中状态）' });

        // 获取目标用户信息
        db.get("SELECT id, display_name, username FROM users WHERE id = ? AND status = 'active'", [to_user_id], (err, targetUser) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!targetUser) return res.status(400).json({ error: '目标用户不存在或已禁用' });

            // 直接更新任务归属，如果是从OPEN状态分配，需要更新状态为CLAIMED并设置认领时间
            const newOwner = targetUser.display_name || targetUser.username;
            const isFromOpen = task.status === 'OPEN';

            // 计算截止时间：如果从OPEN状态分配，且发布时未设置deadline，且有预估工时，则自动计算
            let deadlineClause = '';
            if (isFromOpen && !task.deadline && task.estimated_hours > 0) {
                deadlineClause = `, deadline = datetime('now', 'localtime', '+${Math.ceil(task.estimated_hours)} hours')`;
            }

            const updateSql = isFromOpen
                ? `UPDATE task_pool SET owner_id = ?, owner = ?, status = 'CLAIMED', claimed_at = datetime('now', 'localtime')${deadlineClause} WHERE id = ?`
                : "UPDATE task_pool SET owner_id = ?, owner = ? WHERE id = ?";
            const updateParams = isFromOpen ? [to_user_id, newOwner, id] : [to_user_id, newOwner, id];

            db.run(updateSql, updateParams, function (err) {
                if (err) return res.status(500).json({ error: err.message });

                // 记录分配操作日志
                const operator = req.user.display_name || req.user.username;
                const logReason = isFromOpen
                    ? `分配任务给 ${newOwner}`
                    : `重新分配任务给 ${newOwner}（原负责人: ${task.owner || '无'}）`;
                insertOperationLog(id, 'ASSIGN', operator, logReason);

                const statusText = isFromOpen ? '已分配并认领' : '已重新分配';
                res.json({ message: `任务${statusText}给 ${newOwner}` });
            });
        });
    });
});

// ==================== 文件预览 API ====================

// 预览Excel文件(字段映射文档等)
app.get('/api/preview/excel/:filename', (req, res) => {
    const { filename } = req.params;

    // 尝试在uploads和archive目录查找文件
    let filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(ARCHIVE_DIR, filename);
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    // 检查是否为Excel文件
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
        return res.status(400).json({ error: '仅支持Excel文件(.xlsx, .xls)预览' });
    }

    try {
        // 读取并解析Excel文件
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0]; // 读取第一个Sheet
        const sheet = workbook.Sheets[sheetName];

        // 转换为JSON格式
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        if (data.length === 0) {
            return res.json({ headers: [], rows: [], sheetName });
        }

        // 第一行作为表头
        const headers = data[0] || [];
        const rows = data.slice(1);

        res.json({
            sheetName,
            headers,
            rows,
            totalRows: rows.length
        });
    } catch (err) {
        console.error('Excel解析失败:', err);
        res.status(500).json({ error: 'Excel文件解析失败: ' + err.message });
    }
});

// ==================== 文档中心 API ====================

// ==================== 文档中心 API (Database Driven) ====================

function initDocTable() {
    // 创建文档表（含版本管理字段）
    db.run(`CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        filename TEXT UNIQUE,
        category TEXT,
        icon TEXT,
        description TEXT,
        is_visible INTEGER DEFAULT 1,
        version TEXT DEFAULT '1.0',
        version_group TEXT,
        is_latest INTEGER DEFAULT 1,
        is_download INTEGER DEFAULT 0,
        file_type TEXT,
        change_log TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`, (err) => {
        if (!err) {
            // 添加版本相关字段（如果表已存在但缺少字段）
            db.run("ALTER TABLE documents ADD COLUMN version TEXT DEFAULT '1.0'", () => { });
            db.run("ALTER TABLE documents ADD COLUMN version_group TEXT", () => { });
            db.run("ALTER TABLE documents ADD COLUMN is_latest INTEGER DEFAULT 1", () => { });
            db.run("ALTER TABLE documents ADD COLUMN change_log TEXT", () => { });
            db.run("ALTER TABLE documents ADD COLUMN is_download INTEGER DEFAULT 0", () => { });
            db.run("ALTER TABLE documents ADD COLUMN file_type TEXT", () => { });
            syncDocsFromDisk();
        }
    });
}

// 从文件名中提取版本号和基础名称
// 例如: "开发需求说明书_招投标与合同域_v1.1.md" -> { baseName: "开发需求说明书_招投标与合同域", version: "1.1" }
function extractVersionInfo(filename) {
    const basename = path.basename(filename, '.md');
    // 匹配 _v1.0, _v1.1, _v2.0 等版本格式
    const versionMatch = basename.match(/_v(\d+\.\d+)$/i);
    if (versionMatch) {
        return {
            baseName: basename.replace(/_v\d+\.\d+$/i, ''),
            version: versionMatch[1]
        };
    }
    // 无版本号，默认为 1.0
    return {
        baseName: basename,
        version: '1.0'
    };
}

// 自动扫描磁盘同步文档
function syncDocsFromDisk() {
    const docsRoot = path.join(__dirname, '..', 'docs');

    // 定义目录映射规则（按角色场景分组：开发必读 / 业务参考 / 项目管理 / 资源）
    const categoryMap = {
        // 开发必读
        'standard': { name: '开发规范', icon: '' },
        'decision': { name: '决策记录', icon: '' },
        'guide': { name: '使用指南', icon: '' },
        // 业务参考
        'design': { name: '业务参考', icon: '' },
        'req': { name: '需求文档', icon: '' },
        // 项目管理
        'solution': { name: '建设方案', icon: '' },
        // 辅助资源
        'archive': { name: '归档文档', icon: '' }
    };

    // 递归扫描 helper（支持子目录，子目录文档归入父分类）
    function scanDir(dir, categoryKey, isArchive = false) {
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir);
        let results = [];
        files.forEach(file => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                // 跳过 local、archive、resources 等特殊目录
                if (['local', 'archive', 'resources'].includes(file)) {
                    return;
                }
                // 递归扫描子目录，保持父分类
                results.push(...scanDir(fullPath, categoryKey, isArchive));
            } else if (file.endsWith('.md')) {
                const versionInfo = extractVersionInfo(file);
                results.push({
                    filename: path.relative(path.join(__dirname, '..'), fullPath).replace(/\\/g, '/'),
                    title: versionInfo.baseName.replace(/_/g, ' '),
                    category: categoryKey,
                    categoryName: categoryMap[categoryKey]?.name || categoryKey,
                    version: versionInfo.version,
                    versionGroup: versionInfo.baseName,
                    isArchive: isArchive
                });
            } else if (/\.(xlsx?|docx?|pdf)$/i.test(file)) {
                // 支持资源模板文件（Excel、Word、PDF）
                const baseName = path.basename(file, path.extname(file));
                const ext = path.extname(file).toLowerCase().replace('.', '');
                // 确定文件类型
                let fileType = 'file';
                if (/xlsx?/.test(ext)) fileType = 'excel';
                else if (/docx?/.test(ext)) fileType = 'word';
                else if (ext === 'pdf') fileType = 'pdf';

                results.push({
                    filename: path.relative(path.join(__dirname, '..'), fullPath).replace(/\\/g, '/'),
                    title: baseName.replace(/_/g, ' '),
                    category: categoryKey,
                    categoryName: categoryMap[categoryKey]?.name || categoryKey,
                    version: null,
                    versionGroup: baseName,
                    isArchive: isArchive,
                    isDownload: true,
                    fileType: fileType
                });
            }
        });
        return results;
    }

    let allDocs = [];

    // 扫描所有分类目录
    const categories = ['req', 'standard', 'design', 'decision', 'solution', 'guide'];
    categories.forEach(cat => {
        allDocs.push(...scanDir(path.join(docsRoot, cat), cat));
    });

    // 扫描归档目录
    allDocs.push(...scanDir(path.join(docsRoot, 'archive'), 'archive', true));
    // 扫描归档子目录
    const archiveSubDirs = ['req', 'standard', 'design', 'solution'];
    archiveSubDirs.forEach(subDir => {
        allDocs.push(...scanDir(path.join(docsRoot, 'archive', subDir), 'archive', true));
    });

    // 按版本组分组，确定每组的最新版本
    const versionGroups = {};
    allDocs.forEach(doc => {
        if (!versionGroups[doc.versionGroup]) {
            versionGroups[doc.versionGroup] = [];
        }
        versionGroups[doc.versionGroup].push(doc);
    });

    // 为每个版本组设置 is_latest
    Object.keys(versionGroups).forEach(group => {
        const docs = versionGroups[group];
        // 按版本号排序（降序）
        docs.sort((a, b) => {
            const vA = parseFloat(a.version) || 0;
            const vB = parseFloat(b.version) || 0;
            return vB - vA;
        });
        // 最高版本设为 is_latest = 1
        docs.forEach((doc, idx) => {
            doc.isLatest = idx === 0 ? 1 : 0;
        });
    });

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT INTO documents (title, filename, category, icon, description, is_visible, version, version_group, is_latest, is_download, file_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
            updated_at = datetime('now', 'localtime'),
            category = excluded.category,
            is_visible = excluded.is_visible,
            version = excluded.version,
            version_group = excluded.version_group,
            is_latest = excluded.is_latest,
            is_download = excluded.is_download,
            file_type = excluded.file_type
        `);

        const HIDDEN_FILES = [
            '关于平台.md',                                              // 仅通过顶部链接访问
            '项目架构说明.md',                                           // 平台内部技术文档
            '市场端看板指标分类分析_20260210.md',                         // 一次性分析，已录入平台
            '原子指标与智慧数据指标映射关系_20260209.md',                  // 映射已完成，已录入平台
        ];

        const scannedFilenames = allDocs.map(d => d.filename);

        // 1. Insert/Update scanned files
        allDocs.forEach(doc => {
            const catInfo = categoryMap[doc.category] || { name: '其他文档', icon: '' };
            const simpleName = path.basename(doc.filename);
            // 归档文档不在主列表显示，但仍记录在数据库中
            let isVisible = doc.isArchive ? 0 : 1;
            if (HIDDEN_FILES.includes(simpleName)) isVisible = 0;
            const isDownload = doc.isDownload ? 1 : 0;
            const fileType = doc.fileType || 'markdown';
            stmt.run(doc.title, doc.filename, catInfo.name, catInfo.icon, doc.title, isVisible, doc.version, doc.versionGroup, doc.isLatest, isDownload, fileType);
        });

        // 2. Remove missing files (Hard Delete) - 删除数据库中不存在于磁盘的文件记录
        db.all("SELECT filename FROM documents", [], (err, rows) => {
            if (err) return;
            const dbFiles = rows.map(r => r.filename);
            const toDelete = dbFiles.filter(f => !scannedFilenames.includes(f));

            if (toDelete.length > 0) {
                const delStmt = db.prepare("DELETE FROM documents WHERE filename = ?");
                toDelete.forEach(f => {
                    logger.info(`[Doc Sync] Removing stale record: ${f}`);
                    delStmt.run(f);
                });
                delStmt.finalize();
            }
        });

        stmt.finalize(() => {
            logger.info(`[Doc Sync] Synced ${allDocs.length} documents (including archives).`);
        });
    });
}

// 初始化文档表
initDocTable();

// 获取文档列表 (按分类分组，仅返回可见且最新的文档)
app.get('/api/docs', (req, res) => {
    const { include_archive } = req.query;

    let sql = "SELECT * FROM documents WHERE is_visible = 1";
    if (!include_archive) {
        sql += " AND is_latest = 1";
    }
    sql += " ORDER BY category, title";

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 获取文档版本列表
app.get('/api/docs/:filename/versions', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);

    // 先获取当前文档的版本组
    db.get("SELECT version_group FROM documents WHERE filename = ?", [filename], (err, doc) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!doc || !doc.version_group) {
            return res.json([]); // 无版本信息
        }

        // 获取同一版本组的所有文档
        db.all(
            "SELECT id, title, filename, version, is_latest, change_log, updated_at FROM documents WHERE version_group = ? ORDER BY version DESC",
            [doc.version_group],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows);
            }
        );
    });
});

// 读取指定文档内容 (支持读取归档文档)
app.get('/api/docs/:filename', (req, res) => {
    // filename 可能是 "docs/req/xxx.md" (URL encoded)
    const filename = decodeURIComponent(req.params.filename);

    // 允许读取归档文档（不检查 is_visible）
    db.get("SELECT * FROM documents WHERE filename = ?", [filename], (err, doc) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!doc) return res.status(404).json({ error: '文档未注册' });

        // 构建绝对路径
        const filePath = path.join(__dirname, '..', doc.filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '物理文件不存在' });
        }

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                console.error('读取文件失败:', err);
                return res.status(500).json({ error: '读取文件失败' });
            }
            res.json({
                content: data,
                filename: doc.filename,
                name: doc.title,
                size: data.length,
                version: doc.version,
                version_group: doc.version_group,
                is_latest: doc.is_latest
            });
        });
    });
});

// 发布新版本（归档旧版本）
app.post('/api/docs/publish', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { old_filename, new_filename, change_log } = req.body;

    if (!old_filename || !new_filename) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    const projectRoot = path.join(__dirname, '..');
    const oldFilePath = path.join(projectRoot, old_filename);
    const newFilePath = path.join(projectRoot, new_filename);

    // 检查新文件是否存在
    if (!fs.existsSync(newFilePath)) {
        return res.status(404).json({ error: '新版本文件不存在' });
    }

    // 检查旧文件是否存在
    if (!fs.existsSync(oldFilePath)) {
        return res.status(404).json({ error: '旧版本文件不存在' });
    }

    try {
        // 1. 确定归档目录
        const oldRelDir = path.dirname(old_filename); // e.g. "docs/req"
        const archiveDir = path.join(projectRoot, 'docs', 'archive', oldRelDir.replace('docs/', ''));

        // 2. 创建归档目录
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }

        // 3. 提取版本信息，重命名旧文件
        const oldBasename = path.basename(old_filename);
        const versionInfo = extractVersionInfo(oldBasename);
        const archivedFilename = `${versionInfo.baseName}_v${versionInfo.version}.md`;
        const archivePath = path.join(archiveDir, archivedFilename);

        // 4. 移动旧文件到归档目录
        fs.renameSync(oldFilePath, archivePath);
        logger.info(`[Doc Publish] Archived: ${old_filename} -> ${path.relative(projectRoot, archivePath)}`);

        // 5. 更新数据库 - 旧版本
        const archivedRelPath = path.relative(projectRoot, archivePath).replace(/\\/g, '/');
        await dbRunAsync(
            "UPDATE documents SET is_visible = 0, is_latest = 0, filename = ? WHERE filename = ?",
            [archivedRelPath, old_filename]
        );

        // 6. 更新数据库 - 新版本 (如果已经存在记录则更新，否则插入)
        const newVersionInfo = extractVersionInfo(new_filename);
        await dbRunAsync(`
            INSERT INTO documents (title, filename, category, icon, description, is_visible, version, version_group, is_latest, change_log)
            VALUES (?, ?, '📝 业务需求与规格', '📑', ?, 1, ?, ?, 1, ?)
            ON CONFLICT(filename) DO UPDATE SET
            is_visible = 1,
            is_latest = 1,
            version = excluded.version,
            version_group = excluded.version_group,
            change_log = excluded.change_log,
            updated_at = datetime('now', 'localtime')
        `, [
            newVersionInfo.baseName.replace(/_/g, ' '),
            new_filename,
            newVersionInfo.baseName.replace(/_/g, ' '),
            newVersionInfo.version,
            newVersionInfo.baseName,
            change_log || null
        ]);

        // 7. 重新同步文档
        syncDocsFromDisk();

        res.json({
            message: '文档发布成功',
            archived: archivedRelPath,
            published: new_filename
        });

    } catch (err) {
        logger.error('[Doc Publish] Error:', err);
        res.status(500).json({ error: '发布失败: ' + err.message });
    }
});

// ==================== 指标管理 API ====================

// 获取指标列表（支持筛选）
app.get('/api/metrics', (req, res) => {
    const { domain_id, metric_type, tag_id, status, keyword, category } = req.query;

    let sql = `
        SELECT m.*,
               d.name as domain_name,
               u.display_name as owner_name,
               GROUP_CONCAT(DISTINCT mt.tag_name) as tags,
               GROUP_CONCAT(DISTINCT mt.id || ':' || mt.tag_name || ':' || mt.color) as tag_details
        FROM metrics m
        LEFT JOIN sys_domains d ON m.domain_id = d.id
        LEFT JOIN users u ON m.owner_id = u.id
        LEFT JOIN metrics_tag_rel mtr ON m.id = mtr.metric_id
        LEFT JOIN metrics_tags mt ON mtr.tag_id = mt.id
        WHERE 1=1
    `;
    const params = [];

    if (domain_id) {
        sql += ` AND m.domain_id = ?`;
        params.push(domain_id);
    }
    if (metric_type) {
        sql += ` AND m.metric_type = ?`;
        params.push(metric_type);
    }
    if (status) {
        sql += ` AND m.status = ?`;
        params.push(status);
    }
    if (keyword) {
        sql += ` AND (m.metric_code LIKE ? OR m.metric_name LIKE ? OR m.biz_def LIKE ?)`;
        const kw = `%${keyword}%`;
        params.push(kw, kw, kw);
    }
    if (category) {
        sql += ` AND COALESCE(m.metric_category, 'basic') = ?`;
        params.push(category);
    }

    sql += ` GROUP BY m.id ORDER BY m.sort_order ASC, m.id ASC`;

    // 如果有 tag_id 筛选，需要后处理
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // 处理标签筛选
        if (tag_id) {
            rows = rows.filter(row => {
                if (!row.tag_details) return false;
                const tagIds = row.tag_details.split(',').map(t => t.split(':')[0]);
                return tagIds.includes(tag_id);
            });
        }

        // 解析 tag_details 为结构化数据
        rows.forEach(row => {
            if (row.tag_details) {
                row.tagList = row.tag_details.split(',').map(t => {
                    const [id, name, color] = t.split(':');
                    return { id: parseInt(id), name, color };
                });
            } else {
                row.tagList = [];
            }
            delete row.tag_details;
        });

        res.json(rows);
    });
});

// 获取所有标签 (必须在 /api/metrics/:id 之前定义)
app.get('/api/metrics/tags/list', (req, res) => {
    db.all('SELECT * FROM metrics_tags ORDER BY id', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 获取单个指标详情
app.get('/api/metrics/:id', (req, res) => {
    const { id } = req.params;

    const sql = `
        SELECT m.*,
               d.name as domain_name,
               u.display_name as owner_name,
               GROUP_CONCAT(DISTINCT mt.id || ':' || mt.tag_name || ':' || mt.color) as tag_details
        FROM metrics m
        LEFT JOIN sys_domains d ON m.domain_id = d.id
        LEFT JOIN users u ON m.owner_id = u.id
        LEFT JOIN metrics_tag_rel mtr ON m.id = mtr.metric_id
        LEFT JOIN metrics_tags mt ON mtr.tag_id = mt.id
        WHERE m.id = ?
        GROUP BY m.id
    `;

    db.get(sql, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: '指标不存在' });

        // 解析标签
        if (row.tag_details) {
            row.tagList = row.tag_details.split(',').map(t => {
                const [id, name, color] = t.split(':');
                return { id: parseInt(id), name, color };
            });
        } else {
            row.tagList = [];
        }
        delete row.tag_details;

        res.json(row);
    });
});

// 新增指标
app.post('/api/metrics', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { metric_code, metric_name, biz_def, tech_def, dax_def, domain_id, metric_type, data_type, unit, source_table, tag_ids, formula, parent_metric_id, dependency_ids, sort_order, metric_category, assess_dept, assess_note } = req.body;
    const owner_id = req.user.id;

    if (!metric_code || !metric_name) {
        return res.status(400).json({ error: '指标编码和名称为必填项' });
    }

    db.run(`
        INSERT INTO metrics (metric_code, metric_name, biz_def, tech_def, dax_def, domain_id, metric_type, formula, parent_metric_id, data_type, unit, owner_id, source_table, sort_order, metric_category, assess_dept, assess_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [metric_code, metric_name, biz_def, tech_def, dax_def || null, domain_id || null, metric_type || 'atomic', formula || null, parent_metric_id || null, data_type, unit, owner_id, source_table || null, sort_order || 0, metric_category || 'basic', assess_dept || null, assess_note || null],
    function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: '指标编码已存在' });
            }
            return res.status(500).json({ error: err.message });
        }

        const metricId = this.lastID;

        // 关联标签
        if (tag_ids && tag_ids.length > 0) {
            const tagStmt = db.prepare(`INSERT OR IGNORE INTO metrics_tag_rel (metric_id, tag_id) VALUES (?, ?)`);
            tag_ids.forEach(tagId => tagStmt.run(metricId, tagId));
            tagStmt.finalize();
        }

        // 关联依赖指标（复合指标的公式依赖）
        if (dependency_ids && dependency_ids.length > 0) {
            const depStmt = db.prepare(`INSERT OR IGNORE INTO metrics_dependencies (metric_id, depends_on_metric_id, dependency_type) VALUES (?, ?, ?)`);
            dependency_ids.forEach(depId => depStmt.run(metricId, depId, 'formula'));
            depStmt.finalize();
        }

        // 派生指标自动记录与父指标的依赖
        if (parent_metric_id) {
            db.run(`INSERT OR IGNORE INTO metrics_dependencies (metric_id, depends_on_metric_id, dependency_type) VALUES (?, ?, 'derive')`,
                [metricId, parent_metric_id]);
        }

        res.json({ id: metricId, message: '指标创建成功' });
    });
});

// 更新指标（自动归档历史版本）
app.put('/api/metrics/:id', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { id } = req.params;
    const { metric_code, metric_name, biz_def, tech_def, dax_def, domain_id, metric_type, data_type, unit, status, source_table, tag_ids, change_reason, formula, parent_metric_id, dependency_ids, sort_order, metric_category, assess_dept, assess_note } = req.body;
    const updated_by = req.user.id;

    // 先获取当前版本信息
    db.get('SELECT * FROM metrics WHERE id = ?', [id], (err, oldMetric) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!oldMetric) return res.status(404).json({ error: '指标不存在' });

        // 归档到历史表
        db.run(`
            INSERT INTO metrics_history (metric_id, version, metric_code, metric_name, biz_def, tech_def, change_reason, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, oldMetric.version, oldMetric.metric_code, oldMetric.metric_name, oldMetric.biz_def, oldMetric.tech_def, change_reason || '内容更新', updated_by]);

        // 更新主表，版本号 +1
        const newVersion = oldMetric.version + 1;
        db.run(`
            UPDATE metrics SET
                metric_code = ?, metric_name = ?, biz_def = ?, tech_def = ?, dax_def = ?,
                domain_id = ?, metric_type = ?, formula = ?, parent_metric_id = ?,
                data_type = ?, unit = ?,
                status = ?, source_table = ?, sort_order = ?, metric_category = ?, assess_dept = ?, assess_note = ?, version = ?,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `, [
            metric_code || oldMetric.metric_code,
            metric_name || oldMetric.metric_name,
            biz_def !== undefined ? biz_def : oldMetric.biz_def,
            tech_def !== undefined ? tech_def : oldMetric.tech_def,
            dax_def !== undefined ? dax_def : oldMetric.dax_def,
            domain_id !== undefined ? domain_id : oldMetric.domain_id,
            metric_type || oldMetric.metric_type,
            formula !== undefined ? formula : oldMetric.formula,
            parent_metric_id !== undefined ? parent_metric_id : oldMetric.parent_metric_id,
            data_type !== undefined ? data_type : oldMetric.data_type,
            unit !== undefined ? unit : oldMetric.unit,
            status || oldMetric.status,
            source_table !== undefined ? source_table : oldMetric.source_table,
            sort_order !== undefined ? sort_order : oldMetric.sort_order,
            metric_category !== undefined ? metric_category : (oldMetric.metric_category || 'basic'),
            assess_dept !== undefined ? assess_dept : oldMetric.assess_dept,
            assess_note !== undefined ? assess_note : oldMetric.assess_note,
            newVersion,
            id
        ], function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // 更新标签关联
            if (tag_ids !== undefined) {
                // 删除旧关联
                db.run('DELETE FROM metrics_tag_rel WHERE metric_id = ?', [id], () => {
                    // 插入新关联
                    if (tag_ids && tag_ids.length > 0) {
                        const tagStmt = db.prepare(`INSERT OR IGNORE INTO metrics_tag_rel (metric_id, tag_id) VALUES (?, ?)`);
                        tag_ids.forEach(tagId => tagStmt.run(id, tagId));
                        tagStmt.finalize();
                    }
                });
            }

            // 更新依赖关系
            if (dependency_ids !== undefined) {
                db.run('DELETE FROM metrics_dependencies WHERE metric_id = ?', [id], () => {
                    if (dependency_ids && dependency_ids.length > 0) {
                        const depStmt = db.prepare(`INSERT OR IGNORE INTO metrics_dependencies (metric_id, depends_on_metric_id, dependency_type) VALUES (?, ?, 'formula')`);
                        dependency_ids.forEach(depId => depStmt.run(id, depId));
                        depStmt.finalize();
                    }
                    // 派生指标自动记录与父指标的依赖
                    const pid = parent_metric_id !== undefined ? parent_metric_id : oldMetric.parent_metric_id;
                    if (pid) {
                        db.run(`INSERT OR IGNORE INTO metrics_dependencies (metric_id, depends_on_metric_id, dependency_type) VALUES (?, ?, 'derive')`,
                            [id, pid]);
                    }
                });
            }

            res.json({ message: '指标更新成功', version: newVersion });
        });
    });
});

// 查询指标的依赖关系（当前指标依赖哪些指标）
app.get('/api/metrics/:id/dependencies', (req, res) => {
    const { id } = req.params;
    db.all(`
        SELECT md.dependency_type, m.id, m.metric_code, m.metric_name, m.metric_type
        FROM metrics_dependencies md
        JOIN metrics m ON md.depends_on_metric_id = m.id
        WHERE md.metric_id = ?
    `, [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 查询指标的影响范围（哪些指标依赖当前指标）
app.get('/api/metrics/:id/dependents', (req, res) => {
    const { id } = req.params;
    db.all(`
        SELECT md.dependency_type, m.id, m.metric_code, m.metric_name, m.metric_type
        FROM metrics_dependencies md
        JOIN metrics m ON md.metric_id = m.id
        WHERE md.depends_on_metric_id = ?
    `, [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 删除指标（仅管理员）
app.delete('/api/metrics/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM metrics WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '指标不存在' });

        // 关联表会因 ON DELETE CASCADE 自动删除
        res.json({ message: '指标删除成功' });
    });
});

// 获取指标版本历史
app.get('/api/metrics/:id/history', (req, res) => {
    const { id } = req.params;

    db.all(`
        SELECT mh.*, u.display_name as updated_by_name
        FROM metrics_history mh
        LEFT JOIN users u ON mh.updated_by = u.id
        WHERE mh.metric_id = ?
        ORDER BY mh.version DESC
    `, [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 新增标签（管理员）
app.post('/api/metrics/tags', authenticateToken, requireAdmin, (req, res) => {
    const { tag_name, color } = req.body;

    if (!tag_name) {
        return res.status(400).json({ error: '标签名称为必填项' });
    }

    db.run(`INSERT INTO metrics_tags (tag_name, color) VALUES (?, ?)`,
        [tag_name, color || '#d97706'],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: '标签名称已存在' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ id: this.lastID, message: '标签创建成功' });
        }
    );
});

// 删除标签（管理员）
app.delete('/api/metrics/tags/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM metrics_tags WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '标签不存在' });
        res.json({ message: '标签删除成功' });
    });
});

// 11. Mark Task as ON_HOLD
app.post('/api/tasks/:id/hold', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const operator = req.user.display_name || req.user.username;

    if (!reason) return res.status(400).json({ error: "必须提供存疑原因" });

    // 权限校验：owner 本人 或 admin/publisher
    db.get("SELECT owner_id, owner FROM task_pool WHERE id = ?", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(404).json({ error: "任务不存在" });

        const isOwner = (task.owner_id && task.owner_id === req.user.id) ||
            (task.owner === req.user.display_name) ||
            (task.owner === req.user.username);
        const isPrivileged = req.user.role === 'admin' || req.user.role === 'publisher';
        if (!isOwner && !isPrivileged) {
            return res.status(403).json({ error: "无权操作此任务" });
        }

        db.run(
            "UPDATE task_pool SET status = 'ON_HOLD', hold_reason = ?, hold_by = ? WHERE id = ? AND (status IN ('OPEN', 'CLAIMED') OR status IS NULL)",
            [reason, operator, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: "任务不存在或状态不正确" });
                insertOperationLog(id, 'HOLD', operator, reason);
                res.json({ message: "任务已标记为存疑" });
            }
        );
    });
});

// 12. Resolve ON_HOLD Task (根据 owner 恢复为 OPEN 或 CLAIMED)
app.post('/api/tasks/:id/resolve', authenticateToken, requireNonViewer, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const operator = req.user.display_name || req.user.username;

    // 先查任务，根据是否有 owner 决定恢复到哪个状态
    db.get("SELECT owner, owner_id FROM task_pool WHERE id = ? AND status = 'ON_HOLD'", [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(404).json({ error: "任务不是存疑状态" });

        // 权限校验：owner 本人 或 admin/publisher
        const isOwner = (task.owner_id && task.owner_id === req.user.id) ||
            (task.owner === req.user.display_name) ||
            (task.owner === req.user.username);
        const isPrivileged = req.user.role === 'admin' || req.user.role === 'publisher';
        if (!isOwner && !isPrivileged) {
            return res.status(403).json({ error: "无权操作此任务" });
        }

        // 有 owner 恢复为 CLAIMED，无 owner 恢复为 OPEN
        const restoreStatus = task.owner_id ? 'CLAIMED' : 'OPEN';
        const statusLabel = restoreStatus === 'CLAIMED' ? '进行中' : '待认领';

        db.run(
            `UPDATE task_pool SET status = '${restoreStatus}', hold_reason = NULL, hold_by = NULL WHERE id = ? AND status = 'ON_HOLD'`,
            [id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: "任务不是存疑状态" });
                // 记录操作日志
                const logReason = reason ? `问题已解决：${reason.trim()}` : `问题已解决，任务恢复为${statusLabel}`;
                insertOperationLog(id, 'RESOLVE', operator, logReason);
                res.json({ message: `任务问题已解决，恢复为${statusLabel}` });
            }
        );
    });
});

// ==================== 模型管理 API ====================

// 1. 获取模型列表 (需要登录)
// 性能优化：合并重复子查询，使用索引 idx_task_linked_model_status
app.get('/api/models', authenticateToken, (req, res) => {
    // 允许通过 query 参数过滤, 也可以不传参数获取全部
    const { layer, owner, keyword } = req.query;
    let sql = `
        SELECT dm.*,
            -- 通过 LEFT JOIN 聚合一次扫描完成所有统计
            COALESCE(ts.archived_task_count, 0) as archived_task_count,
            COALESCE(ts.developed_task_count, 0) as developed_task_count,
            COALESCE(ts.developing_task_count, 0) as developing_task_count,
            lat.id as latest_active_task_id,
            lat.status as latest_active_task_status,
            lat.owner as latest_active_task_owner,
            lat.owner_id as latest_active_task_owner_id
        FROM data_models dm
        LEFT JOIN (
            SELECT linked_model_id,
                SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) as archived_task_count,
                SUM(CASE WHEN status IN ('DONE', 'ARCHIVED') THEN 1 ELSE 0 END) as developed_task_count,
                SUM(CASE WHEN status IN ('OPEN', 'CLAIMED', 'TRANSFERRING', 'ON_HOLD') THEN 1 ELSE 0 END) as developing_task_count
            FROM task_pool
            GROUP BY linked_model_id
        ) ts ON ts.linked_model_id = dm.id
        LEFT JOIN (
            SELECT tp1.linked_model_id, tp1.id, tp1.status, tp1.owner, tp1.owner_id
            FROM task_pool tp1
            INNER JOIN (
                SELECT linked_model_id, MAX(created_at) as max_created_at
                FROM task_pool
                WHERE status != 'ARCHIVED'
                GROUP BY linked_model_id
            ) tp2 ON tp1.linked_model_id = tp2.linked_model_id AND tp1.created_at = tp2.max_created_at AND tp1.status != 'ARCHIVED'
        ) lat ON lat.linked_model_id = dm.id
        WHERE (dm.is_deleted = 0 OR dm.is_deleted IS NULL)
    `;
    let params = [];

    if (layer) {
        sql += " AND dm.layer = ?";
        params.push(layer);
    }
    if (owner) {
        sql += " AND (dm.tech_owner LIKE ? OR dm.biz_owner LIKE ?)";
        params.push(`%${owner}%`, `%${owner}%`);
    }
    if (keyword) {
        sql += " AND (dm.table_name LIKE ? OR dm.table_comment LIKE ?)";
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    sql += " ORDER BY dm.table_name"; // 默认按表名排序, 方便下拉选择

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 1.1 获取已归档的 ODS 表列表（供 DIM 建模时选择源表）
app.get('/api/models/ods-tables', authenticateToken, (req, res) => {
    const { keyword } = req.query;

    // 查询 ODS 层已归档的模型（有至少一个归档任务）
    // 注意：layer 字段存储为小写 'ods'
    let sql = `
        SELECT
            dm.id,
            dm.table_name,
            dm.table_comment,
            dm.source_system,
            dm.source_table,
            dm.status as model_status,
            (SELECT COUNT(*) FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status = 'ARCHIVED') as archived_task_count,
            (SELECT MAX(tp.done_at) FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status = 'ARCHIVED') as last_archived_at
        FROM data_models dm
        WHERE UPPER(dm.layer) = 'ODS'
          AND (dm.is_deleted = 0 OR dm.is_deleted IS NULL)
          AND EXISTS (SELECT 1 FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status = 'ARCHIVED')
    `;
    let params = [];

    if (keyword) {
        sql += " AND (dm.table_name LIKE ? OR dm.table_comment LIKE ? OR dm.source_table LIKE ?)";
        params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    sql += " ORDER BY dm.table_name";

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 检查 ODS 表的下游依赖（DIM/DWD 层模型）
// 用于在 reopen ODS 任务前检测是否有下游表依赖
app.get('/api/models/:id/downstream-deps', authenticateToken, (req, res) => {
    const { id } = req.params;

    // 首先获取该模型/任务关联的 ODS 表名
    db.get(`
        SELECT dm.id, dm.table_name, dm.layer, dm.table_comment
        FROM data_models dm
        WHERE dm.id = ?
    `, [id], (err, model) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!model) return res.status(404).json({ error: "模型不存在" });

        // 只有 ODS 层才需要检查下游依赖
        if (model.layer.toUpperCase() !== 'ODS') {
            return res.json({ hasDeps: false, deps: [], message: "非 ODS 层模型，无需检查下游依赖" });
        }

        // 查找下游依赖：DIM/DWD 层模型的 source_table 包含该 ODS 表名
        // 或者 dim_config.source_tables 中引用了该表
        const odsTableName = model.table_name;
        db.all(`
            SELECT dm.id, dm.table_name, dm.table_comment, dm.layer, dm.status,
                   (SELECT COUNT(*) FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status = 'ARCHIVED') as archived_count,
                   (SELECT tp.status FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status NOT IN ('ARCHIVED') ORDER BY tp.created_at DESC LIMIT 1) as latest_task_status
            FROM data_models dm
            WHERE UPPER(dm.layer) IN ('DIM', 'DWD', 'DWS', 'ADS')
              AND (dm.is_deleted = 0 OR dm.is_deleted IS NULL)
              AND (
                  dm.source_table LIKE ? OR
                  dm.dim_config LIKE ?
              )
        `, [`%${odsTableName}%`, `%${odsTableName}%`], (err2, deps) => {
            if (err2) return res.status(500).json({ error: err2.message });

            const hasDeps = deps.length > 0;
            const archivedDeps = deps.filter(d => d.archived_count > 0);

            res.json({
                hasDeps,
                totalCount: deps.length,
                archivedCount: archivedDeps.length,
                deps: deps.map(d => ({
                    id: d.id,
                    table_name: d.table_name,
                    table_comment: d.table_comment,
                    layer: d.layer,
                    status: d.status,
                    hasArchivedTask: d.archived_count > 0,
                    latestTaskStatus: d.latest_task_status
                })),
                sourceModel: {
                    id: model.id,
                    table_name: model.table_name,
                    table_comment: model.table_comment
                }
            });
        });
    });
});

// 通过任务 ID 检查其关联 ODS 模型的下游依赖
app.get('/api/tasks/:id/downstream-deps', authenticateToken, (req, res) => {
    const { id } = req.params;

    // 获取任务关联的模型
    db.get(`
        SELECT tp.id as task_id, tp.linked_model_id, dm.table_name, dm.layer, dm.table_comment
        FROM task_pool tp
        LEFT JOIN data_models dm ON tp.linked_model_id = dm.id
        WHERE tp.id = ?
    `, [id], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!task) return res.status(404).json({ error: "任务不存在" });
        if (!task.linked_model_id) return res.json({ hasDeps: false, deps: [], message: "任务未关联模型" });
        if (!task.layer || task.layer.toUpperCase() !== 'ODS') return res.json({ hasDeps: false, deps: [], message: "非 ODS 层任务，无需检查下游依赖" });

        // 查找下游依赖
        const odsTableName = task.table_name;
        db.all(`
            SELECT dm.id, dm.table_name, dm.table_comment, dm.layer, dm.status,
                   (SELECT COUNT(*) FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status = 'ARCHIVED') as archived_count,
                   (SELECT tp.status FROM task_pool tp WHERE tp.linked_model_id = dm.id AND tp.status NOT IN ('ARCHIVED') ORDER BY tp.created_at DESC LIMIT 1) as latest_task_status
            FROM data_models dm
            WHERE UPPER(dm.layer) IN ('DIM', 'DWD', 'DWS', 'ADS')
              AND (
                  dm.source_table LIKE ? OR
                  dm.dim_config LIKE ?
              )
        `, [`%${odsTableName}%`, `%${odsTableName}%`], (err2, deps) => {
            if (err2) return res.status(500).json({ error: err2.message });

            const hasDeps = deps.length > 0;
            const archivedDeps = deps.filter(d => d.archived_count > 0);

            res.json({
                hasDeps,
                totalCount: deps.length,
                archivedCount: archivedDeps.length,
                deps: deps.map(d => ({
                    id: d.id,
                    table_name: d.table_name,
                    table_comment: d.table_comment,
                    layer: d.layer,
                    status: d.status,
                    hasArchivedTask: d.archived_count > 0,
                    latestTaskStatus: d.latest_task_status
                })),
                sourceTask: {
                    id: task.task_id,
                    linked_model_id: task.linked_model_id,
                    table_name: task.table_name,
                    table_comment: task.table_comment
                }
            });
        });
    });
});

// 2. 注册新模型
app.post('/api/models', authenticateToken, requireNonViewer, (req, res) => {
    const { layer, domain, table_name, table_comment, tech_owner, biz_owner, update_cycle, source_system, source_table, dim_config, config_mode, design_notes } = req.body;

    if (!table_name || !layer) {
        return res.status(400).json({ error: "表名(table_name)和分层(layer)必填" });
    }

    // 记录创建者ID，用于后续权限控制（开发者只能编辑自己注册的模型）
    const createdById = req.user.id;
    const userName = req.user.display_name || req.user.username;

    // DIM 配置序列化为 JSON 字符串
    const dimConfigJson = dim_config ? JSON.stringify(dim_config) : null;
    const category = req.body.category || 'general'; // 默认为一般资产
    const finalConfigMode = config_mode || 'standard';

    // 先检查是否存在已删除的同名模型，如果存在则物理删除它
    db.get(`SELECT id, is_deleted FROM data_models WHERE table_name = ?`, [table_name], (checkErr, existingModel) => {
        if (checkErr) {
            logger.error(`检查同名模型失败: ${checkErr.message}`);
            return res.status(500).json({ error: checkErr.message });
        }

        logger.info(`检查同名模型: table_name=${table_name}, existingModel=${JSON.stringify(existingModel)}`);

        // 如果存在同名模型
        if (existingModel) {
            logger.info(`发现同名模型: id=${existingModel.id}, is_deleted=${existingModel.is_deleted}, type=${typeof existingModel.is_deleted}`);
            // 如果是已删除的模型，物理删除它以便重新注册
            if (existingModel.is_deleted == 1) {  // 使用宽松比较，兼容字符串 "1"
                logger.info(`准备物理删除已软删除的模型 id=${existingModel.id}`);
                db.run(`DELETE FROM data_models WHERE id = ?`, [existingModel.id], (deleteErr) => {
                    if (deleteErr) {
                        logger.error(`物理删除失败: ${deleteErr.message}`);
                        return res.status(500).json({ error: deleteErr.message });
                    }
                    logger.info(`物理删除成功，继续注册新模型`);
                    // 删除成功后继续注册新模型
                    doInsertModel();
                });
                return;
            } else {
                // 存在未删除的同名模型，返回错误
                logger.info(`存在未删除的同名模型，拒绝注册`);
                return res.status(400).json({ error: "该表名已存在" });
            }
        }

        // 不存在同名模型，直接注册
        doInsertModel();
    });

    function doInsertModel() {
        const stmt = db.prepare(`
            INSERT INTO data_models
            (layer, domain, table_name, table_comment, tech_owner, biz_owner, update_cycle, source_system, source_table, model_type, category, status, created_by_id, dim_config, config_mode, design_notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)
        `);

        stmt.run(layer, domain, table_name, table_comment, tech_owner, biz_owner, update_cycle, source_system || null, source_table || null, req.body.model_type || 'TABLE', category, createdById, dimConfigJson, finalConfigMode, design_notes || null, function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "该表名已存在" });
                }
                return res.status(500).json({ error: err.message });
            }

            const newModelId = this.lastID;

            // 记录创建日志
            insertModelChangeLog({
                modelId: newModelId,
                modelName: table_name,
                action: 'CREATE',
                changeType: ['DIM', 'DWD'].includes(layer.toUpperCase()) ? 'dim_config' : 'basic_info',
                beforeValue: null,
                afterValue: {
                    layer, domain, table_name, table_comment,
                    tech_owner, biz_owner, update_cycle,
                    source_system, source_table,
                    model_type: req.body.model_type || 'TABLE',
                    category,
                    dim_config
                },
                changeSummary: '创建模型',
                operatorId: createdById,
                operatorName: userName
            });

            res.json({ id: newModelId, message: "模型注册成功" });
        });
        stmt.finalize();
    }
});

// 2.5 快捷提交：注册模型后一键完成开发（自动创建任务并推进到待验收状态）
app.post('/api/models/:id/quick-submit', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;

    try {
        // 1. 验证模型存在
        const model = await dbGetAsync(
            "SELECT * FROM data_models WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)", [id]
        );
        if (!model) {
            return res.status(404).json({ error: "模型不存在或已删除" });
        }

        // 业务权限检查：admin/publisher OR tech_owner OR 创建者
        // 快捷提交本质是模型创建者一次完成开发，不应被无关用户调用
        if (req.user.role !== 'publisher' && !canEditModel(req.user, model)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、创建者或管理员可以执行快捷提交' });
        }

        // 2. 验证模型状态为 CREATED（刚注册的）
        if (model.status !== 'CREATED') {
            return res.status(400).json({ error: `模型当前状态为 ${model.status}，快捷提交仅适用于新注册(CREATED)的模型` });
        }

        // 3. 检查没有关联的活跃任务
        const existingTask = await dbGetAsync(
            "SELECT id, title, status FROM task_pool WHERE linked_model_id = ? AND status != 'ARCHIVED' LIMIT 1",
            [id]
        );
        if (existingTask) {
            return res.status(400).json({
                error: `该模型已关联进行中的任务 #${existingTask.id}：${existingTask.title} (${existingTask.status})`
            });
        }

        // 4. 根据模型层级确定任务类型
        const layerToCat = { 'ods': 'ODS_SYNC', 'dim': 'DIM_DEV', 'dwd': 'DWD_DEV', 'ads': 'ADS_RPT' };
        const taskCategory = layerToCat[model.layer] || 'DWD_DEV';

        // 5. 生成北京时间
        const now = new Date();
        const beijingTime = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ');

        // 6. 创建任务，直接设为 DONE 状态（已完成开发，等待验收）
        const taskTitle = `${model.table_name} 模型开发`;
        const taskDesc = `由「注册并完成开发」快捷通道自动创建。模型：${model.table_name}（${model.table_comment || ''})`;

        const insertResult = await dbRunAsync(
            `INSERT INTO task_pool (title, desc, status, created_by, owner, owner_id, category, priority, linked_model_id, created_at, claimed_at, done_at)
             VALUES (?, ?, 'DONE', ?, ?, ?, ?, 'P1', ?, ?, ?, ?)`,
            [taskTitle, taskDesc, userId, userName, userId, taskCategory, parseInt(id), beijingTime, beijingTime, beijingTime]
        );

        const taskId = insertResult.lastID;

        // 7. 记录任务操作日志（发布 + 领取 + 提交，三步合一）
        insertOperationLog(taskId, 'PUBLISH', userName, `快捷通道自动发布: ${taskTitle}`);
        insertOperationLog(taskId, 'CLAIM', userName, '快捷通道自动领取');
        insertOperationLog(taskId, 'SUBMIT', userName, '快捷通道自动提交（注册时已完成开发）');

        // 8. 更新模型状态为 REVIEWING（待验收）
        await dbRunAsync(
            "UPDATE data_models SET status = 'REVIEWING' WHERE id = ?", [id]
        );

        // 9. 记录模型变更日志
        insertModelChangeLog({
            modelId: id,
            modelName: model.table_name,
            action: 'STATUS_CHANGE',
            changeType: 'status',
            beforeValue: { status: 'CREATED' },
            afterValue: { status: 'REVIEWING' },
            changeSummary: '快捷通道：注册并完成开发，自动推进到待验收',
            operatorId: userId,
            operatorName: userName
        });

        logger.info(`快捷提交成功: 模型 ${model.table_name}(${id}) → REVIEWING, 任务 #${taskId}`);
        res.json({ taskId, message: '快捷提交成功，模型已进入待验收状态' });

    } catch (e) {
        logger.error(`快捷提交失败: ${e.message}`);
        res.status(500).json({ error: '快捷提交失败: ' + e.message });
    }
});

// 3. 删除模型 (软删除，需要登录，且仅限管理员和发布者)
app.delete('/api/models/:id', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body; // 删除原因（可选）
    const userRole = req.user.role;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;

    try {
        // 先获取模型信息（用于日志）
        const model = await dbGetAsync("SELECT * FROM data_models WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)", [id]);
        if (!model) {
            return res.status(404).json({ error: "模型不存在或已删除" });
        }

        // 权限检查：admin/publisher 可删任意模型；其他用户需为创建者或技术负责人
        if (userRole !== 'admin' && userRole !== 'publisher') {
            if (!canEditModel(req.user, model)) {
                return res.status(403).json({ error: "权限不足：只有技术负责人或创建者可以删除此模型" });
            }
        }

        // 检查关联任务（仅警告，不阻断）
        const linkedTasks = await dbAllAsync(
            "SELECT id, title, status, owner FROM task_pool WHERE linked_model_id = ? AND status NOT IN ('ARCHIVED')",
            [id]
        );
        // 如果前端未传 force=true 且有未归档关联任务，返回警告让前端确认
        if (linkedTasks.length > 0 && !req.body.force) {
            return res.status(409).json({
                warning: true,
                message: `该模型有 ${linkedTasks.length} 个未归档的关联任务，删除后任务仍保留但模型标记将显示"已删除"。是否继续？`,
                linkedTasks: linkedTasks.map(t => ({ id: t.id, title: t.title, status: t.status, owner: t.owner }))
            });
        }

        // 软删除
        db.run(
            `UPDATE data_models
             SET is_deleted = 1, deleted_at = datetime('now', 'localtime'), deleted_by = ?, delete_reason = ?
             WHERE id = ?`,
            [userId, reason || null, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });

                // 级联软删除伴生表
                db.run(`UPDATE data_models SET is_deleted = 1, deleted_at = datetime('now','localtime'),
                    deleted_by = ?, delete_reason = '主表被删除' WHERE companion_of = ? AND (is_deleted = 0 OR is_deleted IS NULL)`,
                    [userId, id]);

                // 如果删除的是伴生表，同步将主表的 changeTracking.enabled 置为 false
                if (model.companion_of) {
                    db.get(`SELECT id, dim_config FROM data_models WHERE id = ?`, [model.companion_of], (err2, parent) => {
                        if (err2 || !parent || !parent.dim_config) return;
                        try {
                            const cfg = JSON.parse(parent.dim_config);
                            const ct = cfg.dwdConfig?.changeTracking || cfg.changeTracking;
                            if (ct && ct.enabled) {
                                ct.enabled = false;
                                db.run(`UPDATE data_models SET dim_config = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
                                    [JSON.stringify(cfg), parent.id]);
                                logger.info(`伴生表 id=${id} 被删除，主表 id=${parent.id} 的 changeTracking.enabled 已置为 false`);
                            }
                        } catch(e) { /* ignore parse error */ }
                    });
                }

                // 记录删除日志
                insertModelChangeLog({
                    modelId: model.id,
                    modelName: model.table_name,
                    action: 'DELETE',
                    changeType: 'full_delete',
                    beforeValue: model,
                    afterValue: null,
                    changeSummary: reason ? `删除模型: ${reason}` : '删除模型',
                    operatorId: userId,
                    operatorName: userName
                });

                res.json({ message: "模型已删除" });
            }
        );
    } catch (err) {
        logger.error('Delete model error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 4. 更新模型 (需要登录，权限校验：管理员/发布者可编辑所有，开发者仅能编辑自己注册的)
app.put('/api/models/:id', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { table_name, table_comment, tech_owner, biz_owner, status, source_system, source_table, category, dim_config, update_cycle, domain, config_mode, design_notes } = req.body;
    const userRole = req.user.role;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;

    try {
        // 获取原模型信息（用于变更对比和权限检查）
        const oldModel = await dbGetAsync("SELECT * FROM data_models WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)", [id]);
        if (!oldModel) {
            return res.status(404).json({ error: "模型不存在" });
        }

        // 如果要修改 table_name，检查新名称是否已存在
        if (table_name && table_name !== oldModel.table_name) {
            const existingModel = await dbGetAsync("SELECT id FROM data_models WHERE table_name = ? AND id != ? AND (is_deleted = 0 OR is_deleted IS NULL)", [table_name, id]);
            if (existingModel) {
                return res.status(400).json({ error: `表名 ${table_name} 已被其他模型使用` });
            }
        }

        // 权限检查：管理员可编辑所有模型，其他人只能编辑自己作为技术负责人的模型
        if (userRole !== 'admin') {
            const isTechOwner = oldModel.tech_owner === userName;
            const isCreator = oldModel.created_by_id === userId;
            if (!isTechOwner && !isCreator) {
                return res.status(403).json({ error: "权限不足：只有技术负责人或管理员可以编辑此模型" });
            }
        }

        // 解析旧的 dim_config
        let oldDimConfig = null;
        if (oldModel.dim_config) {
            try {
                oldDimConfig = JSON.parse(oldModel.dim_config);
            } catch (e) {
                oldDimConfig = null;
            }
        }

        // 判断变更类型 - 使用深度比较检测是否有实际变化
        const dimConfigProvided = dim_config !== undefined;
        const hasDimConfigChange = dimConfigProvided && hasDimConfigActualChange(oldDimConfig, dim_config);
        const hasTableNameChange = table_name && table_name !== oldModel.table_name;
        const hasBasicInfoChange = hasTableNameChange ||
            (table_comment !== undefined && table_comment !== oldModel.table_comment) ||
            (tech_owner !== undefined && tech_owner !== oldModel.tech_owner) ||
            (biz_owner !== undefined && biz_owner !== oldModel.biz_owner) ||
            (status !== undefined && status !== oldModel.status) ||
            (source_system !== undefined && source_system !== oldModel.source_system) ||
            (source_table !== undefined && source_table !== oldModel.source_table) ||
            (category !== undefined && category !== oldModel.category) ||
            (update_cycle !== undefined && update_cycle !== oldModel.update_cycle) ||
            (domain !== undefined && domain !== oldModel.domain) ||
            (config_mode !== undefined && config_mode !== oldModel.config_mode) ||
            (design_notes !== undefined && design_notes !== oldModel.design_notes);

        // 如果没有任何实际变化，仍需检查伴生表是否需要补建，然后返回
        if (!hasDimConfigChange && !hasBasicInfoChange) {
            if (oldModel.layer && oldModel.layer.toUpperCase() === 'DWD') {
                ensureCompanionExists(oldModel.id, oldDimConfig, oldModel, userId);
            }
            return res.json({ message: "模型更新成功", noChange: true });
        }

        // 构建更新语句
        let sql, params;
        // 计算实际要写入的值（如果前端没传则保持原值）
        const finalTableName = table_name || oldModel.table_name;
        const finalTableComment = table_comment !== undefined ? table_comment : oldModel.table_comment;
        const finalTechOwner = tech_owner !== undefined ? tech_owner : oldModel.tech_owner;
        const finalBizOwner = biz_owner !== undefined ? biz_owner : oldModel.biz_owner;
        const finalStatus = status !== undefined ? status : oldModel.status;
        const finalSourceSystem = source_system !== undefined ? (source_system || null) : (oldModel.source_system || null);
        const finalSourceTable = source_table !== undefined ? (source_table || null) : (oldModel.source_table || null);
        const finalCategory = category !== undefined ? (category || 'general') : (oldModel.category || 'general');
        const finalUpdateCycle = update_cycle !== undefined ? (update_cycle || null) : oldModel.update_cycle;
        const finalDomain = domain !== undefined ? (domain || null) : oldModel.domain;
        const finalConfigMode = config_mode !== undefined ? (config_mode || 'standard') : (oldModel.config_mode || 'standard');

        // 字段变更时间戳：对比新旧 dim_config，自动给新增字段打 addedAt、修改字段打 modifiedAt
        if (hasDimConfigChange && dim_config && oldDimConfig) {
            const today = new Date().toISOString().split('T')[0];
            const stampTimestamps = (newFields, oldFields, getKey, hasChanged) => {
                if (!newFields || !Array.isArray(newFields)) return;
                const oldMap = new Map();
                (oldFields || []).forEach(f => { const k = (getKey(f) || '').toLowerCase(); if (k) oldMap.set(k, f); });
                newFields.forEach(f => {
                    const key = (getKey(f) || '').toLowerCase();
                    if (!key) return;
                    const old = oldMap.get(key);
                    if (!old) {
                        if (!f.addedAt) f.addedAt = today;
                    } else if (hasChanged(f, old)) {
                        f.modifiedAt = today;
                        if (old.addedAt) f.addedAt = old.addedAt;
                    } else {
                        if (old.addedAt) f.addedAt = old.addedAt;
                        if (old.modifiedAt) f.modifiedAt = old.modifiedAt;
                    }
                });
            };
            stampTimestamps(dim_config.selectedFields, oldDimConfig.selectedFields,
                f => f.targetField,
                (f, o) => f.dataType !== o.dataType || f.srcField !== o.srcField || f.sourceAlias !== o.sourceAlias);
            stampTimestamps(dim_config.derivedFields, oldDimConfig.derivedFields,
                f => f.name,
                (f, o) => f.expression !== o.expression || (f.type || f.dataType) !== (o.type || o.dataType));
            stampTimestamps(dim_config.fieldMappings, oldDimConfig.fieldMappings,
                f => f.targetField,
                (f, o) => f.dataType !== o.dataType || f.srcField !== o.srcField);
        }

        if (dimConfigProvided) {
            const dimConfigJson = dim_config ? JSON.stringify(dim_config) : null;
            sql = `
                UPDATE data_models
                SET table_name = ?, table_comment = ?, tech_owner = ?, biz_owner = ?, status = ?,
                    source_system = ?, source_table = ?, model_type = ?, category = ?,
                    update_cycle = ?, domain = ?, config_mode = ?,
                    dim_config = ?, design_notes = ?, updated_at = datetime('now', 'localtime')
                WHERE id = ?
            `;
            const finalDesignNotes = design_notes !== undefined ? (design_notes || null) : (oldModel.design_notes || null);
            params = [
                finalTableName, finalTableComment, finalTechOwner, finalBizOwner, finalStatus,
                finalSourceSystem, finalSourceTable,
                req.body.model_type || oldModel.model_type || 'TABLE', finalCategory,
                finalUpdateCycle, finalDomain, finalConfigMode,
                dimConfigJson, finalDesignNotes, id
            ];
        } else {
            sql = `
                UPDATE data_models
                SET table_name = ?, table_comment = ?, tech_owner = ?, biz_owner = ?, status = ?,
                    source_system = ?, source_table = ?, model_type = ?, category = ?,
                    update_cycle = ?, domain = ?, config_mode = ?, design_notes = ?,
                    updated_at = datetime('now', 'localtime')
                WHERE id = ?
            `;
            const finalDesignNotes2 = design_notes !== undefined ? (design_notes || null) : (oldModel.design_notes || null);
            params = [
                finalTableName, finalTableComment, finalTechOwner, finalBizOwner, finalStatus,
                finalSourceSystem, finalSourceTable,
                req.body.model_type || oldModel.model_type || 'TABLE', finalCategory,
                finalUpdateCycle, finalDomain, finalConfigMode, finalDesignNotes2,
                id
            ];
        }

        db.run(sql, params, function (err) {
            if (err) return res.status(500).json({ error: err.message });

            // 记录变更日志（只有实际变化时才记录）
            const beforeValue = {
                ...oldModel,
                dim_config: oldDimConfig
            };
            const afterValue = {
                table_comment, tech_owner, biz_owner, status,
                source_system, source_table, category,
                model_type: req.body.model_type || 'TABLE',
                dim_config: dim_config || oldDimConfig
            };

            // 确定变更类型
            let changeType = '';
            if (hasDimConfigChange && hasBasicInfoChange) {
                changeType = 'basic_info,dim_config';
            } else if (hasDimConfigChange) {
                changeType = 'dim_config';
            } else if (hasBasicInfoChange) {
                changeType = 'basic_info';
            }

            const changeSummary = generateChangeSummary('UPDATE', beforeValue, afterValue, changeType);

            insertModelChangeLog({
                modelId: oldModel.id,
                modelName: oldModel.table_name,
                action: 'UPDATE',
                changeType,
                beforeValue,
                afterValue,
                changeSummary,
                operatorId: userId,
                operatorName: userName
            });

            // === 伴生表级联管理 ===
            if (dimConfigProvided && oldModel.layer && oldModel.layer.toUpperCase() === 'DWD') {
                syncCompanionTable(oldModel.id, dim_config, oldDimConfig, oldModel, userId, userName);
            }

            res.json({ message: "模型更新成功" });
        });
    } catch (err) {
        logger.error('Update model error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// === 伴生表级联管理辅助函数 ===
function syncCompanionTable(parentId, newConfig, oldConfig, parentModel, userId, userName) {
    const newCT = newConfig?.dwdConfig?.changeTracking || newConfig?.changeTracking;
    const oldCT = oldConfig?.dwdConfig?.changeTracking || oldConfig?.changeTracking;
    const nowEnabled = newCT?.enabled === true;
    const wasEnabled = oldCT?.enabled === true;
    const parentTableName = parentModel.table_name;
    const changeTableName = newCT?.changeTableName || parentTableName.replace(/_df$/, '_change_di');

    if (nowEnabled && !wasEnabled) {
        // 新勾选 → 创建伴生表模型
        const companionConfig = JSON.stringify({
            configType: 'DWD_COMPANION',
            parentModelId: parentId,
            parentTableName: parentTableName
        });
        // 先检查是否已存在（可能之前软删除了）
        db.get(`SELECT id, is_deleted FROM data_models WHERE table_name = ?`, [changeTableName], (err, existing) => {
            if (err) return logger.error(`伴生表检查失败: ${err.message}`);
            if (existing && existing.is_deleted == 1) {
                // 恢复已删除的伴生表
                db.run(`UPDATE data_models SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
                    companion_of = ?, dim_config = ?, config_mode = 'companion', table_comment = ?,
                    tech_owner = ?, domain = ?, layer = ?, updated_at = datetime('now','localtime')
                    WHERE id = ?`,
                    [parentId, companionConfig, (parentModel.table_comment || '') + ' - 变更追踪',
                     parentModel.tech_owner, parentModel.domain, parentModel.layer, existing.id]);
                // 更新主表的 changeTracking.companionModelId
                updateCompanionModelId(parentId, existing.id);
            } else if (existing) {
                // 已存在且未删除 — 更新从属关系
                db.run(`UPDATE data_models SET companion_of = ?, dim_config = ?, config_mode = 'companion',
                    updated_at = datetime('now','localtime') WHERE id = ?`,
                    [parentId, companionConfig, existing.id]);
                updateCompanionModelId(parentId, existing.id);
            } else {
                // 创建新的伴生表记录
                db.run(`INSERT INTO data_models (layer, domain, table_name, table_comment, tech_owner, biz_owner,
                    update_cycle, status, created_by_id, dim_config, config_mode, companion_of, category)
                    VALUES (?, ?, ?, ?, ?, ?, 'di', ?, ?, ?, 'companion', ?, 'general')`,
                    [parentModel.layer, parentModel.domain, changeTableName,
                     (parentModel.table_comment || '') + ' - 变更追踪',
                     parentModel.tech_owner, parentModel.biz_owner,
                     parentModel.status, userId, companionConfig, parentId],
                    function(insertErr) {
                        if (insertErr) return logger.error(`伴生表创建失败: ${insertErr.message}`);
                        const companionId = this.lastID;
                        updateCompanionModelId(parentId, companionId);
                        logger.info(`伴生表已创建: id=${companionId}, table=${changeTableName}, parent=${parentId}`);
                    });
            }
        });
    } else if (!nowEnabled && wasEnabled) {
        // 取消勾选 → 软删除伴生表
        db.run(`UPDATE data_models SET is_deleted = 1, deleted_at = datetime('now','localtime'),
            deleted_by = ?, delete_reason = '主表取消变更追踪' WHERE companion_of = ? AND (is_deleted = 0 OR is_deleted IS NULL)`,
            [userId, parentId], function(err) {
                if (err) return logger.error(`伴生表删除失败: ${err.message}`);
                if (this.changes > 0) logger.info(`伴生表已软删除: parent=${parentId}, affected=${this.changes}`);
            });
    } else if (nowEnabled && wasEnabled) {
        // 更新伴生表信息（同步主表的 tech_owner、domain 等）
        const companionConfig = JSON.stringify({
            configType: 'DWD_COMPANION',
            parentModelId: parentId,
            parentTableName: parentModel.table_name
        });
        // 先尝试通过 companion_of 找伴生表
        db.get(`SELECT id FROM data_models WHERE companion_of = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, [parentId], (err, companion) => {
            if (companion) {
                // 伴生表已存在且关系正确 — 同步元数据
                db.run(`UPDATE data_models SET table_comment = ?, tech_owner = ?, domain = ?, dim_config = ?,
                    updated_at = datetime('now','localtime') WHERE id = ?`,
                    [(parentModel.table_comment || '') + ' - 变更追踪',
                     parentModel.tech_owner, parentModel.domain, companionConfig, companion.id]);
            } else {
                // companion_of 关系未建立（可能是旧数据或已被用户手动删除），按表名查找
                db.get(`SELECT id, is_deleted FROM data_models WHERE table_name = ?`, [changeTableName], (err2, existing) => {
                    if (err2) return;
                    if (existing && existing.is_deleted == 1) {
                        // 伴生表已被用户手动删除 — 不自动恢复，等用户通过平台重新勾选创建
                        logger.info(`伴生表 ${changeTableName}(id=${existing.id}) 已被删除，跳过自动恢复，需用户手动重建`);
                    } else if (existing) {
                        // 已存在但 companion_of 为空 — 补充从属关系
                        db.run(`UPDATE data_models SET companion_of = ?, dim_config = ?, config_mode = 'companion',
                            table_comment = ?, tech_owner = ?, domain = ?,
                            updated_at = datetime('now','localtime') WHERE id = ?`,
                            [parentId, companionConfig, (parentModel.table_comment || '') + ' - 变更追踪',
                             parentModel.tech_owner, parentModel.domain, existing.id]);
                        updateCompanionModelId(parentId, existing.id);
                    } else {
                        // 完全不存在 — 不自动补建，等用户通过平台重新勾选创建
                        logger.info(`伴生表 ${changeTableName} 不存在，跳过自动补建，需用户手动重建`);
                    }
                });
            }
        });
    }
}

// 检查已启用变更追踪的主表是否缺少伴生表（仅同步元数据，不自动恢复已删除或补建缺失的伴生表）
function ensureCompanionExists(parentId, config, parentModel, userId) {
    const ct = config?.dwdConfig?.changeTracking || config?.changeTracking;
    if (!ct?.enabled) return; // 未启用，不处理

    const changeTableName = ct.changeTableName || parentModel.table_name.replace(/_df$/, '_change_di');

    // 先检查是否已有活跃的伴生表
    db.get(`SELECT id FROM data_models WHERE companion_of = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, [parentId], (err, active) => {
        if (err) return;
        if (active) return; // 已存在活跃伴生表，无需操作

        // 不存在活跃伴生表 — 不自动恢复或补建，等用户通过平台手动勾选重建
        logger.info(`主表 id=${parentId} 启用了变更追踪但无活跃伴生表，跳过自动补建，需用户手动重建`);
    });
}

function updateCompanionModelId(parentId, companionId) {
    // 把 companionModelId 写回主表的 changeTracking 配置中
    db.get(`SELECT dim_config FROM data_models WHERE id = ?`, [parentId], (err, row) => {
        if (err || !row || !row.dim_config) return;
        try {
            const cfg = JSON.parse(row.dim_config);
            const ct = cfg.dwdConfig?.changeTracking || cfg.changeTracking;
            if (ct) {
                ct.companionModelId = companionId;
                db.run(`UPDATE data_models SET dim_config = ? WHERE id = ?`,
                    [JSON.stringify(cfg), parentId]);
            }
        } catch(e) { /* ignore parse error */ }
    });
}

// 5. 检查表名是否存在 (需要登录)
app.get('/api/models/check', authenticateToken, (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: "Name is required" });

    // 排除已删除的模型，允许重新注册已删除的同名模型
    db.get("SELECT id FROM data_models WHERE table_name = ? AND (is_deleted = 0 OR is_deleted IS NULL)", [name], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exists: !!row });
    });
});

// 5.1 检查模型的归档任务数量（用于计算迭代版本）
app.get('/api/models/:id/archived-tasks-count', authenticateToken, (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Model ID is required" });

    // 统计该模型关联的已归档任务数量
    db.get(
        "SELECT COUNT(*) as count FROM task_pool WHERE linked_model_id = ? AND status = 'ARCHIVED'",
        [id],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ archivedCount: row ? row.count : 0 });
        }
    );
});

// 5.2 获取模型关联的归档任务列表
app.get('/api/models/:id/archived-tasks', authenticateToken, (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Model ID is required" });

    db.all(
        `SELECT id, title, owner, done_at, category
         FROM task_pool
         WHERE linked_model_id = ? AND status = 'ARCHIVED'
         ORDER BY done_at DESC`,
        [id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 5.3 获取模型变更日志
app.get('/api/models/:id/change-logs', authenticateToken, (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Model ID is required" });

    db.all(
        `SELECT id, model_id, model_name, action, change_type, before_value, after_value,
                change_summary, operator_id, operator_name, created_at
         FROM model_change_logs
         WHERE model_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
        [id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            // 解析 JSON 字段
            const logs = (rows || []).map(log => ({
                ...log,
                before_value: log.before_value ? JSON.parse(log.before_value) : null,
                after_value: log.after_value ? JSON.parse(log.after_value) : null
            }));

            res.json(logs);
        }
    );
});

// 5.3.1 手动记录模型变更日志（用于 API 操作后的变更追溯）
app.post('/api/models/:id/change-log', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { changeSummary, changeType } = req.body;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;

    if (!changeSummary) {
        return res.status(400).json({ error: '缺少 changeSummary 参数' });
    }

    try {
        const model = await dbGetAsync("SELECT id, table_name, tech_owner, created_by_id FROM data_models WHERE id = ?", [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 业务权限检查：admin/publisher OR tech_owner OR 当前活跃任务 owner
        const latestOwnerId = await getLatestActiveTaskOwnerId(id);
        if (!canOperateModel(req.user, model, latestOwnerId)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、当前任务负责人或管理员可以添加变更记录' });
        }

        insertModelChangeLog({
            modelId: model.id,
            modelName: model.table_name,
            action: 'NOTE',
            changeType: changeType || 'manual_note',
            beforeValue: null,
            afterValue: null,
            changeSummary,
            operatorId: userId,
            operatorName: userName
        });

        res.json({ message: '变更记录已添加' });
    } catch (err) {
        logger.error('Add change log error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 5.4 获取所有模型变更日志（管理员查看）
app.get('/api/model-change-logs', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { limit = 50, offset = 0, action, modelName } = req.query;

    let sql = `
        SELECT id, model_id, model_name, action, change_type,
               change_summary, operator_id, operator_name, created_at
        FROM model_change_logs
        WHERE 1=1
    `;
    let params = [];

    if (action) {
        sql += " AND action = ?";
        params.push(action);
    }
    if (modelName) {
        sql += " AND model_name LIKE ?";
        params.push(`%${modelName}%`);
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 6. 批量导入模型 (仅管理员/发布者可操作)
app.post('/api/models/batch', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const models = req.body;

    if (!Array.isArray(models) || models.length === 0) {
        return res.status(400).json({ error: "请提供有效的模型数组" });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    try {
        await dbRunAsync("BEGIN TRANSACTION");

        for (let i = 0; i < models.length; i++) {
            const m = models[i];

            // 基础验证
            if (!m.table_name || !m.layer) {
                errors.push(`第${i + 1}行: 表名和分层为必填项`);
                failCount++;
                continue;
            }

            // 检查表名是否已存在
            const existing = await dbGetAsync("SELECT id FROM data_models WHERE table_name = ?", [m.table_name]);
            if (existing) {
                errors.push(`第${i + 1}行: 表名 ${m.table_name} 已存在`);
                failCount++;
                continue;
            }

            try {
                await dbRunAsync(`
                    INSERT INTO data_models
                    (layer, domain, table_name, table_comment, tech_owner, biz_owner, update_cycle, source_system, source_table, model_type, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    m.layer.toUpperCase(),
                    m.domain || null,
                    m.table_name,
                    m.table_comment || null,
                    m.tech_owner || null,
                    m.biz_owner || null,
                    m.update_cycle || null,
                    m.source_system || null,
                    m.source_table || null,
                    m.model_type || 'TABLE',
                    'CREATED'  // 批量导入的模型默认为 CREATED 状态，忽略用户输入
                ]);
                successCount++;
            } catch (insertErr) {
                console.error(`Model insert error for ${m.table_name}:`, insertErr.message);
                errors.push(`第${i + 1}行: ${insertErr.message}`);
                failCount++;
            }
        }

        await dbRunAsync("COMMIT");

        res.json({
            success: successCount,
            failed: failCount,
            errors: errors.slice(0, 10),
            message: `成功导入 ${successCount} 条模型`
        });

    } catch (e) {
        console.error("Model batch import error:", e.message);
        try { await dbRunAsync("ROLLBACK"); } catch (rollbackErr) { /* ignore */ }
        res.status(500).json({ error: "服务器事务错误: " + e.message });
    }
});

// ==================== ODS 自动验收 API ====================

// 1. 获取数据库连接列表 (仅管理员)
app.get('/api/db-connections', authenticateToken, requireAdmin, (req, res) => {
    db.all("SELECT id, name, type, host, port, database, default_schema, username, is_default, connection_type, source_system_code, created_at, updated_at FROM db_connections ORDER BY is_default DESC, id", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 1.5 测试新连接 (未保存的连接，仅管理员) - 必须在 :id 路由之前
app.post('/api/db-connections/test-new', authenticateToken, requireAdmin, async (req, res) => {
    const { type, host, port, database, username, password } = req.body;

    if (!host || !database || !username || !password) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    const dialect = (type === 'mysql') ? 'mysql' : 'sqlserver';  // v1.69.1：默认 sqlserver 保持向后兼容

    try {
        if (dialect === 'mysql') {
            // mysql2 一次性连接（不入池，避免污染 mysqlPools 缓存）
            const conn = await mysql.createConnection({
                host,
                port: port || 3306,
                database,
                user: username,
                password,
                connectTimeout: 10000,
                charset: 'utf8mb4'
            });
            try {
                await conn.query('SELECT 1 AS test');
            } finally {
                await conn.end();
            }
        } else {
            const config = {
                user: username,
                password: password,
                server: host,
                port: port || 1433,
                database: database,
                options: {
                    encrypt: false,
                    trustServerCertificate: true,
                    enableArithAbort: true,
                    requestTimeout: 10000
                }
            };
            const pool = new sql.ConnectionPool(config);
            await pool.connect();
            await pool.request().query('SELECT 1 as test');
            await pool.close();
        }

        res.json({ success: true, message: '连接测试成功' });
    } catch (err) {
        logger.error(`Test new db connection error (dialect=${dialect}):`, err.message);
        res.status(500).json({ success: false, error: '连接失败: ' + err.message });
    }
});

// 1.6 获取默认数据库连接 (需要登录) - 必须在 :id 路由之前
app.get('/api/db-connections/default', authenticateToken, async (req, res) => {
    try {
        const conn = await dbGetAsync("SELECT id, name, type, host, port, database, default_schema FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1");
        if (!conn) {
            return res.status(404).json({ error: '未配置默认数据库连接' });
        }
        res.json(conn);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 新增数据库连接 (仅管理员)
app.post('/api/db-connections', authenticateToken, requireAdmin, async (req, res) => {
    const { name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code } = req.body;

    if (!name || !host || !database || !username || !password) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    // 源系统连接必须填写源系统代码
    if (connection_type === 'source' && !source_system_code) {
        return res.status(400).json({ error: '源系统连接必须填写源系统代码' });
    }

    try {
        const encryptedPassword = encryptPassword(password);

        // 如果设置为默认连接，先清除其他默认（仅对数仓连接）
        if (is_default && connection_type !== 'source') {
            await dbRunAsync("UPDATE db_connections SET is_default = 0 WHERE connection_type = 'warehouse' OR connection_type IS NULL");
        }

        const result = await dbRunAsync(
            `INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, type || 'sqlserver', host, port || 1433, database, default_schema || 'dbo', username, encryptedPassword,
             (is_default && connection_type !== 'source') ? 1 : 0, connection_type || 'warehouse', source_system_code || null]
        );

        res.json({ id: result.lastID, message: '数据库连接创建成功' });
    } catch (err) {
        logger.error('Create db connection error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. 更新数据库连接 (仅管理员)
app.put('/api/db-connections/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, type, host, port, database, default_schema, username, password, is_default } = req.body;

    try {
        // 如果设置为默认连接，先清除其他默认
        if (is_default) {
            await dbRunAsync("UPDATE db_connections SET is_default = 0 WHERE id != ?", [id]);
        }

        let sql, params;
        if (password) {
            // 更新密码
            const encryptedPassword = encryptPassword(password);
            sql = `UPDATE db_connections SET name = ?, type = ?, host = ?, port = ?, database = ?, default_schema = ?, username = ?, password = ?, is_default = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`;
            params = [name, type, host, port, database, default_schema, username, encryptedPassword, is_default ? 1 : 0, id];
        } else {
            // 不更新密码
            sql = `UPDATE db_connections SET name = ?, type = ?, host = ?, port = ?, database = ?, default_schema = ?, username = ?, is_default = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`;
            params = [name, type, host, port, database, default_schema, username, is_default ? 1 : 0, id];
        }

        await dbRunAsync(sql, params);
        res.json({ message: '数据库连接更新成功' });
    } catch (err) {
        logger.error('Update db connection error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 4. 删除数据库连接 (仅管理员)
app.delete('/api/db-connections/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        await dbRunAsync("DELETE FROM db_connections WHERE id = ?", [id]);
        res.json({ message: '数据库连接删除成功' });
    } catch (err) {
        logger.error('Delete db connection error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 5. 测试数据库连接 (仅管理员)
app.post('/api/db-connections/:id/test', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const conn = await dbGetAsync("SELECT * FROM db_connections WHERE id = ?", [id]);
        if (!conn) {
            return res.status(404).json({ error: '连接配置不存在' });
        }

        const password = decryptPassword(conn.password);
        const dialect = (conn.type === 'mysql') ? 'mysql' : 'sqlserver';  // v1.69.1

        if (dialect === 'mysql') {
            const pool = await getMysqlPool({
                host: conn.host,
                port: conn.port,
                database: conn.database,
                username: conn.username,
                password
            });
            await pool.query('SELECT 1 AS test');
        } else {
            const pool = await getMssqlPool({
                host: conn.host,
                port: conn.port,
                database: conn.database,
                username: conn.username,
                password
            });
            await pool.request().query('SELECT 1 as test');
        }
        res.json({ success: true, message: '连接测试成功' });
    } catch (err) {
        logger.error('Test db connection error:', err.message);
        res.status(500).json({ success: false, error: '连接失败: ' + err.message });
    }
});

// 5.1 获取源表字段结构 (用于 DDL 生成)
app.get('/api/db-connections/table-columns', authenticateToken, async (req, res) => {
    const { source_system, table_name } = req.query;

    if (!source_system || !table_name) {
        return res.status(400).json({ error: '缺少参数: source_system 和 table_name' });
    }

    try {
        // 根据源系统代码查找源系统连接
        const conn = await dbGetAsync(
            "SELECT * FROM db_connections WHERE connection_type = 'source' AND source_system_code = ?",
            [source_system]
        );

        if (!conn) {
            return res.status(404).json({
                error: `未找到源系统 ${source_system} 的数据库连接配置`,
                hint: '请联系管理员在「管理后台 → 数据库连接」中配置源系统连接'
            });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 解析表名（可能包含 schema，如 dbo.table_name）
        let schema = conn.default_schema || 'dbo';
        let tableName = table_name;
        if (table_name.includes('.')) {
            const parts = table_name.split('.');
            schema = parts[0];
            tableName = parts[1];
        }

        // 查询表字段结构（包含 IDENTITY 和主键信息）
        const result = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`
                SELECT
                    c.COLUMN_NAME as column_name,
                    c.DATA_TYPE as data_type,
                    c.CHARACTER_MAXIMUM_LENGTH as max_length,
                    c.NUMERIC_PRECISION as precision,
                    c.NUMERIC_SCALE as scale,
                    c.IS_NULLABLE as is_nullable,
                    c.COLUMN_DEFAULT as column_default,
                    ISNULL(CAST(ep.value AS NVARCHAR(500)), '') as column_comment,
                    ISNULL(sc.is_identity, 0) as is_identity,
                    CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END as is_primary_key
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME
                    AND sc.object_id = OBJECT_ID(@schema + '.' + @table)
                LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id
                    AND ep.minor_id = sc.column_id
                    AND ep.name = 'MS_Description'
                LEFT JOIN (
                    SELECT col.name as column_name
                    FROM sys.indexes idx
                    JOIN sys.index_columns ic ON idx.object_id = ic.object_id AND idx.index_id = ic.index_id
                    JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
                    WHERE idx.is_primary_key = 1 AND idx.object_id = OBJECT_ID(@schema + '.' + @table)
                ) pk ON pk.column_name = c.COLUMN_NAME
                WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
                ORDER BY c.ORDINAL_POSITION
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                error: `表 ${schema}.${tableName} 不存在或无法访问`,
                hint: '请检查表名是否正确，或确认数据库连接账号有读取权限'
            });
        }

        // 获取表注释
        const tableCommentResult = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`
                SELECT CAST(ep.value AS NVARCHAR(500)) as table_comment
                FROM sys.extended_properties ep
                JOIN sys.tables t ON ep.major_id = t.object_id
                JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE ep.minor_id = 0
                  AND ep.name = 'MS_Description'
                  AND s.name = @schema
                  AND t.name = @table
            `);

        const tableComment = tableCommentResult.recordset.length > 0
            ? tableCommentResult.recordset[0].table_comment
            : '';

        res.json({
            schema,
            table_name: tableName,
            table_comment: tableComment,
            columns: result.recordset
        });

    } catch (err) {
        logger.error('Get table columns error:', err.message);
        res.status(500).json({ error: '获取表结构失败: ' + err.message });
    }
});

// 5.2 获取数仓表字段结构 (用于 DIM 层 DDL 生成)
app.get('/api/warehouse/describe-table', authenticateToken, async (req, res) => {
    const { table } = req.query;

    if (!table) {
        return res.status(400).json({ error: '缺少参数: table' });
    }

    try {
        // 获取数仓默认连接
        const conn = await dbGetAsync(
            "SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1"
        );

        if (!conn) {
            return res.status(404).json({
                error: '未配置默认数仓连接',
                hint: '请联系管理员在「管理后台 → 数据库连接」中配置数仓连接'
            });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 解析表名（可能包含 schema）
        let schema = conn.default_schema || 'dbo';
        let tableName = table;
        if (table.includes('.')) {
            const parts = table.split('.');
            schema = parts[0];
            tableName = parts[1];
        }

        // 查询表字段结构
        const result = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`
                SELECT
                    c.COLUMN_NAME as column_name,
                    c.DATA_TYPE +
                        CASE
                            WHEN c.DATA_TYPE IN ('varchar', 'nvarchar', 'char', 'nchar')
                                THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'MAX' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) END + ')'
                            WHEN c.DATA_TYPE IN ('decimal', 'numeric')
                                THEN '(' + CAST(c.NUMERIC_PRECISION AS VARCHAR) + ',' + CAST(c.NUMERIC_SCALE AS VARCHAR) + ')'
                            ELSE ''
                        END as data_type,
                    c.IS_NULLABLE as is_nullable,
                    ISNULL(CAST(ep.value AS NVARCHAR(500)), '') as column_comment
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME
                    AND sc.object_id = OBJECT_ID(@schema + '.' + @table)
                LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id
                    AND ep.minor_id = sc.column_id
                    AND ep.name = 'MS_Description'
                WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
                ORDER BY c.ORDINAL_POSITION
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                error: `表 ${schema}.${tableName} 不存在`,
                hint: '请检查表名是否正确'
            });
        }

        res.json(result.recordset);

    } catch (err) {
        logger.error('Describe warehouse table error:', err.message);
        res.status(500).json({ error: '获取表结构失败: ' + err.message });
    }
});

// 5.3 获取数仓表完整信息（字段、行数、样例数据）- 用于资产中心详情页
app.get('/api/warehouse/table-info', authenticateToken, async (req, res) => {
    const { table } = req.query;

    if (!table) {
        return res.status(400).json({ error: '缺少参数: table' });
    }

    try {
        // 获取数仓默认连接
        const conn = await dbGetAsync(
            "SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1"
        );

        if (!conn) {
            return res.status(404).json({
                error: '未配置默认数仓连接',
                hint: '请联系管理员在「管理后台 → 数据库连接」中配置数仓连接'
            });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 解析表名（可能包含 schema）
        let schema = conn.default_schema || 'dbo';
        let tableName = table;
        if (table.includes('.')) {
            const parts = table.split('.');
            schema = parts[0];
            tableName = parts[1];
        }

        // 1. 查询表字段结构
        const fieldsResult = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`
                SELECT
                    c.COLUMN_NAME as name,
                    c.DATA_TYPE +
                        CASE
                            WHEN c.DATA_TYPE IN ('varchar', 'nvarchar', 'char', 'nchar')
                                THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'MAX' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) END + ')'
                            WHEN c.DATA_TYPE IN ('decimal', 'numeric')
                                THEN '(' + CAST(c.NUMERIC_PRECISION AS VARCHAR) + ',' + CAST(c.NUMERIC_SCALE AS VARCHAR) + ')'
                            ELSE ''
                        END as type,
                    CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as nullable,
                    ISNULL(CAST(ep.value AS NVARCHAR(500)), '') as comment
                FROM INFORMATION_SCHEMA.COLUMNS c
                LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME
                    AND sc.object_id = OBJECT_ID(@schema + '.' + @table)
                LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id
                    AND ep.minor_id = sc.column_id
                    AND ep.name = 'MS_Description'
                WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
                ORDER BY c.ORDINAL_POSITION
            `);

        if (fieldsResult.recordset.length === 0) {
            return res.status(404).json({
                error: `表 ${schema}.${tableName} 不存在`,
                hint: '请检查表名是否正确，或表尚未在数仓中创建'
            });
        }

        // 2. 查询表行数（使用 sys.partitions 快速估算，避免全表扫描）
        const countResult = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`
                SELECT SUM(p.rows) AS row_count
                FROM sys.partitions p
                INNER JOIN sys.tables t ON p.object_id = t.object_id
                INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE s.name = @schema AND t.name = @table AND p.index_id IN (0, 1)
            `);

        // 3. 获取表最近更新时间（通过 sys.dm_db_index_usage_stats）
        let lastUpdate = null;
        try {
            const updateResult = await pool.request()
                .input('schema', sql.NVarChar, schema)
                .input('table', sql.NVarChar, tableName)
                .query(`
                    SELECT TOP 1
                        CONVERT(VARCHAR(10), ISNULL(last_user_update, last_user_seek), 120) as last_update
                    FROM sys.dm_db_index_usage_stats us
                    INNER JOIN sys.objects o ON us.object_id = o.object_id
                    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                    WHERE s.name = @schema AND o.name = @table
                    ORDER BY ISNULL(last_user_update, last_user_seek) DESC
                `);
            if (updateResult.recordset.length > 0) {
                lastUpdate = updateResult.recordset[0].last_update;
            }
        } catch (e) {
            // 忽略权限不足等错误
            logger.debug('Get table last update failed:', e.message);
        }

        // 4. 查询样例数据（限制 10 条）
        let sampleData = [];
        try {
            const sampleResult = await pool.request()
                .query(`SELECT TOP 10 * FROM [${schema}].[${tableName}]`);
            sampleData = sampleResult.recordset;
        } catch (e) {
            logger.debug('Get sample data failed:', e.message);
        }

        res.json({
            table_name: `${schema}.${tableName}`,
            fields: fieldsResult.recordset,
            row_count: countResult.recordset[0]?.row_count || 0,
            last_update: lastUpdate || '-',
            sample_data: sampleData
        });

    } catch (err) {
        logger.error('Get warehouse table info error:', err.message);
        res.status(500).json({ error: '获取表信息失败: ' + err.message });
    }
});

// 5.4 查询 DIM 表版本链（按业务键查询所有版本）- 用于资产中心变更追踪
app.post('/api/warehouse/version-chain', authenticateToken, async (req, res) => {
    const { tableName, businessKey, keyValue } = req.body;

    logger.info('查询版本链请求:', { tableName, businessKey, keyValue });

    if (!tableName || !businessKey || !keyValue) {
        logger.warn('版本链查询参数缺失:', { tableName, businessKey, keyValue });
        return res.status(400).json({ error: `缺少必要参数: tableName=${tableName}, businessKey=${businessKey}, keyValue=${keyValue}` });
    }

    try {
        // 获取数仓默认连接
        const conn = await dbGetAsync(
            "SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1"
        );

        if (!conn) {
            return res.status(404).json({ error: '未配置默认数仓连接' });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 解析表名（可能包含 schema）
        let schema = conn.default_schema || 'dbo';
        let table = tableName;
        if (tableName.includes('.')) {
            const parts = tableName.split('.');
            schema = parts[0];
            table = parts[1];
        }

        // 验证业务键字段是否存在（防止 SQL 注入）
        const columnCheck = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, table)
            .input('column', sql.NVarChar, businessKey)
            .query(`
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND COLUMN_NAME = @column
            `);

        if (columnCheck.recordset.length === 0) {
            return res.status(400).json({ error: `字段 ${businessKey} 不存在于表 ${tableName}` });
        }

        // 查询该业务键的所有版本记录
        // 注意：业务键字段名已通过上面的查询验证，可以安全拼接
        const result = await pool.request()
            .input('keyValue', sql.NVarChar, String(keyValue))
            .query(`
                SELECT *
                FROM [${schema}].[${table}]
                WHERE [${businessKey}] = @keyValue
                ORDER BY dw_eff_dt ASC
            `);

        res.json({
            tableName: `${schema}.${table}`,
            businessKey: businessKey,
            keyValue: keyValue,
            versionCount: result.recordset.length,
            versions: result.recordset
        });

    } catch (err) {
        logger.error('Query version chain error:', err.message);
        res.status(500).json({ error: '查询版本链失败: ' + err.message });
    }
});

// DIM 语义验收确认（人工勾选后保存，仅管理员/发布者）
app.post('/api/models/:id/semantic-review', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { id } = req.params;
    const { confirmed } = req.body; // { surrogate_key: true, business_key: true, ... }
    const userName = req.user.display_name || req.user.username;
    const userId = req.user.id;

    try {
        // 校验 confirmed 参数
        if (!confirmed || typeof confirmed !== 'object') {
            return res.status(400).json({ error: '缺少确认信息' });
        }

        const model = await dbGetAsync("SELECT * FROM data_models WHERE id = ?", [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 保存语义验收记录到 model_test_records
        await dbRunAsync(
            `INSERT INTO model_test_records (model_id, table_name, test_user, test_user_id, overall_result, total_rows, detail_json, execution_time_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, model.table_name, userName, userId, 'pass', 0, JSON.stringify({ phase: 'semantic', confirmed, confirmed_at: new Date().toISOString() }), 0]
        );

        logger.info(`Semantic review confirmed for model ${model.table_name} by ${userName}`);
        res.json({ success: true, message: '语义验收已确认' });
    } catch (err) {
        logger.error('Semantic review error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DIM 层独立验收端点（按表名验收，不依赖模型）
app.post('/api/warehouse/dim-acceptance', authenticateToken, requireNonViewer, async (req, res) => {
    const { tableName, phase, businessKey } = req.body;
    const userName = req.user.display_name || req.user.username;

    if (!tableName) {
        return res.status(400).json({ error: '缺少必要参数: tableName' });
    }

    try {
        // 获取数仓默认连接
        const conn = await dbGetAsync(
            "SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1"
        );
        if (!conn) {
            return res.status(400).json({ error: '未配置默认数据库连接，请联系管理员' });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 验证表存在
        const schema = conn.default_schema || 'dbo';
        const tableCheck = await pool.request()
            .input('schema', sql.NVarChar, schema)
            .input('table', sql.NVarChar, tableName)
            .query(`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table`);

        if (tableCheck.recordset.length === 0) {
            return res.status(400).json({ error: `表 ${schema}.${tableName} 不存在` });
        }

        // 尝试从 dim_models 获取配置
        let dimConfig = null;
        const dimModel = await dbGetAsync(
            "SELECT * FROM data_models WHERE table_name = ? AND layer = 'DIM'",
            [tableName]
        );
        if (dimModel && dimModel.dim_config) {
            try { dimConfig = JSON.parse(dimModel.dim_config); } catch (e) { /* ignore */ }
        }

        logger.info(`Starting DIM acceptance for ${tableName} by ${userName}`);
        const result = await executeDimValidation({
            pool, schema, tableName,
            businessKey: businessKey || null,
            dimConfig,
            phase: phase || 'all'
        });

        // 保存验收记录（如有关联模型）
        if (dimModel) {
            const savedPhase = phase || 'all';
            await dbRunAsync(
                `INSERT INTO model_test_records (model_id, table_name, test_user, test_user_id, overall_result, total_rows, detail_json, db_connection_id, execution_time_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [dimModel.id, tableName, userName, req.user.id, result.overall_result, result.total_rows, JSON.stringify({ phase: savedPhase, structure: result.structure, data: result.data, semantic: result.semantic, summary: result.summary }), conn.id, result.execution_time_ms]
            );
        }

        res.json({
            table_name: tableName,
            ...result,
            test_user: userName,
            test_time: new Date().toISOString()
        });
    } catch (err) {
        logger.error('DIM acceptance error:', err.message);
        res.status(500).json({ error: 'DIM 验收执行失败: ' + err.message });
    }
});

// 6. 获取验收配置 (需要登录)
app.get('/api/validation/config', authenticateToken, (req, res) => {
    db.all("SELECT * FROM validation_config", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 转换为对象格式
        const config = {};
        rows.forEach(r => { config[r.config_key] = r.config_value; });
        res.json(config);
    });
});

// 9. 更新验收配置 (仅管理员)
app.put('/api/validation/config', authenticateToken, requireAdmin, async (req, res) => {
    const configs = req.body; // { key1: value1, key2: value2 }

    try {
        for (const [key, value] of Object.entries(configs)) {
            await dbRunAsync(
                "UPDATE validation_config SET config_value = ?, updated_at = datetime('now', 'localtime') WHERE config_key = ?",
                [value, key]
            );
        }
        res.json({ message: '验收配置更新成功' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9.5 获取单个模型详情 (包含DIM配置)
app.get('/api/models/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const model = await dbGetAsync("SELECT * FROM data_models WHERE id = ?", [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }
        // 解析 DIM 配置 JSON（兼容双重 JSON 编码）
        if (model.dim_config) {
            try {
                model.dim_config = JSON.parse(model.dim_config);
                if (typeof model.dim_config === 'string') model.dim_config = JSON.parse(model.dim_config);
            } catch (e) {
                model.dim_config = null;
            }
        }
        res.json(model);
    } catch (err) {
        logger.error('Get model detail error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 10. 获取表元数据 (需要登录)
app.get('/api/models/:id/metadata', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        // 获取模型信息
        const model = await dbGetAsync("SELECT * FROM data_models WHERE id = ?", [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 获取默认数据库连接
        const conn = await dbGetAsync("SELECT * FROM db_connections WHERE is_default = 1 LIMIT 1");
        if (!conn) {
            return res.status(400).json({ error: '未配置默认数据库连接' });
        }

        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        const metadata = await getTableMetadata(pool, conn.default_schema, model.table_name);
        res.json({
            model: model,
            connection: { name: conn.name, database: conn.database, schema: conn.default_schema },
            metadata: metadata
        });
    } catch (err) {
        logger.error('Get metadata error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 11. 执行验收 (需要登录 + 业务权限)
app.post('/api/models/:id/validate', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;

    try {
        // 获取模型信息
        const model = await dbGetAsync("SELECT * FROM data_models WHERE id = ?", [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 业务权限检查：admin/publisher OR tech_owner OR 当前活跃任务 owner
        const latestOwnerId = await getLatestActiveTaskOwnerId(id);
        if (!canOperateModel(req.user, model, latestOwnerId)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、当前任务负责人或管理员可以执行验收' });
        }

        // 支持 ODS、DIM、DWD 层模型验收
        const layer = model.layer.toUpperCase();
        if (!['ODS', 'DIM', 'DWD'].includes(layer)) {
            return res.status(400).json({ error: `暂不支持 ${model.layer} 层模型验收，当前支持 ODS、DIM 和 DWD 层` });
        }

        // 获取默认数据库连接（数仓）
        const conn = await dbGetAsync("SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1");
        if (!conn) {
            return res.status(400).json({ error: '未配置默认数据库连接，请联系管理员' });
        }

        // 获取数仓连接池
        const password = decryptPassword(conn.password);
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        let result;

        if (layer === 'DIM') {
            // === DIM 层验收 ===
            let dimConfig = null;
            if (model.dim_config) {
                try {
                    dimConfig = JSON.parse(model.dim_config);
                    if (typeof dimConfig === 'string') dimConfig = JSON.parse(dimConfig);
                } catch (e) { /* ignore */ }
            }

            const dimPhase = req.body.phase || 'all';
            logger.info(`Starting DIM validation (phase=${dimPhase}) for model ${model.table_name} by ${userName}`);
            result = await executeDimValidation({
                pool,
                schema: conn.default_schema,
                tableName: model.table_name,
                businessKey: req.body.businessKey || null,
                dimConfig,
                phase: dimPhase
            });

            // 语义验收不保存 model_test_records（由人工确认后单独保存）
            let insertResult = { lastID: null };
            if (dimPhase !== 'semantic') {
                insertResult = await dbRunAsync(
                    `INSERT INTO model_test_records (model_id, table_name, test_user, test_user_id, overall_result, total_rows, detail_json, db_connection_id, execution_time_ms)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [id, model.table_name, userName, userId, result.overall_result, result.total_rows, JSON.stringify({ phase: dimPhase, structure: result.structure, data: result.data, semantic: result.semantic, summary: result.summary }), conn.id, result.execution_time_ms]
                );
            }

            logger.info(`DIM validation completed for model ${model.table_name}: ${result.overall_result}`);

            res.json({
                record_id: insertResult.lastID,
                model_id: parseInt(id),
                table_name: model.table_name,
                layer: 'DIM',
                ...result,
                test_user: userName,
                test_time: new Date().toISOString()
            });
        } else if (layer === 'DWD') {
            // === DWD 层验收 ===
            let dwdConfig = null;
            if (model.dim_config) {
                try {
                    dwdConfig = JSON.parse(model.dim_config);
                    // 处理双重 JSON 编码：API PUT 存入时可能多序列化一次
                    if (typeof dwdConfig === 'string') dwdConfig = JSON.parse(dwdConfig);
                } catch (e) { /* ignore */ }
            }

            const dwdPhase = req.body.phase || 'all';
            logger.info(`Starting DWD validation (phase=${dwdPhase}) for model ${model.table_name} by ${userName}`);
            result = await executeDwdValidation({
                pool,
                schema: conn.default_schema,
                tableName: model.table_name,
                dwdConfig,
                phase: dwdPhase
            });

            // 保存验收记录
            const insertResult = await dbRunAsync(
                `INSERT INTO model_test_records (model_id, table_name, test_user, test_user_id, overall_result, total_rows, detail_json, db_connection_id, execution_time_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, model.table_name, userName, userId, result.overall_result, result.total_rows, JSON.stringify({ phase: dwdPhase, structure: result.structure, data: result.data, summary: result.summary }), conn.id, result.execution_time_ms]
            );

            logger.info(`DWD validation completed for model ${model.table_name}: ${result.overall_result}`);

            res.json({
                record_id: insertResult.lastID,
                model_id: parseInt(id),
                table_name: model.table_name,
                layer: 'DWD',
                ...result,
                test_user: userName,
                test_time: new Date().toISOString()
            });
        } else {
            // === ODS 层验收（原有逻辑） ===
            // 获取验收配置
            const configRows = await dbAllAsync("SELECT * FROM validation_config");
            const validationConfig = {};
            configRows.forEach(r => { validationConfig[r.config_key] = r.config_value; });

            const validationParams = {
                pool,
                schema: conn.default_schema,
                tableName: model.table_name,
                validationConfig
            };

            // 如果模型有源系统和源表信息，尝试获取源系统连接进行数据量对比
            if (model.source_system && model.source_table) {
                const sourceConn = await dbGetAsync(
                    "SELECT * FROM db_connections WHERE connection_type = 'source' AND source_system_code = ?",
                    [model.source_system]
                );

                if (sourceConn) {
                    try {
                        const sourcePassword = decryptPassword(sourceConn.password);
                        const sourcePool = await getMssqlPool({
                            host: sourceConn.host,
                            port: sourceConn.port,
                            database: sourceConn.database,
                            username: sourceConn.username,
                            password: sourcePassword
                        });

                        validationParams.sourcePool = sourcePool;
                        validationParams.sourceSchema = sourceConn.default_schema;
                        validationParams.sourceTable = model.source_table;
                        validationParams.sourceDatabase = sourceConn.database;

                        logger.info(`Source system connection found for ${model.source_system}, will compare with source table ${model.source_table}`);
                    } catch (sourceConnErr) {
                        logger.warn(`Failed to connect to source system ${model.source_system}:`, sourceConnErr.message);
                    }
                } else {
                    logger.info(`No source system connection configured for ${model.source_system}`);
                }
            }

            logger.info(`Starting ODS validation for model ${model.table_name} by ${userName}`);
            result = await executeOdsValidation(validationParams);

            const insertResult = await dbRunAsync(
                `INSERT INTO model_test_records (model_id, table_name, test_user, test_user_id, overall_result, total_rows, detail_json, db_connection_id, execution_time_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, model.table_name, userName, userId, result.overall_result, result.total_rows, JSON.stringify(result.details), conn.id, result.execution_time_ms]
            );

            logger.info(`ODS validation completed for model ${model.table_name}: ${result.overall_result}`);

            res.json({
                record_id: insertResult.lastID,
                model_id: parseInt(id),
                table_name: model.table_name,
                layer: 'ODS',
                overall_result: result.overall_result,
                total_rows: result.total_rows,
                details: result.details,
                execution_time_ms: result.execution_time_ms,
                test_user: userName,
                test_time: new Date().toISOString()
            });
        }
    } catch (err) {
        logger.error('Validation error:', err.message);
        res.status(500).json({ error: '验收执行失败: ' + err.message });
    }
});

// 12. 获取模型验收历史 (需要登录)
app.get('/api/models/:id/test-records', authenticateToken, (req, res) => {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const phase = req.query.phase; // 可选：按 phase 过滤（structure/data/semantic）

    let sql = `SELECT id, model_id, table_name, test_time, test_user, overall_result, total_rows, execution_time_ms, created_at
         FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL)`;
    const params = [id];

    if (phase) {
        sql += ` AND detail_json LIKE ?`;
        params.push(`%"phase":"${phase.replace(/[^a-z]/g, '')}"%`);
    }

    sql += ` ORDER BY test_time DESC LIMIT ?`;
    params.push(limit);

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 13. 获取验收详情 (需要登录)
app.get('/api/models/:id/test-records/:recordId', authenticateToken, (req, res) => {
    const { id, recordId } = req.params;

    db.get(
        "SELECT * FROM model_test_records WHERE id = ? AND model_id = ?",
        [recordId, id],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: '验收记录不存在' });

            // 解析 detail_json
            row.details = JSON.parse(row.detail_json || '{}');
            delete row.detail_json;
            res.json(row);
        }
    );
});

// 14. 获取模型最新验收状态 (需要登录)
app.get('/api/models/:id/validation-status', authenticateToken, (req, res) => {
    const { id } = req.params;

    db.get(
        `SELECT overall_result, test_time, test_user FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1`,
        [id],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) {
                return res.json({ status: 'never', message: '未验收' });
            }
            res.json({
                status: row.overall_result,
                test_time: row.test_time,
                test_user: row.test_user
            });
        }
    );
});

// 15. 批量获取模型验收状态 (需要登录) - 用于列表展示
app.get('/api/models/validation-status/batch', authenticateToken, async (req, res) => {
    const { ids } = req.query; // 逗号分隔的 ID 列表

    if (!ids) {
        return res.json({});
    }

    const idList = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return res.json({});
    }

    try {
        // 获取每个模型的最新验收记录
        const placeholders = idList.map(() => '?').join(',');
        const records = await dbAllAsync(`
            SELECT m.model_id, m.overall_result, m.test_time, m.test_user
            FROM model_test_records m
            INNER JOIN (
                SELECT model_id, MAX(test_time) as max_time
                FROM model_test_records
                WHERE model_id IN (${placeholders}) AND (invalidated = 0 OR invalidated IS NULL)
                GROUP BY model_id
            ) latest ON m.model_id = latest.model_id AND m.test_time = latest.max_time
            WHERE m.invalidated = 0 OR m.invalidated IS NULL
        `, idList);

        // 获取分阶段验收状态（DIM/DWD 有 structure/data/semantic 阶段）
        const phaseRecords = await dbAllAsync(`
            SELECT model_id, detail_json, overall_result, test_time
            FROM model_test_records
            WHERE model_id IN (${placeholders}) AND (invalidated = 0 OR invalidated IS NULL)
            ORDER BY test_time DESC
        `, idList);

        // 转换为 { id: { status, phases } } 格式
        const statusMap = {};
        idList.forEach(id => { statusMap[id] = { status: 'never', phases: {} }; });
        records.forEach(r => {
            statusMap[r.model_id].status = r.overall_result;
            statusMap[r.model_id].test_time = r.test_time;
            statusMap[r.model_id].test_user = r.test_user;
        });

        // 提取分阶段信息（每个 phase 取最新一条）
        phaseRecords.forEach(r => {
            try {
                const detail = JSON.parse(r.detail_json || '{}');
                const phase = detail.phase;
                if (phase && statusMap[r.model_id] && !statusMap[r.model_id].phases[phase]) {
                    statusMap[r.model_id].phases[phase] = {
                        result: r.overall_result,
                        test_time: r.test_time
                    };
                }
            } catch (e) { /* ignore parse errors */ }
        });

        res.json(statusMap);
    } catch (err) {
        logger.error('Batch validation status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 模型脚本保存 API ====================

// 保存模型生成的脚本到服务器
// 脚本保存到关联任务的目录: uploads/{用户名}/{任务ID}_{任务标题}/
app.post('/api/models/:id/save-scripts', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { scripts, tableName } = req.body;
    const user = req.user;

    if (!scripts || !tableName) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    try {
        // 获取模型信息
        const model = await dbGetAsync('SELECT * FROM data_models WHERE id = ?', [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 业务权限检查：admin/publisher OR tech_owner OR 当前活跃任务 owner
        const latestOwnerId = await getLatestActiveTaskOwnerId(id);
        if (!canOperateModel(req.user, model, latestOwnerId)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、当前任务负责人或管理员可以保存脚本' });
        }

        // 查找关联该模型的任务（优先找当前用户的进行中任务）
        const userName = user.display_name || user.username;
        let task = await dbGetAsync(
            `SELECT id, title, owner FROM task_pool
             WHERE linked_model_id = ? AND owner = ? AND status IN ('CLAIMED', 'DONE')
             ORDER BY CASE WHEN status = 'CLAIMED' THEN 0 ELSE 1 END
             LIMIT 1`,
            [id, userName]
        );

        // 如果当前用户没有关联任务，查找任意关联任务
        if (!task) {
            task = await dbGetAsync(
                `SELECT id, title, owner FROM task_pool
                 WHERE linked_model_id = ? AND status IN ('CLAIMED', 'DONE')
                 ORDER BY CASE WHEN status = 'CLAIMED' THEN 0 ELSE 1 END
                 LIMIT 1`,
                [id]
            );
        }

        let scriptDir;
        let scriptPath;

        if (task) {
            // 保存到任务目录: uploads/{任务负责人}/{任务ID}_{任务标题}/
            const taskOwner = task.owner || userName;
            const safeTitle = task.title.replace(/[\\/:*?"<>|]/g, '_');
            scriptDir = path.join(UPLOAD_DIR, taskOwner, `${task.id}_${safeTitle}`);
            scriptPath = path.join(taskOwner, `${task.id}_${safeTitle}`);
            logger.info(`Saving scripts to task directory: ${scriptDir}`);
        } else {
            // 没有关联任务，保存到用户目录下的模型文件夹
            const safeTableName = tableName.replace(/[\\/:*?"<>|]/g, '_');
            scriptDir = path.join(UPLOAD_DIR, userName, `model_${id}_${safeTableName}`);
            scriptPath = path.join(userName, `model_${id}_${safeTableName}`);
            logger.info(`No linked task found, saving scripts to: ${scriptDir}`);
        }

        if (!fs.existsSync(scriptDir)) {
            fs.mkdirSync(scriptDir, { recursive: true });
        }

        const savedFiles = [];
        const archivedFiles = [];
        const skippedFiles = [];
        const safeTableName = tableName.replace(/[\\/:*?"<>|]/g, '_');

        // --- 脚本内容比对辅助函数 ---
        // 去掉注释头中的日期和版本行，只比较业务逻辑部分
        const normalizeForCompare = (content) => {
            return content
                .replace(/创建日期:\s*\d{4}-\d{2}-\d{2}/g, '')
                .replace(/配置版本:\s*v\d+/g, '')
                .replace(/最后同步:\s*[^\n]*/g, '')
                .replace(/\r\n/g, '\n')
                .trim();
        };

        // 归档旧文件到 _history/ 目录，保留最近 MAX_HISTORY 个版本
        const MAX_HISTORY = 20;
        const archiveOldScript = (scriptDir, fileName, configVersion) => {
            const filePath = path.join(scriptDir, fileName);
            if (!fs.existsSync(filePath)) return false;

            const historyDir = path.join(scriptDir, '_history');
            if (!fs.existsSync(historyDir)) {
                fs.mkdirSync(historyDir, { recursive: true });
            }

            // 归档文件名：{原名去.sql}.v{版本}.{日期}.sql
            const baseName = fileName.replace(/\.sql$/, '');
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const versionStr = configVersion || 'unknown';
            const archiveName = `${baseName}.v${versionStr}.${dateStr}.sql`;
            fs.copyFileSync(filePath, path.join(historyDir, archiveName));

            // 清理超出上限的历史文件（按同一脚本类型分组清理）
            const allHistory = fs.readdirSync(historyDir)
                .filter(f => f.startsWith(baseName + '.v') && f.endsWith('.sql'))
                .sort();  // 字母排序，旧的在前
            if (allHistory.length > MAX_HISTORY) {
                const toDelete = allHistory.slice(0, allHistory.length - MAX_HISTORY);
                toDelete.forEach(f => {
                    fs.unlinkSync(path.join(historyDir, f));
                    logger.info(`History cleanup: deleted ${f}`);
                });
            }

            return true;
        };

        // 保存单个脚本（比对 → 归档 → 写入）
        const saveScript = (scriptKey, fileName, type) => {
            const content = scripts[scriptKey];
            if (!content) return;

            const filePath = path.join(scriptDir, fileName);

            // 比对：如果旧文件存在且内容无实质变化，跳过
            if (fs.existsSync(filePath)) {
                const oldContent = fs.readFileSync(filePath, 'utf8');
                if (normalizeForCompare(oldContent) === normalizeForCompare(content)) {
                    skippedFiles.push({ type, fileName, reason: '内容无变化' });
                    return;
                }
                // 有变化，归档旧版本
                const configVersion = req.body.configVersion || 'unknown';
                archiveOldScript(scriptDir, fileName, configVersion);
                archivedFiles.push({ type, fileName });
            }

            fs.writeFileSync(filePath, content, 'utf8');
            savedFiles.push({ type, fileName });
        };

        // 保存各类脚本（带版本归档）
        saveScript('ddl', `${safeTableName}_DDL.sql`, 'DDL');
        saveScript('fullLoad', `${safeTableName}_全量初始化.sql`, '全量初始化');
        saveScript('incremental', `${safeTableName}_增量加载.sql`, '增量加载');
        saveScript('fdl', `${safeTableName}_FDL节点.sql`, 'FDL节点');
        saveScript('sync', `${safeTableName}_同步脚本.sql`, '同步脚本');
        saveScript('quality', `${safeTableName}_质量规则.sql`, '质量规则');

        // 只在有实际保存或归档时更新数据库记录
        if (savedFiles.length > 0) {
            await dbRunAsync(
                'UPDATE data_models SET script_path = ?, script_saved_at = datetime("now", "localtime"), script_saved_by = ?, script_modified = 0, script_modified_by = NULL, script_modified_at = NULL WHERE id = ?',
                [scriptPath, userName, id]
            );
        }

        const logParts = [];
        if (savedFiles.length) logParts.push(`saved: ${savedFiles.map(f => f.type).join(', ')}`);
        if (archivedFiles.length) logParts.push(`archived: ${archivedFiles.map(f => f.type).join(', ')}`);
        if (skippedFiles.length) logParts.push(`skipped: ${skippedFiles.map(f => f.type).join(', ')}`);
        logger.info(`Scripts for model ${id} (${tableName}) by ${user.username}: ${logParts.join(' | ')}`);

        res.json({
            success: true,
            message: savedFiles.length > 0
                ? `已保存 ${savedFiles.length} 个脚本${archivedFiles.length ? `（${archivedFiles.length} 个旧版本已归档）` : ''}`
                : `所有脚本内容无变化，无需保存`,
            scriptPath,
            savedFiles,
            archivedFiles,
            skippedFiles,
            taskId: task?.id || null
        });
    } catch (err) {
        logger.error('Save scripts error:', err.message);
        res.status(500).json({ error: '保存脚本失败: ' + err.message });
    }
});

// 获取模型已保存的脚本列表
app.get('/api/models/:id/scripts', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const model = await dbGetAsync('SELECT table_name, script_path, script_saved_at, script_saved_by FROM data_models WHERE id = ?', [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (!model.script_path) {
            return res.json({ scripts: [], savedAt: null, savedBy: null });
        }

        const scriptDir = path.join(UPLOAD_DIR, model.script_path);
        if (!fs.existsSync(scriptDir)) {
            return res.json({ scripts: [], savedAt: model.script_saved_at, savedBy: model.script_saved_by });
        }

        // 列出目录下所有 .sql 文件
        const files = fs.readdirSync(scriptDir).filter(f => f.endsWith('.sql'));
        const scripts = files.map(fileName => ({
            fileName,
            filePath: `${model.script_path}/${fileName}`,
            downloadUrl: `/uploads/${model.script_path}/${fileName}`
        }));

        res.json({
            scripts,
            savedAt: model.script_saved_at,
            savedBy: model.script_saved_by
        });
    } catch (err) {
        logger.error('Get scripts error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 更新脚本修改标记（前端批量保存后同步状态）
app.put('/api/models/:id/script-modified', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { modified } = req.body;
    const user = req.user;
    const userName = user.display_name || user.username;

    try {
        // 业务权限检查：admin/publisher OR tech_owner OR 当前活跃任务 owner
        const model = await dbGetAsync('SELECT id, tech_owner, created_by_id FROM data_models WHERE id = ?', [id]);
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }
        const latestOwnerId = await getLatestActiveTaskOwnerId(id);
        if (!canOperateModel(req.user, model, latestOwnerId)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、当前任务负责人或管理员可以更新脚本状态' });
        }

        if (modified) {
            await dbRunAsync(
                'UPDATE data_models SET script_modified = 1, script_modified_by = ?, script_modified_at = datetime("now", "localtime") WHERE id = ?',
                [userName, id]
            );
        } else {
            await dbRunAsync(
                'UPDATE data_models SET script_modified = 0, script_modified_by = NULL, script_modified_at = NULL WHERE id = ?',
                [id]
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 编辑并保存脚本内容（人工修改）
app.put('/api/models/:id/edit-script', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    const { fileName, content, autoSave } = req.body;
    const user = req.user;
    const userName = user.display_name || user.username;

    if (!fileName || content === undefined) {
        return res.status(400).json({ error: '缺少 fileName 或 content 参数' });
    }

    try {
        const model = await dbGetAsync(
            'SELECT id, table_name, script_path, script_modified, tech_owner, created_by_id FROM data_models WHERE id = ? AND is_deleted = 0',
            [id]
        );
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 业务权限检查：admin/publisher OR tech_owner OR 当前活跃任务 owner
        const latestOwnerId = await getLatestActiveTaskOwnerId(id);
        if (!canOperateModel(req.user, model, latestOwnerId)) {
            return res.status(403).json({ error: '权限不足：只有技术负责人、当前任务负责人或管理员可以编辑脚本' });
        }

        let scriptPath = model.script_path;
        if (!scriptPath) {
            // 自定义模式允许自动创建脚本目录
            const safeTableName = model.table_name.replace(/[\\/:*?"<>|]/g, '_');
            scriptPath = `${userName}/${safeTableName}`;
            await dbRunAsync(
                'UPDATE data_models SET script_path = ?, script_saved_at = datetime("now","localtime"), script_saved_by = ? WHERE id = ?',
                [scriptPath, userName, id]
            );
        }

        const scriptDir = path.join(UPLOAD_DIR, scriptPath);
        const filePath = path.join(scriptDir, fileName);

        // 安全检查：确保文件名不包含路径遍历
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ error: '非法文件名' });
        }

        // 读取旧内容（用于变更日志和内容对比）
        let beforeContent = null;
        if (fs.existsSync(filePath)) {
            beforeContent = fs.readFileSync(filePath, 'utf8');
        }

        // 对比内容：只有真正发生变化才写文件和记录
        const isNewFile = beforeContent === null;
        const contentChanged = isNewFile || beforeContent !== content;

        if (!contentChanged) {
            // 内容未变化，无需写文件和标记
            return res.json({ success: true, message: `脚本 ${fileName} 内容未变化，跳过保存`, fileName, changed: false });
        }

        // 写入新内容
        if (!fs.existsSync(scriptDir)) {
            fs.mkdirSync(scriptDir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf8');

        // 标记修改状态：仅当人工编辑（非 autoSave 批量备份）且修改已有文件时标记
        if (!isNewFile && !autoSave) {
            await dbRunAsync(
                'UPDATE data_models SET script_modified = 1, script_modified_by = ?, script_modified_at = datetime("now", "localtime") WHERE id = ?',
                [userName, id]
            );
        }

        // 写入变更日志：区分"初始化"和"编辑修改"
        const changeType = isNewFile ? 'script_init' : 'script_edit';
        const changeSummary = generateChangeSummary('UPDATE', null, null, changeType, fileName);
        insertModelChangeLog({
            modelId: model.id,
            modelName: model.table_name,
            action: isNewFile ? 'CREATE' : 'UPDATE',
            changeType,
            beforeValue: isNewFile ? null : { fileName, content: beforeContent },
            afterValue: { fileName, content },
            changeSummary,
            operatorId: user.id,
            operatorName: userName
        });

        logger.info(`Script edited for model ${id} (${model.table_name}), file: ${fileName}, by ${userName}`);

        res.json({
            success: true,
            message: `脚本 ${fileName} 已保存`,
            fileName,
            modifiedBy: userName,
            modifiedAt: new Date().toISOString()
        });
    } catch (err) {
        logger.error('Edit script error:', err.message);
        res.status(500).json({ error: '保存脚本失败: ' + err.message });
    }
});

// 获取单个脚本文件内容
app.get('/api/models/:id/script-content', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { fileName } = req.query;

    if (!fileName) {
        return res.status(400).json({ error: '缺少 fileName 参数' });
    }

    // 安全检查
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
        return res.status(400).json({ error: '非法文件名' });
    }

    try {
        const model = await dbGetAsync(
            'SELECT id, table_name, script_path, script_modified, script_modified_by, script_modified_at FROM data_models WHERE id = ? AND is_deleted = 0',
            [id]
        );
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (!model.script_path) {
            return res.json({ content: null, exists: false, modified: false });
        }

        const filePath = path.join(UPLOAD_DIR, model.script_path, fileName);

        if (!fs.existsSync(filePath)) {
            return res.json({ content: null, exists: false, modified: !!model.script_modified });
        }

        const content = fs.readFileSync(filePath, 'utf8');
        res.json({
            content,
            exists: true,
            modified: !!model.script_modified,
            modifiedBy: model.script_modified_by,
            modifiedAt: model.script_modified_at
        });
    } catch (err) {
        logger.error('Get script content error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 模型交付物状态检测 API ====================

app.get('/api/models/:id/dev-status', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const model = await dbGetAsync(
            'SELECT id, table_name, layer, config_mode, dim_config, script_path, status, script_modified, script_modified_by, script_modified_at FROM data_models WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)',
            [id]
        );
        if (!model) {
            return res.status(404).json({ error: '模型不存在' });
        }

        const layer = (model.layer || '').toLowerCase();
        const safeTableName = model.table_name.replace(/[\\/:*?"<>|]/g, '_');
        const deliverables = {};

        // 1. 检查字段配置（DIM/DWD 适用）
        if (['dim', 'dwd'].includes(layer)) {
            let configReady = false;
            let configDetail = '未配置';
            if (model.config_mode === 'custom') {
                configReady = true;
                configDetail = '自定义脚本模式（无需标准配置）';
            } else if (model.dim_config) {
                try {
                    const cfg = typeof model.dim_config === 'string' ? JSON.parse(model.dim_config) : model.dim_config;

                    // 计算字段数量（兼容三种配置结构）
                    // 1. ODS/DIM 标准模式：sourceTables[].fields[].selected
                    let fieldCount = (cfg.sourceTables || []).reduce((sum, t) => sum + (t.fields || []).filter(f => f.selected).length, 0);
                    // 2. DIM SCD 高级配置：scdConfig.fieldMappings + derivedFields
                    const scdFieldCount = (cfg.scdConfig?.fieldMappings || []).length + (cfg.scdConfig?.derivedFields || []).length;
                    if (scdFieldCount > fieldCount) fieldCount = scdFieldCount;
                    // 3. DWD 配置：selectedFields + derivedFields
                    const dwdFieldCount = (cfg.selectedFields || []).length + (cfg.derivedFields || []).length;
                    if (dwdFieldCount > fieldCount) fieldCount = dwdFieldCount;

                    const hasConfig = fieldCount > 0 || (cfg.sourceTables && cfg.sourceTables.length > 0 && cfg.scdConfig);
                    if (hasConfig && fieldCount > 0) {
                        configReady = true;
                        const extras = [];
                        const scdType = cfg.scdConfig?.scdType || cfg.scdType;
                        if (scdType) extras.push(scdType);
                        if (cfg.dwdConfig?.updateStrategy) extras.push(cfg.dwdConfig.updateStrategy === 'FULL_OVERWRITE' ? '全量覆盖' : cfg.dwdConfig.updateStrategy === 'INCREMENTAL_APPEND' ? '增量追加' : '分区覆盖');
                        configDetail = `${fieldCount} 个字段已定义` + (extras.length ? `，${extras.join('、')}` : '');
                    } else {
                        configDetail = '配置为空或无有效字段';
                    }
                } catch (e) {
                    configDetail = '配置解析异常';
                }
            }
            deliverables.config = { ready: configReady, detail: configDetail };
        }

        // 2. 检查 DDL 脚本（DIM/DWD 适用，ODS 无需）
        if (['dim', 'dwd'].includes(layer)) {
            let ddlReady = false;
            let ddlDetail = '未生成';
            if (model.script_path) {
                const ddlFileName = `${safeTableName}_DDL.sql`;
                const ddlPath = path.join(UPLOAD_DIR, model.script_path, ddlFileName);
                if (fs.existsSync(ddlPath)) {
                    const stat = fs.statSync(ddlPath);
                    if (stat.size > 0) {
                        ddlReady = true;
                        ddlDetail = `${ddlFileName} (${(stat.size / 1024).toFixed(1)}KB)`;
                    }
                }
            }
            // 标准配置模式 + 配置就绪 → DDL 可由平台自动生成，视为就绪
            if (!ddlReady && model.config_mode !== 'custom' && deliverables.config?.ready) {
                ddlReady = true;
                ddlDetail = '可自动生成（基于字段配置）';
            }
            deliverables.ddl = { ready: ddlReady, detail: ddlDetail };
        }

        // 3. 检查 ETL 脚本（DIM/DWD 适用，ODS 无需）
        if (['dim', 'dwd'].includes(layer)) {
            let etlReady = false;
            let etlDetail = '未生成';
            if (model.script_path) {
                const scriptDir = path.join(UPLOAD_DIR, model.script_path);
                if (fs.existsSync(scriptDir)) {
                    const etlFiles = fs.readdirSync(scriptDir).filter(f =>
                        f.endsWith('.sql') && !f.includes('_DDL') && !f.includes('_tabs_manifest')
                    );
                    if (etlFiles.length > 0) {
                        etlReady = true;
                        etlDetail = `${etlFiles.length} 个脚本文件`;
                    }
                }
            }
            // 标准配置模式 + 配置就绪 → ETL 可由平台自动生成，视为就绪
            if (!etlReady && model.config_mode !== 'custom' && deliverables.config?.ready) {
                etlReady = true;
                etlDetail = '可自动生成（基于字段配置）';
            }
            deliverables.etl = { ready: etlReady, detail: etlDetail };
        }

        // 4. 检查验收记录（可选项）
        const latestTest = await dbGetAsync(
            "SELECT overall_result, test_time FROM model_test_records WHERE model_id = ? AND (invalidated = 0 OR invalidated IS NULL) ORDER BY test_time DESC LIMIT 1",
            [id]
        );
        deliverables.validation = {
            ready: latestTest && ['pass', 'warn'].includes(latestTest.overall_result),
            detail: latestTest ? `${latestTest.overall_result === 'pass' ? '通过' : latestTest.overall_result === 'warn' ? '通过(有警告)' : '未通过'} (${latestTest.test_time})` : '未执行验收',
            optional: true
        };

        // 计算是否可提交（必要项全部就绪）
        // ODS 层无需 DDL/ETL 交付物（FDL 直接从源表同步），仅需数据量核对
        const requiredItems = ['dim', 'dwd'].includes(layer) ? ['ddl', 'etl'] : [];
        if (deliverables.config) requiredItems.push('config');
        const canSubmit = requiredItems.every(k => deliverables[k]?.ready);
        const missingItems = requiredItems.filter(k => !deliverables[k]?.ready);

        res.json({
            model: {
                table_name: model.table_name,
                layer: model.layer,
                config_mode: model.config_mode || 'standard',
                status: model.status,
                script_modified: !!model.script_modified,
                script_modified_by: model.script_modified_by || null,
                script_modified_at: model.script_modified_at || null
            },
            deliverables,
            canSubmit,
            missingItems
        });
    } catch (err) {
        logger.error('Dev-status check error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 管理员待办 API ====================

// 获取全部待办
app.get('/api/admin/todos', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT * FROM admin_todos ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        sort_order ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 新增待办
app.post('/api/admin/todos', authenticateToken, requireAdmin, (req, res) => {
    const { title, priority, category } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
    db.run(`INSERT INTO admin_todos (title, priority, category) VALUES (?, ?, ?)`,
        [title.trim(), priority || 'P1', category || '其他'],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        });
});

// 更新待办
app.put('/api/admin/todos/:id', authenticateToken, requireAdmin, (req, res) => {
    const { title, priority, category, status, sort_order } = req.body;
    const fields = [];
    const values = [];
    if (title !== undefined) { fields.push('title = ?'); values.push(title.trim()); }
    if (priority !== undefined) { fields.push('priority = ?'); values.push(priority); }
    if (category !== undefined) { fields.push('category = ?'); values.push(category); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
    if (fields.length === 0) return res.status(400).json({ error: '无更新字段' });
    fields.push("updated_at = datetime('now','localtime')");
    values.push(req.params.id);
    db.run(`UPDATE admin_todos SET ${fields.join(', ')} WHERE id = ?`, values, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: this.changes });
    });
});

// 删除待办
app.delete('/api/admin/todos/:id', authenticateToken, requireAdmin, (req, res) => {
    db.run(`DELETE FROM admin_todos WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

// ==================== 钉钉配置 API（数据协作模块 v2.0 §7.5）====================
// 凭证(AppKey/AppSecret/RobotCode) + platform_base_url 加密存 system_configs。
// 通知模块本身在 utils/dingtalk-notify.js,无依赖,通过本组 API 拿到解密后的凭证后调用。
// 3 个 endpoint:GET 取(密码字段掩码) / PUT 改(加密存) / POST 测连接(调真实 gettoken)

const DINGTALK_CONFIG_KEYS = ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code', 'platform_base_url'];

function readSystemConfig(key) {
    return new Promise((resolve, reject) => {
        db.get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [key], (err, row) => {
            if (err) return reject(err);
            if (!row || !row.config_value_encrypted) return resolve(null);
            try {
                resolve(decryptPassword(row.config_value_encrypted));
            } catch (e) {
                logger.error(`decrypt ${key} failed:`, e.message);
                resolve(null);
            }
        });
    });
}

// v1.78.1：开发/导出人提交后是否给 admin 发钉钉通知的总开关
// 默认关（配置缺失/非 'on' 一律视为关）——admin 主动到平台查看提交，现阶段不被动推送
// 恢复被动通知：把 system_configs.collab_notify_admin_on_submit 写成 'on'
async function isNotifyAdminOnSubmitEnabled() {
    try {
        const v = await readSystemConfig('collab_notify_admin_on_submit');
        return String(v || '').trim().toLowerCase() === 'on';
    } catch (e) {
        logger.warn(`[notify-switch] 读 collab_notify_admin_on_submit 失败，按"关"处理：${e.message}`);
        return false;
    }
}

function writeSystemConfig(key, value, user) {
    return new Promise((resolve, reject) => {
        const encrypted = value ? encryptPassword(value) : null;
        db.run(
            `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
             VALUES (?, ?, ?, ?, datetime('now','localtime'))
             ON CONFLICT(config_key) DO UPDATE SET
               config_value_encrypted = excluded.config_value_encrypted,
               updated_by = excluded.updated_by,
               updated_by_name = excluded.updated_by_name,
               updated_at = excluded.updated_at`,
            [key, encrypted, user && user.id, user && user.display_name],
            (err) => err ? reject(err) : resolve()
        );
    });
}

// GET /api/admin/dingtalk-config — 取当前配置(密码字段返回掩码,只暴露是否已配置)
app.get('/api/admin/dingtalk-config', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [appKey, appSecret, robotCode, platformBaseUrl] = await Promise.all(
            DINGTALK_CONFIG_KEYS.map(readSystemConfig)
        );
        // 安全约定:三类密钥永远不回明文,只回是否已配置;platform_base_url 是 URL 不敏感可回明文
        res.json({
            app_key: appKey ? '***' : '',
            app_secret: appSecret ? '***' : '',
            robot_code: robotCode ? '***' : '',
            platform_base_url: platformBaseUrl || '',
            configured: !!(appKey && appSecret && robotCode)
        });
    } catch (err) {
        logger.error('GET /api/admin/dingtalk-config 失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/dingtalk-config — 更新配置(加密存)
// 约定:前端只在用户改了的字段才传;未传或传空串的字段保持原值不动(避免误清空)
//      但 platform_base_url 例外——明文字段,前端可以显式传空串来清空
app.put('/api/admin/dingtalk-config', authenticateToken, requireAdmin, async (req, res) => {
    const { app_key, app_secret, robot_code, platform_base_url } = req.body || {};
    try {
        const updates = [];
        // 三类密钥:有传值且非掩码 → 加密更新;传空串或掩码 → 跳过(避免误覆盖)
        if (typeof app_key === 'string' && app_key && app_key !== '***') {
            updates.push(writeSystemConfig('dingtalk_app_key', app_key.trim(), req.user));
        }
        if (typeof app_secret === 'string' && app_secret && app_secret !== '***') {
            updates.push(writeSystemConfig('dingtalk_app_secret', app_secret.trim(), req.user));
        }
        if (typeof robot_code === 'string' && robot_code && robot_code !== '***') {
            updates.push(writeSystemConfig('dingtalk_robot_code', robot_code.trim(), req.user));
        }
        // platform_base_url 明文,显式传 string 即覆盖(包括空串)
        if (typeof platform_base_url === 'string') {
            updates.push(writeSystemConfig('platform_base_url', platform_base_url.trim(), req.user));
        }
        if (updates.length === 0) return res.status(400).json({ error: '无字段更新(密码字段为掩码 *** 不会被改写,请输入新值)' });

        await Promise.all(updates);
        // 凭证改了 → 清通知模块的 token 缓存,下次发通知会用新 secret 重取
        dingtalkNotify.clearCachedToken();
        res.json({ updated: updates.length });
    } catch (err) {
        logger.error('PUT /api/admin/dingtalk-config 失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/dingtalk-config/test — 测试连接
// 行为:用当前 DB 里存的凭证(不接受请求体里的明文)调真实 gettoken,验证可达性
//      返回 { ok: true } 或 { ok: false, error, errcode? }
app.post('/api/admin/dingtalk-config/test', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [appKey, appSecret] = await Promise.all([
            readSystemConfig('dingtalk_app_key'),
            readSystemConfig('dingtalk_app_secret')
        ]);
        if (!appKey || !appSecret) {
            return res.status(400).json({ ok: false, error: '请先保存 AppKey 和 AppSecret 再测试' });
        }
        // 测试前清缓存,确保是真实拿一次 token,不是命中前一次的成功缓存
        dingtalkNotify.clearCachedToken();
        try {
            await dingtalkNotify.getAccessToken(appKey, appSecret);
            res.json({ ok: true, message: '钉钉凭证验证通过,access_token 已成功获取' });
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            res.json({
                ok: false,
                error: cls.hint,
                errcode: cls.errcode,
                errmsg: cls.errmsg,
                reason: cls.reason
            });
        }
    } catch (err) {
        logger.error('POST /api/admin/dingtalk-config/test 失败:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ==================== 任务提示配置 API ====================

// 获取所有任务提示配置 (公开接口，无需登录)
app.get('/api/task-tips', (req, res) => {
    db.all("SELECT * FROM task_tips WHERE enabled = 1 ORDER BY sort_order", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // 解析 tips JSON 字符串
        const result = rows.map(row => ({
            ...row,
            tips: JSON.parse(row.tips || '[]')
        }));
        res.json(result);
    });
});

// 获取所有任务提示配置（管理员，包含禁用的）
app.get('/api/task-tips/all', authenticateToken, requireAdmin, (req, res) => {
    db.all("SELECT * FROM task_tips ORDER BY sort_order", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const result = rows.map(row => ({
            ...row,
            tips: JSON.parse(row.tips || '[]')
        }));
        res.json(result);
    });
});

// 更新任务提示配置 (管理员)
app.put('/api/task-tips/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { icon, title, tips, enabled } = req.body;

    if (!title) return res.status(400).json({ error: "标题不能为空" });
    if (!Array.isArray(tips)) return res.status(400).json({ error: "提示内容必须是数组" });

    const tipsJson = JSON.stringify(tips);

    db.run(
        "UPDATE task_tips SET icon = ?, title = ?, tips = ?, enabled = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        [icon || 'lightbulb', title, tipsJson, enabled ? 1 : 0, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: "配置不存在" });
            res.json({ message: "提示配置更新成功" });
        }
    );
});

// ==================== 域管理 API ====================

// 获取所有域 (需要登录)
app.get('/api/domains', authenticateToken, (req, res) => {
    // 只返回 active 状态的业务域（deprecated 的不显示）
    db.all("SELECT * FROM sys_domains WHERE status = 'active' ORDER BY code", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 添加域 (管理员)
app.post('/api/domains', authenticateToken, requireAdmin, (req, res) => {
    const { code, name, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: "Code and Name are required" });

    const stmt = db.prepare("INSERT INTO sys_domains (code, name, description) VALUES (?, ?, ?)");
    stmt.run(code.toLowerCase(), name, description, function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: "域代码已存在" });
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, message: "域添加成功" });
    });
    stmt.finalize();
});

// 更新域 (管理员) - 只允许修改名称、描述、状态，代码不可修改
app.put('/api/domains/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { name, description, status } = req.body;

    if (!name) return res.status(400).json({ error: "名称不能为空" });
    if (status && !['active', 'deprecated'].includes(status)) {
        return res.status(400).json({ error: "状态值无效" });
    }

    db.run(
        "UPDATE sys_domains SET name = ?, description = ?, status = ? WHERE id = ?",
        [name, description || '', status || 'active', id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: "域不存在" });
            res.json({ message: "域更新成功" });
        }
    );
});

// 删除域 (管理员)
app.delete('/api/domains/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM sys_domains WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "域已删除" });
    });
});

// ==================== 源系统管理 API ====================

// 获取所有源系统 (需要登录)
app.get('/api/source-systems', authenticateToken, (req, res) => {
    db.all("SELECT * FROM sys_source_systems ORDER BY code", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 添加源系统 (管理员)
app.post('/api/source-systems', authenticateToken, requireAdmin, (req, res) => {
    const { code, name, description } = req.body;
    if (!code || !name) return res.status(400).json({ error: "Code and Name are required" });

    const stmt = db.prepare("INSERT INTO sys_source_systems (code, name, description, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))");
    stmt.run(code.toUpperCase(), name, description, function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: "系统代码已存在" });
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, message: "源系统添加成功" });
    });
    stmt.finalize();
});

// 删除源系统 (管理员)
app.delete('/api/source-systems/:id', authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM sys_source_systems WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "源系统已删除" });
    });
});

// ==================== 个人工作台 API ====================
// 获取个人工作台数据
app.get('/api/my-workspace', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const userRole = req.user.role;
    const now = new Date();

    try {
        // 1. 我认领的任务（进行中）
        const myClaimedTasks = await dbAllAsync(`
            SELECT t.*,
                   dm.table_name as linked_model_name,
                   dm.table_comment as linked_model_comment,
                   dm.is_deleted as linked_model_is_deleted
            FROM task_pool t
            LEFT JOIN data_models dm ON t.linked_model_id = dm.id
            WHERE t.owner_id = ? AND t.status IN ('CLAIMED', 'ON_HOLD', 'TRANSFERRING')
            ORDER BY
                CASE WHEN t.priority = 'P0' THEN 0 WHEN t.priority = 'P1' THEN 1 ELSE 2 END,
                t.created_at DESC
        `, [userId]);

        // 2. 我发布的任务（管理员/发布者）
        let myPublishedTasks = [];
        if (userRole === 'admin' || userRole === 'publisher') {
            myPublishedTasks = await dbAllAsync(`
                SELECT t.*,
                       u.display_name as owner_name,
                       dm.table_name as linked_model_name,
                       dm.is_deleted as linked_model_is_deleted
                FROM task_pool t
                LEFT JOIN users u ON t.owner_id = u.id
                LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                WHERE t.created_by = ? AND t.status NOT IN ('ARCHIVED')
                ORDER BY t.created_at DESC
                LIMIT 50
            `, [userId]);
        }

        // 3. 待我验收的任务（我发布的且状态为DONE）- 仅管理员/发布者
        let pendingConfirmTasks = [];
        if (userRole === 'admin' || userRole === 'publisher') {
            pendingConfirmTasks = await dbAllAsync(`
                SELECT t.*,
                       u.display_name as owner_name,
                       dm.table_name as linked_model_name,
                       dm.is_deleted as linked_model_is_deleted
                FROM task_pool t
                LEFT JOIN users u ON t.owner_id = u.id
                LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                WHERE t.created_by = ? AND t.status = 'DONE'
                ORDER BY t.done_at DESC
            `, [userId]);
        }

        // 3.1 我的待审任务（我提交后等待验收的）- 所有用户
        const myPendingReviewTasks = await dbAllAsync(`
            SELECT t.*,
                   dm.table_name as linked_model_name,
                   dm.table_comment as linked_model_comment,
                   dm.is_deleted as linked_model_is_deleted
            FROM task_pool t
            LEFT JOIN data_models dm ON t.linked_model_id = dm.id
            WHERE t.owner_id = ? AND t.status = 'DONE'
            ORDER BY t.done_at DESC
        `, [userId]);

        // 4. 我的已完成任务（最近归档的，用于展示成就）
        const myCompletedTasks = await dbAllAsync(`
            SELECT t.*,
                   dm.table_name as linked_model_name,
                   dm.table_comment as linked_model_comment,
                   dm.is_deleted as linked_model_is_deleted
            FROM task_pool t
            LEFT JOIN data_models dm ON t.linked_model_id = dm.id
            WHERE t.owner_id = ? AND t.status = 'ARCHIVED'
            ORDER BY t.done_at DESC
            LIMIT 10
        `, [userId]);

        // 5. 转发给我的待处理请求
        const pendingTransfers = await dbAllAsync(`
            SELECT tt.*,
                   t.title as task_title,
                   t.category as task_category,
                   t.priority as task_priority,
                   u.display_name as from_user_name
            FROM task_transfers tt
            JOIN task_pool t ON tt.task_id = t.id
            JOIN users u ON tt.from_user_id = u.id
            WHERE tt.to_user_id = ? AND tt.status = 'pending'
            ORDER BY tt.created_at DESC
        `, [userId]);

        // 5. 统计数据 (使用 done_at 替代不存在的 archived_at)
        const stats = await dbGetAsync(`
            SELECT
                COUNT(CASE WHEN owner_id = ? AND status IN ('CLAIMED', 'ON_HOLD', 'TRANSFERRING') THEN 1 END) as in_progress,
                COUNT(CASE WHEN owner_id = ? AND status = 'DONE' THEN 1 END) as pending_confirm,
                COUNT(CASE WHEN owner_id = ? AND status = 'ARCHIVED'
                           AND done_at >= date('now', '-7 days') THEN 1 END) as completed_week,
                COUNT(CASE WHEN owner_id = ? AND status = 'ARCHIVED'
                           AND done_at >= date('now', 'start of month') THEN 1 END) as completed_month,
                COUNT(CASE WHEN owner_id = ? AND status = 'ARCHIVED' THEN 1 END) as completed_total,
                COUNT(CASE WHEN created_by = ? THEN 1 END) as published_count
            FROM task_pool
        `, [userId, userId, userId, userId, userId, userId]);

        // 计算工时和逾期状态
        const processTask = (task) => {
            let elapsed_hours = 0;
            let is_overdue = false;

            if (['CLAIMED', 'ON_HOLD', 'TRANSFERRING'].includes(task.status) && task.claimed_at) {
                const claimedAt = parseLocalDateTime(task.claimed_at);
                elapsed_hours = (now - claimedAt) / (1000 * 60 * 60);
                elapsed_hours = Math.round(elapsed_hours * 10) / 10;

                if (task.estimated_hours > 0 && elapsed_hours > task.estimated_hours) {
                    is_overdue = true;
                }
            }

            if (task.deadline && !['DONE', 'ARCHIVED'].includes(task.status)) {
                if (now > parseLocalDateTime(task.deadline)) {
                    is_overdue = true;
                }
            }

            return { ...task, elapsed_hours, is_overdue };
        };

        res.json({
            claimed: myClaimedTasks.map(processTask),
            published: myPublishedTasks.map(processTask),
            pending_confirm: pendingConfirmTasks,
            my_pending_review: myPendingReviewTasks,
            my_completed: myCompletedTasks,
            transfers: pendingTransfers,
            stats: {
                in_progress: stats.in_progress || 0,
                pending_confirm: stats.pending_confirm || 0,
                completed_week: stats.completed_week || 0,
                completed_month: stats.completed_month || 0,
                completed_total: stats.completed_total || 0,
                published_count: stats.published_count || 0
            }
        });
    } catch (err) {
        logger.error('获取个人工作台数据失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 工作台统计详情 API
app.get('/api/my-workspace/stats-detail', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const type = req.query.type;

    try {
        let sql = '';
        let params = [];

        switch (type) {
            case 'in_progress':
                // 进行中的任务
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    WHERE t.owner_id = ? AND t.status IN ('CLAIMED', 'ON_HOLD', 'TRANSFERRING')
                    ORDER BY t.claimed_at DESC
                `;
                params = [userId];
                break;

            case 'pending':
                // 待验收的任务（我提交的）
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    WHERE t.owner_id = ? AND t.status = 'DONE'
                    ORDER BY t.done_at DESC
                `;
                params = [userId];
                break;

            case 'week':
                // 本周完成的
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    WHERE t.owner_id = ? AND t.status = 'ARCHIVED'
                          AND t.done_at >= date('now', '-7 days')
                    ORDER BY t.done_at DESC
                `;
                params = [userId];
                break;

            case 'month':
                // 本月完成的
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    WHERE t.owner_id = ? AND t.status = 'ARCHIVED'
                          AND t.done_at >= date('now', 'start of month')
                    ORDER BY t.done_at DESC
                `;
                params = [userId];
                break;

            case 'total':
                // 累计完成的（最多显示50条）
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    WHERE t.owner_id = ? AND t.status = 'ARCHIVED'
                    ORDER BY t.done_at DESC
                    LIMIT 50
                `;
                params = [userId];
                break;

            case 'published':
                // 我发布的所有任务
                sql = `
                    SELECT t.*, dm.table_name as linked_model_name, dm.is_deleted as linked_model_is_deleted,
                           u.display_name as owner_name
                    FROM task_pool t
                    LEFT JOIN data_models dm ON t.linked_model_id = dm.id
                    LEFT JOIN users u ON t.owner_id = u.id
                    WHERE t.created_by = ?
                    ORDER BY t.created_at DESC
                    LIMIT 50
                `;
                params = [userId];
                break;

            default:
                return res.status(400).json({ error: '无效的统计类型' });
        }

        const tasks = await dbAllAsync(sql, params);
        res.json(tasks);

    } catch (err) {
        logger.error('获取统计详情失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== 全局错误处理中间件 ====================
// 404 处理 - 未匹配的路由
// ==================== 统计中心 API ====================

// 解析统计接口的时间范围参数：优先 start_date/end_date，其次 days，传 'all' 或缺失视为不限
// 注意：SQLite 数据用 datetime('now','localtime') 存北京时间字符串，
// 这里 days 转日期必须用本地时区格式化，否则北京时间凌晨 0-8 点会出现日期偏一天的偏差
function resolveStatsDateRange({ start_date, end_date, days }) {
    if (start_date && end_date) {
        return { startDate: start_date, endDate: end_date };
    }
    if (days && days !== 'all') {
        const n = parseInt(days, 10);
        if (Number.isFinite(n) && n > 0) {
            const fmt = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const end = new Date();
            const start = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
            return { startDate: fmt(start), endDate: fmt(end) };
        }
    }
    return { startDate: null, endDate: null };
}

// 6.1 统计汇总数据
app.get('/api/statistics/summary', authenticateToken, (req, res) => {
    const { startDate, endDate } = resolveStatsDateRange(req.query);

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
        dateFilter = `AND created_at BETWEEN ? AND ?`;
        params.push(startDate, endDate + ' 23:59:59');
    }

    const sql = `
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_count,
            SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as claimed_count,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done_count,
            SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) as archived_count,
            SUM(CASE WHEN status = 'ON_HOLD' THEN 1 ELSE 0 END) as hold_count,
            SUM(CASE WHEN status = 'TRANSFERRING' THEN 1 ELSE 0 END) as transferring_count,
            ROUND(AVG(CASE WHEN actual_hours > 0 THEN actual_hours / 3600.0 END), 1) as avg_hours,
            ROUND(AVG(CASE WHEN estimated_hours > 0 AND actual_hours > 0
                THEN (actual_hours / 3600.0 - estimated_hours) / estimated_hours * 100 END), 1) as avg_deviation
        FROM task_pool
        WHERE 1=1 ${dateFilter}
    `;

    db.get(sql, params, (err, row) => {
        if (err) {
            logger.error('统计汇总查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }

        // 计算完成率
        const completed = (row.done_count || 0) + (row.archived_count || 0);
        const inProgress = completed + (row.claimed_count || 0) + (row.transferring_count || 0);
        const completionRate = inProgress > 0 ? Math.round(completed / inProgress * 100) : 0;

        res.json({
            total: row.total || 0,
            open: row.open_count || 0,
            claimed: row.claimed_count || 0,
            done: row.done_count || 0,
            archived: row.archived_count || 0,
            hold: row.hold_count || 0,
            transferring: row.transferring_count || 0,
            completionRate,
            avgHours: row.avg_hours || 0,
            avgDeviation: row.avg_deviation || 0
        });
    });
});

// 6.2 任务趋势数据 (按日/周统计)
app.get('/api/statistics/trend', authenticateToken, (req, res) => {
    const { group_by = 'day' } = req.query;
    const resolved = resolveStatsDateRange(req.query);

    // 默认最近30天（trend 接口无论是否传参都需要日期范围用于 BETWEEN）
    const defaultEnd = new Date().toISOString().split('T')[0];
    const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const startDate = resolved.startDate || defaultStart;
    const endDate = resolved.endDate || defaultEnd;

    // 按日期分组
    const dateFormat = group_by === 'week' ? '%Y-W%W' : '%Y-%m-%d';

    const sql = `
        SELECT
            strftime('${dateFormat}', created_at) as date,
            COUNT(*) as created,
            SUM(CASE WHEN status IN ('DONE', 'ARCHIVED') THEN 1 ELSE 0 END) as completed
        FROM task_pool
        WHERE created_at BETWEEN ? AND ?
        GROUP BY strftime('${dateFormat}', created_at)
        ORDER BY date
    `;

    db.all(sql, [startDate, endDate + ' 23:59:59'], (err, rows) => {
        if (err) {
            logger.error('趋势数据查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }

        // 补充完成时间统计
        const completedSql = `
            SELECT
                strftime('${dateFormat}', done_at) as date,
                COUNT(*) as completed_at_date
            FROM task_pool
            WHERE done_at BETWEEN ? AND ?
                AND status IN ('DONE', 'ARCHIVED')
            GROUP BY strftime('${dateFormat}', done_at)
            ORDER BY date
        `;

        db.all(completedSql, [startDate, endDate + ' 23:59:59'], (err2, completedRows) => {
            if (err2) {
                logger.error('完成趋势查询失败:', err2);
                return res.status(500).json({ error: '查询失败' });
            }

            // 合并数据：需要包含所有日期（创建或完成）
            const createdMap = {};
            const completedMap = {};

            rows.forEach(r => { createdMap[r.date] = r.created; });
            completedRows.forEach(r => { completedMap[r.date] = r.completed_at_date; });

            // 合并所有日期
            const allDates = new Set([...Object.keys(createdMap), ...Object.keys(completedMap)]);
            const sortedDates = Array.from(allDates).sort();

            const result = sortedDates.map(date => ({
                date: date,
                created: createdMap[date] || 0,
                completed: completedMap[date] || 0
            }));

            res.json(result);
        });
    });
});

// 6.3 团队产能排行
app.get('/api/statistics/team', authenticateToken, (req, res) => {
    const { startDate, endDate } = resolveStatsDateRange(req.query);

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
        dateFilter = `AND done_at BETWEEN ? AND ?`;
        params.push(startDate, endDate + ' 23:59:59');
    }

    const sql = `
        SELECT
            owner,
            COUNT(*) as completed_count,
            ROUND(SUM(actual_hours / 3600.0), 1) as total_hours,
            ROUND(AVG(actual_hours / 3600.0), 1) as avg_hours,
            SUM(CASE WHEN category = 'ODS_SYNC' THEN 1 ELSE 0 END) as ods_count,
            SUM(CASE WHEN category = 'DIM_DEV' THEN 1 ELSE 0 END) as dim_count,
            SUM(CASE WHEN category = 'DWD_DEV' THEN 1 ELSE 0 END) as dwd_count,
            SUM(CASE WHEN category = 'ADS_RPT' THEN 1 ELSE 0 END) as ads_count,
            SUM(CASE WHEN category = 'DATA_FIX' THEN 1 ELSE 0 END) as fix_count
        FROM task_pool
        WHERE status IN ('DONE', 'ARCHIVED')
            AND owner IS NOT NULL
            AND owner != ''
            ${dateFilter}
        GROUP BY owner
        ORDER BY completed_count DESC, total_hours ASC
        LIMIT 20
    `;

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('团队产能查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }
        res.json(rows);
    });
});

// 6.4 任务类型分布
app.get('/api/statistics/category', authenticateToken, (req, res) => {
    const { startDate, endDate } = resolveStatsDateRange(req.query);

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
        dateFilter = `AND created_at BETWEEN ? AND ?`;
        params.push(startDate, endDate + ' 23:59:59');
    }

    const sql = `
        SELECT
            category,
            COUNT(*) as count,
            SUM(CASE WHEN status IN ('DONE', 'ARCHIVED') THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as in_progress,
            SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as pending,
            ROUND(AVG(CASE WHEN actual_hours > 0 THEN actual_hours / 3600.0 END), 1) as avg_hours
        FROM task_pool
        WHERE 1=1 ${dateFilter}
        GROUP BY category
        ORDER BY count DESC
    `;

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('类型分布查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }

        const categoryNames = {
            'ODS_SYNC': 'ODS同步',
            'DIM_DEV': 'DIM开发',
            'DWD_DEV': 'DWD开发',
            'ADS_RPT': 'ADS报表',
            'DATA_FIX': '数据运维'
        };

        const result = rows.map(r => ({
            category: r.category,
            name: categoryNames[r.category] || r.category,
            count: r.count,
            completed: r.completed,
            inProgress: r.in_progress,
            pending: r.pending,
            avgHours: r.avg_hours || 0
        }));

        res.json(result);
    });
});

// 6.5 优先级分布
app.get('/api/statistics/priority', authenticateToken, (req, res) => {
    const { startDate, endDate } = resolveStatsDateRange(req.query);

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
        dateFilter = `AND created_at BETWEEN ? AND ?`;
        params.push(startDate, endDate + ' 23:59:59');
    }

    const sql = `
        SELECT
            COALESCE(priority, 'P2') as priority,
            COUNT(*) as count,
            SUM(CASE WHEN status IN ('DONE', 'ARCHIVED') THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as in_progress
        FROM task_pool
        WHERE 1=1 ${dateFilter}
        GROUP BY COALESCE(priority, 'P2')
        ORDER BY priority
    `;

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('优先级分布查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }
        res.json(rows);
    });
});

// 6.6 工时统计
app.get('/api/statistics/hours', authenticateToken, (req, res) => {
    const { startDate, endDate } = resolveStatsDateRange(req.query);

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
        dateFilter = `AND done_at BETWEEN ? AND ?`;
        params.push(startDate, endDate + ' 23:59:59');
    }

    const sql = `
        SELECT
            ROUND(SUM(actual_hours / 3600.0), 1) as total_actual,
            ROUND(SUM(estimated_hours), 1) as total_estimated,
            ROUND(AVG(actual_hours / 3600.0), 1) as avg_actual,
            ROUND(AVG(estimated_hours), 1) as avg_estimated,
            COUNT(*) as task_count,
            SUM(CASE WHEN actual_hours / 3600.0 > estimated_hours THEN 1 ELSE 0 END) as overdue_count,
            SUM(CASE WHEN actual_hours / 3600.0 <= estimated_hours THEN 1 ELSE 0 END) as on_time_count
        FROM task_pool
        WHERE status IN ('DONE', 'ARCHIVED')
            AND actual_hours > 0
            ${dateFilter}
    `;

    db.get(sql, params, (err, row) => {
        if (err) {
            logger.error('工时统计查询失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }

        const onTimeRate = row.task_count > 0
            ? Math.round(row.on_time_count / row.task_count * 100)
            : 0;

        res.json({
            totalActual: row.total_actual || 0,
            totalEstimated: row.total_estimated || 0,
            avgActual: row.avg_actual || 0,
            avgEstimated: row.avg_estimated || 0,
            taskCount: row.task_count || 0,
            overdueCount: row.overdue_count || 0,
            onTimeCount: row.on_time_count || 0,
            onTimeRate
        });
    });
});

// ==================== 文档评论 API ====================

// 获取已审核的评论列表（公开）
app.get('/api/comments', (req, res) => {
    const { doc_filename, category } = req.query;

    let sql = `
        SELECT id, doc_filename, user_name, content, category,
               admin_reply, admin_reply_by, admin_reply_at, created_at
        FROM doc_comments
        WHERE status = 'approved'
    `;
    const params = [];

    if (doc_filename) {
        sql += ' AND doc_filename = ?';
        params.push(doc_filename);
    }
    if (category && category !== 'all') {
        sql += ' AND category = ?';
        params.push(category);
    }

    sql += ' ORDER BY created_at DESC';

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('获取评论失败:', err);
            return res.status(500).json({ error: '获取评论失败' });
        }
        res.json(rows);
    });
});

// 获取待审核评论列表（仅管理员）
app.get('/api/comments/pending', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const sql = `
        SELECT id, doc_filename, user_id, user_name, content, category, status, created_at
        FROM doc_comments
        WHERE status = 'pending'
        ORDER BY created_at ASC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            logger.error('获取待审核评论失败:', err);
            return res.status(500).json({ error: '获取待审核评论失败' });
        }
        res.json(rows);
    });
});

// 获取所有评论（仅管理员，用于管理）
app.get('/api/comments/all', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const { status } = req.query;
    let sql = `
        SELECT id, doc_filename, user_id, user_name, content, category, status,
               admin_reply, admin_reply_by, admin_reply_at, created_at
        FROM doc_comments
    `;
    const params = [];

    if (status && status !== 'all') {
        sql += ' WHERE status = ?';
        params.push(status);
    }

    sql += ' ORDER BY created_at DESC';

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('获取评论列表失败:', err);
            return res.status(500).json({ error: '获取评论列表失败' });
        }
        res.json(rows);
    });
});

// 提交评论（需登录）
app.post('/api/comments', authenticateToken, (req, res) => {
    const { doc_filename, content, category = 'general' } = req.body;

    if (!doc_filename || !content) {
        return res.status(400).json({ error: '文档路径和评论内容不能为空' });
    }

    if (content.length > 1000) {
        return res.status(400).json({ error: '评论内容不能超过1000字' });
    }

    const validCategories = ['general', 'feature', 'bug', 'experience'];
    if (!validCategories.includes(category)) {
        return res.status(400).json({ error: '无效的评论分类' });
    }

    const sql = `
        INSERT INTO doc_comments (doc_filename, user_id, user_name, content, category)
        VALUES (?, ?, ?, ?, ?)
    `;

    db.run(sql, [doc_filename, req.user.id, req.user.username, content, category], function(err) {
        if (err) {
            logger.error('提交评论失败:', err);
            return res.status(500).json({ error: '提交评论失败' });
        }

        logger.info(`用户 ${req.user.username} 提交了评论，待审核`);
        res.json({
            success: true,
            message: '评论提交成功，等待管理员审核',
            id: this.lastID
        });
    });
});

// 审核通过评论（仅管理员）
app.put('/api/comments/:id/approve', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const { id } = req.params;

    db.run('UPDATE doc_comments SET status = ? WHERE id = ?', ['approved', id], function(err) {
        if (err) {
            logger.error('审核评论失败:', err);
            return res.status(500).json({ error: '审核失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '评论不存在' });
        }
        logger.info(`管理员 ${req.user.username} 审核通过评论 #${id}`);
        res.json({ success: true, message: '评论已通过审核' });
    });
});

// 审核拒绝评论（仅管理员）
app.put('/api/comments/:id/reject', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const { id } = req.params;

    db.run('UPDATE doc_comments SET status = ? WHERE id = ?', ['rejected', id], function(err) {
        if (err) {
            logger.error('拒绝评论失败:', err);
            return res.status(500).json({ error: '操作失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '评论不存在' });
        }
        logger.info(`管理员 ${req.user.username} 拒绝评论 #${id}`);
        res.json({ success: true, message: '评论已拒绝' });
    });
});

// 回复评论（仅管理员）
app.put('/api/comments/:id/reply', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const { id } = req.params;
    const { reply } = req.body;

    if (!reply || reply.trim() === '') {
        return res.status(400).json({ error: '回复内容不能为空' });
    }

    if (reply.length > 500) {
        return res.status(400).json({ error: '回复内容不能超过500字' });
    }

    const sql = `
        UPDATE doc_comments
        SET admin_reply = ?, admin_reply_by = ?, admin_reply_at = datetime('now', 'localtime')
        WHERE id = ?
    `;

    db.run(sql, [reply.trim(), req.user.username, id], function(err) {
        if (err) {
            logger.error('回复评论失败:', err);
            return res.status(500).json({ error: '回复失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '评论不存在' });
        }
        logger.info(`管理员 ${req.user.username} 回复评论 #${id}`);
        res.json({ success: true, message: '回复成功' });
    });
});

// 删除评论（仅管理员）
app.delete('/api/comments/:id', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    const { id } = req.params;

    db.run('DELETE FROM doc_comments WHERE id = ?', [id], function(err) {
        if (err) {
            logger.error('删除评论失败:', err);
            return res.status(500).json({ error: '删除失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '评论不存在' });
        }
        logger.info(`管理员 ${req.user.username} 删除评论 #${id}`);
        res.json({ success: true, message: '评论已删除' });
    });
});

// 获取待审核评论数量（仅管理员）
app.get('/api/comments/pending-count', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '权限不足' });
    }

    db.get('SELECT COUNT(*) as count FROM doc_comments WHERE status = ?', ['pending'], (err, row) => {
        if (err) {
            logger.error('获取待审核数量失败:', err);
            return res.status(500).json({ error: '查询失败' });
        }
        res.json({ count: row.count });
    });
});

// ==================== 需求跟踪 API（v1.74.0 升级：问题跟踪 → 需求跟踪）====================

// 获取需求列表（支持筛选）
app.get('/api/issues', authenticateToken, requireIssueSchemaReady, (req, res) => {
    // C5（方案 T5 + v1.1 §4.5）：筛选含 requester_dept（"系统自动"单独分组）+ data_domain（报表按域预过滤）；
    //   M-6 不采纳 keyword 改名，保留 search 命名。
    const { status, type, source, priority, assigned_to, requester_dept, data_domain, search, sort = 'updated_at', order = 'DESC' } = req.query;
    let sql = 'SELECT * FROM issues WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (priority) { sql += ' AND priority = ?'; params.push(priority); }
    if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
    if (requester_dept) { sql += ' AND requester_dept = ?'; params.push(requester_dept); }
    if (data_domain) { sql += ' AND data_domain = ?'; params.push(data_domain); }
    if (search) { sql += ' AND (title LIKE ? OR description LIKE ? OR related_table LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    // C5 bug 修复：删死引用 'progress'——C1 重建 issues 表已移除 progress 列，留在白名单会让
    //   sort=progress 生成 `ORDER BY progress` 触发 SQLite no such column 报 500。
    const allowedSort = ['id', 'priority', 'status', 'type', 'updated_at', 'created_at'];
    const sortCol = allowedSort.includes(sort) ? sort : 'updated_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    if (sortCol === 'priority') {
        sql += ` ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END ${sortOrder}, updated_at DESC`;
    } else if (sortCol === 'status') {
        sql += ` ORDER BY CASE status WHEN '待处理' THEN 0 WHEN '处理中' THEN 1 WHEN '待验证' THEN 2 ELSE 3 END ${sortOrder}, updated_at DESC`;
    } else {
        sql += ` ORDER BY ${sortCol} ${sortOrder}`;
    }

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 创建需求（C3：viewer 自录 assigned_to 可空 + 选填字段 + 落 history 首行 + 不内嵌通知）
//   H-1：任意登录用户可录（viewer 自录），assigned_to 可空；05 L-1：viewer 创建后端强制 P2
//   M-8：assigned_to_name 后端查 users 表填（不信任入参）；H-1：POST 不发钉钉（通知走 §2.8 notify endpoint）
app.post('/api/issues', authenticateToken, requireIssueSchemaReady, async (req, res) => {
    try {
        const {
            title, raw_requirement, description, type, source, priority,
            requester_dept, requester_name, requester_phone, oa_number, deadline,
            data_domain, acceptance_url, assigned_to, related_table, error_time
        } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
        if (!type || !ISSUE_TYPES.includes(type)) return res.status(400).json({ error: '无效或缺失的需求类型' });
        if (source && !ISSUE_SOURCES.includes(source)) return res.status(400).json({ error: '无效的需求来源' });
        if (priority && !ISSUE_PRIORITIES.includes(priority)) return res.status(400).json({ error: '无效的优先级' });
        if (!requester_dept || !COLLAB_REQUESTER_DEPTS.includes(requester_dept)) return res.status(400).json({ error: '无效或缺失的业务方部门' });
        if (!requester_name || !requester_name.trim()) return res.status(400).json({ error: '业务方姓名不能为空' });
        // acceptance_url 选填：非空则须通过 sanitizeUrl（H-1 录入侧防线，与 builder 双层）。
        //   codex 10 L-1：落库用 sanitize 后的值（trim 后），不存原始值，避免两端空格致展示/比较不一致。
        let safeAcceptanceUrl = null;
        if (acceptance_url) {
            safeAcceptanceUrl = issueNotify.sanitizeUrl(acceptance_url);
            if (!safeAcceptanceUrl) {
                return res.status(400).json({ error: '预览/验收地址非法：仅支持 http/https 且不含特殊字符', code: 'INVALID_ACCEPTANCE_URL' });
            }
        }
        // data_domain 选填：空值落 NULL（05 M-1，展示侧 COALESCE 归"未分类"）
        const domainVal = (data_domain && String(data_domain).trim()) ? String(data_domain).trim() : null;
        // 05 L-1：viewer 创建后端强制 P2（防业务方自抬优先级）；非 viewer 用传入值，默认 P2
        const isViewer = req.user.role === 'viewer';
        const priorityVal = isViewer ? 'P2' : (priority || 'P2');

        // M-8：assigned_to 非空时后端查 users 表填 assigned_to_name（不信任前端入参）
        let assignedToId = null, assignedToName = null;
        if (assigned_to !== undefined && assigned_to !== null && assigned_to !== '') {
            if (isViewer) return res.status(403).json({ error: 'viewer 不能在录入时指派', code: 'VIEWER_CANNOT_ASSIGN' });
            const u = await dbGetAsync('SELECT id, display_name FROM users WHERE id = ?', [Number(assigned_to)]);
            if (!u) return res.status(400).json({ error: '指派目标用户不存在' });
            assignedToId = u.id; assignedToName = u.display_name;
        }

        const sql = `INSERT INTO issues
            (title, raw_requirement, description, type, source, data_domain, priority,
             requester_dept, requester_name, requester_phone, oa_number, deadline, acceptance_url,
             assigned_to, assigned_to_name, related_table, error_time, created_by, created_by_name)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        // codex 10 M-1：INSERT issue + history 首行包事务（对齐 collab BEGIN IMMEDIATE 范式，无 mutex——
        //   POST 是新增行无"同行状态机并发"，仅需原子性）；history 失败回滚，避免无首行历史的孤儿 issue。
        let issueId;
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            const result = await dbRunAsync(sql, [
                title.trim(), raw_requirement || '', description || '', type, source || '业务方', domainVal, priorityVal,
                requester_dept, requester_name.trim(), requester_phone || null, oa_number || null, deadline || null, safeAcceptanceUrl,
                assignedToId, assignedToName, related_table || null, error_time || null,
                req.user.id, req.user.display_name || req.user.username
            ]);
            issueId = result.lastID;
            // 落 issue_status_history 首行（from=NULL, to=待处理），开发过程时间线起点
            await dbRunAsync(
                `INSERT INTO issue_status_history (issue_id, from_status, to_status, reason, operator_id, operator_name)
                 VALUES (?, NULL, '待处理', NULL, ?, ?)`,
                [issueId, req.user.id, req.user.display_name || req.user.username]
            );
            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }

        logger.info(`用户 ${req.user.username} 创建需求 #${issueId}: ${title.trim()}`);
        res.json({ id: issueId });
    } catch (err) {
        logger.error('创建需求失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 获取需求详情（含评论）
app.get('/api/issues/:id', authenticateToken, requireIssueSchemaReady, (req, res) => {
    db.get('SELECT * FROM issues WHERE id = ?', [req.params.id], (err, issue) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!issue) return res.status(404).json({ error: '需求不存在' });

        db.all('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC', [req.params.id], (err2, comments) => {
            if (err2) return res.status(500).json({ error: err2.message });
            issue.comments = comments || [];
            // C6c（OP-1）：内联状态变更历史（倒序），供详情页"状态时间线"渲染——
            //   现 GET 只返 issue+comments 不含 history，详情页时间线无数据源；内联避免前端多一次请求。
            db.all(
                'SELECT id, from_status, to_status, reason, operator_id, operator_name, created_at FROM issue_status_history WHERE issue_id = ? ORDER BY id DESC',
                [req.params.id],
                (err3, history) => {
                    if (err3) return res.status(500).json({ error: err3.message });
                    issue.status_history = history || [];
                    res.json(issue);
                }
            );
        });
    });
});

// 编辑需求（C3：字段白名单更新 + preview_url→acceptance_url 过 sanitizeUrl；status/assign 走专用 endpoint）
app.put('/api/issues/:id', authenticateToken, requireIssueSchemaReady, requirePublisherOrAdmin, (req, res) => {
    const {
        title, raw_requirement, description, type, source, priority,
        requester_dept, requester_name, requester_phone, oa_number, deadline,
        data_domain, acceptance_url, related_table, error_time
    } = req.body;
    const fields = [];
    const values = [];

    if (title !== undefined) { if (!title.trim()) return res.status(400).json({ error: '标题不能为空' }); fields.push('title = ?'); values.push(title.trim()); }
    if (raw_requirement !== undefined) { fields.push('raw_requirement = ?'); values.push(raw_requirement || ''); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (type !== undefined) { if (!ISSUE_TYPES.includes(type)) return res.status(400).json({ error: '无效的需求类型' }); fields.push('type = ?'); values.push(type); }
    if (source !== undefined) { if (!ISSUE_SOURCES.includes(source)) return res.status(400).json({ error: '无效的需求来源' }); fields.push('source = ?'); values.push(source); }
    if (priority !== undefined) { if (!ISSUE_PRIORITIES.includes(priority)) return res.status(400).json({ error: '无效的优先级' }); fields.push('priority = ?'); values.push(priority); }
    if (requester_dept !== undefined) { if (!COLLAB_REQUESTER_DEPTS.includes(requester_dept)) return res.status(400).json({ error: '无效的业务方部门' }); fields.push('requester_dept = ?'); values.push(requester_dept); }
    if (requester_name !== undefined) { if (!requester_name.trim()) return res.status(400).json({ error: '业务方姓名不能为空' }); fields.push('requester_name = ?'); values.push(requester_name.trim()); }
    if (requester_phone !== undefined) { fields.push('requester_phone = ?'); values.push(requester_phone || null); }
    if (oa_number !== undefined) { fields.push('oa_number = ?'); values.push(oa_number || null); }
    if (deadline !== undefined) { fields.push('deadline = ?'); values.push(deadline || null); }
    if (data_domain !== undefined) { fields.push('data_domain = ?'); values.push((data_domain && String(data_domain).trim()) ? String(data_domain).trim() : null); }
    if (acceptance_url !== undefined) {
        let safeUrl = null;
        if (acceptance_url) {
            safeUrl = issueNotify.sanitizeUrl(acceptance_url);  // codex 10 L-1：落 sanitize 后的值
            if (!safeUrl) return res.status(400).json({ error: '预览/验收地址非法：仅支持 http/https 且不含特殊字符', code: 'INVALID_ACCEPTANCE_URL' });
        }
        fields.push('acceptance_url = ?'); values.push(safeUrl);
    }
    if (related_table !== undefined) { fields.push('related_table = ?'); values.push(related_table || null); }
    if (error_time !== undefined) { fields.push('error_time = ?'); values.push(error_time || null); }

    if (fields.length === 0) return res.status(400).json({ error: '无更新字段' });
    fields.push("updated_at = datetime('now','localtime')");
    values.push(req.params.id);

    db.run(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '需求不存在' });
        res.json({ updated: this.changes });
    });
});

// 状态流转
// 状态流转（C4：6 态状态机 + 双层权限 + reason 条件必填 + closed_at 处理 + UPDATE/history 同事务）
//   权限（§1.6）：被指派人(user)只能 待处理↔处理中↔待验证 三态间流转（接手/完成/验证退回）；
//                 终态决策（已关闭/已暂缓/已拒绝）和激活（已暂缓→待处理）仅 admin。
//   中间件 requireNonViewer 挡 viewer，admin/publisher/user 细分在 handler 内做。
app.put('/api/issues/:id/status', authenticateToken, requireIssueSchemaReady, requireNonViewer, async (req, res) => {
    const id = req.params.id;
    try {
        const { status, last_transition_reason } = req.body;
        if (!status || !ISSUE_STATUSES.includes(status)) return res.status(400).json({ error: '无效的状态' });

        const issue = await dbGetAsync('SELECT id, status, assigned_to, type FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });
        const fromStatus = issue.status;

        // ① 状态机转换合法性（放行闸门）
        const allowed = ISSUE_STATUS_TRANSITIONS[fromStatus];
        if (!allowed || !allowed.includes(status)) {
            return res.status(400).json({ error: `不能从「${fromStatus}」转为「${status}」`, code: 'INVALID_TRANSITION' });
        }

        // ② 操作主体权限（§1.6）
        const isAdmin = req.user.role === 'admin';
        const isAssignee = issue.assigned_to && Number(issue.assigned_to) === Number(req.user.id);
        // 被指派人可做的转换：仅 待处理/待验证/已关闭→处理中（接手/退回回退）、处理中→待验证（完成）
        const ASSIGNEE_ALLOWED_TARGETS = ['处理中', '待验证'];
        if (!isAdmin) {
            // 终态决策 + 激活仅 admin
            if (['已关闭', '已暂缓', '已拒绝', '待处理'].includes(status)) {
                return res.status(403).json({ error: `「${status}」仅管理员可操作`, code: 'ADMIN_ONLY_TRANSITION' });
            }
            // 非 admin 走"被指派人"路径：必须是本人 + 目标在被指派人可做集合
            if (!isAssignee || !ASSIGNEE_ALLOWED_TARGETS.includes(status)) {
                return res.status(403).json({ error: '只有被指派人或管理员可推进此状态', code: 'NOT_ASSIGNEE' });
            }
        }

        // ③ reason 条件必填（§2.3）：进入 已关闭/已暂缓/已拒绝 必填；待验证→处理中（退回）必填；
        //    正常推进（待处理/已关闭→处理中=接手/重开、处理中→待验证）不强制（§0.8 L-3 空 reason 不当异常）。
        // codex 12 M-2：先类型归一（非字符串当空，防 .trim 报错 500）+ 长度校验提到分支外（非必填超长也拦）。
        const reason = (typeof last_transition_reason === 'string' ? last_transition_reason.trim() : '');
        if (reason.length > 500) return res.status(400).json({ error: '原因/说明不超过 500 字', code: 'REASON_TOO_LONG' });
        const isReturnToProcessing = (status === '处理中' && fromStatus === '待验证');  // 退回（靠 from 区分，非首次接手/重开）
        const reasonRequired = ['已关闭', '已暂缓', '已拒绝'].includes(status) || isReturnToProcessing;
        if (reasonRequired && !reason) {
            const label = status === '已关闭' ? '完成说明（实际交付了什么/验收依据）' : '变更原因';
            return res.status(400).json({ error: `转为「${status}」必须填写${label}`, code: 'REASON_REQUIRED' });
        }
        const reasonVal = reason || null;

        // ④ closed_at 处理（§2.3 总表，已拒绝也落=用户拍板对齐方案）：
        //    进入 已关闭/已拒绝 → now；进入 处理中（含重开/退回/接手）/ 待处理（激活）→ 清 NULL；进入 已暂缓 → 不动（保持 NULL）
        let closedAtSql;
        if (status === '已关闭' || status === '已拒绝') closedAtSql = "datetime('now','localtime')";
        else if (status === '处理中' || status === '待处理') closedAtSql = 'NULL';
        else closedAtSql = 'closed_at';  // 已暂缓：保持原值（本就 NULL）

        // ⑤ 重开重置业务方完成通知字段（§0.6 M-2）：已关闭→处理中（重开）时清 requester_notify_*
        const isReopen = (status === '处理中' && fromStatus === '已关闭');
        const reopenResetSql = isReopen
            ? `, requester_notify_status='not_sent', requester_notified_at=NULL, requester_notify_message_key=NULL, requester_notify_error=NULL, requester_read_at=NULL`
            : '';

        // ⑥ 模型硬闸门占位（v1.1 §2.3）：type='看板/报表需求' 且进入处理中时校验关联模型——
        //    ensureReportModelGate + issue_models 表属第二段 C9，第一段 v1.74.0 不实现，C9 在此事务内补调用。

        // ⑦ UPDATE + history INSERT 同事务（对齐 collab 裸 BEGIN IMMEDIATE 范式，server.js:13393；不套 exporter mutex——
        //    issue 单行状态转移，双条件 UPDATE 守卫 + changes 检查已足够防并发重复推进，无跨行副作用）
        // codex 12 H-1：非 admin 的 UPDATE 额外守卫 assigned_to=req.user.id——堵"读到自己是负责人后被 admin 改派、
        //   原负责人仍能推进"的竞态（权限校验在事务外，守卫把 assigned_to 纳入并发不变量）。
        const assigneeGuardSql = isAdmin ? '' : ' AND assigned_to = ?';
        const updParams = isAdmin
            ? [status, reasonVal, id, fromStatus]
            : [status, reasonVal, id, fromStatus, req.user.id];
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            // 双条件 UPDATE 守卫（MEMORY 状态机三件套）：WHERE id + status=旧状态（+非admin时 assigned_to），防 SELECT 与 UPDATE 间被并发改
            const upd = await dbRunAsync(
                `UPDATE issues SET status = ?, last_transition_reason = ?,
                        closed_at = ${closedAtSql}${reopenResetSql},
                        updated_at = datetime('now','localtime')
                  WHERE id = ? AND status = ?${assigneeGuardSql}`,
                updParams
            );
            if (!upd || upd.changes !== 1) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({ error: '需求状态或负责人已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' });
            }
            // history INSERT（append-only，from→to + 本次 reason + operator=req.user）
            await dbRunAsync(
                `INSERT INTO issue_status_history (issue_id, from_status, to_status, reason, operator_id, operator_name)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [id, fromStatus, status, reasonVal, req.user.id, req.user.display_name || req.user.username]
            );
            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }

        logger.info(`用户 ${req.user.username} 将需求 #${id} 状态 ${fromStatus}→${status}`);
        res.json({ message: '状态已更新', status });
    } catch (err) {
        logger.error('状态流转失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 指派 / 改派（C3 H-1+H-3：只更新负责人 + 写 pending_reassign_*，不内嵌通知；通知走 §2.8 notify-reassign）
//   M-8：assigned_to_name 后端查 users 表填，不信任入参；改派时记录"原→新"供 notify-reassign 读取
// v1.75.0 C2 改人守卫（方案 §4 C2 + 编码前真相核实修正 + codex 39 审 H-1/M-1/L-1）：
//   现有 endpoint 不支持取消指派（传 null→400）+ 首派前 notify 必 not_sent，故四象限只 3 个分支可达——
//   ① 首派（null→非空，notify 必 not_sent）/ ② 改派（非空→非空）/ ③ 未变（相同 id，下方已拦）。
//   守卫边界（用户拍板）：仅当 notify_status='sent'（已成功通知开发后又改人）才走"重置链路"——
//   重置开发侧 notify_* + 清 pending_reassign + 写 is_system 系统评论（这是 notify-reassign 覆盖不到的
//   "通知后反悔改人"缺口）；notify_status 非 sent（not_sent/failed，还没成功通知就改人）→ 维持现有写
//   pending_reassign 逻辑不动（pending 锚点照常给 notify-reassign 用）。两路按 notify_status 分流，不冲突。
// codex 39 审修订（用户全按）：
//   H-1：requireIssueV1750SchemaReady **不挂路由级**（否则迁移失败时首派/未通知改派/未变这些不写 is_system
//        的既有路径也被挡 503，扩大故障面）——下沉到 reset 分支内判定，只有真要写 is_system 才检查 readiness。
//   M-1/L-1：脏状态归一化——hasRealAssignee 用 Number(assigned_to)>0（排除 NULL/0 占位，对齐 collab
//        developer_id>0 范式）；脏状态"无真实负责人却 notify=sent"（!hasRealAssignee && wasNotified）也纳入
//        重置链路顺手清理（方案 §8 约束②显式兜底，不交给实现自行猜测）。
app.put('/api/issues/:id/assign', authenticateToken, requireIssueSchemaReady, requirePublisherOrAdmin, async (req, res) => {
    const id = req.params.id;
    try {
        const { assigned_to } = req.body;
        // 不支持取消指派（传 null 拒绝）——取消指派无业务场景，且会让 pending_reassign 语义混乱
        // （方案四象限"非空→null 取消指派""null→null 空转"在此被 400 拦截，endpoint 层不可达，不实现这两分支）
        if (assigned_to === undefined || assigned_to === null || assigned_to === '') {
            return res.status(400).json({ error: '必须指定被指派人', code: 'ASSIGN_TARGET_REQUIRED' });
        }
        // v1.75.0 C2：多读 notify_status（判"已通知后改人"）；read_at/notified_at 等随重置一起清
        const issue = await dbGetAsync('SELECT id, assigned_to, assigned_to_name, notify_status FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });

        const u = await dbGetAsync('SELECT id, display_name FROM users WHERE id = ?', [Number(assigned_to)]);
        if (!u) return res.status(400).json({ error: '指派目标用户不存在' });

        // ③ 未变（相同 id）→ 幂等不重复写（可达分支之一）。注意用 hasRealAssignee 口径避免 0 占位误判。
        const hasRealAssignee = Number(issue.assigned_to) > 0;        // L-1：排除 NULL/0 占位，0 非合法 user_id
        if (hasRealAssignee && Number(issue.assigned_to) === u.id) {
            return res.json({ updated: 0, message: '负责人未变化' });
        }

        // v1.75.0 C2 分流（codex 39 M-1/L-1 修订）：reset 链路触发条件 = 已成功通知过（notify_status='sent'）
        //   且（正常改派 hasRealAssignee=true，或脏状态：无真实负责人却 notify=sent）。即只要"已通知 + 负责人将变"
        //   就重置——hasRealAssignee 时是正常"通知后改人"，!hasRealAssignee 时是脏状态（assigned_to 空/0 但已 sent，
        //   §8 约束②显式兜底纳入重置清理，使其回到干净态）。两种都需重置 notify_*，统一走 reset 链路。
        const wasNotified = issue.notify_status === 'sent';           // 已成功通知开发过
        const needResetGuard = wasNotified;                           // 已通知 + 负责人将变（未变已在上方拦截）→ 必重置

        if (needResetGuard) {
            // ── 重置链路：重置开发侧 notify_* + 清 pending_reassign + 写系统评论（同一事务）──
            //   字段隔离：只清开发侧 notify_*（notify_status/notified_at/notify_message_key/read_at/notify_error）；
            //   业务方 requester_notify_* 绝不碰（物理隔离）。重置后新负责人回到"未通知"态，admin 需重新点通知。
            // H-1：reset 链路要写 issue_comments.is_system，此处才检查 v1.75.0 readiness（下沉，不挡其他分支）。
            if (ISSUE_V1750_SCHEMA_STATE.error || !ISSUE_V1750_SCHEMA_STATE.ready) {
                return res.status(503).json({
                    error: '需求跟踪 v1.75.0 优化功能（改人留痕）暂不可用：新增字段未就绪，请稍后重试或联系管理员',
                    detail: ISSUE_V1750_SCHEMA_STATE.error || 'initializing',
                    code: 'ISSUE_V1750_SCHEMA_NOT_READY'
                });
            }
            const fromLabel = hasRealAssignee ? (issue.assigned_to_name || '未知') : '未指派';
            const sysComment = `🔄【系统】负责人由「${fromLabel}」改为「${u.display_name}」，原通知已失效，请重新通知新负责人。`;
            await dbRunAsync('BEGIN IMMEDIATE');
            try {
                await dbRunAsync(
                    `UPDATE issues SET assigned_to = ?, assigned_to_name = ?,
                            notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL,
                            read_at = NULL, notify_error = NULL,
                            pending_reassign_from_id = NULL, pending_reassign_from_name = NULL,
                            pending_reassign_to_id = NULL, pending_reassign_to_name = NULL,
                            reassigned_at = datetime('now','localtime'),
                            updated_at = datetime('now','localtime')
                     WHERE id = ?`,
                    [u.id, u.display_name, id]
                );
                // 系统评论固定 user_name='系统'（前端展示用），user_id 记操作者便于追溯；is_system=1 是判别字段（复审 low-1 注释补充）
                await dbRunAsync(
                    `INSERT INTO issue_comments (issue_id, user_id, user_name, content, is_system)
                     VALUES (?, ?, '系统', ?, 1)`,
                    [id, Number(req.user.id), sysComment]
                );
                await dbRunAsync('COMMIT');
            } catch (txErr) {
                try { await dbRunAsync('ROLLBACK'); } catch (_) {}
                throw txErr;
            }
            logger.info(`用户 ${req.user.username} 改派需求 #${id} 给 ${u.display_name}（原 ${fromLabel}，已通知→重置通知态 + 系统评论留痕${hasRealAssignee ? '' : '；⚠️脏状态兜底：原无真实负责人却 notify=sent'}）`);
            return res.json({ updated: 1, assigned_to: u.id, assigned_to_name: u.display_name, notify_reset: true });
        }

        // ① 首派（null→非空，notify 必 not_sent）/ ② 改派但未通知（not_sent/failed）→ 维持现有 pending_reassign 写入逻辑
        // ⚠️ 语义（codex 10 M-3）：pending_reassign_* 是**单字段覆盖式**，记录"最近一次改派的原→新"。
        //   若 admin 未点 notify-reassign 就连续改派（A→B→C），from 会被覆盖为 B、to=C，通知时只通知 B→C，
        //   A 不会收到"已转交"。这是**有意取舍**——未通知前的连续改派视为中间跳未生效，只通知最后有效负责人。
        //   内网 ≤10 人手动场景下合理（admin 通常指派后即通知）；前端文案需明确此行为（C6 待办）。
        //   若未来需通知所有曾被移出者，应改 append-only reassign log（C5/C6 扩展，本期不做）。
        await dbRunAsync(
            `UPDATE issues SET assigned_to = ?, assigned_to_name = ?,
                    pending_reassign_from_id = ?, pending_reassign_from_name = ?,
                    pending_reassign_to_id = ?, pending_reassign_to_name = ?,
                    reassigned_at = datetime('now','localtime'),
                    updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [u.id, u.display_name,
             // L-1：hasRealAssignee 归一化——0 占位/NULL 都写 null，from_id 不落 0 脏值（首派 from 为空亦走此）
             hasRealAssignee ? issue.assigned_to : null, hasRealAssignee ? (issue.assigned_to_name || null) : null,
             u.id, u.display_name,
             id]
        );
        logger.info(`用户 ${req.user.username} 指派需求 #${id} 给 ${u.display_name}（原 ${issue.assigned_to_name || '无'}）`);
        res.json({ updated: 1, assigned_to: u.id, assigned_to_name: u.display_name });
    } catch (err) {
        logger.error('指派需求失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// progress endpoint 已删除（C3：进度条管理被移除，方案 §0.5.5 删进度条；不再用 progress 字段）

// 删除需求（C3：显式删子表——对齐 collab DELETE 范式，M-9 偏离落地。
//   本项目未开 PRAGMA foreign_keys=ON，ON DELETE CASCADE 不自动生效，故按 collab 既有做法逐表删，
//   覆盖 issue_comments / issue_attachments / issue_status_history 三张子表 + 物理附件清理。）
app.delete('/api/issues/:id', authenticateToken, requireIssueSchemaReady, requireAdmin, async (req, res) => {
    const id = req.params.id;
    try {
        const issue = await dbGetAsync('SELECT id FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });

        // codex 10 M-2：4 表删除包事务，避免半删状态（先子表后主表，对齐 collab FK CASCADE 未生效手动删范式）
        // codex 11 复审 L-1：SELECT file_name 移入事务内（删子表前），使附件清单与实际删除行处同一写事务窗口，
        //   闭合"读清单后、获写锁前并发新增附件→孤儿物理文件"的极端边界。
        let result, atts = [];
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            atts = await dbAllAsync('SELECT file_name FROM issue_attachments WHERE issue_id = ?', [id]);
            await dbRunAsync('DELETE FROM issue_status_history WHERE issue_id = ?', [id]);
            await dbRunAsync('DELETE FROM issue_attachments WHERE issue_id = ?', [id]);
            await dbRunAsync('DELETE FROM issue_comments WHERE issue_id = ?', [id]);
            result = await dbRunAsync('DELETE FROM issues WHERE id = ?', [id]);
            if (!result || result.changes === 0) {
                await dbRunAsync('ROLLBACK');
                return res.status(404).json({ error: '需求不存在' });
            }
            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }

        // 物理附件清理（事务提交后做，最佳努力——失败只 warn 不阻断 DB 一致性；走 ALLOWED_FILE_DIRS 白名单）
        for (const a of atts) {
            try { safeDeleteFileSync(a.file_name, UPLOAD_DIR); }
            catch (e) { logger.warn(`[issue-delete] 需求 #${id} 附件物理删除失败 ${a.file_name}：${e.message}`); }
        }

        logger.info(`管理员 ${req.user.username} 删除需求 #${id}（含 ${atts.length} 个附件）`);
        res.json({ deleted: result.changes });
    } catch (err) {
        logger.error('删除需求失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 获取评论列表
app.get('/api/issues/:id/comments', authenticateToken, requireIssueSchemaReady, (req, res) => {
    db.all('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// ── C4a：录入附件 endpoint（v1.0.5 方案 §1.3a / §4.1）──────────────────────────
// 先行后传：POST /api/issues 先建 issue（纯 JSON），再调本子接口补传附件（无"创建前上传"）。
// 权限（用户拍板 viewer 例外）：不挂 requireNonViewer——viewer 可给「自己创建」的 issue 传录入附件
//   （对齐方案 §4 viewer 权限矩阵"可上传自己录入时附件"）；非 viewer 角色对任意 issue 放行。
// 复用 collab 范式：issueUpload(multer 实例) + multer-error→JSON 包装(对齐 server.js multer 错误中间件)
//   + cleanupPendingFiles(collabSubmitHelpers) + isPathSafe/safeDeleteFileSync(白名单)。
// GET 列表 / 上传 / 详情页下载（走静态服务 /uploads/issues/<名>）三件套。
// 可见性（codex C4a M-1 自核降级）：附件列表继承 issue 模块「内部透明」既定口径——
//   GET /api/issues/:id（详情含 comments）+ GET /api/issues（列表）均无 viewer 归属 ACL，
//   任意登录用户可见（内部工具，需求对团队透明）。附件读跟齐此口径，不单独加读 ACL，
//   避免「详情/评论能看、附件看不了」的割裂；viewer 归属仅约束写（上传，见 POST），读透明。
app.get('/api/issues/:id/attachments', authenticateToken, requireIssueSchemaReady, (req, res) => {
    // id 正整数校验（codex C4a L-2：与 POST 一致，区分"参数错误"vs"空列表"）
    if (!/^[1-9]\d*$/.test(req.params.id)) {
        return res.status(400).json({ error: 'id 必须是正整数' });
    }
    db.all(
        'SELECT id, issue_id, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name, created_at FROM issue_attachments WHERE issue_id = ? ORDER BY created_at ASC',
        [req.params.id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// 上传录入附件：multipart/form-data，field 名 'files'（单文件，前端逐个传）
app.post('/api/issues/:id/attachments', authenticateToken, requireIssueSchemaReady,
    // id 严格正整数校验（codex C4a H-1）——必须在 multer **之前**：multer 是前置中间件，destination
    //   用 req.params.id 拼 _pending 路径，若不先拦非法 id（含 ../分隔符/超长），文件会在落盘阶段
    //   写入非预期路径，等进 handler 校验时已落盘。前置拦截把路径约束放到落盘之前（纵深防御）。
    (req, res, next) => {
        if (!/^[1-9]\d*$/.test(req.params.id)) {
            return res.status(400).json({ error: 'id 必须是正整数' });
        }
        next();
    },
    // multer 错误捕获（对齐 collab submit 范式）——multer 前置中间件抛的 MulterError 走 Express
    //   error flow，handler 内 try/catch 接不到，故手动 invoke 并清理已落盘 pending 文件。
    (req, res, next) => {
        issueUpload.array('files', 1)(req, res, (err) => {
            if (!err) return next();
            const isMulterErr = err && err.name === 'MulterError';
            const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
            try { collabSubmitHelpers.cleanupPendingFiles(req.files, logger); } catch (_) { /* ignore */ }
            logger.warn(`[issue-attach] multer error: code=${code} msg=${err.message}`);
            return res.status(400).json({
                error: '上传文件失败',
                code,
                detail: isMulterErr ? err.message : (err.message || '上传过程异常'),
            });
        });
    },
    async (req, res) => {
        const idStr = req.params.id;
        // best-effort 删空 _pending/{id}/ 子目录（codex C4a L-1：避免空目录长期积累污染人工排查）。
        //   rmdir 仅删空目录，非空/不存在/失败一律忽略——不影响主流程。失败/成功路径都调一次。
        const rmPendingDirIfEmpty = () => {
            if (!/^[1-9]\d*$/.test(String(idStr))) return;
            try { fs.rmdirSync(path.join(ISSUE_PENDING_BASE, String(idStr))); } catch (_) { /* 非空或不存在，忽略 */ }
        };
        const cleanupPending = () => {
            try { collabSubmitHelpers.cleanupPendingFiles(req.files, logger); } catch (_) { /* ignore */ }
            rmPendingDirIfEmpty();
        };

        // id 严格正则（对齐 collab submit M1；防 req.params.id 裸入 SQL 的类型错配盲区；
        //   与前置 multer id 校验中间件双保险——本层兜底，理论上不会命中）
        if (!/^[1-9]\d*$/.test(idStr)) {
            cleanupPending();
            return res.status(400).json({ error: 'id 必须是正整数' });
        }
        const id = parseInt(idStr, 10);

        // multer 单文件：req.files 为数组（field 'files'），取第一个；无文件 → 400
        const file = Array.isArray(req.files) && req.files.length > 0 ? req.files[0] : null;
        if (!file) {
            cleanupPending();
            return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' });
        }

        try {
            // 先行后传 + viewer 例外：查 issue 存在 + created_by（viewer 仅能传自己创建的 issue）
            const issue = await dbGetAsync('SELECT id, created_by FROM issues WHERE id = ?', [id]);
            if (!issue) {
                cleanupPending();
                return res.status(404).json({ error: '需求不存在' });
            }
            const uploaderId = Number(req.user.id);
            if (!Number.isSafeInteger(uploaderId)) {
                cleanupPending();
                return res.status(400).json({ error: '上传人身份异常', code: 'INVALID_UPLOADER' });
            }
            if (req.user.role === 'viewer' && Number(issue.created_by) !== uploaderId) {
                cleanupPending();
                return res.status(403).json({ error: '只能为自己创建的需求上传附件', code: 'VIEWER_NOT_OWNER' });
            }

            // 物理落盘：_pending/{id}/<multer名> → uploads/issues/<multer名>（平铺 issues/ 子目录，不照搬 collab 版本化命名）
            //   file.filename 已含 ts+rand 防重名（issueStorage filename callback），直接复用作正式名。
            // M-2 固有窗口（codex C4a，最佳努力边界）：rename 成功后、INSERT 完成前若进程崩溃，DB 无记录
            //   但正式目录留孤儿文件。文件系统 rename 与 SQLite INSERT 无法组成真正原子事务，内网低并发
            //   下概率极低，不引入复杂事务化文件管理；靠 [collab-integrity] 巡检扩展覆盖 uploads/issues/
            //   做兜底（见 TODO：扩展启动期 integrity 巡检 orphan_file 扫描范围到 issues 目录）。
            const finalName = file.filename;
            const finalPath = path.join(ISSUE_UPLOAD_BASE, finalName);
            const relPath = path.join('issues', finalName).replace(/\\/g, '/'); // 入库相对路径，统一 / 分隔
            try {
                fs.renameSync(file.path, finalPath);
                rmPendingDirIfEmpty(); // L-1：rename 后 _pending/{id}/ 已空，顺手清空目录
            } catch (renameErr) {
                logger.error(`[issue-attach] 需求 #${id} 文件移动失败: ${renameErr.message}`);
                cleanupPending();
                return res.status(500).json({ error: '附件文件移动失败', code: 'FILE_MOVE_FAILED' });
            }

            // INSERT issue_attachments；uploaded_by 用 Number 归一化（不抄 comments 裸落库），
            //   uploaded_by_name 取 display_name||username；file_size/mime_type 防 undefined → ?? null。
            const uploaderName = req.user.display_name || req.user.username || `user#${uploaderId}`;
            const fileSize = (typeof file.size === 'number') ? file.size : null;
            const mimeType = (typeof file.mimetype === 'string' && file.mimetype.trim()) ? file.mimetype : null;
            try {
                const result = await dbRunAsync(
                    `INSERT INTO issue_attachments
                        (issue_id, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
                     VALUES (?,?,?,?,?,?,?)`,
                    [id, relPath, file.originalname, fileSize, mimeType, uploaderId, uploaderName]
                );
                logger.info(`用户 ${req.user.username} 为需求 #${id} 上传附件 ${file.originalname}（${relPath}）`);
                return res.json({
                    id: result.lastID,
                    issue_id: id,
                    file_name: relPath,
                    original_name: file.originalname,
                    file_size: fileSize,
                    mime_type: mimeType,
                });
            } catch (insertErr) {
                // INSERT 失败 → 已 rename 的正式文件成孤儿，回滚物理文件（防孤儿盲区）
                try { safeDeleteFileSync(relPath, UPLOAD_DIR); } catch (_) { /* best effort */ }
                logger.error(`[issue-attach] 需求 #${id} 附件入库失败，已回滚物理文件: ${insertErr.message}`);
                return res.status(500).json({ error: insertErr.message });
            }
        } catch (err) {
            cleanupPending();
            logger.error('上传录入附件失败:', err.message);
            return res.status(500).json({ error: err.message });
        }
    }
);

// 添加评论
app.post('/api/issues/:id/comments', authenticateToken, requireIssueSchemaReady, requireNonViewer, (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: '评论内容不能为空' });

    db.get('SELECT id FROM issues WHERE id = ?', [req.params.id], (err, issue) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!issue) return res.status(404).json({ error: '问题不存在' });

        db.run('INSERT INTO issue_comments (issue_id, user_id, user_name, content) VALUES (?, ?, ?, ?)',
            [req.params.id, req.user.id, req.user.display_name || req.user.username, content.trim()], function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                // 同时更新 issue 的 updated_at
                db.run(`UPDATE issues SET updated_at = datetime('now','localtime') WHERE id = ?`, [req.params.id]);
                res.json({ id: this.lastID });
            });
    });
});

// ==================== §2.8 需求跟踪钉钉通知 endpoint（C3：全手动触发）====================
// 复用 collab sendCollabDingtalkRaw 范式（取 config → getAccessToken → 反查 dingUserId → 发送 + token_expired 重试），
// 但发送层调 C2 的 issueNotify.sendIssueMarkdown（薄封装）。落库 notify_* 在 endpoint 内（与 collab 同构）。
//
// issue 版钉钉发送：targetUser={id,display_name,phone,dingtalk_user_id}；返回 {ok, message_key, status, body}
async function sendIssueDingtalkRaw(targetUser, title, markdown) {
    const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
    );
    if (!appKey || !appSecret || !robotCode) {
        return { ok: false, reason: 'no_config', body: { error: '钉钉配置未填写，请管理员先到系统配置填写凭证' } };
    }
    if (!targetUser.phone) {
        return { ok: false, reason: 'no_phone', body: { error: `${targetUser.display_name || 'user#' + targetUser.id} 未绑定手机号，无法推送钉钉` } };
    }
    let token;
    try {
        token = await dingtalkNotify.getAccessToken(appKey, appSecret);
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        return { ok: false, reason: cls.reason, body: { error: cls.hint } };
    }
    // 反查 dingtalk_user_id（缺失则按手机号查 + 回写 users，对齐 collab）
    let dingUserId = targetUser.dingtalk_user_id;
    if (!dingUserId) {
        try {
            dingUserId = await dingtalkNotify.getUserIdByMobile(token, targetUser.phone);
            await dbRunAsync('UPDATE users SET dingtalk_user_id = ? WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = \'\')', [dingUserId, targetUser.id]);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return { ok: false, reason: cls.reason, body: { error: '钉钉用户查询失败：' + cls.hint } };
        }
    }
    // 发送（调 C2 helper）；token_expired 伪重试一次
    let r = await issueNotify.sendIssueMarkdown({ token, robotCode, dingUserId: String(dingUserId).trim(), title, markdown });
    if (!r.success && r.reason === 'token_expired') {
        dingtalkNotify.clearCachedToken();
        try {
            const freshToken = await dingtalkNotify.getAccessToken(appKey, appSecret);
            r = await issueNotify.sendIssueMarkdown({ token: freshToken, robotCode, dingUserId: String(dingUserId).trim(), title, markdown });
        } catch (retryErr) {
            const cls = dingtalkNotify.classifyError(retryErr);
            return { ok: false, reason: cls.reason, body: { error: '重试取 token 失败：' + cls.hint } };
        }
    }
    if (!r.success) {
        // userId 失效 → 清缓存（下次重新反查）
        if (r.clearUserId) await dbRunAsync('UPDATE users SET dingtalk_user_id = NULL WHERE id = ?', [targetUser.id]);
        // codex 10 M-4：二次仍 token_expired → 清坏 token 缓存，避免后续 notify 持续失败到 token 自然过期
        if (r.reason === 'token_expired') dingtalkNotify.clearCachedToken();
        return { ok: false, reason: r.reason, body: { error: '钉钉推送失败', reason: r.reason } };
    }
    // codex 12 H-2：发送成功但 message_key 缺失 → 视为"发了但无法跟踪已读"，按失败处理（消费 C2 message_key_missing 标记）
    //   避免落 sent 后 notify-read-status 因缺 message_key 返 NO_MESSAGE_KEY 形成"已发送但永远查不到已读"不一致。
    if (!r.message_key) {
        return { ok: false, reason: 'message_key_missing', body: { error: '钉钉已发送但未返回消息标识，无法跟踪已读，请重试', reason: 'message_key_missing' } };
    }
    return { ok: true, message_key: r.message_key };
}

// 读 platform_base_url 并校验（09 复审 L-2：baseUrl 是 admin 配置，但仍过 sanitizeUrl 防脏配置破坏 markdown 深链）
async function getSafePlatformBaseUrl() {
    const raw = await readSystemConfig('platform_base_url');
    if (!raw) return '';
    return issueNotify.sanitizeUrl(raw) || '';  // 不合法返空 → buildIssueDeepLink 据空 baseUrl 省略深链
}

// §2.8 ① 通知开发（#1 指派）：前置 assigned_to 非空 + status ∈ {待处理,处理中,待验证}（M-5）
app.post('/api/issues/:id/notify-developer', authenticateToken, requireIssueSchemaReady, requirePublisherOrAdmin, async (req, res) => {
    const id = req.params.id;
    const attemptAt = new Date().toISOString();
    try {
        const issue = await dbGetAsync('SELECT * FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });
        if (!issue.assigned_to) return res.status(400).json({ error: '尚未指派开发，无法通知', code: 'NOT_ASSIGNED' });
        if (!['待处理', '处理中', '待验证'].includes(issue.status)) {
            return res.status(400).json({ error: `当前状态「${issue.status}」不可通知开发`, code: 'STATUS_NOT_NOTIFIABLE' });
        }
        const dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.assigned_to]);
        if (!dev) return res.status(400).json({ error: '被指派开发账号不存在' });

        const baseUrl = await getSafePlatformBaseUrl();
        const md = issueNotify.buildIssueAssignedMarkdown(issue, baseUrl);
        const result = await sendIssueDingtalkRaw(dev, `📋 新需求指派：${issue.title}`, md);

        if (result.ok) {
            await dbRunAsync(
                `UPDATE issues SET notify_status='sent', notified_at=?, notify_message_key=?, notify_error=NULL WHERE id=?`,
                [attemptAt, result.message_key, id]);
            return res.json({ success: true, message_key: result.message_key });
        }
        // H-4：失败必落库
        await dbRunAsync(
            `UPDATE issues SET notify_status='failed', notified_at=?, notify_message_key=NULL, notify_error=? WHERE id=?`,
            [attemptAt, result.reason || 'other', id]);
        logger.warn(`[issue-notify] 需求 #${id} 通知开发失败：${result.reason}`);
        return res.status(502).json({ success: false, ...result.body });
    } catch (err) {
        logger.error('通知开发失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// §2.8 ② 通知改派（#2）：读 pending_reassign_* 推新负责人 + 原负责人，发完留痕
//   仅新负责人通知落 issues.notify_*（updateIssueStatus=true）；原负责人通知失败仅 warn（M-1）
app.post('/api/issues/:id/notify-reassign', authenticateToken, requireIssueSchemaReady, requirePublisherOrAdmin, async (req, res) => {
    const id = req.params.id;
    const attemptAt = new Date().toISOString();
    try {
        const issue = await dbGetAsync('SELECT * FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });
        if (!issue.pending_reassign_to_id) return res.status(400).json({ error: '无改派记录可通知', code: 'NO_REASSIGN' });

        const baseUrl = await getSafePlatformBaseUrl();
        const newDev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.pending_reassign_to_id]);
        // codex 11 复审 M-1：新负责人账号不存在也走"失败可重试"语义（与 rNew 发送失败一致）——
        //   落 notify_status='failed' + 保留 pending（账号修复后可重试）+ 不通知原负责人，admin 端能看到失败态。
        if (!newDev) {
            await dbRunAsync(`UPDATE issues SET notify_status='failed', notified_at=?, notify_message_key=NULL, notify_error='new_dev_not_found' WHERE id=?`,
                [attemptAt, id]);
            logger.warn(`[issue-notify] 需求 #${id} 改派通知失败：新负责人账号(id=${issue.pending_reassign_to_id})不存在，保留 pending 待重试`);
            return res.status(400).json({ success: false, retriable: true, code: 'NEW_DEV_NOT_FOUND', error: '新负责人账号不存在，请核查后重试' });
        }

        // 新负责人通知（落 notify_*）
        const mdNew = issueNotify.buildIssueReassignedMarkdownForNew(issue, issue.pending_reassign_from_name, baseUrl);
        const rNew = await sendIssueDingtalkRaw(newDev, `🔄 需求转派给你：${issue.title}`, mdNew);

        // codex 10 H-2：新负责人通知失败 → 落 failed + **保留 pending_reassign_***（不清空、不通知原负责人）
        //   让 admin 修复钉钉配置/手机号后可再点 notify-reassign 重试（对齐 collab"失败可重试"范式）。
        if (!rNew.ok) {
            await dbRunAsync(`UPDATE issues SET notify_status='failed', notified_at=?, notify_message_key=NULL, notify_error=? WHERE id=?`,
                [attemptAt, rNew.reason || 'other', id]);
            logger.warn(`[issue-notify] 需求 #${id} 改派通知（新负责人）失败：${rNew.reason}，保留 pending 待重试`);
            return res.status(502).json({ success: false, new_notified: false, retriable: true, ...rNew.body });
        }

        // 新负责人通知成功 → 落 sent
        await dbRunAsync(`UPDATE issues SET notify_status='sent', notified_at=?, notify_message_key=?, notify_error=NULL WHERE id=?`,
            [attemptAt, rNew.message_key, id]);

        // 原负责人通知（仅在新负责人成功后做；最佳努力，不落 issues.notify_*——M-1：仅当前负责人维度落库）
        let oldNotified = false;
        if (issue.pending_reassign_from_id) {
            const oldDev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.pending_reassign_from_id]);
            if (oldDev) {
                const mdOld = issueNotify.buildIssueReassignedMarkdownForOld(issue, newDev.display_name);
                const rOld = await sendIssueDingtalkRaw(oldDev, `🔄 需求已转交：${issue.title}`, mdOld);
                oldNotified = rOld.ok;
                if (!rOld.ok) logger.warn(`[issue-notify] 需求 #${id} 原负责人通知失败：${rOld.reason}（不影响主流程）`);
            }
        }

        // 仅新负责人通知成功后才清 pending_reassign_*（避免成功通知后重复通知；失败已在上方早返回保留 pending）
        await dbRunAsync(
            `UPDATE issues SET pending_reassign_from_id=NULL, pending_reassign_from_name=NULL,
                    pending_reassign_to_id=NULL, pending_reassign_to_name=NULL WHERE id=?`, [id]);

        return res.json({ success: true, new_notified: true, old_notified: oldNotified, message_key: rNew.message_key });
    } catch (err) {
        logger.error('通知改派失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 业务方完成通知发送（C4）：业务方无平台账号，靠 requester_phone 反查钉钉号（区别于 sendIssueDingtalkRaw 走 users.id→phone）
//   对齐 create-chat 的 getUserIdByMobile(requester_phone) 反查链路（server.js:11575），非 collab notify-done 的 contact_person_id 路径。
//   返回 { ok, message_key, reason, body }；reason='requester_invalid' = 手机号查不到钉钉号（非企业成员/未绑定/离职）。
async function sendIssueDingtalkToRequester(requesterPhone, title, markdown) {
    if (!requesterPhone) return { ok: false, reason: 'requester_phone_empty', body: { error: '业务方手机号为空，无法发送完成通知' } };
    const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
    );
    if (!appKey || !appSecret || !robotCode) {
        return { ok: false, reason: 'no_config', body: { error: '钉钉配置未填写，请管理员先到系统配置填写凭证' } };
    }
    let token;
    try {
        token = await dingtalkNotify.getAccessToken(appKey, appSecret);
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        return { ok: false, reason: cls.reason, body: { error: cls.hint } };
    }
    // requester_phone 反查钉钉 user_id（业务方可能非企业成员/未绑定 → 查不到）
    let dingUserId;
    try {
        const raw = await dingtalkNotify.getUserIdByMobile(token, requesterPhone);
        dingUserId = raw != null ? String(raw).trim() : '';
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        return { ok: false, reason: cls.reason === 'user_invalid' ? 'requester_invalid' : cls.reason, body: { error: '业务方钉钉号查询失败：' + cls.hint } };
    }
    if (!dingUserId) {
        return { ok: false, reason: 'requester_invalid', body: { error: '业务方手机号查不到钉钉号（非企业成员/未绑定/离职），请线下转达' } };
    }
    // 发送（调 C2 helper）；token_expired 伪重试一次
    let r = await issueNotify.sendIssueMarkdown({ token, robotCode, dingUserId, title, markdown });
    if (!r.success && r.reason === 'token_expired') {
        dingtalkNotify.clearCachedToken();
        try {
            const freshToken = await dingtalkNotify.getAccessToken(appKey, appSecret);
            r = await issueNotify.sendIssueMarkdown({ token: freshToken, robotCode, dingUserId, title, markdown });
        } catch (retryErr) {
            const cls = dingtalkNotify.classifyError(retryErr);
            return { ok: false, reason: cls.reason, body: { error: '重试取 token 失败：' + cls.hint } };
        }
    }
    if (!r.success) {
        if (r.reason === 'token_expired') dingtalkNotify.clearCachedToken();
        return { ok: false, reason: r.reason, body: { error: '钉钉推送失败', reason: r.reason } };
    }
    // codex 12 H-2：发送成功但 message_key 缺失 → 视为"发了但无法跟踪已读"，按失败处理（消费 C2 message_key_missing 标记）
    //   避免落 sent 后 notify-read-status 因缺 message_key 返 NO_MESSAGE_KEY 形成"已发送但永远查不到已读"不一致。
    if (!r.message_key) {
        return { ok: false, reason: 'message_key_missing', body: { error: '钉钉已发送但未返回消息标识，无法跟踪已读，请重试', reason: 'message_key_missing' } };
    }
    return { ok: true, message_key: r.message_key };
}

// §2.8 ③ 通知业务方完成（#3，C4）：前置 status='已关闭' + requester_phone 非空；落 requester_notify_*（与开发侧隔离）
//   M-4：notify_error 固定短枚举（requester_phone_empty/requester_invalid/token_expired/network/other...）
//   M-3（codex 02）：acceptance_url 为空时软二次确认——前端 body 传 { confirm_no_link:true } 才放行无链接发送
app.post('/api/issues/:id/notify-requester-done', authenticateToken, requireIssueSchemaReady, requireAdmin, async (req, res) => {
    const id = req.params.id;
    const attemptAt = new Date().toISOString();
    try {
        const issue = await dbGetAsync('SELECT * FROM issues WHERE id = ?', [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });
        if (issue.status !== '已关闭') return res.status(409).json({ error: '仅「已关闭」需求可通知业务方完成', code: 'INVALID_STATE_FOR_NOTIFY' });
        if (!issue.requester_phone) return res.status(400).json({ error: '业务方手机号为空，无法通知（请先补填手机号）', code: 'REQUESTER_PHONE_EMPTY' });

        // codex 12 M-4 幂等：已成功通知（sent + 有 message_key）默认不重发（防手抖双击/前端重试重复打扰业务方）；
        //   需重发要显式 force_resend===true（如业务方反馈没收到）。
        const forceResend = req.body?.force_resend === true;
        if (!forceResend && issue.requester_notify_status === 'sent' && issue.requester_notify_message_key) {
            return res.json({ success: true, already_sent: true, message_key: issue.requester_notify_message_key,
                message: '已通知过业务方，未重复发送（如需重发传 force_resend）' });
        }

        // codex 12 M-3 软二次确认 + L-2 严格 ===true：acceptance_url 为空 → 通知无链接，需前端 confirm_no_link===true 才发（不硬阻断）
        const link = issueNotify.sanitizeUrl(issue.acceptance_url);
        if (!link && req.body?.confirm_no_link !== true) {
            return res.status(409).json({
                error: '未填预览/验收地址，业务方将收到无链接的完成通知',
                code: 'NO_ACCEPTANCE_URL', link_included: false, need_confirm: true
            });
        }

        // v1.74.1 L-1：完成通知"完成确认人"显示真正的关闭操作人，非录入人（created_by_name）。
        //   issues 表无 closed_by 列，builder fallback 链是 closed_by_name||created_by_name||'管理员'，
        //   故 closed_by_name 恒 undefined → 永远落到录入人（死分支永不到管理员）。
        //   修法：查 issue_status_history 最后一条 to_status='已关闭' 的 operator_name 注入 issue.closed_by_name，
        //   builder 一行不改（拿到值即用）。history 缺失（如旧数据 / 直接 SQL 改状态）时为 null → builder 自然 fallback 录入人。
        const closeRow = await dbGetAsync(
            `SELECT operator_name FROM issue_status_history
              WHERE issue_id = ? AND to_status = '已关闭'
              ORDER BY id DESC LIMIT 1`, [id]);
        // codex 25 L-2：trim 收口——null / 空串 / 纯空白都回退 builder fallback（录入人），不显示「完成确认：␣␣␣」
        const closedBy = String((closeRow && closeRow.operator_name) || '').trim();
        if (closedBy) issue.closed_by_name = closedBy;

        const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
        const result = await sendIssueDingtalkToRequester(issue.requester_phone, `✅ 需求已完成：${issue.title}`, md);

        if (result.ok) {
            await dbRunAsync(
                `UPDATE issues SET requester_notify_status='sent', requester_notified_at=?, requester_notify_message_key=?, requester_notify_error=NULL WHERE id=?`,
                [attemptAt, result.message_key, id]);
            return res.json({ success: true, message_key: result.message_key, link_included: !!link });
        }
        // H-4：失败必落库（requester_notify_error 存短枚举 reason）
        await dbRunAsync(
            `UPDATE issues SET requester_notify_status='failed', requester_notified_at=?, requester_notify_message_key=NULL, requester_notify_error=? WHERE id=?`,
            [attemptAt, result.reason || 'other', id]);
        logger.warn(`[issue-notify] 需求 #${id} 业务方完成通知失败：${result.reason}`);
        return res.status(502).json({ success: false, ...result.body });
    } catch (err) {
        logger.error('通知业务方完成失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 已读状态查询（C4，§3.5 ISSUE_FIELD_MAP）：单 endpoint 两路 recipient
//   issue_developer 走 assigned_to→users.dingtalk_user_id（对齐 collab developer 路）；
//   issue_requester 走 requester_phone 反查（M-1：无 user_id 不读 users 表，与 collab 三路最大偏差）。
// codex 12 M-1：钉钉调用 token_expired 自动清缓存+重取+重试一次（read-status 链路对齐发送链路的重试能力）
//   fn 接收 token 执行钉钉调用；若抛 token_expired，clearCachedToken + 重新 getAccessToken 后重跑 fn 一次。
async function callDingtalkWithTokenRetry(appKey, appSecret, token, fn) {
    try {
        return await fn(token);
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        if (cls.reason !== 'token_expired') throw err;
        dingtalkNotify.clearCachedToken();
        const freshToken = await dingtalkNotify.getAccessToken(appKey, appSecret);
        return await fn(freshToken);  // 重试一次；再失败由调用方 catch
    }
}

const ISSUE_READ_FIELD_MAP = {
    issue_developer: { user_id_col: 'assigned_to', notified_at: 'notified_at', message_key: 'notify_message_key', read_at: 'read_at', status_col: 'notify_status', label: '被指派开发', byPhone: false },
    issue_requester: { user_id_col: null, notified_at: 'requester_notified_at', message_key: 'requester_notify_message_key', read_at: 'requester_read_at', status_col: 'requester_notify_status', label: '业务方', byPhone: true },
};
app.get('/api/issues/:id/notify-read-status', authenticateToken, requireIssueSchemaReady, async (req, res) => {
    const id = req.params.id;
    try {
        const recipient = req.query.recipient || 'issue_developer';
        const fm = ISSUE_READ_FIELD_MAP[recipient];
        if (!fm) return res.status(400).json({ error: '无效的 recipient', code: 'INVALID_RECIPIENT' });

        // 字段名是写死的列名常量（非用户输入），插值进 SELECT 无注入风险
        const issue = await dbGetAsync(
            `SELECT id, requester_phone, ${fm.user_id_col || 'NULL'} AS recipient_user_id,
                    ${fm.notified_at} AS notified_at, ${fm.message_key} AS message_key,
                    ${fm.read_at} AS read_at, ${fm.status_col} AS notify_status
               FROM issues WHERE id = ?`, [id]);
        if (!issue) return res.status(404).json({ error: '需求不存在' });

        if (!issue.notified_at || issue.notify_status !== 'sent') {
            return res.status(400).json({ error: `尚未成功通知${fm.label}`, code: 'NOT_NOTIFIED', read: false });
        }
        // 已固化 → 直接返（钉钉无取消已读语义，不再查）
        if (issue.read_at) return res.json({ recipient, read: true, read_at: issue.read_at, cached: true });
        if (!issue.message_key) return res.status(400).json({ error: '缺少消息标识', code: 'NO_MESSAGE_KEY', read: false });

        // 取凭证 + token
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
        if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写', code: 'NO_DINGTALK_CONFIG' });
        let token;
        try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }

        // 解析收件人钉钉 user_id：developer 走 users 表；requester 走 phone 反查（M-1 偏差）
        let recipientDingUid = '';
        if (fm.byPhone) {
            if (!issue.requester_phone) return res.status(400).json({ error: '业务方手机号为空，无法查已读', code: 'REQUESTER_PHONE_EMPTY', read: false });
            try { const raw = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getUserIdByMobile(t, issue.requester_phone)); recipientDingUid = raw != null ? String(raw).trim() : ''; }
            catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: '业务方钉钉号查询失败：' + cls.hint, reason: cls.reason }); }
        } else {
            const u = await dbGetAsync('SELECT dingtalk_user_id FROM users WHERE id = ?', [issue.recipient_user_id]);
            recipientDingUid = u && u.dingtalk_user_id ? String(u.dingtalk_user_id).trim() : '';
        }
        if (!recipientDingUid) return res.json({ recipient, read: false, read_at: null, read_status: 'recipient_unresolved' });

        // 查钉钉已读（token_expired 自动重试一次）
        let readResult;
        try { readResult = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getReadStatus(t, robotCode, issue.message_key)); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }

        const myEntry = (readResult.readDetails || []).find(d => String(d.userId).trim() === recipientDingUid && d.readStatus === 'READ');
        const isRead = !!myEntry;
        let readAt = null;
        if (isRead) {
            // codex 12 M-3：readTimestamp 单位兼容归一（不凭印象 *1000）——>1e12 视为毫秒、>1e9 视为秒
            const ts = Number(myEntry.readTimestamp) || 0;
            const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : Date.now());
            readAt = new Date(ms).toLocaleString('zh-CN');
            // 首次查到 READ 固化（动态写回对应 read_at 列）
            await dbRunAsync(`UPDATE issues SET ${fm.read_at} = ? WHERE id = ?`, [readAt, id]);
        }
        res.json({ recipient, read: isRead, read_at: readAt, read_user_count: (readResult.readUserIds || []).length });
    } catch (err) {
        logger.error('查已读状态失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── C4：需求拉群讨论（方案 §4 C4，对齐 collab create-chat server.js:12090 朴素幂等范式）──────────
//   POST /api/issues/:id/create-chat：把需求相关方拉进钉钉群讨论。
//   与 collab 差异：① 权限 admin/publisher/本单 assigned_to/本单 created_by，viewer 禁止
//                   ② 群成员 示例用户A(3)+assigned_to+requester_phone 反查业务方+触发人
//                   ③ 群名 [需求]{title}-讨论（复用 collab Unicode 裁剪逻辑，与协作群命名区分）
//                   ④ issue 无操作日志表，补偿/降级走 logger.error/warn 结构化日志（可检索）
//   挂 requireIssueV1750SchemaReady：写 issues.dingtalk_chat_*（v1.75.0 新列），缺列软降级 503。
//   挂 requireNonViewer：先挡 viewer（admin/publisher/user 放行）；handler 内再判 user 必须是本单关系人。
//   幂等（对齐 collab 12138，不加 mutex）：先查 dingtalk_open_conversation_id 非空则返"已有群"——
//     生产单进程 fork_mode，collab 同范式跑一月无重复群（codex 31 持久化锁判过度设计驳回）。
app.post('/api/issues/:id/create-chat', authenticateToken, requireIssueSchemaReady, requireIssueV1750SchemaReady, requireNonViewer, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const userRole = req.user.role;

    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    // 当前用户 id 正整数守卫（对齐 collab create-chat M2）
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }

    try {
        const issue = await dbGetAsync(
            `SELECT id, title, status, requester_name, requester_phone,
                    assigned_to, assigned_to_name, created_by, oa_number,
                    dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name
               FROM issues WHERE id = ?`,
            [id]
        );
        if (!issue) return res.status(404).json({ error: '需求不存在' });

        // 权限校验：admin/publisher 任意单；user 必须是本单 assigned_to 或 created_by；viewer 已被 requireNonViewer 挡
        //   （hasRealAssignee 口径对齐 C2：Number()>0 排除 0/NULL 占位）
        const isAdminOrPublisher = userRole === 'admin' || userRole === 'publisher';
        const isAssignee = Number(issue.assigned_to) > 0 && Number(issue.assigned_to) === userId;
        const isCreator = Number(issue.created_by) > 0 && Number(issue.created_by) === userId;
        if (!isAdminOrPublisher && !isAssignee && !isCreator) {
            return res.status(403).json({
                error: '仅管理员/发布者，或本需求的负责人/创建人可拉起讨论群',
                code: 'NOT_ALLOWED'
            });
        }

        // 幂等：已建群直接返回旧值（朴素读时检查，对齐 collab 12138，不加 mutex）
        // codex 35 审 H-1：空串/NULL 口径统一（trim 后非空才算已建群，与落库 UPDATE 守卫一致防孤儿群）
        // codex 35 审 M-2 残余风险：单进程同进程异步并发（同 issue 两请求 await 钉钉期间交错）DB 一致性可守住，
        //   但仍可能建出"另一个孤儿钉钉群"——落库失败补偿已有 CHAT_LINK_FAILED 告警 + 群主钉钉客户端手动解散；
        //   collab 同范式跑一月无报告（内部 ≤10 人手动场景双击概率极低），不加进程内 in-flight 锁；
        //   Commit D 前端按钮提交态防抖辅助。
        const existingOpenConvId = String(issue.dingtalk_open_conversation_id || '').trim();
        if (existingOpenConvId) {
            // codex 36 复审 L-3：返回体口径与判断一致（trim 后透出，防历史脏值继续向外）
            return res.json({
                message: '该需求已有讨论群（请到钉钉客户端查看）',
                id,
                chat_id: String(issue.dingtalk_chat_id || '').trim(),
                open_conversation_id: existingOpenConvId,
                chat_name: String(issue.dingtalk_chat_name || '').trim(),
                idempotent: true
            });
        }

        // 取凭证
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
        );
        if (!appKey || !appSecret || !robotCode) {
            return res.status(500).json({ error: '钉钉配置未填写，请管理员先到系统配置 → 钉钉配置填写凭证', code: 'NO_DINGTALK_CONFIG' });
        }

        // 构造群成员：示例用户A（固定 admin 群主）+ assigned_to（非空才加）+ 触发人；业务方走 phone 反查单独加
        // v1.79.x codex 审 medium-1：所有成员来源统一走 addRealChatMember，排除内置 admin(id=1) + 无效/占位 id
        //   （含触发人本是 id=1，或 id=1 被指派为 assigned_to 的情况）。示例用户A(3) 正整数 ≠1 照常加入。
        const memberUserIds = new Set();
        addRealChatMember(memberUserIds, COLLAB_CHAT_ADMIN_ID);
        addRealChatMember(memberUserIds, issue.assigned_to);
        addRealChatMember(memberUserIds, userId);

        // 拉取所有平台成员的 dingtalk_user_id
        const memberRows = await dbAllAsync(
            `SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id IN (${[...memberUserIds].map(() => '?').join(',')})`,
            [...memberUserIds]
        );
        if (memberRows.length !== memberUserIds.size) {
            const foundIds = new Set(memberRows.map(r => r.id));
            const missing = [...memberUserIds].filter(uid => !foundIds.has(uid));
            return res.status(400).json({
                error: `群成员账号查询不全，缺失 user.id=${missing.join(',')}`,
                code: 'MEMBER_NOT_FOUND'
            });
        }

        // 取 access_token
        let token;
        try {
            token = await dingtalkNotify.getAccessToken(appKey, appSecret);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'GETTOKEN_FAILED' });
        }

        // 业务方负责人手机号反查（最佳努力，对齐 collab 12193）：
        //   requester_phone 非空 → 正则防御 → getUserIdByMobile 反查；命中加入群；未命中/异常 → 静默降级带 warning
        let requesterDingUid = null;
        let requesterDegraded = false;
        // codex 35 L-1：手机号 trim 归一化（防前后空格导致正则误判非法或传带空白手机号给钉钉）
        const requesterPhoneNormalized = String(issue.requester_phone || '').trim();
        if (requesterPhoneNormalized) {
            if (!/^1\d{10}$/.test(requesterPhoneNormalized)) {
                logger.warn(`[issue-create-chat] 需求 #${id} requester_phone 格式非法（${maskPhone(requesterPhoneNormalized)}），跳过反查降级`);
                requesterDegraded = true;
            } else {
                try {
                    const rawDingUid = await dingtalkNotify.getUserIdByMobile(token, requesterPhoneNormalized);
                    requesterDingUid = rawDingUid != null ? String(rawDingUid).trim() : null;
                    if (requesterDingUid) {
                        logger.info(`[issue-create-chat] 需求 #${id} 业务方手机号 ${maskPhone(requesterPhoneNormalized)} 反查命中 dingtalk_user_id=${requesterDingUid}`);
                    } else {
                        requesterDegraded = true;
                    }
                } catch (err) {
                    const cls = dingtalkNotify.classifyError(err);
                    logger.warn(`[issue-create-chat] 需求 #${id} 业务方手机号 ${maskPhone(requesterPhoneNormalized)} 反查失败：errcode=${cls.errcode} reason=${cls.reason}，降级走现有成员`);
                    requesterDingUid = null;
                    requesterDegraded = true;
                }
            }
        } else {
            requesterDegraded = true;  // 无手机号，业务方无法加入
        }

        // 补齐平台成员 dingtalk_user_id（缺失的按手机号反查 + 回写）
        const dingUserIds = [];
        for (const m of memberRows) {
            // codex 35 M-1：标准化读取，空白串不算有效（防 trim 空串混入成员误判 NOT_ENOUGH_MEMBERS）
            let dingUid = String(m.dingtalk_user_id || '').trim();
            // codex 35 L-1：m.phone trim 归一化（防带空格反查失败）
            const memberPhoneNormalized = String(m.phone || '').trim();
            if (!dingUid) {
                if (!memberPhoneNormalized) {
                    return res.status(400).json({
                        error: `${m.display_name || 'user#' + m.id} 未绑定手机号，无法拉入钉钉群`,
                        suggestion: '请到 admin → 用户管理 → 编辑该用户 → 填写手机号后重试',
                        code: 'NO_PHONE',
                        target_user_id: m.id
                    });
                }
                try {
                    // codex 35 M-1：反查返回值 trim 归一化；空值显式失败（不回写空到 users 也不混入成员）
                    const rawDingUid = await dingtalkNotify.getUserIdByMobile(token, memberPhoneNormalized);
                    dingUid = rawDingUid != null ? String(rawDingUid).trim() : '';
                    if (!dingUid) {
                        return res.status(502).json({
                            error: `${m.display_name} 钉钉账号反查为空，无法拉入群`,
                            target_user_id: m.id,
                            code: 'DINGTALK_USER_LOOKUP_EMPTY'
                        });
                    }
                    await dbRunAsync(
                        `UPDATE users SET dingtalk_user_id = ?
                         WHERE id = ? AND (dingtalk_user_id IS NULL OR TRIM(dingtalk_user_id) = '')`,
                        [dingUid, m.id]
                    );
                } catch (err) {
                    const cls = dingtalkNotify.classifyError(err);
                    return res.status(502).json({
                        error: `${m.display_name} 钉钉账号查询失败：${cls.hint}`,
                        errcode: cls.errcode, errmsg: cls.errmsg,
                        target_user_id: m.id,
                        code: 'DINGTALK_USER_LOOKUP_FAILED'
                    });
                }
            }
            const normalizedDingUid = dingUid != null ? String(dingUid).trim() : '';
            dingUserIds.push({ userId: m.id, dingtalk_user_id: normalizedDingUid, display_name: m.display_name });
        }

        // 业务方真人加入群（最佳努力，反查命中才加；不进 users 表用 0 占位 userId + 真实 dingtalk_user_id）
        if (requesterDingUid) {
            const dupExisting = dingUserIds.some(u => u.dingtalk_user_id === requesterDingUid);
            if (!dupExisting) {
                dingUserIds.push({
                    userId: 0,
                    dingtalk_user_id: requesterDingUid,
                    display_name: `${issue.requester_name || '业务方'}（业务方）`
                });
            }
        }

        // 最小成群下限（方案 §C4）：去重后真实钉钉号 < 2 人 → 无法建群
        const uniqueDingUids = new Set(dingUserIds.map(u => u.dingtalk_user_id).filter(Boolean));
        if (uniqueDingUids.size < 2) {
            return res.status(400).json({
                error: '缺少开发或业务方钉钉账号，群成员不足 2 人无法建群（请确认负责人/业务方已绑定钉钉手机号）',
                code: 'NOT_ENOUGH_MEMBERS'
            });
        }

        // 群主固定示例用户A（COLLAB_CHAT_ADMIN_ID）——对齐 collab v1.71.2，便于统一收口解散
        const owner = dingUserIds.find(u => u.userId === COLLAB_CHAT_ADMIN_ID);
        if (!owner) {
            return res.status(500).json({ error: '平台群主（示例用户A）钉钉账号未找到', code: 'OWNER_NOT_FOUND' });
        }

        // 群名：[需求]{title}-讨论（方案决策点 6，与协作群 [OA-xxx] 命名区分；复用 collab ≤20 字符 Unicode 裁剪）
        //   裁剪用 Array.from 按 Unicode 码点切（防中文/emoji 截半），整体超 20 时截 title 保前后缀
        const rawTitle = String(issue.title || `需求${id}`);
        const PREFIX = '[需求]', SUFFIX = '-讨论';
        let chatName = `${PREFIX}${rawTitle}${SUFFIX}`;
        if (Array.from(chatName).length > 20) {
            const budget = 20 - Array.from(PREFIX).length - Array.from(SUFFIX).length;  // 留给 title 的码点预算
            const clippedTitle = Array.from(rawTitle).slice(0, Math.max(budget, 0)).join('');
            chatName = `${PREFIX}${clippedTitle}${SUFFIX}`;
        }

        // codex 39 末次合并审 #1 HIGH：建群前轻量复查 assigned_to 防"成员快照过期"竞态
        //   场景：本 endpoint 读 issue 拿 assigned_to 后，C2 PUT /assign 改派到新负责人 →
        //         本端用旧 assigned_to 建钉钉群 → 落库 → 前端永久显示"已建群"但新负责人不在群里
        //   修法：钉钉调用前再 SELECT 一次 assigned_to + dingtalk_open_conversation_id，
        //         若 dingtalk_open_conversation_id 已被并发请求填上 → 走幂等返回（防"另一个孤儿群"）；
        //         若 assigned_to 与初始快照不同 → 409 让用户刷新页面后重拉（不发钉钉避免 admin 手动救场）
        //   说明：仍保留方案 §C4 朴素幂等（不加进程内锁），仅在 dingtalk 外部调用前做一次乐观复查；
        //         此复查窗口外（钉钉调用期间 → 落库前）仍可能有竞态，但已大幅缩窄；
        //         落库 UPDATE WHERE 守 dingtalk_open_conversation_id IS NULL **+ assigned_to IS ?**（codex 40 #1）双保险
        //   codex 40 #1 治本：UPDATE 加 assigned_to 乐观锁守 → 钉钉调用期间（可能秒级）改派也能拦住；
        //                      affectedRows=0 后 SELECT 判 ① open_conv_id 已被填 → 幂等 ② assigned_to 已变 → 409 + CRITICAL 日志钉钉孤儿群
        //   codex 40 #2：recheck 返空 → 404 ISSUE_DELETED_BEFORE_CHAT 避免无主孤儿群
        const recheck = await dbGetAsync(
            `SELECT assigned_to, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name
               FROM issues WHERE id = ?`,
            [id]
        );
        if (!recheck) {
            logger.warn(`[issue-create-chat] 需求 #${id} 建群前复查未找到 issue（已被并发删除），拒绝建钉钉孤儿群`);
            return res.status(404).json({
                error: '需求在拉群准备过程中已被删除，请刷新页面',
                code: 'ISSUE_DELETED_BEFORE_CHAT'
            });
        }
        if (String(recheck.dingtalk_open_conversation_id || '').trim()) {
            // 并发请求已先建群 → 走幂等返回（口径与 11135 一致）
            return res.json({
                message: '该需求已有讨论群（并发请求已先建群，请到钉钉客户端查看）',
                id,
                chat_id: String(recheck.dingtalk_chat_id || '').trim(),
                open_conversation_id: String(recheck.dingtalk_open_conversation_id || '').trim(),
                chat_name: String(recheck.dingtalk_chat_name || '').trim(),
                idempotent: true
            });
        }
        // codex 41 #1：nullable-aware 比较口径与下游 UPDATE 乐观锁一致，防 Number(null)=0 误判
        const recheckAssignedTo = recheck.assigned_to == null ? null : Number(recheck.assigned_to);
        const issueAssignedTo = issue.assigned_to == null ? null : Number(issue.assigned_to);
        if (recheckAssignedTo !== issueAssignedTo) {
            logger.warn(`[issue-create-chat] 需求 #${id} 建群前复查发现 assigned_to 变化：${issueAssignedTo} → ${recheckAssignedTo}（C2 改派并发），拒绝按旧成员建群`);
            return res.status(409).json({
                error: '负责人在拉群准备过程中已被改派，请刷新页面后重新拉群',
                code: 'ASSIGNEE_CHANGED_BEFORE_CHAT'
            });
        }
        // codex 40 #1：保存初始 assigned_to 快照供落库 UPDATE 乐观锁使用
        //   （建群前复查 + 落库乐观锁形成双保险，闭环复查到 UPDATE 之间的窗口）
        //   codex 41 #1 HIGH：nullable-aware 快照——Number(null)=0 但 SQLite 'assigned_to IS 0' 不匹配 IS NULL；
        //                     必须保留 null 让 sqlite3 驱动绑定到 SQL NULL，'IS ?'(null) 才等价于 IS NULL（首派前 NULL 可达）
        const initialAssignedTo = issue.assigned_to == null ? null : Number(issue.assigned_to);

        // 调钉钉建群
        let chatCreateResult;
        try {
            chatCreateResult = await dingtalkNotify.createChatGroup(
                token,
                chatName,
                owner.dingtalk_user_id,
                dingUserIds.map(u => u.dingtalk_user_id)
            );
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            logger.warn(`[issue-create-chat] 需求 #${id} chat/create 调用失败 by ${userName}：${cls.reason}`);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'CHAT_CREATE_FAILED' });
        }
        if (chatCreateResult.errcode !== 0) {
            const cls = dingtalkNotify.classifyError(chatCreateResult);
            logger.warn(`[issue-create-chat] 需求 #${id} chat/create 被拒 errcode=${chatCreateResult.errcode} by ${userName}`);
            return res.status(502).json({
                error: cls.hint, errcode: chatCreateResult.errcode, errmsg: chatCreateResult.errmsg,
                reason: cls.reason, code: 'CHAT_CREATE_REJECTED'
            });
        }

        const newChatId = chatCreateResult.chatid;
        const newOpenConvId = chatCreateResult.openConversationId;

        // 条件 UPDATE 落库（对齐 collab H1+H2）：dingtalk_open_conversation_id IS NULL 守卫并发后写者落不进库
        let updateResult;
        try {
            // codex 40 #1：UPDATE 加初始快照守卫双保险（SQLite IS 运算符兼容 null = null 首派可达）；
            //   钉钉调用期间改派会让乐观锁失败 → changes=0 → 走下面分支重新 SELECT 判幂等/409。
            //   codex 42 #1：本注释刻意不在同段内同时含完整 SQL 三段关键词，避免 T10d 正则误命中
            updateResult = await dbRunAsync(
                `UPDATE issues
                    SET dingtalk_chat_id = ?,
                        dingtalk_open_conversation_id = ?,
                        dingtalk_chat_created_at = datetime('now','localtime'),
                        dingtalk_chat_created_by = ?,
                        dingtalk_chat_name = ?
                  WHERE id = ?
                    AND (dingtalk_open_conversation_id IS NULL OR TRIM(dingtalk_open_conversation_id) = '')
                    AND assigned_to IS ?`,
                [newChatId, newOpenConvId, userId, chatName, id, initialAssignedTo]
            );
        } catch (dbErr) {
            // 落库失败补偿（方案 §C4，对齐 collab CREATE_CHAT_DB_FAILED）：钉钉群已建但平台落库失败 →
            //   结构化 logger.error 记完整 chat_id/open_conversation_id（可检索）+ 返明确错误供管理员手工补录
            logger.error(`[issue-create-chat] CRITICAL 钉钉群已建但落库异常 issue_id=${id} chatid=${newChatId} open_conversation_id=${newOpenConvId} chat_name=${chatName} created_by=${userId}(${userName}) error=${dbErr.message}`);
            return res.status(500).json({
                error: '钉钉群已创建但平台落库失败，请联系管理员手工补录（详见后端日志 issue-create-chat CRITICAL）',
                code: 'CHAT_CREATED_DB_UPDATE_FAILED',
                chat_id: newChatId,
                open_conversation_id: newOpenConvId,
                chat_name: chatName
            });
        }
        if (!updateResult || updateResult.changes === 0) {
            // 守卫未通过 → 并发竞态。codex 40 #1 扩展三分支：
            //   ① open_conv_id 已被填 → 别人先落库（幂等返回，本次新建群孤儿日志）
            //   ② assigned_to 已变 → 钉钉调用期间 C2 改派 → 409 + CRITICAL 日志（钉钉孤儿群需手工解散）
            //   ③ 未知原因（理论不触发）→ CHAT_LINK_FAILED + 群主手工解散
            const refreshed = await dbGetAsync(
                'SELECT assigned_to, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name FROM issues WHERE id = ?',
                [id]
            );
            // codex 36 复审 L-4：竞态分支判断和响应统一用 trim 后变量（与 H-1 口径一致）
            const refreshedOpenConvId = refreshed ? String(refreshed.dingtalk_open_conversation_id || '').trim() : '';
            // codex 41 #1：nullable-aware 比较，防 Number(null)=0 跳过 ② 分支错误进 ③ 致孤儿群
            const refreshedAssignedTo = refreshed && refreshed.assigned_to != null ? Number(refreshed.assigned_to) : null;
            if (refreshedOpenConvId) {
                // 分支 ① 别人先落库（已关联群不应被覆盖，但群成员可能基于旧 assigned_to 快照）
                // codex 41 #2：极端三方并发场景下分支 ① 优先返回幂等可能漏报"成员快照过期"——
                //              加 WARN 日志记 assigned_to 是否同时变化，便于运维事后排查（不动主逻辑）
                if (refreshedAssignedTo !== initialAssignedTo) {
                    logger.error(`[issue-create-chat] CRITICAL 并发竞态叠加改派：需求 #${id} 别人先落库（${refreshed.dingtalk_chat_id}）且 assigned_to 变化（初始=${initialAssignedTo} → 当前=${refreshedAssignedTo}），群成员可能基于旧负责人快照，请运维核查群成员与当前负责人一致性`);
                } else {
                    logger.warn(`[issue-create-chat] 并发竞态：需求 #${id} 另一请求已先落库（${refreshed.dingtalk_chat_id}），本次新建群丢弃 chatid=${newChatId} open_conv_id=${newOpenConvId}`);
                }
                return res.json({
                    message: '该需求已有讨论群（您本次新建的群因并发竞态被舍弃，请群主在钉钉客户端解散）',
                    id,
                    chat_id: String(refreshed.dingtalk_chat_id || '').trim(),
                    open_conversation_id: refreshedOpenConvId,
                    chat_name: String(refreshed.dingtalk_chat_name || '').trim(),
                    idempotent: true,
                    race_dropped_chat_id: newChatId
                });
            }
            if (refreshed && refreshedAssignedTo !== initialAssignedTo) {
                // 分支 ② 钉钉调用期间 C2 改派 → 钉钉群已建但成员快照过期 → 不落库
                logger.error(`[issue-create-chat] CRITICAL 钉钉调用期间 assigned_to 变化导致落库乐观锁失败 issue_id=${id} 初始=${initialAssignedTo} 当前=${refreshedAssignedTo} chatid=${newChatId} open_conversation_id=${newOpenConvId}（钉钉孤儿群需手工解散）`);
                return res.status(409).json({
                    error: '负责人在拉群过程中已被改派，钉钉群已建但未关联到需求，请群主在钉钉客户端手动解散并刷新页面后重拉',
                    code: 'ASSIGNEE_CHANGED_BEFORE_CHAT',
                    chat_id: newChatId,
                    open_conversation_id: newOpenConvId
                });
            }
            // 分支 ③ 未知原因 changes=0（理论不触发，issue 无作废/归档守卫）→ 记日志返回
            logger.error(`[issue-create-chat] 需求 #${id} UPDATE changes=0 但未查到已落库群（异常）chatid=${newChatId} open_conv_id=${newOpenConvId}`);
            return res.status(500).json({
                error: '群已建出但未关联到需求，请群主在钉钉客户端手动解散并联系管理员',
                code: 'CHAT_LINK_FAILED',
                chat_id: newChatId,
                open_conversation_id: newOpenConvId
            });
        }

        logger.info(`[issue-create-chat] 需求 #${id} 拉群成功 by ${userName} chatid=${newChatId}${requesterDegraded ? '（业务方未加入，已降级）' : ''}`);

        // 发欢迎卡片（best-effort，失败不影响主流程；所有动态字段 escapeMarkdown 防注入）
        try {
            const escape = dingtalkNotify.escapeMarkdown;
            const oaText = issue.oa_number ? `OA-${escape(String(issue.oa_number).replace(/^(test-)?oa-?/i, ''))}` : '（无 OA）';
            // codex 35 L-2：按 Unicode 码点截断，与群名 Array.from 同口径，避免截半 emoji
            const titleClipped = Array.from(String(issue.title || '')).slice(0, 30).join('');
            const cardTitle = `关于「${escape(titleClipped)}」需求讨论群`;
            const cardMarkdown = [
                `## 需求讨论群已创建`,
                ``,
                `**需求**：${escape(String(issue.title || '-').slice(0, 60))}`,
                `**OA 单号**：${oaText}`,
                `**业务方**：${escape(issue.requester_name || '-')}`,
                `**负责人**：${escape(issue.assigned_to_name || '未指派')}`,
                `**拉群人**：${escape(userName)}`,
                ``,
                `> 请相关方在群内同步上下文，推进需求处理。`
            ].join('\n');
            const cardResp = await dingtalkNotify.sendGroupMessage(token, robotCode, newOpenConvId, 'sampleMarkdown', { title: cardTitle, text: cardMarkdown });
            if (cardResp && cardResp.code) {
                logger.warn(`[issue-create-chat] #${id} 群卡片发送失败 code=${cardResp.code} msg=${cardResp.message || ''}`);
            }
        } catch (cardErr) {
            logger.warn(`[issue-create-chat] 需求 #${id} 欢迎卡片发送异常（不影响建群）：${cardErr.message}`);
        }

        return res.json({
            message: requesterDegraded
                ? '讨论群已创建（业务方因无钉钉账号/手机号未加入，请线下转达或补填手机号后重新整理）'
                : '讨论群已创建',
            id,
            chat_id: newChatId,
            open_conversation_id: newOpenConvId,
            chat_name: chatName,
            requester_degraded: requesterDegraded
        });
    } catch (err) {
        logger.error('需求拉群失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// codex C5 M-3：webhook secret 校验抽独立中间件，挂在 requireIssueSchemaReady **之前**——
//   未授权请求始终先被 401 拦截，不暴露 schema 初始化状态（503+detail），保持 401 鉴权语义优先于 503。
function requireWebhookSecret(req, res, next) {
    if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: '无效的 Webhook 密钥' });
    }
    next();
}

// codex C5 M-1：LIKE 通配符转义——run_id 拼入 LIKE 前转义 \ % _，配合 ESCAPE '\'，
//   避免含 %/_ 的 run_id 被当通配符误判"已存在"而漏建工单。
function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, '\\$&');
}

// codex C5 M-2：webhook body 字段归一——FDL 是外部输入边界，String(v).trim() 收口，
//   防对象/数组进模板字符串变 [object Object]/逗号拼接污染标题/description；空白按空处理。
function normalizeWebhookField(v) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' && typeof v !== 'number') return ''; // 对象/数组/布尔等一律视为空
    return String(v).trim();
}

// Webhook: FDL调度异常自动接入（预留）
//   C5 改造：① M-7 补 requester_dept='系统自动'/requester_name='FDL系统'（修 C1 重建后 NOT NULL 适配 bug
//   + 避免污染部门统计）② 落 issue_status_history 首行（对齐 C3 POST，使 FDL 工单详情页时间线不缺起点）
//   ③ M-1 run_id LIKE 转义 ④ M-2 body 字段类型归一 ⑤ L-1 run_id 去重移进事务内（写锁串行化防并发重复）。
//   run_id 去重沿用 description LIKE（L-3：不依赖任何被删字段，schema 重建不影响）。
// 中间件顺序（M-3）：requireWebhookSecret（401 优先）→ requireIssueSchemaReady（codex 09 H-1，503）→ handler。
app.post('/api/issues/webhook/schedule', requireWebhookSecret, requireIssueSchemaReady, async (req, res) => {
    // M-2：body 字段统一归一（拒对象/数组，空白→空）
    const tableName = normalizeWebhookField(req.body.table_name);
    const nodeName = normalizeWebhookField(req.body.node_name);
    const errorMessage = normalizeWebhookField(req.body.error_message);
    const errorTime = normalizeWebhookField(req.body.error_time);
    const runId = normalizeWebhookField(req.body.run_id);
    if (!tableName && !nodeName) return res.status(400).json({ error: '至少需要 node_name 或 table_name' });

    try {
        const title = `[调度异常] ${tableName || nodeName} 执行失败`;
        const desc = [
            errorMessage || '无错误详情',
            runId ? `\nrun_id: ${runId}` : ''
        ].join('');

        // INSERT issue + history 首行包事务（对齐 C3 POST BEGIN IMMEDIATE 范式，无 mutex——新增行无同行状态机并发；
        //   history 失败回滚，避免无首行历史的孤儿调度工单）。operator_id=0/operator_name='FDL系统' 表示系统侧。
        // L-1：run_id 去重移进事务内（BEGIN 后查重+插入，写锁串行化，闭合"并发同 run_id 都查不到各自插入"窗口）。
        let issueId, dupId = null;
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            if (runId) {
                // M-1：LIKE 特殊字符转义 + ESCAPE '\'，防 %/_ 通配符误判
                const existing = await dbGetAsync(
                    "SELECT id FROM issues WHERE description LIKE ? ESCAPE '\\' AND type = ?",
                    [`%run_id: ${escapeLike(runId)}%`, '调度异常']
                );
                if (existing) {
                    await dbRunAsync('COMMIT');  // 无写操作，提交释放写锁
                    dupId = existing.id;
                }
            }
            if (dupId === null) {
                const result = await dbRunAsync(
                    `INSERT INTO issues (title, description, type, source, priority, requester_dept, requester_name, related_table, error_time, created_by, created_by_name)
                     VALUES (?, ?, '调度异常', 'FDL自动', 'P1', '系统自动', 'FDL系统', ?, ?, 0, 'FDL系统')`,
                    [title, desc, tableName || null, errorTime || null]
                );
                issueId = result.lastID;
                await dbRunAsync(
                    `INSERT INTO issue_status_history (issue_id, from_status, to_status, reason, operator_id, operator_name)
                     VALUES (?, NULL, '待处理', NULL, 0, 'FDL系统')`,
                    [issueId]
                );
                await dbRunAsync('COMMIT');
            }
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }

        if (dupId !== null) return res.json({ id: dupId, message: '已存在相同记录，跳过' });

        logger.info(`Webhook 自动创建调度异常 #${issueId}: ${title}`);
        res.json({ id: issueId });
    } catch (err) {
        logger.error('Webhook 创建调度异常失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 数据协作模块 API（v1.0.1 一阶段）
// 详细方案见 docs/local/数据协作模块_一阶段方案.md
// ============================================================

// 部门枚举（与前端常量同步，校验入参合法性）
const COLLAB_REQUESTER_DEPTS = [
    '市场营销部', '交付运营部', '财务管理部', '人事行政部',
    '审计风控部', '信息技术部', '安全保卫部', '其他归口部门',
    '董事会', '公司高管',
    '华北分公司', '华东分公司', '华南分公司', '华西分公司',
    '华中分公司', '西南分公司', '西北分公司',
    '杭州区域', '浙北区域', '浙南区域',
    '示例关联方B', '示例关联方C', '示例集团关联方A', '示例关联方D', '示例海外子公司',
    '其他',
    '系统自动'  // v1.74.0 需求跟踪 M-7：FDL Webhook 等系统侧来源专用，前端按部门统计时单独分组（collab 业务侧不会主动选，共享常量无破坏性影响）
];

// 需求类型枚举
// v2.0 仅允许 ONE_OFF_EXPORT（新建时硬填）；其余 3 类保留兼容旧数据 + 列表筛选合法值
const COLLAB_REQUEST_TYPES = ['DASHBOARD_NEW', 'METRIC_CHANGE', 'METRIC_ADD_FROM_SOURCE', 'ONE_OFF_EXPORT'];
const COLLAB_REQUEST_TYPE_V2_DEFAULT = 'ONE_OFF_EXPORT';

// 主表状态枚举
// v3 二级转派状态机（2026-05-18 起）：PENDING_ASSIGN → PENDING → SUBMITTED → DONE → ARCHIVED
// CONFIRMED/CLAIMED 保留以兼容潜在旧数据筛选
// v1.71.0 三级转发：新增 EXPORTING 状态（PENDING → EXPORTING by forward-to-exporter；EXPORTING → PENDING by return-to-dev；EXPORTING → SUBMITTED by submit-export）
const COLLAB_STATUSES = ['PENDING_ASSIGN', 'PENDING', 'EXPORTING', 'SUBMITTED', 'DONE', 'ARCHIVED', 'CONFIRMED', 'CLAIMED'];

// 二级转派占位值（B1 方案）：未指派时 developer_id=0、developer_name='(待指派)'
// 权威判断未指派：status === 'PENDING_ASSIGN'；developer_id=0 是冗余信号
const COLLAB_UNASSIGNED_DEVELOPER_ID = 0;
const COLLAB_UNASSIGNED_DEVELOPER_NAME = '(待指派)';

// v1.70.4 codex 30 审 #5：手机号脱敏 helper，用于日志输出避免明文进审计/服务日志
//   规则：保留前 3 位 + 末 4 位，中间 4 位 ****；非 11 位输入返回 '[invalid_phone]' 不暴露原文
function maskPhone(phone) {
    if (phone == null || typeof phone !== 'string') return '[invalid_phone]';
    const trimmed = phone.trim();
    if (!/^1\d{10}$/.test(trimmed)) return '[invalid_phone]';
    return `${trimmed.slice(0, 3)}****${trimmed.slice(7)}`;
}

// 协作单操作日志写入辅助
function insertCollabLog(collabRequestId, operationType, operatorId, operator, reason = null) {
    db.run(
        'INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason) VALUES (?, ?, ?, ?, ?)',
        [collabRequestId, operationType, operatorId, operator, reason],
        (err) => { if (err) logger.error('Insert collab log failed:', err.message); }
    );
}

// 取数交付质量记录 v3.0 Commit E：详情页质量汇总已抽到 collabSubmitHelpers.buildQualitySummary（纯函数，可单测）

// 协作单附件 multer 配置（v2.0 方案 §5.4）
// 5 类 attachment_type 复用一个 multer 实例：扩展名联合白名单 + 100MB 顶上限；
// MIME 校验取消（codex 六审 B7）；扩展名 + 大小的分级在 endpoint 内按 attachment_type 二次校验。
const COLLAB_UPLOAD_BASE = path.join(UPLOAD_DIR, 'collab');

if (!fs.existsSync(COLLAB_UPLOAD_BASE)) {
    fs.mkdirSync(COLLAB_UPLOAD_BASE, { recursive: true });
}

// 各 attachment_type 的扩展名白名单 + 大小上限（字节）
// 方案 §5.4：screenshot=10MB / example_xlsx 分级 / result_data=100MB / result_script=1MB / pdf=10MB
// v1.72.0：pdf 类型一并清理（生产 0 行 + grep 0 真实业务调用 + 前端无入口）
// v1.77.0：screenshot 放开 .pdf（原始单据常为 OA 导出 PDF）——⚠️ 导出截图（submit-export 的
//   result_data_screenshot）共享本规则但业务语义=屏幕截图，已在该入口单独排除 .pdf，改本规则时同步审视
// v1.77.0：新增 data_scope（数据范围说明，如"A部门,B部门…"）——独立类型，
//   不复用 example_xlsx：质量校验列对齐按 attachment_type='example_xlsx' 取模板，data_scope 天然不参与比对
const COLLAB_ATTACHMENT_RULES = {
    screenshot:     { exts: ['.png','.jpg','.jpeg','.gif','.webp','.pdf'],                                sizeByExt: null,                              defaultSize: 10  * 1024 * 1024 },
    example_xlsx:   { exts: ['.xlsx','.xls','.pdf','.docx','.png','.jpg','.jpeg','.gif','.webp'],         sizeByExt: { '.xlsx': 100*1024*1024, '.xls': 100*1024*1024 }, defaultSize: 10  * 1024 * 1024 },
    data_scope:     { exts: ['.xlsx','.xls','.txt'],                                                      sizeByExt: null,                              defaultSize: 10  * 1024 * 1024 },
    result_data:    { exts: ['.xlsx','.xls'],                                                             sizeByExt: null,                              defaultSize: 100 * 1024 * 1024 },
    result_script:  { exts: ['.sql','.txt'],                                                              sizeByExt: null,                              defaultSize: 1   * 1024 * 1024 }
};

// 全部允许的扩展名（联合白名单，multer fileFilter 用）
const COLLAB_ALLOWED_EXTS_UNION = Array.from(new Set(
    Object.values(COLLAB_ATTACHMENT_RULES).flatMap(r => r.exts)
));

// 扩展名规范化（codex 六审 L-3）：trim + 拒绝控制字符 + 转小写
function normalizeAttachmentExt(filename) {
    const trimmed = String(filename || '').trim();
    if (!trimmed) return '';
    if (/[\x00-\x1F\x7F]/.test(trimmed)) return '';
    return path.extname(trimmed).toLowerCase().trim();
}

// 判断给定文件 (扩展名 + size) 是否符合 attachment_type 规则
// 返回 { ok: true } 或 { ok: false, error: '...' }
function validateCollabAttachmentRule(attachmentType, originalname, size) {
    const rule = COLLAB_ATTACHMENT_RULES[attachmentType];
    if (!rule) {
        return { ok: false, error: `不支持的 attachment_type: ${attachmentType}` };
    }
    const ext = normalizeAttachmentExt(originalname);
    if (!ext) {
        return { ok: false, error: '文件名为空或包含非法字符' };
    }
    if (!rule.exts.includes(ext)) {
        return { ok: false, error: `${attachmentType} 不支持扩展名 ${ext}，仅允许 ${rule.exts.join('/')}` };
    }
    const sizeLimit = (rule.sizeByExt && rule.sizeByExt[ext]) || rule.defaultSize;
    if (typeof size === 'number' && size > sizeLimit) {
        return { ok: false, error: `${attachmentType} (${ext}) 文件大小超限：${(size/1024/1024).toFixed(1)}MB > ${(sizeLimit/1024/1024).toFixed(0)}MB` };
    }
    return { ok: true, normalizedExt: ext, sizeLimit };
}

const collabStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 暂存到 _pending/{id}/，新建协作单接口拿到 id 后再 rename 到 {id}_{safe_desc} 子目录
        const reqId = req.params.id || req.body.collab_request_id || 'tmp';
        const targetDir = path.join(COLLAB_UPLOAD_BASE, '_pending', String(reqId));
        try {
            fs.mkdirSync(targetDir, { recursive: true });
            cb(null, targetDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: function (req, file, cb) {
        // Latin1 → UTF-8 修复中文文件名乱码
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ts = Date.now();
        const rand = Math.round(Math.random() * 1e9);
        const safeOriginal = file.originalname.replace(/[\\/:*?"<>|]/g, '_');
        cb(null, `${ts}_${rand}_${safeOriginal}`);
    }
});

const collabUpload = multer({
    storage: collabStorage,
    limits: {
        fileSize: 100 * 1024 * 1024,  // 上限 100MB（最大规则）；endpoint 内按 attachment_type 二次卡分级
        files: 5
    },
    fileFilter: function (req, file, cb) {
        const ext = normalizeAttachmentExt(file.originalname);
        if (!ext) {
            return cb(new Error('文件名为空或包含非法字符'));
        }
        if (!COLLAB_ALLOWED_EXTS_UNION.includes(ext)) {
            return cb(new Error(`不支持的扩展名 ${ext}，仅允许 ${COLLAB_ALLOWED_EXTS_UNION.join('/')}`));
        }
        cb(null, true);
    }
});

// ── 需求跟踪录入附件 multer 配置（C4a / v1.0.5 方案 §1.3a）────────────────────
// 「机制复用、各建一张表/各落一个目录」：复用 collab 的 filename 防重名（ts_rand_safeOriginal +
//   latin1→utf8）与扩展名联合白名单逻辑，但**独立 destination**——落 uploads/issues/_pending/{id}/，
//   与 collab 的 _pending/{id}/ 物理隔离，避免 issue #5 与 collab #5 撞同一 pending 目录。
// 落盘位置（用户拍板，偏离方案 §1.3a 字面"平铺 UPLOAD_DIR 根"）：正式目录 uploads/issues/ 子目录，
//   与 collab/ 同级，避免根目录文件随 task/collab 混杂膨胀；file_name 入库存相对路径 'issues/<名>'，
//   DELETE 时 safeDeleteFileSync('issues/<名>', UPLOAD_DIR) 经 path.join + isPathSafe 仍兼容。
// 录入附件是纯描述性材料（OA 截图/示例表/需求文档），不照搬 collab 的版本化/按人锁/seq 复杂度（方案 §1.3a）。
const ISSUE_UPLOAD_BASE = path.join(UPLOAD_DIR, 'issues');
const ISSUE_PENDING_BASE = path.join(ISSUE_UPLOAD_BASE, '_pending');

if (!fs.existsSync(ISSUE_UPLOAD_BASE)) {
    fs.mkdirSync(ISSUE_UPLOAD_BASE, { recursive: true });
}

const issueStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 暂存到 issues/_pending/{id}/，先行后传：POST /api/issues/:id/attachments 必带 :id（已存在 issue）
        // 纵深防御（codex C4a H-1 第二层）：endpoint 已挂前置 id 校验中间件拦非法 id，但 destination
        //   自身也不信任原始 req.params.id——非正整数直接 cb(error)，杜绝任何落盘到非预期路径的可能。
        const reqId = req.params.id;
        if (!/^[1-9]\d*$/.test(String(reqId))) {
            return cb(new Error('非法 issue id'));
        }
        const targetDir = path.join(ISSUE_PENDING_BASE, String(reqId));
        try {
            fs.mkdirSync(targetDir, { recursive: true });
            cb(null, targetDir);
        } catch (e) {
            cb(e);
        }
    },
    filename: function (req, file, cb) {
        // Latin1 → UTF-8 修复中文文件名乱码（同 collab 10858 范式，原地 mutate 供 handler 读取）
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ts = Date.now();
        const rand = Math.round(Math.random() * 1e9);
        const safeOriginal = file.originalname.replace(/[\\/:*?"<>|]/g, '_');
        cb(null, `${ts}_${rand}_${safeOriginal}`);
    }
});

const issueUpload = multer({
    storage: issueStorage,
    limits: {
        fileSize: 100 * 1024 * 1024,  // 顶上限 100MB（对齐 collab，防 DoS）
        files: 1                       // 录入附件低频小量，单次 1 个（前端逐个传，规避多文件部分失败回滚）
    },
    fileFilter: function (req, file, cb) {
        // 复用 collab 联合白名单（11 种：图片/xlsx/xls/pdf/docx/sql/txt），覆盖 OA 截图/示例表/文档场景
        const ext = normalizeAttachmentExt(file.originalname);
        if (!ext) {
            return cb(new Error('文件名为空或包含非法字符'));
        }
        if (!COLLAB_ALLOWED_EXTS_UNION.includes(ext)) {
            return cb(new Error(`不支持的扩展名 ${ext}，仅允许 ${COLLAB_ALLOWED_EXTS_UNION.join('/')}`));
        }
        cb(null, true);
    }
});

// 协作单附件目录路径生成
function getCollabAttachmentDir(requestId, description) {
    const safeDesc = String(description || '').replace(/[\\/:*?"<>|\s]/g, '_').substring(0, 20);
    return path.join(COLLAB_UPLOAD_BASE, `${requestId}_${safeDesc}`);
}

// 协作单字段校验 helper（新建 + 编辑共用）
// v2.0：新建时 OA 流程号 + 目标业务库必填；request_type 不再由前端传（后端硬填 ONE_OFF_EXPORT）
async function validateCollabRequestFields(body, isCreate = true) {
    const { requester_dept, requester_name, request_type, description, deadline, developer_id,
            oa_request_no, target_db_connection_id, contact_person_id } = body;

    if (isCreate) {
        if (!oa_request_no || !String(oa_request_no).trim()) return 'OA 流程号必填';
        if (!requester_dept) return '需求部门必填';
        if (!requester_name || !String(requester_name).trim()) return '业务方负责人必填';
        if (!description || !String(description).trim()) return '需求描述必填';
        if (!deadline) return '期望完成时间必填';
        // v3 二级转派改造：创建时填对接人，不填 developer（按拍板 #10 admin 不能越权直填）
        if (!contact_person_id) return '对接人必填';
        if (developer_id !== undefined && developer_id !== null && developer_id !== '') {
            return '创建协作单时不应直接指定开发人员（请由对接人后续指派）';
        }
        if (!target_db_connection_id) return '目标业务库必填';
    }

    if (requester_dept !== undefined && !COLLAB_REQUESTER_DEPTS.includes(requester_dept)) {
        return `无效的需求部门，合法值见前端常量`;
    }
    if (request_type !== undefined && !COLLAB_REQUEST_TYPES.includes(request_type)) {
        return `无效的需求类型，合法值: ${COLLAB_REQUEST_TYPES.join(', ')}`;
    }
    if (target_db_connection_id !== undefined && target_db_connection_id !== null) {
        const conn = await dbGetAsync(
            "SELECT id, connection_type FROM db_connections WHERE id = ?",
            [target_db_connection_id]
        );
        if (!conn) return '指定的目标业务库不存在';
        if (conn.connection_type !== 'source') return '目标业务库必须是 source 类型连接';
    }
    // v3 校验对接人
    let contactPerson = null;
    if (contact_person_id !== undefined && contact_person_id !== null) {
        contactPerson = await dbGetAsync(
            "SELECT id, display_name, username, role, status FROM users WHERE id = ?",
            [contact_person_id]
        );
        if (!contactPerson) return '指定的对接人不存在';
        if (contactPerson.status !== 'active') return '指定的对接人已停用';
        // 对接人角色不限制（与 developer 校验对齐：user/publisher/admin 均可）
        if (!['user', 'publisher', 'admin'].includes(contactPerson.role)) {
            return '指定的对接人角色无效（仅 user/publisher/admin）';
        }
    }
    if (developer_id !== undefined && developer_id !== null && developer_id !== ''
        && developer_id !== COLLAB_UNASSIGNED_DEVELOPER_ID) {
        const dev = await dbGetAsync(
            "SELECT id, display_name, username, role, status FROM users WHERE id = ?",
            [developer_id]
        );
        if (!dev) return '指派的开发人员不存在';
        if (dev.status !== 'active') return '指派的开发人员已停用';
        if (!['user', 'publisher', 'admin'].includes(dev.role)) return '指派的开发人员角色无效（仅 user/publisher/admin）';
        return { ok: true, developer: dev, contactPerson };
    }

    return { ok: true, contactPerson };
}

// 0. 获取 source 类型的 db_connections 列表（v2.0 录入弹窗目标业务库下拉用）
// 方案 §8.2：admin 专属，过滤 connection_type='source'
app.get('/api/collab/db-connections/source', authenticateToken, requireAdmin, (req, res) => {
    // v1.68.0 路由式多方言（2026-05-20）：放开 sqlserver / mysql 双方言
    // Deploy 3 单方言决策已升级 — sql-validator 与 runRealSmokeTest 按 connection.type 分派
    db.all(
        "SELECT id, name, type, host, port, database, source_system_code FROM db_connections WHERE connection_type = 'source' AND type IN ('sqlserver', 'mysql') ORDER BY name ASC, id ASC",
        [],
        (err, rows) => {
            if (err) {
                logger.error('source 连接列表查询失败:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows || []);
        }
    );
});

// v1.70.2 新增：所有登录用户可查 source 连接 id → name 映射（仅显示用，不返 host/port/database/凭证）
// 修复 BUG：开发账号打开协作单详情页"目标业务库"显示 #2 而非真实名（原 endpoint 加 requireAdmin 致开发 403）
//
// ⚠️ 边界声明（codex 27 审 #1 medium 拍板：不采纳收敛，加注释明确）：
//   - 这是"全员可见的业务库元数据" — 任何登录用户（含 viewer）能枚举全部 source 连接 id/name/type
//   - 安全前提：db_connections.name 由 admin 自起，约定使用系统标识（如 business_db / HRD-newhrd），
//     **不应**含敏感业务信息（客户名 / 环境凭证暗示）
//   - 当前 4-5 用户内网工具 + admin 自管 db 连接，此边界可接受
//   - 未来扩展场景（外部审计 / viewer 角色增加 / 多租户）需要收敛为"按用户可见协作单 target_db_id 过滤"
app.get('/api/collab/db-connections/lookup', authenticateToken, (req, res) => {
    db.all(
        "SELECT id, name, type FROM db_connections WHERE connection_type = 'source' AND type IN ('sqlserver', 'mysql') ORDER BY name ASC, id ASC",
        [],
        (err, rows) => {
            if (err) {
                logger.error('source 连接 lookup 查询失败:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows || []);
        }
    );
});

// 1. 获取协作单列表（支持 status / developer / type / dept / my_role 筛选）
// v3 二级转派改造（2026-05-18）+ codex 十六审 #2 high 权限收敛：
//   - admin 默认可看全部
//   - 非 admin 默认仅看 contact_person_id=req.user.id OR (developer_id=req.user.id AND developer_id!=0)
//   - my_role=contact|developer|admin 显式筛选优先于默认权限（仍受角色限制）
//   - developer_id 显式查询：仅 admin 或查询自己的可用
// v1.66.2 软删除（2026-05-19）：
//   - 默认过滤 archived_at IS NULL
//   - 仅 admin 可传 ?show_archived=1 看全部（含已作废）
app.get('/api/collab/requests', authenticateToken, (req, res) => {
    const { status, developer_id, request_type, requester_dept, search, my_role, show_archived } = req.query;

    let sql = 'SELECT * FROM collab_requests WHERE 1=1';
    const params = [];
    const currentUserId = Number(req.user.id);
    const isAdmin = req.user.role === 'admin';

    // v1.66.2 软删除过滤：默认不返已作废单；仅 admin 可传 show_archived=1 看全部
    if (show_archived === '1' || show_archived === 'true') {
        if (!isAdmin) {
            return res.status(403).json({ error: 'show_archived 仅 admin 可用', code: 'NOT_ADMIN' });
        }
        // admin 显式要求看全部 → 不加 archived_at 过滤
    } else {
        sql += ' AND archived_at IS NULL';
    }

    // v3 my_role 筛选（优先于 developer_id，互斥）
    // v1.71.0：加 'exporter'（数据导出人按 exporter_user_id 筛选）
    if (my_role) {
        if (!['contact', 'developer', 'exporter', 'admin'].includes(my_role)) {
            return res.status(400).json({ error: '无效的 my_role 值（合法值：contact/developer/exporter/admin）' });
        }
        if (my_role === 'admin' && !isAdmin) {
            return res.status(403).json({ error: 'my_role=admin 仅 admin 角色可用' });
        }
        if (my_role === 'contact') {
            sql += ' AND contact_person_id = ?';
            params.push(currentUserId);
        } else if (my_role === 'developer') {
            // 排除占位值 0（PENDING_ASSIGN 状态的未指派单）
            sql += ' AND developer_id = ? AND developer_id != 0';
            params.push(currentUserId);
        } else if (my_role === 'exporter') {
            // v1.71.0：exporter_user_id 列表（v1.0 §4 列表筛选）
            //   - 仅返回当前用户作为数据导出人的协作单
            //   - 历史已退回的单（PENDING 状态 + exporter_user_id 残留）也会命中——
            //     前端用 status 文案区分"当前导出中"vs"曾被指派已退回"，详情页用 §5.3.5 语义切换
            sql += ' AND exporter_user_id = ?';
            params.push(currentUserId);
        }
        // my_role=admin：不加筛选，返回全部
    } else if (!isAdmin) {
        // codex 十六审 #2：未传 my_role 的普通用户默认按本人可见范围过滤
        // v1.71.0：增加 exporter_user_id 维度（数据导出人也是本单"我的"角色）
        sql += ' AND (contact_person_id = ? OR (developer_id = ? AND developer_id != 0) OR exporter_user_id = ?)';
        params.push(currentUserId, currentUserId, currentUserId);
    }
    // 注：admin 不传 my_role 时不加筛选，保留"看全部"语义

    if (status) {
        if (!COLLAB_STATUSES.includes(status)) return res.status(400).json({ error: '无效的状态值' });
        sql += ' AND status = ?';
        params.push(status);
    }
    // developer_id 显式筛选：codex 十六审 #2 收紧
    //   - admin 可查任意 developer_id
    //   - 非 admin 仅能查自己（developer_id == currentUserId）
    //   - my_role 优先时此参数被覆盖
    if (developer_id && !my_role) {
        if (!isAdmin && Number(developer_id) !== currentUserId) {
            return res.status(403).json({ error: 'developer_id 仅 admin 可查询他人' });
        }
        sql += ' AND developer_id = ?';
        params.push(developer_id);
    }
    if (request_type) {
        if (!COLLAB_REQUEST_TYPES.includes(request_type)) return res.status(400).json({ error: '无效的需求类型' });
        sql += ' AND request_type = ?';
        params.push(request_type);
    }
    if (requester_dept) {
        sql += ' AND requester_dept = ?';
        params.push(requester_dept);
    }
    if (search) {
        sql += ' AND (description LIKE ? OR requester_name LIKE ? OR external_request_id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // 状态排序：v3 加 PENDING_ASSIGN 在最前（"待指派"优先级最高）
    // v1.71.0：EXPORTING 插在 PENDING 之后、SUBMITTED 之前（导出中是 PENDING 的"承接态"，未提交所以排在 SUBMITTED 之前）
    sql += ` ORDER BY
        CASE status
            WHEN 'PENDING_ASSIGN' THEN 0
            WHEN 'PENDING' THEN 1
            WHEN 'EXPORTING' THEN 2
            WHEN 'SUBMITTED' THEN 3
            WHEN 'DONE' THEN 4
            WHEN 'ARCHIVED' THEN 5
            ELSE 6
        END,
        deadline ASC,
        id DESC`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            logger.error('协作单列表查询失败:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows || []);
    });
});

// 2. 获取协作单详情（含 items + attachments + logs）
// v3 二级转派改造（codex 十六审 #1 critical）：可见性闸门
//   - admin 全部可见
//   - 本单 contact_person_id === req.user.id 可见
//   - 本单 developer_id !== 0 且 developer_id === req.user.id 可见
//   - v1.71.0：本单 exporter_user_id !== 0 且 exporter_user_id === req.user.id 可见
//             （包括已退回单 PENDING + exporter_user_id 残留场景，让历史导出人能查看"曾经处理过"的单）
//   - 其他 → 403
app.get('/api/collab/requests/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const request = await dbGetAsync('SELECT * FROM collab_requests WHERE id = ?', [id]);
        if (!request) return res.status(404).json({ error: '协作单不存在' });

        // 可见性校验（统一 Number 比较，规避 JWT id 字符串/数字混用导致的误判）
        const currentUserId = Number(req.user.id);
        const isAdmin = req.user.role === 'admin';
        const isContact = Number(request.contact_person_id) === currentUserId;
        const isDeveloper = Number(request.developer_id) !== 0
                         && Number(request.developer_id) === currentUserId;
        // v1.71.0 三级转发：导出人可见性（排除 NULL/0 占位）
        const isExporter = request.exporter_user_id != null
                        && Number(request.exporter_user_id) !== 0
                        && Number(request.exporter_user_id) === currentUserId;
        if (!isAdmin && !isContact && !isDeveloper && !isExporter) {
            return res.status(403).json({ error: '无权查看此协作单', code: 'FORBIDDEN' });
        }

        // v3 改派后展示前任：前端拿不到姓名只能显示 user#X，这里 JOIN users 查姓名作为派生字段返
        if (request.previous_developer_id) {
            const prevUser = await dbGetAsync(
                'SELECT display_name, username FROM users WHERE id = ?',
                [request.previous_developer_id]
            );
            if (prevUser) {
                request.previous_developer_name = prevUser.display_name || prevUser.username;
            }
        }

        const items = await dbAllAsync(
            'SELECT * FROM collab_dev_plan_items WHERE collab_request_id = ? ORDER BY seq ASC, id ASC',
            [id]
        );
        const attachments = await dbAllAsync(
            'SELECT * FROM collab_attachments WHERE collab_request_id = ? ORDER BY created_at DESC',
            [id]
        );
        const logs = await dbAllAsync(
            'SELECT * FROM collab_operation_logs WHERE collab_request_id = ? ORDER BY created_at DESC, id DESC',
            [id]
        );

        // 取数交付质量记录 v3.0 Commit E：附带质量数据（同 items/attachments/logs 一次拉全范式，用户拍板）
        //   - quality_records：每次提交一行（C2 旁路写），按提交序升序
        //   - return_records：每次打回一行（D 写），按打回时间升序
        //   - quality_summary：后端算好的汇总（交付时长 M-7 / 提交次数 / 打回次数 / 返工次数），口径集中后端一处
        //
        // ⭐ 双校验 Commit D §8b.1 关键过滤（方案明确"最易漏"）：只展示正式交付质量 record_kind='passed'，
        //   不展示 failed 过程留痕（failed 是 append-only 调试用途，业务用户看到会混淆"已交付"判断）。
        //   buildQualitySummary 接收过滤后的数组自动生效（不改 helper）；未来若需 debug 接口看 failed，另起 endpoint。
        const qualityRecords = await dbAllAsync(
            "SELECT * FROM collab_quality_record WHERE collab_request_id = ? AND record_kind = 'passed' ORDER BY submission_seq ASC, id ASC",
            [id]
        );
        const returnRecords = await dbAllAsync(
            'SELECT * FROM collab_return_record WHERE collab_request_id = ? ORDER BY returned_at ASC, id ASC',
            [id]
        );
        const qualitySummary = collabSubmitHelpers.buildQualitySummary(request, qualityRecords, returnRecords);

        res.json({
            ...request, items, attachments, logs,
            quality_records: qualityRecords,
            return_records: returnRecords,
            quality_summary: qualitySummary,
        });
    } catch (err) {
        logger.error('协作单详情查询失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3. 新建协作单（admin 唯一）
// v3 二级转派改造（2026-05-18）：admin 创建时只填对接人（contact_person_id），不填 developer
//   - 状态落 PENDING_ASSIGN，developer_id 占位 0，developer_name 占位 '(待指派)'
//   - 后续由对接人调 POST /:id/assign 指派具体开发，状态推进到 PENDING
app.post('/api/collab/requests', authenticateToken, requireAdmin, async (req, res) => {
    const {
        external_request_id,
        oa_request_no,
        requester_dept,
        requester_name,
        description,
        deadline,
        contact_person_id,
        exporter_user_id,  // v1.72.3 admin 直派模式（与 contact_person_id 二选一）
        target_db_connection_id,
        requester_phone  // v1.70.4 ④ 业务方负责人手机号（选填）
    } = req.body;

    try {
        // === v1.72.3 admin 直派模式：二选一校验 ===
        const hasContactPerson = contact_person_id !== undefined
                                 && contact_person_id !== null
                                 && contact_person_id !== ''
                                 && Number(contact_person_id) > 0;
        const hasExporter = exporter_user_id !== undefined
                            && exporter_user_id !== null
                            && exporter_user_id !== ''
                            && Number(exporter_user_id) > 0;

        if (hasContactPerson && hasExporter) {
            return res.status(400).json({
                error: 'contact_person_id 与 exporter_user_id 不可同时填写（二选一）',
                code: 'CONFLICTING_ASSIGN_MODE'
            });
        }
        if (!hasContactPerson && !hasExporter) {
            return res.status(400).json({
                error: 'contact_person_id 与 exporter_user_id 必须二选一填写',
                code: 'MISSING_ASSIGN_MODE'
            });
        }

        const assignMode = hasExporter ? 'admin_direct' : 'normal';
        const initialStatus = hasExporter ? 'EXPORTING' : 'PENDING_ASSIGN';

        // === admin_direct 模式：校验 exporter 用户 + 必填字段（绕过 validateCollabRequestFields 的 contact_person_id 必填）===
        let exporterUser = null;
        let contactPerson = null;
        let contactPersonName = '';
        let validatedExporterId = 0;
        let validatedExporterName = '';

        if (assignMode === 'admin_direct') {
            // codex 32 审 L-1 采纳：即使未来 requireAdmin 中间件放宽（如允许 publisher 创建 normal 模式协作单），
            // admin_direct 分支仍必须 admin-only —— 直派权限的核心是 admin 凭业务判断绕过流转链路，
            // 不能授予 publisher/contact/developer。此处守卫不可删除。
            if (req.user.role !== 'admin') {
                return res.status(403).json({
                    error: '仅 admin 可直派给数据导出人',
                    code: 'NOT_ADMIN_FOR_DIRECT_ASSIGN'
                });
            }
            // 必填字段（不走 validateCollabRequestFields 的 contact_person_id 校验）
            if (!oa_request_no || !String(oa_request_no).trim()) return res.status(400).json({ error: 'OA 流程号必填' });
            if (!requester_dept) return res.status(400).json({ error: '需求部门必填' });
            if (!requester_name || !String(requester_name).trim()) return res.status(400).json({ error: '业务方负责人必填' });
            if (!description || !String(description).trim()) return res.status(400).json({ error: '需求描述必填' });
            if (!deadline) return res.status(400).json({ error: '期望完成时间必填' });
            if (!target_db_connection_id) return res.status(400).json({ error: '目标业务库必填' });
            if (!COLLAB_REQUESTER_DEPTS.includes(requester_dept)) {
                return res.status(400).json({ error: '无效的需求部门，合法值见前端常量' });
            }
            // 校验 target_db_connection
            const conn = await dbGetAsync(
                "SELECT id, connection_type FROM db_connections WHERE id = ?",
                [target_db_connection_id]
            );
            if (!conn) return res.status(400).json({ error: '指定的目标业务库不存在' });
            if (conn.connection_type !== 'source') return res.status(400).json({ error: '目标业务库必须是 source 类型连接' });

            // 校验 exporter 用户
            exporterUser = await dbGetAsync(
                "SELECT id, display_name, username, role, status FROM users WHERE id = ?",
                [Number(exporter_user_id)]
            );
            if (!exporterUser) {
                return res.status(400).json({ error: '数据导出人不存在', code: 'EXPORTER_NOT_FOUND' });
            }
            if (exporterUser.status !== 'active') {
                return res.status(400).json({ error: '数据导出人已停用', code: 'EXPORTER_INACTIVE' });
            }
            // v1.72.5：admin 直派支持 viewer 角色（客服性质运营，配合 requireExporterOrNonViewer 中间件）
            if (!['user', 'publisher', 'admin', 'viewer'].includes(exporterUser.role)) {
                return res.status(400).json({ error: '数据导出人角色无效（仅 user/publisher/admin/viewer）' });
            }
            // v1.74.3：纯只读领导账号不可被设为数据导出人（防 admin 直派下拉手滑选中，前端已过滤+后端兜底）
            if (isReadonlyLeaderId(exporterUser.id)) {
                return res.status(400).json({ error: '该账号为纯只读领导账号，不可指派为数据导出人', code: 'EXPORTER_IS_READONLY_LEADER' });
            }
            validatedExporterId = exporterUser.id;
            validatedExporterName = exporterUser.display_name || exporterUser.username;
        } else {
            // normal 模式走原有 validateCollabRequestFields
            const validation = await validateCollabRequestFields(req.body, true);
            if (typeof validation === 'string') {
                return res.status(400).json({ error: validation });
            }
            contactPerson = validation.contactPerson;
            contactPersonName = contactPerson.display_name || contactPerson.username;
        }

        const operatorId = req.user.id;
        const operatorName = req.user.display_name || req.user.username;

        const oaTrimmed = String(oa_request_no).trim();

        // v1.70.4 ④ 业务方手机号校验（选填，11 位数字；空字符串/null/undefined 都视为未填）
        let phoneTrimmed = null;
        if (requester_phone != null && String(requester_phone).trim() !== '') {
            phoneTrimmed = String(requester_phone).trim();
            if (!/^1\d{10}$/.test(phoneTrimmed)) {
                return res.status(400).json({ error: '业务方负责人手机号必须是 11 位以 1 开头的数字' });
            }
        }

        // OA 流程号唯一性预检（codex 六审 M-2）
        const oaExisting = await dbGetAsync(
            'SELECT id FROM collab_requests WHERE oa_request_no = ?',
            [oaTrimmed]
        );
        if (oaExisting) {
            return res.status(409).json({
                error: `OA 流程号 ${oaTrimmed} 已存在关联协作单 #${oaExisting.id}`,
                existing_id: oaExisting.id
            });
        }

        try {
            const result = await dbRunAsync(
                `INSERT INTO collab_requests
                    (external_request_id, oa_request_no, requester_dept, requester_name, request_type,
                     description, deadline, status, created_by, created_by_name,
                     developer_id, developer_name,
                     contact_person_id, contact_person_name,
                     target_db_connection_id, requester_phone,
                     assign_mode,
                     exporter_user_id, exporter_name, exporter_assigned_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    external_request_id || null,
                    oaTrimmed,
                    requester_dept,
                    String(requester_name).trim(),
                    COLLAB_REQUEST_TYPE_V2_DEFAULT,
                    String(description).trim(),
                    deadline,
                    initialStatus,  // v1.72.3: normal → PENDING_ASSIGN / admin_direct → EXPORTING
                    operatorId,
                    operatorName,
                    COLLAB_UNASSIGNED_DEVELOPER_ID,
                    COLLAB_UNASSIGNED_DEVELOPER_NAME,
                    assignMode === 'admin_direct' ? 0 : contactPerson.id,
                    assignMode === 'admin_direct' ? '' : contactPersonName,
                    target_db_connection_id,
                    phoneTrimmed,  // v1.70.4 ④
                    assignMode,  // v1.72.3
                    assignMode === 'admin_direct' ? validatedExporterId : null,
                    assignMode === 'admin_direct' ? validatedExporterName : null,
                    assignMode === 'admin_direct' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null
                ]
            );
            const newId = result.lastID;
            const opLogType = assignMode === 'admin_direct' ? 'ADMIN_DIRECT_CREATE' : 'CREATE';
            const opLogReason = assignMode === 'admin_direct'
                ? `直派给: ${validatedExporterName} (id=${validatedExporterId})`
                : null;
            insertCollabLog(newId, opLogType, operatorId, operatorName, opLogReason);
            logger.info(`用户 ${req.user.username} 创建协作单 #${newId}（OA: ${oaTrimmed}，模式: ${assignMode}${assignMode === 'admin_direct' ? `，直派给: ${validatedExporterName}` : ''}）`);
            res.json({
                id: newId,
                message: assignMode === 'admin_direct'
                    ? `✅ 协作单已创建（admin 直派给 ${validatedExporterName}）`
                    : '协作单已创建',
                assign_mode: assignMode,
                initial_status: initialStatus,
                exporter_name: assignMode === 'admin_direct' ? validatedExporterName : undefined,
                contact_person_name: assignMode === 'normal' ? contactPersonName : undefined
            });
        } catch (insertErr) {
            // UNIQUE 冲突兜底（与预检并发竞态）
            if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed')) {
                const conflict = await dbGetAsync(
                    'SELECT id FROM collab_requests WHERE oa_request_no = ?',
                    [oaTrimmed]
                );
                return res.status(409).json({
                    error: `OA 流程号 ${oaTrimmed} 已存在关联协作单 #${conflict ? conflict.id : '?'}`,
                    existing_id: conflict ? conflict.id : null
                });
            }
            throw insertErr;
        }
    } catch (err) {
        logger.error('创建协作单失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4. 编辑协作单（仅 admin + PENDING_ASSIGN / PENDING + 未提交）
// v3 二级转派改造（2026-05-18）+ v1.66.2 编辑功能放宽（2026-05-19）：
//   - 权限收紧：仅 admin（v1.0.2 残留 publisher/developer 路径全部移除）
//   - 状态白名单：PENDING_ASSIGN / PENDING（前提是 submission_version=0，未提交脚本）
//   - 移除 developer_id 编辑路径：改派走 POST /:id/assign endpoint
//   - 可改字段：external_request_id / requester_dept / requester_name / description / deadline
//     · contact_person_id 仅 PENDING_ASSIGN 可改（PENDING 已指派开发，换对接人会造成"指派归属"混乱）
//   - request_type 不可改（v2.0 硬填 ONE_OFF_EXPORT，不再支持改）
//   - archived 协作单不可编辑（已软删除）
//   - oa_request_no（external_request_id）改变时需做 UNIQUE 预检
app.put('/api/collab/requests/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const operatorName = req.user.display_name || req.user.username;

    try {
        const existing = await dbGetAsync('SELECT * FROM collab_requests WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: '协作单不存在' });

        // 软删除拦截
        if (existing.archived_at) {
            return res.status(409).json({
                error: '协作单已作废，不可编辑',
                code: 'ARCHIVED'
            });
        }

        // 状态白名单：PENDING_ASSIGN / PENDING 可编辑（PENDING 要求 submission_version=0 即未提交）
        const isPendingAssign = existing.status === 'PENDING_ASSIGN';
        const isPendingUnsubmitted = existing.status === 'PENDING' && (existing.submission_version || 0) === 0;
        if (!isPendingAssign && !isPendingUnsubmitted) {
            return res.status(409).json({
                error: `当前状态 ${existing.status} 不可编辑（仅 PENDING_ASSIGN 或 PENDING+未提交可编辑文本字段）`,
                code: 'INVALID_STATE',
                current_status: existing.status
            });
        }

        // 拒绝 developer_id / status / request_type 等字段更新（走对应 endpoint 或不可改）
        if (req.body.developer_id !== undefined) {
            return res.status(400).json({
                error: '不能通过 PUT 修改 developer_id，请走 POST /:id/assign 指派/改派',
                code: 'USE_ASSIGN_ENDPOINT'
            });
        }
        if (req.body.status !== undefined && req.body.status !== existing.status) {
            return res.status(400).json({
                error: '不能通过 PUT 修改状态（状态由对应 endpoint 驱动）',
                code: 'CANNOT_UPDATE_STATUS'
            });
        }
        if (req.body.request_type !== undefined && req.body.request_type !== existing.request_type) {
            return res.status(400).json({
                error: '需求类型不可修改（v2.0 固定为 ONE_OFF_EXPORT）',
                code: 'REQUEST_TYPE_LOCKED'
            });
        }
        // PENDING 状态不允许改 contact_person_id（已指派开发，换对接人会破坏指派归属）
        if (!isPendingAssign
            && req.body.contact_person_id !== undefined
            && Number(req.body.contact_person_id) !== existing.contact_person_id) {
            return res.status(400).json({
                error: 'PENDING 状态不允许更换对接人（仅 PENDING_ASSIGN 可改）',
                code: 'CANNOT_CHANGE_CONTACT_IN_PENDING'
            });
        }

        // oa_request_no（external_request_id）UNIQUE 预检：若改了，先看是否与其他协作单冲突
        // v3 创建 endpoint 用的是 oa_request_no 字段，但实际 INSERT 时取了 external_request_id 字段（命名不一致）
        // PUT 允许两个字段名传入，但实际编辑 oa_request_no 字段
        const oaChanged = req.body.oa_request_no !== undefined
            && String(req.body.oa_request_no).trim() !== (existing.oa_request_no || '');
        if (oaChanged) {
            const newOa = String(req.body.oa_request_no).trim();
            if (!newOa) {
                return res.status(400).json({ error: 'OA 流程号不能为空', code: 'OA_REQUIRED' });
            }
            const conflict = await dbGetAsync(
                'SELECT id FROM collab_requests WHERE oa_request_no = ? AND id != ?',
                [newOa, id]
            );
            if (conflict) {
                return res.status(409).json({
                    error: `OA 流程号 ${newOa} 已存在关联协作单 #${conflict.id}`,
                    existing_id: conflict.id,
                    code: 'OA_CONFLICT'
                });
            }
        }

        // 字段校验（PUT 走非创建分支）
        const validation = await validateCollabRequestFields(req.body, false);
        if (typeof validation === 'string') {
            return res.status(400).json({ error: validation });
        }

        const updates = [];
        const params = [];
        const fields = ['external_request_id', 'requester_dept', 'requester_name', 'description', 'deadline'];
        for (const f of fields) {
            if (req.body[f] !== undefined) {
                updates.push(`${f} = ?`);
                params.push(typeof req.body[f] === 'string' ? req.body[f].trim() : req.body[f]);
            }
        }
        // v1.70.4 ④ requester_phone（选填，11 位数字；空字符串/null 都视为清空）
        if (req.body.requester_phone !== undefined) {
            let phoneVal = null;
            if (req.body.requester_phone !== null && String(req.body.requester_phone).trim() !== '') {
                phoneVal = String(req.body.requester_phone).trim();
                if (!/^1\d{10}$/.test(phoneVal)) {
                    return res.status(400).json({ error: '业务方负责人手机号必须是 11 位以 1 开头的数字' });
                }
            }
            updates.push('requester_phone = ?');
            params.push(phoneVal);
        }
        // oa_request_no 独立字段（部分前端用 oa_request_no 命名传入）
        if (oaChanged) {
            updates.push('oa_request_no = ?');
            params.push(String(req.body.oa_request_no).trim());
        }
        // contact_person_id 可改（仅 PENDING_ASSIGN）
        if (isPendingAssign
            && req.body.contact_person_id !== undefined
            && Number(req.body.contact_person_id) !== existing.contact_person_id) {
            const newContact = validation.contactPerson;
            if (!newContact) {
                return res.status(400).json({ error: '指定的对接人无效', code: 'INVALID_CONTACT_PERSON' });
            }
            updates.push('contact_person_id = ?');
            updates.push('contact_person_name = ?');
            params.push(newContact.id, newContact.display_name || newContact.username);
            // v1.66.1：换对接人时清空对接人钉钉通知跟踪字段（旧对接人的已读痕迹不能沾染新对接人）
            updates.push('contact_notified_at = NULL');
            updates.push('contact_notify_message_key = NULL');
            updates.push('contact_read_at = NULL');
        }

        if (updates.length === 0) return res.json({ message: '无字段需要更新' });

        // 条件 UPDATE：兜底并发漂移（防 SELECT 后状态被推进；PENDING 还要兜底 submission_version 未变 + archived_at 未变）
        params.push(id, existing.status);
        const result = await dbRunAsync(
            `UPDATE collab_requests SET ${updates.join(', ')}
              WHERE id = ?
                AND status = ?
                AND archived_at IS NULL
                AND (submission_version IS NULL OR submission_version = 0)`,
            params
        );
        if (!result || result.changes === 0) {
            return res.status(409).json({
                error: '协作单状态已变化（可能已被指派/提交/作废），请刷新后重试',
                code: 'STATE_CHANGED'
            });
        }

        insertCollabLog(id, 'EDIT', userId, operatorName, null);
        res.json({ message: '已更新' });
    } catch (err) {
        logger.error('编辑协作单失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4.5 软删除协作单（v1.66.2 加，2026-05-19）
//   - 仅 admin
//   - 仅 PENDING_ASSIGN / PENDING + submission_version=0（未提交脚本/附件）
//   - archived_reason 选填（type=string，trim 后 ≤500 字符）
//   - 写 archived_at + archived_reason + archived_by + 'ARCHIVE_SOFT' 操作日志
//   - 列表 endpoint 默认过滤 archived_at IS NULL，需带 ?show_archived=1 才能看到
app.post('/api/collab/requests/:id/archive', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // id 校验（沿用 bypass / assign endpoint 风格）
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // archived_reason 校验（选填，type=string，trim 后 ≤500 字符）
    let reason = null;
    if (req.body && req.body.archived_reason !== undefined && req.body.archived_reason !== null) {
        if (typeof req.body.archived_reason !== 'string') {
            return res.status(400).json({ error: 'archived_reason 必须是字符串', code: 'INVALID_REASON' });
        }
        const trimmed = req.body.archived_reason.trim();
        if (trimmed.length > 500) {
            return res.status(400).json({ error: 'archived_reason 不能超过 500 字符', code: 'REASON_TOO_LONG' });
        }
        reason = trimmed || null;
    }

    try {
        const collab = await dbGetAsync(
            'SELECT id, status, submission_version, archived_at FROM collab_requests WHERE id = ?',
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在' });

        if (collab.archived_at) {
            return res.status(409).json({
                error: '协作单已作废，不可重复作废',
                code: 'ALREADY_ARCHIVED'
            });
        }

        // v1.70.3 业务需求变更：admin 任何非 ARCHIVED 终态都可作废（不再限 PENDING_ASSIGN / PENDING+v0）
        //   - 作废 = 软删除 archived_at 标记，不动 sql_validated_at / done_at / status 等已完成字段（保留历史事实）
        //   - 拒绝 ARCHIVED 终态作废（与 admin-fix 终态保护一致；ARCHIVED 是 admin 主动推到的只读终态）
        //   - archived_at IS NOT NULL（已作废）由上方 ALREADY_ARCHIVED 分支拦截
        if (collab.status === 'ARCHIVED') {
            return res.status(409).json({
                error: '协作单已归档锁定（ARCHIVED 终态），不可作废',
                code: 'ARCHIVED_PROTECTED',
                current_status: collab.status
            });
        }

        // 条件 UPDATE：兜底并发漂移
        //   - status = ? 守卫防 SELECT 后状态变化（如另一 admin 同时把单推到 ARCHIVED；SELECT 已拒 ARCHIVED，
        //     若 SELECT 后被推到 ARCHIVED，status=? 拦截即足够，无需重复 status!='ARCHIVED'，codex 29 审 #3 删冗余）
        //   - archived_at IS NULL 守卫防双作废
        //   - 移除原 submission_version=0 守卫（DONE/SUBMITTED 等有 v>0 的状态也允许作废）
        const result = await dbRunAsync(
            `UPDATE collab_requests
                SET archived_at = datetime('now','localtime'),
                    archived_reason = ?,
                    archived_by = ?
              WHERE id = ?
                AND status = ?
                AND archived_at IS NULL`,
            [reason, userId, id, collab.status]
        );

        if (!result || result.changes === 0) {
            return res.status(409).json({
                error: '协作单状态已变化（可能已被指派/提交/作废），请刷新后重试',
                code: 'STATE_CHANGED'
            });
        }

        insertCollabLog(id, 'ARCHIVE_SOFT', userId, userName, reason);
        logger.info(`[collab-archive] 协作单 #${id} 软删除 by ${userName}${reason ? ` reason=${reason.slice(0, 50)}` : ''}`);

        return res.json({
            message: '协作单已作废',
            id,
            archived_at: new Date().toISOString()
        });
    } catch (e) {
        logger.error(`[collab-archive] 协作单 #${id} 作废异常: ${e.message}`, e);
        return res.status(500).json({ error: '作废失败，请联系管理员', code: 'ARCHIVE_FAILED' });
    }
});

// 4.6 归档锁定协作单（v1.67.1 加，2026-05-20）
//   - 仅 admin
//   - 仅 DONE 可推到 ARCHIVED（已交付 + smoke test 通过的终态）
//   - archived_final_reason 选填（type=string，trim 后 ≤500 字符）
//   - 写 status='ARCHIVED' + archived_final_at + archived_final_reason + archived_final_by + 'ARCHIVE_FINAL' 操作日志
//   - 与 v1.66.2 archived_at 软删除完全独立，互不重叠（软删除是 PENDING_ASSIGN/PENDING 前的撤销；本 endpoint 是 DONE 后的归档锁定）
app.post('/api/collab/requests/:id/archive-final', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // id 校验（沿用 archive / bypass / assign endpoint 风格）
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // archived_final_reason 校验（选填）
    let reason = null;
    if (req.body && req.body.archived_final_reason !== undefined && req.body.archived_final_reason !== null) {
        if (typeof req.body.archived_final_reason !== 'string') {
            return res.status(400).json({ error: 'archived_final_reason 必须是字符串', code: 'INVALID_REASON' });
        }
        const trimmed = req.body.archived_final_reason.trim();
        if (trimmed.length > 500) {
            return res.status(400).json({ error: 'archived_final_reason 不能超过 500 字符', code: 'REASON_TOO_LONG' });
        }
        reason = trimmed || null;
    }

    try {
        const collab = await dbGetAsync(
            'SELECT id, status, archived_at, archived_final_at FROM collab_requests WHERE id = ?',
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在' });

        if (collab.archived_at) {
            return res.status(409).json({
                error: '协作单已作废（软删除），不可归档',
                code: 'ALREADY_SOFT_ARCHIVED'
            });
        }

        if (collab.status === 'ARCHIVED' || collab.archived_final_at) {
            return res.status(409).json({
                error: '协作单已归档，不可重复归档',
                code: 'ALREADY_ARCHIVED_FINAL'
            });
        }

        if (collab.status !== 'DONE') {
            return res.status(409).json({
                error: `当前状态 ${collab.status} 不可归档（仅 DONE 可归档）`,
                code: 'NOT_DONE',
                current_status: collab.status
            });
        }

        // 条件 UPDATE：兜底并发漂移
        const result = await dbRunAsync(
            `UPDATE collab_requests
                SET status = 'ARCHIVED',
                    archived_final_at = datetime('now','localtime'),
                    archived_final_reason = ?,
                    archived_final_by = ?
              WHERE id = ?
                AND status = 'DONE'
                AND archived_at IS NULL
                AND archived_final_at IS NULL`,
            [reason, userId, id]
        );

        if (!result || result.changes === 0) {
            return res.status(409).json({
                error: '协作单状态已变化（可能已被作废/归档），请刷新后重试',
                code: 'STATE_CHANGED'
            });
        }

        insertCollabLog(id, 'ARCHIVE_FINAL', userId, userName, reason);
        logger.info(`[collab-archive-final] 协作单 #${id} 归档锁定 by ${userName}${reason ? ` reason=${reason.slice(0, 50)}` : ''}`);

        // codex 十八审 #4：返回真实落库值（localtime ISO），避免响应时区与 DB 落库值不一致导致前端跳变
        const updated = await dbGetAsync(
            'SELECT archived_final_at FROM collab_requests WHERE id = ?',
            [id]
        );
        return res.json({
            message: '协作单已归档',
            id,
            archived_final_at: updated && updated.archived_final_at ? updated.archived_final_at : null,
            current_status: 'ARCHIVED'
        });
    } catch (e) {
        logger.error(`[collab-archive-final] 协作单 #${id} 归档异常: ${e.message}`, e);
        return res.status(500).json({ error: '归档失败，请联系管理员', code: 'ARCHIVE_FINAL_FAILED' });
    }
});

// ============================================================
// POST /api/collab/requests/:id/create-chat
//   v1.69.0 拉起钉钉沟通群（数据协作模块）
//   三方任一在未归档时可触发；幂等：已建群直接返回旧 chatid
//   群主 = 触发人；群成员固定含示例用户A(ADMIN_ID=3) + 对接人 + 当前 developer(若已指派)
//   钉钉无 disband 服务端 API，群留作历史沟通记录
// ============================================================
const COLLAB_CHAT_ADMIN_ID = 3;  // 示例用户A（user.id=3），数据协作模块固定 admin 群成员
// v1.79.x：内置 admin 占位账号（user.id=1，username=admin）——无真人、无手机号/钉钉号。
//   它不能作为群成员入"拉起讨论群"（拉群会因无钉钉号失败）；平台方角色已由固定群成员示例用户A代表。
const BUILTIN_ADMIN_USER_ID = 1;
// v1.79.x codex 审 medium-1：群成员加入统一走此 helper，排除"内置 admin 占位账号 + 无效/占位 id"。
//   覆盖所有成员来源（触发人 / 对接人 / 开发 / assigned_to），不止触发人那一路——
//   防 id=1 经业务字段（被指派为对接人/开发）进群仍导致拉群失败。Set 自动去重。
//   注意：示例用户A(COLLAB_CHAT_ADMIN_ID=3) 是正整数且 ≠1，走本 helper 照常加入。
function addRealChatMember(memberSet, rawId) {
    const uid = Number(rawId);
    if (Number.isSafeInteger(uid) && uid > 0 && uid !== BUILTIN_ADMIN_USER_ID) {
        memberSet.add(uid);
    }
}

app.post('/api/collab/requests/:id/create-chat', authenticateToken, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const userRole = req.user.role;

    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    // codex M2：userId 正整数守卫（与 developer_id=0/contact_person_id=0 占位策略对齐）
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }

    try {
        const collab = await dbGetAsync(
            `SELECT id, status, archived_at, archived_final_at, oa_request_no,
                    description, requester_name, requester_phone, contact_person_id, developer_id,
                    dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在' });

        if (collab.archived_at) {
            return res.status(409).json({ error: '协作单已作废，不可拉起群聊', code: 'ALREADY_SOFT_ARCHIVED' });
        }
        if (collab.status === 'ARCHIVED' || collab.archived_final_at) {
            return res.status(409).json({ error: '协作单已归档，不可拉起群聊', code: 'ALREADY_ARCHIVED_FINAL' });
        }

        // 权限校验：三方任一（admin / 对接人 / 当前 developer）
        // codex M2：contact_person_id 也显式排除 0 占位值（与 developer_id 一致）
        const isAdmin = userRole === 'admin';
        const isContactPerson = Number(collab.contact_person_id) > 0 && Number(collab.contact_person_id) === userId;
        const isDeveloper = Number(collab.developer_id) > 0 && Number(collab.developer_id) === userId;
        if (!isAdmin && !isContactPerson && !isDeveloper) {
            return res.status(403).json({
                error: '仅 admin / 对接人 / 当前开发可拉起群聊',
                code: 'NOT_ALLOWED'
            });
        }

        // 幂等：已建群直接返回旧值
        if (collab.dingtalk_open_conversation_id) {
            return res.json({
                message: '协作单已有沟通群（请到钉钉客户端查看）',
                id,
                chat_id: collab.dingtalk_chat_id,
                open_conversation_id: collab.dingtalk_open_conversation_id,
                chat_name: collab.dingtalk_chat_name,
                idempotent: true
            });
        }

        // 取凭证
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
        );
        if (!appKey || !appSecret || !robotCode) {
            return res.status(500).json({ error: '钉钉配置未填写，请管理员先到系统配置 → 钉钉配置填写凭证', code: 'NO_DINGTALK_CONFIG' });
        }

        // 构造群成员：示例用户A（固定 admin）+ 对接人 + 当前 developer(若已指派) + 触发人
        // v1.79.x codex 审 medium-1：所有成员来源统一走 addRealChatMember，排除内置 admin(id=1) + 无效/占位 id
        //   （含触发人本是 id=1，或 id=1 被指派为对接人/开发的情况）。示例用户A(3) 正整数 ≠1 照常加入。
        const memberUserIds = new Set();
        addRealChatMember(memberUserIds, COLLAB_CHAT_ADMIN_ID);
        addRealChatMember(memberUserIds, collab.contact_person_id);
        addRealChatMember(memberUserIds, collab.developer_id);
        addRealChatMember(memberUserIds, userId);

        // 拉取所有成员的 dingtalk_user_id
        const memberRows = await dbAllAsync(
            `SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id IN (${[...memberUserIds].map(() => '?').join(',')})`,
            [...memberUserIds]
        );
        if (memberRows.length !== memberUserIds.size) {
            const foundIds = new Set(memberRows.map(r => r.id));
            const missing = [...memberUserIds].filter(uid => !foundIds.has(uid));
            return res.status(400).json({
                error: `群成员账号查询不全，缺失 user.id=${missing.join(',')}`,
                code: 'MEMBER_NOT_FOUND'
            });
        }

        // 取 access_token
        let token;
        try {
            token = await dingtalkNotify.getAccessToken(appKey, appSecret);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'GETTOKEN_FAILED' });
        }

        // v1.70.4 ④ 业务方负责人手机号反查（最佳努力）
        //   - requester_phone 非空 → 正则防御（codex 30 审 #8 后台直写脏数据兜底）→ getUserIdByMobile 反查
        //   - 命中则把业务方真人加入群；未命中/异常 → 静默降级走现有 4 人组逻辑
        //   - 失败不阻塞群创建，仅写脱敏日志（codex 30 审 #5：手机号合规脱敏 138****5678）
        //   - 注意：业务方真人可能不在 users 表里，所以独立拿一个 dingUserId 单独 push 到 dingUserIds，不进 memberRows
        let requesterDingUid = null;
        if (collab.requester_phone) {
            // codex 30 审 #8 防御：反查前再走一次正则，非法值跳过避免传给钉钉
            if (!/^1\d{10}$/.test(collab.requester_phone)) {
                logger.warn(`[collab-create-chat] 协作单 #${id} requester_phone 格式非法（${maskPhone(collab.requester_phone)}），跳过反查降级走现有成员`);
            } else {
                try {
                    const rawDingUid = await dingtalkNotify.getUserIdByMobile(token, collab.requester_phone);
                    // codex 30 审 #6：钉钉 userId 规范化（防字符串/数字/空白脏数据漏匹配）
                    requesterDingUid = rawDingUid != null ? String(rawDingUid).trim() : null;
                    if (requesterDingUid) {
                        logger.info(`[collab-create-chat] 协作单 #${id} 业务方手机号 ${maskPhone(collab.requester_phone)} 反查命中 dingtalk_user_id=${requesterDingUid}`);
                    }
                } catch (err) {
                    const cls = dingtalkNotify.classifyError(err);
                    logger.warn(`[collab-create-chat] 协作单 #${id} 业务方手机号 ${maskPhone(collab.requester_phone)} 反查失败：errcode=${cls.errcode} reason=${cls.reason}，降级走现有成员`);
                    insertCollabLog(id, 'CREATE_CHAT_REQUESTER_LOOKUP_FAIL', userId, userName, `phone=${maskPhone(collab.requester_phone)} errcode=${cls.errcode}`);
                    requesterDingUid = null;
                }
            }
        }

        // 补齐 dingtalk_user_id（缺失的按手机号反查）
        const dingUserIds = [];
        for (const m of memberRows) {
            let dingUid = m.dingtalk_user_id;
            if (!dingUid) {
                if (!m.phone) {
                    return res.status(400).json({
                        error: `${m.display_name || 'user#' + m.id} 未绑定手机号，无法拉入钉钉群`,
                        suggestion: '请到 admin → 用户管理 → 编辑该用户 → 填写手机号后重试',
                        code: 'NO_PHONE',
                        target_user_id: m.id
                    });
                }
                try {
                    dingUid = await dingtalkNotify.getUserIdByMobile(token, m.phone);
                    // codex M3：仅在 dingtalk_user_id 为空时回写，避免并发或手动改过的值被覆盖
                    await dbRunAsync(
                        `UPDATE users SET dingtalk_user_id = ?
                         WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = '')`,
                        [dingUid, m.id]
                    );
                } catch (err) {
                    const cls = dingtalkNotify.classifyError(err);
                    return res.status(502).json({
                        error: `${m.display_name} 钉钉账号查询失败：${cls.hint}`,
                        errcode: cls.errcode, errmsg: cls.errmsg,
                        target_user_id: m.id,
                        code: 'DINGTALK_USER_LOOKUP_FAILED'
                    });
                }
            }
            // v1.70.4 codex 30 审 #6：dingtalk_user_id 归一化（防 users 表脏数据 - 数字/带空白字符）
            const normalizedDingUid = dingUid != null ? String(dingUid).trim() : '';
            dingUserIds.push({ userId: m.id, dingtalk_user_id: normalizedDingUid, display_name: m.display_name });
        }

        // v1.70.4 ④ 业务方真人加入群（最佳努力，反查命中才加）
        //   - 不进 users 表，所以没有 userId（platform 内部用户 id）；用 0 占位但 dingtalk_user_id 是真实的
        //   - 去重保护：钉钉接口本身对重复 userId 会忽略，但本地也做 set 防御
        //   - codex 30 审 #6：两侧 dingtalk_user_id 已归一化为 trim 后字符串，严格相等可靠
        if (requesterDingUid) {
            const dupExisting = dingUserIds.some(u => u.dingtalk_user_id === requesterDingUid);
            if (!dupExisting) {
                dingUserIds.push({
                    userId: 0,  // 平台无对应账号
                    dingtalk_user_id: requesterDingUid,
                    display_name: `${collab.requester_name || '业务方'}（业务方）`
                });
            }
        }

        // v1.71.2 (5/25)：群主始终固定为示例用户A（COLLAB_CHAT_ADMIN_ID），方便示例用户A有意识地解散群（钉钉无服务端 disband API）
        // 原逻辑：找触发人当群主 → 谁拉群谁是 owner，群解散需联系当时拉群人，admin 不便统一收口
        // 现逻辑：固定为 COLLAB_CHAT_ADMIN_ID；示例用户A本来就在 memberUserIds 中（line 10854），useridlist 必含示例用户A，满足钉钉硬约束
        const owner = dingUserIds.find(u => u.userId === COLLAB_CHAT_ADMIN_ID);
        if (!owner) {
            // 理论不触发：line 10854 已强制 add(COLLAB_CHAT_ADMIN_ID)，缺失会在 line 10864 提前 return MEMBER_NOT_FOUND
            // 这里作为防御性兜底，避免示例用户A users 记录被 admin 误删后 endpoint 静默继续
            return res.status(500).json({ error: '平台群主（示例用户A）钉钉账号未找到', code: 'OWNER_NOT_FOUND' });
        }

        // 群名：[OA-{oa_request_no}] {requester_name} {YYYY-MM-DD}（≤20 字符兜底截断）
        // v1.69.3 修复 OA- 前缀重复（admin 录入的 oa_request_no 可能已带 OA-/TEST-OA- 前缀）
        const rawOa = collab.oa_request_no || `id${id}`;
        const oa = rawOa.replace(/^(test-)?oa-?/i, '');
        const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        let chatName = `[OA-${oa}] ${collab.requester_name || ''} ${today}`;
        if (chatName.length > 20) chatName = chatName.slice(0, 20);

        // 调钉钉建群
        let chatCreateResult;
        try {
            chatCreateResult = await dingtalkNotify.createChatGroup(
                token,
                chatName,
                owner.dingtalk_user_id,
                dingUserIds.map(u => u.dingtalk_user_id)
            );
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            insertCollabLog(id, 'CREATE_CHAT_FAIL', userId, userName, `chat/create:${cls.reason}`);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'CHAT_CREATE_FAILED' });
        }
        if (chatCreateResult.errcode !== 0) {
            const cls = dingtalkNotify.classifyError(chatCreateResult);
            insertCollabLog(id, 'CREATE_CHAT_FAIL', userId, userName, `chat/create:errcode=${chatCreateResult.errcode}`);
            return res.status(502).json({
                error: cls.hint, errcode: chatCreateResult.errcode, errmsg: chatCreateResult.errmsg,
                reason: cls.reason, code: 'CHAT_CREATE_REJECTED'
            });
        }

        const newChatId = chatCreateResult.chatid;
        const newOpenConvId = chatCreateResult.openConversationId;

        // codex H1+H2+M1：条件 UPDATE 兜底三重风险
        //   1. dingtalk_open_conversation_id IS NULL → 并发同时建群时，后写入者落不进库（H2）
        //   2. archived_at/final_at/status 守卫 → 建群中协作单被归档/作废时拒绝落库（M1）
        //   3. UPDATE 失败 → 结构化打印 collab_id/chatid/openConversationId 供管理员手工补录（H1）
        // 钉钉无 disband 服务端 API，落库失败后群已存在但平台不可见，需要手工修复
        let updateResult;
        try {
            updateResult = await dbRunAsync(
                `UPDATE collab_requests
                    SET dingtalk_chat_id = ?,
                        dingtalk_open_conversation_id = ?,
                        dingtalk_chat_created_at = datetime('now','localtime'),
                        dingtalk_chat_created_by = ?,
                        dingtalk_chat_name = ?
                  WHERE id = ?
                    AND archived_at IS NULL
                    AND archived_final_at IS NULL
                    AND status <> 'ARCHIVED'
                    AND dingtalk_open_conversation_id IS NULL`,
                [newChatId, newOpenConvId, userId, chatName, id]
            );
        } catch (dbErr) {
            // H1：DB exception 时把已建群信息结构化记到日志，便于管理员按 SQL 补录
            logger.error(`[collab-create-chat] CRITICAL 钉钉群已建但落库异常 collab_id=${id} chatid=${newChatId} open_conversation_id=${newOpenConvId} chat_name=${chatName} created_by=${userId}(${userName}) error=${dbErr.message}`);
            insertCollabLog(id, 'CREATE_CHAT_DB_FAILED', userId, userName, `chatid=${newChatId} open_conv_id=${newOpenConvId} err=${dbErr.message}`);
            return res.status(500).json({
                error: '钉钉群已创建但平台落库失败，请联系管理员手工补录（详见后端日志 CREATE_CHAT_DB_FAILED）',
                code: 'CHAT_CREATED_DB_UPDATE_FAILED',
                chat_id: newChatId,
                open_conversation_id: newOpenConvId,
                chat_name: chatName
            });
        }
        if (!updateResult || updateResult.changes === 0) {
            // H2+M1：守卫未通过 → 协作单在 chat/create 期间被归档/作废 或 别人已抢先建群
            // 重新读 db 决定返回路径
            const refreshed = await dbGetAsync(
                'SELECT status, archived_at, archived_final_at, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name FROM collab_requests WHERE id = ?',
                [id]
            );
            // 别人抢先建群 → 退化为幂等返回（旧群信息），把本次新建的群孤儿信息记日志
            if (refreshed && refreshed.dingtalk_open_conversation_id) {
                logger.warn(`[collab-create-chat] 并发竞态：协作单 #${id} 另一请求已先落库（${refreshed.dingtalk_chat_id}），本次新建群信息丢弃 chatid=${newChatId} open_conv_id=${newOpenConvId}`);
                insertCollabLog(id, 'CREATE_CHAT_RACE_DROP', userId, userName, `dropped chatid=${newChatId}, kept=${refreshed.dingtalk_chat_id}`);
                return res.json({
                    message: '协作单已有沟通群（您本次新建的群因并发竞态被舍弃，请群主在钉钉客户端解散）',
                    id,
                    chat_id: refreshed.dingtalk_chat_id,
                    open_conversation_id: refreshed.dingtalk_open_conversation_id,
                    chat_name: refreshed.dingtalk_chat_name,
                    idempotent: true,
                    race_dropped_chat_id: newChatId
                });
            }
            // 否则是归档/作废守卫拦下 → 群已建但协作单已锁定，记日志返回 STATE_CHANGED
            logger.error(`[collab-create-chat] STATE_CHANGED 协作单 #${id} 在 chat/create 期间被归档/作废 chatid=${newChatId} open_conv_id=${newOpenConvId} chat_name=${chatName} created_by=${userId}(${userName})`);
            insertCollabLog(id, 'CREATE_CHAT_STATE_CHANGED', userId, userName, `chatid=${newChatId} open_conv_id=${newOpenConvId}`);
            return res.status(409).json({
                error: '协作单状态已变化（可能已被作废/归档），群已建出但未关联到协作单，请群主在钉钉客户端手动解散',
                code: 'STATE_CHANGED',
                chat_id: newChatId,
                open_conversation_id: newOpenConvId
            });
        }
        insertCollabLog(id, 'CREATE_CHAT', userId, userName, `chatid=${newChatId}`);
        logger.info(`[collab-create-chat] 协作单 #${id} 拉群成功 by ${userName} chatid=${newChatId}`);

        // 发欢迎卡片 + 一段话（best-effort，失败不影响主流程）
        const descText = String(collab.description || '').slice(0, 30);
        const cardTitle = `关于 OA-${oa} 「${descText}」需求取数沟通群`;
        const cardMarkdown = [
            `## 协作单沟通群已创建`,
            ``,
            `**协作单**：OA-${oa}`,
            `**业务方**：${collab.requester_name || '-'}`,
            `**需求描述**：${dingtalkNotify.escapeMarkdown(descText)}`,
            `**拉群人**：${userName}`,
            ``,
            `> 请相关方在群内同步上下文，推进协作单。`
        ].join('\n');
        try {
            const cardResp = await dingtalkNotify.sendGroupMessage(token, robotCode, newOpenConvId, 'sampleMarkdown', { title: cardTitle, text: cardMarkdown });
            if (cardResp && cardResp.code) {
                logger.warn(`[collab-create-chat] #${id} 群卡片发送失败 code=${cardResp.code} msg=${cardResp.message || ''}`);
            }
            const plainText = `关于 OA-${oa} 「${descText}」需求取数沟通群`;
            const textResp = await dingtalkNotify.sendGroupMessage(token, robotCode, newOpenConvId, 'sampleText', { content: plainText });
            if (textResp && textResp.code) {
                logger.warn(`[collab-create-chat] #${id} 群文本发送失败 code=${textResp.code} msg=${textResp.message || ''}`);
            }
        } catch (err) {
            logger.warn(`[collab-create-chat] #${id} 群消息发送异常（不影响建群）: ${err.message}`);
        }

        return res.json({
            message: '沟通群已创建，请到钉钉客户端查看（钉钉无解散接口，使用完后由群主在客户端手动解散）',
            id,
            chat_id: newChatId,
            open_conversation_id: newOpenConvId,
            chat_name: chatName,
            member_count: dingUserIds.length,
            idempotent: false
        });
    } catch (e) {
        logger.error(`[collab-create-chat] 协作单 #${id} 拉群异常: ${e.message}`, e);
        return res.status(500).json({ error: '拉群失败，请联系管理员', code: 'CREATE_CHAT_FAILED' });
    }
});

// ============================================================
// 钉钉公用发送路径（v3 二级转派抽取，2026-05-19）
// 输入：targetUser 必须含 { id, display_name, phone, dingtalk_user_id }
//       title + markdown + operatorInfo { id, name } 用于审计日志
// 输出：{ ok, status, body }
//        - ok=true 时 status=200 + body={message, target_user_name, notified_at, processQueryKey}
//        - ok=false 时 status=4xx/5xx + body 含 error/errcode/errmsg/reason/suggestion
// 副作用：成功时返回 processQueryKey 让调用方决定是否落 notify_message_key（创建模板才需要落）
// best-effort 调用方：拿 result 不要 throw；按 ok 分支处理或仅记日志
// ============================================================
async function sendCollabDingtalkRaw(collabId, targetUser, title, markdown, operatorInfo) {
    // 1. 取凭证
    const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
    );
    if (!appKey || !appSecret || !robotCode) {
        return { ok: false, status: 500, body: { error: '钉钉配置未填写,请管理员先到系统配置 → 钉钉配置填写凭证', reason: 'no_config' } };
    }

    // 2. phone 校验
    if (!targetUser.phone) {
        return {
            ok: false, status: 400,
            body: {
                error: `${targetUser.display_name || 'user#' + targetUser.id} 未绑定手机号`,
                suggestion: '请到 admin → 用户管理 → 编辑该用户 → 填写手机号后重试',
                reason: 'no_phone'
            }
        };
    }

    // 3. 取 access_token
    let token;
    try {
        token = await dingtalkNotify.getAccessToken(appKey, appSecret);
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `gettoken:${cls.reason}`);
        return { ok: false, status: 502, body: { error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason } };
    }

    // 4. dingtalk_user_id 缓存
    let dingUserId = targetUser.dingtalk_user_id;
    if (!dingUserId) {
        try {
            dingUserId = await dingtalkNotify.getUserIdByMobile(token, targetUser.phone);
            await dbRunAsync('UPDATE users SET dingtalk_user_id = ? WHERE id = ?', [dingUserId, targetUser.id]);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `get_by_mobile:${cls.reason}`);
            return {
                ok: false, status: 400,
                body: {
                    error: '钉钉用户查询失败',
                    detail: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg,
                    suggestion: '请确认手机号已加入企业钉钉',
                    reason: cls.reason
                }
            };
        }
    }

    // 5. 发送 + token_expired 伪重试一次
    async function doSend(useToken) {
        return await dingtalkNotify.sendMarkdownToUser(useToken, robotCode, [dingUserId], title, markdown);
    }

    let sendResult;
    try {
        sendResult = await doSend(token);
    } catch (err) {
        const cls = dingtalkNotify.classifyError(err);
        insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `send:${cls.reason}`);
        return { ok: false, status: 502, body: { error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason } };
    }

    if (sendResult.errcode && sendResult.errcode !== 0) {
        const cls = dingtalkNotify.classifyError(sendResult);
        if (cls.reason === 'token_expired') {
            dingtalkNotify.clearCachedToken();
            try {
                const freshToken = await dingtalkNotify.getAccessToken(appKey, appSecret);
                sendResult = await doSend(freshToken);
            } catch (retryErr) {
                const retryCls = dingtalkNotify.classifyError(retryErr);
                insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `retry:${retryCls.reason}`);
                return { ok: false, status: 502, body: { error: retryCls.hint, errcode: retryCls.errcode, reason: retryCls.reason } };
            }
            if (sendResult.errcode && sendResult.errcode !== 0) {
                const retryCls2 = dingtalkNotify.classifyError(sendResult);
                insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `retry:${retryCls2.reason}`);
                return { ok: false, status: 502, body: { error: retryCls2.hint, errcode: retryCls2.errcode, errmsg: retryCls2.errmsg, reason: retryCls2.reason } };
            }
        } else {
            if (cls.clearUserId) {
                await dbRunAsync('UPDATE users SET dingtalk_user_id = NULL WHERE id = ?', [targetUser.id]);
            }
            insertCollabLog(collabId, 'NOTIFY_FAIL', operatorInfo.id, operatorInfo.name, `send:${cls.reason}`);
            return { ok: false, status: 502, body: { error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason } };
        }
    }

    return {
        ok: true, status: 200,
        body: {
            target_user_name: targetUser.display_name,
            notified_at: new Date().toISOString(),
            processQueryKey: sendResult.processQueryKey || null
        }
    };
}

// 取协作单 + target_db_name 的辅助（钉钉模板拼装需要）
async function getCollabWithDbName(id) {
    return await dbGetAsync(
        `SELECT c.*, dc.name AS target_db_name
         FROM collab_requests c
         LEFT JOIN db_connections dc ON dc.id = c.target_db_connection_id
         WHERE c.id = ?`,
        [id]
    );
}

// 5. 触发钉钉通知（v3 二级转派改造：admin 在 PENDING_ASSIGN/PENDING 状态可调）
// 流程:取协作单 → 按状态选模板 + 收件人 →（PENDING_ASSIGN 发对接人创建模板；PENDING 发开发指派模板）
//      → sendCollabDingtalkRaw → 仅 PENDING 时落 notified_at + processQueryKey（已读回执跟踪用，对应开发端首次指派）
// v3 注意：原 v2.0 PENDING 状态发开发的语义保留；新增 PENDING_ASSIGN 发对接人。已读回执（notify_message_key）只在
//        "发开发"成功时落（PENDING 路径），因为对接人接收的"创建模板"不需要已读跟踪。
// codex 十六审 #3 high 权限拆分：
//   - PENDING_ASSIGN：仅 admin 可调（通知对接人）
//   - PENDING：admin 或本单 contact_person 可调（通知开发；对接人指派后能自助通知）
// codex 十六审 #4 high：notify 重发 PENDING 时同步清空 read_at（避免旧 processQueryKey 已读时间复用）
app.post('/api/collab/requests/:id/notify', authenticateToken, requireNonViewer, async (req, res) => {
    const { id } = req.params;
    try {
        const collab = await getCollabWithDbName(id);
        if (!collab) return res.status(404).json({ error: '协作单不存在' });
        // v1.72.3：扩展 EXPORTING 状态支持通知 exporter
        if (collab.status !== 'PENDING_ASSIGN'
            && collab.status !== 'PENDING'
            && collab.status !== 'EXPORTING') {
            return res.status(409).json({ error: `当前状态 ${collab.status} 不可发送通知（仅 PENDING_ASSIGN / PENDING / EXPORTING 可触发）` });
        }

        // codex 十六审 #3：按状态分支权限
        const currentUserId = Number(req.user.id);
        const isAdmin = req.user.role === 'admin';
        if (collab.status === 'PENDING_ASSIGN' && !isAdmin) {
            return res.status(403).json({ error: 'PENDING_ASSIGN 状态仅 admin 可发送通知', code: 'NOT_NOTIFIER' });
        }
        if (collab.status === 'PENDING') {
            const isContactPerson = Number(collab.contact_person_id) === currentUserId;
            if (!isAdmin && !isContactPerson) {
                return res.status(403).json({ error: '仅 admin 或本单对接人可发送通知', code: 'NOT_NOTIFIER' });
            }
        }
        // v1.72.3：EXPORTING 状态权限分支
        //   - admin_direct 模式：仅 admin 可通知（与 admin 直派权限对齐）
        //   - normal 模式：admin / 对接人 / 开发 都可通知（forward 后想"重发"通知 exporter 用）
        if (collab.status === 'EXPORTING') {
            if (collab.assign_mode === 'admin_direct') {
                if (!isAdmin) {
                    return res.status(403).json({
                        error: 'admin 直派模式 EXPORTING 状态仅 admin 可通知',
                        code: 'NOT_NOTIFIER'
                    });
                }
            } else {
                const isContactPerson = Number(collab.contact_person_id) === currentUserId;
                const isDeveloper = Number(collab.developer_id) === currentUserId;
                if (!isAdmin && !isContactPerson && !isDeveloper) {
                    return res.status(403).json({
                        error: '仅 admin / 对接人 / 开发可发送通知',
                        code: 'NOT_NOTIFIER'
                    });
                }
            }
        }

        const platformBaseUrl = await readSystemConfig('platform_base_url');

        // 按状态选收件人 + 模板
        let targetUserId, title, markdown, opLogType;
        if (collab.status === 'PENDING_ASSIGN') {
            targetUserId = collab.contact_person_id;
            title = `待指派协作单 · ${collab.requester_dept}`;
            markdown = dingtalkNotify.buildCollabCreatedCard(collab, platformBaseUrl);
            opLogType = 'NOTIFY_CONTACT';
        } else if (collab.status === 'PENDING') {
            targetUserId = collab.developer_id;
            title = `新临时取数任务 · ${collab.requester_dept}`;
            markdown = dingtalkNotify.buildCollabAssignedCard(collab, platformBaseUrl);
            opLogType = 'NOTIFY';
        } else {
            // v1.72.3：EXPORTING 状态通知 exporter
            targetUserId = collab.exporter_user_id;
            const isDirect = collab.assign_mode === 'admin_direct';
            title = isDirect
                ? `数据导出任务 · admin 直派 · ${collab.requester_dept}`
                : `数据导出任务 · ${collab.requester_dept}`;
            markdown = dingtalkNotify.buildCollabExporterNotifyCard(collab, platformBaseUrl);
            opLogType = isDirect ? 'NOTIFY_EXPORTER_DIRECT' : 'NOTIFY_EXPORTER';
        }

        if (!targetUserId || Number(targetUserId) === 0) {
            // v1.72.3 codex 32 审 H-1 采纳：admin 直派切回流转的特殊错误细化
            //   切回流转后 status=PENDING_ASSIGN + assign_mode='admin_direct' + contact_person_id=0
            //   admin 需要先点"编辑协作单"补齐 D1 才能通知
            if (collab.status === 'PENDING_ASSIGN'
                && collab.assign_mode === 'admin_direct'
                && (!collab.contact_person_id || Number(collab.contact_person_id) === 0)) {
                return res.status(400).json({
                    error: '该单是 admin 直派切回流转单，请先点"编辑协作单"补齐对接人后再通知',
                    code: 'CONTACT_PERSON_NOT_ASSIGNED_AFTER_FALLBACK'
                });
            }
            return res.status(400).json({ error: '收件人未定（PENDING_ASSIGN 需有对接人，PENDING 需已指派开发，EXPORTING 需已指派数据导出人）' });
        }

        const targetUser = await dbGetAsync(
            'SELECT id, display_name, phone, dingtalk_user_id, status FROM users WHERE id = ?',
            [targetUserId]
        );
        if (!targetUser) return res.status(400).json({ error: '收件人账号不存在' });
        if (targetUser.status !== 'active') return res.status(400).json({ error: `收件人 ${targetUser.display_name} 已停用` });

        const operatorInfo = { id: req.user.id, name: req.user.display_name || req.user.username };
        const result = await sendCollabDingtalkRaw(id, targetUser, title, markdown, operatorInfo);
        if (!result.ok) return res.status(result.status).json(result.body);

        // 成功：按状态分支落不同字段组
        // - PENDING_ASSIGN：落 contact_notified_at + contact_notify_message_key（v1.66.1 加，对接人已读跟踪）+ 清 contact_read_at
        // - PENDING：落 notified_at + notify_message_key（开发已读跟踪）+ 清 read_at
        // codex 十六审 #4：重发时清对应路径的 read_at —— 旧 processQueryKey 的"已读时间"不能复用到新 processQueryKey
        if (collab.status === 'PENDING_ASSIGN') {
            await dbRunAsync(
                "UPDATE collab_requests SET contact_notified_at = datetime('now','localtime'), contact_notify_message_key = ?, contact_read_at = NULL WHERE id = ?",
                [result.body.processQueryKey, id]
            );
        } else if (collab.status === 'PENDING') {
            await dbRunAsync(
                "UPDATE collab_requests SET notified_at = datetime('now','localtime'), notify_message_key = ?, read_at = NULL WHERE id = ?",
                [result.body.processQueryKey, id]
            );
        }
        insertCollabLog(id, opLogType, operatorInfo.id, operatorInfo.name, null);

        // 兼容旧前端字段名 developer_name（D2 钉钉模块原返回字段）
        res.json({
            message: '通知已发送',
            developer_name: result.body.target_user_name,  // 兼容旧字段名
            target_user_name: result.body.target_user_name,
            notified_at: result.body.notified_at
        });
    } catch (err) {
        logger.error('POST /api/collab/requests/:id/notify 失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. 查询钉钉已读状态(Day 3 增补 · 方案 1 pull 模式)
// 钉钉端约定:消息发出后 24h 内可查;processQueryKey 在 notify 成功时已落到对应 message_key 列
// v1.66.1 加 ?recipient=contact|developer 参数：
//   - recipient=developer（默认，向后兼容）：查 notify_message_key + 落 read_at（PENDING/SUBMITTED+ 用）
//   - recipient=contact：查 contact_notify_message_key + 落 contact_read_at（PENDING_ASSIGN 用）
//   - recipient=requester_done（2026-05-29 导出通知业务方）：查 done_notify_message_key + 落 done_read_at（DONE 后通知业务方用）
//     done_read_at 语义 = 业务方已读"完成通知"，不代表下载/打开 xlsx（codex 53 M-1）
app.get('/api/collab/requests/:id/notify-read-status', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const recipient = (req.query.recipient || 'developer').toLowerCase();
    if (recipient !== 'contact' && recipient !== 'developer' && recipient !== 'requester_done') {
        return res.status(400).json({ error: '无效的 recipient 值（合法值：contact/developer/requester_done）' });
    }

    // 字段名映射：选不同字段组
    // ⚠️ fieldMap 各值仅内部常量（拼进 SELECT），禁止接入任何用户输入（codex 79 L-2）
    // 2026-06-09 codex 78 H-3：requester_done 收件人 = 业务方负责人（requester_phone 反查钉钉，
    //   无平台账号不走 users 表）——原 user_id:'contact_person_id' 在 admin 直派单 =0 查不到用户，
    //   且发送端已改 requester_phone 反查，已读比对必须用同一收件人 userid 否则永远 false
    const isRequesterDone = recipient === 'requester_done';
    const fieldMap = isRequesterDone
        ? {
            notified_at: 'done_notified_at',
            message_key: 'done_notify_message_key',
            read_at: 'done_read_at',
            user_id: 'NULL',  // 业务方负责人不在 users 表，收件人 userid 由 requester_phone 反查
            label: '业务方（完成通知）',
        }
        : recipient === 'contact'
        ? {
            notified_at: 'contact_notified_at',
            message_key: 'contact_notify_message_key',
            read_at: 'contact_read_at',
            user_id: 'contact_person_id',
            label: '对接人',
        }
        : {
            notified_at: 'notified_at',
            message_key: 'notify_message_key',
            read_at: 'read_at',
            user_id: 'developer_id',
            label: '开发',
        };

    try {
        const collab = await dbGetAsync(
            `SELECT id, ${fieldMap.user_id} AS recipient_user_id,
                    requester_name, requester_phone,
                    ${fieldMap.notified_at} AS notified_at,
                    ${fieldMap.message_key} AS message_key,
                    ${fieldMap.read_at} AS read_at
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在' });
        if (!collab.notified_at) return res.status(400).json({ error: `尚未通知${fieldMap.label},无法查询已读状态` });

        // requester_done 收件人显示名 = 业务方负责人姓名（非 users 表用户，2026-06-09 codex 78 H-3）
        const resolveDisplayName = async () => {
            if (isRequesterDone) return collab.requester_name || '业务方负责人';
            const u = await dbGetAsync('SELECT display_name FROM users WHERE id = ?', [collab.recipient_user_id]);
            return u && u.display_name;
        };

        // 已固化 read_at → 直接返回,不再调钉钉(钉钉无"取消已读"语义,固化值即终态)
        if (collab.read_at) {
            const name0 = await resolveDisplayName();
            return res.json({
                recipient,
                notified_at: collab.notified_at,
                // 兼容旧前端字段名（recipient=developer 时返 developer_name；recipient=contact 时返 contact_person_name 风格）
                developer_name: name0,
                recipient_name: name0,
                read: true,
                read_at: collab.read_at,
                cached: true,
                queried_at: new Date().toISOString()
            });
        }

        // codex 56-D M-1：message_key 缺失校验放在 24h 判断【之前】——
        //   老协作单/钉钉未返消息号时仍返原 400（不改变 contact/developer 既有语义，避免回归）
        if (!collab.message_key) {
            return res.status(400).json({ error: `该${fieldMap.label}通知缺少消息标识,无法查询已读状态(老协作单或钉钉端未返回消息号)` });
        }

        // codex 53 M-2：24h 查询窗口（钉钉端约定消息发出后 24h 内可查）——三路一致顺手补齐
        //   未固化 read_at 且 notified_at 超 24h → 停查钉钉，返 unread_expired（避免前端长期空查钉钉）
        //   注：24h 判断在 message_key 校验之后，只作用于"真发过通知"的单（codex 56-D M-1）
        //   L-1：notified_at 为 SQLite datetime('now','localtime') 格式，Date.parse 按 Node 进程本地时区解析，
        //        隐式依赖"Node TZ == SQLite localtime TZ"（当前生产单机一致）。24h 是软边界，时区偏移几小时无实质影响。
        const notifiedMs = Date.parse(String(collab.notified_at).replace(' ', 'T'));
        if (Number.isFinite(notifiedMs) && (Date.now() - notifiedMs) > 24 * 60 * 60 * 1000) {
            const nameExp = await resolveDisplayName();
            return res.json({
                recipient,
                notified_at: collab.notified_at,
                developer_name: nameExp,
                recipient_name: nameExp,
                read: false,
                read_at: null,                  // M-2：与现有 read:false 分支字段对齐
                read_status: 'unread_expired',  // 未读且已超钉钉可查询窗口
                read_user_count: 0,             // M-2：与现有分支字段对齐
                queried_at: new Date().toISOString()
            });
        }

        // 取钉钉凭证(readStatus 需要 robotCode)
        const [appKey, appSecret, robotCode] = await Promise.all([
            readSystemConfig('dingtalk_app_key'),
            readSystemConfig('dingtalk_app_secret'),
            readSystemConfig('dingtalk_robot_code')
        ]);
        if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写' });

        let token;
        try {
            token = await dingtalkNotify.getAccessToken(appKey, appSecret);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, reason: cls.reason });
        }

        // 取收件人的 dingtalk userid 做对照
        //   2026-06-09 codex 78 H-3：requester_done 走 requester_phone 反查（与发送端同一收件人，
        //   业务方负责人不在 users 表）；contact/developer 两路维持 users 表查询不变
        let recipientDingUserId = null;
        let recipientDisplayName = null;
        if (isRequesterDone) {
            // codex 79 M-2：错误码与发送端分层一致（phone 空 / 查不到人分开）；
            // codex 79 M-1：502 固定文案，不拼 hint（钉钉 errmsg 可能回显手机号）
            const resolved = await dingtalkNotify.resolveRequesterDingUserId(token, collab.requester_phone);
            if (!resolved.ok) {
                if (resolved.reason === 'requester_phone_empty') {
                    return res.status(400).json({ error: '业务方负责人手机号为空，无法比对已读', code: 'REQUESTER_PHONE_EMPTY', reason: resolved.reason });
                }
                if (resolved.reason === 'requester_invalid') {
                    return res.status(400).json({ error: '业务方手机号查不到企业钉钉号，无法比对已读', code: 'REQUESTER_INVALID', reason: resolved.reason });
                }
                return res.status(502).json({ error: '业务方钉钉号查询失败，请稍后重试', code: 'REQUESTER_LOOKUP_FAILED', reason: resolved.reason });
            }
            recipientDingUserId = resolved.userid;
            recipientDisplayName = collab.requester_name || '业务方负责人';
        } else {
            const recipientUser = await dbGetAsync(
                'SELECT id, display_name, dingtalk_user_id FROM users WHERE id = ?',
                [collab.recipient_user_id]
            );
            recipientDingUserId = recipientUser && recipientUser.dingtalk_user_id;
            recipientDisplayName = recipientUser && recipientUser.display_name;
        }

        // 调钉钉已读 API
        let readResult;
        try {
            readResult = await dingtalkNotify.getReadStatus(token, robotCode, collab.message_key);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return res.status(502).json({ error: cls.hint, errcode: cls.errcode, reason: cls.reason });
        }

        // 钉钉错误响应(errcode!=0)
        if (readResult.raw && readResult.raw.errcode && readResult.raw.errcode !== 0) {
            const cls = dingtalkNotify.classifyError(readResult.raw);
            return res.status(502).json({
                error: cls.hint,
                errcode: cls.errcode,
                errmsg: cls.errmsg,
                reason: cls.reason
            });
        }

        // 成功:判断收件人 userId 是否在已读列表里
        const isRead = recipientDingUserId && readResult.readUserIds.includes(recipientDingUserId);

        // 提取 readTimestamp 转本地时间字符串
        let readAt = null;
        if (isRead && Array.isArray(readResult.readDetails)) {
            const myEntry = readResult.readDetails.find(item => item.userId === recipientDingUserId && item.readStatus === 'READ');
            if (myEntry && myEntry.readTimestamp) {
                const d = new Date(myEntry.readTimestamp * 1000);
                const pad = (n) => String(n).padStart(2, '0');
                readAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            }
        }

        // 首次查到 READ → 固化到对应 read_at 列（按 recipient 写不同字段）
        if (readAt && !collab.read_at) {
            await dbRunAsync(`UPDATE collab_requests SET ${fieldMap.read_at} = ? WHERE id = ?`, [readAt, id]);
        }

        res.json({
            recipient,
            notified_at: collab.notified_at,
            developer_name: recipientDisplayName,  // 兼容旧前端
            recipient_name: recipientDisplayName,
            read: !!isRead,
            read_at: readAt,
            read_user_count: readResult.readUserIds.length,
            queried_at: new Date().toISOString()
        });
    } catch (err) {
        logger.error('GET /api/collab/requests/:id/notify-read-status 失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4.5 提交开发交付物（D3 模块 4）— 端到端：上传 + smoke test + 版本激活
//
// 方案 §6.2 + codex 九审 13 条全采纳（见 docs/local/codex审查记录/数据协作模块/10-D3-模块4-提交API-取舍审-20260513.md）
// codex 十审实施后审查见 11-D3-模块4-代码审-20260513.md（11 条全采纳：8 修 + 3 改注释）
//
// 依赖（codex 十审 #9 隐式依赖标注）：
//   - decryptPassword(encryptedHex)        server.js:1417 同文件共享函数，AES-256-CBC 解密
//   - getMssqlPool(connConfig)             server.js:1436 同文件共享函数，连接池
//   - insertCollabLog(reqId, type, ...)    server.js:9690 同文件共享函数，操作日志
//   - dbGetAsync / dbRunAsync / dbAllAsync server.js:86-100 sqlite3 promise 包装
//   - COLLAB_UPLOAD_BASE                   server.js:9684 uploads/collab 绝对路径
//   - collabUpload                         server.js:9780 multer 实例
//   - collabVersioning / collabSubmitHelpers  utils/ 下独立模块（require 在顶部）
//
// 状态机编排（codex C1，对照表见上述归档文档 §"状态 × 结果 × DB 更新 × 文件去向 对照表"）：
//   1. multer 落盘到 _pending/{id}/
//   2. 前置校验（id 正则 / 存在 / 状态 / 权限 / 文件分类）→ 任一失败 cleanupPendingFiles + 返回错误
//   3. 前置 UPDATE：status → SUBMITTED + last_submitted_at（带 submission_version=oldVer 乐观锁，C3）
//   4. 取目标库连接配置 + 解密密码
//   5. 调 activateNewVersion，runSmokeTest 注入 runRealSmokeTest 闭包
//   6. activateNewVersion 成功 → 后置 UPDATE：status → DONE + sql_validated_at（带乐观锁）
//   7. activateNewVersion 失败：
//      - INCOMPLETE_SNAPSHOT/PATH_VIOLATION → 已 cleanupMovedFiles，cleanupPendingFiles 兜底
//      - SMOKE_TEST_FAILED → 写 sql_validation_status='failed' + sql_validation_error（带乐观锁，C3）
//      - CONCURRENT_SUBMIT → activateNewVersion 已挪到 _orphaned/，409 含 orphanedDir
//      - 其他 → 500 + 通用提示
//
// 单方言（方案 §6.1-A）：目标库必须 type='sqlserver'
app.post('/api/collab/requests/:id/submit',
    authenticateToken,
    requireNonViewer,
    // 取数质量双校验 schema 守门（Commit C 接入点）——双校验列/索引迁移未就绪时本入口 503，
    // 防止 ALTER 失败被吞后 recordQualityForDeveloperSubmit 运行期 SQL 崩（方案 §3.0 codex 30#1 范式）
    requireCollabQualityDualCheckSchemaReady,
    // multer 错误捕获（codex 十审 #1）— multer 是前置中间件，
    // 它抛的 MulterError（超数量/大小/类型）会走 Express error flow，
    // endpoint 内 try/catch 接不到，所以这里手动调 upload(req, res, cb)
    (req, res, next) => {
        collabUpload.array('files', 2)(req, res, (err) => {
            if (!err) return next();
            // multer 错误统一转 JSON（codex L1 决策落地）
            const isMulterErr = err && err.name === 'MulterError';
            const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
            // 文件可能已部分落盘，清理（注意 req.files 此时可能 undefined）
            try { collabSubmitHelpers.cleanupPendingFiles(req.files, logger); } catch (_) { /* ignore */ }
            logger.warn(`[collab-submit] multer error: code=${code} msg=${err.message}`);
            return res.status(400).json({
                error: '上传文件失败',
                code,
                // multer 自带的 message 通常是英文短句（"Too many files" 等），可直接给前端做提示
                detail: isMulterErr ? err.message : '上传过程异常',
            });
        });
    },
    async (req, res) => {
        const idStr = req.params.id;
        const userId = req.user.id;
        const userName = req.user.username || req.user.display_name || `user#${userId}`;

        // helper：安全清理 multer pending 文件（包装一下传 logger）
        const cleanupPending = () => collabSubmitHelpers.cleanupPendingFiles(req.files, logger);

        // === 前置校验：id 严格正则（codex M1）===
        if (!/^[1-9]\d*$/.test(idStr)) {
            cleanupPending();
            return res.status(400).json({ error: 'id 必须是正整数' });
        }
        const id = parseInt(idStr, 10);

        try {
            // === 前置校验：协作单存在 ===
            const collab = await dbGetAsync(
                `SELECT id, status, developer_id, target_db_connection_id, submission_version,
                        description, attachment_dir, submitted_at,
                        oa_request_no, created_at
                   FROM collab_requests WHERE id = ?`,
                [id]
            );
            if (!collab) {
                cleanupPending();
                return res.status(404).json({ error: '协作单不存在' });
            }

            // === 前置校验：状态 ∈ {PENDING, SUBMITTED, DONE}（v1.67.1 加 DONE 用于归档前重传）===
            // DONE 状态允许 developer 重传交付物，submission_version + 1，重走 smoke test；
            // ARCHIVED 由白名单默认拒绝（归档锁定后任何人不可改）
            if (!['PENDING', 'SUBMITTED', 'DONE'].includes(collab.status)) {
                cleanupPending();
                return res.status(409).json({
                    error: `当前状态 ${collab.status} 不允许提交（仅 PENDING/SUBMITTED/DONE 可提交）`,
                    current_status: collab.status,
                });
            }

            // === 前置校验：权限（仅指派 developer 本人）===
            // v3 二级转派方案 §6 拍板：负责人/admin 都不能代开发提交（权责清晰）
            //   - admin 兜底场景请走改派 endpoint（POST /:id/assign 改派给其他在岗开发）
            //   - codex 十审 #6：JWT id 可能是字符串、SQLite developer_id 是数字，用 Number() 归一化
            // B1 占位值方案：developer_id=0 表示未指派（PENDING_ASSIGN 阶段），单独提示更明确
            if (!collab.developer_id || collab.developer_id === COLLAB_UNASSIGNED_DEVELOPER_ID) {
                cleanupPending();
                return res.status(409).json({
                    error: '协作单未指派开发，无法提交（请先由对接人指派开发）',
                    code: 'NOT_ASSIGNED'
                });
            }
            const userIdNum = Number(userId);
            const devIdNum = Number(collab.developer_id);
            const isDev = Number.isSafeInteger(userIdNum) && userIdNum === devIdNum;
            if (!isDev) {
                cleanupPending();
                return res.status(403).json({
                    error: '仅本单指派开发可提交交付物（admin 兜底请走改派）',
                    code: 'NOT_DEVELOPER'
                });
            }

            // === 前置校验：文件分类（必须恰好 result_data + result_script，codex M2 简化版）===
            const classify = collabSubmitHelpers.classifyUploadedFiles(req.files);
            if (!classify.ok) {
                cleanupPending();
                return res.status(400).json({ error: classify.reason });
            }

            // === 前置校验：目标库配置（codex M5）===
            if (!collab.target_db_connection_id) {
                cleanupPending();
                return res.status(409).json({ error: '协作单缺少目标业务库配置（target_db_connection_id 为空）' });
            }
            // v1.68.0 路由式多方言：放开 sqlserver / mysql，按 type 分派 smoke test
            const targetConn = await dbGetAsync(
                `SELECT id, name, type, host, port, database, username, password
                   FROM db_connections
                  WHERE id = ? AND connection_type = 'source' AND type IN ('sqlserver', 'mysql')`,
                [collab.target_db_connection_id]
            );
            if (!targetConn) {
                cleanupPending();
                return res.status(500).json({ error: '目标业务库配置缺失或方言不支持（仅支持 SQL Server / MySQL）' });
            }

            const oldVer = collab.submission_version || 0;

            // === 写 SUBMIT_ATTEMPT 日志（codex M7）===
            // codex 十审 #11：日志回显文件名走 safeDisplayName（basename + 控制字符过滤 + 截断）
            const dataName = collabSubmitHelpers.safeDisplayName(classify.result_data.originalname);
            const scriptName = collabSubmitHelpers.safeDisplayName(classify.result_script.originalname);
            insertCollabLog(id, 'SUBMIT_ATTEMPT', userId, userName,
                `oldVer=${oldVer}, files=${dataName}+${scriptName}`);

            // === 前置 UPDATE：→ SUBMITTED + last_submitted_at（codex C1 + C3）===
            // submitted_at 首次设置时写，后续重提保留原值
            //
            // ⚠️ codex 十审 #2 + #3：本前置 UPDATE 的"乐观锁"语义降级说明
            //   - 当前 oldVer 不变 + status IN ('PENDING','SUBMITTED')，并发两个 submit 都可能通过此步
            //   - 真正的并发仲裁在 activateNewVersion 内部（事务 UPDATE WHERE submission_version=:oldVer）
            //   - 本前置 UPDATE 主要作用：① 状态机推进到 SUBMITTED；② 防 DONE/ARCHIVED 等非法状态进入
            //   - 因此 CONCURRENT_PRE_UPDATE 仅在"DONE/ARCHIVED 被 GET 后又被改回 PENDING/SUBMITTED 的极端时序"下触发
            //   - 4-5 用户内网工具不引入 attempt_token 进一步抢占（性价比低）
            //
            // ⚠️ codex 十一审 #2：sql_validation_status 区分 queued / running
            //   - 前置 UPDATE 只写 'queued'（排队中，等 smoke test 互斥锁）
            //   - validation_started_at **不在此处写**，由 runRealSmokeTest 拿到锁后写
            //   - 这样模块 5 启动恢复扫描只处理真正的 running 超时（validation_started_at 非 NULL）
            //   - 不变量：sql_validation_status='running' ⇒ validation_started_at IS NOT NULL
            //
            // v1.67.1：白名单加 DONE（codex 十八审 #1）—— DONE 重传走归档前修改路径
            //   - 同时清空 done_at + sql_validation_error，避免新一轮验收中详情页仍展示旧"已完成"
            //     语义污染（友好用户：开发删了交付物准备重传时，原 DONE 视觉应消失）
            //   - 不动 friction_* 字段（business 决策：摩擦记录跟"协作过程"而非"单次提交"绑定）
            const preUpdate = await dbRunAsync(
                `UPDATE collab_requests
                    SET status = 'SUBMITTED',
                        submitted_at = COALESCE(submitted_at, datetime('now','localtime')),
                        last_submitted_at = datetime('now','localtime'),
                        sql_validation_status = 'queued',
                        validation_started_at = NULL,
                        done_at = NULL,
                        sql_validation_error = NULL
                  WHERE id = ? AND submission_version = ? AND status IN ('PENDING','SUBMITTED','DONE') AND archived_at IS NULL`,
                [id, oldVer]
            );
            if (!preUpdate || preUpdate.changes === 0) {
                cleanupPending();
                return res.status(409).json({
                    error: '并发冲突：协作单状态已被其他请求修改，请刷新后重试',
                    code: 'CONCURRENT_PRE_UPDATE',
                });
            }

            // === v3 best-effort 钉钉触发：通知 admin 协作单已提交 ===
            // 5/18 决策：钉钉走部不阻塞主流程；admin 拿不到通知不影响 smoke test 推进
            // 选 admin 用户：role='admin' + status='active' + phone 非空；多个则取最早创建的一个
            // 失败仅记日志（NOTIFY_FAIL），不向调用方返回错误
            (async () => {
                try {
                    // v1.78.1：总开关默认关——开发提交后不再被动通知 admin（admin 主动到平台查看）
                    if (!(await isNotifyAdminOnSubmitEnabled())) {
                        logger.info(`[collab-submit-notify] 协作单 #${id} 提交后 admin 通知已被开关关闭（collab_notify_admin_on_submit≠on），跳过钉钉`);
                        return;
                    }
                    const adminUser = await dbGetAsync(
                        `SELECT id, display_name, phone, dingtalk_user_id
                         FROM users
                         WHERE role = 'admin' AND status = 'active' AND phone IS NOT NULL AND phone != ''
                         ORDER BY created_at ASC LIMIT 1`
                    );
                    if (!adminUser) {
                        logger.info(`[collab-submit-notify] 协作单 #${id} 提交后无可通知的 admin（无手机号或全停用），跳过钉钉`);
                        return;
                    }
                    const collab = await getCollabWithDbName(id);
                    if (!collab) return;
                    const platformBaseUrl = await readSystemConfig('platform_base_url');
                    const title = `协作单已提交 · ${collab.requester_dept}`;
                    const markdown = dingtalkNotify.buildCollabSubmittedCard(collab, platformBaseUrl);
                    const operatorInfo = { id: userId, name: userName };
                    const result = await sendCollabDingtalkRaw(id, adminUser, title, markdown, operatorInfo);
                    if (result.ok) {
                        insertCollabLog(id, 'NOTIFY_ADMIN_SUBMIT', userId, userName, null);
                        logger.info(`[collab-submit-notify] 协作单 #${id} 已通知 admin ${adminUser.display_name}`);
                    } else {
                        logger.warn(`[collab-submit-notify] 协作单 #${id} 通知 admin 失败：${result.body.error}（reason=${result.body.reason}）`);
                    }
                } catch (e) {
                    logger.warn(`[collab-submit-notify] 协作单 #${id} 钉钉触发异常：${e.message}`);
                }
            })();

            // === 解密目标库密码 ===
            let dbPassword;
            try {
                dbPassword = decryptPassword(targetConn.password);
            } catch (e) {
                cleanupPending();
                logger.error(`[collab-submit] 目标库密码解密失败: ${e.message}`);
                // codex 十审 #7：密码/连接失败按"业务验证失败"处理（停留 SUBMITTED + sql_validation_status=failed）
                // 这里仅写 validation 失败标记，**不回滚 status**（前置 UPDATE 已置 SUBMITTED）
                // 开发能在详情页看到错误，admin 知晓后调整目标库配置
                await dbRunAsync(
                    `UPDATE collab_requests
                        SET sql_validation_status = 'failed',
                            sql_validation_error = '目标库配置异常，请联系管理员'
                      WHERE id = ? AND submission_version = ?`,
                    [id, oldVer]
                ).catch(() => {});
                return res.status(500).json({ error: '目标库配置异常，请联系管理员' });
            }

            // === 拿连接池（v1.68.0 路由式多方言按 type 分派） ===
            const dialect = targetConn.type;  // 'sqlserver' / 'mysql'
            let pool;
            try {
                const poolConfig = {
                    host: targetConn.host,
                    port: targetConn.port,
                    database: targetConn.database,
                    username: targetConn.username,
                    password: dbPassword,
                };
                pool = dialect === 'mysql' ? await getMysqlPool(poolConfig) : await getMssqlPool(poolConfig);
            } catch (e) {
                cleanupPending();
                logger.error(`[collab-submit] 目标库连接失败 (dialect=${dialect}): ${e.message}`);
                // codex 十审 #7：连接失败 = 业务验证失败，停留 SUBMITTED（不回滚 status）
                await dbRunAsync(
                    `UPDATE collab_requests
                        SET sql_validation_status = 'failed',
                            sql_validation_error = ?
                      WHERE id = ? AND submission_version = ?`,
                    [collabSubmitHelpers.sanitizeSqlError(`连接业务库失败: ${e.message}`), id, oldVer]
                ).catch(() => {});
                insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName, `连接业务库失败`);
                return res.status(500).json({ error: '业务库连接失败，请联系管理员' });
            }

            // === 调 activateNewVersion ===
            // runSmokeTest 闭包注入 runRealSmokeTest，传 pool + ctx（含 dbAsync 用于拿锁后写 running）
            // codex 十一审 #2：runRealSmokeTest 拿到 Mutex 锁后才把 sql_validation_status 从 'queued' 升级为 'running'
            // v1.68.0：dialect + allowedDb（业务库名）随 ctx 传入，runRealSmokeTest 用于 sql-validator 路由
            const runSmokeTestClosure = (scriptPath) =>
                collabSubmitHelpers.runRealSmokeTest(scriptPath, pool, {
                    requestId: id,
                    oldVer,
                    dbAsync: { runAsync: dbRunAsync },
                    logger,
                    dialect,
                    allowedDb: targetConn.database,
                });

            const uploadedFiles = [
                {
                    attachment_type: 'result_data',
                    source_path: classify.result_data.path,
                    original_name: classify.result_data.originalname,
                    uploaded_by: userId,
                    uploaded_by_name: userName,
                },
                {
                    attachment_type: 'result_script',
                    source_path: classify.result_script.path,
                    original_name: classify.result_script.originalname,
                    uploaded_by: userId,
                    uploaded_by_name: userName,
                },
            ];

            let activateResult;
            try {
                activateResult = await collabVersioning.activateNewVersion({
                    db,
                    dbAsync: { runAsync: dbRunAsync, getAsync: dbGetAsync, allAsync: dbAllAsync },
                    requestId: id,
                    oldVer,
                    collabRoot: COLLAB_UPLOAD_BASE,
                    description: collab.description,
                    attachmentDir: collab.attachment_dir,
                    // v1.72.0 落盘命名所需字段
                    oaRequestNo: collab.oa_request_no,
                    collabCreatedAt: collab.created_at,
                    uploadedFiles,
                    runSmokeTest: runSmokeTestClosure,
                    logger,
                });
            } catch (e) {
                // 分支处理（codex C1 + 对照表）
                if (e.code === 'SMOKE_TEST_FAILED') {
                    // smoke test 失败：业务错，HTTP 200 + business_error
                    // v1.70.0 方案 §1.2：附件不再删除，保留在正式目录 status='failed'
                    // activateNewVersion 内部已 INSERT failed 行（BEGIN IMMEDIATE 事务）
                    // e.failedAttachments 含本次 failed 行明细 [{ id, attachment_type, failed_attempt_seq, file_name }]
                    const sqlErr = collabSubmitHelpers.sanitizeSqlError(e.smokeError || e.message);
                    await dbRunAsync(
                        `UPDATE collab_requests
                            SET sql_validation_status = 'failed',
                                sql_validation_error = ?,
                                sql_validated_at = datetime('now','localtime')
                          WHERE id = ? AND submission_version = ?`,
                        [sqlErr, id, oldVer]
                    ).catch(err => logger.warn(`[collab-submit] 写 failed 状态失败: ${err.message}`));
                    const failedCount = Array.isArray(e.failedAttachments) ? e.failedAttachments.length : 0;
                    const attemptSeq = failedCount > 0 ? e.failedAttachments[0].failed_attempt_seq : null;
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName,
                        `${sqlErr} (attempt_seq=${attemptSeq}, 撞墙附件保留 ${failedCount} 个)`);

                    // === 取数质量双校验增强 Commit C：failed 路径质量记录（方案 §5.3 failed→SUBMITTED + #11 核心）===
                    //   - 状态已持久化（UPDATE failed）+ operation_log 已写，在 return 前调用双校验
                    //   - codex Commit C 审 medium-5 说明：14223 UPDATE 即使被 .catch 吞错，前置 UPDATE（14072）
                    //     已把状态推进到 SUBMITTED/queued——质量记录写 failed 与主表 SUBMITTED 语义自洽
                    //     （SUBMITTED + failed 质量留痕 = "提交了但 smoke 没过"）
                    //   - recordKind='failed' → 纯 INSERT，不带 OR IGNORE，纯 append（不进唯一索引，方案 §4.4）
                    //   - submissionSeq=oldVer（failed 不自增 submission_version）
                    //   - excel 侧照常跑（#11 核心可信度——SQL 误伤时 excel 校验仍能反映真实交付质量）
                    //   - 自包 try/catch 永不抛（H-2，方案 §6.1）；不影响 failed 主 return 既有结构
                    //   - codex Commit C 审 high-2 解答：e.failedAttachments[].file_name 由 collab-attachment-versioning.js
                    //     的 finalName 拼接保证含原扩展名（.xlsx/.xls/.sql/.txt），_evaluateExcelSide 走
                    //     `original_name || file_name` fallback 正确识别为 excel（虽然 failedAttachments 没 original_name）
                    let qualityCheckFailed = {
                        sql:   { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
                        excel: { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
                        check_status: 'compute_failed', persistence_status: 'failed'
                    };
                    try {
                        // 从 e.failedAttachments 拿本次 failed 附件（含物理文件，已落盘 status='failed'）
                        // 字段：{id, attachment_type, failed_attempt_seq, file_name}（无 original_name，但 file_name 含原扩展名）
                        const failedAttArr = Array.isArray(e.failedAttachments) ? e.failedAttachments : [];
                        const failedResultData = failedAttArr.find(a => a.attachment_type === 'result_data') || null;
                        const failedResultScript = failedAttArr.find(a => a.attachment_type === 'result_script') || null;
                        const qr = await collabSubmitHelpers.recordQualityForDeveloperSubmit({
                            dbAsync: { runAsync: dbRunAsync, getAsync: dbGetAsync },
                            requestId: id,
                            submitterId: userId,
                            submitterName: userName,
                            submissionSeq: oldVer,  // failed 不自增 submission_version
                            recordKind: 'failed',
                            sqlSmokeResult: null,   // → sql_unchecked_reason='SMOKE_FAILED'
                            sqlAttachmentId: failedResultScript ? failedResultScript.id : null,
                            resultDataAttachment: failedResultData,
                            insertLog: insertCollabLog,
                            logger,
                        });
                        if (qr) qualityCheckFailed = qr;
                    } catch (qe) {
                        logger.warn(`[collab-submit] failed 路径双校验旁路异常（已隔离，不影响 failed 主流程）: ${qe.message}`);
                        insertCollabLog(id, 'QUALITY_RECORD', userId, userName, `dualcheck_failed_endpoint_fallback:${qe.message}`);
                    }

                    return res.status(200).json({
                        business_error: true,
                        message: 'smoke test 验证失败，请检查 SQL；撞墙的附件已保留在失败提交历史中',
                        sql_validation_status: 'failed',
                        sql_validation_error: sqlErr,
                        current_status: 'SUBMITTED',
                        failed_attempt_seq: attemptSeq,
                        failed_attachments: e.failedAttachments || [],
                        // 取数质量双校验结果（方案 §5.3 #11 核心：SQL failed 时仍校验 excel 反映真实交付质量）
                        quality_check: qualityCheckFailed,
                    });
                }
                if (e.code === 'SMOKE_TEST_FAILED_INSERT_FAILED') {
                    // v1.70.0：smoke 失败 + INSERT failed 行自身失败（DB 故障）
                    // activateNewVersion 内部已 moveToOrphanedSubdir('failed_insert_failed') 把文件挪隔离区
                    // 不写 sql_validation_status（避免假象通过），返 500 让前端友好提示
                    logger.error(`[collab-submit] 协作单 #${id} SMOKE_TEST_FAILED 但 INSERT failed 行失败: ${e.message}`);
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName,
                        `smoke 失败附件持久化异常：${e.message}`);
                    return res.status(500).json({
                        error: '提交验证失败且失败记录持久化异常，请联系管理员',
                        code: 'SMOKE_TEST_FAILED_INSERT_FAILED',
                    });
                }
                if (e.code === 'INCOMPLETE_SNAPSHOT') {
                    cleanupPending();
                    return res.status(400).json({ error: e.message, code: 'INCOMPLETE_SNAPSHOT' });
                }
                if (e.code === 'PATH_VIOLATION') {
                    cleanupPending();
                    logger.error(`[collab-submit] 路径越界: ${e.detail}`);
                    return res.status(500).json({ error: '文件路径异常', code: 'PATH_VIOLATION' });
                }
                if (e.code === 'CONCURRENT_SUBMIT') {
                    // activateNewVersion 内部已挪文件到 _orphaned/
                    // codex 十审 #4：物理路径仅写日志，不返回前端（避免暴露目录结构）
                    logger.warn(`[collab-submit] 协作单 #${id} 并发冲突，新文件已隔离到 ${e.orphanedDir}`);
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName, `并发冲突，新文件已隔离`);
                    return res.status(409).json({
                        error: '并发提交冲突，已被另一个请求抢先',
                        code: 'CONCURRENT_SUBMIT',
                    });
                }
                if (e.code === 'RUNNING_UPDATE_STALE') {
                    // codex 十二审 #3：写 running 时 0 行影响 → 状态已被其他流程改动
                    // activateNewVersion 内部已 cleanupMovedFiles 删本次文件
                    // 不写 sql_validation_status（不知道当前状态是什么），返 409 让前端刷新重试
                    logger.warn(`[collab-submit] 协作单 #${id} 状态漂移，写 running 0 行影响`);
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName,
                        '提交期间状态被其他流程改动');
                    return res.status(409).json({
                        error: '协作单状态已被其他流程改动，请刷新后重试',
                        code: 'STATE_DRIFT',
                        retryable: true,
                    });
                }
                if (e.code === 'RUNNING_UPDATE_FAILED') {
                    // codex 十二审 #2：写 running 时 DB 异常 → 系统错
                    // activateNewVersion 内部已 cleanupMovedFiles 删本次文件
                    // 把状态恢复到 'queued' 让前端可重试，不写 failed
                    logger.error(`[collab-submit] 协作单 #${id} 写 running 状态 DB 异常: ${e.message}`);
                    await dbRunAsync(
                        `UPDATE collab_requests
                            SET sql_validation_error = NULL
                          WHERE id = ?
                            AND submission_version = ?
                            AND status = 'SUBMITTED'
                            AND sql_validation_status = 'queued'`,
                        [id, oldVer]
                    ).catch(err => logger.warn(`[collab-submit] 恢复 queued 状态失败: ${err.message}`));
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName,
                        '写 running 状态失败（系统异常）');
                    return res.status(500).json({
                        error: '系统繁忙，请稍后重试',
                        code: 'RUNNING_UPDATE_FAILED',
                        retryable: true,
                    });
                }
                if (e.code === 'SMOKE_MUTEX_WAIT_TIMEOUT') {
                    // codex 十一审 #3 #10 + 十二审 #1：smoke test 互斥等待超时（5s 内没拿到锁）
                    //   - activateNewVersion 内部已 cleanupMovedFiles 删本次新文件
                    //   - **不写 sql_validation_status='failed'**（因为本次根本没真跑过 smoke test）
                    //   - 把状态恢复到 'queued'（保留可重试语义），前端友好提示稍后重试
                    //   - 返回 409 而不是 500，明示业务可重试
                    //   - codex 十二审 #1：WHERE 收紧到 status='SUBMITTED' AND sql_validation_status='queued'
                    //     防止异常时序下覆盖不该改的记录（如本次提交期间被另一流程改成 DONE/ARCHIVED）
                    logger.warn(`[collab-submit] 协作单 #${id} smoke test 互斥等待超时（5s），系统繁忙`);
                    await dbRunAsync(
                        `UPDATE collab_requests
                            SET sql_validation_error = NULL
                          WHERE id = ?
                            AND submission_version = ?
                            AND status = 'SUBMITTED'
                            AND sql_validation_status = 'queued'`,
                        [id, oldVer]
                    ).catch(err => logger.warn(`[collab-submit] 恢复 queued 状态失败: ${err.message}`));
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName,
                        'smoke test 互斥等待超时（系统繁忙）');
                    return res.status(409).json({
                        error: 'smoke test 系统繁忙，请稍后重试',
                        code: 'SMOKE_BUSY',
                        retryable: true,
                    });
                }
                // 其他异常
                // codex 十审 #5：原始 e.message 可能含本地路径/SQL 片段/连接信息，仅写日志不返前端
                cleanupPending();
                logger.error(`[collab-submit] activateNewVersion 未知异常: ${e.message}`, e);
                await dbRunAsync(
                    `UPDATE collab_requests
                        SET sql_validation_status = 'failed',
                            sql_validation_error = ?
                      WHERE id = ? AND submission_version = ?`,
                    [collabSubmitHelpers.sanitizeSqlError(`提交失败: ${e.message}`), id, oldVer]
                ).catch(() => {});
                return res.status(500).json({ error: '提交失败，请联系管理员' });
            }

            // === activateNewVersion 内部已 UPDATE：submission_version + sql_validation_status='passed' + sql_validated_at + status='DONE' + done_at + attachment_dir ===
            //     （事务 + 乐观锁已生效，本 endpoint 不再追加 UPDATE）

            insertCollabLog(id, 'SUBMIT_SUCCESS', userId, userName,
                `newVer=${activateResult.newVer}, dir=${activateResult.attachmentDir}`);

            // === 取数质量双校验增强 Commit C：主事务成功后旁路写双校验记录（方案 §5.3 passed→DONE 路径）===
            //   - 切换 v3.0 recordQualityOnSubmit → recordQualityForDeveloperSubmit（双校验：SQL+excel；record_kind='passed'；INSERT OR IGNORE）
            //   - recordKind='passed'：走唯一索引幂等（changes=0 → ignored_due_to_duplicate；changes>0 → recorded）
            //   - 自包 try/catch 永不抛（H-2，方案 §6.1）；calc/落库分离 schema 永远返回（compute_failed 兜底）
            //   - 附件 id 从主事务后查（activateNewVersion 不返结构、不侵入老函数）：result_data（excel 侧）+ result_script（SQL 侧）
            //   - codex Commit B 审 high-2 硬约束：passed 路径必须显式查 sqlAttachmentId 传入，避免脱链
            //   - codex Commit C 审 high-1/medium-3 落地：查询缺失时显式 compute_failed + operation_log，
            //     不让"系统异常（附件被 supersede / DB 时序异常）"伪装成"用户未传 result_data"（NO_RESULT_DATA）
            const newVer = activateResult.newVer;
            // 兜底常量（codex Commit C 审 low-7：避免 passed/failed 两处 schema 漂移）
            const qualityCheckFallback = () => ({
                sql:   { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
                excel: { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
                check_status: 'compute_failed', persistence_status: 'failed'
            });
            let qualityCheck = qualityCheckFallback();
            try {
                // 查本次提交的 active 附件（result_data / result_script，submission_version=newVer + status='active'）
                const attachRows = await dbAllAsync(
                    `SELECT id, attachment_type, file_name, original_name FROM collab_attachments
                      WHERE collab_request_id = ? AND submission_version = ?
                        AND attachment_type IN ('result_data','result_script')
                        AND (status = 'active' OR status IS NULL)`,
                    [id, newVer]
                );
                const resultDataAttach = attachRows.find(r => r.attachment_type === 'result_data') || null;
                const resultScriptAttach = attachRows.find(r => r.attachment_type === 'result_script') || null;
                // codex Commit C 审 high-1/medium-3：passed 路径 activateNewVersion 已成功 = result_data+result_script 必到位（classifyUploadedFiles 强制）
                //   查不到 = 系统异常（附件被 supersede / 极端时序）→ 不能伪装成 NO_RESULT_DATA 用户问题，落 compute_failed + log
                if (!resultDataAttach || !resultScriptAttach) {
                    logger.error(`[collab-submit] passed 路径附件查询缺失（系统异常，非用户问题）: req=${id} newVer=${newVer} found=${attachRows.length} types=${attachRows.map(a => a.attachment_type).join(',')}`);
                    insertCollabLog(id, 'QUALITY_RECORD', userId, userName,
                        `dualcheck_passed_attachment_missing: newVer=${newVer} found=${attachRows.length}`);
                    // qualityCheck 保留 compute_failed/failed 默认，不调 helper
                } else {
                    const qr = await collabSubmitHelpers.recordQualityForDeveloperSubmit({
                        dbAsync: { runAsync: dbRunAsync, getAsync: dbGetAsync },
                        requestId: id,
                        submitterId: userId,
                        submitterName: userName,
                        submissionSeq: newVer,
                        recordKind: 'passed',
                        sqlSmokeResult: activateResult.smokeTestResult,  // {columns, validatedAt, rowCount}
                        sqlAttachmentId: resultScriptAttach.id,
                        resultDataAttachment: resultDataAttach,
                        insertLog: insertCollabLog,
                        logger,
                    });
                    if (qr) qualityCheck = qr;
                    // codex Commit C 审 high-1：附件查询结果落 operation_log，便于排查"本次质量记录用了哪个附件"
                    insertCollabLog(id, 'QUALITY_RECORD', userId, userName,
                        `dualcheck_passed_attach: data_id=${resultDataAttach.id} script_id=${resultScriptAttach.id} persist=${qr && qr.persistence_status}`);
                }
            } catch (qe) {
                // 双重保险：helper 设计上永不抛（H-2），这里再兜一层确保主流程绝不因质量记录失败而返 500
                logger.warn(`[collab-submit] 双校验质量记录旁路异常（已隔离，不影响提交）: ${qe.message}`);
                insertCollabLog(id, 'QUALITY_RECORD', userId, userName, `dualcheck_passed_endpoint_fallback:${qe.message}`);
            }

            return res.json({
                message: '提交成功',
                new_version: newVer,
                attachment_dir: activateResult.attachmentDir,
                sql_validation_status: 'passed',
                smoke_test_validated_at: activateResult.smokeTestResult.validatedAt,
                smoke_test_row_count: activateResult.smokeTestResult.rowCount,
                current_status: 'DONE',
                // 取数质量双校验结果（方案 §6.1 稳定 schema：sql/excel/check_status/persistence_status）
                //   前端 Commit D 据此弹双侧缺列提醒（不阻塞）+ persistence_status 用于排查
                quality_check: qualityCheck,
            });
        } catch (e) {
            // 顶层兜底（含 multer 后业务校验前抛错的小概率路径）
            // codex 十审 #5：e.message 仅写日志，不返前端
            cleanupPending();
            logger.error(`[collab-submit] 顶层异常: ${e.message}`, e);
            return res.status(500).json({ error: '提交失败，请联系管理员' });
        }
    }
);

// 4b. 验收失败旁路（admin，方案 §6.5.2 + D3 模块 6 取舍审 codex 14 全采纳）
//   - 状态守卫：SUBMITTED + sql_validation_status='failed'
//   - bypass_reason 必填，trim 后 10..500 字符
//   - 双层守卫：前置 SELECT 给"当前状态 X"友好错误 + 条件 UPDATE 看 changes 兜底并发
//   - 不写 sql_validated_at（保留 smoke test 真跑过的语义），bypass 走 done_at
//   - BYPASS 日志 best-effort（fire-and-forget），跟项目其他 collab 写入风格一致
// ==========================================================
// v3 二级转派指派 endpoint（2026-05-18，预期 v1.66.0）
// 方案 §4.1：负责人指派 / 改派开发
//   - 权限：协作单 contact_person 本人 或 admin（admin 兜底）
//   - 状态：PENDING_ASSIGN → PENDING（首次指派）；PENDING → PENDING（改派，保留状态）
//   - 校验：developer_id 有效 active user；developer_id != 0；developer_id != contact_person_id
//   - 副作用：UPDATE 字段 + 写改派前 developer_id 到 previous_developer_id（用于通知前任）
//   - 钉钉通知：本 endpoint 不主动触发，由 admin/对接人调 /notify endpoint 手动发送（与既有风格一致，错误隔离）
// ==========================================================
app.post('/api/collab/requests/:id/assign', authenticateToken, requireNonViewer, async (req, res) => {
    const idStr = req.params.id;
    // codex 十六审 #5：JWT id 字符串/数字混用防误判，统一 Number
    const userId = Number(req.user.id);
    const userRole = req.user.role;
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // === 前置：id 校验（沿用 bypass endpoint 风格）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // === 前置：developer_id body 校验（codex 十六审 #5：用严格正则替换 parseInt，避免接受 '12abc' / '1.5'）===
    const rawDeveloperId = req.body && req.body.developer_id;
    if (rawDeveloperId === undefined || rawDeveloperId === null) {
        return res.status(400).json({ error: 'developer_id 必填', code: 'MISSING_DEVELOPER' });
    }
    if (!/^[1-9]\d*$/.test(String(rawDeveloperId))) {
        return res.status(400).json({ error: 'developer_id 必须是正整数', code: 'INVALID_DEVELOPER' });
    }
    const developerId = Number(rawDeveloperId);
    if (!Number.isSafeInteger(developerId)) {
        return res.status(400).json({ error: 'developer_id 超出安全整数范围', code: 'INVALID_DEVELOPER' });
    }

    try {
        // === 取协作单 + 双重状态守卫 ===
        const collab = await dbGetAsync(
            `SELECT id, status, contact_person_id, developer_id, oa_request_no
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }

        // 权限：仅 admin 或本单 contact_person 可指派（codex 十六审 #5：统一 Number 比较）
        const isAdmin = userRole === 'admin';
        const isContactPerson = Number(collab.contact_person_id) === userId;
        if (!isAdmin && !isContactPerson) {
            return res.status(403).json({
                error: '仅本单对接人或 admin 可指派开发',
                code: 'NOT_ASSIGNER'
            });
        }

        // 状态：仅 PENDING_ASSIGN / PENDING 可指派或改派
        if (collab.status !== 'PENDING_ASSIGN' && collab.status !== 'PENDING') {
            return res.status(409).json({
                error: `当前状态 ${collab.status} 不允许指派（仅 PENDING_ASSIGN / PENDING 可指派/改派）`,
                code: 'INVALID_STATE',
                current_status: collab.status
            });
        }

        // 不能指派给对接人自己（按拍板 #10 严格走流程）— Number 比较防类型漂移
        if (developerId === Number(collab.contact_person_id)) {
            return res.status(400).json({
                error: '不能将对接人本人指派为开发',
                code: 'SAME_AS_CONTACT'
            });
        }

        // 校验 developer 用户存在 + active + role 合法
        const dev = await dbGetAsync(
            'SELECT id, display_name, username, role, status FROM users WHERE id = ?',
            [developerId]
        );
        if (!dev) {
            return res.status(400).json({ error: '指派的开发人员不存在', code: 'DEVELOPER_NOT_FOUND' });
        }
        if (dev.status !== 'active') {
            return res.status(400).json({ error: `开发人员 ${dev.display_name} 已停用`, code: 'DEVELOPER_INACTIVE' });
        }
        if (!['user', 'publisher', 'admin'].includes(dev.role)) {
            return res.status(400).json({ error: '指派的开发人员角色无效', code: 'INVALID_ROLE' });
        }

        // 改派幂等：指派的人和当前相同时直接成功（避免误点重发）— Number 比较防类型漂移
        if (collab.status === 'PENDING' && Number(collab.developer_id) === developerId) {
            return res.json({
                message: '该协作单已指派给此开发，无需重复操作',
                current_status: 'PENDING',
                developer_id: developerId,
                no_change: true
            });
        }

        const developerName = dev.display_name || dev.username;
        const isReassign = collab.status === 'PENDING';
        const previousDeveloperId = isReassign ? collab.developer_id : null;

        // === 条件 UPDATE：兜底并发漂移（沿用 bypass endpoint 风格）===
        // 双 WHERE 条件：id + status 必须仍是发起时的状态
        // codex 十六审 #4 high：首次指派 / 改派时清空旧 developer 的通知跟踪字段
        //   - notified_at / notify_message_key / read_at 三件套清空，避免前任已读时间沾染新开发
        //   - 首次指派时这三字段本就应该是 NULL（PENDING_ASSIGN 阶段不会发开发钉钉），冗余清空也无害
        const result = await dbRunAsync(
            `UPDATE collab_requests SET
                developer_id = ?,
                developer_name = ?,
                status = 'PENDING',
                assigned_at = datetime('now','localtime'),
                assigned_by = ?,
                previous_developer_id = ?,
                notified_at = NULL,
                notify_message_key = NULL,
                read_at = NULL
              WHERE id = ?
                AND status = ?
                AND contact_person_id = ?`,
            [developerId, developerName, userId, previousDeveloperId, id, collab.status, collab.contact_person_id]
        );

        if (!result || result.changes === 0) {
            return res.status(409).json({
                error: '协作单状态已变化，请刷新后重试',
                code: 'STATE_CHANGED'
            });
        }

        // 审计日志：ASSIGNED / REASSIGNED
        const opType = isReassign ? 'REASSIGNED' : 'ASSIGNED';
        const logReason = isReassign
            ? `改派开发：${previousDeveloperId} → ${developerId}(${developerName})`
            : `指派开发：${developerId}(${developerName})`;
        insertCollabLog(id, opType, userId, userName, logReason);
        logger.info(`[collab-assign] 协作单 #${id} ${opType} by ${userName}: dev=${developerId}(${developerName})${isReassign ? `, prev=${previousDeveloperId}` : ''}`);

        return res.json({
            message: isReassign ? '改派成功' : '指派成功',
            current_status: 'PENDING',
            developer_id: developerId,
            developer_name: developerName,
            previous_developer_id: previousDeveloperId,
            is_reassign: isReassign
        });
    } catch (e) {
        logger.error(`[collab-assign] 协作单 #${id} 指派异常: ${e.message}`, e);
        return res.status(500).json({ error: '指派失败，请联系管理员', code: 'ASSIGN_FAILED' });
    }
});

// v1.71.0 三级转发：exporter 相关状态转移全局串行化锁
//
// 历史：Commit C codex 36 审 H-1 修复（原名 forwardToExporterMutex 仅保护 forward）
// 改名：Commit D codex 37 取舍审 H-1 → collabExporterTransitionMutex
//   - 改名理由：实际保护范围扩展到 forward + return + submit-export（Commit E）三类 exporter 状态转移
//   - 旧名 forwardToExporterMutex 会让 Commit E 维护者误以为 submit-export 不需要复用该锁
//   - 改名清晰边界：所有"涉及 exporter_user_id / EXPORTING 状态机"的转移都走此锁
//
// 问题背景：sqlite3 默认 parallel mode（未用 db.serialize 包裹）下，BEGIN IMMEDIATE/UPDATE/INSERT/COMMIT
// 在并发场景可能交错，导致状态机不一致（Commit C e2e T18 已复现 forward 场景）。
//
// 设计：
//   - 单全局锁（不分 collab_id），简化设计；保护"同一状态机并发"而非"同类请求并发"
//   - 内网 ~10 人 + exporter 状态转移是低频操作 + 锁内主流程 < 100ms，串行化开销可忽略
//   - 5s 超时（与 smoke test 锁一致）
//
// 不变量：
//   - locked === true ⇒ 当前确实有一个 exporter 状态转移在跑
//   - waiters 中所有元素 acquired === false（已 acquired 的就已经 shift 出来了）
//
// ⚠️ cluster 兼容性：仅 PM2 单实例下有效，多实例需改为 DB 级锁
const collabExporterTransitionMutex = (() => {
    let locked = false;
    const waiters = [];

    function acquire(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const node = { resolve, timer: null, acquired: false };
            if (!locked) {
                locked = true;
                node.acquired = true;
                return resolve(makeRelease(node));
            }
            waiters.push(node);
            node.timer = setTimeout(() => {
                if (node.acquired) return;
                const idx = waiters.indexOf(node);
                if (idx >= 0) waiters.splice(idx, 1);
                const e = new Error('COLLAB_EXPORTER_MUTEX_WAIT_TIMEOUT');
                e.code = 'COLLAB_EXPORTER_MUTEX_WAIT_TIMEOUT';
                reject(e);
            }, timeoutMs);
        });
    }

    function makeRelease(node) {
        let released = false;
        return function release() {
            if (released) return;
            released = true;
            while (waiters.length > 0) {
                const next = waiters.shift();
                if (next.acquired) {
                    console.warn('[collab-exporter-mutex] invariant violated: waiter.acquired=true while still in queue');
                    continue;
                }
                if (next.timer) clearTimeout(next.timer);
                next.acquired = true;
                return next.resolve(makeRelease(next));
            }
            locked = false;
        };
    }

    return { acquire };
})();

// v1.71.0 三级转发：开发把任务转给数据导出人（方案 §3）
//
// 入参（body）：
//   - exporter_id: number（必填，目标数据导出人 user.id）
//   - contact_user_ids: number[]（必填 ≥1，沟通对象 user.id 数组，v0.1 决策 C-1 留痕）
//
// 原子事务：UPDATE collab_requests（PENDING→EXPORTING + exporter_* + forwarded_at）
//           + INSERT operation_logs FORWARD_TO_EXPORTER reason=JSON
//           ⚠️ 整个主流程包在 collabExporterTransitionMutex 内（codex 36 审 H-1 修复，37 审 H-1 改名）
//
// 钉钉副作用（commit 后执行，失败仅记日志不回滚 DB）：
//   - 加 exporter 进群（群必须已存在；不自动建群，由用户提前点"拉起钉钉沟通群"）
//   - 个人推送给 exporter（含附件数 + 协作单详情链接）
//
// 业务约束：群必须先建（CHAT_NOT_EXISTS 拒绝转发，引导用户先调 create-chat endpoint）
//           平台对业务方不可见，业务方角色不在权限矩阵内
app.post('/api/collab/requests/:id/forward-to-exporter', authenticateToken, requireNonViewer, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const userRole = req.user.role;

    // === 前置：id 校验（沿用 assign / bypass 风格）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }

    // === 前置：exporter_id body 校验（严格正则）===
    const rawExporterId = req.body && req.body.exporter_id;
    if (rawExporterId === undefined || rawExporterId === null) {
        return res.status(400).json({ error: 'exporter_id 必填', code: 'MISSING_EXPORTER_ID' });
    }
    if (!/^[1-9]\d*$/.test(String(rawExporterId))) {
        return res.status(400).json({ error: 'exporter_id 必须是正整数', code: 'INVALID_EXPORTER_ID' });
    }
    const exporterId = Number(rawExporterId);
    if (!Number.isSafeInteger(exporterId)) {
        return res.status(400).json({ error: 'exporter_id 超出安全整数范围', code: 'INVALID_EXPORTER_ID' });
    }

    // === 前置：contact_user_ids body 校验 ===
    const rawContactIds = req.body && req.body.contact_user_ids;
    if (!Array.isArray(rawContactIds) || rawContactIds.length === 0) {
        return res.status(400).json({ error: 'contact_user_ids 必填且至少 1 人', code: 'INVALID_CONTACT_USER_IDS' });
    }
    if (!rawContactIds.every(uid => /^[1-9]\d*$/.test(String(uid)) && Number.isSafeInteger(Number(uid)))) {
        return res.status(400).json({ error: 'contact_user_ids 元素必须是正整数', code: 'INVALID_CONTACT_USER_IDS_ELEM' });
    }
    const contactUserIds = rawContactIds.map(Number);

    // codex 36 审 H-1：先 acquire exporter 状态转移 mutex 串行化主流程
    // 业务影响：同一时刻全局只有 1 个 exporter 状态转移在跑（含 return / submit-export），串行化开销 < 100ms
    let release;
    try {
        release = await collabExporterTransitionMutex.acquire(5000);
    } catch (mutexErr) {
        logger.warn(`[forward-to-exporter] 协作单 #${id} 等待 collabExporterTransitionMutex 超时: ${mutexErr.message}`);
        return res.status(503).json({
            error: '系统繁忙，请稍后重试',
            code: 'COLLAB_EXPORTER_MUTEX_BUSY'
        });
    }

    try {
        // === 取协作单（含 dingtalk_chat_id 判断群是否存在）===
        const collab = await dbGetAsync(
            `SELECT id, status, archived_at, archived_final_at, oa_request_no,
                    description, requester_name, contact_person_id, developer_id,
                    dingtalk_chat_id, dingtalk_open_conversation_id
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
        }

        // === 软删除 / 归档守卫（按既有惯例）===
        if (collabSubmitHelpers.isSoftArchived(collab)) {
            return res.status(409).json({ error: '协作单已作废，不可转发', code: 'PARENT_SOFT_ARCHIVED' });
        }
        if (collabSubmitHelpers.isFinalArchived(collab)) {
            return res.status(409).json({ error: '协作单已归档锁定，不可转发', code: 'PARENT_ARCHIVED_LOCKED' });
        }

        // === 状态守卫：仅 PENDING 可转发（不允许 PENDING_ASSIGN/SUBMITTED/DONE 等）===
        if (collab.status !== 'PENDING') {
            return res.status(409).json({
                error: `仅 PENDING 状态可转发给数据导出人，当前状态：${collab.status}`,
                code: 'INVALID_STATE_FOR_FORWARD',
                current_status: collab.status
            });
        }

        // === 权限守卫：仅 admin / 本单 developer / 本单 contact_person 可转发 ===
        // 平台对业务方不可见，业务方角色不在权限矩阵内
        const isAdmin = userRole === 'admin';
        const isCurrentDeveloper = Number(collab.developer_id) > 0 && Number(collab.developer_id) === userId;
        const isContactPerson = Number(collab.contact_person_id) > 0 && Number(collab.contact_person_id) === userId;
        if (!isAdmin && !isCurrentDeveloper && !isContactPerson) {
            return res.status(403).json({
                error: '仅 admin / 当前开发 / 对接人可转发给数据导出人',
                code: 'NOT_FORWARDER'
            });
        }

        // === 业务约束：群必须先建（不自动建群，引导用户先调 create-chat 后重试）===
        if (!collab.dingtalk_chat_id || !collab.dingtalk_open_conversation_id) {
            return res.status(409).json({
                error: '请先点击"拉起钉钉沟通群"建立群聊后再转发',
                code: 'CHAT_NOT_EXISTS',
                suggestion: '在详情页点【拉起钉钉沟通群】按钮，建群成功后重试本操作'
            });
        }

        // === 同人空转校验：不能转给当前 developer 自己 ===
        if (Number(collab.developer_id) === exporterId) {
            return res.status(400).json({
                error: '不能转发给自己（您是本单开发）',
                code: 'CANNOT_FORWARD_TO_SELF'
            });
        }

        // === 校验 exporter 用户 active + 绑定钉钉 ===
        const exporterUser = await dbGetAsync(
            `SELECT id, display_name, username, phone, dingtalk_user_id, status
               FROM users WHERE id = ?`,
            [exporterId]
        );
        if (!exporterUser) {
            return res.status(400).json({ error: '数据导出人不存在', code: 'EXPORTER_NOT_FOUND' });
        }
        if (exporterUser.status !== 'active') {
            return res.status(400).json({ error: `数据导出人 ${exporterUser.display_name} 已停用`, code: 'EXPORTER_INACTIVE' });
        }
        // v1.74.3：纯只读领导账号不可被转发为数据导出人（前端已过滤+后端兜底；领导拦截优先于钉钉绑定校验，错因更清晰）
        if (isReadonlyLeaderId(exporterUser.id)) {
            return res.status(400).json({ error: '该账号为纯只读领导账号，不可转发为数据导出人', code: 'EXPORTER_IS_READONLY_LEADER' });
        }
        if (!exporterUser.dingtalk_user_id && !exporterUser.phone) {
            return res.status(400).json({
                error: '数据导出人未绑定钉钉/手机号，无法发起加群与通知',
                code: 'EXPORTER_NO_DINGTALK',
                target_user_id: exporterUser.id
            });
        }

        // === 校验 contact 用户全部 active（去重防参数注水）===
        const uniqContactIds = [...new Set(contactUserIds)];
        const contactRows = await dbAllAsync(
            `SELECT id, display_name, status FROM users
              WHERE id IN (${uniqContactIds.map(() => '?').join(',')})`,
            uniqContactIds
        );
        if (contactRows.length !== uniqContactIds.length) {
            const foundIds = new Set(contactRows.map(r => r.id));
            const missing = uniqContactIds.filter(uid => !foundIds.has(uid));
            return res.status(400).json({
                error: `沟通对象用户不存在：user.id=${missing.join(',')}`,
                code: 'CONTACT_USERS_NOT_FOUND',
                missing_ids: missing
            });
        }
        const inactive = contactRows.filter(r => r.status !== 'active');
        if (inactive.length > 0) {
            return res.status(400).json({
                error: `沟通对象用户已停用：${inactive.map(r => r.display_name).join(',')}`,
                code: 'CONTACT_USERS_INACTIVE'
            });
        }

        // === 查附件数（仅记日志用，前端弹框已展示）===
        const attachmentCountRow = await dbGetAsync(
            `SELECT COUNT(*) AS cnt FROM collab_attachments
              WHERE collab_request_id = ? AND status = 'active'`,
            [id]
        );
        const attachmentCount = attachmentCountRow.cnt;

        // === 阶段 1：DB 原子事务（UPDATE + INSERT log）===
        // 方案 §3.2：BEGIN IMMEDIATE 包 UPDATE collab_requests + INSERT log，commit 后再钉钉
        let updateResult;
        try {
            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

            // UPDATE 双 WHERE 守卫：status=PENDING + archived_at IS NULL + archived_final_at IS NULL
            // 防 SELECT 与 UPDATE 之间被并发改状态 / 被 admin 作废产生半复活状态（codex 31 审 #2 critical）
            updateResult = await dbRunAsync(
                `UPDATE collab_requests
                    SET status = 'EXPORTING',
                        exporter_user_id = ?,
                        exporter_name = ?,
                        exporter_assigned_at = datetime('now', 'localtime'),
                        forwarded_to_exporter_at = datetime('now', 'localtime')
                  WHERE id = ?
                    AND status = 'PENDING'
                    AND archived_at IS NULL
                    AND archived_final_at IS NULL`,
                [exporterId, exporterUser.display_name, id]
            );

            if (!updateResult || updateResult.changes === 0) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({
                    error: '协作单状态已变更，请刷新重试',
                    code: 'CONCURRENT_STATE_CHANGE'
                });
            }

            // INSERT operation_logs（reason 字段存 JSON 字符串，沿用 v1.70.4 ADMIN_FIX 模式）
            await dbRunAsync(
                `INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason)
                 VALUES (?, 'FORWARD_TO_EXPORTER', ?, ?, ?)`,
                [id, userId, userName, JSON.stringify({
                    exporter_id: exporterId,
                    exporter_name: exporterUser.display_name,
                    contact_user_ids: uniqContactIds,
                    attachment_count: attachmentCount
                })]
            );

            await dbRunAsync('COMMIT');
        } catch (e) {
            try { await dbRunAsync('ROLLBACK'); } catch { /* ignore rollback err */ }
            logger.error(`[forward-to-exporter] 协作单 #${id} DB 事务失败: ${e.message}`, e);
            return res.status(500).json({ error: '转发失败，请重试', code: 'DB_TRANSACTION_FAILED' });
        }

        logger.info(`[forward-to-exporter] 协作单 #${id} PENDING → EXPORTING by ${userName} exporter=${exporterId}(${exporterUser.display_name}) attachments=${attachmentCount}`);

        // === 阶段 2：钉钉副作用（commit 后执行，失败仅记日志不回滚 DB）===
        // 2.1 加 exporter 进群（群已确认存在，前置校验通过）
        let addUserOutcome = { kind: 'skipped', detail: '' };
        try {
            const [appKey, appSecret] = await Promise.all(
                ['dingtalk_app_key', 'dingtalk_app_secret'].map(readSystemConfig)
            );
            if (!appKey || !appSecret) {
                addUserOutcome = { kind: 'skipped', detail: '钉钉配置未填写' };
                insertCollabLog(id, 'FORWARD_ADD_USER_SKIP', userId, userName, '钉钉配置未填写');
            } else {
                const token = await dingtalkNotify.getAccessToken(appKey, appSecret);

                // 如果 exporter 没有 dingtalk_user_id 但有 phone，先反查（按 sendCollabDingtalkRaw 模式）
                let exporterDingUid = exporterUser.dingtalk_user_id;
                if (!exporterDingUid && exporterUser.phone) {
                    try {
                        exporterDingUid = await dingtalkNotify.getUserIdByMobile(token, exporterUser.phone);
                        // 回写缓存（仅在空时回写，对齐 create-chat M3 codex 修订）
                        await dbRunAsync(
                            `UPDATE users SET dingtalk_user_id = ?
                              WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = '')`,
                            [exporterDingUid, exporterUser.id]
                        );
                    } catch (lookupErr) {
                        const lookupCls = dingtalkNotify.classifyError(lookupErr);
                        addUserOutcome = { kind: 'lookup_fail', detail: `getUserIdByMobile:${lookupCls.reason}` };
                        insertCollabLog(id, 'FORWARD_ADD_USER_FAIL', userId, userName,
                            `getUserIdByMobile errcode=${lookupCls.errcode} reason=${lookupCls.reason}`);
                    }
                }

                if (exporterDingUid && addUserOutcome.kind !== 'lookup_fail') {
                    const normalized = String(exporterDingUid).trim();
                    const addResult = await dingtalkNotify.addUserToChat(token, collab.dingtalk_chat_id, [normalized]);
                    const cls = dingtalkNotify.classifyAddUserErrcode(addResult.errcode, addResult.errorUserIds);
                    addUserOutcome = { kind: cls.kind, detail: `errcode=${addResult.errcode} action=${cls.action}` };
                    if (cls.kind === 'soft_success') {
                        insertCollabLog(id, 'FORWARD_ADD_USER_OK', userId, userName, addUserOutcome.detail);
                    } else {
                        insertCollabLog(id, 'FORWARD_ADD_USER_FAIL', userId, userName, addUserOutcome.detail);
                    }
                }
            }
        } catch (e) {
            logger.warn(`[forward-to-exporter] 协作单 #${id} 钉钉加群异常（不阻塞主流程）: ${e.message}`);
            insertCollabLog(id, 'FORWARD_ADD_USER_EXCEPTION', userId, userName, e.message);
            addUserOutcome = { kind: 'exception', detail: e.message };
        }

        // 2.2 钉钉个人推送给 exporter（失败仅记日志）
        let notifyOutcome = { ok: false, detail: '' };
        try {
            // codex 36 审 M-3：platform_base_url 配置注入硬化（避免误填 ) / 空格 / 换行破坏 Markdown 链接）
            // 用 new URL(...) 构造 + 失败降级 fallback；提取 hostname 验证非空（防 javascript:/data: 等协议）
            const FALLBACK_BASE = 'http://192.168.1.100:3000';
            const platformUrlRaw = (await readSystemConfig('platform_base_url')) || FALLBACK_BASE;
            let detailUrl;
            try {
                const url = new URL(`/Data_Collab.html?id=${id}`, platformUrlRaw);
                if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) {
                    throw new Error(`platform_base_url 协议/host 非法: ${url.protocol}//${url.hostname}`);
                }
                detailUrl = url.toString();
            } catch (urlErr) {
                logger.warn(`[forward-to-exporter] platform_base_url 配置非法 (${platformUrlRaw})，降级用 fallback: ${urlErr.message}`);
                detailUrl = new URL(`/Data_Collab.html?id=${id}`, FALLBACK_BASE).toString();
            }

            // codex 31 审 #7 high：所有 ${} 动态字段必须 escapeMarkdown 包裹防注入
            const escape = dingtalkNotify.escapeMarkdown;
            const safeOaNo = escape(collab.oa_request_no || `id${id}`);
            const safeRequesterName = escape(collab.requester_name || '-');
            const safeMatterDesc = escape(collab.description || '（未填写）');
            const safeForwarderName = escape(userName || '-');
            const forwarderRoleLabel = isAdmin ? 'admin' : (isCurrentDeveloper ? '开发' : '对接人');

            const title = `[OA-${safeOaNo}] 协作单转发给您（数据导出人）`;
            const markdown = [
                `### 数据协作单 OA-${safeOaNo}`,
                ``,
                `**业务方**：${safeRequesterName}`,
                `**事项概述**：${safeMatterDesc}`,
                `**转发人**：${safeForwarderName}（${forwarderRoleLabel}）`,
                attachmentCount > 0
                    ? `**附件数**：${attachmentCount} 个，[点击下载查看](${detailUrl})`
                    : `**附件数**：0`,
                ``,
                `请在群内与转发人协商执行细节。如确认不归您做，可在详情页点【退回开发】。`,
                ``,
                `[查看协作单详情](${detailUrl})`
            ].join('\n');

            const sendRes = await sendCollabDingtalkRaw(id, {
                id: exporterUser.id,
                display_name: exporterUser.display_name,
                phone: exporterUser.phone,
                dingtalk_user_id: exporterUser.dingtalk_user_id
            }, title, markdown, { id: userId, name: userName });

            notifyOutcome = { ok: sendRes.ok, detail: sendRes.ok ? '' : JSON.stringify(sendRes.body || {}) };
            if (sendRes.ok) {
                insertCollabLog(id, 'FORWARD_NOTIFY_OK', userId, userName, null);
            } else {
                insertCollabLog(id, 'FORWARD_NOTIFY_FAIL', userId, userName, notifyOutcome.detail);
            }
        } catch (e) {
            logger.warn(`[forward-to-exporter] 协作单 #${id} 钉钉个人推送异常（不阻塞主流程）: ${e.message}`);
            insertCollabLog(id, 'FORWARD_NOTIFY_EXCEPTION', userId, userName, e.message);
            notifyOutcome = { ok: false, detail: e.message };
        }

        return res.json({
            success: true,
            current_status: 'EXPORTING',
            exporter_id: exporterId,
            exporter_name: exporterUser.display_name,
            chat_id: collab.dingtalk_chat_id,
            attachment_count: attachmentCount,
            add_user_outcome: addUserOutcome,
            notify_outcome: notifyOutcome
        });
    } catch (e) {
        logger.error(`[forward-to-exporter] 协作单 #${id} 转发异常: ${e.message}`, e);
        return res.status(500).json({ error: '转发失败，请联系管理员', code: 'FORWARD_FAILED' });
    } finally {
        // codex 36 审 H-1：无论成功/失败/异常都必须 release mutex（防永久 leak）
        if (release) release();
    }
});

// ============================================================
// v1.72.3 admin 直派模式 endpoint 集（2026-05-28）
//   方案：admin直派模式_方案_20260528_v1.0.md §4.2-4.3
//   1. POST /:id/admin-direct-reassign — admin 改派直派接收人（换人）
//   2. POST /:id/admin-direct-fallback — admin 切回流转模式（EXPORTING → PENDING_ASSIGN）
//   3. GET  /:id/reassign-history     — 查询改派历史（详情页展示用）
//
// 共同约束：
//   - 仅 admin 可调（requireAdmin 中间件）
//   - 仅 assign_mode='admin_direct' 可调（normal 模式协作单不可调）
//   - 仅 status='EXPORTING' 可调（其他状态拒绝）
//   - acquire collabExporterTransitionMutex 与 forward/return/submit-export 串行化（v1.72.3 mutex 范围扩展）
//   - 钉钉静默：endpoint 本身不发钉钉，admin 后续自主点详情页通知按钮
// ============================================================
const FALLBACK_REASON_MAX_LEN = 500;

// v1.72.3 改派 endpoint
app.post('/api/collab/requests/:id/admin-direct-reassign', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // === 前置：id 校验（沿用 forward-to-exporter 风格）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // === 前置：new_exporter_user_id 校验 ===
    const rawNewExporterId = req.body && req.body.new_exporter_user_id;
    if (rawNewExporterId === undefined || rawNewExporterId === null) {
        return res.status(400).json({ error: 'new_exporter_user_id 必填', code: 'MISSING_NEW_EXPORTER_ID' });
    }
    if (!/^[1-9]\d*$/.test(String(rawNewExporterId))) {
        return res.status(400).json({ error: 'new_exporter_user_id 必须是正整数', code: 'INVALID_NEW_EXPORTER_ID' });
    }
    const newExporterId = Number(rawNewExporterId);
    if (!Number.isSafeInteger(newExporterId)) {
        return res.status(400).json({ error: 'new_exporter_user_id 超出安全整数范围', code: 'INVALID_NEW_EXPORTER_ID' });
    }

    // === mutex acquire（5s 超时返 503）===
    let release;
    try {
        release = await collabExporterTransitionMutex.acquire(5000);
    } catch (mutexErr) {
        logger.warn(`[admin-direct-reassign] 协作单 #${id} 等待 mutex 超时: ${mutexErr.message}`);
        return res.status(503).json({
            error: '系统繁忙，请稍后重试',
            code: 'COLLAB_EXPORTER_MUTEX_BUSY'
        });
    }

    try {
        // === 取协作单 ===
        const collab = await dbGetAsync(
            `SELECT id, status, assign_mode, exporter_user_id, exporter_name,
                    archived_at, archived_final_at, oa_request_no
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
        }

        // === 守卫：assign_mode = admin_direct ===
        if (collab.assign_mode !== 'admin_direct') {
            return res.status(409).json({
                error: '仅 admin 直派模式协作单可改派',
                code: 'NOT_ADMIN_DIRECT_MODE',
                current_assign_mode: collab.assign_mode
            });
        }

        // === 守卫：软删 / 归档 ===
        if (collab.archived_at) {
            return res.status(409).json({
                error: '协作单已作废，不可改派',
                code: 'PARENT_SOFT_ARCHIVED'
            });
        }
        if (collab.archived_final_at) {
            return res.status(409).json({
                error: '协作单已归档锁定，不可改派',
                code: 'PARENT_ARCHIVED_LOCKED'
            });
        }

        // === 守卫：status = EXPORTING ===
        if (collab.status !== 'EXPORTING') {
            return res.status(409).json({
                error: `仅 EXPORTING 状态可改派，当前状态：${collab.status}`,
                code: 'INVALID_STATE_FOR_REASSIGN',
                current_status: collab.status
            });
        }

        // === 校验新接收人存在 + active ===
        const newExporter = await dbGetAsync(
            'SELECT id, display_name, username, role, status FROM users WHERE id = ?',
            [newExporterId]
        );
        if (!newExporter) {
            return res.status(400).json({
                error: '新接收人不存在',
                code: 'NEW_EXPORTER_NOT_FOUND'
            });
        }
        if (newExporter.status !== 'active') {
            return res.status(400).json({
                error: `新接收人 ${newExporter.display_name || newExporter.username} 已停用`,
                code: 'NEW_EXPORTER_INACTIVE'
            });
        }
        // v1.72.5：admin 直派改派支持 viewer 角色（与创建时白名单对齐）
        if (!['user', 'publisher', 'admin', 'viewer'].includes(newExporter.role)) {
            return res.status(400).json({
                error: '新接收人角色无效（仅 user/publisher/admin/viewer）',
                code: 'NEW_EXPORTER_INVALID_ROLE'
            });
        }
        // v1.74.3：纯只读领导账号不可被改派为数据导出人（前端已过滤+后端兜底，与 admin-direct-create 对称）
        if (isReadonlyLeaderId(newExporter.id)) {
            return res.status(400).json({
                error: '该账号为纯只读领导账号，不可改派为数据导出人',
                code: 'NEW_EXPORTER_IS_READONLY_LEADER'
            });
        }

        const originalExporterName = collab.exporter_name;
        const newExporterName = newExporter.display_name || newExporter.username;

        // === 事务：UPDATE + 操作日志（沿用 v1.71.0 显式 BEGIN IMMEDIATE 模式）===
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            const result = await dbRunAsync(
                `UPDATE collab_requests
                    SET exporter_user_id = ?,
                        exporter_name = ?,
                        exporter_assigned_at = datetime('now','localtime')
                  WHERE id = ?
                    AND status = 'EXPORTING'
                    AND assign_mode = 'admin_direct'
                    AND archived_at IS NULL
                    AND archived_final_at IS NULL`,
                [newExporterId, newExporterName, id]
            );

            if (!result || result.changes === 0) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({
                    error: '协作单状态已变化（可能已被切回流转/作废），请刷新后重试',
                    code: 'STATE_CHANGED'
                });
            }

            // 操作日志（事务内显式 INSERT，不用 fire-and-forget insertCollabLog）
            const reasonText = `原接收人: ${originalExporterName} → 新接收人: ${newExporterName}`;
            await dbRunAsync(
                `INSERT INTO collab_operation_logs
                    (collab_request_id, operation_type, operator_id, operator, reason)
                 VALUES (?, 'ADMIN_DIRECT_REASSIGN', ?, ?, ?)`,
                [id, userId, userName, reasonText]
            );

            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            logger.error(`[admin-direct-reassign] 协作单 #${id} 事务失败: ${txErr.message}`, txErr);
            return res.status(500).json({
                error: '改派失败，请联系管理员',
                code: 'REASSIGN_TX_FAILED'
            });
        }

        logger.info(`[admin-direct-reassign] 协作单 #${id} ${originalExporterName} → ${newExporterName} by ${userName}`);

        return res.json({
            success: true,
            message: `✅ 已改派给${newExporterName}`,
            current_status: 'EXPORTING',
            exporter_id: newExporterId,
            exporter_name: newExporterName,
            previous_exporter_name: originalExporterName
        });
    } catch (e) {
        logger.error(`[admin-direct-reassign] 协作单 #${id} 异常: ${e.message}`, e);
        return res.status(500).json({
            error: '改派失败，请联系管理员',
            code: 'REASSIGN_FAILED'
        });
    } finally {
        if (release) release();
    }
});

// v1.72.3 切回流转 endpoint
app.post('/api/collab/requests/:id/admin-direct-fallback', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // === 前置：id 校验 ===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // === 前置：fallback_reason 校验 ===
    let fallbackReason = null;
    if (req.body && req.body.fallback_reason !== undefined && req.body.fallback_reason !== null) {
        if (typeof req.body.fallback_reason !== 'string') {
            return res.status(400).json({
                error: 'fallback_reason 必须是字符串',
                code: 'INVALID_FALLBACK_REASON'
            });
        }
        const trimmed = req.body.fallback_reason.trim();
        if (trimmed.length > FALLBACK_REASON_MAX_LEN) {
            return res.status(400).json({
                error: `fallback_reason 不能超过 ${FALLBACK_REASON_MAX_LEN} 字符`,
                code: 'FALLBACK_REASON_TOO_LONG'
            });
        }
        fallbackReason = trimmed || null;
    }

    // === mutex acquire ===
    let release;
    try {
        release = await collabExporterTransitionMutex.acquire(5000);
    } catch (mutexErr) {
        logger.warn(`[admin-direct-fallback] 协作单 #${id} 等待 mutex 超时: ${mutexErr.message}`);
        return res.status(503).json({
            error: '系统繁忙，请稍后重试',
            code: 'COLLAB_EXPORTER_MUTEX_BUSY'
        });
    }

    try {
        // === 取协作单 ===
        const collab = await dbGetAsync(
            `SELECT id, status, assign_mode, exporter_user_id, exporter_name,
                    archived_at, archived_final_at, oa_request_no
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
        }

        // === 守卫：assign_mode + status + 软删 / 归档 ===
        if (collab.assign_mode !== 'admin_direct') {
            return res.status(409).json({
                error: '仅 admin 直派模式协作单可切回流转',
                code: 'NOT_ADMIN_DIRECT_MODE',
                current_assign_mode: collab.assign_mode
            });
        }
        if (collab.archived_at) {
            return res.status(409).json({ error: '协作单已作废，不可切回流转', code: 'PARENT_SOFT_ARCHIVED' });
        }
        if (collab.archived_final_at) {
            return res.status(409).json({ error: '协作单已归档锁定，不可切回流转', code: 'PARENT_ARCHIVED_LOCKED' });
        }
        if (collab.status !== 'EXPORTING') {
            return res.status(409).json({
                error: `仅 EXPORTING 状态可切回流转，当前状态：${collab.status}`,
                code: 'INVALID_STATE_FOR_FALLBACK',
                current_status: collab.status
            });
        }

        const originalExporterName = collab.exporter_name;

        // === 事务：UPDATE 状态 + 字段清空 + 附件 superseded + 操作日志 ===
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            // 1. UPDATE collab_requests
            const collabResult = await dbRunAsync(
                `UPDATE collab_requests
                    SET status = 'PENDING_ASSIGN',
                        exporter_user_id = NULL,
                        exporter_name = NULL,
                        exporter_assigned_at = NULL,
                        forwarded_to_exporter_at = NULL
                  WHERE id = ?
                    AND status = 'EXPORTING'
                    AND assign_mode = 'admin_direct'
                    AND archived_at IS NULL
                    AND archived_final_at IS NULL`,
                [id]
            );

            if (!collabResult || collabResult.changes === 0) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({
                    error: '协作单状态已变化，请刷新后重试',
                    code: 'STATE_CHANGED'
                });
            }

            // 2. 历史附件标 superseded（仅 result_data / result_script 主交付物，沿用 v1.71.0 撞墙附件保留模式）
            await dbRunAsync(
                `UPDATE collab_attachments
                    SET status = 'superseded',
                        superseded_at = datetime('now','localtime')
                  WHERE collab_request_id = ?
                    AND status = 'active'
                    AND attachment_type IN ('result_data', 'result_script')`,
                [id]
            );

            // 3. 操作日志
            const reasonText = fallbackReason
                ? `原 exporter: ${originalExporterName} / 原因: ${fallbackReason}`
                : `原 exporter: ${originalExporterName}`;
            await dbRunAsync(
                `INSERT INTO collab_operation_logs
                    (collab_request_id, operation_type, operator_id, operator, reason)
                 VALUES (?, 'ADMIN_DIRECT_FALLBACK', ?, ?, ?)`,
                [id, userId, userName, reasonText]
            );

            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            logger.error(`[admin-direct-fallback] 协作单 #${id} 事务失败: ${txErr.message}`, txErr);
            return res.status(500).json({
                error: '切回流转失败，请联系管理员',
                code: 'FALLBACK_TX_FAILED'
            });
        }

        logger.info(`[admin-direct-fallback] 协作单 #${id} EXPORTING → PENDING_ASSIGN by ${userName}, prev exporter=${originalExporterName}${fallbackReason ? ` reason=${fallbackReason.slice(0, 50)}` : ''}`);

        return res.json({
            success: true,
            message: '✅ 已切回流转模式，请指派一级负责人',
            current_status: 'PENDING_ASSIGN',
            assign_mode: 'admin_direct',  // 保留作历史标识（assign_mode 单调）
            previous_exporter_name: originalExporterName
        });
    } catch (e) {
        logger.error(`[admin-direct-fallback] 协作单 #${id} 异常: ${e.message}`, e);
        return res.status(500).json({
            error: '切回流转失败，请联系管理员',
            code: 'FALLBACK_FAILED'
        });
    } finally {
        if (release) release();
    }
});

// v1.72.3 改派历史查询（详情页改派历史区块展示用，admin 专属）
app.get('/api/collab/requests/:id/reassign-history', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    try {
        const logs = await dbAllAsync(
            `SELECT id, created_at, operator, operator_id, reason
               FROM collab_operation_logs
              WHERE collab_request_id = ?
                AND operation_type = 'ADMIN_DIRECT_REASSIGN'
              ORDER BY created_at DESC, id DESC`,
            [id]
        );
        return res.json({ success: true, logs });
    } catch (e) {
        logger.error(`[reassign-history] 协作单 #${id} 查询异常: ${e.message}`, e);
        return res.status(500).json({ error: '查询改派历史失败', code: 'HISTORY_QUERY_FAILED' });
    }
});

// v1.71.0 三级转发：数据导出人退回任务给开发（方案 §5 + v0.1 决策 R-1~R-6）
//
// 入参（body）：
//   - return_reason: enum string（必填，5 选 1，方案 §5.2 + codex 37 审 M-5 采纳新增 missing_info）
//   - return_note: string（可选 ≤500 字，codex 37 审 L-1 采纳；选 other/missing_info 时建议填写但不强制）
//
// 业务规则（v0.1 决策 R-1 ~ R-6）：
//   - 仅 EXPORTING 状态可调
//   - 仅当前 exporter_user_id === req.user.id 可调（admin/dev/contact 都不行；admin 兜底走已有 admin-fix endpoint）
//   - 状态机：EXPORTING → PENDING
//   - exporter_user_id / exporter_name 字段保留（不清空，方案 §5.3.5 历史展示）
//   - 旧附件保留只读展示（不动 status）
//   - 不发钉钉通知（v0.1 决策依赖群内沟通；codex 37 M-7 关切已在群内沟通中覆盖）
//
// 事务：BEGIN IMMEDIATE → UPDATE（双 WHERE：status='EXPORTING' + exporter_user_id=? + archived 双轨守卫）
//        → await INSERT operation_logs（显式事务内，不用 fire-and-forget insertCollabLog）→ COMMIT
//        失败 ROLLBACK 返 500
//
// 并发：包在 collabExporterTransitionMutex 内（codex 37 审 H-1+H-2+H-3 全部 must-have）
const VALID_RETURN_REASONS = ['business_permission', 'dev_permission', 'underlying_query', 'missing_info', 'other'];
const RETURN_NOTE_MAX_LEN = 500;
// v1.71.0 Commit E：数据导出人提交交付物 export_summary 上限（与 RETURN_NOTE 对齐）
const EXPORT_SUMMARY_MAX_LEN = 500;

app.post('/api/collab/requests/:id/return-to-dev', authenticateToken, requireExporterOrNonViewer, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;

    // === 前置：id 校验（沿用 forward/assign 风格）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }

    // === 前置：return_reason 枚举校验 ===
    const rawReason = req.body && req.body.return_reason;
    if (!rawReason || typeof rawReason !== 'string') {
        return res.status(400).json({
            error: `return_reason 必填`,
            code: 'MISSING_RETURN_REASON',
            valid_values: VALID_RETURN_REASONS
        });
    }
    if (!VALID_RETURN_REASONS.includes(rawReason)) {
        return res.status(400).json({
            error: `return_reason 必须是：${VALID_RETURN_REASONS.join(' / ')}`,
            code: 'INVALID_RETURN_REASON',
            valid_values: VALID_RETURN_REASONS
        });
    }
    const returnReason = rawReason;

    // === 前置：return_note 校验（可选，≤500 字）===
    let returnNote = null;
    if (req.body && req.body.return_note !== undefined && req.body.return_note !== null) {
        if (typeof req.body.return_note !== 'string') {
            return res.status(400).json({ error: 'return_note 必须是字符串', code: 'INVALID_RETURN_NOTE' });
        }
        const trimmed = req.body.return_note.trim();
        if (trimmed.length > RETURN_NOTE_MAX_LEN) {
            return res.status(400).json({
                error: `return_note 不能超过 ${RETURN_NOTE_MAX_LEN} 字符`,
                code: 'RETURN_NOTE_TOO_LONG',
                max_length: RETURN_NOTE_MAX_LEN,
                actual_length: trimmed.length
            });
        }
        returnNote = trimmed || null;  // 空串视为未填
    }

    // === 在 collabExporterTransitionMutex 内执行主流程（codex 37 审 H-1+H-2+H-3 mutex 必须）===
    let release;
    try {
        release = await collabExporterTransitionMutex.acquire(5000);
    } catch (mutexErr) {
        logger.warn(`[return-to-dev] 协作单 #${id} 等待 collabExporterTransitionMutex 超时: ${mutexErr.message}`);
        return res.status(503).json({
            error: '系统繁忙，请稍后重试',
            code: 'COLLAB_EXPORTER_MUTEX_BUSY'
        });
    }

    try {
        // === 取协作单 ===
        const collab = await dbGetAsync(
            `SELECT id, status, archived_at, archived_final_at, exporter_user_id, exporter_name
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
        }

        // === 软删除 / 归档守卫 ===
        if (collabSubmitHelpers.isSoftArchived(collab)) {
            return res.status(409).json({ error: '协作单已作废，不可退回', code: 'PARENT_SOFT_ARCHIVED' });
        }
        if (collabSubmitHelpers.isFinalArchived(collab)) {
            return res.status(409).json({ error: '协作单已归档锁定，不可退回', code: 'PARENT_ARCHIVED_LOCKED' });
        }

        // === 状态守卫：仅 EXPORTING 可退回 ===
        if (collab.status !== 'EXPORTING') {
            return res.status(409).json({
                error: `仅 EXPORTING 状态可退回开发，当前状态：${collab.status}`,
                code: 'INVALID_STATE_FOR_RETURN',
                current_status: collab.status
            });
        }

        // === 权限守卫：仅当前 exporter 可退回（v0.1 决策 R-3）===
        // admin 兜底场景走已有 admin-fix endpoint（codex 37 审 M-6 部分采纳）
        if (collab.exporter_user_id == null || Number(collab.exporter_user_id) !== userId) {
            return res.status(403).json({
                error: '仅当前数据导出人可退回（admin 兜底请走 admin-fix endpoint）',
                code: 'ONLY_EXPORTER_CAN_RETURN'
            });
        }

        // === 阶段 1：DB 原子事务（BEGIN IMMEDIATE + UPDATE + await INSERT log + COMMIT）===
        // codex 37 审 M-2 采纳：log 必须 await 在事务内，不用 fire-and-forget insertCollabLog
        try {
            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

            // UPDATE 双 WHERE 守卫：status=EXPORTING + exporter_user_id=userId + archived 双轨
            // 防 mutex 释放间隙状态被并发改 / 被 admin 作废
            // exporter 字段保留（v0.1 R-2 决策：字段保留用于 §5.3.5 历史展示）
            const updateResult = await dbRunAsync(
                `UPDATE collab_requests
                    SET status = 'PENDING'
                  WHERE id = ?
                    AND status = 'EXPORTING'
                    AND exporter_user_id = ?
                    AND archived_at IS NULL
                    AND archived_final_at IS NULL`,
                [id, userId]
            );

            if (!updateResult || updateResult.changes === 0) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({
                    error: '协作单状态已变更，请刷新重试',
                    code: 'CONCURRENT_STATE_CHANGE'
                });
            }

            // await INSERT operation_logs（reason 字段存 JSON 字符串，沿用 forward 模式）
            await dbRunAsync(
                `INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason)
                 VALUES (?, 'RETURN_TO_DEV', ?, ?, ?)`,
                [id, userId, userName, JSON.stringify({
                    return_reason: returnReason,
                    return_note: returnNote,
                    exporter_user_id: collab.exporter_user_id,
                    exporter_name: collab.exporter_name
                })]
            );

            await dbRunAsync('COMMIT');
        } catch (e) {
            try { await dbRunAsync('ROLLBACK'); } catch { /* ignore rollback err */ }
            logger.error(`[return-to-dev] 协作单 #${id} DB 事务失败: ${e.message}`, e);
            return res.status(500).json({ error: '退回失败，请重试', code: 'DB_TRANSACTION_FAILED' });
        }

        logger.info(`[return-to-dev] 协作单 #${id} EXPORTING → PENDING by ${userName}(exporter id=${userId}) reason=${returnReason}${returnNote ? ' note=' + returnNote.slice(0, 50) : ''}`);

        return res.json({
            success: true,
            current_status: 'PENDING',
            return_reason: returnReason,
            return_note: returnNote,
            // exporter 字段保留（前端用于展示"前导出人（已退回）"，详见方案 §5.3.5）
            historic_exporter_user_id: collab.exporter_user_id,
            historic_exporter_name: collab.exporter_name
        });
    } catch (e) {
        logger.error(`[return-to-dev] 协作单 #${id} 退回异常: ${e.message}`, e);
        return res.status(500).json({ error: '退回失败，请联系管理员', code: 'RETURN_FAILED' });
    } finally {
        if (release) release();
    }
});

// ==========================================================
// 取数交付质量记录 v3.0 Commit D：打回开发 return-quality（2026-06-08）
//
//   定位：对接人/admin 把"已成功交付（DONE）的取数结果"打回开发重做，带原因分类。
//     与 return-to-dev（三级转发 EXPORTING→PENDING by exporter）是**两条独立退回链路**——
//     状态/权限/字段全不同，故走新抽的 transitionToDevPending 骨架（H-3：抽共性不套旧 endpoint），
//     **不碰 exporter 字段 / 不接受 EXPORTING 源状态**。
//
//   ⚠️ 状态机（codex 76 末次合并审 H-1 修正）：DONE → PENDING（带 submission_version 乐观锁防重复打回）。
//     **源状态是 DONE 不是 SUBMITTED**——dev /submit 走 smoke 通过后 activateNewVersion 写 DONE
//     （collab-attachment-versioning:534 + server:14028 current_status:'DONE'），SUBMITTED 只是 smoke
//     失败的中间态（13878）。打回 = 对接人对"已成功交付的结果"不满意让开发重做（DONE→PENDING，
//     开发走 /submit 重传 version+1 重走 smoke）。原误用 SUBMITTED 致打回对正常交付单完全失效。
//   权限（M-6）：admin 或本单 contact_person（后端校验，前端隐藏不替代）
//   body：{ reason_type（4 枚举校验）, reason_note（可选 ≤500）}
//   同事务（M-4）：UPDATE status=PENDING + INSERT collab_return_record + INSERT operation_log（transitionToDevPending 内）
//   返工计数（M-5）：所有 reason_type 都写 return_record；聚合时仅 DEV_QUALITY 计返工（E 阶段渲染区分）
//   submission_seq（用户拍板）：= 被打回时的 collab_requests.submission_version（与 C2 quality_record 同源对齐）
//   无质量记录也允许打回（L-1）：return_record 关联 request+submission_seq，不强依赖 quality_record_id
//   钉钉：本期不发（与 return-to-dev 一致依赖群内沟通；后续按需加）
// ==========================================================
const VALID_RETURN_QUALITY_REASON_TYPES = ['DEV_QUALITY', 'REQ_CHANGE', 'ENV_ISSUE', 'BIZ_ADJUST'];
// codex 74 M-3：reason_note 限长在此 endpoint 层做（collab_return_record schema 无 CHECK，记 backlog 等 migration 搭车）。
//   ⚠️ 约定：未来若新增 collab_return_record 写入路径（如多产出子项打回），**必须复用此限长校验**，
//   不要绕过——schema 层暂无 length CHECK 兜底，旁路写入超长会污染展示/统计端。
const RETURN_QUALITY_NOTE_MAX_LEN = 500;

app.post('/api/collab/requests/:id/return-quality', authenticateToken, requireNonViewer, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const isAdmin = req.user.role === 'admin';

    // === 前置：id 校验 ===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }

    // === 前置：reason_type 枚举校验（4 枚举，与 collab_return_record CHECK 对齐）===
    const rawType = req.body && req.body.reason_type;
    if (!rawType || typeof rawType !== 'string' || !VALID_RETURN_QUALITY_REASON_TYPES.includes(rawType)) {
        return res.status(400).json({
            error: `reason_type 必须是：${VALID_RETURN_QUALITY_REASON_TYPES.join(' / ')}`,
            code: 'INVALID_REASON_TYPE',
            valid_values: VALID_RETURN_QUALITY_REASON_TYPES
        });
    }
    const reasonType = rawType;

    // === 前置：reason_note 校验（可选，≤500 字）===
    let reasonNote = null;
    if (req.body && req.body.reason_note !== undefined && req.body.reason_note !== null) {
        if (typeof req.body.reason_note !== 'string') {
            return res.status(400).json({ error: 'reason_note 必须是字符串', code: 'INVALID_REASON_NOTE' });
        }
        const trimmed = req.body.reason_note.trim();
        if (trimmed.length > RETURN_QUALITY_NOTE_MAX_LEN) {
            return res.status(400).json({
                error: `reason_note 不能超过 ${RETURN_QUALITY_NOTE_MAX_LEN} 字符`,
                code: 'REASON_NOTE_TOO_LONG',
                max_length: RETURN_QUALITY_NOTE_MAX_LEN,
                actual_length: trimmed.length
            });
        }
        reasonNote = trimmed || null;
    }

    try {
        // === 取协作单（含权限/状态/版本所需字段）===
        const collab = await dbGetAsync(
            `SELECT id, status, archived_at, archived_final_at,
                    contact_person_id, contact_person_name, submission_version
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
        }

        // === 软删除 / 归档守卫 ===
        if (collabSubmitHelpers.isSoftArchived(collab)) {
            return res.status(409).json({ error: '协作单已作废，不可打回', code: 'PARENT_SOFT_ARCHIVED' });
        }
        if (collabSubmitHelpers.isFinalArchived(collab)) {
            return res.status(409).json({ error: '协作单已归档锁定，不可打回', code: 'PARENT_ARCHIVED_LOCKED' });
        }

        // === 权限守卫：admin 或本单 contact_person（M-6 后端校验）===
        const isContactPerson = collab.contact_person_id != null && Number(collab.contact_person_id) === userId;
        if (!isAdmin && !isContactPerson) {
            return res.status(403).json({
                error: '仅本单对接人或管理员可打回',
                code: 'ONLY_CONTACT_OR_ADMIN'
            });
        }

        // === 状态守卫：仅 DONE 可打回（codex 76 H-1）===
        //   dev /submit smoke 通过后是 DONE（正常交付）；SUBMITTED 是 smoke 失败中间态不该打回；
        //   EXPORTING 是三级转发链路（走 return-to-dev）。打回 = 对已成功交付的结果不满意让开发重做。
        if (collab.status !== 'DONE') {
            return res.status(409).json({
                error: `仅已完成（DONE）的取数结果可打回开发，当前状态：${collab.status}`,
                code: 'INVALID_STATE_FOR_RETURN_QUALITY',
                current_status: collab.status
            });
        }

        // 被打回的提交版本（与 C2 quality_record 同源对齐）
        //   codex 74 M-1：显式校验 >=1，不用 || 0 兜底。DONE 必经成功 /submit →
        //   activateNewVersion 写 version=newVer=oldVer+1 必 >=1；version<1 的 DONE 是异常数据，
        //   拒绝而非写 seq=0 污染与 quality_record 的 request+seq 关联。
        const seq = Number(collab.submission_version);
        if (!Number.isSafeInteger(seq) || seq < 1) {
            logger.error(`[return-quality] 协作单 #${id} DONE 但 submission_version 异常(${collab.submission_version})，拒绝打回`);
            return res.status(409).json({
                error: '协作单提交版本异常，无法打回，请联系管理员',
                code: 'INVALID_SUBMISSION_VERSION'
            });
        }

        // === 同事务转换：DONE → PENDING（乐观锁 submission_version）+ return_record + log ===
        //   transitionToDevPending 管事务骨架；extraWrites 在同事务内插 return_record + operation_log（M-4 原子）。
        let result;
        try {
            result = await collabSubmitHelpers.transitionToDevPending(
                { runAsync: dbRunAsync },
                {
                    requestId: id,
                    fromStatus: 'DONE',
                    // 乐观锁：submission_version 防重复打回（第二次打回时状态已 PENDING，changes=0 拒）
                    //   + archived 双轨守卫（无占位符，骨架按 sql 是否含 '?' 决定是否入参）
                    extraGuards: [
                        { sql: 'submission_version = ?', value: seq },
                        { sql: 'archived_at IS NULL' },
                        { sql: 'archived_final_at IS NULL' },
                    ],
                    // codex 76 H-1 衍生：DONE→PENDING 清已完成痕迹，避免详情页"PENDING 却残留旧完成时间/验收通过"矛盾。
                    //   与 /submit 前置 UPDATE（DONE 重传时也清 done_at/sql_validation_error）口径一致。
                    //   codex 77 复审 L-1：已覆盖 DONE 独有的完成态标量字段；旧产出附件（result_data 等）是历史留痕，
                    //   UI 按 status/submission_version 区分展示（开发重传时 supersede），非需清的状态字段。
                    clearFields: ['done_at', 'sql_validated_at', 'sql_validation_status', 'sql_validation_error'],
                    extraWrites: async (dbA) => {
                        // 打回记录（reason_type 全记，聚合时仅 DEV_QUALITY 计返工 M-5）
                        await dbA.runAsync(
                            `INSERT INTO collab_return_record
                                (collab_request_id, collab_sub_item_id, submission_seq,
                                 returned_by, returned_by_name, reason_type, reason_note,
                                 status_before, status_after)
                             VALUES (?, NULL, ?, ?, ?, ?, ?, 'DONE', 'PENDING')`,
                            [id, seq, userId, userName, reasonType, reasonNote]
                        );
                        // operation_log（同事务 await，不用 fire-and-forget，与 return-to-dev 模式一致）
                        await dbA.runAsync(
                            `INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason)
                             VALUES (?, 'RETURN_QUALITY', ?, ?, ?)`,
                            [id, userId, userName, JSON.stringify({
                                reason_type: reasonType,
                                reason_note: reasonNote,
                                submission_seq: seq,
                                is_rework: reasonType === 'DEV_QUALITY',
                                // codex 74 L-2：补状态快照，与 return_record 对齐，只看 operation_logs 也能读全状态变化
                                status_before: 'DONE',
                                status_after: 'PENDING'
                            })]
                        );
                    },
                }
            );
        } catch (e) {
            logger.error(`[return-quality] 协作单 #${id} 事务失败: ${e.message}`, e);
            return res.status(500).json({ error: '打回失败，请重试', code: 'DB_TRANSACTION_FAILED' });
        }

        if (!result.ok) {
            // changes=0：状态已变 / 并发 / 重复打回（已是 PENDING）
            return res.status(409).json({
                error: '协作单状态已变更（可能已被打回或提交版本已变），请刷新重试',
                code: 'CONCURRENT_STATE_CHANGE'
            });
        }

        logger.info(`[return-quality] 协作单 #${id} DONE → PENDING by ${userName}(id=${userId}) reason_type=${reasonType} seq=${seq} rework=${reasonType === 'DEV_QUALITY'}${reasonNote ? ' note=' + reasonNote.slice(0, 50) : ''}`);

        return res.json({
            success: true,
            current_status: 'PENDING',
            reason_type: reasonType,
            reason_note: reasonNote,
            submission_seq: seq,
            is_rework: reasonType === 'DEV_QUALITY'  // 前端可据此提示"计入返工"
        });
    } catch (e) {
        logger.error(`[return-quality] 协作单 #${id} 打回异常: ${e.message}`, e);
        return res.status(500).json({ error: '打回失败，请联系管理员', code: 'RETURN_QUALITY_FAILED' });
    }
});

// v1.71.0 Commit E：数据导出人提交交付物（方案 §6 + codex 39 取舍审落地）
//
// 入参（multipart）：
//   - result_data: 1 必填（.xlsx/.xls）
//   - result_data_screenshot: 1 必填（.png/.jpg/.jpeg/.gif/.webp）
//   - export_summary: 可选字符串 ≤500 字
//
// 业务规则：
//   - 状态 EXPORTING → SUBMITTED（与 dev 走 POST /submit 后状态一致，admin 走 DONE 验收）
//   - 仅当前 exporter_user_id === req.user.id 可调
//   - 附件入库 attachment_type：result_data + screenshot（codex 39 H-3 采纳：不新增 result_data_screenshot 类型）
//     · multer field 名仍叫 result_data_screenshot（前端字段名清晰），endpoint 内入库映射 attachment_type='screenshot'
//     · 截图来源 = uploaded_by === collab.exporter_user_id（Commit F 渲染依据）
//   - submission_version 不递增（codex 39 H-1 部分采纳：保现有"dev 提交次数"语义，用 uploaded_by + log 区分）
//   - 双向 supersede（codex 39 H-2 采纳）：本次 supersede 同 type 旧 active，日志 reason JSON 记录被覆盖附件 id/type/original_name
//   - UPDATE 清空 sql_validation_status + sql_validation_error（codex 39 M-5 采纳：不残留 dev submit 旧校验）
//   - 钉钉个人推送 dev + admin（codex 39 M-3 采纳：best-effort + commit 后执行 + 失败仅记 NOTIFY_FAIL 不回滚）
//
// 并发：包在 collabExporterTransitionMutex 内（codex 39 M-6 采纳，沿用 Commit D T17 模式）
//
// 文件落盘：照搬 admin-submit-on-behalf 13369-13451 精简模式（codex 39 H-1 采纳：不调 activateNewVersion）
//   理由：activateNewVersion 强制 result_data+result_script 完整快照 + 跑 smoke test，与 exporter 只交 result_data 冲突
//
// 响应字段（codex 39 L-3 采纳，供 Commit F 直接消费）：
//   - current_status: 'SUBMITTED'
//   - export_summary: string | null（回显）
//   - superseded_attachments: [{ id, attachment_type, original_name, uploaded_by, uploaded_by_name }]
//
// XSS / Markdown 注入防护（codex 39 L-1 采纳，三输出点）：
//   - 钉钉 markdown：所有用户输入用 dingtalkNotify.escapeMarkdown 包裹（本 endpoint 做）
//   - 日志 reason JSON：原文存（不截断不 escape，操作日志原文便于复盘）（本 endpoint 做）
//   - 前端详情页 HTML：escapeHtml 包裹（Commit F 做）
app.post('/api/collab/requests/:id/submit-export',
    authenticateToken,
    requireExporterOrNonViewer,
    // multer 错误捕获（同 POST /submit 风格）
    (req, res, next) => {
        const handler = collabUpload.fields([
            { name: 'result_data', maxCount: 1 },
            { name: 'result_data_screenshot', maxCount: 1 }
        ]);
        handler(req, res, (err) => {
            if (!err) return next();
            const isMulterErr = err && err.name === 'MulterError';
            const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
            try {
                const allFiles = [];
                if (req.files) {
                    Object.values(req.files).forEach(arr => { if (Array.isArray(arr)) allFiles.push(...arr); });
                }
                collabSubmitHelpers.cleanupPendingFiles(allFiles, logger);
            } catch (_) { /* ignore */ }
            logger.warn(`[submit-export] multer error: code=${code} msg=${err.message}`);
            return res.status(400).json({
                error: '附件上传失败',
                code,
                detail: isMulterErr ? err.message : err.message,
            });
        });
    },
    async (req, res) => {
        const idStr = req.params.id;
        const userId = Number(req.user.id);
        const userName = req.user.display_name || req.user.username || `user#${userId}`;

        const cleanupPending = () => {
            try {
                const allFiles = [];
                if (req.files) {
                    Object.values(req.files).forEach(arr => { if (Array.isArray(arr)) allFiles.push(...arr); });
                }
                collabSubmitHelpers.cleanupPendingFiles(allFiles, logger);
            } catch (_) { /* ignore */ }
        };

        // === 前置：id 校验（沿用 forward/return 风格）===
        if (!/^[1-9]\d*$/.test(idStr)) {
            cleanupPending();
            return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
        }
        const id = parseInt(idStr, 10);
        if (!Number.isSafeInteger(id)) {
            cleanupPending();
            return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
        }
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            cleanupPending();
            return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
        }

        // === 前置：附件必填校验 ===
        const resultDataFile = req.files && req.files.result_data && req.files.result_data[0];
        const screenshotFile = req.files && req.files.result_data_screenshot && req.files.result_data_screenshot[0];
        if (!resultDataFile || !screenshotFile) {
            cleanupPending();
            return res.status(400).json({
                error: 'result_data + result_data_screenshot 均必填',
                code: 'MISSING_REQUIRED_FILES'
            });
        }

        // === 前置：result_data 文件二次校验（按 result_data 规则：.xlsx/.xls + 100MB）===
        const dataCheck = validateCollabAttachmentRule('result_data', resultDataFile.originalname, resultDataFile.size);
        if (!dataCheck.ok) {
            cleanupPending();
            return res.status(400).json({ error: dataCheck.error, code: 'INVALID_RESULT_DATA' });
        }
        // === 前置：screenshot 文件二次校验（按 screenshot 规则：图片 + 10MB，codex 39 L-2 采纳）===
        // v1.77.0 收紧：screenshot 规则为「原始单据截图」放开了 .pdf，但导出截图业务语义=屏幕截图，
        //   本入口单独排除 PDF（共享规则的两个入口语义不同，防连带放宽）
        const shotExt = normalizeAttachmentExt(screenshotFile.originalname);
        if (shotExt === '.pdf') {
            cleanupPending();
            return res.status(400).json({ error: '导出数据截图仅支持图片格式（PNG/JPG/GIF/WEBP），不支持 PDF', code: 'INVALID_SCREENSHOT' });
        }
        const shotCheck = validateCollabAttachmentRule('screenshot', screenshotFile.originalname, screenshotFile.size);
        if (!shotCheck.ok) {
            cleanupPending();
            return res.status(400).json({ error: shotCheck.error, code: 'INVALID_SCREENSHOT' });
        }

        // === 前置：export_summary 校验（可选，≤500 字，codex 39 L-1 采纳）===
        let exportSummary = null;
        if (req.body && req.body.export_summary !== undefined && req.body.export_summary !== null) {
            if (typeof req.body.export_summary !== 'string') {
                cleanupPending();
                return res.status(400).json({ error: 'export_summary 必须是字符串', code: 'INVALID_EXPORT_SUMMARY' });
            }
            const trimmed = req.body.export_summary.trim();
            if (trimmed.length > EXPORT_SUMMARY_MAX_LEN) {
                cleanupPending();
                return res.status(400).json({
                    error: `export_summary 不能超过 ${EXPORT_SUMMARY_MAX_LEN} 字符`,
                    code: 'EXPORT_SUMMARY_TOO_LONG',
                    max_length: EXPORT_SUMMARY_MAX_LEN,
                    actual_length: trimmed.length
                });
            }
            exportSummary = trimmed || null;  // 空串视为未填
        }

        // === 在 collabExporterTransitionMutex 内执行主流程（codex 39 M-6 采纳 mutex 必须）===
        let release;
        try {
            release = await collabExporterTransitionMutex.acquire(5000);
        } catch (mutexErr) {
            cleanupPending();
            logger.warn(`[submit-export] 协作单 #${id} 等待 collabExporterTransitionMutex 超时: ${mutexErr.message}`);
            return res.status(503).json({
                error: '系统繁忙，请稍后重试',
                code: 'COLLAB_EXPORTER_MUTEX_BUSY'
            });
        }

        let movedFiles = [];  // [{ attachment_type, final_path, original_name }]
        let supersededAttachments = [];  // codex 39 H-2 采纳：日志 + 响应记录覆盖附件
        let collabSnapshot = null;        // 用于钉钉副作用

        try {
            // === 取协作单 ===
            const collab = await dbGetAsync(
                `SELECT id, status, archived_at, archived_final_at, oa_request_no, description,
                        developer_id, exporter_user_id, exporter_name, attachment_dir, submission_version,
                        requester_dept, requester_name, created_at
                   FROM collab_requests WHERE id = ?`,
                [id]
            );
            if (!collab) {
                cleanupPending();
                return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });
            }

            // === 软删除 / 归档守卫 ===
            if (collabSubmitHelpers.isSoftArchived(collab)) {
                cleanupPending();
                return res.status(409).json({ error: '协作单已作废，不可提交', code: 'PARENT_SOFT_ARCHIVED' });
            }
            if (collabSubmitHelpers.isFinalArchived(collab)) {
                cleanupPending();
                return res.status(409).json({ error: '协作单已归档锁定，不可提交', code: 'PARENT_ARCHIVED_LOCKED' });
            }

            // === 状态守卫：仅 EXPORTING 可调 ===
            if (collab.status !== 'EXPORTING') {
                cleanupPending();
                return res.status(409).json({
                    error: `仅 EXPORTING 状态可提交，当前状态：${collab.status}`,
                    code: 'INVALID_STATE_FOR_EXPORT_SUBMIT',
                    current_status: collab.status
                });
            }

            // === 权限守卫：仅当前 exporter 可提交 ===
            if (collab.exporter_user_id == null || Number(collab.exporter_user_id) !== userId) {
                cleanupPending();
                return res.status(403).json({
                    error: '仅当前数据导出人可提交（admin 兜底请走 admin-submit-on-behalf endpoint）',
                    code: 'ONLY_EXPORTER_CAN_SUBMIT'
                });
            }

            // === 文件落盘：照搬 admin-submit-on-behalf 路径（codex 39 H-1 采纳）===
            const versInternal = collabVersioning._internal;

            // ① 路径校验：每个 multer 文件必须在 _pending/{id}/ 下
            const pendingRoot = path.join(COLLAB_UPLOAD_BASE, '_pending', String(id));
            const uploadedFiles = [
                { attachment_type: 'result_data', file: resultDataFile },
                // codex 39 H-3 采纳：multer field 名 result_data_screenshot 但入库 attachment_type='screenshot'
                { attachment_type: 'screenshot', file: screenshotFile }
            ];
            for (const item of uploadedFiles) {
                const check = versInternal.ensureInsideRoot(item.file.path, pendingRoot);
                if (!check.ok) {
                    cleanupPending();
                    logger.warn(`[submit-export] 路径越界: ${check.error}`);
                    return res.status(400).json({ error: '附件路径校验失败', code: 'PATH_VIOLATION' });
                }
            }

            // ② 决定目标目录（首次激活才需算）
            let attachmentDirName = collab.attachment_dir;
            if (!attachmentDirName) {
                attachmentDirName = versInternal.computeAttachmentDirName(id, collab.description);
            }
            const targetDir = path.join(COLLAB_UPLOAD_BASE, attachmentDirName);
            const targetCheck = versInternal.ensureInsideRoot(targetDir, COLLAB_UPLOAD_BASE);
            if (!targetCheck.ok) {
                cleanupPending();
                return res.status(400).json({ error: '目标目录越界', code: 'PATH_VIOLATION' });
            }
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // ③ v1.72.0：预分配 attachment_seq（screenshot 走 sc/ex 通道），rd 复用 submission_version
            //    submit-export 不递增 submission_version → rd 复用 collab.submission_version 作 seq
            //    sc 用 allocateAttachmentSeq 预读 MAX+1
            //    并发保护：依赖 collabExporterTransitionMutex 全局锁（v1.71.0 引入）— 同协作单同 exporter
            //    submit-export/forward/return 串行化保证 → 不会有同 (rid, sc) 并发竞态（codex 47 H-1 修订）
            //    seq 与 INSERT submission_version 统一：rd 用 collab.submission_version || 1，
            //    INSERT 也写同值 → 文件名 seq 与 DB version 字段一致（codex 47 H-2 修订）
            const rdSeq = collab.submission_version || 1;
            const scSeq = await collabVersioning.allocateAttachmentSeq(
                { getAsync: dbGetAsync }, id, 'screenshot'
            );
            const seqByType = { result_data: rdSeq, screenshot: scSeq };

            // ④ rename 文件到正式目录（v1.72.0 新规则文件名）
            try {
                for (const item of uploadedFiles) {
                    const ext = path.extname(item.file.originalname || '');
                    const finalName = collabVersioning.buildFinalAttachmentName({
                        oaRequestNo: collab.oa_request_no,
                        createdAt: collab.created_at,
                        seq: seqByType[item.attachment_type],
                        attachmentType: item.attachment_type,
                        isFailed: false,
                        displayName: userName,
                        username: userName,
                        ext,
                    });
                    const finalPath = path.join(targetDir, finalName);
                    fs.renameSync(item.file.path, finalPath);
                    movedFiles.push({
                        attachment_type: item.attachment_type,
                        final_path: finalPath,
                        original_name: item.file.originalname,
                        attachment_seq: seqByType[item.attachment_type],
                    });
                }
            } catch (renameErr) {
                logger.error(`[submit-export] 文件移动失败: ${renameErr.message}`);
                try {
                    await versInternal.moveToOrphaned(
                        movedFiles.map(f => ({ final_path: f.final_path })),
                        id, (collab.submission_version || 0), COLLAB_UPLOAD_BASE, logger
                    );
                } catch (_) { /* ignore */ }
                cleanupPending();
                return res.status(500).json({ error: '附件文件移动失败', code: 'FILE_MOVE_FAILED' });
            }

            // === 阶段 1：BEGIN IMMEDIATE 事务（supersede 同 type 旧 active + INSERT 新 active + UPDATE collab_requests + INSERT log）===
            //   codex 39 H-1 + codex 47 H-2：submit-export 不递增 submission_version
            //   首次 submit-export 时 collab.submission_version 可能为 NULL/0，用 `|| 1` 统一 rdSeq 与 INSERT 值
            //   → 文件名 seq 与 DB submission_version 字段始终一致
            const newSubmissionVersion = collab.submission_version || 1;

            try {
                await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

                // 先查同 type 旧 active 用于日志（codex 39 H-2 + M-4 采纳）
                // 注意：screenshot 类型也会同 type supersede，这是预期（避免一对多 active screenshot 混淆来源）
                supersededAttachments = await dbAllAsync(
                    `SELECT id, attachment_type, original_name, uploaded_by, uploaded_by_name
                       FROM collab_attachments
                      WHERE collab_request_id = ?
                        AND attachment_type IN ('result_data', 'screenshot')
                        AND status = 'active'`,
                    [id]
                );

                // supersede 同 type 旧 active
                for (const mf of movedFiles) {
                    await dbRunAsync(
                        `UPDATE collab_attachments
                            SET status='superseded', superseded_at=datetime('now','localtime')
                          WHERE collab_request_id=?
                            AND attachment_type=?
                            AND status='active'`,
                        [id, mf.attachment_type]
                    );
                    // INSERT 新 active 行（v1.72.0 写入 attachment_seq）
                    const relPath = path.relative(path.dirname(COLLAB_UPLOAD_BASE), mf.final_path).replace(/\\/g, '/');
                    await dbRunAsync(
                        `INSERT INTO collab_attachments
                            (collab_request_id, attachment_type, file_name, original_name,
                             uploaded_by, uploaded_by_name, submission_version, status, superseded_at,
                             attachment_seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
                        [id, mf.attachment_type, relPath, mf.original_name,
                         userId, userName, newSubmissionVersion, mf.attachment_seq]
                    );
                }

                // UPDATE collab_requests：EXPORTING → DONE（v1.72.10：exporter 上传即终态，不走 SUBMITTED 验收链路）
                //   业务理由：exporter 角色是"导业务数据"，与 developer 写 SQL 不同，导出结果不需要 admin 二次验收
                //   smoke test：submit-export 本身不触发 smoke（仅 submit endpoint 走 smoke），状态机改造不影响验收流程
                //   sql_validation_status='admin_closed'：与 admin-submit-on-behalf 一致语义（"未走 smoke 验证"）
                //   admin 兜底：若 exporter 上传错误，admin 走 admin-submit-on-behalf 走 DONE→DONE 路径替换文件
                // codex 39 M-5 采纳保留：清 sql_validation_error + validation_started_at（不残留 dev submit 旧校验）
                // 双轨守卫：status=EXPORTING + exporter_user_id=userId + archived 双轨
                const updResult = await dbRunAsync(
                    `UPDATE collab_requests
                        SET status = 'DONE',
                            export_summary = ?,
                            submitted_at = COALESCE(submitted_at, datetime('now','localtime')),
                            last_submitted_at = datetime('now','localtime'),
                            done_at = datetime('now','localtime'),
                            sql_validation_status = 'admin_closed',
                            sql_validation_error = NULL,
                            validation_started_at = NULL,
                            attachment_dir = COALESCE(attachment_dir, ?)
                      WHERE id = ?
                        AND status = 'EXPORTING'
                        AND exporter_user_id = ?
                        AND archived_at IS NULL
                        AND archived_final_at IS NULL`,
                    [exportSummary, attachmentDirName, id, userId]
                );

                if (!updResult || updResult.changes === 0) {
                    await dbRunAsync('ROLLBACK');
                    // 已移动的文件挪 _orphaned/{id}_v{ver}_{ts}/ 避免污染正式目录
                    try {
                        await versInternal.moveToOrphaned(
                            movedFiles, id, newSubmissionVersion, COLLAB_UPLOAD_BASE, logger
                        );
                    } catch (_) { /* ignore */ }
                    return res.status(409).json({
                        error: '协作单状态已变更，请刷新后重试',
                        code: 'CONCURRENT_STATE_CHANGE'
                    });
                }

                // INSERT operation_logs SUBMIT_EXPORT（codex 39 H-2 + L-3 采纳：reason JSON 含完整审计信息）
                // codex 50 M-3 采纳：加 flow='exporter_direct_done' 字段区分 exporter 直闭环 vs admin 兑底，
                //   未来 grep 审计/统计可按 flow 字段精确分流（与 admin-submit-on-behalf flow 字段对应）
                await dbRunAsync(
                    `INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason)
                     VALUES (?, 'SUBMIT_EXPORT', ?, ?, ?)`,
                    [id, userId, userName, JSON.stringify({
                        flow: 'exporter_direct_done',
                        exporter_user_id: collab.exporter_user_id,
                        exporter_name: collab.exporter_name,
                        export_summary: exportSummary,
                        has_summary: !!exportSummary,
                        summary_length: exportSummary ? exportSummary.length : 0,
                        // codex 39 H-2 采纳：记录被 supersede 的附件 id/type/original_name + uploaded_by
                        // 用于复盘"谁的交付物被谁覆盖"（含跨人覆盖：dev 提交后 exporter 重交、或 exporter 重传）
                        superseded_attachments: supersededAttachments.map(a => ({
                            id: a.id,
                            attachment_type: a.attachment_type,
                            original_name: a.original_name,
                            uploaded_by: a.uploaded_by,
                            uploaded_by_name: a.uploaded_by_name
                        })),
                        newly_uploaded: movedFiles.map(mf => ({
                            attachment_type: mf.attachment_type,
                            original_name: mf.original_name
                        }))
                    })]
                );

                await dbRunAsync('COMMIT');
            } catch (txErr) {
                try { await dbRunAsync('ROLLBACK'); } catch { /* ignore */ }
                if (movedFiles.length > 0) {
                    try {
                        await versInternal.moveToOrphaned(
                            movedFiles, id, newSubmissionVersion, COLLAB_UPLOAD_BASE, logger
                        );
                    } catch (_) { /* ignore */ }
                }
                logger.error(`[submit-export] 协作单 #${id} DB 事务失败: ${txErr.message}`, txErr);
                return res.status(500).json({ error: '提交失败，请重试', code: 'DB_TRANSACTION_FAILED' });
            }

            // 快照供钉钉副作用使用（commit 后即可读最新状态）
            collabSnapshot = await getCollabWithDbName(id);

            logger.info(`[submit-export] 协作单 #${id} EXPORTING → DONE by ${userName}(exporter id=${userId}) summary_len=${exportSummary ? exportSummary.length : 0} superseded=${supersededAttachments.length} (v1.72.10: skip SUBMITTED for exporter direct closure)`);

            // === 响应（codex 39 L-3 采纳：固定结构供 Commit F 直接消费）===
            res.json({
                success: true,
                current_status: 'DONE',
                export_summary: exportSummary,
                superseded_attachments: supersededAttachments.map(a => ({
                    id: a.id,
                    attachment_type: a.attachment_type,
                    original_name: a.original_name,
                    uploaded_by: a.uploaded_by,
                    uploaded_by_name: a.uploaded_by_name
                }))
            });
        } catch (e) {
            cleanupPending();
            logger.error(`[submit-export] 协作单 #${id} 提交异常: ${e.message}`, e);
            return res.status(500).json({ error: '提交失败，请联系管理员', code: 'SUBMIT_EXPORT_FAILED' });
        } finally {
            if (release) release();
        }

        // === 钉钉副作用（commit 后执行，失败仅记日志不影响业务返回；codex 39 M-3 采纳：dev + admin best-effort）===
        // 注意：response 已经返回给前端，此处异步执行不阻塞前端
        if (!collabSnapshot) return;  // 防御：理论不会发生，已 commit 必有 snapshot
        (async () => {
            try {
                const escape = dingtalkNotify.escapeMarkdown;
                const safeOaNo = escape(collabSnapshot.oa_request_no || '-');
                const safeUserName = escape(userName);
                const rawPreview = exportSummary
                    ? (exportSummary.length > 80 ? exportSummary.slice(0, 80) + '...' : exportSummary)
                    : '（导出人未填写操作概要）';
                const summaryPreview = escape(rawPreview);

                const platformBaseUrl = await readSystemConfig('platform_base_url') || 'http://192.168.1.100:3000';
                const detailUrl = `${platformBaseUrl}/Data_Collab.html?id=${id}`;

                // codex 40 审 S-1 修复：title 也是 markdown 字段，所有动态值用 escape 过的 safeOaNo（沿用 codex 31 审 #7 high 原则）
                // v1.72.10：状态机改 EXPORTING → DONE，文案同步「已提交」→「已完成」
                const title = `[OA-${safeOaNo}] 数据导出人已完成`;
                const markdown = [
                    `### 数据协作单 OA-${safeOaNo}`,
                    '',
                    `- **导出人**:${safeUserName}`,
                    `- **操作概要**:${summaryPreview}`,
                    '',
                    `[👉 查看详情](${detailUrl})`
                ].join('\n');

                // 推 developer（原 dev）
                if (collabSnapshot.developer_id) {
                    const devUser = await dbGetAsync(
                        `SELECT id, display_name, phone, dingtalk_user_id
                           FROM users WHERE id = ? AND status = 'active'`,
                        [collabSnapshot.developer_id]
                    );
                    if (devUser) {
                        const r = await sendCollabDingtalkRaw(id, devUser, title, markdown, { id: userId, name: userName });
                        if (r.ok) {
                            insertCollabLog(id, 'NOTIFY_DEV_EXPORT_SUBMIT', userId, userName, null);
                        } else {
                            logger.warn(`[submit-export-notify] 协作单 #${id} 通知 dev 失败：${r.body && r.body.error}（reason=${r.body && r.body.reason}）`);
                        }
                    } else {
                        logger.info(`[submit-export-notify] 协作单 #${id} 无可通知的 dev（用户不存在或停用）`);
                    }
                }

                // 推 admin（best-effort，复用 POST /submit 的"取最早 active admin"模式）
                // v1.78.1：总开关默认关——导出人提交后不再被动通知 admin（dev 通知不受影响，上方照常发）
                if (!(await isNotifyAdminOnSubmitEnabled())) {
                    logger.info(`[submit-export-notify] 协作单 #${id} admin 通知已被开关关闭（collab_notify_admin_on_submit≠on），跳过（dev 通知不受影响）`);
                } else {
                    const adminUser = await dbGetAsync(
                        `SELECT id, display_name, phone, dingtalk_user_id
                           FROM users
                          WHERE role = 'admin' AND status = 'active' AND phone IS NOT NULL AND phone != ''
                          ORDER BY created_at ASC LIMIT 1`
                    );
                    if (adminUser) {
                        const r = await sendCollabDingtalkRaw(id, adminUser, title, markdown, { id: userId, name: userName });
                        if (r.ok) {
                            insertCollabLog(id, 'NOTIFY_ADMIN_EXPORT_SUBMIT', userId, userName, null);
                        } else {
                            logger.warn(`[submit-export-notify] 协作单 #${id} 通知 admin 失败：${r.body && r.body.error}（reason=${r.body && r.body.reason}）`);
                        }
                    } else {
                        logger.info(`[submit-export-notify] 协作单 #${id} 无可通知的 admin（无手机号或全停用）`);
                    }
                }
            } catch (e) {
                logger.warn(`[submit-export-notify] 协作单 #${id} 钉钉触发异常：${e.message}`);
            }
        })();
    }
);

// 导出人通知业务方 + 发数据（2026-05-29 方案 v1.1；2026-06-09 收件人修复 codex 78）
//   exporter 交付 DONE 后，手动点按钮 → 钉钉发 Excel 文件 + 完成通知 + 跟踪业务方已读
//   三步：① media/upload 拿 media_id ② sampleFile 发文件 ③ sampleMarkdown 发完成通知（先文件后文字）
//   全三步成功才落 done_*；任一步失败返 success:false（codex 52 H-1/M-6：失败不伪装成功，"不阻断"只指不回滚 DONE）
//   收件人 = 业务方负责人（requester_phone 反查钉钉 userid，对齐 Issue 范式；原 contact_person_id 路径
//     在 admin 直派单 =0 必失败，且对接人本就不是数据接收方——生产 #9 触发修复）
//   范围 = DONE + 有效 exporter + 唯一 active result_data（normal forward / admin_direct 都支持，
//     不再限定 assign_mode；纯 developer SQL 路径无 exporter 无 result_data 天然进不来）
app.post('/api/collab/requests/:id/notify-requester-done', authenticateToken, async (req, res) => {
    const idStr = req.params.id;
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const isAdmin = req.user.role === 'admin';

    // === 前置：id 校验 ===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    try {
        // === 取协作单（2026-06-09 收件人修复 codex 78：收件人=业务方负责人 requester_name/requester_phone，
        //     不再是 contact_person——对接人只是内部流转角色，业务方负责人才是数据要发给的人）===
        const collab = await dbGetAsync(
            `SELECT id, status, assign_mode, exporter_user_id, exporter_name,
                    created_by, created_by_name,
                    requester_name, requester_phone, oa_request_no, description,
                    done_notify_message_key, done_notified_at
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在', code: 'NOT_FOUND' });

        // === codex 55 M-1：exporter_user_id 用正整数语义（0 是占位无效值，对齐现有可见性判断 L10371）===
        const exporterId = Number(collab.exporter_user_id);
        const hasValidExporter = Number.isSafeInteger(exporterId) && exporterId > 0;

        // === H-2 权限守卫（可执行条件）：admin / 本单 exporter / 本单创建人（v1.77.0 统一放行）===
        //   v1.77.0：创建人是协作单 owner，对"数据是否送达业务方"负责——两条交付路径（exporter 交付 /
        //   developer 提交）都放行创建人，不按路径切权限
        if (!isAdmin) {
            const isOwnExporter = hasValidExporter && exporterId === userId;
            const isCreator = Number(collab.created_by) === userId;
            if (!isOwnExporter && !isCreator) {
                return res.status(403).json({ error: '仅本单数据导出人、创建人或管理员可通知', code: 'NOT_AUTHORIZED_TO_NOTIFY' });
            }
        }

        // === 范围守卫（v1.77.0 路径分流）：DONE + 唯一 active result_data 才可发（下游 ①M-4 兜底）。
        //   两条交付路径统一支持：
        //   - exporter 交付路径：normal forward / admin_direct 单 submit-export 产生 result_data（v1.76.1 原范围）
        //   - developer 交付路径（v1.77.0 新增）：开发 /submit 同样产生 1 active result_data（classifyUploadedFiles
        //     1rd+1rs），smoke 过 → DONE。⚠️ 修正 v1.76.1 注释错误："纯 developer 路径无 result_data"不成立，
        //     当时真正拦住它的只是下面已删除的 hasValidExporter 409（codex 79 H-1，本版业务驱动放开）
        //   delivery_path 仅用于留痕审计；卡片署名 = 发送人（与路径无关）
        if (collab.status !== 'DONE') {
            return res.status(409).json({ error: `仅 DONE 状态可通知，当前：${collab.status}`, code: 'INVALID_STATE_FOR_NOTIFY' });
        }
        const deliveryPath = hasValidExporter ? 'exporter' : 'developer';

        // === 收件人前置校验（codex 78 H-1 fail-fast）：业务方负责人手机号为空 → 400，不必走附件/钉钉 ===
        const requesterPhone = String(collab.requester_phone || '').trim();
        if (!requesterPhone) {
            return res.status(400).json({ error: '业务方负责人手机号为空，无法发送（请先在协作单补填手机号）', code: 'REQUESTER_PHONE_EMPTY' });
        }

        // === ① M-4：取 result_data active 唯一附件（0/多个明确报错，不随机取）===
        //   codex 84 M-1：status 列是 ALTER 后加可空无 DEFAULT——D1/D2 时代老附件 status=NULL 实为可用，
        //   NULL 兼容与前端渲染（a.status==='active' || !a.status）及 recordQuality 模板查询同源；
        //   唯一性 AMBIGUOUS 守卫兜底混合场景
        const atts = await dbAllAsync(
            `SELECT id, file_name, original_name FROM collab_attachments
              WHERE collab_request_id = ? AND attachment_type = 'result_data'
                AND (status = 'active' OR status IS NULL)`,
            [id]
        );
        if (atts.length === 0) return res.status(409).json({ error: '无有效数据文件', code: 'RESULT_DATA_MISSING' });
        if (atts.length > 1) return res.status(409).json({ error: '存在多个有效数据文件，请联系管理员修复', code: 'RESULT_DATA_AMBIGUOUS' });
        const att = atts[0];

        // === M-2（codex 54）：本需求只发 xlsx，断言扩展名（submit-export 已限定 .xlsx/.xls，此处兜底）===
        const lowerName = String(att.original_name || att.file_name || '').toLowerCase();
        if (!lowerName.endsWith('.xlsx') && !lowerName.endsWith('.xls')) {
            return res.status(409).json({ error: '数据文件不是 .xlsx/.xls，无法作为文件消息发送', code: 'RESULT_DATA_NOT_XLSX' });
        }

        // === ② M-5：拼物理路径 + ensureInsideRoot 校验（root 与 submit-export 落库一致）===
        //   submit-export 落库：file_name = path.relative(path.dirname(COLLAB_UPLOAD_BASE), finalPath)
        //   故 storageRoot = path.dirname(COLLAB_UPLOAD_BASE)，拼接 root 与校验 root 统一
        const versInternal = collabVersioning._internal;
        const storageRoot = path.dirname(COLLAB_UPLOAD_BASE);
        const physicalPath = path.join(storageRoot, att.file_name);
        const rootCheck = versInternal.ensureInsideRoot(physicalPath, storageRoot);
        if (!rootCheck.ok) return res.status(400).json({ error: '附件路径校验失败', code: 'PATH_VIOLATION' });
        if (!fs.existsSync(physicalPath)) return res.status(409).json({ error: '数据文件物理缺失', code: 'RESULT_DATA_FILE_MISSING' });

        // === 取凭证 + token ===
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
        );
        if (!appKey || !appSecret || !robotCode) {
            return res.status(500).json({ error: '钉钉配置未填写', code: 'DINGTALK_NOT_CONFIGURED' });
        }
        let token;
        try {
            token = await dingtalkNotify.getAccessToken(appKey, appSecret);
        } catch (err) {
            const cls = dingtalkNotify.classifyError(err);
            return res.status(502).json({ success: false, error: cls.hint, code: 'DINGTALK_TOKEN_FAILED', reason: cls.reason });
        }

        // === 收件人反查（2026-06-09 codex 78）：requester_phone → 企业钉钉 userid，对齐 Issue 范式 ===
        //   HTTP 分层（codex 78 H-1）：查不到人（业务输入问题）→ 400；token/network/钉钉服务异常 → 502 + reason。
        //   token_expired 不重试（对齐本 endpoint M-6 既有策略，codex 78 M-4）。
        //   codex 79 M-1：502 固定文案 + reason，不拼上游 hint（钉钉 errmsg 可能回显手机号）。
        const resolved = await dingtalkNotify.resolveRequesterDingUserId(token, requesterPhone);
        if (!resolved.ok) {
            if (resolved.reason === 'requester_invalid') {
                return res.status(400).json({ error: '业务方手机号查不到企业钉钉号（非企业成员/未绑定/离职），请线下转达数据', code: 'REQUESTER_INVALID', reason: resolved.reason });
            }
            // requester_phone_empty 已前置判过，到这里只剩服务类异常（token_expired/network/server_5xx/...）
            return res.status(502).json({ success: false, error: '业务方钉钉号查询失败，请稍后重试或联系管理员', code: 'REQUESTER_LOOKUP_FAILED', reason: resolved.reason });
        }
        const requesterDingUserId = resolved.userid;

        const userIds = [requesterDingUserId];
        const sendFileName = att.original_name || path.basename(att.file_name);

        // === H-1 三步：先文件后文字，逐步记结果（M-6：token 过期不自动重试，失败返 partial_failure 用户重点）===
        //   M-2/M-4：成功判断 = errcode OK 且 invalidStaffIdList 空（markdown 额外要 processQueryKey 非空）
        const steps = { media_upload: false, file_send: false, markdown_send: false };
        let mediaId = null, mdResp = null, failedStep = null, errDetail = null;

        // codex 55 L-1：先校验 resp 对象形态，避免非对象响应抛 TypeError 被归为泛网络错误
        const dingtalkSendOk = (resp) =>
            resp && typeof resp === 'object'
            && (!resp.errcode || resp.errcode === 0)
            && (!Array.isArray(resp.invalidStaffIdList) || resp.invalidStaffIdList.length === 0);

        try {
            const buffer = fs.readFileSync(physicalPath);
            // ① upload
            mediaId = await dingtalkNotify.uploadMedia(token, sendFileName, buffer);
            steps.media_upload = true;
            // ② 发文件（M-2：errcode + invalidStaffIdList 双判）
            const fileResp = await dingtalkNotify.sendFileToUser(token, robotCode, userIds, mediaId, sendFileName);
            if (!dingtalkSendOk(fileResp)) {
                throw Object.assign(new Error('sampleFile 发送未成功'), { dingtalkResp: fileResp, step: 'file_send' });
            }
            steps.file_send = true;
            // ③ 发完成通知文字（收尾确认）
            //   v1.77.0：卡片联系人 = 单据发送人（本次操作人），非 exporter_name——业务方有疑问找发数据的人
            const card = dingtalkNotify.buildRequesterDoneCard({
                oaRequestNo: collab.oa_request_no,
                description: collab.description,
                senderName: userName
            });
            mdResp = await dingtalkNotify.sendMarkdownToUser(token, robotCode, userIds, card.title, card.text);
            // M-4：markdown 成功条件加 processQueryKey 非空（否则已读永远查不到 → 视为失败不落 done_*）
            if (!dingtalkSendOk(mdResp) || !mdResp.processQueryKey) {
                throw Object.assign(new Error('markdown 未成功或缺 processQueryKey'), { dingtalkResp: mdResp, step: 'markdown_send' });
            }
            steps.markdown_send = true;
        } catch (e) {
            failedStep = e.step || (!steps.media_upload ? 'media_upload' : !steps.file_send ? 'file_send' : 'markdown_send');
            errDetail = dingtalkNotify.classifyError(e.dingtalkResp || e);
        }

        const allOk = steps.media_upload && steps.file_send && steps.markdown_send;

        // === H-1 全成才落 done_*（M-1 存 markdown 的 processQueryKey）+ 清 done_read_at（重发清）===
        //   codex 55 M-2：三步全发成功但 UPDATE 失败是"已发送但未落库"的反向不一致——
        //   此时钉钉已真发出，绝不能让用户以为失败去重发（会重复发文件）。独立 catch + 专门错误码告知。
        let dbUpdateFailed = false;
        if (allOk) {
            try {
                await dbRunAsync(
                    `UPDATE collab_requests
                        SET done_notified_at = datetime('now','localtime'),
                            done_notify_message_key = ?,
                            done_read_at = NULL
                      WHERE id = ?`,
                    [mdResp.processQueryKey, id]   // markdown_send=true 已保证 processQueryKey 非空
                );
            } catch (dbErr) {
                dbUpdateFailed = true;
                logger.error(`[notify-requester-done] 协作单 #${id} 钉钉已全发成功但 done_* 落库失败: ${dbErr.message}（key=${mdResp.processQueryKey}）`, dbErr);
            }
        }

        // === 留痕（复用 insertCollabLog，rec 4 结构化 detail；失败不阻断 = insertCollabLog fire-and-forget）===
        //   codex 55 M-3：记 previous_done_notify_message_key，重发覆盖时可追溯
        //   2026-06-09 codex 78：收件人改业务方负责人——记反查到的 userid，不落明文手机号（M-2 隐私）
        insertCollabLog(id, 'NOTIFY_REQUESTER_DONE', userId, userName, JSON.stringify({
            all_ok: allOk,
            db_update_failed: dbUpdateFailed,
            failed_step: failedStep,
            steps,
            media_id: mediaId,
            attachment_id: att.id,
            recipient_source: 'requester_phone',
            requester_userid: requesterDingUserId,
            requester_name: collab.requester_name || null,
            assign_mode: collab.assign_mode,
            delivery_path: deliveryPath,   // v1.77.0：按 exporter_user_id>0 推断的交付归类（exporter=导出人交付 / developer=开发提交交付），非精确提交来源（codex 84 L-1）
            markdown_key: allOk ? mdResp.processQueryKey : null,
            previous_done_notify_message_key: collab.done_notify_message_key || null,
            previous_done_notified_at: collab.done_notified_at || null,
            dingtalk_errcode: errDetail ? errDetail.errcode : null,
            dingtalk_errmsg: errDetail ? errDetail.errmsg : null
        }));

        // === M-2：三步全成但落库失败 → 钉钉已发出，告知"已发送但状态未保存，勿重发"===
        if (allOk && dbUpdateFailed) {
            return res.status(200).json({
                success: false,
                code: 'NOTIFY_SENT_BUT_DB_UPDATE_FAILED',
                message: '通知与数据已发送给业务方，但完成状态保存失败，请勿重发，已记录待管理员补录',
                steps
            });
        }

        // === M-6：发送失败如实返 success:false（不伪装成功；DONE 状态不回滚）===
        if (!allOk) {
            logger.warn(`[notify-requester-done] 协作单 #${id} 通知部分失败 failed_step=${failedStep} by ${userName}`);
            return res.status(200).json({
                success: false,
                code: 'NOTIFY_PARTIAL_FAILURE',
                failed_step: failedStep,
                message: '通知/发送未完成，请重试或线下联系业务方',
                steps
            });
        }

        logger.info(`[notify-requester-done] 协作单 #${id} 已通知业务方负责人(requester_userid=${requesterDingUserId}) + 发数据 by ${userName}`);
        return res.json({ success: true, done_notified_at_set: true, steps });
    } catch (e) {
        logger.error(`[notify-requester-done] 协作单 #${idStr} 异常: ${e.message}`, e);
        return res.status(500).json({ success: false, error: '通知失败，请联系管理员', code: 'NOTIFY_REQUESTER_DONE_FAILED' });
    }
});

app.post('/api/collab/requests/:id/bypass', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = req.user.id;
    const userName = req.user.username || req.user.display_name || `user#${userId}`;

    // === 前置校验：id 严格正则 + Number.isSafeInteger 防精度丢失（codex 15 审 #2）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // === 前置校验：bypass_reason 类型 + trim 后长度（codex 14 #4）===
    const rawReason = req.body && req.body.bypass_reason;
    if (typeof rawReason !== 'string') {
        return res.status(400).json({
            error: 'bypass_reason 必须是字符串',
            code: 'INVALID_REASON',
        });
    }
    const reason = rawReason.trim();
    if (reason.length < 10) {
        return res.status(400).json({
            error: '旁路原因必须不少于 10 个字符',
            code: 'BYPASS_REASON_TOO_SHORT',
        });
    }
    if (reason.length > 500) {
        return res.status(400).json({
            error: '旁路原因不能超过 500 个字符',
            code: 'BYPASS_REASON_TOO_LONG',
        });
    }

    try {
        // === 前置 SELECT：协作单存在 + 三重状态守卫（友好错误信息）===
        // v1.70.3 codex 29 审 #1：加 archived_at 字段查询 + 守卫（业务需求 admin 现可在任何状态作废，
        //   理论上 SUBMITTED+作废后再 bypass 流程几乎不会触发，但加守卫防御）
        const collab = await dbGetAsync(
            `SELECT id, status, sql_validation_status, archived_at
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }
        if (collab.archived_at) {
            return res.status(409).json({
                error: '协作单已作废，不允许旁路',
                code: 'SOFT_ARCHIVED_PROTECTED',
            });
        }
        if (collab.status !== 'SUBMITTED' || collab.sql_validation_status !== 'failed') {
            return res.status(409).json({
                error: `当前状态 ${collab.status}/${collab.sql_validation_status || 'NULL'} 不允许旁路（仅 SUBMITTED + failed 可旁路）`,
                code: 'INVALID_STATE',
                current_status: collab.status,
                current_sql_validation_status: collab.sql_validation_status,
            });
        }

        // === 条件 UPDATE：兜底并发（防 SELECT 后 UPDATE 前状态被改）===
        // 方案 §6.5.2 字段集 + codex 14 #6 不写 sql_validated_at
        const result = await dbRunAsync(
            `UPDATE collab_requests SET
                status = 'DONE',
                sql_validation_status = 'bypassed',
                bypass_validation = 1,
                bypass_reason = ?,
                bypass_by = ?,
                bypass_by_name = ?,
                done_at = datetime('now','localtime')
              WHERE id = ?
                AND status = 'SUBMITTED'
                AND sql_validation_status = 'failed'
                AND archived_at IS NULL`,
            [reason, userId, userName, id]
        );

        if (!result || result.changes === 0) {
            // 并发漂移：SELECT 后状态被其他流程改动（如开发重新提交且 smoke test 通过）
            return res.status(409).json({
                error: '协作单状态已变化，请刷新后重试',
                code: 'STATE_CHANGED',
            });
        }

        // === BYPASS 审计日志（best-effort，方案 §6.5.2 + codex 14 #3 决策 B）===
        // 跟 submit/notify endpoint 风格一致；DB 写本地 SQLite + 内网 4-5 用户，
        // 主表 UPDATE 已成功后日志 INSERT 失败概率近乎 0；失败时 logger.error 留痕
        insertCollabLog(id, 'BYPASS', userId, userName, reason);

        return res.json({
            message: '旁路放行成功',
            current_status: 'DONE',
            sql_validation_status: 'bypassed',
        });
    } catch (e) {
        // 顶层兜底：错误信息仅写日志，不返前端（沿用 submit endpoint #5 风格）
        // codex 15 审 #1：500 兜底补 code（4xx 业务分支已带 code，5xx 也带 code 让前端可识别）
        logger.error(`[collab-bypass] 协作单 #${id} 旁路异常: ${e.message}`, e);
        return res.status(500).json({ error: '旁路失败，请联系管理员', code: 'BYPASS_FAILED' });
    }
});

// =============================================================================
// 4b'. admin-fix endpoint（v1.70.0 Step 3，方案 §3-A）
// =============================================================================
//
// 触发场景：v2.0 上线后业务 5/21 OA-364265 暴露的"admin 创建协作单时录错目标库
// → 开发上传 SQL 被 smoke test 拦 → admin 无兜底通道改字段让开发重传"
//
// 设计要点（quality_first A1-A7 grep 真相事实）：
//   - requireAdmin（不是 requireRole(['admin'])，项目实际中间件）
//   - users WHERE status = 'active'（不抽 isActiveUserWhere helper，server.js 0 处 is_active 用法）
//   - v1.70.0 范围剥离 v1.71.0：不含 exporter_id 字段 + EXPORTING 状态（5/22 拍板 γ 砍掉 v1.71.0 推后）
//   - FIELD_STATUS_MATRIX 在 admin-fix + GET allowed-fields 两 endpoint 内分别定义（不抽顶层常量，符合方案 v1.2 + 不引入跨函数依赖）
//
// 字段级状态准入矩阵（v1.70.0 范围）：
//   target_db_connection_id / description / oa_request_no / contact_person_id：PENDING_ASSIGN / PENDING / SUBMITTED 可改
//   developer_id：PENDING / SUBMITTED 可改（PENDING_ASSIGN 还没指派开发，改 developer 走 assign endpoint）
//
// 终态保护：DONE / ARCHIVED / archived_at NOT NULL 全部拒
//
// 业务校验：
//   - oa_request_no 唯一性（排除自身）
//   - target_db_connection_id 在 db_connections 表中 connection_type='source' + type IN sqlserver/mysql
//   - 人员字段 ID > 0 + users 表 status='active'
//
// 审计：insertCollabLog operation_type='ADMIN_FIX' + reason=JSON(changes / old / reason / cleared_sql_error)
app.post('/api/collab/requests/:id/admin-fix', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = req.user.id;
    const userName = req.user.username || req.user.display_name || `user#${userId}`;

    // === 前置校验：id 严格正则 + Number.isSafeInteger（沿用 bypass endpoint 风格）===
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // === 入参解析 ===
    const { changes = {}, reason: rawReason, clear_sql_validation_error: clearFlagRaw } = (req.body || {});

    // codex 26 审 #4：reason 必填 + 类型早校验（防止无 reason 写操作），但长度校验推后到业务校验前
    // 这样字段白名单 / 终态保护 / 状态准入等关键错误优先暴露，不被 REASON_TOO_SHORT 遮蔽
    if (typeof rawReason !== 'string') {
        return res.status(400).json({ error: '修正原因必填且必须是字符串', code: 'REASON_REQUIRED' });
    }
    const reason = rawReason.trim();

    // codex 26 审 #7：clear_sql_validation_error 入参类型校验
    // 只接受 undefined / boolean；其他类型如 'false' 字符串、数字会被拒
    if (clearFlagRaw !== undefined && typeof clearFlagRaw !== 'boolean') {
        return res.status(400).json({
            error: 'clear_sql_validation_error 必须是布尔值（true/false）或省略',
            code: 'FIELD_VALIDATION_FAILED',
        });
    }
    const clear_sql_validation_error = clearFlagRaw !== false; // undefined / true → true；显式 false → false

    if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
        return res.status(400).json({ error: '必须指定至少一个要修改的字段', code: 'NO_CHANGES' });
    }

    // === 字段约束（codex 二审 #7：人员字段 min:1，不允许 0）===
    const FIELD_CONSTRAINTS = {
        'target_db_connection_id': { type: 'integer', min: 1 },
        'description': { type: 'string', maxLength: 2000, trim: true },
        'oa_request_no': { type: 'string', maxLength: 100, trim: true, pattern: /^[A-Za-z0-9-]+$/ },
        'contact_person_id': { type: 'integer', min: 1 },
        'developer_id': { type: 'integer', min: 1 },
        // v1.78.0：截止时间可改（deadline 是 DATETIME NOT NULL，不允许清空）
        'deadline': { type: 'datetime' },
    };
    function validateField(field, value, constraint) {
        if (constraint.type === 'integer') {
            if (!Number.isInteger(value)) return `字段 ${field} 必须是整数`;
            if (constraint.min !== undefined && value < constraint.min) {
                return `字段 ${field} 不能小于 ${constraint.min}（人员字段不可清空）`;
            }
        }
        if (constraint.type === 'datetime') {
            // v1.78.0：deadline 是 DATETIME NOT NULL，必须非空字符串
            if (typeof value !== 'string') return `字段 ${field} 必须是字符串（日期时间）`;
            const v = value.trim();
            if (v.length === 0) return `字段 ${field} 不能为空（截止时间必填）`;
            // 接受 'YYYY-MM-DD HH:mm' 或 'YYYY-MM-DDTHH:mm'，秒可选
            if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(v)) {
                return `字段 ${field} 格式必须是 YYYY-MM-DD HH:mm（或带秒）`;
            }
            // 格式对但日期非法（如 2026-13-45）也要拦：用各分量逐一核对避免时区/兜底解析放行
            const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
            const [Y, Mo, D, H, Mi, S] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
            const dt = new Date(Y, Mo - 1, D, H, Mi, S);
            if (dt.getFullYear() !== Y || dt.getMonth() !== Mo - 1 || dt.getDate() !== D
                || dt.getHours() !== H || dt.getMinutes() !== Mi || dt.getSeconds() !== S) {
                return `字段 ${field} 不是合法的日期时间`;
            }
        }
        if (constraint.type === 'string') {
            if (typeof value !== 'string') return `字段 ${field} 必须是字符串`;
            const v = constraint.trim ? value.trim() : value;
            if (constraint.minLength !== undefined && v.length < constraint.minLength) {
                return `字段 ${field} 长度不能少于 ${constraint.minLength}`;
            }
            if (constraint.maxLength !== undefined && v.length > constraint.maxLength) {
                return `字段 ${field} 长度不能超过 ${constraint.maxLength}`;
            }
            if (constraint.pattern && !constraint.pattern.test(v)) {
                return `字段 ${field} 格式不符合要求`;
            }
        }
        return null;
    }
    // v1.78.0 codex 审 low-2：deadline 归一化为 DB 格式 'YYYY-MM-DD HH:mm:ss'
    // UPDATE 拼接与审计日志 newValues 共用此函数，避免"日志记 T 分隔/无秒、DB 存空格/带秒"的不一致
    function normalizeDeadlineForDb(raw) {
        let dv = String(raw).trim().replace('T', ' ');
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dv)) dv += ':00'; // 补秒
        return dv;
    }

    // === 字段值类型校验 ===
    const validationErrors = [];
    for (const [field, newVal] of Object.entries(changes)) {
        const constraint = FIELD_CONSTRAINTS[field];
        if (constraint) {
            const err = validateField(field, newVal, constraint);
            if (err) validationErrors.push(err);
        }
    }
    if (validationErrors.length > 0) {
        return res.status(400).json({
            error: '字段校验失败',
            detail: validationErrors,
            code: 'FIELD_VALIDATION_FAILED',
        });
    }

    // === 白名单字段校验（拒绝未声明字段，防止改 status / submission_version 等）===
    const ALLOWED_FIELDS = Object.keys(FIELD_CONSTRAINTS);
    const invalidFields = Object.keys(changes).filter(f => !ALLOWED_FIELDS.includes(f));
    if (invalidFields.length > 0) {
        return res.status(400).json({
            error: `字段不可改：${invalidFields.join(', ')}`,
            code: 'FIELD_NOT_ALLOWED',
            allowed_fields: ALLOWED_FIELDS,
        });
    }

    try {
        // === 查协作单 ===
        const collab = await dbGetAsync(`SELECT * FROM collab_requests WHERE id = ?`, [id]);
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }

        // === 终态保护（v1.70.0 Step 1 helper 复用）===
        if (collab.status === 'DONE') {
            return res.status(409).json({ error: 'DONE 状态不允许 admin-fix（终态保护）', code: 'TERMINAL_STATE_PROTECTED' });
        }
        if (collabSubmitHelpers.isFinalArchived(collab)) {
            return res.status(409).json({ error: '已归档协作单严格不允许修改', code: 'ARCHIVED_PROTECTED' });
        }
        if (collabSubmitHelpers.isSoftArchived(collab)) {
            return res.status(409).json({ error: '已作废协作单不允许修改', code: 'SOFT_ARCHIVED_PROTECTED' });
        }

        // === 字段级状态准入矩阵（v1.70.0 范围 — 不含 v1.71.0 的 exporter_id / EXPORTING）===
        const FIELD_STATUS_MATRIX = {
            'target_db_connection_id': ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
            'description':             ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
            'oa_request_no':           ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
            'contact_person_id':       ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
            'developer_id':            ['PENDING', 'SUBMITTED'],
            'deadline':                ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'], // v1.78.0：截止时间，同 description 档（最宽组）
        };
        for (const field of Object.keys(changes)) {
            const allowedStatuses = FIELD_STATUS_MATRIX[field];
            if (!allowedStatuses.includes(collab.status)) {
                return res.status(409).json({
                    error: `字段 ${field} 在状态 ${collab.status} 下不可改（仅 ${allowedStatuses.join('/')} 可改）`,
                    code: 'FIELD_STATUS_NOT_ALLOWED',
                    field,
                    current_status: collab.status,
                    allowed_statuses: allowedStatuses,
                });
            }
        }

        // codex 26 审 #4：reason 长度校验推到这里（字段白名单 / 终态保护 / 状态准入之后，业务校验之前）
        // 让 admin 救火时优先看到"这个字段/状态不能改"的关键错误，不被 reason 长度问题遮蔽
        if (reason.length < 10) {
            return res.status(400).json({ error: '修正原因必须不少于 10 个字符', code: 'REASON_TOO_SHORT' });
        }
        if (reason.length > 500) {
            return res.status(400).json({ error: '修正原因不能超过 500 个字符', code: 'REASON_TOO_LONG' });
        }

        // === 业务层校验（oa_request_no 唯一性 / target_db 存在 / 人员存在且 active）===
        // codex 26 审 #6：userLookup 缓存人员字段查询结果，避免拼 UPDATE 时二次查 users
        const businessErrors = [];
        const oldValues = {};
        const newValues = {};
        const userLookup = {}; // field → { id, display_name }
        for (const [field, newVal] of Object.entries(changes)) {
            oldValues[field] = collab[field];
            // v1.78.0 codex 审 low-2：审计日志 newValues 记实际落库值（deadline 归一化后），与 DB 一致
            newValues[field] = (field === 'deadline') ? normalizeDeadlineForDb(newVal) : newVal;

            if (field === 'oa_request_no') {
                const exists = await dbGetAsync(
                    `SELECT id FROM collab_requests WHERE oa_request_no = ? AND id <> ?`,
                    [newVal, id]
                );
                if (exists) businessErrors.push(`OA 号 ${newVal} 已存在（协作单 #${exists.id}）`);
            }
            if (field === 'target_db_connection_id') {
                const conn = await dbGetAsync(
                    `SELECT id, type FROM db_connections WHERE id = ? AND connection_type='source' AND type IN ('sqlserver','mysql')`,
                    [newVal]
                );
                if (!conn) businessErrors.push(`目标库 ID ${newVal} 不存在或不可用`);
            }
            if (field === 'contact_person_id' || field === 'developer_id') {
                const user = await dbGetAsync(
                    `SELECT id, display_name FROM users WHERE id = ? AND status = 'active'`,
                    [newVal]
                );
                if (!user) businessErrors.push(`用户 ID ${newVal} 不存在或已停用（字段 ${field}）`);
                else userLookup[field] = user;
            }
        }
        if (businessErrors.length > 0) {
            return res.status(400).json({
                error: '字段业务校验失败',
                detail: businessErrors,
                code: 'BUSINESS_VALIDATION_FAILED',
            });
        }

        // === 拼接 UPDATE 语句（联动 *_name 字段同步刷新，codex 26 审 #6 复用 userLookup）===
        const setClauses = [];
        const setParams = [];
        for (const [field, newVal] of Object.entries(changes)) {
            setClauses.push(`${field} = ?`);
            // v1.78.0：deadline 归一化为 DB 格式（codex 审 low-2 抽 normalizeDeadlineForDb，与审计日志同源）
            setParams.push(field === 'deadline' ? normalizeDeadlineForDb(newVal) : newVal);

            if (field === 'contact_person_id') {
                setClauses.push(`contact_person_name = ?`);
                setParams.push(userLookup[field] ? userLookup[field].display_name : null);
            }
            if (field === 'developer_id') {
                setClauses.push(`developer_name = ?`);
                setParams.push(userLookup[field] ? userLookup[field].display_name : null);
            }
        }

        // codex 26 审 #1：清空 sql_validation_error / sql_validation_status（基于两个字段任一存在）
        // 旧逻辑只看 sql_validation_error → 若历史数据 sql_validation_status='failed' 但 error 为空（或只需清状态的场景），
        // admin-fix 返成功但 status 仍卡 → 开发不能重传
        const clearedSqlValidation = clear_sql_validation_error
            && (collab.sql_validation_error != null || collab.sql_validation_status != null);
        if (clearedSqlValidation) {
            setClauses.push(`sql_validation_error = NULL`);
            setClauses.push(`sql_validation_status = NULL`);
        }

        // codex 26 审 #3：UPDATE WHERE 加状态守卫，防 SELECT 后协作单被改成 DONE / ARCHIVED 的并发竞态
        // 复用 v1.69.0 钉钉建群 endpoint 已建立的"条件 UPDATE + result.changes 检查"模式
        setParams.push(id, collab.status);
        const result = await dbRunAsync(
            `UPDATE collab_requests SET ${setClauses.join(', ')}
              WHERE id = ?
                AND status = ?
                AND archived_at IS NULL
                AND archived_final_at IS NULL`,
            setParams
        );
        if (!result || result.changes === 0) {
            return res.status(409).json({ error: '协作单状态已变化或不存在，请刷新后重试', code: 'STATE_CHANGED' });
        }

        // === 审计日志（reason 字段存 JSON 含 changes / old / reason / cleared_sql_validation）===
        insertCollabLog(id, 'ADMIN_FIX', userId, userName, JSON.stringify({
            changes: newValues,
            old_values: oldValues,
            reason,
            cleared_sql_validation: clearedSqlValidation,
        }));

        const updated = await dbGetAsync(`SELECT * FROM collab_requests WHERE id = ?`, [id]);
        return res.json({
            success: true,
            message: 'admin-fix 修正成功',
            collab: updated,
            changed_fields: Object.keys(changes),
            cleared_sql_validation: clearedSqlValidation,
        });
    } catch (e) {
        logger.error(`[collab-admin-fix] 协作单 #${id} admin-fix 异常: ${e.message}`, e);
        return res.status(500).json({ error: 'admin-fix 失败，请联系管理员', code: 'ADMIN_FIX_FAILED' });
    }
});

// =============================================================================
// 4b''. GET admin-fix/allowed-fields（v1.70.0 Step 3，给前端查"当前状态可改字段"）
// =============================================================================
// 前端 adminFixModal 渲染时按 status 查询，灰显不可改字段
app.get('/api/collab/admin-fix/allowed-fields', authenticateToken, requireAdmin, (req, res) => {
    const status = String(req.query.status || '');
    // 与 admin-fix endpoint 内 FIELD_STATUS_MATRIX 完全一致（v1.70.0 范围 + v1.78.0 deadline）
    const FIELD_STATUS_MATRIX = {
        'target_db_connection_id': ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
        'description':             ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
        'oa_request_no':           ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
        'contact_person_id':       ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'],
        'developer_id':            ['PENDING', 'SUBMITTED'],
        'deadline':                ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED'], // v1.78.0：截止时间，同 description 档（最宽组）
    };
    const allowedFields = Object.entries(FIELD_STATUS_MATRIX)
        .filter(([_, statuses]) => statuses.includes(status))
        .map(([field, _]) => field);
    return res.json({ status, allowed_fields: allowedFields });
});

// 4c. 协作摩擦归因记录（admin，方案 §6.6 + D3 模块 7）
//   - 状态守卫：仅 DONE 状态可记录
//   - friction_cause_category 三枚举之一；friction_note 必填 trim 后非空 ≤ 1000 字符
//   - 覆盖式存最近一次（admin 多次提交直接覆盖,不报"已有记录"错误）
//   - 写 FRICTION_RECORD 日志,reason 字段记录新旧值摘要供未来归因审计
//   - 并发保护：条件 UPDATE WHERE status='DONE',changes=0 返 409
app.post('/api/collab/requests/:id/friction-record', authenticateToken, requireAdmin, async (req, res) => {
    const idStr = req.params.id;
    const userId = req.user.id;
    const userName = req.user.username || req.user.display_name || `user#${userId}`;

    // id 严格正则 + Number.isSafeInteger（沿用 bypass endpoint 风格）
    if (!/^[1-9]\d*$/.test(idStr)) {
        return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    }
    const id = parseInt(idStr, 10);
    if (!Number.isSafeInteger(id)) {
        return res.status(400).json({ error: 'id 超出安全整数范围', code: 'INVALID_ID' });
    }

    // 参数校验：friction_cause_category + friction_note
    const VALID_CATEGORIES = ['requirement_unclear', 'tech_misunderstanding', 'other'];
    const rawCategory = req.body && req.body.friction_cause_category;
    if (typeof rawCategory !== 'string' || !VALID_CATEGORIES.includes(rawCategory)) {
        return res.status(400).json({
            error: 'friction_cause_category 必须是 requirement_unclear / tech_misunderstanding / other 之一',
            code: 'INVALID_CATEGORY',
        });
    }
    const rawNote = req.body && req.body.friction_note;
    if (typeof rawNote !== 'string') {
        return res.status(400).json({ error: 'friction_note 必须是字符串', code: 'INVALID_NOTE' });
    }
    const note = rawNote.trim();
    if (note.length < 1) {
        return res.status(400).json({ error: 'friction_note 必填', code: 'FRICTION_NOTE_REQUIRED' });
    }
    if (note.length > 1000) {
        return res.status(400).json({ error: 'friction_note 不能超过 1000 个字符', code: 'FRICTION_NOTE_TOO_LONG' });
    }

    try {
        // 前置 SELECT：状态守卫 + 取旧值供日志摘要
        // v1.70.3 codex 29 审 #1：加 archived_at 字段查询 + 守卫（DONE 后作废仍允许 admin-fix 之外其他操作是隐性 BUG）
        const collab = await dbGetAsync(
            `SELECT id, status, friction_cause_category, friction_note, archived_at FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }
        if (collab.archived_at) {
            return res.status(409).json({
                error: '协作单已作废，不允许记录协作摩擦',
                code: 'SOFT_ARCHIVED_PROTECTED',
            });
        }
        // v1.70.4 codex 30 审 #3：状态门禁同步前端 renderFrictionSection 放开
        //   原仅 DONE 可记录 → 改为所有未归档状态可记录（admin 可在协作过程中即时记录摩擦）
        //   前端 renderFrictionSection 已放开：admin 在 archived_at IS NULL && status !== 'ARCHIVED' 时可填
        //   前后端语义对齐：admin 拉群后或沟通过程中即可填，无需等到 DONE 才"事后复盘"
        if (collab.status === 'ARCHIVED') {
            return res.status(409).json({
                error: '已归档协作单不允许记录协作摩擦',
                code: 'ARCHIVED_PROTECTED',
                current_status: collab.status,
            });
        }

        // 条件 UPDATE 兜底并发（防 SELECT 后被并发作废/归档；不卡 status 让所有非终态都通过）
        const result = await dbRunAsync(
            `UPDATE collab_requests SET
                friction_occurred = 1,
                friction_recorded_at = datetime('now','localtime'),
                friction_cause_category = ?,
                friction_note = ?
              WHERE id = ? AND status <> 'ARCHIVED' AND archived_at IS NULL`,
            [rawCategory, note, id]
        );
        if (!result || result.changes === 0) {
            return res.status(409).json({
                error: '协作单状态已变化，请刷新后重试',
                code: 'STATE_CHANGED',
            });
        }

        // 新旧值摘要日志（方案 §6.6：旧[cat|note前30] → 新[cat|note前30]）
        const oldCat = collab.friction_cause_category || '空';
        const oldNote = (collab.friction_note || '').slice(0, 30);
        const newNote = note.slice(0, 30);
        const summary = `旧[${oldCat}|${oldNote}] → 新[${rawCategory}|${newNote}]`;
        insertCollabLog(id, 'FRICTION_RECORD', userId, userName, summary);

        return res.json({
            message: '协作摩擦记录已保存',
            friction_cause_category: rawCategory,
            friction_note: note,
        });
    } catch (e) {
        logger.error(`[collab-friction] 协作单 #${id} 摩擦记录异常: ${e.message}`, e);
        return res.status(500).json({ error: '记录失败，请联系管理员', code: 'FRICTION_FAILED' });
    }
});

// =============================================================================
// 4c. POST /api/collab/requests/:id/admin-submit-on-behalf（v1.70.4 ③，行政闭环；v1.72.10 扩展 DONE→DONE）
// =============================================================================
// 语义：admin 把协作单强制推进到 DONE，不走 smoke test、不要求传附件。
//   - SUBMITTED → DONE（v1.70.4 原语义）：admin 替 developer 画句号
//   - DONE → DONE（v1.72.10 扩展）：admin 修正已 exporter 闭环单的交付物文件（替换 result_data）
// 触发场景：
//   1) D1→D2 链路（v1.70.4 原场景）：admin 录错关键字段 → 开发上传 smoke 失败 → admin-fix
//      修字段后，开发已完成本职工作，admin 走本 endpoint 单方面闭环。
//   2) EXPORTING 直 DONE 链路（v1.72.10 新场景）：exporter（含 viewer 客服）上传后直接 DONE，
//      如果发现 exporter 上传的文件错了（错单/错列/错版本），admin 走本 endpoint 重传 result_data
//      替换交付物（旧 active superseded + 新 active INSERT），保持 DONE 终态。
//
// 业务规则：
//   - 只 admin 可调
//   - 状态机：SUBMITTED → DONE 或 DONE → DONE（v1.72.10 扩展；PENDING 还没提交不该跳过；ARCHIVED 已严格归档）
//   - sql_validation_status='admin_closed'（新值，区别于 passed/failed/bypassed，表示"行政闭环未验证"）
//   - sql_validation_error 强制清空（避免详情页继续展示旧错误污染语义）
//   - done_at 取值（v1.70.4 codex 30 审 #2：合并到 UPDATE 子查询消除 SELECT/UPDATE 间附件集合变化竞态）：
//       1. 优先取 collab_attachments 中 status='active' 的最新 created_at（dev 最后一次有效提交时间）
//       2. 若无 active 附件，取 collab_requests.deadline（要求完成时间）
//       3. 若 deadline 也异常（不应该，schema NOT NULL），最后兜底 datetime('now','localtime')
//   - reason ≥10 字 ≤500 字（与 admin-fix / bypass / archive 一致）
//   - 不发钉钉（只写日志，与 bypass 同节奏）
//   - 不动 failed 历史附件、friction_*、submission_version（保留审计证据）
//   - 不动 sql_validated_at（保留首次成功验收时间；若从未有过则也为 NULL）
//
// 与 bypass 的区别：
//   - bypass 是 admin 主动覆盖 smoke test 失败结论（"我手工验过，放行"），sql_validation_status='bypassed'
//   - admin-submit-on-behalf 是 admin 替开发画句号（"开发没责任，但需要 admin 错误造成的协作单闭环"），不假装做过验证
//   - 两个 endpoint 独立：bypass 一般 SUBMITTED+failed 时用；admin-submit 是 SUBMITTED+任意 sql 状态都能用（即便 queued/passed 也可——业务上 admin 想强制行政闭环就允许）
//
// v1.70.4 codex 30 审 #1 声明：sql_validation_status 当前无 schema CHECK 约束 / 无应用层白名单
// （已 grep 全 server.js 0 命中 + 9 smoke 烟雾测试证实 admin_closed UPDATE 成功）。
// 未来若引入白名单需同步加入 admin_closed 枚举值；建表 SQL 若加 CHECK 需含 admin_closed。
app.post('/api/collab/requests/:id/admin-submit-on-behalf',
    authenticateToken,
    requireAdmin,
    // v1.70.5 新增：admin 可选上传 result_script(.sql) + result_data(.xlsx/.xls)
    //   - multer.fields 接两个独立字段名，每个最多 1 个，全部可选
    //   - 不做内容校验（业务方明确"不做校验"），multer 已做扩展名/大小白名单
    //   - 上传错误统一 JSON 转义（sync 与 v1.70.0 submit endpoint 风格一致）
    (req, res, next) => {
        const handler = collabUpload.fields([
            { name: 'result_script', maxCount: 1 },
            { name: 'result_data', maxCount: 1 }
        ]);
        handler(req, res, (err) => {
            if (!err) return next();
            const isMulterErr = err && err.name === 'MulterError';
            const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
            // 清理已落盘的部分文件
            try {
                const allFiles = [];
                if (req.files) {
                    Object.values(req.files).forEach(arr => { if (Array.isArray(arr)) allFiles.push(...arr); });
                }
                collabSubmitHelpers.cleanupPendingFiles(allFiles, logger);
            } catch (_) { /* ignore */ }
            logger.warn(`[collab-admin-submit] multer error: code=${code} msg=${err.message}`);
            return res.status(400).json({
                error: '附件上传失败',
                code,
                detail: isMulterErr ? err.message : err.message,
            });
        });
    },
    async (req, res) => {
        const id = parseInt(req.params.id, 10);

        // 收尾 helper：清理本次 multer 已落盘但未入库的文件
        const cleanupPending = () => {
            try {
                const allFiles = [];
                if (req.files) {
                    Object.values(req.files).forEach(arr => { if (Array.isArray(arr)) allFiles.push(...arr); });
                }
                collabSubmitHelpers.cleanupPendingFiles(allFiles, logger);
            } catch (_) { /* ignore */ }
        };

        if (!Number.isSafeInteger(id) || id <= 0) {
            cleanupPending();
            return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
        }

        const reason = String(req.body.reason || '').trim();
        if (reason.length < 10) {
            cleanupPending();
            return res.status(400).json({ error: '行政闭环原因必须不少于 10 个字符', code: 'REASON_TOO_SHORT' });
        }
        if (reason.length > 500) {
            cleanupPending();
            return res.status(400).json({ error: '行政闭环原因不能超过 500 个字符', code: 'REASON_TOO_LONG' });
        }

        const userId = req.user.id;
        const userName = req.user.display_name || req.user.username;

        // v1.70.5 收集本次 admin 上传的可选附件（0/1/2 个）
        const adminUploadedFiles = [];
        if (req.files) {
            if (req.files.result_script && req.files.result_script.length > 0) {
                adminUploadedFiles.push({ attachment_type: 'result_script', file: req.files.result_script[0] });
            }
            if (req.files.result_data && req.files.result_data.length > 0) {
                adminUploadedFiles.push({ attachment_type: 'result_data', file: req.files.result_data[0] });
            }
        }
        const hasAdminUpload = adminUploadedFiles.length > 0;

        try {
            const collab = await dbGetAsync(
                `SELECT id, status, deadline, description, attachment_dir, submission_version,
                        archived_at, archived_final_at, sql_validation_status,
                        oa_request_no, created_at
                   FROM collab_requests WHERE id = ?`,
                [id]
            );
            if (!collab) {
                cleanupPending();
                return res.status(404).json({ error: '协作单不存在' });
            }

            if (collab.archived_at) {
                cleanupPending();
                return res.status(409).json({ error: '已作废协作单不允许行政闭环', code: 'SOFT_ARCHIVED_PROTECTED' });
            }
            if (collab.status === 'ARCHIVED' || collab.archived_final_at) {
                cleanupPending();
                return res.status(409).json({ error: '已归档协作单不允许行政闭环', code: 'ARCHIVED_PROTECTED' });
            }
            // v1.72.10：扩展支持 DONE→DONE（admin 修正已 exporter 闭环单的交付物）
            if (!['SUBMITTED', 'DONE'].includes(collab.status)) {
                cleanupPending();
                return res.status(409).json({
                    error: `当前状态 ${collab.status} 不允许行政闭环（仅 SUBMITTED / DONE 可走）`,
                    code: 'STATE_NOT_ALLOWED_FOR_ADMIN_SUBMIT',
                    current_status: collab.status,
                });
            }
            // codex 50 H-2 采纳：DONE→DONE 强制 hasAdminUpload（D3 语义"admin 替换 result_data 文件"
            //   要求实际上传新文件；无附件的 no-op 调用没业务意义且产生无用日志 + 改写 done_at）
            //   SUBMITTED→DONE 保留原 v1.70.4 灵活性（可不上传，admin 替开发画句号）
            if (collab.status === 'DONE' && !hasAdminUpload) {
                cleanupPending();
                return res.status(400).json({
                    error: 'DONE 状态行政修正必须上传 result_data 替换交付物',
                    code: 'MISSING_ATTACHMENT_FOR_DONE_FIX',
                });
            }

            // v1.70.5 admin 附件移动到正式目录（复用 D3 模块 2 路径校验逻辑，但不调 activateNewVersion）
            //   理由：activateNewVersion 强制完整快照（result_data + result_script 各 1）+ 跑 smoke test，
            //   行政闭环要求"可选上传 + 不做校验"，两条都不匹配 → 精简版本地实现
            //   复用 collabVersioning._internal 的 ensureInsideRoot + computeAttachmentDirName + moveToOrphaned
            //   流程：①路径校验 ②决定目标目录 ③rename 到正式目录 ④事务内 INSERT 新 active + UPDATE 旧 active 同 type → superseded
            const versInternal = collabVersioning._internal;
            const VERSIONED_TYPES = collabVersioning.VERSIONED_DELIVERY_ATTACHMENT_TYPES;
            let movedAdminFiles = [];  // [{ attachment_type, final_path, original_name }]
            let attachmentDirName = collab.attachment_dir;

            if (hasAdminUpload) {
                // ①路径校验：每个 multer 文件必须在 _pending/{id}/ 下
                const pendingRoot = path.join(COLLAB_UPLOAD_BASE, '_pending', String(id));
                for (const item of adminUploadedFiles) {
                    const check = versInternal.ensureInsideRoot(item.file.path, pendingRoot);
                    if (!check.ok) {
                        cleanupPending();
                        logger.warn(`[collab-admin-submit] 路径越界: ${check.error}`);
                        return res.status(400).json({ error: '附件路径校验失败', code: 'PATH_VIOLATION' });
                    }
                }

                // ②决定目标目录（首次激活才需算）
                if (!attachmentDirName) {
                    attachmentDirName = versInternal.computeAttachmentDirName(id, collab.description);
                }
                const targetDir = path.join(COLLAB_UPLOAD_BASE, attachmentDirName);
                const targetCheck = versInternal.ensureInsideRoot(targetDir, COLLAB_UPLOAD_BASE);
                if (!targetCheck.ok) {
                    cleanupPending();
                    return res.status(400).json({ error: '目标目录越界', code: 'PATH_VIOLATION' });
                }
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }

                // ③rename 文件到正式目录（v1.72.0 新规则文件名，rd/rs 用 submission_version 作 seq）
                //   admin-fix 不递增 submission_version → rd/rs 复用 collab.submission_version（默认 0 → 1）
                const adminSeq = collab.submission_version || 1;
                try {
                    for (const item of adminUploadedFiles) {
                        const ext = path.extname(item.file.originalname || '');
                        const finalName = collabVersioning.buildFinalAttachmentName({
                            oaRequestNo: collab.oa_request_no,
                            createdAt: collab.created_at,
                            seq: adminSeq,
                            attachmentType: item.attachment_type,
                            isFailed: false,
                            displayName: userName,
                            username: userName,
                            ext,
                        });
                        const finalPath = path.join(targetDir, finalName);
                        fs.renameSync(item.file.path, finalPath);
                        movedAdminFiles.push({
                            attachment_type: item.attachment_type,
                            final_path: finalPath,
                            original_name: item.file.originalname,
                            attachment_seq: adminSeq,
                        });
                    }
                } catch (renameErr) {
                    logger.error(`[collab-admin-submit] 文件移动失败: ${renameErr.message}`);
                    // 已 rename 的挪 _orphaned；未 rename 的 cleanupPending 清掉
                    try {
                        await versInternal.moveToOrphaned(
                            movedAdminFiles.map(f => ({ final_path: f.final_path })),
                            id, (collab.submission_version || 0), COLLAB_UPLOAD_BASE, logger
                        );
                    } catch (_) { /* ignore */ }
                    cleanupPending();
                    return res.status(500).json({ error: '附件文件移动失败', code: 'FILE_MOVE_FAILED' });
                }
            }

            // 单事务：INSERT 新 admin active 行（如有）+ UPDATE 旧 active 同 type → superseded + UPDATE collab_requests
            //   submission_version 不变（admin 行政闭环不算正常 dev 提交，不递增版本号）
            //   旧 active 同 attachment_type（result_data / result_script）→ superseded（选 1 覆盖语义）
            //   codex 47 M-1：与 adminSeq 统一用 `|| 1`，首次 admin 上传时 NULL/0 → 1 → 文件名 seq 与 DB 一致
            const newSubmissionVersion = collab.submission_version || 1;

            try {
                await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

                // ④ INSERT 新 admin active 行 + supersede 同 type 旧 active
                for (const mf of movedAdminFiles) {
                    // INSERT 前先 supersede 该 type 的所有旧 active 行（避免一对多 active）
                    await dbRunAsync(
                        `UPDATE collab_attachments
                            SET status='superseded', superseded_at=datetime('now','localtime')
                          WHERE collab_request_id=?
                            AND attachment_type=?
                            AND status='active'`,
                        [id, mf.attachment_type]
                    );
                    // INSERT 新 admin active 行（v1.72.0 写入 attachment_seq）
                    // file_name 路径计算与 versioning §3.6 完全一致：relative(dirname(collabRoot), final_path) replace \ → /
                    const relPath = path.relative(path.dirname(COLLAB_UPLOAD_BASE), mf.final_path).replace(/\\/g, '/');
                    await dbRunAsync(
                        `INSERT INTO collab_attachments
                            (collab_request_id, attachment_type, file_name, original_name,
                             uploaded_by, uploaded_by_name, submission_version, status, superseded_at,
                             attachment_seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
                        [id, mf.attachment_type, relPath, mf.original_name,
                         userId, userName, newSubmissionVersion, mf.attachment_seq]
                    );
                }

                // ⑤ 并发守卫 + done_at COALESCE 子查询（v1.70.4 codex 30 审 #2）
                //   注意：因前面 INSERT 了 admin 自己的 active 附件，子查询会包含 admin 这一行
                //         done_at 取的是"截至本次行政闭环时间点 admin 与 dev 累计的最新 active"
                //         这正是预期：admin 补传后 done_at 取 admin 上传时间（如有），否则 dev 旧 active 时间，否则 deadline，否则 now
                // v1.72.10：扩展 WHERE status IN ('SUBMITTED','DONE') 支持 admin 修正已 exporter 闭环单
                //
                // codex 50 H-1 采纳（sql_validation_status 分流防降级）：
                //   - SUBMITTED→DONE 路径：原 v1.70.4 行为不变，写 'admin_closed'（admin 替开发画句号未走 smoke）
                //   - DONE→DONE 路径：保留原 sql_validation_status（passed/admin_closed/bypassed 等）
                //     避免把原 smoke passed 的 DONE 单降级为 admin_closed
                //
                // codex 50 M-1 采纳（done_at 保留不重写）：
                //   - SUBMITTED→DONE 路径：done_at 走原 COALESCE 子查询（首次完成需要写时间）
                //   - DONE→DONE 路径：COALESCE(done_at, ...) 已有 done_at 保留，不被新上传附件 max(created_at) 改写
                //     业务上 admin 兜底修文件不应改写"首次完成时间"
                const isDoneFix = (collab.status === 'DONE');
                const updResult = await dbRunAsync(
                    `UPDATE collab_requests
                        SET status = 'DONE',
                            done_at = ${isDoneFix
                                ? `COALESCE(done_at, datetime('now','localtime'))`
                                : `COALESCE(
                                    (SELECT MAX(created_at) FROM collab_attachments
                                      WHERE collab_request_id = collab_requests.id
                                        AND status = 'active'
                                        AND attachment_type IN ('result_data','result_script')),
                                    deadline,
                                    datetime('now','localtime')
                                )`},
                            sql_validation_status = ${isDoneFix
                                ? `sql_validation_status`
                                : `'admin_closed'`},
                            sql_validation_error = NULL,
                            attachment_dir = COALESCE(attachment_dir, ?)
                      WHERE id = ?
                        AND status IN ('SUBMITTED', 'DONE')
                        AND archived_at IS NULL
                        AND archived_final_at IS NULL`,
                    [hasAdminUpload ? attachmentDirName : null, id]
                );

                if (!updResult || updResult.changes === 0) {
                    await dbRunAsync('ROLLBACK');
                    // 已移动的 admin 文件挪 _orphaned/{id}_v{ver}_{ts}/（CONCURRENT_SUBMIT 同等待遇）
                    if (movedAdminFiles.length > 0) {
                        try {
                            await versInternal.moveToOrphaned(
                                movedAdminFiles, id, newSubmissionVersion, COLLAB_UPLOAD_BASE, logger
                            );
                        } catch (_) { /* ignore */ }
                    }
                    return res.status(409).json({
                        error: '协作单状态已变化或不存在，请刷新后重试',
                        code: 'STATE_CHANGED'
                    });
                }

                await dbRunAsync('COMMIT');
            } catch (txErr) {
                try { await dbRunAsync('ROLLBACK'); } catch (_) { /* ignore */ }
                // 物理文件挪 _orphaned 避免污染正式目录
                if (movedAdminFiles.length > 0) {
                    try {
                        await versInternal.moveToOrphaned(
                            movedAdminFiles, id, newSubmissionVersion, COLLAB_UPLOAD_BASE, logger
                        );
                    } catch (_) { /* ignore */ }
                }
                throw txErr;
            }

            // UPDATE 后回查实际写入的 done_at 与推断来源
            const updated = await dbGetAsync(`SELECT * FROM collab_requests WHERE id = ?`, [id]);
            let doneAtSource = 'now';
            const finalDoneAt = updated && updated.done_at;
            if (finalDoneAt) {
                const lastActive = await dbGetAsync(
                    `SELECT MAX(created_at) AS last_at FROM collab_attachments
                      WHERE collab_request_id = ?
                        AND status = 'active'
                        AND attachment_type IN ('result_data','result_script')`,
                    [id]
                );
                if (lastActive && lastActive.last_at === finalDoneAt) {
                    // 区分 admin 上传 vs dev 上传作为来源（仅用作日志/前端展示语义）
                    doneAtSource = hasAdminUpload ? 'admin_supplemental_attachment' : 'dev_last_active_attachment';
                } else if (collab.deadline === finalDoneAt) {
                    doneAtSource = 'deadline';
                }
            }

            // 审计日志（reason JSON 含 source 推断依据 + admin 上传文件清单）
            // codex 50 M-3 采纳：加 flow 字段区分流程来源（SUBMITTED→DONE = 'submitted_to_done_admin_closure' /
            //   DONE→DONE = 'done_to_done_admin_fix'），未来 grep 审计/统计可按 flow 字段精确分流，
            //   不依赖 sql_validation_status + ADMIN_SUBMIT_ON_BEHALF 双条件推断
            insertCollabLog(id, 'ADMIN_SUBMIT_ON_BEHALF', userId, userName, JSON.stringify({
                reason,
                flow: collab.status === 'DONE' ? 'done_to_done_admin_fix' : 'submitted_to_done_admin_closure',
                done_at_source: doneAtSource,
                done_at_value: finalDoneAt,
                old_sql_validation_status: collab.sql_validation_status || null,
                admin_uploaded: movedAdminFiles.map(mf => ({
                    type: mf.attachment_type,
                    original_name: mf.original_name,
                })),
            }));

            return res.json({
                success: true,
                message: '行政闭环成功',
                collab: updated,
                done_at_source: doneAtSource,
                admin_uploaded_count: movedAdminFiles.length,
            });
        } catch (e) {
            // 异常 cleanup：未移动的 _pending 文件清掉；已移动的（movedAdminFiles）走 moveToOrphaned 隔离
            cleanupPending();
            logger.error(`[collab-admin-submit] 协作单 #${id} 行政闭环异常: ${e.message}`, e);
            return res.status(500).json({ error: '行政闭环失败，请联系管理员', code: 'ADMIN_SUBMIT_FAILED' });
        }
    }
);

// 5. 删除协作单（publisher+，级联 + 清理附件目录）
app.delete('/api/collab/requests/:id', authenticateToken, requirePublisherOrAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const existing = await dbGetAsync('SELECT id, description FROM collab_requests WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: '协作单不存在' });

        // 级联删除（FOREIGN KEY ON DELETE CASCADE 已配置，但需要 PRAGMA foreign_keys=ON）
        // 这里显式删子表确保兼容性
        await dbRunAsync('DELETE FROM collab_dev_plan_items WHERE collab_request_id = ?', [id]);
        await dbRunAsync('DELETE FROM collab_attachments WHERE collab_request_id = ?', [id]);
        await dbRunAsync('DELETE FROM collab_operation_logs WHERE collab_request_id = ?', [id]);
        const result = await dbRunAsync('DELETE FROM collab_requests WHERE id = ?', [id]);

        if (result.changes === 0) return res.status(404).json({ error: '协作单不存在' });

        // 清理附件目录（uploads/collab/{id}_*/）
        try {
            const attDir = getCollabAttachmentDir(id, existing.description);
            if (fs.existsSync(attDir)) {
                fs.rmSync(attDir, { recursive: true, force: true });
                logger.info(`协作单 #${id} 附件目录已清理: ${attDir}`);
            }
        } catch (e) {
            logger.error(`清理协作单 #${id} 附件目录失败:`, e.message);
        }

        logger.info(`用户 ${req.user.username} 删除协作单 #${id}`);
        res.json({ message: '协作单已删除' });
    } catch (err) {
        logger.error('删除协作单失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. 列附件（登录可查）
app.get('/api/collab/requests/:id/attachments', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const exists = await dbGetAsync('SELECT id FROM collab_requests WHERE id = ?', [id]);
        if (!exists) return res.status(404).json({ error: '协作单不存在' });

        const list = await dbAllAsync(
            'SELECT * FROM collab_attachments WHERE collab_request_id = ? ORDER BY created_at DESC',
            [id]
        );
        res.json(list || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. 上传附件（按 attachment_type 分权限）
//    screenshot / example_xlsx / pdf：admin+publisher
//    result_data / result_script：本单 developer 或 admin+publisher
//    支持单次上传多个文件（multer field 名 'files'，最多 5 个）
app.post('/api/collab/requests/:id/attachments',
    authenticateToken,
    requireNonViewer,
    collabUpload.array('files', 5),
    async (req, res) => {
        const { id } = req.params;
        const { attachment_type } = req.body;
        const userId = req.user.id;
        const userName = req.user.display_name || req.user.username;
        const isPrivileged = ['admin', 'publisher'].includes(req.user.role);

        // 收尾函数：失败时清理已经落盘但未入库的临时文件
        const cleanupTempFiles = () => {
            (req.files || []).forEach(f => {
                try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e) { /* ignore */ }
            });
            // 尝试清理空的 _pending 子目录
            try {
                const pendingDir = path.join(COLLAB_UPLOAD_BASE, '_pending', String(id));
                if (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).length === 0) {
                    fs.rmdirSync(pendingDir);
                }
            } catch (e) { /* ignore */ }
        };

        try {
            // v2.0：5 类附件（v1.71.x D1 老类型 delivery/original_ticket 已清理 — 生产 0 行实证）
            const validAttachmentTypes = Object.keys(COLLAB_ATTACHMENT_RULES);
            if (!attachment_type || !validAttachmentTypes.includes(attachment_type)) {
                cleanupTempFiles();
                return res.status(400).json({ error: `attachment_type 必须是 ${validAttachmentTypes.join('/')}` });
            }

            const request = await dbGetAsync('SELECT * FROM collab_requests WHERE id = ?', [id]);
            if (!request) {
                cleanupTempFiles();
                return res.status(404).json({ error: '协作单不存在' });
            }

            // 权限校验（按"是否开发交付物"分组）
            // 开发交付物：result_data / result_script → 本单 developer 或 admin/publisher
            // 录入物 / 截图 / 示例 / PDF：admin/publisher
            const isDeveloperUpload = ['result_data', 'result_script'].includes(attachment_type);
            if (isDeveloperUpload) {
                const isOwnDev = request.developer_id === userId;
                if (!isOwnDev && !isPrivileged) {
                    cleanupTempFiles();
                    return res.status(403).json({ error: '无权上传交付附件（仅本单开发或管理员）' });
                }
            } else {
                if (!isPrivileged) {
                    cleanupTempFiles();
                    return res.status(403).json({ error: '无权上传此类附件（仅管理员/发布者）' });
                }
            }

            // 状态约束
            // v2.0：交付物（result_data/result_script）只能在 SUBMITTED 后由 POST /:id/submit 走（Deploy 3）；
            //       此通用 endpoint 不再接受 v2.0 交付物类型 — 留给 Deploy 3 的提交 endpoint
            if (['result_data', 'result_script'].includes(attachment_type)) {
                cleanupTempFiles();
                return res.status(409).json({ error: '交付物（result_data/result_script）请通过 POST /:id/submit 提交（Deploy 3 上线）' });
            }
            // v1.67.1 改造：ARCHIVED 归档锁定后仅 admin 可上传（publisher 也拒绝）
            // 与 v1.66.2 archived_at 软删除独立：归档锁定是已交付的历史归档，软删除是未提交前的撤销
            if (request.archived_at) {
                cleanupTempFiles();
                return res.status(409).json({
                    error: '协作单已作废，不可上传附件',
                    code: 'PARENT_SOFT_ARCHIVED'
                });
            }
            if (request.status === 'ARCHIVED') {
                const isAdmin = req.user.role === 'admin';
                if (!isAdmin) {
                    cleanupTempFiles();
                    return res.status(403).json({
                        error: '协作单已归档锁定，仅管理员可上传附件',
                        code: 'PARENT_ARCHIVED_LOCKED'
                    });
                }
            }

            const files = req.files || [];
            if (files.length === 0) {
                return res.status(400).json({ error: '请至少上传一个文件' });
            }

            // v1.77.0 codex 83 M-1：data_scope 单文件语义后端强制（前端单文件 input 仅 UI 层，API 直调可绕过；
            //   example_xlsx 历史同为前端单文件后端不限，既有行为不动，仅新类型收紧）
            if (attachment_type === 'data_scope' && files.length > 1) {
                cleanupTempFiles();
                return res.status(400).json({ error: '数据范围说明仅支持单个文件', code: 'DATA_SCOPE_SINGLE_FILE_ONLY' });
            }

            // 按 attachment_type 规则二次校验（扩展名分级 + 大小分级）
            for (const f of files) {
                const check = validateCollabAttachmentRule(attachment_type, f.originalname, f.size);
                if (!check.ok) {
                    cleanupTempFiles();
                    return res.status(400).json({ error: check.error });
                }
            }

            // 把临时文件从 _pending/{id}/ 移到 {id}_{safe_desc}/
            const targetDir = getCollabAttachmentDir(id, request.description);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // v1.72.0：预分配 attachment_seq（sc/ex/ds 走 attachment_seq 通道）
            //   通用 upload 仅处理 screenshot / example_xlsx / data_scope（rd/rs 已在前面拦截）
            //   多文件批量上传：每个文件按提交顺序分配 +1 (从 MAX+1 开始)
            const baseSeq = await collabVersioning.allocateAttachmentSeq(
                { getAsync: dbGetAsync }, id, attachment_type
            );

            const inserted = [];
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const fileSeq = baseSeq + i;
                const ext = path.extname(f.originalname || '');
                let finalName;
                try {
                    finalName = collabVersioning.buildFinalAttachmentName({
                        oaRequestNo: request.oa_request_no,
                        createdAt: request.created_at,
                        seq: fileSeq,
                        attachmentType: attachment_type,
                        isFailed: false,
                        displayName: userName,
                        username: userName,
                        ext,
                    });
                } catch (nameErr) {
                    logger.error('附件命名失败:', nameErr.message);
                    // codex 47 M-2：清理 multer 临时文件防垃圾残留
                    try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ }
                    continue;
                }
                const finalPath = path.join(targetDir, finalName);
                try {
                    fs.renameSync(f.path, finalPath);
                } catch (e) {
                    logger.error('附件移动失败:', e.message);
                    // codex 47 M-2：清理 multer 临时文件防垃圾残留
                    try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ }
                    continue;
                }

                // 入库（file_name 存相对路径，方便 GET 访问；v1.72.0 写入 attachment_seq）
                const relPath = path.relative(UPLOAD_DIR, finalPath).replace(/\\/g, '/');
                const result = await dbRunAsync(
                    `INSERT INTO collab_attachments
                        (collab_request_id, attachment_type, file_name, original_name,
                         uploaded_by, uploaded_by_name, attachment_seq)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [id, attachment_type, relPath, f.originalname, userId, userName, fileSeq]
                );
                inserted.push({
                    id: result.lastID,
                    attachment_type,
                    file_name: relPath,
                    original_name: f.originalname,
                    size: f.size
                });
            }

            // v1.77.0 codex 83 M-3：全部文件落盘/入库失败时不能返回成功（原行为"已上传 0 个附件"+200，
            //   前端会误报成功提示；files.length>0 但 inserted=0 必为异常路径，所有类型统一收紧）
            if (inserted.length === 0) {
                cleanupTempFiles();
                return res.status(500).json({ error: '附件上传失败（文件落盘或入库异常），请重试', code: 'ATTACHMENT_PERSIST_FAILED' });
            }

            insertCollabLog(id, 'ATTACH_UPLOAD', userId, userName, `上传 ${inserted.length} 个 ${attachment_type} 附件`);

            // 清理空的 _pending 子目录
            try {
                const pendingDir = path.join(COLLAB_UPLOAD_BASE, '_pending', String(id));
                if (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).length === 0) {
                    fs.rmdirSync(pendingDir);
                }
            } catch (e) { /* ignore */ }

            // 取数交付质量记录 v3.0 Commit E：example_xlsx 模板上传时列对齐可读性预检（源头防线，用户拍板）
            //   - 只提示不拦断（贴"列对齐不是闸门"）：坏模板/非 xlsx 仍上传成功，仅带 template_warning 供前端弹非阻塞提示。
            //   - 与 C2 旁路三态留痕互补：源头让 admin 当场知道 + C2 兜底留痕。
            //   - 多文件批量时取本次上传的第一个 example_xlsx 预检（取数模板通常单个）。
            let templateWarning = null;
            if (attachment_type === 'example_xlsx') {
                const tpl = inserted.find(a => a.attachment_type === 'example_xlsx');
                if (tpl) {
                    const chk = collabSubmitHelpers.checkTemplateReadable(tpl.file_name, tpl.original_name);
                    if (!chk.ok) {
                        templateWarning = { ok: false, reason: chk.reason, original_name: tpl.original_name };
                    }
                }
            }

            res.json({
                message: `已上传 ${inserted.length} 个附件`,
                attachments: inserted,
                template_warning: templateWarning,  // null=无警告；非 null=前端弹非阻塞提示（reason: NON_XLSX/EMPTY_HEADER/READ_FAILED）
            });
        } catch (err) {
            logger.error('上传协作单附件失败:', err);
            cleanupTempFiles();
            res.status(500).json({ error: err.message });
        }
    }
);

// multer 错误处理（文件过大、超出数量等）
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && req.path.startsWith('/api/collab/')) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单个文件不能超过 100MB（细分类型上限可能更低，详见错误提示）' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '单次最多上传 5 个文件' });
        return res.status(400).json({ error: `上传错误: ${err.message}` });
    }
    if (err && err.message && (err.message.startsWith('不支持的') || err.message.startsWith('文件名为空'))) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// 8. 删除附件
//    v1.71.0 权限矩阵（按"前置闸门 + 状态/类型二级限制"两阶段）：
//
//    ⏤ 阶段 0（最高优先级，硬阻断）：软删除守卫
//      - archived_at 非空 → 409 PARENT_SOFT_ARCHIVED（任何人不可改，含 admin）
//
//    ⏤ 阶段 1（按人锁前置闸门，v1.71.0 引入，方案 §2.2 + v0.1 D5）：
//      checkAttachmentOwnerOrAdmin(att, req.user)
//      - admin 任何 attachment 都可越权 → 通过
//      - 非 admin 仅 attachment.uploaded_by === req.user.id 通过；其余 403 ATTACHMENT_OWNER_LOCKED
//      - publisher 不再越权（v1.66 前历史能力被 v0.1 D5 B1-锁 收回；其他 endpoint 的 isPrivileged 不动）
//
//    ⏤ 阶段 2（通过闸门后的状态/类型二级限制）：
//      - ARCHIVED 协作单：仅 admin（owner 非 admin 已无法走到这里，admin 兜底）→ 403 PARENT_ARCHIVED_LOCKED
//      - failed 附件：admin 任何状态可清；非 admin 仅 PENDING/PENDING_ASSIGN/SUBMITTED 可清（已由阶段 1 限定 = 上传人本人）
//      - DONE 协作单 + result_* 类型：非 admin 当前 developer 仅可删自己上传的（owner 闸门已强制）；
//                                       非 result_* 类型（screenshot/example_xlsx）：仅 admin
//      - 其他状态（PENDING_ASSIGN/PENDING/SUBMITTED）：owner 闸门已强制，无额外限制
//
//    历史 mismatch 注意：v1.70.5 ADMIN_SUBMIT_ON_BEHALF 兜底产生的 result_* 由 admin 上传，
//      原 developer 在 v1.71.0 后无法自助修改，需找 admin 重传（见 scripts/verify-result-attachment-owner-consistency.js）
app.delete('/api/collab/attachments/:attId', authenticateToken, requireNonViewer, async (req, res) => {
    const { attId } = req.params;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;
    const isAdmin = req.user.role === 'admin';

    try {
        const att = await dbGetAsync('SELECT * FROM collab_attachments WHERE id = ?', [attId]);
        if (!att) return res.status(404).json({ error: '附件不存在' });

        const parent = await dbGetAsync(
            'SELECT id, status, developer_id, archived_at FROM collab_requests WHERE id = ?',
            [att.collab_request_id]
        );
        if (!parent) return res.status(404).json({ error: '协作单不存在' });

        // 软删除（v1.66.2）：任何人不可改附件（含 failed 历史）
        if (collabSubmitHelpers.isSoftArchived(parent)) {
            return res.status(409).json({
                error: '协作单已作废，不可改动附件',
                code: 'PARENT_SOFT_ARCHIVED'
            });
        }

        // v1.71.0 方案 §2.2 + v0.1 D5：按人锁前置闸门
        //   - 仅 admin 可越权操作他人附件；publisher 不再越权（v1.66 前历史能力被 v0.1 B1-锁 收回）
        //   - 闸门后的业务分支按 attachment_type / status 做精细化拒绝（保留细分错误码）
        //   - ARCHIVED 状态下 admin 兜底逻辑在闸门后继续生效（admin 走通闸门进入分支）
        const ownerCheck = collabSubmitHelpers.checkAttachmentOwnerOrAdmin(att, req.user);
        if (!ownerCheck.ok) {
            return res.status(403).json({ error: ownerCheck.reason, code: ownerCheck.code });
        }

        // ARCHIVED 归档锁定（v1.67.1）：仅 admin 可改
        // 注：闸门已让"非 admin 他人"在 ATTACHMENT_OWNER_LOCKED 处被拦截；
        //     此处 isFinalArchived 分支仅拦截"非 admin 上传人本人"——
        //     归档后即使是上传人本人也不能改，仅 admin 兜底
        if (collabSubmitHelpers.isFinalArchived(parent)) {
            if (!isAdmin) {
                return res.status(403).json({
                    error: '协作单已归档锁定，仅管理员可改附件',
                    code: 'PARENT_ARCHIVED_LOCKED'
                });
            }
        } else if (att.status === 'failed') {
            // v1.70.0 方案 §1.2：failed 附件跨状态分支（codex 24 审 #1 改正向白名单）
            //   - admin 任何状态都可删（含 failed 历史清理）
            //   - 非管理员仅 PENDING/PENDING_ASSIGN/SUBMITTED 三态可删（未来新增状态默认拒绝）
            //   - "uploaded_by 本人"约束已由前置闸门 checkAttachmentOwnerOrAdmin 强制（v1.71.0）
            //   - DONE / ARCHIVED 等其他状态下 failed 仅 admin 可清（保留作为审计证据）
            if (!isAdmin) {
                const FAILED_DELETE_ALLOWED_STATES = ['PENDING', 'PENDING_ASSIGN', 'SUBMITTED'];
                if (!FAILED_DELETE_ALLOWED_STATES.includes(parent.status)) {
                    return res.status(403).json({
                        error: `当前状态（${parent.status}）下 failed 附件仅管理员可清理（保留作为审计证据）`,
                        code: 'FAILED_KEEP_FOR_AUDIT'
                    });
                }
                // owner 检查已在前置闸门完成，此处分支不再判（v1.71.0 publisher 越权收权）
            }
        } else if (parent.status === 'DONE') {
            // DONE 状态：开发本人可改自己单的 result_* 交付物（用于修改后重走 smoke test）
            // 截图/example_xlsx 是 admin 创建产物，仅 admin 可改
            const isResultType = att.attachment_type === 'result_data' || att.attachment_type === 'result_script';
            const isCurrentDeveloper = Number(parent.developer_id) === Number(userId) && Number(parent.developer_id) !== 0;
            if (isResultType) {
                if (!isCurrentDeveloper && !isAdmin) {
                    return res.status(403).json({
                        error: '已完成状态下仅当前开发或管理员可改交付物',
                        code: 'NOT_CURRENT_DEVELOPER'
                    });
                }
            } else {
                if (!isAdmin) {
                    return res.status(403).json({
                        error: '截图/数据模板仅管理员可改',
                        code: 'NOT_ADMIN_FOR_TYPE'
                    });
                }
            }
        }
        // 其他状态（PENDING_ASSIGN / PENDING / SUBMITTED）：
        //   v1.71.0 前：上传人本人或 admin/publisher 可删
        //   v1.71.0 后：owner 检查已由前置闸门 checkAttachmentOwnerOrAdmin 强制（publisher 越权收权）
        //   本分支不再额外判，直接走删除流程

        // 删数据库记录
        await dbRunAsync('DELETE FROM collab_attachments WHERE id = ?', [attId]);

        // 删物理文件（v1.70.0：走 resolveAttachmentPath 防越界）
        try {
            const fullPath = collabSubmitHelpers.resolveAttachmentPath(att.file_name);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch (e) {
            logger.error('删除附件物理文件失败:', e.message);
        }

        const logSuffix = att.status === 'failed' ? `（failed seq=${att.failed_attempt_seq}）` : '';
        insertCollabLog(att.collab_request_id, 'ATTACH_DELETE', userId, userName,
            `删除附件 ${att.original_name}${logSuffix}`);
        res.json({ message: '附件已删除' });
    } catch (err) {
        logger.error('删除协作单附件失败:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 数据修正模块 API —— 已抽离至 routes/corrections.js（巨型文件拆分首试点，J2 切换）
//   schema readiness + DDL/migration + 18 端点 + helper 全在模块内（16 deps 局部注入）。
//   实例化点选此（原区3 位置）：16 注入依赖此处均已定义（最晚 COLLAB_CHAT_ADMIN_ID）。
//   initSchema() 在 db 连接回调内调用（M-1 codex 末次审：保持原 correction 建表时序零变更）；
//   readiness 闸门保证建好前 correction 端点 503（首启短暂窗口，与原行为一致）。
// ============================================================
const correctionModule = require('./routes/corrections')({
  logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken,
  requireAdmin, requirePublisherOrAdmin, sendIssueDingtalkRaw, UPLOAD_DIR,
  readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry,
  normalizeAttachmentExt, safeDeleteFileSync, maskPhone,
});
// initSchema() 调用见 db 连接回调（busy_timeout + initTable 之后）；此处仅实例化 + 挂载路由。
app.use('/api/corrections', correctionModule.router);

// ============================================================
// MCP Demo - 数仓对话查询
// ============================================================

/**
 * 解析用户自然语言查询意图
 */
function parseUserQuery(message) {
    const msg = message.trim().toLowerCase();

    // 帮助 / 功能介绍
    if (/帮助|help|能做什么|功能|你好/.test(msg)) {
        return { intent: 'help' };
    }

    // 列出所有表
    if (/(?:所有|全部|哪些|列出|查看).*表|表.*(?:列表|清单|目录)|list.*table/i.test(msg)) {
        return { intent: 'list_tables' };
    }

    // 表结构 / 字段
    const describeMatch = msg.match(/(?:(.+?)的)?(?:结构|字段|列|schema|describe|定义|有哪些字段)/);
    if (describeMatch) {
        const tableName = extractTableName(message) || describeMatch[1]?.trim();
        return { intent: 'describe_table', table: tableName };
    }

    // 分组统计（图表） — 必须在 count_rows 之前匹配
    if (/(?:按|分|各|每个|group\s*by).*(?:统计|分布|数量|多少|汇总)/.test(msg) || /(?:统计|分布|数量|汇总).*(?:按|分|各)/.test(msg)) {
        // 识别分组维度
        let groupBy = null;
        if (/年度|年份|每年|按年|逐年|year/i.test(msg)) groupBy = 'year';
        else if (/月度|月份|每月|按月|逐月|month/i.test(msg)) groupBy = 'month';
        else if (/季度|每季|按季|quarter/i.test(msg)) groupBy = 'quarter';
        else if (/schema/i.test(msg) || /库/.test(msg)) groupBy = 'schema';
        else if (/类型|type/i.test(msg)) groupBy = 'type';
        else if (/分层|层级|layer|ods|dwd|dim/i.test(msg)) groupBy = 'layer';
        // 识别时间字段（可选指定）
        let dateField = null;
        if (/签约|签订|signing/i.test(msg)) dateField = 'SigningDate';
        else if (/创建|create/i.test(msg)) dateField = 'CreateTime';
        else if (/开始|begin|start/i.test(msg)) dateField = 'BeginDate';
        else if (/结束|end/i.test(msg)) dateField = 'EndDate';
        else if (/提交|submit/i.test(msg)) dateField = 'SubmitDate';
        const tableName = extractTableName(message);
        return { intent: 'group_count', table: tableName, groupBy, dateField };
    }

    // 样本数据 / 查看数据 — 必须在 count_rows 之前，避免"10条"被误匹配为行数统计
    if (/(?:最近|样本|示例|预览|sample|preview|top)\d*|前\s*\d+|\d+\s*条/.test(msg)) {
        const tableName = extractTableName(message);
        const limitMatch = msg.match(/(?:前|最近|top)\s*(\d+)|\b(\d+)\s*条/);
        const limit = limitMatch ? Math.min(parseInt(limitMatch[1] || limitMatch[2]), 50) : 10;
        return { intent: 'sample_data', table: tableName, limit };
    }

    // 数据量 / 行数统计
    if (/(?:多少|数量|行数|总数|统计|count)/.test(msg)) {
        const tableName = extractTableName(message);
        return { intent: 'count_rows', table: tableName };
    }

    // 兜底
    return { intent: 'unknown' };
}

/**
 * 从用户输入中提取表名
 */
function extractTableName(message) {
    // 匹配 ods_xxx_df / dwd_xxx_df / dim_xxx 等数仓表名模式
    const tablePattern = message.match(/\b((?:ods|dwd|dws|dim|ads|stg|biz)_[\w]+)\b/i);
    if (tablePattern) return tablePattern[1];

    // 匹配 schema.table 模式
    const schemaTable = message.match(/\b(\w+\.\w+)\b/);
    if (schemaTable) return schemaTable[1];

    // 匹配"合同主表"等中文别名
    const aliasMap = {
        '合同主表': 'ods_contract_df',
        '合同表': 'ods_contract_df',
        '合同': 'ods_contract_df',
        '合同续签': 'ods_contract_original_df',
        '续签表': 'ods_contract_original_df'
    };
    for (const [alias, name] of Object.entries(aliasMap)) {
        if (message.includes(alias)) return name;
    }

    return null;
}

/**
 * 获取数仓连接池的辅助函数
 */
async function getWarehousePool() {
    const conn = await dbGetAsync(
        "SELECT * FROM db_connections WHERE is_default = 1 AND (connection_type = 'warehouse' OR connection_type IS NULL) LIMIT 1"
    );
    if (!conn) return { pool: null, error: '未配置默认数仓连接' };

    const password = decryptPassword(conn.password);
    const pool = await getMssqlPool({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        username: conn.username,
        password: password
    });
    return { pool, schema: conn.default_schema || 'dbo' };
}

/**
 * 验证表名是否存在于数仓
 */
async function validateTableName(pool, schema, tableName) {
    // 解析 schema.table
    let tSchema = schema;
    let tName = tableName;
    if (tableName.includes('.')) {
        const parts = tableName.split('.');
        tSchema = parts[0];
        tName = parts[1];
    }
    const result = await pool.request()
        .input('schema', sql.NVarChar, tSchema)
        .input('table', sql.NVarChar, tName)
        .query(`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND TABLE_TYPE = 'BASE TABLE'`);
    return { valid: result.recordset.length > 0, schema: tSchema, table: tName };
}

app.post('/api/mcp-demo/chat', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ type: 'error', message: '请输入查询内容' });
    }

    const parsed = parseUserQuery(message);
    logger.info(`MCP Demo - intent: ${parsed.intent}, table: ${parsed.table || 'N/A'}, message: "${message}"`);

    try {
        // help 不需要数据库连接
        if (parsed.intent === 'help') {
            return res.json({
                type: 'text',
                message: `我支持以下操作：\n\n- **查看所有表**：输入"数仓里有哪些表"\n- **查看表结构**：输入"ods_contract_df 的字段"\n- **统计行数**：输入"合同表有多少条数据"\n- **查看样本数据**：输入"查看合同主表前10条数据"\n\n你也可以直接输入数仓表名（如 \`ods_contract_df\`），我会自动识别。`
            });
        }

        if (parsed.intent === 'unknown') {
            return res.json({
                type: 'text',
                message: `抱歉，我没能理解你的意图。试试这些表达方式：\n\n- "查看所有表"\n- "ods_contract_df 有哪些字段"\n- "合同表有多少条数据"\n- "查看最近10条合同数据"`
            });
        }

        // 以下意图都需要数仓连接
        const { pool, schema: defaultSchema, error } = await getWarehousePool();
        if (!pool) {
            return res.json({ type: 'error', message: error });
        }

        // --- list_tables ---
        if (parsed.intent === 'list_tables') {
            const sqlText = `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`;
            const result = await pool.request().query(sqlText);
            const tables = result.recordset;
            return res.json({
                type: 'table',
                tool_name: 'list_tables',
                sql: sqlText,
                message: `数仓中共有 **${tables.length}** 张表：`,
                columns: ['TABLE_SCHEMA', 'TABLE_NAME'],
                data: tables,
                total_count: tables.length
            });
        }

        // --- describe_table ---
        if (parsed.intent === 'describe_table') {
            if (!parsed.table) {
                return res.json({ type: 'text', message: '请告诉我要查看哪张表的结构，例如："ods_contract_df 的字段"' });
            }
            const { valid, schema: tSchema, table: tName } = await validateTableName(pool, defaultSchema, parsed.table);
            if (!valid) {
                return res.json({ type: 'error', message: `表 \`${parsed.table}\` 不存在，请检查表名是否正确。` });
            }
            const sqlText = `SELECT c.COLUMN_NAME, c.DATA_TYPE + CASE WHEN c.DATA_TYPE IN ('varchar','nvarchar','char','nchar') THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'MAX' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) END + ')' WHEN c.DATA_TYPE IN ('decimal','numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS VARCHAR) + ',' + CAST(c.NUMERIC_SCALE AS VARCHAR) + ')' ELSE '' END AS DATA_TYPE_FULL, c.IS_NULLABLE, ISNULL(CAST(ep.value AS NVARCHAR(500)),'') AS COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS c LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME AND sc.object_id = OBJECT_ID('${tSchema}.${tName}') LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id AND ep.minor_id = sc.column_id AND ep.name = 'MS_Description' WHERE c.TABLE_SCHEMA = '${tSchema}' AND c.TABLE_NAME = '${tName}' ORDER BY c.ORDINAL_POSITION`;
            // 实际执行使用参数化
            const result = await pool.request()
                .input('schema', sql.NVarChar, tSchema)
                .input('table', sql.NVarChar, tName)
                .query(`
                    SELECT
                        c.COLUMN_NAME,
                        c.DATA_TYPE +
                            CASE
                                WHEN c.DATA_TYPE IN ('varchar','nvarchar','char','nchar')
                                    THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'MAX' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) END + ')'
                                WHEN c.DATA_TYPE IN ('decimal','numeric')
                                    THEN '(' + CAST(c.NUMERIC_PRECISION AS VARCHAR) + ',' + CAST(c.NUMERIC_SCALE AS VARCHAR) + ')'
                                ELSE ''
                            END AS DATA_TYPE_FULL,
                        c.IS_NULLABLE,
                        ISNULL(CAST(ep.value AS NVARCHAR(500)), '') AS COLUMN_COMMENT
                    FROM INFORMATION_SCHEMA.COLUMNS c
                    LEFT JOIN sys.columns sc ON sc.name = c.COLUMN_NAME
                        AND sc.object_id = OBJECT_ID(@schema + '.' + @table)
                    LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id
                        AND ep.minor_id = sc.column_id
                        AND ep.name = 'MS_Description'
                    WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
                    ORDER BY c.ORDINAL_POSITION
                `);
            return res.json({
                type: 'table',
                tool_name: 'describe_table',
                sql: sqlText,
                message: `表 **${tSchema}.${tName}** 共有 **${result.recordset.length}** 个字段：`,
                columns: ['COLUMN_NAME', 'DATA_TYPE_FULL', 'IS_NULLABLE', 'COLUMN_COMMENT'],
                data: result.recordset,
                total_count: result.recordset.length
            });
        }

        // --- group_count (图表) ---
        if (parsed.intent === 'group_count') {
            let sqlText, chartTitle;
            const timeGroupBy = ['year', 'month', 'quarter'].includes(parsed.groupBy);

            if (timeGroupBy && parsed.table) {
                // 按时间维度分组（年度/月度/季度）
                const { valid, schema: tSchema, table: tName } = await validateTableName(pool, defaultSchema, parsed.table);
                if (!valid) {
                    return res.json({ type: 'error', message: `表 \`${parsed.table}\` 不存在。` });
                }
                // 确定时间字段：优先用户指定，其次自动检测
                let dateCol = parsed.dateField;
                if (!dateCol) {
                    const dateColResult = await pool.request()
                        .input('schema', sql.NVarChar, tSchema)
                        .input('table', sql.NVarChar, tName)
                        .query(`SELECT TOP 1 COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND DATA_TYPE IN ('date','datetime','datetime2','smalldatetime') AND COLUMN_NAME NOT LIKE 'dw[_]%' ORDER BY ORDINAL_POSITION`);
                    if (dateColResult.recordset.length === 0) {
                        return res.json({ type: 'text', message: `表 **${tName}** 中没有找到日期类型字段，无法按时间分组。` });
                    }
                    dateCol = dateColResult.recordset[0].COLUMN_NAME;
                }
                // 验证字段存在
                const colCheck = await pool.request()
                    .input('schema', sql.NVarChar, tSchema)
                    .input('table', sql.NVarChar, tName)
                    .input('column', sql.NVarChar, dateCol)
                    .query(`SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND COLUMN_NAME = @column`);
                if (colCheck.recordset.length === 0) {
                    return res.json({ type: 'error', message: `字段 \`${dateCol}\` 不存在于表 ${tName}。` });
                }

                const periodLabels = { year: '年度', month: '月度', quarter: '季度' };
                if (parsed.groupBy === 'year') {
                    sqlText = `SELECT CAST(YEAR([${dateCol}]) AS VARCHAR) AS label, COUNT(*) AS value FROM [${tSchema}].[${tName}] WHERE [${dateCol}] IS NOT NULL GROUP BY YEAR([${dateCol}]) ORDER BY label`;
                    chartTitle = `${tName} 按${periodLabels.year}统计（${dateCol}）`;
                } else if (parsed.groupBy === 'month') {
                    sqlText = `SELECT FORMAT([${dateCol}], 'yyyy-MM') AS label, COUNT(*) AS value FROM [${tSchema}].[${tName}] WHERE [${dateCol}] IS NOT NULL GROUP BY FORMAT([${dateCol}], 'yyyy-MM') ORDER BY label`;
                    chartTitle = `${tName} 按${periodLabels.month}统计（${dateCol}）`;
                } else if (parsed.groupBy === 'quarter') {
                    sqlText = `SELECT CAST(YEAR([${dateCol}]) AS VARCHAR) + '-Q' + CAST(DATEPART(QUARTER, [${dateCol}]) AS VARCHAR) AS label, COUNT(*) AS value FROM [${tSchema}].[${tName}] WHERE [${dateCol}] IS NOT NULL GROUP BY YEAR([${dateCol}]), DATEPART(QUARTER, [${dateCol}]) ORDER BY label`;
                    chartTitle = `${tName} 按${periodLabels.quarter}统计（${dateCol}）`;
                }
            } else if (timeGroupBy && !parsed.table) {
                return res.json({ type: 'text', message: '按时间维度统计需要指定表名，例如："按年度统计合同主表数据"' });
            } else if (parsed.groupBy === 'schema' || (!parsed.groupBy && !parsed.table)) {
                sqlText = `SELECT TABLE_SCHEMA AS label, COUNT(*) AS value FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' GROUP BY TABLE_SCHEMA ORDER BY value DESC`;
                chartTitle = '各 Schema 表数量分布';
            } else if (parsed.groupBy === 'layer') {
                sqlText = `SELECT CASE WHEN TABLE_NAME LIKE 'ods[_]%' THEN 'ODS' WHEN TABLE_NAME LIKE 'dwd[_]%' THEN 'DWD' WHEN TABLE_NAME LIKE 'dws[_]%' THEN 'DWS' WHEN TABLE_NAME LIKE 'dim[_]%' THEN 'DIM' WHEN TABLE_NAME LIKE 'ads[_]%' THEN 'ADS' WHEN TABLE_NAME LIKE 'stg[_]%' THEN 'STG' ELSE '其他' END AS label, COUNT(*) AS value FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' GROUP BY CASE WHEN TABLE_NAME LIKE 'ods[_]%' THEN 'ODS' WHEN TABLE_NAME LIKE 'dwd[_]%' THEN 'DWD' WHEN TABLE_NAME LIKE 'dws[_]%' THEN 'DWS' WHEN TABLE_NAME LIKE 'dim[_]%' THEN 'DIM' WHEN TABLE_NAME LIKE 'ads[_]%' THEN 'ADS' WHEN TABLE_NAME LIKE 'stg[_]%' THEN 'STG' ELSE '其他' END ORDER BY value DESC`;
                chartTitle = '数仓分层表数量分布';
            } else if (parsed.groupBy === 'type' && parsed.table) {
                const { valid, schema: tSchema, table: tName } = await validateTableName(pool, defaultSchema, parsed.table);
                if (!valid) {
                    return res.json({ type: 'error', message: `表 \`${parsed.table}\` 不存在。` });
                }
                const colResult = await pool.request()
                    .input('schema', sql.NVarChar, tSchema)
                    .input('table', sql.NVarChar, tName)
                    .query(`SELECT TOP 1 COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND DATA_TYPE IN ('varchar','nvarchar') AND COLUMN_NAME LIKE '%type%' ORDER BY ORDINAL_POSITION`);
                if (colResult.recordset.length === 0) {
                    return res.json({ type: 'text', message: `未找到表 **${tName}** 中适合分组的类型字段。` });
                }
                const groupCol = colResult.recordset[0].COLUMN_NAME;
                sqlText = `SELECT ISNULL([${groupCol}], 'NULL') AS label, COUNT(*) AS value FROM [${tSchema}].[${tName}] GROUP BY [${groupCol}] ORDER BY value DESC`;
                chartTitle = `${tName} 按 ${groupCol} 分布`;
            } else {
                sqlText = `SELECT TABLE_SCHEMA AS label, COUNT(*) AS value FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' GROUP BY TABLE_SCHEMA ORDER BY value DESC`;
                chartTitle = '各 Schema 表数量分布';
            }

            const result = await pool.request().query(sqlText);
            const chartData = result.recordset.map(r => ({ label: String(r.label), value: Number(r.value) }));
            return res.json({
                type: 'chart',
                tool_name: 'group_count',
                sql: sqlText,
                message: `**${chartTitle}**`,
                chart_data: chartData,
                chart_title: chartTitle
            });
        }

        // --- count_rows ---
        if (parsed.intent === 'count_rows') {
            if (!parsed.table) {
                return res.json({ type: 'text', message: '请告诉我要统计哪张表，例如："合同表有多少条数据"' });
            }
            const { valid, schema: tSchema, table: tName } = await validateTableName(pool, defaultSchema, parsed.table);
            if (!valid) {
                return res.json({ type: 'error', message: `表 \`${parsed.table}\` 不存在，请检查表名是否正确。` });
            }
            const sqlText = `SELECT COUNT(*) AS cnt FROM [${tSchema}].[${tName}]`;
            const result = await pool.request().query(sqlText);
            const count = result.recordset[0].cnt;
            return res.json({
                type: 'stat',
                tool_name: 'count_rows',
                sql: sqlText,
                message: `表 **${tSchema}.${tName}** 的数据量：`,
                stat_value: count,
                stat_label: '条记录'
            });
        }

        // --- sample_data ---
        if (parsed.intent === 'sample_data') {
            if (!parsed.table) {
                return res.json({ type: 'text', message: '请告诉我要查看哪张表的数据，例如："查看 ods_contract_df 前10条"' });
            }
            const { valid, schema: tSchema, table: tName } = await validateTableName(pool, defaultSchema, parsed.table);
            if (!valid) {
                return res.json({ type: 'error', message: `表 \`${parsed.table}\` 不存在，请检查表名是否正确。` });
            }
            const limit = parsed.limit || 10;
            const sqlText = `SELECT TOP ${limit} * FROM [${tSchema}].[${tName}]`;
            const result = await pool.request().query(sqlText);
            const columns = result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [];
            // 获取总行数
            const countResult = await pool.request().query(`SELECT COUNT(*) AS cnt FROM [${tSchema}].[${tName}]`);
            const totalCount = countResult.recordset[0].cnt;
            return res.json({
                type: 'table',
                tool_name: 'sample_data',
                sql: sqlText,
                message: `表 **${tSchema}.${tName}** 的前 ${limit} 条数据：`,
                columns: columns,
                data: result.recordset,
                total_count: totalCount
            });
        }

    } catch (err) {
        logger.error('MCP Demo chat error:', err.message);
        res.json({ type: 'error', message: '查询执行失败: ' + err.message });
    }
});

app.use((req, res, next) => {
    // 静态文件请求交给express.static处理，API请求返回404
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found', path: req.path });
    }
    next();
});

// 全局错误处理
app.use((err, req, res, next) => {
    // 记录错误信息
    logger.error('Unhandled error:', {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        path: req.path,
        method: req.method
    });

    // Multer 文件上传错误
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '文件大小超过限制' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: '文件数量超过限制' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '意外的文件字段' });
    }

    // JSON 解析错误
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '无效的JSON格式' });
    }

    // JWT 认证错误
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: '无效的token' });
    }
    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'token已过期' });
    }

    // 默认服务器错误
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误'
    });
});

// 未捕获的Promise拒绝处理
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// 未捕获的异常处理
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    // 给进程一些时间来记录错误后优雅退出
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Task Pool Server running at http://localhost:${PORT}`);
    logger.info(`Local access: http://localhost:${PORT}/Task_Pool.html`);
    logger.info(`Remote access: http://192.168.1.100:${PORT}/Task_Pool.html`);

    // v1.74.3 codex 60 审 M-3 部分采纳：启动期打印纯只读领导名单（前后端双常量漂移时日志可查；
    //   前端 Data_Collab.html 须保持 READONLY_LEADER_IDS 与此一致，verify-readonly-leader-exporter-block.js 卡同源）
    logger.info(`v1.74.3 纯只读领导账号名单（不可被设为 exporter）: READONLY_LEADER_IDS = [${READONLY_LEADER_IDS.join(', ')}]`);

    // Deploy 3 数据协作模块附件巡检（codex 七审 L1 异步启动 + M3 异常非阻塞）
    // 不阻塞服务 ready，巡检结果只走 logger.warn/info，不抛错
    setImmediate(() => {
        const collabRoot = path.join(UPLOAD_DIR, 'collab');
        collabVersioning.scanOrphansAndDanglingPointers({
            db,
            dbAsync: { runAsync: dbRunAsync, getAsync: dbGetAsync, allAsync: dbAllAsync },
            collabRoot,
            logger
        }).catch(e => {
            logger.error(`[collab-integrity] 巡检顶层 Promise 异常（不阻断服务）: ${e.message}`);
        });
    });

    // Deploy 3 模块 5 启动恢复（codex 十一审 #2 #4 #5 #7）
    //   - 进程崩溃（PM2 重启/OOM/系统断电）后，可能有协作单卡在
    //     sql_validation_status='running'（拿锁开始 smoke test 后进程死了）
    //   - 启动时扫超时的 running 协作单恢复为 failed，让开发可重提
    //
    // 不变量（codex #2 落地）：
    //   running 必伴随 validation_started_at IS NOT NULL（拿锁后才同时写）
    //   所以 SQL 不需要 NULL 兜底（codex #6 Claude 不采纳）
    //
    // 阈值 90s：smoke test 自身 20s 超时 + mssql 连接冷启动 + 错误处理 + DB 写回 ≈ 30s 上限的 3 倍兜底
    //   不会误杀任何真正在跑的 smoke test（最长 20s 必出结果）
    //
    // 业务范围（codex #5）：限定 status='SUBMITTED'，不动 DONE/ARCHIVED/PENDING
    //   （DONE 不可能仍为 running 但严格过滤防御）
    setImmediate(async () => {
        try {
            // codex 十二审 #4：错误文案改为"校验流程被中断"——避免开发误以为 SQL 本身有问题
            // 真实语义：可能 smoke 已通过但 DB 事务未 commit 就崩溃了（at-least-once 重提语义）
            const result = await dbRunAsync(
                `UPDATE collab_requests
                    SET sql_validation_status = 'failed',
                        sql_validation_error = '服务重启时校验流程被中断，请重新提交（这不代表您的 SQL 有问题）'
                  WHERE status = 'SUBMITTED'
                    AND sql_validation_status = 'running'
                    AND validation_started_at < datetime('now','localtime','-90 seconds')`
            );
            if (result && result.changes > 0) {
                logger.warn(`[collab-resume] 启动恢复 ${result.changes} 个 running 超时协作单为 failed`);
            } else {
                logger.info(`[collab-resume] 启动恢复扫描完成，无中断的 smoke test`);
            }

            // codex 十二审 #7：诊断脏数据（running + validation_started_at NULL）
            // 该组合违反代码不变量（拿锁后才同时写两字段）——若出现说明手工修复或迁移异常
            // 只 warn 不动数据，便于排查
            const diag = await dbAllAsync(
                `SELECT id FROM collab_requests
                  WHERE sql_validation_status = 'running'
                    AND validation_started_at IS NULL`
            );
            if (diag && diag.length > 0) {
                logger.warn(`[collab-resume] 诊断：${diag.length} 个 running + validation_started_at NULL 脏数据 (id=${diag.map(r => r.id).join(',')})——违反代码不变量，需手工排查`);
            }
        } catch (e) {
            logger.error(`[collab-resume] 启动恢复扫描异常（不阻断服务）: ${e.message}`);
        }
    });
});

