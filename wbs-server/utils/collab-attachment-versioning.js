/**
 * 数据协作模块附件版本化 + 启动巡检（Deploy 3）
 *
 * 设计来源：docs/local/数据协作模块_方案_v2.0.md §5.4
 * codex 七审拍板（13 条全采纳）：docs/local/codex审查记录/数据协作模块/08-D3-附件版本化取舍审-20260513.md
 *
 * 核心职责：
 *   1. activateNewVersion()   提交版本激活的事务（写新版本 → smoke test → DB 事务 + 乐观锁 → 旧版本标 superseded）
 *   2. scanOrphansAndDanglingPointers()  启动巡检，三类分类输出（active 缺文件 / superseded 保留 / 完全孤儿）
 *   3. placeholderSmokeTest() 占位 smoke test，模块 3（SQL parser + 引擎）完成前 fail-closed
 *
 * 关键不变量（codex C3）：
 *   - active 行：superseded_at IS NULL
 *   - superseded 行：superseded_at IS NOT NULL
 *
 * 关键约束（codex M5 完整快照语义）：
 *   - 一次激活 = result_data + result_script 同时提供，否则 throw
 *   - 激活 supersede 该 collab_request 的全部 oldVer active 行
 *
 * 并发竞态（codex C4）：
 *   - 乐观锁 WHERE submission_version=:oldVer 失败 → 文件挪到 _orphaned/{rid}_v{newVer}_{ts}/
 *   - 不静默残留在正式目录
 *
 * 安全攻击面（codex M2）：
 *   - 源文件必须位于 _pending/{rid}/ 下
 *   - 目标路径 resolve 后必须仍在 collab 目录下
 *   - 禁止跟随 symlink
 *   - DB 只保存服务端生成的 file_name（与 D1 现状一致）
 *
 * 智能感知（codex M3）：
 *   - 巡检异常一律 try/catch，logger.error 但不阻断服务启动
 *   - DB schema 缺字段（SQLITE_ERROR）单独识别，不被通用 catch 吞掉
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// §1 placeholderSmokeTest（codex C2：fail-closed，比 codex 建议更严）
// ---------------------------------------------------------------------------

/**
 * 模块 3（SQL parser + smoke test 引擎）尚未实现，此占位函数硬 throw。
 *
 * 设计理由（codex C2 + Claude 更严）：
 *   - codex 建议环境变量门控放行 → Claude 认为环境变量有"忘记关"的风险
 *   - 硬 throw 让任何意外调用立即暴露，模块 3 完成时 server.js 的调用点会换成真实实现
 *
 * 调用方必须捕获 SMOKE_TEST_NOT_IMPLEMENTED 错误并返回 503 / 提示"smoke test 引擎未就绪"。
 *
 * @returns {Promise<never>} 永远 throw
 */
async function placeholderSmokeTest(/* scriptFilePath */) {
    const e = new Error('SMOKE_TEST_NOT_IMPLEMENTED: 模块 3 SQL smoke test 引擎尚未实现');
    e.code = 'SMOKE_TEST_NOT_IMPLEMENTED';
    throw e;
}

// ---------------------------------------------------------------------------
// §2 路径工具（codex M2 安全防线）
// ---------------------------------------------------------------------------

/**
 * 检查 candidate 是否位于 root 下（防路径穿越 + 防符号链接）。
 * 返回 { ok, resolvedPath, error }
 */
function ensureInsideRoot(candidate, root) {
    try {
        // realpathSync 会跟随 symlink，所以 candidate 是 symlink 时 realpathSync 拿到实际目标；
        // 我们要求"目标位置和 candidate 字面位置都必须在 root 内"
        const literalResolved = path.resolve(candidate);
        if (!literalResolved.startsWith(path.resolve(root) + path.sep) && literalResolved !== path.resolve(root)) {
            return { ok: false, error: `路径越界（字面）：${literalResolved} 不在 ${root} 下` };
        }
        if (fs.existsSync(candidate)) {
            const realResolved = fs.realpathSync(candidate);
            if (!realResolved.startsWith(path.resolve(root) + path.sep) && realResolved !== path.resolve(root)) {
                return { ok: false, error: `路径越界（realpath，疑似 symlink）：${realResolved} 不在 ${root} 下` };
            }
            // 拒绝跟随 symlink 的源文件
            const stat = fs.lstatSync(candidate);
            if (stat.isSymbolicLink()) {
                return { ok: false, error: `源文件是符号链接：${candidate}` };
            }
        }
        return { ok: true, resolvedPath: literalResolved };
    } catch (e) {
        return { ok: false, error: `路径校验异常：${e.message}` };
    }
}

