'use strict';
const assert = require('assert');

const CREATE = '#212 B2.2 建档直接指定';
const PERMISSIONS = '#212 B2.2 人员操作权限';
const ROTATION = '#212 B2.2 换人原子性';
const QUALIFICATION = '#212 B2.2 待确认资格与来源';
const RETIRED = '#212 B2.2 邀请与提议已停用';
const PROTECTION = '#212 B2.2 保留的人员写入保护';

function defineMembershipCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, confirm: H } = T;
  const base = '/sysbuild';
  const get = (uid, path) => api(uid, 'GET', base + path);
  const post = (uid, path, body) => api(uid, 'POST', base + path, body || {});
  const put = (uid, path, body) => api(uid, 'PUT', base + path, body);
  const label = (side, leader, representative) => ({ name: side, leader_user_id: leader, representative_user_id: representative });
  const detail = async (projectId, uid = U.pm) => {
    const r = await get(uid, '/projects/' + projectId);
    assert.strictEqual(r.status, 200, r.text);
    return r.body;
  };
  const count = async (table, where, bindings) => (await sqlGet(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, bindings)).n;
  let next = 0;
  const draft = (extra) => Object.assign({
    system_name: '#212 人员指定用例 ' + (++next), build_type: 'inhouse', demand_parties: [label('甲部', U.own, U.del)],
  }, extra || {});
  async function create(extra, actor = U.pm) {
    const r = await post(actor, '/projects', draft(extra));
    assert.strictEqual(r.status, 201, r.text);
    return r.body.project.id;
  }
  const swap = (party, leader, representative) => ({
    leader_user_id: leader, representative_user_id: representative,
    expected_appointment_id: party.owner?.appointment_id ?? null, expected_delegation_id: party.delegate?.delegation_id ?? null,
    reason: '人员已调整，请以当前安排为准',
  });

  test(CREATE + '：三个建设方式、管理员代建、多个需求方、先填开发领导；角色和事件即时生效，不建发送意图', async () => {
    for (const type of ['outsource', 'inhouse', 'procurement']) {
      const byAdmin = type === 'outsource';
      const extra = { build_type: type, demand_parties: [label('甲部', U.own, U.del), label('乙部', U.x1, U.x2)] };
      if (byAdmin) extra.pm_user_id = U.pm;
      if (type !== 'procurement') extra.dev_party = label('开发方', U.x3, type === 'outsource' ? U.m1 : null);
      const pid = await create(extra, byAdmin ? U.admin : U.pm);
      const view = await detail(pid);
      assert.strictEqual(view.project.pm_user_id, U.pm);
      assert.deepStrictEqual(view.parties.map((p) => [p.name, p.owner.user_id, p.delegate?.user_id ?? null]), type === 'procurement'
        ? [['甲部', U.own, U.del], ['乙部', U.x1, U.x2]]
        : [['甲部', U.own, U.del], ['乙部', U.x1, U.x2], ['开发方', U.x3, type === 'outsource' ? U.m1 : null]]);
      assert.ok(view.members.every((m) => m.status === 'joined' && m.joined_at), '保存后直接加入');
      const mine = await detail(pid, U.del);
      assert.deepStrictEqual(mine.me.delegate_of_parties, [view.parties[0].id]);
      const events = await sqlAll("SELECT event_type, payload_json, operator_id FROM sysbuild_events WHERE project_id = ? AND event_type IN ('party_created','appointment_activated','delegation_activated') ORDER BY id", [pid]);
      assert.strictEqual(events.length, view.parties.length * 2 + view.parties.filter((p) => p.delegate).length);
      for (const event of events) {
        assert.strictEqual(JSON.parse(event.payload_json).source, 'direct_assignment');
        assert.strictEqual(event.operator_id, byAdmin ? U.admin : U.pm);
      }
      assert.strictEqual(await count('sysbuild_send_intents', 'project_id = ?', [pid]), 0);
      assert.strictEqual(await count('sysbuild_confirm_tasks', 'project_id = ?', [pid]), 0);
    }
  });

  test(CREATE + ' 校验与回滚：缺人、重复、PM 本人、停用账号、只读与用户代建；触发器拒绝授权后无半成品', async () => {
    const rows = async () => await sqlGet(`SELECT
      (SELECT COUNT(*) FROM sysbuild_projects) AS projects, (SELECT COUNT(*) FROM sysbuild_batches) AS batches,
      (SELECT COUNT(*) FROM sysbuild_nodes) AS nodes, (SELECT COUNT(*) FROM sysbuild_parties) AS parties,
      (SELECT COUNT(*) FROM sysbuild_members) AS members, (SELECT COUNT(*) FROM sysbuild_appointments) AS appointments,
      (SELECT COUNT(*) FROM sysbuild_delegations) AS delegations, (SELECT COUNT(*) FROM sysbuild_events) AS events`, []);
    const before = await rows();
    const entries = [
      [{ demand_parties: [] }, 400, 'demand_parties'],
      [{ demand_parties: [{ name: '甲部', leader_user_id: U.own }] }, 400, 'demand_parties[0].representative_user_id'],
      [{ demand_parties: [label('甲部', U.own, U.own)] }, 400, 'demand_parties[0].representative_user_id'],
      [{ demand_parties: [label('甲部', U.own, U.del), label('乙部', U.x1, U.own)] }, 400, 'demand_parties[1].representative_user_id'],
      [{ dev_party: { name: '开发方', representative_user_id: U.x2 } }, 400, 'dev_party.leader_user_id'],
      [{ demand_parties: [label('甲部', U.pm, U.del)] }, 409, 'demand_parties[0].leader_user_id'],
      [{ pm_user_id: U.cand }, 403],
    ];
    for (const [extra, status, field] of entries) {
      const res = await post(U.pm, '/projects', draft(extra));
      expectErr(res, status, status === 400 ? 'SYSBUILD_INVALID_INPUT' : status === 409 ? 'SYSBUILD_STATE' : 'SYSBUILD_FORBIDDEN');
      if (field) assert.strictEqual(res.body.field, field);
    }
    expectErr(await post(U.ro, '/projects', draft()), 403, 'SYSBUILD_FORBIDDEN');
    await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.x3]);
    try {
      const r = await post(U.pm, '/projects', draft({ dev_party: label('开发方', U.x3, null) }));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT');
      assert.strictEqual(r.body.field, 'dev_party.leader_user_id');
      const mixed = await post(U.pm, '/projects', draft({
        demand_parties: [label('第一需求部', U.pm, U.del), label('第二需求部', U.x3, U.x2)],
      }));
      expectErr(mixed, 409, 'SYSBUILD_STATE');
      assert.strictEqual(mixed.body.field, 'demand_parties[0].leader_user_id');
    } finally {
      await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.x3]);
    }
    assert.deepStrictEqual(await rows(), before, '拒绝建档保持全部实体和事件');
    await sqlRun("CREATE TRIGGER sb2_people_rollback BEFORE INSERT ON sysbuild_delegations BEGIN SELECT RAISE(ABORT,'fixture_rollback'); END", []);
    try {
      expectErr(await post(U.pm, '/projects', draft()), 500, 'SYSBUILD_INTERNAL');
      assert.deepStrictEqual(await rows(), before, '成员、阶段、任职及事件随失败回滚');
    } finally {
      await sqlRun('DROP TRIGGER sb2_people_rollback', []);
    }
  });

  test(PERMISSIONS + '：管理员先接管、已暂停与已结项允许、终止拒绝、非成员 404、第二开发方拒绝、跨项目成员归属拒绝', async () => {
    const pid = await create();
    const outsider = await create({ demand_parties: [label('外部', U.x1, U.x2)] });
    const a = (await detail(pid)).parties[0];
    const b = (await detail(outsider)).parties[0];
    const change = swap(a, U.m1, U.del);
    const partyPath = '/parties/' + a.id + '/people';
    for (const who of [U.admin, U.own, U.ro]) {
      const view = await detail(pid, who);
      assert.strictEqual(view.parties[0].actions.assign_people, false);
      assert.strictEqual(view.actions.add_member, false);
      expectErr(await put(who, partyPath, change), 403, 'SYSBUILD_FORBIDDEN');
    }
    expectErr(await put(U.out, partyPath, change), 404, 'SYSBUILD_NOT_FOUND');
    const path = '/projects/' + pid + '/members';
    expectErr(await post(U.pm, path, { party_id: b.id, user_id: U.x3 }), 400, 'SYSBUILD_INVALID_INPUT');
    const dev = { side: 'dev', ...label('开发方', U.x1, null) };
    assert.strictEqual((await post(U.pm, '/projects/' + pid + '/parties', dev)).status, 201);
    expectErr(await post(U.pm, '/projects/' + pid + '/parties', { ...dev, leader_user_id: U.x2 }), 409, 'SYSBUILD_STATE');
    assert.strictEqual((await post(U.admin, '/projects/' + pid + '/pm', { pm_user_id: U.admin, reason: '接管项目' })).status, 200);
    assert.strictEqual((await detail(pid, U.admin)).parties[0].actions.assign_people, true);
    expectErr(await put(U.pm, partyPath, change), 403, 'SYSBUILD_FORBIDDEN');
    for (const status of ['paused', 'closed']) {
      await sqlRun('UPDATE sysbuild_projects SET status = ? WHERE id = ?', [status, pid]);
      const now = (await detail(pid, U.admin)).parties[0];
      const next = status === 'paused' ? U.m1 : U.m2;
      assert.strictEqual(now.actions.assign_people, true);
      assert.strictEqual((await put(U.admin, partyPath, swap(now, next, U.del))).status, 200);
    }
    await sqlRun("UPDATE sysbuild_projects SET status = 'terminated' WHERE id = ?", [pid]);
    const terminated = await detail(pid, U.admin);
    const now = terminated.parties[0];
    assert.strictEqual(now.actions.assign_people, false);
    assert.strictEqual(now.actions.rename, false);
    assert.strictEqual(terminated.actions.add_member, false);
    assert.deepStrictEqual(terminated.actions.party_sides, []);
    expectErr(await put(U.admin, partyPath, swap(now, U.m1, U.del)), 409, 'SYSBUILD_PROJECT_READONLY');
    expectErr(await put(U.pm, partyPath, swap(now, U.m1, U.del)), 403, 'SYSBUILD_FORBIDDEN');
  });

  test(ROTATION + '：同方账号可复用，校验旧编号、并发无部分提交；换领导重建授权，移出级联', async () => {
    const pid = await create({ dev_party: label('开发侧', U.x1, null) });
    const path = '/projects/' + pid + '/members';
    const [demand, development] = (await detail(pid)).parties;
    const assignment = (party) => '/parties/' + party.id + '/people';
    const added = await post(U.pm, path, { party_id: demand.id, user_id: U.m1 });
    assert.strictEqual(added.status, 201, added.text);
    assert.strictEqual(added.body.member.status, 'joined');
    expectErr(await post(U.pm, path, { party_id: demand.id, user_id: U.m1 }), 409, 'SYSBUILD_STATE');
    expectErr(await put(U.pm, assignment(demand), swap(demand, U.x1, U.del)), 409, 'SYSBUILD_STATE');
    const changes = await Promise.all([
      put(U.pm, assignment(demand), swap(demand, U.m1, U.del)),
      put(U.pm, assignment(demand), swap(demand, U.m2, U.del)),
    ]);
    assert.deepStrictEqual(changes.map((r) => r.status).sort(), [200, 409]);
    const current = (await detail(pid)).parties[0];
    assert.ok([U.m1, U.m2].includes(current.owner.user_id));
    assert.strictEqual(current.delegate.user_id, U.del);
    assert.notStrictEqual(current.owner.appointment_id, demand.owner.appointment_id);
    assert.notStrictEqual(current.delegate.delegation_id, demand.delegate.delegation_id);
    assert.strictEqual(await count('sysbuild_appointments', "party_id = ? AND status = 'active'", [demand.id]), 1);
    assert.strictEqual(await count('sysbuild_delegations', "party_id = ? AND status = 'active'", [demand.id]), 1);
    const before = await count('sysbuild_events', 'project_id = ?', [pid]);
    const unchanged = await put(U.pm, assignment(current), swap(current, current.owner.user_id, U.del));
    assert.strictEqual(unchanged.status, 200, unchanged.text);
    assert.strictEqual(unchanged.body.changed, false);
    assert.strictEqual(await count('sysbuild_events', 'project_id = ?', [pid]), before);
    const rotation = await put(U.pm, assignment(development), swap(development, U.x2, null));
    assert.strictEqual(rotation.status, 200, rotation.text);
    const dev = (await detail(pid)).parties[1];
    assert.strictEqual(dev.owner.user_id, U.x2);
    assert.strictEqual(dev.delegate, null);
    assert.strictEqual((await put(U.pm, assignment(dev), swap(dev, U.x2, U.x3))).status, 200);
    const newDev = (await detail(pid)).parties[1];
    assert.strictEqual(newDev.owner.appointment_id, dev.owner.appointment_id);
    assert.strictEqual((await post(U.pm, '/members/' + newDev.owner.member_id + '/remove', { reason: '离开项目' })).status, 200);
    assert.strictEqual((await post(U.pm, '/members/' + newDev.delegate.member_id + '/remove', { reason: '离开开发方' })).status, 200);
    const end = await detail(pid, U.del);
    assert.strictEqual(end.parties[1].owner, null);
    assert.strictEqual(end.parties[1].delegate, null);
    assert.ok(end.appointments.some((r) => r.id === newDev.owner.appointment_id && r.status === 'ended'));
    assert.ok(end.delegations.some((r) => r.id === newDev.delegate.delegation_id && r.status === 'revoked'));
    const swapPair = (await detail(pid)).parties[0];
    expectErr(await post(U.del, '/delegations/' + swapPair.delegate.delegation_id + '/revoke', { reason: '非 PM 操作' }), 403, 'SYSBUILD_FORBIDDEN');
    const replaceDelegate = await put(U.pm, assignment(swapPair), swap(swapPair, swapPair.owner.user_id, U.cand));
    assert.strictEqual(replaceDelegate.status, 200, replaceDelegate.text);
    const afterDelegate = (await detail(pid)).parties[0];
    assert.strictEqual(afterDelegate.owner.appointment_id, swapPair.owner.appointment_id);
    assert.notStrictEqual(afterDelegate.delegate.delegation_id, swapPair.delegate.delegation_id);
    assert.strictEqual((await put(U.pm, assignment(afterDelegate), swap(afterDelegate, U.cand, afterDelegate.owner.user_id))).status, 200);
    const swapped = (await detail(pid)).parties[0];
    assert.deepStrictEqual([swapped.owner.user_id, swapped.delegate.user_id], [afterDelegate.delegate.user_id, afterDelegate.owner.user_id]);
  });

  test(PROTECTION + '：保留账号字段、本人目标、仅 PM、只读否决及移出负责人的授权级联', async () => {
    const pid = await create();
    const route = '/projects/' + pid + '/members';
    const byPm = await detail(pid);
    const party = byPm.parties[0];
    const changePath = '/parties/' + party.id + '/people';
    const rosterSnapshot = (projectId = pid) => Promise.all([
      count('sysbuild_members', 'project_id = ?', [projectId]),
      count('sysbuild_parties', 'project_id = ?', [projectId]),
      count('sysbuild_appointments', 'party_id IN (SELECT id FROM sysbuild_parties WHERE project_id = ?)', [projectId]),
      count('sysbuild_delegations', 'party_id IN (SELECT id FROM sysbuild_parties WHERE project_id = ?)', [projectId]),
      count('sysbuild_events', 'project_id = ?', [projectId]),
      count('sysbuild_send_intents', 'project_id = ?', [projectId]),
    ]);
    const beforeRejects = await rosterSnapshot();
    for (const [body, field] of [
      [{ party_id: party.id, person_name: '  张三  ' }, 'person_name'],
      [{ party_id: party.id, user_id: U.m1, person_name: '李四' }, 'person_name'],
      [{}, 'user_id'],
      [{ party_id: party.id, person_name: null }, 'person_name'],
      [{ party_id: party.id, user_id: U.m1, person_name: null }, 'person_name'],
      [{ party_id: party.id, person_name: '' }, 'person_name'],
      [{ party_id: party.id, user_id: U.m1, person_name: '' }, 'person_name'],
      [{ party_id: party.id, person_name: '   ' }, 'person_name'],
      [{ person_name: 'n'.repeat(51) }, 'person_name'],
      [{ person_name: 123 }, 'person_name'],
      [{ user_id: 'x' }, 'user_id'],
      [{ user_id: 0 }, 'user_id'],
      [{ user_id: U.m1, party_id: 'x' }, 'party_id'],
      [{ party_id: 'x', person_name: '李四' }, 'person_name'],
      [{ party_id: party.id, user_id: 'x', person_name: '李四' }, 'person_name'],
      [{ party_id: 'x', user_id: 'x' }, 'party_id'],
    ]) {
      const r = await post(U.pm, route, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', JSON.stringify(body));
      assert.strictEqual(r.body.field, field);
      assert.deepStrictEqual(await rosterSnapshot(), beforeRejects);
    }
    await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.own]);
    try {
      const same = await put(U.pm, changePath, swap(party, U.own, U.del));
      expectErr(same, 400, 'SYSBUILD_INVALID_INPUT');
      assert.strictEqual(same.body.field, 'leader_user_id');
      const replaceRepresentative = await put(U.pm, changePath, swap(party, U.own, U.m1));
      expectErr(replaceRepresentative, 400, 'SYSBUILD_INVALID_INPUT');
      assert.strictEqual(replaceRepresentative.body.field, 'leader_user_id');
    } finally {
      await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.own]);
    }
    expectErr(await post(U.pm, route, { user_id: U.pm }), 409, 'SYSBUILD_STATE');
    expectErr(await put(U.pm, changePath, swap(party, U.pm, U.del)), 409, 'SYSBUILD_STATE');
    expectErr(await put(U.pm, changePath, swap(party, U.own, U.pm)), 409, 'SYSBUILD_STATE');
    expectErr(await put(U.pm, changePath, swap(party, U.own, U.own)), 400, 'SYSBUILD_INVALID_INPUT');
    const pmRow = byPm.members.find((row) => row.user_id === U.pm);
    const selfRemoval = await post(U.pm, '/members/' + pmRow.id + '/remove', { reason: '移出当前 PM' });
    assert.deepStrictEqual([pmRow.actions.remove, selfRemoval.status, selfRemoval.body.code], [false, 409, 'SYSBUILD_STATE'], '详情标志与写端点均禁止移出当前 PM');
    assert.strictEqual((await sqlGet('SELECT removed_at FROM sysbuild_members WHERE id = ?', [pmRow.id])).removed_at, null);
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.ro, pid]);
    expectErr(await put(U.ro, changePath, swap(party, U.own, U.del)), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await post(U.ro, '/projects/' + pid + '/parties', { side: 'dev', ...label('开发方', U.x1, null) }), 403, 'SYSBUILD_FORBIDDEN');
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.pm, pid]);
    assert.strictEqual((await post(U.pm, '/members/' + party.delegate.member_id + '/remove', { reason: '负责人已离开' })).status, 200);
    assert.strictEqual((await detail(pid)).parties[0].delegate, null);
    const revoked = await sqlGet('SELECT status FROM sysbuild_delegations WHERE id = ?', [party.delegate.delegation_id]);
    assert.strictEqual(revoked.status, 'revoked', '移出负责人必须撤销授权行');
    const newPerson = await post(U.pm, route, { party_id: party.id, user_id: U.m1 });
    assert.strictEqual(newPerson.status, 201);
    expectErr(await post(U.pm, route, { party_id: party.id, user_id: U.m1 }), 409, 'SYSBUILD_STATE');
    // 脏数据防线夹具：既有活动任职行意外指向 PM 成员。入口与读标志仍要拒绝本人操作。
    await sqlRun('UPDATE sysbuild_appointments SET member_id = ? WHERE id = ?', [pmRow.id, party.owner.appointment_id]);
    const underPm = (await detail(pid)).appointments.find((row) => row.id === party.owner.appointment_id);
    assert.strictEqual(underPm.actions.end, false);
    expectErr(await post(U.pm, '/appointments/' + underPm.id + '/end', { reason: '不能结束自己的任职' }), 409, 'SYSBUILD_STATE');

    // 各入口独立造没有 PM 成员行的项目，避免归属冲突或前一写入遮蔽本人限制。
    const selfTargets = [];
    for (const role of ['member', 'leader', 'representative']) {
      const legacyPid = await create();
      await sqlRun('DELETE FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [legacyPid, U.pm]);
      const legacyParty = (await detail(legacyPid)).parties[0];
      const beforeSelfTarget = await rosterSnapshot(legacyPid);
      const response = role === 'member'
        ? await post(U.pm, '/projects/' + legacyPid + '/members', { user_id: U.pm })
        : await put(U.pm, '/parties/' + legacyParty.id + '/people', swap(legacyParty, role === 'leader' ? U.pm : U.own, role === 'representative' ? U.pm : U.del));
      const afterSelfTarget = await rosterSnapshot(legacyPid);
      const unchanged = beforeSelfTarget.every((n, index) => afterSelfTarget[index] === n);
      selfTargets.push([role, response.status, response.body.code, response.body.field, unchanged]);
    }
    assert.deepStrictEqual(selfTargets, [
      ['member', 409, 'SYSBUILD_STATE', 'user_id', true],
      ['leader', 409, 'SYSBUILD_STATE', 'leader_user_id', true],
      ['representative', 409, 'SYSBUILD_STATE', 'representative_user_id', true],
    ], '三处直接指定都按各自字段拦当前 PM，即使不存在 PM 成员行');
  });

  test('参与方：改名——PM 成功且事件记改前 / 改后；同名不写事件；别的键 400；非 PM 403；非成员 404；已终止 409；不存在 404', async () => {
    const pid = await create();
    const party = (await detail(pid)).parties[0];
    const route = base + '/parties/' + party.id;
    const patch = (user, body, url = route) => api(user, 'PATCH', url, body);
    const renamed = await patch(U.pm, { name: '  新甲部  ' });
    assert.strictEqual(renamed.status, 200, renamed.text);
    const partyView = { id: party.id, side: 'demand', name: '新甲部' };
    assert.deepStrictEqual(renamed.body, { party: partyView, changed: true });
    const loadEvents = () => sqlAll("SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND event_type = 'party_renamed'", [pid]);
    assert.deepStrictEqual((await loadEvents()).map((row) => JSON.parse(row.payload_json)), [{ before: '甲部', after: '新甲部' }]);
    const same = await patch(U.pm, { name: '新甲部' });
    assert.strictEqual(same.status, 200, same.text);
    assert.deepStrictEqual(same.body, { party: partyView, changed: false });
    for (const k of ['side', 'project_id', 'sort_order']) {
      expectErr(await patch(U.pm, { name: 'x', [k]: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '键 ' + k);
    }
    expectErr(await patch(U.pm, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺 name');
    expectErr(await patch(U.pm, { name: 'n'.repeat(51) }), 400, 'SYSBUILD_INVALID_INPUT', '51 字');
    for (const user of [U.own, U.del, U.admin, U.ro]) {
      expectErr(await patch(user, { name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM');
    }
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.ro, pid]);
    try {
      assert.ok((await detail(pid, U.ro)).me.roles.includes('pm'));
      expectErr(await patch(U.ro, { name: '只读项目经理改名' }), 403, 'SYSBUILD_FORBIDDEN', '当前 PM 为只读账号');
    } finally {
      await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.pm, pid]);
    }
    expectErr(await patch(U.out, { name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await patch(U.pm, { name: 'x' }, base + '/parties/99999999'), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    expectErr(await patch(U.pm, { name: 'x' }, base + '/parties/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    await sqlRun("UPDATE sysbuild_projects SET status = 'terminated' WHERE id = ?", [pid]);
    expectErr(await patch(U.pm, { name: '终止后' }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await sqlGet('SELECT name FROM sysbuild_parties WHERE id = ?', [party.id])).name, '新甲部');
    assert.strictEqual((await loadEvents()).length, 1, '同名和被拒的写入不写事件');
  });

  test(QUALIFICATION + '：同一负责人随换领导换授权，旧修订不可办理，改发保持历史来源', async () => {
    const pid = await create();
    const ini = await H.produceEffectiveInitiation(pid);
    assert.ok(ini);
    const party = (await detail(pid)).parties[0];
    const pk = await H.mkPackage(pid, 'overall');
    const pv = await H.mkPreparedVersion(pk);
    await H.planAllNodes(pid);
    const submit = await post(U.pm, '/package-versions/' + pv + '/submit');
    assert.strictEqual(submit.status, 200, submit.text);
    const before = (await H.tasksOf(pv)).find((task) => task.user_id === U.del);
    const beforeView = await H.openTask(U.del, before.task_id);
    assert.strictEqual(beforeView.status, 200, beforeView.text);
    assert.strictEqual(beforeView.body.revision.direct_assignment_role, '负责人');
    assert.strictEqual((await put(U.pm, '/parties/' + party.id + '/people', swap(party, U.m1, U.del))).status, 200);
    const stale = await H.openTask(U.del, before.task_id);
    assert.strictEqual(stale.body.actions.decide, false);
    const todo = await get(U.del, '/my/todo');
    assert.strictEqual(todo.body.items.confirm.some((task) => task.task_id === before.task_id), false);
    const reissued = await post(U.pm, '/confirm-tasks/' + before.task_id + '/reissue', { reason: '更新任职链', revision_id: before.rev_id });
    assert.strictEqual(reissued.status, 200, reissued.text);
    const current = await H.openTask(U.del, before.task_id);
    assert.strictEqual(current.body.actions.decide, true);
    assert.notStrictEqual(current.body.revision.id, before.rev_id);
    assert.deepStrictEqual(current.body.revisions.map((row) => row.direct_assignment_role), ['负责人', '负责人']);
    const letter = await get(U.pm, '/package-versions/' + pv + '/confirmation-sheet');
    assert.strictEqual(letter.status, 200, letter.text);
    assert.match(letter.text, /直接指定，未经本人接受/);
  });

  test(RETIRED + '：旧读写路由消失，待办只计确认，空库不创建人员发送意图', async () => {
    const pid = await create();
    const party = (await detail(pid)).parties[0];
    for (const [method, path] of [
      ['GET', '/my/invitations'], ['GET', '/my/invitations/1'],
      ['POST', '/my/invitations/1/accept'], ['POST', '/my/invitations/1/decline'],
      ['POST', '/parties/' + party.id + '/appointments'], ['POST', '/parties/' + party.id + '/delegations'],
      ['POST', '/appointments/' + party.owner.appointment_id + '/withdraw'],
      ...['approve', 'reject', 'accept', 'decline', 'withdraw'].map((op) => ['POST', '/delegations/' + party.delegate.delegation_id + '/' + op]),
    ]) {
      assert.strictEqual((await api(U.pm, method, base + path, method === 'GET' ? undefined : {})).status, 404, path);
    }
    const todo = await get(U.own, '/my/todo');
    assert.strictEqual(todo.status, 200, todo.text);
    assert.ok(!Object.hasOwn(todo.body.counts, 'accept') && !Object.hasOwn(todo.body.items, 'accept'));
    assert.strictEqual(todo.body.counts.badge, todo.body.counts.confirm);
    assert.strictEqual(await count('sysbuild_send_intents', 'project_id = ?', [pid]), 0);
  });
}

const MEMBERSHIP_MUTATIONS = [
  { id: '#212 B2.3 只读 PM 可改参与方名称', expect: ['参与方：改名'], edits: [
    { file: 'rules.js', from: 'party_rename: Object.freeze({ can: canActAsPm, state: noStateLimit })', to: 'party_rename: Object.freeze({ can: (identity) => identity.isPm, state: noStateLimit })' },
  ] },
  { id: '#212 B2.3 参与方同名重写与重复留痕', expect: ['参与方：改名'], edits: [
    { file: 'membership.js', from: 'if (party.name === name) return { party: { id: partyId, side: party.side, name }, changed: false };', to: '' },
  ] },
  { id: '#212 B2.2 建档漏写参与方角色', expect: [CREATE + '：'], edits: [{ file: 'projects.js', from: 'await people.addInitialParties(q, { id: pid, pm_user_id: pmId }, user, parties);', to: '' }] },
  { id: '#212 B2.2 后续人员操作错误允许未接管管理员', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: 'party_people: Object.freeze({ can: canActAsPm, state: noStateLimit })', to: 'party_people: Object.freeze({ can: (identity) => identity.isAdmin || canActAsPm(identity), state: noStateLimit })' }] },
  { id: '开发方不限一个', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: "if (t.side === 'dev' && t.hasDevParty) return '本项目已有开发方参与方，每个项目至多一个';", to: '' }] },
  { id: '#212 B2.2 允许覆盖跳过旧编号重核', expect: [ROTATION], edits: [{ file: 'membership-people.js', from: 'if ((appointment?.id ?? null) !== values.expectedAppointmentId || (delegation?.id ?? null) !== values.expectedDelegationId) {', to: 'if (false) {' }] },
  { id: '#212 B2.2 确认详情不注明直接指定', expect: [QUALIFICATION], edits: [{ file: 'confirm-core.js', from: "return appointmentId ? '领导' : '负责人';", to: 'return null;' }] },
  { id: 'M-1：共享判定去掉本人目标限制', expect: [PROTECTION], edits: [{ file: 'rules.js', from: 'if (def.noSelf && isSelfManagedTarget(identity, t))', to: 'if (false)' }] },
  { id: 'PM 本人的成员行可被移出', expect: [PROTECTION], edits: [
    { file: 'rules.js', from: "member_remove: Object.freeze({\n    can: canActAsPm,\n    noSelf: true,", to: "member_remove: Object.freeze({\n    can: canActAsPm,\n    noSelf: false," },
    { file: 'rules.js', from: "return t.isPmRow ? 'PM 本人的成员行不能移出，要更换 PM 请走更换 PM' : null;", to: 'return null;' },
  ] },
  { id: 'M-1：结束任职的写端点不传目标用户', expect: [PROTECTION], edits: [{ file: 'membership.js', from: "rules.assertOp('appointment_end', identity, identity.project, { status: row.status, targetUserId: row.user_id });", to: "rules.assertOp('appointment_end', identity, identity.project, { status: row.status });" }] },
  { id: 'M-1：详情里任职 end / withdraw 标志不带目标用户（读写不同源）', expect: [PROTECTION], edits: [{ file: 'membership.js', from: "end: rules.opAllowed('appointment_end', identity, project, { status: row.status, targetUserId: row.user_id })", to: "end: rules.opAllowed('appointment_end', identity, project, { status: row.status })" }] },
  { id: '接受任职不结束原负责人', expect: [ROTATION], edits: [{ file: 'membership-people.js', from: 'if (leaderChanged && appointment) await endAppointment(q, operator, project.id, appointment, values.reason);', to: '' }] },
  { id: '负责人更换（结束任职）不撤销 / 撤回基于它的授权', expect: [ROTATION], edits: [{ file: 'membership-people.js', from: 'for (const delegation of delegations) await revokeDelegation(q, operator, projectId, delegation, revokeReason);', to: '' }] },
  { id: '接受授权不撤销原生效代表人', expect: [ROTATION], edits: [{ file: 'membership-people.js', from: 'if (delegation && !leaderChanged && representativeChanged) {', to: 'if (false) {' }] },
  { id: '添加成员不查重复邀请', expect: [PROTECTION], edits: [{ file: 'membership-people.js', from: 'if (!reuse || member.joined_at === null) throw stateError(', to: 'if (false) throw stateError(' }] },
  { id: 'D2：加成员不拦操作人本人', expect: [PROTECTION], edits: [{ file: 'membership-people.js', from: 'if (userId === Number(operator.id) || userId === Number(project.pm_user_id)) throw stateError(', to: 'if (false) throw stateError(' }] },
  { id: '成员管理只读否决被去掉（只读 PM 可建参与方）', expect: [PROTECTION], edits: [{ file: 'rules.js', from: "party_add: Object.freeze({\n    can: canActAsPm,", to: "party_add: Object.freeze({\n    can: (identity) => identity.isPm," }] },
  { id: 'R8：添加成员按 person_name 键拒绝（键出现即拒，不按值判断）', expect: [PROTECTION], edits: [{ file: 'membership.js', from: "if (Object.prototype.hasOwnProperty.call(body, 'person_name'))", to: 'if (false)' }] },
  { id: '授权可授给本方现任负责人本人', expect: [PROTECTION], edits: [{ file: 'membership-people.js', from: 'if (leaderId === representativeId)', to: 'if (false)' }] },
  { id: '移出成员不级联本人名下的授权', expect: [PROTECTION], edits: [{ file: 'membership-people.js', from: "for (const item of delegations) await revokeDelegation(q, operator, projectId, item, '成员移出');", to: '' }] },
  { id: '状态查表：已终止放行 membership', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: 'membership: Object.freeze({ active: true, paused: true, terminated: false, closed: true })', to: 'membership: Object.freeze({ active: true, paused: true, terminated: true, closed: true })' }] },
  { id: '检查顺序：项目状态 409 先于权限 403（成员动作）', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: 'if (!def.can(identity, project, t)) return', to: 'if (!def.can(identity, project, t) && projectAllowsWrite(project.status, OP_KIND[op])) return' }] },
  { id: 'M3：项目级 add_member 标志不看项目状态（MA）', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: "add_member: opAllowed('member_add', identity, project, {}),", to: 'add_member: canActAsPm(identity),' }] },
  { id: 'M3：项目级 party_sides 不看项目状态（MB）', expect: [PERMISSIONS], edits: [{ file: 'rules.js', from: "opAllowed('party_add', identity, project, { side,", to: "opAllowed('party_add', identity, { ...project, status: 'active' }, { side," }] },
  { id: 'M3：详情里参与方的 rename 标志不看项目状态（MC）', expect: [PERMISSIONS], edits: [{ file: 'membership.js', from: "rename: rules.opAllowed('party_rename', identity, project),", to: "rename: rules.opAllowed('party_rename', identity, { ...project, status: 'active' })," }] },
  { id: 'D3 放开历史：普通成员看不到已结束的任职', expect: [ROTATION], edits: [{ file: 'membership-visibility.js', from: "return row.status === 'ended' ||", to: "return (row.status === 'ended' && manager(identity)) ||" }] },
  { id: 'D3 放开历史：普通成员看不到已撤销的授权', expect: [ROTATION], edits: [{ file: 'membership-visibility.js', from: "return row.status === 'revoked' ||", to: "return (row.status === 'revoked' && manager(identity)) ||" }] },
  { id: '添加成员不校验参与方归属', expect: [PERMISSIONS], edits: [{ file: 'membership.js', from: "if (partyId !== null && !(await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [partyId, projectId]))) {", to: 'if (false) {' }] },
];

module.exports = { defineMembershipCases, MEMBERSHIP_MUTATIONS };
