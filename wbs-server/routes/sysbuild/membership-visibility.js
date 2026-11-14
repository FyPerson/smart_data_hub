// C8：C2未生效身份意图的可见谓词，成员页、任务和原始凭据读面同源。
// 只依赖rules，不依赖membership/confirm/attachments，避免读取助手成环。
'use strict';
const rules = require('./rules');
const managerOf = (identity) => !!(identity.isPm || identity.isAdmin);
const mineOf = (identity, row) => row.user_id !== null && row.user_id !== undefined && Number(row.user_id) === Number(identity.userId);
const activeMember = (row) => row.removed_at === null && row.joined_at !== null && row.joined_at !== undefined;
function memberVisible(identity, row) {
  return managerOf(identity) || activeMember(row);
}
function appointmentVisible(identity, row) {
  return managerOf(identity) || row.status === 'ended' || (activeMember(row) && (row.status === 'active' || (mineOf(identity, row) && row.status === 'pending')));
}
function delegationVisible(identity, row) {
  const ownerSees = rules.ownsParty(identity, row.party_id) && ['pending_owner', 'pending_accept', 'active'].includes(row.status);
  return managerOf(identity) || row.status === 'revoked' || (activeMember(row) && (row.status === 'active' || (mineOf(identity, row) && row.status === 'pending_accept') || ownerSees));
}
async function objectVisible(q, identity, projectId, type, objectId) {
  if (managerOf(identity)) return true;
  if (type === 'member') {
    const member = await q.get('SELECT user_id, joined_at, removed_at FROM sysbuild_members WHERE id = ? AND project_id = ?', [objectId, projectId]);
    return !!member && memberVisible(identity, member);
  }
  if (type === 'invitation') {
    const invitation = await q.get('SELECT kind, member_id, appointment_id FROM sysbuild_invitations WHERE id = ? AND project_id = ?', [objectId, projectId]);
    if (!invitation) return false;
    if (invitation.kind === 'join') return objectVisible(q, identity, projectId, 'member', invitation.member_id);
    if (invitation.kind === 'appointment') return objectVisible(q, identity, projectId, 'appointment', invitation.appointment_id);
    return false;
  }
  if (type === 'appointment') {
    const appointment = await q.get(`SELECT a.status AS status, a.party_id AS party_id, m.user_id AS user_id, m.joined_at AS joined_at, m.removed_at AS removed_at
      FROM sysbuild_appointments a JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_parties p ON p.id = a.party_id WHERE a.id = ? AND p.project_id = ?`, [objectId, projectId]);
    return !!appointment && appointmentVisible(identity, appointment);
  }
  if (type === 'delegation') {
    const delegation = await q.get(`SELECT d.status AS status, d.party_id AS party_id, m.user_id AS user_id, m.joined_at AS joined_at, m.removed_at AS removed_at
      FROM sysbuild_delegations d JOIN sysbuild_members m ON m.id = d.member_id JOIN sysbuild_parties p ON p.id = d.party_id WHERE d.id = ? AND p.project_id = ?`, [objectId, projectId]);
    return !!delegation && delegationVisible(identity, delegation);
  }
  return false;
}
async function taskVisible(q, identity, task) {
  if (task.object_type !== 'invitation' && task.object_type !== 'delegation') return true;
  return objectVisible(q, identity, task.project_id, task.object_type, task.object_id);
}
// 原始代录凭据跟随所属确认任务。其他业务附件保持原项目级查看口径。
async function attachmentVisible(q, identity, projectId, attachmentId) {
  if (managerOf(identity)) return true;
  const bindings = await q.all("SELECT owner_id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type = 'confirmation'", [attachmentId]);
  for (const binding of bindings) {
    const owner = await q.get(`SELECT c.task_revision_id AS task_revision_id, t.project_id AS project_id, t.object_type AS object_type, t.object_id AS object_id
      FROM sysbuild_confirmations c LEFT JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id LEFT JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE c.id = ?`, [binding.owner_id]);
    if (!owner) return false;
    if (owner.task_revision_id === null) continue;
    if (owner.project_id !== projectId || !(await taskVisible(q, identity, owner))) return false;
  }
  return true;
}
module.exports = { memberVisible, appointmentVisible, delegationVisible, objectVisible, taskVisible, attachmentVisible };
