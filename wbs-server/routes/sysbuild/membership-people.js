'use strict';

const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');

const NAME_MAX = 50;
const REASON_MAX = 500;
const ASSIGNMENT_SOURCE = 'direct_assignment';
const hasKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const stateError = (message, field) => Object.assign(makeError(409, 'SYSBUILD_STATE', message), field ? { field } : {});
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), { field });

function readText(value, field, label, limit) {
  if (value === undefined || value === null) throw invalid(`${label}必填`, field);
  if (typeof value !== 'string') throw invalid(`${label}必须是文本`, field);
  const text = value.trim();
  if (!text) throw invalid(`${label}必填`, field);
  if (rules.hasControlChar(text)) throw invalid(`${label}不能包含控制字符`, field);
  if (Array.from(text).length > limit) throw invalid(`${label}不能超过 ${limit} 个字符`, field);
  return text;
}

function readId(value, field, label, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw invalid(`${label}必填`, field);
  }
  const id = rules.parseId(value);
  if (id === null) throw invalid(`${label}编号不合法`, field);
  return id;
}

function assertFields(value, fields, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('人员指定参数必须是 JSON 对象', prefix || 'body');
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw invalid('不支持的人员指定字段', prefix ? `${prefix}.${key}` : key);
  }
}

function readPair(value, side, prefix = '') {
  const leaderField = prefix + 'leader_user_id';
  const representativeField = prefix + 'representative_user_id';
  const leaderId = readId(value.leader_user_id, leaderField, '领导账号');
  const representativeId = readId(value.representative_user_id, representativeField, '负责人账号', side === 'dev');
  if (leaderId === representativeId) throw invalid('领导与负责人须由不同账号担任', representativeField);
  return { leaderId, representativeId, leaderField, representativeField };
}

function readParty(value, side, prefix = '') {
  assertFields(value, prefix ? ['name', 'leader_user_id', 'representative_user_id'] : ['side', 'name', 'leader_user_id', 'representative_user_id'], prefix.slice(0, -1));
  return { side, name: readText(value.name, prefix + 'name', '参与方名称', NAME_MAX), ...readPair(value, side, prefix) };
}

function readInitialParties(body) {
  if (!Array.isArray(body.demand_parties) || body.demand_parties.length === 0) {
    throw invalid('至少指定一个需求部门及其领导、负责人', 'demand_parties');
  }
  const parties = body.demand_parties.map((value, index) => readParty(value, 'demand', `demand_parties[${index}].`));
  if (body.dev_party !== undefined && body.dev_party !== null) parties.push(readParty(body.dev_party, 'dev', 'dev_party.'));
  return parties;
}

function readRoleChange(body) {
  assertFields(body, ['leader_user_id', 'representative_user_id', 'expected_appointment_id', 'expected_delegation_id', 'reason']);
  for (const field of ['expected_appointment_id', 'expected_delegation_id', 'representative_user_id']) {
    if (!hasKey(body, field)) throw invalid('必须提供当前身份或明确留空', field);
  }
  return {
    ...readPair(body, 'dev'),
    expectedAppointmentId: readId(body.expected_appointment_id, 'expected_appointment_id', '任职', true),
    expectedDelegationId: readId(body.expected_delegation_id, 'expected_delegation_id', '授权', true),
    reason: readText(body.reason, 'reason', '更换原因', REASON_MAX),
  };
}

function emit(q, operator, projectId, objectType, objectId, eventType, payload) {
  return writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(operator.id),
    operatorName: operator.display_name || operator.username || ('user#' + operator.id),
  });
}

async function eligibleMember(q, project, operator, userId, field, partyId, reuse) {
  const user = await q.get('SELECT id, status FROM users WHERE id = ?', [userId]);
  if (!user || user.status !== 'active') throw invalid('账号不存在或不可用', field);
  if (userId === Number(operator.id) || userId === Number(project.pm_user_id)) throw stateError('不能把项目经理或操作人指定为普通成员、领导或负责人', field);
  const member = await q.get(
    'SELECT id, user_id, party_id, joined_at FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1',
    [project.id, userId]
  );
  if (!member) return null;
  if (member.party_id !== partyId) throw stateError('该账号已有其他项目内归属，请先移出后再添加', field);
  if (!reuse || member.joined_at === null) throw stateError('该账号已有本项目成员记录', field);
  return member;
}

