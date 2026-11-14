// routes/sysbuild/membership.js — 项目管理（系统建设记录）模块：参与方、成员、任职、授权、邀请端点 + 受邀人窄范围入口（C2b / M-S2）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §4.2（前三行）、§4.5、§5、§6.2（前六张表）、§7「成员与授权」组。
//   派单 = docs/local/系统建设记录/送审准备/C2b_参与方成员任职授权邀请_派单_20261029.md。
//
// 工厂 createMembershipRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（C4b 起多了代录用的附件绑定助手与可选的「今天」注入），其余与 projects.js 同款；
//   router 上的路径都以 /sysbuild/ 开头，鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 另导出 decorateDetail(q, identity, project, partyItems, memberItems, readonlyIds)：项目详情（projects.js）用它给参与方 / 成员补逐对象 actions，
//   并返回可见的任职与授权列表——读接口与写端点走 rules.js 里同一张 OBJECT_OPS 表（rules.opAllowed / rules.checkOp）；
//   withdrawInvitationsOfInviter(q, user, projectId, inviterId, readonlyIds)：更换 PM 的事务里撤回原 PM 发出的待处理邀请及关联对象（M1 ③）。
// 管理类动作（建 / 改参与方、加 / 移出成员、提议 / 撤回 / 结束任职）的权限 = 非只读且（PM 或 admin）；PM 发起授权与 PM 撤回授权提议
//   只认「以 PM 身份行事」（rules.canActAsPm，admin 接管后才可）。D2：管理动作不得作用于操作人本人（加成员、提议任职对目标逐一核对）。
//
// 检查顺序（§5.3）：参数 400 → 对象存在 404 → 可见性 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 对象状态与业务规则 409 / 400。
//   接受类例外：接受 / 拒绝邀请与授权时，第三步改为「是否指向本人」（不是 → 404，与不存在同响应），不再走成员可见性。
// 写端点全部在 withWriteTxn 内完成「加载 → 校验 → 写 → 写事件」；条件更新 WHERE 一律带改前状态并核对影响行数（0 → 409 SYSBUILD_STATE）。
'use strict';
const visibility = require('./membership-visibility');
const express = require('express');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const notifyCore = require('./notify-core'); // C6b：邀请 / 授权写发送意图
const confirmCore = require('./confirm-core'); // C4b Q-S1：代录端点（任职接受 / 授权批准与接受）共用确认任务、确认记录与外部日期助手

const NAME_MAX = 50;
const REASON_MAX = 500;
const INV_EVENT = Object.freeze({ accepted: 'invitation_accepted', declined: 'invitation_declined', withdrawn: 'invitation_withdrawn' });
// 窄范围入口里的「所授权限说明」：固定文案，按邀请类型写（§5.1：项目名称、角色、邀请人、所授权限说明）。
const PERMISSION_NOTES = Object.freeze({
  join: '接受后你将成为本项目成员，可以查看本项目的全部历史，并按所在参与方的角色参与办理。',
  appointment: '接受后你将成为所在参与方在本项目中的负责人，可以代表本方作出确认，并可授权、撤销本方代表人。',
  delegation: '接受后你将成为所在参与方在本项目中的代表人，可以代表本方作出确认。',
});

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const present = (v) => v !== undefined && v !== null;
// 请求体：没有请求体（undefined / null）按空对象；存在却不是普通对象（express.json 的 strict 模式仍会放行数组根值）→ 400（codex 17 号 L-1）。
function bodyOf(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
  return b;
}

