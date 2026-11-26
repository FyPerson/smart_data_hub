'use strict';

const assert = require('node:assert/strict');

const GATES = 'B4.1 上线和结项选填完成同一事务';
const TEXT = 'B4.1 四类确认正文门';
const EARLY = 'B4.2 先开工、可选说明及附件';
const DEFAULT = 'B4.2 默认汇报节奏、登记与精简汇报';
const SCHEDULE = 'B4.2 首排并发与推迟结项的证据';

function addDays(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function defineStep4Cases(T) {
  const { test, api, U, sqlAll, sqlGet, sqlRun, expectErr, addParty, confirm: H } = T;
  const request = (method, tail, body) => api(U.pm, method, '/sysbuild' + tail, body);
  const post = (tail, body = {}) => request('POST', tail, body);
  const get = async (tail) => {
    const res = await request('GET', tail);
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
  };
  const submit = (id) => post('/package-versions/' + id + '/submit');
  const keptNode = (id) => sqlGet('SELECT status, opened_at, closed_at FROM sysbuild_nodes WHERE id = ?', [id]);
  const actuals = (id) => sqlAll("SELECT kind, actual_date FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('actual_start','actual_end') ORDER BY id", [id]);
  const plan = (pid) => get('/projects/' + pid + '/plan');
  async function oldEnough(pid) {
    await sqlRun("UPDATE sysbuild_golive_events SET created_at = datetime('now','localtime','-1 hour') WHERE batch_id IN (SELECT id FROM sysbuild_batches WHERE project_id = ?)", [pid]);
  }

  test(GATES, async () => {
    const pid = await H.newProject();
    await H.produceEffectiveOverall(pid);
    const before = await plan(pid);
    const batch = before.batches[0].id;
    const dev = before.nodes.find((n) => n.template_key === 'b_dev').id;
    const milestone = before.nodes.find((n) => n.is_golive_milestone).id;
    const extra = await post('/batches/' + batch + '/nodes', { name: '上线时补结记的普通阶段' });
    assert.strictEqual(extra.status, 201, extra.text);
    const optional = extra.body.node.id;
    const dropped = await post('/batches/' + batch + '/nodes', { name: '已经取消的阶段' });
    assert.strictEqual(dropped.status, 201, dropped.text);
    const cancelled = dropped.body.node.id;
    assert.strictEqual((await post('/nodes/' + cancelled + '/cancel', { reason: '覆盖结项名单过滤' })).status, 200);
    const ordinary = before.nodes.find((n) => n.template_key === 'p_overall').id;
    assert.strictEqual((await post('/nodes/' + ordinary + '/start')).status, 200);
    const crossClose = await post('/nodes/' + ordinary + '/close', { complete_node_ids: [optional] });
    expectErr(crossClose, 409, 'SYSBUILD_STATE');
    assert.strictEqual(crossClose.body.field, 'complete_node_ids');
    assert.strictEqual((await keptNode(ordinary)).status, 'in_progress');
    assert.strictEqual((await keptNode(optional)).status, 'not_started');
    assert.deepStrictEqual(await actuals(optional), []);
    assert.deepStrictEqual((await actuals(ordinary)).map((r) => r.kind), ['actual_start']);
    const sibling = await H.newProject();
    const otherNode = (await plan(sibling)).nodes.find((n) => n.template_key === 'b_dev').id;
    const go = '/batches/' + batch + '/golive';
    const can = () => get('/batches/' + batch + '/handover');
    const noAcceptance = await post(go, { complete_node_ids: [otherNode] });
    expectErr(noAcceptance, 409, 'SYSBUILD_GOLIVE_BLOCKED');
    assert.deepStrictEqual(noAcceptance.body.blockers.map((b) => b.code), ['ACCEPT_NOT_EFFECTIVE']);
    await H.acceptEffective(pid, batch);
    assert.deepStrictEqual((await can()).completion_candidates.map((n) => n.id), [dev, optional]);
    assert.strictEqual((await can()).actions.golive, true);
    // v8 生产只有默认批次；同项目其它批次的作用域用夹具验证。
    const anotherBatch = (await sqlRun("INSERT INTO sysbuild_batches (project_id,seq,name,is_default,status) VALUES (?,2,'夹具第二批',0,'planning')", [pid])).lastID;
    const anotherStage = (await sqlRun("INSERT INTO sysbuild_nodes (project_id,batch_id,name,sort_order,is_golive_milestone) VALUES (?,?,'夹具错批次阶段',10,0)", [pid, anotherBatch])).lastID;
    for (const bad of [otherNode, milestone, anotherStage, ordinary, cancelled]) {
      const r = await post(go, { complete_node_ids: [optional, bad] });
      expectErr(r, 409, 'SYSBUILD_STATE');
      assert.strictEqual(r.body.field, 'complete_node_ids');
      assert.strictEqual((await keptNode(optional)).status, 'not_started');
    }
    await sqlRun('DELETE FROM sysbuild_nodes WHERE id = ?', [anotherStage]);
    await sqlRun('DELETE FROM sysbuild_batches WHERE id = ?', [anotherBatch]);
    const duplicate = await post(go, { complete_node_ids: [optional, optional] });
    expectErr(duplicate, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(duplicate.body.field, 'complete_node_ids');
    await sqlRun("UPDATE sysbuild_nodes SET status = 'in_progress', opened_at = datetime('now','localtime') WHERE id = ?", [dev]);
    const futureStart = (await sqlRun("INSERT INTO sysbuild_node_schedule_records (node_id,kind,actual_date,created_by) VALUES (?,'actual_start','2099-12-31',?)", [dev, U.pm])).lastID;
    const future = await post(go, { complete_node_ids: [optional, dev] });
    expectErr(future, 409, 'SYSBUILD_STATE');
    assert.strictEqual(future.body.message, '实际开始晚于收口日期，请先更正实际开始');
    assert.strictEqual((await keptNode(optional)).status, 'not_started');
    assert.deepStrictEqual(await actuals(optional), []);
    assert.strictEqual((await plan(pid)).batches[0].status, 'active');
    await sqlRun('DELETE FROM sysbuild_node_schedule_records WHERE id = ?', [futureStart]);
    await sqlRun("UPDATE sysbuild_nodes SET status = 'not_started', opened_at = NULL WHERE id = ?", [dev]);
    const unrelatedAttachment = await H.stageAtt(sibling, U.pm, 'e');
    const invalidAttachment = await post(go, { complete_node_ids: [optional], attachment_ids: [unrelatedAttachment] });
    expectErr(invalidAttachment, 400, 'SYSBUILD_INVALID_INPUT');
    assert.deepStrictEqual(await actuals(optional), [], '附件失败回滚已有选中阶段的写入');
    assert.strictEqual((await keptNode(optional)).status, 'not_started');
    assert.strictEqual((await plan(pid)).batches[0].status, 'active');
    const live = await post(go, { complete_node_ids: [optional] });
    assert.strictEqual(live.status, 200, live.text);
    assert.deepStrictEqual(live.body.completed_node_ids, [optional]);
    assert.strictEqual((await keptNode(dev)).status, 'not_started', '上线后未选的阶段仍保留');
    assert.deepStrictEqual((await actuals(optional)).map((r) => r.kind), ['actual_end']);
    const closed = (await plan(pid)).nodes.find((n) => n.id === optional);
    assert.ok(closed.actual_end);
    assert.strictEqual(closed.actual_start, null);
    assert.strictEqual((await sqlGet("SELECT count(*) AS n FROM sysbuild_events WHERE project_id = ? AND object_type = 'node' AND object_id = ? AND event_type = 'node_started'", [pid, optional])).n, 0);
    await oldEnough(pid);
    await H.prepareAdditionalClosingCards(pid);
    const closing = before.nodes.find((n) => n.template_key === 'p_closing').id;
    const initiation = before.nodes.find((n) => n.template_key === 'p_initiation').id;
    assert.strictEqual((await post('/nodes/' + closing + '/start')).status, 200);
    const close = '/nodes/' + closing + '/close';
    const pre = await post(close, { complete_node_ids: [dev] });
    expectErr(pre, 409, 'SYSBUILD_CLOSE_BLOCKED');
    assert.strictEqual((await keptNode(dev)).status, 'not_started');
    const v = await H.mkVersion(await H.mkPackage(pid, 'closing'));
    assert.strictEqual((await submit(v)).status, 200);
    await H.confirmAll(v);
    const eligible = (await plan(pid)).nodes.find((n) => n.id === closing).completion_candidates.map((n) => n.id);
    assert.ok(eligible.includes(dev) && eligible.includes(initiation), '结项包含 live 批次的未完成节点和普通项目层节点');
    assert.ok(!eligible.includes(optional) && !eligible.includes(milestone) && !eligible.includes(closing));
    for (const bad of [optional, milestone, closing, cancelled, otherNode]) {
      const wrong = await post(close, { complete_node_ids: [dev, bad] });
      expectErr(wrong, 409, 'SYSBUILD_STATE');
      assert.strictEqual(wrong.body.field, 'complete_node_ids');
      assert.strictEqual((await keptNode(dev)).status, 'not_started', '组合内不合格时整体拒绝');
      assert.deepStrictEqual(await actuals(dev), []);
      assert.strictEqual((await plan(pid)).project.status, 'active');
    }
    const done = await post(close, { complete_node_ids: [dev] });
    assert.strictEqual(done.status, 200, done.text);
    assert.deepStrictEqual(done.body.completed_node_ids, [dev]);
    assert.strictEqual((await keptNode(dev)).status, 'closed');
    assert.strictEqual((await keptNode(initiation)).status, 'not_started', '结项未选中的原样归档');
    assert.strictEqual((await plan(pid)).project.status, 'closed');
    expectErr(await post('/nodes/' + initiation + '/start'), 409, 'SYSBUILD_PROJECT_READONLY');
  });

  test(TEXT, async () => {
    const pid = await H.newProject();
    await H.seedParty(pid, '正文验收部门', U.own, U.del);
    const batch = (await plan(pid)).batches[0].id;
    for (const type of ['initiation', 'overall', 'batch_accept', 'closing']) {
      if (type === 'overall') await H.planAllNodes(pid);
      if (type === 'closing') {
        assert.strictEqual((await post('/batches/' + batch + '/golive')).status, 200);
        await oldEnough(pid);
        await H.prepareAdditionalClosingCards(pid);
      }
      const v = await H.mkPreparedVersion(await H.mkPackage(pid, type, type === 'batch_accept' ? batch : undefined));
      if (type === 'initiation') await H.declareInitiationBasis(v);
      const path = '/package-versions/' + v;
      const snapshot = (await get(path)).snapshot_json;
      if (type === 'overall') {
        const bothMissing = await request('PATCH', path, { snapshot_json: { ...snapshot, text: '', material_version_ids: [] } });
        assert.strictEqual(bothMissing.status, 200, bothMissing.text);
        const res = await submit(v);
        expectErr(res, 409, 'SYSBUILD_STATE');
        assert.match(res.body.message, /请选入「需求文档」/);
        assert.deepStrictEqual(res.body, (await get(path)).submit_block);
      }
      for (const text of [' \t\n ', 15]) {
        const save = await request('PATCH', path, { snapshot_json: { ...snapshot, text } });
        assert.strictEqual(save.status, 200, save.text);
        const view = await get(path);
        assert.strictEqual(view.actions.submit, false, type + ' 缺正文时不可发起');
        const blocked = await submit(v);
        expectErr(blocked, 409, 'SYSBUILD_STATE');
        assert.deepStrictEqual(blocked.body, view.submit_block);
        assert.strictEqual(blocked.body.field, 'snapshot_json.text');
        assert.strictEqual((await get(path)).version.status, 'draft');
      }
      const restored = await request('PATCH', path, { snapshot_json: { ...snapshot, text: '本次确认正文' } });
      assert.strictEqual(restored.status, 200, restored.text);
      assert.strictEqual((await get(path)).actions.submit, true);
      assert.strictEqual((await submit(v)).status, 200);
      await H.confirmAll(v);
    }
  });

  test(EARLY, async () => {
    const pid = await H.newProject();
    const view = await plan(pid);
    const dev = view.nodes.find((n) => n.template_key === 'b_dev');
    const proj = view.nodes.find((n) => n.template_key === 'p_overall');
    assert.strictEqual(dev.allow_start_note, true);
    assert.strictEqual(proj.allow_start_note, false);
    const start = (id, body) => post(`/nodes/${id}/start`, body);
    const note = '需求方同意先开展联调准备\n范围仍在确认中';
    let rejected = await start(proj.id, { start_note: note });
    expectErr(rejected, 409, 'SYSBUILD_STATE');
    assert.strictEqual(rejected.body.field, 'start_note');
    const foreign = await H.stageAtt(await H.newProject(), U.pm, 'e');
    rejected = await start(dev.id, { attachment_ids: [foreign] });
    expectErr(rejected, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(rejected.body.field, 'start_note');
    rejected = await start(dev.id, { start_note: note, attachment_ids: [foreign] });
    expectErr(rejected, 400, 'SYSBUILD_INVALID_INPUT');
    assert.strictEqual(rejected.body.field, 'attachment_ids');
    assert.strictEqual((await keptNode(dev.id)).status, 'not_started');
    assert.deepStrictEqual(await actuals(dev.id), []);
    assert.deepStrictEqual(await sqlAll("SELECT id FROM sysbuild_events WHERE project_id=? AND event_type IN ('node_started','entry_created')", [pid]), []);
    assert.deepStrictEqual(await sqlAll('SELECT id FROM sysbuild_entries WHERE node_id=?', [dev.id]), []);
    const att = await H.stageAtt(pid, U.pm, 'a');
    const started = await start(dev.id, { start_note: '  ' + note + '  ', attachment_ids: [att] });
    assert.strictEqual(started.status, 200, started.text);
    assert.deepStrictEqual([started.body.node.status, started.body.node.range_unconfirmed_started, started.body.node.allow_start_note], ['in_progress', true, false]);
    const written = (await get(`/projects/${pid}/entries`)).entries.find((entry) => entry.node_id === dev.id);
    const read = (await get('/entries/' + written.id)).entry;
    assert.deepStrictEqual([read.type, read.title, read.body, read.period, read.attachments.map((a) => a.attachment_id)], ['note', '范围确认前开工说明', note, 'process', [att]]);
    const evidence = await sqlGet("SELECT owner_type,owner_id FROM sysbuild_attachment_bindings WHERE attachment_id=?", [att]);
    assert.deepStrictEqual(evidence, { owner_type: 'entry', owner_id: read.id });
    const events = await sqlAll("SELECT event_type FROM sysbuild_events WHERE project_id=? AND event_type IN ('node_started','entry_created') ORDER BY id", [pid]);
    assert.deepStrictEqual(events.map((ev) => ev.event_type), ['node_started', 'entry_created']);
    await H.produceEffectiveOverall(pid);
    const effective = await plan(pid);
    assert.strictEqual(effective.nodes.find((n) => n.id === dev.id).range_unconfirmed_started, false);
    const next = await post('/batches/' + view.batches[0].id + '/nodes', { name: '范围确认后新增的普通阶段' });
    assert.strictEqual(next.status, 201, next.text);
    assert.strictEqual(next.body.node.allow_start_note, false);
    rejected = await start(next.body.node.id, { start_note: note });
    expectErr(rejected, 409, 'SYSBUILD_STATE');
    assert.strictEqual(rejected.body.field, 'start_note');
    assert.strictEqual((await start(next.body.node.id, {})).status, 200);
  });

  test(DEFAULT, async () => {
    for (const [type, key, cycle, interval] of [['outsource', 'b_dev', 'weekly', 7], ['procurement', 'b_config', 'weekly', 7], ['inhouse', 'b_dev', 'biweekly', 14]]) {
      const pid = await H.newProject(type);
      const n = (await plan(pid)).nodes.find((node) => node.template_key === key);
      const started = await post(`/nodes/${n.id}/start`);
      assert.strictEqual(started.status, 200, started.text);
      const today = started.body.node.actual_start;
      const first = addDays(today, interval);
      assert.strictEqual(started.body.node.current_plan, null);
      const view = () => plan(pid).then((data) => data.nodes.find((node) => node.id === n.id).report);
      const initial = await view();
      assert.deepStrictEqual([initial.cycle_source, initial.current_cycle, initial.default_cycle, initial.due_items[0].sources],
        ['default', null, { cycle, first_due_on: first }, [{ kind: 'default_cycle' }]]);
      const reg = (form, extra) => post(`/projects/${pid}/entries`, { node_id: n.id, form, ...extra });
      const request = await reg({ kind: 'report_request', due_on: first, reason: '请提交本次移交准备与风险处理进展' });
      assert.strictEqual(request.status, 201, request.text);
      assert.deepStrictEqual((await view()).due_items[0].sources.map((s) => s.kind), ['default_cycle', 'request']);
      const dev = await addParty(pid, '开发方', 'dev');
      const progress = await reg({ kind: 'progress_report', due_on: first, done: '已整理接口契约和联调校验记录' }, { source_party_id: dev });
      assert.strictEqual(progress.status, 201, progress.text);
      assert.deepStrictEqual(progress.body.entry.form, { kind: 'progress_report', due_on: first, done: '已整理接口契约和联调校验记录', next: null, risks: null, milestone_impact: false });
      assert.strictEqual((await view()).due_items[0].submitted, true);
      const tooEarly = await reg({ kind: 'report_cycle', cycle: 'monthly', first_due_on: addDays(today, -1) });
      expectErr(tooEarly, 400, 'SYSBUILD_INVALID_INPUT');
      assert.strictEqual(tooEarly.body.field, 'form.first_due_on');
      const hand = await reg({ kind: 'report_cycle', cycle: 'monthly', first_due_on: today });
      assert.strictEqual(hand.status, 201, hand.text);
      assert.deepStrictEqual([(await view()).cycle_source, (await view()).default_cycle], ['registered', null]);
      assert.strictEqual((await view()).current_cycle.entry_id, hand.body.entry.id);
      assert.strictEqual((await view()).latest_report.entry_id, progress.body.entry.id);
      assert.strictEqual((await view()).due_items.some((item) => item.sources.some((s) => s.kind === 'default_cycle')), false);
    }
  });

  test(SCHEDULE, async () => {
    const pid = await H.newProject();
    await H.produceEffectiveOverall(pid);
    const p = await plan(pid);
    const added = await post('/batches/' + p.batches[0].id + '/nodes', { name: '范围确认后首排并发验证' });
    const id = added.body.node.id;
    const schedule = (id, start, end, extra) => post(`/nodes/${id}/schedule`, { kind: 'plan', planned_start: start, planned_end: end, ...extra });
    const started = await post('/nodes/' + id + '/start');
    assert.strictEqual(started.status, 200, started.text);
    assert.strictEqual(started.body.node.plan_write_mode, 'draft', '仅实际开始不算已经排期');
    const pending = await Promise.all([schedule(id, '2035-01-01', '2035-01-03'), schedule(id, '2035-01-02', '2035-01-04')]);
    assert.deepStrictEqual(pending.map((r) => r.status).sort(), [201, 400]);
    assert.strictEqual(pending.find((r) => r.status === 400).body.field, 'reason');
    const firstPlan = (await get('/nodes/' + id + '/schedule')).records.filter((r) => r.kind === 'plan_change');
    assert.deepStrictEqual(firstPlan.map((r) => r.reason), ['范围生效后首次排期']);
    const ordinary = await schedule(id, '2035-01-04', '2035-01-10', { reason: '结合联调资源更新本阶段计划' });
    assert.strictEqual(ordinary.status, 201, ordinary.text);
    const close = p.nodes.find((n) => n.template_key === 'p_closing');
    const fixedEnd = close.current_plan.end;
    const movedStart = addDays(close.current_plan.start, -1);
    const sameEnd = await schedule(close.id, movedStart, fixedEnd, { reason: '调整起点，结项日期保持原计划' });
    assert.strictEqual(sameEnd.status, 201, sameEnd.text);
    expectErr(await schedule(close.id, movedStart, addDays(fixedEnd, 1), { reason: '延期一天交付结项材料' }), 400, 'SYSBUILD_EVIDENCE_REQUIRED');
    const withReason = await schedule(close.id, movedStart, addDays(fixedEnd, 1), { reason: '延期一天交付结项材料', no_written_evidence: true, no_evidence_reason: '本次排期顺延由现场沟通确认暂无文件' });
    assert.strictEqual(withReason.status, 201, withReason.text);
    assert.deepStrictEqual(withReason.body.node.baseline, close.baseline);
  });
}

const step4Mutations = [
  { id: 'B4.1 放过空确认正文', expect: [TEXT], edits: [
    { file: 'rules.js', from: "if (t.hasConfirmationText !== true) return { code: 'SYSBUILD_STATE'", to: "if (false) return { code: 'SYSBUILD_STATE'" },
  ] },
  { id: 'B4.1 上线候选越过批次作用域', expect: [GATES], edits: [
    { file: 'node-completion.js', from: 'AND (? IS NULL OR n.batch_id = ?)', to: 'AND (? IS NULL OR ? IS NOT NULL)' },
  ] },
  { id: 'B4.1 结项遗漏已上线批次候选', expect: [GATES], edits: [
    { file: 'node-completion.js', from: 'AND (? IS NULL OR n.id <> ?)', to: "AND (? IS NULL OR n.id <> ?) AND (b.status IS NULL OR b.status <> 'live')" },
  ] },
  { id: 'B4.1 上线未勾选的阶段也完成', expect: [GATES], edits: [
    { file: 'node-completion.js', from: 'for (const id of ids) {', to: 'for (const id of Object.keys(candidates).map(Number)) {' },
  ] },
  { id: 'B4.1 普通阶段越权批量完成', expect: [GATES], edits: [
    { file: 'plan.js', from: 'if (!closing && completionIds.length) throw completion.ineligibleSelection();', to: '' },
  ] },
  { id: 'B4.1 重开又改同层后续阶段', expect: ['重开只改当前阶段'], edits: [
    { file: 'plan.js', from: "await emit(q, user, node.project_id, 'node', nid, 'node_reopened', { reason });",
      to: "await q.run(\"UPDATE sysbuild_nodes SET status='in_progress',closed_at=NULL WHERE project_id=? AND batch_id IS ? AND sort_order>? AND status='closed'\", [node.project_id, node.batch_id, node.sort_order]); await emit(q, user, node.project_id, 'node', nid, 'node_reopened', { reason });" },
  ] },
  { id: 'B4.2 开工说明接受已确认范围', expect: [EARLY], edits: [
    { file: 'plan.js', from: 'return node.batch_id !== null && !hasEffectiveOverall;', to: 'return node.batch_id !== null;' },
  ] },
  { id: 'B4.2 有附件但不开工说明', expect: [EARLY], edits: [
    { file: 'plan.js', from: "if (!note && attachmentIds.length) throw invalid('附沟通记录时请填写开工说明', 'start_note');", to: '' },
  ] },
  { id: 'B4.2 自研默认周期误用每周', expect: [DEFAULT], edits: [
    { file: 'report-core.js', from: "inhouse: 'biweekly'", to: "inhouse: 'weekly'" },
  ] },
  { id: 'B4.2 默认首期从开工当日算', expect: [DEFAULT], edits: [
    { file: 'report-core.js', from: "first_due_on: addDays(state.started_on, cycle === 'weekly' ? 7 : 14)", to: 'first_due_on: state.started_on' },
  ] },
  { id: 'B4.2 无计划时允许登记以前的首次应交日', expect: [DEFAULT], edits: [
    { file: 'entry-forms.js', from: '!state.current_plan && form.first_due_on < today', to: 'false' },
  ] },
  { id: 'B4.2 实际开工错误算作已有排期', expect: [SCHEDULE], edits: [
    { file: 'plan.js', from: "records.some((r) => r.kind === 'plan_change')", to: "records.some((r) => r.kind === 'plan_change' || r.kind === 'actual_start')" },
  ] },
  { id: 'B4.2 生效后首次排期错误沿用草稿原因', expect: [SCHEDULE], edits: [
    { file: 'plan.js', from: 'hasEffectiveOverall ? FIRST_PLAN_REASON : DRAFT_PLAN_REASON', to: 'DRAFT_PLAN_REASON' },
  ] },
  { id: 'B4.2 同一结项结束日也要求证据', expect: [SCHEDULE], edits: [
    { file: 'plan.js', from: 'cur && plannedEnd > cur.end;', to: 'cur && plannedEnd >= cur.end;' },
  ] },
];

module.exports = { defineStep4Cases, step4Mutations };
