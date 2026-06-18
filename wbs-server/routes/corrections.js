// routes/corrections.js — 数据修正模块（从 server.js 抽离，巨型文件拆分首试点）
// 生成：scripts/build-routes-corrections.js 程序化切割 server.js 三区（行为零变更）
//   区1 readiness(原195-245) / 区2 DDL+migration(1991-2261) / 区3 主体+18端点(18289-19802)
//   16 共享符号经 deps 局部注入；18 端点 app.xxx('/api/corrections...') 改 router.xxx('/...')
//   导出 { initSchema, router, _internals }——_internals 供 verify require 真实逻辑（根治 RC-L2 复刻漂移）
//   ⚠️ 区1/2/3 代码为程序化切割保持 0 缩进，实际位于下方 module.exports factory 作用域内（非文件顶层变量）。
'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dingtalkNotify = require('../utils/dingtalk-notify');
const collabVersioning = require('../utils/collab-attachment-versioning');
const collabSubmitHelpers = require('../utils/collab-submit-helpers');

module.exports = (deps) => {
  // codex M-2：工厂期 deps 校验——漏注入即启动期失败（而非深层端点运行期才 xxx is not a function）。
  const REQUIRED_DEPS = ['logger', 'db', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken', 'requireAdmin', 'requirePublisherOrAdmin', 'sendIssueDingtalkRaw', 'UPLOAD_DIR', 'readSystemConfig', 'COLLAB_CHAT_ADMIN_ID', 'callDingtalkWithTokenRetry', 'normalizeAttachmentExt', 'safeDeleteFileSync', 'maskPhone'];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/corrections 缺注入依赖: ' + __k);
  }
  const {
    logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken, requireAdmin, requirePublisherOrAdmin, sendIssueDingtalkRaw, UPLOAD_DIR, readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry, normalizeAttachmentExt, safeDeleteFileSync, maskPhone
  } = deps;

// ============================================================
// 区1：schema readiness state + 中间件 + 列定义常量 + source 白名单（原 server.js 195-245）
// ============================================================
// ── 数据修正模块 schema readiness（方案 §5.1 / §7 / 复用清单 server.js:108-187）──────────
//   correction 是全新模块（correction_requests/correction_attachments/correction_status_history 三表，
//   8 态状态机 + 5 群字段），全新表用 CREATE TABLE IF NOT EXISTS 一次建全（无 ALTER，方案 §9 约束 24）。
//   migration 函数只 PRAGMA 复查三表 + 关键列就位才置 ready；未就绪挡 correction 写入口（503），其他模块正常。
//   readiness 闸门 = 冗余防线 + 首启短暂窗口保护（方案 §7：migration 完成前 ready=false，避免首启报错）。
const CORRECTION_SCHEMA_STATE = { ready: false, error: null };
// migration 后 PRAGMA 复查这三表各自的关键列全部到位才置 ready（不穷举全字段，挑 8 态/群/通知锚点列）
const CORRECTION_REQUIRED_TABLES = ['correction_requests', 'correction_attachments', 'correction_status_history', 'correction_requesters'];
// readiness 复查是"启动期就绪抽样"——挑代表性关键不变量（8 态锚点/群字段/责任链），
//   不做全字段全量校验（那是 verify-correction-schema.js 的职责）。全新模块无 ALTER，
//   CREATE 要么整表成功要么 firstCorrDdlError 兜底，单个可空辅助列不会"缺失"，无需逐列复查。
//   （codex 08 M-1 建议补成 62 列全集，经核实为职责混淆 + 纯冗余，驳回；保持精简。）
const CORRECTION_REQUESTS_KEY_COLS = [
    'correction_type', 'batch_completion_note', 'submission_count',
    'fixed_at', 'refixed_at', 'source_system_other',
    'completion_notify_status', 'archived_at', 'friction_reason', 'voided_at',
    'created_by', 'relay_notified_user_id',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at',
    'dingtalk_chat_created_by', 'dingtalk_chat_name',
    // v1.81.0 复审优化 H 新增列（codex 24 H-1）：纳入 readiness 抽样，旧库缺列→503 拦截
    //   （防删 expected_value 后旧表残留 NOT NULL 导致建单 500；对齐 issue requireIssueV1750SchemaReady 范式）
    'correction_count', 'relay_notify_status', 'closure_type',
    // 本次细优②（2026-06-17）：创建人通知（开发/对接人告知建单人）四件套锚点——已上线表 ALTER 后须复查它就位才 ready
    //   （C-1 codex 36/37：ALTER 必须在下方 missingCols 复查【之前】完成，见 runCorrectionMigration [2a]/[2b]）。
    'creator_notify_status',
    // 跨系统关联方案（L1，2026-06-18）：组键入 readiness 抽样——已上线表 ALTER 后须复查就位才 ready
    //   （C-1 硬性顺序：ALTER 在 missingCols 复查【之前】完成，见 runCorrectionMigration [2a-x]）。
    //   error_proof_note 不入（可空辅助列，缺失不影响核心写入口，方案 §5.1）。
    'correction_group_id'
];
// codex 08 H-1：CORRECTION_SCHEMA_STATE 是"三表"就绪闸门，readiness 须对称复查三表关键列，
//   不能只验主表（否则附件/历史表 DDL 引入 bug 时仍放行）。两表只需验各自的 NOT NULL 锚点列：
//   附件 uploaded_by（R-3 归属责任链）、历史 to_status（唯一审计 NOT NULL），各加 correction_request_id。
const CORRECTION_ATTACHMENTS_KEY_COLS = ['correction_request_id', 'attachment_type', 'file_name', 'uploaded_by'];
const CORRECTION_HISTORY_KEY_COLS = ['correction_request_id', 'to_status', 'created_at'];
// 两表 NOT NULL 锚点列（PRAGMA table_info 的 notnull=1 必须命中，防旧表/半成品表缺约束）
const CORRECTION_ATTACHMENTS_NOTNULL_COLS = ['correction_request_id', 'attachment_type', 'file_name', 'uploaded_by'];
const CORRECTION_HISTORY_NOTNULL_COLS = ['correction_request_id', 'to_status'];
// ── 跨系统关联方案 §5.2 / §6.6（L1）：业务方子表 readiness 锚点 + 完成通知状态枚举 ──────────
//   correction_requesters 是多业务方完成通知真相源（普适）。readiness 对称复查其关键列 + NOT NULL 锚点
//   （缺列/缺约束时拦截，否则 L2 notify-done 写子表运行期报错）。
//   完成通知状态唯一枚举：writeCorrectionRequesters（L2）写入校验 + 迁移回填 COALESCE 兜底共用。
const CORRECTION_REQUESTERS_KEY_COLS = ['correction_request_id', 'requester_name', 'is_primary', 'seq', 'completion_notify_status'];
const CORRECTION_REQUESTERS_NOTNULL_COLS = ['correction_request_id', 'requester_name', 'is_primary', 'seq'];
const CORRECTION_REQUESTER_NOTIFY_STATUSES = ['not_sent', 'sent', 'failed', 'no_phone'];
// 守门中间件：Commit B 起所有 correction 写入口（建单/指派/流转/拉群/通知）挂在路由前。
//   readiness=false → 503，避免建表/迁移失败被吞后入口运行期 SQL 崩。
function requireCorrectionSchemaReady(req, res, next) {
    if (CORRECTION_SCHEMA_STATE.error) {
        return res.status(503).json({
            error: '数据修正功能暂不可用：表结构未就绪',
            detail: CORRECTION_SCHEMA_STATE.error,
            code: 'CORRECTION_SCHEMA_NOT_READY'
        });
    }
    if (!CORRECTION_SCHEMA_STATE.ready) {
        return res.status(503).json({
            error: '数据修正功能正在初始化，请稍后重试',
            code: 'CORRECTION_SCHEMA_INITIALIZING'
        });
    }
    next();
}

// ── 数据修正·所属系统白名单（方案 §5.1 / R-5）─────────────────────────────────
//   Commit A 顺手定义（无害常量，Commit B 建单 source_system 校验用）。
//   source_system 必 ∈ 此白名单（含字面 '其他'）；='其他' 时 source_system_other 非空（B 阶段校验）。
const CORRECTION_SOURCE_SYSTEMS = [
    'BMS', 'CRM', 'HRD', '财务系统', 'OA 系统', 'FineDataLink数仓', '其他'
];