// 文本：trim 后按码点计长；必填缺失 / 非文本 / 超长 400。
function readText(raw, field, label, max, required) {
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (typeof raw !== 'string') throw invalid(`${label}必须是文本`, field);
  const v = raw.trim();
  if (v === '') {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field); // 预筛 L1：NUL 等控制字符否则落到库内 CHECK 以 500 暴露
  if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
  return v;
}
// 编号：缺失（undefined / null）按 required 处理；其余必须是正整数。
function readId(raw, field, label, required) {
  if (!present(raw)) {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  const id = rules.parseId(raw);
  if (!id) throw invalid(`${label}不合法`, field);
  return id;
}

// ── 读库：任职 / 授权 / 邀请的统一选择（详情、写端点、窄范围入口共用，避免各写一份漂移）──────────────
const APPT_COLS = `a.id AS id, a.party_id AS party_id, a.member_id AS member_id, a.status AS status, a.proposed_by AS proposed_by,
  a.effective_at AS effective_at, a.ended_at AS ended_at, a.end_reason AS end_reason, a.created_at AS created_at,
  p.project_id AS project_id, m.user_id AS user_id, u.status AS user_status, m.joined_at AS joined_at, m.removed_at AS removed_at,
  COALESCE(u.display_name, u.username, m.person_name) AS name`;
const APPT_FROM = 'FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id JOIN sysbuild_members m ON m.id = a.member_id LEFT JOIN users u ON u.id = m.user_id';
const DELEGATION_COLS = `d.id AS id, d.party_id AS party_id, d.member_id AS member_id, d.appointment_id AS appointment_id, d.status AS status, d.proposed_by AS proposed_by,
  d.effective_at AS effective_at, d.revoked_at AS revoked_at, d.revoke_reason AS revoke_reason, d.created_at AS created_at,
  p.project_id AS project_id, m.user_id AS user_id, u.status AS user_status, m.joined_at AS joined_at, m.removed_at AS removed_at,
  COALESCE(u.display_name, u.username, m.person_name) AS name,
  (SELECT a.id FROM sysbuild_appointments a WHERE a.party_id = d.party_id AND a.status = 'active' LIMIT 1) AS current_appointment_id,
  (SELECT om.user_id FROM sysbuild_appointments oa JOIN sysbuild_members om ON om.id = oa.member_id WHERE oa.id = d.appointment_id) AS owner_user_id,
  (SELECT ou.status FROM sysbuild_appointments oa JOIN sysbuild_members om ON om.id = oa.member_id LEFT JOIN users ou ON ou.id = om.user_id WHERE oa.id = d.appointment_id) AS owner_user_status`;
const DELEGATION_FROM = 'FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id JOIN sysbuild_members m ON m.id = d.member_id LEFT JOIN users u ON u.id = m.user_id';
const INVITATION_SELECT = `SELECT i.id AS id, i.project_id AS project_id, i.member_id AS member_id, i.kind AS kind, i.appointment_id AS appointment_id,
  i.status AS status, i.invited_by AS invited_by, i.created_at AS created_at,
  m.user_id AS user_id, m.party_id AS party_id, m.joined_at AS joined_at, m.removed_at AS removed_at,
  pr.system_name AS system_name, pr.phase_name AS phase_name, pr.status AS project_status, pr.pm_user_id AS pm_user_id,
  pa.name AS party_name, pa.side AS side, ap.status AS appt_status,
  COALESCE(ui.display_name, ui.username) AS invited_by_name, ui.role AS inviter_role
  FROM sysbuild_invitations i JOIN sysbuild_members m ON m.id = i.member_id JOIN sysbuild_projects pr ON pr.id = i.project_id
  LEFT JOIN sysbuild_parties pa ON pa.id = m.party_id LEFT JOIN sysbuild_appointments ap ON ap.id = i.appointment_id LEFT JOIN users ui ON ui.id = i.invited_by`;

// ── 目标对象：把库里的行整理成 rules.OBJECT_OPS 认的 target（读写两端同一份）────────────────────────
//   historyConflict（C4b Q-S2，P58）：历史补录窗口开启期间该授权已有历史导入 → 文案，否则 null；调用方现取（delegationConflictOf），不传则为 undefined，规则层对批准 / 接受 / 代录 fail-closed 拒绝。
function delegationTarget(d, project, historyConflict) {
  const appointmentIsCurrent = present(d.current_appointment_id) && Number(d.current_appointment_id) === Number(d.appointment_id);
  const memberActive = d.removed_at === null && d.joined_at !== null;
  const isPmUser = present(d.user_id) && Number(d.user_id) === Number(project.pm_user_id);
  let requalReason = null;
  if (!appointmentIsCurrent) requalReason = '授权所依据的负责人任职已变化，该授权提议已失效';
  else if (!memberActive) requalReason = '被授权人已不是本项目成员，该授权提议已失效';
  else if (isPmUser) requalReason = 'PM 不得兼任代表人，该授权提议已失效';
  // ownerHasAccount / memberHasAccount：代录授权两步（rules.delegation_proxy）判「该步的本人有没有平台账号」用——批准一步是授权所依据任职的负责人，接受一步是被授权人。
  return {
    party_id: d.party_id, status: d.status, proposed_by: d.proposed_by, userId: d.user_id, appointmentIsCurrent, requalReason, historyConflict,
    ownerHasAccount: present(d.owner_user_id), memberHasAccount: present(d.user_id),
    ownerAccountDisabled: present(d.owner_user_id) && d.owner_user_status !== 'active', memberAccountDisabled: present(d.user_id) && d.user_status !== 'active', // 预筛 L10：账号停用另给文案
  };
}
// 任职接受代录的 target（rules.appointment_proxy_accept）：任职状态、成员是否已加入未移出、成员是否有平台账号。
function appointmentProxyTarget(a, historyConflict) {
  return {
    status: a.status, memberActive: a.removed_at === null && a.joined_at !== null, hasAccount: present(a.user_id), historyConflict, // historyConflict：C4b Q-S2（P58），appointmentConflictOf 现取
    accountDisabled: present(a.user_id) && a.user_status !== 'active', // 预筛 L10：账号停用另给文案
  };
}
// 只读账号集合（调用方从平台配置注入）：缺失抛 500，不回落为空集合（回落会让只读 admin 静默有权）。
function readonlySetOf(readonlyIds) {
  if (!(Array.isArray(readonlyIds) || readonlyIds instanceof Set)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：只读账号集合未提供');
  return new Set(Array.from(readonlyIds).map(Number));
}
// 邀请人此刻是否仍有权发邀请：先做只读否决（邀请人在只读名单里就不再有权，无论是不是本项目 PM，codex 16 号 M-2），
//   再判本项目 PM，或 admin（L7）。
function inviterEntitled(project, inv, roSet) {
  if (roSet.has(Number(inv.invited_by))) return false;
  if (Number(inv.invited_by) === Number(project.pm_user_id)) return true;
  return inv.inviter_role === 'admin';
}
// 邀请：inviter 须仍有权（邀请人资格重核）；成员行未移出；任职类还须任职仍待接受、被邀请人已加入且不是 PM。
//   historyConflict（C4b Q-S2，P58）：任职类邀请 = 该任职的历史补录窗口互斥结果；加入邀请没有任职，恒 null（调用方传 null）。
function invitationTarget(project, inv, apptStatus, roSet, historyConflict) {
  const entitled = inviterEntitled(project, inv, roSet);
  let requalReason = null;
  if (!entitled) requalReason = '邀请人已不是本项目 PM，该邀请已失效';
  else if (inv.removed_at !== null) requalReason = '被邀请人的成员记录已移出，该邀请已失效';
  else if (inv.kind === 'appointment') {
    if (apptStatus !== 'pending') requalReason = '任职提议已变化，该邀请已失效';
    else if (inv.joined_at === null) requalReason = '被邀请人尚未加入本项目，该邀请已失效';
    else if (present(inv.user_id) && Number(inv.user_id) === Number(project.pm_user_id)) requalReason = 'PM 不得兼任参与方负责人，该邀请已失效';
  }
  return { status: inv.status, kind: inv.kind, userId: inv.user_id, requalReason, historyConflict };
}
// 历史补录窗口互斥（P58）的现取：邀请按种类（加入邀请没有任职，null），任职 / 授权按行本身。
const invitationConflictOf = (q, inv) => (inv.kind === 'appointment'
  ? confirmCore.membershipHistoryConflict(q, inv.project_id, 'appointment', inv.appointment_id)
  : null);
const appointmentConflictOf = (q, a) => confirmCore.membershipHistoryConflict(q, a.project_id, 'appointment', a.id);
const delegationConflictOf = (q, d) => confirmCore.membershipHistoryConflict(q, d.project_id, 'delegation', d.id);
// C6b 修订批 2（M2 / P185）：邀请 / 授权对某个用户此刻「可操作」（接受或拒绝）的判定——GET /my/invitations 的 actions、待办 accept 类 / 角标、钉钉发送侧发送前复核（notify.js describeRef）共用这一份，不各写一份。
//   row：INVITATION_SELECT 的行 / DELEGATION_ITEM_SELECT 的行；accessOpts：{ readonlyIds, writeRoles? }。返回 { project, accept, decline }。
const DELEGATION_ITEM_SELECT = `SELECT ${DELEGATION_COLS}, pr.system_name AS system_name, pr.phase_name AS phase_name, pr.status AS project_status, pr.pm_user_id AS pm_user_id,
  p.name AS party_name, p.side AS side, COALESCE(up.display_name, up.username) AS proposed_by_name
  ${DELEGATION_FROM} JOIN sysbuild_projects pr ON pr.id = p.project_id LEFT JOIN users up ON up.id = d.proposed_by`;
async function invitationActionsOf(q, user, row, accessOpts) {
  const identity = await rules.loadProjectIdentity(q, row.project_id, user, accessOpts);
  const project = { id: row.project_id, status: row.project_status, pm_user_id: row.pm_user_id };
  const t = invitationTarget(project, row, row.appt_status, readonlySetOf(accessOpts.readonlyIds), await invitationConflictOf(q, row));
  return { project, accept: rules.opAllowed('invitation_accept', identity, project, t), decline: rules.opAllowed('invitation_decline', identity, project, t) };
}
async function delegationActionsOf(q, user, d, accessOpts) {
  const identity = await rules.loadProjectIdentity(q, d.project_id, user, accessOpts);
  const project = { id: d.project_id, status: d.project_status, pm_user_id: d.pm_user_id };
  const t = delegationTarget(d, project, await delegationConflictOf(q, d));
  return { project, accept: rules.opAllowed('delegation_accept', identity, project, t), decline: rules.opAllowed('delegation_decline', identity, project, t) };
}

// ── 事件与状态转移助手（全部只在 withWriteTxn 回调里用，q 是回调给的查询助手）─────────────────────────
function emit(q, user, projectId, objectType, objectId, eventType, payload) {
  return writeEvent(q, { projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: operatorNameOf(user) });
}
// 邀请 pending → accepted / declined / withdrawn（同时写 responded_at，schema CHECK 要求与 pending 联动）。
async function moveInvitation(q, user, inv, to, extra) {
  const r = await q.run("UPDATE sysbuild_invitations SET status = ?, responded_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [to, inv.id]);
  if (r.changes === 0) throw stateError('邀请状态已变化，请刷新后重试');
  await emit(q, user, inv.project_id, 'invitation', inv.id, INV_EVENT[to], Object.assign({ kind: inv.kind, member_id: inv.member_id, appointment_id: inv.appointment_id }, extra || {}));
}
async function withdrawInvitationsOfAppointment(q, user, apptId, extra) {
  const rows = await q.all("SELECT id, project_id, member_id, kind, appointment_id FROM sysbuild_invitations WHERE appointment_id = ? AND status = 'pending' ORDER BY id", [apptId]);
  for (const inv of rows) await moveInvitation(q, user, inv, 'withdrawn', extra);
}
// 失效邀请的收尾（M1 ②）：邀请置 withdrawn，同事务收掉它关联的对象，不留僵尸行——
//   join：成员行仍待接受（未加入、未移出）则置已移出（原因「邀请已失效」）并写 member_removed；
//   appointment：关联任职仍是 pending 则置 withdrawn 并写 appointment_withdrawn。
//   row 来自 INVITATION_SELECT；why 写进各条事件的 reason；via 标明触发来源（accept = 受邀人接受时重核不通过；pm_change = 更换 PM 时主动撤回）。
async function settleStaleInvitation(q, user, row, why, via) {
  await moveInvitation(q, user, row, 'withdrawn', { reason: why, stale: true, via });
  if (row.kind === 'join') {
    if (row.removed_at === null && row.joined_at === null) {
      const rm = await q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = ? WHERE id = ? AND removed_at IS NULL AND joined_at IS NULL", ['邀请已失效', row.member_id]);
      if (rm.changes === 0) throw stateError('成员状态已变化，请刷新后重试');
      await emit(q, user, row.project_id, 'member', row.member_id, 'member_removed', { user_id: row.user_id, party_id: row.party_id, reason: '邀请已失效', via });
    }
    return;
  }
  const appt = await q.get('SELECT id, party_id, member_id, status FROM sysbuild_appointments WHERE id = ?', [row.appointment_id]);
  if (appt && appt.status === 'pending') await moveAppointment(q, user, row.project_id, appt, 'withdrawn', 'appointment_withdrawn', { reason: why, stale: true, via });
}
// 更换 PM 时（projects.js POST pm，同事务）主动撤回原 PM 发出的待处理邀请及其关联对象——邀请人失权即失效，不留惰性悬挂（M1 ③）。
//   原 PM 若是 admin 且非只读，他发出的邀请仍有效（邀请人资格重核认 admin），不动。返回撤回的条数。
async function withdrawInvitationsOfInviter(q, user, projectId, inviterId, readonlyIds) {
  const roSet = readonlySetOf(readonlyIds);
  const inviter = await q.get('SELECT role FROM users WHERE id = ?', [inviterId]);
  if (inviter && inviter.role === 'admin' && !roSet.has(Number(inviterId))) return 0;
  const rows = await q.all(`${INVITATION_SELECT} WHERE i.project_id = ? AND i.invited_by = ? AND i.status = 'pending' ORDER BY i.id`, [projectId, inviterId]);
  for (const row of rows) await settleStaleInvitation(q, user, row, '邀请人已不是本项目 PM，该邀请已失效', 'pm_change');
  return rows.length;
}
// 任职 pending → rejected / withdrawn（不带时间列）。
async function moveAppointment(q, user, projectId, a, to, eventType, extra) {
  const r = await q.run('UPDATE sysbuild_appointments SET status = ? WHERE id = ? AND status = ?', [to, a.id, a.status]);
  if (r.changes === 0) throw stateError('任职状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'appointment', a.id, eventType, Object.assign({ party_id: a.party_id, member_id: a.member_id }, extra || {}));
}
// 授权状态转移（不带时间列）：approve（pending_owner → pending_accept）、reject、withdraw。
//   C6b 修订批 1（L1）：可选第七参 o——o.notify === false 不写发送意图。历史事实导入（history.js）把授权 pending_owner → pending_accept 后在同一事务里立刻接受生效，
//   写下的意图只会在发送时被判「授权已不在待接受状态」而跳过，所以导入路径不写（选「加参数」而不是把写意图挪到批准端点：批准端点与代录批准要各写一次，多一处漏写的可能）。
async function moveDelegation(q, user, projectId, d, to, eventType, extra, o) {
  const r = await q.run('UPDATE sysbuild_delegations SET status = ? WHERE id = ? AND status = ?', [to, d.id, d.status]);
  if (r.changes === 0) throw stateError('授权状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'delegation', d.id, eventType, Object.assign({ party_id: d.party_id, member_id: d.member_id }, extra || {}));
  // C6b（§9.2 邀请与授权 → 本人）：授权进入「待被授权人接受」（负责人批准 / 代录批准）→ 被授权人（有账号时）收到发送意图
  if (to === 'pending_accept' && !(o && o.notify === false)) await enqueueDelegationIntent(q, projectId, d);
}
// C6b：被授权人（有账号时）的「待接受」通知。授权提议由本方负责人直接发起（初始 pending_accept）时也走这里；PM 发起的待负责人确认（pending_owner）此刻被授权人还不能接受，批准之后再通知。
function enqueueDelegationIntent(q, projectId, d) {
  return notifyCore.enqueueMemberIntent(q, { projectId, memberId: d.member_id, purpose: notifyCore.PURPOSES.DELEGATION_ACCEPT, refType: notifyCore.REF_TYPES.DELEGATION, refId: d.id });
}
async function revokeDelegation(q, user, projectId, d, reason) {
  const r = await q.run("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = ? WHERE id = ? AND status = 'active'", [reason, d.id]);
  if (r.changes === 0) throw stateError('授权状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'delegation', d.id, 'delegation_revoked', { party_id: d.party_id, member_id: d.member_id, reason });
}
// 基于某条任职的授权一并处理：生效的 → revoked（原因 reason），待定提议（pending_owner / pending_accept）→ withdrawn。
async function settleDelegationsOfAppointment(q, user, projectId, apptId, reason) {
  const rows = await q.all(
    "SELECT id, party_id, member_id, status FROM sysbuild_delegations WHERE appointment_id = ? AND status IN ('active', 'pending_owner', 'pending_accept') ORDER BY id",
    [apptId]
  );
  for (const d of rows) {
    if (d.status === 'active') await revokeDelegation(q, user, projectId, d, reason);
    else await moveDelegation(q, user, projectId, d, 'withdrawn', 'delegation_withdrawn', { reason });
  }
}
// 结束一条现任任职：任职 → ended，并处理基于它的授权（成员移出 / 负责人更换 / PM 手动结束三处共用）。
async function endAppointment(q, user, projectId, a, endReason, delegationReason) {
  const r = await q.run("UPDATE sysbuild_appointments SET status = 'ended', ended_at = datetime('now','localtime'), end_reason = ? WHERE id = ? AND status = 'active'", [endReason, a.id]);
  if (r.changes === 0) throw stateError('任职状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'appointment', a.id, 'appointment_ended', { party_id: a.party_id, member_id: a.member_id, end_reason: endReason });
  await settleDelegationsOfAppointment(q, user, projectId, a.id, delegationReason);
}
// 任职生效：先结束本方原现任（负责人更换，其授权一并处理），再把本条置为 active（唯一索引 uq_sysbuild_appointments_active 要求先结束旧的）。
//   effectiveAt（可选，C4b Q-S2 历史事实导入）：生效时刻文本 'YYYY-MM-DD HH:MM:SS'（原日期 00:00:00，P54）；缺省 = 此刻。历史导入要求本方当时没有现任（冲突检查先拒绝），所以 olds 为空、不走更换级联。
async function activateAppointment(q, user, projectId, a, effectiveAt) {
  const olds = await q.all("SELECT id, party_id, member_id, status FROM sysbuild_appointments WHERE party_id = ? AND status = 'active' ORDER BY id", [a.party_id]);
  for (const old of olds) await endAppointment(q, user, projectId, old, '负责人更换', '负责人更换后需重新授权');
  const r = await q.run("UPDATE sysbuild_appointments SET status = 'active', effective_at = COALESCE(?, datetime('now','localtime')) WHERE id = ? AND status = 'pending'", [effectiveAt === undefined ? null : effectiveAt, a.id]);
  if (r.changes === 0) throw stateError('任职状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'appointment', a.id, 'appointment_activated', { party_id: a.party_id, member_id: a.member_id, replaced: olds.map((o) => o.id) });
}
async function activateDelegation(q, user, projectId, d, effectiveAt) {
  const olds = await q.all("SELECT id, party_id, member_id, status FROM sysbuild_delegations WHERE party_id = ? AND status = 'active' ORDER BY id", [d.party_id]);
  for (const old of olds) await revokeDelegation(q, user, projectId, old, '代表人更换');
  const r = await q.run("UPDATE sysbuild_delegations SET status = 'active', effective_at = COALESCE(?, datetime('now','localtime')) WHERE id = ? AND status = 'pending_accept'", [effectiveAt === undefined ? null : effectiveAt, d.id]);
  if (r.changes === 0) throw stateError('授权状态已变化，请刷新后重试');
  await emit(q, user, projectId, 'delegation', d.id, 'delegation_activated', { party_id: d.party_id, member_id: d.member_id, appointment_id: d.appointment_id, replaced: olds.map((o) => o.id) });
}
// 移出成员的级联（同一事务）：现任任职 → ended（及其授权）；本人名下的授权 生效 → revoked / 待定 → withdrawn；待接受任职 → withdrawn；
//   待接受邀请 → withdrawn。每个级联对象各写一条事件。
async function cascadeMemberRemoval(q, user, projectId, memberId) {
  const appts = await q.all("SELECT id, party_id, member_id, status FROM sysbuild_appointments WHERE member_id = ? AND status IN ('active', 'pending') ORDER BY id", [memberId]);
  for (const a of appts) {
    if (a.status === 'active') await endAppointment(q, user, projectId, a, '成员移出', '负责人成员移出，需重新授权');
  }
  const dels = await q.all("SELECT id, party_id, member_id, status FROM sysbuild_delegations WHERE member_id = ? AND status IN ('active', 'pending_owner', 'pending_accept') ORDER BY id", [memberId]);
  for (const d of dels) {
    if (d.status === 'active') await revokeDelegation(q, user, projectId, d, '成员移出');
    else await moveDelegation(q, user, projectId, d, 'withdrawn', 'delegation_withdrawn', { reason: '成员移出' });
  }
  for (const a of appts) {
    if (a.status === 'pending') {
      await moveAppointment(q, user, projectId, a, 'withdrawn', 'appointment_withdrawn', { reason: '成员移出' });
      await withdrawInvitationsOfAppointment(q, user, a.id, { reason: '成员移出' });
    }
  }
  const invs = await q.all("SELECT id, project_id, member_id, kind, appointment_id FROM sysbuild_invitations WHERE member_id = ? AND status = 'pending' ORDER BY id", [memberId]);
  for (const inv of invs) await moveInvitation(q, user, inv, 'withdrawn', { reason: '成员移出' });
}

// ── 逐对象 actions 与可见的任职 / 授权列表（项目详情用）──────────────────────────────────────────
//   参与方、成员对象原地补 actions；返回 { appointments, delegations }。可见范围：PM / admin 全部；其余人（含只读账号）见
//   ① 已加入成员名下的生效对象；② 历史事实——已结束的任职（ended）与已撤销的授权（revoked），含已移出成员名下的（D3 放开历史，
//   用户 2026-10-29 拍板；带人、时间、原因）；③ 与本人有关的（本人的待接受任职；本方负责人名下本方的待处理授权；本人待接受的授权）。
//   rejected / withdrawn 的提议不是生效过的身份事实，普通成员不可见；别人的待接受任职、别方的待处理授权同样不可见。
async function decorateDetail(q, identity, project, partyItems, memberItems, readonlyIds) {
  const roSet = readonlySetOf(readonlyIds);
  const pid = project.id;
  const manager = !!(identity.isPm || identity.isAdmin);
  const me = identity.userId;
  const apptRows = await q.all(`SELECT ${APPT_COLS} ${APPT_FROM} WHERE p.project_id = ? ORDER BY a.id`, [pid]);
  const delRows = await q.all(`SELECT ${DELEGATION_COLS} ${DELEGATION_FROM} WHERE p.project_id = ? ORDER BY d.id`, [pid]);
  const invRows = await q.all(`${INVITATION_SELECT} WHERE i.project_id = ? AND i.kind = 'appointment' AND i.status = 'pending' ORDER BY i.id`, [pid]);
  const currentAppt = {};
  const pendingAppt = {};
  for (const a of apptRows) {
    if (a.status === 'active') currentAppt[a.party_id] = a.id;
    if (a.status === 'pending') pendingAppt[a.party_id] = true;
  }
  const pendingDel = {};
  for (const d of delRows) {
    if (d.status === 'pending_owner' || d.status === 'pending_accept') pendingDel[d.party_id] = true;
  }
  const invByAppt = {};
  for (const inv of invRows) invByAppt[inv.appointment_id] = inv;
  for (const p of partyItems) {
    p.actions = {
      rename: rules.opAllowed('party_rename', identity, project, {}),
      propose_appointment: rules.opAllowed('appointment_propose', identity, project, { hasPendingAppointment: !!pendingAppt[p.id] }),
      propose_delegation: rules.opAllowed('delegation_propose', identity, project, {
        party_id: p.id, currentAppointmentId: currentAppt[p.id] || null, hasPendingDelegation: !!pendingDel[p.id],
      }),
    };
  }
  for (const m of memberItems) {
    m.actions = { remove: rules.opAllowed('member_remove', identity, project, { removed: m.status === 'removed', isPmRow: present(m.user_id) && Number(m.user_id) === Number(project.pm_user_id), targetUserId: m.user_id }) };
  }
  const appointments = [];
  for (const a of apptRows) {
    const mine = present(a.user_id) && Number(a.user_id) === Number(me);
    const visible = visibility.appointmentVisible(identity, a);
    if (!visible) continue;
    const inv = invByAppt[a.id] || null;
    const apptConflict = await appointmentConflictOf(q, a);
    const invT = inv ? invitationTarget(project, inv, a.status, roSet, apptConflict) : null;
    const item = {
      id: a.id, party_id: a.party_id, member_id: a.member_id, name: a.name, status: a.status,
      effective_at: a.effective_at, ended_at: a.ended_at, end_reason: a.end_reason, created_at: a.created_at,
      invitation_id: inv && (manager || mine) ? inv.id : null,
      actions: {
        withdraw: rules.opAllowed('appointment_withdraw', identity, project, { status: a.status, targetUserId: a.user_id }),
        end: rules.opAllowed('appointment_end', identity, project, { status: a.status, targetUserId: a.user_id }),
        proxy_accept: rules.opAllowed('appointment_proxy_accept', identity, project, appointmentProxyTarget(a, apptConflict)),// C4b：无账号成员的任职接受代录（与 POST …/proxy-accept 同源）
        accept: !!invT && rules.opAllowed('invitation_accept', identity, project, invT),
        decline: !!invT && rules.opAllowed('invitation_decline', identity, project, invT),
      },
    };
    appointments.push(item);
  }
  const delegations = [];
  for (const d of delRows) {
    const visible = visibility.delegationVisible(identity, d);
    if (!visible) continue;
    const t = delegationTarget(d, project, await delegationConflictOf(q, d));
    delegations.push({
      id: d.id, party_id: d.party_id, member_id: d.member_id, name: d.name, appointment_id: d.appointment_id, status: d.status,
      effective_at: d.effective_at, revoked_at: d.revoked_at, revoke_reason: d.revoke_reason, created_at: d.created_at,
      actions: {
        approve: rules.opAllowed('delegation_approve', identity, project, t),
        reject: rules.opAllowed('delegation_reject', identity, project, t),
        accept: rules.opAllowed('delegation_accept', identity, project, t),
        decline: rules.opAllowed('delegation_decline', identity, project, t),
        revoke: rules.opAllowed('delegation_revoke', identity, project, t),
        withdraw: rules.opAllowed('delegation_withdraw', identity, project, t),
        proxy: rules.opAllowed('delegation_proxy', identity, project, t), // C4b：无账号一方的授权代录（按当前状态是批准或接受一步，与 POST …/proxy 同源）
      },
    });
  }
  return { appointments, delegations };
}

function createMembershipRoutes(ctx) {
  for (const k of ['db', 'logger']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/membership 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/membership 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/membership 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function') {
    throw new Error('routes/sysbuild/membership 参数 attachmentHelpers 必须带 bindStagedAttachments'); // C4b：代录端点绑定凭据附件
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  // 代录的外部确认日期上限 = 今天（服务器本地日期）；todayProvider 可选注入（进程内夹具用固定值），缺省取系统本地日期。
  const today = () => (typeof ctx.todayProvider === 'function' ? ctx.todayProvider() : confirmCore.localDateString(new Date()));

  // ── 统一错误出口（与 projects.js 同款）──────────────────────────────────────────────────
  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 成员接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  // 真实站点里 server.js 的全局 JSON 解析先于本模块应答（见 projects.js 同处注释）；这个 16kb 解析器只在进程内夹具里起作用。
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));

  // 先可见性、再补齐其余身份字段：看不见的人（不存在 / 非成员）只付 loadProjectAccess 的查询就得到 404。
  async function visibleFor(q, user, projectId) {
    const access = await rules.loadProjectAccess(q, projectId, user, accessOpts());
    rules.assertVisible(access);
    return rules.completeIdentity(q, access, user);
  }
  const loadParty = (q, partyId) => q.get('SELECT id, project_id, side, name FROM sysbuild_parties WHERE id = ?', [partyId]);
  const loadMember = (q, memberId) => q.get('SELECT id, project_id, party_id, user_id, person_name, joined_at, removed_at FROM sysbuild_members WHERE id = ?', [memberId]);
  const loadAppointment = (q, apptId) => q.get(`SELECT ${APPT_COLS} ${APPT_FROM} WHERE a.id = ?`, [apptId]);
  const loadDelegation = (q, did) => q.get(`SELECT ${DELEGATION_COLS} ${DELEGATION_FROM} WHERE d.id = ?`, [did]);

  // ── POST /sysbuild/projects/:id/parties：新建参与方 ───────────────────────────────────────
  // PM 或 admin（非只读，admin 不必先接管）；{ side: 'demand' | 'dev', name }；开发方每项目至多一个（已有 → 409 SYSBUILD_STATE，不让唯一索引报 500）。
  router.post('/sysbuild/projects/:id/parties', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const body = bodyOf(req);
    const side = body.side;
    if (typeof side !== 'string' || !schema.ENUMS.partySide.includes(side)) throw invalid(`side 必须是 ${schema.ENUMS.partySide.join(' / ')} 之一`, 'side');
    const name = readText(body.name, 'name', '参与方名称', NAME_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const identity = await visibleFor(q, user, pid);
      const dev = await q.get("SELECT id FROM sysbuild_parties WHERE project_id = ? AND side = 'dev' LIMIT 1", [pid]);
      // C4a P35：本项目有待确认的立项包 / 总体规划包时不能新建需求部门参与方（必需确认人集合已随提交生成；identity.hasPendingContentPackage 在本事务内现查，
      //   与读接口 actions.party_sides 同源）。C2 代码按 C4a 修订批派单改动。
      rules.assertOp('party_add', identity, identity.project, { side, hasDevParty: !!dev, hasPendingContentPackage: !!identity.hasPendingContentPackage });
      const mx = await q.get('SELECT COALESCE(MAX(sort_order), 0) AS top FROM sysbuild_parties WHERE project_id = ?', [pid]);
      const sortOrder = mx.top + 1;
      const ins = await q.run('INSERT INTO sysbuild_parties (project_id, side, name, sort_order, created_by) VALUES (?, ?, ?, ?, ?)', [pid, side, name, sortOrder, Number(user.id)]);
      await emit(q, user, pid, 'party', ins.lastID, 'party_created', { side, name });
      return { party: { id: ins.lastID, side, name, sort_order: sortOrder } };
    });
    res.status(201).json(out);
  }));

  // ── PATCH /sysbuild/parties/:pid：改参与方名称 ───────────────────────────────────────────
  router.patch('/sysbuild/parties/:pid', parseJsonBody, handle(async (req, res) => {
    const partyId = rules.parseId(req.params.pid);
    if (!partyId) throw invalid('参与方编号不合法', 'pid');
    const body = bodyOf(req);
    for (const k of Object.keys(body)) {
      if (k !== 'name') throw invalid(`不能通过本接口修改 ${k}`, k);
    }
    const name = readText(body.name, 'name', '参与方名称', NAME_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const party = await loadParty(q, partyId);
      if (!party) throw rules.notFound();
      const identity = await visibleFor(q, user, party.project_id);
      rules.assertOp('party_rename', identity, identity.project, {});
      let changed = false;
      if (party.name !== name) {
        const r = await q.run('UPDATE sysbuild_parties SET name = ? WHERE id = ? AND name = ?', [name, partyId, party.name]);
        if (r.changes === 0) throw stateError('参与方已变化，请刷新后重试');
        await emit(q, user, party.project_id, 'party', partyId, 'party_renamed', { before: party.name, after: name });
        changed = true;
      }
      return { party: { id: partyId, side: party.side, name }, changed };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/members：添加成员 / 发加入邀请 ────────────────────────────
  // PM 或 admin（非只读，admin 不必先接管；目标不得是操作人本人，D2）；{ party_id | null, user_id } 有账号 → 成员行待接受 + 加入邀请；{ party_id | null, person_name } 无账号 → 直接已加入、不建邀请（名录性质）。
  router.post('/sysbuild/projects/:id/members', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const body = bodyOf(req);
    const partyId = readId(body.party_id, 'party_id', '参与方', false);
    const hasUser = present(body.user_id);
    const hasName = present(body.person_name);
    if (hasUser && hasName) throw invalid('user_id 与 person_name 只能给一个', 'user_id');
    if (!hasUser && !hasName) throw invalid('user_id 与 person_name 必须给一个', 'user_id');
    const userId = hasUser ? readId(body.user_id, 'user_id', '用户', true) : null;
    const personName = hasName ? readText(body.person_name, 'person_name', '姓名', NAME_MAX, true) : null;
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const identity = await visibleFor(q, user, pid);
      rules.assertOp('member_add', identity, identity.project, {});
      if (partyId !== null) {
        const party = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [partyId, pid]);
        if (!party) throw invalid('参与方不存在或不属于本项目', 'party_id');
      }
      if (userId !== null) {
        const u = await q.get('SELECT id, status FROM users WHERE id = ?', [userId]);
        if (!u || u.status !== 'active') throw invalid('用户不存在或账号不可用', 'user_id');
        rules.assertNotSelfTarget('member_add', identity, userId);
        if (userId === identity.project.pm_user_id) throw stateError('PM 本人已是本项目成员，不能再加为成员');
        const exist = await q.get('SELECT id, joined_at FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1', [pid, userId]);
        if (exist) throw stateError(exist.joined_at === null ? '该用户已有待接受的加入邀请' : '该用户已是本项目成员');
        const mIns = await q.run('INSERT INTO sysbuild_members (project_id, party_id, user_id, joined_at, added_by) VALUES (?, ?, ?, NULL, ?)', [pid, partyId, userId, uid]);
        const iIns = await q.run("INSERT INTO sysbuild_invitations (project_id, member_id, kind, appointment_id, status, invited_by) VALUES (?, ?, 'join', NULL, 'pending', ?)", [pid, mIns.lastID, uid]);
        await emit(q, user, pid, 'member', mIns.lastID, 'member_invited', { user_id: userId, party_id: partyId, invitation_id: iIns.lastID });
        await notifyCore.enqueueMemberIntent(q, { projectId: pid, memberId: mIns.lastID, purpose: notifyCore.PURPOSES.INVITATION, refType: notifyCore.REF_TYPES.INVITATION, refId: iIns.lastID }); // C6b：被邀请本人
        return {
          member: { id: mIns.lastID, party_id: partyId, user_id: userId, status: 'pending', joined_at: null },
          invitation: { id: iIns.lastID, kind: 'join', status: 'pending' },
        };
      }
      const mIns = await q.run("INSERT INTO sysbuild_members (project_id, party_id, person_name, joined_at, added_by) VALUES (?, ?, ?, datetime('now','localtime'), ?)", [pid, partyId, personName, uid]);
      await emit(q, user, pid, 'member', mIns.lastID, 'member_added', { user_id: null, person_name: personName, party_id: partyId, no_account: true });
      const row = await loadMember(q, mIns.lastID);
      return { member: { id: mIns.lastID, party_id: partyId, user_id: null, person_name: personName, status: 'joined', joined_at: row.joined_at }, invitation: null };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/members/:mid/remove：移出成员（级联）─────────────────────────────────────
  router.post('/sysbuild/members/:mid/remove', parseJsonBody, handle(async (req, res) => {
    const mid = rules.parseId(req.params.mid);
    if (!mid) throw invalid('成员编号不合法', 'mid');
    const reason = readText(bodyOf(req).reason, 'reason', '移出原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const member = await loadMember(q, mid);
      if (!member) throw rules.notFound();
      const identity = await visibleFor(q, user, member.project_id);
      const isPmRow = present(member.user_id) && Number(member.user_id) === Number(identity.project.pm_user_id);
      rules.assertOp('member_remove', identity, identity.project, { removed: member.removed_at !== null, isPmRow, targetUserId: member.user_id });
      const r = await q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = ? WHERE id = ? AND removed_at IS NULL", [reason, mid]);
      if (r.changes === 0) throw stateError('成员状态已变化，请刷新后重试');
      await emit(q, user, member.project_id, 'member', mid, 'member_removed', { user_id: member.user_id, party_id: member.party_id, reason, was_pending: member.joined_at === null });
      await cascadeMemberRemoval(q, user, member.project_id, mid);
      return { member: { id: mid, status: 'removed' } };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/parties/:pid/appointments：提议负责人任职 ───────────────────────────────
  router.post('/sysbuild/parties/:pid/appointments', parseJsonBody, handle(async (req, res) => {
    const partyId = rules.parseId(req.params.pid);
    if (!partyId) throw invalid('参与方编号不合法', 'pid');
    const memberId = readId(bodyOf(req).member_id, 'member_id', '成员', true);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const party = await loadParty(q, partyId);
      if (!party) throw rules.notFound();
      const identity = await visibleFor(q, user, party.project_id);
      const pend = await q.get("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'pending' LIMIT 1", [partyId]);
      rules.assertOp('appointment_propose', identity, identity.project, { hasPendingAppointment: !!pend });
      const m = await loadMember(q, memberId);
      if (!m || m.project_id !== party.project_id || m.party_id !== partyId) throw invalid('成员不存在或不属于该参与方', 'member_id');
      if (m.removed_at !== null) throw stateError('该成员已移出，不能任命');
      if (m.joined_at === null) throw stateError('该成员尚未接受加入，不能任命');
      rules.assertNotSelfTarget('appointment_propose', identity, m.user_id);
      if (present(m.user_id) && Number(m.user_id) === Number(identity.project.pm_user_id)) throw stateError('PM 不得兼任参与方负责人');
      const cur = await q.get("SELECT member_id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active' LIMIT 1", [partyId]);
      if (cur && cur.member_id === m.id) throw stateError('该成员已是本方现任负责人');
      const aIns = await q.run("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by) VALUES (?, ?, 'pending', ?)", [partyId, m.id, uid]);
      let invitation = null;
      if (present(m.user_id)) {
        const iIns = await q.run("INSERT INTO sysbuild_invitations (project_id, member_id, kind, appointment_id, status, invited_by) VALUES (?, ?, 'appointment', ?, 'pending', ?)", [party.project_id, m.id, aIns.lastID, uid]);
        invitation = { id: iIns.lastID, kind: 'appointment', status: 'pending' };
        await notifyCore.enqueueMemberIntent(q, { projectId: party.project_id, memberId: m.id, purpose: notifyCore.PURPOSES.INVITATION, refType: notifyCore.REF_TYPES.INVITATION, refId: iIns.lastID }); // C6b：被提议担任负责人的本人
      }
      await emit(q, user, party.project_id, 'appointment', aIns.lastID, 'appointment_proposed', {
        party_id: partyId, member_id: m.id, invitation_id: invitation ? invitation.id : null, no_account: !invitation,
      });
      return { appointment: { id: aIns.lastID, party_id: partyId, member_id: m.id, status: 'pending' }, invitation };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/appointments/:apid/withdraw、/end ─────────────────────────────────────
  router.post('/sysbuild/appointments/:apid/withdraw', parseJsonBody, handle(async (req, res) => {
    const apid = rules.parseId(req.params.apid);
    if (!apid) throw invalid('任职编号不合法', 'apid');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const a = await loadAppointment(q, apid);
      if (!a) throw rules.notFound();
      const identity = await visibleFor(q, user, a.project_id);
      rules.assertOp('appointment_withdraw', identity, identity.project, { status: a.status, targetUserId: a.user_id });
      await moveAppointment(q, user, a.project_id, a, 'withdrawn', 'appointment_withdrawn', {});
      await withdrawInvitationsOfAppointment(q, user, apid, { reason: '任职提议已撤回' });
      return { appointment: { id: apid, status: 'withdrawn' } };
    });
    res.json(out);
  }));
  router.post('/sysbuild/appointments/:apid/end', parseJsonBody, handle(async (req, res) => {
    const apid = rules.parseId(req.params.apid);
    if (!apid) throw invalid('任职编号不合法', 'apid');
    const reason = readText(bodyOf(req).reason, 'reason', '结束原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const a = await loadAppointment(q, apid);
      if (!a) throw rules.notFound();
      const identity = await visibleFor(q, user, a.project_id);
      rules.assertOp('appointment_end', identity, identity.project, { status: a.status, targetUserId: a.user_id });
      await endAppointment(q, user, a.project_id, a, reason, '负责人任职已结束，需重新授权');
      return { appointment: { id: apid, status: 'ended' } };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/parties/:pid/delegations：发起代表人授权 ───────────────────────────────
  // 发起人是本方现任负责人（含只读账号）→ 直接待被授权人接受（pending_accept）；是 PM → 待负责人确认（pending_owner）；其他人 403。
  router.post('/sysbuild/parties/:pid/delegations', parseJsonBody, handle(async (req, res) => {
    const partyId = rules.parseId(req.params.pid);
    if (!partyId) throw invalid('参与方编号不合法', 'pid');
    const memberId = readId(bodyOf(req).member_id, 'member_id', '成员', true);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const party = await loadParty(q, partyId);
      if (!party) throw rules.notFound();
      const identity = await visibleFor(q, user, party.project_id);
      const cur = await q.get("SELECT id, member_id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active' LIMIT 1", [partyId]);
      const pend = await q.get("SELECT id FROM sysbuild_delegations WHERE party_id = ? AND status IN ('pending_owner', 'pending_accept') LIMIT 1", [partyId]);
      rules.assertOp('delegation_propose', identity, identity.project, { party_id: partyId, currentAppointmentId: cur ? cur.id : null, hasPendingDelegation: !!pend });
      const initial = rules.delegationInitialStatus(identity, partyId);
      const m = await loadMember(q, memberId);
      if (!m || m.project_id !== party.project_id || m.party_id !== partyId) throw invalid('成员不存在或不属于该参与方', 'member_id');
      if (m.removed_at !== null) throw stateError('该成员已移出，不能授权');
      if (m.joined_at === null) throw stateError('该成员尚未接受加入，不能授权');
      // C4b Q-D1（用户 2026-11-04 确认）：无账号成员可以被授权为代表人——批准 / 接受两步里无账号的一方只能由 PM 代录（POST …/delegations/:did/proxy）；
      //   其余前置（已加入、未移出、PM 不得兼任、与负责人分设）不变。无账号成员没有 user_id，PM 兼任判断天然不适用。
      if (present(m.user_id) && Number(m.user_id) === Number(identity.project.pm_user_id)) throw stateError('PM 不得兼任参与方代表人');
      if (m.id === cur.member_id) throw stateError('负责人与代表人须分设，不能授权给本方现任负责人本人');
      const act = await q.get("SELECT member_id FROM sysbuild_delegations WHERE party_id = ? AND status = 'active' LIMIT 1", [partyId]);
      if (act && act.member_id === m.id) throw stateError('该成员已是本方生效代表人');
      const ins = await q.run('INSERT INTO sysbuild_delegations (party_id, member_id, appointment_id, status, proposed_by) VALUES (?, ?, ?, ?, ?)', [partyId, m.id, cur.id, initial, uid]);
      await emit(q, user, party.project_id, 'delegation', ins.lastID, 'delegation_proposed', {
        party_id: partyId, member_id: m.id, appointment_id: cur.id, initial_status: initial,
      });
      if (initial === 'pending_accept') await enqueueDelegationIntent(q, party.project_id, { id: ins.lastID, member_id: m.id });
      return { delegation: { id: ins.lastID, party_id: partyId, member_id: m.id, appointment_id: cur.id, status: initial } };
    });
    res.status(201).json(out);
  }));

  // ── 授权的负责人确认 / 撤销 / 撤回（走项目可见性）─────────────────────────────────────────
  function delegationAction(opName, apply) {
    return handle(async (req, res) => {
      const did = rules.parseId(req.params.did);
      if (!did) throw invalid('授权编号不合法', 'did');
      const reason = opName === 'delegation_revoke' ? readText(bodyOf(req).reason, 'reason', '撤销原因', REASON_MAX, true) : null;
      const user = req.user;
      const out = await db.withWriteTxn(async (q) => {
        const d = await loadDelegation(q, did);
        if (!d) throw rules.notFound();
        const identity = await visibleFor(q, user, d.project_id);
        rules.assertOp(opName, identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));
        return apply(q, user, d, reason);
      });
      res.json(out);
    });
  }
  router.post('/sysbuild/delegations/:did/approve', parseJsonBody, delegationAction('delegation_approve', async (q, user, d) => {
    await moveDelegation(q, user, d.project_id, d, 'pending_accept', 'delegation_approved', {});
    return { delegation: { id: d.id, status: 'pending_accept' } };
  }));
  router.post('/sysbuild/delegations/:did/reject', parseJsonBody, delegationAction('delegation_reject', async (q, user, d) => {
    await moveDelegation(q, user, d.project_id, d, 'rejected', 'delegation_rejected', { by: 'owner' });
    return { delegation: { id: d.id, status: 'rejected' } };
  }));
  router.post('/sysbuild/delegations/:did/revoke', parseJsonBody, delegationAction('delegation_revoke', async (q, user, d, reason) => {
    await revokeDelegation(q, user, d.project_id, d, reason);
    return { delegation: { id: d.id, status: 'revoked' } };
  }));
  router.post('/sysbuild/delegations/:did/withdraw', parseJsonBody, delegationAction('delegation_withdraw', async (q, user, d) => {
    await moveDelegation(q, user, d.project_id, d, 'withdrawn', 'delegation_withdrawn', {});
    return { delegation: { id: d.id, status: 'withdrawn' } };
  }));

  // ── 被授权人本人接受 / 拒绝授权（接受类例外：第三步是「指向本人」，不走成员可见性）─────────────
  function delegationResponse(decision) {
    const opName = decision === 'accept' ? 'delegation_accept' : 'delegation_decline';
    return handle(async (req, res) => {
      const did = rules.parseId(req.params.did);
      if (!did) throw invalid('授权编号不合法', 'did');
      const user = req.user;
      const out = await db.withWriteTxn(async (q) => {
        const d = await loadDelegation(q, did);
        if (!d || !present(d.user_id) || Number(d.user_id) !== Number(user.id)) throw rules.notFound();
        const identity = await rules.loadProjectIdentity(q, d.project_id, user, accessOpts());
        if (!identity.project) throw rules.notFound();
        const verdict = rules.checkOp(opName, identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));
        if (verdict && verdict.stale) {
          // 资格重核不通过：这条提议永远不会再有效，置为已撤回并提交，再报 409。
          await moveDelegation(q, user, d.project_id, d, 'withdrawn', 'delegation_withdrawn', { reason: verdict.message, stale: true });
          return { stale: verdict.message };
        }
        if (verdict) throw makeError(verdict.status, verdict.code, verdict.message);
        if (decision === 'accept') {
          await activateDelegation(q, user, d.project_id, d);
          return { delegation: { id: did, status: 'active' }, project_id: d.project_id };
        }
        await moveDelegation(q, user, d.project_id, d, 'rejected', 'delegation_rejected', { by: 'delegate' });
        return { delegation: { id: did, status: 'rejected' }, project_id: d.project_id };
      });
      if (out.stale) throw stateError(out.stale);
      res.json(out);
    });
  }
  router.post('/sysbuild/delegations/:did/accept', parseJsonBody, delegationResponse('accept'));
  router.post('/sysbuild/delegations/:did/decline', parseJsonBody, delegationResponse('decline'));

  // ── C4b Q-S1：无账号成员的任职接受 / 授权批准与接受，由本项目 PM 代录（Q-D1；方案 §4.2「代录」）──────────────────────────────
  // 代录统一为「先有任务再代录」（P45）：C2 的任职 / 授权不走确认任务（邀请或直接端点），所以代录时在同一写事务里建立「邀请 / 授权」类确认任务与首条修订
  //   （当场置为已确认），再写代录确认记录 + 凭据附件，最后走原来的激活函数（任职生效含原负责人更换，授权生效含原代表人更换；批准一步推进到待接受）。
  //   请求体 = 代录的四个凭据字段；授权端点另必带 expected_step（grant / accept），锁定本次凭据对应的步骤。
  //   检查顺序：400 参数形态 → 404 对象不存在或不可见 → 403 非本项目 PM → 409 项目状态 / 对象状态（有账号的人走本人入口）→ 400 外部日期范围与附件可用性。
  //   外部日期下限 = 该任职 / 授权提议的创建日（凭据日期早于提议出现的那天不可能对应它；代录当场才建的修订日期不能当下限，否则只能填今天）。
  function proxyEvidenceOf(req, extraKeys) {
    const body = bodyOf(req);
    for (const k of Object.keys(body)) {
      if (!confirmCore.PROXY_KEYS.includes(k) && !(extraKeys || []).includes(k)) throw invalid(`不支持的字段 ${k}`, k);
    }
    return confirmCore.readProxyEvidence(body, '代录');
  }
  router.post('/sysbuild/appointments/:apid/proxy-accept', parseJsonBody, handle(async (req, res) => {
    const apid = rules.parseId(req.params.apid);
    if (!apid) throw invalid('任职编号不合法', 'apid');
    const evidence = proxyEvidenceOf(req);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const a = await loadAppointment(q, apid);
      if (!a) throw rules.notFound();
      const identity = await visibleFor(q, user, a.project_id);
      rules.assertOp('appointment_proxy_accept', identity, identity.project, appointmentProxyTarget(a, await appointmentConflictOf(q, a)));
      confirmCore.assertProxyDate(evidence.externalDate, a.created_at, today(), '任职提议的创建日期');
      const inv = await q.run(
        "INSERT INTO sysbuild_invitations (project_id, member_id, kind, appointment_id, status, invited_by, responded_at) VALUES (?, ?, 'appointment', ?, 'accepted', ?, datetime('now','localtime'))",
        [a.project_id, a.member_id, apid, uid]
      );
      await emit(q, user, a.project_id, 'invitation', inv.lastID, 'invitation_accepted', { kind: 'appointment', member_id: a.member_id, appointment_id: apid, via: 'proxy' });
      const t = await confirmCore.createTaskWithRevision(q, user, {
        projectId: a.project_id, objectType: 'invitation', objectId: inv.lastID, objectVersionId: inv.lastID, purpose: 'accept_invitation', partyId: a.party_id,
        requiredMemberId: a.member_id, basisAppointmentId: null, basisDelegationId: null, notify: false, // C6b：代录当场已确认，不发「请确认」
      });
      await confirmCore.settleRevision(q, t.revisionId, 'confirmed');
      const rec = await confirmCore.recordProxyConfirmation(q, user, attachmentHelpers, {
        projectId: a.project_id, taskId: t.taskId, revisionId: t.revisionId, objectType: 'invitation', objectVersionId: inv.lastID,
        requiredMemberId: a.member_id, actorUserId: null, decision: 'confirm', reason: null, evidence,
      });
      await activateAppointment(q, user, a.project_id, a);
      await emit(q, user, a.project_id, 'appointment', apid, 'appointment_proxy_accepted', {
        party_id: a.party_id, member_id: a.member_id, invitation_id: inv.lastID, task_id: t.taskId, revision_id: t.revisionId, confirmation_id: rec.confirmationId,
      });
      return {
        appointment: { id: apid, status: 'active' }, invitation: { id: inv.lastID, kind: 'appointment', status: 'accepted' },
        task_id: t.taskId, revision_id: t.revisionId, confirmation_id: rec.confirmationId, attachment_ids: rec.attachmentIds,
      };
    });
    res.json(out);
  }));
  // 授权「接受」一步的外部日期下限 = 负责人批准日（codex 21 号 L1）。来源，按可靠性从高到低：
  //   ① 批准一步是代录的 → 那条 delegation_grant 代录确认记录的 external_date（凭据上的日期，比操作日期更接近真实批准）；
  //   ② 批准一步是平台批准 → 批准端点写的 delegation_approved 事件的 created_at（操作发生的服务器本地时间；授权表本身没有批准时间列）；
  //   ③ 没有批准记录（本方负责人自己提议、直接进待接受）→ 提议创建日。
  //   ①② 的取法在 confirm-core.js delegationApprovedOn（与历史导入的批准日核对共用，预筛 LOW-3），这里只加 ③ 的回落。
  async function delegationApprovalFloor(q, d) {
    return (await confirmCore.delegationApprovedOn(q, d.id)) || d.created_at;
  }
  router.post('/sysbuild/delegations/:did/proxy', parseJsonBody, handle(async (req, res) => {
    const did = rules.parseId(req.params.did);
    if (!did) throw invalid('授权编号不合法', 'did');
    const evidence = proxyEvidenceOf(req, ['expected_step']);
    const expectedStep = bodyOf(req).expected_step;
    if (!['grant', 'accept'].includes(expectedStep)) throw invalid('请选择本次代录的授权步骤（grant / accept）', 'expected_step');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const d = await loadDelegation(q, did);
      if (!d) throw rules.notFound();
      const identity = await visibleFor(q, user, d.project_id);
      rules.assertOp('delegation_proxy', identity, identity.project, delegationTarget(d, identity.project, await delegationConflictOf(q, d)));
      // 先锁定请求意图，再写任务 / 凭据；旧页重试不能把批准凭据记成本人接受。
      const grant = expectedStep === 'grant';
      if (d.status !== (grant ? 'pending_owner' : 'pending_accept')) throw stateError('授权步骤已变化，请刷新后按当前步骤重新代录');
      // codex 21 号 L1：外部日期下限——批准一步 = 提议创建日；接受一步 = 负责人批准日（接受不可能早于批准）。批准日来源见 delegationApprovalFloor。
      confirmCore.assertProxyDate(evidence.externalDate, grant ? d.created_at : await delegationApprovalFloor(q, d), today(), grant ? '授权提议的创建日期' : '负责人批准日');
      const owner = grant ? await q.get('SELECT member_id FROM sysbuild_appointments WHERE id = ?', [d.appointment_id]) : null;
      const requiredMemberId = grant ? owner.member_id : d.member_id;
      const t = await confirmCore.createTaskWithRevision(q, user, {
        projectId: d.project_id, objectType: 'delegation', objectId: did, objectVersionId: did, purpose: grant ? 'delegation_grant' : 'delegation_accept', partyId: d.party_id,
        requiredMemberId, basisAppointmentId: grant ? d.appointment_id : null, basisDelegationId: null, notify: false, // C6b：代录当场已确认，不发「请确认」
      });
      await confirmCore.settleRevision(q, t.revisionId, 'confirmed');
      const rec = await confirmCore.recordProxyConfirmation(q, user, attachmentHelpers, {
        projectId: d.project_id, taskId: t.taskId, revisionId: t.revisionId, objectType: 'delegation', objectVersionId: did,
        requiredMemberId, actorUserId: null, decision: 'confirm', reason: null, evidence,
      });
      if (grant) await moveDelegation(q, user, d.project_id, d, 'pending_accept', 'delegation_approved', { via: 'proxy' });
      else await activateDelegation(q, user, d.project_id, d);
      await emit(q, user, d.project_id, 'delegation', did, grant ? 'delegation_proxy_granted' : 'delegation_proxy_accepted', {
        party_id: d.party_id, member_id: d.member_id, required_member_id: requiredMemberId, task_id: t.taskId, revision_id: t.revisionId, confirmation_id: rec.confirmationId,
      });
      return {
        delegation: { id: did, status: grant ? 'pending_accept' : 'active' }, step: grant ? 'grant' : 'accept',
        task_id: t.taskId, revision_id: t.revisionId, confirmation_id: rec.confirmationId, attachment_ids: rec.attachmentIds,
      };
    });
    res.json(out);
  }));

  // ── 受邀人窄范围入口 ───────────────────────────────────────────────────────────────────
  // 只返回：项目名称、角色（加入哪一方 / 任哪一方负责人）、邀请人显示名、发起时间、所授权限说明、当前状态，外加本人可作的动作；
  //   不返回成员列表、参与方列表以外的任何项目内容（§5.1）。
  function roleOf(type, side, partyName) {
    return { type, side: side === undefined ? null : side, party_name: partyName === undefined ? null : partyName };
  }
  async function invitationView(q, user, row) {
    const act = await invitationActionsOf(q, user, row, accessOpts());
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      project: { system_name: row.system_name, phase_name: row.phase_name },
      role: roleOf(row.kind, row.side, row.party_name),
      invited_by_name: row.invited_by_name,
      invited_at: row.created_at,
      permission_note: PERMISSION_NOTES[row.kind],
      actions: { accept: act.accept, decline: act.decline },
    };
  }
  //   C6b 修订批 1（P183）：列表取数抽成 myInvitationItems(q, user)，GET /my/todo 的 accept 类读同一个函数（与本端点同源，不另写第二份口径）。
  async function myInvitationItems(q, user) {
    const uid = Number(user.id);
    {
      const rows = await q.all(`${INVITATION_SELECT} WHERE m.user_id = ? AND i.status = 'pending' AND m.removed_at IS NULL ORDER BY i.id`, [uid]);
      const invitations = [];
      for (const r of rows) invitations.push(await invitationView(q, user, r));
      const dels = await q.all(`${DELEGATION_ITEM_SELECT} WHERE m.user_id = ? AND d.status = 'pending_accept' AND m.removed_at IS NULL ORDER BY d.id`, [uid]);
      const delegations = [];
      for (const d of dels) {
        const act = await delegationActionsOf(q, user, d, accessOpts());
        delegations.push({
          id: d.id,
          status: d.status,
          project: { system_name: d.system_name, phase_name: d.phase_name },
          role: roleOf('delegation', d.side, d.party_name),
          proposed_by_name: d.proposed_by_name,
          proposed_at: d.created_at,
          permission_note: PERMISSION_NOTES.delegation,
          actions: { accept: act.accept, decline: act.decline },
        });
      }
      return { invitations, delegations };
    }
  }
  router.get('/sysbuild/my/invitations', handle(async (req, res) => {
    const out = await db.withRead((q) => myInvitationItems(q, req.user));
    res.json(out);
  }));
  router.get('/sysbuild/my/invitations/:iid', handle(async (req, res) => {
    const iid = rules.parseId(req.params.iid);
    if (!iid) throw invalid('邀请编号不合法', 'iid');
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const row = await q.get(`${INVITATION_SELECT} WHERE i.id = ?`, [iid]);
      // 接受类例外（§5.3）：只对「指向本人的有效邀请」返回——不是本人的、已处理（接受 / 拒绝 / 撤回）的、成员行已移出的，
      //   一律与不存在同一响应；不再走成员可见性（L4：已处理 / 已移出的邀请不再暴露项目名与参与方现名）。
      if (!row || !present(row.user_id) || Number(row.user_id) !== Number(user.id)) throw rules.notFound();
      if (row.status !== 'pending' || row.removed_at !== null) throw rules.notFound();
      return { invitation: await invitationView(q, user, row) };
    });
    res.json(out);
  }));

  // ── 受邀人本人接受 / 拒绝邀请 ───────────────────────────────────────────────────────────
  function invitationResponse(decision) {
    const opName = decision === 'accept' ? 'invitation_accept' : 'invitation_decline';
    return handle(async (req, res) => {
      const iid = rules.parseId(req.params.iid);
      if (!iid) throw invalid('邀请编号不合法', 'iid');
      const user = req.user;
      const out = await db.withWriteTxn(async (q) => {
        const row = await q.get(`${INVITATION_SELECT} WHERE i.id = ?`, [iid]);
        if (!row || !present(row.user_id) || Number(row.user_id) !== Number(user.id)) throw rules.notFound();
        const identity = await rules.loadProjectIdentity(q, row.project_id, user, accessOpts());
        if (!identity.project) throw rules.notFound();
        const project = identity.project;
        const verdict = rules.checkOp(opName, identity, project, invitationTarget(project, row, row.appt_status, readonlySetOf(ctx.readonlyIds), await invitationConflictOf(q, row)));
        if (verdict && verdict.stale) {
          // 只有「接受」会走到这里（拒绝不重核）。邀请人已无权等：邀请置为已撤回，同事务收掉关联的成员行 / 任职（M1 ②），
          //   提交后（回调不抛错）再在事务外报 409。
          await settleStaleInvitation(q, user, row, verdict.message, 'accept');
          return { stale: verdict.message };
        }
        if (verdict) throw makeError(verdict.status, verdict.code, verdict.message);
        if (row.kind === 'join') {
          if (decision === 'accept') {
            const j = await q.run("UPDATE sysbuild_members SET joined_at = datetime('now','localtime') WHERE id = ? AND joined_at IS NULL AND removed_at IS NULL", [row.member_id]);
            if (j.changes === 0) throw stateError('成员状态已变化，请刷新后重试');
            await moveInvitation(q, user, row, 'accepted', {});
            // 成员行从待接受转为已加入是成员对象自己的状态转移：单独写 member_joined（不复用 member_added——那是建成员行时的语义，codex 16 号 M-3）。
            await emit(q, user, row.project_id, 'member', row.member_id, 'member_joined', { user_id: row.user_id, party_id: row.party_id, invitation_id: row.id });
          } else {
            await moveInvitation(q, user, row, 'declined', {});
            const rm = await q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = ? WHERE id = ? AND removed_at IS NULL AND joined_at IS NULL", ['拒绝加入', row.member_id]);
            if (rm.changes === 0) throw stateError('成员状态已变化，请刷新后重试');
            await emit(q, user, row.project_id, 'member', row.member_id, 'member_removed', { user_id: row.user_id, party_id: row.party_id, reason: '拒绝加入', via: 'decline' });
          }
        } else {
          const appt = await q.get('SELECT id, party_id, member_id, status FROM sysbuild_appointments WHERE id = ?', [row.appointment_id]);
          if (decision === 'accept') {
            await moveInvitation(q, user, row, 'accepted', {});
            await activateAppointment(q, user, row.project_id, appt);
          } else {
            await moveInvitation(q, user, row, 'declined', {});
            // 拒绝不重核：邀请人失权、任职已变化时也能回绝；任职仍待接受才置 rejected（其余状态不动，避免违反任职表的状态 / 时间联动 CHECK）。
            if (appt && appt.status === 'pending') await moveAppointment(q, user, row.project_id, appt, 'rejected', 'appointment_rejected', {});
          }
        }
        return { invitation: { id: iid, kind: row.kind, status: decision === 'accept' ? 'accepted' : 'declined' }, project_id: row.project_id };
      });
      if (out.stale) throw stateError(out.stale);
      res.json(out);
    });
  }
  router.post('/sysbuild/my/invitations/:iid/accept', parseJsonBody, invitationResponse('accept'));
  router.post('/sysbuild/my/invitations/:iid/decline', parseJsonBody, invitationResponse('decline'));

  return { router, myInvitationItems }; // myInvitationItems：C6b GET /my/todo 的 accept 类用（与 GET /my/invitations 同源）
}

// activateAppointment / activateDelegation / moveDelegation：历史事实导入（history.js，C4b Q-S2）复用，生效 / 推进的状态写法与本人接受路径同一份，不复制。
module.exports = { createMembershipRoutes, decorateDetail, withdrawInvitationsOfInviter, activateAppointment, activateDelegation, moveDelegation, withdrawInvitationsOfAppointment, INVITATION_SELECT, DELEGATION_ITEM_SELECT, invitationActionsOf, delegationActionsOf };
