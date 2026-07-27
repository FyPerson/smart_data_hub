// 角色权限重构 C0：受理门相关的 SQL 片段与 DDL —— **单一真相源**。
//
// 为什么独立成文件：这些片段有三个消费方——
//   ① routes/sys-iteration/index.js（引擎的 reactivate / resubmit_intake、启动收口 [F]）
//   ② scripts/verify-sys-intake-gate.js 等测试（造夹具、断言）
//   ③ scripts/fix-sys-intake-gate-violation.js（运维裁决工具）
// codex C0 七轮审 HIGH-1 的实证教训：运维脚本自己另写了一份"回受理门"的字段清单（只改 status + intake_required），
// 结果把违规单修成「表面合法、但 tech_lead_*/relay_* 跨轮残留」的半清状态——比不修更糟（它看起来干净了）。
// 故凡是"回受理门"的语义，一律从本文件取，任何一方都不得再手写清单。
'use strict';

// ── 技术负责人咨询 9 列 ──────────────────────────────────────────────────────
//   只清 id/name 会留两个真缺陷：①展示面矛盾（无负责人却有通知记录）
//   ②跨轮次污染（recordSysTechLeadNotify 的版本围栏 WHERE 是 tech_lead_notify_request_event_id，
//     不清它则上一轮在途通知的回写会命中新一轮的行）。
const SYS_CLEAR_TECH_LEAD_FIELDS_SQL = [
  'tech_lead_id = NULL',
  'tech_lead_name = NULL',
  'tech_lead_notify_request_event_id = NULL',
  "tech_lead_notify_status = 'not_sent'",
  'tech_lead_notified_at = NULL',
  'tech_lead_notify_message_key = NULL',
  'tech_lead_read_at = NULL',
  'tech_lead_notify_error = NULL',
  'tech_lead_notify_sent_by = NULL',
];

// ── 对接人通知 8 列（C2b 起含 sent_by）──────────────────────────────────────
//   relay_notified_user_id 原由 bug path B 建单写入，C0 关闭 path B 后已无业务写入路径。
//   定性为**轮次状态**（这一轮该通知谁），非永久审计字段（审计留痕在 timeline）。
//   ⭐ C2b：`relay_notify_sent_by` 必须一并清 —— 不变量是 `not_sent ⟹ sent_by 空`，
//   回受理门把 status 归零却留着 sent_by，会造出「没发过、却记着是谁发的」的违约行。
//   （tech_lead 组的 sent_by 早已在上面那份清单里，本行是把同一条规则补齐到 relay 组。）
const SYS_CLEAR_RELAY_FIELDS_SQL = [
  'relay_notified_user_id = NULL',
  'relay_notified_user_name = NULL',
  "relay_notify_status = 'not_sent'",
  'relay_notified_at = NULL',
  'relay_read_at = NULL',
  'relay_notify_message_key = NULL',
  'relay_notify_error = NULL',
  'relay_notify_sent_by = NULL',
];

// ── 回受理门 = 恢复受理门标志 + 清两组轮次痕迹 ────────────────────────────────
//   三者必须在**同一条 UPDATE 的 SET 列表**里原子生效（引擎侧由 sysIssueTransition 的单条 UPDATE 保证）。
const SYS_BACK_TO_INTAKE_GATE_SQL = [
  'intake_required = 1',
  ...SYS_CLEAR_TECH_LEAD_FIELDS_SQL,
  ...SYS_CLEAR_RELAY_FIELDS_SQL,
];

// ── 受理态一致性触发器（全表 intake_required 恒 1）────────────────────────────
const SYS_INTAKE_GATE_TRIGGER_NAMES = ['trg_sys_issues_intake_gate_ins', 'trg_sys_issues_intake_gate_upd'];
const SYS_INTAKE_GATE_ABORT_MSG = 'intake_required 必须为 1——角色权限重构 C0 焊死受理门：全类型必经受理，0 为非法态';
const SYS_INTAKE_GATE_TRIGGERS_SQL = [
  `CREATE TRIGGER ${SYS_INTAKE_GATE_TRIGGER_NAMES[0]}
   BEFORE INSERT ON sys_issues
   WHEN NEW.intake_required IS NOT 1
   BEGIN SELECT RAISE(ABORT, '${SYS_INTAKE_GATE_ABORT_MSG}'); END;`,
  `CREATE TRIGGER ${SYS_INTAKE_GATE_TRIGGER_NAMES[1]}
   BEFORE UPDATE ON sys_issues
   WHEN NEW.intake_required IS NOT 1
   BEGIN SELECT RAISE(ABORT, '${SYS_INTAKE_GATE_ABORT_MSG}'); END;`,
];
// ⚠️ 刻意**不带 IF NOT EXISTS**（codex 七轮审 MED-1）：名称存在不等于定义正确——
//   库里若有同名但定义漂移/空操作的旧触发器，IF NOT EXISTS 会静默保留它，
//   于是"名称齐全 → 判定约束已恢复 → readiness 放行"，而实际约束无效。
//   故恢复流程一律 **DROP 后重建**，用下面这组 DROP 配套使用。
const SYS_INTAKE_GATE_DROP_SQL = SYS_INTAKE_GATE_TRIGGER_NAMES.map(n => `DROP TRIGGER IF EXISTS ${n}`);

// C0 存量归一迁移标记
const C0_INTAKE_GATE_MIGRATION_KEY = 'role_perm_c0_intake_gate';

// 受理门违规判定（三处必须逐字一致：迁移 WHERE / 启动收口后验 / 运维脚本）
//   ⚠️ 必须带 IS NULL：SQLite 三值逻辑下 `!= 1` 不匹配 NULL。
const INTAKE_VIOLATION_WHERE = 'intake_required != 1 OR intake_required IS NULL';

module.exports = {
  SYS_CLEAR_TECH_LEAD_FIELDS_SQL,
  SYS_CLEAR_RELAY_FIELDS_SQL,
  SYS_BACK_TO_INTAKE_GATE_SQL,
  SYS_INTAKE_GATE_TRIGGER_NAMES,
  SYS_INTAKE_GATE_TRIGGERS_SQL,
  SYS_INTAKE_GATE_DROP_SQL,
  SYS_INTAKE_GATE_ABORT_MSG,
  C0_INTAKE_GATE_MIGRATION_KEY,
  INTAKE_VIOLATION_WHERE,
};
