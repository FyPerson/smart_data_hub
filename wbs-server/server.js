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

// 问题跟踪常量
const ISSUE_TYPES = ['需求', '缺陷', '数据质量', '变更请求', '源系统变更', '调度异常'];
const ISSUE_SOURCES = ['业务方', '内部发现', '外包反馈', 'FDL自动'];
const ISSUE_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ISSUE_STATUSES = ['待处理', '处理中', '待验证', '已关闭'];
const ISSUE_STATUS_TRANSITIONS = {
    '待处理': ['处理中'],
    '处理中': ['待验证'],
    '待验证': ['已关闭', '处理中'],
    '已关闭': ['处理中']
};
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
        initTable();
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

    // 问题跟踪
    db.run(`CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT '需求',
        source TEXT NOT NULL DEFAULT '内部发现',
        priority TEXT NOT NULL DEFAULT 'P2',
        status TEXT NOT NULL DEFAULT '待处理',
        related_table TEXT,
        error_time DATETIME,
        progress INTEGER DEFAULT 0,
        preview_url TEXT,
        assigned_to INTEGER,
        assigned_to_name TEXT,
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        closed_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to)`);

    db.run(`CREATE TABLE IF NOT EXISTS issue_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)`);

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
            ['archived_by', 'INTEGER']
        ];
        for (const [col, type] of v3CollabRequestColumns) {
            safeAlterAddColumn('collab_requests', col, type);
        }
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_contact_person ON collab_requests(contact_person_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_collab_contact_status ON collab_requests(contact_person_id, status)`);

        // 健康检查放在 serialize 末尾，确保所有 ALTER/INDEX 都已串行执行完
        verifyV2CollabSchema();
    });
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
        'archived_at', 'archived_reason', 'archived_by'
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
            logger.info(`v2.0 schema 健康检查通过：collab_requests ${expectedCollabRequest.length} 个新增字段齐全（含 D3 attachment_dir + v3 二级转派 5 字段 + v1.66.1 对接人钉钉已读跟踪 3 字段 + v1.66.2 软删除 3 字段）`);
        }
    });
    db.all("PRAGMA table_info(collab_attachments)", [], (err, rows) => {
        if (err) return;
        const actualCols = rows.map(r => r.name);
        const missing = ['submission_version', 'status', 'superseded_at'].filter(c => !actualCols.includes(c));
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

// 进程退出时关闭连接池
process.on('SIGINT', async () => {
    await closeMssqlPools();
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
    const { host, port, database, username, password } = req.body;

    if (!host || !database || !username || !password) {
        return res.status(400).json({ error: '缺少必要参数' });
    }

    try {
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

        res.json({ success: true, message: '连接测试成功' });
    } catch (err) {
        logger.error('Test new db connection error:', err.message);
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
        const pool = await getMssqlPool({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            username: conn.username,
            password: password
        });

        // 执行简单查询测试
        const result = await pool.request().query('SELECT 1 as test');
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

// ==================== 问题跟踪 API ====================

// 获取问题列表（支持筛选）
app.get('/api/issues', authenticateToken, (req, res) => {
    const { status, type, source, priority, assigned_to, search, sort = 'updated_at', order = 'DESC' } = req.query;
    let sql = 'SELECT * FROM issues WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (priority) { sql += ' AND priority = ?'; params.push(priority); }
    if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
    if (search) { sql += ' AND (title LIKE ? OR description LIKE ? OR related_table LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const allowedSort = ['id', 'priority', 'status', 'type', 'updated_at', 'created_at', 'progress'];
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

// 创建问题
app.post('/api/issues', authenticateToken, (req, res) => {
    const { title, description, type, source, priority, related_table, error_time, assigned_to, assigned_to_name } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
    if (type && !ISSUE_TYPES.includes(type)) return res.status(400).json({ error: '无效的问题类型' });
    if (source && !ISSUE_SOURCES.includes(source)) return res.status(400).json({ error: '无效的问题来源' });
    if (priority && !ISSUE_PRIORITIES.includes(priority)) return res.status(400).json({ error: '无效的优先级' });

    const sql = `INSERT INTO issues (title, description, type, source, priority, related_table, error_time, assigned_to, assigned_to_name, created_by, created_by_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [
        title.trim(),
        description || '',
        type || '需求',
        source || '内部发现',
        priority || 'P2',
        related_table || null,
        error_time || null,
        assigned_to || null,
        assigned_to_name || null,
        req.user.id,
        req.user.display_name || req.user.username
    ], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logger.info(`用户 ${req.user.username} 创建问题 #${this.lastID}: ${title.trim()}`);
        res.json({ id: this.lastID });
    });
});

