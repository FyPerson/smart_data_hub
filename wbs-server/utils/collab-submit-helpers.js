/**
 * 数据协作模块提交 endpoint helper（Deploy 3 模块 4）
 *
 * 设计来源：docs/local/数据协作模块_方案_v2.0.md §6.2
 * codex 九审拍板（13 条全采纳）：docs/local/codex审查记录/数据协作模块/10-D3-模块4-提交API-取舍审-20260513.md
 *
 * 提供 3 个工具函数：
 *   - cleanupPendingFiles(files)   清理 multer 已落盘但 endpoint 拒绝接收的临时文件（C2）
 *   - sanitizeSqlError(message)    SQL Server 错误消息脱敏（M3）
 *   - runRealSmokeTest(...)        真 smoke test 调用（sql-validator + mssql）
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sqlValidator = require('./sql-validator');

// ============================================================================
// §-1 路径与终态 helper（v1.70.0 方案 §1.2 / §1.2.6 抽取）
// ============================================================================
//
// 抽取动机（quality_first A1-A7）：
//   - 现状：DELETE endpoint + activateNewVersion 各自散落"终态判断"和"路径拼接"
//   - 问题：跨 endpoint 改动权限矩阵或目录结构时，多处手抄遗漏（v1.67.1 critical bug 源头）
//   - 防范：统一一处定义，所有调用方走 helper
//
// ⚠️ v1.70.0 不抽 isActiveUserWhere（codex 三审 #2 误报）：
//   - grep 全文 server.js 0 处 is_active=1 用法，全部已是 status='active'
//   - 不存在替换工作；如未来 users 表新增软删字段再抽
//
// UPLOAD_DIR 计算与 server.js:22 必须保持等价（path.join(__dirname, 'uploads')）
//   - server.js 的 __dirname = wbs-server/
//   - 本文件 __dirname = wbs-server/utils/，所以取 path.dirname(__dirname)
const UPLOAD_DIR_FOR_RESOLVE = path.join(path.dirname(__dirname), 'uploads');

/**
 * 拼接附件物理路径并做越界校验（防 file_name 含 ../ 之类）。
 *
 * DB 中 file_name 形如 `collab/{rid}_xxx/123_456_a.xlsx`（相对 uploads 根的 POSIX 路径）。
 * 校验后返回的绝对路径，调用方可安全 fs.unlinkSync / fs.createReadStream。
 *
 * @param {string} file_name DB collab_attachments.file_name
 * @returns {string} 绝对路径
 * @throws {Error} INVALID_ATTACHMENT_PATH 越界 / 空
 */
function resolveAttachmentPath(file_name) {
    if (!file_name || typeof file_name !== 'string') {
        const e = new Error('INVALID_ATTACHMENT_PATH: file_name 为空');
        e.code = 'INVALID_ATTACHMENT_PATH';
        throw e;
    }
    const fullPath = path.resolve(UPLOAD_DIR_FOR_RESOLVE, file_name);
    // codex 24 审 #5：Windows 文件系统大小写不敏感（NTFS 默认），盘符或路径段大小写差异
    // 会让 startsWith 误判合法路径越界。Win32 下统一 toLowerCase 比较；POSIX 保持大小写敏感。
    const baseResolved = path.resolve(UPLOAD_DIR_FOR_RESOLVE) + path.sep;
    const isWin = process.platform === 'win32';
    const cmpFull = isWin ? fullPath.toLowerCase() : fullPath;
    const cmpBase = isWin ? baseResolved.toLowerCase() : baseResolved;
    if (!cmpFull.startsWith(cmpBase)) {
        const e = new Error(`INVALID_ATTACHMENT_PATH: 路径越界 ${file_name}`);
        e.code = 'INVALID_ATTACHMENT_PATH';
        throw e;
    }
    return fullPath;
}

/**
 * 软删除（作废）判断：v1.66.2 引入 archived_at NOT NULL 视为已作废。
 *
 * @param {object} collab collab_requests 行（含 archived_at 字段）
 * @returns {boolean}
 */
function isSoftArchived(collab) {
    return !!(collab && collab.archived_at);
}

/**
 * 终态归档判断：v1.67.1 引入 status='ARCHIVED' 视为完成归档锁定。
 *
 * 注意：与 isSoftArchived 完全独立 —— 软删除是"作废未上线"，归档是"完成后只读"。
 *
 * @param {object} collab collab_requests 行（含 status 字段）
 * @returns {boolean}
 */
