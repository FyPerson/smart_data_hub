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
// C1（数据协作接入外部源 G1）：sql_validation_status 唯一枚举源 + 写入前置断言
const { assertSqlValidationStatus, VALIDATION_MODES } = require('./collab-validation-status');

// ---------------------------------------------------------------------------
// §0 可版本化开发交付物 attachment_type 白名单（v1.70.2 codex 28 审 #4）
// ---------------------------------------------------------------------------
//
// 设计动机：
//   activateNewVersion §3.6 步骤 b UPDATE supersede 时只能针对"可版本化的开发交付物"，
//   不能误超 admin 创建时上传的 example_xlsx（数据模板）/ screenshot（原始单据截图）—
//   这两类业务上无"新旧版本"语义，提交版本切换时应保持 active 不动。
//
// ⭐ 维护约束（未来新增 attachment_type 时必读）：
//   - 新增的 attachment_type 若属于"开发交付物 + 每次提交可替换"语义 → 必须扩展此白名单
//   - 新增的 attachment_type 若属于"admin/对接人初始上传 + 业务无替换语义"（如 v1.71.0 三级转发
//     的导出结果若 admin 也参与）→ 不应入此白名单，由"创建时上传"路径单独管理
//   - failed 路径目前不 supersede 旧 active（v1.70.0 Step 1 设计），如未来 failed 改造同样需
//     调用此白名单守卫，防止误伤 admin 附件
const VERSIONED_DELIVERY_ATTACHMENT_TYPES = ['result_data', 'result_script'];

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
// §2.5 v1.72.0 落盘文件名统一 OA 格式（codex 31 spec-critique 修订版 v1.4）
// ---------------------------------------------------------------------------
//
// 格式：{oa_request_no}_{YYYYMMDD}_{nnn}_{rd|rs|sc|ex}[_failed]_{safeName}.{ext}
// 注：生产 oa_request_no 字段值已含 OA- 前缀（如 'OA-364265' / 'TEST-OA123456'），
//     helper 不再补 OA- 前缀，避免双前缀。生成示例：OA-364265_20260522_001_rd_示例用户A.xlsx
//
// 双轨制 seq 来源（codex 31 H-1 修订）：
//   - rd/rs（result_data/result_script）：复用 submission_version 作为 seq
//     → 与现有"版本号"语义一致；事务内已分配；零并发风险
//   - sc/ex（screenshot/example_xlsx）：用新增列 attachment_seq，
//     调用方 BEGIN IMMEDIATE 短事务内 SELECT MAX(attachment_seq)+1 预分配
//
// failed 路径（codex 31 H-3 + codex 47 M-4 修订）：
//   - rd/rs failed：用 newVer（oldVer+1，即本次尝试版本号）作 seq + 加 _failed 后缀
//     → 同 newVer 下 active 和 failed 区分仅靠 _failed 后缀；与 §3.4 active 名同 seq 但加后缀避免冲突
//     注意：DB 行 submission_version 仍写 0（不晋升）+ failed_attempt_seq 由 insertFailedAttachments 计算
//     文件名 seq 与 DB submission_version 在 failed 路径**有意分离**——文件名表达"尝试版本"语义
//   - sc/ex 不进 failed 路径（仅 rd/rs 会过 smoke test）
//
// helper 不查 DB，纯函数；调用方负责传 seq + isFailed
//
// 字符净化（codex 31 M-1 实证轻量版）：
//   - safeOa：替换 [\\/:*?"<>|] + 空格 + _ → -；trim
//   - safeName：替换 [\\/:*?"<>|] → _；trim；空 fallback username；
//     按 code point 截前 10 防 surrogate pair；
//   - safeExt：path.extname 已小写化（调用方负责传扩展名）
//
// 类型缩写（codex 31 M-2 修订）：
//   - result_data → rd
//   - result_script → rs
//   - screenshot → sc
//   - example_xlsx → ex
//   - pdf 类型 v1.72.0 一并清理（生产 0 行 + 无前端入口）

const ATTACHMENT_TYPE_TO_ABBR = {
    result_data: 'rd',
    result_script: 'rs',
    screenshot: 'sc',
    example_xlsx: 'ex',
    data_scope: 'ds'        // v1.77.0 数据范围说明（如"A部门,B部门…"），走 sc/ex 同款 attachment_seq 通道
};