async function addMemberRow(q, operator, projectId, partyId, userId) {
  const ins = await q.run(
    "INSERT INTO sysbuild_members (project_id, party_id, user_id, joined_at, added_by) VALUES (?, ?, ?, datetime('now','localtime'), ?)",
    [projectId, partyId, userId, Number(operator.id)]
  );
  await emit(q, operator, projectId, 'member', ins.lastID, 'member_added', { user_id: userId, party_id: partyId, source: ASSIGNMENT_SOURCE });
  return q.get('SELECT id, party_id, user_id, joined_at FROM sysbuild_members WHERE id = ?', [ins.lastID]);
}

async function addMember(q, project, operator, partyId, userId) {
  await eligibleMember(q, project, operator, userId, 'user_id', partyId, false);
  return addMemberRow(q, operator, project.id, partyId, userId);
}

async function pairMembers(q, project, operator, partyId, pair, reuse) {
  return {
    leader: await eligibleMember(q, project, operator, pair.leaderId, pair.leaderField, partyId, reuse),
    representative: pair.representativeId === null ? null : await eligibleMember(q, project, operator, pair.representativeId, pair.representativeField, partyId, reuse),
  };
}

async function revokeDelegation(q, operator, projectId, delegation, reason) {
  const result = await q.run("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = ? WHERE id = ? AND status = 'active'", [reason, delegation.id]);
  if (!result.changes) throw stateError('授权状态已变化，请刷新后重试');
  await emit(q, operator, projectId, 'delegation', delegation.id, 'delegation_revoked', { party_id: delegation.party_id, member_id: delegation.member_id, reason });
}

async function endAppointment(q, operator, projectId, appointment, reason, revokeReason = reason) {
  const result = await q.run("UPDATE sysbuild_appointments SET status = 'ended', ended_at = datetime('now','localtime'), end_reason = ? WHERE id = ? AND status = 'active'", [reason, appointment.id]);
  if (!result.changes) throw stateError('任职状态已变化，请刷新后重试');
  await emit(q, operator, projectId, 'appointment', appointment.id, 'appointment_ended', { party_id: appointment.party_id, member_id: appointment.member_id, end_reason: reason });
  const delegations = await q.all("SELECT id, party_id, member_id FROM sysbuild_delegations WHERE appointment_id = ? AND party_id = ? AND status = 'active' ORDER BY id", [appointment.id, appointment.party_id]);
  for (const delegation of delegations) await revokeDelegation(q, operator, projectId, delegation, revokeReason);
}

async function assignLeader(q, operator, projectId, partyId, memberId, before, reason) {
  const result = await q.run(
    "INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at) VALUES (?, ?, 'active', ?, datetime('now','localtime'))",
    [partyId, memberId, Number(operator.id)]
  );
  await emit(q, operator, projectId, 'appointment', result.lastID, 'appointment_activated', {
    party_id: partyId, member_id: memberId, source: ASSIGNMENT_SOURCE, replaced: before ? [before.id] : [], reason,
  });
  return result.lastID;
}

async function assignRepresentative(q, operator, projectId, partyId, memberId, appointmentId, before, reason) {
  const result = await q.run(
    "INSERT INTO sysbuild_delegations (party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (?, ?, ?, 'active', ?, datetime('now','localtime'))",
    [partyId, memberId, appointmentId, Number(operator.id)]
  );
  await emit(q, operator, projectId, 'delegation', result.lastID, 'delegation_activated', {
    party_id: partyId, member_id: memberId, appointment_id: appointmentId, source: ASSIGNMENT_SOURCE, replaced: before ? [before.id] : [], reason,
  });
  return result.lastID;
}

async function addParty(q, project, operator, values) {
  await pairMembers(q, project, operator, null, values, false);
  const order = await q.get('SELECT COALESCE(MAX(sort_order), 0) AS top FROM sysbuild_parties WHERE project_id = ?', [project.id]);
  const sortOrder = order.top + 1;
  const ins = await q.run('INSERT INTO sysbuild_parties (project_id, side, name, sort_order, created_by) VALUES (?, ?, ?, ?, ?)',
    [project.id, values.side, values.name, sortOrder, Number(operator.id)]);
  const partyId = ins.lastID;
  await emit(q, operator, project.id, 'party', partyId, 'party_created', { side: values.side, name: values.name, source: ASSIGNMENT_SOURCE });
  const leader = await addMemberRow(q, operator, project.id, partyId, values.leaderId);
  const representative = values.representativeId === null ? null : await addMemberRow(q, operator, project.id, partyId, values.representativeId);
  const appointmentId = await assignLeader(q, operator, project.id, partyId, leader.id, null, null);
  if (representative) await assignRepresentative(q, operator, project.id, partyId, representative.id, appointmentId, null, null);
  return { id: partyId, side: values.side, name: values.name, sort_order: sortOrder };
}