function isFinalArchived(collab) {
    return !!(collab && collab.status === 'ARCHIVED');
}

// ============================================================================
// §0 全局 smoke test 互斥锁（codex 十一审 #1 critical 修正版）
// ============================================================================
//
// 实现要点（codex 十一审 #1）：
//   - 显式 locked 布尔 + waiters 数组（不是 Promise 链）
//   - 等待超时必须从 waiters 删除自己，不能调用任何 resolve（否则后续 waiter 会越过仍在执行的持锁者）
//   - release 时只唤醒"未超时"的下一个 waiter
//
// 不变量：
//   - locked === true ⇒ 当前确实有一个 smoke test 在跑
//   - waiters 中所有元素 acquired === false（已 acquired 的就已经 shift 出来了）
//
// ⚠️ cluster 兼容性（codex 十一审 #9）：
//   本锁仅在 PM2 单实例下有效。若未来启用 PM2 cluster 或多实例部署，
//   多个 Node 进程各自持有独立的 mutex 状态，会失去全局互斥语义，
//   需要改为数据库级锁（SQLite UPDATE WHERE 抢占 / 或外部 Redis 锁）。
//   D3 不实现 DB 级锁（4-5 用户内网 + PM2 单实例足够）。
const globalSmokeTestMutex = (() => {
    let locked = false;
    const waiters = [];  // [{ resolve, timer, acquired }]

    function acquire(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const node = { resolve, timer: null, acquired: false };
            if (!locked) {
                locked = true;
                node.acquired = true;
                return resolve(makeRelease(node));
            }
            // 排队
            waiters.push(node);
            node.timer = setTimeout(() => {
                if (node.acquired) return;  // 已被 release 唤醒了，无需处理
                // 从队列删除自己（不调用任何 resolve，不影响其他 waiter）
                const idx = waiters.indexOf(node);
                if (idx >= 0) waiters.splice(idx, 1);
                const e = new Error('SMOKE_MUTEX_WAIT_TIMEOUT');
                e.code = 'SMOKE_MUTEX_WAIT_TIMEOUT';
                reject(e);
            }, timeoutMs);
        });
    }

    function makeRelease(node) {
        let released = false;
        return function release() {
            if (released) return;  // 防重复 release
            released = true;
            // 找到下一个未超时的 waiter 唤醒
            while (waiters.length > 0) {
                const next = waiters.shift();
                if (next.acquired) {
                    // codex 十二审 #6：不变量被破坏的诊断分支
                    // waiters 中所有元素 acquired 应该都是 false（已 acquired 的会被 shift 移出）
                    // 命中说明状态机内部不变量被破坏，需要排查
                    console.warn('[collab-mutex] invariant violated: waiter.acquired=true while still in queue');
                    continue;
                }
                if (next.timer) clearTimeout(next.timer);
                next.acquired = true;
                // locked 维持 true，下一个 waiter 接力
                return next.resolve(makeRelease(next));
            }
            // 没有 waiter，释放锁
            locked = false;
        };
    }

    function _stats() {
        return { locked, waiters: waiters.length };
    }

    return { acquire, _stats };
})();

// ============================================================================
// §1 cleanupPendingFiles（codex C2）
// ============================================================================

/**
 * 清理 multer 已落盘但 endpoint 业务校验失败的临时文件。
 *
 * Express 中 multer 是 endpoint handler 前置中间件，文件已经写到 _pending/ 后才进入 handler。
 * 任何 4xx/5xx 提前返回路径都必须先调本函数清理，否则会留下垃圾文件甚至泄露提交内容。
 *
 * 清理失败仅 logger.warn，不抛错也不覆盖主错误（清理失败的概率低，不应阻塞主流程错误返回）。
 *
 * @param {Array<{path: string}>} files multer req.files 数组
 * @param {object} logger
 */
function cleanupPendingFiles(files, logger) {
    if (!Array.isArray(files) || files.length === 0) return;
    const log = logger || console;
    for (const f of files) {
        if (!f || typeof f.path !== 'string') continue;
        try {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        } catch (e) {
            log.warn(`[collab-submit] cleanup pending file failed: ${f.path} - ${e.message}`);
        }
    }
}

// ============================================================================
// §2 sanitizeSqlError（codex M3 — Claude 精简版）
// ============================================================================

