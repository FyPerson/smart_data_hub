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
const crypto = require('crypto');     // C2：reassign operation_id 用 randomUUID（§3 events 规格，同 server.js:11 范式）
const multer = require('multer');     // C3b 附件上传（自建，对齐 corrections.js:9 范式；§10.3 deps 表 multer=自建）
const T = require('./transitions');   // 状态机常量单一来源（§3.7，T-M4）
const SF = require('./status-families');   // C0/C2：主状态族常量 + W06 白名单（§4.0/§5.3，联合 SSOT）
const { assertMainStatusTransition } = require('./status-transition-guard');   // C2 交付物①：不变量 7 三层组合统一入口
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
  // 系统迭代五表（sys_releases/sys_issues/sys_issue_timeline/sys_issue_attachments/sys_issue_dev_assignees）。
  //   C1 首版 CREATE TABLE IF NOT EXISTS 一次建全（无 ALTER，方案 §3.1）；**bug 流 Commit ① 起已上线表演进**：
  //   新列走 runSysMigration [1a] 幂等 ALTER（生产 v1.102.0 有表，IF NOT EXISTS 对已存在表 no-op 不加列）。
  //   ⚠️ 通知改造 Commit C1a（bug流通知改造_方案_20260703_v1.5.md，内容 v1.6 定稿）新增第 5 张表
  //   `sys_issue_dev_assignees`（多开发协作子表）——对生产已有 sys 四表库同样是**全新表**，CREATE TABLE
  //   IF NOT EXISTS 直接建全（含 CHECK，无需 ALTER）；sys_issues 侧新增 11 列（relay 通知 7 + requester
  //   byPhone 快照 2 + 上线编排 release_assignee 2）走既有 alterAddMissingCols 幂等 ALTER 范式补列。
  //   migration PRAGMA 复查五表 + 关键列就位才置 ready；未就绪挡 sys-* 写入口（503），其他模块正常。
  //   readiness 闸门 = 冗余防线 + 首启短暂窗口保护（migration 完成前 ready=false，避免首启报错）。
  //   ⚠️ C0（多开发协作与 commit 留痕重构 方案 v2.9 §9/附录C，2026-07-16）新增 3 张表——
  //   `sys_issue_dev_commits`（commit 留痕行）/ `sys_issue_dev_events`（append-only 事件表）/
  //   `sys_issue_release_commit_snapshots`（发布冻结快照）——五表→八表；均为**全新表**，CREATE TABLE
  //   IF NOT EXISTS 直接建全；`sys_issue_dev_assignees` 侧新增 4 列（dev_status 四态/resolved_at/
  //   no_code_reason/superseded_by）走既有 alterAddMissingCols 幂等 ALTER 范式补列（本表首次引入 ALTER）。
  const SYS_SCHEMA_STATE = { ready: false, error: null };

  const SYS_REQUIRED_TABLES = ['sys_releases', 'sys_issues', 'sys_issue_timeline', 'sys_issue_attachments', 'sys_issue_dev_assignees',
    // ← C0（多开发协作与 commit 留痕重构 v2.9 §9/附录C）新增 3 表：sys_issue_dev_commits / sys_issue_dev_events / sys_issue_release_commit_snapshots
    'sys_issue_dev_commits', 'sys_issue_dev_events', 'sys_issue_release_commit_snapshots',
    // ← C1（受理与排期改造 §12）迁移完成标记表：迁移事务写标记的落点，须存在（否则迁移无处写标记→无限重跑）
    'sys_schema_migrations'];

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
    'needs_release', 'related_correction_no', 'fix_gap_note', 'dingtalk_chat_id',  // ← bug 流 Commit ① 锚点（[审:M1] 指定 4 锚；derive_reason + 其余 4 群字段由 verify 全量保障）
    'relay_notify_status',  // ← 通知改造 C1a 锚点（bug流通知改造_方案_20260703_v1.5.md §4.1）：对接人通知侧状态，
                             //   relay 其余 6 列由 verify-sys-schema 全量保障。
    // ← 通知改造 C3b/C4 锚点：release_assignee_id/name 在 C1a 时确为纯数据列（不入锚点），但 C3b（execute-release/
    //   assign-release-dev SELECT release_assignee_id 判执行权）+ C4（列表 GET SELECT release_assignee_id/name 供批量面板
    //   + 详情可见性闸门读 release_assignee_id）后已成**被消费的热路径列**——须入锚点，否则 mid-migration 崩溃后
    //   （key 列已补但这两列未补）readiness 误报 ready → 列表 SELECT「no such column」500（codex 末次合并审 MED 收口）。
    'release_assignee_id', 'release_assignee_name',
    // ← 通知改造 follow-up（2026-07-07）第 5 类「通知上线开发」：release_assignee_notify_* 5 列**整组**入 readiness 锚点
    //   （codex 43 HIGH 采纳·防御性加固）。核实：runSysMigration 的 ready 是「alterAddMissingCols 全部 + [2] 复查全过」
    //   原子终点（本文件下方 665 行），中途异常走 catch→ready=false，故「status 补了其余没补还 ready」在本架构不可达；
    //   但整组入锚点更严格、为后续第 6 类通知立稳范式，区别于 relay/creator 历史「只锚 status」口径（本类采全列锚点）。
    'release_assignee_notify_status', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error', 'release_assignee_read_at',
    // ← [codex 100 号 HIGH-1] GATE 纵深方案 A（deferred 标记）锚点：runWGate/estimate/feasibility/unblock/
    //   return/reopen/成员写入口（新 pending 生命周期）均读写此列，属被消费的热路径列，须入锚点（同 114 行
    //   release_assignee_id 先例："mid-migration 崩溃后未补此列会 500"）。
    'gate_deferred_at',
    // ← C1（受理与排期改造 §8.1/§8.3）锚点：intake_required 是**被消费的热路径列**——sysIssueTransition SELECT
    //   读它做 dynamicTarget='initial_status' 落态解析 + §8.3 断言5 严格 0/1 归一化（本文件收严处），
    //   mid-migration 崩溃（列未补）会让该 SELECT/归一化 500，须入锚点（同 release_assignee_id 先例）。
    //   tech_lead_notify_status 是 NOT NULL 列，同 relay_notify_status 先例整组通知列以 status 锚点代表入 readiness
    //   （其余 tech_lead_* 由 verify-sys-schema 全量保障）；scheduled_start/tech_lead_id 等纯数据列 C1 无热读，暂不锚。
    'intake_required', 'tech_lead_notify_status',
  ];
  const SYS_RELEASES_KEY_COLS = ['release_no', 'status', 'is_hotfix', 'release_note', 'version_tag',
    'release_type'];   // ← bug 流 Commit ① 批次类型隔离锚点（[codex三审:L] 值域非空由 ② 服务端守卫强制，readiness 只查列在）
  const SYS_TIMELINE_KEY_COLS = ['event_type', 'from_status', 'to_status', 'action_code', 'ref_id', 'round_no'];
  const SYS_ATTACHMENTS_KEY_COLS = ['attachment_type', 'round_no', 'status'];
  // ← 通知改造 C1a 新表锚点（bug流通知改造_方案_20260703_v1.5.md §4.1）。sys_issue_dev_assignees 是**一次性
  //   CREATE TABLE（无 ALTER 路径）**——要么整表建全要么不存在，故 readiness 用"结构全列在"模型（非 sys_issues 那种
  //   ALTER 演进表的抽样锚点）：缺任一结构列=建表未完整→[2] 判 ready=false。**列集 = [1c] 迁移依赖全列（SELECT+INSERT
  //   触达列），并与 [1c] 的 devAssigneesSchemaReady guard 同源**（guard 直接 .every 引用本常量），杜绝 guard/锚点/INSERT
  //   三处列集漂移（通知改造批1 集成审收口：codex MEDIUM + ultracode 五视角 #5/#6）。
  const SYS_DEV_ASSIGNEES_KEY_COLS = ['issue_id', 'user_id', 'user_name', 'is_primary', 'notify_status',
    'notified_at', 'read_at', 'notify_message_key', 'notify_error', 'removed_at',
    // ← C0（多开发协作与 commit 留痕重构 v2.9 §9/附录C）ALTER 追加 4 列：dev_status 四态 + resolved_at + no_code_reason + superseded_by。
    //   本表由「全新表」范式（无 ALTER）首次破例引入 ALTER 演进——C-1 顺序铁律同样适用：ALTER 必须在下方
    //   [2] 复查之前完成（见 runSysMigration [1a-4]）。
    'dev_status', 'resolved_at', 'no_code_reason', 'superseded_by'];

  // ── C0 新增 3 表锚点（多开发协作与 commit 留痕重构 v2.9 §9/附录C）：readiness「结构全列在」模型 ──────────
  //   与 sys_issue_dev_assignees 首版同款——三表均为**一次性 CREATE TABLE（无 ALTER 路径）**，要么整表建全
  //   要么不存在，缺任一结构列=建表未完整→[2] 判 ready=false。
  const SYS_DEV_COMMITS_KEY_COLS = ['issue_id', 'dev_assignee_id', 'dev_user_id', 'component', 'commit_ref', 'created_at', 'updated_at'];
  const SYS_DEV_EVENTS_KEY_COLS = ['issue_id', 'dev_assignee_id', 'related_dev_assignee_id', 'action', 'from_status', 'to_status', 'operator_id', 'reason', 'payload_json', 'created_at'];
  const SYS_RELEASE_COMMIT_SNAPSHOTS_KEY_COLS = ['release_id', 'issue_id', 'snapshot_json', 'created_at'];

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

  // ── 角色权限重构 C0：受理门 SQL/DDL 常量统一从 intake-gate-sql.js 取（**单一真相源**）─────────────
  //   曾经把"回受理门"的字段清单在 index.js 与运维脚本各写一份，结果脚本漏清 tech_lead_*/relay_* 十六列，
  //   把违规单修成「表面合法、跨轮次状态仍脏」的半清状态（codex 七轮审 HIGH-1）。故收敛为一处定义、多处引用。
  //   触发器 DDL **不带 IF NOT EXISTS**、恢复时一律 DROP 后重建——名称存在不等于定义正确（七轮审 MED-1）。
  const {
    SYS_CLEAR_TECH_LEAD_FIELDS_SQL,
    SYS_CLEAR_RELAY_FIELDS_SQL,
    SYS_BACK_TO_INTAKE_GATE_SQL,
    SYS_INTAKE_GATE_TRIGGER_NAMES,
    SYS_INTAKE_GATE_TRIGGERS_SQL,
    SYS_INTAKE_GATE_DROP_SQL,
    C0_INTAKE_GATE_MIGRATION_KEY,
    INTAKE_VIOLATION_WHERE,
  } = require('./intake-gate-sql');

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
  //   ⭐ [F4 修正，通知改造 Commit C1b，bug流通知改造_方案_20260703_v1.5.md §3.1 正交表]
  //     四行正交（与 correction 的差异不再是"有无 per-单绑定"，而是"操作权 vs 通知目标"两条独立轴）：
  //     ① 白名单 [7,13] = **谁能操作**（assign/reassign + 发/查已读 开发·建单人·业务方侧，全局、任意 bug 单）；
  //     ② `relay_notified_user_id`（per-单）= **"通知对接人"这一动作的收件目标**（path B 建单写入，通知改造新增列，
  //        与①同为白名单成员但语义不同——不是"谁能操作"而是"该单通知发给谁"，白名单成员不能发 notify-relay 给自己）；
  //     ③ `assigned_to` = 主开发（DRI，状态机 owner）；④ `sys_issue_dev_assignees` 子表 = 开发集（主+协作）。
  //     ⚠️ 历史口径（C1 已废）：此处原写「type 精判把①的操作权收窄到 type='bug'」——C1 后①**不再是操作权来源**，
  //     操作权唯一来自 SYS_INTAKE_LIAISON_IDS（见下方 isSysIntakeLiaison / requireIntakeLiaison）。
  //   ⚠️ 改名单需三处同步：本常量 + 前端 public/Sys_Iteration.html 同名常量 + scripts/verify-sys-liaison.js
  //     （verify 卡三处字面量一致防漂移，对齐 correction relay 白名单三处同步纪律）。
  //   ⚠️ 部署前探针（deferred 到 5 片齐部署前，[[feedback_real_sample_before_deploy]]）：确认生产 users 表
  //     id=7 是示例发布者、id=13 是示例对接人且均 active、非 viewer（correction relay 已在产用此二 id，属产验事实，探针复核即可）。
  const SYS_BUG_LIAISON_USER_IDS = [7, 13];
  //   单一真相点（对齐 correction isCorrectionRelayWhitelisted / server.js isReadonlyLeaderId 范式）：uid 是否在对接人白名单。
  function isSysBugLiaison(uid) {
    return Number(uid) > 0 && SYS_BUG_LIAISON_USER_IDS.includes(Number(uid));
  }
  // ⭐ 角色权限重构 C1：**requireAdminOrBugLiaison 已删除**（codex C1 审 MED）。
  //   它曾是 bug 指派/换人/成员/通知端点的粗筛中间件（放行 admin ∨ 白名单[7,13]）。
  //   C1 把这一族端点的粗筛统一换成 requireIntakeLiaison（admin ∨ 受理人[13]·全类型），
  //   该中间件随之**零路由引用**。保留一个无人调用的授权中间件是风险而非兼容——
  //   任何新端点误挂它都会让示例发布者[7] 重新拿回本应撤销的写权限，故连同 _internals 导出一并删除。
  //   ⚠️ SYS_BUG_LIAISON_USER_IDS / isSysBugLiaison **保留**，但语义已收窄为两项**非操作权**用途：
  //     ① 列表/详情**可见性**（技术负责人示例发布者需看到 bug 单才能接咨询、回评估意见）
  //     ② path B relay **收件人**白名单（"该单通知发给谁"，与"谁能操作"正交）
  //   verify-sys-liaison [W] 组据此断言"该中间件已退场"，防日后被重新挂上。

  // ── 受理与排期改造 C2（§3 三白名单·按能力拆·三名单独立不共享引用）────────────────────────
  //   ⚠️ 三名单独立（不复用 SYS_BUG_LIAISON_USER_IDS）——按能力拆而非按角色：受理能力(示例对接人) ≠ bug 对接能力(示例发布者+示例对接人)
  //   ≠ 技术负责人能力(示例发布者)。共享引用会让「角色重划/撤权」时误连带（§3「防角色重划撤权回归」·示例发布者 bug 权零回归=
  //   SYS_BUG_LIAISON_USER_IDS index.js:212 保持不动）。
  //   ⚠️ 部署前探针（同 SYS_BUG_LIAISON 先例·[[feedback_real_sample_before_deploy]]）：确认生产 users id=13 是示例对接人、
  //     id=7 是示例发布者·均 active 非 viewer（id=7/13 已在 SYS_BUG_LIAISON 产用·属产验事实·探针复核即可）。
  // ── 角色权限重构 C0：**建单表单**客户端契约版本（codex C0 审 HIGH-1 / 复审 HIGH-1 范围澄清）───────
  //   语义：客户端显式声明自己知道当前的建单表单契约。C0 把受理门焊死为全类型必经后，
  //   "不传 intake_required"在旧页面意味着"用户取消了勾选"、在新页面意味着"该开关已不存在"——
  //   两者请求体逐字相同，只能靠本字段区分（否则旧页面取消勾选会被静默强制进受理门）。
  //
  //   ⭐ **适用范围：仅 POST /sys-issues（建单表单）**，刻意不扩展到 derive / reactivate。判据是
  //     「该端点是否承载了**用户在表单里表达的、可能被静默改义的意图**」：
  //     · 建单：有——用户勾/不勾「需对接人受理」是明确意图，被强制翻转必须响亮拒绝。
  //     · derive / reactivate：无——它们是详情页的单一动作按钮，用户只表达"派生"/"重新激活"这个动作本身，
  //       不表达受理门开关；且结果状态在同一次交互里就回写抽屉与列表（用户立刻看到「待受理」），
  //       是**可见的行为升级**而非静默改义。为它们加闸会让契约字段渗透到所有写端点（每个新端点都得记得带），
  //       却换不到等价收益。该范围划定由 verify-sys-intake-gate [SCOPE] 组固化，防日后被误当作"漏了"。
  //   ⚠️ 契约再变（如未来放开某类型免受理）必须 +1，并同步前端 + verify 夹具；旧值一律 400 引导刷新。
  const SYS_INTAKE_CONTRACT_VERSION = 2;   // 1 = C0 之前（受理门可选）；2 = C0 起（全类型必经·参数面封死）
  const SYS_INTAKE_LIAISON_IDS = [13];   // 示例对接人：受理动作（intake_accept/intake_return/request_tech_consult）授权
  const SYS_TECH_LEAD_IDS = [7];         // 示例发布者：技术负责人（被通知·下拉候选·tech_lead_id ∈ 此名单·§6/§8.1）
  //   单一真相点（对齐 isSysBugLiaison 范式）：uid 是否在受理人 / 技术负责人白名单。
  function isSysIntakeLiaison(uid) {
    return Number(uid) > 0 && SYS_INTAKE_LIAISON_IDS.includes(Number(uid));
  }
  function isSysTechLead(uid) {
    return Number(uid) > 0 && SYS_TECH_LEAD_IDS.includes(Number(uid));
  }
  //   粗筛中间件：放行 admin ∨ 受理人白名单；
  //   进 handler 后由 sysIssueTransition [3] roleGuard='intake_liaison' 精判（引擎权威·中间件只粗筛）。
  //   ⚠️ resubmit_intake/edit_in_revision 授权是 created_by∨admin（§5.3）**不走本中间件**——它们由端点 handler
  //     加载 issue 后按 created_by 精判（受理人不获重提他人单权·§11 示例对接人 resubmit 他人单→403 回归）。
  //   ⭐ 角色权限重构 C1 起**已实弹挂载 11 条路由**（取代已删除的 requireAdminOrBugLiaison）：
  //     · 受理 3：intake-accept / intake-return / request-tech-consult
  //     · 协调人族 5：assign / reassign / dev-assignees(POST 加人) / dev-assignees/:id/excuse / …/supersede-excuse
  //     · 通知 3：notify-developer / notify-creator（C1 三轮审 MED-1 补挂）/ notify-requester
  //   ⚠️ **DELETE /dev-assignees/:assigneeId 有意不挂**：它的授权是「协调人 ∨ **本人**」（成员可自移除），
  //     挂上会把自移除一并挡掉；该端点在 handler 内用 isSysCoordinator 精判非本人的情形。
  //   此前"建而未挂"的阶段性说明已作废。
  function requireIntakeLiaison(req, res, next) {
    const role = req.user && req.user.role;
    if (role === 'admin' || isSysIntakeLiaison(req.user && req.user.id)) return next();
    return res.status(403).json({ error: '仅管理员或受理人可操作', code: 'NOT_ADMIN_OR_INTAKE_LIAISON' });
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

        -- ── 通知改造 Commit C1a（bug流通知改造_方案_20260703_v1.5.md §4.1/§4.2/§2.3，内容 v1.6 定稿）──────────
        --   置于表尾（与旧库 ALTER ADD COLUMN 追加序一致，两路径列序不漂移，同 bug 流 Commit ① 惯例）。
        --   relay 通知（对接人侧，7 列，§4.1）：白名单成员通过 path B 建单写 relay_notified_user_id，
        --   notify-relay 端点（C3）发送后填其余 6 列；relay_notify_status 对齐三侧 notify_status 处理
        --   （NOT NULL DEFAULT 'not_sent' + CHECK；新库路径带 CHECK，ALTER 路径不补——见下方 [1a] 说明）。
        relay_notified_user_id INTEGER,
        relay_notified_at DATETIME,
        relay_read_at DATETIME,
        relay_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (relay_notify_status IN ('not_sent','sent','failed')),
        relay_notify_message_key TEXT,
        relay_notify_error TEXT,
        relay_notified_user_name TEXT,       -- 反规范化收件人姓名（白名单成员可能改名，§4.1）
        -- requester byPhone 收件人快照（§4.2 H-5）：notify-requester 发送时落快照，
        --   重发/查已读走快照不走当前 requester_phone（防发后改号已读失真）。
        requester_notify_phone_snapshot TEXT,
        requester_notify_ding_uid TEXT,
        -- 上线编排指定执行开发（§2.3，C3b assign-release-dev/execute-release 消费）：
        --   C1a 仅建列——nullable inert，本 commit 不接入任何读/写/守卫逻辑（schema 一次到位免二次迁移）。
        release_assignee_id INTEGER,
        release_assignee_name TEXT,
        -- ── 通知改造 follow-up（2026-07-07）：第 5 类「通知上线开发」——admin 指定上线执行开发后手动通知其执行 hotfix/发版。
        --   镜像 creator_notify_* 五列范式（byId 发送，无 phone 快照）；旧库 ALTER 路径见 runSysMigration [1a-3]。
        release_assignee_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (release_assignee_notify_status IN ('not_sent','sent','failed')),
        release_assignee_notified_at DATETIME,
        release_assignee_notify_message_key TEXT,
        release_assignee_notify_error TEXT,
        release_assignee_read_at DATETIME,

        -- ── [codex 100 号 HIGH-1] GATE 纵深方案 A（deferred 标记，方案 v2.9 补丁五修订）──────────
        --   置于表尾（同上惯例，与旧库 ALTER ADD COLUMN 追加序一致）。NULL=无 deferred；非空=曾被 runWGate
        --   判定"全在册完成态但资格未过"（isGateEligibleForVerify=false），等待 estimate/feasibility/unblock
        --   任一资格修复端点消费并原子清除；return/reopen/新 pending 生命周期（add/re-add/assign 产生 pending）
        --   同样清除（防陈旧标记被后续无关轮次误消费）。旧库 ALTER 路径见 runSysMigration [1a-5]。
        gate_deferred_at DATETIME,

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
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_attach_issue ON sys_issue_attachments(issue_id)`, recordSysErr('idx_sys_attach_issue'));

      // ── 2.5 sys_issue_dev_assignees（多开发协作子表，通知改造 Commit C1a，
      //   bug流通知改造_方案_20260703_v1.5.md §4.1，内容 v1.6 定稿）──────────
      //   主开发 assigned_to（DRI，写在 sys_issues）+ 协作开发（本表 is_primary=0）；
      //   **全新表**——对生产已有 sys 四表库，CREATE TABLE IF NOT EXISTS 同样是首次真建（非 no-op），
      //   直接带完整 CHECK 上线，不走 alterAddMissingCols（那是给「已存在表加列」用的，本表整表是新的）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_dev_assignees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,                -- 服务端从 users.display_name 重算，不信客户端（§3.3）
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (notify_status IN ('not_sent','sent','failed')),
        notified_at DATETIME,
        read_at DATETIME,
        notify_message_key TEXT,
        notify_error TEXT,
        removed_at DATETIME,                    -- 软删（改派移除保留审计通知行），NULL=在册（§3.3 五步差量 upsert）
        FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
      )`, recordSysErr('sys_issue_dev_assignees'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_dev_assignees_issue ON sys_issue_dev_assignees(issue_id)`, recordSysErr('idx_sys_dev_assignees_issue'));
      // [G12] 部分唯一索引——只约束在册行（removed_at IS NULL），禁整表 UNIQUE(issue_id,user_id)：
      //   同一开发软删后再加回会撞整表约束，部分索引兼容「复活最近一条」改派算法（§3.3 步骤 2）。
      // ⚠️ C0（多开发协作与 commit 留痕重构 v2.9）起：本条不再是 serialize 块最后一个 DDL——下方新增
      //   2.6/2.7/2.8 三张表接着建。migration 触发 callback 已下移到本块**真正最后**一个 db.run（2.8 结尾）。
      //   uq_dev_assignee_roster（方案附录C 命名）与本索引语义完全相同（同一列组+同一部分索引谓词），
      //   **复用不重建**（主会话已核实的偏差裁定，C0 任务书）——本索引即方案 §9.1「建 uq_dev_assignee_roster
      //   前先查重复在册」步骤的既有等价物，唯一索引已在线约束，无需额外中止检查。
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_dev_assignee_active ON sys_issue_dev_assignees(issue_id, user_id) WHERE removed_at IS NULL`, recordSysErr('idx_sys_dev_assignee_active'));
      // M2①（86 号审）：附录C 在 uq_dev_assignee_roster 之后紧跟 idx_dev_assignee_issue_removed（issue_id,removed_at）
      //   ——此前遗漏未建。逐字照附录C 补上，位置对齐（复用后的等价索引之后）。
      db.run(`CREATE INDEX IF NOT EXISTS idx_dev_assignee_issue_removed ON sys_issue_dev_assignees(issue_id, removed_at)`, recordSysErr('idx_dev_assignee_issue_removed'));

      // ── 2.6 sys_issue_dev_commits（C0，多开发协作与 commit 留痕重构 v2.9 §9/附录C）──────────
      //   commit 留痕行（前端 SVN / 后端 GIT 填 commit_ref）；可编辑（D2，四守卫见方案 §6.3，C4 起接线）。
      //   **全新表**——CREATE TABLE IF NOT EXISTS 首次真建，直接带完整 CHECK 上线（同 dev_assignees 首版范式）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_dev_commits (
        id INTEGER PRIMARY KEY,
        issue_id INTEGER NOT NULL,
        dev_assignee_id INTEGER NOT NULL,
        dev_user_id INTEGER NOT NULL,
        component TEXT NOT NULL CHECK (component IN ('frontend','backend')),
        commit_ref TEXT NOT NULL CHECK (length(trim(commit_ref)) BETWEEN 1 AND 200),  -- 入库前已 trim（服务层）
        created_at TEXT NOT NULL,
        updated_at TEXT NULL
      )`, recordSysErr('sys_issue_dev_commits'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_dev_commits_assignee ON sys_issue_dev_commits(dev_assignee_id)`, recordSysErr('idx_dev_commits_assignee'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_dev_commits_issue ON sys_issue_dev_commits(issue_id)`, recordSysErr('idx_dev_commits_issue'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_dev_commits_user ON sys_issue_dev_commits(issue_id, dev_user_id)`, recordSysErr('idx_dev_commits_user'));

      // ── 2.7 sys_issue_dev_events（C0，多开发协作与 commit 留痕重构 v2.9 §9/附录C）──────────
      //   append-only 事件表（无 UPDATE/DELETE API，方案 §3「events 规格」）；action 枚举 11 值（含 reassign
      //   落地为 add/remove 事件组，非独立 action 字面值，见 status-families.js 顶部注释同源说明）。
      //   附录 C 未给本表索引（events 目前仅按 issue_id/dev_assignee_id 小范围查询，量级由 §0「≤20 人团队」
      //   场景事实兜底，暂不建索引；未来若查询模式变化再补，不在本 commit 范围）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_dev_events (
        id INTEGER PRIMARY KEY,
        issue_id INTEGER NOT NULL,
        dev_assignee_id INTEGER NOT NULL,
        related_dev_assignee_id INTEGER NULL,
        action TEXT NOT NULL CHECK (action IN
          ('add','remove','self-remove','re-add','excuse','supersede-excuse',
           'submit','no_code','add-commit','edit-commit','delete-commit')),
        from_status TEXT NULL, to_status TEXT NULL,
        operator_id INTEGER NOT NULL,
        reason TEXT NULL,
        payload_json TEXT NULL,   -- submit 明细 / commit 载荷 / reassign {operation_id,reason,added,removed}
        created_at TEXT NOT NULL
      )`, recordSysErr('sys_issue_dev_events'));

      // ── 2.9 sys_schema_migrations（C1，受理与排期改造 §12 存量迁移完成标记）──────────────────────
      //   独立迁移完成标记表：区分「列补了但状态映射/后验未跑完」（残留态）与「整段迁移已收敛」（完成态）。
      //   仅靠「列存在」幂等不足以表达此区分（列在即跳过 → 剩余旧态永迁不了，方案 §12 步骤9 场景③）。
      //   语义 = 一次性、全局、migration_key UNIQUE（区别于 validation_config 的「业务配置」语义，故 sys 模块内自建）。
      //   ⚠️ 建表须在下方「真正最后一个 DDL」之前——保持 sys_issue_release_commit_snapshots 仍是触发 runSysMigration 的末条（时序铁律）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_schema_migrations (
        migration_key TEXT PRIMARY KEY,   -- 迁移唯一键（如 'intake_schedule_c1'）；PRIMARY KEY 即 UNIQUE，天然幂等
        applied_at TEXT NOT NULL           -- 完成时刻（随迁移事务提交一并写入，失败则不落 → 下次重跑）
      )`, recordSysErr('sys_schema_migrations'));

      // ── 2.8 sys_issue_release_commit_snapshots（C0，多开发协作与 commit 留痕重构 v2.9 §9/附录C）──────────
      //   发布冻结快照（D3）；UNIQUE(release_id,issue_id) 保证同一 (release_id,issue_id) 生命周期只快照一次
      //   （方案 §8「快照基数与插入语义」，写入用 ON CONFLICT(release_id,issue_id) DO NOTHING，禁 INSERT OR IGNORE
      //   ——那会静默吞 NOT NULL/CHECK 等一切约束失败，C6 接线时须遵守，本 commit 仅建表不接线）。
      // ⚠️ 本块是 serialize 队列**真正最后**一个 DDL——callback 触发 runSysMigration（时序铁律 corrections.js:322-323
      //   同款：必须由 serialize 块内最后一个 db.run callback 触发，否则 PRAGMA 与队列里 CREATE TABLE 竞态 → 永久 false）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_release_commit_snapshots (
        id INTEGER PRIMARY KEY,
        release_id INTEGER NOT NULL,
        issue_id INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,   -- schema 版本1，§8 固定字段，commit_id 升序；零 commit=[]
        created_at TEXT NOT NULL,
        UNIQUE (release_id, issue_id)
      )`, (err) => {
        recordSysErr('sys_issue_release_commit_snapshots')(err);
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
    // ⚠️ 曾用 `gateTriggersDropped` 标志决定 finally 是否收口，已废弃（codex 五轮审 HIGH-1）：
    //   它只记录**本次调用**是否走到过 DROP，挡不住"上次进程 DROP 后被强杀 + 本次在 [0b] 之前早退"
    //   这条跨启动缺口。现在 finally [F] 的触发条件改为「sys_issues 表存在」，与本次是否 DROP 过无关。
    //
    // 迁移主体是否成功（[3] 置位）。ready 的最终置位在 finally [F] 末尾——必须等受理门收口跑完，
    //   否则调用方会在收口事务提交前就认为初始化完成（间歇性 SQLITE_ERROR 的根因）。
    let migrationBodyOk = false;
    try {
      // 函数开头显式重置 ready=false，状态转移清晰（corrections.js codex 08 L-1）。
      SYS_SCHEMA_STATE.ready = false;

      // [0] 建表阶段若有 DDL 失败，直接熔断
      if (ddlError) {
        SYS_SCHEMA_STATE.error = `建表 DDL 失败：${ddlError}`;
        logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error} → sys-* 写入口将返 503`);
        return;
      }

      // [0b] ⭐ 角色权限重构 C0：**迁移期先摘掉受理门触发器**（codex 三轮审："历史迁移应在创建触发器之前执行"）。
      //   必要性：C1 的 intake_required 归一化会把非法值写成 **0**（`CASE WHEN =1 THEN 1 ELSE 0 END`，
      //   那是受理门可选时代的正确口径），而 C0 触发器要求恒 1 —— 若触发器已在，C1 重跑会被自己拦死，
      //   整个 readiness 挂掉。首次启动时触发器尚不存在，问题只在"删标记重跑"场景暴露，但那正是迁移设计支持的场景。
      //   安全性：迁移跑在启动初始化阶段（端点未注册、无并发请求），摘除窗口内不存在业务写入；
      //   ⚠️ 重建与全表后验统一收在函数末尾的 **finally [F]**（覆盖所有 return 早退与 throw 路径），
      //     不再依赖"正常路径走到某一行"——见 [F] 的完整说明。
      //   ⚠️ 本步之后的任何路径（含 return 早退 / throw / 进程被强杀后的下次启动）都由 [F] 兜底重建，
      //     [F] 不依赖"本次是否 DROP 过"这一标志，只看 sys_issues 表是否存在。
      for (const n of SYS_INTAKE_GATE_TRIGGER_NAMES) await dbRunAsync(`DROP TRIGGER IF EXISTS ${n}`);

      // [1] 表存在性（C0 起 8 表 + C1 起迁移标记表 sys_schema_migrations = 9 表）
      const tables = await new Promise((resolve, reject) => {
        db.all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sys_releases','sys_issues','sys_issue_timeline','sys_issue_attachments','sys_issue_dev_assignees','sys_issue_dev_commits','sys_issue_dev_events','sys_issue_release_commit_snapshots','sys_schema_migrations')",
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

      // [1a-2] ⭐ 通知改造 Commit C1a（bug流通知改造_方案_20260703_v1.5.md §4.1/§4.2/§2.3，内容 v1.6 定稿）：
      //   sys_issues 已上线表演进——补 11 列（relay 通知 7 + requester byPhone 快照 2 + 上线编排
      //   release_assignee 2），照 [1a] 同一 alterAddMissingCols 幂等 ALTER 范式；相对新库 CREATE（本文件
      //   §2.2）多出的 CHECK/NOT NULL 语义，ALTER 路径同 needs_release 先例不补 CHECK（SQLite ALTER 补约束
      //   受限）——relay_notify_status 例外：NOT NULL DEFAULT 'not_sent' 可通过 ALTER 常量默认值回填旧行
      //   （SQLite 支持 ADD COLUMN NOT NULL + 常量 DEFAULT，历史行自动回填，不同于 CHECK 的硬限制）。
      //   顺序铁律同 [1a]：relay_notify_status 已入 SYS_ISSUES_KEY_COLS——本 ALTER 必须在下方 [2] 复查之前完成。
      const NOTIFY_REWORK_ISSUE_COLS = [
        ['relay_notified_user_id', 'INTEGER'],
        ['relay_notified_at', 'DATETIME'],
        ['relay_read_at', 'DATETIME'],
        ['relay_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],   // ALTER 不补 CHECK，新库 CREATE 带完整 CHECK（对照 verify-sys-schema）
        ['relay_notify_message_key', 'TEXT'],
        ['relay_notify_error', 'TEXT'],
        ['relay_notified_user_name', 'TEXT'],
        ['requester_notify_phone_snapshot', 'TEXT'],   // §4.2 H-5：byPhone 收件人快照
        ['requester_notify_ding_uid', 'TEXT'],
        ['release_assignee_id', 'INTEGER'],            // §2.3：C1a 仅建列，无任何读/写/守卫引用
        ['release_assignee_name', 'TEXT'],
      ];
      await alterAddMissingCols('sys_issues', NOTIFY_REWORK_ISSUE_COLS, '通知改造 Commit C1a');

      // [1a-3] ⭐ 通知改造 follow-up（2026-07-07）：第 5 类「通知上线开发」——sys_issues 补 release_assignee 通知 5 列
      //   （镜像 creator_notify_*/relay_notify_* 范式，byId 发送无 phone 快照）。release_assignee_notify_status 已入
      //   SYS_ISSUES_KEY_COLS，本 ALTER 必须在下方 [2] 复查之前完成（顺序铁律同 [1a]）。NOT NULL DEFAULT 'not_sent'
      //   常量可通过 ALTER 回填旧行；CHECK 不补（新库 CREATE 带完整 CHECK，对照 verify-sys-schema）——同 relay_notify_status 先例。
      const RELEASE_EXECUTOR_NOTIFY_COLS = [
        ['release_assignee_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],
        ['release_assignee_notified_at', 'DATETIME'],
        ['release_assignee_notify_message_key', 'TEXT'],
        ['release_assignee_notify_error', 'TEXT'],
        ['release_assignee_read_at', 'DATETIME'],
      ];
      await alterAddMissingCols('sys_issues', RELEASE_EXECUTOR_NOTIFY_COLS, '通知改造 follow-up·通知上线开发');

      // [1a-4] ⭐ C0（多开发协作与 commit 留痕重构 方案 v2.9 §9/附录C）：sys_issue_dev_assignees 已上线表演进——
      //   补 4 列（dev_status 四态 + resolved_at + no_code_reason + superseded_by），照既有 alterAddMissingCols
      //   幂等 ALTER 范式（本表首次破例引入 ALTER——此前一直是「全新表」CREATE 一次建全，通知改造 C1a 至此终结）。
      //   dev_status 已入 SYS_DEV_ASSIGNEES_KEY_COLS——本 ALTER 必须在下方 [2] 复查之前完成（C-1 顺序铁律同 [1a]）。
      //   dev_status 用常量 DEFAULT 'pending' 可通过 ALTER 回填旧行（同 relay_notify_status 先例）；
      //   值域 IN ('pending','code_submitted','no_code','excused') 仅服务层强校验，ALTER 路径不补 CHECK
      //   （SQLite ALTER 补约束受限，同 needs_release/relay_notify_status 先例——两路径不变量由服务层+探针 P1-P15 等效保障）。
      // ⚠️ 唯一索引复用裁定（主会话已核实的偏差裁定，C0 任务书明示）：方案附录C 的
      //   `uq_dev_assignee_roster ON (issue_id,user_id) WHERE removed_at IS NULL` 与现网既有
      //   `idx_sys_dev_assignee_active`（本文件 initSchema 2.5 段）语义完全相同（同一列组+同一部分索引谓词）
      //   ——**不建第二个同义索引，复用不重建**；方案 §9.1「建 uq_dev_assignee_roster 前先查重复在册（有重→
      //   中止人工）」的中止检查也随之不需要——索引已在线约束，唯一性早已由既有索引保证，不存在"建索引时才
      //   发现重复"的风险窗口。
      const MULTIDEV_C0_DEV_ASSIGNEE_COLS = [
        ['dev_status', "TEXT NOT NULL DEFAULT 'pending'"],
        ['resolved_at', 'TEXT'],
        ['no_code_reason', 'TEXT'],
        ['superseded_by', 'INTEGER'],
      ];
      await alterAddMissingCols('sys_issue_dev_assignees', MULTIDEV_C0_DEV_ASSIGNEE_COLS, 'C0 多开发协作与 commit 留痕重构 v2.9 §9/附录C');

      // [1a-5] [codex 100 号 HIGH-1] GATE 纵深方案 A（deferred 标记）——补丁五原方案 B（资格修复端点事务尾部
      //   无条件重跑 runWGate）被证伪：return/reopen 会进 DEV 并清空 estimate/feasibility 但**保留完成态
      //   roster**（既有测试明确要求此时须 remove+re-add 开新 pending 实例）——这是合法的"DEV+allComplete+
      //   资格空缺"新一轮态，与"资格暂缺 deferred GATE"同形态但语义相反，方案 B 无条件重跑会在补
      //   estimate/feasibility 后把新轮单直接弹回 VERIFY，绕过重新开发与提交。改方案 A：加**持久字段**
      //   `gate_deferred_at`（DATETIME，非布尔——同 blocked_at/resolved_at 既有风格，兼作审计"何时被 defer"）
      //   落点选择：新增列（同 alterAddMissingCols 幂等 ALTER 范式，C0 runner 已有的列迁移基础设施可直接复用，
      //   schema 演进成本最低）——备选"复用既有 meta 机制"（如 C0 用过的 validation_config 表）不适用，因
      //   该表语义是"一次性配置标记"（config_key UNIQUE），非"逐 issue 状态"，语义不匹配、还要多一次 JOIN。
      const GATE_DEFERRED_COLS = [
        ['gate_deferred_at', 'DATETIME'],   // NULL=无 deferred；非空=曾在此刻被 GATE 判定"全完成态但资格未过"，等待资格修复端点消费
      ];
      await alterAddMissingCols('sys_issues', GATE_DEFERRED_COLS, 'codex 100 号 HIGH-1 GATE 纵深方案 A（deferred 标记）');

      // [1a-6] ⭐ C1（受理与排期改造 §8 Schema 迁移 + §12 存量迁移）：sys_issues 补 11 列（受理/排期/技术负责人通知）+
      //   状态映射（待评估/已排期 → 待指派）+ intake_required 归一化到 0/1。**单一原子迁移**（方案 §12 步骤8·codex 128-M）：
      //   补列 + 归一化 + 状态映射 + 后验校验 + 写完成标记**同一事务**（BEGIN IMMEDIATE），标记最后写且随事务提交
      //   （失败则整体回滚、标记不落 → 下次启动重跑）。
      //
      //   ⚠️ 事务选型（不用 sysBeginImmediate）：runSysMigration 跑在**启动初始化阶段**（端点尚未注册、无并发请求），
      //   sysBeginImmediate 走的是运行期并发 mutex（5s acquire + SYS_BUSY 503），语义是给端点并发设计的——迁移期套它
      //   会引入无谓的超时/繁忙耦合。故此处用裸 dbRunAsync('BEGIN IMMEDIATE')/COMMIT/ROLLBACK，贴合「启动期一次性迁移」。
      //
      //   ⚠️ 幂等 vs 标记（方案 §12 步骤1/9）：仅靠「列存在」幂等不足——列在即整段跳过 → 剩余旧态永迁不了（场景③）。
      //   故用独立 sys_schema_migrations 标记：标记不存在才跑；跑时 alterAddMissingCols 因列在自然跳过（幂等），
      //   但状态映射 UPDATE 仍命中剩余旧态 → 场景③（列在无标记的旧版非原子残留）自然收敛。
      const C1_MIGRATION_KEY = 'intake_schedule_c1';
      const c1Done = await new Promise((resolve, reject) => {
        db.get('SELECT migration_key FROM sys_schema_migrations WHERE migration_key = ?', [C1_MIGRATION_KEY],
          (err, row) => err ? reject(err) : resolve(!!row));
      });
      if (!c1Done) {
        // 受理/排期/技术负责人通知 11 列（方案 §8.1）。ALTER 不带 CHECK（SQLite ALTER 补约束受限，同 needs_release/
        //   relay_notify_status 先例）——值域由服务层枚举校验 + verify 断言兜底，两路径不变量等效。
        //   NOT NULL DEFAULT 常量可通过 ALTER 回填旧行（intake_required→0 / tech_lead_notify_status→'not_sent'）。
        const INTAKE_SCHEDULE_C1_ISSUE_COLS = [
          // ⭐ 角色权限重构 C0（codex C0 审 HIGH-2）：DEFAULT 由 0 改 1——受理门已焊死为全类型必经，
          //   "新行的默认值"必须与该不变量同向。⚠️ 本改动只对**全新库**生效（alterAddMissingCols 列已存在即跳过，
          //   已迁移库的 DEFAULT 保持 0 且 SQLite 无法原地改）；已有库由下方 [1a-7] C0 迁移把存量归一为 1、
          //   再由 readiness 哨兵持续监测矛盾单。三道防线（统一创建函数 / 迁移归一 / 启动哨兵）叠加，
          //   不为改一个 DEFAULT 去重建 60+ 列的主表（成本与回归风险远高于收益·方案 §7「零 DDL」）。
          ['intake_required', "INTEGER NOT NULL DEFAULT 1"],   // §8.1：0=无受理/1=启用受理；C0 起恒 1（归一化+verify 保证 ∈{0,1}）
          ['scheduled_start', 'TEXT'],                          // §8.1：admin 定计划开工日（参考字段·仅变更流）
          ['tech_lead_id', 'INTEGER'],                          // §8.1：技术负责人 id（∈ SYS_TECH_LEAD_IDS·服务端校验）
          ['tech_lead_name', 'TEXT'],                           // 服务端派生
          ['tech_lead_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],  // ∈{not_sent,sent,failed}（verify 兜底）
          ['tech_lead_notified_at', 'TEXT'],                    // sent 必填
          ['tech_lead_notify_message_key', 'TEXT'],             // sent 必填
          ['tech_lead_read_at', 'TEXT'],                        // 非空 ⟹ sent
          ['tech_lead_notify_error', 'TEXT'],                   // failed 必填
          ['tech_lead_notify_sent_by', 'INTEGER'],             // sent/failed 必填
          ['tech_lead_notify_request_event_id', 'INTEGER'],    // 当前请求对应 timeline 事件 id（结果归属·codex 128-M）
        ];

        // 旧∪新合法集（方案 §12 步骤2·codex H4）：首次迁移后重跑时数据已含新态，仅验旧集会误判 fail。
        //   旧态 = 受理排期改造前的 待评估/已排期（已从 T.ALLOWED_STATUSES 删除，此处作字面量保留供迁移识别）。
        const C1_LEGACY_STATUSES = ['待评估', '已排期'];
        const legalUnionByType = {};
        for (const t of Object.keys(T.ALLOWED_STATUSES)) {
          legalUnionByType[t] = new Set([...T.ALLOWED_STATUSES[t], ...C1_LEGACY_STATUSES]);
        }

        // ⚠️ 事务原子性前置不变量（codex C1 常规审 HIGH·2026-07-19 判误报但固化为防线）：本事务的边界所有权
        //   依赖上方 [1a]~[1a-5] 全部**严格 await 完成**（每个 alterAddMissingCols 及其内部 db.run/db.all 都包在
        //   await new Promise 里·Promise 只在回调内 resolve → 续体天然在回调之后·同连接语句按提交顺序执行）。
        //   到此处时旧段所有 PRAGMA/ALTER 已在连接上执行完毕，不会被夹进本 BEGIN IMMEDIATE。
        //   ⛔ 新增旧段迁移（未来 [1a-x]）**禁止 fire-and-forget**（不 await 的 db.run）——否则未完成语句可能落入本
        //   事务，导致 C1 COMMIT/ROLLBACK 意外提交/回滚他段。node-sqlite3 control-flow 只对「回调内串行提交」保证顺序。
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
          // 步骤2·先验（旧∪新·未知组合 fail-fast）：事务内锁定后校验，任何 (type,status) 不在旧∪新集 → 中止回滚。
          const preRows = await new Promise((resolve, reject) => {
            db.all('SELECT type, status, COUNT(*) AS n FROM sys_issues GROUP BY type, status',
              (err, rows) => err ? reject(err) : resolve(rows || []));
          });
          for (const r of preRows) {
            const union = legalUnionByType[r.type];
            if (!union || !union.has(r.status)) {
              throw new Error(`C1 迁移先验失败：非法组合 (type=${r.type}, status=${r.status})·不在旧∪新合法集 → fail-fast 回滚`);
            }
          }
          // 迁移前旧态计数（供步骤6 映射数守恒断言）：仍处旧态的 feature/improvement 行数。
          const preLegacyCount = preRows
            .filter(r => (r.type === 'feature' || r.type === 'improvement') && C1_LEGACY_STATUSES.includes(r.status))
            .reduce((s, r) => s + r.n, 0);
          const preTotal = preRows.reduce((s, r) => s + r.n, 0);

          // 步骤3·补列（事务内·幂等）：alterAddMissingCols 内部 PRAGMA 查列不存在才 ALTER，重跑跳过。
          await alterAddMissingCols('sys_issues', INTAKE_SCHEDULE_C1_ISSUE_COLS, 'C1 受理与排期改造 §8.1');

          // 步骤3·intake_required 严格布尔归一化（方案 §8.3-5/§12·拒 0/1 外值·不依赖 JS 真值转换）：
          //   NULL/非 1 → 0；1 → 1。ALTER DEFAULT 0 已使旧行为 0，此 UPDATE 是防御性收敛（幂等·二跑无副作用）。
          await dbRunAsync(`UPDATE sys_issues SET intake_required = CASE WHEN intake_required = 1 THEN 1 ELSE 0 END`);

          // 步骤4·状态映射（只映射仍处旧态的行·限 type·方案 §12 步骤4）：待评估/已排期 → 待指派。
          //   bug 无待评估/已排期·不动。幂等：WHERE status IN 旧集，二跑旧态已清 → 命中 0 行。
          const mapResult = await dbRunAsync(
            `UPDATE sys_issues SET status = '待指派'
             WHERE type IN ('feature','improvement') AND status IN ('待评估','已排期')`);
          // fail-closed（codex C1 常规审 MED-1·conf high 采纳）：dbRunAsync(server.js:205 resolve(this)) 对 UPDATE
          //   稳定返回 this.changes(number·实测零命中=0)。取不到 changes ⟹ 包装器契约破坏（如未来重构改箭头回调丢 this），
          //   属不可安全降级情况——原「null 跳过守恒」是 fail-open 死代码，与本迁移 fail-fast 目标矛盾。改为取不到即抛回滚。
          if (!mapResult || !Number.isInteger(mapResult.changes) || mapResult.changes < 0) {
            throw new Error(`C1 迁移映射数不可得（dbRunAsync 未返回合法 changes：${mapResult && mapResult.changes}）→ 回滚（MIGRATION_CHANGES_UNAVAILABLE）`);
          }
          const mappedRows = mapResult.changes;

          // 步骤6·后验（同事务·方案 §12 步骤6）：
          const postRows = await new Promise((resolve, reject) => {
            db.all('SELECT type, status, intake_required, COUNT(*) AS n FROM sys_issues GROUP BY type, status, intake_required',
              (err, rows) => err ? reject(err) : resolve(rows || []));
          });
          let postTotal = 0, postLegacyRemain = 0, postTargetCount = 0;
          for (const r of postRows) {
            postTotal += r.n;
            // 后验①：所有 (type,status) ∈ **新集合**（迁移后不应再有旧态；旧集不再合法）。
            const allowed = T.ALLOWED_STATUSES[r.type];
            if (!allowed || !allowed.includes(r.status)) {
              throw new Error(`C1 迁移后验失败：(type=${r.type}, status=${r.status}) 不在新合法集 → 回滚`);
            }
            // 后验②：intake_required ∈ {0,1}（严格·拒其它值）。
            if (r.intake_required !== 0 && r.intake_required !== 1) {
              throw new Error(`C1 迁移后验失败：intake_required=${r.intake_required} ∉ {0,1}（type=${r.type},status=${r.status}）→ 回滚`);
            }
            if ((r.type === 'feature' || r.type === 'improvement') && C1_LEGACY_STATUSES.includes(r.status)) postLegacyRemain += r.n;
            if ((r.type === 'feature' || r.type === 'improvement') && r.status === '待指派') postTargetCount += r.n;
          }
          // 后验③：总行数守恒（迁移不增删行·仅改 status）。
          if (postTotal !== preTotal) {
            throw new Error(`C1 迁移后验失败：总行数不守恒（迁移前 ${preTotal} → 迁移后 ${postTotal}）→ 回滚`);
          }
          // 后验④：旧态清零（映射后不应再有 feature/improvement 处于旧态）。
          if (postLegacyRemain !== 0) {
            throw new Error(`C1 迁移后验失败：映射后仍有 ${postLegacyRemain} 行 feature/improvement 处旧态 → 回滚`);
          }
          // 后验⑤：映射数量守恒（本次实际 UPDATE 行数 == 迁移前旧态行数·无条件断言·codex MED-1 fail-closed）。
          //   mappedRows 上方已保证是合法非负整数（取不到已抛回滚），此处不再降级跳过——直证逐映射数量，
          //   补足「总行数守恒仅证净行数、旧态清零+新集合法不证逐映射数」的缺口（防触发器等量替换/身份替换）。
          if (mappedRows !== preLegacyCount) {
            throw new Error(`C1 迁移后验失败：映射数不守恒（旧态 ${preLegacyCount} 行·实映射 ${mappedRows} 行）→ 回滚`);
          }

          // 步骤8·写完成标记（最后写·随事务提交）：先落标记再 COMMIT——若 COMMIT 失败标记随之回滚，下次重跑。
          await dbRunAsync(`INSERT INTO sys_schema_migrations (migration_key, applied_at) VALUES (?, datetime('now','localtime'))`,
            [C1_MIGRATION_KEY]);

          await dbRunAsync('COMMIT');
          logger.info(`[系统迭代迁移] ✅ C1 受理与排期改造完成（补 11 列 + 状态映射 ${mappedRows} 行待评估/已排期→待指派 + intake_required 归一化 + 后验守恒·总 ${postTotal} 行·标记 ${C1_MIGRATION_KEY} 已落）`);
        } catch (e) {
          try { await dbRunAsync('ROLLBACK'); } catch (_) { /* best-effort */ }
          throw e;   // 抛到外层 catch → SYS_SCHEMA_STATE.error（可观测·不静默吞）·sys 写入口 503
        }
      }

      // [1a-7] ⭐ 角色权限重构 C0（codex C0 审 HIGH-2 收口）：intake_required 存量归一为 1。
      //   背景：C0 把受理门焊死为全类型必经（三创建入口恒 intake=1），但 C1 迁移把旧行回填成了 0，
      //   且已迁移库的列 DEFAULT 无法原地改。存量里任何 intake_required=0 的单都是**新模型下的非法态**：
      //   ① 若其 status 已是受理态（待受理/待修改）→「待受理+ir0」矛盾组合，受理动作被 [3.5] 不变量 409 拒 → 单卡死；
      //   ② 若其 status 是开发前段（待指派/待处理）→ 该单当初正是"绕过受理门"进来的，语义上应视为"已受理"，
      //      归一为 1 不改变它的 status（只修正标志位），后续流转不受影响。
      //   ⚠️ 生产当前零单据（方案 §7），本迁移预期命中 0 行；保留它是为了 ①开发/测试库自愈 ②未来存量非零时的确定性。
      //   幂等：WHERE intake_required != 1，二跑命中 0 行。原子：单条 UPDATE + 后验 + 标记同一事务。
      const C0_MIGRATION_KEY = C0_INTAKE_GATE_MIGRATION_KEY;
      const c0Done = await new Promise((resolve, reject) => {
        db.get('SELECT migration_key FROM sys_schema_migrations WHERE migration_key = ?', [C0_MIGRATION_KEY],
          (err, row) => err ? reject(err) : resolve(!!row));
      });
      if (!c0Done) {
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
          const normResult = await dbRunAsync(`UPDATE sys_issues SET intake_required = 1 WHERE ${INTAKE_VIOLATION_WHERE}`);
          if (!normResult || !Number.isInteger(normResult.changes) || normResult.changes < 0) {
            throw new Error(`C0 迁移归一数不可得（dbRunAsync 未返回合法 changes：${normResult && normResult.changes}）→ 回滚`);
          }
          // 后验（同事务·fail-closed）：全表 intake_required 必须恒 1，否则回滚（宁可启动失败也不放矛盾单进生产）。
          const bad = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${INTAKE_VIOLATION_WHERE}`,
              (err, row) => err ? reject(err) : resolve(row ? row.c : -1));
          });
          if (bad !== 0) throw new Error(`C0 迁移后验失败：仍有 ${bad} 行 intake_required != 1 → 回滚`);
          await dbRunAsync(`INSERT INTO sys_schema_migrations (migration_key, applied_at) VALUES (?, datetime('now','localtime'))`,
            [C0_MIGRATION_KEY]);
          await dbRunAsync('COMMIT');
          logger.info(`[系统迭代迁移] ✅ C0 受理门焊死：intake_required 存量归一 ${normResult.changes} 行 → 全表恒 1（标记 ${C0_MIGRATION_KEY} 已落）`);
        } catch (e) {
          try { await dbRunAsync('ROLLBACK'); } catch (_) { /* best-effort */ }
          throw e;
        }
      }

      // [1a-7b/1a-8 已移除] ⭐ 角色权限重构 C0（codex 四轮审 HIGH-1/HIGH-2）：
      //   原先在此处"创建受理门触发器"+"启动哨兵只告警"，两者都有生命周期缺陷——
      //   前者不在 finally 里（迁移任一早退/抛错都会让触发器长期缺失），后者只记日志不阻断
      //   （"触发器在、存量却非法、readiness=true"这种最坏组合仍可发生）。
      //   现统一收进本函数末尾的 **finally [F]**：无条件全表归一 → 后验 → 重建触发器 → 校验 sqlite_master，
      //   任一不达标即阻断 readiness（保留原始迁移错误作根因）。此处不再有触发器相关逻辑。

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

      // [1c] ⭐ 通知改造 Commit C1b（历史迁移，独立 commit，§4.3 H-2/H-3）：
      //   补 primary 子表行 + 行内同时回填旧 dev notify_*（单条 INSERT…VALUES 一次写入 is_primary=1 与通知状态列，
      //   非"先插行再 UPDATE 回填"两步——同一终态更简单、避免中间态）。⚠️ 逐行 INSERT、**非单事务整体原子**：单行
      //   INSERT 原子，整迁移靠幂等重跑收敛（非单条语句回滚）——WHERE NOT EXISTS 已有在册 primary 行的 issue 跳过
      //   （不因迁移重跑或 C2 上线后产生的新单而误覆盖；进程中途崩溃留部分补齐、下次启动重跑收敛）。
      //   user_name 解析优先级：users.display_name → users.username → sys_issues.assigned_to_name（既有
      //   建单/指派时留痕的反规范化名）→ 'user#'+id 兜底。⚠️ 不对 users 表做 LEFT JOIN（多数 verify-sys-*.js
      //   测试库不建 users 表，JOIN 会因"no such table: users"让 runSysMigration 整体 catch 熔断、殃及全部
      //   18 个回归脚本）——改为**先探测 users 表是否存在**（sqlite_master 查表名，不是 try/catch 吞异常：
      //   区分"表不存在的预期分支"与"真实查询错误"，后者仍应 throw 到外层 catch 置 SYS_SCHEMA_STATE.error）。
      //   ⚠️ 同理防御 sys_issue_dev_assignees 自身列不全（正常路径不可达——本表由 [2.5] CREATE TABLE IF NOT
      //   EXISTS 一次建全，无 ALTER，不存在半成品态；此处仅为 readiness 缺列测试场景兜底）：查询前先 PRAGMA
      //   探测 **SYS_DEV_ASSIGNEES_KEY_COLS（= 本步 SELECT+INSERT 触达的迁移依赖全列，与 [2] 锚点同源）** 是否都在，
      //   不在则跳过本步、把诊断权交还 [2]——[2] 用同一列集判 ready=false，给干净的"关键列缺失"信息，而非本步因
      //   SQL 编译期列名解析失败抛原始 SQLITE_ERROR 熔断整个 runSysMigration（guard 覆盖 SELECT 的 issue_id 与
      //   INSERT 的全部目标列，故不会 guard 放行却在 INSERT 处撞缺列）。
      const devAssigneesCols = (await new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(sys_issue_dev_assignees)`, (err, rows) => err ? reject(err) : resolve(rows || []));
      })).map(c => c.name);
      const devAssigneesSchemaReady = SYS_DEV_ASSIGNEES_KEY_COLS.every(c => devAssigneesCols.includes(c));
      let legacyAssignedRows = [];
      if (devAssigneesSchemaReady) {
        legacyAssignedRows = await new Promise((resolve, reject) => {
          db.all(
            `SELECT id, assigned_to, assigned_to_name, notify_status, notified_at, notify_message_key, notify_error, read_at
               FROM sys_issues
              WHERE assigned_to IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM sys_issue_dev_assignees da
                   WHERE da.issue_id = sys_issues.id AND da.is_primary = 1 AND da.removed_at IS NULL
                )`,
            (err, rows) => err ? reject(err) : resolve(rows || [])
          );
        });
      } else {
        logger.warn('[系统迭代迁移] 通知改造 C1b：sys_issue_dev_assignees 关键列不全，跳过历史迁移回填（[2] 复查用同一 SYS_DEV_ASSIGNEES_KEY_COLS 锚点集据此判 ready=false）');
      }
      if (legacyAssignedRows.length > 0) {
        const usersTableExists = await new Promise((resolve, reject) => {
          db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`, (err, row) => err ? reject(err) : resolve(!!row));
        });
        let userNameById = new Map();
        if (usersTableExists) {
          const uniqueUids = [...new Set(legacyAssignedRows.map(r => r.assigned_to))];
          const userRows = await new Promise((resolve, reject) => {
            db.all(`SELECT id, display_name, username FROM users WHERE id IN (${uniqueUids.map(() => '?').join(',')})`, uniqueUids,
              (err, rows) => err ? reject(err) : resolve(rows || []));
          });
          userNameById = new Map(userRows.map(u => [u.id, u.display_name || u.username || null]));
        }
        for (const row of legacyAssignedRows) {
          const resolvedName = (usersTableExists ? userNameById.get(row.assigned_to) : null) || row.assigned_to_name || `user#${row.assigned_to}`;
          await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO sys_issue_dev_assignees
                 (issue_id, user_id, user_name, is_primary, notify_status, notified_at, notify_message_key, notify_error, read_at)
               VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
              [row.id, row.assigned_to, resolvedName, row.notify_status, row.notified_at, row.notify_message_key, row.notify_error, row.read_at],
              (err) => err ? reject(err) : resolve()
            );
          });
        }
        logger.info(`[系统迭代迁移] 通知改造 C1b：补 primary 子表行 + 回填 dev notify ${legacyAssignedRows.length} 单（users 表${usersTableExists ? '存在，已按 id 重算姓名' : '不存在，回退 assigned_to_name'}）`);
      }
      // requester 历史快照降级（§4.3 H 收口）：**无需额外迁移动作**——requester_notify_phone_snapshot 是 C1a
      //   新增列，旧行 ALTER 后天然为 NULL；'status=sent ∧ snapshot IS NULL' 这一判定组合在数据层已天然成立，
      //   HISTORICAL_SNAPSHOT_MISSING 降级逻辑留给 C3 read-status 端点按此组合判读（不新增标记列，任务书 §批1 口径）。
      //   生产 sys_issues=0 行，本缺口生产不可达；测试库验证见 verify-sys-bug-migration.js。

      // [2] 八表关键列 PRAGMA 复查（抽样锚点，非全字段；[1a]/[1a-2]/[1a-4] ALTER 后的最新列集）
      const checks = [
        ['sys_issues', SYS_ISSUES_KEY_COLS],
        ['sys_releases', SYS_RELEASES_KEY_COLS],
        ['sys_issue_timeline', SYS_TIMELINE_KEY_COLS],
        ['sys_issue_attachments', SYS_ATTACHMENTS_KEY_COLS],
        ['sys_issue_dev_assignees', SYS_DEV_ASSIGNEES_KEY_COLS],   // 通知改造 C1a 新表 + C0 追加 4 列（ALTER，[1a-4]）
        // ← C0（多开发协作与 commit 留痕重构 v2.9 §9/附录C）新增 3 表锚点，结构全列在模型（同 dev_assignees 首版）
        ['sys_issue_dev_commits', SYS_DEV_COMMITS_KEY_COLS],
        ['sys_issue_dev_events', SYS_DEV_EVENTS_KEY_COLS],
        ['sys_issue_release_commit_snapshots', SYS_RELEASE_COMMIT_SNAPSHOTS_KEY_COLS],
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

      // [3] 迁移主体全部就位 → 记下"可以 ready"，但**先不置位**。
      //   ⚠️ ready 必须等 finally [F] 的受理门收口跑完才置（见 [F] 末尾）：
      //     finally 在 try 之后执行，若在这里就置 ready=true，调用方（如 verify 的 waitReady、
      //     server.js 启动流程）会在 [F] 的事务尚未提交时就认为初始化完成 —— 随后关闭连接/发起写入，
      //     与正在执行的收口事务相撞，表现为**间歇性**的 SQLITE_ERROR（真实踩坑：
      //     verify-sys-multidev-reset 连跑 5 次 OK/FAIL/FAIL/OK/FAIL）。
      SYS_SCHEMA_STATE.error = null;
      migrationBodyOk = true;
    } catch (e) {
      SYS_SCHEMA_STATE.ready = false;
      SYS_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
      logger.error(`[系统迭代 C1] 🚫 ${SYS_SCHEMA_STATE.error}`);
    } finally {
      // ── [F] ⭐ 角色权限重构 C0：受理门约束收口（**已按 codex 九轮审的收敛判断大幅简化**）────────────
      //
      //   职责边界（这是本段唯一要记住的事）：
      //     **[F] 只负责"恢复约束"与"如实报告"，不负责"修数据"。**
      //     数据归一只属于 [1a-7] 那个带迁移标记的正式迁移事务；[F] 发现非法行一律阻断 readiness、留证据。
      //
      //   为什么这么切（第 2~8 轮的教训）：早期版本让 [F] 也承担归一，就必须回答"这批非法行是首次升级的存量、
      //   还是 C0 生效后被绕过的证据"，于是长出 markerTable 探测 / trustedFirstUpgrade / polluted 分类 /
      //   降级恢复的降级 等一层层分支，而每层分支自身又需要失效恢复——连续 5 轮的 HIGH 都出在这些**恢复层的恢复层**上。
      //   本项目的真实风险面（生产零单据 / 内网 / 单机 PM2 fork 单实例 / 无外部进程写库）
      //   ⚠️ 此处原写「单 admin」作为论据之一，2026-07-27 核实生产实为 **6 个 active admin**，该词已删。
      //     本条论据的真实支点是**单实例 fork + 无外部写库进程**（迁移期 DROP 触发器的前提），与 admin 人数无关，故结论不变。
      //   根本撑不起这套复杂度。砍掉"自动修数据"这一职责后，猜测成因的整棵分支树随之消失。
      //
      //   为什么仍放在 finally：[0b] 在迁移开始处 DROP 了触发器，而迁移体内有多处 return 早退与 throw；
      //   重建若只写在正常路径上，任一异常都会让数据库长期无约束（比迁移失败本身更危险）。
      //   触发条件是「sys_issues 表存在」而非"本次是否 DROP 过"——后者挡不住"上次进程 DROP 后被强杀"的跨启动缺口。
      //
      //   为什么 DROP 后重建而非 IF NOT EXISTS：名称存在 ≠ 定义正确；同名漂移的旧触发器会被静默保留，
      //   造成"名称齐全 → 判定已恢复 → readiness 放行"而实际约束无效。
      const appendErr = (msg) => {
        SYS_SCHEMA_STATE.ready = false;
        SYS_SCHEMA_STATE.error = `${SYS_SCHEMA_STATE.error ? SYS_SCHEMA_STATE.error + ' | ' : ''}${msg}`;
        logger.error(`[系统迭代] 🚫 ${SYS_SCHEMA_STATE.error} → sys-* 写入口将返 503`);
      };
      try {
        const tableRow = await new Promise((resolve, reject) => {
          db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_issues'`,
            (err, row) => err ? reject(err) : resolve(row));
        });
        if (tableRow) {
          let txnOpen = false;
          try {
            await dbRunAsync('BEGIN IMMEDIATE');
            txnOpen = true;

            // intake_required 列可能尚未 ALTER 到位（补列步骤失败/早退）——无该列则约束无从建立
            const hasIrCol = (await new Promise((resolve, reject) => {
              db.all(`PRAGMA table_info(sys_issues)`, (err, rows) => err ? reject(err) : resolve(rows || []));
            })).some(c => c.name === 'intake_required');

            if (!hasIrCol) {
              await dbRunAsync('ROLLBACK'); txnOpen = false;
              appendErr('C0 受理门约束无法建立：sys_issues 缺少 intake_required 列（补列步骤未完成）');
            } else {
              // 重建约束（无条件·与数据是否干净无关）
              for (const sql of SYS_INTAKE_GATE_DROP_SQL) await dbRunAsync(sql);
              const ddlErrs = [];
              for (const sql of SYS_INTAKE_GATE_TRIGGERS_SQL) {
                try { await dbRunAsync(sql); } catch (e) { ddlErrs.push(e && e.message); }
              }
              const present = await new Promise((resolve, reject) => {
                db.all(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${SYS_INTAKE_GATE_TRIGGER_NAMES.map(() => '?').join(',')})`,
                  SYS_INTAKE_GATE_TRIGGER_NAMES, (err, rows) => err ? reject(err) : resolve((rows || []).map(r => r.name)));
              });
              const missingTrg = SYS_INTAKE_GATE_TRIGGER_NAMES.filter(n => !present.includes(n));

              if (missingTrg.length || ddlErrs.length) {
                await dbRunAsync('ROLLBACK'); txnOpen = false;
                const why = [];
                if (missingTrg.length) why.push(`触发器缺失：${missingTrg.join(',')}`);
                if (ddlErrs.length) why.push(`DDL 报错：${ddlErrs.join(' / ')}`);
                appendErr(`C0 受理门约束未就位：${why.join('；')} —— 请人工处理后重启（数据未做任何修改）`);
              } else {
                await dbRunAsync('COMMIT'); txnOpen = false;

                // 约束已就位，再**只读**核对一次数据；有非法行只阻断 + 留证据，**不修**（见职责边界）。
                //   ⚠️ 单独 try/catch（codex 十轮审 LOW）：这段是"提交之后的只读后验"，与上面的恢复事务
                //     是两件事。若混在外层 catch 里，查询失败会被报成"恢复事务失败"，把运维排查引到错误方向。
                try {
                  const badRows = await new Promise((resolve, reject) => {
                    db.all(`SELECT id, type, status, intake_required FROM sys_issues WHERE ${INTAKE_VIOLATION_WHERE} LIMIT 20`,
                      (err, rows) => err ? reject(err) : resolve(rows || []));
                  });
                  if (badRows.length) {
                    const cntRow = await new Promise((resolve, reject) => {
                      db.get(`SELECT COUNT(*) AS c FROM sys_issues WHERE ${INTAKE_VIOLATION_WHERE}`,
                        (err, row) => err ? reject(err) : resolve(row));
                    });
                    const sample = badRows.map(r => `#${r.id}(${r.type}/${r.status}/ir=${r.intake_required})`).join(' ');
                    appendErr(`C0 受理门存在非法数据：${cntRow ? cntRow.c : badRows.length} 行 intake_required != 1（样本≤20：${sample}）。` +
                      `**触发器已就位**，新的违规写入会被拒；已存在的这些行未做任何自动修改（自动改成 1 会把"绕过受理门"洗成表面合法，并抹掉判别信号）。` +
                      `处理：node scripts/fix-sys-intake-gate-violation.js --db <path> 先 dry-run 看清单，逐单裁决后重启。`);
                  }
                } catch (verifyErr) {
                  appendErr(`C0 受理门数据后验查询失败（约束已恢复，但无法确认存量是否合规）：${verifyErr && verifyErr.message}`);
                }
              }
            }
          } catch (txErr) {
            if (txnOpen) { try { await dbRunAsync('ROLLBACK'); } catch (_) { /* best-effort */ } }
            appendErr(`C0 受理门恢复事务失败：${txErr && txErr.message}`);
          }
        }
      } catch (probeErr) {
        appendErr(`C0 受理门收口探测失败：${probeErr && probeErr.message}`);
      }

      // ── [F-end] ready 的**唯一置位点**：迁移主体 OK ∧ 收口未报错，才放行写入口。
      //   放在最末尾是关键：若在 try 里就置 ready=true，调用方（server.js 启动流程、verify 的 waitReady）
      //   会在收口事务尚未提交时认为初始化完成，随后关连接/发起写入撞上该事务，表现为间歇性 SQLITE_ERROR
      //   （实测 verify-sys-multidev-reset 连跑 5 次 OK/FAIL/FAIL/OK/FAIL，修正后连跑 6 次全 OK）。
      if (migrationBodyOk && !SYS_SCHEMA_STATE.error) {
        SYS_SCHEMA_STATE.ready = true;
        logger.info(`[系统迭代 C1] ✅ sys ${SYS_REQUIRED_TABLES.length}表就绪 + C0 受理门约束就位，写入口放行。`);
      }
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

  // ============================================================
  // 二·六、通知改造 C2：多开发协作子表差量 upsert（§3.3 五步 + [C-1] 一致性协议）
  //   [C3 退场] 本节原有两个 helper（resolveCollaboratorList + applyDevAssigneeDiff）供旧单人授权模型的
  //   sysIssueTransition 'assign' case + 旧 POST /:id/reassign 共用；C2 已整体重写 reassign（成员 API 节），
  //   C3 本轮删除旧 /sys-issues/:id/assign 端点 + 'assign' switch 分支（去主次改造收尾，指派统一由 C2 的
  //   POST .../dev-assignees 承担）。**`applyDevAssigneeDiff` 随之删除**（唯一调用点已不存在）；
  //   `resolveCollaboratorList` **保留**——仍被 W01 建单 path A（assign_mode='A' 直置 DEV 时解析协作开发
  //   id 列表）调用，非死代码。
  // ============================================================

  // 协作开发 id 数组 → [{id,name}] 校验+解析（存在性/非 viewer/服务端从 users 重算 name，不信客户端；
  //   去重；防与主开发 id 重复）。抛 SysTransitionError（400）供调用方各自 catch 转 HTTP / 触发事务回滚。
  //   ⚠️ 会查 users 表——仅在 rawIds 非空数组时才触达（verify-sys-transition.js 等无 users 表的直调场景，
  //   因未传 collaborator_ids，rawIds 规范化为 []，循环不执行，不查 users，不受影响）。
  async function resolveCollaboratorList(rawIds, primaryDevId) {
    // 非空非数组（如误传字符串/对象）显式拒绝，不静默按"无协作"处理（fail-closed，防调用方拼错字段被吞）。
    if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) {
      throw new SysTransitionError(400, 'INVALID_COLLABORATOR_IDS', '协作开发须为数组');
    }
    const list = Array.isArray(rawIds) ? rawIds : [];
    const collaborators = [];
    const seen = new Set();
    for (const raw of list) {
      const cid = parsePositiveId(raw);
      if (!cid) throw new SysTransitionError(400, 'INVALID_COLLABORATOR_IDS', '协作开发 id 非法');
      if (cid === primaryDevId) throw new SysTransitionError(400, 'ASSIGNEE_DUPLICATE', '协作开发不能与主开发相同');
      if (seen.has(cid)) continue;   // 幂等去重（重复 id 不报错，静默合并）
      seen.add(cid);
      const cdev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [cid]);
      if (!cdev) throw new SysTransitionError(400, 'COLLABORATOR_NOT_FOUND', `协作开发用户不存在（id=${cid}）`);
      if (cdev.role === 'viewer') throw new SysTransitionError(400, 'COLLABORATOR_VIEWER', `不能添加查看者为协作开发（id=${cid}）`);
      collaborators.push({ id: cdev.id, name: cdev.display_name || cdev.username || `user#${cdev.id}` });
    }
    return collaborators;
  }

  // [C3 退场] `applyDevAssigneeDiff`（差量 upsert 五步，assign/reassign 共用旧单人授权模型算法）已删除——
  //   唯一调用点（旧 /sys-issues/:id/assign 端点 + sysIssueTransition 'assign' switch 分支）随本轮改造一并
  //   删除，函数体不再可达。多开发 roster 差量写入现由 C2 的成员 API 承担：add/re-add=`addOrReaddMembers`，
  //   reassign=`POST .../reassign` 内联差量逻辑（先插新再移旧，§3），两者均已过 W-GATE/electRepresentative，
  //   不复用本函数的"单一 primary+协作"语义（该语义本身就是要被去主次改造替换掉的对象）。

  // ============================================================
  // 二·七、C2（多开发协作与 commit 留痕重构 v2.9）：成员 API + supersede + 选举 + W-GATE
  //   SSOT = 方案 v2.9 §3/§3.6/§4/§5 + 开发计划 v2.9 §2（联合 SSOT）。
  //   ⚠️ 范围声明（红线，C2 编码时立）：本节新增/重写 add/re-add/remove/self-remove/excuse/supersede-excuse/
  //   reassign 五类成员写入口 + CREATE（W01）直置 DEV 的接线 + W-GATE；C2 当时**不碰** W07（/assign /schedule
  //   等既有状态转换端点）与 RELEASE（发布/hotfix）——两者留给 C3 范围。
  //   [codex 99 号 M3 更新·技术债已解除] 本段原记"旧版 applyDevAssigneeDiff 短期与本节新写 roster 逻辑并存"
  //   ——该并存期已随 C3（W05 唯一 submit + W06/W07 切换）结束：`applyDevAssigneeDiff` 已彻底删除（唯一调用点
  //   旧 /assign switch 分支随之删除，函数体不再可达，无导出残留）；`/assign` 端点已按本节 roster 原语重建
  //   （见其自身注释：roster INSERT + electRepresentative + 双条件 UPDATE 三件套，非 applyDevAssigneeDiff）；
  //   `/reassign` 由本节整体重写为声明式最终 roster 差量（§3）。至此 add/re-add/assign/reassign 四个写入口
  //   均已统一收敛到 C2 引入的 roster 原语体系，无遗留双实现。
  // ============================================================

  // ── dev_assignees 响应列集单一来源（防写读镜像漂移，C1 codex 89 号审 MED 的教训在 C2 直接消灭重复）──────────
  //   凡是"写操作后要把最新 dev_assignees 塞进响应体"的地方，一律调用本函数，不再各自手写 SELECT 文本。
  const DEV_ASSIGNEES_SELECT_COLS = `id, user_id, user_name, is_primary, notify_status, notified_at, read_at, notify_message_key, notify_error, dev_status, resolved_at, no_code_reason`;
  async function fetchActiveDevAssignees(issueId) {
    return dbAllAsync(
      `SELECT ${DEV_ASSIGNEES_SELECT_COLS} FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY is_primary DESC, id ASC`,
      [issueId]
    );
  }

  // 非主状态写断言①：assertKnownIssueStatus（方案 §5.1 ①层，族外拒绝）。
  function assertKnownIssueStatus(issueType, status) {
    if (!T.ALLOWED_STATUSES[issueType] || !T.ALLOWED_STATUSES[issueType].includes(status)) {
      throw new SysTransitionError(409, 'GATE_INVARIANT', `未知状态「${status}」（issue_type=${issueType}，族外拒绝）`);
    }
  }

  // C3 交付物：非主状态写断言②：assertDevMember（方案 §5.1 ②层，在册∧removed_at IS NULL∧user=actor）。
  //   去主次后 W05（submit）与 W06（estimate/feasibility/blocked 等旁路动作）统一改判"actor 是否当前在册"，
  //   不再判"actor 是否等于单一 assigned_to"（旧单人代表模型的授权语义已随本次重构废除，§0）——任一在册开发
  //   均可对整单执行这类"对本单填一次"的旁路动作（W06 各字段本身不分人，门禁只管"谁有资格填"）。
  //   命中返回该在册 dev_assignee 行（{id,user_id,user_name,dev_status,...}）供调用方按需使用（如 submit 需要
  //   actor 对应的 dev_assignee_id 来定位 commit 行归属）；未命中 → 403 NOT_ROSTERED（与 §6.2 submit 同一错误码，
  //   §10 API 契约错误码全集内，语义均为"actor 当前不在该单的开发在册名单"）。
  //   [C4] opts.code/opts.message 可覆盖默认错误码——commit 行编辑三端点（§6.3 守卫①）复用本函数做"actor 当前
  //   在册"判定，但 §10 API 契约表该三端点错误码集合内无 NOT_ROSTERED（仅列 COMMIT_SCOPE），故调用处传
  //   { code: 'COMMIT_SCOPE' } 覆盖（契约裁定点，详见完成报告）；其余既有 4 处调用点不传 opts，行为零变化。
  async function assertDevMember(issueId, actorId, opts = {}) {
    const code = opts.code || 'NOT_ROSTERED';
    const message = opts.message || '仅在册开发可执行该操作';
    const row = await dbGetAsync(
      `SELECT id, user_id, user_name, dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL`,
      [issueId, actorId]
    );
    if (!row) throw new SysTransitionError(403, code, message);
    return row;
  }

  // 非主状态写断言③：主状态族门（方案 §4.3 矩阵，只管"这个族允许不允许做这个成员动作"，不管 dev_status 细节）。
  //   FROZEN 族在矩阵里逐行全 ❌，故不入白名单——familyOfStatus 若落在 FROZEN（或未知）直接拒绝。
  const MEMBER_ACTION_FAMILY_MATRIX = {
    add: ['D_PRE', 'DEV', 'VERIFY'],       // add/re-add 同列（§4.3 首列）
    remove: ['D_PRE', 'DEV', 'VERIFY'],    // remove/self-remove 同列
    excuse: ['DEV'],                        // 仅 SYS_DEV（§4.3/§5.2）
    supersede: ['DEV', 'VERIFY'],
    reassign: ['D_PRE', 'DEV', 'VERIFY'],  // 基础全族（bug 待处理态经 add 预指派/reactivate 后可带 roster，声明式改派合法）
    // [C4] commit 行编辑三端点守卫③（方案 §6.3："主状态∈(SYS_DEV∪SYS_VERIFY)"）——复用本矩阵而非另写一份
    // family 判定，与既有五个成员动作同一 409 INVALID_STATUS 语义收口（S17/S27"冻结态→409"实测依据）。
    commit: ['DEV', 'VERIFY'],
  };
  // C2c（2026-07-18·codex 115 MED 修正）：type 级族门覆盖——reassign 对**变更流(feature/improvement)**排除 D_PRE 族。
  //   设计立场（对抗审 B·WEAKENED 后精确化）：变更流 **声明式改派(reassign)仅开放 DEV/VERIFY**——D_PRE 首次组建
  //   开发集走 assign(已排期→开发中)、若需预调名单走 add/remove 差量端点（add/remove 族门仍含 D_PRE·有意保留）。
  //   这是"动作语义分门"的设计选择（reassign≠add/remove），**非"D_PRE 必无 roster"的事实断言**——D_PRE 经 add
  //   预指派确可产生 roster，故 add/remove 保留 D_PRE 服务这条路径、reassign 收窄不与之矛盾（对抗审 B 核为设计选择非缺陷）。
  //   背景来源：用户实测「已排期」态 assign+reassign 按钮共存。**bug 不同**——bug 待处理(D_PRE)保留 reassign
  //   （92 号审有意·bug 待处理可 add 预指派/reactivate 带 roster 后声明式改派），矩阵一刀切去 D_PRE 会误伤 bug。
  //   故按 type 拆：矩阵基础含 D_PRE（服务 bug），变更流在此覆盖排除。前端 transitions.js reassign.from 同源。
  const MEMBER_ACTION_FAMILY_TYPE_OVERRIDE = {
    reassign: {
      feature: ['DEV', 'VERIFY'],
      improvement: ['DEV', 'VERIFY'],
      // bug 未列 → 回落基础矩阵（含 D_PRE）
    },
  };
  // 取某 (actionKey, issueType) 的允许族清单（type 覆盖优先，否则回落基础矩阵）——唯一权威，verify 与端点同源读此。
  function memberActionFamiliesFor(actionKey, issueType) {
    const override = MEMBER_ACTION_FAMILY_TYPE_OVERRIDE[actionKey];
    if (override && Object.prototype.hasOwnProperty.call(override, issueType)) return override[issueType];
    return MEMBER_ACTION_FAMILY_MATRIX[actionKey];
  }
  function assertMemberActionFamilyAllowed(actionKey, issueType, status) {
    const allowedFamilies = memberActionFamiliesFor(actionKey, issueType);
    if (!allowedFamilies) throw new Error(`assertMemberActionFamilyAllowed: 未登记的 actionKey="${actionKey}"`);
    const family = SF.familyOfStatus(issueType, status);
    if (!family || !allowedFamilies.includes(family)) {
      // M6（91 号审）：族不满足是"当前主状态/成员动作不匹配"业务语义，改归 INVALID_STATUS（409）——
      //   GATE_INVARIANT 收窄只留主状态非法边/进族 roster 不满足/W-GATE UPDATE changes 冲突三类"守卫内部不变量"。
      throw new SysTransitionError(409, 'INVALID_STATUS', `当前状态「${status}」不允许该成员动作（${actionKey}）`);
    }
    return family;
  }

  // 协调人判定（附录B：协调人=对接人∪admin）。
  //   ⭐ 角色权限重构 C1（方案 v1.5 §4-C1）：由「admin ∨ (bug 对接人[7,13] 且 type='bug')」
  //     改为「admin ∨ 受理人[13]」——**去掉 type 精判，全类型统一**。
  //     · 示例发布者[7] 不再是协调人：他转为纯技术负责人（只在被咨询时回一条评估留言），
  //       指派/改派/开发成员管理/附件操作全部收归受理人示例对接人[13]。
  //     · 去 type 精判是因为受理人本就该全类型主导（v1.5 §3 角色模型），原先的
  //       "对接人仅可操作 bug 单"隔离是 bug 流白名单时代的产物。
  //   ⚠️ issueType 参数保留但不再参与判定：6 类消费点（指派族 3 + 附件族 3）的调用签名不动，
  //     避免为一次语义收敛去改 12 处调用点；下一次若确认无人需要该参数，由 C5 末次审一并清理。
  function isSysCoordinator(actor, issueType) {
    void issueType;
    return actor.role === 'admin' || isSysIntakeLiaison(actor.id);
  }

  // C2 交付物⑥：写一条 sys_issue_dev_events 行（方案 §3 events 规格）。必须在已开启的事务内调用。
  //   payload 由各调用点按动作构造好传入，本函数只管落库，不做业务校验（业务校验在各调用点完成）。
  async function insertDevEvent({ issueId, devAssigneeId, relatedDevAssigneeId, action, reason, operatorId, payload }) {
    await dbRunAsync(
      `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, related_dev_assignee_id, action, reason, operator_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
      [issueId, devAssigneeId, relatedDevAssigneeId || null, action, reason || null, operatorId, payload ? JSON.stringify(payload) : null]
    );
  }

  // C2 交付物②：服务层代表选举（方案 §3.6 四步序）——所有成员写事务末尾统一调用（不变量 8）。
  //   ⚠️ 与 C0 一次性重置脚本内联版（scripts/sys-multidev-c0-reset.js electRepresentativeInline）算法逐字相同；
  //   本函数是权威实现，reset 脚本保留独立内联版不动（一次性脚本，改动面小，其头部注释已指向本函数为权威）。
  //
  // M2（对抗审 2026-07-17）：代表（assigned_to）实变时同事务原子重置 sys_issues 的 dev 侧 notify 五列——
  //   notify_status/notified_at/notify_message_key/notify_error/read_at（**无前缀**，dev 侧专属，不与
  //   requester_/creator_/relay_/release_assignee_ 四组同名前缀列混淆，那四组各自的重置时机不受本次影响）。
  //   语义延续旧 reassign「换主」分支（05-L3，commit 8700 一带，"仅重置开发侧通知"）：旧模型换主必经该重置，
  //   C2 去主次重写后 electRepresentative 成为**所有**代表变化路径的唯一收敛点（add/remove/excuse/supersede/
  //   reassign/建单 path A 五处调用，见调用点清单），但重写时遗漏了这一步——钉钉派发若在事务外 best-effort
  //   失败被 catch 吞掉（dispatchSysNotify 范式），旧代表遗留的 notify_status='sent'/read_at 非空会被新代表
  //   误读为"已通知/已读"。判定基准=assigned_to 实际变化（含变为 NULL，例如零在册），而非"是否发生过换人操作"
  //   ——与 91 号审 M5（reassign 通知判定改"代表真实变化"）同一口径；建单 path A 场景（新单五列本就是 CREATE
  //   default 'not_sent'/NULL）重置无害，不特判 CREATE 调用点（避免维护第二条判断路径，成本可控）。
  async function electRepresentative(issueId) {
    const issue = await dbGetAsync('SELECT assigned_to, assigned_at FROM sys_issues WHERE id = ?', [issueId]);
    const prevAssignedTo = (issue && issue.assigned_to !== null && issue.assigned_to !== undefined) ? Number(issue.assigned_to) : null;
    const activeRows = await dbAllAsync(
      `SELECT id, user_id, user_name, dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL ORDER BY user_id ASC`,
      [issueId]
    );
    let winner = null;
    if (issue && issue.assigned_to !== null && issue.assigned_to !== undefined) {
      winner = activeRows.find(r => Number(r.user_id) === Number(issue.assigned_to)) || null;   // ① 现任仍在册
    }
    if (!winner) winner = activeRows.find(r => r.dev_status === 'pending') || null;              // ② 在册 pending 最小 user_id
    if (!winner && activeRows.length > 0) winner = activeRows[0];                                // ③ 全在册最小 user_id

    const newAssignedTo = winner ? Number(winner.user_id) : null;
    const repChanged = prevAssignedTo !== newAssignedTo;
    // M2：代表实变时随主 UPDATE 一并重置（同一 UPDATE 语句内，非另开一条——避免"选举 UPDATE 成功、重置 UPDATE
    //   失败"的半写状态；失败按现有事务范式自然向上抛错回滚，不 .catch(warn) 静默吞，同状态机字段 UPDATE 三件套精神）。
    const notifyResetSql = repChanged
      ? `, notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL, notify_error = NULL, read_at = NULL`
      : '';

    // ⚠️ M2（91 号审）assigned_at 语义拍板：assigned_at = **roster 首次形成时间**，代表变化（含换人）不推进——
    //   仅当当前 assigned_at 为 NULL（issue 从未有过在册代表）时才补写 now；一旦补写过，后续无论选举结果如何
    //   变化（is_primary 易主/换人）都不再更新。SSOT 定调"assigned_to=纯派生代表"，assigned_at 作为"何时有人
    //   接手"的首次留痕，不应随代表轮换而推进（对齐 RC-M5 下游 estimate/feasibility 的 assigned_at<=
    //   dev_estimated_at 校验语义：只关心"这单何时首次有人接手"，非"最近一次选举是何时"）。
    if (winner) {
      await dbRunAsync(`UPDATE sys_issue_dev_assignees SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE issue_id = ?`, [winner.id, issueId]);
      const assignedAtIsNull = !issue || issue.assigned_at === null || issue.assigned_at === undefined;
      if (assignedAtIsNull) {
        await dbRunAsync(`UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?, assigned_at = datetime('now','localtime')${notifyResetSql} WHERE id = ?`, [winner.user_id, winner.user_name, issueId]);
      } else {
        await dbRunAsync(`UPDATE sys_issues SET assigned_to = ?, assigned_to_name = ?${notifyResetSql} WHERE id = ?`, [winner.user_id, winner.user_name, issueId]);
      }
    } else {
      // ④ 零在册——assigned_to 归 NULL 时 assigned_at 也一并清空（roster 生命周期结束，下次重新形成时视为
      //   "再次首次形成"，assigned_at 会重新补写；无有效指派人就不该留一个陈旧时间戳）。M2：代表由非空变 NULL
      //   同样属"代表实变"，一并重置 notify 五列（repChanged 已含此情形，notifyResetSql 同样按 repChanged 生成）。
      await dbRunAsync(`UPDATE sys_issue_dev_assignees SET is_primary = 0 WHERE issue_id = ?`, [issueId]);
      await dbRunAsync(`UPDATE sys_issues SET assigned_to = NULL, assigned_to_name = NULL, assigned_at = NULL${notifyResetSql} WHERE id = ?`, [issueId]);
    }
    return winner ? { userId: winner.user_id, userName: winner.user_name } : null;
  }

  // [codex 98 号 HIGH 回填] GATE 纵深：DEV→VERIFY 候选命中"全员完成态"后仍需资格过滤——dev_estimated_at
  //   未填、blocked=1、或 needs_feasibility=1 且未达可行性合格条件的单，不应被 GATE 自动推进到待验证。94 号
  //   M4 场景（excuse 清空 pending 触发 GATE）等非 submit 路径同样会走到这里，此时没有 submit 侧硬闸兜底，
  //   必须在 GATE 自身补一层不依赖 action 的资格过滤，否则未估时/受阻/评估未过的单可被"意外推过"。判定逻辑
  //   与 submit 闸门（见 POST .../submit 内 [codex 98 号 HIGH 回填] 注释）完全同构——同一套 issue 级不变量，
  //   非独立设计，两处均对照 e39e65b 版旧 case 'submit' 逐条复刻。
  //   dev_estimated_at 判定**不分 type**（对照旧 case 'submit' 该判定本就无 type 限定，逐字核对而非推测）；
  //   blocked/feasibility 判定仍仅 feature/improvement 触发（bug/config 无该维度，§2.2 裁剪）。
  //   语义取舍（codex 98 号 HIGH 后续追问）：dev_estimated_at 与 blocked/feasibility 同归为「issue 级资格
  //   字段」而非「仅 submit 请求体校验」——三者均落在 sys_issues 表、均为提交前必须已具备的持久状态（非
  //   submit body 本身携带的瞬时输入，那类校验如旧 SUBMIT_SUMMARY_REQUIRED 已被新 §6.1 mode 专属必填取代、
  //   不入此列），故与 blocked/feasibility 同等并入 GATE 纵深，不视为"仅 submit 动作前置"而排除在外。
  async function isGateEligibleForVerify(issueId, issueType) {
    const row = await dbGetAsync(
      `SELECT dev_estimated_at, blocked, needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk
         FROM sys_issues WHERE id = ?`,
      [issueId]
    );
    if (!row) return false;   // fail-closed：查不到宁可不推进
    if (!row.dev_estimated_at) return false;
    if (!['feature', 'improvement'].includes(issueType)) return true;
    if (row.blocked === 1) return false;
    if (row.needs_feasibility === 1) {
      if (!row.feasibility_conclusion) return false;
      if (!['可行', '有条件可行', '不可行'].includes(row.feasibility_conclusion)) return false;
      if (row.feasibility_conclusion === '不可行') return false;
      if (!(row.feasibility_requirement_confirm || '').trim()) return false;
      if (row.feasibility_conclusion === '有条件可行' && !(row.feasibility_risk || '').trim()) return false;
    }
    return true;
  }

  // C2 交付物④：W-GATE（不变量 8）——成员写 + 选举之后，同事务内统一调用，判定是否需要主状态联动。
  //   边=DEV→VERIFY（在册≥1 且全在册完成态）/ VERIFY→DEV（含新增 pending）；D_PRE/FROZEN 不触发（矩阵 §4.3
  //   "主状态不动"），本函数自行短路，调用方不必先判族。UPDATE 走状态机三件套：双条件守卫 WHERE + changes 检查。
  //
  //   [codex 100 号 HIGH-1] gate_deferred_at 维护——本函数是全部"成员动作"（add/re-add/remove/self-remove/
  //   excuse/supersede/reassign/submit/no_code）触发 GATE 判定的唯一入口，故本函数本身是维护该标记最合适
  //   的单一权威位置（而非要求每个调用方各自记得置/清）：
  //   - inDev∧allComplete∧!eligible（资格未过）→ 置位（COALESCE 保留首次 defer 时刻，不因后续多次判定刷新）。
  //   - inDev∧!allComplete（含新 pending 打破先前 allComplete——覆盖 add/re-add/reassign 等"新 pending 生命
  //     周期"场景，比 codex 处方逐个端点手写清除更不易遗漏）→ 清除陈旧标记（本轮尚未到判定点，标记语义已失效）。
  //   - inDev∧allComplete∧eligible（即将进 VERIFY）→ 随下方状态转移 UPDATE 原子清除（消费完成）。
  //   - inVerify → 不适用该标记语义（进 VERIFY 时已清），不 touch。
  //   assign（D_PRE→DEV）不经过本函数（结构上不可能携带陈旧 deferred，D_PRE 态从未进过 DEV 家族）；
  //   return/reopen 不经过本函数（ADMIN_TRANSITION 走 sysIssueTransition，非 GATE）——两者对 gate_deferred_at
  //   的清除各自在自身 UPDATE 内直接处理（见 §6.2/return/reopen 落点注释），不依赖本函数覆盖。
  async function runWGate(issueId, issueType, currentStatus, actor) {
    const inDev = SF.isInFamily(issueType, currentStatus, 'DEV');
    const inVerify = SF.isInFamily(issueType, currentStatus, 'VERIFY');
    if (!inDev && !inVerify) return { changed: false };

    const rosterRows = await dbAllAsync(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [issueId]);
    const activeCount = rosterRows.length;
    const pendingCount = rosterRows.filter(r => r.dev_status === 'pending').length;
    const allComplete = activeCount > 0 && pendingCount === 0;

    let targetStatus = null;
    if (inDev && allComplete) {
      // GATE 纵深：全员完成态只是必要条件，还需资格过滤（blocked/feasibility/dev_estimated_at，见上方 isGateEligibleForVerify）
      const eligible = await isGateEligibleForVerify(issueId, issueType);
      if (eligible) {
        targetStatus = SF.SYS_VERIFY_STATUSES[issueType][0];
      } else {
        // 方案 A（deferred 标记）：置位等待资格修复端点（estimate/feasibility/unblock）消费
        await dbRunAsync(
          `UPDATE sys_issues SET gate_deferred_at = COALESCE(gate_deferred_at, datetime('now','localtime')) WHERE id = ?`,
          [issueId]
        );
      }
    } else if (inVerify && pendingCount > 0) {
      targetStatus = SF.SYS_DEV_STATUSES[issueType][0];
    }
    if (inDev && !allComplete) {
      // roster 未（再）达全完成态（含新 pending 打破先前 allComplete）——陈旧 deferred 标记语义已失效，清除
      await dbRunAsync(`UPDATE sys_issues SET gate_deferred_at = NULL WHERE id = ? AND gate_deferred_at IS NOT NULL`, [issueId]);
    }
    if (!targetStatus || targetStatus === currentStatus) return { changed: false };

    assertMainStatusTransition({
      routeKind: 'GATE', action: null, actionKind: null, issueType,
      before: currentStatus, after: targetStatus,
      rosterActiveCount: activeCount, rosterAllComplete: allComplete,
    });

    // 进 VERIFY 时随状态转移原子清除 gate_deferred_at（消费完成，同一 UPDATE 内完成，非分两步）
    // [codex 101 号 MED 回填] updated_at——旧版 assign/submit 公共 UPDATE 都刷 updated_at，本处（W-GATE 状态
    //   转移）是旧版对应逻辑在新模型的落点之一，SSOT 未废除该行为，补回（范围严格限定此三处，不动
    //   electRepresentative 通用选举 UPDATE——94 号 L1 裁定对暂缓/拒绝/作废终态场景"反伤效率统计终止时刻
    //   语义"仍有效，不在本次范围内）。
    const clearDeferredSql = targetStatus === SF.SYS_VERIFY_STATUSES[issueType][0] ? ', gate_deferred_at = NULL' : '';
    const upd = await dbRunAsync(`UPDATE sys_issues SET status = ?, updated_at = datetime('now','localtime')${clearDeferredSql} WHERE id = ? AND status = ?`, [targetStatus, issueId, currentStatus]);
    if (!upd || upd.changes !== 1) {
      throw new SysTransitionError(409, 'GATE_INVARIANT', '主状态已被并发修改，门禁转移失败（changes≠1）');
    }
    // M4（91 号审）：主状态确实发生变化时，同事务内补一条 sys_issue_timeline 镜像行（event_type='status_change'）
    //   ——旧 timeline 是"主状态时间线"的唯一读源（GET /sys-issues/:id 的 §5.3 演进时间线），W-GATE 触发的自动
    //   转移若不落一行，会在时间线上凭空断档。成员动作本身（add/remove/excuse/...）不写 timeline，只落
    //   sys_issue_dev_events——"codex 裁断 b"：两条审计轨迹分工明确，timeline 只记"主状态变化"，dev_events 只记
    //   "成员/roster 变化"，W-GATE 是两者的交汇点，故只在此处补一行。
    await dbRunAsync(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
       VALUES (?, 'status_change', ?, ?, ?, ?, ?)`,
      [issueId, currentStatus, targetStatus, 'W-GATE 自动门禁转移（成员在册完成态变化）', actor ? actor.id : null, actor ? actor.name : 'system']
    );
    return { changed: true, from: currentStatus, to: targetStatus };
  }

  // C2 交付物③：加人/复活成员共用底层（POST .../dev-assignees 用；reassign 的"插新"半步不复用本函数——
  //   reassign 需要精确知道每个新增 user 的 dev_assignee_id 以构造 operation_id 分组事件，逻辑相近但落点不同，
  //   为保持每处事务序清晰，reassign 在自己的处理函数里内联相同的"判 add/re-add + INSERT"逻辑，不强行复用
  //   以免把两种不同的事件分组语义耦合进一个共享函数——[[feedback_grep_before_writing]] 的反向应用：这里是
  //   "看似可复用但语义不同不该硬复用"的判断，非遗漏）。
  //   每个 user_id 独立判断：已在册→幂等跳过（不重复插入/不写事件）；否则一律 INSERT 新行（不复活旧软删行——
  //   §4.4"新建 pending 实例"与 supersede §4.2"INSERT 新 pending"同一原则，防"复活时忘记重置 dev_status 等
  //   字段"的整类 bug）；该 user_id 此前从未出现过→action='add'；曾有历史行（必是软删）→action='re-add'。
  //   调用方须已在事务内（sysBeginImmediate 已开）。返回 { added:[dev_assignee_id,...], skipped:[user_id,...] }。
  async function addOrReaddMembers(issueId, userIds, actorId) {
    const rawList = Array.isArray(userIds) ? userIds : [];
    if (rawList.length === 0) throw new SysTransitionError(400, 'VALIDATION', 'user_ids 不能为空');
    // L1（91 号审）：逐项 parsePositiveId 严格校验，任一非法（非正整数/字符串/小数/0/负数）整请求 400 零副作用——
    //   与 reassign 的 member_ids 校验严格度对齐（不再用 Number()+filter 静默丢弃非法项）。
    const parsedIds = [];
    for (const raw of rawList) {
      const pid = parsePositiveId(raw);
      if (!pid) throw new SysTransitionError(400, 'VALIDATION', `user_ids 含非法值：${JSON.stringify(raw)}`);
      parsedIds.push(pid);
    }
    const targetIds = [...new Set(parsedIds)];
    const existingRows = await dbAllAsync(`SELECT id, user_id, removed_at FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id`, [issueId]);
    const activeUserIds = new Set(existingRows.filter(r => r.removed_at === null).map(r => Number(r.user_id)));
    const everSeenUserIds = new Set(existingRows.map(r => Number(r.user_id)));

    const added = [];
    const skipped = [];
    for (const uid of targetIds) {
      if (activeUserIds.has(uid)) { skipped.push(uid); continue; }   // 已在册：幂等跳过
      const user = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [uid]);
      if (!user) throw new SysTransitionError(400, 'VALIDATION', `用户不存在（id=${uid}）`);
      if (user.role === 'viewer') throw new SysTransitionError(400, 'VALIDATION', `不能添加查看者为开发（id=${uid}）`);
      const userName = user.display_name || user.username || `user#${uid}`;
      const result = await dbRunAsync(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
        [issueId, uid, userName]
      );
      const daId = result.lastID;
      const action = everSeenUserIds.has(uid) ? 're-add' : 'add';
      await insertDevEvent({ issueId, devAssigneeId: daId, action, operatorId: actorId });
      added.push(daId);
    }
    return { added, skipped };
  }

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
                feasibility_risk, blocked, release_id, needs_release, gate_deferred_at,
                intake_required
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
      } else if (transition.dynamicTarget === 'initial_status') {
        // 受理排期改造 §9：dynamicTarget='initial_status' 的具名边（引擎内**仅 reactivate** 走此分支——
        //   create 不经本函数[端点直接 INSERT]、derive 用 createdIssueDynamicTarget、change_intake_mode 是自持端点）。
        //   ⭐ 角色权限重构 C0（方案 v1.5 §4-C0）：落态**不再依赖单据当前 intake_required**，改走创建路径唯一入口
        //     恒落「待受理」——原实现读 row.intake_required 分两支，是 v1.4 §2.2-B 认定的"reactivate 落态绕过受理门"缺口
        //     （已拒绝单若 intake_required=0，重新激活会直落待指派/待处理，跳过受理）。
        //   ⚠️ 落态恒定不等于放弃脏数据探测：下方仍保留 0/1 严格归一化校验（C1·codex131-M3 既有防线），
        //     读到非 0/1 照旧 500 阻断——库被外部污染/迁移未生效时仍要响亮失败，只是**校验结果不再参与落态决策**。
        //   ⚠️ 落态置「待受理」的同时必须把 intake_required 一并写 1（见下方 switch 的 reactivate 分支 setFrags），
        //     否则产出「待受理 + intake_required=0」矛盾组合 → 后续 intake_accept 被 [3.5] 不变量拒 409，单卡死。
        const rawIntake = row.intake_required;
        if (rawIntake !== 1 && rawIntake !== '1' && rawIntake !== 0 && rawIntake !== '0') {
          throw new SysTransitionError(500, 'INTAKE_REQUIRED_INVARIANT', `intake_required 数据不变量破坏：期望 0/1，实际=${rawIntake}（issue ${row.id}）`);
        }
        toStatus = T.resolveSysInitialStatusForCreate(type);
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

      // [2b] C3 交付物：W07 接线——sysIssueTransition 是全部 admin 流转（schedule/accept/return/close/hold/
      //   reactivate/issue_reject/void/reopen/resume）的唯一落点，此处统一接线一次即覆盖全部具名边（submit/
      //   assign 已随 C3 移出本函数，不在此列）。routeKind=ADMIN_TRANSITION，action 传本函数入参 action——
      //   与 [1] 用于 findTransition 元数据查询的是同一个字符串（写读同源，禁再造一份判断）；守卫内部会用
      //   同一 action 再解析一次具名边（resume 走专属分支），双重校验但非重复劳动：[1] 负责取 toStatus/
      //   timelineEvent 等元数据供后续业务逻辑用，守卫负责不变量 7 三层 fail-closed 判定。
      //   rosterActiveCount/rosterAllComplete 同事务内查询后传入（与 C2 成员端点/runWGate 同源查询方式）——
      //   ⚠️ 不按"目标态是否落 RELEASE 族"条件式查询：③层门禁同时管 enteringDev/enteringVerify/enteringRelease
      //   三个分支（如 reopen 进「开发中」同样受 enteringDev 门约束，S28 acceptance 明确要求 W07 路径也要测到
      //   零在册拒绝），漏查会让 fail-closed 因 rosterActiveCount=undefined 误拒本该合法的转移。
      {
        const rosterRows = await dbAllAsync(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [issueId]);
        const rosterActiveCount = rosterRows.length;
        const rosterAllComplete = rosterActiveCount > 0 && rosterRows.every(r => r.dev_status !== 'pending');
        assertMainStatusTransition({
          routeKind: 'ADMIN_TRANSITION', action, actionKind: null, issueType: type,
          before: fromStatus, after: toStatus, rosterActiveCount, rosterAllComplete,
        });
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
        // ⭐ 角色权限重构 C1：roleGuard='admin_or_bug_liaison' 分支**已删除**。
        //   原语义 = admin ∨ bug 对接人白名单[7,13]，且靠"仅挂 bug transition"实现 type 隔离。
        //   C1 后四条曾用它的 transition（bug/变更流 × assign/reassign）统一改为 'intake_liaison'
        //   （admin ∨ 受理人[13]·**全类型**），示例发布者[7] 由此失去指派权、转为纯技术负责人。
        //   该字符串已从 KNOWN_ROLE_GUARDS 移除：若哪里还残留，引擎会以 500 UNKNOWN_ROLE_GUARD fail-closed，
        //   verify-sys-meta 的"非空 roleGuard ∈ 已知集"断言也会先一步红灯。
        // roleGuard='intake_liaison' = admin ∨ SYS_INTAKE_LIAISON_IDS 白名单（示例对接人 id13）。
        //   ⭐ 覆盖面（角色权限重构 C1 后）：受理门三动作（intake_accept/intake_return/request_tech_consult）
        //   **＋ 指派族 assign/reassign 的 bug 与变更流共四条**——后者由 C1 从 'admin_or_bug_liaison'/'admin' 收敛而来，
        //   是「受理人全类型主导」的引擎侧落点。全部已接线（verify-sys-role-perm-c1 走真实 HTTP 端点验整链）。
        if (transition.roleGuard === 'intake_liaison' && !(isAdmin || isSysIntakeLiaison(actor.id))) permitted = false;
        // 受理排期改造 §5.3（codex131-H1 修）：roleGuard='creator_or_admin'（resubmit_intake/edit_in_revision）=
        //   建单人 ∨ admin。⚠️ 用事务内**锁定后的 row.created_by** 校验（BEGIN IMMEDIATE 后读的 row·非端点事务外预检·防 TOCTOU）——
        //   杜绝"端点预检通过但进引擎被 admin guard 误拒"的契约冲突（roleGuard 声明与意图同源）。
        const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
        if (transition.roleGuard === 'creator_or_admin' && !(isAdmin || isCreator)) permitted = false;
        if (transition.ownerGuard === 'assignee' && !isAssignee) permitted = false;  // 严格本人，不放行 admin
        // ⚠️ 默认拒绝未知 roleGuard（codex C2 常规审 MED-1·结构性 fail-open 收口）：上面逐个判断已知 guard 字符串，
        //   permitted 初值 true——若未来 transition 拼错/新增未实现的 roleGuard 值（C3/C4 正新增受理动作 transition·
        //   高发期），会**静默放行**。此处对**非空未知 roleGuard** 显式拒绝（配置错误 fail-closed）。
        //   ⚠️ roleGuard 为空/undefined 是合法的（如 estimate/submit 靠 ownerGuard·无角色门）——不拒空值。
        //   已实现枚举 = KNOWN_ROLE_GUARDS（verify-sys-meta 断言 transitions 里所有 roleGuard ∈ 此集·防漂移）。
        if (transition.roleGuard && !T.KNOWN_ROLE_GUARDS.has(transition.roleGuard)) {
          throw new SysTransitionError(500, 'UNKNOWN_ROLE_GUARD', `未实现的 roleGuard 配置：${transition.roleGuard}（transition 常量错误·fail-closed 拒绝）`);
        }
        if (!permitted) throw new SysTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权执行此状态流转');
      }

      // [3.5] 受理门不变量（受理排期改造 §5·codex C3 常规审 MED-1·复审 MED 收口）：受理门动作
      //   （intake_accept/intake_return/resubmit_intake·T.INTAKE_GATE_ACTIONS）仅当 intake_required=1 才可执行——
      //   待受理/待修改 结构上只由 intake_required=1 的路径产生，若读到 intake_required=0 + 受理态即数据不变量破坏
      //   （如 resubmit 会产「待受理+intake_required=0」矛盾组合·污染后续 reactivate 初始态解析）。fail-closed 拒绝
      //   （对齐 C1 归一化收严「宁 fail 不静默」）；归一化只认 0/1（同 dynamicTarget='initial_status' 口径）。
      //   ⚠️ 置于**权限校验[3]之后**（复审 MED 收口）：无权操作者稳得 403（不因字段级 409 侧信道推断工单 intake_required 状态），
      //     有权操作者对脏数据仍得明确 409（不弱化不变量）。
      if (T.INTAKE_GATE_ACTIONS.has(action)) {
        const ri = row.intake_required;
        const riNorm = (ri === 1 || ri === '1') ? 1 : ((ri === 0 || ri === '0') ? 0 : null);
        if (riNorm !== 1) {
          throw new SysTransitionError(409, 'INTAKE_REQUIRED_INVARIANT', `受理门动作「${action}」要求 intake_required=1（当前=${ri}·issue ${row.id}）`);
        }
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
        // [受理排期改造 §4.2 退场] 'schedule' switch 分支已随 schedule 动作退场删除——
        //   schedule 端点恒返 409 SCHEDULE_DISABLED（不再调 sysIssueTransition），且 findTransition('schedule',...) 恒 null
        //   （CHANGE_FLOW_TRANSITIONS 已删 schedule 条目），本分支不可达，删除防误导。priority/deadline 改由
        //   建单填 + 待修改态 edit_in_revision 承接（§7.3）；priority_reviewed_at 退役（保留历史值·§7.3）。
        // [C3 退场] 'assign' switch 分支已随旧 /sys-issues/:id/assign 端点一并删除——去主次改造后"指派"
        //   由 C2 的多开发 dev-assignees 端点（POST .../dev-assignees，D_PRE→DEV 走 W-GATE/electRepresentative）
        //   承担，不再是单一 assigned_to 授权写。findTransition('assign',...) 已从 §5.1 意义上不可达
        //   （无端点再传 action='assign' 给本函数），保留会误导读者以为仍有路径可达，随退场一并删除。
        // [C3 退场] 'submit' switch 分支已随旧单一 `makeTransitionEndpoint('submit')` 注册一并删除——
        //   W05「唯一 submit」改走独立事务的 handleDevSubmit（多开发 commit 事件模型，§6.1/§6.2），不再经
        //   sysIssueTransition/findTransition('submit',...)（该边从此不可达）。旧逻辑里的"交付说明(summary)+
        //   round_no 交付附件绑定"（C3b/11-H2/RC-M4）与本次删除一并退场——不是遗漏，是范围裁定：新模型下
        //   commit 行本身即交付证据，旧"文本摘要+附件轮次绑定"UX 若要保留，属计划 §4 C7「交付 D5」在新模型上
        //   重新设计的范围，不在本轮（C3）内静默保留半套旧字段（详见交付汇报"范围取舍说明"）。
        //   fix_gap_note（bug 派生单修复缺口说明）与可行性评估闸门同样只服务旧单人 submit 流程，随之退场；
        //   新 handleDevSubmit 不复刻这两项（同一取舍，非各自独立决定）。
        // ── 受理门动作（受理排期改造 §5·C3 接线）──────────────────────
        //   intake_accept（待受理→待指派/待处理）：无 payload、无额外 SET，走通用 UPDATE（default 语义），
        //     不列 case（summary 恒 null·timeline actionCode='intake_accept' 已由常量给）。故此处只处理需 reason 的 intake_return。
        //   resubmit_intake（待修改→待受理）：⭐ 角色权限重构 C0 起**改为有额外 SET**（见下方 case·原为"无额外 SET 不列 case"）。
        case 'resubmit_intake': {
          // ⭐ 角色权限重构 C0（方案 v1.5 §4-C0）：重新提交 = **开启新一轮受理**，须把上一轮咨询痕迹整组清干净。
          //   ① intake_required=1：方案要求的"原子恢复"。C0 后此处结构上恒已为 1（[3.5] 受理门不变量先行拒了 ≠1 的单），
          //      属**防御性冗余**——保留是因为它把"重提必回受理门"写成了本地不变量，不依赖上游检查的存续。
          //   ② tech_lead_* 九列整组归零：**与 request-tech-consult(:3991-3997) 同一套重置语义**，不是只清 id/name。
          //      ⚠️ 若只清 id/name 会留两个真缺陷（[[feedback_write_read_same_semantic]] 写读同源）：
          //        · 展示面矛盾：tech_lead_id=NULL 却 notify_status='sent'/notified_at 有值 =「无负责人却有通知记录」
          //        · **跨轮次污染（真 bug）**：recordSysTechLeadNotify(:6310-6314) 的版本围栏 WHERE 是
          //          `tech_lead_notify_request_event_id=?`。上一轮的在途通知回写只认这个 event_id——不清它，
          //          回写会命中**新一轮**的行，把已归零的投递态改成 sent/failed（而负责人已被清空）。
          //      归零后单回到"从未咨询过"的干净态，与 §8.3 不变量（not_sent ⟹ sent_by/read_at 空）自洽。
          //   ③ relay_* 七列同批清（codex C0 审 MED-3）：见 SYS_CLEAR_RELAY_FIELDS_SQL 处的语义定性。
          //   ⚠️ 三组字段走同一常量 SYS_BACK_TO_INTAKE_GATE_SQL，与 reactivate 逐字一致（防两处清单漂移）。
          setFrags.push(...SYS_BACK_TO_INTAKE_GATE_SQL);
          break;
        }
        case 'intake_return': {
          // 受理退改（§5.1②·原因必填）：待受理→待修改，reason 落 timeline.summary（对齐 return/reopen 的 reason→summary 范式）。
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'INTAKE_RETURN_REASON_REQUIRED', '请填写退改原因');
          summary = reason;
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
            'scheduled_start = NULL',    // 受理排期改造 §7.2（C6·补声明未实现缺口）：打回=预计完成失效→计划开工日随之失效（transitions.js return sideEffects 已声明·此前引擎未实现）
            'gate_deferred_at = NULL',   // [codex 100 号 HIGH-1] 打回=新一轮，roster 完成态保留但需求重新提交，清陈旧 deferred 标记（不该被后续 estimate/feasibility 误消费弹回 VERIFY）
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
            'scheduled_start = NULL',    // 受理排期改造 §7.2（C6·补声明未实现缺口）：重开=新一轮·计划开工日失效（transitions.js reopen sideEffects 已声明）
            'gate_deferred_at = NULL',   // [codex 100 号 HIGH-1] 重开=新一轮，同 return，清陈旧 deferred 标记
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
          // ⭐ 角色权限重构 C0（方案 v1.5 §4-C0）：reactivate 回受理门——落态已恒「待受理」（见上方 [动态目标解析]），
          //   此处同事务把 intake_required 一并置 1，两者必须原子（同一条 UPDATE 的 SET 列表）；否则会留下
          //   「待受理 + intake_required=0」矛盾单，被 [3.5] 受理门不变量拒 409 而永久卡死（已拒绝单的 ir 可能是
          //   0——历史单或旧 derive 产出）。置 1 是把脏态修正回不变量，不是覆盖用户意图。
          //   ⚠️ 只对 reactivate 生效：本块与 issue_reject 共用（→已拒绝·不进受理门），故按 action 精判，
          //     **不能**另写一个 `case 'reactivate'`——JS switch 重复 case 标签只有首个可达，后写的是死代码
          //     （本 commit 首版正是这么写的，被 verify-sys-intake-gate [C3] 的 ir=0 脏单用例抓出）。
          //   ⚠️ 同时清上一轮咨询/转派痕迹（codex C0 审 MED-3）：已拒绝单可能带着上一轮的 tech_lead_*（受理期
          //     发起过咨询后被拒）与 relay_*（历史 path B 建单），回受理门即新一轮，旧轮次状态不跨轮继承。
          if (action === 'reactivate') setFrags.push(...SYS_BACK_TO_INTAKE_GATE_SQL);
          break;
        }
        case 'void': {
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'VOID_REASON_REQUIRED', '请填写作废原因');
          summary = reason;
          // F2b 修（ultracode）：作废 blocked 单清受阻三件套（§⑥ 处置后清 blocked，不动评估——作废非新一轮，评估留作问责）
          setFrags.push(...SYS_CLEAR_BLOCKED_FIELDS_SQL);
          // [codex 101 号 HIGH 回填] 已作废是不可恢复终态，gate_deferred_at 若带入终态即成脏状态（非死锁，
          //   因终态无任何路径再消费该标记，但字段语义"等待资格修复"已失效）——随状态 UPDATE 一并清除。
          setFrags.push('gate_deferred_at = NULL');
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
        case 'resume': {
          // [codex C3 对抗审 HIGH-A 回填] timeline 如实记录实际恢复到的状态；若 resolveToStatusInTxn 判定
          //   降级（暂缓期在册不满足 VERIFY/RELEASE 进族门），summary 备注"自动降级"+原目标，供审计追溯
          //   （非静默改写历史，实际发生了什么就记什么）。
          const info = opts.resumeDegradeInfo;
          summary = (info && info.degraded)
            ? `恢复到「${toStatus}」（自动降级，原目标「${info.originalTarget}」因暂缓期在册不满足进族门禁）`
            : `恢复到「${toStatus}」`;
          break;
        }
        // [v1.6 退场·C3b] 'confirm-online-norelease' switch 分支已删除——随 transitions.js 移除该 meta 条目，
        //   findTransition 对任意 type 恒返 null，[1] 会在到达本 switch 前就以 INVALID_TRANSITION 抛出
        //   （本函数入口处 findTransition 查表在 switch 之前，见上方 [1]），故本分支 100% 不可达死代码，
        //   随退场一并删除（保留会误导读者以为仍有路径可达）。whereFrags/whereParams 通用脚手架继续保留
        //   给未来 action 复用（当前恒为空数组，零成本）。
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

      // [codex 101 号 HIGH 回填] resume 跨族死锁——resume 是唯一"离开 D_PRE 族恢复回任意活跃族"的动作，恢复
      //   目标若落在 DEV 族且此单带着 gate_deferred_at（hold 前已被 GATE 判定"全完成态但资格未过"，hold 本身
      //   保留该标记——"合理"，见 codex 101 号裁断），必须同一事务内消费：resume 之前无任何路径会重新触发
      //   GATE（unblock/estimate/feasibility 只在各自端点内消费，不知道 resume 刚发生），若不在此处补消费，
      //   resume 后 roster 已全非 pending 无法再靠 submit 触发、且此时 blocked 若已被 hold 清零则 unblock 也
      //   拒绝（NOT_BLOCKED），永久卡死。
      //   **只在恢复目标∈DEV 族时消费**——resume 动态解析目标可能是 D_PRE/DEV/VERIFY/RELEASE 任一活跃族：
      //   gate_deferred_at 语义上只在 runWGate 的 inDev 分支产生（见该函数注释），故恢复到 VERIFY/RELEASE/
      //   D_PRE 时该字段结构上不可能非空（若非空必是脏数据，不属于本次要处理的死锁场景，交由该目标族自身
      //   语义处理——如恢复到 VERIFY 就是"回到已完成态"，不涉及"是否该进 VERIFY"的判断）；且 runWGate 本身
      //   幂等（roster 未变则 no-op，暂缓期间加了新 pending 则按 !allComplete 自然清标，已有机制覆盖，无需
      //   本处额外分支）。返回给调用方（resume 端点）的最终状态须反映 GATE 后续推进（若发生）。
      let finalToStatus = toStatus;
      if (action === 'resume' && row.gate_deferred_at && SF.isInFamily(row.type, toStatus, 'DEV')) {
        const gateResult = await runWGate(issueId, row.type, toStatus, actor);
        if (gateResult.changed) finalToStatus = gateResult.to;
      }

      await sysCommit();
      return { ok: true, fromStatus, toStatus: finalToStatus, notifyAfterCommit: transition.notifyAfterCommit || null };
    } catch (txErr) {
      try { await sysRollback(); } catch (_) { /* ignore */ }
      throw txErr;
    }
  }

  // endpoint catch 转 HTTP（对齐 corrections sendCorrectionTransitionError）。
  function sendSysTransitionError(res, e) {
    if (e instanceof SysTransitionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    // C2：status-transition-guard.js 的 MainStatusGuardError 不 instanceof SysTransitionError（独立模块，防循环
    //   依赖不 require index.js）——duck-type 兼容其 .httpStatus/.code 结构，同款转换，不必在每个调用点手动包一层。
    if (e && typeof e.httpStatus === 'number' && typeof e.code === 'string') {
      return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    }
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
      // ── 角色权限重构 C0（方案 v1.5 §4-C0）：受理门焊死 ──────────────────────────────────────
      //   ⭐ 全类型建单**必经受理**（bug/feature/improvement），intake_required 由服务端恒定为 1，
      //     落态恒「待受理」——不再由 admin 勾选决定（原「需对接人受理」checkbox 随本 commit 从前端移除）。
      //   ⚠️ **客户端传 intake_required 一律 400**（不是"忽略后静默恒 1"）：静默忽略会让旧前端/缓存页面
      //     误以为"我关掉了受理门"而实际开着，失败必须响亮（沿用本模块 INVALID_INTAKE_REQUIRED 失败响亮范式）。
      //     旧客户端（阶段1 部署后、静态资源未刷新）传 0 时会收到该 400，属预期——§14 阶段1/2 兼容用例覆盖。
      //   ⚠️ 落态一律走 T.resolveSysInitialStatusForCreate（创建路径唯一入口·不再直调 resolveInitialStatus·
      //     verify 源码扫描断言锁定），三创建入口（建单/derive/reactivate）同源。
      //   ⭐⭐ 客户端契约版本闸（codex C0 审 HIGH-1 收口）：**必须放在 intake_required 判断之前**。
      //     缺口还原：旧页面的提交逻辑是 `if (v.intake_required) body.intake_required = 1`——用户**取消勾选**时
      //     该字段被整个省略，请求体与新前端逐字相同。若只拒"字段存在"，则旧页面勾选→400（响亮）、
      //     旧页面取消勾选→201 且被服务端强制置 1（**静默改义**：用户以为关掉了受理门，实际开着）。
      //     "字段是否出现"无法区分新旧客户端，必须由客户端显式声明契约版本。
      //   ⚠️ 拒绝文案给可执行动作（强制刷新），而不是只报错——阶段1 部署后旧页面是**预期内**的常见状态（§14）。
      //   ⚠️ 严格比较不用 Number() 强制转换（codex 复审 LOW-1）：Number(['2'])===2、Number(' 2 ')===2，
      //     数组/空白包裹的字符串都会被放行，与"客户端显式声明整数版本"的契约不符。只认数字 2 与字符串 '2'。
      if (b.intake_contract_version !== SYS_INTAKE_CONTRACT_VERSION
          && b.intake_contract_version !== String(SYS_INTAKE_CONTRACT_VERSION)) {
        return res.status(400).json({
          error: '页面版本过旧（受理规则已更新：所有迭代单必经对接人受理）。请按 Ctrl+F5 强制刷新后重新建单',
          code: 'CLIENT_CONTRACT_OUTDATED',
          expected_contract_version: SYS_INTAKE_CONTRACT_VERSION,
        });
      }
      //   受理门已固化：intake_required 由服务端恒定为 1，客户端传任何值（含 0/1）都拒——失败响亮不静默。
      if (b.intake_required !== undefined) {
        return res.status(400).json({
          error: '受理门已固化：所有迭代单必经对接人受理，不再接受 intake_required 参数',
          code: 'INTAKE_REQUIRED_FIXED',
        });
      }
      const intakeRequired = 1;
      const initialStatus = T.resolveSysInitialStatusForCreate(type);

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

      // ── 通知改造 C2：建单三路径（assign_mode ∈ {A,B,none}，互斥，§2.1）──────────
      //   省略 assign_mode（既有全部调用方，含 19 套既有 verify-sys-*.js）默认 'none'——零行为变化。
      //   仅 type='bug' 可用 A/B：A 路径事务2（sysIssueTransition('assign')）要求前置态=该 type 的 assign
      //   `from` 白名单，bug 恰为初始态「待处理」；变更流初始态「待评估」≠assign 前置态「已排期」，建单后立即
      //   assign 必然 INVALID_TRANSITION——与其让调用方在"单已建但指派必然失败"的半成品态里猜原因，不如在此
      //   前置拒绝更清晰（ASSIGN_MODE_BUG_ONLY，不创建任何行）。B 路径（对接人）本就是 bug 专属概念（§3.1）。
      const rawAssignMode = (typeof b.assign_mode === 'string' && b.assign_mode.trim()) ? b.assign_mode.trim() : 'none';
      if (!['A', 'B', 'none'].includes(rawAssignMode)) {
        return res.status(400).json({ error: 'assign_mode 仅支持 A/B/none', code: 'INVALID_ASSIGN_MODE' });
      }
      const hasAssignInput = b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== '';
      const hasCollabInput = b.collaborator_ids !== undefined && b.collaborator_ids !== null;
      const hasRelayInput = b.relay_user_id !== undefined && b.relay_user_id !== null && b.relay_user_id !== '';
      if (hasAssignInput && rawAssignMode !== 'A') {
        return res.status(400).json({ error: 'assigned_to 仅在 assign_mode=A 时可传', code: 'ASSIGN_MODE_CONFLICT' });
      }
      if (hasCollabInput && rawAssignMode !== 'A') {
        return res.status(400).json({ error: 'collaborator_ids 仅在 assign_mode=A 时可传', code: 'ASSIGN_MODE_CONFLICT' });
      }
      if (hasRelayInput && rawAssignMode !== 'B') {
        return res.status(400).json({ error: 'relay_user_id 仅在 assign_mode=B 时可传', code: 'ASSIGN_MODE_CONFLICT' });
      }
      if (rawAssignMode === 'A' && !hasAssignInput) {
        return res.status(400).json({ error: 'path A 需指定主开发', code: 'ASSIGN_TARGET_REQUIRED' });
      }
      if (rawAssignMode === 'B' && !hasRelayInput) {
        return res.status(400).json({ error: 'path B 需指定通知对接人', code: 'RELAY_USER_REQUIRED' });
      }
      if (rawAssignMode !== 'none' && type !== 'bug') {
        return res.status(400).json({ error: '仅 bug 建单支持指定主开发/对接人（assign_mode）', code: 'ASSIGN_MODE_BUG_ONLY' });
      }
      // 受理排期改造 §47（C10 末次审 #1·codex149）：受理门与「建单即指派」互斥——intake_required=1（落态「待受理」）时禁 A/B。
      //   否则 path A 会把 finalStatus 拨到开发态（SF.SYS_DEV_STATUSES[type][0]·见下方 rawAssignMode==='A' 分支）跳过受理门，
      //   等于建单直接绕过受理确认（受理门核心洞）。要先受理·受理通过（intake_accept）后再走指派/改派。
      //   ⭐ 角色权限重构 C0：intakeRequired 已恒 1（见上方焊死段）→ 本守卫对 **所有** path A/B 请求生效，
      //     bug「建单即指派/建单即通知对接人」两条旧路径由此**结构性关闭**（前端 assign_mode 区同 commit 移除）。
      //     判据保留写成 `intakeRequired === 1 && ...` 而非直接判 rawAssignMode——保住"受理门开则禁 A/B"这条
      //     业务不变量的字面表达，日后若 intake 再度可变（不预期）守卫语义不随之失真。
      if (intakeRequired === 1 && rawAssignMode !== 'none') {
        return res.status(400).json({ error: '所有迭代单必经对接人受理，不能在建单时直接指派开发/对接人；请先受理通过再指派', code: 'INTAKE_WITH_ASSIGN_CONFLICT' });
      }

      // path B：白名单校验 + 反规范化姓名（单事务内随 INSERT 一并写入，无第二事务）。
      let relayUserId = null, relayUserName = null;
      if (rawAssignMode === 'B') {
        relayUserId = parsePositiveId(b.relay_user_id);
        if (!relayUserId) return res.status(400).json({ error: '通知对接人 ID 非法', code: 'INVALID_RELAY_USER' });
        if (!isSysBugLiaison(relayUserId)) return res.status(400).json({ error: '通知对接人须为白名单成员', code: 'RELAY_USER_NOT_WHITELISTED' });
        const relayUser = await dbGetAsync('SELECT id, display_name, username FROM users WHERE id = ?', [relayUserId]);
        if (!relayUser) return res.status(400).json({ error: '通知对接人不存在', code: 'RELAY_USER_NOT_FOUND' });
        relayUserName = relayUser.display_name || relayUser.username || `user#${relayUser.id}`;
      }
      // path A：主开发 id 仅做格式校验（正整数），**存在性/非 viewer/协作开发校验推迟到事务2内**
      //   （首事务字段边界，§2.2）——事务1 INSERT 不查 users、不落 assigned_*，主开发 id 只作为事务2 入参透传。
      let primaryDevIdRaw = null, collaboratorIdsRaw = [];
      if (rawAssignMode === 'A') {
        primaryDevIdRaw = parsePositiveId(b.assigned_to);
        if (!primaryDevIdRaw) return res.status(400).json({ error: '主开发 ID 非法', code: 'ASSIGN_TARGET_REQUIRED' });
        if (hasCollabInput) {
          if (!Array.isArray(b.collaborator_ids)) return res.status(400).json({ error: '协作开发须为数组', code: 'INVALID_COLLABORATOR_IDS' });
          collaboratorIdsRaw = b.collaborator_ids;
        }
      }

      const actor = sysActor(req);
      let newId = null;
      // C2（多开发协作与 commit 留痕重构 v2.9 交付物⑤）：path A 改单一事务、routeKind=CREATE 直置 DEV——
      //   替换旧版"事务1 INSERT(D_PRE) + 事务2 sysIssueTransition('assign')"两段式。旧版允许"单已建但指派
      //   失败"的半成品态（201 + assign_failed 标记）；新版失败即整体回滚（无单产生），是本次破坏性变更
      //   （既有 verify-sys-dev-assignee-transition.js 断言旧半成品态语义的用例已同步改，见交付汇报"既有
      //   测试变更清单"）。primaryUser/collaborators 预先在事务内查好（存在性/非 viewer），INSERT 主表仍先落
      //   initialStatus 占位、随后同事务内插子表、选举、UPDATE 到最终 DEV 态——从外部观察者角度等价于一步
      //   null→DEV（未提交事务外部不可见，不构成真实的 D_PRE→DEV 状态机转移，不触碰 ADMIN_TRANSITION/W07）。
      let primaryUser = null, collaborators = [];
      let finalStatus = initialStatus;
      await sysBeginImmediate();
      try {
        if (rawAssignMode === 'A') {
          primaryUser = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [primaryDevIdRaw]);
          if (!primaryUser) { await sysRollback(); return res.status(400).json({ error: '主开发用户不存在', code: 'ASSIGN_TARGET_NOT_FOUND' }); }
          if (primaryUser.role === 'viewer') { await sysRollback(); return res.status(400).json({ error: '不能指派给查看者（viewer）', code: 'ASSIGN_TARGET_VIEWER' }); }
          try {
            collaborators = await resolveCollaboratorList(collaboratorIdsRaw, primaryDevIdRaw);
          } catch (colErr) {
            // [codex C3 对抗审 M-P1 回填] 双重 sysRollback 修复——仅业务错误（SysTransitionError）在此回滚+
            //   转 HTTP 响应；非业务错误（如 resolveCollaboratorList 内部意外抛出的非 SysTransitionError
            //   异常）裸 throw，交外层 try/catch 的唯一回滚点处理（外层已有 catch(txErr){sysRollback();throw}）
            //   ——此前两个分支都先 sysRollback() 再判类型，非业务错误路径会导致内外两处各调一次
            //   sysRollback()：第一次已释放锁（releaseSysTxn 清空 __sysTxnRelease），若此时另一等待中的事务
            //   抢到锁开始新事务，第二次 sysRollback() 发出的 ROLLBACK 会错误地作用到那个新事务上（锁所有权
            //   被破坏）。
            if (colErr instanceof SysTransitionError) {
              await sysRollback();
              return res.status(colErr.httpStatus).json({ error: colErr.message, code: colErr.code });
            }
            throw colErr;
          }
          finalStatus = SF.SYS_DEV_STATUSES[type][0];
        } else {
          // H2（91 号审）：CREATE 全路径覆盖——普通建单（none）与 path B 同样必须过 assertMainStatusTransition
          //   （routeKind=CREATE，before=null→初始 D_PRE 态，零在册——D_PRE 不吃③层门禁，rosterActiveCount 传 0
          //   即可）。此前只有 path A 调用，none/B 完全绕过了不变量 7 校验，是本次 H2 收口的核心缺口。
          assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: type, before: null, after: initialStatus, rosterActiveCount: 0 });
        }

        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline,
              needs_feasibility, intake_required, related_correction_no,
              created_by, created_by_name, record_source,
              relay_notified_user_id, relay_notified_user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?)`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value,
           needsFeasibility, intakeRequired, relatedCorrectionNo,
           actor.id, actor.name,
           relayUserId, relayUserName]
        );
        newId = result.lastID;

        // ⚠️ 角色权限重构 C0 起本分支**结构性不可达**：intakeRequired 恒 1 → 上方 INTAKE_WITH_ASSIGN_CONFLICT
        //   守卫对任意 rawAssignMode !== 'none' 先行 400（方案 v1.5 §4-C0「path A/B 自然拒」）。
        //   ⚠️ **本 commit 刻意不删这段代码**：C0 的收口手段是"入口守卫拒绝"，删实现属 C5「断旧路」范围；
        //     两件事分开做，C0 才能保持"只焊死入口、不动开发态写路径"的可回滚性（§14 阶段1 回滚只需还原守卫）。
        if (rawAssignMode === 'A') {
          const memberIds = [primaryDevIdRaw, ...collaborators.map(c => c.id)];
          for (const uid of memberIds) {
            const uname = (uid === primaryDevIdRaw)
              ? (primaryUser.display_name || primaryUser.username || `user#${uid}`)
              : (collaborators.find(c => c.id === uid).name);
            const insRes = await dbRunAsync(
              `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
              [newId, uid, uname]
            );
            await insertDevEvent({ issueId: newId, devAssigneeId: insRes.lastID, action: 'add', operatorId: actor.id });
          }
          await electRepresentative(newId);
          const rosterCountRow = await dbGetAsync('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL', [newId]);
          // W01 建单直置 DEV 的不变量 7 三层校验：before=null（本次创建从未存在过）、after=finalStatus、
          //   ③层门禁靠 rosterActiveCount（S28：零在册直置 DEV→400——path A 因 assigned_to 必填结构性不可达，
          //   仅在 assertMainStatusTransition 直调单测覆盖，见交付汇报）。
          assertMainStatusTransition({ routeKind: 'CREATE', action: 'create', actionKind: null, issueType: type, before: null, after: finalStatus, rosterActiveCount: rosterCountRow.c });
          // H2（91 号审）：占位状态 UPDATE 补状态机三件套——双条件守卫（WHERE 含期望前置 status=initialStatus）
          //   + changes===1 断言（同事务内本就是唯一写者，理论不可能撞并发，但铁律要求全场景统一套用不例外）。
          const placeholderUpd = await dbRunAsync(`UPDATE sys_issues SET status = ? WHERE id = ? AND status = ?`, [finalStatus, newId, initialStatus]);
          if (!placeholderUpd || placeholderUpd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: '建单占位状态异常（数据竞争），请重试', code: 'GATE_INVARIANT' });
          }
        }

        // M4（91 号审）：created timeline 的 to_status 用最终提交状态（finalStatus），非事务内占位态
        //   （initialStatus）——path A 直置 DEV 时，占位态从未对外可见（同事务内 UPDATE 掉），时间线应如实
        //   反映"这条单创建时就直接是开发中"，而非误导性地记一条"创建到 D_PRE"再无对应"D_PRE→DEV"轨迹。
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
          [newId, finalStatus, (typeof b.description === 'string' ? b.description.trim() : null) || '信息技术部建单', actor.id, actor.name]
        );

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      if (rawAssignMode === 'A') {
        await dispatchSysNotify(newId, 'notifyAssignedDeveloper');   // best-effort，同旧版 assign 动作的通知标记
      }

      const respBody = { id: newId, type, status: finalStatus };
      if (rawAssignMode === 'B') {
        respBody.relay_notified_user_id = relayUserId;
        respBody.relay_notified_user_name = relayUserName;
      }
      if (rawAssignMode === 'A') {
        // 写读同源：与详情 GET / assign / reassign 共用同一 SELECT 列集（fetchActiveDevAssignees，防镜像漂移）。
        const devAssignees = await fetchActiveDevAssignees(newId);
        respBody.dev_assignees = devAssignees;
        const primaryRow = devAssignees.find(d => d.is_primary === 1) || {};
        respBody.assigned_to = primaryRow.user_id;
        respBody.assigned_to_name = primaryRow.user_name;
      }
      res.status(201).json(respBody);
    } catch (err) {
      // sendSysTransitionError 内部已兼容 SysTransitionError（F2：SYS_BUSY 等保 503）与 status-transition-guard.js
      // 的 MainStatusGuardError（duck-typed .httpStatus/.code），未预期错误落 500——建单场景日志加一句上下文。
      if (!(err instanceof SysTransitionError) && !(err && typeof err.httpStatus === 'number')) {
        logger.error('[系统迭代] 建单失败:', err && err.message);
      }
      sendSysTransitionError(res, err);
    }
  });

  // ── POST /sys-issues/:id/schedule：【受理排期改造 §4.2 退场】──────────
  //   排期动作（待评估→已排期）已退场：admin 排期改为「开发回填预计 → admin 定计划开工日 scheduled_start」（§7）。
  //   端点保留但恒返 409 SCHEDULE_DISABLED（比 findTransition 恒 null 的 INVALID_TRANSITION 更友好·早于引擎判断）。
  //   ⚠️ ACTION_LABELS.schedule='排期' 保留（历史 timeline 行 action_code='schedule' 仍需渲染·transitions.js）。
  router.post('/sys-issues/:id/schedule', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    return res.status(409).json({ error: '排期动作已退场：请由开发回填预计完成时间后，admin 定计划开工日', code: 'SCHEDULE_DISABLED' });
  });

  // ── POST /sys-issues/:id/assign：指派（C3 重写，去主次多开发模型；已排期→开发中 / 待处理→处理中）──────────
  //   ⚠️ 与 C2 的 POST .../dev-assignees（加人）不同：dev-assignees 面向"已在 DEV/VERIFY 族的单追加成员"，
  //   按 §4.3 矩阵对 D_PRE 族是"预指派，主状态不动"；本端点才是 D_PRE→DEV 这条边本身的唯一入口（transitions.js
  //   'assign' 具名边仍在，roleGuard='admin'/bug 单 'admin_or_bug_liaison' 未变）——旧 applyDevAssigneeDiff
  //   （单主开发差量模型）已删除，前置分析发现该端点是 6+ 个既有 verify 脚本（dev-assignee-transition/notify/
  //   bug-transitions/bug-notify/feasibility/liaison）驱动"issue 进 DEV 态"的**唯一治具**，直接删除会让全套
  //   verify 大范围失败，故按"保留 HTTP 契约（URL/请求体/响应体/错误码不变），内部换成 C2 多开发原语"重建：
  //   roster INSERT（首批成员，非 applyDevAssigneeDiff 的差量算法）→ electRepresentative → routeKind=
  //   ADMIN_TRANSITION 具名边 'assign' 校验（在册≥1 即过 enteringDev 门，findTransition 内部仍校 from=
  //   已排期/待处理）→ 双条件 UPDATE 状态机三件套 → timeline。
  //   ⚠️ 行为差异（去主次的必然结果，非 bug）：请求体 `assigned_to` 只是"首批候选成员之一"，最终谁是
  //   assigned_to（派生代表）由 electRepresentative 决定（本单首次形成 roster=在册最小 user_id，§3.6），
  //   不保证等于请求体传入值——旧模型"客户端指定谁是主开发"的授权语义正是本次要移除的对象（§0）。
  router.post('/sys-issues/:id/assign', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const devId = parsePositiveId((req.body || {}).assigned_to);
    if (!devId) return res.status(400).json({ error: '必须指定被指派开发', code: 'ASSIGN_TARGET_REQUIRED' });
    try {
      const actor = sysActor(req);
      await sysBeginImmediate();
      let devAssignees, primaryRow, targetStatus;
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // 权限精判同 sysIssueTransition [3] 口径：admin 全能；bug 对接人白名单仅限 type='bug'（§3「不全局化」）。
        if (!isSysCoordinator(actor, row.type)) {
          await sysRollback();
          return res.status(403).json({ error: '无权执行此状态流转', code: 'NOT_AUTHORIZED_FOR_TRANSITION' });
        }

        const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [devId]);
        if (!dev) { await sysRollback(); return res.status(400).json({ error: '指派目标用户不存在', code: 'ASSIGN_TARGET_NOT_FOUND' }); }
        if (dev.role === 'viewer') { await sysRollback(); return res.status(400).json({ error: '不能指派给查看者（viewer）', code: 'ASSIGN_TARGET_VIEWER' }); }
        const devName = dev.display_name || dev.username || `user#${dev.id}`;

        let collaborators;
        try {
          collaborators = await resolveCollaboratorList((req.body || {}).collaborator_ids, devId);
        } catch (colErr) {
          // [codex C3 对抗审 M-P1 回填] 双重 sysRollback 修复——同 W01 path A 落点，仅业务错误在此回滚，
          //   非业务错误裸 throw 交外层唯一回滚点（防锁所有权跨事务破坏，详见 W01 path A 处的完整说明）。
          if (colErr instanceof SysTransitionError) {
            await sysRollback();
            return res.status(colErr.httpStatus).json({ error: colErr.message, code: colErr.code });
          }
          throw colErr;
        }

        // roster INSERT（首批成员，幂等跳过已在册——本端点前置态=D_PRE，正常路径在册本为空，防御性兜底）。
        const memberIds = [devId, ...collaborators.map(c => c.id)];
        const existingActive = await dbAllAsync(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
        const existingSet = new Set(existingActive.map(r => Number(r.user_id)));
        for (const uid of memberIds) {
          if (existingSet.has(uid)) continue;
          const uname = uid === devId ? devName : collaborators.find(c => c.id === uid).name;
          const insRes = await dbRunAsync(
            `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
            [id, uid, uname]
          );
          await insertDevEvent({ issueId: id, devAssigneeId: insRes.lastID, action: 'add', operatorId: actor.id });
        }

        await electRepresentative(id);

        const rosterRows = await dbAllAsync(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
        const rosterActiveCount = rosterRows.length;
        const rosterAllComplete = rosterActiveCount > 0 && rosterRows.every(r => r.dev_status !== 'pending');
        targetStatus = SF.SYS_DEV_STATUSES[row.type][0];
        assertMainStatusTransition({
          routeKind: 'ADMIN_TRANSITION', action: 'assign', actionKind: null, issueType: row.type,
          before: row.status, after: targetStatus, rosterActiveCount, rosterAllComplete,
        });

        // [codex 100 号 HIGH-1] gate_deferred_at 防御性清除：D_PRE→DEV 是首次进 DEV 家族，结构上不可能带着
        //   陈旧 deferred（该标记仅在 DEV 家族内产生），但按处方"新 pending 生命周期（add/re-add/assign 产生
        //   pending）清标"字面要求同等处理，零成本防御。
        // [codex 101 号 MED 回填] updated_at——旧版 assign 公共 UPDATE 刷 updated_at，本处新版 /assign 补回
        //   （范围严格限定，见上方 runWGate 落点同款注释）。
        const upd = await dbRunAsync(`UPDATE sys_issues SET status = ?, updated_at = datetime('now','localtime'), gate_deferred_at = NULL WHERE id = ? AND status = ?`, [targetStatus, id, row.status]);
        if (!upd || upd.changes !== 1) {
          throw new SysTransitionError(409, 'GATE_INVARIANT', '迭代单状态已变更，请刷新重试');
        }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'assign', ?, ?, ?, ?, ?)`,
          [id, row.status, targetStatus, `指派给 ${devName}`, actor.id, actor.name]
        );

        devAssignees = await fetchActiveDevAssignees(id);
        primaryRow = devAssignees.find(d => d.is_primary === 1) || {};
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      await dispatchSysNotify(id, 'notifyAssignedDeveloper');
      res.json({ id, assigned_to: primaryRow.user_id, assigned_to_name: primaryRow.user_name, dev_assignees: devAssignees, status: targetStatus });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/:id/reassign：改派（C2 全语义重写，方案 v2.9 §3 reassign 段）──────────
  //   ⚠️ 破坏性契约变更（既有 verify-sys-*.js 断言旧语义的用例本轮已同步改，详见交付汇报"既有测试变更清单"）：
  //   旧模型 = newAssignedTo/oldAssignedTo「换主」乐观锁 + 主/协作二分；新模型 = **声明式最终 roster**
  //   （`member_ids` 数组，无主次之分——"去主次"是本次重构核心，§0）+ `reason` 必填，按最终集合与当前在册
  //   集合做一次性差量校验（D_PRE 可空 / DEV·VERIFY 最终集合≥1 / no-op→400 VALIDATION）；**先插新再移旧**
  //   （与 supersede-excuse 顺序相反，§3）；差量 events 按 operation_id 分组（同请求内共享同一 UUID）；
  //   差量落地后跑**一次** W-GATE（VERIFY 下含新增 pending→转 DEV，仅移除且剩余全完成→保持 VERIFY，矩阵§4.3）。
  //   是否主开发（is_primary）不再由请求方指定，选举全权交给 electRepresentative（§3.6）。
  router.post('/sys-issues/:id/reassign', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: '改派原因必填（trim 1..200）', code: 'VALIDATION' });
    const rawMemberIds = (req.body || {}).member_ids;
    if (!Array.isArray(rawMemberIds)) return res.status(400).json({ error: 'member_ids 须为数组（最终期望在册名单，可为空数组）', code: 'VALIDATION' });
    const targetIds = [...new Set(rawMemberIds.map(parsePositiveId))];
    if (targetIds.some(x => !x)) return res.status(400).json({ error: 'member_ids 含非法用户 id', code: 'VALIDATION' });

    const actor = sysActor(req);
    let toAdd = [], toRemove = [], gateResult = { changed: false }, rowStatusAtStart = null;
    let repChanged = false, newRepUserId = null;
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_to FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        const prevAssignedTo = (row.assigned_to !== null && row.assigned_to !== undefined) ? Number(row.assigned_to) : null;
        assertKnownIssueStatus(row.type, row.status);
        // ④ 对接人白名单 type 精判（reassign 独立事务不经 sysIssueTransition [3]，须显式）：非 admin（即中间件放行的
        //   白名单对接人）仅可改派 bug 单，不得越界改派变更流/config（§3「不全局化」，H-2 隔离）。
        if (!isSysCoordinator(actor, row.type)) {
          await sysRollback();
          return res.status(403).json({ error: '仅协调人可改派', code: 'FORBIDDEN' });
        }
        assertMemberActionFamilyAllowed('reassign', row.type, row.status);
        const family = SF.familyOfStatus(row.type, row.status);

        const currentRows = await dbAllAsync(`SELECT id, user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
        const currentIds = currentRows.map(r => Number(r.user_id));
        const currentSet = new Set(currentIds);
        const targetSet = new Set(targetIds);
        toAdd = targetIds.filter(uid => !currentSet.has(uid));
        toRemove = currentIds.filter(uid => !targetSet.has(uid));

        // [C7 回填] M3（94 号对抗审复核：旧乐观锁 REASSIGN_STALE/expectedCollaboratorIds 被 C2 去主次重写删除
        //   无等价物，双协调人先后提交会静默覆盖；复核当时降级为 backlog——"v2.9 明定 member_ids=权威最终集，
        //   事件因果准确非伪造；协调人极少+事务串行+软删可恢复"，记 C7 候选，前端改派弹窗重做时以
        //   expected_member_ids 补回，见 codex审查记录/系统迭代/94号 M3）。字段可选：不传（旧/其它调用方）
        //   完全跳过，向后兼容；传入则须与当前在册 user_id 集合（currentSet，无序）精确相等，否则视为"进入弹窗
        //   之后名单已被他人改派"，409 拒绝。校验位置刻意早于下方 no-op/LAST_ASSIGNEE 判定——防止"传入的
        //   expected 已过期但目标集合恰好等于最新在册集合"这类巧合掩盖掉真实的并发覆盖场景（虽罕见但判定顺序
        //   本身零成本，不依赖该巧合不会发生）。**契约裁定点**：REASSIGN_STALE 未登记进方案 §10 API 契约表的
        //   8 码全集——比照该表 /assign 行已有的 ASSIGN_TARGET_REQUIRED 同类先例（端点专属码，非全局错误码
        //   集合成员），前端按状态码 409 + code 精确匹配消费，不视为对全集的破坏性扩展。
        const rawExpected = (req.body || {}).expected_member_ids;
        if (rawExpected !== undefined) {
          if (!Array.isArray(rawExpected)) {
            await sysRollback();
            return res.status(400).json({ error: 'expected_member_ids 须为数组（可选，最终态一致性乐观锁）', code: 'VALIDATION' });
          }
          const expectedIds = rawExpected.map(parsePositiveId);
          if (expectedIds.some(x => !x)) {
            await sysRollback();
            return res.status(400).json({ error: 'expected_member_ids 含非法用户 id', code: 'VALIDATION' });
          }
          const expectedSet = new Set(expectedIds);
          const staleMismatch = expectedSet.size !== currentSet.size || [...expectedSet].some(uid => !currentSet.has(uid));
          if (staleMismatch) {
            await sysRollback();
            return res.status(409).json({ error: '开发名单已被他人修改，请刷新后重试', code: 'REASSIGN_STALE' });
          }
        }

        if (toAdd.length === 0 && toRemove.length === 0) {
          await sysRollback();
          return res.status(400).json({ error: '开发集合无变更，无需改派', code: 'VALIDATION' });
        }
        if ((family === 'DEV' || family === 'VERIFY') && targetIds.length === 0) {
          await sysRollback();
          return res.status(400).json({ error: '最终开发集合不能为空（当前主状态要求≥1 名开发）', code: 'LAST_ASSIGNEE' });
        }

        const operationId = crypto.randomUUID();
        const eventPayload = { operation_id: operationId, reason, added_user_ids: toAdd, removed_user_ids: toRemove };

        // 先插新（§3：与 supersede-excuse 顺序相反）——始终 INSERT 新行，不复活旧软删行（§4.4 同一原则）。
        for (const uid of toAdd) {
          const user = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [uid]);
          if (!user) { await sysRollback(); return res.status(400).json({ error: `用户不存在（id=${uid}）`, code: 'VALIDATION' }); }
          if (user.role === 'viewer') { await sysRollback(); return res.status(400).json({ error: `不能添加查看者为开发（id=${uid}）`, code: 'VALIDATION' }); }
          const userName = user.display_name || user.username || `user#${uid}`;
          const insRes = await dbRunAsync(
            `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
            [id, uid, userName]
          );
          await insertDevEvent({ issueId: id, devAssigneeId: insRes.lastID, action: 'add', reason, operatorId: actor.id, payload: eventPayload });
        }
        // 再移旧——M1（91 号审）：UPDATE 补状态机三件套（双条件守卫 WHERE issue_id/dev_status 不限但 removed_at
        //   IS NULL 必须成立 + changes===1 检查），防同一行被并发/逻辑 bug 二次移除而悄悄吞掉。
        for (const uid of toRemove) {
          const oldRow = currentRows.find(r => Number(r.user_id) === uid);
          const rmUpd = await dbRunAsync(
            `UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime') WHERE id = ? AND issue_id = ? AND removed_at IS NULL`,
            [oldRow.id, id]
          );
          if (!rmUpd || rmUpd.changes !== 1) {
            // 错误码沿用 runWGate 自身"UPDATE 乐观守卫失败"同款约定（GATE_INVARIANT/409）——本仓库对"changes≠1
            // 并发/一致性守卫失败"统一走此码，不额外发明 §10 8 码之外的新码（避免前端多出一种未声明的 code 分支）。
            throw new SysTransitionError(409, 'GATE_INVARIANT', `reassign 移除失败：目标行(id=${oldRow.id})状态异常（changes=${rmUpd && rmUpd.changes}）`);
          }
          await insertDevEvent({ issueId: id, devAssigneeId: oldRow.id, action: 'remove', reason, operatorId: actor.id, payload: eventPayload });
        }

        // M1（91 号审）：差量应用完成、选举前，重查在册 user_id 集合与 member_ids 目标集合双向判等——
        //   任何不一致（diff 逻辑本身的 bug，或极端竞态）都视为内部一致性失败，直接抛错回滚，不带着错的
        //   roster 继续往下走选举/W-GATE。错误码同上，理由同上（GATE_INVARIANT/409，不发明新码）。
        const postDiffRows = await dbAllAsync(`SELECT user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
        const postDiffSet = new Set(postDiffRows.map(r => Number(r.user_id)));
        const targetSetFinal = new Set(targetIds);
        const rosterMatches = postDiffSet.size === targetSetFinal.size && [...targetSetFinal].every(uid => postDiffSet.has(uid));
        if (!rosterMatches) {
          throw new SysTransitionError(409, 'GATE_INVARIANT',
            `reassign 差量应用后在册集合与目标集合不一致：目标=${JSON.stringify([...targetSetFinal])} 实际=${JSON.stringify([...postDiffSet])}`);
        }

        await electRepresentative(id);
        const afterRow = await dbGetAsync('SELECT assigned_to FROM sys_issues WHERE id = ?', [id]);
        newRepUserId = (afterRow && afterRow.assigned_to !== null && afterRow.assigned_to !== undefined) ? Number(afterRow.assigned_to) : null;
        repChanged = prevAssignedTo !== newRepUserId;

        gateResult = await runWGate(id, row.type, row.status, actor);   // 一次 W-GATE（差量已全部落地）
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      // post-commit best-effort：通知 + 讨论群同步（M5·91 号审：判定基准从"toAdd.length>0"改为"代表真实
      //   变化"——旧判定会在"只加协作、代表未变"时误发重复通知，也会在"纯移除导致代表被动换人"时漏发；
      //   代表真实变化才是"需要通知新负责人"的准确信号）。
      if (repChanged && newRepUserId !== null) {
        await dispatchSysNotify(id, 'notifyAssignedDeveloper');
        await syncSysChatAddDev(id, newRepUserId);
      }
      const devAssignees = await fetchActiveDevAssignees(id);
      res.json({ id, added_user_ids: toAdd, removed_user_ids: toRemove, main_status: gateResult.changed ? gateResult.to : rowStatusAtStart, dev_assignees: devAssignees });
    } catch (err) {
      sendSysTransitionError(res, err);
    }
  });

  // ============================================================
  // C2（多开发协作与 commit 留痕重构 v2.9）：成员 API 四端点
  //   POST dev-assignees（add/re-add）/ DELETE dev-assignees/:id（remove/self-remove）/
  //   POST dev-assignees/:id/excuse / POST dev-assignees/:id/supersede-excuse
  //   方案 §10 API 契约 + §4.3 矩阵 + §5.2 布尔表；均为**全新端点**（无现网先例），故不接任何钉钉通知派发——
  //   W12 红线是"不改既有触发点"，新端点没有既有触发点可改，通知/群同步接线属未来 commit（已在交付汇报列明）。
  // ============================================================

  // ── POST /sys-issues/:id/dev-assignees：加人/复活（协调人）──────────
  router.post('/sys-issues/:id/dev-assignees', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const rawIds = (req.body || {}).user_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) return res.status(400).json({ error: 'user_ids 必须为非空数组', code: 'VALIDATION' });
    try {
      const actor = sysActor(req);
      let addResult = { added: [], skipped: [] }, gateResult = { changed: false }, rowStatusAtStart = null;
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        if (!isSysCoordinator(actor, row.type)) { await sysRollback(); return res.status(403).json({ error: '仅协调人可操作', code: 'FORBIDDEN' }); }
        assertMemberActionFamilyAllowed('add', row.type, row.status);

        addResult = await addOrReaddMembers(id, rawIds, actor.id);
        await electRepresentative(id);
        gateResult = await runWGate(id, row.type, row.status, actor);
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      const devAssignees = await fetchActiveDevAssignees(id);
      res.json({
        id, added_dev_assignee_ids: addResult.added, skipped_user_ids: addResult.skipped,
        main_status: gateResult.changed ? gateResult.to : rowStatusAtStart, dev_assignees: devAssignees,
      });
    } catch (err) {
      sendSysTransitionError(res, err);
    }
  });

  // ── DELETE /sys-issues/:id/dev-assignees/:assigneeId：移除/自行移除（协调人∨本人）──────────
  //   reason 经 body 传（DELETE 请求体，Express 需 express.json() 已挂——本项目全局已挂，同其余 DELETE 附件端点范式）。
  router.delete('/sys-issues/:id/dev-assignees/:assigneeId', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const assigneeId = parsePositiveId(req.params.assigneeId);
    if (!id || !assigneeId) return res.status(400).json({ error: '无效的参数', code: 'VALIDATION' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason 必填（trim 1..200，经 body 传）', code: 'VALIDATION' });
    try {
      const actor = sysActor(req);
      let gateResult = { changed: false }, rowStatusAtStart = null, isSelf = false;
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);

        const target = await dbGetAsync('SELECT id, user_id, removed_at FROM sys_issue_dev_assignees WHERE id = ? AND issue_id = ?', [assigneeId, id]);
        if (!target || target.removed_at !== null) { await sysRollback(); return res.status(400).json({ error: '目标不在册', code: 'VALIDATION' }); }
        isSelf = Number(target.user_id) === Number(actor.id);
        const isCoordinator = isSysCoordinator(actor, row.type);
        if (!isSelf && !isCoordinator) { await sysRollback(); return res.status(403).json({ error: '仅协调人或本人可移除', code: 'FORBIDDEN' }); }
        assertMemberActionFamilyAllowed('remove', row.type, row.status);

        const family = SF.familyOfStatus(row.type, row.status);
        const gated = family === 'DEV' || family === 'VERIFY';
        const activeCountRow = await dbGetAsync('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL', [id]);
        if (gated && Number(activeCountRow.c) === 1) {
          await sysRollback();
          return res.status(400).json({ error: '不能移除在册最后一名开发', code: 'LAST_ASSIGNEE' });
        }
        if (family === 'VERIFY') {
          // 防御性再校验（矩阵§4.3 VERIFY/remove 行"剩余存在未完成→拒绝"）：VERIFY 的"全员完成"不变量正常
          // 由 P14 恒等式保证不可达，此处仍显式再核一遍，双保险不迷信调用前状态必然自洽。
          const remaining = await dbAllAsync('SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL AND id != ?', [id, assigneeId]);
          if (remaining.some(r => r.dev_status === 'pending')) {
            await sysRollback();
            return res.status(400).json({ error: '待验证态下移除后剩余成员存在未完成，拒绝', code: 'GATE_INVARIANT' });
          }
        }

        // M1（91 号审）：状态机三件套——双条件守卫 WHERE（issue_id + removed_at IS NULL）+ changes===1 检查。
        const rmUpd = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime') WHERE id = ? AND issue_id = ? AND removed_at IS NULL`,
          [assigneeId, id]
        );
        if (!rmUpd || rmUpd.changes !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '目标状态已变化（可能已被移除），请重试', code: 'GATE_INVARIANT' });
        }
        await insertDevEvent({ issueId: id, devAssigneeId: assigneeId, action: isSelf ? 'self-remove' : 'remove', reason, operatorId: actor.id });
        await electRepresentative(id);
        gateResult = await runWGate(id, row.type, row.status, actor);
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      const devAssignees = await fetchActiveDevAssignees(id);
      res.json({ id: assigneeId, removed: true, self: isSelf, main_status: gateResult.changed ? gateResult.to : rowStatusAtStart, dev_assignees: devAssignees });
    } catch (err) {
      sendSysTransitionError(res, err);
    }
  });

  // ── POST /sys-issues/:id/dev-assignees/:assigneeId/excuse：开脱（协调人；仅 SYS_DEV；目标须 pending）──────────
  //   D11：允许开脱最后一名 pending（全员开脱=协调人显式行为，若因此触发"全员完成"→ W-GATE 天然进待验证）。
  router.post('/sys-issues/:id/dev-assignees/:assigneeId/excuse', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const assigneeId = parsePositiveId(req.params.assigneeId);
    if (!id || !assigneeId) return res.status(400).json({ error: '无效的参数', code: 'VALIDATION' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason 必填（trim 1..200）', code: 'VALIDATION' });
    try {
      const actor = sysActor(req);
      let gateResult = { changed: false }, rowStatusAtStart = null;
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        if (!isSysCoordinator(actor, row.type)) { await sysRollback(); return res.status(403).json({ error: '仅协调人可操作', code: 'FORBIDDEN' }); }
        assertMemberActionFamilyAllowed('excuse', row.type, row.status);   // 仅 SYS_DEV

        const target = await dbGetAsync('SELECT id, dev_status FROM sys_issue_dev_assignees WHERE id = ? AND issue_id = ? AND removed_at IS NULL', [assigneeId, id]);
        if (!target) { await sysRollback(); return res.status(400).json({ error: '目标不在册', code: 'VALIDATION' }); }
        // 双条件守卫 UPDATE + changes 检查（状态机 UPDATE 三件套铁律）：目标须 pending 才能开脱。
        const upd = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET dev_status = 'excused', resolved_at = datetime('now','localtime')
             WHERE id = ? AND dev_status = 'pending' AND removed_at IS NULL`,
          [assigneeId]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(400).json({ error: '目标须为 pending 才能开脱', code: 'INVALID_STATUS' }); }
        await insertDevEvent({ issueId: id, devAssigneeId: assigneeId, action: 'excuse', reason, operatorId: actor.id });
        await electRepresentative(id);
        gateResult = await runWGate(id, row.type, row.status, actor);
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      const devAssignees = await fetchActiveDevAssignees(id);
      res.json({ id: assigneeId, dev_status: 'excused', main_status: gateResult.changed ? gateResult.to : rowStatusAtStart, dev_assignees: devAssignees });
    } catch (err) {
      sendSysTransitionError(res, err);
    }
  });

  // ── POST /sys-issues/:id/dev-assignees/:assigneeId/supersede-excuse：开脱恢复（协调人；§4.2 八步固定序逐字）──────────
  router.post('/sys-issues/:id/dev-assignees/:assigneeId/supersede-excuse', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const assigneeId = parsePositiveId(req.params.assigneeId);
    if (!id || !assigneeId) return res.status(400).json({ error: '无效的参数', code: 'VALIDATION' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason 必填（trim 1..200）', code: 'VALIDATION' });
    try {
      const actor = sysActor(req);
      let gateResult = { changed: false }, rowStatusAtStart = null, newAssigneeId = null;
      // 1. BEGIN IMMEDIATE
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        // 2. 校验（协调人；主状态∈SYS_DEV∪SYS_VERIFY；目标在册∧excused）
        if (!isSysCoordinator(actor, row.type)) { await sysRollback(); return res.status(403).json({ error: '仅协调人可操作', code: 'FORBIDDEN' }); }
        assertMemberActionFamilyAllowed('supersede', row.type, row.status);   // SYS_DEV∪SYS_VERIFY
        const target = await dbGetAsync('SELECT id, user_id, user_name, dev_status, removed_at FROM sys_issue_dev_assignees WHERE id = ? AND issue_id = ?', [assigneeId, id]);
        if (!target || target.removed_at !== null || target.dev_status !== 'excused') {
          await sysRollback();
          return res.status(400).json({ error: '目标须在册且为 excused 才能开脱恢复', code: 'SUPERSEDE_PRECONDITION' });
        }
        // 3. UPDATE 旧行 removed_at=now（禁先插新——会撞 uq_dev_assignee_roster 部分唯一索引，§4.2 注）
        //    M1（91 号审）：状态机三件套——双条件守卫 WHERE（dev_status='excused' + removed_at IS NULL，与步骤 2
        //    的前置校验同条件）+ changes===1 检查，防目标在校验后到 UPDATE 前被并发改变（同事务内理论不可能，
        //    仍按铁律显式核验，不依赖"调用前状态必然自洽"的隐式假设）。
        const rmUpd = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET removed_at = datetime('now','localtime')
             WHERE id = ? AND issue_id = ? AND dev_status = 'excused' AND removed_at IS NULL`,
          [assigneeId, id]
        );
        if (!rmUpd || rmUpd.changes !== 1) {
          throw new SysTransitionError(409, 'SUPERSEDE_PRECONDITION', `开脱恢复失败：目标(id=${assigneeId})状态已变化（changes=${rmUpd && rmUpd.changes}）`);
        }
        // 4. INSERT 新 pending（复制旧实例 issue_id+user_id）→ newId
        const insRes = await dbRunAsync(
          `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 0, 'pending')`,
          [id, target.user_id, target.user_name]
        );
        newAssigneeId = insRes.lastID;
        // 5. UPDATE 旧行 superseded_by=newId（M1：补 WHERE id=?/issue_id=? + changes===1；superseded_by 此时必为
        //    NULL——本函数是唯一写路径，同一行不会被 supersede 两次，仍显式核验不吞错）。
        const supUpd = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET superseded_by = ? WHERE id = ? AND issue_id = ? AND superseded_by IS NULL`,
          [newAssigneeId, assigneeId, id]
        );
        if (!supUpd || supUpd.changes !== 1) {
          throw new SysTransitionError(409, 'SUPERSEDE_PRECONDITION', `开脱恢复失败：superseded_by 回写异常（id=${assigneeId}，changes=${supUpd && supUpd.changes}）`);
        }
        // 6. 选举+门禁；VERIFY→DEV
        await electRepresentative(id);
        gateResult = await runWGate(id, row.type, row.status, actor);
        // 7. event supersede-excuse（dev_assignee_id=旧，related=newId，与 superseded_by 必一致，reason）
        await insertDevEvent({ issueId: id, devAssigneeId: assigneeId, relatedDevAssigneeId: newAssigneeId, action: 'supersede-excuse', reason, operatorId: actor.id });
        // 8. COMMIT
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      const devAssignees = await fetchActiveDevAssignees(id);
      res.json({ id: assigneeId, new_dev_assignee_id: newAssigneeId, main_status: gateResult.changed ? gateResult.to : rowStatusAtStart, dev_assignees: devAssignees });
    } catch (err) {
      sendSysTransitionError(res, err);
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
      // [codex C3 对抗审 HIGH-B 回填] 在册成员读可见性——SSOT §0（方案 v2.9 line 33）明定角色读权：
      //   "开发=在册∧pending；历史参与=子表曾有行且当前不在册——只读整单+可下附件"，且 line 88
      //   "`is_primary`/`assigned_to` 禁作授权源"。此前列表 WHERE 只认 assigned_to（纯派生代表，去主次后
      //   不再等于"谁在干活"）——非代表的在册协作成员（assertDevMember 判定有写权）反而列表看不到、详情
      //   直接 403，与 SSOT 字面定义矛盾。历史参与是否可见按 SSOT 原文"只读整单"字面理解（非"仅可下附件"，
      //   附件是历史参与读权的子集示例非全部）——一并纳入，用 `EXISTS` 子查询覆盖"曾有行"（不筛 removed_at，
      //   在册与历史参与同等可见，与 SSOT 措辞完全对应，不额外区分）。
      const rosterVisibilitySql = `EXISTS (SELECT 1 FROM sys_issue_dev_assignees da WHERE da.issue_id = sys_issues.id AND da.user_id = ?)`;
      // ⭐ 角色权限重构 C1（codex C1 审 HIGH-2）：**受理人[13] 全类型可见**，与 admin 同不加 where 限制。
      //   必要性：C1 把指派权扩到全类型，若列表仍只放行 bug，示例对接人就会「后端能指派 feature、界面却找不到那张单」
      //   ——写读不同源造成的功能断裂（[[feedback_write_read_same_semantic]]）。受理人要受理**所有**新单、
      //   指派**所有**类型，故其可见面与 admin 一致（作废单仍由下方 include_voided 统一过滤，那条仅 admin 生效）。
      const isIntakeLiaisonUser = isSysIntakeLiaison(uid);
      if (!isAdmin && !isIntakeLiaisonUser) {
        // ④ bug 对接人白名单（**可见性语义·非操作权**）：C1 后该名单在写路径上已完全退场，
        //   这里保留是因为技术负责人示例发布者[7] 仍需看到 bug 单才能接收咨询、回评估意见（C3）。
        //   ⚠️ 必与详情读端同源，否则「列表看不到但能开详情」写读不一致。
        if (isSysBugLiaison(uid)) {
          where.push(`(assigned_to = ? OR type = 'bug' OR ${rosterVisibilitySql})`);
          params.push(uid, uid);
        } else {
          // 非 admin 非对接人：自己被指派的单（开发）∪ 被指定为上线执行开发的单（release_assignee_id，通知改造 C-orch）
          //   ∪ 在册/历史参与该单的成员（HIGH-B）。
          //   ⚠️ 写读同源（[[feedback_write_read_same_semantic]]）：execute-release 把上线终态写权授给 release_assignee_id，
          //   读端必须镜像——否则被指定执行开发（既非 assigned_to 也非白名单对接人时）列表看不到该单、够不到「执行上线」。
          //   release orchestration 是 bug 专属，故 release_assignee_id 仅对 bug 有值，无需再叠 type 条件；详情端点同步放行。
          where.push(`(assigned_to = ? OR release_assignee_id = ? OR ${rosterVisibilitySql})`);
          params.push(uid, uid, uid);
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

      // C1（多开发协作与 commit 留痕重构 v2.9 §13 S1）：列表负责人列改多人展示——子查询聚合在册成员名
      //   （removed_at IS NULL，按 user_id 升序），避免逐行 N+1 查询；assigned_to_name 原样保留（兼容旧前端/
      //   其余读它的地方不动，C1 只加不减）。
      //   ⚠️ LOW-1（89 号审）：`dev_roster_names` 字段值协议 = **JSON 数组字符串**（如 '["张三","李四"]'），
      //   非逗号拼接明文——display_name 无"禁逗号"约束，人名本身可能含英文逗号，逗号拼接不可逆（前端 split(',')
      //   会把 "张三,李" 这种单个含逗号的名字错拆成两截）。改用 json_group_array（内层子查询仍先 ORDER BY 再
      //   聚合，json_group_array 同 GROUP_CONCAT 一样不支持直接 ORDER BY）——零命中时返回合法空数组 '[]'
      //   （非 NULL，SQLite 聚合函数对 json_group_array 的空集特例，已用真实 db 验证），前端 JSON.parse 后
      //   按数组长度判断是否需要回退 assigned_to_name。字段名保留 `dev_roster_names` 不改（减少改动面），
      //   值类型变更已在本注释 + 前端 JSON.parse 处双向留痕。
      const rows = await dbAllAsync(
        `SELECT id, type, status, priority, title, system_name, module_name, source,
                assigned_to, assigned_to_name, scheduled_start, dev_estimated_at, deadline,
                created_by, created_by_name, origin_issue_id, release_id, needs_release,
                release_assignee_id, release_assignee_name, release_assignee_notify_status,
                reopen_count, return_count, scope_changed, created_at, updated_at,
                (SELECT json_group_array(user_name) FROM (
                   SELECT user_name FROM sys_issue_dev_assignees
                    WHERE issue_id = sys_issues.id AND removed_at IS NULL
                    ORDER BY user_id ASC
                 )) AS dev_roster_names
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
      // [codex 101 号 LOW 回填] gate_deferred_at 是 GATE 纵深方案 A 的内部实现标记（服务端消费，见方案
      //   §16 补丁五置/清/消费规则表），非读模型字段——`SELECT *` 会连带把它塞进 `row` 一并 res.json 出去，
      //   在此删除（既有代码侵入最小：不改 SELECT 语句、不改下方长 res.json 行）。列表端点（GET /sys-issues）
      //   本就用显式列投影，不含该列，不受影响。
      delete row.gate_deferred_at;

      // 可见性（M-6）：admin 看全部 / 开发本人（assigned_to）可见 / 其他 403。
      //   ⚠️ codex 14 M-1：**与列表读端同源**——列表非 admin 仅 assigned_to=本人，详情必须一致，
      //   故详情**不含 isCreator**（方案 §9 M-6 矩阵无"建单人可见"项；isCreator 会造成"列表看不到但能开详情"
      //   写读不一致，且 native 建单 requireAdmin → created_by 恒 admin，isCreator 对非 admin 永不成立=死代码+未来 import 风险）。
      const role = req.user.role, uid = Number(req.user.id);
      const isAdmin = role === 'admin';
      const isAssignee = Number(row.assigned_to) === uid && uid > 0;
      // ⭐ 角色权限重构 C1（codex C1 审 HIGH-2）：受理人[13] **全类型**可见详情，与列表读端同源。
      //   理由同列表：C1 的全类型指派权若没有配套的全类型可见性，就会出现"能指派却打不开单"的断裂。
      const isIntakeLiaisonUser = isSysIntakeLiaison(uid);
      // ④ bug 对接人白名单（**可见性语义·非操作权**）：C1 后写路径已完全不用该名单；
      //   保留可见性是为技术负责人示例发布者[7] 能看到 bug 单以接收咨询、回评估意见（C3）。
      const isBugLiaison = isSysBugLiaison(uid) && row.type === 'bug';
      // C-orch 写读同源：被指定上线执行开发（release_assignee_id）可见 bug 单详情（否则够不到「执行上线」按钮）——
      //   与列表读端同源；release orchestration 是 bug 专属，故叠 type='bug' 精判。
      const isReleaseExecutor = Number(row.release_assignee_id) === uid && uid > 0 && row.type === 'bug';
      // [codex C3 对抗审 HIGH-B 回填] 在册/历史参与成员读可见性——与列表读端同源（同一 EXISTS 语义，SSOT 依据
      //   同上方列表端点注释：方案 v2.9 line 33"历史参与…只读整单"+ line 88"assigned_to 禁作授权源"）。
      const isRosterMember = uid > 0 && !!(await dbGetAsync(
        `SELECT 1 FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? LIMIT 1`, [id, uid]
      ));
      // ⭐ C1：受理人加入放行集（全类型·与列表读端同源）
      if (!isAdmin && !isIntakeLiaisonUser && !isAssignee && !isBugLiaison && !isReleaseExecutor && !isRosterMember) {
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
      // ── 通知改造 C2 §E（写读同源）：多开发协作子表 join，附录 A 读接口契约——
      //   仅 removed_at IS NULL 在册行，主开发（is_primary=1）排前。通知能力派生（can_send 等）/发送/
      //   read-status 属 C3、前端渲染属 C4/C5——本批只保证这里的数据结构正确，不做更多。
      //   ⚠️ 写读同源铁律：本列集用 fetchActiveDevAssignees 单一来源，与全部 mutation 响应镜像
      //   （path A 建单/assign/reassign/C2 四新端点）共用同一 SELECT，杜绝各自手写漂移。
      const devAssignees = await fetchActiveDevAssignees(id);
      // P4（详情端补查·仅此端点）：每个在册 dev 最近一次 submit/no_code 事件的 work_note（工作说明）——从 dev_events
      //   payload_json 提取（json_extract），按 dev_assignee_id 关联当前在册行，取该行最近事件（id DESC LIMIT 1）。
      //   写读同源：写侧落 submit/no_code 事件 payload_json.work_note（上方 eventPayload），读侧此处提取回填。
      //   多开发各自 work_note 不覆盖（各 dev_assignee 行独立取自己的事件）。合并进 devAssignees 供开发成员区展示。
      if (devAssignees && devAssignees.length) {
        const workNoteRows = await dbAllAsync(
          `SELECT e.dev_assignee_id AS da_id,
                  json_extract(e.payload_json, '$.work_note') AS work_note,
                  e.created_at AS submitted_at
             FROM sys_issue_dev_events e
             JOIN (
               SELECT dev_assignee_id, MAX(id) AS max_id
                 FROM sys_issue_dev_events
                WHERE issue_id = ? AND action IN ('submit','no_code')
                GROUP BY dev_assignee_id
             ) latest ON latest.dev_assignee_id = e.dev_assignee_id AND latest.max_id = e.id
            WHERE e.issue_id = ?`,
          [id, id]
        );
        // codex P4 审 LOW-1：work_note 与 work_note_submitted_at 成对——某 dev 提交了但没填 work_note 时（事件存在但
        //   payload 无 work_note 键→json_extract 返 null），submitted_at 也置 null，避免"有时刻无内容"的脏字段语义。
        const wnMap = new Map(workNoteRows.map(r => {
          const note = r.work_note || null;
          return [r.da_id, { work_note: note, submitted_at: note ? r.submitted_at : null }];
        }));
        for (const d of devAssignees) {
          const wn = wnMap.get(d.id);
          d.work_note = wn ? wn.work_note : null;
          d.work_note_submitted_at = wn ? wn.submitted_at : null;
        }
      }
      // C1（新增）：commit 留痕行（方案 §13 S1「各自 commit 行」+ §8 快照口径同源——含 removed 实例的行，
      //   即使该实例已软删也不撤回其历史 commit 记录）。JOIN 取 user_name 供前端直接渲染"开发"列，不用前端
      //   自行按 dev_assignee_id 反查在册成员名（在册成员可能已被移除，join 用 sys_issue_dev_assignees 的
      //   历史行本身取名，非当前在册集合）。C3/C4 写入口尚未接线，当前表必为空，返回 []。
      const devCommits = await dbAllAsync(
        `SELECT c.id, c.dev_assignee_id, c.dev_user_id, da.user_name AS dev_user_name,
                c.component, c.commit_ref, c.created_at, c.updated_at
           FROM sys_issue_dev_commits c
           JOIN sys_issue_dev_assignees da ON da.id = c.dev_assignee_id
          WHERE c.issue_id = ?
          ORDER BY c.id ASC`,
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
      res.json({ issue: row, timeline, attachments, specAttachments, hasSpecAttachment: specAttachments.length > 0, origin_issue: originIssue, derived_issues: derivedIssues, related_correction: relatedCorrection, dev_assignees: devAssignees, dev_commits: devCommits });
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

  // ============================================================
  // C3 交付物：W05 唯一 submit（多开发 commit 事件模型，方案 §6.1/§6.2，联合 SSOT 计划 §2.2/§2.5）
  //   唯一写入口 = POST /api/sys-issues/:id/submit（W16 编号保留，无第二 URL，Step0 路由枚举已证实）。
  //   不再走 sysIssueTransition/makeTransitionEndpoint（旧单人 summary+attachment 模型随之退场，见上方
  //   'submit' switch 分支退场注释）。独立事务，按 §6.2 五步固定序执行。
  // ============================================================

  const COMMIT_COMPONENTS = ['frontend', 'backend'];   // 与 sys_issue_dev_commits.component 的 DDL CHECK 同源（附录C）

  // §6.1 body 结构校验（写库前拒绝，纯函数不接 db）：mode='no_code'|'commits' 互斥，多余字段/null→VALIDATION。
  //   返回 { ok:true, mode, noCodeReason, commits:[{component,commit_ref}] } 或 { ok:false, message }。
  function validateSubmitBody(body) {
    const b = body || {};
    // [codex 100 号 HIGH-2 回填] fix_gap_note 纳入 §6.1 body 契约的"条件字段"——是否必填取决于事务内 row 状态
    //   （派生自 bug 的 bug 单首次提交），此处只做类型层放行（同旧代码 non-string→视为未填，不在此报错），
    //   必填判定与真正校验在事务内进行（见 submit handler 内 [codex 100 号 HIGH-2 回填] 注释）。
    const ALLOWED_TOP_KEYS = ['mode', 'no_code_reason', 'commits', 'fix_gap_note', 'work_note'];   // P4：+work_note（选填工作说明）
    const extraTop = Object.keys(b).filter(k => !ALLOWED_TOP_KEYS.includes(k));
    if (extraTop.length > 0) return { ok: false, message: `不支持的字段：${extraTop.join(',')}` };
    if (b.mode !== 'no_code' && b.mode !== 'commits') return { ok: false, message: 'mode 仅支持 no_code/commits' };
    const fixGapNote = typeof b.fix_gap_note === 'string' ? b.fix_gap_note : null;
    // P4 work_note（选填·两模式均可带）：非 string 且非 undefined/null → 400（不静默吞·方案 §4.3 H-MED）；
    //   trim 上限 1000 字符（Unicode 码点 [...str].length 计·防中文/emoji 组合字符按字节误判）；空白落 null（统一）。
    if (b.work_note !== undefined && b.work_note !== null && typeof b.work_note !== 'string') {
      return { ok: false, message: 'work_note 须为字符串' };
    }
    const workNoteRaw = typeof b.work_note === 'string' ? b.work_note.trim() : '';
    if ([...workNoteRaw].length > 1000) return { ok: false, message: 'work_note 过长（上限 1000 字）' };
    const workNote = workNoteRaw || null;

    if (b.mode === 'no_code') {
      if (b.no_code_reason === null) return { ok: false, message: 'no_code_reason 不能为 null' };
      const reason = (typeof b.no_code_reason === 'string' ? b.no_code_reason.trim() : '');
      if (!reason || reason.length > 500) return { ok: false, message: 'no_code_reason 必填（trim 长度 1..500）' };
      if (b.commits !== undefined && b.commits !== null) {
        if (!Array.isArray(b.commits)) return { ok: false, message: 'commits 须为数组' };
        if (b.commits.length > 0) return { ok: false, message: 'no_code 模式不应携带非空 commits' };
      }
      return { ok: true, mode: 'no_code', noCodeReason: reason, commits: [], fixGapNote, workNote };
    }

    // mode === 'commits'
    if (b.no_code_reason !== undefined) return { ok: false, message: 'commits 模式禁止携带 no_code_reason 字段' };
    if (!Array.isArray(b.commits) || b.commits.length === 0) return { ok: false, message: 'commits 至少 1 条' };
    // commit 记录改造（2026-07-19）：删除「同 component 至多 1 条」限制——前端改为「前端组/后端组」两分组、组内多行，
    //   同一 component 可含多条 commit。完全重复行（同实例+component+ref）由 §6.2 步骤4 自然键查重兜底（同批第一条
    //   入库后第二条 SELECT 即命中→400），故此处不再维护 seenComponents，仅做元素级字段校验。
    const commits = [];
    for (const raw of b.commits) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'commits 元素非法' };
      const extraCommitKeys = Object.keys(raw).filter(k => !['component', 'commit_ref'].includes(k));
      if (extraCommitKeys.length > 0) return { ok: false, message: `commits 元素含不支持字段：${extraCommitKeys.join(',')}` };
      if (!COMMIT_COMPONENTS.includes(raw.component)) return { ok: false, message: 'component 仅支持 frontend/backend' };
      if (typeof raw.commit_ref !== 'string') return { ok: false, message: 'commit_ref 须为字符串' };
      const ref = raw.commit_ref.trim();
      if (!ref || ref.length > 200) return { ok: false, message: 'commit_ref 必填（trim 长度 1..200）' };
      commits.push({ component: raw.component, commit_ref: ref });
    }
    return { ok: true, mode: 'commits', noCodeReason: null, commits, fixGapNote, workNote };
  }

  router.post('/sys-issues/:id/submit', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const parsed = validateSubmitBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message, code: 'VALIDATION' });

    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      let memberRow, targetDevStatus, gateResult, rowStatusAtStart, devAssignees;
      try {
        // §6.2 步骤1：assertKnownIssueStatus → 解析在册实例（0 行→403 NOT_ROSTERED）
        const row = await dbGetAsync(
          `SELECT id, type, status, blocked, needs_feasibility, feasibility_conclusion,
                  feasibility_requirement_confirm, feasibility_risk, dev_estimated_at,
                  first_submitted_at, origin_issue_id
             FROM sys_issues WHERE id = ?`,
          [id]
        );
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        memberRow = await assertDevMember(id, actor.id);

        // §6.2 步骤2：断言主状态∈SYS_DEV（按 issue_type）——body 已在路由层前置校验
        if (!SF.isInFamily(row.type, row.status, 'DEV')) {
          await sysRollback();
          return res.status(409).json({ error: `当前状态「${row.status}」不可提交`, code: 'INVALID_STATUS' });
        }

        // [codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED——旧单人 case 'submit'（e39e65b 版 index.js:1376）
        //   `if (!row.dev_estimated_at) throw new SysTransitionError(400, 'ESTIMATE_REQUIRED', ...)`，位于
        //   SUBMIT_SUMMARY_REQUIRED 之后、blocked/feasibility 闸之前，**无 type 限定**（bug 流同样受理，逐字
        //   核对旧代码确认，非按 W06 口径猜测裁剪）。SUBMIT_SUMMARY_REQUIRED 本身不复刻（summary 字段已被
        //   新 §6.1 mode 专属必填校验取代，见 validateSubmitBody），但 ESTIMATE_REQUIRED 是独立不变量，
        //   与 summary 校验無关联，需单独复刻。
        if (!row.dev_estimated_at) {
          await sysRollback();
          return res.status(400).json({ error: '请先回填预计完成时间', code: 'ESTIMATE_REQUIRED' });
        }

        // [codex 100 号 HIGH-2 回填] first_submitted_at 首次原子盖章 + 派生 bug 首提 fix_gap_note 闸门——
        //   旧单人 case 'submit'（e39e65b 版 index.js:1378-1396）逐条复刻，与 W05 唯一 submit 收敛无关，
        //   属新 submit handler 遗漏的第二处 C2 既有不变量静默回归（与 98 号 HIGH 同类），本轮一并回填：
        //   ① first_submitted_at 首次永不变（§3.5），仅当前值为空才写，返工重提不覆写；
        //   ② fix_gap_note 首提闸门（谓词 [审:H3]+[审:M5]，bug流_方案_v1.2 §4）：仅「派生自 bug
        //     （origin_issue_id 存在）∧ 新单也是 bug（row.type='bug'）∧ 首次提交（first_submitted_at 为空）」
        //     触发必填；跨类型 bug→feature 与非派生单自然跳过（M5）；origin 查不到 → 409 SYS_ORIGIN_MISSING
        //     fail-closed（谱系脏数据，防绕过留痕）；返工重提（first_submitted_at 已盖）不再要求也不覆写
        //     （fix_gap_note = 首版修复缺口一次性留痕）。判定共用 !row.first_submitted_at 条件，与①同源。
        const isFirstSubmission = !row.first_submitted_at;
        if (isFirstSubmission && row.origin_issue_id && row.type === 'bug') {
          const originForGap = await dbGetAsync('SELECT type FROM sys_issues WHERE id = ?', [row.origin_issue_id]);
          if (!originForGap) {
            await sysRollback();
            return res.status(409).json({ error: '派生单的原单不存在（谱系数据异常），请联系管理员', code: 'SYS_ORIGIN_MISSING' });
          }
          if (originForGap.type === 'bug') {
            const gap = (typeof parsed.fixGapNote === 'string' ? parsed.fixGapNote.trim() : '');
            if (!gap) {
              await sysRollback();
              return res.status(400).json({ error: '派生自 bug 的修复单首次提交需填写「修复缺口说明」', code: 'FIX_GAP_NOTE_REQUIRED' });
            }
            await dbRunAsync(`UPDATE sys_issues SET fix_gap_note = ? WHERE id = ?`, [gap, id]);
          }
        }
        if (isFirstSubmission) {
          await dbRunAsync(`UPDATE sys_issues SET first_submitted_at = datetime('now','localtime') WHERE id = ? AND first_submitted_at IS NULL`, [id]);
        }

        // [codex 98 号 HIGH 回填] submit 资格不变量（方案 §6 补记）：blocked/feasibility 两道硬闸——
        //   旧单人 case 'submit'（e39e65b 版 index.js:1405-1428）逐条复刻，判定/错误码/触发条件原样照搬，
        //   不重新设计。仅 issue 级字段（blocked/needs_feasibility/feasibility_*），与 dev_assignee 子表/
        //   commit 事件模型正交，故置于同一事务内、家族校验之后 / dev_status UPDATE 之前，与被更新工单同一
        //   事务快照（row 已在本函数入口读取，非重新查询，避免竞态窗口）。仅 feature/improvement 触发
        //   （bug/config 不受理 feasibility/blocked，§2.2 裁剪，与 SYS_W06_ALLOWED_STATUS 口径一致）。
        if (['feature', 'improvement'].includes(row.type)) {
          if (row.blocked === 1) {
            await sysRollback();
            return res.status(400).json({ error: '该单已受阻，不能提交（请先解除受阻）', code: 'ISSUE_BLOCKED' });
          }
          if (row.needs_feasibility === 1) {
            if (!row.feasibility_conclusion) {
              await sysRollback();
              return res.status(400).json({ error: '请先填写可行性评估', code: 'FEASIBILITY_REQUIRED' });
            }
            if (!['可行', '有条件可行', '不可行'].includes(row.feasibility_conclusion)) {
              await sysRollback();
              return res.status(400).json({ error: '可行性评估结论非法，请重新填写', code: 'FEASIBILITY_REQUIRED' });
            }
            if (row.feasibility_conclusion === '不可行') {
              await sysRollback();
              return res.status(400).json({ error: '评估为不可行，不能提交（请联系建单人处置）', code: 'FEASIBILITY_NOT_FEASIBLE' });
            }
            if (!(row.feasibility_requirement_confirm || '').trim()) {
              await sysRollback();
              return res.status(400).json({ error: '评估不完整：需求理解确认未填', code: 'FEASIBILITY_INCOMPLETE' });
            }
            if (row.feasibility_conclusion === '有条件可行' && !(row.feasibility_risk || '').trim()) {
              await sysRollback();
              return res.status(400).json({ error: '有条件可行需填写风险与依赖', code: 'FEASIBILITY_RISK_REQUIRED' });
            }
          }
        }

        // §6.2 步骤3：双条件守卫转移（状态机字段 UPDATE 三件套：双条件 WHERE + changes 检查 + 失败阻断）
        targetDevStatus = parsed.mode === 'no_code' ? 'no_code' : 'code_submitted';
        const upd = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET dev_status = ?, resolved_at = datetime('now','localtime'), no_code_reason = ?
             WHERE id = ? AND dev_status = 'pending' AND removed_at IS NULL`,
          [targetDevStatus, parsed.mode === 'no_code' ? parsed.noCodeReason : null, memberRow.id]
        );
        if (!upd || upd.changes !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '已提交过或状态已变', code: 'INVALID_STATUS' });
        }

        // §6.2 步骤4：mode=commits → INSERT 行（trim 已入库；自然键查重：同实例+component+ref 重复→400）
        const insertedCommits = [];
        if (parsed.mode === 'commits') {
          for (const c of parsed.commits) {
            const dup = await dbGetAsync(
              `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ?`,
              [memberRow.id, c.component, c.commit_ref]
            );
            if (dup) throw new SysTransitionError(400, 'VALIDATION', `commit 已存在（自然键重复）：${c.component}`);
            const insRes = await dbRunAsync(
              `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
              [id, memberRow.id, actor.id, c.component, c.commit_ref]
            );
            insertedCommits.push({ commit_id: insRes.lastID, component: c.component, commit_ref: c.commit_ref });
          }
        }

        // §6.2 步骤5：写恰 1 条 submit|no_code 事件（payload 含全部初始 commit 明细，方案 §3 模型）
        //   → electRepresentative → 门禁：全完成态→主状态待验证（W-GATE 内，同事务，不变量 8）
        // P4：work_note（选填工作说明）落进本条 submit/no_code 事件的 payload_json——每个 dev 各自的 submit 事件行
        //   独立承载，多开发各自 work_note 不覆盖（方案 §4.3 H1：不落主表/不落可变 dev_assignees 行）。仅有值时加键。
        const eventPayload = parsed.mode === 'no_code'
          ? { mode: 'no_code', no_code_reason: parsed.noCodeReason, ...(parsed.workNote ? { work_note: parsed.workNote } : {}) }
          : { mode: 'commits', commits: insertedCommits, dev_assignee_id: memberRow.id, ...(parsed.workNote ? { work_note: parsed.workNote } : {}) };
        await insertDevEvent({
          issueId: id, devAssigneeId: memberRow.id,
          action: parsed.mode === 'no_code' ? 'no_code' : 'submit',
          operatorId: actor.id, payload: eventPayload,
        });

        await electRepresentative(id);
        gateResult = await runWGate(id, row.type, row.status, actor);

        // [codex 101 号 MED 回填] updated_at——旧版单人 submit 经 sysIssueTransition 共用 UPDATE 必刷
        // updated_at（无论主状态是否随之改变）；新版 submit 主体写在 sys_issue_dev_assignees（无 updated_at
        // 列），仅当 runWGate 恰好推进主状态时才顺带刷新 sys_issues.updated_at——未推进时（多数 submit，
        // 尚有其他在册成员未完成）issue 行本身完全不被触碰，SSOT 未明确废除"submit 成功即刷 issue
        // updated_at"这条旧不变量，补回：submit 成功后无条件刷一次（幂等，即便 runWGate 已刷过也仅是
        // 同值再刷一次时间戳，无副作用）。范围严格限定此三处（另两处=/assign、runWGate 状态转移），不动
        // electRepresentative 通用选举 UPDATE（94 号 L1 裁定仍有效）。
        await dbRunAsync(`UPDATE sys_issues SET updated_at = datetime('now','localtime') WHERE id = ?`, [id]);

        // [codex C3 对抗审 L-P5 回填] 在册读移入 COMMIT 前——同 /assign 端点既有惯例（同事务快照读，
        // 防"COMMIT 后、响应组装前"窗口期与并发 add/remove 竞态读到不一致 roster；纯响应体收敛，
        // 无业务行为变化）。
        devAssignees = await fetchActiveDevAssignees(id);

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({
        id, dev_status: targetDevStatus, dev_assignee_id: memberRow.id,
        // main_status 恒填充（同 C2 add/reassign 端点既有惯例，非条件性 undefined）：W-GATE 未触发时=原状态。
        main_status: gateResult.changed ? gateResult.to : rowStatusAtStart,
        dev_assignees: devAssignees,
      });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ============================================================
  // 二·八、C4（多开发协作与 commit 留痕重构 v2.9）：commit 行编辑三端点（补充/改/删）
  //   SSOT = 方案 v2.9 §6.3（四守卫+固定事务序）+ §3 events 规格（commit 事件载荷）+ §10 API 契约 +
  //   §13 验收 S17/S18/S19/S27/S29/S30/S33/S38。commit 行写⇒业务行+事件同一事务（不变量8"不触发 W-GATE"，
  //   与成员写/完成态写的 W-GATE 全套区分——本节三端点不调用 electRepresentative/runWGate，主状态/代表均不
  //   受影响，仅 sys_issue_dev_commits + sys_issue_dev_events 两表变化）。
  //
  //   四守卫（§6.3 逐字，本节三端点共用同一套判定顺序 ①②③④，"锁定校验：四守卫全套"在事务内、任何写操作之前）：
  //   ① actor 当前在册（路由 issue 下存在未移除实例，历史参与者→403 COMMIT_SCOPE）——复用 assertDevMember，
  //      code 覆盖为 COMMIT_SCOPE（**契约裁定点①**：不复用其默认 NOT_ROSTERED——§10 API 契约表本三端点错误码
  //      集合内无 NOT_ROSTERED，仅列 COMMIT_SCOPE）。POST 场景下本次查询结果即"actor 当前在册实例"，同时供
  //      守卫④使用（无需重复查询）。
  //   ② 目标行 dev_user_id=actor.id（本人在册时可编辑名下所有行，含已 removed 旧实例行）∧ 行 issue_id=路由
  //      issue_id——PUT/DELETE 专属（POST 无目标行，创建新行）。不存在/跨 issue/非本人三种情形统一 403
  //      COMMIT_SCOPE（不单独判 404——S38③ 跨 issue 路由验收要求 403 而非 404，与"不泄露其他 issue 是否存在
  //      该 commit_id"的最小信息暴露原则一致）。
  //   ③ 主状态∈(SYS_DEV∪SYS_VERIFY)——复用 assertMemberActionFamilyAllowed（新增 actionKey='commit'，
  //      MEMBER_ACTION_FAMILY_MATRIX 追加一行），与既有 add/remove/excuse/supersede/reassign 五个成员动作同一
  //      409 INVALID_STATUS 语义收口（S17/S27"冻结态→409"实测依据；HTTP=409 是"主状态族级门禁"颗粒度）。
  //   ④ POST 专属：新行只挂 actor 当前在册实例（守卫①已定位）且该实例 dev_status='code_submitted'——不满足
  //      →400 INVALID_STATUS（**契约裁定点②**：与既有 excuse 端点"目标须 pending 才能开脱"同款"单行实例级
  //      前置条件不满足"语义对齐用 400，区别于守卫③"主状态族级门禁"用 409——两种不同颗粒度的状态校验不共享
  //      同一 HTTP 语义，同 excuse 端点先例）。S38①②两个负例即命中本守卫。
  //      DELETE 专属：删后所属实例（若 dev_status='code_submitted'）commit 行剩余需≥1，否则 400 GATE_INVARIANT
  //      （§10 HTTP 二分："请求破坏门禁不变量→400"，S18 依据；per-invariant P2/P4/P5 保证非 code_submitted 实例
  //      本就 commit 行=0，故本判定天然只在 code_submitted 实例上触发，仍显式判 dev_status 做纵深防御非纯计数）。
  // ============================================================

  // POST/PUT 共用字段校验（§6.3"字段校验同 §6.1 子集"）：component 枚举 + commit_ref trim 1..200；
  //   多余字段/null → 400（COMMIT_COMPONENTS.includes(null/undefined) 天然 false、typeof null !== 'string' 天然
  //   拒绝，无需再显式 null 特判）；镜像 validateSubmitBody 内 commits 元素校验但独立成 body 顶层校验（POST/PUT
  //   body 顶层即 {component, commit_ref}，非 submit 的 {mode, commits:[...]} 信封）。
  function validateCommitFieldsBody(body) {
    const b = body || {};
    const ALLOWED_KEYS = ['component', 'commit_ref'];
    const extra = Object.keys(b).filter(k => !ALLOWED_KEYS.includes(k));
    if (extra.length > 0) return { ok: false, message: `不支持的字段：${extra.join(',')}` };
    if (!COMMIT_COMPONENTS.includes(b.component)) return { ok: false, message: 'component 仅支持 frontend/backend' };
    if (typeof b.commit_ref !== 'string') return { ok: false, message: 'commit_ref 须为字符串' };
    const ref = b.commit_ref.trim();
    if (!ref || ref.length > 200) return { ok: false, message: 'commit_ref 必填（trim 长度 1..200）' };
    return { ok: true, component: b.component, commit_ref: ref };
  }

  // ── POST /sys-issues/:id/dev/commits：补充行（仅当前在册实例，§6.3④ POST 限定）──────────
  router.post('/sys-issues/:id/dev/commits', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const parsed = validateCommitFieldsBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message, code: 'VALIDATION' });

    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      let insertedCommit;
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);

        // 守卫①：actor 当前在册（COMMIT_SCOPE，非默认 NOT_ROSTERED——契约裁定点①）；同时取得 POST 所需的
        //   "actor 当前在册实例"（守卫④复用，无需重复查询）。
        const activeRow = await assertDevMember(id, actor.id, { code: 'COMMIT_SCOPE', message: '仅当前在册开发可提交 commit 行' });
        // 守卫③：主状态∈(SYS_DEV∪SYS_VERIFY)
        assertMemberActionFamilyAllowed('commit', row.type, row.status);
        // 守卫④（POST 专属）：只挂 actor 当前在册实例且该实例 dev_status='code_submitted'（契约裁定点②：400 INVALID_STATUS）
        if (activeRow.dev_status !== 'code_submitted') {
          await sysRollback();
          return res.status(400).json({ error: '当前在册实例非 code_submitted，不能补充 commit 行', code: 'INVALID_STATUS' });
        }

        // 字段校验后置查重：同 dev_assignee_id+component+trim(ref) 已存在→400（§6.3 步骤2）
        const dup = await dbGetAsync(
          `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ?`,
          [activeRow.id, parsed.component, parsed.commit_ref]
        );
        if (dup) { await sysRollback(); return res.status(400).json({ error: `commit 已存在（自然键重复）：${parsed.component}`, code: 'VALIDATION' }); }

        const insRes = await dbRunAsync(
          `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
          [id, activeRow.id, actor.id, parsed.component, parsed.commit_ref]
        );
        insertedCommit = {
          id: insRes.lastID, issue_id: id, dev_assignee_id: activeRow.id, dev_user_id: actor.id,
          component: parsed.component, commit_ref: parsed.commit_ref,
        };

        // 守卫全套通过 + 行已写 → INSERT event（add-commit，载荷按 §3：{commit_id,component,commit_ref,dev_assignee_id}）
        await insertDevEvent({
          issueId: id, devAssigneeId: activeRow.id, action: 'add-commit', operatorId: actor.id,
          payload: { commit_id: insertedCommit.id, component: parsed.component, commit_ref: parsed.commit_ref, dev_assignee_id: activeRow.id },
        });

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id: insertedCommit.id, commit: insertedCommit });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── PUT /sys-issues/:id/dev/commits/:commitId：改 component/commit_ref（须当前在册，§6.3）──────────
  router.put('/sys-issues/:id/dev/commits/:commitId', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const commitId = parsePositiveId(req.params.commitId);
    if (!id || !commitId) return res.status(400).json({ error: '无效的参数', code: 'VALIDATION' });
    const parsed = validateCommitFieldsBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.message, code: 'VALIDATION' });

    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      let updatedCommit;
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);

        // 守卫①：actor 当前在册（COMMIT_SCOPE）——只判"是否在册"，不要求目标行属于本次查到的这一实例
        // （守卫②另判目标行归属，允许本人在册时编辑名下所有行含已 removed 旧实例行，§6.3②）。
        await assertDevMember(id, actor.id, { code: 'COMMIT_SCOPE', message: '仅当前在册开发可编辑 commit 行' });

        // 守卫②：目标行 dev_user_id=actor.id ∧ issue_id=路由 issue_id；不存在/跨 issue/非本人 → 403 COMMIT_SCOPE（S38③）
        const target = await dbGetAsync(
          `SELECT id, issue_id, dev_assignee_id, dev_user_id, component, commit_ref FROM sys_issue_dev_commits WHERE id = ?`,
          [commitId]
        );
        if (!target || target.issue_id !== id || Number(target.dev_user_id) !== Number(actor.id)) {
          await sysRollback();
          return res.status(403).json({ error: '仅本人 commit 行可编辑', code: 'COMMIT_SCOPE' });
        }

        // 守卫③：主状态∈(SYS_DEV∪SYS_VERIFY)
        assertMemberActionFamilyAllowed('commit', row.type, row.status);

        // 无变化 PUT（规范化后与自身相同）→400 VALIDATION，不写 updated_at/event（§6.3 步骤2）
        if (target.component === parsed.component && target.commit_ref === parsed.commit_ref) {
          await sysRollback();
          return res.status(400).json({ error: '与当前值相同，无实际变化', code: 'VALIDATION' });
        }

        // 查重：同 dev_assignee_id+component+trim(ref) 已存在→400（排除当前 commit_id）
        const dup = await dbGetAsync(
          `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ? AND id != ?`,
          [target.dev_assignee_id, parsed.component, parsed.commit_ref, commitId]
        );
        if (dup) { await sysRollback(); return res.status(400).json({ error: `commit 已存在（自然键重复）：${parsed.component}`, code: 'VALIDATION' }); }

        await dbRunAsync(
          `UPDATE sys_issue_dev_commits SET component = ?, commit_ref = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
          [parsed.component, parsed.commit_ref, commitId]
        );
        updatedCommit = {
          id: commitId, issue_id: id, dev_assignee_id: target.dev_assignee_id, dev_user_id: target.dev_user_id,
          component: parsed.component, commit_ref: parsed.commit_ref,
        };

        // INSERT event（edit-commit，载荷按 §3：{commit_id,old:{component,commit_ref},new:{component,commit_ref}}）
        await insertDevEvent({
          issueId: id, devAssigneeId: target.dev_assignee_id, action: 'edit-commit', operatorId: actor.id,
          payload: {
            commit_id: commitId,
            old: { component: target.component, commit_ref: target.commit_ref },
            new: { component: parsed.component, commit_ref: parsed.commit_ref },
          },
        });

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id: commitId, commit: updatedCommit });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── DELETE /sys-issues/:id/dev/commits/:commitId：删（须当前在册；剩余≥1；reason，§6.3）──────────
  //   reason 经 body 传（DELETE 请求体，同 dev-assignees/:assigneeId 既有范式）。
  router.delete('/sys-issues/:id/dev/commits/:commitId', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const commitId = parsePositiveId(req.params.commitId);
    if (!id || !commitId) return res.status(400).json({ error: '无效的参数', code: 'VALIDATION' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: 'reason 必填（trim 1..200，经 body 传）', code: 'VALIDATION' });

    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      let deletedCommit;
      try {
        const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);

        // 守卫①
        await assertDevMember(id, actor.id, { code: 'COMMIT_SCOPE', message: '仅当前在册开发可删除 commit 行' });

        // 守卫②
        const target = await dbGetAsync(
          `SELECT id, issue_id, dev_assignee_id, dev_user_id, component, commit_ref FROM sys_issue_dev_commits WHERE id = ?`,
          [commitId]
        );
        if (!target || target.issue_id !== id || Number(target.dev_user_id) !== Number(actor.id)) {
          await sysRollback();
          return res.status(403).json({ error: '仅本人 commit 行可删除', code: 'COMMIT_SCOPE' });
        }

        // 守卫③
        assertMemberActionFamilyAllowed('commit', row.type, row.status);

        // 守卫④（DELETE 专属）：删后所属实例若 code_submitted 剩余需≥1，否则 400 GATE_INVARIANT（S18）
        const ownerInstance = await dbGetAsync('SELECT id, dev_status FROM sys_issue_dev_assignees WHERE id = ?', [target.dev_assignee_id]);
        if (ownerInstance && ownerInstance.dev_status === 'code_submitted') {
          const remain = await dbGetAsync(
            `SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND id != ?`,
            [target.dev_assignee_id, commitId]
          );
          if (Number(remain.c) === 0) {
            await sysRollback();
            return res.status(400).json({ error: '删除后该实例将无任何 commit 行（code_submitted 须保留≥1）', code: 'GATE_INVARIANT' });
          }
        }

        await dbRunAsync(`DELETE FROM sys_issue_dev_commits WHERE id = ?`, [commitId]);
        deletedCommit = {
          id: commitId, issue_id: id, dev_assignee_id: target.dev_assignee_id, dev_user_id: target.dev_user_id,
          component: target.component, commit_ref: target.commit_ref,
        };

        // INSERT event（delete-commit，reason 必填；载荷按 §3：{commit_id,component,commit_ref,dev_assignee_id}）
        await insertDevEvent({
          issueId: id, devAssigneeId: target.dev_assignee_id, action: 'delete-commit', reason, operatorId: actor.id,
          payload: { commit_id: commitId, component: target.component, commit_ref: target.commit_ref, dev_assignee_id: target.dev_assignee_id },
        });

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id: commitId, deleted: true });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // admin 动作
  router.post('/sys-issues/:id/accept', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('accept'));
  router.post('/sys-issues/:id/return', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('return'));
  router.post('/sys-issues/:id/close', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('close'));
  router.post('/sys-issues/:id/hold', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('hold'));
  router.post('/sys-issues/:id/reactivate', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reactivate'));
  router.post('/sys-issues/:id/issue-reject', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('issue_reject'));
  router.post('/sys-issues/:id/void', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('void'));
  router.post('/sys-issues/:id/reopen', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reopen'));

  // ── 受理门三出口（受理排期改造 §5.1·C3）──────────────────────────────────────
  //   ⚠️ 权限分两档（§5.3 逐动作授权表）：
  //     · intake_accept / intake_return → requireIntakeLiaison 中间件粗筛（admin ∨ SYS_INTAKE_LIAISON_IDS）
  //       + 引擎 [3] roleGuard='intake_liaison' 精判（写读同源·中间件是粗筛非权威）。
  //     · resubmit_intake → **不挂 requireIntakeLiaison**（授权=created_by∨admin·受理人不获重提他人单权）：
  //       只挂 authenticateToken+readiness，授权由引擎 [3] roleGuard='creator_or_admin' 按事务内锁定的 row.created_by 精判。
  //   三者均改 status（走 sysIssueTransition 唯一落点）·双条件 WHERE + changes≠1→409 竞态守卫由引擎统一提供。
  //   intake_accept：待受理→待指派(变更流)/待处理(bug)·无 payload·无通知（§4.5 列表驱动）→ 复用 makeTransitionEndpoint。
  //   resubmit_intake：待修改→待受理·无 payload·无通知（§4.5）→ 复用 makeTransitionEndpoint（notifyAfterCommit=null·dispatch 早返回）。
  router.post('/sys-issues/:id/intake-accept', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, makeTransitionEndpoint('intake_accept'));
  router.post('/sys-issues/:id/resubmit-intake', authenticateToken, requireSysSchemaReady, makeTransitionEndpoint('resubmit_intake'));

  // intake_return：待受理→待修改·原因必填（引擎 switch case 校 reason 落 timeline.summary）·提交后自动通知建单人（§5.1②·非列表驱动）。
  //   通知走独立 handler（makeTransitionEndpoint 的 dispatchSysNotify marker 机制不含「退改通知建单人」·此处显式发）。
  //   通知全 best-effort：事务已提交·钉钉失败只记 recordSysCreatorNotify(failed)·不影响 200（对齐 dispatchSysNotify 范式）。
  //   self-guard：操作者==建单人时跳过发送（对齐 notify-creator 端点 SELF_NOTIFY_SKIPPED·给自己发退改无意义）。
  router.post('/sys-issues/:id/intake-return', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const actor = sysActor(req);
    try {
      const r = await sysIssueTransition(id, 'intake_return', null, actor, req.body || {});
      // 提交后自动通知建单人（best-effort·独立于事务成败·退改原因取 body.reason·引擎已校非空）。
      //   ⚠️ codex C3 常规审 HIGH-1：发送抛异常也须落 recordSysCreatorNotify(failed)——内层 try 把 throw 归一为 {ok:false}，
      //     再无条件落库·杜绝「注释称失败记 failed 但抛异常路径停在 not_sent」的审计不一致（sendIssueDingtalkRaw 已知失败多返 {ok:false}·
      //     此处兜住极端 throw：sendIssueMarkdown 未包 try 的路径）。creator/issue 缺失记 warn（MED-2 可观测·不加 skipped 状态列·本期不做通知代际）。
      try {
        const issue = await dbGetAsync('SELECT id, type, title, system_name, created_by FROM sys_issues WHERE id = ?', [id]);
        if (!issue) {
          logger.warn(`[系统迭代] 退改通知：issue ${id} 提交后查不到，跳过通知`);
        } else if (Number(actor.id) === Number(issue.created_by)) {
          // self-guard：操作者==建单人·给自己发退改无意义（对齐 notify-creator SELF_NOTIFY_SKIPPED），不发不记。
        } else {
          const creator = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.created_by]);
          if (!creator) {
            logger.warn(`[系统迭代] 退改通知：建单人 user 缺失（issue ${id} created_by=${issue.created_by}），跳过`);
          } else {
            // ⚠️ codex C3 复审 HIGH 收口：把「准备(baseUrl/markdown)+发送」整体包进 try——任一环节抛异常都归一为 {ok:false}·
            //   record 放 try 外无条件落库·完整闭合「通知尝试失败必记 failed」（不再只按 sendIssueDingtalkRaw 单函数闭合·
            //   getSafePlatformBaseUrl/buildSysIntakeReturnCreatorMarkdown 抛异常也落 failed·不停在 not_sent）。
            let result;
            try {
              const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
              const baseUrl = await getSafePlatformBaseUrl();
              const { title, md } = buildSysIntakeReturnCreatorMarkdown(issue, reason, baseUrl);
              result = await sendIssueDingtalkRaw(creator, title, md);
            } catch (prepOrSendErr) {
              result = { ok: false, reason: (prepOrSendErr && prepOrSendErr.message) || 'notify_exception' };
            }
            // record 在 try 外：通知尝试无论准备/发送哪步失败都落 failed（record 自身 DB 写失败无法自证·由外层 catch 记 warn）。
            await recordSysCreatorNotify(id, !!(result && result.ok), result && result.message_key, result && result.reason);
          }
        }
      } catch (notifyErr) { logger.warn('[系统迭代] 退改通知建单人失败（不影响流转）:', notifyErr && notifyErr.message); }
      res.json({ id, status: r.toStatus, action: 'intake_return' });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── edit_in_revision：待修改态编辑内容（受理排期改造 §5.2·C4）──────────────────────
  //   旁路动作（transitions.js to=null·不改 status·类比 estimate 独立事务）：待修改态白名单字段编辑。
  //   ⚠️ **不挂 requireIntakeLiaison**（授权=created_by∨admin·§5.3·受理人不获编辑他人单权）：只挂 auth+readiness·handler 内按事务内 row.created_by 精判。
  //   字段白名单（§5.2）——禁 status/intake_required/type/tech_lead_*/created_by（服务端字段禁客户端写·未知字段 400）。
  //   审计（§5.2 codex M 消歧）：event_type=note + action_code=edit_in_revision（priority 改动也走此码·不单列 priority_change）·改动字段名列入 summary（timeline 无 payload_json 列·不为审计明文差异做 schema 迁移·codex C4 LOW-6：不落前后值）。
  const EDIT_IN_REVISION_FIELDS = ['title', 'description', 'system_name', 'module_name', 'priority', 'deadline', 'needs_feasibility', 'requester_dept', 'requester_name', 'requester_phone'];
  const EDIT_FIELD_LABELS = { title: '标题', description: '描述', system_name: '所属系统', module_name: '模块', priority: '优先级', deadline: '预期完成', needs_feasibility: '需可行性评估', requester_dept: '需求方部门', requester_name: '需求方姓名', requester_phone: '需求方电话' };
  router.post('/sys-issues/:id/edit-in-revision', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    // 未知字段拒绝（防客户端写服务端字段·§5.2 白名单外一律拒）
    const extra = Object.keys(b).filter(k => !EDIT_IN_REVISION_FIELDS.includes(k));
    if (extra.length) return res.status(400).json({ error: `不支持编辑的字段：${extra.join(',')}`, code: 'EDIT_FIELD_NOT_ALLOWED' });
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync(
          `SELECT id, type, status, created_by, title, description, system_name, module_name, priority, deadline,
                  needs_feasibility, requester_dept, requester_name, requester_phone
             FROM sys_issues WHERE id = ?`, [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // 权限：created_by∨admin（§5.3·事务内锁定后 row.created_by 校验·防 TOCTOU）
        const isAdmin = actor.role === 'admin';
        const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
        if (!(isAdmin || isCreator)) { await sysRollback(); return res.status(403).json({ error: '仅建单人或管理员可编辑', code: 'NOT_AUTHORIZED_FOR_EDIT' }); }
        // 仅待修改态可编辑（§5.2·乐观锁 WHERE status='待修改' 兜 TOCTOU）
        if (row.status !== '待修改') { await sysRollback(); return res.status(409).json({ error: `仅「待修改」态可编辑内容（当前「${row.status}」）`, code: 'EDIT_STATUS_INVALID' }); }
        // 逐字段校验（复用建单口径）+ 计算改动集（幂等：值未变不列入）
        const setFrags = [], setParams = [], changed = [];
        for (const f of EDIT_IN_REVISION_FIELDS) {
          if (!(f in b)) continue;   // 未传字段不动
          let val;
          if (f === 'title') {
            val = (typeof b.title === 'string' ? b.title.trim() : '');
            if (!val) { await sysRollback(); return res.status(400).json({ error: '标题必填', code: 'TITLE_REQUIRED' }); }
          } else if (f === 'system_name') {
            val = (typeof b.system_name === 'string' ? b.system_name.trim() : '');
            if (!T.BIZ_SYSTEMS.includes(val)) { await sysRollback(); return res.status(400).json({ error: '所属系统非法', code: 'INVALID_SYSTEM_NAME' }); }
          } else if (f === 'priority') {
            if (!['P0', 'P1', 'P2', 'P3'].includes(b.priority)) { await sysRollback(); return res.status(400).json({ error: '优先级非法（P0-P3）', code: 'INVALID_PRIORITY' }); }
            val = b.priority;
          } else if (f === 'deadline') {
            const dl = normalizeDeadline(b.deadline);
            if (!dl.ok) { await sysRollback(); return res.status(400).json({ error: '预期完成日期格式非法（YYYY-MM-DD 真实日期）', code: 'INVALID_DEADLINE' }); }
            val = dl.value;   // 规范化串或 null
          } else if (f === 'needs_feasibility') {
            // 0/1 + type guard（同建单：仅 feature/improvement 可设 1·L-2 输入收窄）
            const raw = b.needs_feasibility;
            if ([1, '1', true].includes(raw)) {
              if (!['feature', 'improvement'].includes(row.type)) { await sysRollback(); return res.status(400).json({ error: '仅变更类（feature/improvement）可要求可行性评估', code: 'FEASIBILITY_NOT_APPLICABLE' }); }
              val = 1;
            } else if ([undefined, null, 0, '0', false, ''].includes(raw)) {
              val = 0;
            } else { await sysRollback(); return res.status(400).json({ error: 'needs_feasibility 仅接受 0/1', code: 'INVALID_NEEDS_FEASIBILITY' }); }
          } else {
            // description/module_name/requester_dept/requester_name/requester_phone：自由文本。
            //   ⚠️ codex C4 MED-2：只接受 string 或 null——非字符串非 null（对象/数组/数字）显式 400，
            //     不静默转 null（否则客户端类型错误会被当"清空"执行·造成数据丢失）。string trim 后空串归 null（统一）。
            const rawv = b[f];
            if (rawv !== null && typeof rawv !== 'string') {
              await sysRollback();
              return res.status(400).json({ error: `${EDIT_FIELD_LABELS[f]} 须为字符串或 null`, code: 'INVALID_EDIT_FIELD_TYPE' });
            }
            val = (typeof rawv === 'string') ? (rawv.trim() || null) : null;
          }
          // 幂等对比（codex C4 MED-3：按字段归一后**严格 ===**·不用 String() 强转·区分 DB null 与文本 "null"）：
          //   needs_feasibility 归 int 比；title/system_name/priority 是非空串直接比；deadline/自由文本 归 null-or-string 比。
          let normOld, normNew;
          if (f === 'needs_feasibility') { normOld = Number(row[f]) === 1 ? 1 : 0; normNew = val; }
          else { normOld = (row[f] === '' || row[f] == null) ? null : row[f]; normNew = (val === '' || val === undefined) ? null : val; }
          if (normOld === normNew) continue;   // 严格相等·未变（幂等零写入）
          setFrags.push(`${f} = ?`);
          setParams.push(val);
          changed.push(f);
        }
        if (!changed.length) {
          // 无有效改动 → 幂等零写入（不 UPDATE 不留 timeline·同 estimate unchanged 范式）
          await sysRollback();
          return res.json({ id, unchanged: true });
        }
        // 旁路 UPDATE（不改 status）+ 乐观锁绑 status='待修改'（防 TOCTOU：编辑期间状态被 resubmit/change_intake_mode 改走）
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET ${setFrags.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ? AND status = '待修改'`,
          [...setParams, id]);
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_EDIT' }); }
        // note timeline + action_code=edit_in_revision（改动字段名列入 summary·结构化审计够用）。
        //   ⚠️ sys_issue_timeline 无 payload_json 列（该列在 sys_issue_dev_events）——改动快照落 summary 文本·
        //     不为审计明文差异做 schema 迁移（超 C4 范围·字段名列表已满足「哪些字段改了」审计需求）。
        const changedLabels = changed.map(f => EDIT_FIELD_LABELS[f] || f);
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'edit_in_revision', ?, ?)`,
          [id, `编辑待修改内容（${changedLabels.join('、')}）`,
           Number(actor.id) || null, actor.name || null]);
        await sysCommit();
        return res.json({ id, changed, action: 'edit_in_revision' });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // SYS_BUSY 等保 503（业务错误·安全文案）
      // codex C4 MED-4：未识别异常不回传 err.message（防泄露 SQLite 错误/约束名/内部实现）·日志留全供排查·客户端仅通用文案+稳定码。
      logger.error('[系统迭代] 编辑待修改内容失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '编辑失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── change_intake_mode：切换受理模式（受理排期改造 §5.4·C4）──────────────────────
  //   admin 专用（requireAdmin）·原因必填·同事务翻转 intake_required + status（§5.4 真值表·含变更流+bug）。
  //   自持事务（非 sysIssueTransition）：真值表含幂等零写入 / 409 INTAKE_MODE_LOCKED / 后段 409·不适配通用引擎「恒转换」语义。
  //   条件 UPDATE 含 id + type + status + **旧 intake_required**（§5.4 防竞态：并发切换只有一个命中·另一个 changes≠1→409）。
  //   ⚠️ change_intake_mode **不入 T.INTAKE_GATE_ACTIONS**（它是翻转 intake_required 的动作·若要求 intake_required=1 会自锁开受理门路径）。
  //   ⭐ 角色权限重构 C0（方案 v1.5 §4-C0/§14）：**下线——后端一律拒绝；新页面已隐藏入口，本路由只服务旧缓存页面**。
  //     受理门已焊死为"全类型必经"（intake_required 恒 1·三创建入口同源），"切换受理模式"这一动作在新模型下
  //     语义消失（关掉它等于开一条绕过受理的后门，正是本次要堵的缺口）。
  //     ⚠️ 分两步而非一次删净（§14 发布顺序·codex 三轮审 MED-3 修正表述）：
  //       · 本 commit：**前端按钮无条件隐藏**（新页面不再出现必然失败的死按钮）+ 后端保留路由返 409；
  //         保留路由是为了让**已加载的旧页面/缓存客户端**点到时得到明确业务提示，而不是 404/白屏。
  //       · 阶段2（同发布批次）：连同本路由、前端 siModalChangeIntakeMode 函数、meta 动作条目一并删除。
  //     ⚠️ 拒绝范式照抄本模块既有端点退场先例（confirm-online-norelease `:4191` / set-release-flag）：
  //       **409 + 专属 code + 指向新流程的文案**，不用 410（本项目未采用该语义，保持一致）。
  //     ⚠️ 置于所有参数校验**之前**：下线是端点级结论，与入参是否合法无关；先校验会让调用方收到误导性的 400
  //       （像是"参数写对了就能用"）。verify-sys-intake-schedule-c4.js 的既有用例随本 commit 同步改期望值。
  router.post('/sys-issues/:id/change-intake-mode', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    return res.status(409).json({
      error: '受理门已固化：全部迭代单必经对接人受理，「切换受理模式」功能已下线',
      code: 'INTAKE_MODE_SWITCH_DISABLED',
    });
    // ⚠️ 阶段2（同发布批次·§14）：连同本路由一并删除，并移除前端 siModalChangeIntakeMode 入口。
    //   实现体已在本 commit 删除（codex C0 审 MED-1）——保留不可达代码既拿不到"删一行 return 就回滚"的能力
    //   （建单/derive/reactivate/前端契约不会跟着回来），又会随表结构演进无声腐化。回滚以整个 commit 为单位。
  });

  // ── request_tech_consult：发起技术负责人沟通（受理排期改造 §6·C5）──────────────────────
  //   旁路动作（transitions.js to=null·不改 status·类比 edit_in_revision 自持事务·**不入 T.INTAKE_GATE_ACTIONS**·由 status='待受理' 门隐含受理态）。
  //   挂 requireIntakeLiaison（admin∨受理人·§5.3）。选技术负责人（tech_lead_id∈SYS_TECH_LEAD_IDS·服务端校验+派生 name·禁客户端提交 name）。
  //   请求版本 + 结果归属（§6·codex 128-M/130-H）：每次 request（含同人连发）生成新 timeline 事件（=request_event_id）+ 重置全部投递字段
  //     （notify_status→not_sent·清 message_key/read_at/error/notified_at/sent_by）。提交后自动首发（best-effort·条件 request_event_id 落库）。
  router.post('/sys-issues/:id/request-tech-consult', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const techLeadId = parsePositiveId((req.body || {}).tech_lead_id);
    if (!techLeadId) return res.status(400).json({ error: '请选择技术负责人', code: 'TECH_LEAD_ID_REQUIRED' });
    if (!isSysTechLead(techLeadId)) return res.status(400).json({ error: '技术负责人须为白名单成员', code: 'TECH_LEAD_NOT_WHITELISTED' });
    const actor = sysActor(req);
    let requestEventId = null, techLeadUser = null, issueSnap = null, techLeadName = null;
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, title, system_name FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // 仅待受理态可发起（§5.1③·受理态结构上 intake_required=1·status 门隐含·同 edit_in_revision 范式）
        if (row.status !== '待受理') { await sysRollback(); return res.status(409).json({ error: `仅「待受理」态可发起技术负责人沟通（当前「${row.status}」）`, code: 'REQUEST_TECH_CONSULT_STATUS_INVALID' }); }
        // tech_lead_name 服务端派生（禁客户端提交·§6）
        const tl = await dbGetAsync('SELECT id, display_name, username, phone, dingtalk_user_id FROM users WHERE id = ?', [techLeadId]);
        if (!tl) { await sysRollback(); return res.status(409).json({ error: '技术负责人用户不存在', code: 'TECH_LEAD_NOT_FOUND' }); }
        techLeadName = tl.display_name || tl.username || `user#${tl.id}`;
        // note timeline（tech_lead 快照入 summary·timeline 无 payload_json 列）→ lastID = request_event_id（结果归属锚点）
        const tlIns = await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'request_tech_consult', ?, ?)`,
          [id, `发起技术负责人沟通：${techLeadName}(id${techLeadId})`, Number(actor.id) || null, actor.name || null]);
        requestEventId = tlIns.lastID;
        // 每次 request（含同人连发·非仅换人·§6·130-H）生成新版本 + 重置全部投递字段（含 sent_by 清空·§8.3 not_sent⟹sent_by 空）
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET tech_lead_id=?, tech_lead_name=?, tech_lead_notify_request_event_id=?,
                  tech_lead_notify_status='not_sent', tech_lead_notify_message_key=NULL, tech_lead_read_at=NULL,
                  tech_lead_notify_error=NULL, tech_lead_notified_at=NULL, tech_lead_notify_sent_by=NULL,
                  updated_at=datetime('now','localtime')
             WHERE id=? AND status='待受理'`,
          [techLeadId, techLeadName, requestEventId, id]);
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' }); }
        await sysCommit();
        techLeadUser = tl; issueSnap = row;
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // === 提交后：request 已成功落库（timeline+负责人+版本重置持久化）。以下首发+回写全 best-effort ===
      //   codex C5 HIGH-2：提交后任何异常（record 抛/DB 抖）不把「已提交的 request」伪装成 500 整体失败——否则诱导客户端重试→生成新版本+重复通知。
      //   codex C5 HIGH-1：不做无条件 fresh 查询（并发新 request 会让 fresh 反映新版本而响应带旧 request_event_id=混版）——
      //     用**本次 sendResult + record 的 changes** 派生响应状态：changes=1 用本次结果·changes=0 标 superseded（本次被并发新 request 取代）。
      let notifyStatus = 'unknown', superseded = false;
      try {
        let sendResult;
        try {
          const baseUrl = await getSafePlatformBaseUrl();
          const { title, md } = buildSysTechLeadMarkdown({ id, title: issueSnap.title, system_name: issueSnap.system_name }, baseUrl);
          sendResult = await sendIssueDingtalkRaw(techLeadUser, title, md);
        } catch (prepOrSendErr) {
          sendResult = { ok: false, reason: 'notify_exception' };   // codex C5 MED-6：不用 raw message（防泄露 infra 细节）
        }
        const rec = await recordSysTechLeadNotify(id, requestEventId, !!(sendResult && sendResult.ok), sendResult && sendResult.message_key, sendResult && sendResult.reason, actor.id);
        // 派生须与 record 内部降级口径一致（ok 但无 message_key→failed·HIGH-3）·否则响应与库不符
        if (rec && rec.changes === 1) notifyStatus = (sendResult && sendResult.ok && sendResult.message_key) ? 'sent' : 'failed';
        else superseded = true;   // changes=0：期间又 request→本次回写作废·响应标 superseded（不混版）
      } catch (notifyErr) {
        logger.warn('[系统迭代] 技术负责人首发回写失败（request 已提交·不影响）:', notifyErr && notifyErr.message);
        notifyStatus = 'unknown';   // request 成功·投递结果未知（客户端可重发·非重发 request）
      }
      return res.json({ id, tech_lead_id: techLeadId, tech_lead_name: techLeadName, request_event_id: requestEventId, tech_lead_notify_status: notifyStatus, ...(superseded ? { superseded: true } : {}) });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 发起技术负责人沟通失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '发起技术负责人沟通失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── resend-tech-consult：重发技术负责人通知（受理排期改造 §6·C5）──────────────────────
  //   权限=admin∨SYS_INTAKE_LIAISON_IDS∨created_by（§6 统一三方·含 admin 代办）·端点内加载 issue 后精判（不挂角色中间件·因含 created_by）。
  //   携带 expected_request_event_id·与当前 tech_lead_notify_request_event_id 不一致→409（防基于旧版本重发·期间又 request 换人/连发·§6）。
  //   双层守：expected 显式比对 + recordSysTechLeadNotify 条件 request_event_id 落库（并发期间 request_event_id 又变则 changes=0→409）。
  router.post('/sys-issues/:id/resend-tech-consult', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const expectedEventId = parsePositiveId((req.body || {}).expected_request_event_id);
    if (!expectedEventId) return res.status(400).json({ error: '缺少 expected_request_event_id', code: 'EXPECTED_REQUEST_EVENT_ID_REQUIRED' });
    const actor = sysActor(req);
    try {
      const row = await dbGetAsync('SELECT id, title, system_name, status, created_by, tech_lead_id, tech_lead_notify_request_event_id FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // 权限：admin∨受理人∨建单人（§6）
      const isAdmin = actor.role === 'admin';
      const isLiaison = isSysIntakeLiaison(actor.id);
      const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
      if (!(isAdmin || isLiaison || isCreator)) return res.status(403).json({ error: '仅管理员/受理人/建单人可重发', code: 'NOT_AUTHORIZED_FOR_TECH_CONSULT_RESEND' });
      // C10 末次审 #5（codex149）：重发仅限受理阶段——技术负责人沟通是「待受理」态动作（request 发起门=待受理·transitions §6），
      //   受理通过(intake_accept→待指派/待处理)/退改(→待修改)后单已离开待受理，旧受理请求不应继续向技术负责人发过期通知
      //   （intake_accept 不清 tech_lead 字段·仅由本状态门约束）。置于权限校验之后（避免非权限者借状态码侧信道探单据态·同 C3 不变量顺序）。
      if (row.status !== '待受理') return res.status(409).json({ error: '该单已离开受理阶段，不可重发技术负责人沟通', code: 'TECH_CONSULT_RESEND_LATE' });
      if (!row.tech_lead_id || !row.tech_lead_notify_request_event_id) return res.status(409).json({ error: '该单未发起技术负责人沟通，无可重发', code: 'NO_TECH_CONSULT_TO_RESEND' });
      // expected_request_event_id 一致性（防基于旧页面版本重发）
      if (Number(expectedEventId) !== Number(row.tech_lead_notify_request_event_id)) {
        return res.status(409).json({ error: '技术负责人沟通已更新（换人/重新发起），请刷新后重发', code: 'TECH_CONSULT_VERSION_CONFLICT' });
      }
      // codex C5 MED-5：发送前重校 isSysTechLead（白名单调整/脏数据/其他写路径污染时·不向非白名单发·recipient 契约·镜像 notify-relay isSysBugLiaison 复核）
      if (!isSysTechLead(row.tech_lead_id)) return res.status(409).json({ error: '技术负责人已不在白名单，请重新发起沟通选择当前成员', code: 'TECH_LEAD_NOT_WHITELISTED' });
      const tl = await dbGetAsync('SELECT id, display_name, username, phone, dingtalk_user_id FROM users WHERE id = ?', [row.tech_lead_id]);
      if (!tl) return res.status(409).json({ error: '技术负责人用户不存在', code: 'TECH_LEAD_NOT_FOUND' });
      // 重发（best-effort·整体包 try 归一 failed·codex MED-6 安全 reason）
      let sendResult;
      try {
        const baseUrl = await getSafePlatformBaseUrl();
        const { title, md } = buildSysTechLeadMarkdown(row, baseUrl);
        sendResult = await sendIssueDingtalkRaw(tl, title, md);
      } catch (prepOrSendErr) {
        sendResult = { ok: false, reason: 'notify_exception' };
      }
      // 条件 request_event_id 落库（并发期间又 request→request_event_id 变→changes=0→409·拒过期回写·§6 版本围栏写回）
      const rec = await recordSysTechLeadNotify(id, row.tech_lead_notify_request_event_id, !!(sendResult && sendResult.ok), sendResult && sendResult.message_key, sendResult && sendResult.reason, actor.id);
      if (!rec || rec.changes !== 1) return res.status(409).json({ error: '技术负责人沟通已更新，请刷新后重发', code: 'TECH_CONSULT_VERSION_CONFLICT' });
      // codex C5 HIGH-1：用本次 record 结果派生响应（changes=1 已确认本版本·不做无条件 fresh 查询·防混版）
      const notifyStatus = (sendResult && sendResult.ok && sendResult.message_key) ? 'sent' : 'failed';
      return res.json({ id, tech_lead_notify_status: notifyStatus, request_event_id: row.tech_lead_notify_request_event_id });
    } catch (err) {
      logger.error('[系统迭代] 重发技术负责人通知失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '重发技术负责人通知失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── set_scheduled_start：定计划开工日（受理排期改造 §7.2·C6）──────────────────────
  //   旁路自持事务（不改 status·类比 estimate）·admin·变更流「开发中」/bug「处理中」（dev 工作态·isDevWorkState）·参考字段非闸门。
  //   scheduled_start = YYYY-MM-DD（Asia/Shanghai 日历日·复用 normalizeDeadline 严格解析：拒日期时间/无效/溢出日期 2026-02-30）·
  //     可传 null/空清除（清除不要求 dev_estimated_at）。设值须 dev_estimated_at 非空（§7.2·开发回填预计 → admin 定开工日）。
  //   event_type=note·action_code=set_scheduled_start。⚠️ 报表不拿"进开发中时间"当实际开工（参考字段·软约束早于 estimate 仅前端警告）。
  router.post('/sys-issues/:id/set-scheduled-start', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    // codex C6 HIGH-1：字段必须显式提供——缺失（undefined）不当清除（否则空 body/无 body 会静默清除已有开工日·方案只授权显式 null/空清除）。
    if (!Object.prototype.hasOwnProperty.call(b, 'scheduled_start')) {
      return res.status(400).json({ error: '缺少 scheduled_start（清除请显式传 null）', code: 'SCHEDULED_START_REQUIRED' });
    }
    const raw = b.scheduled_start;
    // 显式 null / trim 后空串 → 清除；string → 严格 YYYY-MM-DD（复用 normalizeDeadline·拒日期时间/无效/溢出）；
    //   codex C6 MED-2：非 string 非 null（数组/对象/数字）显式 400——不经 normalizeDeadline 的 String(raw) 强转（防 ["2026-09-01"] 蒙混过关）。
    let val;
    if (raw === null) {
      val = null;
    } else if (typeof raw === 'string') {
      if (raw.trim() === '') { val = null; }
      else {
        const parsed = normalizeDeadline(raw);
        if (!parsed.ok || !parsed.value) return res.status(400).json({ error: '计划开工日格式非法（应为 YYYY-MM-DD 真实日期）', code: 'INVALID_SCHEDULED_START' });
        val = parsed.value;
      }
    } else {
      return res.status(400).json({ error: '计划开工日须为字符串或 null', code: 'INVALID_SCHEDULED_START' });
    }
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, dev_estimated_at, scheduled_start FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // from = dev 工作态（开发中/处理中·§7.2·isDevWorkState 单一判定）
        if (!T.isDevWorkState(row.type, row.status)) {
          await sysRollback();
          return res.status(409).json({ error: `当前状态「${row.status}」不可定计划开工日（仅开发中/处理中）`, code: 'SCHEDULED_START_STATUS_INVALID' });
        }
        // 设值须 dev_estimated_at 非空（§7.2）；清除（val=null）不要求
        if (val !== null && !row.dev_estimated_at) {
          await sysRollback();
          return res.status(409).json({ error: '请先回填预计完成时间，再定计划开工日', code: 'SCHEDULED_START_REQUIRES_ESTIMATE' });
        }
        // 幂等：同值零写入（含 null==null·同 estimate unchanged 范式）
        const curVal = row.scheduled_start == null ? null : row.scheduled_start;
        if (curVal === val) { await sysRollback(); return res.json({ id, scheduled_start: val, unchanged: true }); }
        // 旁路 UPDATE（不改 status）+ 乐观锁绑 status（防并发离开 dev 态）
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET scheduled_start = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?`,
          [val, id, row.status]);
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'set_scheduled_start', ?, ?)`,
          [id, val === null ? '清除计划开工日' : `定计划开工日：${val}`, Number(sysActor(req).id) || null, sysActor(req).name || null]);
        await sysCommit();
        return res.json({ id, scheduled_start: val, action: 'set_scheduled_start' });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 定计划开工日失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '定计划开工日失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── [R3 退场，v1.6 §2.3 C-1] POST /sys-issues/:id/confirm-online-norelease（已下线，仅 bug 流曾用）──────────
  //   findTransition('bug','confirm-online-norelease',...) 已随 transitions.js 移除该 meta 条目恒返 null——
  //   若仍走 makeTransitionEndpoint 会退化成通用 400 INVALID_TRANSITION（可用但不够清晰）。改自定义 handler
  //   显式先判 type='bug' 返 LEGACY_RELEASE_FLOW_DISABLED（409，友好文案指向新流程），非 bug 兜底走原
  //   sysIssueTransition（该 action 从未在任何 type 定义过，防御性保留、正常不可达）。
  router.post('/sys-issues/:id/confirm-online-norelease', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT id, type FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      if (row.type === 'bug') {
        return res.status(409).json({ error: '该功能已下线，bug 上线流程请改用「批量指定上线开发」+「执行上线」', code: 'LEGACY_RELEASE_FLOW_DISABLED' });
      }
      const r = await sysIssueTransition(id, 'confirm-online-norelease', null, sysActor(req), req.body || {});
      await dispatchSysNotify(id, r.notifyAfterCommit);
      res.json({ id, status: r.toStatus, action: 'confirm-online-norelease' });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── DELETE /sys-issues/:id：物理删除迭代单（admin 专用·不可逆·2026-07-07）──────────
  //   场景：admin 单人清理测试/脏单。物理删除（非 void 软删）——sys_issues 主表 + 三张子表全清 + 附件磁盘文件。
  //   ⚠️ 级联必须手动做：本库从未开 PRAGMA foreign_keys=ON（子表 FK ON DELETE CASCADE 仅自文档、运行不生效，
  //     见 sys_issue_timeline 建表注释），故显式 DELETE 每张子表，否则留孤儿（timeline / 附件行 / 协作开发通知行）。
  //   守边界（方案 a）：拒删「被别的单派生引用（origin）」或「已挂上线批次（release_id）」的单——防悬空引用 / 破坏
  //     批次成员一致性。真要删这类单说明有特殊情况，应单独处置，不让删除按钮默默替决策。
  //   通知数据落点：creator/requester/release_assignee 三侧通知快照在 sys_issues 主表列（删主行即清）；
  //     协作开发通知在 sys_issue_dev_assignees（删子表即清）——两处都在本级联范围内，零残留。
  router.delete('/sys-issues/:id', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      // 【codex 44 审 H-1/H-2 采纳】守卫读 + 附件清单读全部下沉到 sysBeginImmediate 之后：
      //   所有 sys 写路径（建单/派生/挂批次/传附件）都走同一模块级全局锁（见本文件 sysBeginImmediate 注释），
      //   持锁期间无写路径能插入，把「读到无派生/无批次 + 附件清单」与「删除」收进同一持锁窗口 → TOCTOU 窗口归零
      //   （否则读后删前可能被插入派生子单/挂 release_id → 悬空母单；或被传新附件 → 删库不删盘的孤儿文件）。
      let atts = [];
      let titleForLog = '';
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, title, release_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        titleForLog = row.title || '';
        // 守卫①：有派生子单（被引用为 origin）→ 删母单会让子单 origin_issue_id 悬空，拒删。
        const derived = await dbGetAsync('SELECT id FROM sys_issues WHERE origin_issue_id = ? LIMIT 1', [id]);
        if (derived) { await sysRollback(); return res.status(409).json({ error: '该单已派生出子单，不可删除（请先处理派生链）', code: 'SYS_ISSUE_HAS_DERIVED' }); }
        // 守卫②：已挂上线批次（release_id 非空）→ 删除会破坏批次成员一致性，拒删。
        if (row.release_id) { await sysRollback(); return res.status(409).json({ error: '该单已加入上线批次，不可删除', code: 'SYS_ISSUE_IN_RELEASE' }); }

        // 附件磁盘文件清单：持锁后读，与下方 DELETE 处于同一持锁窗口（防读后删前被传新附件 → 只删库不删盘）。
        atts = await dbAllAsync('SELECT file_name FROM sys_issue_attachments WHERE issue_id = ?', [id]);

        // 先删三张 issue_id 子表，再删主表（PRAGMA OFF 下顺序不影响 FK，但逻辑自洽）。
        await dbRunAsync('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id]);
        await dbRunAsync('DELETE FROM sys_issue_attachments WHERE issue_id = ?', [id]);
        await dbRunAsync('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id]);
        const del = await dbRunAsync('DELETE FROM sys_issues WHERE id = ?', [id]);
        if (!del || del.changes !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'SYS_ISSUE_DELETE_CONFLICT' });
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // COMMIT 成功后才物理删附件文件（DB 为准；文件删失败留 orphan，不影响已提交的 DB 删除，无幽灵行）。
      //   【codex 44 审 M-1 采纳·修法据实调整】safeDeleteFileSync 返回布尔且内部 try/catch 不抛异常（server.js:525），
      //     故 codex 原议「在 catch 里记 warn」抓不到——改为按返回值判定：返回 false（含"文件本就不存在"这类既有脏态
      //     与"删除受阻"）时记一条带 issue id 的 warn，给 admin 留人工核对线索（不改接口 200 语义）。
      let fileDelFailed = 0;
      for (const a of atts) {
        if (!safeDeleteFileSync(a.file_name, UPLOAD_DIR)) {
          fileDelFailed++;
          logger.warn(`[系统迭代] 物理删除 #${id} 附件文件未删除（可能已不存在或删除受阻，留待人工核对）：${a.file_name}`);
        }
      }
      logger.info(`用户 ${req.user.username} 物理删除迭代单 #${id}（${titleForLog}）+ ${atts.length} 个附件${fileDelFailed ? `（其中 ${fileDelFailed} 个文件未删除，见 warn）` : ''}`);
      return res.json({ ok: true, id });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // SYS_BUSY 等保 503
      logger.error('[系统迭代] 物理删除失败:', err && err.message);
      return res.status(500).json({ error: (err && err.message) || '删除失败' });
    }
  });

  // ── POST /sys-issues/:id/estimate：回填预计完成（在册开发，不改 status，旁路独立事务，§3.6/§7）──────────
  //   C3 交付物：W06 切换——闸门 dev_estimated_at 格式合法 + >=assigned_at 不变；权限从 ownerGuard（严格
  //   assigned_to 本人）改 assertDevMember（在册，方案 §5.1 ②层）+ SF.isW06Allowed（固化常量，替代
  //   T.findTransition 临时借用，见 status-families.js SYS_W06_ALLOWED_STATUS 头部注释核对现网 from）。
  //   去主次后任一在册开发均可填（W06 类动作对整单填一次，不分"谁是代表"，§0）。
  router.post('/sys-issues/:id/estimate', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const est = normalizeSysDatetime((req.body || {}).dev_estimated_at);
      if (!est) return res.status(400).json({ error: '预计完成时间格式非法（YYYY-MM-DD HH:MM）', code: 'INVALID_ESTIMATE' });
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_at, needs_feasibility, dev_estimated_at, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // estimate 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单，替代旧 T.findTransition 借用）
        if (!SF.isW06Allowed('estimate', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可回填预计`, code: 'ESTIMATE_STATUS_INVALID' });
        }
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        // estimate 封口（codex 17 M-6 / 开放②）：needs_feasibility=1 且 feature/improvement → 预计完成只能在 /feasibility 写，
        //   防绕过评估口径 + 防主表 dev_estimated_at 与 feasibility timeline 快照不一致。needs_feasibility=0 仍走 estimate。
        if (['feature', 'improvement'].includes(row.type) && row.needs_feasibility === 1) {
          await sysRollback();
          return res.status(409).json({ error: '该单需先填可行性评估（预计完成在评估表单内一并提交）', code: 'ESTIMATE_REQUIRES_FEASIBILITY' });
        }
        // assigned_at 缺失保护（codex 15b L-1）：进开发态正常应有 assigned_at（electRepresentative 首次形成 roster 时写，
        //   §3.6 M2）；import/人工修库可能造出"开发中但 assigned_at 空"的脏单，缺失则拒（防绕过 >=assigned_at 闸门）。
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
        // 旁路 UPDATE（不改 status）+ 乐观锁绑 status（W06：actor 未必是 assigned_to，去主次不再绑 assigned_to 条件）
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET dev_estimated_at = ?, updated_at = datetime('now','localtime')
            WHERE id = ? AND status = ?`,
          [est, id, row.status]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_ESTIMATE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'estimate', ?, ?, ?)`,
          [id, est, actor.id, actor.name]
        );
        // [codex 100 号 HIGH-1] 方案 B（无条件重跑 runWGate）已被证伪并撤回——改方案 A（deferred 标记）：
        //   仅当 gate_deferred_at 非空（即此单确曾被 GATE 判定"全完成态但资格未过"，正等待资格修复）才重跑
        //   runWGate 消费标记；无标记时不调用，避免误伤 return/reopen 之后"roster 完成态保留但需求新一轮
        //   重新提交"的场景（那类场景不该被 estimate 单独一次回填就弹回 VERIFY，须走 remove+re-add 开新
        //   pending 实例——既有测试 S16/S31 等已验证）。
        if (row.gate_deferred_at) {
          await runWGate(id, row.type, row.status, actor);
        }
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

  // ── [R1 退场，v1.6 §2.3 C-1] POST /sys-issues/:id/set-release-flag：填发版信息（已下线）──────────
  //   通知改造 v1.6 上线编排收敛后，bug 待执行意图不再由 needs_release 承担（改 execute-release 的
  //   mode 参数，H-2）；本端点对 type='bug' 一律 LEGACY_RELEASE_FLOW_DISABLED（本端点历史上只服务 bug——
  //   findTransition 对 feature/improvement 从未定义 set_release_flag，故本端点 100% 面向 bug 流量，
  //   本次退场即整端点实质停用）。needs_release 列转只读残留（F5，历史 timeline 标签保留渲染）。
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
        if (row.type === 'bug') {
          await sysRollback();
          return res.status(409).json({ error: '该功能已下线，bug 上线流程请改用「批量指定上线开发」+「执行上线」', code: 'LEGACY_RELEASE_FLOW_DISABLED' });
        }
        // set_release_flag 合法前置态（历史仅 bug 流定义；feature/improvement 从未有此条目，findTransition 恒 null，防御性保留）
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

  // ── POST /sys-issues/:id/feasibility：填可行性评估（在册开发，不改 status，旁路独立事务，F2b §4.1 / v1.7 §十九）──────────
  //   闸门：conclusion 枚举 + requirement_confirm 非空 + dev_estimated_at 格式(>=assigned_at) + 有条件可行/不可行时 risk 必填；
  //   type 仅 feature/improvement；needs_feasibility=1（未勾选 409）；status=W06 白名单固化（M-3）；blocked=1 禁改（M-3' 409 ISSUE_BLOCKED）。
  //   C3 交付物：W06 切换——权限从 ownerGuard 改 assertDevMember（在册），去主次后任一在册开发均可填。
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
        const row = await dbGetAsync('SELECT id, type, status, assigned_at, needs_feasibility, blocked, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        if (!['feature', 'improvement'].includes(row.type)) { await sysRollback(); return res.status(409).json({ error: '仅变更类单据可填可行性评估', code: 'FEASIBILITY_NOT_APPLICABLE' }); }
        if (row.needs_feasibility !== 1) { await sysRollback(); return res.status(409).json({ error: '该单未要求可行性评估', code: 'FEASIBILITY_NOT_REQUIRED' }); }
        // status 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单）
        if (!SF.isW06Allowed('feasibility', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可填评估`, code: 'FEASIBILITY_STATUS_INVALID' });
        }
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        // blocked=1 禁改评估（codex 17b M-3，受阻要继续须先 unblock，保流程线性）
        if (row.blocked === 1) { await sysRollback(); return res.status(409).json({ error: '该单已受阻，请先解除受阻再填评估', code: 'ISSUE_BLOCKED' }); }
        // assigned_at 缺失保护 + >=assigned_at（同 estimate，dev_estimated_at 一并写入）
        const assignedMin = truncToMinute(row.assigned_at);
        if (!assignedMin) { await sysRollback(); return res.status(409).json({ error: '该单缺少指派时间（数据异常）', code: 'ASSIGNED_AT_MISSING' }); }
        if (est < assignedMin) { await sysRollback(); return res.status(400).json({ error: '预计完成时间不能早于指派时间', code: 'ESTIMATE_BEFORE_ASSIGN' }); }
        // 乐观锁绑 status='开发中'（W06：actor 未必是 assigned_to，去主次不再绑 assigned_to 条件）；
        //   UPDATE 评估字段 + dev_estimated_at
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET feasibility_conclusion = ?, feasibility_requirement_confirm = ?, feasibility_risk = ?,
                  dev_estimated_at = ?, updated_at = datetime('now','localtime')
            WHERE id = ? AND status = '开发中'`,
          [conclusion, requirementConfirm, risk || null, est, id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_FEASIBILITY' }); }
        // feasibility timeline 快照（append-only 冻结，summary 拼结论/需求理解/风险/预计完成）
        const snapshot = `结论：${conclusion}｜需求理解：${requirementConfirm}｜风险：${risk || '无'}｜预计完成：${est}`;
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'feasibility', ?, ?, ?)`,
          [id, snapshot, actor.id, actor.name]
        );
        // [codex 100 号 HIGH-1] 同 estimate：方案 B 撤回，改方案 A——仅 gate_deferred_at 非空时消费重跑
        //   runWGate（避免 return/reopen 后"roster 完成态保留但需重新提交"场景被误弹回 VERIFY）。
        if (row.gate_deferred_at) {
          await runWGate(id, row.type, row.status, actor);
        }
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

  // ── POST /sys-issues/:id/blocked：标记受阻（在册开发，不改 status，blocked=1，F2b §4.2）──────────
  //   reason 非空 + status=W06 白名单固化 + 重复 blocked 拒（M-4 防覆盖首次受阻证据）。
  //   ⭐ M-1 收口（codex 19 F2a 审）：仅 needs_feasibility=1 的 feature/improvement 单可受阻——守住「受阻归评估环节」不变量，
  //     否则 needs_feasibility=0 的受阻单会绕过 submit 评估闸门（submit 的 blocked 检查嵌在 needs_feasibility=1 内）。
  //   C3 交付物：W06 切换——权限从 ownerGuard 改 assertDevMember（在册），去主次后任一在册开发均可标记。
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
        const row = await dbGetAsync('SELECT id, type, status, needs_feasibility, blocked FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // M-1 收口：仅 feature/improvement + needs_feasibility=1 可受阻
        if (!['feature', 'improvement'].includes(row.type) || row.needs_feasibility !== 1) {
          await sysRollback(); return res.status(409).json({ error: '仅要求可行性评估的变更类单据可标记受阻', code: 'BLOCKED_NOT_APPLICABLE' });
        }
        // status 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单）
        if (!SF.isW06Allowed('blocked', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可标记受阻`, code: 'BLOCKED_STATUS_INVALID' });
        }
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        if (row.blocked === 1) { await sysRollback(); return res.status(409).json({ error: '该单已处于受阻状态', code: 'ISSUE_ALREADY_BLOCKED' }); }
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET blocked = 1, blocked_reason = ?, blocked_at = datetime('now','localtime'),
                  updated_at = datetime('now','localtime')
            WHERE id = ? AND status = '开发中' AND blocked = 0`,
          [reason, id]
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
        const row = await dbGetAsync('SELECT id, type, status, blocked, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
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
        // [codex 100 号 HIGH-1] 死锁场景一：blocked=1 单最后一个 pending 成员被 excuse（allComplete 达成但
        //   isGateEligibleForVerify 因 blocked=1 拦下，GATE 正确置 gate_deferred_at 并保持 DEV），此后 unblock
        //   清 blocked——方案 B（无条件重跑）已撤回，改方案 A：仅 gate_deferred_at 非空时消费重跑 runWGate
        //   （避免 return/reopen 之后误弹回 VERIFY，同 estimate/feasibility 一致口径）。
        if (row.gate_deferred_at) {
          await runWGate(id, row.type, row.status, actor);
        }
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
      // 受理排期改造 §4.2/§B：删「待评估/已排期」→「待指派」。与 hold.from（transitions.js·待指派/开发中/待验证/待上线）同源
      //   （resume 只能回暂缓前活跃态·hold.from 即活跃态权威集·INTAKE 态禁 hold 故不在内）。
      //   ⚠️ 历史兼容（§12.7）：存量 hold timeline from_status=待评估/已排期 的旧单 resume 映射待指派 → 属 C1 迁移范围（C0 阶段生产 sys 空表·无历史 hold）。
      const ACTIVE_STATES = ['待指派', '开发中', '待验证', '待上线'];   // 变更流活跃态（已上线/已关闭=终态，旁路态/INTAKE 不在内）
      // [codex C3 对抗审 HIGH-A 回填] resume 降级回 DEV 族——暂缓窗口内成员换血/移除完成态成员后，若仍机械
      //   恢复到暂缓前的 VERIFY/RELEASE 态，会被 [2b] 的进族门禁（enteringVerify/enteringRelease 要求
      //   在册≥1∧全完成）永久拒绝，且 resume 目标由 timeline 历史确定性推导、无法绕过（return/reopen/derive
      //   均救不了这条单）。降级方案（用户拍板）：目标∈VERIFY/RELEASE 族且 roster 当前不满足门禁条件时，把
      //   恢复目标降级为该 issue_type 的 DEV 族状态（feature/improvement=开发中，bug=处理中），走
      //   enteringDev 门（仅要求在册≥1，比 VERIFY/RELEASE 的"全完成"宽松）；满足原门则照旧恢复原目标不降级。
      //   零在册单降级后仍会被 enteringDev 拦（合理，非本次要解决的问题）——逃生口是暂缓期先给单加至少 1 名
      //   成员再 resume（D_PRE 族允许 add，矩阵 §4.3"预指派，主状态不动"）。
      //   降级信息通过 resumeDegradeInfo 传给 switch-case 写 timeline summary（如实记录+备注"自动降级"）。
      const resumeDegradeInfo = { degraded: false, originalTarget: null };
      const resolveToStatusInTxn = async (row) => {
        // 此回调在 BEGIN IMMEDIATE + 读到真实 row（status 已守 expectedFrom='已暂缓'）之后、同事务内执行。
        const holdEv = await dbGetAsync(
          `SELECT from_status FROM sys_issue_timeline
            WHERE issue_id = ? AND event_type = 'status_change' AND action_code = 'hold' AND to_status = '已暂缓'
            ORDER BY id DESC LIMIT 1`,
          [row.id]
        );
        let target = holdEv && holdEv.from_status;
        if (!target) throw new SysTransitionError(409, 'RESUME_NO_PRIOR_STATUS', '无法定位暂缓前状态（timeline 缺暂缓事件）');
        // C10 末次审 #2（codex149）：存量兼容——历史 hold timeline from_status 记录的旧态（受理排期改造前的
        //   「待评估/已排期」·C1 迁移只改 sys_issues.status 未回改 timeline 历史值）映射为「待指派」（新前段活跃态）。
        //   否则旧值 ∉ ACTIVE_STATES → RESUME_TARGET_INVALID 致存量已暂缓单永久无法 resume（兑现方案 §12.7/§366 承诺）。
        //   生产 sys 空表·当前无历史 hold·此为防御性闭合（zero-risk·映射后仍过下方 ACTIVE_STATES 校验）。
        if (target === '待评估' || target === '已排期') target = '待指派';
        // 校验 target 是当前 type 的合法【活跃态】（非终态/旁路态；防注入非法态）
        if (!ACTIVE_STATES.includes(target) || !(T.ALLOWED_STATUSES[row.type] || []).includes(target)) {
          throw new SysTransitionError(409, 'RESUME_TARGET_INVALID', `暂缓前状态「${target}」非合法活跃态，不可恢复`);
        }
        const targetFamily = SF.familyOfStatus(row.type, target);
        if (targetFamily === 'VERIFY' || targetFamily === 'RELEASE') {
          const rosterRows = await dbAllAsync(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [row.id]);
          const rosterActiveCount = rosterRows.length;
          const rosterAllComplete = rosterActiveCount > 0 && rosterRows.every(r => r.dev_status !== 'pending');
          if (!(rosterActiveCount >= 1 && rosterAllComplete)) {
            resumeDegradeInfo.degraded = true;
            resumeDegradeInfo.originalTarget = target;
            return SF.SYS_DEV_STATUSES[row.type][0];
          }
        }
        return target;
      };
      // sysIssueTransition 内 findTransition('resume', '已暂缓') 守前置态；expectedFrom='已暂缓' 双守；动态目标态事务内解析
      const r = await sysIssueTransition(id, 'resume', '已暂缓', sysActor(req), {}, { resolveToStatusInTxn, resumeDegradeInfo });
      const respBody = { id, status: r.toStatus };
      if (resumeDegradeInfo.degraded) {
        respBody.degraded = true;
        respBody.original_target = resumeDegradeInfo.originalTarget;
      }
      res.json(respBody);
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
        // ⭐ 角色权限重构 C0（方案 v1.5 §4-C0/§2.4）：derive 新单同样**必经受理**——落态走创建路径唯一入口（恒「待受理」），
        //   取代原「新单默认 intake_required=0 → 直落待指派/待处理」（那正是 v1.4 §2.2-A 认定的"derive 绕过受理门"缺口）。
        //   ⚠️ **必须同时在下方 INSERT 显式落 intake_required=1**：本表列定义为 `INTEGER NOT NULL DEFAULT 0`，
        //     原 INSERT 未列该字段（靠 DEFAULT 落 0）。若只改落态不补列，新单将是「待受理 + intake_required=0」的
        //     矛盾组合 → 被 sysIssueTransition 受理门不变量（INTAKE_GATE_ACTIONS·本文件 [3.5]）fail-closed 拒绝，
        //     派生单永远无法受理（卡死）。建单入口 INSERT 本就显式落该列，derive 此前是唯一漏网点。
        const initialStatus = T.resolveSysInitialStatusForCreate(type);
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
              created_by, created_by_name, record_source, intake_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', 1)`,
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
  // 三·六、C3b 建立 + C5 授权改造：附件（上传 / 下载 / 删除）—— 复刻 corrections.js 范式（§6 / 核实#11 / 11-H2 / 12-M1）
  //   落盘 uploads/sys-iteration/{id}/；multer 先落 _pending，handler 校验权限/状态通过后 persist 移正式目录 + INSERT。
  //   [C5 round_no 遗产①回填] 旧模型（11-H2）：delivery/screenshot 上传 round_no=NULL 暂存 → submit 事务绑
  //   round_no。**该绑定语义已随 C3 唯一 submit（W05 收敛，handleDevSubmit）整体退场**——submit 不再写
  //   round_no，三种附件类型（delivery/screenshot/spec）落库 round_no 恒为 NULL，无"暂存待绑"这回事；
  //   round_no 列仅对 C3 之前的存量生产行有值，纯历史数据不参与任何判定（§5.4 授权口径见下方三端点自身注释）。
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
  //   **物理删文件仅对「DB 确删的行（changes=1 且事务已提交）」**——否则事务回滚 / 行被并发 superseded 时，
  //     行仍 active 却文件被删 → 下载 404 不一致。
  //   [codex 106 号 LOW 回填] `status = 'active'` 守卫（防并发 supersede 窗口误删）仍是活防线，保留；旧
  //   `round_no IS NULL` 子句已随 round_no 绑定机制退场失去意义（本函数只处理 sysPersistAttachments 刚落库的
  //   行，C3 起该写路径 round_no 恒 NULL——条件恒真、从未真正过滤任何行，纯历史遗留死代码），本次简化删除，
  //   不改变任何可观测行为（del where 少一个恒真子句，结果集不变）。
  //   [混合对抗审 B 半修·106 号 LOW 后续] 原实现内部吞掉一切失败、调用方永远拿不到"是否真撤销"的信号——
  //   三处 TOCTOU recheck 409 分支曾无条件回复"上传已撤销"，即便实际撤销失败（附件仍 active）也这么说，
  //   等于对用户/日志撒谎。改为**返回 boolean**：全部行确认已从 active 撤下（本次删除成功，或核实时发现
  //   本就不在 active——例如被更早一次调用已处理）→ true；仍有任一行核实后仍 active → false（绝不向外抛
  //   这条铁律不变，调用方据 false 改说诚实文案 + 记错误日志，见三处调用点）。**重试一次**（获锁超时或
  //   DELETE 事务失败时，整批重跑一遍 attemptOnce，仍不行才认输）——不做 persist 整体事务化（P3 backlog，
  //   F1 基础设施结构不动，本次只加"重试 1 次 + 如实回报"两层轻量兜底）。
  async function sysRollbackPersisted(persisted) {
    const list = (persisted || []);
    if (list.length === 0) return true;
    const attemptOnce = async () => {
      try {
        await sysBeginImmediate();
        try {
          const deletedIds = new Set();
          for (const a of list) {
            const r = await dbRunAsync("DELETE FROM sys_issue_attachments WHERE id = ? AND status = 'active'", [a.id]);
            if (r && r.changes === 1) deletedIds.add(a.id);
          }
          await sysCommit();
          // 仅删「本次确已从 DB 删除的行」的文件，杜绝 active 行指向缺失文件（未匹配的 id 留给下方逐行核实兜底）
          for (const a of list) { if (deletedIds.has(a.id)) { try { safeDeleteFileSync(a.file_name, UPLOAD_DIR); } catch (_) {} } }
          return true;
        } catch (e) {
          try { await sysRollback(); } catch (__) { /* ignore */ }
          logger.warn('[系统迭代] sysRollbackPersisted DELETE 失败: ' + (e && e.message));
          return false;
        }
      } catch (acqErr) {
        logger.warn('[系统迭代] sysRollbackPersisted 获锁失败: ' + (acqErr && acqErr.message));
        return false;
      }
    };
    let committed = await attemptOnce();
    if (!committed) {
      logger.warn('[系统迭代] sysRollbackPersisted 首次尝试未提交，重试一次');
      committed = await attemptOnce();
    }
    // 最终真值来源＝逐行核实（不只信 attemptOnce 内部粗粒度布尔）：两次 attemptOnce 之间可能出现"第一次已
    // 部分删除成功、第二次因该行不再匹配 WHERE（已不是 active）而被计为未命中"这类假阴性——直接查库判"是否
    // 还 active"才是"全部行确认删除（或本就不存在）"这条成功语义的准确判据，且天然幂等（重复调用不误报）。
    for (const a of list) {
      const stillActive = await dbGetAsync(`SELECT 1 FROM sys_issue_attachments WHERE id = ? AND status = 'active'`, [a.id]);
      if (stillActive) return false;
    }
    return true;
  }
  // 清本次 _pending 残留（handler 校验失败/未移动时调；10-M2 命名 cleanupOrphanFiles，仅指 multer 临时文件，非 DB 暂存态）
  function sysCleanupOrphanFiles(req, issueId) {
    const files = Array.isArray(req.files) ? req.files : [];
    for (const f of files) { try { if (f && f.path) fs.unlinkSync(f.path); } catch (_) {} }
    if (issueId && /^[1-9]\d*$/.test(String(issueId))) { try { fs.rmdirSync(path.join(SYS_PENDING_BASE, String(issueId))); } catch (_) {} }
  }

  // ── C5（附件授权改造，方案 §5.4「附件口径统一表」+ §0 line33 角色定义）：三端点（上传/下载/删除）共用的
  //   在册/历史参与判定——在册（active）= 与 assertDevMember 同构语义（removed_at IS NULL），用于上传授权；
  //   历史参与（historical）= 子表曾有行且当前不在册（§0 line33），用于① 下载放行（§5.4 下载列含"历史参与"）
  //   ② 删除排除的裁定点（即便本人上传，历史参与"无任何写权"优先于"上传者可删"，见 §0 line33 与本文件下方
  //   DELETE 端点注释）。与详情端点 isRosterMember（含历史）EXISTS 查询同构（[[feedback_write_read_same_semantic]]），
  //   一次查询拆出 active/historical 两个布尔供三端点各自取用，不重复写 SQL。
  async function sysAttachmentRosterState(issueId, userId) {
    if (!userId || userId <= 0) return { active: false, historical: false };
    const rows = await dbAllAsync(`SELECT removed_at FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ?`, [issueId, userId]);
    const active = rows.some(r => r.removed_at === null || r.removed_at === undefined);
    const historical = rows.length > 0 && !active;
    return { active, historical };
  }

  // ── POST /sys-issues/:id/attachments：上传（C5·§5.4 唯一权威：spec=协调人(对接人∨admin)∧状态∉SYS_TERMINAL；
  //   delivery/screenshot=(在册∨协调人)∧状态∈SYS_DEV∪SYS_VERIFY）──────────────────────────────────────
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
      const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
      if (!row) { sysCleanupOrphanFiles(req, id); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
      // C5（§5.4 前置）：附件写先过 assertKnownIssueStatus——族外/未知 status 直接拒绝（防脏 status 绕过后续族判断）
      assertKnownIssueStatus(row.type, row.status);
      const actor = sysActor(req);
      const isAdmin = actor.role === 'admin';
      const isCoordinator = isSysCoordinator(actor, row.type);   // 协调人=对接人∪admin（§0），bug 精判已内置于函数
      const files = Array.isArray(req.files) ? req.files : [];

      if (attachmentType === 'spec') {
        // C5（§5.4）：需求材料上传 = 协调人（对接人∨admin）∧ 状态∉SYS_TERMINAL——原仅 admin+非作废两处均按
        //   唯一权威表拓宽/改用终态族（TERMINAL=已上线∪非发布终态，不含待上线，§4.0）。
        if (!isCoordinator) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '需求材料仅协调人（对接人/admin）可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
        if (SF.isInFamily(row.type, row.status, 'TERMINAL')) { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '终态单不可上传需求材料', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
        if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
        const supersedeId = parsePositiveId((req.body || {}).supersede_id);   // 可选替换（10-M1 supersede 留痕）
        persisted = await sysPersistAttachments(id, files, 'spec', null, actor);
        // TOCTOU 二次守卫：persist 后重读状态仍∉SYS_TERMINAL（校验→INSERT 间被流转进终态则回滚；type 不可变用首读值）
        const recheck = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
        if (!recheck || SF.isInFamily(row.type, recheck.status, 'TERMINAL')) {
          const failedIds = persisted.map(a => a.id);
          const rolledBack = await sysRollbackPersisted(persisted); persisted = [];
          if (!rolledBack) {
            logger.error(`[系统迭代] 附件上传撤销未确认（spec 锁外终态重验命中）：issue=${id}, attachment_ids=${JSON.stringify(failedIds)}`);
            return res.status(409).json({ error: '迭代单状态已变更，上传撤销未确认，请联系管理员核查附件', code: 'INVALID_STATE_FOR_ATTACHMENT' });
          }
          return res.status(409).json({ error: '迭代单状态已变更，上传已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
        }
        // 替换：旧 spec 标 superseded（12-M1 二次 WHERE：id + issue_id + attachment_type='spec' + active）+ note 留痕。
        //   A4：supersede UPDATE + note 包进事务——半成品（UPDATE 成功 note 失败）整体回滚 + 走外层 catch 删新 spec（替换整体失败，旧件保持 active，无"新旧都没了"窗口）。
        //   软信号：supersedeId 命中 → superseded=true；不命中（非本单/非 spec/非 active）→ superseded=false（新 spec 仍保留，前端据此提示"替换目标无效"）。
        let superseded = false;
        if (supersedeId) {
          await sysBeginImmediate();
          try {
            // [对抗审 A 回填·与 106 号 DELETE 锁内重验同构] 锁外 recheck（上方 L4166-4171）→ 本事务拿锁之间
            //   仍有终态转移窗口（publish/void 持锁提交）——supersede 让旧 spec 退出 active 是一次附件写，
            //   同受 §5.4 终态门约束，锁内须重读 status 以真值收口。命中终态：本事务回滚 + 撤销刚 persist 的
            //   新 spec（与锁外 recheck 失败同语义同码），return 在 try 内——事务已 sysRollback()，不会再走到
            //   外层 catch 的兜底回滚（sysRollback 已释放锁，外层 catch 不会二次拿锁重复回滚，对照 106 号范式）。
            const supGate = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
            if (!supGate || SF.isInFamily(row.type, supGate.status, 'TERMINAL')) {
              await sysRollback();
              const failedIds = persisted.map(a => a.id);
              const rolledBack = await sysRollbackPersisted(persisted); persisted = [];
              if (!rolledBack) {
                logger.error(`[系统迭代] 附件上传撤销未确认（supersede 锁内终态重验命中）：issue=${id}, attachment_ids=${JSON.stringify(failedIds)}`);
                return res.status(409).json({ error: '迭代单状态已变更，上传撤销未确认，请联系管理员核查附件', code: 'INVALID_STATE_FOR_ATTACHMENT' });
              }
              return res.status(409).json({ error: '迭代单状态已变更，上传已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
            }
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

      // delivery / screenshot（开发交付物，C5·§5.4）：(在册∨协调人) ∧ 状态∈(SYS_DEV∪SYS_VERIFY)。
      //   round_no 遗产①（M-P4）：C3 起唯一 submit（handleDevSubmit）不再绑 round_no（旧单人 case 'submit' 分支
      //   已随 W05 收敛删除，grep 零命中），round_no 落库恒 NULL——本函数不再是"暂存待 submit 绑"，纯粹是交付物/
      //   截图的落库时刻，无待绑语义（下方 logger.info 措辞同步更正）。
      //   状态门原仅 isDevWorkState（=SYS_DEV 单族），本次按 §5.4 拓宽到 SYS_DEV∪SYS_VERIFY（待验证阶段在册
      //   仍可补传交付物/截图，属真实行为放宽，非误改——旧口径只允许"开发中/处理中"，验收阶段被误拦）。
      const roster = await sysAttachmentRosterState(id, actor.id);
      if (!isCoordinator && !roster.active) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '交付附件仅在册开发/协调人可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
      const inDevOrVerify = SF.isInFamily(row.type, row.status, 'DEV') || SF.isInFamily(row.type, row.status, 'VERIFY');
      if (!inDevOrVerify) { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '仅开发进行态（开发中/处理中/待验证）可上传交付附件', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
      if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
      persisted = await sysPersistAttachments(id, files, attachmentType, null, actor);
      // TOCTOU 二次守卫：persist 后重读仍处 SYS_DEV∪SYS_VERIFY 态 且 授权仍成立（type 不可变用首读值；协调人身份
      //   不受事务影响故不重查，仅"在册"路径需重查——校验→INSERT 间被 remove/打回/作废则回滚）。
      const recheck = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
      const recheckStatusOk = !!recheck && (SF.isInFamily(row.type, recheck.status, 'DEV') || SF.isInFamily(row.type, recheck.status, 'VERIFY'));
      const recheckAuthOk = isCoordinator || (await sysAttachmentRosterState(id, actor.id)).active;
      if (!recheckStatusOk || !recheckAuthOk) {
        const failedIds = persisted.map(a => a.id);
        const rolledBack = await sysRollbackPersisted(persisted); persisted = [];
        if (!rolledBack) {
          logger.error(`[系统迭代] 附件上传撤销未确认（delivery/screenshot 锁外重验命中）：issue=${id}, attachment_ids=${JSON.stringify(failedIds)}`);
          return res.status(409).json({ error: '迭代单状态已变更，上传撤销未确认，请联系管理员核查附件', code: 'INVALID_STATE_FOR_ATTACHMENT' });
        }
        return res.status(409).json({ error: '迭代单状态已变更，上传已撤销，请刷新重试', code: 'INVALID_STATE_FOR_ATTACHMENT' });
      }
      logger.info(`用户 ${req.user.username} 为迭代单 #${id} 上传${attachmentType === 'screenshot' ? '截图' : '交付物'} ${persisted.length} 个（round_no 遗产①：恒 NULL，无待绑语义，C5）`);
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

  // ── GET /sys-issues/:id/attachments/:attId/download：下载（C5·§5.4 唯一权威：admin∨对接人∨在册∨历史参与；
  //   下载列本身无状态限定——不再单独判"已作废非 admin 403"，契约裁定点见完成报告）+ ALLOWED_FILE_DIRS 白名单 + 二次 WHERE active ──
  router.get('/sys-issues/:id/attachments/:attId/download', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const attId = parsePositiveId(req.params.attId);
    if (!id || !attId) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const actor = sysActor(req);
      const isAdmin = actor.role === 'admin';
      const isCoordinator = isSysCoordinator(actor, row.type);
      const roster = await sysAttachmentRosterState(id, actor.id);
      if (!isAdmin && !isCoordinator && !roster.active && !roster.historical) {
        return res.status(403).json({ error: '无权下载此附件', code: 'NOT_AUTHORIZED_TO_VIEW' });
      }
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

  // ── DELETE /sys-issues/:id/attachments/:attId：删除（C5·§5.4 唯一权威：(上传者∧非历史参与∨对接人∨admin)
  //   ∧ 状态∉SYS_TERMINAL——spec/delivery/screenshot 统一同一公式，不再分支）──────────────────────────
  //   round_no 遗产③（M-P4）：ATTACHMENT_BOUND_NOT_DELETABLE 由"round_no NOT NULL"（旧 submit 绑定语义，C3 起
  //   已退场）改判"状态∈SYS_TERMINAL"（终态族，§4.0）。存量已绑 round_no 的历史行不再单独处理——round_no 列
  //   保留为纯历史数据、不参与本判定（契约裁定点，见完成报告）。
  //   12-M1 二次 WHERE：id + issue_id + attachment_type + status='active' 不变。
  router.delete('/sys-issues/:id/attachments/:attId', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    const attId = parsePositiveId(req.params.attId);
    if (!id || !attId) return res.status(400).json({ error: '无效的 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const row = await dbGetAsync('SELECT id, type, status FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // C5（§5.4 前置）：附件写先过 assertKnownIssueStatus
      assertKnownIssueStatus(row.type, row.status);
      const att = await dbGetAsync(
        `SELECT id, attachment_type, round_no, file_name, uploaded_by FROM sys_issue_attachments WHERE id = ? AND issue_id = ? AND status = 'active'`,
        [attId, id]
      );
      if (!att) return res.status(404).json({ error: '附件不存在或已失效', code: 'SYS_ATTACHMENT_NOT_FOUND' });
      const actor = sysActor(req);
      const isAdmin = actor.role === 'admin';
      const isCoordinator = isSysCoordinator(actor, row.type);
      // §0 line33："历史参与…无任何写权"——优先于"上传者可删"，本次裁定点：历史参与者即便是本人上传也排除
      //   （见完成报告"契约裁定点"清单）。上传者本人若从未进过 dev_assignees（如 admin/协调人上传的 spec），
      //   roster.historical 恒 false，不受本裁定影响。
      let isUploaderEligible = false;
      if (Number(att.uploaded_by) === actor.id && actor.id > 0) {
        const roster = await sysAttachmentRosterState(id, actor.id);
        isUploaderEligible = !roster.historical;
      }
      if (!isAdmin && !isCoordinator && !isUploaderEligible) {
        return res.status(403).json({ error: '无权删除此附件', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' });
      }
      if (SF.isInFamily(row.type, row.status, 'TERMINAL')) {
        return res.status(409).json({ error: '终态单不可删除附件', code: 'ATTACHMENT_BOUND_NOT_DELETABLE' });
      }
      // 物理删（12-M1 二次 WHERE，attachment_type 防 spec/delivery 误删）。
      //   A1（txn-MED，C5 重定义，106 号 HIGH 补全）：旧"round_no IS NULL"TOCTOU 守卫随 round_no 绑定机制退场
      //   （C3 起恒 NULL，无并发绑定可言）一并失效。新 TOCTOU 关注点有二，均在"预检（BEGIN IMMEDIATE 之前）→
      //   拿锁"这段窗口内可能失真：① 单被推进至终态 ② 上传者被 remove（在册→历史参与，授权失效）。两者均由
      //   sysBeginImmediate 全局互斥锁天然收口（同一时刻只有一个写事务持锁，拿锁后原地重读即最新真值）——
      //   下方先重读 status 判终态，再对"凭上传者资格"路径重读 roster 判历史参与（admin/协调人身份不随时间
      //   窗口变化不重查）。均不在 DELETE WHERE 里拼子查询，改走显式重验 + 提前 return（评估后定，见完成报告）。
      // F1（C4.5 审）：DELETE + timeline INSERT 纳入 mutex 事务（与状态机同锁串行化，杜绝落进他人事务被回滚）；
      //   物理删文件挪到 COMMIT 成功之后——杜绝"DB 回滚但文件已删→行复活成 active 却文件没了→下载 404"的不可逆脏态。
      await sysBeginImmediate();
      try {
        const gateRecheck = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
        if (!gateRecheck || SF.isInFamily(row.type, gateRecheck.status, 'TERMINAL')) {
          await sysRollback();
          return res.status(409).json({ error: '迭代单状态已变更（进入终态），请刷新重试', code: 'ATTACHMENT_BOUND_NOT_DELETABLE' });
        }
        // [codex 106 号 HIGH 回填] 锁内授权重验：admin/协调人身份=JWT role+SYS_BUG_LIAISON_USER_IDS 常量白名单
        //   （非 DB 可变态，预检读到即终值，不随时间窗口变化，故不重查）；仅"凭上传者资格"这一路径的合法性依赖
        //   roster.historical（sys_issue_dev_assignees.removed_at，DB 可变态）——预检（BEGIN IMMEDIATE 之前）到
        //   拿锁之间存在窗口：预检时在册的上传者可能被协调人 remove（在册→历史参与），§0 line33"历史参与…无任何
        //   写权"须在锁内以真值收口（写锁已持有，此刻读到的即最终态，不会再变）。admin/isCoordinator 分支已直接
        //   放行则跳过本查询（省一次 DB 往返）；uploader 若从未在册（roster.historical 恒 false）不受影响。
        if (!isAdmin && !isCoordinator) {
          const rosterRecheck = await sysAttachmentRosterState(id, actor.id);
          if (rosterRecheck.historical) {
            await sysRollback();
            return res.status(403).json({ error: '无权删除此附件（已不在册）', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' });
          }
        }
        const del = await dbRunAsync(
          `DELETE FROM sys_issue_attachments WHERE id = ? AND issue_id = ? AND attachment_type = ? AND status = 'active'`,
          [attId, id, att.attachment_type]
        );
        if (!del || del.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '附件状态已变更，请刷新重试', code: 'SYS_ATTACHMENT_NOT_FOUND' }); }
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

  // ── C6：发布冻结快照写入（§8「快照基数与插入语义」，**假定调用方已 BEGIN IMMEDIATE**）─────────
  //   同一 (release_id,issue_id) 生命周期只快照一次：INSERT ... ON CONFLICT(release_id,issue_id) DO NOTHING
  //   （禁 INSERT OR IGNORE——会静默吞 NOT NULL/CHECK 等一切约束失败，方案 §8 明文）。
  //   changes 读取纪律（Lz-1）：changes 直接取本 INSERT 语句的 dbRunAsync 返回值（`this.changes`，sqlite3 单连接
  //   serialize 队列内该 Promise resolve 时即该语句执行完毕的直接结果，中间未插入任何其他语句），非另起查询估算。
  //   changes=0 → 同事务显式 SELECT 确认该 (release_id,issue_id) 是否已存在快照行：存在→视为已冻结继续（幂等，
  //   覆盖"同一批次内理论不会二次发布但脏库/竞态"防线）；不存在→抛错，由调用方 catch 整体 ROLLBACK 发布事务。
  //   snapshot_json 由 JS 层查 sys_issue_dev_commits 全部现存行（含 removed 实例，方案 §8 明文）拼数组后
  //   JSON.stringify——不用 SQL 聚合（防 LEFT JOIN 誤产：零行本应 []，聚合函数在无匹配行时常产出单个
  //   全 NULL 聚合结果而非空集，见 Mz-5）。commit_id 即表主键 id，ORDER BY id ASC 天然升序。
  async function snapshotReleaseCommitsInTxn(releaseId, issueId) {
    const commitRows = await dbAllAsync(
      `SELECT id AS commit_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at
         FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id ASC`,
      [issueId]
    );
    const snapshotJson = JSON.stringify(commitRows);   // 零行 → commitRows=[] → '[]'（Mz-5 固定合法空数组）
    const ins = await dbRunAsync(
      `INSERT INTO sys_issue_release_commit_snapshots (release_id, issue_id, snapshot_json, created_at)
       VALUES (?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(release_id, issue_id) DO NOTHING`,
      [releaseId, issueId, snapshotJson]
    );
    if (!ins || ins.changes === 0) {
      const existing = await dbGetAsync(
        'SELECT id FROM sys_issue_release_commit_snapshots WHERE release_id = ? AND issue_id = ?',
        [releaseId, issueId]
      );
      if (!existing) {
        // 请求破坏门禁不变量（发布 changes=0 查无快照）→ 400（§10 GATE_INVARIANT HTTP 状态二分表）。
        throw new SysTransitionError(400, 'GATE_INVARIANT', `发布快照写入异常（release_id=${releaseId} issue_id=${issueId} changes=0 且查无快照），已整体回滚`);
      }
      // 已存在 → 视为已冻结，继续（幂等；正常路径不可达——同一 (release_id,issue_id) 只有一次发布边——此为防御性覆盖）。
    }
  }

  // 事务内发布核心（**假定调用方已 BEGIN IMMEDIATE**，本函数不 begin/commit/rollback）。
  //   publish（攒批）与 hotfix（单条兜底）共用，杜绝两路逻辑漂移（§6.1 两路都产出批次记录）。
  //   payload.release_note / version_tag 非空时先落库（"填上线说明+版本 → 发布"单步），再校验（闸门③ D7·C6 起
  //   release_note 必填不变、version_tag 仅长度校验允许空落 NULL——§8 去 version_tag 必填，109 号注释同步）。
  //   抛 SysTransitionError 由调用方 try/catch ROLLBACK + endpoint sendSysTransitionError 转 HTTP。
  // [codex 102 号 HIGH 回填] RELEASE 守卫接线——action/actionKind 由调用方传入（三处调用点各自的语义身份，
  //   §2.6/status-transition-guard.js RELEASE_ACTION_ACTIONKIND_PAIRS 既有枚举，勿造新值）：
  //   - `publishReleaseTransition`（legacy 批量 /publish）→ action='publish', actionKind='publish'
  //   - `hotfix-publish` 端点（R2 单条兜底，仅变更流可达，同样建 release_id 真批次）→ 同上
  //     （方案 §2.5"publish=变更流 publish 动作"这一桶的结构特征=建真批次/产快照，hotfix-publish 完全符合，
  //     不是 execute-release 的 hotfix 分支——那支不建批次不落 release_id，语义不同）
  //   - `execute-release`(mode=publish) → action='execute-release', actionKind='execute'
  async function _publishReleaseCoreInTxn(releaseId, actor, payload = {}, action, actionKind) {
    const rel = await dbGetAsync('SELECT id, status, release_note, version_tag, release_type FROM sys_releases WHERE id = ?', [releaseId]);
    if (!rel) throw new SysTransitionError(404, 'RELEASE_NOT_FOUND', '上线批次不存在');
    if (rel.status !== '计划中') throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次非「计划中」，不能发布');

    // 闸门③（D7，§7·C6 去 version_tag 必填）：release_note trim 非空 + 长度上限；version_tag 仅长度上限，允许空
    //   （SSOT §8「去 version_tag 必填」/S21）。payload 覆盖优先（单步填+发布）。
    let releaseNote = (payload.release_note !== undefined && payload.release_note !== null) ? payload.release_note : rel.release_note;
    let versionTag = (payload.version_tag !== undefined && payload.version_tag !== null) ? payload.version_tag : rel.version_tag;
    releaseNote = (typeof releaseNote === 'string' ? releaseNote.trim() : '');
    versionTag = (typeof versionTag === 'string' ? versionTag.trim() : '');
    if (!releaseNote) throw new SysTransitionError(400, 'RELEASE_NOTE_REQUIRED', '请填写上线说明');
    if (releaseNote.length > SYS_RELEASE_NOTE_MAX) throw new SysTransitionError(400, 'RELEASE_NOTE_TOO_LONG', `上线说明超长（≤${SYS_RELEASE_NOTE_MAX} 字）`);
    if (versionTag.length > SYS_VERSION_TAG_MAX) throw new SysTransitionError(400, 'VERSION_TAG_TOO_LONG', `版本号超长（≤${SYS_VERSION_TAG_MAX} 字）`);
    // 落库最终说明+版本（T-L1：只存批次表，issue 侧靠 release_id+timeline 引用；status='计划中' 二次守卫已由上方读保证）
    //   [C6 契约裁定点] 空 version_tag 落库用 NULL 非 ''——对齐 POST /sys-releases 建批次时"未填→NULL"的既有列语义
    //   （SSOT 未逐字定码此处，选与既有惯例同源的空值表示，防"空串"与"未填"两种状态语义分裂）。
    await dbRunAsync('UPDATE sys_releases SET release_note = ?, version_tag = ? WHERE id = ? AND status = ?',
      [releaseNote, versionTag || null, releaseId, '计划中']);

    // H-3 步骤2：读组内 issue，校 ≥1 且全「待上线」（add-issues 已守，此处防并发被移出/重开清空/混入非待上线）。
    const members = await dbAllAsync('SELECT id, status, type, needs_release FROM sys_issues WHERE release_id = ?', [releaseId]);
    if (members.length === 0) throw new SysTransitionError(409, 'RELEASE_EMPTY', '批次内无待上线单，不能发布');
    const bad = members.find(m => m.status !== '待上线');
    if (bad) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_READY', `批次内 #${bad.id} 非「待上线」（当前「${bad.status}」），请先移除`);
    // B（codex M-2）：core 内再校成员 type∈可发布3类，与 add-issues 入口防线一致（纵深防脏库/旧表缺 CHECK/手工修库）。
    //   正常 schema 下 config 受 DB CHECK(type<>'config' OR release_id IS NULL) 永不可成为成员，此守卫为 schema 漂移兜底（对齐 submit 闸门"不全信单入口"哲学）。
    const badType = members.find(m => !RELEASABLE_TYPES.includes(m.type));
    if (badType) throw new SysTransitionError(409, 'RELEASE_MEMBER_NOT_RELEASABLE', `批次内 #${badType.id} 类型不可发布（${badType.type}），请先移除`);
    // [v1.6 退场·C3b] 旧 needs_release=1 纵深闸（bug 流 Commit ② 引入）已移除——needs_release 唯一写点
    //   set_release_flag 随 R1 一并退场（LEGACY_RELEASE_FLOW_DISABLED），此后 bug 的 needs_release 永远
    //   停在建单时的初值（NULL，转只读残留，F5），若仍强校验 needs_release=1 会让新流程（execute-release
    //   mode=publish）**恒 409**——新流程的守卫已换成更强的 release_assignee_id 体系（G6 请求级前置：
    //   全部成员 release_assignee_id 非空且全等于 actor.id，见 execute-release 端点），完全覆盖本闸原意图。
    //   ⚠️ 本函数其余校验（下方 badType/族别一致性/状态/原子 UPDATE/timeline/批次翻发布）逐字未动——
    //   这是"不动 _publishReleaseCoreInTxn 内核"硬约束下唯一必要的外科手术式改动：该谓词只筛
    //   m.type==='bug' 的成员，对变更流(feature/improvement)完全不可达，故不影响变更流零回归；
    //   退场前唯二能带 bug 成员进本函数的旧入口（R2 hotfix-publish 单条 / R4 批次 publish）现均在各自
    //   端点入口处对 type='bug'/release_type='bug' 提前拒绝（本 commit 同步落地），故本谓词移除前后，
    //   legacy 路径实际上都已到不了这里——唯一新增的合法调用方是 execute-release(mode=publish)（G6）。
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

    // [codex 102 号 HIGH 回填] RELEASE 守卫接线——此前守卫纯函数已实现 RELEASE 的 action/actionKind 配对 +
    //   「在册≥1∧无 pending」进族门（95-97 号 H1 修复引入），但真实发布路径零调用，是"SSOT 说有门、代码没
    //   接"的矛盾态（我们自己的 H1 修复造成，不留给 C6）。同一事务内批量查询每单 roster（与 W07 接线同源的
    //   查询方式：`removed_at IS NULL` 在册行），逐单调用 assertMainStatusTransition——零在册/含 pending 的
    //   待上线单在此处 400 GATE_INVARIANT 拦下，早于下方批量 UPDATE，故拦下时状态/批次/快照均未落库
    //   （fail-fast，符合"逐单校验、任一不过整批不落地"的 H-3 原子性精神）。**不改 GATE 合成边 action=null
    //   契约**——RELEASE routeKind 的 action 恒为具名字符串，本次接线不涉及 GATE routeKind。
    {
      const memberIds = members.map(m => m.id);
      const ph = memberIds.map(() => '?').join(',');
      const rosterRows = await dbAllAsync(
        `SELECT issue_id, dev_status FROM sys_issue_dev_assignees WHERE issue_id IN (${ph}) AND removed_at IS NULL`,
        memberIds
      );
      const rosterByIssue = new Map();
      for (const id of memberIds) rosterByIssue.set(id, []);
      for (const r of rosterRows) rosterByIssue.get(r.issue_id).push(r.dev_status);
      for (const m of members) {
        const statuses = rosterByIssue.get(m.id) || [];
        const rosterActiveCount = statuses.length;
        const rosterAllComplete = rosterActiveCount > 0 && statuses.every(s => s !== 'pending');
        assertMainStatusTransition({
          routeKind: 'RELEASE', action, actionKind, issueType: m.type,
          before: m.status, after: '已上线', rosterActiveCount, rosterAllComplete,
        });
      }
    }

    // H-3 步骤3：批量翻「已上线」+ released_at，校 changes 等于预期数否则整体回滚 409。
    const flip = await dbRunAsync(
      "UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE release_id = ? AND status = '待上线'",
      [releaseId]
    );
    if (!flip || flip.changes !== expected) {
      throw new SysTransitionError(409, 'RELEASE_PUBLISH_CONFLICT', '批次内单状态已变更，请刷新重试');
    }

    // H-3 步骤3.5（C6·§8「发布与快照」）：主状态置「已上线」成功后、事务提交前，逐单落发布冻结快照。
    //   本函数是 publish / hotfix-publish 端点 / execute-release(mode=publish) 三入口的共用内核（见函数头注释），
    //   快照逻辑长在这唯一交汇点即天然满足"三入口同事务"——execute-release(mode=hotfix) 走的是完全独立的直接
    //   UPDATE 分支（不经本函数、release_id 恒 NULL），故不产快照，无需额外排除。
    for (const m of members) {
      await snapshotReleaseCommitsInTxn(releaseId, m.id);
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
      // [H-1 收口·codex40] R4 legacy /publish 退场加固：不只看存量 release_type，从**成员实际族别** fail-closed——
      //   纯 bug 成员但 release_type IS NULL 的脏/历史批次，若只在端点查 release_type='bug' 会漏，直发即绕过
      //   release_assignee 执行权矩阵（复活旧 admin 发布入口）。本 wrapper **仅被 R4 调用**（execute-release /
      //   hotfix-publish 均直连 _publishReleaseCoreInTxn，不经此），故在此按成员族别拦 bug 是唯一必要且**不触核内**的
      //   外科加固；execute-release(mode=publish) 的合法 bug 发布不受影响。remove-issues 不连带扩展（只摘单不发布、
      //   不绕执行权，且过度拦截会让脏批次更难清理，codex40 第十人视角）。
      const famMembers = await dbAllAsync('SELECT type FROM sys_issues WHERE release_id = ?', [releaseId]);
      const legacyFams = [...new Set(famMembers.map(m => releaseFamilyOf(m.type)).filter(Boolean))];
      if (legacyFams.includes('bug')) {
        throw new SysTransitionError(409, 'LEGACY_RELEASE_FLOW_DISABLED', 'bug 批次请改用「执行上线」流程');
      }
      const r = await _publishReleaseCoreInTxn(releaseId, actor, payload, 'publish', 'publish');
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

  // ── GET /sys-releases/:id/commit-snapshots：批次发布冻结快照只读端点（C6，§10 API 契约）──────────
  //   [C6 契约裁定点] 返回形态：SSOT §10 仅注明"只读"，未逐字定 response body 形态——本端点将每行
  //   snapshot_json 解析为 commits 数组一并返回（非原样字符串），省前端二次 JSON.parse；风格对齐
  //   GET /sys-releases/:id（批次不存在存在性前置校验 + 纯只读投影，同为 requireAdmin）。
  //   批次存在但零快照行（未发布 / hotfix mode=hotfix 路径无 release_id / accept·resume 进待上线不产快照）
  //   → items: []（合法态，非错误，不 404）。
  router.get('/sys-releases/:id/commit-snapshots', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    try {
      const rel = await dbGetAsync('SELECT id FROM sys_releases WHERE id = ?', [id]);
      if (!rel) return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' });
      const rows = await dbAllAsync(
        `SELECT id, release_id, issue_id, snapshot_json, created_at
           FROM sys_issue_release_commit_snapshots WHERE release_id = ? ORDER BY issue_id ASC`,
        [id]
      );
      const items = rows.map(r => {
        let commits = [];
        try { commits = JSON.parse(r.snapshot_json); } catch (_) { commits = []; }   // 防御性：正常写路径（snapshotReleaseCommitsInTxn）不会产生非法 JSON
        return { id: r.id, release_id: r.release_id, issue_id: r.issue_id, commits, created_at: r.created_at };
      });
      res.json({ release_id: id, items });
    } catch (err) {
      logger.error('[系统迭代] 批次快照查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次快照查询失败' });
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
        // [R5①退场，v1.6 §2.3 C-1 回填] bug 单一律拒绝走 legacy 批次编辑链路——v1.6 后 bug 批次只能由
        //   execute-release(mode=publish) 在事务内建/更（H-3 单一聚合根），admin 手动"建批次→add-issues(bug)→publish"
        //   整链对 bug 停用，否则绕过 release_assignee 守卫复活双入口。同时天然覆盖 [R5②]（建批次拒 bug 族别）——
        //   批次的 release_type='bug' 只能由本次判断阻止的这条入口产生，堵住这一条即无其他途径可达。
        const bugIssueIds = typeRows.filter(r => r.type === 'bug').map(r => r.id);
        if (bugIssueIds.length > 0) {
          await sysRollback();
          return res.status(409).json({ error: '该功能已下线，bug 上线流程请改用「批量指定上线开发」+「执行上线」', code: 'LEGACY_RELEASE_FLOW_DISABLED', issue_ids: bugIssueIds });
        }
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
        const rel = await dbGetAsync('SELECT id, status, release_type FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能移除', code: 'RELEASE_NOT_PLANNING' }); }
        // [R5⑤退场，v1.6 §2.3 C-1 回填] bug 族别批次 fail-closed 同拒——v1.6 后 add-issues 已堵住 bug 进 legacy
        //   批次的唯一入口，故本分支正常路径不可达（防御性闸，覆盖脏库/历史残留 release_type='bug' 批次场景）。
        if (rel.release_type === 'bug') {
          await sysRollback();
          return res.status(409).json({ error: '该功能已下线，bug 批次请改用「执行上线」流程', code: 'LEGACY_RELEASE_FLOW_DISABLED' });
        }
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
  //   [R4 退场，v1.6 §2.3 C-1] **release_type='bug' 批次一律拒发**（替代者=execute-release(mode=publish)，
  //   其内部复用 _publishReleaseCoreInTxn 但入口守卫换成 release_assignee 体系）——**变更流（release_type='change'
  //   或历史 NULL 批次）保留，唯一发布入口，行为逐字不变**。
  router.post('/sys-releases/:id/publish', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    try {
      const rel = await dbGetAsync('SELECT release_type FROM sys_releases WHERE id = ?', [id]);
      if (!rel) return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' });
      if (rel.release_type === 'bug') {
        return res.status(409).json({ error: '该功能已下线，bug 批次请改用「执行上线」流程', code: 'LEGACY_RELEASE_FLOW_DISABLED' });
      }
      const r = await publishReleaseTransition(id, sysActor(req), req.body || {});
      const releasedIds = r.releasedIssueIds || [];
      // 批次通知逐单发需求方·已上线（§6.2：状态先提交成功）。ultracode 审 #4：批次可达 200 单（C4 上限），
      //   N 条钉钉网络发送串行 await 在响应前会阻塞 HTTP 响应至超时（504），而批次其实已发布成功。
      //   故先回响应，再**后台**逐单顺序 best-effort 派发（dispatch 内绝不抛 + record 进 mutex 串行化，不阻塞主响应）。
      // ⚠️ codex 审 M-2：此后台派发为**进程内非持久 best-effort**——PM2 重启/进程退出会丢未发完的通知，单据停在
      //   requester_notify_status='not_sent'/'failed'。补偿口径 = C6 前端按 not_sent/failed 筛出提供**手动补发**入口
      //   （对齐 issue-tracker 既有手动 notify 端点范式）；内网 + 批次量小，不引入持久队列（见 backlog）。
      //   ⚠️ 论据更正（2026-07-27）：原写「内网**单 admin** + 批次量小」，核实生产实为 **6 个 active admin** ——
      //     "只有一个人会点发布"这个前提不成立，6 人可并发启动多个最多 200 单的后台循环。当前仍不引入持久队列，
      //     但依据改为「内网低频 + 有手动补发兜底」，并已记入 backlog：若真出现并发批量发布，需加进程级有界队列 + 并发上限。
      res.json({ id, status: '已发布', released: releasedIds, count: r.count });
      (async () => { for (const iid of releasedIds) await dispatchSysNotify(iid, 'notifyReleasedToRequester'); })().catch(() => { /* dispatch 内已 best-effort，此处兜底防 unhandledRejection */ });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── [R2 退场，v1.6 §2.3 C-1] POST /sys-issues/:id/hotfix-publish：单条 hotfix 兜底 ──────────
  //   **变更流(feature/improvement)保留**（admin，自动建 is_hotfix=1 批次 + 一键发布，§6.1，行为逐字不变）；
  //   **bug 一律 LEGACY_RELEASE_FLOW_DISABLED**（替代者=execute-release(mode=hotfix)，注意新 hotfix
  //   **不建批次**，与本端点"hotfix 也建 is_hotfix=1 批次"语义不同，H-3）。
  //   单事务原子：校单「待上线」AND 未挂批次 AND 非 config/非 bug → 建 hotfix 批次 → 绑单 → 复用 _publishReleaseCoreInTxn 发布。
  router.post('/sys-issues/:id/hotfix-publish', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const issueId = parsePositiveId(req.params.id);
    if (!issueId) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '');
    // C6 去 version_tag 必填（SSOT §8/S21）：不再校非空，仅长度上限。
    const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '');
    if (!releaseNote) return res.status(400).json({ error: '请填写上线说明', code: 'RELEASE_NOTE_REQUIRED' });
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
        if (!RELEASABLE_TYPES.includes(issue.type)) {
          await sysRollback();
          return res.status(409).json(issue.type === 'config'
            ? { error: '配置类不进上线批次', code: 'CONFIG_NO_RELEASE' }
            : { error: `该类型暂不可进上线批次（当前仅 ${RELEASABLE_TYPES.join('/')}）`, code: 'TYPE_NOT_RELEASABLE' });
        }
        // [R2 退场] bug 一律拒绝（放在 status/release_id 校验之前，防止"该单非待上线"这类通用错误掩盖"整条路已下线"的更根本事实）
        if (issue.type === 'bug') {
          await sysRollback();
          return res.status(409).json({ error: '该功能已下线，bug 上线流程请改用「批量指定上线开发」+「执行上线」', code: 'LEGACY_RELEASE_FLOW_DISABLED' });
        }
        if (issue.status !== '待上线' || issue.release_id !== null) {
          await sysRollback();
          return res.status(409).json({ error: '该单非「待上线」或已挂批次，不能 hotfix', code: 'ISSUE_NOT_HOTFIXABLE' });
        }
        releaseNo = await nextReleaseNo();
        const relIns = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag, created_by, created_by_name, release_type)
           VALUES (?, ?, '计划中', 1, ?, ?, ?, ?, ?)`,
          // C6：空 version_tag 落 NULL（与核心函数 UPDATE 步骤同源语义，见 _publishReleaseCoreInTxn 契约裁定点注释）；
          // 核心函数随后会以同值再次 UPDATE 覆盖，此处仅保持初始建批次记录本身语义一致，非功能必需。
          [releaseNo, `hotfix #${issueId}`, releaseNote, versionTag || null, actor.id, actor.name, releaseFamilyOf(issue.type)]   // D-A：存族别（bug→'bug' / feature·improvement→'change'）
        );
        releaseId = relIns.lastID;
        const bind = await dbRunAsync(
          "UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = '待上线' AND release_id IS NULL",
          [releaseId, issueId]
        );
        if (!bind || bind.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '该单状态已变更，请刷新重试', code: 'ISSUE_NOT_HOTFIXABLE' }); }
        result = await _publishReleaseCoreInTxn(releaseId, actor, { release_note: releaseNote, version_tag: versionTag }, 'publish', 'publish');
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
  // 三·四·五、通知改造 C3b 上线编排（§2.3，G3-G6）——批量指定上线开发 + 换人 + 指定开发本人执行上线
  //   替代 v1.103.0 已上线 ②「建单人确认发布」为「建单人编排、指定开发执行」，改已上线执行权。
  //   三端点均对 issue 批量操作（非 /sys-issues/:id/xxx 单条模式），因待执行阶段尚无 sys_releases 批次可挂。
  // ============================================================

  // ── POST /sys-issues/assign-release-dev：批量指定上线开发（建单人，G3，H-4 先整批资格校验）──────────
  //   仅允许"未指定执行人"或"同人幂等重提"（M-1）；改 A→B 须走 reassign-release-dev。
  router.post('/sys-issues/assign-release-dev', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const raw = b.issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要指定上线开发的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    const devId = parsePositiveId(b.release_assignee_id);
    if (!devId) return res.status(400).json({ error: '必须指定上线开发', code: 'RELEASE_ASSIGNEE_REQUIRED' });
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [devId]);
        if (!dev) { await sysRollback(); return res.status(400).json({ error: '指定的上线开发不存在', code: 'RELEASE_ASSIGNEE_NOT_FOUND' }); }
        if (dev.role === 'viewer') { await sysRollback(); return res.status(400).json({ error: '不能指定查看者为上线开发', code: 'RELEASE_ASSIGNEE_VIEWER' }); }
        const devName = dev.display_name || dev.username || `user#${dev.id}`;

        const idPh = issueIds.map(() => '?').join(',');
        const rows = await dbAllAsync(`SELECT id, type, status, release_id, release_assignee_id FROM sys_issues WHERE id IN (${idPh})`, issueIds);
        if (rows.length !== issueIds.length) { await sysRollback(); return res.status(404).json({ error: '部分迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // H-4：先整批资格校验，任一失败整批不落库。
        for (const r of rows) {
          if (r.type !== 'bug') { await sysRollback(); return res.status(409).json({ error: `#${r.id} 非 bug 单，不支持上线编排`, code: 'RELEASE_ASSIGN_TYPE_INVALID', issue_id: r.id }); }
          if (r.status !== '待上线') { await sysRollback(); return res.status(409).json({ error: `#${r.id} 非「待上线」，不能指定上线开发`, code: 'RELEASE_ASSIGN_STATUS_INVALID', issue_id: r.id }); }
          if (r.release_id !== null) { await sysRollback(); return res.status(409).json({ error: `#${r.id} 已挂上线批次，不能重新指定`, code: 'ISSUE_ALREADY_IN_RELEASE', issue_id: r.id }); }
          // M-1：仅"未指定"或"同人幂等重提"；已指定他人须走 reassign-release-dev。
          if (r.release_assignee_id !== null && Number(r.release_assignee_id) !== devId) {
            await sysRollback();
            return res.status(409).json({ error: `#${r.id} 已指定其他上线开发，请改用「换人」（reassign-release-dev）`, code: 'RELEASE_ASSIGNEE_ALREADY_SET', issue_id: r.id });
          }
        }
        for (const iid of issueIds) {
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_assignee_id = ?, release_assignee_name = ?, updated_at = datetime('now','localtime')
               WHERE id = ? AND type = 'bug' AND status = '待上线' AND release_id IS NULL
                 AND (release_assignee_id IS NULL OR release_assignee_id = ?)`,
            [devId, devName, iid, devId]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${iid} 状态已变更，请刷新重试`, code: 'CONCURRENT_STATE_CHANGE', issue_id: iid });
          }
          await dbRunAsync(
            `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
             VALUES (?, 'note', ?, 'assign_release_dev', ?, ?)`,
            [iid, `指定上线开发：${devName}`, actor.id, actor.name]
          );
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ assigned: issueIds, release_assignee_id: devId, count: issueIds.length });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/reassign-release-dev：批量换人（建单人，G4，M-1 边界：仅已指定单可换）──────────
  router.post('/sys-issues/reassign-release-dev', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const raw = b.issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要换人的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    const devId = parsePositiveId(b.release_assignee_id);
    if (!devId) return res.status(400).json({ error: '必须指定新的上线开发', code: 'RELEASE_ASSIGNEE_REQUIRED' });
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        const dev = await dbGetAsync('SELECT id, display_name, username, role FROM users WHERE id = ?', [devId]);
        if (!dev) { await sysRollback(); return res.status(400).json({ error: '指定的上线开发不存在', code: 'RELEASE_ASSIGNEE_NOT_FOUND' }); }
        if (dev.role === 'viewer') { await sysRollback(); return res.status(400).json({ error: '不能指定查看者为上线开发', code: 'RELEASE_ASSIGNEE_VIEWER' }); }
        const devName = dev.display_name || dev.username || `user#${dev.id}`;

        const idPh = issueIds.map(() => '?').join(',');
        const rows = await dbAllAsync(`SELECT id, type, status, release_id, release_assignee_id, release_assignee_name FROM sys_issues WHERE id IN (${idPh})`, issueIds);
        if (rows.length !== issueIds.length) { await sysRollback(); return res.status(404).json({ error: '部分迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        for (const r of rows) {
          if (r.type !== 'bug') { await sysRollback(); return res.status(409).json({ error: `#${r.id} 非 bug 单，不支持上线编排`, code: 'RELEASE_ASSIGN_TYPE_INVALID', issue_id: r.id }); }
          if (r.status !== '待上线') { await sysRollback(); return res.status(409).json({ error: `#${r.id} 非「待上线」，不能换人`, code: 'RELEASE_ASSIGN_STATUS_INVALID', issue_id: r.id }); }
          if (r.release_id !== null) { await sysRollback(); return res.status(409).json({ error: `#${r.id} 已挂上线批次（已进入执行），不能换人`, code: 'ISSUE_ALREADY_IN_RELEASE', issue_id: r.id }); }
          // 换人专用：必须已有指定人（未指定应走 assign-release-dev）。
          if (r.release_assignee_id === null) { await sysRollback(); return res.status(409).json({ error: `#${r.id} 尚未指定上线开发，请改用「批量指定上线开发」（assign-release-dev）`, code: 'RELEASE_ASSIGNEE_NOT_SET', issue_id: r.id }); }
          // 【批量通知 Commit 0 · H-1 同人守卫】新人 == 现执行人 → 整批拒（不清零/不写 timeline）。
          //   否则换人重置会把该单已有的 sent/failed 通知态无意义打回 not_sent、清已读、写"X→X"伪 timeline。
          //   整批任一同人即 409（对齐本端点"任一失败整批不落库"范式）。
          if (Number(r.release_assignee_id) === devId) { await sysRollback(); return res.status(409).json({ error: `#${r.id} 的上线开发已是该人，无需换人`, code: 'RELEASE_ASSIGNEE_UNCHANGED', issue_id: r.id }); }
        }
        for (const r of rows) {
          const oldName = r.release_assignee_name;
          // 【批量通知 Commit 0 · C-1】换人时原子重置 release_assignee_notify_* 5 列——新执行人的通知态归零，
          //   否则沿用旧人 sent/failed → 新人被判"已通知"、已读时刻失真、批量通知②态闸误拦。
          //   末行 release_assignee_id <> devId 双保险（H-1 已在前置循环拒同人，此处再兜一层防并发插入同人）。
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_assignee_id = ?, release_assignee_name = ?,
               release_assignee_notify_status = 'not_sent', release_assignee_notified_at = NULL,
               release_assignee_notify_message_key = NULL, release_assignee_notify_error = NULL,
               release_assignee_read_at = NULL, updated_at = datetime('now','localtime')
               WHERE id = ? AND type = 'bug' AND status = '待上线' AND release_id IS NULL
                 AND release_assignee_id IS NOT NULL AND release_assignee_id <> ?`,
            [devId, devName, r.id, devId]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${r.id} 状态已变更，请刷新重试`, code: 'CONCURRENT_STATE_CHANGE', issue_id: r.id });
          }
          await dbRunAsync(
            `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
             VALUES (?, 'note', ?, 'reassign_release_dev', ?, ?)`,
            [r.id, `改派上线开发：${oldName || '（原执行人）'} → ${devName}`, actor.id, actor.name]
          );
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ reassigned: issueIds, release_assignee_id: devId, count: issueIds.length });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── POST /sys-issues/execute-release：指定开发本人执行上线（G5 hotfix / G6 publish）──────────
  //   权限=actor.id===release_assignee_id（H-1，admin 无隐式执行权，除非 admin 本人被显式指定）。
  //   mode=hotfix：单 issue，不建批次，release_id/version_tag 保持 NULL（H-2/H-3）。
  //   mode=publish：请求级前置（全选中 issue 状态=待上线∧release_assignee_id 非空∧全相同∧==actor.id，H-4）+
  //     单事务建/更 sys_releases 批次（复用 _publishReleaseCoreInTxn 内核）+ 全部转已上线；任一失败整批回滚。
  //   F2（2026-07-06 用户拍板）：不自动触发任何通知（建单人通知走手动 notify-creator，G8）。
  router.post('/sys-issues/execute-release', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const b = req.body || {};
    const mode = b.mode;
    if (!['hotfix', 'publish'].includes(mode)) return res.status(400).json({ error: 'mode 仅支持 hotfix/publish', code: 'INVALID_RELEASE_MODE' });
    const raw = b.issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要执行上线的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    if (mode === 'hotfix' && issueIds.length !== 1) return res.status(400).json({ error: 'hotfix 模式仅支持单条', code: 'HOTFIX_SINGLE_ONLY' });
    const actor = sysActor(req);

    try {
      // [U-2 收口·ultracode] execute-release 角色下限：指定执行人若在 assign 后被降级为 viewer
      //   （assign-release-dev 已校 viewer，但降级不清 release_assignee_id、authenticateToken 只回查 status 不回查 role，
      //   server.js 亦不清该字段），执行时**回查当前 role** 守 viewer-never-write 不变量（本端点内闭合，不碰 server.js）。
      //   status 不在此查——authenticateToken 已强制 status='active'（否则 403 账号已被禁用），此处再查冗余且会误伤未设
      //   status 的测试夹具；本收口只补 authenticateToken 不覆盖的 role 维度。
      const execUser = await dbGetAsync('SELECT role FROM users WHERE id = ?', [actor.id]);
      if (!execUser || execUser.role === 'viewer') {
        return res.status(403).json({ error: '当前账号无执行上线权限（已降级为查看者）', code: 'EXECUTOR_NOT_ELIGIBLE' });
      }
      if (mode === 'hotfix') {
        const issueId = issueIds[0];
        await sysBeginImmediate();
        try {
          const issue = await dbGetAsync('SELECT id, type, status, release_id, release_assignee_id FROM sys_issues WHERE id = ?', [issueId]);
          if (!issue) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
          if (issue.type !== 'bug') { await sysRollback(); return res.status(409).json({ error: '仅 bug 单支持上线编排', code: 'RELEASE_ASSIGN_TYPE_INVALID' }); }
          // H-1：仅被指定执行人本人可执行；admin 无隐式执行权（除非 admin 恰被指定）。
          if (!issue.release_assignee_id || Number(issue.release_assignee_id) !== actor.id) {
            await sysRollback();
            return res.status(403).json({ error: '仅被指定的上线开发本人可执行上线', code: 'RELEASE_ASSIGNEE_GUARD_FAILED' });
          }
          if (issue.status !== '待上线' || issue.release_id !== null) {
            await sysRollback();
            return res.status(409).json({ error: '该单非「待上线」或已挂批次，不能执行 hotfix', code: 'ISSUE_NOT_EXECUTABLE' });
          }
          // [codex 102 号 HIGH 回填] RELEASE 守卫接线（hotfix 路径，与 _publishReleaseCoreInTxn 同批修复）——
          //   UPDATE 前查询该单 roster（与 W07/_publishReleaseCoreInTxn 同源的查询方式：removed_at IS NULL
          //   在册行），调用 assertMainStatusTransition(routeKind='RELEASE', action='execute-release',
          //   actionKind='hotfix')；零在册/含 pending 在此处 400 GATE_INVARIANT 拦下，早于下方 UPDATE。
          {
            const rosterRows = await dbAllAsync(
              `SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`,
              [issueId]
            );
            const rosterActiveCount = rosterRows.length;
            const rosterAllComplete = rosterActiveCount > 0 && rosterRows.every(r => r.dev_status !== 'pending');
            assertMainStatusTransition({
              routeKind: 'RELEASE', action: 'execute-release', actionKind: 'hotfix', issueType: issue.type,
              before: issue.status, after: '已上线', rosterActiveCount, rosterAllComplete,
            });
          }
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
               WHERE id = ? AND status = '待上线' AND release_id IS NULL AND release_assignee_id = ?`,
            [issueId, actor.id]
          );
          if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' }); }
          await dbRunAsync(
            `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name)
             VALUES (?, 'release', '待上线', '已上线', ?, 'execute_release_hotfix', ?, ?)`,
            [issueId, 'hotfix 上线（不发版，不建批次）', actor.id, actor.name]
          );
          await sysCommit();
        } catch (txErr) {
          try { await sysRollback(); } catch (_) { /* ignore */ }
          throw txErr;
        }
        // F2：不自动通知
        return res.json({ mode: 'hotfix', issue_id: issueId, status: '已上线' });
      }

      // mode === 'publish'（C6 去 version_tag 必填，SSOT §8/S21：不再校非空，仅长度上限）
      const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '');
      const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '');
      if (!releaseNote) return res.status(400).json({ error: '请填写上线说明', code: 'RELEASE_NOTE_REQUIRED' });
      if (releaseNote.length > SYS_RELEASE_NOTE_MAX) return res.status(400).json({ error: `上线说明超长（≤${SYS_RELEASE_NOTE_MAX} 字）`, code: 'RELEASE_NOTE_TOO_LONG' });
      if (versionTag.length > SYS_VERSION_TAG_MAX) return res.status(400).json({ error: `版本号超长（≤${SYS_VERSION_TAG_MAX} 字）`, code: 'VERSION_TAG_TOO_LONG' });

      let releaseId = null, releaseNo = null, result = null;
      await sysBeginImmediate();
      try {
        const idPh = issueIds.map(() => '?').join(',');
        const rows = await dbAllAsync(`SELECT id, type, status, release_id, release_assignee_id FROM sys_issues WHERE id IN (${idPh})`, issueIds);
        if (rows.length !== issueIds.length) { await sysRollback(); return res.status(404).json({ error: '部分迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // H-4/G6 请求级前置：全部满足 type=bug ∧ 状态=待上线 ∧ release_id IS NULL ∧ release_assignee_id 非空
        //   ∧ 全部相同 ∧ ==actor.id，否则整批拒绝（不指出具体哪条，防止批量场景下逐条泄露过多信息且语义本就是"整批"）。
        const assigneeIdSet = new Set(rows.map(r => (r.release_assignee_id === null ? null : Number(r.release_assignee_id))));
        const anyBad = rows.some(r => r.type !== 'bug' || r.status !== '待上线' || r.release_id !== null
          || r.release_assignee_id === null || Number(r.release_assignee_id) !== actor.id);
        if (anyBad || assigneeIdSet.size !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '批次内所有单必须为 bug、「待上线」且指定同一上线开发（即当前登录人）', code: 'RELEASE_BATCH_ASSIGNEE_MISMATCH' });
        }
        // H-3：单一聚合根——建批次（release_type='bug'，created_by 复用为"批次持执行人"字段，即当前登录开发）。
        releaseNo = await nextReleaseNo();
        const relIns = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag, created_by, created_by_name, release_type)
           VALUES (?, ?, '计划中', 0, ?, ?, ?, ?, 'bug')`,
          [releaseNo, `执行上线（${actor.name}）`, releaseNote, versionTag || null, actor.id, actor.name]   // C6：空 version_tag 落 NULL，同源见 hotfix-publish 注释
        );
        releaseId = relIns.lastID;
        // 绑单：双 WHERE 守卫（待上线 + release_id IS NULL + release_assignee_id=actor.id），changes 须等于批次数（原子）。
        const idPh2 = issueIds.map(() => '?').join(',');
        const bind = await dbRunAsync(
          `UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime')
             WHERE id IN (${idPh2}) AND status = '待上线' AND release_id IS NULL AND release_assignee_id = ?`,
          [releaseId, ...issueIds, actor.id]
        );
        if (!bind || bind.changes !== issueIds.length) { await sysRollback(); return res.status(409).json({ error: '批次内单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' }); }
        // 复用共享内核发布（H-3）：核心校验（成员≥1/全待上线/type 白名单/族别一致）+ 原子翻已上线 + release timeline + 批次已发布。
        result = await _publishReleaseCoreInTxn(releaseId, actor, { release_note: releaseNote, version_tag: versionTag }, 'execute-release', 'execute');
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // F2：不自动通知
      res.status(201).json({ mode: 'publish', release_id: releaseId, release_no: releaseNo, status: '已上线', released: result.releasedIssueIds, count: result.count });
    } catch (err) {
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

  // 对接人侧 markdown（通知改造 C3 G7，仅 bug 建单 path B 场景；"通知对接人协助指派"）。
  function buildSysRelayMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `📮 请协助指派开发：${safeTitle}`,
      md: `### 📮 新 bug 待指派开发\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n请登录平台为该问题指派开发处理人。${link}`,
    };
  }

  // 建单人侧 markdown（通知改造 C3 G8；开发/对接人向建单人汇报进展或完结）。
  function buildSysCreatorMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    const statusLine = issueNotify.issueSafeText(issue.status, 20);
    return {
      title: `📬 迭代单状态更新：${safeTitle}`,
      md: `### 📬 迭代单状态更新\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n- **当前状态**：${statusLine}\n\n请登录平台查看详情。${link}`,
    };
  }

  // 建单人侧·受理退改 markdown（受理排期改造 §5.1②·C3；对接人/admin 退改后自动通知建单人去「待修改」补充修改）。
  //   与 buildSysCreatorMarkdown（进展/完结汇报）区分：退改是「请你改」的 actionable 通知，带退改原因。
  function buildSysIntakeReturnCreatorMarkdown(issue, reason, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    const reasonText = issueNotify.issueSafeText(reason, 200);
    return {
      title: `📝 迭代单需修改后重新提交：${safeTitle}`,
      md: `### 📝 您提交的迭代单需修改\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n- **退改原因**：${reasonText}\n\n请登录平台在「待修改」状态下修改后重新提交受理。${link}`,
    };
  }

  // 技术负责人侧 markdown（受理排期改造 §6·C5·对接人/admin 请技术负责人对待受理单做技术评估沟通）。
  function buildSysTechLeadMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `🔧 请协助技术评估：${safeTitle}`,
      md: `### 🔧 请协助技术评估（受理沟通）\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n对接人就该单发起了技术负责人沟通，请登录平台查看需求并给出技术评估意见。${link}`,
    };
  }

  // 上线执行开发侧 markdown（通知改造 follow-up 2026-07-07；admin 通知被指定上线开发执行 hotfix/发版）。
  function buildSysReleaseExecutorMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `🚀 请执行上线：${safeTitle}`,
      md: `### 🚀 你被指定为本单上线开发\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n该 bug 单已进入「待上线」，请登录平台执行 hotfix（不发版直接上线）或发版（建批次填版本号）。${link}`,
    };
  }

  // 批量通知上线开发·合并 markdown（模型B 同执行人多单合并一条，镜像单条 buildSysReleaseExecutorMarkdown 转义范式）。
  //   M-2（方案 §3）：正文最多列前 SYS_RELEASE_BATCH_MD_MAX 条，超出附「…其余 M 条请登录平台查看」——防同执行人
  //   极端批量（理论至 SYS_BATCH_ISSUE_MAX=200）markdown 超钉钉消息长度上限致整组 failed。平台入口用无 issue 参数的
  //   总入口链接（非逐单深链）。
  const SYS_RELEASE_BATCH_MD_MAX = 20;
  function buildSysReleaseExecutorBatchMarkdown(issueList, baseUrl) {
    const n = issueList.length;
    const shown = issueList.slice(0, SYS_RELEASE_BATCH_MD_MAX);
    const lines = shown.map(it => `- #${it.id} ${issueNotify.issueSafeText(it.title, 60)}（${issueNotify.issueSafeText(it.system_name, 30)}）`);
    const overflow = n > SYS_RELEASE_BATCH_MD_MAX ? `\n- …其余 ${n - SYS_RELEASE_BATCH_MD_MAX} 条请登录平台查看` : '';
    const entry = baseUrl ? `\n\n[登录平台查看](${baseUrl}/Sys_Iteration.html)` : '';
    return {
      title: `🚀 你有 ${n} 个待上线单待执行`,
      md: `### 🚀 你被指定为以下 ${n} 个待上线单的上线开发\n\n${lines.join('\n')}${overflow}\n\n请登录平台执行 hotfix（不发版直接上线）或发版（建批次填版本号）。${entry}`,
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
  // 同 sysNotifyWrite，但回传 run 结果（批量通知按组守卫 UPDATE 需 changes 判命中数，见 notify-release-executor-batch）。
  async function sysNotifyWriteRun(sql, params) {
    await sysBeginImmediate();
    try { const r = await dbRunAsync(sql, params); await sysCommit(); return r; }
    catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
  }
  // 三侧落库 helper（read_at 在每次新发送时一并重置——新 message_key 后旧已读时刻失去意义；失败时同样清，failed=无可读消息）。
  async function recordSysDevNotify(issueId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET notify_status=?, notified_at=datetime('now','localtime'),
              notify_message_key=?, notify_error=?, read_at=NULL WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId]);
  }
  // requester 落库 helper 扩展落 phone_snapshot（通知改造 C3 H-5/M-A）：每次实际尝试发送（无论成败）都把
  //   本次使用的手机号固化进 requester_notify_phone_snapshot——首次发送=当前 requester_phone；此后任何
  //   重发/自动再触发都读快照（sendSysRequesterNotify 内 phoneToUse 已按此口径解析），故这里"再写一次快照"
  //   对已有快照是幂等 no-op、对首次发送是"落快照"动作，单一写点不分裂。
  async function recordSysRequesterNotify(issueId, ok, messageKey, error, phoneSnapshot) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET requester_notify_status=?, requester_notified_at=datetime('now','localtime'),
              requester_notify_message_key=?, requester_notify_error=?, requester_read_at=NULL,
              requester_notify_phone_snapshot=COALESCE(requester_notify_phone_snapshot, ?) WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), phoneSnapshot || null, issueId]);
  }
  // 对接人侧落库（通知改造 C3 G7，relay_* 5 列，与三侧 notify_status 处理同构）。
  //   ⭐ 角色权限重构 C0（codex 第三轮审 MED-1）：WHERE 补 `relay_notified_user_id=?` 收件人围栏。
  //     缺口：本函数原先只按 id 更新。C0 让 reactivate/resubmit 会**清空** relay 七列（回受理门=新一轮），
  //     而"通知已通过前置校验、正在发送"的在途请求随后完成回调时，会把已归零的 relay_notify_status
  //     重新写成 sent/failed → 出现「无收件人却有发送状态」的跨轮污染。
  //     （我上一轮判断"C0 后 relay 无写入路径故不可达"是**不完整的**：部署前已存在 relay 目标的历史单、
  //      以及"校验已过、清理发生在发送与回写之间"的在途请求，都仍可达。）
  //     修法取 codex 的低成本方案：把**发起发送时的收件人**作为 CAS 条件——清空后旧回调零命中，
  //     无需新增版本列（与 tech_lead 侧的 request_event_id 围栏同构，只是复用现成列）。
  async function recordSysRelayNotify(issueId, ok, messageKey, error, relayUserId) {
    return await sysNotifyWriteRun(
      `UPDATE sys_issues SET relay_notify_status=?, relay_notified_at=datetime('now','localtime'),
              relay_notify_message_key=?, relay_notify_error=?, relay_read_at=NULL
         WHERE id=? AND relay_notified_user_id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId, relayUserId]);
  }
  // 建单人侧落库（通知改造 C3 G8，creator_notify_* 5 列，C1a 已建列·本 commit 起首次接入写路径）。
  async function recordSysCreatorNotify(issueId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET creator_notify_status=?, creator_notified_at=datetime('now','localtime'),
              creator_notify_message_key=?, creator_notify_error=?, creator_read_at=NULL WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId]);
  }
  // 技术负责人侧落库（受理排期改造 §6·C5·9 列 tech_lead_notify_*）。
  //   ⚠️ 与 creator/relay 范式关键差异：WHERE 加 `tech_lead_notify_request_event_id=?`——**条件更新拒过期回写**（§6·codex 128-M/130-H）：
  //     只在「当前请求版本仍是 requestEventId」时落库；若期间又 request_tech_consult（换人/同人连发→request_event_id 已变）则本次
  //     首发/重发/异步回写作废（返回 changes=0·调用方据此判过期·不覆盖新版本的投递态）。返回 run 结果供调用方判 changes。
  //   ⚠️ 语义边界（codex C5 MED-4）：这是**版本围栏写回**（护 DB 结果归属·防旧版本投递态污染新版本）·**非 exactly-once 投递**——
  //     旧版本的外部钉钉消息仍可能实际送达（只是回写被拒）·同一版本的并发重发也都会实际发送。本期内网低频**接受 at-least-once/可能重复**
  //     （⚠️ 2026-07-27 论据更正：原写「本期**单 admin** 内网低频」，核实生产实为 **6 个 active admin**，"只有一个人会点重发"不成立；
  //      结论仍维持接受重复，但依据改为「内网低频 + 重复投递业务可容忍」，不再以操作者唯一为前提）
  //     （方案 §13 本期不做通知代际/幂等锁）；真要恰好一次需 attempt_id/inflight 状态或事务型 outbox（YAGNI·未做）。
  //   §8.3 字段不变量：sent⟹notified_at+message_key+sent_by 非空；failed⟹error+sent_by 非空；read_at 每次新投递重置 NULL。
  //   （not_sent⟹sent_by/read_at 空 由 request_tech_consult 端点重置字段时保证·本函数只落 sent/failed·恒写 sent_by。）
  async function recordSysTechLeadNotify(issueId, requestEventId, ok, messageKey, error, sentBy) {
    // §8.3 契约守卫（codex C5 HIGH-3）：
    //   ① sent/failed 都要求 sent_by 正整数——sentBy 非正整数是调用方 bug（应传 actor.id）·抛契约错（由调用方 best-effort catch 兜·不静默写非法行）。
    //   ② sent⟹message_key 非空——ok=true 但发送器漏返 message_key = 软失败（复刻 issue-tracker「message_key 缺失即判失败」范式）·降级 failed(message_key_missing)·杜绝「sent 但 message_key 空」违约行。
    const sb = Number(sentBy);
    if (!(sb > 0)) throw new Error(`recordSysTechLeadNotify: sent_by 必须为正整数（§8.3 sent/failed⟹sent_by 非空）·实际=${sentBy}`);
    let effectiveOk = !!ok, mk = messageKey, err = error;
    if (effectiveOk && (messageKey == null || messageKey === '')) { effectiveOk = false; err = 'message_key_missing'; mk = null; }
    return await sysNotifyWriteRun(
      `UPDATE sys_issues SET tech_lead_notify_status=?, tech_lead_notified_at=datetime('now','localtime'),
              tech_lead_notify_message_key=?, tech_lead_notify_error=?, tech_lead_read_at=NULL, tech_lead_notify_sent_by=?
         WHERE id=? AND tech_lead_notify_request_event_id=?`,
      [effectiveOk ? 'sent' : 'failed', effectiveOk ? mk : null, effectiveOk ? null : (err || 'other'), sb, issueId, requestEventId]);
  }
  // 上线执行开发侧落库（通知改造 follow-up 2026-07-07，release_assignee_notify_* 5 列，镜像 creator 范式）。
  async function recordSysReleaseExecutorNotify(issueId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issues SET release_assignee_notify_status=?, release_assignee_notified_at=datetime('now','localtime'),
              release_assignee_notify_message_key=?, release_assignee_notify_error=?, release_assignee_read_at=NULL WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId]);
  }
  // 开发协作子表逐 dev 落库（通知改造 C3 G9）：定位 = (issue_id, user_id, removed_at IS NULL) 活动行（§6.1 M-2），
  //   软删历史行不参与——WHERE 天然排除，若并发中该行恰被软删，changes=0，本函数吞（best-effort 通知写，不抛）。
  async function recordSysDevAssigneeNotify(issueId, userId, ok, messageKey, error) {
    await sysNotifyWrite(
      `UPDATE sys_issue_dev_assignees SET notify_status=?, notified_at=datetime('now','localtime'),
              notify_message_key=?, notify_error=?, read_at=NULL
        WHERE issue_id=? AND user_id=? AND removed_at IS NULL`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), issueId, userId]);
  }

  // dev 侧发送（收件人 = assigned_to → users.id/phone/dingtalk_user_id；§8.2）。
  //   ⚠️ 本函数只服务【自动派发】路径（dispatchSysNotify，对 bug 早返回不触达——现只有变更流 feature/improvement
  //   会走到这里）——单开发 + 主表 notify_* 语义在通知改造后对变更流保持零回归。bug 的手动逐 dev 通知走
  //   G9（notify-developer 端点）+ recordSysDevAssigneeNotify（子表），两条路径按 type 天然分流，互不覆盖。
  async function sendSysDevNotify(issue, marker, baseUrl) {
    if (!issue.assigned_to) { await recordSysDevNotify(issue.id, false, null, 'no_assignee'); return; }
    const dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.assigned_to]);
    if (!dev) { await recordSysDevNotify(issue.id, false, null, 'dev_not_found'); return; }
    const { title, md } = buildSysDevMarkdown(issue, marker, baseUrl);
    const result = await sendIssueDingtalkRaw(dev, title, md);
    await recordSysDevNotify(issue.id, !!result.ok, result.message_key, result.reason);
  }

  // 需求方侧发送（收件人 = requester_phone 反查钉钉号；业务方无平台账号；§8.2）。
  //   通知改造 C3 H-5/M-A 收件人快照：phoneToUse 优先取已落的 requester_notify_phone_snapshot（"重发"场景——
  //   一旦首次实际尝试过发送，后续一律认准同一快照，不受当前 requester_phone 被清空/改号影响）；
  //   快照为空（真正首次发送，或历史 pre-C1a 无快照旧数据不适用——生产 0 行不可达）才退回当前 requester_phone。
  async function sendSysRequesterNotify(issue, kind, baseUrl) {
    const phoneToUse = issue.requester_notify_phone_snapshot || issue.requester_phone;
    // ultracode 审 #2：无需求方（内部自发现单常见，requester 三字段+快照皆空）→ 无人可通知，保持 not_sent（不算失败）。
    //   否则每张内部单 estimate/已上线后都被打成 requester『failed』，C6 满屏假失败红标 + admin 无意义重试。
    //   区分『有需求方但缺手机号』(→failed) 与『根本无需求方』(→保持 not_sent)。
    if (!phoneToUse && !issue.requester_name && !issue.requester_dept) return;
    if (!phoneToUse) { await recordSysRequesterNotify(issue.id, false, null, 'requester_phone_empty', null); return; }
    let extra = null;
    if (kind === 'released' && issue.release_id) {
      const rel = await dbGetAsync('SELECT version_tag, release_note FROM sys_releases WHERE id = ?', [issue.release_id]);
      if (rel) extra = { versionTag: rel.version_tag, releaseNote: rel.release_note };
    }
    const { title, md } = buildSysRequesterMarkdown(issue, kind, baseUrl, extra);
    const result = await sendIssueDingtalkToRequester(phoneToUse, title, md);
    // [U-1 收口·ultracode + codex42] 快照仅在**已投递**时固化，判据=`已送达该号`而非仅 result.ok：
    //   ① 硬失败（requester_invalid 号查不到钉钉/no_config/token/网络 !r.success）=消息**未送达**→不固化（传 null，
    //      COALESCE 保留原值：首发硬失败仍 NULL、admin 改正 requester_phone 后重发读新号，堵"错号永久锁死→业务方失联"）。
    //   ② message_key_missing（r.success===true 但无 key，见 server.js sendIssueDingtalkToRequester 末段）=钉钉**已接受
    //      投递**、只是无法跟踪已读→消息已到该人，必须固化（否则 admin 误以为没发去改号，重发到新号=违反 M-A"重发认同一人"）。
    //   ③ 成功=固化。成功后再失败重发传 null→COALESCE 保留成功快照不被抹。
    const requesterDispatched = result.ok || result.reason === 'message_key_missing';
    await recordSysRequesterNotify(issue.id, !!result.ok, result.message_key, result.reason, requesterDispatched ? phoneToUse : null);
  }

  // ── 交互优化 C2：自动通知总开关（具名策略函数，替代原 type==='bug' 早返回）──────────────
  //   本期把变更流(feature/improvement) 的自动钉钉派发也改为「全手动」，对齐 bug 单——即所有 type 都不
  //   自动派发（bug 早已手动；变更流本次改手动；config 未来加时亦手动）。用具名函数而非无条件 return，
  //   显式列 type、留可观测性、未来若要恢复某 type 自动派发只需改此一处（codex H4）。
  //   ⚠️ 部署切换：本项目=单开发者一次性部署（deploy skill 前后端同步上 + bump 缓存串），不存在多用户
  //     新旧前端长期并存窗口，故未实现 AUTO/CUTOVER/MANUAL 三态状态机 + CLIENT_UPGRADE_REQUIRED
  //     （方案 §4.6 为多用户平滑切换设计，对单人一次性部署过重）；回滚=改本函数返回值重部署。
  function isAutoNotifyEnabled(issueType) {
    // 本期全关（返回 false）。保留 type 形参：未来若要给某 type 恢复自动派发，在此按 type 放行即可。
    void issueType;
    return false;
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
      // ── 交互优化 C2：自动派发总闸（替代原 `if (issue.type === 'bug') return`）──
      //   全 type 手动化——变更流通知改由详情页通知区手动点按钮触发（同 bug 单）。isAutoNotifyEnabled 现恒 false，
      //   故此处对所有 type 早返回。保留具名判断而非删 10 个调用点（无发送副作用）。
      //   ⚠️ codex L2 诚实标注：判断位于 SELECT 之后，故每个调用点仍付出一次只读 issue 查询（非真"空操作"）；
      //   现每次状态变更后多一次 SELECT，无发送/写库副作用、开销可接受。逐个删调用点（彻底省这次查询）留 backlog。
      if (!isAutoNotifyEnabled(issue.type)) return;
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
  // 三·六、手动通知端点（④b-1 复刻 correction notify-* 手动范式 + 通知改造 C3 四方扩展，§6 手动链式）
  //   bug 流通知不自动派发（dispatchSysNotify 对 bug 早返回），改由相关方在详情页手动点按钮触发；
  //   变更流自 C2a 起**同样支持手动通知**（自动派发照旧），两者可发状态白名单不同，见 sysNotifyStatusesFor。
  //   4 类：开发（逐 dev，子表）/ 对接人（relay·仅 admin·随 C0 关闭 path B 正在退场）/ 建单人（self-guard）/ 业务方（byPhone 快照）。
  //   ⭐ 权限（角色权限重构 C1 后·全类型统一）：developer / creator / requester 三通道 = **admin ∨ 受理人[13]**，
  //     对应的**三个**端点均挂 requireIntakeLiaison 粗筛 + handler 内 sysManualNotifyGuard 精判（type 门限 / 状态 / 通道白名单）；
  //     relay 与 release_executor 两通道 = **仅 admin**（requireAdmin），不随 C1 放开。
  //     此前的「走 requireAdminOrBugLiaison 粗筛」「creator 含主开发本人」「变更流仅 admin」三条口径均已作废
  //     （中间件已删除 / H3 删主开发放权 / C1 删变更流特判）。
  //   ⚠️ 端点不再限 type='bug'：C2a 起变更流亦走手动通知（bug 与变更流的可发状态白名单不同，见 sysNotifyStatusesFor）。
  // ============================================================

  // ── [codex31/ultracode ④b-1 复审 + 通知改造 C3 §5.2] 手动通知状态闸门（**后端真闸=权威**；前端按钮硬编码镜像同一状态集=非授权源，改一侧须同步另一侧，对齐本模块 SI_CHAT_STATUSES/白名单前端镜像范式；复刻 issue-tracker STATUS_NOT_NOTIFIABLE 范式 server.js:11321）──
  //   ⚠️ 两审收敛核心：前端按钮受 SI_CHAT_STATUSES 收窄，但后端原缺状态闸门→直连 API/前端态过期可对终态 bug 发矛盾通知。
  //   通知开发仅「处理中」（开发在干活态；待验证/待上线非其回合，指派/返工模板不适用，避免陈旧误导，含 ultracode external-api nit）。
  //   通知对接人仅「待处理」（G7，建单后未受理前的窗口，对接人协助指派）。
  //   通知建单人：待验证/待上线/已上线（G8，开发完成→建单人验收/上线闭环）。
  //   [F3 收窄，2026-07-06 用户拍板] 通知报障人：待验证/待上线/已上线——**去掉「处理中」**（方案 §5.2 sendable 表逐字；
  //   与旧 ④b-1「受理后活跃态」口径不同，用户可感知变化，批3 报告单列确认）；排 待处理[未受理无进展]/已拒绝/已作废[终态"正在跟进"矛盾卡片]。
  const SYS_NOTIFY_DEV_STATUSES = ['处理中'];
  const SYS_NOTIFY_RELAY_STATUSES = ['待处理'];
  const SYS_NOTIFY_CREATOR_STATUSES = ['待验证', '待上线', '已上线'];
  const SYS_NOTIFY_REQUESTER_STATUSES = ['待验证', '待上线', '已上线'];
  const SYS_NOTIFY_RELEASE_EXECUTOR_STATUSES = ['待上线'];   // 通知改造 follow-up：仅待上线态（release_assignee 已指定）可通知上线开发

  // ── 交互优化 C2a：变更流(feature/improvement) 手动通知状态白名单（方案 §3.2 矩阵）──────────────
  //   与 bug 流分开（bug 开发态='处理中'，变更流='开发中'）。channel×type 精确取，后端权威、前端镜像。
  //   developer：开发中/待验证（指派/改派/打回后开发在干活或待验证回合）；
  //   creator/requester：待验证/待上线/已上线（开发完成→建单人验收/需求方进展-上线闭环，同 bug creator/requester 口径）。
  const SYS_NOTIFY_DEV_STATUSES_CHANGE = ['开发中', '待验证'];
  const SYS_NOTIFY_CREATOR_STATUSES_CHANGE = ['待验证', '待上线', '已上线'];
  const SYS_NOTIFY_REQUESTER_STATUSES_CHANGE = ['待验证', '待上线', '已上线'];
  // 按 type + 通道取可发状态白名单（bug 用原常量，变更流用 *_CHANGE；未知 type 返空=一律不可发，默认拒绝）。
  function sysNotifyStatusesFor(type, channel) {
    if (type === 'bug') {
      return { developer: SYS_NOTIFY_DEV_STATUSES, relay: SYS_NOTIFY_RELAY_STATUSES,
               creator: SYS_NOTIFY_CREATOR_STATUSES, requester: SYS_NOTIFY_REQUESTER_STATUSES }[channel] || [];
    }
    if (type === 'feature' || type === 'improvement') {
      // 变更流无 relay 通道（对接人是 bug path B 专属）——relay 返空=永远拒绝。
      return { developer: SYS_NOTIFY_DEV_STATUSES_CHANGE, relay: [],
               creator: SYS_NOTIFY_CREATOR_STATUSES_CHANGE, requester: SYS_NOTIFY_REQUESTER_STATUSES_CHANGE }[channel] || [];
    }
    return [];   // 未知 type（含 config 未定）默认拒绝
  }

  // ── 交互优化 C2a：手动通知统一授权守卫（方案 §3.2 授权表 type×channel）──────────────────────
  //   返回 null=放行；返回 {status, body}=拒绝（handler 原样 res.status().json()）。
  //   ⭐ 角色权限重构 C1（用户 2026-07-27 拍板·方案 v1.5 §4-C1③）：**developer/creator/requester 三通道
  //     全类型统一为 admin ∨ 受理人[13]**，删掉原先"变更流仅 admin"的特判。
  //     理由：示例对接人既然全类型受理 + 全类型指派，"通知开发/建单人/报障人"是同一条协作动作的延续；
  //     留着特判会造出「能指派变更流开发、却不能通知他」的割裂。
  //     示例发布者[7] 同步失去这三个通道（他转纯技术负责人，只回一条评估留言）。
  //   授权表（C1 后）：
  //     bug / feature / improvement：developer/creator/requester = admin ∨ 受理人[13]
  //     relay = 仅 admin（bug）/ 永远拒绝（变更流·无对接人角色）——relay 通道**不随本次放开**，
  //            因为 C0 已关闭其唯一业务写入路径（path B 建单），该通道正在退场，不给它扩权。
  //     未知 type = 全部拒绝（默认拒绝）。
  //   ⚠️ H3 修正：creator 通道**不含**「主开发本人」——is_primary/assigned_to 禁作授权源（去主次核心）。
  //   注：self-guard（本人不给自己发）与 relay 收件人白名单复核等通道专属细节仍在各 handler 内单独处理，
  //   本守卫只统一「type 门限 + 角色授权」这一层。
  //   ⚠️ 通道白名单 fail-closed（codex C1 审 HIGH-1）：原实现只特判 relay、其余 channel 一律走"admin∨受理人"分支，
  //     是**结构性 fail-open**——将来新增通道（或调用方传错字符串）会被静默放行给受理人。
  //     现改为显式枚举：只有 SYS_MANUAL_NOTIFY_CHANNELS 里的通道才有判定，未知通道一律 400。
  const SYS_MANUAL_NOTIFY_CHANNELS = new Set(['developer', 'creator', 'requester', 'relay']);
  function sysManualNotifyGuard(issue, channel, actor) {
    const type = issue.type;
    const isAdmin = actor.role === 'admin';
    const isIntakeLiaison = isSysIntakeLiaison(actor.id);
    if (!SYS_MANUAL_NOTIFY_CHANNELS.has(channel)) {
      return { status: 400, body: { error: '未知通知通道', code: 'MANUAL_NOTIFY_CHANNEL_UNKNOWN' } };
    }
    // relay 通道：bug 仅 admin（该通道随 C0 关闭 path B 后正在退场·不给受理人扩权）；变更流本就没有该通道。
    if (channel === 'relay') {
      if (type === 'bug') {
        return isAdmin ? null : { status: 403, body: { error: '仅管理员可通知对接人', code: 'NOT_AUTHORIZED_FOR_NOTIFY' } };
      }
      if (type === 'feature' || type === 'improvement') {
        return { status: 400, body: { error: '变更流无对接人通知', code: 'MANUAL_NOTIFY_CHANNEL_NA' } };
      }
      return { status: 400, body: { error: '该类型暂不支持手动通知', code: 'MANUAL_NOTIFY_TYPE_NA' } };
    }
    // developer / creator / requester：C1 起**全类型统一** = admin ∨ 受理人[13]
    if (type === 'bug' || type === 'feature' || type === 'improvement') {
      return (isAdmin || isIntakeLiaison) ? null : { status: 403, body: { error: '仅管理员/受理人可发送该通知', code: 'NOT_AUTHORIZED_FOR_NOTIFY' } };
    }
    return { status: 400, body: { error: '该类型暂不支持手动通知', code: 'MANUAL_NOTIFY_TYPE_NA' } };   // 未知 type 默认拒绝
  }

  //   通知开发（逐 dev，通知改造 C3 G9 改造）：带 body.dev_user_id，定位子表活动行 (issue_id,user_id,removed_at IS NULL)，
  //   状态落子表行（notify_status 等 5 列）——主表 notify_*（dev 侧）自本端点起转只读回溯，只服务变更流自动派发（C1b 已回填）。
  router.post('/sys-issues/:id/notify-developer', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const devUserId = parsePositiveId((req.body || {}).dev_user_id);
    if (!devUserId) return res.status(400).json({ error: '缺少 dev_user_id', code: 'DEV_USER_ID_REQUIRED' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // 授权走统一守卫（C1 后 developer 通道 = 全类型 admin ∨ 受理人[13]；守卫另负责 type 门限与未知通道 fail-closed）。
      const devAuthErr = sysManualNotifyGuard(issue, 'developer', sysActor(req));
      if (devAuthErr) return res.status(devAuthErr.status).json(devAuthErr.body);
      const devStatuses = sysNotifyStatusesFor(issue.type, 'developer');
      if (!devStatuses.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知开发`, code: 'STATUS_NOT_NOTIFIABLE' });
      // 先查目标活动成员行（removed_at IS NULL），确认目标有效——放在自指判断之前（C2a·codex M1）：
      //   伪造/已移除的自己 ID 应先归类为 DEV_ASSIGNEE_NOT_FOUND，而非被自指守卫误判为 SELF_NOTIFY_FORBIDDEN。
      const devRow = await dbGetAsync(
        `SELECT id, user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL`,
        [id, devUserId]
      );
      if (!devRow) return res.status(409).json({ error: '该开发不在本单指派子表中（可能已被移除）', code: 'DEV_ASSIGNEE_NOT_FOUND' });
      // C2a 自指守卫：目标确认在册后，本人不能给自己发（仅 developer 通道）。
      if (Number(devUserId) === Number(sysActor(req).id)) {
        return res.status(403).json({ error: '不能给自己发送通知', code: 'SELF_NOTIFY_FORBIDDEN' });
      }
      const dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [devUserId]);
      if (!dev) return res.status(409).json({ error: '开发用户不存在', code: 'DEV_ASSIGNEE_NOT_FOUND' });
      // [ultracode devil MED] bug 打回返工后仍在「处理中」但 return_count>0 → 用返工模板（否则发陈旧「指派/请回填」误导；auto 路径原 return 的 notifyReturnedToDeveloper 被 bug 早返回吞掉，此处手动补偿）。
      //   [codex 复审 M-1·有意接受] 若「打回后改派新开发」（return_count 保留），新开发点通知也走返工模板——内容「查看打回原因·返工后重新提交」对新接手者仍成立（bug 确需返工），不引「被打回者本人」精判字段（避免为边角加 schema）。verify [Rework2] 锁定此语义。
      //   ⚠️ 逐 dev 后：主开发与协作开发共用同一 marker 判定（均基于 issue.return_count，非"谁被打回过"精判，同 Rework2 有意接受语义扩展到协作侧）。
      const marker = (Number(issue.return_count) > 0) ? 'notifyReturnedToDeveloper' : 'notifyAssignedDeveloper';
      const baseUrl = await getSafePlatformBaseUrl();
      const { title, md } = buildSysDevMarkdown(issue, marker, baseUrl);
      const result = await sendIssueDingtalkRaw(dev, title, md);
      await recordSysDevAssigneeNotify(id, devUserId, !!result.ok, result.message_key, result.reason);
      const fresh = await dbGetAsync('SELECT notify_status, notify_error FROM sys_issue_dev_assignees WHERE id = ?', [devRow.id]);
      res.json({ id, dev_user_id: devUserId, notify_status: fresh.notify_status, notify_error: fresh.notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知开发失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知开发失败' }); }
  });

  //   通知对接人（新，通知改造 C3 G7）：仅 admin（白名单成员亦不可发，§3.1 正交——对接人是通知目标非操作者）；
  //   收件人=relay_notified_user_id（path B 建单写入）；发送前复核仍在白名单（防常量表变更后的历史脏数据）。
  router.post('/sys-issues/:id/notify-relay', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // C2a：授权走统一守卫（relay 通道：bug=仅 admin / 变更流=永远拒绝 MANUAL_NOTIFY_CHANNEL_NA·无对接人角色）。
      const relayAuthErr = sysManualNotifyGuard(issue, 'relay', sysActor(req));
      if (relayAuthErr) return res.status(relayAuthErr.status).json(relayAuthErr.body);
      if (!issue.relay_notified_user_id) return res.status(409).json({ error: '该单未指定通知对接人', code: 'NO_RELAY_USER_TO_NOTIFY' });
      if (!isSysBugLiaison(issue.relay_notified_user_id)) return res.status(409).json({ error: '通知对接人已不在白名单，无法发送', code: 'RELAY_USER_NOT_WHITELISTED' });
      if (!SYS_NOTIFY_RELAY_STATUSES.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知对接人（仅待处理）`, code: 'STATUS_NOT_NOTIFIABLE' });
      const relayUser = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.relay_notified_user_id]);
      if (!relayUser) return res.status(409).json({ error: '通知对接人用户不存在', code: 'RELAY_USER_NOT_FOUND' });
      const baseUrl = await getSafePlatformBaseUrl();
      const { title, md } = buildSysRelayMarkdown(issue, baseUrl);
      const result = await sendIssueDingtalkRaw(relayUser, title, md);
      // ⭐ C0（codex 三轮审 MED-1）：带上**发起发送时**捕获的收件人做 CAS 围栏——若这期间单据被
      //   reactivate/resubmit 清空了 relay 目标（回受理门=新一轮），本次回写零命中，不污染新轮次。
      const rec = await recordSysRelayNotify(id, !!result.ok, result.message_key, result.reason, issue.relay_notified_user_id);
      if (!rec || rec.changes !== 1) {
        // 回写被围栏拒绝：单据已进入新一轮（relay 目标被清或换人）。不是错误，但要如实告知调用方，
        //   免得前端按"已发送"渲染——外部钉钉消息可能已实际送达，这一点由 §14 业务接受项承担。
        //   ⚠️ 不把 'superseded' 塞进 relay_notify_status（codex 四轮审 MED-2）：该字段是**持久化枚举**
        //     （not_sent/sent/failed），混入临时值会污染前端与后续读取方对枚举的假设。
        //     改用独立布尔 superseded + persisted=false 表达"本次投递未计入当前轮次"。
        logger.warn(`[系统迭代] notify-relay 回写被收件人围栏拒绝（单据已进入新一轮）：issue=${id}, 原收件人=${issue.relay_notified_user_id}`);
        const cur = await dbGetAsync('SELECT relay_notify_status FROM sys_issues WHERE id = ?', [id]);
        return res.json({
          id,
          superseded: true,
          persisted: false,
          relay_notify_status: cur ? cur.relay_notify_status : null,   // 当前真实落库值（不是本次结果）
          message: '该单已进入新一轮受理，本次通知未计入当前轮次；外部钉钉消息可能已送达',
        });
      }
      const fresh = await dbGetAsync('SELECT relay_notify_status, relay_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, relay_notify_status: fresh.relay_notify_status, relay_notify_error: fresh.relay_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知对接人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知对接人失败' }); }
  });

  //   通知建单人（新，通知改造 C3 G8）：权限=admin ∨ 受理人[13]（C1 起全类型统一）；self-guard 横切例外（M-2）——
  //   actor.id===created_by 一律不实际发送，返 200 {skipped:true, code:'SELF_NOTIFY_SKIPPED'}（非错误，前端淡提示）。
  //   ⚠️ **self-guard 按人不按角色**（2026-07-27 更正）：本段原写「因 native 建单 created_by 恒=admin，
  //     故 **admin 点此按钮总被跳过**」——后半句只在"系统里只有一个 admin"时成立，而生产实为 **6 个 active admin**。
  //     准确语义：**只有建单人本人触发才跳过**。admin A 建的单、admin B 点此按钮 → `actor.id !== created_by` →
  //     **不跳过、真发钉钉给 A**。实现（比 `actor.id` 与 `created_by`）本就正确，错的是这条注释与 verify 的单 admin 夹具。
  //     verify-sys-role-perm-c1 [M3] 已补 admin2 交叉用例锁定该语义。
  //   ⚠️ 中间件 requireIntakeLiaison（C1 复审 MED-1 补挂）：C1 前本端点刻意不挂角色中间件——授权表按 type 分叉
  //     （bug=admin∨对接人 / 变更流=仅 admin），中间件在 handler 前拿不到 issue 无法表达 type 差异。
  //     C1 把 creator 通道拍成**全类型 admin∨受理人**（与 type 无关）后，该理由消失，而"不挂"留下一个
  //     **单据存在性预言机**：无权用户打不存在的 id 得 404、打存在的 id 得 403，可枚举出哪些单据号真实存在
  //     （notify-developer / notify-requester 因有中间件一律 403，无此差异）。补挂后与另两通道对齐。
  //     中间件放行面（admin ∨ 受理人）与 handler 内 sysManualNotifyGuard 的 creator 通道判定**逐格等价**，
  //     故对合法调用者零行为变更；guard 仍保留，负责 type 门限 / 未知通道 / 状态校验。
  router.post('/sys-issues/:id/notify-creator', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const actor = sysActor(req);
      // 授权走统一守卫（C1 后 creator 通道 = 全类型 admin ∨ 受理人[13]）。
      //   ⚠️ H3 修正：**删除原「主开发本人（isPrimaryDev）」放权**——is_primary/assigned_to 禁作授权源（去主次核心），
      //   bug 主开发不再能发建单人通知（用户拍板接受收窄，与去主次一致）。查已读侧 notify-read-status 同步删（写读同源）。
      const creatorAuthErr = sysManualNotifyGuard(issue, 'creator', actor);
      if (creatorAuthErr) return res.status(creatorAuthErr.status).json(creatorAuthErr.body);
      // self-guard 优先于状态闸门（M-2 横切例外：无论状态如何，本人恒不实际发送）
      if (Number(actor.id) === Number(issue.created_by)) {
        return res.json({ id, skipped: true, code: 'SELF_NOTIFY_SKIPPED' });
      }
      const creatorStatuses = sysNotifyStatusesFor(issue.type, 'creator');
      if (!creatorStatuses.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知建单人`, code: 'STATUS_NOT_NOTIFIABLE' });
      const creator = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.created_by]);
      if (!creator) return res.status(409).json({ error: '建单人用户不存在', code: 'CREATOR_NOT_FOUND' });
      const baseUrl = await getSafePlatformBaseUrl();
      const { title, md } = buildSysCreatorMarkdown(issue, baseUrl);
      const result = await sendIssueDingtalkRaw(creator, title, md);
      await recordSysCreatorNotify(id, !!result.ok, result.message_key, result.reason);
      const fresh = await dbGetAsync('SELECT creator_notify_status, creator_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, creator_notify_status: fresh.creator_notify_status, creator_notify_error: fresh.creator_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知建单人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知建单人失败' }); }
  });

  //   通知上线开发（release_assignee 侧，通知改造 follow-up 2026-07-07）：admin 指定上线执行开发后手动通知其执行 hotfix/发版。
  //   权限=仅 admin（与 assign-release-dev 一致，谁指定谁通知）；须已指定 release_assignee_id + 状态=待上线。byId 发送（无 phone 快照）。
  router.post('/sys-issues/:id/notify-release-executor', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      if (issue.type !== 'bug') return res.status(400).json({ error: '手动通知仅用于 bug 单', code: 'MANUAL_NOTIFY_BUG_ONLY' });
      if (!issue.release_assignee_id) return res.status(409).json({ error: '该单未指定上线开发，请先「指定上线开发」', code: 'NO_RELEASE_ASSIGNEE_TO_NOTIFY' });
      if (!SYS_NOTIFY_RELEASE_EXECUTOR_STATUSES.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知上线开发（仅待上线）`, code: 'STATUS_NOT_NOTIFIABLE' });
      const executor = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.release_assignee_id]);
      if (!executor) return res.status(409).json({ error: '上线开发用户不存在', code: 'RELEASE_ASSIGNEE_NOT_FOUND' });
      const baseUrl = await getSafePlatformBaseUrl();
      const { title, md } = buildSysReleaseExecutorMarkdown(issue, baseUrl);
      const result = await sendIssueDingtalkRaw(executor, title, md);
      await recordSysReleaseExecutorNotify(id, !!result.ok, result.message_key, result.reason);
      const fresh = await dbGetAsync('SELECT release_assignee_notify_status, release_assignee_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, release_assignee_notify_status: fresh.release_assignee_notify_status, release_assignee_notify_error: fresh.release_assignee_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知上线开发失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知上线开发失败' }); }
  });

  // ── POST /sys-issues/notify-release-executor-batch：批量通知上线开发（admin，模型B 同执行人合并一条）──────────
  //   两步流后端强制②态（H-2）：仅 type='bug' + status='待上线' + release_assignee_id 非空 +
  //     COALESCE(notify_status,'not_sent') IN ('not_sent','failed') 可通知；已通知(sent)→ALREADY_NOTIFIED（不进发送分组）。
  //   按 release_assignee_id 分组，跨执行人各发一条合并 markdown；发送(sendIssueDingtalkRaw)在锁外，仅按组守卫 UPDATE
  //     进 sysNotifyWriteRun 短事务（②态闸 + release_assignee_id + status 三重 WHERE 防 TOCTOU）；未命中(changes<组内数)→
  //     concurrent_changed（合并钉钉已尝试发送、落库前该行被并发改派/离态、本行未记结果，前端不无脑重发）。
  //   L-1：单条端点 notify-release-executor 有意保持现状不加②态闸（sent 单详情重发保留）——仅本批量端点强制②态。
  router.post('/sys-issues/notify-release-executor-batch', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const raw = b.issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要通知的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    try {
      const baseUrl = await getSafePlatformBaseUrl();
      const idPh = issueIds.map(() => '?').join(',');
      const rows = await dbAllAsync(
        `SELECT id, type, status, title, system_name, release_assignee_id,
                COALESCE(release_assignee_notify_status,'not_sent') AS notify_status
           FROM sys_issues WHERE id IN (${idPh})`, issueIds);
      const byId = new Map(rows.map(r => [r.id, r]));

      // 逐单资格分类（H-2 后端强制②态）：skipped / ALREADY_NOTIFIED / 进入按执行人分组
      const resultMap = new Map();
      const eligibleByDev = new Map();   // release_assignee_id → [row...]
      for (const iid of issueIds) {
        const r = byId.get(iid);
        if (!r || r.type !== 'bug' || r.status !== '待上线' || !r.release_assignee_id) { resultMap.set(iid, { id: iid, code: 'skipped' }); continue; }
        if (r.notify_status === 'sent') { resultMap.set(iid, { id: iid, code: 'ALREADY_NOTIFIED' }); continue; }
        if (r.notify_status !== 'not_sent' && r.notify_status !== 'failed') { resultMap.set(iid, { id: iid, code: 'skipped' }); continue; }   // 兜底（schema CHECK 保证不可达）
        const devId = Number(r.release_assignee_id);
        if (!eligibleByDev.has(devId)) eligibleByDev.set(devId, []);
        eligibleByDev.get(devId).push(r);
      }

      // 按执行人分组：查执行人 → 建合并 markdown → 发一条 → 按组守卫 UPDATE → 据 changes(+回读) 生成每单结果
      for (const [devId, groupRows] of eligibleByDev) {
        const groupIds = groupRows.map(r => r.id);
        const executor = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [devId]);
        let ok = false, messageKey = null, sendErr = null;
        if (!executor) {
          sendErr = 'executor_not_found';   // 执行人查不到 → 组内全 failed（守卫 UPDATE 落 failed）
        } else {
          const { title, md } = buildSysReleaseExecutorBatchMarkdown(groupRows, baseUrl);
          const sendResult = await sendIssueDingtalkRaw(executor, title, md);   // 锁外网络调用
          ok = !!sendResult.ok; messageKey = ok ? sendResult.message_key : null; sendErr = ok ? null : (sendResult.reason || 'other');
        }
        const gph = groupIds.map(() => '?').join(',');
        // 守卫 UPDATE 的 WHERE 与分类读侧完全同源（type='bug' + status='待上线' + release_assignee_id + ②态）——
        //   codex H-1 [[write_read_same_semantic]]：type 现不可变（无端点改 sys_issues.type）故写侧漏 type 当前不可达，
        //   但读侧分类带了 type='bug'，写侧同源加固防未来加 type 编辑路径破防（零成本）。
        const upd = await sysNotifyWriteRun(
          `UPDATE sys_issues SET release_assignee_notify_status=?, release_assignee_notified_at=datetime('now','localtime'),
             release_assignee_notify_message_key=?, release_assignee_notify_error=?, release_assignee_read_at=NULL
           WHERE id IN (${gph}) AND type = 'bug' AND release_assignee_id=? AND status='待上线'
             AND COALESCE(release_assignee_notify_status,'not_sent') IN ('not_sent','failed')`,
          [ok ? 'sent' : 'failed', messageKey, sendErr, ...groupIds, devId]);
        const targetStatus = ok ? 'sent' : 'failed';
        if (upd && upd.changes === groupIds.length) {
          // 全部命中（无并发）：直接标结果，免回读
          for (const iid of groupIds) resultMap.set(iid, { id: iid, code: targetStatus, release_assignee_notify_status: targetStatus });
        } else {
          // 部分命中：回读按当前态判「命中(sent/failed)」vs「并发改动(concurrent_changed)」。
          //   hit 判定条件与守卫 UPDATE 的 WHERE 完全同源（type/release_assignee_id/status/notify_status）+ sent 再比对
          //   message_key（本次发送唯一标识）。failed 分支无 message_key 唯一标识（codex M-1）：低并发下，
          //   守卫 UPDATE 经 sysBeginImmediate 全局锁串行、reread 紧随其后，未命中行必因 type/assignee/status/notify_status
          //   某项在 UPDATE 时不匹配——该项若仍不匹配（如改派→id 变、离态→status 变）reread 即判 concurrent_changed；
          //   要误判"命中"须该行状态在 UPDATE 与 reread 之间恰好翻回匹配态（多写者竞态）。
          //   ⚠️ **论据失效（2026-07-27 核实·本段原写"单 admin 场景不存在"）**：生产实为 **6 个 active admin**，
          //     多写者竞态**不再是"不存在"，而是"低概率"** —— 6 人可并发跑批量通知，理论上存在
          //     "A 的 UPDATE 与 reread 之间，B 把该行改走又改回"导致本次把 B 的写入误判为自己命中的窗口。
          //     **未改代码**（真正的修法是给每次批量尝试生成 attempt_id 写入条件更新、或用 UPDATE...RETURNING 直接取命中 ID，
          //     属设计变更）。用户 2026-07-27 判定 6 个 admin 均为数据/信息部门自己人、可信 → 定级 **P2 待办**，
          //     触发修 = 真出现并发批量通知的归因错乱。见 PROJECT_STATUS backlog。
          const fresh = await dbAllAsync(
            `SELECT id, type, release_assignee_id, status, release_assignee_notify_status AS ns, release_assignee_notify_message_key AS mk
               FROM sys_issues WHERE id IN (${gph})`, groupIds);
          const freshById = new Map(fresh.map(f => [f.id, f]));
          for (const iid of groupIds) {
            const f = freshById.get(iid);
            const hit = f && f.type === 'bug' && Number(f.release_assignee_id) === devId && f.status === '待上线' && f.ns === targetStatus
              && (ok ? f.mk === messageKey : true);
            if (hit) resultMap.set(iid, { id: iid, code: targetStatus, release_assignee_notify_status: f.ns });
            else resultMap.set(iid, { id: iid, code: 'concurrent_changed', release_assignee_notify_status: f ? f.ns : null });
          }
        }
      }

      const results = issueIds.map(iid => resultMap.get(iid));
      const agg = { sent: 0, failed: 0, skipped: 0, already_notified: 0, concurrent_changed: 0 };
      for (const r of results) {
        if (r.code === 'sent') agg.sent++;
        else if (r.code === 'failed') agg.failed++;
        else if (r.code === 'skipped') agg.skipped++;
        else if (r.code === 'ALREADY_NOTIFIED') agg.already_notified++;
        else if (r.code === 'concurrent_changed') agg.concurrent_changed++;
      }
      res.json({ results, ...agg });
    } catch (err) {
      logger.error('[系统迭代] 批量通知上线开发失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批量通知上线开发失败' });
    }
  });

  //   通知报障人（requester 侧 requester_notify_*，进展/已上线卡片）：需有报障人手机号（sendSysRequesterNotify 内亦有"无报障人保持 not_sent"守卫）。
  //   [M-A 两套规则] 首发依赖当前 requester_phone；已发送过（快照非空）后重发不受当前 requester_phone 是否为空限制。
  router.post('/sys-issues/:id/notify-requester', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // 授权走统一守卫（C1 后 requester 通道 = 全类型 admin ∨ 受理人[13]）。
      const reqAuthErr = sysManualNotifyGuard(issue, 'requester', sysActor(req));
      if (reqAuthErr) return res.status(reqAuthErr.status).json(reqAuthErr.body);
      const reqStatuses = sysNotifyStatusesFor(issue.type, 'requester');
      if (!reqStatuses.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知报障人`, code: 'STATUS_NOT_NOTIFIABLE' });   // 排终态矛盾卡片（复审）+ F3 收窄（去处理中）
      // M-A：快照非空=已发送过，允许重发（不看当前 phone）；快照空=首发，须当前 phone 非空
      if (!issue.requester_notify_phone_snapshot && !issue.requester_phone) {
        return res.status(409).json({ error: '无报障人手机号，无法通知', code: 'NO_REQUESTER_PHONE' });   // 显式前置拦（避免误落 failed）
      }
      const baseUrl = await getSafePlatformBaseUrl();
      const kind = issue.status === '已上线' ? 'released' : 'progress';   // 已上线走 released（带版本，release_id=NULL 时 sendSysRequesterNotify 优雅降级无版本行），否则 progress（当前状态）
      await sendSysRequesterNotify(issue, kind, baseUrl);   // 落库 requester_notify_*（含快照，H-5/M-A）
      const fresh = await dbGetAsync('SELECT requester_notify_status, requester_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, requester_notify_status: fresh.requester_notify_status, requester_notify_error: fresh.requester_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知报障人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知报障人失败' }); }
  });

  // ── GET /sys-issues/:id/notify-read-status（新，通知改造 C3 G11）：byId(dev/relay/creator)+byPhone(requester) 双寻址 ──
  //   复刻 issue-tracker /api/issues/:id/notify-read-status 范式（server.js:11552，token 重试+已读固化写回）。
  //   dev 定位子表活动行（?dev_user_id=）；relay/creator 走 sys_issues 反规范化列；requester 走收件人快照反查。
  // [M-1 收口·codex40] 权限闸：原仅 authenticateToken，任意登录用户可探任意单四侧通知触达/已读时间（越权泄露）。
  //   in-handler 检查（非中间件）：本端点是**多通道复用**的（?type=dev|relay|creator|requester|release_executor），
  //   各通道授权面不同（前三 = admin∨受理人 / 后两 = 仅 admin），中间件层表达不了逐通道差异，故在 handler 内
  //   按 query.type 映射到发送侧同一个 sysManualNotifyGuard（写读同源·C2a·H3 已一并删除「主开发本人」放权）。
  router.get('/sys-issues/:id/notify-read-status', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const type = req.query.type;
    if (!['dev', 'relay', 'creator', 'requester', 'release_executor'].includes(type)) {
      return res.status(400).json({ error: '无效的通知类型', code: 'INVALID_NOTIFY_TYPE' });
    }
    // ⚠️ 单据存在性预言机防线（C1 三轮审 MED-1·与 notify-creator 补挂中间件同构）：本端点的授权原本**全部**在
    //   issue 加载之后，于是未授权者打不存在的 id 得 404、打存在的 id 得 403 —— 可据此枚举真实单号。
    //   这里前置一道**静态角色粗筛**：它只用 JWT 身份 + query 通道，不需要 issue 上下文，因此能放到查库之前，
    //   让"存在"与"不存在"对未授权者一律 403。
    //   ⚠️ 放行面必须与下方 sysManualNotifyGuard / release_executor 分支**逐通道等价**（改一处必同步另一处）：
    //     dev / creator / requester = admin ∨ 受理人[13]；relay / release_executor = 仅 admin。
    //   精判（issue.type 门限 / 通道 NA / 状态 / 收件人快照）仍由 issue 加载后的 guard 承担——本层只回答
    //   "这个角色连这个通道都碰不到吗"，不回答"这张单此刻能不能查"。错误码沿用 NOT_AUTHORIZED_FOR_NOTIFY 不变。
    {
      const preActor = sysActor(req);
      const preAdminOnly = (type === 'relay' || type === 'release_executor');
      const prePermitted = preActor.role === 'admin' || (!preAdminOnly && isSysIntakeLiaison(preActor.id));
      if (!prePermitted) {
        return res.status(403).json({
          error: preAdminOnly ? '仅管理员可查看该通知已读状态' : '仅管理员/受理人可查看通知已读状态',
          code: 'NOT_AUTHORIZED_FOR_NOTIFY',
        });
      }
    }
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // C2a·codex L1：未知 issue.type 统一先拒（400 MANUAL_NOTIFY_TYPE_NA，与发送端点错误码一致；不再用"变更流"文案误标）。
      if (!['bug', 'feature', 'improvement'].includes(issue.type)) {
        return res.status(400).json({ error: '该类型暂不支持通知查已读', code: 'MANUAL_NOTIFY_TYPE_NA' });
      }
      // C2a·codex M2：查已读改**逐通道**授权（与发送侧 sysManualNotifyGuard 完全写读同源），非仅单据级 type 判——
      //   否则 bug 对接人能查 relay 已读，但 relay 发送仅 admin（漏格）。query.type(通道) 映射到 guard 的 channel。
      //   release_executor 无发送 guard 映射（独立端点·仅 admin），单独按 admin 判。
      //   ⚠️ H3：guard 内 creator 通道已不含「主开发本人」，故查已读侧天然同步删（写读同源）。
      const rsActor = sysActor(req);
      const rsChannelMap = { dev: 'developer', relay: 'relay', creator: 'creator', requester: 'requester' };
      let rsAuthErr;
      if (type === 'release_executor') {
        rsAuthErr = (rsActor.role === 'admin') ? null : { status: 403, body: { error: '仅管理员可查看上线开发通知已读状态', code: 'NOT_AUTHORIZED_FOR_NOTIFY' } };
      } else {
        rsAuthErr = sysManualNotifyGuard(issue, rsChannelMap[type], rsActor);
      }
      if (rsAuthErr) return res.status(rsAuthErr.status).json(rsAuthErr.body);

      let notifyStatus, messageKey, readAt, devRowId = null, devUserId = null;
      if (type === 'dev') {
        devUserId = parsePositiveId(req.query.dev_user_id);
        if (!devUserId) return res.status(400).json({ error: '缺少 dev_user_id', code: 'DEV_USER_ID_REQUIRED' });
        const row = await dbGetAsync(
          `SELECT id, notify_status, notify_message_key, read_at FROM sys_issue_dev_assignees
            WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL`,
          [id, devUserId]
        );
        if (!row) return res.status(404).json({ error: '该开发不在本单指派子表中', code: 'DEV_ASSIGNEE_NOT_FOUND' });
        notifyStatus = row.notify_status; messageKey = row.notify_message_key; readAt = row.read_at; devRowId = row.id;
      } else if (type === 'relay') {
        notifyStatus = issue.relay_notify_status; messageKey = issue.relay_notify_message_key; readAt = issue.relay_read_at;
      } else if (type === 'creator') {
        notifyStatus = issue.creator_notify_status; messageKey = issue.creator_notify_message_key; readAt = issue.creator_read_at;
      } else if (type === 'release_executor') {
        notifyStatus = issue.release_assignee_notify_status; messageKey = issue.release_assignee_notify_message_key; readAt = issue.release_assignee_read_at;
      } else {
        notifyStatus = issue.requester_notify_status; messageKey = issue.requester_notify_message_key; readAt = issue.requester_read_at;
      }

      if (notifyStatus !== 'sent' || !messageKey) {
        return res.status(400).json({ error: '尚未成功发送该通知', code: 'NOTIFY_NOT_SENT', read: false });
      }
      // 已固化 → 直接返（钉钉无取消已读语义，不再查）
      if (readAt) return res.json({ type, read: true, read_at: readAt, cached: true });

      // requester 快照前置校验（先于钉钉配置获取——"根本没有收件人标识可查"比"钉钉配置缺失"更根本，
      //   fail fast 不浪费一次配置/token 往返；H-5/§6.1：查已读用快照，非当前 requester_phone；
      //   status='sent' 却快照空 = 历史迁移前旧数据，生产 0 行不可达，测试库可造样本验证）。
      let requesterSnapshotPhone = null;
      if (type === 'requester') {
        requesterSnapshotPhone = issue.requester_notify_phone_snapshot;
        if (!requesterSnapshotPhone) {
          return res.status(400).json({ error: '业务方手机号快照缺失，无法查已读（历史记录无快照）', code: 'HISTORICAL_SNAPSHOT_MISSING', read: false });
        }
      }

      const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
      if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写', code: 'NO_DINGTALK_CONFIG' });
      let token;
      try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }

      let recipientDingUid = '';
      if (type === 'requester') {
        try {
          const raw = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getUserIdByMobile(t, requesterSnapshotPhone));
          recipientDingUid = raw != null ? String(raw).trim() : '';
        } catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: '业务方钉钉号查询失败：' + cls.hint, reason: cls.reason }); }
      } else {
        const uid = type === 'dev' ? devUserId : (type === 'relay' ? issue.relay_notified_user_id : (type === 'release_executor' ? issue.release_assignee_id : issue.created_by));
        const u = await dbGetAsync('SELECT dingtalk_user_id FROM users WHERE id = ?', [uid]);
        recipientDingUid = u && u.dingtalk_user_id ? String(u.dingtalk_user_id).trim() : '';
      }
      if (!recipientDingUid) return res.json({ type, read: false, read_at: null, read_status: 'recipient_unresolved' });

      let readResult;
      try { readResult = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getReadStatus(t, robotCode, messageKey)); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }

      const myEntry = (readResult.readDetails || []).find(d => String(d.userId).trim() === recipientDingUid && d.readStatus === 'READ');
      const isRead = !!myEntry;
      let readAtStr = null;
      if (isRead) {
        // codex 12 M-3：readTimestamp 单位兼容归一（不凭印象 *1000）——>1e12 视为毫秒、>1e9 视为秒
        const ts = Number(myEntry.readTimestamp) || 0;
        const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : Date.now());
        readAtStr = new Date(ms).toLocaleString('zh-CN');
        if (type === 'dev') {
          await sysNotifyWrite('UPDATE sys_issue_dev_assignees SET read_at = ? WHERE id = ?', [readAtStr, devRowId]);
        } else {
          const col = type === 'relay' ? 'relay_read_at' : (type === 'creator' ? 'creator_read_at' : (type === 'release_executor' ? 'release_assignee_read_at' : 'requester_read_at'));
          await sysNotifyWrite(`UPDATE sys_issues SET ${col} = ? WHERE id = ?`, [readAtStr, id]);
        }
      }
      res.json({ type, read: isRead, read_at: readAtStr, read_user_count: (readResult.readUserIds || []).length });
    } catch (err) {
      logger.error('[系统迭代] 查已读状态失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '查已读状态失败' });
    }
  });

  // ============================================================
  // 四、导出（_internals 供 verify require 真实逻辑，RC-L2）
  // ============================================================
  const _internals = {
    SYS_SCHEMA_STATE,
    // 角色权限重构 C0：受理态一致性触发器（供 verify 临时摘除后按原样重建·防两处 DDL 漂移）
    SYS_INTAKE_GATE_TRIGGERS_SQL,
    SYS_INTAKE_GATE_TRIGGER_NAMES,
    // 角色权限重构 C1：手动通知授权守卫（verify 直调做通道白名单 fail-closed 单元断言）
    sysManualNotifyGuard,
    SYS_REQUIRED_TABLES,
    SYS_ISSUES_KEY_COLS,
    SYS_RELEASES_KEY_COLS,
    SYS_TIMELINE_KEY_COLS,
    SYS_ATTACHMENTS_KEY_COLS,
    SYS_DEV_ASSIGNEES_KEY_COLS,   // 通知改造 C1a 新表锚点（C0 起追加 dev_status 四态 4 列）
    // C0（多开发协作与 commit 留痕重构 v2.9）新增 3 表锚点（verify-sys-multidev-schema 等 require 真实逻辑）
    SYS_DEV_COMMITS_KEY_COLS,
    SYS_DEV_EVENTS_KEY_COLS,
    SYS_RELEASE_COMMIT_SNAPSHOTS_KEY_COLS,
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
    // C6：发布冻结快照（verify-sys-multidev-snapshots require 真实逻辑，RC-L2 防复刻漂移；
    //   直测 ON CONFLICT(release_id,issue_id) DO NOTHING 的幂等/changes=0 分支，业务状态机正常路径
    //   不可达二次发布，需绕开 HTTP 层直调本函数验证 SQL 层不变量）
    snapshotReleaseCommitsInTxn,
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
    // requireAdminOrBugLiaison 已随 C1 删除（见其定义处说明）——刻意不再导出，防误挂新端点
    // 受理排期改造 C2：三白名单（verify-sys-liaison 扩·require 真实逻辑防字面量漂移 + 权限单元级回归）
    SYS_INTAKE_LIAISON_IDS,
    SYS_TECH_LEAD_IDS,
    isSysIntakeLiaison,
    isSysTechLead,
    requireIntakeLiaison,
    recordSysTechLeadNotify,   // C5：技术负责人通知条件落库（verify 直测 request_event_id 拒过期回写 changes=0）
    // [C3] applyDevAssigneeDiff 已删除（见函数体退场注释）；resolveCollaboratorList 保留（W01 path A + 新版
    //   /assign 仍用，verify-sys-dev-assignee-transition require 真实逻辑）。
    resolveCollaboratorList,
    // C2（多开发协作与 commit 留痕重构 v2.9）：成员 API + supersede + 选举 + W-GATE（verify-sys-multidev-members require 真实逻辑）
    assertMainStatusTransition,
    electRepresentative,
    runWGate,
    insertDevEvent,
    addOrReaddMembers,
    fetchActiveDevAssignees,
    assertKnownIssueStatus,
    assertMemberActionFamilyAllowed,
    isSysCoordinator,
    MEMBER_ACTION_FAMILY_MATRIX,
    MEMBER_ACTION_FAMILY_TYPE_OVERRIDE,   // C2c·codex115 MED：reassign type 级族门覆盖（变更流排除 D_PRE / bug 保留）
    memberActionFamiliesFor,               // type 感知取族门（verify [6] 写读同源断言 + 端点同源读此）
    DEV_ASSIGNEES_SELECT_COLS,
  };

  return { initSchema, router, _internals };
};
