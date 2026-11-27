'use strict';
// 平台管理员（routes/sysbuild/rules.js「平台管理员」段，2026-11-27 用户定：便于补录）：
//   名单内、平台角色为 admin 的账号（U.superAdmin，编号 1）不接管即可做 PM 的全部动作，并可代办须由对方本人做的确认与表态；
//   其余 admin 角色账号（U.admin）的权限不变。期望值一律手写，不取自被测代码。
const assert = require('node:assert/strict');
const path = require('node:path');

const T_PM = '平台管理员：不接管即可做 PM 的动作，普通管理员仍被拒';
const T_GATE = '平台管理员：标记不可冒用，只读否决与项目状态限制照旧';
const T_CONFIRM = '平台管理员：代办确认如实留痕';
const T_WORK = '平台管理员：代办开发评估与砍需求表态，待办不串';
const T_CUT = '平台管理员：多部门砍需求表态与结论文案';
const T_SELF = '平台管理员：本人就是开发负责人或表态负责人时按本人记';
const T_RO = '平台管理员：同时在只读名单时经真实端点一律被拒';

function defineSuperAdminCases(T) {
  const { test, U, api, upload, sqlGet, sqlAll, sqlRun, expectErr, addParty, addMember, addAppointment, addDelegation, confirm: H } = T;
  const get = (uid, url) => api(uid, 'GET', '/sysbuild' + url);
  const post = (uid, url, body = {}) => api(uid, 'POST', '/sysbuild' + url, body);
  const nodesOf = async (pid) => Object.fromEntries((await get(U.pm, `/projects/${pid}/plan`)).body.nodes.map((n) => [n.template_key, n]));
  const eventsOf = (pid, type) => sqlAll('SELECT operator_id, payload_json FROM sysbuild_events WHERE project_id = ? AND event_type = ? ORDER BY id', [pid, type]);
  const payloadOf = (event) => JSON.parse(event.payload_json);
  const denied = (r, label) => expectErr(r, 403, 'SYSBUILD_FORBIDDEN', label);
  const nameOf = async (uid) => (await sqlGet('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [uid])).name;
  // 造一个待确认的立项包：一个需求部门（领导 leader、负责人 U.del），立项由领导确认。
  const submitInitiation = async (leader = U.own) => {
    const pid = await H.newProject();
    const party = await H.seedParty(pid, '补录需求部门', leader, U.del);
    const pk = await H.mkPackage(pid, 'initiation');
    const pv = await H.mkVersion(pk);
    await H.declareInitiationBasis(pv);
    const sent = await post(U.pm, `/package-versions/${pv}/submit`);
    assert.strictEqual(sent.status, 200, sent.text);
    const tasks = await H.tasksOf(pv);
    assert.deepStrictEqual(tasks.map((task) => task.user_id), [leader], '立项由需求部门领导确认');
    return { pid, pv, party, task: tasks[0] };
  };
  const viewersOf = async (pv) => (await sqlAll("SELECT user_id FROM sysbuild_views WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY id", [pv])).map((row) => row.user_id);
  const confirmationsOf = (pv) => sqlAll('SELECT actor_user_id, decision FROM sysbuild_confirmations WHERE object_version_id = ? ORDER BY id', [pv]);
  // 开发方：领导 U.x1，负责人 responsible（缺省 U.x2）。返回负责人的授权编号。
  const seedDev = async (pid, responsible = U.x2) => {
    const party = await addParty(pid, '补录开发组', 'dev');
    const lead = await addMember(pid, U.x1, { party });
    return addDelegation(party, await addMember(pid, responsible, { party }), await addAppointment(party, lead, 'active'), 'active');
  };
  const act = (uid, id, body) => post(uid, `/opinions/${id}/actions`, body);
  const opinionOf = async (uid, id) => (await get(uid, `/opinions/${id}`)).body.opinion;
  // 开发方领导提出砍需求，PM 初判合理，进入各需求部门表态。
  const openCutIn = async (pid, parties) => {
    const created = await post(U.x1, `/projects/${pid}/opinions`, { title: '本期移出一项范围', body: '开发方提出本期移出一项范围。' });
    assert.strictEqual(created.status, 201, created.text);
    const classified = await act(U.pm, created.body.opinion.id, { action: 'triage', category: 'cut', decision: 'continue', text: '初判合理，请需求方负责人表态' });
    assert.deepStrictEqual([classified.status, classified.body.opinion.approvals.map((row) => row.party_id)], [200, parties.map((party) => party.party)]);
    return created.body.opinion.id;
  };
  // 砍需求表态：平台管理员代办时带回代办对象的授权编号（expected），负责人本人不带。
  const cutDecide = (uid, id, party, decision = 'agree', extra = {}) => act(uid, id, { action: 'cut_decide', party_id: party.party, decision, ...extra });
  const cutProxy = (id, party, decision = 'agree', extra = {}) => cutDecide(U.superAdmin, id, party, decision, { expected_delegation_id: party.dlg, ...extra });

  test(T_PM, async () => {
    const pid = await H.newProject();
    const nodes = await nodesOf(pid);
    // 身份卡与项目级 actions：平台管理员不是 PM、不是成员，但维护类标志都为真；普通管理员不变。
    const mine = (await get(U.superAdmin, `/projects/${pid}`)).body;
    assert.deepStrictEqual([mine.me.is_admin, mine.me.is_super_admin, mine.me.is_pm, mine.me.is_member], [true, true, false, false]);
    assert.deepStrictEqual(
      [mine.actions.edit_basics, mine.actions.add_member, mine.actions.add_party, mine.actions.view_send_intents, mine.actions.takeover],
      [true, true, true, true, true]
    );
    assert.deepStrictEqual(mine.notify, { send_failed: 0 }, '能补发的人带发送失败条数');
    const plain = (await get(U.admin, `/projects/${pid}`)).body;
    assert.deepStrictEqual(
      [plain.me.is_admin, plain.me.is_super_admin, plain.actions.edit_basics, plain.actions.add_member, plain.actions.add_party, plain.actions.view_send_intents, plain.actions.takeover],
      [true, false, false, false, false, false, true]
    );
    assert.strictEqual(Object.hasOwn(plain, 'notify'), false);
    assert.strictEqual((await get(U.pm, `/projects/${pid}`)).body.me.is_super_admin, false);

    // 改基本信息
    const edit = { goal: '补录：按线下立项资料登记的项目目标' };
    denied(await api(U.admin, 'PATCH', `/sysbuild/projects/${pid}`, edit), '普通管理员改基本信息');
    const edited = await api(U.superAdmin, 'PATCH', `/sysbuild/projects/${pid}`, edit);
    assert.strictEqual(edited.status, 200, edited.text);
    assert.strictEqual(edited.body.project.goal, edit.goal);

    // 材料：卡片标志与上传执行同源；留痕如实记平台管理员本人
    const basis = `/nodes/${nodes.p_initiation.id}/materials/initiation-basis/versions`;
    const cardOf = async (uid) => (await get(uid, `/projects/${pid}/materials`)).body.cards.find((card) => card.key === 'initiation-basis');
    assert.deepStrictEqual((await cardOf(U.admin)).actions, { upload: false, mark_not_applicable: false });
    assert.deepStrictEqual((await cardOf(U.superAdmin)).actions, { upload: true, mark_not_applicable: true });
    denied(await post(U.admin, basis, { body: '线下立项纪要' }), '普通管理员上传材料');
    const att = await H.stageAtt(pid, U.superAdmin);
    const uploaded = await post(U.superAdmin, basis, { body: '线下立项纪要', attachment_ids: [att] });
    assert.strictEqual(uploaded.status, 201, uploaded.text);
    assert.deepStrictEqual((await eventsOf(pid, 'material_version_created')).map((event) => event.operator_id), [U.superAdmin]);

    // 排期、阶段开始、自建卡片、遮蔽附件
    const plan = { kind: 'plan', planned_start: H.PLAN_START, planned_end: H.PLAN_END };
    denied(await post(U.admin, `/nodes/${nodes.p_initiation.id}/schedule`, plan), '普通管理员排期');
    assert.strictEqual((await post(U.superAdmin, `/nodes/${nodes.p_initiation.id}/schedule`, plan)).status, 201);
    denied(await post(U.admin, `/nodes/${nodes.p_initiation.id}/start`), '普通管理员开始阶段');
    assert.strictEqual((await post(U.superAdmin, `/nodes/${nodes.p_initiation.id}/start`)).status, 200);
    denied(await post(U.admin, `/nodes/${nodes.b_dev.id}/material-cards`, { name: '补录资料' }), '普通管理员自建卡片');
    assert.strictEqual((await post(U.superAdmin, `/nodes/${nodes.b_dev.id}/material-cards`, { name: '补录资料' })).status, 201);
    denied(await post(U.admin, `/attachments/${att}/mask`, { reason: '该材料包含受控信息' }), '普通管理员遮蔽附件');
    assert.strictEqual((await post(U.superAdmin, `/attachments/${att}/mask`, { reason: '该材料包含受控信息' })).status, 200);

    // 另两个有独立权限入口的 PM 动作：加成员（membership.js）、看发送意图（notify.js）
    denied(await post(U.admin, `/projects/${pid}/members`, { user_id: U.m1, party_id: null }), '普通管理员加成员');
    const joined = await post(U.superAdmin, `/projects/${pid}/members`, { user_id: U.m1, party_id: null });
    assert.strictEqual(joined.status, 201, joined.text);
    assert.deepStrictEqual(await sqlAll('SELECT user_id, added_by FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.m1]), [{ user_id: U.m1, added_by: U.superAdmin }]);
    denied(await get(U.admin, `/projects/${pid}/send-intents`), '普通管理员看发送意图');
    assert.strictEqual((await get(U.superAdmin, `/projects/${pid}/send-intents`)).status, 200);

    // 补发通知（写入口，与看发送意图同一道权限）与软删附件（附件端点自己的判定）
    denied(await post(U.admin, `/projects/${pid}/send-intents/resend`), '普通管理员补发通知');
    assert.strictEqual((await post(U.superAdmin, `/projects/${pid}/send-intents/resend`)).status, 200);
    const spare = await H.stageAtt(pid, U.pm, 'c');
    denied(await post(U.admin, `/attachments/${spare}/delete`), '普通管理员软删附件');
    assert.strictEqual((await post(U.superAdmin, `/attachments/${spare}/delete`)).status, 200);
    assert.strictEqual((await sqlGet('SELECT deleted_at FROM sysbuild_attachments WHERE id = ?', [spare])).deleted_at !== null, true);

    // 登记来源方：能代登的人才有来源选项；第一项按本人身份写，后面是本项目的参与方
    const source = await addParty(pid, '补录来源部门', 'demand');
    const registration = async (uid) => (await get(uid, `/projects/${pid}/entries`)).body.registration;
    const sources = async (uid) => (await registration(uid)).source_choices;
    assert.strictEqual(await sources(U.admin), null);
    assert.deepStrictEqual(await sources(U.superAdmin), [{ id: null, label: '管理员本人登记' }, { id: source, label: '代登：补录来源部门' }]);
    assert.deepStrictEqual(await sources(U.pm), [{ id: null, label: 'PM 本人登记' }, { id: source, label: '代登：补录来源部门' }]);
    // 三张登记表单的可用标志：进度汇报、汇报节奏、临时汇报要求，平台管理员都可登记，普通管理员都不可
    const formFlags = async (uid) => {
      const view = await registration(uid);
      return ['progress_report', 'report_cycle', 'report_request'].map((kind) => view.forms.find((form) => form.kind === kind).allowed);
    };
    assert.deepStrictEqual(await formFlags(U.superAdmin), [true, true, true]);
    assert.deepStrictEqual(await formFlags(U.admin), [false, false, false]);
    // 带来源方的代登（entries.js 里单独判断谁能填来源方）：平台管理员用选项里的部门提交，普通管理员填了 400
    const entry = { type: 'note', title: '补录登记', body: '补录线下记录', source_party_id: (await sources(U.superAdmin))[1].id };
    expectErr(await post(U.admin, `/projects/${pid}/entries`, entry), 400, 'SYSBUILD_INVALID_INPUT', '普通管理员填来源方');
    const logged = await post(U.superAdmin, `/projects/${pid}/entries`, entry);
    assert.strictEqual(logged.status, 201, logged.text);
    assert.deepStrictEqual(
      [logged.body.entry.source_party_id, logged.body.entry.operator_user_id, logged.body.entry.operator_identity.is_pm, logged.body.entry.operator_identity.is_admin],
      [source, U.superAdmin, false, true], '代登的来源方是所填部门，操作人与身份快照如实记平台管理员（不是 PM）'
    );

    // 只读的 PM：读侧这两个字段与改动前一样照给（他本来就不能补发、不能登记，只是看得到）
    const roPid = await H.newProject();
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.ro, roPid]);
    assert.deepStrictEqual((await get(U.ro, `/projects/${roPid}`)).body.notify, { send_failed: 0 });
    assert.deepStrictEqual((await get(U.ro, `/projects/${roPid}/entries`)).body.registration.source_choices[0], { id: null, label: 'PM 本人登记' });
  });

  test(T_GATE, async () => {
    const rules = require(path.join(T.getModuleDir(), 'rules.js'));
    const pid = await H.newProject();
    const q = { get: sqlGet };
    const opts = { readonlyIds: [6, 11], writeRoles: ['admin', 'publisher', 'user'] };
    const superOf = async (user) => (await rules.loadProjectAccess(q, pid, user, opts)).isSuper;
    const mark = rules.createSuperAdminMarker([1]);
    const pass = (user) => {
      let called = 0;
      mark({ user }, null, () => { called += 1; });
      assert.strictEqual(called, 1, '标记中间件总是放行到下一个');
      return user;
    };
    // 标记只认「经过中间件的那个对象本身」
    const real = { id: 1, role: 'admin' };
    assert.strictEqual(await superOf(real), false, '没经过标记中间件的对象不算');
    pass(real);
    assert.strictEqual(await superOf(real), true);
    assert.strictEqual(await superOf({ ...real }), false, '照着拼出来的对象不算');
    assert.strictEqual(await superOf(Object.assign({ isSuper: true, is_super_admin: true }, { id: 1, role: 'admin' })), false, '自带字段不算');
    for (const [user, label] of [
      [{ id: 1, role: 'user' }, '角色不是 admin'], [{ id: '1', role: 'admin' }, '编号是字符串'],
      [{ id: 2, role: 'admin' }, '不在名单'], [{ id: [1], role: 'admin' }, '编号是数组'],
    ]) assert.strictEqual(await superOf(pass(user)), false, label);
    const demoted = pass({ id: 1, role: 'admin' });
    demoted.role = 'user';
    assert.strictEqual(await superOf(demoted), false, '标记之后角色被改掉也不算');
    const promoted = pass({ id: 1, role: 'user' });
    promoted.role = 'admin';
    assert.strictEqual(await superOf(promoted), false, '经过中间件时不是 admin 就没有登记，之后角色变成 admin 也不算');
    pass(undefined);
    pass(null);
    for (const bad of ['1', [0], [1.5], ['1'], null]) assert.throws(() => rules.createSuperAdminMarker(bad), /正整数数组/);
    assert.deepStrictEqual([Array.from(rules.SUPER_ADMIN_USER_IDS), Object.isFrozen(rules.SUPER_ADMIN_USER_IDS)], [[1], true]);

    // 纯判定：只读账号一票否决；代办不绕过对象状态前置；本人的动作不受影响
    const base = { project: { id: 1, status: 'active' }, isAdmin: true, isSuper: true, isPm: false, isMember: false, isReadonly: false, userId: 1 };
    const readonly = { ...base, isReadonly: true };
    const ordinary = { ...base, isSuper: false };
    const pm = { ...ordinary, isAdmin: false, isPm: true, isMember: true };
    assert.deepStrictEqual([base, readonly, ordinary, pm].map((identity) => rules.canActAsPm(identity)), [true, false, false, true]);
    assert.deepStrictEqual([base, readonly, ordinary, pm].map((identity) => rules.canProxyAsSuperAdmin(identity)), [true, false, false, false]);
    const statusOf = (identity, op, target) => { const verdict = rules.checkOp(op, identity, identity.project, target); return verdict ? verdict.status : 200; };
    const decide = { isRequired: false, currentRevisionId: 1, revisionStatus: 'pending', objectVersionId: 1, objectPending: true, qualificationLoss: null };
    assert.deepStrictEqual([base, readonly, ordinary, pm].map((identity) => statusOf(identity, 'confirm_decide', decide)), [200, 403, 403, 403]);
    assert.strictEqual(statusOf(readonly, 'confirm_decide', { ...decide, isRequired: true }), 200, '只读账号本人的确认不受影响');
    assert.strictEqual(statusOf(base, 'confirm_decide', { ...decide, qualificationLoss: '必需确认人已不是本项目成员，请联系项目经理改发' }), 409);
    assert.strictEqual(statusOf(base, 'confirm_decide', { ...decide, revisionStatus: 'confirmed' }), 409);
    const cut = { opinionStatus: 'cut_approval', cutStatus: 'pending', isCutResponsible: false, hasCutResponsible: true };
    assert.deepStrictEqual([base, readonly, ordinary, pm].map((identity) => statusOf(identity, 'opinion_cut_decide', cut)), [200, 403, 403, 403]);
    assert.deepStrictEqual(
      [false, undefined].map((value) => statusOf(base, 'opinion_cut_decide', { ...cut, hasCutResponsible: value })), [409, 409],
      '代办表态须有现任负责人，事实没取到也拒绝'
    );
    assert.strictEqual(statusOf(ordinary, 'opinion_cut_decide', { ...cut, isCutResponsible: true, hasCutResponsible: undefined }), 200, '本人表态不看 hasCutResponsible');
    assert.strictEqual(statusOf(base, 'opinion_cut_decide', { ...cut, cutStatus: 'agree' }), 409);
    // 进度汇报代登（entry_create_dev）：PM 与平台管理员可代登，普通管理员与只读的平台管理员不可
    assert.deepStrictEqual([base, readonly, ordinary, pm].map((identity) => statusOf(identity, 'entry_create_dev', { devPartyId: 5 })), [200, 403, 403, 200]);

    // 令牌里的角色是签发时的快照：库里编号 1 被降级后，仍写着 admin、仍带标记的旧令牌不再是平台管理员；恢复后重新生效
    const setLiveRole = (role) => sqlRun('UPDATE users SET role = ? WHERE id = ?', [role, U.superAdmin]);
    await setLiveRole('user');
    try {
      assert.strictEqual(await superOf(real), false, '库里已降级');
      denied(await api(U.superAdmin, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '降级后不应改动' }), '降级后带旧令牌改基本信息');
      assert.strictEqual((await get(U.superAdmin, `/projects/${pid}`)).body.me.is_super_admin, false);
    } finally {
      await setLiveRole('admin');
    }
    assert.strictEqual(await superOf(real), true, '恢复为 admin 后重新生效');
    assert.strictEqual((await get(U.superAdmin, `/projects/${pid}`)).body.me.is_super_admin, true);
    //   停用的账号同样不算（真实请求在平台鉴权那层就被拦下，这里只核身份读取这一层，用查询替身给出停用状态）
    const disabledQ = { get: (statement, params) => (statement.startsWith('SELECT role, status FROM users') ? Promise.resolve({ role: 'admin', status: 'disabled' }) : sqlGet(statement, params)) };
    assert.strictEqual((await rules.loadProjectAccess(disabledQ, pid, real, opts)).isSuper, false);
    const missingQ = { get: (statement, params) => (statement.startsWith('SELECT role, status FROM users') ? Promise.resolve(undefined) : sqlGet(statement, params)) };
    assert.strictEqual((await rules.loadProjectAccess(missingQ, pid, real, opts)).isSuper, false);

    // 项目状态 × 动作表对平台管理员同样生效
    const nodes = await nodesOf(pid);
    assert.strictEqual((await post(U.admin, `/projects/${pid}/status`, { to: 'terminated', reason: '核对已终止项目的写入限制' })).status, 200);
    expectErr(await post(U.superAdmin, `/nodes/${nodes.p_initiation.id}/materials/initiation-basis/versions`, { body: '终止后补材料' }), 409, 'SYSBUILD_PROJECT_READONLY');
  });

  test(T_CONFIRM, async () => {
    const { pid, pv, task } = await submitInitiation();
    const tid = task.task_id;

    // 普通管理员、PM 都不能代办；普通管理员打开不写浏览记录
    const seen = await H.openTask(U.admin, tid);
    assert.deepStrictEqual([seen.status, seen.body.actions.decide, seen.body.actions.decide_mode], [200, false, null]);
    assert.deepStrictEqual(await viewersOf(pv), []);
    const body = H.decideBodyOf(seen.body, 'confirm');
    denied(await H.decideRaw(U.admin, tid, body), '普通管理员代办确认');
    denied(await H.decideRaw(U.pm, tid, body), 'PM 代办确认');

    // 平台管理员：不进他的「待我确认」；必需确认人本人看过不算他看过，他自己没打开就不能代办；打开写一条他本人的浏览记录
    assert.deepStrictEqual((await get(U.superAdmin, '/my/confirmations')).body.items.filter((item) => item.task_id === tid), []);
    assert.strictEqual((await H.openTask(U.own, tid)).status, 200);
    assert.deepStrictEqual(await viewersOf(pv), [U.own]);
    expectErr(await H.decideRaw(U.superAdmin, tid, body), 409, 'SYSBUILD_NOT_VIEWED');
    assert.deepStrictEqual(await confirmationsOf(pv), []);
    const opened = await H.openTask(U.superAdmin, tid);
    assert.deepStrictEqual([opened.status, opened.body.actions.decide, opened.body.actions.decide_mode], [200, true, 'admin']);
    assert.deepStrictEqual(await viewersOf(pv), [U.own, U.superAdmin]);
    const done = await H.decideRaw(U.superAdmin, tid, body);
    assert.strictEqual(done.status, 200, done.text);
    assert.deepStrictEqual([done.body.decision, done.body.effective, done.body.version.status], ['confirm', true, 'effective']);

    // 留痕：确认记录与事件的操作人是平台管理员，事件另记代的是谁；读侧与确认单标「管理员代办」
    assert.deepStrictEqual(
      await sqlAll('SELECT actor_user_id, method, decision FROM sysbuild_confirmations WHERE task_revision_id = ?', [task.rev_id]),
      [{ actor_user_id: U.superAdmin, method: 'platform', decision: 'confirm' }]
    );
    assert.deepStrictEqual(
      (await eventsOf(pid, 'confirmation_recorded')).map((event) => [event.operator_id, payloadOf(event).by_super_admin, payloadOf(event).on_behalf_of_user_id]),
      [[U.superAdmin, true, U.own]]
    );
    const after = await H.openTask(U.pm, tid);
    assert.deepStrictEqual(after.body.confirmations.map((row) => [row.actor_user_id, row.by_admin_proxy]), [[U.superAdmin, true]]);
    assert.strictEqual(after.body.revision.status, 'confirmed');
    const again = await H.openTask(U.superAdmin, tid);
    assert.deepStrictEqual([again.body.actions.decide, again.body.actions.decide_mode], [false, null]);
    assert.deepStrictEqual(await viewersOf(pv), [U.own, U.superAdmin], '修订已处理后再打开不再写浏览记录');
    const sheet = await get(U.pm, `/package-versions/${pv}/confirmation-sheet`);
    assert.strictEqual(sheet.status, 200);
    assert.ok(sheet.text.includes('（管理员代办）'), '确认单标管理员代办');

    // 对照：必需确认人本人确认，不标代办
    const own = await submitInitiation();
    const ownOpened = await H.openTask(U.own, own.task.task_id);
    assert.deepStrictEqual([ownOpened.body.actions.decide, ownOpened.body.actions.decide_mode], [true, 'self']);
    assert.strictEqual((await H.decideRaw(U.own, own.task.task_id, H.decideBodyOf(ownOpened.body, 'confirm'))).status, 200);
    assert.deepStrictEqual((await H.openTask(U.pm, own.task.task_id)).body.confirmations.map((row) => [row.actor_user_id, row.by_admin_proxy]), [[U.own, false]]);
    const ownEvent = payloadOf((await eventsOf(own.pid, 'confirmation_recorded'))[0]);
    assert.deepStrictEqual([Object.hasOwn(ownEvent, 'by_super_admin'), Object.hasOwn(ownEvent, 'on_behalf_of_user_id')], [false, false]);
    assert.strictEqual((await get(U.pm, `/package-versions/${own.pv}/confirmation-sheet`)).text.includes('管理员代办'), false);

    // 平台管理员本人就是必需确认人：按本人确认记，不标代办
    const mine = await submitInitiation(U.superAdmin);
    const mineOpened = await H.openTask(U.superAdmin, mine.task.task_id);
    assert.deepStrictEqual([mineOpened.body.actions.decide, mineOpened.body.actions.decide_mode], [true, 'self']);
    assert.strictEqual((await H.decideRaw(U.superAdmin, mine.task.task_id, H.decideBodyOf(mineOpened.body, 'confirm'))).status, 200);
    assert.deepStrictEqual((await H.openTask(U.pm, mine.task.task_id)).body.confirmations.map((row) => [row.actor_user_id, row.by_admin_proxy]), [[U.superAdmin, false]]);
    assert.strictEqual(Object.hasOwn(payloadOf((await eventsOf(mine.pid, 'confirmation_recorded'))[0]), 'by_super_admin'), false);

    // 代办不绕过对象状态前置：必需确认人的任职失效后不能代办、打开也不留浏览记录；PM 改发后旧修订不能再提交，重新打开才能代办新修订
    const moved = await submitInitiation();
    const movedTid = moved.task.task_id;
    const before = await H.openTask(U.superAdmin, movedTid);
    assert.strictEqual(before.body.actions.decide, true);
    assert.deepStrictEqual(await viewersOf(moved.pv), [U.superAdmin]);
    const staleBody = H.decideBodyOf(before.body, 'confirm');
    const swapped = await api(U.pm, 'PUT', `/sysbuild/parties/${moved.party.party}/people`, {
      leader_user_id: U.cand, representative_user_id: U.del, expected_appointment_id: moved.party.apt, expected_delegation_id: moved.party.dlg, reason: '核对任职失效后的代办',
    });
    assert.strictEqual(swapped.status, 200, swapped.text);
    const lost = await H.openTask(U.superAdmin, movedTid);
    assert.deepStrictEqual([lost.body.revision.status, lost.body.actions.decide, lost.body.actions.decide_mode], ['pending', false, null]);
    assert.deepStrictEqual(await viewersOf(moved.pv), [U.superAdmin], '此刻不能代办的任务，打开不再写浏览记录');
    const refused = await H.decideRaw(U.superAdmin, movedTid, staleBody);
    expectErr(refused, 409, 'SYSBUILD_STATE');
    assert.strictEqual(refused.body.message, '必需确认人所依据的领导任职已不再生效，请联系项目经理改发');
    assert.deepStrictEqual(await confirmationsOf(moved.pv), []);
    // 改发也是 PM 的动作：平台管理员不接管直接改发，普通管理员被拒
    denied(await post(U.admin, `/confirm-tasks/${movedTid}/reissue`, { reason: '领导换人后改发' }), '普通管理员改发');
    const reissued = await post(U.superAdmin, `/confirm-tasks/${movedTid}/reissue`, { reason: '领导换人后改发' });
    assert.strictEqual(reissued.status, 200, reissued.text);
    expectErr(await H.decideRaw(U.superAdmin, movedTid, staleBody), 409, 'SYSBUILD_TASK_SUPERSEDED');
    // 浏览证据的口径：按「操作人 + 对象版本」认，且打开时间不早于本修订创建（秒级）。把改发前的那次浏览拨到更早，
    //   用新修订号直接提交就没有有效浏览了，须重新打开；同一对象版本下不同任务共用同一人的浏览记录是既有规则，不在这里收紧。
    await sqlRun("UPDATE sysbuild_views SET opened_at = '2000-01-01 00:00:00' WHERE object_version_id = ? AND user_id = ?", [moved.pv, U.superAdmin]);
    expectErr(await H.decideRaw(U.superAdmin, movedTid, { ...staleBody, revision_id: reissued.body.revision.id }), 409, 'SYSBUILD_NOT_VIEWED');
    assert.deepStrictEqual(await confirmationsOf(moved.pv), []);
    const fresh = await H.openTask(U.superAdmin, movedTid);
    assert.deepStrictEqual([fresh.body.revision.id, fresh.body.actions.decide_mode], [reissued.body.revision.id, 'admin']);
    const freshBody = H.decideBodyOf(fresh.body, 'confirm');
    expectErr(await H.decideRaw(U.superAdmin, movedTid, { ...freshBody, object_version_id: moved.pv + 100000 }), 409, 'SYSBUILD_VERSION_CHANGED');
    assert.strictEqual((await H.decideRaw(U.superAdmin, movedTid, freshBody)).status, 200);
    assert.deepStrictEqual(await sqlAll('SELECT actor_user_id, view_id FROM sysbuild_confirmations WHERE object_version_id = ?', [moved.pv]), [{ actor_user_id: U.superAdmin, view_id: fresh.body.view_id }]);
    assert.deepStrictEqual(
      (await eventsOf(moved.pid, 'confirmation_recorded')).map((event) => [event.operator_id, payloadOf(event).by_super_admin, payloadOf(event).on_behalf_of_user_id, payloadOf(event).view_id]),
      [[U.superAdmin, true, U.cand, fresh.body.view_id]], '代的是改发后的现任领导，事件引用的是重新打开的那次浏览'
    );

    // 代办有异议：与本人的异议同样处理——修订记有异议、版本仍待确认、PM 收到知会；留痕标代办
    //   知会按用途、所指修订、收件人逐项核对（用途 decision_objected，ref_id = 修订编号）
    const objectionNotices = (projectId, revisionId) => sqlAll("SELECT recipient_user_id FROM sysbuild_send_intents WHERE project_id = ? AND purpose = 'decision_objected' AND ref_id = ? ORDER BY id", [projectId, revisionId]);
    for (const [decision, status] of [['object', 'objected'], ['reject', 'rejected']]) {
      const disputed = await submitInitiation();
      const outcome = await H.openAndDecide(U.superAdmin, disputed.task.task_id, decision);
      assert.strictEqual(outcome.status, 200, outcome.text);
      assert.deepStrictEqual([outcome.body.decision, outcome.body.revision.status, outcome.body.effective, outcome.body.version.status], [decision, status, false, 'pending']);
      assert.deepStrictEqual(await confirmationsOf(disputed.pv), [{ actor_user_id: U.superAdmin, decision }]);
      assert.deepStrictEqual(
        (await eventsOf(disputed.pid, 'confirmation_recorded')).map((event) => [event.operator_id, payloadOf(event).decision, payloadOf(event).by_super_admin, payloadOf(event).on_behalf_of_user_id]),
        [[U.superAdmin, decision, true, U.own]]
      );
      assert.deepStrictEqual(await objectionNotices(disputed.pid, disputed.task.rev_id), [{ recipient_user_id: U.pm }], '代办的' + decision + '照常知会 PM');
    }

    // 平台管理员接管成为 PM 后代办异议：知会的去重按实际操作人，不给自己发
    const taken = await submitInitiation();
    const takeover = await post(U.superAdmin, `/projects/${taken.pid}/pm`, { pm_user_id: U.superAdmin, reason: '核对接管后代办的知会' });
    assert.strictEqual(takeover.status, 200, takeover.text);
    const takenOpened = await H.openTask(U.superAdmin, taken.task.task_id);
    assert.strictEqual(takenOpened.body.actions.decide_mode, 'admin', '兼任 PM 仍是代办，不是本人确认');
    assert.strictEqual((await H.decideRaw(U.superAdmin, taken.task.task_id, H.decideBodyOf(takenOpened.body, 'reject'))).status, 200);
    assert.deepStrictEqual(await confirmationsOf(taken.pv), [{ actor_user_id: U.superAdmin, decision: 'reject' }]);
    assert.deepStrictEqual(await objectionNotices(taken.pid, taken.task.rev_id), [], '自己就是 PM 时不再知会自己');
  });

  test(T_WORK, async () => {
    const pid = await H.newProject();
    const devParty = await addParty(pid, '补录开发组', 'dev');
    const lead = await addMember(pid, U.x1, { party: devParty });
    const responsible = await addMember(pid, U.x2, { party: devParty });
    const devDelegation = await addDelegation(devParty, responsible, await addAppointment(devParty, lead, 'active'), 'active');
    const demand = await H.seedParty(pid, '补录原需求部门', U.own, U.del);
    const act = (uid, id, body) => post(uid, `/opinions/${id}/actions`, body);
    const propose = async (uid) => {
      const created = await post(uid, `/projects/${pid}/opinions`, { title: '补录意见', body: '补录线下已经议定的意见内容。' });
      assert.strictEqual(created.status, 201, created.text);
      return created.body.opinion.id;
    };
    const detail = async (uid, id) => (await get(uid, `/opinions/${id}`)).body.opinion;
    const todo = async (uid, id) => (await get(uid, '/my/todo')).body.items.opinion.find((item) => item.opinion_id === id);
    const toAssessment = async () => {
      const id = await propose(U.pm);
      const triaged = await act(U.pm, id, { action: 'triage', category: 'requirement', decision: 'continue', text: '请开发方评估改动范围' });
      assert.strictEqual(triaged.body.opinion.status, 'assessment', triaged.text);
      return id;
    };
    const assessFlags = async (uid, id) => { const view = await detail(uid, id); return [view.actions.assess, view.actions.assess_mode]; };

    // 开发评估：平台管理员代办不要求截图，库里记为代录，读侧与事件标管理员代办，并告知 PM 去定去向
    const op = await toAssessment();
    assert.deepStrictEqual(await assessFlags(U.superAdmin, op), [true, 'admin']);
    assert.deepStrictEqual(await assessFlags(U.admin, op), [false, null]);
    assert.deepStrictEqual(await assessFlags(U.pm, op), [true, 'proxy']);
    assert.deepStrictEqual(await assessFlags(U.x2, op), [true, 'dev']);
    const input = { action: 'assess', text: '按线下评估结论补录', estimated_hours: 4 };
    denied(await act(U.admin, op, input), '普通管理员代办开发评估');
    expectErr(await act(U.pm, op, input), 400, 'SYSBUILD_EVIDENCE_REQUIRED', 'PM 代录仍须截图');
    // 页面带回打开表单时的登记方式：与此刻不一致就拒绝且不落库（不带则不核，兼容不带这个字段的请求）
    expectErr(await act(U.superAdmin, op, { ...input, expected_mode: 'dev' }), 409, 'SYSBUILD_STATE', '登记方式与打开表单时不一致');
    expectErr(await act(U.superAdmin, op, { ...input, expected_mode: 'someone' }), 400, 'SYSBUILD_INVALID_INPUT', '登记方式不合法');
    assert.deepStrictEqual(await sqlAll('SELECT status, assessment_source FROM sysbuild_opinions WHERE id = ?', [op]), [{ status: 'assessment', assessment_source: null }]);
    const assessed = await act(U.superAdmin, op, { ...input, expected_mode: 'admin' });
    assert.strictEqual(assessed.status, 200, assessed.text);
    const view = assessed.body.opinion;
    assert.deepStrictEqual(
      [view.status, view.assessment_source, view.assessed_by, view.assessed_for_user_id, view.assessed_for_delegation_id, view.assessment_by_admin],
      ['disposition', 'proxy', U.superAdmin, U.x2, devDelegation, true]
    );
    assert.deepStrictEqual((await eventsOf(pid, 'opinion_assessed')).map((event) => [event.operator_id, payloadOf(event).source, payloadOf(event).by_super_admin]), [[U.superAdmin, 'proxy', true]]);
    assert.deepStrictEqual(
      await sqlAll("SELECT recipient_user_id FROM sysbuild_send_intents WHERE project_id = ? AND purpose = 'opinion_ready_notice' ORDER BY id", [pid]),
      [{ recipient_user_id: U.pm }]
    );
    // 对照：PM 带截图代录、开发负责人本人评估，都不标管理员代办
    const byPm = await toAssessment();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0sAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), '开发意见截图.png');
    const staged = await upload(U.pm, `/sysbuild/projects/${pid}/attachments/stage`, form);
    assert.strictEqual(staged.status, 200, staged.text);
    const pmAssessed = await act(U.pm, byPm, { ...input, attachment_ids: [staged.body.attachment.id] });
    assert.deepStrictEqual([pmAssessed.status, pmAssessed.body.opinion.assessment_source, pmAssessed.body.opinion.assessment_by_admin], [200, 'proxy', false]);
    const byDev = await toAssessment();
    const devAssessed = await act(U.x2, byDev, input);
    assert.deepStrictEqual([devAssessed.status, devAssessed.body.opinion.assessment_source, devAssessed.body.opinion.assessment_by_admin], [200, 'dev', false]);

    // PM 的另两个动作由平台管理员执行：定去向（生成任务）、写任务结果；普通管理员都被拒
    const outcome = { action: 'dispose', outcome: 'now', text: '补录：线下已议定本期做' };
    denied(await act(U.admin, op, outcome), '普通管理员定去向');
    const adopted = await act(U.superAdmin, op, outcome);
    assert.strictEqual(adopted.status, 200, adopted.text);
    const taskId = adopted.body.opinion.task.id;
    assert.deepStrictEqual(await sqlAll('SELECT resolved_by, outcome FROM sysbuild_opinions WHERE id = ?', [op]), [{ resolved_by: U.superAdmin, outcome: 'now' }]);
    denied(await post(U.admin, `/tasks/${taskId}/result`, { status: 'done' }), '普通管理员写任务结果');
    assert.strictEqual((await post(U.superAdmin, `/tasks/${taskId}/result`, { status: 'done' })).status, 200);
    assert.deepStrictEqual(await sqlAll('SELECT status, resolved_by FROM sysbuild_tasks WHERE id = ?', [taskId]), [{ status: 'done', resolved_by: U.superAdmin }]);

    // 平台管理员接管成为 PM 之后仍按管理员代办评估：不要求截图、标管理员代办、不给自己发待定去向的知会
    const ownPid = await H.newProject();
    const ownDev = await addParty(ownPid, '接管项目的开发组', 'dev');
    const ownLead = await addMember(ownPid, U.x1, { party: ownDev });
    await addDelegation(ownDev, await addMember(ownPid, U.x2, { party: ownDev }), await addAppointment(ownDev, ownLead, 'active'), 'active');
    const ownOpinion = (await post(U.pm, `/projects/${ownPid}/opinions`, { title: '接管前提出的意见', body: '接管前由原 PM 提出并初判。' })).body.opinion.id;
    assert.strictEqual((await act(U.pm, ownOpinion, { action: 'triage', category: 'requirement', decision: 'continue', text: '请开发方评估改动范围' })).body.opinion.status, 'assessment');
    assert.strictEqual((await post(U.superAdmin, `/projects/${ownPid}/pm`, { pm_user_id: U.superAdmin, reason: '核对接管后的代办评估' })).status, 200);
    assert.deepStrictEqual(await assessFlags(U.superAdmin, ownOpinion), [true, 'admin']);
    const ownAssessed = await act(U.superAdmin, ownOpinion, input);
    assert.deepStrictEqual([ownAssessed.status, ownAssessed.body.opinion.assessment_source, ownAssessed.body.opinion.assessment_by_admin], [200, 'proxy', true]);
    assert.deepStrictEqual(await sqlAll("SELECT recipient_user_id FROM sysbuild_send_intents WHERE project_id = ? AND purpose = 'opinion_ready_notice'", [ownPid]), []);

    // 「等我处理」只按本人身份：平台管理员即使是本项目普通成员，也不出现 PM 的待初判
    const waiting = await propose(U.pm);
    await addMember(pid, U.superAdmin);
    assert.ok(await todo(U.pm, waiting), '待初判在 PM 本人的待办里');
    assert.strictEqual(await todo(U.superAdmin, waiting), undefined);
    assert.strictEqual((await detail(U.superAdmin, waiting)).actions.triage, true, '代办权限仍在，只是不算他的待办');
    //   待开发评估同理：在现任开发负责人的待办里，不在平台管理员的待办里，而他的详情页仍给代办动作
    const pendingAssess = await toAssessment();
    assert.ok(await todo(U.x2, pendingAssess), '待评估在开发负责人本人的待办里');
    assert.strictEqual(await todo(U.superAdmin, pendingAssess), undefined);
    assert.deepStrictEqual(await assessFlags(U.superAdmin, pendingAssess), [true, 'admin']);

    // 砍需求表态：平台管理员代办，表态人如实记管理员，读侧与事件标代办
    await H.produceEffectiveOverall(pid, { party: demand });
    const openCut = async () => {
      const created = await post(U.x1, `/projects/${pid}/opinions`, { title: '本期移出一项范围', body: '开发方提出本期移出一项范围。' });
      assert.strictEqual(created.status, 201, created.text);
      const id = created.body.opinion.id;
      const classified = await act(U.pm, id, { action: 'triage', category: 'cut', decision: 'continue', text: '初判合理，请需求方负责人表态' });
      assert.strictEqual(classified.status, 200, classified.text);
      assert.deepStrictEqual(classified.body.opinion.approvals.map((row) => row.party_id), [demand.party]);
      return id;
    };
    const rowOf = async (uid, id) => { const row = (await detail(uid, id)).approvals[0]; return [row.can_decide, row.decide_mode, row.by_admin_proxy]; };
    const decideCut = (uid, id) => (uid === U.superAdmin ? cutProxy(id, demand) : cutDecide(uid, id, demand));
    const first = await openCut();
    assert.deepStrictEqual(await rowOf(U.superAdmin, first), [true, 'admin', false]);
    assert.deepStrictEqual(await rowOf(U.del, first), [true, 'self', false]);
    assert.deepStrictEqual(await rowOf(U.admin, first), [false, null, false]);
    // 代办表单用的「代谁」：只给能代办的人，写明现任负责人与他的授权编号
    assert.deepStrictEqual((await detail(U.superAdmin, first)).approvals[0].proxy_for, { delegation_id: demand.dlg, name: await nameOf(U.del) });
    assert.deepStrictEqual([(await detail(U.del, first)).approvals[0].proxy_for, (await detail(U.admin, first)).approvals[0].proxy_for], [null, null]);
    // 待表态在需求部门负责人本人的待办里，不在平台管理员的待办里（此时他已是本项目普通成员）
    assert.ok(await todo(U.del, first), '待表态在负责人本人的待办里');
    assert.strictEqual(await todo(U.superAdmin, first), undefined);
    denied(await decideCut(U.admin, first), '普通管理员代办表态');
    const agreed = await decideCut(U.superAdmin, first);
    assert.strictEqual(agreed.status, 200, agreed.text);
    assert.deepStrictEqual([agreed.body.opinion.outcome, agreed.body.opinion.approvals.map((row) => [row.status, row.decided_by, row.delegation_id, row.by_admin_proxy])], ['cut_agreed', [['agree', U.superAdmin, demand.dlg, true]]]);
    assert.strictEqual(agreed.body.opinion.outcome_text, '原范围各需求部门均已同意本期移出，其中含管理员代办的表态');
    assert.deepStrictEqual(
      (await eventsOf(pid, 'opinion_cut_decided')).map((event) => [event.operator_id, payloadOf(event).by_super_admin, payloadOf(event).on_behalf_of_user_id]),
      [[U.superAdmin, true, U.del]]
    );
    // 对照：负责人本人表态
    const second = await openCut();
    const own = await decideCut(U.del, second);
    assert.deepStrictEqual([own.status, own.body.opinion.approvals.map((row) => [row.decided_by, row.by_admin_proxy])], [200, [[U.del, false]]]);
    assert.strictEqual(own.body.opinion.outcome_text, '原范围各需求部门负责人均同意本期移出');
    const ownEvent = payloadOf((await eventsOf(pid, 'opinion_cut_decided'))[1]);
    assert.deepStrictEqual([Object.hasOwn(ownEvent, 'by_super_admin'), Object.hasOwn(ownEvent, 'on_behalf_of_user_id')], [false, false]);
    // 该部门没有现任负责人时不能代办，表态行保持待定
    const third = await openCut();
    const revoked = await post(U.pm, `/delegations/${demand.dlg}/revoke`, { reason: '核对没有现任负责人时的代办' });
    assert.strictEqual(revoked.status, 200, revoked.text);
    assert.deepStrictEqual(await rowOf(U.superAdmin, third), [false, null, false]);
    const blocked = await decideCut(U.superAdmin, third);
    expectErr(blocked, 409, 'SYSBUILD_STATE');
    assert.strictEqual(blocked.body.message, '该需求部门当前没有负责人，请先指定人员后再代办表态');
    assert.deepStrictEqual(await sqlAll('SELECT status, decided_by FROM sysbuild_cut_approvals WHERE opinion_id = ?', [third]), [{ status: 'pending', decided_by: null }]);
  });

  test(T_CUT, async () => {
    const pid = await H.newProject();
    const devParty = await addParty(pid, '多部门场景的开发组', 'dev');
    const lead = await addMember(pid, U.x1, { party: devParty });
    await addDelegation(devParty, await addMember(pid, U.x2, { party: devParty }), await addAppointment(devParty, lead, 'active'), 'active');
    const first = await H.seedParty(pid, '原需求部门甲', U.own, U.del);
    const second = await H.seedParty(pid, '原需求部门乙', U.m1, U.m2);
    await H.produceEffectiveOverall(pid);
    const openCut = () => openCutIn(pid, [first, second]);
    const decide = (uid, id, party, decision = 'agree') => (uid === U.superAdmin ? cutProxy(id, party, decision) : cutDecide(uid, id, party, decision));
    const stored = (id) => sqlGet('SELECT status, outcome, outcome_text FROM sysbuild_opinions WHERE id = ?', [id]);
    const rows = (id) => sqlAll('SELECT party_id, status, decided_by FROM sysbuild_cut_approvals WHERE opinion_id = ? ORDER BY party_id', [id]);

    // 代办同意一个部门：只动这一行，另一部门仍待定，意见不结案；另一部门本人同意后结案，结论写明含代办
    const mixed = await openCut();
    assert.strictEqual((await decide(U.superAdmin, mixed, first)).status, 200);
    assert.deepStrictEqual(await rows(mixed), [{ party_id: first.party, status: 'agree', decided_by: U.superAdmin }, { party_id: second.party, status: 'pending', decided_by: null }]);
    assert.deepStrictEqual(await stored(mixed), { status: 'cut_approval', outcome: null, outcome_text: null });
    assert.strictEqual((await decide(U.m2, mixed, second)).status, 200);
    assert.deepStrictEqual(await stored(mixed), { status: 'concluded', outcome: 'cut_agreed', outcome_text: '原范围各需求部门均已同意本期移出，其中含管理员代办的表态' });
    // 对照：两个部门都由负责人本人同意，结论不提代办
    const plain = await openCut();
    assert.strictEqual((await decide(U.del, plain, first)).status, 200);
    assert.strictEqual((await decide(U.m2, plain, second)).status, 200);
    assert.deepStrictEqual(await stored(plain), { status: 'concluded', outcome: 'cut_agreed', outcome_text: '原范围各需求部门负责人均同意本期移出' });
    // 代办不同意且没写说明：结论写明是管理员代办的表态；负责人本人不同意时仍是原文案
    const refusedByAdmin = await openCut();
    assert.strictEqual((await decide(U.superAdmin, refusedByAdmin, second, 'object')).status, 200);
    assert.deepStrictEqual(await stored(refusedByAdmin), { status: 'concluded', outcome: 'scope_kept', outcome_text: '管理员代办表态：不同意，维持原范围' });
    assert.deepStrictEqual(await rows(refusedByAdmin), [{ party_id: first.party, status: 'pending', decided_by: null }, { party_id: second.party, status: 'object', decided_by: U.superAdmin }]);
    const refusedByOwner = await openCut();
    assert.strictEqual((await decide(U.m2, refusedByOwner, second, 'object')).status, 200);
    assert.deepStrictEqual(await stored(refusedByOwner), { status: 'concluded', outcome: 'scope_kept', outcome_text: '需求方负责人不同意，维持原范围' });
    // 写了说明的不同意：代办的结论仍带代办标识，本人的结论就是他写的说明
    const explainedByAdmin = await openCut();
    assert.strictEqual((await cutProxy(explainedByAdmin, first, 'object', { text: '线下会议已否决' })).status, 200);
    assert.strictEqual((await stored(explainedByAdmin)).outcome_text, '管理员代办表态：不同意，说明：线下会议已否决');
    const explainedByOwner = await openCut();
    assert.strictEqual((await cutDecide(U.del, explainedByOwner, first, 'object', { text: '线下会议已否决' })).status, 200);
    assert.strictEqual((await stored(explainedByOwner)).outcome_text, '线下会议已否决');

    // 代办须带回代办对象；期间换了负责人就拒绝，重新打开看到新负责人后才能代办
    const swapping = await openCut();
    const missing = await cutDecide(U.superAdmin, swapping, second);
    expectErr(missing, 400, 'SYSBUILD_INVALID_INPUT', '代办没带代办对象');
    assert.strictEqual(missing.body.field, 'expected_delegation_id');
    const changed = await api(U.pm, 'PUT', `/sysbuild/parties/${second.party}/people`, {
      leader_user_id: U.m1, representative_user_id: U.cand2, expected_appointment_id: second.apt, expected_delegation_id: second.dlg, reason: '核对代办期间换负责人',
    });
    assert.strictEqual(changed.status, 200, changed.text);
    const stale = await cutProxy(swapping, second);
    expectErr(stale, 409, 'SYSBUILD_STATE', '用换人前的代办对象提交');
    assert.strictEqual(stale.body.message, '该需求部门的负责人已变更，请重新打开后核对代办对象');
    assert.deepStrictEqual((await rows(swapping))[1], { party_id: second.party, status: 'pending', decided_by: null });
    const now = (await opinionOf(U.superAdmin, swapping)).approvals[1].proxy_for;
    assert.deepStrictEqual([now.delegation_id !== second.dlg, now.name], [true, await nameOf(U.cand2)]);
    assert.strictEqual((await cutDecide(U.superAdmin, swapping, second, 'agree', { expected_delegation_id: now.delegation_id })).status, 200);
    assert.deepStrictEqual((await rows(swapping))[1], { party_id: second.party, status: 'agree', decided_by: U.superAdmin });
    const lastEvent = (await eventsOf(pid, 'opinion_cut_decided')).pop();
    assert.deepStrictEqual([payloadOf(lastEvent).by_super_admin, payloadOf(lastEvent).on_behalf_of_user_id], [true, U.cand2]);
  });

  test(T_SELF, async () => {
    // 平台管理员本人就是现任开发负责人：评估按本人记（不是代办），照常知会 PM
    const devPid = await H.newProject();
    const devDelegation = await seedDev(devPid, U.superAdmin);
    const opinion = (await post(U.pm, `/projects/${devPid}/opinions`, { title: '本人评估的意见', body: '由开发负责人本人评估。' })).body.opinion.id;
    assert.strictEqual((await act(U.pm, opinion, { action: 'triage', category: 'requirement', decision: 'continue', text: '请开发方评估改动范围' })).body.opinion.status, 'assessment');
    const before = await opinionOf(U.superAdmin, opinion);
    assert.deepStrictEqual([before.actions.assess, before.actions.assess_mode], [true, 'dev']);
    const selfInput = { action: 'assess', text: '开发负责人本人的评估', estimated_hours: 3 };
    // 带着「管理员代办」的旧表单提交（比如打开代办表单之后才被任命为开发负责人）：登记方式已变，拒绝
    expectErr(await act(U.superAdmin, opinion, { ...selfInput, expected_mode: 'admin' }), 409, 'SYSBUILD_STATE', '本人已是开发负责人却按代办提交');
    const assessed = await act(U.superAdmin, opinion, { ...selfInput, expected_mode: 'dev' });
    assert.strictEqual(assessed.status, 200, assessed.text);
    assert.deepStrictEqual(
      [assessed.body.opinion.assessment_source, assessed.body.opinion.assessed_by, assessed.body.opinion.assessed_for_delegation_id, assessed.body.opinion.assessment_by_admin],
      ['dev', U.superAdmin, devDelegation, false]
    );
    const assessedEvents = await eventsOf(devPid, 'opinion_assessed');
    assert.deepStrictEqual(assessedEvents.map((item) => [item.operator_id, payloadOf(item).source, Object.hasOwn(payloadOf(item), 'by_super_admin')]), [[U.superAdmin, 'dev', false]]);
    assert.deepStrictEqual(await sqlAll("SELECT recipient_user_id FROM sysbuild_send_intents WHERE project_id = ? AND purpose = 'opinion_ready_notice'", [devPid]), [{ recipient_user_id: U.pm }]);

    // 平台管理员本人就是需求部门现任负责人：表态按本人记，不给代办对象、不标代办
    const pid = await H.newProject();
    await seedDev(pid);
    const mine = await H.seedParty(pid, '本人负责的需求部门', U.own, U.superAdmin);
    await H.produceEffectiveOverall(pid);
    const cut = await openCutIn(pid, [mine]);
    const row = (await opinionOf(U.superAdmin, cut)).approvals[0];
    assert.deepStrictEqual([row.can_decide, row.decide_mode, row.proxy_for], [true, 'self', null]);
    // 带着代办对象提交（比如打开代办表单之后才被任命为负责人）：不按本人表态收下，要求重新打开
    const staleProxy = await cutProxy(cut, mine);
    expectErr(staleProxy, 409, 'SYSBUILD_STATE', '本人已是负责人却带着代办对象');
    assert.deepStrictEqual(await sqlAll('SELECT status, decided_by FROM sysbuild_cut_approvals WHERE opinion_id = ?', [cut]), [{ status: 'pending', decided_by: null }]);
    const decided = await cutDecide(U.superAdmin, cut, mine);
    assert.strictEqual(decided.status, 200, decided.text);
    assert.deepStrictEqual(decided.body.opinion.approvals.map((item) => [item.status, item.decided_by, item.delegation_id, item.by_admin_proxy]), [['agree', U.superAdmin, mine.dlg, false]]);
    assert.strictEqual(decided.body.opinion.outcome_text, '原范围各需求部门负责人均同意本期移出');
    const cutEvents = await eventsOf(pid, 'opinion_cut_decided');
    assert.deepStrictEqual(cutEvents.map((item) => [item.operator_id, Object.hasOwn(payloadOf(item), 'by_super_admin'), Object.hasOwn(payloadOf(item), 'on_behalf_of_user_id')]), [[U.superAdmin, false, false]]);
  });

  test(T_RO, async () => {
    // 平台管理员同时在只读名单里：只读一票否决，PM 的动作与三类代办经真实端点都被拒。只读名单是服务端常量，只有进程内夹具能临时改。
    const kit = T.getReadonlyKit();
    if (!kit) return T.skip;
    const waiting = await submitInitiation();
    const nodes = await nodesOf(waiting.pid);
    const pid = await H.newProject();
    await seedDev(pid);
    const demand = await H.seedParty(pid, '只读场景的需求部门', U.own, U.del);
    await H.produceEffectiveOverall(pid);
    const cut = await openCutIn(pid, [demand]);
    const assessing = (await post(U.pm, `/projects/${pid}/opinions`, { title: '只读场景的意见', body: '待开发评估。' })).body.opinion.id;
    assert.strictEqual((await act(U.pm, assessing, { action: 'triage', category: 'requirement', decision: 'continue', text: '请开发方评估改动范围' })).body.opinion.status, 'assessment');
    const body = H.decideBodyOf((await H.openTask(U.pm, waiting.task.task_id)).body, 'confirm');
    const goalOf = async () => (await sqlGet('SELECT goal FROM sysbuild_projects WHERE id = ?', [waiting.pid])).goal;
    const versionCount = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_material_versions v JOIN sysbuild_materials m ON m.id = v.material_id WHERE m.node_id = ?', [nodes.p_initiation.id])).n;
    const edit = { goal: '只读场景：移出名单后才应写入' };
    const material = { body: '只读场景：移出名单后才应上传' };
    const assessment = { action: 'assess', text: '只读场景：移出名单后才应评估', estimated_hours: 1 };
    const [goalBefore, versionsBefore] = [await goalOf(), await versionCount()];
    kit.add(U.superAdmin);
    try {
      const me = (await get(U.superAdmin, `/projects/${waiting.pid}`)).body;
      assert.deepStrictEqual([me.me.is_super_admin, me.me.is_readonly, me.actions.edit_basics, me.actions.add_member], [true, true, false, false]);
      denied(await api(U.superAdmin, 'PATCH', `/sysbuild/projects/${waiting.pid}`, edit), '只读的平台管理员改基本信息');
      denied(await post(U.superAdmin, `/nodes/${nodes.p_initiation.id}/materials/initiation-basis/versions`, material), '只读的平台管理员上传材料');
      assert.deepStrictEqual([await goalOf(), await versionCount()], [goalBefore, versionsBefore], '被拒的请求没有写入');
      const opened = await H.openTask(U.superAdmin, waiting.task.task_id);
      assert.deepStrictEqual([opened.body.actions.decide, opened.body.actions.decide_mode], [false, null]);
      assert.deepStrictEqual(await viewersOf(waiting.pv), [], '只读的平台管理员打开不留浏览记录');
      denied(await H.decideRaw(U.superAdmin, waiting.task.task_id, body), '只读的平台管理员代办确认');
      assert.deepStrictEqual(await confirmationsOf(waiting.pv), []);
      assert.deepStrictEqual([(await opinionOf(U.superAdmin, cut)).approvals[0].can_decide, (await opinionOf(U.superAdmin, assessing)).actions.assess], [false, false]);
      denied(await cutProxy(cut, demand), '只读的平台管理员代办表态');
      denied(await act(U.superAdmin, assessing, assessment), '只读的平台管理员代办评估');
      assert.deepStrictEqual(await sqlAll('SELECT status FROM sysbuild_cut_approvals WHERE opinion_id = ?', [cut]), [{ status: 'pending' }]);
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_opinions WHERE id = ?', [assessing])).status, 'assessment');
    } finally {
      kit.remove(U.superAdmin);
    }
    // 对照：移出只读名单后，同样的五个请求都能做并落库（证明上面被拒是因为只读，不是别的前置）
    assert.strictEqual((await api(U.superAdmin, 'PATCH', `/sysbuild/projects/${waiting.pid}`, edit)).status, 200);
    assert.strictEqual((await post(U.superAdmin, `/nodes/${nodes.p_initiation.id}/materials/initiation-basis/versions`, material)).status, 201);
    assert.deepStrictEqual([await goalOf(), await versionCount()], [edit.goal, versionsBefore + 1]);
    const reopened = await H.openTask(U.superAdmin, waiting.task.task_id);
    assert.strictEqual(reopened.body.actions.decide, true);
    assert.strictEqual((await H.decideRaw(U.superAdmin, waiting.task.task_id, H.decideBodyOf(reopened.body, 'confirm'))).status, 200);
    assert.deepStrictEqual(await confirmationsOf(waiting.pv), [{ actor_user_id: U.superAdmin, decision: 'confirm' }]);
    assert.strictEqual((await cutProxy(cut, demand)).status, 200);
    assert.strictEqual((await act(U.superAdmin, assessing, assessment)).status, 200);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_opinions WHERE id = ?', [assessing])).status, 'disposition');
  });
}

