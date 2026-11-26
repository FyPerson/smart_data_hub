'use strict';

const express = require('express');
const rules = require('./rules');
const { ENUMS } = require('./schema');
const visibility = require('./membership-visibility');
const people = require('./membership-people');
const { invalid, stateError, emit, readId, readText } = people;

const APPOINTMENT_ROWS = `SELECT a.id, a.party_id, a.member_id, a.status, a.effective_at, a.ended_at, a.end_reason,
  a.created_at, p.project_id, m.user_id, m.joined_at, m.removed_at, COALESCE(u.display_name, u.username) AS name
  FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id
  JOIN sysbuild_members m ON m.id = a.member_id LEFT JOIN users u ON u.id = m.user_id`;
const DELEGATION_ROWS = `SELECT d.id, d.party_id, d.member_id, d.appointment_id, d.status, d.effective_at, d.revoked_at,
  d.revoke_reason, d.created_at, p.project_id, m.user_id, m.joined_at, m.removed_at, COALESCE(u.display_name, u.username) AS name
  FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id
  JOIN sysbuild_members m ON m.id = d.member_id LEFT JOIN users u ON u.id = m.user_id`;

function bodyOf(req) {
  if (req.body === undefined || req.body === null) return {};
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw invalid('请求体必须是 JSON 对象', 'body');
  return req.body;
}

async function decorateDetail(q, identity, project, parties, members) {
  const appointments = await q.all(`${APPOINTMENT_ROWS} WHERE p.project_id = ? ORDER BY a.id`, [project.id]);
  const delegations = await q.all(`${DELEGATION_ROWS} WHERE p.project_id = ? ORDER BY d.id`, [project.id]);
  for (const party of parties) {
    party.actions = {
      rename: rules.opAllowed('party_rename', identity, project),
      assign_people: rules.opAllowed('party_people', identity, project),
    };
  }
  for (const member of members) {
    member.actions = {
      remove: rules.opAllowed('member_remove', identity, project, {
        removed: member.status === 'removed', isPmRow: member.user_id === project.pm_user_id, targetUserId: member.user_id,
      }),
    };
  }
  return {
    appointments: appointments.filter((row) => visibility.appointmentVisible(identity, row)).map((row) => ({
      id: row.id, party_id: row.party_id, member_id: row.member_id, name: row.name, status: row.status,
      effective_at: row.effective_at, ended_at: row.ended_at, end_reason: row.end_reason, created_at: row.created_at,
      actions: { end: rules.opAllowed('appointment_end', identity, project, { status: row.status, targetUserId: row.user_id }) },
    })),
    delegations: delegations.filter((row) => visibility.delegationVisible(identity, row)).map((row) => ({
      id: row.id, party_id: row.party_id, member_id: row.member_id, name: row.name, appointment_id: row.appointment_id,
      status: row.status, effective_at: row.effective_at, revoked_at: row.revoked_at, revoke_reason: row.revoke_reason, created_at: row.created_at,
      actions: { revoke: rules.opAllowed('delegation_revoke', identity, project, { status: row.status, targetUserId: row.user_id }) },
    })),
  };
}