/**
 * SQL Server 错误消息脱敏。
 *
 * codex 建议脱敏 server 名 / login / 路径 / stack；Claude 简化保留表名/列名/错误码（这正是开发要看的）。
 *
 * 脱敏目标（mssql 库 e.message 常见格式）：
 *   - 服务器/实例名：'... at server XYZ' / 'on server XYZ'
 *   - 登录名：'login XYZ' / 'login failed for user XYZ'
 *   - 路径：含驱动器盘符的 Windows 路径
 *   - stack trace 行（含 at /path/to/file.js:N:N）
 *
 * 保留：表名、列名、错误码（Msg XXX）、SQL Server 报错的核心句子
 *
 * @param {string|undefined} message 原始 e.message
 * @returns {string}
 */
function sanitizeSqlError(message) {
    if (!message) return '';
    let s = String(message);

    // 删 stack trace 风格行
    s = s.split('\n').filter(line => !/^\s*at\s+/.test(line)).join('\n');

    // 删服务器/实例名提示
    s = s.replace(/(\bat server\s+)\S+/gi, '$1[REDACTED]');
    s = s.replace(/(\bon server\s+)\S+/gi, '$1[REDACTED]');
    s = s.replace(/(\bserver\s*=\s*)\S+/gi, '$1[REDACTED]');

    // 删登录名提示
    // codex 十审 #10：第二条正则原写法 \blogin\s+['"]?\w+['"]? 会误匹配 'login failed'
    // 改为只精确匹配明显是登录名的形式：login 后接引号包裹的名字 / "login name=xxx" / "login user xxx"
    s = s.replace(/(\blogin failed for user\s+)\S+/gi, '$1[REDACTED]');
    s = s.replace(/(\blogin\s+)(['"])([^'"\s]+)\2/gi, '$1$2[REDACTED]$2');
    s = s.replace(/(\blogin\s+name\s*=\s*)\S+/gi, '$1[REDACTED]');
    s = s.replace(/(\blogin\s+user\s+)\S+/gi, '$1[REDACTED]');

    // 删 Windows 路径
    s = s.replace(/[A-Z]:\\[\\\S]+/gi, '[PATH_REDACTED]');

    // 截断到 500 字符（防止超长错误污染日志和前端）
    if (s.length > 500) s = s.slice(0, 500) + '...';

    return s.trim();
}

// ============================================================================
// §3 runRealSmokeTest（替换 D3-2 placeholderSmokeTest）
// ============================================================================

/**
 * 真 smoke test：读 result_script → sql-validator → 互斥锁 → 拿锁后写 running → 真连业务库执行。
 *
 * 设计对接 D3-2 collab-attachment-versioning.js 的 runSmokeTest 参数签名：
 *   async (scriptFinalPath) => { ok, validatedAt?, error? }
 *
 * v1.68.0 路由式多方言改造（2026-05-20）：
 *   ctx 加 dialect ('sqlserver' / 'mysql') + allowedDb（业务库名）；执行时按 dialect 分派 mssql / mysql2 API
 *
 * 本函数职责（codex 十一审 #1/#2/#3 联动落地）：
 *   1. 读 scriptFinalPath 文件内容（utf-8）
 *   2. validateAndTransform({dialect, allowedDb})（静态校验，不消耗互斥锁）
 *   3. 取 Mutex.acquire（5s 等不到 throw SMOKE_MUTEX_WAIT_TIMEOUT，由 endpoint 转 409）
 *   4. 拿锁后 UPDATE sql_validation_status='running' + validation_started_at=NOW（不变量：running 必伴随 validation_started_at IS NOT NULL）
 *   5. 按 dialect 真连业务库执行（mssql 20s 超时 / mysql2 connection-level timeout）
 *   6. 释放锁（finally 保证）
 *
 * @param {string} scriptFilePath  result_script 的物理路径
 * @param {object} pool            mssql ConnectionPool 或 mysql2 Pool（按 dialect）
 * @param {object} ctx             **必填** { requestId, oldVer, dbAsync: {runAsync}, logger, dialect, allowedDb }
 * @returns {Promise<{ok: true, validatedAt: Date, rowCount: number} | {ok: false, error: string, layer?: number}>}
 */
async function runRealSmokeTest(scriptFilePath, pool, ctx) {
    if (!ctx || typeof ctx !== 'object' || ctx.requestId == null
        || !ctx.dbAsync || typeof ctx.dbAsync.runAsync !== 'function') {
        throw new Error('runRealSmokeTest: ctx 必填且需含 requestId + dbAsync.runAsync（codex 十二审 #5）');
    }
    const { requestId, oldVer, dbAsync, logger } = ctx;
    const dialect = ctx.dialect || 'sqlserver';
    const allowedDb = ctx.allowedDb;
    const log = logger || console;

    // 1. 读文件
    let sqlText;
    try {
        sqlText = await fsp.readFile(scriptFilePath, 'utf-8');
    } catch (e) {
        const err = new Error(`无法读取 result_script 文件：${e.message}`);
        err.code = 'SCRIPT_READ_FAILED';
        throw err;
    }
    if (!sqlText || sqlText.trim().length === 0) {
        return { ok: false, error: 'result_script 文件为空', layer: 0 };
    }

    // 2. validator（静态校验，不消耗锁）—— 路由式多方言：dialect + allowedDb 必传
    const v = sqlValidator.validateAndTransform(sqlText, { dialect, allowedDb });
    if (!v.ok) {
        if (v.layer === 0 && v.reason && /lexer 内部错误/.test(v.reason)) {
            return { ok: false, error: 'SQL 形态不被支持，请改写', layer: 0 };
        }
        const errMsg = `[layer ${v.layer}] ${v.reason}` + (v.detail ? ` / ${v.detail}` : '');
        return { ok: false, error: errMsg, layer: v.layer };
    }

    // 3. 取 Mutex（5s 超时 → throw SMOKE_MUTEX_WAIT_TIMEOUT）
    const release = await globalSmokeTestMutex.acquire(5000);

    try {
        // 4. 拿锁后写 running + validation_started_at
        let upd;
        try {
            upd = await dbAsync.runAsync(
                `UPDATE collab_requests
                    SET sql_validation_status = 'running',
                        validation_started_at = datetime('now','localtime')
                  WHERE id = ?
                    AND submission_version = ?
                    AND status = 'SUBMITTED'
                    AND sql_validation_status = 'queued'`,
                [requestId, oldVer]
            );
        } catch (dbErr) {
            log.error(`[collab-submit] 写 running 状态 DB 异常 (req=${requestId}): ${dbErr.message}`);
            const e = new Error(`写 running 状态失败：${dbErr.message}`);
            e.code = 'RUNNING_UPDATE_FAILED';
            throw e;
        }
        if (!upd || upd.changes === 0) {
            log.warn(`[collab-submit] 写 running 状态 0 行影响 (req=${requestId}, oldVer=${oldVer})——状态已被其他流程改动`);
            const e = new Error('协作单状态已被其他流程改动，请刷新后重试');
            e.code = 'RUNNING_UPDATE_STALE';
            throw e;
        }

        // 5. 按 dialect 分派真连业务库（v1.68.0）
        if (dialect === 'sqlserver') {
            const request = pool.request();
            request.timeout = 20000;
            try {
                const result = await request.query(v.smokeSql);
                return {
                    ok: true,
                    validatedAt: new Date(),
                    rowCount: result.recordset ? result.recordset.length : 0,
                };
            } catch (e) {
                const sanitized = sanitizeSqlError(e.message);
                log.info(`[collab-submit] smoke test SQL Server 报错: ${sanitized}`);
                return {
                    ok: false,
                    error: `SQL Server: ${sanitized}`,
                    sqlServerCode: e.code || null,
                };
            }
        } else if (dialect === 'mysql') {
            // mysql2/promise pool：用 query + timeout 选项实现 20s 限制
            // 注：mysql2 timeout 是 connection 级别的，超时会抛 PROTOCOL_SEQUENCE_TIMEOUT
            try {
                const [rows] = await pool.query({ sql: v.smokeSql, timeout: 20000 });
                return {
                    ok: true,
                    validatedAt: new Date(),
                    rowCount: Array.isArray(rows) ? rows.length : 0,
                };
            } catch (e) {
                const sanitized = sanitizeSqlError(e.message);
                log.info(`[collab-submit] smoke test MySQL 报错: ${sanitized}`);
                return {
                    ok: false,
                    error: `MySQL: ${sanitized}`,
                    mysqlCode: e.code || null,
                };
            }
        } else {
            return { ok: false, error: `不支持的方言：${dialect}` };
        }
    } finally {
        // 6. 一定释放锁（即使报错）
        try { release(); } catch (e) { log.warn(`[collab-submit] release mutex error: ${e.message}`); }
    }
}

// ============================================================================
// §4 文件分类（按扩展名推断 attachment_type）
// ============================================================================

const RESULT_DATA_EXTS = new Set(['.xlsx', '.xls']);
const RESULT_SCRIPT_EXTS = new Set(['.sql', '.txt']);

/**
 * 安全展示文件名（codex 十审 #11）：
 *   - 取 basename（去掉路径分隔符，防 ../ 之类）
 *   - 去控制字符（替换为 _）
 *   - 截断到 80 字符
 *
 * 用于错误消息和日志中回显，**不影响落盘命名**（落盘文件名由 multer 服务端生成）。
 */
function safeDisplayName(originalname) {
    if (!originalname) return '<unnamed>';
    let s = String(originalname);
    // 取 basename（兼容 / \ : 三种分隔符，Windows 盘符路径 C:foo.xlsx 也能正确剥离）
    s = s.replace(/^.*[\\/:]/, '');
    // 去控制字符
    s = s.replace(/[\x00-\x1F\x7F]/g, '_');
    // 截断
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s || '<unnamed>';
}

/**
 * 按扩展名分类 multer 上传的文件。
 *
 * 期望恰好 2 个文件：一个 result_data 一个 result_script。
 *
 * @param {Array<{originalname, path, size}>} files multer req.files
 * @returns {{ ok: true, result_data, result_script } | { ok: false, reason: string }}
 */
function classifyUploadedFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
        return { ok: false, reason: '未上传任何文件' };
    }
    if (files.length !== 2) {
        return { ok: false, reason: `必须恰好上传 2 个文件（result_data + result_script），实际 ${files.length} 个` };
    }
    let result_data = null;
    let result_script = null;
    for (const f of files) {
        const safeName = safeDisplayName(f.originalname);
        if (!f.size || f.size === 0) {
            return { ok: false, reason: `文件 ${safeName} 为空（大小 0 字节）` };
        }
        const ext = path.extname(f.originalname || '').toLowerCase();
        if (RESULT_DATA_EXTS.has(ext)) {
            if (result_data) return { ok: false, reason: '检测到多个 result_data 类型文件（xlsx/xls），仅允许 1 个' };
            result_data = f;
        } else if (RESULT_SCRIPT_EXTS.has(ext)) {
            if (result_script) return { ok: false, reason: '检测到多个 result_script 类型文件（sql/txt），仅允许 1 个' };
            result_script = f;
        } else {
            return { ok: false, reason: `文件 ${safeName} 扩展名 ${ext} 不在允许列表（xlsx/xls/sql/txt）` };
        }
    }
    if (!result_data) return { ok: false, reason: '缺少 result_data 文件（需要 xlsx 或 xls）' };
    if (!result_script) return { ok: false, reason: '缺少 result_script 文件（需要 sql 或 txt）' };
    return { ok: true, result_data, result_script };
}

// ============================================================================
// 导出
// ============================================================================

/**
 * v1.71.0 三级转发：附件按人锁前置闸门。
 *
 * 业务规则（v0.1 决策点 B1+B2+B3 拍板）：
 *   - 按 uploaded_by 精确匹配（不按角色 / 不按 reqUser.role 与上传角色配对）
 *   - admin 可越权操作（不区分上传 admin 个体）
 *   - 非 admin 仅本人可操作自己上传的附件
 *
 * @param {object} attachment - { id, uploaded_by }，uploaded_by 必须为 number
 * @param {object} reqUser    - { id, role }
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
function checkAttachmentOwnerOrAdmin(attachment, reqUser) {
    if (!attachment || typeof attachment.uploaded_by !== 'number') {
        return { ok: false, reason: '附件信息缺失或 uploaded_by 异常', code: 'ATTACHMENT_INVALID' };
    }
    if (!reqUser || typeof reqUser.id !== 'number') {
        return { ok: false, reason: '请求用户信息缺失', code: 'REQ_USER_INVALID' };
    }
    if (reqUser.role === 'admin') {
        return { ok: true };
    }
    if (attachment.uploaded_by === reqUser.id) {
        return { ok: true };
    }
    return { ok: false, reason: '只有上传人本人或 admin 可操作此附件', code: 'ATTACHMENT_OWNER_LOCKED' };
}

module.exports = {
    cleanupPendingFiles,
    sanitizeSqlError,
    runRealSmokeTest,
    classifyUploadedFiles,
    safeDisplayName,
    // v1.70.0 抽取（方案 §1.2.6）
    resolveAttachmentPath,
    isSoftArchived,
    isFinalArchived,
    // v1.71.0 三级转发：附件按人锁前置闸门
    checkAttachmentOwnerOrAdmin,
    // 暴露给测试和监控（生产代码不应直接 acquire/release，统一走 runRealSmokeTest 包装）
    _globalSmokeTestMutex: globalSmokeTestMutex,
};
