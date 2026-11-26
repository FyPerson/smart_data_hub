// routes/sysbuild/events.js — 项目管理（系统建设记录）模块事件写入的唯一助手
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §6（sysbuild_events）。
//
// 事件类型不在 DB 里加枚举 CHECK（见 schema.js 头注：C2–C6 会陆续登记新类型，SQLite 改 CHECK 要重建表），
//   改由本文件的登记表校验：未登记的类型是编程错误，抛 500 SYSBUILD_INTERNAL，事务随之回滚。
//   后续阶段往 EVENT_TYPES 追加。
'use strict';
const { makeError } = require('./db');

const EVENT_TYPES = Object.freeze([
  // C1c 附件
  'attachment_staged', 'attachment_bound', 'attachment_frozen', 'attachment_deleted', 'attachment_masked',
  // C2a 项目（建项 / 改基本信息 / 状态转移 / 更换 PM 或接管 / PM 成员行）
  'project_created', 'project_updated', 'project_status_changed', 'project_pm_changed', 'member_added',
  // 参与方管理以及人员直接指定，生效与历史身份各自留痕。
  'party_created', 'party_renamed', 'member_removed',
  'appointment_activated', 'appointment_ended', 'delegation_activated', 'delegation_revoked',
  // C3a 批次 / 节点 / 排期（方案 v1.2 §3、§4.4、§4.5）：建项带出的批次与节点、节点动作、排期记录各一条
  'batch_created', 'batch_updated',
  'node_created', 'node_started', 'node_closed', 'node_reopened', 'node_cascade_reopened', 'node_cancelled', 'node_renamed', 'nodes_reordered',
  'node_plan_set', 'node_rescheduled', 'node_actual_corrected',
  // C3b 内容包与版本 / 附件沿用（方案 v1.2 §2.3 总体规划单一身份、§10.3 附件复用；payload 一律不含附件原文件名）
  'attachment_referenced',
  'package_created', 'package_version_created', 'package_version_edited',
  // C4a 内容包提交确认 / 撤回 / 生效 / 替代、确认任务与修订、确认记录、基线（payload 一律不含附件原文件名，Q8）
  'package_version_submitted', 'package_version_withdrawn', 'package_version_effective', 'package_version_superseded',
  'confirm_task_created', 'confirm_task_reissued', 'confirmation_recorded',
  'baseline_formed',
  // C4a 修订批 P38：项目终止时待确认修订置已失效
  'confirm_revision_invalidated',
  // C4a 修订批三 M-1：合并形态总体规划包生效推进批次（规划中 → 进行中）
  'batch_status_changed',
  // C5 S-S1a 登记与办理：登记创建；办理动作（更正 / 作废，payload.action 区分）；改期知会生成（C6 起结论 / 仅供参考 / 分流 / 拆分 / 知会异议的事件类型已删）
  'entry_created', 'entry_action_recorded', 'notice_created',
  // C6a 上线：确认试运行结束 / 再上线（golive_recorded，payload.kind 区分 golive / regolive）、撤销上线（golive_revoked）。
  //   批次状态、里程碑节点、项目状态的变化沿用 batch_status_changed / node_closed / node_reopened / project_status_changed。
  'golive_recorded', 'golive_revoked',
  // C6b 通知：发送意图的每次尝试（payload 带渠道返回摘要，不含凭证与令牌；outcome = sent / failed / skipped）、PM 点补发
  'send_intent_attempted', 'send_intents_resent',
  // C8：候选材料及其只追加版本（不包含正文或附件原名）。
  'material_created', 'material_version_created', 'material_not_applicable',
  'opinion_created', 'opinion_triaged', 'opinion_assessed',
  'opinion_concluded', 'opinion_cut_decided', 'opinion_cut_withdrawn',
  'work_task_created', 'work_task_resolved',
]);

// 必须在调用方的 withWriteTxn 回调里用回调给的 q 调用：事件与业务写入同一事务，要么都落库要么都不落。
async function writeEvent(q, ev) {
  if (!ev || !EVENT_TYPES.includes(ev.eventType)) {
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：事件类型未登记');
  }
  const payloadJson = ev.payload === undefined ? null : JSON.stringify(ev.payload);
  const projectId = ev.projectId === undefined ? null : ev.projectId;
  const objectId = ev.objectId === undefined ? null : ev.objectId;
  return q.run(
    'INSERT INTO sysbuild_events (project_id, object_type, object_id, event_type, payload_json, operator_id, operator_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [projectId, ev.objectType, objectId, ev.eventType, payloadJson, ev.operatorId, ev.operatorName]
  );
}

module.exports = { EVENT_TYPES, writeEvent };