// ============================================================
// 区2：DDL + migration（原 server.js 1991-2261）。建表 serialize 块包进 initSchema()，
//   server.js 启动 initTable() 内调用 correctionModule.initSchema()（时序不变）。
// ============================================================
function initSchema() {
    // ==================== 数据修正模块 v1.81.0（Commit A schema）====================
    // 方案见 docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md §2 / §9
    // 全新模块三表（主表 + 附件表 + 状态历史表），8 态状态机 + 5 群字段，CREATE TABLE IF NOT EXISTS
    //   一次建全（无 ALTER，§9 约束 24）。CHECK 约束仅新库建表带（项目惯例：status/correction_type/
    //   completion_notify_status 等枚举不进 DB CHECK，靠后端写入口集中校验，§2.1/§9 约束 12）。
    // ⚠️ 与 collab v2 ALTER 块分离：correction 是全新表，独立 serialize 块保证 CREATE→INDEX 严格串行
    //   （CREATE INDEX 编译期校验列名，与 CREATE TABLE 并发会触发 "no such column" 竞态，同 1634 踩坑）。
    db.serialize(() => {
        // codex 范式（对齐需求跟踪 C1 1408-1414）：db.run 不传 callback 时前序失败不中止队列，
        //   "末条成功 ≠ 前面没失败"，故给每个 DDL 挂 recordCorrErr，migration 触发前据 firstCorrDdlError 判定。
        let firstCorrDdlError = null;
        const recordCorrErr = (label) => (err) => {
            if (err && !firstCorrDdlError) {
                firstCorrDdlError = `${label}: ${err.message}`;
                logger.error(`[数据修正 A] DDL 失败 @${label}：${err.message}`);
            }
        };

        // ── 2.1 correction_requests 主表（8 态全字段一次建全，含 5 群字段旁路）──────────
        db.run(`CREATE TABLE IF NOT EXISTS correction_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            -- 需求结构化字段（核心沉淀）
            source_system TEXT NOT NULL,
            source_system_other TEXT,
            location_info TEXT NOT NULL,     -- 修正方式（v1.81.0 复审优化 H：合并原"错误描述+期望值"为一个"错在哪+要改成什么"字段；列名沿用 location_info 减少改动面，删 expected_value §1.2）
            correction_count INTEGER CHECK (correction_count IS NULL OR (typeof(correction_count) = 'integer' AND correction_count >= 1)),  -- 修正条数（H/#6：可空记账字段，非空正整数；RC-L2 + codex24 M-2 DB 兜底 typeof 防 REAL 1.5）
            reason TEXT,
            oa_number TEXT,

            -- 单/批量数据修正区分（G-8，决定交付闸门）
            correction_type TEXT NOT NULL DEFAULT 'single',

            -- 业务方信息
            requester_dept TEXT,
            requester_name TEXT NOT NULL,
            requester_phone TEXT,

            -- 状态机（后端写入口集中校验枚举，不用 DB CHECK 跟项目惯例）
            status TEXT NOT NULL DEFAULT 'PENDING_ASSIGN',

            -- 双时间锚点
            expected_deadline DATETIME,
            dev_estimated_at DATETIME,

            -- 开发侧
            assigned_to INTEGER,
            assigned_to_name TEXT,
            assigned_by INTEGER,
            assigned_at DATETIME,

            -- 开发完成（G-8 批量必填描述 / G-12 提交次数）
            -- batch_completion_note 双语义复用（2026-06-18）：batch=批量完成说明（必填）/ single=首次完成补充说明（选填）；backlog 可迁移为通用 completion_note
            batch_completion_note TEXT,
            submission_count INTEGER DEFAULT 0,

            -- 流转时间戳（效率留痕）
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            estimated_replied_at DATETIME,
            fixed_at DATETIME,
            refixed_at DATETIME,

            -- 完成通知（G-11，建单人手动发，旁路不改状态）
            completion_notified_at DATETIME,
            completion_notify_status TEXT DEFAULT 'not_sent',
            completion_notify_message_key TEXT,
            completion_notify_error TEXT,
            completion_read_at DATETIME,

            -- 对接人转单通知（G-16 路径 B 旁路；v1.81.0 复审优化 H 预置投递审计四件套，I 接手动化+已读 §2.3）
            relay_notified_user_id INTEGER,
            relay_notified_at DATETIME,
            relay_notify_status TEXT DEFAULT 'not_sent',
            relay_notify_message_key TEXT,
            relay_notify_error TEXT,
            relay_read_at DATETIME,

            -- 归档（G-13 建单人收口终态；v1.81.0 复审优化 H 预置 closure_type 区分正常归档/行政闭环，I 接行政闭环 §3.4）
            archived_at DATETIME,
            archived_by INTEGER,
            archived_by_name TEXT,
            friction_reason TEXT,
            closure_type TEXT DEFAULT 'normal',
            closure_reason TEXT,

            -- 作废（G-14，软删除，前端隐藏不物理删，无恢复入口）
            voided_at DATETIME,
            voided_by INTEGER,
            voided_by_name TEXT,
            void_reason TEXT,

            -- 创建人（created_by 强制 NOT NULL，isCreator 可见性 + 归档/作废/通知权限锚点）
            created_by INTEGER NOT NULL,
            created_by_name TEXT,

            -- 终态（拒绝）
            rejected_at DATETIME,
            rejected_by INTEGER,
            rejected_by_name TEXT,
            reject_reason TEXT,

            -- 钉钉通知·开发侧（指派通知开发）
            notify_status TEXT DEFAULT 'not_sent',
            notified_at DATETIME,
            notify_message_key TEXT,
            notify_error TEXT,
            read_at DATETIME,

            -- 钉钉通知·业务方侧（开发回复预计时间时通知业务方）
            requester_notify_status TEXT DEFAULT 'not_sent',
            requester_notified_at DATETIME,
            requester_notify_message_key TEXT,
            requester_notify_error TEXT,
            requester_read_at DATETIME,

            -- 钉钉通知·创建人侧（本次细优②：开发/对接人告知建单人工作完成；creator_notify_status 必带 DEFAULT 对齐四件套，H-1）
            creator_notify_status TEXT DEFAULT 'not_sent',
            creator_notified_at DATETIME,
            creator_notify_message_key TEXT,
            creator_notify_error TEXT,
            creator_read_at DATETIME,

            -- ── 跨系统关联 + 错误证明（跨系统关联方案 §5.1，L1）──────────
            -- correction_group_id：跨系统关联组键（NULL=无组；非 NULL=主单 id；主单判定 id===correction_group_id）。入 KEY_COLS + 建索引。
            -- error_proof_note：建单错误证明说明（可选，配 error_proof 附件；不承载"要改什么"，需求本体仍是 location_info）。不入 KEY_COLS。
            correction_group_id INTEGER,
            error_proof_note TEXT,

            -- 升级讨论拉群（v1.3，旁路字段：不走 correctionTransition、不动 status，G-6）
            dingtalk_chat_id TEXT,
            dingtalk_open_conversation_id TEXT,
            dingtalk_chat_created_at DATETIME,
            dingtalk_chat_created_by INTEGER,
            dingtalk_chat_name TEXT
        )`, recordCorrErr('correction_requests'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_status ON correction_requests(status)`, recordCorrErr('idx_corr_status'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_assigned ON correction_requests(assigned_to)`, recordCorrErr('idx_corr_assigned'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_created_by ON correction_requests(created_by)`, recordCorrErr('idx_corr_created_by'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_dev_estimated ON correction_requests(dev_estimated_at)`, recordCorrErr('idx_corr_dev_estimated'));
        // 列表默认过滤 voided_at IS NULL（G-14）
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_voided ON correction_requests(voided_at)`, recordCorrErr('idx_corr_voided'));

        // ── 2.2 correction_attachments 附件表（error_proof / fix_proof）──────────────
        //   uploaded_by 强制 NOT NULL（R-3：归属责任链依赖此字段）。落盘目录 uploads/correction/{rid}/。
        db.run(`CREATE TABLE IF NOT EXISTS correction_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            correction_request_id INTEGER NOT NULL,
            attachment_type TEXT NOT NULL,
            file_name TEXT NOT NULL,
            original_name TEXT,
            file_size INTEGER,
            mime_type TEXT,
            uploaded_by INTEGER NOT NULL,
            uploaded_by_name TEXT,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (correction_request_id) REFERENCES correction_requests(id)
        )`, recordCorrErr('correction_attachments'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_att_rid ON correction_attachments(correction_request_id)`, recordCorrErr('idx_corr_att_rid'));

        // ── 2.3 correction_status_history 状态历史表（append-only，唯一审计留痕）──────
        db.run(`CREATE TABLE IF NOT EXISTS correction_status_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            correction_request_id INTEGER NOT NULL,
            from_status TEXT,
            to_status TEXT NOT NULL,
            reason TEXT,
            operator_id INTEGER,
            operator_name TEXT,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (correction_request_id) REFERENCES correction_requests(id)
        )`, recordCorrErr('correction_status_history'));
        db.run(`CREATE INDEX IF NOT EXISTS idx_corr_hist_rid ON correction_status_history(correction_request_id)`, recordCorrErr('idx_corr_hist_rid'));

        // ── 2.4 correction_requesters 业务方子表（跨系统关联方案 §5.2，L1）──────────────
        //   多业务方完成通知真相源（普适）：每个"标准单/主单"≥1 行、is_primary=1 唯一；跨系统子单不在此建行
        //   （只读主单子表，§6.1 契约 B）。完成通知/已读按行独立。全新表 CREATE IF NOT EXISTS——旧库不存在即建、
        //   新库一次建全，对两条部署路径都安全（区别于主表加列须走 migration ALTER）。
        db.run(`CREATE TABLE IF NOT EXISTS correction_requesters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            correction_request_id INTEGER NOT NULL,        -- 归属单（跨系统时=主单 id；子单不在此建行）
            requester_name TEXT NOT NULL,
            requester_phone TEXT,
            -- is_primary/seq 数据类型 guard CHECK（codex 48 L-3）：全新表零迁移成本，对齐既有 correction_count CHECK 先例
            --   （数据类型/range guard 可进 CHECK，区别于 status 枚举——枚举按项目惯例靠后端写入口集中校验，不进 CHECK）。
            is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
            seq INTEGER NOT NULL DEFAULT 1 CHECK (seq >= 1),
            completion_notify_status TEXT DEFAULT 'not_sent',   -- 枚举 §6.6（not_sent/sent/failed/no_phone）；惯例靠写入口校验+迁移回填清洗，不进 DB CHECK
            completion_notified_at DATETIME,
            completion_notify_message_key TEXT,
            completion_notify_error TEXT,
            completion_read_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (correction_request_id) REFERENCES correction_requests(id)
        )`, recordCorrErr('correction_requesters'));
        // 主业务方"至多一条"硬约束（partial unique index，§5.3 H-1 不变量）
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_requester_primary
            ON correction_requesters(correction_request_id) WHERE is_primary = 1`, recordCorrErr('idx_correction_requester_primary'));
        // 按单 + seq 查询索引（L-1：当前规模非性能必需，为多业务方未来）
        db.run(`CREATE INDEX IF NOT EXISTS idx_correction_requester_req
            ON correction_requesters(correction_request_id, seq)`, recordCorrErr('idx_correction_requester_req'));

        // ⭐ v1.80.1 hotfix 范式：migration 触发挪进 serialize 块内最后一个 db.run 的 callback，
        //   保证它一定在上面所有 CREATE TABLE/INDEX 排队消耗完之后才跑——否则 runCorrectionMigration
        //   第一步 PRAGMA 会与队列里的 CREATE 竞态（PRAGMA 立即返回空 schema → 列缺失 → readiness 永久 false）。
        //   firstCorrDdlError 透传给 migration：有 DDL 失败直接置 error 不再 PRAGMA。
        db.run('SELECT 1', () => {
            runCorrectionMigration(firstCorrDdlError).catch((e) => {
                CORRECTION_SCHEMA_STATE.ready = false;
                CORRECTION_SCHEMA_STATE.error = `数据修正迁移异常：${e && e.message}`;
                logger.error(`[数据修正 A] 🚫 迁移异常：${e && e.message}`);
            });
        });
    });
}
// ── 数据修正模块 schema 迁移/就绪探测（方案 §7 / §9 约束 3）─────────────────
//   全新模块无 ALTER：本函数不改 schema，只在 initTable serialize 队列消耗完后 PRAGMA 复查
//   三表 + 关键列是否到位，全部就位才置 CORRECTION_SCHEMA_STATE.ready=true。
//   ⚠️ 时序铁律（v1.80.1 hotfix 同源）：必须由 serialize 块内最后一个 db.run 的 callback 触发，
//     否则 PRAGMA 会与队列里的 CREATE TABLE 竞态（PRAGMA 立即返回空 schema → 列缺失 → 永久 false）。
//   入参 ddlError：建表 serialize 块收集的首个 DDL 错误；非空直接置 error 不再 PRAGMA。
async function runCorrectionMigration(ddlError) {
    try {
        // codex 08 L-1：函数开头显式重置 ready=false，状态转移清晰（只有全部检查通过才 error=null/ready=true）。
        //   当前启动只调一次，但未来若手动重试 migration，避免旧 error/ready 残留影响判断。
        CORRECTION_SCHEMA_STATE.ready = false;

        // [0] 建表阶段若有 DDL 失败，直接熔断（不可能 ready）
        if (ddlError) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = `建表 DDL 失败：${ddlError}`;
            logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error} → correction 写入口将返 503`);
            return;
        }

        // [1] 三表存在性（sqlite_master 查表名）
        const tables = await new Promise((resolve, reject) => {
            db.all(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('correction_requests','correction_attachments','correction_status_history','correction_requesters')",
                (err, rows) => err ? reject(err) : resolve((rows || []).map(r => r.name))
            );
        });
        const missingTables = CORRECTION_REQUIRED_TABLES.filter(t => !tables.includes(t));
        if (missingTables.length > 0) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = `correction 表缺失：${missingTables.join(',')}`;
            logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error} → correction 写入口将返 503`);
            return;
        }

        // [2] correction_requests 列 PRAGMA（先取现有列，供 [2a] 判断是否需 ALTER；C-1 codex 36/37 硬性顺序）
        let cols = await new Promise((resolve, reject) => {
            db.all('PRAGMA table_info(correction_requests)', (err, rows) => err ? reject(err) : resolve(rows));
        });
        if (!cols || cols.length === 0) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = '无法读取 correction_requests 表结构（PRAGMA 失败）';
            logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error}`);
            return;
        }
        let colNames = cols.map(c => c.name);

        // [2a] ⭐ 本次细优②（2026-06-17）：已上线表演进——creator 通知 5 列（四件套 status/notified_at/message_key/error + read_at）幂等 ALTER ADD COLUMN。
        //   生产 correction_requests 已有数据，不能 DROP 重建；CREATE TABLE IF NOT EXISTS 对已存在表 no-op（新列不加），故此处补。
        //   ⚠️ C-1（codex 36/37）硬性顺序铁律：ALTER 必须在下方 missingCols 复查【之前】完成——否则 KEY_COLS 含
        //     creator_notify_status 会判缺列 → ready=false → 整个 correction 写入口 503（生产熔断）。
        //   幂等：PRAGMA 查列不存在才 ALTER（重启多次：首次 ALTER、后续跳过）；ALTER reject → 外层 catch 置 error
        //     （可观测，不用 server.js 老范式 B 的空回调吞错）。col/type 为硬编码常量非用户输入，插值无注入风险。
        //   DEFAULT 'not_sent'：ALTER ADD COLUMN 带默认值给生产存量行回填 'not_sent'（H-1，对齐四件套初值）。
        const CREATOR_NOTIFY_COLS = [
            ['creator_notify_status', "TEXT DEFAULT 'not_sent'"],
            ['creator_notified_at', 'DATETIME'],
            ['creator_notify_message_key', 'TEXT'],
            ['creator_notify_error', 'TEXT'],
            ['creator_read_at', 'DATETIME'],
        ];
        for (const [col, type] of CREATOR_NOTIFY_COLS) {
            if (!colNames.includes(col)) {
                await new Promise((resolve, reject) => {
                    db.run(`ALTER TABLE correction_requests ADD COLUMN ${col} ${type}`, (err) => err ? reject(err) : resolve());
                });
                logger.info(`[数据修正迁移] correction_requests ADD COLUMN ${col} ${type}（细优② creator 通知）`);
            }
        }
        // [2a-x] ⭐ 跨系统关联方案（L1，2026-06-18）：已上线表演进——加 correction_group_id（组键，入 KEY_COLS）
        //   + error_proof_note（建单错误证明说明，不入 KEY_COLS）幂等 ALTER ADD COLUMN（同 [2a] creator 范式）。
        //   生产已有数据不能 DROP 重建，CREATE TABLE IF NOT EXISTS 对已存在表 no-op（新列不加），故此处补。
        //   ⚠️ C-1 硬性顺序：group_id 已入 KEY_COLS，ALTER 必须在下方 missingCols 复查【之前】完成（否则判缺列 503）。
        //   col/type 为硬编码常量非用户输入，插值无注入风险；ALTER reject → 外层 catch 置 error（可观测，不静默吞）。
        const CROSS_SYSTEM_COLS = [
            ['correction_group_id', 'INTEGER'],   // NULL=无组；非 NULL=主单 id（主单判定 id===correction_group_id）
            ['error_proof_note', 'TEXT'],          // 建单错误证明说明（可选，配 error_proof 附件；需求本体仍是 location_info）
        ];
        for (const [col, type] of CROSS_SYSTEM_COLS) {
            if (!colNames.includes(col)) {
                await new Promise((resolve, reject) => {
                    db.run(`ALTER TABLE correction_requests ADD COLUMN ${col} ${type}`, (err) => err ? reject(err) : resolve());
                });
                logger.info(`[数据修正迁移] correction_requests ADD COLUMN ${col} ${type}（L1 跨系统关联）`);
            }
        }
        // [2a-x2] correction_group_id 索引：⚠️ 必须在 ALTER 之后建——若放 initSchema serialize 块，旧库该列尚未
        //   ALTER → CREATE INDEX 报 "no such column: correction_group_id" → recordCorrErr 收集为 DDL 失败 → 熔断 503。
        //   置此（ALTER 后、幂等 IF NOT EXISTS）：新库 CREATE TABLE 已含列→ALTER 跳过→建索引；旧库 ALTER 后→建索引。两路径都安全。
        await new Promise((resolve, reject) => {
            db.run('CREATE INDEX IF NOT EXISTS idx_corr_group ON correction_requests(correction_group_id)', (err) => err ? reject(err) : resolve());
        });
        // [2b] ⭐ ALTER 后【重新】PRAGMA：下方 missingCols 必须用最新列集（C-1：不能复用 [2] 的旧 colNames 复查）
        cols = await new Promise((resolve, reject) => {
            db.all('PRAGMA table_info(correction_requests)', (err, rows) => err ? reject(err) : resolve(rows));
        });
        colNames = cols.map(c => c.name);

        const missingCols = CORRECTION_REQUESTS_KEY_COLS.filter(c => !colNames.includes(c));
        if (missingCols.length > 0) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = `correction_requests 关键列缺失：${missingCols.join(',')}`;
            logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error} → correction 写入口将返 503`);
            return;
        }

        // [2c] codex 08 H-1：附件表 + 历史表关键列 + NOT NULL 锚点复查（三表闸门须对称，不能只验主表）。
        //   旧表/半成品表缺 uploaded_by(R-3) 或 to_status 时，CREATE TABLE IF NOT EXISTS 不修复 →
        //   readiness 须在此拦截，否则后续 Commit B/C/D 写附件/历史时运行期报错。
        const checkTableCols = async (tableName, keyCols, notnullCols) => {
            const tCols = await new Promise((resolve, reject) => {
                db.all(`PRAGMA table_info(${tableName})`, (err, rows) => err ? reject(err) : resolve(rows));
            });
            if (!tCols || tCols.length === 0) return `无法读取 ${tableName} 表结构（PRAGMA 失败）`;
            const names = tCols.map(c => c.name);
            const missing = keyCols.filter(c => !names.includes(c));
            if (missing.length > 0) return `${tableName} 关键列缺失：${missing.join(',')}`;
            // NOT NULL 锚点必须 notnull=1（防旧表缺约束）
            const notNullBroken = notnullCols.filter(c => {
                const def = tCols.find(x => x.name === c);
                return !def || def.notnull !== 1;
            });
            if (notNullBroken.length > 0) return `${tableName} NOT NULL 约束缺失：${notNullBroken.join(',')}`;
            return null;
        };
        const attErr = await checkTableCols('correction_attachments', CORRECTION_ATTACHMENTS_KEY_COLS, CORRECTION_ATTACHMENTS_NOTNULL_COLS);
        if (attErr) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = attErr;
            logger.error(`[数据修正 A] 🚫 ${attErr} → correction 写入口将返 503`);
            return;
        }
        const histErr = await checkTableCols('correction_status_history', CORRECTION_HISTORY_KEY_COLS, CORRECTION_HISTORY_NOTNULL_COLS);
        if (histErr) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = histErr;
            logger.error(`[数据修正 A] 🚫 ${histErr} → correction 写入口将返 503`);
            return;
        }

        // [2d] ⭐ 跨系统关联方案 §5.2（L1）：correction_requesters 业务方子表关键列 + NOT NULL 锚点复查
        //   （对齐三表对称校验：完成通知真相源缺列/缺约束 → L2 写子表运行期报错，故 readiness 在此拦截）。
        const reqErr = await checkTableCols('correction_requesters', CORRECTION_REQUESTERS_KEY_COLS, CORRECTION_REQUESTERS_NOTNULL_COLS);
        if (reqErr) {
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = reqErr;
            logger.error(`[数据修正 A] 🚫 ${reqErr} → correction 写入口将返 503`);
            return;
        }

        // [2e] ⭐ 跨系统关联方案 §5.4（L1）：业务方子表幂等回填——每个"标准单/主单"（非子单）回填一条
        //   is_primary=1（搬主表 requester_name/phone + 已有 completion_notify_* 兼容列，作完成通知真相源初值）。
        //   幂等：NOT EXISTS(同单 primary 行) 防重复（migration 每次启动都跑，已回填则跳过）。
        //   ⚠️ 子单豁免（group_id != id）：跨系统子单不写子表（§6.1 契约 B）——若不豁免，段二落地后子单（兼容列复制了
        //     主业务方非空 name、无子表行）会被每次重启的回填误造 primary 行。L1 存量单 group_id 均 NULL → 全部回填，
        //     此条件同时为段二 L4 前向兼容。空 requester_name 历史单跳过（§5.4）；VOIDED 有名单（生产 id=1）正常回填。
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO correction_requesters
                    (correction_request_id, requester_name, requester_phone, is_primary, seq,
                     completion_notify_status, completion_notified_at, completion_notify_message_key,
                     completion_notify_error, completion_read_at)
                 SELECT cr.id, cr.requester_name, cr.requester_phone, 1, 1,
                        -- status 枚举清洗（codex 48 M-1 / 方案 §5.3 RC-L2"迁移共用 write helper 清洗，status 只取 §6.6 常量"）：
                        --   非法/NULL 旧状态统一归 'not_sent'，不把脏值原样搬进子表（否则 L2 按枚举处理遇未知值）。
                        CASE WHEN cr.completion_notify_status IN ('not_sent','sent','failed','no_phone')
                             THEN cr.completion_notify_status ELSE 'not_sent' END,
                        cr.completion_notified_at,
                        cr.completion_notify_message_key, cr.completion_notify_error, cr.completion_read_at
                 FROM correction_requests cr
                 WHERE cr.requester_name IS NOT NULL AND TRIM(cr.requester_name) != ''
                   AND (cr.correction_group_id IS NULL OR cr.correction_group_id = cr.id)
                   AND NOT EXISTS (
                       SELECT 1 FROM correction_requesters x
                       WHERE x.correction_request_id = cr.id AND x.is_primary = 1
                   )`,
                (err) => err ? reject(err) : resolve()
            );
        });

        // [2f] ⭐ readiness 数据不变量断言（RC3-L1，方案 §5.4）：非 VOIDED 的"标准单/主单"（非子单）
        //   有且仅有一条 is_primary=1；VOIDED 单豁免（允许无 primary——历史无名作废单不提供业务方通知入口）。
        //   违反 → 503 fail-fast（回填异常/数据脏时阻断写入口）；生产仅 2 单均正常回填，real_sample 部署前已端到端验。
        const primaryViolations = await new Promise((resolve, reject) => {
            db.all(
                `SELECT cr.id AS id, COUNT(rq.id) AS primary_count
                 FROM correction_requests cr
                 LEFT JOIN correction_requesters rq
                   ON rq.correction_request_id = cr.id AND rq.is_primary = 1
                 WHERE cr.status != 'VOIDED'
                   AND (cr.correction_group_id IS NULL OR cr.correction_group_id = cr.id)
                 GROUP BY cr.id
                 HAVING COUNT(rq.id) != 1`,
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });
        if (primaryViolations.length > 0) {
            const sample = primaryViolations.slice(0, 5).map(r => `#${r.id}(${r.primary_count})`).join(',');
            CORRECTION_SCHEMA_STATE.ready = false;
            CORRECTION_SCHEMA_STATE.error = `correction_requesters 主业务方不变量破坏（非 VOIDED 单须恰一条 primary）：${sample}`;
            logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error} → correction 写入口将返 503`);
            return;
        }

        // [3] 全部就位 → 置 ready
        CORRECTION_SCHEMA_STATE.error = null;
        CORRECTION_SCHEMA_STATE.ready = true;
        logger.info(`[数据修正 A] ✅ correction 四表就绪（${tables.length}/4 表 + 主表关键列 + 附件/历史/业务方表 NOT NULL 锚点齐全 + 主业务方不变量校验通过），写入口放行。`);
    } catch (e) {
        CORRECTION_SCHEMA_STATE.ready = false;
        CORRECTION_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
        logger.error(`[数据修正 A] 🚫 ${CORRECTION_SCHEMA_STATE.error}`);
    }
}

// ============================================================
// 区3：常量 + helper + 18 端点（原 server.js 18289-19802）
// ============================================================
const router = express.Router();
// ============================================================
// 数据修正模块 API（v1.81.0 Commit B：correctionTransition + 建单 + 指派 + GET 列表/详情）
//   方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md（§3 状态机 / §4 流程 / §7 权限 / §9 编码前置）
//   节奏：docs/local/数据修正/数据修正模块_开发节奏_20260612_v1.0.md（Commit B）
//   ⚠️ Commit B scope 决策（用户拍板）：
//     ① 钉钉发送统一延到 Commit D（节奏 D 集中"指派/完成/拒绝通知"）——B 只记意图字段
//        （relay_notified_user_id / notify_status='not_sent'）+ TODO(Commit D) 标记，不发网络。
//     ② GET 列表/详情在 B 补最小版（节奏未明确分配读接口，但 §9.4 详情可见性是前置约束、
//        且无读接口无法观测建单/指派）；时长/积压筛选/8 态徽章留 F（前端）。
// ============================================================

// ── 8 态枚举（方案 §3.1）+ 流转表（§3.2）+ correction_type（G-8）─────────────────
//   状态机集中校验枚举（不用 DB CHECK，跟项目惯例，方案 §5.3）。VOIDED 为软删最终态无后续转移；
//   VOIDED 作为目标走 correctionTransition 通用旁路（§3.4 / G-14）。
const CORRECTION_STATUSES = [
    'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'FIXED', 'REFIXED',
    'ARCHIVED', 'REJECTED', 'VOIDED'
];
const CORRECTION_STATUS_TRANSITIONS = {
    // I2 §3.4：3 个未完成态加 ARCHIVED 为合法目标（仅行政闭环 admin_closure 走，transition 内 closure_type 二次约束源态；
    //   normal 归档在 transition 内强校验 fromStatus∈{FIXED,REFIXED}，双分支互不污染）
    'PENDING_ASSIGN':            ['ASSIGNED_PENDING_ESTIMATE', 'ARCHIVED', 'REJECTED', 'VOIDED'],
    'ASSIGNED_PENDING_ESTIMATE': ['IN_PROGRESS', 'ARCHIVED', 'REJECTED', 'VOIDED'],
    'IN_PROGRESS':               ['FIXED', 'ARCHIVED', 'REJECTED', 'VOIDED'],
    'FIXED':                     ['REFIXED', 'ARCHIVED', 'VOIDED'],   // 重修→REFIXED / 归档→ARCHIVED / 作废
    'REFIXED':                   ['REFIXED', 'ARCHIVED', 'VOIDED'],   // 可再次重修（停 REFIXED·G-9）/ 归档 / 作废
    'ARCHIVED':                  ['VOIDED'],                          // 归档后仍可作废（G-14）
    'REJECTED':                  ['VOIDED'],                          // 拒绝后仍可作废
    // 'VOIDED' 无后续转移（最终终态）
};
const CORRECTION_TYPES = ['single', 'batch'];

// ── 对接人白名单（路线 B：对接人 = 固定白名单，非角色口径）──────────────────────────────
//   示例发布者(id=7,publisher) / 示例对接人(id=13,user)。授权高于 role——白名单成员即可当对接人（看 / 派其经手 relay 单），
//   即便 user 角色（correctionTransition 指派分支对白名单 relay 权威放行，见 §权限校验）。
//   ⚠️ 改名单需三处同步：本常量 + 前端 public/Data_Correction.html 同名常量 + scripts/verify-correction-relay-whitelist.js，
//      verify 卡三处字面量一致防漂移（运行：node scripts/verify-correction-relay-whitelist.js）。
//   ⚠️ 白名单 > role：若把 viewer 加入名单，viewer 也会获得 relay 指派能力，维护注意（verify 加"成员非 viewer"防御断言）。
const CORRECTION_RELAY_USER_IDS = [7, 13];
//   单一真相点（对齐 server.js isReadonlyLeaderId 范式）：uid 是否在对接人白名单。
function isCorrectionRelayWhitelisted(uid) {
    return Number(uid) > 0 && CORRECTION_RELAY_USER_IDS.includes(Number(uid));
}
//   /assign 粗筛中间件：放行 admin/publisher 或白名单对接人；进 handler 后由 transition 权威校验"是否本单经手 relay"。
function requireRelayOrPublisherOrAdmin(req, res, next) {
    const role = req.user && req.user.role;
    if (role === 'admin' || role === 'publisher') return next();
    if (req.user && isCorrectionRelayWhitelisted(req.user.id)) return next();
    return res.status(403).json({ error: '无权指派（仅管理员 / 发布者或指定对接人）', code: 'NOT_AUTHORIZED_TO_ASSIGN' });
}

// ── deadline 工具（方案 §4.1 / §8 复用 normalizeDeadlineForDb 逻辑）──────────────
//   normalizeDeadlineForDb 是 17173 行某 endpoint 内的局部函数（非模块级），逻辑仅几行，此处复刻同语义。
//   归一化：'YYYY-MM-DDTHH:MM' → 'YYYY-MM-DD HH:MM:SS'（SQLite localtime 存储格式）；空/非法返 null。
function normalizeCorrectionDatetime(raw) {
    if (raw === undefined || raw === null) return null;
    let dv = String(raw).trim().replace('T', ' ');
    if (!dv) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dv)) dv += ':00';
    // codex 09 M-2：严格格式 + 真实日期校验——只接受 'YYYY-MM-DD HH:MM:SS' 且年月日时分秒越界（13 月/32 日/25 时）返 null。
    //   防 dev_estimated_at='abc' 绕过 ESTIMATE_REQUIRED 进 IN_PROGRESS / expected_deadline 落非法文本污染时长计算。
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dv);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    const dt = new Date(y, mo - 1, d, h, mi, s);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ||
        dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== s) return null;
    return dv;
}
//   expected_deadline 后端智能默认（逻辑同 Data_Collab.html:4938-4950 改后端生成）：
//   < 15:00 → 当天 17:00；≥ 15:00 → 次日 12:00（仅参考、可空，§4.1）。
function correctionDefaultDeadline(now = new Date()) {
    const d = new Date(now.getTime());
    if (d.getHours() < 15) {
        d.setHours(17, 0, 0, 0);
    } else {
        d.setDate(d.getDate() + 1);
        d.setHours(12, 0, 0, 0);
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
// codex 09 RC-L3：body 用户/单 id 正整数校验（非法返 null → endpoint 返 400，比兜到 NOT_FOUND 语义清晰）。
//   用于 assigned_to / relay_notified_user_id 等 body 入参（路径参数 id 在 endpoint 内联校验，见 L-6）。
function parsePositiveCorrectionId(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// ── 数据修正·唯一状态流转入口 correctionTransition（H-1 / R-6 / §3.4）─────────────
//   全模块唯一改 status 的函数（指派/回复预计/标完成/重修/拒绝/归档/作废都复用），禁止任何直接 UPDATE status。
//   单个 BEGIN IMMEDIATE 事务内：① R-6 事务内读真实 fromStatus（不信客户端）② 流转合法性 ③ 业务闸门
//   ④ 双条件 WHERE UPDATE（changes 检查）⑤ history append。VOIDED 走通用旁路（不比对 expectedFromStatus，
//   但仍执行双条件 WHERE 守卫，§3.4 / G-14 / M-3）。
//   Commit B 实现全部 8 态闸门；触发 →FIXED/→REFIXED/→IN_PROGRESS 的 endpoint 在 Commit C，→拒绝/归档/作废在 D，
//   但闸门逻辑此刻全部就位（节奏 B：correctionTransition 骨架含"所有业务闸门"）。
class CorrectionTransitionError extends Error {
    constructor(httpStatus, code, message) {
        super(message);
        this.name = 'CorrectionTransitionError';
        this.httpStatus = httpStatus;
        this.code = code;
    }
}
//   actor = { id, name }；payload 按 toStatus 携带闸门输入（见各 case 注释）。
//   成功返 { ok:true, fromStatus, toStatus }；业务/并发错误抛 CorrectionTransitionError（endpoint 捕获转 HTTP）。
async function correctionTransition(requestId, expectedFromStatus, toStatus, actor, payload = {}) {
    if (!CORRECTION_STATUSES.includes(toStatus)) {
        throw new CorrectionTransitionError(400, 'INVALID_TARGET_STATUS', `非法目标状态：${toStatus}`);
    }
    await dbRunAsync('BEGIN IMMEDIATE');
    try {
        // R-6：事务内读 DB 真实状态作为 fromStatus；闸门/权限用 correction_type/assigned_to/created_by/dingtalk_chat_id/
        //   fixed_at/refixed_at（H-1 新增性兜底基线）一并读。
        const row = await dbGetAsync(
            'SELECT id, status, correction_type, assigned_to, created_by, relay_notified_user_id, dingtalk_chat_id, fixed_at, refixed_at FROM correction_requests WHERE id = ?',
            [requestId]
        );
        if (!row) throw new CorrectionTransitionError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
        const fromStatus = row.status;

        if (toStatus === 'VOIDED') {
            // 通用旁路（G-14）：任意非 VOIDED 态可作废，不比对 expectedFromStatus；幂等保护 + 下方双 WHERE 守卫
            if (fromStatus === 'VOIDED') throw new CorrectionTransitionError(409, 'ALREADY_VOIDED', '修正单已作废');
        } else {
            // 流转合法性（目标须在当前态的允许集合内）
            const allowed = CORRECTION_STATUS_TRANSITIONS[fromStatus] || [];
            if (!allowed.includes(toStatus)) {
                throw new CorrectionTransitionError(400, 'INVALID_TRANSITION', `不能从「${fromStatus}」转为「${toStatus}」`);
            }
            // expectedFromStatus 比对（防客户端传陈旧/错误前置状态）
            if (expectedFromStatus && fromStatus !== expectedFromStatus) {
                throw new CorrectionTransitionError(409, 'CONCURRENT_STATE_CHANGE', '修正单状态已变更，请刷新重试');
            }
        }

        // 权限校验（codex 09 M-3 / 方案 §3.4 step3 / §7.2：transition 内按 actor 角色 + 状态分流是权威闸门，
        //   不靠通用写中间件放行所有推进）。endpoint 外层 requireAdmin/requirePublisherOrAdmin 是粗筛第一道，
        //   此处按动作精校验，防 Commit C/D 漏 dev/publisher/建单人 的动作边界。需 actor.role（endpoint 传入）。
        {
            const role = actor.role;
            const isAdmin = role === 'admin';
            const isPublisher = role === 'publisher';
            const isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
            const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
            // 路线 B：白名单对接人对「其本人经手的 relay 单」有指派权（仅此一个动作）；只在指派 case 放行，
            //   其他写动作分支不含本判定 → relay 不获泛化写权限（H-2 隔离）。含白名单判定 → 移出白名单即失效。
            const isWhitelistRelay = isCorrectionRelayWhitelisted(actor.id) && Number(row.relay_notified_user_id) === Number(actor.id);
            let permitted = false;
            switch (toStatus) {
                case 'ASSIGNED_PENDING_ESTIMATE': permitted = isAdmin || isPublisher || isWhitelistRelay; break;  // 指派（§7.1 + 路线 B 白名单 relay）
                case 'IN_PROGRESS': case 'FIXED': case 'REFIXED': permitted = isAdmin || isAssignee; break;     // 回复预计/标完成/重修=开发本人或 admin
                case 'REJECTED':
                    permitted = (fromStatus === 'PENDING_ASSIGN')
                        ? (isAdmin || isPublisher)                  // 未指派：调度角色（§4.6 H-3）
                        : (isAdmin || isPublisher || isAssignee);   // 已指派/进行中：+ 被指派开发本人
                    break;
                case 'ARCHIVED': {
                    // I2 §3.4 + codex 28 M-2：closure_type 归一化 + 非法校验前置到权限（非法值优先报 INVALID_CLOSURE_TYPE，不被权限 NOT_AUTHORIZED 抢先，与闸门 case 口径一致）
                    const ct = (payload.closure_type === undefined || payload.closure_type === null || payload.closure_type === '') ? 'normal' : payload.closure_type;
                    if (ct !== 'normal' && ct !== 'admin_closure') throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_TYPE', 'closure_type 仅 normal | admin_closure');
                    permitted = (ct === 'admin_closure') ? isAdmin : (isAdmin || isCreator);   // normal=建单人/admin；admin_closure=仅 admin
                    break;
                }
                case 'VOIDED': permitted = isAdmin || isCreator; break;     // 作废=建单人或 admin（§4.8）
                default: permitted = isAdmin;                               // 安全网：未列动作仅 admin
            }
            if (!permitted) throw new CorrectionTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权执行此状态流转');
        }

        // 业务闸门 + SET 片段 + history.reason（按 toStatus 分支）
        const setFrags = [];
        const setParams = [];
        let historyReason = null;

        switch (toStatus) {
            case 'ASSIGNED_PENDING_ESTIMATE': {
                // 指派：写 assigned_to/name/by + assigned_at（R-4 合法性由 endpoint 前置校验）
                setFrags.push('assigned_to = ?', 'assigned_to_name = ?', 'assigned_by = ?', "assigned_at = datetime('now','localtime')");
                setParams.push(Number(payload.assigned_to), payload.assigned_to_name || null, Number(payload.assigned_by) || null);
                historyReason = payload.assigned_to_name ? `指派给 ${payload.assigned_to_name}` : null;
                break;
            }
            case 'IN_PROGRESS': {
                // 强制闸门（§4.3）：dev_estimated_at 非空才能进 IN_PROGRESS
                const est = normalizeCorrectionDatetime(payload.dev_estimated_at);
                if (!est) throw new CorrectionTransitionError(400, 'ESTIMATE_REQUIRED', '请先回复预计完成时间');
                setFrags.push('dev_estimated_at = ?', "estimated_replied_at = datetime('now','localtime')");
                setParams.push(est);
                break;
            }
            case 'FIXED': {
                // 标完成闸门按 correction_type 分流（§4.4 / G-8）
                if (row.correction_type === 'batch') {
                    const note = (typeof payload.batch_completion_note === 'string' ? payload.batch_completion_note.trim() : '');
                    if (!note) throw new CorrectionTransitionError(400, 'BATCH_NOTE_REQUIRED', '批量修正标完成必须填写完成说明');
                    if (note.length > 500) throw new CorrectionTransitionError(400, 'COMPLETION_NOTE_TOO_LONG', '完成说明不超过 500 字');   // L-3：对齐 closure_reason 上限
                    setFrags.push('batch_completion_note = ?');
                    setParams.push(note);
                } else {
                    // single：历史存在合规 fix_proof（H-2，join users 查角色；uploaded_by=assigned_to OR role='admin'）
                    const cnt = await dbGetAsync(
                        `SELECT COUNT(*) AS c FROM correction_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                          WHERE a.correction_request_id = ? AND a.attachment_type = 'fix_proof' AND a.uploaded_by IS NOT NULL
                            AND (a.uploaded_by = ? OR u.role = 'admin')`,
                        [requestId, Number(row.assigned_to) || -1]
                    );
                    if (!cnt || cnt.c < 1) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正标完成必须上传结果证明截图');
                    // 完成说明（选填，single 复用 batch_completion_note 字段）：single 已强制 fix_proof 截图留证，文字仅补充上下文，非空才写；空则保持 NULL
                    const snote = (typeof payload.batch_completion_note === 'string' ? payload.batch_completion_note.trim() : '');
                    if (snote.length > 500) throw new CorrectionTransitionError(400, 'COMPLETION_NOTE_TOO_LONG', '完成说明不超过 500 字');   // L-3：对齐 closure_reason 上限
                    if (snote) { setFrags.push('batch_completion_note = ?'); setParams.push(snote); }
                }
                setFrags.push("fixed_at = datetime('now','localtime')", 'submission_count = 1');
                break;
            }
            case 'REFIXED': {
                // 重修提交（§4.4a 类型一 / G-9/G-10/G-12）：FIXED/REFIXED 直接到 REFIXED + submission_count+1
                if (row.correction_type === 'batch') {
                    const rnote = (typeof payload.resubmit_note === 'string' ? payload.resubmit_note.trim() : '');
                    if (!rnote) throw new CorrectionTransitionError(400, 'BATCH_RESUBMIT_NOTE_REQUIRED', '批量重修提交必须填写本次重修说明');
                    if (rnote.length > 500) throw new CorrectionTransitionError(400, 'RESUBMIT_NOTE_TOO_LONG', '重修说明不超过 500 字');   // L-3：对齐 closure_reason 上限
                    historyReason = rnote;   // §9 约束 33：resubmit_note 写 history.reason，不加主表字段
                } else {
                    // single：必须校验本次新增 fix_proof（HIGH-1 06 轮，§3.4——不能 COUNT 历史附件，否则可复用旧图绕过留证）
                    const ids = Array.isArray(payload.new_fix_proof_attachment_ids)
                        ? payload.new_fix_proof_attachment_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
                        : [];
                    if (ids.length === 0) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正重修提交必须上传本次新增结果证明');
                    // codex 09 H-1：新增性兜底——附件须晚于上次完成时间 COALESCE(refixed_at, fixed_at)（与积压筛选同范式），
                    //   防复用旧 fix_proof id 绕过重修留证（§3.4/§9.37）。主保证仍是 Commit C /resubmit 只传本次上传 id；
                    //   此为纵深防御第二道。基线 NULL 时 `created_at > NULL`=NULL → 0 行 → 安全拒（REFIXED 时 fixed_at 必非空）。
                    const newnessBaseline = row.refixed_at || row.fixed_at || null;
                    const placeholders = ids.map(() => '?').join(',');
                    const cnt = await dbGetAsync(
                        `SELECT COUNT(*) AS c FROM correction_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                          WHERE a.correction_request_id = ? AND a.attachment_type = 'fix_proof' AND a.uploaded_by IS NOT NULL
                            AND a.id IN (${placeholders}) AND (a.uploaded_by = ? OR u.role = 'admin')
                            AND a.created_at > ?`,
                        [requestId, ...ids, Number(row.assigned_to) || -1, newnessBaseline]
                    );
                    // 全部传入 id 必须命中合规（防夹带他单/error_proof/越权上传者/复用旧图）
                    if (!cnt || cnt.c !== ids.length) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '本次新增结果证明无效（须属本单 fix_proof、上传者为开发本人或 admin、且为本次完成后新增）');
                    // 重修说明（选填，对称 batch resubmit_note）：非空则拼入 history.reason（§9 约束 33：不加主表字段，逐次留痕在历史）
                    const srnote = (typeof payload.resubmit_note === 'string' ? payload.resubmit_note.trim() : '');
                    if (srnote.length > 500) throw new CorrectionTransitionError(400, 'RESUBMIT_NOTE_TOO_LONG', '重修说明不超过 500 字');   // L-3：对齐 closure_reason 上限
                    historyReason = srnote
                        ? `重修提交（新增 ${ids.length} 张结果证明）：${srnote}`
                        : `重修提交（新增 ${ids.length} 张结果证明）`;
                }
                setFrags.push("refixed_at = datetime('now','localtime')", 'submission_count = submission_count + 1');
                break;
            }
            case 'ARCHIVED': {
                // I2 §3.4：ARCHIVED 双分支闸门，按 closure_type 分流，互不污染。
                //   RC-M2：缺失 closure_type 默认 normal（向后兼容旧 archive 调用）；非空非法值 → 400（不静默归一防 typo）。
                const closureTypeRaw = payload.closure_type;
                const closureType = (closureTypeRaw === undefined || closureTypeRaw === null || closureTypeRaw === '') ? 'normal' : closureTypeRaw;
                if (closureType !== 'normal' && closureType !== 'admin_closure') {
                    throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_TYPE', 'closure_type 仅 normal | admin_closure');
                }
                if (closureType === 'admin_closure') {
                    // 行政闭环（M-7/M-8）：仅 admin（上方权限已校）从 PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS 记账式收口；
                    //   必填 closure_reason（10-500，transition 内最终强校验防其他路径绕过）；跳过 fix_proof/friction 闸门。
                    if (!['PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS'].includes(fromStatus)) {
                        throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_SOURCE', `行政闭环只能从未完成态（PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS）发起，当前：${fromStatus}`);
                    }
                    const cr = (typeof payload.closure_reason === 'string' ? payload.closure_reason.trim() : '');
                    if (cr.length < 10 || cr.length > 500) {
                        throw new CorrectionTransitionError(400, 'CLOSURE_REASON_REQUIRED', '行政闭环必须填写闭环原因（10-500 字）');
                    }
                    setFrags.push("archived_at = datetime('now','localtime')", 'archived_by = ?', 'archived_by_name = ?', "closure_type = 'admin_closure'", 'closure_reason = ?', 'friction_reason = NULL');   // L-1：互斥清理 friction_reason
                    setParams.push(Number(actor.id) || null, actor.name || null, cr);
                    historyReason = `行政闭环：${cr}`;
                } else {
                    // 正常归档（§4.7/G-13）：流转表放宽后须在此强校验来自 FIXED/REFIXED（未完成单走行政闭环）；
                    //   发起过拉群（dingtalk_chat_id 非空）→ friction_reason 必填。
                    if (fromStatus !== 'FIXED' && fromStatus !== 'REFIXED') {
                        throw new CorrectionTransitionError(400, 'INVALID_TRANSITION', `正常归档只能从已完成态（FIXED/REFIXED）发起，当前：${fromStatus}（未完成单请用行政闭环）`);
                    }
                    const fr = (typeof payload.friction_reason === 'string' ? payload.friction_reason.trim() : '');
                    if (row.dingtalk_chat_id && !fr) {
                        throw new CorrectionTransitionError(400, 'FRICTION_REASON_REQUIRED', '本单发起过拉群讨论，归档必须填写摩擦原因');
                    }
                    setFrags.push("archived_at = datetime('now','localtime')", 'archived_by = ?', 'archived_by_name = ?', "closure_type = 'normal'", 'friction_reason = ?', 'closure_reason = NULL');   // L-1：互斥清理 closure_reason
                    setParams.push(Number(actor.id) || null, actor.name || null, fr || null);
                    historyReason = fr || null;
                }
                break;
            }
            case 'REJECTED': {
                const rr = (typeof payload.reject_reason === 'string' ? payload.reject_reason.trim() : '');
                if (!rr) throw new CorrectionTransitionError(400, 'REJECT_REASON_REQUIRED', '拒绝必须填写原因');
                setFrags.push("rejected_at = datetime('now','localtime')", 'rejected_by = ?', 'rejected_by_name = ?', 'reject_reason = ?');
                setParams.push(Number(actor.id) || null, actor.name || null, rr);
                historyReason = rr;
                break;
            }
            case 'VOIDED': {
                const vr = (typeof payload.void_reason === 'string' ? payload.void_reason.trim() : '');   // 建议填不强制（G-14）
                setFrags.push("voided_at = datetime('now','localtime')", 'voided_by = ?', 'voided_by_name = ?', 'void_reason = ?');
                setParams.push(Number(actor.id) || null, actor.name || null, vr || null);
                historyReason = vr || null;
                break;
            }
            default:
                // PENDING_ASSIGN 不是任何流转的合法目标（上方合法性已拦），此处为安全网
                throw new CorrectionTransitionError(400, 'UNSUPPORTED_TRANSITION', `暂不支持转为 ${toStatus}`);
        }

        // 双条件 WHERE 守卫（status = 事务内读到的真实 fromStatus）：闭合 SELECT 与 UPDATE 间的并发改窗口
        const setClause = ['status = ?', ...setFrags].join(', ');
        const upd = await dbRunAsync(
            `UPDATE correction_requests SET ${setClause} WHERE id = ? AND status = ?`,
            [toStatus, ...setParams, requestId, fromStatus]
        );
        if (!upd || upd.changes !== 1) {
            throw new CorrectionTransitionError(409, 'CONCURRENT_STATE_CHANGE', '修正单状态已变更，请刷新重试');
        }
        await dbRunAsync(
            `INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [requestId, fromStatus, toStatus, historyReason, Number(actor.id) || null, actor.name || null]
        );
        await dbRunAsync('COMMIT');
        return { ok: true, fromStatus, toStatus };
    } catch (e) {
        try { await dbRunAsync('ROLLBACK'); } catch (_) {}
        throw e;
    }
}