async function addInitialParties(q, project, operator, parties) {
  const seen = new Set();
  for (const party of parties) {
    for (const [id, field] of [[party.leaderId, party.leaderField], [party.representativeId, party.representativeField]]) {
      if (id === null) continue;
      if (seen.has(id)) throw invalid('同一项目的指定账号不能重复', field);
      seen.add(id);
    }
  }
  for (const party of parties) await addParty(q, project, operator, party);
}

async function currentRoles(q, partyId) {
  const appointment = await q.get(
    "SELECT a.id, a.party_id, a.member_id, m.user_id FROM sysbuild_appointments a JOIN sysbuild_members m ON m.id = a.member_id WHERE a.party_id = ? AND a.status = 'active'",
    [partyId]
  );
  const delegation = await q.get(
    "SELECT d.id, d.party_id, d.member_id, d.appointment_id, m.user_id FROM sysbuild_delegations d JOIN sysbuild_members m ON m.id = d.member_id WHERE d.party_id = ? AND d.status = 'active'",
    [partyId]
  );
  return { appointment, delegation };
}

async function replacePeople(q, project, operator, party, values) {
  const { appointment, delegation } = await currentRoles(q, party.id);
  if ((appointment?.id ?? null) !== values.expectedAppointmentId || (delegation?.id ?? null) !== values.expectedDelegationId) {
    throw stateError('参与方的任职或授权已变化，请刷新后重试');
  }
  if (delegation && delegation.appointment_id !== appointment?.id) throw stateError('本方生效授权的任职依据已失效，请先撤销授权');
  if (values.representativeId === null && (party.side === 'demand' || delegation)) {
    throw invalid('请选择负责人，开发方已有负责人的可另行撤销授权', values.representativeField);
  }
  const existing = await pairMembers(q, project, operator, party.id, values, true);
  const leaderChanged = appointment?.user_id !== values.leaderId;
  const representativeChanged = (delegation?.user_id ?? null) !== values.representativeId;
  if (!leaderChanged && !representativeChanged) {
    return { changed: false, appointment_id: appointment.id, delegation_id: delegation?.id ?? null };
  }
  if (leaderChanged && appointment) await endAppointment(q, operator, project.id, appointment, values.reason);
  if (delegation && !leaderChanged && representativeChanged) {
    await revokeDelegation(q, operator, project.id, delegation, values.reason);
  }
  let appointmentId = appointment?.id;
  if (leaderChanged) {
    const member = existing.leader || await addMemberRow(q, operator, project.id, party.id, values.leaderId);
    appointmentId = await assignLeader(q, operator, project.id, party.id, member.id, appointment, values.reason);
  }
  let delegationId = delegation?.id ?? null;
  if ((leaderChanged || representativeChanged) && values.representativeId !== null) {
    const member = existing.representative || await addMemberRow(q, operator, project.id, party.id, values.representativeId);
    delegationId = await assignRepresentative(q, operator, project.id, party.id, member.id, appointmentId, delegation, values.reason);
  }
  return { changed: true, appointment_id: appointmentId, delegation_id: delegationId };
}

async function cascadeMemberRemoval(q, operator, projectId, memberId) {
  const appointments = await q.all("SELECT id, party_id, member_id FROM sysbuild_appointments WHERE member_id = ? AND status = 'active' ORDER BY id", [memberId]);
  for (const item of appointments) await endAppointment(q, operator, projectId, item, '成员移出', '领导已移出，需重新指定负责人');
  const delegations = await q.all("SELECT id, party_id, member_id FROM sysbuild_delegations WHERE member_id = ? AND status = 'active' ORDER BY id", [memberId]);
  for (const item of delegations) await revokeDelegation(q, operator, projectId, item, '成员移出');
}

module.exports = {
  NAME_MAX, REASON_MAX, ASSIGNMENT_SOURCE, invalid, stateError, emit, readId, readText, readParty,
  readInitialParties, readRoleChange, addInitialParties, addParty, addMember, replacePeople,
  endAppointment, revokeDelegation, cascadeMemberRemoval,
};
