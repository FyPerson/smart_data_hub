'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const T_MATERIAL = 'B3.2 卡片合格版本与声明生效顺序';
const T_SCOPE = 'B3.2 三职责计划与范围材料';
const T_CLOSING = 'B3.2 结项两处卡片检查';
const T_CANCEL = 'B3.2 验收阶段不可取消';
const T_CLOSING_FALLBACK = 'B3.2 结项保留未被卡片覆盖的批次阻塞';

function defineCardCases(T) {
  const { test, api, U, expectErr, sqlAll, sqlGet, sqlRun, confirm: H } = T;
  const get = (url) => api(U.pm, 'GET', url);
  const post = (url, body = {}) => api(U.pm, 'POST', url, body);
  const plan = async (pid) => (await get(`/sysbuild/projects/${pid}/plan`)).body;
  const cards = async (pid) => (await get(`/sysbuild/projects/${pid}/materials`)).body.cards;
  const card = async (pid, key) => (await cards(pid)).find((item) => item.key === key);
  const end = (node, key) => `/sysbuild/nodes/${node.id}/materials/${key}`;
  const reason = '已经在线下核准，此项目没有相应书面材料';
  const mark = (node, key, text = reason) => post(end(node, key) + '/not-applicable', { reason: text });
  const upload = (node, key, body) => post(end(node, key) + '/versions', body);
  const submit = (vid) => post(`/sysbuild/package-versions/${vid}/submit`);
  const expectCode = (r, code, field) => assert.deepStrictEqual([r.status, r.body.code, r.body.field], [code, code === 400 ? 'SYSBUILD_INVALID_INPUT' : 'SYSBUILD_STATE', field]);
  const setPlan = (node) => post(`/sysbuild/nodes/${node.id}/schedule`, { kind: 'plan', planned_start: H.PLAN_START, planned_end: H.PLAN_END });
  const create = async (buildType) => {
    const pid = await H.newProject(buildType);
    await H.seedParty(pid, '需求部门', U.own, U.del);
    const view = await plan(pid);
    return { pid, batch: view.batches[0].id, nodes: Object.fromEntries(view.nodes.map((node) => [node.template_key, node])) };
  };

  test(T_MATERIAL, async () => {
    const { pid, nodes } = await create('outsource');
    const initial = await cards(pid);
    assert.strictEqual(initial.filter((item) => item.required).length, 11);
    assert.deepStrictEqual(initial.filter((item) => !item.required).map((item) => item.key).sort(), ['prototype-design', 'test-report', 'user-manual']);
    expectCode(await upload(nodes.p_initiation, 'contract-order', { body: '错阶段' }), 409, 'key');
    expectCode(await upload(nodes.p_contract, 'contract-order', { name: '试图改名', body: '正文' }), 400, 'name');
    expectCode(await upload(nodes.b_dev, 'required-custom-1', { name: '抢先占用', body: '正文' }), 409, 'key');
    const added = await post(`/sysbuild/nodes/${nodes.b_dev.id}/material-cards`, { name: '自建验收前资料' });
    assert.strictEqual(added.status, 201, added.text);
    const custom = added.body.material.material_key;
    for (const [node, key] of [[nodes.p_initiation, 'initiation-basis'], [nodes.p_contract, 'contract-order'], [nodes.b_trial, 'operations-handover'], [nodes.b_dev, custom]]) {
      const stated = await mark(node, key);
      assert.strictEqual(stated.status, 201, stated.text);
      assert.strictEqual((await card(pid, key)).declaration.id, stated.body.event_id);
      expectCode(await upload(node, key, { body: '上传失败', attachment_ids: [999999] }), 400, 'attachment_ids');
      assert.strictEqual((await card(pid, key)).declaration.id, stated.body.event_id, '失败上传没有使旧说明失效');
      assert.strictEqual((await upload(node, key, { body: '只有正文的最新一版' })).status, 201);
      await sqlRun("UPDATE sysbuild_events SET created_at = '2026-11-25 15:10:00' WHERE project_id = ? AND (id = ? OR id = (SELECT MAX(id) FROM sysbuild_events WHERE project_id = ? AND event_type = 'material_version_created'))", [pid, stated.body.event_id, pid]);
      assert.deepStrictEqual([(await card(pid, key)).complete, (await card(pid, key)).declaration], [false, null], '同秒上传也能使说明失效');
      const restated = await mark(node, key);
      assert.strictEqual(restated.status, 201, restated.text);
      const first = await H.stageAtt(pid, U.pm);
      const second = await H.stageAtt(pid, U.pm);
      const withFiles = await upload(node, key, { attachment_ids: [first, second] });
      assert.strictEqual(withFiles.status, 201, withFiles.text);
      assert.strictEqual((await upload(node, key, { body: '更新的正文版不替换先前合格版' })).status, 201);
      assert.deepStrictEqual((await card(pid, key)).qualified_version_ids, [withFiles.body.version.id]);
      expectCode(await mark(node, key), 409, 'key');
      assert.strictEqual((await post(`/sysbuild/attachments/${first}/mask`, { reason: '该材料包含受控信息' })).status, 200);
      const afterMask = await card(pid, key);
      assert.deepStrictEqual([afterMask.complete, afterMask.declaration, afterMask.actions.mark_not_applicable], [false, null, true], '部分失效也不重新激活上传前的说明');
      assert.strictEqual((await mark(node, key)).status, 201, '仍无合格版可重新填');
      assert.strictEqual((await card(pid, key)).complete, true);
    }
    expectCode(await mark(nodes.p_overall, 'requirements-document', '短'), 409, 'key');
    expectCode(await mark(nodes.b_uat, 'acceptance-record', '短'), 409, 'key');
    expectCode(await upload(nodes.p_overall, 'requirements-document', { body: '缺附件' }), 400, 'attachment_ids');
    const audit = (await get(`/sysbuild/projects/${pid}/events?limit=100`)).body.items;
    assert.ok(audit.some((item) => item.label === '填写了无书面依据原因'));
    assert.ok(audit.some((item) => item.label === '将材料标为不适用'));
  });

  test(T_SCOPE, async () => {
    for (const [buildType, keys, roles] of [
      ['outsource', ['b_uat', 'b_trial', 'p_closing'], [['acceptance'], ['golive'], ['closing']]],
      ['procurement', ['b_training', 'b_trial', 'p_closing'], [['acceptance'], ['golive'], ['closing']]],
      ['inhouse', ['b_golive', 'p_closing'], [['acceptance', 'golive'], ['closing']]],
    ]) {
      const { pid, nodes } = await create(buildType);
      await H.produceEffectiveInitiation(pid);
      const version = await H.mkVersion(await H.mkPackage(pid, 'overall'));
      expectErr(await submit(version), 409, 'SYSBUILD_STATE', '所需日期为空');
      for (const key of keys) assert.strictEqual((await setPlan(nodes[key])).status, 201);
      assert.strictEqual((await card(pid, 'project-plan')).complete, true, '计划齐全独立于范围是否生效');
      assert.strictEqual((await card(pid, 'overall')).complete, false);
      const draft = (await get(`/sysbuild/package-versions/${version}`)).body;
      assert.deepStrictEqual(draft.submit_block, { code: 'SYSBUILD_STATE', message: '请选入「需求文档」中带可用附件的一版' });
      assert.strictEqual((await submit(version)).body.message, draft.submit_block.message);
      const basis = await H.prepareBasisVersion(version);
      const submitted = await submit(version);
      assert.strictEqual(submitted.status, 200, submitted.text);
      const [task] = await H.tasksOf(version);
      const opened = await H.openTask(U.del, task.task_id);
      assert.deepStrictEqual(opened.body.object.node_plans.map((item) => [item.template_key, item.roles]), keys.map((key, index) => [key, roles[index]]));
      assert.strictEqual(opened.body.object.materials[0].id, basis);
      await H.confirmAll(version);
      const baselines = await sqlAll("SELECT node_id, package_version_id FROM sysbuild_node_schedule_records WHERE kind = 'baseline' AND package_version_id = ? ORDER BY id", [version]);
      assert.deepStrictEqual(baselines.map((item) => item.node_id), keys.map((key) => nodes[key].id));
      assert.strictEqual((await card(pid, 'overall')).complete, true);
      const newer = await upload(nodes.p_overall, 'requirements-document', { attachment_ids: [await H.stageAtt(pid, U.pm)] });
      assert.deepStrictEqual((await card(pid, 'requirements-document')).after_confirmation_version_ids, [newer.body.version.id]);
    }
  });

  test(T_CLOSING, async () => {
    const { pid, batch, nodes } = await create('inhouse');
    const initiation = await H.produceEffectiveInitiation(pid);
    const effectiveBefore = (await get(`/sysbuild/package-versions/${initiation.pv}`)).body.snapshot_json.no_written_basis_reason;
    assert.strictEqual((await upload(nodes.p_initiation, 'initiation-basis', { body: '后来补传的说明' })).status, 201);
    const basis = await card(pid, 'initiation-basis');
    assert.deepStrictEqual([basis.complete, basis.declaration, basis.qualified_version_ids.length], [true, null, 0], '生效声明在补传后继续完成');
    assert.strictEqual((await get(`/sysbuild/package-versions/${initiation.pv}`)).body.snapshot_json.no_written_basis_reason, effectiveBefore);
    await H.produceEffectiveOverall(pid);
    await H.readyForGolive(pid, batch);
    await H.productionGolive(batch);
    const closing = await H.mkVersion(await H.mkPackage(pid, 'closing'));
    assert.strictEqual((await post(`/sysbuild/nodes/${nodes.p_closing.id}/start`)).status, 200);
    const blocked = await submit(closing);
    expectErr(blocked, 409, 'SYSBUILD_STATE', '正式上线后集中过必做卡');
    assert.strictEqual(blocked.body.message, '以下必做事项尚未完成，不能发起结项确认：上线（含测试与验收）（第 1 批） · 运维交接材料');
    const failed = await post(`/sysbuild/nodes/${nodes.p_closing.id}/close`);
    assert.strictEqual(failed.body.code, 'SYSBUILD_CLOSE_BLOCKED');
    assert.deepStrictEqual(failed.body.blockers.map((item) => item.code), ['REQUIRED_CARDS_INCOMPLETE']);
    assert.ok(failed.body.blockers[0].message.includes('结项 · 结项确认'));
    const read = (await plan(pid)).nodes.find((item) => item.id === nodes.p_closing.id);
    assert.deepStrictEqual([read.actions.close, read.close_blockers], [false, failed.body.blockers]);
    assert.strictEqual((await mark(nodes.b_golive, 'operations-handover')).status, 201);
    for (const [key, node, type] of [['requirements-document', nodes.p_overall, 'overall'], ['acceptance-record', nodes.b_golive, 'batch_accept']]) {
      const current = (await card(pid, key)).qualified_version_ids[0];
      const attachment = await sqlGet("SELECT attachment_id AS id FROM sysbuild_attachment_bindings WHERE owner_type = 'material_version' AND owner_id = ?", [current]);
      const effective = await sqlGet("SELECT v.id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = ? AND v.status = 'effective'", [pid, type]);
      assert.strictEqual((await post(`/sysbuild/attachments/${attachment.id}/mask`, { reason: '处置当时的受控附件' })).status, 200);
      assert.strictEqual((await card(pid, key)).complete, false);
      const noUsable = await submit(closing);
      expectErr(noUsable, 409, 'SYSBUILD_STATE', '冻结版不可用时结项待补');
      assert.ok(noUsable.body.message.includes((await card(pid, key)).name));
      assert.strictEqual((await upload(node, key, { attachment_ids: [await H.stageAtt(pid, U.pm)] })).status, 201, '已完成阶段仍可补传');
      assert.strictEqual((await card(pid, key)).complete, true);
      assert.deepStrictEqual((await get(`/sysbuild/package-versions/${effective.id}`)).body.snapshot_json.material_version_ids, [current], '补传不覆盖当时的确认');
    }
    assert.strictEqual((await submit(closing)).status, 200, '提交排除待发起的结项确认卡');
    await H.confirmAll(closing);
    assert.strictEqual((await post(`/sysbuild/nodes/${nodes.p_closing.id}/close`)).status, 200);
  });

  test(T_CLOSING_FALLBACK, async () => {
    const { closeBlockers } = require(path.join(T.getModuleDir(), 'plan.js'));
    const closing = { id: 31, template_key: 'p_closing', batch_id: null };
    const facts = {
      closing: { closingEffectiveAt: '2026-11-25 08:00:00', closingStale: false, packagePending: [], goliveNewer: [], notLive: [{ id: 12, name: '已登记的批次' }, { id: 13, name: '缺卡片的批次' }] },
      closingCards: [{ node_id: 21, node_name: '正式上线节点', batch_id: 12, batch_name: '已登记的批次', key: 'golive', name: '正式上线记录' }],
    };
    const blocked = closeBlockers(closing, facts);
    assert.deepStrictEqual(blocked.map((item) => [item.code, item.batch_ids]), [['BATCH_NOT_LIVE', [13]], ['REQUIRED_CARDS_INCOMPLETE', [12]]]);
    assert.strictEqual(blocked[0].message, '以下批次还没有正式上线，不能结项：缺卡片的批次');
  });

  test(T_CANCEL, async () => {
    for (const [buildType, key] of [['outsource', 'b_uat'], ['procurement', 'b_training']]) {
      const { pid, nodes } = await create(buildType);
      assert.strictEqual(nodes[key].actions.cancel, false);
      const response = await post(`/sysbuild/nodes/${nodes[key].id}/cancel`, { reason: '尝试取消验收' });
      expectErr(response, 409, 'SYSBUILD_STATE', '固定验收阶段');
      assert.strictEqual(response.body.message, '承载验收确认的预设阶段不能取消');
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_nodes WHERE id = ?', [nodes[key].id])).status, 'not_started');
      assert.strictEqual((await post(`/sysbuild/nodes/${nodes.b_golive.id}/cancel`, { reason: '取消普通上线阶段' })).status, 200);
      assert.strictEqual((await plan(pid)).nodes.find((node) => node.id === nodes.b_golive.id).status, 'cancelled');
    }
  });
}