function createMembershipRoutes(ctx) {
  for (const key of ['db', 'logger']) {
    if (ctx[key] === undefined) throw new Error('routes/sysbuild/membership 缺参数: ' + key);
  }
  for (const key of ['readonlyIds', 'writeRoles']) {
    if (!(Array.isArray(ctx[key]) || ctx[key] instanceof Set)) throw new Error('routes/sysbuild/membership 参数必须是数组或 Set: ' + key);
  }
  const { db, logger } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  function sendError(res, error) {
    if (res.headersSent) return;
    const isBusiness = !!(error && typeof error.status === 'number' && typeof error.code === 'string' && error.code.startsWith('SYSBUILD_'));
    if (isBusiness && error.status < 500) {
      const body = { code: error.code, message: error.message };
      if (error.field) body.field = error.field;
      return res.status(error.status).json(body);
    }
    const cause = error && (error.cause || error);
    logger.error(`[sysbuild] 成员接口内部错误: ${(cause && cause.message) || String(error)}`);
    if (isBusiness) return res.status(error.status).json({ code: error.code, message: error.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((error) => sendError(res, error)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (error) => (
    error ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));

  async function visibleFor(q, user, projectId) {
    const access = await rules.loadProjectAccess(q, projectId, user, accessOpts());
    rules.assertVisible(access);
    return rules.completeIdentity(q, access, user);
  }
  async function loadParty(q, partyId) {
    const party = await q.get('SELECT id, project_id, side, name FROM sysbuild_parties WHERE id = ?', [partyId]);
    if (!party) throw rules.notFound();
    return party;
  }

  router.post('/sysbuild/projects/:id/parties', parseJsonBody, handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id', '项目');
    const body = bodyOf(req);
    if (!ENUMS.partySide.includes(body.side)) throw invalid('side 必须是 demand / dev 之一', 'side');
    const values = people.readParty(body, body.side);
    const out = await db.withWriteTxn(async (q) => {
      const identity = await visibleFor(q, req.user, projectId);
      rules.assertOp('party_add', identity, identity.project, {
        side: values.side, hasDevParty: identity.hasDevParty, hasPendingContentPackage: identity.hasPendingContentPackage,
      });
      return { party: await people.addParty(q, identity.project, req.user, values) };
    });
    res.status(201).json(out);
  }));

  router.patch('/sysbuild/parties/:pid', parseJsonBody, handle(async (req, res) => {
    const partyId = readId(req.params.pid, 'pid', '参与方');
    const body = bodyOf(req);
    for (const key of Object.keys(body)) {
      if (key !== 'name') throw invalid(`不能通过本接口修改 ${key}`, key);
    }
    const name = readText(body.name, 'name', '参与方名称', people.NAME_MAX);
    const out = await db.withWriteTxn(async (q) => {
      const party = await loadParty(q, partyId);
      const identity = await visibleFor(q, req.user, party.project_id);
      rules.assertOp('party_rename', identity, identity.project);
      if (party.name === name) return { party: { id: partyId, side: party.side, name }, changed: false };
      const result = await q.run('UPDATE sysbuild_parties SET name = ? WHERE id = ? AND name = ?', [name, partyId, party.name]);
      if (!result.changes) throw stateError('参与方已变化，请刷新后重试');
      await emit(q, req.user, party.project_id, 'party', partyId, 'party_renamed', { before: party.name, after: name });
      return { party: { id: partyId, side: party.side, name }, changed: true };
    });
    res.json(out);
  }));

  router.put('/sysbuild/parties/:pid/people', parseJsonBody, handle(async (req, res) => {
    const partyId = readId(req.params.pid, 'pid', '参与方');
    const values = people.readRoleChange(bodyOf(req));
    const out = await db.withWriteTxn(async (q) => {
      const party = await loadParty(q, partyId);
      const identity = await visibleFor(q, req.user, party.project_id);
      rules.assertOp('party_people', identity, identity.project);
      return people.replacePeople(q, identity.project, req.user, party, values);
    });
    res.json(out);
  }));

  router.post('/sysbuild/projects/:id/members', parseJsonBody, handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id', '项目');
    const body = bodyOf(req);
    if (Object.prototype.hasOwnProperty.call(body, 'person_name')) throw invalid('添加成员只接受平台账号（user_id）', 'person_name');
    const partyId = readId(body.party_id, 'party_id', '参与方', true);
    const userId = readId(body.user_id, 'user_id', '用户');
    const out = await db.withWriteTxn(async (q) => {
      const identity = await visibleFor(q, req.user, projectId);
      rules.assertOp('member_add', identity, identity.project);
      if (partyId !== null && !(await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [partyId, projectId]))) {
        throw invalid('参与方不存在或不属于本项目', 'party_id');
      }
      const member = await people.addMember(q, identity.project, req.user, partyId, userId);
      return { member: { ...member, status: 'joined' } };
    });
    res.status(201).json(out);
  }));

  router.post('/sysbuild/members/:mid/remove', parseJsonBody, handle(async (req, res) => {
    const memberId = readId(req.params.mid, 'mid', '成员');
    const reason = readText(bodyOf(req).reason, 'reason', '移出原因', people.REASON_MAX);
    const out = await db.withWriteTxn(async (q) => {
      const member = await q.get('SELECT id, project_id, party_id, user_id, removed_at FROM sysbuild_members WHERE id = ?', [memberId]);
      if (!member) throw rules.notFound();
      const identity = await visibleFor(q, req.user, member.project_id);
      rules.assertOp('member_remove', identity, identity.project, {
        removed: member.removed_at !== null, isPmRow: member.user_id === identity.project.pm_user_id, targetUserId: member.user_id,
      });
      const result = await q.run("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = ? WHERE id = ? AND removed_at IS NULL", [reason, memberId]);
      if (!result.changes) throw stateError('成员状态已变化，请刷新后重试');
      await emit(q, req.user, member.project_id, 'member', memberId, 'member_removed', { user_id: member.user_id, party_id: member.party_id, reason });
      await people.cascadeMemberRemoval(q, req.user, member.project_id, memberId);
      return { member: { id: memberId, status: 'removed' } };
    });
    res.json(out);
  }));

  router.post('/sysbuild/appointments/:apid/end', parseJsonBody, handle(async (req, res) => {
    const appointmentId = readId(req.params.apid, 'apid', '任职');
    const reason = readText(bodyOf(req).reason, 'reason', '结束原因', people.REASON_MAX);
    const out = await db.withWriteTxn(async (q) => {
      const row = await q.get(`${APPOINTMENT_ROWS} WHERE a.id = ?`, [appointmentId]);
      if (!row) throw rules.notFound();
      const identity = await visibleFor(q, req.user, row.project_id);
      rules.assertOp('appointment_end', identity, identity.project, { status: row.status, targetUserId: row.user_id });
      await people.endAppointment(q, req.user, row.project_id, row, reason, '领导任职已结束，需重新指定负责人');
      return { appointment: { id: appointmentId, status: 'ended' } };
    });
    res.json(out);
  }));

  router.post('/sysbuild/delegations/:did/revoke', parseJsonBody, handle(async (req, res) => {
    const delegationId = readId(req.params.did, 'did', '授权');
    const reason = readText(bodyOf(req).reason, 'reason', '撤销原因', people.REASON_MAX);
    const out = await db.withWriteTxn(async (q) => {
      const row = await q.get(`${DELEGATION_ROWS} WHERE d.id = ?`, [delegationId]);
      if (!row) throw rules.notFound();
      const identity = await visibleFor(q, req.user, row.project_id);
      rules.assertOp('delegation_revoke', identity, identity.project, { status: row.status, targetUserId: row.user_id });
      await people.revokeDelegation(q, req.user, row.project_id, row, reason);
      return { delegation: { id: delegationId, status: 'revoked' } };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createMembershipRoutes, decorateDetail };
