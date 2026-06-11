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
// 取数交付质量记录 v3.0 Commit C2：列对齐写入依赖 B 的两个纯 helper
const { readXlsxHeader } = require('./xlsx-header-reader');
const { compareColumns } = require('./column-alignment-checker');

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
 * @returns {Promise<{ok: true, validatedAt: Date, rowCount: number, columns: string[]} | {ok: false, error: string, layer?: number}>}
 *   columns（取数质量 v3.0 Commit C1）：SQL 结果列名数组（列对齐用）。
 *     - **向后兼容**：只新增 columns 字段，不改 ok/rowCount/error/validatedAt 现有字段语义。
 *     - 来自结果集元数据（非首行数据）→ 零行查询也有列名（探针实证 TDS COLMETADATA 先于 ROW token）。
 *     - 列名提取失败（理论不会，防御性）→ columns=[]，不影响 smoke 成功。
 */

/**
 * 从 SQL 查询结果提取列名（取数质量 v3.0 Commit C1，列对齐用）。
 *   - SQL Server（mssql）：result.recordset.columns 是对象 { 列名: {index,name,...} }，来自 COLMETADATA 元数据，零行也有。
 *   - MySQL（mysql2）：pool.query 返回 [rows, fields]，fields[].name 是列名，零行也有。
 *
 *   ⚠️ 列顺序（codex 70 H-1，真实业务库实证）：mssql columns 是对象，Object.keys 对**整数样式列名**
 *      （如别名 [0]/[1]/[2024]）会被 JS 强制升序排序，丢失 SELECT 顺序。故**必须按 meta.index 排序**
 *      还原 SELECT 列顺序，不能直接用 Object.keys 顺序。
 *   ⚠️ 重复列名（codex 70 H-2，真实业务库实证）：mssql columns 以列名为 key，**天然无法保留重复列名**
 *      （SELECT 'x' AS dup,'y' AS dup → columns 只剩 1 个 dup）。本函数**不支持重复列名**，重复会丢。
 *      对列对齐口径无害：compareColumns 用 Set 比对（T⊆S）本就去重，重复列不影响"模板列是否都在"判定。
 *   单结果集前提（codex 70 M-1，已核实）：sql-validator 只放行单 SELECT/WITH（首关键字白名单
 *     + 多分号拒绝 + 返回 array 多语句拒绝，见 sql-validator.js:507/514），故只有一个结果集，
 *     columns 对应唯一结果集，不存在"多结果集 columns 只对应第一组"的歧义。
 *   - 防御性：任何异常 → 返回 []（列名提取不该影响 smoke 成功判定，codex 67 硬约束 #9）。
 *     mysql2 在 CALL/非 SELECT/多结果集场景 fields 可能 undefined/嵌套 → 返回 []（旁路降级，
 *     C2 消费侧区分 []=无列/降级，不判 smoke 失败，codex 70 L-1）。validator 已禁这些场景，纯防御。
 *
 * @param {string} dialect 'sqlserver' / 'mysql'
 * @param {object} mssqlResult mssql request.query 的返回（含 recordset）
 * @param {Array} mysqlFields  mysql2 query 返回的 fields 数组
 * @returns {string[]} 列名数组（按 SELECT 顺序；提取失败返回 []）
 */