// ── 通知字段语义映射表（L-2 codex 20 末次审）：4 类旁路通知动作的状态字段 / 语义 / 下游读取方，各自独立勿混淆 ──
//   | 动作              | endpoint            | 状态字段                    | 收件人          | 成功/失败/no_phone 落库            | 下游读取方                |
//   |-------------------|---------------------|----------------------------|----------------|-----------------------------------|--------------------------|
//   | 指派通知开发       | assign / 建单 path A | notify_status(+key/error)  | dev 直取        | sent / failed（异常·not_found 也落 failed）| 详情通知区               |
//   | 回复预计通知业务方 | reply-estimate      | requester_notify_status    | requester 反查  | sent / no_phone / failed          | 详情通知区               |
//   | 完成通知业务方     | notify-done         | completion_notify_status   | requester 反查  | sent / no_phone / failed（config·token 前置失败不落，返 HTTP 错误）| 详情通知区 + 归档弱提示  |
//   | 对接人协助指派     | 建单 path B relay   | relay_notified_at(时间戳)   | relay 直取      | **仅成功写时间戳；失败留 NULL**（刻意：积压筛选靠它判"已通知却未指派"）| 列表积压高亮 + 建单响应 relay_notify_sent |
//   ⚠️ relay 与前三者语义不同：前三者是"投递审计"（有 status+error 字段，失败必落库）；relay 是"积压检测信号"（NULL=未成功通知→计入积压）。
//
// ── 数据修正 Commit D2a：钉钉发送基础设施（复用 dingtalkNotify 模块 + sendIssueDingtalkRaw 平台用户范式）──
//   钉钉通知是旁路动作：transition/建单已成功，通知失败如实落 notify_status='failed' 不回滚业务动作（对齐 issue H-4）。
//   所有卡片动态字段用 dingtalkNotify.escapeMarkdown 包裹防注入（codex 31 #7 范式）。dev/relay=平台用户走 sendIssueDingtalkRaw；业务方走 phone 反查。

// 业务方钉钉发送（requester_phone 反查 → markdown）。返回 {ok, message_key, reason}；no_phone/no_config/反查失败/send_failed 各自 reason。
async function sendCorrectionDingtalkToRequester(requesterPhone, title, markdown) {
    const phone = String(requesterPhone || '').trim();
    if (!phone) return { ok: false, reason: 'no_phone' };
    const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
    if (!appKey || !appSecret || !robotCode) return { ok: false, reason: 'no_config' };
    let token;
    try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
    catch (err) { return { ok: false, reason: dingtalkNotify.classifyError(err).reason }; }
    let resolved;
    try { resolved = await dingtalkNotify.resolveRequesterDingUserId(token, phone); }   // codex 13 L-1：包 try 闭合，抛错也归 {ok:false}
    catch (err) { return { ok: false, reason: dingtalkNotify.classifyError(err).reason || 'resolve_failed' }; }
    if (!resolved.ok) return { ok: false, reason: resolved.reason };   // requester_invalid（业务输入）/ 服务类异常
    const sendOk = (r) => r && typeof r === 'object' && (!r.errcode || r.errcode === 0)
        && (!Array.isArray(r.invalidStaffIdList) || r.invalidStaffIdList.length === 0);
    let mdResp;
    try { mdResp = await dingtalkNotify.sendMarkdownToUser(token, robotCode, [resolved.userid], title, markdown); }
    catch (err) { return { ok: false, reason: dingtalkNotify.classifyError(err).reason }; }
    if (!sendOk(mdResp) || !mdResp.processQueryKey) return { ok: false, reason: 'send_failed' };
    return { ok: true, message_key: mdResp.processQueryKey, userid: resolved.userid };
}

// 指派通知开发（共享 helper：assign endpoint + 建单 path A 都调）。读 correction + dev → 发 → 落 notify_*。
//   旁路不抛错：内部捕获，落 sent/failed（对齐 issue H-4 失败必落库），返回结果供 endpoint 决定是否提示。
// 细优③/④C（2026-06-17，codex 36 M-3）：通知钉钉消息「查看详情」登录地址。对齐 collab 硬化范式
//   （server.js forward-to-exporter）：platform_base_url 配置 + new URL 协议/host 校验 + 失败降级 fallback。
//   假设平台根路径部署（192.168.1.100:3000 根）；URL 经 new URL 保证合法无换行，不额外 escapeMarkdown（沿用 collab 只 escape 文本字段）。
async function buildCorrectionDetailUrl(correctionId) {
    const FALLBACK_BASE = 'http://192.168.1.100:3000';
    const raw = (await readSystemConfig('platform_base_url')) || FALLBACK_BASE;
    try {
        const url = new URL(`/Data_Correction.html?id=${correctionId}`, raw);
        if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error(`platform_base_url 协议/host 非法: ${url.protocol}//${url.hostname}`);
        return url.toString();
    } catch (e) {
        logger.warn(`[correction-detail-url] platform_base_url 配置非法 (${String(raw).replace(/[\r\n\t]/g, ' ').slice(0, 200)})，降级 fallback: ${e.message}`);
        return new URL(`/Data_Correction.html?id=${correctionId}`, FALLBACK_BASE).toString();
    }
}

async function notifyCorrectionAssignedDev(correctionId, devId) {
    // codex 13 M-1/M-2：把"算发送结果"与"落库"拆两阶段——dev 不存在 / 发送抛异常都规范为 r={ok:false}，
    //   再统一 UPDATE notify_*（异常/not_found 也落 failed，闭合"失败必落库" issue H-4）；仅 UPDATE 本身抛错才无法落库。
    let c, dev;
    try {
        c = await dbGetAsync('SELECT source_system, location_info, expected_deadline FROM correction_requests WHERE id = ?', [correctionId]);
        dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [devId]);
    } catch (e) {
        logger.warn(`[correction-notify] 修正单 #${correctionId} 指派通知查询异常：${e.message}`);
        c = null; dev = null;
    }
    if (!c) { logger.warn(`[correction-notify] 修正单 #${correctionId} 指派通知：单不存在，无法落库`); return { ok: false, reason: 'not_found' }; }
    let r;
    if (!dev) {
        r = { ok: false, reason: 'not_found' };
    } else {
        const esc = dingtalkNotify.escapeMarkdown;
        const detailUrl = await buildCorrectionDetailUrl(correctionId);   // 细优③：通知开发带登录地址
        const md = [
            '您被指派一条**数据修正需求**，请登平台回复预计完成时间：', '',
            `- 所属系统：${esc(c.source_system)}`,
            `- 修正方式：${esc(c.location_info)}`,
            c.expected_deadline ? `- 期望完成：${esc(String(c.expected_deadline))}` : ''
        ].filter(Boolean).join('\n') + `\n\n[查看修正单详情](${detailUrl})`;
        try { r = await sendIssueDingtalkRaw(dev, '📋 数据修正·新指派', md); }
        catch (e) { r = { ok: false, reason: 'exception' }; logger.warn(`[correction-notify] 修正单 #${correctionId} 指派发送异常：${e.message}`); }
    }
    try {
        // codex 31 M-1：read_at 清理合并进同一 UPDATE（CASE WHEN sent THEN NULL），对齐 relay/estimate/done 原子清理；
        //   原 notify-developer 外层单独 `UPDATE read_at=NULL`（吞异常）可能出现"新 message_key 已写但旧 read_at 残留"→前端误显示"最近已读"。
        const dbStatus = r.ok ? 'sent' : 'failed';
        await dbRunAsync(
            `UPDATE correction_requests SET notify_status=?, notified_at=datetime('now','localtime'), notify_message_key=?, notify_error=?, read_at=CASE WHEN ?='sent' THEN NULL ELSE read_at END WHERE id=?`,
            [dbStatus, r.ok ? r.message_key : null, r.ok ? null : (r.reason || 'other'), dbStatus, correctionId]);
    } catch (dbErr) {
        logger.error(`[correction-notify] 修正单 #${correctionId} 指派通知落库失败：${dbErr.message}（钉钉 ok=${r.ok}）`);
    }
    if (!r.ok) logger.warn(`[correction-notify] 修正单 #${correctionId} 指派通知开发失败：${r.reason}`);
    return r;
}

