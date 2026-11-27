'use strict';

const assert = require('node:assert/strict');

const PROPOSE = 'B5.1 项目成员意见与阶段挂靠';
const TRIAGE = 'B5.1 初判评估、免评估与开发本人提议';
const PROXY = 'B5.1 代填真实截图和评估事务';
const DISPOSE = 'B5.2 意见去向、任务与范围调整';
const CUT = 'B5.2 砍需求本人多部门同意';
const CLOSE = 'B5.2 结项两处未结事项与并发';
const NOTICES = 'B5.3 知悉、本人待办和任务结果';
const RETRY = 'B5.3 知悉停用、恢复补发与过期扫描';

function defineWorkCases({ test, U, api, upload, sqlAll, sqlGet, sqlRun, addParty, addMember, addAppointment, addDelegation, expectErr, getKit, skip, confirm: H }) {
  const get = (user, tail) => api(user, 'GET', '/sysbuild' + tail);
  const post = (user, tail, body = {}) => api(user, 'POST', '/sysbuild' + tail, body);
  const listPath = (pid) => '/projects/' + pid + '/opinions';
  const detailPath = (id) => '/opinions/' + id;
  const request = { title: '增加批次联调反馈', body: '请记录接口联调发现的内容与预期结果。' };
  const propose = (user, pid, extra) => post(user, listPath(pid), { ...request, ...extra });
  const act = (user, id, body) => post(user, detailPath(id) + '/actions', body);
  const triage = (id, extra) => act(U.pm, id, { action: 'triage', category: 'requirement', decision: 'continue', text: '请核接口和报表的改动范围', ...extra });
  async function listedOpinion(pid, id) {
    const result = await get(U.pm, listPath(pid));
    assert.strictEqual(result.status, 200, result.text);
    const opinion = result.body.opinions.find((row) => row.id === id);
    assert.ok(opinion, '列表含对应意见');
    return opinion;
  }
  const personName = async (id) => (await sqlGet('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [id])).name;
  async function seedDev(pid) {
    const party = await addParty(pid, '开发组', 'dev');
    const leader = await addMember(pid, U.x1, { party });
    const responsible = await addMember(pid, U.x2, { party });
    const apt = await addAppointment(party, leader, 'active');
    const delegation = await addDelegation(party, responsible, apt, 'active');
    return { party, delegation, appointment: apt };
  }
  async function stageImage(projectId) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0sAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), '开发意见截图.png');
    const response = await upload(U.pm, '/sysbuild/projects/' + projectId + '/attachments/stage', form);
    assert.strictEqual(response.status, 200, response.text);
    return response.body.attachment.id;
  }
  const stored = (id) => sqlGet('SELECT * FROM sysbuild_opinions WHERE id=?', [id]);

  test(PROPOSE, async () => {
    const pid = await H.newProject();
    const mem = await addMember(pid, U.m1);
    let res = await propose(U.m1, pid);
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual([res.body.opinion.node_id, res.body.opinion.author_side, res.body.opinion.status], [null, 'internal', 'triage']);
    assert.strictEqual((await propose(U.admin, pid)).status, 201, '管理员无需先成为成员');
    expectErr(await propose(U.ro, pid), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await propose(U.out, pid), 404, 'SYSBUILD_NOT_FOUND');
    expectErr(await propose(U.pm, pid, { node_id: 1 }), 400, 'SYSBUILD_INVALID_INPUT');
    const nodes = (await get(U.pm, '/projects/' + pid + '/plan')).body.nodes;
    const initiation = nodes.find((n) => n.template_key === 'p_initiation').id;
    const closing = nodes.find((n) => n.template_key === 'p_closing').id;
    const dev = nodes.find((n) => n.template_key === 'b_dev').id;
    assert.strictEqual((await post(U.pm, '/nodes/' + initiation + '/start')).status, 200);
    assert.strictEqual((await post(U.pm, '/nodes/' + dev + '/start')).status, 200);
    assert.strictEqual((await post(U.pm, '/nodes/' + closing + '/start')).status, 200);
    const other = await H.newProject();
    const foreign = await H.stageAtt(other, U.pm, 'a');
    const blocked = await propose(U.pm, pid, { attachment_ids: [foreign] });
    expectErr(blocked, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(blocked.body.field, 'attachment_ids');
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_opinions WHERE project_id=?', [pid])).length, 2);
    const att = await H.stageAtt(pid, U.m1, 'd');
    res = await propose(U.m1, pid, { attachment_ids: [att] });
    assert.strictEqual(res.status, 201, res.text);
    const created = res.body.opinion;
    assert.strictEqual(created.node_id, dev, '项目层较后阶段与批次阶段并行时，挂到展示次序的最后一条');
    assert.deepStrictEqual(created.attachments.map((item) => item.attachment_id), [att]);
    assert.deepStrictEqual((await sqlGet('SELECT owner_type,owner_id FROM sysbuild_attachment_bindings WHERE attachment_id=?', [att])), { owner_type: 'opinion', owner_id: created.id });
    assert.strictEqual((await get(U.ro, listPath(pid))).body.actions.create, false);
    assert.strictEqual((await get(U.out, detailPath(created.id))).status, 404);
    const removed = await post(U.pm, '/members/' + mem + '/remove', { reason: '该成员已调离项目' });
    assert.strictEqual(removed.status, 200, removed.text);
    expectErr(await propose(U.m1, pid), 404, 'SYSBUILD_NOT_FOUND');
    const paused = await post(U.admin, '/projects/' + pid + '/status', { to: 'paused', reason: '保留意见登记的场景' });
    assert.strictEqual(paused.status, 200, paused.text);
    assert.strictEqual((await propose(U.pm, pid)).status, 201);
    const ended = await post(U.admin, '/projects/' + pid + '/status', { to: 'terminated', reason: '保持归档项目读侧' });
    assert.strictEqual(ended.status, 200, ended.text);
    expectErr(await propose(U.pm, pid), 409, 'SYSBUILD_PROJECT_READONLY');
  });

  test(TRIAGE, async () => {
    const pid = await H.newProject();
    const dev = await seedDev(pid);
    assert.strictEqual((await get(U.x2, listPath(pid))).body.actions.self_assess, true);
    const missing = await propose(U.x2, pid);
    expectErr(missing, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(missing.body.field, 'estimated_hours');
    expectErr(await propose(U.x1, pid, { estimated_hours: 3 }), 400, 'SYSBUILD_INVALID_INPUT', '开发方领导不代填本人提议工时');
    const personal = await propose(U.x2, pid, { estimated_hours: 0 });
    assert.strictEqual(personal.status, 201, personal.text);
    const self = personal.body.opinion;
    assert.deepStrictEqual([self.assessment_source, self.assessment_text, self.assessment_hours, self.assessed_for_delegation_id], ['self', request.body, 0, dev.delegation]);
    const next = await triage(self.id);
    assert.strictEqual(next.status, 200, next.text);
    assert.strictEqual(next.body.opinion.status, 'disposition');
    const opinion = (await propose(U.pm, pid)).body.opinion;
    assert.deepStrictEqual((await listedOpinion(pid, opinion.id)).waiting_for, { role: 'pm', name: await personName(U.pm) });
    const rejected = await triage(opinion.id, { needs_assessment: false });
    expectErr(rejected, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(rejected.body.field, 'skip_reason');
    assert.strictEqual((await stored(opinion.id)).status, 'triage');
    const bypass = await triage(opinion.id, { needs_assessment: false, skip_reason: '此条指出已确认文案的标点，无开发工作' });
    assert.strictEqual(bypass.status, 200, bypass.text);
    assert.deepStrictEqual([bypass.body.opinion.status, bypass.body.opinion.needs_assessment], ['disposition', 0]);
    const early = (await propose(U.pm, pid)).body.opinion;
    const no = await triage(early.id, { decision: 'no', text: '本项目现有功能已经覆盖此次意见' });
    assert.strictEqual(no.status, 200, no.text);
    assert.deepStrictEqual([no.body.opinion.status, no.body.opinion.outcome, no.body.opinion.outcome_text], ['concluded', 'no', '本项目现有功能已经覆盖此次意见']);
    const ended = await listedOpinion(pid, early.id);
    assert.deepStrictEqual([ended.is_pending, ended.waiting_for], [false, null]);
    const real = (await propose(U.pm, pid)).body.opinion;
    expectErr(await act(U.admin, real.id, { action: 'triage', category: 'problem', decision: 'continue', text: '普通管理员无 PM 资格' }), 403, 'SYSBUILD_FORBIDDEN');
    assert.strictEqual((await triage(real.id)).body.opinion.status, 'assessment');
    const waitDev = await listedOpinion(pid, real.id);
    assert.deepStrictEqual([waitDev.is_pending, waitDev.waiting_for], [true, { role: 'developer', name: await personName(U.x2) }]);
    assert.strictEqual((await get(U.x1, detailPath(real.id))).body.opinion.actions.assess_mode, null);
    assert.strictEqual((await get(U.x2, detailPath(real.id))).body.opinion.actions.assess_mode, 'dev');
    assert.strictEqual((await get(U.pm, detailPath(real.id))).body.opinion.actions.assess_mode, 'proxy');
    const assessment = { action: 'assess', text: '不牵涉核心改动，建议先检查接口入参', estimated_hours: 1.25 };
    expectErr(await act(U.x1, real.id, assessment), 403, 'SYSBUILD_FORBIDDEN');
    const parallel = await Promise.all([act(U.x2, real.id, assessment), act(U.x2, real.id, assessment)]);
    assert.deepStrictEqual(parallel.map((r) => r.status).sort(), [200, 409]);
    assert.deepStrictEqual([(await stored(real.id)).assessment_source, (await stored(real.id)).assessment_hours], ['dev', 1.25]);
    assert.deepStrictEqual((await listedOpinion(pid, real.id)).waiting_for, { role: 'pm', name: await personName(U.pm) });
    assert.strictEqual((await sqlAll("SELECT id FROM sysbuild_events WHERE project_id=? AND object_type='opinion' AND object_id=? AND event_type='opinion_assessed'", [pid, real.id])).length, 1);
  });

  test(PROXY, async () => {
    const pid = await H.newProject();
    const dev = await seedDev(pid);
    const op = (await propose(U.pm, pid)).body.opinion;
    assert.strictEqual((await triage(op.id)).body.opinion.status, 'assessment');
    const input = { action: 'assess', text: '按开发方截图记载其建议从性能基线开始验证', estimated_hours: 2.5 };
    expectErr(await act(U.pm, op.id, input), 400, 'SYSBUILD_EVIDENCE_REQUIRED');
    const text = await H.stageAtt(pid, U.pm, 'a');
    expectErr(await act(U.pm, op.id, { ...input, attachment_ids: [text] }), 400, 'SYSBUILD_EVIDENCE_REQUIRED');
    assert.strictEqual(await sqlGet('SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id=?', [text]), undefined);
    assert.strictEqual((await stored(op.id)).status, 'assessment');
    const other = await stageImage(await H.newProject());
    expectErr(await act(U.pm, op.id, { ...input, attachment_ids: [other] }), 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual((await stored(op.id)).status, 'assessment');
    const att = await stageImage(pid);
    const ok = await act(U.pm, op.id, { ...input, attachment_ids: [att] });
    assert.strictEqual(ok.status, 200, ok.text);
    const view = ok.body.opinion;
    assert.deepStrictEqual([view.status, view.assessment_source, view.assessed_by, view.assessed_for_user_id, view.assessed_for_delegation_id], ['disposition', 'proxy', U.pm, U.x2, dev.delegation]);
    assert.deepStrictEqual(view.assessment_attachments.map((item) => item.attachment_id), [att]);
    assert.strictEqual((await get(U.pm, '/attachments/' + att)).body.attachment.actions.delete, false);
    const deniedDelete = await post(U.pm, '/attachments/' + att + '/delete');
    expectErr(deniedDelete, 409, 'SYSBUILD_STATE');
    assert.strictEqual(deniedDelete.body.message, '附件已作为开发评估凭据，不能删除；如需隐藏请由项目经理遮蔽');

    const noResponsible = await H.newProject();
    const waiting = (await propose(U.pm, noResponsible)).body.opinion.id;
    assert.strictEqual((await triage(waiting)).body.opinion.status, 'assessment');
    assert.deepStrictEqual((await listedOpinion(noResponsible, waiting)).waiting_for, { role: 'developer', name: null });
    expectErr(await act(U.pm, waiting, input), 400, 'SYSBUILD_EVIDENCE_REQUIRED');
    const evidence = await stageImage(noResponsible);
    const provisional = await act(U.pm, waiting, { ...input, attachment_ids: [evidence] });
    assert.strictEqual(provisional.status, 200, provisional.text);
    assert.deepStrictEqual([provisional.body.opinion.assessed_by, provisional.body.opinion.assessed_for_user_id, provisional.body.opinion.assessed_for_delegation_id], [U.pm, null, null]);
  });

  test(DISPOSE, async () => {
    const pid = await H.newProject();
    await seedDev(pid);
    const opened = await propose(U.pm, pid);
    assert.strictEqual(opened.status, 201, opened.text);
    const id = opened.body.opinion.id;
    const ready = await triage(id, { needs_assessment: false, skip_reason: '已有说明并不需要额外开发量评估' });
    assert.strictEqual(ready.status, 200, ready.text);
    const { pv } = await H.produceEffectiveOverall(pid);
    const rangePath = '/package-versions/' + pv;
    const initial = await get(U.pm, rangePath);
    const sheet = await get(U.pm, rangePath + '/confirmation-sheet');
    assert.strictEqual(sheet.status, 200, sheet.text);
    const close = (await get(U.pm, '/projects/' + pid + '/plan')).body.nodes.find((n) => n.template_key === 'p_closing').id;
    const disposeBody = { action: 'dispose', outcome: 'now', text: '本期纳入需求并交给开发负责人追踪' };
    expectErr(await act(U.x2, id, disposeBody), 403, 'SYSBUILD_FORBIDDEN');
    const competing = await Promise.all([act(U.pm, id, disposeBody), act(U.pm, id, disposeBody)]);
    assert.deepStrictEqual(competing.map((r) => r.status).sort(), [200, 409]);
    const decided = competing.find((r) => r.status === 200).body.opinion;
    assert.deepStrictEqual([decided.status, decided.outcome, decided.adjustment_version_id], ['concluded', 'now', pv]);
    const taskId = decided.task.id;
    const created = (await get(U.pm, '/tasks/' + taskId)).body.task;
    assert.deepStrictEqual([created.source_opinion_id, created.node_id, created.assignee_user_id, created.planned_on], [id, close, U.x2, null]);
    const scope = (await get(U.pm, rangePath)).body;
    assert.deepStrictEqual(scope.snapshot_json, initial.body.snapshot_json);
    assert.deepStrictEqual(scope.materials, initial.body.materials);
    assert.deepStrictEqual(scope.scope_adjustments.map((r) => r.opinion_id), [id]);
    const afterSheet = await get(U.pm, rangePath + '/confirmation-sheet');
    assert.strictEqual(afterSheet.text, sheet.text);
    const taskResult = (user, id, body) => post(user, '/tasks/' + id + '/result', body);
    expectErr(await taskResult(U.x1, taskId, { status: 'done' }), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await taskResult(U.x2, taskId, { status: 'cancelled' }), 400, 'SYSBUILD_INVALID_INPUT');
    const done = await taskResult(U.x2, taskId, { status: 'done', text: '按设计修订完成' });
    assert.strictEqual(done.status, 200, done.text);
    expectErr(await taskResult(U.x2, taskId, { status: 'done' }), 409, 'SYSBUILD_STATE');

    const other = await H.newProject();
    const otherNode = (await get(U.pm, '/projects/' + other + '/plan')).body.nodes[0].id;
    expectErr(await get(U.pm, '/projects/' + pid + '/tasks?node=' + otherNode), 404, 'SYSBUILD_NOT_FOUND');
    const manualPath = '/nodes/' + close + '/tasks';
    expectErr(await post(U.pm, manualPath, { title: '他项目成员', assignee_user_id: U.out }), 400, 'SYSBUILD_INVALID_INPUT');
    const manual = await post(U.pm, manualPath, { title: '手工跟踪事项', planned_on: '2026-12-03', assignee_user_id: U.pm });
    assert.strictEqual(manual.status, 201, manual.text);
    assert.deepStrictEqual([manual.body.task.source_opinion_id, manual.body.task.planned_on], [null, '2026-12-03']);
    assert.strictEqual((await taskResult(U.pm, manual.body.task.id, { status: 'cancelled', text: '已由现有事项覆盖，撤销本条' })).status, 200);
    const later = (await propose(U.pm, pid)).body.opinion;
    assert.strictEqual((await triage(later.id, { needs_assessment: false, skip_reason: '无需评估，登记后续范围建议' })).status, 200);
    const held = await act(U.pm, later.id, { action: 'dispose', outcome: 'next', text: '此批人员已经排满，下期再看' });
    assert.deepStrictEqual([held.body.opinion.task, held.body.opinion.adjustment_version_id], [null, null]);
  });

  test(CUT, async () => {
    const pid = await H.newProject();
    const devParty = await seedDev(pid);
    const primary = await H.seedParty(pid, '原需求部门甲', U.own, U.del);
    const second = await H.seedParty(pid, '原需求部门乙', U.m1, U.m2);
    const openCut = async () => {
      const created = await propose(U.x1, pid);
      assert.strictEqual(created.status, 201, created.text);
      return created.body.opinion.id;
    };
    const classify = (id) => triage(id, { category: 'cut' });
    const first = await openCut();
    const noScope = await classify(first);
    expectErr(noScope, 409, 'SYSBUILD_STATE');
    assert.strictEqual(noScope.body.field, 'category');
    const { pk, pv } = await H.produceEffectiveOverall(pid);
    await sqlRun("INSERT INTO sysbuild_confirm_tasks(project_id,object_type,object_id,object_version_id,purpose,party_id,created_by) VALUES (?,'package_version',?,?,'package_confirm',?,?)", [pid, pk, pv, devParty.party, U.pm]);
    const newDept = await H.seedParty(pid, '范围之后加入的需求部门', U.cand, U.cand2);
    const begin = await classify(first);
    assert.strictEqual(begin.status, 200, begin.text);
    assert.deepStrictEqual(begin.body.opinion.approvals.map((a) => a.party_id), [primary.party, second.party]);
    const bothWaiting = await listedOpinion(pid, first);
    assert.deepStrictEqual(bothWaiting.waiting_for, { role: 'demand', parties: [
      { party_name: '原需求部门甲', name: await personName(U.del) },
      { party_name: '原需求部门乙', name: await personName(U.m2) },
    ] });
    const decision = (user, id, partyId, value = 'agree') => act(user, id, { action: 'cut_decide', party_id: partyId, decision: value });
    expectErr(await decision(U.pm, first, primary.party), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await decision(U.own, first, primary.party), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await decision(U.cand2, first, newDept.party), 403, 'SYSBUILD_FORBIDDEN');
    expectErr(await decision(U.del, first, second.party), 403, 'SYSBUILD_FORBIDDEN');
    const both = await Promise.all([decision(U.del, first, primary.party), decision(U.m2, first, second.party)]);
    assert.ok(both.every((r) => r.status === 200), JSON.stringify(both.map((r) => r.body)));
    const complete = (await get(U.pm, detailPath(first))).body.opinion;
    assert.deepStrictEqual([complete.outcome, complete.adjustment_version_id, complete.task], ['cut_agreed', pv, null]);
    assert.deepStrictEqual(complete.approvals.map((a) => [a.party_id, a.decided_by]), [[primary.party, U.del], [second.party, U.m2]]);
    const opposed = await openCut();
    assert.strictEqual((await classify(opposed)).status, 200);
    await Promise.all([decision(U.del, opposed, primary.party), decision(U.m2, opposed, second.party, 'object')]);
    assert.deepStrictEqual([(await stored(opposed)).outcome, (await stored(opposed)).adjustment_version_id], ['scope_kept', null]);
    const withdrawn = await openCut();
    assert.strictEqual((await classify(withdrawn)).status, 200);
    const stop = await act(U.pm, withdrawn, { action: 'cut_withdraw', text: '本期保留原范围，撤回本条同意请求' });
    assert.strictEqual(stop.status, 200, stop.text);
    assert.deepStrictEqual([stop.body.opinion.outcome, stop.body.opinion.adjustment_version_id], ['scope_kept', null]);
    assert.ok(stop.body.opinion.approvals.every((row) => row.can_decide === false));
    const changed = await openCut();
    assert.strictEqual((await classify(changed)).status, 200);
    const sole = await decision(U.del, changed, primary.party);
    assert.strictEqual(sole.status, 200, sole.text);
    assert.strictEqual(sole.body.opinion.status, 'cut_approval');
    const replaced = await api(U.pm, 'PUT', '/sysbuild/parties/' + second.party + '/people', {
      leader_user_id: U.m1, representative_user_id: U.x3, expected_appointment_id: second.apt, expected_delegation_id: second.dlg,
      reason: '更换第二部门的当前负责人',
    });
    assert.strictEqual(replaced.status, 200, replaced.text);
    const onlyRemaining = await listedOpinion(pid, changed);
    assert.deepStrictEqual([onlyRemaining.is_pending, onlyRemaining.waiting_for], [true, { role: 'demand', parties: [
      { party_name: '原需求部门乙', name: await personName(U.x3) },
    ] }]);
    expectErr(await decision(U.m2, changed, second.party), 403, 'SYSBUILD_FORBIDDEN');
    const qualified = await decision(U.x3, changed, second.party);
    assert.strictEqual(qualified.status, 200, qualified.text);
    assert.deepStrictEqual(qualified.body.opinion.approvals.map((row) => row.decided_by), [U.del, U.x3]);
    assert.deepStrictEqual((await get(U.pm, '/package-versions/' + pv)).body.scope_adjustments.map((a) => a.opinion_id), [first, changed]);
    const stale = await openCut();
    assert.strictEqual((await classify(stale)).status, 200);
    assert.strictEqual((await decision(U.del, stale, primary.party)).status, 200);
    await sqlRun("UPDATE sysbuild_package_versions SET status='superseded' WHERE id=?", [pv]);
    assert.deepStrictEqual((await get(U.pm, '/package-versions/' + pv)).body.scope_adjustments.map((a) => a.opinion_id), [first, changed]);
    expectErr(await decision(U.x3, stale, second.party), 409, 'SYSBUILD_STATE');
    assert.strictEqual((await stored(stale)).status, 'cut_approval');
    assert.deepStrictEqual((await sqlAll('SELECT status FROM sysbuild_cut_approvals WHERE opinion_id=? ORDER BY party_id', [stale])).map((row) => row.status), ['agree', 'pending']);
    await sqlRun("UPDATE sysbuild_package_versions SET status='effective' WHERE id=?", [pv]);
    assert.strictEqual((await act(U.pm, stale, { action: 'cut_withdraw', text: '核对范围异常后撤回，继续保留原范围' })).status, 200);
    assert.strictEqual((await sqlAll('SELECT id FROM sysbuild_tasks WHERE project_id=?', [pid])).length, 0);
    const lostList = await openCut();
    await sqlRun('DELETE FROM sysbuild_confirm_tasks WHERE project_id=? AND object_version_id=?', [pid, pv]);
    const emptyRoster = await classify(lostList);
    expectErr(emptyRoster, 409, 'SYSBUILD_STATE');
    assert.strictEqual(emptyRoster.body.field, 'category');
    assert.strictEqual((await stored(lostList)).status, 'triage');
    assert.deepStrictEqual(await sqlAll('SELECT id FROM sysbuild_cut_approvals WHERE opinion_id=?', [lostList]), []);

    // 夹具模拟账号在已任职后变为平台只读。本人表态与原有内容包确认共用此权限边界。
    const readonlyPid = await H.newProject();
    await seedDev(readonlyPid);
    const readonlyParty = await H.seedParty(readonlyPid, '只读但有本人确认资格', U.own, U.ro);
    await H.produceEffectiveOverall(readonlyPid);
    const readonlyCut = (await propose(U.x1, readonlyPid)).body.opinion.id;
    assert.strictEqual((await classify(readonlyCut)).status, 200);
    expectErr(await propose(U.ro, readonlyPid), 403, 'SYSBUILD_FORBIDDEN');
    const ownDecision = await decision(U.ro, readonlyCut, readonlyParty.party);
    assert.strictEqual(ownDecision.status, 200, ownDecision.text);
    assert.strictEqual(ownDecision.body.opinion.outcome, 'cut_agreed');
  });

  test(CLOSE, async () => {
    const pid = await H.newProject();
    await H.produceEffectiveOverall(pid);
    const bid = await H.defaultBatchId(pid);
    await H.acceptEffective(pid, bid);
    const live = await post(U.pm, '/batches/' + bid + '/golive');
    assert.strictEqual(live.status, 200, live.text);
    await sqlRun("UPDATE sysbuild_golive_events SET created_at=datetime('now','localtime','-1 hour') WHERE batch_id=?", [bid]);
    await H.prepareAdditionalClosingCards(pid);
    const plan = () => get(U.pm, '/projects/' + pid + '/plan').then((r) => r.body);
    const nodes = (await plan()).nodes;
    const phase = nodes.find((n) => n.template_key === 'p_closing').id;
    const ordinary = nodes.find((n) => n.template_key === 'b_dev').id;
    const start = (nid) => post(U.pm, '/nodes/' + nid + '/start');
    const close = (nid) => post(U.pm, '/nodes/' + nid + '/close');
    assert.strictEqual((await start(phase)).status, 200);
    assert.strictEqual((await start(ordinary)).status, 200);
    const op = (await propose(U.pm, pid)).body.opinion;
    const task = (await post(U.pm, '/nodes/' + ordinary + '/tasks', { title: '阶段结束后仍要回复的任务', assignee_user_id: U.pm })).body.task;
    assert.strictEqual((await close(ordinary)).status, 200, '阶段不被任务或意见拦住');
    const pv = await H.mkPreparedVersion(await H.mkPackage(pid, 'closing'));
    const versionPath = '/package-versions/' + pv;
    const submit = () => post(U.pm, versionPath + '/submit');
    const denied = await submit();
    expectErr(denied, 409, 'SYSBUILD_STATE');
    const items = [
      { kind: 'opinion', id: op.id, title: op.title, node_id: ordinary },
      { kind: 'task', id: task.id, title: task.title, node_id: ordinary },
    ];
    assert.deepStrictEqual(denied.body.pending_work, items);
    const read = await get(U.pm, versionPath);
    assert.deepStrictEqual(read.body.submit_block, denied.body);
    assert.strictEqual(read.body.actions.submit, false);
    const direct = await close(phase);
    expectErr(direct, 409, 'SYSBUILD_CLOSE_BLOCKED');
    assert.deepStrictEqual(direct.body.blockers.find((b) => b.code === 'PENDING_PROJECT_WORK').pending_work, items);
    const visible = (await plan()).nodes.find((n) => n.id === phase);
    assert.strictEqual(visible.actions.close, false);
    assert.deepStrictEqual(visible.close_blockers, direct.body.blockers);
    assert.strictEqual((await triage(op.id, { decision: 'no' })).status, 200);
    assert.strictEqual((await post(U.pm, '/tasks/' + task.id + '/result', { status: 'done' })).status, 200);
    const submitted = await submit();
    assert.strictEqual(submitted.status, 200, submitted.text);
    await H.confirmAll(pv);
    const late = (await propose(U.pm, pid)).body.opinion;
    assert.strictEqual((await close(phase)).status, 409);
    assert.strictEqual((await triage(late.id, { decision: 'no' })).status, 200);
    const [closing, concurrent] = await Promise.all([close(phase), propose(U.pm, pid)]);
    if (closing.status === 200) expectErr(concurrent, 409, 'SYSBUILD_PROJECT_READONLY');
    else {
      expectErr(closing, 409, 'SYSBUILD_CLOSE_BLOCKED');
      assert.strictEqual(concurrent.status, 201, concurrent.text);
      assert.strictEqual((await triage(concurrent.body.opinion.id, { decision: 'no' })).status, 200);
      assert.strictEqual((await close(phase)).status, 200);
    }
    assert.strictEqual((await plan()).project.status, 'closed');
    expectErr(await propose(U.pm, pid), 409, 'SYSBUILD_PROJECT_READONLY');
    expectErr(await post(U.pm, '/nodes/' + ordinary + '/tasks', { title: '归档后试加任务', assignee_user_id: U.pm }), 409, 'SYSBUILD_PROJECT_READONLY');
    assert.deepStrictEqual(await sqlAll("SELECT id FROM sysbuild_opinions WHERE project_id=? AND status<>'concluded'", [pid]), []);
  });

  const opinionTodo = async (uid, id) => (await get(uid, '/my/todo')).body.items.opinion.find((item) => item.opinion_id === id);
  const taskTodo = async (uid, id) => (await get(uid, '/my/todo')).body.items.work_task.find((item) => item.work_task_id === id);
  const intents = (pid) => sqlAll("SELECT id,purpose,ref_type,ref_id,recipient_user_id,status,attempts,last_error FROM sysbuild_send_intents WHERE project_id=? AND purpose LIKE 'opinion_%' ORDER BY id", [pid]);

  test(NOTICES, async () => {
    const kit = getKit();
    if (kit) kit.ding.reset();
    const pid = await H.newProject();
    await seedDev(pid);
    const demand = await H.seedParty(pid, '需求方意见测试', U.own, U.del);
    await addMember(pid, U.m1, { party: demand.party });
    const op = (await propose(U.m1, pid)).body.opinion;
    assert.ok(await opinionTodo(U.pm, op.id), '待初判进入PM待办');
    assert.strictEqual(await opinionTodo(U.x2, op.id), undefined);
    assert.strictEqual((await triage(op.id)).body.opinion.status, 'assessment');
    assert.ok(await opinionTodo(U.x2, op.id));
    assert.strictEqual(await opinionTodo(U.x1, op.id), undefined, '开发领导无评估待办');
    assert.strictEqual(await opinionTodo(U.pm, op.id), undefined);
    const developmentText = '先复用对账查询，再补页面与验收。';
    const review = await act(U.x2, op.id, { action: 'assess', text: developmentText, estimated_hours: 1.5 });
    assert.strictEqual(review.status, 200, review.text);
    assert.ok(await opinionTodo(U.pm, op.id), '开发给完意见进入PM待定去向');
    assert.strictEqual(await opinionTodo(U.x2, op.id), undefined);
    const adopted = await act(U.pm, op.id, { action: 'dispose', outcome: 'now', text: '同意本期做，确认分工。' });
    assert.strictEqual(adopted.status, 200, adopted.text);
    assert.strictEqual(await opinionTodo(U.pm, op.id), undefined);
    const tid = adopted.body.opinion.task.id;
    assert.ok(await taskTodo(U.x2, tid));
    assert.strictEqual(await taskTodo(U.own, tid), undefined);
    assert.strictEqual((await post(U.x2, '/tasks/' + tid + '/result', { status: 'done' })).status, 200);
    assert.strictEqual(await taskTodo(U.x2, tid), undefined);
    assert.deepStrictEqual((await intents(pid)).map((r) => [r.purpose, r.ref_type, r.recipient_user_id]), [
      ['opinion_assess_notice', 'opinion', U.x2], ['opinion_ready_notice', 'opinion', U.pm], ['opinion_result_notice', 'opinion', U.m1],
    ]);
    if (kit) {
      const result = kit.ding.sends().find((r) => r.title === '【系统建设记录】意见结论知悉' && r.markdown.includes('opinion=' + op.id));
      assert.ok(result, '结论知悉实际发送');
      assert.ok(result.markdown.includes(developmentText));
      assert.ok(result.markdown.includes('工时：1.5 小时'));
      assert.ok(result.markdown.includes('/Sys_Build.html?project=' + pid + '&tab=opinions&opinion=' + op.id));
      assert.deepStrictEqual(result.userIds, ['ding-u' + U.m1]);
    }
    const proxy = (await propose(U.pm, pid, { title: 'PM 代录意见的知悉检查' })).body.opinion;
    assert.strictEqual((await triage(proxy.id)).status, 200);
    const screenshot = await stageImage(pid);
    assert.strictEqual((await act(U.pm, proxy.id, { action: 'assess', text: '据开发方原截图补录意见。', estimated_hours: 2, attachment_ids: [screenshot] })).status, 200);
    assert.deepStrictEqual((await intents(pid)).filter((row) => row.ref_type === 'opinion' && row.ref_id === proxy.id).map((row) => row.purpose), ['opinion_assess_notice']);

    await H.produceEffectiveOverall(pid);
    const cut = (await propose(U.x1, pid)).body.opinion;
    assert.strictEqual((await triage(cut.id, { category: 'cut' })).status, 200);
    const cutIntent = (await intents(pid)).find((row) => row.purpose === 'opinion_cut_notice');
    assert.deepStrictEqual([cutIntent.ref_type, cutIntent.recipient_user_id], ['cut_approval', U.del]);
    assert.ok(await opinionTodo(U.del, cut.id), '待本人同意');
    assert.strictEqual(await opinionTodo(U.own, cut.id), undefined, '领导无代同意待办');
    assert.strictEqual((await act(U.del, cut.id, { action: 'cut_decide', party_id: demand.party, decision: 'object' })).status, 200);
    assert.strictEqual(await opinionTodo(U.del, cut.id), undefined);
  });

  test(RETRY, async () => {
    const kit = getKit();
    if (!kit) return skip;
    kit.ding.reset();
    const pid = await H.newProject();
    await seedDev(pid);
    const first = (await propose(U.pm, pid)).body.opinion;
    const sends = () => kit.ding.sends().filter((row) => row.markdown.includes('project=' + pid + '&tab=opinions'));
    try {
      await sqlRun("UPDATE users SET status='disabled' WHERE id=?", [U.x2]);
      assert.strictEqual((await triage(first.id)).status, 200);
      const toRestore = (await intents(pid)).find((row) => row.ref_id === first.id);
      assert.deepStrictEqual([toRestore.status, toRestore.attempts], ['failed', 1]);
      assert.match(toRestore.last_error, /停用/);
      assert.strictEqual(sends().length, 0);
      await sqlRun("UPDATE users SET status='active' WHERE id=?", [U.x2]);
      const resent = await post(U.pm, '/projects/' + pid + '/send-intents/resend');
      assert.strictEqual(resent.status, 200, resent.text);
      assert.strictEqual((await intents(pid)).find((row) => row.id === toRestore.id).status, 'sent');
      assert.strictEqual(sends().length, 1);
      const doomed = (await propose(U.pm, pid)).body.opinion;
      await sqlRun("UPDATE users SET status='disabled' WHERE id=?", [U.x2]);
      assert.strictEqual((await triage(doomed.id)).status, 200);
      const stale = (await intents(pid)).find((row) => row.ref_id === doomed.id);
      assert.strictEqual(stale.status, 'failed');
      const end = await post(U.admin, '/projects/' + pid + '/status', { to: 'terminated', reason: '终止后已有评估通知失效' });
      assert.strictEqual(end.status, 200, end.text);
      await sqlRun("UPDATE users SET status='active' WHERE id=?", [U.x2]);
      await kit.notifier.scan();
      const skipped = (await intents(pid)).find((row) => row.id === stale.id);
      assert.deepStrictEqual([skipped.status, skipped.attempts], ['sent', 1]);
      assert.match(skipped.last_error, /无需发送/);
      assert.strictEqual(await opinionTodo(U.x2, doomed.id), undefined);
      assert.strictEqual(sends().length, 1);

      const answerPid = await H.newProject();
      await addMember(answerPid, U.m1);
      const recipient = (await propose(U.m1, answerPid)).body.opinion;
      await sqlRun("UPDATE users SET status='disabled' WHERE id=?", [U.m1]);
      const answer = '此功能现有页面已覆盖，本期不增加入口。';
      assert.strictEqual((await triage(recipient.id, { decision: 'no', text: answer })).status, 200);
      const reply = (await intents(answerPid)).find((row) => row.purpose === 'opinion_result_notice');
      assert.deepStrictEqual([reply.recipient_user_id, reply.status, reply.attempts], [U.m1, 'failed', 1]);
      assert.match(reply.last_error, /停用/);
      await sqlRun("UPDATE users SET status='active' WHERE id=?", [U.m1]);
      assert.strictEqual((await post(U.pm, '/projects/' + answerPid + '/send-intents/resend')).status, 200);
      const actual = kit.ding.sends().find((row) => row.markdown.includes('project=' + answerPid + '&tab=opinions&opinion=' + recipient.id));
      assert.ok(actual && actual.markdown.includes(answer) && !actual.markdown.includes('null'));
      assert.strictEqual((await intents(answerPid))[0].status, 'sent');

      const reassignedPid = await H.newProject();
      const appointed = await seedDev(reassignedPid);
      const reassigned = (await propose(U.pm, reassignedPid)).body.opinion;
      await sqlRun("UPDATE users SET status='disabled' WHERE id=?", [U.x2]);
      assert.strictEqual((await triage(reassigned.id)).status, 200);
      const developerIntent = (await intents(reassignedPid)).find((row) => row.purpose === 'opinion_assess_notice' && row.ref_id === reassigned.id);
      assert.ok(developerIntent, '评估发送意图引用本条意见');
      assert.deepStrictEqual([developerIntent.recipient_user_id, developerIntent.status, developerIntent.attempts], [U.x2, 'failed', 1]);
      assert.strictEqual((await api(U.pm, 'PUT', '/sysbuild/parties/' + appointed.party + '/people', {
        leader_user_id: U.x1, representative_user_id: U.x3, expected_appointment_id: appointed.appointment, expected_delegation_id: appointed.delegation,
        reason: '开发评估过程中重新指定现任负责人',
      })).status, 200);
      await sqlRun("UPDATE users SET status='active' WHERE id=?", [U.x2]);
      assert.strictEqual((await post(U.pm, '/projects/' + reassignedPid + '/send-intents/resend')).status, 200);
      const staleDeveloper = (await intents(reassignedPid)).find((row) => row.id === developerIntent.id);
      assert.deepStrictEqual([staleDeveloper.status, staleDeveloper.attempts], ['sent', 1]);
      assert.match(staleDeveloper.last_error, /无需发送/);
      assert.ok(await opinionTodo(U.x3, reassigned.id));
      assert.strictEqual(await opinionTodo(U.x2, reassigned.id), undefined);
      assert.strictEqual(kit.ding.sends().some((row) => row.markdown.includes('project=' + reassignedPid + '&tab=opinions')), false);

      const cutPid = await H.newProject();
      await seedDev(cutPid);
      const demand = await H.seedParty(cutPid, '换负责人的需求部门', U.own, U.del);
      await H.produceEffectiveOverall(cutPid);
      const cut = (await propose(U.x1, cutPid)).body.opinion;
      await sqlRun("UPDATE users SET status='disabled' WHERE id=?", [U.del]);
      const approval = await triage(cut.id, { category: 'cut' });
      assert.strictEqual(approval.status, 200, approval.text);
      const demandRow = approval.body.opinion.approvals.find((row) => row.party_id === demand.party);
      const demandIntent = (await intents(cutPid)).find((row) => row.purpose === 'opinion_cut_notice' && row.ref_id === demandRow.id);
      assert.ok(demandIntent, '知悉引用本部门待表态行');
      assert.deepStrictEqual([demandIntent.recipient_user_id, demandIntent.status, demandIntent.attempts], [U.del, 'failed', 1]);
      assert.strictEqual((await api(U.pm, 'PUT', '/sysbuild/parties/' + demand.party + '/people', {
        leader_user_id: U.own, representative_user_id: U.x3, expected_appointment_id: demand.apt, expected_delegation_id: demand.dlg,
        reason: '待表态阶段重新指定需求部门负责人',
      })).status, 200);
      await sqlRun("UPDATE users SET status='active' WHERE id=?", [U.del]);
      await kit.notifier.scan();
      const staleDemand = (await intents(cutPid)).find((row) => row.id === demandIntent.id);
      assert.deepStrictEqual([staleDemand.status, staleDemand.attempts], ['sent', 1]);
      assert.match(staleDemand.last_error, /无需发送/);
      assert.ok(await opinionTodo(U.x3, cut.id));
      assert.strictEqual(await opinionTodo(U.del, cut.id), undefined);
      assert.strictEqual(kit.ding.sends().some((row) => row.markdown.includes('project=' + cutPid + '&tab=opinions')), false);
    } finally {
      for (const uid of [U.x2, U.m1, U.del]) await sqlRun("UPDATE users SET status='active' WHERE id=?", [uid]);
      kit.ding.reset();
    }
  });
}

const workMutations = [
  { id: 'B6.3 未办结反计已结论意见', expect: [TRIAGE], edits: [
    { file: 'work-core.js', from: "status <> 'concluded'", to: "status = 'concluded'" },
  ] },
  { id: 'B6.3 开发评估误等项目经理', expect: [TRIAGE], edits: [
    { file: 'work.js', from: 'await nameOf(context.developer?.userId)', to: 'await nameOf(project.pm_user_id)' },
  ] },
  { id: 'B6.3 已回话的部门仍在等待人', expect: [CUT], edits: [
    { file: 'work.js', from: "AND status = 'pending' ORDER BY party_id", to: 'ORDER BY party_id' },
  ] },
  { id: 'B5.1 意见误挂最先开始的阶段', expect: [PROPOSE], edits: [
    { file: 'work-core.js', from: 'ORDER BY (n.batch_id IS NOT NULL) DESC', to: 'ORDER BY (n.batch_id IS NOT NULL) ASC' },
  ] },
  { id: 'B5.1 初判跳过评估无需原因', expect: [TRIAGE], edits: [
    { file: 'work.js', from: 'if (needsAssessment === false && !input.skipReason)', to: 'if (false)' },
  ] },
  { id: 'B5.1 把开发领导当负责人', expect: [TRIAGE], edits: [
    { file: 'work-core.js', from: 'await confirmations.currentDelegate(q, partyId, options)', to: 'await confirmations.currentOwner(q, partyId, options)' },
  ] },
  { id: 'B5.1 代填不需要真实截图', expect: [PROXY], edits: [
    { file: 'work.js', from: "if (mode === 'proxy') await verifyScreenshot(q, bound);", to: '' },
  ] },
  { id: 'B5.2 本期做不建任务', expect: [DISPOSE], edits: [
    { file: 'work.js', from: 'await createTask(q, user, pid, nodeId, { title: opinion.title, assigneeId: assignee?.id ?? context.identity.project.pm_user_id, plannedOn: null, opinionId: opinion.id });', to: '' },
  ] },
  { id: 'B5.2 砍需求任一部门同意即生效', expect: [CUT], edits: [
    { file: 'work.js', from: "if (approvals.length === 0 || !approvals.every((row) => row.status === 'agree')) return;", to: 'if (false) return;' },
  ] },
  { id: 'B5.2 领导或 PM 可代砍需求表态', expect: [CUT], edits: [
    { file: 'rules.js', from: 'can: (identity, project, t) => t.isCutResponsible === true || canProxyAsSuperAdmin(identity),', to: 'can: (identity, project, t) => identity.isPm || t.isCutResponsible === true || canProxyAsSuperAdmin(identity),' },
  ] },
  { id: 'B5.2 结项提交绕过待办', expect: [CLOSE], edits: [
    { file: 'rules.js', from: "if (t.packageType === 'closing' && t.pendingWork) return t.pendingWork;", to: '' },
  ] },
  { id: 'B5.2 结项收口绕过待办', expect: [CLOSE], edits: [
    { file: 'plan.js', from: 'if (f.pendingWork?.length) {', to: 'if (false) {' },
  ] },
  { id: 'B5.3 开发评估结束不知悉PM', expect: [NOTICES], edits: [
    { file: 'work.js', from: "if (!identity.isPm) await workNotify.afterDeveloperAssessment", to: "if (false) await workNotify.afterDeveloperAssessment" },
  ] },
  { id: 'B5.3 开发评估待办误发给可代录PM', expect: [NOTICES], edits: [
    { file: 'work-notify.js', from: "if (item.status === 'assessment' && developer?.userId !== uid) continue;", to: '' },
  ] },
  { id: 'B5.3 结论通知遗漏开发意见和工时', expect: [NOTICES], edits: [
    { file: 'work-notify.js', from: 'const assessment = opinion.assessment_source', to: 'const assessment = false' },
  ] },
  { id: 'B5.3 开发评估知悉跳过停用账号', expect: [RETRY], edits: [
    { file: 'work-notify.js', from: "if (status === 'assessment') {\n    const developer = await work.developerResponsible(q, pid, STRUCTURAL);", to: "if (status === 'assessment') {\n    const developer = await work.developerResponsible(q, pid);" },
  ] },
  { id: 'B5.3 扫描仍外发终止项目的意见知悉', expect: [RETRY], edits: [
    { file: 'work-notify.js', from: "if (!project || project.status === 'terminated')", to: "if (!project)" },
    { file: 'work-notify.js', from: "if (!['active', 'paused'].includes(project.status)) return notNeeded();", to: '' },
  ] },
  { id: 'B5.3 补发不复核开发评估收件人', expect: [RETRY], edits: [
    { file: 'work-notify.js', from: "return opinion.status === 'assessment' && developer?.userId === user.id", to: "return opinion.status === 'assessment'" },
  ] },
  { id: 'B5.3 扫描不复核砍需求收件人', expect: [RETRY], edits: [
    { file: 'work-notify.js', from: "approval.status === 'pending' && responsible?.userId === user.id", to: "approval.status === 'pending'" },
  ] },
];

module.exports = { defineWorkCases, workMutations };