// 获取问题详情（含评论）
app.get('/api/issues/:id', authenticateToken, (req, res) => {
    db.get('SELECT * FROM issues WHERE id = ?', [req.params.id], (err, issue) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!issue) return res.status(404).json({ error: '问题不存在' });

        db.all('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC', [req.params.id], (err2, comments) => {
            if (err2) return res.status(500).json({ error: err2.message });
            issue.comments = comments || [];
            res.json(issue);
        });
    });
});

// 编辑问题
app.put('/api/issues/:id', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { title, description, type, source, priority, related_table, error_time, preview_url } = req.body;
    const fields = [];
    const values = [];

    if (title !== undefined) { if (!title.trim()) return res.status(400).json({ error: '标题不能为空' }); fields.push('title = ?'); values.push(title.trim()); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (type !== undefined) { if (!ISSUE_TYPES.includes(type)) return res.status(400).json({ error: '无效的问题类型' }); fields.push('type = ?'); values.push(type); }
    if (source !== undefined) { if (!ISSUE_SOURCES.includes(source)) return res.status(400).json({ error: '无效的问题来源' }); fields.push('source = ?'); values.push(source); }
    if (priority !== undefined) { if (!ISSUE_PRIORITIES.includes(priority)) return res.status(400).json({ error: '无效的优先级' }); fields.push('priority = ?'); values.push(priority); }
    if (related_table !== undefined) { fields.push('related_table = ?'); values.push(related_table || null); }
    if (error_time !== undefined) { fields.push('error_time = ?'); values.push(error_time || null); }
    if (preview_url !== undefined) { fields.push('preview_url = ?'); values.push(preview_url || null); }

    if (fields.length === 0) return res.status(400).json({ error: '无更新字段' });
    fields.push("updated_at = datetime('now','localtime')");
    values.push(req.params.id);

    db.run(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '问题不存在' });
        res.json({ updated: this.changes });
    });
});

// 状态流转
app.put('/api/issues/:id/status', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { status } = req.body;
    if (!status || !ISSUE_STATUSES.includes(status)) return res.status(400).json({ error: '无效的状态' });

    db.get('SELECT status FROM issues WHERE id = ?', [req.params.id], (err, issue) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!issue) return res.status(404).json({ error: '问题不存在' });

        const allowed = ISSUE_STATUS_TRANSITIONS[issue.status];
        if (!allowed || !allowed.includes(status)) {
            return res.status(400).json({ error: `不能从"${issue.status}"转为"${status}"` });
        }

        const closedAt = status === '已关闭' ? "datetime('now','localtime')" : 'NULL';
        db.run(`UPDATE issues SET status = ?, closed_at = ${closedAt}, updated_at = datetime('now','localtime') WHERE id = ?`,
            [status, req.params.id], function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                logger.info(`用户 ${req.user.username} 将问题 #${req.params.id} 状态改为 ${status}`);
                res.json({ updated: this.changes });
            });
    });
});

// 指派
app.put('/api/issues/:id/assign', authenticateToken, requirePublisherOrAdmin, (req, res) => {
    const { assigned_to, assigned_to_name } = req.body;
    db.run(`UPDATE issues SET assigned_to = ?, assigned_to_name = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [assigned_to || null, assigned_to_name || null, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: '问题不存在' });
            logger.info(`用户 ${req.user.username} 指派问题 #${req.params.id} 给 ${assigned_to_name || '无'}`);
            res.json({ updated: this.changes });
        });
});

// 更新进度
app.put('/api/issues/:id/progress', authenticateToken, requireNonViewer, (req, res) => {
    const { progress } = req.body;
    if (progress === undefined || progress < 0 || progress > 100) return res.status(400).json({ error: '进度必须在0-100之间' });

    db.run(`UPDATE issues SET progress = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [progress, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: '问题不存在' });
            res.json({ updated: this.changes });
        });
});

// 删除问题
app.delete('/api/issues/:id', authenticateToken, requireAdmin, (req, res) => {
    db.run('DELETE FROM issues WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: '问题不存在' });
        logger.info(`管理员 ${req.user.username} 删除问题 #${req.params.id}`);
        res.json({ deleted: this.changes });
    });
});

