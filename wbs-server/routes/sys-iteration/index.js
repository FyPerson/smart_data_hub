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
//   - 全新模块：CREATE TABLE IF NOT EXISTS 一次建全，无 ALTER（核实#1；⚠️ bug 流 Commit ① 起已破例——
//     已上线表演进走 runSysMigration [1a] 幂等 ALTER，照 corrections [2a] 系列范式）
//   - 删单显式删子表（核实#1，本项目从不开 PRAGMA foreign_keys=ON）
//   - 导出 { initSchema, router, _internals }，_internals 供 verify require 真实逻辑（RC-L2 根治复刻漂移）
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');     // C3b 附件上传（自建，对齐 corrections.js:9 范式；§10.3 deps 表 multer=自建）
const T = require('./transitions');   // 状态机常量单一来源（§3.7，T-M4）
const issueNotify = require('../../utils/issue-notify');   // C5 通知 markdown 安全文本（issueSafeText 复用 dingtalk-notify escapeMarkdown，不新建转义，§10.3 require）
const dingtalkNotify = require('../../utils/dingtalk-notify');   // ③ 真钉钉建群 create-chat（getAccessToken/getUserIdByMobile/createChatGroup/sendGroupMessage/classifyError/escapeMarkdown；stateless util 直接 require，对齐 issueNotify + corrections.js 范式）

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
    'sendIssueDingtalkRaw', 'sendIssueDingtalkToRequester', 'getSafePlatformBaseUrl',
    // ⬆ ③（真钉钉建群）加入：readSystemConfig（钉钉凭证）/ COLLAB_CHAT_ADMIN_ID（群主示例用户A id=3）/
    //   callDingtalkWithTokenRetry（token 过期重试包装，对齐 collab/issue create-chat）/ maskPhone（业务方手机号日志脱敏）（§5 [审:#7] 均=注入）。
    'readSystemConfig', 'COLLAB_CHAT_ADMIN_ID', 'callDingtalkWithTokenRetry', 'maskPhone'];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/sys-iteration 缺注入依赖: ' + __k);
  }
  const { logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken, requireAdmin,
    UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync, ALLOWED_FILE_DIRS,
    sendIssueDingtalkRaw, sendIssueDingtalkToRequester, getSafePlatformBaseUrl,
    readSystemConfig, COLLAB_CHAT_ADMIN_ID, callDingtalkWithTokenRetry, maskPhone } = deps;

  // ============================================================
  // 一、schema readiness state + 关键列锚点常量 + 守门中间件
  // ============================================================
  // 系统迭代四表（sys_releases/sys_issues/sys_issue_timeline/sys_issue_attachments）。
  //   C1 首版 CREATE TABLE IF NOT EXISTS 一次建全（无 ALTER，方案 §3.1）；**bug 流 Commit ① 起已上线表演进**：
  //   新列走 runSysMigration [1a] 幂等 ALTER（生产 v1.102.0 有表，IF NOT EXISTS 对已存在表 no-op 不加列）。
  //   migration PRAGMA 复查四表 + 关键列就位才置 ready；未就绪挡 sys-* 写入口（503），其他模块正常。
  //   readiness 闸门 = 冗余防线 + 首启短暂窗口保护（migration 完成前 ready=false，避免首启报错）。
  const SYS_SCHEMA_STATE = { ready: false, error: null };

  const SYS_REQUIRED_TABLES = ['sys_releases', 'sys_issues', 'sys_issue_timeline', 'sys_issue_attachments'];

  // readiness 复查是"启动期就绪 status-only 抽样"——挑代表性关键不变量列（三侧通知 status 锚点/质量计数/
  //   来源/血缘批次/config 生效时刻），不做全字段全量校验（那是 verify-sys-schema.js 的职责，对齐 corrections
  //   codex 08 M-1 驳回"补全列全集"理由）。
  // ⚠️ 口径与前提（codex 13 M-1 统一）：三侧通知每侧只查 *_notify_status 一个 status 锚点，**不查**该侧
  //   notified_at/message_key/error/read_at 其余 4 列——前提 = 三侧 5 列在同一条 CREATE TABLE 原子建表
  //   （C1 首版即含），要么整表成功（5 列全在）、要么 firstSysDdlError 兜底（整表失败），不存在
  //   "status 列在、其余 4 列缺"的半成品态。**三侧通知各 5 列的全量校验在 verify-sys-schema.js（07-M3）**，
  //   readiness 与 verify 职责分工明确、不分裂。
  //   ⚠️ 前提更新（bug 流 Commit ① 起）：本模块已引入 ALTER（runSysMigration [1a] 补 bug 流列）——
  //     「全新无 ALTER」前提仅对 C1 首版 CREATE 内的列组继续成立；**ALTER 追加的列组**（bug 流 9+1 列）
  //     半成品态可能出现，故每组 ≥1 个锚点入本清单（[审:M1] 指定 4 锚），其余由 verify 全量保障 +
  //     [1a] 置于 [2] 复查之前（C-1 顺序铁律）保证 readiness 判定用的是 ALTER 后列集。
  // ⚠️ L-6：三侧通知 status 锚点（dev/requester/creator）必须列全，别只查新增漏既有。
  const SYS_ISSUES_KEY_COLS = [
    'type', 'status', 'priority', 'system_name', 'source', 'record_source', 'import_batch_id',
    'origin_issue_id', 'release_id', 'created_by', 'assigned_to',
    'dev_estimated_at', 'deadline', 'assigned_at', 'first_submitted_at', 'accepted_at',
    'released_at', 'closed_at', 'reopened_at',
    'reopen_count', 'return_count', 'scope_changed',
    'notify_status', 'requester_notify_status', 'creator_notify_status',  // ← 三侧锚点（L-6）
    'effected_at',                                                        // ← config 已生效时刻（11-M1），readiness 须含
    'needs_feasibility', 'feasibility_conclusion', 'blocked',            // ← 可行性评估闸门锚点（F1 §2.3，抽样非全列；其余 4 评估列由 verify 全量保障）
    'needs_release', 'related_correction_no', 'fix_gap_note', 'dingtalk_chat_id'  // ← bug 流 Commit ① 锚点（[审:M1] 指定 4 锚；derive_reason + 其余 4 群字段由 verify 全量保障）
  ];
  const SYS_RELEASES_KEY_COLS = ['release_no', 'status', 'is_hotfix', 'release_note', 'version_tag',
    'release_type'];   // ← bug 流 Commit ① 批次类型隔离锚点（[codex三审:L] 值域非空由 ② 服务端守卫强制，readiness 只查列在）
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

  // ── bug 流对接人白名单（Commit ④，bug流_方案_20260702_v1.2 §3；用户 2026-07-03 拍板 D1）──────────────
  //   路线：对接人 = 固定两用户白名单（**非角色口径**，可非 admin）——示例发布者(id=7,publisher) / 示例对接人(id=13,user)。
  //   ⭐ 与 correction relay 白名单（corrections.js CORRECTION_RELAY_USER_IDS）是**同两人**（生产已在用），刻意复用
  //     其已验证 id；bug 流镜像该范式。授权高于 role——白名单成员即可当对接人（看 bug / 指派 / 换人），即便 user 角色。
  //   ⚠️ bug 流对接人是**全局**白名单（无每单 relay_notified_user_id 绑定，与 correction 不同）——两人对**任意 bug 单**
  //     都可指派/换人；type 精判把权限**收窄到 type='bug'**（不波及 feature/improvement 变更流，§3「不全局化」）。
  //   ⚠️ 改名单需三处同步：本常量 + 前端 public/Sys_Iteration.html 同名常量 + scripts/verify-sys-liaison.js
  //     （verify 卡三处字面量一致防漂移，对齐 correction relay 白名单三处同步纪律）。
  //   ⚠️ 部署前探针（deferred 到 5 片齐部署前，[[feedback_real_sample_before_deploy]]）：确认生产 users 表
  //     id=7 是示例发布者、id=13 是示例对接人且均 active、非 viewer（correction relay 已在产用此二 id，属产验事实，探针复核即可）。
  const SYS_BUG_LIAISON_USER_IDS = [7, 13];
  //   单一真相点（对齐 correction isCorrectionRelayWhitelisted / server.js isReadonlyLeaderId 范式）：uid 是否在对接人白名单。
  function isSysBugLiaison(uid) {
    return Number(uid) > 0 && SYS_BUG_LIAISON_USER_IDS.includes(Number(uid));
  }
  //   粗筛中间件（挂 bug 指派/换人端点前）：放行 admin 或白名单对接人；进 handler 后由
  //   sysIssueTransition [3] 的 roleGuard='admin_or_bug_liaison'（assign）/ 端点 handler type='bug' 精判（reassign）
  //   权威收窄到「仅 bug 单」——对接人不获变更流/config 的指派权（H-2 隔离，§3「不全局化」）。
  function requireAdminOrBugLiaison(req, res, next) {
    const role = req.user && req.user.role;
    if (role === 'admin' || isSysBugLiaison(req.user && req.user.id)) return next();
    return res.status(403).json({ error: '仅管理员或对接人可操作', code: 'NOT_ADMIN_OR_BUG_LIAISON' });
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
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        -- 批次类型隔离（bug 方案 [审:L1]，Commit ① 建列+回填 / Commit ② add-issues 校一致启用；表尾对齐 ALTER 追加序）。
        --   NULLABLE 建列（[codex三审:L]：SQLite 已有表不能补 NOT NULL/CHECK，改 readiness 复查 + 服务端守卫强制）。
        release_type TEXT
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

        -- ── bug 流（bug流_方案_20260702_v1.2 §9，Commit ①）──────────
        --   置于表尾（table-level CHECK 之前）：与旧库 ALTER ADD COLUMN 追加序一致，两路径列序不漂移。
        --   needs_release：bug 待上线态内开发填「是否发版」（NULL=未填；1=发版走 hotfix 批次/0=不发版走专用 transition，§8.2，Commit ② 写入）。
        --     CHECK 仅新库带（旧库 ALTER 不补 CHECK，corrections [2a-x3] 同源；靠 ② 写入口枚举校验 + verify 兜底，两路径不变量等效）。
        needs_release INTEGER CHECK (needs_release IS NULL OR needs_release IN (0,1)),
        related_correction_no TEXT,        -- §7 软关联数据修正单号（不跳转/不硬校验/不 join；建单接收=Commit ④）
        derive_reason TEXT,                -- §4 双描述·建单人派生原因（derive 端点必填=Commit ⑤）
        fix_gap_note TEXT,                 -- §4 双描述·派生单首次提交"修复缺口说明"（submit 闸门=Commit ⑤）
        -- 拉群讨论 6 字段（§5 [审:#7]，逐字复刻 correction_requests 旁路字段；建群端点=Commit ③）
        --   dingtalk_chat_desc：拉群议题（③ 必填才允许拉群，§5「留痕:描述」；用户 2026-07-03 拍板存列真留痕）。
        dingtalk_chat_id TEXT,
        dingtalk_open_conversation_id TEXT,
        dingtalk_chat_created_at DATETIME,
        dingtalk_chat_created_by INTEGER,
        dingtalk_chat_name TEXT,
        dingtalk_chat_desc TEXT,

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

  // ── schema 就绪探测 + 迁移（方案 §3.5 / 核实#5；bug 流 Commit ① 起含 ALTER）─────────────────
  //   C1~C6 时代「全新模块无 ALTER」前提就此终结：sys 四表已上线 v1.102.0（生产有表），bug 流新列走
  //   [1a] 幂等 ALTER 补列（照 corrections runCorrectionMigration [2a] 系列范式）+ [1b] release_type 回填，
  //   再 [2] PRAGMA 复查四表 + 关键列（含新锚点），全部就位才置 SYS_SCHEMA_STATE.ready=true。
  //   入参 ddlError：建表 serialize 块收集的首个 DDL 错误。
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

      // [1a] ⭐ bug 流 Commit ①（bug流_方案_20260702_v1.2 §9）：已上线表演进——sys_issues 补 9 列 +
      //   sys_releases 补 release_type，幂等 ALTER ADD COLUMN（照 corrections [2a]/[2a-x]/[2a-pt] 范式：
      //   PRAGMA 查列不存在才 ALTER；重启多次首次 ALTER、后续跳过）。生产 sys 表已有数据不能 DROP 重建，
      //   CREATE TABLE IF NOT EXISTS 对已存在表 no-op（新列不加），故此处补；新库 CREATE 已含列 → 全部跳过。
      //   ⚠️ C-1 硬性顺序铁律（corrections codex 36/37 同源）：needs_release/related_correction_no/fix_gap_note/
      //     dingtalk_chat_id/release_type 已入 KEY_COLS——ALTER 必须在下方 [2] 关键列复查【之前】完成，
      //     否则判缺列 → ready=false → sys 写入口 503（生产熔断）。
      //   ⚠️ ALTER 路径不带 CHECK（corrections [2a-x3] 同源：ALTER 补约束受限）：needs_release CHECK 仅新库
      //     CREATE 带，旧库靠 Commit ② 写入口枚举校验 + verify 断言兜底，两路径不变量等效。
      //   col/type 为硬编码常量非用户输入，插值无注入风险；ALTER reject → 外层 catch 置 error（可观测不静默吞）。
      const alterAddMissingCols = async (tbl, colDefs, label) => {
        const rows = await new Promise((resolve, reject) => {
          db.all(`PRAGMA table_info(${tbl})`, (err, r) => err ? reject(err) : resolve(r));
        });
        if (!rows || rows.length === 0) throw new Error(`无法读取 ${tbl} 表结构（PRAGMA 失败，ALTER 前置检查）`);
        const names = rows.map(c => c.name);
        for (const [col, type] of colDefs) {
          if (!names.includes(col)) {
            await new Promise((resolve, reject) => {
              db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`, (err) => err ? reject(err) : resolve());
            });
            logger.info(`[系统迭代迁移] ${tbl} ADD COLUMN ${col} ${type}（${label}）`);
          }
        }
      };
      const BUG_FLOW_ISSUE_COLS = [
        ['needs_release', 'INTEGER'],              // NULL=未填；1=发版/0=不发版（§8.2，② 端点写入+枚举校验）
        ['related_correction_no', 'TEXT'],         // §7 软关联修正单号（④ 建单接收）
        ['derive_reason', 'TEXT'],                 // §4 双描述·派生原因（⑤ derive 端点必填）
        ['fix_gap_note', 'TEXT'],                  // §4 双描述·修复缺口说明（⑤ submit 闸门）
        ['dingtalk_chat_id', 'TEXT'],              // §5 拉群 6 字段（③ 建群端点，复刻 correction）
        ['dingtalk_open_conversation_id', 'TEXT'],
        ['dingtalk_chat_created_at', 'DATETIME'],
        ['dingtalk_chat_created_by', 'INTEGER'],
        ['dingtalk_chat_name', 'TEXT'],
        ['dingtalk_chat_desc', 'TEXT'],            // ③ 拉群议题（用户 2026-07-03 拍板存列真留痕，§5「留痕:描述」）
      ];
      await alterAddMissingCols('sys_issues', BUG_FLOW_ISSUE_COLS, 'bug 流 Commit ①');
      await alterAddMissingCols('sys_releases', [['release_type', 'TEXT']], 'bug 流 Commit ①·批次类型隔离 [审:L1]');

      // [1b] release_type **族别**回填（D-A：bug vs 非bug，用户 2026-07-03 拍板）：按成员族别回填非空批次——
      //   含 bug 成员 → 'bug'，否则（feature/improvement）→ 'change'；空批次留 NULL（② 建批次/加单时写值）。
      //   ⭐ 这消解了旧「按精确 type 唯一性回填」留下的 codex H-2 哑弹：历史批次（bug 流未上线前只可能含
      //   feature/improvement，bug 单无法建）全部干净归入 'change'，不再有「非空但 release_type=NULL」的混批态，
      //   故删去旧 mixedRels warn 分支（族别下无「混合待人工」态）。幂等：WHERE release_type IS NULL，二跑无副作用。
      await new Promise((resolve, reject) => {
        db.run(`UPDATE sys_releases SET release_type = CASE
                  WHEN EXISTS (SELECT 1 FROM sys_issues WHERE sys_issues.release_id = sys_releases.id AND sys_issues.type = 'bug') THEN 'bug'
                  ELSE 'change' END
                WHERE release_type IS NULL
                  AND EXISTS (SELECT 1 FROM sys_issues WHERE sys_issues.release_id = sys_releases.id)`,
          (err) => err ? reject(err) : resolve());
      });

      // [2] 四表关键列 PRAGMA 复查（抽样锚点，非全字段；[1a] ALTER 后的最新列集）
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
                first_submitted_at, reopen_count, return_count, origin_issue_id,
                needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm,
                feasibility_risk, blocked, release_id, needs_release
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
        // bug 流对接人白名单（Commit ④，§3）：roleGuard='admin_or_bug_liaison' = admin 或白名单对接人（示例发布者/示例对接人）。
        //   ⚠️ 该 roleGuard **仅挂在 bug transition**（transitions.js assign，变更流 assign 仍 'admin'），故此处放行
        //     白名单对接人时 **type 精判隐含**——transition 由 findTransition(row.type,...) 查出，能命中 'admin_or_bug_liaison'
        //     即 row.type='bug'，对接人不获变更流/config 指派权（§3「不全局化」，H-2 隔离）。
        if (transition.roleGuard === 'admin_or_bug_liaison' && !(isAdmin || isSysBugLiaison(actor.id))) permitted = false;
        if (transition.ownerGuard === 'assignee' && !isAssignee) permitted = false;  // 严格本人，不放行 admin
        if (!permitted) throw new SysTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权执行此状态流转');
      }

      // [4] RC-M5 状态级不变量：进入开发后状态须有 assigned_to（avoid "已进流程却无开发负责人"）。
      //   bug 流 Commit ①（[审:M4] 同族）：全集常量收敛到 T.REQUIRES_ASSIGNEE_STATUSES（跨类型 union，
      //   含 bug 的 处理中；已拒绝/已作废/待处理 等无开发态不在内），替换本地硬编码防加类型漏。
      if (T.REQUIRES_ASSIGNEE_STATUSES.includes(toStatus)) {
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
      // bug 流 Commit ②：多数 transition 无需额外 WHERE（通用 id+status 双条件已够），仅
      //   confirm-online-norelease 需要 release_id/needs_release 双 WHERE 守卫（[审:H1]），故留空数组
      //   给个别 action 按需追加，不影响其余 transition 的既有 WHERE 语义。
      const whereFrags = [];
      const whereParams = [];

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
          // [⑤ §4 双描述·fix_gap_note 首提闸门]（谓词 [审:H3]+[审:M5] 弥合，bug 流_方案_v1.2 §4）：
          //   仅「派生自 bug（origin.type='bug'）∧ 新单也是 bug（row.type='bug'）∧ 首次提交（first_submitted_at 为空）」触发必填；
          //   跨类型 bug→feature（row.type≠'bug'）与非派生单自然跳过（M5「跨类型 bug→feature 跳过 fix_gap_note」）。
          //   置于 first_submitted_at 判定之后、共用其 !row.first_submitted_at 条件：只在首提盖 fix_gap_note，
          //   返工重提（first_submitted_at 已盖）不再要求也不覆写（fix_gap_note = 首版修复缺口一次性留痕）。
          if (!row.first_submitted_at && row.origin_issue_id && row.type === 'bug') {
            const originForGap = await dbGetAsync('SELECT type FROM sys_issues WHERE id = ?', [row.origin_issue_id]);
            // [M-1 fail-closed·codex 合并审 + 五视角对抗审] origin_issue_id 非空却查不到 origin = 谱系脏数据
            //   （生产无硬删除端点 + origin 由 derive 校验存在 → 不可达，仅手工改库可致）。按本模块"防脏数据/
            //   手工修库 fail-closed"房规：显式报错而非静默按"非 bug"放行绕过 fix_gap_note 留痕（三态判定）。
            if (!originForGap) throw new SysTransitionError(409, 'SYS_ORIGIN_MISSING', '派生单的原单不存在（谱系数据异常），请联系管理员');
            if (originForGap.type === 'bug') {
              const gap = (typeof payload.fix_gap_note === 'string' ? payload.fix_gap_note.trim() : '');
              if (!gap) throw new SysTransitionError(400, 'FIX_GAP_NOTE_REQUIRED', '派生自 bug 的修复单首次提交需填写「修复缺口说明」');
              setFrags.push('fix_gap_note = ?'); setParams.push(gap);
            }
          }
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
          //     追加 config 流时若新增此类回路，reactivate/issue_reject 须改为复用 SYS_CLEAR_FEASIBILITY_FIELDS_SQL，否则残留评估跨轮带过去。
          //   ✅ bug 流已核对（Commit ①）：bug 的 issue_reject 仅 from=待处理（前段，从未进开发）、reactivate 回 待处理；
          //     且 bug 建单守卫拒 needs_feasibility=1（评估字段恒 NULL）+ blocked M-1 收口不适用 bug（恒 0）——
          //     「不清」对 bug 同样成立，无残留面。
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
        case 'confirm-online-norelease': {
          // 确认上线·不发版（bug §8.2 [审:H1]）：needs_release 必须已在「填发版信息」填为 0（唯一写点=
          //   set_release_flag），release_id 必须为空（未挂批次/未走 hotfix）——事务内先友好校验，再靠
          //   whereFrags 追加双 WHERE 兜底并发漂移（防校验后、UPDATE 前被另一请求抢先挂批次/改 needs_release）。
          if (row.release_id !== null && row.release_id !== undefined) {
            throw new SysTransitionError(409, 'ISSUE_ALREADY_IN_RELEASE', '该单已挂上线批次，不能走「确认上线·不发版」');
          }
          if (row.needs_release !== 0) {
            throw new SysTransitionError(409, 'NEEDS_RELEASE_NOT_SET', '请先在「填发版信息」中选择「不发版」');
          }
          setFrags.push("released_at = datetime('now','localtime')");
          whereFrags.push('release_id IS NULL', 'needs_release = 0');
          break;
        }
        default:
          // publish 走 hotfix-publish/publishReleaseTransition（C4），不经此函数；其余未列动作走通用（无闸门）。
          break;
      }

      // [6] 双条件 WHERE 守卫（status = 事务内读到的真实 fromStatus）+ changes≠1→409（乐观锁）
      //   whereFrags 为个别 action（confirm-online-norelease）追加的额外 WHERE 条件，其余动作恒为空数组，
      //   拼接后与原 WHERE 语义等价（不影响既有 transition 行为）。
      const setClause = ['status = ?', "updated_at = datetime('now','localtime')", ...setFrags].join(', ');
      const whereExtra = whereFrags.length ? ' AND ' + whereFrags.join(' AND ') : '';
      const upd = await dbRunAsync(
        `UPDATE sys_issues SET ${setClause} WHERE id = ? AND status = ?${whereExtra}`,
        [toStatus, ...setParams, issueId, fromStatus, ...whereParams]
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
        // 放行类型 = ALLOWED_STATUSES 已定义流（bug 流 Commit ① 起含 bug）；config 待追加。
        return res.status(400).json({ error: `类型暂不支持（当前支持 ${Object.keys(T.ALLOWED_STATUSES).join('/')}）`, code: 'TYPE_NOT_SUPPORTED', allowed: Object.keys(T.ALLOWED_STATUSES) });
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
      //   其他 type 传 1 拒绝（防 bug/config 误带评估）。bug 流 Commit ① 起该守卫实弹生效
      //   （bug 建单已放行，传 needs_feasibility=1 → 400 FEASIBILITY_NOT_APPLICABLE，评估环节不适用 bug）。
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

      // §7 关联数据修正单号（bug 流 Commit ④，建单可选软引用）：自由文本（OA 号 / 修正单 id / datafix-N 等），
      //   不硬校验不 join、不跳转（详情做 best-effort 软查提示，见详情端点）；≤100 字。任意 type 可带（无害软字段），
      //   前端仅 bug 建单暴露入口（§7 是 bug 关切；变更流带上也无害，后端不按 type 拒以免多余分支）。
      const relatedCorrectionNo = (typeof b.related_correction_no === 'string' && b.related_correction_no.trim()) ? b.related_correction_no.trim() : null;
      if (relatedCorrectionNo && relatedCorrectionNo.length > 100) {
        return res.status(400).json({ error: '关联修正单号不超过 100 字', code: 'RELATED_CORRECTION_NO_TOO_LONG' });
      }

      const actor = sysActor(req);
      let newId = null;
      await sysBeginImmediate();
      try {
        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline,
              needs_feasibility, related_correction_no,
              created_by, created_by_name, record_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value,
           needsFeasibility, relatedCorrectionNo,
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

  // ── POST /sys-issues/:id/assign：指派（变更流 已排期→开发中 / bug 待处理→处理中；admin，被指派人非 viewer）──────────
  //   bug 流 Commit ①：expectedFrom 由硬编码 '已排期' 改 null——前置态按 type 不同（bug=待处理），
  //   由 findTransition 的 from 白名单守 + 双 WHERE changes 守并发（同 makeTransitionEndpoint 口径）；
  //   expectedFrom 原是端点硬编码而非客户端传值，去掉不损失防陈旧语义。
  //   ④ 对接人白名单放开：中间件 requireAdminOrBugLiaison 粗筛（admin 或白名单对接人）；变更流指派仍只 admin——
  //     由 sysIssueTransition [3] roleGuard 精判（bug assign='admin_or_bug_liaison' / feature assign='admin'），
  //     对接人指派 feature 单会在 [3] 被 403（roleGuard 命中前已过被指派人校验，无副作用，事务未起）。
  router.post('/sys-issues/:id/assign', authenticateToken, requireSysSchemaReady, requireAdminOrBugLiaison, async (req, res) => {
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
      const r = await sysIssueTransition(id, 'assign', null, sysActor(req),
        { assigned_to: dev.id, assigned_to_name: devName });
      await dispatchSysNotify(id, r.notifyAfterCommit);   // notifyAssignedDeveloper → 通知新开发（dev 侧，best-effort）
      res.json({ id, assigned_to: dev.id, assigned_to_name: devName, status: r.toStatus });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/reassign：改派（开发中/待验证 → 开发中，admin，照 correction v1.85.0 L-R）──────────
  //   ⚠️ 不走 sysIssueTransition（语义上状态可能不变=同态换人）；独立事务 + 乐观锁绑 oldAssignedTo + status。
  //   ④ 对接人白名单放开：中间件 requireAdminOrBugLiaison 粗筛；reassign 独立事务不经 [3]，故 type='bug' 精判在
  //     handler 内读 row 后做（非 admin=白名单对接人仅可改派 bug 单），对齐 correction reassign RC4-M1 handler 精校验。
  router.post('/sys-issues/:id/reassign', authenticateToken, requireSysSchemaReady, requireAdminOrBugLiaison, async (req, res) => {
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
        // ④ 对接人白名单 type 精判（reassign 独立事务不经 sysIssueTransition [3]，须显式）：非 admin（即中间件放行的
        //   白名单对接人）仅可改派 bug 单，不得越界改派变更流/config（§3「不全局化」，H-2 隔离）。
        if (actor.role !== 'admin' && !(isSysBugLiaison(actor.id) && row.type === 'bug')) {
          await sysRollback();
          return res.status(403).json({ error: '对接人仅可改派 bug 单', code: 'NOT_AUTHORIZED_FOR_TRANSITION' });
        }
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
      await syncSysChatAddDev(id, dev.id);                      // §5 [审:#16] 换人同步群成员（加新不移旧，best-effort 不抛；定义见下方拉群段，声明已提升）
      res.json({ id, assigned_to: dev.id, assigned_to_name: devName });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 改派失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '改派失败' });
    }
  });

  // ============================================================
  // bug 流 Commit ③：真钉钉建群（POST /sys-issues/:id/create-chat）
  //   §5：复刻 correction create-chat 范式（一次成型 chat/create + 双 WHERE 守卫 + CRITICAL 落库失败处理 + requester_phone 反查降级）。
  //   bug 流增量 vs correction：
  //     ① 无额外成员多选、无排除名单（成员=固定底座：群主示例用户A + 建单人 + 指派开发 + 发起人；对接人待 Commit ④ 放开）
  //     ② 描述必填 chat_desc（用户 2026-07-03 拍板存列 dingtalk_chat_desc 真留痕，§5「留痕:描述」；写库 + 欢迎卡片）
  //     ③ 状态门槛 = 指派后非终态（处理中/待验证/待上线）
  //     ④ 钉钉调用走 callDingtalkWithTokenRetry（token 过期重试，对齐 collab/issue create-chat，§5 [审:#7]）
  //   幂等锚点 = dingtalk_open_conversation_id IS NULL；旁路 UPDATE 6 群字段，不走 sysIssueTransition/不动 status/不写 timeline
  //   （拉群非状态流转；钉钉无服务端解散 API，用完由群主示例用户A在客户端手动解散，D2 沿用 correction 收口）。
  //   ⚠️ 并发：单条原子 UPDATE + 双 WHERE 守卫（open_conversation_id IS NULL）已足，不需 sysTxnMutex（非多语句 BEGIN IMMEDIATE 事务）。
  // ============================================================
  const SYS_CHAT_ALLOWED_STATUSES = ['处理中', '待验证', '待上线'];   // 指派后非终态可拉群（排 待处理[未指派] / 已上线·已拒绝·已作废[终态]）
  // sys 专用成员入口——只排无效/占位 id（≤0/NaN/非安全整数），**不排 id=1**（sys 同 users 表，id=1=真实 admin，对齐 correction M-2）
  function addSysChatMember(memberSet, rawId) {
    const uid = Number(rawId);
    if (Number.isSafeInteger(uid) && uid > 0) memberSet.add(uid);
  }

  // ── §5 [审:#16] 换人同步群成员（Option A：加新不移旧，用户 2026-07-03 拍板；函数声明已提升，reassign 端点在上方前向调用 OK）──
  //   reassign 换开发后，若该单已建讨论群，best-effort 把新开发加进群（addUserToChat，对齐 collab 三级转发 server.js:15519）。
  //   ⚠️「移旧」无实现：钉钉本代码库无移除群成员 API（dingtalk-notify 仅 addUserToChat），旧开发留群——他本是该单经手人，
  //     留群看后续无泄露/无实质危害；如需移除由群主示例用户A在钉钉客户端手动操作（前端改派处提示）。
  //   全 best-effort：解析失败/加人失败仅日志、绝不抛，不影响改派主流程（改派事务已提交）。
  async function syncSysChatAddDev(issueId, devId) {
    try {
      const chatRow = await dbGetAsync('SELECT dingtalk_chat_id, dingtalk_open_conversation_id FROM sys_issues WHERE id = ?', [issueId]);
      if (!chatRow || !chatRow.dingtalk_open_conversation_id || !chatRow.dingtalk_chat_id) return { synced: false, reason: 'no_chat' };
      const u = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [devId]);
      if (!u) return { synced: false, reason: 'dev_not_found' };
      const [appKey, appSecret] = await Promise.all(['dingtalk_app_key', 'dingtalk_app_secret'].map(readSystemConfig));
      if (!appKey || !appSecret) return { synced: false, reason: 'no_config' };
      let token;
      try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
      catch (err) { logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 取 token 失败，跳过加新开发进群：${dingtalkNotify.classifyError(err).reason}`); return { synced: false, reason: 'token_failed' }; }
      // 解析新开发钉钉号（缺则手机号反查 + 回写，与 create-chat resolveDing 同范式）
      let ding = (u.dingtalk_user_id != null) ? String(u.dingtalk_user_id).trim() : '';
      if (!ding) {
        const phone = (u.phone != null) ? String(u.phone).trim() : '';
        if (!/^1\d{10}$/.test(phone)) { logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 新开发 ${u.display_name || ('#' + devId)} 无钉钉号且手机号缺失，跳过加群`); return { synced: false, reason: 'no_dingtalk' }; }
        try {
          const raw = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getUserIdByMobile(t, phone));
          ding = raw != null ? String(raw).trim() : '';
          if (ding) await dbRunAsync(`UPDATE users SET dingtalk_user_id = ? WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = '')`, [ding, u.id]);
        } catch (err) { logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 新开发手机号 ${maskPhone(u.phone)} 反查失败，跳过加群：${dingtalkNotify.classifyError(err).reason}`); return { synced: false, reason: 'lookup_failed' }; }
        if (!ding) { logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 新开发 ${u.display_name || ('#' + devId)} 反查无钉钉号，跳过加群`); return { synced: false, reason: 'not_found' }; }
      }
      // 加新开发进群（best-effort，对齐 collab 15519：addUserToChat + classifyAddUserErrcode）
      const addResult = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.addUserToChat(t, chatRow.dingtalk_chat_id, [ding]));
      const errcode = addResult && addResult.errcode;
      let clsKind = null, clsAction = null;
      try { const cls = dingtalkNotify.classifyAddUserErrcode(errcode, addResult && addResult.errorUserIds); clsKind = cls && cls.kind; clsAction = cls && cls.action; } catch (_) { /* 分类失败不影响 best-effort */ }
      const ok = clsKind === 'soft_success' || clsKind === 'success' || errcode === 0;
      if (ok) logger.info(`[sys-chat-sync] 迭代单 #${issueId} 新开发 ${u.display_name || ('#' + devId)} 已加入讨论群（errcode=${errcode} kind=${clsKind}）`);
      else logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 新开发加群未成功 errcode=${errcode} kind=${clsKind} action=${clsAction}`);
      return { synced: ok, errcode };
    } catch (err) {
      logger.warn(`[sys-chat-sync] 迭代单 #${issueId} 换人同步群成员异常（不影响改派）：${err && err.message}`);
      return { synced: false, reason: 'exception' };
    }
  }

  // ── ④b-2 GET /sys-issues/:id/chat-candidates：拉群成员多选候选（前端拉群弹框打开时拉取）──────────
  //   候选 = active 非 viewer 且有合法手机号的系统用户（排固定底座）∪ 当前单据报障人（用户 7/3 拍板）。
  //   ⚠️ **不返手机号本身**（隐私），只返 id + display_name 供勾选；create-chat 落地时按 id 再查+resolve 钉钉。鉴权同 create-chat。
  router.get('/sys-issues/:id/chat-candidates', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const userId = Number(req.user.id);
    const role = req.user.role;
    try {
      const c = await dbGetAsync('SELECT id, type, created_by, assigned_to, requester_name, requester_phone FROM sys_issues WHERE id = ?', [id]);
      if (!c) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const isAdmin = role === 'admin';
      const isCreator = Number(c.created_by) === userId && userId > 0;
      const isAssignee = Number(c.assigned_to) === userId && userId > 0;
      if (!isAdmin && !isCreator && !isAssignee) return res.status(403).json({ error: '无权查看此迭代单', code: 'NOT_AUTHORIZED_TO_VIEW' });
      if (!isAdmin && !isAssignee) return res.status(403).json({ error: '仅管理员或被指派开发本人可发起拉群讨论', code: 'NOT_ALLOWED_TO_CREATE_CHAT' });
      if (c.type !== 'bug') return res.status(409).json({ error: '拉群讨论目前仅用于 BUG 类迭代单', code: 'CHAT_ONLY_FOR_BUG' });

      // 固定底座（展示用，前端标"自动入群，无需勾选"）：群主示例用户A + 建单人 + 指派开发 + 发起人
      const baseIdSet = new Set();
      addSysChatMember(baseIdSet, COLLAB_CHAT_ADMIN_ID);
      addSysChatMember(baseIdSet, c.created_by);
      addSysChatMember(baseIdSet, c.assigned_to);
      addSysChatMember(baseIdSet, userId);
      const baseIds = [...baseIdSet];
      const nameRows = baseIds.length ? await dbAllAsync(`SELECT id, display_name, username FROM users WHERE id IN (${baseIds.map(() => '?').join(',')})`, baseIds) : [];
      const nameMap = new Map(nameRows.map(u => [u.id, u.display_name || u.username || `user#${u.id}`]));
      const base_members = baseIds.map(bid => ({ id: bid, display_name: nameMap.get(bid) || `user#${bid}` }));
      // 候选：active 非 viewer + 合法手机号 + 排 base（不返手机号本身）
      const actives = await dbAllAsync(`SELECT id, display_name, username, phone FROM users WHERE status = 'active' AND role != 'viewer' ORDER BY display_name`, []);
      const candidates = actives
        .filter(u => /^1\d{10}$/.test(String(u.phone || '').trim()) && !baseIdSet.has(Number(u.id)))
        .map(u => ({ id: u.id, display_name: u.display_name || u.username || `user#${u.id}` }));
      const reqPhone = String(c.requester_phone || '').trim();
      const requester = { name: c.requester_name || '报障人', eligible: /^1\d{10}$/.test(reqPhone) };
      res.json({ base_members, candidates, requester });
    } catch (err) { logger.error('[系统迭代] chat-candidates 失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '获取候选失败' }); }
  });

  router.post('/sys-issues/:id/create-chat', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const userId = Number(req.user.id);
    const userName = req.user.display_name || req.user.username || `user#${userId}`;
    const role = req.user.role;
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: '当前用户 id 非法', code: 'INVALID_USER_ID' });
    }
    try {
      const c = await dbGetAsync(
        `SELECT id, status, type, title, created_by, assigned_to, requester_name, requester_phone,
                dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name
           FROM sys_issues WHERE id = ?`, [id]);
      if (!c) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });

      // ── ① 校验顺序（M-6 第一步）：可见性鉴权 + 拉群权限（均 403，均在幂等/门槛之前，防泄露历史群）──
      const isAdmin = role === 'admin';
      const isCreator = Number(c.created_by) === userId && userId > 0;
      const isAssignee = Number(c.assigned_to) === userId && userId > 0;
      if (!isAdmin && !isCreator && !isAssignee) {
        return res.status(403).json({ error: '无权查看此迭代单', code: 'NOT_AUTHORIZED_TO_VIEW' });
      }
      // 拉群发起权：admin 或被指派开发本人（对接人白名单 = Commit ④ 再放开）
      if (!isAdmin && !isAssignee) {
        return res.status(403).json({ error: '仅管理员或被指派开发本人可发起拉群讨论', code: 'NOT_ALLOWED_TO_CREATE_CHAT' });
      }

      // 拉群 = bug 流特性（§5 属 bug流_方案）。防泄漏：待验证/待上线两态 bug/change 共用，仅靠状态门槛会漏放 feature/improvement，
      //   故显式 type='bug' 兜底（前端按钮亦 type==='bug' 才出）。将来若要放开到全类型：去此 guard + 状态门槛加 '开发中'。
      if (c.type !== 'bug') {
        return res.status(409).json({ error: '拉群讨论目前仅用于 BUG 类迭代单', code: 'CHAT_ONLY_FOR_BUG' });
      }

      // ── ② 幂等（M-1）：已建群直接返回现有群信息（先于描述/状态门槛——已建群无需再填议题，graceful 取历史群入口，对齐 correction）──
      if (c.dingtalk_open_conversation_id) {
        return res.json({
          message: '迭代单已有讨论群（请到钉钉客户端查看）',
          id, chat_id: c.dingtalk_chat_id, open_conversation_id: c.dingtalk_open_conversation_id,
          chat_name: c.dingtalk_chat_name, idempotent: true
        });
      }

      // ── ③ 描述必填（§5「填完才允许」，bug 流增量；trim 后非空、≤500）──
      const chatDesc = (typeof (req.body || {}).chat_desc === 'string') ? req.body.chat_desc.trim() : '';
      if (!chatDesc) return res.status(400).json({ error: '请填写拉群议题（讨论内容）后再发起', code: 'CHAT_DESC_REQUIRED' });
      if (chatDesc.length > 500) return res.status(400).json({ error: '拉群议题不超过 500 字', code: 'CHAT_DESC_TOO_LONG' });

      // ── ④ 状态门槛（仅未建群才校验）：仅指派后非终态可新建群 ──
      if (!SYS_CHAT_ALLOWED_STATUSES.includes(c.status)) {
        return res.status(409).json({
          error: `当前状态（${c.status}）不可发起拉群：未指派或已为终态`,
          code: 'CHAT_NOT_ALLOWED_IN_STATUS'
        });
      }

      // 取钉钉凭证（前置不可尝试 → 直接返错，不建群；对齐 collab/notify config→500/token→502）
      const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
      if (!appKey || !appSecret || !robotCode) {
        return res.status(500).json({ error: '钉钉配置未填写，请管理员先到系统配置 → 钉钉配置填写凭证', code: 'NO_DINGTALK_CONFIG' });
      }
      let token;
      try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, errcode: cls.errcode, errmsg: cls.errmsg, reason: cls.reason, code: 'GETTOKEN_FAILED' }); }

      // ── 成员构成：固定底座（不排 id=1）：群主示例用户A + 建单人 + 指派开发 + 发起人 ──
      const baseIdSet = new Set();
      addSysChatMember(baseIdSet, COLLAB_CHAT_ADMIN_ID);
      addSysChatMember(baseIdSet, c.created_by);
      addSysChatMember(baseIdSet, c.assigned_to);
      addSysChatMember(baseIdSet, userId);

      // ④b-2 额外选中成员（多选下拉，候选=系统用户有手机号；用户 7/3 拍板手动挑）：parsePositiveId 校验 + 去重(排 base) + 上限 30 防滥用。
      //   钉钉解析/存在性/active/viewer 校验在下方 selected 解析循环做（optional 成员：无效即跳过记 skipped，不阻断建群）。
      const selectedIdSet = new Set();
      const rawSel = Array.isArray((req.body || {}).member_user_ids) ? req.body.member_user_ids : [];
      if (rawSel.length > 30) return res.status(400).json({ error: '选中成员过多（≤30）', code: 'TOO_MANY_MEMBERS' });
      for (const raw of rawSel) { const sid = parsePositiveId(raw); if (sid && !baseIdSet.has(sid)) selectedIdSet.add(sid); }

      const allRefIds = [...new Set([...baseIdSet, ...selectedIdSet])];
      const userRows = allRefIds.length
        ? await dbAllAsync(`SELECT id, display_name, phone, dingtalk_user_id, status, role FROM users WHERE id IN (${allRefIds.map(() => '?').join(',')})`, allRefIds)
        : [];
      const userMap = new Map(userRows.map(u => [u.id, u]));
      const nameOf = (uid) => { const u = userMap.get(Number(uid)); return (u && u.display_name) || `user#${uid}`; };

      // 钉钉号解析（缺则手机号反查 + 回写；无手机号/格式非法/反查失败 → 返空，best-effort 降级；调用走 callDingtalkWithTokenRetry 抗 token 过期）
      async function resolveDing(u) {
        let ding = (u && u.dingtalk_user_id != null) ? String(u.dingtalk_user_id).trim() : '';
        if (ding) return ding;
        const phone = (u && u.phone != null) ? String(u.phone).trim() : '';
        if (!/^1\d{10}$/.test(phone)) return '';
        try {
          const raw = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getUserIdByMobile(t, phone));
          ding = raw != null ? String(raw).trim() : '';
          if (ding) await dbRunAsync(`UPDATE users SET dingtalk_user_id = ? WHERE id = ? AND (dingtalk_user_id IS NULL OR dingtalk_user_id = '')`, [ding, u.id]);
          return ding;
        } catch (err) {
          logger.warn(`[sys-create-chat] 迭代单 #${id} 成员 ${nameOf(u.id)} 钉钉号反查失败：${dingtalkNotify.classifyError(err).reason}，降级跳过`);
          return '';
        }
      }

      const memberDingList = [];                 // {userId, dingtalk_user_id, display_name}
      const seenDing = new Set();
      // [codex29 L-2] 元素 = { user_id, display_name } 对象数组（**非纯 id**），逐字复刻 correction create-chat 契约；
      //   字段名 missing_required_member_ids 保持与 correction 一致（降迁移认知负担），前端只取 .length 使用。
      const missingRequiredMemberIds = [];       // 固定底座缺钉钉号（strong warning，不阻断）
      for (const bid of baseIdSet) {
        const u = userMap.get(bid);
        if (!u) { missingRequiredMemberIds.push({ user_id: bid, display_name: `user#${bid}` }); continue; }   // 账号丢失（脏数据）
        const ding = await resolveDing(u);
        if (!ding) { missingRequiredMemberIds.push({ user_id: bid, display_name: u.display_name || `user#${bid}` }); continue; }
        if (!seenDing.has(ding)) { seenDing.add(ding); memberDingList.push({ userId: bid, dingtalk_user_id: ding, display_name: u.display_name || `user#${bid}` }); }
      }

      // ④b-2 选中成员解析（optional：不存在/非 active/viewer/无钉钉 → 跳过记 selectedSkipped，不阻断建群；dedup 钉钉，与底座/报障人同号视为已在群）
      const selectedAdded = [];
      const selectedSkipped = [];
      for (const sid of selectedIdSet) {
        const u = userMap.get(sid);
        if (!u || u.status !== 'active' || u.role === 'viewer') { selectedSkipped.push({ user_id: sid, reason: 'invalid_or_inactive' }); continue; }
        const ding = await resolveDing(u);
        if (!ding) { selectedSkipped.push({ user_id: sid, display_name: u.display_name || `user#${sid}`, reason: 'no_ding' }); continue; }
        if (seenDing.has(ding)) continue;   // 与底座/其他选中同钉钉 → 已在群，静默跳过
        seenDing.add(ding);
        memberDingList.push({ userId: sid, dingtalk_user_id: ding, display_name: u.display_name || `user#${sid}` });
        selectedAdded.push({ user_id: sid, display_name: u.display_name || `user#${sid}` });
      }

      // 报障人真人加入（requester_phone 反查，best-effort；不进 users 表故 userId=0；§6 报障人复用 requester_phone）
      //   报障人未加入是预期内常态降级（多不在企业钉钉），用独立 requester_included + requester_skip_reason 字段（对齐 correction M-2，不塞 warnings）。
      //   ④b-2：报障人改「opt-in」（用户 7/3 拍板报障人也走手动勾选下拉，非 ③ 的自动加）——仅 include_requester 时才反查加入。
      const includeRequester = ((req.body || {}).include_requester === true || (req.body || {}).include_requester === 1 || (req.body || {}).include_requester === '1');
      let requesterIncluded = false;
      let requesterSkipReason = includeRequester ? 'none' : 'not_selected';   // not_selected=未勾选 / none=已在群 / no_phone / not_found / lookup_failed
      if (includeRequester) {
        const reqPhone = String(c.requester_phone || '').trim();
        if (!reqPhone || !/^1\d{10}$/.test(reqPhone)) {
          requesterSkipReason = 'no_phone';
        } else {
          try {
            const raw = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getUserIdByMobile(t, reqPhone));
            const rDing = raw != null ? String(raw).trim() : '';
            if (!rDing) {
              requesterSkipReason = 'not_found';
            } else if (seenDing.has(rDing)) {
              requesterIncluded = true;   // 报障人钉钉号已在成员列表 → 已在群
            } else {
              seenDing.add(rDing);
              memberDingList.push({ userId: 0, dingtalk_user_id: rDing, display_name: `${c.requester_name || '报障人'}（报障人）` });
              requesterIncluded = true;
            }
          } catch (err) {
            requesterSkipReason = 'lookup_failed';
            logger.warn(`[sys-create-chat] 迭代单 #${id} 报障人手机号 ${maskPhone(c.requester_phone)} 反查失败：${dingtalkNotify.classifyError(err).reason}，降级不加报障人`);
          }
        }
      }

      // 群主 = 示例用户A（COLLAB_CHAT_ADMIN_ID）。未解析到（理论不发生，id=3 生产恒有）→ 无群主无法建群，硬失败
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
          code: 'NOT_ENOUGH_MEMBERS', missing_required_member_ids: missingRequiredMemberIds
        });
      }

      // 群名：[系统迭代]{title 摘要}-讨论（Array.from 按码点截断 ≤20，不截半个字，对齐 collab/issue/correction）
      const rawName = `[系统迭代]${String(c.title || ('#' + id)).trim()}-讨论`;
      const cp = Array.from(rawName);
      const chatName = cp.length > 20 ? cp.slice(0, 20).join('') : rawName;

      // 调钉钉建群（一次成型，走 callDingtalkWithTokenRetry 抗 token 过期）
      let chatRes;
      try { chatRes = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.createChatGroup(t, chatName, owner.dingtalk_user_id, memberDingList.map(m => m.dingtalk_user_id))); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); logger.warn(`[sys-create-chat] 迭代单 #${id} chat/create 异常：${cls.reason}`); return res.status(502).json({ error: cls.hint, errcode: cls.errcode, reason: cls.reason, code: 'CHAT_CREATE_FAILED' }); }
      if (!chatRes || chatRes.errcode !== 0) {
        const cls = dingtalkNotify.classifyError(chatRes || {});
        logger.warn(`[sys-create-chat] 迭代单 #${id} chat/create 拒绝 errcode=${chatRes && chatRes.errcode}`);
        return res.status(502).json({ error: cls.hint, errcode: chatRes && chatRes.errcode, reason: cls.reason, code: 'CHAT_CREATE_REJECTED' });
      }
      const newChatId = chatRes.chatid;
      const newOpenConvId = chatRes.openConversationId;
      // errcode=0 不代表群标识齐全——钉钉字段缺失/改名时 chatid/openConversationId 可能为空（H-1）。放任 null 落库会破坏幂等锚点 → 重复建群。
      //   群已建但无可用标识、平台无从落库（钉钉无解散 API），只能 CRITICAL 记原始响应供排查后返 502。
      if (!newChatId || !String(newChatId).trim() || !newOpenConvId || !String(newOpenConvId).trim()) {
        let chatResRaw = ''; try { chatResRaw = JSON.stringify(chatRes).slice(0, 500); } catch (_) { chatResRaw = '[unserializable]'; }
        logger.error(`[sys-create-chat] CRITICAL 迭代单 #${id} chat/create 返 errcode=0 但群标识缺失 chatid=${newChatId} open_conversation_id=${newOpenConvId}（钉钉响应字段契约异常，群可能已建出无法关联）raw=${chatResRaw}`);
        return res.status(502).json({ error: '钉钉建群返回异常（群标识缺失），请稍后重试或联系管理员', code: 'CHAT_CREATE_BAD_RESPONSE' });
      }

      // 旁路 UPDATE 6 群字段 + 双 WHERE 守卫（open_conversation_id IS NULL 防并发 + status IN 守卫防建群期间流转出可拉态）。
      //   不走 transition / 不动 status / 不写 timeline（§5 旁路）。sys 作废态用 status='已作废'（在 allowed 集外），故 status IN 已兼作废守卫。
      let upd;
      try {
        upd = await dbRunAsync(
          `UPDATE sys_issues
              SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ?,
                  dingtalk_chat_created_at = datetime('now','localtime'), dingtalk_chat_created_by = ?,
                  dingtalk_chat_name = ?, dingtalk_chat_desc = ?
            WHERE id = ? AND dingtalk_open_conversation_id IS NULL
              AND status IN (${SYS_CHAT_ALLOWED_STATUSES.map(() => '?').join(',')})`,
          [newChatId, newOpenConvId, userId, chatName, chatDesc, id, ...SYS_CHAT_ALLOWED_STATUSES]);
      } catch (dbErr) {
        logger.error(`[sys-create-chat] CRITICAL 钉钉群已建但落库异常 sys_issue_id=${id} chatid=${newChatId} open_conversation_id=${newOpenConvId} chat_name=${chatName} created_by=${userId}(${userName}) error=${dbErr.message}`);
        return res.status(500).json({ error: '钉钉群已创建但平台落库失败，请联系管理员手工补录（详见后端日志）', code: 'CHAT_CREATED_DB_UPDATE_FAILED', chat_id: newChatId, open_conversation_id: newOpenConvId, chat_name: chatName });
      }
      if (!upd || upd.changes === 0) {
        // 守卫未过：并发抢先落库 或 建群期间流转出可拉态/被作废
        const refreshed = await dbGetAsync('SELECT status, dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_name FROM sys_issues WHERE id = ?', [id]);
        if (refreshed && refreshed.dingtalk_open_conversation_id) {
          logger.warn(`[sys-create-chat] 并发竞态：迭代单 #${id} 另一请求已先落库（${refreshed.dingtalk_chat_id}），本次新建群 chatid=${newChatId} 丢弃`);
          return res.json({ message: '迭代单已有讨论群（您本次新建的群因并发竞态被舍弃，请群主在钉钉客户端解散）', id, chat_id: refreshed.dingtalk_chat_id, open_conversation_id: refreshed.dingtalk_open_conversation_id, chat_name: refreshed.dingtalk_chat_name, idempotent: true, race_dropped_chat_id: newChatId });
        }
        logger.error(`[sys-create-chat] STATE_CHANGED 迭代单 #${id} 建群期间流转出可拉态/被作废 chatid=${newChatId} open_conversation_id=${newOpenConvId} created_by=${userId}(${userName})`);
        return res.status(409).json({ error: '迭代单状态已变化（可能已流转/作废），群已建出但未关联，请群主在钉钉客户端手动解散', code: 'STATE_CHANGED', chat_id: newChatId, open_conversation_id: newOpenConvId });
      }
      logger.info(`[sys-create-chat] 迭代单 #${id} 拉群成功 by ${userName} chatid=${newChatId}（成员 ${memberDingList.length}）`);

      // 发欢迎卡片（best-effort，含拉群议题 chat_desc；失败不影响建群）
      try {
        const esc = dingtalkNotify.escapeMarkdown;
        const cardTitle = `系统迭代讨论群 #${id}`;
        const cardMd = [
          `## 系统迭代讨论群已创建`, ``,
          `**标题**：${esc(String(c.title || '-'))}`,
          `**议题**：${esc(chatDesc)}`,
          `**拉群人**：${esc(userName)}`, ``,
          `> 请相关方在群内同步上下文，推进本迭代单处理。`
        ].join('\n');
        const cardResp = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.sendGroupMessage(t, robotCode, newOpenConvId, 'sampleMarkdown', { title: cardTitle, text: cardMd }));
        if (cardResp && cardResp.code) logger.warn(`[sys-create-chat] #${id} 群卡片发送失败 code=${cardResp.code}`);
      } catch (err) { logger.warn(`[sys-create-chat] #${id} 群消息发送异常（不影响建群）：${err.message}`); }

      return res.json({
        message: '讨论群已创建，请到钉钉客户端查看（钉钉无解散接口，使用完后由群主在客户端手动解散）',
        id, chat_id: newChatId, open_conversation_id: newOpenConvId, chat_name: chatName,
        member_count: memberDingList.length, idempotent: false,
        missing_required_member_ids: missingRequiredMemberIds,
        requester_included: requesterIncluded,
        requester_skip_reason: requesterSkipReason,
        selected_added: selectedAdded.length,      // ④b-2 选中成员成功加入数
        selected_skipped: selectedSkipped           // ④b-2 选中但跳过（无效/无钉钉），供前端提示
      });
    } catch (e) {
      logger.error(`[sys-create-chat] 迭代单 #${id} 拉群异常: ${e.message}`, e);
      return res.status(500).json({ error: '拉群失败，请联系管理员', code: 'CREATE_CHAT_FAILED' });
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
        // ④ bug 对接人白名单：除本人被指派单外，额外可见**全部 bug 单**（type='bug'）——对接人需看到待处理 bug
        //   才能指派/换人（§3 全局白名单，无每单绑定）。⚠️ 必与详情读端同源（[[feedback_write_read_same_semantic]]，
        //   下方详情端点同步放行 bug 对接人），否则「列表看不到但能开详情」写读不一致。移出白名单即失去此可见性。
        if (isSysBugLiaison(uid)) {
          where.push("(assigned_to = ? OR type = 'bug')");
          params.push(uid);
        } else {
          // 非 admin 非对接人：仅自己被指派的单（开发）；其他角色 assigned_to 不会等于自己 → 自然空集
          where.push('assigned_to = ?');
          params.push(uid);
        }
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
                created_by, created_by_name, origin_issue_id, release_id, needs_release,
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
      // ④ bug 对接人白名单：与列表读端同源（[[feedback_write_read_same_semantic]]）——白名单对接人可见 bug 单详情
      //   （type='bug'）。移出白名单即失效；非 bug 单（变更流/config）对接人仍不可见（type 精判）。
      const isBugLiaison = isSysBugLiaison(uid) && row.type === 'bug';
      if (!isAdmin && !isAssignee && !isBugLiaison) {
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

      // §7 关联修正单号软提示（bug 流 Commit ④，不硬校验不 join）：related_correction_no 是自由文本软引用，
      //   best-effort 单独轻查 correction_requests（纯数字→按 id / 否则→按 oa_number 匹配），查到回状态（active/voided）、
      //   查不到回 not_found，异常吞为 null（correction 表不存在/查询失败均不影响详情主体）。前端据此显「已作废/未找到」提示。
      let relatedCorrection = null;
      if (row.related_correction_no) {
        try {
          const rcNo = String(row.related_correction_no).trim();
          let cr = null, matchedBy = null;
          if (/^[1-9]\d{0,8}$/.test(rcNo)) {
            cr = await dbGetAsync('SELECT id, voided_at FROM correction_requests WHERE id = ?', [Number(rcNo)]);
            if (cr) matchedBy = 'id';
          }
          if (!cr) {
            cr = await dbGetAsync('SELECT id, voided_at FROM correction_requests WHERE oa_number = ?', [rcNo]);
            if (cr) matchedBy = 'oa_number';
          }
          // [codex 审 30 M-2] 回 matched_by 消歧（纯数字优先按修正单 id / 否则按 oa_number），供前端显式展示「按 ID / 按 OA 号」匹配，
          //   避免「全数字 OA 号 coincidentally 撞某 correction id」时软提示误导用户。仍是 best-effort 软引用（不硬校验不 join）。
          relatedCorrection = cr
            ? { found: true, status: cr.voided_at ? 'voided' : 'active', id: cr.id, matched_by: matchedBy }
            : { found: false, status: 'not_found', matched_by: null };
        } catch (e) { relatedCorrection = null; /* 软查失败（含 correction 表不存在）不影响详情主体 */ }
      }

      // 12-M2（A7）：具名 spec 子集 + 布尔，使前端补传入口刷新不丢、不依赖临时前端状态
      const specAttachments = attachments.filter(a => a.attachment_type === 'spec');
      res.json({ issue: row, timeline, attachments, specAttachments, hasSpecAttachment: specAttachments.length > 0, origin_issue: originIssue, derived_issues: derivedIssues, related_correction: relatedCorrection });
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
  // bug 流 Commit ②：确认上线·不发版（建单人/admin，release_id 保持 NULL 不建批次，§8.2 [审:H1]）
  router.post('/sys-issues/:id/confirm-online-norelease', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('confirm-online-norelease'));

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

  // ── POST /sys-issues/:id/set-release-flag：填发版信息（开发本人，不改 status，旁路独立事务，bug §2.3/§8.1）──────────
  //   needs_release 唯一写点（K1/K2）：仅本端点可写；枚举校验 0/1；release_id 已挂批次后禁改（防绕过 add-issues 一致性）。
  router.post('/sys-issues/:id/set-release-flag', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const raw = (req.body || {}).needs_release;
    if (raw !== 0 && raw !== 1) return res.status(400).json({ error: 'needs_release 仅支持 0（不发版）/1（发版）', code: 'INVALID_NEEDS_RELEASE' });
    try {
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to, release_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // set_release_flag 合法前置态（bug 流：待上线；findTransition 天然限定 type=bug，feature/improvement 无此常量条目）
        const t = T.findTransition(row.type, 'set_release_flag', row.status);
        if (!t) { await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可填发版信息`, code: 'SET_RELEASE_FLAG_STATUS_INVALID' }); }
        const isAssignee = Number(row.assigned_to) === actor.id && actor.id > 0;
        if (!isAssignee) { await sysRollback(); return res.status(403).json({ error: '仅被指派开发本人可填发版信息', code: 'NOT_AUTHORIZED_FOR_TRANSITION' }); }
        if (row.release_id !== null) { await sysRollback(); return res.status(409).json({ error: '该单已挂上线批次，不能再改发版信息', code: 'ISSUE_ALREADY_IN_RELEASE' }); }
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET needs_release = ?, updated_at = datetime('now','localtime')
             WHERE id = ? AND status = ? AND assigned_to = ? AND release_id IS NULL`,
          [raw, id, row.status, actor.id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'status_change', ?, 'set_release_flag', ?, ?)`,
          [id, raw === 1 ? '发版' : '不发版', actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, needs_release: raw });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 填发版信息失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '填发版信息失败' });
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
      // 新单字段校验（同建单口径）——[⑤] type 校验推迟到事务内：M5「origin.type='bug' 时默认 new.type='bug'」
      //   须先读到 origin 才能定默认，故此处只读原始值，ALLOWED_STATUSES 校验移入事务（见下）。
      const rawType = (typeof b.type === 'string' ? b.type.trim() : '');
      const title = (typeof b.title === 'string' ? b.title.trim() : '');
      if (!title) return res.status(400).json({ error: '标题必填', code: 'TITLE_REQUIRED' });
      const systemName = (typeof b.system_name === 'string' ? b.system_name.trim() : '');
      if (!T.BIZ_SYSTEMS.includes(systemName)) return res.status(400).json({ error: '所属系统非法', code: 'INVALID_SYSTEM_NAME', allowed: T.BIZ_SYSTEMS });
      const source = (typeof b.source === 'string' ? b.source.trim() : '');
      if (!['业务方', '内部', '生产故障'].includes(source)) return res.status(400).json({ error: '来源必填（业务方/内部/生产故障）', code: 'SOURCE_REQUIRED' });
      const priority = (b.priority && ['P0', 'P1', 'P2', 'P3'].includes(b.priority)) ? b.priority : 'P2';
      const dl = normalizeDeadline(b.deadline);
      if (!dl.ok) return res.status(400).json({ error: '预期完成日期格式非法', code: 'INVALID_DEADLINE' });
      // [⑤ §4 双描述·Q2 合并] derive_reason 取代旧 derive_note：既落新单 derive_reason 列、又作 derive timeline summary。
      //   必填范围（Q1）= 仅 bug 语境（origin.type='bug'），feature→feature 派生保持选填——精判在事务内（需 origin.type）。
      const deriveReason = (typeof b.derive_reason === 'string' ? b.derive_reason.trim() : '');

      const actor = sysActor(req);
      let newId = null, resolvedType = null, resolvedStatus = null;
      await sysBeginImmediate();
      try {
        // 原单须存在（[⑤] SELECT 补 status——M5 反向约束需判 origin.status）
        const origin = await dbGetAsync('SELECT id, type, status, origin_issue_id FROM sys_issues WHERE id = ?', [originId]);
        if (!origin) { await sysRollback(); return res.status(404).json({ error: '原单不存在', code: 'ORIGIN_NOT_FOUND' }); }
        // [⑤ §4 M5] 类型默认 + 反向约束 + derive_reason 必填（三者都依赖 origin.type='bug' 精判，故置于原单读取后）：
        //   · origin=bug 时默认 new.type='bug'（M5「默认 new.type='bug'」；跨类型 bug→feature 由调用方显式传 type='feature'）
        //   · type 校验推迟至此（默认解析后再校 ALLOWED_STATUSES，防省略 type 的 bug 派生被误 400）
        //   · origin=bug ⟹ origin.status 必须「已上线」（§4「仅从已上线单发起」，非上线单派生 bug=脏谱系）
        //   · origin=bug ⟹ derive_reason 必填（Q1 仅 bug 语境；feature→feature 派生保持选填）
        const originIsBug = origin.type === 'bug';
        const type = rawType || (originIsBug ? 'bug' : '');
        if (!T.ALLOWED_STATUSES[type]) { await sysRollback(); return res.status(400).json({ error: `类型暂不支持（当前支持 ${Object.keys(T.ALLOWED_STATUSES).join('/')}）`, code: 'TYPE_NOT_SUPPORTED', allowed: Object.keys(T.ALLOWED_STATUSES) }); }
        if (originIsBug && origin.status !== '已上线') { await sysRollback(); return res.status(409).json({ error: 'bug 类单仅可从「已上线」派生（上线后再出问题才派生新单）', code: 'SYS_DERIVE_ORIGIN_NOT_ONLINE' }); }
        if (originIsBug && !deriveReason) { await sysRollback(); return res.status(400).json({ error: '派生自 bug 的单需填写派生原因', code: 'DERIVE_REASON_REQUIRED' }); }
        const initialStatus = T.INITIAL_STATUS_BY_TYPE[type];
        resolvedType = type; resolvedStatus = initialStatus;   // 供事务外 201 响应体
        // M-1 防环：沿 origin 链回溯，链深阈值 + 不成环（新单尚未建，故只回溯原单祖先链，确保有限）
        let cursor = origin.origin_issue_id, depth = 0;
        while (cursor) {
          if (Number(cursor) === Number(originId)) { await sysRollback(); return res.status(409).json({ error: '派生会形成血缘环', code: 'DERIVE_CYCLE' }); }
          if (++depth > DERIVE_MAX_CHAIN_DEPTH) { await sysRollback(); return res.status(409).json({ error: '血缘链过深（疑似异常）', code: 'DERIVE_CHAIN_TOO_DEEP' }); }
          const parent = await dbGetAsync('SELECT origin_issue_id FROM sys_issues WHERE id = ?', [cursor]);
          cursor = parent ? parent.origin_issue_id : null;
        }
        // 建新单（origin_issue_id = 原单 id；[⑤] 落 derive_reason 列——feature 派生留空则存 NULL）
        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline, origin_issue_id, derive_reason,
              created_by, created_by_name, record_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value, originId, (deriveReason || null), actor.id, actor.name]
        );
        newId = result.lastID;
        // T-L3：先写 created（新单建立，to_status=初始态），再写 derive（ref_id=原单 id），同事务、created 在前
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
          [newId, initialStatus, `派生自 #${originId}`, actor.id, actor.name]
        );
        // [⑤ Q2] derive timeline summary = derive_reason（取代旧 derive_note）；feature 派生留空则回退默认文案
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, ref_id, operator_id, operator_name)
           VALUES (?, 'derive', ?, ?, ?, ?)`,
          [newId, deriveReason || `派生自 #${originId}`, originId, actor.id, actor.name]
        );
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.status(201).json({ id: newId, origin_issue_id: originId, type: resolvedType, status: resolvedStatus });
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
      const row = await dbGetAsync('SELECT id, type, status, assigned_to FROM sys_issues WHERE id = ?', [id]);
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

      // delivery / screenshot（开发交付物，11-H2）：仅被指派开发本人 + 开发工作态（round_no=NULL 暂存，submit 绑）。
      //   bug 流 Commit ①（[审:M4]）：'开发中' 硬编码 → T.isDevWorkState(type,status)（变更流=开发中 / bug=处理中），
      //   否则 bug 单开发在 处理中 无法上传交付附件（submit 绑定链路断）。
      if (!isAssignee) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '交付附件仅被指派开发本人可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
      if (!T.isDevWorkState(row.type, row.status)) { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '仅开发进行状态（开发中/处理中）可上传交付附件', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
      if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
      persisted = await sysPersistAttachments(id, files, attachmentType, null, actor);
      // TOCTOU 二次守卫：persist 后重读仍处开发工作态 且 assigned_to 未变（校验→INSERT 间被打回/作废/改派则回滚；type 不可变，用首读值）
      const recheck = await dbGetAsync('SELECT status, assigned_to FROM sys_issues WHERE id = ?', [id]);
      if (!recheck || !T.isDevWorkState(row.type, recheck.status) || Number(recheck.assigned_to) !== actor.id) {
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
  // bug 流 Commit ② 起 'bug' 恢复可进批次/hotfix（① 曾临时收窄防 needs_release 未填被误发）：
  //   闸门收敛到「bug 类型的 needs_release 必须=1」——add-issues/hotfix-publish/_publishReleaseCoreInTxn
  //   三处写入口均同步加 needs_release=1 校验（K1，运行时防线，旧库 ALTER 无 CHECK）+ release_type 批次隔离
  //   （§8.3 [审:L1]，add-issues 校一致禁混批）。config 不进批次（§6.1）不变。
  const RELEASABLE_TYPES = ['feature', 'improvement', 'bug'];

  // ── D-A（codex H-1 + ultracode CT-1，用户 2026-07-03 拍板）：批次按「族别」隔离，非精确 type ──────────
  //   隔离的**唯一真实理由** = bug 有 needs_release（发版/不发版）语义、feature/improvement 没有；
  //   而 feature 与 improvement 共用 CHANGE_FLOW_TRANSITIONS、上线语义逐字相同，拆开零收益纯摩擦，
  //   且已上线 C4 允许 feature+improvement 同批（保住「一个版本=一个批次」）。故 release_type 存**族别**
  //   `'bug'` / `'change'`（非精确 type）：`bug`→'bug'，`feature`/`improvement`→'change'，`config` 永不进批次。
  //   这同时消解 codex H-2（历史 release_type=NULL 混批未 fail-closed）——历史批次（bug 流未上线前只可能含
  //   feature/improvement）全归 'change'，不再有 NULL-mixed 哑弹。
  const RELEASE_FAMILY_BY_TYPE = { bug: 'bug', feature: 'change', improvement: 'change' };
  const releaseFamilyOf = (type) => RELEASE_FAMILY_BY_TYPE[type] || null;   // config/未知 → null（不可进批次）

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
    const rel = await dbGetAsync('SELECT id, status, release_note, version_tag, release_type FROM sys_releases WHERE id = ?', [releaseId]);
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
    const members = await dbAllAsync('SELECT id, status, type, needs_release FROM sys_issues WHERE release_id = ?', [releaseId]);
    if (members.length === 0) throw new SysTransitionError(409, 'RELEASE_EMPTY', '批次内无待上线单，不能发布');
    const bad = members.find(m => m.status !== '待上线');
    if (bad) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_READY', `批次内 #${bad.id} 非「待上线」（当前「${bad.status}」），请先移除`);
    // B（codex M-2）：core 内再校成员 type∈可发布3类，与 add-issues 入口防线一致（纵深防脏库/旧表缺 CHECK/手工修库）。
    //   正常 schema 下 config 受 DB CHECK(type<>'config' OR release_id IS NULL) 永不可成为成员，此守卫为 schema 漂移兜底（对齐 submit 闸门"不全信单入口"哲学）。
    const badType = members.find(m => !RELEASABLE_TYPES.includes(m.type));
    if (badType) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_RELEASABLE', `批次内 #${badType.id} 类型不可发布（${badType.type}），请先移除`);
    // bug 流 Commit ②（K1 纵深防线，同 badType 哲学）：批次内 bug 必须 needs_release=1——不发版单走
    //   confirm-online-norelease 专用 transition，理论上不该进批次（add-issues 已挡），此处防 schema 漂移/手工改库。
    const badBugRelease = members.find(m => m.type === 'bug' && m.needs_release !== 1);
    if (badBugRelease) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_RELEASABLE', `批次内 #${badBugRelease.id} 未标记「发版」（needs_release≠1），不能进批次`);
    // 族别一致性纵深防线（D-A：bug vs 非bug，codex H-2 fail-closed）：**从成员推导族别强制校验，不依赖存的 release_type**——
    //   ① 组内成员族别必须唯一（bug 与非 bug 不能混）——覆盖历史 release_type=NULL 混批批次（发布前也挡住）；
    //   ② release_type 已存且与成员实际族别不符（脏库/手工改）也拒。config 已被 badType 挡（releaseFamilyOf 返 null 亦不计入）。
    const memberFamilies = [...new Set(members.map(m => releaseFamilyOf(m.type)).filter(Boolean))];
    if (memberFamilies.length > 1) {
      throw new SysTransitionError(409, 'RELEASE_MEMBER_TYPE_MISMATCH', '批次内混了 bug 与非 bug 单，不能发布（请拆分）');
    }
    if (rel.release_type && memberFamilies[0] && memberFamilies[0] !== rel.release_type) {
      throw new SysTransitionError(409, 'RELEASE_MEMBER_TYPE_MISMATCH', `批次族别（${rel.release_type}）与成员实际族别（${memberFamilies[0]}）不符，请核对`);
    }
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
  //   闸门：批次「计划中」+ 每单「待上线」AND release_id IS NULL AND type∈可发布3类（防多批次抢占/config 混入）+
  //   bug 类型须 needs_release=1（K1）+ release_type **族别**隔离（D-A：bug vs 非bug，feature/improvement 可同批）。
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
        const rel = await dbGetAsync('SELECT id, status, release_type FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能加单', code: 'RELEASE_NOT_PLANNING' }); }
        // ── release_type 族别隔离（D-A：bug vs 非bug）──────────
        //   本次入参族别须唯一（bug 与 feature/improvement 不能混选）；与批次已定族别一致；
        //   批次族别未定（新批次 / 历史 NULL 批次）时，**连读已有成员族别一并判定**（codex H-2 fail-closed：
        //   不只看本次入参，防历史混批被本次入参回填成错误族别）。feature+improvement 同族 'change' 可共批。
        const idPh = issueIds.map(() => '?').join(',');
        const typeRows = await dbAllAsync(`SELECT id, type FROM sys_issues WHERE id IN (${idPh})`, issueIds);
        const newFamilies = [...new Set(typeRows.map(r => releaseFamilyOf(r.type)).filter(Boolean))];
        if (newFamilies.length > 1) {
          await sysRollback();
          return res.status(409).json({ error: '本次加单混了 bug 与非 bug，不能同批（bug 单独成批）', code: 'MIXED_TYPE_BATCH' });
        }
        const newFam = newFamilies[0] || null;
        let targetFamily = rel.release_type;
        if (targetFamily) {
          if (newFam && newFam !== targetFamily) {
            await sysRollback();
            return res.status(409).json({ error: `本次加单族别（${newFam}）与批次族别（${targetFamily}）不一致，不能混批`, code: 'RELEASE_TYPE_MISMATCH' });
          }
        } else {
          // 批次族别未定：读已有成员族别（H-2）——历史 NULL 批次可能已有成员，须一并判唯一族别。
          const existRows = await dbAllAsync('SELECT DISTINCT type FROM sys_issues WHERE release_id = ?', [id]);
          const existFamilies = [...new Set(existRows.map(r => releaseFamilyOf(r.type)).filter(Boolean))];
          const combined = [...new Set([...existFamilies, ...(newFam ? [newFam] : [])])];
          if (combined.length > 1) {
            await sysRollback();
            return res.status(409).json({ error: '批次已有成员与本次加单族别不一致，不能混批（请分批或清空后重来）', code: 'RELEASE_TYPE_MISMATCH' });
          }
          targetFamily = combined[0] || null;   // 全部 id 无效且批次空 → null，交由下方逐单 UPDATE 自然失败
        }
        // 逐单 UPDATE：可发布类型 + bug 须 needs_release=1 + 族别闸门（targetFamily='bug'→只收 bug；='change'→只收非 bug）。
        const famClause = targetFamily === 'bug' ? "AND type = 'bug'" : (targetFamily === 'change' ? "AND type <> 'bug'" : '');
        for (const iid of issueIds) {
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime')
               WHERE id = ? AND status = '待上线' AND release_id IS NULL AND type IN (${typePh})
                 AND (type <> 'bug' OR needs_release = 1) ${famClause}`,
            [id, iid, ...RELEASABLE_TYPES]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${iid} 不可加入（须为未挂批次的「待上线」单、非配置类、与批次族别一致，bug 须已标记「发版」）`, code: 'ISSUE_NOT_ADDABLE', issue_id: iid });
          }
        }
        // 批次族别首次落定（release_type 原为空）——同事务内回填族别，changes 校验兜底（F-5，防未来绕过 mutex 的写路径）。
        if (!rel.release_type && targetFamily) {
          const back = await dbRunAsync('UPDATE sys_releases SET release_type = ? WHERE id = ? AND release_type IS NULL', [targetFamily, id]);
          if (!back || back.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: '批次族别落定冲突，请刷新重试', code: 'RELEASE_TYPE_BACKFILL_CONFLICT' });
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
        // F-4（ultracode SM-3）：批次被移空后复位 release_type=NULL，让空批次回到「未定族别」态可被任意族别重新占用，
        //   否则残留旧族别 → 复用该空批次加异族单时报「族别不一致」对空批次令人费解、且批次删不掉发不出（锁死）。
        await dbRunAsync(
          `UPDATE sys_releases SET release_type = NULL
             WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sys_issues WHERE sys_issues.release_id = ?)`,
          [id, id]
        );
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
        const issue = await dbGetAsync('SELECT id, status, release_id, type, needs_release FROM sys_issues WHERE id = ?', [issueId]);
        if (!issue) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // C（codex L-2）：类型判断用 RELEASABLE_TYPES 白名单（与 add-issues 同源，防未来加类型漂移）；config 保留特化错误码。
        //   bug 自 Commit ② 起为 hotfix 发版主路径（RELEASABLE_TYPES 已恢复含 bug），但须 needs_release=1（K1，见下）。
        if (!RELEASABLE_TYPES.includes(issue.type)) {
          await sysRollback();
          return res.status(409).json(issue.type === 'config'
            ? { error: '配置类不进上线批次', code: 'CONFIG_NO_RELEASE' }
            : { error: `该类型暂不可进上线批次（当前仅 ${RELEASABLE_TYPES.join('/')}）`, code: 'TYPE_NOT_RELEASABLE' });
        }
        if (issue.status !== '待上线' || issue.release_id !== null) {
          await sysRollback();
          return res.status(409).json({ error: '该单非「待上线」或已挂批次，不能 hotfix', code: 'ISSUE_NOT_HOTFIXABLE' });
        }
        // bug 流 Commit ②（K1）：bug 走 hotfix 前必须已在「填发版信息」标记 needs_release=1；
        //   未填(NULL)/标了不发版(0) 应走 confirm-online-norelease，不能绕过发版闸门。
        if (issue.type === 'bug' && issue.needs_release !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '该 bug 未标记「发版」，不能走 hotfix 上线（请先在「填发版信息」选择「发版」，或走「确认上线·不发版」）', code: 'BUG_NEEDS_RELEASE_NOT_SET' });
        }
        releaseNo = await nextReleaseNo();
        const relIns = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag, created_by, created_by_name, release_type)
           VALUES (?, ?, '计划中', 1, ?, ?, ?, ?, ?)`,
          [releaseNo, `hotfix #${issueId}`, releaseNote, versionTag, actor.id, actor.name, releaseFamilyOf(issue.type)]   // D-A：存族别（bug→'bug' / feature·improvement→'change'）
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
      // [ultracode nit] bug 用「问题修复」口径，变更流用「需求上线」口径（同一 released 分支按 type 分叉文案）
      if (issue.type === 'bug') {
        return {
          title: `✅ 您反馈的问题已修复上线：${safeTitle}`,
          md: `### ✅ 您反馈的问题已修复并上线\n\n- **系统**：${system}\n- **问题**：${title}${verLine}\n\n问题已修复并上线，感谢您的反馈。${link}`,
        };
      }
      return {
        title: `🚀 您的需求已上线：${safeTitle}`,
        md: `### 🚀 您的需求已上线\n\n- **系统**：${system}\n- **需求**：${title}${verLine}\n\n相关功能已上线，感谢您的支持。${link}`,
      };
    }
    if (kind === 'progress') {
      // ④b-1 bug 手动通知报障人·进展卡片（非已上线态；已上线走 released 分支）——当前状态告知，best-effort 手动触发
      return {
        title: `📣 您反馈的问题有进展：${safeTitle}`,
        md: `### 📣 问题处理进展\n\n- **系统**：${system}\n- **问题**：${title}\n- **当前状态**：${issueNotify.issueSafeText(issue.status, 20)}\n\n信息技术部正在跟进处理，感谢您的反馈。${link}`,
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
      // ── ④b-1 bug 流通知改「手动点按钮触发」──：跳过一切自动派发（bug 走 notify-developer/notify-requester 手动端点）。
      //   ⚠️ 只对 type='bug' 早返回——变更流(feature/improvement) 仍自动派发（其 auto→手动改造另立专用 commit，见 backlog）；
      //   config 追加时再定。这是本 commit 唯一改变 dispatchSysNotify 行为处，变更流零回归靠此 type 门限精确隔离。
      if (issue.type === 'bug') return;
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
  // 三·六、④b-1 bug 流手动通知端点（复刻 correction notify-* 手动范式；§6 手动链式）
  //   bug 流通知不自动派发（dispatchSysNotify 对 bug 早返回），改由 admin/对接人在详情页手动点按钮触发。
  //   复用 C5 发送/落库原语（sendSysDevNotify / sendSysRequesterNotify → recordSys*Notify 三侧隔离落库）。
  //   权限 requireAdminOrBugLiaison 粗筛（admin 或对接人白名单）+ handler type='bug' 精判（变更流无手动端点，仍自动）。
  //   建单人侧（creator）不做手动端点：native 建单人=admin=示例用户A本人，self 不通知（feedback_no_self_notify）。
  // ============================================================

  // ── [codex31/ultracode ④b-1 复审] 手动通知状态闸门（**后端真闸=权威**；前端按钮硬编码镜像同一状态集=非授权源，改一侧须同步另一侧，对齐本模块 SI_CHAT_STATUSES/白名单前端镜像范式；复刻 issue-tracker STATUS_NOT_NOTIFIABLE 范式 server.js:11321）──
  //   ⚠️ 两审收敛核心：前端按钮受 SI_CHAT_STATUSES 收窄，但后端原缺状态闸门→直连 API/前端态过期可对终态 bug 发矛盾通知。
  //   通知开发仅「处理中」（开发在干活态；待验证/待上线非其回合，指派/返工模板不适用，避免陈旧误导，含 ultracode external-api nit）。
  //   通知报障人：受理后活跃态 + 已上线（排 待处理[未受理无进展]/已拒绝/已作废[终态"正在跟进"矛盾卡片]）。
  const SYS_NOTIFY_DEV_STATUSES = ['处理中'];
  const SYS_NOTIFY_REQUESTER_STATUSES = ['处理中', '待验证', '待上线', '已上线'];

  //   通知开发（dev 侧 notify_*）：需已指派 + status='处理中'；模板按 return_count 选（返工 vs 首次指派，[ultracode devil MED]）。
  router.post('/sys-issues/:id/notify-developer', authenticateToken, requireSysSchemaReady, requireAdminOrBugLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      if (issue.type !== 'bug') return res.status(400).json({ error: '手动通知仅用于 bug 单', code: 'MANUAL_NOTIFY_BUG_ONLY' });   // 变更流仍自动派发
      if (!issue.assigned_to) return res.status(409).json({ error: '尚未指派开发，无法通知', code: 'NO_ASSIGNEE_TO_NOTIFY' });
      if (!SYS_NOTIFY_DEV_STATUSES.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知开发（仅处理中）`, code: 'STATUS_NOT_NOTIFIABLE' });
      // [ultracode devil MED] bug 打回返工后仍在「处理中」但 return_count>0 → 用返工模板（否则发陈旧「指派/请回填」误导；auto 路径原 return 的 notifyReturnedToDeveloper 被 bug 早返回吞掉，此处手动补偿）。
      //   [codex 复审 M-1·有意接受] 若「打回后改派新开发」（return_count 保留），新开发点通知也走返工模板——内容「查看打回原因·返工后重新提交」对新接手者仍成立（bug 确需返工），不引「被打回者本人」精判字段（避免为边角加 schema）。verify [Rework2] 锁定此语义。
      const marker = (Number(issue.return_count) > 0) ? 'notifyReturnedToDeveloper' : 'notifyAssignedDeveloper';
      const baseUrl = await getSafePlatformBaseUrl();
      await sendSysDevNotify(issue, marker, baseUrl);   // 落库 notify_*（sent/failed，best-effort 内部处理）
      const fresh = await dbGetAsync('SELECT notify_status, notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, notify_status: fresh.notify_status, notify_error: fresh.notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知开发失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知开发失败' }); }
  });

  //   通知报障人（requester 侧 requester_notify_*，进展/已上线卡片）：需有报障人手机号（sendSysRequesterNotify 内亦有"无报障人保持 not_sent"守卫）。
  router.post('/sys-issues/:id/notify-requester', authenticateToken, requireSysSchemaReady, requireAdminOrBugLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      if (issue.type !== 'bug') return res.status(400).json({ error: '手动通知仅用于 bug 单', code: 'MANUAL_NOTIFY_BUG_ONLY' });
      if (!SYS_NOTIFY_REQUESTER_STATUSES.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知报障人`, code: 'STATUS_NOT_NOTIFIABLE' });   // 排终态矛盾卡片（复审）
      if (!issue.requester_phone) return res.status(409).json({ error: '无报障人手机号，无法通知', code: 'NO_REQUESTER_PHONE' });   // 显式前置拦（避免误落 failed）
      const baseUrl = await getSafePlatformBaseUrl();
      const kind = issue.status === '已上线' ? 'released' : 'progress';   // 已上线走 released（带版本，release_id=NULL 时 sendSysRequesterNotify 优雅降级无版本行），否则 progress（当前状态）
      await sendSysRequesterNotify(issue, kind, baseUrl);   // 落库 requester_notify_*
      const fresh = await dbGetAsync('SELECT requester_notify_status, requester_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, requester_notify_status: fresh.requester_notify_status, requester_notify_error: fresh.requester_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知报障人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知报障人失败' }); }
  });

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
    // bug 流 Commit ③：真钉钉建群（verify-sys-create-chat require 真实逻辑，防漂移）
    SYS_CHAT_ALLOWED_STATUSES,
    addSysChatMember,
    syncSysChatAddDev,   // [codex29 M-1] 导出供 verify 直测真函数「绝不抛」契约
    // bug 流 Commit ④a：对接人白名单（verify-sys-liaison require 真实逻辑，防三处字面量漂移 + 权限精判回归）
    SYS_BUG_LIAISON_USER_IDS,
    isSysBugLiaison,
    requireAdminOrBugLiaison,
  };

  return { initSchema, router, _internals };
};
