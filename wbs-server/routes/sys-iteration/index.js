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
    'sys_schema_migrations',
    // ← 角色权限重构 C2a：物删审计表。**必须进 readiness 硬清单**——它不在就意味着"删了查不到"，
    //   而删除是不可逆的；宁可整个 sys 写入口 503，也不放行一个审计写不进去的删除端点。
    'sys_issue_delete_audit',
    // ← 上线体统一重构 C0（方案 v3.4 §6.2，2026-07-28）：上线值班排班表。**全新表**（软删 CHECK
    //   含 removed_by_name IS NOT NULL 是 C0 硬门槛——SQLite 已建表无法补 CHECK，见 initSchema 2.11 段）。
    'sys_release_duty_roster',
    // ← 上线执行人多选与多人双确认（方案 20260806 v1.7 §4.1，C0）：执行人子表，批次可多人、逐人一行、
    //   代次由行 id 承载（§4.1a，不加 gen 列）。**全新表**，CHECK 一次到位（见 initSchema 2.12 段）。
    'sys_release_executors'];

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
    // ← 通知改造 C3b/C4 锚点：release_assignee_id/name 在 C1a 时确为纯数据列（不入锚点），后成**被消费的热路径列**
    //   ——须入锚点（[2026-07-30] 旧上线编排家族封禁后写端点已死，但列表 GET SELECT + 详情只读展示仍读这两列，
    //   锚点保留），否则 mid-migration 崩溃后
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
    // ← 角色权限重构 v2.1（C2.5 撤销·§4 OA 生命周期）锚点：oa_number 是**被消费的热路径列**——
    //   set-oa-number 的 SET 写它、assign 的 OA 前置守卫与列表/详情 SELECT 读它，mid-migration 崩溃
    //   （列未补）会让这些语句撞 no such column → 500（同 release_assignee_id / gate_deferred_at 先例）。
    'oa_number',
    // ← 建单优化批 C1（方案 20260731_v1.2 §3/§4）锚点：intake_liaison_id 是**被消费的热路径列**——
    //   三创建入口写它 + notify-intake/notify-read-status 读它 + 详情 SELECT * 展示它，mid-migration
    //   崩溃（列未补）会让这些语句撞 no such column → 500（同 oa_number/gate_deferred_at 先例）。
    //   intake_notify_status 是 NOT NULL 列，同 relay/tech_lead_notify_status 先例整组通知列以 status
    //   锚点代表入 readiness（其余 intake_notify_* 由 verify-sys-schema 全量保障）。
    'intake_liaison_id', 'intake_notify_status',
    // ← 建单优化批 C3b（方案 20260801_v1.3 §6c）锚点：oa_exempt 是**被消费的热路径列**——三创建入口写它
    //   （主建单按提交值/衍生入口恒 0）+ assertSysDevCommitmentOaGuard 的 SELECT 读它做放行判定，
    //   mid-migration 崩溃（列未补）会让这些语句撞 no such column → 500（同 oa_number/intake_liaison_id 先例）。
    'oa_exempt',
    // ← C1（工期对接测试与风险等级拆分 方案 v1.0 §4/§10）锚点：**本 commit 是纯 schema commit**
    //   （族常量+ALTER+CHECK 探针，C1 范围声明不接线端点/GATE/guard），本组列此刻尚无消费者——整组
    //   预锚点入 readiness（同 SYS_RELEASES_KEY_COLS「上线体统一重构 C0」/release_assignee_notify_* 先例：
    //   "纯 schema commit 仍先整组入锚，避免后续接线 commit 忘记补锚点"）。liaison_test_cycle_no=§3.0
    //   决策树⑦周期自增核心锚点、estimated_effort_days/risk_level=评估/受理闸门核心锚点（C2/C4 接线）；
    //   liaison_test_notify_* 通知列组（除 notify_sent_by）整组入锚——§6 预占协议的 status/token/
    //   started_at/cycle_no/recipient 是同一条 CAS 的原子写入单元，缺任一列会让该 CAS 编译期撞
    //   no such column，采 release_assignee_notify_*/SYS_RELEASES_KEY_COLS「整组」口径（而非 relay/
    //   intake「只锚 status」口径——那两侧无 token 预占协议，语义更简单）；notify_sent_by 不入锚点，
    //   同 notify_sent_by/intake_notify_sent_by/release_assignee_notify_sent_by 先例（sent_by 类列
    //   历来只由 verify-sys-schema 全量保障，不进 readiness 抽样锚点）。
    'estimated_effort_days', 'risk_level', 'liaison_test_cycle_no',
    'liaison_test_recipient_id', 'liaison_test_recipient_name', 'liaison_test_notify_status',
    'liaison_test_notified_at', 'liaison_test_notify_message_key', 'liaison_test_notify_error',
    'liaison_test_read_at', 'liaison_test_notify_cycle_no', 'liaison_test_attempt_token',
    'liaison_test_attempt_started_at',
    // ← [codex 291 号 H-1 收口] liaison_test_attachment_watermark：runWGate ⑦ 同一 CAS 原子写入、pass
    //   凭证判定热读，同组其余 liaison_test_* 列一样"被消费的热路径列"，须入锚点（同 §156 整组入锚说明）。
    'liaison_test_attachment_watermark',
    // ← ⭐ [C9-fix M2①] online_source：**被消费的热路径列**，须入锚点——理由与 gate_deferred_at 同款
    //   （:132-135 那条"runWGate/estimate/... 均读写此列，属被消费的热路径列"）：本列被 **列表端点的
    //   显式列投影 SELECT 直接取出**（GET /sys-issues 的 `origin_issue_id, release_id, needs_release,
    //   online_source` 那一行）供 deriveOnlineSourceKind 逐行派生，是每次开列表页都会跑的最热路径。
    //   mid-migration 崩溃（key 列已补、本列未补）会让 readiness 误报 ready → 列表 SELECT 撞
    //   `no such column: online_source` → 整个列表页 500（正是 release_assignee_id 当年入锚的同一场景，
    //   见 :121-124 收口注释）。
    //   ⚠️ 本条推翻了 C9 编码期"纯数据列不入 KEY_COLS"的裁定——那条裁定成立的前提是"只在 SELECT * 里
    //   顺带被读到"，而列表端点是显式列投影，前提不成立。判定标准始终是"有没有 SQL 显式点名它"，
    //   不是"它是不是新列/是不是纯展示"。
    'online_source',
  ];
  const SYS_RELEASES_KEY_COLS = ['release_no', 'status', 'is_hotfix', 'release_note', 'version_tag',
    'release_type',   // ← bug 流 Commit ① 批次类型隔离锚点（[codex三审:L] 值域非空由 ② 服务端守卫强制，readiness 只查列在）
    // ← 上线体统一重构 C0（方案 v3.4 §6.1，2026-07-28）新增 10 列，整组入锚点（同 release_assignee_notify_*
    //   在 sys_issues 侧的先例：被消费的热路径列，mid-migration 崩溃后半成品态会致端点 500，须整组锚定；
    //   本 C0 是纯 schema commit，这些列本身尚无消费者，仍先整组入锚，避免后续接线 commit 忘记补锚点）。
    'release_assignee_id', 'release_assignee_name', 'release_assignee_notify_status',
    'release_assignee_notify_started_at', 'release_assignee_notified_at',
    'release_assignee_notify_message_key', 'release_assignee_notify_error',
    'release_assignee_notify_token', 'release_assignee_read_at', 'release_kind'];
  const SYS_TIMELINE_KEY_COLS = ['event_type', 'from_status', 'to_status', 'action_code', 'ref_id', 'round_no',
    'payload_json'];   // ← [codex 291 号 H-2 收口] liaison_test_pass 写点热读列，同 §156 一带"整组入锚"哲学
  const SYS_ATTACHMENTS_KEY_COLS = ['attachment_type', 'round_no', 'status'];
  // ← 通知改造 C1a 新表锚点（bug流通知改造_方案_20260703_v1.5.md §4.1）。sys_issue_dev_assignees 是**一次性
  //   CREATE TABLE（无 ALTER 路径）**——要么整表建全要么不存在，故 readiness 用"结构全列在"模型（非 sys_issues 那种
  //   ALTER 演进表的抽样锚点）：缺任一结构列=建表未完整→[2] 判 ready=false。**列集 = [1c] 迁移依赖全列（SELECT+INSERT
  //   触达列），并与 [1c] 的 devAssigneesSchemaReady guard 同源**（guard 直接 .every 引用本常量），杜绝 guard/锚点/INSERT
  //   三处列集漂移（通知改造批1 集成审收口：codex MEDIUM + ultracode 五视角 #5/#6）。
  const SYS_DEV_ASSIGNEES_KEY_COLS = ['issue_id', 'user_id', 'user_name', 'is_primary', 'notify_status',
    'notified_at', 'read_at', 'notify_message_key', 'notify_error', 'removed_at',
    // ← C2b（角色权限重构）ALTER 追加：notify_sent_by（逐 dev 通知的操作者）。本表是"结构全列在"模型，
    //   新列必须同步入锚点，否则"表在但缺该列"会被判 ready，随后写入撞 no such column → 通知端点 500。
    'notify_sent_by',
    // ← C0（多开发协作与 commit 留痕重构 v2.9 §9/附录C）ALTER 追加 4 列：dev_status 四态 + resolved_at + no_code_reason + superseded_by。
    //   本表由「全新表」范式（无 ALTER）首次破例引入 ALTER 演进——C-1 顺序铁律同样适用：ALTER 必须在下方
    //   [2] 复查之前完成（见 runSysMigration [1a-4]）。
    'dev_status', 'resolved_at', 'no_code_reason', 'superseded_by'];
  // ── 上线体统一重构 C0（方案 v3.4 §6.2，2026-07-28）：排班表锚点，「结构全列在」模型 ────────────────────
  //   同 sys_issue_delete_audit 首版一样：**一次性 CREATE TABLE（无 ALTER 路径）**——软删成组 CHECK
  //   （含 removed_by_name IS NOT NULL）是 C0 硬门槛，SQLite 已建表无法补 CHECK，本表建表即终版。
  //   缺任一结构列=建表未完整→[2] 判 ready=false。
  const SYS_DUTY_ROSTER_KEY_COLS = ['duty_date', 'user_id', 'user_name', 'created_by',
    'removed_at', 'removed_by', 'removed_by_name'];

  // ── C0 新增 3 表锚点（多开发协作与 commit 留痕重构 v2.9 §9/附录C）：readiness「结构全列在」模型 ──────────
  //   与 sys_issue_dev_assignees 首版同款——三表均为**一次性 CREATE TABLE（无 ALTER 路径）**，要么整表建全
  //   要么不存在，缺任一结构列=建表未完整→[2] 判 ready=false。
  const SYS_DEV_COMMITS_KEY_COLS = ['issue_id', 'dev_assignee_id', 'dev_user_id', 'component', 'commit_ref', 'created_at', 'updated_at'];
  const SYS_DEV_EVENTS_KEY_COLS = ['issue_id', 'dev_assignee_id', 'related_dev_assignee_id', 'action', 'from_status', 'to_status', 'operator_id', 'reason', 'payload_json', 'created_at'];
  const SYS_RELEASE_COMMIT_SNAPSHOTS_KEY_COLS = ['release_id', 'issue_id', 'snapshot_json', 'created_at'];
  // ── 角色权限重构 C2a（方案 v1.7 §4-C2a）：物理删除审计表锚点 ──────────────────────────────────
  //   同上"结构全列在"模型（一次性 CREATE TABLE，无 ALTER 路径）。本表是**不可逆动作的唯一 DB 留证**——
  //   缺列即审计不完整，宁可 readiness 不放行也不能让删除端点在"审计写不全"的库上跑（fail-closed）。
  const SYS_DELETE_AUDIT_KEY_COLS = ['issue_id', 'issue_type', 'issue_status', 'issue_title',
    'issue_created_by', 'issue_created_at', 'attachment_count', 'timeline_count',
    // ← 对抗审 F1/F2/F7 收口：四张子表的快照与计数（按 issue_id 子表统一枚举，非"挑三张"）
    'dev_assignee_count', 'dev_commit_count', 'dev_event_count', 'release_snapshot_count',
    'issue_json', 'timeline_json', 'attachments_json',
    'dev_assignees_json', 'dev_commits_json', 'dev_events_json', 'release_snapshots_json',
    'operator_id', 'operator_name', 'reason', 'deleted_at'];

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
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.2/§8·C2] estimated_effort_days 加入本常量本体——换轮
  //   （return/reopen，见下方两处消费本常量的调用点）连工期一起清（新一轮重评，旧工期不跨轮带过去，
  //   同评估三字段"当前轮"语义一致，§8 换轮清空语义汇总表逐字冻结）。
  const SYS_CLEAR_FEASIBILITY_FIELDS_SQL = [
    'feasibility_conclusion = NULL',
    'feasibility_requirement_confirm = NULL',
    'feasibility_risk = NULL',
    'estimated_effort_days = NULL',
    ...SYS_CLEAR_BLOCKED_FIELDS_SQL,
  ];

  // ── S3（bug暂缓方案 20260803 v0.4 §7.4）：hold 提交时随状态 UPDATE 同事务重置建单人侧通知列组 ──────────
  //   因复用既有 creator_notify_* 列组（intake_return 等场景也写它），上一轮或其他场景的 'sent' 状态会让
  //   本轮暂缓通知被误判为已发送——同一事务内重置为 not_sent，把"本轮"锚定在这次 hold 上（§7.4 表格第一行）。
  //   ⭐⭐ S3b 收窄（codex 复核推翻 S3 首版"不分 type"判断）：**仅 bug 流使用**（调用点 case 'hold' 内
  //   已加 `type === 'bug'` 条件，见该处）——变更流 hold 从未重置过 creator_notify_*，这是既有已上线行为；
  //   而该列组被 intake_return（受理退改自动通知建单人）等场景共用，真实可达链路"变更流单 intake_return
  //   通知成功(sent) → resubmit_intake → intake_accept → hold" 若不收窄会把"曾通知过建单人退改"的审计
  //   痕迹与 UI 徽章一并抹掉——危害不在"有没有新端点消费"，而在"抹掉了已有场景写入的状态"。同 S2 roster
  //   冻结守卫的 bug-only 口径（同一任务内同性质改动，处理口径必须一致）。本常量定义本身不含 type 判断
  //   （纯 SQL 片段列表），仅 bug 单一份"仅 bug 用"的约束在调用点体现，此处仅记一句指引不重复三处判断逻辑。
  const SYS_CLEAR_CREATOR_NOTIFY_FIELDS_SQL = [
    "creator_notify_status = 'not_sent'",
    'creator_notified_at = NULL',
    'creator_notify_message_key = NULL',
    'creator_notify_error = NULL',
    'creator_read_at = NULL',
    'creator_notify_sent_by = NULL',
  ];

  // ── 角色权限重构 C0：受理门 SQL/DDL 常量统一从 intake-gate-sql.js 取（**单一真相源**）─────────────
  //   曾经把"回受理门"的字段清单在 index.js 与运维脚本各写一份，结果脚本漏清 tech_lead_*/relay_* 十六列，
  //   把违规单修成「表面合法、跨轮次状态仍脏」的半清状态（codex 七轮审 HIGH-1）。故收敛为一处定义、多处引用。
  //   触发器 DDL **不带 IF NOT EXISTS**、恢复时一律 DROP 后重建——名称存在不等于定义正确（七轮审 MED-1）。
  const {
    SYS_CLEAR_TECH_LEAD_FIELDS_SQL,
    SYS_CLEAR_RELAY_FIELDS_SQL,
    SYS_CLEAR_INTAKE_NOTIFY_FIELDS_SQL,
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
  // ⭐⭐⭐ [C10 对接人绑单精判·方案 v1.7 §10.2·裁定1] 对接人**候选资格** allowlist——`active ∧ role∈{user,publisher}`。
  //   ⚠️ **刻意独立于 hasReleaseEligibility（:9374），不复用**，两条理由（编码前方案回报已论证、主会话裁定采纳）：
  //     ① **role 值域未被强制封闭**：USER_ROLES（server.js:72）定义后全项目零消费，role 列无 CHECK，建/改用户端点
  //        均不校验值域。hasReleaseEligibility 用**否定式** denylist（`role∉{viewer,admin}`）——未知/脏 role（拼错的
  //        `Publisher`、将来新增角色）会被判 eligible（**fail-open**）。本函数用**肯定式** allowlist（`role∈{user,publisher}`）
  //        ——未知 role 一律不 eligible（**fail-closed**）。§10.2 要的是后者。两式仅在值域真封闭时等价，而它没封闭。
  //     ② **概念分离**：「上线执行资格」≠「对接人候选资格」——今天谓词恰同不代表永远同，共用一函数则将来改一处会
  //        静默污染另一处（[[feedback_write_read_same_semantic]]）。故独立成件，谓词等价这件事写在注释里、不写成复用。
  //   （role 值域封闭约束——写入端校验 USER_ROLES / 加 CHECK——本批不做，已登记 backlog：allowlist 已 fail-closed 兜住脏值。）
  const INTAKE_LIAISON_ELIGIBLE_ROLES = ['user', 'publisher'];
  //   纯 role 判据（供中间件**粗筛**用 JWT role·同步·不读库）——粗筛只挡明显越权，精判在引擎/handler 内实时读库。
  function isRoleIntakeEligible(role) {
    return INTAKE_LIAISON_ELIGIBLE_ROLES.includes(role);
  }
  //   权威候选判据（**实时读库**·同 hasReleaseEligibility 的"不信调用方标记"范式）：存在 ∧ active ∧ role∈allowlist。
  async function isIntakeLiaisonEligible(userId) {
    if (!(Number(userId) > 0)) return false;
    const u = await dbGetAsync('SELECT status, role FROM users WHERE id = ?', [Number(userId)]);
    return !!(u && u.status === 'active' && INTAKE_LIAISON_ELIGIBLE_ROLES.includes(u.role));
  }
  // ⭐⭐ [C10-fix2 MED-2·绑定对接人「发通知」有效性统一校验] tech-lead-comment 的「评估已回」首发/补发通知
  //   发给本单 intake_liaison_id——发送前必须校验该绑定人**存在 ∧ status='active' ∧ role∈候选 allowlist**
  //   （与 liaison-test「停用/移出候选即无有效收件人」、resolveActiveSysIntakeLiaisons 逐字同口径）。原实现
  //   只查 users 是否存在、不验 active/role，绑定人停用或被移出候选后仍会收到「你的单被回复了」通知（越权
  //   知悉/噪声）。失效（不存在 no_bound_liaison / 停用·角色移出 liaison_ineligible）→ 返回 {user:null,reason}
  //   让调用方 logger.warn 降级不发。谓词与 isIntakeLiaisonEligible 同源（同一 INTAKE_LIAISON_ELIGIBLE_ROLES
  //   allowlist·fail-closed），但一次 SELECT 连发送所需列（display_name/phone/dingtalk_user_id）一并取回，
  //   省二次读库。两条通知路径（tech-lead-comment 首发 :6924 一带 / resend-notify :7126 一带）共用本 helper。
  async function resolveValidBoundLiaisonForNotify(boundLiaisonId) {
    if (!(Number(boundLiaisonId) > 0)) return { user: null, reason: 'no_bound_liaison' };
    const u = await dbGetAsync(
      'SELECT id, display_name, username, phone, dingtalk_user_id, status, role FROM users WHERE id = ?',
      [Number(boundLiaisonId)]
    );
    if (!u) return { user: null, reason: 'liaison_not_found' };
    if (!(u.status === 'active' && INTAKE_LIAISON_ELIGIBLE_ROLES.includes(u.role))) {
      return { user: null, reason: 'liaison_ineligible' };
    }
    return { user: u, reason: null };
  }
  // ⭐⭐ [C10·裁定2] 绑单精判（权限不变量·硬约束）：单据动作仅 **admin ∨ 该单当前 intake_liaison_id 本人**。
  //   角色候选资格（isIntakeLiaisonEligible）只决定"谁能被选进候选/谁能受理存量空单"，**不授跨单操作权**——
  //   示例对接人[13] 从"可操作所有单"收紧为"仅名下绑定单"（**行为变更**·方案已拍板+部署日公告在案）。
  //   示例对接人[13] 从"可操作所有单"收紧为"仅名下绑定单"（**行为变更**·方案已拍板+部署日公告在案）。row 需含 intake_liaison_id。
  //   ⚠️ 布尔判据（非抛异常版）——各直连 handler 沿用既有「早退 res.status(403)」范式，不改成抛异常，风格一致
  //     且不依赖各 handler 内层 catch 的回滚行为。错误码统一 NOT_BOUND_LIAISON。
  function isBoundLiaisonOrAdmin(actor, row) {
    if (actor && actor.role === 'admin') return true;
    return !!(row && row.intake_liaison_id != null && Number(actor.id) === Number(row.intake_liaison_id) && Number(actor.id) > 0);
  }
  // ⭐⭐⭐ [C10-fix5 HIGH·撤销资格同步撤销存量绑单操作权·fail-closed] 绑单精判（含 eligibility）——
  //   原 isBoundLiaisonOrAdmin 只校验「绑定人身份」（admin ∨ 该单 intake_liaison_id 本人），**不校验该人当前是否仍
  //   eligible**（active ∧ role∈候选 allowlist）。缺陷（codex 322 末次审 HIGH）：对接人 role 被改成 viewer（移出候选·
  //   但仍 active）后，ta 仍是该单 intake_liaison_id ⇒ isBoundLiaisonOrAdmin=true ⇒ **仍能执行受保护动作**（fail-open
  //   残留操作权）；而通知端 resolveValidBoundLiaisonForNotify（:404·C10-fix2）已校验 active+role∈allowlist 立即失效
  //   ——两端不对称（能操作但收不到通知）。本 helper 补齐对称：**admin ∨ (绑定本人 ∧ 当前 isIntakeLiaisonEligible)**。
  //   ⚠️ 分层复用（单一事实源）：身份判据复用 isBoundLiaisonOrAdmin（admin 已在其内旁路，故 admin 命中上方 early
  //     return·不读库）；eligibility 判据复用 isIntakeLiaisonEligible（同 INTAKE_LIAISON_ELIGIBLE_ROLES allowlist·
  //     fail-closed·与通知端 resolveValidBoundLiaisonForNotify 逐字同口径）。绑定本人才需 await 读库一次。
  //   ⚠️ async 化的连带影响：本 helper 供 10 个直连 handler（全 async 上下文）改 await 调用；引擎内联 isBoundLiaison
  //     （roleGuard 层·:3229）与同步守卫 sysManualNotifyGuard（:12813）各自另加 eligibility（前者内联 await·后者经
  //     opts.actorEligible 预读传入）——三处 eligibility 语义单一源于 isIntakeLiaisonEligible。
  async function isBoundLiaisonEligibleOrAdmin(actor, row) {
    if (actor && actor.role === 'admin') return true;          // admin 旁路·不读库（同 isBoundLiaisonOrAdmin 语义）
    if (!isBoundLiaisonOrAdmin(actor, row)) return false;      // 非绑定本人（admin 已上分支返回）→ 直接拒·不读库
    return await isIntakeLiaisonEligible(actor.id);            // 绑定本人还须当前仍 eligible（fail-closed）
  }
  // 角色权限重构 C3（方案 v1.9 §4-C3）历史沿革：request-tech-consult / resend-tech-consult 两个既有端点的
  //   开放态谓词单一来源——按 type 分流，避免两个端点各自硬编码一份、日后改一处漏另一处（写读同源）。
  //   C3 当时曾令变更流（feature/improvement）随预沟通段前移到「待商议」，bug 保持锚定「待受理」（bug 不走
  //   预沟通段，本动作对 bug 的语义从来是"请技术负责人协助判断/定位"，与变更流那条不是同一件事）；
  //   彼时新增的 tech-lead-comment / cancel-consult 也不复用本函数，各自硬编码「待商议」（不分 type）。
  //   ⭐ codex Round-A 审 MED（同 C2.5a A-HIGH「合法初始态收敛为单值」教训）：改为**显式映射 + fail-closed**，
  //   不用"非预沟通类型即回退『待受理』"这种隐式兜底——原实现对 config/拼写错误/脏 type 值也会静默返回
  //   「待受理」，一个从未设计过的 type 混进来时守卫毫无反应。现在未登记的 type 显式返回 null，
  //   调用方（request/resend-tech-consult）必须显式判断 null 并拒绝（409 REQUEST_TECH_CONSULT_TYPE_INVALID）。
  //   ⭐⭐ C2.5 撤销（方案 v2.1 §3）：**全类型收敛为「待受理」单值**——预沟通段废除，变更流与 bug 的
  //   咨询开放态自此同值（v1.9 的 P5 分流随撤销自然消失）。fail-closed 对未登记 type 保留。
  function sysTechConsultGateStatus(type) {
    if (type === 'feature' || type === 'improvement' || type === 'bug') return '待受理';
    return null;                                       // 未登记 type（config/脏数据/拼写错误）→ fail-closed
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
  // ⭐ [C10·裁定2] 粗筛判据从「admin ∨ SYS_INTAKE_LIAISON_IDS[13]」放宽为「admin ∨ role∈候选 allowlist」——
  //   候选池扩大到全 eligible 成员（用 JWT role 同步判，粗筛足够；跨单**绑单精判**在引擎 roleGuard / handler 内
  //   实时读库完成，见 assertBoundLiaisonOrAdmin）。粗筛放宽 + 精判收紧：非 admin 候选须过粗筛才够得着 handler
  //   （受理存量空单 / 操作自己名下单），但操作**他人绑定单**会被精判 403 NOT_BOUND_LIAISON 拦下。
  function requireIntakeLiaison(req, res, next) {
    const role = req.user && req.user.role;
    if (role === 'admin' || isRoleIntakeEligible(role)) return next();
    return res.status(403).json({ error: '仅管理员或受理人可操作', code: 'NOT_ADMIN_OR_INTAKE_LIAISON' });
  }

  // ── 建单优化批 C1（方案 20260731_v1.2 §3 改动点2，审 215 M-4）：对接人下拉候选同源 helper ──────────
  //   从 SYS_INTAKE_LIAISON_IDS JOIN users 过滤 active，返回 [{id,name}]。**四处全部复用此一个函数**
  //   （下拉查询端点 GET intake-liaisons / 主建单校验 / 衍生入口自动填 / notify-intake 收件人解析），
  //   active 判定不许四处各写——本期该常量恒 1 人，升级为多人时（受理人角色加第二人）只需改本函数。
  //   ⭐ [C10·裁定2·废止白名单] 候选来源从「id IN SYS_INTAKE_LIAISON_IDS」改为「status='active' ∧ role∈候选
  //     allowlist」（与 isIntakeLiaisonEligible 同源判据）。四消费点（下拉/建单校验/衍生自动填/notify-intake 收件人
  //     解析）自动跟随——示例对接人[13] 不再是唯一候选，任一 eligible 成员都可被选为对接人。
  async function resolveActiveSysIntakeLiaisons() {
    const ph = INTAKE_LIAISON_ELIGIBLE_ROLES.map(() => '?').join(',');
    const rows = await dbAllAsync(
      `SELECT id, display_name, username FROM users WHERE status = 'active' AND role IN (${ph}) ORDER BY id`,
      INTAKE_LIAISON_ELIGIBLE_ROLES
    );
    return (rows || []).map(r => ({ id: r.id, name: r.display_name || r.username || `user#${r.id}` }));
  }

  // ── 上线体统一重构 C1（方案 v3.4 §6.14 权限矩阵「排班表写」行）→ C2a 泛化（§6.8「撤销上线安排」同判据）──
  //   仅对接人可用，**admin 一律 403**——不能复用 requireIntakeLiaison（那是 admin ∨ 白名单）。
  //   这是本模块内**唯一"admin 也不能写"**的写权限例外（其余端点几乎都是 admin 天然放行 ∨ 白名单），
  //   故独立写一个中间件、不与 requireIntakeLiaison 共享判据——防止未来 requireIntakeLiaison 若加别的
  //   豁免分支被本端点误继承，悄悄放开本该焊死的 admin 例外。
  //   ⚠️ C2a 改名（codex 决策点，主会话裁定）：原名 `requireDutyRosterWrite`（C1 排班表专属）泛化为
  //   `requireLiaisonOnly`——判据与 C1 逐字相同（仅 isSysIntakeLiaison），C2a `cancel-schedule`（撤销上线
  //   安排）复用同一判据（§6.8「权限=对接人，admin不可用」）。错误码同步从 `DUTY_ROSTER_WRITE_LIAISON_ONLY`
  //   泛化为 `INTAKE_LIAISON_ONLY`（不再绑定"排班表"这一具体资源名，两个功能共用同一 403 语义）——
  //   verify-sys-duty-roster.js 的 5 处引用已同步改码（C2a 收口时一并改）。
  // ⭐⭐ [C10-fix M1·收回权限放宽·守边界] 判据保持**窄集合[13]**（isSysIntakeLiaison·非候选 allowlist）——
  //   **按能力拆**（同 SYS_BUG_LIAISON 独立原则）：candidate 口径（per-issue 受理类动作·下拉候选/建单校验/
  //   衍生自动填/受理空单）走 isIntakeLiaisonEligible 随 C10 扩大到全 eligible 成员，**但 release/roster 级
  //   操作授权保持窄集合[13]**，两者刻意分离——候选扩大**不延伸到 release 级**。
  //   ⚠️ 理由：cancel-schedule / 排班表写都是 **release/roster 级**操作（作用于 sys_releases，一个批次含多张
  //     单、各单 intake_liaison_id 可能不同），**没有单一"该单 intake_liaison_id"可绑**，per-issue 绑单精判在
  //     release 粒度结构性不可表达；若随候选池被动放宽成 8 人（8 名开发都能撤销上线排期/改排班）=纯放宽，
  //     违 [[feedback_guard_boundary_over_convenience]] 守既有边界。故此处**收回 C10 的被动放宽**，回到原
  //     [13] 窄集合 + admin 排除（§6.8 刻意设计：撤销上线安排/排班表写=对接人专属，admin 不介入·
  //     isSysIntakeLiaison 对 admin 的 id 天然不命中）。**admin 排除保持不动**。
  //   ⭐ P6 已裁定=追认窄集合（用户 2026-08-08 拍板：release/roster 级操作无 per-issue 绑定可判，随池
  //     放宽=8 名开发均可撤销上线排期/改排班=纯扩权无收益；将来对接人池常态化扩大时再评估「排班管理者」
  //     角色）。本批只收回被动放宽、不新造角色，也不改 candidate 口径的扩大。
  function requireLiaisonOnly(req, res, next) {
    if (isSysIntakeLiaison(req.user && req.user.id)) return next();
    return res.status(403).json({ error: '仅对接人可操作（管理员无此权限）', code: 'INTAKE_LIAISON_ONLY' });
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
        release_type TEXT,
        -- ── 上线体统一重构 C0（方案 v3.4 §6.1，2026-07-28）新增 10 列：上线值班执行人 + 通知状态机 + 应急标记 ──
        --   表尾对齐 ALTER 追加序（同 release_type 惯例）；旧库演进走 runSysMigration [1a-10] 幂等 ALTER
        --   （不带 CHECK，同 needs_release/relay_notify_status 先例——值域由服务层守卫 + 本表新库 CREATE 路径
        --   CHECK 双重兜底）。本 commit 仅建列，不接入任何读/写/守卫逻辑（同 C1a release_assignee_id 首次
        --   建列的「schema 一次到位免二次迁移」惯例，业务接线留给后续 commit）。
        release_assignee_id INTEGER,
        release_assignee_name TEXT,
        release_assignee_notify_status TEXT NOT NULL DEFAULT 'not_sent'
          CHECK (release_assignee_notify_status IN ('not_sent','sending','sent','failed','stale')),
        release_assignee_notify_started_at DATETIME,
        release_assignee_notified_at DATETIME,
        release_assignee_notify_message_key TEXT,
        release_assignee_notify_error TEXT,
        release_assignee_notify_token TEXT,
        release_assignee_read_at DATETIME,
        release_kind TEXT NOT NULL DEFAULT 'normal' CHECK (release_kind IN ('normal','emergency'))
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

        -- 角色权限重构 v2.1 §4：OA 流程号。受理通过后、单据进入「§4 显式允许状态集」内时经
        --   POST /sys-issues/:id/set-oa-number 回填。⚠️ 允许集只限制**补填/修改窗口**，不限制字段存续——
        --   已有值随正常流转保留（唯一清空点=reactivate）；「待受理」等窗口开启前的态恒 NULL——
        --   NULL = 尚未走 OA，是有意义的业务态，故**不设占位号**。
        --   值域 1-20 位纯数字由服务层 assertSysOaNumber 守卫（不加 DB CHECK：ALTER 路径补不了约束，
        --   新库/旧库两条路径若一边有 CHECK 一边没有，反而制造"看起来一致实则不同"的假象）。
        oa_number TEXT,

        -- 建单优化批 C3b（方案 20260801_v1.3 §6c）：免 OA 声明标志。1=本单无需 OA 立项（内部自发/未走
        --   OA），建单弹窗显式勾选、建单后一次性定死（编辑窗口不提供修改入口，§6c 设计点5）；号与豁免
        --   正交——exempt=1 单仍可正常 set-oa-number 填号（守卫任一满足即过，填号不联动清标志）。
        --   NOT NULL DEFAULT 0（同 intake_notify_status 先例：CREATE TABLE 与 ALTER 双路径都写
        --   NOT NULL DEFAULT，旧库 ALTER 语义自动回填 0，无需求）。
        oa_exempt INTEGER NOT NULL DEFAULT 0 CHECK (oa_exempt IN (0,1)),

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
        --   needs_release：bug 待上线态内开发填「是否发版」（NULL=未填；1=发版走 hotfix 批次/0=不发版走专用 transition，§8.2，Commit ② 写入，历史设计）。
        --     CHECK 仅新库带（旧库 ALTER 不补 CHECK，corrections [2a-x3] 同源；靠 ② 写入口枚举校验 + verify 兜底，两路径不变量等效）。
        --   ⚠️⚠️ [上线体统一重构 C3→C6 起] 本列**唯一写点** POST /sys-issues/:id/set-release-flag 已随 C3
        --   全类型退场为 410 Gone（该端点历史上只服务 bug，退场即整端点实质停用）——全项目 grep 确认此后再无
        --   任何代码路径能把本列写成非 NULL，bug 建单起即恒停在初值 NULL，**转为纯只读残留**（与下方本表
        --   release_assignee_id 组"双重身份"8 列不同：本列没有第二套仍在活跃读写它的独立机制，是单一身份、
        --   彻底死透的残留列）。方案 v3.4 §5b 业务口径 #2 明文「needs_release｜废弃」——add-issues 端点曾额外
        --   叠加"bug 须 needs_release=1"闸门（因唯一写点已死，该闸门等价于对 bug 恒拒），2026-07-29 主会话
        --   裁定选项 A 随双闸一并拆除（见 add-issues 路由处注释），此后 bug 与 feature/improvement 经同一
        --   add-issues 入口完全同源放行，不再依赖本列取值。**结论**：禁止未来任何人以此列"看似还在 SELECT
        --   里"为由恢复对它的准入判断——C5 收口批曾因这一列使 bug 永久无法加单，是本次拆闸的直接起因；
        --   本列仍会被部分 SELECT 语句读出（供前端历史 timeline 标签渲染 + 建单初值展示），这是展示用途，
        --   不是业务判断依据。DROP COLUMN 更是硬约束下禁止的操作（37 列表重建风险），故保留列不删。
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
        -- 上线编排指定执行开发（§2.3 历史：C3b assign-release-dev/execute-release 消费·家族已于 2026-07-30 全封）：
        --   C1a 仅建列——nullable inert，本 commit 不接入任何读/写/守卫逻辑（schema 一次到位免二次迁移）。
        --   ⚠️⚠️ [上线体统一重构 C5 起注记] 本组 8 列（release_assignee_id/name + 下方 5 列 + 表尾
        --   ALTER 补的 release_assignee_notify_sent_by）**不是单纯的"只读残留列"**，情况分两半：
        --   ① 对**本次上线体统一重构**（C0-C9，权威源=sys_releases 同名 10 列 + 排班表）而言，这 8 列
        --      C5 起确实只读——曾经把 sys_releases 权威态镜像进来的 syncReleaseLegacyMirror 双写函数
        --      已随 C5 整体删除（见该函数原定义处的删除注释），本重构的任何写路径不会再碰它们。
        --   ② 这 8 列曾同时是另一套独立、更早于本次重构的机制（2026-07-07「通知上线开发」follow-up：
        --      assign-release-dev/reassign-release-dev 写 release_assignee_id/name；notify-release-executor(-batch)
        --      写通知 5 列）的活跃读写字段。[2026-07-30 用户裁定] 该"旧上线编排"机制 4 端点已全部封禁退场
        --      （409 LEGACY_RELEASE_FLOW_DISABLED，实现体已删，见 index.js 旧上线编排退场段）——自此全库
        --      对这 8 列**零写路径**，②也归入只读残留。
        --   **结论**：8 列业务写路径全封（指派/换人/通知发送）；唯一残留写点=notify-read-status 的已读固化回写
        --   release_assignee_read_at（仅历史 sent 数据可达，生产 0 行，codex 208 审 HIGH-1 精确口径）。仍禁止
        --   DROP COLUMN/复用/改写语义——DROP 是 37 列表重建硬约束下禁止的操作；历史数据读路径保留。
        release_assignee_id INTEGER,
        release_assignee_name TEXT,
        -- ── 通知改造 follow-up（2026-07-07）：第 5 类「通知上线开发」5 列——镜像 creator_notify_* 五列范式（byId 发送，无 phone 快照）；旧库 ALTER 路径见 runSysMigration [1a-3]。
        --   [C5 起] 不再被 sys_releases 侧镜像双写触碰（syncReleaseLegacyMirror 已删）；[2026-07-30 起] 唯一写入方
        --   （旧上线编排 notify-release-executor(-batch) 经 recordSysReleaseExecutorNotify）亦随家族封禁整体删除。
        --   ⚠️ 精确口径（codex 208 审 HIGH-1 修正）：5 列中 4 列零写路径；release_assignee_read_at 尚存唯一残留写点=
        --   notify-read-status?type=release_executor 的已读固化回写（仅对历史 sent+message_key 数据可达，生产 0 行，前端触发点已删）。
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

        -- ── 建单优化批 C1（方案 20260731_v1.2 §3/§4）：对接人字段 + intake 通知通道 5 列 ──────────
        --   置于表尾（同惯例，与旧库 ALTER ADD COLUMN 追加序一致）。intake_liaison_id 可空（存量单/
        --   导入单无对接人为合法态，§3 改动点1）；intake 通知 5 列逐列镜像 creator_notify_* 范式
        --   （§4 改动点1，NOT NULL DEFAULT 双路径同 creator_notify_status 先例）——⚠️ 本通道刻意不设
        --   独立的 intake_notified_at 列（方案 §4 列清单明列 5 列：status/message_key/error/read_at/
        --   sent_by，不含 notified_at），status/message_key/error/sent_by 四列已足支撑三态流转与查
        --   已读判定，旧库 ALTER 路径见 runSysMigration [1a-11]。
        intake_liaison_id INTEGER,
        intake_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (intake_notify_status IN ('not_sent','sent','failed')),
        intake_notify_message_key TEXT,
        intake_notify_error TEXT,
        intake_read_at DATETIME,
        intake_notify_sent_by INTEGER,

        -- ── C1（工期对接测试与风险等级拆分 方案 v1.0 §4/§10）：工期 + 风险等级 + 测试段周期号 ──────────
        --   置于表尾（同惯例，与旧库 ALTER ADD COLUMN 追加序一致）。estimated_effort_days=评估环节人日
        --   （feasibility payload 写入，§3.2；契约=有限数、0<v≤365、0.5 整数倍，CAST 双倍取整技巧同
        --   SQLite 无 MOD 运算符环境下的惯用写法）；risk_level=对接人受理时技术风险定级（intake_accept
        --   同一 UPDATE 原子落库，§3.4；⭐ 用户拍板批1改造B：feature+improvement 均必填，bug 恒 NULL，
        --   合法空=仅存量单，NULL 是有意义业务态不设占位，同 oa_number 先例）；值域=一级/二级/三级
        --   （⭐ 用户拍板批1改造A：原「高/中/低」全仓改名，语义不变，仅文案换）；liaison_test_cycle_no=
        --   独立测试周期号（§3.0-⑦ 进入「待对接测试」的同一 CAS 内自增，只增不清，与 return_count/
        --   reopen_count 语义分离，§3.1b）。三列 CHECK 仅新库带（旧库 ALTER 不补 CHECK，见下方
        --   runSysMigration 说明）。
        estimated_effort_days REAL CHECK (estimated_effort_days IS NULL OR (
          typeof(estimated_effort_days) IN ('integer','real') AND estimated_effort_days > 0
          AND estimated_effort_days <= 365
          AND (estimated_effort_days * 2) = CAST(estimated_effort_days * 2 AS INTEGER)
        )),
        risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('一级','二级','三级')),
        liaison_test_cycle_no INTEGER NOT NULL DEFAULT 0 CHECK (typeof(liaison_test_cycle_no) = 'integer' AND liaison_test_cycle_no >= 0),

        -- ── C1：对接测试通知列组（§6 预占协议·逐列镜像 intake_notify_* 六列范式 + recipient 快照 + 周期令牌）──
        --   逐字镜像 intake_notify_* 六列范式（status/message_key/error/read_at/sent_by），**补
        --   liaison_test_notified_at**（C0 矩阵验证清单 §A 附注核实：现网 intake 组本就没有 notified_at，
        --   属明显正确的补全，非镜像偏离）；recipient_id/recipient_name=通知目标快照（本通道无持久
        --   "测试人"指派列——测试授权来自 SYS_INTAKE_LIAISON_IDS 池，非某个固定字段——收件人只在预占
        --   发送时按池落定并快照，同 relay_notified_user_id/relay_notified_user_name 快照先例，非
        --   intake_liaison_id 那种"指派兼收件人合一"模式）；liaison_test_notify_cycle_no/attempt_token/
        --   attempt_started_at=§6 预占协议三件套（token 预占并发互斥 + 独立时间源支持超窗恢复 + 通知
        --   周期与主周期防串号）。**跨列不变量**（sending⇔token∧started_at 非空、notify_cycle_no≤主
        --   周期）不是 DB CHECK 能表达的（单列约束语法，SQLite ALTER 补的多列条件更加受限）——服务端
        --   每次写入维护 + verify 探针扫非法组合（§4 落库策略拍板，C4 接线）。status 四态
        --   not_sent/sending/sent/failed（新通道新 CHECK，区别于三侧通知经典三态 not_sent/sent/failed
        --   ——本通道多一个 sending 因需要预占协议，同 release_assignee_notify_status 5 态先例，唯一
        --   区别是本通道不需要 release_assignee 那个"stale"超窗态，超窗直接判定复用 sending+时间源）。
        liaison_test_recipient_id INTEGER,
        liaison_test_recipient_name TEXT,
        liaison_test_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (liaison_test_notify_status IN ('not_sent','sending','sent','failed')),
        liaison_test_notified_at DATETIME,
        liaison_test_notify_message_key TEXT,
        liaison_test_notify_error TEXT,
        liaison_test_read_at DATETIME,
        liaison_test_notify_sent_by INTEGER,
        liaison_test_notify_cycle_no INTEGER NOT NULL DEFAULT 0 CHECK (typeof(liaison_test_notify_cycle_no) = 'integer' AND liaison_test_notify_cycle_no >= 0),
        liaison_test_attempt_token TEXT,
        liaison_test_attempt_started_at DATETIME,
        -- [codex 291 号 H-1 收口·2026-08-06] pass 凭证"本轮附件"判定改 id 水位模型（原 created_at 时间比较
        --   在同一事务/同一秒内插入多行时精度不足，见 verify-sys-liaison-test.js [6h] 反证）。语义＝"进入
        --   本轮待对接测试那一刻，附件表里已存在的最大 id"——runWGate ⑦ 同一 CAS 原子写入
        --   COALESCE(MAX(该单 delivery/screenshot 附件 id), 0)；pass 凭证判定改"附件.id > watermark"
        --   （严格大于，watermark 本身是"旧"附件，不算本轮）。NOT NULL DEFAULT 0：存量单/从未进入过
        --   测试段的单，水位=0，语义上"任何 id>0 的附件都算新"（不会误判，因为 sys_issue_attachments.id
        --   是 AUTOINCREMENT 恒 >=1）。
        liaison_test_attachment_watermark INTEGER NOT NULL DEFAULT 0 CHECK (typeof(liaison_test_attachment_watermark) = 'integer' AND liaison_test_attachment_watermark >= 0),

        -- ── [C9 无 commit 单验收直翻·方案 v1.7 §10.1 字段契约] 「已上线」来源标签 ──────────
        --   ⭐ [C9-fix M2③] **置于表尾**（从原先夹在 released_at 与 effected_at 之间的位置挪来）——本表的
        --     既定惯例是"新增列一律排表尾，与旧库 ALTER ADD COLUMN 的追加序保持一致，两条建表路径列序不漂移"
        --     （见本表 :592/:620/:664/:671/:685 各组段首注释与 sys_releases 的 release_type/C0 十列先例）。
        --     原位置违反该惯例：新库 CREATE 出来的表里 online_source 在第 12 列，旧库 ALTER 补出来的在最后
        --     一列，PRAGMA table_info 序号两库不同——本身不影响功能（全部读写都按列名），但会让"用列序
        --     比对两库 schema"这类运维手段产生假差异，也让后来者误以为本表允许在中间插列。
        --   ⚠️ 本段是 JS 模板字符串内的 SQL 注释：禁反引号、禁 \t/\n 转义序列（会截断模板串，报错还不指向真凶行）。
        --   仅免上线直翻路径写 'no_commit_acceptance'；批次发布路径**不写**（留 NULL，由"有 active 批次
        --   关联"这一事实推出 release_publish）；存量历史 NULL + 无关联 ⇒ unknown_legacy。
        --   刻意无 CHECK（值域开放、只读不判、唯一写入点是源码常量）——逐条理由见 alterAddMissingCols
        --   侧同名列注释（C9_ONLINE_SOURCE_ISSUE_COLS 组）。
        online_source TEXT,

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
        -- [codex 291 号 H-2 收口·2026-08-06] 结构化留痕列——恢复方案 D22-④ 拍板原意（"留痕进 pass 事件
        --   payload"）。批2曾因发现本表当时无此列，退而求其次落 summary 文本；291 号裁定=改，本列到位后
        --   summary 收窄为 80 字展示摘要，完整凭证（test_note 全文/attachment_ids/evidence/cycle_no）
        --   走本列，键名 schema 冻结见 index.js case 'liaison_test_pass' 写入处注释。目前仅 liaison_test_pass
        --   一个写点消费；本表其余 9 种 event_type 不写此列（保持 NULL），非本次范围扩张。
        payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
        FOREIGN KEY (issue_id) REFERENCES sys_issues(id) ON DELETE CASCADE
      )`, recordSysErr('sys_issue_timeline'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_timeline_issue ON sys_issue_timeline(issue_id, created_at)`, recordSysErr('idx_sys_timeline_issue'));
      // ⭐ 技术负责人读权（写读同源修复·codex 审 MED）：列表 WHERE 里对本表跑相关 EXISTS
      //   （issue_id + action_code + operator_id 三等值），既有 idx_sys_timeline_issue 只覆盖前一列。
      //   本表是只增流水（每单每次流转写行），随数据增长该子查询会退化为逐单扫描 → 补三列复合索引。
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_timeline_actor_action ON sys_issue_timeline(issue_id, action_code, operator_id)`, recordSysErr('idx_sys_timeline_actor_action'));
      // ── 上线体统一重构 C0（方案 v3.4 §6.13，2026-07-28）：上线单动作反查索引 ──────────────────────────
      //   反查双条件 `event_type='scope_change' AND action_code IN (...) AND ref_id=<上线单id>`；本索引配
      //   ref_id 等值 + action_code 覆盖。ref_id/action_code 均是本表**首版原生列**（非 ALTER 追加），故可与
      //   其余索引同批建在 initSchema（不存在"列尚未 ALTER 到位、索引编译期撞 no such column"的时序风险，
      //   区别于下方 idx_sys_releases_assignee 那种建在 ALTER 追加列上的索引）。
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_timeline_action_ref ON sys_issue_timeline(ref_id, action_code)`, recordSysErr('idx_sys_timeline_action_ref'));

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
      //   commit 留痕行（前端 GIT / 后端 SVN 填 commit_ref；2026-08-04 对调，此前口径全反）；可编辑（D2，四守卫见方案 §6.3，C4 起接线）。
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

      // ── 2.10 sys_issue_delete_audit（角色权限重构 C2a，方案 v1.7 §4-C2a）─────────────────────────
      //   物理删除审计：`DELETE /sys-issues/:id` 会连 sys_issue_timeline 一起清掉，**审计链随单据一起消失**，
      //   DB 内零痕迹（此前只有 PM2 应用日志记 username——会轮转、不可查询、不是审计表）。生产有 6 个 active admin，
      //   风险性质 = 误操作 + 事后查不清是谁删了什么（非越权），故本表只解决"查得到"，**不改软删**（方案 §4-C2a）。
      //
      //   ⚠️ 三条设计约束，改本表前先读：
      //   ① **不带 issue_id 外键、不进任何级联清单**——本模块的级联是手写 DELETE（PRAGMA foreign_keys 从未开），
      //      只要没人写 `DELETE FROM sys_issue_delete_audit` 它就不会被删。这正是"审计表活得比业务行久"的实现方式。
      //      issue_id 在这里是**历史编号快照**（被删单据的号），不是引用——单据已不存在，不可 JOIN。
      //   ② **全量 JSON 快照**（issue_json/timeline_json/attachments_json）与计数列并存：计数便于不解 JSON 看规模，
      //      也是 JSON 完整性的交叉校验（count 与数组长度对不上 = 快照有问题）。只留计数等于知道"有过 12 条证据"
      //      却不知道是什么，事后照样查不清（方案 v1.7 §0-③）。
      //   ③ reason NOT NULL——删除是不可逆动作，"为什么删"必须由操作者当场说明（端点 trim 1..200 校验，
      //      同 DELETE /dev/commits/:commitId 既有范式）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_issue_delete_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,                -- 被删单据号（历史快照·非外键·单据已不存在）
        issue_type TEXT,
        issue_status TEXT,
        issue_title TEXT,
        issue_created_by INTEGER,
        issue_created_at TEXT,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        timeline_count INTEGER NOT NULL DEFAULT 0,
        -- ⭐ 对抗审 F1/F2/F7 收口：**按 issue_id 子表统一枚举**，不再是"挑三张"。
        --   初版只快照 issue/timeline/attachments 三份，而带 issue_id 的子表实为 6 张 ——
        --   dev_assignees 被删却没快照（协作开发名册 + 每人的 C2b notify_sent_by 一起消失，
        --   "谁给这张被删单的哪个开发发过钉钉"恰好查不到，正是 C2b 存在的理由）；
        --   dev_commits/dev_events 更是**既没删也没快照**（C0 加表时漏补级联，留永久孤儿行）。
        dev_assignee_count INTEGER NOT NULL DEFAULT 0,
        dev_commit_count INTEGER NOT NULL DEFAULT 0,
        dev_event_count INTEGER NOT NULL DEFAULT 0,
        release_snapshot_count INTEGER NOT NULL DEFAULT 0,
        issue_json TEXT NOT NULL,                 -- sys_issues 整行快照（JSON）
        timeline_json TEXT NOT NULL,              -- 被删 timeline 全部行（JSON 数组·按 id 升序）
        attachments_json TEXT NOT NULL,           -- 被删附件清单（JSON 数组·含 file_name/original_name/type/size）
        dev_assignees_json TEXT NOT NULL,         -- 被删协作开发名册（含 removed_at 软删历史行 + 逐人 notify_sent_by）
        dev_commits_json TEXT NOT NULL,           -- 被删 commit 留痕行
        dev_events_json TEXT NOT NULL,            -- 被删开发侧事件审计链（含 operator_id/reason）
        release_snapshots_json TEXT NOT NULL,     -- 被删发布冻结快照（守卫②使其正常为空·见端点注释）
        operator_id INTEGER NOT NULL,
        operator_name TEXT NOT NULL,
        -- reason 带 DB 层 CHECK（codex C2a 审 MED）：NOT NULL 只挡 NULL，挡不住空白/超长。
        --   本表是全新表（非 ALTER 演进），可直接带 CHECK 上线——同 sys_issue_dev_commits.commit_ref 既有先例。
        --   意义：端点层校验只覆盖"经端点写入"，而运维直连 SQLite / 未来新端点会绕过它；
        --   审计契约「不可逆删除必须说明原因」应当由 DB 兜底，而不是靠"大家都记得走端点"。
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
        deleted_at TEXT NOT NULL
      )`, recordSysErr('sys_issue_delete_audit'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_delete_audit_issue ON sys_issue_delete_audit(issue_id)`, recordSysErr('idx_sys_delete_audit_issue'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_delete_audit_deleted_at ON sys_issue_delete_audit(deleted_at)`, recordSysErr('idx_sys_delete_audit_deleted_at'));

      // ── 2.11 sys_release_duty_roster（上线值班排班表，上线体统一重构方案 v3.4 §6.2，2026-07-28）──────────
      //   **全新表**——CREATE TABLE IF NOT EXISTS 首次真建，直接带完整 CHECK 上线（同 sys_issue_delete_audit
      //   首版范式，不走 alterAddMissingCols——那是给"已存在表加列"用的，本表整表是新的）。
      //   ⚠️ C0 硬门槛（方案 §6.2 注·锚点 14）：SQLite 已建表无法补 CHECK，本 DDL 必须在首次建表时即为
      //   最终版——尤其软删成组 CHECK 第二分支须显式 `removed_by_name IS NOT NULL`（v3.4 codex L-1 修正：
      //   SQLite CHECK 结果为 NULL 时不拒绝该行，`length(trim(removed_by_name)) > 0` 单独写在
      //   removed_by_name IS NULL 时求值为 NULL → 半软删可逃逸写入，故须与 duty_date 的 date(...,'+0 days')
      //   IS NOT NULL 同源显式判空）。
      //   ⚠️ 环境偏差修正（主会话 2026-07-28 实测裁定，建表前唯一修补窗口）：实测 sqlite 3.44.2 裸
      //   `date(duty_date)`（不带 modifier）对"月内溢出但数字仍在 GLOB 允许范围"的日期（如 02-30、非闰年
      //   02-29、04-31）**原样回显、不做 Julian 回转归一化**——`date('2026-02-30')` = '2026-02-30'
      //   （非 NULL 也不等于'2026-03-02'），导致方案 v3.4 §6.2 原式"date() 归一化不等于原值→拒"这条防线
      //   对月内溢出日期实际不生效。改为 `date(duty_date,'+0 days')`（带 '+0 days' modifier）后，sqlite
      //   会走 Julian day 计算再回转，真正触发归一化：'2026-02-30'→'2026-03-02'（≠原值→拒）、
      //   非闰年'2026-02-29'→'2026-03-01'（≠原值→拒）、闰年'2024-02-29'→'2024-02-29'（=原值→放行）。
      //   9 组用例经**主会话外部实测**（独立 probe 脚本直连 sqlite3 验证 date(x,'+0 days') 归一化语义）
      //   符合方案意图，此为方案原式与实际运行环境的已知偏差修正（裁定=方案意图>方案字面 DDL），非本次
      //   实现新引入的逻辑变更；**本 verify-sys-schema.js [11c] 覆盖清单**是另一层——它是走真实
      //   initSchema() 建表 + 真实 CHECK 拒写的自动化回归断言（非临时 probe），两者验证目标一致但载体不同。
      //   ⚠️ codex C0 审收口（0 HIGH/1 MED/4 LOW，主会话裁定，2026-07-28，建表前唯一修补窗口）三处加固：
      //   ① 软删成组 CHECK 第二分支追加 `datetime(removed_at) IS NOT NULL`（removed_at 系服务端
      //     datetime('now') 生成、无月内溢出输入面，故不需要 duty_date 那种 '+0 days' 归一化技巧，
      //     datetime() 判 NULL 足够拦空串/纯空格/垃圾串这类污染值）与 `removed_by > 0`（防 0/负数占位符
      //     伪装成"已处理"）；② user_id 补 `CHECK (user_id > 0)`；③ created_by 补 `CHECK (created_by > 0)`
      //     （均防 0/负数这类非法 id 静默入库）。
      //   ⚠️ codex LOW-2（duty_date 未设业务下限，如拒绝早于建表日期的历史值）**裁定不采纳**——DB 层只做
      //     结构校验（GLOB 格式 + 归一化后一致），SQLite 接受 0000-9999 全日期域；具体业务允许的排班日期
      //     范围（如"不得早于今天""不得超前 N 天"）是运行时会变的业务规则，交服务层校验，DB 层不写死。
      db.run(`CREATE TABLE IF NOT EXISTS sys_release_duty_roster (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        duty_date       DATE    NOT NULL
                          CHECK (duty_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                 AND date(duty_date,'+0 days') IS NOT NULL
                                 AND date(duty_date,'+0 days') = duty_date),
        user_id         INTEGER NOT NULL CHECK (user_id > 0),
        user_name       TEXT    NOT NULL CHECK (length(trim(user_name)) > 0),
        note            TEXT    CHECK (note IS NULL OR length(note) <= 200),
        created_by      INTEGER NOT NULL CHECK (created_by > 0),
        created_by_name TEXT    NOT NULL CHECK (length(trim(created_by_name)) > 0),
        created_at      DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
        removed_at      DATETIME,
        removed_by      INTEGER,
        removed_by_name TEXT,
        CHECK (
          (removed_at IS NULL     AND removed_by IS NULL     AND removed_by_name IS NULL)
          OR
          (removed_at IS NOT NULL AND datetime(removed_at) IS NOT NULL
           AND removed_by IS NOT NULL AND removed_by > 0
           AND removed_by_name IS NOT NULL AND length(trim(removed_by_name)) > 0)
        )
      )`, recordSysErr('sys_release_duty_roster'));
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_duty_roster_active
        ON sys_release_duty_roster(duty_date) WHERE removed_at IS NULL`, recordSysErr('idx_sys_duty_roster_active'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_duty_roster_user
        ON sys_release_duty_roster(user_id, duty_date)`, recordSysErr('idx_sys_duty_roster_user'));

      // ── 2.12 sys_release_executors（上线执行人多选与多人双确认，方案 20260806 v1.7 §4.1）──────────
      //   **全新表**——CREATE TABLE IF NOT EXISTS 首次真建，直接带完整 CHECK 上线（同 sys_release_duty_roster
      //   2.11 段首版范式，不走 alterAddMissingCols）。⚠️ C0 硬门槛：SQLite 已建表无法补 CHECK，本 DDL
      //   必须在首次建表时即为最终版（方案 §4.1 两轮 codex 审 0-HIGH 定稿，逐字落地，不做"优化"）。
      //   代次语义（§4.1a）：行 id 即代次，不加 gen 列——撤销安排=软删全体，重新安排=INSERT 新行（新 id），
      //   旧行 removed_at 非空后不参与部分唯一索引约束，同一 user_id 天然可再插新行，不会互相写到对方。
      //   ⚠️ 307 号 L1（codex 对抗审）核查结论（主会话订正版·agent 原稿误写"未声明 REFERENCES"，实际
      //   本表 DDL 尾部**声明了** `FOREIGN KEY (release_id) REFERENCES sys_releases(id) ON DELETE CASCADE`，
      //   见下方表体末行）：该 FK 是**装饰性**的——本平台恒 `foreign_keys=OFF`（核实#1），CASCADE 不会被
      //   enforce，父子关系实际靠应用层约定维系（与 sys_issue_timeline 等表"写了 REFERENCES 纯当注释"同
      //   一先例）。全项目 grep `DELETE FROM sys_releases` 核实：**生产路径（routes/ 目录）零命中**
      //   ——批次表当前没有任何删除入口（只有软删/状态流转，从不物理删行），故"父行被删、子表留孤儿行"
      //   这个风险场景在当前代码下结构性不可达，不需要也没有手写级联 DELETE 段。⚠️ 若未来任何改造给
      //   sys_releases 加上了物理删除路径，**必须**同批比照 sys_issues 的先例（DELETE /sys-issues/:id
      //   处：删主表前先手写 DELETE 本表 + 其余子表，见该端点头部"级联必须手动做"注释）给本表补一段手写
      //   级联 DELETE——不能假设 FK 会自动兜底（本平台从不开 `PRAGMA foreign_keys=ON`，DB 层永远不会替
      //   你做这件事）。
      db.run(`CREATE TABLE IF NOT EXISTS sys_release_executors (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id        INTEGER NOT NULL,
        user_id           INTEGER NOT NULL CHECK (user_id > 0),
        user_name         TEXT    NOT NULL CHECK (length(trim(user_name, ' ' || char(9) || char(10) || char(13))) > 0),

        -- 通知列（沿用批次级既有五态值域 + token，逐人一份）
        notify_status     TEXT    NOT NULL DEFAULT 'not_sent'
                            CHECK (notify_status IN ('not_sent','sending','sent','failed','stale')),
        notify_started_at DATETIME,
        notified_at       DATETIME,
        notify_message_key TEXT,
        notify_error      TEXT,
        notify_token      TEXT,
        read_at           DATETIME,

        -- 执行确认（双确认核心）
        exec_status       TEXT    NOT NULL DEFAULT 'pending' CHECK (exec_status IN ('pending','done')),
        executed_at       DATETIME,

        -- 审计
        added_by          INTEGER NOT NULL CHECK (added_by > 0),
        added_by_name     TEXT    NOT NULL CHECK (length(trim(added_by_name, ' ' || char(9) || char(10) || char(13))) > 0),
        created_at        DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
        removed_at        DATETIME,
        removed_by        INTEGER,
        removed_by_name   TEXT,

        -- 软删三列成组（第二分支须显式判空，否则 CHECK 求值为 NULL 时半软删可逃逸，同排班表 2.11 段教训）
        CHECK (
          (removed_at IS NULL     AND removed_by IS NULL     AND removed_by_name IS NULL)
          OR
          (removed_at IS NOT NULL AND datetime(removed_at) IS NOT NULL
           AND removed_by IS NOT NULL AND removed_by > 0
           AND removed_by_name IS NOT NULL
           AND length(trim(removed_by_name, ' ' || char(9) || char(10) || char(13))) > 0)
        ),
        -- 执行态成组：done 必有时间戳且时间戳合法
        CHECK (
          (exec_status = 'pending' AND executed_at IS NULL)
          OR
          (exec_status = 'done' AND executed_at IS NOT NULL AND datetime(executed_at) IS NOT NULL)
        ),
        -- 通知态成组：只约束"必然成立"的字段，宁松勿紧。
        --   刻意不约束 notify_message_key——钉钉发送成功也可能不返回该值（sendResult.ok 时才有 message_key，
        --   否则为 null），若写死"sent 必有 message_key"会让正常发送直接入库失败，而建表后 CHECK 补不了改
        --   不了，这类错误不可逆，必须一次判对。
        --   stale 分支刻意无附加条件：它由 sending 惰性转换而来（只改 status 不动其余列），加条件会把既有
        --   转换语句卡死。
        --   sending/sent 分支补 datetime() 合法性：抢占写 notify_started_at、回写成功写 notified_at 两者
        --   恒合法；迁移来的 sent 行由迁移预检 P5 保证 notified_at 合法。
        --   ⚠️ 裁定（Opus 预筛 MED-5）：本表全部 datetime 判据维持裸 datetime(x) IS NOT NULL，不引入排班表
        --   2.11 段 duty_date 那种 date(x,'+0 days') 归一化回比对写法——两者场景不同：① 本表的 datetime 列
        --   （notify_started_at/notified_at/executed_at/removed_at）全部由服务端 datetime('now','localtime')
        --   机器生成，无用户输入面，同 2.11 段排班表软删 CHECK 一带已审定稿的口径（那条注释原话：removed_at
        --   系服务端 datetime('now') 生成、无月内溢出输入面，故不需要 duty_date 那种 '+0 days' 归一化技巧，
        --   datetime() 判 NULL 足够拦空串/纯空格/垃圾串这类污染值）；② '+0 days' 是文本回比对，会把"文本到分"
        --   精度的合法历史值（本项目实存该值域，见 sqlite_date_check_gotcha 沉淀）误判为"归一化后不等于原值"
        --   而误拒，误杀面大于拦截价值；③ 月内溢出垃圾值唯一来源是迁移脚本从旧列搬运的历史手工数据，由迁移
        --   预检 P1/P5 同一判据（datetime(x) IS NOT NULL）一致处理，两处判据必须同源，DDL 若改用 '+0 days'
        --   反而会与迁移脚本的判据产生新的不一致。此裁定为方案 §4.1 定稿口径，非本次遗漏，防后续审查轮重复提起。
        CHECK (
          (notify_status = 'not_sent' AND notified_at IS NULL AND notify_error IS NULL)
          OR (notify_status = 'sending' AND notify_started_at IS NOT NULL
              AND datetime(notify_started_at) IS NOT NULL AND notify_token IS NOT NULL)
          OR (notify_status = 'sent'    AND notified_at IS NOT NULL
              AND datetime(notified_at) IS NOT NULL)
          OR (notify_status = 'failed'  AND notify_error IS NOT NULL)
          OR (notify_status = 'stale')
        ),
        FOREIGN KEY (release_id) REFERENCES sys_releases(id) ON DELETE CASCADE
      )`, recordSysErr('sys_release_executors'));
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_release_exec_active
        ON sys_release_executors(release_id, user_id) WHERE removed_at IS NULL`, recordSysErr('idx_sys_release_exec_active'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_release_exec_release
        ON sys_release_executors(release_id, removed_at)`, recordSysErr('idx_sys_release_exec_release'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_sys_release_exec_user
        ON sys_release_executors(user_id, exec_status)`, recordSysErr('idx_sys_release_exec_user'));

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

      // [1] 表存在性（C0 起 8 表 + C1 迁移标记表 + C2a 物删审计表 + 上线体统一重构 C0 排班表
      //   + 上线执行人多选与多人双确认 C0 执行人子表 = 12 表，即 SYS_REQUIRED_TABLES.length；
      //   本注释是文档性计数，已知会随新表落后——真正的存在性判定不依赖这行数字，见下方动态派生）
      //   ⚠️ **IN 列表由 SYS_REQUIRED_TABLES 动态生成，不再硬编码**（C2a 踩坑根治）：
      //   原实现把同一份表清单写了两遍——常量里一份、这条 SQL 的 IN 里一份。C2a 新增 sys_issue_delete_audit
      //   时只加了常量，表明明建成了却被判"缺失"（IN 里没有 → 查不回来 → filter 认定缺）。
      //   这类"两份清单必然漂移"的缺口不会报语法错，只会在下一个加表的人身上再犯一次，故改为单一来源派生。
      const tablePh = SYS_REQUIRED_TABLES.map(() => '?').join(',');
      const tables = await new Promise((resolve, reject) => {
        db.all(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tablePh})`,
          SYS_REQUIRED_TABLES,
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
        ['needs_release', 'INTEGER'],              // [上线体统一重构 C3→C6 起只读残留] 唯一写点 set-release-flag
        //   已 410 退场，恒停在初值 NULL；旧库 ALTER 路径同 CREATE TABLE 处完整只读残留说明，不重复展开。
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

      // [1a-5b] ⭐ 角色权限重构 C2b（方案 v1.7 §4-C2b·承 codex 167 号 HIGH-2）：五个通知通道补 `*_sent_by`。
      //   背景：生产有 6 个 active admin + 受理人 = **7 个可能触发者**，而 creator/requester/relay/
      //   release_assignee/dev 五个通道只记了"发过没、成没成、message_key"，**没记谁发的** ——
      //   事后无法区分是谁给业务方发了那条钉钉。
      //   ⭐ 本片是**复刻不是设计**：`tech_lead` 通道早有 `tech_lead_notify_sent_by` + §8.3 不变量
      //   （`sent/failed ⟹ sent_by 非空`，`recordSysTechLeadNotify` 对非正整数 sentBy 直接抛契约错），
      //   这里把同一套范式铺到另外五个通道。
      //   ALTER 不带 CHECK（同 relay_notify_status / needs_release 先例）：值域由服务层守卫 + verify 断言兜底。
      //   **历史行 sent_by 为 NULL 可接受**（迁移前无从追溯谁发的），不变量只约束迁移后的新投递。
      //   ⚠️ 顺序铁律同 [1a]：必须在下方 [2] 复查之前（子表列已入 SYS_DEV_ASSIGNEES_KEY_COLS「全列在」锚点）。
      const NOTIFY_SENT_BY_ISSUE_COLS = [
        ['notify_sent_by', 'INTEGER'],                      // dev 侧（主表 notify_*·仅自动派发路径写·详见 recordSysDevNotify 注释）
        ['requester_notify_sent_by', 'INTEGER'],            // 业务方侧——**唯一对外发声通道**，本片最核心的一列
        ['creator_notify_sent_by', 'INTEGER'],              // 建单人侧
        ['relay_notify_sent_by', 'INTEGER'],                // 对接人侧（通道随 C0 关闭 path B 正在退场，仍补齐以免留半拉子不变量）
        ['release_assignee_notify_sent_by', 'INTEGER'],     // 上线开发侧（单条端点 + 批量端点两个写点共用）——
        //   C5 起注记见 CREATE TABLE sys_issues 处 release_assignee_id 列旁的完整说明（8 列只读残留 vs 旧上线编排活跃字段）。
      ];
      await alterAddMissingCols('sys_issues', NOTIFY_SENT_BY_ISSUE_COLS, '角色权限重构 C2b·五通道通知操作者留痕');
      await alterAddMissingCols('sys_issue_dev_assignees', [['notify_sent_by', 'INTEGER']],
        '角色权限重构 C2b·逐 dev 子表通知操作者留痕');

      // [1a-5c] ⭐ 角色权限重构 v2.1 §4：OA 流程号列。历史沿革：C2.5（v1.9）时期本列曾在"预沟通通过"
      //   端点提交时才回填；**C2.5 已撤销**，现由受理通过后、单据进入 §4 显式允许状态集内时经 set-oa-number 端点
      //   回填。⚠️ 191 复审 M 勘定：允许集只限制**补填/修改窗口**（窗口外 409），不等于"窗口外恒 NULL"——
      //   已有值随正常流转保留到终态（唯一清空点=reactivate 防御性归一）；窗口开启前（待受理/待修改）恒
      //   NULL。**NULL 在这里是有意义的业务态（尚未走 OA），
      //   不是缺陷**，因此**不设占位号**（刻意不学 issue_lite 的 `datadev-{id}` / correction 的
      //   `datafix-{id}` 触发器范式：那两处的不变量是"OA 恒非空"，本模块不变量形态不同）。
      //   ⭐ 角色权限重构 C4·184 号预审（PM-1·收窄不回填）：本列的"应有值"不变量只约束新流程产生的单据，
      //   不是对全表存量数据的断言——历史路径（derive/reactivate 等）落在允许集状态的存量单，oa_number
      //   恒为 NULL 属**合法历史态**，不做回填也不造占位号。部署前用探针核查存量单规模，见
      //   `docs/local/系统迭代/任务_C25b_C3_无人值守执行段_20260727.md` §11 新增的部署探针条目。
      //   值域（1-20 位纯数字）由服务层 assertSysOaNumber 守卫，ALTER 不补 CHECK（同 relay_notify_status 先例）。
      const OA_NUMBER_ISSUE_COLS = [
        ['oa_number', 'TEXT'],
      ];
      await alterAddMissingCols('sys_issues', OA_NUMBER_ISSUE_COLS, '角色权限重构 v2.1 §4·OA 流程号');

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

      // [1a-9] ⭐⭐ C2.5 撤销存量迁移（191 号审 CRITICAL 收口·幂等）：「待商议」→「待受理」。
      //   生产从未部署过 C2.5（该态只存在于未部署代码与本地测试库·本地已一次性脚本迁毕），本迁移是
      //   **防御层**：备份恢复/其他副本/任何跑过 v1.9 分支代码的库，启动即自愈——否则存量待商议单在
      //   新状态机下是非法态（无任何出边·守卫拒绝），单据永久卡死。幂等：无匹配行时 UPDATE changes=0，
      //   无需迁移标记（与 C0 归一不同——本条的 WHERE 本身就是收敛判据，重复执行天然 no-op）。
      //   不动 oa_number（迁移前置断言语义已由一次性脚本验证：停在待商议的单该列恒 NULL）。
      try {
        const pdMig = await dbRunAsync(`UPDATE sys_issues SET status = '待受理' WHERE status = '待商议'`);
        if (pdMig && pdMig.changes > 0) {
          logger.info(`[系统迭代迁移] ✅ C2.5 撤销：存量「待商议」归一「待受理」 ${pdMig.changes} 行（防御层·幂等）`);
        }
      } catch (pdErr) {
        // fail-closed 同 C0 口径：迁移失败宁可阻断 readiness 也不放非法态单进流程
        throw new Error(`C2.5 撤销存量迁移失败：${pdErr && pdErr.message}`);
      }

      // [1a-10] ⭐ 上线体统一重构 C0（方案 v3.4 §6.1，2026-07-28）：sys_releases 已上线表演进——补 10 列
      //   （上线值班执行人 id/name + 通知状态机 6 列 + release_kind 应急标记）。ALTER 不带 CHECK（SQLite ALTER
      //   补约束受限，同 release_type/needs_release/relay_notify_status 先例）——值域由服务层枚举校验 + verify
      //   断言兜底（新库 CREATE 路径全量 CHECK，见 initSchema 2.1 段），两路径不变量等效。
      //   release_assignee_notify_status/release_kind 用 NOT NULL DEFAULT 常量可通过 ALTER 回填旧行
      //   （同 relay_notify_status 先例）。
      //   ⚠️ 顺序铁律同 [1a]：这 10 列已入 SYS_RELEASES_KEY_COLS——本 ALTER 必须在下方 [2] 关键列复查之前完成。
      const RELEASE_DUTY_ASSIGNEE_COLS = [
        ['release_assignee_id', 'INTEGER'],
        ['release_assignee_name', 'TEXT'],
        ['release_assignee_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],
        ['release_assignee_notify_started_at', 'DATETIME'],
        ['release_assignee_notified_at', 'DATETIME'],
        ['release_assignee_notify_message_key', 'TEXT'],
        ['release_assignee_notify_error', 'TEXT'],
        ['release_assignee_notify_token', 'TEXT'],
        ['release_assignee_read_at', 'DATETIME'],
        ['release_kind', "TEXT NOT NULL DEFAULT 'normal'"],
      ];
      await alterAddMissingCols('sys_releases', RELEASE_DUTY_ASSIGNEE_COLS, '上线体统一重构 C0·方案 v3.4 §6.1');
      // ⚠️ 索引须在上方 ALTER 之后建：release_assignee_id 是本步 ALTER 才追加的列，旧库在 ALTER 之前不存在
      //   该列——若把这条 CREATE INDEX 挪去 initSchema 的 serialize 块（建表阶段），旧库会在 ALTER 执行前
      //   先跑到它、撞"no such column: release_assignee_id"（同本文件 341 行"CREATE INDEX 编译期校验列名，
      //   与 CREATE TABLE 并发触发竞态"同源问题，只是这里的竞态对象是 ALTER 而非 CREATE TABLE）。新库该列
      //   已在初版 CREATE 里，此处 IF NOT EXISTS 对新库是幂等 no-op、不受影响。
      await dbRunAsync(`CREATE INDEX IF NOT EXISTS idx_sys_releases_assignee ON sys_releases(release_assignee_id)`);

      // [1a-7b/1a-8 已移除] ⭐ 角色权限重构 C0（codex 四轮审 HIGH-1/HIGH-2）：
      //   原先在此处"创建受理门触发器"+"启动哨兵只告警"，两者都有生命周期缺陷——
      //   前者不在 finally 里（迁移任一早退/抛错都会让触发器长期缺失），后者只记日志不阻断
      //   （"触发器在、存量却非法、readiness=true"这种最坏组合仍可发生）。
      //   现统一收进本函数末尾的 **finally [F]**：无条件全表归一 → 后验 → 重建触发器 → 校验 sqlite_master，
      //   任一不达标即阻断 readiness（保留原始迁移错误作根因）。此处不再有触发器相关逻辑。

      // [1a-11] ⭐ 建单优化批 C1（方案 20260731_v1.2 §3/§4/§7）：sys_issues 补 6 列——对接人 id
      //   （intake_liaison_id）+ intake 通知通道 5 列（status/message_key/error/read_at/sent_by，
      //   逐列镜像 creator_notify_* 范式，§4 改动点1）。ALTER 不带 CHECK（同 relay_notify_status/
      //   needs_release 先例）——值域由服务层枚举校验 + verify 断言兜底；intake_notify_status 走
      //   NOT NULL DEFAULT 常量 ALTER 路径可自动回填旧行为 'not_sent'（同 relay_notify_status/
      //   release_assignee_notify_status 先例，审 215 H-2：CREATE TABLE 与 ALTER 双路径都写
      //   NOT NULL DEFAULT）。
      const SYS_INTAKE_LIAISON_ISSUE_COLS = [
        ['intake_liaison_id', 'INTEGER'],
        ['intake_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],
        ['intake_notify_message_key', 'TEXT'],
        ['intake_notify_error', 'TEXT'],
        ['intake_read_at', 'DATETIME'],
        ['intake_notify_sent_by', 'INTEGER'],
      ];
      await alterAddMissingCols('sys_issues', SYS_INTAKE_LIAISON_ISSUE_COLS, '建单优化批 C1·对接人字段 + intake 通知通道');
      // ⚠️ 半迁移防御（方案 §7·复审 M-2 + 终审 M 双检）：全新库/正常存量库的 ALTER 本身已能通过
      //   NOT NULL DEFAULT 自动回填旧行为 'not_sent'（SQLite ALTER TABLE ADD COLUMN 语义），此处 UPDATE
      //   是防御性收敛——只应对"该列此前已存在但未走本 ALTER 语句"（如手工建列/历史损坏迁移）留下
      //   NULL 值的极端场景，正常路径二跑恒 0 行命中（幂等无害）。verify 做数据+schema 双检：除本处
      //   数据扫描外，PRAGMA table_info(sys_issues) 断言该列 notnull=1 且 dflt_value='not_sent'。
      const intakeNotifyNullBackfill = await dbRunAsync(
        `UPDATE sys_issues SET intake_notify_status = 'not_sent' WHERE intake_notify_status IS NULL`);
      if (intakeNotifyNullBackfill && intakeNotifyNullBackfill.changes > 0) {
        logger.info(`[系统迭代迁移] 建单优化批 C1：intake_notify_status 半迁移残留回填 ${intakeNotifyNullBackfill.changes} 行 → 'not_sent'`);
      }

      // [1a-12] ⭐ 建单优化批 C3b（方案 20260801_v1.3 §6c）：sys_issues 补 1 列——oa_exempt（本单无需 OA
      //   立项声明标志）。INTEGER NOT NULL DEFAULT 0（同 intake_notify_status 先例：CREATE TABLE 与
      //   ALTER 双路径都写 NOT NULL DEFAULT）——0/1 无"尚未走 OA"这类独立业务含义的 NULL 态，ALTER 的
      //   DEFAULT 语义本身即可让旧行自动回填 0，不需要额外半迁移 backfill 步骤。
      const SYS_OA_EXEMPT_ISSUE_COLS = [
        ['oa_exempt', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      await alterAddMissingCols('sys_issues', SYS_OA_EXEMPT_ISSUE_COLS, '建单优化批 C3b·免 OA 声明标志');

      // [1a-13] ⭐ 系统迭代 评估工期+对接测试段+优先级/风险等级拆分 方案 v1.0（C1·§4/§10）：sys_issues 补
      //   工期/风险等级/测试周期 3 列 + 对接测试通知列组 11 列（§6 预占协议，逐字镜像 intake_notify_* +
      //   recipient 快照 + 周期令牌三件套，含 notify_sent_by——该列本身**不入 SYS_ISSUES_KEY_COLS 锚点**
      //   （同 intake_notify_sent_by/release_assignee_notify_sent_by 先例，sent_by 类列历来只由
      //   verify-sys-schema 全量保障），但仍在本次 ALTER 一并建列（同一新通道一次到位，不为它单独拆
      //   ALTER 调用）。ALTER 不带 CHECK（SQLite ALTER 补约束受限，同 needs_release/relay_notify_status/
      //   intake_notify_status 先例）——值域由服务层守卫（C2-C5 接线）+ verify-sys-schema.js 断言兜底，
      //   两路径不变量等效；跨列不变量（sending⇔token∧started_at 非空、notify_cycle_no≤主周期）本就不是
      //   单列 DB CHECK 能表达的，全靠服务端维护+verify 探针，与 ALTER/CREATE 路径是否带 CHECK 无关。
      //   NOT NULL DEFAULT 常量列（liaison_test_cycle_no/liaison_test_notify_cycle_no/
      //   liaison_test_notify_status）可通过 ALTER 回填旧行（同 intake_notify_status 先例，无需额外
      //   半迁移 backfill UPDATE）。⚠️ 顺序铁律同 [1a]：本组列已入 SYS_ISSUES_KEY_COLS——ALTER 必须在
      //   下方 [2] 关键列复查之前完成（本 ALTER 段落全程在 [2] 之前，天然满足）。
      const LIAISON_TEST_ISSUE_COLS = [
        ['estimated_effort_days', 'REAL'],
        // [部署 dry-run 2026-08-06 抓获·「两套语义」第三实例] C1 原定义无 CHECK（292-M1 只补了两根新列
        // 漏了这根老列）——生产真实样本 dry-run 发现迁移库 risk_level 无值域约束，补与新建表 DDL 同款。
        ['risk_level', "TEXT CHECK (risk_level IS NULL OR risk_level IN ('一级','二级','三级'))"],
        ['liaison_test_cycle_no', 'INTEGER NOT NULL DEFAULT 0'],
        ['liaison_test_recipient_id', 'INTEGER'],
        ['liaison_test_recipient_name', 'TEXT'],
        ['liaison_test_notify_status', "TEXT NOT NULL DEFAULT 'not_sent'"],
        ['liaison_test_notified_at', 'DATETIME'],
        ['liaison_test_notify_message_key', 'TEXT'],
        ['liaison_test_notify_error', 'TEXT'],
        ['liaison_test_read_at', 'DATETIME'],
        ['liaison_test_notify_sent_by', 'INTEGER'],
        ['liaison_test_notify_cycle_no', 'INTEGER NOT NULL DEFAULT 0'],
        ['liaison_test_attempt_token', 'TEXT'],
        ['liaison_test_attempt_started_at', 'DATETIME'],
        // [codex 291 号 H-1 收口] 附件周期水位——ALTER 支持 NOT NULL + 常量 DEFAULT 回填旧行（同
        //   liaison_test_cycle_no/relay_notify_status 先例），CHECK 仅新库 CREATE 带。
        // [codex 292 号 M-1 收口] ALTER 版与新建表 DDL 同款列级 CHECK——两条建列路径约束语义一致，
        // 迁移库同样拒绝负数/非整数水位（负水位会把历史附件误判为本轮凭证）。
        ['liaison_test_attachment_watermark', "INTEGER NOT NULL DEFAULT 0 CHECK (typeof(liaison_test_attachment_watermark) = 'integer' AND liaison_test_attachment_watermark >= 0)"],
      ];
      await alterAddMissingCols('sys_issues', LIAISON_TEST_ISSUE_COLS, 'C1 工期对接测试与风险等级拆分 方案 v1.0 §4');
      // ⭐ [C9 无 commit 单验收直翻·方案 v1.7 §10.1 字段契约] online_source：「已上线」这一状态是**怎么
      //   来的**——批次发布 / 免上线直翻 / 存量历史。v1.7 撤回了"纯 DTO 派生"方案（297-B M-a：存量
      //   已上线∧无批次关联单会被误分类成免上线），改为物理列显式记录。
      //   仅免上线直翻路径写 'no_commit_acceptance'；批次发布路径**不写**（留 NULL，由"有 active 批次
      //   关联"这一事实推出 release_publish）；存量历史行天然 NULL 且无批次关联 → unknown_legacy。
      //   ⭐ [C9-fix M2④] **独立成组、自带 label**（原先搭在 LIAISON_TEST_ISSUE_COLS 尾巴上）——
      //     alterAddMissingCols 的第三参数 label 是**迁移日志行**的归属说明（落点=该函数内的
      //     `logger.info('[系统迭代迁移] {表} ADD COLUMN {列} {类型}（{label}）')`，**不写 sys_schema_migrations
      //     表**——那张表只被 [1a-6] 那类"有 migration_key 的一次性数据迁移"用，纯 ALTER 补列不登记）。
      //     搭车会让本列的建列日志印成"C1 工期对接测试与风险等级拆分"，与它真实的方案出处（v1.7 §10.1）
      //     不符。生产升级时这行日志是"这根列什么时候、因为哪份方案加的"的唯一现场证据，归属错了等于把
      //     排障线索写成误导。分组不改变执行语义（alterAddMissingCols 幂等、逐列判存在性），只改归属与可读性。
      //   ⚠️ 刻意**不加 CHECK**，理由三条（v1.139 risk_level「ALTER 漏 CHECK」前车之鉴要求逐条论证，
      //     不是默认省事）：
      //     ① 本列语义是"来源标签"，值域**开放且预期会增长**——将来若有第三种上线来源（如批量导入
      //        标记历史上线），加值只需改写入点；带 CHECK 的话 SQLite 建表后 CHECK 不可改，会重演
      //        `sys_issue_dev_commits.component` 那种"新枚举=新旧库两套语义"的坑（§10.3 已明文规避）。
      //     ② 本列**只被读、不被判**：DTO 派生只做 `列值非空 → no_commit_acceptance` 的存在性判断，
      //        没有任何逻辑分支依赖具体字面量相等，脏值最坏后果是 DTO 显示成 no_commit_acceptance，
      //        不影响状态机/权限/写路径任何一条。
      //     ③ 唯一写入点是本批新增的直翻分支，写的是源码内字面量常量（ONLINE_SOURCE_NO_COMMIT），
      //        不接受任何外部输入——不存在"用户传个畸形值进来"的攻击面。
      //   （与 risk_level 的差别正在此：那根列的值参与 UI 分级与业务判定、且由用户输入，缺 CHECK 是真缺口。）
      const C9_ONLINE_SOURCE_ISSUE_COLS = [
        ['online_source', 'TEXT'],
      ];
      await alterAddMissingCols('sys_issues', C9_ONLINE_SOURCE_ISSUE_COLS, 'C9 无commit直翻 方案v1.7§10.1');
      // [codex 291 号 H-2 收口] sys_issue_timeline 首次经 alterAddMissingCols 补列（此前该表无 ALTER 路径，
      //   旧库靠 CREATE TABLE IF NOT EXISTS no-op 停在原 12 列——TEXT 列无 CHECK 语义损失，ALTER 补列本身低风险）。
      await alterAddMissingCols('sys_issue_timeline', [['payload_json', "TEXT CHECK (payload_json IS NULL OR json_valid(payload_json))"]], 'D22 pass 凭证结构化留痕（291 号 H-2·292 号 M-4 补 json_valid 约束与 DDL 同款——读侧 JSON.parse/json_extract 不被脏值击穿的 DB 层保证）');
      // [codex 293 号 H·294 号裁定=报警级登记（阻断不采纳）] 无 CHECK 存量列检测——**有意不阻断启动**：
      //   本检测手段（DDL 文本 includes）是尽力而为的可观测性辅助非精确 oracle（294-M1 自认脆弱可假阳），
      //   脆弱检测+硬阻断=假阳性可瘫痪生产启动，误杀面大于防护收益；「无约束存量列」不存在是**部署
      //   盘点结论**（295 号措辞降格：唯一已知实例=本地已重建修复·生产列不存在走含 CHECK 定义·测试库
      //   每次新建——由盘点证据而非代码结构保证，维护脚本/直接 SQL 等旁路写入不在覆盖内），且应用层校验枚举
      //   （intake_accept/pass 写点）本就拦非法值——CHECK 是纵深第二层非唯一防线。按登记接受归类
      //   （对齐 282-N3 范式：风险接受诚实归类不宣称机制闭合），部署清单含「生产无两列」前置核验项。
      // [codex 293 号 H 原始语境] alterAddMissingCols 只在缺列时建列，
      //   「291 中间版本迁移过（列在但无 CHECK）」的库不会被自动补约束。该形态的库已知仅本地 dev 库
      //   曾出现（2026-08-06 已 DROP+重建修复）；生产两列不存在将走上方含 CHECK 定义（发布前置条件之一）。
      //   本断言把「不该存在的形态」变可观测：SQLite 的 ALTER ADD COLUMN 会把新列全文（含列级 CHECK）
      //   拼进 sqlite_master 的表 DDL 文本，故列名在而 CHECK 片段不在 ⇒ 无约束存量列，大声报警。
      for (const [tbl, col, checkFrag] of [
        ['sys_issues', 'liaison_test_attachment_watermark', "typeof(liaison_test_attachment_watermark) = 'integer'"],
        ['sys_issue_timeline', 'payload_json', 'json_valid(payload_json)'],
        ['sys_issues', 'risk_level', "risk_level IN ('一级','二级','三级')"],   // dry-run 抓获后补入检测面
      ]) {
        const ddlRow = await new Promise((resolve, reject) => {
          db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [tbl], (err, r) => err ? reject(err) : resolve(r));
        });
        const ddl = (ddlRow && ddlRow.sql) || '';
        if (ddl.includes(col) && !ddl.includes(checkFrag)) {
          logger.error(`[系统迭代迁移][293-H 检测] ${tbl}.${col} 存在但缺 CHECK 约束（无约束存量列·需按 292 号 M-1 同款 DROP+重建修复），当前 DDL 片段核对失败`);
        }
      }

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

      // [2] 十表关键列 PRAGMA 复查（抽样锚点，非全字段；[1a]/[1a-2]/[1a-4]/[1a-10] ALTER 后的最新列集）
      //   ⚠️ 表数随 SYS_REQUIRED_TABLES 增长（C2a 起含 sys_issue_delete_audit，上线体统一重构 C0 起含
      //   sys_release_duty_roster）——新增表建完必须同时进 SYS_REQUIRED_TABLES（表在）与本 checks（列全），
      //   只进一处会留"表在但列缺"的半成品放行缺口。
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
        // ← C2a 物删审计表（角色权限重构）：结构全列在才放行——审计列缺失 = 删除留不下证据，fail-closed 到 503。
        ['sys_issue_delete_audit', SYS_DELETE_AUDIT_KEY_COLS],
        // ← 上线体统一重构 C0（方案 v3.4 §6.2）：排班表，结构全列在模型（同 dev_assignees/delete_audit 首版）。
        ['sys_release_duty_roster', SYS_DUTY_ROSTER_KEY_COLS],
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

  // ── 建单优化批 C1（方案 20260731_v1.2 §6b.3）：标题自动派生（描述→标题）──────────
  //   算法（复审 M-2 收口，可测试伪代码）：description 整体 trim → 按换行分割取第一个非空行 →
  //   按 Unicode code point（Array.from）截取前 40 个字符 → 有截断则追加"…"。
  //   调用前提：description 已过非空校验（主建单端点先判 DESCRIPTION_REQUIRED），故首个非空行必然
  //   存在，派生结果恒非空——不需要额外的空标题兜底分支。
  //   "40 字符"口径 = Unicode code point（终审 L·接受 ZWJ 组合 emoji/字素簇可能被拆，内部工单标题
  //   极端边缘场景，不引入 Intl.Segmenter 升级）。
  function deriveSysTitleFromDescription(desc) {
    const trimmed = String(desc == null ? '' : desc).trim();
    const lines = trimmed.split(/\r\n|\r|\n/);
    const firstNonEmptyLine = (lines.find(l => l.trim().length > 0) || '').trim();
    const chars = Array.from(firstNonEmptyLine);
    if (chars.length <= 40) return firstNonEmptyLine;
    return chars.slice(0, 40).join('') + '…';
  }

  // ⭐ 角色权限重构 C4·184 号预审（PL-1，原是 codex C4 审 Round-2 收口的 before_id 专用校验，
  //   本次抽成共享 helper）：整串十进制正整数正则 + Number.isSafeInteger 双重把关——比 parsePositiveId
  //   更严（那层用 `Number(v)` 隐式转换，会把 '1e3'/'+123'/' 123 ' 这类字符串误判成合法正整数，见
  //   parsePositiveId 与本函数的行为差异）。用于"精确过滤/翻页游标"类参数——语义歧义会直接导致查错单
  //   或翻页错位，值得比一般的正整数 ID 参数更严格。删除跨端点重复实现分别验证：本函数与旧的
  //   before_id 内联校验代码逐字等价（这次抽取零行为变化），供 GET /sys-issue-delete-audit 的
  //   before_id 与 issue_id 两个参数共用，防止两处各写一份、以后改一处忘改另一处。
  function parseStrictPositiveId(v) {
    if (typeof v !== 'string') return null;
    if (!/^[1-9]\d*$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  // datetime 规范化（核实#8 / §6.2：C3 复刻 correction normalizeCorrectionDatetime 零回归；
  //   backlog 记"datetime 校验三模块统一抽 utils/datetime-normalize.js"）。
  //   接受 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DDTHH:MM'（前端 datetime-local）等，规范化为 'YYYY-MM-DD HH:MM'；
  //   非法返 null（端点据此返 400）。
  //   codex 15 M-2：口径**分钟级**——只接受 YYYY-MM-DD HH:MM，**带秒判非法**（不再吞秒，避免 10:30:99 被
  //   规范化为 10:30 通过）。与 assigned_at 比较时见 estimate 端点（assigned_at 也归一化到分钟，同分钟视为不早于）。
  //   ── 时间格式统一 S3（20260804·锚点 D4/D10）：输出补 ':00'，入参接受"无秒"与"秒=00"两种 ──
  //   D4：库内时间统一到秒。用户填到分，**后端补 :00**（用户拍板；听过"补零≠精确、只是格式对齐"的
  //     评估后仍选做，理由=库内格式一致本身正当）。
  //   D10 幂等：秒位只接受**省略**或 **'00'** 两种——不放宽是刻意的最小必要。为什么必须放宽到 '00'：
  //     补秒后库里存的是 'HH:MM:00'，把这条记录读回来原样重提，会被自己的校验器 400 拒（改前的严格
  //     正则连 ':00' 都不认）。为什么不放宽到任意合法秒：codex 15 M-2 定的防线是"带秒判非法、不吞秒"，
  //     放开 '14:30:45' 就等于恢复吞秒，那条防线白立了。
  //   ⚠️ 与 normalizeDeadlineDT 的入参口径**刻意不同**（那个接受任意合法秒后截断），两者各有拍板出处：
  //     此处严格源自 codex 15 M-2；那处宽松源自 v1.136.0 D2「兼容 API 直调与历史值」。不是随手不一致。
  function normalizeSysDatetime(raw) {
    if (raw === undefined || raw === null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace('T', ' ');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/);   // 秒位可选，捕获后校验
    if (!m) return null;
    if (m[6] !== undefined && m[6] !== '00') return null;   // D10：秒位只认省略或 '00'（'14:30:45'/'10:30:99' 一律非法）
    // 显式逐个转换捕获组（codex 253-C L-2）：原写法 `m.map(Number)` 会把完整匹配和省略的秒位一并转成
    //   NaN，靠解构位置恰好避开——读的人容易以为 m 里每项都是有效数字，扩展字段时就会踩到。
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
    const dt = new Date(y, mo - 1, d, h, mi);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:00`;   // D4：入库到秒
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

  // ── ② 期望完成精确到时分（四处优化 D2）：deadline **专用** datetime 校验器 ──────────────────
  //   ⚠️⚠️ 为什么不直接放宽上面的 normalizeDeadline —— 它是**通用纯日期校验器**，本模块共 12 处调用，
  //     其中 8 处用在 scheduled_start（计划开工日）/ planned_date / duty_date / date_from / date_to 上，
  //     这些字段的业务口径就是"只到天"。放宽它 = 一次性把 6 个不该带时分的字段一起放开（计划开工日
  //     能填 14:30、值班日期能填时分），属跨字段污染。故新建专用函数，normalizeDeadline 原样不动。
  //   接受：'YYYY-MM-DD'（补 00:00）｜'YYYY-MM-DD HH:MM'｜'YYYY-MM-DDTHH:MM'（datetime-local 原样值）
  //         ｜'YYYY-MM-DD HH:MM:SS'（截到分钟，兼容 API 直调与历史值）
  //   输出：统一 'YYYY-MM-DD HH:MM'；空/未传 → { ok:true, value:null }（deadline 选填，沿用旧口径）
  //   ⚠️ 纯日期补 00:00 只发生在**本次确实提交了该字段**时。四个写入端点都是"未传该字段就不进分支"，
  //     所以存量纯日期行不会被动（锚点 E2：不伪造精度、不批量刷写；用户再次编辑时自行补时分）。
  function normalizeDeadlineDT(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    const s = String(raw).trim();
    if (!s) return { ok: true, value: null };   // 纯空格/空串 = 可选未填（同 normalizeDeadline）
    // codex 248 M-3：秒位必须**捕获后校验**。原写法 `(?::\d{2})?` 不捕获 ⇒ '14:30:99' 被接受并静默截成
    //   '14:30'，与错误文案里的"真实时间"自相矛盾，也让调用方误以为那个秒是合法的。
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return { ok: false, value: null };
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const hh = m[4] === undefined ? 0 : Number(m[4]);
    const mi = m[5] === undefined ? 0 : Number(m[5]);
    const ss = m[6] === undefined ? 0 : Number(m[6]);   // 秒只做合法性校验，不落库（deadline 精度到分钟）
    // 真实日期回比对：挡 2026-02-30 / 2026-13-01 这类"格式对但日期不存在"（同 normalizeDeadline 范式）
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return { ok: false, value: null };
    // 时分秒范围：正则只锁了"两位数字"，25:00 / 12:70 / 14:30:99 都要靠这里挡
    if (hh > 23 || mi > 59 || ss > 59) return { ok: false, value: null };
    const pad = (n) => String(n).padStart(2, '0');
    // 时间格式统一 S3（D4）：输出补 ':00' 入库。入参口径**不动**——它本就接受任意合法秒后截断
    //   （v1.136.0 D2「兼容 API 直调与历史值」），已天然幂等，不需要为 D10 再放宽或收紧。
    //   ⚠️ 秒仍不落库：deadline 语义精度到分钟，':00' 是格式对齐不是精度声明（同 D4 的自我认知）。
    return { ok: true, value: `${m[1]}-${m[2]}-${m[3]} ${pad(hh)}:${pad(mi)}:00` };
  }

  // ── deadline 的**文本**截断件（时间格式统一 S3·D3）────────────────────────────────────
  //   ⚠️ 不能用 truncToMinute：它匹配 `^(日期) (时:分)`，对**纯日期**返回 null——存量 deadline 正是纯日期，
  //     拿它拼留痕会把 '2026-08-10' 变成"空"，凭空造出一条"从空改为 X"的假记录。
  //   与前端 siFmtDeadline 同款语义（[[feedback_same_principle_across_layers]]：前端已经想清楚的事，
  //     后端不能想当然换个件）：纯日期原样、带时分截到分、认不出的原样露出。
  //   用途仅限**给人看的文本**（timeline summary / 通知文案）；入库一律用 normalizeDeadlineDT 的带秒值。
  function deadlineToMinuteText(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    // ⚠️ 本正则与前端 `siFmtDeadline` 是**同一份契约的两处实现**，必须逐字同源（含时区后缀分支）。
    //   契约向量表钉在两侧：后端 `scripts/verify-sys-time-precision.js` 的 CONTRACT ↔ 前端 Playwright [T24]
    //   的 dlProbe。改任一侧的规则必须两边一起改，否则一侧红。（漂移实例见 codex 审 253-B 归档。）
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (!m) return s;
    return m[2] ? `${m[1]} ${m[2]}` : m[1];
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
  // S2（bug暂缓方案 20260803 v0.4 §4.5b·codex 236 L-1）：族粒度做不到"同族内排除单个状态"——
  //   D_PRE.bug 现含 ['待处理','已暂缓']（S1 §4.1 新增「已暂缓」后），reassign 需要保留「待处理」
  //   （92 号审既有能力，verify S33 断言锁定）同时排除「已暂缓」（§4.5 暂缓期改派冻结）。加一层状态级
  //   排除表，叠在族门之上——运行时判定（assertMemberActionFamilyAllowed 消费）与声明校核
  //   （verify-sys-meta.js [6] authoritative 计算同样消费 memberActionAuthoritativeStatuses）必须
  //   共读同一份，防止重演 S1→S2 那次"声明与运行时脱节"的漂移（reassign.from 曾因此需要 S1 补态）。
  const MEMBER_ACTION_STATUS_EXCLUDE = {
    reassign: { bug: ['已暂缓'] },   // §4.5b：真闸=assertRosterNotFrozen/HOLD_ROSTER_FROZEN（见下方），本表只影响声明的合法态集合
  };
  // 某 (actionKey, issueType) 的权威合法状态集合 = 族门展开 - 状态级排除。verify-sys-meta.js [6] 与
  // assertMemberActionFamilyAllowed 均消费本函数，杜绝两处各自维护副本再度漂移。
  function memberActionAuthoritativeStatuses(actionKey, issueType) {
    const families = memberActionFamiliesFor(actionKey, issueType);
    if (!families) throw new Error(`memberActionAuthoritativeStatuses: 未登记的 actionKey="${actionKey}"`);
    const excluded = (MEMBER_ACTION_STATUS_EXCLUDE[actionKey] && MEMBER_ACTION_STATUS_EXCLUDE[actionKey][issueType]) || [];
    return families.flatMap(fam => SF.getFamilyStatuses(issueType, fam)).filter(s => !excluded.includes(s));
  }
  function assertMemberActionFamilyAllowed(actionKey, issueType, status) {
    const allowedFamilies = memberActionFamiliesFor(actionKey, issueType);
    if (!allowedFamilies) throw new Error(`assertMemberActionFamilyAllowed: 未登记的 actionKey="${actionKey}"`);
    const family = SF.familyOfStatus(issueType, status);
    // S2：族内单点排除（族门粒度不够时的补丁层，见上方 MEMBER_ACTION_STATUS_EXCLUDE 注释）——当前仅
    //   reassign×bug×已暂缓 命中，其余 actionKey 排除表为空，本行零影响（含 commit 行编辑三端点）。
    const excluded = (MEMBER_ACTION_STATUS_EXCLUDE[actionKey] && MEMBER_ACTION_STATUS_EXCLUDE[actionKey][issueType]) || [];
    if (!family || !allowedFamilies.includes(family) || excluded.includes(status)) {
      // M6（91 号审）：族不满足是"当前主状态/成员动作不匹配"业务语义，改归 INVALID_STATUS（409）——
      //   GATE_INVARIANT 收窄只留主状态非法边/进族 roster 不满足/W-GATE UPDATE changes 冲突三类"守卫内部不变量"。
      throw new SysTransitionError(409, 'INVALID_STATUS', `当前状态「${status}」不允许该成员动作（${actionKey}）`);
    }
    return family;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // [C9 无 commit 单验收直翻「已上线」·方案 v1.7 §10.1]
  // ══════════════════════════════════════════════════════════════════════════════════════
  //   诉求：前后端都没有 commit 的单（配置/数据/文档类工作），验收通过即生效，不必挂上线批次。
  const SYS_ONLINE_STATUS = '已上线';                          // 与批次发布路径同值（§10.1 字段契约：status 一列不分家）
  const ONLINE_SOURCE_NO_COMMIT = 'no_commit_acceptance';      // online_source 唯一由本路径写入的字面量
  // ⭐ [C9-fix2 H1] 免上线直翻边的**唯一合法起点**——引擎自调准入判定的门（见 sysIssueTransition 内
  //   「[1b] C9 裁决引擎自调」）。刻意起一个作用域写死在名字里的常量名（而非通用的 SYS_VERIFY_STATUS）：
  //   它只表达"C9 这条边从哪来"，不是本模块「待验证」这个状态的通用别名，避免后人拿它去替换别处字面量。
  //   与守卫 status-transition-guard.js 的 NO_COMMIT_ONLINE 分支（before 必须是「待验证」）同一事实，
  //   两处若漂移，守卫会先一步 409 GATE_INVARIANT 报出边非法（fail-closed 方向）。
  const SYS_NO_COMMIT_ONLINE_FROM_STATUS = '待验证';
  const SYS_NO_COMMIT_ONLINE_SUMMARY = '无提交免上线（验收通过自动结单）';
  // 「active 批次状态集合」——[[feedback_status_set_enumerate_not_merge]] 逐状态核出，不归并：
  //   `sys_releases.status` 的 DDL CHECK 全集只有两个值（见本文件 sys_releases CREATE TABLE 的
  //   `CHECK (status IN ('计划中','已发布'))`），两个都算 active。
  //   ⚠️ 方案 §10.1 原文提到"已撤销/已作废批次不算 active"——**当前 schema 里没有对应状态值可排除**
  //     （C9 预检文档已登记这条口径落差）。核实结论：cancel-schedule 撤销的是"执行人安排"，不是批次本身
  //     （它软删 sys_release_executors 行 + 写 timeline，**从不改 sys_releases.status**——全文
  //     `UPDATE sys_releases SET status` 仅一处，在 _publishReleaseCoreInTxn 内做 计划中→已发布）。
  //     故"撤销批次"这个业务概念根本不通过 status 表达，方案那句是前瞻性表述。本集合当前**等价于**
  //     "该 release_id 在 sys_releases 里存在任意一行"，但仍显式写出两个状态值而非退化成 EXISTS——
  //     将来真引入第三态时，这里会因为"新状态没被列进来"而立刻暴露需要决策，退化写法则会静默把它当 active。
  const SYS_ACTIVE_RELEASE_STATUSES = ['计划中', '已发布'];
  /**
   * [C9·§10.1 字段契约「来源区分」] 「已上线」来源三分支派生——**后端唯一权威**（297 M6），
   *   前端只按 DTO 渲染、不自行判定（否则前后端两套判据必然漂移）。
   *   判定顺序有意如此，不可互换：
   *     ① 有 active 批次关联 → 'release_publish'（批次发布是既有主路径，优先认领；即使 online_source
   *        因历史脏数据非空，"挂着 active 批次"这个事实也更强）
   *     ② online_source **严格等于** ONLINE_SOURCE_NO_COMMIT → 'no_commit_acceptance'（本批直翻路径唯一写入点）
   *     ③ 关联空 ∧ 列非该值 → 'unknown_legacy'（存量历史，**不伪装成免上线**——297-B M-a 正是为此撤回了
   *        "纯 DTO 派生"方案：没有物理列时这一格会被误分类成免上线）
   *   ⚠️ 入参 row 需含 status/release_id/online_source；调用点若用列投影 SELECT 必须把这三列取全。
   *   ⭐ [C9-fix2 M1·严格等值] ② 的判据从"非空即认"收紧为 `=== ONLINE_SOURCE_NO_COMMIT`。原写法
   *     （`!= null && !== ''`）把**任意非空值**折叠成免上线：本列无 DDL CHECK（见 :1634 一带三条理由），
   *     直连 SQL / 迁移脚本 / 将来新增的第二种来源标签写进任何字符串，都会被这一格认领成"免上线直翻"。
   *     那是**把不认识的东西说成认识的**——比报 unknown 更坏，因为它给出的是一个看起来确定的错误答案。
   *     收紧后：非空但不认识的脏值一律落 ③ unknown_legacy（含直连脏值形态），语义=「这单确实上线了，
   *     但来源标签不是本模块写的、无法归类」——如实说不知道。DTO 三值契约不变，前端零改动。
   *     ⚠️ 若将来真新增第二种 online_source 取值，必须在此**显式新增分支**（而不是放宽回"非空即认"）——
   *       那正是本次收紧要挡住的退化路径。
   *   ⚠️ 这里的"active 批次关联"用 `release_id 非空` 近似，**不再查 sys_releases.status**：读点是热路径
   *     （列表逐行），为一个展示标签逐行发子查询不划算。
   *     ⭐ [C9-fix2 H2-b·注释订正] 原注释称"release_id 非空却指向非 active 批次的组合在当前 schema 下
   *       不可能"，理由是"status 全集两值都算 active"——该论证**只排除了状态形态，漏了「批次行被删」形态**：
   *       release_id 指向一条已不存在的 sys_releases 行（悬垂指针）时，它既不是 active 也不是非 active，
   *       上述论证覆盖不到。evaluateNoCommitDirectOnline 的条件②自己就显式处理了这个形态（用 `SELECT 1
   *       FROM sys_releases WHERE id=? AND status IN(...)` 查不到即判"无 active 关联"放行直翻），
   *       于是写侧容忍悬垂、读侧（本函数）却因 release_id 非空一律先认 release_publish ⇒ 写读分裂。
   *     现状：该分裂已由 [C9-fix2 H2-a]「直翻写点同事务把 release_id 置 NULL」堵死——**本函数优先序的
   *       安全性现在依赖那条不变量**（直翻单落库后 release_id 恒 NULL，不会带着悬垂指针进 ①）。
   *       动那条写点前必须回来看这一段。若将来 sys_releases 真引入第三态（非 active），本函数与
   *       evaluateNoCommitDirectOnline 仍须同批修改——两处已互相点名。
   */
  function deriveOnlineSourceKind(row) {
    if (!row || row.status !== SYS_ONLINE_STATUS) return null;
    if (row.release_id != null) return 'release_publish';
    if (row.online_source === ONLINE_SOURCE_NO_COMMIT) return 'no_commit_acceptance';
    return 'unknown_legacy';
  }

  /**
   * 准入四条件判定（§10.1）——**必须在验收通过的同一写事务内调用**（sysBeginImmediate 已持有）。
   * 返回 { directFlip: boolean, deletedCommitCount: number, blockedBy: string|null }。
   * 只读不写；写由调用方在同一事务的主 UPDATE 里做（条件③状态 CAS 即那条 UPDATE 自身）。
   */
  async function evaluateNoCommitDirectOnline(issueId, issueRow) {
    // 条件①：active commit 行数=0（任意 component·含 §10.3 HRD 单组）
    //   ⚠️ 297-M1：**只信数据库**——不读 payload、不读任何"前端说这单没有 commit"的标志位。
    //   ⚠️⚠️ **C0 盘点纠偏（方案与实现的口径落差，编码时实测发现）**：方案 §10.1 条件①原文写的是
    //     `removed_at IS NULL`，但 `sys_issue_dev_commits` **根本没有 removed_at 列**——该表用的是
    //     **物理 DELETE**（见 `DELETE FROM sys_issue_dev_commits WHERE id = ?`），不是软删。
    //     照方案字面写会直接 `SQLITE_ERROR: no such column: removed_at`（本批首跑实测撞到）。
    //     故 active 判定退化为"表内该 issue 的行数"——行存在即 active，无软删态可排除。
    const activeRow = await dbGetAsync(
      `SELECT COUNT(*) AS c FROM sys_issue_dev_commits WHERE issue_id = ?`,
      [issueId]
    );
    const activeCommitCount = Number(activeRow && activeRow.c) || 0;
    // 条件④配套数据：N = **发生过多少次「删除提交」动作**。
    //   ⚠️ 同上落差的连带影响：commit 行被物删后**表里不留任何痕迹**，这个 N 不可能从 commits 表数出来。
    //     真正的删除留痕在 append-only 的 `sys_issue_dev_events`（`action='delete-commit'`，DDL CHECK
    //     枚举 11 值里明列）——那张表无 UPDATE/DELETE API，是本仓唯一可信的"曾经删过"事实源。
    //   ⭐⭐ [C9 对抗审 codex 317·M2 订正] N 的准确语义是**删除动作次数**，**不是"唯一 commit 数量"**——
    //     这条区别是可观测的，不是理论边角：原注释断言"同一条 commit 被删两次不可能（物删后该行不复存在）"，
    //     只说对了一半。同一条**行 id** 确实删不了两次，但完全可以「提交 commit（某 ref）→ 删 → 用**同一个
    //     ref** 重新提交（这是**新行**）→ 再删」——这是"填错删掉重填"的正常操作，删两次就落 2 条
    //     delete-commit 事件，N=2，而"涉及的不同 commit"只有一个 ref。故本函数给出的 N 会把"同一 commit
    //     反复删"累计进去，读者**不能**把它读成"有 N 条不同的提交被删过"。verify-sys-c9-direct-online [5]
    //     的"同 ref 重加再删"序列钉死了这条语义（N=2 而非去重的 1）。
    //     ⚠️ 也因此，所有消费 N 的文案（响应体 / timeline / 前端提示）都必须用"发生过 N 次删除提交动作"
    //       这类措辞，绝不能用"N 条已删提交记录 / N 条提交"——后者会被读成 commit 计数（本批已统一订正）。
    //     ⚠️ 与"当前已软删行数"口径的关系：本表是纯物删，无软删态，故不存在"软删行数"这个量；将来若
    //       commits 表改成软删 + 可恢复，"动作次数"与"当前软删行数"会分岔，届时须重新裁定文案用哪个口径。
    const deletedRow = await dbGetAsync(
      `SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id = ? AND action = 'delete-commit'`,
      [issueId]
    );
    const deletedCommitCount = Number(deletedRow && deletedRow.c) || 0;
    if (activeCommitCount > 0) return { directFlip: false, deletedCommitCount, blockedBy: 'active_commits' };
    // 条件②：无 active 批次关联——双侧 NOT EXISTS 形态（§10.1/297-B M-b 形态写死，列名经 C0 盘点校准）。
    //   单侧字段 `release_id IS NULL` 与批次侧状态一并判：release_id 指向一条已被物理删除/不存在的批次行时
    //   同样算"无 active 关联"（NOT EXISTS 自然覆盖），不需要额外的悬垂外键分支。
    if (issueRow.release_id != null) {
      const ph = SYS_ACTIVE_RELEASE_STATUSES.map(() => '?').join(',');
      const relRow = await dbGetAsync(
        `SELECT 1 AS hit FROM sys_releases r WHERE r.id = ? AND r.status IN (${ph})`,
        [issueRow.release_id, ...SYS_ACTIVE_RELEASE_STATUSES]
      );
      if (relRow) return { directFlip: false, deletedCommitCount, blockedBy: 'active_release' };
    }
    return { directFlip: true, deletedCommitCount, blockedBy: null };
  }

  // S2（bug暂缓方案 §4.5·roster 冻结）：bug 单 status='已暂缓' 时，加人/移人（含本人自移除）/改派/
  //   开脱/开脱恢复五个成员端点全部拒绝，消除"暂缓期成员被移空 → resume 撞 enteringDev 门
  //   （rosterActiveCount>=1）→ 400 → 单永久卡死，唯一出口只剩不可逆 void"的死锁链（§4.5 原文）。
  //   ⚠️ 该链不需要任何误操作即可触发：DELETE /dev-assignees/:id 授权是「协调人 ∨ 本人」，开发能把
  //   自己移出单子（转岗交接时是自然动作）。
  //   ⚠️ bug-only：变更流「已暂缓」的成员操作是既有已上线行为，本函数只在 issueType==='bug' 时生效，
  //   不得误伤（§10.4 第 19 条断言锁定）。刻意做成独立函数、在各端点内显式调用（而非塞进
  //   assertMemberActionFamilyAllowed 内部）——后者被 commit 行编辑三端点共用（MEMBER_ACTION_FAMILY_MATRIX.commit），
  //   把冻结逻辑写进共享函数会连带影响未在本方案范围内的 commit 编辑端点，故显式收窄到 5 个目标端点各自调用。
  function assertRosterNotFrozen(issueType, status) {
    if (issueType === 'bug' && status === '已暂缓') {
      throw new SysTransitionError(409, 'HOLD_ROSTER_FROZEN', '暂缓期成员名单已冻结，请先恢复（resume）后再调整');
    }
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
      ? `, notify_status = 'not_sent', notified_at = NULL, notify_message_key = NULL, notify_error = NULL, read_at = NULL` +
        `, notify_sent_by = NULL`   // C2b：not_sent ⟹ sent_by 空（留着会造出「没发过、却记着谁发的」违约行）
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
      `SELECT dev_estimated_at, blocked, needs_feasibility, feasibility_conclusion, feasibility_requirement_confirm, feasibility_risk, estimated_effort_days
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
    // [C7 工时评估补全·方案 v1.7 §9.1] 工期资格判定从 `nf=1 ∧ feature` **整体外提**到"feature/improvement
    // 两类型 × nf 两值"全覆盖，与 submit 闸门（handleDevSubmit 内同名检查）逐条同构：
    //   ① 类型维度扩围：C2 原口径"必填=仅 nf=1 的 feature；improvement 选填"已废止——用户 2026-08-06 拍板
    //      批1改造B 已把 risk_level 从 feature-only 扩到 feature+improvement，C7 对工期做同款对称扩围，
    //      两个字段自此在"变更类单据"上口径一致（见 case 'intake_accept' 处同批注释）。
    //   ② nf 维度补齐：原判据整段嵌在 `needs_feasibility === 1` 分支内，nf=0 的单**从来不过工期资格**——
    //      那是 C2 的结构性缺口（nf=0 没有 feasibility 端点可填，工期就无人写、GATE 也就无从判），C7 给
    //      estimate 端点补上写点后该缺口才有条件闭合，故本次把检查移出 nf 分支、对两值统一施加。
    // 位置在 `!['feature','improvement'].includes(issueType) → return true`（上方）之后，故 bug/config
    // 天然不受影响，无需再加类型判据。
    // [codex 269 号 M-1 存储值复查·保留]：不能只判"非 NULL"就等于合法——DDL CHECK 仅新库 CREATE 路径带，
    // 旧库 ALTER 路径没有（C1 既有降级拍板，见 alterAddMissingCols 调用处注释），脏值（历史直连 SQL/
    // 迁移写入的 1.3、字符串等非法值）可以合法落库到已上线旧表。GATE 是读侧最终防线，必须复用
    // normalizeSysEffortDays 重新验一遍存量值，ok=false（格式非法）或 value=null（未填）两种情况
    // 一视同仁视为"资格未过"——与写入口（estimate/feasibility/submit）同一套判定函数，非各自独立实现。
    // ⚠️ GATE 失败=静默 defer（gate_deferred_at 打标，无错误码），语义不变——本次只扩判据覆盖面，
    //   不碰 runWGate 的打标/消费链（消费点见 estimate/feasibility 端点内 `if (row.gate_deferred_at)`）。
    const effortCheck = normalizeSysEffortDays(row.estimated_effort_days);
    if (!effortCheck.ok || effortCheck.value === null) return false;
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
  // [工期对接测试与风险等级拆分 方案 v1.1 §6/D20·C4] hasValidLiaison——判该单当前 intake_liaison_id 是否
  //   仍指向一个 active 受理人（§3.0 决策树 ⑥ 判据）。返回解析出的 {id,name}（直接可用于通知列组写入，
  //   免重复查 users 表）；查不到/未在池内 → null（fail-closed，⑥ 分支据此判定降级）。
  async function hasValidLiaison(issueId) {
    const row = await dbGetAsync('SELECT intake_liaison_id FROM sys_issues WHERE id = ?', [issueId]);
    if (!row || !row.intake_liaison_id) return null;
    const activeLiaisons = await resolveActiveSysIntakeLiaisons();
    return activeLiaisons.find(l => l.id === row.intake_liaison_id) || null;
  }

  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0·C4 合并修复批 275-M1] 统一花名册"完成度/资格"分析——
  //   此前 runWGate 的 ②③④ 三层防线、liaison_test_pass ①b 复查、以及 sysIssueTransition [2b] 通用守卫/
  //   assign/resume-degrade/release-publish 四处 guard 调用点，各自手写一份 `rows.length` +
  //   `filter/every(dev_status...)` 的等价逻辑（同一判断散落 5+ 处，逐字相同——典型漂移温床）。收敛为
  //   单一纯函数：输入=(dev_status) 行数组（形如 `[{dev_status:'pending'}, ...]`），输出五个计数/派生量。
  //   ⚠️ 275-M1 指出的真实缺口：liaison_test_pass ①b 此前只数 pendingCount（=0 即判"全完成"），未检查
  //   unknownCount——若花名册出现"合法交付行(code_submitted/no_code) + 未知 dev_status 脏值行"并存，
  //   unknown 行既非 pending 也非合法交付，allComplete 判定会被它绕过（不算 pending，被当"已处理"）而
  //   放行 pass，与 runWGate ② 层"未知 dev_status 一律阻断"的 fail-closed 精神矛盾。现在两处共用同一份
  //   分析结果，pass 复查显式检查 unknownCount>0 直接拒绝。
  //   KNOWN_DEV_STATUSES 与原 runWGate ② 层定义逐字一致，未新增/删减任何合法值。
  const KNOWN_DEV_STATUSES = ['pending', 'code_submitted', 'no_code', 'excused'];
  function analyzeRosterForGate(rows) {
    const list = rows || [];
    const activeCount = list.length;
    const pendingCount = list.filter(r => r.dev_status === 'pending').length;
    const deliverableCount = list.filter(r => r.dev_status === 'code_submitted' || r.dev_status === 'no_code').length;
    const unknownCount = list.filter(r => !KNOWN_DEV_STATUSES.includes(r.dev_status)).length;
    return {
      activeCount, pendingCount, deliverableCount, unknownCount,
      allComplete: activeCount > 0 && pendingCount === 0,
      hasDeliverable: deliverableCount > 0,
    };
  }

  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0·C4] runWGate 改造——feature 类型走新的 ①②③④⑥⑦ 分型
  //   决策树（⑤ 已删，D21：electRepresentative 结构性保证全员 excused 场景不可达，见方案 §3.0 详述），
  //   improvement/bug 维持原有 DEV↔VERIFY 二元判定不变（本次改造范围严格收窄为 feature-only，不触碰
  //   两者既有稳定路径）。
  async function runWGate(issueId, issueType, currentStatus, actor) {
    const inDev = SF.isInFamily(issueType, currentStatus, 'DEV');
    const inVerify = SF.isInFamily(issueType, currentStatus, 'VERIFY');
    // LIAISON_TEST 对 improvement/bug 恒空数组（status-families.js）→ isInFamily 恒 false，两者不受影响。
    const inLiaisonTest = SF.isInFamily(issueType, currentStatus, 'LIAISON_TEST');
    if (!inDev && !inVerify && !inLiaisonTest) return { changed: false };

    const rosterRows = await dbAllAsync(`SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [issueId]);
    // [方案 §3.0-②③④·C4·275-M1 收敛] 花名册计数统一走 analyzeRosterForGate（定义见上方，含未知
    //   dev_status 防御性校验——DDL 无 CHECK 约束，理论上恒 ∈ 已知 4 态但缺 DB 层强制，fail-closed
    //   兜底：出现未知值一律阻断，不推进任何方向）。仅 feature 决策树消费 unknownCount 这层新防御——
    //   improvement/bug 维持原二元逻辑不引入，范围收窄不波及既有稳定路径。
    const { activeCount, pendingCount, allComplete, deliverableCount, unknownCount: invalidStatusCount } = analyzeRosterForGate(rosterRows);

    let targetStatus = null;
    let mirrorActionCode = null;   // 仅 ⑥ 降级路径写专用 actionCode，其余 GATE 转移恒 null（既有行为不变）
    let extraCasSql = '';          // ⑦ 进入待对接测试：周期号自增 + 通知列组重置，同一 CAS 内原子写入
    let extraCasParams = [];

    if (issueType === 'feature') {
      if (invalidStatusCount > 0) {
        // ② 阻断：保持不动，不推进任何方向，留可观测错误供人工核查/verify 报警
        logger.error(`[系统迭代][W-GATE] issue=${issueId} 花名册出现未知 dev_status（${invalidStatusCount}/${activeCount} 行，非 pending/code_submitted/no_code/excused），已阻断本次 GATE 判定`);
        return { changed: false };
      }
      if (inDev) {
        if (activeCount === 0 || pendingCount > 0) {
          // ③ 保持开发中（现状行为，未全完成）——不做任何事，落到下方"清 deferred"分支
        } else {
          // activeCount>0 且 pendingCount===0：资格判定
          const eligible = await isGateEligibleForVerify(issueId, issueType);
          if (!eligible) {
            // ④ 落 gate_deferred_at（全员完成但资格不足，等待 estimate/feasibility/unblock 消费）
            await dbRunAsync(
              `UPDATE sys_issues SET gate_deferred_at = COALESCE(gate_deferred_at, datetime('now','localtime')) WHERE id = ?`,
              [issueId]
            );
          } else if (deliverableCount === 0) {
            // [S12 双路审查 Opus-1 HIGH 收口] 全员 excused（activeCount>0 ∧ pendingCount===0 ∧
            //   deliverableCount===0）——花名册里没有任何一名成员真正交付过（code_submitted/no_code），
            //   全部是 excused。此前 ⑦ 分支准入不查 deliverableCount，这类单会被判定"全部通过"直接
            //   进「待对接测试」，但该态之后的每一条出口都假设"至少有 1 份交付物"：liaison_test_pass
            //   的 ①b 复查会因 hasDeliverable=false 而 409（LIAISON_TEST_PASS_INVARIANT）；
            //   liaison_test_return 的花名册重置 UPDATE（本文件 :3141 一带，WHERE dev_status IN
            //   ('code_submitted','no_code')）天然 0 行命中，触发 500 LIAISON_TEST_RETURN_RESET_INVARIANT；
            //   待对接测试态的花名册七写入口矩阵全部 409（族矩阵不含 LIAISON_TEST）；hold 同样被状态
            //   矩阵拒绝——单据落进一个只剩 void 能救的死胡同。
            //   修法：deliverableCount===0 时走与 ⑥ 同款的降级形态，直落待验证，但用专属 actionCode
            //   `liaison_test_skip_excused` 区分（该码在 last_completed_at 白名单 :4642/:4714 两处
            //   早已在位——D21 撤销决策树⑤分支后曾判定为"死值"，本次修复令其重新可达，勿动白名单本身，
            //   只更新其旁注释，见该处）。业务含义与 D11/方案 §2 一致："现网全员 excused 天然进待验证"，
            //   本质是⑥降级的姊妹分支：⑥ 是"对接人失效"导致测试段跳过，本分支是"没有交付物可测"
            //   导致测试段跳过，两者共享同一落点（待验证）与同一降级语义，仅原因不同。
            targetStatus = SF.SYS_VERIFY_STATUSES[issueType][0];
            mirrorActionCode = 'liaison_test_skip_excused';
          } else {
            const liaison = await hasValidLiaison(issueId);
            if (!liaison) {
              // ⑥ 降级：GATE 时刻无有效对接人（创建时刻恒有效，运行时可能因停用/移出白名单失效，
              //   §3.0 前提修正）——直落待验证，跳过测试段，专用 actionCode 留痕防常态化。
              targetStatus = SF.SYS_VERIFY_STATUSES[issueType][0];
              mirrorActionCode = 'liaison_test_skip_liaison';
            } else {
              // ⑦ 全部通过：进入待对接测试。周期号自增（liaison_test_cycle_no/notify_cycle_no 同得旧值+1，
              //   SQL 内自增引用旧值、不先读后写）+ 通知列组原子重置（recipient 落刚解析出的有效对接人，
              //   status='not_sent'，其余通知字段清空迎接本轮新周期，§4/§6 表）。⭐ 走到这里已隐含
              //   deliverableCount>0（上方分支已把 =0 的情形拦截并分流），是本行"⑦ 真的有交付物可测"
              //   这条不变量成立的唯一保证来源。
              targetStatus = SF.SYS_LIAISON_TEST_STATUSES[issueType][0];
              // [codex 291 号 H-1 收口] 附件周期水位——同一 CAS 原子写入 correlated 子查询取值（实测确认
              // SQLite UPDATE ... SET 里子查询可引用被更新表自身的列名做关联，无需 FROM 别名）：语义＝
              // "进入本轮那一刻，这张单已存在的最新一条 delivery/screenshot 附件 id"，pass 凭证判定据此
              // 与之后新传的附件 id 比较（见 case 'liaison_test_pass'）。COALESCE(...,0)：从未传过附件时
              // MAX 为 NULL，归零（列 DEFAULT 也是 0，两者语义一致，不留 NULL 水位）。
              // [codex 292 号 M-3 前提写实] 水位快照的线性化保证=下方 correlated 子查询与状态 CAS 同一条
              //   UPDATE 语句（SQLite 语句级原子）；跨语句并发前提=生产 sqlite3 单连接串行化+本转移事务
              //   BEGIN IMMEDIATE（全库 BEGIN 互斥域=已知 P3 挂账，非本列独有前提）。「进入测试段之后上传
              //   的附件 id 必大于水位」依赖 id 单调性——附件表为软删（status 列）不物理删行，ROWID 不复用，
              //   单调性成立。SQL 注释刻意不放模板串内（模板串 SQL 注释三类陷阱·MEMORY 在案）。
              //   [293 号 M-1 前提补实] 「已软删附件恢复为 active 绕过水位」结构性不可达——附件表唯一
              //   UPDATE 写点=置 superseded（本文件 :7734 一带·单向软删），无任何恢复端点/写路径；若未来
              //   新增附件恢复功能，须同步重审水位语义（恢复的旧附件 id>当轮水位会被计为本轮凭证）。
              extraCasSql = `, liaison_test_cycle_no = liaison_test_cycle_no + 1,
                liaison_test_notify_cycle_no = liaison_test_cycle_no + 1,
                liaison_test_recipient_id = ?, liaison_test_recipient_name = ?,
                liaison_test_notify_status = 'not_sent', liaison_test_notified_at = NULL,
                liaison_test_notify_message_key = NULL, liaison_test_notify_error = NULL,
                liaison_test_read_at = NULL, liaison_test_notify_sent_by = NULL,
                liaison_test_attempt_token = NULL, liaison_test_attempt_started_at = NULL,
                liaison_test_attachment_watermark = (
                  SELECT COALESCE(MAX(a.id), 0) FROM sys_issue_attachments a
                   WHERE a.issue_id = sys_issues.id AND a.attachment_type IN ('delivery','screenshot') AND a.status = 'active'
                )`;
              extraCasParams = [liaison.id, liaison.name];
            }
          }
        }
      } else if (inLiaisonTest || inVerify) {
        // 弹回（§3.1 点4"脏数据防御分支"）：新 pending 成员打破全完成态 → 回开发中。LIAISON_TEST 侧
        //   正常业务路径下花名册七写入口在该态已 409（族矩阵不含 LIAISON_TEST），理论不可达，此处仅兜底；
        //   VERIFY 侧同既有行为（弹回逻辑不变）。
        if (pendingCount > 0) {
          targetStatus = SF.SYS_DEV_STATUSES[issueType][0];
        }
      }
      if (inDev && !(activeCount > 0 && pendingCount === 0)) {
        await dbRunAsync(`UPDATE sys_issues SET gate_deferred_at = NULL WHERE id = ? AND gate_deferred_at IS NOT NULL`, [issueId]);
      }
    } else {
      // improvement/bug：原有二元逻辑逐字保留，本次改造不触碰。
      if (inDev && allComplete) {
        const eligible = await isGateEligibleForVerify(issueId, issueType);
        if (eligible) {
          targetStatus = SF.SYS_VERIFY_STATUSES[issueType][0];
        } else {
          await dbRunAsync(
            `UPDATE sys_issues SET gate_deferred_at = COALESCE(gate_deferred_at, datetime('now','localtime')) WHERE id = ?`,
            [issueId]
          );
        }
      } else if (inVerify && pendingCount > 0) {
        targetStatus = SF.SYS_DEV_STATUSES[issueType][0];
      }
      if (inDev && !allComplete) {
        await dbRunAsync(`UPDATE sys_issues SET gate_deferred_at = NULL WHERE id = ? AND gate_deferred_at IS NOT NULL`, [issueId]);
      }
    }

    if (!targetStatus || targetStatus === currentStatus) return { changed: false };

    assertMainStatusTransition({
      routeKind: 'GATE', action: null, actionKind: null, issueType,
      before: currentStatus, after: targetStatus,
      rosterActiveCount: activeCount, rosterAllComplete: allComplete,
    });

    // 进 VERIFY 或 LIAISON_TEST（两者都是"决策树往前走通过 GATE"的方向）时原子清除 gate_deferred_at；
    // 弹回 DEV 不清（弹回≠"资格问题已解决"，是"新增未完成成员"，与 deferred 语义无关，沿用既有口径）。
    const liaisonTestStatusForType = (SF.SYS_LIAISON_TEST_STATUSES[issueType] || [])[0];
    const enteringForward = targetStatus === SF.SYS_VERIFY_STATUSES[issueType][0]
      || (!!liaisonTestStatusForType && targetStatus === liaisonTestStatusForType);
    const clearDeferredSql = enteringForward ? ', gate_deferred_at = NULL' : '';

    // [B3·C5d 写入端半] mirror timeline 行的人话 summary——按方向选择文案，不新增 action_code（既有
    //   liaison_test_skip_excused/liaison_test_skip_liaison 两码保留不动，方向语义靠 summary+from/to 列
    //   已足够承载，跨线协调新码的前端标签/守卫 allowlist 过渡态没有必要）。
    //   四类方向穷尽本函数全部会走到本 INSERT 的分支（feature 决策树 + improvement/bug 二元逻辑共用同一
    //   段尾部代码，见函数体）：
    //     ① mirrorActionCode='liaison_test_skip_excused'（feature ⑦ 分支变体·全员 excused）
    //     ② mirrorActionCode='liaison_test_skip_liaison'（feature ⑥ 降级·对接人失效）
    //     ③ mirrorActionCode=null 且 enteringForward=true（feature ⑦ 正常/improvement·bug 二元逻辑的
    //        "全完成→VERIFY" 分支，进 VERIFY 或 LIAISON_TEST 两个目的地共用同一句——不重复状态名，前端已用
    //        from/to 渲染 →状态 后缀）
    //     ④ mirrorActionCode=null 且 enteringForward=false（"回弹"——feature 的 inLiaisonTest||inVerify
    //        分支与 improvement/bug 的 inVerify 分支，pendingCount>0 时新 pending 成员打破全完成态退回 DEV；
    //        targetStatus 走到这里只可能是 VERIFY[0]/LIAISON_TEST[0]/DEV[0] 三者之一，enteringForward=false
    //        时穷尽只剩 DEV[0] 这一种，故此分支等价于"回弹"、无需额外判空 targetStatus===DEV[0]）。
    //   ⚠️ ①②优先于③④判定——两个 skip 码只在 targetStatus=VERIFY 时被置（不可能与"回弹"同时成立），
    //   但作为方向信号它们比"是否 enteringForward"更具体（明确点出"跳过对接测试"这层业务含义），故取值时
    //   mirrorActionCode 非空优先读它，为空才退到 enteringForward 的二分方向判断。
    const W_GATE_SKIP_SUMMARY = {
      liaison_test_skip_excused: '在册开发全员开脱，跳过对接测试自动流转',
      liaison_test_skip_liaison: '对接人不可用，跳过对接测试自动流转',
    };
    const mirrorSummary = mirrorActionCode
      ? (W_GATE_SKIP_SUMMARY[mirrorActionCode] || '成员在册完成态变化，自动流转')   // 兜底：结构上不可达（mirrorActionCode 仅 3 种取值，另一种是 null），防御性保留
      : (enteringForward ? '全部在册开发已完成，自动流转' : '出现新的待提交成员，自动退回开发中');

    // [codex 101 号 MED 回填] updated_at——旧版 assign/submit 公共 UPDATE 都刷 updated_at，本处（W-GATE 状态
    // 转移）是旧版对应逻辑在新模型的落点之一，SSOT 未废除该行为，补回（范围严格限定此三处，不动
    // electRepresentative 通用选举 UPDATE——94 号 L1 裁定对暂缓/拒绝/作废终态场景"反伤效率统计终止时刻
    // 语义"仍有效，不在本次范围内）。
    const upd = await dbRunAsync(
      `UPDATE sys_issues SET status = ?, updated_at = datetime('now','localtime')${clearDeferredSql}${extraCasSql} WHERE id = ? AND status = ?`,
      [targetStatus, ...extraCasParams, issueId, currentStatus]
    );
    if (!upd || upd.changes !== 1) {
      throw new SysTransitionError(409, 'GATE_INVARIANT', '主状态已被并发修改，门禁转移失败（changes≠1）');
    }
    // M4（91 号审）：主状态确实发生变化时，同事务内补一条 sys_issue_timeline 镜像行（event_type='status_change'）
    //   ——旧 timeline 是"主状态时间线"的唯一读源（GET /sys-issues/:id 的 §5.3 演进时间线），W-GATE 触发的自动
    //   转移若不落一行，会在时间线上凭空断档。成员动作本身（add/remove/excuse/...）不写 timeline，只落
    //   sys_issue_dev_events——"codex 裁断 b"：两条审计轨迹分工明确，timeline 只记"主状态变化"，dev_events 只记
    //   "成员/roster 变化"，W-GATE 是两者的交汇点，故只在此处补一行。
    //   [方案 v1.1 §3.0-⑥/D17·C4] action_code 新增写入——此前恒 NULL（隐式），⑥ 降级路径现写专用值
    //   'liaison_test_skip_liaison'（其余转移仍是 NULL，未改变既有行为），供 last_completed_at 白名单
    //   （§3.1 点7 D17）与 verify 探针识别"这条 W-GATE 转移是否降级路径"。
    //   [B3·C5d 写入端半] summary 改人话（见上方 mirrorSummary 计算块及其注释）——不再落内部机制名
    //   "W-GATE 自动门禁转移"，按方向选四选一文案；action_code 三值维持不变（不新增码，见上方注释）。
    await dbRunAsync(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name, action_code)
       VALUES (?, 'status_change', ?, ?, ?, ?, ?, ?)`,
      [issueId, currentStatus, targetStatus, mirrorSummary, actor ? actor.id : null, actor ? actor.name : 'system', mirrorActionCode]
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

  // ⭐ 角色权限重构 v2.1 §4：OA 流程号契约守卫。
  //   口径**逐字照抄 issue_lite 的编辑口**（server.js `PATCH /issue-lite/:id` 的 oa_number 分支），
  //   不是另起炉灶 —— 两处是同一个业务概念（公司 OA 系统的流程号），值域必须一致。
  //   ⚠️ **只吃字符串、拒 number**（issue_lite 的 codex E2 审已踩过这个坑）：number 经 JSON 解析对
  //   16-20 位号有**精度舍入**面（静默存错号，事后对不上账且看不出异常）+ 丢前导零。
  //   ⚠️ 与 issue_lite 的**刻意差异**：这里**不做占位号归一**（对方空值归一为 `datadev-{id}` 维护
  //   "OA 恒非空"不变量）。本模块的 NULL 有独立业务含义 =「尚未走 OA」（OA 允许状态集之外全程恒此态），
  //   把它填成占位号会抹掉"这单到底走没走 OA"这个真实信息。本守卫用于 set-oa-number 端点的**必填**校验。
  // ⭐⭐ R4 守卫下沉（用户手测抓出绕过·191 号审 M"守卫只在单一 HTTP 处理器"当时被主会话裁定漏掉——
  //   如实记录）：变更流在「待指派」族投入开发资源的**所有入口**共用本守卫——/assign（A 路径）、
  //   dev-assignees POST（加成员）、reassign（批量差量含新增）。语义=「指派开发前必须有 OA 号」盖的是
  //   "把人放上单子"这件事本身，不是某一个端点。bug 不受限（D2）；DEV/VERIFY 族的加人不查（进族时
  //   已过本守卫·存量不追溯）。同事务自查 oa_number（不依赖调用方 row 列形状——[3.6] 踩过的坑）。
  // ⭐⭐⭐ 建单优化批 C3b（方案 20260801_v1.3 §6c 设计点4）：新契约——`oa_exempt=1`（建单弹窗显式勾选
  //   「本单无需 OA」，一次性定死，编辑窗口不提供翻转入口）单直接放行，不再走 OA 号格式校验；
  //   `oa_exempt=0` 时现状规则不变（无号 409 引导补号）。号与豁免正交：exempt=1 单事后仍可正常
  //   set-oa-number 填号（守卫任一条件满足即过，填号不联动清标志，见 set-oa-number 端点）。
  async function assertSysDevCommitmentOaGuard(issueId, issueType) {
    if (issueType !== 'feature' && issueType !== 'improvement') return;
    const r = await dbGetAsync('SELECT oa_number, oa_exempt FROM sys_issues WHERE id = ?', [issueId]);
    if (r && Number(r.oa_exempt) === 1) return;   // 免 OA 单：豁免格式校验，直接放行
    try {
      assertSysOaNumber(r && r.oa_number);
    } catch (e) {
      throw new SysTransitionError(409, 'ASSIGN_REQUIRES_OA_NUMBER', '指派开发前须先补填 OA 流程号（受理通过后由管理员在详情页填写）');
    }
  }
  function assertSysOaNumber(raw) {
    if (raw === undefined || raw === null || raw === '') {
      throw new SysTransitionError(400, 'OA_NUMBER_REQUIRED', '请填写 OA 流程号（业务方在 OA 发起的需求流程单号）');
    }
    if (typeof raw !== 'string') {
      throw new SysTransitionError(400, 'OA_NUMBER_INVALID', 'OA 流程号格式错误（须为字符串）');
    }
    const t = raw.trim();
    if (!t) {
      throw new SysTransitionError(400, 'OA_NUMBER_REQUIRED', '请填写 OA 流程号（业务方在 OA 发起的需求流程单号）');
    }
    if (!/^\d{1,20}$/.test(t)) {
      throw new SysTransitionError(400, 'OA_NUMBER_INVALID', 'OA 流程号须为 1-20 位纯数字');
    }
    return t;
  }

  // S2（bug暂缓方案 20260803 v0.4 §5.2）：hold 的授权实现——目标语义（口径 #6）=「任一活跃在册成员 ∨ admin」。
  //   ⚠️ 本函数是 bug hold **唯一防线**：transitions.js 里 bug 的 hold 条目 roleGuard/ownerGuard 均为 null
  //   （B 步骤已从 S1 的临时值 roleGuard:'admin' 改回），sysIssueTransition [3] 权限段对双 null 是**完全放行**
  //   （permitted 初值 true，双 null 时全部 if 分支不命中，见 [3] 段落）——若本函数缺失或未被正确调用，
  //   任何登录用户（含 viewer）都能暂缓他人的单。查 roster 用同事务内查询（不依赖调用方传入的 issue
  //   形状——sysIssueTransition 的 SELECT 列表未必含 roster 信息，且不同调用点 SELECT 列可能不同，直接
  //   查表最稳）。失败语义：403 + 抛错——调用点在 sysIssueTransition 事务内、任何状态 UPDATE 之前，抛出后
  //   外层 catch 会整体 rollback，状态/timeline/通知列组均不发生任何变化（§10.2 第 11b 条断言）。
  // S4 补强（codex 239 审 M-1，主会话核实成立）：不抛异常的谓词版本——供下方 assertBugHoldActor（真闸，
  //   写路径用）与 GET /sys-issues/:id 详情接口下发的 can_bug_hold 能力位（前端按钮显隐依据，读路径用）
  //   共用同一份判定逻辑，避免两处各写一份 SQL 造成漂移（此前前端用 siCaps.isRosterMember 顶替，那是
  //   "在册/历史参与成员读可见性"判定，既不判 removed_at IS NULL 也不判 dev_status != 'excused'，是拿
  //   读权限冒充写权限——已移除/已 excuse 的成员会被前端多显示按钮，点击后端才 403 拦下）。
  //   type 门限（仅 bug）由调用方在读取 can_bug_hold 前自行判断（本谓词不含 type 检查，因为
  //   assertBugHoldActor 的调用点已由 `action==='hold' && type==='bug'` 把关，type 判断没必要塞进本谓词）。
  async function canBugHold(actor, issue) {
    if (actor && actor.role === 'admin') return true;
    const actorId = actor && Number(actor.id);
    if (actorId > 0) {
      // ⚠️ 与方案 §5.2 给出的示例 SQL 有一处刻意加严：多加 `AND dev_status != 'excused'`。
      //   §5.2 的"必测角色矩阵"明确要求「失效（已移除**或已 excuse**）的原成员 hold → 403」，但示例 SQL
      //   只写了 `removed_at IS NULL`——excuse 只改 dev_status 不动 removed_at，若照抄示例 SQL，已被
      //   开脱（excused）但未移除的成员仍会通过"活跃在册"判定，与必测矩阵的 403 期望矛盾。本函数按
      //   必测矩阵的业务意图实现（excused=已不再对该单负责，不应有权暂缓），不照搬会导致 verify 测试组
      //   与实现相悖。⚠️ 仅本函数收紧，不改 assertDevMember（estimate/submit 等 W06 动作沿用既有口径，
      //   不在本方案改动范围）。
      const roster = await dbGetAsync(
        `SELECT 1 FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL AND dev_status != 'excused'`,
        [issue.id, actorId]
      );
      if (roster) return true;
    }
    return false;
  }
  async function assertBugHoldActor(actor, issue) {
    if (await canBugHold(actor, issue)) return;
    throw new SysTransitionError(403, 'NOT_AUTHORIZED_FOR_HOLD', '仅活跃在册开发或管理员可暂缓该单');
  }

  // [工期对接测试与风险等级拆分 方案 v1.1 §6·D19·C4b] 对接测试通知触发者授权——**本单在册开发 ∨ admin**。
  //   刻意不用 sysManualNotifyGuard（那套=admin∨SYS_INTAKE_LIAISON_IDS 池，服务 developer/creator/requester/
  //   relay/intake 五通道）：本通道的触发主体语义完全不同——是"开发完成交付后主动喊对接人来测"，天然应由
  //   开发本人触发，而非受理人池（让对接人自己触发通知自己，语义倒置，C0 矩阵验证清单 §A-H3 已定位为冲突）。
  //   判定口径= assertDevMember 类判定（`removed_at IS NULL`，不排除 excused——与 assertBugHoldActor 的
  //   canBugHold 刻意加严 `dev_status != 'excused'` 不同：暂缓是"谁还对本单负责"，本处只是"谁有资格喊一声
  //   对接人"，excused 成员喊一声无害，不必收紧）。admin 兜底（现网五通道 + hold 通知统一惯例）。
  async function assertLiaisonTestNotifyActor(actor, issueId) {
    if (actor && actor.role === 'admin') return;
    const actorId = actor && Number(actor.id);
    if (actorId > 0) {
      const roster = await dbGetAsync(
        `SELECT 1 FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? AND removed_at IS NULL`,
        [issueId, actorId]
      );
      if (roster) return;
    }
    throw new SysTransitionError(403, 'NOT_AUTHORIZED_FOR_NOTIFY', '仅本单在册开发或管理员可发送对接测试通知');
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
                intake_required,
                oa_number,
                intake_liaison_id,
                liaison_test_cycle_no, liaison_test_attachment_watermark
           FROM sys_issues WHERE id = ?`,
        [issueId]
      );
      if (!row) throw new SysTransitionError(404, 'SYS_ISSUE_NOT_FOUND', '迭代单不存在');
      const fromStatus = row.status;
      const type = row.type;

      // [1] 查 transition 常量（type + action + fromStatus → 唯一 transition）
      const transition = T.findTransition(type, action, fromStatus);
      if (!transition) {
        // [C6·方案 v3.4 §6.5] reopen 的 from 已收窄为仅「已关闭」（两流同步，见 transitions.js）——
        //   从「已上线」（未归档）调用 reopen 现查无此边，给更精确的 409「须先归档」而非泛化的 400
        //   INVALID_TRANSITION：语义上"动作合法但业务前置未满足"更贴近本函数其余同类场景（如
        //   NOTIFY_NOT_SENT）的 409 措辞哲学，附录 A 明列「reopen｜admin·已上线（未归档）｜409」。
        //   仅对 reopen 单独精判，不改动其余动作的 400 兜底面（那些是"动作对该态从未定义过"的真泛化拒绝）。
        //   ⭐ [codex 204 审收口] 精判加两道限定，避免收窄带来的两处语义回退：
        //   ① **类型限定**（审 HIGH-1 降级采纳为防御纵深）：仅对"确实支持归档→重开"的类型精判——用
        //      `findTransition(type,'reopen','已关闭')` 非 null 表达（config 等未登记类型恒 null，
        //      transitions.js:64 fail-closed 基石）。当前 config 流是 TODO 未实现、建单入口即 400
        //      TYPE_NOT_SUPPORTED 拒绝，故该分支当前不可达；此限定是为"未来 config 流实现时不误伤"预留。
        //   ② **权限限定**（审 MED-1 采纳·真回退）：本精判位于 [1]，早于 [3] roleGuard——收窄前该边存在时
        //      非 admin 会在 [3] 得 403，收窄后若一律给 409 等于把业务态信息（"该单已上线未归档"）暴露给
        //      无权限者，且权限语义回退。故仅 admin 得精判 409，非 admin 落下方泛化 400（不泄露业务事实）。
        if (action === 'reopen' && fromStatus === '已上线'
            && T.findTransition(type, 'reopen', '已关闭')
            && actor && actor.role === 'admin') {
          throw new SysTransitionError(409, 'ISSUE_NOT_ARCHIVED', '已上线的迭代单需先「归档」才能重开');
        }
        throw new SysTransitionError(400, 'INVALID_TRANSITION', `「${type}」单在「${fromStatus}」态不能执行「${action}」`);
      }

      // ⭐⭐ [1b] [C9-fix2 H1·裁决收归引擎] 免上线直翻的准入判定由**引擎自己发起**，结果只存引擎局部变量。
      //   改前：accept 端点构造 `opts.directOnlineInfo` 可变载体传进来，钩子在事务内 Object.assign(verdict)，
      //     引擎的 routeKind 判定 / 写点 / timeline / 响应全部消费**调用方给的那个对象**。于是"这条边够不够
      //     格进已上线"这件事，最终信的是调用方递进来的一个普通对象——任何新调用点只要伪造
      //     `{directFlip:true}` 并让钩子返回「已上线」，就能整套绕开准入四条件（codex 316 H1 攻击面①）。
      //     守卫那一层也救不了：它拿到的 routeKind 正是由同一个伪造对象推出来的 NO_COMMIT_ONLINE。
      //   改后：**调用方无从自报裁决**——载体 opts.directOnlineInfo 已整个删除（全文无残留引用），
      //     evaluateNoCommitDirectOnline 的唯一调用点就是下面这一行，在引擎内、事务内、由引擎按边的形状
      //     自己决定要不要问。伪造的 opts 至多能让 toStatus 变成「已上线」，那会撞下方 [2b] 的
      //     DIRECT_ONLINE_VERDICT_MISSING 500 fail-closed（因为局部裁决要么为 null、要么 directFlip=false）。
      //   ⚠️ 触发条件写死成「accept ∧ 事务内真实 status===待验证」两条，与守卫 NO_COMMIT_ONLINE 分支允许的
      //     唯一边形状（待验证→已上线）同源。当前三个流的 accept 都只有 待验证→待上线 一条边
      //     （transitions.js 各流 action:'accept' 各一条），故这两条件等价于"所有 accept"——行为与改前逐字
      //     相同；显式写出 from 态是为了将来若有人给 accept 加一条别的 from，C9 判定不会被静默套用上去。
      //   ⚠️ row.status 用的是**事务内锁定后读到的真实值**（BEGIN IMMEDIATE 之后），不是端点事务外预检值。
      let noCommitOnlineVerdict = null;
      if (action === 'accept' && row.status === SYS_NO_COMMIT_ONLINE_FROM_STATUS) {
        noCommitOnlineVerdict = await evaluateNoCommitDirectOnline(row.id, row);
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
      // ⭐⭐ [C9-fix2 H1·目标态覆写权收归引擎] 常规目标态（accept 恒「待上线」，由上方常量分支解析）解析完之后，
      //   **引擎**按自己那份局部裁决决定要不要改判成「已上线」。钩子契约同步收窄：resolveToStatusInTxn 对
      //   accept 只有权返回常规目标态，翻牌这一步不再经过调用方（accept 端点现已不传任何钩子，见该端点）。
      //   ⚠️ 刻意**不**做反向归一：若调用方硬塞一个返回「已上线」的钩子而裁决是 false/null，这里不把它悄悄
      //     改回「待上线」，而是让它带着「已上线」撞下方 [2b] 的 DIRECT_ONLINE_VERDICT_MISSING 500。
      //     静默纠正会把"有人开了一条没做准入判定的进已上线通道"这件事吞掉；响亮失败才是 fail-closed。
      if (noCommitOnlineVerdict && noCommitOnlineVerdict.directFlip === true) {
        toStatus = SYS_ONLINE_STATUS;
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
        // [275-M1 收口] 同一份 analyzeRosterForGate（见 hasValidLiaison 之后定义），不再各自手写 filter/every。
        const { activeCount: rosterActiveCount, allComplete: rosterAllComplete } = analyzeRosterForGate(rosterRows);
        // ⭐ [C9·§10.1] routeKind 按"这条边实际是什么"选，不是按"从哪个函数调进来"选：accept 被
        //   resolveToStatusInTxn 动态改判成「已上线」时，它已经不是 ADMIN_TRANSITION 那条
        //   `待验证→待上线` 的边，而是 C9 新立的 `待验证→已上线` 免上线直翻边——必须报 NO_COMMIT_ONLINE，
        //   否则会被 ADMIN_TRANSITION 分支的「不得直写已上线」正确地拦下（本批实测撞到过，是守卫在尽职）。
        //   ⚠️ 判据用 `toStatus === SYS_ONLINE_STATUS && action === 'accept'` 而非"端点传了什么"——
        //     守卫要校的是**边的真实形状**，让调用方自报 routeKind 等于把守卫的判断权交出去。
        // ⭐⭐ [C9-fix M1·fail-closed 加固 → C9-fix2 H1·裁决源改为引擎局部量] 判据**三项**：动作是 accept
        //   ∧ 目标态是已上线 ∧ 引擎自己的准入裁决 directFlip===true。前两项都可能在**没经过
        //   evaluateNoCommitDirectOnline 准入四条件**的情况下成立（有人给 accept 装别的 resolveToStatusInTxn、
        //   或改 transitions.js 让 accept 的常量 to 变成「已上线」），只看前两项就会把一条从没做过准入判定的
        //   边认作 NO_COMMIT_ONLINE 放过守卫——**fail-open**。
        //   ⭐ [C9-fix2 H1] 第三项读的是 [1b] 引擎自调产出的**局部变量**（不再是 opts 里调用方递进来的
        //     可变载体）。差别是本质的：改前"够不够格"的最终依据是调用方给的一个普通对象，伪造它即可
        //     整套绕开准入四条件；改后调用方在这条判据上没有任何输入面。
        const isNoCommitDirectOnline = (action === 'accept' && toStatus === SYS_ONLINE_STATUS
          && !!noCommitOnlineVerdict && noCommitOnlineVerdict.directFlip === true);
        // ⭐ 配套的显式 fail-closed：目标态是「已上线」却拿不到 directFlip 裁决 ⇒ **不静默降级成
        //   ADMIN_TRANSITION**（那样只会得到守卫的 409「不得直写已上线」，错误信息指向状态机边而非真凶）。
        //   直接 500 内部错，把"有人开了一条没做准入判定的进已上线通道"这件事变成响亮失败。
        //   ⭐ [C9-fix2 H1·可达性重述] 裁决收归引擎后，本分支的形态变成「目标态已上线，但引擎没为这条边
        //     产生过 directFlip=true 的裁决」，具体三种来路：
        //       ① 调用方塞了个返回「已上线」的 resolveToStatusInTxn 钩子，而引擎的局部裁决是 false
        //          （准入四条件没过）或 null（该边压根不是 accept×待验证，引擎没问过）——**伪造 opts 的
        //          攻击面正落在这里**，拿到的是 500 而不是一次成功的越权直翻；
        //       ② action 的常量 to 配成「已上线」——⭐ [85ace8b 预筛 MED-2 订正] 这不是"将来"：
        //          transitions.js:1028 的 `execute-release`（BUG_FLOW·meta/历史 timeline 标签保留用）
        //          **今天就是这样一条常量**。它无害仅因引擎零调用点+前端通用循环显式 skip——一旦有人
        //          给它接上 makeTransitionEndpoint，会在此当场 500 而不是静默直写已上线（这正是本
        //          fail-closed 的价值：地雷已埋好，本分支是它唯一的引爆保险）；
        //       ③ 给 accept 新增一条别的 from 态的边（引擎的 [1b] 门只认 待验证）。
        //     三种都当场炸，不悄悄放行。
        if (toStatus === SYS_ONLINE_STATUS && !isNoCommitDirectOnline) {
          throw new SysTransitionError(500, 'DIRECT_ONLINE_VERDICT_MISSING',
            `目标态「${SYS_ONLINE_STATUS}」缺少免上线直翻裁决（action=${action}，directFlip=${noCommitOnlineVerdict ? noCommitOnlineVerdict.directFlip : '(引擎未产生裁决)'}）——进「已上线」必须经准入四条件判定，拒绝无裁决放行`);
        }
        assertMainStatusTransition({
          routeKind: isNoCommitDirectOnline ? 'NO_COMMIT_ONLINE' : 'ADMIN_TRANSITION',
          action, actionKind: null, issueType: type,
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
        // ⭐ [C10·裁定2] 拒绝码分流：绑单精判失败（intake_liaison/_only）报 NOT_BOUND_LIAISON（与直连 handler
        //   的 assign/reassign/notify 等同码·全端点单一"你不是该单对接人"语义）；其余 roleGuard 失败仍报通用
        //   NOT_AUTHORIZED_FOR_TRANSITION。roleGuard 是单值·至多一个分支命中，denyCode 不会被多分支相互覆盖。
        let roleGuardDenyCode = 'NOT_AUTHORIZED_FOR_TRANSITION';
        if (transition.roleGuard === 'admin' && !isAdmin) permitted = false;
        // ⭐ 角色权限重构 C1：roleGuard='admin_or_bug_liaison' 分支**已删除**。
        //   原语义 = admin ∨ bug 对接人白名单[7,13]，且靠"仅挂 bug transition"实现 type 隔离。
        //   C1 后四条曾用它的 transition（bug/变更流 × assign/reassign）统一改为 'intake_liaison'
        //   （admin ∨ 受理人[13]·**全类型**），示例发布者[7] 由此失去指派权、转为纯技术负责人。
        //   该字符串已从 KNOWN_ROLE_GUARDS 移除：若哪里还残留，引擎会以 500 UNKNOWN_ROLE_GUARD fail-closed，
        //   verify-sys-meta 的"非空 roleGuard ∈ 已知集"断言也会先一步红灯。
        // ⭐⭐⭐ [C10·裁定2·绑单精判] roleGuard='intake_liaison' 从「admin ∨ 白名单[13]」收紧为
        //   「admin ∨ **该单当前 intake_liaison_id 本人**」——示例对接人从"可操作所有单"变"仅名下单"（**行为变更**·
        //   方案已拍板+部署日公告）。角色候选资格只决定谁能被选/受理空单，不授跨单操作权。
        //   ⭐ **存量空单兜底（仅 intake_accept·裁定2）**：intake_liaison_id IS NULL 的**待受理**单（存量·intake_liaison_id
        //     可空是合法态），任一 eligible 候选可受理——受理动作在 case 'intake_accept' 内同事务 CAS 绑自己
        //     （见该处 whereFrags）。**非** intake_accept 的动作对空单不给此兜底（如 issue_reject 空单→403，admin 出口=void）。
        //   ⚠️ isIntakeLiaisonEligible 实时读库（本函数 async·await 合法）；空单兜底只对 accept 开，收紧面不外溢。
          //   ⭐⭐ [C10-fix3 MED-2·codex 319-R 登记·非逻辑改动｜C10-fix4 注释订正] admin 受理空单后
          //     intake_liaison_id 保持 NULL（C10-fix2：admin 不绑自己）是**合法态、非权限死锁**：本 admin 分支
          //     （isAdmin）无条件放行 ⇒ admin 可继续 assign/退回(intake_return)/通知 代管推进；eligible 非 admin
          //     成员对 NULL 单恒 403 NOT_BOUND_LIAISON（只 admin 能推进）。证据=verify-sys-c10-liaison-binding [9]。
          //   ⚠️ [C10-fix4·codex 319-R2 MED 订正+P7 已裁 A] 原注释「后续 admin 指派/换绑时把绑定定下来」**失实**：
          //     对一个**已存在的 NULL 单**，后置能写 intake_liaison_id 的点**恰两处**（本空单 CAS :3362 +
          //     notify-intake auto-fill :13145）——**不含建单时的首次写入**（主建单 INSERT :4199 也写该列·必填
          //     校验 :3965·是第三个写点但属"创建时首次落值"·非"对已存在 NULL 单的后置改写"·[C11-fix2 后 S6 末次
          //     合并审 LOW-1 订正：原「全仓恰两处」绝对措辞漏了 create 写点，收窄为"后置写点"）。assign
          //     **不写** intake_liaison_id，且当前无换对接人端点（L2 缺口）。故 admin 受理的 NULL 单，其对接人定夺
          //     当前**仅** notify-intake auto-fill 在候选恰 1 人（length===1）时可自动填；生产多候选（8 人）下
          //     NULL 单**无自动获对接人路径**，走到「待对接测试」态时 liaison-test 收件人为 NULL → fail-closed 不发
          //     （已知限制·非死锁但流程受阻）。**⭐ P7 已裁定=选项 A（用户 2026-08-08 拍板：接受此限制·
          //     管理员代管）**：存量空单极少（本地实测 1 个），出现时由 admin 手动补对接人（改派/后续动作）处理，
          //     不改受理契约、不加强制指定参数。当前实现（admin 受理空单不绑·保 NULL·代管推进）即最终口径·
          //     无需改代码。（曾评估 B admin 受理必带 eligible 目标 / C 受理 409 禁止，均未采纳——A 最小侵入。）
        {
          // ⭐⭐⭐ [C10-fix5 HIGH·引擎内联绑单精判叠加 eligibility] isBoundLiaison 原只判身份（fail-open：对接人
          //   role 改 viewer 后仍命中）——补 `∧ await isIntakeLiaisonEligible`（撤销候选资格同步撤销存量绑单操作
          //   权·与直连 handler isBoundLiaisonEligibleOrAdmin / 通知端 resolveValidBoundLiaisonForNotify 同口径·
          //   fail-closed）。**不复用 isBoundLiaisonEligibleOrAdmin helper**——它捆了 admin，而下方 intake_liaison_only
          //   分支必须排除 admin（§2 矩阵 190 号刻意区分），故此处内联。eligibility 语义仍单一源于 isIntakeLiaisonEligible。
          //   ⚠️ 与 isUnboundAcceptClaim 互斥（intake_liaison_id 非null vs null）：单请求至多触发一次 eligibility 读库；
          //     短路顺序（身份三条件在前·eligibility 读库在后）保证非绑定本人不读库。
          // ⭐ [C10-fix6·codex 322-R MED-2] 显式 `!isAdmin` 前置——intake_liaison_only 排 admin 的契约不再依赖
          //   「isIntakeLiaisonEligible(adminId) 恒 false」这一**隐含不变量**（若将来 eligible 集合纳入 admin 或
          //   资格函数加 admin 旁路，隐含依赖会静默放行绑定 admin·违 §2/190「intake_liaison_only 必排 admin」）。
          //   普通 intake_liaison 仍由下方 `isAdmin || isBoundLiaison` 放行 admin·两 roleGuard 差异由代码结构固定。
          const isBoundLiaison = !isAdmin && row.intake_liaison_id != null && Number(actor.id) === Number(row.intake_liaison_id) && Number(actor.id) > 0
            && await isIntakeLiaisonEligible(actor.id);
          const isUnboundAcceptClaim = action === 'intake_accept' && row.intake_liaison_id == null && await isIntakeLiaisonEligible(actor.id);
          if (transition.roleGuard === 'intake_liaison' && !(isAdmin || isBoundLiaison || isUnboundAcceptClaim)) { permitted = false; roleGuardDenyCode = 'NOT_BOUND_LIAISON'; }
          // ⭐⭐ [C10·裁定2] 'intake_liaison_only'（仅对接人·不含 admin·§2 矩阵 190 号刻意区分）同步收紧为
          //   「仅该单绑定对接人本人」。当前仅变更流 issue_reject 用；空单无绑定人 ⇒ 无人可 reject，admin 出口=void（§2）。
          if (transition.roleGuard === 'intake_liaison_only' && !isBoundLiaison) { permitted = false; roleGuardDenyCode = 'NOT_BOUND_LIAISON'; }
        }
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
        if (!permitted) throw new SysTransitionError(403, roleGuardDenyCode, roleGuardDenyCode === 'NOT_BOUND_LIAISON' ? '仅管理员或该单对接人可执行此操作' : '无权执行此状态流转');
      }

      // [3.4] ⭐⭐ S2（bug暂缓方案 §5.2·唯一且强制落点）：hold 在 bug 类型下 roleGuard/ownerGuard 均为
      //   null（见上方 [3]），此处补齐真实授权闸门——assertBugHoldActor（定义于本函数上方）。
      //   落点严格满足方案要求："findTransition 之后（[1]）、任何状态 UPDATE 之前（[6]）"，且
      //   sysIssueTransition 是通用 transition 引擎、hold 没有专用端点绕开它，本处即"所有能触发
      //   hold 的入口的唯一必经之路"。失败 403 + 事务回滚，UPDATE/timeline 均未执行，无任何副作用。
      if (action === 'hold' && type === 'bug') {
        await assertBugHoldActor(actor, row);
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

      // [3.6] ⭐⭐ R2/R3 咨询前置守卫（C2.5 撤销·方案 v2.1 §2 状态矩阵·用户拍板 D3）：
      //   · R3 受理阻断（全类型）：挂着"未回复"的技术咨询时不可受理——先等回复或手动取消（**取代**旧 PH-2
      //     在受理方向上的自动清：用户拍板选阻断非清理）。
      //   · R2 拒绝前置（仅变更流）：拒绝的依据必须是技术负责人的意见——当前轮无意见（含从未咨询/被清）
      //     一律 409。"当前轮已回复"判定与 PH-1 轮次模型同源（timeline.id > 本轮 event_id）。
      //   位置=[3.5] 同段（权限[3]之后·UPDATE 之前·同事务读锁定行）：无权者稳得 403 不泄露咨询态；
      //   bug 的 issue_reject 不进本守卫（保持 admin 现状·未回复悬挂由 [PH-2 挂点] 自动清收口）。
      if (action === 'intake_accept' || (action === 'issue_reject' && (row.type === 'feature' || row.type === 'improvement'))) {
        // ⚠️ 守卫**自查两列**（S3 红灯诊断修）：引擎各路径加载 row 的 SELECT 列清单不一，row.tech_lead_id
        //   可能是 undefined——而 `undefined != null` 为 false，会让 hasActiveConsult 恒 false → 变更流拒绝
        //   恒 409（首跑 [RA] 组红灯坐实）。同事务内单查一次，不依赖调用方 row 的形状。
        const cRow = await dbGetAsync('SELECT tech_lead_id, tech_lead_notify_request_event_id FROM sys_issues WHERE id = ?', [row.id]);
        const hasActiveConsult = !!cRow && cRow.tech_lead_id != null && cRow.tech_lead_notify_request_event_id != null;
        const hasCurrentRoundComment = hasActiveConsult ? !!(await dbGetAsync(
          `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
          [row.id, cRow.tech_lead_notify_request_event_id])) : false;
        if (action === 'intake_accept' && hasActiveConsult && !hasCurrentRoundComment) {
          throw new SysTransitionError(409, 'INTAKE_BLOCKED_BY_PENDING_CONSULT', '技术负责人咨询尚未回复：请先等待回复，或取消咨询后再受理');
        }
        if (action === 'issue_reject' && !hasCurrentRoundComment) {
          throw new SysTransitionError(409, 'REJECT_REQUIRES_TECH_COMMENT', '拒绝须以技术负责人评估意见为依据：请先发起技术咨询并获得意见后再操作');
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
      let timelinePayloadJson = null;   // [codex 291 号 H-2] 结构化留痕，目前仅 case 'liaison_test_pass' 写值，其余动作恒 NULL
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
        //   intake_accept（待受理→待指派/待处理）：[工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5 新增]
        //     risk_level 现与状态流转同一 UPDATE 原子落库（唯一写点，见下方 case）。
        //     ⭐ 用户拍板批1改造B（2026-08-06）：新口径=feature+improvement 均必填 ∈ {一级,二级,三级}；
        //     bug 恒 NULL（传值即拒绝，对称 §3.2/C2 feasibility 端点"bug 无工期"EFFORT_REQUIRED/
        //     EFFORT_INVALID 的处理形态）——原「仅 feature 必填、improvement 与 bug 同拒绝」口径已废止，
        //     "非 feature 拒绝+自愈清零"的分支现只剩 bug 一个类型（改造前 improvement/bug 两个类型共用
        //     同一分支，故此处判据从 `type === 'feature'` 扩为 `type === 'feature' || type === 'improvement'`，
        //     bug 独占 else 分支）。⭐ 用户拍板批1改造A：值域「高/中/低」全仓改名为「一级/二级/三级」，
        //     语义不变仅文案换。summary 仍恒 null·timeline actionCode='intake_accept' 已由常量给。
        //   resubmit_intake（待修改→待受理）：⭐ 角色权限重构 C0 起**改为有额外 SET**（见下方 case·原为"无额外 SET 不列 case"）。
        case 'intake_accept': {
          // ⭐⭐⭐ [C10·裁定2·存量空单 CAS 兜底] intake_liaison_id **可空是合法态**（存量单：本地实测 1 个·生产可能更多）。
          //   受理时若该列为空，**同事务把受理人自己 CAS 绑上去**——`WHERE intake_liaison_id IS NULL`（whereFrags）+
          //   引擎主 UPDATE 的 `changes!==1→409 CONCURRENT_STATE_CHANGE`（既有乐观锁）天然实现"两人同时受理同一空单·抢一"：
          //   后到者读到的 row 也是 NULL，但 UPDATE 命中 0 行（列已被前者写非空）⇒ 409。状态 CAS（WHERE status=?）另保
          //   "非待受理空单不可抢"（先撞状态闸）。roleGuard 侧的空单准入（admin ∨ eligible）见 :3174 一带。
          //   ⚠️ 已绑单（intake_liaison_id 非空）的正常受理**不动此列**——只补空、不覆盖，避免受理人 admin 代办时把绑定人改掉。
          // ⭐⭐⭐ [C10-fix2 MED-1·admin 代办受理空单不写入非 eligible 绑定] 空单 CAS 绑自己**仅对 eligible 候选开放**——
          //   :3197 的准入放行 admin(isAdmin) ∨ eligible(isUnboundAcceptClaim) ∨ 绑定本人；但 admin ∉ eligible 候选
          //   （role='admin' 不在 INTAKE_LIAISON_ELIGIBLE_ROLES），若无条件绑 actor 会把 intake_liaison_id 写成
          //   admin id=1——**破坏「绑定值来自 eligible 候选」数据不变量**（下拉候选/建单校验/notify 收件人解析各消费
          //   点均假设该列∈候选池·admin 混入造成多模块分歧）。故绑定写点独立加 isIntakeLiaisonEligible(actor.id) 闸
          //   （与 :3196 isUnboundAcceptClaim 的 eligible 判据同源·准入与写入同口径）：仅 eligible 成员受理空单才
          //   CAS 绑自己；**admin 代办受理空单不写入非 eligible 绑定·intake_liaison_id 保持 NULL=合法态**（admin
          //   后续指派对接人时再定）。isIntakeLiaisonEligible 实时读库（本函数 async·await 合法；本条只对空单求值·
          //   已绑单短路不触发·收紧面不外溢）。
          if (row.intake_liaison_id == null && await isIntakeLiaisonEligible(actor.id)) {
            setFrags.push('intake_liaison_id = ?');
            setParams.push(Number(actor.id));
            whereFrags.push('intake_liaison_id IS NULL');   // 无占位参数（IS NULL）；CAS 抢一由 changes!==1 兜底
          }
          const riskRaw = payload.risk_level;
          // [284 号 L-1 固化] null/空串 = 未提供（宽松语义，有意为之）——前端正常不会给非适用类型
          // 发这个字段，但 API 调用者显式传 null 的意图约等于"未传"，不该被当成"传了个非法值"处理；
          // 只有非空非 null 的具体字符串才算"真的传了值"。改造B后本宽松语义仅对 bug 生效（唯一还会
          // 落到 else 分支的类型）。
          const riskProvided = riskRaw !== undefined && riskRaw !== null && riskRaw !== '';
          if (type === 'feature' || type === 'improvement') {
            const riskTrim = (typeof riskRaw === 'string') ? riskRaw.trim() : '';
            if (!riskProvided) {
              throw new SysTransitionError(400, 'RISK_LEVEL_REQUIRED', '请选择风险等级');
            }
            if (!['一级', '二级', '三级'].includes(riskTrim)) {
              throw new SysTransitionError(400, 'RISK_LEVEL_INVALID', '风险等级仅支持"一级/二级/三级"');
            }
            setFrags.push('risk_level = ?');
            setParams.push(riskTrim);
          } else {
            if (riskProvided) {
              // bug：risk_level 恒 NULL（对接人受理时仅对 feature/improvement 定级）——bug 传
              // 具体值是语义错误，显式拒绝（不静默丢弃：静默丢弃会让调用方误以为传了就生效，掩盖真实的
              // 调用方 bug）。null/空串已在上面 riskProvided 判定里被当"未传"，不会走到这里。
              throw new SysTransitionError(409, 'RISK_LEVEL_NOT_APPLICABLE', `「${type}」类型不支持风险等级`);
            }
            // [284 号 M-1 自愈版，285 号 M-1 注释修正，改造B后收窄为 bug 独占] 受理成功路径显式清零——
            // 不依赖"列默认/既有值恒 NULL"的假设（那只在从未被脏写过的前提下成立）。手工 SQL/历史导入等
            // 旁路仍可能给 bug 行写入过非空 risk_level；受理是该类型单在本列上唯一还会执行的
            // 写路径，借这次唯一写点把脏值原子归零，比另开一条运维清洗脚本更可靠。
            // ⚠️ SQLite 表级 CHECK 可以表达 `CHECK (risk_level IS NULL OR type IN ('feature','improvement'))`
            // （跨列条件，SQLite CHECK 支持引用同表其他列，技术上并非表达不了）；但对既有 37 列大表追加
            // 表级 CHECK 须重建整表（本项目"换壳禁令"，见既有踩坑记录），成本远超本条不变量的价值；触发器
            // 可以不重建表就追加，但会引入新的迁移面/维护面，本期不做。故本不变量的承诺范围明确限定为：
            // 服务层唯一写点自愈（本处）+ [H-7] 探针检测（verify-sys-intake-gate.js）——DB 旁路
            // （运维手工 SQL/数据导入）产生的脏写，在"脏写发生"到"下一次该单据受理"之间存在一段窗口期
            // 该行确实带着非法 risk_level（DB 层不拦），由下一次受理自愈或探针扫描暴露，不是"从不可能
            // 出现脏值"，是"脏值不会在服务层留存超过一次受理周期"——这条区别已明确登记接受，非遗漏。
            setFrags.push('risk_level = NULL');
          }
          break;
        }
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
        // （C2.5 撤销·方案 v2.1）"预沟通通过"这一 case 分支已删除——该 action 在 transitions.js 已无条目，
        //   findTransition 对任意 type 恒返 null，[1] 会在到达本 switch 前就以 INVALID_TRANSITION 抛出
        //   （本函数入口处 findTransition 查表在 switch 之前），本分支曾 100% 不可达（路由已 404），
        //   随撤销一并删除死代码（保留会误导读者以为仍有路径可达）。OA 号回填改经独立路由
        //   POST /sys-issues/:id/set-oa-number（见该端点实现，非本引擎 switch 内）。
        case 'intake_return': {
          // 受理退改（§5.1②·原因必填）：待受理→待修改，reason 落 timeline.summary（对齐 return/reopen 的 reason→summary 范式）。
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'INTAKE_RETURN_REASON_REQUIRED', '请填写退改原因');
          summary = reason;
          break;
        }
        case 'accept': {
          setFrags.push("accepted_at = datetime('now','localtime')");
          // ⭐ [C9 无 commit 单验收直翻·方案 v1.7 §10.1] 目标态若已被 resolveToStatusInTxn 判成「已上线」
          //   （准入四条件全满足，判定函数=evaluateNoCommitDirectOnline，与本 UPDATE **同一事务**），
          //   则本条 UPDATE 一并写上线时刻与来源标签——三件事（status/released_at/online_source）落在
          //   同一条 SQL 里，天然原子，不存在"翻了牌但来源没写上"的中间态。
          //   ⚠️ release_id 刻意不伪造批次关联，DTO 三分支正是靠"无批次关联 ∧ online_source 为本路径标签"
          //     认出这条路径的（§10.1 字段契约表）。
          //   ⭐⭐ [C9-fix2 H2-a·写读分裂堵口] release_id 从"不写（默认它本来就是 NULL）"改为**显式置 NULL**。
          //     原因是准入条件②与 DTO 派生对 release_id 的口径本来是分裂的：
          //       · 写侧 evaluateNoCommitDirectOnline 条件② 用 `SELECT 1 FROM sys_releases WHERE id=? AND
          //         status IN(...)`，**容忍悬垂**——release_id 指向一条已被删除的批次行时查不到，判"无 active
          //         关联"放行直翻（该容忍是有意的，见该处注释）；
          //       · 读侧 deriveOnlineSourceKind 第 ① 分支只看 `release_id != null`，一律先认 release_publish。
          //     两者叠加的后果：一个带悬垂 release_id 的单被直翻成「已上线」并写上 online_source 之后，
          //     详情/列表会把它显示成"批次发布"——真相是免上线直翻，来源标签被 ① 分支永久遮蔽。
          //     现在同事务把这一列清成 NULL：直翻单落库后恒无批次关联，读侧 ① 分支不会误领，两侧口径闭合。
          //     ⚠️ 这一列的清除与 status/released_at/online_source 在**同一条 UPDATE** 里，不存在"翻了牌但
          //       悬垂指针还挂着"的中间态。deriveOnlineSourceKind 的优先序安全性现依赖本行（那边已注明）。
          //     ⚠️ 生产当前不可达（批次行零删除 + 解绑路径 :10243 已清列），这是**纵深修复**不是止血。
          //   ⚠️ 本路径**不经** sys_releases / R-GATE / _publishReleaseCoreInTxn——批次发布是另一条链路，
          //     两者只在"最终 status 值相同"这一点上重合，中心守卫零改动（§10.1 设计要点红线）。
          // ⭐⭐ [C9-fix M1·写点同门 → C9-fix2 H1·同源对象改为引擎局部裁决] 判据与上方 routeKind 选择处
          //   **逐字同源**：不只看 toStatus，还要求引擎自己的裁决 directFlip===true。两处必须同谓词——写点若
          //   比守卫处宽松，就会出现"守卫按 ADMIN_TRANSITION 判、写点却按直翻写 online_source" 这种半写态
          //   （或反之，翻了牌却不写来源，DTO 立刻把它误分类成 unknown_legacy）。
          //   ⚠️ 实际上上方的 fail-closed 已经保证走到这里时 toStatus==='已上线' ⟺ directFlip===true（不满足
          //     的组合早已 500 抛出，根本到不了本 switch）。这里仍写全谓词，是因为**两处判据同源这件事本身
          //     要看得见**——留一个只判半边的写点，等于给未来"上面放宽了下面忘了跟"埋一颗静默半写的雷。
          if (toStatus === SYS_ONLINE_STATUS && noCommitOnlineVerdict && noCommitOnlineVerdict.directFlip === true) {
            setFrags.push("released_at = datetime('now','localtime')", 'online_source = ?', 'release_id = NULL');
            setParams.push(ONLINE_SOURCE_NO_COMMIT);
            // 第 4 条：曾有 commit 但已删光 → 允许直翻，但 timeline 附记留证（用户 2026-08-06 拍板：
            //   codex 的 ever-had-commit 硬闸不采纳，填错删掉重填属合法操作，留证不设闸，交人判断）。
            // ⭐ [C9 对抗审 codex 317·M2] 文案用「发生过 N 次删除提交动作」而非「N 条已删提交记录」——
            //   N 是 delete-commit **动作次数**（同一 ref 反复删会累计，见 evaluateNoCommitDirectOnline
            //   :2388 一带的语义说明），"N 条记录/N 条提交"会被读成"有 N 条不同的提交"，语义偏移。
            const deletedN = Number(noCommitOnlineVerdict.deletedCommitCount) || 0;
            summary = SYS_NO_COMMIT_ONLINE_SUMMARY
              + (deletedN > 0 ? `（该单曾发生过 ${deletedN} 次删除提交动作）` : '');
          }
          break;
        }
        // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5·C4 新增] 对接测试通过：待对接测试 → 待验证。
        //   ①b 复查（同事务内重新查询，防 GATE 判定→操作者点击 pass 之间 roster 被并发改动）：
        //   isRosterCompleteAndEligible ∧ hasDeliverable——**不复查 hasValidLiaison**（操作者本身就是
        //   池内受理人，其授权即测试合法性来源，§3.0 末尾"复查组合规则"冻结）。任一不满足 → 409
        //   LIAISON_TEST_PASS_INVARIANT，整事务回滚（早于 [6] 主表 UPDATE，不产生任何副作用）。
        //   [275-M1 收口] 计数改走 analyzeRosterForGate（与 runWGate 同一份实现）——此前本处只手写
        //   pendingCount 一项，遗漏了 unknownCount 检查：花名册若同时存在"合法交付行(code_submitted/
        //   no_code) + 未知 dev_status 脏值行"，未知行既非 pending 也非法交付，旧写法会把它当"已处理"
        //   放过 passRosterComplete 判定，与 runWGate ②层"未知 dev_status 一律阻断"精神矛盾。现在显式
        //   检查 unknownCount>0 单独 409（早于组合判定，文案区分"脏数据"与"未全完成/资格/无交付"）。
        // [S12 双路审查 codex 287 号 M-1 收口] 本 case 刻意不读 liaison_test_notify_status——sending
        //   期间也放行通过，是登记过的既有语义（非漏查），完整推导见 writebackLiaisonTestNotify 函数
        //   下方注释（:11273 起）。
        case 'liaison_test_pass': {
          const passRosterRows = await dbAllAsync(
            `SELECT dev_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`,
            [issueId]
          );
          const passAnalysis = analyzeRosterForGate(passRosterRows);
          if (passAnalysis.unknownCount > 0) {
            throw new SysTransitionError(409, 'LIAISON_TEST_PASS_INVARIANT', '当前不满足对接测试通过前置条件（在册出现未知 dev_status 脏值，需人工核查数据完整性）');
          }
          const passEligible = passAnalysis.allComplete ? await isGateEligibleForVerify(issueId, type) : false;
          if (!(passAnalysis.allComplete && passEligible && passAnalysis.hasDeliverable)) {
            throw new SysTransitionError(409, 'LIAISON_TEST_PASS_INVARIANT', '当前不满足对接测试通过前置条件（在册未全完成态/资格未过/无交付记录）');
          }
          // [方案 D22-④·2026-08-06 批2·codex 291 号 H-1/H-2/M-1 收口] pass 凭证校验：口径="进入本轮待
          //   对接测试之后新上传的附件" 或 "pass 当场填写的测试说明文字"，至少其一。置于①b 复查**之后**——
          //   评估是否放行 pass 这件事，roster/资格/交付完整性是更根本的前置条件，评估顺序上应先判定
          //   "这次 pass 在业务上是否成立"，evidence 是在此基础上追加的"操作者本人是否真的验证过"的补充
          //   约束；也让 [6b]/[6c]/[6d] 等既有 roster/资格反例测试继续精确命中 LIAISON_TEST_PASS_INVARIANT
          //   （不因未带凭证被错误分类到新码）。
          const testNoteRaw = payload.test_note;
          if (testNoteRaw !== undefined && testNoteRaw !== null && typeof testNoteRaw !== 'string') {
            throw new SysTransitionError(400, 'LIAISON_TEST_NOTE_INVALID', '测试说明格式错误（须为字符串）');
          }
          const testNoteTrim = (typeof testNoteRaw === 'string') ? testNoteRaw.trim() : '';
          if (testNoteTrim.length > 500) {
            throw new SysTransitionError(400, 'LIAISON_TEST_NOTE_TOO_LONG', '测试说明不超过 500 字');
          }
          const hasNote = testNoteTrim.length > 0;
          // [291 号 H-1] "本轮附件"判定改 id 水位模型——不再比较 created_at（同一事务/同一秒插入多行时
          //   精度不足，见 verify-sys-liaison-test.js [6h] 反证）。水位＝进入本轮那一刻 runWGate ⑦ 原子
          //   写入的 liaison_test_attachment_watermark（"旧"附件的最大 id，见该列 DDL 注释）；凭证附件
          //   须严格 id > watermark。[291 号 M-1] 不再因 hasNote=true 短路——无条件查询，拿到真实
          //   attachment_ids 供下方 payload_json 留痕（"说明+附件同时都有"时 evidence='both' 需要两者
          //   都确实成立，短路会让"有说明但其实也传了新附件"这一真三态永远测不到）。
          const passAttRows = await dbAllAsync(
            `SELECT id FROM sys_issue_attachments
               WHERE issue_id = ? AND attachment_type IN ('delivery','screenshot') AND status = 'active'
                 AND id > ?
               ORDER BY id ASC`,
            [issueId, row.liaison_test_attachment_watermark || 0]
          );
          const attachmentIds = passAttRows.map(r => r.id);
          const hasAttachment = attachmentIds.length > 0;
          if (!hasNote && !hasAttachment) {
            throw new SysTransitionError(400, 'LIAISON_TEST_PASS_EVIDENCE_REQUIRED', '请上传测试截图或填写测试说明');
          }
          const evidence = hasNote && hasAttachment ? 'both' : (hasNote ? 'note' : 'attachment');
          // [291 号 H-2] 结构化留痕——恢复方案 D22-④ 拍板原意，落 sys_issue_timeline.payload_json（该列
          // 291 号新补，批2曾因当时无此列退而求其次落 summary 全文，现收口）。键名 schema 冻结（供未来
          // 读侧 json_extract，同 submit 事件 payload_json 的 self_tested/test_env_deployed/work_note 写读
          // 同源范式，见 SUBMIT_SELF_TESTED_KEY 一带注释）：
          //   test_note      —— 仅 hasNote 时出现，测试说明全文（未截断，≤500 字，"仅有值时加键"同 work_note 惯例）
          //   attachment_ids —— 仅 hasAttachment 时出现，本轮新传附件 id 数组（升序）
          //   evidence       —— 恒出现，'note'|'attachment'|'both'
          //   cycle_no       —— 恒出现，本次 pass 所属的 liaison_test_cycle_no（落库时的当前值，非 pass 后递增值——
          //                      pass 边不改周期号，见 transitions.js 该条目 sideEffects 注释）
          const payloadObj = { evidence, cycle_no: row.liaison_test_cycle_no };
          if (hasNote) payloadObj.test_note = testNoteTrim;
          if (hasAttachment) payloadObj.attachment_ids = attachmentIds;
          timelinePayloadJson = JSON.stringify(payloadObj);
          // summary 收窄为 80 字展示摘要（列表/时间线一览用，不再是唯一凭证载体——完整凭证在 payload_json）。
          // ⚠️ XSS 核实：前端时间线渲染 summary 走 `esc(e.summary)`（Sys_Iteration.html siRenderTimeline，
          // 见 :esc() 调用点），非裸插值——test_note 若含 <script>/引号等字符，落 summary 预览时同样经
          // esc() 转义安全展示；payload_json 本身不直接渲染进 DOM（无消费方，见列注释），无额外转义面。
          const notePreview = testNoteTrim.length > 80 ? testNoteTrim.slice(0, 80) + '…' : testNoteTrim;
          summary = hasNote
            ? `对接测试通过｜测试说明：${notePreview}${hasAttachment ? '（另有本轮测试附件）' : ''}`
            : '对接测试通过｜凭证：本轮测试附件';
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
        // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5+§3.1b/D18·C4 新增] 对接测试打回：待对接测试 →
        //   开发中（原因必填）。§3.1b 逐字："复用现网 return 字段清理部分"——即 return case 的 setFrags
        //   除 return_count++ 外全部照搬：dev_estimated_at/scheduled_start/gate_deferred_at 清空 +
        //   SYS_CLEAR_FEASIBILITY_FIELDS_SQL（feasibility 三字段+estimated_effort_days+blocked 三件套）。
        //   返工轮逐步状态表印证此设计意图（§3.1b："打回（重置≥1人 pending·清资格）→ 重填资格 → 逐人
        //   re-submit"）——"清资格"就是这里的评估字段清空，逼迫测试打回后必须重新走一遍评估+估时才能
        //   再次提交，与业务验收打回（return）对开发的要求完全一致，唯一差异=不计入 return_count（D18）。
        //   ⚠️ v1.1 D18 钉死：**不递增 return_count**（测试段内打回是"对接测试的一个环节"，非"业务验收
        //   打回"，两者统计口径语义分离，独立计入 liaison_test_cycle_no）。花名册重置（③层）放在下方 [7]
        //   timeline 写入之后的既有"post-processing 内联块"区（同 resume bug-only 收窄先例，同一事务内，
        //   是否放在 timeline 写入前后不影响 all-or-nothing 语义）。
        // [S12 双路审查 codex 287 号 M-1 收口] 同上——本 case 同样刻意不读 liaison_test_notify_status，
        //   sending 期间打回同样放行，理由与 liaison_test_pass 一致（见 writebackLiaisonTestNotify 下方
        //   注释 :11273 起）。
        case 'liaison_test_return': {
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'LIAISON_TEST_RETURN_REASON_REQUIRED', '请填写打回原因');
          summary = reason;
          setFrags.push('dev_estimated_at = NULL', 'scheduled_start = NULL', 'gate_deferred_at = NULL',
            ...SYS_CLEAR_FEASIBILITY_FIELDS_SQL);
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
            // ⭐⭐ [C9-fix2 M2·online_source 生命周期] 重开=新一轮，上一轮"怎么上线的"这个标签必须一并作废。
            //   不清的后果很具体：一个免上线直翻过的单被 reopen 后，online_source 仍留着 'no_commit_acceptance'，
            //   若这一轮改走**批次发布**上线，deriveOnlineSourceKind 的 ① 分支（release_id 非空）虽然会先
            //   认领 release_publish 把它遮住。⭐ [85ace8b 预筛 MED-1 订正] 本段初版曾举"execute-release 的
            //   hotfix 直翻分支"作为"已上线∧release_id 空"的现实来路——**那是被 :9002 一带陈旧注释骗的**：
            //   execute-release 端点已于 C3 整体退场（handler 首行无条件 409 LEGACY_RELEASE_FLOW_DISABLED），
            //   预筛全扫实证当前**无任何路径**产出「已上线∧release_id IS NULL」（除 C9 直翻自身，而它会重写
            //   标签）。故本行是**纯纵深防御**：挡的是将来新增此类路径、或直连 SQL 造出该组合时，陈旧标签
            //   冒名"免上线直翻"——不是在修一个今天可达的缺陷。
            //   与相邻的 released_at/release_id 同属"上线事实三件套"，那两件已经在清，本列是漏网的第三件。
            //   ⚠️ deleted_commit_count **不是物理列**（全库无此列，仅 accept 响应体的一个键，由
            //     evaluateNoCommitDirectOnline 现算现给），故无从清、也无需清——本次未加该 SET 片段。
            'online_source = NULL',
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
          if (action === 'reactivate') {
            setFrags.push(...SYS_BACK_TO_INTAKE_GATE_SQL);
            // ⭐ oa_number 也必须归零：本块上方那句"回受理门即新一轮，旧轮次状态不跨轮继承"是既定不变量，
            //   reactivate 落态回「待受理」——而「待受理」不在 OA 允许状态集内（§4 显式允许集·OA_NUMBER_STATUS_NOT_ALLOWED
            //   的判定边界），若不清零就会产生"待受理 + 非空 OA 号"这种状态与字段矛盾的脏数据，且详情/
            //   列表会展示上一轮那个已作废的号，误导判断（写读语义不同源）。
            //   旧号不丢：上一轮 set-oa-number 的 timeline.summary 记着它，历史可回溯。
            //   ⚠️ **只放在 reactivate 分支，不并进 SYS_BACK_TO_INTAKE_GATE_SQL 常量本体**——那个常量与
            //     resubmit_intake（待修改→待受理）共用；resubmit_intake 的单从「待受理」经 intake_return
            //     退回「待修改」再提交，全程未经过 OA 可填窗口（该窗口在 intake-accept 之后才开），
            //     其 oa_number 结构上恒为 NULL，无需显式清（清了也是 no-op）——reactivate 的显式清零是
            //     防御性归一，防已拒绝单历史上曾在 OA 可填窗口内被设置过号（如受理后又被拒的边缘路径）。
            //   ⚠️ bug 流的 oa_number 同样受 §4 允许集约束（待受理不在内），reactivate 同样清零，无需按 type 分支。
            setFrags.push('oa_number = NULL');
          }
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
          // ⭐⭐ S3b（**主会话抽查**推翻 S3 首版·此时尚未送 codex 审）：随状态 UPDATE 同事务重置建单人侧通知列组——本轮暂缓通知锚点
          //   （见常量定义处注释）。**必须 bug-only**（`type === 'bug'`）——变更流 hold 从未重置过
          //   creator_notify_*，是既有已上线行为；该列组被 intake_return（受理退改自动通知建单人）等场景
          //   共用，真实可达链路"变更流单 intake_return 通知成功(sent) → resubmit_intake → intake_accept
          //   → hold"若不收窄，会把"曾通知过建单人退改"的审计痕迹与 UI 徽章一并抹掉——这不是"无端点消费
          //   就无害"的旁路清理，而是**抹掉已有场景写入的状态**，是真实回归。收窄=保持变更流现状=零回归；
          //   不收窄=给已上线功能引入新副作用。同 S2 roster 冻结守卫 bug-only 口径（assertRosterNotFrozen
          //   同样只在 issueType==='bug' 时生效），同一任务内同性质改动口径必须一致。
          if (type === 'bug') {
            setFrags.push(...SYS_CLEAR_CREATOR_NOTIFY_FIELDS_SQL);
          }
          break;
        }
        case 'resume': {
          // ⭐ [bug暂缓方案 20260803 v0.4 §4.2/口径 #1] resume 两流统一 reason 必填——bug 流新增 resume
          //   条目本就理由必填，变更流侧 transitions.js 的 resume requiredPayload 同步从 [] 改 ['reason']
          //   （行为变更，见该处注释）。C1 只加必填校验 + 把 reason 拼进 summary，既有 resumeDegradeInfo
          //   降级留痕逻辑保留不动（不得丢失）。
          const reason = (typeof payload.reason === 'string' ? payload.reason.trim() : '');
          if (!reason) throw new SysTransitionError(400, 'RESUME_REASON_REQUIRED', '请填写恢复原因');
          // [codex C3 对抗审 HIGH-A 回填] timeline 如实记录实际恢复到的状态；若 resolveToStatusInTxn 判定
          //   降级（暂缓期在册不满足 VERIFY/RELEASE 进族门），summary 备注"自动降级"+原目标，供审计追溯
          //   （非静默改写历史，实际发生了什么就记什么）。
          const info = opts.resumeDegradeInfo;
          summary = (info && info.degraded)
            ? `恢复到「${toStatus}」（自动降级，原目标「${info.originalTarget}」因暂缓期在册不满足进族门禁）｜原因：${reason}`
            : `恢复到「${toStatus}」｜原因：${reason}`;
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

      // [7] timeline 写入（event_type + action_code 按 transition 常量，summary 按动作，round_no 仅 submit 非空 C3b，
      //   payload_json 仅 liaison_test_pass 非空 C4/291 号 H-2·其余动作恒 NULL）
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline
           (issue_id, event_type, from_status, to_status, summary, action_code, round_no, operator_id, operator_name, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, transition.timelineEvent, fromStatus, toStatus, summary, transition.actionCode || null, timelineRoundNo,
         Number(actor.id) || null, actor.name || null, timelinePayloadJson]
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

      // ⭐⭐ S3（bug暂缓方案 §7.4）：resume 提交时同事务重置**子表** sys_issue_dev_assignees 的通知列组——
      //   注意不是主表！S0 §13-8 核实推翻了方案原假设：开发侧有两套独立通知列组——(A) 主表 sys_issues.notify_*
      //   服务【自动派发】路径，而 isAutoNotifyEnabled 恒 false ⇒ 该路径不可达，重置它没有意义；(B) 子表
      //   sys_issue_dev_assignees.notify_* 才是 notify-developer 手动通知（含本方案新增的 notify-resume-dev）
      //   的实际可达路径 ⇒ 本方案重置的是它。范围限**全部在册行**（removed_at IS NULL）——已移除成员的历史
      //   通知行保留（软删审计语义，同 :712 注释口径），不随 resume 抹除。
      // ⭐⭐ S3b（**主会话抽查**推翻 S3 首版"不分 type"判断·此时尚未送 codex 审）：**必须 bug-only**——子表 notify_* 同样是
      //   notify-developer 端点的实际可达路径，**变更流也在用**（既有已上线功能，非本方案新增）。真实
      //   可达链路"变更流单 assign 后点过「通知开发」(notify_status='sent') → hold → resume"若不收窄，
      //   会把这条记录抹掉，且开发可能被 notify-developer 重复通知——同上方 hold 侧 creator_notify_* 的
      //   理由：危害不在"有没有新端点消费"，而在"抹掉已有场景写入的状态"。收窄=保持变更流现状=零回归。
      //   同 S2 roster 冻结守卫 bug-only 口径，同一任务内同性质改动处理口径必须一致。
      // ⚠️ 必须同时显式按 action==='resume' 收窄——本段位于 switch 之后的通用流程区，其余动作（accept/
      //   return/close/…）都会经过这里，不加判断会把每次任意状态流转都错误地清空开发侧通知列组。
      if (action === 'resume' && type === 'bug') {
        await dbRunAsync(
          `UPDATE sys_issue_dev_assignees
              SET notify_status = 'not_sent', notified_at = NULL, read_at = NULL,
                  notify_message_key = NULL, notify_error = NULL, notify_sent_by = NULL
            WHERE issue_id = ? AND removed_at IS NULL`,
          [issueId]
        );
      }

      // [工期对接测试与风险等级拆分 方案 v1.1 §3.1b·C4 新增] liaison_test_return 花名册重置——③层，
      //   同一事务内、[6] 主表 UPDATE 已成功之后执行。逐状态映射（冻结）：code_submitted/no_code →
      //   pending（清 resolved_at/no_code_reason，令这些成员重新出现在"待提交"视图里）；excused 不动
      //   （保留豁免语义，不因打回而被拉回开发队列）。[S12 双路审查 Opus-1 收口·注释写实] 行数断言
      //   ≥1——runWGate ⑦ 分支准入前已显式检查 deliverableCount（见该函数 :2335 一带
      //   `else if (deliverableCount === 0)` 分支：零交付单会被分流到 liaison_test_skip_excused
      //   降级路径，根本不会进入「待对接测试」），故能走到本条 liaison_test_return 的单据结构上必然
      //   带着≥1 名 code_submitted/no_code 成员，本次重置理论上必然命中≥1 行；0 行说明 GATE 判定与
      //   本次重置之间数据不一致，throw 触发整事务回滚（同 [[feedback_state_machine_update_invariant]]：
      //   changes 检查 + 失败阻断，不用 .catch(warn) 静默吞）。
      if (action === 'liaison_test_return') {
        const ltResetResult = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees
              SET dev_status = 'pending', resolved_at = NULL, no_code_reason = NULL
            WHERE issue_id = ? AND removed_at IS NULL AND dev_status IN ('code_submitted', 'no_code')`,
          [issueId]
        );
        if (!ltResetResult || ltResetResult.changes < 1) {
          throw new SysTransitionError(500, 'LIAISON_TEST_RETURN_RESET_INVARIANT',
            `对接测试打回花名册重置行数应≥1，实际=${ltResetResult ? ltResetResult.changes : 0}（issue ${issueId}，数据不一致需人工核查）`);
        }
      }

      // ⭐⭐ PH-2 挂载点改造（C2.5 撤销·方案 v2.1 §2 矩阵·helper 本体不变）：原挂"离开待商议"两条边
      //   （随预沟通段废除退场）。新挂三条边——离开「待受理」且可能带着"未回复"咨询的路径：
      //   ① bug 的 issue_reject（from=待受理·admin·无 R2 意见前置守卫→可能带未回复咨询·188 号审 H2）
      //   ② intake_return（退回后单在待修改，comment 谓词=待受理，示例发布者答不了→必悬挂·自决 P3）
      //   ③ void（终态必清·自决 P3；from='*' 下对已过受理阶段的单，未回复咨询结构上已不可能
      //     ——R3 阻断+①②清理保证——helper 对"已回复/无咨询"恒 no-op，防御性挂上无害）
      //   变更流 issue_reject **不挂**：R2 前置守卫要求当前轮已有意见，"未回复"结构上到不了这条边。
      if ((action === 'issue_reject' && row.type === 'bug' && fromStatus === '待受理')
          || action === 'intake_return' || action === 'void') {
        const reasonLabel = action === 'issue_reject' ? 'bug 拒绝' : (action === 'intake_return' ? '退回修改' : '作废');
        await clearPendingConsultOnLeave(issueId, actor, reasonLabel);
      }

      await sysCommit();
      // ⭐ [C9-fix2 H1] 裁决的**只读副本**随返回值出去——端点要拼响应体（online_source / deleted_commit_count
      //   两个键）就只能从这里拿，不再有"端点自己持有一个可变载体"这种输入面。Object.freeze 让"只读"不止是
      //   口头约定：调用方改不了它，也就无法把一次 false 裁决篡改成 true 再去影响别处（当前无此消费点，
      //   冻结是把口子提前封死）。非 accept×待验证 的边恒为 null（引擎压根没问过）。
      const noCommitOnlineForCaller = noCommitOnlineVerdict
        ? Object.freeze({
          directFlip: noCommitOnlineVerdict.directFlip === true,
          deletedCommitCount: Number(noCommitOnlineVerdict.deletedCommitCount) || 0,
          blockedBy: noCommitOnlineVerdict.blockedBy || null,
        })
        : null;
      return { ok: true, fromStatus, toStatus: finalToStatus, notifyAfterCommit: transition.notifyAfterCommit || null, noCommitOnline: noCommitOnlineForCaller };
    } catch (txErr) {
      try { await sysRollback(); } catch (_) { /* ignore */ }
      throw txErr;
    }
  }

  // ⭐ 角色权限重构 C4·PH-2（184 号预审 HIGH·用户裁定，挂载点随 C2.5 撤销·方案 v2.1 §2 矩阵改造，
  //   helper 本体逻辑不变）：在特定离场边上原子清"未回复"的技术负责人咨询 + 留痕。背景：若单据离开
  //   「待受理」（bug issue_reject / intake_return / void，见调用点 [7] 之后的挂载判断）时还挂着一轮
  //   "已发起但技术负责人尚未回复"的咨询，它会变成永久悬挂的死数据（tech_lead_id 还指向一个已经离场的
  //   沟通对象，展示面/后续 resend 全部失去意义）。
  //   ⚠️ 只清"未回复"的悬挂咨询——**已回复**的轮次是历史事实（技术负责人确实提交过意见），不是垃圾，
  //   必须保留（PH-1 世界模型：意见唯一性绑咨询轮次，旧轮意见不因换轮/离开「待受理」而失效）。判定复用
  //   PH-1 同一条"当前轮是否有意见"（timeline id > 本轮 request_event_id 且 action_code='tech_lead_comment'），
  //   两处口径同源，不再各写一份（防漂移）。
  //   ⚠️ 必须在调用方已持有的同一事务内调用（本函数不自己 sysBeginImmediate/sysCommit）——失败必须
  //   throw 让外层事务整体回滚，不能吞错误静默 warn（同 [[feedback_state_machine_update_invariant]]：
  //   changes 检查 + 失败阻断，不用 .catch(warn) 假装无事发生）。
  //   ⚠️ NULL 防御（PH-1 世界模型明文要求）：`tech_lead_notify_request_event_id` 为 NULL 时 `id > NULL`
  //   在 SQL 三值逻辑下恒为 NULL，若不显式挡在前面，"无活动轮"会被悄悄当成"当前轮无意见"处理——
  //   这里先在 JS 层用 `== null` 短路返回（no-op），不依赖 SQL 侧的 NULL 语义兜底。
  async function clearPendingConsultOnLeave(issueId, actor, reasonLabel) {
    const row = await dbGetAsync(
      'SELECT tech_lead_id, tech_lead_name, tech_lead_notify_request_event_id FROM sys_issues WHERE id = ?',
      [issueId]
    );
    if (!row || row.tech_lead_id == null || row.tech_lead_notify_request_event_id == null) return false;   // 无活动轮，no-op
    const hasCurrentRoundComment = await dbGetAsync(
      `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
      [issueId, row.tech_lead_notify_request_event_id]
    );
    if (hasCurrentRoundComment) return false;   // 当前轮已有意见——已回复的轮次是历史，不清不留痕
    const upd = await dbRunAsync(
      `UPDATE sys_issues SET ${SYS_CLEAR_TECH_LEAD_FIELDS_SQL.join(', ')}, updated_at=datetime('now','localtime')
         WHERE id=? AND tech_lead_id=? AND tech_lead_notify_request_event_id=?`,
      [issueId, row.tech_lead_id, row.tech_lead_notify_request_event_id]
    );
    if (!upd || upd.changes !== 1) {
      throw new SysTransitionError(500, 'CLEAR_PENDING_CONSULT_FAILED', '自动取消未回复的技术负责人咨询失败');
    }
    await dbRunAsync(
      `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
       VALUES (?, 'note', ?, 'cancel_consult', ?, ?)`,
      [issueId, `${reasonLabel}：未回复的技术咨询已自动取消（原技术负责人：${row.tech_lead_name || ('#' + row.tech_lead_id)}）`,
       Number(actor.id) || null, actor.name || null]
    );
    return true;
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

  // ── GET /sys-issues/intake-liaisons：对接人下拉候选（建单优化批 C1 §3 改动点5）──────────
  //   ⚠️ 挂 requireAdmin（审 215 M-3）：建单弹窗现仅 admin 可用；**将来开放业务方建单时，本端点权限
  //   随建单权限同步放宽**（演进意图，非遗留欠账）。返回值来自同源 helper resolveActiveSysIntakeLiaisons()
  //   ——与主建单校验/衍生入口自动填/notify-intake 收件人解析共用同一 active 判据，不许四处各写。
  //   ⚠️ 顺序：须在 /sys-issues/:id 之前注册（同 /sys-issues/meta 先例），否则 'intake-liaisons' 被 :id 捕获。
  router.get('/sys-issues/intake-liaisons', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    try {
      const items = await resolveActiveSysIntakeLiaisons();
      res.json({ items });
    } catch (err) {
      logger.error('[系统迭代] 查询对接人候选失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '查询对接人候选失败' });
    }
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
      // ── 建单优化批 C1（方案 20260731_v1.2 §6b.2·复审 H-1 收口·新契约）──────────────────────────
      //   主建单端点请求矩阵（撤销 v1.1"旧客户端兼容零变化"的说法）：description 从本版起为**主建单
      //   端点必填**（新契约）；title 缺省时服务端按 description 首个非空行自动派生。
      //   ⚠️ 衍生建单两入口（/derive、/:id/reactivate 等独立代码路径）**完全不受影响**——自带 title、
      //   description 可空现状保留，不走本矩阵（方案 §6b.2 明文划界）。
      const rawDescription = (typeof b.description === 'string' ? b.description.trim() : '');
      if (!rawDescription) {
        return res.status(400).json({ error: '描述必填', code: 'DESCRIPTION_REQUIRED' });
      }
      const rawTitle = (typeof b.title === 'string' ? b.title.trim() : '');
      const title = rawTitle || deriveSysTitleFromDescription(rawDescription);
      // ── 建单优化批 C1（方案 §3 改动点3）：对接人必填，且须 ∈ resolveActiveSysIntakeLiaisons() 结果集
      //   （写读同源，不信前端）——与衍生入口自动填/notify-intake 收件人解析共用同一 helper。
      const intakeLiaisonId = parsePositiveId(b.intake_liaison_id);
      if (!intakeLiaisonId) {
        return res.status(400).json({ error: '对接人必填', code: 'INTAKE_LIAISON_REQUIRED' });
      }
      const activeIntakeLiaisonsAtCreate = await resolveActiveSysIntakeLiaisons();
      if (!activeIntakeLiaisonsAtCreate.some(l => l.id === intakeLiaisonId)) {
        return res.status(400).json({ error: '对接人非法（须为当前受理人）', code: 'INVALID_INTAKE_LIAISON' });
      }
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
      // deadline 校验（codex 14 M-2；四处优化 D2 起改用 datetime 版——**四个写 deadline 的端点必须同口径**，
      //   否则会出现"建单能填到分钟、一改范围/一编辑就被拒"的分裂）
      const dl = normalizeDeadlineDT(b.deadline);
      if (!dl.ok) return res.status(400).json({ error: '期望完成格式非法（应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM 的真实时间）', code: 'INVALID_DEADLINE' });
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
      // ── 建单优化批 C3b（方案 20260801_v1.3 §6c 设计点1）：需求方三字段缺省整组固化 ──────────────
      //   三字段全部缺省（未传或 trim 空）→ 整组按建单人身份固化：姓名=建单人 display_name、
      //   电话=建单人 users.phone（查不到/未填保持空，不造假值）、部门=「信息技术部」；
      //   任一字段有值 → 整组按提交值落库（**不逐字段混填默认**——防"业务方姓名+建单人电话"错配组合）。
      // ⭐ codex 219 M-1 收口：三字段类型白名单前置——只接受 undefined/null/string，其余类型（数字/对象/
      //   数组/布尔）400 拒绝，不静默当空处理。原逻辑用 `typeof v === 'string' ? trim : ''` 把非字符串
      //   脏值悄悄当"未提供"，会让 `requester_name:123` 这类客户端类型错误被误判为"三字段全缺省"，
      //   进而误固化为建单人身份——真实的输入错误被吞掉，故必须先响亮拒绝，再进 trim+整组判定。
      const invalidRequesterFields = ['requester_dept', 'requester_name', 'requester_phone'].filter(f => {
        const v = b[f];
        return v !== undefined && v !== null && typeof v !== 'string';
      });
      if (invalidRequesterFields.length) {
        return res.status(400).json({
          error: `需求方字段类型非法（须为字符串或不传）：${invalidRequesterFields.join(',')}`,
          code: 'INVALID_REQUESTER_FIELDS',
        });
      }
      const rawReqDept = (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : '');
      const rawReqName = (typeof b.requester_name === 'string' ? b.requester_name.trim() : '');
      const rawReqPhone = (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : '');
      let finalReqDept, finalReqName, finalReqPhone;
      if (!rawReqDept && !rawReqName && !rawReqPhone) {
        const actorRow = await dbGetAsync('SELECT phone FROM users WHERE id = ?', [actor.id]);
        finalReqDept = '信息技术部';
        finalReqName = actor.name;
        finalReqPhone = (actorRow && actorRow.phone) ? actorRow.phone : null;   // 无电话保持空，不造假值
      } else {
        finalReqDept = rawReqDept || null;
        finalReqName = rawReqName || null;
        finalReqPhone = rawReqPhone || null;
      }
      // ── 建单优化批 C3b §6c 设计点3：oa_exempt——严格 0/1（同 needs_feasibility 输入收窄范式），
      //   非法值 400 不静默降级。checkbox 是权威声明，服务端只认提交值（不从需求方字段反推——
      //   固化后需求方恒非空，反推必错）。
      let oaExempt = 0;
      const rawOaExempt = b.oa_exempt;
      const TRUTHY_OA = [1, '1', true];
      const FALSY_OA = [undefined, null, 0, '0', false, ''];
      if (TRUTHY_OA.includes(rawOaExempt)) oaExempt = 1;
      else if (!FALSY_OA.includes(rawOaExempt)) {
        return res.status(400).json({ error: 'oa_exempt 仅接受 0/1（布尔）', code: 'INVALID_OA_EXEMPT' });
      }
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
              needs_feasibility, intake_required, related_correction_no, intake_liaison_id,
              created_by, created_by_name, record_source,
              relay_notified_user_id, relay_notified_user_name, oa_exempt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?)`,
          [type, initialStatus, priority, title,
           rawDescription,
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           finalReqDept, finalReqName, finalReqPhone,
           dl.value,
           needsFeasibility, intakeRequired, relatedCorrectionNo, intakeLiaisonId,
           actor.id, actor.name,
           relayUserId, relayUserName, oaExempt]
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
          // 建单优化批 C1：description 从本版起主建单端点必填，rawDescription 恒非空（不再需要
          //   '信息技术部建单' 兜底文案——旧兜底只在 description 可空的旧契约下才可能触达）。
          [newId, finalStatus, rawDescription, actor.id, actor.name]
        );

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      if (rawAssignMode === 'A') {
        await dispatchSysNotify(newId, 'notifyAssignedDeveloper', actor.id);   // best-effort，同旧版 assign 动作的通知标记
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
        const row = await dbGetAsync('SELECT id, type, status, oa_number, oa_exempt, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // ⭐⭐ [C10·裁定2·绑单精判] 权限从 isSysCoordinator（admin∨白名单[13]）收紧为 **admin ∨ 该单 intake_liaison_id 本人**——
        //   示例对接人从"可指派所有单"变"仅指派名下单"（**行为变更**·方案已拍板+部署日公告）。指派发生在已绑单的待指派态，
        //   不涉及空单兜底（空单只在待受理态经 intake_accept 绑定）。
        // ⭐ [C10-fix5 HIGH] 绑单精判改 isBoundLiaisonEligibleOrAdmin（admin ∨ 绑定本人 ∧ 当前仍 eligible·async 读库）——
        //   撤销候选资格（role→viewer 等）同步撤销存量绑单操作权，与通知端失效对称（fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) {
          await sysRollback();
          return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' });
        }
        // ⭐⭐ R4 指派守卫（C2.5 撤销·方案 v2.1 §4·用户拍板"指派开发前必须有号"）：**变更流专属**——
        //   开发资源投入必须挂 OA 立项依据。对 oa_number **现值跑完整格式校验**（189 号审：`IS NOT NULL`
        //   会放过空串/空白/绕道写入的非法值），不合格一律 409 引导先补号。bug 不受限（OA 对 bug 可选·D2）。
        //   置于权限精判之后（无权者稳得 403，不借 409 侧信道探单据 OA 状态——同 [3.5] 排序理由）。
        // 统一走共享守卫（三入口同源·两份实现=漂移温床）；throw→txErr 回滚→外层 sendSysTransitionError
        await assertSysDevCommitmentOaGuard(id, row.type);

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
        // [275-M1 收口] 同上，消费共用 analyzeRosterForGate。
        const { activeCount: rosterActiveCount, allComplete: rosterAllComplete } = analyzeRosterForGate(rosterRows);
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
        // 建单优化批 C3b（方案 §6c 设计点6）：免 OA 单（oa_exempt=1）的指派留痕追加标注，与该单能绕过
        //   assertSysDevCommitmentOaGuard 格式校验这件事对齐，便于事后审计"这单为什么无号也能指派"。
        // ⭐ codex 219 M-2 裁定口径：免 OA 标注仅在**首次** /assign 落 timeline；dev-assignees 加成员/
        //   reassign 对 exempt 单同样经守卫放行，但**不重复标注**——详情页 OA 行常驻展示豁免态（见
        //   `无需 OA（内部自发）`），逐次标注是审计噪音，不追加。零行为改动（本条仅注释声明口径）。
        const assignSummary = `指派给 ${devName}` + (Number(row.oa_exempt) === 1 ? '（免 OA 单）' : '');
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
           VALUES (?, 'assign', ?, ?, ?, ?, ?)`,
          [id, row.status, targetStatus, assignSummary, actor.id, actor.name]
        );

        devAssignees = await fetchActiveDevAssignees(id);
        primaryRow = devAssignees.find(d => d.is_primary === 1) || {};
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      await dispatchSysNotify(id, 'notifyAssignedDeveloper', actor.id);
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
        const row = await dbGetAsync('SELECT id, type, status, assigned_to, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        const prevAssignedTo = (row.assigned_to !== null && row.assigned_to !== undefined) ? Number(row.assigned_to) : null;
        assertKnownIssueStatus(row.type, row.status);
        // ⭐⭐ [C10·裁定2·绑单精判] 权限从 isSysCoordinator 收紧为 **admin ∨ 该单 intake_liaison_id 本人**（行为变更）。
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) {
          await sysRollback();
          return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' });
        }
        assertRosterNotFrozen(row.type, row.status);   // S2·§4.5：暂缓期改派冻结（bug-only）
        assertMemberActionFamilyAllowed('reassign', row.type, row.status);
        const family = SF.familyOfStatus(row.type, row.status);

        const currentRows = await dbAllAsync(`SELECT id, user_id FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
        const currentIds = currentRows.map(r => Number(r.user_id));
        const currentSet = new Set(currentIds);
        const targetSet = new Set(targetIds);
        toAdd = targetIds.filter(uid => !currentSet.has(uid));
        // R4 下沉：批量差量含新增且在待指派族 → 同守卫（纯移除不拦）。⚠️ 现状**防御性在位但不可触发**：
        //   变更流 reassign 被上方族闸拦在 DEV/VERIFY（TYPE_OVERRIDE），bug 可达 D_PRE 但 helper 对 bug
        //   early-return（D2）。留守卫=若未来放开变更流 D_PRE reassign，OA 不变量已就位（verify [AS] 有
        //   不可达哨兵联动提醒）。
        if (family === 'D_PRE' && toAdd.length > 0) await assertSysDevCommitmentOaGuard(id, row.type);
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
        await dispatchSysNotify(id, 'notifyAssignedDeveloper', actor.id);
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
        const row = await dbGetAsync('SELECT id, type, status, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        // ⭐⭐ [C10·裁定2·绑单精判] admin ∨ 该单 intake_liaison_id 本人（行为变更·示例对接人从可操作所有单→仅名下单）。
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) { await sysRollback(); return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' }); }
        assertRosterNotFrozen(row.type, row.status);   // S2·§4.5：暂缓期加人冻结（bug-only）
        const addFamily = assertMemberActionFamilyAllowed('add', row.type, row.status);
        // R4 下沉：待指派族加成员=投入开发资源，变更流须先有 OA（与 /assign、reassign 同守卫）。
        //   ⚠️ 口径钉死（196 增量审 M2·产品语义裁定）：**D_PRE 族任何加成员请求先过 OA**——含重复加已在册、
        //   复活已移除成员（fail-closed 宁严勿漏·空数组在上游 rawIds 校验已 400 不达此处）；不做"算出实际
        //   新增集合再守卫"的精细化——那要在守卫前复制 addOrReaddMembers 的集合逻辑，两份必漂。
        if (addFamily === 'D_PRE') await assertSysDevCommitmentOaGuard(id, row.type);

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
        const row = await dbGetAsync('SELECT id, type, status, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);

        const target = await dbGetAsync('SELECT id, user_id, removed_at FROM sys_issue_dev_assignees WHERE id = ? AND issue_id = ?', [assigneeId, id]);
        if (!target || target.removed_at !== null) { await sysRollback(); return res.status(400).json({ error: '目标不在册', code: 'VALIDATION' }); }
        isSelf = Number(target.user_id) === Number(actor.id);
        // ⭐⭐ [C10·裁定2·绑单精判] 协调人部分从 isSysCoordinator（admin∨白名单[13]）收紧为 admin ∨ 该单 intake_liaison_id
        //   本人（行为变更）；**本人自移除（isSelf）不受影响**——开发转岗交接自移除是既有语义，绑单精判只管"非本人"那侧。
        // ⭐ [C10-fix5 HIGH] 绑单精判叠加 eligibility（撤销资格即失操作权·fail-closed）；isSelf 自移除不受此约束。
        const isBoundOrAdmin = await isBoundLiaisonEligibleOrAdmin(actor, row);
        if (!isSelf && !isBoundOrAdmin) { await sysRollback(); return res.status(403).json({ error: '仅管理员、该单对接人或本人可移除', code: 'NOT_BOUND_LIAISON' }); }
        assertRosterNotFrozen(row.type, row.status);   // S2·§4.5：暂缓期移人冻结（bug-only，含本人自移除）
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
        const row = await dbGetAsync('SELECT id, type, status, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        // ⭐⭐ [C10·裁定2·绑单精判] admin ∨ 该单 intake_liaison_id 本人（行为变更）。
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) { await sysRollback(); return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' }); }
        assertRosterNotFrozen(row.type, row.status);   // S2·§4.5：暂缓期开脱冻结（bug-only）
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
        const row = await dbGetAsync('SELECT id, type, status, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        rowStatusAtStart = row.status;
        assertKnownIssueStatus(row.type, row.status);
        // 2. 校验（⭐⭐ [C10·裁定2·绑单精判] admin ∨ 该单 intake_liaison_id 本人·行为变更；主状态∈SYS_DEV∪SYS_VERIFY；目标在册∧excused）
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) { await sysRollback(); return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' }); }
        assertRosterNotFrozen(row.type, row.status);   // S2·§4.5：暂缓期开脱恢复冻结（bug-only）
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
      // ⭐⭐ 技术负责人读权（2026-07-28 手工验收发现·**写读不同源**）：C3 把提交评估意见的**写权**给了
      //   本单技术负责人（含变更流的「待商议」单），但读端可见性还停在 C1 时代的 `type='bug'`——
      //   方案 §4-C1 核实表当时判「可见性默认保持」，那是 C2.5 预沟通段**还不存在**时做的决定，
      //   C2.5/C3 把技术负责人的工作对象扩到变更流后，这条决定就过期了，没人回头改它。
      //   后果（实测）：示例发布者列表看不到被咨询的 feature 单、详情 403、钉钉深链点进去也 403——
      //   方案 §3 角色表要求他「平台回一条最终评估意见」，而他**在平台上根本够不到那张单**。
      //   ⚠️ 判定**刻意不依赖 SYS_TECH_LEAD_IDS 白名单**（与 rosterVisibilitySql 同范式）：
      //     `tech_lead_id=我` 与「timeline 里有我提交的 tech_lead_comment」这两个条件本身就是参与证据，
      //     只有真被咨询过的人才满足。挂白名单反而会让「日后换人」把前任已写的评估记录一并锁死。
      //   ⚠️ 覆盖两段（用户 2026-07-28 拍板选 A）：① 当前被咨询 ② 历史回过意见（咨询已被 cancel /
      //     PH-2 自动清 / reactivate 清九列之后，仍看得到自己写过的那张单）——与开发成员「曾有行即可见」一致。
      //   ⚠️⚠️ **本改动把 sys_issue_timeline 从「纯审计日志」提升为「授权依据」**（codex 审 MED 的
      //     recommendation·已验证当前不成立但必须固化）：一旦某条 `action_code='tech_lead_comment'`
      //     的流水行可被伪造，伪造者就获得该单的**持久读权**。当前**生产运行时写路径**（routes/ 下的
      //     HTTP 路由与服务端代码）已核实成立的三条不变量：
      //       ① 全部 10 处 `INSERT INTO sys_issue_timeline` 的 `action_code` 均为 **SQL 字面量**，
      //          无一处用占位符从变量/请求体传入；
      //       ② `'tech_lead_comment'` 在生产代码内只有 tech-lead-comment 端点一处写入，`operator_id` 取
      //          `sysActor(req)` 的认证用户 id（非请求体字段）；
      //       ③ 不存在通用的 timeline 写入 / 修改 HTTP 端点。
      //     ⚠️ 核实范围**刻意排除 `scripts/` 验证夹具**（187 号审 LOW 收窄）：verify-sys-tech-lead-comment
      //     的 [V] 组自身就用 raw SQL 插入该 action_code 造"历史参与"夹具——那是测试进程内存库里的受控
      //     写入，非生产攻击面；此前"全仓"的表述把它也圈了进去，会误导后续安全审查以为夹具也被禁止。
      //     ⚠️ **日后若新增"可自定义 action_code 的 timeline 写入口"（含导入、后台脚本、批量修复工具），
      //     必须同步评估本处授权语义**——那不再只是多了一条日志，而是多了一条发读权的路。
      const techLeadVisibilitySql = `(tech_lead_id = ? OR EXISTS (SELECT 1 FROM sys_issue_timeline tl
             WHERE tl.issue_id = sys_issues.id AND tl.action_code = 'tech_lead_comment' AND tl.operator_id = ?))`;
      // ⭐ 角色权限重构 C1（codex C1 审 HIGH-2）：**受理人[13] 全类型可见**，与 admin 同不加 where 限制。
      //   必要性：C1 把指派权扩到全类型，若列表仍只放行 bug，示例对接人就会「后端能指派 feature、界面却找不到那张单」
      //   ——写读不同源造成的功能断裂（[[feedback_write_read_same_semantic]]）。受理人要受理**所有**新单、
      //   指派**所有**类型，故其可见面与 admin 一致（作废单仍由下方 include_voided 统一过滤，那条仅 admin 生效）。
      const isIntakeLiaisonUser = isSysIntakeLiaison(uid);
      // ⚠️ codex 审 LOW：列表此前缺 `uid > 0` 防护（详情端有）。uid 非正（脏 token / id 缺失）时下面所有
      //   等值判据都会拿一个无意义的值去比对（`assigned_to = 0` 之类可能命中脏行），故显式挡在最前：
      //   非 admin 非受理人且 uid 非正 → 恒空集（与"其他登录用户不可见"的既有语义一致，非 403）。
      if (!isAdmin && !isIntakeLiaisonUser && !(uid > 0)) {
        where.push('1 = 0');
      } else if (!isAdmin && !isIntakeLiaisonUser) {
        // ④ bug 对接人白名单（**可见性语义·非操作权**）：C1 后该名单在写路径上已完全退场，
        //   这里保留是因为技术负责人示例发布者[7] 仍需看到 bug 单才能接收咨询、回评估意见（C3）。
        //   ⚠️ 必与详情读端同源，否则「列表看不到但能开详情」写读不一致。
        // ⭐⭐ [C10-fix5 MED-1·写读同源·向绑定人授读权] 本单 intake_liaison_id 本人可见其名下单——补 `intake_liaison_id = ?`
        //   析取（`uid > 0` 由上方 :5259 前置守卫保证：非 admin 非[13] 且 uid 非正已落 `1=0` 空集分支·此处 uid 恒正·多推冗余但不错）。
        //   现网 [13] 走 isIntakeLiaisonUser 全量可见分支、加此析取对其冗余；**非 [13] eligible 成员被绑对接人**（有操作权
        //   isBoundLiaisonEligibleOrAdmin 但此前列表看不到/详情 403）加了才可见（[[feedback_write_read_same_semantic]] fail-closed 收口）。
        //   ⚠️⚠️ **读写不对称·有意设计非疏漏**：可见性=**纯绑定身份**（不叠 isIntakeLiaisonEligible），操作权=身份 ∧ 当前 eligible
        //     （HIGH 已 403 挡撤销资格者操作）。故被撤销候选资格（role→viewer）的旧对接人**仍能看到名下旧单**（曾负责可查·非
        //     越权）但改不动它——读比写宽。列表叠 eligibility 需对每行子查询 users 表、成本高收益低，故只在写路径（操作）收 eligibility。
        if (isSysBugLiaison(uid)) {
          // 参数顺序：assigned_to / intake_liaison(MED-1) / roster / techLead(tech_lead_id) / techLead(operator_id)——type='bug' 无占位符
          where.push(`(assigned_to = ? OR intake_liaison_id = ? OR type = 'bug' OR ${rosterVisibilitySql} OR ${techLeadVisibilitySql})`);
          params.push(uid, uid, uid, uid, uid);
        } else {
          // 非 admin 非对接人：自己被指派的单（开发）∪ 旧上线编排指定执行开发的历史单（release_assignee_id，
          //   2026-07-07 机制，4 端点已于 2026-07-30 全封，纯只读残留，仅历史 bug 单可能非空）∪ **本批次上线
          //   执行人子表在册**（sys_release_executors，方案 v1.7 §4.4 改造 8，替代此前批次级
          //   sys_releases.release_assignee_id 单列——旧单列本就未曾接入本 WHERE，本条 EXISTS 是新增放行，非
          //   替换）∪ 在册/历史参与该单的成员（HIGH-B）。
          //   ⚠️ 写读同源（[[feedback_write_read_same_semantic]]）：详情端点（GET /sys-issues/:id）isReleaseExecutor
          //   已改子表 EXISTS 判定（C4a），列表须镜像同一集合——否则「详情打得开、列表看不见」写读不一致。
          //   ⚠️ 迭代单维度关联键必须 `e.release_id = sys_issues.release_id`（本单所属批次），不可与批次维度
          //   `e.release_id = r.id` 混用（方案 §4.4 #11 复制陷阱）。
          // ⭐ [C9 读点标注·方案 v1.7 §10.1 逐点标注要求] **本「我的」可见面读点显式声明：不按「已上线」
          //   来源分流，但免上线直翻单只能靠前两条析取项被看见，这是设计如此、不是遗漏。**
          //   直翻单 `release_id` 恒 NULL（§10.1 字段契约：不伪造批次关联），故本行 releaseExecutor
          //   的 EXISTS（关联键 `e.release_id = sys_issues.release_id`）对它**结构性永不命中**——NULL
          //   参与等值比较恒为 NULL/不成立。这不构成可见性缺口：批次执行人这条可见理由的前提就是
          //   "这单挂在某个批次上、而我是那个批次的执行人"，而直翻单**从来没进过任何批次**，也就不存在
          //   "执行人"这个角色。直翻单的开发照常经 `assigned_to` 与 roster/历史参与两条析取项看到自己的单。
          //   ⚠️ 日后若给直翻单补任何"伪批次"关联来让它出现在批次视图里，等于推翻 §10.1 字段契约，
          //     须先回方案改口径，不可在本 SQL 里绕（那会让 DTO 三分支把它误判成 release_publish）。
          const releaseExecutorVisibilitySql = `EXISTS (SELECT 1 FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.user_id = ? AND e.removed_at IS NULL)`;
          // ⭐⭐ [C10-fix5 MED-1·写读同源] 同 bug-liaison 分支：补 `intake_liaison_id = ?` 析取（uid>0 由 :5259 守卫保证）——
          //   非 [13] eligible 成员被绑对接人后列表可见其名下单（读=纯身份·不叠 eligibility·读写不对称见上方分支注释）。
          // 参数顺序：assigned_to / intake_liaison(MED-1) / release_assignee_id / releaseExecutor / roster / techLead(tech_lead_id) / techLead(operator_id)
          where.push(`(assigned_to = ? OR intake_liaison_id = ? OR (release_assignee_id = ? AND type = 'bug') OR ${releaseExecutorVisibilitySql} OR ${rosterVisibilitySql} OR ${techLeadVisibilitySql})`);
          params.push(uid, uid, uid, uid, uid, uid, uid);
        }
      }
      // 默认过滤作废（前端可传 include_voided=1，仅 admin 生效）
      const includeVoided = isAdmin && (req.query.include_voided === '1' || req.query.include_voided === 'true');
      if (!includeVoided) where.push("status != '已作废'");

      // 可选筛选（type/status/system/priority/release/assigned）
      const addEq = (col, val) => { if (val !== undefined && val !== null && val !== '') { where.push(`${col} = ?`); params.push(val); } };
      addEq('type', req.query.type);
      // ⭐ [C9 读点标注·方案 v1.7 §10.1 逐点标注要求] **本读点显式声明：status 筛选不区分「已上线」的来源。**
      //   `?status=已上线` 命中的是**两条入口写出的全部已上线单**（批次发布 release_publish + 免上线直翻
      //   no_commit_acceptance），因为两条路径写的是同一根 status 列的同一个值——这是 §10.1 字段契约
      //   「status 一列不分家」的直接后果，不是遗漏。用户按状态筛选时想看的是"哪些单已经上线了"，
      //   来源是列表里「上线方式」那一格回答的问题，不是筛选条件要回答的。
      //   ⚠️ 刻意**不提供** `?online_source=` 筛选：C9 是纯展示扩字段（同 C8 risk_level 的既定口径，
      //     见下方 SELECT 注释与 panel-static 的反向断言），加筛选属独立需求，须另行立项。
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
        // [C8 风险/优先级双显·方案 v1.7 §9.2] risk_level 加入列表 SELECT——**只读扩字段**，纯展示用途
        //   （列表页优先级列改上下双行：上=优先级徽章、下=风险等级小字）。不加筛选、不加排序、不进任何
        //   写路径；C5 受理门 intake_accept 仍是该列唯一写点，本次零改动。
        `SELECT id, type, status, priority, risk_level, title, system_name, module_name, source,
                assigned_to, assigned_to_name, scheduled_start, dev_estimated_at, deadline,
                created_by, created_by_name, requester_name, requester_dept,
                origin_issue_id, release_id, needs_release, online_source,   -- ← [C9] deriveOnlineSourceKind 的输入之一（另两列 status/release_id 本就在）
                release_assignee_id, release_assignee_name, release_assignee_notify_status,
                -- C4a（方案 §4.4 #8）：批次级单列旧字段（上两行）已冻结不再更新，本单所属批次的执行人
                --   通知态改由子表实时聚合派生（六态优先级判定同 getReleaseNotifySummary/方案 §4.3，
                --   此处内联为相关子查询避免逐行 N+1）；release_id 为空时天然落 'none'（NULL 比较恒假）。
                --   ⚠️ L7（Opus 预筛）字段命名统一为 executor_notify_summary（与批次列表端点/hotfix-publish
                --   响应体同名字段对齐，不再用"release_"前缀多此一举地区分——本字段本就挂在 issue 行上，
                --   前缀不表达任何额外信息；改名时机=零消费者（前端 C5 未接线），零成本）。
                --   ⚠️ 305 号 M2（Opus 预筛）改正向计数法（fail-closed）：原"<>"比对写法在 SQL 三值逻辑下对
                --   NULL 不安全——"notify_status <> 'sent'" 遇 NULL 求值为 NULL（非 TRUE），会让 EXISTS 子
                --   查询把这一行当"不违反"处理，悄悄默认判成"全 sent"这类过于乐观的聚合结果。⚠️ 实测订正：
                --   该列本身还叠着 NOT NULL 约束（非仅 CHECK），真 NULL physically 写不进这张表，即便用
                --   PRAGMA ignore_check_constraints 也只放宽 CHECK、不放宽 NOT NULL——纯 NULL 场景在当前
                --   schema 下确实不可达。但六态聚合是显示逻辑不是安全边界，宁可多一层防御也不依赖"这一列
                --   永远合法"这个假设本身（schema 未来若放宽 NOT NULL，或 CHECK 之外仍能塞进值域外脏字符串
                --   ——同样的三值逻辑隐患对"值域外未知值"依然成立，见下方正向计数写法本身不依赖任何值是否
                --   为 NULL）。改用"总数=匹配数"的正向计数：COUNT(*) 与
                --   SUM(CASE WHEN notify_status='sent' THEN 1 ELSE 0 END) 比较——NULL/脏值行在 SUM 里贡献 0
                --   （不会被误计入"sent"），两个计数天然不相等，稳定跌落到兜底分支（fail-closed，不会
                --   fail-open 地宣称"全部正常"）。
                (CASE
                   WHEN (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL) = 0 THEN 'none'
                   WHEN (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL AND e.notify_status = 'sending') > 0 THEN 'sending'
                   WHEN (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL)
                        = (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL AND e.notify_status = 'sent') THEN 'sent'
                   WHEN (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL)
                        = (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL AND e.notify_status = 'not_sent') THEN 'not_sent'
                   WHEN (SELECT COUNT(*) FROM sys_release_executors e WHERE e.release_id = sys_issues.release_id AND e.removed_at IS NULL AND e.notify_status = 'sent') > 0 THEN 'partial'
                   ELSE 'failed'
                 END) AS executor_notify_summary,
                reopen_count, return_count, scope_changed, created_at, updated_at,
                tech_lead_id, tech_lead_notify_status,   -- S5 手动化：列表通知徽章消费（193 复审：oa_number 已撤——
                --   "顺带"加列=未经 187 读权契约证明的扩面；徽章不消费它，列表不需要它）
                (SELECT EXISTS(SELECT 1 FROM sys_issue_timeline tl2 WHERE tl2.issue_id = sys_issues.id
                    AND tl2.action_code = 'tech_lead_comment'
                    AND tl2.id > sys_issues.tech_lead_notify_request_event_id))
                  AS has_current_tech_lead_comment,       -- 193 复审 M：列表徽章"已留言收口"权威判定（与详情红条同口径·
                --   event_id NULL 时 id>NULL 恒 NULL→EXISTS false→徽章条件另判 tech_lead_id·前端零自推导）
                (SELECT json_group_array(user_name) FROM (
                   SELECT user_name FROM sys_issue_dev_assignees
                    WHERE issue_id = sys_issues.id AND removed_at IS NULL
                    ORDER BY user_id ASC
                 )) AS dev_roster_names,
                -- S4（bug暂缓方案 20260803 v0.4 §6.3）：「已暂缓 N 天」徽章取数——取本单**最近一次** hold
                -- 事件的 created_at（MAX 天然只取最新一轮，多轮暂缓不累加）。⚠️ 该值在 resume/void 后依然
                -- 非 NULL（历史事实不会消失）——前端必须叠加 status='已暂缓' 才能渲染，本列本身不做状态门控
                -- （同 has_current_tech_lead_comment 范式：SQL 只出数，状态语义交给前端/调用方判断）。
                (SELECT MAX(created_at) FROM sys_issue_timeline
                   WHERE issue_id = sys_issues.id AND action_code = 'hold') AS last_held_at,
                -- S2（贴图四件与工期测试段 20260805·三列一体设计）：末次进入「待验证」的单据级完成时刻
                -- （Q5 拍板：列表只取末次，打回次数不进列表）。⚠️ 刻意不用 sys_issue_dev_events 的
                -- submit/no_code MAX——多开发部分提交时那个 MAX 会把"还没好"的单误报出完成时间，
                -- timeline status_change 才是整单完成的权威落点。返工进行中（打回回到开发中）时
                -- 本列照常显示上次完成时刻，同行状态列可见真实状态，详情页另有首末+次数全貌。
                -- 无记录（老单早于 timeline 镜像/从未完成）返回 NULL 属诚实缺失。SQL 只出数不做
                -- 状态门控（同 has_current_tech_lead_comment/last_held_at 范式）。
                -- ⚠️ S4 段1收口（codex 263 号 M-1·Opus 预筛发现·主会话亲核成立）：必须加
                -- action_code 条件——变更流 hold 允许 from='待验证'（transitions.js:308-309），
                -- resume 回解后会写一条同样 event_type='status_change'/to_status='待验证' 但
                -- action_code='resume' 的 timeline 行（transitions.js:324），若不排除，MAX 会把
                -- 「恢复时刻」冒充「完成时刻」。恢复后的单保留原完成时刻不变，正合 Q5「什么时候真的
                -- 好了」的语义。
                -- [S12 双路审查 Opus-4 LOW 收口] 以下合并改写自两段曾并存但字面互斥的旧注释（一段说
                -- "W-GATE mirror 行是唯一真完成落点"，另一段说"完成落点已挪到引擎 transition"），
                -- 读者会不知道信哪句。真相是完成落点按 type 分岔，不是"整体挪走"：
                --   · improvement/bug：仍走原 DEV↔VERIFY 二元判定，唯一完成写点是 W-GATE 门禁转移的
                --     timeline mirror INSERT（本文件 runWGate 函数体内 :2443-2447，该 INSERT 的列清单
                --     本就含 action_code 这一列——只是其值取自 mirrorActionCode 变量，这两个 type 走的
                --     分支该变量恒为 null，故这两个 type 落库的 action_code 恒 NULL，未受 v1.1 触碰）。
                --   · feature（[工期对接测试与风险等级拆分 方案 v1.1 §3.1 点7/D17·C4 收口]）：走测试段
                --     后完成落点从"mirrorActionCode 恒 null"的默认路径，挪到该 INSERT 同一列写入三个
                --     具名 actionCode 之一——liaison_test_pass 恒写（liaison-test-pass 端点独立事务）、
                --     liaison_test_skip_liaison / liaison_test_skip_excused 两条降级路径由 runWGate
                --     本体写（mirrorActionCode 变量在这两条分支被赋具名值）。若不跟着改，所有 feature
                --     单实际完成时刻恒 NULL（C0 矩阵验证清单 §A-H1 静默回归）。"实际完成"=
                --     liaison_test_pass 正常通过、或 ⑥ liaison_test_skip_liaison（对接人失效降级）、
                --     或 liaison_test_skip_excused（S12 双路审查 Opus-1 HIGH 修复新增：全员 excused
                --     无交付物可测，同款降级），三者业务含义相同——"不再需要开发继续动，进入验收侧
                --     视野"，只是触发原因不同。
                -- liaison_test_skip_excused 曾在 v1.1 D21 撤销决策树⑤分支后一度成死值（无代码路径写
                -- 它）；随 S12-Opus-1 修复"全员 excused 直落待验证"复活——现在是真实可达的写者，
                -- 非"宽松匹配富余项"，白名单本身未改动（含义随实现变化，字面数组不变）。
                (SELECT MAX(created_at) FROM sys_issue_timeline
                   WHERE issue_id = sys_issues.id AND event_type = 'status_change'
                     AND to_status = '待验证'
                     AND (action_code IS NULL OR action_code IN ('liaison_test_pass', 'liaison_test_skip_excused', 'liaison_test_skip_liaison'))
                ) AS last_completed_at,
                -- C1（commit号两列 20260803·锚点 D4）：前端/后端 commit 编码聚合。
                --   ⚠️ 值协议 = JSON 数组字符串（如 '["a3f9c21","1c5d883"]'），非分隔符拼接明文，两条理由：
                --   ① 前端要显示「首条 + 等 N 条」（D3）必须拿到数组才能算 N，拼好的串算不出；
                --   ② commit_ref 是 1-200 字符自由文本、无"禁分号"约束，分隔符拼接不可逆——与上方 4177
                --      注释记录的 89 号审 LOW-1（dev_roster_names 人名含逗号被 split 错拆）是同一个坑。
                --   内层子查询先 ORDER BY 再聚合（json_group_array 同 GROUP_CONCAT 一样不支持直接 ORDER BY）；
                --   id ASC = 录入顺序，与发布快照 snapshotReleaseCommitsInTxn 的 ORDER BY id ASC 同源。
                --   零命中返回合法空数组 '[]'（非 NULL，SQLite 对 json_group_array 空集的既有特例，同 4180 注释）。
                --   ⚠️ 刻意不关联 sys_issue_dev_assignees：成员被移除（removed_at 非空）后其 commit 仍要显示
                --   ——commit 是已发生的事实，与快照 §8「查全部现存行（含 removed 实例）」同口径。
                --   ⚠️ 本段注释禁用反引号——整条 SQL 在 JS 模板字符串内，反引号会提前终止字符串（本次已踩）。
                --   ⭐ 末次合并审（codex 246 MED-1）补元素级过滤：本查询原样聚合 commit_ref，而 C2 的
                --   refsByComponent（批次详情侧）只收非空字符串 ⇒ 同一张脏数据单，本端点出 '[null]' /
                --   '["   "]'，批次详情出 '[]'，**两个后端端点的 raw 契约不一致**；前端 helper 恰好把两者
                --   过滤成同样显示，所以单页冒烟全绿、问题被掩盖。这是"C2 收口时加了过滤却没回头同步 C1"
                --   的漏法（同 feedback_pattern_sweep_not_symptom_list：修同类问题要按模式扫全仓，
                --   不能只修被点名的那一处）。此处与 refsByComponent 的 JS 规则对齐。
                --   ⚠️ 必须写 trim(X, chars) 的双参形式：SQLite 的单参 trim(X) 只去空格，而 JS 的
                --   String.trim() 去所有空白（含 Tab/LF/CR）——写成单参会让「Tab+换行+空格」这类值
                --   在 SQL 侧留下、JS 侧滤掉，两端口径依然不一致（本次实测踩到：X1b 交叉断言在修了
                --   单参版之后仍然红，才暴露这个语义差异）。char(32/9/10/13)=空格/Tab/LF/CR。
                --   ⚠️ 口径边界（复审 246-B rec-3 精确化）：本过滤是 **ASCII whitespace 防御**，不是
                --   "完全等价 JS String.trim()"——后者还覆盖 \v \f NBSP FEFF 及多类 Unicode 空格。
                --   对 commit 编码这种字段继续扩到完整 Unicode 空白属过度设计，除非产品契约明确要求等同。
                --   ⚠️ 另注：本表的 CHECK 用的也是**单参 trim**，故 Tab/LF 类空白值**本就能合法写入**
                --   （length(trim(<Tab><LF><空格>))=3>0）⇒ 这类脏值不限于历史数据，当前写入端即可产生。
                --   ⚠️ 本段注释禁写反斜杠转义序列（如 反斜杠t、反斜杠n）——整条 SQL 在 JS 模板字符串内，
                --   它们会被 JS 先转义成真实控制字符，换行会**截断 -- 注释**、后半句落进 SQL 正文
                --   报 syntax error（本次已踩；与本文件上方"注释禁用反引号"同源，都是模板字符串的坑）。
                (SELECT json_group_array(commit_ref) FROM (
                   SELECT commit_ref FROM sys_issue_dev_commits
                    WHERE issue_id = sys_issues.id AND component = 'frontend'
                      AND commit_ref IS NOT NULL
                      AND trim(commit_ref, char(32) || char(9) || char(10) || char(13)) <> ''
                    ORDER BY id ASC
                 )) AS frontend_commit_refs,
                (SELECT json_group_array(commit_ref) FROM (
                   SELECT commit_ref FROM sys_issue_dev_commits
                    WHERE issue_id = sys_issues.id AND component = 'backend'
                      AND commit_ref IS NOT NULL
                      AND trim(commit_ref, char(32) || char(9) || char(10) || char(13)) <> ''
                    ORDER BY id ASC
                 )) AS backend_commit_refs,
                -- [C11·§10.3] 不分 component 的**全 commit 合并列**（严格按 id ASC）——命中「单组版本号」系统时
                --   用它替换 backend_commit_refs、并把 frontend_commit_refs 置空，实现「历史 frontend 行合并进
                --   版本号组、不进前后端占比分母」（JS 侧 deriveSingleCommitGroupDTO 命中后改写，见下）。同款
                --   双参 trim 防御（与上两列一致，理由见其注释）。非命中系统不消费本列，前端也不读它。
                (SELECT json_group_array(commit_ref) FROM (
                   SELECT commit_ref FROM sys_issue_dev_commits
                    WHERE issue_id = sys_issues.id
                      AND commit_ref IS NOT NULL
                      AND trim(commit_ref, char(32) || char(9) || char(10) || char(13)) <> ''
                    ORDER BY id ASC
                 )) AS all_commit_refs
           FROM sys_issues
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY id DESC`,
        params
      );
      // ⭐ [C9·§10.1] 列表逐行派生「已上线」来源三分支——与详情端点走**同一个** deriveOnlineSourceKind，
      //   不在这里重写一份判据（读点分散是 §10.1"所有已上线读点逐点标注"要防的事）。
      //   ⚠️ 本 SELECT 必须取到 status/release_id/online_source 三列，派生函数才有输入（online_source
      //     已随本批加入列投影，另两列本就在）。
      // ⭐ [C11·方案 v1.7 §10.3·M5/M6] 逐行派生单组「版本号」DTO 契约 + 展示统一合并：
      //   ① 三字段 single_commit_group/group_label/allowed_components（后端唯一权威·前端只渲染不判定）。
      //   ② 命中系统：backend_commit_refs 换成 all_commit_refs（含历史 frontend 行·严格 id 序）、
      //      frontend_commit_refs 置空 '[]'——「命中系统 commit 计入版本号类，不进前后端占比分母」（item 8）+
      //      「历史 frontend 行合并进版本号组展示」（item 6）。**登记接受**：component 值本身不再可反推 HRD 语义。
      //   判据用 loadSingleCommitGroupSystemSet 一次读配置 + 逐行 Set.has（避免 N 次 readSystemConfig 往返），
      //   与单据级端点 isSingleCommitGroupSystem 同源（都走同一份 Set 语义）。
      const singleCommitSystemSet = await loadSingleCommitGroupSystemSet();
      for (const r of rows) {
        r.online_source_kind = deriveOnlineSourceKind(r);
        const dto = deriveSingleCommitGroupDTO(singleCommitSystemSet, r.system_name);
        r.single_commit_group = dto.single_commit_group;
        r.group_label = dto.group_label;
        r.allowed_components = dto.allowed_components;
        if (dto.single_commit_group) {
          r.backend_commit_refs = r.all_commit_refs;   // 合并列（不分 component·id 序）→ 版本号组
          r.frontend_commit_refs = '[]';               // 前端组置空（不进前后端分母）
        }
        delete r.all_commit_refs;                       // 内部合并列不外泄（前端不需要额外字段）
      }
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
      // S3（四件①，2026-08-05）：详情补 last_completed_at——与列表端点 GET /sys-issues 完全同一 SQL
      // （见该端点完整注释：末次进入「待验证」的单据级完成时刻 + action_code 白名单排除 resume 语义洞
      //   的完整推导；本处不复制全文，避免两处注释各自漂移）。sys_issues.* 与该计算列混用属合法 SQL。
      //   ⚠️ 两处子查询须逐字符一致（S4 段1收口 codex 263 M-1）。[方案 v1.1 §3.1 点7/D17·C4] 同批改
      //   IN 白名单——见列表端点处完整注释，理由不重复。
      const row = await dbGetAsync(
        `SELECT sys_issues.*,
                (SELECT MAX(created_at) FROM sys_issue_timeline
                   WHERE issue_id = sys_issues.id AND event_type = 'status_change'
                     AND to_status = '待验证'
                     AND (action_code IS NULL OR action_code IN ('liaison_test_pass', 'liaison_test_skip_excused', 'liaison_test_skip_liaison'))
                ) AS last_completed_at
           FROM sys_issues WHERE id = ?`,
        [id]
      );
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // [codex 101 号 LOW 回填] gate_deferred_at 是 GATE 纵深方案 A 的内部实现标记（服务端消费，见方案
      //   §16 补丁五置/清/消费规则表），非读模型字段——`SELECT *` 会连带把它塞进 `row` 一并 res.json 出去，
      //   在此删除（既有代码侵入最小：不改 SELECT 语句、不改下方长 res.json 行）。列表端点（GET /sys-issues）
      //   本就用显式列投影，不含该列，不受影响。
      delete row.gate_deferred_at;
      // ⭐ [C9·方案 v1.7 §10.1] 「已上线」来源三分支派生（后端唯一权威·前端只渲染不判定）。
      //   非「已上线」单恒 null——不是"不适用"要用某个占位串表达，读点判 null 即可。
      row.online_source_kind = deriveOnlineSourceKind(row);
      // ⭐ [C11·方案 v1.7 §10.3·M6] 单组「版本号」DTO 契约（后端唯一权威·前端只按 DTO 渲染不自行判定）：
      //   single_commit_group / group_label（「版本号」）/ allowed_components（命中系统只含 backend）。命中系统的
      //   提交界面渲染单组、详情 commit 表一律显示 group_label（含历史 frontend 行合并进版本号组展示，不迁移数据）。
      {
        const dto = deriveSingleCommitGroupDTO(await loadSingleCommitGroupSystemSet(), row.system_name);
        row.single_commit_group = dto.single_commit_group;
        row.group_label = dto.group_label;
        row.allowed_components = dto.allowed_components;
      }

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
      // ⭐⭐ [C10-fix5 MED-1·写读同源·与列表读端同源] 本单 intake_liaison_id 本人可见详情——**纯绑定身份**判定
      //   （不叠 isIntakeLiaisonEligible·读写不对称：可见性=身份·操作权=身份∧当前 eligible·读比写宽是有意设计，
      //   见列表端 :5265 附近完整注释）。非 [13] eligible 成员被绑对接人后（有操作权但此前详情 403）加了才可开。
      const isBoundLiaison = row.intake_liaison_id != null && Number(row.intake_liaison_id) === uid && uid > 0;
      // ④ bug 对接人白名单（**可见性语义·非操作权**）：C1 后写路径已完全不用该名单；
      //   保留可见性是为技术负责人示例发布者[7] 能看到 bug 单以接收咨询、回评估意见（C3）。
      const isBugLiaison = isSysBugLiaison(uid) && row.type === 'bug';
      // ⭐⭐ 技术负责人读权（写读同源修复·**与列表读端逐条同源**，见列表端 techLeadVisibilitySql 的完整说明）：
      //   ① 当前被咨询（tech_lead_id=我）② 历史回过意见（timeline 有我提交的 tech_lead_comment）。
      //   不挂 SYS_TECH_LEAD_IDS 白名单——两个条件本身即参与证据，挂白名单会让换人后前任够不到自己写的记录。
      const isTechLeadOfIssue = uid > 0 && (
        Number(row.tech_lead_id) === uid
        || !!(await dbGetAsync(
          `SELECT 1 FROM sys_issue_timeline WHERE issue_id = ? AND action_code = 'tech_lead_comment' AND operator_id = ? LIMIT 1`,
          [id, uid]
        ))
      );
      // C-orch 写读同源（历史批次·2026-07-07 旧机制）：issue 级 release_assignee_id 列在 v3.4 C5 断镜像后
      //   已是只读残留（新批次不再回写），仅历史 bug 单可能非空——保留原判据（含 type='bug' 精判）兼容历史数据。
      // ⭐ 执行人入口批（2026-07-31 用户拍板）：补**批次级**执行人判断——新机制执行人身份只在
      //   sys_releases.release_assignee_id（批次表），且 C3 全类型统一后 feature/improvement 成员单的执行人
      //   同样需要打开单据（从批次详情成员列表进入/核对内容），不叠 type='bug'。release_brief 同查兼作
      //   详情响应字段（前端「前往上线单」按钮判权的数据源——此前后端不返批次级执行人字段，按钮只能
      //   "宁可少显示"锁 admin∨对接人，正是 07-30 记录的已知限制，本批一并解除）。
      let releaseBrief = null;
      if (row.release_id) {
        releaseBrief = await dbGetAsync(
          `SELECT id, release_no, status, release_kind, release_assignee_id, release_assignee_name
             FROM sys_releases WHERE id = ?`, [row.release_id]
        );
      }
      // C4a（方案 §4.4 改造 5b·新发现①）：第二处放行分支——原判据 `releaseBrief.release_assignee_id`
      //   单列比对（批次级旧列，C1 起停写，PUT executors 不再写它）只放行"代表执行人"这一个人，同批其余
      //   在册执行人（如非第一位被选的示例开发L）永远判不到自己是执行人，深链打不开详情。改子表 EXISTS——
      //   只要在本批次在册（removed_at IS NULL）即放行，覆盖全体多执行人，不再局限单一代表。
      //   （第一个条件——issue 级 `release_assignee_id`，2026-07-07 旧上线编排机制——维持不变：4 端点已于
      //   2026-07-30 全封，纯历史只读残留，仅历史 bug 单可能非空，不属本次改造对象。）
      const isReleaseExecutorInRoster = row.release_id ? !!(await dbGetAsync(
        `SELECT 1 FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1`,
        [row.release_id, uid]
      )) : false;
      const isReleaseExecutor = uid > 0 && (
        (Number(row.release_assignee_id) === uid && row.type === 'bug')
        || isReleaseExecutorInRoster
      );
      // [codex C3 对抗审 HIGH-B 回填] 在册/历史参与成员读可见性——与列表读端同源（同一 EXISTS 语义，SSOT 依据
      //   同上方列表端点注释：方案 v2.9 line 33"历史参与…只读整单"+ line 88"assigned_to 禁作授权源"）。
      //   ⚠️ S4 补强（codex 239 审 M-1）：本变量是**读可见性**判定（这个人能不能看这张单），既不判
      //   removed_at IS NULL 也不判 dev_status != 'excused'——不能拿它当"能否暂缓"的授权依据（那是下面
      //   can_bug_hold 的职责，两者刻意不同源，不要合并）。
      const isRosterMember = uid > 0 && !!(await dbGetAsync(
        `SELECT 1 FROM sys_issue_dev_assignees WHERE issue_id = ? AND user_id = ? LIMIT 1`, [id, uid]
      ));
      // S4 补强（codex 239 审 M-1，主会话核实成立）：can_bug_hold 能力位——与写路径真闸 assertBugHoldActor
      //   共用同一谓词 canBugHold，前端据此判断「暂缓」相关按钮显隐（取代此前误用 isRosterMember/
      //   siCaps.isRosterMember 顶替的做法——那是读可见性，不含 removed_at/dev_status 收紧，会让已移除/
      //   已 excuse 的历史成员在前端多看到按钮）。仅 bug 类型计算：变更流 hold 是纯 admin 权限，走既有
      //   admin 判断分支，不消费这个字段。挂在 row 上直接返回（issue 对象自带，前端无需额外合并一行）。
      row.can_bug_hold = row.type === 'bug' ? await canBugHold({ id: uid, role }, row) : false;
      // ⭐ C1：受理人加入放行集（全类型·与列表读端同源）
      // ⭐ [C10-fix5 MED-1] isBoundLiaison 加入放行集（与列表 intake_liaison_id 析取同源）。
      if (!isAdmin && !isIntakeLiaisonUser && !isAssignee && !isBugLiaison && !isReleaseExecutor && !isRosterMember && !isTechLeadOfIssue && !isBoundLiaison) {
        return res.status(403).json({ error: '无权查看此迭代单', code: 'NOT_AUTHORIZED_TO_VIEW' });
      }
      if (row.status === '已作废' && !isAdmin) {
        return res.status(403).json({ error: '该迭代单已作废', code: 'SYS_ISSUE_VOIDED' });
      }

      // timeline（演进时间线，§5.3）
      // ⭐ 角色权限重构 C4·184 号预审 PH-1（世界模型：意见唯一性绑咨询轮次）：投影补 `id`——
      //   前端 hasTechLeadComment 判定改轮内（`timeline行.id > iss.tech_lead_notify_request_event_id`），
      //   没有这一列前端拿不到可比较的 timeline 行序号（此前只投影业务字段，没人需要行号本身）。
      //   本次核实发现：详情端点此前从未把 timeline.id 投影出去（列举式 SELECT 的既有缺口），世界模型
      //   要求的轮内比较结构上做不到，故本次一并补上——纯新增列，不影响任何既有消费方（无消费方按
      //   固定 key 数量/顺序做过 deepStrictEqual，已 grep 全部 verify-sys-*.js 确认）。
      const timeline = await dbAllAsync(
        `SELECT id, event_type, from_status, to_status, summary, action_code, ref_id, round_no,
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
        // [v1.1 §3.3·C3] 同一查询顺带提取 self_tested/test_env_deployed（写读同源：写侧见上方 submit
        //   handler 的 eventPayload，本批次之后新写入的行恒为 true）——不复用 work_note 那条"note 非空
        //   才给 submitted_at"的耦合逻辑（两者是独立字段，self_tested/test_env_deployed 的有无只取决于
        //   "这个 dev 有没有提交过"，与有没有填 work_note 无关，不能借用同一个 note 变量做判断）。
        //   [codex 272 号 M-1] ⚠️ 不能想当然认为"读到非 null 就必然是 true"——这条只对本批次校验上线
        //   之后的新写入成立，历史脏数据（迁移遗留/手工改库/未来某次校验放宽期间侥幸落库的行）不受此
        //   约束，详情端是审计读取口，必须按下方 strictBoolFromJsonExtract 老实映射，不能替写侧背书。
        // [B4·C6] 同一查询顺带提取 bug_cause_note（写读同源：写侧见上方 submit handler 的 eventPayload）——
        //   与 work_note 同一存储范式（各 dev 各自最近一次 submit/no_code 事件独立承载），故复用本条查询、
        //   不另开一次查询。bug 单每轮必填故非 bug 单历史行、bug 单迁移前旧行读到 null 是预期形态。
        const workNoteRows = await dbAllAsync(
          `SELECT e.dev_assignee_id AS da_id,
                  json_extract(e.payload_json, '$.work_note') AS work_note,
                  json_extract(e.payload_json, '$.bug_cause_note') AS bug_cause_note,
                  json_extract(e.payload_json, '$.${SUBMIT_SELF_TESTED_KEY}') AS ${SUBMIT_SELF_TESTED_KEY},
                  json_extract(e.payload_json, '$.${SUBMIT_TEST_ENV_DEPLOYED_KEY}') AS ${SUBMIT_TEST_ENV_DEPLOYED_KEY},
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
        // [codex 272 号 M-1 收口] 严格布尔映射，不用 !! 强转——!! 会把任何"非空/非零"值都化妆成 true，
        //   包括脏历史 payload 里的字符串 'false'、非空数组 []、对象等（这些在 JS 里都是 truthy）。审计
        //   字段的语义是"读到了什么就是什么"，读不出明确布尔就该显式 null（不可读≠false，更不能被误判
        //   成已确认=true）。SQLite json_extract 对 JSON true/false 分别返回 INTEGER 1/0（无原生布尔类型），
        //   故只认严格 ===1/===0 两个值；除此之外的任何返回（NULL、其余数字、字符串、数组序列化文本等）
        //   一律映射 null——不可读，非"读到了 false"，更非"读到了 true"。
        function strictBoolFromJsonExtract(v) {
          if (v === 1) return true;
          if (v === 0) return false;
          return null;
        }
        const wnMap = new Map(workNoteRows.map(r => {
          const note = r.work_note || null;
          return [r.da_id, {
            work_note: note, submitted_at: note ? r.submitted_at : null,
            bug_cause_note: r.bug_cause_note || null,   // [B4·C6] 无值（非 bug 单/历史行）→ null，同 work_note 的 || null 归一写法
            [SUBMIT_SELF_TESTED_KEY]: strictBoolFromJsonExtract(r[SUBMIT_SELF_TESTED_KEY]),
            [SUBMIT_TEST_ENV_DEPLOYED_KEY]: strictBoolFromJsonExtract(r[SUBMIT_TEST_ENV_DEPLOYED_KEY]),
          }];
        }));
        for (const d of devAssignees) {
          const wn = wnMap.get(d.id);
          d.work_note = wn ? wn.work_note : null;
          d.work_note_submitted_at = wn ? wn.submitted_at : null;
          d.bug_cause_note = wn ? wn.bug_cause_note : null;   // [B4·C6]
          d[SUBMIT_SELF_TESTED_KEY] = wn ? wn[SUBMIT_SELF_TESTED_KEY] : null;
          d[SUBMIT_TEST_ENV_DEPLOYED_KEY] = wn ? wn[SUBMIT_TEST_ENV_DEPLOYED_KEY] : null;
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
      // S4 段1收口（codex 264 号末次合并审 M-2 采纳）：无代码交付历史凭证——此前 ncItems 只从
      //   fetchActiveDevAssignees（removed_at IS NULL 在册行）取数，返工场景下 remove+re-add 旧成员
      //   实例后，旧一轮的 no_code_reason 唯一交付凭证从详情里彻底消失，违背四件④"无代码交付=没有
      //   commit 可追溯，那段文字是唯一交付凭证"的拍板精神。口径对齐上面 devCommits 的先例（本文件
      //   :4300 附近注释："commit 是已发生的事实，与快照 §8『查全部现存行（含 removed 实例）』同口径"）：
      //   查该单**全部**历史实例（不限 removed_at），只要 dev_status='no_code' 且 no_code_reason
      //   非空白就算数——无代码说明同样是已发生的事实，不因成员被移出而消失。
      const noCodeRecords = await dbAllAsync(
        `SELECT id, user_id, user_name, no_code_reason, resolved_at, removed_at
           FROM sys_issue_dev_assignees
          WHERE issue_id = ? AND dev_status = 'no_code'
            AND no_code_reason IS NOT NULL AND trim(no_code_reason) <> ''
          ORDER BY id ASC`,
        [id]
      );
      // [B6·MED-1] bug_cause_records：详情端 bug_cause_note 历史轮次可见性对齐 noCodeRecords 先例——
      //   现挂在 devAssignees 行上的 bug_cause_note（上方 work_note 同款补查块）只反映**在册视角**（仅
      //   当前有效实例），而返工的标准重置路径 remove+re-add（B4b「完成态不回 pending」约束下唯一可行
      //   路径）会让首轮原因随旧实例被移出而从 UI 消失。codex 264 M-2 对 no_code_reason 判过同一件事，
      //   裁定=查全部历史实例，本次对齐该先例（主会话已裁定）。
      //   仅 type='bug' 查询——非 bug 恒 []：bug_cause_note 结构上只会出现在 bug 单的 submit/no_code 事件
      //   payload_json 里（B4 写入端已按 type 门控），显式按 type 判定比隐式依赖"其它类型数据天然为空"
      //   更清楚，也少一次无意义查询。
      //   数据源：与上方 workNoteRows 同款"MAX(id) per dev_assignee_id 取该实例最近一次提交事件"，但那
      //   条查询没有 JOIN dev_assignees（不需要 user_name/removed_at，只服务在册 devAssignees 合并），
      //   这里需要单独一条 JOIN 版本——JOIN 手法与 noCodeRecords 完全一致（拿 user_name/removed_at·不限
      //   removed_at）。按**事件 id** 升序（非 dev_assignee_id 升序）：事件 id 天然是提交发生的时间序，
      //   同一 dev 跨轮的两次提交必然对应两个不同的 dev_assignee_id（remove+re-add 产生新实例），事件 id
      //   顺序即轮次顺序。
      //   [codex 327 M-2 口径固化] MAX(id) per 实例的聚合**实际无损**：dev_status CAS 单向（pending→
      //   code_submitted/no_code 后不回 pending，重做恒走 remove+re-add=新实例），同一实例结构上至多产生
      //   一条 submit/no_code 事件，聚合只是防御性写法。若未来放开「同实例重复提交」，本查询须改为全事件
      //   列出（含 submitted_at 逐条展示），否则会静默丢弃早期原因。
      let bugCauseRecords = [];
      if (row.type === 'bug') {
        const bcRows = await dbAllAsync(
          `SELECT e.dev_assignee_id AS dev_assignee_id, da.user_id AS user_id, da.user_name AS user_name,
                  json_extract(e.payload_json, '$.bug_cause_note') AS bug_cause_note,
                  e.created_at AS submitted_at, da.removed_at AS removed_at
             FROM sys_issue_dev_events e
             JOIN sys_issue_dev_assignees da ON da.id = e.dev_assignee_id
             JOIN (
               SELECT dev_assignee_id, MAX(id) AS max_id
                 FROM sys_issue_dev_events
                WHERE issue_id = ? AND action IN ('submit','no_code')
                GROUP BY dev_assignee_id
             ) latest ON latest.dev_assignee_id = e.dev_assignee_id AND latest.max_id = e.id
            WHERE e.issue_id = ? AND json_extract(e.payload_json, '$.bug_cause_note') IS NOT NULL
            ORDER BY e.id ASC`,
          [id, id]
        );
        bugCauseRecords = bcRows.map(r => ({
          dev_assignee_id: r.dev_assignee_id, user_id: r.user_id, user_name: r.user_name,
          bug_cause_note: r.bug_cause_note, submitted_at: r.submitted_at, removed: !!r.removed_at,
        }));
      }
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
      // ⭐⭐ 附件面裁剪（技术负责人读权修复**自身引入的新暴露面**·必须与本次改动同批处置）：
      //   本次把详情可见性放开给「本单技术负责人」之前，示例发布者打不开变更流详情（403），自然也看不到附件；
      //   放开之后，他虽然仍**下载不了**（下载端点判据独立，未放开），却能在响应里读到附件**列表**
      //   （原始文件名等元数据）。方案 §3 角色表明写技术负责人「**不看附件**」「看材料/讨论走线下」，
      //   文件名本身即材料信息，故须裁剪。
      //   ⚠️ 判据与**附件下载端点逐字同源**（`sysAttachmentRosterState` 同一函数）——他下载不到的东西，
      //   就不该在详情里看到；两处用同一判据才不会再长出"列表能看见、下载 403"这类新的读端不一致。
      //   ⚠️ 不误伤：admin / 受理人（isSysCoordinator = admin ∨ 受理人）/ 在册成员 / 历史参与成员全部照旧；
      //   示例发布者若同时兼任本单开发（方案 §3 明确允许兼任），会命中 roster 分支，附件照常可见。
      //   187 号审 LOW（采纳）：先判角色再查库——admin/受理人（详情请求的大多数）本就有权，无条件先跑
      //   roster 查询等于给热路径白加一次 DB 往返和一个失败点；短路后语义不变（角色不满足才落到 roster）。
      const attActor = sysActor(req);
      const attIsCoordinator = attActor.role === 'admin' || isSysCoordinator(attActor, row.type);
      const attRoster = attIsCoordinator ? null : await sysAttachmentRosterState(id, attActor.id);
      const canSeeAttachmentList = attIsCoordinator || !!(attRoster && (attRoster.active || attRoster.historical));
      const outAttachments = canSeeAttachmentList ? attachments : [];
      const outSpecAttachments = canSeeAttachmentList ? specAttachments : [];
      // [执行人入口批·codex 审 MED-1 收口] release_brief 条件下发：单据可读集（建单人/在册成员/技术负责人等）
      //   比批次可读集宽——批次元数据（执行人 id/name/通知面）只发给与 GET /sys-releases/:id 同一放行集
      //   （admin ∨ 对接人 ∨ 本批次执行人），其余读者拿 null。前端 siCanOpenRelease 以"brief 非空"为唯一
      //   判据（数据即权限，前端不复算三分支），写读同源单点在此。
      const canSeeReleaseBrief = isAdmin || isIntakeLiaisonUser || isReleaseExecutor;
      res.json({ issue: row, timeline, attachments: outAttachments, specAttachments: outSpecAttachments, hasSpecAttachment: outSpecAttachments.length > 0, origin_issue: originIssue, derived_issues: derivedIssues, related_correction: relatedCorrection, dev_assignees: devAssignees, dev_commits: devCommits, no_code_records: noCodeRecords, bug_cause_records: bugCauseRecords, release_brief: canSeeReleaseBrief ? releaseBrief : null });
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
        // C2b（codex 审 MED）：actor 取一次复用 —— 流转的操作者与通知的 sent_by 必须**同源**，
        //   双取虽当前等价，但一旦 sysActor 引入派生字段/请求态就会分叉，而这是审计字段。
        const actor = sysActor(req);
        const r = await sysIssueTransition(id, action, null, actor, req.body || {});
        // notifyAfterCommit：return→notifyReturnedToDeveloper（发 dev）/ reopen→notifyAssignedDeveloper（发 dev）/
        //   submit→notifySubmittedToAdmin（dispatch 内早返回不发）/ 其余 null（dispatch 早返回）。best-effort。
        await dispatchSysNotify(id, r.notifyAfterCommit, actor.id);
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

  // [codex 272 号 L-3] 提交双勾两键名集中定义——写侧本 handler 的 eventPayload 构造 + 读侧上方 GET
  // 详情端点 workNoteRows 的 json_extract 路径/结果字段名，三处共用同一常量（非各自重复写字面量
  // 'self_tested'/'test_env_deployed'），防止未来改名/重构时只改一端、写读悄悄漂移出同源。两处
  // handler 同处 module.exports 工厂函数体（本文件 39 行起）的同一层闭包作用域，声明顺序不影响
  // 引用——请求处理时工厂函数早已整体执行完毕，所有顶层 const 均已就绪。
  const SUBMIT_SELF_TESTED_KEY = 'self_tested';
  const SUBMIT_TEST_ENV_DEPLOYED_KEY = 'test_env_deployed';

  const COMMIT_COMPONENTS = ['frontend', 'backend'];   // 与 sys_issue_dev_commits.component 的 DDL CHECK 同源（附录C）

  // ============================================================
  // §10.3（C11）HRD 类系统：commit 提交不分前后端（单组「版本号」）
  //   拍板口径（方案 v1.7 §10.3）：所属系统命中「不分前后端系统清单」的单，commit 提交界面不再分
  //   前端组/后端组，只填一类「版本号」多行；**落库复用 component='backend'**（零 schema 变更，规避
  //   sys_issue_dev_commits.component DDL CHECK 只许 frontend/backend 的硬约束，不开「新枚举=新旧库两套
  //   语义」的坑）。判定源单一、后端唯一权威（M6），前端只按 DTO 渲染不自行判定。
  // ============================================================
  const SINGLE_COMMIT_GROUP_LABEL = '版本号';                          // 命中系统统一组标签（DTO group_label）
  const SINGLE_COMMIT_GROUP_CONFIG_KEY = 'sys_single_commit_group_systems';   // 照搬 sys_release_default_executor_ids 配置范式
  // 初始值=HRD（方案 §10.3）。config 未写/为空时的**代码兜底默认**——保证「初始值 HRD」无需部署日手工写库即
  //   生效（readSystemConfig 无法从本模块 seed·无 writeSystemConfig 注入，且部署日手工写库有遗漏风险）。
  //   config 一旦写入即以 config 为准（replace 语义·admin 若要保留 HRD 须在 config 里显式含 HRD）——
  //   清单是「配置化」的，默认只兜「从未配置过」这一档。
  const DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS = ['HRD'];

  // 读配置一次 → 命中系统 Set（批量场景复用·避免逐行 readSystemConfig 的 N 次 DB 往返）。格式照搬
  //   sys_release_default_executor_ids：**逗号串或 JSON 数组**皆可。畸形/空 → 回落 DEFAULT（不猜、不静默塌成空集）。
  async function loadSingleCommitGroupSystemSet() {
    let raw = null;
    try { raw = await readSystemConfig(SINGLE_COMMIT_GROUP_CONFIG_KEY); }
    catch (e) { logger.warn(`[系统迭代·10.3] 读 ${SINGLE_COMMIT_GROUP_CONFIG_KEY} 失败，回落默认清单：${e && e.message}`); raw = null; }
    const trimmed = String(raw || '').trim();
    if (!trimmed) return new Set(DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS);   // 从未配置/空 → 默认 HRD
    let list;
    // ⚠️ [C11-fix2·codex 320 MED 收口·**判据从「前缀猜测」改为「JSON.parse 成败」**] 前缀判据（`[`/`{`）根本堵
    //   不干净：JSON 标量 `123`/`true`/`null`/`"HRD"`（带引号）不以 `[`/`{` 开头 → 掉进 split(',') 被硬拆成
    //   `['123']`/`['"HRD"']` 垃圾集；JSON 数组含非字符串元素 `[123]`/`[{}]` → String 强转成 `'123'`/`'[object Object]'`
    //   同样成非空垃圾集——两类都不回落默认、静默移除 HRD。C11-fix 只补 `{` 前缀是治标（codex 320 MED 打回）。
    //   彻底修=**先无条件 JSON.parse 试**：成功且是「全部非空字符串的数组」才接受；其余 JSON 形态（标量/对象/
    //   含非字符串元素的数组）一律 list=[] 回落默认。解析失败（真逗号串 `HRD,OA` 不是合法 JSON）才按逗号拆。
    let parsed; let parseOk = false;
    try { parsed = JSON.parse(trimmed); parseOk = true; } catch (_) { parseOk = false; }
    if (parseOk) {
      // 合法 JSON：仅接受全非空字符串数组（配置本义=系统名清单）；标量/对象/含非字符串元素 → 回落默认。
      list = (Array.isArray(parsed) && parsed.every(x => typeof x === 'string' && x.trim())) ? parsed : [];
    } else if (trimmed[0] === '[' || trimmed[0] === '{') {
      // 非合法 JSON 但以 `[`/`{` 开头 = **畸形 JSON 意图**（`[not-json` / `{bad`）→ 回落默认，**不**当逗号串
      //   硬拆（否则 `['[not-json']` 垃圾集）。此分支是 JSON.parse 成败判据的必要兜底：parse 失败不等于
      //   「就是逗号串」，用户明显想写 JSON 只是写错了。（C11-fix2 首版漏此兜底致 [not-json 假红，本行补回。）
      list = [];
    } else {
      // 真逗号串（HRD,OA / 单个 HRD）——非 JSON、非 [/{ 开头，合法配置格式。
      // ⚠️ [C11-fix2·codex 320-R LOW 边界·不宣称覆盖所有畸形] 未闭合 JSON 字符串（`"HRD`）/裸畸形标量
      //   （`1e`/`tru`）也 parse 失败且非 [/{ 开头 → 落此 split → 垃圾系统名（不含 HRD → HRD 失效）。
      //   这类属 admin 手写严重畸形·**可达性极低**（helper 恒逗号串）·且失败方向=配置不生效（admin 可见）
      //   非安全问题·**登记接受**不再收紧逗号串系统名语法。本判据保证的是「原报告所列 JSON 标量/对象/含非
      //   字符串元素/[/{ 开头畸形 一律回落默认」，非「识别一切畸形字符串」。
      list = trimmed.split(',');
    }
    const set = new Set(list.map(s => String(s).trim()).filter(Boolean));
    // 空集（显式 `[]`/全空白项/JSON 对象归一后）同样回落 DEFAULT——[C11-fix LOW-2 登记] 故当前**无经 config
    //   整体停用本功能的途径**（清单恒至少含默认 HRD·fail-safe）；若将来需「配置停用」须另加显式停用语义或改代码默认。
    return set.size ? set : new Set(DEFAULT_SINGLE_COMMIT_GROUP_SYSTEMS);
  }

  // §10.3 M5 单一判定源：某系统是否「不分前后端·单组版本号」。统计/展示/导出/通知读 component 前先过它。
  //   单据级端点（submit/POST/PUT commits/详情）用本函数（各读一次配置）；列表这类批量端点改用
  //   loadSingleCommitGroupSystemSet 一次读配置 + 逐行 Set.has，判据同源不漂移。
  async function isSingleCommitGroupSystem(systemName) {
    if (!systemName) return false;
    const set = await loadSingleCommitGroupSystemSet();
    return set.has(String(systemName).trim());
  }

  // §10.3 M6 DTO 契约派生（后端唯一权威·前端只渲染不判定）：给定「命中系统 Set」+ systemName →
  //   single_commit_group / group_label / allowed_components 三字段。命中系统 allowed_components 只含 backend
  //   （前端据此渲染单组·提交只发 backend），非命中系统给全集（frontend/backend 两组照旧）。
  function deriveSingleCommitGroupDTO(systemsSet, systemName) {
    const single = !!(systemsSet && systemName && systemsSet.has(String(systemName).trim()));
    return {
      single_commit_group: single,
      group_label: single ? SINGLE_COMMIT_GROUP_LABEL : null,
      allowed_components: single ? ['backend'] : COMMIT_COMPONENTS.slice(),
    };
  }

  // §6.1 body 结构校验（写库前拒绝，纯函数不接 db）：mode='no_code'|'commits' 互斥，多余字段/null→VALIDATION。
  //   返回 { ok:true, mode, noCodeReason, commits:[{component,commit_ref}] } 或 { ok:false, message }。
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.3·C3] 提交双勾恒等 true 校验——三类型通用（feature/
  //   improvement/bug 均适用，不像 §3.2 工期仅 feature，§1 拍板"必勾才能提交"无 type 限定）。
  //   缺失/显式 false 视为"未勾选"（_REQUIRED，同 EFFORT_REQUIRED 语义——"你还没做这件事"）；非
  //   undefined/null/false/true 的其余类型或值视为"畸形输入"（_INVALID，同 EFFORT_INVALID 语义——
  //   "你传了什么东西但不是我们要的布尔值"）。错误码语义化对齐 §3.2 EFFORT_REQUIRED/EFFORT_INVALID 先例。
  function assertSubmitChecklistFlag(raw, label, requiredCode, invalidCode) {
    if (raw === undefined || raw === null || raw === false) {
      return { ok: false, message: `请先勾选"${label}"再提交`, code: requiredCode };
    }
    if (raw !== true) {
      return { ok: false, message: `${label}对应字段须为布尔值 true`, code: invalidCode };
    }
    return { ok: true };
  }
  function validateSubmitBody(body) {
    const b = body || {};
    // [codex 100 号 HIGH-2 回填] fix_gap_note 纳入 §6.1 body 契约的"条件字段"——是否必填取决于事务内 row 状态
    //   （派生自 bug 的 bug 单首次提交），此处只做类型层放行（同旧代码 non-string→视为未填，不在此报错），
    //   必填判定与真正校验在事务内进行（见 submit handler 内 [codex 100 号 HIGH-2 回填] 注释）。
    // [v1.1 §3.3·C3] +self_tested/test_env_deployed（提交双勾，恒等 true 校验）。
    const ALLOWED_TOP_KEYS = ['mode', 'no_code_reason', 'commits', 'fix_gap_note', 'work_note', 'bug_cause_note', SUBMIT_SELF_TESTED_KEY, SUBMIT_TEST_ENV_DEPLOYED_KEY];   // P4：+work_note（选填工作说明）；C6：+bug_cause_note（bug 单必填「产生原因」，形状校验型无关，适用面/必填闸见 handler）
    const extraTop = Object.keys(b).filter(k => !ALLOWED_TOP_KEYS.includes(k));
    if (extraTop.length > 0) return { ok: false, message: `不支持的字段：${extraTop.join(',')}` };
    // [codex 272 号 L-1 锁定] mode-first 既有顺序保持不变——结构校验（mode 是否合法）先于字段校验
    // （双勾是否勾选），故 {} 空 body 或非法 mode 命中的是 VALIDATION（下一行），不会是
    // SELF_TESTED_REQUIRED（即便这类请求也同样缺失双勾字段）。这是本文件既有契约（同 no_code_reason/
    // commits 等字段校验一贯排在 mode 校验之后的次序惯例），非本次新引入，verify 用一条测试锁定。
    if (b.mode !== 'no_code' && b.mode !== 'commits') return { ok: false, message: 'mode 仅支持 no_code/commits' };
    // [v1.1 §3.3·C3] 双勾校验放在 mode 校验之后、其余字段之前——与 mode/commits/no_code_reason 无关，
    // 两个独立字段各自判定，任一未过即整请求拒绝（写库前拒绝，不进入事务）。self_tested 先判、
    // test_env_deployed 后判——顺序无业务含义，纯粹按 payload 里两个键的自然顺序排。
    const selfTestedCheck = assertSubmitChecklistFlag(b[SUBMIT_SELF_TESTED_KEY], '已完成自测', 'SELF_TESTED_REQUIRED', 'SELF_TESTED_INVALID');
    if (!selfTestedCheck.ok) return selfTestedCheck;
    const testEnvCheck = assertSubmitChecklistFlag(b[SUBMIT_TEST_ENV_DEPLOYED_KEY], '已上测试库', 'TEST_ENV_DEPLOYED_REQUIRED', 'TEST_ENV_DEPLOYED_INVALID');
    if (!testEnvCheck.ok) return testEnvCheck;
    const fixGapNote = typeof b.fix_gap_note === 'string' ? b.fix_gap_note : null;
    // P4 work_note（选填·两模式均可带）：非 string 且非 undefined/null → 400（不静默吞·方案 §4.3 H-MED）；
    //   trim 上限 1000 字符（Unicode 码点 [...str].length 计·防中文/emoji 组合字符按字节误判）；空白落 null（统一）。
    if (b.work_note !== undefined && b.work_note !== null && typeof b.work_note !== 'string') {
      return { ok: false, message: 'work_note 须为字符串' };
    }
    const workNoteRaw = typeof b.work_note === 'string' ? b.work_note.trim() : '';
    if ([...workNoteRaw].length > 1000) return { ok: false, message: 'work_note 过长（上限 1000 字）' };
    const workNote = workNoteRaw || null;

    // [B4·C6] bug_cause_note 形状校验（类型无关，同 work_note 写法）：非 string 且非 undefined/null → 400；
    //   trim 后 Unicode 码点数上限 500（对齐用户拍板口径）。是否必填/是否适用（仅 type='bug'）依赖 row.type，
    //   validateSubmitBody 是纯函数拿不到 row，必填/适用面闸门下沉到 handler（见该处 BUG_CAUSE_REQUIRED/
    //   BUG_CAUSE_NOT_APPLICABLE）——本函数只保证"传了就必须是合法字符串"这一层，与业务语义无关。
    if (b.bug_cause_note !== undefined && b.bug_cause_note !== null && typeof b.bug_cause_note !== 'string') {
      return { ok: false, message: 'bug_cause_note 须为字符串' };
    }
    const bugCauseNoteRaw = typeof b.bug_cause_note === 'string' ? b.bug_cause_note.trim() : '';
    if ([...bugCauseNoteRaw].length > 500) return { ok: false, message: 'bug_cause_note 过长（上限 500 字）' };
    const bugCauseNote = bugCauseNoteRaw || null;

    if (b.mode === 'no_code') {
      if (b.no_code_reason === null) return { ok: false, message: 'no_code_reason 不能为 null' };
      const reason = (typeof b.no_code_reason === 'string' ? b.no_code_reason.trim() : '');
      if (!reason || reason.length > 500) return { ok: false, message: 'no_code_reason 必填（trim 长度 1..500）' };
      if (b.commits !== undefined && b.commits !== null) {
        if (!Array.isArray(b.commits)) return { ok: false, message: 'commits 须为数组' };
        if (b.commits.length > 0) return { ok: false, message: 'no_code 模式不应携带非空 commits' };
      }
      // [codex 272 号 L-3·273 号 M 修正] 把双勾的**请求体原始值**随 parsed 带出（camelCase，同 noCodeReason
      // 风格）——不硬编码 true：写前不变量断言的是"请求里真的传了 true"这个现实，硬编码会让断言恒真、
      // 未来校验被误放宽时照样把假 true 写进审计（273 号抓的恒真断言变体）。
      return { ok: true, mode: 'no_code', noCodeReason: reason, commits: [], fixGapNote, workNote, bugCauseNote, selfTested: b[SUBMIT_SELF_TESTED_KEY], testEnvDeployed: b[SUBMIT_TEST_ENV_DEPLOYED_KEY] };
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
    return { ok: true, mode: 'commits', noCodeReason: null, commits, fixGapNote, workNote, bugCauseNote, selfTested: b[SUBMIT_SELF_TESTED_KEY], testEnvDeployed: b[SUBMIT_TEST_ENV_DEPLOYED_KEY] };   // 273 号 M：带原始值非硬编码（同上方 no_code 分支注释）
  }

  router.post('/sys-issues/:id/submit', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const parsed = validateSubmitBody(req.body);
    // [v1.1 §3.3·C3] validateSubmitBody 现会为提交双勾返回语义化 code（SELF_TESTED_REQUIRED 等）——
    // 优先用它，其余既有校验分支未带 code（一直是裸 message）时兜底回落通用 VALIDATION，不破坏既有行为。
    if (!parsed.ok) return res.status(400).json({ error: parsed.message, code: parsed.code || 'VALIDATION' });

    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      let memberRow, targetDevStatus, gateResult, rowStatusAtStart, devAssignees;
      try {
        // §6.2 步骤1：assertKnownIssueStatus → 解析在册实例（0 行→403 NOT_ROSTERED）
        const row = await dbGetAsync(
          `SELECT id, type, status, blocked, needs_feasibility, feasibility_conclusion,
                  feasibility_requirement_confirm, feasibility_risk, dev_estimated_at, estimated_effort_days,
                  first_submitted_at, origin_issue_id, system_name
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

        // [B4·C6] bug 单必填「产生原因」（用户拍板三条口径：逐人填/每轮必填/no_code 与 commits 两 mode
        //   同样要求，不做首轮豁免）——仅 type='bug' 适用，其余类型误传即拒（错误码命名与判据结构对齐 C7
        //   的 EFFORT_NOT_APPLICABLE 范式：适用类型缺值 → REQUIRED；不适用类型带值 → NOT_APPLICABLE）。
        //   位置刻意放在 ESTIMATE_REQUIRED 之后、fix_gap_note 首提闸门之前：本闸判据只需 row.type 与
        //   parsed.bugCauseNote（均已就绪，零额外查询/写入），是本区段里最"轻"的一道；而紧随其后的
        //   fix_gap_note 分支要多查一次 origin 单且可能落两个 UPDATE（first_submitted_at/fix_gap_note）
        //   ——把不依赖任何额外副作用的判定尽量前置，同 ESTIMATE_REQUIRED 紧邻本身也是这个道理（虽然本
        //   区段全部分支失败都走 sysRollback 回滚，事务原子性下顺序不影响数据正确性，这里纯粹是"轻判定
        //   靠前、有副作用的判定靠后"的既有排序惯例，不是安全边界）。
        //   ⚠️ 与 C7"不适用优先于格式"先例的对齐说明（如实记录查证结果，非照搬）：C7 的格式校验
        //   （INVALID_EFFORT_DAYS）与适用面校验（EFFORT_NOT_APPLICABLE）同处一层——都在事务内、row 已知
        //   之后——故存在真实的先后取舍，C7 选择"先适用面后格式"。bug_cause_note 的**形状**校验（是否为
        //   string、trim 后 ≤500 字）已按方案要求上移到 validateSubmitBody（路由层，早于本行、早于 row
        //   加载），与"适用面"根本不在同一层——形状必然先于适用面判定（架构决定，非本处可取舍的先后关系）。
        //   能对齐 C7 精神的只有"适用面判定本身在同层里尽量靠前"这一点，已体现在上面的插入位置里。
        if (row.type === 'bug') {
          if (!parsed.bugCauseNote) {
            await sysRollback();
            return res.status(400).json({ error: '请填写 bug 产生原因', code: 'BUG_CAUSE_REQUIRED' });
          }
        } else if (parsed.bugCauseNote) {
          await sysRollback();
          return res.status(400).json({ error: '该类型单据无「bug 产生原因」字段', code: 'BUG_CAUSE_NOT_APPLICABLE' });
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
          // [C7 工时评估补全·方案 v1.7 §9.1] 工期硬闸：从 `nf=1 ∧ feature` 扩到"feature/improvement 两类型
          // × nf 两值"，与 isGateEligibleForVerify 逐条同构（同一套 issue 级不变量，非独立设计）。本检查
          // **移出 nf=1 分支**、置于其后同一层——对 nf=1 保持原有先后次序（评估五闸全过后才查工期，precedence
          // 不变），对 nf=0 则是本次新增的唯一一道工期闸。
          // [codex 269 号 M-1 存储值复查·保留]：同 isGateEligibleForVerify 理由（ALTER 旧库路径无 DDL CHECK，
          // 脏值可合法落库）——复用 normalizeSysEffortDays 重新验存量值，区分两种错误语义：真缺失（从未填过）
          // 报 EFFORT_REQUIRED 引导去填；非空但归一失败（历史脏值/数据异常）报独立码 EFFORT_INVALID 引导去改。
          // ⚠️ 文案必须**指路到对应补填入口**——这不是措辞讲究，是本次扩围的唯一出路：本地存量已量化 5 单
          //   在途会被新闸拦下（4 个 nf=0 feature + 1 个 nf=0 improvement），它们的开发看到报错后能不能自己
          //   走通，全靠这句话说没说清去哪儿填。nf=1 的工期入口在可行性评估弹窗，nf=0 的在估时弹窗（C7 新
          //   开的写点），两条路径入口不同，故文案按 needs_feasibility 分岔，不共用一句泛泛的"请填写工期"。
          const effortEntry = row.needs_feasibility === 1 ? '可行性评估' : '估时';
          const effortCheck = normalizeSysEffortDays(row.estimated_effort_days);
          if (!effortCheck.ok) {
            await sysRollback();
            return res.status(400).json({ error: `工期数据异常（${effortCheck.error}），请重新在${effortEntry}中填写`, code: 'EFFORT_INVALID' });
          }
          if (effortCheck.value === null) {
            await sysRollback();
            return res.status(400).json({ error: `请先在${effortEntry}中填写工期（人日）`, code: 'EFFORT_REQUIRED' });
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
        //   §10.3（C11）命中「不分前后端系统」的单：**服务端强制归一 component=backend**（无视客户端传值）——
        //   前端虽已按 DTO allowed_components=['backend'] 只发 backend，此处仍以后端判据兜底（判定不散落·
        //   前后端零漂移）。归一后的 comp 同时用于自然键查重（两条 frontend+backend 同 ref 归一后同为 backend
        //   → 查重命中 400，语义正确）+ INSERT + 响应，三处一致。SVN 校验口径=既有 commit_ref trim 1..200
        //   （backend 组本就是 SVN·零新增校验逻辑，方案 §10.3 校验口径）。
        const forceSingleCommitBackend = await isSingleCommitGroupSystem(row.system_name);
        const insertedCommits = [];
        if (parsed.mode === 'commits') {
          for (const c of parsed.commits) {
            const comp = forceSingleCommitBackend ? 'backend' : c.component;
            const dup = await dbGetAsync(
              `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ?`,
              [memberRow.id, comp, c.commit_ref]
            );
            if (dup) throw new SysTransitionError(400, 'VALIDATION', `commit 已存在（自然键重复）：${comp}`);
            const insRes = await dbRunAsync(
              `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
              [id, memberRow.id, actor.id, comp, c.commit_ref]
            );
            insertedCommits.push({ commit_id: insRes.lastID, component: comp, commit_ref: c.commit_ref });
          }
        }

        // §6.2 步骤5：写恰 1 条 submit|no_code 事件（payload 含全部初始 commit 明细，方案 §3 模型）
        //   → electRepresentative → 门禁：全完成态→主状态待验证（W-GATE 内，同事务，不变量 8）
        // P4：work_note（选填工作说明）落进本条 submit/no_code 事件的 payload_json——每个 dev 各自的 submit 事件行
        //   独立承载，多开发各自 work_note 不覆盖（方案 §4.3 H1：不落主表/不落可变 dev_assignees 行）。仅有值时加键。
        // [B4·C6] bug_cause_note 同样落本条事件 payload_json（逐人填口径①：每个 dev 各自 submit/no_code 事件
        //   独立承载，不覆盖、不落主表/dev_assignees 行——与 work_note 同一存储范式）。"仅有值时加键"写法
        //   与 work_note 对齐；上方闸门已保证 bug 单必有值、非 bug 单恒无值，故 bug 单此键恒在、非 bug 单恒无。
        // [v1.1 §3.3·C3] self_tested/test_env_deployed 恒为 true 才能走到这里（validateSubmitBody 已挡），
        //   两键无条件写入（不像 work_note 那样"仅有值时加键"——这两个键在通过校验的每一条 submit/no_code
        //   事件里恒定存在且恒为 true，是"事件 JSON 键名 schema 冻结"的一部分，供 verify 稳定读取断言）。
        // [codex 272 号 L-3 写前不变量] 不直接信任"能走到这里就必然过了校验"这个隐含假设——显式断言
        // parsed.selfTested/testEnvDeployed 确为 true 才落笔硬编码 true。这条断言此刻看起来是废话（本
        // 函数 validateSubmitBody 确实保证了这一点），但它的价值在未来：如果哪次重构不小心放宽了
        // assertSubmitChecklistFlag（比如误改成允许 undefined 透传/漏掉某个分支的 return），下面这行
        // 硬编码 true 会在不知情的情况下悄悄写入一条"看起来双勾已确认但实际从未真正校验过"的假记录——
        // 这类审计假阳性一旦落库就很难事后甄别。加上这条断言后，同样的疏漏会在写入前就直接 throw 炸穿，
        // 而不是留下一条无法追溯的脏数据。
        if (parsed.selfTested !== true || parsed.testEnvDeployed !== true) {
          throw new Error(`[写前不变量违反] submit 双勾应恒为 true 才能到达 eventPayload 构造，实得 selfTested=${parsed.selfTested} testEnvDeployed=${parsed.testEnvDeployed}（validateSubmitBody 校验被绕过或被弱化，需立即排查，非静默写假 true）`);
        }
        const eventPayload = parsed.mode === 'no_code'
          ? { mode: 'no_code', no_code_reason: parsed.noCodeReason, [SUBMIT_SELF_TESTED_KEY]: true, [SUBMIT_TEST_ENV_DEPLOYED_KEY]: true, ...(parsed.workNote ? { work_note: parsed.workNote } : {}), ...(parsed.bugCauseNote ? { bug_cause_note: parsed.bugCauseNote } : {}) }
          : { mode: 'commits', commits: insertedCommits, dev_assignee_id: memberRow.id, [SUBMIT_SELF_TESTED_KEY]: true, [SUBMIT_TEST_ENV_DEPLOYED_KEY]: true, ...(parsed.workNote ? { work_note: parsed.workNote } : {}), ...(parsed.bugCauseNote ? { bug_cause_note: parsed.bugCauseNote } : {}) };
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
        const row = await dbGetAsync('SELECT id, type, status, system_name FROM sys_issues WHERE id = ?', [id]);
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

        // §10.3（C11）命中「不分前后端系统」→ 服务端强制归一 component=backend（无视客户端传值，与 submit 同判据）。
        const comp = (await isSingleCommitGroupSystem(row.system_name)) ? 'backend' : parsed.component;
        // 字段校验后置查重：同 dev_assignee_id+component+trim(ref) 已存在→400（§6.3 步骤2）
        const dup = await dbGetAsync(
          `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ?`,
          [activeRow.id, comp, parsed.commit_ref]
        );
        if (dup) { await sysRollback(); return res.status(400).json({ error: `commit 已存在（自然键重复）：${comp}`, code: 'VALIDATION' }); }

        const insRes = await dbRunAsync(
          `INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`,
          [id, activeRow.id, actor.id, comp, parsed.commit_ref]
        );
        insertedCommit = {
          id: insRes.lastID, issue_id: id, dev_assignee_id: activeRow.id, dev_user_id: actor.id,
          component: comp, commit_ref: parsed.commit_ref,
        };

        // 守卫全套通过 + 行已写 → INSERT event（add-commit，载荷按 §3：{commit_id,component,commit_ref,dev_assignee_id}）
        await insertDevEvent({
          issueId: id, devAssigneeId: activeRow.id, action: 'add-commit', operatorId: actor.id,
          payload: { commit_id: insertedCommit.id, component: comp, commit_ref: parsed.commit_ref, dev_assignee_id: activeRow.id },
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
        const row = await dbGetAsync('SELECT id, type, status, system_name FROM sys_issues WHERE id = ?', [id]);
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

        // §10.3（C11）命中「不分前后端系统」→ 服务端强制归一 component=backend（无视客户端传值，与 submit/POST 同判据）。
        //   ⚠️ 含存量 frontend 行的显式编辑：命中系统下把它归一为 backend 属**合法用户动作**（把历史行改成正规
        //   单组行），与「不迁移数据」（=不做批量迁移）不冲突；归一后可能与既有 backend 同 ref 撞自然键 → 查重 400（正确）。
        const comp = (await isSingleCommitGroupSystem(row.system_name)) ? 'backend' : parsed.component;

        // 无变化 PUT（规范化后与自身相同）→400 VALIDATION，不写 updated_at/event（§6.3 步骤2）
        if (target.component === comp && target.commit_ref === parsed.commit_ref) {
          await sysRollback();
          return res.status(400).json({ error: '与当前值相同，无实际变化', code: 'VALIDATION' });
        }

        // 查重：同 dev_assignee_id+component+trim(ref) 已存在→400（排除当前 commit_id）
        const dup = await dbGetAsync(
          `SELECT id FROM sys_issue_dev_commits WHERE dev_assignee_id = ? AND component = ? AND commit_ref = ? AND id != ?`,
          [target.dev_assignee_id, comp, parsed.commit_ref, commitId]
        );
        if (dup) { await sysRollback(); return res.status(400).json({ error: `commit 已存在（自然键重复）：${comp}`, code: 'VALIDATION' }); }

        await dbRunAsync(
          `UPDATE sys_issue_dev_commits SET component = ?, commit_ref = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
          [comp, parsed.commit_ref, commitId]
        );
        updatedCommit = {
          id: commitId, issue_id: id, dev_assignee_id: target.dev_assignee_id, dev_user_id: target.dev_user_id,
          component: comp, commit_ref: parsed.commit_ref,
        };

        // INSERT event（edit-commit，载荷按 §3：{commit_id,old:{component,commit_ref},new:{component,commit_ref}}）
        await insertDevEvent({
          issueId: id, devAssigneeId: target.dev_assignee_id, action: 'edit-commit', operatorId: actor.id,
          payload: {
            commit_id: commitId,
            old: { component: target.component, commit_ref: target.commit_ref },
            new: { component: comp, commit_ref: parsed.commit_ref },
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
  // ⭐ [C9·方案 v1.7 §10.1] accept 用**专用 handler**而非通用 makeTransitionEndpoint：需要在引擎的
  //   同一写事务内把目标态从「待上线」动态改判成「已上线」，并把删光留痕计数回传到响应体。
  //   其余 makeTransitionEndpoint 动作零影响（本改动只作用于 accept 这一条注册）。
  //   实现要点：
  //     ⭐⭐ [C9-fix2 H1·端点降级为纯调用方] 本端点**不再向引擎传任何 opts**——既没有 directOnlineInfo
  //       可变载体，也没有 resolveToStatusInTxn 钩子。理由见引擎 [1b]：让调用方递进"这条边够不够格进
  //       已上线"的判定结果，等于把守卫的判断权交出去（codex 316 H1）。现在准入判定由引擎在事务内自调
  //       evaluateNoCommitDirectOnline 完成，端点只负责发起动作 + 把引擎给的**只读裁决副本**拼进响应体。
  //     ⚠️ 钩子删掉后目标态走的是引擎的常量分支 `T.resolveToStatus(transition, fromStatus)`——与原钩子体内
  //       那两行（findTransition + resolveToStatus）**逐字等价**，原钩子存在的唯一理由就是"顺手把翻牌判定
  //       塞在同一个回调里"，翻牌收归引擎后它只剩重算一遍常量目标态，纯冗余，故整个删除而非留个空壳。
  //     ⚠️ 本端点仍保留专用 handler（不改回 makeTransitionEndpoint）：响应体要多带 online_source /
  //       deleted_commit_count 两个键，通用 handler 给不了。
  router.post('/sys-issues/:id/accept', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const actor = sysActor(req);
      const r = await sysIssueTransition(id, 'accept', null, actor, req.body || {});
      await dispatchSysNotify(id, r.notifyAfterCommit, actor.id);
      // 响应体带 deleted_commit_count（297-B L-a）：前端在验收结果提示里显示「该单曾发生过 N 次删除提交
      //   动作，本次按无 active commit 免上线」（N=0 不显示）——审计留痕之外让验收人当场可见。
      //   ⭐ [C9 对抗审 codex 317·M2] 键名 deleted_commit_count 是历史遗留（值是 delete-commit **动作次数**，
      //     非"唯一 commit 数"），本批只订正**面向人的文案**、不改键名（改键名要动前端读点 + 老响应体契约，
      //     超出本纯文案批）；含义以此处及 evaluateNoCommitDirectOnline :2388 的语义说明为准。
      //   非直翻路径不带这两个键，响应体与 C9 前逐字相同（老前端不受影响）。
      //   ⭐ [C9-fix2 H1] 数据源改为引擎返回的只读副本 r.noCommitOnline（Object.freeze，见引擎 return 处）。
      const verdict = r.noCommitOnline;
      res.json({
        id, status: r.toStatus, action: 'accept',
        ...(verdict && verdict.directFlip
          ? { online_source: ONLINE_SOURCE_NO_COMMIT, deleted_commit_count: verdict.deletedCommitCount }
          : {}),
      });
    } catch (err) { sendSysTransitionError(res, err); }
  });
  router.post('/sys-issues/:id/return', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('return'));
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.1 点5·C4 新增] 对接测试通过/打回——roleGuard='intake_liaison'
  //   （对接人池∨admin），中间件用 requireIntakeLiaison 粗筛（同 intake-accept 既有范式），引擎 [3] 再精判
  //   一次（写读同源，非重复劳动：中间件挡多数非法请求早退，引擎是不变量最后一道防线）。走通用
  //   makeTransitionEndpoint（同 accept/return 等具名边），不新起专用 handler。
  router.post('/sys-issues/:id/liaison-test-pass', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, makeTransitionEndpoint('liaison_test_pass'));
  router.post('/sys-issues/:id/liaison-test-return', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, makeTransitionEndpoint('liaison_test_return'));
  router.post('/sys-issues/:id/close', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('close'));
  // ⭐⭐ S2（bug暂缓方案 §5.2·实现错回填）：hold 中间件层 requireAdmin **已移除**——hold 曾经全类型 admin-only
  //   （变更流 roleGuard:'admin'），S2 后 bug 的授权语义变成「任一活跃在册成员 ∨ admin」（口径 #6），中间件
  //   在加载 issue 之前不知道 type，无法按 type 分支（同 issue-reject/void 那批"粗筛 + 引擎精判"范式，
  //   见下方 issue-reject 注释）——若继续挂 requireAdmin，bug 的在册开发会在**到达引擎之前**就被 403 拦下，
  //   assertBugHoldActor 形同虚设（本条是 S0/S1 遗留的真实实现缺口，S2 集成测试时发现并同批修复）。
  //   收窄改为**粗筛**：仅 authenticateToken + requireSysSchemaReady（同 estimate/blocked 等"引擎内精判"
  //   端点范式）——精确授权全交给引擎：变更流仍受 [3] 的 roleGuard:'admin' 拦（非 admin 403，零回归）；
  //   bug 受 [3.4] 的 assertBugHoldActor 拦（非 admin∧非在册 403，新语义生效）。
  router.post('/sys-issues/:id/hold', authenticateToken, requireSysSchemaReady, makeTransitionEndpoint('hold'));
  router.post('/sys-issues/:id/reactivate', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reactivate'));
  // ⭐⭐ R2（C2.5 撤销·方案 v2.1 §3·190 号消歧"替换非叠加"）：中间件 requireAdmin **替换为**
  //   requireIntakeLiaison（粗筛 admin∨受理人——受理人要进得来拒变更单，admin 要进得来拒 bug；
  //   中间件加载不了 issue 做不了 type 分支）。**引擎 roleGuard 才是最终授权边界**：
  //   变更流条目 'intake_liaison_only'（admin 403）/ bug 条目 'admin'（受理人 403）——两层都过才放行。
  router.post('/sys-issues/:id/issue-reject', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, makeTransitionEndpoint('issue_reject'));
  router.post('/sys-issues/:id/void', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('void'));
  router.post('/sys-issues/:id/reopen', authenticateToken, requireSysSchemaReady, requireAdmin, makeTransitionEndpoint('reopen'));

  // ── （C2.5 撤销·方案 v2.1）pre-discuss-pass 路由已删除（预沟通段废除·404）；OA 号改经下方
  //    set-oa-number 端点在受理后补填 ────────────────────────
  // ── ⭐⭐ R4 OA 号补填（方案 v2.1 §4·用户拍板"受理后 admin 补填·指派前必须有"）──────────
  //   权限=仅 admin——理由是**信息可达性**：只有 admin/建单人在 OA 系统内、知道流程号是多少（对接人与
  //   开发团队不在 OA 内、无从获知），所以只能由 admin 来填。⚠️ 这不是平台内保密要求——OA 号填进平台后
  //   就是全链路可见的过程参考号（详情/timeline 正常展示），191 号审曾据旧表述误判 timeline 泄露。
  //   **可填窗口=显式允许集（默认拒绝·189 号审）**：受理之后的全部非终态+已上线才可填/改——
  //   具体集合**以下方常量为准，注释不再重复枚举**（191 复审 L：注释枚举已漂移过一次）。
  //   bug 的 OA 可选（D2·填了同样校验格式）；指派后仍可改=纠错窗口（timeline 留痕可审计）。
  //   服务端比对制（[[feedback_server_side_diff_for_audit]]）：同值 no-op（200·不写 timeline 不留痕）。
  //   [S12 双路审查 codex 287 号 D 项收口] ⚠️ 上一句"受理之后的全部非终态"是概括性表述，非逐态字面
  //   相等——feature/improvement 下方数组刻意不含「待对接测试」，该测试段窗口内 set-oa-number 返回
  //   409 是 **C0 矩阵验证清单登记确认过的预期缺格**，非本次巡查漏改：OA 号在指派开发前置守卫
  //   （assertSysDevCommitmentOaGuard）已强制必填在先，进入测试段时不存在"还没号"的场景，且与
  //   C0 附注登记的另一同族设计取向一致（测试段内 notify-developer/creator/requester 三通道同样
  //   因状态白名单不含「待对接测试」而全哑 409，是同一批"测试段专属、非常态操作全部收紧"的取舍，
  //   不是逐处独立决定）。若未来发现测试段确有改号真实需求，需走方案新增，非本处直接放宽。
  const SYS_OA_ALLOWED_STATUSES = {
    // 191 号审 M（同型第三次·终版口径=受理后全部非终态+已上线·逐状态对照 ALLOWED_STATUSES 核出不手拼）：+待验证
    // ⚠️ 「待对接测试」不在集合内——见上方 [S12...D 项收口] 注释，刻意排除非遗漏。
    feature: ['待指派', '开发中', '待验证', '待上线', '已上线', '已暂缓'],
    improvement: ['待指派', '开发中', '待验证', '待上线', '已上线', '已暂缓'],
    // ⚠️ bug 集合仍无「已暂缓」——但理由已变（bug暂缓方案 20260803 v0.4 §4.4）：BUG_FLOW_STATUSES **现在
    //   确实有**「已暂缓」态（本方案新增，见 transitions.js bug 状态集注释），旧理由"暂缓有意省略"已失效。
    //   不纳入的真实理由=**bug 结构性不进 OA 守卫**：assertSysDevCommitmentOaGuard 首行 type guard 对
    //   bug 直接 return（bug 从不校验该守卫），暂缓期补号对 bug 没有实际用途。数组值本身不动——这是
    //   §4.4 的负向断言之一，若未来有人把「已暂缓」加进本集合，需先回看方案 §4.4 确认口径未变。
    bug: ['待处理', '处理中', '待验证', '待上线', '已上线'],
  };
  router.post('/sys-issues/:id/set-oa-number', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const actor = sysActor(req);
    try {
      let oa;
      try {
        oa = assertSysOaNumber((req.body || {}).oa_number);   // 复用引擎同一校验（1-20 位纯数字·拒 number 类型·写读同源）
      } catch (vErr) {
        if (vErr instanceof SysTransitionError) return res.status(vErr.httpStatus).json({ error: vErr.message, code: vErr.code });
        throw vErr;
      }
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, oa_number FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        const allowed = SYS_OA_ALLOWED_STATUSES[row.type];
        if (!Array.isArray(allowed) || !allowed.includes(row.status)) {
          await sysRollback();
          return res.status(409).json({ error: `当前状态「${row.status}」不可填写 OA 号（受理通过后方可补填）`, code: 'OA_NUMBER_STATUS_NOT_ALLOWED' });
        }
        if (String(row.oa_number || '') === oa) {   // 同值 no-op（服务端比对制·不产伪审计行）
          await sysRollback();
          return res.json({ id, oa_number: oa, changed: false });
        }
        const upd = await dbRunAsync(`UPDATE sys_issues SET oa_number = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?`, [oa, id, row.status]);
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '单据状态已变化，请刷新后重试', code: 'OA_NUMBER_STATE_CHANGED' }); }
        const prev = row.oa_number ? `（原 ${row.oa_number}）` : '';
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'set_oa_number', ?, ?)`,
          [id, `补填 OA 流程号：${oa}${prev}`, Number(actor.id) || null, actor.name || null]);
        await sysCommit();
        return res.json({ id, oa_number: oa, changed: true });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      logger.error('[系统迭代] 补填 OA 号失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '补填 OA 号失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

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
            await recordSysCreatorNotify(id, !!(result && result.ok), result && result.message_key, result && result.reason, actor.id);
          }
        }
      } catch (notifyErr) { logger.warn('[系统迭代] 退改通知建单人失败（不影响流转）:', notifyErr && notifyErr.message); }
      res.json({ id, status: r.toStatus, action: 'intake_return' });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── edit_in_revision：编辑窗口两档扩展（建单优化批 C3·方案 20260731_v1.2 §6）──────────────────────
  //   旁路动作（transitions.js to=null·不改 status·类比 estimate 独立事务）：两档白名单字段编辑。
  //   ⚠️ **不挂 requireIntakeLiaison**（授权=created_by∨admin·§5.3·受理人不获编辑他人单权）：只挂 auth+readiness·handler 内按事务内 row.created_by 精判。
  //   两档**按流分开**（§6.1·codex C3 审 0ed6fb8 M-1 收口——族外状态与档位判定不能共用一份全局并集常量，
  //   否则"待处理"这类 bug 专属态会被错误地当成变更流的合法 A 档，反之亦然）：
  //   变更流（feature/improvement）A 档=待受理/待修改/待指派（10 字段全量）、B 档=开发中（9 字段）；
  //   bug 流 A 档=待受理/待修改/待处理（10 字段全量）、B 档=处理中（9 字段，剔除 needs_feasibility——
  //   开发完成判定条件不得在开发期变更，B 档传该字段显式 400 明示原因）；待验证起（含所有后续态与终态）
  //   维持 409 冻结。族外/未知状态（如 config 或数据损坏产生的非法组合）由 assertKnownIssueStatus 先行
  //   fail-closed 拒绝（409 GATE_INVARIANT，同 assign 端点 :3033 用法，置于权限判定之前）。
  //   ⭐ 并发终闸（§6.2·[[feedback_state_machine_update_invariant]] 三件套直接应用）：状态读取/档位判断/
  //   请求字段校验/最终 UPDATE 全部在同一事务内完成，**不在事务外预计算可编辑字段集合**——未知字段 400 判定
  //   随之从"进事务前"挪到"读到真实 status、定完档位之后"（档位本身依赖事务内重读的 status 与 type）。
  //   最终 UPDATE 带 `WHERE id=? AND status IN (<该流该档白名单>)` 双条件守卫 + changes===0 → 409 回滚，
  //   防跨档漂移/TOCTOU。
  //   审计（§5.2 codex M 消歧）：event_type=note + action_code=edit_in_revision（priority 改动也走此码·不单列 priority_change）·改动字段名列入 summary（timeline 无 payload_json 列·不为审计明文差异做 schema 迁移·codex C4 LOW-6：不落前后值）；
  //   当前轮已有技术负责人评估意见时追加"（当前轮已有评估意见，评估在先）"标注（§6.4·审 215 M-6 轻量版）——
  //   判定口径同源 clearPendingConsultOnLeave（:2612）："当前轮是否有意见" = tech_lead_notify_request_event_id
  //   非空 且 存在 timeline.id > 该 event_id 的 action_code='tech_lead_comment' 行，不再各写一份防漂移。
  const EDIT_TIER_A_CHANGE = ['待受理', '待修改', '待指派'];   // 变更流 A 档（指派前）
  const EDIT_TIER_B_CHANGE = ['开发中'];                       // 变更流 B 档（开发期）
  const EDIT_TIER_A_BUG = ['待受理', '待修改', '待处理'];      // bug 流 A 档（指派前）
  const EDIT_TIER_B_BUG = ['处理中'];                          // bug 流 B 档（开发期）
  const EDIT_TIER_A_FIELDS = ['title', 'description', 'system_name', 'module_name', 'priority', 'deadline', 'needs_feasibility', 'requester_dept', 'requester_name', 'requester_phone'];
  const EDIT_TIER_B_FIELDS = EDIT_TIER_A_FIELDS.filter(f => f !== 'needs_feasibility');   // B 档剔除 needs_feasibility
  const EDIT_FIELD_LABELS = { title: '标题', description: '描述', system_name: '所属系统', module_name: '模块', priority: '优先级', deadline: '预期完成', needs_feasibility: '需可行性评估', requester_dept: '需求方部门', requester_name: '需求方姓名', requester_phone: '需求方电话' };
  router.post('/sys-issues/:id/edit-in-revision', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync(
          `SELECT id, type, status, created_by, title, description, system_name, module_name, priority, deadline,
                  needs_feasibility, requester_dept, requester_name, requester_phone, tech_lead_notify_request_event_id
             FROM sys_issues WHERE id = ?`, [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // 族外/未知状态 fail-closed（codex C3 审 M-1·同 assign 端点 :3033 用法，置于权限判定之前）：
        //   config 或数据损坏产生的"type/status 非法组合"在此先被拒绝，不会漏到下方按 type 选档的逻辑里
        //   被误判成某个流的合法态。
        assertKnownIssueStatus(row.type, row.status);
        // 权限：created_by∨admin（§5.3·事务内锁定后 row.created_by 校验·防 TOCTOU）
        const isAdmin = actor.role === 'admin';
        const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
        if (!(isAdmin || isCreator)) { await sysRollback(); return res.status(403).json({ error: '仅建单人或管理员可编辑', code: 'NOT_AUTHORIZED_FOR_EDIT' }); }
        // 两档判定（§6.1·M-1 按流分档）：以事务内刚读到的真实 status/type 为准，不在事务外预计算
        //   （§6.2 并发终闸前提）。assertKnownIssueStatus 已保证 row.type ∈ {feature,improvement,bug}。
        const isChangeFlowRow = (row.type === 'feature' || row.type === 'improvement');
        const rowTierAStatuses = isChangeFlowRow ? EDIT_TIER_A_CHANGE : EDIT_TIER_A_BUG;
        const rowTierBStatuses = isChangeFlowRow ? EDIT_TIER_B_CHANGE : EDIT_TIER_B_BUG;
        let tierFields, tierStatuses;
        if (rowTierAStatuses.includes(row.status)) { tierFields = EDIT_TIER_A_FIELDS; tierStatuses = rowTierAStatuses; }
        else if (rowTierBStatuses.includes(row.status)) { tierFields = EDIT_TIER_B_FIELDS; tierStatuses = rowTierBStatuses; }
        else {
          await sysRollback();
          const editableHint = isChangeFlowRow ? '待受理/待修改/待指派/开发中' : '待受理/待修改/待处理/处理中';
          return res.status(409).json({ error: `当前「${row.status}」态不可编辑内容（仅${editableHint}可编辑）`, code: 'EDIT_STATUS_INVALID' });
        }
        // 未知字段拒绝（防客户端写服务端字段·档位内白名单外一律拒·§6.1）——需在档位判定之后才能做，
        //   B 档缺 needs_feasibility，传该字段落入 extra。
        //   ⚠️ codex C3 审 L-1 收口：专属码 EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B **仅当 extra 恰好只含
        //   needs_feasibility 一项**时才返回——否则（needs_feasibility 与其他未知字段混传）会用"开发期不可
        //   变更评估"这句话掩盖掉同批混入的其他非法字段，误导调用方以为只有一个问题。混传时统一走通用码，
        //   文案列出全部 extra（含 needs_feasibility），不做特例吞并。
        const extra = Object.keys(b).filter(k => !tierFields.includes(k));
        if (extra.length) {
          await sysRollback();
          if (extra.length === 1 && extra[0] === 'needs_feasibility') {
            return res.status(400).json({ error: '开发中/处理中阶段不可修改"需可行性评估"（开发完成判定条件不得在开发期变更）', code: 'EDIT_NEEDS_FEASIBILITY_LOCKED_IN_TIER_B' });
          }
          return res.status(400).json({ error: `不支持编辑的字段：${extra.join(',')}`, code: 'EDIT_FIELD_NOT_ALLOWED' });
        }
        // 逐字段校验（复用建单口径）+ 计算改动集（幂等：值未变不列入）
        const setFrags = [], setParams = [], changed = [];
        for (const f of tierFields) {
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
            const dl = normalizeDeadlineDT(b.deadline);   // 四处优化 D2：同建单口径（到分钟）
            if (!dl.ok) { await sysRollback(); return res.status(400).json({ error: '期望完成格式非法（YYYY-MM-DD 或 YYYY-MM-DD HH:MM 的真实时间）', code: 'INVALID_DEADLINE' }); }
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
          else if (f === 'deadline') {
            // ⚠️ S3（D4）：val 现在**带秒**，而 row.deadline 可能是 S3 之前写入的无秒值或存量纯日期。
            //   逐字比会把**纯格式升级**（'14:30' → '14:30:00'）判成真变更 ⇒ 写库 + 留一条假的"已修改"记录。
            //   ⇒ 幂等比对归到分（入库仍用带秒的 val，见 setParams.push(val)）。
            //   前端有 dirty 门（没改就不传该字段）挡着，走不到这条；但 **API 直调传相同值就能走到** ——
            //   与 scope-change 那处是同一个模式，按模式一起修，不留同款（[[feedback_pattern_sweep_not_symptom_list]]）。
            normOld = deadlineToMinuteText(row[f]);
            normNew = deadlineToMinuteText(val);
          }
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
        // 旁路 UPDATE（不改 status）+ 双条件守卫绑该档 status 白名单（§6.2 并发终闸：防 TOCTOU/跨档漂移——
        //   若编辑期间单据被 assign/intake_accept 等动作带出本档，WHERE 不命中，changes=0 → 409，不静默误写）。
        const statusPlaceholders = tierStatuses.map(() => '?').join(',');
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET ${setFrags.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ? AND status IN (${statusPlaceholders})`,
          [...setParams, id, ...tierStatuses]);
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_EDIT' }); }
        // 当前轮已有技术负责人评估意见 → summary 追加"评估在先"标注（§6.4·判定口径同源 clearPendingConsultOnLeave）。
        //   NULL 防御：tech_lead_notify_request_event_id 为 NULL（无活动轮）时短路，不查 timeline。
        const hasCurrentRoundComment = row.tech_lead_notify_request_event_id != null
          ? await dbGetAsync(
              `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
              [id, row.tech_lead_notify_request_event_id])
          : null;
        // note timeline + action_code=edit_in_revision（改动字段名列入 summary·结构化审计够用）。
        //   ⚠️ sys_issue_timeline 无 payload_json 列（该列在 sys_issue_dev_events）——改动快照落 summary 文本·
        //     不为审计明文差异做 schema 迁移（超 C4 范围·字段名列表已满足「哪些字段改了」审计需求）。
        const changedLabels = changed.map(f => EDIT_FIELD_LABELS[f] || f);
        const noteSummary = `编辑内容（${changedLabels.join('、')}）` + (hasCurrentRoundComment ? '（当前轮已有评估意见，评估在先）' : '');
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'edit_in_revision', ?, ?)`,
          [id, noteSummary, Number(actor.id) || null, actor.name || null]);
        await sysCommit();
        return res.json({ id, changed, action: 'edit_in_revision' });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // SYS_BUSY 等保 503（业务错误·安全文案）
      // codex C4 MED-4：未识别异常不回传 err.message（防泄露 SQLite 错误/约束名/内部实现）·日志留全供排查·客户端仅通用文案+稳定码。
      logger.error('[系统迭代] 编辑内容失败:', err && err.stack || (err && err.message));
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
    let requestEventId = null, techLeadName = null;   // S5 手动化：techLeadUser/issueSnap 随首发段删除退场
    try {
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, title, system_name, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // ⭐⭐ [C10·裁定2·绑单精判] 本端点此前仅靠 requireIntakeLiaison 中间件粗筛（admin∨白名单），无 handler 内精判——
        //   C10 补上 **admin ∨ 该单 intake_liaison_id 本人**（行为变更）。⚠️ **不给空单兜底**：空单兜底仅 intake_accept 有
        //   （裁定2）；存量空单（intake_liaison_id 为空）→ 403，须先受理绑定再发起咨询（accept 会把它带出待受理，
        //   这与"空单唯一前进动作是受理"一致，非死锁）。
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) { await sysRollback(); return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' }); }
        // ⭐ 角色权限重构 v2.1（C2.5 撤销）：开放态经 sysTechConsultGateStatus 统一判定——全类型均「待受理」
        //   （C3 时期曾按 type 分流，变更流「待商议」/bug「待受理」，该分流已随预沟通段撤销归一）。
        //   codex Round-A 审 MED：分流函数 fail-closed 返 null（未登记 type）时必须显式拒绝，
        //   不能让 `row.status !== null` 恒真而被误判为"状态不对"（那会给出一条误导性错误信息）。
        const gateStatus = sysTechConsultGateStatus(row.type);
        if (gateStatus === null) { await sysRollback(); return res.status(409).json({ error: `未知的迭代单类型「${row.type}」，无法判定技术负责人沟通开放态`, code: 'REQUEST_TECH_CONSULT_TYPE_INVALID' }); }
        if (row.status !== gateStatus) { await sysRollback(); return res.status(409).json({ error: `仅「${gateStatus}」态可发起技术负责人沟通（当前「${row.status}」）`, code: 'REQUEST_TECH_CONSULT_STATUS_INVALID' }); }
        // ⭐ 角色权限重构 C4·184 号预审 HIGH（用户裁定 PH-1，撤销 codex Round-A 审 HIGH 加的终局守卫）：
        //   **换轮合法化**——原「本轮已有意见即终局，永不可再发起」制造了一个死角（新负责人留言撞唯一性
        //   约束、取消咨询被"已留言不可取消"挡住，单据卡死无法再往下走）。新世界模型：意见唯一性不再是
        //   "整单只能有一条"，而是**绑定咨询轮次**——`tech_lead_notify_request_event_id` 标识"当前轮"，
        //   判定改为"轮内唯一"（EXISTS 判断改用 `timeline.id > 当前 request_event_id`，见 tech-lead-comment
        //   端点的 INSERT…SELECT 子查询）。已有意见后 admin/受理人**可以**直接再次 request 开新轮，旧意见
        //   留在 timeline 作历史（不删不改）。本处早检查（事务内 hasComment→409）随之整体删除，唯一性判定
        //   下沉到 tech-lead-comment 端点自己的轮内 NOT EXISTS 子查询里。
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
        // ⭐ 角色权限重构 C4·184 号预审 HIGH（换轮合法化）：WHERE 的 NOT EXISTS(tech_lead_comment) 已删除——
        //   开新轮不再要求"整单尚无意见"，唯一性判定下沉到 tech-lead-comment 端点自己的轮内子查询。
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET tech_lead_id=?, tech_lead_name=?, tech_lead_notify_request_event_id=?,
                  tech_lead_notify_status='not_sent', tech_lead_notify_message_key=NULL, tech_lead_read_at=NULL,
                  tech_lead_notify_error=NULL, tech_lead_notified_at=NULL, tech_lead_notify_sent_by=NULL,
                  updated_at=datetime('now','localtime')
             WHERE id=? AND status=?`,
          [techLeadId, techLeadName, requestEventId, id, gateStatus]);
        if (!upd || upd.changes !== 1) {
          await sysRollback();
          return res.status(409).json({ error: '迭代单状态已变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' });
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      // ⭐⭐ S5 通知手动化（方案 v2.1 §6·用户拍板 D4·2026-07-28）：**提交后首发段整体删除**——
      //   发起/换轮咨询不再自动发钉钉。事务内本就把 notify 列组重置为 not_sent（见上方 UPDATE），删掉
      //   首发后状态天然停 not_sent；发送改由用户在详情页点独立「发送通知」按钮 → 复用 resend-tech-consult
      //   端点（expected_request_event_id 围栏/白名单复检/条件落库全套既有机制·首发与重发对它无机制差别）。
      //   随首发退场的还有：`superseded` 响应标记（那是首发回写的并发保护——没有回写就没有"本次回写被
      //   新 request 取代"这回事·响应体不再含该字段）与 unknown 派生态（无发送即无"结果未知"）。
      //   原 C5 HIGH-1/HIGH-2 的两条防护（不 fresh 查询防混版/提交后异常不伪装 500）随段删除自然消解——
      //   它们防的是"提交后 best-effort 段"的故障面，该段已不存在。
      //   漏发风险的闭环（同批前端）：详情页未发送红条 + 列表 not_sent/failed 徽章 + 已留言收口；
      //   且 R3 受理阻断本身兜底——想受理必进详情，红条可见。
      return res.json({ id, tech_lead_id: techLeadId, tech_lead_name: techLeadName, request_event_id: requestEventId, tech_lead_notify_status: 'not_sent' });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 发起技术负责人沟通失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '发起技术负责人沟通失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── resend-tech-consult：重发技术负责人通知（受理排期改造 §6·C5）──────────────────────
  //   ⭐⭐ [C10-fix M2·补绑单精判·对称] 权限收紧为 **admin ∨ 该单 intake_liaison_id 本人**（isBoundLiaisonOrAdmin·
  //     码 NOT_BOUND_LIAISON），与对称的 request-tech-consult/cancel-consult 同口径（§10.2 通知重发仅 admin∨绑定本人）。
  //     **去掉原 created_by 分支**：它是**权限**（决定谁能触发重发·非通知 self-guard），§10.2 无 created_by，故随收紧
  //     移除（与 intake-return 的 created_by=通知 self-guard 保留不同）。端点内加载 issue 后精判（不挂角色中间件·因需读
  //     row.intake_liaison_id）。空单（intake_liaison_id 为空）→ 403，须先受理绑定。
  //   携带 expected_request_event_id·与当前 tech_lead_notify_request_event_id 不一致→409（防基于旧版本重发·期间又 request 换人/连发·§6）。
  //   双层守：expected 显式比对 + recordSysTechLeadNotify 条件 request_event_id 落库（并发期间 request_event_id 又变则 changes=0→409）。
  router.post('/sys-issues/:id/resend-tech-consult', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const expectedEventId = parsePositiveId((req.body || {}).expected_request_event_id);
    if (!expectedEventId) return res.status(400).json({ error: '缺少 expected_request_event_id', code: 'EXPECTED_REQUEST_EVENT_ID_REQUIRED' });
    const actor = sysActor(req);
    try {
      const row = await dbGetAsync('SELECT id, type, title, system_name, status, intake_liaison_id, tech_lead_id, tech_lead_notify_request_event_id FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // ⭐⭐ [C10-fix M2·绑单精判] 权限收紧为 admin ∨ 该单 intake_liaison_id 本人（与 request-tech-consult/
      //   cancel-consult 对称）——原「admin∨受理人白名单[13]∨建单人」三方收敛；created_by 是权限分支（§10.2 无），
      //   随收紧移除（非通知 self-guard）。空单（intake_liaison_id 为空）→ 403 NOT_BOUND_LIAISON，须先受理绑定。
      // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed·async 读库·此处尚未开事务无回滚顾虑）。
      if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) return res.status(403).json({ error: '仅管理员或该单对接人可重发', code: 'NOT_BOUND_LIAISON' });
      // C10 末次审 #5（codex149）：重发仅限受理阶段——原表述"技术负责人沟通是「待受理」态动作"是 C10 时代
      //   （C3 谓词前移前）的旧口径，C3 时期曾按 type 分流（变更流「待商议」/bug「待受理」）；**v2.1 撤销
      //   C2.5 后归一为全类型「待受理」**。受理通过(intake_accept)/退改后单已离开开放态，旧请求不应继续
      //   向技术负责人发过期通知（intake_accept 不清 tech_lead 字段·仅由本状态门约束）。
      //   置于权限校验之后（避免非权限者借状态码侧信道探单据态·同不变量顺序）。
      // ⭐ 角色权限重构 v2.1：与 request-tech-consult 同一分流来源（sysTechConsultGateStatus）。
      //   codex Round-A 审 MED：分流函数 fail-closed 返 null（未登记 type）时须显式拒绝。
      const gateStatus = sysTechConsultGateStatus(row.type);
      if (gateStatus === null) return res.status(409).json({ error: `未知的迭代单类型「${row.type}」，无法判定技术负责人沟通开放态`, code: 'REQUEST_TECH_CONSULT_TYPE_INVALID' });
      if (row.status !== gateStatus) return res.status(409).json({ error: `该单已离开${gateStatus}阶段，不可重发技术负责人沟通`, code: 'TECH_CONSULT_RESEND_LATE' });
      // ⭐ 角色权限重构 C4·184 号预审 HIGH（PH-1 换轮合法化，撤销原"整单终局"判定）：ALREADY_COMMENTED
      //   改**轮内**判定——先确认"当前轮"存在（tech_lead_id/event_id 均非空，NULL=无活动轮，见 PH-1 世界
      //   模型 NULL 防御），再判该轮是否已有意见；旧轮的意见不拦（换轮后是新一轮，"重发请评估通知"对
      //   新一轮而言仍然成立）。故顺序反过来：先判"有没有当前轮"，再判"当前轮有没有意见"。
      if (!row.tech_lead_id || !row.tech_lead_notify_request_event_id) return res.status(409).json({ error: '该单未发起技术负责人沟通，无可重发', code: 'NO_TECH_CONSULT_TO_RESEND' });
      const hasComment = await dbGetAsync(
        `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
        [id, row.tech_lead_notify_request_event_id]);
      if (hasComment) return res.status(409).json({ error: '本单技术评估已终局（已提交评估意见），不可重新发起技术负责人沟通', code: 'TECH_CONSULT_ALREADY_COMMENTED' });
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

  // ── tech-lead-comment：技术负责人提交最终评估意见（角色权限重构 C3·方案 v1.9 §4-C3）──────────────────────
  //   权限：仅 isSysTechLead(actor.id)（[7]·**不放行 admin**——本判定只按 id 白名单不按 role，即便某 admin
  //     的 user_id 恰好也在白名单里，本函数本身对"是不是 admin"零感知，不给 admin 开任何后门）
  //     + 本单 tech_lead_id === actor.id（本人门·isSysTechLead 只证明"是白名单里的技术负责人"，
  //     不证明"是本单被咨询的那个人"，白名单未来若扩容这一步不可省）。
  //   谓词：**status='待受理'（硬编码字面量，非按 type 分流的 sysTechConsultGateStatus）**。历史沿革：
  //     C3 落地时随 C2.5 预沟通段令本端点谓词硬编码「待商议」，只服务变更流（bug 不获得本端点）；
  //     **C2.5 已随方案 v2.1 撤销**，谓词改回「待受理」——bug 现与变更流同等可用本端点提交评估意见
  //     （不再是变更流专属能力，见 transitions.js request_tech_consult 条目注释的沿革说明）。
  //   ⭐ 角色权限重构 C4·184 号预审 HIGH（PH-1 用户裁定，世界模型：意见唯一性绑咨询轮次，非整单唯一）：
  //     一条不可变**改为轮内**——同一 `tech_lead_notify_request_event_id`（当前轮）内只能提交一次；
  //     换轮（request-tech-consult 重新发起）后旧轮的 timeline.id 必小于新轮 request_event_id，天然
  //     不参与新一轮的唯一性判断（timeline id 单调递增，见 PH-1 世界模型）。一条不可变·单条原子写
  //     （照抄 request_tech_consult「写 timeline note + INSERT 回调自身 changes/lastID」范式）：
  //     资格（tech_lead_id=本人 且 status=待受理 且 **event_id 非 NULL**——NULL 防御，无活动轮不可提交）
  //     + 唯一性（当前轮尚无 tech_lead_comment，`timeline.id > 当前 request_event_id`）+ 插入合并进
  //     一条 INSERT…SELECT，无查插竞态；结果读取用本次 INSERT 回调自身的 changes/lastID（不再发起
  //     独立 changes()/last_insert_rowid() 查询，避免共享连接结果被并发请求污染）。
  //   SQLITE_BUSY：本端点**不经 sysBeginImmediate/mutex**（单条语句本身在 SQLite 里已原子，无需事务包裹，
  //     属方案 §7.1 已接受的共享连接架构风险同类）——按方案 §4-C3 显式把该 driver 错误单独映射 503，
  //     不与业务冲突的 409 混同（弱判据 status>=400 会把它误判成"合格拒绝"）。
  //   ⭐⭐ C5 末次合并审 HIGH（186 号·**PH-1 收口自身留下的死角**）：轮次围栏。PH-1 撤销了 request 端的
  //     终局守卫（换轮合法化），于是"技术负责人正在填写意见时 admin 重新发起咨询"从不可能变成设计允许。
  //     此前本端点只校验「本人 + 待受理 + 当前轮非空」，不校验"提交的这条意见回答的是哪一轮"——旧弹窗
  //     提交时三个条件全满足，意见被写成**新轮**的唯一意见（timeline.id 必然 > 新轮 event_id），造成
  //     ①意见归属错轮（示例发布者回答的是上一轮的问题）②新轮再也提交不了真意见（轮内唯一性已被占用，需 admin
  //     再换一轮才能解锁）。⚠️ 放大因素：`SYS_TECH_LEAD_IDS` 当前只有一人，换轮必然换给同一人，
  //     上面的"本人门"在这个场景下**完全不提供保护**。
  //     修法与 `resend-tech-consult`（同批 PH-1 收口已配围栏，见其 `:4586`）**同构**：前端提交时带上打开
  //     弹窗那一刻的 `expected_request_event_id`，后端在 INSERT 资格谓词里追加 `= ?` 严格比对（不匹配
  //     则 changes=0，由下方诊断分支给确切码 TECH_LEAD_COMMENT_ROUND_CHANGED，不与"已提交过"混同）。
  router.post('/sys-issues/:id/tech-lead-comment', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    // 轮次围栏（186 号 HIGH）：必填——缺失即拒，不做"未传就放行"的向后兼容（那等于给旧前端留一条绕过
    //   围栏的路；本端点与前端同批部署，无第三方消费者）。照抄 resend-tech-consult:4556 的解析范式。
    const expectedEventId = parsePositiveId((req.body || {}).expected_request_event_id);
    if (!expectedEventId) return res.status(400).json({ error: '缺少 expected_request_event_id', code: 'EXPECTED_REQUEST_EVENT_ID_REQUIRED' });
    const actor = sysActor(req);
    // 权限①：白名单本身（与 role 无关——不放行 admin）
    if (!isSysTechLead(actor.id)) return res.status(403).json({ error: '仅技术负责人可提交评估意见', code: 'NOT_TECH_LEAD' });
    // 输入面（服务端纯文本 + trim 非空 + 长度 ≤2000 + 拒纯空白；前端非授权源，这里才是真闸）
    const raw = (req.body || {}).comment;
    if (typeof raw !== 'string') return res.status(400).json({ error: '评估意见须为文本', code: 'TECH_LEAD_COMMENT_INVALID' });
    const comment = raw.trim();
    if (!comment) return res.status(400).json({ error: '评估意见不能为空', code: 'TECH_LEAD_COMMENT_REQUIRED' });
    if (comment.length > 2000) return res.status(400).json({ error: '评估意见不超过 2000 字', code: 'TECH_LEAD_COMMENT_TOO_LONG' });
    try {
      const row = await dbGetAsync('SELECT id, type, status, title, system_name, tech_lead_id, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // 权限②：本人门
      if (Number(row.tech_lead_id) !== Number(actor.id)) {
        return res.status(403).json({ error: '仅本单被指定的技术负责人可提交评估意见', code: 'NOT_ASSIGNED_TECH_LEAD' });
      }
      let ins;
      try {
        // ⭐ 角色权限重构 C4·184 号预审 HIGH（PH-1）：资格 EXISTS 追加 `tech_lead_notify_request_event_id
        //   IS NOT NULL`（无活动轮不可提交，NULL 防御）；唯一性 NOT EXISTS 改**轮内**——嵌套子查询取
        //   本单当前的 request_event_id，与 timeline.id 比较（同一条语句内完成，保持原子，不引入
        //   "先查 event_id 再拼 JS 参数"的查插竞态）。
        //   ⭐ 186 号 HIGH：资格谓词追加 `tech_lead_notify_request_event_id = ?`（轮次围栏）。与 IS NOT NULL
        //     并存不冗余：`= ?` 在 NULL 时恒为 NULL（不满足）已能挡住无活动轮，但显式保留 IS NOT NULL 让
        //     "NULL 防御"这条不变量在语句里可读、不依赖三值逻辑的隐式行为（PH-1 世界模型的一贯写法）。
        ins = await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           SELECT ?, 'note', ?, 'tech_lead_comment', ?, ?
            WHERE EXISTS(SELECT 1 FROM sys_issues WHERE id=? AND tech_lead_id=? AND status=? AND tech_lead_notify_request_event_id IS NOT NULL
                           AND tech_lead_notify_request_event_id = ?)
              AND NOT EXISTS(SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'
                               AND id > (SELECT tech_lead_notify_request_event_id FROM sys_issues WHERE id=?))`,
          [id, comment, Number(actor.id) || null, actor.name || null, id, actor.id, '待受理'  /* C2.5 撤销·谓词回待受理（方案 v2.1 §3） */, expectedEventId, id, id]
        );
      } catch (dbErr) {
        // SQLITE_BUSY 可重试服务错误（方案 §4-C3）——不是业务冲突，不应归 409
        if (dbErr && (dbErr.code === 'SQLITE_BUSY' || /SQLITE_BUSY/.test(String(dbErr.message || '')))) {
          return res.status(503).json({ error: '系统繁忙，请稍后重试', code: 'SYS_BUSY' });
        }
        throw dbErr;
      }
      if (!ins || ins.changes !== 1) {
        // 只读诊断（changes=0 的确切原因，非弱判据）：已提交过（轮内）优先于 状态/指派已变。
        //   ⭐ PH-1：与上方 INSERT 唯一性判定同一口径——嵌套子查询取当前 event_id，NULL（无活动轮）时
        //   `id > NULL` 恒 NULL，本查询天然查无结果（不会误判"已提交过"），落到下面的 STATE_CHANGED
        //   分支，同样是确切码，不会因 NULL 比较放空唯一性而误报"提交成功"。
        //   ⭐ 186 号 HIGH：轮次诊断**排在最前**——轮次已变时 dup 查的是"新轮有没有意见"，对提交者而言
        //     那不是真实原因（他的意见属于旧轮），报 ALREADY_SUBMITTED 会误导他以为自己重复提交了。
        //     event_id 为 NULL（咨询已被 cancel-consult 取消，九列已清）时 Number(null)=0 ≠ expectedEventId，
        //     同样落这条——文案"重新发起或已取消"覆盖两种成因，都指向同一个可操作动作：刷新后重看。
        const cur = await dbGetAsync('SELECT tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id]);
        if (cur && Number(cur.ev || 0) !== Number(expectedEventId)) {
          return res.status(409).json({ error: '技术负责人沟通已更新（重新发起或已取消），请刷新后重新评估', code: 'TECH_LEAD_COMMENT_ROUND_CHANGED' });
        }
        const dup = await dbGetAsync(
          `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment'
             AND id > (SELECT tech_lead_notify_request_event_id FROM sys_issues WHERE id=?)`,
          [id, id]
        );
        if (dup) return res.status(409).json({ error: '本单已提交过评估意见，不可重复提交', code: 'TECH_LEAD_COMMENT_ALREADY_SUBMITTED' });
        return res.status(409).json({ error: '迭代单状态或指派已变化，无法提交评估意见', code: 'TECH_LEAD_COMMENT_STATE_CHANGED' });
      }
      // 通知受理人「评估已回」——best-effort，失败不回滚已落库的意见（至少一次投递语义·方案原文）。
      //   ⭐ F8 教训：同批落 action_code='notify_sent' 只增 timeline（复用 recordSysNotifyTimeline）——本通道
      //   零持久状态列（C3 方案 §4「schema：零新列」），timeline 行是这条通知**唯一**的历史记录，不写就永久无痕。
      //   sent_by 走 assertNotifySentBy 校验（fail-closed，非法 actor.id 直接抛错，不静默写非法行）。
      let notifyStatus = 'unknown';
      try {
        const sentBy = assertNotifySentBy('sysTechLeadCommentNotify', actor.id);
        // ⭐ [C10·裁定4] 收件人从全局白名单第一人（SYS_INTAKE_LIAISON_IDS[0]）改为**该单当前 intake_liaison_id**——
        //   技术负责人评论的是这张**具体单**，应通知**本单**对接人而非全局第一人。绑单后语义正确。
        //   ⚠️ intake_liaison_id 为空（存量空单/未绑）→ **不发 + logger.warn 诚实降级**，**不回退候选池**：
        //     回退池会把"技术负责人回复了你的单"发给与本单无关的人，违反绑单语义（[[feedback_write_read_same_semantic]]）。
        const liaisonUserId = row.intake_liaison_id;
        let liaison = null;
        let sendResult;
        // ⭐ [C10-fix2 MED-2] 绑定对接人有效性统一校验（存在 ∧ active ∧ role∈候选 allowlist·共用
        //   resolveValidBoundLiaisonForNotify）——停用/移出候选即无有效收件人：不发 + warn（同 liaison-test
        //   口径），不发给已失去该单对接资格的历史绑定人（原实现只查存在、不验 active/role）。
        const resolvedLiaison = await resolveValidBoundLiaisonForNotify(liaisonUserId);
        liaison = resolvedLiaison.user;
        if (!liaison) {
          logger.warn(`[系统迭代] tech-lead-comment 通知降级：单 ${id} 无有效绑定对接人（intake_liaison_id=${liaisonUserId == null ? 'NULL' : liaisonUserId}·原因=${resolvedLiaison.reason}），不发送`);
          sendResult = { ok: false, reason: resolvedLiaison.reason };
        } else {
          try {
            const baseUrl = await getSafePlatformBaseUrl();
            const { title, md } = buildSysTechLeadCommentReplyMarkdown(row, baseUrl);
            sendResult = await sendIssueDingtalkRaw(liaison, title, md);
          } catch (sendErr) {
            sendResult = { ok: false, reason: 'notify_exception' };
          }
        }
        const ok = !!(sendResult && sendResult.ok && sendResult.message_key);
        const who = liaisonUserId
          ? (liaison ? `${liaison.display_name || liaison.username || ''}(id${liaisonUserId})` : `(id${liaisonUserId})`)
          : '(无绑定对接人)';
        // ⭐ codex Round-C 审 MED（采纳）：recordSysNotifyTimeline 现有返回契约（成功 true / catch 分支 false，
        //   不再是"万一它抛错"这类推测——它本就不抛，只是此前无法从外部区分"写成功"和"静默吞掉"）。
        //   notifyStatus 语义：发送成功且留痕成功→sent；发送成功但留痕失败→unknown（钉钉可能已送达，
        //   只是这条"谁发的/什么时候发的"记录没能落库，不能谎称 sent，但也不是"发送失败"）；发送失败→failed。
        const recorded = await recordSysNotifyTimeline(id, '受理人', who, ok, ok ? sendResult.message_key : (sendResult && sendResult.reason), { id: sentBy, name: actor.name });
        notifyStatus = ok ? (recorded ? 'sent' : 'unknown') : 'failed';
      } catch (notifyErr) {
        logger.warn('[系统迭代] 技术负责人评估意见回复通知失败（意见已提交·不影响）:', notifyErr && notifyErr.message);
      }
      return res.json({ id, tech_lead_comment_id: ins.lastID, notify_status: notifyStatus });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 提交技术负责人评估意见失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '提交评估意见失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── cancel-consult：取消技术负责人沟通（角色权限重构 C3·方案 v1.9 §4-C3 异常收口）──────────────────────
  //   权限：admin ∨ 受理人（沿用既有 requireIntakeLiaison 中间件，与 intake-accept/intake-return/
  //     request-tech-consult 三个受理门动作同源，不新造一个等价判断）。
  //   谓词：**硬编码 status='待受理'**（与 tech-lead-comment 同一决定，理由见其端点注释——C2.5 撤销后
  //     回归「待受理」，bug 同样可用本端点）+ 已留言（tech_lead_comment 存在）则不可取消。
  //   条件更新 + changes 检查 + 失败阻断（[[feedback_state_machine_update_invariant]] 双条件守卫范式）：
  //     changes=0 时只读诊断返回确切冲突原因（已留言不可取消 / 已被取消或尚未发起 / 咨询已换轮 / 状态已变）。
  //   ⭐ 整组清空 tech_lead_* 九列（复用 SYS_CLEAR_TECH_LEAD_FIELDS_SQL 单一真相源，非只清 tech_lead_id）：
  //     只清 id 会留两个真缺陷——展示面矛盾（已清负责人却仍留着通知记录）+ 跨轮次污染
  //     （tech_lead_notify_request_event_id 不清，下一轮 request-tech-consult 的回调可能命中本轮残留版本号），
  //     同 C0 七轮审 HIGH-1「只清 id/name 会留半清状态」的教训，直接复用既有清单，不再另起一份副本。
  //   ⭐ codex Round-A 审 MED（采纳·F3/F4 同构兄弟教训）：**前置 SELECT 必须在 sysBeginImmediate 之内**——
  //     原实现读在事务外（未持锁），读到的 tech_lead_id 快照与随后事务内的 UPDATE 之间存在窗口：另一并发
  //     请求（如受理人重新发起咨询·同人连发生成新 request_event_id、或换人）可能在这个窗口内完成提交，
  //     此时若仍用"事务外读到的旧快照"做 WHERE 条件，会用过期数据判定一次本不该成立的取消/或该拒的没拒。
  //     修法 = relay/tech_lead 通知函数已用过的同款版本围栏：把 SELECT 挪进事务、多绑 CAS 一列
  //     （tech_lead_notify_request_event_id），把"读"和"用来写的条件"钉在同一次原子操作里。
  router.post('/sys-issues/:id/cancel-consult', authenticateToken, requireSysSchemaReady, requireIntakeLiaison, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        // ⭐ 读挪进事务内（见上方端点注释）：同一事务内先读后写，杜绝"事务外读到的旧快照"窗口。
        const row = await dbGetAsync('SELECT id, tech_lead_id, tech_lead_name, tech_lead_notify_request_event_id, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        // ⭐⭐ [C10·决策3·绑单精判] 本端点此前仅靠 requireIntakeLiaison 中间件鉴权，粗筛放宽后 dev(user) 漏进（实测
        //   dev 取消 got 200 期望 403）——补 handler 内精判 **admin ∨ 该单 intake_liaison_id 本人**（与 request-tech-consult
        //   对称·行为变更）。空单（intake_liaison_id 为空）→ 403，须先受理绑定（与 request-tech-consult 同口径）。
        // ⭐ [C10-fix5 HIGH] 叠加 eligibility（撤销资格即失操作权·fail-closed）。
        if (!(await isBoundLiaisonEligibleOrAdmin(actor, row))) { await sysRollback(); return res.status(403).json({ error: '仅管理员或该单对接人可执行此操作', code: 'NOT_BOUND_LIAISON' }); }
        // ⭐ 角色权限重构 C4·184 号预审 MED（合并复审收尾）：NULL 退化态短路——event_id 为 NULL（哪怕
        //   tech_lead_id 恰好有值，属理论上不该出现的脏态：request-tech-consult 恒同时写这两列，两者
        //   不该出现"一个有值一个空"的组合）时，直接判定"无活动轮"拒绝，不进入下面的 guarded UPDATE。
        //   ⚠️ 不加这层短路的话：下面 WHERE 的 `tech_lead_notify_request_event_id IS ?`（NULL 时是
        //   `IS NULL`）会命中这一行，而 NOT EXISTS 子查询里的 `id > ?`（NULL）在 SQL 三值逻辑下对任何
        //   timeline 行都不成立，NOT EXISTS 因此"查无匹配"而恒真——两者叠加会让 guarded UPDATE 把这个
        //   本不该存在的脏态当成"一个可以合法取消的活动轮"清掉。与 PH-1/PH-2 各处"event_id NULL=无活动轮"
        //   的世界模型同源，本短路是一致性防御，不是业务新增判断。
        if (row.tech_lead_notify_request_event_id == null) {
          await sysRollback();
          return res.status(409).json({ error: '技术负责人沟通已被取消或尚未发起', code: 'CANCEL_CONSULT_NO_ACTIVE_CONSULT' });
        }
        // ⭐ 角色权限重构 C4·184 号预审 HIGH（PH-1）：已留言不可取消——改**轮内**判定（id > 本轮 request_event_id，
        //   同 tech-lead-comment/resend-tech-consult 同一口径）。理论上到不了"当前轮已留言又来取消"这个
        //   组合（前端按钮按轮内态互斥展示），但同源改齐防未来漂移——不留一处判定还是整单口径的死角。
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET ${SYS_CLEAR_TECH_LEAD_FIELDS_SQL.join(', ')}, updated_at=datetime('now','localtime')
             WHERE id=? AND tech_lead_id=? AND tech_lead_notify_request_event_id IS ? AND status=?
               AND NOT EXISTS(SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?)`,
          [id, row.tech_lead_id, row.tech_lead_notify_request_event_id, '待受理'  /* C2.5 撤销·谓词回待受理（方案 v2.1 §3） */, id, row.tech_lead_notify_request_event_id]
        );
        if (!upd || upd.changes !== 1) {
          await sysRollback();
          const hasComment = await dbGetAsync(
            `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
            [id, row.tech_lead_notify_request_event_id]);
          if (hasComment) return res.status(409).json({ error: '技术负责人已提交评估意见，不可取消', code: 'CANCEL_CONSULT_ALREADY_COMMENTED' });
          const fresh = await dbGetAsync('SELECT tech_lead_id, tech_lead_notify_request_event_id, status FROM sys_issues WHERE id = ?', [id]);
          if (!fresh || !fresh.tech_lead_id) return res.status(409).json({ error: '技术负责人沟通已被取消或尚未发起', code: 'CANCEL_CONSULT_NO_ACTIVE_CONSULT' });
          // ⭐ 换轮诊断：tech_lead_id 未变但 request_event_id 已变——期间又发起了一轮咨询（同人连发/换人后又连发），
          //   本次取消所依据的快照已过期，不能当作"取消当前这一轮"（否则会取消一个自己都没见过的新轮次）。
          if (Number(fresh.tech_lead_notify_request_event_id) !== Number(row.tech_lead_notify_request_event_id)) {
            return res.status(409).json({ error: '技术负责人沟通已换轮（重新发起/换人），请刷新后重试', code: 'CANCEL_CONSULT_CONSULT_ROUND_CHANGED' });
          }
          return res.status(409).json({ error: '迭代单状态或指派已变更，请刷新重试', code: 'CANCEL_CONSULT_STATE_CHANGED' });
        }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
           VALUES (?, 'note', ?, 'cancel_consult', ?, ?)`,
          [id, `取消技术负责人沟通：${row.tech_lead_name || ('#' + row.tech_lead_id)}`, Number(actor.id) || null, actor.name || null]
        );
        await sysCommit();
        return res.json({ id, canceled: true });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 取消技术负责人沟通失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '取消技术负责人沟通失败，请稍后重试', code: 'INTERNAL_ERROR' });
    }
  });

  // ── tech-lead-comment/resend-notify：重发「评估已回」通知给受理人（角色权限重构 C3 补丁·方案 §4-C3）─────
  //   来由：方案原文"投递状态记录 + 失败可重试补发入口"——tech-lead-comment 端点只做了首发 + 留痕，
  //   缺补发入口。本端点补上，与首发同构（不新起一套发送逻辑）。
  //   ⭐⭐ [C10-fix M2·绑单精判] 权限：admin ∨ **该单 intake_liaison_id 本人**（isBoundLiaisonOrAdmin·从原
  //   isSysCoordinator=admin∨白名单[13] 收紧·§10.2 通知重发仅绑定本人）∨ 本单技术负责人本人（isSysTechLead(actor.id)
  //   且 tech_lead_id===actor.id，同 tech-lead-comment 端点的本人门·selfTechLead 保留：本单负责人 resend 自己的
  //   评估通知合理，非对接人权限面）。handler 内判（不挂中间件——要额外放行"本单技术负责人"这一格，中间件表达不了）。
  //   守卫：单不存在 404；**当前轮**尚无 tech_lead_comment（未曾提交评估意见，或仅有旧轮的历史意见）→
  //   409（补发无意义，没什么可发的——PH-1 第二半：换轮合法化后必须堵住"旧轮意见被当成现役意见补发"，
  //   否则受理人会收到一条指向已作废轮次的过期通知）；status 已离开「待受理」→ 409（受理人已行动/单据
  //   已流转，补发失去意义）。
  //   行为：与 tech-lead-comment 端点的通知段逐字同构——发给**该单 intake_liaison_id**（裁定4·空单不发+warn），sent_by 走
  //   assertNotifySentBy，复用 buildSysTechLeadCommentReplyMarkdown + recordSysNotifyTimeline 再落一条
  //   只增 timeline 行（至少一次投递语义·方案降级声明明说不追求 exactly-once，重复通知可容忍）。
  //   通知失败也 200（补发本身 best-effort，与首发同语义），响应体如实带 notify_status:'failed'。
  router.post('/sys-issues/:id/tech-lead-comment/resend-notify', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const actor = sysActor(req);
    try {
      const row = await dbGetAsync('SELECT id, type, status, title, system_name, tech_lead_id, tech_lead_notify_request_event_id, intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const isSelfTechLead = isSysTechLead(actor.id) && Number(row.tech_lead_id) === Number(actor.id);
      // ⭐⭐ [C10-fix M2·绑单精判] 「admin∨受理人」段从 isSysCoordinator（admin∨白名单[13]）收紧为
      //   isBoundLiaisonOrAdmin（admin∨该单 intake_liaison_id 本人·§10.2 通知重发仅绑定本人）。
      // ⭐⭐⭐ [C10-fix2 MED-3·selfTechLead 例外正式登记] **§10.2「通知重发绑单精判」的唯一显式例外 = 本单技术
      //   负责人自服务重发本人评估通知**（isSysTechLead(actor.id) ∧ tech_lead_id===actor.id）——非临时豁免、非
      //   遗留：技术负责人回了评估意见后，重发一次"评估已回"给受理人属自服务合理动作，与"谁是本单对接人"这条
      //   权限轴正交，故在绑单精判之外单开这一格（handler 内判·中间件表达不了"本单技术负责人"这一动态条件）。
      //   ⭐ [C10-fix2 MED-3·统一拒绝码] 非 self 非绑定统一返回 **NOT_BOUND_LIAISON**（消除原
      //   NOT_AUTHORIZED_FOR_TECH_LEAD_COMMENT_RESEND 这套仅本端点独有的拒绝语义·与全模块绑单精判端点同码）。
      //   空单（intake_liaison_id 为空）→ 仅 admin/selfTechLead 可发。
      // ⭐ [C10-fix5 HIGH] 绑单分支叠加 eligibility（撤销资格即失操作权·fail-closed）；selfTechLead 例外正交保留。
      if (!((await isBoundLiaisonEligibleOrAdmin(actor, row)) || isSelfTechLead)) {
        return res.status(403).json({ error: '仅管理员、该单对接人或本单技术负责人可重发通知', code: 'NOT_BOUND_LIAISON' });
      }
      // ⭐ 角色权限重构 C4·184 号预审 HIGH（PH-1 第二半）：hasComment 改**仅当前轮**——`id > 本轮
      //   request_event_id`。event_id 为 NULL（无活动轮）时 `id > NULL` 恒 NULL，hasComment 查询天然
      //   查无结果，落入下方 409（NULL 防御，不会因三值逻辑放空判断而误判"有当前轮意见"）。
      const hasComment = row.tech_lead_notify_request_event_id != null
        ? await dbGetAsync(
            `SELECT 1 FROM sys_issue_timeline WHERE issue_id=? AND action_code='tech_lead_comment' AND id > ?`,
            [id, row.tech_lead_notify_request_event_id])
        : null;
      if (!hasComment) return res.status(409).json({ error: '本单尚无技术负责人评估意见，无可重发', code: 'NO_TECH_LEAD_COMMENT_TO_NOTIFY' });
      if (row.status !== '待受理'  /* C2.5 撤销·谓词回待受理（方案 v2.1 §3） */) {
        return res.status(409).json({ error: '本单已离开待受理阶段，无需重发通知', code: 'TECH_LEAD_COMMENT_NOTIFY_RESEND_LATE' });
      }
      // ⭐⭐ C5 末次合并审 MED（186 号）：**原注释的竞态分析漏了一条路径**——它只考虑"被带离待商议"，
      //   并断言"不会是同时被 cancel-consult 取消（已留言的单 cancel 恒 409）"，但漏了 **request_tech_consult
      //   换轮**：PH-1 撤销终局守卫后，已留言的单**可以**被重新发起咨询。换轮后旧意见的 timeline.id 小于
      //   新轮 event_id，"当前轮已回复"不再成立，此时补发"评估已回"就是向受理人**谎报新轮已完成评估**
      //   （不是"发晚了"，是内容与现状不符）。故这条不能沿用 at-least-once 容忍，必须堵。
      //   修法：发送前二次确认 status 与 event_id 都还是首次读到的那一份，不一致即 409 不发送。
      //   ⚠️ 残余窗口如实声明：二次确认与外部发送之间仍有微秒级窗口（外部调用无法纳入事务），本修复把
      //   窗口从"整个权限校验+构造期"收窄到"确认后立即发送"，不是消除。原注释接受的"被带离待商议"竞态
      //   同样由这次二次确认一并收窄（status 也在比对项里）。
      //   ⭐⭐ **该残余窗口已由用户于 2026-07-28 明确接受**（186 号复审判"部分闭合"，二选一：实现轮次绑定
      //   的待发送记录+条件领取〔架构级〕/ 取得明确风险接受结论 —— 用户选后者）。
      //   ⚠️ **接受依据（末轮审修正版·初版依据有事实错误，见下）**：
      //     ① 后果是一条**语义过期的通知**而非数据错误——受理人点进单据看到的永远是现状，通知的作用是
      //        提醒去看单据而不是替代看单据，最坏结果是白点一次；
      //     ② 概率低但**真实可达**：需要一次换轮请求的 DB 写入恰好落在本端点"二次确认 → 外部发送"之间，
      //        两个操作在时间上高度接近才会命中。
      //   ⚠️ **初版依据错在哪（留档防重犯）**：初版写的是"触发需 admin 在微秒级窗口内完成换轮，人工操作
      //     粒度是秒，物理上几乎不可达"。**这是错的**——它把"admin 的操作时长"与"admin 请求的落库时刻"
      //     混为一谈：admin 在点按钮那一刻操作就结束了，之后请求排队/等 mutex，**只要它的写入落在窗口内
      //     即触发，人不需要在窗口内做任何事**。且窗口**无硬上界**（事件循环调度、系统负载、外部网络调用
      //     前的异步边界都可能拉长它），"微秒级"同样是想当然。此外初版把多人并发列为"未来才需复查"，
      //     而生产**当前就有 6 个 active admin**（167 号审已查明的事实）——并发前提当下即成立。
      //   ⚠️ **复查触发条件（不是永久接受）**：**任何提高「轮次变更」并发度或自动化程度的变化**，
      //     包括但不限于：① SYS_TECH_LEAD_IDS 扩容至多人 ② 批量 / 脚本化咨询操作入口 ③ 多 admin 同时
      //     处理同一单成为常态操作 ④ 任何自动 / 定时修改 status 或 tech_lead_notify_request_event_id 的路径。
      //     任一显著变化时须重新评估，届时回到轮次绑定待发送记录 + 条件领取方案。
      const fresh = await dbGetAsync('SELECT status, tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id]);
      if (!fresh || fresh.status !== '待受理'  /* C2.5 撤销·谓词回待受理（方案 v2.1 §3） */
          || Number(fresh.ev || 0) !== Number(row.tech_lead_notify_request_event_id || 0)) {
        return res.status(409).json({ error: '技术负责人沟通已更新（重新发起/取消）或单据已流转，请刷新后再试', code: 'TECH_LEAD_COMMENT_NOTIFY_ROUND_CHANGED' });
      }
      let notifyStatus = 'failed';   // 默认 failed（而非 unknown）——本端点是补发，任何未能完成发送都应如实报"没发成"
      try {
        const sentBy = assertNotifySentBy('sysTechLeadCommentResendNotify', actor.id);
        // ⭐ [C10·裁定4] 同 tech-lead-comment：收件人改为该单 intake_liaison_id；空→不发+warn（不回退候选池）。
        const liaisonUserId = row.intake_liaison_id;
        let liaison = null;
        let sendResult;
        // ⭐ [C10-fix2 MED-2] 绑定对接人有效性统一校验（共用 resolveValidBoundLiaisonForNotify）——与
        //   tech-lead-comment 首发同口径：停用/移出候选即无有效收件人，不发 + warn。
        const resolvedLiaison = await resolveValidBoundLiaisonForNotify(liaisonUserId);
        liaison = resolvedLiaison.user;
        if (!liaison) {
          logger.warn(`[系统迭代] tech-lead-comment 重发通知降级：单 ${id} 无有效绑定对接人（intake_liaison_id=${liaisonUserId == null ? 'NULL' : liaisonUserId}·原因=${resolvedLiaison.reason}），不发送`);
          sendResult = { ok: false, reason: resolvedLiaison.reason };
        } else {
          try {
            const baseUrl = await getSafePlatformBaseUrl();
            const { title, md } = buildSysTechLeadCommentReplyMarkdown(row, baseUrl);
            sendResult = await sendIssueDingtalkRaw(liaison, title, md);
          } catch (sendErr) {
            sendResult = { ok: false, reason: 'notify_exception' };
          }
        }
        const ok = !!(sendResult && sendResult.ok && sendResult.message_key);
        const who = liaisonUserId
          ? (liaison ? `${liaison.display_name || liaison.username || ''}(id${liaisonUserId})` : `(id${liaisonUserId})`)
          : '(无绑定对接人)';
        // ⭐ codex Round-D 审 MED（采纳）：与 tech-lead-comment 端点统一三态语义——"发送成功但留痕失败"
        //   报 'unknown' 而非 'failed'。此前本端点把这两种情形都报 failed，会诱导消费方把"其实已送达"
        //   当作可重试失败再发一遍（重复通知虽在 at-least-once 容忍内，但明知已送达还引导重发是语义谎报）；
        //   两端点同一情形必须同一状态词（写读同源）。发送失败仍恒 failed。
        const recorded = await recordSysNotifyTimeline(id, '受理人', who, ok, ok ? sendResult.message_key : (sendResult && sendResult.reason), { id: sentBy, name: actor.name });
        notifyStatus = ok ? (recorded ? 'sent' : 'unknown') : 'failed';
      } catch (notifyErr) {
        logger.warn('[系统迭代] 技术负责人评估意见重发通知失败:', notifyErr && notifyErr.message);
      }
      return res.json({ id, notify_status: notifyStatus });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 重发技术负责人评估意见通知失败:', err && err.stack || (err && err.message));
      return res.status(500).json({ error: '重发通知失败，请稍后重试', code: 'INTERNAL_ERROR' });
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
      const actor = sysActor(req);   // C2b：流转 actor 与通知 sent_by 同源，不双取
      const r = await sysIssueTransition(id, 'confirm-online-norelease', null, actor, req.body || {});
      await dispatchSysNotify(id, r.notifyAfterCommit, actor.id);
      res.json({ id, status: r.toStatus, action: 'confirm-online-norelease' });
    } catch (err) { sendSysTransitionError(res, err); }
  });

  // ── DELETE /sys-issues/:id：物理删除迭代单（admin 专用·不可逆·2026-07-07）──────────
  //   场景：清理测试/脏单。物理删除（非 void 软删）——sys_issues 主表 + **六张 issue_id 子表**全清 + 附件磁盘文件。
  //   ⚠️ 原文写"admin **单人**清理"是单 admin 时代的化石（生产实为 6 个 active admin）；
  //     "三张子表"同样是化石（C0 后带 issue_id 的子表已达 6 张）——两处都已按事实更正。
  //   ⚠️ 级联必须手动做：本库从未开 PRAGMA foreign_keys=ON（子表 FK ON DELETE CASCADE 仅自文档、运行不生效，
  //     见 sys_issue_timeline 建表注释），故显式 DELETE 每张子表，否则留孤儿（timeline / 附件行 / 协作开发通知行）。
  //   守边界（方案 a）：拒删「被别的单派生引用（origin）」或「已挂上线批次（release_id）」的单——防悬空引用 / 破坏
  //     批次成员一致性。真要删这类单说明有特殊情况，应单独处置，不让删除按钮默默替决策。
  //   通知数据落点：creator/requester/release_assignee 三侧通知快照在 sys_issues 主表列（删主行即清）；
  //     协作开发通知在 sys_issue_dev_assignees（删子表即清）——两处都在本级联范围内，零残留。
  //
  //   ⭐ 角色权限重构 C2a（方案 v1.7 §4-C2a·codex 167 号 HIGH-1）：**删前先写 sys_issue_delete_audit**。
  //     背景：本端点原注释写「场景：admin **单人**清理测试/脏单」——那是"系统里只有一个 admin"时代的化石，
  //     生产实为 **6 个 active admin**，每人都能不可逆物删他人单，且 `DELETE FROM sys_issue_timeline`
  //     把审计链一并抹掉，DB 内零痕迹（仅 PM2 日志记 username：会轮转、不可查询、非审计表）。
  //     用户 2026-07-27 拍板：6 人皆自己人可信 → 风险性质是"误操作 + 事后查不清"而非越权 →
  //     **只补审计留痕，不拆 admin 权限、不改软删**（软删要动 origin 引用完整性 / 附件磁盘保留策略 /
  //     "清理测试脏单"这个真实场景，改动面远大于收益）。
  //   ⚠️ 三条不变量（改本段前先读）：
  //     ① **审计写在同一事务内、且在 DELETE 之前**——审计写失败即整体 rollback。
  //        ⚠️ **成立域到此为止：sys 模块内**（对抗审 F5 收口·原文写的是无条件的"结构性排除"，那是绝对词失准）。
  //        跨模块不成立：本项目单个共享 sqlite3 连接，sys mutex 只串行化 sys 模块自己的事务点，
  //        而 corrections/collab 等模块另有 20+ 处**裸 BEGIN**（catch 里例行 ROLLBACK）。
  //        若删除事务的某个 await 空隙里，另一模块的请求在同一连接上 BEGIN 撞出 nested-transaction 错误，
  //        它的 catch-ROLLBACK 回滚的是**本删除事务** → 审计 INSERT 被撤销、后续 DELETE 退化 autocommit
  //        逐条提交 → 终态恰是"删了但没记"+子表孤儿。该机制在 collab e2e T18 **已复现过**
  //        （见 sysTxnMutex 段注释），根治=全局 DB 事务锁，属 [[collab_transaction_mutex_p3_todo]] P3 债。
  //        本片不局部硬拧（局部锁救不了跨模块），改为：**表述收窄 + 失败路径留 CRITICAL 线索**（见下方 catch）。
  //     ② 快照必须在 DELETE **之前**读（删后就没有了）：单据整行 + timeline 全部行 + 附件清单。
  //     ③ reason 必填——不可逆动作要求操作者当场说明"为什么删"（trim 1..200，body 传，
  //        同 DELETE /dev/commits/:commitId 既有范式）。**这是契约变更**：前端删除弹窗已同 commit 加输入框，
  //        6 个 playwright 实测脚本的收尾清理调用也同批补了 reason（它们只打日志不断言，漏改会静默留脏单）。
  //   ℹ️ 已知取舍（codex C2a 复审 LOW·不改）：快照在事务内一次性读出并序列化，体积随该单 timeline/附件行数
  //     线性增长，持锁时间同理。当前 admin 低频 + 单据规模小，且"删前完整快照"正是本片目标，
  //     不为此牺牲完整性；若将来出现超大单据再考虑规模提示或上限保护。
  router.delete('/sys-issues/:id', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    // C2a：reason 必填（入事务前先校，省一次无谓持锁）
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: '删除原因必填（trim 1..200，经 body 传）', code: 'VALIDATION' });
    const actor = sysActor(req);
    try {
      // 【codex 44 审 H-1/H-2 采纳】守卫读 + 附件清单读全部下沉到 sysBeginImmediate 之后：
      //   所有 sys 写路径（建单/派生/挂批次/传附件）都走同一模块级全局锁（见本文件 sysBeginImmediate 注释），
      //   持锁期间无写路径能插入，把「读到无派生/无批次 + 附件清单」与「删除」收进同一持锁窗口 → TOCTOU 窗口归零
      //   （否则读后删前可能被插入派生子单/挂 release_id → 悬空母单；或被传新附件 → 删库不删盘的孤儿文件）。
      let atts = [];
      let titleForLog = '';
      await sysBeginImmediate();
      try {
        //   C2a：守卫读由 `SELECT id, title, release_id` 扩为 **`SELECT *`** —— 同一行既做守卫判定又做审计快照，
        //   一次读两用（不再单独跑一条快照查询，也就不存在"两次读之间行被改"的窗口）。
        //   列举式 SELECT 在这里是错的：本表 60+ 列且仍在演进，审计要的正是"删除当时的全貌"，漏列即漏证。
        const row = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        titleForLog = row.title || '';
        // 守卫①：有派生子单（被引用为 origin）→ 删母单会让子单 origin_issue_id 悬空，拒删。
        const derived = await dbGetAsync('SELECT id FROM sys_issues WHERE origin_issue_id = ? LIMIT 1', [id]);
        if (derived) { await sysRollback(); return res.status(409).json({ error: '该单已派生出子单，不可删除（请先处理派生链）', code: 'SYS_ISSUE_HAS_DERIVED' }); }
        // 守卫②：已挂上线批次（release_id 非空）→ 删除会破坏批次成员一致性，拒删。
        if (row.release_id) { await sysRollback(); return res.status(409).json({ error: '该单已加入上线批次，不可删除', code: 'SYS_ISSUE_IN_RELEASE' }); }

        // 附件磁盘文件清单：持锁后读，与下方 DELETE 处于同一持锁窗口（防读后删前被传新附件 → 只删库不删盘）。
        //   C2a：由 `SELECT file_name` 扩为 **`SELECT *`**（原只取 file_name 供磁盘删除）——同一次查询两用：
        //   下方磁盘删除仍只读 `a.file_name`，审计则拿到整行。三份快照口径统一为"整行"，理由见下方 timeline 段。
        atts = await dbAllAsync(
          `SELECT * FROM sys_issue_attachments WHERE issue_id = ? ORDER BY id`, [id]);

        // ⭐ C2a 审计快照（必须在 DELETE 之前读——删完就没有了）：单据整行（上方 row）+ 附件清单（上方 atts）
        //   + 下面这**四张 issue_id 子表**的整行快照。
        //   ⚠️ **`SELECT *` 不是偷懒，是契约**（codex C2a 审 HIGH）：初版这里列举了 11 列，当时确实一列不漏，
        //   但 timeline 表是演进中的（历史上加过 action_code / ref_id / round_no），挑列快照会在下一次加列时
        //   **静默漏证**——而漏的恰恰是"删除时刻的完整审计链"，事后无从发现。与上方 issue 快照同一口径。
        //
        // ⭐⭐ **子表清单必须与下方 DELETE 清单逐张对齐**（对抗审 F1/F2/F7 收口）：
        //   初版快照三份（issue/timeline/attachments）、DELETE 三张（dev_assignees/attachments/timeline），
        //   两份清单**互不相同且都不完整** —— dev_assignees 删了没快照、dev_commits/dev_events 既没删也没快照。
        //   带 issue_id 的子表实为 **6 张**（timeline / attachments / dev_assignees / dev_commits /
        //   dev_events / release_commit_snapshots）。加表的人只往 SYS_REQUIRED_TABLES 和 readiness 里加，
        //   没人回头看"删除端点是不是也要跟着删"——这就是"两份清单必然漂移"在级联场景的实例。
        //   ⛔ **以后再加带 issue_id 的表，必须同时改这里的快照读、下方的 DELETE、以及 verify 的六表残留断言。**
        const timelineRows = await dbAllAsync(
          `SELECT * FROM sys_issue_timeline WHERE issue_id = ? ORDER BY id`, [id]);
        const devAssigneeRows = await dbAllAsync(
          `SELECT * FROM sys_issue_dev_assignees WHERE issue_id = ? ORDER BY id`, [id]);
        const devCommitRows = await dbAllAsync(
          `SELECT * FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id`, [id]);
        const devEventRows = await dbAllAsync(
          `SELECT * FROM sys_issue_dev_events WHERE issue_id = ? ORDER BY id`, [id]);
        //   release_commit_snapshots：守卫②（已挂批次拒删）使它在正常路径下**恒为空**——
        //   有快照 ⟹ 曾发布过 ⟹ release_id 非空 ⟹ 上面就被 409 拦了。仍然读+删+快照，
        //   理由是"靠另一个守卫保证为空"是**跨条件的间接论证**，一旦守卫②口径变化（例如将来允许删已发布单）
        //   这里会静默留孤儿。显式处理的成本是两行，不值得省。
        const releaseSnapshotRows = await dbAllAsync(
          `SELECT * FROM sys_issue_release_commit_snapshots WHERE issue_id = ? ORDER BY id`, [id]);

        // 审计行先落库：写失败 → 抛 → 外层 catch rollback → 业务行一条不删（"删了但没记"被结构性排除）。
        await dbRunAsync(
          `INSERT INTO sys_issue_delete_audit
             (issue_id, issue_type, issue_status, issue_title, issue_created_by, issue_created_at,
              attachment_count, timeline_count, dev_assignee_count, dev_commit_count, dev_event_count,
              release_snapshot_count,
              issue_json, timeline_json, attachments_json,
              dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
              operator_id, operator_name, reason, deleted_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'))`,
          [id, row.type, row.status, row.title, row.created_by, row.created_at,
           atts.length, timelineRows.length, devAssigneeRows.length, devCommitRows.length,
           devEventRows.length, releaseSnapshotRows.length,
           JSON.stringify(row), JSON.stringify(timelineRows), JSON.stringify(atts),
           JSON.stringify(devAssigneeRows), JSON.stringify(devCommitRows),
           JSON.stringify(devEventRows), JSON.stringify(releaseSnapshotRows),
           actor.id, actor.name, reason]);

        // 删**全部六张** issue_id 子表，再删主表。
        //   ⚠️ **顺序按依赖从叶子到根**（收口审 MED）：`dev_commits`/`dev_events` 通过 `dev_assignee_id`
        //   引用 `dev_assignees`，故先删前两者。当前 `PRAGMA foreign_keys` 未开启，顺序不影响执行；
        //   但一旦将来开启，反过来的顺序会直接违反外键约束 —— 让顺序与真实依赖一致是零成本的未来兼容。
        //   ⚠️ 原注释写的是"先删三张子表"——那是 2026-07-07 的化石，C0（多开发协作与 commit 留痕重构）
        //   新增 dev_commits/dev_events/release_commit_snapshots 三张带 issue_id 的表时没回头补这里，
        //   于是 commit 留痕与开发侧事件审计链在物删后成为**永久孤儿**（sys_issues 是 AUTOINCREMENT，
        //   id 不复用，故不会张冠李戴，但"零残留"这个承诺一直是假的）。对抗审 F7 抓出。
        await dbRunAsync('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id]);            // 叶：引用 dev_assignees.id
        await dbRunAsync('DELETE FROM sys_issue_dev_events WHERE issue_id = ?', [id]);            // 叶：引用 dev_assignees.id
        await dbRunAsync('DELETE FROM sys_issue_release_commit_snapshots WHERE issue_id = ?', [id]);
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
        //   ⭐ 对抗审 F5 收口：物删是**不可逆**动作，其事务异常与普通端点不同级 ——
        //   若异常发生在"部分 DELETE 已被 autocommit 提交"之后（跨模块事务纠缠场景，见上方不变量①），
        //   业务行可能已经没了、而审计行被回滚掉，DB 内不留任何线索。
        //   这条 CRITICAL 日志是那种情况下**唯一的人工补审计入口**：带单据摘要与操作者，
        //   使运维能据此重建"谁在什么时候试图删了什么"。正常回滚路径也会打——宁可多打。
        logger.error(`[系统迭代][CRITICAL] 物理删除事务异常 #${id} —— 若业务行已消失而审计表无对应行，` +
          `请据本条人工补审计：operator=${actor.id}/${actor.name}·reason=${reason.replace(/[\r\n\t]+/g, ' ').slice(0, 120)}·` +
          `title=${String(titleForLog).slice(0, 80)}·err=${(txErr && txErr.message) || txErr}`);
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
      //   C2a：应用日志保留（便于运维时序排查），但**它不再是唯一留痕**——权威留证在 sys_issue_delete_audit
      //   （可查询、不轮转、含快照与 reason）。日志带上 reason 便于 grep 时一眼看清动机。
      //   ⚠️ reason 是管理员自由输入，进日志前**单行化 + 截断**（codex C2a 审 LOW）：换行会把一条日志
      //   撕成多行、破坏按行 grep，也让日志可被输入内容"伪造成多条记录"。审计表存完整原文，日志只求可读。
      const reasonForLog = reason.replace(/[\r\n\t]+/g, ' ').slice(0, 120);
      logger.info(`用户 ${req.user.username} 物理删除迭代单 #${id}（${titleForLog}）+ ${atts.length} 个附件${fileDelFailed ? `（其中 ${fileDelFailed} 个文件未删除，见 warn）` : ''}·原因：${reasonForLog}`);
      return res.json({ ok: true, id });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // SYS_BUSY 等保 503
      logger.error('[系统迭代] 物理删除失败:', err && err.message);
      return res.status(500).json({ error: (err && err.message) || '删除失败' });
    }
  });

  // ── GET /sys-issue-delete-audit：物删审计查询入口（角色权限重构 C4·F9，172 号对抗审）─────────────
  //   背景：C2a 建了 sys_issue_delete_audit（删前整行+子表快照+reason），但对抗审 172 号指出它**零查询面**——
  //   写进去后没有任何入口能看，等于没有。用户拍板口径三条：仅 admin 可查；展示层手机号脱敏（中间四位星号）；
  //   库内快照原文不动（脱敏只发生在响应序列化时，不改 DB）。
  //   本端点只读——列表版只投影摘要列（不含 issue_json 等大 JSON 字段，避免列表页面被单条记录的完整快照拖垮）；
  //   详情版按 id 单条取全部列。两者共用同一份 requireAdmin（复用既有中间件，不新造）+ 同一份
  //   serializeAuditRow（脱敏字段清单单一来源）。
  //   ⚠️ 中间件顺序（codex C4 审 Round-1 收口·LOW）：authenticateToken → requireAdmin → requireSysSchemaReady——
  //   非 admin 必须恒 403，不能因为 schema 未就绪就先 503（那会向未授权用户泄露"表结构是否就绪"这个内部状态）。
  //   ⚠️ 分页改游标（codex C4 审 Round-1 收口·MED）：**追加型表**（只 INSERT 不 UPDATE，本表刻意不进任何
  //   级联/更新路径，见建表注释）用 offset 翻页存在经典缺陷——翻页期间若有新行插入（本表恰恰是持续增长的，
  //   随时可能有新的物删发生），后续页会因为"前面多插了几行"而重复看到本该在上一页出现过的行，或跳过
  //   本该出现的行。改用 id 游标（audit id 是 AUTOINCREMENT，单调递增，与 id DESC 排序天然一致）：
  //   `WHERE id < ?`（无 before_id 则不加此条件，从最新一条开始）+ 可选 `issue_id = ?` 过滤，
  //   `ORDER BY id DESC LIMIT ?`。翻页把上一页最后一条的 id 作为下一页的 before_id，不重不漏。
  //   ⚠️ issue_id 过滤当前无索引（codex C4 审 Round-1）：物删属低频操作、本表体量小，全表扫描可接受；
  //   若未来审计行数量级上升，再补 `idx_sys_delete_audit_issue`（已有，见建表段——其实已经有索引，
  //   这里指的是"按 issue_id 过滤 + id 排序"这个组合暂无复合索引，单列索引对小表足够）。
  router.get('/sys-issue-delete-audit', authenticateToken, requireAdmin, requireSysSchemaReady, async (req, res) => {
    const q = req.query || {};
    const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;
    // ⭐ codex C4 审 Round-1 收口（MED）：limit 解析改严格——整串十进制正整数正则校验，不满足就落回默认值。
    //   ⚠️ 宽松兜底是刻意选择：本端点是只读查询，传了个奇怪的 limit（'abc'/'-5'/'5.5'/'0'）没有必要 400，
    //   直接按默认分页大小服务更符合"只读查询容错优先"的取向；issue_id/before_id 则相反（见下方），
    //   因为那两个是"精确过滤/翻页游标"，语义歧义会导致查错单或翻页错位，值得用 400 显式拒绝。
    const LIMIT_RE = /^[1-9]\d*$/;
    let limit = DEFAULT_LIMIT;
    if (typeof q.limit === 'string' && LIMIT_RE.test(q.limit)) {
      limit = Math.min(Number(q.limit), MAX_LIMIT);
    }
    // ⭐ codex C4 审 Round-2 收口（LOW，184 号预审 PL-1 收口后改调共享 parseStrictPositiveId）：
    //   before_id 与 issue_id 都是"精确过滤/翻页游标"语义（值歧义会导致查错单或翻页错位），统一走比
    //   parsePositiveId 更严的正则+isSafeInteger 双重校验，不再各写一份（见 parseStrictPositiveId 定义处）。
    let beforeId = null;
    if (q.before_id !== undefined && q.before_id !== '') {
      beforeId = parseStrictPositiveId(q.before_id);
      if (!beforeId) return res.status(400).json({ error: 'before_id 须为正整数', code: 'INVALID_BEFORE_ID' });
    }
    const whereParts = [];
    const params = [];
    if (beforeId) { whereParts.push('id < ?'); params.push(beforeId); }
    if (q.issue_id !== undefined && q.issue_id !== '') {
      const issueIdFilter = parseStrictPositiveId(q.issue_id);
      if (!issueIdFilter) return res.status(400).json({ error: 'issue_id 须为正整数', code: 'INVALID_ISSUE_ID_FILTER' });
      whereParts.push('issue_id = ?'); params.push(issueIdFilter);
    }
    const where = whereParts.length ? ('WHERE ' + whereParts.join(' AND ')) : '';
    try {
      const rows = await dbAllAsync(
        `SELECT id, issue_id, issue_type, issue_status, issue_title, operator_id, operator_name, reason, deleted_at
           FROM sys_issue_delete_audit ${where}
          ORDER BY id DESC
          LIMIT ?`,
        [...params, limit]
      );
      const items = rows.map(r => serializeAuditRow(r, { withSnapshots: false }));
      // next_before_id：本页恰好取满 limit 条时才给出（= 本页最后一条 id，下一页请求带上它）——
      // 不满 limit 说明已经到底（含空表），此时为 null，前端据此隐藏「加载更多」。
      const nextBeforeId = (rows.length === limit && rows.length > 0) ? rows[rows.length - 1].id : null;
      res.json({ items, limit, next_before_id: nextBeforeId });
    } catch (err) {
      logger.error('[系统迭代] 查询删除审计列表失败:', err && err.message);
      res.status(500).json({ error: '查询删除审计列表失败' });
    }
  });

  // ── GET /sys-issue-delete-audit/:auditId：物删审计详情（角色权限重构 C4·F9）───────────────────
  //   含完整快照 JSON（issue_json/timeline_json/attachments_json/dev_assignees_json/dev_commits_json/
  //   dev_events_json/release_snapshots_json）——这些字段体积可能较大，故只在详情端点返回，不进列表。
  //   展示层脱敏统一走 serializeAuditRow（withSnapshots:true）——覆盖 issue_title/operator_name/reason
  //   三个自由文本摘要字段 + 全部七个快照 JSON（结构化脱敏，见 maskJsonSnapshotText）。
  router.get('/sys-issue-delete-audit/:auditId', authenticateToken, requireAdmin, requireSysSchemaReady, async (req, res) => {
    const auditId = parsePositiveId(req.params.auditId);
    if (!auditId) return res.status(400).json({ error: '无效的审计记录 ID', code: 'INVALID_AUDIT_ID' });
    try {
      const row = await dbGetAsync('SELECT * FROM sys_issue_delete_audit WHERE id = ?', [auditId]);
      if (!row) return res.status(404).json({ error: '审计记录不存在', code: 'AUDIT_NOT_FOUND' });
      res.json(serializeAuditRow(row, { withSnapshots: true }));
    } catch (err) {
      logger.error('[系统迭代] 查询删除审计详情失败:', err && err.message);
      res.status(500).json({ error: '查询删除审计详情失败' });
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
      // ⭐ [C7-C9 收口批 M1·裁定=不适用优先] dev_estimated_at 这里**只解析、不报错**——格式错的 return 已
      //   下沉到事务内、适用面闸与封口 409 之后（见下方 [C7-C9 收口批 M1] 标记处）。这是 C7-fix2 M1 那个病
      //   的**另一半**：当时只把 estimated_effort_days 的格式错挪了下去，dev_estimated_at 仍留在事务外最
      //   前面，于是「bug 单 / nf=1 单传了工期，同时日期也写错了」先拿到 INVALID_ESTIMATE（"日期格式不对"），
      //   把日期改对再试一次才撞上真正的 EFFORT_NOT_APPLICABLE——调用方照样要绕一圈才走到真相，正是
      //   C7-fix2 要消灭的那种引导。/feasibility 已由 C8-fix Q1 做端点级整体重排，本项是**本 workstream
      //   （C7 工时评估两端点三字段）里**最后一处对齐。
      //   ⚠️ [收口批预筛 MED-2 订正] 「最后一处」**不指全仓**——按同款模式（payload/格式码先于适用面或状态
      //     闸）全扫 router 写端点，另有三处同病未收口：/scope-change（:7947 一带·feature/improvement 恒
      //     不适用 409 SCOPE_CHANGE_DISABLED，但畸形 deadline 先报 400 INVALID_DEADLINE，实测）、
      //     /set-scheduled-start（:6957 一带·「待验证」态畸形日期先报 400 INVALID_SCHEDULED_START 后才
      //     409 状态闸，实测）、/hotfix-publish（:11215 一带·代码序同形，未实测）。三处各须自己的断言
      //     矩阵，属独立行为变更批，本批不动——已登记 backlog 排期，勿据本句「最后一处」认定全仓已收口。
      const est = normalizeSysDatetime((req.body || {}).dev_estimated_at);
      // S3（D3/D4）：est **带秒**用于入库；estMin **到分**用于一切比较与给人看的文本。
      //   两个变量显式分开，每个使用点自己选——不靠"字符串比较碰巧也对"这种巧合。
      //   ⚠️ 下面那道 500 守卫拦的是**内部不变量被破坏**（非用户输入错误——非法输入由上一行的 est 为空
      //     表达，两者语义不同不可合并）：estMin 非空依赖"校验器输出形态"这一跨函数隐含约定，一旦被改坏，
      //     null 会一路参与比较（`null < '2026-...'` 恒 true ⇒ 闸门失效）与文本拼接（留痕里出现 "null"），
      //     且一声不吭。
      //   ⚠️ [C7-C9 收口批 M1] 解析失败时这一行是**安全空转**：truncToMinute 首行即 `if (!dbDatetime) return null`，
      //     传 null 不抛异常。故"格式错"与"内部不变量"两道判定可以都下沉，且必须保持 est → estMin 的先后
      //     （est 为空时 estMin 必然也为空，若 500 那道先判就会把用户的格式错误报成服务端故障）。
      const estMin = truncToMinute(est);
      // [C7 工时评估补全·方案 v1.7 §9.1] 工期写点②：本端点承接 **nf=0 的 feature/improvement**（nf=1 的写点
      // 恒在 /feasibility，见下方封口）。这里只做**格式层归一**（纯格式，不依赖 row.type/needs_feasibility），
      // 归一结果留到事务内按适用面判定后才决定报不报错。
      // ⚠️ [C8-fix K1 注释订正] 本段原写「事务外先拦，避免为一个格式错误白开一次 IMMEDIATE 事务」——
      //   那是 C7 初版的写法，**已被 C7-fix2 M1 推翻**（见下方 ⭐ 块），与其下文自相矛盾。现状是：
      //   事务外只 parse 不 return，格式错的 return 在事务内、适用面闸之后。"少开一次事务"这个收益已被
      //   有意放弃，换的是错误码 precedence 正确。留此订正为记：注释是审查输入，实现改了注释必须同批改，
      //   否则下一个人会拿这句陈旧话去"修正"实现（[[feedback_comment_is_review_input]]）。
      // ⚠️ 错误码与 /feasibility 逐字同源：格式非法 → effortParse.code（= 'INVALID_EFFORT_DAYS'，由
      //   normalizeSysEffortDays 给），缺失 → 'EFFORT_REQUIRED'（下方事务内按 type/nf 判定后给）。
      //   'EFFORT_INVALID' 是**存量脏值**专用码（submit 闸/GATE 复查已落库值时用），不是输入格式码，
      //   两者语义不同不可混用（见 handleDevSubmit 内 EFFORT_INVALID 注释）。
      // ⭐ [C7-fix2 M1·裁定=不适用优先] 这里**只解析、不报错**——格式错的 return 已下沉到事务内、适用面闸
      //   之后（见下方 [C7-fix2 M1] 标记处）。原因是 precedence 排错了：C7 初版在事务外就把格式错抛出去，
      //   于是「bug 单 / nf=1 单传了个 1.3」拿到的是 `INVALID_EFFORT_DAYS`（"你这个数字格式不对"），可实际
      //   问题是**这个参数在这里根本不该出现**——照着格式码去改值（1.3 → 1.5）再试一次，只会撞上第二个
      //   错误码，等于让调用方绕一圈才走到真相。正确顺序是先回答"该不该传"，再回答"传得对不对"：
      //     ① 适用面闸（不适用 ∧ 传了 → EFFORT_NOT_APPLICABLE，**不看值的格式**）
      //     ② 封口 409（ESTIMATE_REQUIRES_FEASIBILITY）——nf=1 且工期按三态判据算"未提供"时才走到这里，
      //        真传了工期的 nf=1 单已被 ① 拦下（[4d]/[4e] 两组分别钉死这两条）
      //     ③ 适用单据才报格式错——两项，相对序 = **先日期后工期**：
      //          ③-a dev_estimated_at → 400 INVALID_ESTIMATE / 500 ESTIMATE_NORMALIZE_INTERNAL
      //               （[C7-C9 收口批 M1] 本批下沉；重排前它在事务外最前面，本就先于工期，故此序即"逐字不变"）
      //          ③-b estimated_effort_days → 400 INVALID_EFFORT_DAYS
      //     ④ 必填闸（EFFORT_REQUIRED）
      //   ⭐⭐ [C7-fix3 H·第三次重排后的完整序] 上面 ①-④ 描述的是"业务判定之间"的先后，它们**整体**又被
      //     排在了两道更前置的闸之后（见事务内 assertDevMember 处的 ⭐⭐⭐ 块）：
      //       Ⅰ 404 SYS_ISSUE_NOT_FOUND / assertKnownIssueStatus（记录存在性 + 数据完整性自检）
      //       Ⅱ **assertDevMember → 403 NOT_ROSTERED**（在册鉴权·C7-fix3 前移到此）
      //       Ⅲ 状态闸 ESTIMATE_STATUS_INVALID
      //       Ⅳ 上面的 ①→②→③-a→③-b→④
      //     即：先答"你有没有资格碰这单"，再答"这单现在能不能做这动作"，最后才答"你传得对不对"。
      //     与 /feasibility 的 C8-fix2 序同构（两端点自此对齐，不再各说各话）。
      //   ⚠️ 对**适用单据**（nf=0 的 feature/improvement）而言，本次重排后的可观测行为与 C7 逐字相同：
      //     格式错仍是 400 INVALID_EFFORT_DAYS、缺失仍是 400 EFFORT_REQUIRED，只是判定挪进了事务内。
      //     代价=为一个格式错多开一次 IMMEDIATE 事务（原注释拿这个当事务外拦截的理由）——该代价换的是
      //     错误码正确，且这条路径本就要开事务做 row 查询，多出的只是"格式错这一种情形也会开一次"。
      //   （314-M1 裁定；P2 已追认·用户 2026-08-08 拍板维持 400+不适用优先）
      const effortParse = normalizeSysEffortDays((req.body || {}).estimated_effort_days);
      const effortValue = effortParse.ok ? effortParse.value : null;   // 解析失败时值不可用，占位 null（真正的报错在事务内）
      // "调用方到底传没传这个字段"与"传了但归一成 null"必须分开：前者用于下方**适用面闸**（不适用的单
      // 传了就拒），后者用于必填判定。normalizeSysEffortDays 把 undefined/null/'' 都归成 value:null，
      // 单看 effortValue 分不出"没传"和"传了空串"，故这里独立记一份原始存在性。
      // ⭐ [C7-fix MED-1·裁定=对齐三态] 判据与 case 'intake_accept' 里的 riskProvided **同源同形**
      //   （`riskRaw !== undefined && !== null && !== ''`，见 284 号 L-1 固化注释）：显式传 `null`／空串
      //   一律按「未提供」处理，而不是按「传了个不该传的值」拒绝。理由沿用 284-L1 原话——API 调用方显式
      //   传 null 的意图约等于"未传"，前端表单在字段不适用时也常留空串；把这两种当成"违规传值"去 400，
      //   拦的是意图正确的调用方。C7 初版只判 `!== undefined`，与同仓 risk_level 的三态口径分岔了，本次对齐。
      //   （P1 已追认·用户 2026-08-08 拍板三态判据）
      // ⭐ [C8-fix Q2/L2·315 表态=保持不 trim] 这里**刻意不 trim**，两条判据分工必须钉死，别当成疏漏：
      //   · `effortProvided` 回答的是「**调用方有没有显式提交这个字段**」——纯空白串 `'   '` 算**提交了**
      //     （用户在输入框敲了空格再提交，是一次真实的提交动作）。判据与 case 'intake_accept' 的
      //     riskProvided **逐字同源**（`!== undefined && !== null && !== ''`，284-L1 固化），两个字段在
      //     "什么算提供"这件事上必须同一把尺子，否则同一份表单的两个字段行为分岔。
      //   · 「**值是不是缺失**」是另一个问题，由 normalizeSysEffortDays 归一判定——它内部对纯空白
      //     `raw.trim() === ''` 返回 `{ok:true, value:null}`，于是纯空白最终落 EFFORT_REQUIRED
      //     （verify-sys-effort-c7 [2b] 已钉死）。两条判据串起来的净效果是对的：纯空白 = 提交了但没填。
      //   ⚠️ 若未来要改成 trim（即"纯空白视同未提交"），**必须 effort + risk_level 同批动**——只改一个
      //     会让 [H-4②''] 那组（intake-gate:647，纯空白判 RISK_LEVEL_INVALID 非 REQUIRED）与本端点分岔，
      //     且该改动会推翻已追认的 P1 三态口径（用户 2026-08-08 拍板），须重新提请拍板。这不是"以后想改
      //     再说"，是改的时候有个成对约束不能忘。
      const effortRaw = (req.body || {}).estimated_effort_days;
      const effortProvided = effortRaw !== undefined && effortRaw !== null && effortRaw !== '';
      // 事务内赋值、事务外（成功响应）读取——故必须提到事务 try 之外声明。初值 false 是 fail-safe 方向：
      // 万一将来有人加了一条在赋值之前就 return 的路径，响应里最多是"少带一个键"，不会误报工期。
      let effortApplicable = false;
      const actor = sysActor(req);
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_at, needs_feasibility, dev_estimated_at, estimated_effort_days, gate_deferred_at FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // ⭐⭐⭐ [C7-fix3 H·防探知收口·**本端点第三次重排**·codex 316-R 表态三] assertDevMember 前移到状态闸之前。
        //   ── 前两次重排都只动"业务判定之间"的先后：C7-fix2 M1 把工期格式错沉到适用面闸之后，
        //      C7-C9 收口批 M1 把日期格式错一并沉下去。两次都没碰鉴权的位置，于是留下与 /feasibility
        //      **同款**的侧漏：非在册的登录用户拿错误码当探针，同一个 id 就能问出单据处在什么状态——
        //        · 状态不在 W06 白名单 → 409 ESTIMATE_STATUS_INVALID，**错误文案里还带着状态名**
        //          （`当前状态「${row.status}」不可回填预计`），等于直接把状态字符串念给未授权者听；
        //        · 状态在白名单 → 才继续往下走，最终撞 403 NOT_ROSTERED。
        //      两种回答一对比，"这单现在是不是开发中"就暴露了；配合适用面闸/封口/格式三层，还能再问出
        //      type 与 needs_feasibility。
        //   ── 本次重排后的序（与 /feasibility 的 C8-fix2 序**同构**，两端点自此对齐）：
        //        ① 404 SYS_ISSUE_NOT_FOUND / assertKnownIssueStatus —— 记录存在性 + 内部数据完整性自检
        //        ② **assertDevMember（403 NOT_ROSTERED）** —— 在册鉴权，本行
        //        ③ 状态闸 ESTIMATE_STATUS_INVALID → 适用面闸 → 封口 409 → 格式（日期→工期）→ 必填闸
        //           （③ 内部相对序**逐字未动**，本次只前移 assertDevMember 一件，变化面最小）
        //   ── 可观测行为变化面（精确边界·[316-R2] 范围限定：以下「一律」以"单据存在且通过
        //      assertKnownIssueStatus 完整性自检"为前提——404 与状态完整性异常仍在鉴权前，属既定资源策略）：
        //        · **非在册用户**：对已存在的合法单据，无论其状态/类型/nf、payload 怎么传，一律 403 NOT_ROSTERED。
        //        · **在册成员**：状态闸及其后全部判定的相对序与重排前逐字相同——[4e]/[4f] 等既有断言的
        //          发起者都是在册 dev，故其预期一个都不用改（跑全组即为实证）。
        //   ⚠️ codex 316-R 表态三原文=「不接受仅登记」：C8-fix2 时把本端点的同款侧漏登记为"待 316-R 表态后
        //     单独处置"，表态结论是必须真修而非留档，本批即执行该表态。两端点自此不再有口径分岔。
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        // estimate 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单，替代旧 T.findTransition 借用）
        if (!SF.isW06Allowed('estimate', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可回填预计`, code: 'ESTIMATE_STATUS_INVALID' });
        }
        // [C7 工时评估补全·方案 v1.7 §9.1] 工期参数**适用面闸**（先于封口 409）：本端点只对 nf=0 的
        // feature/improvement 接受 estimated_effort_days。其余情形一律"传值即拒"400，不开旁路——
        //   · bug/config：这两类单据本就没有工期维度（同 case 'intake_accept' 里 risk_level "bug 恒 NULL、
        //     传值即拒绝"的对称处理形态），静默忽略会让调用方以为写进去了；
        //   · nf=1 的 feature/improvement：工期是评估表单的一部分，唯一写点在 /feasibility。若这里悄悄
        //     受理，主表 estimated_effort_days 就能绕开评估被单独改掉，与 feasibility timeline 快照脱钩
        //     ——正是下方 ESTIMATE_REQUIRES_FEASIBILITY 封口要防的那件事在工期字段上的翻版。
        // 刻意置于封口 409 **之前**：封口只在"没传工期"时保持原样 409（既有行为逐字不变），一旦真传了
        // 工期参数，报"这个参数在这里不被接受"比报"这单要先填评估"更贴近调用方的实际错误。两条闸都在
        // assertDevMember 之后，不存在向未授权者泄露单据属性的问题。
        // ⭐ [C7-fix MED-2·裁定=维持 400，此处登记取舍] 为何本码用 **400** 而同族的 FEASIBILITY_NOT_APPLICABLE /
        //   RISK_LEVEL_NOT_APPLICABLE 用 **409**？判据是"错在请求的哪一层"：
        //     · 400 = **payload 参数不适用**——调用方多带了一个本端点不收的字段。这跟单据当前处于什么状态
        //       无关（该单是 nf=1 也好、是 bug 也好，都是"这个参数在这里不该出现"），改单据状态也救不了它，
        //       只能改请求体 ⇒ 客户端请求本身有问题 ⇒ 400。
        //     · 409 = **资源前置条件不满足**——动作本身合法、参数也对，只是单据当前状态不允许（如"该单未
        //       要求可行性评估"）。改单据状态就能成功 ⇒ 冲突 ⇒ 409。
        //   ⚠️ 方案 v1.7 §9.1 原话「400 + 与封口同构」**自相矛盾**：封口（ESTIMATE_REQUIRES_FEASIBILITY）
        //     是 409，"与封口同构"就该是 409，与前半句的 400 打架。本实现取其前半句 400，是**有意取舍**
        //     而非漏读——理由即上面那条分层判据（这确实是 payload 层的错）。**P2 已追认（用户 2026-08-08
        //     拍板：维持 400+不适用优先），方案 §9.1 该段已同步订正注记**，后人不得拿"§9.1 说要与封口
        //     同构"来推翻这里。
        if (effortProvided && !(['feature', 'improvement'].includes(row.type) && row.needs_feasibility === 0)) {
          await sysRollback();
          return res.status(400).json({
            error: ['feature', 'improvement'].includes(row.type)
              ? '该单需在可行性评估中填写工期（人日），本表单不接受工期参数'
              // [C7-fix LOW-3②·收口批预筛 LOW-4 订正] 本分支 **bug 单当前就走得到**（[4f-①] 断言的正是这句
              //   文案）——原注释首句「本分支当前不可达」系措辞错误，把「config **情形**不可达」写成了整个
              //   分支不可达，与实测矛盾。不可达的只是 config：config 流的状态机从未定义（无
              //   CONFIG_FLOW_TRANSITIONS），config 单进不到 W06 估时态，isW06Allowed 会先 409
              //   ESTIMATE_STATUS_INVALID 拦下。文案写"该类型单据"而非"bug 单"是为了将来真开 config 流时
              //   不必回来改字；留着 config 容错的成本近乎零，删了反而要重新论证。
              : '该类型单据无工期（人日）字段',
            code: 'EFFORT_NOT_APPLICABLE',
          });
        }
        // estimate 封口（codex 17 M-6 / 开放②）：needs_feasibility=1 且 feature/improvement → 预计完成只能在 /feasibility 写，
        //   防绕过评估口径 + 防主表 dev_estimated_at 与 feasibility timeline 快照不一致。needs_feasibility=0 仍走 estimate。
        if (['feature', 'improvement'].includes(row.type) && row.needs_feasibility === 1) {
          await sysRollback();
          return res.status(409).json({ error: '该单需先填可行性评估（预计完成在评估表单内一并提交）', code: 'ESTIMATE_REQUIRES_FEASIBILITY' });
        }
        // ⭐ [C7-C9 收口批 M1] dev_estimated_at **格式**错 + estMin 内部不变量两道守卫的报错点（原在事务外
        //   :7308/:7315 一带，现下沉至此）。位置刻意夹在「适用面闸 + 封口 409」之后、工期格式错之前：
        //     · 之后 —— 本批要修的就是「不适用优先」，日期格式错不该抢在 EFFORT_NOT_APPLICABLE 前面；
        //     · 之前 —— 保**适用单据**（nf=0 的 feature/improvement）的相对序逐字不变：日期格式错重排前
        //       在事务外最前面、本就先于工期格式错，挪进来后这条先后关系必须原样保住（verify-sys-effort-c7
        //       [4f-③] 正向对照钉死：适用单据 + 畸形日期 + 畸形工期 → 仍是 INVALID_ESTIMATE）。
        //   ⚠️ [收口批预筛 MED-1 订正] 本次重排改变的可观测行为=**不适用单据＋下条登记的四类前置闸情形**
        //     （后者**含适用单据**：nf=0 单在「待验证」态传畸形日期，旧版 400 INVALID_ESTIMATE → 现
        //     409 ESTIMATE_STATUS_INVALID；非在册开发＋畸形日期 → 403 NOT_ROSTERED，均探针实证）。核心例：
        //     bug/nf=1 单传了工期又写错日期，现在拿到的是 EFFORT_NOT_APPLICABLE（真问题）而不是
        //     INVALID_ESTIMATE（假线索）。故「适用单据行为逐字不变」的准确表述是：适用单据**通过前置四闸
        //     之后**的行为逐字不变（[4f-③] 钉的正是这个收窄后的声称）。
        //   ⚠️ 边缘行为登记（与 /feasibility 的同款登记对齐，如实记不掩盖）：404 SYS_ISSUE_NOT_FOUND、
        //     assertKnownIssueStatus、assertDevMember、ESTIMATE_STATUS_INVALID 现在**全部先于**日期格式校验
        //     ——单据不存在 / 非在册开发 / 状态不对时，畸形日期不再有机会报出来。这与 C7-fix2 为工期字段
        //     已经接受的是同一笔账（授权与资源类问题优先于负载格式问题报出，也不向未授权者泄露单据属性）。
        //     ⭐ [C7-fix3 H] 这一串的**内部顺序本批已变**：assertDevMember 从 ESTIMATE_STATUS_INVALID 之后
        //       前移到它之前（上面两项不动）。对"日期格式错还报不报得出来"没有影响（四者都在它前面），
        //       但对**非在册者拿到哪个码**影响是本质的：原先状态不对先报 409（连状态名都在文案里），
        //       现在恒 403 NOT_ROSTERED。
        if (!est) {
          await sysRollback();
          return res.status(400).json({ error: '预计完成时间格式非法（YYYY-MM-DD HH:MM）', code: 'INVALID_ESTIMATE' });
        }
        // [收口批预筛 LOW-1 登记] 本 500 当前**结构性不可达**（纯防御性，故无测试覆盖）：normalizeSysDatetime
        //   成功时恒返带秒的规整格式，truncToMinute 的正则对其恒匹配 ⇒ est 真值时 estMin 必真值（七向量
        //   探针实测无一命中）。保留理由同 :7316 一带——拦的是「校验器输出形态」这一跨函数约定将来被改坏。
        if (!estMin) {
          await sysRollback();
          return res.status(500).json({ error: '时间规范化内部错误（estMin 为空）', code: 'ESTIMATE_NORMALIZE_INTERNAL' });
        }
        // ⭐ [C7-fix2 M1] 工期**格式**错的报错点（原在事务外 :7070 一带，现下沉至此）。走到这一行时
        //   `!effortParse.ok` 蕴含"本单是适用单据"，无需再判类型/nf——推理链：解析失败只可能发生在传了个
        //   非空的真值上（undefined/null/'' 都被 normalizeSysEffortDays 归成 ok:true+value:null），故
        //   `!ok ⟹ effortProvided`；而 effortProvided 的不适用组合已被上方适用面闸整个 return 掉，
        //   剩下的必然是 nf=0 的 feature/improvement。断言化这条推理没必要（多一道恒真检查反成噪音），
        //   但推理本身要写下来，否则后人会以为这里漏了类型判据。
        //   对适用单据而言错误码与位置语义均与 C7 一致：400 + INVALID_EFFORT_DAYS + effortParse.error 原文。
        if (!effortParse.ok) {
          await sysRollback();
          return res.status(400).json({ error: effortParse.error, code: effortParse.code });
        }
        // [C7 工时评估补全] 工期必填判定（走到这里必然是 nf=0；两类型同构，与 /feasibility 的
        // `['feature','improvement'] ∧ effortValue===null → EFFORT_REQUIRED` 逐条同形）。
        // 位置在状态/权限（assertDevMember）/封口三道闸之后——同 /feasibility 的取舍理由：授权与状态类
        // 问题应优先于"表单填完整没"报出，防未在册/态不对的调用者从错误码里探知"只要把工期填上就行"。
        if (['feature', 'improvement'].includes(row.type) && effortValue === null) {
          await sysRollback();
          return res.status(400).json({ error: '请填写工期（人日）', code: 'EFFORT_REQUIRED' });
        }
        // assigned_at 缺失保护（codex 15b L-1）：进开发态正常应有 assigned_at（electRepresentative 首次形成 roster 时写，
        //   §3.6 M2）；import/人工修库可能造出"开发中但 assigned_at 空"的脏单，缺失则拒（防绕过 >=assigned_at 闸门）。
        const assignedMin = truncToMinute(row.assigned_at);
        if (!assignedMin) {
          await sysRollback(); return res.status(409).json({ error: '该单缺少指派时间（数据异常），无法回填预计完成', code: 'ASSIGNED_AT_MISSING' });
        }
        // >=assigned_at 校验（§7）：assigned_at 带秒（DB datetime），截到分钟比较（同分钟视为不早于，codex 15 M-2）。
        //   ⚠️ S3 起 est **带秒**（D4），故这里比较必须用 estMin ——两边都是 'YYYY-MM-DD HH:MM' 时
        //     字符串比较才等价于时间先后比较。直接拿带秒的 est 比也"碰巧"对（前 16 字符相同时较长者更大
        //     ＝同分钟视为不早于），但那是靠字符串长度的巧合，不是靠语义；换个字段就不成立了。
        if (estMin < assignedMin) {
          await sysRollback(); return res.status(400).json({ error: '预计完成时间不能早于指派时间', code: 'ESTIMATE_BEFORE_ASSIGN' });
        }
        // ⭐ [并发乐观锁·expected_dev_estimated_at] 可选字段：调用方声明"打开弹窗时看到的现值"，用于探测
        //   "我读之后、我写之前，这行是否已被另一个在册开发覆盖"——两个在册开发先后填写时，当前乐观锁只绑
        //   status（本行下方 UPDATE 的 WHERE），同状态内二次填写测不出，后填的会直接覆盖先填的且无感知。
        //   与 /reassign 端点的 expected_member_ids 同一手法（见 :4504 一带原注释）：键不存在（undefined）→
        //   整段跳过，旧前端零行为变化；键存在必须是 string 或 null（打开弹窗时若现值为空即传 null）。
        //   ⭐ 位置刻意放在**既有状态/格式/必填闸之后、同值 no-op 判定之前**——并发真相优先于"值有没有变"：
        //   若判定顺序反过来，"expected 已过期但恰好与最新库值同值"这类巧合会被下方 no-op 短路掉，看似无害
        //   实则掩盖了一次真实的并发覆盖（no-op 分支不写库不留痕，谁覆盖了谁无从查起）。
        //   错误码 ESTIMATE_STALE 为本批新增（命名与既有 REASSIGN_STALE 同构·estimate/feasibility 两端点共用同一码）。
        const rawExpectedEstimate = (req.body || {}).expected_dev_estimated_at;
        if (rawExpectedEstimate !== undefined) {
          if (rawExpectedEstimate !== null && typeof rawExpectedEstimate !== 'string') {
            await sysRollback();
            return res.status(400).json({ error: 'expected_dev_estimated_at 须为字符串或 null（可选，并发乐观锁）', code: 'VALIDATION' });
          }
          // 字节级严格等值：expected 就是详情 GET 的原文回传，不做分钟归一（同 reassign 集合乐观锁精确相等口径）。
          //   [codex 327 M-1 口径固化] 本字段语义=**不透明版本值**（opaque version token），契约是「原样回传
          //   详情 GET 的 dev_estimated_at」，不是「等价时间比较」——调用方自行构造同一时刻的不同字符串形态
          //   （补秒/T/时区等）会得到 ESTIMATE_STALE，属约定内行为（前端是唯一调用方且照约定接线，见 F6）。
          const curDevEstimatedAt = (row.dev_estimated_at === undefined || row.dev_estimated_at === null) ? null : row.dev_estimated_at;
          if (rawExpectedEstimate !== curDevEstimatedAt) {
            await sysRollback();
            return res.status(409).json({ error: '预计完成时间已被他人更新，请刷新后重试', code: 'ESTIMATE_STALE' });
          }
        }
        // §7 M-3 同分钟归一化 unchanged 零写入（复用 collab v1.90.0 范式，ultracode 审 #6）：
        //   新预计 == 现存（截分钟）→ 不写不留 timeline，且后续不触发需求方通知（避免同值重复回填重复推送业务方）。
        const curEstMin = truncToMinute(row.dev_estimated_at);
        // ⭐ S3 必修：est 补秒后与 curEstMin（无秒）**永不相等**，同值 no-op 会整个失效 ⇒ 每次提交同值都
        //   写库 + 写 timeline + **重复推送业务方钉钉通知**，正是上面这段注释要防的事。两边都归到分再比。
        //   （[[feedback_write_read_same_semantic]]：改写端的格式一变，读端的比较口径必须跟着看一遍。）
        // [C7 工时评估补全] ⚠️ 同值 no-op 必须**两个字段都没变**才成立。本端点自 C7 起对适用类型是双字段
        //   写点，若沿用"只比预计完成时间"的旧条件，"时间不变、只改工期"这种真实改法会被短路成 unchanged
        //   直接 rollback——工期静默丢失，前端还收到成功提示。（[[feedback_write_read_same_semantic]]：写端
        //   多了一个字段，读端的"变没变"判据必须跟着扩，不能只看老字段。）
        //   ⚠️ 但这条扩展**只对适用类型生效**：bug/config 的 estimated_effort_days 本就不归本端点管，若把
        //   它们的存量脏值也算进"变了"，那类单据每次同值回填都会退化成"写库+写 timeline+重复推送需求方
        //   钉钉"——正是上面 §7 M-3 同值 no-op 要防的事。故先用 effortApplicable 划定作用域。
        //   适用类型内工期比较用归一后的数值（curEffort.value vs effortValue）而非裸列值：存量脏值（旧库
        //   ALTER 路径无 DDL CHECK）归一后 ok=false ⇒ 判定为"变了"走写入路径把脏值覆盖成合法值，自愈。
        effortApplicable = ['feature', 'improvement'].includes(row.type);
        const curEffort = normalizeSysEffortDays(row.estimated_effort_days);
        const effortUnchanged = !effortApplicable || (curEffort.ok && curEffort.value === effortValue);
        if (curEstMin && curEstMin === estMin && effortUnchanged) {
          await sysRollback();
          return res.json({ id, dev_estimated_at: est, ...(effortApplicable ? { estimated_effort_days: effortValue } : {}), unchanged: true });
        }
        // 旁路 UPDATE（不改 status）+ 乐观锁绑 status（W06：actor 未必是 assigned_to，去主次不再绑 assigned_to 条件）；
        //   ⭐ 上方 expected_dev_estimated_at 一致时才会走到这一行——两把锁互补：本行的 status 锁防"单据状态
        //   已被换"，上方的值锁防"**dev_estimated_at** 在同状态内被另一在册开发二次覆盖"（status 不变时本行的锁
        //   对此完全无感）。⚠️ 值锁只比对 dev_estimated_at 单字段——同一条 UPDATE 里的 estimated_effort_days 不在
        //   锁内（"日期不动只改工期"的并发覆盖不设防·残留缺口登记见任务锚点待追认 P1，Opus 预筛 MED-1 收窄）。
        // [C7] estimated_effort_days 并入**同一条 UPDATE** 原子落库（与 dev_estimated_at 同事务同语句，不新
        //   开独立写点）。SET 片段按 effortApplicable 条件拼接而非恒写：bug/config 走到这里 effortValue 恒为
        //   null（适用面闸已拒绝一切传值），若恒写就会把这类单据的存量列值抹成 NULL——虽然"bug 恒 NULL"是
        //   设计不变量、抹掉方向上没错，但那是**追溯改既有数据**，超出 C7 范围（禁区："已完结/在途后置态不
        //   追溯"）。不适用类型的 UPDATE 语句自此与 C7 前逐字相同，行为零变化。
        const effortSetFrag = effortApplicable ? 'estimated_effort_days = ?, ' : '';
        const effortSetParams = effortApplicable ? [effortValue] : [];
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET dev_estimated_at = ?, ${effortSetFrag}updated_at = datetime('now','localtime')
            WHERE id = ? AND status = ?`,
          [est, ...effortSetParams, id, row.status]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_ESTIMATE' }); }
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
           VALUES (?, 'estimate', ?, ?, ?)`,
          //   summary 用 estMin：时间轴上这条 summary 是**纯文本直出**、前端不过格式化件，
          //   写带秒的值进去，页面上就会冒出一条到秒的时间，直接违反 D3。（D4 管库里的字段，不管留痕文本。）
          [id, estMin, actor.id, actor.name]
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
      await dispatchSysNotify(id, 'notifyEstimateToCreatorAndRequester', actor.id);   // 仅发需求方侧；creator 侧本期 not_sent（M-4）；best-effort
      // [C7] 成功响应回带工期——与 unchanged 分支同形（都只对适用类型带该键），前端拿它做本地回显不必
      //   再拉一次详情。不适用类型的响应体与 C7 前逐字相同（不凭空多一个恒 null 的键）。
      res.json({ id, dev_estimated_at: est, ...(effortApplicable ? { estimated_effort_days: effortValue } : {}) });
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
  // ── C3 退场（方案 §6.7/§6.14/附录A）：POST /sys-issues/:id/set-release-flag 全类型 410 Gone ──────────
  //   本端点早于 C3 已对 bug 恒 409、对 feature/improvement 因 findTransition 恒返 null 而恒 409
  //   SET_RELEASE_FLAG_STATUS_INVALID——两类型都已是事实上的死端点，C3 明确收口为 410（而非继续
  //   409），语义更准确："资源曾经存在、现已永久移除"，与"业务前置条件不满足"的 409 区分开。
  router.post('/sys-issues/:id/set-release-flag', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.status(410).json({
      error: '该端点已下线（410 Gone）：发版信息填写流程已随上线体统一重构退场，无需再单独标记 needs_release',
      code: 'ENDPOINT_GONE',
    });
  });

  // [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] 工期字段归一化+校验：与 DDL CHECK 同口径（有限数、
  //   0<v≤365、0.5 整数倍）——错误码语义化（区别于裸 400），供 feasibility 端点消费。纯函数不抛异常，
  //   返回 { ok, value } 或 { ok:false, error, code }，与本文件 feasibility 端点其余校验一贯的直接
  //   res.status(400) 写法配合（不套 assertSysOaNumber 那种抛 SysTransitionError 的风格——那是给
  //   sysIssueTransition 引擎内部消费的，本端点是独立旁路事务，历来自己直接 return res）。
  //   raw 未填（undefined/null/''）→ value:null 合法（改进类选填/尚未评估）；由调用方按 type 决定是否必填。
  //   [codex 269 号 M-2 类型收紧]：裸用 `Number(raw)` 会把一整类"看起来不像数字却被 JS 隐式转换成合法
  //   数字"的输入静默放行——`Number(true)===1`、`Number([1])===1`（单元素数组走 toString 再转数字）、
  //   `Number('0x10')===16`（十六进制字面量）——这些类型压根不该被认作"填了工期"。改为：仅接受
  //   `typeof number` 或 trim 后**完全匹配纯十进制格式**（`^\d+(\.\d+)?$`，不含科学计数法/正负号/千分位）
  //   的字符串；其余类型（布尔/数组/对象等）一律拒绝。字符串 trim 后为空 → 视同未填（value:null，与前端
  //   "留空不传该字段"语义一致，不报错）。刻意不支持科学计数法（如 '5e-1'）——"人日"业务语义下从没有
  //   自然产生这种写法的场景，从严拒绝优先于兼容更多格式，缩小歧义面。
  function normalizeSysEffortDays(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
    let n;
    if (typeof raw === 'number') {
      n = raw;
    } else if (typeof raw === 'string') {
      const t = raw.trim();
      if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: '工期须为数字（人日）', code: 'INVALID_EFFORT_DAYS' };
      n = Number(t);
    } else {
      return { ok: false, error: '工期须为数字（人日）', code: 'INVALID_EFFORT_DAYS' };
    }
    if (!Number.isFinite(n)) return { ok: false, error: '工期须为数字（人日）', code: 'INVALID_EFFORT_DAYS' };
    if (n <= 0 || n > 365) return { ok: false, error: '工期须在 (0, 365] 范围内', code: 'INVALID_EFFORT_DAYS' };
    if (Math.round(n * 2) !== n * 2) return { ok: false, error: '工期须为 0.5 的整数倍', code: 'INVALID_EFFORT_DAYS' };
    return { ok: true, value: n };
  }

  // ── POST /sys-issues/:id/feasibility：填可行性评估（在册开发，不改 status，旁路独立事务，F2b §4.1 / v1.7 §十九）──────────
  //   闸门：conclusion 枚举 + requirement_confirm 非空 + dev_estimated_at 格式(>=assigned_at) + 有条件可行/不可行时 risk 必填；
  //   type 仅 feature/improvement；needs_feasibility=1（未勾选 409）；status=W06 白名单固化（M-3）；blocked=1 禁改（M-3' 409 ISSUE_BLOCKED）。
  //   C3 交付物：W06 切换——权限从 ownerGuard 改 assertDevMember（在册），去主次后任一在册开发均可填。
  //   [v1.1 §3.2·C2 → C7 修订] 工期字段（estimated_effort_days）写点①=本端点 payload（写点②=estimate 端点，
  //   承接 nf=0）。C7 起 **feature 与 improvement 同为必填**（原 improvement 选填口径已废止，对齐 risk_level
  //   批1改造B 的同款扩围）；见下方 row.type 分支判定；resubmission 全量覆盖（含清空，同既有 risk 字段
  //   "未传即清"语义一致）。
  // ⭐ [C8-fix Q1] /feasibility 的 payload 校验整块抽成纯函数——**只为让"整体下沉到适用面闸之后"这件事
  //   可审计**：抽出来之后，"八项之间的相对顺序有没有被动过"可以逐行对着看，比在原地上下挪代码块安全。
  //   八项顺序（与重排前逐字相同，标号供对账）：
  //     ① conclusion 枚举 → 400 INVALID_FEASIBILITY_CONCLUSION
  //     ② requirement_confirm 必填 → 400 FEASIBILITY_REQUIREMENT_REQUIRED
  //     ③ requirement_confirm ≤500 → 400 FEASIBILITY_REQUIREMENT_TOO_LONG
  //     ④ risk ≤1000 → 400 FEASIBILITY_RISK_TOO_LONG
  //     ⑤ risk 条件必填（有条件可行/不可行）→ 400 FEASIBILITY_RISK_REQUIRED
  //     ⑥ dev_estimated_at 格式 → 400 INVALID_ESTIMATE
  //     ⑦ estMin 内部不变量 → 500 ESTIMATE_NORMALIZE_INTERNAL
  //     ⑧ 工期格式/值域 → 400 INVALID_EFFORT_DAYS（经 normalizeSysEffortDays 直出；必填判定不在此，
  //        仍留在事务内状态/权限/受阻三闸之后，见调用点下方 EFFORT_REQUIRED）
  //   纯函数不接 db、不抛异常，返回 { ok:true, ...解析值 } 或 { ok:false, status, error, code }。
  function validateFeasibilityPayload(b) {
    const conclusion = (typeof b.conclusion === 'string' ? b.conclusion.trim() : '');
    if (!['可行', '有条件可行', '不可行'].includes(conclusion)) {
      return { ok: false, status: 400, error: '可行性结论仅「可行/有条件可行/不可行」', code: 'INVALID_FEASIBILITY_CONCLUSION' };
    }
    const requirementConfirm = (typeof b.requirement_confirm === 'string' ? b.requirement_confirm.trim() : '');
    if (!requirementConfirm) return { ok: false, status: 400, error: '请填写需求理解确认', code: 'FEASIBILITY_REQUIREMENT_REQUIRED' };
    if (requirementConfirm.length > 500) return { ok: false, status: 400, error: '需求理解确认不超过 500 字', code: 'FEASIBILITY_REQUIREMENT_TOO_LONG' };   // ultracode：补长度上限对齐 reassign/scope_change 范式
    const risk = (typeof b.risk === 'string' ? b.risk.trim() : '');
    if (risk.length > 1000) return { ok: false, status: 400, error: '风险与依赖不超过 1000 字', code: 'FEASIBILITY_RISK_TOO_LONG' };
    // 有条件可行 / 不可行 需填风险与依赖（可行可不填，§十九）
    if ((conclusion === '有条件可行' || conclusion === '不可行') && !risk) {
      return { ok: false, status: 400, error: '「有条件可行/不可行」需填写风险与依赖', code: 'FEASIBILITY_RISK_REQUIRED' };
    }
    const est = normalizeSysDatetime(b.dev_estimated_at);
    if (!est) return { ok: false, status: 400, error: '预计完成时间格式非法（YYYY-MM-DD HH:MM）', code: 'INVALID_ESTIMATE' };
    const estMin = truncToMinute(est);   // S3：同 estimate 端点——est 带秒入库、estMin 到分用于比较与文本
    if (!estMin) return { ok: false, status: 500, error: '时间规范化内部错误（estMin 为空）', code: 'ESTIMATE_NORMALIZE_INTERNAL' };   // 同 estimate 的 LOW-1 守卫
    // [v1.1 §3.2·C2] 工期格式/值域归一（纯格式层，不依赖 row.type）；"必填"判定不在此——那要等状态/权限/
    //   受阻三闸过完（调用点下方 EFFORT_REQUIRED），理由见该处注释。
    const effortParse = normalizeSysEffortDays(b.estimated_effort_days);
    if (!effortParse.ok) return { ok: false, status: 400, error: effortParse.error, code: effortParse.code };
    return { ok: true, conclusion, requirementConfirm, risk, est, estMin, effortValue: effortParse.value };
  }
  router.post('/sys-issues/:id/feasibility', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const b = req.body || {};
      const actor = sysActor(req);
      // [C8-fix Q1] conclusion 在事务**提交之后**仍被消费（下方 notify 分支判定 + 响应体），故必须提到
      //   事务 try 之外声明——payload 校验整体下沉进事务后，原本的 `const conclusion` 作用域只到 try 内，
      //   不上提会在提交后撞 ReferenceError（本批实测撞到：500 "conclusion is not defined"）。
      //   初值 null 是 fail-safe 方向：万一将来加了一条赋值前就 return 的路径，最坏是不发通知，不会误发。
      let conclusion = null;
      await sysBeginImmediate();
      try {
        const row = await dbGetAsync('SELECT id, type, status, assigned_at, needs_feasibility, blocked, gate_deferred_at, dev_estimated_at FROM sys_issues WHERE id = ?', [id]);
        if (!row) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }
        assertKnownIssueStatus(row.type, row.status);
        // ⭐ [C8-fix Q1·315 表态=端点适用面优先·整体重排] **端点适用面两闸先于全部 payload 字段校验**。
        //   原序是「payload 八项（事务外）→ 适用面两闸（事务内）」，于是 bug 单传个畸形日期，拿到的是
        //   `INVALID_ESTIMATE`（"你日期格式不对"）——可实际问题是**这个端点根本不服务 bug 单**，调用方
        //   照着格式码去改日期，改对了也只会撞上第二个错误码。这与 C7-fix2 M1 在 /estimate 修的是**同一个
        //   病**（不适用优先），315 表态要求跟进且做端点级整体重排，不是只挪工期那一项。
        //   ⚠️ 重排口径：整块 payload 校验**原封不动地整体下沉**（八项之间的相对顺序逐字未变，见
        //     validateFeasibilityPayload 内注释标号），只是整体挪到了两条适用面闸之后。因此：
        //       · **适用单据（feature/improvement ∧ nf=1）的可观测行为逐字不变**——它必然通过这两闸，
        //         之后遇到的校验顺序、错误码、状态码与重排前完全相同；
        //       · 不适用单据（bug/config → 409 FEASIBILITY_NOT_APPLICABLE；nf=0 → 409 FEASIBILITY_NOT_REQUIRED）
        //         无论 payload 多畸形，一律先拿到这两个 409。
        //   ⚠️ [C7-C9 收口批 L3] 边缘行为登记（如实记，别让后人以为"适用面闸真的是第一道"）：本次下沉的是
        //     **payload 校验**，而 `row` 是适用面闸自己的输入，故排在这两闸更前面的还有两件事，它们同样
        //     先于 payload 校验，且都是重排前后一致的既有行为：
        //       · **404 SYS_ISSUE_NOT_FOUND 先于 payload 校验**——单据不存在时，payload 再畸形也只会拿到
        //         404。重排前它也在 payload 之后（payload 在事务外），故这条是**重排带来的新序**：原先
        //         "不存在的单 + 畸形 payload" 报 payload 码，现在报 404。方向与本次裁定一致（先答"这单/这
        //         端点该不该服务你"，再答"你传得对不对"），如实登记而非默认无人会问。
        //       · **assertKnownIssueStatus 先于 payload 校验**——它对"库里存着状态机不认识的状态值"抛
        //         SysTransitionError（脏数据自检，非用户输入问题）。于是脏状态单遇上畸形 payload，报的是
        //         状态类错误而不是 payload 码。同上，属重排后的新序，同一条判据下是对的。
        //       · [收口批预筛 MED-3 登记 → **C8-fix2 H 已收口**] 该条登记的是「payload 校验仍先于
        //         FEASIBILITY_STATUS_INVALID / assertDevMember / ISSUE_BLOCKED 三闸」这个侧漏（实证：非在册
        //         开发打畸形 payload 得 400 payload 码，payload 全合法才得 403 NOT_ROSTERED）。**本次
        //         C8-fix2 H 已修**：见紧邻下方的第二次重排注释块，现序为「鉴权 → 业务属性三闸 → payload」。
        //   ⚠️ 代价：payload 校验现在要开一次 IMMEDIATE 事务才跑得到（原来在事务外，畸形请求不占锁）。
        //     与 /estimate 同一笔账——换的是错误码正确，且这条路径本就要开事务查 row。
        //     [C7-C9 收口批 L5·量化] 这笔代价的**上限**是明确的：新增占锁窗口 = 一次按主键的 `SELECT ... WHERE id=?`
        //     ＋ 纯内存的 payload 字段校验（正则/长度/枚举/数值归一，validateFeasibilityPayload 是不接 db 的
        //     纯函数），**没有任何额外 IO**，没有网络调用、没有 fs、没有第二条 SQL。也就是说畸形请求多占的
        //     是"一次 PK 点查 + 几十微秒内存计算"，不是"一次业务处理"。写下这个量化是为了让后人评估"要不要
        //     退回事务外拦"时有实测口径的锚点，而不是凭"开事务=昂贵"的直觉推翻本次裁定。
        // ⭐⭐⭐ [C8-fix2 H·防探知收口·**本端点第二次重排**·codex 316-C 表态一] 鉴权提到全部业务属性闸之前。
        //   ── 第一次重排（C8-fix Q1）解决的是「不适用优先于 payload 格式错」，只把 payload 挪到了**适用面
        //      两闸**之后；那次没动 assertDevMember，于是留下一条侧漏：
        //        **非在册的登录用户可以拿错误码当探针**——同一个 id 打不同 payload，回来的码会随单据属性变化：
        //          · 单据是 bug/config → 409 FEASIBILITY_NOT_APPLICABLE（探知了 type 类别）
        //          · 单据 nf=0 → 409 FEASIBILITY_NOT_REQUIRED（探知了 needs_feasibility）
        //          · payload 畸形 → 400 payload 码（探知"这单是 nf=1 的变更类"，因为它过了前两闸）
        //          · payload 全合法 → 才终于撞上 403 NOT_ROSTERED
        //        也就是说"你有没有资格碰这单"这个最根本的问题，被排在了一堆会泄露单据属性的判定**后面**。
        //   ── 本次重排后的序（**目标序，codex 316-C 表态一**）：
        //        ① 404 SYS_ISSUE_NOT_FOUND / assertKnownIssueStatus —— 记录是否存在 + 内部数据完整性自检
        //        ② **assertDevMember（403 NOT_ROSTERED）** —— 在册鉴权，本行
        //        ③ 业务属性三闸：适用面两闸 → 状态闸 → 受阻闸（**相互相对序逐字未动**，最小化变化面）
        //        ④ validateFeasibilityPayload 整块 —— 负载格式，沉到最后
        //   ── 可观测行为变化面（精确边界，别扩大理解）：
        //        · **非在册用户**：无论单据什么形态、payload 多畸形，一律 403 NOT_ROSTERED。探针失效。
        //        · **在册成员**：适用面/状态/受阻/payload 四组之间的相对序与重排前**逐字相同**（他们必然过
        //          ② 这道闸，之后遇到的判定顺序、错误码、状态码一个没变）——[6c] 三组三类×三向量矩阵
        //          原样全绿即为实证。
        //   ── 代价与理由：assertDevMember 是本端点唯一带 DB 查询的鉴权（查 sys_issue_dev_assignees），提前
        //      意味着"本该被适用面闸一眼拒掉的 bug 单请求"现在也要多跑一条 roster 查询。这笔代价换的是
        //      "未授权者问不出已存在单据的业务属性"——安全边界优先于一次索引点查（[[feedback_guard_boundary_over_convenience]]）。
        //      ⚠️ [C7-fix3 L2·声称收窄] 上一版写的是"拿不到**任何**单据属性信息"，那是绝对词且与实现不符：
        //        **404 存在性仍可见**（单据不存在先得 404 SYS_ISSUE_NOT_FOUND），assertKnownIssueStatus 抛的
        //        状态类异常同样排在鉴权之前。两者都是**既定资源策略**（本仓全部 :id 端点同款），不是本次
        //        重排的疏漏；改它要整仓统一改成"未授权一律 404"，是另一个量级的决策。本次真正堵住的是
        //        「已存在单据的 type / needs_feasibility / status / payload 合法性」这四类属性。
        //   ⚠️ [C7-fix3 补批 ③·MED-1 订正·事实已反转] 本段初版写的是「/estimate 有同款侧漏……本批刻意不动，
        //      等 codex 316-R 表态后单独处置」。两处都要订正：
        //        · **事实反转**——316-R 表态三=「不接受仅登记」，/estimate 的同款侧漏已由 **C7-fix3 H 收口**
        //          （见该端点 :7492 一带的第三次重排块），两端点的鉴权/状态/属性/payload 序自此**同构**；
        //          W06 族第三例 /blocked 也已在本补批一并收口（:7957 一带），三处同一手法。
        //        · **原位置描述自始有误**——初版称 /estimate 的 assertDevMember「在格式校验之后」，实际它当时
        //          就在格式校验**之前**（格式校验早已被 C7-fix2 M1 / 收口批 M1 下沉到适用面闸之后）；
        //          那句话描述的关系从来不成立，一并订正，避免后人拿它去推错误的对齐方案。
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        if (!['feature', 'improvement'].includes(row.type)) { await sysRollback(); return res.status(409).json({ error: '仅变更类单据可填可行性评估', code: 'FEASIBILITY_NOT_APPLICABLE' }); }
        if (row.needs_feasibility !== 1) { await sysRollback(); return res.status(409).json({ error: '该单未要求可行性评估', code: 'FEASIBILITY_NOT_REQUIRED' }); }
        // status 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单）
        if (!SF.isW06Allowed('feasibility', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可填评估`, code: 'FEASIBILITY_STATUS_INVALID' });
        }
        // blocked=1 禁改评估（codex 17b M-3，受阻要继续须先 unblock，保流程线性）
        if (row.blocked === 1) { await sysRollback(); return res.status(409).json({ error: '该单已受阻，请先解除受阻再填评估', code: 'ISSUE_BLOCKED' }); }
        // [C8-fix2 H] payload 校验整块下沉至此（三闸之后）——见上方重排注释块 ④
        const payload = validateFeasibilityPayload(b);
        if (!payload.ok) { await sysRollback(); return res.status(payload.status).json({ error: payload.error, code: payload.code }); }
        const { requirementConfirm, risk, est, estMin, effortValue } = payload;
        conclusion = payload.conclusion;   // [C8-fix Q1] 赋给上提的外层变量（提交后仍要读）
        // [工期对接测试与风险等级拆分 方案 v1.1 §3.2·C2] feature 工期必填（improvement 选填）——刻意放在
        // 状态/权限/受阻三道闸**之后**（同 assigned_at 缺失保护紧邻，都是"通过前置闸后才检查的负载完整性"）：
        // 授权（NOT_ROSTERED）/状态（FEASIBILITY_STATUS_INVALID）/受阻（ISSUE_BLOCKED）三类问题应优先于
        // "表单填完整没"报出，防止未在册/态不对的调用者从错误码里探知"只要把工期填上就行"这类误导信息。
        // ⭐ [C8-fix2 H·注释订正] 上面这条「防探知」理由在 C8-fix2 之前**只对 EFFORT_REQUIRED 这一项成立**
        //   （其余八项 payload 校验当时排在三闸之前，照样会把单据属性漏出去，见 MED-3 登记）。本次重排后
        //   它对**整块 payload 校验**都成立了——EFFORT_REQUIRED 不再是这条理由的孤例，而是它的自然延续。
        // [C7 工时评估补全·方案 v1.7 §9.1] 必填面从 feature-only 扩到 feature+improvement——判据由
        // `row.type === 'feature'` 改为两类型枚举。上方 :FEASIBILITY_NOT_APPLICABLE 闸已把非这两类拦掉，
        // 此处枚举写全是为了让"工期对谁必填"这件事在本行就能读出来，不必回溯上文（也避免将来若放开
        // 类型面时这条静默变成"对所有能填评估的类型必填"）。三层（本端点/submit 闸/GATE）同步同构。
        if (['feature', 'improvement'].includes(row.type) && effortValue === null) {
          await sysRollback(); return res.status(400).json({ error: '请填写工期（人日）', code: 'EFFORT_REQUIRED' });
        }
        // assigned_at 缺失保护 + >=assigned_at（同 estimate，dev_estimated_at 一并写入）
        const assignedMin = truncToMinute(row.assigned_at);
        if (!assignedMin) { await sysRollback(); return res.status(409).json({ error: '该单缺少指派时间（数据异常）', code: 'ASSIGNED_AT_MISSING' }); }
        if (estMin < assignedMin) { await sysRollback(); return res.status(400).json({ error: '预计完成时间不能早于指派时间', code: 'ESTIMATE_BEFORE_ASSIGN' }); }   // S3：同 estimate，比较用到分值
        // ⭐ [并发乐观锁·expected_dev_estimated_at] 同 /estimate 端点同款机制（详见该端点 :7982 一带完整
        //   注释）：调用方可选声明"打开弹窗时看到的现值"，用于探测两个在册开发先后填评估表单时的静默覆盖。
        //   位置刻意放在 UPDATE 之前、既有状态/受阻/payload/必填/assigned_at 诸闸之后——并发真相优先于
        //   "值有没有变"；本端点本无同值 no-op 判定（resubmission 全量覆盖，含清空），故此处即"UPDATE 前
        //   最后一道闸"。键不存在（undefined）→ 整段跳过，旧前端零行为变化。
        const rawExpectedEstimate = (req.body || {}).expected_dev_estimated_at;
        if (rawExpectedEstimate !== undefined) {
          if (rawExpectedEstimate !== null && typeof rawExpectedEstimate !== 'string') {
            await sysRollback();
            return res.status(400).json({ error: 'expected_dev_estimated_at 须为字符串或 null（可选，并发乐观锁）', code: 'VALIDATION' });
          }
          const curDevEstimatedAt = (row.dev_estimated_at === undefined || row.dev_estimated_at === null) ? null : row.dev_estimated_at;   // 字节级严格等值，同 /estimate
          if (rawExpectedEstimate !== curDevEstimatedAt) {
            await sysRollback();
            return res.status(409).json({ error: '预计完成时间已被他人更新，请刷新后重试', code: 'ESTIMATE_STALE' });
          }
        }
        // 乐观锁绑 status='开发中'（W06：actor 未必是 assigned_to，去主次不再绑 assigned_to 条件）；
        //   UPDATE 评估字段 + dev_estimated_at + estimated_effort_days（v1.1 §3.2·C2 新增；resubmission
        //   全量覆盖含清空，同既有 risk 字段"未传即清"语义一致，非部分 PATCH）
        //   ⭐ 上方 expected_dev_estimated_at 一致时才会走到这一行——两把锁互补：本行的 status 锁防"单据
        //   状态已被换"，上方的值锁防"**dev_estimated_at** 在同开发中态内被另一在册开发二次覆盖"。⚠️ 值锁只比对
        //   dev_estimated_at 单字段——resubmission 全量覆盖的其余四个评估字段（结论/需求确认/风险/工期）不在锁内，
        //   "日期不动只改结论"的并发覆盖不设防（残留缺口登记见任务锚点待追认 P1，Opus 预筛 MED-1 收窄）。
        const upd = await dbRunAsync(
          `UPDATE sys_issues SET feasibility_conclusion = ?, feasibility_requirement_confirm = ?, feasibility_risk = ?,
                  dev_estimated_at = ?, estimated_effort_days = ?, updated_at = datetime('now','localtime')
            WHERE id = ? AND status = '开发中'`,
          [conclusion, requirementConfirm, risk || null, est, effortValue, id]
        );
        if (!upd || upd.changes !== 1) { await sysRollback(); return res.status(409).json({ error: '迭代单状态或负责人已变更，请刷新重试', code: 'CONCURRENT_FEASIBILITY' }); }
        // feasibility timeline 快照（append-only 冻结，summary 拼结论/需求理解/风险/预计完成/工期）
        //   S3：快照文本用 estMin（同 estimate 的 timeline summary 理由——纯文本直出，带秒会显示到秒违反 D3）；
        //   工期是数字非时间字段，不涉及秒/分精度问题，同一原则下仍是"写入时就定成给人看的最终文本"。
        const effortText = effortValue !== null ? `${effortValue}人日` : '未填';
        const snapshot = `结论：${conclusion}｜需求理解：${requirementConfirm}｜风险：${risk || '无'}｜预计完成：${estMin}｜工期：${effortText}`;
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
        await dispatchSysNotify(id, 'notifyEstimateToCreatorAndRequester', actor.id);
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
        // ⭐⭐⭐ [C7-fix3 补批 ①·防探知收口·**W06 族第三个同款侧漏**] assertDevMember 前移到全部业务属性闸之前。
        //   ── 来源：C7-fix3 交付后按「模式而非名单」对 W06 族端点做普查（[[feedback_pattern_sweep_not_symptom_list]]），
        //      判定表结论=本端点与 /feasibility（C8-fix2 H）、/estimate（C7-fix3 H）是**同一个病的第三例**。
        //   ── 侧漏形态（非在册的登录用户拿错误码当探针，一个 id 能问出三层信息）：
        //        · 非 feature/improvement 或 nf≠1 → 409 BLOCKED_NOT_APPLICABLE（漏 type 与 needs_feasibility）
        //        · 状态不在 W06 白名单 → 409 BLOCKED_STATUS_INVALID，**文案里还带着状态名**
        //          （`当前状态「${row.status}」不可标记受阻`），等于把状态字符串念给未授权者听
        //        · 三闸全过 → 才终于撞 403 NOT_ROSTERED
        //   ── 本次重排后的序（与另两个端点**同一手法、同一行文**）：
        //        ① 404 SYS_ISSUE_NOT_FOUND / assertKnownIssueStatus（记录存在性 + 数据完整性自检）
        //        ② **assertDevMember（403 NOT_ROSTERED）** —— 在册鉴权，本行
        //        ③ BLOCKED_NOT_APPLICABLE → BLOCKED_STATUS_INVALID → ISSUE_ALREADY_BLOCKED
        //           （③ 内部相对序**逐字未动**，本次只前移 assertDevMember 一件）
        //   ── 变化面（[316-R2] 范围限定：前提=单据存在且通过完整性自检——404 与状态异常仍在鉴权前，既定
        //      资源策略）：**非在册用户**对已存在的合法单据，无论 type/nf/状态/是否已受阻，一律 403 NOT_ROSTERED；
        //      **在册成员**的三闸相对序与错误码逐字不变（[4g-blocked] 的两条配对正例即实证）。
        //   ⚠️ reason 的两道 payload 校验（BLOCKED_REASON_REQUIRED / _TOO_LONG）仍在事务外、**先于**本鉴权——
        //     那是**纯 payload 自校验，不读 row、不泄露任何单据属性**（无论单据是什么、存不存在，同样的入参
        //     恒得同样的码），故不构成探针面，本批刻意不动它（动了要多开一次事务，换不来安全收益）。
        // W06 断言②：assertDevMember（在册即可，非严格 assigned_to 本人——去主次，§5.1）
        await assertDevMember(id, actor.id);
        // M-1 收口：仅 feature/improvement + needs_feasibility=1 可受阻
        if (!['feature', 'improvement'].includes(row.type) || row.needs_feasibility !== 1) {
          await sysRollback(); return res.status(409).json({ error: '仅要求可行性评估的变更类单据可标记受阻', code: 'BLOCKED_NOT_APPLICABLE' });
        }
        // status 合法前置态：SF.isW06Allowed 固化常量（同 §5.3 W06 白名单）
        if (!SF.isW06Allowed('blocked', row.type, row.status)) {
          await sysRollback(); return res.status(409).json({ error: `当前状态「${row.status}」不可标记受阻`, code: 'BLOCKED_STATUS_INVALID' });
        }
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
      // ⭐⭐ S2（bug暂缓方案 §4.2·实现错回填）：本常量此前只列变更流活跃态——写这行时 bug 还没有 hold/resume
      //   （S1 才新增，见 transitions.js bug hold/resume 条目）。bug 的 hold.from 只有 ['处理中']，即 bug
      //   resume 唯一可能的暂缓前态恒为「处理中」，若不加入本表，resume 会在事务内被下方 `!ACTIVE_STATES.includes(target)`
      //   拦截，抛 409 RESUME_TARGET_INVALID——**bug hold→resume 全流程此前从未真正跑通过**（S1 只做常量层，
      //   未做集成测试；S2 集成测试[死锁反证用例]首次实测到本缺口）。下方紧跟 `T.ALLOWED_STATUSES[row.type].includes(target)`
      //   仍按 type 精确二次校验，加入「处理中」不会让 feature/improvement 误通过（其 ALLOWED_STATUSES 不含处理中）。
      const ACTIVE_STATES = ['待指派', '开发中', '待验证', '待上线', '处理中'];   // 变更流 + bug 活跃态并集（已上线/已关闭=终态，旁路态/INTAKE 不在内）
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
          // [275-M1 收口] 同上，消费共用 analyzeRosterForGate。
          const { activeCount: rosterActiveCount, allComplete: rosterAllComplete } = analyzeRosterForGate(rosterRows);
          if (!(rosterActiveCount >= 1 && rosterAllComplete)) {
            resumeDegradeInfo.degraded = true;
            resumeDegradeInfo.originalTarget = target;
            return SF.SYS_DEV_STATUSES[row.type][0];
          }
        }
        return target;
      };
      // sysIssueTransition 内 findTransition('resume', '已暂缓') 守前置态；expectedFrom='已暂缓' 双守；动态目标态事务内解析
      // ⭐ [bug暂缓方案 20260803 v0.4 口径 #1·实现错回填] 本路由此前硬编码 payload={}（历史遗留——resume
      //   requiredPayload 原为 []，不需要任何 body 字段，硬编码零成本）。C1 把 resume 的 requiredPayload
      //   改为 ['reason'] 后，case 'resume' 靠 payload.reason 做必填校验——若此处仍传 {}，客户端无论传什么
      //   reason 都会被丢弃，必现 400 RESUME_REASON_REQUIRED（本方案 S1 验证阶段实测命中，非本方案有意行为，
      //   是 makeTransitionEndpoint 通用路径与本专用路由"payload 转发"这一步此前不同源的真实实现缺口，
      //   随 reason 必填一并补齐——修复对齐 makeTransitionEndpoint 的 `req.body || {}` 范式）。
      const r = await sysIssueTransition(id, 'resume', '已暂缓', sysActor(req), req.body || {}, { resolveToStatusInTxn, resumeDegradeInfo });
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
        const dl = normalizeDeadlineDT(trimmedDeadline);   // 四处优化 D2：同建单口径（到分钟）
        if (!dl.ok) return res.status(400).json({ error: '期望完成格式非法（YYYY-MM-DD 或 YYYY-MM-DD HH:MM 的真实时间）', code: 'INVALID_DEADLINE' });
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
        // ⚠️ S3（D3/D4）：dlValue 现在**带秒**（normalizeDeadlineDT 输出补 ':00'），而 row.deadline 可能是
        //   S3 之前写入的无秒值或存量纯日期。直接逐字比会把**纯格式升级**（'14:30' → '14:30:00'）判成真变更，
        //   写库 + 留一条"deadline 从 X 改为 X"的假记录。⇒ 比对与留痕文本都归到分（入库仍用带秒的 dlValue）。
        //   本端点当前无 type 可达（见上方守卫注释），改在这里是为 config 流放开时不留坑。
        const dlTextNew = deadlineToMinuteText(dlValue);
        const dlTextOld = deadlineToMinuteText(row.deadline);
        if (dlValue !== undefined && dlTextNew !== dlTextOld) {
          evSummary += `（deadline ${dlTextOld || '空'} → ${dlTextNew}）`;
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
      const dl = normalizeDeadlineDT(b.deadline);   // 四处优化 D2：同建单口径（到分钟）
      if (!dl.ok) return res.status(400).json({ error: '期望完成格式非法（应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM 的真实时间）', code: 'INVALID_DEADLINE' });
      // [⑤ §4 双描述·Q2 合并] derive_reason 取代旧 derive_note：既落新单 derive_reason 列、又作 derive timeline summary。
      //   必填范围（Q1）= 仅 bug 语境（origin.type='bug'），feature→feature 派生保持选填——精判在事务内（需 origin.type）。
      const deriveReason = (typeof b.derive_reason === 'string' ? b.derive_reason.trim() : '');

      // ⭐⭐⭐ [C10·决策1·派生单对接人=继承 origin] 原实现（建单优化批 C1）靠「active 受理人恰 1 人」自动填——
      //   那是为 SYS_INTAKE_LIAISON_IDS=[13] **单例池**写的：候选池扩大后（裁定2）恒 ≥2 人 → 恒 409
      //   INTAKE_LIAISON_AUTO_FILL_FAILED（单例假设破裂）。C10 改为**派生单继承 origin 的 intake_liaison_id**：
      //     · origin 建单必填对接人（裁定2 保持必填）⇒ 正常派生有明确继承值，不产生新空单；
      //     · **最小行为变更**——「派生即有对接人」不变，只是来源从固定[13]变成 origin 的对接人（业务连续性：
      //       派生需求归原单对接人负责）；
      //     · ⚠️ 若 origin 本身是**存量空单**（intake_liaison_id NULL）⇒ 派生单也落 NULL，走 accept CAS 兜底
      //       （与空单模型一致）。
      //   继承值需 origin.intake_liaison_id ⇒ 解析移入事务内（origin 读取后），原事务外 resolveActiveSysIntakeLiaisons
      //   调用与 length!==1 闸整块删除（单例假设的最后残留）。**P4 已追认（用户 2026-08-08 拍板继承 origin）**
      //   （方案 §10.2 未覆盖 derive 口径·选最小行为变更方向·曾评估空单/admin 指定方案均未采纳；已知软肋=
      //   换对接人 L2 端点当前缺失，继承错人时暂由 admin 手动处理，L2 列扩池前置依赖）。
      const actor = sysActor(req);
      let newId = null, resolvedType = null, resolvedStatus = null;
      await sysBeginImmediate();
      try {
        // 原单须存在（[⑤] SELECT 补 status——M5 反向约束需判 origin.status；[C10·决策1] 补 intake_liaison_id 供派生单继承）
        const origin = await dbGetAsync('SELECT id, type, status, origin_issue_id, intake_liaison_id FROM sys_issues WHERE id = ?', [originId]);
        if (!origin) { await sysRollback(); return res.status(404).json({ error: '原单不存在', code: 'ORIGIN_NOT_FOUND' }); }
        // ⭐ [C10·决策1] 派生单继承 origin 对接人（可能为 NULL=存量空单，走 accept CAS 兜底）。
        const autoIntakeLiaisonId = origin.intake_liaison_id;
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
        // ⭐ 建单优化批 C3b（方案 20260801_v1.3 §6c 设计点5）：oa_exempt **刻意不入本 INSERT 列表**——
        //   靠 CREATE TABLE / ALTER 的 `DEFAULT 0` 落 0（fail-closed：衍生单源自业务需求几乎必走 OA，
        //   免 OA 需求真出现再议，入方案 §9 观察项；显式恒 0 也可以，但少一处需要维护的硬编码值，
        //   DEFAULT 本身就是最不容易漂移的"恒 0"实现）。
        const result = await dbRunAsync(
          `INSERT INTO sys_issues
             (type, status, priority, title, description, system_name, module_name, source,
              requester_dept, requester_name, requester_phone, deadline, origin_issue_id, derive_reason,
              created_by, created_by_name, record_source, intake_required, intake_liaison_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', 1, ?)`,
          [type, initialStatus, priority, title,
           (typeof b.description === 'string' ? b.description.trim() : null),
           systemName, (typeof b.module_name === 'string' ? b.module_name.trim() : null), source,
           (typeof b.requester_dept === 'string' ? b.requester_dept.trim() : null),
           (typeof b.requester_name === 'string' ? b.requester_name.trim() : null),
           (typeof b.requester_phone === 'string' ? b.requester_phone.trim() : null),
           dl.value, originId, (deriveReason || null), actor.id, actor.name, autoIntakeLiaisonId]
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
      //   [S12 双路审查 Opus-2 MED 收口·方案 §3.5「待对接测试」矩阵+C0 双登记必做项] 再拓宽到含
      //   LIAISON_TEST——待对接测试段仍是开发/对接人协作补证据的窗口（如对接人测出问题需要开发追加
      //   截图佐证、或开发继续补交付材料），"仅 DEV∪VERIFY 两族"会把这条协作路径挡在测试段外。
      //   LIAISON_TEST 对 improvement/bug 恒空数组（status-families.js），isInFamily 对这两个 type
      //   恒 false，不影响其既有行为范围，只是给 feature 多开一扇门。
      const roster = await sysAttachmentRosterState(id, actor.id);
      if (!isCoordinator && !roster.active) { sysCleanupOrphanFiles(req, id); return res.status(403).json({ error: '交付附件仅在册开发/协调人可上传', code: 'NOT_AUTHORIZED_FOR_ATTACHMENT' }); }
      const inDevOrVerify = SF.isInFamily(row.type, row.status, 'DEV') || SF.isInFamily(row.type, row.status, 'VERIFY') || SF.isInFamily(row.type, row.status, 'LIAISON_TEST');
      if (!inDevOrVerify) { sysCleanupOrphanFiles(req, id); return res.status(409).json({ error: '仅开发进行态（开发中/处理中/待验证/待对接测试）可上传交付附件', code: 'INVALID_STATE_FOR_ATTACHMENT' }); }
      if (files.length === 0) { sysCleanupOrphanFiles(req, id); return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' }); }
      persisted = await sysPersistAttachments(id, files, attachmentType, null, actor);
      // TOCTOU 二次守卫：persist 后重读仍处 SYS_DEV∪SYS_VERIFY 态 且 授权仍成立（type 不可变用首读值；协调人身份
      //   不受事务影响故不重查，仅"在册"路径需重查——校验→INSERT 间被 remove/打回/作废则回滚）。
      const recheck = await dbGetAsync('SELECT status FROM sys_issues WHERE id = ?', [id]);
      const recheckStatusOk = !!recheck && (SF.isInFamily(row.type, recheck.status, 'DEV') || SF.isInFamily(row.type, recheck.status, 'VERIFY') || SF.isInFamily(row.type, recheck.status, 'LIAISON_TEST'));
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
  //   闸门当时收敛到「bug 类型的 needs_release 必须=1」——add-issues/hotfix-publish/_publishReleaseCoreInTxn
  //   三处写入口曾同步加 needs_release=1 校验（K1，运行时防线，旧库 ALTER 无 CHECK）+ release_type 批次隔离
  //   （§8.3 [审:L1]，add-issues 校一致禁混批）。**历史设计，现状**：_publishReleaseCoreInTxn 的校验随
  //   v1.6/C3b 退场（见其函数体内注释）、release_type 族别隔离随 C5"混批守卫拆除"整体删除（方案 §5a）、
  //   add-issues 的 needs_release=1 条件随本次双闸拆除删除（2026-07-29 主会话裁定选项 A）——三处校验现已
  //   全部不存在，config 不进批次（§6.1）是本表仅存的原样闸门。
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

  // ── C6→C2a 演进：发布冻结快照写入（§8「快照基数与插入语义」+ 上线体统一重构 §6.6a 快照 v2，
  //   **假定调用方已 BEGIN IMMEDIATE**）─────────
  //   同一 (release_id,issue_id) 生命周期只快照一次：INSERT ... ON CONFLICT(release_id,issue_id) DO NOTHING
  //   （禁 INSERT OR IGNORE——会静默吞 NOT NULL/CHECK 等一切约束失败，方案 §8 明文）。
  //   changes 读取纪律（Lz-1）：changes 直接取本 INSERT 语句的 dbRunAsync 返回值（`this.changes`，sqlite3 单连接
  //   serialize 队列内该 Promise resolve 时即该语句执行完毕的直接结果，中间未插入任何其他语句），非另起查询估算。
  //   changes=0 → 同事务显式 SELECT 确认该 (release_id,issue_id) 是否已存在快照行：存在→视为已冻结继续（幂等，
  //   覆盖"同一批次内理论不会二次发布但脏库/竞态"防线）；不存在→抛错，由调用方 catch 整体 ROLLBACK 发布事务。
  //   ⭐ C2a snapshot v2（方案 §6.6a，codex 三源统一字段集）：snapshot_json 从纯 commit 数组升级为对象
  //   `{schema_version:2, type, title_snapshot, status_at_publish, commits}`——`issue` 入参须含
  //   `{id, type, title}`（调用方 `_publishReleaseCoreInTxn` 的 members 查询已补 `title` 列）；
  //   `status_at_publish` 固定为 `'已上线'`——本函数只在批量翻牌 UPDATE 成功（`changes===expected`）之后被
  //   调用，届时所有成员必已是「已上线」，无需另查，直接常量赋值（同一事务内的确定性事实，非猜测）。
  //   **启动门已拍板**：不写 v1（纯数组）兼容读端——GET /sys-releases/:id/commit-snapshots 的读端小兼容
  //   分支（同时接受数组/对象两种历史形态）不算"v1 兼容读端"，那专指 getReleaseMembers()（C4 才做）。
  //   commits 数组本身仍是 JS 层查 sys_issue_dev_commits 全部现存行（含 removed 实例，方案 §8 明文）拼出，
  //   不用 SQL 聚合（防 LEFT JOIN 誤产：零行本应 []，聚合函数在无匹配行时常产出单个全 NULL 聚合结果而非
  //   空集，见 Mz-5）。commit_id 即表主键 id，ORDER BY id ASC 天然升序。
  //   **返回值**：v2 payload 对象（供调用方复用同一份 commits 查询结果去写 release_published timeline 载荷，
  //   不重复查一次 sys_issue_dev_commits）。
  async function snapshotReleaseCommitsInTxn(releaseId, issue) {
    const issueId = issue.id;
    const commitRows = await dbAllAsync(
      `SELECT id AS commit_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at
         FROM sys_issue_dev_commits WHERE issue_id = ? ORDER BY id ASC`,
      [issueId]
    );
    const payload = {
      schema_version: 2,
      type: issue.type,
      title_snapshot: issue.title,
      status_at_publish: '已上线',
      commits: commitRows,   // 零行 → []（Mz-5 固定合法空数组）
    };
    const snapshotJson = JSON.stringify(payload);
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
    return payload;
  }

  // 事务内发布核心（**假定调用方已 BEGIN IMMEDIATE**，本函数不 begin/commit/rollback）。
  //   publish（攒批）与 hotfix（单条兜底）共用，杜绝两路逻辑漂移（§6.1 两路都产出批次记录）。
  //   payload.release_note / version_tag 非空时先落库（"填上线说明+版本 → 发布"单步），再校验（闸门③ D7·C6 起
  //   release_note 必填不变、version_tag 仅长度校验允许空落 NULL——§8 去 version_tag 必填，109 号注释同步）。
  //   抛 SysTransitionError 由调用方 try/catch ROLLBACK + endpoint sendSysTransitionError 转 HTTP。
  // [codex 102 号 HIGH 回填] RELEASE 守卫接线——action/actionKind 由调用方传入（§2.6/status-transition-guard.js
  //   RELEASE_ACTION_ACTIONKIND_PAIRS 既有枚举，勿造新值）。
  //   ⭐ 调用面现状（302-L2 压缩为当前事实，历史退场细节不再赘述）：HTTP 可达唯一入口
  //   `/sys-releases/:id/execute`（C3，「确认我这一份」+ R-GATE，方案 §4.3）→ action='execute-release',
  //   actionKind='execute'；`publishReleaseTransition`（legacy 批量 /publish，路由本身已 409 退场，函数体
  //   **刻意保留不删**）仅作"内部调用绕过 HTTP 也会被拦"的测试直调载体，见其定义处 :9584 一带注释 →
  //   action='publish', actionKind='publish'。
  //
  // [C9·codex 207 审 HIGH-2 轻量采纳] 不变量显式声明——「同一 release_id 永不二次发布」：
  //   本函数把 releaseId 写入 sys_releases.status='已发布'（下方步骤4末尾 UPDATE，WHERE status='计划中'）
  //   后，该行的 status 全项目再无任何写点会把它拨回「计划中」（status 列仅两处写：本函数这里单向
  //   计划中→已发布；POST /sys-releases 建批次时的初值，恒'计划中'新建行）。担心点是：若某个已发布
  //   release 的旧成员被 close→reopen 后又设法"回到"同一个 release_id 并再次触发本函数，
  //   snapshotReleaseCommitsInTxn 的 `INSERT ... ON CONFLICT(release_id,issue_id) DO NOTHING` 会让
  //   第二次快照静默丢弃（旧快照原样保留、新 commits 变更进不去），同时下方 H-3 步骤4 的
  //   release_published timeline 行没有唯一约束，会对同一 (release_id,issue_id) 多插一条。
  //   该场景由两道独立守卫组合兜死（缺一不可，需同时失效才会真出问题）：
  //     ① reopen 不动 release：sysIssueTransition 的 reopen sideEffects（transitions.js 变更流/bug 流两条
  //        目分别在 ~363/~665 行）只清 issue 自身列（accepted_at/released_at/closed_at/release_id/
  //        dev_estimated_at/scheduled_start），从未写过 sys_releases 任何列——reopen 后该 issue 的
  //        release_id 被清空、脱离原批次，但原批次那一行的 status 原地不动，永远停在「已发布」。
  //     ② add-issues 拦非「计划中」：POST /sys-releases/:id/add-issues（本文件 ~7643 行）前置校验
  //        `rel.status!=='计划中'` 才放行加单——即使有人拿 reopen 后释放出来的 issue 硬要传回**同一个**
  //        已发布 release_id，也会在加单这一步先吃 409 RELEASE_NOT_PLANNING，走不到本函数。
  //   纵深第三层（本函数自身）：即便前两道被绕过（如未来新功能允许「已发布」批次撤回改「计划中」），
  //   本函数入口处的 `rel.status !== '计划中'` 前置校验（上方数行）与步骤4末尾 UPDATE 的
  //   `WHERE status='计划中' AND changes===1` 双重确认仍会各自单独拦下——三层任一存活，不变量都不破。
  //   ⚠️ 若上述守卫在未来被同时削弱/绕过：真实后果**不是**"静默产出错误但被判完整的数据"——
  //   getReleaseMembers()（下方 C4 段）的完整性校验除 Set 去重后的 `expectedIds.size` 外，另有一条
  //   `snapRows.length === publishedTlRows.length` 的**原始行数**比对（[C5 收口批·codex 203 审 A 项]
  //   专为这个假设场景加的防线，见其函数体内该行注释），timeline 重复行会让这个原始行数比对失配，
  //   从而正确判 `degraded`（返回红线提示"历史记录不完整"）而非误判完整——真实后果是**发布历史从
  //   精确快照降级为不可用**（用户可见的功能损失），不是静默数据污染。verify-sys-release-batch.js
  //   ⑬组内的「⑬-C9锁定」子断言直接构造这一具体场景（已发布批次成员 close→reopen 后加回同一旧批次）
  //   锁定当前代码下②这道守卫确实生效，防回归。
  async function _publishReleaseCoreInTxn(releaseId, actor, payload = {}, action, actionKind) {
    const rel = await dbGetAsync(
      // [C5 收口批] release_type 列已从本 SELECT 移除——族别一致性检查随"混批守卫拆除"一并删除后，
      //   本函数体内不再有任何地方读取 rel.release_type（已核对，见上方族别检查删除处注释）。
      // ⭐ C3（方案 §4.4 改造 4）：release_assignee_id/release_assignee_notify_status 两列不再是中心
      //   守卫依据——批次级列已被行级子表取代，本 SELECT 相应收窄，不再读这两列（避免留一个没人再用
      //   的死读取，误导后来者以为它们还在被消费）。
      `SELECT id, status, release_note, version_tag FROM sys_releases WHERE id = ?`,
      [releaseId]
    );
    if (!rel) throw new SysTransitionError(404, 'RELEASE_NOT_FOUND', '上线批次不存在');
    if (rel.status !== '计划中') throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次非「计划中」，不能发布');

    // ── C3 中心守卫改口径（方案 §4.4 改造 4）：进入「已上线」的唯一合法上下文——本函数自己在同一写
    //   事务内读取执行人子表并判定，**不接受调用方传入的"已验证"标记**。任何调用方（HTTP 端点或内部
    //   直调，如 verify 直调 publishReleaseTransition/_internals 绕过 HTTP）想让某个 release 发布，
    //   都必须真实满足这三项，无法绕过——这是"内部调用绕过 HTTP 也会被拦"的具体落点。
    //   旧口径「release_assignee_id===actor.id」（单人执行人单列比对）→ 新口径「actor 在册（子表
    //   EXISTS）∧ 在册人数≥1 ∧ 在册全员 exec_status='done'」（多人各自确认，方案 §4.3 R-GATE 同款
    //   条件，此处是"内部直调也绕不过"的那道唯一防线，与 /execute 路由自身的 R-GATE 判定逐字同源）。
    //   ⭐ 用户拍板决策 7 第三次修正（方案 v1.7 二订）：执行人下限 2→1——单人批次也是合法的"多人机制的
    //   退化态"，不再强制 EXECUTORS_TOO_FEW；本守卫改守"非空"不变量（零在册仍拒，见下方 `< 1` 判据），
    //   不再守"至少两人"。
    //   ⚠️ **绝不加"全员 notify_status='sent'"检查**——v1.3·M-b 死锁教训：某人 done 之后若被误重发
    //   且失败，该行会变成 done+failed（sent 已经不成立），若中心守卫还要求"全员 sent"，这类批次会
    //   永远发布不了（最后一人怎么点都过不了守卫）。"全员已确认（done）"本身就已经蕴含"确认那一刻
    //   notify_status 曾经是 sent"（CAS 前置条件），不需要、也不能再叠加"此刻仍是 sent"这个更强的
    //   要求。
    //   ⚠️ 与 /execute 路由自身的行级 CAS+R-GATE 判定是纵深防御关系（对该路由是冗余复核——其自身已
    //   在同事务内先做过一遍，这里必然重新通过）；对其余调用方（现存的 publishReleaseTransition 及
    //   未来可能新增的调用方）这才是唯一防线。校验顺序：在册存在性 → 人数 → 全员完成态，与 /execute
    //   路由 R-GATE 判定同一顺序，不新造顺序。
    const execRows = await dbAllAsync(
      `SELECT user_id, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL`,
      [releaseId]
    );
    const actorInRoster = execRows.some(r => Number(r.user_id) === Number(actor.id));
    if (!actorInRoster) {
      throw new SysTransitionError(403, 'EXECUTOR_GUARD_FAILED', '仅在册执行人可执行上线');
    }
    if (execRows.length < 1) {
      throw new SysTransitionError(409, 'EXECUTORS_TOO_FEW', '在册执行人为空，不能发布');
    }
    const allDone = execRows.every(r => r.exec_status === 'done');
    if (!allDone) {
      throw new SysTransitionError(409, 'EXECUTORS_NOT_ALL_DONE', '尚有执行人未确认完成，不能发布');
    }
    const centralGuardEligible = await hasReleaseEligibility(actor.id);
    if (!centralGuardEligible) {
      throw new SysTransitionError(403, 'EXECUTOR_NOT_ELIGIBLE', '当前账号无执行上线资格（非在职，或为查看者/管理员）');
    }

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
    // ⭐ C2a：members 补 `title` 列——snapshot v2（§6.6a）需要发布时的标题快照 `title_snapshot`，
    //   不额外查询，直接复用本次已查的 members（同一事务内一致性快照，避免二次 SELECT 产生的读撕裂窗口）。
    const members = await dbAllAsync('SELECT id, status, type, title, needs_release FROM sys_issues WHERE release_id = ?', [releaseId]);
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
    // [C5 收口批·C3 遗留补做] 族别一致性纵深防线（原"混批守卫"）已整体删除——方案 §5a 架构决策表明文
    //   "混批守卫 → 拆除"，§6.10 发布事务内校验清单里"④ 类型一致"一条也已删除；C3"全类型统一"落地后，
    //   bug/feature/improvement 可合法同批（deriveReleaseType 把 mixed 列为合法派生值本身即是佐证）。
    //   原两条检查（① 组内成员族别不可混 ② 与批次已存 release_type 不符也拒）连同 memberFamilies 变量
    //   一并删除——badType（上方，config 排除）与 needs_release 校验（同上，v1.6 已退场）逐字不动，
    //   本次只删族别隔离这一层，不影响其余闸门。
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
      // [275-M1 收口] 行内保留 {dev_status} 对象形状（而非裸字符串），与 analyzeRosterForGate 的输入契约
      //   一致，四处 guard 调用点同一份分析函数，不再各自维护一份 filter/every。
      for (const r of rosterRows) rosterByIssue.get(r.issue_id).push({ dev_status: r.dev_status });
      for (const m of members) {
        const { activeCount: rosterActiveCount, allComplete: rosterAllComplete } = analyzeRosterForGate(rosterByIssue.get(m.id) || []);
        assertMainStatusTransition({
          routeKind: 'RELEASE', action, actionKind, issueType: m.type,
          before: m.status, after: '已上线', rosterActiveCount, rosterAllComplete,
        });
      }
    }

    // H-3 步骤3：批量翻「已上线」+ released_at，校 changes 等于预期数否则整体回滚 409。
    // ⭐ [C9-fix2 M2·双保险] SET 追加 `online_source = NULL`——**纯列追加，不动本函数任何判定/流程**
    //   （红线：_publishReleaseCoreInTxn 内核零逻辑改动，本行只是让这条 UPDATE 多写一列常量 NULL）。
    //   语义：经批次发布上线的单，其「上线来源」就是批次发布，不该带任何免上线直翻的标签。
    //   为什么是"双保险"而不是必需：能走到这条 UPDATE 的单 status 必须是「待上线」，而 online_source 的
    //   唯一写入**非 NULL 值**的点是 C9 直翻分支（[85ace8b 预筛 LOW-1 订正] 写 NULL 的点本批已有三处：
    //   C9 写标签/reopen 清列/本条——"唯一"限定的是非 NULL 值；那条边一步落「已上线」，落完就不在「待上线」了），所以理论上进得来的单
    //   该列恒 NULL。挡的是"理论"失效的两类情形——① 直连 SQL / 迁移脚本给存量单写过该列；② 将来有人给
    //   online_source 加第二个写入点却漏了这条链路。代价为零（一列常量），收益是让"批次发布 ⇒ 列为 NULL"
    //   从推理结论变成写点保证，deriveOnlineSourceKind 的 ①②分支边界因此不依赖任何历史假设。
    const flip = await dbRunAsync(
      "UPDATE sys_issues SET status = '已上线', released_at = datetime('now','localtime'), online_source = NULL, updated_at = datetime('now','localtime') WHERE release_id = ? AND status = '待上线'",
      [releaseId]
    );
    if (!flip || flip.changes !== expected) {
      throw new SysTransitionError(409, 'RELEASE_PUBLISH_CONFLICT', '批次内单状态已变更，请刷新重试');
    }

    // H-3 步骤3.5（C6·§8「发布与快照」+ C2a §6.6a v2 演进）：主状态置「已上线」成功后、事务提交前，逐单落
    //   发布冻结快照。本函数是 publish / hotfix-publish 端点 / execute-release(mode=publish/hotfix) /
    //   新 execute 端点（C2a）共用内核（见函数头注释），快照逻辑长在这唯一交汇点即天然满足"入口同事务"——
    //   ⭐ [85ace8b 预筛 MED-1 订正] 本行原写"execute-release(mode=hotfix) 走完全独立的直接 UPDATE 分支
    //   （不经本函数、release_id 恒 NULL）"——**陈旧**：execute-release 端点已于 C3 整体退场（handler 首行
    //   无条件 409 LEGACY_RELEASE_FLOW_DISABLED），该分支已不存在；现行 hotfix-publish 与 execute 均直连
    //   本函数。这句陈旧描述曾在 C9-fix2 骗过两层审读（agent 与主会话都引它立论），留此订正为记：
    //   注释自述的架构事实必须回 handler 体核实（[[feedback_comment_is_review_input]]）。
    //   ⚠️ 保留每单快照 payload（Map），供下方 timeline 写 release_published 复用同一份 commits 查询结果，
    //   不重复查一次 sys_issue_dev_commits（同一批 commit 行两处消费，一次查询）。
    const snapPayloadByIssue = new Map();
    for (const m of members) {
      const payload = await snapshotReleaseCommitsInTxn(releaseId, m);
      snapPayloadByIssue.set(m.id, payload);
    }

    // H-3 步骤4：每单写 release timeline（ref_id=批次 id，summary=上线说明，**逐字不动，旧流兼容**）
    //   + **C2a 新增**：每单另写一条 release_published 结构化留痕行（§6.6a/§6.13）+ 批次置「已发布」。
    //   ⚠️ [C2a 编码前置②探查结论，见完成报告详述] 现有 event_type='release' 行的 `summary` 列被前端
    //   siRenderTimeline（Sys_Iteration.html:~1302）消费为**人类可读文本**直接 esc() 展示；本表
    //   （sys_issue_timeline）没有 payload_json 列（那是 sys_issue_dev_commits 表独有，:683）。若把
    //   §6.6a 结构化 JSON 塞进这条既有行的 summary，会让详情页时间线显示裸 JSON（可见回归）且丢失现有
    //   人类可读文案。故**不改动**这条既有 release 行的任何字段（event_type/summary/无 action_code）——
    //   **另写一条**新行（event_type='scope_change'·action_code='release_published'），与 release_add/
    //   release_remove/release_date_change/release_schedule_cancel 四个新 action_code 同属一套"scope_change
    //   留痕体系"、地位对等，非从旧行"升级"。JSON 落在这条**新行**的 summary（本表唯一可承载文本的列），
    //   旧行完全不受影响、前端现有渲染逐字不变。
    for (const m of members) {
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, ref_id, operator_id, operator_name)
         VALUES (?, 'release', '待上线', '已上线', ?, ?, ?, ?)`,
        [m.id, releaseNote, releaseId, Number(actor.id) || null, actor.name || null]
      );
      const publishedPayload = { issue_id: m.id, ...snapPayloadByIssue.get(m.id) };
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
         VALUES (?, 'scope_change', ?, 'release_published', ?, ?, ?)`,
        [m.id, JSON.stringify(publishedPayload), releaseId, Number(actor.id) || null, actor.name || null]
      );
    }
    const done = await dbRunAsync(
      "UPDATE sys_releases SET status = '已发布', released_at = datetime('now','localtime') WHERE id = ? AND status = '计划中'",
      [releaseId]
    );
    if (!done || done.changes !== 1) throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次状态已变更，请刷新重试');

    return { releaseId, releasedIssueIds: members.map(m => m.id), count: expected };
  }

  // ============================================================
  // 上线体统一重构 C4（方案 v3.4 §6.6/§6.6a/§6.6b）：getReleaseMembers 统一读源
  // ============================================================
  //
  //   **唯一读源规则**（§6.6）：`release.status='计划中'` → `live`（当前 sys_issues.release_id 直读）；
  //   `release.status='已发布'` → 优先**快照表**（`sys_issue_release_commit_snapshots`，完整性校验通过）；
  //   快照缺失或完整性校验失败 → 回落 `sys_issue_timeline` 的 `release_published` 载荷重建，标记 `degraded`。
  //   `sys_releases.status` CHECK 只有 `计划中`/`已发布` 两值（:390），故本函数只需二分支，无第三态需处理。
  //
  //   **三源统一字段集**（§6.6a）：`{issue_id, type, title_snapshot, status_at_publish, commits}`——
  //   三个源码路径（live/snapshot/degraded）无论走哪一条，`members[]` 里每个元素的字段名逐字相同，消费者
  //   不必为三态各写一份"这个字段在这一态叫什么名字"的分支。`live` 态没有"发布时"这个时间点，`title_snapshot`
  //   /`status_at_publish` 取的是**当前**值（live 态语义上等价于"此刻的快照"），`commits` 取当前
  //   `sys_issue_dev_commits` 全部现存行（与 `snapshotReleaseCommitsInTxn` 写入时的查询逐字同构，未发布
  //   前这份数据本就在持续变化，是 live 态的正常语义，不是伪造）。
  //
  //   **完整性校验的独立锚点**（§6.6a）：不能拿快照表的行数比自己（那样任何整体缺失都会"自认完整"）——
  //   用同一次发布事务里必然写入的 `release_published` timeline 行数作独立锚点（`_publishReleaseCoreInTxn`
  //   步骤4对每个发布成员各写一条，见其函数体，与快照写入同一事务，数量天然对等）。快照行数≠该锚点行数，
  //   或任一行解析失败/`schema_version` 非 2/必需字段缺失 → 整体判 `degraded`（**不允许部分快照当完整返回**，
  //   §6.6a 原话）。
  //
  //   **降级路径"不伪造字段"**（任务 A 硬要求）：timeline 载荷解析失败或字段缺失时，对应字段回填 `null`
  //   （不是猜测值/不是默认值），字段名进 `unavailable_fields`——与 C2b 对 timeline JSON 解析失败的处理精神
  //   一致（那处也是"解析不出来就如实说解析不出来"，不拿兜底文案冒充真实内容）。
  //
  //   **调用契约**：`release` 至少含 `{id, status}`——多数调用方（GET /sys-releases、GET /sys-releases/:id）
  //   本就已查过 release 主行，直接传入，不重复查一次 `SELECT status FROM sys_releases`。`status` 严格
  //   校验值域（[C5 收口批·codex 203 审 B 项]：此前只校验 `id`，`status` 缺失/拼写错/传了非法值时会被
  //   `!== '已发布'` 静默当 `live` 处理——对一个真实已发布批次会因此错读"当前可变值"而非发布时冻结值，
  //   是隐蔽的脏读，非"读源判定分支"意义上的第三态）。
  //
  //   **`opts.countOnly`**（[C5 收口批·codex 203 审 C 项]）：仅需成员数/`source`/`degraded`（如批次列表）
  //   时置 `true`——跳过组装完整 `members[]`（live 态跳过 commits JOIN；snapshot/degraded 态跳过逐条构造
  //   返回对象）。⚠️ 三态判定本身（live/snapshot 完整性校验/degraded 判定的每一步条件）**逐字复用同一段
  //   代码**，`countOnly` 只影响"要不要把已经算出的结果塞进返回数组"这一步，不是另写一套更"轻"的判定
  //   逻辑——避免两套判定各自演进后悄悄漂移（两次真实业务事故的教训模式，本函数从设计起就要防）。
  async function getReleaseMembers(release, opts = {}) {
    if (!release || !release.id) {
      throw new Error('getReleaseMembers: release.id 必填（调用方须先查到 release 行再传入，不接受裸 id）');
    }
    if (release.status !== '计划中' && release.status !== '已发布') {
      throw new Error(`getReleaseMembers: release.status 非法（须为「计划中」或「已发布」），实际=${JSON.stringify(release.status)}——调用契约要求传入真实 release 行，不接受缺失/伪造 status（脏读防线，见函数头注释）`);
    }
    const releaseId = release.id;
    const countOnly = !!opts.countOnly;

    if (release.status !== '已发布') {
      // ── live：计划中 ──
      const rows = await dbAllAsync(
        countOnly
          ? `SELECT id AS issue_id FROM sys_issues WHERE release_id = ? ORDER BY id ASC`
          : `SELECT id AS issue_id, type, title AS title_snapshot, status AS status_at_publish
               FROM sys_issues WHERE release_id = ? ORDER BY id ASC`,
        [releaseId]
      );
      if (countOnly) {
        return { count: rows.length, source: 'live', degraded: false, unavailable_fields: [], duplicate_release_published: [], duplicate_release_published_conflict: [] };
      }
      if (rows.length === 0) {
        return { members: [], source: 'live', degraded: false, unavailable_fields: [], duplicate_release_published: [], duplicate_release_published_conflict: [] };
      }
      // commits：与 snapshotReleaseCommitsInTxn 写入时同构查询（当前全部现存行，含软删实例，方案 §8 明文），
      // 批量查询后按 issue_id 分组（N 单一次查询，非逐单 N 次往返）。
      const issueIds = rows.map(r => r.issue_id);
      const ph = issueIds.map(() => '?').join(',');
      const commitRows = await dbAllAsync(
        `SELECT issue_id, id AS commit_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at, updated_at
           FROM sys_issue_dev_commits WHERE issue_id IN (${ph}) ORDER BY id ASC`,
        issueIds
      );
      const commitsByIssue = new Map(issueIds.map(id => [id, []]));
      for (const c of commitRows) {
        const { issue_id, ...rest } = c;
        commitsByIssue.get(issue_id).push(rest);
      }
      const members = rows.map(r => ({ ...r, commits: commitsByIssue.get(r.issue_id) || [] }));
      return { members, source: 'live', degraded: false, unavailable_fields: [], duplicate_release_published: [], duplicate_release_published_conflict: [] };
    }

    // ── 已发布：优先快照表，完整性校验（countOnly 与否共用本段全部判定代码，见函数头注释）──
    const snapRows = await dbAllAsync(
      `SELECT issue_id, snapshot_json FROM sys_issue_release_commit_snapshots WHERE release_id = ? ORDER BY issue_id ASC`,
      [releaseId]
    );
    // 独立锚点：release_published timeline 行（同一发布事务内与快照同步写入，数量=真实发布成员数）。
    // [C9 二次收口·codex 207 审 MED-1] `ORDER BY issue_id ASC, id ASC`——补第二排序键（`id` 是本表自增
    //   主键，天然反映写入先后）。仅 `issue_id ASC` 时，同 issue_id 的多行彼此顺序由 SQLite 隐式决定
    //   （未定义、不保证跨查询稳定），下方"去重取首条"若不加这道稳定排序，脏数据下"首条"到底是哪条会
    //   随机漂移；加上 `id ASC` 后"首条"确定=该 issue_id 最早写入的那一行，可复现、可解释。
    const publishedTlRows = await dbAllAsync(
      `SELECT issue_id, summary FROM sys_issue_timeline
         WHERE ref_id = ? AND event_type = 'scope_change' AND action_code = 'release_published'
        ORDER BY issue_id ASC, id ASC`,
      [releaseId]
    );
    const expectedIds = new Set(publishedTlRows.map(r => r.issue_id));

    // [C5 收口批·codex 203 审 A 项] 补 `snapRows.length===publishedTlRows.length` 直接比对（不依赖
    //   expectedIds 去重后的 `.size`）——当前快照表 `UNIQUE(release_id,issue_id)` + 发布 CAS
    //   `WHERE status='计划中'` 双防线下，publishedTlRows 出现同 issue_id 重复行理论不可达，本条与
    //   `snapRows.length===expectedIds.size` 恒等价，是纯防御纵深（廉价，不依赖去重语义）；C6 若允许
    //   reopen 后复用同一 release_id 二次发布，会让两者真正分叉，到时这条判定才会成为救命的那一条。
    let complete = expectedIds.size > 0
      && snapRows.length === expectedIds.size
      && snapRows.length === publishedTlRows.length;
    const snapMembers = [];
    if (complete) {
      for (const row of snapRows) {
        if (!expectedIds.has(row.issue_id)) { complete = false; break; }   // 快照行不在预期集合内（脏数据防线）
        let parsed;
        try { parsed = JSON.parse(row.snapshot_json); } catch (_) { complete = false; break; }
        if (!parsed || parsed.schema_version !== 2) { complete = false; break; }
        if (parsed.type == null || parsed.title_snapshot == null || parsed.status_at_publish == null || !Array.isArray(parsed.commits)) {
          complete = false; break;
        }
        if (!countOnly) {
          snapMembers.push({
            issue_id: row.issue_id, type: parsed.type, title_snapshot: parsed.title_snapshot,
            status_at_publish: parsed.status_at_publish, commits: parsed.commits,
          });
        }
      }
    }
    if (complete) {
      return countOnly
        ? { count: snapRows.length, source: 'snapshot', degraded: false, unavailable_fields: [], duplicate_release_published: [], duplicate_release_published_conflict: [] }
        : { members: snapMembers, source: 'snapshot', degraded: false, unavailable_fields: [], duplicate_release_published: [], duplicate_release_published_conflict: [] };
    }

    // ── degraded：回落 timeline release_published 载荷重建；解析失败/字段缺失一律 null，不伪造 ──
    // [C9 任务C·codex 207 审 MED-3 防御，二次收口·codex 207 复审 MED-1/LOW-1 修正] publishedTlRows 按
    //   issue_id 去重——正常路径下一个 issue_id 只会有一条 release_published timeline 行（同一次发布事务
    //   写一次，_publishReleaseCoreInTxn 头部注释声明的"同一 release_id 永不二次发布"不变量保证不会有
    //   第二次发布产生第二条）。此处去重是脏数据兜底（历史遗留/手工改库/该不变量未来被破坏），**去重
    //   不静默、也不假定重复行内容一致**：
    //   - `duplicate_release_published`：出现重复行的 issue_id 去重后数组（语义="哪些 issue 出现了重复
    //     行"，每个 issue_id 至多出现一次——不随重复行数量线性增长，3 条重复行也只计 1 次）。
    //   - `duplicate_release_published_conflict`：上面这个集合的**子集**——重复行之间 summary 字节不相同
    //     （逐字符串比较，两次 JSON.stringify 同一份逻辑数据在本项目写入路径下天然产出相同字符串，见
    //     snapshotReleaseCommitsInTxn/本函数上方写入处，故字符串不等 ⟺ 内容真不同，不需要反序列化后
    //     深度比较）。conflict 情形下"取哪条"不再是无关紧要的选择——本函数保留 `issue_id ASC, id ASC`
    //     稳定排序下的**首条**（该 issue_id 最早写入的一行），可复现、可解释，但**不代表内容必然正确**，
    //     这正是 conflict 诊断字段存在的意义：把"存在分歧、我武断选了一条"如实报给调用方，不伪装成
    //     "反正都一样选哪条都无所谓"。
    const seenPubSummary = new Map();   // issue_id → 保留（首条）行的 summary，供后续行比对是否冲突
    const dupPubIdSet = new Set();
    const conflictPubIdSet = new Set();
    const dedupedTlRows = [];
    for (const row of publishedTlRows) {
      if (seenPubSummary.has(row.issue_id)) {
        dupPubIdSet.add(row.issue_id);
        if (seenPubSummary.get(row.issue_id) !== row.summary) conflictPubIdSet.add(row.issue_id);
        continue;
      }
      seenPubSummary.set(row.issue_id, row.summary);
      dedupedTlRows.push(row);
    }
    const dupPubIds = [...dupPubIdSet];
    const conflictPubIds = [...conflictPubIdSet];
    if (countOnly) {
      // 成员数 = dedupedTlRows.length（去重后，与下方完整路径的成员数枚举依据一致）——不逐行解析 summary
      // 构造完整对象，unavailable_fields 对列表视图无意义故给空数组（非另一套判定：上面 `complete` 已判定
      // 为 false 的过程与完整路径逐字相同，这里只是不做后续组装）。
      return { count: dedupedTlRows.length, source: 'degraded', degraded: true, unavailable_fields: [], duplicate_release_published: dupPubIds, duplicate_release_published_conflict: conflictPubIds };
    }
    const degradedMembers = [];
    const unavailable = new Set();
    for (const row of dedupedTlRows) {
      let parsed = null;
      try { parsed = JSON.parse(row.summary); } catch (_) { parsed = null; }
      if (!parsed || parsed.schema_version !== 2) {
        // 整条载荷不可用——issue_id 本身来自 timeline 行本身（可信，非载荷内容），其余字段全部标不可用。
        degradedMembers.push({ issue_id: row.issue_id, type: null, title_snapshot: null, status_at_publish: null, commits: null });
        unavailable.add('type'); unavailable.add('title_snapshot'); unavailable.add('status_at_publish'); unavailable.add('commits');
        continue;
      }
      const member = { issue_id: row.issue_id };
      for (const f of ['type', 'title_snapshot', 'status_at_publish']) {
        if (parsed[f] === undefined || parsed[f] === null) { member[f] = null; unavailable.add(f); }
        else member[f] = parsed[f];
      }
      if (!Array.isArray(parsed.commits)) { member.commits = null; unavailable.add('commits'); }
      else member.commits = parsed.commits;
      degradedMembers.push(member);
    }
    // dedupedTlRows 为空（快照与 timeline 双双缺失的极端脏数据）→ members=[] 但 degraded 仍为 true——
    // "该有却什么都读不到"与"真的没有"是两回事，不能悄悄当"合法空批次"处理（RELEASE_EMPTY 早挡，正常
    // 路径不可达已发布空批次，此处属兜底防线，即使 unavailable 集合空也不改变 degraded=true 的判定）。
    return { members: degradedMembers, source: 'degraded', degraded: true, unavailable_fields: [...unavailable], duplicate_release_published: dupPubIds, duplicate_release_published_conflict: conflictPubIds };
  }

  // ── C2（commit号两列 20260803·锚点 D1/D5）：从 getReleaseMembers() 的 member.commits 派生单组 commit 编码。
  //   三分支的 commits 形状（已逐一核实，非推测）：
  //     live      → 恒数组（`WHERE issue_id IN (...) ORDER BY id ASC` 批量查后按 issue 分组，无匹配为 []）
  //     snapshot  → 恒数组（入口处 `!Array.isArray(parsed.commits)` 已判 degraded，能走到这里必是数组）
  //     degraded  → **可能是 null**（载荷整条不可用 :7581 / commits 非数组 :7590，两处都同时把 'commits'
  //                 加进 unavailable_fields）
  //   ⚠️ 因此 commits 非数组时**返回 null 而不是 []**：degraded 的「读不出来」与正常的「这单没有 commit」
  //     是两件事，用同一个 [] 表示会让前端无法区分，等于伪造了"该单确实没提交代码"这个事实——违反
  //     §6.6a「降级路径不伪造字段」（同 :7430 注释精神）。前端另可查 unavailable_fields 是否含 'commits'。
  //   ⚠️ 返回**真数组**（非 JSON 字符串）——与列表端点 GET /sys-issues 的 frontend_commit_refs 是字符串
  //     形态**刻意不同**：那边受 SQL 层限制只能出 JSON 文本，这边是 JS 层派生，再 stringify 让前端 parse
  //     是无意义的序列化往返。前端共享 helper 统一接受"已解析的数组"，由各调用方负责把自己的形态解析好。
  //   顺序：commits 本身已按 id ASC（live 的 SQL 排序 / 快照写入时的 ORDER BY id ASC），filter 保序，
  //     故派生结果天然是录入顺序，与列表端点同源。
  //   ⚠️ 元素级校验（codex 审 242 risks-2 收口）：只收 commit_ref 为**非空字符串**的元素。degraded 分支的
  //     commits 来自 timeline 载荷，是脏数据兜底路径——若某元素缺 commit_ref，不加这道过滤会 map 出
  //     `undefined`、JSON 序列化成 `null`，前端渲染出空白或字面量 "null"。丢弃坏元素而非整组判空：
  //     同组里的好元素仍是真实事实，不该被一个坏元素连坐（与"不伪造字段"不冲突——那条管的是
  //     "读不出来别说成空"，这条管的是"别把读不出来的单个元素冒充成一个 ref"）。
  function refsByComponent(commits, component) {
    if (!Array.isArray(commits)) return null;
    return commits
      .filter(c => c && c.component === component && typeof c.commit_ref === 'string' && c.commit_ref.trim() !== '')
      .map(c => c.commit_ref);
  }

  // ── §6.9 release_type 类型派生：从 getReleaseMembers() 的返回结果派生，不回落读当前任务表/存量
  //   release_type 列——那一列已"停止作为可写事实"（§6.9，本函数是它的读端替代）。三值：
  //   `{category:'single', type:'bug'|'feature'|'improvement'}` / `{category:'mixed', type:null}` /
  //   `{category:'unknown', type:null}`（members 为空，或 type 字段已在 unavailable_fields 中——降级且
  //   type 不可用时，此时即使 members[].type 恰好非 null 也不可信任，必须先查 unavailable_fields 短路，
  //   不能只看字段值本身是否为空来判断，方案原话"不回落读当前任务表"正是防止这种情形下悄悄信了脏值）。
  function deriveReleaseType(gm) {
    if (!gm) return { category: 'unknown', type: null };
    if (gm.unavailable_fields && gm.unavailable_fields.includes('type')) return { category: 'unknown', type: null };
    if (!gm.members || gm.members.length === 0) return { category: 'unknown', type: null };
    const types = new Set(gm.members.map(m => m.type).filter(t => t != null));
    if (types.size === 0) return { category: 'unknown', type: null };   // 防御：unavailable_fields 未标但值仍全空
    if (types.size > 1) return { category: 'mixed', type: null };
    const only = [...types][0];
    return RELEASABLE_TYPES.includes(only) ? { category: 'single', type: only } : { category: 'unknown', type: null };
  }

  // ============================================================
  // 上线体统一重构 C2a（方案 v3.4 §6.3a/§6.10/§6.11/§10.2）：通知状态机共享原语
  // ============================================================

  // ── 上线资格判定（§6.3a）：存在 ∧ status='active' ∧ role∉('viewer','admin')，**每次实时读库**，
  //   不接受调用方传入的"已验证"标记（§6.10 中心守卫不变量）。 ──────────
  async function hasReleaseEligibility(userId) {
    if (!userId) return false;
    const u = await dbGetAsync('SELECT status, role FROM users WHERE id = ?', [userId]);
    return !!(u && u.status === 'active' && u.role !== 'viewer' && u.role !== 'admin');
  }

  // [C4b 删除·H1 根治] 批次级 staleTransitionForRelease（转 release_assignee_notify_status 的惰性 stale
  //   转换）已整体删除——批次级通知机制随本轮退场全灭后，全项目再无任何写路径会把这一列写成 'sending'，
  //   该函数原本要转换的目标态从此结构性不可达，继续保留是一段永远不会命中任何行的死 UPDATE。三个原调用
  //   点均已随各自宿主一并处置：notify-executor 路由整体删除（原调用点随路由删除）；cancel-schedule 的
  //   调用直接移除（见该路由 MED-3 改造注释）；update-planned-date 的调用同样直接移除（该端点从不消费
  //   本次转换的结果，只是"写路径统一先做一次惰性转换"这条既有审计习惯的收尾，习惯所依附的机制已不存在）。

  // ── 行级 stale 惰性转换（C2·预筛 L8）：沿用批次级前身留下的 -5 分钟窗口口径（该常量本身不随批次级
  //   机制退场——同一域的超时语义仍然成立，只是承载它的列从批次级单列换成了子表逐行）——CHECK 的 stale 裸分支
  //   （§4.1 定稿："stale 分支刻意无附加条件：它由 sending 惰性转换而来，只改 status 不动其余列"）
  //   正是为这种"只改一列"的转换设计。函数化两个粒度供 C3/C4 复用：
  //   - staleTransitionForExecutorRow(releaseId, userId)：单行，按 (release_id,user_id) identity tuple
  //     定位（不要求调用方先查出内部行 id——路由天然就有这两个值，与批次级"按 releaseId 一路到底"
  //     的调用习惯一致，本通知端点入口即用此签名）。
  //   - staleTransitionForExecutorRelease(releaseId)：批量，转换某批次下全部超窗 sending 行，供"打开批次
  //     详情/撤销上线安排先兜底刷一遍"这类整批场景复用（C2 本身不接线，留给 C3/C4——L1 订正：已按原计划
  //     落地，详情端点 GET /sys-releases/:id〔:9237〕+ cancel-schedule〔:9828，C4b 305 号 M3〕两处接线，
  //     execute 确认端点仍刻意不接，见该路由处 LOW-4 登记说明）。
  async function staleTransitionForExecutorRow(releaseId, userId) {
    await dbRunAsync(
      `UPDATE sys_release_executors SET notify_status = 'stale'
         WHERE release_id = ? AND user_id = ? AND removed_at IS NULL AND notify_status = 'sending'
           AND notify_started_at < datetime('now','localtime','-5 minutes')`,
      [releaseId, userId]
    );
  }
  async function staleTransitionForExecutorRelease(releaseId) {
    await dbRunAsync(
      `UPDATE sys_release_executors SET notify_status = 'stale'
         WHERE release_id = ? AND removed_at IS NULL AND notify_status = 'sending'
           AND notify_started_at < datetime('now','localtime','-5 minutes')`,
      [releaseId]
    );
  }

  // ── 通知态聚合派生（方案 §4.3，C4a 新增）：批次级不再落列，改由子表实时聚合。带优先级的顺序判定，
  //   自上而下命中即返回，结构上不可能落空（六态判定表逐字照方案 §4.3）：
  //     1 无在册行 → 'none'；2 存在 sending → 'sending'；3 全部 sent → 'sent'；4 全部 not_sent → 'not_sent'；
  //     5 存在至少一个 sent（且不全是、无 sending）→ 'partial'；6 以上皆不命中（必含 failed/stale）→ 'failed'。
  //   `deriveExecutorNotifySummary`：纯函数，调用方已手头有在册行数组时用（省一次查询，如 hotfix-publish
  //   两处"重复调用"分支复用同一份 execRows）；`getReleaseNotifySummary`：DB 查询版，供只要聚合值、没有
  //   现成行数组的调用方（列表类端点）直接复用，两者共享同一判定逻辑，不重复实现两套优先级表。
  function deriveExecutorNotifySummary(execRows) {
    if (!execRows || execRows.length === 0) return 'none';
    // 307 号 M2（codex 对抗审）：改显式计数实现——原 `.some()/.every()` 直接读 `r.notify_status`，若数组里
    //   混进 `null`/`undefined` 元素（正常 DB 查询结果不会有，但本函数是纯函数、"execRows 已手头有在册行
    //   数组"的调用方不受限于 SQL 查询形状，理论上能传入畸形数组）会在 `r.notify_status` 处直接抛
    //   TypeError，而不是优雅地落到某个业务态——抛异常不是"fail-closed"，是端点整个 500，比误判更糟。
    //   `r && r.notify_status` 把畸形元素（null/undefined 本身，或对象但缺 notify_status 字段）归一成
    //   JS 的 `undefined`，不抛异常也不会意外撞上任何合法枚举值，天然落不进 sent/not_sent 全等分支——
    //   与下方 SQL CASE 的正向计数法（COUNT(*)=SUM(CASE...)）同一 fail-closed 精神的 JS 版实现，防三方
    //   （JS/DB/SQL）在这类边界输入上分道扬镳。
    const statuses = execRows.map(r => r && r.notify_status);
    const total = statuses.length;
    let sendingCount = 0, sentCount = 0, notSentCount = 0;
    for (const s of statuses) {
      if (s === 'sending') sendingCount++;
      else if (s === 'sent') sentCount++;
      else if (s === 'not_sent') notSentCount++;
      // 其余（域外脏字符串/undefined/任何非四枚举值）不计入任何桶——正是这一步让畸形/脏值行既不能
      // 假装成"全 sent"也不能假装成"全 not_sent"，只会拉低对应桶的计数、把结果推向 partial/failed。
    }
    if (sendingCount > 0) return 'sending';
    if (sentCount === total) return 'sent';
    if (notSentCount === total) return 'not_sent';
    if (sentCount > 0) return 'partial';
    return 'failed';
  }
  async function getReleaseNotifySummary(releaseId) {
    if (!releaseId) return 'none';
    const rows = await dbAllAsync(
      `SELECT notify_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL`,
      [releaseId]
    );
    return deriveExecutorNotifySummary(rows);
  }

  // [C5 删除] syncReleaseLegacyMirror（§10.2·C2-C4 过渡期双写兼容函数）已整体删除——曾把 sys_releases
  //   批次级执行人/通知态镜像到 sys_issues 旧单级 8 列（release_assignee_id/name + release_assignee_
  //   notify_status/notified_at/message_key/error/read_at + release_assignee_notify_sent_by）。
  //   删除依据（§10.1"双写期到 C4 终止"）：C4 已把 getReleaseMembers() 唯一读源接入全部"列表/详情/导出/
  //   统计/类型派生"消费者（见 C4 完成报告），全项目 grep 确认**没有任何消费者依赖这份镜像**——本次删除
  //   前逐处核对了读消费者（见 C5 完成报告 §1），原两处调用点（applyReleaseChange 步骤⑥ /
  //   sendReleaseNotifyAndWriteback ②步）已一并删除，改动见各自函数体内注释。
  //   ⚠️ 这 8 列本身**保留在 schema 里**（不 DROP，§项目"不再 drop 重建"铁律）。[2026-07-30 用户裁定后
  //   补记] C5 当时不能笼统宣称"完全只读"——另一套独立的旧上线编排机制（assign-release-dev 等 4 端点）
  //   仍在读写；该家族现已全部封禁（见"旧上线编排退场段"），8 列业务写路径全封转只读残留（唯一残留
  //   写点=notify-read-status 已读固化 read_at，仅历史 sent 数据可达），见 schema 定义处注释。

  // ── applyReleaseChange 原语（§6.11 七步，假定调用方已在 mutex 事务内）：────────────────────────────
  //   ① 校验单 status='计划中'（防御性重查——调用方通常已查过一次，这里是同一事务内的第二道闸，成本极低）
  //   ② 读旧执行人（供 timeline 记旧值/§6.8 撤销安排文案）——本函数不重读成员集/planned_date，那些是
  //      调用方已经知道的东西（差量本就由调用方算好传入）
  //   ③ **CAS 应用变更**：add-issues/remove-issues 的实际变更（sys_issues.release_id）与
  //      update-planned-date 的实际变更（sys_releases.planned_date）**均已由调用方在调用本函数之前完成**
  //      （"现有逻辑加单成功后经原语收尾"——族别守卫/needs_release 条件一概不动，C3 才拆）；
  //      **仅 cancel-schedule** 的实际变更（§6.8 CAS 重置）也由调用方自己做（因为它需要比本函数默认重置
  //      更强的 CAS 保护：与预读的 notify_status/release_assignee_id/token 逐列比对），并通过
  //      `opts.skipReset=true` 告知本函数"重置已完成，不要重复做"。
  //   ④ 差量已由调用方结构化传入（`delta`），本函数只负责判定是否全空
  //   ⑤ 差量非空 → 重置通知六列 + 清执行人两列 + 换 token（除非 opts.skipReset 或 opts.keepExecutor——
  //      后者是 2026-07-31 用户拍板"执行人移单保留身份继续执行"专用，见 remove-issues 端点与本函数内实现）
  //   ⑥ 双写兼容：当前成员（含新增）∪ 明确移除的旧成员，一律清空旧单级 8 列
  //   ⑦ 按差量写 timeline（event_type='scope_change'，每受影响成员一条，同 ref_id=releaseId + 同批次标识）
  //   差量全空 → 直接返回（幂等：不清通知、不写 timeline）。任一步失败抛错，由调用方 catch 整体 ROLLBACK。
  async function applyReleaseChange(releaseId, actor, delta, opts = {}) {
    const addedIds = delta.added_issue_ids || [];
    const removedIds = delta.removed_issue_ids || [];
    // ⚠️ codex 199 审 LOW-1（组合语义焊死为显式契约）：add/remove/改期/撤销安排四类 delta 信号
    //   **至多一类为真**——四个调用方（add-issues/remove-issues/update-planned-date/cancel-schedule）
    //   各自天然只触发其中一类，本函数从未设计过"同一次调用里同时加单又改期"这种混合语义（若真出现，
    //   §6.11 七步的"重置/双写/timeline"该按哪类文案写都没有定义）。
    //   不是业务错误（不该让用户看到 400），是**编程契约违反**——某调用方传错了参数，直接抛 500 级异常，
    //   越早炸越好，别让"组合语义未定义"悄悄按某一类的逻辑跑出一个看似正常但实际错误的结果。
    const activeKinds = [addedIds.length > 0, removedIds.length > 0, !!delta.planned_date_changed, !!delta.schedule_cancelled]
      .filter(Boolean).length;
    if (activeKinds > 1) {
      throw new Error(`applyReleaseChange 契约违反：delta 组合语义未定义——added_issue_ids/removed_issue_ids/planned_date_changed/schedule_cancelled 至多一类非空/为真，实际同时命中 ${activeKinds} 类（releaseId=${releaseId}）`);
    }

    // C4b（H1 根治）：SELECT 不再取 release_assignee_id/release_assignee_notify_status——旧六列重置块
    //   已随批次级通知机制整体退场删除（见下方 opts.skipReset 分支），本函数体内再无任何地方读这两列。
    //   release_assignee_name 保留：cancel-schedule 的 MED-1 兜底（子表为空回落旧列）永久保留，需要它。
    const rel = await dbGetAsync(
      `SELECT id, status, release_assignee_name FROM sys_releases WHERE id = ?`,
      [releaseId]
    );
    if (!rel) throw new SysTransitionError(404, 'RELEASE_NOT_FOUND', '上线批次不存在');
    if (rel.status !== '计划中') throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次非「计划中」，不能变更');

    // [C5 删除] 双写兼容镜像调用（syncReleaseLegacyMirror）已删除——§10.1"双写期到 C4 终止"，见函数删除处
    //   注释。currentMembers 查询保留，且**提前到 isEmpty 判断之前**（2026-07-31 codex 审 MED-2）：下方
    //   opts.keepExecutor 的 fail-closed 契约检查需要它判断"移除后批次是否仍非空"——本查询查的就是
    //   "当前"（调用方已在调用本函数之前完成删除）成员集，timeline 阶段 planned_date_changed/
    //   schedule_cancelled 两个分支继续复用同一份结果，不重复查询。
    const currentMembers = await dbAllAsync('SELECT id FROM sys_issues WHERE release_id = ?', [releaseId]);

    // [2026-07-31 codex 审 MED-2 采纳] opts.keepExecutor 契约级 fail-closed 检查——对齐上面 activeKinds
    //   "编程契约违反直接抛异常，越早炸越好"的风格：keepExecutor 只允许"执行人本人移单、且移除后批次
    //   仍非空"这一种场景使用，防未来其他调用方（加单/改期/撤销上线安排等）误传 keepExecutor，导致一个
    //   本该被重置的过期 sent 态被悄悄保留下来（执行人已经不该再对着一个语义已变化的批次"当场继续执行"）。
    //   五个子条件均为必要条件，逐条显式核对（不依赖调用方"应该没传错"的假设）：
    //   ① removedOnly：虽然上面的 activeKinds 互斥检查已保证至多一类 delta 为真，但那只挡"同时命中多类"，
    //      没规定命中的到底是哪一类——这里显式绑定必须是 removedIds 那一类，堵住"改期/撤销安排误传
    //      keepExecutor"这种活得下来的漏网场景。
    //   ② remove_by_executor：必须是执行人分支产生的移除（admin 分支永远不传 keepExecutor，双重锁定）。
    //   ③ assigneeMatches / ④ notifiedSent：rel 这次 SELECT 读到的必须是"当前仍是 sent 态、且执行人正是
    //      本次操作者"——不是缓存值、不是调用方口头保证。
    //   ⑤ nonEmptyAfterRemoval：currentMembers 是调用方完成删除**之后**的当前成员集，非空才谈得上"保留
    //      身份继续执行"，否则应当走完整重置（sent∧空成员不可达的常态不能被本分支破坏）。
    //   C4a（方案 §4.4 改造 7）：③④两条子条件由旧单列比对（assigneeMatches/notifiedSent，均读
    //   sys_releases 批次级单列）改子表在册行查询——actor 须是本批次子表在册（removed_at IS NULL）且该行
    //   notify_status='sent'，与 remove-issues 端点自身的前置守卫（同批 C4a 改造）同一判据来源，不新造
    //   第二套口径。**保留全体在册行**（不只 actor 一人）——本分支只决定"要不要重置"，不涉及逐行去留，
    //   子表本身在下方 `!opts.keepExecutor` 判断为 false 时天然不会被软删，全体在册行随之原样保留。
    if (opts.keepExecutor) {
      const removedOnly = removedIds.length > 0 && addedIds.length === 0
        && !delta.planned_date_changed && !delta.schedule_cancelled;
      const isExecutorRemove = delta.remove_by_executor === true;
      const actorExecRow = await dbGetAsync(
        `SELECT notify_status FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL`,
        [releaseId, actor.id]
      );
      const actorInRoster = !!actorExecRow;
      const notifiedSent = !!actorExecRow && actorExecRow.notify_status === 'sent';
      const nonEmptyAfterRemoval = currentMembers.length > 0;
      if (!removedOnly || !isExecutorRemove || !actorInRoster || !notifiedSent || !nonEmptyAfterRemoval) {
        throw new Error(
          `applyReleaseChange 契约违反：opts.keepExecutor 仅允许"执行人本人移单且移除后批次仍非空"场景使用——` +
          `releaseId=${releaseId} 命中：removedOnly=${removedOnly}, remove_by_executor=${isExecutorRemove}, ` +
          `actorInRoster=${actorInRoster}, notifiedSent=${notifiedSent}, nonEmptyAfterRemoval=${nonEmptyAfterRemoval}`
        );
      }
    }

    const isEmpty = addedIds.length === 0 && removedIds.length === 0
      && !delta.planned_date_changed && !delta.schedule_cancelled;
    if (isEmpty) return { applied: false };

    // ⚠️ opts.skipReset=true 时（cancel-schedule），调用方在调用本函数**之前**已自行完成子表软删——
    //   本函数不再信自己的这次 SELECT 去猜"旧执行人是谁"，必须由调用方通过 opts.oldAssigneeName 显式
    //   传入它自己重置前捕获的旧值（cancel-schedule 传的是 MED-1 兜底后的 executorNamesText）。
    //   opts.keepExecutor=true 时（2026-07-31 用户拍板，remove-issues 执行人分支·剩余成员>0）：调用方
    //   压根不做任何重置——rel 这次 SELECT 读到的仍是"当前"（未被任何人动过）的真实值，故沿用与"既不
    //   skipReset 也不 keepExecutor"相同的取值路径（rel.release_assignee_name），不需要单独分支。
    //   ⚠️ C4b（用户裁定，见交接指令第 5 条）：oldAssigneeId 已删除——原值来自 rel.release_assignee_id，
    //   全项目 grep 核实零消费者（既不进 timeline 文案，也没有调用方读取本函数返回的 old_assignee_id
    //   字段），是纯历史占位，随批次级列整体退场一并清理，不留死值。
    const oldAssigneeName = opts.skipReset ? opts.oldAssigneeName : rel.release_assignee_name;

    // C4a（Opus 预筛 MED-3）：软删前先算 doneNames——供下方 release_add/release_date_change/release_remove
    //   三条 timeline 附记"已丢弃 N 条完成确认"，不静默丢事实。**裁定：不加二次确认闸**（与 cancel-schedule
    //   的 confirm_discard_done 不同）——加单/改期/admin 移单都是高频常规操作，若也叠一道"发现有人已确认
    //   完成就拦下要求二次确认"，会让日常操作摩擦陡增；这三类操作的"重置执行人"本就是既有行为（改造前
    //   就会重置旧单列），本次只是把"重置连带丢弃了谁的完成确认"这件事从静默变为留痕可见，留痕已经满足
    //   "不静默丢事实"的底线，加闸是超出本次改造范围的产品决策，留给后续按需评估。
    let resetDoneNames = [];
    if (!opts.skipReset && !opts.keepExecutor) {
      const doneRowsForReset = await dbAllAsync(
        `SELECT user_name FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL AND exec_status = 'done'`,
        [releaseId]
      );
      resetDoneNames = doneRowsForReset.map(r => r.user_name);

      // C4b（H1 根治）：旧六列重置 UPDATE 已整体删除——本函数原先每次差量非空都联动重置一遍批次级 10
      //   列，如今这组列全项目已无任何写点（历史只读残留，见 schema 定义处注释），本函数不必再对着一组
      //   已冻结的死列白跑一次 UPDATE。子表软删全员（下方）单独承担"重置即清空、重新安排是全新一轮"这
      //   一件事，与旧列的存废彻底解耦。
      // L2（C4b 预筛，Opus 预筛 L11 处已预告"见 applyReleaseChange 内同款兜底注释"——此处补回缺失的另一
      //   半）：removed_by_name 用 resolveExecutorDisplayName 而不是直接传 actor.name，是防 actor.name
      //   恰为纯半角空格这类"非空但 trim 后为空"的 display_name——`||` 判真假值挡不住这种值（非空字符串
      //   本身是 truthy），若直接落库会撞本表 removed_by_name 的非空 CHECK（`length(trim(removed_by_name))
      //   > 0`）当场 500；resolveExecutorDisplayName 内部兜底到 username/uid，保证落库值必然非空白。
      await dbRunAsync(
        `UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?
           WHERE release_id = ? AND removed_at IS NULL`,
        [actor.id, resolveExecutorDisplayName({ display_name: actor.name }, actor.id), releaseId]
      );
    }
    const resetDiscardSuffix = resetDoneNames.length > 0
      ? `（已丢弃 ${resetDoneNames.length} 条完成确认：${resetDoneNames.join('、')}）`
      : '';

    // currentMembers 已在函数上方（isEmpty 判断之前）提前查询——供 opts.keepExecutor 契约检查复用，此处
    //   不再重复查询，下方 timeline 的 planned_date_changed/schedule_cancelled 两个分支直接沿用同一份结果。

    // timeline（§6.13）：每受影响成员各写一条，同 ref_id=releaseId 天然关联同一次调用产生的多行
    //   （sys_issue_timeline 按 ref_id 查询即可枚举——[C9 任务D·codex 207 审 LOW-1] 此前此处另生成过
    //   一个 batchKey 字符串，注释称"供日志/排障关联"，但既未落库也未 logger 输出，返回值也查无任何
    //   消费者（grep 全项目 batch_key/batchKey 零命中，四个调用方都是 `await applyReleaseChange(...)`
    //   未接收返回值）——是"承诺了却没兑现"的虚假注释，已随本次一并删除，不留假排障线索）。
    const timelineTargets = [];
    // C4a（Opus 预筛 MED-3）：resetDiscardSuffix 在有真实被丢弃的 done 行时才非空，附加到"通知与执行人
    //   已重置"这一类文案末尾——keepExecutor 分支（reset 未运行）resetDiscardSuffix 恒为空串，天然不出现。
    for (const iid of addedIds) timelineTargets.push({ issueId: iid, actionCode: 'release_add', summary: `加入上线批次，通知与执行人已重置${resetDiscardSuffix}` });
    // 2026-07-31 用户拍板（执行人移单四口径"仅时间线留痕"）：移除文案按"操作者角色 × 是否移空"分支——
    //   admin 分支维持改造前逐字文案（无 reason 时不变，有 reason 时追加原因，通知与执行人恒重置，
    //   因 admin 分支从不传 opts.keepExecutor）；执行人分支恒带 reason（端点已强制必填），按
    //   opts.keepExecutor 决定是否出现"通知与执行人已重置"字样——保留执行人时**不得**出现该字样
    //   （身份未被动），移空时才如实出现（keepExecutor 由 remove-issues 端点按剩余成员数算好传入）。
    for (const iid of removedIds) {
      let summary;
      if (delta.remove_by_executor) {
        summary = opts.keepExecutor
          ? `执行人移出上线批次（原因：${delta.remove_reason}）`
          : `执行人移出上线批次（原因：${delta.remove_reason}）；批次已移空，通知与执行人已重置${resetDiscardSuffix}`;
      } else {
        summary = delta.remove_reason
          ? `移出上线批次（原因：${delta.remove_reason}），通知与执行人已重置${resetDiscardSuffix}`
          : `移出上线批次，通知与执行人已重置${resetDiscardSuffix}`;
      }
      timelineTargets.push({ issueId: iid, actionCode: 'release_remove', summary });
    }
    if (delta.planned_date_changed) {
      for (const m of currentMembers) timelineTargets.push({ issueId: m.id, actionCode: 'release_date_change', summary: `上线计划日期变更，通知与执行人已重置${resetDiscardSuffix}` });
    }
    if (delta.schedule_cancelled) {
      const reasonTxt = delta.cancel_reason || '';
      // C4a（方案 §4.4 改造 5）：撤销上线安排若丢弃了已完成确认的执行人，timeline 如实附记「已丢弃 N 条
      //   完成确认：张三」——给撤销一个解锁通道，但不静默丢事实（delta.discarded_done_names 由
      //   cancel-schedule 端点在 confirm_discard_done 闸通过后传入，非空才附记，为空时无附加文本）。
      const discardedNames = Array.isArray(delta.discarded_done_names) ? delta.discarded_done_names : [];
      const discardSuffix = discardedNames.length > 0
        ? `；已丢弃 ${discardedNames.length} 条完成确认：${discardedNames.join('、')}`
        : '';
      for (const m of currentMembers) {
        timelineTargets.push({
          issueId: m.id, actionCode: 'release_schedule_cancel',
          summary: `撤销上线安排（原执行人：${oldAssigneeName || '（无）'}）原因：${reasonTxt}${discardSuffix}`,
        });
      }
    }
    for (const t of timelineTargets) {
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
         VALUES (?, 'scope_change', ?, ?, ?, ?, ?)`,
        [t.issueId, t.summary, t.actionCode, releaseId, Number(actor.id) || null, actor.name || null]
      );
    }

    return { applied: true, old_assignee_name: oldAssigneeName };
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

  // ── GET /sys-releases：批次列表（admin ∨ 对接人 = 全量；其他登录用户 = 仅「执行人=我」的批次；可选 status 筛选 + 含成员数）──────────
  // ⭐ C2b 第2批（Playwright 冒烟发现的真实缺口·非本次新引入）：middleware 由 requireAdmin 改为
  //   requireIntakeLiaison（admin ∨ 对接人）——对接人要能真实执行「撤销上线安排」（cancel-schedule，
  //   §6.8 明文 admin 不可用、仅对接人），前提是先能看到批次列表/详情本身；这两个 GET 端点此前仍锁
  //   requireAdmin（C2a 遗留，那时还没有 cancel-schedule 这个只属于对接人的动作），对接人点开「批次管理」
  //   会直接 403，功能完全不可达——纯只读放开，不影响任何写路径的权限边界（写端点各自维持原判据不变）。
  // ⭐ 执行人入口批（2026-07-31 用户拍板·v1.130.0 部署首日实测反馈）：执行人入口不能只活在钉钉深链上——
  //   登录后系统迭代页要有可见入口。下方 :id 端点注释里「列表端点刻意不做此扩展」的旧裁定被部分推翻：
  //   列表对**其他登录用户**开放，但行内过滤只返回 release_assignee_id=本人 的批次（含全部状态，供回看
  //   历史执行记录，同日拍板"含历史"）——"最小可见面"原则保持，只是从"零列表"放宽到"仅自己的行"，
  //   仍不向普通用户暴露全局上线计划。无关普通用户拿空数组而非 403（前端按"空则不显示入口"处理）。
  //   requireIntakeLiaison 中间件从本路由摘除、改行内 scope 分支（其余端点的该中间件不受影响）；
  //   响应新增 scope 字段（'all'|'mine'）供前端区分视角（面板标题/管理动作显隐）。
  router.get('/sys-releases', authenticateToken, requireSysSchemaReady, async (req, res) => {
    try {
      const actor = sysActor(req);
      const isFullScope = actor.role === 'admin' || isSysIntakeLiaison(actor.id);
      const where = [], params = [];
      if (req.query.status === '计划中' || req.query.status === '已发布') { where.push('r.status = ?'); params.push(req.query.status); }
      // C4a（方案 §4.4 #8）：批次维度 mine 过滤——单列等值 `r.release_assignee_id = ?`（旧批次级列，C1 起
      //   停写）→ 子表 EXISTS（`e.release_id = r.id`，与迭代单维度 `e.release_id = i.release_id` 不可混用，
      //   方案 §4.4 #11 复制陷阱）。scope=mine 含全部批次状态（供回看历史执行记录，见下方 issue_count 注释
      //   同一 07-31 拍板），但只认**当前在册**（removed_at IS NULL）——镜像旧单列语义：换人后旧执行人即
      //   丢失可见性（旧列被覆盖后天然查不到自己），子表同款不回看已软删的旧代次。
      if (!isFullScope) {
        where.push('EXISTS (SELECT 1 FROM sys_release_executors e WHERE e.release_id = r.id AND e.user_id = ? AND e.removed_at IS NULL)');
        params.push(Number(actor.id));
      }
      // SELECT 补执行人聚合列：mine 视角前端要渲染"待执行"徽章（status+notify_status 组合判断），all 视角
      //   列表也顺带能显示执行人——此前列表不返回执行人列，admin 只能逐个点详情看。
      //   ⚠️ C4a（方案 §4.4 #8）：r.release_assignee_id/name/release_assignee_notify_status 三列已冻结（C1
      //   起新批次恒 NULL/not_sent，PUT executors 不写它们）——保留原样只为历史已发布批次回看（§4.2"历史
      //   数据读路径保留"），**不再是权威通知态来源**。新增 executor_notify_summary 走子表实时聚合（方案
      //   §4.3 六态判定，getReleaseNotifySummary 同一判定函数，此处逐行调用，规模同 issue_count 的既有
      //   N+1 先例，管理端点数据量小可接受）。
      const rows = await dbAllAsync(
        `SELECT r.id, r.release_no, r.title, r.status, r.is_hotfix, r.release_note, r.version_tag,
                r.planned_date, r.released_at, r.created_by, r.created_by_name, r.created_at,
                r.release_assignee_id, r.release_assignee_name, r.release_assignee_notify_status
           FROM sys_releases r
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY r.id DESC`,
        params
      );
      for (const r of rows) { r.executor_notify_summary = await getReleaseNotifySummary(r.id); }
      // L7（待执行徽标精度）：mine 视角补「本人在该单 executor 子表在册行」的执行态，供前端把「待执行」徽标
      //   从"批次级 notify 聚合"精化为"批次级 ∧ 本人行未 done"——某执行人自己确认上线完成（exec_status='done'）
      //   后，其个人徽标熄灭，即使同批其他执行人尚未完成（各执行人各自视角）。done 唯一语义来源 = 本人在册行
      //   exec_status='done'（DDL 2.12 段 CHECK 值域仅 pending/done，done 必有合法 executed_at；与 R-GATE 双确认
      //   §4.3 「在册全员 exec_status='done'」判据同源，不另立 done 判据）。
      //   ⚠️ 仅 mine 视角计算并下发这两字段——full 视角（admin/对接人）是全局 oversight 面，维持批次级聚合徽标
      //   不受影响（前端另按 isMine 门控，full 视角本就拿不到该字段，双保险）。一次性 IN 批量查，不叠 N+1；
      //   在册唯一性由 idx_sys_release_exec_active 部分唯一索引保证（(release_id,user_id) removed_at IS NULL 至多一行），
      //   Map 不会被同 release 多行覆盖。mine 视角 EXISTS 过滤已保证每行都有本人在册行，`|| null` 仅防御性兜底。
      let myExecStatusByRelease = null;
      if (!isFullScope && rows.length) {
        myExecStatusByRelease = new Map();
        const relIds = rows.map(r => r.id);
        const placeholders = relIds.map(() => '?').join(',');
        const myRows = await dbAllAsync(
          `SELECT release_id, exec_status FROM sys_release_executors
            WHERE user_id = ? AND removed_at IS NULL AND release_id IN (${placeholders})`,
          [Number(actor.id), ...relIds]
        );
        for (const mr of myRows) myExecStatusByRelease.set(mr.release_id, mr.exec_status);
      }
      const myExecFields = (relId) => {
        if (!myExecStatusByRelease) return {};   // full 视角：不下发本人执行态字段（前端 isMine 门控 + 此处双保险）
        const st = myExecStatusByRelease.get(relId) || null;
        return { my_executor_status: st, my_executor_done: st === 'done' };
      };
      // 上线体统一重构 C4（方案 §6.6/§6.9 "列表 / 详情 / 导出 / 统计一律调用同一函数，禁止各自查询"）：
      //   issue_count 不再用 sys_issues 的相关子查询（那是纯 live 计数——「已发布」批次一旦有成员被 reopen
      //   （清 release_id，§6.4），live 计数会比"真实发布过的成员数"更小，与该批次的历史事实脱节）。改为
      //   逐行调用 getReleaseMembers()，其内部按 status 自动走 live/snapshot/degraded 三态正确读源。
      //   N+1：每行一次 getReleaseMembers 调用（内部 1-3 条子查询，视源而定）——与被替换的相关子查询同一
      //   量级的每行开销，本管理端点数据规模小（上线批次远非高频海量表），可接受，非本次引入新性能风险。
      //   [消费者策略·§6.6b] 列表视图按"详情页"同类对待——标注 degraded，不做统计口径的"排除"（那是统计/
      //   报表消费者的策略，列表只是给管理员一览，仍应可见，只是标出"这条的成员数是降级重建的，不一定准"）。
      //   [C5 收口批·codex 203 审 C 项] 列表只需要 issue_count/source/degraded，不需要组装完整
      //   members[]（type/title_snapshot/commits 等）——改用 `{countOnly:true}` 轻量路径（与详情端点的
      //   完整调用共用同一套三态判定代码，见 getReleaseMembers 函数头注释，非另写一套判定）。
      // 上线日志页需求（2026-07-31 用户拍板）：admin 专属 include_members=1——非 admin 传了也静默忽略
      //   （不报错，按未传处理）。成员读源仍走 getReleaseMembers() 统一函数（live/snapshot/degraded 三态），
      //   禁止另写查询（同 C4「列表/详情/导出/统计一律调用同一函数」纪律）。
      const wantMembers = req.query.include_members === '1' && actor.role === 'admin';
      const items = [];
      for (const r of rows) {
        if (wantMembers) {
          const gm = await getReleaseMembers({ id: r.id, status: r.status });
          // 字段映射对齐批次详情端点旧契约（id/type/title/status，见 GET /sys-releases/:id 注释）。
          const members = gm.members.map(m => ({ id: m.issue_id, type: m.type, title: m.title_snapshot, status: m.status_at_publish }));
          items.push({ ...r, issue_count: members.length, source: gm.source, degraded: gm.degraded, members, ...myExecFields(r.id) });
        } else {
          const gm = await getReleaseMembers({ id: r.id, status: r.status }, { countOnly: true });
          items.push({ ...r, issue_count: gm.count, source: gm.source, degraded: gm.degraded, ...myExecFields(r.id) });
        }
      }
      res.json({ items, total: items.length, scope: isFullScope ? 'all' : 'mine' });
    } catch (err) {
      logger.error('[系统迭代] 批次列表失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次列表查询失败' });
    }
  });

  // ── GET /sys-releases/executor-candidates：上线执行人候选清单（admin，方案 v1.7 §4.4 端点 1 + §4.5 第 1 条默认值后端解析）──
  //   ⚠️ 路由注册顺序铁律：本静态路径**必须**注册在下方 `GET /sys-releases/:id` 之前——Express 按注册
  //   顺序匹配，`:id` 是通配段，若本路由排在 :id 之后，"/sys-releases/executor-candidates" 请求会先命中
  //   :id 路由、把 "executor-candidates" 当 id 解析，直接 400 INVALID_RELEASE_ID，本路由永远不可达
  //   （C1 编码期间已实测踩中，故留此警示，防未来挪动顺序时重犯）。
  //   返回**全部 active 用户**（含无资格者，供前端置灰展示——不能只返回合格用户，否则前端渲染不出置灰项，
  //   方案 v1.2·M1 修正）。eligible/disabled_reason 复用 hasReleaseEligibility 同一判据（写读同源，不在本
  //   端点另起一套推导逻辑）。
  //   另解析双来源默认值（决策 8）：①排班=sys_release_duty_roster②固定默认人=system_configs 键
  //   sys_release_default_executor_ids（users.id 逗号串）。解析全在后端返回
  //   selected_by_default[]/default_source/skipped_defaults[]/duty_date_used 四字段，前端只展示不推断
  //   （v1.4·codex 254-C LOW-3）。任一来源失效只跳过该来源记入 skipped_defaults 含原因，不阻塞候选清单
  //   返回；默认值不参与任何门限判断，仅供前端预勾选。
  //   ⭐ C1-fix-1（主会话亲验实证纠偏，L11 订正）：排班口径不是"点开候选框那天"，是**上线那天谁值班谁
  //   默认被选**——业务语义 = 谁值班就该由谁经手当天的上线安排。C1 首版沿用的排班预取先例是彼时前端
  //   `siBatchDutyPreview`（按 `rel.planned_date` 查 `/sys-duty-roster?from=<planned_date>&to=<planned_date>`），
  //   该函数已随 C5 重写整体删除——选人已前移到本端点+选人弹窗，"打开详情页展示性预览排班"这层不再需要
  //   独立维护。duty 口径本身不变，只是承载它的前端函数换了：现由本端点自己按 planned_date/今天定位
  //   duty_date，经 `selected_by_default[]`/`duty_date_used` 两字段把口径完整交给选人弹窗（siExecutorPickerRender，
  //   Sys_Iteration.html），不再依赖任何独立的"预览"函数——C1 首版理解成"调用当天"（`date('now',
  //   'localtime')`）是误读，本次订正的是那层误读，与承载它的前端函数是否还在无关。
  //   可选查询参数 `release_id`：带了 → 查该批次 `planned_date`，非空则 duty_date 用 planned_date；批次
  //   不存在 404 RELEASE_NOT_FOUND；`planned_date` 为空则回退今天（批次还没定计划日期，没有更准的锚点）。
  //   不带 `release_id` → 直接用今天（hotfix-publish 弹选人框时批次尚未建立，"现在上线"用今天正确，见
  //   方案 §4.4 端点 2b）。响应体 `duty_date_used` 回传实际用的是哪一天，前端/测试可直接断言。
  router.get('/sys-releases/executor-candidates', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    try {
      async function todayStr() {
        return (await dbGetAsync(`SELECT date('now','localtime') AS d`)).d;
      }

      // duty_date 定位（C1-fix-1）：release_id 给了就查 planned_date，没给或为空则回退今天。
      let dutyDateUsed, dutyDateSource; // dutyDateSource: 'planned' | 'today'
      if (req.query.release_id !== undefined) {
        const releaseIdParam = parsePositiveId(req.query.release_id);
        if (!releaseIdParam) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
        const rel = await dbGetAsync('SELECT id, planned_date FROM sys_releases WHERE id = ?', [releaseIdParam]);
        if (!rel) return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' });
        if (rel.planned_date) { dutyDateUsed = rel.planned_date; dutyDateSource = 'planned'; }
        else { dutyDateUsed = await todayStr(); dutyDateSource = 'today'; }
      } else {
        dutyDateUsed = await todayStr(); dutyDateSource = 'today';
      }
      const dutyDayLabel = dutyDateSource === 'planned' ? `上线日（${dutyDateUsed}）` : '今日';

      const users = await dbAllAsync(
        `SELECT id, display_name, role FROM users WHERE status = 'active' ORDER BY display_name`, []
      );
      const items = [];
      for (const u of users) {
        // ⭐ L4（Opus 预筛）：这里已用 status='active' 过滤，通常 hasReleaseEligibility 的 active 判定会
        // 通过；但本查询与下方逐个 hasReleaseEligibility 调用之间**没有事务包裹**，账号在这两次读取的
        // 间隙被停用是可能发生的（非"恒真"），故仍调用同一函数复核而非假定必过——"eligible" 与 PUT
        // executors 端点闸③的判据保持单一来源，不在本端点另写一份角色白名单。
        // ⭐ 299-L2（codex 审登记接受）：本循环对 users 逐行调用 hasReleaseEligibility 是 N+1 查询模式，
        // 按当前 14 人规模（方案 §2.4 生产实测）接受；用户规模显著增长时应改批量 IN 查询 + 同源资格判据
        // （避免真改成批量版时判据逻辑与 hasReleaseEligibility/PUT executors 闸③各自漂移）。
        const eligible = await hasReleaseEligibility(u.id);
        const disabled_reason = eligible ? null
          : (u.role === 'admin' ? '管理员角色无上线执行资格' : u.role === 'viewer' ? '查看者角色无上线执行资格' : '无上线执行资格');
        items.push({ id: u.id, display_name: u.display_name, role: u.role, eligible, disabled_reason });
      }

      // 给定 user_id，判定是否合格默认候选人；不合格/不存在都给出人类可读原因（排班/config 引用的 id
      // 可能已停用/不在 active 列表里，需单独查一次拿准确原因，不能只在上面 active-only 的 items 里找）。
      async function resolveDefaultCandidate(userId) {
        const eligible = await hasReleaseEligibility(userId);
        if (eligible) {
          const found = items.find(i => i.id === userId);
          return { ok: true, display_name: found ? found.display_name : null };
        }
        const u = await dbGetAsync('SELECT id, display_name, status, role FROM users WHERE id = ?', [userId]);
        if (!u) return { ok: false, reason: `用户 ID=${userId} 不存在` };
        if (u.status !== 'active') return { ok: false, reason: `「${u.display_name}」账号已停用` };
        if (u.role === 'admin') return { ok: false, reason: `「${u.display_name}」管理员角色无上线执行资格` };
        if (u.role === 'viewer') return { ok: false, reason: `「${u.display_name}」查看者角色无上线执行资格` };
        return { ok: false, reason: `「${u.display_name}」无上线执行资格` };
      }

      const skipped_defaults = [];
      const dutySelected = [];
      const configSelected = [];

      // ① 排班（duty_date=dutyDateUsed，上方已按 release_id 有无定位到"上线日"或回退"今日"）
      const dutyRow = await dbGetAsync(
        `SELECT user_id, user_name FROM sys_release_duty_roster WHERE duty_date = ? AND removed_at IS NULL`,
        [dutyDateUsed]
      );
      if (!dutyRow) {
        skipped_defaults.push({ source: 'duty', user_id: null, reason: `${dutyDayLabel}无排班安排` });
      } else {
        const r = await resolveDefaultCandidate(Number(dutyRow.user_id));
        if (r.ok) dutySelected.push(Number(dutyRow.user_id));
        else skipped_defaults.push({ source: 'duty', user_id: Number(dutyRow.user_id), reason: `${dutyDayLabel}排班执行人${r.reason}` });
      }

      // ② 固定默认执行人（system_configs.sys_release_default_executor_ids，users.id 逗号串；方案要求
      //   部署前人工写入 23（示例开发L），全仓现无写入点——见任务锚点部署日清单，L3）
      const rawConfig = await readSystemConfig('sys_release_default_executor_ids');
      const rawConfigTrimmed = String(rawConfig || '').trim();
      if (!rawConfigTrimmed) {
        // 缺失/为空档：配置本身没填，正常态，不是手误——与下方"配置项非法"档文案明确分开。
        skipped_defaults.push({ source: 'config', user_id: null, reason: '未配置固定默认执行人（system_configs.sys_release_default_executor_ids 缺失或为空）' });
      } else {
        // ⭐ 299-M1（codex 审）：token 级可观测——逐 token 判定，不再用一条笼统的"配置值非法（原值：...）"
        //   糊掉具体是哪个 token 出的问题；合法 token 才进资格校验，非法 token（非数字/0/负数）当场逐项
        //   追加 skipped_defaults，运维一眼能定位到底是配置里的哪一段写错了。
        //   ⭐ L2（Opus 预筛）：Number.isInteger 改 Number.isSafeInteger，对齐 server.js:12840
        //   getIssueLiteIdentities 的 toInt 范式（防超出安全整数范围的畸形字符串静默通过）。
        const rawTokens = rawConfigTrimmed.split(',').map(s => s.trim()).filter(Boolean);
        const legalConfigIds = [];
        for (const tok of rawTokens) {
          const n = Number(tok);
          if (Number.isSafeInteger(n) && n > 0) {
            legalConfigIds.push(n);
          } else {
            skipped_defaults.push({ source: 'config', user_id: null, reason: `配置项非法：${tok}` });
          }
        }
        // ⭐ 299-L1（codex 审）：合法 id 去重后再解析资格——同一 id 在配置里重复出现（如 "6,6,7"）不应
        //   导致 default_source.config 出现重复项，也不必对同一 id 重复查两次资格。
        const configIds = [...new Set(legalConfigIds)];
        for (const cid of configIds) {
          const r = await resolveDefaultCandidate(cid);
          if (r.ok) configSelected.push(cid);
          else skipped_defaults.push({ source: 'config', user_id: cid, reason: `固定默认执行人${r.reason}` });
        }
      }

      // 并集去重（决策 8），default_source 按来源拆分明细供前端标注"来自排班/来自默认配置"
      const selected_by_default = [...new Set([...dutySelected, ...configSelected])];
      res.json({
        items, selected_by_default,
        default_source: { duty: dutySelected, config: configSelected },
        skipped_defaults,
        duty_date_used: dutyDateUsed,
      });
    } catch (err) {
      logger.error('[系统迭代] 执行人候选清单查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '执行人候选清单查询失败' });
    }
  });

  // ── GET /sys-releases/:id：批次详情（admin ∨ 对接人 ∨ 本单执行人；批次 + 组内 issue 列表，供 C6 展示/挑单）──────────
  //   同上方 GET /sys-releases 的 C2b 第2批权限放开理由：对接人须能看到详情才能真用「撤销上线安排」。
  //   ⭐ 第三条放行分支（本单 release_assignee_id === actor.id）——Playwright 冒烟实测发现的第二个真实缺口：
  //   §6.14「完成上线」明文授权"值班开发本人"可执行上线，但此前本端点仍锁 admin∨对接人，被通知的执行人
  //   自己点不进详情页看「执行上线」按钮，功能与「撤销上线安排」同款 0% 可达。放行判据依赖数据行本身
  //   （只有本单，非全局），故不能用路由级中间件表达，改路由级仅登录、行内判定——**镜像 GET /sys-duty-roster
  //   已有的"全量 vs 仅本人"读权限缩放先例**（§6.14「排班表读」行），非新发明模式。列表端点 GET /sys-releases
  //   原"刻意不做此扩展"的裁定已于 2026-07-31 被用户拍板部分推翻（执行人入口批）：列表对普通用户开放但
  //   行内过滤只返回本人批次——与本端点"只开自己那条"的最小可见面原则同向，见列表端点注释。
  //   信息暴露边界（codex 200 审 MED-1 主会话裁定·不加通知态条件）：执行人读权由状态机自动管理——
  //   cancel-schedule/改期/移单经 applyReleaseChange 清执行人两列即同步收回读权；failed/stale 保留原执行人
  //   =重发目标本人，应可读；已发布单保留执行人=本人回看自己执行发布的批次（审计对称）。不存在"漏清"路径。
  router.get('/sys-releases/:id', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    try {
      const rel = await dbGetAsync('SELECT * FROM sys_releases WHERE id = ?', [id]);
      if (!rel) return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' });
      const actor = sysActor(req);
      // C4a（方案 §4.4 改造 5b）：单列比对（旧批次级列，C1 起停写）→ 子表 EXISTS——只有代表执行人一人能
      //   看到详情页会让同批次其余在册执行人（如非首位被选的示例开发L）深链打不开，见 §4.4 改造 5b 说明。
      const isAssignee = !!(await dbGetAsync(
        `SELECT 1 FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1`,
        [id, actor.id]
      ));
      if (actor.role !== 'admin' && !isSysIntakeLiaison(actor.id) && !isAssignee) {
        return res.status(403).json({ error: '仅管理员、对接人或本批次执行人可查看', code: 'NOT_ADMIN_OR_INTAKE_LIAISON_OR_ASSIGNEE' });
      }
      // C4a（方案 §4.4 改造 5b 登记⑤·Opus 预筛 MED-6 挪位）：鉴权通过之后再做行级批量惰性 stale 转换——
      //   打开详情页先把超窗 sending 行转 stale，前端拿到的执行人行级状态才是新鲜的（此前 stale 转换只在
      //   写路径调用，详情 GET 未接线，会让"发送在途已超过 5 分钟"的陈旧 sending 停留展示，误导 admin
      //   以为还在外呼）。**挪到鉴权后**：未授权访问者不该触发任何写副作用（即便是"惰性状态转换"这种
      //   幂等只读语义等价的写），无权限窥探不该顺带改动库内状态；单条 UPDATE，非事务写路径。
      await staleTransitionForExecutorRelease(id);
      // 上线体统一重构 C4（方案 §6.6/§6.6b）：批次内 issue 列表改走统一读源——「计划中」批次仍是直读
      //   sys_issues（live，等价于本端点改造前的直接查询）；「已发布」批次优先走发布快照，快照缺失/
      //   校验失败则回落 timeline release_published 载荷重建（degraded，不静默当空）。
      //   ⚠️ **返回契约刻意保留旧字段名**（id/type/title/status，非 getReleaseMembers 内部的
      //   issue_id/type/title_snapshot/status_at_publish）——前端 siOpenBatchDetail 现有渲染逐字读这四个
      //   旧键名（`i.id`/`i.type`/`i.title`/`i.status`，见 Sys_Iteration.html），本批只切读源不改前端，
      //   字段名对齐旧契约是"旧消费者拿到不同形状的数据"这条风险的具体防线，非随手照抄内部命名。
      //   priority/system_name/module_name/assigned_to_name 四列**不再返回**——它们是"当前"（可变）任务
      //   表字段，对 snapshot/degraded 态的历史成员显示"当前值"会重犯 §6.6a 明确警告的错（"正常快照反而
      //   拿不到发布时的标题，得回头读可变的当前任务表"，同理不该混入可变的优先级/系统名等字段）；核实
      //   前端 siOpenBatchDetail 渲染逻辑（Sys_Iteration.html:~3508-3512）本就只消费 id/type/title/status
      //   四个字段，未读这四列，故删除它们对现有前端**零回归**（已用 grep 核对该渲染函数体，非猜测）。
      const gm = await getReleaseMembers(rel);
      // C2（commit号两列·锚点 D1）：成员清单补前端/后端 commit 编码两列——执行人上线时需要知道每张待上线
      //   单该发哪些 commit（本端点判权已含批次执行人，他看到的 issues 天然只有本批成员，无需额外过滤）。
      //   ⚠️ 已发布批次的值来自**发布快照**（getReleaseMembers 的 snapshot 分支），不回查 live 表——
      //   发布后开发仍可 add/edit/delete commit，回查会让"这批当时发的是什么"漂移（锚点 D5）。
      //   degraded 时 refsByComponent 返回 null（不伪造 []），且 gm.unavailable_fields 已含 'commits'。
      const issues = gm.members.map(m => ({
        id: m.issue_id, type: m.type, title: m.title_snapshot, status: m.status_at_publish,
        frontend_commit_refs: refsByComponent(m.commits, 'frontend'),
        backend_commit_refs: refsByComponent(m.commits, 'backend'),
      }));
      // [C9 任务C·codex 207 审 MED-3 防御，二次收口新增 duplicate_release_published_conflict] 两个诊断
      //   字段与 unavailable_fields 同级暴露——仅 degraded 源可能非空（脏数据兜底诊断），live/snapshot
      //   恒 []，不静默吞掉这个信号。conflict 是 duplicate 的子集：前者=重复行内容确实不一致（更严重）。
      // [C5·唯一后端改动点] 详情端点补 executors 字段——C4a 编码时裁定"详情端点不加 executors 数组，
      //   留 C5 按需"（见交接摘要），C5 前端要渲染多人执行人区块，此刻是"需要"的时点。字段与 PUT
      //   executors/hotfix-publish 两端点的响应形状同构（id/user_id/user_name/notify_status/exec_status），
      //   额外带 read_at（前端已读徽标要用）；executor_notify_summary 复用 deriveExecutorNotifySummary
      //   同一份判定（写读同源，不在本端点另起一套聚合逻辑）。上方 :9271 的 staleTransitionForExecutorRelease
      //   已在鉴权后跑过一轮批量 stale 转换，这里查到的 notify_status 已是新鲜值，不需要再转一次。
      const executorRows = await dbAllAsync(
        `SELECT id, user_id, user_name, notify_status, exec_status, read_at
           FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`,
        [id]
      );
      res.json({
        release: rel, issues, source: gm.source, degraded: gm.degraded, unavailable_fields: gm.unavailable_fields,
        duplicate_release_published: gm.duplicate_release_published || [],
        duplicate_release_published_conflict: gm.duplicate_release_published_conflict || [],
        executors: executorRows, executor_notify_summary: deriveExecutorNotifySummary(executorRows),
      });
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
        let parsed = null;
        try { parsed = JSON.parse(r.snapshot_json); } catch (_) { parsed = null; }   // 防御性：正常写路径（snapshotReleaseCommitsInTxn）不会产生非法 JSON
        // ⭐ C2a snapshot v2 演进：新写入是对象 {schema_version:2,...,commits:[...]}；本端点仅做类型分支
        //   取出 commits 数组本身（非"v1 兼容读端"——那是 getReleaseMembers() 的职责，C4 才做统一读源/降级
        //   契约。这里只是不让本已有的零消费者调试端点在写端演进后把整个 v2 对象错当 commits 数组返回，
        //   属避免引入回归的最小必要修正，同时对早于本次的历史纯数组行保持兼容）。
        const commits = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.commits) ? parsed.commits : []);
        return { id: r.id, release_id: r.release_id, issue_id: r.issue_id, commits, created_at: r.created_at };
      });
      res.json({ release_id: id, items });
    } catch (err) {
      logger.error('[系统迭代] 批次快照查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次快照查询失败' });
    }
  });

  // ============================================================
  // 上线体统一重构 C1（方案 v3.4 §6.2/§6.3a/§6.14）：排班表 CRUD 三端点 + 资格闸
  // ============================================================

  // 共享软删（POST 调班与 DELETE 共用，保证三字段同写、语义唯一——不能两处各写一份，否则以后改一处漏另一处）：
  //   双条件守卫（id + removed_at IS NULL）+ changes 检查（状态机字段 UPDATE 三件套，同 feedback_state_machine_
  //   update_invariant 范式）；removed_at 用 datetime('now','localtime') 服务端生成，写读同源与 created_at/
  //   released_at 等既有列一致。调用方负责判断返回值：changes!==1 表示目标已不在活跃态（并发已被移除/不存在）。
  async function softDeleteDutyRoster(id, actor) {
    const result = await dbRunAsync(
      `UPDATE sys_release_duty_roster SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?
        WHERE id = ? AND removed_at IS NULL`,
      [actor.id, actor.name, id]
    );
    return !!(result && result.changes === 1);
  }

  // ── GET /sys-duty-roster：排班列表（§6.2 端点段·query from/to 必填 + ≤366 天 + 权限视图）──────────
  //   [2026-07-30 用户提出] 查询上限 93 天 → 366 天（**固定日数滚动窗口**，足以覆盖闰年长度——非"自然年"
  //   日历语义，codex 212 审 LOW-2 措辞修正）：开发按月轮值需要一年视图；数据面每天
  //   ≤1 条活跃排班，一年最多 366 行，配合前端区间合并展示（按月轮值约 12 段行）无性能压力。批量**写**
  //   上限 62 天不放宽（写路径成本不同，见 batch 端点注释；按月轮值逐月批量设置足够）。
  //   权限视图（§6.14「排班表读」行）：admin ∨ 对接人 → 全量；其他登录用户 → 只返回本人的行。
  //   日期校验复用 normalizeDeadline（与 POST duty_date 同一函数——YYYY-MM-DD + 真实日历日校验，不新写
  //   重复逻辑，见该函数既有注释：deadline/planned_date 已在用，语义完全等价）。
  router.get('/sys-duty-roster', authenticateToken, requireSysSchemaReady, async (req, res) => {
    try {
      const fromRaw = req.query.from, toRaw = req.query.to;
      if (!fromRaw || !toRaw) return res.status(400).json({ error: 'from/to 均为必填（YYYY-MM-DD）', code: 'DUTY_RANGE_REQUIRED' });
      const fromCheck = normalizeDeadline(fromRaw), toCheck = normalizeDeadline(toRaw);
      if (!fromCheck.ok || !fromCheck.value || !toCheck.ok || !toCheck.value) {
        return res.status(400).json({ error: 'from/to 格式非法（应为 YYYY-MM-DD 真实日期）', code: 'INVALID_DUTY_DATE' });
      }
      const from = fromCheck.value, to = toCheck.value;
      if (to < from) return res.status(400).json({ error: 'to 不得早于 from', code: 'DUTY_RANGE_INVALID' });
      // 用 Date.UTC 计算跨度天数（避免本地时区/夏令时导致的 23/25 小时日造成天数误差）。
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      const diffDays = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
      if (diffDays > 365) return res.status(400).json({ error: '查询区间不得超过 366 天', code: 'DUTY_RANGE_TOO_LONG' });   // 含首尾两端，diffDays=365 即 366 天（固定日数上限非自然年，2026-07-30 自 93 天放宽）

      const actor = sysActor(req);
      const isAdminOrLiaison = actor.role === 'admin' || isSysIntakeLiaison(actor.id);
      const where = ['duty_date BETWEEN ? AND ?', 'removed_at IS NULL'];
      const params = [from, to];
      if (!isAdminOrLiaison) { where.push('user_id = ?'); params.push(actor.id); }
      const rows = await dbAllAsync(
        `SELECT id, duty_date, user_id, user_name, note, created_by, created_by_name, created_at
           FROM sys_release_duty_roster WHERE ${where.join(' AND ')} ORDER BY duty_date ASC`,
        params
      );
      res.json({ items: rows, from, to });
    } catch (err) {
      logger.error('[系统迭代] 排班列表查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '排班列表查询失败' });
    }
  });

  // ── POST /sys-duty-roster：新增/调班（§6.2 端点段·仅对接人）──────────
  //   资格闸（§6.3a）：**事务内**实时读库判定 存在 ∧ status='active' ∧ role∉('viewer','admin')——codex 198
  //   审 MED-1 采纳：与同日旧行查询/软删/插入同一 mutex 事务，写入时强 R-2（消除判定与写入之间的漂移窗口，
  //   详见事务内注释）；user_name 服务端从 users.display_name 派生，不信 body（同建单/指派等既有端点范式）。
  //   调班语义：该 duty_date 已有活跃行 → 事务内先软删旧行再插新行（原子，mutex 串行化天然避免同日并发双插撞
  //   partial UNIQUE idx_sys_duty_roster_active）；无则直接插。
  //   ⚠️ 纯输入校验（日期格式/user_id 格式/note 长度）留在事务外——无库依赖，先拒早拒，不占用 mutex 窗口。
  router.post('/sys-duty-roster', authenticateToken, requireSysSchemaReady, requireLiaisonOnly, async (req, res) => {
    const b = req.body || {};
    try {
      const actor = sysActor(req);
      const dateCheck = normalizeDeadline(b.duty_date);
      if (!dateCheck.ok || !dateCheck.value) {
        return res.status(400).json({ error: '排班日期格式非法（应为 YYYY-MM-DD 真实日期）', code: 'INVALID_DUTY_DATE' });
      }
      const dutyDate = dateCheck.value;

      const userId = parsePositiveId(b.user_id);
      if (!userId) return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_DUTY_USER_ID' });

      const note = (typeof b.note === 'string' ? b.note.trim() : '') || null;
      if (note && note.length > 200) return res.status(400).json({ error: '备注超长（≤200）', code: 'DUTY_NOTE_TOO_LONG' });

      let newId = null, replacedName = null, userName = null;
      await sysBeginImmediate();
      try {
        // 资格闸（§6.3a，codex 198 审 MED-1 采纳）：资格查询在事务内=写入时强 R-2——与同日旧行查询/软删/
        //   插入同一 mutex 事务，消除"判定合格"到"实际写入"之间用户角色/状态漂移的窗口（事务外读存在
        //   TOCTOU：判定时合格，写入前被撤权/禁用，仍会写入过时资格）。不信调用方声称的资格，实时读库。
        const target = await dbGetAsync('SELECT id, display_name, username, status, role FROM users WHERE id = ?', [userId]);
        if (!target || target.status !== 'active' || target.role === 'viewer' || target.role === 'admin') {
          await sysRollback();
          return res.status(400).json({ error: '该用户不具备上线值班资格（须为在职且非查看者/管理员）', code: 'DUTY_USER_NOT_ELIGIBLE' });
        }
        userName = target.display_name || target.username || `user#${userId}`;

        const existing = await dbGetAsync('SELECT id, user_name FROM sys_release_duty_roster WHERE duty_date = ? AND removed_at IS NULL', [dutyDate]);
        if (existing) {
          const softDeleted = await softDeleteDutyRoster(existing.id, actor);
          if (!softDeleted) {
            await sysRollback();
            return res.status(409).json({ error: '该日排班已被并发修改，请重试', code: 'DUTY_ROSTER_CONFLICT' });
          }
          replacedName = existing.user_name;
        }
        const result = await dbRunAsync(
          `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, note, created_by, created_by_name)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [dutyDate, userId, userName, note, actor.id, actor.name]
        );
        newId = result.lastID;
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.status(201).json({ id: newId, duty_date: dutyDate, user_id: userId, user_name: userName, note, replaced: replacedName });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 排班新增/调班失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '排班新增/调班失败' });
    }
  });

  // ── DELETE /sys-duty-roster/:id：移除排班（§6.2 端点段·仅对接人）──────────
  //   [C9 任务E·codex 207 审 LOW-2] 并发下的 404 语义说明（不改实现）：下方先有一次事务外 SELECT
  //   （仅为给正常路径一个更友好的早期 404，非并发控制手段）,真正的软删是 softDeleteDutyRoster 内部
  //   单条 `UPDATE ... WHERE id=? AND removed_at IS NULL` 原子完成（该语句自身对并发安全，不会双删/
  //   丢更新）。但两次请求race 时：A 的 SELECT 读到"存在"之后、A 调用 softDeleteDutyRoster 之前，
  //   B 先一步把该行软删——A 的 UPDATE 因 WHERE 条件不再匹配而 changes=0，A 走到下方"softDeleted 为
  //   false"分支同样返回 404。即"SELECT 时还在，DELETE 时已消失"这种 404 是**预期可接受**的并发覆盖
  //   语义（该行事实上确实已被移除，返回 404 而非 500/静默成功是正确结果，只是不是本次这个请求删的），
  //   不代表数据损坏或需要额外加锁。
  router.delete('/sys-duty-roster/:id', authenticateToken, requireSysSchemaReady, requireLiaisonOnly, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的排班 ID', code: 'INVALID_DUTY_ROSTER_ID' });
    try {
      const actor = sysActor(req);
      const row = await dbGetAsync('SELECT id, removed_at FROM sys_release_duty_roster WHERE id = ?', [id]);
      if (!row || row.removed_at !== null) return res.status(404).json({ error: '排班记录不存在或已移除', code: 'DUTY_ROSTER_NOT_FOUND' });
      const softDeleted = await softDeleteDutyRoster(id, actor);
      if (!softDeleted) return res.status(404).json({ error: '排班记录不存在或已移除', code: 'DUTY_ROSTER_NOT_FOUND' });
      res.json({ id, removed: true });
    } catch (err) {
      logger.error('[系统迭代] 排班移除失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '排班移除失败' });
    }
  });

  // ── POST /sys-duty-roster-batch：区间批量设置值班人（§6.2 端点段泛化·用户 2026-07-29 实测后提出，C2b 第2批）──────────
  //   命名镜像既有"单条/批量"并存范式（notify-release-executor / notify-release-executor-batch）。
  //   语义=逐日复用单日 POST 的"软删旧活跃行+插新行"调班语义（不新起第二套写法，本函数体内直接调用同一个
  //   softDeleteDutyRoster + 同一句 INSERT SQL），**同一个 BEGIN IMMEDIATE…COMMIT 事务**跑完整个区间——
  //   任一环节失败（并发冲突/DB 约束违反/其它异常）都会走 catch 块 sysRollback() 回滚**已执行的全部**软删+插入，
  //   零部分提交（事务边界=资格闸读取起到 for 循环最后一条 INSERT 止，见下方代码）。
  //   写权限仍 requireLiaisonOnly（仅对接人，admin 403 焊死不例外，与单日 POST 同判据）。
  //   区间上限 62 天——比 GET 的 93 天查询上限更紧：批量写会连带触发最多 62 次软删+62 次插入+62 条 timeline
  //   量级的库操作，比只读查询成本高，收紧上限防误操作污染过大区间（限额与 GET 的查询上限是两件事，不复用
  //   同一常量/错误码，防止未来只改一处遗漏另一处的写读同源漂移）。
  router.post('/sys-duty-roster-batch', authenticateToken, requireSysSchemaReady, requireLiaisonOnly, async (req, res) => {
    const b = req.body || {};
    try {
      const actor = sysActor(req);
      // 纯输入校验留在事务外（同单日 POST 既有注释："无库依赖，先拒早拒，不占用 mutex 窗口"）。
      //   date_from/date_to 本身的日历合法性由 normalizeDeadline 挡（月内溢出如 2026-02-30 在此已被拒，
      //   400 INVALID_DUTY_DATE，零写入）；区间内部逐日日期由本函数用 Date.UTC 步进生成，天然全部合法，
      //   不会出现"区间边界合法但内部某天非法"的情形——DB 侧 duty_date CHECK（date(x,'+0 days') 归一化）
      //   仍作为最后一道防线保留在 DDL（C0），本端点的编程路径下预期不会触发，但不因此撤防。
      const fromCheck = normalizeDeadline(b.date_from);
      const toCheck = normalizeDeadline(b.date_to);
      if (!fromCheck.ok || !fromCheck.value || !toCheck.ok || !toCheck.value) {
        return res.status(400).json({ error: 'date_from/date_to 均为必填（YYYY-MM-DD 真实日期）', code: 'INVALID_DUTY_DATE' });
      }
      const dateFrom = fromCheck.value, dateTo = toCheck.value;
      if (dateTo < dateFrom) return res.status(400).json({ error: 'date_to 不得早于 date_from', code: 'DUTY_RANGE_INVALID' });

      // Date.UTC 计算跨度天数（同 GET /sys-duty-roster 既有写法，避免本地时区/夏令时导致的 23/25 小时日误差）。
      const [fy, fm, fd] = dateFrom.split('-').map(Number);
      const [ty, tm, td] = dateTo.split('-').map(Number);
      const diffDays = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
      if (diffDays > 61) return res.status(400).json({ error: '批量设置区间不得超过 62 天', code: 'DUTY_BATCH_RANGE_TOO_LONG' });   // 含首尾两端，diffDays=61 即 62 天

      const userId = parsePositiveId(b.user_id);
      if (!userId) return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_DUTY_USER_ID' });

      const note = (typeof b.note === 'string' ? b.note.trim() : '') || null;
      if (note && note.length > 200) return res.status(400).json({ error: '备注超长（≤200）', code: 'DUTY_NOTE_TOO_LONG' });

      // 区间内全部日期字符串——UTC 毫秒步进 + toISOString 切片取 YYYY-MM-DD，规避本地时区/DST 漂移
      //   （与上面 diffDays 同一套 Date.UTC 基准，两处不一致会导致生成日期数与声称的 diffDays 对不上）。
      const dates = [];
      const fromUtcMs = Date.UTC(fy, fm - 1, fd);
      for (let i = 0; i <= diffDays; i++) {
        dates.push(new Date(fromUtcMs + i * 86400000).toISOString().slice(0, 10));
      }

      let userName = null;
      const items = [];
      await sysBeginImmediate();
      try {
        // 资格闸（§6.3a，同单日 POST 判据）：事务内实时读库一次——区间内所有日期共享同一事务时刻的资格
        //   快照（不是"信调用方声称"，是"判定与写入落在同一个事务里"，满足 R-2 核心诉求；不逐日重复查询
        //   同一 userId 的 users 行，这不是资格漂移，是同一事务时刻内的常量）。
        const target = await dbGetAsync('SELECT id, display_name, username, status, role FROM users WHERE id = ?', [userId]);
        if (!target || target.status !== 'active' || target.role === 'viewer' || target.role === 'admin') {
          await sysRollback();
          return res.status(400).json({ error: '该用户不具备上线值班资格（须为在职且非查看者/管理员）', code: 'DUTY_USER_NOT_ELIGIBLE' });
        }
        userName = target.display_name || target.username || `user#${userId}`;

        // 逐日复用单日 POST 的写法：先查当日活跃行 → 有则软删（softDeleteDutyRoster，与单日 POST/DELETE
        //   共用同一函数，三字段同写不出现第二套语义）→ 插入新行。任一天 softDeleteDutyRoster 返回 false
        //   （changes!==1，同日活跃行被并发抢先改动）立即 rollback 整个事务并 409，已写入的前 N 天全部撤销
        //   ——这就是"全成或全不成"的具体落点（非仅理论声明，见此处真实控制流）。
        for (const dutyDate of dates) {
          const existing = await dbGetAsync('SELECT id, user_name FROM sys_release_duty_roster WHERE duty_date = ? AND removed_at IS NULL', [dutyDate]);
          let replacedName = null;
          if (existing) {
            const softDeleted = await softDeleteDutyRoster(existing.id, actor);
            if (!softDeleted) {
              await sysRollback();
              return res.status(409).json({ error: `该日（${dutyDate}）排班已被并发修改，请重试`, code: 'DUTY_ROSTER_CONFLICT' });
            }
            replacedName = existing.user_name;
          }
          const result = await dbRunAsync(
            `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, note, created_by, created_by_name)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [dutyDate, userId, userName, note, actor.id, actor.name]
          );
          items.push({ id: result.lastID, duty_date: dutyDate, replaced: replacedName });
        }
        await sysCommit();
      } catch (txErr) {
        // 兜底：DB 层任何异常（含理论上不该触发但仍是最后防线的 CHECK 违例）在此统一回滚——
        //   本 catch 与外层单日 POST/其余端点的 txErr 处理逐字同款范式，不新写变体。
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.status(201).json({ date_from: dateFrom, date_to: dateTo, user_id: userId, user_name: userName, note, count: items.length, items });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 排班区间批量设置失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '排班区间批量设置失败' });
    }
  });

  // ── POST /sys-releases/:id/add-issues：加单（admin，M-8 双 WHERE 原子全成或全败）──────────
  //   闸门：批次「计划中」+ 每单「待上线」AND release_id IS NULL AND type∈可发布3类（防多批次抢占/config 混入）。
  //   [上线体统一重构] bug 双闸拆除（2026-07-29 主会话裁定选项 A，依据方案 v3.4 §5a 架构决策表「混批守卫/
  //   needs_release/release_type 可写性 → 拆除/废弃/停止」+ §5b #2「needs_release｜废弃」+ #3「上线单类型｜
  //   完全不限（config 除外）」）：① 恒 409 的 bugIssueIds 闸门（曾把任意 bug 单挡在 add-issues 门外，见本
  //   commit 前的历史注释）② 逐单 UPDATE 里的 `(type <> 'bug' OR needs_release = 1)` 条件（needs_release
  //   唯一写点 set-release-flag 已随 C3 退场为 410 Gone，此条件对 bug 恒假，与①叠加后 bug 100% 无法加单，
  //   见 needs_release 列定义处的完整只读残留说明）——两者一并拆除后，bug 与 feature/improvement 完全同源，
  //   仅剩 type IN (${typePh}) 这一道类型闸（RELEASABLE_TYPES 排除 config，附录 A 明文负例，与本次拆闸无关，
  //   逐字保留）。
  router.post('/sys-releases/:id/add-issues', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const raw = (req.body || {}).issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要加入的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });   // E（ultracode 安全）：元素数上限防 DoS
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    const typePh = RELEASABLE_TYPES.map(() => '?').join(',');
    const actor = sysActor(req);   // C2a：applyReleaseChange 原语收尾需要 actor（timeline operator_id/name）
    try {
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync('SELECT id, status FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能加单', code: 'RELEASE_NOT_PLANNING' }); }
        // [C5 收口批·C3 遗留补做] release_type 族别隔离（D-A：bug vs 非bug）已整体删除——方案 §5a"混批守卫→
        //   拆除"，原逻辑（本次入参族别唯一 + 与批次已定族别一致 + 批次未定族别时连读已有成员一并判定）
        //   连同其落地机制（famClause 限定 WHERE + release_type 首次落定回填）一并删除。
        // 逐单 UPDATE：仅剩"可发布类型"一道闸（config 排除靠 type IN 子句）——bugIssueIds 恒 409 闸门 +
        //   needs_release=1 条件已一并拆除（见上方端点头注释），bug 与 feature/improvement 完全同源。
        for (const iid of issueIds) {
          const upd = await dbRunAsync(
            `UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime')
               WHERE id = ? AND status = '待上线' AND release_id IS NULL AND type IN (${typePh})`,
            [id, iid, ...RELEASABLE_TYPES]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: `#${iid} 不可加入（须为未挂批次的「待上线」单、非配置类）`, code: 'ISSUE_NOT_ADDABLE', issue_id: iid });
          }
        }
        // C2a §6.11 原语收尾：加单成功后经 applyReleaseChange 原子重置通知/执行人 + 双写 + timeline。
        await applyReleaseChange(id, actor, {
          added_issue_ids: issueIds, removed_issue_ids: [], planned_date_changed: false, schedule_cancelled: false,
        });
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

  // ── POST /sys-releases/:id/remove-issues：移除单（admin ∨ 执行人本人，M-8 双 WHERE 原子全成或全败）──────────
  //   闸门：批次「计划中」+ 每单 release_id=:id AND「待上线」；移除后清空 release_id。
  //   2026-07-31 用户拍板（执行人移单四口径）：移单不再是 admin 专属——被通知的执行人本人也可在执行
  //   环节移出成员（如发现某单不该随本批发布）。权限判据不再走路由级 requireAdmin，改端点内自读自判：
  //   admin 分支行为与改造前完全一致（唯一增量=可选 reason）；执行人分支镜像 /execute 的守卫结构（见其
  //   注释），全部在 BEGIN IMMEDIATE 事务内自读自判，不接受调用方"已验证"标记。
  router.post('/sys-releases/:id/remove-issues', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const raw = (req.body || {}).issue_ids;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: '请选择要移除的迭代单', code: 'ISSUE_IDS_REQUIRED' });
    if (raw.length > SYS_BATCH_ISSUE_MAX) return res.status(400).json({ error: `单次最多 ${SYS_BATCH_ISSUE_MAX} 条`, code: 'TOO_MANY_ISSUES' });   // E（ultracode 安全）：元素数上限防 DoS
    for (const x of raw) if (!parsePositiveId(x)) return res.status(400).json({ error: '迭代单 id 非法', code: 'INVALID_ISSUE_ID' });
    const issueIds = [...new Set(raw.map(parsePositiveId))];
    const actor = sysActor(req);   // C2a：applyReleaseChange 原语收尾需要 actor（timeline operator_id/name）
    const isAdminActor = actor.role === 'admin';
    // reason：admin 可选（trim 后非空才使用，超长仍拒），执行人必填（2026-07-31 用户拍板"仅执行人原因
    //   必填"）。长度上限镜像 cancel-schedule 端点既有规则（本文件 cancel-schedule 路由，trim 后 1..200
    //   字），非另定新上限。
    const rawReason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    let reason = null;
    if (isAdminActor) {
      if (rawReason) {
        if (rawReason.length > 200) return res.status(400).json({ error: '移除原因超长（trim 后 ≤200 字）', code: 'REMOVE_REASON_TOO_LONG' });
        reason = rawReason;
      }
    } else {
      if (!rawReason) return res.status(400).json({ error: '移除原因必填（仅已被通知的执行人可在执行环节移单）', code: 'REMOVE_REASON_REQUIRED' });
      if (rawReason.length > 200) return res.status(400).json({ error: '移除原因超长（trim 后 ≤200 字）', code: 'REMOVE_REASON_TOO_LONG' });
      reason = rawReason;
    }
    try {
      await sysBeginImmediate();
      let remainingCount = 0, keepExecutor = false;
      try {
        const rel = await dbGetAsync(
          'SELECT id, status, release_type FROM sys_releases WHERE id = ?',
          [id]
        );
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能移除', code: 'RELEASE_NOT_PLANNING' }); }
        if (!isAdminActor) {
          // C4a（方案 §4.4 改造 7）：执行人分支守卫（镜像 /execute 的守卫结构，见其注释）——旧单列比对
          //   （release_assignee_id/release_assignee_notify_status，批次级单列，C1 起停写）改子表在册行
          //   查询：actor 须是本批次在册执行人（removed_at IS NULL），且该行 notify_status='sent'。全部
          //   事务内自读自判，不接受"已验证"标记。顺序调整为"先判在册身份、再判通知态"（单人单列下两者
          //   等价，多执行人子表下"查无此行"与"行存在但未通知"是两件不同的事，需要先确认身份）。
          // L10（Opus 预筛，裁定记录）：SELECT 不叠 exec_status 条件——方案 §4.4 改造 7 的契约并未剥夺
          //   已 done 的执行人的移单操作权（"确认完成上线"与"移单"是两件独立的事，done 之后仍可能因为
          //   发现某个成员单不该随本批发布而要求移除它）。故意不加，非遗漏。
          const myExecRow = await dbGetAsync(
            `SELECT notify_status FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL`,
            [id, actor.id]
          );
          if (!myExecRow) {
            await sysRollback();
            return res.status(403).json({ error: '仅被通知的值班执行人本人可移单', code: 'EXECUTOR_GUARD_FAILED' });
          }
          if (myExecRow.notify_status !== 'sent') {
            await sysRollback();
            return res.status(409).json({ error: '仅已被通知的执行人可在执行环节移单', code: 'EXECUTOR_REMOVE_NOT_NOTIFIED' });
          }
          // §6.10 中心守卫同款不变量：实时资格，事务内自读自判（文案对齐 /execute 的 EXECUTOR_NOT_ELIGIBLE）。
          const eligible = await hasReleaseEligibility(actor.id);
          if (!eligible) {
            await sysRollback();
            return res.status(403).json({ error: '当前账号无执行上线资格（非在职，或为查看者/管理员）', code: 'EXECUTOR_NOT_ELIGIBLE' });
          }
        }
        // [R5⑤防御闸已删·2026-07-30 用户拍板] 旧闸（release_type='bug' 一律 409 LEGACY）的前提——"v1.6 后
        //   add-issues 已堵住 bug 进批次，本分支正常路径不可达，仅防脏库/历史残留"——在 C3 全类型统一后失效：
        //   bug 经 hotfix-publish 建应急批次会真实写入 release_type='bug'（见该端点 INSERT 的 releaseFamilyOf），
        //   每个 bug 应急单都命中旧闸＝应急上线单永远无法移单（用户实测发现的误伤；C3 拆双闸时已在
        //   verify-sys-bug-transitions 头注标注"仅 emergency 批次可能命中、递延处理"，本次即收尾）。
        //   "过度拦截让脏批次更难清理"本就是 codex40 第十人视角不给 remove 扩防线的理由（见
        //   publishReleaseTransition 处注释）；生产 sys 表 0 行亦无历史残留可防。移单后语义自洽：单回
        //   「待上线」可重新应急/常规安排上线，批次移空走下方 F-4 复位 release_type=NULL 可复用。
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
        const remainRow = await dbGetAsync('SELECT COUNT(*) AS c FROM sys_issues WHERE release_id = ?', [id]);
        remainingCount = remainRow ? remainRow.c : 0;
        // 2026-07-31 用户拍板（执行人移单四口径"保留执行人继续执行"）：执行人分支 ∧ 剩余>0 时保留执行人
        //   身份（opts.keepExecutor，见 applyReleaseChange 内该 opts 的处理）——变更是执行人本人做的，
        //   无需重新知会；保留身份让其当场继续发布剩余任务。执行人分支 ∧ 剩余=0，或 admin 分支，一律走
        //   现行完整重置（不传 keepExecutor）——移空场景需保住既有"正常流程 sent∧空成员不可达"性质（见
        //   L1 订正：原引用的批次级 preemptReleaseNotifySend 函数已随 C4b H1 退场整体删除，该不变量现由
        //   行级 preemptReleaseExecutorNotifySend 的"成员非空 fail-closed"检查独立承担，见该函数内注释），
        //   批次回到干净可复用态。
        keepExecutor = !isAdminActor && remainingCount > 0;
        // C2a §6.11 原语收尾：移单成功后经 applyReleaseChange 原子重置通知/执行人（除非 keepExecutor）+
        //   双写（清移除单的旧单级 8 列）+ timeline（按角色/是否移空分支生成文案，见该函数内注释）。
        await applyReleaseChange(id, actor, {
          added_issue_ids: [], removed_issue_ids: issueIds, planned_date_changed: false, schedule_cancelled: false,
          remove_reason: reason, remove_by_executor: !isAdminActor,
        }, keepExecutor ? { keepExecutor: true } : {});
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      res.json({ id, removed: issueIds, count: issueIds.length, remaining_count: remainingCount, executor_kept: keepExecutor });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);   // F2：SYS_BUSY 等保 503
      logger.error('[系统迭代] 批次移除失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '批次移除失败' });
    }
  });

  // ── C3 退场（方案 §6.7/§6.10/§6.14/附录A）：POST /sys-releases/:id/publish 全类型 409 ──────────
  //   唯一合法发布入口收窄为 /sys-releases/:id/execute（中心守卫自读自判，§6.10）。admin 直发已不再是
  //   合法路径——即使 admin 是被排入值班的执行人，也必须走"安排上线→（作为执行人）执行上线"两步，
  //   不能再靠本端点一步转已上线。**保留 publishReleaseTransition 函数本体不删**（不接路由，仅供
  //   verify 直调作为"内部调用绕过 HTTP"的测试载体，验证 _publishReleaseCoreInTxn 内嵌的中心守卫
  //   即使被这条路子直接调用也照样拦——见该函数定义处注释）。
  router.post('/sys-releases/:id/publish', authenticateToken, requireSysSchemaReady, async (req, res) => {
    res.status(409).json({
      error: '该端点已下线：发布唯一入口现为「安排上线」（通知值班执行人）+ 执行人本人「执行上线」，请改用「安排上线」（行级通知，POST /sys-releases/:id/executors/:userId/notify）与 /sys-releases/:id/execute',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
  });

  // ============================================================
  // 上线体统一重构 C2a：排班驱动的通知/执行/撤销三端点 + 改期端点（§6.4/§6.4a/§6.8/§6.11）
  // ============================================================

  // ── POST /sys-releases/:id/update-planned-date：改计划上线日期（admin·单计划中·§6.11 原语④）──────────
  //   [C2a 编码前置勘误②] 方案未逐字定路由动词——本端点是**新建端点**（既有 POST /sys-releases 仅建批次时
  //   可写 planned_date，无既有"改期"入口），沿用项目既有"POST 语义动作"风格（非严格 REST PATCH）。
  //   相同日期（含都为 NULL）= 差量空，applyReleaseChange 内部幂等跳过（不清通知不写 timeline）。
  router.post('/sys-releases/:id/update-planned-date', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const dateCheck = normalizeDeadline((req.body || {}).planned_date);   // 复用日期校验（YYYY-MM-DD 真实日期 / 空可选=清除）
    if (!dateCheck.ok) return res.status(400).json({ error: '计划上线日期格式非法（应为 YYYY-MM-DD 真实日期，留空可清除）', code: 'INVALID_PLANNED_DATE' });
    const newDate = dateCheck.value;
    const actor = sysActor(req);
    try {
      // [C4b 删除·H1 根治] codex 199 审 LOW-2 曾在此加的批次级惰性 stale 转换调用已随
      // staleTransitionForRelease 函数整体删除移除——该函数原本转换的 release_assignee_notify_status
      // 列已无任何写路径能产出 'sending' 态，转换动作本身变得没有意义（见函数删除处注释）。
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync('SELECT id, status, planned_date FROM sys_releases WHERE id = ?', [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能改期', code: 'RELEASE_NOT_PLANNING' }); }
        const changed = rel.planned_date !== newDate;   // 相同日期（含都为 null）= 差量空
        if (changed) {
          // CAS 对旧值比对，防并发窗口内被另一次改期抢先。
          const upd = await dbRunAsync(
            `UPDATE sys_releases SET planned_date = ? WHERE id = ? AND status = '计划中' AND COALESCE(planned_date,'') = COALESCE(?,'')`,
            [newDate, id, rel.planned_date]
          );
          if (!upd || upd.changes !== 1) {
            await sysRollback();
            return res.status(409).json({ error: '批次状态已并发变更，请刷新重试', code: 'CONCURRENT_STATE_CHANGE' });
          }
        }
        await applyReleaseChange(id, actor, {
          added_issue_ids: [], removed_issue_ids: [], planned_date_changed: changed, schedule_cancelled: false,
        });
        await sysCommit();
        res.json({ id, planned_date: newDate, changed });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 改计划上线日期失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '改计划上线日期失败' });
    }
  });

  // ── POST /sys-releases/:id/cancel-schedule：撤销上线安排（仅对接人，admin 403，§6.8）──────────
  //   C4a（方案 §4.4 改造 5·v1.2 H1）：准入不再看聚合通知态——旧 sent/stale/failed 限制已删除，只要批次
  //   「计划中」即可撤销（partial 态必须有恢复路径，否则卡死）。子表整体软删（不回带，§4.1a 代次语义）；
  //   在册已有 exec_status='done' 时须带 `confirm_discard_done:true` 二次确认，timeline 如实记丢弃了谁的
  //   完成确认——给撤销一个解锁通道，但不静默丢事实。
  router.post('/sys-releases/:id/cancel-schedule', authenticateToken, requireSysSchemaReady, requireLiaisonOnly, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const reason = (typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '');
    if (!reason || reason.length > 200) return res.status(400).json({ error: '撤销原因必填（trim 后 1..200 字）', code: 'CANCEL_REASON_REQUIRED' });
    const confirmDiscardDone = (req.body || {}).confirm_discard_done === true;
    const actor = sysActor(req);
    try {
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync(
          `SELECT id, status, release_assignee_name FROM sys_releases WHERE id = ?`,
          [id]
        );
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }
        if (rel.status !== '计划中') { await sysRollback(); return res.status(409).json({ error: '批次非「计划中」，不能撤销上线安排', code: 'RELEASE_NOT_PLANNING' }); }
        // C4b（305 号 M3）：行级批量惰性 stale 转换挪到这里——存在性/状态校验先过，请求若会被 404/409
        //   提前拒绝就不再触发这次 UPDATE（拒绝的请求零写库）。M3 原文是"移两处调用"：批次级
        //   staleTransitionForRelease 那一处已随本轮 H1 退场（Part 一）整体删除（该列再无任何写路径会产生
        //   'sending' 态，转换本身变得没有意义），故此处只剩行级 staleTransitionForExecutorRelease 这一处
        //   需要挪位——两处诉求因 Part 一/Part 三 同批次执行而自然合一，非漏做一半。
        await staleTransitionForExecutorRelease(id);
        // C4a：旧「仅 sent/stale/failed 才可撤销」聚合态准入闸已删除（v1.2 H1）——批次「计划中」即可撤销，
        //   partial（部分行 sent、部分 failed/stale）此前无恢复路径会卡死，本次一并解锁。

        // 子表在册行现状——用于 confirm_discard_done 闸 + timeline 留痕（原执行人姓名改读子表，不再依赖
        //   已冻结的批次级单列 rel.release_assignee_name）。
        const execRows = await dbAllAsync(
          `SELECT user_id, user_name, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL`,
          [id]
        );
        const doneNames = execRows.filter(r => r.exec_status === 'done').map(r => r.user_name);
        if (doneNames.length > 0 && !confirmDiscardDone) {
          await sysRollback();
          return res.status(409).json({
            error: `在册已有 ${doneNames.length} 人确认完成上线，撤销将丢弃其确认结果——请带 confirm_discard_done:true 二次确认`,
            code: 'CONFIRM_DISCARD_DONE_REQUIRED',
            done_executor_names: doneNames,
          });
        }
        // C4b（用户裁定）：子表为空时回落旧批次级单列——release_assignee_name 是历史批次（上线体统一
        //   重构 C0-C5 之前建的批次，或经旧上线编排家族留下的残留数据）唯一还留着执行人事实的地方，
        //   旧列本身已随批次级通知机制整体退场冻结为纯历史只读（无任何写路径），这条兜底永久保留，
        //   不随退场删除。
        const executorNamesText = execRows.length > 0
          ? execRows.map(r => r.user_name).join('、')
          : (rel.release_assignee_name || null);
        if (execRows.length > 0) {
          // L11（Opus 预筛）：removed_by_name 改 resolveExecutorDisplayName 统一（见 applyReleaseChange 内
          //   同款兜底注释——防 actor.name 恰为纯半角空格 display_name 绕过 sysActor() 的 `||` 判真假值，
          //   撞本表 removed_by_name 的非空 CHECK 当场 500）。
          await dbRunAsync(
            `UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?
               WHERE release_id = ? AND removed_at IS NULL`,
            [actor.id, resolveExecutorDisplayName({ display_name: actor.name }, actor.id), id]
          );
        }
        // C4b（H1 根治）：旧六列重置 CAS 已整体删除——批次级通知写路径（preemptReleaseNotifySend/
        //   sendReleaseNotifyAndWriteback/notify-executor 路由）随本轮退场全灭，再无任何并发写主体会与
        //   本请求争抢这几列，原先靠 token 比对兜的"防并发窗口内被抢先改动"这层保护已无对手可防。真正的
        //   并发安全性由 sysBeginImmediate() 的全局互斥事务保证——本请求从读 rel 到软删子表到写 timeline
        //   全程在同一个事务临界区内，不存在被插队的窗口，不需要再额外 CAS 一次已经不承担业务语义的旧列。
        await applyReleaseChange(id, actor, {
          added_issue_ids: [], removed_issue_ids: [], planned_date_changed: false,
          schedule_cancelled: true, cancel_reason: reason, discarded_done_names: doneNames,
        }, { skipReset: true, oldAssigneeName: executorNamesText });
        await sysCommit();
        res.json({ id, cancelled: true, old_assignee_name: executorNamesText, discarded_done_count: doneNames.length });
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 撤销上线安排失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '撤销上线安排失败' });
    }
  });

  // ── 批次级上线执行通知 markdown（区别于 issue 级 buildSysReleaseExecutorMarkdown，供 sys_releases
  //   批次通知复用；简洁自足，不依赖成员明细，避免为消息文案再查一轮成员列表）。 ──────────
  function buildReleaseBatchExecutorMarkdown(rel, baseUrl) {
    const title = `【上线值班】${rel.release_no || ('#' + rel.id)} 待您执行上线`;
    const lines = [
      `### 上线值班通知`,
      `批次：${rel.release_no || ('#' + rel.id)}${rel.title ? '（' + rel.title + '）' : ''}`,
      `计划上线日期：${rel.planned_date || '（未设置）'}`,
    ];
    // C2b 第2批：原式裸 baseUrl 只到首页，执行人无路径找到自己被指派的批次——改深链直达详情页「安排上线」
    // 面板（sysReleaseDeepLinkLine 定义于本文件下方，同 sysDeepLinkLine 一起维护）。link 自带 \n\n 前缀，
    // 直接字符串拼接（不进 lines 数组走 join，避免与 join 分隔符叠加产生多余空行——同 buildSysReleaseExecutorMarkdown
    // 既有拼接范式）。
    const link = sysReleaseDeepLinkLine(baseUrl, rel.id);
    return { title, md: lines.join('\n\n') + link };
  }

  // [C4b 删除·H1 根治] 批次级通知两段 CAS（preemptReleaseNotifySend/sendReleaseNotifyAndWriteback）已
  //   整体删除——唯一调用方 POST /sys-releases/:id/notify-executor 路由随批次级通知机制整体退场一并删除
  //   （见 GET /sys-releases/:id/executor-read-status 同批删除处注释）。行级等价机制见下方
  //   preemptReleaseExecutorNotifySend/sendReleaseExecutorNotifyAndWriteback（C2 起已是唯一活跃通道）。

  // ═══════════════════════════════════════════════════════════════════════════
  // C2：行级通知——两段 CAS 拆成两个可复用函数，供 /sys-releases/:id/executors/:userId/notify 路由调用
  //   （C3/C4 若有其它调用点亦复用同一份，不得另写旁路）。C4b 起是本模块唯一活跃的通知发送通道——
  //   批次级同构双胞胎（preemptReleaseNotifySend/sendReleaseNotifyAndWriteback）已随批次级通知机制
  //   整体退场删除（见上方一行删除说明），本组函数不再有"镜像批次级范式"这层历史包袱。
  //
  //   preemptReleaseExecutorNotifySend(releaseId, userId)：行级抢占发送权。**假定调用方已
  //     sysBeginImmediate()，本函数不 begin/commit**，调用方按返回的 outcome 自行决定 commit 还是
  //     rollback。返回判别式对象 { outcome, ... }。
  //   sendReleaseExecutorNotifyAndWriteback(releaseId, userId, preempt, actor)：外呼 + 写回五条件
  //     CAS（§4.1a 定稿逐字）。调用方必须在 preempt 那次事务已 COMMIT 之后（事务外）调用；本函数
  //     内部自己开一个新 sysBeginImmediate 做回写 + timeline，函数签名不暴露额外事务边界给调用方。
  //     本函数显式补齐 D16 同款判据（sys_notify_dry_run='on' 时跳过真实外呼，CAS+留痕照走）。
  // ═══════════════════════════════════════════════════════════════════════════
  async function preemptReleaseExecutorNotifySend(releaseId, userId) {
    // MED-1（Opus 预筛）：批次态闸——JOIN sys_releases 拿 status，与 PUT executors 闸⓿同码 409
    //   RELEASE_NOT_PLANNING（批次已发布/取消后不该还能通知某个执行人；此前只有 PUT 端点有这道闸，
    //   通知端点是漏网之鱼）。
    const row = await dbGetAsync(
      `SELECT sre.id, sre.notify_status, sre.exec_status, sr.status AS release_status
         FROM sys_release_executors sre
         JOIN sys_releases sr ON sr.id = sre.release_id
        WHERE sre.release_id = ? AND sre.user_id = ? AND sre.removed_at IS NULL`,
      [releaseId, userId]
    );
    if (!row) return { outcome: 'not_active' };
    if (row.release_status !== '计划中') return { outcome: 'not_planning' };
    // MED-2（Opus 预筛）：成员非空 fail-closed——空批次不该还能通知执行人（正常流程不可达，防的是异常
    //   态）。L1 订正：原批次级同款检查所在的 preemptReleaseNotifySend 函数已随 C4b H1 退场整体删除（连带
    //   其行号引用一并失效），本检查现已是这条不变量唯一的活体承担者，不再是"与批次级同码"的镜像副本。
    const memberCount = await dbGetAsync('SELECT COUNT(*) AS c FROM sys_issues WHERE release_id = ?', [releaseId]);
    if (!memberCount || memberCount.c === 0) {
      return { outcome: 'empty' };
    }
    // 顺序对齐方案定稿：done 优先于通知态判断（已确认完成的人不存在"再通知一次"的业务语义，误点会
    //   把该行打成 done+failed 制造没人看得懂的状态组合——同 R-GATE 分诊表"done 优先于通知态"同一理由）。
    if (row.exec_status === 'done') return { outcome: 'already_done' };
    // 路由入口已先调用 staleTransitionForExecutorRow 做过一轮惰性转换；此刻若仍是 sending，说明是
    //   真实在途（未超窗），不是该转未转的陈旧态。
    if (row.notify_status === 'sending') return { outcome: 'in_flight' };
    const priorStatus = row.notify_status;   // not_sent/sent/failed/stale 之一
    const newToken = crypto.randomBytes(16).toString('hex');
    const cas = await dbRunAsync(
      `UPDATE sys_release_executors SET
         notify_status='sending', notify_started_at=datetime('now','localtime'), notify_token=?,
         notified_at=NULL, notify_message_key=NULL, notify_error=NULL, read_at=NULL
       WHERE id=? AND release_id=? AND user_id=? AND removed_at IS NULL AND notify_status=?`,
      [newToken, row.id, releaseId, userId, priorStatus]
    );
    if (!cas || cas.changes !== 1) {
      return { outcome: 'concurrent_changed' };
    }
    return { outcome: 'preempted', rowId: row.id, token: newToken, priorStatus };
  }

  // 共用：行级通知 timeline 独立小事务写入（MED-3/MED-4，Opus 预筛），失败只 log 不上抛——发送结果
  //   （成功/失败/并发变更）已经在各自的 CAS 事务里落地为事实，timeline 只是留痕描述，不该因为它
  //   自己失败而让"已经发生的事实"被回滚或让整个请求报错误导（"事实"和"账面描述"分两条命）。
  async function writeExecutorNotifyTimelineSafe(releaseId, summary, actor, logCtx) {
    // 300-M1（codex）：members 查询移进外层 try——原先它在 try 之前，一旦这次 SELECT 本身失败（连接抖动
    //   等），异常会直接从本函数抛出，冒到调用方头上：正常分支会把已提交的成功发送结果变成 500 响应，
    //   concurrent_changed 分支更糟——会打破"这条分支必须返回 200+concurrent_changed，不能报错"的既有
    //   契约。本函数存在的意义就是"timeline 出什么问题都不该连累已经落地的发送事实"，读 members 本身
    //   也是"写 timeline"这个动作的一部分，必须一并纳入兜底。
    try {
      const members = await dbAllAsync('SELECT id FROM sys_issues WHERE release_id = ?', [releaseId]);
      if (members.length === 0) {
        // MED-2 闸理论上应已在预占阶段挡住零成员批次；这里出现是异常态（如预占后成员被并发清空的极窄
        //   窗口），不静默吞掉，写实 log 供排查，而不是假装成功。
        logger.warn(`[系统迭代] notify-executor(行级) timeline 留痕：批次 ${releaseId} 零成员，无法挂 timeline（${logCtx}）`);
        return false;
      }
      await sysBeginImmediate();
      try {
        for (const m of members) {
          await dbRunAsync(
            `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
             VALUES (?, 'scope_change', ?, 'release_executor_notify', ?, ?, ?)`,
            [m.id, summary, releaseId, actor.id, actor.name]
          );
        }
        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      return true;
    } catch (err) {
      logger.error(`[系统迭代] notify-executor(行级) timeline 留痕失败（${logCtx}）：release=${releaseId}`, err && err.message);
      return false;
    }
  }

  async function sendReleaseExecutorNotifyAndWriteback(releaseId, userId, preempt, actor) {
    const executor = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [userId]);
    let sendResult = { ok: false, reason: '执行人用户不存在' };
    let isDryRun = false;
    if (executor) {
      // D16 同款 dry-run 判据（sys_notify_dry_run 配置开关），措辞/归一化逻辑与 notify-liaison-test 一致。
      const dryRunRaw = await readSystemConfig('sys_notify_dry_run');
      const dryRunNorm = String(dryRunRaw || '').trim().toLowerCase();
      if (dryRunRaw && !['on', 'off', ''].includes(dryRunNorm)) {
        logger.warn(`[系统迭代] notify-executor(行级): sys_notify_dry_run 配置值疑似笔误（实际值=${JSON.stringify(dryRunRaw)}，非 on/off/空），本次按真发处理：release=${releaseId} user=${userId}`);
      }
      isDryRun = dryRunNorm === 'on';
      if (isDryRun) {
        sendResult = { ok: true, dry_run: true, message_key: `dryrun-${Date.now()}` };
      } else {
        const relInfo = await dbGetAsync('SELECT id, release_no, title, planned_date FROM sys_releases WHERE id = ?', [releaseId]);
        const baseUrl = await getSafePlatformBaseUrl();
        const { title, md } = buildReleaseBatchExecutorMarkdown(relInfo || { id: releaseId }, baseUrl);
        sendResult = await sendIssueDingtalkRaw(executor, title, md);
      }
    }

    const nowRow = sendResult.ok ? await dbGetAsync(`SELECT datetime('now','localtime') AS n`) : null;
    const notifiedAt = sendResult.ok ? (nowRow && nowRow.n) : null;
    const messageKey = sendResult.ok ? sendResult.message_key : null;
    const errMsg = sendResult.ok ? null : (sendResult.reason || '发送失败');

    // MED-3（Opus 预筛）：写回五条件 CAS 单独一个事务，先提交——发送结果是"已经发生的事实"，不能因为
    //   紧随其后的 timeline 留痕失败而被连累回滚/丢失。timeline 拆到本函数下半段独立第二个小事务。
    await sysBeginImmediate();
    let writeback;
    try {
      // 写回五条件 CAS（§4.1a 定稿逐字）：id+release_id+user_id+removed_at IS NULL+notify_token+
      //   notify_status='sending'——六个 WHERE 子句字面看着比"五条件"多一个，是因为 id 本身也是
      //   条件之一（方案原文把"行主键"单独算成条件①，本处逐字落地不做取舍）。
      writeback = await dbRunAsync(
        `UPDATE sys_release_executors SET
           notify_status = ?, notify_started_at = NULL,
           notified_at = ?, notify_message_key = ?, notify_error = ?
         WHERE id = ? AND release_id = ? AND user_id = ? AND removed_at IS NULL
           AND notify_token = ? AND notify_status = 'sending'`,
        [sendResult.ok ? 'sent' : 'failed', notifiedAt, messageKey, errMsg, preempt.rowId, releaseId, userId, preempt.token]
      );
      if (!writeback || writeback.changes !== 1) {
        await sysRollback();
        // 绝不降级写入：changes!==1 说明这行在预占之后又被并发动过（软删/代次更迭/另一次写回抢先），
        //   本次结果一律不落库，按 concurrent_changed 处理（同批次级既有范式）。
        logger.warn(`[系统迭代] notify-executor(行级) 结果回写被 CAS 拒绝（并发变更）：release=${releaseId} user=${userId}`);
        const fresh = await dbGetAsync('SELECT notify_status FROM sys_release_executors WHERE id = ?', [preempt.rowId]);
        // MED-4（Opus 预筛）：写回被拒不等于"什么都没发生"——通知这个动作已经真实发出去了，只是账本
        //   没记上，这个事实本身值得留痕，措辞与正常首发/重发区分开，不假装是一次干净成功。
        const userRow0 = await dbGetAsync('SELECT display_name FROM users WHERE id = ?', [userId]);
        const userName0 = (userRow0 && userRow0.display_name) || `user#${userId}`;
        // 300-L1（codex）：接收返回值——concurrent_changed 是账面不一致风险最高的路径（发送结果和 CAS
        //   记录本来就已经对不上了），补留痕这一步再失败必须让调用方/前端看得见，不能默默吞掉第二次。
        const timelineOkCC = await writeExecutorNotifyTimelineSafe(
          releaseId, `通知执行人：${userName0}（通知已发出但结果未入账，并发变更）`, actor, 'concurrent_changed');
        return { outcome: 'concurrent_changed', notify_status: fresh ? fresh.notify_status : null, dry_run: isDryRun, timeline_failed: !timelineOkCC };
      }
      await sysCommit();
    } catch (txErr) {
      try { await sysRollback(); } catch (_) { /* ignore */ }
      throw txErr;
    }

    // MED-3：timeline 独立小事务——失败只 log + 响应带 timeline_failed:true，不影响已提交的发送结果。
    const userRow = await dbGetAsync('SELECT display_name FROM users WHERE id = ?', [userId]);
    const userName = (userRow && userRow.display_name) || `user#${userId}`;
    const kindLabel = preempt.priorStatus === 'not_sent' ? '首发' : '重发';
    // HIGH-1（Opus 预筛）：演练与真发不得在留痕上混同（同 D16/282-N1"演练不得与真发混同"口径）——
    //   summary 显式标注"·演练"，事后翻 timeline 不会把一次 dry-run 误读成真的发出过通知。
    const dryTag = isDryRun ? '·演练' : '';
    const summary = sendResult.ok
      ? `通知执行人：${userName}（${kindLabel}${dryTag}）`
      : `通知执行人：${userName}（${kindLabel}，失败：${errMsg}）`;
    const timelineOk = await writeExecutorNotifyTimelineSafe(releaseId, summary, actor, 'send-result');

    return {
      outcome: sendResult.ok ? 'sent' : 'failed', notify_status: sendResult.ok ? 'sent' : 'failed',
      notify_error: errMsg, dry_run: isDryRun, timeline_failed: !timelineOk,
    };
  }

  // ⭐ L7（Opus 预筛）：user_ids 元素严格解析——只接受 number 类型或纯数字字符串，拒绝布尔/数组/对象/
  //   浮点数/科学计数法等"看似能转成数字但不该被当作 user_id"的畸形输入（同 normalizeSysEffortDays 的
  //   269 号 codex 收紧精神：裸 Number(el) 对 true/[5]/'0x10' 等会静默转出"看起来合法"的数字，掩盖真实
  //   输入形态）。返回正整数或 null（null=非法，调用方据此整体拒绝）。
  function parseStrictPositiveUserId(el) {
    if (typeof el === 'number') {
      return (Number.isSafeInteger(el) && el > 0) ? el : null;
    }
    if (typeof el === 'string' && /^\d+$/.test(el)) {
      const n = Number(el);
      return (Number.isSafeInteger(n) && n > 0) ? n : null;
    }
    return null;
  }

  // ⭐ 301-M2（Opus 预筛）：执行人姓名兜底解析——PUT executors 与 hotfix-publish 两处共用（原各自内联
  //   `(u && u.display_name) || \`user#${uid}\`` 逐字重复，抽出本函数消灭双份漂移风险）。加固两个既有
  //   缺口：
  //   ① JS `||` 只判真假值，非空白字符串是 truthy——一个全空格 display_name（含全角空格 U+3000）会
  //     绕过兜底被当"有效姓名"直插子表，撞上 sys_release_executors.user_name 的 CHECK（SQLite 双参
  //     trim(x,' '||char(9)||char(10)||char(13)) 只认半角空格/Tab/LF/CR，不认 U+3000——纯半角空格会被
  //     CHECK 拒当场 500；半角+全角混合反而"合法通过" CHECK，却存进一个人眼看不出内容的姓名，是比 500
  //     更隐蔽的数据质量坑）。改用 JS `.trim()`（覆盖 ECMAScript WhiteSpace 类，含 U+3000）做"是否有效
  //     内容"的真实判据，不依赖 DB CHECK 兜底。
  //   ② 既有 display_name||username||user#id 三级范式（对照 :405-408/:2114-2117 等既有同款写法）在这
  //     两处漏了中间一级 username 兜底——补齐：display_name trim 后非空则用之，否则 username trim 后
  //     非空则用之，仍空才落到 user#uid。
  function resolveExecutorDisplayName(user, uid) {
    const dn = user && typeof user.display_name === 'string' ? user.display_name.trim() : '';
    if (dn) return dn;
    const un = user && typeof user.username === 'string' ? user.username.trim() : '';
    if (un) return un;
    return `user#${uid}`;
  }

  // ── PUT /sys-releases/:id/executors：设置上线执行人集合（admin，方案 v1.7 §4.4 端点 2 + 四道闸 + §4.1a 代次语义）──
  //   只收去重后的 user_ids 数组；姓名/资格**一律服务端同一写事务内重查重算，不信客户端**（不接受前端
  //   传来的候选清单/姓名字段）。四道闸按方案定稿顺序执行，错误码精确：
  //     ⓿ 批次态闸（CAS 语义，非先查后写——guarded 空写 UPDATE + changes 检查，防"空集陷阱"：已发布批次
  //       若子表恰好为空〔迁移对"已发布且无执行人"不插行〕，闸①对空集合恒真会误放行，必须先有本闸）
  //       → 违反 409 RELEASE_NOT_PLANNING
  //     ① 生命周期闸（全部在册行须 notify_status='not_sent' ∧ exec_status='pending' 才可写；任一行进入
  //       sending/sent/failed/stale 整体拒绝——换人须先 cancel-schedule 整体作废再重新安排，C4 落地）
  //       → 违反 409 EXECUTORS_LOCKED
  //     ② 人数闸（去重后 ≥1——⭐ 用户拍板决策 7 第三次修正〔方案 v1.7 二订〕：下限 2→1，单人批次
  //       是合法的多人机制退化态） → 违反 400 EXECUTORS_TOO_FEW（空集合仍拒，码不变）
  //     ③ 资格闸（每个 user_id 同事务实时过 hasReleaseEligibility，与 GET executor-candidates 的 eligible
  //       判据同一函数、单一来源） → 违反 400 EXECUTOR_NOT_ELIGIBLE
  //   集合替换=软删不在新集合中的在册行（removed_at/removed_by/removed_by_name 三列成组）+ INSERT 新增的，
  //   **绝不复活旧行**（§4.1a 代次语义：行 id 即代次，软删行留在原地，重新加入永远是新 id）；仍在新集合
  //   中的既有在册行原样不动（不软删也不重插，代次不变）。timeline 记「设置上线执行人：张三、李四」，照
  //   applyReleaseChange 既有范式按受影响成员各写一条（ref_id=releaseId 关联同一次调用产生的多行）。
  //   ⭐ MED-1（Opus 预筛）：**新集合与在册集合完全一致时（无软删也无新增）是空差量 no-op**——跳过软删/
  //   INSERT/timeline 全部写入，只走查询+提交，响应体 `changed:false`；真有变更时 `changed:true`——对齐
  //   `update-planned-date`（:9572-9588）的 `changed` 字段范式与 `applyReleaseChange` 的空差量直接返回
  //   （不写 timeline）同一精神，防止管理员重复点"保存"时刷出没有实际变化的 timeline 噪音。
  router.put('/sys-releases/:id/executors', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const actor = sysActor(req);
    const b = req.body || {};

    // 输入面校验（早于任何 DB 访问，纯请求形状检查）：user_ids 必须是正整数数组，去重（决策 7"去重后"口径）
    if (!Array.isArray(b.user_ids)) {
      return res.status(400).json({ error: 'user_ids 必须是数组', code: 'INVALID_USER_IDS' });
    }
    const rawIds = b.user_ids.map(parseStrictPositiveUserId);
    if (rawIds.some(n => n === null)) {
      return res.status(400).json({ error: 'user_ids 元素须为正整数（number 或纯数字字符串）', code: 'INVALID_USER_IDS' });
    }
    const userIds = [...new Set(rawIds)];

    let changed = false;
    try {
      await sysBeginImmediate();
      try {
        // ⓿ 批次态闸：guarded 空写（SET status=status 是无副作用的自赋值，只为拿到一次 WHERE 条件生效的
        //   changes 计数），非"先 SELECT 读 status 再 JS if 判断"——落实"CAS 语义"要求，DB 层而非仅应用层
        //   拒绝非「计划中」批次的写入。
        const gate0 = await dbRunAsync(`UPDATE sys_releases SET status = status WHERE id = ? AND status = '计划中'`, [id]);
        if (!gate0 || gate0.changes !== 1) {
          const exists = await dbGetAsync('SELECT id FROM sys_releases WHERE id = ?', [id]);
          if (!exists) throw new SysTransitionError(404, 'RELEASE_NOT_FOUND', '上线批次不存在');
          throw new SysTransitionError(409, 'RELEASE_NOT_PLANNING', '批次非「计划中」，不能设置执行人');
        }

        // ① 生命周期闸
        const activeRows = await dbAllAsync(
          `SELECT id, user_id, user_name, notify_status, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL`,
          [id]
        );
        const locked = activeRows.some(r => r.notify_status !== 'not_sent' || r.exec_status !== 'pending');
        if (locked) throw new SysTransitionError(409, 'EXECUTORS_LOCKED', '存在执行人已进入通知/确认流程，须先撤销上线安排后再重新设置');

        // ② 人数闸（决策 7 三修：下限 2→1，空集合仍拒）
        if (userIds.length < 1) throw new SysTransitionError(400, 'EXECUTORS_TOO_FEW', '至少选择 1 名执行人');

        // ③ 资格闸：逐个重查资格（hasReleaseEligibility，与候选端点同一函数）+ 姓名（不信客户端传来的任何姓名字段）
        const resolved = [];
        for (const uid of userIds) {
          const eligible = await hasReleaseEligibility(uid);
          if (!eligible) throw new SysTransitionError(400, 'EXECUTOR_NOT_ELIGIBLE', `用户 ID=${uid} 不具备上线执行资格`);
          // 301-M2：SELECT 补 username（resolveExecutorDisplayName 的中间兜底级需要它）。
          const u = await dbGetAsync('SELECT display_name, username FROM users WHERE id = ?', [uid]);
          resolved.push({ id: uid, name: resolveExecutorDisplayName(u, uid) });
        }

        // 集合替换：软删不在新集合中的在册行 + INSERT 新增的；仍在新集合中的既有在册行原样不动
        const newIdSet = new Set(userIds);
        const activeIdSet = new Set(activeRows.map(r => Number(r.user_id)));
        const toRemove = activeRows.filter(r => !newIdSet.has(Number(r.user_id)));
        const toAdd = resolved.filter(r => !activeIdSet.has(r.id));

        // 空差量 no-op（MED-1）：新集合与在册集合完全一致 → 不软删、不 INSERT、不写 timeline，只提交。
        changed = toRemove.length > 0 || toAdd.length > 0;
        if (changed) {
          for (const r of toRemove) {
            // L11（Opus 预筛）：removed_by_name 改 resolveExecutorDisplayName 统一（同款兜底见
            //   applyReleaseChange/cancel-schedule 软删处注释，三端点耦合同一防线）。
            const upd = await dbRunAsync(
              `UPDATE sys_release_executors SET removed_at = datetime('now','localtime'), removed_by = ?, removed_by_name = ?
               WHERE id = ? AND removed_at IS NULL`,
              [actor.id, resolveExecutorDisplayName({ display_name: actor.name }, actor.id), r.id]
            );
            if (!upd || upd.changes !== 1) throw new Error(`执行人行 #${r.id} 软删异常（期望 1 行，实际 ${upd && upd.changes}）`);
          }
          for (const r of toAdd) {
            const ins = await dbRunAsync(
              `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)`,
              // 310-M1：added_by_name 过 resolveExecutorDisplayName 兜底——actor.name（JWT display_name）为纯空白时
              //   会撞本表 added_by_name 双参 trim 非空 CHECK 变 500，与 removed_by_name 三处兜底同一口径。
              [id, r.id, r.name, actor.id, resolveExecutorDisplayName({ display_name: actor.name }, actor.id)]
            );
            if (!ins || !ins.lastID) throw new Error(`执行人 user_id=${r.id} 插入异常`);
          }

          // timeline（照 applyReleaseChange §6.13 既有范式）：按受影响成员 issue 各写一条，ref_id=releaseId 关联
          const names = resolved.map(r => r.name).join('、');
          const members = await dbAllAsync('SELECT id FROM sys_issues WHERE release_id = ?', [id]);
          for (const m of members) {
            await dbRunAsync(
              `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
               VALUES (?, 'scope_change', ?, 'release_executors_set', ?, ?, ?)`,
              [m.id, `设置上线执行人：${names}`, id, actor.id, actor.name]
            );
          }
        }

        await sysCommit();
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      const finalRows = await dbAllAsync(
        `SELECT id, user_id, user_name, notify_status, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`,
        [id]
      );
      res.json({ id, executors: finalRows, changed });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 设置执行人失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '设置执行人失败' });
    }
  });

  // [C4b 删除·H1 根治] POST /sys-releases/:id/notify-executor（批次级"通知执行开发"，两段 CAS）+
  //   GET /sys-releases/:id/executor-read-status（批次级"查已读"）两路由已整体删除——批次级单执行人
  //   通知机制随本轮退场全灭，唯一活跃通道收敛为下方行级端点（POST .../executors/:userId/notify +
  //   GET .../executors/:userId/read-status）。
  //   [C5 已收口] 前端 Sys_Iteration.html 曾有三处调用点（306 号 L3 订正计数——原文误记"两处"：
  //   siReleaseResendExecutor"重新通知"、siReleaseQueryExecutorRead"查询已读"、siReleaseNotifyExecutor
  //   "安排上线"）指向这两个已删除的路由——C5 已整体重写安排上线面板为多执行人 UI：三个旧函数连同其
  //   `[C5-TODO]` 标记已随重写整体删除（不是改调用目标，是函数本身不再存在），新入口见
  //   siReleaseSetExecutorsModal（选人+PUT executors）/siExecutorRowNotify（行级发通知）/
  //   siExecutorRowReadStatus（行级查已读）。
  //   历史存档（供排障对照旧行为）：这两个路由原来的完整实现见 codex 305 号审查前的版本（git blame 本文件
  //   本段落，或查 `docs/local/codex审查记录/系统迭代/` 下 C4a/C4b 相关归档）。

  // ── POST /sys-releases/:id/executors/:userId/notify：通知执行人（行级，C2，方案 v1.7 §4.4 端点 3）──────────
  //   行级唯一发送入口：首发/重发/失败重试**同端点按行状态分支**，无群发（决策 4，见 PUT executors
  //   头部注释同一原则）。一人失败不牵连另一人——本端点天然只操作一行，"行级独立无批次级回滚"是结构性
  //   成立，不需要额外代码保证。
  router.post('/sys-releases/:id/executors/:userId/notify', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_USER_ID' });
    const actor = sysActor(req);
    try {
      await staleTransitionForExecutorRow(id, userId);   // 行级 stale 惰性转换，先于抢占判断（同批次级既有范式）

      let preempt = null;
      await sysBeginImmediate();
      try {
        preempt = await preemptReleaseExecutorNotifySend(id, userId);
        if (preempt.outcome === 'preempted') { await sysCommit(); } else { await sysRollback(); }
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      switch (preempt.outcome) {
        case 'not_active': return res.status(404).json({ error: '该用户不是本批次在册执行人（未加入/已被移除）', code: 'EXECUTOR_NOT_ACTIVE' });
        // MED-1（Opus 预筛）：批次态闸，与 PUT executors 闸⓿同码同文案精神。
        case 'not_planning': return res.status(409).json({ error: '批次非「计划中」，不能通知执行人', code: 'RELEASE_NOT_PLANNING' });
        // MED-2（Opus 预筛）：成员非空 fail-closed，与批次级 notify-executor 的 RELEASE_EMPTY 同码。
        case 'empty': return res.status(409).json({ error: '批次内无待上线单，不能通知执行人', code: 'RELEASE_EMPTY' });
        case 'already_done': return res.status(409).json({ error: '该执行人已确认完成上线，不能再次通知', code: 'EXECUTOR_ALREADY_DONE' });
        case 'in_flight': return res.status(409).json({ error: '已有发送在途，请稍候', code: 'NOTIFY_IN_FLIGHT' });
        // 抢占阶段 CAS 落空：按字面指令走 409（区别于下方写回阶段沿用既有"200+concurrent_changed 标志"
        //   范式——两处 CAS 失败语义不同：这里是"你依据的前置态已经不新鲜，请重新读一遍再试"，值得让
        //   调用方显式重试；写回阶段是"发送这个既成事实已经发生，只是账本没记上"，200 更贴切。
        case 'concurrent_changed':
          return res.status(409).json({ error: '通知状态已并发变更，请重试', code: 'NOTIFY_CONCURRENT_CHANGED', concurrent_changed: true });
        default: break;   // 'preempted' → 往下走事务外通知
      }

      const sendOutcome = await sendReleaseExecutorNotifyAndWriteback(id, userId, preempt, actor);
      if (sendOutcome.outcome === 'concurrent_changed') {
        // L2（Opus 预筛）：concurrent_changed 响应补 dry_run 字段（282 同款响应形状一致性——调用方不该
        //   因为走了并发分支就少拿到这个字段）。300-L1：同步透出 timeline_failed——这条分支本身已经是
        //   账面不一致风险最高的路径，"补留痕这步也失败了"必须让调用方看得见，不能比正常成功分支还隐蔽。
        return res.json({ id, user_id: userId, concurrent_changed: true, notify_status: sendOutcome.notify_status, dry_run: sendOutcome.dry_run, timeline_failed: sendOutcome.timeline_failed });
      }
      res.json({
        id, user_id: userId, notify_status: sendOutcome.notify_status,
        notify_error: sendOutcome.notify_error, dry_run: sendOutcome.dry_run,
        timeline_failed: sendOutcome.timeline_failed,   // MED-3：timeline 独立小事务失败时置 true，不影响本次响应仍是成功
      });
    } catch (err) {
      if (err instanceof SysTransitionError) return sendSysTransitionError(res, err);
      logger.error('[系统迭代] 通知执行人（行级）失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '通知执行人失败' });
    }
  });

  // ── GET /sys-releases/:id/executors/:userId/read-status：执行人查已读（行级，C2，改造 #9）──────────
  //   镜像上方批次级 executor-read-status 的范式：token 重试 + 已读固化写回 + 权限同通道仅 admin。
  //   固化写回带**收件人+message_key 双围栏**下沉行级，额外加 `removed_at IS NULL` + 行 `id`——代次
  //   隔离（§4.1a）：软删旧行永不被写回，即便 message_key 恰好撞见历史值也拦得住（行 id 是最强的那道
  //   围栏，message_key 只是第二道）。message_key 为空的行（从未发过/历史脏数据）返回明确不可查语义
  //   `read_status:'no_message_key'`，非报错——404/500 会让前端误以为哪里坏了，而这其实是正常态
  //   （not_sent 行本就没有 message_key）。
  //   [C5 已收口] ⭐ L3（Opus 预筛，C4b 订正）：本端点"从未发送"（message_key 为空）走 200 + read_status:
  //   'no_message_key'，非报错——这是刻意的设计选择，不是历史遗留：批次级 executor-read-status（旧路由，
  //   曾对"尚未成功发送"走 400 NOTIFY_NOT_SENT）已随 C4b H1 退场整体删除，不再有可比对的活体对照组，
  //   原"两端点故意不同码"的对比措辞连带失去意义。行级设计的立场独立成立：'还没发/发了没人读/读了'是
  //   同一枚举维度上的三种正常态，不该有一种单独被 400 特殊对待——C5 前端只需接这一套 read_status 枚举
  //   判定，不必再兼容另一套错误码语义。
  //   ⭐ 300-L2（codex）：read_status 统一枚举——本端点每条分支都带这个字段，C5 前端一套 switch 判定，
  //   不用另外拼 read/cached/dry_run 几个布尔位判断到底是哪种状态：
  //     'no_message_key'        从未发过通知（message_key 为空）
  //     'dry_run'                message_key 是演练伪造值，不可查真实已读
  //     'recipient_unresolved'   收件人钉钉号解析不出，查不了
  //     'read'                    已读（cached 快路径或本次活查命中）
  //     'unread'                  本次活查未命中已读（发了，暂无人读）
  router.get('/sys-releases/:id/executors/:userId/read-status', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const userId = parsePositiveId(req.params.userId);
    if (!userId) return res.status(400).json({ error: '无效的用户 ID', code: 'INVALID_USER_ID' });
    try {
      const row = await dbGetAsync(
        `SELECT id, notify_status AS ns, notify_message_key AS mk, read_at AS ra
           FROM sys_release_executors WHERE release_id = ? AND user_id = ? AND removed_at IS NULL`,
        [id, userId]
      );
      if (!row) return res.status(404).json({ error: '该用户不是本批次在册执行人（未加入/已被移除）', code: 'EXECUTOR_NOT_ACTIVE' });
      if (!row.mk) return res.json({ read: false, read_at: null, read_status: 'no_message_key' });
      if (row.ra) return res.json({ read: true, read_at: row.ra, cached: true, read_status: 'read' });
      // HIGH-1 子项（Opus 预筛）：演练发送产生的 message_key 恒以 dryrun- 开头，是伪造值——短路必须放
      //   在读钉钉配置/外呼之前，不能指望"本地凭证恰好没配"兜底（本地实测三项凭证俱全，见 L1 订正）；
      //   否则会拿这个假 key 去真打 getReadStatus，钉钉侧大概率报错，但仍是一次不该发生的真实外呼。
      if (row.mk.startsWith('dryrun-')) return res.json({ read: false, read_at: null, read_status: 'dry_run' });
      const [appKey, appSecret, robotCode] = await Promise.all(
        ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig));
      if (!appKey || !appSecret || !robotCode) return res.status(500).json({ error: '钉钉配置未填写', code: 'NO_DINGTALK_CONFIG' });
      let token;
      try { token = await dingtalkNotify.getAccessToken(appKey, appSecret); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
      const u = await dbGetAsync('SELECT dingtalk_user_id FROM users WHERE id = ?', [userId]);
      const uid = u && u.dingtalk_user_id ? String(u.dingtalk_user_id).trim() : '';
      if (!uid) return res.json({ read: false, read_at: null, read_status: 'recipient_unresolved' });
      let readResult;
      try { readResult = await callDingtalkWithTokenRetry(appKey, appSecret, token, (t) => dingtalkNotify.getReadStatus(t, robotCode, row.mk)); }
      catch (err) { const cls = dingtalkNotify.classifyError(err); return res.status(502).json({ error: cls.hint, reason: cls.reason }); }
      const my = (readResult.readDetails || []).find(d => String(d.userId).trim() === uid && d.readStatus === 'READ');
      let readAtStr = null;
      if (my) {
        // L6（Opus 预筛）：read_at 改 SQL 侧 datetime('now','localtime') 计算——弃用 toLocaleString
        //   的斜杠格式（'2026/2/1 10:00:00'，locale 相关、月日不补零），对齐项目"时间格式统一"口径
        //   （truncToMinute/normalizeDeadlineDT 同款 SQL-side 计算范式）。语义也更贴切：记的是"本系统
        //   查询确认已读的时刻"，不盲信钉钉回执自带的 readTimestamp（时钟源不同，不必强行换算）。
        const nowRow = await dbGetAsync(`SELECT datetime('now','localtime') AS n`);
        readAtStr = nowRow && nowRow.n;
        await sysNotifyWrite(
          `UPDATE sys_release_executors SET read_at = ?
             WHERE id = ? AND release_id = ? AND user_id = ? AND removed_at IS NULL AND notify_message_key = ? AND read_at IS NULL`,
          [readAtStr, row.id, id, userId, row.mk]);
      }
      // 300-L2：活查分支同样补稳定枚举——已读/未读不再只靠裸 read 布尔位区分。
      res.json({ read: !!my, read_at: readAtStr, read_user_count: (readResult.readUserIds || []).length, read_status: my ? 'read' : 'unread' });
    } catch (err) {
      logger.error('[系统迭代] 执行人（行级）查已读失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '查已读失败' });
    }
  });

  // ── C3 重写（方案 §4.3 全文）：POST /sys-releases/:id/execute：「确认我这一份」+ R-GATE（行级双确认）
  //   ──────────
  //   ⭐ 语义整体切换：旧口径"批次 notify_status='sent' ∧ release_assignee_id===actor.id"（单人执行）
  //   → 新口径"actor 自己那一行 notify_status='sent' ∧ removed_at IS NULL ∧ exec_status='pending'"
  //   （多人各自确认，谁被通知了谁才能确认，不再依赖批次级聚合态）。
  //   **前端必传 `executor_row_id`**（行主键=代次，§4.1a）——缺参直接 400，**不做"服务端自己查一行"
  //   的兜底**：那等于把代次保证又丢了（v1.3 修正案例：对接人撤销安排+admin 重新安排产生新行后，A 的
  //   旧页面确认请求会误打进新代次，见 §4.3 逐字论述）。
  //   **行级 CAS**（§4.3 定稿逐字，user_id=actor.id——只能确认自己那份）：
  //     UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime')
  //       WHERE id=? AND release_id=? AND user_id=? AND removed_at IS NULL
  //         AND notify_status='sent' AND exec_status='pending'
  //   `changes===1` 才走 R-GATE；`changes!==1` 回查该行做**幂等三分诊**（判序：`done` 优先于通知态，
  //   v1.3·codex 254-B M-b——已 `done` 的人若被误重发且失败，该行会变成 `done+failed`，判序错了会先撞
  //   `NOTIFY_NOT_SENT`，等于告诉一个已经确认完的人"你还没收到通知"，纯误导）：
  //     ① 行不存在/已软删/`id` 与 `release_id`+`user_id` 不匹配 → 403 `EXECUTOR_NOT_ACTIVE`
  //     ② `exec_status==='done'` → **幂等成功 200**：`{my_status:'done', already:true, pending_count:N,
  //        released:<批次是否已发布>}`
  //     ③ `notify_status!=='sent'` → 409 `NOTIFY_NOT_SENT`
  //   ⚠️ **设计决策（供复核）**：本端点**不**在事务顶部单独判"批次必须计划中"再拒绝——那会与②的
  //   `released:<bool>` 契约冲突：一个批次已发布后，其全部执行人行必然是 `done`（R-GATE 前置条件），
  //   任何后续重复确认请求本就该落进②的幂等分支、如实报 `released:true`，若顶部先按批次非计划中拒绝，
  //   这条路径永远走不到②。安全性由两层深层保障：CAS 本身的隐式不变量（能让 CAS 成功的行，那一刻批次
  //   必是「计划中」——已发布批次的行必然全 `done`，不可能再满足 `exec_status='pending'`）+
  //   `_publishReleaseCoreInTxn` 内部独立 re-check（R-GATE 触发发布那一刻若批次状态有异会在那里抛错，
  //   整体回滚，见其函数体）。
  //   **R-GATE**（同事务，照搬 W-GATE）：CAS 成功后，在册人数≥1（决策 7 三修下限 2→1）∧ 无 `pending` → 调
  //   `_publishReleaseCoreInTxn` 翻「已发布」；未满足只落自己那行（CAS 已完成）+ timeline「执行人张三
  //   确认完成（还差 N 人）」，批次仍「计划中」。**发布失败整体回滚**：`_publishReleaseCoreInTxn` 抛错
  //   （如上线说明为空）时，本人的 `done` 一并回滚不落库——不允许"我确认了、批次没发布、我却是 done"
  //   的半截态（两者同一事务，天然满足）。
  //   **上线说明时机（M4）**：`release_note`/`version_tag` 可选，仅 R-GATE 真触发发布那一次由
  //   `_publishReleaseCoreInTxn` 内部校验非空（闸门③逐字未动）；非最后一人时这两参数即使传了也不使用
  //   （不校验也不落库，不会因非最后一人传了格式有问题的说明而被误拒）。
  //   **六校验去留清单**（对照 C3 改造前现状代码逐条判定，完整论述见完成报告）：
  //     保留——批次存在性（404 RELEASE_NOT_FOUND）/ actor 资格实时复核（`hasReleaseEligibility`，事务内
  //       自读自判，403 EXECUTOR_NOT_ELIGIBLE）/ RELEASE_EMPTY（由 `_publishReleaseCoreInTxn` 内部既有
  //       检查覆盖，R-GATE 触发发布时若批次空会在那里抛错触发整体回滚，本端点不重复该检查）
  //     移除——① 批次级 `staleTransitionForRelease(id)` 调用（L1 订正：该函数本身已随 C4b H1 退场从本文件
  //       整体删除，此处是历史设计记录——本端点当时判定不调用它就已不受影响，与"该函数后来是否还存在"
  //       无关）：该函数转的是 `release_assignee_notify_status` 这个新架构已不读的批次级列，对本端点判定
  //       结果零影响（'sending'/'stale' 均不满足新 CAS 的 `notify_status='sent'` 条件，转不转都一样落
  //       ③ NOTIFY_NOT_SENT 分诊，无需引入行级 stale 转换替代——不影响正确性，纯粹省一次无意义的写）
  //       ② 顶部单独的批次「计划中」拒绝分支（见上方"设计决策"）
  //       ③ 旧 `release_assignee_id` 单列比对 / 旧批次级 `notify_status` 单列比对：均被行级 CAS 自身的
  //       五条件 + 幂等三分诊表达取代，不再是独立的前置 if
  //   ⭐ [MED-1/302-M1/303-M1 已删除·用户拍板决策 7 第三次修正（方案 v1.7 二订）] CAS 之前曾有一道
  //     在册人数闸（`rosterCount<2` → 409 `EXECUTORS_TOO_FEW`），目的是避免"注定发不出去的批次也把行
  //     烧成 done"——引入它的前提是"下限 2 人，1 人批次永远凑不齐 R-GATE"；决策 7 三修把下限降到 1 人
  //     后，这个前提不再成立（任何 ≥1 在册的批次都可能凑齐 R-GATE），本闸整体移除。done 幂等分诊路由
  //     （preRow.exec_status==='done' 直接幂等回显）与资格闸/CAS 链完全不受影响，原样保留——本条只删
  //     "判人数"这一步，判序结构不变。
  //   ⭐ LOW-4 登记（Opus 预筛，L1 订正生产调用点声称）：行级 stale 批量兜底刷新
  //     `staleTransitionForExecutorRelease`（**C2 已实现**，见上方函数定义处）本端点**刻意不接线**——⚠️ 原
  //     "当前零生产调用点，仅 _internals 导出+单元断言看守"已过时：C4a 改造 5b 已按原计划把它接进详情端点
  //     GET /sys-releases/:id（见该路由内调用），C4b（305 号 M3）又把 cancel-schedule 的批量刷新也接了进去
  //     ——如今是两处活跃生产调用点，唯独本端点（execute 确认）仍不接，理由不变：单行 CAS 自身已完整覆盖
  //     超窗判定的正确性（见下方分析），接线与否只影响提示文案精细度，不影响判定结果。本端点当前对超窗
  //     `sending` 行
  //     的实际行为：CAS 五条件里 `notify_status='sent'` 不满足 → `changes!==1` → 幂等三分诊 → `exec_status`
  //     非 `done` → 落分诊③ `NOTIFY_NOT_SENT`（LOW-3 后文案带回 `当前状态：sending`）——用户体验是"提示
  //     未收到通知"而非更精确的"发送中/已超时"，但不影响正确性（`sending` 状态下这一行客观上确实还没有
  //     一次成功送达，"未收到通知"是真实描述），纯粹是可优化的措辞精细度，非功能缺口。
  router.post('/sys-releases/:id/execute', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的批次 ID', code: 'INVALID_RELEASE_ID' });
    const actor = sysActor(req);
    const b = req.body || {};
    // LOW-2（Opus 预筛）：executor_row_id 改用 parseStrictPositiveUserId 同款严格解析（同文件 user_ids[]
    //   元素解析同一口径——只接受 number 或纯数字字符串，拒绝布尔/数组/对象/浮点数/科学计数法等"看似能
    //   转成数字但不该被当作行 id"的畸形输入；旧 parsePositiveId 对 true/[5] 等会经 Number() 静默转出
    //   "看起来合法"的数字，同一文件同一类输入（数据库自增 id）不该有两套宽松度不同的解析口径）。
    const executorRowId = parseStrictPositiveUserId(b.executor_row_id);
    if (!executorRowId) return res.status(400).json({ error: '缺少 executor_row_id（页面可能已过期，请刷新重试）', code: 'EXECUTOR_ROW_ID_REQUIRED' });
    const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '');
    const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '');
    try {
      let outcome = null;   // { kind:'published', result } | { kind:'pending', pendingCount }
      await sysBeginImmediate();
      try {
        const rel = await dbGetAsync(`SELECT id FROM sys_releases WHERE id=?`, [id]);
        if (!rel) { await sysRollback(); return res.status(404).json({ error: '上线批次不存在', code: 'RELEASE_NOT_FOUND' }); }

        // 302-M1/303-M1（Opus 预筛/对抗审）判序遗产（人数闸本身已随决策 7 三修删除，判序结构保留）：
        //   ⭐ 资格闸（`hasReleaseEligibility`）挪到 done 路由之后——已 done 是既成事实，其幂等回显不该
        //   被"此刻资格状态"否决（判序哲学："done 优先于一切事后才发生变化的过程态"，资格是否还有效
        //   属于此类）。最终判序：
        //     ① 行不存在（或已软删/id 不匹配）→ 403 EXECUTOR_NOT_ACTIVE
        //     ② 行存在且 exec_status='done' → 直接走幂等分诊②（不过资格闸、不进 CAS——已完成的确认
        //        永远是幂等成功，不因本人资格此刻失效而改判；补充用例：done 之后本人账号被禁用，重复
        //        确认仍 200 already:true）
        //     ③ 行存在且 exec_status='pending' → 此时才过资格闸（403 EXECUTOR_NOT_ELIGIBLE）→ 照常走
        //        行级 CAS（下方 CAS 五条件逐字未动，历次改造只挪了"谁来决定走哪条分诊路"，不碰 CAS 本身
        //        的原子写语义）。[决策 7 三修] 原判序③这一步曾还要过一道"人数闸"（rosterCount<2 → 409
        //        EXECUTORS_TOO_FEW，与中心守卫同码——同一判定的镜像前置），随下限降到 1 人已整体删除，
        //        中心守卫那道仍在（`< 1`，见 :8285 一带），纵深防御关系不变，只是本端点这层前置副本
        //        没有存在的必要了（`rosterCount>=1` 在"行已存在"这个前提下恒真：既然 preRow 查得到这
        //        一行，说明子表对本批次至少有这一行，`rosterCount` 不可能为 0）。
        const preRow = await dbGetAsync(
          `SELECT id, notify_status, exec_status FROM sys_release_executors
             WHERE id=? AND release_id=? AND user_id=? AND removed_at IS NULL`,
          [executorRowId, id, actor.id]
        );
        if (!preRow) {
          await sysRollback();
          return res.status(403).json({ error: '你已不是本批次执行人，或页面已过期请刷新', code: 'EXECUTOR_NOT_ACTIVE' });
        }
        if (preRow.exec_status === 'done') {
          const pendingRow = await dbGetAsync(
            `SELECT COUNT(*) AS c FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL AND exec_status='pending'`,
            [id]
          );
          // 302-L1（Opus 预筛）：released 当场重算（不用事务头快照——降低对写事务串行实现的隐性依赖）。
          const relNow = await dbGetAsync(`SELECT status FROM sys_releases WHERE id=?`, [id]);
          // 303-L1（Opus 对抗审）：relNow 空值防御——正常不可达（sys_release_executors.release_id 有
          //   FK ON DELETE CASCADE 指回 sys_releases，行存在则批次必存在），防的是"FK 未启用"或"迁移期
          //   脏数据"这类结构性假设被打破的边界态，不静默产出 TypeError（"Cannot read properties of
          //   undefined"）500，而是给一个能定位问题的 403（这一行事实上已经是"孤儿行"，判它不在册合理）。
          if (!relNow) {
            // C4a（方案 §4.4 登记④）：孤儿行防御触发即 logger.warn——正常路径结构上不可达（FK CASCADE
            //   保证行存在则批次必存在），命中说明 FK 未启用或存在迁移期脏数据，留一条可检索的日志线索，
            //   不止悄悄 403 让运维毫无察觉。
            logger.warn(`[系统迭代] execute(行级确认) 幂等分诊②：批次 ${id} 查无 sys_releases 行（孤儿行防御触发，executor_row_id=${executorRowId}, user_id=${actor.id}），请排查 FK/迁移脏数据`);
            await sysRollback();
            return res.status(403).json({ error: '你已不是本批次执行人，或页面已过期请刷新', code: 'EXECUTOR_NOT_ACTIVE' });
          }
          await sysRollback();   // 本分支纯读，无写入
          return res.json({ my_status: 'done', already: true, pending_count: pendingRow.c, released: relNow.status === '已发布' });
        }
        // preRow.exec_status === 'pending'：此时才过资格闸（303-M1 判序重排，MED-1/302-M1 原意保留，
        //   只是位置再挪了一次）。[决策 7 三修] 原本这里还要过一道人数闸（rosterCount<2 拒），已随执行人
        //   下限 2→1 整体删除——见上方 302-M1/303-M1 判序遗产注释的完整论述。
        // 六校验保留：actor 资格实时复核（事务内自读自判，不接受调用方"已验证"标记）。
        const eligible = await hasReleaseEligibility(actor.id);
        if (!eligible) {
          await sysRollback();
          return res.status(403).json({ error: '当前账号无执行上线资格（非在职，或为查看者/管理员）', code: 'EXECUTOR_NOT_ELIGIBLE' });
        }

        // 行级 CAS（§4.3 定稿逐字，条件不变）
        const cas = await dbRunAsync(
          `UPDATE sys_release_executors SET exec_status='done', executed_at=datetime('now','localtime')
             WHERE id=? AND release_id=? AND user_id=? AND removed_at IS NULL
               AND notify_status='sent' AND exec_status='pending'`,
          [executorRowId, id, actor.id]
        );
        if (!cas || cas.changes !== 1) {
          // 防御性兜底诊断：同一写事务内，preRow 读到 pending 之后按 sysTxnMutex 序列化保证不会再被
          // 别的请求改写，实际唯一可能触发本分支的原因是 preRow.notify_status !== 'sent'（幂等三分诊③）
          // ——not-found/done 两支在本次改造后已是结构性不可达的纵深防御（保留是为了不依赖"永远不会
          // 再被绕过"这个隐性假设，而不是静默产出 500）。
          const row = await dbGetAsync(
            `SELECT id, notify_status, exec_status FROM sys_release_executors
               WHERE id=? AND release_id=? AND user_id=? AND removed_at IS NULL`,
            [executorRowId, id, actor.id]
          );
          if (!row) {
            await sysRollback();
            return res.status(403).json({ error: '你已不是本批次执行人，或页面已过期请刷新', code: 'EXECUTOR_NOT_ACTIVE' });
          }
          if (row.exec_status === 'done') {
            const pendingRow = await dbGetAsync(
              `SELECT COUNT(*) AS c FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL AND exec_status='pending'`,
              [id]
            );
            const relNow2 = await dbGetAsync(`SELECT status FROM sys_releases WHERE id=?`, [id]);   // 302-L1 同款当场重算
            // 303-L1 同款空值防御（见上方 preRow-done 分支完整论述）。C4a（登记④）同款 logger.warn。
            if (!relNow2) {
              logger.warn(`[系统迭代] execute(行级确认) CAS 失败后回查分诊②：批次 ${id} 查无 sys_releases 行（孤儿行防御触发，executor_row_id=${executorRowId}, user_id=${actor.id}），请排查 FK/迁移脏数据`);
              await sysRollback();
              return res.status(403).json({ error: '你已不是本批次执行人，或页面已过期请刷新', code: 'EXECUTOR_NOT_ACTIVE' });
            }
            await sysRollback();   // 本分支纯读，无写入
            return res.json({ my_status: 'done', already: true, pending_count: pendingRow.c, released: relNow2.status === '已发布' });
          }
          // row.notify_status !== 'sent'
          await sysRollback();
          // LOW-3（Opus 预筛）：文案带回通知态原值，方便前端/自查者一眼区分 not_sent（还没点发送）与
          //   failed（发过但失败，M-b 场景另一半——见 [8j] 组用例）两种不同的"尚未收到通知"成因。
          return res.status(409).json({ error: `尚未收到通知（当前状态：${row.notify_status}），无法执行上线`, code: 'NOTIFY_NOT_SENT' });
        }

        // CAS 成功——同事务内 R-GATE 判定（照搬 W-GATE：在册人数≥1 ∧ 无 pending，决策 7 三修下限 2→1）
        // L5（写实对称登记）：`execRows.length >= 1` 这条判据在这个具体调用点上同样是 post-CAS 恒真——
        //   与中心守卫 `execRows.length < 1`（:8288 一带）那处"结构性死代码"发现是同一类结构性防御：
        //   CAS 刚成功证明了 actor 自己那一行（`removed_at IS NULL`）确实存在，本查询又是同一事务内紧接
        //   着重新读取，那一行必然还在，`execRows.length` 不可能为 0。保留该判据不是因为它此刻会为假，
        //   是防御性写法（不依赖"调用者一定先过了 CAS"这个假设去裸写 `pendingCount === 0`）——与中心
        //   守卫处的登记同一处置：写实记录，不删代码。
        const execRows = await dbAllAsync(
          `SELECT user_id, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`,
          [id]
        );
        const pendingCount = execRows.filter(r => r.exec_status === 'pending').length;
        const rGateSatisfied = execRows.length >= 1 && pendingCount === 0;

        if (rGateSatisfied) {
          // M4：release_note 非空仅在此刻由 _publishReleaseCoreInTxn 内部闸门③校验；抛错（如说明为空）
          //   会导致本次事务整体回滚，上面刚 CAS 成功的 done 也一并撤销，不留半截态。
          const pubResult = await _publishReleaseCoreInTxn(
            id, actor, { release_note: releaseNote || undefined, version_tag: versionTag || undefined },
            'execute-release', 'execute'
          );
          await sysCommit();
          outcome = { kind: 'published', result: pubResult };
        } else {
          // 未满足：只落自己那行（CAS 已完成）+ timeline，批次仍「计划中」。
          const userRow = await dbGetAsync('SELECT display_name, username FROM users WHERE id = ?', [actor.id]);
          const userName = resolveExecutorDisplayName(userRow, actor.id);
          const members = await dbAllAsync('SELECT id FROM sys_issues WHERE release_id = ?', [id]);
          // LOW-1 轻量版（Opus 预筛，决策 7 三修同步更正引用）：零成员是异常态（正常不可达——本次 CAS
          //   刚成功即证明"执行人"非空（preRow 命中的这一行本身就是在册执行人），但不保证"批次成员单"
          //   非空（两者是不同的表，"执行人非空"不蕴含"成员单非空"）；CAS 已经成功，确认者本人的操作
          //   完全合规，不该因为这条与他无关的附带留痕失败而被拒绝）——对齐 C2 `writeExecutorNotifyTimelineSafe` 同款"零成员=留痕失败但
          //   不拒绝主流程"语义（同款三行：不写、warn log、响应标注失败），不引入嵌套事务（本分支已在
          //   外层 sysBeginImmediate 事务内，不能再调用会自己 begin/commit 的 writeExecutorNotifyTimelineSafe
          //   ——sysTxnMutex 非重入，嵌套会死锁）。
          let timelineFailed = false;
          if (members.length === 0) {
            logger.warn(`[系统迭代] execute(行级确认) timeline 留痕：批次 ${id} 零成员，无法挂 timeline`);
            timelineFailed = true;
          } else {
            for (const m of members) {
              await dbRunAsync(
                `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
                 VALUES (?, 'scope_change', ?, 'release_executor_done', ?, ?, ?)`,
                [m.id, `执行人${userName}确认完成（还差${pendingCount}人）`, id, actor.id, actor.name]
              );
            }
          }
          await sysCommit();
          outcome = { kind: 'pending', pendingCount, timelineFailed };
        }
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }

      if (outcome.kind === 'published') {
        const result = outcome.result;
        // ⚠️ 响应形状变更（C3）：`released` 统一为布尔（是否因本次确认触发发布），不再是旧版本那样的
        //   已发布 issue_id 数组——数组挪到新键 `released_issue_ids`，避免同一键名在"未满足"分支（布尔
        //   false）与"已发布"分支（数组）之间语义分裂。旧调用方若还读裸 `released` 当数组用会需要同步
        //   改造前端（详见完成报告）。
        res.json({
          id, status: '已上线', released: true, released_issue_ids: result.releasedIssueIds, count: result.count,
          my_status: 'done', pending_count: 0,
        });
        // 发布成功后通知需求方——沿用 /publish 端点既有派发范式（照搬：先响应后台 best-effort 派发，dispatch
        //   内 isAutoNotifyEnabled 现恒 false 故实际不发，但架构与 /publish 一致，若未来手动化策略调整两路同步生效）。
        const releaseActorId = actor.id;
        (async () => { for (const iid of result.releasedIssueIds) await dispatchSysNotify(iid, 'notifyReleasedToRequester', releaseActorId); })().catch(() => { /* 兜底防 unhandledRejection */ });
      } else {
        // LOW-1 轻量版：timeline_failed 恒出现在响应里（布尔，非 truthy 才带），对齐 C2 行级通知端点
        // concurrent_changed 分支同款"稳定枚举字段"写法（300-L2），不是只在失败时才出现的可选字段。
        res.json({ my_status: 'done', pending_count: outcome.pendingCount, released: false, timeline_failed: !!outcome.timelineFailed });
      }
    } catch (err) {
      // C3 实测发现（HIGH 回归②③ 改造用例首次真实经由 /execute 走通 roster 门违例路径）：assertMainStatusTransition
      //   抛的是 MainStatusGuardError（status-transition-guard.js 独立模块，不 instanceof SysTransitionError，
      //   防循环依赖不 require index.js）——旧写法 `if (err instanceof SysTransitionError) ...` 会漏判这个类，
      //   落到下面的通用 500，把本该是 400 GATE_INVARIANT 的响应错报成 500。sendSysTransitionError 内部本就
      //   duck-type 兼容两种类型（.httpStatus/.code 结构），直接无条件调用即可，不必在外层重复做类型分支
      //   （同 hotfix-publish catch 块既有写法）。
      sendSysTransitionError(res, err);
    }
  });

  // ── C3 重写（方案 §6.7）+ C2b 改造（方案 v1.7 §4.4 改造 2b/10）：POST /sys-issues/:id/hotfix-publish：
  //   应急一键——甲方一键完成「建上线单+加单+安排上线」，**发布仍由值班开发执行**（R-3，本端点不再直接
  //   翻已上线）。──────────
  //   ⭐ C2b（方案 §4.4 改造 2b）：**去自动定人**——本端点内部不再复用批次级 preemptReleaseNotifySend
  //   查排班自动定执行人（L1 订正：该函数本身已随 C4b H1 退场整体删除，这里是历史设计记录——彼时决定不
  //   复用它，与它后来是否还存在无关）。改为前端先弹同款选人框（同 PUT executors 复用组件，§4.5）→ 端点收
  //   `executors[]`（user_id 数组）→「建单+加单+写执行人子表」单事务原子提交，子表行全 not_sent/pending
  //   （added_by=actor）。**通知不在本端点内发**——admin 建完批次后到详情页用 C2 行级端点
  //   `POST /sys-releases/:id/executors/:userId/notify` 逐人点发送。
  //   **两阶段语义随之简化**（原字面"①建单+抢占 ②外呼"；C2b 后阶段②整体移出本端点，不再是"外部通知
  //   失败不回滚"这种半原子语义，本端点现在**要么整体成功要么整体回滚**，没有第二阶段可失败）：
  //     ①原子建单（类型/状态校验 + 执行人集合闸门 + 建批次 + 绑单 + 写执行人子表，同一 BEGIN IMMEDIATE）
  //     ②[已移出] 通知——不再是本端点职责，事后由 admin 逐人调用行级通知端点
  //   闸门（人数≥1/资格，决策 7 三修）同事务内过，与 PUT executors 闸②③同码同函数（EXECUTORS_TOO_FEW /
  //   EXECUTOR_NOT_ELIGIBLE / hasReleaseEligibility）。批次态闸⓿（status='计划中'）与生命周期闸①（全部
  //   在册行 not_sent/pending）对**全新批次**天然满足，不必显式再查一次——⭐ LOW-4（Opus 预筛）论据订正：
  //   本端点写执行人子表前，批次刚被自己在同一未提交事务内 INSERT（status='计划中'恒真，写的就是这个
  //   值），真正撑住这两道闸的是 **AUTOINCREMENT 生成的这个新 id 此刻没有第二方能引用它**（要查询/写入
  //   某个 release_id 的前提是先知道这个 id，而它是本次调用刚生成、尚未返回给任何调用方的局部变量，
  //   不存在"另一个请求碰巧也在操作同一个 id"这种竞争可能）+ **执行人子表对这个全新 id 必然是空集**
  //   （我们自己都还没 INSERT 过一行）——"全部在册行都满足 X"这个全称命题在空集上恒真，不依赖"谁看得见
  //   谁看不见未提交数据"这类连接可见性假设（单连接场景下同连接本就能看见自己的未提交写入，原表述不
  //   成立）。显式补查这两道闸只是验证一个数学上不可能为假的条件，纯粹死代码，故不写。
  //   **全类型统一**：RELEASABLE_TYPES（bug/feature/improvement）一视同仁，不再对 bug 特殊拒绝——上线体
  //   统一重构 C3 的核心目标（旧 bug 专属 execute-release 通道本次一并 409 退场，见其路由处）。
  router.post('/sys-issues/:id/hotfix-publish', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const issueId = parsePositiveId(req.params.id);
    if (!issueId) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const b = req.body || {};
    const releaseNote = (typeof b.release_note === 'string' ? b.release_note.trim() : '');
    const versionTag = (typeof b.version_tag === 'string' ? b.version_tag.trim() : '');
    if (!releaseNote) return res.status(400).json({ error: '请填写上线说明', code: 'RELEASE_NOTE_REQUIRED' });
    if (releaseNote.length > SYS_RELEASE_NOTE_MAX) return res.status(400).json({ error: `上线说明超长（≤${SYS_RELEASE_NOTE_MAX} 字）`, code: 'RELEASE_NOTE_TOO_LONG' });
    if (versionTag.length > SYS_VERSION_TAG_MAX) return res.status(400).json({ error: `版本号超长（≤${SYS_VERSION_TAG_MAX} 字）`, code: 'VERSION_TAG_TOO_LONG' });
    // C2b 输入面校验（早于任何 DB 访问，纯请求形状检查，同 PUT executors 既有范式+同错误码）：executors
    // 必须是正整数数组，去重。⚠️「重复调用」分支不消费本字段（只读现状不建新批次），但前端选人弹窗两处
    // 复用（§4.5），恒会带上——形状校验统一在最前面做，不因分支不同而放宽。
    // ⭐ LOW-3（Opus 预筛）登记接受：本数组无显式元素数上限。有界性靠三层兜底而非硬 cap——① 下方 `Set`
    // 去重先天收窄规模；② 资格闸逐个 `hasReleaseEligibility` 首个不合格即整体 400 短路，不会为一个超大
    // 数组把全部资格查询跑完；③ Express `express.json()` 本身有 body 体积上限兜底极端超大请求体。决策 7
    // （三修）明确"至少 1 人"下限、未提业务上限，不额外加硬 cap（同批 PUT executors 端点亦未设上限，两
    // 端点口径一致）。
    if (!Array.isArray(b.executors)) {
      return res.status(400).json({ error: 'executors 必须是数组', code: 'INVALID_USER_IDS' });
    }
    const rawExecIds = b.executors.map(parseStrictPositiveUserId);
    if (rawExecIds.some(n => n === null)) {
      return res.status(400).json({ error: 'executors 元素须为正整数（number 或纯数字字符串）', code: 'INVALID_USER_IDS' });
    }
    const executorIds = [...new Set(rawExecIds)];
    try {
      const actor = sysActor(req);

      // ① 建单+加单+闸门校验+写执行人子表（同一事务）。phase1=null 表示已在事务内提前 return 响应。
      let phase1 = null;
      await sysBeginImmediate();
      try {
        const issue = await dbGetAsync('SELECT id, status, release_id, type FROM sys_issues WHERE id = ?', [issueId]);
        if (!issue) { await sysRollback(); return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' }); }

        if (issue.release_id !== null) {
          // ── 重复调用（7 态响应表·§6.7）：该单已挂某上线单，按其现状分支 ──
          // L8（Opus 预筛）：SELECT 不再取 release_assignee_notify_status——旧列停写后本分支已完全不读
          // rel.ns（notify_status/idempotent/hint 全改子表聚合，见下），继续查它是死读，删除。
          const rel = await dbGetAsync(
            `SELECT id, status, release_kind, release_no FROM sys_releases WHERE id = ?`,
            [issue.release_id]
          );
          if (!rel || rel.release_kind !== 'emergency') {
            await sysRollback();
            return res.status(409).json({ error: `该任务已在上线单 #${issue.release_id} 中，请勿混用应急口`, code: 'ISSUE_IN_NON_EMERGENCY_RELEASE' });
          }
          if (rel.status === '已发布') {
            await sysRollback();
            return res.status(409).json({ error: '该任务已上线，不可再建应急单', code: 'ISSUE_ALREADY_RELEASED' });
          }
          // 改造 10（Opus 预筛/codex 254 H6）：release_assignee_id/name 旧列停写后恒 NULL——改读子表在册
          // 行聚合，同 PUT executors 响应形状（executors 数组，每行自带各自 notify_status）。
          // ⭐ C4a（方案 §4.4 登记①）：notify_status/idempotent/hint 判定改子表聚合语义——原按批次级旧列
          // rel.ns 判定"协调方裁定"至此收口。hint 不再指"安排上线"旧入口（该入口已随 C2b 群发语义退场），
          // 按子表在册行通知态聚合给写实提示：有任意行 sent/sending → idempotent:true（视为已在处理中，
          // 不重建新批次）；全体 not_sent/failed/stale（无 sent/sending）→ 提示到批次详情逐人发通知（新
          // UI 范式下没有"重新发送"这个单点动作了）；⭐ Opus 预筛 MED-2：`none`（子表在册 0 行，理论仅
          // 极端并发窗口——首次调用写子表与本分支查询之间不该出现，但仍需给出可执行提示而非空泛文案）
          // 单独给出"请先重新选择执行人"文案，与"有人但都没收到通知"的提示区分开。
          // ⭐ LOW-1（Opus 预筛）同快照：execRows 查询移到 sysRollback() 之前——与上面 rel 同一未提交事务内
          // 读出，保证两者是同一时刻的快照（若先 rollback 再读 execRows，两次读之间理论上可能被另一并发
          // 请求插入写操作，rel 与 execRows 就不再是同一时刻的一致视图，即便本分支自身纯读无写）。
          const execRows = await dbAllAsync(
            `SELECT id, user_id, user_name, notify_status, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`,
            [issue.release_id]
          );
          await sysRollback();   // 本分支纯读，无写入——紧邻返回前，晚于上面两次读取
          const hasSentOrSending = execRows.some(r => r.notify_status === 'sending' || r.notify_status === 'sent');
          const notifySummary = deriveExecutorNotifySummary(execRows);
          const common = {
            issue_id: issueId, release_id: rel.id, release_no: rel.release_no,
            notify_status: notifySummary, created_new: false, notification_attempted: false,
            executors: execRows,
          };
          if (hasSentOrSending) return res.json({ ...common, idempotent: true });
          const hint = notifySummary === 'none' ? '该应急批次当前无在册执行人，请先重新选择执行人' : '请到批次详情逐人发通知';
          return res.json({ ...common, hint });
        }

        // ── 首次调用：校验 + 执行人闸门 + 建 release_kind='emergency' 批次 + 抢占绑单 + 写执行人子表 ──
        if (!RELEASABLE_TYPES.includes(issue.type)) {
          await sysRollback();
          return res.status(409).json(issue.type === 'config'
            ? { error: '配置类不进上线批次', code: 'CONFIG_NO_RELEASE' }
            : { error: `该类型暂不可进上线批次（当前仅 ${RELEASABLE_TYPES.join('/')}）`, code: 'TYPE_NOT_RELEASABLE' });
        }
        if (issue.status !== '待上线') {
          await sysRollback();
          return res.status(409).json({ error: '该单非「待上线」，不能 hotfix', code: 'ISSUE_NOT_HOTFIXABLE' });
        }

        // C2b：② 人数闸（决策 7 三修：下限 2→1）+ ③ 资格闸（同 PUT executors 闸②③同码同函数）——
        //   提到建批次之前，快速失败，不占用批次号；类型/状态校验后立即做，是本端点"决定要不要真的
        //   动手建资源"的最后关口。
        if (executorIds.length < 1) {
          await sysRollback();
          return res.status(400).json({ error: '至少选择 1 名执行人', code: 'EXECUTORS_TOO_FEW' });
        }
        const resolvedExecutors = [];
        for (const uid of executorIds) {
          const eligible = await hasReleaseEligibility(uid);
          if (!eligible) {
            await sysRollback();
            return res.status(400).json({ error: `用户 ID=${uid} 不具备上线执行资格`, code: 'EXECUTOR_NOT_ELIGIBLE' });
          }
          // 301-M2：SELECT 补 username（resolveExecutorDisplayName 的中间兜底级需要它）。
          const u = await dbGetAsync('SELECT display_name, username FROM users WHERE id = ?', [uid]);
          resolvedExecutors.push({ id: uid, name: resolveExecutorDisplayName(u, uid) });
        }

        const releaseNo = await nextReleaseNo();
        const relIns = await dbRunAsync(
          `INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_note, version_tag,
                                      created_by, created_by_name, release_type, release_kind, planned_date)
           VALUES (?, ?, '计划中', 1, ?, ?, ?, ?, ?, 'emergency', date('now','localtime'))`,
          // release_kind='emergency' 供 emergency_display 口径识别（§6.12）；planned_date=当日（C2b 后
          //   不再驱动排班查询，仅作展示/统计口径沿用，不动这一列的写入）。
          [releaseNo, `hotfix #${issueId}`, releaseNote, versionTag || null, actor.id, actor.name, releaseFamilyOf(issue.type)]
        );
        const releaseId = relIns.lastID;

        // 并发首次调用抢占（§6.7）：WHERE release_id IS NULL 条件更新——败方 changes=0。
        const bind = await dbRunAsync(
          "UPDATE sys_issues SET release_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = '待上线' AND release_id IS NULL",
          [releaseId, issueId]
        );
        if (!bind || bind.changes !== 1) {
          // 败方：回滚本次新建的批次（含刚才的 INSERT），改读赢家现状返回（与"重复调用"分支同一响应形状）。
          await sysRollback();
          const loser = await dbGetAsync('SELECT release_id FROM sys_issues WHERE id = ?', [issueId]);
          if (loser && loser.release_id) {
            // L8（Opus 预筛）：SELECT 同上分支删掉死读 release_assignee_notify_status——本分支同样已完全
            // 改子表聚合判定，不再读 rel.ns。
            const winnerRel = await dbGetAsync(
              `SELECT id, status, release_kind, release_no FROM sys_releases WHERE id = ?`,
              [loser.release_id]
            );
            if (winnerRel && winnerRel.release_kind === 'emergency' && winnerRel.status !== '已发布') {
              // 改造 10 同款修法：与"重复调用"分支同一处理，避免同一处 bug 只补一半（两分支是同一响应
              // 形状的复制体，本次一并修，见上方"重复调用"分支注释的同款说明）。C4a（登记①）同款子表
              // 聚合语义，两分支必须同步改，不能只改一半留下"同一 bug 只补一半"的新版本。
              const winnerExecRows = await dbAllAsync(
                `SELECT id, user_id, user_name, notify_status, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`,
                [winnerRel.id]
              );
              const winnerHasSentOrSending = winnerExecRows.some(r => r.notify_status === 'sending' || r.notify_status === 'sent');
              const winnerNotifySummary = deriveExecutorNotifySummary(winnerExecRows);
              const common = {
                issue_id: issueId, release_id: winnerRel.id, release_no: winnerRel.release_no,
                notify_status: winnerNotifySummary, created_new: false, notification_attempted: false,
                executors: winnerExecRows,
              };
              if (winnerHasSentOrSending) return res.json({ ...common, idempotent: true });
              const winnerHint = winnerNotifySummary === 'none' ? '该应急批次当前无在册执行人，请先重新选择执行人' : '请到批次详情逐人发通知';
              return res.json({ ...common, hint: winnerHint });
            }
          }
          return res.status(409).json({ error: '该单状态已变更，请刷新重试', code: 'ISSUE_NOT_HOTFIXABLE' });
        }

        // 加单成功——写执行人子表（C2b：不再抢占发送权，只落执行人在册行，not_sent/pending 走 DDL 默认值）。
        // 批次态闸⓿/生命周期闸①对全新批次天然满足（见路由头部注释），不重复显式校验。
        for (const r of resolvedExecutors) {
          const ins = await dbRunAsync(
            `INSERT INTO sys_release_executors (release_id, user_id, user_name, added_by, added_by_name) VALUES (?, ?, ?, ?, ?)`,
            // 310-M1：同 PUT executors 处兜底口径（added_by_name 防纯空白 actor.name 撞 CHECK 500）。
            [releaseId, r.id, r.name, actor.id, resolveExecutorDisplayName({ display_name: actor.name }, actor.id)]
          );
          if (!ins || !ins.lastID) throw new Error(`执行人 user_id=${r.id} 插入异常`);
        }

        // C4a（方案 §4.4 登记②）：hotfix timeline 留痕补录——首次调用分支此前建单+写执行人子表后无任何
        //   timeline 记录，与常规「安排上线」路径（PUT executors 落「设置上线执行人：...」timeline，见其
        //   路由头部注释）不对称。补两条，照 PUT executors §6.13 范式挂成员单（ref_id=releaseId 关联）：
        //   「应急建单」+「执行人指派」——本单是应急路径的唯一成员，故只挂它自己一条记录，非遍历 members。
        const execNames = resolvedExecutors.map(r => r.name).join('、');
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
           VALUES (?, 'scope_change', ?, 'release_hotfix_create', ?, ?, ?)`,
          [issueId, `应急建单 ${releaseNo}`, releaseId, actor.id, actor.name]
        );
        await dbRunAsync(
          `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, ref_id, operator_id, operator_name)
           VALUES (?, 'scope_change', ?, 'release_executors_set', ?, ?, ?)`,
          [issueId, `设置上线执行人：${execNames}`, releaseId, actor.id, actor.name]
        );

        await sysCommit();
        phase1 = { releaseId, releaseNo };
      } catch (txErr) {
        try { await sysRollback(); } catch (_) { /* ignore */ }
        throw txErr;
      }
      if (!phase1) return;   // 上面"重复调用"/"并发败方"/闸门拒绝分支已提前 return 响应

      const { releaseId, releaseNo } = phase1;

      // C2b：本端点到此结束——通知整体移出本端点（原"②事务外通知"阶段不再存在）。响应不含任何"已通知"
      // 暗示（不返回 notify_status/notification_attempted/notify_error），只如实展示刚落库的执行人子表，
      // admin 需到批次详情页逐人点「发通知」（行级端点）。
      const finalRows = await dbAllAsync(
        `SELECT id, user_id, user_name, notify_status, exec_status FROM sys_release_executors WHERE release_id = ? AND removed_at IS NULL ORDER BY id`,
        [releaseId]
      );
      res.json({
        issue_id: issueId, release_id: releaseId, release_no: releaseNo, created_new: true,
        executors: finalRows,
      });
    } catch (err) {
      // A（codex M-1）：hotfix 自动号极端竞态撞 UNIQUE 时转 409（不退化为 500 + 原始 SQLite 错误外泄）。
      // ⭐ LOW-2（Opus 预筛）收窄：精确匹配 `sys_releases.release_no`（DDL: `release_no TEXT NOT NULL
      // UNIQUE`，SQLite 报错格式恒为 "UNIQUE constraint failed: sys_releases.release_no"）——C2b 新增
      // 的执行人子表写入也可能撞 UNIQUE（`idx_sys_release_exec_active` 部分唯一索引，理论不可达但非
      // 结构上不可能），原先宽泛的 /UNIQUE/i 会把这类完全无关的失败也误映射成"批次号冲突，请重试"这个
      // 文不对题的提示；收窄后只有真正的批次号碰撞才走这条 409，其余 UNIQUE 失败原样透出给
      // sendSysTransitionError（500 + 真实错误信息，不再被误导性文案掩盖）。
      if (err && /UNIQUE constraint failed: sys_releases\.release_no/.test(err.message || '')) {
        return res.status(409).json({ error: '批次号生成冲突，请重试', code: 'RELEASE_NO_GENERATE_CONFLICT' });
      }
      sendSysTransitionError(res, err);
    }
  });

  // ============================================================
  // 三·四·五、[已退场] 旧上线编排（原通知改造 C3b §2.3 G3-G6：批量指定/换人/通知上线开发 + execute-release）
  //   [2026-07-30 用户裁定·上线体统一重构收尾] 旧家族 4 端点全部封禁（assign-release-dev /
  //   reassign-release-dev / notify-release-executor / notify-release-executor-batch）——上线体 C0-C9 后，
  //   执行人唯一权威源 = sys_releases 级（排班表经 notify-executor 两段 CAS 写入），issue 级
  //   release_assignee_* 8 列业务写路径自此全封、转只读残留（唯一残留写点=notify-read-status 已读固化
  //   release_assignee_read_at，仅历史 sent 数据可达·codex 208 审 HIGH-1 精确口径；列不 DROP，37 列表重建硬约束见 schema 注释）。
  //   ⚠️ L1（Opus 预筛，C4b 追加订正）：以上是 2026-07-30 那一轮改造的原话，权威源声称已过时——C4b（H1
  //   根治）又把"sys_releases 级 + notify-executor 两段 CAS"这条批次级机制本身整体退场删除了，当前真正
  //   唯一权威源已再前移一级，是 sys_release_executors 子表（行级，PUT executors 建行 + 行级
  //   preemptReleaseExecutorNotifySend/sendReleaseExecutorNotifyAndWriteback 两段 CAS 写通知态）。本段之下
  //   描述的"issue 级 release_assignee_* 8 列全封"结论不受影响仍然成立（那 8 列本就早于本轮退场即已封死），
  //   变的只是"谁是当前权威源"这句话本身——保留原句不改是为了如实留存决策时间线，读者请以本条订正为准。
  //   拒绝范式照抄本模块退场先例（下方 execute-release 同 code；change-intake-mode 同结构）：
  //   409 + 专属 code，置于一切参数校验之前（端点级结论与入参无关）；requireAdmin 一并摘除（对任何角色
  //   都是同一个"已下线"，留 403 会误导"换个身份就能用"）；实现体删除不留不可达代码（照 change-intake-mode
  //   C0 审 MED-1 先例，回滚以整个 commit 为单位）。
  //   meta（transitions.js）中 assign-release-dev 条目照 execute-release 退场先例**保留**（前端通用循环已
  //   抑制渲染，动 meta 会连带状态机断言面，收益为零）。
  // ============================================================

  // ── [已退场] POST /sys-issues/assign-release-dev：批量指定上线开发（原 G3）──────────
  router.post('/sys-issues/assign-release-dev', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.status(409).json({
      error: '该端点已下线：上线执行人现由管理员在「安排上线」选人弹窗指定（排班仅作默认候选来源），批次详情逐人发送通知',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
  });

  // ── [已退场] POST /sys-issues/reassign-release-dev：批量换执行人（原 G4 + Path A 单条换人）──────────
  router.post('/sys-issues/reassign-release-dev', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.status(409).json({
      error: '该端点已下线：换执行人请由对接人「撤销上线安排」（cancel-schedule）后重新「安排上线」',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
  });

  // ── C3 退场（方案 §6.7/§6.10/§6.14/附录A）：POST /sys-issues/execute-release 全类型 409 ──────────
  //   旧 bug 专属"上线编排"G5(hotfix)/G6(publish) 两模式随"全类型统一"一并退场——bug 现与 feature/
  //   improvement 同走 hotfix-publish（应急）或排班+安排上线+执行上线（常规）两条统一路径。
  //   [2026-07-30 用户裁定] 同族 assign-release-dev/reassign-release-dev（及通知两端点）此前"隐藏前端
  //   入口、保留端点"的过渡态已终结——4 端点全部封禁（见上方退场段），与本端点同 code 同范式。
  router.post('/sys-issues/execute-release', authenticateToken, requireSysSchemaReady, async (req, res) => {
    res.status(409).json({
      error: '该端点已下线：bug 上线流程现与其他类型统一，请改用「应急一键」(hotfix-publish) 或「安排上线」+「执行上线」(execute)',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
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

  // [D22 批2收口·codex 290 号裁定=改·291 号 M-4 补齐] 状态显示名——纯展示映射，与前端
  //   Sys_Iteration.html 的 siStatusDisplay **逐项同表**（"待验证"→"待验收"、"已关闭"→"已归档"，其余
  //   原样；291 号 M-4 前本函数漏了"已关闭→已归档"这一项，与前端不同表，已补齐并加下方对照断言锁定
  //   "逐项同表"这条不变量，非仅覆盖"待验证"一个值）；**只用于外发文案渲染**，绝不写回 DB/绝不作为
  //   查询条件/绝不影响 status 列本身——存储值/状态机/API 响应体 issue.status 字面量恒不变，仅本函数
  //   的返回值可能与 issue.status 不同。钉钉通知也是用户可见显示面，状态名理应与页面一致，否则页面
  //   看到"待验收"/"已归档"、钉钉消息却收到"待验证"/"已关闭"，对业务方/建单人是两套口径的割裂体验。
  function sysStatusDisplayName(status) {
    if (status === '待验证') return '待验收';
    if (status === '已关闭') return '已归档';
    return status;
  }

  // 深链行（baseUrl 已 sanitize；为空则省略，对齐 issue-tracker buildIssueDeepLink 范式）。
  //   URL 约定：Sys_Iteration.html?issue=<id>（C6 前端须按此 query 参数定位详情，整数 id 无注入面）。
  function sysDeepLinkLine(baseUrl, issueId) {
    if (!baseUrl) return '';
    return `\n\n[查看详情](${baseUrl}/Sys_Iteration.html?issue=${issueId})`;
  }

  // 批次深链（C2b 第2批·Playwright 冒烟实测发现的第三个真实缺口）：值班执行人此前拿到的通知只有裸
  //   baseUrl（buildReleaseBatchExecutorMarkdown 原式），落地页面没有任何入口能让非 admin/非对接人的
  //   普通执行人找到自己被指派的那一条批次——「批次管理」入口仍锁 admin∨对接人（避免向普通执行人暴露
  //   全部批次列表），执行人唯一合法路径就是这条深链。镜像 sysDeepLinkLine 写法，query 参数用
  //   `?release=<id>`（前端 Sys_Iteration.html 已接线，见该文件 DOMContentLoaded 深链段）。
  function sysReleaseDeepLinkLine(baseUrl, releaseId) {
    if (!baseUrl) return '';
    return `\n\n[前往安排上线面板](${baseUrl}/Sys_Iteration.html?release=${releaseId})`;
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
        md: `### 📣 问题处理进展\n\n- **系统**：${system}\n- **问题**：${title}\n- **当前状态**：${issueNotify.issueSafeText(sysStatusDisplayName(issue.status), 20)}\n\n信息技术部正在跟进处理，感谢您的反馈。${link}`,
      };
    }
    // estimate
    return {
      title: `⏱ 预计完成时间已更新：${safeTitle}`,
      //   S3（D3）：读 DB 原值会带秒（补秒后），但**发给业务方的钉钉消息也是"给人看的文本"**，同样到分。
      //     这是写读同源的必查点——写端补了秒，所有读端（页面、留痕、外发消息）都得跟着看一遍。
      md: `### ⏱ 开发已回填预计完成时间\n\n- **系统**：${system}\n- **需求**：${title}\n- **预计完成**：${truncToMinute(issue.dev_estimated_at) || '—'}\n\n开发已着手处理，预计完成时间如上。${link}`,
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
    const statusLine = issueNotify.issueSafeText(sysStatusDisplayName(issue.status), 20);   // [D22 批2] 显示映射，issue.status 本身不变
    return {
      title: `📬 迭代单状态更新：${safeTitle}`,
      md: `### 📬 迭代单状态更新\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n- **当前状态**：${statusLine}\n\n请登录平台查看详情。${link}`,
    };
  }

  // 对接人受理侧 markdown（建单优化批 C1 §4 改动点2/6）：仅带单号+标题+深链，**不内联 description/
  //   priority 等可编辑字段**——通知后内容可变已成常态（第十人自查·214 风险备注同族），文案不内联
  //   可变字段则通知永不失真。渠道截断以落库 title 为输入（issueSafeText/sysNotifyTitle 本身只
  //   slice 不追加省略号，即便 title 已含派生截断的"…"也不会叠成"……"）。
  function buildSysIntakeMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `📥 新迭代单待受理：${safeTitle}`,
      md: `### 📥 新迭代单待受理\n\n- **单号**：#${issue.id}\n- **标题**：${title}\n\n请登录平台受理该单。${link}`,
    };
  }

  // 对接测试侧 markdown（工期对接测试与风险等级拆分 方案 v1.1 §6·C4b）：开发点击"通知对接人测试"，
  //   收件人=liaison_test_recipient_*（D20 claim 自愈后的当前值）。同 buildSysIntakeMarkdown 口径，
  //   仅带单号+标题+深链，不内联可变字段。
  function buildSysLiaisonTestMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `🧪 迭代单待对接测试：${safeTitle}`,
      md: `### 🧪 迭代单已进入对接测试\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n开发已完成交付，请登录平台对接测试该单。${link}`,
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

  // 建单人侧·暂缓通知 markdown（S3·bug暂缓方案 20260803 v0.4 §7.1/§7.3）：开发（活跃在册成员）或 admin
  //   标记暂缓后，手动通知建单人。签名 (issue, reason, baseUrl) 逐字对齐方案任务书；"谁做的"不加第 4 个
  //   参数——由调用端点把本轮 hold timeline 行的 operator_name 合并进 issue 对象的 `hold_by_name` 字段
  //   （该行本就是端点为§7.3"本轮锚点"判定读取的同一条，不额外查询）。
  //   ⚠️ 不带成员清单等敏感内容（v1.132.0 风险备注同族）：只带单号/标题/操作人/理由原文/深链，不内联
  //   roster 名单，防未来权限变化后经通知内容侧信道泄露团队信息。
  //   reason 传入的是 timeline.summary——hold 的 summary 就是理由原文本身（无拼接），故此处即"理由原文"。
  function buildSysHoldCreatorMarkdown(issue, reason, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    const reasonText = issueNotify.issueSafeText(reason, 200);
    const who = issueNotify.issueSafeText(issue.hold_by_name || '未知', 40);
    return {
      title: `⏸ 迭代单已暂缓：${safeTitle}`,
      md: `### ⏸ 迭代单已暂缓\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n- **操作人**：${who}\n- **暂缓原因**：${reasonText}\n\n该单已暂缓，观察期内可重启继续处理，或由管理员作废了结。请登录平台查看详情。${link}`,
    };
  }

  // 开发侧·重启通知 markdown（S3·bug暂缓方案 §7.1/§7.3）：admin 重启暂缓单后，手动通知在册开发。
  //   同上，"谁做的"经 issue.resume_by_name 合并传入（来源=§7.3 算法定位到的本轮 resume timeline 行）。
  //   ⚠️ reason 传入的是该 resume timeline 行的 summary——resume 的 summary 是拼接串（"恢复到「X」
  //   （可能带自动降级注记）｜原因：<reason>"，见 index.js case 'resume'），非纯原因文本，故本模板标签用
  //   "重启说明"而非"重启原因"——如实反映内容形态，不假装是纯净原文（hold 侧因 summary=reason 本就纯净，
  //   两侧标签故意不同，非疏漏）。
  function buildSysResumeDevMarkdown(issue, reason, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    const reasonText = issueNotify.issueSafeText(reason, 200);
    const who = issueNotify.issueSafeText(issue.resume_by_name || '未知', 40);
    return {
      title: `▶️ 迭代单已重启：${safeTitle}`,
      md: `### ▶️ 迭代单已重启\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n- **操作人**：${who}\n- **重启说明**：${reasonText}\n\n该单已恢复处理，请登录平台查看详情并继续跟进。${link}`,
    };
  }

  // 技术负责人侧 markdown（受理排期改造 §6·C5·对接人/admin 请技术负责人做技术评估沟通）。
  //   ⭐ codex Round-A 审 MED（采纳）：措辞去掉"（受理沟通）"——该动作经 sysTechConsultGateStatus 判定开放态
  //   （历史沿革：C3 时期曾按 type 分流，变更流「待商议」/bug「待受理」；v2.1 撤销 C2.5 后全类型归一
  //   「待受理」，"受理阶段内的诊断协助"对两类型均成立）；改用中性的"技术评估沟通"，两类型共用同一条
  //   文案不失真。
  function buildSysTechLeadMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `🔧 请协助技术评估：${safeTitle}`,
      md: `### 🔧 请协助技术评估\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n对接人就该单发起了技术负责人沟通，请登录平台查看需求并给出技术评估意见。${link}`,
    };
  }

  // 受理人侧·技术负责人评估已回 markdown（角色权限重构 C3；技术负责人提交最终评估意见后
  //   通知受理人"评估已回"，请其登录平台查看内容并决定后续处置——可做则受理通过（intake_accept）后
  //   由 admin 经 set-oa-number 补 OA 号，不可做则受理人 issue_reject（前置守卫要求当前轮已有评估意见）。
  function buildSysTechLeadCommentReplyMarkdown(issue, baseUrl) {
    const title = issueNotify.issueSafeText(issue.title, 80);
    const safeTitle = sysNotifyTitle(issue.title);
    const system = issueNotify.issueSafeText(issue.system_name, 40);
    const link = sysDeepLinkLine(baseUrl, issue.id);
    return {
      title: `✅ 技术负责人评估已回复：${safeTitle}`,
      md: `### ✅ 技术负责人评估已回复\n\n- **单号**：#${issue.id}\n- **系统**：${system}\n- **标题**：${title}\n\n技术负责人已提交本单最终评估意见，请登录平台查看具体内容并决定后续处置。${link}`,
    };
  }

  // [已退场 2026-07-30·用户裁定] buildSysReleaseExecutorMarkdown / buildSysReleaseExecutorBatchMarkdown
  //   （含 SYS_RELEASE_BATCH_MD_MAX）已随旧上线编排家族封禁整体删除——唯二调用方 notify-release-executor(-batch)
  //   已封 409。批次级执行人通知的 buildReleaseBatchExecutorMarkdown 是独立函数，不受影响。

  // 通知落库写串行化进 sys mutex（ultracode 审 #1，C4.5 同类防线）：通知写跑在主事务提交后、mutex 已释放，
  //   若用裸 autocommit dbRunAsync，会落进另一并发请求已打开的 BEGIN IMMEDIATE 事务里，随其 ROLLBACK 一起丢失
  //   （钉钉已发但库回到 not_sent → 后续误判未发重复推送）。照附件写口径用 sysBeginImmediate/sysCommit 独立小事务串行化。
  //   注：dispatch 调用点均在各端点主事务 sysCommit 之后（mutex 已释放），此处再 acquire 不会自死锁。
  async function sysNotifyWrite(sql, params) {
    await sysBeginImmediate();
    try { await dbRunAsync(sql, params); await sysCommit(); }
    catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
  }
  // 同 sysNotifyWrite，但回传 run 结果（各 record* 落库 helper 需 changes 判围栏命中，如 recordSysTechLeadNotify/recordSysDevAssigneeNotify）。
  async function sysNotifyWriteRun(sql, params) {
    await sysBeginImmediate();
    try { const r = await dbRunAsync(sql, params); await sysCommit(); return r; }
    catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
  }
  // ⭐ 对抗审 F8 收口：**投递历史**与**投递状态**分离。
  //   问题：`*_notify_sent_by` 是**轮次状态列**，四个重置点（换代表 / 换执行人 / 回受理门 / 重发咨询）
  //   都会按不变量 `not_sent ⟹ sent_by 空` 把它清成 NULL —— 这个不变量本身是对的（否则会造出
  //   "没发过却记着谁发的"的矛盾行，Fable 主张"不变量在为信息销毁背书"这半被 GPT 核推翻了）。
  //   但真问题在另一半：**手动通知从不写 timeline**，于是重置一发生，
  //   "上一轮那条钉钉是谁发的"就在全库消失 —— C2b 的审计承诺**只在当前轮次内成立**。
  //   修法：状态列照旧重置，另外补一条**只增不改**的 timeline 留痕（'note' + action_code='notify_sent'）。
  //   为什么用 timeline 而不是新建 sys_notify_log 表：timeline 本就是本模块的 append-only 审计链、
  //   已有 operator_id/operator_name/created_at 三列语义完全对口，且详情页已经在渲染它——
  //   新建表要连带做查询、渲染、readiness、级联与快照（刚被 F1/F7 教育过），成本远大于收益。
  //   ⚠️ 本函数是 **best-effort**：留痕失败不能影响"通知已发出"这个既成事实，也不能回滚业务，
  //   故内部自吞异常只记 warn（与通知落库同为 best-effort 语义）。
  //   ⭐ codex Round-C 审 MED（采纳）：加返回契约——成功 return true，catch 分支 return false（此前恒
  //   返回 undefined，调用方无从区分"留痕真的写进去了"还是"发生了什么但被吞掉了"）。既有调用点（notify-developer
  //   等一批既有端点）此前全部忽略返回值，加这个契约对它们零影响；C3 的两个新通知段（tech-lead-comment /
  //   resend-notify）借此判断"发送成功但留痕失败"这类此前无法区分的边界情形（见两处调用点注释）。
  async function recordSysNotifyTimeline(issueId, channel, recipientDesc, ok, messageKeyOrErr, actor) {
    try {
      //   ⚠️ 收口审 MED-security：留痕长期保存，而 messageKey/错误串可能夹带 token 片段、手机号、
      //   HTTP 响应体。统一走 sanitizeAuditText（去控制字符 + 掩手机号 + 长 hash 串替换 + 截断）。
      const who = recipientDesc ? sanitizeAuditText(recipientDesc, 60) : '(未知收件人)';
      const tail = ok ? `message_key=${sanitizeAuditText(messageKeyOrErr, 40)}` : `失败=${sanitizeAuditText(messageKeyOrErr || 'other', 40)}`;
      await dbRunAsync(
        `INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
         VALUES (?, 'note', ?, 'notify_sent', ?, ?)`,
        [issueId, `发送${channel}通知 → ${who}：${ok ? '成功' : '失败'}（${tail}）`,
         Number(actor && actor.id) || null, (actor && actor.name) || null]);
      return true;
    } catch (e) {
      logger.warn(`[系统迭代] 通知留痕写入失败 #${issueId} ${channel}: ${(e && e.message) || e}`);
      return false;
    }
  }

  // ⭐ 角色权限重构 C2b（方案 v1.7 §4-C2b）：五通道 sent_by 统一契约守卫 —— **照抄 recordSysTechLeadNotify
  //   的既有范式**（本文件下方 §8.3 段），不是新设计。
  //   语义：sent_by = **本次投递的责任人**。手动通道 = 点发送按钮的人；自动派发通道 = **引发本次通知的
  //   流转操作者**（谁做了 estimate / 发布 / 打回）。两者共用同一条不变量，不分列。
  //   为什么非正整数要**抛错**而不是写 NULL：写 NULL 会静默产出违反 `sent/failed ⟹ sent_by 非空` 的行，
  //   而这类行事后无法与"迁移前的历史行"区分 —— 审计表里混进说不清来源的行，比当场失败糟得多。
  //   调用方均为 best-effort 通知路径（外层已 catch），抛错不会打断业务事务。
  //   ⚠️ 比 tech_lead 原范式**多一格严**：原守卫只判 `sb > 0`，`1.5` 这类非整数能过。sent_by 是 users.id，
  //   小数写进去就是查不回人的脏数据，故这里补 Number.isInteger。下方 recordSysTechLeadNotify 已改为
  //   复用本函数 —— 六通道 + tech_lead 共用**同一个**守卫，不留"两套略不同的校验"这种必然漂移的结构。
  //   ⚠️ 类型面刻意收窄到 number | 十进制整数字符串（codex C2b 审 MED）：
  //   裸 `Number(x)` 会把 `true` 归一成 1、`' 13 '` 归一成 13 —— 前者会把审计归属**错记到 user 1 头上**，
  //   而"错记"比"没记"更糟（查审计的人会得到一个看起来可信的错误答案）。审计字段宁可当场失败。
  function assertNotifySentBy(fnName, sentBy) {
    const okType = typeof sentBy === 'number'
      || (typeof sentBy === 'string' && /^[1-9]\d*$/.test(sentBy));   // 不接受前后空白/前导零/符号
    const sb = okType ? Number(sentBy) : NaN;
    if (!Number.isSafeInteger(sb) || !(sb > 0)) {
      throw new Error(`${fnName}: sent_by 必须为正整数（不变量 sent/failed⟹sent_by 非空）·实际=${typeof sentBy}:${String(sentBy)}`);
    }
    return sb;
  }

  // ⭐ 收口审 MED：**通知回写零命中必须留可 grep 的线索**（对抗审 F6 的真正兜底）。
  //   场景：钉钉**已经真的发出去了**，但回写 UPDATE 命中 0 行 —— 单据在发送的秒级窗口里被删了 /
  //   收件人被改派（CAS 围栏拒写）/ 子表行被软删。此前四个走 `sysNotifyWrite` 的 helper 直接丢弃 changes，
  //   于是"外部消息已送达、库内零痕迹"这种最难查的情况**连一条日志都没有**。
  //   ⚠️ 为什么不能靠 F8 那条 timeline 兜底（我原本的推理有漏洞，收口审指出）：单据已删时，
  //   那条 timeline 要么写不进去、要么变成指向已删单据的**孤儿行**，反而与"删除后六表全清"自相矛盾。
  //   故这里落**应用日志**（不是审计表）——它的定位就是"排时序用的线索"，与 C2a 的权威留证分工不同。
  function warnNotifyWriteMissed(channel, issueId, sentBy, ok, detail, runResult) {
    if (runResult && runResult.changes > 0) return;
    logger.warn(`[系统迭代][通知回写零命中] channel=${channel} issue=#${issueId} sent_by=${sentBy} ` +
      `外部发送=${ok ? '成功' : '失败'}(${sanitizeAuditText(detail, 60)}) —— ` +
      `钉钉可能已实际送达但库内无处落（单据已删 / 收件人已变更 / 成员行已软删），此日志是唯一线索`);
  }

  // ⭐ 角色权限重构 C4·F9（172 号对抗审）：手机号掩码抽成独立 helper——F9 审计查询端点的展示层
  //   脱敏也要用同一条规则，若两处各写一份正则就是漂移温床（改了掩码格式，另一处忘改）。
  //   下方 sanitizeAuditText 改为调用本函数，顺序/结果与原实现逐字一致，零行为变化。
  // ⭐ 角色权限重构 C4·184 号预审（PM-3·脱敏多格式升级）：真实数据里手机号不总是纯 11 位连续数字——
  //   业务方口头/录入习惯常带分隔符（138-1234-5678 / 138 1234 5678），原实现只认连续 11 位数字，这类
  //   分隔格式会被漏判、明文外泄。升级为两条互补规则（由调用方按"这个值是不是一个 phone 语义字段"
  //   传 `opts.keyIsPhone` 选择路径，见下方 walk 的两处调用）：
  //   ① `opts.keyIsPhone===true`（键名含 phone 的整段字符串/数字值，见 maskJsonSnapshotText 的 walk）：
  //      先剥离 `[-\s]` 归一，若归一后恰好是合法 11 位「1[3-9]开头」手机号，判定"这整个值就是一个手机号"，
  //      直接把整值替换成标准掩码形态 `138****5678`。⚠️ **不逐字还原原分隔符格式**（剥离归一后已丢失
  //      "分隔符原来在第几位"这个信息，逆向拼回没有实际收益，反而增加实现复杂度；本路径命中的字段本身
  //      语义就是"一个电话号码"这个原子值，标准形态已经达成脱敏目的，这个简化是 184 收口批的裁定取舍）。
  //      归一后不是合法 11 位格式（脏数据/非手机号内容）→ 不提前 return，落到下面②的自由文本规则，不裸奔。
  //   ② 默认路径（自由文本，未声明 keyIsPhone 或值不是纯手机号）：正则升级为
  //      `1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}`（分隔符可选、允许 - 或空格）+ 前后非数字边界断言——边界断言
  //      是防误伤的关键：OA 号/订单号常是长串连续数字，其中任何"看似手机号"的中间子串前后必然紧邻其他
  //      数字，会被 `(?<!\d)`/`(?!\d)` 正确排除在外（不会被误判成手机号而遭掩码，verify [M] 补了 20 位
  //      纯数字 OA 号负例用例证明这一点）。命中后掩中间 4 位、**保留原分隔符**（"138-1234-5678"→
  //      "138-****-5678"；自由文本要保留原文可读性，只挖掉隐私部分，与①"整值替换"的取舍刻意不同）。
  function maskPhoneDigits(s, opts) {
    const str = String(s == null ? '' : s);
    if (opts && opts.keyIsPhone) {
      const normalized = str.replace(/[-\s]/g, '');
      if (/^1[3-9]\d{9}$/.test(normalized)) {
        return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
      }
      // 归一后不是合法手机号格式——不裸奔，落到下面的自由文本规则继续尝试。
    }
    // ⚠️ 角色权限重构 C4·184 号预审 LOW（合并复审收尾）：`(?<!\d)`/`(?!\d)` 是 lookbehind/lookahead——
    //   lookbehind 需 Node ≥10（V8 6.2+/Chrome 62+ 起支持，V8 lookbehind 特性）；本项目 `package.json`
    //   未声明 `engines` 字段固定最低版本，本地开发运行时为 Node v24（远高于该门槛）。生产侧未能直接
    //   核实版本号（未做生产 SSH 探测，超出本次改动范围），但仓库内 `scripts/verify-unify-static.js:107`
    //   已有同款 lookbehind 用法（`(?<![\w-])...`，前端统一项目既有代码，已合并 main），是"这条语法在
    //   本项目实际部署环境下可用"的既有先例佐证。若未来需要支持 Node <10 的运行时，这两处 lookbehind
    //   都要一并改写（如手动前置一个非捕获组读前一字符判断），不是本函数独有的风险点。
    return str.replace(/(?<!\d)(1[3-9]\d)([-\s]?)(\d{4})([-\s]?)(\d{4})(?!\d)/g,
      (m, p1, sep1, mid, sep2, tail) => `${p1}${sep1}****${sep2}${tail}`);
  }
  // 审计/留痕文本清洗（收口审 MED-security）：留痕会长期保存，而错误串可能夹带 token 片段、
  //   手机号、HTTP 响应体。统一在这里去控制字符 + 掩手机号 + 截断，再落库。
  function sanitizeAuditText(s, maxLen = 80) {
    return maskPhoneDigits(s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[a-f0-9]{32,}/gi, '[hash]')                                 // token/密钥样式的长串
      .slice(0, maxLen);
  }

  // ⭐ 角色权限重构 C4·F9（172 号对抗审 Round-1 收口·MED）：快照脱敏改结构化，不再对整段 JSON 文本
  //   做一次性正则替换——那种做法命中不了"键名含 phone 的数字型字段"（JSON.stringify 后是裸数字，
  //   不带引号，值本身也未必凑够 11 位连续数字被正则命中）。改为：先 JSON.parse，递归遍历对象/数组——
  //   字符串值一律走 maskPhoneDigits；键名含 "phone"（大小写不敏感）的数字值先转字符串再同样脱敏
  //   （覆盖"库内该列意外存成数字"这种边缘情况）；处理完 JSON.stringify 写回。
  //   ⚠️ 两层策略：**结构化处理是主路径**（对已知形状的快照有键名感知，更精确）；若 JSON.parse 失败
  //   （脏数据/历史遗留非法 JSON），退化为对原始文本的字符串级正则兜底——不追求精确，只求"不裸奔"
  //   （宁可脱敏面稍宽也不漏一个手机号）。
  // ⭐⭐ C5 末次合并审 MED（186 号）：**纯数字标识字段豁免手机号规则**。上面②自由文本正则的边界断言
  //   `(?<!\d)…(?!\d)` 只能挡住"长数字串里的子串"，挡不住**整个值恰好长得像手机号**的情形——`oa_number`
  //   值域是 `/^\d{1,20}$/`，若某个 OA 流程号恰为 11 位且以 13-19 开头（如 13812345678），首尾边界均满足，
  //   会被整条掩成 `138****5678`，导致 admin 查删除审计时看不到真实 OA 号（可追溯性受损）。
  //   ⚠️ 上面那段注释自称"verify [M] 补了 20 位纯数字 OA 号负例证明不误伤"——20 位确实不命中，**11 位会**，
  //   负例选窄了（186 号 verify 已补 11 位用例）。
  //   豁免安全性：这些键在写入端就有格式闸门（oa_number 过 `/^\d{1,20}$/`），不可能承载自由文本，
  //   因此"跳过手机号扫描"不会放过真实手机号；反过来若把它们交给正则，损失的是真实业务标识。
  //   ⚠️ 新增键前先确认该键**写入端有纯数字/受限格式校验**，否则不得加入本集合。
  //   ⚠️⚠️ 186 号复审 MED（**本修复自身引入的过宽面·已收窄**）：豁免最初按键名递归生效，等于
  //   "任意快照、任意层级、任意同名键（含 oa_number 数组里的字符串元素）一律跳过手机号扫描"。
  //   写入端的 `/^\d{1,20}$/` 闸门只管得住 `sys_issues.oa_number` 这**一个顶层列**，管不住嵌套结构里
  //   任何人塞进来的同名键——那些位置一旦存手机号就会明文外泄。故收窄为**路径精确豁免**：
  //   仅 `issue_json` 的**顶层直接属性** `oa_number` 生效（depth===1），数组元素与嵌套对象一律照常脱敏。
  const SYS_AUDIT_NON_PHONE_NUMERIC_KEYS = new Set(['oa_number']);
  const SYS_AUDIT_NUMERIC_ID_EXEMPT_SNAPSHOT_COL = 'issue_json';   // 豁免只在这一份快照里成立
  function maskJsonSnapshotText(rawText, snapshotCol) {
    if (rawText == null) return rawText;
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return maskPhoneDigits(rawText);   // 兜底路径：非法 JSON 原文做字符串级脱敏，不裸奔
    }
    //   depth 语义：顶层 JSON 值本身 = 0，其直接属性 = 1，再往里/数组元素依次 +1。
    const walk = (node, keyHint, depth) => {
      // ⭐ 角色权限重构 C4·184 号预审（PM-3）：字符串分支也按 keyHint 走①路径（整值即手机号→标准形态）——
      //   此前字符串分支不看 keyHint，一律走自由文本正则；键名含 phone 的字符串值（如 requester_phone
      //   存的就是纯手机号）现在优先尝试①的整值判定，未命中再自然退化到②的自由文本正则（同一函数内部
      //   已处理该退化，见 maskPhoneDigits 定义）。
      const keyIsPhone = /phone/i.test(keyHint || '');
      // 186 号 MED（复审收窄）：纯数字标识字段豁免——**路径精确**：仅 issue_json 顶层直接属性（depth===1）。
      //   数组元素（depth≥2·同 keyHint 但已不是那个受校验的顶层标量）与任何嵌套层级的同名键都不豁免。
      const keyIsOpaqueNumericId = snapshotCol === SYS_AUDIT_NUMERIC_ID_EXEMPT_SNAPSHOT_COL && depth === 1
        && SYS_AUDIT_NON_PHONE_NUMERIC_KEYS.has(String(keyHint || '').toLowerCase());
      if (typeof node === 'string') return keyIsOpaqueNumericId ? node : maskPhoneDigits(node, { keyIsPhone });
      // ⭐⭐ 186 号末轮 MED（**注释声称过强·实现补齐**）：数字分支原先只看 keyIsPhone，其余数字一律原样
      //   返回——于是上一批注释里那句"数组元素与嵌套对象一律照常脱敏"对**数字型**值并不成立
      //   （`{"nested":{"oa_number":13812345678}}` 会明文输出）。该泄露面本身是既有行为（非本次引入），
      //   但把它留着而注释声称已覆盖，就是拿一个只在字符串路径成立的结论去背书全类型——同 MED-1 本体
      //   同一形态的错误。故补齐：非 phone 键的数字也按自由文本规则扫一遍。
      //   ⚠️ 类型保持：未命中手机号形态时返回**原数字**（不把 42 变成 "42"，避免改变快照的 JSON 类型面）；
      //   命中时才返回掩码字符串（此时原值已不可保留，类型变化是脱敏的必然代价）。
      if (typeof node === 'number') {
        if (keyIsPhone) return maskPhoneDigits(String(node), { keyIsPhone: true });
        if (keyIsOpaqueNumericId) return node;   // 受写入端 /^\d{1,20}$/ 闸门保护的那一个位置：原样
        const numStr = String(node);
        const maskedNum = maskPhoneDigits(numStr);
        return maskedNum === numStr ? node : maskedNum;
      }
      if (Array.isArray(node)) return node.map(item => walk(item, keyHint, depth + 1));
      if (node && typeof node === 'object') {
        const out = {};
        for (const k of Object.keys(node)) out[k] = walk(node[k], k, depth + 1);
        return out;
      }
      return node;   // boolean / null / undefined 原样保留
    };
    return JSON.stringify(walk(parsed, null, 0));
  }

  // ⭐ 角色权限重构 C4·F9（172 号对抗审 Round-1 收口·HIGH）：审计响应序列化统一入口——此前列表/详情
  //   两个端点各自手写脱敏字段清单，只脱敏了 reason，漏了 issue_title/operator_name（同样是用户可控的
  //   自由文本，同样可能夹带手机号），违反用户拍板口径的字面意思（"展示层手机号脱敏"没有限定只脱 reason）。
  //   集中一处，列表/详情共用，杜绝以后再有第三处各写一份脱敏字段清单。
  //   withSnapshots=false（列表用）只处理三个自由文本摘要字段；true（详情用）额外处理七份快照 JSON
  //   （用 hasOwnProperty 判断，天然兼容"列表 SELECT 没有这些列"的情形，不需要按调用方传参再分叉一次）。
  const SYS_AUDIT_TEXT_MASK_COLS = ['issue_title', 'operator_name', 'reason'];
  const SYS_AUDIT_SNAPSHOT_JSON_COLS = ['issue_json', 'timeline_json', 'attachments_json',
    'dev_assignees_json', 'dev_commits_json', 'dev_events_json', 'release_snapshots_json'];
  function serializeAuditRow(row, { withSnapshots } = {}) {
    const out = { ...row };
    for (const col of SYS_AUDIT_TEXT_MASK_COLS) {
      if (Object.prototype.hasOwnProperty.call(out, col)) out[col] = maskPhoneDigits(out[col]);
    }
    if (withSnapshots) {
      for (const col of SYS_AUDIT_SNAPSHOT_JSON_COLS) {
        // 186 号复审 MED：传列名——豁免只在 issue_json 里成立，其余六份快照的同名键照常脱敏。
        if (Object.prototype.hasOwnProperty.call(out, col)) out[col] = maskJsonSnapshotText(out[col], col);
      }
    }
    return out;
  }

  // 三侧落库 helper（read_at 在每次新发送时一并重置——新 message_key 后旧已读时刻失去意义；失败时同样清，failed=无可读消息）。
  //   ⚠️ C2b 诚实标注：本函数**当前无可达调用路径** —— 唯一调用者 sendSysDevNotify 只服务自动派发
  //   （dispatchSysNotify），而 isAutoNotifyEnabled 现恒 false，对所有 type 早返回。补 sent_by 仍是必要的：
  //   将来若恢复自动派发，缺 actor 会在这里**当场抛契约错**（fail-closed），而不是静默写出一批无操作者的行。
  async function recordSysDevNotify(issueId, ok, messageKey, error, sentBy) {
    const sb = assertNotifySentBy('recordSysDevNotify', sentBy);
    const r = await sysNotifyWriteRun(
      `UPDATE sys_issues SET notify_status=?, notified_at=datetime('now','localtime'),
              notify_message_key=?, notify_error=?, read_at=NULL, notify_sent_by=? WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, issueId]);
    warnNotifyWriteMissed('dev主表', issueId, sb, ok, ok ? messageKey : error, r);
    return r;
  }
  // requester 落库 helper 扩展落 phone_snapshot（通知改造 C3 H-5/M-A）：每次实际尝试发送（无论成败）都把
  //   本次使用的手机号固化进 requester_notify_phone_snapshot——首次发送=当前 requester_phone；此后任何
  //   重发/自动再触发都读快照（sendSysRequesterNotify 内 phoneToUse 已按此口径解析），故这里"再写一次快照"
  //   对已有快照是幂等 no-op、对首次发送是"落快照"动作，单一写点不分裂。
  //   ⭐ C2b：requester 是**唯一对业务方发声**的通道，也正是 167 号 HIGH-2 点名的场景——
  //   "谁给业务方发了那条钉钉"必须查得到。可达路径 = 手动 notify-requester 端点（actor 现成）
  //   + 自动派发（当前总闸关闭，不可达）。
  async function recordSysRequesterNotify(issueId, ok, messageKey, error, phoneSnapshot, sentBy) {
    const sb = assertNotifySentBy('recordSysRequesterNotify', sentBy);
    const r = await sysNotifyWriteRun(
      `UPDATE sys_issues SET requester_notify_status=?, requester_notified_at=datetime('now','localtime'),
              requester_notify_message_key=?, requester_notify_error=?, requester_read_at=NULL,
              requester_notify_sent_by=?,
              requester_notify_phone_snapshot=COALESCE(requester_notify_phone_snapshot, ?) WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, phoneSnapshot || null, issueId]);
    //   ⚠️ requester 是唯一对**业务方**发声的通道 —— "钉钉发出去了、库里却没落"在这一路后果最重
    //   （业务方拿着消息来问，而平台查不到任何记录）。零命中必须留线索。
    warnNotifyWriteMissed('业务方', issueId, sb, ok, ok ? messageKey : error, r);
    return r;
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
  async function recordSysRelayNotify(issueId, ok, messageKey, error, relayUserId, sentBy) {
    const sb = assertNotifySentBy('recordSysRelayNotify', sentBy);
    return await sysNotifyWriteRun(
      `UPDATE sys_issues SET relay_notify_status=?, relay_notified_at=datetime('now','localtime'),
              relay_notify_message_key=?, relay_notify_error=?, relay_read_at=NULL, relay_notify_sent_by=?
         WHERE id=? AND relay_notified_user_id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, issueId, relayUserId]);
  }
  // 建单人侧落库（通知改造 C3 G8，creator_notify_* 5 列，C1a 已建列·本 commit 起首次接入写路径）。
  async function recordSysCreatorNotify(issueId, ok, messageKey, error, sentBy) {
    const sb = assertNotifySentBy('recordSysCreatorNotify', sentBy);
    const r = await sysNotifyWriteRun(
      `UPDATE sys_issues SET creator_notify_status=?, creator_notified_at=datetime('now','localtime'),
              creator_notify_message_key=?, creator_notify_error=?, creator_read_at=NULL, creator_notify_sent_by=? WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, issueId]);
    warnNotifyWriteMissed('建单人', issueId, sb, ok, ok ? messageKey : error, r);
    return r;
  }
  // 对接人受理侧落库（建单优化批 C1 §4 改动点1/5；intake_notify_* 5 列，逐字镜像 recordSysCreatorNotify
  //   格局——含每次发送（含 failed 后重发）无条件清 intake_read_at、恒写 sent_by。⚠️ 本通道无
  //   intake_notified_at 列（方案 §4 列清单只列 5 列：status/message_key/error/read_at/sent_by，
  //   不含 notified_at），故 SET 子句比 creator 少一句，其余逐字一致。
  async function recordSysIntakeNotify(issueId, ok, messageKey, error, sentBy) {
    const sb = assertNotifySentBy('recordSysIntakeNotify', sentBy);
    const r = await sysNotifyWriteRun(
      `UPDATE sys_issues SET intake_notify_status=?,
              intake_notify_message_key=?, intake_notify_error=?, intake_read_at=NULL, intake_notify_sent_by=? WHERE id=?`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, issueId]);
    warnNotifyWriteMissed('对接人受理', issueId, sb, ok, ok ? messageKey : error, r);
    return r;
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
    //   C2b：改为复用统一守卫 assertNotifySentBy（语义不变、多判一格整数）——原地重复实现的那版
    //   与 C2b 五通道的守卫是同一条规则的两处表达，留着必然漂移。
    const sb = assertNotifySentBy('recordSysTechLeadNotify', sentBy);
    let effectiveOk = !!ok, mk = messageKey, err = error;
    if (effectiveOk && (messageKey == null || messageKey === '')) { effectiveOk = false; err = 'message_key_missing'; mk = null; }
    return await sysNotifyWriteRun(
      `UPDATE sys_issues SET tech_lead_notify_status=?, tech_lead_notified_at=datetime('now','localtime'),
              tech_lead_notify_message_key=?, tech_lead_notify_error=?, tech_lead_read_at=NULL, tech_lead_notify_sent_by=?
         WHERE id=? AND tech_lead_notify_request_event_id=?`,
      [effectiveOk ? 'sent' : 'failed', effectiveOk ? mk : null, effectiveOk ? null : (err || 'other'), sb, issueId, requestEventId]);
  }
  // [已退场 2026-07-30·用户裁定] recordSysReleaseExecutorNotify（release_assignee_notify_* 5 列落库 +
  //   对抗审 F3 收件人 CAS 围栏）已随旧上线编排家族封禁整体删除——唯一调用方 notify-release-executor 已封
  //   409，发送侧对 5 列零写路径（read_at 的已读固化残留写点见 notify-read-status 端点注释）；exports 的
  //   verify 直调出口一并移除（verify-sys-notify-sent-by 对应用例已删）。
  // 开发协作子表逐 dev 落库（通知改造 C3 G9）：定位 = (issue_id, user_id, removed_at IS NULL) 活动行（§6.1 M-2），
  //   软删历史行不参与——WHERE 天然排除，若并发中该行恰被软删，changes=0，本函数吞（best-effort 通知写，不抛）。
  //   ⭐ 对抗审 F4 收口：定位从 `(issue_id, user_id, removed_at IS NULL)` 改为**行主键**。
  //   缺口：原条件的设计意图是"行被软删则 changes=0 静默吞"，但它只挡"删"、不挡"**删了又加**"——
  //     T1 受理人点通知 dev5 → 钉钉在途
  //     T2 协调人移除 dev5（软删 R1）后又重新加回 dev5 → 生成新行 R2（新一轮，not_sent/sent_by=NULL）
  //     T3 T1 的回写按 (issue_id,user_id,removed_at IS NULL) 唯一命中的是 **R2**
  //   于是 R2 带着上一轮的投递结果与操作者出生：成功则显示"已通知"而新一轮内容从未发出，
  //   失败则新行一出生就是 failed + 红标。与 relay 的跨轮污染同构，只是这里连代际标识都没有。
  //   修法取最低成本：handler 早就查出了 devRow.id，直接拿它当围栏，**无需新增列**。
  async function recordSysDevAssigneeNotify(issueId, devAssigneeRowId, ok, messageKey, error, sentBy) {
    const sb = assertNotifySentBy('recordSysDevAssigneeNotify', sentBy);
    const rowId = Number(devAssigneeRowId);
    if (!(rowId > 0)) throw new Error(`recordSysDevAssigneeNotify: 需传 sys_issue_dev_assignees 行主键（防"移除→重加"跨代污染）·实际=${devAssigneeRowId}`);
    const r = await sysNotifyWriteRun(
      `UPDATE sys_issue_dev_assignees SET notify_status=?, notified_at=datetime('now','localtime'),
              notify_message_key=?, notify_error=?, read_at=NULL, notify_sent_by=?
        WHERE id=? AND issue_id=? AND removed_at IS NULL`,
      [ok ? 'sent' : 'failed', ok ? messageKey : null, ok ? null : (error || 'other'), sb, rowId, issueId]);
    //   零命中 = 该成员行在发送窗口内被软删（或整单被删）。原实现"静默吞"是有意的（best-effort），
    //   但静默的代价是"钉钉已发、库里无痕"完全不可查 —— 保留不抛，改为留一条线索。
    warnNotifyWriteMissed('开发(子表)', issueId, sb, ok, ok ? messageKey : error, r);
    return r;
  }

  // dev 侧发送（收件人 = assigned_to → users.id/phone/dingtalk_user_id；§8.2）。
  //   ⚠️ 本函数只服务【自动派发】路径（dispatchSysNotify，对 bug 早返回不触达——现只有变更流 feature/improvement
  //   会走到这里）——单开发 + 主表 notify_* 语义在通知改造后对变更流保持零回归。bug 的手动逐 dev 通知走
  //   G9（notify-developer 端点）+ recordSysDevAssigneeNotify（子表），两条路径按 type 天然分流，互不覆盖。
  //   C2b：新增 sentBy 入参（= 引发本次自动派发的流转操作者 id）——由 dispatchSysNotify 一路透传自各端点的 actor。
  async function sendSysDevNotify(issue, marker, baseUrl, sentBy) {
    if (!issue.assigned_to) { await recordSysDevNotify(issue.id, false, null, 'no_assignee', sentBy); return; }
    const dev = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.assigned_to]);
    if (!dev) { await recordSysDevNotify(issue.id, false, null, 'dev_not_found', sentBy); return; }
    const { title, md } = buildSysDevMarkdown(issue, marker, baseUrl);
    const result = await sendIssueDingtalkRaw(dev, title, md);
    await recordSysDevNotify(issue.id, !!result.ok, result.message_key, result.reason, sentBy);
  }

  // 需求方侧发送（收件人 = requester_phone 反查钉钉号；业务方无平台账号；§8.2）。
  //   通知改造 C3 H-5/M-A 收件人快照：phoneToUse 优先取已落的 requester_notify_phone_snapshot（"重发"场景——
  //   一旦首次实际尝试过发送，后续一律认准同一快照，不受当前 requester_phone 被清空/改号影响）；
  //   快照为空（真正首次发送，或历史 pre-C1a 无快照旧数据不适用——生产 0 行不可达）才退回当前 requester_phone。
  //   C2b：新增 sentBy 入参 —— 手动 notify-requester 端点传点按钮的人；自动派发路径传引发流转的 actor。
  //   ⚠️ 注意「无需求方直接 return」这一支**不落库也不需要 sentBy**（保持 not_sent，见下方 ultracode #2 注释），
  //   所以 sentBy 的契约校验发生在真正落库的两条路径上，不会把"根本没发"误判为契约违规。
  async function sendSysRequesterNotify(issue, kind, baseUrl, sentBy) {
    const phoneToUse = issue.requester_notify_phone_snapshot || issue.requester_phone;
    // ultracode 审 #2：无需求方（内部自发现单常见，requester 三字段+快照皆空）→ 无人可通知，保持 not_sent（不算失败）。
    //   否则每张内部单 estimate/已上线后都被打成 requester『failed』，C6 满屏假失败红标 + admin 无意义重试。
    //   区分『有需求方但缺手机号』(→failed) 与『根本无需求方』(→保持 not_sent)。
    if (!phoneToUse && !issue.requester_name && !issue.requester_dept) return;
    if (!phoneToUse) { await recordSysRequesterNotify(issue.id, false, null, 'requester_phone_empty', null, sentBy); return; }
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
    await recordSysRequesterNotify(issue.id, !!result.ok, result.message_key, result.reason, requesterDispatched ? phoneToUse : null, sentBy);
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
  //   ⭐ C2b 新增第三个入参 `actorId`（方案 v1.7 §4-C2b）：自动派发通道的 `sent_by` 语义 =
  //   **引发本次通知的流转操作者**（谁做了 estimate / 发布 / 打回），与手动通道「谁点了发送」并列，
  //   共用同一条不变量。9 个调用点全部显式传入。
  //   ⚠️ 为什么在"自动派发当前恒关"的情况下仍要透传：这条参数把「恢复自动派发时必须提供操作者」
  //   结构性地钉住了 —— 缺 actor 会在 record 层**当场抛契约错**（fail-closed），
  //   而不是静默写出一批 sent_by 为空、事后与历史行无法区分的记录。
  //   ⚠️ **准确说 fail-closed 发生在"真正落库那一刻"，不是本函数入口**（codex C2b 复审 LOW·如实标注）：
  //   不落库的分支（marker 为空 / 总闸关闭 / 无需求方早返回）不会校验 actorId，错值会被静默带过。
  //   **刻意不在入口加守卫**：本函数被 9 处调用，其中多数 marker 根本不发送；入口抛错会沿调用栈
  //   传到端点的 catch（如 sendSysTransitionError），把一次 **best-effort 通知**升级成**业务请求 500**
  //   —— 通知失败不该打断已经提交成功的业务流转，这条边界比"更早失败"更重要。
  async function dispatchSysNotify(issueId, marker, actorId) {
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
          await sendSysDevNotify(issue, marker, baseUrl, actorId);
          break;
        case 'notifyEstimateToCreatorAndRequester':
          await sendSysRequesterNotify(issue, 'estimate', baseUrl, actorId);   // 仅需求方侧；creator 侧本期 not_sent（M-4）
          break;
        case 'notifyReleasedToRequester':
          await sendSysRequesterNotify(issue, 'released', baseUrl, actorId);
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
  // ── 建单优化批 C1（方案 §4 改动点3）：intake 通道判定 = 仅「待受理」态可发——三 type 共用同一值
  //   （受理门统一焊死为「待受理」单值，不像 relay/developer 那样分 bug/变更流两套，见下方 sysNotifyStatusesFor）。
  const SYS_NOTIFY_INTAKE_STATUSES = ['待受理'];

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
               creator: SYS_NOTIFY_CREATOR_STATUSES, requester: SYS_NOTIFY_REQUESTER_STATUSES,
               intake: SYS_NOTIFY_INTAKE_STATUSES }[channel] || [];
    }
    if (type === 'feature' || type === 'improvement') {
      // 变更流无 relay 通道（对接人是 bug path B 专属）——relay 返空=永远拒绝。intake 通道三 type 同值。
      return { developer: SYS_NOTIFY_DEV_STATUSES_CHANGE, relay: [],
               creator: SYS_NOTIFY_CREATOR_STATUSES_CHANGE, requester: SYS_NOTIFY_REQUESTER_STATUSES_CHANGE,
               intake: SYS_NOTIFY_INTAKE_STATUSES }[channel] || [];
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
  const SYS_MANUAL_NOTIFY_CHANNELS = new Set(['developer', 'creator', 'requester', 'relay', 'intake']);
  // ⭐⭐ [C10·决策2/4] opts.enforceBinding：**写路径**（notify-developer/creator/requester 三兄弟）传 true → 用
  //   绑单精判（admin ∨ 该单对接人）；**读路径**（notify-read-status 查已读状态）不传 → 保持 admin∨候选白名单[13]
  //   不动（决策4：可见性/已读查询不在 C10 收窄范围·isSysIntakeLiaison 仅可见性语义保留）。同一守卫两种口径，
  //   由调用方按"这是操作还是查看"显式选择，不让守卫猜。
  function sysManualNotifyGuard(issue, channel, actor, opts = {}) {
    const type = issue.type;
    const isAdmin = actor.role === 'admin';
    const isIntakeLiaison = isSysIntakeLiaison(actor.id);   // 读路径（read-status）沿用·仅可见性语义（决策4 保留）
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
    // ── 建单优化批 C1（方案 §4 改动点2，审 215 M-5）：intake 通道——路由级 requireAdmin 是唯一放行条件，
    //   本分支只做业务校验的一部分（type 门限 fail-closed）；但本函数同时被 notify-read-status 复用
    //   （该端点无路由级 requireAdmin，靠这里精判），故仍需显式判 isAdmin——**与 relay 同构**（受理人
    //   是通知对象本人，不给自己发；全类型统一，不像 relay 那样仅 bug 可用，因 intake_liaison_id 适用
    //   全部三类型）。
    if (channel === 'intake') {
      if (type === 'bug' || type === 'feature' || type === 'improvement') {
        return isAdmin ? null : { status: 403, body: { error: '仅管理员可通知对接人受理', code: 'NOT_AUTHORIZED_FOR_NOTIFY' } };
      }
      return { status: 400, body: { error: '该类型暂不支持手动通知', code: 'MANUAL_NOTIFY_TYPE_NA' } };
    }
    // developer / creator / requester：C1 起**全类型统一** = admin ∨ 受理人[13]
    if (type === 'bug' || type === 'feature' || type === 'improvement') {
      // ⭐⭐ [C10·决策2·绑单精判] 写路径（enforceBinding）：admin ∨ 该单 intake_liaison_id 本人（行为变更·
      //   示例对接人从"可发所有单通知"→"仅名下单"）。读路径（read-status）：保持 admin∨候选[13]（决策4 可见性不动）。
      // ⭐⭐⭐ [C10-fix5 HIGH·守卫保同步·eligibility 经 opts 预读传入] 绑单分支叠加 eligibility（撤销资格即失操作权·
      //   fail-closed）。**本守卫刻意保持同步**——verify-sys-role-perm-c1 [G] 组同步直调本函数、异步化会破测且涟漪到
      //   relay/intake/read-status 三个无关调用点；且 isIntakeLiaisonEligible 读库属 async，不能在同步函数内 await。
      //   故 eligibility 由三个写路径调用方（notify-developer/creator/requester）在调用守卫**前**预读 actor 的
      //   isIntakeLiaisonEligible 结果、经 opts.actorEligible 传入（actor 作用域不变量·一次读库）。
      //   `opts.actorEligible === true` 显式全等：未传/undefined ⇒ 非 admin 一律拒（fail-closed·防未来新增
      //   enforceBinding 调用方漏传 eligibility 时静默放行）。admin 经 isBoundLiaisonOrAdmin 内旁路，不受 eligibility 约束。
      if (opts.enforceBinding) {
        const granted = isBoundLiaisonOrAdmin(actor, issue) && (isAdmin || opts.actorEligible === true);
        return granted ? null : { status: 403, body: { error: '仅管理员或该单对接人可发送该通知', code: 'NOT_BOUND_LIAISON' } };
      }
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
      const actor = sysActor(req);   // C2b（codex 审 MED）：授权判定与 sent_by 同源，一个 handler 只取一次 actor
      // ⭐ [C10-fix5 HIGH·守卫前预读 eligibility] 调用同步守卫前先 await 一次 actor 的候选资格，经 opts 传入绑单精判分支
      //   （撤销资格即失发通知权·fail-closed·[[feedback_async_handler_input_gates]] 输入面前置）。
      const actorEligible = actor.role === 'admin' ? true : await isIntakeLiaisonEligible(actor.id);   // [C10-fix6·codex 322-R MED-1] admin 旁路彻底不读库（守卫已 isAdmin 放行·省查询+资格函数异常不连累 admin 通知路径）
      const devAuthErr = sysManualNotifyGuard(issue, 'developer', actor, { enforceBinding: true, actorEligible });   // [C10·决策2] 写路径=绑单精判
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
      if (Number(devUserId) === Number(actor.id)) {
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
      //   对抗审 F4：传**行主键** devRow.id（上方 :7030 已查出）而非 user_id —— 软删后重加会生成新行，
      //   按 (issue_id,user_id) 定位会让本轮回写落到下一轮的新行上。
      await recordSysDevAssigneeNotify(id, devRow.id, !!result.ok, result.message_key, result.reason, actor.id);
      //   对抗审 F8：状态列会被重置抹掉，历史投递另落一条只增 timeline（谁在何时发给了谁、成没成）
      await recordSysNotifyTimeline(id, '开发', `${dev.display_name || dev.username || ''}(id${devUserId})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);
      const fresh = await dbGetAsync('SELECT notify_status, notify_error FROM sys_issue_dev_assignees WHERE id = ?', [devRow.id]);
      res.json({ id, dev_user_id: devUserId, notify_status: fresh.notify_status, notify_error: fresh.notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知开发失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知开发失败' }); }
  });

  // ── S3（bug暂缓方案 20260803 v0.4 §7.3）：POST /sys-issues/:id/notify-resume-dev ──────────────────
  //   重启通知开发——admin 手动点按钮，批量通知**全部在册开发**（§7.4 resume 事务已把子表 notify_* 整组
  //   重置为 not_sent，本端点是对应的"发"半边；一次点击尽力发给所有本轮未发送成功的在册成员，语义上与
  //   §7.4 的"整组重置"对称，不做单人挑选——这与 notify-developer 端点"逐 dev 挑一个发"是两回事，
  //   刻意不复用同一端点：授权规则不同（本端点固定 admin-only，非 admin∨受理人）、状态判据不同
  //   （§7.3 专属算法，非 sysNotifyStatusesFor 白名单）、收件人范围不同（批量 vs 单选）。
  //   requireAdmin 中间件直接放行判定——不像 hold 那样"admin∨在册"两种身份混合，本端点唯一合法调用者
  //   只有 admin，可以在中间件层拦（同 accept/return/close 等纯 admin 端点范式，无需拖到引擎里精判）。
  router.post('/sys-issues/:id/notify-resume-dev', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // ① type 门限：仅 bug（本通知功能本身是 bug 暂缓机制的配套，变更流没有对应的"暂缓通知建单人"新入口）。
      if (issue.type !== 'bug') return res.status(409).json({ error: '仅 bug 单支持重启通知', code: 'RESUME_NOTIFY_TYPE_NA' });
      // ② status 门限：仅「处理中」——重启的落点态（bug hold.from 恒为处理中，resume 恒回处理中）。
      if (issue.status !== '处理中') return res.status(409).json({ error: `当前状态（${issue.status}）不可发送重启通知`, code: 'STATUS_NOT_NOTIFIABLE' });
      // ③ ⭐⭐ 方案 §7.3 可执行算法——逐字实现，禁止"优化"回 action_code IN (...) 筛选（见下方长注释）。
      //   第一步：只用 to_status 筛选主状态入边（结构化字段，所有主状态转移都写；note 类旁路事件 to_status
      //   为 NULL，天然被排除）。
      //   第二步：判定该行是否为本轮 resume（仅 resume 的 action_code 非 NULL 且为 'resume' → 放行；否则
      //   NULL/其他值/无行 → 一律拒绝）。
      //   ⚠️⚠️ 为什么筛选只能用 to_status、不能用 action_code IN ('resume','return','reopen','assign')：
      //   已核实的真值表——resume 的 action_code='resume'（非空）；hold='hold'；而 assign/return/reopen
      //   **全部为 NULL**（return/reopen 走独立 timelineEvent、INSERT 语句里没有 action_code 列；assign 走
      //   独立写点同样没有该列）。若把这四者 OR 进筛选条件，return/reopen/assign 三类行会因 action_code
      //   IS NULL 而被 SQL `IN (...)` 判定为不匹配，一条都选不中——"最近入口事件"会错误地落回更早那条
      //   resume 行，H-1 的防误发修复完全失效（234 H-1 教训）。筛选只用 to_status，action_code 只在拿到
      //   行之后、第二步里判定，绝不能合并成一个筛选条件。
      const entryRow = await dbGetAsync(
        `SELECT id, action_code, summary, operator_name FROM sys_issue_timeline
          WHERE issue_id = ? AND to_status = '处理中'
          ORDER BY id DESC LIMIT 1`,
        [id]
      );
      if (!entryRow || entryRow.action_code !== 'resume') {
        return res.status(409).json({ error: '最近一次进入「处理中」并非通过重启（resume），不可发送重启通知', code: 'RESUME_ANCHOR_NOT_FOUND' });
      }
      // ④ 本轮通知列状态非 sent——批量语义：只要还有在册成员本轮未发送成功，就允许触发（发给这些"待发"的人；
      //   已经 sent 的不重发，天然幂等）。全员皆 sent 时明确拒绝（同轮重复点击的语义，§10.6 第 9 条）。
      const roster = await dbAllAsync(
        `SELECT id, user_id, notify_status FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
      if (roster.length === 0) return res.status(409).json({ error: '当前无在册开发，无法发送重启通知', code: 'RESUME_NOTIFY_NO_ROSTER' });
      const pending = roster.filter(r => r.notify_status !== 'sent');
      if (pending.length === 0) return res.status(409).json({ error: '本轮重启通知已全部发送', code: 'NOTIFY_ALREADY_SENT' });
      const actor = sysActor(req);
      const baseUrl = await getSafePlatformBaseUrl();
      // "谁做的"取本轮 resume 事件的 operator_name（entryRow 本就是③步查出的同一行，不额外查询）。
      const { title, md } = buildSysResumeDevMarkdown({ ...issue, resume_by_name: entryRow.operator_name }, entryRow.summary, baseUrl);
      const results = [];
      let claimedAny = false;
      for (const member of pending) {
        // ⑤ ⭐⭐ S3b2·M-1：逐行原子 claim（CAS）——同 hold 侧同一套机制，子表 notify_message_key 兼作临时
        //   占位令牌（不引入 sending 态，理由同 hold 侧长注释）。claim 失败（changes!==1）说明该行已被
        //   并发请求认领或本轮已 sent，跳过不发（这不是这一行的错误，是"这一行这次不归我发"）——批量场景
        //   下允许部分行认领成功、部分行跳过，不因个别行冲突让整批失败。
        //   失败释放路径同 hold 侧：recordSysDevAssigneeNotify 既有实现 `notify_message_key = ok ? messageKey : null`，
        //   发送失败时自动把 message_key 写回 NULL，等价于释放占位，无需额外代码。
        const claimToken = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${member.id}`;
        const claim = await dbRunAsync(
          `UPDATE sys_issue_dev_assignees SET notify_message_key = ?
             WHERE id = ? AND issue_id = ? AND removed_at IS NULL AND notify_status <> 'sent' AND notify_message_key IS NULL`,
          [claimToken, member.id, id]
        );
        if (!claim || claim.changes !== 1) {
          results.push({ dev_assignee_id: member.id, user_id: member.user_id, ok: false, skipped: true, reason: 'claim_conflict' });
          continue;
        }
        claimedAny = true;
        const user = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [member.user_id]);
        if (!user) {
          await recordSysDevAssigneeNotify(id, member.id, false, null, 'dev_not_found', actor.id);
          results.push({ dev_assignee_id: member.id, user_id: member.user_id, ok: false, reason: 'dev_not_found' });
          continue;
        }
        // S5b·M-1 收口（防御性对称，非本轮已知的具体 bug）：sendIssueDingtalkRaw 内部已把已知失败模式
        //   （无配置/无手机号/token 失败/查用户失败）都归一成 {ok:false,...} 返回值，理论上极少抛出未捕获
        //   异常；但同构 notify-hold-creator 侧、intake_return 既有范式（index.js:5066-5077），仍整体包一层
        //   try——万一真抛异常，本行 claim 已占的 notify_message_key 若不归一成 {ok:false} 交给下面
        //   recordSysDevAssigneeNotify 落库，会永久卡死（同 M-1 那一类问题），且异常会中断整个 for 循环、
        //   连累其余成员本轮也发不出。
        let result;
        try {
          result = await sendIssueDingtalkRaw(user, title, md);
        } catch (sendErr) {
          result = { ok: false, reason: (sendErr && sendErr.message) || 'notify_exception' };
        }
        await recordSysDevAssigneeNotify(id, member.id, !!result.ok, result.message_key, result.reason, actor.id);
        await recordSysNotifyTimeline(id, '开发', `${user.display_name || user.username || ''}(id${member.user_id})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);
        results.push({ dev_assignee_id: member.id, user_id: member.user_id, ok: !!result.ok });
      }
      // 整批全部被并发请求抢先认领（一行都没抢到）→ 明确 409，与 hold 侧同一错误码语义（"这轮不归你发"）；
      // 部分抢到部分没抢到 → 仍 200，results 里逐行标注 skipped，调用方可读到"哪些行是我发的"。
      if (!claimedAny) {
        return res.status(409).json({ error: '本轮重启通知正在发送中或已被其他请求认领，请稍后刷新查看', code: 'NOTIFY_CLAIM_CONFLICT' });
      }
      const fresh = await dbAllAsync(
        `SELECT id, user_id, notify_status, notify_error FROM sys_issue_dev_assignees WHERE issue_id = ? AND removed_at IS NULL`, [id]);
      res.json({ id, results, dev_assignees: fresh });
    } catch (err) { logger.error('[系统迭代] 重启通知开发失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '重启通知开发失败' }); }
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
      const actor = sysActor(req);   // C2b：同上，授权与 sent_by 同源
      const relayAuthErr = sysManualNotifyGuard(issue, 'relay', actor);
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
      const rec = await recordSysRelayNotify(id, !!result.ok, result.message_key, result.reason, issue.relay_notified_user_id, actor.id);
      await recordSysNotifyTimeline(id, '对接人', `${issue.relay_notified_user_name || ''}(id${issue.relay_notified_user_id})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);   // 对抗审 F8
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
      // ⭐ [C10-fix5 HIGH·守卫前预读 eligibility] 同 notify-developer：调用同步守卫前先 await 候选资格经 opts 传入（fail-closed）。
      const actorEligible = actor.role === 'admin' ? true : await isIntakeLiaisonEligible(actor.id);   // [C10-fix6·codex 322-R MED-1] admin 旁路彻底不读库（守卫已 isAdmin 放行·省查询+资格函数异常不连累 admin 通知路径）
      const creatorAuthErr = sysManualNotifyGuard(issue, 'creator', actor, { enforceBinding: true, actorEligible });   // [C10·决策2] 写路径=绑单精判
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
      await recordSysCreatorNotify(id, !!result.ok, result.message_key, result.reason, actor.id);
      await recordSysNotifyTimeline(id, '建单人', `${creator.display_name || creator.username || ''}(id${issue.created_by})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);   // 对抗审 F8
      const fresh = await dbGetAsync('SELECT creator_notify_status, creator_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, creator_notify_status: fresh.creator_notify_status, creator_notify_error: fresh.creator_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知建单人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知建单人失败' }); }
  });

  // ── S3（bug暂缓方案 20260803 v0.4 §7.3）：POST /sys-issues/:id/notify-hold-creator ──────────────────
  //   暂缓通知建单人——活跃在册开发或 admin 手动点按钮。刻意不复用上方通用 notify-creator 端点：授权规则
  //   不同（本端点=任一活跃在册成员∨admin，通用 creator 通道=admin∨受理人，两者授权主体集合不等价，且本
  //   端点权限判定需**逐字复用 S2 的 assertBugHoldActor**——同一份判定口径，不重新实现一份易漂移的副本）；
  //   状态判据不同（本端点=固定"已暂缓"单态 + hold 本轮锚点，非 sysNotifyStatusesFor 的多态白名单）；
  //   type 门限不同（本端点仅 bug，通用 creator 通道 bug/feature/improvement 皆可）。
  //   校验顺序严格按方案 §7.3 五步枚举顺序实现（type→status→actor→本轮锚点→self-guard），非套用上面
  //   notify-creator"self-guard 优先于状态闸门"的旧范式——本端点是方案专门定义的新契约，独立枚举顺序。
  router.post('/sys-issues/:id/notify-hold-creator', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      // ① type 门限：不得对变更流暂缓单生效（暂缓通知是 bug 暂缓机制的配套，变更流不适用）。
      if (issue.type !== 'bug') return res.status(409).json({ error: '仅 bug 单支持暂缓通知', code: 'HOLD_NOTIFY_TYPE_NA' });
      // ② status 门限：仅「已暂缓」。
      if (issue.status !== '已暂缓') return res.status(409).json({ error: `当前状态（${issue.status}）不可发送暂缓通知`, code: 'STATUS_NOT_NOTIFIABLE' });
      // ③ 授权：任一活跃在册成员 ∨ admin——**复用 S2 的 assertBugHoldActor**，与"谁能标记暂缓"同一套判定
      //   口径（含 dev_status != 'excused' 的加严，见该函数定义处注释），不重新实现第二份易漂移的判定。
      const actor = sysActor(req);
      try {
        await assertBugHoldActor(actor, issue);
      } catch (guardErr) {
        if (guardErr instanceof SysTransitionError) return res.status(guardErr.httpStatus).json({ error: guardErr.message, code: guardErr.code });
        throw guardErr;
      }
      // ④ ⭐ 本轮锚点（S3b2·L-1 统一判据）：与重启侧（notify-resume-dev）同构算法——先按 to_status 筛选
      //   主状态入边（结构化字段，所有主状态转移都写），再判该行是否为 hold。原实现直接把
      //   `action_code = 'hold'` 塞进 WHERE 一起筛选，是比重启侧弱的判据：若将来出现"非 hold 方式进入
      //   已暂缓"的路径（如某个新动作也能让单据落到已暂缓态），这条 WHERE 会跳过那一行、静默回落到更早
      //   一条真正的 hold 行，把陈旧事件误判为"本轮"。改成同构写法后，"最近一次进入已暂缓的入边是不是
      //   hold"这个判定与重启侧"最近一次进入处理中的入边是不是 resume"完全对称，两侧判据强度一致。
      const holdRow = await dbGetAsync(
        `SELECT id, action_code, summary, operator_name FROM sys_issue_timeline
          WHERE issue_id = ? AND to_status = '已暂缓'
          ORDER BY id DESC LIMIT 1`,
        [id]
      );
      if (!holdRow || holdRow.action_code !== 'hold') {
        return res.status(409).json({ error: '未找到本轮暂缓事件（最近一次进入已暂缓并非通过 hold）', code: 'HOLD_ANCHOR_NOT_FOUND' });
      }
      if (issue.creator_notify_status === 'sent') return res.status(409).json({ error: '本轮暂缓通知已发送', code: 'NOTIFY_ALREADY_SENT' });
      // ⑤ self-guard：操作者==建单人时跳过发送（复用 intake_return 的 SELF_NOTIFY_SKIPPED 范式），且保持
      //   not_sent 不写 sent（§7.4 明确要求，避免"跳过"被后续误读为"已发送"）——故此处直接 return，不落
      //   recordSysCreatorNotify 任何值。
      if (Number(actor.id) === Number(issue.created_by)) {
        return res.json({ id, skipped: true, code: 'SELF_NOTIFY_SKIPPED' });
      }
      // ⑥ ⭐⭐ S3b2·M-1：原子 claim（CAS）——防并发点击/浏览器重试/代理重放让两个请求都读到 not_sent
      //   各自发送 → 同轮重复真实发送。用现有列做条件更新，`creator_notify_message_key` 兼作临时占位
      //   令牌（值域三态 not_sent/sent/failed，**不引入 sending 态**——加态要改 CHECK，SQLite 得 drop+
      //   重建 37 列表，同时破坏本方案零 schema 变更承诺与项目"不再 drop 重建"规矩）。
      //   条件：status<>'sent'（真正已发送的不会被抢）且 message_key IS NULL（§7.4 hold/resume 事务已把它
      //   清 NULL，新一轮从 NULL 起步；已被别的并发请求认领的行此刻 message_key 是对方的令牌，非 NULL，
      //   抢不到）。changes!==1 → 明确 409，不重试、不静默吞。
      //   ⚠️ 失败释放路径**不需要额外代码**：recordSysCreatorNotify 的既有实现本就是
      //   `creator_notify_message_key = ok ? messageKey : null`——发送失败时它会把 message_key 写回
      //   NULL，等价于"释放占位"，下一次点击（同轮重试）能重新 claim 成功。这是复用既有函数的既有行为，
      //   不是新写的释放逻辑，两者必须保持同步：若未来改了 recordSysCreatorNotify 的失败分支不再清空
      //   message_key，这里的 claim 机制会失效（同轮永久卡死，claim 后失败=没人能再发）。
      // ⑤b S5b·M-1 收口（codex 239 复审，末次合并审确认真缺陷）：建单人用户查询提到 claim **之前**——
      //   这条查询只依赖 issue.created_by（③步之前已读到），与"是否已 claim"无关，没有理由留在 claim 之后。
      //   ⚠️ 原实现把它放在 claim 之后：查不到用户时 `return 409 CREATOR_NOT_FOUND`，claim 已占的
      //   `creator_notify_message_key` 从未被释放——建单人用户不存在（孤儿 created_by／用户表历史清理）
      //   时会让本轮通知永久卡在 NOTIFY_CLAIM_CONFLICT，直到下一次 hold 才被 §7.4 重置。讽刺之处：本方案
      //   整节 §4.5 消除的是 resume 死锁，却在通知路径引入了一个同类的小死锁。修法：把"claim 之后还可能
      //   因缺前置数据而提前 return"的检查一律挪到 claim 之前，claim 之后只留"必然要走完、双归一"的路径
      //   （见下方 try/catch）。
      const creator = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [issue.created_by]);
      if (!creator) return res.status(409).json({ error: '建单人用户不存在', code: 'CREATOR_NOT_FOUND' });
      const claimToken = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const claim = await dbRunAsync(
        `UPDATE sys_issues SET creator_notify_message_key = ?
           WHERE id = ? AND creator_notify_status <> 'sent' AND creator_notify_message_key IS NULL`,
        [claimToken, id]
      );
      if (!claim || claim.changes !== 1) {
        return res.status(409).json({ error: '本轮暂缓通知正在发送中或已被其他请求认领，请稍后刷新查看', code: 'NOTIFY_CLAIM_CONFLICT' });
      }
      // S5b·M-1 收口（同构 intake_return 既有范式，index.js:5066-5077 的"整体包一层 try，异常归一 {ok:false}"）：
      //   claim 之后仅剩"必然要落一个结果"的发送路径——baseUrl 取值/模板构建/实际发送整体包一层 try，
      //   任一环节抛异常都归一为 {ok:false}，下面 recordSysCreatorNotify 无条件落库（含释放 claim，见该函数
      //   SET 子句 `ok?messageKey:null`）。不再让"claim 已占、异常直接扔给外层 500"这条路径存在——
      //   那条路径下 claim 永远不会被释放（同一类缺陷的防御性收口，非仅修已知的 creator 一处）。
      let result;
      try {
        const baseUrl = await getSafePlatformBaseUrl();
        // "谁做的"取本轮 hold 事件的 operator_name（holdRow 本就是④步查出的同一行，不额外查询）；
        // reason 传 holdRow.summary——hold 的 summary 就是理由原文本身（无拼接），对齐模板注释。
        const { title, md } = buildSysHoldCreatorMarkdown({ ...issue, hold_by_name: holdRow.operator_name }, holdRow.summary, baseUrl);
        result = await sendIssueDingtalkRaw(creator, title, md);
      } catch (prepOrSendErr) {
        result = { ok: false, reason: (prepOrSendErr && prepOrSendErr.message) || 'notify_exception' };
      }
      await recordSysCreatorNotify(id, !!result.ok, result.message_key, result.reason, actor.id);
      await recordSysNotifyTimeline(id, '建单人', `${creator.display_name || creator.username || ''}(id${issue.created_by})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);
      const fresh = await dbGetAsync('SELECT creator_notify_status, creator_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, creator_notify_status: fresh.creator_notify_status, creator_notify_error: fresh.creator_notify_error });
    } catch (err) { logger.error('[系统迭代] 暂缓通知建单人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '暂缓通知建单人失败' }); }
  });

  // ── [已退场] POST /sys-issues/:id/notify-release-executor：手动通知上线开发（通知改造 follow-up 2026-07-07）──────────
  //   [2026-07-30 用户裁定·旧上线编排家族 4 端点全封] 写入口 assign-release-dev 已封 ⇒ release_assignee_id
  //   全库零写路径，本端点前置条件在生产永不满足；执行人通知现走行级端点（批次详情逐人发送·notify-executor 已随 C4b 退场）。
  router.post('/sys-issues/:id/notify-release-executor', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.status(409).json({
      error: '该端点已下线：执行人通知现走批次详情逐人发送（行级端点），不再单据级单独通知',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
  });

  // ── [已退场] POST /sys-issues/notify-release-executor-batch：批量通知上线开发（模型B 合并发送）──────────
  //   [2026-07-30 用户裁定·旧上线编排家族 4 端点全封] 理由同上方单条端点；②态闸/按组守卫 UPDATE/竞态对账
  //   等实现整体删除（历史设计见 git 历史 + codex 审 48-51 归档），回滚以整个 commit 为单位。
  router.post('/sys-issues/notify-release-executor-batch', authenticateToken, requireSysSchemaReady, (req, res) => {
    res.status(409).json({
      error: '该端点已下线：执行人通知现走批次详情逐人发送（行级端点），不再按单据批量通知',
      code: 'LEGACY_RELEASE_FLOW_DISABLED',
    });
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
      const actor = sysActor(req);   // C2b：同上
      // ⭐ [C10-fix5 HIGH·守卫前预读 eligibility] 同 notify-developer/creator：调用同步守卫前先 await 候选资格经 opts 传入（fail-closed）。
      const actorEligible = actor.role === 'admin' ? true : await isIntakeLiaisonEligible(actor.id);   // [C10-fix6·codex 322-R MED-1] admin 旁路彻底不读库（守卫已 isAdmin 放行·省查询+资格函数异常不连累 admin 通知路径）
      const reqAuthErr = sysManualNotifyGuard(issue, 'requester', actor, { enforceBinding: true, actorEligible });   // [C10·决策2] 写路径=绑单精判
      if (reqAuthErr) return res.status(reqAuthErr.status).json(reqAuthErr.body);
      const reqStatuses = sysNotifyStatusesFor(issue.type, 'requester');
      if (!reqStatuses.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知报障人`, code: 'STATUS_NOT_NOTIFIABLE' });   // 排终态矛盾卡片（复审）+ F3 收窄（去处理中）
      // M-A：快照非空=已发送过，允许重发（不看当前 phone）；快照空=首发，须当前 phone 非空
      if (!issue.requester_notify_phone_snapshot && !issue.requester_phone) {
        return res.status(409).json({ error: '无报障人手机号，无法通知', code: 'NO_REQUESTER_PHONE' });   // 显式前置拦（避免误落 failed）
      }
      const baseUrl = await getSafePlatformBaseUrl();
      // ⭐ [C9 读点标注·方案 v1.7 §10.1 逐点标注要求] **本读点显式声明：不区分「已上线」的来源。**
      //   免上线直翻单（online_source='no_commit_acceptance'）与批次发布单一样走 `released` 卡片——
      //   对业务方而言"你的需求上线了"这件事没有两种说法，来源是内部流程细节，不该出现在对外通知里。
      //   ⚠️ 已有的降级正好覆盖直翻单：直翻单 release_id 恒 NULL ⇒ 无版本号 ⇒ 本行注释里那句
      //     「release_id=NULL 时 sendSysRequesterNotify 优雅降级无版本行」**正是直翻单的实际形态**
      //     （该降级早于 C9 存在，为 bug hotfix 不建批次场景写的，C9 天然复用，无需改动发送侧）。
      const kind = issue.status === '已上线' ? 'released' : 'progress';   // 已上线走 released（带版本，release_id=NULL 时 sendSysRequesterNotify 优雅降级无版本行），否则 progress（当前状态）
      await sendSysRequesterNotify(issue, kind, baseUrl, actor.id);   // 落库 requester_notify_*（含快照 H-5/M-A + C2b sent_by=点发送的人）
      const fresh = await dbGetAsync('SELECT requester_notify_status, requester_notify_error FROM sys_issues WHERE id = ?', [id]);
      //   ⭐ 对抗审 F8：requester 是**唯一对业务方发声**的通道，"谁给业务方发了那条钉钉"正是 167 号 HIGH-2 的原问题。
      //   状态列会被后续轮次重置抹掉，故另落一条只增 timeline。收件人取快照优先（与实际发送口径同源）。
      await recordSysNotifyTimeline(id, '业务方',
        maskPhone(issue.requester_notify_phone_snapshot || issue.requester_phone || ''),
        fresh.requester_notify_status === 'sent', fresh.requester_notify_status === 'sent' ? 'ok' : (fresh.requester_notify_error || 'other'), actor);
      res.json({ id, requester_notify_status: fresh.requester_notify_status, requester_notify_error: fresh.requester_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知报障人失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知报障人失败' }); }
  });

  //   通知对接人受理（新，建单优化批 C1 §4 改动点2）：**权限分层语义（审 215 M-5）**——路由级
  //   requireAdmin 是唯一放行条件；handler 内 sysManualNotifyGuard(issue,'intake',actor) 只做业务
  //   校验（type 门限 fail-closed，内部仍判 isAdmin——本函数同时被 notify-read-status 复用，那个
  //   端点没有路由级 requireAdmin）。仅「待受理」态可发（sysNotifyStatusesFor 三 type 同值）。
  //   收件人解析（复审 M-1 收口 + codex 461a1e0 HIGH/MED 收口 + codex 221a HIGH 收口）：intake_liaison_id
  //   须命中 resolveActiveSysIntakeLiaisons() 当前 active 受理人集合才算"可用"——**为 NULL 的存量单**与
  //   **非空但已停用/被移出白名单的历史对接人**统一视为"当前无可达对接人"，走同一降级路径：仅当 active
  //   受理人恰好 1 人才降级发给该唯一成员（≠1 一律 409，0 人/多人两文案），且**降级解析成功即回写**
  //   intake_liaison_id（覆盖旧值，含 NULL 或已失效的旧 id——通知即指派语义，不依赖发送结果）。单列
  //   read_at/message_key 模型只支持单收件人，永不群发。
  //   ⚠️ 221a 之前 inactive 单独判 409 INTAKE_LIAISON_INACTIVE、文案让"先更正对接人"，但编辑白名单不含
  //   该字段、无任何修正入口，是无法自行走出的死局——现已与 NULL 分支合一，该错误码不再产出。
  router.post('/sys-issues/:id/notify-intake', authenticateToken, requireSysSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      const actor = sysActor(req);
      const intakeAuthErr = sysManualNotifyGuard(issue, 'intake', actor);
      if (intakeAuthErr) return res.status(intakeAuthErr.status).json(intakeAuthErr.body);
      const intakeStatuses = sysNotifyStatusesFor(issue.type, 'intake');
      if (!intakeStatuses.includes(issue.status)) return res.status(409).json({ error: `当前状态（${issue.status}）不可通知对接人受理`, code: 'STATUS_NOT_NOTIFIABLE' });

      // codex 审 461a1e0 HIGH 收口：常规路径与降级路径**共用同一次** resolveActiveSysIntakeLiaisons()
      //   调用（同源 helper，不许两条分支各判各的）——此前常规路径（intake_liaison_id 非空）完全绕开
      //   helper，只查 users 是否存在，未验证该人是否仍是当前 active 受理人（已停用/已被移出白名单的
      //   历史对接人仍会收到通知）。
      const activeLiaisons = await resolveActiveSysIntakeLiaisons();
      let targetLiaisonId = issue.intake_liaison_id;
      // ⭐⭐ codex 221a HIGH 收口（notify-intake 对接人失效死局修复）：intake_liaison_id 非空但不在当前
      //   active 受理人集合（已停用/被移出白名单）与 intake_liaison_id 为 NULL（存量单）统一视为
      //   "当前无可达对接人"同一语义——原实现把 inactive 单独判 409 INTAKE_LIAISON_INACTIVE、文案让
      //   "先更正对接人"，但编辑白名单不含该字段、无任何修正入口，是无法自行走出的死局。改为与 NULL
      //   分支合一：仅当 active 受理人恰好 1 人才降级发送 + 受控回写覆盖旧值（含 NULL 或已失效的旧
      //   id）；0 人/多人两分支沿用既有文案与错误码，不新增码。
      // ⭐ [C10-fix L3·核实非死分支·保留不清] 曾疑「候选池扩到 8 后 length===1 恒 false → =1 降级成死分支」，
      //   核实结论=**非死分支**：① 结构可达——恰 1 名 eligible active 受理人时 length===1 成立（生产 7/8 停用、
      //   或本地 harness 默认候选池就恒为单人[13]）；② verify-sys-intake-liaison [⑤=1]/[⑩①] 显式覆盖该路径
      //   （=1 → 200 sent + 通知即指派回写 13/13→14）。生产候选≥2 时 NULL/inactive 单确实恒落 length>1 →
      //   409「请先补录」，但那是**数据态**非**结构死**，自动填能力未消失。故本批保留、不改行为（清理会破坏上述两组）。
      const targetIsUsable = !!(targetLiaisonId && activeLiaisons.some(l => l.id === targetLiaisonId));
      if (!targetIsUsable) {
        if (activeLiaisons.length === 0) {
          return res.status(409).json({ error: '受理人配置异常，请联系管理员核查受理人账号状态', code: 'INTAKE_LIAISON_CONFIG_ERROR' });
        }
        if (activeLiaisons.length > 1) {
          return res.status(409).json({ error: '请先补录对接人', code: 'INTAKE_LIAISON_MISSING' });
        }
        const staleLiaisonId = targetLiaisonId;   // 读取时的原值：NULL（存量单）或已失效的旧 id（inactive）
        targetLiaisonId = activeLiaisons[0].id;
        // codex 审 461a1e0 MED 收口（221a 扩展覆盖 inactive 场景）：**通知即指派**——对接人归属在"降级
        //   解析出唯一候选"这一刻即确定，回写不依赖发送结果（即便本次 sendIssueDingtalkRaw 失败，
        //   intake_liaison_id 仍落库，重发会走命中集合的常规路径；read-status 从此也走常规
        //   intake_liaison_id 读取，不再空转降级判断）。守卫式 UPDATE（`WHERE intake_liaison_id IS ?`
        //   绑读取时原值——SQLite `IS` 绑 NULL 时精确匹配 NULL、绑非空值时等价 `=`，同一条语句覆盖
        //   NULL 与 inactive 两种"旧值"）防并发覆盖：若并发请求已先一步回写，本次 no-op（changes=0）。
        // ⚠️ codex 221a M-2 契约注明：inactive 与 NULL 同语义=当前无可达对接人；回写与发送同流，
        //   message_key 恒对应回写后的 liaison_id——read-status 查询自洽，无需额外收件人快照列。
        const claimRes = await dbRunAsync(`UPDATE sys_issues SET intake_liaison_id = ? WHERE id = ? AND intake_liaison_id IS ?`, [targetLiaisonId, id, staleLiaisonId]);
        // codex 复审 MED 收口：守卫 UPDATE no-op（changes=0）= 并发请求已先一步完成指派——通知必须发给
        //   「已被指派的那个人」而非本请求解析出的候选（两次解析之间 active 集合可能已变）。以库内值为准
        //   重读收敛，否则通知对象与库内指派可能指向两个人，破坏「通知即指派」一致性。
        if (!claimRes || claimRes.changes === 0) {
          const claimed = await dbGetAsync('SELECT intake_liaison_id FROM sys_issues WHERE id = ?', [id]);
          // codex 221 复审 MED 收口：重读值必须**再过一次 active 集合校验**才可采信——当前唯一写入口
          //   （本降级路径）写入的恒为写入时刻的 active 唯一人，但若未来新增维护入口/脚本直写出非白名单
          //   值，无此校验则 no-op 分支会成为 active 白名单的旁路（把通知发给库内非 active 用户）。
          //   不命中 → 409 请重试（fail-closed，不静默替换、不递归重解析）。
          if (claimed && claimed.intake_liaison_id && activeLiaisons.some(l => l.id === claimed.intake_liaison_id)) {
            targetLiaisonId = claimed.intake_liaison_id;
          } else {
            return res.status(409).json({ error: '对接人指派状态刚发生变化，请刷新后重试', code: 'INTAKE_LIAISON_CHANGED' });
          }
        }
      }
      // codex 221a M-1 变体裁定（竞态残余窗口注明，零行为改动）：状态校验（上方 intakeStatuses.includes）
      //   与本处发送/回写之间无事务终闸——与既有 5 类手动通知 helper（notify-developer/creator/
      //   requester/relay/release-executor）逐字一致的既定契约，非本次新增缺口。残余窗口：通知发送
      //   过程中单据被流转走（如恰好此时受理通过/退回修改），写回会落在新态上；这是自愈的——通知行
      //   仅在「待受理」态渲染（siRenderNotify 按 status 门控），回受理门（intake_return/reactivate）
      //   整组归零 intake 通知 5 列（SYS_CLEAR_INTAKE_NOTIFY_FIELDS_SQL），污染既不可见也不跨轮。
      const liaisonUser = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [targetLiaisonId]);
      if (!liaisonUser) return res.status(409).json({ error: '对接人用户不存在', code: 'INTAKE_LIAISON_NOT_FOUND' });

      const baseUrl = await getSafePlatformBaseUrl();
      const { title, md } = buildSysIntakeMarkdown(issue, baseUrl);
      const result = await sendIssueDingtalkRaw(liaisonUser, title, md);
      await recordSysIntakeNotify(id, !!result.ok, result.message_key, result.reason, actor.id);
      await recordSysNotifyTimeline(id, '对接人受理', `${liaisonUser.display_name || liaisonUser.username || ''}(id${targetLiaisonId})`, !!result.ok, result.ok ? result.message_key : result.reason, actor);
      const fresh = await dbGetAsync('SELECT intake_notify_status, intake_notify_error FROM sys_issues WHERE id = ?', [id]);
      res.json({ id, intake_notify_status: fresh.intake_notify_status, intake_notify_error: fresh.intake_notify_error });
    } catch (err) { logger.error('[系统迭代] 手动通知对接人受理失败:', err && err.message); res.status(500).json({ error: (err && err.message) || '通知对接人受理失败' }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 对接测试通知（工期对接测试与风险等级拆分 方案 v1.1 §6·C4b·D16/D19/D20）——预占协议两段式：
  //   preemptLiaisonTestNotifySend(id, expectedCycle)：短事务①，CAS 抢占 sending（不 begin/commit 暴露给
  //     调用方——本函数自成一个独立短事务，调用方按返回的 outcome 分流，never throws（底层 DB 异常除外）。
  //   writebackLiaisonTestNotify(id, token, ok, messageKey, error, sentBy)：短事务②，按 attempt_token 精确
  //     CAS 回写——token 不匹配（换代/被新预占覆盖）则 changes=0，调用方据此走"并发变更"分支，不静默覆盖。
  //   两函数之间（事务外）才允许调 sendIssueDingtalkRaw——与 release-executor §7b 现网范式（:9219/:9308）
  //   同构，唯一差异：本通道无独立 'stale' 枚举值（liaison_test_notify_status CHECK 仅 4 态），
  //   "sending 超窗恢复"改为方案 §6 冻结写法，直接内联进抢占 CAS 的 WHERE（非 release 那种独立惰性转换
  //   前置 pass），恢复窗口=10 分钟（方案逐字冻结，非 release 侧 5 分钟）。
  // ═══════════════════════════════════════════════════════════════════════════
  // [codex 276 号审 M-1] 外呼超时围栏——8 分钟 < 10 分钟 stale 恢复窗口：进程仍存活但外呼异常挂起时，
  //   主动判超时比等 10 分钟 stale 窗口被下一次点击顺带恢复更快、更可观测。
  // [codex 277 号审 H-1 收口] ⭐ 超时 ≠ 失败——这是本类判定的核心二分法（4 态 CHECK 已冻结，不新增第 5
  //   态区分"确定失败"与"结果未知"，改走这条 JS 层判别式）：
  //     · **确定失败**（send 函数同步/异步 reject 抛出真实错误，如钉钉侧返回明确失败）：这次调用**没有
  //       实际发出过消息**，回写 failed 允许立即重试是安全的。
  //     · **结果未知**（withTimeout 超时）：底层 sendIssueDingtalkRaw 这个 Promise **可能仍在飞**（进程
  //       没崩，只是我们等不及了主动放弃等待）——它随时可能在超时之后才真正成功。此时若回写 failed，
  //       用户会立即重试，一旦"迟到的成功"恰好发生在重试窗口内，就是**真实双发**（两条钉钉消息都送达）。
  //       故超时分支**不回写、保持 sending 不动**——10 分钟 stale 窗口是唯一合法的重试许可来源（等到那
  //       时原调用早该有结果了，晚成功大概率落在这 10 分钟窗内不会被覆盖；stale 窗口之后仍可能有极小
  //       概率的"超晚成功+窗后重试"双发残留，这是**下游无幂等键情况下的结构性极限**——彻底杜绝双发需要
  //       给 sendIssueDingtalkRaw 接一层幂等键或补一个异步对账任务核对钉钉侧实际投递记录，这是方案级的
  //       后续工作，本轮不做，仅挂账并在此注释披露）。
  //   用一个专用 Error 子类标记"这个 reject 来自超时包装器本身"，与"被包装的 promise 自己 reject"精确
  //   区分（不能用 message 文本匹配，那样太脆弱）。
  class NotifyTimeoutError extends Error {}
  function withTimeout(promise, ms, message) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new NotifyTimeoutError(message || `操作超时（${ms}ms）`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
  }
  // [codex 278 号审 M-4] 超时时长提为可注入的模块级变量（非 const）——生产默认 8 分钟；verify 测试通过
  // `_internals.setNotifyLiaisonTestTimeoutMsForTest(ms)`（见文件底部 _internals 导出）改成几十毫秒，
  // 使"超时命中"这条高风险分支能被自动化断言覆盖，不必真等 8 分钟。刻意不做成端点 body/query 可传参
  // （那样客户端就能自己决定超时时长，是一个不必要的滥用面——超时策略是服务端内部配置，不应由请求方
  // 控制）。
  let NOTIFY_SEND_TIMEOUT_MS = 8 * 60 * 1000;
  // [codex 276 号审 H-1 收口] 增参 expectedRecipientId——CAS WHERE 绑定当前请求解析出的收件人快照，
  //   杜绝"预占前解析出收件人 A，预占这一刻库里已被并发改成收件人 B，但 CAS 只判 cycle/status 未判
  //   recipient 而误把消息发给 A"的错发风险（收件人 A 已不是库内权威值，A 收到的通知与库内实际记录的
  //   收件人不一致）。claim 自愈仍发生在调用方解析阶段（预占前），语义不变——本函数只负责"预占时收件人
  //   是否仍等于解析时那一个"的围栏。
  // ⭐⭐⭐ [C10-fix3 HIGH·codex 319-R·纵深防御] 增参 expectedBoundId——CAS WHERE 再叠一条
  //   `AND intake_liaison_id = ?`（=调用方解析并校验过的当前绑定人 boundId），把「本次要发的收件人
  //   =当前绑定人」与「抢发送锁这一刻 DB 里绑定人仍=该值」两点锁进同一条原子 CAS，关闭"读绑定→取锁"
  //   之间的 TOCTOU 间窗。**纵深性质如实登记**：本模块当前**无 u5→u6 换对接人端点**（该端点缺失=已登记
  //   的 L2 缺口），到「待对接测试」态时 intake_liaison_id 早已绑定且此后无端点改它 ⇒ 本条 CAS 约束在
  //   现网**恒真、当前不可触发 no-op**；加它是为**防将来 L2 换对接人端点上线后**的并发改绑把消息发给
  //   旧对接人（越权知悉），非当前可触发 bug 的修复。并发改绑 → CAS changes=0 → 诊断重读判 binding_changed
  //   → 归入既有 CHANGED 分支（409 LIAISON_TEST_RECIPIENT_CHANGED），绝不沿用旧绑定人发送。
  async function preemptLiaisonTestNotifySend(id, expectedCycle, expectedRecipientId, expectedBoundId) {
    const newToken = crypto.randomBytes(16).toString('hex');
    await sysBeginImmediate();
    let cas;
    try {
      cas = await dbRunAsync(
        `UPDATE sys_issues SET liaison_test_notify_status = 'sending',
                liaison_test_attempt_token = ?, liaison_test_attempt_started_at = datetime('now','localtime')
          WHERE id = ? AND type = 'feature' AND status = '待对接测试'
            AND liaison_test_recipient_id = ?
            AND intake_liaison_id = ?
            AND (liaison_test_notify_status IN ('not_sent','failed')
                 OR (liaison_test_notify_status = 'sending' AND (liaison_test_attempt_started_at IS NULL
                      OR liaison_test_attempt_started_at <= datetime('now','localtime','-10 minutes'))))
            AND liaison_test_notify_cycle_no = ? AND liaison_test_cycle_no = ?`,
        [newToken, id, expectedRecipientId, expectedBoundId, expectedCycle, expectedCycle]
      );
      if (cas && cas.changes === 1) await sysCommit(); else await sysRollback();
    } catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
    if (!cas || cas.changes !== 1) {
      // 诊断性重读（同 release-executor §7b①失败分支范式，:9294-9298）——细分失败原因，不笼统一个 409。
      const fresh = await dbGetAsync(
        `SELECT status, type, liaison_test_notify_status AS ns, liaison_test_recipient_id AS rid,
                intake_liaison_id AS lid,
                liaison_test_notify_cycle_no AS ncn, liaison_test_cycle_no AS mcn, liaison_test_attempt_started_at AS sat
           FROM sys_issues WHERE id = ?`, [id]
      );
      if (!fresh) return { outcome: 'not_found' };
      if (fresh.type !== 'feature' || fresh.status !== '待对接测试') return { outcome: 'status_invalid', status: fresh.status };
      if (!fresh.rid) return { outcome: 'recipient_unavailable' };
      // [H-1] 现值 recipient≠本次请求解析时的快照——收件人已被并发改动（claim 自愈/换单等），
      //   本次预占绝不能沿用旧收件人发送，提示调用方刷新后按新收件人重新走一遍解析+预占。
      if (fresh.rid !== expectedRecipientId) return { outcome: 'recipient_changed' };
      // ⭐ [C10-fix3 HIGH·纵深｜C10-fix4 注释订正] 现值 intake_liaison_id≠调用方解析时的绑定人（boundId）——
      //   「读绑定→取锁」间被并发改绑（防 L2 换对接人端点未来上线；当前无该端点 ⇒ 现网恒不命中此分支）。
      //   与 recipient_changed 同归 CHANGED 语义：绝不沿用旧绑定人发送，提示刷新后按新绑定重走解析+预占。
      //   ⚠️ [C10-fix4·codex 319-R2 MED 订正] 上方 preempt SQL 的 `AND intake_liaison_id = ?` 是**无条件**子句，
      //     bind expectedBoundId——故 expectedBoundId **必传**（本函数全仓唯一调用点传的是发送路径解析出的
      //     boundId，恒非空）。若省略（传 undefined/null），SQL 层 `intake_liaison_id = NULL` 恒不匹配任何非
      //     NULL 值 ⇒ CAS 必落空，**不是「跳过判据不影响既有行为」**（原注释此说失实，已删）。本诊断层的
      //     `!= null` 守卫只是与 SQL 层同源的防御，正常四参数调用下恒进入比较。类型两侧 Number 归一，防
      //     DB 返回数字、调用方传字符串时的虚假 binding_changed（codex 319-R2 LOW）。
      if (expectedBoundId != null && Number(fresh.lid) !== Number(expectedBoundId)) return { outcome: 'binding_changed' };
      if (fresh.ncn !== expectedCycle || fresh.mcn !== expectedCycle) return { outcome: 'cycle_mismatch' };
      if (fresh.ns === 'sent') return { outcome: 'already_sent' };
      if (fresh.ns === 'sending') return { outcome: 'sending_in_progress' };
      return { outcome: 'cas_conflict' };
    }
    return { outcome: 'preempted', token: newToken };
  }
  async function writebackLiaisonTestNotify(id, token, ok, messageKey, error, sentBy) {
    const sb = assertNotifySentBy('writebackLiaisonTestNotify', sentBy);
    const nowRow = ok ? await dbGetAsync(`SELECT datetime('now','localtime') AS n`) : null;
    const notifiedAt = ok ? (nowRow && nowRow.n) : null;
    await sysBeginImmediate();
    let w;
    try {
      w = await dbRunAsync(
        `UPDATE sys_issues SET liaison_test_notify_status = ?, liaison_test_attempt_token = NULL, liaison_test_attempt_started_at = NULL,
                liaison_test_notified_at = ?, liaison_test_notify_message_key = ?, liaison_test_notify_error = ?,
                liaison_test_read_at = NULL, liaison_test_notify_sent_by = ?
          WHERE id = ? AND liaison_test_notify_status = 'sending' AND liaison_test_attempt_token = ?`,
        [ok ? 'sent' : 'failed', notifiedAt, ok ? messageKey : null, ok ? null : (error || 'other'), sb, id, token]
      );
      if (w && w.changes === 1) await sysCommit(); else await sysRollback();
    } catch (e) { try { await sysRollback(); } catch (_) { /* ignore */ } throw e; }
    return w;
  }
  // [S12 双路审查 codex 287 号 M-1 收口] ⭐ 已接受的既有语义（登记，非缺陷）——liaison_test_pass/
  //   liaison_test_return/void 与上面这套预占/回写协议之间**从无任何互斥闸门**：sending 态的通知仍在飞
  //   （preempt 已抢占 attempt_token，sendIssueDingtalkRaw 尚未返回）时若恰好有人点了「通过」/「打回」/
  //   「作废」，主状态照常原子推进（下方 case 'liaison_test_pass'/'liaison_test_return' 从不读取
  //   liaison_test_notify_status），sending 态会被留在主表上，直到这次 send 真正 resolve 才由
  //   writebackLiaisonTestNotify 收尾——届时主状态可能早已不是「待对接测试」。这不是漏做互斥，是三点
  //   合起来认定"没必要做"：
  //   ① 上面 writebackLiaisonTestNotify 的 CAS WHERE 只认 liaison_test_notify_status='sending' AND
  //     liaison_test_attempt_token=?（:11260），完全不校验 status/type——主状态早走远了，迟到的回写
  //     照样精确落到自己那一行（token 是唯一凭证，不会因主状态变了就 changes=0，不会误伤/不会落空）；
  //   ② liaison_test_notify_* 整组列是审计/展示信息，从不是任何闸门的前置条件（没有代码读它来决定
  //     能不能 pass/return/void），主状态推进与通知记录本就允许"错峰"、互不阻塞；
  //   ③ 真要加互斥，得在 pass/return/void 每条边前插一次额外 SELECT+可能的 409，换来的是"必须等通知
  //     发完才能操作"这种真实业务里没人要的强绑定——用户点了通过就该立刻通过，不该被一条正在飞的
  //     钉钉消息卡住。三条合起来=纯粹的信息滞后（等 send 真正 resolve 后 sending 行自己会翻正确终态：
  //     sent/failed），非状态腐化、非数据不一致、非需要补的闸门。
  //   verify-sys-liaison-test.js 有专门契约测试（标记 [E-race]）实测：sending 中途 pass/return 均 200
  //   成功不被阻塞，且晚到的 writeback 仍能精确落回那条已"过时"的通知记录，与已推进的主状态互不干扰、
  //   互不覆盖（dormant sent 数据与 advanced 主状态共存，非冲突）。

  // ── POST /sys-issues/:id/notify-liaison-test（新，方案 v1.1 §6·C4b）：开发/admin 手动通知对接人来测 ──
  //   D19：触发者=本单在册开发∨admin（assertLiaisonTestNotifyActor，非 sysManualNotifyGuard 的池∨admin
  //   口径）；收件人=操作者本人 → 403 SELF_NOTIFY_FORBIDDEN（对齐 developer 通道既有先例 :10138）。
  //   D20：预占前先做 recipient 快照失效自愈（复用 codex 221a claim 范式，逐字同构 notify-intake :10982+
  //   仅列名替换 intake_liaison_id→liaison_test_recipient_id）。
  //   D16：dry-run——system_configs.sys_notify_dry_run='on' 时完整走 CAS+留痕，唯独跳过真实
  //   sendIssueDingtalkRaw 调用（message_key 写 'dryrun-'+时间戳标记）。⚠️ 本地/生产观察期共用同一
  //   开关——生产若临时开启做观察，观察结束务必手动清空/写回非 'on' 值，否则会静默吞掉该通道全部真实钉钉通知
  //   （无独立的"生产禁用"硬闸，纯约定，用户已知悉此风险）。响应/行内展示带演练标记（dry_run 字段+
  //   message_key 前缀），供前端与运维一眼区分本次是否真实发出。
  router.post('/sys-issues/:id/notify-liaison-test', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    try {
      const issue = await dbGetAsync('SELECT * FROM sys_issues WHERE id = ?', [id]);
      if (!issue) return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
      if (issue.type !== 'feature') return res.status(409).json({ error: '仅变更流(feature)支持对接测试通知', code: 'LIAISON_TEST_NOTIFY_TYPE_NA' });
      if (!SF.isInFamily(issue.type, issue.status, 'LIAISON_TEST')) {
        return res.status(409).json({ error: `当前状态（${issue.status}）不可通知对接人测试`, code: 'STATUS_NOT_NOTIFIABLE' });
      }
      const actor = sysActor(req);
      // [282 号复审 N3 登记] 授权检查与预占 CAS 之间存在毫秒级 TOCTOU 窗口（成员被移出后已过检的
      // 请求仍可完成预占）——明确接受的遗留中风险：窗口极短、消息内容与操作者身份无关、audit sent_by
      // 实名可追、与现网其他通道（无 CAS）同水位；机制闭合需 CAS 加 EXISTS 在册子查询，热路径复杂度不值。
      try {
        await assertLiaisonTestNotifyActor(actor, id);
      } catch (guardErr) {
        if (guardErr instanceof SysTransitionError) return res.status(guardErr.httpStatus).json({ error: guardErr.message, code: guardErr.code });
        throw guardErr;
      }
      const expectedCycle = parsePositiveId((req.body || {}).expected_cycle);
      if (!expectedCycle) return res.status(400).json({ error: '缺少 expected_cycle', code: 'EXPECTED_CYCLE_REQUIRED' });

      // D20 claim 自愈：与 notify-intake :10982-11024 逐字同构（仅列名换成 liaison_test_recipient_*）。
      const activeLiaisons = await resolveActiveSysIntakeLiaisons();
      let targetRecipientId = issue.liaison_test_recipient_id;
      const boundId = issue.intake_liaison_id;
      // ⭐⭐⭐ [C10-fix2 HIGH-1·收件人可用判据加「等于当前绑定人」] 原判据只看"旧收件人仍在 active 候选池"，
      //   **漏判"是否仍等于本单当前 intake_liaison_id"**——触发路径：单原绑 u5（liaison_test_recipient_id 已写
      //   u5）→ 改绑 u6，只要 u5 仍 active eligible 就会判 usable=true → 跳过自愈继续发 u5 = **通知发给已失去
      //   该单对接资格的旧对接人（越权知悉）**。故收件人"可用"须同时满足：非空 ∧ **等于当前绑定人 boundId** ∧
      //   该绑定人仍在 active 候选池（eligible）。三者任一不满足 → 进自愈块把收件人 CAS 改为当前绑定人。
      const targetIsUsable = !!(
        targetRecipientId && boundId != null &&
        Number(targetRecipientId) === Number(boundId) &&
        activeLiaisons.some(l => l.id === targetRecipientId)
      );
      if (!targetIsUsable) {
        // ⭐⭐⭐ [C10·决策1] 自愈目标 = **该单 intake_liaison_id 绑定对接人**——不再是"候选池唯一成员"（那是
        //   SYS_INTAKE_LIAISON_IDS=[13] 单例池假设，候选池扩大后 ≥2 恒 409 AMBIGUOUS）。这不是"挑对接人"而是
        //   "发给本单对接人"，清晰无歧义（同裁定4/决策1 口径）。原 0/>1/==1 三分支整体删除。
        const boundLiaison = boundId ? activeLiaisons.find(l => l.id === boundId) : null;
        if (!boundLiaison) {
          // 绑定对接人为空（存量空单）或已失效（停用/移出候选）→ **不发 + logger.warn 诚实降级**（决策4），
          //   **不回退候选池**（回退会把"你的单要做对接测试了"发给与本单无关的人，违绑单语义）。
          logger.warn(`[系统迭代] 对接测试通知降级：单 ${id} 无有效绑定对接人（intake_liaison_id=${boundId == null ? 'NULL' : boundId}），不发送`);
          return res.status(409).json({ error: '本单无有效对接人（未绑定或已失效），无法发送对接测试通知', code: 'LIAISON_TEST_RECIPIENT_UNBOUND' });
        }
        const staleRecipientId = targetRecipientId;
        targetRecipientId = boundLiaison.id;
        // [codex 277/278 号审 M-1] sending 期间收件人锁定——`AND liaison_test_notify_status IS NOT
        //   'sending'`：若此刻已有另一请求持有预占权（正在外呼/等待回写），claim 自愈不得在半途把收件人
        //   换掉——那样"正在飞的那条消息是发给谁"与"库内最新收件人"就对不上了。锁定期间本守卫式 UPDATE
        //   直接 changes=0（不生效），走下方既有的"claim 未成功→重读判定"分支；并发的另一请求自己的
        //   preempt CAS 也会因 liaison_test_notify_status='sending' 未超窗而正常拿到 409
        //   SENDING_IN_PROGRESS，两边行为自洽。⭐ 278 号收口：`!=` 改 `IS NOT`——该列有
        //   `NOT NULL DEFAULT 'not_sent'` 约束，NULL 结构性不可达，两种写法在本列上行为逐字等价，
        //   改用 `IS NOT` 纯粹是更稳的 SQL 惯用法（NULL 语义天然正确，零功能变化、零成本）。
        const claimRes = await dbRunAsync(
          `UPDATE sys_issues SET liaison_test_recipient_id = ?, liaison_test_recipient_name = ? WHERE id = ? AND liaison_test_recipient_id IS ? AND liaison_test_notify_status IS NOT 'sending'`,
          [targetRecipientId, boundLiaison.name, id, staleRecipientId]
        );
        if (!claimRes || claimRes.changes === 0) {
          const claimed = await dbGetAsync('SELECT liaison_test_recipient_id FROM sys_issues WHERE id = ?', [id]);
          // ⭐ [C10-fix2 HIGH-1] 重读采信收窄：并发已写入的收件人必须**等于当前绑定人 boundLiaison.id**才可采信
          //   （原判据"在 active 池即采信"会在 sending 锁 no-op 时把 stale 旧收件人重新采信 → 复现"发给旧对接人"
          //   越权）。等于绑定人 = 并发请求已把收件人自愈成同一目标（合法）；不等 = 收件人仍 stale/被改到别人，
          //   fail-closed 409 让调用方刷新后重走解析（不静默沿用旧收件人）。
          if (claimed && Number(claimed.liaison_test_recipient_id) === Number(boundLiaison.id)) {
            targetRecipientId = claimed.liaison_test_recipient_id;
          } else {
            return res.status(409).json({ error: '对接测试收件人状态刚发生变化，请刷新后重试', code: 'LIAISON_TEST_RECIPIENT_CHANGED' });
          }
        }
      }
      // D19 自指硬守卫：收件人解析确定后才判——顺序对齐 notify-developer :10557（先确认目标有效，再判自指）。
      if (Number(targetRecipientId) === Number(actor.id)) {
        return res.status(403).json({ error: '不能给自己发送通知', code: 'SELF_NOTIFY_FORBIDDEN' });
      }
      const recipientUser = await dbGetAsync('SELECT id, display_name, phone, dingtalk_user_id FROM users WHERE id = ?', [targetRecipientId]);
      if (!recipientUser) return res.status(409).json({ error: '对接测试收件人不存在', code: 'LIAISON_TEST_RECIPIENT_NOT_FOUND' });

      // [codex 276 号审 H-1] CAS 绑定本次请求解析出的收件人快照（targetRecipientId）——预占成功后
      //   发送沿用同一份 recipientUser（已在上方解析，不二次读库）；预占时若库内现值已不是这个收件人
      //   （并发被 claim/换单改动），CAS 直接落空，诊断分支细分出 'recipient_changed'。
      // ⭐ [C10-fix3 HIGH·纵深] 第 4 参 boundId——发送路径下 targetRecipientId 恒 === boundId（收件人已在
      //   上方自愈/校验为当前绑定人），CAS 用它再叠 `AND intake_liaison_id = boundId`，抢锁瞬间原子确认绑定
      //   未被并发改动（防 L2 换对接人端点上线；当前无该端点 ⇒ 恒真不 no-op）。改绑并发 → CAS 落空 →
      //   'binding_changed' → 409 CHANGED，不发旧对接人。
      const preempt = await preemptLiaisonTestNotifySend(id, expectedCycle, targetRecipientId, boundId);
      switch (preempt.outcome) {
        case 'not_found': return res.status(404).json({ error: '迭代单不存在', code: 'SYS_ISSUE_NOT_FOUND' });
        case 'status_invalid': return res.status(409).json({ error: `当前状态（${preempt.status}）不可通知对接人测试`, code: 'STATUS_NOT_NOTIFIABLE' });
        case 'recipient_unavailable': return res.status(409).json({ error: '对接测试收件人暂不可用，请重试', code: 'LIAISON_TEST_RECIPIENT_UNAVAILABLE' });
        case 'recipient_changed': return res.status(409).json({ error: '对接测试收件人状态刚发生变化，请刷新后重试', code: 'LIAISON_TEST_RECIPIENT_CHANGED' });
        // ⭐ [C10-fix3 HIGH·纵深] binding_changed 归入既有 CHANGED 分支（同码 LIAISON_TEST_RECIPIENT_CHANGED，
        //   前端 siApiErr 按 code 统一"刷新后重试"提示，不新增消费面），仅文案区分便于日志观测。
        case 'binding_changed': return res.status(409).json({ error: '本单对接人绑定刚发生变化，请刷新后重试', code: 'LIAISON_TEST_RECIPIENT_CHANGED' });
        case 'cycle_mismatch': return res.status(409).json({ error: '测试周期已变化，请刷新后重试', code: 'LIAISON_TEST_CYCLE_MISMATCH' });
        case 'already_sent': return res.status(409).json({ error: '本轮通知已发送', code: 'LIAISON_TEST_NOTIFY_ALREADY_SENT' });
        case 'sending_in_progress': return res.status(409).json({ error: '已有发送在途，请稍候', code: 'LIAISON_TEST_NOTIFY_SENDING_IN_PROGRESS' });
        case 'cas_conflict': return res.status(409).json({ error: '通知状态已并发变更，请重试', code: 'LIAISON_TEST_NOTIFY_CAS_CONFLICT' });
        default: break;   // 'preempted' → 往下走事务外通知
      }

      // [codex 276 号审 M-1] 预占成功到回写之间（readSystemConfig/getSafePlatformBaseUrl/buildMarkdown/
      //   外呼本身）整段包专用 try/catch——进程仍存活时没理由让这次尝试悬在 'sending' 里等 10 分钟
      //   stale 窗口才被下一次点击顺带恢复（用户会在这 10 分钟内反复撞「已有发送在途」的死按钮）。
      // [codex 278 号审 H-1 分类结论] 复核 sendIssueDingtalkRaw 实现（server.js:11937-11990）：其内部对
      //   全部"下游明确拒绝"场景（钉钉配置缺失/收件人无手机号/getAccessToken 失败/getUserIdByMobile
      //   失败/sendIssueMarkdown 返回 success=false/message_key 缺失）统统走返回值协议
      //   `{ok:false, reason}`（各自已有内部 try/catch，从不因这些确定性失败 throw）——这些场景走
      //   `sendResult.ok===false` 分支（下方 writebackLiaisonTestNotify 正常传 ok=false，非本 catch
      //   块职责）。会真正落进本 catch 块的只有两类，且**均无法证明消息未曾送达**：
      //     ① withTimeout 自己的超时（NotifyTimeoutError）；
      //     ② server.js:11966 首次 `issueNotify.sendIssueMarkdown()` 调用本身抛出——这是
      //        sendIssueDingtalkRaw 全函数体内唯一未包 try/catch 的外呼点，统一 throw、不带"钉钉是否
      //        已收到"的分类信息。
      //   故用 `reachedExternalCall` 标记精确区分两类异常源头：外呼开始前（dry-run 判断/baseUrl 读取/
      //   markdown 构建，均为本地操作，无网络副作用）的异常 = **确定失败**，回写 failed 允许立即重试；
      //   外呼过程中（含上述①②两种情形）的异常 = **结果未知**，不回写、保持 sending，10 分钟 stale
      //   窗口是唯一合法重试许可来源。
      // [codex 278 号审 H-2 定性封口] 本通道投递语义正式定性为**至少一次**——与全平台既有六个钉钉通知
      //   通道同一水位（业务代价=收件人偶尔收到重复提醒，可接受，非本通道独有的新风险）。stale 窗口后
      //   的"超晚成功+窗后重试"极小概率双发残留，按此定性**不再挂账等待另立机制**——恰好一次投递需要
      //   下游接一层幂等键或补一个异步对账任务核对钉钉侧实际送达记录，这是独立的方案级工作，与本通道
      //   当前"至少一次"的既定水位无关，不在此实现。
      let sendResult;
      let reachedExternalCall = false;
      try {
        // D16 dry-run：仅跳过真实外呼，CAS+留痕全走。
        const dryRunRaw = await readSystemConfig('sys_notify_dry_run');
        const dryRunNorm = String(dryRunRaw || '').trim().toLowerCase();
        // [281 号对抗审 R7 部分采纳，282 号复审 LOW 修正措辞] 配置值非空但既不是 'on' 也不是 'off'
        // （已 trim().toLowerCase() 归一化后仍非法，如误填 'y'/'true'/'onn'）——fail-open 语义本身
        // 不改（缺键/怪值一律按真发处理，方向对齐生产预期），只在日志侧留痕提醒，便于运维发现疑似
        // 笔误，别真以为开着 dry-run 观察结果发现全是真实钉钉。
        if (dryRunRaw && !['on', 'off', ''].includes(dryRunNorm)) {
          logger.warn(`[系统迭代] notify-liaison-test: sys_notify_dry_run 配置值疑似笔误（实际值=${JSON.stringify(dryRunRaw)}，非 on/off/空），本次按真发处理：issue=${id}`);
        }
        const isDryRun = dryRunNorm === 'on';
        if (isDryRun) {
          sendResult = { ok: true, dry_run: true, message_key: `dryrun-${Date.now()}` };
        } else {
          const baseUrl = await getSafePlatformBaseUrl();
          const { title, md } = buildSysLiaisonTestMarkdown(issue, baseUrl);
          reachedExternalCall = true;
          sendResult = await withTimeout(sendIssueDingtalkRaw(recipientUser, title, md), NOTIFY_SEND_TIMEOUT_MS, '钉钉发送超时');
        }
      } catch (sendErr) {
        if (reachedExternalCall) {
          // 结果未知（超时 或 sendIssueDingtalkRaw 唯一未分类的裸抛）——不回写，保持 sending。
          const isTimeout = sendErr instanceof NotifyTimeoutError;
          const kind = isTimeout ? '超时' : '未分类异常（sendIssueDingtalkRaw 内部裸抛，server.js:11966 未包裹）';
          logger.error(`[系统迭代] notify-liaison-test 外呼${kind}（结果未知，保持 sending 不回写）：issue=${id} token=${preempt.token} err=${sendErr && sendErr.message}`);
          // [codex 278 号审 M-2] stale_at：本次预占的 attempt_started_at + 10 分钟——直接读回 DB 刚落的
          // 权威值（而非 JS 侧 Date.now() 近似），避免与 SQLite datetime('now','localtime') 的潜在毫秒级
          // 误差；纯提示用途，权威判定仍在后端 CAS。
          // [codex 279 号审 M-1 收口] 这段查询+日期换算是**辅助信息**，它自己失败绝不能连累核心响应语义
          // （504 + 结果未知码这件事本身必须照常发生）——单独包 try/catch，失败只 log，staleAt 留 null。
          let staleAt = null;
          try {
            const staleRow = await dbGetAsync('SELECT liaison_test_attempt_started_at AS sat FROM sys_issues WHERE id = ?', [id]);
            if (staleRow && staleRow.sat) {
              const d = new Date(String(staleRow.sat).replace(' ', 'T'));
              if (!isNaN(d.getTime())) {
                d.setMinutes(d.getMinutes() + 10);
                const p = n => String(n).padStart(2, '0');
                staleAt = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
              }
            }
          } catch (staleErr) {
            logger.error(`[系统迭代] notify-liaison-test 计算 stale_at 失败（不影响主响应，照常返回 504）：issue=${id} err=${staleErr && staleErr.message}`);
          }
          // [codex 279 号审 L-1] 独立错误码——超时命中 vs 外呼函数本身裸抛，响应语义/重试策略完全相同
          // （同 504、同「10 分钟后可重试」文案），仅 code 不同，便于前端/运维日志区分两种触发源。
          return res.status(504).json({
            error: '通知发送结果未知（外呼异常），自本次发送开始满 10 分钟后可重试',
            code: isTimeout ? 'LIAISON_TEST_NOTIFY_TIMEOUT' : 'LIAISON_TEST_NOTIFY_RESULT_UNKNOWN',
            stale_at: staleAt,
          });
        }
        // 确定失败（还未触达外呼这一步就已异常——dry-run 判断/baseUrl 读取/markdown 构建阶段的本地
        // 异常，均无网络副作用）：这次调用 100% 没有实际发出过消息，回写 failed 允许立即重试是安全的。
        const truncatedMsg = String((sendErr && sendErr.message) || sendErr || 'unknown').slice(0, 200);
        try {
          await writebackLiaisonTestNotify(id, preempt.token, false, null, truncatedMsg, actor.id);
        } catch (writebackErr) {
          logger.error(`[系统迭代] notify-liaison-test 异常回写 failed 也失败：issue=${id} writebackErr=${writebackErr && writebackErr.message}`);
        }
        throw sendErr;
      }

      // [codex 277 号审 H-2] 最终回写保护——此刻 sendResult 已是既成事实（sendResult.ok===true 时钉钉
      //   消息确实已经发出）。writebackLiaisonTestNotify 内部自身的 try/catch 只处理"CAS no-op"
      //   （changes!==1，下方已有 concurrent_changed 分支），但如果它**直接抛出真实异常**（DB 连接抖动/
      //   busy 超时等瞬时故障），绝不能让这个异常原样冒泡到外层变成"通知失败"的 500——那会诱导用户看到
      //   报错后重新点击发送，而这次外呼其实已经成功，重发=真实双发。策略：失败重试一次（多数瞬时故障
      //   重试即可恢复）；仍失败则**响应 200 + writeback_failed:true 警示**（绝不能诱导重发），完整 error
      //   log 供运维核实。
      // [codex 278 号审 H-2 定性封口] ⚠️ 两次都失败后，该行会残留在 'sending' 态，只能靠 10 分钟 stale
      //   窗口或人工介入恢复——stale 窗口重发若与"迟到的原始成功"重叠，会产生极小概率的重复投递。
      //   **本通道投递语义已正式定性为至少一次**（与全平台既有六个钉钉通知通道同一水位：收件人偶尔
      //   收到重复提醒，业务代价可接受，非本通道独有的新风险）。恰好一次投递需要下游幂等键/投递账本
      //   （对账任务核对钉钉侧实际送达记录），这是独立于本通道的方案级工作——按既定"至少一次"水位，
      //   不再为这条 stale 窗后残留路径新增机制，到此封口。
      let writeback;
      try {
        writeback = await writebackLiaisonTestNotify(id, preempt.token, !!sendResult.ok, sendResult.message_key, sendResult.reason, actor.id);
      } catch (writebackErr1) {
        logger.error(`[系统迭代] notify-liaison-test 结果回写异常（第 1 次），重试一次：issue=${id} sendOk=${!!sendResult.ok} err=${writebackErr1 && writebackErr1.message}`);
        try {
          writeback = await writebackLiaisonTestNotify(id, preempt.token, !!sendResult.ok, sendResult.message_key, sendResult.reason, actor.id);
        } catch (writebackErr2) {
          logger.error(`[系统迭代] notify-liaison-test 结果回写连续两次异常，判定回写失败（该行将残留 sending，需人工核实/等 stale 窗恢复）：issue=${id} sendOk=${!!sendResult.ok} messageKey=${sendResult.message_key || ''} err1=${writebackErr1 && writebackErr1.message} err2=${writebackErr2 && writebackErr2.message}`);
          try {
            // [282 号复审 HIGH·N1 收口] channel 按 dry_run 分叉——timeline summary 因此变成「发送
            // 对接测试演练通知 → 谁：成功（message_key=dryrun-...）」，审计读者不会把"成功"误读成
            // 真实外呼成功。action_code 仍保持 'notify_sent' 不动（无 DDL CHECK，但不新增枚举值，
            // 避免下游消费者面）。
            await recordSysNotifyTimeline(id, sendResult.dry_run ? '对接测试演练' : '对接测试',
              `${recipientUser.display_name || recipientUser.username || ''}(id${targetRecipientId})`,
              !!sendResult.ok, sendResult.ok ? sendResult.message_key : sendResult.reason, actor);
          } catch (tlErr) { logger.warn(`[系统迭代] notify-liaison-test 回写失败后补 timeline 也失败：issue=${id} err=${tlErr && tlErr.message}`); }
          return res.json({
            // [281 号对抗审 N1 采纳，282 号复审 MED 补净] dry-run 下从未真实外呼钉钉——sent_externally
            // 必须落 false，否则违反 279 号已定的契约（true=已真实发出）。dry_run 字段同时回传供前端
            // 区分文案；error 文案本身也按 dry_run 分叉，不再出现"可能已发出"这类对演练场景失实的措辞。
            id, writeback_failed: true, sent_externally: !!sendResult.ok && !sendResult.dry_run,
            dry_run: !!sendResult.dry_run,
            error: sendResult.dry_run
              ? '演练回写失败（未真实外呼钉钉），发送状态将于约 10 分钟后自动恢复，届时可重试或联系管理员'
              : '通知可能已发出，但结果回写失败，请勿重复点击发送，请联系管理员核实',
          });
        }
      }
      await recordSysNotifyTimeline(id, sendResult.dry_run ? '对接测试演练' : '对接测试',
        `${recipientUser.display_name || recipientUser.username || ''}(id${targetRecipientId})`,
        !!sendResult.ok, sendResult.ok ? sendResult.message_key : sendResult.reason, actor);
      if (!writeback || writeback.changes !== 1) {
        logger.warn(`[系统迭代] notify-liaison-test 结果回写被 CAS 拒绝（并发变更）：issue=${id}`);
        const fresh = await dbGetAsync('SELECT liaison_test_notify_status AS ns FROM sys_issues WHERE id = ?', [id]);
        // [282 号复审 MED 补净] 补 dry_run 字段——与其余响应形状一致，前端/运维不必靠猜测判断这一次
        // 并发冲突发生在演练态还是真发态。
        return res.json({ id, concurrent_changed: true, liaison_test_notify_status: fresh ? fresh.ns : null, dry_run: !!sendResult.dry_run });
      }
      const fresh = await dbGetAsync(
        `SELECT liaison_test_notify_status, liaison_test_notify_error, liaison_test_recipient_id, liaison_test_recipient_name
           FROM sys_issues WHERE id = ?`, [id]
      );
      res.json({
        id, liaison_test_notify_status: fresh.liaison_test_notify_status, liaison_test_notify_error: fresh.liaison_test_notify_error,
        liaison_test_recipient_id: fresh.liaison_test_recipient_id, liaison_test_recipient_name: fresh.liaison_test_recipient_name,
        dry_run: !!sendResult.dry_run,
      });
    } catch (err) {
      if (err instanceof SysTransitionError) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
      logger.error('[系统迭代] 通知对接测试失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '通知对接测试失败' });
    }
  });

  // ── GET /sys-issues/:id/notify-read-status（新，通知改造 C3 G11）：byId(dev/relay/creator)+byPhone(requester) 双寻址 ──
  //   复刻 issue-tracker /api/issues/:id/notify-read-status 范式（server.js:11552，token 重试+已读固化写回）。
  //   dev 定位子表活动行（?dev_user_id=）；relay/creator 走 sys_issues 反规范化列；requester 走收件人快照反查。
  //   ⚠️ [2026-07-30 家族封禁后·codex 208 审 HIGH-1 定位] type=release_executor 分支保留（读+已读固化回写
  //   release_assignee_read_at）——这是 release_assignee_* 8 列在家族封禁后的**唯一残留写点**：仅对历史
  //   sent+message_key 数据可达（发送写路径已全封 ⇒ 生产 0 行永不满足前置），前端触发点已删，仅剩直打 API；
  //   语义是"固化钉钉已读事实"的读侧缓存，非业务状态变更，故保留不封。
  // [M-1 收口·codex40] 权限闸：原仅 authenticateToken，任意登录用户可探任意单四侧通知触达/已读时间（越权泄露）。
  //   in-handler 检查（非中间件）：本端点是**多通道复用**的（?type=dev|relay|creator|requester|release_executor），
  //   各通道授权面不同（前三 = admin∨受理人 / 后两 = 仅 admin），中间件层表达不了逐通道差异，故在 handler 内
  //   按 query.type 映射到发送侧同一个 sysManualNotifyGuard（写读同源·C2a·H3 已一并删除「主开发本人」放权）。
  router.get('/sys-issues/:id/notify-read-status', authenticateToken, requireSysSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的迭代单 ID', code: 'INVALID_SYS_ISSUE_ID' });
    const type = req.query.type;
    if (!['dev', 'relay', 'creator', 'requester', 'release_executor', 'intake'].includes(type)) {
      return res.status(400).json({ error: '无效的通知类型', code: 'INVALID_NOTIFY_TYPE' });
    }
    // ⚠️ 单据存在性预言机防线（C1 三轮审 MED-1·与 notify-creator 补挂中间件同构）：本端点的授权原本**全部**在
    //   issue 加载之后，于是未授权者打不存在的 id 得 404、打存在的 id 得 403 —— 可据此枚举真实单号。
    //   这里前置一道**静态角色粗筛**：它只用 JWT 身份 + query 通道，不需要 issue 上下文，因此能放到查库之前，
    //   让"存在"与"不存在"对未授权者一律 403。
    //   ⚠️ 放行面必须与下方 sysManualNotifyGuard / release_executor 分支**逐通道等价**（改一处必同步另一处）：
    //     dev / creator / requester = admin ∨ 受理人[13]；relay / release_executor / intake = 仅 admin
    //     （建单优化批 C1：intake 通道镜像 relay/release_executor，同为仅 admin）。
    //   精判（issue.type 门限 / 通道 NA / 状态 / 收件人快照）仍由 issue 加载后的 guard 承担——本层只回答
    //   "这个角色连这个通道都碰不到吗"，不回答"这张单此刻能不能查"。错误码沿用 NOT_AUTHORIZED_FOR_NOTIFY 不变。
    {
      const preActor = sysActor(req);
      const preAdminOnly = (type === 'relay' || type === 'release_executor' || type === 'intake');
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
      const rsChannelMap = { dev: 'developer', relay: 'relay', creator: 'creator', requester: 'requester', intake: 'intake' };
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
      } else if (type === 'intake') {
        notifyStatus = issue.intake_notify_status; messageKey = issue.intake_notify_message_key; readAt = issue.intake_read_at;
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
        // intake：uid 取 issue.intake_liaison_id——为 NULL 的存量单（发送时曾走 §4 降级发送）此处不
        //   重新推导 fallback，直接落 uid=null → 下方 dingtalk_user_id 查无该行 → recipientDingUid=''
        //   → 走既有 recipient_unresolved 分支（同"无 dingtalk_user_id"降级路径，不新增分支）。
        const uid = type === 'dev' ? devUserId
          : (type === 'relay' ? issue.relay_notified_user_id
          : (type === 'release_executor' ? issue.release_assignee_id
          : (type === 'intake' ? issue.intake_liaison_id
          : issue.created_by)));
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
          const col = type === 'relay' ? 'relay_read_at'
            : (type === 'creator' ? 'creator_read_at'
            : (type === 'release_executor' ? 'release_assignee_read_at'
            : (type === 'intake' ? 'intake_read_at'
            : 'requester_read_at')));
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
    // [codex 278 号审 M-4] notify-liaison-test 外呼超时时长——生产默认 8 分钟（NOTIFY_SEND_TIMEOUT_MS
    //   闭包变量），仅供 verify 测试改成几十毫秒以自动化覆盖"超时命中"这条高风险分支；不暴露为端点
    //   可传参（超时策略是服务端配置，不应由请求方控制）。
    setNotifyLiaisonTestTimeoutMsForTest: (ms) => { NOTIFY_SEND_TIMEOUT_MS = ms; },
    // 角色权限重构 C0：受理态一致性触发器（供 verify 临时摘除后按原样重建·防两处 DDL 漂移）
    SYS_INTAKE_GATE_TRIGGERS_SQL,
    SYS_INTAKE_GATE_TRIGGER_NAMES,
    // 角色权限重构 C1：手动通知授权守卫（verify 直调做通道白名单 fail-closed 单元断言）
    sysManualNotifyGuard,
    // 角色权限重构 C2a：物删审计表锚点
    SYS_DELETE_AUDIT_KEY_COLS,
    // 角色权限重构 C2b：**三个测试专用导出** = 契约守卫 assertNotifySentBy + 两个落库 helper。
    //   导出理由同 snapshotReleaseCommitsInTxn 既有先例——「契约错必须抛而不是静默写 NULL」这条性质，
    //   经 HTTP 层测不到（端点总是传得出 actor.id），只能直调验证。不导出就等于这条守卫没有断言看着。
    //   ⚠️ **仅供 verify / 契约测试直调，不是业务调用入口**（codex C2b 审 LOW）：这两个 helper 只做落库，
    //   绕开了端点侧的授权、状态白名单、self-guard 与收件人解析。业务代码一律走 HTTP 端点。
    assertNotifySentBy,
    recordSysCreatorNotify,
    recordSysDevAssigneeNotify,
    // 建单优化批 C1（方案 20260731_v1.2）：对接人同源 helper + intake 通道落库/文案 + 标题派生——
    //   导出供 verify 直调真实逻辑（RC-L2 防复刻漂移），业务代码一律走 HTTP 端点。
    resolveActiveSysIntakeLiaisons,
    recordSysIntakeNotify,
    buildSysIntakeMarkdown,
    deriveSysTitleFromDescription,
    SYS_NOTIFY_INTAKE_STATUSES,
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
    // 上线体统一重构 C0（方案 v3.4 §6.2）新增排班表锚点（verify-sys-schema 等 require 真实逻辑）
    SYS_DUTY_ROSTER_KEY_COLS,
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
    normalizeDeadlineDT,   // 四处优化 D2②：deadline 专用 datetime 校验器（与上一行**并存**——上一行是纯日期字段的共用校验器，勿合并）
    deadlineToMinuteText,  // 时间格式统一 S3（D3）：deadline 的**文本**截断件（留痕/通知用；truncToMinute 对纯日期返 null 不能替代）
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
    // C4：getReleaseMembers 统一读源（verify 直调覆盖三态+完整性校验分支，RC-L2 防复刻漂移）
    getReleaseMembers,
    deriveReleaseType,   // §6.9 类型派生（verify 直调覆盖 single/mixed/unknown 三值）
    // C2a：通知状态机共享原语（verify-sys-release-batch require 真实逻辑，RC-L2 防复刻漂移）
    hasReleaseEligibility,
    // [C4b 删除] staleTransitionForRelease 导出项一并移除——函数本体已删（见其原定义处删除注释）。
    // [C5 删除] syncReleaseLegacyMirror 导出项一并移除——函数本体已删（见其原定义处删除注释）。
    applyReleaseChange,
    requireLiaisonOnly,   // C1 排班表写权泛化（原 requireDutyRosterWrite），C2a cancel-schedule 复用同判据
    // C5：钉钉通知派发（verify-sys-notify require 真实逻辑）
    dispatchSysNotify,
    buildSysDevMarkdown,
    buildSysRequesterMarkdown,
    buildSysCreatorMarkdown,   // [D22 批2·codex 290 号裁定] 状态显示映射 verify 直调覆盖，同 buildSysRequesterMarkdown 既有导出理由
    sysStatusDisplayName,      // [D22 批2] 纯展示映射 helper，verify 直调断言产出含"待验收"不含"待验证"
    sysDeepLinkLine,
    // S3（bug暂缓方案 §7.1/§7.3/§7.4）：两个新模板 + 通知列重置 SQL 常量（verify 直调真实逻辑，RC-L2 防复刻漂移）
    buildSysHoldCreatorMarkdown,
    buildSysResumeDevMarkdown,
    SYS_CLEAR_CREATOR_NOTIFY_FIELDS_SQL,
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
    sysTechConsultGateStatus,   // 角色权限重构 C3：request/resend-tech-consult 开放态按 type 分流单一来源（verify 直测分流值）
    recordSysNotifyTimeline,   // 角色权限重构 C3：受理人「评估已回」通知复用此 helper（verify 直测 timeline 落库）
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
    // S2（bug暂缓方案 §4.5/§4.5b/§5.2）：hold 授权 + roster 冻结 + reassign 状态级排除（verify 直调真实逻辑，RC-L2 防复刻漂移）
    assertBugHoldActor,
    assertRosterNotFrozen,
    MEMBER_ACTION_STATUS_EXCLUDE,
    memberActionAuthoritativeStatuses,     // §4.5b：verify-sys-meta.js [6] authoritative 计算改消费此函数（族门-状态级排除，双向同源）
    DEV_ASSIGNEES_SELECT_COLS,
    // C2（上线执行人多选，方案 v1.7 §4.4 端点 3 + 预筛 L8）：行级 stale 惰性转换直调导出——理由同上方
    // C2b 三项（"经 HTTP 层测不到/测不精确，只能直调验证"）：HTTP 层能间接证明"过期 sending 允许再发"，
    // 但拿不到"转换那一刻状态确实是 stale"这个中间态的直接快照，直调才能补上这条强断言。
    staleTransitionForExecutorRow,
    staleTransitionForExecutorRelease,
    // C4a（方案 §4.3 通知态聚合派生，verify 直调覆盖六态优先级判定，RC-L2 防复刻漂移）：
    deriveExecutorNotifySummary,
    getReleaseNotifySummary,
  };

  return { initSchema, router, _internals };
};