const mutation = (id, expect, file, from, to) => ({ id: '平台管理员 ' + id, expect: Array.isArray(expect) ? expect : [expect], edits: [{ file, from, to }] });
const SUPER_ADMIN_MUTATIONS = [
  mutation('名单多出一个 admin 账号', [T_PM, T_GATE], 'rules.js', 'const SUPER_ADMIN_USER_IDS = Object.freeze([1]);', 'const SUPER_ADMIN_USER_IDS = Object.freeze([1, 2]);'),
  mutation('所有 admin 角色都算平台管理员', [T_PM, T_GATE], 'rules.js', 'const marked = isAdmin && isSuperAdminUser(user);', 'const marked = isAdmin;'),
  mutation('不按库里此刻的角色与状态再核', T_GATE, 'rules.js', "const isSuper = marked && !!live && live.role === 'admin' && live.status === 'active';", 'const isSuper = marked;'),
  mutation('库里已停用的账号仍算平台管理员', T_GATE, 'rules.js', "const isSuper = marked && !!live && live.role === 'admin' && live.status === 'active';", "const isSuper = marked && !!live && live.role === 'admin';"),
  mutation('库里查不到账号仍算平台管理员', T_GATE, 'rules.js', "const isSuper = marked && !!live && live.role === 'admin' && live.status === 'active';", "const isSuper = marked && (!live || (live.role === 'admin' && live.status === 'active'));"),
  // 平台角色有两层核对：标记中间件登记前查一次，loadProjectAccess 读身份时再查一次（isAdmin &&）。
  //   只去掉中间件那层：由「经过中间件时不是 admin、之后角色变成 admin」的断言判红；只去掉读身份那层：由「标记之后角色被改掉」的断言判红（下面的「标记后不再核对角色」）。
  mutation('标记不查平台角色', T_GATE, 'rules.js', "user.role === 'admin' && Number.isSafeInteger(user.id) && allowed.has(user.id)", 'Number.isSafeInteger(user.id) && allowed.has(user.id)'),
  { id: '平台管理员 标记与身份读取都不查平台角色', expect: [T_GATE], edits: [
    { file: 'rules.js', from: "user.role === 'admin' && Number.isSafeInteger(user.id) && allowed.has(user.id)", to: 'Number.isSafeInteger(user.id) && allowed.has(user.id)' },
    { file: 'rules.js', from: 'const marked = isAdmin && isSuperAdminUser(user);', to: 'const marked = isSuperAdminUser(user);' },
  ] },
  mutation('标记把编号强转成数字', T_GATE, 'rules.js', 'Number.isSafeInteger(user.id) && allowed.has(user.id)) SUPER_ADMIN_USERS.add(user);', 'allowed.has(Number(user.id))) SUPER_ADMIN_USERS.add(user);'),
  mutation('标记后不再核对角色', T_GATE, 'rules.js', 'const marked = isAdmin && isSuperAdminUser(user);', 'const marked = isSuperAdminUser(user);'),
  mutation('名单参数不校验', T_GATE, 'rules.js', 'if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw', 'if (false) throw'),
  mutation('平台管理员不能做 PM 的动作', T_PM, 'rules.js', '  if (identity.isReadonly) return false;\n  return !!(identity.isPm || identity.isSuper === true);', '  if (identity.isReadonly) return false;\n  return !!identity.isPm;'),
  mutation('代办没有只读否决', [T_GATE, T_RO], 'rules.js', 'return !!(identity.isSuper === true && !identity.isReadonly);', 'return identity.isSuper === true;'),
  mutation('做 PM 的动作时只读否决不管平台管理员', [T_GATE, T_RO], 'rules.js', '  if (identity.isReadonly) return false;\n  return !!(identity.isPm || identity.isSuper === true);', '  if (identity.isReadonly && identity.isSuper !== true) return false;\n  return !!(identity.isPm || identity.isSuper === true);'),
  mutation('PM 也能代办确认', [T_CONFIRM, T_GATE], 'rules.js', 't.isRequired === true || canProxyAsSuperAdmin(identity),', 't.isRequired === true || canProxyAsSuperAdmin(identity) || identity.isPm === true,'),
  mutation('普通管理员也能代办确认', [T_CONFIRM, T_GATE], 'rules.js', 't.isRequired === true || canProxyAsSuperAdmin(identity),', 't.isRequired === true || canProxyAsSuperAdmin(identity) || (identity.isAdmin && !identity.isReadonly),'),
  mutation('代办确认被去掉', [T_CONFIRM, T_GATE], 'rules.js', 't.isRequired === true || canProxyAsSuperAdmin(identity),', 't.isRequired === true,'),
  mutation('平台管理员打开不写浏览记录', T_CONFIRM, 'confirm.js', "c.latest.status === 'pending' : rules.opAllowed('confirm_decide', c.access, c.access.project, target);", "c.latest.status === 'pending' : false;"),
  mutation('不能代办时打开也写浏览记录', T_CONFIRM, 'confirm.js', "c.latest.status === 'pending' : rules.opAllowed('confirm_decide', c.access, c.access.project, target);", "c.latest.status === 'pending' : rules.canProxyAsSuperAdmin(c.access) && c.latest.status === 'pending';"),
  mutation('浏览记录不核对操作人', T_CONFIRM, 'confirm.js', "'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_type = ? AND object_version_id = ? AND opened_at >= ? ORDER BY id DESC LIMIT 1',\n        [uid, c.task.object_type,", "'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE object_type = ? AND object_version_id = ? AND opened_at >= ? ORDER BY id DESC LIMIT 1',\n        [c.task.object_type,"),
  mutation('代办的浏览记录不设时间下限', T_CONFIRM, 'confirm.js', "'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_type = ? AND object_version_id = ? AND opened_at >= ? ORDER BY id DESC LIMIT 1',\n        [uid, c.task.object_type, c.task.object_version_id, c.latest.created_at]", "'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_type = ? AND object_version_id = ? ORDER BY id DESC LIMIT 1',\n        [uid, c.task.object_type, c.task.object_version_id]"),
  mutation('知会去重按被代办的人', T_CONFIRM, 'confirm.js', 'refId: c.latest.id, actorUserId: Number(user.id) });', 'refId: c.latest.id, actorUserId: c.requiredUserId });'),
  mutation('代办的异议不知会 PM', T_CONFIRM, 'confirm.js', "if (decision !== 'confirm') {\n      await notifyCore.enqueuePmIntent(", "if (decision !== 'confirm' && c.requiredUserId === Number(user.id)) {\n      await notifyCore.enqueuePmIntent("),
  mutation('代办确认的事件不记代办', T_CONFIRM, 'confirm.js', "...(proxied ? { by_super_admin: true, on_behalf_of_user_id: c.requiredUserId } : {}),", ''),
  mutation('本人确认也记成代办', T_CONFIRM, 'confirm.js', 'const proxied = c.requiredUserId !== uid;', 'const proxied = true;'),
  mutation('读侧代办标识恒假', T_CONFIRM, 'confirm-core.js', 'return Number(row.actor_user_id) !== Number(row.required_user_id);', 'return false;'),
  mutation('读侧代办标识恒真', T_CONFIRM, 'confirm-core.js', 'return Number(row.actor_user_id) !== Number(row.required_user_id);', 'return true;'),
  mutation('确认页方式标志不区分代办', T_CONFIRM, 'confirm.js', "body.actions.decide_mode = target.isRequired ? 'self' : 'admin';", "body.actions.decide_mode = 'self';"),
  mutation('确认单不标代办', T_CONFIRM, 'confirmation-sheet.js', "${c.by_admin_proxy === true ? '（管理员代办）' : ''}", ''),
  mutation('确认单全部标代办', T_CONFIRM, 'confirmation-sheet.js', "c.by_admin_proxy === true ? '（管理员代办）' : ''", "'（管理员代办）'"),
  mutation('身份卡不报平台管理员', T_PM, 'projects.js', 'is_super_admin: identity.isSuper === true,', 'is_super_admin: false,'),
  mutation('来源方第一项不按身份写', T_PM, 'entries.js', "label: identity.isPm === true ? 'PM 本人登记' : '管理员本人登记'", "label: 'PM 本人登记'"),
  mutation('代办评估仍要截图', T_WORK, 'work.js', "if (mode === 'proxy') await verifyScreenshot(q, bound);", "if (mode !== 'dev') await verifyScreenshot(q, bound);"),
  mutation('代办评估记成开发本人', T_WORK, 'work.js', "  if (rules.canProxyAsSuperAdmin(identity) && !target.isDevResponsible) return 'admin';\n", ''),
  mutation('兼任 PM 时按 PM 代录', T_WORK, 'work.js', "  if (rules.canProxyAsSuperAdmin(identity) && !target.isDevResponsible) return 'admin';\n  if (identity.isPm) return 'proxy';", "  if (identity.isPm) return 'proxy';\n  if (rules.canProxyAsSuperAdmin(identity) && !target.isDevResponsible) return 'admin';"),
  mutation('兼任 PM 时评估后知会自己', T_WORK, 'work.js', 'if (!identity.isPm) await workNotify.afterDeveloperAssessment', "if (mode !== 'proxy') await workNotify.afterDeveloperAssessment"),
  mutation('评估不核对打开表单时的登记方式', [T_WORK, T_SELF], 'work.js', 'if (input.expectedMode !== null && input.expectedMode !== mode) throw invalidState(', 'if (false) throw invalidState('),
  mutation('评估的登记方式不校验取值', T_WORK, 'work.js', "if (expectedMode !== null && !['dev', 'proxy', 'admin'].includes(expectedMode)) throw invalid('评估的登记方式不合法', 'expected_mode');", ''),
  mutation('代办评估事件不记代办', T_WORK, 'work.js', "...(mode === 'admin' ? { by_super_admin: true } : {}),", ''),
  mutation('代办评估后不告知 PM', T_WORK, 'work.js', 'if (!identity.isPm) await workNotify.afterDeveloperAssessment', "if (mode === 'dev') await workNotify.afterDeveloperAssessment"),
  mutation('代办不同意的结论写成负责人', T_CUT, 'work.js', "proxied ? proxyText : (input.text || '需求方负责人不同意，维持原范围')", "(input.text || '需求方负责人不同意，维持原范围')"),
  mutation('本人不同意的结论写成代办', T_CUT, 'work.js', "proxied ? proxyText : (input.text || '需求方负责人不同意，维持原范围')", 'proxyText'),
  mutation('代办写了说明的不同意不带标识', T_CUT, 'work.js', "proxied ? proxyText : (input.text || '需求方负责人不同意，维持原范围')", "proxied && !input.text ? proxyText : (input.text || '需求方负责人不同意，维持原范围')"),
  mutation('代办表态不核对代办对象', T_CUT, 'work.js', 'if (input.expectedDelegationId !== approval.responsible.delegationId) throw invalidState(', 'if (false) throw invalidState('),
  mutation('缺少代办对象误报为负责人变更', T_CUT, 'work.js', "if (input.expectedDelegationId === null) throw invalid('代办表态须带代办对象', 'expected_delegation_id');", ''),
  { id: '平台管理员 缺少代办对象被放行', expect: [T_CUT], edits: [
    { file: 'work.js', from: "if (input.expectedDelegationId === null) throw invalid('代办表态须带代办对象', 'expected_delegation_id');", to: '' },
    { file: 'work.js', from: 'if (input.expectedDelegationId !== approval.responsible.delegationId) throw invalidState(', to: 'if (input.expectedDelegationId !== null && input.expectedDelegationId !== approval.responsible.delegationId) throw invalidState(' },
  ] },
  mutation('本人带着代办对象也按本人表态收下', T_SELF, 'work.js', "} else if (input.expectedDelegationId !== null) {\n      throw invalidState('该需求部门的负责人已变更，请重新打开后核对代办对象');\n    }", '}'),
  mutation('本人表态也给代办对象', T_SELF, 'work.js', "row.proxy_for = row.decide_mode === 'admin'", 'row.proxy_for = row.decide_mode !== null'),
  // 替换值取「正确编号 + 1」：必然与正确值不同（用部门编号之类的别的列，在夹具里可能恰好同值，2026-11-27 自检实测）。
  mutation('代办对象的授权编号给错', [T_WORK, T_CUT], 'work.js', '? { delegation_id: responsible.delegationId, name:', '? { delegation_id: responsible.delegationId + 1, name:'),
  mutation('只读 PM 不给发送失败条数', T_PM, 'projects.js', 'if (identity.isPm === true || rules.canActAsPm(identity)) detail.notify =', 'if (rules.canActAsPm(identity)) detail.notify ='),
  mutation('只读 PM 不给来源选项', T_PM, 'entries.js', 'const sources = identity.isPm === true || rules.canActAsPm(identity) ?', 'const sources = rules.canActAsPm(identity) ?'),
  mutation('平台管理员不能带来源方代登', T_PM, 'entries.js', "if (!rules.canActAsPm(identity)) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');", "if (identity.isPm !== true) throw invalid('只有项目经理代登时可以填写来源方', 'source_party_id');"),
  mutation('本人是开发负责人也记成管理员代办', T_SELF, 'work.js', 'if (rules.canProxyAsSuperAdmin(identity) && !target.isDevResponsible) return', 'if (rules.canProxyAsSuperAdmin(identity)) return'),
  mutation('含代办的全部同意写成负责人均同意', [T_CUT, T_WORK], 'work.js', "anyProxy ? '原范围各需求部门均已同意本期移出，其中含管理员代办的表态' : ", ''),
  mutation('只看最后一行是否代办', T_CUT, 'work.js', 'anyProxy = (await cutDecidedByProxy(q, row)) || anyProxy;', 'anyProxy = await cutDecidedByProxy(q, row);'),
  mutation('代办同意一个部门就结案', T_CUT, 'work.js', "if (approvals.length === 0 || !approvals.every((row) => row.status === 'agree')) return;", "if (approvals.length === 0 || (!proxied && !approvals.every((row) => row.status === 'agree'))) return;"),
  mutation('PM 代录也标管理员代办', T_WORK, 'work.js', "assessmentByAdmin = !!event && JSON.parse(event.payload_json)?.by_super_admin === true;", 'assessmentByAdmin = !!event;'),
  mutation('代办权限算进本人待办', T_WORK, 'work-notify.js', 'const identity = { ...access, isSuper: false, userId: uid };', 'const identity = { ...access, userId: uid };'),
  mutation('普通管理员也能代办表态', [T_WORK, T_GATE], 'rules.js', 't.isCutResponsible === true || canProxyAsSuperAdmin(identity),', 't.isCutResponsible === true || canProxyAsSuperAdmin(identity) || (identity.isAdmin && !identity.isReadonly),'),
  mutation('代办表态不查现任负责人', T_GATE, 'rules.js', "if (t.isCutResponsible !== true && t.hasCutResponsible !== true) return '该需求部门当前没有负责人，请先指定人员后再代办表态';", ''),
  mutation('现任负责人事实恒真', T_WORK, 'work.js', 'hasCutResponsible: !!approval?.responsible,', 'hasCutResponsible: true,'),
  mutation('代办表态的事件不记代办', T_WORK, 'work.js', '...(proxied ? { by_super_admin: true, on_behalf_of_user_id: approval.responsible.userId } : {}),', ''),
  mutation('表态读侧代办标识恒假', T_WORK, 'work.js', 'return !!holder && holder.user_id !== null && Number(holder.user_id) !== Number(row.decided_by);', 'return false;'),
  mutation('表态方式标志不区分代办', T_WORK, 'work.js', "(responsible?.userId === context.identity.userId ? 'self' : 'admin')", "'self'"),
];

module.exports = { defineSuperAdminCases, SUPER_ADMIN_MUTATIONS };
