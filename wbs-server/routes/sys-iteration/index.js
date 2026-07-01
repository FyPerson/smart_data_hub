// routes/sys-iteration/index.js — 系统迭代模块（业务系统软件迭代跟踪）
//   业务设计 SSOT = docs/local/系统迭代/系统迭代_方案_20260624_v1.6.md（4 类型 bug/feature/improvement/config）
//   编码实施 SSOT = docs/local/系统迭代/系统迭代_编码实施方案_20260624_v1.3.md
//
// C1 范围（本 commit）：schema（4 表 + 索引）+ readiness 守门 + 空 router + initSchema + 导出 _internals。
//   ⚠️ 切片策略：本轮先打通【变更流（feature + improvement）】，但 schema 4 表一次建全、type CHECK 含全 4 类、
//     effected_at/release_id CHECK 照建（方案 §3.1 铁律：一次建全避免后续 ALTER 重建表）。
//     状态机常量 / transition / 端点是 C2 起增量，C1 不含。
//
// 范式来源（已逐项 grep 对齐 corrections.js，§15b 核实）：
//   - readiness：CORRECTION_SCHEMA_STATE + 关键列 PRAGMA 复查 + 未就绪 503（corrections.js:34-91/319-532）
//   - initSchema：db.serialize 顺序建表 + recordErr 兜底 + serialize 末条 callback 触发 migration（corrections.js:104-318）
//   - 全新模块：CREATE TABLE IF NOT EXISTS 一次建全，无 ALTER（核实#1）
//   - 删单显式删子表（核实#1，本项目从不开 PRAGMA foreign_keys=ON）
//   - 导出 { initSchema, router, _internals }，_internals 供 verify require 真实逻辑（RC-L2 根治复刻漂移）
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');     // C3b 附件上传（自建，对齐 corrections.js:9 范式；§10.3 deps 表 multer=自建）
const T = require('./transitions');   // 状态机常量单一来源（§3.7，T-M4）
const issueNotify = require('../../utils/issue-notify');   // C5 通知 markdown 安全文本（issueSafeText 复用 dingtalk-notify escapeMarkdown，不新建转义，§10.3 require）

// sysIssueTransition 抛的业务/并发错误（endpoint catch 转 HTTP，对齐 corrections CorrectionTransitionError）。
class SysTransitionError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'SysTransitionError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

