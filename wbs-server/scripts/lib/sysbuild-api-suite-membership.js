// 验证脚本库：项目管理（系统建设记录）模块 C2b——参与方、成员、任职、授权、邀请与受邀人窄范围入口（M-S2）的用例
//   派单：docs/local/系统建设记录/送审准备/C2b_参与方成员任职授权邀请_派单_20261029.md
//
// 本文件只放用例，由 sysbuild-api-suite.js 的 defineCases() 末尾调用 defineMembershipCases(T) 登记（与 C2a 用例同一套夹具、同一个变异自检）。
//   T = 套件注入的夹具与助手（U 用户角色表、api / sqlRun 等，W / MODS 用 getter 取，因为套件在用例登记之后才赋值）。
//   期望值一律手写，不取自被测代码。
'use strict';
const assert = require('assert');

function defineMembershipCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, mkProject, addMember, addParty, addAppointment, addDelegation, addInvitation } = T;
  const post = (uid, urlPath, body) => api(uid, 'POST', urlPath, body === undefined ? {} : body);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const rowOf = (table, id) => sqlGet(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const countOf = async (sql, p) => (await sqlGet(sql, p)).n;
  const setStatus = (pid, status) => sqlRun('UPDATE sysbuild_projects SET status = ? WHERE id = ?', [status, pid]);
  const KEYS = (o) => Object.keys(o).sort();

  // 场景：项目（PM）+ 甲部（现任负责人 own、代表人 del）+ 无参与方的普通成员 m1。
  async function scene() {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    const mOwn = await addMember(pid, U.own, { party });
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = await addMember(pid, U.del, { party });
    const mM1 = await addMember(pid, U.m1);
    return { pid, party, mOwn, apt, mDel, mM1 };
  }

  // ── 参与方 ───────────────────────────────────────────────────────────────────────────
  test('参与方：新建——PM 成功（需求方 / 开发方）与事件手写核对；第二个开发方 409；非 PM 成员 403；admin（非只读）未接管也可建；只读账号是 PM 也 403；非成员 404；已终止 409、已结项允许；参数 400', async () => {
    const pid = await mkProject(U.pm);
    await addMember(pid, U.m1);
    const url = `/sysbuild/projects/${pid}/parties`;
    const r1 = await post(U.pm, url, { side: 'demand', name: '  财务部  ' });
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual(r1.body.party, { id: r1.body.party.id, side: 'demand', name: '财务部', sort_order: 1 });
    const r2 = await post(U.pm, url, { side: 'dev', name: '开发商' });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual(r2.body.party.sort_order, 2);
    expectErr(await post(U.pm, url, { side: 'dev', name: '另一家开发商' }), 409, 'SYSBUILD_STATE', '第二个开发方');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ? AND side = 'dev'", [pid]), 1, '开发方至多一个');
    const r3 = await post(U.pm, url, { side: 'demand', name: '人事部' });
    assert.strictEqual(r3.status, 201, '需求方可以有多个');
    const evs = await eventsOf(pid, 'party_created');
    assert.deepStrictEqual(evs.map((e) => JSON.parse(e.payload_json)), [{ side: 'demand', name: '财务部' }, { side: 'dev', name: '开发商' }, { side: 'demand', name: '人事部' }]);
    assert.ok(evs.every((e) => e.operator_id === U.pm && e.object_type === 'party'));
    assert.deepStrictEqual(evs.map((e) => e.object_id), [r1.body.party.id, r2.body.party.id, r3.body.party.id]);
    const detail = await api(U.pm, 'GET', `/sysbuild/projects/${pid}`);
    assert.deepStrictEqual(detail.body.actions.party_sides, ['demand'], '已有开发方后只剩需求方可建');
    assert.strictEqual(detail.body.actions.add_party, true);
    // 权限与状态
    expectErr(await post(U.m1, url, { side: 'demand', name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
    // fixC：admin（非只读）不必接管即可管理（§5.2「添加 / 移出成员、指定负责人、发邀请」admin 为是）。
    const byAdmin = await post(U.admin, url, { side: 'demand', name: 'admin 建的参与方' });
    assert.strictEqual(byAdmin.status, 201, `admin 未接管也可建参与方: ${byAdmin.text}`);
    assert.strictEqual((await eventsOf(pid, 'party_created')).pop().operator_id, U.admin, '事件操作人是 admin');
    expectErr(await post(U.out, url, { side: 'demand', name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    const roPid = await mkProject(U.ro);
    expectErr(await post(U.ro, `/sysbuild/projects/${roPid}/parties`, { side: 'demand', name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '只读账号是 PM 也不能建');
    expectErr(await post(U.pm, '/sysbuild/projects/99999999/parties', { side: 'demand', name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
    await setStatus(pid, 'terminated');
    expectErr(await post(U.pm, url, { side: 'demand', name: '终止后' }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    await setStatus(pid, 'closed');
    assert.strictEqual((await post(U.pm, url, { side: 'demand', name: '结项后补录' })).status, 201, '已结项允许（成员与授权变更，仅为补登与 G7 需要）');
    await setStatus(pid, 'paused');
    assert.strictEqual((await post(U.pm, url, { side: 'demand', name: '暂停中' })).status, 201);
    // 参数
    const p2 = await mkProject(U.pm);
    const u2 = `/sysbuild/projects/${p2}/parties`;
    const bads = [
      [{ name: 'x' }, 'side', '缺 side'], [{ side: 'x', name: 'x' }, 'side', 'side 非法'], [{ side: 'demand' }, 'name', '缺 name'],
      [{ side: 'demand', name: '   ' }, 'name', 'name 空白'], [{ side: 'demand', name: 'n'.repeat(51) }, 'name', 'name 51 字'], [{ side: 'demand', name: 123 }, 'name', 'name 非文本'],
    ];
    for (const [body, field, label] of bads) {
      const r = await post(U.pm, u2, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    }
    assert.strictEqual((await post(U.pm, u2, { side: 'demand', name: 'n'.repeat(50) })).status, 201, '50 字通过');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_parties WHERE project_id = ?', [p2]), 1, '参数错误不得留行');
    expectErr(await post(U.m1, url, { side: 'x', name: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '参数非法先于权限');
  });

  test('参与方：改名——PM 成功且事件记改前 / 改后；同名不写事件；别的键 400；非 PM 403；非成员 404；已终止 409；不存在 404', async () => {
    const s = await scene();
    const url = `/sysbuild/parties/${s.party}`;
    const r = await api(U.pm, 'PATCH', url, { name: '  新甲部  ' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { party: { id: s.party, side: 'demand', name: '新甲部' }, changed: true });
    assert.strictEqual((await rowOf('sysbuild_parties', s.party)).name, '新甲部');
    assert.deepStrictEqual(await payloads(s.pid, 'party_renamed'), [{ before: '甲部', after: '新甲部' }]);
    const same = await api(U.pm, 'PATCH', url, { name: '新甲部' });
    assert.strictEqual(same.status, 200);
    assert.strictEqual(same.body.changed, false);
    assert.strictEqual((await eventsOf(s.pid, 'party_renamed')).length, 1, '同名不写事件');
    for (const k of ['side', 'project_id', 'sort_order']) expectErr(await api(U.pm, 'PATCH', url, { name: 'x', [k]: 1 }), 400, 'SYSBUILD_INVALID_INPUT', `键 ${k}`);
    expectErr(await api(U.pm, 'PATCH', url, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺 name');
    expectErr(await api(U.pm, 'PATCH', url, { name: 'n'.repeat(51) }), 400, 'SYSBUILD_INVALID_INPUT', '51 字');
    expectErr(await api(U.m1, 'PATCH', url, { name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
    expectErr(await api(U.own, 'PATCH', url, { name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '负责人也不能改');
    expectErr(await api(U.out, 'PATCH', url, { name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await api(U.pm, 'PATCH', '/sysbuild/parties/99999999', { name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    expectErr(await api(U.pm, 'PATCH', '/sysbuild/parties/abc', { name: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    await setStatus(s.pid, 'terminated');
    expectErr(await api(U.pm, 'PATCH', url, { name: '终止后' }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await rowOf('sysbuild_parties', s.party)).name, '新甲部');
  });

  // ── 成员与加入邀请 ───────────────────────────────────────────────────────────────────
  test('成员：添加有账号——成员行待接受 + 加入邀请（邀请人 = PM）；重复邀请 / 加 PM 本人 / 已是成员 409；party_id 为空 = 内部成员；party 不属本项目与用户不可用 400；非 PM 403；已终止 409', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    await addMember(pid, U.m1);
    const url = `/sysbuild/projects/${pid}/members`;
    const r = await post(U.pm, url, { party_id: party, user_id: U.cand });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.member, { id: r.body.member.id, party_id: party, user_id: U.cand, status: 'pending', joined_at: null });
    assert.deepStrictEqual(r.body.invitation, { id: r.body.invitation.id, kind: 'join', status: 'pending' });
    const m = await rowOf('sysbuild_members', r.body.member.id);
    assert.strictEqual(m.project_id, pid);
    assert.strictEqual(m.party_id, party);
    assert.strictEqual(m.user_id, U.cand);
    assert.strictEqual(m.person_name, null);
    assert.strictEqual(m.joined_at, null);
    assert.strictEqual(m.removed_at, null);
    assert.strictEqual(m.added_by, U.pm);
    const inv = await rowOf('sysbuild_invitations', r.body.invitation.id);
    assert.deepStrictEqual([inv.project_id, inv.member_id, inv.kind, inv.appointment_id, inv.status, inv.invited_by, inv.responded_at], [pid, m.id, 'join', null, 'pending', U.pm, null]);
    const ev = await eventsOf(pid, 'member_invited');
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(JSON.parse(ev[0].payload_json), { user_id: U.cand, party_id: party, invitation_id: inv.id });
    assert.strictEqual(ev[0].object_type, 'member');
    assert.strictEqual(ev[0].object_id, m.id);
    assert.strictEqual(ev[0].operator_id, U.pm);
    // 待接受的受邀人不是成员：项目详情 404，成员列表里对普通成员不可见。
    expectErr(await api(U.cand, 'GET', `/sysbuild/projects/${pid}`), 404, 'SYSBUILD_NOT_FOUND', '待接受的受邀人');
    const n0 = await countOf('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ?', [pid]);
    expectErr(await post(U.pm, url, { party_id: party, user_id: U.cand }), 409, 'SYSBUILD_STATE', '重复邀请');
    expectErr(await post(U.pm, url, { party_id: null, user_id: U.pm }), 409, 'SYSBUILD_STATE', '加 PM 本人');
    expectErr(await post(U.pm, url, { user_id: U.m1 }), 409, 'SYSBUILD_STATE', '已是成员');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ?', [pid]), n0, '被拒绝的添加不得留行');
    // PM 本人没有成员行时（极端数据）也不能把 PM 加为成员
    const noRow = (await sqlRun("INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, created_by) VALUES ('无PM行', 'inhouse', ?, ?)", [U.x1, U.admin])).lastID;
    expectErr(await post(U.x1, `/sysbuild/projects/${noRow}/members`, { user_id: U.x1 }), 409, 'SYSBUILD_STATE', 'PM 无成员行时加 PM 本人');
    // party_id 缺省 / null = 信息技术部内部成员
    const inner = await post(U.pm, url, { party_id: null, user_id: U.cand2 });
    assert.strictEqual(inner.status, 201, inner.text);
    assert.strictEqual((await rowOf('sysbuild_members', inner.body.member.id)).party_id, null);
    const inner2 = await post(U.pm, url, { user_id: U.x1 });
    assert.strictEqual(inner2.status, 201, inner2.text);
    // 引用非法
    const other = await mkProject(U.pm);
    const otherParty = await addParty(other, '别的项目的参与方');
    const bp = await post(U.pm, url, { party_id: otherParty, user_id: U.x2 });
    expectErr(bp, 400, 'SYSBUILD_INVALID_INPUT', 'party 不属本项目');
    assert.strictEqual(bp.body.field, 'party_id');
    expectErr(await post(U.pm, url, { party_id: 99999999, user_id: U.x2 }), 400, 'SYSBUILD_INVALID_INPUT', 'party 不存在');
    const nu = await post(U.pm, url, { user_id: 987654 });
    expectErr(nu, 400, 'SYSBUILD_INVALID_INPUT', '用户不存在');
    assert.strictEqual(nu.body.field, 'user_id');
    await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.inactive]);
    try {
      expectErr(await post(U.pm, url, { user_id: U.inactive }), 400, 'SYSBUILD_INVALID_INPUT', '账号停用');
    } finally {
      await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.inactive]);
    }
    // 权限与状态
    expectErr(await post(U.m1, url, { user_id: U.x2 }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
    expectErr(await post(U.ro, url, { user_id: U.x2 }), 403, 'SYSBUILD_FORBIDDEN', '只读账号（非成员）');
    // fixC：admin（非只读）不必接管即可加成员，邀请人记 admin；D2：管理动作不得作用于操作人本人（admin 邀请自己 409，PM 同样）。
    const byAdmin = await post(U.admin, url, { user_id: U.m2 });
    assert.strictEqual(byAdmin.status, 201, `admin 未接管也可加成员: ${byAdmin.text}`);
    assert.strictEqual((await rowOf('sysbuild_invitations', byAdmin.body.invitation.id)).invited_by, U.admin);
    expectErr(await post(U.admin, url, { user_id: U.admin }), 409, 'SYSBUILD_STATE', 'D2：admin 邀请自己');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.admin]), 0, '被拒绝的自邀不留行');
    expectErr(await post(U.out, url, { user_id: U.x2 }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    await setStatus(pid, 'terminated');
    expectErr(await post(U.pm, url, { user_id: U.x2 }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    await setStatus(pid, 'closed');
    assert.strictEqual((await post(U.pm, url, { user_id: U.x2 })).status, 201, '已结项允许');
  });

  test('成员：添加无账号——直接已加入且不建邀请（事件 member_added 标 no_account）；user_id / person_name 二选一；长度与类型 400', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    const url = `/sysbuild/projects/${pid}/members`;
    const r = await post(U.pm, url, { party_id: party, person_name: '  张三  ' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.invitation, null);
    assert.strictEqual(r.body.member.status, 'joined');
    assert.strictEqual(r.body.member.person_name, '张三');
    const m = await rowOf('sysbuild_members', r.body.member.id);
    assert.strictEqual(m.user_id, null);
    assert.strictEqual(m.person_name, '张三');
    assert.strictEqual(m.party_id, party);
    assert.ok(m.joined_at, '无账号成员直接已加入');
    assert.strictEqual(m.removed_at, null);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_invitations WHERE member_id = ?', [m.id]), 0, '不建邀请');
    const ev = await eventsOf(pid, 'member_added');
    const mine = ev.filter((e) => e.object_id === m.id);
    assert.strictEqual(mine.length, 1);
    assert.deepStrictEqual(JSON.parse(mine[0].payload_json), { user_id: null, person_name: '张三', party_id: party, no_account: true });
    assert.strictEqual((await eventsOf(pid, 'member_invited')).length, 0, '无账号不写 member_invited');
    // 同名可以并存（名录性质）；内部成员（party 缺省）也可以是无账号
    assert.strictEqual((await post(U.pm, url, { person_name: '张三' })).status, 201);
    const detail = await api(U.pm, 'GET', `/sysbuild/projects/${pid}`);
    assert.strictEqual(detail.body.members.filter((x) => x.name === '张三').length, 2);
    // 参数
    const bads = [
      [{ user_id: U.cand, person_name: '李四' }, 'user_id', '二者都给'], [{}, 'user_id', '二者都没给'], [{ person_name: '   ' }, 'person_name', '姓名空白'],
      [{ person_name: 'n'.repeat(51) }, 'person_name', '姓名 51 字'], [{ person_name: 123 }, 'person_name', '姓名非文本'], [{ user_id: 'x' }, 'user_id', 'user_id 非法'],
      [{ user_id: 0 }, 'user_id', 'user_id 为 0'], [{ person_name: '李四', party_id: 'x' }, 'party_id', 'party_id 非法'],
    ];
    for (const [body, field, label] of bads) {
      const b = await post(U.pm, url, body);
      expectErr(b, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(b.body.field, field, `${label} 的 field`);
    }
    assert.strictEqual((await post(U.pm, url, { person_name: 'n'.repeat(50) })).status, 201, '姓名 50 字通过');
  });

  // ── 窄范围入口 ───────────────────────────────────────────────────────────────────────
  test('窄范围入口：受邀人看得到邀请且响应字段恰为约定集合；受邀人 GET 项目详情 404；别人的邀请 404 且与不存在同响应；接受后详情可见', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '财务部');
    const add = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, user_id: U.cand });
    const iid = add.body.invitation.id;
    const v = await api(U.cand, 'GET', `/sysbuild/my/invitations/${iid}`);
    assert.strictEqual(v.status, 200, v.text);
    assert.deepStrictEqual(KEYS(v.body), ['invitation']);
    const inv = v.body.invitation;
    assert.deepStrictEqual(KEYS(inv), ['actions', 'id', 'invited_at', 'invited_by_name', 'kind', 'permission_note', 'project', 'role', 'status'], '顶层键集合全等');
    assert.deepStrictEqual(KEYS(inv.project), ['phase_name', 'system_name']);
    assert.deepStrictEqual(KEYS(inv.role), ['party_name', 'side', 'type']);
    assert.deepStrictEqual(KEYS(inv.actions), ['accept', 'decline']);
    const proj = await sqlGet('SELECT system_name, phase_name FROM sysbuild_projects WHERE id = ?', [pid]);
    const pmUser = await sqlGet('SELECT display_name, username FROM users WHERE id = ?', [U.pm]);
    const invRow = await rowOf('sysbuild_invitations', iid);
    assert.strictEqual(inv.id, iid);
    assert.strictEqual(inv.kind, 'join');
    assert.strictEqual(inv.status, 'pending');
    assert.deepStrictEqual(inv.project, { system_name: proj.system_name, phase_name: proj.phase_name });
    assert.deepStrictEqual(inv.role, { type: 'join', side: 'demand', party_name: '财务部' });
    assert.strictEqual(inv.invited_by_name, pmUser.display_name || pmUser.username);
    assert.strictEqual(inv.invited_at, invRow.created_at);
    assert.ok(inv.permission_note.includes('成员') && !inv.permission_note.includes('负责人') && !inv.permission_note.includes('代表人'), '加入类的权限说明');
    assert.deepStrictEqual(inv.actions, { accept: true, decline: true });
    // 内部成员（无参与方）：角色里 side / party_name 为 null
    const innerAdd = await post(U.pm, `/sysbuild/projects/${pid}/members`, { user_id: U.cand2 });
    const iv2 = await api(U.cand2, 'GET', `/sysbuild/my/invitations/${innerAdd.body.invitation.id}`);
    assert.deepStrictEqual(iv2.body.invitation.role, { type: 'join', side: null, party_name: null });
    // 任职类邀请的说明与加入类不同
    const mOwner = await addMember(pid, U.own, { party });
    const ap = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: mOwner });
    const iv3 = await api(U.own, 'GET', `/sysbuild/my/invitations/${ap.body.invitation.id}`);
    assert.strictEqual(iv3.status, 200, iv3.text);
    assert.deepStrictEqual(KEYS(iv3.body.invitation), KEYS(inv), '任职类同一组键');
    assert.ok(iv3.body.invitation.permission_note.includes('负责人'), '任职类的权限说明');
    assert.notStrictEqual(iv3.body.invitation.permission_note, inv.permission_note);
    assert.strictEqual(iv3.body.invitation.role.type, 'appointment');
    // 列表
    const list = await api(U.cand, 'GET', '/sysbuild/my/invitations');
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(KEYS(list.body), ['delegations', 'invitations']);
    // 用例之间共用一个库，cand 在别的用例里可能还有待处理邀请：只看本用例这一条。
    const listed = list.body.invitations.filter((x) => x.id === iid);
    assert.strictEqual(listed.length, 1);
    assert.deepStrictEqual(KEYS(listed[0]), KEYS(inv), '列表项与窄范围入口同一组键');
    assert.ok(list.body.invitations.every((x) => x.status === 'pending'), '列表只含待处理');
    assert.ok(Array.isArray(list.body.delegations));
    // 受邀人还不是成员
    expectErr(await api(U.cand, 'GET', `/sysbuild/projects/${pid}`), 404, 'SYSBUILD_NOT_FOUND', '受邀人看项目详情');
    const mine = await api(U.cand, 'GET', '/sysbuild/projects?scope=mine');
    assert.ok(!mine.body.projects.map((p) => p.id).includes(pid), '待接受不在 scope=mine 里');
    // 别人的邀请 404，与不存在的邀请同一响应体
    const other = await api(U.x1, 'GET', `/sysbuild/my/invitations/${iid}`);
    const none = await api(U.x1, 'GET', '/sysbuild/my/invitations/99999999');
    expectErr(other, 404, 'SYSBUILD_NOT_FOUND', '别人的邀请');
    expectErr(none, 404, 'SYSBUILD_NOT_FOUND', '不存在的邀请');
    assert.deepStrictEqual(other.body, none.body, '两种 404 响应体必须相同');
    expectErr(await api(U.pm, 'GET', `/sysbuild/my/invitations/${iid}`), 404, 'SYSBUILD_NOT_FOUND', 'PM 也不是受邀人');
    expectErr(await api(U.admin, 'GET', `/sysbuild/my/invitations/${iid}`), 404, 'SYSBUILD_NOT_FOUND', 'admin 也不是受邀人');
    expectErr(await api(U.cand, 'GET', '/sysbuild/my/invitations/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    // 无账号成员没有邀请：任何人查都是 404
    // 接受后详情可见
    const acc = await post(U.cand, `/sysbuild/my/invitations/${iid}/accept`);
    assert.strictEqual(acc.status, 200, acc.text);
    const after = await api(U.cand, 'GET', `/sysbuild/projects/${pid}`);
    assert.strictEqual(after.status, 200, '接受后成为成员，详情可见');
    assert.ok(after.body.members.some((x) => x.user_id === U.cand && x.status === 'joined'));
    assert.ok((await api(U.cand, 'GET', '/sysbuild/projects?scope=mine')).body.projects.map((p) => p.id).includes(pid));
    // L4：窄范围入口只对「指向本人的有效邀请」（pending 且成员行未移出）返回——处理过的与不存在同一响应体。
    const done = await api(U.cand, 'GET', `/sysbuild/my/invitations/${iid}`);
    expectErr(done, 404, 'SYSBUILD_NOT_FOUND', '已接受的邀请');
    assert.deepStrictEqual(done.body, none.body, '已接受的邀请与不存在同一响应体');
    assert.ok(!(await api(U.cand, 'GET', '/sysbuild/my/invitations')).body.invitations.some((x) => x.id === iid), '处理后不在待处理列表里');
    // 已拒绝 / 已撤回 / 成员行已移出（邀请仍 pending 的数据）也一样 404，不暴露项目名与参与方现名
    const d1 = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, user_id: U.x1 });
    assert.strictEqual((await post(U.x1, `/sysbuild/my/invitations/${d1.body.invitation.id}/decline`)).status, 200);
    expectErr(await api(U.x1, 'GET', `/sysbuild/my/invitations/${d1.body.invitation.id}`), 404, 'SYSBUILD_NOT_FOUND', '已拒绝的邀请');
    const d2 = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, user_id: U.x2 });
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${d2.body.member.id}/remove`, { reason: '撤销邀请' })).status, 200);
    await api(U.pm, 'PATCH', `/sysbuild/parties/${party}`, { name: '移出后改名' });
    expectErr(await api(U.x2, 'GET', `/sysbuild/my/invitations/${d2.body.invitation.id}`), 404, 'SYSBUILD_NOT_FOUND', '被撤回的邀请');
    const d3 = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, user_id: U.x3 });
    await sqlRun('UPDATE sysbuild_members SET removed_at = ?, removed_reason = ? WHERE id = ?', ['2026-10-05 10:00:00', '构造', d3.body.member.id]);
    expectErr(await api(U.x3, 'GET', `/sysbuild/my/invitations/${d3.body.invitation.id}`), 404, 'SYSBUILD_NOT_FOUND', '成员行已移出但邀请仍 pending');
  });

  test('加入邀请：接受与拒绝——接受写 joined_at 与 responded_at；拒绝后成员行已移出（原因「拒绝加入」）、可再次邀请；事件手写核对；处理过的邀请再处理 409', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    const url = `/sysbuild/projects/${pid}/members`;
    const a = await post(U.pm, url, { party_id: party, user_id: U.cand });
    const acc = await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/accept`);
    assert.strictEqual(acc.status, 200, acc.text);
    assert.deepStrictEqual(acc.body, { invitation: { id: a.body.invitation.id, kind: 'join', status: 'accepted' }, project_id: pid });
    const m = await rowOf('sysbuild_members', a.body.member.id);
    assert.ok(m.joined_at && m.removed_at === null);
    const inv = await rowOf('sysbuild_invitations', a.body.invitation.id);
    assert.strictEqual(inv.status, 'accepted');
    assert.ok(inv.responded_at);
    assert.deepStrictEqual(await payloads(pid, 'invitation_accepted'), [{ kind: 'join', member_id: m.id, appointment_id: null }]);
    // M-3：接受加入 = 邀请 accepted + 成员行 joined 两个对象各一条事件（member_joined 不复用 member_added）
    const joinedEv = await eventsOf(pid, 'member_joined');
    assert.strictEqual(joinedEv.length, 1);
    assert.deepStrictEqual(JSON.parse(joinedEv[0].payload_json), { user_id: U.cand, party_id: party, invitation_id: a.body.invitation.id });
    assert.deepStrictEqual([joinedEv[0].object_type, joinedEv[0].object_id, joinedEv[0].operator_id], ['member', m.id, U.cand]);
    assert.strictEqual((await eventsOf(pid, 'invitation_accepted')).length, 1);
    assert.strictEqual((await eventsOf(pid, 'member_added')).filter((e) => e.object_id === m.id).length, 0, '不复用 member_added（建成员行的语义）');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '重复接受');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/decline`), 409, 'SYSBUILD_STATE', '接受后拒绝');
    assert.strictEqual((await eventsOf(pid, 'member_joined')).length, 1, '被拒绝的重复请求不再写事件');
    // 拒绝
    const b = await post(U.pm, url, { party_id: party, user_id: U.cand2 });
    const dec = await post(U.cand2, `/sysbuild/my/invitations/${b.body.invitation.id}/decline`);
    assert.strictEqual(dec.status, 200, dec.text);
    assert.strictEqual(dec.body.invitation.status, 'declined');
    const m2 = await rowOf('sysbuild_members', b.body.member.id);
    assert.ok(m2.removed_at, '拒绝后成员行已移出');
    assert.strictEqual(m2.removed_reason, '拒绝加入');
    assert.strictEqual(m2.joined_at, null);
    const inv2 = await rowOf('sysbuild_invitations', b.body.invitation.id);
    assert.strictEqual(inv2.status, 'declined');
    assert.ok(inv2.responded_at);
    assert.deepStrictEqual(await payloads(pid, 'invitation_declined'), [{ kind: 'join', member_id: m2.id, appointment_id: null }]);
    const rem = (await eventsOf(pid, 'member_removed')).filter((e) => e.object_id === m2.id);
    assert.strictEqual(rem.length, 1);
    assert.deepStrictEqual(JSON.parse(rem[0].payload_json), { user_id: U.cand2, party_id: party, reason: '拒绝加入', via: 'decline' });
    expectErr(await post(U.cand2, `/sysbuild/my/invitations/${b.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '拒绝后再接受');
    // 可再次邀请，且新的邀请可接受
    const again = await post(U.pm, url, { party_id: party, user_id: U.cand2 });
    assert.strictEqual(again.status, 201, again.text);
    assert.notStrictEqual(again.body.member.id, b.body.member.id, '新建成员行，旧的已移出行保留');
    assert.strictEqual((await post(U.cand2, `/sysbuild/my/invitations/${again.body.invitation.id}/accept`)).status, 200);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.cand2]), 2);
    // 参数与归属
    expectErr(await post(U.cand, '/sysbuild/my/invitations/abc/accept'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await post(U.cand, '/sysbuild/my/invitations/99999999/accept'), 404, 'SYSBUILD_NOT_FOUND', '不存在');
  });

  test('加入邀请：邀请人资格重核——更换 PM 时原 PM 的待处理邀请及关联对象被同事务撤回（M1 ③）；接受时重核不通过 → 409 并收掉关联成员行 / 任职（M1 ②）；拒绝不重核（M1 ①）；admin 邀请仍有效且只读 admin 不算（L7）；重核防御分支（L1）', async () => {
    // ── M1 ③：更换 PM 的同一事务里撤回原 PM 发出的待处理邀请，并收掉关联的待接受成员行 / 任职提议 ──
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    await addMember(pid, U.m1);
    const mAp = await addMember(pid, U.x1, { party });
    const url = `/sysbuild/projects/${pid}/members`;
    const a = await post(U.pm, url, { party_id: party, user_id: U.cand });
    const b = await post(U.pm, url, { party_id: party, user_id: U.cand2 });
    const c = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: mAp });
    assert.strictEqual(c.status, 201, c.text);
    const swap = await post(U.admin, `/sysbuild/projects/${pid}/pm`, { pm_user_id: U.m1, reason: '中途更换 PM' });
    assert.strictEqual(swap.status, 200, swap.text);
    for (const inv of [a.body.invitation, b.body.invitation, c.body.invitation]) {
      const row = await rowOf('sysbuild_invitations', inv.id);
      assert.strictEqual(row.status, 'withdrawn', `邀请 ${inv.id} 随更换 PM 被撤回`);
      assert.ok(row.responded_at);
    }
    for (const m of [a.body.member, b.body.member]) {
      const row = await rowOf('sysbuild_members', m.id);
      assert.ok(row.removed_at, '关联的待接受成员行已移出');
      assert.strictEqual(row.removed_reason, '邀请已失效');
      assert.strictEqual(row.joined_at, null);
    }
    assert.strictEqual((await rowOf('sysbuild_appointments', c.body.appointment.id)).status, 'withdrawn', '关联的待接受任职提议已撤回');
    assert.strictEqual((await rowOf('sysbuild_members', mAp)).removed_at, null, '任职类邀请不移出已加入的成员');
    assert.strictEqual((await eventsOf(pid, 'invitation_withdrawn')).length, 3);
    const mrem = (await payloads(pid, 'member_removed')).filter((p) => p.reason === '邀请已失效');
    assert.deepStrictEqual(mrem.map((p) => p.via), ['pm_change', 'pm_change']);
    assert.strictEqual((await eventsOf(pid, 'appointment_withdrawn')).length, 1);
    assert.ok((await eventsOf(pid, 'invitation_withdrawn')).every((e) => e.operator_id === U.admin), '事件操作人是更换 PM 的 admin');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '已撤回再接受');
    expectErr(await post(U.x1, `/sysbuild/my/invitations/${c.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', 'M2：PM1 提议任职 → 换 PM → 受邀人接受');
    assert.strictEqual((await rowOf('sysbuild_appointments', c.body.appointment.id)).status, 'withdrawn');
    // 被撤回的邀请不卡死受邀人：新 PM 可重新邀请
    const re = await post(U.m1, url, { party_id: party, user_id: U.cand });
    assert.strictEqual(re.status, 201, re.text);
    assert.strictEqual((await post(U.cand, `/sysbuild/my/invitations/${re.body.invitation.id}/accept`)).status, 200);
    // ── M1 ②：接受时重核不通过（造数据：邀请人既不是 PM 也不是 admin）→ 409，邀请置 withdrawn，同事务收关联成员行 ──
    const pid2 = await mkProject(U.pm);
    const party2 = await addParty(pid2, '乙部');
    const mJ = await addMember(pid2, U.cand, { party: party2, pending: true });
    const iJ = await addInvitation(pid2, mJ, 'join', 'pending', U.x3);
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iJ}/accept`), 409, 'SYSBUILD_STATE', '邀请人无权时接受');
    assert.strictEqual((await rowOf('sysbuild_invitations', iJ)).status, 'withdrawn', '邀请被置为已撤回（事务内提交，不随 409 回滚）');
    assert.ok((await rowOf('sysbuild_invitations', iJ)).responded_at);
    const mJrow = await rowOf('sysbuild_members', mJ);
    assert.ok(mJrow.removed_at && mJrow.removed_reason === '邀请已失效' && mJrow.joined_at === null, '待接受成员行同事务置为已移出（原因邀请已失效）');
    const jEv = (await payloads(pid2, 'invitation_withdrawn'))[0];
    assert.strictEqual(jEv.stale, true);
    assert.strictEqual(jEv.via, 'accept');
    assert.ok(jEv.reason && jEv.reason.length > 0, '事件写明原因');
    assert.deepStrictEqual((await payloads(pid2, 'member_removed')).map((p) => [p.reason, p.via]), [['邀请已失效', 'accept']]);
    const reinv = await post(U.pm, `/sysbuild/projects/${pid2}/members`, { party_id: party2, user_id: U.cand });
    assert.strictEqual(reinv.status, 201, '成员行已收掉，可重新邀请（不留僵尸待接受行）');
    // 任职类：重核不通过 → 邀请 withdrawn + 关联任职 withdrawn
    const mA = await addMember(pid2, U.x1, { party: party2 });
    const apS = await addAppointment(party2, mA, 'pending');
    const iA = await addInvitation(pid2, mA, 'appointment', 'pending', U.x3, apS);
    expectErr(await post(U.x1, `/sysbuild/my/invitations/${iA}/accept`), 409, 'SYSBUILD_STATE', '任职类：邀请人无权时接受');
    assert.strictEqual((await rowOf('sysbuild_invitations', iA)).status, 'withdrawn');
    assert.strictEqual((await rowOf('sysbuild_appointments', apS)).status, 'withdrawn', '关联任职同事务撤回');
    assert.strictEqual((await rowOf('sysbuild_members', mA)).removed_at, null, '已加入的成员不受影响');
    assert.deepStrictEqual((await payloads(pid2, 'appointment_withdrawn')).map((p) => [p.stale, p.via]), [[true, 'accept']]);
    // ── M1 ①：拒绝不重核——邀请人无权时受邀人仍能明确回绝 ──
    const mJ2 = await addMember(pid2, U.cand2, { party: party2, pending: true });
    const iJ2 = await addInvitation(pid2, mJ2, 'join', 'pending', U.x3);
    const dj = await post(U.cand2, `/sysbuild/my/invitations/${iJ2}/decline`);
    assert.strictEqual(dj.status, 200, `邀请人无权时拒绝加入仍可: ${dj.text}`);
    assert.strictEqual((await rowOf('sysbuild_invitations', iJ2)).status, 'declined');
    assert.strictEqual((await rowOf('sysbuild_members', mJ2)).removed_reason, '拒绝加入');
    const mA2 = await addMember(pid2, U.x2, { party: party2 });
    const apS2 = await addAppointment(party2, mA2, 'pending');
    const iA2 = await addInvitation(pid2, mA2, 'appointment', 'pending', U.x3, apS2);
    assert.strictEqual((await post(U.x2, `/sysbuild/my/invitations/${iA2}/decline`)).status, 200, '邀请人无权时拒绝任职仍可');
    assert.strictEqual((await rowOf('sysbuild_invitations', iA2)).status, 'declined');
    assert.strictEqual((await rowOf('sysbuild_appointments', apS2)).status, 'rejected');
    // ── L1：重核的其余防御分支（直接写库造数据）──
    // C6 成员行已移出而邀请仍 pending；C7 关联任职已不是待接受；C8 受邀人已是本项目 PM（邀请人 = 受邀人本人，故邀请人资格本身有效）
    const pid3 = await mkProject(U.pm);
    const party3 = await addParty(pid3, '丙部');
    const mR = await addMember(pid3, U.cand, { party: party3, removed: true });
    const iR = await addInvitation(pid3, mR, 'join', 'pending', U.pm);
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iR}/accept`), 409, 'SYSBUILD_STATE', 'C6：成员行已移出');
    assert.strictEqual((await rowOf('sysbuild_invitations', iR)).status, 'withdrawn');
    const mW = await addMember(pid3, U.cand2, { party: party3 });
    const apW = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by) VALUES (?, ?, 'withdrawn', ?)", [party3, mW, U.pm])).lastID;
    const iW = await addInvitation(pid3, mW, 'appointment', 'pending', U.pm, apW);
    expectErr(await post(U.cand2, `/sysbuild/my/invitations/${iW}/accept`), 409, 'SYSBUILD_STATE', 'C7：任职已不是待接受');
    assert.strictEqual((await rowOf('sysbuild_invitations', iW)).status, 'withdrawn');
    assert.strictEqual((await rowOf('sysbuild_appointments', apW)).status, 'withdrawn', '任职原样不动');
    const mP = await addMember(pid3, U.x1, { party: party3 });
    const apP = await addAppointment(party3, mP, 'pending');
    const iP = await addInvitation(pid3, mP, 'appointment', 'pending', U.x1, apP);
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.x1, pid3]);
    expectErr(await post(U.x1, `/sysbuild/my/invitations/${iP}/accept`), 409, 'SYSBUILD_STATE', 'C8：受邀人已是 PM');
    assert.strictEqual((await rowOf('sysbuild_invitations', iP)).status, 'withdrawn');
    assert.strictEqual((await rowOf('sysbuild_appointments', apP)).status, 'withdrawn', '关联任职同事务撤回');
    // 对照：同样的造数不满足失效条件时接受成功（证明上面的 409 来自重核，而不是别的）
    const pid4 = await mkProject(U.pm);
    const party4 = await addParty(pid4, '丁部');
    const mOk = await addMember(pid4, U.x2, { party: party4 });
    const apOk = await addAppointment(party4, mOk, 'pending');
    const iOk = await addInvitation(pid4, mOk, 'appointment', 'pending', U.pm, apOk);
    assert.strictEqual((await post(U.x2, `/sysbuild/my/invitations/${iOk}/accept`)).status, 200, '对照：条件满足时接受成功');
    // ── L7：admin 邀请人仍有效，但只读账号即使角色是 admin 也不算 ──
    const pid5 = await mkProject(U.pm);
    const m5a = await addMember(pid5, U.cand, { party: null, pending: true });
    const m5b = await addMember(pid5, U.cand2, { party: null, pending: true });
    const i5a = await addInvitation(pid5, m5a, 'join', 'pending', U.admin);
    const i5b = await addInvitation(pid5, m5b, 'join', 'pending', U.ro);
    const roRole = (await sqlGet('SELECT role FROM users WHERE id = ?', [U.ro])).role;
    await sqlRun("UPDATE users SET role = 'admin' WHERE id = ?", [U.ro]);
    try {
      assert.strictEqual((await post(U.cand, `/sysbuild/my/invitations/${i5a}/accept`)).status, 200, 'admin 邀请人（非 PM）仍有效');
      expectErr(await post(U.cand2, `/sysbuild/my/invitations/${i5b}/accept`), 409, 'SYSBUILD_STATE', 'L7：只读账号即使角色是 admin 也不算有权邀请人');
    } finally {
      await sqlRun('UPDATE users SET role = ? WHERE id = ?', [roRole, U.ro]);
    }
    // ── M-2：只读否决先于 PM 身份——PM 发出邀请后被加入只读名单，其待处理邀请失效 ──
    //   夹具的只读名单是注入的固定集合（真实实例里是 server.js 的 READONLY_LEADER_IDS），测试里改不了；改为让只读账号（U.ro）本来就是
    //   这个项目的 PM、邀请人记为它——等价于「发邀请时它还不在名单里，之后被加入名单」。修复前 PM 分支先返回有权，接受会成功。
    const pidRo = await mkProject(U.ro);
    const partyRo = await addParty(pidRo, '只读PM部');
    const mRoJ = await addMember(pidRo, U.cand, { party: partyRo, pending: true });
    const iRoJ = await addInvitation(pidRo, mRoJ, 'join', 'pending', U.ro);
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iRoJ}/accept`), 409, 'SYSBUILD_STATE', 'M-2：邀请人是只读账号（即使是本项目 PM）');
    assert.strictEqual((await rowOf('sysbuild_invitations', iRoJ)).status, 'withdrawn');
    assert.ok((await rowOf('sysbuild_members', mRoJ)).removed_at, '关联的待接受成员行同事务收尾');
    const mRoA = await addMember(pidRo, U.x1, { party: partyRo });
    const apRoA = await addAppointment(partyRo, mRoA, 'pending');
    const iRoA = await addInvitation(pidRo, mRoA, 'appointment', 'pending', U.ro, apRoA);
    expectErr(await post(U.x1, `/sysbuild/my/invitations/${iRoA}/accept`), 409, 'SYSBUILD_STATE', 'M-2：任职类');
    assert.strictEqual((await rowOf('sysbuild_invitations', iRoA)).status, 'withdrawn');
    assert.strictEqual((await rowOf('sysbuild_appointments', apRoA)).status, 'withdrawn', '关联任职同事务收尾');
    const rjEv = (await payloads(pidRo, 'invitation_withdrawn')).filter((p) => p.stale === true);
    assert.strictEqual(rjEv.length, 2);
    // ── admin 作为邀请人：接管后发邀请，再把 PM 换成别人，admin 的邀请不被更换 PM 撤回，仍有权 ──
    const pid6 = await mkProject(U.pm);
    await addMember(pid6, U.m1);
    const pmInv = await post(U.pm, `/sysbuild/projects/${pid6}/members`, { user_id: U.x3 });
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid6}/pm`, { pm_user_id: U.admin, reason: '接管' })).status, 200);
    assert.strictEqual((await rowOf('sysbuild_invitations', pmInv.body.invitation.id)).status, 'withdrawn', '接管同样撤回原 PM 的邀请');
    const adminInv = await post(U.admin, `/sysbuild/projects/${pid6}/members`, { user_id: U.x1 });
    assert.strictEqual(adminInv.status, 201, adminInv.text);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid6}/pm`, { pm_user_id: U.m1, reason: '换给 m1' })).status, 200);
    assert.strictEqual((await rowOf('sysbuild_invitations', adminInv.body.invitation.id)).status, 'pending', 'admin 发出的邀请不被更换 PM 撤回');
    assert.strictEqual((await rowOf('sysbuild_members', adminInv.body.member.id)).removed_at, null);
    const adminOk = await post(U.x1, `/sysbuild/my/invitations/${adminInv.body.invitation.id}/accept`);
    assert.strictEqual(adminOk.status, 200, `admin 邀请的邀请在 PM 更换后仍有效: ${adminOk.text}`);
    assert.strictEqual((await rowOf('sysbuild_invitations', adminInv.body.invitation.id)).status, 'accepted');
    // 邀请人仍是 PM：正常
    const byPm = await post(U.m1, `/sysbuild/projects/${pid6}/members`, { user_id: U.x2 });
    assert.strictEqual((await post(U.x2, `/sysbuild/my/invitations/${byPm.body.invitation.id}/accept`)).status, 200);
  });

  test('加入邀请：项目状态与只读账号——已终止接受 / 拒绝 409（邀请保持待处理）；已暂停、已结项可接受（D3）；只读账号可接受', async () => {
    const pid = await mkProject(U.pm);
    const url = `/sysbuild/projects/${pid}/members`;
    const a = await post(U.pm, url, { user_id: U.cand });
    const b = await post(U.pm, url, { user_id: U.cand2 });
    await setStatus(pid, 'terminated');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/accept`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止接受');
    expectErr(await post(U.cand2, `/sysbuild/my/invitations/${b.body.invitation.id}/decline`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止拒绝');
    assert.strictEqual((await rowOf('sysbuild_invitations', a.body.invitation.id)).status, 'pending', '邀请保持待处理');
    assert.strictEqual((await rowOf('sysbuild_members', a.body.member.id)).joined_at, null);
    const lst = await api(U.cand, 'GET', `/sysbuild/my/invitations/${a.body.invitation.id}`);
    assert.deepStrictEqual(lst.body.invitation.actions, { accept: false, decline: false }, '终止项目里 actions 与执行一致');
    await setStatus(pid, 'paused');
    assert.deepStrictEqual((await api(U.cand, 'GET', `/sysbuild/my/invitations/${a.body.invitation.id}`)).body.invitation.actions, { accept: true, decline: true });
    assert.strictEqual((await post(U.cand, `/sysbuild/my/invitations/${a.body.invitation.id}/accept`)).status, 200, '已暂停可接受');
    await setStatus(pid, 'closed');
    assert.strictEqual((await post(U.cand2, `/sysbuild/my/invitations/${b.body.invitation.id}/accept`)).status, 200, '已结项可接受（D3：membership 类别）');
    // 只读账号可以作本人确认类动作
    const pid2 = await mkProject(U.pm);
    const r = await post(U.pm, `/sysbuild/projects/${pid2}/members`, { user_id: U.ro });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual((await api(U.ro, 'GET', `/sysbuild/my/invitations/${r.body.invitation.id}`)).body.invitation.actions, { accept: true, decline: true });
    const ok = await post(U.ro, `/sysbuild/my/invitations/${r.body.invitation.id}/accept`);
    assert.strictEqual(ok.status, 200, `只读账号可接受: ${ok.text}`);
    assert.ok((await rowOf('sysbuild_members', r.body.member.id)).joined_at);
    const pid3 = await mkProject(U.pm);
    const r3 = await post(U.pm, `/sysbuild/projects/${pid3}/members`, { user_id: U.ro });
    assert.strictEqual((await post(U.ro, `/sysbuild/my/invitations/${r3.body.invitation.id}/decline`)).status, 200, '只读账号可拒绝');
  });

  test('加入邀请：joined_at 条件更新——成员行已不是待接受时接受 409 且不覆盖 joined_at、邀请保持待处理', async () => {
    const pid = await mkProject(U.pm);
    const mid = await addMember(pid, U.cand); // 已加入的成员行（joined_at = 2026-10-01 10:00:00）
    const iid = await addInvitation(pid, mid, 'join', 'pending', U.pm);
    const before = (await rowOf('sysbuild_members', mid)).joined_at;
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iid}/accept`), 409, 'SYSBUILD_STATE', '成员行已不是待接受');
    assert.strictEqual((await rowOf('sysbuild_members', mid)).joined_at, before, 'joined_at 不被覆盖');
    assert.strictEqual((await rowOf('sysbuild_invitations', iid)).status, 'pending', '失败的事务整体回滚');
    assert.strictEqual((await eventsOf(pid, 'invitation_accepted')).length, 0);
    assert.strictEqual((await eventsOf(pid, 'member_joined')).length, 0, '事务回滚：成员事件也不落');
  });

  // ── 任职 ─────────────────────────────────────────────────────────────────────────────
  test('任职：提议与校验——未加入 / 已移出成员 409；成员行属参与方的 PM 409；成员不属该参与方 400；已有待接受提议 409；已是现任 409；有账号建邀请、无账号只建任职；非 PM 403；终止 409', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    const party2 = await addParty(pid, '乙部');
    const url = `/sysbuild/parties/${party}/appointments`;
    const mPend = await addMember(pid, U.x1, { party, pending: true });
    const mGone = await addMember(pid, U.x2, { party, removed: true });
    const mOk = await addMember(pid, U.cand, { party });
    const mOther = await addMember(pid, U.cand2, { party: party2 });
    const mNoParty = await addMember(pid, U.m1);
    expectErr(await post(U.pm, url, { member_id: mPend }), 409, 'SYSBUILD_STATE', '未加入成员');
    expectErr(await post(U.pm, url, { member_id: mGone }), 409, 'SYSBUILD_STATE', '已移出成员');
    const bad = await post(U.pm, url, { member_id: mOther });
    expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', '成员属于别的参与方');
    assert.strictEqual(bad.body.field, 'member_id');
    expectErr(await post(U.pm, url, { member_id: mNoParty }), 400, 'SYSBUILD_INVALID_INPUT', '成员不属于任何参与方');
    expectErr(await post(U.pm, url, { member_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '成员不存在');
    expectErr(await post(U.pm, url, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺 member_id');
    expectErr(await post(U.pm, url, { member_id: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', 'member_id 非法');
    const otherProj = await mkProject(U.pm);
    const otherParty = await addParty(otherProj, '别项目参与方');
    const mForeign = await addMember(otherProj, U.x3, { party: otherParty });
    expectErr(await post(U.pm, url, { member_id: mForeign }), 400, 'SYSBUILD_INVALID_INPUT', '别项目的成员');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_appointments WHERE party_id = ?', [party]), 0, '被拒绝的提议不留行');
    // 权限
    expectErr(await post(U.m1, url, { member_id: mOk }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
    expectErr(await post(U.out, url, { member_id: mOk }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/parties/99999999/appointments', { member_id: mOk }), 404, 'SYSBUILD_NOT_FOUND', '参与方不存在');
    // 有账号：任职 pending + 邀请 kind=appointment 关联任职
    const ok = await post(U.pm, url, { member_id: mOk });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual(ok.body.appointment, { id: ok.body.appointment.id, party_id: party, member_id: mOk, status: 'pending' });
    const ap = await rowOf('sysbuild_appointments', ok.body.appointment.id);
    assert.deepStrictEqual([ap.party_id, ap.member_id, ap.status, ap.proposed_by, ap.effective_at, ap.ended_at], [party, mOk, 'pending', U.pm, null, null]);
    const inv = await rowOf('sysbuild_invitations', ok.body.invitation.id);
    assert.deepStrictEqual([inv.project_id, inv.member_id, inv.kind, inv.appointment_id, inv.status, inv.invited_by], [pid, mOk, 'appointment', ap.id, 'pending', U.pm]);
    assert.deepStrictEqual(await payloads(pid, 'appointment_proposed'), [{ party_id: party, member_id: mOk, invitation_id: inv.id, no_account: false }]);
    // 已有待接受提议：换一个成员也 409
    const mOk2 = await addMember(pid, U.x3, { party });
    expectErr(await post(U.pm, url, { member_id: mOk2 }), 409, 'SYSBUILD_STATE', '已有待接受的提议');
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${ap.id}/withdraw`)).status, 200);
    // 无账号成员：只建任职，不建邀请
    const noAcc = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, person_name: '王五' });
    const na = await post(U.pm, url, { member_id: noAcc.body.member.id });
    assert.strictEqual(na.status, 201, na.text);
    assert.strictEqual(na.body.invitation, null);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_invitations WHERE appointment_id = ?', [na.body.appointment.id]), 0, '不建邀请');
    assert.strictEqual((await rowOf('sysbuild_appointments', na.body.appointment.id)).status, 'pending', '停在待接受（C4 代录）');
    const naEv = (await payloads(pid, 'appointment_proposed')).filter((p) => p.member_id === noAcc.body.member.id);
    assert.deepStrictEqual(naEv, [{ party_id: party, member_id: noAcc.body.member.id, invitation_id: null, no_account: true }]);
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${na.body.appointment.id}/withdraw`)).status, 200, '无账号的待接受任职可撤回（无邀请可撤）');
    // 已是现任
    const cur = await addAppointment(party, mOk2, 'active');
    expectErr(await post(U.pm, url, { member_id: mOk2 }), 409, 'SYSBUILD_STATE', '已是现任负责人');
    assert.ok(cur);
    // PM 不得兼任：成员行属参与方但 user 是本项目 PM（构造极端数据：把 PM 换成该成员的 user）
    const pid3 = await mkProject(U.pm);
    const party3 = await addParty(pid3, '丙部');
    const mAsPm = await addMember(pid3, U.cand, { party: party3 });
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.cand, pid3]);
    // 操作人用 admin（不是目标本人），这样挡住它的只能是「PM 不得兼任」而不是 D2。
    expectErr(await post(U.admin, `/sysbuild/parties/${party3}/appointments`, { member_id: mAsPm }), 409, 'SYSBUILD_STATE', 'PM 不得兼任负责人');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_appointments WHERE party_id = ?', [party3]), 0);
    // fixC：admin（非只读）不必接管即可提议任职；D2：管理动作不得作用于操作人本人（admin 任命自己 409，PM 任命 admin 则可以）
    const pid5 = await mkProject(U.pm);
    const party5 = await addParty(pid5, '戊部');
    const mOther5 = await addMember(pid5, U.x1, { party: party5 });
    const byAdmin = await post(U.admin, `/sysbuild/parties/${party5}/appointments`, { member_id: mOther5 });
    assert.strictEqual(byAdmin.status, 201, `admin 未接管也可提议任职: ${byAdmin.text}`);
    assert.strictEqual((await rowOf('sysbuild_invitations', byAdmin.body.invitation.id)).invited_by, U.admin);
    assert.strictEqual((await post(U.admin, `/sysbuild/appointments/${byAdmin.body.appointment.id}/withdraw`)).status, 200, 'admin 可撤回');
    const mAdm5 = await addMember(pid5, U.admin, { party: party5 }); // 构造：admin 已是该方成员（例如 PM 邀请、admin 接受之后）
    expectErr(await post(U.admin, `/sysbuild/parties/${party5}/appointments`, { member_id: mAdm5 }), 409, 'SYSBUILD_STATE', 'D2：admin 任命自己');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_appointments WHERE member_id = ?', [mAdm5]), 0, '被拒绝的自任不留行');
    assert.strictEqual((await post(U.pm, `/sysbuild/parties/${party5}/appointments`, { member_id: mAdm5 })).status, 201, '由别人（PM）任命 admin 不受 D2 限制');
    // 项目状态
    const pid4 = await mkProject(U.pm);
    const party4 = await addParty(pid4, '丁部');
    const m4 = await addMember(pid4, U.cand, { party: party4 });
    await setStatus(pid4, 'terminated');
    expectErr(await post(U.pm, `/sysbuild/parties/${party4}/appointments`, { member_id: m4 }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    await setStatus(pid4, 'closed');
    assert.strictEqual((await post(U.pm, `/sysbuild/parties/${party4}/appointments`, { member_id: m4 })).status, 201, '已结项允许');
  });

  test('任职：接受生效与原负责人更换——同一事务内原任职 ended、基于原任职的授权 revoked / 待定提议 withdrawn，各表终态与事件手写核对；他方不受影响', async () => {
    const s = await scene();
    const mM2 = await addMember(s.pid, U.m2, { party: s.party });
    const mCand = await addMember(s.pid, U.cand, { party: s.party });
    const dActive = await addDelegation(s.party, s.mDel, s.apt, 'active');
    const dPending = await addDelegation(s.party, mM2, s.apt, 'pending_accept');
    const dOwner = await addDelegation(s.party, mCand, s.apt, 'pending_owner');
    // 他方：另一方有自己的现任与授权，不应受影响
    const partyB = await addParty(s.pid, '乙部');
    const mB = await addMember(s.pid, U.x1, { party: partyB });
    const aptB = await addAppointment(partyB, mB, 'active');
    const mBd = await addMember(s.pid, U.x2, { party: partyB });
    const dB = await addDelegation(partyB, mBd, aptB, 'active');
    const prop = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mCand });
    assert.strictEqual(prop.status, 201, prop.text);
    // 提议期间原负责人仍是现任
    assert.strictEqual((await rowOf('sysbuild_appointments', s.apt)).status, 'active');
    const acc = await post(U.cand, `/sysbuild/my/invitations/${prop.body.invitation.id}/accept`);
    assert.strictEqual(acc.status, 200, acc.text);
    assert.deepStrictEqual(acc.body, { invitation: { id: prop.body.invitation.id, kind: 'appointment', status: 'accepted' }, project_id: s.pid });
    const newAp = await rowOf('sysbuild_appointments', prop.body.appointment.id);
    assert.strictEqual(newAp.status, 'active');
    assert.ok(newAp.effective_at, '新任职写 effective_at');
    const oldAp = await rowOf('sysbuild_appointments', s.apt);
    assert.strictEqual(oldAp.status, 'ended');
    assert.ok(oldAp.ended_at);
    assert.strictEqual(oldAp.end_reason, '负责人更换');
    const dA = await rowOf('sysbuild_delegations', dActive);
    assert.strictEqual(dA.status, 'revoked');
    assert.ok(dA.revoked_at);
    assert.strictEqual(dA.revoke_reason, '负责人更换后需重新授权');
    assert.strictEqual((await rowOf('sysbuild_delegations', dPending)).status, 'withdrawn', '待接受的授权提议 withdrawn');
    assert.strictEqual((await rowOf('sysbuild_delegations', dOwner)).status, 'withdrawn', '待负责人确认的授权提议 withdrawn');
    assert.strictEqual((await rowOf('sysbuild_delegations', dB)).status, 'active', '他方授权不受影响');
    assert.strictEqual((await rowOf('sysbuild_appointments', aptB)).status, 'active', '他方任职不受影响');
    const inv = await rowOf('sysbuild_invitations', prop.body.invitation.id);
    assert.strictEqual(inv.status, 'accepted');
    assert.ok(inv.responded_at);
    // 事件
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_activated'), [{ party_id: s.party, member_id: mCand, replaced: [s.apt] }]);
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_ended'), [{ party_id: s.party, member_id: s.mOwn, end_reason: '负责人更换' }]);
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_revoked'), [{ party_id: s.party, member_id: s.mDel, reason: '负责人更换后需重新授权' }]);
    const wd = (await payloads(s.pid, 'delegation_withdrawn')).map((p) => p.member_id).sort((a, b) => a - b);
    assert.deepStrictEqual(wd, [mM2, mCand].sort((a, b) => a - b));
    assert.strictEqual((await payloads(s.pid, 'invitation_accepted')).length, 1);
    // 新负责人身份生效；原负责人退为一般成员
    const nd = await api(U.cand, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(nd.body.me.owner_of_parties, [s.party]);
    const od = await api(U.own, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(od.body.me.owner_of_parties, []);
    assert.strictEqual(nd.body.parties.find((p) => p.id === s.party).owner.member_id, mCand);
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${prop.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '重复接受');
  });

  test('任职：撤回 / 结束 / 拒绝——撤回同时撤邀请；结束处理基于它的授权；拒绝置 rejected；对象状态不符与权限 / 项目状态', async () => {
    const s = await scene();
    const mC = await addMember(s.pid, U.cand, { party: s.party });
    const dA = await addDelegation(s.party, s.mDel, s.apt, 'active');
    const mM2 = await addMember(s.pid, U.m2, { party: s.party });
    const dP = await addDelegation(s.party, mM2, s.apt, 'pending_owner');
    // 撤回
    const p1 = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mC });
    expectErr(await post(U.own, `/sysbuild/appointments/${p1.body.appointment.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', '负责人不能撤回');
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/withdraw`), 409, 'SYSBUILD_STATE', '现任不能撤回');
    const w = await post(U.pm, `/sysbuild/appointments/${p1.body.appointment.id}/withdraw`);
    assert.strictEqual(w.status, 200, w.text);
    assert.strictEqual((await rowOf('sysbuild_appointments', p1.body.appointment.id)).status, 'withdrawn');
    const wi = await rowOf('sysbuild_invitations', p1.body.invitation.id);
    assert.strictEqual(wi.status, 'withdrawn');
    assert.ok(wi.responded_at);
    assert.strictEqual((await payloads(s.pid, 'appointment_withdrawn')).length, 1);
    assert.strictEqual((await payloads(s.pid, 'invitation_withdrawn')).length, 1);
    expectErr(await post(U.pm, `/sysbuild/appointments/${p1.body.appointment.id}/withdraw`), 409, 'SYSBUILD_STATE', '已撤回再撤回');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${p1.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '撤回后受邀人接受');
    // 拒绝
    const p2 = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mC });
    const d = await post(U.cand, `/sysbuild/my/invitations/${p2.body.invitation.id}/decline`);
    assert.strictEqual(d.status, 200, d.text);
    assert.strictEqual((await rowOf('sysbuild_appointments', p2.body.appointment.id)).status, 'rejected');
    assert.strictEqual((await rowOf('sysbuild_invitations', p2.body.invitation.id)).status, 'declined');
    assert.strictEqual((await rowOf('sysbuild_appointments', s.apt)).status, 'active', '拒绝不影响现任');
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_rejected'), [{ party_id: s.party, member_id: mC }]);
    assert.strictEqual((await rowOf('sysbuild_members', mC)).removed_at, null, '拒绝任职不移出成员');
    // 项目已终止：受邀人不能接受 / 拒绝
    const p3 = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mC });
    await setStatus(s.pid, 'terminated');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${p3.body.invitation.id}/accept`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止接受任职');
    expectErr(await post(U.pm, `/sysbuild/appointments/${p3.body.appointment.id}/withdraw`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止撤回');
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/end`, { reason: '结束' }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止结束');
    await setStatus(s.pid, 'active');
    // 结束
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/end`, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/end`, { reason: 'r'.repeat(501) }), 400, 'SYSBUILD_INVALID_INPUT', '501 字原因');
    expectErr(await post(U.own, `/sysbuild/appointments/${s.apt}/end`, { reason: '自己结束' }), 403, 'SYSBUILD_FORBIDDEN', '负责人不能自己结束');
    expectErr(await post(U.pm, `/sysbuild/appointments/${p3.body.appointment.id}/end`, { reason: '非现任' }), 409, 'SYSBUILD_STATE', '待接受的不能结束');
    const e = await post(U.pm, `/sysbuild/appointments/${s.apt}/end`, { reason: '  岗位调整  ' });
    assert.strictEqual(e.status, 200, e.text);
    const ended = await rowOf('sysbuild_appointments', s.apt);
    assert.strictEqual(ended.status, 'ended');
    assert.ok(ended.ended_at);
    assert.strictEqual(ended.end_reason, '岗位调整');
    assert.strictEqual((await rowOf('sysbuild_delegations', dA)).status, 'revoked', '基于它的现任授权 revoked');
    assert.strictEqual((await rowOf('sysbuild_delegations', dP)).status, 'withdrawn', '待定授权提议 withdrawn');
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_ended'), [{ party_id: s.party, member_id: s.mOwn, end_reason: '岗位调整' }]);
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/end`, { reason: '再结束' }), 409, 'SYSBUILD_STATE', '已结束再结束');
    expectErr(await post(U.out, `/sysbuild/appointments/${s.apt}/end`, { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/appointments/99999999/end', { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '不存在');
  });

  // ── 授权 ─────────────────────────────────────────────────────────────────────────────
  test('授权：发起与校验——负责人发起直接 pending_accept；PM 发起 pending_owner；只读负责人可授权；其他人 403；无现任负责人 / 已有待定提议 409；不能授给负责人本人、PM、未加入、已移出（无账号成员可以，C4b Q-D1）', async () => {
    const s = await scene();
    const url = `/sysbuild/parties/${s.party}/delegations`;
    const r = await post(U.own, url, { member_id: s.mDel });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.delegation, { id: r.body.delegation.id, party_id: s.party, member_id: s.mDel, appointment_id: s.apt, status: 'pending_accept' });
    const row = await rowOf('sysbuild_delegations', r.body.delegation.id);
    assert.deepStrictEqual([row.party_id, row.member_id, row.appointment_id, row.status, row.proposed_by, row.effective_at], [s.party, s.mDel, s.apt, 'pending_accept', U.own, null]);
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_proposed'), [{ party_id: s.party, member_id: s.mDel, appointment_id: s.apt, initial_status: 'pending_accept' }]);
    expectErr(await post(U.own, url, { member_id: s.mDel }), 409, 'SYSBUILD_STATE', '已有待定提议');
    expectErr(await post(U.pm, url, { member_id: s.mDel }), 409, 'SYSBUILD_STATE', 'PM 也不能在已有待定提议时再发');
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${row.id}/withdraw`)).status, 200);
    // PM 发起 → pending_owner
    const pr = await post(U.pm, url, { member_id: s.mDel });
    assert.strictEqual(pr.status, 201, pr.text);
    assert.strictEqual(pr.body.delegation.status, 'pending_owner');
    assert.strictEqual((await rowOf('sysbuild_delegations', pr.body.delegation.id)).proposed_by, U.pm);
    assert.strictEqual((await payloads(s.pid, 'delegation_proposed')).pop().initial_status, 'pending_owner');
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${pr.body.delegation.id}/withdraw`)).status, 200);
    // 其他人 403 / 404
    expectErr(await post(U.m1, url, { member_id: s.mDel }), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.del, url, { member_id: s.mDel }), 403, 'SYSBUILD_FORBIDDEN', '代表人本人');
    expectErr(await post(U.admin, url, { member_id: s.mDel }), 403, 'SYSBUILD_FORBIDDEN', 'D4：admin 未接管不能代 PM 发起授权');
    expectErr(await post(U.out, url, { member_id: s.mDel }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/parties/99999999/delegations', { member_id: s.mDel }), 404, 'SYSBUILD_NOT_FOUND', '参与方不存在');
    // 候选人校验（都由 PM 发起，选中的人各有一种不合格）
    const mPend = await addMember(s.pid, U.x1, { party: s.party, pending: true });
    const mGone = await addMember(s.pid, U.x2, { party: s.party, removed: true });
    const mNoAcc = (await sqlRun("INSERT INTO sysbuild_members (project_id, party_id, person_name, joined_at, added_by) VALUES (?, ?, '无账号人', '2026-10-01 10:00:00', ?)", [s.pid, s.party, U.admin])).lastID;
    expectErr(await post(U.own, url, { member_id: s.mOwn }), 409, 'SYSBUILD_STATE', '授给负责人本人');
    expectErr(await post(U.pm, url, { member_id: mPend }), 409, 'SYSBUILD_STATE', '未加入成员');
    expectErr(await post(U.pm, url, { member_id: mGone }), 409, 'SYSBUILD_STATE', '已移出成员');
    expectErr(await post(U.pm, url, { member_id: s.mM1 }), 400, 'SYSBUILD_INVALID_INPUT', '成员不属于该参与方');
    expectErr(await post(U.pm, url, { member_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '成员不存在');
    expectErr(await post(U.pm, url, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺 member_id');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_delegations WHERE party_id = ? AND status IN ('pending_owner', 'pending_accept')", [s.party]), 0, '被拒绝的发起不留行');
    // C4b Q-D1（用户 2026-11-04 确认）：无账号成员可以被授权为代表人（原 C2 守卫「无账号成员不能被授权为代表人」已去）；PM 发起 → 待负责人确认，之后批准 / 接受只能代录。
    const naRes = await post(U.pm, url, { member_id: mNoAcc });
    assert.strictEqual(naRes.status, 201, naRes.text);
    assert.deepStrictEqual(naRes.body.delegation, { id: naRes.body.delegation.id, party_id: s.party, member_id: mNoAcc, appointment_id: s.apt, status: 'pending_owner' });
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${naRes.body.delegation.id}/withdraw`)).status, 200, '撤回无账号成员的授权提议后本方不再有待定提议');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_delegations WHERE party_id = ? AND status IN ('pending_owner', 'pending_accept')", [s.party]), 0);
    // L3：不能再授权给当前生效代表人（否则接受时会把他自己的生效授权标成「代表人更换」）
    const dActL3 = await addDelegation(s.party, s.mDel, s.apt, 'active');
    expectErr(await post(U.own, url, { member_id: s.mDel }), 409, 'SYSBUILD_STATE', 'L3：已是本方生效代表人');
    expectErr(await post(U.pm, url, { member_id: s.mDel }), 409, 'SYSBUILD_STATE', 'L3：PM 发起同样挡住');
    assert.strictEqual((await rowOf('sysbuild_delegations', dActL3)).status, 'active');
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_delegations WHERE party_id = ? AND status IN ('pending_owner', 'pending_accept')", [s.party]), 0);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-06 10:00:00', revoke_reason = '构造' WHERE id = ?", [dActL3]);
    // PM 不得兼任代表人（极端数据：成员行属参与方的用户恰是本项目 PM）
    const pid2 = await mkProject(U.pm);
    const party2 = await addParty(pid2, '乙部');
    const mO2 = await addMember(pid2, U.own, { party: party2 });
    await addAppointment(party2, mO2, 'active');
    const mAsPm = await addMember(pid2, U.cand, { party: party2 });
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.cand, pid2]);
    expectErr(await post(U.cand, `/sysbuild/parties/${party2}/delegations`, { member_id: mAsPm }), 409, 'SYSBUILD_STATE', 'PM 不得兼任代表人');
    // 没有现任负责人
    const pid3 = await mkProject(U.pm);
    const party3 = await addParty(pid3, '丙部');
    const m3 = await addMember(pid3, U.cand, { party: party3 });
    expectErr(await post(U.pm, `/sysbuild/parties/${party3}/delegations`, { member_id: m3 }), 409, 'SYSBUILD_STATE', '没有现任负责人');
    // 只读负责人可以授权（§5.1）
    const pid4 = await mkProject(U.pm);
    const party4 = await addParty(pid4, '丁部');
    const mRo = await addMember(pid4, U.ro, { party: party4 });
    await addAppointment(party4, mRo, 'active');
    const m4 = await addMember(pid4, U.cand, { party: party4 });
    const ro = await post(U.ro, `/sysbuild/parties/${party4}/delegations`, { member_id: m4 });
    assert.strictEqual(ro.status, 201, `只读负责人可授权: ${ro.text}`);
    assert.strictEqual(ro.body.delegation.status, 'pending_accept');
    // 项目状态
    await setStatus(pid4, 'terminated');
    expectErr(await post(U.pm, `/sysbuild/parties/${party4}/delegations`, { member_id: m4 }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
  });

  test('授权：确认、接受与更换——PM 发起 → 负责人 approve → 被授权人 accept 生效并撤原代表人；reject / decline；非被授权人 accept 404；负责人更换后旧提议接受 409；依据失效的提议接受 409 并撤回', async () => {
    const s = await scene();
    const mX = await addMember(s.pid, U.x1, { party: s.party });
    const dOld = await addDelegation(s.party, mX, s.apt, 'active');
    const url = `/sysbuild/parties/${s.party}/delegations`;
    const pr = await post(U.pm, url, { member_id: s.mDel });
    const did = pr.body.delegation.id;
    expectErr(await post(U.del, `/sysbuild/delegations/${did}/accept`), 409, 'SYSBUILD_STATE', '负责人未确认前不能接受');
    expectErr(await post(U.pm, `/sysbuild/delegations/${did}/approve`), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能确认');
    expectErr(await post(U.m1, `/sysbuild/delegations/${did}/approve`), 403, 'SYSBUILD_FORBIDDEN', '一般成员不能确认');
    expectErr(await post(U.del, `/sysbuild/delegations/${did}/approve`), 403, 'SYSBUILD_FORBIDDEN', '被授权人不能自己确认');
    expectErr(await post(U.out, `/sysbuild/delegations/${did}/approve`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    const ap = await post(U.own, `/sysbuild/delegations/${did}/approve`);
    assert.strictEqual(ap.status, 200, ap.text);
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'pending_accept');
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_approved'), [{ party_id: s.party, member_id: s.mDel }]);
    expectErr(await post(U.own, `/sysbuild/delegations/${did}/approve`), 409, 'SYSBUILD_STATE', '重复确认');
    expectErr(await post(U.own, `/sysbuild/delegations/${did}/reject`), 409, 'SYSBUILD_STATE', '已确认后不能再拒绝（reject 只对 pending_owner）');
    // 非被授权人 accept：404（接受类例外，与不存在同响应）
    const nf = await post(U.own, `/sysbuild/delegations/${did}/accept`);
    expectErr(nf, 404, 'SYSBUILD_NOT_FOUND', '负责人不是被授权人');
    expectErr(await post(U.pm, `/sysbuild/delegations/${did}/accept`), 404, 'SYSBUILD_NOT_FOUND', 'PM 不是被授权人');
    expectErr(await post(U.m1, `/sysbuild/delegations/${did}/decline`), 404, 'SYSBUILD_NOT_FOUND', '别的成员');
    expectErr(await post(U.del, '/sysbuild/delegations/99999999/accept'), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    assert.deepStrictEqual(nf.body, (await post(U.del, '/sysbuild/delegations/99999999/accept')).body, '与不存在的授权同一响应体');
    // 被授权人接受：生效，原生效授权 revoked（代表人更换）
    const acc = await post(U.del, `/sysbuild/delegations/${did}/accept`);
    assert.strictEqual(acc.status, 200, acc.text);
    assert.deepStrictEqual(acc.body, { delegation: { id: did, status: 'active' }, project_id: s.pid });
    const nd = await rowOf('sysbuild_delegations', did);
    assert.strictEqual(nd.status, 'active');
    assert.ok(nd.effective_at);
    const od = await rowOf('sysbuild_delegations', dOld);
    assert.strictEqual(od.status, 'revoked');
    assert.strictEqual(od.revoke_reason, '代表人更换');
    assert.ok(od.revoked_at);
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_revoked'), [{ party_id: s.party, member_id: mX, reason: '代表人更换' }]);
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_activated'), [{ party_id: s.party, member_id: s.mDel, appointment_id: s.apt, replaced: [dOld] }]);
    const view = await api(U.del, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(view.body.me.delegate_of_parties, [s.party]);
    assert.strictEqual(view.body.parties[0].delegate.member_id, s.mDel);
    expectErr(await post(U.del, `/sysbuild/delegations/${did}/accept`), 409, 'SYSBUILD_STATE', '重复接受');
    // reject（负责人拒绝 PM 的提议）与 decline（被授权人拒绝）
    const pr2 = await post(U.pm, url, { member_id: mX });
    assert.strictEqual(pr2.status, 201, pr2.text);
    const rj = await post(U.own, `/sysbuild/delegations/${pr2.body.delegation.id}/reject`);
    assert.strictEqual(rj.status, 200, rj.text);
    assert.strictEqual((await rowOf('sysbuild_delegations', pr2.body.delegation.id)).status, 'rejected');
    assert.deepStrictEqual((await payloads(s.pid, 'delegation_rejected')).pop(), { party_id: s.party, member_id: mX, by: 'owner' });
    const pr3 = await post(U.own, url, { member_id: mX });
    const dc = await post(U.x1, `/sysbuild/delegations/${pr3.body.delegation.id}/decline`);
    assert.strictEqual(dc.status, 200, dc.text);
    assert.strictEqual((await rowOf('sysbuild_delegations', pr3.body.delegation.id)).status, 'rejected');
    assert.deepStrictEqual((await payloads(s.pid, 'delegation_rejected')).pop(), { party_id: s.party, member_id: mX, by: 'delegate' });
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'active', '拒绝不影响现任代表人');
  });

  test('授权：负责人更换后旧提议不能接受；依据的任职已变化 / 被授权人已是 PM 的提议接受 409 并被撤回；已终止项目接受 409 提议保持；只读被授权人可接受', async () => {
    const s = await scene();
    const mC = await addMember(s.pid, U.cand, { party: s.party });
    const url = `/sysbuild/parties/${s.party}/delegations`;
    const pr = await post(U.own, url, { member_id: s.mDel });
    assert.strictEqual(pr.body.delegation.status, 'pending_accept');
    // 负责人更换（PM 提议 + 新负责人接受）
    const ap = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mC });
    assert.strictEqual((await post(U.cand, `/sysbuild/my/invitations/${ap.body.invitation.id}/accept`)).status, 200);
    expectErr(await post(U.del, `/sysbuild/delegations/${pr.body.delegation.id}/accept`), 409, 'SYSBUILD_STATE', '负责人更换后旧提议');
    assert.strictEqual((await rowOf('sysbuild_delegations', pr.body.delegation.id)).status, 'withdrawn');
    assert.strictEqual((await rowOf('sysbuild_delegations', pr.body.delegation.id)).effective_at, null);
    // 依据失效（直接写库造：提议依据一条已结束的任职，现任是另一条）
    const ended = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at, ended_at, end_reason) VALUES (?, ?, 'ended', ?, '2026-10-02 10:00:00', '2026-10-03 10:00:00', '卸任')", [s.party, s.mOwn, U.admin])).lastID;
    const stale = await addDelegation(s.party, s.mDel, ended, 'pending_accept');
    const r1 = await post(U.del, `/sysbuild/delegations/${stale}/accept`);
    expectErr(r1, 409, 'SYSBUILD_STATE', '依据的任职不是现任');
    assert.strictEqual((await rowOf('sysbuild_delegations', stale)).status, 'withdrawn', '依据失效的提议被置为已撤回（同一事务提交）');
    const sev = (await payloads(s.pid, 'delegation_withdrawn')).filter((p) => p.stale === true);
    assert.strictEqual(sev.length, 1);
    assert.strictEqual(sev[0].member_id, s.mDel);
    // 被授权人已是 PM（极端数据）
    const pid2 = await mkProject(U.pm);
    const party2 = await addParty(pid2, '乙部');
    const mO = await addMember(pid2, U.own, { party: party2 });
    const apt2 = await addAppointment(party2, mO, 'active');
    const mP = await addMember(pid2, U.cand2, { party: party2 });
    const d2 = await addDelegation(party2, mP, apt2, 'pending_accept');
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.cand2, pid2]);
    expectErr(await post(U.cand2, `/sysbuild/delegations/${d2}/accept`), 409, 'SYSBUILD_STATE', '被授权人已是 PM');
    assert.strictEqual((await rowOf('sysbuild_delegations', d2)).status, 'withdrawn');
    // L1 / C9：被授权人的成员行已移出（造数据：正常移出会撤回其提议，这里直接写库留下一条 pending_accept）
    const pid7 = await mkProject(U.pm);
    const party7 = await addParty(pid7, '戊部');
    const mO7 = await addMember(pid7, U.own, { party: party7 });
    const apt7 = await addAppointment(party7, mO7, 'active');
    const mGone7 = await addMember(pid7, U.x1, { party: party7, removed: true });
    const d7 = await addDelegation(party7, mGone7, apt7, 'pending_accept');
    expectErr(await post(U.x1, `/sysbuild/delegations/${d7}/accept`), 409, 'SYSBUILD_STATE', 'C9：被授权人已被移出');
    assert.strictEqual((await rowOf('sysbuild_delegations', d7)).status, 'withdrawn');
    // 已终止：409 READONLY，提议保持
    const s3 = await scene();
    const pr3 = await post(U.own, `/sysbuild/parties/${s3.party}/delegations`, { member_id: s3.mDel });
    await setStatus(s3.pid, 'terminated');
    expectErr(await post(U.del, `/sysbuild/delegations/${pr3.body.delegation.id}/accept`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止接受');
    expectErr(await post(U.del, `/sysbuild/delegations/${pr3.body.delegation.id}/decline`), 409, 'SYSBUILD_PROJECT_READONLY', '已终止拒绝');
    assert.strictEqual((await rowOf('sysbuild_delegations', pr3.body.delegation.id)).status, 'pending_accept');
    await setStatus(s3.pid, 'closed');
    assert.strictEqual((await post(U.del, `/sysbuild/delegations/${pr3.body.delegation.id}/accept`)).status, 200, '已结项可接受（D3）');
    // 只读被授权人可接受 / 拒绝（§5.1 本人确认类）
    const s4 = await scene();
    const mRo = await addMember(s4.pid, U.ro, { party: s4.party });
    const pr4 = await post(U.own, `/sysbuild/parties/${s4.party}/delegations`, { member_id: mRo });
    assert.strictEqual(pr4.status, 201, pr4.text);
    const lst = await api(U.ro, 'GET', '/sysbuild/my/invitations');
    const mine = lst.body.delegations.find((d) => d.id === pr4.body.delegation.id);
    assert.ok(mine, '待接受的授权出现在本人列表里');
    assert.deepStrictEqual(KEYS(mine), ['actions', 'id', 'permission_note', 'project', 'proposed_at', 'proposed_by_name', 'role', 'status']);
    assert.deepStrictEqual(mine.actions, { accept: true, decline: true });
    assert.deepStrictEqual(mine.role.type, 'delegation');
    assert.ok(mine.permission_note.includes('代表人'));
    const ok = await post(U.ro, `/sysbuild/delegations/${pr4.body.delegation.id}/accept`);
    assert.strictEqual(ok.status, 200, `只读账号可接受授权: ${ok.text}`);
  });

  test('授权：撤销与撤回——负责人（含只读）撤销生效授权；PM 不能撤销生效授权 403；撤销需原因；发起人本人或 PM 可撤回待定提议，他人 403；对象状态不符 409', async () => {
    const s = await scene();
    const dA = await addDelegation(s.party, s.mDel, s.apt, 'active');
    expectErr(await post(U.pm, `/sysbuild/delegations/${dA}/revoke`, { reason: 'PM 想撤' }), 403, 'SYSBUILD_FORBIDDEN', 'PM 不能撤销生效授权');
    expectErr(await post(U.del, `/sysbuild/delegations/${dA}/revoke`, { reason: '自己撤' }), 403, 'SYSBUILD_FORBIDDEN', '代表人自己不能撤');
    expectErr(await post(U.m1, `/sysbuild/delegations/${dA}/revoke`, { reason: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await post(U.admin, `/sysbuild/delegations/${dA}/revoke`, { reason: 'x' }), 403, 'SYSBUILD_FORBIDDEN', 'admin');
    expectErr(await post(U.out, `/sysbuild/delegations/${dA}/revoke`, { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.own, `/sysbuild/delegations/${dA}/revoke`, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await post(U.own, `/sysbuild/delegations/${dA}/revoke`, { reason: 'r'.repeat(501) }), 400, 'SYSBUILD_INVALID_INPUT', '501 字');
    assert.strictEqual((await rowOf('sysbuild_delegations', dA)).status, 'active', '被拒绝的撤销不改状态');
    const rv = await post(U.own, `/sysbuild/delegations/${dA}/revoke`, { reason: '  代表人调岗  ' });
    assert.strictEqual(rv.status, 200, rv.text);
    const row = await rowOf('sysbuild_delegations', dA);
    assert.strictEqual(row.status, 'revoked');
    assert.ok(row.revoked_at);
    assert.strictEqual(row.revoke_reason, '代表人调岗');
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_revoked'), [{ party_id: s.party, member_id: s.mDel, reason: '代表人调岗' }]);
    expectErr(await post(U.own, `/sysbuild/delegations/${dA}/revoke`, { reason: '再撤' }), 409, 'SYSBUILD_STATE', '已撤销再撤销');
    // 只读负责人可以撤销
    const pid2 = await mkProject(U.pm);
    const party2 = await addParty(pid2, '乙部');
    const mRo = await addMember(pid2, U.ro, { party: party2 });
    const apt2 = await addAppointment(party2, mRo, 'active');
    const m2 = await addMember(pid2, U.cand, { party: party2 });
    const d2 = await addDelegation(party2, m2, apt2, 'active');
    const rr = await post(U.ro, `/sysbuild/delegations/${d2}/revoke`, { reason: '只读负责人撤销本方代表人' });
    assert.strictEqual(rr.status, 200, `只读负责人可撤销: ${rr.text}`);
    // 撤回
    const s2 = await scene();
    const u2 = `/sysbuild/parties/${s2.party}/delegations`;
    const byOwner = await post(U.own, u2, { member_id: s2.mDel });
    expectErr(await post(U.del, `/sysbuild/delegations/${byOwner.body.delegation.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', '被授权人不能撤回');
    expectErr(await post(U.m1, `/sysbuild/delegations/${byOwner.body.delegation.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', '一般成员不能撤回');
    const w1 = await post(U.pm, `/sysbuild/delegations/${byOwner.body.delegation.id}/withdraw`);
    assert.strictEqual(w1.status, 200, `PM 可撤回负责人发起的待定提议: ${w1.text}`);
    assert.strictEqual((await rowOf('sysbuild_delegations', byOwner.body.delegation.id)).status, 'withdrawn');
    expectErr(await post(U.pm, `/sysbuild/delegations/${byOwner.body.delegation.id}/withdraw`), 409, 'SYSBUILD_STATE', '已撤回再撤回');
    const byPm = await post(U.pm, u2, { member_id: s2.mDel });
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${byPm.body.delegation.id}/withdraw`)).status, 403, '负责人不是发起人，不能撤回 PM 的提议（可 reject）');
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${byPm.body.delegation.id}/withdraw`)).status, 200, '发起人 PM 可撤回');
    const byOwner2 = await post(U.own, u2, { member_id: s2.mDel });
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${byOwner2.body.delegation.id}/withdraw`)).status, 200, '发起人本人可撤回');
    assert.strictEqual((await payloads(s2.pid, 'delegation_withdrawn')).length, 3);
    const dAct = await addDelegation(s2.party, s2.mDel, s2.apt, 'active');
    expectErr(await post(U.pm, `/sysbuild/delegations/${dAct}/withdraw`), 409, 'SYSBUILD_STATE', '生效授权不能撤回');
    // L2：前 PM 发起的授权提议，换 PM 后他不能再撤回（详情里也看不到）；新 PM 可以
    const s4 = await scene();
    const l2 = await post(U.pm, `/sysbuild/parties/${s4.party}/delegations`, { member_id: s4.mDel });
    assert.strictEqual(l2.body.delegation.status, 'pending_owner');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s4.pid}/pm`, { pm_user_id: U.m1, reason: '换给 m1' })).status, 200);
    expectErr(await post(U.pm, `/sysbuild/delegations/${l2.body.delegation.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', 'L2：前 PM 不能再撤回自己发起的提议');
    assert.strictEqual((await rowOf('sysbuild_delegations', l2.body.delegation.id)).status, 'pending_owner');
    const l2d = await api(U.pm, 'GET', `/sysbuild/projects/${s4.pid}`);
    assert.ok(!l2d.body.delegations.some((x) => x.id === l2.body.delegation.id), '前 PM 在详情里看不到它——撤回也不该可行');
    assert.strictEqual((await post(U.m1, `/sysbuild/delegations/${l2.body.delegation.id}/withdraw`)).status, 200, '新 PM 可以撤回');
    // 只读负责人发起的提议，本人可撤回
    const pid3 = await mkProject(U.pm);
    const party3 = await addParty(pid3, '丙部');
    const mRo3 = await addMember(pid3, U.ro, { party: party3 });
    await addAppointment(party3, mRo3, 'active');
    const m3 = await addMember(pid3, U.cand, { party: party3 });
    const rp = await post(U.ro, `/sysbuild/parties/${party3}/delegations`, { member_id: m3 });
    assert.strictEqual((await post(U.ro, `/sysbuild/delegations/${rp.body.delegation.id}/withdraw`)).status, 200, '只读负责人可撤回自己发起的授权提议');
  });

  // ── 移出成员 ─────────────────────────────────────────────────────────────────────────
  test('移出成员：级联——现任任职 ended、基于它的授权 revoked / 待定 withdrawn、本人名下授权 revoked / 待定 withdrawn、待接受任职与邀请 withdrawn；各表终态与事件手写核对；PM 本人 409', async () => {
    const pid = await mkProject(U.pm);
    const P = await addParty(pid, '甲部');
    const Q = await addParty(pid, '乙部');
    const R = await addParty(pid, '丙部');
    const T = await addParty(pid, '丁部');
    const mX = await addMember(pid, U.cand, { party: P });
    const a1 = await addAppointment(P, mX, 'active');
    const mD1 = await addMember(pid, U.x1, { party: P });
    const mD2 = await addMember(pid, U.x2, { party: P });
    const d1 = await addDelegation(P, mD1, a1, 'active');
    const d2 = await addDelegation(P, mD2, a1, 'pending_accept');
    const mO2 = await addMember(pid, U.own, { party: Q });
    const a2 = await addAppointment(Q, mO2, 'active');
    const d3 = await addDelegation(Q, mX, a2, 'active');
    const mO3 = await addMember(pid, U.del, { party: R });
    const a3 = await addAppointment(R, mO3, 'active');
    const d4 = await addDelegation(R, mX, a3, 'pending_owner');
    const a4 = await addAppointment(T, mX, 'pending');
    const i1 = await addInvitation(pid, mX, 'appointment', 'pending', U.pm, a4);
    const bystander = await addMember(pid, U.m2, { party: Q });
    const dBy = await addDelegation(Q, bystander, a2, 'pending_accept');
    const url = `/sysbuild/members/${mX}/remove`;
    expectErr(await post(U.m1, url, { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员 m1（未加入）');
    expectErr(await post(U.own, url, { reason: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '负责人不能移出成员');
    expectErr(await post(U.pm, url, {}), 400, 'SYSBUILD_INVALID_INPUT', '缺原因');
    expectErr(await post(U.pm, url, { reason: 'r'.repeat(501) }), 400, 'SYSBUILD_INVALID_INPUT', '501 字');
    expectErr(await post(U.pm, '/sysbuild/members/99999999/remove', { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '不存在');
    assert.strictEqual((await rowOf('sysbuild_appointments', a1)).status, 'active', '被拒绝的移出不级联');
    const r = await post(U.pm, url, { reason: '  离职  ' });
    assert.strictEqual(r.status, 200, r.text);
    const m = await rowOf('sysbuild_members', mX);
    assert.ok(m.removed_at);
    assert.strictEqual(m.removed_reason, '离职');
    // 现任任职 ended
    const A1 = await rowOf('sysbuild_appointments', a1);
    assert.strictEqual(A1.status, 'ended');
    assert.ok(A1.ended_at);
    assert.strictEqual(A1.end_reason, '成员移出');
    // 基于它的授权：现任 revoked，待定 withdrawn
    const D1 = await rowOf('sysbuild_delegations', d1);
    assert.strictEqual(D1.status, 'revoked');
    assert.ok(D1.revoked_at);
    assert.ok(D1.revoke_reason && D1.revoke_reason.length > 0);
    assert.strictEqual((await rowOf('sysbuild_delegations', d2)).status, 'withdrawn');
    // 本人名下的授权：现任 revoked（成员移出），待定 withdrawn
    const D3 = await rowOf('sysbuild_delegations', d3);
    assert.strictEqual(D3.status, 'revoked');
    assert.strictEqual(D3.revoke_reason, '成员移出');
    assert.ok(D3.revoked_at);
    assert.strictEqual((await rowOf('sysbuild_delegations', d4)).status, 'withdrawn');
    // 待接受的任职与邀请
    assert.strictEqual((await rowOf('sysbuild_appointments', a4)).status, 'withdrawn');
    const I1 = await rowOf('sysbuild_invitations', i1);
    assert.strictEqual(I1.status, 'withdrawn');
    assert.ok(I1.responded_at);
    // 与该成员无关的对象不受影响
    assert.strictEqual((await rowOf('sysbuild_appointments', a2)).status, 'active');
    assert.strictEqual((await rowOf('sysbuild_appointments', a3)).status, 'active');
    assert.strictEqual((await rowOf('sysbuild_delegations', dBy)).status, 'pending_accept');
    // 事件：每个级联对象各一条
    assert.strictEqual((await eventsOf(pid, 'member_removed')).length, 1);
    assert.deepStrictEqual((await payloads(pid, 'member_removed'))[0], { user_id: U.cand, party_id: P, reason: '离职', was_pending: false });
    assert.deepStrictEqual((await eventsOf(pid, 'appointment_ended')).map((e) => e.object_id), [a1]);
    assert.deepStrictEqual((await eventsOf(pid, 'delegation_revoked')).map((e) => e.object_id).sort((a, b) => a - b), [d1, d3].sort((a, b) => a - b));
    assert.deepStrictEqual((await eventsOf(pid, 'delegation_withdrawn')).map((e) => e.object_id).sort((a, b) => a - b), [d2, d4].sort((a, b) => a - b));
    assert.deepStrictEqual((await eventsOf(pid, 'appointment_withdrawn')).map((e) => e.object_id), [a4]);
    assert.deepStrictEqual((await eventsOf(pid, 'invitation_withdrawn')).map((e) => e.object_id), [i1]);
    // 再移出 409；PM 本人 409；移出后项目详情 404
    expectErr(await post(U.pm, url, { reason: '再移出' }), 409, 'SYSBUILD_STATE', '已移出');
    const pmRow = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.pm])).id;
    expectErr(await post(U.pm, `/sysbuild/members/${pmRow}/remove`, { reason: '移出自己' }), 409, 'SYSBUILD_STATE', 'PM 本人（操作人就是 PM：被本人判定先挡）');
    // 操作人不是 PM（admin 未接管）：挡住它的是「PM 的成员行不能移出」这一条对象状态，而不是本人判定
    const pmRowErr = await post(U.admin, `/sysbuild/members/${pmRow}/remove`, { reason: 'admin 移出 PM 行' });
    expectErr(pmRowErr, 409, 'SYSBUILD_STATE', 'admin 移出 PM 的成员行');
    assert.ok(pmRowErr.body.message.includes('PM'), `原因应是 PM 行不能移出: ${pmRowErr.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_members', pmRow)).removed_at, null);
    expectErr(await api(U.cand, 'GET', `/sysbuild/projects/${pid}`), 404, 'SYSBUILD_NOT_FOUND', '移出后看不到项目');
    // 待接受成员：移出时撤回其待接受邀请
    const added = await post(U.pm, `/sysbuild/projects/${pid}/members`, { user_id: U.x3 });
    const rp = await post(U.pm, `/sysbuild/members/${added.body.member.id}/remove`, { reason: '邀请错人' });
    assert.strictEqual(rp.status, 200, rp.text);
    assert.strictEqual((await rowOf('sysbuild_invitations', added.body.invitation.id)).status, 'withdrawn');
    assert.strictEqual((await payloads(pid, 'member_removed')).pop().was_pending, true);
    expectErr(await post(U.x3, `/sysbuild/my/invitations/${added.body.invitation.id}/accept`), 409, 'SYSBUILD_STATE', '移出后接受');
    // fixC：admin（非只读）不必接管即可移出成员
    const byAdm = await post(U.admin, `/sysbuild/projects/${pid}/members`, { user_id: U.cand2 });
    assert.strictEqual(byAdm.status, 201, byAdm.text);
    const admRm = await post(U.admin, `/sysbuild/members/${byAdm.body.member.id}/remove`, { reason: 'admin 未接管移出' });
    assert.strictEqual(admRm.status, 200, `admin 未接管也可移出成员: ${admRm.text}`);
    assert.strictEqual((await rowOf('sysbuild_invitations', byAdm.body.invitation.id)).status, 'withdrawn');
    // 已终止：409；已结项允许
    const pid2 = await mkProject(U.pm);
    const m2 = await addMember(pid2, U.m1);
    await setStatus(pid2, 'terminated');
    expectErr(await post(U.pm, `/sysbuild/members/${m2}/remove`, { reason: 'x' }), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    await setStatus(pid2, 'closed');
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${m2}/remove`, { reason: 'x' })).status, 200, '已结项允许');
  });

  // ── 管理动作不得作用于本人（codex 16 号 M-1）────────────────────────────────────────
  test('管理动作不得作用于本人：admin 同时是目标成员 / 现任负责人 / 待接受任职人时，移出 / 结束 / 撤回都 409 且 actions 为假；另一个有权者（PM）可以执行', async () => {
    const pid = await mkProject(U.pm);
    const party = await addParty(pid, '甲部');
    const party2 = await addParty(pid, '乙部');
    const party3 = await addParty(pid, '丙部');
    // admin 自己：已加入的成员行 + 甲部现任负责人 + 乙部待接受任职人（同一个成员行名下）
    const mAdm = await addMember(pid, U.admin, { party });
    const apActive = await addAppointment(party, mAdm, 'active');
    const apPend = await addAppointment(party2, mAdm, 'pending');
    // 别人：对照——同样的对象别人名下，admin 可以操作
    const mOther = await addMember(pid, U.m1, { party: party3 });
    const apOtherActive = await addAppointment(party3, mOther, 'active');
    const mOther2 = await addMember(pid, U.m2, { party: party2 });
    const apOtherPend = await addAppointment(party2, mOther2, 'pending');
    const snap = async () => JSON.stringify([
      await sqlAll('SELECT id, removed_at FROM sysbuild_members WHERE project_id = ? ORDER BY id', [pid]),
      await sqlAll('SELECT a.id, a.status FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id WHERE p.project_id = ? ORDER BY a.id', [pid]),
    ]);
    // 详情里 admin 的 actions：本人名下全假，别人名下为真（读写同源）
    const d = await api(U.admin, 'GET', `/sysbuild/projects/${pid}`);
    assert.strictEqual(d.status, 200, d.text);
    const mem = (id) => d.body.members.find((x) => x.id === id);
    const apt = (id) => d.body.appointments.find((x) => x.id === id);
    assert.strictEqual(mem(mAdm).actions.remove, false, 'admin 不能移出自己');
    assert.strictEqual(mem(mOther).actions.remove, true, 'admin 可以移出别人');
    assert.strictEqual(apt(apActive).actions.end, false, 'admin 不能结束自己的现任');
    assert.strictEqual(apt(apOtherActive).actions.end, true, 'admin 可以结束别人的现任');
    assert.strictEqual(apt(apPend).actions.withdraw, false, 'admin 不能撤回提议自己任职的提议');
    assert.strictEqual(apt(apOtherPend).actions.withdraw, true, 'admin 可以撤回别人的任职提议');
    // 执行：409 STATE，状态不变
    const before = await snap();
    expectErr(await post(U.admin, `/sysbuild/members/${mAdm}/remove`, { reason: '自己移出自己' }), 409, 'SYSBUILD_STATE', '移出本人');
    expectErr(await post(U.admin, `/sysbuild/appointments/${apActive}/end`, { reason: '自己结束自己' }), 409, 'SYSBUILD_STATE', '结束本人任职');
    expectErr(await post(U.admin, `/sysbuild/appointments/${apPend}/withdraw`), 409, 'SYSBUILD_STATE', '撤回本人任职提议');
    assert.strictEqual(await snap(), before, '被拒绝的请求不改任何状态');
    // PM 视角：同一批对象的 actions 为真，且可以执行
    const pd = await api(U.pm, 'GET', `/sysbuild/projects/${pid}`);
    assert.strictEqual(pd.body.members.find((x) => x.id === mAdm).actions.remove, true);
    assert.strictEqual(pd.body.appointments.find((x) => x.id === apActive).actions.end, true);
    assert.strictEqual(pd.body.appointments.find((x) => x.id === apPend).actions.withdraw, true);
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${apPend}/withdraw`)).status, 200, 'PM 可撤回 admin 的待接受任职');
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${apActive}/end`, { reason: '换人' })).status, 200, 'PM 可结束 admin 的现任');
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${mAdm}/remove`, { reason: '移出 admin' })).status, 200, 'PM 可移出 admin 的成员行');
    // admin 对别人的同类动作可以
    assert.strictEqual((await post(U.admin, `/sysbuild/appointments/${apOtherPend}/withdraw`)).status, 200);
    assert.strictEqual((await post(U.admin, `/sysbuild/appointments/${apOtherActive}/end`, { reason: 'admin 结束' })).status, 200);
    assert.strictEqual((await post(U.admin, `/sysbuild/members/${mOther2}/remove`, { reason: 'admin 移出' })).status, 200);
    // PM 作为操作人同样受限：PM 的成员行本就不能移出（409），且不是任职人；PM 想把自己加为成员、任命自己同样 409（沿用 D2 用例，这里核对移出 PM 行的原因）
    const pmRow = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.pm])).id;
    expectErr(await post(U.pm, `/sysbuild/members/${pmRow}/remove`, { reason: '移出自己' }), 409, 'SYSBUILD_STATE', 'PM 移出自己');
    // 接管后的 admin（即 PM）也一样：admin 接管后移出自己的成员行（接管时新建的 PM 行）→ 409
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/pm`, { pm_user_id: U.admin, reason: '接管' })).status, 200);
    const admRow = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL', [pid, U.admin])).id;
    expectErr(await post(U.admin, `/sysbuild/members/${admRow}/remove`, { reason: '接管后移出自己' }), 409, 'SYSBUILD_STATE', '接管后的 admin 移出自己');
  });

  // ── 我的邀请列表（H1）────────────────────────────────────────────────────────────────
  test('我的邀请：列表只含指向本人的待处理邀请与待本人接受的授权——他人的、已处理的、本人名下待负责人确认的都不在；id 集合与手写期望全等（限本用例造的数据）', async () => {
    // 项目 A：本人（cand）是已加入成员，名下有 pending_accept 授权（应在）与 pending_owner 授权（不应在）；别人（del）名下另有 pending_accept（不应在）
    const s = await scene();
    const mCand = await addMember(s.pid, U.cand, { party: s.party });
    const dMine = await addDelegation(s.party, mCand, s.apt, 'pending_accept');
    const dOwnerPending = await addDelegation(s.party, mCand, s.apt, 'pending_owner');
    const dOther = await addDelegation(s.party, s.mDel, s.apt, 'pending_accept');
    // 项目 B：本人的 join 待处理（应在）；别人（x1）的 join 待处理（不应在）；本人已拒绝的（不应在）
    const pidB = await mkProject(U.pm);
    const partyB = await addParty(pidB, '乙部');
    const mMine = await addMember(pidB, U.cand, { party: partyB, pending: true });
    const iMine = await addInvitation(pidB, mMine, 'join', 'pending', U.pm);
    const mOther = await addMember(pidB, U.x1, { party: partyB, pending: true });
    const iOther = await addInvitation(pidB, mOther, 'join', 'pending', U.pm);
    const mDone = await addMember(pidB, U.cand, { party: partyB, removed: true });
    const iDone = await addInvitation(pidB, mDone, 'join', 'declined', U.pm);
    // 项目 C：本人已加入成员，任职类邀请待处理（应在）；别人（x2）的任职类邀请待处理（不应在）
    const pidC = await mkProject(U.pm);
    const partyC = await addParty(pidC, '丙部');
    const mApMine = await addMember(pidC, U.cand, { party: partyC });
    const apMine = await addAppointment(partyC, mApMine, 'pending');
    const iApMine = await addInvitation(pidC, mApMine, 'appointment', 'pending', U.pm, apMine);
    const mApOther = await addMember(pidC, U.x2, { party: partyC });
    const apOther = await addAppointment(partyC, mApOther, 'pending');
    const iApOther = await addInvitation(pidC, mApOther, 'appointment', 'pending', U.pm, apOther);
    const mine = await api(U.cand, 'GET', '/sysbuild/my/invitations');
    assert.strictEqual(mine.status, 200, mine.text);
    const scope = new Set([iMine, iOther, iDone, iApMine, iApOther]);
    assert.deepStrictEqual(mine.body.invitations.map((x) => x.id).filter((id) => scope.has(id)), [iMine, iApMine], '本人只看到自己的待处理邀请');
    const dscope = new Set([dMine, dOwnerPending, dOther]);
    assert.deepStrictEqual(mine.body.delegations.map((x) => x.id).filter((id) => dscope.has(id)), [dMine], '本人只看到待本人接受的授权：不含别人的、也不含待负责人确认的');
    assert.ok(mine.body.invitations.every((x) => x.status === 'pending') && mine.body.delegations.every((x) => x.status === 'pending_accept'));
    const other = await api(U.x1, 'GET', '/sysbuild/my/invitations');
    assert.deepStrictEqual(other.body.invitations.map((x) => x.id).filter((id) => scope.has(id)), [iOther], '别人只看到自己的');
    assert.deepStrictEqual(other.body.delegations.map((x) => x.id).filter((id) => dscope.has(id)), []);
    const del = await api(U.del, 'GET', '/sysbuild/my/invitations');
    assert.deepStrictEqual(del.body.delegations.map((x) => x.id).filter((id) => dscope.has(id)), [dOther]);
    const x2 = await api(U.x2, 'GET', '/sysbuild/my/invitations');
    assert.deepStrictEqual(x2.body.invitations.map((x) => x.id).filter((id) => scope.has(id)), [iApOther]);
    // 管理者自己不因为是 PM / admin 而看到别人的
    for (const uid of [U.pm, U.admin]) {
      const r = await api(uid, 'GET', '/sysbuild/my/invitations');
      assert.deepStrictEqual(r.body.invitations.map((x) => x.id).filter((id) => scope.has(id)), [], `${uid} 不是受邀人`);
      assert.deepStrictEqual(r.body.delegations.map((x) => x.id).filter((id) => dscope.has(id)), []);
    }
  });

  // ── 检查顺序 ─────────────────────────────────────────────────────────────────────────
  test('检查顺序（C2b）：参数 400 → 对象 404 → 可见性 404 → 权限 403 → 项目状态 409 → 对象状态 409；接受类例外——非本人邀请 404（先于项目状态），本人邀请但项目已终止 409', async () => {
    const s = await scene();
    await setStatus(s.pid, 'terminated');
    // 成员无权限 + 已终止 → 403（不是 409）；PM 有权限 + 已终止 → 409
    expectErr(await post(U.m1, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '无权限 + 终止');
    expectErr(await post(U.pm, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: 'x' }), 409, 'SYSBUILD_PROJECT_READONLY', '有权限 + 终止');
    expectErr(await post(U.out, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员 + 终止');
    expectErr(await post(U.m1, `/sysbuild/projects/${s.pid}/parties`, { side: 'zzz', name: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '参数非法先于权限');
    expectErr(await post(U.out, '/sysbuild/projects/99999999/members', { user_id: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '参数非法先于存在性');
    // 有权限 + 终止 + 对象状态也不符：先报项目状态
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/withdraw`), 409, 'SYSBUILD_PROJECT_READONLY', '终止先于对象状态');
    await setStatus(s.pid, 'active');
    expectErr(await post(U.pm, `/sysbuild/appointments/${s.apt}/withdraw`), 409, 'SYSBUILD_STATE', '项目正常时是对象状态');
    // 对象 404 先于可见性之外的一切：非成员对不存在的对象 → 404；无权限对不存在的对象 → 404
    expectErr(await post(U.out, '/sysbuild/members/99999999/remove', { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '不存在的成员');
    expectErr(await post(U.out, `/sysbuild/members/${s.mOwn}/remove`, { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '存在但看不到');
    expectErr(await post(U.m1, '/sysbuild/members/99999999/remove', { reason: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '成员对不存在的成员');
    // 接受类例外
    const added = await post(U.pm, `/sysbuild/projects/${s.pid}/members`, { user_id: U.cand });
    const iid = added.body.invitation.id;
    await setStatus(s.pid, 'terminated');
    const notMine = await post(U.cand2, `/sysbuild/my/invitations/${iid}/accept`);
    expectErr(notMine, 404, 'SYSBUILD_NOT_FOUND', '非本人邀请（项目已终止）');
    const none = await post(U.cand2, '/sysbuild/my/invitations/99999999/accept');
    assert.deepStrictEqual(notMine.body, none.body, '非本人邀请与不存在同响应');
    expectErr(await post(U.pm, `/sysbuild/my/invitations/${iid}/accept`), 404, 'SYSBUILD_NOT_FOUND', 'PM 也不是受邀人');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iid}/accept`), 409, 'SYSBUILD_PROJECT_READONLY', '本人邀请但项目已终止');
    expectErr(await post(U.cand, `/sysbuild/my/invitations/${iid}/decline`), 409, 'SYSBUILD_PROJECT_READONLY', '本人邀请但项目已终止（拒绝）');
    // 窄范围入口不走成员可见性：受邀人（非成员）在终止项目里也能读邀请
    assert.strictEqual((await api(U.cand, 'GET', `/sysbuild/my/invitations/${iid}`)).status, 200);
  });

  // ── 详情里的逐对象 actions 与可见范围 ─────────────────────────────────────────────────
  test('详情（C2b）：参与方 / 成员 / 任职 / 授权带逐对象 actions；普通成员看不到待接受 / 已移出成员名下的任职与授权；PM / admin 全部可见；本人相关的待处理对象对本人可见', async () => {
    const s = await scene();
    const mPend = await addMember(s.pid, U.x1, { party: s.party, pending: true });
    const apPend = await addAppointment(s.party, mPend, 'pending');
    const partyB = await addParty(s.pid, '乙部');
    const mGone = await addMember(s.pid, U.x2, { party: partyB, removed: true });
    const dGone = await addDelegation(partyB, mGone, s.apt, 'active');
    const mM2 = await addMember(s.pid, U.m2, { party: s.party });
    const dMine = await addDelegation(s.party, mM2, s.apt, 'pending_accept');
    const dAct = await addDelegation(s.party, s.mDel, s.apt, 'active');
    const apEnded = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at, ended_at, end_reason) VALUES (?, ?, 'ended', ?, '2026-10-02 10:00:00', '2026-10-03 10:00:00', '卸任')", [s.party, s.mOwn, U.admin])).lastID;
    // D3 放开历史（用户 2026-10-29 拍板）：已结束的任职与已撤销的授权对普通成员也可见（含已移出成员名下的）；rejected / withdrawn 的提议不可见
    const apEndedGone = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at, ended_at, end_reason) VALUES (?, ?, 'ended', ?, '2026-10-02 10:00:00', '2026-10-04 10:00:00', '成员移出')", [partyB, mGone, U.admin])).lastID;
    const apRej = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by) VALUES (?, ?, 'rejected', ?)", [s.party, s.mOwn, U.admin])).lastID;
    const apWd = (await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by) VALUES (?, ?, 'withdrawn', ?)", [s.party, s.mOwn, U.admin])).lastID;
    const dRevoked = (await sqlRun("INSERT INTO sysbuild_delegations (party_id, member_id, appointment_id, status, proposed_by, effective_at, revoked_at, revoke_reason) VALUES (?, ?, ?, 'revoked', ?, '2026-10-03 10:00:00', '2026-10-06 10:00:00', '代表人更换')", [s.party, mM2, s.apt, U.admin])).lastID;
    const dRevGone = (await sqlRun("INSERT INTO sysbuild_delegations (party_id, member_id, appointment_id, status, proposed_by, effective_at, revoked_at, revoke_reason) VALUES (?, ?, ?, 'revoked', ?, '2026-10-03 10:00:00', '2026-10-07 10:00:00', '成员移出')", [partyB, mGone, s.apt, U.admin])).lastID;
    const dRej = await addDelegation(s.party, mM2, s.apt, 'rejected');
    const dWd = await addDelegation(s.party, mM2, s.apt, 'withdrawn');
    // M4：已加入成员名下、不是本人的待接受任职；乙方（丙部）负责人名下的待处理授权——普通成员与别方负责人都不该看到
    const mJoinedAp = await addMember(s.pid, U.cand, { party: s.party });
    const apJ = await addAppointment(s.party, mJoinedAp, 'pending');
    const partyC = await addParty(s.pid, '丙部');
    const mC2 = await addMember(s.pid, U.cand2, { party: partyC });
    const apC = await addAppointment(partyC, mC2, 'active');
    const mC3 = await addMember(s.pid, U.x3, { party: partyC });
    const dCpo = await addDelegation(partyC, mC3, apC, 'pending_owner');
    const dCpa = await addDelegation(partyC, mC3, apC, 'pending_accept');
    const ids = (v, key) => v.body[key].map((x) => x.id);
    const pm = await api(U.pm, 'GET', `/sysbuild/projects/${s.pid}`);
    const admin = await api(U.admin, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(pm, 'appointments'), [s.apt, apPend, apEnded, apEndedGone, apRej, apWd, apJ, apC], 'PM 看全部任职（含待接受、已结束、已拒绝 / 已撤回）');
    assert.deepStrictEqual(ids(pm, 'delegations'), [dGone, dMine, dAct, dRevoked, dRevGone, dRej, dWd, dCpo, dCpa], 'PM 看全部授权');
    assert.deepStrictEqual(ids(admin, 'appointments'), ids(pm, 'appointments'));
    assert.deepStrictEqual(ids(admin, 'delegations'), ids(pm, 'delegations'));
    const m1 = await api(U.m1, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(m1, 'appointments'), [s.apt, apEnded, apEndedGone, apC], '普通成员见现任 + 已结束的任职（含已移出成员名下的）；看不到待接受的（含已加入成员名下的）、已拒绝 / 已撤回的');
    assert.deepStrictEqual(ids(m1, 'delegations'), [dAct, dRevoked, dRevGone], '普通成员见生效授权 + 已撤销的授权（含已移出成员名下的）；别方待处理的、已拒绝 / 已撤回的看不到');
    const ro = await api(U.ro, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(ro, 'appointments'), ids(m1, 'appointments'), '只读账号与普通成员同口径');
    assert.deepStrictEqual(ids(ro, 'delegations'), ids(m1, 'delegations'));
    // 历史项带人、时间、原因（手写）
    const ended = m1.body.appointments.find((x) => x.id === apEnded);
    assert.deepStrictEqual([ended.status, ended.ended_at, ended.end_reason], ['ended', '2026-10-03 10:00:00', '卸任']);
    assert.ok(typeof ended.name === 'string' && ended.name.length > 0);
    const endedGone = m1.body.appointments.find((x) => x.id === apEndedGone);
    assert.deepStrictEqual([endedGone.status, endedGone.ended_at, endedGone.end_reason], ['ended', '2026-10-04 10:00:00', '成员移出']);
    assert.ok(typeof endedGone.name === 'string' && endedGone.name.length > 0, '已移出成员名下的历史任职仍显示人名');
    assert.deepStrictEqual(KEYS(endedGone.actions), ['accept', 'decline', 'end', 'proxy_accept', 'withdraw']); // C4b：任职多一个 proxy_accept（无账号成员的任职接受代录）
    assert.ok(Object.values(endedGone.actions).every((v) => v === false), '历史项没有可用动作');
    const revoked = m1.body.delegations.find((x) => x.id === dRevoked);
    assert.deepStrictEqual([revoked.status, revoked.revoked_at, revoked.revoke_reason, revoked.effective_at], ['revoked', '2026-10-06 10:00:00', '代表人更换', '2026-10-03 10:00:00']);
    const revGone = m1.body.delegations.find((x) => x.id === dRevGone);
    assert.deepStrictEqual([revGone.status, revGone.revoke_reason], ['revoked', '成员移出']);
    assert.ok(typeof revGone.name === 'string' && revGone.name.length > 0);
    assert.ok(Object.values(revoked.actions).every((v) => v === false), '历史项没有可用动作');
    // 已移出成员本人在 members 列表里的口径不变：普通成员仍看不到已移出的成员行
    assert.ok(!m1.body.members.some((x) => x.id === mGone), '已移出成员不在普通成员的 members 里');
    const mine = await api(U.m2, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(mine, 'delegations'), [dMine, dAct, dRevoked, dRevGone], '本人待接受的授权对本人可见；本人名下已撤销的历史也只是历史（rejected / withdrawn 不显示）');
    const own = await api(U.own, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(own, 'delegations'), [dMine, dAct, dRevoked, dRevGone], '负责人看到本方待处理、生效与已撤销的授权（已移出成员名下的生效授权、别方的待处理看不到）');
    assert.deepStrictEqual(ids(own, 'appointments'), [s.apt, apEnded, apEndedGone, apC], '负责人也看不到别人的待接受任职');
    const ownC = await api(U.cand2, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(ownC, 'delegations'), [dAct, dRevoked, dRevGone, dCpo, dCpa], '丙部负责人看到本方的待处理授权，看不到甲部的');
    const mineAp = await api(U.cand, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.deepStrictEqual(ids(mineAp, 'appointments'), [s.apt, apEnded, apEndedGone, apJ, apC], '本人的待接受任职对本人可见');
    // actions 键集合
    for (const p of pm.body.parties) assert.deepStrictEqual(KEYS(p.actions), ['propose_appointment', 'propose_delegation', 'rename']);
    for (const x of pm.body.members) assert.deepStrictEqual(KEYS(x.actions), ['remove']);
    for (const a of pm.body.appointments) assert.deepStrictEqual(KEYS(a.actions), ['accept', 'decline', 'end', 'proxy_accept', 'withdraw']);
    for (const d of pm.body.delegations) assert.deepStrictEqual(KEYS(d.actions), ['accept', 'approve', 'decline', 'proxy', 'reject', 'revoke', 'withdraw']); // C4b：授权多一个 proxy（无账号一方的授权代录）
    for (const x of m1.body.members) assert.deepStrictEqual(KEYS(x.actions), ['remove'], '普通成员也带 actions 键');
    assert.ok(m1.body.members.every((x) => x.actions.remove === false));
    assert.ok(m1.body.parties.every((p) => p.actions.rename === false && p.actions.propose_appointment === false && p.actions.propose_delegation === false));
    // 项目级 actions 新键
    assert.strictEqual(pm.body.actions.add_member, true);
    assert.strictEqual(m1.body.actions.add_member, false);
    assert.strictEqual(admin.body.actions.add_member, true, 'fixC：admin（非只读）未接管也可加成员');
    assert.deepStrictEqual(m1.body.actions.party_sides, []);
    assert.deepStrictEqual(pm.body.actions.party_sides, ['demand', 'dev']);
    assert.deepStrictEqual(admin.body.actions.party_sides, ['demand', 'dev']);
    // admin 未接管：管理类逐对象标志为真，「以 PM 身份行事」的授权类（发起 / 撤回）为假
    assert.ok(admin.body.parties.every((p) => p.actions.rename === true && p.actions.propose_delegation === false));
    assert.ok(admin.body.delegations.every((d) => d.actions.withdraw === false), 'D4：admin 未接管不能撤回授权提议');
    assert.ok(admin.body.members.filter((x) => x.status !== 'removed' && x.user_id !== U.pm).every((x) => x.actions.remove === true), 'admin 可移出（非 PM 行的）未移出成员');
    // 列表里的项目级 actions 与详情一致
    const list = await api(U.pm, 'GET', '/sysbuild/projects?scope=mine');
    assert.deepStrictEqual(list.body.projects.find((p) => p.id === s.pid).actions, pm.body.actions);
  });

  test('admin 接管后（C2b）：admin（非只读）未接管也可管理参与方 / 成员 / 任职，但不能代 PM 发起 / 撤回授权（D4）；接管后可以，原 PM 则不再可以；只读 admin 一票否决', async () => {
    const s = await scene();
    const mC = await addMember(s.pid, U.cand, { party: s.party });
    // 未接管：管理类动作可以
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: '乙部' })).status, 201, '未接管建参与方');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/members`, { user_id: U.x1 })).status, 201, '未接管加成员');
    const ap = await post(U.admin, `/sysbuild/parties/${s.party}/appointments`, { member_id: mC });
    assert.strictEqual(ap.status, 201, `未接管提议任职: ${ap.text}`);
    assert.strictEqual((await post(U.admin, `/sysbuild/appointments/${ap.body.appointment.id}/withdraw`)).status, 200, '未接管撤回任职提议');
    assert.strictEqual((await post(U.admin, `/sysbuild/members/${s.mM1}/remove`, { reason: 'admin 移出' })).status, 200, '未接管移出成员');
    // 未接管：授权类的 PM 动作不行（D4）；PM 发起的提议 admin 也撤不了
    expectErr(await post(U.admin, `/sysbuild/parties/${s.party}/delegations`, { member_id: s.mDel }), 403, 'SYSBUILD_FORBIDDEN', '未接管不能代 PM 发起授权');
    const pr = await post(U.pm, `/sysbuild/parties/${s.party}/delegations`, { member_id: s.mDel });
    assert.strictEqual(pr.status, 201, pr.text);
    expectErr(await post(U.admin, `/sysbuild/delegations/${pr.body.delegation.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', 'D4：未接管不能撤回授权提议');
    assert.strictEqual((await rowOf('sysbuild_delegations', pr.body.delegation.id)).status, 'pending_owner');
    // 接管后：admin 即 PM，授权类也可以；原 PM 不再可以
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/pm`, { pm_user_id: U.admin, reason: '接管' })).status, 200);
    assert.strictEqual((await post(U.admin, `/sysbuild/delegations/${pr.body.delegation.id}/withdraw`)).status, 200, '接管后可撤回');
    const pr2 = await post(U.admin, `/sysbuild/parties/${s.party}/delegations`, { member_id: s.mDel });
    assert.strictEqual(pr2.status, 201, pr2.text);
    assert.strictEqual(pr2.body.delegation.status, 'pending_owner', '接管后发起授权 = 待负责人确认');
    expectErr(await post(U.pm, `/sysbuild/projects/${s.pid}/parties`, { side: 'demand', name: 'y' }), 403, 'SYSBUILD_FORBIDDEN', '原 PM 不再可以');
    expectErr(await post(U.pm, `/sysbuild/delegations/${pr2.body.delegation.id}/withdraw`), 403, 'SYSBUILD_FORBIDDEN', '原 PM 也不能撤回');
    const d = await api(U.admin, 'GET', `/sysbuild/projects/${s.pid}`);
    assert.strictEqual(d.body.actions.add_member, true);
    // 只读 admin：一票否决对 admin 同样生效（把只读账号临时改成 admin 角色）
    const roRole = (await sqlGet('SELECT role FROM users WHERE id = ?', [U.ro])).role;
    await T.setRole(U.ro, 'admin');
    try {
      const pid2 = await mkProject(U.pm);
      expectErr(await post(U.ro, `/sysbuild/projects/${pid2}/parties`, { side: 'demand', name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '只读 admin 建参与方');
      expectErr(await post(U.ro, `/sysbuild/projects/${pid2}/members`, { person_name: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '只读 admin 加成员');
      const dd = await api(U.ro, 'GET', `/sysbuild/projects/${pid2}`);
      assert.strictEqual(dd.status, 200);
      assert.strictEqual(dd.body.actions.add_member, false);
      assert.deepStrictEqual(dd.body.actions.party_sides, []);
    } finally {
      await T.setRole(U.ro, roRole);
    }
  });

  // ── rules：OBJECT_OPS 手写矩阵 ──────────────────────────────────────────────────────
  test('rules（C2b）：动作表登记全集与手写判定矩阵——PM / 只读一票否决 / 本人确认类例外 / 项目状态走 membership 行 / 对象状态 / 资格重核 stale', async () => {
    const R = T.getMods().rules;
    // C3a 起 OBJECT_OPS 另有批次 / 节点 / 排期十个动作（登记与类别在 sysbuild-api-suite-plan.js 的 OP_KIND 用例手写核对），这里只核 C2b 的十六个。
    const C3A_OPS = ['batch_update', 'node_add', 'node_cancel', 'node_close', 'node_rename', 'node_reopen', 'node_reorder', 'node_start', 'schedule_correct', 'schedule_plan'];
    // C3b 另加十个模块 / 条目 / 内容包动作（登记与类别在 sysbuild-api-suite-plan.js 的 OP_KIND 用例手写核对；C3b 围栏外的一处改动，见 C3b 报告「偏离」）。
    const C3B_OPS = ['module_create', 'module_rename', 'item_create', 'item_version_create', 'item_set_module', 'package_create', 'package_version_create', 'package_version_edit', 'package_item_add', 'package_item_remove'];
    const C4A_OPS = ['package_version_submit', 'package_version_withdraw', 'confirm_reissue', 'confirm_decide']; // C4a 新动作的判定矩阵在 sysbuild-api-suite-confirm.js 的 rules 用例
    const C4B_OPS = ['confirm_proxy', 'appointment_proxy_accept', 'delegation_proxy', 'history_window_open', 'history_window_close', 'history_window_reopen', 'history_confirmation_record', 'history_fact_import']; // C4b 代录三个新动作的判定矩阵在 sysbuild-api-suite-proxy.js 的 rules 用例；Q-S2 五个历史动作的矩阵在 sysbuild-api-suite-history.js
    // C5 S-S1a 另加十五个登记与办理动作（登记与类别在 sysbuild-api-suite-plan.js 的 OP_KIND 用例手写核对；判定矩阵在 sysbuild-api-suite-entries.js 的 rules 用例；本行是 C5 围栏外的一处改动，见 C5 报告）。
    const C5_OPS = ['entry_create_process', 'entry_create_supplement', 'entry_correct', 'entry_void', 'entry_conclude', 'entry_for_reference', 'entry_mark_commitment', 'entry_unmark_commitment',
      'entry_mark_risk', 'entry_unmark_risk', 'entry_escalate', 'notice_object', 'entry_conclusion_decide', 'entry_conclusion_proxy', 'entry_conclusion_reissue',
      'entry_split', 'entry_assign_items', 'entry_link_sys_issue', 'entry_object', // S-S1b 另加四个（拆分 / 待判定归属 / 记单号 / 提异议）；判定矩阵在 sysbuild-api-suite-routing.js 的 rules 用例
      'entry_link_change', 'entry_create_dev', 'change_create', 'change_new_version', // S-S1c 另加四个（挂靠变更 / 写开发方关键事项 / 建变更 / 变更出新版本）；判定矩阵在 sysbuild-api-suite-changes.js 与 sysbuild-api-suite-devkey.js 的 rules 用例
      'golive', 'revoke_golive', 'handover_request', // C6a 另加三个（确认试运行结束 / 撤销上线 / 发起交接确认）；判定矩阵在 sysbuild-api-suite-golive.js 的 rules 用例
      'schedule_notice_object']; // C6b 另加一个（对改期知会提异议）；判定在 sysbuild-api-suite-notify.js 的改期知会异议用例，类别在 sysbuild-api-suite-plan.js 的 OP_KIND 用例
    const C8_OPS = ['material_version_create']; // 材料维护类在OP_KIND全集与C8用例独立核对，不归C2身份动作。
    assert.deepStrictEqual(Object.keys(R.OBJECT_OPS).filter((k) => !C3A_OPS.includes(k) && !C3B_OPS.includes(k) && !C4A_OPS.includes(k) && !C4B_OPS.includes(k) && !C5_OPS.includes(k) && !C8_OPS.includes(k)).sort(), [
      'appointment_end', 'appointment_propose', 'appointment_withdraw', 'delegation_accept', 'delegation_approve', 'delegation_decline', 'delegation_propose',
      'delegation_reject', 'delegation_revoke', 'delegation_withdraw', 'invitation_accept', 'invitation_decline', 'member_add', 'member_remove', 'party_add', 'party_rename',
    ], '登记全集（手写）');
    const idn = (o) => Object.assign({ isPm: false, isAdmin: false, isReadonly: false, userId: 50, ownerOfParties: [], delegateOfParties: [] }, o);
    const prj = (st) => ({ id: 1, status: st, pm_user_id: 7 });
    const chk = (op, i, st, t) => R.checkOp(op, i, prj(st || 'active'), t || {});
    // PM 的管理类动作
    //   fixC：管理类动作 = 非只读且（PM 或 admin）；admin 不必接管；只读一票否决对 PM 与 admin 同样生效。
    const manageOps = [
      ['party_rename', {}], ['member_add', {}], ['party_add', { side: 'demand', hasDevParty: false }], ['member_remove', { removed: false, isPmRow: false }],
      ['appointment_propose', { hasPendingAppointment: false }], ['appointment_withdraw', { status: 'pending' }], ['appointment_end', { status: 'active' }],
    ];
    for (const [op, t] of manageOps) {
      assert.strictEqual(chk(op, idn({ isPm: true }), 'active', t), null, `${op} PM`);
      assert.strictEqual(chk(op, idn({ isAdmin: true }), 'active', t), null, `${op} admin 未接管也可`);
      assert.strictEqual(chk(op, idn({ isPm: true, isAdmin: true }), 'active', t), null, `${op} 接管后的 admin`);
      assert.strictEqual(chk(op, idn({ isPm: true, isReadonly: true }), 'active', t).status, 403, `${op} 只读 PM 一票否决`);
      assert.strictEqual(chk(op, idn({ isAdmin: true, isReadonly: true }), 'active', t).status, 403, `${op} 只读 admin 一票否决`);
      assert.strictEqual(chk(op, idn({}), 'active', t).status, 403, `${op} 一般成员`);
      assert.strictEqual(chk(op, idn({ ownerOfParties: [3] }), 'active', t).status, 403, `${op} 负责人`);
    }
    // M-1 / D2：管理动作不得作用于操作人本人（target.targetUserId = 操作人 → 409 STATE），对 PM 与 admin 同样；别人、无账号成员（空）不受限
    for (const [op, t] of [['member_remove', { removed: false, isPmRow: false }], ['appointment_withdraw', { status: 'pending' }], ['appointment_end', { status: 'active' }], ['member_add', {}], ['appointment_propose', { hasPendingAppointment: false }]]) {
      for (const who of [{ isAdmin: true }, { isPm: true }, { isAdmin: true, isPm: true }]) {
        const self = chk(op, idn(who), 'active', Object.assign({ targetUserId: 50 }, t));
        assert.deepStrictEqual([self.status, self.code], [409, 'SYSBUILD_STATE'], `${op} 作用于本人 ${JSON.stringify(who)}`);
        assert.strictEqual(chk(op, idn(who), 'active', Object.assign({ targetUserId: 51 }, t)), null, `${op} 作用于别人`);
        assert.strictEqual(chk(op, idn(who), 'active', Object.assign({ targetUserId: null }, t)), null, `${op} 无账号成员`);
      }
      assert.strictEqual(chk(op, idn({ isAdmin: true }), 'active', Object.assign({ targetUserId: 50 }, t)).message, '不能对自己执行该管理操作');
      assert.strictEqual(chk(op, idn({}), 'active', Object.assign({ targetUserId: 50 }, t)).status, 403, `${op}：没有权限先于本人判定`);
      assert.strictEqual(chk(op, idn({ isAdmin: true }), 'terminated', Object.assign({ targetUserId: 50 }, t)).code, 'SYSBUILD_PROJECT_READONLY', `${op}：项目状态先于本人判定`);
    }
    assert.throws(() => R.assertNotSelfTarget('member_add', idn({ isAdmin: true }), 50), (e) => e.status === 409 && e.code === 'SYSBUILD_STATE');
    assert.doesNotThrow(() => R.assertNotSelfTarget('member_add', idn({ isAdmin: true }), 51));
    assert.throws(() => R.assertNotSelfTarget('party_rename', idn({ isAdmin: true }), 50), (e) => e.status === 500, '未登记本人目标限制的动作不能用它');
    // 项目状态：membership 行 = 进行中 / 已暂停 / 已结项允许，已终止拒绝
    const states = [['active', true], ['paused', true], ['terminated', false], ['closed', true]];
    for (const [st, ok] of states) {
      const v = chk('party_rename', idn({ isPm: true }), st);
      if (ok) assert.strictEqual(v, null, `membership × ${st}`);
      else assert.deepStrictEqual([v.status, v.code], [409, 'SYSBUILD_PROJECT_READONLY'], `membership × ${st}`);
    }
    // 权限先于项目状态
    assert.strictEqual(chk('party_rename', idn({}), 'terminated').status, 403);
    // 开发方唯一
    assert.strictEqual(chk('party_add', idn({ isPm: true }), 'active', { side: 'dev', hasDevParty: false }), null);
    assert.deepStrictEqual([chk('party_add', idn({ isPm: true }), 'active', { side: 'dev', hasDevParty: true }).status, chk('party_add', idn({ isPm: true }), 'active', { side: 'dev', hasDevParty: true }).code], [409, 'SYSBUILD_STATE']);
    assert.strictEqual(chk('party_add', idn({ isPm: true }), 'active', { side: 'demand', hasDevParty: true }), null);
    // 成员移出：PM 行与已移出
    assert.strictEqual(chk('member_remove', idn({ isPm: true }), 'active', { removed: false, isPmRow: false }), null);
    assert.strictEqual(chk('member_remove', idn({ isPm: true }), 'active', { removed: false, isPmRow: true }).code, 'SYSBUILD_STATE');
    assert.strictEqual(chk('member_remove', idn({ isPm: true }), 'active', { removed: true, isPmRow: false }).code, 'SYSBUILD_STATE');
    // 授权：初始状态矩阵
    assert.strictEqual(R.delegationInitialStatus(idn({ ownerOfParties: [3] }), 3), 'pending_accept');
    assert.strictEqual(R.delegationInitialStatus(idn({ ownerOfParties: [3], isReadonly: true }), 3), 'pending_accept', '只读负责人也是');
    assert.strictEqual(R.delegationInitialStatus(idn({ ownerOfParties: [3] }), 4), null, '别方的负责人');
    assert.strictEqual(R.delegationInitialStatus(idn({ isPm: true }), 3), 'pending_owner');
    assert.strictEqual(R.delegationInitialStatus(idn({ isPm: true, isReadonly: true }), 3), null);
    assert.strictEqual(R.delegationInitialStatus(idn({ isAdmin: true }), 3), null, 'D4：admin 未接管不能代 PM 发起授权');
    assert.strictEqual(R.delegationInitialStatus(idn({ isAdmin: true, isPm: true }), 3), 'pending_owner', '接管后的 admin 即 PM');
    assert.strictEqual(R.canActAsPm(idn({ isPm: true })), true);
    assert.strictEqual(R.canActAsPm(idn({ isAdmin: true })), false);
    assert.strictEqual(R.canActAsPm(idn({ isPm: true, isReadonly: true })), false);
    const dp = (extra) => Object.assign({ party_id: 3, currentAppointmentId: 9, hasPendingDelegation: false }, extra);
    assert.strictEqual(chk('delegation_propose', idn({ ownerOfParties: [3], isReadonly: true }), 'active', dp()), null);
    assert.strictEqual(chk('delegation_propose', idn({ isPm: true }), 'active', dp({ currentAppointmentId: null })).code, 'SYSBUILD_STATE');
    assert.strictEqual(chk('delegation_propose', idn({ isPm: true }), 'active', dp({ hasPendingDelegation: true })).code, 'SYSBUILD_STATE');
    assert.strictEqual(chk('delegation_propose', idn({}), 'active', dp()).status, 403);
    // 授权撤销：仅本方负责人（含只读），PM 不行
    const dl = (extra) => Object.assign({ party_id: 3, status: 'active', proposed_by: 50, appointmentIsCurrent: true, userId: 60, requalReason: null, historyConflict: null }, extra); // C4b Q-S2：historyConflict 缺失 fail-closed，手写目标默认 null（无冲突）
    assert.strictEqual(chk('delegation_revoke', idn({ ownerOfParties: [3], isReadonly: true }), 'active', dl()), null);
    assert.strictEqual(chk('delegation_revoke', idn({ isPm: true }), 'active', dl()).status, 403, 'PM 不能撤销');
    assert.strictEqual(chk('delegation_revoke', idn({ ownerOfParties: [4] }), 'active', dl()).status, 403, '别方负责人');
    assert.strictEqual(chk('delegation_revoke', idn({ ownerOfParties: [3] }), 'active', dl({ status: 'revoked' })).code, 'SYSBUILD_STATE');
    // 确认 / 拒绝：负责人本人，pending_owner 且依据仍是现任
    assert.strictEqual(chk('delegation_approve', idn({ ownerOfParties: [3] }), 'active', dl({ status: 'pending_owner' })), null);
    assert.strictEqual(chk('delegation_approve', idn({ ownerOfParties: [3] }), 'active', dl({ status: 'pending_owner', appointmentIsCurrent: false })).code, 'SYSBUILD_STATE');
    assert.strictEqual(chk('delegation_approve', idn({ ownerOfParties: [3] }), 'active', dl({ status: 'pending_accept' })).code, 'SYSBUILD_STATE');
    assert.strictEqual(chk('delegation_reject', idn({ isPm: true }), 'active', dl({ status: 'pending_owner' })).status, 403);
    // 撤回（L2 / D4）：以 PM 身份行事的人；或发起人本人且仍是本方负责人（含只读负责人）。前 PM、admin 未接管都不行。
    const wd = (i, t) => chk('delegation_withdraw', i, 'active', dl(Object.assign({ status: 'pending_accept' }, t)));
    assert.strictEqual(wd(idn({ isPm: true })), null);
    assert.strictEqual(wd(idn({ isPm: true, isReadonly: true })).status, 403);
    assert.strictEqual(wd(idn({ userId: 50, ownerOfParties: [3] })), null, '发起人本人且仍是本方负责人');
    assert.strictEqual(wd(idn({ userId: 50 })).status, 403, 'L2：发起人本人但既不是 PM 也不是本方负责人（前 PM）');
    assert.strictEqual(wd(idn({ userId: 51, ownerOfParties: [3] })).status, 403, '本方负责人但不是发起人');
    assert.strictEqual(wd(idn({ userId: 50, ownerOfParties: [4] })).status, 403, '发起人是别方负责人');
    assert.strictEqual(wd(idn({ userId: 50, isReadonly: true })).status, 403, '只读发起人但已不是本方负责人');
    assert.strictEqual(wd(idn({ userId: 50, isReadonly: true, ownerOfParties: [3] })), null, '只读发起人仍是本方负责人');
    assert.strictEqual(wd(idn({ isAdmin: true, userId: 50 })).status, 403, 'D4：admin 未接管（即使记作发起人）不能撤回');
    assert.strictEqual(wd(idn({ isAdmin: true, isPm: true })), null, '接管后的 admin 即 PM');
    assert.strictEqual(wd(idn({ isPm: true }), { status: 'active' }).code, 'SYSBUILD_STATE');
    // 本人确认类：只读账号可以；项目状态走 membership；非本人 403；资格重核 stale
    const inv = (extra) => Object.assign({ status: 'pending', kind: 'join', userId: 50, requalReason: null, historyConflict: null }, extra); // C4b Q-S2：同上
    for (const op of ['invitation_accept', 'invitation_decline']) {
      assert.strictEqual(chk(op, idn({ isReadonly: true }), 'active', inv()), null, `${op} 只读账号可以`);
      assert.strictEqual(chk(op, idn({}), 'closed', inv()), null, `${op} 已结项可以（D3）`);
      assert.strictEqual(chk(op, idn({}), 'terminated', inv()).code, 'SYSBUILD_PROJECT_READONLY');
      assert.strictEqual(chk(op, idn({ userId: 51 }), 'active', inv()).status, 403, `${op} 非本人`);
      assert.strictEqual(chk(op, idn({ isPm: true, userId: 51 }), 'active', inv()).status, 403, `${op} PM 也不能代为接受`);
      assert.strictEqual(chk(op, idn({}), 'active', inv({ status: 'accepted' })).code, 'SYSBUILD_STATE');
    }
    // 接受重核 stale；拒绝不重核（M1 ①：邀请人失权后受邀人仍能明确回绝）
    const st = chk('invitation_accept', idn({}), 'active', inv({ requalReason: '邀请人已无权' }));
    assert.deepStrictEqual([st.status, st.code, st.stale], [409, 'SYSBUILD_STATE', true], 'invitation_accept stale');
    assert.strictEqual(chk('invitation_decline', idn({}), 'active', inv({ requalReason: '邀请人已无权' })), null, 'invitation_decline 不重核');
    // M2：待负责人确认（pending_owner）的授权，被授权人不能接受 / 拒绝（负责人未确认前不在被授权人手里）
    for (const op of ['delegation_accept', 'delegation_decline']) {
      const v = chk(op, idn({}), 'active', dl({ status: 'pending_owner', userId: 50 }));
      assert.deepStrictEqual([v.status, v.code], [409, 'SYSBUILD_STATE'], `${op} × pending_owner`);
      assert.strictEqual(chk(op, idn({}), 'active', dl({ status: 'pending_accept', userId: 50 })), null, `${op} × pending_accept`);
      for (const bad of ['active', 'rejected', 'revoked', 'withdrawn']) assert.strictEqual(chk(op, idn({}), 'active', dl({ status: bad, userId: 50 })).code, 'SYSBUILD_STATE', `${op} × ${bad}`);
    }
    // 授权接受：重核 stale；拒绝不重核
    assert.strictEqual(chk('delegation_accept', idn({}), 'active', dl({ status: 'pending_accept', userId: 50, requalReason: '依据已变' })).stale, true);
    assert.strictEqual(chk('delegation_decline', idn({}), 'active', dl({ status: 'pending_accept', userId: 50, requalReason: '依据已变' })), null);
    // 项目状态先于 stale
    assert.strictEqual(chk('invitation_accept', idn({}), 'terminated', inv({ requalReason: 'x' })).code, 'SYSBUILD_PROJECT_READONLY');
    // 未登记的动作抛 500
    assert.throws(() => R.checkOp('no_such_op', idn({}), prj('active'), {}), (e) => e.status === 500 && e.code === 'SYSBUILD_INTERNAL');
    assert.throws(() => R.checkOp('constructor', idn({}), prj('active'), {}), (e) => e.status === 500);
    // 事件类型登记（手写全集）
    const E = require('path').join(T.getModuleDir(), 'events.js');
    const types = require(E).EVENT_TYPES;
    for (const t of ['party_created', 'party_renamed', 'member_invited', 'member_added', 'member_joined', 'member_removed', 'invitation_accepted', 'invitation_declined', 'invitation_withdrawn',
      'appointment_proposed', 'appointment_activated', 'appointment_rejected', 'appointment_withdrawn', 'appointment_ended',
      'delegation_proposed', 'delegation_approved', 'delegation_rejected', 'delegation_activated', 'delegation_revoked', 'delegation_withdrawn']) {
      assert.ok(types.includes(t), `事件类型 ${t} 已登记`);
    }
  });

  // ── actions 与执行一致（逐对象）──────────────────────────────────────────────────────
  test('actions 与执行一致（C2b）：9 种身份 × 参与方 / 成员 / 任职 / 授权的全部逐对象 actions——标志为真 ⇔ 真实调用成功，为假 ⇔ 被拒（403 / 404 / 409）且状态不变；标志与手写期望一致', async () => {
    const build = async (status) => {
      const w = {};
      w.pid = await mkProject(U.pm);
      w.P = await addParty(w.pid, '甲部');
      w.Q = await addParty(w.pid, '乙部');
      w.S = await addParty(w.pid, '丙部');
      w.mOwn = await addMember(w.pid, U.own, { party: w.P });
      w.apP = await addAppointment(w.P, w.mOwn, 'active');
      w.mDel = await addMember(w.pid, U.del, { party: w.P });
      w.dlA = await addDelegation(w.P, w.mDel, w.apP, 'active');
      w.mM2 = await addMember(w.pid, U.m2, { party: w.P });
      w.dlPA = await addDelegation(w.P, w.mM2, w.apP, 'pending_accept');
      w.mM1 = await addMember(w.pid, U.m1);
      w.mRo = await addMember(w.pid, U.ro, { party: w.Q });
      w.apQ = await addAppointment(w.Q, w.mRo, 'active');
      w.mX1 = await addMember(w.pid, U.x1, { party: w.Q });
      w.dlPO = await addDelegation(w.Q, w.mX1, w.apQ, 'pending_owner');
      w.mX2 = await addMember(w.pid, U.x2, { party: w.Q });
      w.apQp = await addAppointment(w.Q, w.mX2, 'pending');
      w.invQ = await addInvitation(w.pid, w.mX2, 'appointment', 'pending', U.pm, w.apQp);
      w.mCand = await addMember(w.pid, U.cand, { party: w.S });
      w.apS = await addAppointment(w.S, w.mCand, 'active');
      w.mCand2 = await addMember(w.pid, U.cand2, { party: w.S });
      w.mPend = await addMember(w.pid, U.x3, { pending: true });
      w.invJ = await addInvitation(w.pid, w.mPend, 'join', 'pending', U.pm);
      w.mRem = await addMember(w.pid, U.out, { removed: true });
      // 种子授权的发起人统一记为 PM（夹具默认记 admin 编号：admin 会因「发起人本人」而能撤回，与本用例要验证的身份矩阵无关）。
      await sqlRun('UPDATE sysbuild_delegations SET proposed_by = ? WHERE party_id IN (?, ?, ?)', [U.pm, w.P, w.Q, w.S]);
      if (status && status !== 'active') await setStatus(w.pid, status);
      return w;
    };
    const IDENTITIES = [['pm', U.pm], ['own', U.own], ['del', U.del], ['m1', U.m1], ['ro', U.ro], ['admin', U.admin], ['x2', U.x2], ['m2', U.m2], ['cand', U.cand], ['x1', U.x1]];
    // 项目级标志（add_party / party_sides / add_member）也当作一类「对象」纳入一致性检查：详情里取出后挂成 projectObjs。
    const fetchDetail = async (uid, w) => {
      const d = await api(uid, 'GET', `/sysbuild/projects/${w.pid}`);
      assert.strictEqual(d.status, 200, `详情: ${d.text}`);
      const a = d.body.actions;
      d.body.projectObjs = [{ id: w.pid, actions: { add_party: a.add_party, add_member: a.add_member, party_side_demand: a.party_sides.includes('demand'), party_side_dev: a.party_sides.includes('dev') } }];
      return d;
    };
    // 对象 → 请求（候选人固定为各方里合格的一位，使「标志为真」时执行必能成功）
    const request = (w, kind, o, action) => {
      const cand = { [w.P]: w.mM2, [w.Q]: w.mX1, [w.S]: w.mCand2 };
      if (kind === 'projectObjs') {
        if (action === 'add_member') return ['POST', `/sysbuild/projects/${w.pid}/members`, { person_name: '新来的人' }];
        return ['POST', `/sysbuild/projects/${w.pid}/parties`, { side: action === 'party_side_dev' ? 'dev' : 'demand', name: '新参与方' }];
      }
      if (kind === 'parties') {
        if (action === 'rename') return ['PATCH', `/sysbuild/parties/${o.id}`, { name: '改名后' }];
        if (action === 'propose_appointment') return ['POST', `/sysbuild/parties/${o.id}/appointments`, { member_id: cand[o.id] }];
        return ['POST', `/sysbuild/parties/${o.id}/delegations`, { member_id: cand[o.id] }];
      }
      if (kind === 'members') return ['POST', `/sysbuild/members/${o.id}/remove`, { reason: '测试移出' }];
      // C4b 代录请求体：形态合格的四个凭据字段（附件编号不存在没关系——标志为假的请求在绑定附件之前就被 403 / 404 / 409 拒绝；本世界的成员都有平台账号，代录标志恒为假）
      const PROXY_BODY = { external_date: '2026-10-01', actual_confirmer: '测试确认人', identity_basis: '测试依据', attachment_ids: [99999999] };
      if (kind === 'appointments') {
        if (action === 'withdraw') return ['POST', `/sysbuild/appointments/${o.id}/withdraw`, {}];
        if (action === 'end') return ['POST', `/sysbuild/appointments/${o.id}/end`, { reason: '测试结束' }];
        if (action === 'proxy_accept') return ['POST', `/sysbuild/appointments/${o.id}/proxy-accept`, PROXY_BODY];
        return ['POST', `/sysbuild/my/invitations/${o.invitation_id || (o.id === w.apQp ? w.invQ : 99999999)}/${action}`, {}];
      }
      if (action === 'proxy') return ['POST', `/sysbuild/delegations/${o.id}/proxy`, { ...PROXY_BODY, expected_step: o.status === 'pending_accept' ? 'accept' : 'grant' }];
      return ['POST', `/sysbuild/delegations/${o.id}/${action}`, action === 'revoke' ? { reason: '测试撤销' } : {}];
    };
    const KINDS = ['parties', 'members', 'appointments', 'delegations', 'projectObjs'];
    const snapshot = async (w) => JSON.stringify([
      await sqlAll('SELECT id, removed_at FROM sysbuild_members WHERE project_id = ? ORDER BY id', [w.pid]),
      await sqlAll('SELECT id, name FROM sysbuild_parties WHERE project_id = ? ORDER BY id', [w.pid]),
      await sqlAll('SELECT a.id, a.status FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id WHERE p.project_id = ? ORDER BY a.id', [w.pid]),
      await sqlAll('SELECT d.id, d.status FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id WHERE p.project_id = ? ORDER BY d.id', [w.pid]),
      await sqlAll('SELECT id, status FROM sysbuild_invitations WHERE project_id = ? ORDER BY id', [w.pid]),
    ]);
    // 在指定项目状态下，对给定身份跑一遍「标志 ⇔ 执行」；返回 { trueSet, trueRuns, falseRuns, rejectCodes }。
    const runMatrix = async (status, identities) => {
      const trueSet = {};
      const rejectCodes = {};
      let trueRuns = 0;
      let falseRuns = 0;
      for (const [label, uid] of identities) {
        const w0 = await build(status);
        const d0 = await fetchDetail(uid, w0);
        trueSet[label] = [];
        for (const kind of KINDS) {
          for (let i = 0; i < d0.body[kind].length; i += 1) {
            const obj0 = d0.body[kind][i];
            for (const action of Object.keys(obj0.actions)) {
              const flag = obj0.actions[action];
              const tag = `${status}/${label} ${kind}[${i}]#${obj0.id}.${action}`;
              if (flag) {
                trueSet[label].push(`${kind}.${action}`);
                // 为真：在一个结构相同的新世界里执行，必须成功（先在新世界里重取详情，确认同一位置的标志仍为真）
                const w = await build(status);
                const d = await fetchDetail(uid, w);
                const obj = d.body[kind][i];
                assert.strictEqual(obj.actions[action], true, `${tag} 新世界里同位置标志应为真`);
                const [method, urlPath, body] = request(w, kind, obj, action);
                const r = await api(uid, method, urlPath, body);
                assert.ok(r.status === 200 || r.status === 201, `${tag} 标志为真但执行失败: ${r.status} ${String(r.text).slice(0, 160)}`);
                trueRuns += 1;
              } else {
                // 为假：在共享世界里执行，必须被拒绝且状态不变
                const [method, urlPath, body] = request(w0, kind, obj0, action);
                const before = await snapshot(w0);
                const r = await api(uid, method, urlPath, body);
                assert.ok([403, 404, 409].includes(r.status), `${tag} 标志为假但执行结果是 ${r.status} ${String(r.text).slice(0, 160)}`);
                assert.strictEqual(await snapshot(w0), before, `${tag} 被拒绝的请求不得改变任何状态`);
                rejectCodes[`${label} ${kind}.${action}${obj0.invitation_id ? '#inv' : ''}`] = r.body && r.body.code;
                falseRuns += 1;
              }
            }
          }
        }
      }
      return { trueSet, trueRuns, falseRuns, rejectCodes };
    };
    const uniq = (a) => Array.from(new Set(a)).sort();
    // ── 进行中 ──
    const act = await runMatrix('active', IDENTITIES);
    const trueSet = act.trueSet;
    assert.ok(act.trueRuns >= 40 && act.falseRuns >= 300, `覆盖面不应缩水：为真 ${act.trueRuns} 次，为假 ${act.falseRuns} 次`);
    // 手写期望（逐身份）：为真的动作集合
    const PROJECT_ALL = ['projectObjs.add_member', 'projectObjs.add_party', 'projectObjs.party_side_demand', 'projectObjs.party_side_dev'];
    assert.deepStrictEqual(uniq(trueSet.pm), uniq([
      'appointments.end', 'appointments.withdraw', 'delegations.withdraw', 'members.remove', 'parties.propose_appointment', 'parties.propose_delegation', 'parties.rename', ...PROJECT_ALL,
    ]), 'PM 为真的动作');
    assert.deepStrictEqual(uniq(trueSet.admin), uniq([
      'appointments.end', 'appointments.withdraw', 'members.remove', 'parties.propose_appointment', 'parties.rename', ...PROJECT_ALL,
    ]), 'admin（未接管）：管理类可以，授权类（发起 / 撤回）不行（fixC / D4）');
    assert.deepStrictEqual(uniq(trueSet.own), ['delegations.revoke'], '负责人：撤销本方生效授权（本方已有待定提议，不能再发起）');
    assert.deepStrictEqual(uniq(trueSet.ro), ['delegations.approve', 'delegations.reject'], '只读负责人：确认 / 拒绝本方待负责人确认的授权');
    assert.deepStrictEqual(uniq(trueSet.cand), ['parties.propose_delegation'], '丙部负责人：本方没有待定提议，可发起授权');
    assert.deepStrictEqual(uniq(trueSet.x2), ['appointments.accept', 'appointments.decline'], '待接受任职的本人');
    assert.deepStrictEqual(uniq(trueSet.m2), ['delegations.accept', 'delegations.decline'], '待接受授权的本人');
    assert.deepStrictEqual(trueSet.del, [], '代表人：无');
    assert.deepStrictEqual(trueSet.m1, [], '一般成员：无');
    assert.deepStrictEqual(trueSet.x1, [], 'M2：待负责人确认（pending_owner）授权的被授权人：此时什么都不能做');
    // M2：待负责人确认的授权，被授权人 accept / decline 都 409，状态不变（详情里本就看不到这条授权，所以单独打）
    {
      const w = await build('active');
      const before = await snapshot(w);
      for (const action of ['accept', 'decline']) {
        const r = await api(U.x1, 'POST', `/sysbuild/delegations/${w.dlPO}/${action}`, {});
        expectErr(r, 409, 'SYSBUILD_STATE', `pending_owner 的被授权人 ${action}`);
      }
      assert.strictEqual(await snapshot(w), before, '被授权人对 pending_owner 授权的 accept / decline 不改任何状态');
    }
    // ── M3：已终止——全部标志为假，执行一律被拒（有权限的人是 409 PROJECT_READONLY）──
    const TERM_IDS = IDENTITIES.filter(([label]) => ['pm', 'own', 'del', 'ro', 'admin', 'x2', 'm2', 'cand'].includes(label));
    const term = await runMatrix('terminated', TERM_IDS);
    assert.strictEqual(term.trueRuns, 0, '已终止：没有任何标志为真');
    for (const [label, set] of Object.entries(term.trueSet)) assert.deepStrictEqual(set, [], `已终止 ${label} 无可用动作`);
    assert.ok(term.falseRuns >= 300, `已终止的为假执行次数: ${term.falseRuns}`);
    assert.strictEqual(term.rejectCodes['pm parties.rename'], 'SYSBUILD_PROJECT_READONLY', '有权限的 PM 在已终止项目里被拒的原因是项目状态');
    assert.strictEqual(term.rejectCodes['pm projectObjs.add_member'], 'SYSBUILD_PROJECT_READONLY');
    assert.strictEqual(term.rejectCodes['admin parties.rename'], 'SYSBUILD_PROJECT_READONLY');
    assert.strictEqual(term.rejectCodes['own delegations.revoke'], 'SYSBUILD_PROJECT_READONLY');
    assert.strictEqual(term.rejectCodes['x2 appointments.accept#inv'], 'SYSBUILD_PROJECT_READONLY', '本人的待接受任职邀请：已终止 409 PROJECT_READONLY');
    // ── M3：已结项——与进行中一致（membership 在已结项允许，D3）──
    const clo = await runMatrix('closed', TERM_IDS);
    for (const [label] of TERM_IDS) assert.deepStrictEqual(uniq(clo.trueSet[label]), uniq(trueSet[label]), `已结项 ${label} 的可用动作与进行中一致`);
    assert.ok(clo.trueRuns >= 25, `已结项的为真执行次数: ${clo.trueRuns}`);
  });
}

// ── 变异（C2b）：写法同主套件的 MUTATIONS；锚点必须在副本里恰好出现一次，expect 的每个前缀都要被实际打红的用例命中 ──
const MEMBERSHIP_MUTATIONS = [
  { id: '去掉「邀请人仍有权」重核（邀请人已不是 PM 仍可接受）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "if (!entitled) requalReason = '邀请人已不是本项目 PM，该邀请已失效';", to: "if (false) requalReason = '邀请人已不是本项目 PM，该邀请已失效';" }] },
  { id: '邀请人资格重核去掉「或是 admin」分支', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "return inv.inviter_role === 'admin';", to: 'return false;' }] },
  { id: '邀请人资格：去掉只读否决（L7 / M-2：只读 admin 与只读 PM 都仍有权）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: '  if (roSet.has(Number(inv.invited_by))) return false;\n', to: '' }] },
  { id: '邀请人资格：PM 分支先于只读否决（M-2：只读后的 PM 的邀请仍有效）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "  if (roSet.has(Number(inv.invited_by))) return false;\n  if (Number(inv.invited_by) === Number(project.pm_user_id)) return true;", to: "  if (Number(inv.invited_by) === Number(project.pm_user_id)) return true;\n  if (roSet.has(Number(inv.invited_by))) return false;" }] },
  { id: 'M-3：接受加入不写 member_joined 事件', expect: ['加入邀请：接受与拒绝'], edits: [{ file: 'membership.js', from: "await emit(q, user, row.project_id, 'member', row.member_id, 'member_joined', { user_id: row.user_id, party_id: row.party_id, invitation_id: row.id });", to: '' }] },
  { id: 'M-1：共享判定去掉本人目标限制', expect: ['管理动作不得作用于本人', 'rules（C2b）'], edits: [{ file: 'rules.js', from: 'if (def.noSelf && isSelfManagedTarget(identity, t)) return', to: 'if (false) return' }] },
  { id: 'M-1：移出成员的写端点不传目标用户', expect: ['管理动作不得作用于本人'], edits: [{ file: 'membership.js', from: 'isPmRow, targetUserId: member.user_id });', to: 'isPmRow });' }] },
  { id: 'M-1：撤回任职的写端点不传目标用户', expect: ['管理动作不得作用于本人'], edits: [{ file: 'membership.js', from: "rules.assertOp('appointment_withdraw', identity, identity.project, { status: a.status, targetUserId: a.user_id });", to: "rules.assertOp('appointment_withdraw', identity, identity.project, { status: a.status });" }] },
  { id: 'M-1：结束任职的写端点不传目标用户', expect: ['管理动作不得作用于本人'], edits: [{ file: 'membership.js', from: "rules.assertOp('appointment_end', identity, identity.project, { status: a.status, targetUserId: a.user_id });", to: "rules.assertOp('appointment_end', identity, identity.project, { status: a.status });" }] },
  { id: 'M-1：详情里成员 remove 标志不带目标用户（读写不同源）', expect: ['管理动作不得作用于本人'], edits: [{ file: 'membership.js', from: 'Number(project.pm_user_id), targetUserId: m.user_id }) };', to: 'Number(project.pm_user_id) }) };' }] },
  { id: 'M-1：详情里任职 end / withdraw 标志不带目标用户（读写不同源）', expect: ['管理动作不得作用于本人'], edits: [
    { file: 'membership.js', from: "withdraw: rules.opAllowed('appointment_withdraw', identity, project, { status: a.status, targetUserId: a.user_id }),", to: "withdraw: rules.opAllowed('appointment_withdraw', identity, project, { status: a.status })," },
    { file: 'membership.js', from: "end: rules.opAllowed('appointment_end', identity, project, { status: a.status, targetUserId: a.user_id }),", to: "end: rules.opAllowed('appointment_end', identity, project, { status: a.status })," },
  ] },
  { id: '邀请人资格不通过时不把邀请置为已撤回', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "await settleStaleInvitation(q, user, row, verdict.message, 'accept');", to: '' }] },
  { id: '拒绝加入不置成员行已移出', expect: ['加入邀请：接受与拒绝'], edits: [{ file: 'membership.js', from: "const rm = await q.run(\"UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = ? WHERE id = ? AND removed_at IS NULL AND joined_at IS NULL\", ['拒绝加入', row.member_id]);", to: 'const rm = { changes: 1 };' }] },
  { id: '接受加入的条件更新去掉 joined_at IS NULL（运行时并发用例；静态守卫同样会判红，见报告）', expect: ['加入邀请：joined_at 条件更新'], edits: [{ file: 'membership.js', from: 'WHERE id = ? AND joined_at IS NULL AND removed_at IS NULL"', to: 'WHERE id = ? AND removed_at IS NULL"' }] },
  { id: '接受任职不结束原负责人', expect: ['任职：接受生效与原负责人更换'], edits: [{ file: 'membership.js', from: "for (const old of olds) await endAppointment(q, user, projectId, old, '负责人更换', '负责人更换后需重新授权');", to: '' }] },
  { id: '负责人更换（结束任职）不撤销 / 撤回基于它的授权', expect: ['任职：接受生效与原负责人更换', '任职：撤回 / 结束 / 拒绝', '移出成员：级联'], edits: [{ file: 'membership.js', from: '  await settleDelegationsOfAppointment(q, user, projectId, a.id, delegationReason);', to: '' }] },
  { id: '接受授权不撤销原生效代表人', expect: ['授权：确认、接受与更换'], edits: [{ file: 'membership.js', from: "for (const old of olds) await revokeDelegation(q, user, projectId, old, '代表人更换');", to: '' }] },
  { id: '依据失效的授权提议接受时不置为已撤回', expect: ['授权：负责人更换后旧提议'], edits: [{ file: 'membership.js', from: "await moveDelegation(q, user, d.project_id, d, 'withdrawn', 'delegation_withdrawn', { reason: verdict.message, stale: true });", to: '' }] },
  { id: 'PM 可撤销生效授权', expect: ['授权：撤销与撤回', 'rules（C2b）'], edits: [{ file: 'rules.js', from: 'delegation_revoke: Object.freeze({ can: (identity, project, t) => ownsParty(identity, t.party_id),', to: 'delegation_revoke: Object.freeze({ can: (identity, project, t) => ownsParty(identity, t.party_id) || canManageMembership(identity),' }] },
  { id: '授权可授给本方现任负责人本人', expect: ['授权：发起与校验'], edits: [{ file: 'membership.js', from: "if (m.id === cur.member_id) throw stateError('负责人与代表人须分设，不能授权给本方现任负责人本人');", to: '' }] },
  { id: '授权可授给 PM', expect: ['授权：发起与校验'], edits: [{ file: 'membership.js', from: "if (present(m.user_id) && Number(m.user_id) === Number(identity.project.pm_user_id)) throw stateError('PM 不得兼任参与方代表人');", to: '' }] },
  // C4b Q-D1：原变异「授权可授给无账号成员」（去掉 C2 的拒绝）随契约翻转——现在无账号成员可以被授权，对应变异是把 C2 的拒绝恢复（派单 3：「:578 恢复拒绝」）。
  { id: 'C4b 授权拒绝无账号成员（恢复 C2 守卫，违反 Q-D1）', expect: ['授权：发起与校验', 'C4b 无账号授权'], edits: [{ file: 'membership.js', from: "if (m.joined_at === null) throw stateError('该成员尚未接受加入，不能授权');", to: "if (m.joined_at === null) throw stateError('该成员尚未接受加入，不能授权');\n      if (!present(m.user_id)) throw stateError('无账号成员不能被授权为代表人');" }] },
  { id: '只读负责人授权被否决', expect: ['授权：发起与校验', 'rules（C2b）'], edits: [{ file: 'rules.js', from: "if (ownsParty(identity, partyId)) return 'pending_accept';", to: "if (ownsParty(identity, partyId) && !identity.isReadonly) return 'pending_accept';" }] },
  { id: '只读账号接受邀请被否决', expect: ['加入邀请：项目状态与只读账号', 'rules（C2b）'], edits: [{ file: 'rules.js', from: "invitation_accept: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t),", to: "invitation_accept: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t) && !identity.isReadonly," }] },
  { id: '窄范围入口多返回一个字段', expect: ['窄范围入口：'], edits: [{ file: 'membership.js', from: 'permission_note: PERMISSION_NOTES[row.kind],', to: 'permission_note: PERMISSION_NOTES[row.kind], leak: row.party_id,' }] },
  { id: '窄范围入口：别人的邀请也能读', expect: ['窄范围入口：'], edits: [{ file: 'membership.js', from: "      if (!row || !present(row.user_id) || Number(row.user_id) !== Number(user.id)) throw rules.notFound();\n      if (row.status !== 'pending'", to: "      if (!row) throw rules.notFound();\n      if (row.status !== 'pending'" }] },
  { id: '接受邀请时非本人返回 403 而不是 404', expect: ['检查顺序（C2b）'], edits: [{ file: 'membership.js', from: "const row = await q.get(`${INVITATION_SELECT} WHERE i.id = ?`, [iid]);\n        if (!row || !present(row.user_id) || Number(row.user_id) !== Number(user.id)) throw rules.notFound();", to: "const row = await q.get(`${INVITATION_SELECT} WHERE i.id = ?`, [iid]);\n        if (!row || !present(row.user_id) || Number(row.user_id) !== Number(user.id)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');" }] },
  { id: '我的邀请列表含已处理的邀请', expect: ['窄范围入口：'], edits: [{ file: 'membership.js', from: "WHERE m.user_id = ? AND i.status = 'pending' AND m.removed_at IS NULL ORDER BY i.id", to: 'WHERE m.user_id = ? AND m.removed_at IS NULL ORDER BY i.id' }] },
  { id: '移出成员不级联本人名下的授权', expect: ['移出成员：级联'], edits: [{ file: 'membership.js', from: "for (const d of dels) {\n    if (d.status === 'active') await revokeDelegation(q, user, projectId, d, '成员移出');", to: "for (const d of []) {\n    if (d.status === 'active') await revokeDelegation(q, user, projectId, d, '成员移出');" }] },
  { id: '移出成员不撤回待接受任职', expect: ['移出成员：级联'], edits: [{ file: 'membership.js', from: "await moveAppointment(q, user, projectId, a, 'withdrawn', 'appointment_withdrawn', { reason: '成员移出' });", to: '' }] },
  { id: '移出成员不撤回待接受邀请', expect: ['移出成员：级联'], edits: [{ file: 'membership.js', from: "for (const inv of invs) await moveInvitation(q, user, inv, 'withdrawn', { reason: '成员移出' });", to: '' }] },
  { id: 'PM 本人的成员行可被移出', expect: ['移出成员：级联', 'rules（C2b）'], edits: [{ file: 'rules.js', from: "return t.isPmRow ? 'PM 本人的成员行不能移出，要更换 PM 请走更换 PM' : null;", to: 'return null;' }] },
  { id: '接受类动作的项目状态改按 accept 判（D3 违例：已结项不能接受）', expect: ['加入邀请：项目状态与只读账号', 'rules（C2b）'], edits: [{ file: 'rules.js', from: 'if (!projectAllowsWrite(project.status, OP_KIND[op])) return', to: "if (!projectAllowsWrite(project.status, 'accept')) return" }] }, // C3a：checkOp 改查 OP_KIND，锚点随之改写，语义不变（全部动作改按 accept 判）
  { id: '状态查表：已终止放行 membership', expect: ['参与方：新建', 'rules（C2b）', 'rules：项目状态 × 动作表'], edits: [{ file: 'rules.js', from: 'membership: Object.freeze({ active: true, paused: true, terminated: false, closed: true }),', to: 'membership: Object.freeze({ active: true, paused: true, terminated: true, closed: true }),' }] },
  { id: '检查顺序：项目状态 409 先于权限 403（成员动作）', expect: ['检查顺序（C2b）', 'rules（C2b）'], edits: [
    // C3a：checkOp 在权限与项目状态两行之间多了 OP_KIND 的登记硬门，锚点拆成「删掉权限行」+「在状态行之后补回权限行」，语义不变（状态 409 先于权限 403）。
    { file: 'rules.js', from: "  if (!def.can(identity, project, t)) return { status: 403, code: 'SYSBUILD_FORBIDDEN', message: '没有权限执行该操作' };\n", to: '' },
    { file: 'rules.js', from: "if (!projectAllowsWrite(project.status, OP_KIND[op])) return { status: 409, code: 'SYSBUILD_PROJECT_READONLY', message: '当前项目状态不允许该写入' };", to: "if (!projectAllowsWrite(project.status, OP_KIND[op])) return { status: 409, code: 'SYSBUILD_PROJECT_READONLY', message: '当前项目状态不允许该写入' };\n  if (!def.can(identity, project, t)) return { status: 403, code: 'SYSBUILD_FORBIDDEN', message: '没有权限执行该操作' };" },
  ] },
  { id: '成员管理只读否决被去掉（只读 PM 可建参与方）', expect: ['参与方：新建', 'rules（C2b）', 'admin 接管后（C2b）'], edits: [{ file: 'rules.js', from: 'function canManageMembership(identity) {\n  if (identity.isReadonly) return false;\n', to: 'function canManageMembership(identity) {\n' }] },
  { id: '成员管理只读否决对 admin 失效（只读 admin 可管理）', expect: ['rules（C2b）', 'admin 接管后（C2b）'], edits: [{ file: 'rules.js', from: 'function canManageMembership(identity) {\n  if (identity.isReadonly) return false;', to: 'function canManageMembership(identity) {\n  if (identity.isReadonly && !identity.isAdmin) return false;' }] },
  { id: 'fixC：admin 管理被否决（管理类动作又只给 PM）', expect: ['参与方：新建', 'rules（C2b）', 'actions 与执行一致（C2b）'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm || identity.isAdmin);', to: 'return !!identity.isPm;' }] },
  { id: 'fixC：admin 未接管可发起 pending_owner 授权（以 PM 身份行事判定换成了管理判定）', expect: ['admin 接管后（C2b）', 'rules（C2b）'], edits: [{ file: 'rules.js', from: "if (canActAsPm(identity)) return 'pending_owner';", to: "if (canManageMembership(identity)) return 'pending_owner';" }] },
  { id: 'D4：admin 未接管可撤回授权提议', expect: ['admin 接管后（C2b）', 'rules（C2b）'], edits: [{ file: 'rules.js', from: 'if (canActAsPm(identity)) return true;', to: 'if (canManageMembership(identity)) return true;' }] },
  { id: 'L2：前 PM（发起人）仍能撤回授权提议', expect: ['授权：撤销与撤回', 'rules（C2b）'], edits: [{ file: 'rules.js', from: 'return Number(target.proposed_by) === Number(identity.userId) && ownsParty(identity, target.party_id);', to: 'return Number(target.proposed_by) === Number(identity.userId);' }] },
  { id: 'D2：加成员不拦操作人本人', expect: ['成员：添加有账号'], edits: [{ file: 'membership.js', from: "rules.assertNotSelfTarget('member_add', identity, userId);", to: '' }] },
  { id: 'D2：提议任职不拦操作人本人', expect: ['任职：提议与校验'], edits: [{ file: 'membership.js', from: "rules.assertNotSelfTarget('appointment_propose', identity, m.user_id);", to: '' }] },
  { id: 'L3：授权可重复授给当前生效代表人', expect: ['授权：发起与校验'], edits: [{ file: 'membership.js', from: "if (act && act.member_id === m.id) throw stateError('该成员已是本方生效代表人');", to: '' }] },
  { id: 'L4：窄范围入口对已处理 / 已移出的邀请照常返回', expect: ['窄范围入口：'], edits: [{ file: 'membership.js', from: "if (row.status !== 'pending' || row.removed_at !== null) throw rules.notFound();", to: '' }] },
  { id: 'M1 ①：拒绝邀请也走资格重核', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'rules.js', from: 'invitation_decline: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: pendingInvitationState }),', to: 'invitation_decline: Object.freeze({ can: (identity, project, t) => isSelfTarget(identity, t), state: pendingInvitationState, requal: requalOf }),' }] },
  { id: 'M1 ②：接受时重核不通过不收掉关联的待接受成员行', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: 'if (row.removed_at === null && row.joined_at === null) {\n      const rm', to: 'if (false) {\n      const rm' }] },
  { id: 'M1 ②：接受时重核不通过不撤回关联的待接受任职', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "if (appt && appt.status === 'pending') await moveAppointment(q, user, row.project_id, appt, 'withdrawn', 'appointment_withdrawn', { reason: why, stale: true, via });", to: '' }] },
  { id: 'M1 ③：更换 PM 不撤回原 PM 发出的待处理邀请', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'projects.js', from: 'await membership.withdrawInvitationsOfInviter(q, user, pid, oldPm, ctx.readonlyIds);', to: '' }] },
  { id: 'M1 ③：更换 PM 连 admin 发出的邀请也撤回', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "if (inviter && inviter.role === 'admin' && !roSet.has(Number(inviterId))) return 0;", to: '' }] },
  { id: 'M2：被授权人可接受 pending_owner 的授权（C43）', expect: ['rules（C2b）', 'actions 与执行一致（C2b）'], edits: [{ file: 'rules.js', from: "const pendingAcceptState = (t) => (t.status === 'pending_accept' ? null :", to: "const pendingAcceptState = (t) => (t.status === 'pending_accept' || t.status === 'pending_owner' ? null :" }] },
  { id: 'M2：邀请人资格重核只对 join 类生效（C13）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: 'if (!entitled) requalReason', to: "if (!entitled && inv.kind === 'join') requalReason" }] },
  { id: 'M3：项目级 add_member 标志不看项目状态（MA）', expect: ['actions 与执行一致（C2b）'], edits: [{ file: 'rules.js', from: "add_member: opAllowed('member_add', identity, project, {}),", to: 'add_member: canManageMembership(identity),' }] },
  { id: 'M3：项目级 party_sides 不看项目状态（MB）', expect: ['actions 与执行一致（C2b）'], edits: [{ file: 'rules.js', from: "const partySides = ['demand', 'dev'].filter((side) => opAllowed('party_add', identity, project, { side, hasDevParty: !!identity.hasDevParty, hasPendingContentPackage: !!identity.hasPendingContentPackage }));", to: "const partySides = canManageMembership(identity) ? (identity.hasDevParty ? ['demand'] : ['demand', 'dev']) : [];" }] },
  { id: 'M3：详情里参与方的 rename 标志不看项目状态（MC）', expect: ['actions 与执行一致（C2b）'], edits: [{ file: 'membership.js', from: "rename: rules.opAllowed('party_rename', identity, project, {}),", to: 'rename: rules.canManageMembership(identity),' }] },
  { id: 'D3 放开历史：普通成员看不到已结束的任职', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'ended' || (activeMember(row)", to: 'managerOf(identity) || (activeMember(row)' }] },
  { id: 'D3 放开历史：普通成员看不到已撤销的授权', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'revoked' || (activeMember(row)", to: 'managerOf(identity) || (activeMember(row)' }] },
  { id: 'D3 放开历史：已移出成员名下的历史任职 / 授权不可见', expect: ['详情（C2b）'], edits: [
    { file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'ended' || (activeMember(row)", to: "managerOf(identity) || (row.status === 'ended' && activeMember(row)) || (activeMember(row)" },
    { file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'revoked' || (activeMember(row)", to: "managerOf(identity) || (row.status === 'revoked' && activeMember(row)) || (activeMember(row)" },
  ] },
  { id: 'D3 放开历史：已拒绝 / 已撤回的任职提议也对普通成员可见', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'ended' || (activeMember(row)", to: "managerOf(identity) || ['ended', 'rejected', 'withdrawn'].includes(row.status) || (activeMember(row)" }] },
  { id: 'D3 放开历史：已拒绝 / 已撤回的授权提议也对普通成员可见', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "managerOf(identity) || row.status === 'revoked' || (activeMember(row)", to: "managerOf(identity) || ['revoked', 'rejected', 'withdrawn'].includes(row.status) || (activeMember(row)" }] },
  { id: 'M4：普通成员看得到别人的待接受任职（C4）', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "(mineOf(identity, row) && row.status === 'pending')", to: "(row.status === 'pending')" }] },
  { id: 'M4：负责人看得到别方的待处理授权（C41）', expect: ['详情（C2b）'], edits: [{ file: 'membership-visibility.js', from: "rules.ownsParty(identity, row.party_id) && ['pending_owner', 'pending_accept', 'active'].includes(row.status)", to: "identity.ownerOfParties.length > 0 && ['pending_owner', 'pending_accept', 'active'].includes(row.status)" }] },
  { id: 'H1：我的邀请列表含别人的邀请（C1）', expect: ['我的邀请：列表'], edits: [{ file: 'membership.js', from: "WHERE m.user_id = ? AND i.status = 'pending' AND m.removed_at IS NULL ORDER BY i.id", to: "WHERE (m.user_id = ? OR 1 = 1) AND i.status = 'pending' AND m.removed_at IS NULL ORDER BY i.id" }] },
  { id: 'H1：我的邀请列表含别人的 pending_accept 授权（C2）', expect: ['我的邀请：列表'], edits: [{ file: 'membership.js', from: "WHERE m.user_id = ? AND d.status = 'pending_accept' AND m.removed_at IS NULL ORDER BY d.id", to: "WHERE (m.user_id = ? OR 1 = 1) AND d.status = 'pending_accept' AND m.removed_at IS NULL ORDER BY d.id" }] },
  { id: 'H1：我的邀请列表含待负责人确认的授权（C3）', expect: ['我的邀请：列表'], edits: [{ file: 'membership.js', from: "AND d.status = 'pending_accept' AND m.removed_at IS NULL ORDER BY d.id", to: "AND d.status IN ('pending_accept', 'pending_owner') AND m.removed_at IS NULL ORDER BY d.id" }] },
  { id: 'L1：任职类重核不查成员行已移出（C6）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: 'else if (inv.removed_at !== null) requalReason', to: 'else if (false) requalReason' }] },
  { id: 'L1：任职类重核不查任职是否仍待接受（C7）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: "if (apptStatus !== 'pending') requalReason", to: 'if (false) requalReason' }] },
  { id: 'L1：任职类重核不查受邀人已是 PM（C8）', expect: ['加入邀请：邀请人资格重核'], edits: [{ file: 'membership.js', from: 'else if (present(inv.user_id) && Number(inv.user_id) === Number(project.pm_user_id)) requalReason', to: 'else if (false) requalReason' }] },
  { id: 'L1：授权重核不查被授权人已移出（C9）', expect: ['授权：负责人更换后旧提议'], edits: [{ file: 'membership.js', from: 'else if (!memberActive) requalReason', to: 'else if (false) requalReason' }] },
  { id: '开发方不限一个', expect: ['参与方：新建', 'rules（C2b）'], edits: [{ file: 'rules.js', from: "if (t.side === 'dev' && t.hasDevParty) return '本项目已有开发方参与方，每个项目至多一个';", to: '' }] },
  { id: '添加成员不查重复邀请', expect: ['成员：添加有账号'], edits: [{ file: 'membership.js', from: "if (exist) throw stateError(exist.joined_at === null ? '该用户已有待接受的加入邀请' : '该用户已是本项目成员');", to: '' }] },
  { id: '添加成员不校验参与方归属', expect: ['成员：添加有账号'], edits: [{ file: 'membership.js', from: "if (!party) throw invalid('参与方不存在或不属于本项目', 'party_id');", to: '' }] },
  { id: '无账号任职也建邀请', expect: ['任职：提议与校验'], edits: [{ file: 'membership.js', from: 'if (present(m.user_id)) {', to: 'if (true) {' }] },
  { id: '任职提议不拦 PM 兼任', expect: ['任职：提议与校验'], edits: [{ file: 'membership.js', from: "if (present(m.user_id) && Number(m.user_id) === Number(identity.project.pm_user_id)) throw stateError('PM 不得兼任参与方负责人');", to: '' }] },
  { id: '任职提议不拦未加入成员', expect: ['任职：提议与校验'], edits: [{ file: 'membership.js', from: "if (m.joined_at === null) throw stateError('该成员尚未接受加入，不能任命');", to: '' }] },
  { id: '撤回任职不撤回对应邀请', expect: ['任职：撤回 / 结束 / 拒绝'], edits: [{ file: 'membership.js', from: "await withdrawInvitationsOfAppointment(q, user, apid, { reason: '任职提议已撤回' });", to: '' }] },
  { id: 'actions：成员的 remove 标志不看 PM 行（与执行不一致）', expect: ['actions 与执行一致（C2b）'], edits: [{ file: 'membership.js', from: 'isPmRow: present(m.user_id) && Number(m.user_id) === Number(project.pm_user_id), targetUserId', to: 'isPmRow: false, targetUserId' }] },
  { id: 'actions：参与方的授权标志不看待定提议（与执行不一致）', expect: ['actions 与执行一致（C2b）'], edits: [{ file: 'membership.js', from: 'party_id: p.id, currentAppointmentId: currentAppt[p.id] || null, hasPendingDelegation: !!pendingDel[p.id],', to: 'party_id: p.id, currentAppointmentId: currentAppt[p.id] || null, hasPendingDelegation: false,' }] },
];

module.exports = { defineMembershipCases, MEMBERSHIP_MUTATIONS };