/**
 * 净化 OA 号（codex 31 M-1）
 * @param {string} oaRequestNo
 * @returns {string} 净化后值；空时 throw
 */
function sanitizeOaRequestNo(oaRequestNo) {
    const raw = String(oaRequestNo || '').trim();
    if (!raw) {
        const e = new Error('OA 流程号为空，无法生成文件名');
        e.code = 'OA_REQUEST_NO_REQUIRED';
        throw e;
    }
    return raw
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/_/g, '-');
}

/**
 * 净化上传人姓名段（codex 31 M-1 + L-1 fallback 到 username）
 * @param {string} displayName  users.display_name 优先
 * @param {string} username     fallback
 * @returns {string} 净化后值；按 code point 截前 10
 */
function sanitizeUploaderName(displayName, username) {
    const base = String(displayName || '').replace(/[\\/:*?"<>|]/g, '_').trim()
        || String(username || '').replace(/[\\/:*?"<>|]/g, '_').trim()
        || 'unknown';
    // 按 code point 截前 10（防 surrogate pair）
    return Array.from(base).slice(0, 10).join('');
}

/**
 * 把 collab_requests.created_at 转 YYYYMMDD（codex 31 M-3）
 * 接受 'YYYY-MM-DD HH:mm:ss' 或 ISO 字符串；无法解析时 throw
 * @param {string} createdAt
 * @returns {string} 8 位 YYYYMMDD
 */
function formatCreatedAtToYmd(createdAt) {
    const raw = String(createdAt || '').trim();
    if (!raw) {
        const e = new Error('created_at 为空，无法生成文件名日期段');
        e.code = 'INVALID_CREATED_AT';
        throw e;
    }
    // 优先匹配 'YYYY-MM-DD' 前缀（项目统一用 datetime('now','localtime')）
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) {
        const e = new Error(`created_at 格式无法解析: ${raw}`);
        e.code = 'INVALID_CREATED_AT';
        throw e;
    }
    return `${m[1]}${m[2]}${m[3]}`;
}

/**
 * 构造统一落盘文件名（v1.72.0 主入口）
 *
 * @param {object} params
 * @param {string} params.oaRequestNo     collab_requests.oa_request_no（必传非空）
 * @param {string} params.createdAt       collab_requests.created_at
 * @param {number} params.seq             rd/rs=submission_version；sc/ex=新分配 attachment_seq
 * @param {string} params.attachmentType  result_data|result_script|screenshot|example_xlsx|data_scope
 * @param {boolean} params.isFailed       smoke test 失败的 rd/rs
 * @param {string} params.displayName     上传人 display_name
 * @param {string} params.username        fallback username
 * @param {string} params.ext             含 . 的扩展名（如 '.xlsx'）
 * @returns {string} 落盘文件名
 * @throws  OA_REQUEST_NO_REQUIRED / INVALID_CREATED_AT / UNKNOWN_ATTACHMENT_TYPE / INVALID_SEQ
 */
function buildFinalAttachmentName(params) {
    const { oaRequestNo, createdAt, seq, attachmentType, isFailed, displayName, username, ext, typeOrdinal } = params;
    const safeOa = sanitizeOaRequestNo(oaRequestNo);
    const ymd = formatCreatedAtToYmd(createdAt);
    const abbr = ATTACHMENT_TYPE_TO_ABBR[attachmentType];
    if (!abbr) {
        const e = new Error(`未知 attachment_type: ${attachmentType}`);
        e.code = 'UNKNOWN_ATTACHMENT_TYPE';
        throw e;
    }
    if (!Number.isInteger(seq) || seq <= 0) {
        const e = new Error(`seq 必须为正整数: ${seq}`);
        e.code = 'INVALID_SEQ';
        throw e;
    }
    const seqStr = String(seq).padStart(3, '0');
    // 多文件上传 M2（RC-H1/RC2-M1）：同次提交多个同类型文件用 newVer 作 seq 会撞名互相覆盖（active rename 在 smoke 前）。
    //   typeOrdinal（该类型第几个，从 1 起；不入 DB，仅文件名）拼进名字保唯一：rd_01 / rd_02。
    //   active 与 failed rename 传同一个 typeOrdinal（_failed 后缀再区分 active/failed）。仅同类型 ≥2 个才编号。
    //   ⚠️ 可选参数，下列两种都不传 typeOrdinal → 产出与改前**逐字节相同**的旧名（零回归）：
    //      ① sc/ex/ds（attachment_seq 通道，每文件 seq 已不同）；② rd/rs 单文件提交（grouping 对单文件清 typeOrdinal）。
    const ordinalSuffix = (Number.isInteger(typeOrdinal) && typeOrdinal > 0)
        ? `_${String(typeOrdinal).padStart(2, '0')}` : '';
    const failedSuffix = isFailed ? '_failed' : '';
    const safeName = sanitizeUploaderName(displayName, username);
    const safeExt = String(ext || '').toLowerCase();
    // safeOa 已包含 OA-xxx / TEST-OAxxx 自带前缀（生产实证），不再补 OA- 前缀
    return `${safeOa}_${ymd}_${seqStr}_${abbr}${ordinalSuffix}${failedSuffix}_${safeName}${safeExt}`;
}

/**
 * 为 sc/ex 类型预分配 attachment_seq（rd/rs 不走此函数 — 用 submission_version）
 *
 * 调用方须在 BEGIN IMMEDIATE 事务内执行：
 *   SELECT MAX(attachment_seq) + 1 WHERE collab_request_id=? AND attachment_type=?
 *
 * @param {object} dbAsync   { getAsync }
 * @param {number} requestId
 * @param {string} attachmentType  'screenshot' / 'example_xlsx' / 'data_scope'（v1.77.0）
 * @returns {Promise<number>} 下一个可用 attachment_seq（从 1 开始）
 */
const SEQ_CHANNEL_TYPES = new Set(['screenshot', 'example_xlsx', 'data_scope']);
async function allocateAttachmentSeq(dbAsync, requestId, attachmentType) {
    if (!SEQ_CHANNEL_TYPES.has(attachmentType)) {
        // rd/rs 不应走此函数（用 submission_version）
        const e = new Error(`allocateAttachmentSeq 仅支持 sc/ex/ds 类型: ${attachmentType}`);
        e.code = 'INVALID_ALLOC_TYPE';
        throw e;
    }
    const row = await dbAsync.getAsync(
        `SELECT COALESCE(MAX(attachment_seq), 0) AS max_seq
           FROM collab_attachments
          WHERE collab_request_id = ?
            AND attachment_type = ?`,
        [requestId, attachmentType]
    );
    return (row && row.max_seq || 0) + 1;
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
 * @param {string}   [params.validationMode] 'smoke'（缺省）| 'external_skip'
 * @param {Function} [params.revalidate] async fn() → void；validationMode='external_skip' 时
 *        **必传**——写事务内、任何 INSERT/UPDATE 之前调用一次，二次复核外部源登记仍有效
 *        （D25，codex 06 审 H1）；抛错走既有事务异常路径（ROLLBACK + moveToOrphaned）。
 *        smoke 模式不需要/不会调用。
 * @returns {Promise<{ newVer: number, attachmentDir: string, smokeTestResult: object, validationMode: string, validationStatus: string }>}
 * @throws  非法 mode → { code:'INVALID_VALIDATION_MODE' }
 *          external_skip 未传 revalidate → { code:'REVALIDATE_REQUIRED' }
 *          乐观锁失败 → { code:'CONCURRENT_SUBMIT', orphanedDir }
 *          完整快照缺漏 → { code:'INCOMPLETE_SNAPSHOT' }
 *          smoke test 失败 → { code:'SMOKE_TEST_FAILED', smokeError }
 *          路径校验失败 → { code:'PATH_VIOLATION', detail }
 */
async function activateNewVersion(params) {
    const { db, dbAsync, requestId, oldVer, collabRoot, description, attachmentDir,
            oaRequestNo, collabCreatedAt,
            uploadedFiles, runSmokeTest, logger,
            validationMode = VALIDATION_MODES.smoke, revalidate } = params;
    const log = logger || console;

    // 数据协作接入外部源（v1.6 方案 §3.3 B）：mode 枚举校验必须在函数入口、任何文件移动之前——
    //   不合法值直接 throw，绝不能带着一个未知 mode 往下走到 §3.4 的 rename/§3.6 的 UPDATE。
    if (validationMode !== VALIDATION_MODES.smoke && validationMode !== VALIDATION_MODES.external_skip) {
        const err = new Error(`activateNewVersion: 非法 validationMode='${validationMode}'（仅允许 '${VALIDATION_MODES.smoke}'/'${VALIDATION_MODES.external_skip}'）`);
        err.code = 'INVALID_VALIDATION_MODE';
        throw err;
    }
    // 〔D25·codex 06 审 H1 采纳〕external_skip 分支从阶段一命中"已登记免验"到本函数真正写库激活
    // 之间，存在一个未复查窗口：若在此期间该连接的登记被并发撤销（删行/改 type/改 code），
    // external 分支仍会照常免验落 DONE。堵法：external_skip 模式**必传** revalidate（写事务内、
    // UPDATE 之前调用一次），缺失视为调用方违反契约——与非法 mode 同级，函数入口就近拒绝，
    // 不允许带着"没有复查手段"的 external_skip 往下走到任何文件操作。smoke 模式不需要
    // revalidate（它本身就是"当场真连库跑 smoke"，不存在同类窗口）。
    if (validationMode === VALIDATION_MODES.external_skip && typeof revalidate !== 'function') {
        const err = new Error('activateNewVersion: validationMode=external_skip 时 revalidate 必传（写库前二次复核登记状态）');
        err.code = 'REVALIDATE_REQUIRED';
        throw err;
    }

    // §3.1 完整快照校验
    //   多文件上传 M2（H-1，方案 §B）：原"每类恰好 1 个"放宽为「各 1..5 个」（D2/D3）。
    //   多文件不撞（限"同一次提交内"）：active 行 idx_collab_att_version 为普通索引（非 UNIQUE），靠文件名 typeOrdinal 防同次磁盘覆盖；
    //   failed 行靠 insertFailedAttachments 逐文件 failed_attempt_seq 自增防撞 DB 唯一索引 idx_collab_att_failed_seq_unique。
    //   跨重试 failed 防覆盖（M-C，codex/ultracode 审）：smoke 连续失败重试时 submission_version 不晋升 → newVer/typeOrdinal 重复，
    //      failed rename 已加 existence _rN 去重（见 §3.5 failed 分支），保住每一轮 failed 物理留证不被覆盖。
    //   仅允许 result_data / result_script 两类（防上游误传第三类绕过计数）。
    const countByType = uploadedFiles.reduce((acc, f) => {
        acc[f.attachment_type] = (acc[f.attachment_type] || 0) + 1;
        return acc;
    }, {});
    const dataCount = countByType.result_data || 0;
    const scriptCount = countByType.result_script || 0;
    const otherTypes = Object.keys(countByType).filter(t => t !== 'result_data' && t !== 'result_script');
    if (dataCount < 1 || dataCount > 5 || scriptCount < 1 || scriptCount > 5 || otherTypes.length > 0) {
        const err = new Error(
            `完整快照不规范：每次提交必须包含 1..5 个 result_data + 1..5 个 result_script（仅此两类），` +
            `实际 result_data=${dataCount}, result_script=${scriptCount}` +
            (otherTypes.length ? `, 非法类型=${otherTypes.join(',')}` : '')
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
    // v1.72.0：rd/rs 用 newVer (submission_version) 作 seq（codex 31 H-1 双轨制）
    const newVer = oldVer + 1;
    const movedFiles = []; // 用于失败回滚
    let scriptFinalPath = null;
    try {
        for (const f of uploadedFiles) {
            // v1.72.0 落盘命名 OA-{oa}_{YYYYMMDD}_{nnn}_{rd|rs}_{姓名}.{ext}
            // 多文件上传 M2（RC-H1/RC2-M1）：同次提交多个同类型文件用 newVer 作 seq 会撞名，靠 typeOrdinal 区分（rd_01/rd_02）。
            // smoke 失败的 _failed 后缀走下方 failed rename 分支（传同一个 typeOrdinal）
            const ext = path.extname(f.original_name || '');
            const finalName = buildFinalAttachmentName({
                oaRequestNo,
                createdAt: collabCreatedAt,
                seq: newVer,
                attachmentType: f.attachment_type,
                isFailed: false,
                displayName: f.uploaded_by_name,
                username: f.uploaded_by_name,  // POST /submit 上下文已用 display_name||username 合一
                ext,
                typeOrdinal: f.typeOrdinal,   // RC-H1：来自 orderedFiles，多文件防同名覆盖
            });
            const finalPath = path.join(targetDir, finalName);
            const finalCheck = ensureInsideRoot(finalPath, targetDir);
            if (!finalCheck.ok) {
                const err = new Error(`最终文件路径越界：${finalCheck.error}`);
                err.code = 'PATH_VIOLATION';
                throw err;
            }
            fs.renameSync(f.source_path, finalPath);
            movedFiles.push({ ...f, final_path: finalPath, final_name: finalName });
            // M-4/RC-M2：smoke 跑「第一份」上传脚本（orderedFiles 保序 = 上传序），取首个 result_script 后不再覆盖（原逻辑取最后一个）
            if (f.attachment_type === 'result_script' && scriptFinalPath === null) {
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
    // 数据协作接入外部源（v1.6 方案 §3.3 B）：external_skip 模式不调 runSmokeTest（入参本就可为
    //   null——external 分支上游 server.js 压根没构造 runSmokeTestClosure），合成一个恒 ok:true 的
    //   冻结结果，rowCount/columns 均为 null（平台无法连库，没有真实列/行数可报）。
    // 〔M1·codex 06 审措辞收窄〕原口径"external_skip 永不进入 cleanupMovedFiles"是绝对化表述，
    // 已被 D25 的 revalidate 机制打破——现在收窄为准确的两句话：
    //   ① external_skip 仍然**不会**进入下面 482-488 行的 cleanupMovedFiles catch（那是
    //      smoke test 引擎自己抛错时的清理，external_skip 压根不调 runSmokeTest）、也不会进入
    //      490 行起的 "ok=false → _failed rename" 分支（合成结果 ok 恒 true）——这两条 smoke
    //      专属路径的判断没有变。
    //   ② 但 external_skip 现在有一条**独立**的失败路径：写事务内 revalidate() 抛错，走的是
    //      §3.6 末尾统一的事务异常 catch（ROLLBACK + moveToOrphaned），这条清理路径 smoke/
    //      external_skip 两种模式通用、共用同一段代码（U4 已用"构造乐观锁冲突"的方式验证过
    //      moveToOrphaned 对 external_skip 模式确实生效）。
    let smokeTestResult;
    if (validationMode === VALIDATION_MODES.external_skip) {
        // S5〔主会话预筛·2026-09-02〕`skipped: 'external'` 是方案 §3.3 冻结的标识字段——
        // 当前调用链（server.js 响应体、recordQualityForDeveloperSubmit）都不读取这个字段，
        // 纯为下游/日志诊断预留（未来若要在响应体/日志里区分"跳过原因"，不必再改这条合成
        // 结果的 schema）。保留字段本身不引入行为——只是多一个没人读的 key。
        smokeTestResult = Object.freeze({ ok: true, validatedAt: new Date(), rowCount: null, columns: null, skipped: 'external' });
    } else {
        try {
            smokeTestResult = await runSmokeTest(scriptFinalPath);
        } catch (e) {
            // smoke test 抛错（含 placeholder 的 SMOKE_TEST_NOT_IMPLEMENTED / SMOKE_MUTEX_WAIT_TIMEOUT / RUNNING_UPDATE_*）
            // → 删本次文件 + 透传错误
            // 注意：这类是"smoke test 引擎自己出问题"，不属于"业务 SQL 错"，仍走删除路径
            await cleanupMovedFiles(movedFiles, log);
            throw e;
        }
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
        // v1.72.0：smoke 失败 → 把 active 名 rename 为 failed 名（加 _failed 后缀）
        // 同 newVer 序号下区分 active 和 failed 靠 _failed 后缀
        for (const mf of movedFiles) {
            const ext = path.extname(mf.original_name || '');
            let failedName = buildFinalAttachmentName({
                oaRequestNo,
                createdAt: collabCreatedAt,
                seq: newVer,
                attachmentType: mf.attachment_type,
                isFailed: true,
                displayName: mf.uploaded_by_name,
                username: mf.uploaded_by_name,
                ext,
                typeOrdinal: mf.typeOrdinal,   // RC-H1：active+failed rename 全路径传同一个，多文件 failed 防同名覆盖
            });
            const failedDir = path.dirname(mf.final_path);
            let failedPath = path.join(failedDir, failedName);
            // M-C（codex/ultracode 审）：smoke 失败不晋升 submission_version → newVer 恒定、typeOrdinal 重算，
            //   同单连续失败重试时 failedName 会与上一轮相同 → fs.renameSync 静默覆盖、丢历次失败留证。
            //   存在即加 _rN 后缀去重（保住每一轮 failed 物理文件；DB file_name 写去重后实际名，与磁盘一致）。
            if (fs.existsSync(failedPath)) {
                const p = path.parse(failedName);
                let n = 2;
                while (fs.existsSync(path.join(failedDir, `${p.name}_r${n}${p.ext}`))) n++;
                failedName = `${p.name}_r${n}${p.ext}`;
                failedPath = path.join(failedDir, failedName);
            }
            try {
                fs.renameSync(mf.final_path, failedPath);
                mf.final_path = failedPath;
                mf.final_name = failedName;
            } catch (renameErr) {
                log.warn(`[collab-versioning] failed 重命名失败 ${mf.final_path} → ${failedPath}: ${renameErr.message}`);
                // 保留原 active 名，DB 仍记录新路径（虽不一致但不影响业务）
            }
        }
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
    // newVer 已在 §3.4 顶部计算（v1.72.0 提前用于 rd/rs finalName 生成）
    const validatedAt = smokeTestResult.validatedAt || new Date();
    try {
        await dbAsync.runAsync('BEGIN TRANSACTION');

        // 〔D25·codex 06 审 H1〕external_skip 二次复核：写事务内、任何 INSERT/UPDATE 之前调用
        // revalidate()，重新确认该外部源登记在"阶段一命中"到"这一刻真正写库"之间没有被并发
        // 撤销（删行/改 type/改 code）。revalidate 抛错会被下方统一的事务异常 catch 接住
        // （ROLLBACK + moveToOrphaned 把本次文件挪到 _orphaned + 透传错误），与其他事务内异常
        // 走同一条路径，不单独开分支。smoke 模式不传 revalidate，这里天然跳过。
        if (validationMode === VALIDATION_MODES.external_skip) {
            await revalidate();
        }

        // a. INSERT 新版本
        // ⚠️ 取首契约护栏（M-B，codex 审）：严格按 movedFiles 顺序（= orderedFiles = 上传序）逐条 INSERT，
        //   使自增 id 序 = 上传序——passed/failed 双校验取首（SELECT ORDER BY id ASC + find）依赖此不变量。
        //   禁改为「按 attachment_type 分组 / 批量 / 并发」插入，否则取首会从"首份上传"退化为"首个插入"。
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
        // v1.70.2 修：WHERE 加 attachment_type 白名单限定（codex 28 审 #4 抽常量）
        // 根因：原 SQL 只按 submission_version=oldVer 匹配，会误把 admin 同期上传的
        //   example_xlsx（数据模板）和 screenshot（原始单据截图）一锅端置 superseded
        //   →  详情页 filter status='active' 拉不到 → DONE 状态下"数据模板"/"原始单据截图"区块空显
        // 修法：用 VERSIONED_DELIVERY_ATTACHMENT_TYPES 常量限定只 supersede 可版本化开发交付物
        const typePlaceholders = VERSIONED_DELIVERY_ATTACHMENT_TYPES.map(() => '?').join(',');
        await dbAsync.runAsync(
            `UPDATE collab_attachments
                SET status='superseded', superseded_at=datetime('now','localtime')
              WHERE collab_request_id=?
                AND status='active'
                AND submission_version=?
                AND attachment_type IN (${typePlaceholders})`,
            [requestId, oldVer, ...VERSIONED_DELIVERY_ATTACHMENT_TYPES]
        );

        // c. UPDATE collab_requests（乐观锁 + 写 attachment_dir）
        // v1.70.2 修：sql_validated_at 改用 datetime('now','localtime') 与项目其他时间字段统一（done_at/failed_at/created_at 都用本地时间）
        // 原 validatedAt.toISOString() 写 ISO 8601 UTC 导致前端 fmtDate 截前 16 字符显示比北京时间早 8 小时（codex 27 审 #5 修正方向）
        // 例：OA-364265 实际北京时间 15:45 通过 smoke，DB 存 ISO UTC 07:45Z，前端截显 "2026-05-22 07:45"
        // 入参 validatedAt 仍保留接收但不写库（向后兼容签名；当前无外部调用方依赖此入参传入后被持久化）
        // 数据协作接入外部源（v1.6 方案 §3.3 B）：写入值按 mode 二选一——external_skip 写
        //   'external_skipped'，否则写 'passed'。实参保持三元整体传入 assertSqlValidationStatus
        //   （而非拆成 if/else 两次独立 assert 调用）：拆两支会让"文本序上离写入点最近的 assert
        //   调用"只剩后写的那一支，静态覆盖守卫（G1）测不到未命中的另一支——三元单点更安全，
        //   G1 侧已扩展出"三元实参"解析路径配合本写法（见 verify-collab-validation-status-coverage.js）。
        const validationStatus = assertSqlValidationStatus(
            validationMode === VALIDATION_MODES.external_skip ? 'external_skipped' : 'passed'
        ); // C1 G1
        const upd = await dbAsync.runAsync(
            `UPDATE collab_requests
                SET submission_version=?,
                    sql_validation_status='${validationStatus}',
                    sql_validated_at=datetime('now','localtime'),
                    status='DONE',
                    done_at=datetime('now','localtime'),
                    attachment_dir=?
              WHERE id=? AND submission_version=?`,
            [newVer, dirName, requestId, oldVer]
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
        return { newVer, attachmentDir: dirName, smokeTestResult, validationMode, validationStatus };
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
 * ⭐ 维护约束（v1.70.2 codex 28 审 #6）：
 *   - 当前 failed 路径**只 INSERT 新 failed 行**，**不 supersede 旧 active**（与 activateNewVersion 不同）
 *   - 因此不需要 VERSIONED_DELIVERY_ATTACHMENT_TYPES 守卫
 *   - 若未来 failed 改造需要 supersede 旧版本（如"撞墙重提时清旧 failed"），必须用
 *     VERSIONED_DELIVERY_ATTACHMENT_TYPES 白名单守卫防误伤 admin 附件
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
        // 多文件上传 M2（H-2）：同次提交同类型可多文件，failed_attempt_seq 须**逐文件** MAX+1 自增
        //   （原逻辑每类型只算一次 seq、全类型文件复用同值 → 多 failed 同类型撞 idx_collab_att_failed_seq_unique）。
        //   seqCursor 记每类型「下一个待分配 seq」，首文件取 MAX+1，之后每文件用当前值再自增。
        const seqCursor = new Map();  // attachment_type → 下一个待分配 failed_attempt_seq
        for (const mf of movedFiles) {
            if (!seqCursor.has(mf.attachment_type)) {
                const row = await dbAsync.getAsync(
                    `SELECT COALESCE(MAX(failed_attempt_seq), 0) AS max_seq
                       FROM collab_attachments
                      WHERE collab_request_id = ?
                        AND attachment_type = ?
                        AND status = 'failed'`,
                    [requestId, mf.attachment_type]
                );
                seqCursor.set(mf.attachment_type, (row && row.max_seq || 0) + 1);
            }
            const relPath = collabRootRel(mf);
            const seq = seqCursor.get(mf.attachment_type);
            seqCursor.set(mf.attachment_type, seq + 1);  // H-2：自增供同类型下一个文件，逐文件唯一
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
                file_name: relPath,
                original_name: mf.original_name,   // RC-M2/M-2：failed 路径双校验取首需 original_name 识别 excel 扩展名
            });
        }
        await dbAsync.runAsync('COMMIT');
        log.info(`[collab-versioning] 协作单 #${requestId} 撞墙附件保留 ${inserted.length} 个 (${inserted.map(a => `${a.attachment_type}#${a.failed_attempt_seq}`).join(', ')})`);
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
        // file_name 形如 'collab/{rid}_xxx/OA-{oa}_{YYYYMMDD}_{nnn}_{rd|rs|sc|ex}[_failed]_{姓名}.{ext}'（v1.72.0 起；旧单据为 {ts}_{rand}_name.ext），全局唯一不会撞同名
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
    // v1.70.2 codex 28 审 #4：暴露常量供测试 + 历史修复脚本未来扩展引用
    VERSIONED_DELIVERY_ATTACHMENT_TYPES,
    // v1.72.0 落盘文件名统一 OA 格式（endpoint 直接调用）
    buildFinalAttachmentName,
    allocateAttachmentSeq,
    sanitizeOaRequestNo,             // 暴露便于测试 / e2e 断言
    sanitizeUploaderName,
    formatCreatedAtToYmd,
    ATTACHMENT_TYPE_TO_ABBR,
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