function extractResultColumns(dialect, mssqlResult, mysqlFields) {
    try {
        if (dialect === 'sqlserver') {
            const cols = mssqlResult && mssqlResult.recordset && mssqlResult.recordset.columns;
            if (!cols || typeof cols !== 'object') return [];
            // H-1（codex 70）+ 稳定降级（codex 71 M-1）：按 meta.index 排序还原 SELECT 顺序
            //   （Object.keys 对整数样式列名会强制升序乱序）。**真正的稳定降级**：
            //   - 有效 index（Number.isInteger && >=0）→ 按 index 排
            //   - 个别列缺/非法 index → 该列用原始枚举位置兜底（不整体回退，避免部分缺失就退回 Object.keys 乱序）
            //   - tie-breaker：index 相同/都缺时按原始枚举序，保证稳定（Array.sort 在 V8 是稳定的，
            //     但显式用 origPos 兜底不依赖引擎稳定性，更稳）。
            const keys = Object.keys(cols);
            const origPos = new Map(keys.map((k, i) => [k, i]));
            const sortKey = (k) => {
                const idx = cols[k] && cols[k].index;
                return Number.isInteger(idx) && idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
            };
            const ordered = keys.slice().sort((a, b) => {
                const d = sortKey(a) - sortKey(b);
                return d !== 0 ? d : origPos.get(a) - origPos.get(b);  // tie-breaker：原始枚举序
            });
            return ordered.map(key => {
                const meta = cols[key];
                return (meta && typeof meta.name === 'string' && meta.name.length > 0) ? meta.name : key;
            });
        }
        if (dialect === 'mysql') {
            if (!Array.isArray(mysqlFields)) return [];
            return mysqlFields
                .map(f => (f && typeof f.name === 'string') ? f.name : null)
                .filter(name => name != null);
        }
        return [];
    } catch (e) {
        return [];  // 列名提取失败不影响 smoke 成功
    }
}

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
                    // C1：列名来自 recordset.columns 元数据（零行也有），列对齐用；提取失败不影响 smoke
                    columns: extractResultColumns('sqlserver', result, null),
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
                // C1：解构 fields（列元数据，零行也有），列对齐用。原代码只取 rows 丢了 fields。
                const [rows, fields] = await pool.query({ sql: v.smokeSql, timeout: 20000 });
                return {
                    ok: true,
                    validatedAt: new Date(),
                    rowCount: Array.isArray(rows) ? rows.length : 0,
                    columns: extractResultColumns('mysql', null, fields),
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

// ============================================================================
// §5 取数交付质量记录 v3.0 — Commit C2：submit-export 后列对齐写入（旁路）
// ============================================================================
//
// 设计来源：docs/local/数据协作模块_v3.0/取数交付质量记录_方案_20260605_v3.0.md
//           + 开发计划 v0.2 C2 硬约束 7 条 + codex 72 取舍审（spec-critique）9 issue 全落地。
//
// 定位（"管事不管人" + "列对齐不是闸门"）：
//   smoke test 是唯一放行闸门；列对齐只做"当场提示 + 背后留痕"，**绝不阻断/回滚 submit-export 主流程**。
//   本函数在 submit-export 主事务（activateNewVersion 内部事务）commit 成功后被旁路调用。
//
// 异常铁律（codex 72 H-2）：整个函数自包 try/catch，**永远返回结构完整的结果对象**（含失败态），
//   调用方（endpoint）无脑取字段映射进响应，从根上杜绝"未保护变量参与 res.json 致主流程已 DONE 却 HTTP 500"。
//   任何内部异常只 warn + 写 operation_log（best-effort），不向上抛。
//
// 字段口径：
//   - submitted_at（codex 72 H-1）：用"本次提交时间"——INSERT 时 SQL 内联 datetime('now','localtime')，
//     与表内其他时间字段（created_at 等）同源（避免 JS 时区与 SQLite 不一致）。
//     不用 collab.submitted_at（首次提交时间，DONE 重传会让多条记录共享同一时间致时序失真）。
//   - submission_seq：= activateResult.newVer（每次提交版本 +1，幂等键也用它）。
//   - is_columns_complete 三态（codex 69 M-4）：1=列齐全 / 0=缺列 / NULL=未比对（无模板/非xlsx模板/读取失败）。
//   - missing_columns（codex 72 L-1）：永远是 JSON 数组（齐全 [] / 缺列 [...]）；未比对存 NULL。
//   - expected/actual_columns_snapshot（L-1）：JSON 数组；无法获取存 NULL（非字符串 '[]'）。
//
// 未比对原因区分（codex 72 M-1）：reason ∈ OK / MISSING_COLUMNS / NO_TEMPLATE / NON_XLSX_TEMPLATE /
//   XLSX_READ_FAILED / SKIPPED_EXISTING / C2_FAILED，写 operation_log + 回响应供前端提醒（方案乙）。
//   （注：源头另有 E 阶段"模板上传时校验弹窗"防线，本函数是兜底留痕。）
//
// 幂等（codex 72 M-3）：INSERT OR IGNORE + changes 检查，唯一索引冲突时 changes=0 → reason=SKIPPED_EXISTING，
//   不刷错误日志（比 SELECT 查重 + 普通 INSERT 更短更稳，不依赖错误消息文本匹配）。
//
// 不做（codex 72 M-6）：单/多产出一致性检查本期不做（sub_item 恒 NULL 时该检查永真是空跑死代码），
//   多产出上线再加（开发计划 v0.2 硬约束 4 已记在案）。

// 可读出表头的模板扩展名（example_xlsx 字段允许 pdf/docx/png 等，仅这两类能列对齐）
//   codex 76 L-2：含 .xls 是有意的——SheetJS（XLSX.readFile）原生支持旧 .xls 格式（多格式库），
//   readXlsxHeader 函数名是历史命名（B 选 SheetJS 不引 exceljs），实际 .xls/.xlsx 都能读表头。
const COLUMN_ALIGN_READABLE_EXTS = new Set(['.xlsx', '.xls']);

/**
 * submit-export 主事务成功后，旁路记录取数交付质量（列对齐）。
 *
 * @param {object} ctx
 *   @param {object}  ctx.dbAsync        { runAsync, getAsync }（sqlite 异步封装）
 *   @param {number}  ctx.requestId      协作单 id
 *   @param {number}  ctx.submitterId    本次提交开发的 user id（endpoint 的 req.user.id，非 exporter）
 *   @param {string}  ctx.submitterName  本次提交开发名
 *   @param {number}  ctx.submissionSeq  本次提交序号（= activateResult.newVer）
 *   @param {string[]} ctx.smokeColumns  SQL 结果列名（activateResult.smokeTestResult.columns；可能 [] 或 undefined）
 *   @param {function} [ctx.insertLog]   写 operation_log 的函数 (requestId, opType, operatorId, operator, reason)；可选。
 *       ⚠️ 契约（codex 73 M-1）：**必须同步触发、不返回 Promise、自身不抛**（如 server 的 insertCollabLog =
 *       db.run + 回调吞错）。tryInsertQualityLog 只捕同步异常；若未来改成 async/返回 Promise，
 *       其 rejection 不会被兜住，会破坏本函数"永不影响主流程"的 H-2 铁律——改造时必须同步改 tryInsertQualityLog。
 *   @param {object}  [ctx.logger]       日志器，默认 console
 * @returns {Promise<{recorded:boolean, is_columns_complete:(1|0|null), missing_columns:string[], reason:string}>}
 *   **永不抛**。recorded=是否成功写入一行 quality_record；reason 见上枚举。
 *   ⚠️ 响应字段口径（codex 73 M-2）：**missing_columns 始终是数组**（齐全 [] / 缺列 [...] / 未比对 []）——
 *      与 DB 字段不同（DB 未比对存 NULL，便于统计区分；响应保持数组便于前端 .map 渲染不判空）。
 *      **前端判"未比对"必须看 is_columns_complete===null 或 reason（NO_TEMPLATE/NON_XLSX_TEMPLATE/
 *      XLSX_READ_FAILED/C2_FAILED），不能只看 missing_columns.length===0**（那会把"未比对"误判成"列齐全"）。
 */
async function recordQualityOnSubmit(ctx) {
    const log = (ctx && ctx.logger) || console;
    // 兜底默认返回（任何早退/异常都给结构完整对象，H-2）
    const fail = (reason, isComplete = null, missing = []) => ({
        recorded: false,
        is_columns_complete: isComplete,
        missing_columns: missing,
        reason,
    });

    try {
        const { dbAsync, requestId, submitterId, submitterName, submissionSeq } = ctx;
        if (!dbAsync || typeof dbAsync.runAsync !== 'function' || typeof dbAsync.getAsync !== 'function') {
            log.warn('[collab-quality] recordQualityOnSubmit: dbAsync 缺失，跳过质量记录');
            return fail('C2_FAILED');
        }

        // smokeColumns 防御：C1 透传可能 undefined / 非数组 → 视为 [] 空列（columns 多义，codex 71 M-2）
        const sqlCols = Array.isArray(ctx.smokeColumns) ? ctx.smokeColumns : [];

        // 1. 查最新 active example_xlsx 模板（codex 72 M-2：稳定排序取最新）
        const tpl = await dbAsync.getAsync(
            `SELECT id, file_name, original_name FROM collab_attachments
              WHERE collab_request_id = ?
                AND attachment_type = 'example_xlsx'
                AND (status = 'active' OR status IS NULL)
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [requestId]
        );

        // 2. 据模板形态决定 T（需求列）与 is_columns_complete 三态
        let isComplete;        // 1 / 0 / null
        let missing = [];      // 纯数组（L-1）
        let expectedSnapshot = null;  // JSON 数组或 null（L-1）
        let reason;

        if (!tpl) {
            // 无模板：未比对（codex 72 M-1 区分来源）
            isComplete = null;
            reason = 'NO_TEMPLATE';
        } else {
            const ext = path.extname(tpl.original_name || tpl.file_name || '').toLowerCase();
            if (!COLUMN_ALIGN_READABLE_EXTS.has(ext)) {
                // 非 xlsx 模板（admin 有意传 pdf/png 等）：未比对
                isComplete = null;
                reason = 'NON_XLSX_TEMPLATE';
            } else {
                // xlsx/xls 模板：试读表头
                let templateCols;
                try {
                    const abs = resolveAttachmentPath(tpl.file_name);
                    const { header } = readXlsxHeader(abs);  // 抛 XLSX_READ_FAILED
                    templateCols = header;
                } catch (e) {
                    // 读取/解析失败：未比对（codex 69 M-4 不当齐全）
                    //   归类取舍（codex 73 L-1）：resolveAttachmentPath 抛 INVALID_ATTACHMENT_PATH（路径越界，
                    //   内网几乎不发生——file_name 由系统生成非用户输入）也统一归 XLSX_READ_FAILED，
                    //   不为极罕见 case 扩第八态枚举；但 log.warn 保留 e.code 让排查时能区分路径越界 vs xlsx 解析失败。
                    isComplete = null;
                    reason = 'XLSX_READ_FAILED';
                    log.warn(`[collab-quality] req=${requestId} 模板读取失败(${e.code || 'ERR'})，写未比对：${e.message}`);
                    templateCols = undefined;
                }
                if (templateCols !== undefined) {
                    // 正常比对（T ⊆ S）
                    const cmp = compareColumns(templateCols, sqlCols);
                    isComplete = cmp.complete ? 1 : 0;
                    missing = cmp.missing;  // 纯数组
                    expectedSnapshot = JSON.stringify(templateCols);
                    reason = cmp.complete ? 'OK' : 'MISSING_COLUMNS';
                }
            }
        }

        // 3. snapshot（L-1）：actual 始终可取（sqlCols 数组）；expected 仅正常比对时有
        const actualSnapshot = JSON.stringify(sqlCols);
        const missingJson = isComplete === null ? null : JSON.stringify(missing);

        // 4. INSERT OR IGNORE 幂等（codex 72 M-3）：唯一索引冲突 changes=0 → SKIPPED_EXISTING
        //    单产出 collab_sub_item_id 恒 NULL → 命中 idx_qr_unique_single(request_id, submission_seq)
        let insres;
        try {
            insres = await dbAsync.runAsync(
                `INSERT OR IGNORE INTO collab_quality_record
                    (collab_request_id, collab_sub_item_id, submitter_id, submitter_name,
                     submission_seq, submitted_at, missing_columns, is_columns_complete,
                     expected_columns_snapshot, actual_columns_snapshot, sql_attachment_id)
                 VALUES (?, NULL, ?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, NULL)`,
                [requestId, submitterId, submitterName, submissionSeq,
                 missingJson, isComplete, expectedSnapshot, actualSnapshot]
            );
        } catch (e) {
            log.warn(`[collab-quality] req=${requestId} INSERT 异常（不阻断主流程）：${e.message}`);
            // 写一笔 operation_log 便于追溯（best-effort）
            tryInsertQualityLog(ctx, requestId, submitterId, submitterName, `C2_FAILED:${e.message}`, log);
            return fail('C2_FAILED', isComplete, missing);
        }

        const recorded = !!(insres && insres.changes > 0);
        if (!recorded) {
            // 幂等命中（同 request+seq 已有记录，重复提交/重复点击）
            //   语义固化（codex 73 L-2）：SKIPPED_EXISTING 时返回的 is_columns_complete/missing_columns
            //   是**本次重算结果**，非 DB 已留痕记录的结果。本平台同一次提交的重试间隔是毫秒级、模板不可变，
            //   故两者必然一致；且 recorded=false 时前端本就忽略列对齐结果（无新增留痕）。不为此加一次
            //   SELECT 读已有记录（内网过度设计）——recorded=false 已充分表达"未新增"。
            reason = 'SKIPPED_EXISTING';
            log.info(`[collab-quality] req=${requestId} seq=${submissionSeq} 已存在质量记录，幂等跳过`);
        }

        // 5. operation_log 留痕（codex 72 M-1：区分未比对来源 + 记结果）
        tryInsertQualityLog(ctx, requestId, submitterId, submitterName,
            `quality:${reason}/complete=${isComplete === null ? 'NULL' : isComplete}/missing=${missing.length}`, log);

        return {
            recorded,
            is_columns_complete: isComplete,
            missing_columns: missing,
            reason,
        };
    } catch (e) {
        // 顶层兜底（H-2）：任何漏网异常都不阻断主流程
        log.warn(`[collab-quality] recordQualityOnSubmit 顶层异常（已隔离，不阻断 submit）：${e.message}`);
        return fail('C2_FAILED');
    }
}

/**
 * best-effort 写质量相关 operation_log（不阻断、不抛）。
 * 用 ctx.insertLog（若提供）；没有则静默跳过（operation_log 是辅助留痕，缺它不影响列对齐主功能）。
 *
 * ⚠️ H-2 契约（codex 73 M-1）：本函数只用 try/catch 兜**同步**异常。ctx.insertLog 必须是同步
 *   fire-and-forget（不返回 Promise、自身不抛）——server 的 insertCollabLog 即 db.run+回调吞错，符合契约。
 *   若未来把 insertCollabLog 改成 async/返回 Promise，其 rejection 不会被这里兜住，会破坏
 *   recordQualityOnSubmit"永不影响主流程"的 H-2 铁律。改造方必须同步把本函数改 async + await + .catch()。
 */
function tryInsertQualityLog(ctx, requestId, operatorId, operator, reason, log) {
    try {
        if (ctx && typeof ctx.insertLog === 'function') {
            ctx.insertLog(requestId, 'QUALITY_RECORD', operatorId, operator, reason);
        }
    } catch (e) {
        (log || console).warn(`[collab-quality] 写 operation_log 失败（忽略）：${e.message}`);
    }
}

// ============================================================================
// §6 取数交付质量记录 v3.0 — Commit D：退回开发最小状态转换骨架（公共函数）
// ============================================================================
//
// 设计来源：开发计划 v0.2 Commit D（H-3 铁律 + codex 72 取舍审延续）+ 用户拍板"只抽事务骨架"。
//
// 抽取动机（H-3）：现有 return-to-dev（三级转发 EXPORTING→PENDING by exporter）与新 return-quality
//   （打回 SUBMITTED→PENDING by contact_person）共享"改 status→PENDING + 条件 UPDATE 乐观锁 + 同事务"
//   这一最小骨架；但**权限 / 源状态 / 是否碰 exporter 字段 / 是否写 return_record 全不同**。
//   故只抽事务骨架，**不套整个 endpoint**（H-3 铁律：复用旧逻辑前抽公共函数，不套用旧 endpoint）。
//   return-to-dev 暂不重构（避免动已上线代码）；本函数仅给 return-quality 用，未来可渐进收敛。
//
// 边界（用户拍板"只抽事务骨架"）：
//   - 本函数只管：BEGIN IMMEDIATE → 条件 UPDATE status=PENDING（WHERE 带源状态 + 调用方 extraGuards 乐观锁）
//     → changes 检查（0 则 ROLLBACK 返 stale）→ extraWrites 回调（同事务内插 return_record + log）→ COMMIT。
//   - 不管：权限校验 / reason 枚举校验 / 钉钉通知（都在调用方 endpoint 做，事务外）。
//   - extraWrites 在 UPDATE 成功（changes>0）后、COMMIT 前调用，让调用方在**同一事务**内插自己的差异化记录；
//     extraWrites 抛错 → 整个事务 ROLLBACK（状态更新 + return_record 原子，M-4）。

/**
 * 退回开发最小状态转换骨架（X → PENDING，同事务 + 乐观锁）。
 *
 * @param {object} dbAsync         { runAsync }（runAsync(sql, params) → this 含 changes）
 * @param {object} opts
 *   @param {number}   opts.requestId      协作单 id
 *   @param {string}   opts.fromStatus     允许的源状态（如 'SUBMITTED'）——UPDATE WHERE 收紧到该状态
 *   @param {Array}    [opts.extraGuards]  额外 WHERE 守卫，按顺序 AND 拼接。两种形态：
 *                                          - 带占位符：{ sql: 'submission_version = ?', value: 3 }（value 入参）
 *                                          - 无占位符：{ sql: 'archived_at IS NULL' }（value 省略/undefined，不入参）
 *                                          ⚠️ sql 含 '?' 的必须给 value；不含 '?' 的必须不给 value（防参数错位）
 *   @param {function} [opts.extraWrites]  async (dbAsync) => {}：UPDATE 成功后、COMMIT 前在同事务内执行
 *                                          （插 return_record + operation_log）；抛错则整事务 ROLLBACK
 *   @param {string[]} [opts.clearFields]  额外随 status 一起置 NULL 的字段（codex 76 H-1 衍生）。
 *                                          DONE→PENDING 场景需清 done_at/sql_validated_at 等已完成痕迹，避免详情页
 *                                          "PENDING 状态却残留旧完成时间"的矛盾。**字段名白名单校验防注入**（仅允许
 *                                          已知列名），调用方传 ['done_at','sql_validated_at']。
 * @returns {Promise<{ok:boolean, code?:string, changes?:number}>}
 *   ok=true 转换成功；ok=false + code='STALE_STATE'（changes=0，状态已变/并发）；
 *   抛错仅在 BEGIN/COMMIT/extraWrites 异常时（调用方 catch 返 500）——此时已 ROLLBACK。
 */
// clearFields 白名单（防 SQL 注入：字段名不参数化，只能用受控白名单）
const TRANSITION_CLEARABLE_FIELDS = new Set([
    'done_at', 'sql_validated_at', 'sql_validation_status', 'sql_validation_error',
]);
async function transitionToDevPending(dbAsync, opts) {
    const { requestId, fromStatus, extraGuards = [], extraWrites, clearFields = [] } = opts;
    if (!dbAsync || typeof dbAsync.runAsync !== 'function') {
        const e = new Error('transitionToDevPending: dbAsync.runAsync 必填');
        e.code = 'INVALID_DB';
        throw e;
    }
    // 入参 fail-fast（codex 74 L-1：函数已导出，未来复用时尽早暴露开发错误，不拼出无效 WHERE）
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
        const e = new Error('transitionToDevPending: requestId 必须是安全正整数');
        e.code = 'INVALID_REQUEST_ID';
        throw e;
    }
    if (!fromStatus || typeof fromStatus !== 'string') {
        const e = new Error('transitionToDevPending: fromStatus 必须是非空字符串');
        e.code = 'INVALID_FROM_STATUS';
        throw e;
    }

    // 拼 WHERE：固定 id + 源状态，再 AND 上调用方守卫（乐观锁 / archived 双轨等）
    //   守卫两形态：带占位符（sql 含 '?' → push value）/ 无占位符（sql 如 'archived_at IS NULL' → 不 push）。
    //   按 sql 是否含 '?' 决定是否入参，防 IS NULL 类守卫 push undefined 造成参数错位（自检 bug 修复）。
    let where = 'id = ? AND status = ?';
    const params = [requestId, fromStatus];
    for (const g of extraGuards) {
        // 守卫结构 fail-fast（codex 74 L-1/M-2）
        if (!g || !g.sql || typeof g.sql !== 'string') {
            const e = new Error('transitionToDevPending: extraGuard.sql 必须是非空字符串');
            e.code = 'INVALID_GUARD';
            throw e;
        }
        const hasPlaceholder = g.sql.includes('?');
        const hasValue = Object.prototype.hasOwnProperty.call(g, 'value') && g.value !== undefined;
        // 参数形态 fail-fast（codex 74 M-2）：含 ? 必给 value / 不含 ? 不应给 value
        //   防未来复用漏传 value → SQLite 按 NULL 绑定 → 伪装成 changes=0 并发冲突（实为开发错误）
        if (hasPlaceholder && !hasValue) {
            const e = new Error(`transitionToDevPending: 守卫 "${g.sql}" 含占位符但未提供 value`);
            e.code = 'INVALID_GUARD_PARAM';
            throw e;
        }
        if (!hasPlaceholder && hasValue) {
            const e = new Error(`transitionToDevPending: 守卫 "${g.sql}" 不含占位符却提供了 value（会被静默忽略）`);
            e.code = 'INVALID_GUARD_PARAM';
            throw e;
        }
        where += ` AND ${g.sql}`;
        if (hasPlaceholder) {
            params.push(g.value);
        }
    }

    // 额外清空字段（codex 76 H-1 衍生）：白名单校验防注入，拼进 SET
    let clearSql = '';
    for (const f of clearFields) {
        if (!TRANSITION_CLEARABLE_FIELDS.has(f)) {
            const e = new Error(`transitionToDevPending: clearField "${f}" 不在白名单`);
            e.code = 'INVALID_CLEAR_FIELD';
            throw e;
        }
        clearSql += `, ${f} = NULL`;
    }

    await dbAsync.runAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        const upd = await dbAsync.runAsync(
            `UPDATE collab_requests SET status = 'PENDING'${clearSql} WHERE ${where}`,
            params
        );
        if (!upd || upd.changes === 0) {
            await dbAsync.runAsync('ROLLBACK');
            return { ok: false, code: 'STALE_STATE', changes: 0 };
        }
        // 同事务内插差异化记录（return_record + log），抛错则下方 catch ROLLBACK
        if (typeof extraWrites === 'function') {
            await extraWrites(dbAsync);
        }
        await dbAsync.runAsync('COMMIT');
        return { ok: true, changes: upd.changes };
    } catch (e) {
        try { await dbAsync.runAsync('ROLLBACK'); } catch { /* ignore rollback err */ }
        throw e;  // 调用方 catch 返 500（事务已回滚，状态/记录原子一致）
    }
}

// ============================================================================
// §7 取数交付质量记录 v3.0 — Commit E：模板上传时列对齐可读性预检（源头防线）
// ============================================================================
//
// 设计来源：开发计划 v0.2 Commit E（2026-06-08 用户拍板新增）+ C2 取舍审 M-1 延伸。
//   admin 上传 example_xlsx 时预检"该模板能否用于列对齐"，坏模板**当场提示不拦断**
//   （贴"列对齐不是闸门"——admin 可有意传 pdf/说明性模板）。与 C2 旁路三态留痕互补两道防线。
//
// 无抛出的 best-effort 只读 helper（codex 75 L-3：非纯函数——会解析路径 + 读 xlsx 文件，
//   有只读 I/O 副作用但不写入/不阻断）：永不抛，返回 warning 对象供 endpoint 带进响应。

/**
 * 预检 example_xlsx 模板能否用于列对齐（读出表头）。**永不抛**（best-effort，不阻断上传）。
 *
 * @param {string} fileName      DB collab_attachments.file_name（相对 uploads 的 POSIX 路径）
 * @param {string} originalName  原始文件名（取扩展名判断）
 * @returns {{ ok:boolean, reason:string, header_preview:string[] }}
 *   ok=true  → 模板可用于列对齐（reason='OK'，header_preview 给前几列表头预览）
 *   ok=false → 不可用：reason ∈ NON_XLSX（非 xlsx 扩展名，admin 有意传，前端可弱提示或不提示）
 *                       / EMPTY_HEADER（xlsx 但第一行无表头）/ READ_FAILED（解析失败/文件损坏）
 */
function checkTemplateReadable(fileName, originalName) {
    try {
        const ext = path.extname(originalName || fileName || '').toLowerCase();
        if (!COLUMN_ALIGN_READABLE_EXTS.has(ext)) {
            return { ok: false, reason: 'NON_XLSX', header_preview: [] };
        }
        let abs;
        try {
            abs = resolveAttachmentPath(fileName);
        } catch (e) {
            return { ok: false, reason: 'READ_FAILED', header_preview: [] };
        }
        let header;
        try {
            const r = readXlsxHeader(abs);  // 抛 XLSX_READ_FAILED
            header = r.header;
        } catch (e) {
            return { ok: false, reason: 'READ_FAILED', header_preview: [] };
        }
        // 过滤空列名后判断是否有有效表头
        const nonEmpty = Array.isArray(header)
            ? header.filter(h => h != null && String(h).trim() !== '')
            : [];
        if (nonEmpty.length === 0) {
            return { ok: false, reason: 'EMPTY_HEADER', header_preview: [] };
        }
        return { ok: true, reason: 'OK', header_preview: nonEmpty.slice(0, 8).map(h => String(h)) };
    } catch (e) {
        // 顶层兜底：预检失败不影响上传，按"读取失败"返回（不阻断）
        return { ok: false, reason: 'READ_FAILED', header_preview: [] };
    }
}

/**
 * 详情页质量汇总（Commit E，口径集中后端一处，用户拍板）。纯函数。
 *   - 交付时长（M-7）：起点 contact_read_at；终点三级 fallback = archived_final_at（完成归档）> done_at（验收完成）> submitted_at（提交兜底）。
 *     ⚠️ codex 76 M-1：用 archived_final_at（完成归档）不是 archived_at（archived_at 是软删除/作废，作废≠完成）。
 *     ⚠️ codex 77 复审 M-1：done_at（smoke 通过验收完成，activateNewVersion 写）优先于 submitted_at（开发提交时间，前置 UPDATE 写）——
 *        "交付完成耗时"应算到验收完成而非提交那一刻；submitted_at 仅 done_at 缺失时兜底。
 *     contact_read_at 为空 → null（前端"—"）；终点早于起点/解析失败 → null。
 *   - 提交次数 = quality_records 行数（每次提交一行）；打回次数 = return_records 行数；返工 = 仅 DEV_QUALITY（M-5）。
 *   - 列对齐：取最新一次提交（submission_seq 升序末尾）的 is_columns_complete / missing_columns。
 *
 * ⚠️ 当前单产出口径（codex 75 L-4）：submit_count = 质量记录行数 = 提交轮次（单产出 sub_item 恒 NULL，一轮一行）。
 *   多产出上线后一轮提交可能产生多行（每子项一行），届时 submit_count 需改按 distinct submission_seq 统计 +
 *   列对齐按子项展示/主单汇总（renderQualitySection 整体重做，记 backlog 与多产出成套改）。
 *
 * @param {object} request        collab_requests 行（用 contact_read_at / archived_at / submitted_at）
 * @param {Array}  qualityRecords collab_quality_record 行（按 submission_seq 升序）
 * @param {Array}  returnRecords  collab_return_record 行
 * @returns {{delivery_duration_minutes:(number|null), submit_count:number, return_count:number,
 *            rework_count:number, latest_is_columns_complete:(1|0|null), latest_missing_columns:(string|null)}}
 */
function buildQualitySummary(request, qualityRecords, returnRecords) {
    // 双校验 Commit D codex 审 medium-1：把 §8b.1"读路径过滤"契约固化到汇总层防御
    //   即使调用方传入了未过滤的 collab_quality_record 行（如未来新增统计 endpoint 忘加 WHERE），
    //   汇总层兜底只消费 record_kind='passed' 或缺失（v3.0 老单虚拟默认值场景）的记录。
    //   过滤后 submit_count / latest_* 都只反映正式交付质量，failed 留痕不污染前端展示。
    const qrsAll = Array.isArray(qualityRecords) ? qualityRecords : [];
    const qrs = qrsAll.filter(r => !r || !r.record_kind || r.record_kind === 'passed');
    const rrs = Array.isArray(returnRecords) ? returnRecords : [];
    const req = request || {};

    // 交付时长（分钟）：datetime('now','localtime') 格式 'YYYY-MM-DD HH:MM:SS'，按本地时间解析
    let deliveryDurationMinutes = null;
    const start = req.contact_read_at;
    // 终点三级 fallback（codex 76 M-1 + 77 复审 M-1）：完成归档 > 验收完成(done_at) > 提交(兜底)
    //   非 archived_at（作废≠完成）；done_at 优先 submitted_at（验收完成才是交付完成，非开发提交那一刻）
    const end = req.archived_final_at || req.done_at || req.submitted_at;
    if (start && end) {
        const t0 = Date.parse(String(start).replace(' ', 'T'));
        const t1 = Date.parse(String(end).replace(' ', 'T'));
        if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
            deliveryDurationMinutes = Math.round((t1 - t0) / 60000);
        }
        // t1 < t0（异常时序）或解析失败 → 保持 null（前端展示"—"，不展示负数/NaN）
    }

    // 最新一次提交（codex 75 L-1：内部复制排序，不赖调用方——导出函数自洽，未来其他调用方传未排序也对）
    let latest = null;
    if (qrs.length > 0) {
        const sorted = [...qrs].sort((a, b) => {
            const d = (a.submission_seq || 0) - (b.submission_seq || 0);
            return d !== 0 ? d : (a.id || 0) - (b.id || 0);
        });
        latest = sorted[sorted.length - 1];
    }
    const reworkCount = rrs.filter(r => r.reason_type === 'DEV_QUALITY').length;

    return {
        delivery_duration_minutes: deliveryDurationMinutes,
        submit_count: qrs.length,
        return_count: rrs.length,
        rework_count: reworkCount,
        // SQL 侧（v3.0 字段保持向后兼容）
        latest_is_columns_complete: latest ? latest.is_columns_complete : null,
        latest_missing_columns: latest && latest.missing_columns ? latest.missing_columns : null,
        // 双校验 Commit D：excel 侧 + SQL 侧 reason（详情页双侧并列展示用，方案 §6.3）
        //   - excel_is_columns_complete 三态同 SQL 侧（1=齐全/0=缺列/NULL=未比对）
        //   - sql_unchecked_reason / excel_unchecked_reason：is_complete=NULL 时的原因枚举（SMOKE_FAILED / NO_TEMPLATE / ...）
        //   - record_kind 透传供前端识别（虽然读路径已过滤 record_kind='passed'，但暴露字段不增加成本）
        // codex Commit D 审 medium-2：用 nullish 归一替代 `in latest` —— 防御未来非 SELECT * 调用方
        //   row 对象未包含某列时（部分列查询），不应被当成"老单兼容"语义
        latest_excel_is_columns_complete: (latest && latest.excel_is_columns_complete != null) ? latest.excel_is_columns_complete : null,
        latest_excel_missing_columns: (latest && latest.excel_missing_columns) ? latest.excel_missing_columns : null,
        latest_sql_unchecked_reason: (latest && latest.sql_unchecked_reason) ? latest.sql_unchecked_reason : null,
        latest_excel_unchecked_reason: (latest && latest.excel_unchecked_reason) ? latest.excel_unchecked_reason : null,
        // record_kind 归一：缺失时归 'passed'（v3.0 老单 ALTER 加列后 DEFAULT 落 passed；新单总有值）
        latest_record_kind: (latest && latest.record_kind) ? latest.record_kind : (latest ? 'passed' : null),
    };
}

// ============================================================================
// §7 取数质量双校验增强 — Commit B：recordQualityForDeveloperSubmit
// ============================================================================
//
// 设计来源：docs/local/数据协作模块_v3.0/取数质量双校验增强_方案_20260611_v1.2.md
//   §3-§4.4 双校验定位 + §5 触发时机入口契约 + §6.1 quality_check 返回稳定 schema + §8b 编码前置约束
//
// 替代 / 共存：与 v3.0 recordQualityOnSubmit 并存。Commit C 切换 submit passed 路径到本函数，
//   v3.0 老函数保留作为旧 submit-export 路径的调用点（未来渐进收敛）。
//
// 核心差异（vs v3.0 recordQualityOnSubmit）：
//   1. 双校验：新增 excel 侧（result_data 表头 vs 模板），独立于 SQL 成败都跑（SQL failed 时也校验 excel，#11 核心）
//   2. record_kind 分流：passed 走 OR IGNORE 幂等（沿用 v3.0 唯一索引）；failed 纯 INSERT append-only（不进唯一索引）
//      —— 方案 §4.4 第十人视角简化（放弃 failed 严格幂等）
//   3. 稳定返回 schema：check_status（计算）与 persistence_status（落库）分离（§6.1）
//   4. 模板异常两侧 reason 同值：sql_unchecked_reason 与 excel_unchecked_reason 写同一个模板 reason（§3.2 不变量）
//   5. 区分 ignored_due_to_duplicate vs insert_failed（§8b.5 codex v1.2 复审 low-1）
//
// H-2 自包：任何漏网异常都不阻断主流程；所有出口返回稳定 schema 对象。
//
// 入参 ctx：
//   - dbAsync                  { runAsync, getAsync }（必填，缺失 → compute_failed）
//   - requestId                协作单 id
//   - submitterId / submitterName  提交人（v1.2 §1.74 codex 79 范式：req.user 快照防 developer/exporter 语义切换）
//   - submissionSeq            passed 路径 = activateNewVersion 后 newVer；failed 路径 = oldVer（当前版本，不自增）
//   - recordKind               'passed' | 'failed'（必填，非法 → compute_failed）
//   - sqlSmokeResult           passed: { columns: string[] } | failed: null（→ sql_unchecked_reason='SMOKE_FAILED'）
//   - sqlAttachmentId          result_script 附件 id（passed/failed 都写）
//                              ⚠️ Commit C 接入硬约束（codex Commit B 审 high-2）：passed 路径必须显式传入，缺失走
//                              `?? null` 归一化为 NULL 但质量记录与 SQL 附件脱链；接入前 grep ctx.sqlAttachmentId
//                              确保 13945/14063 两个调用点都传入对应 attachment id。
//   - resultDataAttachment     { id, file_name } | null（result_data 缺失时 excel 侧 reason='NO_RESULT_DATA'）
//   - insertLog                operation_log 写入函数（best-effort，抛错被 tryInsertQualityLog 自吞）
//   - logger                   日志对象（warn/info/error）
//
// 返回（quality_check 稳定 schema）：
//   {
//     sql:   { is_complete, missing, reason },
//     excel: { is_complete, missing, reason },
//     check_status:       'ok' | 'compute_failed',
//     persistence_status: 'recorded' | 'ignored_due_to_duplicate' | 'failed'
//   }

// 内部：模板查询 + 试读，返回 { templateCols, templateUncheckedReason }
//   - templateCols 非 null → 正常比对（两侧都用这个列集合）
//   - templateUncheckedReason 非 null → 模板侧前置不可比对，两侧 reason 同值（§3.2）
async function _evaluateTemplateForDualCheck(dbAsync, requestId, logger) {
    const tpl = await dbAsync.getAsync(
        `SELECT id, file_name, original_name FROM collab_attachments
          WHERE collab_request_id = ?
            AND attachment_type = 'example_xlsx'
            AND (status = 'active' OR status IS NULL)
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [requestId]
    );
    if (!tpl) return { templateCols: null, templateUncheckedReason: 'NO_TEMPLATE' };
    const ext = path.extname(tpl.original_name || tpl.file_name || '').toLowerCase();
    if (!COLUMN_ALIGN_READABLE_EXTS.has(ext)) {
        return { templateCols: null, templateUncheckedReason: 'NON_XLSX_TEMPLATE' };
    }
    try {
        const abs = resolveAttachmentPath(tpl.file_name);
        const { header } = readXlsxHeader(abs);
        return { templateCols: header, templateUncheckedReason: null };
    } catch (e) {
        (logger || console).warn(`[collab-dualcheck] req=${requestId} 模板读取失败(${e.code || 'ERR'})：${e.message}`);
        return { templateCols: null, templateUncheckedReason: 'TEMPLATE_READ_FAILED' };
    }
}

// 内部：跑 excel 侧比对（result_data 表头 vs 模板列）
//   - resultDataAttachment 缺失 → reason='NO_RESULT_DATA'
//   - 扩展名非 xlsx/xls → reason='NON_EXCEL_RESULT'
//   - 读取失败 → reason='RESULT_READ_FAILED'
//   - 成功 → 与 templateCols 跑 compareColumns
function _evaluateExcelSide(resultDataAttachment, templateCols, requestId, logger) {
    if (!resultDataAttachment || !resultDataAttachment.file_name) {
        return { is_complete: null, missing: [], reason: 'NO_RESULT_DATA', snapshot: null };
    }
    const ext = path.extname(resultDataAttachment.original_name || resultDataAttachment.file_name || '').toLowerCase();
    if (!COLUMN_ALIGN_READABLE_EXTS.has(ext)) {
        return { is_complete: null, missing: [], reason: 'NON_EXCEL_RESULT', snapshot: null };
    }
    let excelCols;
    try {
        const abs = resolveAttachmentPath(resultDataAttachment.file_name);
        const { header } = readXlsxHeader(abs);
        excelCols = header;
    } catch (e) {
        (logger || console).warn(`[collab-dualcheck] req=${requestId} result_data 读取失败(${e.code || 'ERR'})：${e.message}`);
        return { is_complete: null, missing: [], reason: 'RESULT_READ_FAILED', snapshot: null };
    }
    // 模板已成功（templateCols 非 null 才进这里），正常比对
    const cmp = compareColumns(templateCols, excelCols);
    return {
        is_complete: cmp.complete ? 1 : 0,
        missing: cmp.missing,
        reason: null,
        snapshot: excelCols,
    };
}

async function recordQualityForDeveloperSubmit(ctx) {
    const log = (ctx && ctx.logger) || console;
    // H-2 兜底：所有返回都过这个 builder，保证稳定 schema
    //   compute_failed 契约（方案 §8b.4）：builder 级异常 → 两侧 is_complete=null/missing=[]/reason='QUALITY_CHECK_FAILED'
    const computeFailedReturn = (persistence = 'failed') => ({
        sql:   { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
        excel: { is_complete: null, missing: [], reason: 'QUALITY_CHECK_FAILED' },
        check_status: 'compute_failed',
        persistence_status: persistence,
    });

    try {
        const { dbAsync, requestId, submitterId, submitterName, submissionSeq, recordKind } = ctx;
        if (!dbAsync || typeof dbAsync.runAsync !== 'function' || typeof dbAsync.getAsync !== 'function') {
            log.warn('[collab-dualcheck] recordQualityForDeveloperSubmit: dbAsync 缺失');
            return computeFailedReturn('failed');
        }
        if (recordKind !== 'passed' && recordKind !== 'failed') {
            log.warn(`[collab-dualcheck] req=${requestId} recordKind 非法='${recordKind}'，应为 'passed'|'failed'`);
            return computeFailedReturn('failed');
        }

        // [1] 模板侧（双校验共用，§3.2 两侧 reason 同值）
        const { templateCols, templateUncheckedReason } = await _evaluateTemplateForDualCheck(dbAsync, requestId, log);

        // [2] SQL 侧
        //   passed 路径有 sqlSmokeResult.columns；failed 路径 → SMOKE_FAILED
        //   模板前置不可比对时（templateUncheckedReason !== null）→ SQL 侧用模板 reason（同 excel 侧）
        let sqlSide;
        if (recordKind === 'failed') {
            sqlSide = { is_complete: null, missing: [], reason: 'SMOKE_FAILED', snapshot: [] };
        } else if (templateUncheckedReason) {
            sqlSide = { is_complete: null, missing: [], reason: templateUncheckedReason, snapshot: null };
        } else {
            const sqlCols = (ctx.sqlSmokeResult && Array.isArray(ctx.sqlSmokeResult.columns)) ? ctx.sqlSmokeResult.columns : [];
            const cmp = compareColumns(templateCols, sqlCols);
            sqlSide = {
                is_complete: cmp.complete ? 1 : 0,
                missing: cmp.missing,
                reason: null,
                snapshot: sqlCols,
            };
        }

        // [3] excel 侧
        //   模板前置不可比对时 → excel 侧用同一个模板 reason（§3.2 两侧同值）
        //   模板可比对时 → 跑 _evaluateExcelSide（result_data 缺失/非 excel/读失败 各自独立 reason）
        let excelSide;
        if (templateUncheckedReason) {
            excelSide = { is_complete: null, missing: [], reason: templateUncheckedReason, snapshot: null };
        } else {
            excelSide = _evaluateExcelSide(ctx.resultDataAttachment, templateCols, requestId, log);
        }

        // [4] 归一化（§3.2 不变量）+ snapshot 序列化
        //   未比对（is_complete=null）：snapshot=null + missing=[]（不写非空）；已比对：snapshot=JSON 数组
        const normalizeSide = (side) => ({
            is_complete: side.is_complete,
            missing: side.is_complete === null ? [] : (Array.isArray(side.missing) ? side.missing : []),
            reason: side.reason,
            snapshot: side.is_complete === null ? null : (Array.isArray(side.snapshot) ? side.snapshot : null),
        });
        const sqlN = normalizeSide(sqlSide);
        const excelN = normalizeSide(excelSide);

        // [5] 构造写入参数
        const sqlActualSnapshot = sqlN.snapshot === null ? null : JSON.stringify(sqlN.snapshot);
        const sqlMissingJson = sqlN.is_complete === null ? null : JSON.stringify(sqlN.missing);
        const excelActualSnapshot = excelN.snapshot === null ? null : JSON.stringify(excelN.snapshot);
        const excelMissingJson = excelN.is_complete === null ? null : JSON.stringify(excelN.missing);
        const sqlAttachmentId = (ctx.sqlAttachmentId === undefined || ctx.sqlAttachmentId === null) ? null : ctx.sqlAttachmentId;
        const resultAttachmentId = (ctx.resultDataAttachment && ctx.resultDataAttachment.id) || null;
        // 模板 expected snapshot：能成功读到模板列才有
        const expectedSnapshot = templateCols ? JSON.stringify(templateCols) : null;

        // [6] INSERT 分流
        //   passed：INSERT OR IGNORE，唯一索引兜底幂等 → changes>0=recorded / changes=0=ignored_due_to_duplicate
        //   failed：纯 INSERT（不带 OR IGNORE）→ 不进唯一索引，每次都 append；约束错误（CHECK/NOT NULL）走 catch
        const insertSql = recordKind === 'passed'
            ? `INSERT OR IGNORE INTO collab_quality_record
                (collab_request_id, collab_sub_item_id, submitter_id, submitter_name,
                 submission_seq, submitted_at,
                 missing_columns, is_columns_complete, expected_columns_snapshot, actual_columns_snapshot, sql_attachment_id, sql_unchecked_reason,
                 excel_missing_columns, excel_is_columns_complete, excel_actual_columns_snapshot, excel_unchecked_reason, result_attachment_id,
                 record_kind)
               VALUES (?, NULL, ?, ?, ?, datetime('now','localtime'),
                 ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 'passed')`
            : `INSERT INTO collab_quality_record
                (collab_request_id, collab_sub_item_id, submitter_id, submitter_name,
                 submission_seq, submitted_at,
                 missing_columns, is_columns_complete, expected_columns_snapshot, actual_columns_snapshot, sql_attachment_id, sql_unchecked_reason,
                 excel_missing_columns, excel_is_columns_complete, excel_actual_columns_snapshot, excel_unchecked_reason, result_attachment_id,
                 record_kind)
               VALUES (?, NULL, ?, ?, ?, datetime('now','localtime'),
                 ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 'failed')`;
        const insertParams = [
            requestId, submitterId, submitterName, submissionSeq,
            sqlMissingJson, sqlN.is_complete, expectedSnapshot, sqlActualSnapshot, sqlAttachmentId, sqlN.reason,
            excelMissingJson, excelN.is_complete, excelActualSnapshot, excelN.reason, resultAttachmentId,
        ];

        let persistenceStatus;
        try {
            const insres = await dbAsync.runAsync(insertSql, insertParams);
            // §8b.5：区分幂等 vs 约束错误
            if (recordKind === 'passed') {
                persistenceStatus = (insres && insres.changes > 0) ? 'recorded' : 'ignored_due_to_duplicate';
                if (persistenceStatus === 'ignored_due_to_duplicate') {
                    log.info(`[collab-dualcheck] req=${requestId} seq=${submissionSeq} passed 路径幂等命中（同 seq 已有 passed 记录）`);
                }
            } else {
                // failed 路径不带 OR IGNORE，正常都 changes=1
                persistenceStatus = 'recorded';
            }
        } catch (e) {
            // CHECK/NOT NULL 等约束错误（§8b.5 不静默吞）
            log.warn(`[collab-dualcheck] req=${requestId} seq=${submissionSeq} INSERT 异常（${recordKind}，不阻断主流程）：${e.message}`);
            tryInsertQualityLog(ctx, requestId, submitterId, submitterName,
                `dualcheck_insert_failed/${recordKind}:${e.message}`, log);
            persistenceStatus = 'failed';
        }

        // [7] operation_log 留痕
        tryInsertQualityLog(ctx, requestId, submitterId, submitterName,
            `dualcheck:${recordKind}/sql=${sqlN.is_complete === null ? `NULL(${sqlN.reason})` : sqlN.is_complete}/excel=${excelN.is_complete === null ? `NULL(${excelN.reason})` : excelN.is_complete}/persist=${persistenceStatus}`, log);

        // [8] 稳定返回（§6.1）
        return {
            sql:   { is_complete: sqlN.is_complete,   missing: sqlN.missing,   reason: sqlN.reason },
            excel: { is_complete: excelN.is_complete, missing: excelN.missing, reason: excelN.reason },
            check_status: 'ok',
            persistence_status: persistenceStatus,
        };
    } catch (e) {
        // 顶层兜底：任何漏网异常都返回 compute_failed（H-2 + §8b.4）
        log.warn(`[collab-dualcheck] recordQualityForDeveloperSubmit 顶层异常（已隔离，不阻断 submit）：${e.message}`);
        return computeFailedReturn('failed');
    }
}

module.exports = {
    cleanupPendingFiles,
    sanitizeSqlError,
    runRealSmokeTest,
    extractResultColumns,   // 取数质量 v3.0 C1：列名提取（暴露给单测）
    classifyUploadedFiles,
    safeDisplayName,
    // v1.70.0 抽取（方案 §1.2.6）
    resolveAttachmentPath,
    isSoftArchived,
    isFinalArchived,
    // v1.71.0 三级转发：附件按人锁前置闸门
    checkAttachmentOwnerOrAdmin,
    // 取数交付质量记录 v3.0 Commit C2：submit-export 后列对齐旁路写入
    recordQualityOnSubmit,
    // 取数质量双校验增强 Commit B：双校验（SQL + excel）+ record_kind 分流（passed/failed）+ 稳定 schema
    recordQualityForDeveloperSubmit,
    // 取数交付质量记录 v3.0 Commit D：退回开发最小状态转换骨架（公共函数）
    transitionToDevPending,
    // 取数交付质量记录 v3.0 Commit E：模板上传列对齐可读性预检（源头防线）
    checkTemplateReadable,
    // 取数交付质量记录 v3.0 Commit E：详情页质量汇总（交付时长 M-7 + 提交/打回/返工计数）
    buildQualitySummary,
    // 暴露给测试和监控（生产代码不应直接 acquire/release，统一走 runRealSmokeTest 包装）
    _globalSmokeTestMutex: globalSmokeTestMutex,
};