// ── POST /api/corrections 建单（§4.1 / G-1 requireAdmin / G-8 单批量 / R-5 白名单 / L-1 带指派走 transition）──
router.post('/', authenticateToken, requireCorrectionSchemaReady, requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};

        // 必填：source_system（白名单）+ correction_type + location_info（修正方式）+ requester_name
        //   （v1.81.0 复审优化 H：错误描述+期望值 合并为 location_info 一个"修正方式"，删 expected_value §1.2；error_current/source_table 已 6-15 复审删）
        const sourceSystem = (typeof b.source_system === 'string' ? b.source_system.trim() : '');
        if (!CORRECTION_SOURCE_SYSTEMS.includes(sourceSystem)) {
            return res.status(400).json({ error: '所属系统非法', code: 'INVALID_SOURCE_SYSTEM', allowed: CORRECTION_SOURCE_SYSTEMS });
        }
        const sourceSystemOther = (typeof b.source_system_other === 'string' ? b.source_system_other.trim() : '');
        if (sourceSystem === '其他' && !sourceSystemOther) {
            return res.status(400).json({ error: '所属系统选「其他」时必须填写补充说明', code: 'SOURCE_SYSTEM_OTHER_REQUIRED' });
        }
        const correctionType = (typeof b.correction_type === 'string' ? b.correction_type.trim() : 'single');
        if (!CORRECTION_TYPES.includes(correctionType)) {
            return res.status(400).json({ error: 'correction_type 非法（仅 single | batch）', code: 'INVALID_CORRECTION_TYPE' });
        }
        const locationInfo = (typeof b.location_info === 'string' ? b.location_info.trim() : '');   // 修正方式（合并错误描述+期望值，删 expected_value §1.2）
        if (!locationInfo) return res.status(400).json({ error: '缺少必填字段：location_info', code: 'MISSING_REQUIRED_FIELDS' });
        // L2 多业务方（方案 §6.1 契约 A 入参兼容）：requesters[] 优先，缺失从旧字段 requester_name/phone 生成单业务方。
        //   规范化后第一条=主业务方，写主表 requester_name/phone 作兼容冗余 + 列表显示（§5.1）；全部写子表（§5.2 真相源）。
        const fallbackPrimary = {
            name: (typeof b.requester_name === 'string' ? b.requester_name.trim() : ''),
            phone: (typeof b.requester_phone === 'string' && b.requester_phone.trim()) ? b.requester_phone.trim() : null,
        };
        const normRes = normalizeCorrectionRequesters(b.requesters, fallbackPrimary);
        if (!normRes.ok) return res.status(400).json({ error: normRes.error, code: normRes.code });   // 上限超标（codex 49 M-1）
        const cleanedRequesters = normRes.cleaned;
        if (cleanedRequesters.length === 0) {
            return res.status(400).json({ error: '缺少必填字段：业务方（requester_name 或 requesters[] 至少一个非空姓名）', code: 'MISSING_REQUIRED_FIELDS' });
        }
        const primaryRequester = cleanedRequesters[0];
        const requesterName = primaryRequester.name;       // 主业务方 → 主表兼容冗余
        // error_proof_note（§6.1 / D-10）：建单错误证明说明，可选；≤1000 防御性上限（方案未规定，对齐 note 类字段做有界，防无界 TEXT）
        let errorProofNote = null;
        if (typeof b.error_proof_note === 'string' && b.error_proof_note.trim()) {
            errorProofNote = b.error_proof_note.trim();
            if (errorProofNote.length > 1000) return res.status(400).json({ error: '错误证明说明过长（≤1000 字）', code: 'ERROR_PROOF_NOTE_TOO_LONG' });
        }

        // codex 09 M-4：路径 A（assigned_to 直接指派）与路径 B（relay_notified_user_id 先通知对接人）互斥（§4.2 二选一）。
        //   同传会让单进 ASSIGNED 却又留对接人意图，C/D 误发对接人通知。
        const hasAssign = b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== '';
        const hasRelay = b.relay_notified_user_id !== undefined && b.relay_notified_user_id !== null && b.relay_notified_user_id !== '';
        if (hasAssign && hasRelay) {
            return res.status(400).json({ error: '不能同时直接指派开发和指定对接人（路径 A/B 二选一）', code: 'ASSIGN_AND_RELAY_CONFLICT' });
        }

        // 选填（2026-06-15 复审：删除 source_table——表名只有开发知道且可能涉及多表，不在受理建单环节录）
        const reasonText = (typeof b.reason === 'string' && b.reason.trim()) ? b.reason.trim() : null;
        const oaNumber = (typeof b.oa_number === 'string' && b.oa_number.trim()) ? b.oa_number.trim() : null;
        // 修正条数（H/#6 codex 22 M-3 + codex 24 M-1 严格正则）：可空；非空须为十进制正整数 1-999999999。
        //   用正则而非 Number.isInteger——后者放行字符串 "5.0"/"1e3"/"0x10"/超大数，与前端 /^[1-9]\d{0,8}$/ 口径分裂。
        //   注（codex 25 RC-L1）：正则拦的是"字符串输入形态"（前端 number input 传的是字符串）；若 API 直传 JSON
        //   数字 5.0/1e3，body parser 已归一为整数 5/1000（JSON 中 5.0≡5），属合法整数值，放行无害。
        //   ⚠️ 此正则须与前端 Data_Correction.html submitCorrection 同步。
        let correctionCount = null;
        if (b.correction_count !== undefined && b.correction_count !== null && String(b.correction_count).trim() !== '') {
            const raw = String(b.correction_count).trim();
            if (!/^[1-9]\d{0,8}$/.test(raw)) {
                return res.status(400).json({ error: '修正条数须为正整数（1-999999999）', code: 'INVALID_CORRECTION_COUNT' });
            }
            correctionCount = Number(raw);
        }
        const requesterDept = (typeof b.requester_dept === 'string' && b.requester_dept.trim()) ? b.requester_dept.trim() : null;
        const requesterPhone = primaryRequester.phone;   // 主业务方手机号 → 主表兼容冗余（L2：取自 cleanedRequesters[0]，不再单读 b.requester_phone）
        // deadline：客户端传了合法值归一化用之，否则后端智能默认（§4.1，仅参考可空）
        const expectedDeadline = normalizeCorrectionDatetime(b.expected_deadline) || correctionDefaultDeadline();

        // 路径 B（路线 B）：对接人 = 固定白名单 CORRECTION_RELAY_USER_IDS（非角色口径）；transition 指派分支对白名单
        //   relay 权威放行，故 user 角色也能指派。仍校验「在白名单 + 用户存在 + 有手机号」——手机号是钉钉通知对接人的
        //   必要条件（sendIssueDingtalkRaw 按手机号反查钉钉），缺则将来换人会令单卡死，建单时即拒（M-3 / RC-M2 trim 非空）。
        let relayUserId = null;
        if (hasRelay) {
            const relayId = parsePositiveCorrectionId(b.relay_notified_user_id);
            if (!relayId) return res.status(400).json({ error: '对接人 ID 非法', code: 'INVALID_RELAY_USER_ID' });   // RC-L3
            if (!isCorrectionRelayWhitelisted(relayId)) {
                return res.status(400).json({ error: '对接人不在指定名单内', code: 'RELAY_USER_NOT_IN_WHITELIST' });
            }
            const relayU = await dbGetAsync('SELECT id, phone FROM users WHERE id = ?', [relayId]);
            if (!relayU) return res.status(400).json({ error: '对接人不存在', code: 'RELAY_USER_NOT_FOUND' });
            if (!String(relayU.phone || '').trim()) {
                return res.status(400).json({ error: '对接人未绑定手机号，无法接收钉钉通知', code: 'RELAY_USER_NO_PHONE' });
            }
            relayUserId = relayU.id;
        }

        // 路径 A（默认）：建单带 assigned_to → 先校验存在 + 非 viewer（R-4），建单后立即走 transition（L-1）
        let assignTarget = null;
        if (hasAssign) {
            const devId = parsePositiveCorrectionId(b.assigned_to);
            if (!devId) return res.status(400).json({ error: '指派目标 ID 非法', code: 'INVALID_ASSIGN_TARGET_ID' });   // RC-L3
            const dev = await dbGetAsync('SELECT id, display_name, role FROM users WHERE id = ?', [devId]);
            if (!dev) return res.status(400).json({ error: '指派目标用户不存在', code: 'ASSIGN_TARGET_NOT_FOUND' });
            if (dev.role === 'viewer') return res.status(400).json({ error: '不能指派给查看者（viewer）', code: 'ASSIGN_TARGET_VIEWER' });
            assignTarget = dev;
        }

        const createdBy = Number(req.user.id);
        const createdByName = req.user.display_name || req.user.username;

        // INSERT 主表（PENDING_ASSIGN）+ history 首行（NULL→PENDING_ASSIGN）同事务（对齐 issue C3 POST 范式）
        let newId;
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            const result = await dbRunAsync(
                `INSERT INTO correction_requests
                   (source_system, source_system_other, location_info, correction_count,
                    reason, oa_number, correction_type, requester_dept, requester_name, requester_phone,
                    status, expected_deadline, relay_notified_user_id, created_by, created_by_name, error_proof_note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ASSIGN', ?, ?, ?, ?, ?)`,
                [sourceSystem, sourceSystem === '其他' ? sourceSystemOther : null, locationInfo, correctionCount,
                 reasonText, oaNumber, correctionType, requesterDept, requesterName, requesterPhone,
                 expectedDeadline, relayUserId, createdBy, createdByName, errorProofNote]
            );
            newId = result.lastID;
            await dbRunAsync(
                `INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
                 VALUES (?, NULL, 'PENDING_ASSIGN', ?, ?, ?)`,
                [newId, '信息技术部建单', createdBy, createdByName]
            );
            // L2（§5.2 / §6.1 契约 A）：业务方写子表（完成通知真相源）；主表 requester_name/phone 已写主业务方兼容冗余。
            await writeCorrectionRequesters(newId, cleanedRequesters);
            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }

        // 路径 A：建单带 assigned_to → 立即走 correctionTransition（L-1：产生 history，不直接 INSERT 已指派态）
        let assigned = false;
        if (assignTarget) {
            await correctionTransition(newId, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE',
                { id: createdBy, name: createdByName, role: req.user.role },
                { assigned_to: assignTarget.id, assigned_to_name: assignTarget.display_name, assigned_by: createdBy });
            assigned = true;
            // I1（§2.7 拆自动发）：建单直接指派不再自动发钉钉，notify_status 保持 not_sent；
            //   admin 在详情页手动点「通知开发」按钮触发 POST /:id/notify-developer。
        }
        // I1（§2.7 拆自动发）：建单 path B 不再自动发钉钉给对接人，只记 relay_notified_user_id（已 INSERT）；
        //   relay_notify_status 保持 not_sent，admin 在详情页手动点「通知对接人」按钮触发 POST /:id/notify-relay。

        logger.info(`用户 ${req.user.username} 建数据修正单 #${newId}（${correctionType}/${sourceSystem}）` +
            `${assigned ? ' + 直接指派' : ''}${relayUserId ? ' + 路径B对接人(待手动通知)' : ''}`);
        // I1：建单不再自动发通知，relay_notify_sent 字段移除；通知开发/对接人改详情页手动按钮 + 查已读
        res.json({
            id: newId,
            status: assigned ? 'ASSIGNED_PENDING_ESTIMATE' : 'PENDING_ASSIGN'
        });
    } catch (err) {
        if (err instanceof CorrectionTransitionError) {
            return res.status(err.httpStatus).json({ error: err.message, code: err.code });
        }
        logger.error('建数据修正单失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/corrections/:id/assign 指派（§4.2 / R-4 / 路径 A·B 共用同一 transition）──────────
//   权限 requireRelayOrPublisherOrAdmin（粗筛：admin/publisher 或白名单对接人）；handler 校验被指派开发，
//   correctionTransition 指派分支再权威校验「白名单 relay 仅能派其本人经手的 PENDING_ASSIGN 单」（路线 B）。
router.post('/:id/assign', authenticateToken, requireCorrectionSchemaReady, requireRelayOrPublisherOrAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的修正单 ID', code: 'INVALID_CORRECTION_ID' });   // codex 09 L-6
    try {
        const assignedTo = (req.body || {}).assigned_to;
        if (assignedTo === undefined || assignedTo === null || assignedTo === '') {
            return res.status(400).json({ error: '必须指定被指派开发', code: 'ASSIGN_TARGET_REQUIRED' });
        }
        const devId = parsePositiveCorrectionId(assignedTo);   // RC-L3
        if (!devId) return res.status(400).json({ error: '指派目标 ID 非法', code: 'INVALID_ASSIGN_TARGET_ID' });
        // R-4：assigned_to 存在 + 非 viewer（防僵尸单）
        const dev = await dbGetAsync('SELECT id, display_name, role FROM users WHERE id = ?', [devId]);
        if (!dev) return res.status(400).json({ error: '指派目标用户不存在', code: 'ASSIGN_TARGET_NOT_FOUND' });
        if (dev.role === 'viewer') return res.status(400).json({ error: '不能指派给查看者（viewer）', code: 'ASSIGN_TARGET_VIEWER' });

        const actor = { id: Number(req.user.id), name: req.user.display_name || req.user.username, role: req.user.role };
        // 指派只从 PENDING_ASSIGN 出发（流转表无 ASSIGNED→ASSIGNED；已指派单 expectedFromStatus 不符 → 409）
        await correctionTransition(id, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor,
            { assigned_to: dev.id, assigned_to_name: dev.display_name, assigned_by: actor.id });
        // I3（§2.7 拆自动发，补 I1 遗漏）：详情页内联指派与建单 path A 对齐——不再自动发钉钉，notify_status 保持 not_sent；
        //   admin/publisher 在详情页手动点「通知开发」按钮触发 POST /:id/notify-developer（可发态 ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS）。
        logger.info(`用户 ${req.user.username} 指派数据修正单 #${id} 给 ${dev.display_name}（待手动通知）`);
        res.json({ id, assigned_to: dev.id, assigned_to_name: dev.display_name, status: 'ASSIGNED_PENDING_ESTIMATE' });
    } catch (err) {
        if (err instanceof CorrectionTransitionError) {
            return res.status(err.httpStatus).json({ error: err.message, code: err.code });
        }
        logger.error('指派数据修正单失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/corrections/:id/reassign 改派（D-13 §6.8；镜像 issue v1.75.0 C2 改人范式；codex 46 收口）──
//   仅 ASSIGNED_PENDING_ESTIMATE 态可改派（开发尚未回复 ETA）；IN_PROGRESS（已回复/开工）→ 走作废重建。
//   ⭐ reassign **不走 correctionTransition**（状态不变，是带守卫的字段 UPDATE，类比 issue C2），故权限精校验 / 状态守卫 /
//      乐观锁都在 handler 事务内自做（对齐本模块 correctionTransition 的「事务内读真实 row + 双条件 WHERE + changes 检查」范式）。
//   中间件 requireRelayOrPublisherOrAdmin 仅粗筛；handler 内复刻 /assign 指派分支精校验（白名单对接人仅限本人经手 relay 单，RC4-M1）。
router.post('/:id/reassign', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, requireRelayOrPublisherOrAdmin, async (req, res) => {
    const id = Number(req.params.id);
    try {
        // 新开发校验（RC4-L1）：完全复用 /assign 当前口径（存在 + 非 viewer，不额外限 role=developer，避免与首派不一致）。
        const assignedTo = (req.body || {}).assigned_to;
        if (assignedTo === undefined || assignedTo === null || assignedTo === '') {
            return res.status(400).json({ error: '必须指定新的被指派开发', code: 'REASSIGN_TARGET_REQUIRED' });
        }
        const newDevId = parsePositiveCorrectionId(assignedTo);
        if (!newDevId) return res.status(400).json({ error: '改派目标 ID 非法', code: 'INVALID_REASSIGN_TARGET_ID' });
        const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [newDevId]);
        if (!dev) return res.status(400).json({ error: '改派目标用户不存在', code: 'REASSIGN_TARGET_NOT_FOUND' });
        if (dev.role === 'viewer') return res.status(400).json({ error: '不能改派给查看者（viewer）', code: 'REASSIGN_TARGET_VIEWER' });
        // L-2（codex 53）：开发名兜底——display_name 空时回退 username/id，对齐前端下拉口径 display_name||username，避免 history/assigned_to_name 出现空名。
        const devName = dev.display_name || dev.username || String(dev.id);

        const actor = correctionActor(req);
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            // 事务内读真实 row（权限精校验 + 状态守卫 + 乐观锁基线，不信客户端）。
            //   reassign 权限 = admin/publisher/本单对接人（不含 creator，与首派 /assign 同口径）。
            const row = await dbGetAsync(
                'SELECT id, relay_notified_user_id, assigned_to, assigned_to_name, status FROM correction_requests WHERE id = ?',
                [id]
            );
            if (!row) { await dbRunAsync('ROLLBACK'); return res.status(404).json({ error: '修正单不存在' }); }

            // 权限精校验（RC4-M1，复刻 /assign 指派分支）：admin/publisher 放行；白名单对接人仅当
            //   isCorrectionRelayWhitelisted(actor.id) && relay_notified_user_id===actor.id 才放行（否则 403）——
            //   不能只靠粗筛中间件，否则对接人能改派非本人经手的 relay 单。
            const isAdminOrPub = actor.role === 'admin' || actor.role === 'publisher';
            const isOwnRelay = isCorrectionRelayWhitelisted(actor.id) && Number(row.relay_notified_user_id) === Number(actor.id);
            if (!isAdminOrPub && !isOwnRelay) {
                await dbRunAsync('ROLLBACK');
                return res.status(403).json({ error: '无权改派此修正单（仅管理员/发布者或本单对接人）', code: 'NOT_AUTHORIZED_TO_REASSIGN' });
            }

            // 状态守卫（RC4-L3）：仅 ASSIGNED_PENDING_ESTIMATE 可改派；IN_PROGRESS 专属错误码引导作废重建。
            if (row.status === 'IN_PROGRESS') {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({ error: '开发已回复预计完成/开工，不支持改派，请走作废重建', code: 'REASSIGN_NOT_ALLOWED_AFTER_ESTIMATE' });
            }
            if (row.status !== 'ASSIGNED_PENDING_ESTIMATE') {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({ error: `当前状态「${row.status}」不可改派（仅「待回复预计」态可改派）`, code: 'REASSIGN_STATUS_INVALID' });
            }

            const oldAssignedTo = Number(row.assigned_to);
            if (!(oldAssignedTo > 0)) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({ error: '本单尚无被指派开发，无法改派', code: 'REASSIGN_NO_ASSIGNEE' });
            }
            if (oldAssignedTo === dev.id) {
                await dbRunAsync('ROLLBACK');
                return res.status(400).json({ error: '新开发与当前开发相同，无需改派', code: 'REASSIGN_NO_CHANGE' });
            }

            // 乐观锁 + 更新（RC4-M3 / RC4-M2）：双条件 WHERE 绑 status + oldAssignedTo（该态 assigned_to 非空，用 =? 不用 IS ?）；
            //   重置开发通知态完整清单（含 notify_error，否则前端仍显示旧开发的发送错误）。
            const upd = await dbRunAsync(
                `UPDATE correction_requests
                    SET assigned_to = ?, assigned_to_name = ?, assigned_by = ?, assigned_at = datetime('now','localtime'),
                        notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL, notify_error = NULL, read_at = NULL
                  WHERE id = ? AND status = 'ASSIGNED_PENDING_ESTIMATE' AND assigned_to = ?`,
                [dev.id, devName, actor.id, id, oldAssignedTo]
            );
            if (!upd || upd.changes !== 1) {
                await dbRunAsync('ROLLBACK');
                return res.status(409).json({ error: '修正单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_REASSIGN' });
            }
            // history 同态留痕（RC4-M4）：from=to=ASSIGNED_PENDING_ESTIMATE（状态不变，非状态机转移）；reason 记"改派 旧#X→新#Y"。
            await dbRunAsync(
                `INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
                 VALUES (?, 'ASSIGNED_PENDING_ESTIMATE', 'ASSIGNED_PENDING_ESTIMATE', ?, ?, ?)`,
                [id, `改派 旧#${oldAssignedTo}→新#${dev.id}（${row.assigned_to_name || '原开发'}→${devName}）`, actor.id, actor.name]
            );
            await dbRunAsync('COMMIT');
        } catch (txErr) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) {}
            throw txErr;
        }
        // RC4-L2：reassign 是单据级开发负责人字段更新，**不调 resolveCorrectionGroupAnchor、不跳主单**——
        //   跨系统子单按自身 id/status/assigned_to 独立改派，互不影响组闸门（组闸门只看完成态）。
        //   改派后由 admin/对接人重新手动点「通知开发」通知新开发（对齐现有手动模型，不自动发）。
        logger.info(`用户 ${actor.name} 改派数据修正单 #${id} → ${devName}（开发通知态已重置，待手动通知）`);
        res.json({ id, assigned_to: dev.id, assigned_to_name: devName, status: 'ASSIGNED_PENDING_ESTIMATE', reassigned: true });
    } catch (err) {
        logger.error('改派数据修正单失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/corrections 列表（最小版，§7.1 可见性 + G-14 软删过滤；时长/积压筛选留 F）────────
router.get('/', authenticateToken, requireCorrectionSchemaReady, async (req, res) => {
    try {
        const role = req.user.role;
        const uid = Number(req.user.id);
        const where = [];
        const params = [];
        // 默认过滤作废（G-14）；include_voided=1 仅 admin 可查作废（细优①收紧去 publisher，MS-L1）
        const includeVoided = req.query.include_voided === '1' && role === 'admin';   // 细优①：含已作废仅 admin（收紧去 publisher；前端 canViewVoided 同步，写读同源）
        if (!includeVoided) where.push('voided_at IS NULL');
        // 可见性最小版（§7.1）：admin/publisher 全部；其余（user/viewer）仅 assigned_to=self。F/G 再细化 viewer 只读惯例。
        if (role !== 'admin' && role !== 'publisher') {
            // 路线 B：白名单对接人额外可见其经手的 relay 单（全生命周期非作废）；移出白名单即失去此特权（含白名单判定）。
            if (isCorrectionRelayWhitelisted(uid)) {
                where.push('(assigned_to = ? OR relay_notified_user_id = ?)');
                params.push(uid, uid);
            } else {
                where.push('assigned_to = ?');
                params.push(uid);
            }
        }
        const rows = await dbAllAsync(
            `SELECT id, source_system, source_system_other, location_info, correction_type, status,
                    requester_name, requester_dept, requester_phone, assigned_to, assigned_to_name,
                    expected_deadline, dev_estimated_at, created_at, fixed_at, refixed_at, archived_at,
                    submission_count, created_by, created_by_name, dingtalk_chat_id,
                    relay_notified_at, relay_notify_status, notify_status, requester_notify_status, completion_notify_status, closure_type
               FROM correction_requests
              ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY id DESC`,
            params
        );
        res.json({ items: rows, total: rows.length });
    } catch (err) {
        logger.error('查询数据修正单列表失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/corrections/:id 详情（§7.1/§9.4 可见性：isAdmin||isPublisher||isCreator||isAssignee）────
router.get('/:id', authenticateToken, requireCorrectionSchemaReady, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的修正单 ID', code: 'INVALID_CORRECTION_ID' });   // codex 09 L-6
    try {
        const row = await dbGetAsync('SELECT * FROM correction_requests WHERE id = ?', [id]);
        if (!row) return res.status(404).json({ error: '修正单不存在' });
        // 作废单详情：细优①收紧——仅 admin 可见（与列表 include_voided 同步去 publisher，L-2 写读同源；避免泄露给 publisher/creator/assignee）
        const role = req.user.role, uid = Number(req.user.id);
        const isAdmin = role === 'admin', isPublisher = role === 'publisher';
        const isCreator = Number(row.created_by) === uid && uid > 0;
        const isAssignee = Number(row.assigned_to) === uid && uid > 0;
        // 路线 B：白名单对接人可见其经手 relay 单详情（含白名单判定 → 移出即失效）。全量可见不裁剪（内网内部人，附件=修正证明截图）。
        const isRelay = isCorrectionRelayWhitelisted(uid) && Number(row.relay_notified_user_id) === uid;
        if (!isAdmin && !isPublisher && !isCreator && !isAssignee && !isRelay) {
            return res.status(403).json({ error: '无权查看此修正单', code: 'NOT_AUTHORIZED_TO_VIEW' });
        }
        if (row.voided_at && !isAdmin) {
            return res.status(403).json({ error: '该修正单已作废', code: 'CORRECTION_VOIDED' });
        }
        const history = await dbAllAsync(
            `SELECT from_status, to_status, reason, operator_id, operator_name, created_at
               FROM correction_status_history WHERE correction_request_id = ? ORDER BY id`,
            [id]
        );
        const attachments = await dbAllAsync(
            `SELECT id, attachment_type, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name, created_at
               FROM correction_attachments WHERE correction_request_id = ? ORDER BY id`,
            [id]
        );
        // L3（§6.0/§7.2）：业务方子表 N 行（前端完成通知区按行渲染）+ 组信息（is_master/master_id/members，前端关联组区 + 子单跳主单）。
        //   锚点解析：标准单/主单 requesters=自身子表行；跨系统子单 requesters=主单子表行（is_master=false 时前端隐藏录入、显示"属关联组主单 #N"）。
        const anchor = await resolveCorrectionGroupAnchor(id);
        const requesters = anchor ? anchor.requesters.map(rq => ({
            id: rq.id, requester_name: rq.requester_name, requester_phone: rq.requester_phone, is_primary: rq.is_primary, seq: rq.seq,
            completion_notify_status: rq.completion_notify_status, completion_notified_at: rq.completion_notified_at,
            completion_notify_error: rq.completion_notify_error, completion_read_at: rq.completion_read_at,
        })) : [];
        const group = anchor ? { master_id: anchor.master_id, is_master: anchor.is_master, members: anchor.group_members } : null;
        res.json({ request: row, history, attachments, requesters, group });
    } catch (err) {
        logger.error('查询数据修正单详情失败:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 数据修正模块 API（v1.81.0 Commit C：reply-estimate + complete + resubmit + attachments）
//   方案 §4.3/§4.4/§4.4a/§4.5；节奏 Commit C。4 endpoint 全是"上传附件 + 调 correctionTransition"薄封装，
//   状态机闸门 Commit B 已就位（IN_PROGRESS 的 ESTIMATE / FIXED 的 fix_proof·batch_note / REFIXED 的新增性·resubmit_note）。
//   ⭐ RC-M1（codex 10 Commit B 复审遗留·主保证）：/resubmit（及 /complete single）严格"先上传本次附件 →
//      只把本次上传返回的 id 传入 transition"，保证传入 id 必属本次、created_at 必晚于基线 COALESCE(refixed_at,fixed_at)，
//      根治秒级同秒误拒（B 的 created_at>baseline 兜底是纵深第二道）。
// ============================================================

// ── correction 附件上传底座（镜像 issueUpload 范式：id 前置校验 → latin1→utf8 → ts_rand 命名）─────
const CORRECTION_UPLOAD_BASE = path.join(UPLOAD_DIR, 'correction');
const CORRECTION_PENDING_BASE = path.join(CORRECTION_UPLOAD_BASE, '_pending');
if (!fs.existsSync(CORRECTION_UPLOAD_BASE)) {
    fs.mkdirSync(CORRECTION_UPLOAD_BASE, { recursive: true });
}
// §9.26：fix_proof/error_proof 限图片/PDF/xlsx（比 collab union 窄——结果证明截图/示例表场景，不含 sql/txt/docx）
const CORRECTION_ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.xlsx', '.xls'];
const correctionStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 暂存 _pending/{rid}/：multer 是前置中间件，先落 _pending，handler 校验权限/状态通过后再 rename 正式目录。
        //   纵深防御（对齐 issue C4a H-1）：destination 自身也不信任 req.params.id，非正整数直接 cb(error)。
        const reqId = req.params.id;
        if (!/^[1-9]\d*$/.test(String(reqId))) return cb(new Error('非法修正单 id'));
        const targetDir = path.join(CORRECTION_PENDING_BASE, String(reqId));
        try { fs.mkdirSync(targetDir, { recursive: true }); cb(null, targetDir); } catch (e) { cb(e); }
    },
    filename: function (req, file, cb) {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');   // 中文名乱码修复（同 issue 12500）
        const ts = Date.now();
        const rand = Math.round(Math.random() * 1e9);
        const safeOriginal = file.originalname.replace(/[\\/:*?"<>|]/g, '_');
        cb(null, `${ts}_${rand}_${safeOriginal}`);
    }
});
const correctionUpload = multer({
    storage: correctionStorage,
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },   // 单文件 20MB（截图/示例表），单次最多 5 张
    fileFilter: function (req, file, cb) {
        const ext = normalizeAttachmentExt(file.originalname);
        if (!ext) return cb(new Error('文件名为空或包含非法字符'));
        if (!CORRECTION_ALLOWED_EXTS.includes(ext)) return cb(new Error(`不支持的扩展名 ${ext}，仅允许 ${CORRECTION_ALLOWED_EXTS.join('/')}`));
        cb(null, true);
    }
});
// id 前置校验中间件（必须在 multer 之前，对齐 issue 11289）
function correctionIdGuard(req, res, next) {
    if (!/^[1-9]\d*$/.test(String(req.params.id))) return res.status(400).json({ error: 'id 必须是正整数' });
    next();
}
// multer 错误 → JSON 包装（MulterError 走 Express error flow，handler try/catch 接不到，故手动 invoke + 清理）
function correctionUploadMw(field, maxCount) {
    return (req, res, next) => {
        correctionUpload.array(field, maxCount)(req, res, (err) => {
            if (!err) return next();
            const isMulterErr = err && err.name === 'MulterError';
            const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
            // L-1（codex 11）：清 req.files + 按 rid rmdir 空 _pending（多文件部分失败的极少数 partial-write 残留靠 integrity 巡检兜底，同 issue 范式）
            try { correctionCleanupPending(req, req.params.id); } catch (_) {}
            logger.warn(`[correction-attach] multer error: code=${code} msg=${err.message}`);
            return res.status(400).json({ error: '上传文件失败', code, detail: isMulterErr ? err.message : (err.message || '上传过程异常') });
        });
    };
}
// 把本次 _pending 文件移正式目录 uploads/correction/{rid}/ + INSERT correction_attachments，返回 [{id,file_name,...}]。
//   uploaded_by NOT NULL（R-3）。file_name 存相对路径（供静态下载，同 issue relPath 范式）。任一步失败 → 内部 best-effort 回滚。
async function correctionPersistAttachments(rid, files, attachmentType, uploader) {
    const finalDir = path.join(CORRECTION_UPLOAD_BASE, String(rid));
    fs.mkdirSync(finalDir, { recursive: true });
    const inserted = [];
    const movedPaths = [];
    try {
        for (const f of files) {
            const finalName = f.filename;
            const finalPath = path.join(finalDir, finalName);
            fs.renameSync(f.path, finalPath);
            movedPaths.push(finalPath);
            const relPath = path.join('correction', String(rid), finalName).replace(/\\/g, '/');
            const fileSize = (typeof f.size === 'number') ? f.size : null;
            const mimeType = (typeof f.mimetype === 'string' && f.mimetype.trim()) ? f.mimetype : null;
            const r = await dbRunAsync(
                `INSERT INTO correction_attachments
                    (correction_request_id, attachment_type, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [rid, attachmentType, relPath, f.originalname, fileSize, mimeType, uploader.id, uploader.name]
            );
            inserted.push({ id: r.lastID, attachment_type: attachmentType, file_name: relPath, original_name: f.originalname, file_size: fileSize, mime_type: mimeType });
        }
        return inserted;
    } catch (e) {
        for (const ins of inserted) { try { await dbRunAsync('DELETE FROM correction_attachments WHERE id = ?', [ins.id]); } catch (_) {} }
        for (const p of movedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
        throw e;
    }
}
// transition 失败时回滚本次已落库附件（RC-M1：失败的上传不应留存为历史 fix_proof）
async function correctionRollbackPersisted(persisted) {
    for (const a of (persisted || [])) {
        try { await dbRunAsync('DELETE FROM correction_attachments WHERE id = ?', [a.id]); } catch (_) {}
        try { safeDeleteFileSync(a.file_name, UPLOAD_DIR); } catch (_) {}
    }
}
// 清理本次 _pending 残留（handler 校验失败、未移动时调）
function correctionCleanupPending(req, rid) {
    try { collabSubmitHelpers.cleanupPendingFiles(req.files, logger); } catch (_) {}
    if (rid && /^[1-9]\d*$/.test(String(rid))) { try { fs.rmdirSync(path.join(CORRECTION_PENDING_BASE, String(rid))); } catch (_) {} }
}
// actor（transition 权限校验 + history operator 留痕）
function correctionActor(req) {
    return { id: Number(req.user.id), name: req.user.display_name || req.user.username || `user#${req.user.id}`, role: req.user.role };
}
// CorrectionTransitionError → HTTP
function sendCorrectionTransitionError(res, e) {
    if (e instanceof CorrectionTransitionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    logger.error('correctionTransition 未预期错误:', e && e.message);
    return res.status(500).json({ error: (e && e.message) || '状态流转失败' });
}

// ============================================================
// L2 业务方子表 helper（跨系统关联方案 §5.3 / §6.0 / §6.3）——多业务方真相源 correction_requesters。
// ============================================================
// requesters[] 规范化 + 上限校验（RC-L2 §5.3）：集中业务方入参规则（建单/追加共用）。
//   返回 { ok, cleaned, error, code }——ok=false 时调用方据 code 返 400。
//   清洗：name trim 必填、phone trim 空串归 NULL、跳过空名条目；**仅取 string 标量**（codex 49 L-3：
//     非字符串如 {name:123}/{phone:{}} 不取值，避免 "[object Object]" 静默落库）。
//   上限（codex 49 M-1，防御性，内网低并发场景宽松值）：requesters ≤20 / name ≤100 / phone ≤50。
//   rawList（建单 requesters[]）优先；缺失回退 fallbackPrimary（旧字段单业务方，契约 A 兼容）。
function normalizeCorrectionRequesters(rawList, fallbackPrimary) {
    const MAX_REQUESTERS = 20, MAX_NAME = 100, MAX_PHONE = 50;
    if (Array.isArray(rawList) && rawList.length > MAX_REQUESTERS) {
        return { ok: false, cleaned: [], error: `业务方过多（最多 ${MAX_REQUESTERS} 个）`, code: 'TOO_MANY_REQUESTERS' };
    }
    let list = Array.isArray(rawList) ? rawList : null;
    if (!list || list.length === 0) {
        list = (fallbackPrimary && typeof fallbackPrimary.name === 'string' && fallbackPrimary.name.trim()) ? [fallbackPrimary] : [];
    }
    const cleaned = [];
    for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        const name = (typeof r.name === 'string') ? r.name.trim() : ((typeof r.requester_name === 'string') ? r.requester_name.trim() : '');
        if (!name) continue;   // 空名条目跳过（§5.3：调用方据 cleaned.length>=1 判 400）
        if (name.length > MAX_NAME) return { ok: false, cleaned: [], error: `业务方姓名过长（≤${MAX_NAME} 字）`, code: 'REQUESTER_NAME_TOO_LONG' };
        const phoneStr = (typeof r.phone === 'string') ? r.phone.trim() : ((typeof r.requester_phone === 'string') ? r.requester_phone.trim() : '');
        if (phoneStr.length > MAX_PHONE) return { ok: false, cleaned: [], error: `业务方手机号过长（≤${MAX_PHONE} 字）`, code: 'REQUESTER_PHONE_TOO_LONG' };
        cleaned.push({ name, phone: phoneStr || null });
    }
    return { ok: true, cleaned };
}
// 写业务方子表（建单/追加事务内调，用同连接 dbRunAsync）：第一条=主业务方 is_primary=1 seq=1，其余 seq 递增。
//   status 初值 'not_sent'（§6.6 枚举）。调用方须先 normalizeCorrectionRequesters 且保证 cleaned.length>=1（§5.3 H-1 至少一条）。
async function writeCorrectionRequesters(rid, cleaned) {
    for (let i = 0; i < cleaned.length; i++) {
        const r = cleaned[i];
        await dbRunAsync(
            `INSERT INTO correction_requesters
                (correction_request_id, requester_name, requester_phone, is_primary, seq, completion_notify_status)
             VALUES (?,?,?,?,?,'not_sent')`,
            [rid, r.name, r.phone, i === 0 ? 1 : 0, i + 1]
        );
    }
}
// 业务方锚点解析（§6.0）：统一主子判断。无组单 master=自身；有组单 master=correction_group_id。
//   返回 group_members（含状态，供组闸门）+ requesters（只在 master 上的子表行，is_primary 优先排序）。
//   详情 / notify-done / read-status(done) / 追加 / error_proof 上传统一先调此 helper 再做主子/归属判断。
//   ⚠️ 依赖不变量（codex 49 M-2，L4/§6.2 写时强制 + verify 钉死）：标准单 group_id=NULL；主单 group_id=id（自身）；
//     子单 group_id=master_id(≠自身)。即"任何组都有一条 group_id=id 的主单"。L4 跨系统建单/§6.2 源单升主单
//     必须同事务回填主单 group_id=id，否则从主单入口 resolve 会漏算组成员。此处不做"group_id NULL 时额外查子单"
//     的运行时兜底（会让每个独立单常态多一次必空查询，且掩盖不变量违反）——改用 verify 守不变量（早失败优于兜底）。
async function resolveCorrectionGroupAnchor(correctionId) {
    const row = await dbGetAsync('SELECT id, correction_group_id FROM correction_requests WHERE id = ?', [correctionId]);
    if (!row) return null;
    const masterId = (row.correction_group_id == null) ? Number(row.id) : Number(row.correction_group_id);
    const isMaster = (masterId === Number(row.id));
    const groupMembers = (row.correction_group_id == null)
        ? await dbAllAsync('SELECT id, status, closure_type, source_system FROM correction_requests WHERE id = ?', [masterId])
        : await dbAllAsync('SELECT id, status, closure_type, source_system FROM correction_requests WHERE correction_group_id = ?', [masterId]);
    const requesters = await dbAllAsync(
        'SELECT * FROM correction_requesters WHERE correction_request_id = ? ORDER BY is_primary DESC, seq', [masterId]);
    return { this_id: Number(row.id), master_id: masterId, is_master: isMaster, group_members: groupMembers, requesters };
}
// 组完成判定（§6.3）：仅 FIXED/REFIXED 或 ARCHIVED+normal 视为"该成员已完成"；VOIDED/REJECTED/admin_closure/未完成 阻塞。
//   仅用于"组内其他成员是否完成"的读判定（RC-L1）；端点可发态闸门另限主单当前 FIXED/REFIXED（不靠本函数）。
function isGroupMemberDoneForBusinessNotify(member) {
    if (!member) return false;
    if (member.status === 'FIXED' || member.status === 'REFIXED') return true;
    if (member.status === 'ARCHIVED' && member.closure_type === 'normal') return true;
    return false;
}

// ── POST /:id/reply-estimate 回复预计完成时间（→IN_PROGRESS，§4.3 / ESTIMATE_REQUIRED 闸门）─────
//   权限在 transition 内校（admin/assignee）。钉钉通知业务方延 Commit D（对齐 B scope 决策：钉钉统一 D）。
router.post('/:id/reply-estimate', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const devEstimatedAt = (req.body && req.body.dev_estimated_at !== undefined) ? req.body.dev_estimated_at : null;
        const r = await correctionTransition(id, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', correctionActor(req), { dev_estimated_at: devEstimatedAt });
        // I1（§2.7 拆自动发）：回复预计不再自动通知业务方，requester_notify_status 保持 not_sent；
        //   admin/assignee 在详情页手动点「通知业务方·预计完成」按钮触发 POST /:id/notify-estimate（可发状态 = IN_PROGRESS）。
        return res.json({ ok: true, id, status: r.toStatus });
    } catch (e) { return sendCorrectionTransitionError(res, e); }
});

// ── POST /:id/complete 标完成（→FIXED，§4.4 / G-8）：single multipart 上传 fix_proof / batch 文字描述 ──
//   single：先上传本次 fix_proof（落库）→ transition→FIXED（FIXED 闸门查历史存在合规 fix_proof，本次刚上传即满足，
//   uploaded_by=actor.id 命中 H-2 归属）。batch：无附件要求，走 batch_completion_note（误传文件也落库为可选证据）。
router.post('/:id/complete', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, correctionUploadMw('files', 5), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let persisted = [];
    try {
        const row = await dbGetAsync('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
        if (!row) { correctionCleanupPending(req, id); return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' }); }
        // 预校验权限（避免上传落库后才被 transition 拒造成 orphan）：admin 或被指派开发本人。transition 内会再权威校一次。
        const actor = correctionActor(req);
        const isAdmin = actor.role === 'admin';
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAdmin && !isAssignee) { correctionCleanupPending(req, id); return res.status(403).json({ error: '无权标完成（仅被指派开发本人或 admin）', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        const files = Array.isArray(req.files) ? req.files : [];
        if (row.correction_type === 'single') {
            if (files.length === 0) { correctionCleanupPending(req, id); return res.status(400).json({ error: '单数据修正标完成必须上传结果证明截图', code: 'FIX_PROOF_REQUIRED' }); }
            persisted = await correctionPersistAttachments(id, files, 'fix_proof', actor);
            const r = await correctionTransition(id, 'IN_PROGRESS', 'FIXED', actor, { batch_completion_note: (req.body && req.body.batch_completion_note) || '' });   // 完成说明选填（single 复用 batch_completion_note 字段）
            return res.json({ ok: true, id, status: r.toStatus, attachments: persisted });
        } else {
            if (files.length > 0) persisted = await correctionPersistAttachments(id, files, 'fix_proof', actor);
            const r = await correctionTransition(id, 'IN_PROGRESS', 'FIXED', actor, { batch_completion_note: (req.body && req.body.batch_completion_note) || '' });
            return res.json({ ok: true, id, status: r.toStatus, attachments: persisted });
        }
    } catch (e) {
        await correctionRollbackPersisted(persisted);   // transition 失败 → 回滚本次附件（失败的上传不留存）
        correctionCleanupPending(req, id);
        return sendCorrectionTransitionError(res, e);
    }
});

// ── POST /:id/resubmit 重修提交（→REFIXED，§4.4a 类型一 / G-9/G-12，⭐RC-M1）──────────────────
//   single：先上传本次 fix_proof → 拿本次 id → transition→REFIXED 传 new_fix_proof_attachment_ids（新增性校验）。
//   batch：resubmit_note → transition（写 history.reason）。submission_count+1 在 transition 内。
router.post('/:id/resubmit', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, correctionUploadMw('files', 5), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let persisted = [];
    try {
        const row = await dbGetAsync('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
        if (!row) { correctionCleanupPending(req, id); return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' }); }
        const actor = correctionActor(req);
        const isAdmin = actor.role === 'admin';
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAdmin && !isAssignee) { correctionCleanupPending(req, id); return res.status(403).json({ error: '无权重修提交（仅被指派开发本人或 admin）', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        const files = Array.isArray(req.files) ? req.files : [];
        if (row.correction_type === 'single') {
            if (files.length === 0) { correctionCleanupPending(req, id); return res.status(400).json({ error: '单数据修正重修提交必须上传本次新增结果证明', code: 'FIX_PROOF_REQUIRED' }); }
            persisted = await correctionPersistAttachments(id, files, 'fix_proof', actor);
            const newIds = persisted.map(a => a.id);   // ⭐RC-M1：只传本次上传 id（保证本次新增 + created_at>baseline）
            const r = await correctionTransition(id, row.status, 'REFIXED', actor, { new_fix_proof_attachment_ids: newIds, resubmit_note: (req.body && req.body.resubmit_note) || '' });   // 重修说明选填（对称 batch，进 history.reason）
            return res.json({ ok: true, id, status: r.toStatus, attachments: persisted });
        } else {
            if (files.length > 0) persisted = await correctionPersistAttachments(id, files, 'fix_proof', actor);
            const r = await correctionTransition(id, row.status, 'REFIXED', actor, { resubmit_note: (req.body && req.body.resubmit_note) || '' });
            return res.json({ ok: true, id, status: r.toStatus, attachments: persisted });
        }
    } catch (e) {
        await correctionRollbackPersisted(persisted);
        correctionCleanupPending(req, id);
        return sendCorrectionTransitionError(res, e);
    }
});

// ── POST /:id/attachments 补充附件（§4.4a 类型二，旁路 append，不调 transition / 不改状态 / 不增 count）──
//   权限 creator/assignee/admin（M-2，比 transition 宽）。状态须 ∈{FIXED,REFIXED}（§2.2 M-1：防完成前伪造留证）。
//   ⚠️ attachment_type 统一 fix_proof（§4.4a M-1）；creator 上传的 fix_proof 不满足 H-2 归属（uploaded_by≠assignee/admin），
//      故不计入 FIXED/REFIXED 完成闸门（闸门 COUNT 已按 uploaded_by 过滤）——仅作补充证据留存。〔待 codex 确认此口径〕
router.post('/:id/attachments', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, correctionUploadMw('files', 5), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let persisted = [];   // M-1（codex 20 末次审）：提升到 handler 作用域，catch 才能回滚（对齐 /complete·/resubmit；防 recheck dbGet 抛错时 orphan 附件）
    try {
        // L2 type 分流（§6.7）：规范化 attachment_type，枚举仅 error_proof/fix_proof，缺省 fix_proof，枚举外 400。
        //   ⚠️ 所有拒绝分支（400/403/409）都先 correctionCleanupPending 清 multer 已落的 _pending，防孤儿文件。
        const rawType = (req.body && typeof req.body.attachment_type === 'string') ? req.body.attachment_type.trim() : '';
        const attachmentType = rawType || 'fix_proof';
        if (attachmentType !== 'fix_proof' && attachmentType !== 'error_proof') {
            correctionCleanupPending(req, id);
            return res.status(400).json({ error: 'attachment_type 非法（仅 fix_proof | error_proof）', code: 'INVALID_ATTACHMENT_TYPE' });
        }
        const row = await dbGetAsync('SELECT id, status, assigned_to, created_by, correction_group_id FROM correction_requests WHERE id = ?', [id]);
        if (!row) { correctionCleanupPending(req, id); return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' }); }
        const actor = correctionActor(req);
        const isAdmin = actor.role === 'admin';
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        const isCreator = Number(row.created_by) === actor.id && actor.id > 0;
        const files = Array.isArray(req.files) ? req.files : [];

        if (attachmentType === 'error_proof') {
            // ── error_proof（§6.7 / RC2-M4 / H-3）：先解析锚点，子单 → 409 引导主单（后端约束不靠前端隐藏）──
            const anchor = await resolveCorrectionGroupAnchor(id);
            if (!anchor) { correctionCleanupPending(req, id); return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' }); }   // codex 49 L-4：显式处理空 anchor（与 row 存在性校验语义一致，防数据竞争）
            if (anchor.is_master === false) {
                correctionCleanupPending(req, id);
                return res.status(409).json({ error: '错误证明只能传到主单', code: 'ERROR_PROOF_ON_MASTER_ONLY', master_id: anchor.master_id });
            }
            // 权限限 admin/建单人（建单错误证明是建单侧职责，非开发侧）
            if (!isAdmin && !isCreator) { correctionCleanupPending(req, id); return res.status(403).json({ error: '无权补充错误证明（仅建单人 / admin）', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
            // 早期态可补传：PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS/FIXED/REFIXED（排除 VOIDED/REJECTED/ARCHIVED）
            const ERROR_PROOF_STATES = ['PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'FIXED', 'REFIXED'];
            if (!ERROR_PROOF_STATES.includes(row.status)) { correctionCleanupPending(req, id); return res.status(409).json({ error: `当前状态「${row.status}」不可补充错误证明`, code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
            if (files.length === 0) { correctionCleanupPending(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
            persisted = await correctionPersistAttachments(id, files, 'error_proof', actor);
            // 旁路双 WHERE 守卫：persist 后重读状态仍属可补传态（闭 TOCTOU：校验→INSERT 间被作废/拒绝/归档则回滚）
            const recheckE = await dbGetAsync('SELECT status FROM correction_requests WHERE id = ?', [id]);
            if (!recheckE || !ERROR_PROOF_STATES.includes(recheckE.status)) {
                await correctionRollbackPersisted(persisted); persisted = [];
                return res.status(409).json({ error: '修正单状态已变更，补充错误证明已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
            }
            logger.info(`用户 ${req.user.username} 为修正单 #${id} 补充错误证明 ${persisted.length} 个（旁路 append）`);
            return res.json({ ok: true, id, attachment_type: 'error_proof', attachments: persisted });
        }

        // ── fix_proof（现状，行为不变）：仅 FIXED/REFIXED + admin/被指派开发/建单人 ──
        if (!isAdmin && !isAssignee && !isCreator) { correctionCleanupPending(req, id); return res.status(403).json({ error: '无权补充附件（仅建单人 / 被指派开发 / admin）', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
        if (row.status !== 'FIXED' && row.status !== 'REFIXED') { correctionCleanupPending(req, id); return res.status(409).json({ error: '仅已完成（FIXED/REFIXED）的修正单可补充附件', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
        if (files.length === 0) { correctionCleanupPending(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
        persisted = await correctionPersistAttachments(id, files, 'fix_proof', actor);
        // M-1（codex 11）：旁路无 transition 的双 WHERE 守卫——persist 后重读状态闭合 TOCTOU 窗口
        //   （校验→INSERT 间该单若被归档/作废，补充附件会 append 到非法态）。状态已变 → 回滚本次附件 + 409。
        const recheck = await dbGetAsync('SELECT status FROM correction_requests WHERE id = ?', [id]);
        if (!recheck || (recheck.status !== 'FIXED' && recheck.status !== 'REFIXED')) {
            await correctionRollbackPersisted(persisted);
            persisted = [];   // codex 21：已回滚，置空——rollback 本身幂等，此为显式收口防 catch 万一触发时重复回滚
            return res.status(409).json({ error: '修正单状态已变更，补充附件已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
        }
        logger.info(`用户 ${req.user.username} 为修正单 #${id} 补充附件 ${persisted.length} 个（旁路 append，不改状态）`);
        return res.json({ ok: true, id, attachment_type: 'fix_proof', attachments: persisted });   // 旁路：不调 transition、不改 status、不增 submission_count
    } catch (e) {
        // M-1（codex 20 末次审）：异常分支也回滚本次已落库附件（如 recheck dbGet 抛错），防 orphan；再清 _pending（对齐 /complete·/resubmit）
        await correctionRollbackPersisted(persisted);
        correctionCleanupPending(req, id);
        logger.error('补充附件失败:', e && e.message);
        return res.status(500).json({ error: (e && e.message) || '补充附件失败' });
    }
});

// ============================================================
// 数据修正模块 API（v1.81.0 Commit D1：拒绝 + 归档 + 作废）
//   纯 correctionTransition 薄封装（无钉钉/无 multer）——闸门全在 transition（Commit B 已建 + verify 18/18 验过）：
//   REJECTED 分态权限 + R-1 完成态不可拒 / ARCHIVED friction_reason 摩擦闸门 / VOIDED 通用旁路 + 双 WHERE 守卫。
//   expectedFrom=null：reject/archive 有多个合法源态（reject 从 PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS；
//   archive 仅从 FIXED/REFIXED——非"ARCHIVED 可从任意态进"），靠 transition 流转合法性校验拦非法源态；void 通用旁路。
//   钉钉（指派/回复预计/完成通知/relay）统一在 Commit D2，本批不发网络。
// ============================================================

// ── POST /:id/reject 拒绝（→REJECTED，§4.6 / H-3 分态权限：PENDING_ASSIGN=admin/publisher，已指派/进行中 +本人开发）──
router.post('/:id/reject', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const r = await correctionTransition(id, null, 'REJECTED', correctionActor(req), { reject_reason: req.body && req.body.reject_reason });
        return res.json({ ok: true, id, status: r.toStatus });
    } catch (e) { return sendCorrectionTransitionError(res, e); }
});

// ── POST /:id/archive 归档（→ARCHIVED，§4.7 / G-13，发起过拉群 dingtalk_chat_id 非空→friction_reason 必填）──
router.post('/:id/archive', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const r = await correctionTransition(id, null, 'ARCHIVED', correctionActor(req), { closure_type: 'normal', friction_reason: req.body && req.body.friction_reason });
        return res.json({ ok: true, id, status: r.toStatus, closure_type: 'normal' });
    } catch (e) { return sendCorrectionTransitionError(res, e); }
});

// ── POST /:id/admin-close 行政闭环（I2 §3，仅 admin，未完成态记账式收口 → ARCHIVED + closure_type='admin_closure'）──
//   双层校验：endpoint 体验校验（10-500）+ correctionTransition 内对 admin_closure 最终强校验 + 同事务落库（M-8）。
//   expectedFromStatus=null：多源态（PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS），靠流转表 + closure_type 分支二次约束。
router.post('/:id/admin-close', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const cr = (req.body && typeof req.body.closure_reason === 'string') ? req.body.closure_reason.trim() : '';
        if (cr.length < 10 || cr.length > 500) return res.status(400).json({ error: '行政闭环原因须 10-500 字', code: 'CLOSURE_REASON_REQUIRED' });   // M-8 endpoint 体验校验
        const r = await correctionTransition(id, null, 'ARCHIVED', correctionActor(req), { closure_type: 'admin_closure', closure_reason: cr });
        return res.json({ ok: true, id, status: r.toStatus, closure_type: 'admin_closure' });
    } catch (e) { return sendCorrectionTransitionError(res, e); }
});

// ── POST /:id/void 作废（→VOIDED，§4.8 / G-14，软删通用旁路 + 双条件 WHERE 守卫；void_reason 建议填不强制）──
router.post('/:id/void', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const r = await correctionTransition(id, null, 'VOIDED', correctionActor(req), { void_reason: req.body && req.body.void_reason });
        return res.json({ ok: true, id, status: r.toStatus });
    } catch (e) { return sendCorrectionTransitionError(res, e); }
});

// ── POST /:id/notify-done 完成通知（§4.5 / G-11，建单人手动发，旁路不改状态）─── Commit D2b ───────────
//   三分支：有手机号有附件→发最新 fix_proof + 文字 / 无附件（batch 只填文字无 fix_proof）→发"已完成请自主查看"文字 /
//   无手机号→不发钉钉 + completion_notify_status='no_phone'。镜像 collab notify-requester-done（取附件→反查→
//   三步发送→dingtalkSendOk 双判→全成落库→三态返回），加"附件可选"分支。
//   权限（G-11）：建单人(created_by)/admin（被指派开发无发送权）。触发态 FIXED/REFIXED。可重复发（以最近一次为准 §4.5 L-2）。
router.post('/:id/notify-done', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const isAdmin = req.user.role === 'admin';
    try {
        // ── L2b 多业务方（§6.3）：先解析锚点，子单 → 409 引导主单 ──
        const anchor = await resolveCorrectionGroupAnchor(id);
        if (!anchor) return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' });
        if (anchor.is_master === false) return res.status(409).json({ error: '完成通知只能在主单发送', code: 'NOTIFY_DONE_ON_MASTER_ONLY', master_id: anchor.master_id });
        // 主单行（状态/建单人/卡片字段）；完成通知真相源在子表 anchor.requesters
        const c = await dbGetAsync(`SELECT id, status, created_by, source_system, location_info FROM correction_requests WHERE id = ?`, [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' });
        // 权限（G-11）：建单人或 admin（开发无发送权——信息技术部建单人对业务方交付负责）
        if (!isAdmin && Number(c.created_by) !== userId) {
            return res.status(403).json({ error: '仅建单人或管理员可发送完成通知', code: 'NOT_AUTHORIZED_TO_NOTIFY' });
        }
        // 端点可发态（RC-L1）：主单当前仅 FIXED/REFIXED（归档后不补发）
        if (c.status !== 'FIXED' && c.status !== 'REFIXED') {
            return res.status(409).json({ error: `仅已完成（FIXED/REFIXED）的修正单可发完成通知，当前：${c.status}`, code: 'INVALID_STATE_FOR_NOTIFY' });
        }
        // requester_id 解析（§6.3 RC3-M2）：必填；兼容旧前端=仅一条 requester 且未传时自动取主业务方
        let requesterId = (req.body && req.body.requester_id != null) ? parsePositiveCorrectionId(req.body.requester_id) : null;
        if (req.body && req.body.requester_id != null && !requesterId) return res.status(400).json({ error: '业务方 ID 非法', code: 'INVALID_REQUESTER_ID' });
        // codex 50 L-5：主单无子表行（历史/异常数据）单独报，避免误导为"没传 requester_id"（L1 已保证新数据有子表行）
        if (anchor.requesters.length === 0) return res.status(409).json({ error: '主单无业务方记录（历史/异常数据，需修复后再通知）', code: 'REQUESTER_ROWS_MISSING' });
        if (!requesterId) {
            if (anchor.requesters.length === 1) requesterId = Number(anchor.requesters[0].id);
            else return res.status(400).json({ error: '请指定业务方（requester_id）', code: 'REQUESTER_ID_REQUIRED' });
        }
        // 归属校验（RC2-M3 堵串单/越权）：requester_id 必须属于本主单子表
        const target = anchor.requesters.find(r => Number(r.id) === Number(requesterId));
        if (!target) return res.status(404).json({ error: '业务方不存在或不属于本单', code: 'REQUESTER_NOT_IN_GROUP' });
        // 组闸门（§6.3）：有组 → 组内全部成员完成才放行（无组退化为单成员，等价现状）
        if (anchor.group_members.length > 1 && !anchor.group_members.every(m => isGroupMemberDoneForBusinessNotify(m))) {
            return res.status(409).json({ error: '关联组内还有系统未完成，暂不能通知业务方', code: 'GROUP_NOT_ALL_DONE' });
        }
        // 落库 helper（仅用于 no_phone/failed 非 sent 终态）：更新该业务方子表行 completion_notify_*；
        //   主业务方(is_primary=1) 同步回写主表兼容列（RC2-M2，best-effort 不阻断）。
        //   **一并清 completion_read_at**（codex 50 M-2）：这些态都把 message_key 置 NULL，旧 read_at 成孤儿
        //   （指向已失效消息），failed/no_phone 行带 read_at 自相矛盾，列表/人工排查会误判已读 → 一律清。
        const persistNotify = async (status, messageKey, errorVal) => {
            await dbRunAsync(`UPDATE correction_requesters SET completion_notify_status=?, completion_notified_at=datetime('now','localtime'), completion_notify_message_key=?, completion_notify_error=?, completion_read_at=NULL WHERE id=?`, [status, messageKey, errorVal, target.id]);
            if (Number(target.is_primary) === 1) {
                try { await dbRunAsync(`UPDATE correction_requests SET completion_notify_status=?, completion_notified_at=datetime('now','localtime'), completion_notify_message_key=?, completion_notify_error=?, completion_read_at=NULL WHERE id=?`, [status, messageKey, errorVal, id]); }
                catch (e) { logger.warn(`[correction-notify-done] #${id} 主表兼容列回写失败（子表已更新，真相源正确）：${e.message}`); }
            }
        };
        // RC-M3 统一重发契约：未传 force_resend 且该业务方已 sent 且有 message_key → already_sent
        if (!(req.body && req.body.force_resend === true) && target.completion_notify_status === 'sent' && target.completion_notify_message_key) {
            return res.json({ success: true, already_sent: true, status: 'sent', requester_id: requesterId, message: '已通知过该业务方完成，未重复发送（如需重发传 force_resend）' });
        }
        // ① 无手机号分支（G-11）：不调钉钉，落 no_phone，前端提示线下交付
        const requesterPhone = String(target.requester_phone || '').trim();
        if (!requesterPhone) {
            await persistNotify('no_phone', null, 'no_phone');
            return res.status(400).json({ success: false, code: 'REQUESTER_PHONE_EMPTY', message: '该业务方未填写手机号，请用其他方式交付', status: 'no_phone', requester_id: requesterId });
        }
        // 取最新 fix_proof（在主单上）。最新=最终结果证明（append 历史保留，发最近一张）。
        const att = await dbGetAsync(
            `SELECT id, file_name, original_name FROM correction_attachments
              WHERE correction_request_id = ? AND attachment_type = 'fix_proof' ORDER BY id DESC LIMIT 1`, [id]);
        let physicalPath = null, sendFileName = null;
        if (att) {
            const ext = normalizeAttachmentExt(att.original_name || att.file_name || '');
            if (!CORRECTION_ALLOWED_EXTS.includes(ext)) {
                return res.status(409).json({ error: `结果证明扩展名 ${ext} 非法，无法作为文件发送`, code: 'FIX_PROOF_NOT_SENDABLE' });
            }
            physicalPath = path.join(UPLOAD_DIR, att.file_name);
            const rootCheck = collabVersioning._internal.ensureInsideRoot(physicalPath, UPLOAD_DIR);
            if (!rootCheck.ok) return res.status(400).json({ error: '附件路径校验失败', code: 'PATH_VIOLATION' });
            if (!fs.existsSync(physicalPath)) return res.status(409).json({ error: '结果证明文件物理缺失', code: 'FIX_PROOF_FILE_MISSING' });
            sendFileName = att.original_name || path.basename(att.file_name);
        }
        // 取凭证 + token（config→500/token→502 均不落库；真正"发起后失败"才落 failed）
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
        if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写', code: 'DINGTALK_NOT_CONFIGURED' });
        let token;
        try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ success: false, error: cls.hint, code: 'DINGTALK_TOKEN_FAILED', reason: cls.reason }); }
        // 反查该业务方钉钉号（HTTP 分层：查不到=400 / 服务异常=502）
        const resolved = await dingtalkNotify.resolveRequesterDingUserId(token, requesterPhone);
        if (!resolved.ok) {
            await persistNotify('failed', null, resolved.reason || 'lookup_failed');
            if (resolved.reason === 'requester_invalid') return res.status(400).json({ success: false, code: 'REQUESTER_INVALID', message: '业务方手机号查不到企业钉钉号（非企业成员/未绑定/离职），请线下转达', status: 'failed', requester_id: requesterId });
            return res.status(502).json({ success: false, code: 'REQUESTER_LOOKUP_FAILED', message: '业务方钉钉号查询失败，请稍后重试', status: 'failed', reason: resolved.reason, requester_id: requesterId });
        }
        const userIds = [resolved.userid];
        const sendOk = (r) => r && typeof r === 'object' && (!r.errcode || r.errcode === 0) && (!Array.isArray(r.invalidStaffIdList) || r.invalidStaffIdList.length === 0);
        const esc = dingtalkNotify.escapeMarkdown;
        const cardText = [
            '您反馈的**数据修正需求已完成**：', '',
            `- 所属系统：${esc(c.source_system)}`,
            `- 修正方式：${esc(c.location_info)}`,
            att ? '- 结果证明见随附文件。' : '- 已完成，请自主查看。'
        ].join('\n');
        const steps = { media_upload: !att, file_send: !att, markdown_send: false };
        let mdResp = null, failedStep = null;
        try {
            if (att) {
                const buffer = fs.readFileSync(physicalPath);
                const mediaId = await dingtalkNotify.uploadMedia(token, sendFileName, buffer);
                if (!mediaId) throw Object.assign(new Error('media 上传未返回 mediaId'), { step: 'media_upload' });
                steps.media_upload = true;
                const fileResp = await dingtalkNotify.sendFileToUser(token, robotCode, userIds, mediaId, sendFileName);
                if (!sendOk(fileResp)) throw Object.assign(new Error('文件发送未成功'), { step: 'file_send' });
                steps.file_send = true;
            }
            mdResp = await dingtalkNotify.sendMarkdownToUser(token, robotCode, userIds, '📋 数据修正·已完成', cardText);
            if (!sendOk(mdResp) || !mdResp.processQueryKey) throw Object.assign(new Error('markdown 未成功或缺 processQueryKey'), { step: 'markdown_send' });
            steps.markdown_send = true;
        } catch (e) {
            failedStep = e.step || (!steps.media_upload ? 'media_upload' : !steps.file_send ? 'file_send' : 'markdown_send');
        }
        const allOk = steps.media_upload && steps.file_send && steps.markdown_send;
        if (allOk) {
            // 子表是真相源——子表落库失败才报 NOTIFY_SENT_BUT_DB_UPDATE_FAILED；主表回写在 persistNotify 内 best-effort
            try {
                await dbRunAsync(`UPDATE correction_requesters SET completion_notify_status='sent', completion_notified_at=datetime('now','localtime'), completion_notify_message_key=?, completion_notify_error=NULL, completion_read_at=NULL WHERE id=?`, [mdResp.processQueryKey, target.id]);
            } catch (dbErr) {
                // codex 50 M-1：这是**继承自原主表 notify-done 的已接受边界**（非 L2b 新增）——钉钉已发但落库失败时，
                //   子表未更新 → 后续 already_sent 不命中，重试会重复发送；"请勿重发"是软提示、系统不强阻。
                //   恢复路径：日志已含 requester_id + processQueryKey（key=），运维可据此手工补写该子表行 completion_*。
                //   极罕见竞态（生产 2 单），不引独立审计表 / 不暴露 key 给前端（内部钉钉标识无业务价值 + 扩攻击面）。
                logger.error(`[correction-notify-done] #${id} 业务方#${requesterId} 钉钉已发但子表落库失败：${dbErr.message}（key=${mdResp.processQueryKey}）`);
                return res.status(200).json({ success: false, code: 'NOTIFY_SENT_BUT_DB_UPDATE_FAILED', message: '通知已发送但状态保存失败，请勿重发', delivery_status: 'sent', persist_status: 'failed', requester_id: requesterId });
            }
            if (Number(target.is_primary) === 1) {
                try { await dbRunAsync(`UPDATE correction_requests SET completion_notify_status='sent', completion_notified_at=datetime('now','localtime'), completion_notify_message_key=?, completion_notify_error=NULL, completion_read_at=NULL WHERE id=?`, [mdResp.processQueryKey, id]); }
                catch (e) { logger.warn(`[correction-notify-done] #${id} 主表兼容列回写失败（子表已更新，真相源正确）：${e.message}`); }
            }
            logger.info(`[correction-notify-done] #${id} 完成通知已发业务方#${requesterId}(${resolved.userid}) by ${userName}（${att ? '含附件' : '无附件'}）`);
            return res.json({ success: true, status: 'sent', requester_id: requesterId, has_attachment: !!att });
        }
        await persistNotify('failed', null, failedStep || 'failed');
        logger.warn(`[correction-notify-done] #${id} 业务方#${requesterId} 完成通知部分失败 failed_step=${failedStep} by ${userName}`);
        return res.status(200).json({ success: false, code: 'NOTIFY_PARTIAL_FAILURE', failed_step: failedStep, message: '通知发送未完成，请重试或线下联系业务方', status: 'failed', requester_id: requesterId });
    } catch (e) {
        logger.error(`[correction-notify-done] 修正单 #${id} 异常：${e.message}`, e);
        return res.status(500).json({ success: false, error: '发送完成通知失败', code: 'NOTIFY_DONE_FAILED' });
    }
});

// ============================================================
// 数据修正模块 API（v1.81.0 Commit I1：通知手动化 + 已读查询）
//   拆掉 D2a 自动发后，建单/指派/回复预计只更新状态；钉钉通知改这 3 个详情页手动端点 + notify-done（已有）触发。
//   统一重发契约（§2.6 RC-M3）：未传 force_resend 且 status='sent' 且 message_key 非空 → ALREADY_SENT；
//     重发成功落新 message_key + notified_at + status='sent' + error=NULL + 清对应 read_at（以最近一次为准）。
//   可发状态枚举（§2.2，基于真实 8 态机；统一禁发态 VOIDED/REJECTED/ARCHIVED 由 sendable 不含自动拦）。
// ============================================================
const CORRECTION_NOTIFY_SENDABLE = {
    dev:      ['ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS'],   // 指派后到修完前
    relay:    ['PENDING_ASSIGN'],                              // 对接人协助指派阶段
    estimate: ['IN_PROGRESS'],                                // 已回复预计（进 IN_PROGRESS≡dev_estimated_at 非空）
    done:     ['FIXED', 'REFIXED'],                            // 已修完待确认
    creator:  ['FIXED', 'REFIXED'],                            // 本次细优②：开发/对接人告知建单人工作完成（仅完成态）
};

// POST /:id/notify-developer（通知开发，细优④A 权限放开：admin/publisher/白名单对接人，可发 ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS）
//   ④A（codex 36 H-2）：修"对接人能 assign 却不能通知开发"断层，requireRelayOrPublisherOrAdmin 与 assign 同权限域（有意决策：白名单对接人[7,13]全局可操作）。
//   R-M2（codex 37）：UI 可见性 ≠ API 权限——前端 M-2 后 publisher/对接人通知区只看 creator 行，此端点后端权限保留作管理兜底/兼容。
router.post('/:id/notify-developer', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, requireRelayOrPublisherOrAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const c = await dbGetAsync('SELECT id, status, assigned_to, notify_status, notify_message_key FROM correction_requests WHERE id = ?', [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在' });
        if (!CORRECTION_NOTIFY_SENDABLE.dev.includes(c.status)) return res.status(409).json({ error: `当前状态「${c.status}」不可通知开发`, code: 'STATUS_NOT_NOTIFIABLE' });
        if (!c.assigned_to) return res.status(400).json({ error: '尚未指派开发，无法通知', code: 'NOT_ASSIGNED' });
        // 重发契约（RC-M3）：已 sent 且有 key、未传 force_resend → ALREADY_SENT（防双击重复打扰）
        if (!(req.body && req.body.force_resend === true) && c.notify_status === 'sent' && c.notify_message_key) {
            return res.json({ success: true, already_sent: true, status: 'sent', message: '已通知过开发，未重复发送（如需重发传 force_resend）' });
        }
        const r = await notifyCorrectionAssignedDev(id, c.assigned_to);   // 内部发送 + 落 notify_*（含 read_at 重发清理 codex 31 M-1，sent/failed，失败必落库）
        if (r.ok) return res.json({ success: true, status: 'sent', message_key: r.message_key });
        return res.status(502).json({ success: false, status: 'failed', reason: r.reason });
    } catch (e) {
        logger.error(`[correction-notify-developer] #${id} 异常：${e.message}`);
        return res.status(500).json({ error: '通知开发失败' });
    }
});

// POST /:id/notify-relay（通知对接人协助指派，权限 admin，可发 PENDING_ASSIGN 且有 relay_user）
router.post('/:id/notify-relay', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const c = await dbGetAsync('SELECT id, status, source_system, location_info, relay_notified_user_id, relay_notify_status, relay_notify_message_key FROM correction_requests WHERE id = ?', [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在' });
        if (!CORRECTION_NOTIFY_SENDABLE.relay.includes(c.status)) return res.status(409).json({ error: `当前状态「${c.status}」不可通知对接人`, code: 'STATUS_NOT_NOTIFIABLE' });
        if (!c.relay_notified_user_id) return res.status(400).json({ error: '本单未指定对接人，无法通知', code: 'NO_RELAY_USER' });
        if (!(req.body && req.body.force_resend === true) && c.relay_notify_status === 'sent' && c.relay_notify_message_key) {
            return res.json({ success: true, already_sent: true, status: 'sent', message: '已通知过对接人，未重复发送（如需重发传 force_resend）' });
        }
        // 发送（对接人=平台用户 admin/publisher，走 sendIssueDingtalkRaw）+ 落 relay 四件套（失败必落库，对齐 issue H-4）
        let relayU = null;
        try { relayU = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [c.relay_notified_user_id]); } catch (_) {}
        let r;
        if (!relayU) {
            r = { ok: false, reason: 'not_found' };
        } else {
            const esc = dingtalkNotify.escapeMarkdown;
            const detailUrl = await buildCorrectionDetailUrl(id);   // 细优③：通知对接人带登录地址
            const md = [
                '请协助为以下**数据修正需求**指定开发人员：', '',
                `- 所属系统：${esc(c.source_system)}`,
                `- 修正方式：${esc(c.location_info)}`, '',
                '请登平台在该单上指派开发。'
            ].join('\n') + `\n\n[查看修正单详情](${detailUrl})`;
            try { r = await sendIssueDingtalkRaw(relayU, '📋 数据修正·请协助指派', md); }
            catch (e) { r = { ok: false, reason: 'exception' }; logger.warn(`[correction-notify-relay] #${id} 发送异常：${e.message}`); }
        }
        const status = r.ok ? 'sent' : 'failed';
        try {
            await dbRunAsync(
                `UPDATE correction_requests SET relay_notify_status=?, relay_notified_at=datetime('now','localtime'), relay_notify_message_key=?, relay_notify_error=?, relay_read_at=CASE WHEN ?='sent' THEN NULL ELSE relay_read_at END WHERE id=?`,
                [status, r.ok ? r.message_key : null, r.ok ? null : (r.reason || 'other'), status, id]);
        } catch (dbErr) { logger.error(`[correction-notify-relay] #${id} 落库失败：${dbErr.message}`); }
        if (r.ok) return res.json({ success: true, status: 'sent', message_key: r.message_key });
        return res.status(502).json({ success: false, status: 'failed', reason: r.reason });
    } catch (e) {
        logger.error(`[correction-notify-relay] #${id} 异常：${e.message}`);
        return res.status(500).json({ error: '通知对接人失败' });
    }
});

// POST /:id/notify-creator（细优②：开发/对接人告知建单人「工作已完成」，可发 FIXED/REFIXED）
//   权限 handler 细判（开发可能任意 user 角色，中间件层拦不住）：本单开发 isAssignee / 白名单对接人 isRelay / admin。
//   收件人 created_by（平台用户，admin 建单）走 sendIssueDingtalkRaw；兜底对齐 dev/relay（查不到/发送失败统一落 failed，error 记 reason，前端 failed 分支统一展示，MS-M1）；失败必落库（issue H-4 / H-3·R-M4 codex 36-37/41）。
router.post('/:id/notify-creator', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const c = await dbGetAsync('SELECT id, status, created_by, assigned_to, source_system, location_info, creator_notify_status, creator_notify_message_key FROM correction_requests WHERE id = ?', [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在' });
        const actor = correctionActor(req);
        const isAdmin = actor.role === 'admin';
        const isAssignee = Number(c.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
        const isRelay = isCorrectionRelayWhitelisted(actor.id);
        if (!isAdmin && !isAssignee && !isRelay) return res.status(403).json({ error: '无权通知创建人（仅本单开发/对接人/admin）', code: 'NOT_AUTHORIZED_TO_NOTIFY' });
        if (!CORRECTION_NOTIFY_SENDABLE.creator.includes(c.status)) return res.status(409).json({ error: `当前状态「${c.status}」不可通知创建人`, code: 'STATUS_NOT_NOTIFIABLE' });
        // R-M4（codex 37）：created_by 防脏数据——非有效正整数按 not_found 落库（schema 虽 NOT NULL，仍防御历史脏数据）
        const creatorId = Number(c.created_by);
        if (!Number.isInteger(creatorId) || creatorId <= 0) {
            try { await dbRunAsync(`UPDATE correction_requests SET creator_notify_status='failed', creator_notified_at=datetime('now','localtime'), creator_notify_message_key=NULL, creator_notify_error='created_by 无效' WHERE id=?`, [id]); }
            catch (dbErr) { logger.error(`[correction-notify-creator] #${id} created_by 无效落库失败：${dbErr.message}`); }
            return res.status(400).json({ success: false, status: 'failed', code: 'CREATOR_INVALID' });   // MS-M1：落 failed 对齐 dev/relay，前端 failed 分支统一展示
        }
        // 重发契约（RC-M3）：已 sent 且有 key、未传 force_resend → ALREADY_SENT（NULL/not_sent 走发送，R-M1 NULL 安全）
        if (!(req.body && req.body.force_resend === true) && c.creator_notify_status === 'sent' && c.creator_notify_message_key) {
            return res.json({ success: true, already_sent: true, status: 'sent', message: '已通知过创建人，未重复发送（如需重发传 force_resend）' });
        }
        // 发送 + 落 creator 四件套（兜底对齐 dev：查不到 user→not_found / 发送失败→failed / 失败必落库）
        let creatorU = null;
        try { creatorU = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [creatorId]); } catch (_) {}
        let r;
        if (!creatorU) {
            r = { ok: false, reason: 'not_found' };
        } else {
            const esc = dingtalkNotify.escapeMarkdown;
            const detailUrl = await buildCorrectionDetailUrl(id);   // 细优③：带登录地址
            const md = [
                '您建的**数据修正单已完成**，请知悉：', '',
                `- 所属系统：${esc(c.source_system)}`,
                `- 修正方式：${esc(c.location_info)}`
            ].join('\n') + `\n\n[查看修正单详情](${detailUrl})`;
            try { r = await sendIssueDingtalkRaw(creatorU, '📋 数据修正·已完成', md); }
            catch (e) { r = { ok: false, reason: 'exception' }; logger.warn(`[correction-notify-creator] #${id} 发送异常：${e.message}`); }
        }
        const status = r.ok ? 'sent' : 'failed';   // MS-M1（codex 41）：对齐 dev/relay 范式——not_found/exception 统一落 failed（error 记 reason），前端 failed 分支统一展示
        try {
            await dbRunAsync(
                `UPDATE correction_requests SET creator_notify_status=?, creator_notified_at=datetime('now','localtime'), creator_notify_message_key=?, creator_notify_error=?, creator_read_at=CASE WHEN ?='sent' THEN NULL ELSE creator_read_at END WHERE id=?`,
                [status, r.ok ? r.message_key : null, r.ok ? null : (r.reason || 'other'), status, id]);
        } catch (dbErr) { logger.error(`[correction-notify-creator] #${id} 落库失败：${dbErr.message}`); }
        if (r.ok) return res.json({ success: true, status: 'sent', message_key: r.message_key });
        return res.status(502).json({ success: false, status, reason: r.reason });
    } catch (e) {
        logger.error(`[correction-notify-creator] #${id} 异常：${e.message}`);
        return res.status(500).json({ error: '通知创建人失败' });
    }
});

// POST /:id/notify-estimate（通知业务方·预计完成，权限 admin/assignee，可发 IN_PROGRESS 且 dev_estimated_at 非空）
router.post('/:id/notify-estimate', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const c = await dbGetAsync('SELECT id, status, assigned_to, requester_phone, source_system, location_info, dev_estimated_at, requester_notify_status, requester_notify_message_key FROM correction_requests WHERE id = ?', [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在' });
        const actor = correctionActor(req);
        // §6.5（L2）：notify-estimate 权限收紧仅 admin（去 isAssignee）——建单人/admin 把关业务方沟通，开发不再直发业务方绕过建单人。
        if (actor.role !== 'admin') return res.status(403).json({ error: '无权通知业务方预计完成（仅 admin）', code: 'NOT_AUTHORIZED_TO_NOTIFY' });
        if (!CORRECTION_NOTIFY_SENDABLE.estimate.includes(c.status)) return res.status(409).json({ error: `当前状态「${c.status}」不可通知预计完成`, code: 'STATUS_NOT_NOTIFIABLE' });
        if (!c.dev_estimated_at) return res.status(400).json({ error: '尚未回复预计完成时间', code: 'ESTIMATE_REQUIRED' });   // RC-L1 不变量二次校验
        if (!String(c.requester_phone || '').trim()) {
            // H-1（codex 26）：no_phone 也要落库（对齐 notify-done 范式），否则通知四态/审计黑洞——失败不可观测
            try { await dbRunAsync(`UPDATE correction_requests SET requester_notify_status='no_phone', requester_notified_at=datetime('now','localtime'), requester_notify_message_key=NULL, requester_notify_error='no_phone' WHERE id=?`, [id]); }
            catch (dbErr) { logger.error(`[correction-notify-estimate] #${id} no_phone 落库失败：${dbErr.message}`); }   // RC-M1（codex 27）：落库失败留痕，闭合可观测性
            return res.status(400).json({ success: false, error: '业务方未填手机号，无法通知', code: 'REQUESTER_PHONE_EMPTY', status: 'no_phone' });
        }
        if (!(req.body && req.body.force_resend === true) && c.requester_notify_status === 'sent' && c.requester_notify_message_key) {
            return res.json({ success: true, already_sent: true, status: 'sent', message: '已通知过业务方，未重复发送（如需重发传 force_resend）' });
        }
        const esc = dingtalkNotify.escapeMarkdown;
        const md = [
            '您反馈的**数据修正需求**，开发已回复预计完成时间：', '',
            `- 所属系统：${esc(c.source_system)}`,
            `- 修正方式：${esc(c.location_info)}`,
            `- 预计完成：${esc(String(c.dev_estimated_at || ''))}`
        ].join('\n');
        let sr;
        try { sr = await sendCorrectionDingtalkToRequester(c.requester_phone, '📋 数据修正·预计完成时间', md); }
        catch (e) { sr = { ok: false, reason: 'exception' }; logger.warn(`[correction-notify-estimate] #${id} 发送异常：${e.message}`); }
        const status = sr.ok ? 'sent' : (sr.reason === 'no_phone' ? 'no_phone' : 'failed');
        try {
            await dbRunAsync(
                `UPDATE correction_requests SET requester_notify_status=?, requester_notified_at=datetime('now','localtime'), requester_notify_message_key=?, requester_notify_error=?, requester_read_at=CASE WHEN ?='sent' THEN NULL ELSE requester_read_at END WHERE id=?`,
                [status, sr.ok ? sr.message_key : null, sr.ok ? null : (sr.reason || 'other'), status, id]);
        } catch (dbErr) { logger.error(`[correction-notify-estimate] #${id} 落库失败：${dbErr.message}`); }
        if (sr.ok) return res.json({ success: true, status: 'sent', message_key: sr.message_key });
        if (status === 'no_phone') return res.status(400).json({ success: false, status: 'no_phone', code: 'REQUESTER_PHONE_EMPTY' });
        return res.status(502).json({ success: false, status: 'failed', reason: sr.reason });
    } catch (e) {
        logger.error(`[correction-notify-estimate] #${id} 异常：${e.message}`);
        return res.status(500).json({ error: '通知业务方预计完成失败' });
    }
});

// 已读查询字段映射（§2.5，复用 issue ISSUE_READ_FIELD_MAP 范式）。dev/relay 走 users 表，estimate/done 走 phone 反查。
const CORRECTION_READ_FIELD_MAP = {
    dev:      { user_id_col: 'assigned_to',            notified_at: 'notified_at',           message_key: 'notify_message_key',           read_at: 'read_at',           status_col: 'notify_status',           label: '被指派开发', byPhone: false },
    relay:    { user_id_col: 'relay_notified_user_id', notified_at: 'relay_notified_at',      message_key: 'relay_notify_message_key',     read_at: 'relay_read_at',     status_col: 'relay_notify_status',     label: '对接人',     byPhone: false },
    estimate: { user_id_col: null,                     notified_at: 'requester_notified_at',  message_key: 'requester_notify_message_key', read_at: 'requester_read_at', status_col: 'requester_notify_status', label: '业务方·预计', byPhone: true },
    done:     { user_id_col: null,                     notified_at: 'completion_notified_at', message_key: 'completion_notify_message_key',read_at: 'completion_read_at',status_col: 'completion_notify_status',label: '业务方·完成', byPhone: true },
    creator:  { user_id_col: 'created_by',             notified_at: 'creator_notified_at',    message_key: 'creator_notify_message_key',   read_at: 'creator_read_at',   status_col: 'creator_notify_status',   label: '创建人',     byPhone: false },
};
// GET /:id/notify-read-status?recipient=dev|relay|estimate|done|creator（复用 issue notify-read-status 11732 范式；权限=与对应通知发送同权：dev→admin/publisher/对接人 · relay→admin · estimate→admin/assignee · done→admin/creator · creator→admin/assignee/对接人）
router.get('/:id/notify-read-status', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const recipient = req.query.recipient || 'dev';
        const fm = CORRECTION_READ_FIELD_MAP[recipient];
        if (!fm) return res.status(400).json({ error: '无效的 recipient', code: 'INVALID_RECIPIENT' });

        // ── L2b 多业务方完成通知已读（§6.4）：done 走业务方子表行（非主表），先锚点 + requester_id 归属校验 ──
        //   （独立分支，自包含早返回；不动下方 dev/relay/estimate/creator 统一路径——风险隔离）
        //   ⚠️ 本分支在上方 fm 校验【之后】，仍依赖 CORRECTION_READ_FIELD_MAP.done 作合法 recipient 白名单项
        //     （codex 50 L-4：勿因"done 已迁子表"误删 map.done，否则 done 请求会先被 INVALID_RECIPIENT 拦截）。
        if (recipient === 'done') {
            const anchor = await resolveCorrectionGroupAnchor(id);
            if (!anchor) return res.status(404).json({ error: '修正单不存在' });
            if (anchor.is_master === false) return res.status(409).json({ error: '完成通知已读查询只在主单', code: 'NOTIFY_DONE_ON_MASTER_ONLY', master_id: anchor.master_id });
            const mrow = await dbGetAsync('SELECT created_by FROM correction_requests WHERE id = ?', [id]);
            const actorD = correctionActor(req);
            const isCreatorD = mrow && Number(mrow.created_by) === Number(actorD.id) && Number(actorD.id) > 0;
            if (actorD.role !== 'admin' && !isCreatorD) return res.status(403).json({ error: '无权查询该通知已读状态', code: 'NOT_AUTHORIZED' });   // 与 notify-done 同权（admin/建单人）
            // requester_id 解析（RC3-M2 兼容旧前端：单业务方未传自动取主业务方）+ 归属校验（RC2-M3/RC3-M3）
            let rid = (req.query.requester_id != null) ? parsePositiveCorrectionId(req.query.requester_id) : null;
            if (req.query.requester_id != null && !rid) return res.status(400).json({ error: '业务方 ID 非法', code: 'INVALID_REQUESTER_ID', read: false });
            if (anchor.requesters.length === 0) return res.status(409).json({ error: '主单无业务方记录（历史/异常数据，需修复）', code: 'REQUESTER_ROWS_MISSING', read: false });   // codex 50 L-5
            if (!rid) {
                if (anchor.requesters.length === 1) rid = Number(anchor.requesters[0].id);
                else return res.status(400).json({ error: '请指定业务方（requester_id）', code: 'REQUESTER_ID_REQUIRED', read: false });
            }
            const tgt = anchor.requesters.find(r => Number(r.id) === Number(rid));
            if (!tgt) return res.status(404).json({ error: '业务方不存在或不属于本单', code: 'REQUESTER_NOT_IN_GROUP', read: false });
            // 口径（RC3-M3）：从子表行读 status/message_key；仅 sent+message_key 才反查钉钉，否则返**当前行状态**（codex 50 L-3，前端区分 not_sent/failed/no_phone）
            if (tgt.completion_notify_status !== 'sent' || !tgt.completion_notify_message_key) {
                return res.status(400).json({ error: '该业务方尚未成功通知完成', code: 'REQUESTER_NOTIFY_NOT_SENT', read: false, requester_id: rid, status: tgt.completion_notify_status, notify_error: tgt.completion_notify_error || null });
            }
            if (tgt.completion_read_at) return res.json({ recipient, requester_id: rid, read: true, read_at: tgt.completion_read_at, cached: true });
            const tgtPhone = String(tgt.requester_phone || '').trim();
            if (!tgtPhone) return res.status(400).json({ error: '业务方手机号为空，无法查已读', code: 'REQUESTER_PHONE_EMPTY', read: false });
            const [aK, aS, rC] = await Promise.all(['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
            if (!aK || !aS || !rC) return res.status(500).json({ error: '钉钉配置未填写', code: 'DINGTALK_NOT_CONFIGURED' });
            let tk;
            try { tk = await dingtalkNotify.getAccessToken(aK, aS); }
            catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
            let uidD = '';
            try { const rr = await callDingtalkWithTokenRetry(aK, aS, tk, (t) => dingtalkNotify.resolveRequesterDingUserId(t, tgtPhone)); uidD = rr && rr.ok ? String(rr.userid).trim() : ''; }
            catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: '业务方钉钉号查询失败：' + cls.hint, reason: cls.reason }); }
            if (!uidD) return res.json({ recipient, requester_id: rid, read: false, read_at: null, read_status: 'recipient_unresolved' });
            let rr2;
            try { rr2 = await callDingtalkWithTokenRetry(aK, aS, tk, (t) => dingtalkNotify.getReadStatus(t, rC, tgt.completion_notify_message_key)); }
            catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
            const e2 = (rr2.readDetails || []).find(d => String(d.userId).trim() === uidD && d.readStatus === 'READ');
            let readAtD = null;
            if (e2) {
                const ts = Number(e2.readTimestamp) || 0;
                const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : Date.now());
                const rd = new Date(ms); const p2 = (n) => String(n).padStart(2, '0');
                readAtD = `${rd.getFullYear()}-${p2(rd.getMonth() + 1)}-${p2(rd.getDate())} ${p2(rd.getHours())}:${p2(rd.getMinutes())}:${p2(rd.getSeconds())}`;
                try { await dbRunAsync(`UPDATE correction_requesters SET completion_read_at = ? WHERE id = ?`, [readAtD, tgt.id]); } catch (_) {}   // 首查到 READ 固化子表
                if (Number(tgt.is_primary) === 1) { try { await dbRunAsync(`UPDATE correction_requests SET completion_read_at = ? WHERE id = ?`, [readAtD, id]); } catch (_) {} }   // 主业务方回写主表兼容列
            }
            return res.json({ recipient, requester_id: rid, read: !!e2, read_at: readAtD });
        }

        // 字段名是写死的列名常量（非用户输入），插值进 SELECT 无注入风险
        const c = await dbGetAsync(
            `SELECT id, status, assigned_to, created_by, requester_phone, ${fm.user_id_col || 'NULL'} AS recipient_user_id,
                    ${fm.notified_at} AS notified_at, ${fm.message_key} AS message_key, ${fm.read_at} AS read_at, ${fm.status_col} AS notify_status
               FROM correction_requests WHERE id = ?`, [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在' });
        // 权限 = 与对应通知发送同权限（RC-M4）：dev→admin/publisher / relay→admin / estimate→admin/assignee / done→admin/creator
        const actor = correctionActor(req);
        const isAdmin = actor.role === 'admin', isPublisher = actor.role === 'publisher';
        const isAssignee = Number(c.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
        const isCreator = Number(c.created_by) === Number(actor.id) && Number(actor.id) > 0;
        let canQuery;
        if (recipient === 'dev') canQuery = isAdmin || isPublisher || isCorrectionRelayWhitelisted(actor.id);   // 细优④A（K2-M1）：notify-developer 放开对接人 → dev read-status 同步放开（写读同源）
        else if (recipient === 'relay') canQuery = isAdmin;
        else if (recipient === 'estimate') canQuery = isAdmin;   // §6.5 写读同源：notify-estimate 收紧仅 admin → estimate 已读查询同步收紧（去 isAssignee）
        else if (recipient === 'creator') canQuery = isAdmin || isAssignee || isCorrectionRelayWhitelisted(actor.id);   // 细优②：创建人通知发送方=开发/对接人/admin
        else canQuery = isAdmin || isCreator;   // done
        if (!canQuery) return res.status(403).json({ error: '无权查询该通知已读状态', code: 'NOT_AUTHORIZED' });
        if (!c.notified_at || c.notify_status !== 'sent') return res.status(400).json({ error: `尚未成功通知${fm.label}`, code: 'NOT_NOTIFIED', read: false });
        if (c.read_at) return res.json({ recipient, read: true, read_at: c.read_at, cached: true });   // 已固化直接返
        if (!c.message_key) return res.status(400).json({ error: '缺少消息标识', code: 'NO_MESSAGE_KEY', read: false });
        const [appKey, appSecret, robotCode] = await Promise.all(['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
        if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写', code: 'DINGTALK_NOT_CONFIGURED' });
        let token;
        try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
        // 解析收件人钉钉 user_id：dev/relay 走 users 表；estimate/done 走 requester_phone 反查
        let recipientDingUid = '';
        if (fm.byPhone) {
            if (!String(c.requester_phone || '').trim()) return res.status(400).json({ error: '业务方手机号为空，无法查已读', code: 'REQUESTER_PHONE_EMPTY', read: false });
            try { const rr = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.resolveRequesterDingUserId(t, c.requester_phone)); recipientDingUid = rr && rr.ok ? String(rr.userid).trim() : ''; }
            catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: '业务方钉钉号查询失败：' + cls.hint, reason: cls.reason }); }
        } else {
            const u = await dbGetAsync('SELECT dingtalk_user_id FROM users WHERE id = ?', [c.recipient_user_id]);
            recipientDingUid = u && u.dingtalk_user_id ? String(u.dingtalk_user_id).trim() : '';
        }
        if (!recipientDingUid) return res.json({ recipient, read: false, read_at: null, read_status: 'recipient_unresolved' });
        let readResult;
        try { readResult = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getReadStatus(t, robotCode, c.message_key)); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
        const myEntry = (readResult.readDetails || []).find(d => String(d.userId).trim() === recipientDingUid && d.readStatus === 'READ');
        const isRead = !!myEntry;
        let readAt = null;
        if (isRead) {
            // M-2（codex 26）：read_at 写库用稳定 'YYYY-MM-DD HH:mm:ss'（对齐 datetime('now','localtime')，避免 toLocaleString 斜杠/时区格式分裂 → 前端 formatFullTime 可解析）
            // RC-L2（codex 27）：钉钉一般返回 readTimestamp；缺有效时间戳时退 Date.now() 作"首次查到已读"近似时刻（钉钉无取消已读语义，固化近似值优于永远查不到已读态）
            const ts = Number(myEntry.readTimestamp) || 0;
            const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : Date.now());
            const rd = new Date(ms); const p2 = (n) => String(n).padStart(2, '0');
            readAt = `${rd.getFullYear()}-${p2(rd.getMonth() + 1)}-${p2(rd.getDate())} ${p2(rd.getHours())}:${p2(rd.getMinutes())}:${p2(rd.getSeconds())}`;
            try { await dbRunAsync(`UPDATE correction_requests SET ${fm.read_at} = ? WHERE id = ?`, [readAt, id]); } catch (_) {}   // 首查到 READ 固化
        }
        res.json({ recipient, read: isRead, read_at: readAt });
    } catch (e) {
        logger.error(`[correction-read-status] #${id} 异常：${e.message}`);
        return res.status(500).json({ error: '查询已读状态失败' });
    }
});

// ============================================================
// 数据修正模块 API（v1.81.0 Commit E：升级讨论拉群 create-chat）
//   方案 §4.9（旁路动作不走状态机 G-6）；节奏 Commit E。范式来源 = collab create-chat (server.js:13429)
//   = 一次成型 chat/create + 双 WHERE 守卫 + CRITICAL 落库失败处理 + requester_phone 反查降级。
//   correction 增量：
//     ① 额外勾选 extra_member_ids[]（M-3/M-4：不按 role 过滤；①存在②未禁用③不在排除名单 直接剔除，④无钉钉号跳过+warning）
//     ② CORRECTION_CHAT_EXCLUDE_IDS=[11] 排示例只读领导A（G-5/§5.4；不复用 READONLY_LEADER_IDS=[6,11]）
//     ③ 固定底座成员入口 addCorrectionChatMember **不排 id=1**（M-2：correction 的 id=1 是真实 admin，非占位）
//     ④ 固定底座缺钉钉号 → missing_required_member_ids strong warning，不阻断建群（M-5：有群比没群强）
//     ⑤ 校验顺序：先可见性鉴权 → 拉群权限 → 幂等 → 状态门槛（M-6，幂等/门槛前必先鉴权防泄露历史群）
//     ⑥ 群字段旁路 UPDATE，不走 correctionTransition、不动 status、不写 correction_status_history（G-6/L-2）
// ============================================================

// G-5 / §5.4：拉群可选成员排除名单——独立常量，只排示例只读领导A 11（示例只读领导B 6 可进群，口径区别于 READONLY_LEADER_IDS）
const CORRECTION_CHAT_EXCLUDE_IDS = [11];   // 示例只读领导A
function isCorrectionChatExcludedId(id) { return CORRECTION_CHAT_EXCLUDE_IDS.includes(Number(id)); }
// M-2：correction 专用成员入口——只排无效/占位 id（≤0、NaN、非安全整数），**不排 id=1**
//   （区别于 collab 的 addRealChatMember 硬排 BUILTIN_ADMIN_USER_ID=1；correction id=1 是真实管理员账号应正常入群）
function addCorrectionChatMember(memberSet, rawId) {
    const uid = Number(rawId);
    if (Number.isSafeInteger(uid) && uid > 0) memberSet.add(uid);
}
// 拉群状态门槛（仅未建群时校验，M-1）：仅已指派后非终态可新建群
//   PENDING_ASSIGN（未指派）/ ARCHIVED·REJECTED·VOIDED（终态）拒绝新建（VOIDED 同时被下方 voided_at 守卫拦）。
const CORRECTION_CHAT_ALLOWED_STATUSES = ['ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'FIXED', 'REFIXED'];

// ── POST /:id/create-chat 升级讨论拉群（§4.9 / G-2~G-6，含 codex 03 M-2/M-3 + 04 M-1/M-5/M-6 + L-2）──
//   权限层 = authenticateToken + schema ready + id guard；细粒度可见性/拉群权限在 handler 内（assignee 是 user 角色，
//   不能用 requireAdmin/requirePublisherOrAdmin 中间件，对齐 reply-estimate/complete 内联校验）。
router.post('/:id/create-chat', authenticateToken, requireCorrectionSchemaReady, correctionIdGuard, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const role = req.user.role;
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }
    try {
        const c = await dbGetAsync(
            `SELECT id, status, created_by, assigned_to, requester_name, requester_phone, location_info,
                    voided_at, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name
               FROM correction_requests WHERE id = ?`, [id]);
        if (!c) return res.status(404).json({ error: '修正单不存在', code: 'CORRECTION_NOT_FOUND' });

        // ── ① 校验顺序 M-6 第一步：可见性鉴权 + 拉群权限（均 403，均在幂等/门槛之前，防把历史群信息泄露给无关用户）──
        const isAdmin = role === 'admin';
        const isPublisher = role === 'publisher';
        const isCreator = Number(c.created_by) === userId && userId > 0;
        const isAssignee = Number(c.assigned_to) === userId && userId > 0;
        if (!isAdmin && !isPublisher && !isCreator && !isAssignee) {
            return res.status(403).json({ error: '无权查看此修正单', code: 'NOT_AUTHORIZED_TO_VIEW' });
        }
        // 拉群发起权（G-3）：admin 或被指派开发本人（publisher 仅可见不可拉；correction created_by 必为 admin，故等价 admin||assignee）
        if (!isAdmin && !isAssignee) {
            return res.status(403).json({ error: '仅管理员或被指派开发本人可发起拉群讨论', code: 'NOT_ALLOWED_TO_CREATE_CHAT' });
        }

        // ── ② 幂等（M-1）：已建群直接返回现有群信息，不再校验状态门槛（收口态仍能取历史群入口）──
        if (c.dingtalk_open_conversation_id) {
            return res.json({
                message: '修正单已有讨论群（请到钉钉客户端查看）',
                id, chat_id: c.dingtalk_chat_id, open_conversation_id: c.dingtalk_open_conversation_id,
                chat_name: c.dingtalk_chat_name, idempotent: true
            });
        }

        // ── ③ 状态门槛（仅未建群才校验）：仅已指派后非终态可新建群──
        if (!CORRECTION_CHAT_ALLOWED_STATUSES.includes(c.status)) {
            return res.status(409).json({
                error: `当前状态（${c.status}）不可发起拉群：未指派或已为终态（拒绝/归档/作废）`,
                code: 'CHAT_NOT_ALLOWED_IN_STATUS'
            });
        }

        // L-1（codex 16）：额外成员数量上限——原始入参先卡（失败快返不浪费钉钉 token）。生产 ~19 用户，50 足够且与前端多选列表一致。
        if (Array.isArray(req.body && req.body.extra_member_ids) && req.body.extra_member_ids.length > 50) {
            return res.status(400).json({ error: '额外成员数量超出上限（最多 50 人）', code: 'TOO_MANY_EXTRA_MEMBERS' });
        }

        // 取钉钉凭证（前置不可尝试 → 直接返错，不建群；对齐 collab/notify-done config→500/token→502）
        const [appKey, appSecret, robotCode] = await Promise.all(
            ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
        if (!appKey || !appSecret || !robotCode) {
            return res.status(500).json({ error: '钉钉配置未填写，请管理员先到系统配置 → 钉钉配置填写凭证', code: 'NO_DINGTALK_CONFIG' });
        }
        let token;
        try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'GETTOKEN_FAILED' }); }

        // ── 成员构成（§4.9.3）──────────────────────────────────────────────
        // 固定底座（M-2 不排 id=1）：群主示例用户A + 建单人 + 指派开发 + 发起人
        const baseIdSet = new Set();
        addCorrectionChatMember(baseIdSet, COLLAB_CHAT_ADMIN_ID);
        addCorrectionChatMember(baseIdSet, c.created_by);
        addCorrectionChatMember(baseIdSet, c.assigned_to);
        addCorrectionChatMember(baseIdSet, userId);
        // 固定底座过排除名单（M-5）：命中示例只读领导A 11 → 移出 + warning（纵深防御兜底脏数据，不阻断；示例用户A/发起人本不会是示例只读领导A）
        const baseExcludedIds = [];
        for (const bid of [...baseIdSet]) { if (isCorrectionChatExcludedId(bid)) { baseIdSet.delete(bid); baseExcludedIds.push(bid); } }

        // 额外勾选成员（M-4 不按 role 过滤；M-3 校验 ①存在②未禁用③不在排除名单 直接剔除，④无钉钉号跳过+warning）
        const rawExtra = Array.isArray(req.body && req.body.extra_member_ids) ? req.body.extra_member_ids : [];
        const extraIdSet = new Set();
        for (const r of rawExtra) { const n = Number(r); if (Number.isSafeInteger(n) && n > 0) extraIdSet.add(n); }
        for (const bid of baseIdSet) extraIdSet.delete(bid);          // 去重：已在固定底座的额外 id 不重复处理
        for (const bid of baseExcludedIds) extraIdSet.delete(bid);    // 已被底座排除的也不再作额外处理
        const extraExcludedIds = [];
        for (const eid of [...extraIdSet]) { if (isCorrectionChatExcludedId(eid)) { extraIdSet.delete(eid); extraExcludedIds.push(eid); } }   // ③ 直接剔除（前端列表已滤示例只读领导A，此为后端兜底）

        // 一次性查所有引用到的 user（底座 + 额外 + 被排除的，便于 warning 带 display_name）
        const allRefIds = [...new Set([...baseIdSet, ...extraIdSet, ...baseExcludedIds, ...extraExcludedIds])];
        const userRows = allRefIds.length
            ? await dbAllAsync(`SELECT id, display_name, phone, dingtalk_user_id, status FROM users WHERE id IN (${allRefIds.map(() => '?').join(',')})`, allRefIds)
            : [];
        const userMap = new Map(userRows.map(u => [u.id, u]));
        const nameOf = (uid) => { const u = userMap.get(Number(uid)); return (u && u.display_name) || `user#${uid}`; };

        // 钉钉号解析（缺则按手机号反查 + 回写；无手机号/格式非法/反查失败 → 返空，best-effort 降级）
        async function resolveDing(u) {
            let ding = (u && u.dingtalk_user_id != null) ? String(u.dingtalk_user_id).trim() : '';
            if (ding) return ding;
            const phone = (u && u.phone != null) ? String(u.phone).trim() : '';
            if (!/^1\d{10}$/.test(phone)) return '';
            try {
                const raw = await dingtalkNotify.getUserIdByMobile(token, phone);
                ding = raw != null ? String(raw).trim() : '';
                if (ding) await dbRunAsync(`UPDATE users SET dingtalk_user_id = ? WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = '')`, [ding, u.id]);
                return ding;
            } catch (err) {
                logger.warn(`[correction-create-chat] 修正单 #${id} 成员 ${nameOf(u.id)} 钉钉号反查失败：${dingtalkNotify.classifyError(err).reason}，降级跳过`);
                return '';
            }
        }

        const memberDingList = [];                 // {userId, dingtalk_user_id, display_name}
        const seenDing = new Set();
        const warnings = [];
        const missingRequiredMemberIds = [];       // 固定底座缺钉钉号（strong warning，不阻断）

        // 固定底座示例只读领导A排除的 warning（M-5）
        for (const bid of baseExcludedIds) warnings.push({ code: 'REQUIRED_MEMBER_EXCLUDED', user_id: bid, display_name: nameOf(bid) });

        // 处理固定底座成员（缺钉钉号 → missing_required，不阻断）
        for (const bid of baseIdSet) {
            const u = userMap.get(bid);
            if (!u) { missingRequiredMemberIds.push({ user_id: bid, display_name: `user#${bid}` }); continue; }   // 账号丢失（脏数据）
            const ding = await resolveDing(u);
            if (!ding) { missingRequiredMemberIds.push({ user_id: bid, display_name: u.display_name || `user#${bid}` }); continue; }
            if (!seenDing.has(ding)) { seenDing.add(ding); memberDingList.push({ userId: bid, dingtalk_user_id: ding, display_name: u.display_name || `user#${bid}` }); }
        }

        // 处理额外成员（① 不存在 / ② 已禁用 → 静默剔除；④ 无钉钉号 → 跳过 + warning）
        const includedExtraIds = [];
        const skippedExtraIds = [];
        for (const eid of extraIdSet) {
            const u = userMap.get(eid);
            if (!u) continue;                          // ① 不存在 → 直接剔除（静默）
            if (u.status === 'disabled') continue;     // ② 已禁用 → 直接剔除（静默）
            const ding = await resolveDing(u);
            if (!ding) {                               // ④ 无钉钉号 → 跳过 + warning（不阻断）
                skippedExtraIds.push(eid);
                warnings.push({ code: 'EXTRA_MEMBER_SKIPPED_NO_DINGTALK', user_id: eid, display_name: u.display_name || `user#${eid}` });
                continue;
            }
            // M-1（codex 16）：included_extra_member_ids 严格 = 实际新增进群的额外成员。
            //   ding 与底座/前一个额外成员重复（同一人多平台账号绑同一钉钉号）时本就在群里，不计入 included（也不计 skipped），避免误导前端"已加入 N 人"。
            if (!seenDing.has(ding)) {
                seenDing.add(ding);
                memberDingList.push({ userId: eid, dingtalk_user_id: ding, display_name: u.display_name || `user#${eid}` });
                includedExtraIds.push(eid);
            }
        }

        // 业务方真人加入（requester_phone 反查，best-effort；不进 users 表故 userId=0；对齐 collab 11591-11604）
        //   M-2（codex 16）：业务方未加入是预期内常态降级（业务方多不在企业钉钉），不塞进 warnings 数组（避免前端误判为异常），
        //   改用独立 requester_included + requester_skip_reason 字段，让前端可提示"业务方未加入，请线下补拉"（消文档 §4.9.3 与实现分叉）。
        let requesterIncluded = false;
        let requesterSkipReason = 'none';   // none=已在群 / no_phone=未填或格式非法 / not_found=反查无此人 / lookup_failed=反查异常
        {
            const reqPhone = String(c.requester_phone || '').trim();
            if (!reqPhone || !/^1\d{10}$/.test(reqPhone)) {
                requesterSkipReason = 'no_phone';
            } else {
                try {
                    const raw = await dingtalkNotify.getUserIdByMobile(token, reqPhone);
                    const rDing = raw != null ? String(raw).trim() : '';
                    if (!rDing) {
                        requesterSkipReason = 'not_found';
                    } else if (seenDing.has(rDing)) {
                        requesterIncluded = true;   // 业务方钉钉号已在成员列表（业务方本身也是平台成员/与某成员同号）→ 已在群
                    } else {
                        seenDing.add(rDing);
                        memberDingList.push({ userId: 0, dingtalk_user_id: rDing, display_name: `${c.requester_name || '业务方'}（业务方）` });
                        requesterIncluded = true;
                    }
                } catch (err) {
                    requesterSkipReason = 'lookup_failed';
                    logger.warn(`[correction-create-chat] 修正单 #${id} 业务方手机号 ${maskPhone(c.requester_phone)} 反查失败：${dingtalkNotify.classifyError(err).reason}，降级不加业务方`);
                }
            }
        }

        // 群主 = 示例用户A（COLLAB_CHAT_ADMIN_ID）。示例用户A钉钉号未解析到（理论不发生，id=3 生产恒有）→ 无群主无法建群，硬失败
        const owner = memberDingList.find(m => m.userId === COLLAB_CHAT_ADMIN_ID);
        if (!owner) {
            return res.status(500).json({
                error: '群主（示例用户A）钉钉账号未解析到，无法建群，请联系管理员',
                code: 'OWNER_NOT_RESOLVABLE', missing_required_member_ids: missingRequiredMemberIds
            });
        }
        // 至少需群主 + 1 人（仅剩群主无法成群）→ 友好预检，避免钉钉返回不透明错误
        if (memberDingList.length < 2) {
            return res.status(409).json({
                error: '可加入群的有效成员不足（除群主外无其他已绑钉钉成员），请先为相关成员绑定钉钉号',
                code: 'NOT_ENOUGH_MEMBERS', missing_required_member_ids: missingRequiredMemberIds, warnings
            });
        }

        // 群名：[数据修正]{location_info 摘要}-讨论（Array.from 按码点截断 ≤20，不截半个字，对齐 collab/issue）
        const rawName = `[数据修正]${String(c.location_info || ('#' + id)).trim()}-讨论`;
        const cp = Array.from(rawName);
        const chatName = cp.length > 20 ? cp.slice(0, 20).join('') : rawName;

        // 调钉钉建群（一次成型）
        let chatRes;
        try { chatRes = await dingtalkNotify.createChatGroup(token, chatName, owner.dingtalk_user_id, memberDingList.map(m => m.dingtalk_user_id)); }
        catch (err) { const cls = dingtalkNotify.classifyError(err); logger.warn(`[correction-create-chat] 修正单 #${id} chat/create 异常：${cls.reason}`); return res.status(502).json({ error: cls.hint, errcode: cls.errcode, reason: cls.reason, code: 'CHAT_CREATE_FAILED' }); }
        if (!chatRes || chatRes.errcode !== 0) {
            const cls = dingtalkNotify.classifyError(chatRes || {});
            logger.warn(`[correction-create-chat] 修正单 #${id} chat/create 拒绝 errcode=${chatRes && chatRes.errcode}`);
            return res.status(502).json({ error: cls.hint, errcode: chatRes && chatRes.errcode, reason: cls.reason, code: 'CHAT_CREATE_REJECTED' });
        }
        const newChatId = chatRes.chatid;
        const newOpenConvId = chatRes.openConversationId;
        // H-1（codex 16）：errcode=0 不代表群标识齐全——钉钉字段缺失/改名时 chatid/openConversationId 可能为空。
        //   若放任 null 落库会破坏本模块幂等锚点（dingtalk_open_conversation_id IS NULL 判定）→ 重复建群 + 不可用成功。
        //   群已建但无可用标识，平台无从落库（钉钉无解散 API），只能 CRITICAL 记原始响应供排查后返 502。
        if (!newChatId || !String(newChatId).trim() || !newOpenConvId || !String(newOpenConvId).trim()) {
            // L-1'（codex 17）：附原始响应（限长 500，钉钉建群响应仅 chatid/openConversationId/errcode 无敏感字段）便于排查字段改名/结构异常
            let chatResRaw = ''; try { chatResRaw = JSON.stringify(chatRes).slice(0, 500); } catch (_) { chatResRaw = '[unserializable]'; }
            logger.error(`[correction-create-chat] CRITICAL 修正单 #${id} chat/create 返 errcode=0 但群标识缺失 chatid=${newChatId} open_conversation_id=${newOpenConvId}（钉钉响应字段契约异常，群可能已建出无法关联）raw=${chatResRaw}`);
            return res.status(502).json({ error: '钉钉建群返回异常（群标识缺失），请稍后重试或联系管理员', code: 'CHAT_CREATE_BAD_RESPONSE' });
        }

        // 旁路 UPDATE 5 群字段 + 双 WHERE 守卫（open_conversation_id IS NULL 防并发 + voided_at/status 守卫防建群期间被作废/归档）。
        //   不走 transition / 不动 status / 不写 correction_status_history（G-6/L-2，拉群非状态流转）。
        let upd;
        try {
            upd = await dbRunAsync(
                `UPDATE correction_requests
                    SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ?,
                        dingtalk_chat_created_at = datetime('now','localtime'), dingtalk_chat_created_by = ?, dingtalk_chat_name = ?
                  WHERE id = ? AND dingtalk_open_conversation_id IS NULL AND voided_at IS NULL
                    AND status IN (${CORRECTION_CHAT_ALLOWED_STATUSES.map(() => '?').join(',')})`,
                [newChatId, newOpenConvId, userId, chatName, id, ...CORRECTION_CHAT_ALLOWED_STATUSES]);
        } catch (dbErr) {
            logger.error(`[correction-create-chat] CRITICAL 钉钉群已建但落库异常 correction_id=${id} chatid=${newChatId} open_conversation_id=${newOpenConvId} chat_name=${chatName} created_by=${userId}(${userName}) error=${dbErr.message}`);
            return res.status(500).json({ error: '钉钉群已创建但平台落库失败，请联系管理员手工补录（详见后端日志）', code: 'CHAT_CREATED_DB_UPDATE_FAILED', chat_id: newChatId, open_conversation_id: newOpenConvId, chat_name: chatName });
        }
        if (!upd || upd.changes === 0) {
            // 守卫未过：并发抢先落库 或 建群期间被作废/归档
            const refreshed = await dbGetAsync('SELECT status, voided_at, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name FROM correction_requests WHERE id = ?', [id]);
            if (refreshed && refreshed.dingtalk_open_conversation_id) {
                logger.warn(`[correction-create-chat] 并发竞态：修正单 #${id} 另一请求已先落库（${refreshed.dingtalk_chat_id}），本次新建群 chatid=${newChatId} 丢弃`);
                return res.json({ message: '修正单已有讨论群（您本次新建的群因并发竞态被舍弃，请群主在钉钉客户端解散）', id, chat_id: refreshed.dingtalk_chat_id, open_conversation_id: refreshed.dingtalk_open_conversation_id, chat_name: refreshed.dingtalk_chat_name, idempotent: true, race_dropped_chat_id: newChatId });
            }
            logger.error(`[correction-create-chat] STATE_CHANGED 修正单 #${id} 建群期间被作废/归档 chatid=${newChatId} open_conversation_id=${newOpenConvId} created_by=${userId}(${userName})`);
            return res.status(409).json({ error: '修正单状态已变化（可能被作废/归档），群已建出但未关联，请群主在钉钉客户端手动解散', code: 'STATE_CHANGED', chat_id: newChatId, open_conversation_id: newOpenConvId });
        }
        logger.info(`[correction-create-chat] 修正单 #${id} 拉群成功 by ${userName} chatid=${newChatId}（成员 ${memberDingList.length}）`);

        // 发欢迎卡片（best-effort，失败不影响建群）
        try {
            const esc = dingtalkNotify.escapeMarkdown;
            const cardTitle = `数据修正讨论群 #${id}`;
            const cardMd = [
                `## 数据修正讨论群已创建`, ``,
                `**修正方式**：${esc(String(c.location_info || '-'))}`,
                `**业务方**：${esc(String(c.requester_name || '-'))}`,
                `**拉群人**：${esc(userName)}`, ``,
                `> 请相关方在群内同步上下文，推进数据修正。`
            ].join('\n');
            const cardResp = await dingtalkNotify.sendGroupMessage(token, robotCode, newOpenConvId, 'sampleMarkdown', { title: cardTitle, text: cardMd });
            if (cardResp && cardResp.code) logger.warn(`[correction-create-chat] #${id} 群卡片发送失败 code=${cardResp.code}`);
        } catch (err) { logger.warn(`[correction-create-chat] #${id} 群消息发送异常（不影响建群）：${err.message}`); }

        return res.json({
            message: '讨论群已创建，请到钉钉客户端查看（钉钉无解散接口，使用完后由群主在客户端手动解散）',
            id, chat_id: newChatId, open_conversation_id: newOpenConvId, chat_name: chatName,
            member_count: memberDingList.length, idempotent: false,
            warnings,
            included_extra_member_ids: includedExtraIds,
            skipped_extra_member_ids: skippedExtraIds,
            missing_required_member_ids: missingRequiredMemberIds,
            requester_included: requesterIncluded,
            requester_skip_reason: requesterSkipReason
        });
    } catch (e) {
        logger.error(`[correction-create-chat] 修正单 #${id} 拉群异常: ${e.message}`, e);
        return res.status(500).json({ error: '拉群失败，请联系管理员', code: 'CREATE_CHAT_FAILED' });
    }
});

  return {
    initSchema,
    router,
    _internals: { CORRECTION_STATUSES, CORRECTION_STATUS_TRANSITIONS, CORRECTION_TYPES, CORRECTION_SOURCE_SYSTEMS, CORRECTION_NOTIFY_SENDABLE, CORRECTION_READ_FIELD_MAP, CORRECTION_ALLOWED_EXTS, CORRECTION_CHAT_EXCLUDE_IDS, CORRECTION_CHAT_ALLOWED_STATUSES, CORRECTION_REQUESTS_KEY_COLS, CORRECTION_ATTACHMENTS_KEY_COLS, CORRECTION_HISTORY_KEY_COLS, CORRECTION_REQUESTERS_KEY_COLS, CORRECTION_REQUESTERS_NOTNULL_COLS, CORRECTION_REQUESTER_NOTIFY_STATUSES, normalizeCorrectionDatetime, correctionDefaultDeadline, parsePositiveCorrectionId, correctionTransition, correctionActor, isCorrectionChatExcludedId, requireCorrectionSchemaReady, CORRECTION_SCHEMA_STATE, CORRECTION_RELAY_USER_IDS, isCorrectionRelayWhitelisted, normalizeCorrectionRequesters, writeCorrectionRequesters, resolveCorrectionGroupAnchor, isGroupMemberDoneForBusinessNotify },
  };
};