// 获取评论列表
app.get('/api/issues/:id/comments', authenticateToken, (req, res) => {
    db.all('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 添加评论
app.post('/api/issues/:id/comments', authenticateToken, requireNonViewer, (req, res) => {
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

// Webhook: FDL调度异常自动接入（预留）
app.post('/api/issues/webhook/schedule', (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: '无效的 Webhook 密钥' });

    const { node_name, table_name, error_message, error_time, run_id } = req.body;
    if (!table_name && !node_name) return res.status(400).json({ error: '至少需要 node_name 或 table_name' });

    // run_id 去重
    if (run_id) {
        db.get('SELECT id FROM issues WHERE description LIKE ? AND type = ?', [`%run_id: ${run_id}%`, '调度异常'], (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });
            if (existing) return res.json({ id: existing.id, message: '已存在相同记录，跳过' });
            createScheduleIssue();
        });
    } else {
        createScheduleIssue();
    }

    function createScheduleIssue() {
        const title = `[调度异常] ${table_name || node_name} 执行失败`;
        const desc = [
            error_message || '无错误详情',
            run_id ? `\nrun_id: ${run_id}` : ''
        ].join('');

        db.run(`INSERT INTO issues (title, description, type, source, priority, related_table, error_time, created_by, created_by_name)
                VALUES (?, ?, '调度异常', 'FDL自动', 'P1', ?, ?, 0, 'FDL系统')`,
            [title, desc, table_name || null, error_time || null], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                logger.info(`Webhook 自动创建调度异常 #${this.lastID}: ${title}`);
                res.json({ id: this.lastID });
            });
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
    '其他'
];

// 需求类型枚举
// v2.0 仅允许 ONE_OFF_EXPORT（新建时硬填）；其余 3 类保留兼容旧数据 + 列表筛选合法值
const COLLAB_REQUEST_TYPES = ['DASHBOARD_NEW', 'METRIC_CHANGE', 'METRIC_ADD_FROM_SOURCE', 'ONE_OFF_EXPORT'];
const COLLAB_REQUEST_TYPE_V2_DEFAULT = 'ONE_OFF_EXPORT';

// 主表状态枚举
// v3 二级转派状态机（2026-05-18 起）：PENDING_ASSIGN → PENDING → SUBMITTED → DONE → ARCHIVED
// CONFIRMED/CLAIMED 保留以兼容潜在旧数据筛选
const COLLAB_STATUSES = ['PENDING_ASSIGN', 'PENDING', 'SUBMITTED', 'DONE', 'ARCHIVED', 'CONFIRMED', 'CLAIMED'];

// 二级转派占位值（B1 方案）：未指派时 developer_id=0、developer_name='(待指派)'
// 权威判断未指派：status === 'PENDING_ASSIGN'；developer_id=0 是冗余信号
const COLLAB_UNASSIGNED_DEVELOPER_ID = 0;
const COLLAB_UNASSIGNED_DEVELOPER_NAME = '(待指派)';

// 协作单操作日志写入辅助
function insertCollabLog(collabRequestId, operationType, operatorId, operator, reason = null) {
    db.run(
        'INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, reason) VALUES (?, ?, ?, ?, ?)',
        [collabRequestId, operationType, operatorId, operator, reason],
        (err) => { if (err) logger.error('Insert collab log failed:', err.message); }
    );
}

// 协作单附件 multer 配置（v2.0 方案 §5.4）
// 5 类 attachment_type 复用一个 multer 实例：扩展名联合白名单 + 100MB 顶上限；
// MIME 校验取消（codex 六审 B7）；扩展名 + 大小的分级在 endpoint 内按 attachment_type 二次校验。
const COLLAB_UPLOAD_BASE = path.join(UPLOAD_DIR, 'collab');

if (!fs.existsSync(COLLAB_UPLOAD_BASE)) {
    fs.mkdirSync(COLLAB_UPLOAD_BASE, { recursive: true });
}

// 各 attachment_type 的扩展名白名单 + 大小上限（字节）
// 方案 §5.4：screenshot=10MB / example_xlsx 分级 / result_data=100MB / result_script=1MB / pdf=10MB
const COLLAB_ATTACHMENT_RULES = {
    screenshot:     { exts: ['.png','.jpg','.jpeg','.gif','.webp'],                                       sizeByExt: null,                              defaultSize: 10  * 1024 * 1024 },
    example_xlsx:   { exts: ['.xlsx','.xls','.pdf','.docx','.png','.jpg','.jpeg','.gif','.webp'],         sizeByExt: { '.xlsx': 100*1024*1024, '.xls': 100*1024*1024 }, defaultSize: 10  * 1024 * 1024 },
    result_data:    { exts: ['.xlsx','.xls'],                                                             sizeByExt: null,                              defaultSize: 100 * 1024 * 1024 },
    result_script:  { exts: ['.sql','.txt'],                                                              sizeByExt: null,                              defaultSize: 1   * 1024 * 1024 },
    pdf:            { exts: ['.pdf'],                                                                     sizeByExt: null,                              defaultSize: 10  * 1024 * 1024 }
};

// D1 兼容：旧 attachment_type 'original_ticket' / 'delivery' 映射到新规则
// （D1 上线后 collab_attachments 为空，但 endpoint 历史接受这两个值）
const COLLAB_LEGACY_TYPE_ALIAS = {
    'original_ticket': 'screenshot',   // 老语义"原始单据截图" → 新 screenshot 规则
    'delivery':        'result_data'   // 老语义"交付物" → 新 result_data 规则
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
    const aliased = COLLAB_LEGACY_TYPE_ALIAS[attachmentType] || attachmentType;
    const rule = COLLAB_ATTACHMENT_RULES[aliased];
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
    // Deploy 3 单方言决策（方案 §6.1-A）：仅 SQL Server source 出现在下拉
    // MySQL 等其他方言留到 v2.1 扩展 smoke test 引擎后再放开
    db.all(
        "SELECT id, name, type, host, port, database, source_system_code FROM db_connections WHERE connection_type = 'source' AND type = 'sqlserver' ORDER BY name ASC, id ASC",
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
    if (my_role) {
        if (!['contact', 'developer', 'admin'].includes(my_role)) {
            return res.status(400).json({ error: '无效的 my_role 值（合法值：contact/developer/admin）' });
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
        }
        // my_role=admin：不加筛选，返回全部
    } else if (!isAdmin) {
        // codex 十六审 #2：未传 my_role 的普通用户默认按本人可见范围过滤
        sql += ' AND (contact_person_id = ? OR (developer_id = ? AND developer_id != 0))';
        params.push(currentUserId, currentUserId);
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
    sql += ` ORDER BY
        CASE status
            WHEN 'PENDING_ASSIGN' THEN 0
            WHEN 'PENDING' THEN 1
            WHEN 'SUBMITTED' THEN 2
            WHEN 'DONE' THEN 3
            WHEN 'ARCHIVED' THEN 4
            ELSE 5
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
        if (!isAdmin && !isContact && !isDeveloper) {
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

        res.json({ ...request, items, attachments, logs });
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
        target_db_connection_id
    } = req.body;

    try {
        const validation = await validateCollabRequestFields(req.body, true);
        if (typeof validation === 'string') {
            return res.status(400).json({ error: validation });
        }
        const contactPerson = validation.contactPerson;
        const contactPersonName = contactPerson.display_name || contactPerson.username;

        const operatorId = req.user.id;
        const operatorName = req.user.display_name || req.user.username;

        const oaTrimmed = String(oa_request_no).trim();

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
                     target_db_connection_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_ASSIGN', ?, ?, ?, ?, ?, ?, ?)`,
                [
                    external_request_id || null,
                    oaTrimmed,
                    requester_dept,
                    String(requester_name).trim(),
                    COLLAB_REQUEST_TYPE_V2_DEFAULT,
                    String(description).trim(),
                    deadline,
                    operatorId,
                    operatorName,
                    COLLAB_UNASSIGNED_DEVELOPER_ID,
                    COLLAB_UNASSIGNED_DEVELOPER_NAME,
                    contactPerson.id,
                    contactPersonName,
                    target_db_connection_id
                ]
            );
            const newId = result.lastID;
            insertCollabLog(newId, 'CREATE', operatorId, operatorName, null);
            logger.info(`用户 ${req.user.username} 创建协作单 #${newId}（OA: ${oaTrimmed}）`);
            res.json({ id: newId, message: '协作单已创建' });
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

        const isPendingAssign = collab.status === 'PENDING_ASSIGN';
        const isPendingUnsubmitted = collab.status === 'PENDING' && (collab.submission_version || 0) === 0;
        if (!isPendingAssign && !isPendingUnsubmitted) {
            return res.status(409).json({
                error: `当前状态 ${collab.status} 不可作废（仅 PENDING_ASSIGN 或 PENDING+未提交可作废）`,
                code: 'INVALID_STATE',
                current_status: collab.status
            });
        }

        // 条件 UPDATE：兜底并发漂移
        const result = await dbRunAsync(
            `UPDATE collab_requests
                SET archived_at = datetime('now','localtime'),
                    archived_reason = ?,
                    archived_by = ?
              WHERE id = ?
                AND status = ?
                AND archived_at IS NULL
                AND (submission_version IS NULL OR submission_version = 0)`,
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
        if (collab.status !== 'PENDING_ASSIGN' && collab.status !== 'PENDING') {
            return res.status(409).json({ error: `当前状态 ${collab.status} 不可发送通知（仅 PENDING_ASSIGN / PENDING 可触发）` });
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

        const platformBaseUrl = await readSystemConfig('platform_base_url');

        // 按状态选收件人 + 模板
        let targetUserId, title, markdown, opLogType;
        if (collab.status === 'PENDING_ASSIGN') {
            targetUserId = collab.contact_person_id;
            title = `待指派协作单 · ${collab.requester_dept}`;
            markdown = dingtalkNotify.buildCollabCreatedCard(collab, platformBaseUrl);
            opLogType = 'NOTIFY_CONTACT';
        } else {
            // PENDING
            targetUserId = collab.developer_id;
            title = `新临时取数任务 · ${collab.requester_dept}`;
            markdown = dingtalkNotify.buildCollabAssignedCard(collab, platformBaseUrl);
            opLogType = 'NOTIFY';
        }

        if (!targetUserId || Number(targetUserId) === 0) {
            return res.status(400).json({ error: '收件人未定（PENDING_ASSIGN 需有对接人，PENDING 需已指派开发）' });
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
app.get('/api/collab/requests/:id/notify-read-status', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const recipient = (req.query.recipient || 'developer').toLowerCase();
    if (recipient !== 'contact' && recipient !== 'developer') {
        return res.status(400).json({ error: '无效的 recipient 值（合法值：contact/developer）' });
    }

    // 字段名映射：选不同字段组
    const fieldMap = recipient === 'contact'
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
                    ${fieldMap.notified_at} AS notified_at,
                    ${fieldMap.message_key} AS message_key,
                    ${fieldMap.read_at} AS read_at
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) return res.status(404).json({ error: '协作单不存在' });
        if (!collab.notified_at) return res.status(400).json({ error: `尚未通知${fieldMap.label},无法查询已读状态` });

        // 已固化 read_at → 直接返回,不再调钉钉(钉钉无"取消已读"语义,固化值即终态)
        if (collab.read_at) {
            const u0 = await dbGetAsync('SELECT display_name FROM users WHERE id = ?', [collab.recipient_user_id]);
            return res.json({
                recipient,
                notified_at: collab.notified_at,
                // 兼容旧前端字段名（recipient=developer 时返 developer_name；recipient=contact 时返 contact_person_name 风格）
                developer_name: u0 && u0.display_name,
                recipient_name: u0 && u0.display_name,
                read: true,
                read_at: collab.read_at,
                cached: true,
                queried_at: new Date().toISOString()
            });
        }

        if (!collab.message_key) {
            return res.status(400).json({ error: `该${fieldMap.label}通知缺少消息标识,无法查询已读状态(老协作单或钉钉端未返回消息号)` });
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

        // 取收件人的 dingtalk_user_id 做对照
        const recipientUser = await dbGetAsync(
            'SELECT id, display_name, dingtalk_user_id FROM users WHERE id = ?',
            [collab.recipient_user_id]
        );

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
        const recipientDingUserId = recipientUser && recipientUser.dingtalk_user_id;
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
            developer_name: recipientUser && recipientUser.display_name,  // 兼容旧前端
            recipient_name: recipientUser && recipientUser.display_name,
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
                        description, attachment_dir, submitted_at
                   FROM collab_requests WHERE id = ?`,
                [id]
            );
            if (!collab) {
                cleanupPending();
                return res.status(404).json({ error: '协作单不存在' });
            }

            // === 前置校验：状态 ∈ {PENDING, SUBMITTED}（codex Q2）===
            if (!['PENDING', 'SUBMITTED'].includes(collab.status)) {
                cleanupPending();
                return res.status(409).json({
                    error: `当前状态 ${collab.status} 不允许提交（仅 PENDING/SUBMITTED 可提交）`,
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
            const targetConn = await dbGetAsync(
                `SELECT id, name, type, host, port, database, username, password
                   FROM db_connections
                  WHERE id = ? AND connection_type = 'source' AND type = 'sqlserver'`,
                [collab.target_db_connection_id]
            );
            if (!targetConn) {
                cleanupPending();
                return res.status(500).json({ error: '目标业务库配置缺失或非 SQL Server 方言（v2.0 仅支持 SQL Server）' });
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
            const preUpdate = await dbRunAsync(
                `UPDATE collab_requests
                    SET status = 'SUBMITTED',
                        submitted_at = COALESCE(submitted_at, datetime('now','localtime')),
                        last_submitted_at = datetime('now','localtime'),
                        sql_validation_status = 'queued',
                        validation_started_at = NULL
                  WHERE id = ? AND submission_version = ? AND status IN ('PENDING','SUBMITTED')`,
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

            // === 拿 mssql 连接池 ===
            let pool;
            try {
                pool = await getMssqlPool({
                    host: targetConn.host,
                    port: targetConn.port,
                    database: targetConn.database,
                    username: targetConn.username,
                    password: dbPassword,
                });
            } catch (e) {
                cleanupPending();
                logger.error(`[collab-submit] 目标库连接失败: ${e.message}`);
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
            const runSmokeTestClosure = (scriptPath) =>
                collabSubmitHelpers.runRealSmokeTest(scriptPath, pool, {
                    requestId: id,
                    oldVer,
                    dbAsync: { runAsync: dbRunAsync },
                    logger,
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
                    uploadedFiles,
                    runSmokeTest: runSmokeTestClosure,
                    logger,
                });
            } catch (e) {
                // 分支处理（codex C1 + 对照表）
                if (e.code === 'SMOKE_TEST_FAILED') {
                    // smoke test 失败：业务错，HTTP 200 + business_error
                    const sqlErr = collabSubmitHelpers.sanitizeSqlError(e.smokeError || e.message);
                    await dbRunAsync(
                        `UPDATE collab_requests
                            SET sql_validation_status = 'failed',
                                sql_validation_error = ?,
                                sql_validated_at = datetime('now','localtime')
                          WHERE id = ? AND submission_version = ?`,
                        [sqlErr, id, oldVer]
                    ).catch(err => logger.warn(`[collab-submit] 写 failed 状态失败: ${err.message}`));
                    insertCollabLog(id, 'SUBMIT_VALIDATION_FAILED', userId, userName, sqlErr);
                    return res.status(200).json({
                        business_error: true,
                        message: 'smoke test 验证失败，请检查 SQL',
                        sql_validation_status: 'failed',
                        sql_validation_error: sqlErr,
                        current_status: 'SUBMITTED',
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

            return res.json({
                message: '提交成功',
                new_version: activateResult.newVer,
                attachment_dir: activateResult.attachmentDir,
                sql_validation_status: 'passed',
                smoke_test_validated_at: activateResult.smokeTestResult.validatedAt,
                smoke_test_row_count: activateResult.smokeTestResult.rowCount,
                current_status: 'DONE',
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
        // === 前置 SELECT：协作单存在 + 双重状态守卫（友好错误信息）===
        const collab = await dbGetAsync(
            `SELECT id, status, sql_validation_status
               FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
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
                AND sql_validation_status = 'failed'`,
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
        const collab = await dbGetAsync(
            `SELECT id, status, friction_cause_category, friction_note FROM collab_requests WHERE id = ?`,
            [id]
        );
        if (!collab) {
            return res.status(404).json({ error: '协作单不存在' });
        }
        if (collab.status !== 'DONE') {
            return res.status(409).json({
                error: `当前状态 ${collab.status} 不允许记录协作摩擦（仅 DONE 可记录）`,
                code: 'INVALID_STATE',
                current_status: collab.status,
            });
        }

        // 条件 UPDATE 兜底并发（防 SELECT 后状态被改）
        const result = await dbRunAsync(
            `UPDATE collab_requests SET
                friction_occurred = 1,
                friction_recorded_at = datetime('now','localtime'),
                friction_cause_category = ?,
                friction_note = ?
              WHERE id = ? AND status = 'DONE'`,
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
//    original_ticket：仅 publisher+
//    delivery：本单 developer 或 publisher+
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
            // v2.0：5 类附件 + 兼容 D1 老 2 类
            const validAttachmentTypes = Object.keys(COLLAB_ATTACHMENT_RULES).concat(Object.keys(COLLAB_LEGACY_TYPE_ALIAS));
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
            // 开发交付物：result_data / result_script / delivery（旧）→ 本单 developer 或 admin/publisher
            // 录入物 / 截图 / 示例 / PDF：admin/publisher
            const isDeveloperUpload = ['result_data', 'result_script', 'delivery'].includes(attachment_type);
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
            // 兼容 D1 老 'delivery'：保持原有约束（CONFIRMED 不可上传）
            if (attachment_type === 'delivery' && request.status === 'CONFIRMED') {
                cleanupTempFiles();
                return res.status(409).json({ error: '交付附件只能在 CLAIMED 及以后状态上传' });
            }
            if (request.status === 'ARCHIVED' && !isPrivileged) {
                cleanupTempFiles();
                return res.status(403).json({ error: '已归档协作单的附件仅管理员/发布者可上传' });
            }

            const files = req.files || [];
            if (files.length === 0) {
                return res.status(400).json({ error: '请至少上传一个文件' });
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

            const inserted = [];
            for (const f of files) {
                const finalPath = path.join(targetDir, f.filename);
                try {
                    fs.renameSync(f.path, finalPath);
                } catch (e) {
                    logger.error('附件移动失败:', e.message);
                    continue;
                }

                // 入库（file_name 存相对路径，方便 GET 访问）
                const relPath = path.relative(UPLOAD_DIR, finalPath).replace(/\\/g, '/');
                const result = await dbRunAsync(
                    `INSERT INTO collab_attachments
                        (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [id, attachment_type, relPath, f.originalname, userId, userName]
                );
                inserted.push({
                    id: result.lastID,
                    attachment_type,
                    file_name: relPath,
                    original_name: f.originalname,
                    size: f.size
                });
            }

            insertCollabLog(id, 'ATTACH_UPLOAD', userId, userName, `上传 ${inserted.length} 个 ${attachment_type} 附件`);

            // 清理空的 _pending 子目录
            try {
                const pendingDir = path.join(COLLAB_UPLOAD_BASE, '_pending', String(id));
                if (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).length === 0) {
                    fs.rmdirSync(pendingDir);
                }
            } catch (e) { /* ignore */ }

            res.json({ message: `已上传 ${inserted.length} 个附件`, attachments: inserted });
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
//    父单 ARCHIVED：仅 publisher+ 可删
//    父单非 ARCHIVED：上传人本人或 publisher+ 可删
app.delete('/api/collab/attachments/:attId', authenticateToken, requireNonViewer, async (req, res) => {
    const { attId } = req.params;
    const userId = req.user.id;
    const userName = req.user.display_name || req.user.username;
    const isPrivileged = ['admin', 'publisher'].includes(req.user.role);

    try {
        const att = await dbGetAsync('SELECT * FROM collab_attachments WHERE id = ?', [attId]);
        if (!att) return res.status(404).json({ error: '附件不存在' });

        const parent = await dbGetAsync('SELECT id, status FROM collab_requests WHERE id = ?', [att.collab_request_id]);
        if (!parent) return res.status(404).json({ error: '协作单不存在' });

        if (parent.status === 'ARCHIVED') {
            if (!isPrivileged) return res.status(403).json({ error: '已归档协作单的附件仅管理员/发布者可删' });
        } else {
            if (att.uploaded_by !== userId && !isPrivileged) {
                return res.status(403).json({ error: '只能删除自己上传的附件' });
            }
        }

        // 删数据库记录
        await dbRunAsync('DELETE FROM collab_attachments WHERE id = ?', [attId]);

        // 删物理文件
        try {
            const fullPath = path.join(UPLOAD_DIR, att.file_name);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch (e) {
            logger.error('删除附件物理文件失败:', e.message);
        }

        insertCollabLog(att.collab_request_id, 'ATTACH_DELETE', userId, userName, `删除附件 ${att.original_name}`);
        res.json({ message: '附件已删除' });
    } catch (err) {
        logger.error('删除协作单附件失败:', err);
        res.status(500).json({ error: err.message });
    }
});

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