/**
 * 计算协作单的正式附件目录（用于首次激活）。
 *
 * 优先级：
 *   1. collab_requests.attachment_dir 已固化 → 直接用
 *   2. 否则用 D1 老逻辑 `{id}_{safeDesc}` 作为首次落盘的目录名（同时写回 attachment_dir）
 *
 * 调用方决定要不要把返回值持久化到 attachment_dir 字段。
 */
function computeAttachmentDirName(requestId, description) {
    const safeDesc = String(description || '').replace(/[\\/:*?"<>|\s]/g, '_').substring(0, 20);
    return `${requestId}_${safeDesc}`;
}

// ---------------------------------------------------------------------------
// §3 activateNewVersion（codex C4/M2/M5/M6/L2）
// ---------------------------------------------------------------------------

/**
 * 激活新版本附件提交（完整快照语义）。
 *
 * 流程（codex 七审 H-1 修订完整版）：
 *   1. 校验 uploadedFiles 必须包含 result_data + result_script（M5 完整快照）
 *   2. 校验所有源文件位于 _pending/{requestId}/ 下（M2 防穿越）
 *   3. 决定目标目录：collab_requests.attachment_dir 若已固化则用；否则计算 + 待激活时写回（M1）
 *   4. rename 文件到正式目录（不删旧文件！旧版本仍是 active 直到 DB 事务激活）
 *   5. 调 runSmokeTest(scriptFinalPath)（L2 callback 注入）
 *      - 失败 → 删本次新文件，保持旧 active 不变
 *      - 通过 → 进入下一步
 *   6. DB 事务（BEGIN）：
 *      a. INSERT 新 attachment 行（submission_version=newVer, status='active', superseded_at=NULL）
 *      b. UPDATE 旧 active 行 → status='superseded', superseded_at=CURRENT_TIMESTAMP（C3 不变量）
 *      c. UPDATE collab_requests SET submission_version=newVer, sql_validation_status='passed',
 *            sql_validated_at=NOW(), status='DONE', done_at=NOW(), attachment_dir=<dir>
 *         WHERE id=:id AND submission_version=:oldVer  (H-4 乐观锁)
 *      d. 检查 d 步 changes()，若 0 行 → ROLLBACK + 文件挪到 _orphaned/（C4）
 *   7. COMMIT
 *
 * @param {object} params
 * @param {Database} params.db          sqlite3 Database 实例
 * @param {object}   params.dbAsync     { runAsync, getAsync, allAsync } 异步包装
 * @param {number}   params.requestId   collab_request_id
 * @param {number}   params.oldVer      期望的旧 submission_version（乐观锁基线）
 * @param {string}   params.collabRoot  uploads/collab 绝对路径
 * @param {string}   params.description collab_requests.description（首次激活计算目录用）
 * @param {string|null} params.attachmentDir collab_requests.attachment_dir 当前值
 * @param {Array<{attachment_type, file_name, original_name, source_path, uploaded_by, uploaded_by_name}>} params.uploadedFiles
 *        source_path 必须在 _pending/{requestId}/ 下
 * @param {Function} params.runSmokeTest async fn(scriptFinalPath) → { ok, validatedAt? , error? }
 * @returns {Promise<{ newVer: number, attachmentDir: string, smokeTestResult: object }>}
 * @throws  乐观锁失败 → { code:'CONCURRENT_SUBMIT', orphanedDir }
 *          完整快照缺漏 → { code:'INCOMPLETE_SNAPSHOT' }
 *          smoke test 失败 → { code:'SMOKE_TEST_FAILED', smokeError }
 *          路径校验失败 → { code:'PATH_VIOLATION', detail }
 */
async function activateNewVersion(params) {
    const { db, dbAsync, requestId, oldVer, collabRoot, description, attachmentDir, uploadedFiles, runSmokeTest, logger } = params;
    const log = logger || console;

    // §3.1 完整快照校验（M5 + codex 24 审 #2 medium：每类恰好 1 个）
    // 不仅 hasResultData / hasResultScript，还必须各自恰好 1 个；
    // 否则 v1.70.0 §1.2 failed 路径下同 attachment_type 多文件会撞 UNIQUE(rid, seq, attachment_type)
    const countByType = uploadedFiles.reduce((acc, f) => {
        acc[f.attachment_type] = (acc[f.attachment_type] || 0) + 1;
        return acc;
    }, {});
    const dataCount = countByType.result_data || 0;
    const scriptCount = countByType.result_script || 0;
    if (dataCount !== 1 || scriptCount !== 1) {
        const err = new Error(
            `完整快照不规范：每次提交必须恰好包含 1 个 result_data + 1 个 result_script，` +
            `实际 result_data=${dataCount}, result_script=${scriptCount}`
        );
        err.code = 'INCOMPLETE_SNAPSHOT';
        err.detail = { dataCount, scriptCount, countByType };
        throw err;
    }

    // §3.2 源文件路径校验（M2）— 必须在 _pending/{requestId}/ 下
    const pendingRoot = path.join(collabRoot, '_pending', String(requestId));
    for (const f of uploadedFiles) {
        const check = ensureInsideRoot(f.source_path, pendingRoot);
        if (!check.ok) {
            const err = new Error(`源文件路径校验失败：${check.error}`);
            err.code = 'PATH_VIOLATION';
            err.detail = check.error;
            throw err;
        }
    }

    // §3.3 决定目标目录（M1）
    const dirName = attachmentDir || computeAttachmentDirName(requestId, description);
    const targetDir = path.join(collabRoot, dirName);
    const targetCheck = ensureInsideRoot(targetDir, collabRoot);
    if (!targetCheck.ok) {
        const err = new Error(`目标目录越界：${targetCheck.error}`);
        err.code = 'PATH_VIOLATION';
        throw err;
    }
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // §3.4 rename 文件到正式目录（不删旧）
    const movedFiles = []; // 用于失败回滚
    let scriptFinalPath = null;
    try {
        for (const f of uploadedFiles) {
            const finalName = path.basename(f.source_path); // 沿用 multer 已经生成的 ${ts}_${rand}_${safeOriginal}
            const finalPath = path.join(targetDir, finalName);
            const finalCheck = ensureInsideRoot(finalPath, targetDir);
            if (!finalCheck.ok) {
                const err = new Error(`最终文件路径越界：${finalCheck.error}`);
                err.code = 'PATH_VIOLATION';
                throw err;
            }
            fs.renameSync(f.source_path, finalPath);
            movedFiles.push({ ...f, final_path: finalPath, final_name: finalName });
            if (f.attachment_type === 'result_script') {
                scriptFinalPath = finalPath;
            }
        }
    } catch (e) {
        // 回滚已 rename 的文件回 _pending（best-effort）
        for (const mf of movedFiles) {
            try { fs.renameSync(mf.final_path, mf.source_path); } catch (_) { /* ignore */ }
        }
        throw e;
    }

    // §3.5 smoke test（L2 callback 注入）
    let smokeTestResult;
    try {
        smokeTestResult = await runSmokeTest(scriptFinalPath);
    } catch (e) {
        // smoke test 抛错（含 placeholder 的 SMOKE_TEST_NOT_IMPLEMENTED / SMOKE_MUTEX_WAIT_TIMEOUT / RUNNING_UPDATE_*）
        // → 删本次文件 + 透传错误
        // 注意：这类是"smoke test 引擎自己出问题"，不属于"业务 SQL 错"，仍走删除路径
        await cleanupMovedFiles(movedFiles, log);
        throw e;
    }
    if (!smokeTestResult || !smokeTestResult.ok) {
        // v1.70.0 方案 §1.2 撞墙附件保留改造：
        //   ① smoke test 返回 ok=false（业务 SQL 错） → 不再删文件
        //   ② 文件保留在正式目录 collab/{rid}_xxx/，DB INSERT 新行 status='failed'
        //   ③ failed_attempt_seq 按 (rid, attachment_type) 分组取 MAX+1
        //   ④ BEGIN IMMEDIATE 事务串行化 + UNIQUE 索引兜底
        //   ⑤ failed INSERT 自身失败 → 文件挪 _orphaned/failed_insert_failed/{rid}_v{ver}_{ts}/
        //   ⑥ 抛 SMOKE_TEST_FAILED 含 failedAttachments 反馈给前端
        const smokeError = smokeTestResult && smokeTestResult.error || '未知错误';
        let failedAttachments;
        try {
            failedAttachments = await insertFailedAttachments({
                dbAsync, requestId, movedFiles, smokeError, collabRoot, logger: log
            });
        } catch (insertErr) {
            // INSERT failed 自身失败 → 文件挪隔离区
            log.error(`[collab-versioning] INSERT failed 行失败 (req=${requestId}): ${insertErr.message}`);
            try {
                await moveToOrphanedSubdir(movedFiles, requestId, oldVer, collabRoot, 'failed_insert_failed', log);
            } catch (_) { /* ignore */ }
            const err = new Error(`smoke 失败附件 INSERT DB 失败：${insertErr.message}`);
            err.code = 'SMOKE_TEST_FAILED_INSERT_FAILED';
            err.smokeError = smokeError;
            throw err;
        }
        const err = new Error(`smoke test 验证失败：${smokeError}`);
        err.code = 'SMOKE_TEST_FAILED';
        err.smokeError = smokeError;
        err.failedAttachments = failedAttachments;  // [{ id, attachment_type, failed_attempt_seq, file_name }]
        throw err;
    }

    // §3.6 DB 事务激活（H-4 乐观锁）
    const newVer = oldVer + 1;
    const validatedAt = smokeTestResult.validatedAt || new Date();
    try {
        await dbAsync.runAsync('BEGIN TRANSACTION');

        // a. INSERT 新版本
        for (const mf of movedFiles) {
            const relPath = path.relative(path.dirname(collabRoot), mf.final_path).replace(/\\/g, '/');
            await dbAsync.runAsync(
                `INSERT INTO collab_attachments
                    (collab_request_id, attachment_type, file_name, original_name,
                     uploaded_by, uploaded_by_name, submission_version, status, superseded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
                [requestId, mf.attachment_type, relPath, mf.original_name,
                 mf.uploaded_by, mf.uploaded_by_name, newVer]
            );
        }

        // b. UPDATE 旧 active 行 → superseded（C3 同步写 superseded_at）
        await dbAsync.runAsync(
            `UPDATE collab_attachments
                SET status='superseded', superseded_at=datetime('now','localtime')
              WHERE collab_request_id=? AND status='active' AND submission_version=?`,
            [requestId, oldVer]
        );

        // c. UPDATE collab_requests（乐观锁 + 写 attachment_dir）
        const upd = await dbAsync.runAsync(
            `UPDATE collab_requests
                SET submission_version=?,
                    sql_validation_status='passed',
                    sql_validated_at=?,
                    status='DONE',
                    done_at=datetime('now','localtime'),
                    attachment_dir=?
              WHERE id=? AND submission_version=?`,
            [newVer, validatedAt.toISOString ? validatedAt.toISOString() : String(validatedAt),
             dirName, requestId, oldVer]
        );

        // d. 乐观锁失败检测
        if (!upd || upd.changes === 0) {
            await dbAsync.runAsync('ROLLBACK');
            // 把本次写入的文件挪到 _orphaned/{rid}_v{newVer}_{ts}/（C4）
            const orphanDir = await moveToOrphaned(movedFiles, requestId, newVer, collabRoot, log);
            const err = new Error('并发提交：乐观锁失败（submission_version 已变化）');
            err.code = 'CONCURRENT_SUBMIT';
            err.orphanedDir = orphanDir;
            throw err;
        }

        await dbAsync.runAsync('COMMIT');
        log.info(`[collab-versioning] 协作单 #${requestId} 激活 v${newVer} 成功，目录 ${dirName}`);
        return { newVer, attachmentDir: dirName, smokeTestResult };
    } catch (e) {
        // 事务异常（非乐观锁失败）回滚
        if (e.code !== 'CONCURRENT_SUBMIT') {
            try { await dbAsync.runAsync('ROLLBACK'); } catch (_) { /* ignore */ }
            // 物理文件挪到 _orphaned 避免污染正式目录
            try {
                await moveToOrphaned(movedFiles, requestId, newVer, collabRoot, log);
            } catch (_) { /* ignore */ }
        }
        throw e;
    }
}

async function cleanupMovedFiles(movedFiles, log) {
    for (const mf of movedFiles) {
        try { fs.unlinkSync(mf.final_path); }
        catch (e) { log.warn(`[collab-versioning] 清理失败文件失败 ${mf.final_path}: ${e.message}`); }
    }
}

/**
 * v1.70.0 方案 §1.2 INSERT failed 行（BEGIN IMMEDIATE 事务）
 *
 * 流程：
 *   1. BEGIN IMMEDIATE TRANSACTION（立即拿写锁，防并发 race）
 *   2. 按 attachment_type 分组取 MAX(failed_attempt_seq) + 1
 *   3. INSERT 一行 / 文件 status='failed' + failed_at + failed_reason + failed_attempt_seq
 *   4. COMMIT
 *   5. 任一步异常 ROLLBACK + 抛错
 *
 * 不变量：
 *   - 同 (rid, attachment_type) 内 failed_attempt_seq 严格递增（BEGIN IMMEDIATE + UNIQUE 索引双重防御）
 *   - file_name 保留首次 rename 的相对路径（不动磁盘文件）
 *   - failed 行 superseded_at IS NULL（语义：failed 不是 active 也不是 superseded，是第三态）
 *
 * @returns {Promise<Array<{id, attachment_type, failed_attempt_seq, file_name}>>}
 */
async function insertFailedAttachments({ dbAsync, requestId, movedFiles, smokeError, collabRoot, logger }) {
    const log = logger || console;
    if (!collabRoot) {
        throw new Error('insertFailedAttachments: collabRoot 必传');
    }
    // 与 activateNewVersion §3.6 INSERT active 行用完全一致的拼接逻辑：
    //   relPath = path.relative(path.dirname(collabRoot), mf.final_path)
    //   collabRoot = 'uploads/collab' → dirname = 'uploads' → relative = 'collab/{rid}_xxx/file'
    const collabRootRel = (mf) => path.relative(path.dirname(collabRoot), mf.final_path).replace(/\\/g, '/');
    const inserted = [];
    try {
        await dbAsync.runAsync('BEGIN IMMEDIATE TRANSACTION');
        // 按 attachment_type 分组取 MAX+1
        const seqByType = new Map();
        for (const mf of movedFiles) {
            if (!seqByType.has(mf.attachment_type)) {
                const row = await dbAsync.getAsync(
                    `SELECT COALESCE(MAX(failed_attempt_seq), 0) AS max_seq
                       FROM collab_attachments
                      WHERE collab_request_id = ?
                        AND attachment_type = ?
                        AND status = 'failed'`,
                    [requestId, mf.attachment_type]
                );
                seqByType.set(mf.attachment_type, (row && row.max_seq || 0) + 1);
            }
        }
        // INSERT 一行 / 文件
        for (const mf of movedFiles) {
            const relPath = collabRootRel(mf);
            const seq = seqByType.get(mf.attachment_type);
            const ins = await dbAsync.runAsync(
                `INSERT INTO collab_attachments
                    (collab_request_id, attachment_type, file_name, original_name,
                     uploaded_by, uploaded_by_name, submission_version, status,
                     failed_at, failed_reason, failed_attempt_seq, superseded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'failed',
                         datetime('now','localtime'), ?, ?, NULL)`,
                [requestId, mf.attachment_type, relPath, mf.original_name,
                 mf.uploaded_by, mf.uploaded_by_name, 0,  // submission_version=0 失败不晋升版本
                 String(smokeError || '').slice(0, 2000), seq]
            );
            inserted.push({
                id: ins && ins.lastID,
                attachment_type: mf.attachment_type,
                failed_attempt_seq: seq,
                file_name: relPath
            });
        }
        await dbAsync.runAsync('COMMIT');
        log.info(`[collab-versioning] 协作单 #${requestId} 撞墙附件保留 ${inserted.length} 个 (seq=${[...seqByType.entries()].map(([t, s]) => `${t}:${s}`).join(', ')})`);
        return inserted;
    } catch (e) {
        try { await dbAsync.runAsync('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
    }
}

/**
 * v1.70.0 文件挪到 _orphaned/{subdir}/ 子目录（区分场景）
 * subdir 例如：'failed_insert_failed' / 'concurrent_submit' 等
 */
async function moveToOrphanedSubdir(movedFiles, requestId, ver, collabRoot, subdir, log) {
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
    const orphanDir = path.join(collabRoot, '_orphaned', subdir, `${requestId}_v${ver}_${ts}`);
    try {
        fs.mkdirSync(orphanDir, { recursive: true });
        for (const mf of movedFiles) {
            try {
                const targetPath = path.join(orphanDir, mf.final_name);
                fs.renameSync(mf.final_path, targetPath);
            } catch (e) {
                log.warn(`[collab-versioning] 挪到 _orphaned/${subdir} 失败 ${mf.final_path}: ${e.message}`);
            }
        }
        log.warn(`[collab-versioning] 协作单 #${requestId} v${ver} 隔离到 ${orphanDir}`);
    } catch (e) {
        log.error(`[collab-versioning] 创建 _orphaned/${subdir} 目录失败: ${e.message}`);
    }
    return orphanDir;
}

async function moveToOrphaned(movedFiles, requestId, newVer, collabRoot, log) {
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').substring(0, 15);
    const orphanDir = path.join(collabRoot, '_orphaned', `${requestId}_v${newVer}_${ts}`);
    try {
        fs.mkdirSync(orphanDir, { recursive: true });
        for (const mf of movedFiles) {
            try {
                const targetPath = path.join(orphanDir, mf.final_name);
                fs.renameSync(mf.final_path, targetPath);
            } catch (e) {
                log.warn(`[collab-versioning] 挪到 _orphaned 失败 ${mf.final_path}: ${e.message}`);
            }
        }
        log.warn(`[collab-versioning] 协作单 #${requestId} v${newVer} 因并发/异常隔离到 ${orphanDir}`);
    } catch (e) {
        log.error(`[collab-versioning] 创建 _orphaned 目录失败: ${e.message}`);
    }
    return orphanDir;
}

// ---------------------------------------------------------------------------
// §4 启动巡检（codex C1/M3/L1）
// ---------------------------------------------------------------------------

/**
 * 启动巡检：扫 uploads/collab/ 下文件 vs DB collab_attachments 记录，三类分类输出。
 *
 * 三类（codex C1）：
 *   1. dangling_pointer  DB active 行 → 磁盘文件缺失（最高优先级，可能影响下载）
 *   2. superseded_retain DB superseded 行 → 磁盘文件存在（合法保留物，仅 INFO 级别统计）
 *   3. orphan_file       磁盘文件 → DB 无任何记录（可能是事务失败残留或人工放进来的）
 *
 * 异常处理（codex M3）：
 *   - uploads 目录不存在 / 权限错 / DB schema 缺字段 → logger.error 但不抛
 *   - 单个目录读失败 → 跳过，继续下一个
 *
 * 性能（codex L1）：
 *   - 由 server.js 用 setImmediate 异步调用，不阻塞服务 ready
 *   - 汇总输出（前 N 条样例 + 总数），不刷屏
 */
async function scanOrphansAndDanglingPointers({ db, dbAsync, collabRoot, logger, sampleLimit = 5 }) {
    const log = logger || console;
    const result = {
        dangling_pointer: [],   // [{ requestId, file_name, original_name, attachment_id }]
        superseded_retain: 0,   // 仅统计数量，不堆细节
        failed_retain: 0,       // v1.70.0：failed 附件磁盘文件正常存在的统计
        orphan_file: [],        // [{ path }]
        invalid_pointer: [],    // v1.70.0：DB file_name 越界（含 ../）的统计
        errors: []
    };

    // v1.70.0 lazy require 避免循环依赖（collab-submit-helpers 自己不依赖本模块）
    let collabSubmitHelpers = null;
    try { collabSubmitHelpers = require('./collab-submit-helpers'); } catch (_) { /* 单测桩可能 mock，容错 */ }

    try {
        // §4.1 DB 侧：拉全部 collab_attachments + collab_requests.attachment_dir
        let attachmentRows;
        let requestRows;
        try {
            attachmentRows = await dbAsync.allAsync(
                `SELECT a.id, a.collab_request_id, a.attachment_type, a.file_name, a.original_name, a.status, a.submission_version
                   FROM collab_attachments a`
            );
            requestRows = await dbAsync.allAsync(
                `SELECT id, description, attachment_dir, submission_version FROM collab_requests`
            );
        } catch (e) {
            // DB schema 缺字段类错误单独识别
            if (e.message && /no such column/i.test(e.message)) {
                log.error(`[collab-integrity] DB schema 缺字段（可能 ALTER 未跑完）：${e.message}`);
                result.errors.push({ type: 'SCHEMA_MISSING', detail: e.message });
                return result;
            }
            throw e;
        }

        const requestById = new Map();
        for (const r of requestRows) requestById.set(r.id, r);

        // §4.2 磁盘侧：枚举 uploads/collab 子目录（排除 _pending / _orphaned 内部文件）
        if (!fs.existsSync(collabRoot)) {
            log.warn(`[collab-integrity] uploads/collab 目录不存在: ${collabRoot}`);
            return result;
        }

        // 把 DB attachment 按状态归类（codex 24 审 #3：Map key 改 relpath 与 DB file_name 形式一致）
        // file_name 形如 'collab/{rid}_xxx/{ts}_{rand}_name.ext'，全局唯一不会撞同名
        // active / superseded / failed 三态并存
        const activeFiles = new Map();      // relpath -> row
        const supersededFiles = new Map();  // relpath -> row
        const failedFiles = new Map();      // relpath -> row（v1.70.0）
        for (const a of attachmentRows) {
            // v1.70.0：越界检查（用 resolveAttachmentPath 拒绝 file_name 越界 / 空）
            if (collabSubmitHelpers && collabSubmitHelpers.resolveAttachmentPath) {
                try {
                    collabSubmitHelpers.resolveAttachmentPath(a.file_name);
                } catch (pathErr) {
                    result.invalid_pointer.push({
                        attachment_id: a.id,
                        requestId: a.collab_request_id,
                        file_name: a.file_name,
                        reason: pathErr.message
                    });
                    continue;  // 越界的 file_name 跳过比对
                }
            }
            // 规范化 relpath（统一正斜杠 + 去前导 ./）作为 Map key
            const relKey = String(a.file_name || '').replace(/\\/g, '/').replace(/^\.\//, '');
            if (!relKey) continue;
            if (a.status === 'active') activeFiles.set(relKey, a);
            else if (a.status === 'superseded') supersededFiles.set(relKey, a);
            else if (a.status === 'failed') failedFiles.set(relKey, a);
        }

        // 磁盘扫描（也用相对 uploads 根的 relpath 作为 key，与 DB file_name 形式对齐）
        // diskRoot = path.dirname(collabRoot) = uploads 绝对路径；relpath 形如 'collab/{rid}_xxx/file'
        const diskRoot = path.dirname(collabRoot);
        let entries;
        try {
            entries = fs.readdirSync(collabRoot, { withFileTypes: true });
        } catch (e) {
            log.error(`[collab-integrity] 读 ${collabRoot} 失败: ${e.message}`);
            result.errors.push({ type: 'READ_ROOT', detail: e.message });
            return result;
        }

        const diskFilesByRelpath = new Map(); // relpath -> fullpath
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            // 跳过 _pending（临时上传区）和 _orphaned（隔离区）
            if (e.name === '_pending' || e.name === '_orphaned') continue;
            const subDir = path.join(collabRoot, e.name);
            try {
                const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                for (const sf of subEntries) {
                    if (!sf.isFile()) continue;
                    const fullpath = path.join(subDir, sf.name);
                    const relKey = path.relative(diskRoot, fullpath).replace(/\\/g, '/');
                    diskFilesByRelpath.set(relKey, fullpath);
                }
            } catch (subErr) {
                log.warn(`[collab-integrity] 读子目录 ${subDir} 失败: ${subErr.message}`);
                result.errors.push({ type: 'READ_SUBDIR', detail: subErr.message, path: subDir });
            }
        }

        // §4.3 分类比对（按 relpath key）
        // 1) dangling pointer: DB active 文件 -> 磁盘没有
        for (const [rel, row] of activeFiles.entries()) {
            if (!diskFilesByRelpath.has(rel)) {
                result.dangling_pointer.push({
                    requestId: row.collab_request_id,
                    attachment_id: row.id,
                    file_name: row.file_name,
                    original_name: row.original_name
                });
            }
        }
        // 2) superseded retain: DB superseded 文件 -> 磁盘存在（合法）
        for (const [rel] of supersededFiles.entries()) {
            if (diskFilesByRelpath.has(rel)) result.superseded_retain += 1;
        }
        // v1.70.0 新增：failed retain: DB failed 文件 -> 磁盘存在（合法的撞墙保留物）
        // failed 磁盘缺失也算 dangling_pointer（admin 后续可能想下载查询）
        for (const [rel, row] of failedFiles.entries()) {
            if (diskFilesByRelpath.has(rel)) {
                result.failed_retain += 1;
            } else {
                result.dangling_pointer.push({
                    requestId: row.collab_request_id,
                    attachment_id: row.id,
                    file_name: row.file_name,
                    original_name: row.original_name,
                    note: 'failed 附件磁盘文件缺失'
                });
            }
        }
        // 3) orphan: 磁盘文件 -> DB 无任何记录（含 active/superseded/failed 三态均无）
        for (const [rel, fullpath] of diskFilesByRelpath.entries()) {
            if (!activeFiles.has(rel) && !supersededFiles.has(rel) && !failedFiles.has(rel)) {
                result.orphan_file.push({ path: fullpath });
            }
        }

        // §4.4 汇总日志（L1）
        const dCount = result.dangling_pointer.length;
        const oCount = result.orphan_file.length;
        const sCount = result.superseded_retain;
        const fCount = result.failed_retain;
        const ipCount = result.invalid_pointer.length;
        if (dCount === 0 && oCount === 0 && ipCount === 0) {
            log.info(`[collab-integrity] 巡检通过：active ${activeFiles.size} 条全在；superseded 保留 ${sCount} 份；failed 保留 ${fCount} 份；无孤儿文件 / 无 invalid_pointer`);
        } else {
            log.warn(`[collab-integrity] 巡检发现问题：dangling_pointer=${dCount}，orphan_file=${oCount}，invalid_pointer=${ipCount}，superseded_retain=${sCount}，failed_retain=${fCount}`);
            if (dCount > 0) {
                const sample = result.dangling_pointer.slice(0, sampleLimit);
                log.warn(`[collab-integrity] dangling_pointer 样例(前${sample.length}/${dCount})：${JSON.stringify(sample)}`);
            }
            if (oCount > 0) {
                const sample = result.orphan_file.slice(0, sampleLimit);
                log.warn(`[collab-integrity] orphan_file 样例(前${sample.length}/${oCount})：${JSON.stringify(sample)}`);
            }
            if (ipCount > 0) {
                const sample = result.invalid_pointer.slice(0, sampleLimit);
                log.warn(`[collab-integrity] invalid_pointer 样例(前${sample.length}/${ipCount})：${JSON.stringify(sample)}`);
            }
        }

        return result;
    } catch (e) {
        // 顶层 catch（M3 非阻塞兜底）
        log.error(`[collab-integrity] 巡检异常（非阻塞）: ${e.message}`);
        result.errors.push({ type: 'UNEXPECTED', detail: e.message });
        return result;
    }
}

module.exports = {
    placeholderSmokeTest,
    activateNewVersion,
    scanOrphansAndDanglingPointers,
    // 内部 helper 暴露便于测试
    _internal: {
        ensureInsideRoot,
        computeAttachmentDirName,
        moveToOrphaned,
        moveToOrphanedSubdir,        // v1.70.0
        cleanupMovedFiles,
        insertFailedAttachments      // v1.70.0
    }
};
