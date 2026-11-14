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
  // C2b 参与方 / 成员 / 任职 / 授权 / 邀请（每次状态转移一条，级联对象也各写一条）
  'party_created', 'party_renamed', 'member_invited', 'member_removed',
  'invitation_accepted', 'invitation_declined', 'invitation_withdrawn',
  'appointment_proposed', 'appointment_activated', 'appointment_rejected', 'appointment_withdrawn', 'appointment_ended',
  'delegation_proposed', 'delegation_approved', 'delegation_rejected', 'delegation_activated', 'delegation_revoked', 'delegation_withdrawn',
  // C2b 修订（codex 16 号 M-3）：受邀人接受加入，成员行由待接受转为已加入
  'member_joined',
  // C3a 批次 / 节点 / 排期（方案 v1.2 §3、§4.4、§4.5）：建项带出的批次与节点、节点动作、排期记录各一条
  'batch_created', 'batch_updated',
  'node_created', 'node_started', 'node_closed', 'node_reopened', 'node_cascade_reopened', 'node_cancelled', 'node_renamed', 'nodes_reordered',
  'node_plan_set', 'node_rescheduled', 'node_actual_corrected',
  // C3b 模块 / 需求条目 / 内容包与版本 / 附件沿用（方案 v1.2 §4.1 需求条目登记、§2.3 总体规划单一身份、§10.3 附件复用；payload 一律不含附件原文件名）
  'module_created', 'module_renamed',
  'item_created', 'item_version_created', 'item_module_changed', 'attachment_referenced',
  'package_created', 'package_version_created', 'package_version_edited', 'package_item_added', 'package_item_removed',
  // C4a 内容包提交确认 / 撤回 / 生效 / 替代、确认任务与修订、确认记录、基线、条目提出人状态（payload 一律不含附件原文件名，Q8）
  'package_version_submitted', 'package_version_withdrawn', 'package_version_effective', 'package_version_superseded',
  'confirm_task_created', 'confirm_task_reissued', 'confirm_revision_superseded', 'confirmation_recorded',
  'baseline_formed', 'item_proposer_status_changed',
  // C4a 修订批 P38：项目终止时待确认修订置已失效
  'confirm_revision_invalidated',
  // C4a 修订批三 M-1：合并形态总体规划包生效推进批次（规划中 → 进行中）
  'batch_status_changed',
  // C4b Q-S1 代录：确认任务的代录确认记录；无账号成员的任职接受 / 授权批准与接受由 PM 代录（payload 一律不含附件原文件名，Q8）
  'confirm_proxy_recorded', 'appointment_proxy_accepted', 'delegation_proxy_granted', 'delegation_proxy_accepted',
  // C4b Q-S2：「历史补录中」时间窗的开启 / 关闭 / 重开（凭据附件以 owner_type = event 挂在事件行上）；历史补录（只记确认事实，不改状态）；历史事实导入（恢复历史状态）
  'history_window_opened', 'history_window_closed', 'history_window_reopened', 'history_confirmation_recorded', 'history_fact_imported',
  // C5 S-S1a 登记与办理：登记创建；办理动作（更正 / 作废 / 结论 / 仅供参考 / 标记 / 交裁定，payload.action 区分）；知会生成与知会异议；
  //   登记作废时待确认的结论修订随之失效沿用 confirm_revision_invalidated，新结论替代旧待确认修订沿用 confirm_revision_superseded
  'entry_created', 'entry_action_recorded', 'notice_created', 'notice_objected',
  // C5 S-S1b 分流与收口：登记提交时的首次分流判定（每个处理项一条）、待判定的人工归属（assign_items）、登记拆分（自动混合拆分与手动 split 同名，payload.via 区分）
  'routing_decided', 'routing_assigned', 'entry_split',
  // C5 S-S1c 正式变更：建变更（同一事务建变更包与第一版草稿）/ 提交 / 撤回 / 出新版本 / 生效（含新旧总体规划版本号）；开发方关键事项：确认任务建立与自动失效沿用 confirm_task_created / confirm_revision_invalidated
  'change_created', 'change_submitted', 'change_withdrawn', 'change_new_version', 'change_effective',
  // C6a 上线与交接：确认试运行结束 / 再上线 / 历史导入的上线事件（golive_recorded，payload.kind 区分 golive / regolive，payload.via = history_import 为历史导入）、撤销上线（golive_revoked）、
  //   交接确认的发起（handover_requested）。批次状态、里程碑节点、项目状态的变化沿用 batch_status_changed / node_closed / node_reopened / project_status_changed。
  //   P174：PM 对交接确认的不认可 / 有异议的答复（handover_replied，挂在登记上，payload = { entry_id, batch_id, replied_revision_ids, reply }）。
  'golive_recorded', 'golive_revoked', 'handover_requested', 'handover_replied',
  // C6b 通知：发送意图的每次尝试（payload 带渠道返回摘要，不含凭证与令牌；outcome = sent / failed / skipped）、PM 点补发
  'send_intent_attempted', 'send_intents_resent',
  // C8：候选材料及其只追加版本（不包含正文或附件原名）。
  'material_created', 'material_version_created',
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