const mutation = (id, test, file, from, to) => ({ id: 'B3.2 ' + id, expect: [test], edits: [{ file, from, to }] });
const CARD_MUTATIONS = [
  mutation('禁止已收口材料补传', T_CLOSING, 'rules.js', "['not_started', 'in_progress', 'closed'].includes(t.nodeStatus)", "['not_started', 'in_progress'].includes(t.nodeStatus)"),
  mutation('任一附件可用就算合格', T_MATERIAL, 'materials-core.js', 'version.attachments.every((att)', 'version.attachments.some((att)'),
  mutation('说明无视随后上传', T_MATERIAL, 'stage-cards.js', '(!versions.length || (upload && latest.id > upload.id))', 'true'),
  mutation('立项生效仍只查当前材料', T_CLOSING, 'stage-cards.js', 'initiation ? frozen : state.qualified.length > 0 || !!state.declaration', 'state.qualified.length > 0 || !!state.declaration'),
  mutation('范围省略材料门', T_SCOPE, 'rules.js', "if (t.packageType === 'overall' && t.pairedBasis !== true)", 'if (false)'),
  mutation('发起结项遗漏材料拦截', T_CLOSING, 'rules.js', "if (t.packageType === 'closing' && t.missingCards)", 'if (false)'),
  mutation('验收阶段仍可取消', T_CANCEL, 'rules.js', 'if ([ACCEPTANCE_NODE_KEYS.outsource, ACCEPTANCE_NODE_KEYS.procurement].includes(t.templateKey))', 'if (false)'),
];

module.exports = { defineCardCases, CARD_MUTATIONS };