module.exports = (deps) => {
  // 工厂期 deps 校验——漏注入即启动期 throw（对齐 corrections codex M-2）。
  // codex 13 L-1 口径：本清单是**模块稳定注入契约**——C1 当前实际只用 logger / db / authenticateToken 三项；
  //   dbRunAsync / dbGetAsync / dbAllAsync / requireAdmin 是为 **C2+（端点查询 / 建单权限 / 附件）预留**的契约项，
  //   现在一并校验是为了 C1/C2 紧邻、避免来回扩 REQUIRED_DEPS + 改 server.js 注入。附件/通知 deps 见 §10.3 分阶段
  //   （C3 UPLOAD_DIR/multer、C5 钉钉），到对应 commit 再加入本清单。
  //   ⬆ C3b（附件）加入：UPLOAD_DIR / normalizeAttachmentExt / safeDeleteFileSync / ALLOWED_FILE_DIRS（§10.3 均=注入；multer=自建已 require）。
  //   ⬆ C5（通知）加入：sendIssueDingtalkRaw（dev/creator 走 users.id→phone）/ sendIssueDingtalkToRequester（需求方走 requester_phone 反查）/
  //     getSafePlatformBaseUrl（深链 baseUrl，已 sanitize）——三者均为 server.js 既有 issue-tracker 发送链路闭包，注入复用（§8.2 硬要求"复用现有范式"）。
  const REQUIRED_DEPS = ['logger', 'db', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken', 'requireAdmin',
    'UPLOAD_DIR', 'normalizeAttachmentExt', 'safeDeleteFileSync', 'ALLOWED_FILE_DIRS',
    'sendIssueDingtalkRaw', 'sendIssueDingtalkToRequester', 'getSafePlatformBaseUrl'];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/sys-iteration 缺注入依赖: ' + __k);
  }
  const { logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken, requireAdmin,
    UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync, ALLOWED_FILE_DIRS,
    sendIssueDingtalkRaw, sendIssueDingtalkToRequester, getSafePlatformBaseUrl } = deps;

  // ============================================================
  // 一、schema readiness state + 关键列锚点常量 + 守门中间件
  // ============================================================
  // 系统迭代是全新模块（sys_releases/sys_issues/sys_issue_timeline/sys_issue_attachments 四表）。
  //   全新表用 CREATE TABLE IF NOT EXISTS 一次建全（无 ALTER，方案 §3.1）。migration 函数只 PRAGMA 复查
  //   四表 + 关键列就位才置 ready；未就绪挡 sys-* 写入口（503），其他模块正常。
  //   readiness 闸门 = 冗余防线 + 首启短暂窗口保护（migration 完成前 ready=false，避免首启报错）。
  const SYS_SCHEMA_STATE = { ready: false, error: null };

  const SYS_REQUIRED_TABLES = ['sys_releases', 'sys_issues', 'sys_issue_timeline', 'sys_issue_attachments'];

  // readiness 复查是"启动期就绪 status-only 抽样"——挑代表性关键不变量列（三侧通知 status 锚点/质量计数/
  //   来源/血缘批次/config 生效时刻），不做全字段全量校验（那是 verify-sys-schema.js 的职责，对齐 corrections
  //   codex 08 M-1 驳回"补全列全集"理由）。
  // ⚠️ 口径与前提（codex 13 M-1 统一）：三侧通知每侧只查 *_notify_status 一个 status 锚点，**不查**该侧
  //   notified_at/message_key/error/read_at 其余 4 列——前提 = **本模块全新、无 ALTER**：三侧 5 列在同一条
  //   CREATE TABLE 原子建表，要么整表成功（5 列全在）、要么 firstSysDdlError 兜底（整表失败），不存在
  //   "status 列在、其余 4 列缺"的半成品态。**三侧通知各 5 列的全量校验在 verify-sys-schema.js（07-M3）**，
  //   readiness 与 verify 职责分工明确、不分裂。若将来 config 等追加列改用 ALTER，须把对应 status 锚点
  //   保持在本清单（ALTER 后半成品态才可能出现，届时此抽样假设需重审）。
  // ⚠️ L-6：三侧通知 status 锚点（dev/requester/creator）必须列全，别只查新增漏既有。
  const SYS_ISSUES_KEY_COLS = [
    'type', 'status', 'priority', 'system_name', 'source', 'record_source', 'import_batch_id',
    'origin_issue_id', 'release_id', 'created_by', 'assigned_to',
    'dev_estimated_at', 'deadline', 'assigned_at', 'first_submitted_at', 'accepted_at',
    'released_at', 'closed_at', 'reopened_at',
    'reopen_count', 'return_count', 'scope_changed',
    'notify_status', 'requester_notify_status', 'creator_notify_status',  // ← 三侧锚点（L-6）
    'effected_at',                                                        // ← config 已生效时刻（11-M1），readiness 须含
    'needs_feasibility', 'feasibility_conclusion', 'blocked'             // ← 可行性评估闸门锚点（F1 §2.3，抽样非全列；其余 4 评估列由 verify 全量保障）
  ];
  const SYS_RELEASES_KEY_COLS = ['release_no', 'status', 'is_hotfix', 'release_note', 'version_tag'];
  const SYS_TIMELINE_KEY_COLS = ['event_type', 'from_status', 'to_status', 'action_code', 'ref_id', 'round_no'];
  const SYS_ATTACHMENTS_KEY_COLS = ['attachment_type', 'round_no', 'status'];

  // ── 受阻三件套清理（§⑥ admin 处置后清当前 blocked 字段）：hold/void 处置 + unblock 解除 + 换轮复用 ──────────
  //   F2b 修（ultracode 对抗审）：F2b 让 blocked=1 首次可达后，hold/void 处置 blocked 单必须清 blocked，
  //   否则暂缓→resume 后残留 blocked=1 致开发无法 submit（卡死）/ 作废残留脏数据。
  const SYS_CLEAR_BLOCKED_FIELDS_SQL = [
    'blocked = 0',
    'blocked_reason = NULL',
    'blocked_at = NULL',
  ];
  // ── 换轮清字段（H-2/H-3，F2a §六）：reassign/return/reopen 开启新一轮时，清当前轮评估3 + 受阻3 ──────────
  //   评估/blocked 是"当前轮"状态，换人/打回/重开都进新一轮、不继承旧轮（对齐 T-M2 dev_estimated_at 每轮重填）。
  //   清前 feasibility timeline 快照已写（每次填评估即写），历史从 timeline 追溯（H-3 冻结）；未填评估就换轮时清空无害（本就 NULL）。
  //   ⚠️ dev_estimated_at 不在本片段——三路径各自原有逻辑已清（均含 dev_estimated_at=NULL），本 helper 仅管评估3+blocked3，
  //     不动既有 dev_estimated_at 清理路径（最小回归）。抽片段供三路径复用，防字段清单漂移（codex 17b rec）。
  //   ⚠️ 与 SYS_CLEAR_BLOCKED_FIELDS_SQL 的区别：换轮连评估一起清（新一轮重评）；hold/void/unblock 只清 blocked、留评估（§⑥「不动原评估」作问责对照）。
  const SYS_CLEAR_FEASIBILITY_FIELDS_SQL = [
    'feasibility_conclusion = NULL',
    'feasibility_requirement_confirm = NULL',
    'feasibility_risk = NULL',
    ...SYS_CLEAR_BLOCKED_FIELDS_SQL,
  ];

  // 守门中间件：C2 起所有 sys-* 写入口（建单/指派/流转/批次/附件/通知）挂在路由前。
  //   readiness=false → 503，避免建表/迁移失败被吞后入口运行期 SQL 崩。
  function requireSysSchemaReady(req, res, next) {
    if (SYS_SCHEMA_STATE.error) {
      return res.status(503).json({
        error: '系统迭代功能暂不可用：表结构未就绪',
        detail: SYS_SCHEMA_STATE.error,
        code: 'SYS_SCHEMA_NOT_READY'
      });
    }
    if (!SYS_SCHEMA_STATE.ready) {
      return res.status(503).json({
        error: '系统迭代功能正在初始化，请稍后重试',
        code: 'SYS_SCHEMA_INITIALIZING'
      });
    }
    next();
  }

  // ============================================================
  // 二、DDL（四表 + 索引）。建表 serialize 块包进 initSchema()，
  //   server.js 启动 db 回调内调用 sysIterModule.initSchema()（busy_timeout + initTable + correction initSchema 之后）。
  // ============================================================
  function initSchema() {
    // 字段级 DDL 见方案 v1.6 §4.1-§4.4（本文与方案逐字对齐）。
    // CHECK 约束：type/source/priority/notify_status/event_type/attachment_type/release status 等枚举进 DB CHECK
    //   （方案 L-2/09-M3 明确要 CHECK 防脏值；与 correction"枚举不进 CHECK"惯例不同——本模块按方案要求带 CHECK）。
    // ⚠️ 约束漂移防线（codex 13 M-2）：CREATE TABLE IF NOT EXISTS 对【已存在表】是 no-op，不补约束。
    //   本模块 sys_* 是**全新表，首次上线前生产无旧表**（起服务日志确认首次建表），不存在"列齐但缺 CHECK"
    //   的半成品态，故 runSysMigration 只复查表+关键列、不复查 CHECK/NOT NULL/UNIQUE 是否存在（那是 verify 职责）。
    //   CHECK/NOT NULL/UNIQUE 漂移由 **verify-sys-schema.js 全量覆盖**（含 config release_id 永空 CHECK 等），
    //   **verify-sys-schema 纳入部署前必跑清单**——不靠 readiness 做约束自检（readiness 是每启动热路径，跑
    //   sqlite_master.sql 文本断言职责错位 + 加启动开销）。
    // 建表顺序（RC-L3，FK 引用顺序）：sys_releases → sys_issues（自引用 + 引用 releases）→ timeline → attachments。
    //   注：本项目 foreign_keys=OFF（核实#1），CREATE 时不校验被引用表存在、运行时 FK 不 enforcement——
    //   此顺序为自文档 + 未来开 PRAGMA 兼容 + verify 友好，运行不依赖。
    // ⚠️ 独立 serialize 块保证 CREATE→INDEX 严格串行（CREATE INDEX 编译期校验列名，与 CREATE TABLE 并发触发
    //   "no such column" 竞态，corrections.js:110 同源踩坑）。
    db.serialize(() => {
      // db.run 不传 callback 时前序失败不中止队列（"末条成功 ≠ 前面没失败"），故每个 DDL 挂 recordSysErr，
      //   migration 触发前据 firstSysDdlError 判定（corrections.js:114-121 范式）。
      let firstSysDdlError = null;
      const recordSysErr = (label) => (err) => {
        if (err && !firstSysDdlError) {
          firstSysDdlError = `${label}: ${err.message}`;
          logger.error(`[系统迭代 C1] DDL 失败 @${label}：${err.message}`);
        }
      };

      // ── 2.1 sys_releases（上线批次，§4.4）──────────
      db.run(`CREATE TABLE IF NOT EXISTS sys_releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_no TEXT NOT NULL UNIQUE,
        title TEXT,
        status TEXT NOT NULL DEFAULT '计划中' CHECK (status IN ('计划中','已发布')),
        is_hotfix INTEGER NOT NULL DEFAULT 0,
        release_note TEXT,
        version_tag TEXT,
        planned_date DATE,
        released_at DATETIME,
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime'))
      )`, recordSysErr('sys_releases'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_releases_status ON sys_releases(status)`, recordSysErr('idx_sys_releases_status'));

      // ── 2.2 sys_issues（主表，§4.1）──────────
      //   type CHECK 一次定全 4 类（含 config，避免后续 ALTER 重建表）；
      //   config release_id 永空 DDL CHECK（12-H2）：CHECK (type <> 'config' OR release_id IS NULL) 覆盖所有写入口；
      //   source/priority/三侧 notify_status/record_source 均带 CHECK（方案 L-2/T-M5）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        type TEXT NOT NULL CHECK (type IN ('bug','feature','improvement','config')),
        status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
        priority_reviewed_at DATETIME,

        title TEXT NOT NULL,
        description TEXT,
        system_name TEXT NOT NULL,
        module_name TEXT,
        source TEXT NOT NULL DEFAULT '内部' CHECK (source IN ('业务方','内部','生产故障')),

        requester_dept TEXT,
        requester_name TEXT,
        requester_phone TEXT,

        origin_issue_id INTEGER REFERENCES sys_issues(id),
        release_id INTEGER REFERENCES sys_releases(id),

        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        assigned_to INTEGER,
        assigned_to_name TEXT,

        dev_estimated_at DATETIME,
        deadline DATE,

        assigned_at DATETIME,
        first_submitted_at DATETIME,
        accepted_at DATETIME,
        released_at DATETIME,
        effected_at DATETIME,
        closed_at DATETIME,
        reopened_at DATETIME,

        reopen_count INTEGER NOT NULL DEFAULT 0,
        return_count INTEGER NOT NULL DEFAULT 0,
        scope_changed INTEGER NOT NULL DEFAULT 0,
        last_transition_reason TEXT,

        notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (notify_status IN ('not_sent','sent','failed')),
        notified_at DATETIME,
        notify_message_key TEXT,
        notify_error TEXT,
        read_at DATETIME,

        requester_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (requester_notify_status IN ('not_sent','sent','failed')),
        requester_notified_at DATETIME,
        requester_notify_message_key TEXT,
        requester_notify_error TEXT,
        requester_read_at DATETIME,

        creator_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (creator_notify_status IN ('not_sent','sent','failed')),
        creator_notified_at DATETIME,
        creator_notify_message_key TEXT,
        creator_notify_error TEXT,
        creator_read_at DATETIME,

        -- 可行性评估（评估环节 F1，业务 SSOT = 系统迭代_方案_v1.7 §十九；仅 feature/improvement 用，config 后端拒设、不展示）
        needs_feasibility INTEGER NOT NULL DEFAULT 0 CHECK (needs_feasibility IN (0,1)),   -- 建单勾"需要评估"分级（config 后端强制 0）
        feasibility_conclusion TEXT CHECK (feasibility_conclusion IS NULL OR feasibility_conclusion IN ('可行','有条件可行','不可行')),
        feasibility_requirement_confirm TEXT,                  -- 需求理解确认（开发复述）
        feasibility_risk TEXT,                                 -- 风险与依赖
        -- 受阻（§19.3 ⑥）
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),   -- 受阻标记（开发标，admin 解除）
        blocked_reason TEXT,
        blocked_at DATETIME,
        -- ⚠️ needs_feasibility/blocked 承担 submit 闸门逻辑，脏值 2/-1 语义不清 → 硬 CHECK(0,1)（不照 scope_changed 无 CHECK 范式，codex 17 M-2）

        record_source TEXT NOT NULL DEFAULT 'native' CHECK (record_source IN ('native','import')),
        import_batch_id TEXT,

        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime')),

        CHECK (type <> 'config' OR release_id IS NULL)
      )`, recordSysErr('sys_issues'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_status   ON sys_issues(status)`, recordSysErr('idx_sys_issues_status'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_type     ON sys_issues(type)`, recordSysErr('idx_sys_issues_type'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_system   ON sys_issues(system_name)`, recordSysErr('idx_sys_issues_system'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_assigned ON sys_issues(assigned_to)`, recordSysErr('idx_sys_issues_assigned'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_release  ON sys_issues(release_id)`, recordSysErr('idx_sys_issues_release'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_issues_origin   ON sys_issues(origin_issue_id)`, recordSysErr('idx_sys_issues_origin'));

      // ── 2.3 sys_issue_timeline（统一事件表，§4.2，append-only）──────────
      //   event_type 含 reassign 独立枚举（05-H1）；FK ON DELETE CASCADE（自文档，运行不依赖 PRAGMA OFF）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'created','assign','reassign','estimate','status_change','scope_change',
          'submit','return','release','reopen','derive','note',
          'feasibility','blocked','unblock'
        )),
        from_status TEXT,
        to_status TEXT,
        summary TEXT,
        action_code TEXT,
        ref_id INTEGER,
        round_no INTEGER,
        operator_id INTEGER NOT NULL,
        operator_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
      )`, recordSysErr('sys_issue_timeline'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_timeline_issue ON sys_issue_timeline(issue_id, created_at)`, recordSysErr('idx_sys_timeline_issue'));

      // ── 2.4 sys_issue_attachments（附件，§4.3）──────────
      //   attachment_type CHECK 含 spec（建单需求附件，方案 C）；status CHECK active/superseded（无 pending，09-M3）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        attachment_type TEXT NOT NULL DEFAULT 'delivery' CHECK (attachment_type IN ('delivery','screenshot','spec')),
        round_no INTEGER,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
        uploaded_by INTEGER NOT NULL,
        uploaded_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
      )`, recordSysErr('sys_issue_attachments'));
      // ⚠️ 最后一个 DDL 的 callback 触发 migration（时序铁律 corrections.js:322-323：
      //   必须由 serialize 块内最后一个 db.run callback 触发，否则 PRAGMA 与队列里 CREATE TABLE 竞态 → 永久 false）。
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_attach_issue ON sys_issue_attachments(issue_id)`, (err) => {
        recordSysErr('idx_sys_attach_issue')(err);
        runSysMigration(firstSysDdlError);
      });
    });
  }

  // ── schema 就绪探测（方案 §3.5 / 核实#5）─────────────────
  //   全新模块无 ALTER：本函数不改 schema，只在 serialize 队列消耗完后 PRAGMA 复查四表 + 关键列是否到位，
  //   全部就位才置 SYS_SCHEMA_STATE.ready=true。入参 ddlError：建表 serialize 块收集的首个 DDL 错误。
  async function runSysMigration(ddlError) {
    try {
      // 函数开头显式重置 ready=false，状态转移清晰（corrections.js codex 08 L-1）。
      SYS_SCHEMA_STATE.ready = false;

      // [0] 建表阶段若有 DDL 失败，直接熔断
      if (ddlError) {
        SYS_SCHEMA_STATE.error = `建表 DDL 失败：${ddlError}`;
        logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error} → sys-* 写入口将返 503`);
        return;
      }

      // [1] 四表存在性
      const tables = await new Promise((resolve, reject) => {
        db.all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sys_releases','sys_issues','sys_issue_timeline','sys_issue_attachments')",
          (err, rows) => err ? reject(err) : resolve((rows || []).map(r => r.name))
        );
      });
      const missingTables = SYS_REQUIRED_TABLES.filter(t => !tables.includes(t));
      if (missingTables.length > 0) {
        SYS_SCHEMA_STATE.error = `系统迭代表缺失：${missingTables.join(',')}`;
        logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error} → sys-* 写入口将返 503`);
        return;
      }

      // [2] 四表关键列 PRAGMA 复查（抽样锚点，非全字段）
      const checks = [
        ['sys_issues', SYS_ISSUES_KEY_COLS],
        ['sys_releases', SYS_RELEASES_KEY_COLS],
        ['sys_issue_timeline', SYS_TIMELINE_KEY_COLS],
        ['sys_issue_attachments', SYS_ATTACHMENTS_KEY_COLS],
      ];
      for (const [tbl, keyCols] of checks) {
        const cols = await new Promise((resolve, reject) => {
          db.all(`PRAGMA table_info(${tbl})`, (err, rows) => err ? reject(err) : resolve(rows));
        });
        if (!cols || cols.length === 0) {
          SYS_SCHEMA_STATE.error = `无法读取 ${tbl} 表结构（PRAGMA 失败）`;
          logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error}`);
          return;
        }
        const colNames = cols.map(c => c.name);
        const missingCols = keyCols.filter(c => !colNames.includes(c));
        if (missingCols.length > 0) {
          SYS_SCHEMA_STATE.error = `${tbl} 关键列缺失：${missingCols.join(',')}`;
          logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error} → sys-* 写入口将返 503`);
          return;
        }
      }

      // [3] 全部就位 → 置 ready
      SYS_SCHEMA_STATE.error = null;
      SYS_SCHEMA_STATE.ready = true;
      logger.info(`[系统迭代 C1] ✅ sys 四表就绪（${tables.length}/4 表 + 四表关键列锚点齐全），写入口放行。`);
    } catch (e) {
      SYS_SCHEMA_STATE.ready = false;
      SYS_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
      logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error}`);
    }
  }

  // ============================================================
  // 二·五、actor 提取 + sysIssueTransition（C2 状态机骨架，核实#2 蓝本 correctionTransition）
  // ============================================================

  // actor 提取（对齐 corrections correctionActor，req.user 由 authenticateToken 注入）。
  function sysActor(req) {
    return {
      id: Number(req.user.id),
      name: req.user.display_name || req.user.username || `user#${req.user.id}`,
      role: req.user.role,
    };
  }

  // 正整数 id 解析（端点 :id / assigned_to 等用，对齐 correction parsePositiveCorrectionId）。
  function parsePositiveId(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // datetime 规范化（核实#8 / §6.2：C3 复刻 correction normalizeCorrectionDatetime 零回归；
  //   backlog 记"datetime 校验三模块统一抽 utils/datetime-normalize.js"）。
  //   接受 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DDTHH:MM'（前端 datetime-local）等，规范化为 'YYYY-MM-DD HH:MM'；
  //   非法返 null（端点据此返 400）。
  //   codex 15 M-2：口径**分钟级**——只接受 YYYY-MM-DD HH:MM，**带秒判非法**（不再吞秒，避免 10:30:99 被
  //   规范化为 10:30 通过）。与 assigned_at 比较时见 estimate 端点（assigned_at 也归一化到分钟，同分钟视为不早于）。
  function normalizeSysDatetime(raw) {
    if (raw === undefined || raw === null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace('T', ' ');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})$/);   // 严格分钟级，无可选秒
    if (!m) return null;
    const [, y, mo, d, h, mi] = m.map(Number);
    const dt = new Date(y, mo - 1, d, h, mi);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
  }

  // 把 DB 的 datetime（可能带秒，如 datetime('now','localtime') = 'YYYY-MM-DD HH:MM:SS'）截到分钟，用于 estimate 比较。
  function truncToMinute(dbDatetime) {
    if (!dbDatetime) return null;
    const m = String(dbDatetime).trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]}` : null;
  }

  // deadline 校验（codex 14 M-2）：仅接受 YYYY-MM-DD + 必须是真实日期（挡 2026-13-45 这类格式对但非法的）。
  //   返回 { ok, value } —— value 为规范化后的 YYYY-MM-DD 字符串；ok=false 表示非法（端点返 400 INVALID_DEADLINE）。
  //   空/未传 → { ok:true, value:null }（deadline 可选）。建单 + schedule 共用。
  function normalizeDeadline(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    const s = String(raw).trim();
    if (!s) return { ok: true, value: null };   // 纯空格/空串 = 可选未填，放行（codex 14b M-1：trim 后判空，非判原始值）
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, value: null };
    // 真实日期校验：构造后回比对，挡 2026-02-30 / 2026-13-01 这类格式合法但日期非法的
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return { ok: false, value: null };
    return { ok: true, value: s };
  }

  // ============================================================
  // 二·四·五、sys 状态机串行化 mutex（C4.5，照 collab collabExporterTransitionMutex 范式 server.js:15203）
  //   背景：生产单 sqlite3 连接 parallel 模式下，并发请求的 BEGIN IMMEDIATE 会交错 → nested-transaction
  //     错误（非 SQLITE_BUSY，busy_timeout 不生效）→ 后到请求的 ROLLBACK 回滚先到请求进行中的事务 →
  //     先到请求退化 autocommit 部分提交脏态（collab e2e T18 复现 / server.js:15190-15191；C4 审 ultracode CONFIRMED）。
  //   方案：模块级单全局锁串行化「**所有** sys 事务点」（C2/C3/C3b/C4 的 BEGIN IMMEDIATE 全经 sysBeginImmediate）。
  //     ⚠️ **必须全模块覆盖**：半覆盖无效——未加锁端点的 BEGIN 仍会撞进已加锁端点的事务里制造同款脏态（C4 审 F 判定）。
  //   内网 ~10 人 + sys 写动作低频 + 锁内主流程 < 100ms，串行化开销可忽略；5s 超时。
  //   ⚠️ cluster：仅 PM2 单实例有效，多实例需改 DB 级锁（与 collab mutex 同限制）。
  //   ⚠️ 跨模块（sys vs collab/correction 同连接）交错不在本锁范围（各模块独立锁，需全局 DB 锁才彻底，记 backlog）。
  //   单持有者不变量：mutex 串行化保证同一时刻至多一个 sys 事务持锁 → __sysTxnRelease 全局单变量安全（无并发持有者）。
  const sysTxnMutex = (() => {
    let locked = false;
    const waiters = [];
    function acquire(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const node = { resolve, timer: null, acquired: false };
        if (!locked) { locked = true; node.acquired = true; return resolve(makeRelease(node)); }
        waiters.push(node);
        node.timer = setTimeout(() => {
          if (node.acquired) return;
          const idx = waiters.indexOf(node); if (idx >= 0) waiters.splice(idx, 1);
          const e = new Error('SYS_TXN_MUTEX_WAIT_TIMEOUT'); e.code = 'SYS_TXN_MUTEX_WAIT_TIMEOUT'; reject(e);
        }, timeoutMs);
      });
    }
    function makeRelease(node) {
      let released = false;
      return function release() {
        if (released) return; released = true;
        while (waiters.length > 0) {
          const next = waiters.shift();
          if (next.acquired) { logger.warn('[系统迭代 mutex] 不变量违反：waiter.acquired=true 仍在队列'); continue; }
          if (next.timer) clearTimeout(next.timer);
          next.acquired = true;
          return next.resolve(makeRelease(next));
        }
        locked = false;
      };
    }
    return { acquire };
  })();

  let __sysTxnRelease = null;   // 当前持锁事务的 release（单持有者不变量，mutex 串行化保证）
  function releaseSysTxn() { const r = __sysTxnRelease; __sysTxnRelease = null; if (r) r(); }
  // 取代 dbRunAsync('BEGIN IMMEDIATE')：先拿 mutex 串行化，再开事务；超时→SysTransitionError(503)；开事务失败→释放锁后抛原错。
  //   ⚠️ 锁在「成功 COMMIT」或「任一 ROLLBACK」时释放，故每个 sysBeginImmediate 必须有对应 sysCommit/sysRollback（既有结构已保证）。
  async function sysBeginImmediate() {
    let release;
    try { release = await sysTxnMutex.acquire(5000); }
    catch (e) { throw new SysTransitionError(503, 'SYS_BUSY', '系统繁忙（并发处理中），请稍后重试'); }
    __sysTxnRelease = release;
    try { await dbRunAsync('BEGIN IMMEDIATE'); }
    catch (e) { releaseSysTxn(); throw e; }
  }
  // 取代 dbRunAsync('COMMIT')：**成功提交后才释放锁**；提交失败不释放（throw 出去由调用方 catch 的 sysRollback 释放，
  //   杜绝"提交失败→释放锁→他请求抢锁开事务→本请求 catch 的 ROLLBACK 回滚他人事务"的空窗）。
  async function sysCommit() { await dbRunAsync('COMMIT'); releaseSysTxn(); }
  // 取代 dbRunAsync('ROLLBACK')：best-effort 回滚后**必释放锁**（idempotent：releaseSysTxn 对 null 无操作）。
  async function sysRollback() { try { await dbRunAsync('ROLLBACK'); } catch (_) { /* best-effort */ } releaseSysTxn(); }

  // 唯一允许写 sys_issues.status 的函数（H-2 铁律，照 correctionTransition）：
  //   事务内读真实 status + 流转合法性（查 transitions 常量）+ 双 WHERE（含 expectedFrom）守卫 changes≠1→409 +
  //   权限分流（roleGuard/ownerGuard）+ 闸门校验（requiredPayload）+ sideEffects 写入 + timeline 写入 + COMMIT。
  //   不改 status 的旁路动作（estimate/scope_change/reassign）不走本函数（端点单独事务，C2/C3）。
  //   actor = { id, name, role }；payload 按 action 携带闸门输入。成功返 { ok, fromStatus, toStatus }；
  //   业务/并发错误抛 SysTransitionError（endpoint 捕获转 HTTP）。
  async function sysIssueTransition(issueId, action, expectedFromStatus, actor, payload = {}, opts = {}) {
    await sysBeginImmediate();
    try {
      // R-6：事务内读 DB 真实状态作为 fromStatus（+ 权限/闸门用列）。
      const row = await dbGetAsync(
        `SELECT id, type, status, assigned_to, assigned_to_name, created_by, dev_estimated_at,
                first_submitted_at, reopen_count, return_count,
                needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm,
                feasibility_risk, blocked
           FROM sys_issues WHERE id = ?`,
        [issueId]
      );
      if (!row) throw new SysTransitionError(404, 'SYS_ISSUE_NOT_FOUND', '迭代单不存在');
      const fromStatus = row.status;
      const type = row.type;

      // [1] 查 transition 常量（type + action + fromStatus → 唯一 transition）
      const transition = T.findTransition(type, action, fromStatus);
      if (!transition) {
        throw new SysTransitionError(400, 'INVALID_TRANSITION', `「${type}」单在「${fromStatus}」态不能执行「${action}」`);
      }
      // 目标态解析（codex 15 M-1：动态目标态必须在事务内解析，杜绝 stale 并发读）：
      //   opts.resolveToStatusInTxn(row) 优先——resume 这类动态目标态（其常量 to=null 表示"动态解析"）
      //   在本事务内（BEGIN IMMEDIATE + 读到真实 row 之后）解析，与下方 UPDATE 原子化；
      //   回调返 null/抛 SysTransitionError 表示无法解析（如 timeline 缺暂缓事件）。否则用常量 resolveToStatus。
      let toStatus;
      if (typeof opts.resolveToStatusInTxn === 'function') {
        toStatus = await opts.resolveToStatusInTxn(row);
      } else {
        toStatus = T.resolveToStatus(transition, fromStatus);
      }
      if (toStatus === null || toStatus === undefined) {
        // to=null/undefined 且无动态解析 → 不改 status 的旁路动作（estimate/scope_change，端点独立处理），不应走本函数。
        throw new SysTransitionError(500, 'NOT_A_STATUS_TRANSITION', `动作「${action}」不改 status，不应走 sysIssueTransition`);
      }
      // 目标态须在该 type 合法状态集内（防常量配置错误 / resume 解析出非法态漏网）
      if (!(T.ALLOWED_STATUSES[type] || []).includes(toStatus)) {
        throw new SysTransitionError(500, 'INVALID_TARGET_STATUS', `非法目标状态：${toStatus}`);
      }

      // [2] expectedFromStatus 比对（防客户端传陈旧/错误前置状态）
      if (expectedFromStatus && fromStatus !== expectedFromStatus) {
        throw new SysTransitionError(409, 'CONCURRENT_STATE_CHANGE', '迭代单状态已变更，请刷新重试');
      }

      // [3] 权限校验（roleGuard / ownerGuard，§9 / T-M1 / RC-M5）
      //   ⚠️ codex 14 H-1：ownerGuard='assignee' **严格本人**（不放行 admin）——方案 §9 T-M1 明确 ownerGuard
      //   仅约束"开发本人"（estimate/submit 登录人=assigned_to）；admin 全能仅体现在 roleGuard 动作（验收/
      //   打回/排期/指派等任意 admin 可代办）。**不照搬 correction 的 isAdmin||isAssignee**（系统迭代收紧），
      //   否则 admin 代提交 → timeline 记 admin 提交却显示开发完成，质量统计失真（H-1 risk）。
      {
        const isAdmin = actor.role === 'admin';
        const isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
        let permitted = true;
        if (transition.roleGuard === 'admin' && !isAdmin) permitted = false;
        if (transition.ownerGuard === 'assignee' && !isAssignee) permitted = false;  // 严格本人，不放行 admin
        if (!permitted) throw new SysTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权执行此状态流转');
      }

      // [4] RC-M5 状态级不变量：进入开发后状态须有 assigned_to（avoid "已进流程却无开发负责人"）。
      const DEV_STATES = ['开发中', '待验证', '待上线', '已上线', '已关闭'];
      if (DEV_STATES.includes(toStatus)) {
        const willHaveAssignee = (payload.assigned_to !== undefined && payload.assigned_to !== null)
          ? parsePositiveId(payload.assigned_to)
          : Number(row.assigned_to) > 0;
        if (!willHaveAssignee) {
          throw new SysTransitionError(409, 'NO_ASSIGNEE_FOR_DEV_STATE', `进入「${toStatus}」前必须有开发负责人`);
        }
      }

      // [5] 业务闸门 + SET 片段（按 action 分支；本轮 C2 实现 schedule/assign，其余动作端点 C3+ 接，
      //   但 SET 片段在此一并实现，端点到位即可用）。
      const setFrags = [];
      const setParams = [];
      let summary = null;
      let timelineRoundNo = null;   // C3b：submit 写本轮交付轮次到 timeline.round_no（其余动作 NULL）

      switch (action) {
        case 'schedule': {
          // 排期：可选改 priority/deadline + 盖 priority_reviewed_at
          setFrags.push("priority_reviewed_at = datetime('now','localtime')");
          if (payload.priority !== undefined && payload.priority !== null && payload.priority !== '') {
            if (!['P0', 'P1', 'P2', 'P3'].includes(payload.priority)) {
              throw new SysTransitionError(400, 'INVALID_PRIORITY', '优先级仅 P0/P1/P2/P3');
            }
            setFrags.push('priority = ?'); setParams.push(payload.priority);
          }
          if (payload.deadline !== undefined && payload.deadline !== null && payload.deadline !== '') {
            const dl = normalizeDeadline(payload.deadline);   // codex 14 M-2
            if (!dl.ok) throw new SysTransitionError(400, 'INVALID_DEADLINE', '预期完成日期格式非法（应为 YYYY-MM-DD 真实日期）');
            setFrags.push('deadline = ?'); setParams.push(dl.value);
          }
          break;
        }
        case 'assign': {
          // 指派：写 assigned_to/_name/assigned_at（被指派人合法性由端点前置校验；DDL 无 assigned_by，codex 14b L-1）
          const devId = parsePositiveId(payload.assigned_to);
          if (!devId) throw new SysTransitionError(400, 'INVALID_ASSIGN_TARGET', '指派目标 ID 非法');
          setFrags.push('assigned_to = ?', 'assigned_to_name = ?', "assigned_at = datetime('now','localtime')");
          setParams.push(devId, payload.assigned_to_name || null);
          summary = payload.assigned_to_name ? `指派给 ${payload.assigned_to_name}` : null;
          break;
        }
        case 'submit': {
          // 提交闸门（§7）：交付说明 trim 非空 + dev_estimated_at 非空（端点 C3 接，骨架先备）
          const note = (typeof payload.summary === 'string' ? payload.summary.trim() : '');
          if (!note) throw new SysTransitionError(400, 'SUBMIT_SUMMARY_REQUIRED', '请填写交付说明');
          if (!row.dev_estimated_at) throw new SysTransitionError(400, 'ESTIMATE_REQUIRED', '请先回填预计完成时间');
          summary = note;
          // first_submitted_at 首次永不变（§3.5）
          if (!row.first_submitted_at) setFrags.push("first_submitted_at = datetime('now','localtime')");
          // ── 可行性评估闸门（F2a §3.3 / v1.7 §十九 ③⑤⑥）──────────
          //   codex 17 H-1：仅 type=feature/improvement + needs_feasibility=1 触发（bug/config 脏数据 needs_feasibility=1 不阻断，§19.1 不变量）。
          //   codex 17b M-2：闸门自校验完整性，不全信 feasibility 单入口（防脏数据/手工修库/未来入口绕过）。
          //   dev_estimated_at 已由上方通用闸门（ESTIMATE_REQUIRED）覆盖，此处不重复。
          //   ⭐ M-3（codex 20 + F2a M-1 + ultracode 三方同提接缝，本次彻底收敛）：blocked=1 拒绝提到 needs_feasibility 嵌套外——
          //     受阻单语义上就不该 submit（无论 needs_feasibility），读端自洽、不依赖「blocked=1⟹needs_feasibility=1」写端不变量，
          //     防 DB 脏数据 needs_feasibility=0+blocked=1 绕过。正常路径 needs_feasibility=0 单 blocked 恒 0（/blocked 端点 M-1 收口），移出零副作用。
          //     blocked 置最前 = 受阻是更高优先级「当前不可推进」信号（受阻+结论空时报 ISSUE_BLOCKED 而非 FEASIBILITY_REQUIRED 更准）。
          if (['feature', 'improvement'].includes(row.type)) {
            if (row.blocked === 1) {
              throw new SysTransitionError(400, 'ISSUE_BLOCKED', '该单已受阻，不能提交（请先解除受阻）');
            }
            // 评估完整性校验（仅 needs_feasibility=1 触发，§19.1）：codex 17b M-2 闸门自校验不全信单入口
            if (row.needs_feasibility === 1) {
              if (!row.feasibility_conclusion) {
                throw new SysTransitionError(400, 'FEASIBILITY_REQUIRED', '请先填写可行性评估');
              }
              // L-1（codex 19）：闸门自校验 conclusion 枚举，不全信 DDL CHECK（防旧表/手工修库非法值 + requirement_confirm 非空绕过）
              if (!['可行', '有条件可行', '不可行'].includes(row.feasibility_conclusion)) {
                throw new SysTransitionError(400, 'FEASIBILITY_REQUIRED', '可行性评估结论非法，请重新填写');
              }
              if (row.feasibility_conclusion === '不可行') {
                throw new SysTransitionError(400, 'FEASIBILITY_NOT_FEASIBLE', '评估为不可行，不能提交（请联系建单人处置）');
              }
              if (!(row.feasibility_requirement_confirm || '').trim()) {
                throw new SysTransitionError(400, 'FEASIBILITY_INCOMPLETE', '评估不完整：需求理解确认未填');
              }
              if (row.feasibility_conclusion === '有条件可行' && !(row.feasibility_risk || '').trim()) {
                throw new SysTransitionError(400, 'FEASIBILITY_RISK_REQUIRED', '有条件可行需填写风险与依赖');
              }
            }
          }
          // ── C3b：交付附件绑定本轮 round_no（11-H2 / RC-M4 / 核实#11）──────────
          //   round_no 序列 = 历史 submit 事件 round_no 的 MAX+1（U-2 取数口径同源：event_type='submit' AND round_no IS NOT NULL，A8 补 NOT NULL 与口径逐字一致）。
          //   先经 /attachments 上传的 delivery（round_no=NULL 暂存）→ 本次 submit 传 id 绑定。
          //   ⚠️ 判断①（SSOT 11-H2/RC-M4）：仅 **delivery** 按轮绑定+渲染；screenshot/spec 为松散附件 round_no 恒 NULL（不擅自扩模型）。
          //   二次 WHERE（12-M1 防误绑）：本次 id ∩ 本单 ∩ 上传本人 ∩ attachment_type='delivery' ∩ round_no IS NULL ∩ active；
          //   changes≠ids.length → 400，整事务 ROLLBACK 解绑（= orphan 回滚，附件留 round_no=NULL 待重提）。
          const roundRow = await dbGetAsync(
            `SELECT COALESCE(MAX(round_no), 0) + 1 AS next FROM sys_issue_timeline WHERE issue_id = ? AND event_type = 'submit' AND round_no IS NOT NULL`,
            [issueId]
          );
          timelineRoundNo = (roundRow && roundRow.next) ? roundRow.next : 1;
          // A2（codex C-M1）：attachment_ids 严格校验——传了但非数组 / 含非正整数项 → 400（不静默丢弃，暴露调用方错误）
          if (payload.attachment_ids !== undefined && payload.attachment_ids !== null) {
            if (!Array.isArray(payload.attachment_ids)) throw new SysTransitionError(400, 'SUBMIT_ATTACHMENT_INVALID', 'attachment_ids 须为数组');
            for (const raw of payload.attachment_ids) {
              if (!parsePositiveId(raw)) throw new SysTransitionError(400, 'SUBMIT_ATTACHMENT_INVALID', '交付附件 id 非法');
            }
          }
          const rawAttIds = Array.isArray(payload.attachment_ids) ? payload.attachment_ids : [];
          const attIds = [...new Set(rawAttIds.map(parsePositiveId))];   // 上方已校验全为正整数，map 无 null
          if (attIds.length > 0) {
            const ph = attIds.map(() => '?').join(',');
            const bind = await dbRunAsync(
              `UPDATE sys_issue_attachments SET round_no = ?
                 WHERE id IN (${ph}) AND issue_id = ? AND uploaded_by = ?
                   AND attachment_type = 'delivery' AND round_no IS NULL AND status = 'active'`,
              [timelineRoundNo, ...attIds, issueId, Number(actor.id)]
            );
            if (!bind || bind.changes !== attIds.length) {
              throw new SysTransitionError(400, 'SUBMIT_ATTACHMENT_INVALID', '提交的交付附件无效或已绑定，请刷新后重试');
            }
          }
          break;
        }
        case 'accept': {
          setFrags.push("accepted_at = datetime('now','localtime')");
          break;
        }
        case 'return': {
          // 验收打回（U-2 return_count++ + T-M2 清 dev_estimated_at）
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'RETURN_REASON_REQUIRED', '请填写打回原因');
          summary = reason;
          setFrags.push('return_count = return_count + 1', 'dev_estimated_at = NULL',
            ...SYS_CLEAR_FEASIBILITY_FIELDS_SQL);   // F2a §六：打回=新一轮，清评估+blocked
          break;
        }
        case 'close': {
          setFrags.push("closed_at = datetime('now','localtime')");
          break;
        }
        case 'reopen': {
          // 重开（§3.5）：reopen_count++ + 清时间戳（first_submitted_at 永不变）
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'REOPEN_REASON_REQUIRED', '请填写重开原因');
          summary = reason;
          setFrags.push(
            'reopen_count = reopen_count + 1',
            "reopened_at = datetime('now','localtime')",
            'accepted_at = NULL', 'released_at = NULL', 'closed_at = NULL',
            'release_id = NULL', 'dev_estimated_at = NULL',
            ...SYS_CLEAR_FEASIBILITY_FIELDS_SQL   // F2a §六：重开=新一轮，清评估+blocked
          );
          break;
        }
        case 'issue_reject':
        case 'reactivate': {
          // F2a §六枚举核对：两动作均不清评估+blocked——
          //   issue_reject（待评估→已拒绝）从未进开发轮，评估恒 NULL；
          //   reactivate（已拒绝→待评估）回初始态，"已拒绝"仅由 issue_reject 从"待评估"而来（从未指派/开发），评估恒 NULL，清空无意义。
          //   后续 reactivate→待评估→schedule→assign 进开发是首轮空态，无残留。
          //   ⚠️ TODO（ultracode 对抗审）：该「不清」正确性依赖当前转移图「无 开发态/终态 → 已拒绝/待评估 的回路」。
          //     追加 bug/config 流时若新增此类回路，reactivate/issue_reject 须改为复用 SYS_CLEAR_FEASIBILITY_FIELDS_SQL，否则残留评估跨轮带过去。
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'REASON_REQUIRED', '请填写原因');
          summary = reason;
          break;
        }
        case 'void': {
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'VOID_REASON_REQUIRED', '请填写作废原因');
          summary = reason;
          // F2b 修（ultracode）：作废 blocked 单清受阻三件套（§⑥ 处置后清 blocked，不动评估——作废非新一轮，评估留作问责）
          setFrags.push(...SYS_CLEAR_BLOCKED_FIELDS_SQL);
          break;
        }
        case 'hold': {
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'HOLD_REASON_REQUIRED', '请填写暂缓原因');
          summary = reason;
          // F2b 修（ultracode）：暂缓 blocked 单清受阻三件套（§⑥ 暂缓即解除受阻，resume 回开发中不残留 blocked 致卡死；不动评估）
          setFrags.push(...SYS_CLEAR_BLOCKED_FIELDS_SQL);
          break;
        }
        default:
          // publish 走 publishReleaseTransition（C4），不经此函数；其余未列动作走通用（无闸门）。
          break;
      }

      // [6] 双条件 WHERE 守卫（status = 事务内读到的真实 fromStatus）+ changes≠1→409（乐观锁）
      const setClause = ['status = ?', "updated_at = datetime('now','localtime')", ...setFrags].join(', ');
      const upd = await dbRunAsync(
        `UPDATE sys_issues SET ${setClause} WHERE id = ? AND status = ?`,
        [toStatus, ...setParams, issueId, fromStatus]
      );
      if (!upd || upd.changes !== 1) {
        throw new SysTransitionError(409, 'CONCURRENT_STATE_CHANGE', '迭代单状态已变更，请刷新重试');
      }

      // [7] timeline 写入（event_type + action_code 按 transition 常量，summary 按动作，round_no 仅 submit 非空 C3b）
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline
           (issue_id, event_type, from_status, to_status, summary, action_code, round_no, operator_id, operator_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, transition.timelineEvent, fromStatus, toStatus, summary, transition.actionCode || null, timelineRoundNo,
         Number(actor.id) || null, actor.name || null]
      );

      await sysCommit();
      return { ok: true, fromStatus, toStatus, notifyAfterCommit: transition.notifyAfterCommit || null };
    } catch (txErr) {
      try { await sysRollback(); } catch (_) { /* ignore */ }
      throw txErr;
    }
  }

  // endpoint catch 转 HTTP（对齐 corrections sendCorrectionTransitionError）。
  function sendSysTransitionError(res, e) {
    if (e instanceof SysTransitionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    logger.error('[系统迭代] sysIssueTransition 未预期错误:', e && e.message);
    return res.status(500).json({ error: (e && e.message) || '状态流转失败' });
  }

  // ============================================================
  // 三、router（C2：状态机端点 + 列表/详情 + meta + sys-systems）
  // ============================================================
  // ⚠️ 挂载（§1.3）：本 router 由 server.js `app.use('/api', router)` 挂载，未匹配请求 Express 自动 next()
  //   fall-through，不拦截其他 /api/*。所有 router 级中间件（auth/readiness）也只挂 /sys-* 前缀，
  //   禁裸 router.use(authenticateToken)（07-M2）；端点全部带 /sys- 前缀隔离。
  const router = express.Router();

  // C1 健康探针：仅用于 verify/部署确认 readiness 状态（带 /sys- 前缀，不污染其他 /api 路由）。
  router.get('/sys-issues/_readiness', authenticateToken, (req, res) => {
    res.json({ ready: SYS_SCHEMA_STATE.ready, error: SYS_SCHEMA_STATE.error });
  });

  // ── GET /sys-systems：被迭代业务系统字典（决策①，BIZ_SYSTEMS 常量）──────────
  router.get('/sys-systems', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.json({ items: T.BIZ_SYSTEMS });
  });

  // ── GET /sys-issues/meta：状态机只读视图（决策②，T-M4；前端 fetch 缓存渲染）──────────
  //   ⚠️ 顺序：/sys-issues/meta 必须在 /sys-issues/:id 之前注册，否则 'meta' 被 :id 捕获。
  router.get('/sys-issues/meta', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.json(T.buildMeta());
  });

  // ── POST /sys-issues：建单（admin；不带 multer，spec 附件走建单后两步，§12/方案 C）──────────
  //   建单不走 transition（无前置态），直接 INSERT + 写 created timeline，一个事务。
  router.post('/sys-issues', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    try {
      // 必填 + 枚举校验
      const type = (typeof b.type === 'string' ? b.type.trim() : '');
      if (!T.ALLOWED_STATUSES[type]) {
        // 本轮只放行变更流（feature/improvement）；bug/config 待追加（ALLOWED_STATUSES 无该 type）。
        return res.status(400).json({ error: '类型暂不支持（本期仅 feature/improvement）', code: 'TYPE_NOT_SUPPORTED', allowed: Object.keys(T.ALLOWED_STATUSES) });
      }
      const title = (typeof b.title === 'string' ? b.title.trim() : '');
      if (!title) return res.status(400).json({ error: '标题必填', code: 'TITLE_REQUIRED' });
      const systemName = (typeof b.system_name === 'string' ? b.system_name.trim() : '');
      if (!T.BIZ_SYSTEMS.includes(systemName)) {
        return res.status(400).json({ error: '所属系统非法', code: 'INVALID_SYSTEM_NAME', allowed: T.BIZ_SYSTEMS });
      }
      // source：native 建单必填三选一（不走 DEFAULT，T-M5）
      const source = (typeof b.source === 'string' ? b.source.trim() : '');
      if (!['业务方', '内部', '生产故障'].includes(source)) {
        return res.status(400).json({ error: '来源必填（业务方/内部/生产故障）', code: 'SOURCE_REQUIRED', allowed: ['业务方', '内部', '生产故障'] });
      }
      const priority = (b.priority && ['P0', 'P1', 'P2', 'P3'].includes(b.priority)) ? b.priority : 'P2';
      // deadline 校验（codex 14 M-2）
      const dl = normalizeDeadline(b.deadline);
      if (!dl.ok) return res.status(400).json({ error: '预期完成日期格式非法（应为 YYYY-MM-DD 真实日期）', code: 'INVALID_DEADLINE' });
      const initialStatus = T.INITIAL_STATUS_BY_TYPE[type];   // feature/improvement → 待评估

      // needs_feasibility（F2a §4.5 / 开放④建单后锁定，无中途改入口）：仅 feature/improvement 可设 1；
      //   其他 type 传 1 拒绝（防 bug/config 误带评估）。当前 ALLOWED_STATUSES 仅放行 feature/improvement，
      //   此守卫为追加 bug/config 流时的前置防线。
      //   L-2（codex 19）：输入收窄——只认 1/'1'/true 为开、undefined/null/0/'0'/false/'' 为关，其他非空值显式 400
      //   （防 'true'/'yes'/2 等静默落 0 → 本应评估的单建成无需评估且锁定不可改，失败响亮不静默）。
      let needsFeasibility = 0;
      const rawNeedsFeas = b.needs_feasibility;
      const TRUTHY_NF = [1, '1', true];
      const FALSY_NF = [undefined, null, 0, '0', false, ''];
      if (TRUTHY_NF.includes(rawNeedsFeas)) {
        if (!['feature', 'improvement'].includes(type)) {
          return res.status(400).json({ error: '仅变更类（feature/improvement）可要求可行性评估', code: 'FEASIBILITY_NOT_APPLICABLE' });
        }
        needsFeasibility = 1;
      } else if (!FALSY_NF.includes(rawNeedsFeas)) {
        return res.status(400).json({ error: 'needs_feasibility 仅接受 0/1（布尔）', code: 'INVALID_NEEDS_FEASIBILITY' });
      }

      const actor = sysActor(req);
      let newId = null;
      await sysBeginImmediate();
      try {
        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline,
              needs_feasibility,
              created_by, created_by_name, record_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value,
           needsFeasibility,
           actor.id, actor.name]
        );
        newId = result.lastID;
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
          [newId, initialStatus, (typeof b.description === 'string' ? b.description.trim() : null) || '信息技术部建单', actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.status(201).json({ id: newId, type, status: initialStatus });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 建单失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '建单失败' });
    }
  });

  // ── POST /sys-issues/:id/schedule：排期（待评估 → 已排期，admin）──────────
  router.post('/sys-issues/:id/schedule', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const r = await sysIssueTransition(id, 'schedule', '待评估', sysActor(req), req.body || {});
      res.json({ id, status: r.toStatus });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/assign：指派（已排期 → 开发中，admin，被指派人非 viewer）──────────
  router.post('/sys-issues/:id/assign', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const devId = parsePositiveId((req.body || {}).assigned_to);
      if (!devId) return res.status(400).json({ error: '必须指定被指派开发', code: 'ASSIGN_TARGET_REQUIRED' });
      // 被指派人存在 + 非 viewer（§3.6 闸门）
      const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [devId]);
      if (!dev) return res.status(400).json({ error: '指派目标用户不存在', code: 'ASSIGN_TARGET_NOT_FOUND' });
      if (dev.role === 'viewer') return res.status(400).json({ error: '不能指派给查看者（viewer）', code: 'ASSIGN_TARGET_VIEWER' });
      const devName = dev.display_name || dev.username || `user#${dev.id}`;
      const r = await sysIssueTransition(id, 'assign', '已排期', sysActor(req),
        { assigned_to: dev.id, assigned_to_name: devName });
      await dispatchSysNotify(id, r.notifyAfterCommit);   // notifyAssignedDeveloper → 通知新开发（dev 侧，best-effort）
      res.json({ id, assigned_to: dev.id, assigned_to_name: devName, status: r.toStatus });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/reassign：改派（开发中/待验证 → 开发中，admin，照 correction v1.85.0 L-R）──────────
  //   ⚠️ 不走 sysIssueTransition（语义上状态可能不变=同态换人）；独立事务 + 乐观锁绑 oldAssignedTo + status。
  router.post('/sys-issues/:id/reassign', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const newDevId = parsePositiveId((req.body || {}).newAssignedTo);
      if (!newDevId) return res.status(400).json({ error: '必须指定新开发', code: 'REASSIGN_TARGET_REQUIRED' });
      const oldAssignedTo = parsePositiveId((req.body || {}).oldAssignedTo);
      if (!oldAssignedTo) return res.status(400).json({ error: '必须传当前开发（乐观锁）', code: 'REASSIGN_OLD_REQUIRED' });
      const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
      if (!reason) return res.status(400).json({ error: '改派原因必填', code: 'REASSIGN_REASON_REQUIRED' });
      if (reason.length > 500) return res.status(400).json({ error: '改派原因不超过 500 字', code: 'REASSIGN_REASON_TOO_LONG' });
      // 新开发存在 + 非 viewer
      const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [newDevId]);
      if (!dev) return res.status(400).json({ error: '改派目标用户不存在', code: 'REASSIGN_TARGET_NOT_FOUND' });
      if (dev.role === 'viewer') return res.status(400).json({ error: '不能改派给查看者（viewer）', code: 'REASSIGN_TARGET_VIEWER' });
      const devName = dev.display_name || dev.username || `user#${dev.id}`;

      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // reassign 合法前置态（变更流：开发中/待验证）
        const t = T.findTransition(row.type, 'reassign', row.status);
        if (!t) { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可改派`, code: 'REASSIGN_STATUS_INVALID' }); }
        const toStatus = T.resolveToStatus(t, row.status);   // 待验证→开发中 / 开发中→开发中
        if (Number(row.assigned_to) === dev.id) { await sysRollback(); return res.status(400).json({ error: '新开发与当前开发相同，无需改派', code: 'REASSIGN_NO_CHANGE' }); }
        // 乐观锁：绑 status + oldAssignedTo；清 dev_estimated_at + 仅重置开发侧通知（05-L3）；return_count 不变（05-M2）
        const upd = await dbRunAsync(
          `UPDATE sys_issues
              SET status = ?, assigned_to = ?, assigned_to_name = ?, assigned_at = datetime('now','localtime'),
                  dev_estimated_at = NULL, ${SYS_CLEAR_FEASIBILITY_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime'),
                  notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL, notify_error = NULL, read_at = NULL
            WHERE id = ? AND status = ? AND assigned_to = ?`,
          [toStatus, dev.id, devName, id, row.status, oldAssignedTo]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_REASSIGN' }); }
        // reassign timeline（05-H1 独立 event_type；from/to/summary 必填）
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'reassign', ?, ?, ?, ?, ?)`,
          [id, row.status, toStatus, `改派 旧#${oldAssignedTo}→新#${dev.id}（${devName}）：${reason}`, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      await dispatchSysNotify(id, 'notifyAssignedDeveloper');   // 改派复用指派模板，发新开发（dev 侧，§8.1 06-M2；best-effort）
      res.json({ id, assigned_to: dev.id, assigned_to_name: devName });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 改派失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '改派失败' });
    }
  });

  // ── GET /sys-issues：列表（可见性 admin 全部 / 开发仅本人 / 其他 403，M-6）──────────
  router.get('/sys-issues', authenticateToken, requireSysSchemaReady, async (req, res) => {
    try {
      const role = req.user.role;
      const uid = Number(req.user.id);
      const isAdmin = role === 'admin';
      const where = [];
      const params = [];

      // 可见性（M-6）：admin 全部 / 开发只看 assigned_to=本人 / 其他登录用户不可见（返空，非 403——列表给空集）
      if (!isAdmin) {
        // 非 admin：仅自己被指派的单（开发）；其他角色 assigned_to 不会等于自己 → 自然空集
        where.push('assigned_to = ?');
        params.push(uid);
      }
      // 默认过滤作废（前端可传 include_voided=1，仅 admin 生效）
      const includeVoided = isAdmin && (req.query.include_voided === '1' || req.query.include_voided === 'true');
      if (!includeVoided) where.push("status != '已作废'");

      // 可选筛选（type/status/system/priority/release/assigned）
      const addEq = (col, val) => { if (val !== undefined && val !== null && val !== '') { where.push(`${col} = ?`); params.push(val); } };
      addEq('type', req.query.type);
      addEq('status', req.query.status);
      addEq('system_name', req.query.system);
      addEq('priority', req.query.priority);
      addEq('release_id', req.query.release ? parsePositiveId(req.query.release) : undefined);
      if (isAdmin) addEq('assigned_to', req.query.assigned ? parsePositiveId(req.query.assigned) : undefined);

      const rows = await dbAllAsync(
        `SELECT id, type, status, priority, title, system_name, module_name, source,
                assigned_to, assigned_to_name, dev_estimated_at, deadline,
                created_by, created_by_name, origin_issue_id, release_id,
                reopen_count, return_count, scope_changed, created_at, updated_at
           FROM sys_issues
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY id DESC`,
        params
      );
      res.json({ items: rows, total: rows.length });
    } catch (err) {
      logger.error('[系统迭代] 列表查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '列表查询失败' });
    }
  });

  // ── GET /sys-issues/:id：详情（主表 + timeline + 血缘正反向 + 附件；可见性校验）──────────
  router.get('/sys-issues/:id', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });

      // 可见性（M-6）：admin 看全部 / 开发本人（assigned_to）可见 / 其他 403。
      //   ⚠️ codex 14 M-1：**与列表读端同源**——列表非 admin 仅 assigned_to=本人，详情必须一致，
      //   故详情**不含 isCreator**（方案 §9 M-6 矩阵无"建单人可见"项；isCreator 会造成"列表看不到但能开详情"
      //   写读不一致，且 native 建单 requireAdmin → created_by 恒 admin，isCreator 对非 admin 永不成立=死代码+未来 import 风险）。
      const role = req.user.role, uid = Number(req.user.id);
      const isAdmin = role === 'admin';
      const isAssignee = Number(row.assigned_to) === uid && uid > 0;
      if (!isAdmin && !isAssignee) {
        return res.status(403).json({ error: '无权查看此迭代单', code: 'NOT_AUTHORIZED_TO_VIEW' });
      }
      if (row.status === '已作废' && !isAdmin) {
        return res.status(403).json({ error: '该迭代单已作废', code: 'SYS_ISSUE_VOIDED' });
      }

      // timeline（演进时间线，§5.3）
      const timeline = await dbAllAsync(
        `SELECT event_type, from_status, to_status, summary, action_code, ref_id, round_no,
                operator_id, operator_name, created_at
           FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id`,
        [id]
      );
      // 附件（delivery/screenshot/spec，仅 active）
      const attachments = await dbAllAsync(
        `SELECT id, attachment_type, round_no, file_name, original_name, file_size, mime_type,
                status, uploaded_by, uploaded_by_name, created_at
           FROM sys_issue_attachments WHERE issue_id = ? AND status = 'active' ORDER BY id`,
        [id]
      );
      // 血缘：正向（本单来源 origin_issue_id）+ 反向（已衍生出哪些单，M-2 反查）
      let originIssue = null;
      if (row.origin_issue_id) {
        originIssue = await dbGetAsync('SELECT id, title, type, system_name FROM sys_issues WHERE id = ?', [row.origin_issue_id]);
      }
      const derivedIssues = await dbAllAsync(
        'SELECT id, title, type, status, system_name FROM sys_issues WHERE origin_issue_id = ? ORDER BY id',
        [id]
      );

      // 12-M2（A7）：具名 spec 子集 + 布尔，使前端补传入口刷新不丢、不依赖临时前端状态
      const specAttachments = attachments.filter(a => a.attachment_type === 'spec');
      res.json({ issue: row, timeline, attachments, specAttachments, hasSpecAttachment: specAttachments.length > 0, origin_issue: originIssue, derived_issues: derivedIssues });
    } catch (err) {
      logger.error('[系统迭代] 详情查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '详情查询失败' });
    }
  });

  // ============================================================
  // 三·五、C3a：开发动作 + 旁路态端点（estimate/submit/accept/return/close/hold/resume/
  //   reactivate/issue_reject/void/reopen/scope_change/derive）。改 status 的走 sysIssueTransition 薄封装（H-2）。
  // ============================================================

  // 通用：标准 transition 薄封装（submit/accept/return/close/hold/reactivate/issue_reject/void/reopen）。
  //   端点只解析 id + 透传 body 给 sysIssueTransition（权限/闸门/流转都在 transition 内）。
  //   expectedFrom=null（不强制前置态比对，由 findTransition 的 from 白名单守；并发由双 WHERE changes 守）。
  function makeTransitionEndpoint(action) {
    return async (req, res) => {
      const id = parsePositiveId(req.params.id);
      if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
      try {
        const r = await sysIssueTransition(id, action, null, sysActor(req), req.body || {});
        // notifyAfterCommit：return→notifyReturnedToDeveloper（发 dev）/ reopen→notifyAssignedDeveloper（发 dev）/
        //   submit→notifySubmittedToAdmin（dispatch 内早返回不发）/ 其余 null（dispatch 早返回）。best-effort。
        await dispatchSysNotify(id, r.notifyAfterCommit);
        res.json({ id, status: r.toStatus, action });
      } catch (err) { sendSysTransitionError(res, err); }
    };
  }

  // 开发本人动作（submit）—— ownerGuard 严格本人在 transition 内校（codex 14 H-1）
  router.post('/sys-issues/:id/submit', authenticateToken, requireSysSchemaReady, makeTransitionEndpoint('submit'));
  // admin 动作
  router.post('/sys-issues/:id/accept', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('accept'));
  router.post('/sys-issues/:id/return', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('return'));
  router.post('/sys-issues/:id/close', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('close'));
  router.post('/sys-issues/:id/hold', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('hold'));
  router.post('/sys-issues/:id/reactivate', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reactivate'));
  router.post('/sys-issues/:id/issue-reject', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('issue_reject'));
  router.post('/sys-issues/:id/void', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('void'));
  router.post('/sys-issues/:id/reopen', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reopen'));

  // ── POST /sys-issues/:id/estimate：回填预计完成（开发本人，不改 status，旁路独立事务，§3.6/§7）──────────
  //   闸门：dev_estimated_at 格式合法 + >=assigned_at；ownerGuard 登录人=assigned_to（严格本人）。
  router.post('/sys-issues/:id/estimate', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const est = normalizeSysDatetime((req.body || {}).dev_estimated_at);
      if (!est) return res.status(400).json({ error: '预计完成时间格式非法（YYYY-MM-DD HH:MM）', code: 'INVALID_ESTIMATE' });
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to, assigned_at, needs_feasibility, dev_estimated_at FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // estimate 合法前置态（变更流：开发中）
        const t = T.findTransition(row.type, 'estimate', row.status);
        if (!t) { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可回填预计`, code: 'ESTIMATE_STATUS_INVALID' }); }
        // ownerGuard 严格本人（codex 14 H-1 同口径）
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAssignee) { await sysRollback(); return res.status(403).json({ error: '仅被指派开发本人可回填预计完成', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        // estimate 封口（codex 17 M-6 / 开放②）：needs_feasibility=1 且 feature/improvement → 预计完成只能在 /feasibility 写，
        //   防绕过评估口径 + 防主表 dev_estimated_at 与 feasibility timeline 快照不一致。needs_feasibility=0 仍走 estimate。
        if (['feature', 'improvement'].includes(row.type) && row.needs_feasibility === 1) {
          await sysRollback();
          return res.status(409).json({ error: '该单需先填可行性评估（预计完成在评估表单内一并提交）', code: 'ESTIMATE_REQUIRES_FEASIBILITY' });
        }
        // assigned_at 缺失保护（codex 15b L-1）：进开发态正常应有 assigned_at（assign 时写，RC-M5 同族）；
        //   import/人工修库可能造出"开发中但 assigned_at 空"的脏单，缺失则拒（防绕过 >=assigned_at 闸门）。
        const assignedMin = truncToMinute(row.assigned_at);
        if (!assignedMin) {
          await sysRollback(); return res.status(409).json({ error: '该单缺少指派时间（数据异常），无法回填预计完成', code: 'ASSIGNED_AT_MISSING' });
        }
        // >=assigned_at 校验（§7）：assigned_at 带秒（DB datetime），截到分钟比较（同分钟视为不早于，codex 15 M-2）。
        //   est 已是分钟级规范化串；两者皆 'YYYY-MM-DD HH:MM' 时字符串比较等价于时间先后比较。
        if (est < assignedMin) {
          await sysRollback(); return res.status(400).json({ error: '预计完成时间不能早于指派时间', code: 'ESTIMATE_BEFORE_ASSIGN' });
        }
        // §7 M-3 同分钟归一化 unchanged 零写入（复用 collab v1.90.0 范式，ultracode 审 #6）：
        //   新预计 == 现存（截分钟）→ 不写不留 timeline，且后续不触发需求方通知（避免同值重复回填重复推送业务方）。
        const curEstMin = truncToMinute(row.dev_estimated_at);
        if (curEstMin && curEstMin === est) {
          await sysRollback();
          return res.json({ id, dev_estimated_at: est, unchanged: true });
        }
        // 旁路 UPDATE（不改 status）+ 乐观锁绑 status+assigned_to
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET dev_estimated_at = ?, updated_at = datetime('now','localtime')
            WHERE id = ? AND status = ? AND assigned_to = ?`,
          [est, id, row.status, actor.id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_ESTIMATE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'estimate', ?, ?, ?)`,
          [id, est, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      await dispatchSysNotify(id, 'notifyEstimateToCreatorAndRequester');   // 仅发需求方侧；creator 侧本期 not_sent（M-4）；best-effort
      res.json({ id, dev_estimated_at: est });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 回填预计失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '回填预计失败' });
    }
  });

  // ── POST /sys-issues/:id/feasibility：填可行性评估（开发本人，不改 status，旁路独立事务，F2b §4.1 / v1.7 §十九）──────────
  //   闸门：conclusion 枚举 + requirement_confirm 非空 + dev_estimated_at 格式(>=assigned_at) + 有条件可行/不可行时 risk 必填；
  //   ownerGuard 本人；type 仅 feature/improvement；needs_feasibility=1（未勾选 409）；status='开发中'（M-3）；blocked=1 禁改（M-3' 409 ISSUE_BLOCKED）。
  router.post('/sys-issues/:id/feasibility', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const b = req.body || {};
      const conclusion = (typeof b.conclusion === 'string' ? b.conclusion.trim() : '');
      if (!['可行', '有条件可行', '不可行'].includes(conclusion)) {
        return res.status(400).json({ error: '可行性结论仅「可行/有条件可行/不可行」', code: 'INVALID_FEASIBILITY_CONCLUSION' });
      }
      const requirementConfirm = (typeof b.requirement_confirm === 'string' ? b.requirement_confirm.trim() : '');
      if (!requirementConfirm) return res.status(400).json({ error: '请填写需求理解确认', code: 'FEASIBILITY_REQUIREMENT_REQUIRED' });
      if (requirementConfirm.length > 500) return res.status(400).json({ error: '需求理解确认不超过 500 字', code: 'FEASIBILITY_REQUIREMENT_TOO_LONG' });   // ultracode：补长度上限对齐 reassign/scope_change 范式
      const risk = (typeof b.risk === 'string' ? b.risk.trim() : '');
      if (risk.length > 1000) return res.status(400).json({ error: '风险与依赖不超过 1000 字', code: 'FEASIBILITY_RISK_TOO_LONG' });
      // 有条件可行 / 不可行 需填风险与依赖（可行可不填，§十九）
      if ((conclusion === '有条件可行' || conclusion === '不可行') && !risk) {
        return res.status(400).json({ error: '「有条件可行/不可行」需填写风险与依赖', code: 'FEASIBILITY_RISK_REQUIRED' });
      }
      const est = normalizeSysDatetime(b.dev_estimated_at);
      if (!est) return res.status(400).json({ error: '预计完成时间格式非法（YYYY-MM-DD HH:MM）', code: 'INVALID_ESTIMATE' });
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to, assigned_at, needs_feasibility, blocked FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        if (!['feature', 'improvement'].includes(row.type)) { await sysRollback(); return res.status(409).json({ error: '仅变更类单据可填可行性评估', code: 'FEASIBILITY_NOT_APPLICABLE' }); }
        if (row.needs_feasibility !== 1) { await sysRollback(); return res.status(409).json({ error: '该单未要求可行性评估', code: 'FEASIBILITY_NOT_REQUIRED' }); }
        if (row.status !== '开发中') { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可填评估`, code: 'FEASIBILITY_STATUS_INVALID' }); }
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAssignee) { await sysRollback(); return res.status(403).json({ error: '仅被指派开发本人可填可行性评估', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        // blocked=1 禁改评估（codex 17b M-3，受阻要继续须先 unblock，保流程线性）
        if (row.blocked === 1) { await sysRollback(); return res.status(409).json({ error: '该单已受阻，请先解除受阻再填评估', code: 'ISSUE_BLOCKED' }); }
        // assigned_at 缺失保护 + >=assigned_at（同 estimate，dev_estimated_at 一并写入）
        const assignedMin = truncToMinute(row.assigned_at);
        if (!assignedMin) { await sysRollback(); return res.status(409).json({ error: '该单缺少指派时间（数据异常）', code: 'ASSIGNED_AT_MISSING' }); }
        if (est < assignedMin) { await sysRollback(); return res.status(400).json({ error: '预计完成时间不能早于指派时间', code: 'ESTIMATE_BEFORE_ASSIGN' }); }
        // 乐观锁绑 status='开发中' + assigned_to；UPDATE 评估字段 + dev_estimated_at
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET feasibility_conclusion = ?, feasibility_requirement_confirm = ?, feasibility_risk = ?,
                  dev_estimated_at = ?, updated_at = datetime('now','localtime')
            WHERE id = ? AND status = '开发中' AND assigned_to = ?`,
          [conclusion, requirementConfirm, risk || null, est, id, actor.id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_FEASIBILITY' }); }
        // feasibility timeline 快照（append-only 冻结，summary 拼结论/需求理解/风险/预计完成）
        const snapshot = `结论：${conclusion}｜需求理解：${requirementConfirm}｜风险：${risk || '无'}｜预计完成：${est}`;
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'feasibility', ?, ?, ?)`,
          [id, snapshot, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // §8.1「回填预计完成→需求方」（ultracode 审 #3）：needs_feasibility=1 单的 dev_estimated_at 只能经本端点写入
      //   （/estimate 被 ESTIMATE_REQUIRES_FEASIBILITY 闸门拒），若此处不派发，这一整类单的需求方永远收不到「预计完成」通知。
      //   口径：可行/有条件可行 → 工作推进，发需求方·预计完成（creator 侧 not_sent，同 estimate）；不可行 → 工作不推进，不发。
      if (conclusion === '可行' || conclusion === '有条件可行') {
        await dispatchSysNotify(id, 'notifyEstimateToCreatorAndRequester');
      }
      // 不可行结论：返回标记（前端提示联系建单人处置；不阻断本动作，阻断在 submit）
      res.json({ id, feasibility_conclusion: conclusion, not_feasible: conclusion === '不可行' });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 填可行性评估失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '填可行性评估失败' });
    }
  });

  // ── POST /sys-issues/:id/blocked：标记受阻（开发本人，不改 status，blocked=1，F2b §4.2）──────────
  //   reason 非空 + 开发本人 + status='开发中' + 重复 blocked 拒（M-4 防覆盖首次受阻证据）。
  //   ⭐ M-1 收口（codex 19 F2a 审）：仅 needs_feasibility=1 的 feature/improvement 单可受阻——守住「受阻归评估环节」不变量，
  //     否则 needs_feasibility=0 的受阻单会绕过 submit 评估闸门（submit 的 blocked 检查嵌在 needs_feasibility=1 内）。
  router.post('/sys-issues/:id/blocked', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
      if (!reason) return res.status(400).json({ error: '受阻原因必填', code: 'BLOCKED_REASON_REQUIRED' });
      if (reason.length > 500) return res.status(400).json({ error: '受阻原因不超过 500 字', code: 'BLOCKED_REASON_TOO_LONG' });
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to, needs_feasibility, blocked FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // M-1 收口：仅 feature/improvement + needs_feasibility=1 可受阻
        if (!['feature', 'improvement'].includes(row.type) || row.needs_feasibility !== 1) {
          await sysRollback(); return res.status(409).json({ error: '仅要求可行性评估的变更类单据可标记受阻', code: 'BLOCKED_NOT_APPLICABLE' });
        }
        if (row.status !== '开发中') { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可标记受阻`, code: 'BLOCKED_STATUS_INVALID' }); }
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAssignee) { await sysRollback(); return res.status(403).json({ error: '仅被指派开发本人可标记受阻', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        if (row.blocked === 1) { await sysRollback(); return res.status(409).json({ error: '该单已处于受阻状态', code: 'ISSUE_ALREADY_BLOCKED' }); }
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET blocked = 1, blocked_reason = ?, blocked_at = datetime('now','localtime'),
                  updated_at = datetime('now','localtime')
            WHERE id = ? AND status = '开发中' AND assigned_to = ? AND blocked = 0`,
          [reason, id, actor.id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_BLOCKED' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'blocked', ?, ?, ?)`,
          [id, reason, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, blocked: 1 });
      // notifyBlockedToAdmin：本期不发（收件人 admin=建单人本人，§8.1 admin 自身按需精简 + feedback_no_self_notify，用户 0630 拍板）；
      //   故此处不调 dispatchSysNotify（dispatch 对该 marker 亦早返回，调与不调等效，省一次空查）。受阻已写 blocked timeline + 站内可见。
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 标记受阻失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '标记受阻失败' });
    }
  });

  // ── POST /sys-issues/:id/unblock：解除受阻（admin，不改 status，blocked=0，F2b §4.3）──────────
  //   reason 非空 + admin + blocked=1 前置（M-7 NOT_BLOCKED）+ status='开发中'（防已关闭/作废后篡改处置轨迹）。
  //   清 blocked 三件套（blocked/reason/at），与各处置动作清理范围一致（ultracode 对抗审修正虚假注释）：
  //     reassign/return/reopen 换轮清（连评估一起，新一轮重评）；hold/void admin 处置清 blocked（留评估，§⑥）；
  //     close 对 blocked 单不可达（close from=已上线，blocked 单恒在开发中）；accept/estimate 对 blocked 单亦不可达。
  router.post('/sys-issues/:id/unblock', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
      if (!reason) return res.status(400).json({ error: '解除受阻原因必填', code: 'UNBLOCK_REASON_REQUIRED' });
      if (reason.length > 500) return res.status(400).json({ error: '解除受阻原因不超过 500 字', code: 'UNBLOCK_REASON_TOO_LONG' });
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, status, blocked FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        if (row.blocked !== 1) { await sysRollback(); return res.status(409).json({ error: '该单未处于受阻状态', code: 'NOT_BLOCKED' }); }
        if (row.status !== '开发中') { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可解除受阻`, code: 'UNBLOCK_STATUS_INVALID' }); }
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET ${SYS_CLEAR_BLOCKED_FIELDS_SQL.join(', ')}, updated_at = datetime('now','localtime')
            WHERE id = ? AND blocked = 1 AND status = '开发中'`,
          [id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_UNBLOCK' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'unblock', ?, ?, ?)`,
          [id, reason, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, blocked: 0 });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 解除受阻失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '解除受阻失败' });
    }
  });

  // ── POST /sys-issues/:id/resume：暂缓恢复（已暂缓 → 暂缓前活跃态，admin，H-1/RC-M2）──────────
  //   恢复目标 = timeline 中最近一条 to_status='已暂缓' 事件的 from_status（进入暂缓那刻的活跃态），
  //   校验属当前 type 合法活跃态（非终态/旁路态），查不到/不合法则 409。走 sysIssueTransition（expectedFrom='已暂缓'）。
  router.post('/sys-issues/:id/resume', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      // codex 15 M-1：暂缓前态解析挪进 sysIssueTransition 事务内（resolveToStatusInTxn 回调），
      //   与 UPDATE 原子化——杜绝"事务外读 holdEv → 另一请求 resume+再 hold → 本请求用 stale target 恢复"的并发错态。
      const ACTIVE_STATES = ['待评估', '已排期', '开发中', '待验证', '待上线'];   // 变更流活跃态（已上线/已关闭=终态，旁路态不在内）
      const resolveToStatusInTxn = async (row) => {
        // 此回调在 BEGIN IMMEDIATE + 读到真实 row（status 已守 expectedFrom='已暂缓'）之后、同事务内执行。
        const holdEv = await dbGetAsync(
          `SELECT from_status FROM sys_issue_timeline
            WHERE issue_id = ? AND event_type = 'status_change' AND action_code = 'hold' AND to_status = '已暂缓'
            ORDER BY id DESC LIMIT 1`,
          [row.id]
        );
        const target = holdEv && holdEv.from_status;
        if (!target) throw new SysTransitionError(409, 'RESUME_NO_PRIOR_STATUS', '无法定位暂缓前状态（timeline 缺暂缓事件）');
        // 校验 target 是当前 type 的合法【活跃态】（非终态/旁路态；防注入非法态）
        if (!ACTIVE_STATES.includes(target) || !(T.ALLOWED_STATUSES[row.type] || []).includes(target)) {
          throw new SysTransitionError(409, 'RESUME_TARGET_INVALID', `暂缓前状态「${target}」非合法活跃态，不可恢复`);
        }
        return target;
      };
      // sysIssueTransition 内 findTransition('resume', '已暂缓') 守前置态；expectedFrom='已暂缓' 双守；动态目标态事务内解析
      const r = await sysIssueTransition(id, 'resume', '已暂缓', sysActor(req), {}, { resolveToStatusInTxn });
      res.json({ id, status: r.toStatus });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/scope-change：范围变更（不改 status，写事件 + scope_changed=1，admin，§5.2）──────────
  router.post('/sys-issues/:id/scope-change', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const summary = (typeof (req.body || {}).summary === 'string' ? req.body.summary.trim() : '');
      if (!summary) return res.status(400).json({ error: '范围变更摘要必填', code: 'SCOPE_SUMMARY_REQUIRED' });
      if (summary.length > 1000) return res.status(400).json({ error: '范围变更摘要不超过 1000 字', code: 'SCOPE_SUMMARY_TOO_LONG' });
      // 可选改 deadline（旧值写入事件 summary 留痕，§5.2）。
      //   codex 15 M-3：先 trim 判空——空白字符串视为"未传/不改 deadline"，不进修改分支（防误清空原 deadline）。
      let dlValue;
      const rawDeadline = (req.body || {}).deadline;
      const trimmedDeadline = (rawDeadline === undefined || rawDeadline === null) ? '' : String(rawDeadline).trim();
      if (trimmedDeadline) {
        const dl = normalizeDeadline(trimmedDeadline);
        if (!dl.ok) return res.status(400).json({ error: '预期完成日期格式非法（YYYY-MM-DD 真实日期）', code: 'INVALID_DEADLINE' });
        dlValue = dl.value;
      }
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, deadline FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // F2a §4.4：feature/improvement 全禁范围变更（评估环节"禁开发态调需求"，v1.7 §十九 ⑦）——
        //   双保险：transitions.js 已移除 feature/improvement 的 scope_change 动作（findTransition 返 null），此处再加显式 type 守卫给明确错误码。
        //   config 流支持 scope_change（§18.9），追加时不受此守卫影响（仅拦 feature/improvement）。
        //   ⚠️ ultracode 对抗审：下方端点主体（findTransition/deadline 留痕/scope_changed=1/timeline）当前无任何 type 可达
        //     （config/bug 建单未放开 + feature/improvement 被本守卫前置拦截）——保留供 config 流复用，其内部逻辑（含 codex 15 M-3 空白 deadline 防误清）
        //     的端到端覆盖随 config 流追加时补回（verify-sys-flow [8] 已对应改写为仅验证 409 守卫）。
        if (['feature', 'improvement'].includes(row.type)) {
          await sysRollback();
          return res.status(409).json({ error: '变更类单据不支持范围变更，请改用「派生迭代」新建单或作废重开', code: 'SCOPE_CHANGE_DISABLED' });
        }
        // scope_change 合法前置态（变更流：开发中/待验证，§5.2）
        const t = T.findTransition(row.type, 'scope_change', row.status);
        if (!t) { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可范围变更`, code: 'SCOPE_STATUS_INVALID' }); }
        // deadline 改动留痕到 summary（旧→新）
        let evSummary = summary;
        const setFrags = ['scope_changed = 1'];
        const setParams = [];
        if (dlValue !== undefined && dlValue !== row.deadline) {
          evSummary += `（deadline ${row.deadline || '空'} → ${dlValue}）`;
          setFrags.push('deadline = ?'); setParams.push(dlValue);
        }
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET ${setFrags.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?`,
          [...setParams, id, row.status]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_SCOPE_CHANGE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'scope_change', ?, ?, ?)`,
          [id, evSummary, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, scope_changed: 1 });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 范围变更失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '范围变更失败' });
    }
  });

  // ── POST /sys-issues/:id/derive：派生迭代新单（admin，防环 M-1，§5.1）──────────
  //   原单任意态可派生；新单建立后写 created（初始态）+ derive（ref_id=原单 id），同事务、created 在前（T-L3）。
  const DERIVE_MAX_CHAIN_DEPTH = 50;   // 链深阈值（M-1 防环兜底）
  router.post('/sys-issues/:id/derive', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const originId = parsePositiveId(req.params.id);
    if (!originId) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    try {
      // 新单字段校验（同建单口径）
      const type = (typeof b.type === 'string' ? b.type.trim() : '');
      if (!T.ALLOWED_STATUSES[type]) return res.status(400).json({ error: '类型暂不支持（本期仅 feature/improvement）', code: 'TYPE_NOT_SUPPORTED', allowed: Object.keys(T.ALLOWED_STATUSES) });
      const title = (typeof b.title === 'string' ? b.title.trim() : '');
      if (!title) return res.status(400).json({ error: '标题必填', code: 'TITLE_REQUIRED' });
      const systemName = (typeof b.system_name === 'string' ? b.system_name.trim() : '');
      if (!T.BIZ_SYSTEMS.includes(systemName)) return res.status(400).json({ error: '所属系统非法', code: 'INVALID_SYSTEM_NAME', allowed: T.BIZ_SYSTEMS });
      const source = (typeof b.source === 'string' ? b.source.trim() : '');
      if (!['业务方', '内部', '生产故障'].includes(source)) return res.status(400).json({ error: '来源必填（业务方/内部/生产故障）', code: 'SOURCE_REQUIRED' });
      const priority = (b.priority && ['P0', 'P1', 'P2', 'P3'].includes(b.priority)) ? b.priority : 'P2';
      const dl = normalizeDeadline(b.deadline);
      if (!dl.ok) return res.status(400).json({ error: '预期完成日期格式非法', code: 'INVALID_DEADLINE' });
      const initialStatus = T.INITIAL_STATUS_BY_TYPE[type];

      const actor = sysActor(req);
      let newId = null;
      await sysBeginImmediate();
      try {
        // 原单须存在
        const origin = await dbGetAsync('SELECT id, origin_issue_id FROM sys_issues WHERE id = ?', [originId]);
        if (!origin) { await sysRollback(); return res.status(404).json({ error: '原单不存在', code: 'ORIGIN_NOT_FOUND' }); }
        // M-1 防环：沿 origin 链回溯，链深阈值 + 不成环（新单尚未建，故只回溯原单祖先链，确保有限）
        let cursor = origin.origin_issue_id, depth = 0;
        while (cursor) {
          if (Number(cursor) === Number(originId)) { await sysRollback(); return res.status(409).json({ error: '派生会形成血缘环', code: 'DERIVE_CYCLE' }); }
          if (++depth > DERIVE_MAX_CHAIN_DEPTH) { await sysRollback(); return res.status(409).json({ error: '血缘链过深（疑似异常）', code: 'DERIVE_CHAIN_TOO_DEEP' }); }
          const parent = await dbGetAsync('SELECT origin_issue_id FROM sys_issues WHERE id = ?', [cursor]);
          cursor = parent ? parent.origin_issue_id : null;
        }
        // 建新单（origin_issue_id = 原单 id）
        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline, origin_issue_id,
              created_by, created_by_name, record_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value, originId, actor.id, actor.name]
        );
        newId = result.lastID;
        // T-L3：先写 created（新单建立，to_status=初始态），再写 derive（ref_id=原单 id），同事务、created 在前
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
          [newId, initialStatus, `派生自 #${originId}`, actor.id, actor.name]
        );
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, ref_id, operator_id, operator_name)
           VALUES (?, 'derive', ?, ?, ?, ?)`,
          [newId, (typeof b.derive_note === 'string' ? b.derive_note.trim() : null) || `派生自 #${originId}`, originId, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.status(201).json({ id: newId, origin_issue_id: originId, type, status: initialStatus });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 派生失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '派生失败' });
    }
  });

  // ============================================================
  // 三·六、C3b：附件（上传 / 下载 / 删除）—— 复刻 corrections.js 范式（§6 / 核实#11 / 11-H2 / 12-M1 / §9 权限）
  //   落盘 uploads/sys-iteration/{id}/；multer 先落 _pending，handler 校验权限/状态通过后 persist 移正式目录 + INSERT。
  //   模型（11-H2）：delivery/screenshot 上传 round_no=NULL 暂存 → submit 事务绑 round_no（见 sysIssueTransition submit 分支）；
  //                 spec 需求材料 round_no=NULL 永不被 submit 绑（admin 两步建单上传，方案 C）。
  // ============================================================
  const SYS_UPLOAD_BASE = path.join(UPLOAD_DIR, 'sys-iteration');
  const SYS_PENDING_BASE = path.join(SYS_UPLOAD_BASE, '_pending');
  try { if (!fs.existsSync(SYS_UPLOAD_BASE)) fs.mkdirSync(SYS_UPLOAD_BASE, { recursive: true }); } catch (_) { /* 启动期 best-effort */ }
  // 扩展名白名单（spec=文档/表格/图片 + delivery 交付物 union；不含 zip/exe/可执行脚本/sql，避免任意落盘执行面）。
  const SYS_ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf',
    '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt', '.md'];
  const SYS_ATTACH_TYPES = ['delivery', 'screenshot', 'spec'];
  // A3（codex C-M3）：原始文件名规范化——去 C0 控制字符/换行 + trim + 截长（保扩展名）+ 空回退；
  //   入库 original_name + 下载名都用规范化值，杜绝响应头兼容/日志污染/前端展示风险。
  function sanitizeSysOriginalName(raw) {
    let s = String(raw || '').replace(/[\x00-\x1F\x7F]/g, '').trim();   // eslint-disable-line no-control-regex
    if (s.length > 180) {
      const ext = path.extname(s);
      s = s.slice(0, Math.max(1, 180 - ext.length)) + ext;
    }
    return s || 'attachment';
  }
  const sysStorage = multer.diskStorage({
    destination: function (req, file, cb) {
      // 纵深防御（对齐 corrections 1858）：destination 不信任 req.params.id，非正整数直接 cb(error)。
      const reqId = req.params.id;
      if (!/^[1-9]\d*$/.test(String(reqId))) return cb(new Error('非法迭代单 id'));
      const targetDir = path.join(SYS_PENDING_BASE, String(reqId));
      try { fs.mkdirSync(targetDir, { recursive: true }); cb(null, targetDir); } catch (e) { cb(e); }
    },
    filename: function (req, file, cb) {
      file.originalname = sanitizeSysOriginalName(Buffer.from(file.originalname, 'latin1').toString('utf8'));   // 中文名乱码修复 + A3 规范化
      const ts = Date.now();
      const rand = Math.round(Math.random() * 1e9);
      const safeOriginal = file.originalname.replace(/[\\/:*?"<>|]/g, '_');
      cb(null, `${ts}_${rand}_${safeOriginal}`);
    }
  });
  const sysUpload = multer({
    storage: sysStorage,
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },   // 单文件 20MB，单次最多 5 个
    fileFilter: function (req, file, cb) {
      const ext = normalizeAttachmentExt(file.originalname);
      if (!ext) return cb(new Error('文件名为空或包含非法字符'));
      if (!SYS_ALLOWED_EXTS.includes(ext)) return cb(new Error(`不支持的扩展名 ${ext}，仅允许 ${SYS_ALLOWED_EXTS.join('/')}`));
      cb(null, true);
    }
  });
  // id 前置守卫（必须在 multer 之前，对齐 corrections correctionIdGuard）
  function sysIdGuard(req, res, next) {
    if (!parsePositiveId(req.params.id)) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    next();
  }
  // multer 错误 → JSON 包装（MulterError 走 Express error flow，handler try/catch 接不到，故手动 invoke + 清理）
  function sysUploadMw(field, maxCount) {
    return (req, res, next) => {
      sysUpload.array(field, maxCount)(req, res, (err) => {
        if (!err) return next();
        const isMulterErr = err && err.name === 'MulterError';
        const code = isMulterErr ? err.code : 'UPLOAD_ERROR';
        try { sysCleanupOrphanFiles(req, req.params.id); } catch (_) { /* ignore */ }
        logger.warn(`[系统迭代-attach] multer error: code=${code} msg=${err.message}`);
        return res.status(400).json({ error: '上传文件失败', code, detail: isMulterErr ? err.message : (err.message || '上传过程异常') });
      });
    };
  }
  // _pending → uploads/sys-iteration/{id}/ + INSERT，返回 [{id,...}]。round_no 传 null（暂存/spec）。任一步失败内部 best-effort 回滚。
  //   F1（C4.5 审 CONFIRMED）：INSERT 纳入 sysBeginImmediate 事务 → 经 sysTxnMutex 与状态机事务同锁串行化，
  //     杜绝 autocommit INSERT 落进他人已开事务被一起回滚的脏态（"全模块覆盖"=DB 写全串行，非仅 15 状态机点）。
  //     文件 renameSync 在锁内（≤5 个，metadata 级，<100ms）；失败走事务 ROLLBACK 撤 INSERT + unlink 文件（无需手工 DELETE）。
  async function sysPersistAttachments(issueId, files, attachmentType, roundNo, uploader) {
    const finalDir = path.join(SYS_UPLOAD_BASE, String(issueId));
    fs.mkdirSync(finalDir, { recursive: true });
    const inserted = [];
    const movedPaths = [];
    await sysBeginImmediate();
    try {
      for (const f of files) {
        const finalName = f.filename;
        const finalPath = path.join(finalDir, finalName);
        fs.renameSync(f.path, finalPath);
        movedPaths.push(finalPath);
        const relPath = path.join('sys-iteration', String(issueId), finalName).replace(/\\/g, '/');   // 相对 UPLOAD_DIR（下载经 ALLOWED_FILE_DIRS 白名单）
        const fileSize = (typeof f.size === 'number') ? f.size : null;
        const mimeType = (typeof f.mimetype === 'string' && f.mimetype.trim()) ? f.mimetype : null;
        const r = await dbRunAsync(
          `INSERT INTO sys_issue_attachments
             (issue_id, attachment_type, round_no, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [issueId, attachmentType, roundNo, relPath, f.originalname, fileSize, mimeType, uploader.id, uploader.name]
        );
        inserted.push({ id: r.lastID, attachment_type: attachmentType, round_no: roundNo, file_name: relPath, original_name: f.originalname, file_size: fileSize, mime_type: mimeType });
      }
      await sysCommit();
      return inserted;
    } catch (e) {
      try { await sysRollback(); } catch (_) { /* 事务 ROLLBACK 撤本次 INSERT */ }
      for (const p of movedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
      throw e;
    }
  }
  // 旁路校验失败时回滚本次已落库附件（DELETE 行 + 删文件，走 ALLOWED_FILE_DIRS 白名单）。
  //   F1（C4.5 审）：DELETE 纳入 mutex 事务（与 persist/状态机同锁串行化）。
  //   F1 二轮（附件段快审 CONFIRMED）：**全 best-effort，绝不向外抛**——sysBeginImmediate 在 try 内、acquire 超时(SYS_BUSY)
  //     与 DELETE 失败都吞掉。否则上传 outer catch 在 F2 guard 之前 await 本函数，抛错会逃出 catch → 请求挂死无响应（raw async handler 无错误包装）。
  //   **物理删文件仅对「DB 确删的行（changes=1 且事务已提交）」**——否则事务回滚 / 行被并发绑定(round_no)或 superseded 时，
  //     行仍 active 却文件被删 → 下载 404 不一致。DELETE 带 `round_no IS NULL AND status='active'` 守卫（与主 DELETE 端点 A1 对称纵深；
  //     本次 persist 的行本恒满足，guard 仅在并发绑定/替换时跳过该行=不误删已成交付历史的行）。
  async function sysRollbackPersisted(persisted) {
    const list = (persisted || []);
    if (list.length === 0) return;
    let dbCommitted = false;
    const deletedIds = new Set();
    try {
      await sysBeginImmediate();
      try {
        for (const a of list) {
          const r = await dbRunAsync("DELETE FROM sys_issue_attachments WHERE id = ? AND round_no IS NULL AND status = 'active'", [a.id]);
          if (r && r.changes === 1) deletedIds.add(a.id);
        }
        await sysCommit();
        dbCommitted = true;
      } catch (e) {
        try { await sysRollback(); } catch (__) { /* ignore */ }
        logger.warn('[系统迭代] sysRollbackPersisted DELETE 失败，附件行保留 active: ' + (e && e.message));
      }
    } catch (acqErr) {
      logger.warn('[系统迭代] sysRollbackPersisted 获锁失败，跳过清理（行/文件保留）: ' + (acqErr && acqErr.message));
    }
    if (dbCommitted) {   // 仅删「确已从 DB 删除的行」的文件，杜绝 active 行指向缺失文件
      for (const a of list) { if (deletedIds.has(a.id)) { try { safeDeleteFileSync(a.file_name, UPLOAD_DIR); } catch (_) {} } }
    }
  }
  // 清本次 _pending 残留（handler 校验失败/未移动时调；10-M2 命名 cleanupOrphanFiles，仅指 multer 临时文件，非 DB 暂存态）
  function sysCleanupOrphanFiles(req, issueId) {
    const files = Array.isArray(req.files) ? req.files : [];
    for (const f of files) { try { if (f && f.path) fs.unlinkSync(f.path); } catch (_) {} }
    if (issueId && /^[1-9]\d*$/.test(String(issueId))) { try { fs.rmdirSync(path.join(SYS_PENDING_BASE, String(issueId))); } catch (_) {} }
  }

  // ── POST /sys-issues/:id/attachments：上传（delivery/screenshot=开发本人·开发中 / spec=admin·非作废）──────────
  router.post('/sys-issues/:id/attachments', authenticateToken, requireSysSchemaReady, sysIdGuard, sysUploadMw('files', 5), async (req, res) => {
    const id = parsePositiveId(req.params.id);
    let persisted = [];   // 提升到 handler 作用域，catch 才能回滚（对齐 corrections M-1）
    try {
      const rawType = (req.body && typeof req.body.attachment_type === 'string') ? req.body.attachment_type.trim() : '';
      const attachmentType = rawType || 'delivery';
      if (!SYS_ATTACH_TYPES.includes(attachmentType)) {
        sysCleanupOrphanFiles(req, id);
        return res.status(400).json({ error: 'attachment_type 非法（仅 delivery|screenshot|spec）', code: 'INVALID_ATTACHMENT_TYPE' });
      }
      const row = await dbGetAsync('SELECT id, status, assigned_to FROM sys_issues WHERE id = ?', [id]);
      if (!row) { sysCleanupOrphanFiles(req, id); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
      const actor = sysActor(req);
      const isAdmin = actor.role === 'admin';
      const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
      const files = Array.isArray(req.files) ? req.files : [];

      if (attachmentType === 'spec') {
        // 需求材料（09-L2 仅 admin；非作废态可补传；round_no=NULL 永不被 submit 绑，11-H2）
        if (!isAdmin) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '需求材料仅 admin 可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
        if (row.status === '已作废') { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '已作废单不可上传需求材料', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
        if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
        const supersedeId = parsePositiveId((req.body || {}).supersede_id);   // 可选替换（10-M1 supersede 留痕）
        persisted = await sysPersistAttachments(id, files, 'spec', null, actor);
        // TOCTOU 二次守卫：persist 后重读状态仍非作废（校验→INSERT 间被作废则回滚）
        const recheck = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
        if (!recheck || recheck.status === '已作废') {
          await sysRollbackPersisted(persisted); persisted = [];
          return res.status(409).json({ error: '迭代单状态已变更，上传已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
        }
        // 替换：旧 spec 标 superseded（12-M1 二次 WHERE：id + issue_id + attachment_type='spec' + active）+ note 留痕。
        //   A4：supersede UPDATE + note 包进事务——半成品（UPDATE 成功 note 失败）整体回滚 + 走外层 catch 删新 spec（替换整体失败，旧件保持 active，无"新旧都没了"窗口）。
        //   软信号：supersedeId 命中 → superseded=true；不命中（非本单/非 spec/非 active）→ superseded=false（新 spec 仍保留，前端据此提示"替换目标无效"）。
        let superseded = false;
        if (supersedeId) {
          await sysBeginImmediate();
          try {
            const sup = await dbRunAsync(
              `UPDATE sys_issue_attachments SET status = 'superseded'
                 WHERE id = ? AND issue_id = ? AND attachment_type = 'spec' AND status = 'active'`,
              [supersedeId, id]
            );
            if (sup && sup.changes === 1) {
              await dbRunAsync(
                `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, ref_id, operator_id, operator_name)
                 VALUES (?, 'note', ?, ?, ?, ?)`,
                [id, `替换需求材料（旧附件 #${supersedeId} 留痕 superseded）`, (persisted[0] ? persisted[0].id : null), actor.id, actor.name]
              );
              superseded = true;
            }
            await sysCommit();
          } catch (supErr) {
            try { await sysRollback(); } catch (_) { /* ignore */ }
            throw supErr;
          }
        }
        logger.info(`用户 ${req.user.username} 为迭代单 #${id} 上传需求材料 ${persisted.length} 个${supersedeId ? `（替换 #${supersedeId}=${superseded}）` : ''}`);
        return res.json({ ok: true, id, attachment_type: 'spec', attachments: persisted, superseded });
      }

      // delivery / screenshot（开发交付物，11-H2）：仅被指派开发本人 + 开发中（round_no=NULL 暂存，submit 绑）
      if (!isAssignee) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '交付附件仅被指派开发本人可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
      if (row.status !== '开发中') { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '仅「开发中」可上传交付附件', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
      if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
      persisted = await sysPersistAttachments(id, files, attachmentType, null, actor);
      // TOCTOU 二次守卫：persist 后重读仍 开发中 且 assigned_to 未变（校验→INSERT 间被打回/作废/改派则回滚）
      const recheck = await dbGetAsync('SELECT status, assigned_to FROM sys_issues WHERE id = ?', [id]);
      if (!recheck || recheck.status !== '开发中' || Number(recheck.assigned_to) !== actor.id) {
        await sysRollbackPersisted(persisted); persisted = [];
        return res.status(409).json({ error: '迭代单状态已变更，上传已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
      }
      logger.info(`用户 ${req.user.username} 为迭代单 #${id} 上传${attachmentType === 'screenshot' ? '截图' : '交付物'} ${persisted.length} 个（round_no=NULL 暂存待 submit 绑）`);
      return res.json({ ok: true, id, attachment_type: attachmentType, attachments: persisted });
    } catch (e) {
      await sysRollbackPersisted(persisted);   // 异常分支回滚本次已落库附件防 orphan
      sysCleanupOrphanFiles(req, id);
      if (e instanceof SysTransitionError) return sendSysTransitionError(res, e);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 附件上传失败:', e && e.message);
      return res.status(500).json({ error: (e && e.message) || '附件上传失败' });
    } finally {
      // A6：persist 用 renameSync 把文件移出 _pending/{id} 后该目录空了——任何分支（成功/TOCTOU-409）都清空目录，防长跑堆积
      if (id) { try { fs.rmdirSync(path.join(SYS_PENDING_BASE, String(id))); } catch (_) { /* 非空/不存在则忽略 */ } }
    }
  });

  // ── GET /sys-issues/:id/attachments/:attId/download：下载（§9 权限 admin/指派开发 + ALLOWED_FILE_DIRS 白名单 + 二次 WHERE active）──
  router.get('/sys-issues/:id/attachments/:attId/download', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const attId = parsePositiveId(req.params.attId);
    if (!id || !attId) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT id, status, assigned_to FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const isAdmin = req.user.role === 'admin';
      const isAssignee = Number(row.assigned_to) === Number(req.user.id) && Number(req.user.id) > 0;
      if (!isAdmin && !isAssignee) return res.status(403).json({ error: '无权下载此附件', code: 'NOT_AUTHORIZED_TO_VIEW' });
      if (row.status === '已作废' && !isAdmin) return res.status(403).json({ error: '该迭代单已作废', code: 'SYS_ISSUE_VOIDED' });
      // 二次 WHERE：附件须属本单且 active
      const att = await dbGetAsync(
        `SELECT id, file_name, original_name FROM sys_issue_attachments WHERE id = ? AND issue_id = ? AND status = 'active'`,
        [attId, id]
      );
      if (!att) return res.status(404).json({ error: '附件不存在或已失效', code: 'SYS_ATTACHMENT_NOT_FOUND' });
      // A5 路径安全：file_name 相对 UPLOAD_DIR（'sys-iteration/{id}/{name}'），resolve 后须仍在**本模块子树** SYS_UPLOAD_BASE 内。
      //   收紧到子树（非整个 UPLOAD_DIR）：即便 DB 行被污染指向 uploads/ 下他模块文件也只命中 sys-iteration/；同时防 ../ 越界。
      //   SYS_UPLOAD_BASE 在 UPLOAD_DIR（∈ ALLOWED_FILE_DIRS）之下，满足 M-7 白名单目录读取（更严）。
      const sysBase = path.resolve(SYS_UPLOAD_BASE);
      const absPath = path.resolve(UPLOAD_DIR, att.file_name);
      const within = (absPath === sysBase) || absPath.startsWith(sysBase + path.sep);
      if (!within) {
        logger.warn(`[系统迭代] 下载路径越界拦截: ${att.file_name}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: '文件已丢失', code: 'FILE_NOT_FOUND' });
      return res.download(absPath, att.original_name || path.basename(absPath));
    } catch (err) {
      logger.error('[系统迭代] 附件下载失败:', err && err.message);
      return res.status(500).json({ error: (err && err.message) || '附件下载失败' });
    }
  });

  // ── DELETE /sys-issues/:id/attachments/:attId：删除（spec=admin 物理删 / delivery·screenshot 仅未绑 round_no NULL 由上传本人/admin）──
  //   12-M1 二次 WHERE：id + issue_id + attachment_type + status='active'；已绑 delivery（round_no NOT NULL）=交付历史不可删（留痕）。
  router.delete('/sys-issues/:id/attachments/:attId', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const attId = parsePositiveId(req.params.attId);
    if (!id || !attId) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT id FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const att = await dbGetAsync(
        `SELECT id, attachment_type, round_no, file_name, uploaded_by FROM sys_issue_attachments WHERE id = ? AND issue_id = ? AND status = 'active'`,
        [attId, id]
      );
      if (!att) return res.status(404).json({ error: '附件不存在或已失效', code: 'SYS_ATTACHMENT_NOT_FOUND' });
      const actor = sysActor(req);
      const isAdmin = actor.role === 'admin';
      if (att.attachment_type === 'spec') {
        if (!isAdmin) return res.status(403).json({ error: '需求材料仅 admin 可删除', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' });
      } else {
        // delivery/screenshot：已绑（round_no NOT NULL，已提交）=交付历史不可删；未绑由上传本人/admin 删
        if (att.round_no !== null && att.round_no !== undefined) {
          return res.status(409).json({ error: '已提交的交付附件不可删除', code: 'ATTACHMENT_BOUND_NOT_DELETABLE' });
        }
        const isUploader = Number(att.uploaded_by) === actor.id && actor.id > 0;
        if (!isAdmin && !isUploader) return res.status(403).json({ error: '无权删除此附件', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' });
      }
      // 物理删（12-M1 二次 WHERE，attachment_type 防 spec/delivery 暂存阶段误删）。
      //   A1（txn-MED）：非 spec 把"未绑"不变量下沉到 DELETE WHERE（round_no IS NULL）——闭合"SELECT 判定 → DELETE 之间被并发 submit 绑定 round_no"的 TOCTOU，
      //   届时 DELETE 命中 0 → 409（不会误删刚成为交付历史的附件）。spec 恒 NULL 不加此守卫。
      const roundGuardSql = att.attachment_type === 'spec' ? '' : ' AND round_no IS NULL';
      // F1（C4.5 审）：DELETE + timeline INSERT 纳入 mutex 事务（与状态机同锁串行化，杜绝落进他人事务被回滚）；
      //   物理删文件挪到 COMMIT 成功之后——杜绝"DB 回滚但文件已删→行复活成 active 却文件没了→下载 404"的不可逆脏态。
      await sysBeginImmediate();
      try {
        const del = await dbRunAsync(
          `DELETE FROM sys_issue_attachments WHERE id = ? AND issue_id = ? AND attachment_type = ?${roundGuardSql} AND status = 'active'`,
          [attId, id, att.attachment_type]
        );
        if (!del || del.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '附件状态已变更（可能刚被提交绑定），请刷新重试', code: 'SYS_ATTACHMENT_NOT_FOUND' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, ref_id, operator_id, operator_name)
           VALUES (?, 'note', ?, ?, ?, ?)`,
          [id, `删除${att.attachment_type === 'spec' ? '需求材料' : '交付附件'} #${attId}`, attId, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // COMMIT 成功后才物理删文件（DB 为准；删失败仅 best-effort 留 orphan 文件，无幽灵 active 行）
      try { safeDeleteFileSync(att.file_name, UPLOAD_DIR); } catch (_) { /* best effort */ }
      logger.info(`用户 ${req.user.username} 删除迭代单 #${id} 附件 #${attId}（${att.attachment_type}）`);
      return res.json({ ok: true, id, attachment_id: attId });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 附件删除失败:', err && err.message);
      return res.status(500).json({ error: (err && err.message) || '附件删除失败' });
    }
  });

  // ============================================================
  // 三·六、C4：上线批次（建/列表/详情/加删单 M-8/发布 H-3 原子性/hotfix 兜底，方案 §6）
  //   批次发布因跨表 + 批量，走专用 publishReleaseTransition（非 sysIssueTransition），
  //   但复用同一套状态校验 + timeline 写入规范（H-2）：BEGIN IMMEDIATE 拿写锁串行化 →
  //   校批次「计划中」→ 读组内 issue（≥1 且全「待上线」AND release_id=:id）→ 批量翻「已上线」校 changes →
  //   每单写 release timeline（ref_id=批次）→ 批次置「已发布」。RC-M3 事务模式统一。
  //   config 不进批次（§6.1）：加单 type 白名单 + DB CHECK(type<>'config' OR release_id IS NULL) 双防。
  // ============================================================
  const SYS_RELEASE_NOTE_MAX = 1000;    // 上线说明长度上限（§7 闸门③）
  const SYS_VERSION_TAG_MAX = 100;      // 版本号长度上限
  const SYS_RELEASE_TITLE_MAX = 200;    // 批次说明长度上限
  const SYS_BATCH_ISSUE_MAX = 200;      // E（ultracode 安全）：单次加/移单元素数上限（防超大数组 DoS）
  const RELEASABLE_TYPES = ['bug', 'feature', 'improvement'];   // config 不进批次（§6.1）

  // 自动批次号 R-YYYYMMDD-N（N=当天最大数字后缀 + 1）。**须在 BEGIN IMMEDIATE 事务内调用**。
  //   A（codex M-1 + ultracode CONFIRMED）：用 **MAX(数字后缀)+1**，**不用 COUNT+1**——
  //   手填 release_no 与自动号共用 R-日期-N 命名空间，若手填了一个落在自动空间的跳号（如 R-日期-3），
  //   COUNT+1 会算出已被占用的号 → 撞 UNIQUE → 自动建批次卡死（重试 COUNT 不变反复撞同一号）。
  //   MAX(后缀)+1 始终大于任何已存在的严格形态号，杜绝该碰撞；UNIQUE 约束仍为极端竞态兜底。
  //   只认「R-日期-纯数字」严格形态参与 MAX（异形态手填号如 V-xxx 不干扰）。
  async function nextReleaseNo() {
    const today = await dbGetAsync("SELECT strftime('%Y%m%d', datetime('now','localtime')) AS ymd");
    const prefix = `R-${today.ymd}-`;
    const rows = await dbAllAsync('SELECT release_no FROM sys_releases WHERE release_no GLOB ?', [prefix + '[0-9]*']);
    const re = new RegExp('^R-' + today.ymd + '-(\\d+)$');   // 严格：前缀 + 纯数字后缀
    let maxSeq = 0;
    for (const r of rows) {
      const m = re.exec(r.release_no);
      if (m) { const n = Number(m[1]); if (n > maxSeq) maxSeq = n; }
    }
    return prefix + (maxSeq + 1);
  }

  // 事务内发布核心（**假定调用方已 BEGIN IMMEDIATE**，本函数不 begin/commit/rollback）。
  //   publish（攒批）与 hotfix（单条兜底）共用，杜绝两路逻辑漂移（§6.1 两路都产出批次记录）。
  //   payload.release_note / version_tag 非空时先落库（"填上线说明+版本 → 发布"单步），再校验最终值非空（闸门③ D7）。
  //   抛 SysTransitionError 由调用方 try/catch ROLLBACK + endpoint sendSysTransitionError 转 HTTP。
  async function _publishReleaseCoreInTxn(releaseId, actor, payload = {}) {
    const rel = await dbGetAsync('SELECT id, status, release_note, version_tag FROM sys_releases WHERE id = ?', [releaseId]);
    if (!rel) throw new SysTransitionError(404, 'RELEASE_NOT_FOUND', '上线批次不存在');
    if (rel.status !== '计划中') throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次非「计划中」，不能发布');

    // 闸门③（D7，§7）：release_note + version_tag trim 非空 + 长度上限。payload 覆盖优先（单步填+发布）。
    let releaseNote = (payload.release_note !== undefined && payload.release_note !== null) ? payload.release_note : rel.release_note;
    let versionTag = (payload.version_tag !== undefined && payload.version_tag !== null) ? payload.version_tag : rel.version_tag;
    releaseNote = (typeof releaseNote === 'string' ? releaseNote.trim() : '');
    versionTag = (typeof versionTag === 'string' ? versionTag.trim() : '');
    if (!releaseNote) throw new SysTransitionError(400, 'RELEASE_NOTE_REQUIRED', '请填写上线说明');
    if (!versionTag) throw new SysTransitionError(400, 'VERSION_TAG_REQUIRED', '请填写版本号');
    if (releaseNote.length > SYS_RELEASE_NOTE_MAX) throw new SysTransitionError(400, 'RELEASE_NOTE_TOO_LONG', `上线说明超长（≤${SYS_RELEASE_NOTE_MAX} 字）`);
    if (versionTag.length > SYS_VERSION_TAG_MAX) throw new SysTransitionError(400, 'VERSION_TAG_TOO_LONG', `版本号超长（≤${SYS_VERSION_TAG_MAX} 字）`);
    // 落库最终说明+版本（T-L1：只存批次表，issue 侧靠 release_id+timeline 引用；status='计划中' 二次守卫已由上方读保证）
    await dbRunAsync('UPDATE sys_releases SET release_note = ?, version_tag = ? WHERE id = ? AND status = ?',
      [releaseNote, versionTag, releaseId, '计划中']);

    // H-3 步骤2：读组内 issue，校 ≥1 且全「待上线」（add-issues 已守，此处防并发被移出/重开清空/混入非待上线）。
    const members = await dbAllAsync('SELECT id, status, type FROM sys_issues WHERE release_id = ?', [releaseId]);
    if (members.length === 0) throw new SysTransitionError(409, 'RELEASE_EMPTY', '批次内无待上线单，不能发布');
    const bad = members.find(m => m.status !== '待上线');
    if (bad) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_READY', `批次内 #${bad.id} 非「待上线」（当前「${bad.status}」），请先移除`);
    // B（codex M-2）：core 内再校成员 type∈可发布3类，与 add-issues 入口防线一致（纵深防脏库/旧表缺 CHECK/手工修库）。
    //   正常 schema 下 config 受 DB CHECK(type<>'config' OR release_id IS NULL) 永不可成为成员，此守卫为 schema 漂移兜底（对齐 submit 闸门"不全信单入口"哲学）。
    const badType = members.find(m => !RELEASABLE_TYPES.includes(m.type));
    if (badType) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_RELEASABLE', `批次内 #${badType.id} 类型不可发布（${badType.type}），请先移除`);
    const expected = members.length;

    // H-3 步骤3：批量翻「已上线」+ released_at，校 changes 等于预期数否则整体回滚 409。
    const flip = await dbRunAsync(
      "UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE release_id = ? AND status = '待上线'",
      [releaseId]
    );
    if (!flip || flip.changes !== expected) {
      throw new SysTransitionError(409, 'RELEASE_PUBLISH_CONFLICT', '批次内单状态已变更，请刷新重试');
    }

    // H-3 步骤4：每单写 release timeline（ref_id=批次 id，summary=上线说明）+ 批次置「已发布」。
    for (const m of members) {
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, ref_id, operator_id, operator_name)
         VALUES (?, 'release', '待上线', '已上线', ?, ?, ?, ?)`,
        [m.id, releaseNote, releaseId, Number(actor.id) || null, actor.name || null]
      );
    }
    const done = await dbRunAsync(
      "UPDATE sys_releases SET status = '已发布', released_at = datetime('now','localtime') WHERE id = ? AND status = '计划中'",
      [releaseId]
    );
    if (!done || done.changes !== 1) throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次状态已变更，请刷新重试');

    return { releaseId, releasedIssueIds: members.map(m => m.id), count: expected };
  }

  // 标准发布（攒批）：独立 BEGIN IMMEDIATE 事务包裹 core（§6.2 H-3）。
  async function publishReleaseTransition(releaseId, actor, payload = {}) {
    await sysBeginImmediate();
    try {
      const r = await _publishReleaseCoreInTxn(releaseId, actor, payload);
      await sysCommit();
      return { ok: true, ...r, notifyAfterCommit: 'notifyReleasedToRequester' };   // 通知 C5 落地（先提交再发，失败不回滚已发布）
    } catch (txErr) {
      try { await sysRollback(); } catch (_) { /* ignore */ }
      throw txErr;
    }
  }

  // ── POST /sys-releases：建批次（admin，落「计划中」；release_no 缺省自动 R-YYYYMMDD-N）──────────
  router.post('/sys-releases', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    try {
      const actor = sysActor(req);
      const title = (typeof b.title === 'string' ? b.title.trim() : '') || null;
      if (title && title.length > SYS_RELEASE_TITLE_MAX) return res.status(400).json({ error: '批次说明超长', code: 'RELEASE_TITLE_TOO_LONG' });
      const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '') || null;
      if (releaseNote && releaseNote.length > SYS_RELEASE_NOTE_MAX) return res.status(400).json({ error: '上线说明超长', code: 'RELEASE_NOTE_TOO_LONG' });
      const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '') || null;
      if (versionTag && versionTag.length > SYS_VERSION_TAG_MAX) return res.status(400).json({ error: '版本号超长', code: 'VERSION_TAG_TOO_LONG' });
      const pd = normalizeDeadline(b.planned_date);   // 复用日期校验（YYYY-MM-DD 真实日期 / 空可选）
      if (!pd.ok) return res.status(400).json({ error: '计划上线日期格式非法（应为 YYYY-MM-DD 真实日期）', code: 'INVALID_PLANNED_DATE' });
      const manualNo = (typeof b.release_no === 'string' ? b.release_no.trim() : '');
      if (manualNo && manualNo.length > SYS_VERSION_TAG_MAX) return res.status(400).json({ error: '批次号超长', code: 'RELEASE_NO_TOO_LONG' });

      let newId = null, releaseNo = null;
      await sysBeginImmediate();
      try {
        releaseNo = manualNo || await nextReleaseNo();   // 自动号在 IMMEDIATE 内生成防碰撞
        const result = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag, planned_date, created_by, created_by_name)
           VALUES (?, ?, '计划中', 0, ?, ?, ?, ?, ?)`,
          [releaseNo, title, releaseNote, versionTag, pd.value, actor.id, actor.name]
        );
        newId = result.lastID;
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        if (txErr && /UNIQUE/i.test(txErr.message || '')) return res.status(409).json({ error: '批次号已存在，请换一个', code: 'RELEASE_NO_DUP' });
        throw txErr;
      }
      res.status(201).json({ id: newId, release_no: releaseNo, status: '计划中' });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 建批次失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '建批次失败' });
    }
  });

  // ── GET /sys-releases：批次列表（admin；可选 status 筛选 + 含成员数）──────────
  router.get('/sys-releases', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    try {
      const where = [], params = [];
      if (req.query.status === '计划中' || req.query.status === '已发布') { where.push('r.status = ?'); params.push(req.query.status); }
      const rows = await dbAllAsync(
        `SELECT r.id, r.release_no, r.title, r.status, r.is_hotfix, r.release_note, r.version_tag,
                r.planned_date, r.released_at, r.created_by, r.created_by_name, r.created_at,
                (SELECT COUNT(*) FROM sys_issues i WHERE i.release_id = r.id) AS issue_count
           FROM sys_releases r
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY r.id DESC`,
        params
      );
      res.json({ items: rows, total: rows.length });
    } catch (err) {
      logger.error('[系统迭代] 批次列表失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次列表查询失败' });
    }
  });

  // ── GET /sys-releases/:id：批次详情（admin；批次 + 组内 issue 列表，供 C6 展示/挑单）──────────
  router.get('/sys-releases/:id', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    try {
      const rel = await dbGetAsync('SELECT * FROM sys_releases WHERE id = ?', [id]);
      if (!rel) return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' });
      const issues = await dbAllAsync(
        `SELECT id, type, status, priority, title, system_name, module_name, assigned_to_name
           FROM sys_issues WHERE release_id = ? ORDER BY id`,
        [id]
      );
      res.json({ release: rel, issues });
    } catch (err) {
      logger.error('[系统迭代] 批次详情失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次详情查询失败' });
    }
  });

  // ── POST /sys-releases/:id/add-issues：加单（admin，M-8 双 WHERE 原子全成或全败）──────────
  //   闸门：批次「计划中」+ 每单「待上线」AND release_id IS NULL AND type∈可发布3类（防多批次抢占/config 混入）。
  router.post('/sys-releases/:id/add-issues', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const raw = (req.body || {}).issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要加入的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });   // E（ultracode 安全）：元素数上限防 DoS
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    const typePh = RELEASABLE_TYPES.map(() => '?').join(',');
    try {
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync('SELECT id, status FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能加单', code: 'RELEASE_NOT_PLANNING' }); }
        for (const iid of issueIds) {
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime')
               WHERE id = ? AND status = '待上线' AND release_id IS NULL AND type IN (${typePh})`,
            [id, iid, ...RELEASABLE_TYPES]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${iid} 不可加入（须为未挂批次的「待上线」单且非配置类）`, code: 'ISSUE_NOT_ADDABLE', issue_id: iid });
          }
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, added: issueIds, count: issueIds.length });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 批次加单失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次加单失败' });
    }
  });

  // ── POST /sys-releases/:id/remove-issues：移除单（admin，M-8 双 WHERE 原子全成或全败）──────────
  //   闸门：批次「计划中」+ 每单 release_id=:id AND「待上线」；移除后清空 release_id。
  router.post('/sys-releases/:id/remove-issues', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const raw = (req.body || {}).issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要移除的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });   // E（ultracode 安全）：元素数上限防 DoS
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    try {
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync('SELECT id, status FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能移除', code: 'RELEASE_NOT_PLANNING' }); }
        for (const iid of issueIds) {
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_id = NULL, updated_at = datetime('now','localtime')
               WHERE id = ? AND release_id = ? AND status = '待上线'`,
            [iid, id]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${iid} 不在本批次或状态已变更`, code: 'ISSUE_NOT_REMOVABLE', issue_id: iid });
          }
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, removed: issueIds, count: issueIds.length });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 批次移除失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次移除失败' });
    }
  });

  // ── POST /sys-releases/:id/publish：发布（admin，H-3 原子性，走 publishReleaseTransition）──────────
  //   body 可选 release_note/version_tag（"填说明+版本→发布"单步）；闸门③ 在 core 内校最终值非空。
  router.post('/sys-releases/:id/publish', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    try {
      const r = await publishReleaseTransition(id, sysActor(req), req.body || {});
      const releasedIds = r.releasedIssueIds || [];
      // 批次通知逐单发需求方·已上线（§6.2：状态先提交成功）。ultracode 审 #4：批次可达 200 单（C4 上限），
      //   N 条钉钉网络发送串行 await 在响应前会阻塞 HTTP 响应至超时（504），而批次其实已发布成功。
      //   故先回响应，再**后台**逐单顺序 best-effort 派发（dispatch 内绝不抛 + record 进 mutex 串行化，不阻塞主响应）。
      // ⚠️ codex 审 M-2：此后台派发为**进程内非持久 best-effort**——PM2 重启/进程退出会丢未发完的通知，单据停在
      //   requester_notify_status='not_sent'/'failed'。补偿口径 = C6 前端按 not_sent/failed 筛出提供**手动补发**入口
      //   （对齐 issue-tracker 既有手动 notify 端点范式）；内网单 admin + 批次量小，不引入持久队列（见 backlog）。
      res.json({ id, status: '已发布', released: releasedIds, count: r.count });
      (async () => { for (const iid of releasedIds) await dispatchSysNotify(iid, 'notifyReleasedToRequester'); })().catch(() => { /* dispatch 内已 best-effort，此处兜底防 unhandledRejection */ });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/hotfix-publish：单条 hotfix 兜底（admin，自动建 is_hotfix=1 批次 + 一键发布，§6.1）──
  //   单事务原子：校单「待上线」AND 未挂批次 AND 非 config → 建 hotfix 批次 → 绑单 → 复用 _publishReleaseCoreInTxn 发布。
  router.post('/sys-issues/:id/hotfix-publish', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const issueId = parsePositiveId(req.params.id);
    if (!issueId) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '');
    const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '');
    if (!releaseNote) return res.status(400).json({ error: '请填写上线说明', code: 'RELEASE_NOTE_REQUIRED' });
    if (!versionTag) return res.status(400).json({ error: '请填写版本号', code: 'VERSION_TAG_REQUIRED' });
    if (releaseNote.length > SYS_RELEASE_NOTE_MAX) return res.status(400).json({ error: `上线说明超长（≤${SYS_RELEASE_NOTE_MAX} 字）`, code: 'RELEASE_NOTE_TOO_LONG' });
    if (versionTag.length > SYS_VERSION_TAG_MAX) return res.status(400).json({ error: `版本号超长（≤${SYS_VERSION_TAG_MAX} 字）`, code: 'VERSION_TAG_TOO_LONG' });
    try {
      const actor = sysActor(req);
      let releaseId = null, releaseNo = null, result = null;
      await sysBeginImmediate();
      try {
        const issue = await dbGetAsync('SELECT id, status, release_id, type FROM sys_issues WHERE id = ?', [issueId]);
        if (!issue) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // C（codex L-2）：类型判断用 RELEASABLE_TYPES 白名单（与 add-issues 同源，防未来加类型漂移）；config 保留特化错误码。
        if (!RELEASABLE_TYPES.includes(issue.type)) {
          await sysRollback();
          return res.status(409).json(issue.type === 'config'
            ? { error: '配置类不进上线批次', code: 'CONFIG_NO_RELEASE' }
            : { error: '该类型不进上线批次（仅 bug/feature/improvement）', code: 'TYPE_NOT_RELEASABLE' });
        }
        if (issue.status !== '待上线' || issue.release_id !== null) {
          await sysRollback();
          return res.status(409).json({ error: '该单非「待上线」或已挂批次，不能 hotfix', code: 'ISSUE_NOT_HOTFIXABLE' });
        }
        releaseNo = await nextReleaseNo();
        const relIns = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag, created_by, created_by_name)
           VALUES (?, ?, '计划中', 1, ?, ?, ?, ?)`,
          [releaseNo, `hotfix #${issueId}`, releaseNote, versionTag, actor.id, actor.name]
        );
        releaseId = relIns.lastID;
        const bind = await dbRunAsync(
          "UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = '待上线' AND release_id IS NULL",
          [releaseId, issueId]
        );
        if (!bind || bind.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '该单状态已变更，请刷新重试', code: 'ISSUE_NOT_HOTFIXABLE' }); }
        result = await _publishReleaseCoreInTxn(releaseId, actor, { release_note: releaseNote, version_tag: versionTag });
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      await dispatchSysNotify(issueId, 'notifyReleasedToRequester');   // hotfix 单条发需求方·已上线（best-effort）
      res.status(201).json({ issue_id: issueId, release_id: releaseId, release_no: releaseNo, status: '已上线', count: result.count });
    } catch (err) {
      // A（codex M-1）：hotfix 自动号极端竞态撞 UNIQUE 时转 409（不退化为 500 + 原始 SQLite 错误外泄）
      if (err && /UNIQUE/i.test(err.message || '')) return res.status(409).json({ error: '批次号生成冲突，请重试', code: 'RELEASE_NO_GENERATE_CONFLICT' });
      sendSysTransitionError(res, err);
    }
  });

  // ============================================================
  // 三·五、C5 钉钉通知派发（事务提交后 best-effort 发送 + 三侧物理隔离落库，§8）
  // ============================================================
  //   口径（§8.1 触发表 + 用户 2026-06-30 拍板）：
  //     · dev 侧（notify_*）发：指派/改派/重开（notifyAssignedDeveloper）+ 验收打回（notifyReturnedToDeveloper）
  //     · 需求方侧（requester_notify_*）发：回填预计完成（取双收件人的需求方侧）+ 已上线（notifyReleasedToRequester）
  //     · 本期不发（admin 自身，feedback_no_self_notify / §8.1 M-4）：转待验证(submit)→admin / 受阻(blocked)→admin /
  //       回填预计完成的 creator 侧（保持 not_sent，站内角标走独立未读逻辑，不读 notify_status）。
  //   边界：① best-effort 绝不抛——通知失败不影响已提交的主动作（§6.2 通知边界，事务已提交，dispatch 在提交后跑）；
  //         ② **业务发送失败**（wrapper result.ok=false，如无配置/无手机号/钉钉拒）必落库 failed + reason（§8.2）；
  //            **异常**（infra 抖动 / mutex 5s 超时等，dispatch catch 命中）不强行落 failed，保持落库前态供重试（codex 审 M-1 口径收敛，见 catch 注释）；
  //         ③ 三侧物理隔离——dev 只动 notify_* / requester 只动 requester_notify_*（互不覆盖，T-M3）；
  //         ⑤ 派发时机：单条端点在响应前 await（钉钉 wrapper 走 fetchWithTimeout，延迟有上界；换 verify 确定性 + admin 即时见通知态）；
  //            批次发布 N 条改响应后后台 detached 派发（防 200 单串行阻塞响应超时，codex 审 M-3）；
  //         ④ 复用 issue-tracker 既有发送链路（sendIssueDingtalkRaw/ToRequester 内置 token 重试 + message_key 缺失即判失败，
  //            等价软成功拦截；§8.2"复用现有范式"硬要求；deviation 见末次审说明：用 server.js 成熟 wrapper 替 §10.3 字面的
  //            resolveRequesterDingUserId+复刻 dingtalkSendOk，严格更高复用、风险更低）。

  const SYS_TYPE_LABELS = { feature: '新功能', improvement: '优化', bug: 'BUG', config: '配置变更' };

  // 深链行（baseUrl 已 sanitize；为空则省略，对齐 issue-tracker buildIssueDeepLink 范式）。
  //   URL 约定：Sys_Iteration.html?issue=<id>（C6 前端须按此 query 参数定位详情，整数 id 无注入面）。
  function sysDeepLinkLine(baseUrl, issueId) {
    if (!baseUrl) return '';
    return `\n\n[查看详情](${baseUrl}/Sys_Iteration.html?issue=${issueId})`;
  }

  // 钉钉消息 title 字段是纯文本（通知栏/会话列表展示，非 markdown 渲染，JSON 序列化无注入面）——codex 审 L-1：
  //   只清控制字符（防换行污染日志/展示）+ 截断（防超长），**不做 markdown 转义**（issueSafeText 会让纯文本标题出现难看的 \[ \(）。
  function sysNotifyTitle(text) {
    return String(text == null ? '' : text).replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 60);   // eslint-disable-line no-control-regex
  }

  // dev 侧 markdown（assign/reassign/reopen 共用指派模板，§8.1"复用指派模板"；return 用打回返工模板）。
  function buildSysDevMarkdown(issue, marker, baseUrl) {
    const typeLabel = SYS_TYPE_LABELS[issue.type] || issue.type;
    const title = issueNotify.issueSafeText(issue.title, 80);       // markdown 正文用转义文本
    const safeTitle = sysNotifyTitle(issue.title);                  // title 字段用纯文本清理（L-1）
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    if (marker === 'notifyReturnedToDeveloper') {
      return {
        title: `🔄 验收打回需返工：${safeTitle}`,
        md: `### 🔄 验收打回，需返工\n\n- **单号**：#${issue.id}\n- **类型**：${typeLabel}\n- **系统**：${system}\n- **标题**：${title}\n\n请登录平台查看打回原因，返工后重新提交。${link}`,
      };
    }
    return {
      title: `📋 系统迭代单指派：${safeTitle}`,
      md: `### 📋 迭代单指派给你\n\n- **单号**：#${issue.id}\n- **类型**：${typeLabel}\n- **系统**：${system}\n- **标题**：${title}\n\n请登录平台回填预计完成时间，并着手开发交付。${link}`,
    };
  }

  // 需求方侧 markdown（estimate=预计完成时间已更新；released=已上线，带版本号）。
  function buildSysRequesterMarkdown(issue, kind, baseUrl, extra) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);                  // title 字段用纯文本清理（L-1）
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    if (kind === 'released') {
      const verLine = extra && extra.versionTag ? `\n- **版本**：${issueNotify.issueSafeText(extra.versionTag, 60)}` : '';
      return {
        title: `🚀 您的需求已上线：${safeTitle}`,
        md: `### 🚀 您的需求已上线\n\n- **系统**：${system}\n- **需求**：${title}${verLine}\n\n相关功能已上线，感谢您的支持。${link}`,
      };
    }
    // estimate
    return {
      title: `⏱ 预计完成时间已更新：${safeTitle}`,
      md: `### ⏱ 开发已回填预计完成时间\n\n- **系统**：${system}\n- **需求**：${title}\n- **预计完成**：${issue.dev_estimated_at || '—'}\n\n开发已着手处理，预计完成时间如上。${link}`,
    };
  }

  // 通知落库写串行化进 sys mutex（ultracode 审 #1，C4.5 同类防线）：通知写跑在主事务提交后、mutex 已释放，
  //   若用裸 autocommit dbRunAsync，会落进另一并发请求已打开的 BEGIN IMMEDIATE 事务里，随其 ROLLBACK 一起丢失
  //   （钉钉已发但库回到 not_sent → 后续误判未发重复推送）。照附件写口径用 sysBeginImmediate/sysCommit 独立小事务串行化。
  //   注：dispatch 调用点均在各端点主事务 sysCommit 之后（mutex 已释放），此处再 acquire 不会自死锁。
  async function sysNotifyWrite(sql, params) {
    await sysBeginImmediate();
    try { await dbRunAsync(sql, params); await sysCommit(); }
    catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
  }
  // 三侧落库 helper（read_at 在每次新发送时一并重置——新 message_key 后旧已读时刻失去意义；失败时同样清，failed=无可读消息）。
  async function recordSysDevNotify(issueId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET notify_status=?, notified_at=datetime('now','localtime'),
              notify_message_key=?, notify_error=?, read_at=NULL WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId]);
  }
  async function recordSysRequesterNotify(issueId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET requester_notify_status=?, requester_notified_at=datetime('now','localtime'),
              requester_notify_message_key=?, requester_notify_error=?, requester_read_at=NULL WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId]);
  }

  // dev 侧发送（收件人 = assigned_to → users.id/phone/dingtalk_user_id；§8.2）。
  async function sendSysDevNotify(issue, marker, baseUrl) {
    if (!issue.assigned_to) { await recordSysDevNotify(issue.id, false, null, 'no_assignee'); return; }
    const dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.assigned_to]);
    if (!dev) { await recordSysDevNotify(issue.id, false, null, 'dev_not_found'); return; }
    const { title, md } = buildSysDevMarkdown(issue, marker, baseUrl);
    const result = await sendIssueDingtalkRaw(dev, title, md);
    await recordSysDevNotify(issue.id, !!result.ok, result.message_key, result.reason);
  }

  // 需求方侧发送（收件人 = requester_phone 反查钉钉号；业务方无平台账号；§8.2）。
  async function sendSysRequesterNotify(issue, kind, baseUrl) {
    // ultracode 审 #2：无需求方（内部自发现单常见，requester 三字段皆空）→ 无人可通知，保持 not_sent（不算失败）。
    //   否则每张内部单 estimate/已上线后都被打成 requester『failed』，C6 满屏假失败红标 + admin 无意义重试。
    //   区分『有需求方但缺手机号』(→failed) 与『根本无需求方』(→保持 not_sent)。
    if (!issue.requester_phone && !issue.requester_name && !issue.requester_dept) return;
    if (!issue.requester_phone) { await recordSysRequesterNotify(issue.id, false, null, 'requester_phone_empty'); return; }
    let extra = null;
    if (kind === 'released' && issue.release_id) {
      const rel = await dbGetAsync('SELECT version_tag, release_note FROM sys_releases WHERE id = ?', [issue.release_id]);
      if (rel) extra = { versionTag: rel.version_tag, releaseNote: rel.release_note };
    }
    const { title, md } = buildSysRequesterMarkdown(issue, kind, baseUrl, extra);
    const result = await sendIssueDingtalkToRequester(issue.requester_phone, title, md);
    await recordSysRequesterNotify(issue.id, !!result.ok, result.message_key, result.reason);
  }

  // 通知派发主入口（端点在事务提交后 await 调用；marker = transition.notifyAfterCommit）。
  async function dispatchSysNotify(issueId, marker) {
    if (!marker) return;
    // 本期不发的 marker（admin 自身，§8.1 + 用户拍板）：早返回不查库不发——submit→admin / blocked→admin。
    //   estimate 的 creator 侧不发由 estimate 分支内部只走需求方侧实现（creator 字段保持 not_sent）。
    if (marker === 'notifySubmittedToAdmin' || marker === 'notifyBlockedToAdmin') return;
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [issueId]);
      if (!issue) return;
      const baseUrl = await getSafePlatformBaseUrl();
      switch (marker) {
        case 'notifyAssignedDeveloper':
        case 'notifyReturnedToDeveloper':
          await sendSysDevNotify(issue, marker, baseUrl);
          break;
        case 'notifyEstimateToCreatorAndRequester':
          await sendSysRequesterNotify(issue, 'estimate', baseUrl);   // 仅需求方侧；creator 侧本期 not_sent（M-4）
          break;
        case 'notifyReleasedToRequester':
          await sendSysRequesterNotify(issue, 'released', baseUrl);
          break;
        default:
          logger.warn('[系统迭代] 未知通知标记: ' + marker);
      }
    } catch (err) {
      // ultracode 审 #8 边界（有意）：发送/落库阶段抛异常（如钉钉网络异常、record 的 mutex acquire 5s 超时）→ 静默吞为 warn，
      //   notify_status 保持落库前的态（首次发=not_sent / 重发=上一轮态），**不强行落 failed**。
      //   理由：抛异常≠业务发送失败（业务失败走 result.ok=false 已落 failed），异常多为基础设施抖动，保持 not_sent 让其可被后续动作/手动重发自然重试，语义比"failed"更准。
      logger.warn(`[系统迭代] 通知派发异常 #${issueId} ${marker}: ${(err && err.message) || err}`);
    }
  }

  // ============================================================
  // 四、导出（_internals 供 verify require 真实逻辑，RC-L2）
  // ============================================================
  const _internals = {
    SYS_SCHEMA_STATE,
    SYS_REQUIRED_TABLES,
    SYS_ISSUES_KEY_COLS,
    SYS_RELEASES_KEY_COLS,
    SYS_TIMELINE_KEY_COLS,
    SYS_ATTACHMENTS_KEY_COLS,
    requireSysSchemaReady,
    runSysMigration,
    // C2：状态机 + helper（verify require 真实逻辑）
    sysIssueTransition,
    sysActor,
    parsePositiveId,
    SysTransitionError,
    transitions: T,   // 常量模块（findTransition/buildMeta/ALLOWED_STATUSES/TRANSITIONS/BIZ_SYSTEMS）
    // C3a：datetime/deadline helper（verify 用例表）
    normalizeSysDatetime,
    truncToMinute,
    normalizeDeadline,
    // C3b：附件基础设施（verify-sys-attachments require 真实逻辑）
    sysPersistAttachments,
    sysRollbackPersisted,
    sysCleanupOrphanFiles,
    SYS_UPLOAD_BASE,
    SYS_PENDING_BASE,
    SYS_ALLOWED_EXTS,
    SYS_ATTACH_TYPES,
    // C4：上线批次（verify-sys-release require 真实逻辑）
    publishReleaseTransition,
    nextReleaseNo,
    RELEASABLE_TYPES,
    SYS_RELEASE_NOTE_MAX,
    SYS_VERSION_TAG_MAX,
    // C5：钉钉通知派发（verify-sys-notify require 真实逻辑）
    dispatchSysNotify,
    buildSysDevMarkdown,
    buildSysRequesterMarkdown,
    sysDeepLinkLine,
  };

  return { initSchema, router, _internals };
};
